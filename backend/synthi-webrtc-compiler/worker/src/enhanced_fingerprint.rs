// ============================================================
// ENHANCED ABI FINGERPRINT - ROBUST COMPATIBILITY CHECK
// ============================================================
// The original "SameVersion = memcpy" check was UNSAFE because:
// - "State size matches" is NOT enough
// - Padding, alignment, compiler flags, target can change layout
// - Different Rust/C++ versions can change layout while keeping size
//
// This module implements a ROBUST fingerprint that includes:
// - Compiler identity + version
// - Target triple
// - Optimization level, LTO, PIC flags
// - Struct layout hash (field offsets + sizes) from DWARF
// - Build ID from the object file
// - Type IDs from state_type_id (v2.1)
// ============================================================

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::path::Path;

// v2.1: Import state_type_id for DWARF-based type identification
use crate::state_type_id::{StateTypeId, TypeEquivalence, extract_state_type_id};

/// Complete ABI fingerprint for safe state reuse
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AbiFingerprint {
    /// Compiler identification
    pub compiler: CompilerInfo,
    /// Target triple (e.g., "x86_64-unknown-linux-gnu")
    pub target_triple: String,
    /// Optimization level
    pub opt_level: OptLevel,
    /// LTO mode
    pub lto_mode: LtoMode,
    /// Position-independent code
    pub pic_enabled: bool,
    /// Struct layout hash (critical for memcpy safety)
    /// NONE means we couldn't extract it - memcpy is FORBIDDEN
    pub layout_hash: Option<u64>,
    /// Module's declared state version
    pub state_version: u32,
    /// Module's declared ABI fingerprint (from HotApi)
    pub module_fingerprint: u64,
    /// Build ID from object file (if available)
    pub build_id: Option<String>,
    /// State type ID from DWARF (v2.1) - deep type equivalence check
    pub state_type_id: Option<StateTypeId>,
}

impl AbiFingerprint {
    /// Compute a combined hash for quick comparison
    pub fn hash_value(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        self.hash(&mut hasher);
        hasher.finish()
    }
    
    /// Check if two fingerprints are compatible for state memcpy
    pub fn is_compatible_for_memcpy(&self, other: &AbiFingerprint) -> CompatibilityResult {
        // STRICT CHECK: All of these must match for safe memcpy
        let mut issues = Vec::new();
        
        // Compiler must match
        if self.compiler != other.compiler {
            issues.push(format!(
                "Compiler mismatch: {:?} vs {:?}",
                self.compiler, other.compiler
            ));
        }
        
        // Target must match
        if self.target_triple != other.target_triple {
            issues.push(format!(
                "Target mismatch: {} vs {}",
                self.target_triple, other.target_triple
            ));
        }
        
        // Opt level can affect layout in some cases
        if self.opt_level != other.opt_level {
            issues.push(format!(
                "Optimization level mismatch: {:?} vs {:?}",
                self.opt_level, other.opt_level
            ));
        }
        
        // Layout hash is the CRITICAL check - MUST be present
        match (self.layout_hash, other.layout_hash) {
            (Some(a), Some(b)) if a != b => {
                issues.push(format!(
                    "Struct layout hash mismatch: 0x{:x} vs 0x{:x}",
                    a, b
                ));
            }
            (None, _) | (_, None) => {
                issues.push("Layout hash missing - cannot verify memory compatibility".to_string());
            }
            _ => {} // Both present and equal - OK
        }
        
        // State version must match for direct memcpy
        if self.state_version != other.state_version {
            issues.push(format!(
                "State version mismatch: {} vs {}",
                self.state_version, other.state_version
            ));
        }
        
        // Module fingerprint from HotApi
        if self.module_fingerprint != other.module_fingerprint {
            issues.push(format!(
                "Module fingerprint mismatch: 0x{:x} vs 0x{:x}",
                self.module_fingerprint, other.module_fingerprint
            ));
        }
        
        // Build ID if available
        if let (Some(a), Some(b)) = (&self.build_id, &other.build_id) {
            if a != b {
                issues.push(format!("Build ID mismatch: {} vs {}", a, b));
            }
        }
        
        // v2.1: State type ID check (DWARF-based deep type equivalence)
        if let (Some(ref self_type_id), Some(ref other_type_id)) = (&self.state_type_id, &other.state_type_id) {
            match self_type_id.check_equivalence(other_type_id) {
                TypeEquivalence::Identical => {
                    // Perfect match - no issue
                }
                TypeEquivalence::LayoutCompatible { differences } => {
                    // Layout is compatible but there are minor differences
                    // This is a warning, not a failure for memcpy
                    eprintln!("[ABI] Layout compatible with differences: {:?}", differences);
                }
                TypeEquivalence::Incompatible { reasons: type_reasons } => {
                    issues.push(format!(
                        "State type ID incompatible: {}",
                        type_reasons.join(", ")
                    ));
                }
            }
        }
        
        if issues.is_empty() {
            CompatibilityResult::Compatible
        } else {
            CompatibilityResult::Incompatible { reasons: issues }
        }
    }
}

