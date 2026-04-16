// ============================================================
// Phase 11 — Unified Tier 0 patcher integration tests
// ============================================================
//
// Compiles real C code with gcc, then runs the full Tier 0 v2
// pipeline: tree-sitter classify → string patch or DWARF+imm patch.

use worker::hmr::tier0_unified::{try_tier0_v2, Tier0V2Outcome};
use std::process::Command;

fn compile_so(dir: &std::path::Path, source: &str, name: &str) -> std::path::PathBuf {
    let src = dir.join(format!("{}.c", name));
    let so = dir.join(format!("lib{}.so", name));
    std::fs::write(&src, source).unwrap();
    let out = Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-g", "-gdwarf-4", "-fno-merge-constants", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");
    assert!(out.status.success(), "gcc: {}", String::from_utf8_lossy(&out.stderr));
    so
}

fn setup_symlink(dir: &std::path::Path, so_name: &str, link_name: &str) {
    let _ = std::fs::remove_file(dir.join(link_name));
    std::os::unix::fs::symlink(so_name, dir.join(link_name)).unwrap();
}

#[test]
fn string_literal_patch_e2e() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"const char* title() { return "My Game"; }"#;
    let so_name = "libcore_100.so";
    let so = dir.path().join(so_name);
    let src = dir.path().join("core.c");
    std::fs::write(&src, source).unwrap();
    let out = Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-g", "-gdwarf-4", "-fno-merge-constants", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");
    assert!(out.status.success());
    setup_symlink(dir.path(), so_name, "libcore.so");

    let old_src = r#"const char* title() { return "My Game"; }"#;
    let new_src = r#"const char* title() { return "My App!"; }"#;

    match try_tier0_v2(dir.path(), old_src, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.string_patches > 0, "should have string patches");
            assert!(!r.patched_paths.is_empty());
            // Verify the .so has the new string
            let data = std::fs::read(&so).unwrap();
            assert!(data.windows(7).any(|w| w == b"My App!"));
            assert!(!data.windows(7).any(|w| w == b"My Game"));
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}

#[test]
fn integer_literal_patch_e2e() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    int width = 800;\n    (void)width;\n}\n";
    let so_name = "libcore_200.so";
    compile_so_named(dir.path(), source, "core.c", so_name);
    setup_symlink(dir.path(), so_name, "libcore.so");

    let old_src = "void setup() {\n    int width = 800;\n    (void)width;\n}\n";
    let new_src = "void setup() {\n    int width = 900;\n    (void)width;\n}\n";

    match try_tier0_v2(dir.path(), old_src, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.integer_patches > 0, "should have integer patches");
            // Verify by re-reading the .so with the disassembler
            let so = dir.path().join(so_name);
            let addrs = worker::hmr::binary_patch::dwarf_line_map::line_to_addresses(
                &so, "core.c", 2,
            ).unwrap();
            let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
            let locs = worker::hmr::binary_patch::imm_patcher::find_immediates(
                &so, &va, Some(900),
            ).unwrap();
            assert!(!locs.is_empty(), "should find imm32=900 after patch");
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}

#[test]
fn mixed_string_and_integer_patch() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
const char* get_title() { return "Demo"; }
int get_width() { return 800; }
"#;
    compile_so_named(dir.path(), source, "core.c", "libcore_300.so");
    setup_symlink(dir.path(), "libcore_300.so", "libcore.so");

    let old_src = r#"
const char* get_title() { return "Demo"; }
int get_width() { return 800; }
"#;
    let new_src = r#"
const char* get_title() { return "Live"; }
int get_width() { return 900; }
"#;

    match try_tier0_v2(dir.path(), old_src, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.string_patches > 0, "should have string patches");
            assert!(r.integer_patches > 0, "should have integer patches");
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}

#[test]
fn structural_change_rejected() {
    let dir = tempfile::tempdir().unwrap();
    compile_so_named(dir.path(), "void f() { }\n", "core.c", "libcore_400.so");
    setup_symlink(dir.path(), "libcore_400.so", "libcore.so");

    let old = "void f() { }";
    let new = "void f() { } void g() { }";

    match try_tier0_v2(dir.path(), old, new, &[("core", "core.c")]) {
        Tier0V2Outcome::Ineligible(reason) => {
            assert!(reason.contains("structural"), "reason: {}", reason);
        }
        other => panic!("expected Ineligible, got {:?}", other),
    }
}

#[test]
fn different_length_string_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"const char* f() { return "Short"; }"#;
    compile_so_named(dir.path(), source, "core.c", "libcore_500.so");
    setup_symlink(dir.path(), "libcore_500.so", "libcore.so");

    let old = r#"const char* f() { return "Short"; }"#;
    let new = r#"const char* f() { return "Much Longer"; }"#;

    match try_tier0_v2(dir.path(), old, new, &[("core", "core.c")]) {
        Tier0V2Outcome::Ineligible(reason) => {
            assert!(reason.contains("length mismatch"), "reason: {}", reason);
        }
        other => panic!("expected Ineligible, got {:?}", other),
    }
}

#[test]
fn no_so_files_returns_ineligible() {
    let dir = tempfile::tempdir().unwrap();
    let old = "void f() { int x = 42; }";
    let new = "void f() { int x = 99; }";
    match try_tier0_v2(dir.path(), old, new, &[("core", "core.c")]) {
        Tier0V2Outcome::Ineligible(reason) => {
            assert!(reason.contains("no candidate"), "reason: {}", reason);
        }
        other => panic!("expected Ineligible, got {:?}", other),
    }
}

fn compile_so_named(dir: &std::path::Path, source: &str, src_name: &str, so_name: &str) {
    let src = dir.join(src_name);
    let so = dir.join(so_name);
    std::fs::write(&src, source).unwrap();
    let out = Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-g", "-gdwarf-4", "-fno-merge-constants", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");
    assert!(out.status.success(), "gcc: {}", String::from_utf8_lossy(&out.stderr));
}
