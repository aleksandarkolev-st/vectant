// ============================================================
// ABI VERSIONING AND COMPATIBILITY
// ============================================================
// Versions every exported symbol set and provides compatibility
// checking before dlopen. Keeps last two ABI versions for rollback.
//
// KEY FEATURES:
// - Symbol set versioning with semantic versioning
// - Compatibility check before loading modules
// - Rollback support to previous ABI versions
// - Symbol manifest generation and validation
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Semantic version for ABI
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AbiVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl AbiVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Check if this version is compatible with required version
    /// Compatible if major matches and minor >= required minor
    pub fn is_compatible_with(&self, required: &AbiVersion) -> bool {
        self.major == required.major && self.minor >= required.minor
    }

    /// Check if this is a breaking change from previous version
    pub fn is_breaking_from(&self, previous: &AbiVersion) -> bool {
        self.major != previous.major
    }

    /// Parse from string like "1.2.3"
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some(Self {
            major: parts[0].parse().ok()?,
            minor: parts[1].parse().ok()?,
            patch: parts[2].parse().ok()?,
        })
    }
}

impl std::fmt::Display for AbiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Default for AbiVersion {
    fn default() -> Self {
        Self::new(1, 0, 0)
    }
}

/// Symbol information including type signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolInfo {
    pub name: String,
    pub signature: String,
    pub is_optional: bool,
    pub added_in: AbiVersion,
    pub deprecated_in: Option<AbiVersion>,
}

impl SymbolInfo {
    pub fn required(name: impl Into<String>, signature: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            signature: signature.into(),
            is_optional: false,
            added_in: AbiVersion::default(),
            deprecated_in: None,
        }
    }

    pub fn optional(name: impl Into<String>, signature: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            signature: signature.into(),
            is_optional: true,
            added_in: AbiVersion::default(),
            deprecated_in: None,
        }
    }
}

/// Symbol manifest for a module
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolManifest {
    pub module_name: String,
    pub abi_version: AbiVersion,
    pub symbols: Vec<SymbolInfo>,
    pub created_at: u64,
    pub content_hash: String,
}

impl SymbolManifest {
    pub fn new(module_name: impl Into<String>, version: AbiVersion) -> Self {
        Self {
            module_name: module_name.into(),
            abi_version: version,
            symbols: Vec::new(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            content_hash: String::new(),
        }
    }

    pub fn with_symbol(mut self, symbol: SymbolInfo) -> Self {
        self.symbols.push(symbol);
        self
    }

    pub fn required_symbols(&self) -> Vec<&SymbolInfo> {
        self.symbols.iter().filter(|s| !s.is_optional).collect()
    }

    pub fn symbol_names(&self) -> HashSet<String> {
        self.symbols.iter().map(|s| s.name.clone()).collect()
    }
}

/// Result of compatibility check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityResult {
    pub compatible: bool,
    pub missing_symbols: Vec<String>,
    pub signature_mismatches: Vec<(String, String, String)>, // (name, expected, actual)
    pub deprecated_symbols: Vec<String>,
    pub version_info: String,
}

impl CompatibilityResult {
    pub fn ok() -> Self {
        Self {
            compatible: true,
            missing_symbols: Vec::new(),
            signature_mismatches: Vec::new(),
            deprecated_symbols: Vec::new(),
            version_info: String::new(),
        }
    }

    pub fn incompatible(reason: impl Into<String>) -> Self {
        Self {
            compatible: false,
            missing_symbols: Vec::new(),
            signature_mismatches: Vec::new(),
            deprecated_symbols: Vec::new(),
            version_info: reason.into(),
        }
    }
}

/// Loaded module with ABI information
pub struct LoadedModule {
    pub path: PathBuf,
    pub manifest: SymbolManifest,
    pub library: Option<libloading::Library>,
    pub loaded_at: std::time::Instant,
}

/// ABI version manager with rollback support
pub struct AbiVersionManager {
    /// Current loaded versions per module
    current_versions: HashMap<String, LoadedModule>,
    /// Previous versions for rollback (last 2)
    previous_versions: HashMap<String, Vec<LoadedModule>>,
    /// Expected manifests for compatibility checking
    expected_manifests: HashMap<String, SymbolManifest>,
    /// Maximum previous versions to keep
    max_rollback_versions: usize,
}

impl AbiVersionManager {
    pub fn new() -> Self {
        Self {
            current_versions: HashMap::new(),
            previous_versions: HashMap::new(),
            expected_manifests: HashMap::new(),
            max_rollback_versions: 2,
        }
    }

