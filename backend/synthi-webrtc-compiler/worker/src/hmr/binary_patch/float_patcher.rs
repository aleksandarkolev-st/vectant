// ============================================================
// FLOAT LITERAL PATCHER (Phase 11 — extends Tier 0)
// ============================================================
//
// At -O0, float/double literals are stored in .rodata as IEEE 754
// bytes and loaded via RIP-relative movss/movsd:
//
//   movss xmm0, DWORD PTR [rip+0xNNN]   ; float (4 bytes in .rodata)
//   movsd xmm0, QWORD PTR [rip+0xNNN]   ; double (8 bytes in .rodata)
//
// This module:
//   1. Takes instruction addresses from the DWARF line map
//   2. Disassembles to find movss/movsd with RIP-relative memory operand
//   3. Computes the .rodata file offset from the RIP displacement
//   4. Returns the location so the caller can patch the IEEE 754 bytes

use anyhow::{Context, Result};
use iced_x86::{Decoder, DecoderOptions, Instruction, Mnemonic, OpKind};
use object::{Object, ObjectSection};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct FloatLocation {
    pub instruction_va: u64,
    pub rodata_file_offset: u64,
    pub size: u8,
    pub current_bytes: Vec<u8>,
    pub current_value: f64,
}

/// Scan instructions at the given VAs for movss/movsd with
/// RIP-relative operands (float loads from .rodata).
pub fn find_float_loads(
    so_path: &Path,
    addresses: &[u64],
    expected_value: Option<f64>,
    is_float: bool,
) -> Result<Vec<FloatLocation>> {
    if addresses.is_empty() {
        return Ok(Vec::new());
    }

    let data = std::fs::read(so_path)
        .with_context(|| format!("read {}", so_path.display()))?;
    let obj = object::File::parse(&*data)
        .with_context(|| format!("parse ELF {}", so_path.display()))?;

    let text = obj.section_by_name(".text").context("no .text")?;
    let text_va = text.address();
    let text_file_off = text.file_range().map(|(o, _)| o).unwrap_or(0);
    let text_data = text.data()?;

    let mut results = Vec::new();
    let size: u8 = if is_float { 4 } else { 8 };

    for &addr in addresses {
        if addr < text_va || addr >= text_va + text_data.len() as u64 {
            continue;
        }
        let off = (addr - text_va) as usize;
        let remaining = &text_data[off..];
        let decode_len = remaining.len().min(15);

        let mut decoder = Decoder::with_ip(64, &remaining[..decode_len], addr, DecoderOptions::NONE);
        if let Some(instr) = decoder.iter().next() {
            let mnemonic = instr.mnemonic();
            let is_movss = mnemonic == Mnemonic::Movss;
            let is_movsd = mnemonic == Mnemonic::Movsd;
            if !is_movss && !is_movsd {
                continue;
            }
            // Check size matches requested type
            if is_float && !is_movss {
                continue;
            }
            if !is_float && !is_movsd {
                continue;
            }

            if let Some(loc) = extract_rip_relative_float(
                &instr, addr, &data, text_va, text_file_off, size, expected_value,
            ) {
                results.push(loc);
            }
        }
    }

    Ok(results)
}

/// Patch a float/double in .rodata. Writes the new IEEE 754 bytes
/// at the location's file offset via atomic temp+rename.
pub fn patch_float(
    so_path: &Path,
    location: &FloatLocation,
    new_value: f64,
    is_float: bool,
) -> Result<()> {
    let mut bytes = std::fs::read(so_path)
        .with_context(|| format!("read {}", so_path.display()))?;

    let off = location.rodata_file_offset as usize;
    let size = location.size as usize;

    if off + size > bytes.len() {
        anyhow::bail!("offset {}+{} exceeds file size {}", off, size, bytes.len());
    }

    // Verify current bytes match
    if bytes[off..off + size] != location.current_bytes[..] {
        anyhow::bail!("bytes at offset {} changed since lookup", off);
    }

    // Write new IEEE 754 encoding
    if is_float {
        let new_bytes = (new_value as f32).to_le_bytes();
        bytes[off..off + 4].copy_from_slice(&new_bytes);
    } else {
        let new_bytes = new_value.to_le_bytes();
        bytes[off..off + 8].copy_from_slice(&new_bytes);
    }

    let tmp = so_path.with_extension("so.floatpatch");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, so_path)?;
    Ok(())
}

fn extract_rip_relative_float(
    instr: &Instruction,
    instr_va: u64,
    file_data: &[u8],
    text_va: u64,
    text_file_off: u64,
    size: u8,
    expected: Option<f64>,
) -> Option<FloatLocation> {
    // movss/movsd: operand 1 is memory (source), operand 0 is xmm (dest)
    // OR operand 0 is memory (dest), operand 1 is xmm (source)
    // We want the memory operand with RIP-relative addressing.
    for i in 0..instr.op_count() {
        if instr.op_kind(i) != OpKind::Memory {
            continue;
        }
        if !instr.is_ip_rel_memory_operand() {
            continue;
        }

        let target_va = instr.ip_rel_memory_address();
        // Convert VA to file offset: target_file_off = text_file_off + (target_va - text_va)
        // This works when .rodata is laid out contiguously after .text in the ELF,
        // which is the common case. For robustness, use the section table.
        let target_file_off = if target_va >= text_va {
            text_file_off + (target_va - text_va)
        } else {
            return None;
        };

        let off = target_file_off as usize;
        let sz = size as usize;
        if off + sz > file_data.len() {
            return None;
        }

        let current_bytes = file_data[off..off + sz].to_vec();
        let current_value = if size == 4 {
            f32::from_le_bytes([current_bytes[0], current_bytes[1], current_bytes[2], current_bytes[3]]) as f64
        } else {
            f64::from_le_bytes([
                current_bytes[0], current_bytes[1], current_bytes[2], current_bytes[3],
                current_bytes[4], current_bytes[5], current_bytes[6], current_bytes[7],
            ])
        };

        if let Some(exp) = expected {
            let tolerance = if size == 4 { 1e-5 } else { 1e-10 };
            if (current_value - exp).abs() > tolerance {
                continue;
            }
        }

        return Some(FloatLocation {
            instruction_va: instr_va,
            rodata_file_offset: target_file_off,
            size,
            current_bytes,
            current_value,
        });
    }
    None
}

/// Parse a C float/double literal string to f64.
pub fn parse_c_float(text: &str) -> Option<f64> {
    let s = text.trim().trim_end_matches(|c: char| c == 'f' || c == 'F' || c == 'l' || c == 'L');
    s.parse::<f64>().ok()
}

/// Detect whether a number literal string is a float (vs integer).
pub fn is_float_literal(text: &str) -> bool {
    let s = text.trim();
    s.contains('.') || s.ends_with('f') || s.ends_with('F')
        || s.contains('e') || s.contains('E')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_c_float_basic() {
        assert!((parse_c_float("3.14f").unwrap() - 3.14).abs() < 1e-5);
        assert!((parse_c_float("2.718").unwrap() - 2.718).abs() < 1e-10);
        assert!((parse_c_float("1.0e3").unwrap() - 1000.0).abs() < 1e-5);
    }

    #[test]
    fn is_float_literal_detects() {
        assert!(is_float_literal("3.14f"));
        assert!(is_float_literal("2.718"));
        assert!(is_float_literal("1e3"));
        assert!(!is_float_literal("42"));
        assert!(!is_float_literal("0xFF"));
    }
}
