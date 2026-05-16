// ============================================================
// DWARF LINE → ADDRESS MAPPING (Phase 11a foundation)
// ============================================================
//
// Maps (source_file, line_number) → [virtual addresses] by parsing
// the DWARF .debug_line section in a compiled .so file.
//
// Requires: -g -gdwarf-4 in compile flags (already in sdl2_default).
// Requires: -O0 to prevent instruction reordering.

use anyhow::{Context, Result};
use gimli::{EndianSlice, RunTimeEndian};
use object::{Object, ObjectSection};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineAddress {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub address: u64,
    pub is_stmt: bool,
}

pub fn line_to_addresses(
    so_path: &Path,
    source_file: &str,
    line_number: u32,
) -> Result<Vec<LineAddress>> {
    let data = std::fs::read(so_path).with_context(|| format!("read {}", so_path.display()))?;
    let obj =
        object::File::parse(&*data).with_context(|| format!("parse ELF {}", so_path.display()))?;

    let endian = if obj.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };

    let load_section = |name: &str| -> &[u8] {
        obj.section_by_name(name)
            .and_then(|s| s.data().ok())
            .unwrap_or(&[])
    };

    let dwarf = gimli::Dwarf {
        debug_abbrev: gimli::DebugAbbrev::new(load_section(".debug_abbrev"), endian),
        debug_info: gimli::DebugInfo::new(load_section(".debug_info"), endian),
        debug_str: gimli::DebugStr::new(load_section(".debug_str"), endian),
        debug_line: gimli::DebugLine::new(load_section(".debug_line"), endian),
        debug_line_str: gimli::DebugLineStr::new(load_section(".debug_line_str"), endian),
        debug_addr: gimli::DebugAddr::from(EndianSlice::new(&[], endian)),
        debug_aranges: gimli::DebugAranges::new(&[], endian),
        debug_str_offsets: gimli::DebugStrOffsets::from(EndianSlice::new(&[], endian)),
        debug_types: gimli::DebugTypes::new(&[], endian),
        locations: gimli::LocationLists::new(
            gimli::DebugLoc::new(&[], endian),
            gimli::DebugLocLists::new(&[], endian),
        ),
        ranges: gimli::RangeLists::new(
            gimli::DebugRanges::new(&[], endian),
            gimli::DebugRngLists::new(&[], endian),
        ),
        file_type: gimli::DwarfFileType::Main,
        sup: None,
        abbreviations_cache: gimli::AbbreviationsCache::new(),
    };

    let source_basename = Path::new(source_file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(source_file);

    let mut results = Vec::new();

    let mut unit_iter = dwarf.units();
    while let Ok(Some(header)) = unit_iter.next() {
        let unit = match dwarf.unit(header) {
            Ok(u) => u,
            Err(_) => continue,
        };

        let line_program = match unit.line_program.clone() {
            Some(lp) => lp,
            None => continue,
        };

        let (program, sequences) = match line_program.sequences() {
            Ok(s) => s,
            Err(_) => continue,
        };

        for seq in &sequences {
            let mut sm = program.resume_from(seq);
            while let Ok(Some((_header, row))) = sm.next_row() {
                let row_line = match row.line() {
                    Some(l) => l.get() as u32,
                    None => continue,
                };
                if row_line != line_number {
                    continue;
                }
                let file_entry = match row.file(program.header()) {
                    Some(fe) => fe,
                    None => continue,
                };
                let file_name = resolve_file_name(
                    file_entry,
                    program.header(),
                    &dwarf.debug_str,
                    &dwarf.debug_line_str,
                );
                let file_basename = Path::new(&file_name)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&file_name)
                    .to_string();

                if file_basename != source_basename {
                    continue;
                }

                let col = match row.column() {
                    gimli::ColumnType::LeftEdge => 0,
                    gimli::ColumnType::Column(c) => c.get() as u32,
                };

                results.push(LineAddress {
                    file: file_name,
                    line: line_number,
                    column: col,
                    address: row.address(),
                    is_stmt: row.is_stmt(),
                });
            }
        }
    }

    results.sort_by_key(|e| e.address);
    results.dedup();
    Ok(results)
}

/// Read .rodata section from an ELF file. Returns (file_offset, bytes).
pub fn read_rodata(so_path: &Path) -> Result<Option<(u64, Vec<u8>)>> {
    let data = std::fs::read(so_path).with_context(|| format!("read {}", so_path.display()))?;
    let obj =
        object::File::parse(&*data).with_context(|| format!("parse ELF {}", so_path.display()))?;

    if let Some(section) = obj.section_by_name(".rodata") {
        let offset = section.file_range().map(|(off, _)| off).unwrap_or(0);
        let bytes = section.data()?.to_vec();
        Ok(Some((offset, bytes)))
    } else {
        Ok(None)
    }
}

fn resolve_attr_string(
    attr: gimli::AttributeValue<EndianSlice<'_, RunTimeEndian>, usize>,
    debug_str: &gimli::DebugStr<EndianSlice<'_, RunTimeEndian>>,
    debug_line_str: &gimli::DebugLineStr<EndianSlice<'_, RunTimeEndian>>,
) -> String {
    match attr {
        gimli::AttributeValue::String(s) => s.to_string_lossy().to_string(),
        gimli::AttributeValue::DebugStrRef(offset) => debug_str
            .get_str(offset)
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        gimli::AttributeValue::DebugLineStrRef(offset) => debug_line_str
            .get_str(offset)
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn resolve_file_name(
    file_entry: &gimli::FileEntry<EndianSlice<'_, RunTimeEndian>, usize>,
    header: &gimli::LineProgramHeader<EndianSlice<'_, RunTimeEndian>, usize>,
    debug_str: &gimli::DebugStr<EndianSlice<'_, RunTimeEndian>>,
    debug_line_str: &gimli::DebugLineStr<EndianSlice<'_, RunTimeEndian>>,
) -> String {
    let mut path = String::new();

    if let Some(dir) = file_entry.directory(header) {
        let dir_str = resolve_attr_string(dir, debug_str, debug_line_str);
        if !dir_str.is_empty() {
            path.push_str(&dir_str);
            if !dir_str.ends_with('/') {
                path.push('/');
            }
        }
    }

    let name = resolve_attr_string(file_entry.path_name(), debug_str, debug_line_str);
    path.push_str(&name);
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_address_struct_basics() {
        let la = LineAddress {
            file: "core.cpp".to_string(),
            line: 42,
            column: 5,
            address: 0x1234,
            is_stmt: true,
        };
        assert_eq!(la.line, 42);
        assert_eq!(la.address, 0x1234);
    }
}
