// ============================================================
// INTEGER IMMEDIATE PATCHER (Phase 11 — extends Tier 0)
// ============================================================
//
// At -O0, integer literal assignments compile to instructions like:
//
//   mov DWORD PTR [rbp-0x4], 0x2a    ; int x = 42;
//   mov DWORD PTR [rbp-0x8], 0x258   ; int y = 600;
//
// The immediate operand (0x2a, 0x258) sits at a known offset in the
// encoded instruction. We can patch it in the .so file directly
// without recompiling, just like string literal patching in .rodata.
//
// This module:
//   1. Takes instruction addresses from the DWARF line map
//   2. Reads the corresponding bytes from the .text section
//   3. Disassembles to find the immediate operand position + width
//   4. Returns the file offset + size so the caller can patch
//
// Constraints:
//   - Only works at -O0 (higher opt levels change instruction selection)
//   - Only patches imm32 (4 bytes) — imm8 has different encoding
//   - Only handles mov, not computed values (add/sub with immediates)

use anyhow::{Context, Result};
use iced_x86::{Decoder, DecoderOptions, Instruction, OpKind};
use object::{Object, ObjectSection};
use std::path::Path;

/// A patchable integer immediate found in the .text section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmediateLocation {
    /// Virtual address of the instruction containing the immediate.
    pub instruction_va: u64,
    /// File offset of the immediate operand within the .so.
    pub file_offset: u64,
    /// Size of the immediate in bytes (typically 4 for imm32).
    pub size: u8,
    /// The current value of the immediate.
    pub current_value: i64,
    /// Full instruction length (for context / logging).
    pub instruction_len: usize,
    /// Human-readable disassembly of the instruction.
    pub disasm: String,
}

/// Scan instructions at the given virtual addresses for integer
/// immediate operands. Returns all patchable immediates found.
///
/// `so_path`: compiled .so with DWARF
/// `addresses`: instruction VAs from `line_to_addresses`
/// `expected_old_value`: the old integer value we're looking for
///   (from the source diff). None means "return all immediates."
pub fn find_immediates(
    so_path: &Path,
    addresses: &[u64],
    expected_old_value: Option<i64>,
) -> Result<Vec<ImmediateLocation>> {
    if addresses.is_empty() {
        return Ok(Vec::new());
    }

    let data = std::fs::read(so_path)
        .with_context(|| format!("read {}", so_path.display()))?;
    let obj = object::File::parse(&*data)
        .with_context(|| format!("parse ELF {}", so_path.display()))?;

    let text_section = obj
        .section_by_name(".text")
        .context(".text section not found")?;
    let text_va = text_section.address();
    let text_file_offset = text_section.file_range()
        .map(|(off, _)| off)
        .unwrap_or(0);
    let text_data = text_section.data()?;

    let mut results = Vec::new();

    for &addr in addresses {
        if addr < text_va || addr >= text_va + text_data.len() as u64 {
            continue;
        }
        let offset_in_text = (addr - text_va) as usize;
        let remaining = &text_data[offset_in_text..];
        // Decode up to 15 bytes (max x86-64 instruction length)
        let decode_len = remaining.len().min(15);

        let mut decoder = Decoder::with_ip(
            64,
            &remaining[..decode_len],
            addr,
            DecoderOptions::NONE,
        );

        if let Some(instr) = decoder.iter().next() {
            if let Some(loc) = extract_immediate(&instr, addr, text_va, text_file_offset, expected_old_value) {
                results.push(loc);
            }
        }
    }

    Ok(results)
}

/// Patch an integer immediate in a .so file. Reads the file, replaces
/// the bytes at `location.file_offset` with the new value (little-endian),
/// writes atomically via temp+rename.
pub fn patch_immediate(
    so_path: &Path,
    location: &ImmediateLocation,
    new_value: i64,
) -> Result<()> {
    let mut bytes = std::fs::read(so_path)
        .with_context(|| format!("read {}", so_path.display()))?;

    let off = location.file_offset as usize;
    let size = location.size as usize;

    if off + size > bytes.len() {
        anyhow::bail!(
            "file offset {}+{} exceeds file size {}",
            off, size, bytes.len()
        );
    }

    // Verify the current bytes match expected_old_value
    let current = read_le_signed(&bytes[off..off + size], size);
    if current != location.current_value {
        anyhow::bail!(
            "immediate at offset {} changed since lookup (expected {}, found {})",
            off, location.current_value, current
        );
    }

    // Write new value in little-endian
    let new_bytes = new_value.to_le_bytes();
    bytes[off..off + size].copy_from_slice(&new_bytes[..size]);

    // Atomic write via temp + rename
    let tmp = so_path.with_extension("so.immpatch");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, so_path)?;

    Ok(())
}

fn extract_immediate(
    instr: &Instruction,
    instr_va: u64,
    text_va: u64,
    text_file_offset: u64,
    expected: Option<i64>,
) -> Option<ImmediateLocation> {
    // Check each operand for an immediate value
    for i in 0..instr.op_count() {
        let kind = instr.op_kind(i);
        let (value, size) = match kind {
            OpKind::Immediate32 => (instr.immediate32() as i32 as i64, 4u8),
            OpKind::Immediate32to64 => (instr.immediate32to64() as i64, 4u8),
            OpKind::Immediate16 => (instr.immediate16() as i16 as i64, 2u8),
            OpKind::Immediate8 => (instr.immediate8() as i8 as i64, 1u8),
            OpKind::Immediate8to32 => (instr.immediate8to32() as i64, 1u8),
            OpKind::Immediate8to64 => (instr.immediate8to64() as i64, 1u8),
            _ => continue,
        };

        if let Some(exp) = expected {
            if value != exp {
                continue;
            }
        }

        // Skip imm8 for patching — encoding width mismatch risk.
        // Only patch imm32 and imm16 (imm8 values that need to become
        // larger would require instruction re-encoding).
        if size < 2 {
            continue;
        }

        // The immediate operand is at the END of the instruction
        // encoding. For most x86-64 instructions with imm32, the
        // immediate is the last `size` bytes of the instruction.
        let imm_offset_in_instr = instr.len() - size as usize;
        let instr_file_offset = text_file_offset + (instr_va - text_va);
        let imm_file_offset = instr_file_offset + imm_offset_in_instr as u64;

        let disasm = format!(
            "instr@{:#x} len={} imm{}={}",
            instr_va, instr.len(), size * 8, value
        );

        return Some(ImmediateLocation {
            instruction_va: instr_va,
            file_offset: imm_file_offset,
            size,
            current_value: value,
            instruction_len: instr.len(),
            disasm,
        });
    }

    None
}

fn read_le_signed(bytes: &[u8], size: usize) -> i64 {
    match size {
        1 => bytes[0] as i8 as i64,
        2 => i16::from_le_bytes([bytes[0], bytes[1]]) as i64,
        4 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as i64,
        8 => i64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
        ]),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_le_signed_basics() {
        assert_eq!(read_le_signed(&[42, 0, 0, 0], 4), 42);
        assert_eq!(read_le_signed(&[0xfe, 0xff, 0xff, 0xff], 4), -2);
        assert_eq!(read_le_signed(&[0x58, 0x02, 0, 0], 4), 600);
    }

    #[test]
    fn immediate_location_struct() {
        let loc = ImmediateLocation {
            instruction_va: 0x1000,
            file_offset: 0x500,
            size: 4,
            current_value: 42,
            instruction_len: 7,
            disasm: "mov dword ptr [rbp-4], 2Ah".to_string(),
        };
        assert_eq!(loc.current_value, 42);
        assert_eq!(loc.size, 4);
    }
}
