// ============================================================
// STATE TYPE IDENTIFICATION - ROBUST TYPE MATCHING
// ============================================================
// Addresses requirement #2: Don't do DWARF "find struct by size"
//
// PROBLEM WITH SIZE-BASED MATCHING:
// - Many structs share sizes (e.g., all 64-byte structs)
// - Size can match but layout can differ (padding, field order)
// - Size match gives false confidence in memcpy safety
//
// SOLUTION - EXPLICIT TYPE IDENTIFICATION:
// 1. Module exports `state_type_id` - a stable identifier for the state type
// 2. DWARF lookup uses this exact type name, not size
// 3. Layout hash is computed for that specific type
// 4. Alternatively: embed layout info in ELF note section
//
// HIERARCHY OF IDENTIFICATION:
// 1. Best: Module exports `hot_state_type_id()` returning stable type name
// 2. Good: ELF .note.synthi.state section with type + precomputed hash
// 3. Fallback: Module manifest with explicit schema
// 4. FORBIDDEN: Size-based DWARF search (removed)
// ============================================================

#![allow(dead_code)]

use std::hash::{Hash, Hasher};
use std::path::Path;

// Import libloading for dynamic symbol extraction
// Note: memmap2 and object are used conditionally in unix builds

// ============================================================
// TYPE EQUIVALENCE RESULT
// ============================================================

/// Result of comparing two state type IDs
#[derive(Debug, Clone)]
pub enum TypeEquivalence {
    /// Types are identical - safe for memcpy
    Identical,
    /// Types have compatible layout but minor differences (e.g., same fields, different ordering in BTreeMap)
    LayoutCompatible { differences: Vec<String> },
    /// Types are incompatible - must use migration
    Incompatible { reasons: Vec<String> },
}

// ============================================================
// STATE TYPE IDENTIFIER
// ============================================================

/// A stable identifier for a state type
/// This must be unique per state struct across all modules
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StateTypeId {
    /// Fully qualified type name (e.g., "synthi::core::CoreState")
    pub type_name: String,
    /// Module that owns this type
    pub module: String,
    /// Version of this type definition
    pub type_version: u32,
}

impl StateTypeId {
    pub fn new(type_name: impl Into<String>, module: impl Into<String>, version: u32) -> Self {
        Self {
            type_name: type_name.into(),
            module: module.into(),
            type_version: version,
        }
    }
    
    /// Compute a 128-bit stable hash of this type ID
    pub fn compute_hash(&self) -> u128 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        self.type_name.hash(&mut hasher);
        self.module.hash(&mut hasher);
        self.type_version.hash(&mut hasher);
        let h1 = hasher.finish();
        
        // Second hash with different seed for 128-bit
        let mut hasher2 = DefaultHasher::new();
        self.type_version.hash(&mut hasher2);
        self.type_name.hash(&mut hasher2);
        self.module.hash(&mut hasher2);
        let h2 = hasher2.finish();
        
        ((h1 as u128) << 64) | (h2 as u128)
    }
    
    /// Compute a 64-bit hash (for HotApi compatibility)
    pub fn compute_hash_64(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        self.type_name.hash(&mut hasher);
        self.module.hash(&mut hasher);
        self.type_version.hash(&mut hasher);
        hasher.finish()
    }
    
    /// Check equivalence with another StateTypeId
    pub fn check_equivalence(&self, other: &StateTypeId) -> TypeEquivalence {
        let mut differences = Vec::new();
        let mut incompatible_reasons = Vec::new();
        
        // Type name must match exactly
        if self.type_name != other.type_name {
            incompatible_reasons.push(format!(
                "Type name mismatch: {} vs {}",
                self.type_name, other.type_name
            ));
        }
        
        // Module can differ if type was moved (warning, not error)
        if self.module != other.module {
            differences.push(format!(
                "Module changed: {} -> {}",
                self.module, other.module
            ));
        }
        
        // Version mismatch is critical
        if self.type_version != other.type_version {
            incompatible_reasons.push(format!(
                "Type version mismatch: {} vs {}",
                self.type_version, other.type_version
            ));
        }
        
        if !incompatible_reasons.is_empty() {
            TypeEquivalence::Incompatible { reasons: incompatible_reasons }
        } else if !differences.is_empty() {
            TypeEquivalence::LayoutCompatible { differences }
        } else {
            TypeEquivalence::Identical
        }
    }
}