    /// Register expected symbol manifest for a module
    pub fn register_expected(&mut self, manifest: SymbolManifest) {
        self.expected_manifests
            .insert(manifest.module_name.clone(), manifest);
    }

    /// Check compatibility before loading a module
    pub fn check_compatibility(
        &self,
        module_name: &str,
        candidate_manifest: &SymbolManifest,
    ) -> CompatibilityResult {
        let Some(expected) = self.expected_manifests.get(module_name) else {
            // No expected manifest, accept any version
            return CompatibilityResult::ok();
        };

        // Check version compatibility
        if !candidate_manifest
            .abi_version
            .is_compatible_with(&expected.abi_version)
        {
            return CompatibilityResult::incompatible(format!(
                "ABI version {} is not compatible with required {}",
                candidate_manifest.abi_version, expected.abi_version
            ));
        }

        let mut result = CompatibilityResult::ok();
        result.version_info = format!(
            "Module {} v{} (expected v{})",
            module_name, candidate_manifest.abi_version, expected.abi_version
        );

        // Check for missing required symbols
        let candidate_symbols = candidate_manifest.symbol_names();
        for expected_sym in expected.required_symbols() {
            if !candidate_symbols.contains(&expected_sym.name) {
                result.missing_symbols.push(expected_sym.name.clone());
                result.compatible = false;
            }
        }

        // Check for deprecated symbols
        for sym in &candidate_manifest.symbols {
            if let Some(deprecated_in) = &sym.deprecated_in {
                if candidate_manifest.abi_version.minor >= deprecated_in.minor {
                    result.deprecated_symbols.push(sym.name.clone());
                }
            }
        }

        result
    }

    /// Load a module after compatibility check
    pub fn load_module(
        &mut self,
        path: &Path,
        manifest: SymbolManifest,
    ) -> Result<(), String> {
        let module_name = manifest.module_name.clone();

        // Move current to previous
        if let Some(current) = self.current_versions.remove(&module_name) {
            let prev = self
                .previous_versions
                .entry(module_name.clone())
                .or_insert_with(Vec::new);

            prev.insert(0, current);

            // Keep only last N versions
            while prev.len() > self.max_rollback_versions {
                prev.pop();
            }
        }

        // Load new module
        let library = unsafe {
            libloading::Library::new(path).map_err(|e| format!("Failed to load library: {}", e))?
        };

        let loaded = LoadedModule {
            path: path.to_path_buf(),
            manifest,
            library: Some(library),
            loaded_at: std::time::Instant::now(),
        };

        self.current_versions.insert(module_name, loaded);
        Ok(())
    }

    /// Rollback to previous version
    pub fn rollback(&mut self, module_name: &str) -> Result<(), String> {
        let prev = self
            .previous_versions
            .get_mut(module_name)
            .ok_or_else(|| format!("No previous version for {}", module_name))?;

        if prev.is_empty() {
            return Err(format!("No rollback versions available for {}", module_name));
        }

        let previous = prev.remove(0);

        // Swap current with previous
        if let Some(current) = self.current_versions.remove(module_name) {
            prev.insert(0, current);
        }

        self.current_versions.insert(module_name.to_string(), previous);
        Ok(())
    }

    /// Get current module info
    pub fn get_current(&self, module_name: &str) -> Option<&LoadedModule> {
        self.current_versions.get(module_name)
    }

    /// Get available rollback versions
    pub fn get_rollback_versions(&self, module_name: &str) -> Vec<AbiVersion> {
        self.previous_versions
            .get(module_name)
            .map(|v| v.iter().map(|m| m.manifest.abi_version).collect())
            .unwrap_or_default()
    }

    /// Get symbol from current module
    pub unsafe fn get_symbol<T>(
        &self,
        module_name: &str,
        symbol_name: &[u8],
    ) -> Result<libloading::Symbol<T>, String> {
        let module = self
            .current_versions
            .get(module_name)
            .ok_or_else(|| format!("Module {} not loaded", module_name))?;

        let lib = module
            .library
            .as_ref()
            .ok_or_else(|| format!("Module {} library not available", module_name))?;

        lib.get(symbol_name)
            .map_err(|e| format!("Symbol not found: {}", e))
    }
}

impl Default for AbiVersionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Standard symbol manifests for Synthi modules
pub mod standard_manifests {
    use super::*;

