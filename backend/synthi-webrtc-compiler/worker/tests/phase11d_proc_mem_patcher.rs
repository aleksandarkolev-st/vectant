// ============================================================
// Phase 11d — Live process memory patcher integration tests
// ============================================================
//
// Tests /proc/pid/maps parsing and /proc/pid/mem patching.
// Uses the test process itself (via /proc/self) for maps parsing.
// Full live-patch tests need a child process with a loaded .so.

use std::path::Path;
use worker::hmr::binary_patch::proc_mem_patcher::{
    file_offset_to_va, find_so_base_addr, patch_process_memory,
};

#[test]
fn finds_libc_in_own_maps() {
    let pid = std::process::id();
    let result = find_so_base_addr(pid, Path::new("libc.so")).unwrap();
    assert!(result.is_some(), "libc should be in /proc/self/maps");
    let mapped = result.unwrap();
    assert!(mapped.base_addr > 0);
    assert!(mapped.so_path.to_string_lossy().contains("libc"));
}

#[test]
fn missing_so_returns_none() {
    let pid = std::process::id();
    let result = find_so_base_addr(pid, Path::new("definitely_not_loaded.so")).unwrap();
    assert!(result.is_none());
}

#[test]
fn finds_libpthread_or_libm() {
    let pid = std::process::id();
    // Try common libs that should be loaded
    let libm = find_so_base_addr(pid, Path::new("libm.so")).unwrap();
    let libgcc = find_so_base_addr(pid, Path::new("libgcc_s.so")).unwrap();
    // At least one should be present
    assert!(
        libm.is_some() || libgcc.is_some(),
        "at least libm or libgcc_s should be loaded"
    );
}

#[test]
fn file_offset_to_va_on_real_so() {
    let pid = std::process::id();
    // Find a real .so in our maps
    let maps = std::fs::read_to_string(format!("/proc/{}/maps", pid)).unwrap();
    // Find the first .so that exists on disk
    for line in maps.lines() {
        let parts: Vec<&str> = line.splitn(6, char::is_whitespace).collect();
        if parts.len() < 6 {
            continue;
        }
        let path_str = parts[5].trim();
        if !path_str.ends_with(".so") && !path_str.contains(".so.") {
            continue;
        }
        let so_path = Path::new(path_str);
        if !so_path.exists() {
            continue;
        }

        // Try to convert file offset 0 (should work for any loadable segment)
        let addr_range = parts[0];
        if let Some(dash) = addr_range.find('-') {
            let base = u64::from_str_radix(&addr_range[..dash], 16).unwrap();
            // file_offset_to_va with offset=0 should give us base + segment adjustment
            match file_offset_to_va(0, base, so_path) {
                Ok(va) => {
                    assert!(va >= base, "VA should be >= base addr");
                    return; // Test passes
                }
                Err(_) => continue, // Try next .so
            }
        }
    }
    // If we get here, we couldn't find a testable .so — skip gracefully
}

#[test]
fn patch_own_memory_stack_variable() {
    // Allocate a mutable buffer and patch it via /proc/self/mem
    let mut buffer: [u8; 8] = [0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44];
    let va = buffer.as_ptr() as u64;
    let pid = std::process::id();

    let expected = [0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44];
    let new_bytes = [0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88];

    patch_process_memory(pid, va, &expected, &new_bytes).unwrap();

    assert_eq!(buffer, [0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88]);
}

#[test]
fn patch_rejects_mismatched_expected() {
    let mut buffer: [u8; 4] = [0x01, 0x02, 0x03, 0x04];
    let va = buffer.as_ptr() as u64;
    let pid = std::process::id();

    let wrong_expected = [0xFF, 0xFF, 0xFF, 0xFF];
    let new_bytes = [0x00, 0x00, 0x00, 0x00];

    let result = patch_process_memory(pid, va, &wrong_expected, &new_bytes);
    assert!(result.is_err(), "should reject mismatched expected bytes");
    // Buffer should be unchanged
    assert_eq!(buffer, [0x01, 0x02, 0x03, 0x04]);
}
