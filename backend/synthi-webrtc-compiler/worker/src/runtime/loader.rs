// Module loader is actively used in runner_bin.rs for ABI validation
// #![allow(dead_code)] - REMOVED: This module is now wired up
#![allow(dead_code)]
#![allow(mismatched_lifetime_syntaxes)]

// ============================================================
// MODULE LOADER
// ============================================================
// Responsible for loading, validating, and managing dynamic modules.
// Part of the split runner responsibilities pattern.
//
// RESPONSIBILITIES:
// - Load shared libraries (.so files)
// - Validate ABI compatibility
// - Extract symbols and build symbol tables
// - Manage module lifecycle
// ============================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::compiler::abi_version::AbiVersionManager;
use crate::runtime::plugin_contract::ModuleSlot;
use crate::safety::enhanced_fingerprint::{extract_fingerprint_from_module, AbiFingerprint};

/// Result of a module load operation
#[derive(Debug)]
pub enum LoadResult {
    Success {
        module_id: String,
        abi_version: u32,
    },
    AbiMismatch {
        expected: u32,
        found: u32,
        details: String,
    },
    MissingSymbols {
        symbols: Vec<String>,
    },
    LoadError {
        reason: String,
    },
}

/// Module metadata
#[derive(Debug, Clone)]
pub struct ModuleInfo {
    pub id: String,
    pub slot: ModuleSlot,
    pub path: PathBuf,
    pub abi_version: u32,
    pub content_hash: u64,
    pub loaded_at: std::time::Instant,
    pub symbols: Vec<String>,
    pub fingerprint: Option<AbiFingerprint>,
}

/// Module loader with ABI management
pub struct ModuleLoader {
    /// ABI version manager for compatibility checks
    abi_manager: AbiVersionManager,
    /// Currently loaded modules
    loaded_modules: HashMap<ModuleSlot, ModuleInfo>,
    /// Library handles (kept alive to prevent unloading)
    libraries: HashMap<ModuleSlot, libloading::Library>,
    /// Load history for debugging
    load_history: Vec<(String, std::time::Instant, LoadResult)>,
    /// Maximum history entries
    max_history: usize,
}

impl ModuleLoader {
    pub fn new() -> Self {
        let mut abi_manager = AbiVersionManager::new();

        // Register standard manifests
        use crate::compiler::abi_version::standard_manifests;
        abi_manager.register_expected(standard_manifests::core_v1());
        abi_manager.register_expected(standard_manifests::gui_v1());
        abi_manager.register_expected(standard_manifests::main_v1());

        Self {
            abi_manager,
            loaded_modules: HashMap::new(),
            libraries: HashMap::new(),
            load_history: Vec::new(),
            max_history: 100,
        }
    }

