// ============================================================
// DYNAMIC LIBRARY ADAPTER
// ============================================================
// Implements the Adapter trait for the DynamicLibrary family
// (C, C++, Rust, Zig).  Uses dlopen/dlclose for in-process
// warm swap of compiled shared objects.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::hmr::slot_manager::LibSlot;
use crate::hmr::symbol_validation::SymbolValidationResult;

/// Configuration for the dynlib adapter.
#[derive(Debug, Clone)]
pub struct DynLibAdapterConfig {
    /// Languages this instance handles.
    pub languages: Vec<String>,
    /// Maximum artifact size allowed (bytes).
    pub max_artifact_bytes: u64,
    /// Whether to validate ABI symbols before swap.
    pub validate_symbols: bool,
    /// Healthcheck: number of ticks to wait after reload.
    pub healthcheck_ticks: u32,
}

impl Default for DynLibAdapterConfig {
    fn default() -> Self {
        Self {
            languages: vec!["c".into(), "cpp".into(), "rust".into(), "zig".into()],
            max_artifact_bytes: 256 * 1024 * 1024, // 256 MB
            validate_symbols: true,
            healthcheck_ticks: 2,
        }
    }
}

/// Internal state of the dynlib adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DynLibPhase {
    Uninitialized,
    Ready,
    Swapping,
    Faulted,
    ShutDown,
}

/// The dynamic library adapter.
pub struct DynLibAdapter {
    config: DynLibAdapterConfig,
    phase: DynLibPhase,
    /// Current active slot.
    active_slot: Option<LibSlot>,
    /// Path of the currently loaded artifact.
    active_artifact: Option<String>,
    /// Expected symbol set for ABI validation.
    expected_symbols: Option<SymbolValidationResult>,
    /// Snapshot of the last exported state.
    last_snapshot: Option<Vec<u8>>,
    /// Health after last reload.
    health: AdapterHealth,
    /// Reload counter.
    reload_count: u64,
}

impl DynLibAdapter {
    pub fn new(config: DynLibAdapterConfig) -> Self {
        Self {
            config,
            phase: DynLibPhase::Uninitialized,
            active_slot: None,
            active_artifact: None,
            expected_symbols: None,
            last_snapshot: None,
            health: AdapterHealth::Unknown,
            reload_count: 0,
        }
    }

    /// Set the expected symbols for ABI validation.
    pub fn set_expected_symbols(&mut self, symbols: SymbolValidationResult) {
        self.expected_symbols = Some(symbols);
    }

    /// Get the phase for debugging.
    pub fn phase(&self) -> &str {
        match self.phase {
            DynLibPhase::Uninitialized => "uninitialized",
            DynLibPhase::Ready => "ready",
            DynLibPhase::Swapping => "swapping",
            DynLibPhase::Faulted => "faulted",
            DynLibPhase::ShutDown => "shutdown",
        }
    }

    /// Validate that the artifact has the required symbols.
    fn validate_artifact(&self, artifact_path: &str) -> Result<(), String> {
        if !self.config.validate_symbols {
            return Ok(());
        }
        // In production this would dlopen and check symbols.
        // Here we validate the path is non-empty and looks like a lib.
        if artifact_path.is_empty() {
            return Err("empty artifact path".into());
        }
        let valid_exts = [".so", ".dylib", ".dll"];
        if !valid_exts.iter().any(|ext| artifact_path.ends_with(ext)) {
            return Err(format!(
                "artifact '{}' does not look like a shared library",
                artifact_path
            ));
        }
        Ok(())
    }

    /// Internal swap logic (placeholder for actual dlopen).
    fn perform_swap(&mut self, artifact_path: &str) -> Result<u64, String> {
        self.phase = DynLibPhase::Swapping;

        // Validate
        self.validate_artifact(artifact_path)?;

        // Swap slots: toggle primary/standby
        let new_slot = match self.active_slot {
            Some(LibSlot::Primary) => LibSlot::Standby,
            _ => LibSlot::Primary,
        };

        // Record swap
        self.active_slot = Some(new_slot);
        self.active_artifact = Some(artifact_path.to_string());
        self.reload_count += 1;
        self.phase = DynLibPhase::Ready;
        self.health = AdapterHealth::Healthy;

        // Return simulated swap time
        Ok(15) // ~15ms for dlopen/dlclose cycle
    }
}

impl Adapter for DynLibAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            name: "dynlib".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier3,
            supported_languages: self.config.languages.clone(),
            extra: {
                let mut m = HashMap::new();
                m.insert("reload_count".into(), self.reload_count.to_string());
                m.insert("phase".into(), self.phase().into());
                m
            },
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        if self.phase != DynLibPhase::Uninitialized {
            return Err(format!("cannot initialize from phase {:?}", self.phase));
        }
        self.phase = DynLibPhase::Ready;
        self.active_slot = Some(LibSlot::Primary);
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        self.phase = DynLibPhase::ShutDown;
        self.active_slot = None;
        self.active_artifact = None;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult {
        if self.phase != DynLibPhase::Ready {
            return AdapterReloadResult::Failed {
                error: format!("adapter not ready (phase: {:?})", self.phase),
                recoverable: false,
            };
        }

        // Extract artifact path from build manifest
        let artifact = &req.build_manifest.artifact_path;
        if artifact.is_empty() {
            return AdapterReloadResult::Failed {
                error: "no artifact_path in build manifest".into(),
                recoverable: true,
            };
        }

        match self.perform_swap(artifact) {
            Ok(ms) => AdapterReloadResult::Success {
                reload_ms: ms,
                state_preserved: req.preserve_state && self.last_snapshot.is_some(),
            },
            Err(e) => {
                self.phase = DynLibPhase::Faulted;
                self.health = AdapterHealth::Faulted;
                AdapterReloadResult::Failed {
                    error: e,
                    recoverable: true,
                }
            }
        }
    }

    fn snapshot_state(&self) -> Result<Vec<u8>, String> {
        // In production: call hmr_get_state_json() through the loaded library
        self.last_snapshot.clone().ok_or_else(|| "no state to snapshot".into())
    }

    fn restore_state(&mut self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Err("empty state data".into());
        }
        self.last_snapshot = Some(data.to_vec());
        Ok(())
    }

    fn healthcheck(&self) -> AdapterHealth {
        self.health
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot};

    fn test_manifest(artifact: &str) -> BuildManifest {
        BuildManifest::new("test", "cpp", "DynamicLibrary", 3, BuildSlot::Full, artifact, "abc123")
    }

    #[test]
    fn lifecycle() {
        let mut adapter = DynLibAdapter::new(DynLibAdapterConfig::default());
        assert!(adapter.initialize().is_ok());
        assert_eq!(adapter.phase(), "ready");

        let req = AdapterReloadRequest {
            reload_id: "r-1".into(),
            module_id: "mod_a".into(),
            changed_files: vec!["src/main.c".into()],
            build_manifest: test_manifest("libmod_a.so"),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Success { .. }));

        assert!(adapter.shutdown().is_ok());
        assert_eq!(adapter.phase(), "shutdown");
    }

    #[test]
    fn rejects_bad_artifact() {
        let mut adapter = DynLibAdapter::new(DynLibAdapterConfig::default());
        adapter.initialize().unwrap();

        let req = AdapterReloadRequest {
            reload_id: "r-2".into(),
            module_id: "mod_a".into(),
            changed_files: vec![],
            build_manifest: test_manifest("not_a_lib.txt"),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Failed { .. }));
    }
}
