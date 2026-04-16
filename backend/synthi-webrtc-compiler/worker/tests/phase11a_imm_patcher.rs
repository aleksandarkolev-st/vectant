// ============================================================
// Phase 11 — Integer immediate patcher integration tests
// ============================================================
//
// Compiles real C code with gcc -O0 -g -gdwarf-4, uses the DWARF
// line map to find instruction addresses, then verifies the
// immediate patcher can locate and replace integer operands.

use worker::hmr::binary_patch::dwarf_line_map::line_to_addresses;
use worker::hmr::binary_patch::imm_patcher::{find_immediates, patch_immediate};
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

#[test]
fn finds_imm32_for_integer_assignment() {
    let dir = tempfile::tempdir().unwrap();
    // Line 2: int x = 42;
    let source = "void setup() {\n    int x = 42;\n    (void)x;\n}\n";
    let so = compile_so(dir.path(), source, "imm1");

    let addrs = line_to_addresses(&so, "imm1.c", 2).unwrap();
    assert!(!addrs.is_empty(), "DWARF should map line 2 to addresses");

    let va_list: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    let locs = find_immediates(&so, &va_list, Some(42)).unwrap();
    assert!(
        !locs.is_empty(),
        "should find imm32=42 in instructions at line 2. Addresses: {:?}",
        va_list
    );
    assert_eq!(locs[0].current_value, 42);
    assert!(locs[0].size >= 2);
}

#[test]
fn finds_larger_imm32() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    int width = 800;\n    int height = 600;\n    (void)width; (void)height;\n}\n";
    let so = compile_so(dir.path(), source, "imm2");

    let addrs_w = line_to_addresses(&so, "imm2.c", 2).unwrap();
    let va_w: Vec<u64> = addrs_w.iter().map(|a| a.address).collect();
    let locs_w = find_immediates(&so, &va_w, Some(800)).unwrap();
    assert!(!locs_w.is_empty(), "should find imm32=800 at line 2");

    let addrs_h = line_to_addresses(&so, "imm2.c", 3).unwrap();
    let va_h: Vec<u64> = addrs_h.iter().map(|a| a.address).collect();
    let locs_h = find_immediates(&so, &va_h, Some(600)).unwrap();
    assert!(!locs_h.is_empty(), "should find imm32=600 at line 3");
}

#[test]
fn patch_immediate_changes_value() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    int x = 42;\n    (void)x;\n}\n";
    let so = compile_so(dir.path(), source, "imm3");

    let addrs = line_to_addresses(&so, "imm3.c", 2).unwrap();
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    let locs = find_immediates(&so, &va, Some(42)).unwrap();
    assert!(!locs.is_empty());

    let loc = &locs[0];
    patch_immediate(&so, loc, 99).unwrap();

    // Verify: re-read and find the new value
    let locs_after = find_immediates(&so, &va, Some(99)).unwrap();
    assert!(
        !locs_after.is_empty(),
        "after patching 42→99, should find imm32=99"
    );
    // Old value should be gone
    let locs_old = find_immediates(&so, &va, Some(42)).unwrap();
    assert!(locs_old.is_empty(), "old value 42 should be gone after patch");
}

#[test]
fn no_immediates_for_function_call_line() {
    let dir = tempfile::tempdir().unwrap();
    // Line 3 is a function call with no integer literal
    let source = "extern void foo(void);\nvoid bar() {\n    foo();\n}\n";
    let so = compile_so(dir.path(), source, "imm4");

    let addrs = line_to_addresses(&so, "imm4.c", 3).unwrap();
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    // Looking for value 42 which doesn't exist in a call instruction
    let locs = find_immediates(&so, &va, Some(42)).unwrap();
    assert!(locs.is_empty());
}

#[test]
fn negative_immediate_found() {
    let dir = tempfile::tempdir().unwrap();
    let source = "void setup() {\n    int x = -1;\n    (void)x;\n}\n";
    let so = compile_so(dir.path(), source, "imm5");

    let addrs = line_to_addresses(&so, "imm5.c", 2).unwrap();
    let va: Vec<u64> = addrs.iter().map(|a| a.address).collect();
    let locs = find_immediates(&so, &va, Some(-1)).unwrap();
    assert!(
        !locs.is_empty(),
        "should find imm32=-1 (0xFFFFFFFF) at line 2"
    );
}
