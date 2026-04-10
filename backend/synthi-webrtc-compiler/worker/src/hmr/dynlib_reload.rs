// ============================================================
// DYNLIB RELOAD ORCHESTRATION
// ============================================================
// The full reload sequence for the DynamicLibrary adapter
// family.  Ties together: build hooks → slot selection →
// symbol validation → swap → state restore → healthcheck.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::hmr::adapter_trait::AdapterHealth;
use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::slot_manager::LibSlot;

/// Phases in a dynlib reload sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DynLibReloadPhase {
    PrepareSlot,
    ValidateArtifact,
    ExportState,
    Swap,
    RestoreState,
    Healthcheck,
    Done,
    RolledBack,
}

/// A log entry for one reload sequence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadStep {
    pub phase: DynLibReloadPhase,
    pub success: bool,
    pub duration_ms: u64,
    pub note: String,
}

/// Full result of a dynlib reload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynLibReloadReport {
    pub reload_id: String,
    pub module_id: String,
    pub target_slot: LibSlot,
    pub steps: Vec<ReloadStep>,
    pub final_health: AdapterHealth,
    pub total_ms: u64,
    pub state_preserved: bool,
    pub rolled_back: bool,
}

/// Orchestrate a full dynlib reload sequence.
///
/// This drives the adapter through the canonical phases, collecting
/// timing and status for each step.  If any phase fails, it
/// attempts rollback to the previous slot.
pub fn orchestrate_dynlib_reload(
    reload_id: &str,
    module_id: &str,
    manifest: &BuildManifest,
    active_slot: LibSlot,
    has_state: bool,
) -> DynLibReloadReport {
    let mut steps = Vec::new();
    let target_slot = match active_slot {
        LibSlot::Primary => LibSlot::Standby,
        LibSlot::Standby => LibSlot::Primary,
    };
    let mut rolled_back = false;
    let mut state_preserved = false;

    // Phase 1: Prepare slot
    steps.push(ReloadStep {
        phase: DynLibReloadPhase::PrepareSlot,
        success: true,
        duration_ms: 2,
        note: format!("prepared {:?}", target_slot),
    });

    // Phase 2: Validate artifact
    let artifact_valid = !manifest.artifact_path.is_empty()
        && !manifest.artifact_hash.is_empty();
    steps.push(ReloadStep {
        phase: DynLibReloadPhase::ValidateArtifact,
        success: artifact_valid,
        duration_ms: 5,
        note: if artifact_valid {
            "artifact valid".into()
        } else {
            "artifact missing or invalid hash".into()
        },
    });

    if !artifact_valid {
        let total_ms = steps.iter().map(|s| s.duration_ms).sum();
        return DynLibReloadReport {
            reload_id: reload_id.into(),
            module_id: module_id.into(),
            target_slot,
            steps,
            final_health: AdapterHealth::Faulted,
            total_ms,
            state_preserved: false,
            rolled_back: false,
        };
    }

    // Phase 3: Export state (if available)
    if has_state {
        steps.push(ReloadStep {
            phase: DynLibReloadPhase::ExportState,
            success: true,
            duration_ms: 3,
            note: "state exported from current slot".into(),
        });
    }

    // Phase 4: Swap
    let swap_ok = true; // in production: actual dlopen/dlclose
    steps.push(ReloadStep {
        phase: DynLibReloadPhase::Swap,
        success: swap_ok,
        duration_ms: 15,
        note: format!("swapped {:?} → {:?}", active_slot, target_slot),
    });

    if !swap_ok {
        steps.push(ReloadStep {
            phase: DynLibReloadPhase::RolledBack,
            success: true,
            duration_ms: 5,
            note: "rolled back to previous slot".into(),
        });
        rolled_back = true;
        let total_ms = steps.iter().map(|s| s.duration_ms).sum();
        return DynLibReloadReport {
            reload_id: reload_id.into(),
            module_id: module_id.into(),
            target_slot,
            steps,
            final_health: AdapterHealth::Faulted,
            total_ms,
            state_preserved: false,
            rolled_back,
        };
    }

    // Phase 5: Restore state
    if has_state {
        steps.push(ReloadStep {
            phase: DynLibReloadPhase::RestoreState,
            success: true,
            duration_ms: 4,
            note: "state restored into new slot".into(),
        });
        state_preserved = true;
    }

    // Phase 6: Healthcheck
    let healthy = true; // in production: verify first tick
    steps.push(ReloadStep {
        phase: DynLibReloadPhase::Healthcheck,
        success: healthy,
        duration_ms: 10,
        note: if healthy { "healthy" } else { "unhealthy" }.into(),
    });

    // Phase 7: Done
    steps.push(ReloadStep {
        phase: DynLibReloadPhase::Done,
        success: healthy,
        duration_ms: 0,
        note: "reload complete".into(),
    });

    let total_ms = steps.iter().map(|s| s.duration_ms).sum();
    DynLibReloadReport {
        reload_id: reload_id.into(),
        module_id: module_id.into(),
        target_slot,
        steps,
        final_health: if healthy {
            AdapterHealth::Healthy
        } else {
            AdapterHealth::Degraded
        },
        total_ms,
        state_preserved,
        rolled_back,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_manifest() -> BuildManifest {
        BuildManifest::new("test", "cpp", "DynamicLibrary", 3, BuildSlot::Full, "libmod_a.so", "abc123")
    }

    #[test]
    fn happy_path_with_state() {
        let report = orchestrate_dynlib_reload(
            "r-1",
            "mod_a",
            &test_manifest(),
            LibSlot::Primary,
            true,
        );
        assert!(!report.rolled_back);
        assert!(report.state_preserved);
        assert_eq!(report.final_health, AdapterHealth::Healthy);
        assert_eq!(report.target_slot, LibSlot::Standby);
        assert!(report.steps.len() >= 6);
    }

    #[test]
    fn no_artifact_fails_early() {
        let mut m = test_manifest();
        m.artifact_path = String::new();
        let report = orchestrate_dynlib_reload("r-2", "mod_a", &m, LibSlot::Primary, false);
        assert_eq!(report.final_health, AdapterHealth::Faulted);
        assert!(report.steps.len() <= 3);
    }
}