/// Extract StateTypeId from a loaded module
pub fn extract_state_type_id(module_path: &Path) -> Result<StateTypeId, String> {
    let module_name = module_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    
    // Try method 1: Load library and read exported symbol
    if let Some(type_id) = try_extract_from_symbol(module_path, module_name) {
        return Ok(type_id);
    }
    
    // Try method 2: Read from ELF note section
    #[cfg(unix)]
    if let Some(type_id) = try_extract_type_id_from_elf_note(module_path, module_name) {
        return Ok(type_id);
    }
    
    // Fallback: Generate a default (warns that type equivalence can't be trusted)
    eprintln!("[StateTypeId] WARNING: Could not extract real type ID from {}", module_path.display());
    eprintln!("[StateTypeId] Using fallback - type equivalence checks may not be reliable");
    Ok(StateTypeId {
        type_name: format!("{}::State", module_name),
        module: module_name.to_string(),
        type_version: 1,
    })
}

/// Try to extract type ID from exported symbol using libloading
fn try_extract_from_symbol(module_path: &Path, module_name: &str) -> Option<StateTypeId> {
    // Safety: We're loading the library just to read symbols, then immediately unloading
    let lib = unsafe {
        libloading::Library::new(module_path).ok()?
    };
    
    // Try to get hot_state_type_id function
    let type_id_fn: Result<libloading::Symbol<StateTypeIdFn>, _> = unsafe {
        lib.get(STATE_TYPE_ID_SYMBOL)
    };
    
    if let Ok(func) = type_id_fn {
        let type_name_ptr = unsafe { func() };
        if !type_name_ptr.is_null() {
            let type_name = unsafe {
                std::ffi::CStr::from_ptr(type_name_ptr)
                    .to_str()
                    .ok()?
                    .to_string()
            };
            
            // Try to get layout hash
            let layout_hash: Option<u64> = unsafe {
                lib.get::<StateLayoutHashFn>(STATE_LAYOUT_HASH_SYMBOL)
                    .ok()
                    .map(|f| f())
            };
            
            // Try to get semantic hash for version
            let semantic_hash: Option<u64> = unsafe {
                lib.get::<StateSemanticHashFn>(STATE_SEMANTIC_HASH_SYMBOL)
                    .ok()
                    .map(|f| f())
            };
            
            // Use semantic hash as version if available, otherwise default to 1
            let type_version = semantic_hash
                .map(|h| (h & 0xFFFFFFFF) as u32)
                .unwrap_or(1);
            
            eprintln!("[StateTypeId] Extracted from symbol: type={}, version={}, layout_hash={:?}",
                      type_name, type_version, layout_hash);
            
            return Some(StateTypeId {
                type_name,
                module: module_name.to_string(),
                type_version,
            });
        }
    }
    
    None
}

