// ============================================================
// LIVE PROCESS MEMORY PATCHER (Phase 11d)
// ============================================================
//
// Patches the runner's in-memory .so via /proc/<pid>/mem without
// requiring dlclose+dlopen. This eliminates the ~20ms dlopen cost
// for Tier 0 value edits.
//
// Flow:
//   1. Parse /proc/<pid>/maps to find the .so's base load address
//   2. Convert file offset → virtual address using ELF program headers
//   3. Write new bytes via /proc/<pid>/mem at the computed VA
//
// Safety:
//   - Only patches .rodata and .text (code + read-only data)
//   - Verifies current bytes at the VA match expected before writing
//   - The runner process is NOT stopped during patching — this is safe
//     because we're patching aligned data that the CPU reads atomically
//     (4-byte floats, 4-byte imm32, aligned string spans)

use anyhow::{Context, Result};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Information about a memory-mapped .so in a process.
#[derive(Debug, Clone)]
pub struct MappedSo {
    pub base_addr: u64,
    pub so_path: PathBuf,
}

/// Find the base load address of a .so in a process's memory map.
/// Parses /proc/<pid>/maps and returns the lowest address mapping
/// for the given .so path.
pub fn find_so_base_addr(pid: u32, so_path: &Path) -> Result<Option<MappedSo>> {
    let maps_content = fs::read_to_string(format!("/proc/{}/maps", pid))
        .with_context(|| format!("read /proc/{}/maps", pid))?;

    let so_name = so_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let mut best: Option<MappedSo> = None;

    for line in maps_content.lines() {
        if !line.contains(so_name) {
            continue;
        }
        // Format: start-end perms offset dev inode pathname
        let parts: Vec<&str> = line.splitn(6, char::is_whitespace).collect();
        if parts.len() < 6 {
            continue;
        }
        let addr_range = parts[0];
        let path_str = parts[5].trim();

        // Match by full path or by basename
        if !path_str.ends_with(so_name) && !path_str.contains(so_name) {
            continue;
        }

        if let Some(dash) = addr_range.find('-') {
            let start = u64::from_str_radix(&addr_range[..dash], 16).ok();
            if let Some(addr) = start {
                if best.is_none() || addr < best.as_ref().unwrap().base_addr {
                    best = Some(MappedSo {
                        base_addr: addr,
                        so_path: PathBuf::from(path_str),
                    });
                }
            }
        }
    }

    Ok(best)
}

/// Convert a file offset in the .so to a runtime virtual address
/// in the process's address space.
///
/// `file_offset`: offset within the .so file (from the patcher)
/// `base_addr`: base load address from /proc/pid/maps
/// `so_path`: path to the .so for reading ELF program headers
///
/// The translation uses the ELF LOAD program header:
///   va = base_addr + file_offset - p_offset + p_vaddr
/// where p_offset/p_vaddr come from the LOAD segment containing
/// the file_offset.
pub fn file_offset_to_va(file_offset: u64, base_addr: u64, so_path: &Path) -> Result<u64> {
    use object::{Object, ObjectSegment};
    let data = fs::read(so_path)?;
    let obj = object::File::parse(&*data)?;

    for segment in obj.segments() {
        let (seg_offset, seg_size) = segment.file_range();
        if file_offset >= seg_offset && file_offset < seg_offset + seg_size {
            let va = base_addr + file_offset - seg_offset + segment.address();
            return Ok(va);
        }
    }

    anyhow::bail!(
        "file offset {} not in any LOAD segment of {}",
        file_offset,
        so_path.display()
    )
}

/// Patch bytes in a running process's memory via /proc/pid/mem.
///
/// `pid`: target process ID
/// `va`: virtual address to write at
/// `expected`: bytes currently at that address (integrity check)
/// `new_bytes`: replacement bytes (must be same length as expected)
pub fn patch_process_memory(pid: u32, va: u64, expected: &[u8], new_bytes: &[u8]) -> Result<()> {
    if expected.len() != new_bytes.len() {
        anyhow::bail!("expected and new_bytes must be same length");
    }

    let mem_path = format!("/proc/{}/mem", pid);
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&mem_path)
        .with_context(|| format!("open {}", mem_path))?;

    // Read current bytes to verify
    file.seek(SeekFrom::Start(va))?;
    let mut current = vec![0u8; expected.len()];
    file.read_exact(&mut current)
        .with_context(|| format!("read {} bytes at VA {:#x}", expected.len(), va))?;

    if current != expected {
        anyhow::bail!(
            "memory at VA {:#x} doesn't match expected (found {:02x?}, expected {:02x?})",
            va,
            &current[..current.len().min(8)],
            &expected[..expected.len().min(8)]
        );
    }

    // Write new bytes
    file.seek(SeekFrom::Start(va))?;
    file.write_all(new_bytes)
        .with_context(|| format!("write {} bytes at VA {:#x}", new_bytes.len(), va))?;

    Ok(())
}

/// High-level: patch a file offset in a running process's .so.
/// Combines find_so_base_addr + file_offset_to_va + patch_process_memory.
pub fn patch_live(
    pid: u32,
    so_path: &Path,
    file_offset: u64,
    expected: &[u8],
    new_bytes: &[u8],
) -> Result<()> {
    let mapped = find_so_base_addr(pid, so_path)?
        .with_context(|| format!("{} not found in /proc/{}/maps", so_path.display(), pid))?;

    let va = file_offset_to_va(file_offset, mapped.base_addr, so_path)?;

    eprintln!(
        "[HMR] patch_live: pid={} so={} file_off={:#x} → VA={:#x} ({} bytes)",
        pid,
        so_path.display(),
        file_offset,
        va,
        new_bytes.len()
    );

    patch_process_memory(pid, va, expected, new_bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_so_base_addr_self() {
        // /proc/self/maps should contain libc
        let pid = std::process::id();
        let result = find_so_base_addr(pid, Path::new("libc.so")).unwrap();
        assert!(result.is_some(), "should find libc in own maps");
        assert!(result.unwrap().base_addr > 0);
    }

    #[test]
    fn find_so_base_addr_missing() {
        let pid = std::process::id();
        let result = find_so_base_addr(pid, Path::new("nonexistent_lib.so")).unwrap();
        assert!(result.is_none());
    }
}
