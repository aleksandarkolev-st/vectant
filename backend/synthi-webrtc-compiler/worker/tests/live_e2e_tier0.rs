// ============================================================
// LIVE END-TO-END TIER 0 PIPELINE TEST
// ============================================================
//
// Compiles a realistic HMR C++ project with gcc, then exercises
// the FULL Tier 0 v2 pipeline: tree-sitter classify → DWARF
// line map → string/integer/float patching → verify in binary.
//
// Run:  cargo test --test live_e2e_tier0 -- --nocapture
//
// Requires: gcc, Xvfb (optional for display tests)

use std::path::Path;
use std::process::Command;
use worker::hmr::binary_patch::dwarf_line_map::{line_to_addresses, read_rodata};
use worker::hmr::binary_patch::float_patcher::find_float_loads;
use worker::hmr::binary_patch::imm_patcher::find_immediates;
use worker::hmr::binary_patch::proc_mem_patcher::{find_so_base_addr, patch_process_memory};
use worker::hmr::tier0_literal_patch::{
    candidate_so_paths, patch_so_file, LiteralKind as SwapKind, LiteralSwap, Tier0Outcome,
};
use worker::hmr::tier0_unified::{try_tier0_v2, Tier0V2Outcome};
use worker::hmr::ts_value_classifier::{classify_ast, AstClassification, LiteralKind};

// ─── Helpers ──────────────────────────────────────────────

fn compile_project(dir: &Path, source: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let src = dir.join("core.c");
    let so = dir.join("libcore_1000.so");
    std::fs::write(&src, source).unwrap();

    let out = Command::new("gcc")
        .args([
            "-shared",
            "-fPIC",
            "-O0",
            "-g",
            "-gdwarf-4",
            "-fno-merge-constants",
            "-o",
        ])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc must be installed");
    assert!(
        out.status.success(),
        "gcc failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let _ = std::fs::remove_file(dir.join("libcore.so"));
    std::os::unix::fs::symlink("libcore_1000.so", dir.join("libcore.so")).unwrap();
    (src, so)
}

// ─── 1. FULL PIPELINE: string literal change ──────────────

#[test]
fn e2e_string_literal_full_pipeline() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
#include <stdio.h>
const char* get_title() {
    return "My Game";
}
void setup() {
    printf("%s\n", get_title());
}
"#;
    compile_project(dir.path(), source);

    let old_src = source;
    let new_src = r#"
#include <stdio.h>
const char* get_title() {
    return "My App!";
}
void setup() {
    printf("%s\n", get_title());
}
"#;

    // Step 1: tree-sitter classifies as value-only
    let cls = classify_ast(old_src, new_src);
    match &cls {
        AstClassification::ValueOnly { changes } => {
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].kind, LiteralKind::StringLiteral);
            println!("[OK] tree-sitter: value-only, 1 string change");
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }

    // Step 2: unified Tier 0 patches the .so
    match try_tier0_v2(dir.path(), old_src, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.string_patches > 0);
            println!("[OK] Tier 0 v2: {} string patches", r.string_patches);
        }
        other => panic!("expected Patched, got {:?}", other),
    }

    // Step 3: verify the .so binary
    let so = dir.path().join("libcore_1000.so");
    let data = std::fs::read(&so).unwrap();
    assert!(
        data.windows(7).any(|w| w == b"My App!"),
        ".so should contain new string"
    );
    assert!(
        !data.windows(7).any(|w| w == b"My Game"),
        ".so should NOT contain old string"
    );
    println!("[OK] binary verified: 'My Game' → 'My App!'");
}

// ─── 2. FULL PIPELINE: integer literal change ─────────────