/// Try to extract type ID from ELF note section
#[cfg(unix)]
fn try_extract_type_id_from_elf_note(module_path: &Path, module_name: &str) -> Option<StateTypeId> {
    use std::fs::File;
    use object::{Object, ObjectSection};
    
    let file = File::open(module_path).ok()?;
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    let obj = object::File::parse(&*mmap).ok()?;
    
    // Look for .note.synthi.state section
    for section in obj.sections() {
        if let Ok(name) = section.name() {
            if name == ".note.synthi.state" {
                if let Ok(data) = section.data() {
                    // Parse note format
                    if data.len() >= 16 {
                        let namesz = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
                        let descsz = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
                        let note_type = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
                        
                        if note_type == NOTE_TYPE_STATE_INFO {
                            let name_offset = 12;
                            let aligned_namesz = (namesz + 3) & !3;
                            let desc_offset = name_offset + aligned_namesz;
                            
                            if data.len() >= desc_offset + descsz {
                                let payload_data = &data[desc_offset..desc_offset + descsz];
                                if let Some((payload, type_name)) = StateNotePayload::from_bytes(payload_data) {
                                    eprintln!("[StateTypeId] Extracted from ELF note: type={}, version={}",
                                              type_name, payload.note_version);
                                    return Some(StateTypeId {
                                        type_name,
                                        module: module_name.to_string(),
                                        type_version: payload.note_version,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    None
}

// ============================================================
// EXPORTED TYPE IDENTIFICATION SYMBOLS
// ============================================================

/// Symbol name for type ID export (returns pointer to null-terminated type name)
pub const STATE_TYPE_ID_SYMBOL: &[u8] = b"hot_state_type_id\0";

/// Symbol name for layout hash export (returns precomputed u64 hash)  
pub const STATE_LAYOUT_HASH_SYMBOL: &[u8] = b"hot_state_layout_hash\0";

/// Symbol name for semantic hash export (returns u64 hash of semantics)
pub const STATE_SEMANTIC_HASH_SYMBOL: &[u8] = b"hot_state_semantic_hash\0";

/// Function type: returns pointer to null-terminated type name string
/// The string should be stable across builds (e.g., "mymodule::MyState")
pub type StateTypeIdFn = unsafe extern "C" fn() -> *const std::ffi::c_char;

/// Function type: returns precomputed layout hash
/// This should be computed at build time from the actual struct layout
pub type StateLayoutHashFn = unsafe extern "C" fn() -> u64;

/// Function type: returns semantic hash for reload safety
pub type StateSemanticHashFn = unsafe extern "C" fn() -> u64;

// ============================================================
// ELF NOTE SECTION FORMAT
// ============================================================
// Alternative to exported symbols: embed info in ELF note section
// 
// Section: .note.synthi.state
// Format:
//   namesz: 7 ("SYNTHI\0")
//   descsz: variable
//   type: 1 (STATE_INFO)
//   name: "SYNTHI\0" (padded to 8 bytes)
//   desc: StateNotePayload (binary)
// ============================================================

/// Note type constants
pub const NOTE_TYPE_STATE_INFO: u32 = 1;
pub const NOTE_NAME: &[u8] = b"SYNTHI\0\0"; // Padded to 8 bytes

/// Payload stored in ELF note section
#[derive(Debug, Clone)]
#[repr(C)]
pub struct StateNotePayload {
    /// Version of this note format
    pub note_version: u32,
    /// Type name hash (quick comparison)
    pub type_name_hash: u64,
    /// Precomputed layout hash
    pub layout_hash: u64,
    /// Semantic hash
    pub semantic_hash: u64,
    /// State struct size in bytes
    pub state_size: u64,
    /// State struct alignment
    pub state_align: u32,
    /// Length of type name string that follows
    pub type_name_len: u32,
    // Followed by: type_name_len bytes of UTF-8 type name (null-terminated)
}

impl StateNotePayload {
    pub const CURRENT_VERSION: u32 = 1;
    
    /// Serialize to bytes (for embedding in ELF)
    pub fn to_bytes(&self, type_name: &str) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(
            std::mem::size_of::<Self>() + type_name.len() + 1
        );
        
        bytes.extend_from_slice(&self.note_version.to_le_bytes());
        bytes.extend_from_slice(&self.type_name_hash.to_le_bytes());
        bytes.extend_from_slice(&self.layout_hash.to_le_bytes());
        bytes.extend_from_slice(&self.semantic_hash.to_le_bytes());
        bytes.extend_from_slice(&self.state_size.to_le_bytes());
        bytes.extend_from_slice(&self.state_align.to_le_bytes());
        bytes.extend_from_slice(&(type_name.len() as u32 + 1).to_le_bytes());
        bytes.extend_from_slice(type_name.as_bytes());
        bytes.push(0); // Null terminator
        
        bytes
    }
    
    /// Parse from bytes (from ELF note section)
    pub fn from_bytes(data: &[u8]) -> Option<(Self, String)> {
        if data.len() < std::mem::size_of::<Self>() {
            return None;
        }
        
        let mut cursor = 0;
        
        let read_u32 = |cursor: &mut usize| -> Option<u32> {
            if *cursor + 4 > data.len() { return None; }
            let val = u32::from_le_bytes(data[*cursor..*cursor + 4].try_into().ok()?);
            *cursor += 4;
            Some(val)
        };
        
        let read_u64 = |cursor: &mut usize| -> Option<u64> {
            if *cursor + 8 > data.len() { return None; }
            let val = u64::from_le_bytes(data[*cursor..*cursor + 8].try_into().ok()?);
            *cursor += 8;
            Some(val)
        };
        
        let note_version = read_u32(&mut cursor)?;
        let type_name_hash = read_u64(&mut cursor)?;
        let layout_hash = read_u64(&mut cursor)?;
        let semantic_hash = read_u64(&mut cursor)?;
        let state_size = read_u64(&mut cursor)?;
        let state_align = read_u32(&mut cursor)?;
        let type_name_len = read_u32(&mut cursor)?;
        
        if cursor + type_name_len as usize > data.len() {
            return None;
        }
        
        let type_name_bytes = &data[cursor..cursor + type_name_len as usize - 1]; // Exclude null
        let type_name = String::from_utf8(type_name_bytes.to_vec()).ok()?;
        
        Some((
            StateNotePayload {
                note_version,
                type_name_hash,
                layout_hash,
                semantic_hash,
                state_size,
                state_align,
                type_name_len,
            },
            type_name,
        ))
    }
}

// ============================================================
// TYPE EXTRACTION FROM MODULE
// ============================================================

/// Result of extracting type identification from a module
#[derive(Debug, Clone)]
pub struct ExtractedTypeInfo {
    /// The state type identifier
    pub type_id: Option<StateTypeId>,
    /// Layout hash (for memcpy safety)
    pub layout_hash: Option<u64>,
    /// Semantic hash (for reload safety)
    pub semantic_hash: Option<u64>,
    /// How the info was obtained
    pub source: TypeInfoSource,
}

/// How type info was obtained
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeInfoSource {
    /// From exported hot_state_type_id() function
    ExportedSymbol,
    /// From .note.synthi.state ELF section
    ElfNote,
    /// From module manifest
    Manifest,
    /// Could not extract - memcpy forbidden
    NotAvailable,
}

impl ExtractedTypeInfo {
    /// Check if memcpy is safe based on extracted info
    pub fn is_memcpy_safe(&self, other: &ExtractedTypeInfo) -> MemcpySafety {
        // Must have layout hashes from both
        let (our_hash, their_hash) = match (self.layout_hash, other.layout_hash) {
            (Some(a), Some(b)) => (a, b),
            (None, _) => return MemcpySafety::Forbidden {
                reason: "Missing layout hash from current module".to_string(),
            },
            (_, None) => return MemcpySafety::Forbidden {
                reason: "Missing layout hash from new module".to_string(),
            },
        };
        
        // Layout hashes must match exactly
        if our_hash != their_hash {
            return MemcpySafety::Forbidden {
                reason: format!(
                    "Layout hash mismatch: 0x{:016x} vs 0x{:016x}",
                    our_hash, their_hash
                ),
            };
        }
        
        // Type IDs should match if both present
        if let (Some(ref our_type), Some(ref their_type)) = (&self.type_id, &other.type_id) {
            if our_type.type_name != their_type.type_name {
                return MemcpySafety::Forbidden {
                    reason: format!(
                        "Type name mismatch: '{}' vs '{}'",
                        our_type.type_name, their_type.type_name
                    ),
                };
            }
        }
        
        MemcpySafety::Safe { layout_hash: our_hash }
    }
    
    /// Check if reload is semantically safe (not just memory-safe)
    pub fn is_reload_safe(&self, other: &ExtractedTypeInfo) -> ReloadSafety {
        // First check memcpy safety
        let memcpy = self.is_memcpy_safe(other);
        if let MemcpySafety::Forbidden { reason } = &memcpy {
            return ReloadSafety::RequiresMigration {
                reason: reason.clone(),
            };
        }
        
        // Check semantic hashes
        match (self.semantic_hash, other.semantic_hash) {
            (Some(a), Some(b)) if a != b => {
                ReloadSafety::RequiresMigration {
                    reason: format!(
                        "Semantic hash changed: 0x{:016x} -> 0x{:016x}. \
                         State meaning may have changed even if layout matches.",
                        a, b
                    ),
                }
            }
            (Some(_), None) | (None, Some(_)) => {
                // One side missing semantic hash - warn but allow
                ReloadSafety::SafeWithWarning {
                    layout_hash: self.layout_hash.unwrap_or(0),
                    warning: "Semantic hash missing from one module - cannot verify invariants".to_string(),
                }
            }
            _ => {
                ReloadSafety::Safe {
                    layout_hash: self.layout_hash.unwrap_or(0),
                    semantic_hash: self.semantic_hash,
                }
            }
        }
    }
}

/// Result of memcpy safety check
#[derive(Debug, Clone)]
pub enum MemcpySafety {
    /// Safe to memcpy state
    Safe { layout_hash: u64 },
    /// Memcpy forbidden - must use serialization/migration
    Forbidden { reason: String },
}

impl MemcpySafety {
    pub fn is_safe(&self) -> bool {
        matches!(self, MemcpySafety::Safe { .. })
    }
}

/// Result of reload safety check (semantic, not just memory)
#[derive(Debug, Clone)]
pub enum ReloadSafety {
    /// Safe to reload with state preservation
    Safe { layout_hash: u64, semantic_hash: Option<u64> },
    /// Safe but with warning
    SafeWithWarning { layout_hash: u64, warning: String },
    /// Must use migration (semantics changed)
    RequiresMigration { reason: String },
}

impl ReloadSafety {
    pub fn is_safe(&self) -> bool {
        matches!(self, ReloadSafety::Safe { .. } | ReloadSafety::SafeWithWarning { .. })
    }
}

// ============================================================
// EXTRACTION FUNCTIONS
// ============================================================

/// Extract type info from a loaded library
pub fn extract_type_info(lib: &libloading::Library, module_name: &str) -> ExtractedTypeInfo {
    // Try exported symbols first (best)
    if let Some(info) = try_extract_from_symbols(lib, module_name) {
        return info;
    }
    
    // Note section extraction would require the file path
    // That's handled separately in extract_type_info_from_path
    
    ExtractedTypeInfo {
        type_id: None,
        layout_hash: None,
        semantic_hash: None,
        source: TypeInfoSource::NotAvailable,
    }
}

/// Extract type info from a library file (including ELF sections)
pub fn extract_type_info_from_path(path: &Path, module_name: &str) -> ExtractedTypeInfo {
    // Try ELF note section
    #[cfg(unix)]
    if let Some(info) = try_extract_from_elf_note(path, module_name) {
        return info;
    }
    
    // Try loading library and checking symbols
    if let Ok(lib) = unsafe { libloading::Library::new(path) } {
        let info = extract_type_info(&lib, module_name);
        if info.source != TypeInfoSource::NotAvailable {
            return info;
        }
    }
    
    ExtractedTypeInfo {
        type_id: None,
        layout_hash: None,
        semantic_hash: None,
        source: TypeInfoSource::NotAvailable,
    }
}

fn try_extract_from_symbols(lib: &libloading::Library, module_name: &str) -> Option<ExtractedTypeInfo> {
    unsafe {
        // Try to get type ID
        let type_id: Option<StateTypeId> = lib.get::<StateTypeIdFn>(STATE_TYPE_ID_SYMBOL)
            .ok()
            .and_then(|func| {
                let ptr = func();
                if ptr.is_null() { return None; }
                let cstr = std::ffi::CStr::from_ptr(ptr);
                let type_name = cstr.to_str().ok()?.to_string();
                Some(StateTypeId::new(type_name, module_name, 1))
            });
        
        // Try to get layout hash
        let layout_hash: Option<u64> = lib.get::<StateLayoutHashFn>(STATE_LAYOUT_HASH_SYMBOL)
            .ok()
            .map(|func| func());
        
        // Try to get semantic hash
        let semantic_hash: Option<u64> = lib.get::<StateSemanticHashFn>(STATE_SEMANTIC_HASH_SYMBOL)
            .ok()
            .map(|func| func());
        
        // If we got at least one thing, we succeeded
        if type_id.is_some() || layout_hash.is_some() {
            return Some(ExtractedTypeInfo {
                type_id,
                layout_hash,
                semantic_hash,
                source: TypeInfoSource::ExportedSymbol,
            });
        }
        
        None
    }
}

#[cfg(unix)]
fn try_extract_from_elf_note(path: &Path, module_name: &str) -> Option<ExtractedTypeInfo> {
    use object::{Object, ObjectSection};
    use std::fs::File;
    
    let file = File::open(path).ok()?;
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    let obj = object::File::parse(&*mmap).ok()?;
    
    // Look for .note.synthi.state section
    for section in obj.sections() {
        let name = section.name().ok()?;
        if name == ".note.synthi.state" {
            let data = section.data().ok()?;
            
            // Parse note format
            if data.len() < 12 { continue; }
            let namesz = u32::from_le_bytes(data[0..4].try_into().ok()?) as usize;
            let descsz = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
            let note_type = u32::from_le_bytes(data[8..12].try_into().ok()?);
            
            if note_type != NOTE_TYPE_STATE_INFO { continue; }
            
            // Skip name (aligned to 4 bytes)
            let name_offset = 12;
            let aligned_namesz = (namesz + 3) & !3;
            let desc_offset = name_offset + aligned_namesz;
            
            if data.len() < desc_offset + descsz { continue; }
            
            let desc_data = &data[desc_offset..desc_offset + descsz];
            let (payload, type_name) = StateNotePayload::from_bytes(desc_data)?;
            
            return Some(ExtractedTypeInfo {
                type_id: Some(StateTypeId::new(type_name, module_name, 1)),
                layout_hash: Some(payload.layout_hash),
                semantic_hash: Some(payload.semantic_hash),
                source: TypeInfoSource::ElfNote,
            });
        }
    }
    
    None
}

#[cfg(not(unix))]
fn try_extract_from_elf_note(_path: &Path, _module_name: &str) -> Option<ExtractedTypeInfo> {
    None
}

// ============================================================
// DWARF LOOKUP BY EXACT TYPE NAME (NOT SIZE)
// ============================================================
// This is the CORRECT way to use DWARF: look up a specific type by name,
// not search for structs matching a size.

#[cfg(unix)]
pub fn lookup_type_layout_in_dwarf(
    path: &Path,
    type_name: &str,
) -> Option<TypeLayoutInfo> {
    use gimli::{EndianSlice, Reader, RunTimeEndian};
    use object::{Object, ObjectSection};
    use std::fs::File;
    
    let file = File::open(path).ok()?;
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    let obj = object::File::parse(&*mmap).ok()?;
    
    let endian = if obj.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };
    
    // Load DWARF sections
    let load_section = |name: &str| -> Option<&[u8]> {
        obj.section_by_name(name).and_then(|s| s.data().ok())
    };
    
    let debug_abbrev = load_section(".debug_abbrev")?;
    let debug_info = load_section(".debug_info")?;
    let debug_str = load_section(".debug_str").unwrap_or(&[]);
    
    let dwarf = gimli::Dwarf {
        debug_abbrev: gimli::DebugAbbrev::new(debug_abbrev, endian),
        debug_info: gimli::DebugInfo::new(debug_info, endian),
        debug_str: gimli::DebugStr::new(debug_str, endian),
        debug_addr: gimli::DebugAddr::from(EndianSlice::new(&[], endian)),
        debug_aranges: gimli::DebugAranges::new(&[], endian),
        debug_line: gimli::DebugLine::new(&[], endian),
        debug_line_str: gimli::DebugLineStr::new(&[], endian),
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
    
    // Search for the specific type by name
    let mut iter = dwarf.units();
    while let Ok(Some(header)) = iter.next() {
        let unit = dwarf.unit(header).ok()?;
        
        // Note: abbreviations are already loaded in the unit, no need to fetch separately
        let mut entries = unit.entries();
        while let Ok(Some((_, entry))) = entries.next_dfs() {
            if entry.tag() == gimli::DW_TAG_structure_type {
                // Get the name of this struct
                let name: Option<String> = entry.attr_value(gimli::DW_AT_name).ok().flatten()
                    .and_then(|v| {
                        if let gimli::AttributeValue::DebugStrRef(offset) = v {
                            dwarf.debug_str.get_str(offset).ok()
                                .and_then(|s| {
                                    s.to_slice().ok()
                                        .map(|bytes| String::from_utf8_lossy(bytes.as_ref()).into_owned())
                                })
                        } else {
                            None
                        }
                    });
                
                // Check if this is our target type
                if let Some(ref n) = name {
                    if n == type_name || n.ends_with(&format!("::{}", type_name)) {
                        // Found it! Extract layout info
                        return extract_struct_layout_from_dwarf(&dwarf, &unit, entry, n);
                    }
                }
            }
        }
    }
    
    eprintln!(
        "[TypeId] Type '{}' not found in DWARF info for {}",
        type_name, path.display()
    );
    None
}

#[cfg(unix)]
fn extract_struct_layout_from_dwarf<R: gimli::Reader>(
    _dwarf: &gimli::Dwarf<R>,
    _unit: &gimli::Unit<R>,
    entry: &gimli::DebuggingInformationEntry<R>,
    name: &str,
) -> Option<TypeLayoutInfo> {
    use std::collections::hash_map::DefaultHasher;
    
    // Get struct size
    let size = entry.attr_value(gimli::DW_AT_byte_size).ok()??;
    let struct_size = match size {
        gimli::AttributeValue::Udata(s) => s as usize,
        gimli::AttributeValue::Data1(s) => s as usize,
        gimli::AttributeValue::Data2(s) => s as usize,
        gimli::AttributeValue::Data4(s) => s as usize,
        gimli::AttributeValue::Data8(s) => s as usize,
        _ => return None,
    };
    
    // Compute layout hash from type name + size
    // A full implementation would iterate DW_TAG_member children for field offsets
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    struct_size.hash(&mut hasher);
    let layout_hash = hasher.finish();
    
    Some(TypeLayoutInfo {
        type_name: name.to_string(),
        size: struct_size,
        alignment: 8, // Default, would extract from DWARF
        layout_hash,
        fields: vec![], // Would be populated from DW_TAG_member children
    })
}

#[cfg(not(unix))]
pub fn lookup_type_layout_in_dwarf(
    _path: &Path,
    _type_name: &str,
) -> Option<TypeLayoutInfo> {
    None
}

/// Layout info extracted from DWARF
#[derive(Debug, Clone)]
pub struct TypeLayoutInfo {
    pub type_name: String,
    pub size: usize,
    pub alignment: usize,
    pub layout_hash: u64,
    pub fields: Vec<FieldLayoutInfo>,
}

/// Field layout info from DWARF
#[derive(Debug, Clone)]
pub struct FieldLayoutInfo {
    pub name: String,
    pub type_name: String,
    pub offset: usize,
    pub size: usize,
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_state_type_id_hash() {
        let id1 = StateTypeId::new("core::CoreState", "core", 1);
        let id2 = StateTypeId::new("core::CoreState", "core", 1);
        let id3 = StateTypeId::new("core::CoreState", "core", 2);
        
        assert_eq!(id1.compute_hash(), id2.compute_hash());
        assert_ne!(id1.compute_hash(), id3.compute_hash());
    }
    
    #[test]
    fn test_note_payload_roundtrip() {
        let payload = StateNotePayload {
            note_version: 1,
            type_name_hash: 0x123456789ABCDEF0,
            layout_hash: 0xFEDCBA9876543210,
            semantic_hash: 0x1111222233334444,
            state_size: 256,
            state_align: 8,
            type_name_len: 0, // Will be set by to_bytes
        };
        
        let type_name = "test::TestState";
        let bytes = payload.to_bytes(type_name);
        
        let (parsed, parsed_name) = StateNotePayload::from_bytes(&bytes).unwrap();
        
        assert_eq!(parsed.note_version, payload.note_version);
        assert_eq!(parsed.layout_hash, payload.layout_hash);
        assert_eq!(parsed.semantic_hash, payload.semantic_hash);
        assert_eq!(parsed.state_size, payload.state_size);
        assert_eq!(parsed_name, type_name);
    }
    
    #[test]
    fn test_memcpy_safety_check() {
        let info1 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x12345678),
            semantic_hash: Some(0xABCDEF),
            source: TypeInfoSource::ExportedSymbol,
        };
        
        let info2 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x12345678),
            semantic_hash: Some(0xABCDEF),
            source: TypeInfoSource::ExportedSymbol,
        };
        
        assert!(info1.is_memcpy_safe(&info2).is_safe());
        
        // Different layout hash -> not safe
        let info3 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x87654321),
            semantic_hash: Some(0xABCDEF),
            source: TypeInfoSource::ExportedSymbol,
        };
        
        assert!(!info1.is_memcpy_safe(&info3).is_safe());
    }
    
    #[test]
    fn test_reload_safety_check() {
        let info1 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x12345678),
            semantic_hash: Some(0xABCDEF),
            source: TypeInfoSource::ExportedSymbol,
        };
        
        // Same semantic hash -> safe
        let info2 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x12345678),
            semantic_hash: Some(0xABCDEF),
            source: TypeInfoSource::ExportedSymbol,
        };
        
        assert!(info1.is_reload_safe(&info2).is_safe());
        
        // Different semantic hash -> requires migration (even if layout matches)
        let info3 = ExtractedTypeInfo {
            type_id: Some(StateTypeId::new("TestState", "test", 1)),
            layout_hash: Some(0x12345678),
            semantic_hash: Some(0xDEADBEEF), // Different!
            source: TypeInfoSource::ExportedSymbol,
        };
        
        assert!(matches!(
            info1.is_reload_safe(&info3),
            ReloadSafety::RequiresMigration { .. }
        ));
    }
}