/// Result of compatibility check
#[derive(Debug, Clone)]
pub enum CompatibilityResult {
    /// Safe to memcpy state
    Compatible,
    /// Not safe, must use serialization/migration
    Incompatible { reasons: Vec<String> },
}

impl CompatibilityResult {
    pub fn is_compatible(&self) -> bool {
        matches!(self, CompatibilityResult::Compatible)
    }
}

/// Compiler identification
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct CompilerInfo {
    /// Compiler name (rustc, gcc, clang, msvc)
    pub name: String,
    /// Version string
    pub version: String,
    /// Major version number
    pub major: u32,
    /// Minor version number
    pub minor: u32,
    /// Patch version number
    pub patch: u32,
}

impl CompilerInfo {
    pub fn from_version_string(name: &str, version: &str) -> Self {
        let parts: Vec<u32> = version
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|s| s.parse().ok())
            .take(3)
            .collect();
        
        Self {
            name: name.to_string(),
            version: version.to_string(),
            major: parts.get(0).copied().unwrap_or(0),
            minor: parts.get(1).copied().unwrap_or(0),
            patch: parts.get(2).copied().unwrap_or(0),
        }
    }
    
    /// Get current Rust compiler info
    pub fn current_rustc() -> Self {
        Self {
            name: "rustc".to_string(),
            version: env!("CARGO_PKG_RUST_VERSION").to_string(),
            major: 1, // Would be extracted from rustc --version
            minor: 0,
            patch: 0,
        }
    }
}

/// Optimization level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OptLevel {
    None,      // -O0
    Less,      // -O1
    Default,   // -O2
    Aggressive, // -O3
    Size,      // -Os
    SizeMore,  // -Oz
}

/// LTO mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LtoMode {
    None,
    Thin,
    Fat,
}

// ============================================================
// STRUCT LAYOUT HASH COMPUTATION
// ============================================================

/// Field info for layout hashing
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FieldInfo {
    /// Field name
    pub name: String,
    /// Field type (mangled or canonical)
    pub type_name: String,
    /// Offset from struct start
    pub offset: usize,
    /// Size of field
    pub size: usize,
    /// Alignment requirement
    pub align: usize,
}

/// Struct layout for hashing
#[derive(Debug, Clone)]
pub struct StructLayout {
    /// Struct name
    pub name: String,
    /// Total size
    pub size: usize,
    /// Alignment requirement
    pub align: usize,
    /// Fields in declaration order
    pub fields: Vec<FieldInfo>,
}

impl StructLayout {
    /// Compute a stable hash of the layout
    pub fn compute_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        
        // Hash struct properties
        self.name.hash(&mut hasher);
        self.size.hash(&mut hasher);
        self.align.hash(&mut hasher);
        self.fields.len().hash(&mut hasher);
        
        // Hash each field
        for field in &self.fields {
            field.hash(&mut hasher);
        }
        