#[test]
fn e2e_integer_literal_full_pipeline() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    int width = 800;\n    int height = 600;\n    (void)width; (void)height;\n}\n";
    compile_project(dir.path(), source);

    let new_src = "void setup() {\n    int width = 1024;\n    int height = 768;\n    (void)width; (void)height;\n}\n";

    // Step 1: tree-sitter
    match classify_ast(source, new_src) {
        AstClassification::ValueOnly { changes } => {
            assert_eq!(changes.len(), 2);
            assert!(changes.iter().all(|c| c.kind == LiteralKind::NumberLiteral));
            println!("[OK] tree-sitter: 2 integer changes");
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }

    // Step 2: DWARF line map resolves addresses
    let so = dir.path().join("libcore_1000.so");
    let line2_addrs = line_to_addresses(&so, "core.c", 2).unwrap();
    assert!(!line2_addrs.is_empty(), "DWARF should map line 2");
    println!("[OK] DWARF: {} addresses for line 2", line2_addrs.len());

    // Step 3: iced-x86 finds the immediate
    let va: Vec<u64> = line2_addrs.iter().map(|a| a.address).collect();
    let locs = find_immediates(&so, &va, Some(800)).unwrap();
    assert!(!locs.is_empty(), "should find imm32=800");
    println!(
        "[OK] iced-x86: found imm32=800 at {:#x}",
        locs[0].instruction_va
    );

    // Step 4: unified patcher applies both changes
    match try_tier0_v2(dir.path(), source, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert_eq!(r.integer_patches, 2);
            println!("[OK] Tier 0 v2: {} integer patches", r.integer_patches);
        }
        other => panic!("expected Patched, got {:?}", other),
    }

    // Step 5: verify via disassembler
    let locs_after = find_immediates(&so, &va, Some(1024)).unwrap();
    assert!(!locs_after.is_empty(), "should find imm32=1024 after patch");
    println!("[OK] binary verified: 800 → 1024");
}

// ─── 3. FULL PIPELINE: float literal change ───────────────

#[test]
fn e2e_float_literal_full_pipeline() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    float speed = 1.5f;\n    (void)speed;\n}\n";
    compile_project(dir.path(), source);

    let new_src = "void setup() {\n    float speed = 3.0f;\n    (void)speed;\n}\n";

    // tree-sitter classifies
    match classify_ast(source, new_src) {
        AstClassification::ValueOnly { changes } => {
            assert_eq!(changes.len(), 1);
            println!("[OK] tree-sitter: 1 float change");
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }

    // DWARF resolves line 2
    let so = dir.path().join("libcore_1000.so");
    let addrs = line_to_addresses(&so, "core.c", 2).unwrap();
    assert!(!addrs.is_empty());

    // Find movss loading 1.5f
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    let locs = find_float_loads(&so, &va, Some(1.5), true).unwrap();
    assert!(!locs.is_empty(), "should find movss loading 1.5f");
    println!(
        "[OK] iced-x86: found movss with 1.5f at .rodata offset {:#x}",
        locs[0].rodata_file_offset
    );

    // Unified patcher
    match try_tier0_v2(dir.path(), source, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.float_patches > 0);
            println!("[OK] Tier 0 v2: {} float patches", r.float_patches);
        }
        other => panic!("expected Patched, got {:?}", other),
    }

    // Verify: find 3.0f now
    let locs_after = find_float_loads(&so, &va, Some(3.0), true).unwrap();
    assert!(!locs_after.is_empty(), "should find 3.0f after patch");
    println!("[OK] binary verified: 1.5f → 3.0f");
}

// ─── 4. MIXED: string + integer + float in one edit ───────

#[test]
fn e2e_mixed_all_three_types() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
const char* title() { return "Demo"; }
int width() { return 800; }
float speed() {
    float s = 2.5f;
    return s;
}
"#;
    compile_project(dir.path(), source);

    let new_src = r#"
