// ============================================================
// SWAP ROLLBACK HANDLER
// ============================================================
// Handles rollback when a dynamic library swap fails at any
// phase. Ensures the worker returns to the previous known-good
// state by discarding the standby slot and resuming the old lib.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::dynlib_swap::SwapPhase;
use crate::hmr::slot_manager::LibSlot;

/// Reason for rollback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SwapRollbackReason {
    /// Symbol validation failed.
    SymbolValidationFailed { missing: Vec<String> },

    /// Health check failed after swap.
    HealthCheckFailed { message: String },

    /// Quiescence timeout — worker didn't stop in time.
    QuiescenceTimeout { timeout_ms: u64 },

    /// Snapshot failed.
    SnapshotFailed { message: String },

    /// Library load failed (dlopen error).
    LoadFailed { lib_path: String, message: String },

    /// State restore failed.
    RestoreFailed { message: String },

    /// Explicit abort by supervisor.
    Aborted { reason: String },
}

impl SwapRollbackReason {
    pub fn label(&self) -> &'static str {
        match self {
            SwapRollbackReason::SymbolValidationFailed { .. } => "symbol_validation_failed",
            SwapRollbackReason::HealthCheckFailed { .. } => "health_check_failed",
            SwapRollbackReason::QuiescenceTimeout { .. } => "quiescence_timeout",
            SwapRollbackReason::SnapshotFailed { .. } => "snapshot_failed",
            SwapRollbackReason::LoadFailed { .. } => "load_failed",
            SwapRollbackReason::RestoreFailed { .. } => "restore_failed",
            SwapRollbackReason::Aborted { .. } => "aborted",
        }
    }

    /// Whether this rollback reason suggests a permanent problem
    /// (vs transient issue that might succeed on retry).
    pub fn is_permanent(&self) -> bool {
        matches!(
            self,
            SwapRollbackReason::SymbolValidationFailed { .. }
                | SwapRollbackReason::LoadFailed { .. }
        )
    }
}

/// Record of a rollback that occurred.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapRollbackRecord {
    /// Module that was being swapped.
    pub module: String,

    /// Phase where the failure occurred.
    pub failed_phase: SwapPhase,

    /// Why the rollback happened.
    pub reason: SwapRollbackReason,

    /// Which slot was rolled back to (the old active).
    pub rolled_back_to: LibSlot,

    /// Whether a state snapshot was available for recovery.
    pub had_snapshot: bool,

    /// Whether the old library is still intact and running.
    pub old_lib_intact: bool,
}

impl SwapRollbackRecord {
    /// Whether the system is in a clean state after rollback.
    pub fn is_clean(&self) -> bool {
        self.old_lib_intact
    }

    /// Whether escalation to full restart is needed.
    pub fn needs_restart(&self) -> bool {
        !self.old_lib_intact
    }
}

/// Plan the rollback actions based on which phase failed.
pub fn plan_rollback(
    module: &str,
    failed_phase: SwapPhase,
    reason: SwapRollbackReason,
    active_slot: LibSlot,
    had_snapshot: bool,
) -> SwapRollbackRecord {
    // If we failed before the actual swap, the old lib is intact.
    // If we failed during or after swap, we may need to revert the slot.
    let old_lib_intact = matches!(
        failed_phase,
        SwapPhase::Quiescing | SwapPhase::Snapshotting | SwapPhase::Swapping
    );

    SwapRollbackRecord {
        module: module.to_string(),
        failed_phase,
        reason,
        rolled_back_to: active_slot,
        had_snapshot,
        old_lib_intact,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_rollback_on_quiesce_timeout() {
        let record = plan_rollback(
            "gui",
            SwapPhase::Quiescing,
            SwapRollbackReason::QuiescenceTimeout { timeout_ms: 500 },
            LibSlot::Primary,
            false,
        );
        assert!(record.is_clean());
        assert!(!record.needs_restart());
    }

    #[test]
    fn dirty_rollback_on_restore_failure() {
        let record = plan_rollback(
            "gui",
            SwapPhase::Restoring,
            SwapRollbackReason::RestoreFailed {
                message: "corrupt snapshot".into(),
            },
            LibSlot::Primary,
            true,
        );
        assert!(!record.is_clean());
        assert!(record.needs_restart());
    }

    #[test]
    fn permanent_vs_transient() {
        assert!(SwapRollbackReason::SymbolValidationFailed {
            missing: vec!["on_render".into()]
        }
        .is_permanent());
        assert!(!SwapRollbackReason::QuiescenceTimeout { timeout_ms: 500 }.is_permanent());
    }
}
