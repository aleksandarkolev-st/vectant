// ============================================================
// Phase 11 — Float literal patcher integration tests
// ============================================================

use worker::hmr::binary_patch::dwarf_line_map::line_to_addresses;
use worker::hmr::binary_patch::float_patcher::{find_float_loads, patch_float};
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
fn finds_float_literal_in_rodata() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() {\n    float x = 3.14f;\n    (void)x;\n}\n";
    let so = compile_so(dir.path(), source, "flt1");

    let addrs = line_to_addresses(&so, "flt1.c", 2).unwrap();
    assert!(!addrs.is_empty());
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();

    let locs = find_float_loads(&so, &va, Some(3.14), true).unwrap();
    assert!(!locs.is_empty(), "should find movss loading 3.14f");
    assert!((locs[0].current_value - 3.14).abs() < 1e-5);
    assert_eq!(locs[0].size, 4);
}

#[test]
fn finds_double_literal_in_rodata() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() {\n    double y = 2.718;\n    (void)y;\n}\n";
    let so = compile_so(dir.path(), source, "flt2");

    let addrs = line_to_addresses(&so, "flt2.c", 2).unwrap();
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();

    let locs = find_float_loads(&so, &va, Some(2.718), false).unwrap();
    assert!(!locs.is_empty(), "should find movsd loading 2.718");
    assert!((locs[0].current_value - 2.718).abs() < 1e-10);
    assert_eq!(locs[0].size, 8);
}

#[test]
fn patch_float_changes_value() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() {\n    float x = 3.14f;\n    (void)x;\n}\n";
    let so = compile_so(dir.path(), source, "flt3");

    let addrs = line_to_addresses(&so, "flt3.c", 2).unwrap();
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    let locs = find_float_loads(&so, &va, Some(3.14), true).unwrap();
    assert!(!locs.is_empty());

    patch_float(&so, &locs[0], 6.28, true).unwrap();

    // Verify new value
    let locs_after = find_float_loads(&so, &va, Some(6.28), true).unwrap();
    assert!(!locs_after.is_empty(), "should find 6.28 after patch");
    let locs_old = find_float_loads(&so, &va, Some(3.14), true).unwrap();
    assert!(locs_old.is_empty(), "old value 3.14 should be gone");
}

#[test]
fn unified_tier0_v2_patches_float() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    float speed = 1.5f;\n    (void)speed;\n}\n";
    compile_so(dir.path(), source, "core.c");
    std::fs::rename(
        dir.path().join("libcore.c.so"),
        dir.path().join("libcore_100.so"),
    ).unwrap_or_else(|_| {
        // compile_so names it libcore.c.so, let me just re-compile with the right name
    });
    // Re-compile with correct naming
    let src = dir.path().join("core.c");
    let so = dir.path().join("libcore_100.so");
    std::fs::write(&src, source).unwrap();
    let out = Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-g", "-gdwarf-4", "-fno-merge-constants", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");
    assert!(out.status.success());
    setup_symlink(dir.path(), "libcore_100.so", "libcore.so");

    let old = "void setup() {\n    float speed = 1.5f;\n    (void)speed;\n}\n";
    let new = "void setup() {\n    float speed = 2.5f;\n    (void)speed;\n}\n";

    match try_tier0_v2(dir.path(), old, new, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.float_patches > 0, "should have float patches, got: {:?}", r);
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}

#[test]
fn unified_mixed_int_and_float() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() {\n    int x = 42;\n    float y = 1.5f;\n    (void)x; (void)y;\n}\n";
    let src = dir.path().join("core.c");
    let so = dir.path().join("libcore_200.so");
    std::fs::write(&src, source).unwrap();
    let out = Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-g", "-gdwarf-4", "-fno-merge-constants", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");
    assert!(out.status.success());
    setup_symlink(dir.path(), "libcore_200.so", "libcore.so");

    let old = "void f() {\n    int x = 42;\n    float y = 1.5f;\n    (void)x; (void)y;\n}\n";
    let new = "void f() {\n    int x = 99;\n    float y = 2.5f;\n    (void)x; (void)y;\n}\n";

    match try_tier0_v2(dir.path(), old, new, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.integer_patches > 0, "should have int patches");
            assert!(r.float_patches > 0, "should have float patches");
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}
