// ============================================================
// DYNLIB ROLLBACK STRATEGY
// ============================================================
// Detailed rollback logic when a dynlib reload fails at any
// phase.  Decides which slot to revert to, whether to restore
// state, and what to report to the planner.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Phase at which failure occurred, determining rollback depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailurePhase {
    /// Failed during preload validation — nothing was loaded.
    PreloadValidation,
    /// Failed loading the library (dlopen).
    Load,
    /// Failed resolving symbols.
    SymbolResolve,
    /// Failed exporting state from old library.
    StateExport,
    /// Failed the swap itself (slot toggle).
    Swap,
    /// Failed importing state into new library.
    StateImport,
    /// Failed post-swap health check.
    HealthCheck,
}

/// What the rollback strategy decided to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RollbackAction {
    /// Nothing was loaded; just report failure.
    NoOp,
    /// Unload the new library, keep current slot active.
    UnloadNew,
    /// Toggle back to previous slot (reverse swap).
    RevertSlot,
    /// Revert slot and restore state snapshot.
    RevertSlotAndRestoreState,
    /// Everything is broken; trigger cold reload via planner.
    EscalateColdReload,
}

/// Details of a rollback execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackReport {
    pub failure_phase: FailurePhase,
    pub action_taken: RollbackAction,
    pub state_restored: bool,
    pub rollback_ms: u64,
    pub message: String,
}

/// Configuration for rollback behaviour.
#[derive(Debug, Clone)]
pub struct RollbackConfig {
    /// Whether state rollback is enabled.
    pub enable_state_restore: bool,
    /// Maximum time for rollback before escalating (millis).
    pub rollback_timeout_ms: u64,
    /// Whether to escalate to cold reload on rollback failure.
    pub escalate_on_rollback_failure: bool,
}

impl Default for RollbackConfig {
    fn default() -> Self {
        Self {
            enable_state_restore: true,
            rollback_timeout_ms: 5000,
            escalate_on_rollback_failure: true,
        }
    }
}

/// Determine the rollback action for a given failure phase.
pub fn determine_rollback_action(
    phase: FailurePhase,
    state_snapshot_available: bool,
    config: &RollbackConfig,
) -> RollbackAction {
    match phase {
        FailurePhase::PreloadValidation => {
            // Nothing was loaded.
            RollbackAction::NoOp
        }
        FailurePhase::Load | FailurePhase::SymbolResolve => {
            // New library was loaded but never activated.
            RollbackAction::UnloadNew
        }
        FailurePhase::StateExport => {
            // Old library still active, new was loaded. Unload new.
            RollbackAction::UnloadNew
        }
        FailurePhase::Swap => {
            // Swap partially happened — revert slot.
            RollbackAction::RevertSlot
        }
        FailurePhase::StateImport | FailurePhase::HealthCheck => {
            // New slot is active but in bad shape.
            if config.enable_state_restore && state_snapshot_available {
                RollbackAction::RevertSlotAndRestoreState
            } else {
                RollbackAction::RevertSlot
            }
        }
    }
}

/// Execute a rollback (simulated) and produce a report.
pub fn execute_rollback(
    phase: FailurePhase,
    state_snapshot_available: bool,
    config: &RollbackConfig,
    simulated_rollback_ms: u64,
) -> RollbackReport {
    let action = determine_rollback_action(phase, state_snapshot_available, config);

    let state_restored = action == RollbackAction::RevertSlotAndRestoreState;

    let message = match action {
        RollbackAction::NoOp => "no action needed, failure was pre-load".into(),
        RollbackAction::UnloadNew => "unloaded new library, old slot remains active".into(),
        RollbackAction::RevertSlot => "reverted to previous slot".into(),
        RollbackAction::RevertSlotAndRestoreState => {
            "reverted to previous slot and restored state snapshot".into()
        }
        RollbackAction::EscalateColdReload => "rollback failed, escalating to cold reload".into(),
    };

    RollbackReport {
        failure_phase: phase,
        action_taken: action,
        state_restored,
        rollback_ms: simulated_rollback_ms,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preload_failure_is_noop() {
        let action = determine_rollback_action(
            FailurePhase::PreloadValidation,
            false,
            &RollbackConfig::default(),
        );
        assert_eq!(action, RollbackAction::NoOp);
    }

    #[test]
    fn load_failure_unloads_new() {
        let action = determine_rollback_action(
            FailurePhase::Load,
            false,
            &RollbackConfig::default(),
        );
        assert_eq!(action, RollbackAction::UnloadNew);
    }

    #[test]
    fn health_check_failure_restores_state() {
        let action = determine_rollback_action(
            FailurePhase::HealthCheck,
            true,
            &RollbackConfig::default(),
        );
        assert_eq!(action, RollbackAction::RevertSlotAndRestoreState);
    }

    #[test]
    fn health_check_without_snapshot_just_reverts() {
        let action = determine_rollback_action(
            FailurePhase::HealthCheck,
            false,
            &RollbackConfig::default(),
        );
        assert_eq!(action, RollbackAction::RevertSlot);
    }

    #[test]
    fn execute_produces_report() {
        let report = execute_rollback(
            FailurePhase::StateImport,
            true,
            &RollbackConfig::default(),
            12,
        );
        assert!(report.state_restored);
        assert_eq!(report.action_taken, RollbackAction::RevertSlotAndRestoreState);
        assert_eq!(report.rollback_ms, 12);
    }
}
