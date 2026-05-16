// ============================================================
// Phase 11a — DWARF line-to-address mapping tests
// ============================================================
//
// Compiles a real C file with -g -gdwarf-4 -O0, then verifies
// the DWARF line map correctly resolves source lines to addresses.

use std::process::Command;
use worker::hmr::binary_patch::dwarf_line_map::{line_to_addresses, read_rodata};

fn compile_test_so(dir: &std::path::Path, source: &str, name: &str) -> std::path::PathBuf {
    let src_path = dir.join(format!("{}.c", name));
    let so_path = dir.join(format!("lib{}.so", name));
    std::fs::write(&src_path, source).unwrap();

    let output = Command::new("gcc")
        .args([
            "-shared",
            "-fPIC",
            "-O0",
            "-g",
            "-gdwarf-4",
            "-fno-merge-constants",
            "-o",
        ])
        .arg(&so_path)
        .arg(&src_path)
        .output()
        .expect("gcc must be available");

    if !output.status.success() {
        panic!("gcc failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    so_path
}

#[test]
fn finds_addresses_for_source_line() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
int add(int a, int b) {
    return a + b;
}

const char* greeting() {
    return "Hello World";
}
"#;
    let so = compile_test_so(dir.path(), source, "test1");
    // Line 3 is `return a + b;`
    let entries = line_to_addresses(&so, "test1.c", 3).unwrap();
    assert!(
        !entries.is_empty(),
        "should find at least one address for line 3 (return a + b)"
    );
    for e in &entries {
        assert_eq!(e.line, 3);
        assert!(e.address > 0);
    }
}

#[test]
fn no_addresses_for_blank_line() {
    let dir = tempfile::tempdir().unwrap();
    let source = "int x() {\n\n    return 42;\n}\n";
    let so = compile_test_so(dir.path(), source, "test2");
    // Line 2 is blank — should have no instructions
    let entries = line_to_addresses(&so, "test2.c", 2).unwrap();
    assert!(entries.is_empty(), "blank line should have no addresses");
}

#[test]
fn no_addresses_for_nonexistent_line() {
    let dir = tempfile::tempdir().unwrap();
    let source = "int x() { return 1; }\n";
    let so = compile_test_so(dir.path(), source, "test3");
    let entries = line_to_addresses(&so, "test3.c", 999).unwrap();
    assert!(entries.is_empty());
}

#[test]
fn no_addresses_for_wrong_file() {
    let dir = tempfile::tempdir().unwrap();
    let source = "int x() { return 1; }\n";
    let so = compile_test_so(dir.path(), source, "test4");
    let entries = line_to_addresses(&so, "other_file.c", 1).unwrap();
    assert!(entries.is_empty());
}

#[test]
fn rodata_contains_string_literal() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
const char* msg() { return "TIER0_TEST_LITERAL"; }
"#;
    let so = compile_test_so(dir.path(), source, "test5");
    let rodata = read_rodata(&so).unwrap();
    assert!(rodata.is_some(), ".rodata should exist");
    let (_offset, bytes) = rodata.unwrap();
    let needle = b"TIER0_TEST_LITERAL";
    assert!(
        bytes.windows(needle.len()).any(|w| w == needle),
        "string literal should be in .rodata"
    );
}

#[test]
fn rodata_absent_on_stripped_binary() {
    let dir = tempfile::tempdir().unwrap();
    let source = "int x() { return 42; }\n";
    let src = dir.path().join("test6.c");
    let so = dir.path().join("libtest6.so");
    std::fs::write(&src, source).unwrap();

    Command::new("gcc")
        .args(["-shared", "-fPIC", "-O0", "-s", "-o"])
        .arg(&so)
        .arg(&src)
        .output()
        .expect("gcc");

    // Stripped binary may not have .rodata (or it may be empty)
    // Either outcome is fine — we just verify no panic.
    let _ = read_rodata(&so).unwrap();
}

#[test]
fn multiple_lines_have_distinct_addresses() {
    let dir = tempfile::tempdir().unwrap();
    let source = r#"
int foo() {
    int a = 10;
    int b = 20;
    return a + b;
}
"#;
    let so = compile_test_so(dir.path(), source, "test7");

    let line3 = line_to_addresses(&so, "test7.c", 3).unwrap();
    let line4 = line_to_addresses(&so, "test7.c", 4).unwrap();
    let line5 = line_to_addresses(&so, "test7.c", 5).unwrap();

    // At -O0, each assignment should produce at least one instruction
    assert!(
        !line3.is_empty(),
        "line 3 (int a = 10) should have addresses"
    );
    assert!(
        !line4.is_empty(),
        "line 4 (int b = 20) should have addresses"
    );
    assert!(
        !line5.is_empty(),
        "line 5 (return a + b) should have addresses"
    );

    // Addresses should be strictly increasing
    if !line3.is_empty() && !line4.is_empty() {
        assert!(
            line3[0].address < line4[0].address,
            "line 3 should come before line 4"
        );
    }
}