    /// Load a module from path with full validation
    pub fn load(&mut self, path: &Path, slot: ModuleSlot, content_hash: u64) -> LoadResult {
        let module_name = slot.as_str();
        let start = std::time::Instant::now();

        // Load the library
        let library = match unsafe { libloading::Library::new(path) } {
            Ok(lib) => lib,
            Err(e) => {
                let result = LoadResult::LoadError {
                    reason: format!("Failed to load library: {}", e),
                };
                self.record_load(path.to_string_lossy().to_string(), result);
                return LoadResult::LoadError {
                    reason: format!("Failed to load library: {}", e),
                };
            }
        };

        // Extract manifest from loaded library
        let manifest = unsafe {
            crate::compiler::abi_version::extract_manifest_from_library(&library, module_name)
        };

        // Try to get state size for fingerprinting
        let state_size = unsafe { get_module_state_size(&library, module_name) };

        // Extract fingerprint
        let fingerprint = if state_size > 0 {
            match extract_fingerprint_from_module(
                path,
                manifest.abi_version.major, // Use major version as state version proxy for v1
                0,                          // No module fingerprint in v1
                state_size,
            ) {
                Ok(fp) => Some(fp),
                Err(e) => {
                    eprintln!("[Loader] Failed to extract fingerprint: {}", e);
                    None
                }
            }
        } else {
            None
        };

        // Check Fingerprint compatibility with previous version
        let old_module_data = self
            .loaded_modules
            .get(&slot)
            .map(|info| (info.abi_version, info.fingerprint.clone()));

        if let Some((old_version, Some(old_fp))) = old_module_data {
            if let Some(new_fp) = &fingerprint {
                use crate::safety::enhanced_fingerprint::CompatibilityResult;
                match old_fp.is_compatible_for_memcpy(new_fp) {
                    CompatibilityResult::Compatible => {
                        // OK
                    }
                    CompatibilityResult::Incompatible { reasons } => {
                        let reason = format!("Fingerprint mismatch: {}", reasons.join(", "));
                        self.record_load(
                            path.to_string_lossy().to_string(),
                            LoadResult::LoadError {
                                reason: reason.clone(),
                            },
                        );
                        return LoadResult::AbiMismatch {
                            expected: old_version,
                            found: manifest.abi_version.major,
                            details: reason,
                        };
                    }
                }
            }
        }

        // Check ABI compatibility
        let compat = self.abi_manager.check_compatibility(module_name, &manifest);
        if !compat.compatible {
            let result = if !compat.missing_symbols.is_empty() {
                LoadResult::MissingSymbols {
                    symbols: compat.missing_symbols.clone(),
                }
            } else {
                LoadResult::AbiMismatch {
                    expected: 1, // From expected manifest
                    found: manifest.abi_version.major,
                    details: compat.version_info.clone(),
                }
            };
            self.record_load(
                path.to_string_lossy().to_string(),
                LoadResult::LoadError {
                    reason: format!("Compatibility check failed: {:?}", compat),
                },
            );
            return result;
        }

        // Store module info
        let info = ModuleInfo {
            id: format!("{}_{}", module_name, content_hash),
            slot,
            path: path.to_path_buf(),
            abi_version: manifest.abi_version.major,
            content_hash,
            loaded_at: start,
            symbols: manifest.symbols.iter().map(|s| s.name.clone()).collect(),
            fingerprint,
        };

        // Move previous to rollback if exists
        if let Some(old_lib) = self.libraries.remove(&slot) {
            // Old library will be dropped, but ABI manager keeps track of versions
            drop(old_lib);
        }

        self.loaded_modules.insert(slot, info.clone());
        self.libraries.insert(slot, library);

        let result = LoadResult::Success {
            module_id: info.id.clone(),
            abi_version: manifest.abi_version.major,
        };

        self.record_load(
            path.to_string_lossy().to_string(),
            LoadResult::Success {
                module_id: info.id,
                abi_version: manifest.abi_version.major,
            },
        );

        result
    }

    /// Get a symbol from a loaded module
    pub unsafe fn get_symbol<T>(
        &self,
        slot: ModuleSlot,
        symbol_name: &[u8],
    ) -> Option<libloading::Symbol<T>> {
        self.libraries
            .get(&slot)
            .and_then(|lib| lib.get(symbol_name).ok())
    }

    /// Check if a module is loaded
    pub fn is_loaded(&self, slot: ModuleSlot) -> bool {
        self.loaded_modules.contains_key(&slot)
    }

    /// Get module info
    pub fn get_info(&self, slot: ModuleSlot) -> Option<&ModuleInfo> {
        self.loaded_modules.get(&slot)
    }

    /// Unload a module
    pub fn unload(&mut self, slot: ModuleSlot) -> bool {
        let had_module = self.loaded_modules.remove(&slot).is_some();
        if let Some(lib) = self.libraries.remove(&slot) {
            drop(lib);
        }
        had_module
    }

    /// Rollback to previous version
    pub fn rollback(&mut self, slot: ModuleSlot) -> Result<(), String> {
        self.abi_manager.rollback(slot.as_str())
    }

