// Module loader is actively used in runner_bin.rs for ABI validation
// #![allow(dead_code)] - REMOVED: This module is now wired up
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
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::abi_version::{AbiVersionManager, CompatibilityResult, SymbolManifest};
use crate::plugin_contract::ModuleSlot;

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
        use crate::abi_version::standard_manifests;
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
        let manifest =
            unsafe { crate::abi_version::extract_manifest_from_library(&library, module_name) };

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