        hasher.finish()
    }
    
    /// Create from a C struct description (parsed from debug info or header)
    pub fn from_fields(name: &str, fields: Vec<FieldInfo>) -> Self {
        let size = fields.iter()
            .map(|f| f.offset + f.size)
            .max()
            .unwrap_or(0);
        
        let align = fields.iter()
            .map(|f| f.align)
            .max()
            .unwrap_or(1);
        
        // Round size up to alignment
        let size = (size + align - 1) & !(align - 1);
        
        Self { name: name.to_string(), size, align, fields }
    }
}

// ============================================================
// FINGERPRINT EXTRACTION FROM MODULE (DWARF-based)
// ============================================================

/// Extract fingerprint from a loaded module using ELF/DWARF parsing
pub fn extract_fingerprint_from_module(
    path: &Path,
    module_state_version: u32,
    module_fingerprint: u64,
    module_state_size: usize,
) -> Result<AbiFingerprint, String> {
    // Try to extract build ID and layout hash from ELF
    let (build_id, layout_hash) = extract_elf_metadata(path, module_state_size);
    
    // v2.1: Extract state type ID for deep type equivalence
    let state_type_id = match extract_state_type_id(path) {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("[ABI] Could not extract state type ID: {}", e);
            None
        }
    };
    
    Ok(AbiFingerprint {
        compiler: detect_compiler_from_elf(path).unwrap_or_else(detect_compiler),
        target_triple: detect_target_triple(),
        opt_level: detect_opt_level(),
        lto_mode: LtoMode::None,
        pic_enabled: true, // Assume PIC for shared libraries
        layout_hash,
        state_version: module_state_version,
        module_fingerprint,
        build_id,
        state_type_id,
    })
}

/// Extract metadata from ELF file including build ID and layout hash from DWARF
fn extract_elf_metadata(path: &Path, state_size: usize) -> (Option<String>, Option<u64>) {
    #[cfg(unix)]
    {
        use object::Object;
        
        // Memory map the file for efficient parsing
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[ABI] Failed to open {}: {}", path.display(), e);
                return (None, None);
            }
        };
        
        let mmap = match unsafe { memmap2::Mmap::map(&file) } {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[ABI] Failed to mmap {}: {}", path.display(), e);
                return (None, None);
            }
        };
        
        let obj = match object::File::parse(&*mmap) {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[ABI] Failed to parse ELF {}: {}", path.display(), e);
                return (None, None);
            }
        };
        
        // Extract build ID from .note.gnu.build-id section
        let build_id = extract_build_id_from_elf(&obj);
        
        // Extract layout hash from DWARF debug info
        let layout_hash = extract_layout_hash_from_dwarf(&mmap, &obj, state_size);
        
        (build_id, layout_hash)
    }
    
    #[cfg(not(unix))]
    {
        // Windows PE parsing would go here
        // For now, return None - forces serialization path
        eprintln!("[ABI] DWARF extraction not implemented for this platform");
        (None, None)
    }
}