    /// Core module v1 manifest
    pub fn core_v1() -> SymbolManifest {
        SymbolManifest::new("core", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "core_on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required(
                "core_on_update",
                "fn(*mut c_void, f64)",
            ))
            .with_symbol(SymbolInfo::required("core_get_api", "fn() -> *mut c_void"))
            .with_symbol(SymbolInfo::optional(
                "core_on_event",
                "fn(*mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional("core_on_unload", "fn(*mut c_void)"))
            .with_symbol(SymbolInfo::optional(
                "core_get_abi_version",
                "fn() -> u32",
            ))
            .with_symbol(SymbolInfo::optional(
                "core_on_save_state",
                "fn(*mut c_void) -> *mut c_char",
            ))
            .with_symbol(SymbolInfo::optional(
                "core_on_load_from_json",
                "fn(*const c_char) -> *mut c_void",
            ))
    }

    /// GUI module v1 manifest
    pub fn gui_v1() -> SymbolManifest {
        SymbolManifest::new("gui", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "gui_on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required(
                "gui_on_render",
                "fn(*mut c_void, *mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional(
                "gui_on_event",
                "fn(*mut c_void, *mut c_void, *mut c_void) -> i32",
            ))
            .with_symbol(SymbolInfo::optional("gui_on_unload", "fn(*mut c_void)"))
            .with_symbol(SymbolInfo::optional("gui_get_abi_version", "fn() -> u32"))
    }

    /// Main module v1 manifest (legacy single-file mode)
    pub fn main_v1() -> SymbolManifest {
        SymbolManifest::new("main", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required("on_update", "fn(*mut c_void, f64)"))
            .with_symbol(SymbolInfo::optional(
                "on_event",
                "fn(*mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional("on_unload", "fn(*mut c_void)"))
    }
}

/// Extract symbol manifest from a loaded library
pub unsafe fn extract_manifest_from_library(
    lib: &libloading::Library,
    module_name: &str,
) -> SymbolManifest {
    let mut manifest = SymbolManifest::new(module_name, AbiVersion::default());

    // Try to get ABI version
    let version_symbol = match module_name {
        "core" => b"core_get_abi_version\0",
        "gui" => b"gui_get_abi_version\0",
        _ => b"get_abi_version\0",
    };

    if let Ok(func) = lib.get::<unsafe extern "C" fn() -> u32>(version_symbol) {
        let version = func();
        manifest.abi_version = AbiVersion::new(version, 0, 0);
    }

    // Check for standard symbols
    let symbols_to_check: &[(&[u8], &str, bool)] = match module_name {
        "core" => &[
            (b"core_on_load\0", "core_on_load", false),
            (b"core_on_update\0", "core_on_update", false),
            (b"core_get_api\0", "core_get_api", false),
            (b"core_on_event\0", "core_on_event", true),
            (b"core_on_unload\0", "core_on_unload", true),
        ],
        "gui" => &[
            (b"gui_on_load\0", "gui_on_load", false),
            (b"gui_on_render\0", "gui_on_render", false),
            (b"gui_on_event\0", "gui_on_event", true),
            (b"gui_on_unload\0", "gui_on_unload", true),
        ],
        _ => &[
            (b"on_load\0", "on_load", false),
            (b"on_update\0", "on_update", false),
            (b"on_event\0", "on_event", true),
            (b"on_unload\0", "on_unload", true),
        ],
    };

    for (symbol_bytes, name, is_optional) in symbols_to_check {
        if lib.get::<*const ()>(*symbol_bytes).is_ok() {
            manifest.symbols.push(SymbolInfo {
                name: name.to_string(),
                signature: String::new(), // Would need debug info for actual signature
                is_optional: *is_optional,
                added_in: AbiVersion::default(),
                deprecated_in: None,
            });
        }
    }

    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abi_version_compatibility() {
        let v1_0_0 = AbiVersion::new(1, 0, 0);
        let v1_1_0 = AbiVersion::new(1, 1, 0);
        let v2_0_0 = AbiVersion::new(2, 0, 0);

        assert!(v1_1_0.is_compatible_with(&v1_0_0));
        assert!(!v1_0_0.is_compatible_with(&v1_1_0));
        assert!(!v2_0_0.is_compatible_with(&v1_0_0));
    }

    #[test]
    fn test_compatibility_check() {
        let mut manager = AbiVersionManager::new();

        let expected = SymbolManifest::new("test", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required("func1", "fn()"));

        manager.register_expected(expected);

        let candidate = SymbolManifest::new("test", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required("func1", "fn()"));

        let result = manager.check_compatibility("test", &candidate);
        assert!(result.compatible);

        let missing = SymbolManifest::new("test", AbiVersion::new(1, 0, 0));
        let result = manager.check_compatibility("test", &missing);
        assert!(!result.compatible);
        assert!(result.missing_symbols.contains(&"func1".to_string()));
    }
}