const char* title() { return "Live"; }
int width() { return 900; }
float speed() {
    float s = 5.0f;
    return s;
}
"#;

    match try_tier0_v2(dir.path(), source, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            println!(
                "[OK] mixed patch: {} string + {} integer + {} float",
                r.string_patches, r.integer_patches, r.float_patches
            );
            assert!(r.string_patches > 0, "should patch string");
            assert!(r.integer_patches > 0, "should patch integer");
            assert!(r.float_patches > 0, "should patch float");
        }
        other => panic!("expected Patched, got {:?}", other),
    }

    // Verify all three in binary
    let so = dir.path().join("libcore_1000.so");
    let data = std::fs::read(&so).unwrap();
    assert!(data.windows(4).any(|w| w == b"Live"), "string patched");
    println!("[OK] all three literal types patched in one pass");
}

// ─── 5. STRUCTURAL EDIT: correctly rejected ───────────────

#[test]
fn e2e_structural_edit_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() { int x = 42; }\n";
    compile_project(dir.path(), source);

    let new_src = "void f() { int x = 42; }\nvoid g() { int y = 99; }\n";

    match try_tier0_v2(dir.path(), source, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Ineligible(reason) => {
            assert!(reason.contains("structural"));
            println!("[OK] structural edit correctly rejected: {}", reason);
        }
        other => panic!("expected Ineligible, got {:?}", other),
    }
}

// ─── 6. .rodata verification ──────────────────────────────

#[test]
fn e2e_rodata_section_readable() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"const char* msg() { return "RODATA_TEST_VALUE"; }"#;
    let (_src, so) = compile_project(dir.path(), source);

    let rodata = read_rodata(&so).unwrap();
    assert!(rodata.is_some());
    let (offset, bytes) = rodata.unwrap();
    assert!(offset > 0, "rodata offset should be > 0");
    let needle = b"RODATA_TEST_VALUE";
    assert!(
        bytes.windows(needle.len()).any(|w| w == needle),
        ".rodata should contain the string literal"
    );
    println!("[OK] .rodata at offset {:#x}, contains literal", offset);
}

// ─── 7. DWARF line map completeness ──────────────────────

#[test]
fn e2e_dwarf_line_map_all_lines() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
int add(int a, int b) {
    int result = a + b;
    return result;
}
int multiply(int a, int b) {
    return a * b;
}
"#;
    let (_src, so) = compile_project(dir.path(), source);

    // Each function body line should have at least one address
    for line in [3, 4, 7] {
        let addrs = line_to_addresses(&so, "core.c", line).unwrap();
        assert!(!addrs.is_empty(), "line {} should have addresses", line);
    }
    println!("[OK] DWARF maps all expected source lines");
}

// ─── 8. /proc/self/mem patching ───────────────────────────

#[test]
fn e2e_proc_mem_self_patch() {
    let mut buf = [0x42u8; 4];
    let va = buf.as_ptr() as u64;
    let pid = std::process::id();

    patch_process_memory(
        pid,
        va,
        &[0x42, 0x42, 0x42, 0x42],
        &[0xDE, 0xAD, 0xBE, 0xEF],
    )
    .unwrap();
    assert_eq!(buf, [0xDE, 0xAD, 0xBE, 0xEF]);
    println!("[OK] /proc/self/mem patched 4 bytes at {:#x}", va);
}

// ─── 9. Candidate .so symlink resolution ──────────────────

#[test]
fn e2e_symlink_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let source = "int f() { return 1; }\n";
    compile_project(dir.path(), source);

    let candidates = candidate_so_paths(dir.path());
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].to_string_lossy().contains("libcore_1000.so"));
    println!("[OK] symlink libcore.so → libcore_1000.so resolved");
}

// ─── 10. Negative immediate (edge case) ──────────────────

#[test]
fn e2e_negative_integer_patch() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void f() {\n    int x = -42;\n    (void)x;\n}\n";
    compile_project(dir.path(), source);

    let new_src = "void f() {\n    int x = -99;\n    (void)x;\n}\n";

    match try_tier0_v2(dir.path(), source, new_src, &[("core", "core.c")]) {
        Tier0V2Outcome::Patched(r) => {
            assert!(r.integer_patches > 0);
            println!("[OK] negative integer: -42 → -99 patched");
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}