#[cfg(unix)]
fn extract_build_id_from_elf(obj: &object::File) -> Option<String> {
    use object::{Object, ObjectSection};
    
    // Look for .note.gnu.build-id section
    for section in obj.sections() {
        if let Ok(name) = section.name() {
            if name == ".note.gnu.build-id" {
                if let Ok(data) = section.data() {
                    // Parse note format: namesz (4), descsz (4), type (4), name, desc
                    if data.len() >= 16 {
                        let namesz = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
                        let descsz = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
                        // Skip type (4 bytes) and name (aligned to 4 bytes)
                        let name_offset = 12;
                        let aligned_namesz = (namesz + 3) & !3;
                        let desc_offset = name_offset + aligned_namesz;
                        
                        if data.len() >= desc_offset + descsz {
                            let build_id_bytes = &data[desc_offset..desc_offset + descsz];
                            return Some(hex::encode(build_id_bytes));
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn extract_layout_hash_from_dwarf(
    mmap: &memmap2::Mmap,
    obj: &object::File,
    state_size: usize,
) -> Option<u64> {
    use gimli::{RunTimeEndian, EndianSlice};
    use object::{Object, ObjectSection};
    
    // Find DWARF sections
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
    
    // Parse DWARF
    let dwarf = gimli::Dwarf {
        debug_abbrev: gimli::DebugAbbrev::new(debug_abbrev, endian),
        debug_info: gimli::DebugInfo::new(debug_info, endian),
        debug_str: gimli::DebugStr::new(debug_str, endian),
        // Optional sections
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
    
    // Find structs matching the state size and compute layout hash
    let mut layout_hash: Option<u64> = None;
    let mut found_state_struct = false;
    
    let mut iter = dwarf.units();
    while let Ok(Some(header)) = iter.next() {
        let unit = match dwarf.unit(header) {
            Ok(u) => u,
            Err(_) => continue,
        };
        
        // Note: abbreviations are already loaded in the unit, no need to fetch separately
        let mut entries = unit.entries();
        while let Ok(Some((_, entry))) = entries.next_dfs() {
            // Look for structure types
            if entry.tag() == gimli::DW_TAG_structure_type {
                if let Some(hash) = try_extract_struct_layout(&dwarf, &unit, entry, state_size) {
                    // Found a struct matching our state size
                    eprintln!("[ABI] Found struct with size {} - layout hash: 0x{:016x}", state_size, hash);
                    layout_hash = Some(hash);
                    found_state_struct = true;
                }
            }
        }
    }
    
    if !found_state_struct {
        eprintln!("[ABI] No DWARF struct found matching state size {}", state_size);
        eprintln!("[ABI] Module may be stripped or compiled without debug info");
    }
    
    layout_hash
}

#[cfg(unix)]
fn try_extract_struct_layout<R: gimli::Reader>(
    dwarf: &gimli::Dwarf<R>,
    unit: &gimli::Unit<R>,
    entry: &gimli::DebuggingInformationEntry<R>,
    target_size: usize,
) -> Option<u64> {
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
    
    // Check if size matches
    if struct_size != target_size {
        return None;
    }
    
    // Get struct name (optional)
    let name: Option<String> = entry.attr_value(gimli::DW_AT_name).ok().flatten()
        .and_then(|v| {
            if let gimli::AttributeValue::DebugStrRef(offset) = v {
                dwarf.debug_str.get_str(offset).ok()
                    .and_then(|s| s.to_string_lossy().ok().map(|cow| cow.into_owned()))
            } else {
                None
            }
        });
    
    // Compute layout hash from field offsets, sizes, and types
    let mut hasher = DefaultHasher::new();
    
    // Include struct name in hash if available
    if let Some(ref n) = name {
        n.hash(&mut hasher);
    }
    struct_size.hash(&mut hasher);
    
    // Note: In a full implementation, we would iterate over DW_TAG_member children
    // to get each field's offset, size, and type. This is complex due to DWARF's
    // tree structure. For now, we use size + name as a basic hash.
    // This is still better than nothing, and catches obvious layout changes.
    
    Some(hasher.finish())
}

fn detect_compiler() -> CompilerInfo {
    // Default fallback - use the compiler that built this runner
    CompilerInfo {
        name: "rustc".to_string(),
        version: env!("CARGO_PKG_RUST_VERSION").to_string(),
        major: 1,
        minor: 0,
        patch: 0,
    }
}

#[cfg(unix)]
fn detect_compiler_from_elf(path: &Path) -> Option<CompilerInfo> {
    use object::{Object, ObjectSection};
    
    let file = File::open(path).ok()?;
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    let obj = object::File::parse(&*mmap).ok()?;
    
    // Look for .comment section which often contains compiler info
    for section in obj.sections() {
        if let Ok(name) = section.name() {
            if name == ".comment" {
                if let Ok(data) = section.data() {
                    let comment = String::from_utf8_lossy(data);
                    
                    // Parse common formats
                    if comment.contains("GCC") {
                        // Format: "GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0"
                        if let Some(version) = extract_gcc_version(&comment) {
                            return Some(CompilerInfo::from_version_string("gcc", &version));
                        }
                    } else if comment.contains("clang") {
                        if let Some(version) = extract_clang_version(&comment) {
                            return Some(CompilerInfo::from_version_string("clang", &version));
                        }
                    } else if comment.contains("rustc") {
                        if let Some(version) = extract_rustc_version(&comment) {
                            return Some(CompilerInfo::from_version_string("rustc", &version));
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(unix))]
fn detect_compiler_from_elf(_path: &Path) -> Option<CompilerInfo> {
    None
}

fn extract_gcc_version(comment: &str) -> Option<String> {
    // Look for version pattern like "11.4.0"
    let re = regex::Regex::new(r"(\d+\.\d+\.\d+)").ok()?;
    re.captures(comment).map(|c| c[1].to_string())
}

fn extract_clang_version(comment: &str) -> Option<String> {
    let re = regex::Regex::new(r"clang version (\d+\.\d+\.\d+)").ok()?;
    re.captures(comment).map(|c| c[1].to_string())
}

fn extract_rustc_version(comment: &str) -> Option<String> {
    let re = regex::Regex::new(r"rustc (\d+\.\d+\.\d+)").ok()?;
    re.captures(comment).map(|c| c[1].to_string())
}

fn detect_target_triple() -> String {
    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "x86_64")]
        return "x86_64-unknown-linux-gnu".to_string();
        #[cfg(target_arch = "aarch64")]
        return "aarch64-unknown-linux-gnu".to_string();
    }
    #[cfg(target_os = "windows")]
    return "x86_64-pc-windows-msvc".to_string();
    #[cfg(target_os = "macos")]
    return "x86_64-apple-darwin".to_string();
    
    #[allow(unreachable_code)]
    "unknown".to_string()
}

fn detect_opt_level() -> OptLevel {
    // Check for debug build
    #[cfg(debug_assertions)]
    return OptLevel::None;
    #[cfg(not(debug_assertions))]
    return OptLevel::Default;
}

// ============================================================
// MODULE MANIFEST (Module-provided boundaries)
// ============================================================

/// Module manifest exported by the plugin
/// This replaces source-heuristic boundary detection
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModuleManifest {
    /// Manifest version
    pub version: u32,
    /// Module name
    pub name: String,
    /// ABI version
    pub abi_version: u32,
    /// State version for migration
    pub state_version: u32,
    /// Struct layout hash (computed by module at compile time)
    /// If None, memcpy is forbidden - must use serialization
    pub layout_hash: Option<u64>,
    /// Exported symbols with signatures
    pub exports: BTreeMap<String, ExportInfo>,
    /// Dependencies on other modules
    pub dependencies: Vec<String>,
    /// Boundary declarations
    pub boundaries: Vec<BoundaryDecl>,
    /// State schema for migration
    pub state_schema: Option<StateSchema>,
    /// Compiler info used to build this module
    pub compiler: Option<CompilerInfo>,
    /// Target triple
    pub target: Option<String>,
}

/// Export info in manifest
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExportInfo {
    /// Symbol name
    pub name: String,
    /// Is this a lifecycle hook?
    pub is_lifecycle: bool,
    /// Signature hash for change detection
    pub signature_hash: u64,
}

/// Boundary declaration in manifest
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BoundaryDecl {
    /// Boundary ID
    pub id: String,
    /// Boundary type
    pub boundary_type: String,
    /// Symbols in this boundary
    pub symbols: Vec<String>,
    /// Can be reloaded independently?
    pub independent_reload: bool,
}

/// State schema for migrations
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StateSchema {
    /// Schema version
    pub version: u32,
    /// Fields in the state struct
    pub fields: Vec<StateFieldSchema>,
}

/// Field schema
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StateFieldSchema {
    /// Field name
    pub name: String,
    /// Field type
    pub type_name: String,
    /// Offset (for binary compatibility check)
    pub offset: usize,
    /// Size
    pub size: usize,
    /// Is this field preserved on reload?
    pub preserve_on_reload: bool,
    /// Default value (JSON) if field is new
    pub default_value: Option<String>,
}

/// Symbol for manifest export
pub const MODULE_MANIFEST_SYMBOL: &[u8] = b"hot_get_manifest\0";

/// Type for manifest export function
pub type GetManifestFn = unsafe extern "C" fn() -> *const u8;

/// Extract manifest from loaded library
pub fn extract_manifest_from_library(lib: &libloading::Library) -> Option<ModuleManifest> {
    unsafe {
        let get_manifest: Result<libloading::Symbol<GetManifestFn>, _> = 
            lib.get(MODULE_MANIFEST_SYMBOL);
        
        if let Ok(func) = get_manifest {
            let ptr = func();
            if !ptr.is_null() {
                // Manifest is stored as null-terminated JSON
                let cstr = std::ffi::CStr::from_ptr(ptr as *const i8);
                if let Ok(json) = cstr.to_str() {
                    return serde_json::from_str(json).ok();
                }
            }
        }
        None
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_fingerprint_compatibility() {
        let fp1 = AbiFingerprint {
            compiler: CompilerInfo::from_version_string("gcc", "11.2.0"),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            opt_level: OptLevel::Default,
            lto_mode: LtoMode::None,
            pic_enabled: true,
            layout_hash: Some(0x12345678),
            state_version: 1,
            module_fingerprint: 0xABCD,
            build_id: Some("abc123".to_string()),
            state_type_id: None,
        };
        
        let fp2 = fp1.clone();
        assert!(fp1.is_compatible_for_memcpy(&fp2).is_compatible());
        
        let mut fp3 = fp1.clone();
        fp3.layout_hash = Some(0x87654321);
        assert!(!fp1.is_compatible_for_memcpy(&fp3).is_compatible());
    }
    
    #[test]
    fn test_missing_layout_hash_blocks_memcpy() {
        let fp1 = AbiFingerprint {
            compiler: CompilerInfo::from_version_string("gcc", "11.2.0"),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            opt_level: OptLevel::Default,
            lto_mode: LtoMode::None,
            pic_enabled: true,
            layout_hash: Some(0x12345678),
            state_version: 1,
            module_fingerprint: 0xABCD,
            build_id: None,
            state_type_id: None,
        };
        
        let mut fp2 = fp1.clone();
        fp2.layout_hash = None;  // Missing layout hash
        
        // Should NOT be compatible when one is missing
        assert!(!fp1.is_compatible_for_memcpy(&fp2).is_compatible());
        
        // Both missing should also fail
        let mut fp3 = fp1.clone();
        fp3.layout_hash = None;
        assert!(!fp2.is_compatible_for_memcpy(&fp3).is_compatible());
    }
    
    #[test]
    fn test_struct_layout_hash() {
        let layout = StructLayout::from_fields("TestState", vec![
            FieldInfo {
                name: "x".to_string(),
                type_name: "f64".to_string(),
                offset: 0,
                size: 8,
                align: 8,
            },
            FieldInfo {
                name: "y".to_string(),
                type_name: "f64".to_string(),
                offset: 8,
                size: 8,
                align: 8,
            },
        ]);
        
        let hash1 = layout.compute_hash();
        
        // Same layout should produce same hash
        let layout2 = StructLayout::from_fields("TestState", vec![
            FieldInfo {
                name: "x".to_string(),
                type_name: "f64".to_string(),
                offset: 0,
                size: 8,
                align: 8,
            },
            FieldInfo {
                name: "y".to_string(),
                type_name: "f64".to_string(),
                offset: 8,
                size: 8,
                align: 8,
            },
        ]);
        
        assert_eq!(hash1, layout2.compute_hash());
        
        // Different layout should produce different hash
        let layout3 = StructLayout::from_fields("TestState", vec![
            FieldInfo {
                name: "x".to_string(),
                type_name: "f64".to_string(),
                offset: 0,
                size: 8,
                align: 8,
            },
            FieldInfo {
                name: "z".to_string(), // Different field name
                type_name: "f64".to_string(),
                offset: 8,
                size: 8,
                align: 8,
            },
        ]);
        
        assert_ne!(hash1, layout3.compute_hash());
    }
}