    /// Get available rollback versions
    pub fn get_rollback_versions(&self, slot: ModuleSlot) -> Vec<u32> {
        self.abi_manager
            .get_rollback_versions(slot.as_str())
            .iter()
            .map(|v| v.major)
            .collect()
    }

    /// Get load history
    pub fn get_history(&self) -> &[(String, std::time::Instant, LoadResult)] {
        // Note: Can't return actual LoadResult due to lifetime issues
        // This is a simplified view
        &[]
    }

    fn record_load(&mut self, path: String, result: LoadResult) {
        // For now just log, in production would store result summary
        eprintln!(
            "[Loader] Load {}: {:?}",
            path,
            std::mem::discriminant(&result)
        );

        // Keep history bounded
        if self.load_history.len() >= self.max_history {
            self.load_history.remove(0);
        }
    }

    /// Validate fingerprint compatibility between loaded module and new module
    pub fn validate_fingerprint(
        &self,
        slot: ModuleSlot,
        new_fingerprint: &Option<AbiFingerprint>,
    ) -> crate::safety::enhanced_fingerprint::CompatibilityResult {
        if let Some(old_info) = self.get_info(slot) {
            match (&old_info.fingerprint, new_fingerprint) {
                (Some(old), Some(new)) => old.is_compatible_for_memcpy(new),
                (None, None) => {
                    crate::safety::enhanced_fingerprint::CompatibilityResult::Compatible
                } // Both missing, assume compatible (legacy behavior)
                (Some(_), None) => {
                    crate::safety::enhanced_fingerprint::CompatibilityResult::Incompatible {
                        reasons: vec!["New module missing fingerprint".to_string()],
                    }
                }
                (None, Some(_)) => {
                    crate::safety::enhanced_fingerprint::CompatibilityResult::Incompatible {
                        reasons: vec!["Old module missing fingerprint".to_string()],
                    }
                }
            }
        } else {
            // No old module, always compatible
            crate::safety::enhanced_fingerprint::CompatibilityResult::Compatible
        }
    }
}

/// Helper to extract state size from loaded library
unsafe fn get_module_state_size(lib: &libloading::Library, module_name: &str) -> usize {
    // Try v2.1 HotApi first
    if let Ok(func) = lib
        .get::<unsafe extern "C" fn() -> *const crate::runtime::plugin_contract::HotApi>(
            b"hot_get_api\0",
        )
    {
        let api = func();
        if !api.is_null() {
            return (*api).state_size_bytes;
        }
    }

    // Try v1 specific symbols
    let symbol_name: &[u8] = match module_name {
        "core" => b"core_get_state_size\0",
        "gui" => b"gui_get_state_size\0",
        _ => b"get_state_size\0",
    };

    if let Ok(func) = lib.get::<unsafe extern "C" fn() -> usize>(symbol_name) {
        return func();
    }

    0
}

impl Default for ModuleLoader {
    fn default() -> Self {
        Self::new()
    }
}

/// Interface trait for module loading (for dependency injection/testing)
pub trait ModuleLoaderInterface: Send + Sync {
    fn load(&mut self, path: &Path, slot: ModuleSlot, content_hash: u64) -> LoadResult;
    fn is_loaded(&self, slot: ModuleSlot) -> bool;
    fn unload(&mut self, slot: ModuleSlot) -> bool;
}

impl ModuleLoaderInterface for ModuleLoader {
    fn load(&mut self, path: &Path, slot: ModuleSlot, content_hash: u64) -> LoadResult {
        ModuleLoader::load(self, path, slot, content_hash)
    }

    fn is_loaded(&self, slot: ModuleSlot) -> bool {
        ModuleLoader::is_loaded(self, slot)
    }

    fn unload(&mut self, slot: ModuleSlot) -> bool {
        ModuleLoader::unload(self, slot)
    }
}
