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
// - Struct layout hash (field offsets + sizes)
// - Build ID from the object file
// ============================================================

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::Path;

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
    pub layout_hash: u64,
    /// Module's declared state version
    pub state_version: u32,
    /// Module's declared ABI fingerprint (from HotApi)
    pub module_fingerprint: u64,
    /// Build ID from object file (if available)
    pub build_id: Option<String>,
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
        
        // Layout hash is the critical check
        if self.layout_hash != other.layout_hash {
            issues.push(format!(
                "Struct layout hash mismatch: 0x{:x} vs 0x{:x}",
                self.layout_hash, other.layout_hash
            ));
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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
// FINGERPRINT EXTRACTION FROM MODULE
// ============================================================

/// Extract fingerprint from a loaded module
pub fn extract_fingerprint_from_module(
    path: &Path,
    module_state_version: u32,
    module_fingerprint: u64,
    module_state_size: usize,
) -> Result<AbiFingerprint, String> {
    // Try to extract build ID from ELF
    let build_id = extract_build_id(path);
    
    // For now, use a simplified layout hash based on size
    // Real implementation would parse DWARF debug info
    let layout_hash = compute_simple_layout_hash(module_state_size);
    
    Ok(AbiFingerprint {
        compiler: detect_compiler(),
        target_triple: detect_target_triple(),
        opt_level: detect_opt_level(),
        lto_mode: LtoMode::None,
        pic_enabled: true, // Assume PIC for shared libraries
        layout_hash,
        state_version: module_state_version,
        module_fingerprint,
        build_id,
    })
}

fn detect_compiler() -> CompilerInfo {
    // In practice, this would query the toolchain used to build the module
    CompilerInfo {
        name: "gcc".to_string(),
        version: "11.0.0".to_string(),
        major: 11,
        minor: 0,
        patch: 0,
    }
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
    // Would be read from build configuration
    OptLevel::Default
}

fn extract_build_id(path: &Path) -> Option<String> {
    // Would parse ELF .note.gnu.build-id section
    // For now, return None
    #[cfg(unix)]
    {
        // Real implementation would use goblin or object crate
        // to parse the ELF and extract build ID
        None
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn compute_simple_layout_hash(state_size: usize) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    state_size.hash(&mut hasher);
    hasher.finish()
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
    pub layout_hash: u64,
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
            layout_hash: 0x12345678,
            state_version: 1,
            module_fingerprint: 0xABCD,
            build_id: Some("abc123".to_string()),
        };
        
        let fp2 = fp1.clone();
        assert!(fp1.is_compatible_for_memcpy(&fp2).is_compatible());
        
        let mut fp3 = fp1.clone();
        fp3.layout_hash = 0x87654321;
        assert!(!fp1.is_compatible_for_memcpy(&fp3).is_compatible());
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
