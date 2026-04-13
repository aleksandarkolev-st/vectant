// ============================================================
// HOT SWAP COORDINATOR
// ============================================================
// Orchestrates the full dynamic library hot-swap sequence:
// eligibility → quiesce → snapshot → swap → validate → restore → resume.
// Ties together the swap protocol, slot manager, symbol validation,
// and health checks into a single coordinated operation.
// ============================================================


use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::hmr::dynlib_swap::SwapPhase;
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::slot_manager::LibSlot;
use crate::hmr::symbol_validation::SymbolValidationResult;

/// Configuration for a hot swap operation.
#[derive(Debug, Clone)]
pub struct HotSwapConfig {
    /// Timeout for quiescence (ms).
    pub quiesce_timeout_ms: u64,
    /// Timeout for snapshot (ms).
    pub snapshot_timeout_ms: u64,
    /// Timeout for library loading (ms).
    pub load_timeout_ms: u64,
    /// Timeout for state restore (ms).
    pub restore_timeout_ms: u64,
    /// Timeout for health check (ms).
    pub health_timeout_ms: u64,
    /// Whether to roll back on health check failure.
    pub rollback_on_health_failure: bool,
}

impl Default for HotSwapConfig {
    fn default() -> Self {
        Self {
            quiesce_timeout_ms: 500,
            snapshot_timeout_ms: 1000,
            load_timeout_ms: 2000,
            restore_timeout_ms: 1000,
            health_timeout_ms: 1000,
            rollback_on_health_failure: true,
        }
    }
}

/// A planned hot swap operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotSwapPlan {
    /// Module being swapped.
    pub module: String,
    /// Path to the new library.
    pub new_lib_path: PathBuf,
    /// ABI version of the new library.
    pub new_abi_version: String,
    /// Required symbols to verify.
    pub required_symbols: Vec<String>,
    /// State format version.
    pub state_format_version: u32,
    /// Which slot the new library will occupy.
    pub target_slot: LibSlot,
}

/// Outcome of a hot swap operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotSwapOutcome {
    /// Module that was swapped.
    pub module: String,
    /// Whether the swap succeeded end-to-end.
    pub success: bool,
    /// Phase where it failed (if applicable).
    pub failed_phase: Option<SwapPhase>,
    /// Error message (if applicable).
    pub error: Option<String>,
    /// Symbol validation result.
    pub symbol_validation: Option<SymbolValidationResult>,
    /// Health check result.
    pub health_result: Option<HealthCheckResult>,
    /// Whether rollback was performed.
    pub rolled_back: bool,
    /// Total elapsed time (ms).
    pub total_ms: u64,
    /// Per-phase timing breakdown.
    pub phase_timing: PhaseTiming,
}

/// Timing breakdown by phase.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PhaseTiming {
    pub quiesce_ms: u64,
    pub snapshot_ms: u64,
    pub load_ms: u64,
    pub validate_ms: u64,
    pub restore_ms: u64,
    pub health_check_ms: u64,
    pub resume_ms: u64,
}

impl PhaseTiming {
    pub fn total(&self) -> u64 {
        self.quiesce_ms
            + self.snapshot_ms
            + self.load_ms
            + self.validate_ms
            + self.restore_ms
            + self.health_check_ms
            + self.resume_ms
    }
}

impl HotSwapOutcome {
    /// Create a successful outcome.
    pub fn success(
        module: String,
        symbol_validation: SymbolValidationResult,
        health_result: HealthCheckResult,
        phase_timing: PhaseTiming,
    ) -> Self {
        Self {
            module,
            success: true,
            failed_phase: None,
            error: None,
            symbol_validation: Some(symbol_validation),
            health_result: Some(health_result),
            rolled_back: false,
            total_ms: phase_timing.total(),
            phase_timing,
        }
    }

    /// Create a failure outcome.
    pub fn failure(
        module: String,
        phase: SwapPhase,
        error: String,
        rolled_back: bool,
        phase_timing: PhaseTiming,
    ) -> Self {
        Self {
            module,
            success: false,
            failed_phase: Some(phase),
            error: Some(error),
            symbol_validation: None,
            health_result: None,
            rolled_back,
            total_ms: phase_timing.total(),
            phase_timing,
        }
    }

    /// Whether we exceeded the warm reload budget (2.5s).
    pub fn exceeds_warm_budget(&self) -> bool {
        self.total_ms > 2500
    }
}

/// State machine for tracking hot swap progress.
#[derive(Debug)]
pub struct HotSwapTracker {
    pub module: String,
    pub phase: SwapPhase,
    pub timing: PhaseTiming,
    phase_start_ms: u64,
}

impl HotSwapTracker {
    pub fn new(module: &str) -> Self {
        Self {
            module: module.to_string(),
            phase: SwapPhase::Idle,
            timing: PhaseTiming::default(),
            phase_start_ms: 0,
        }
    }

    /// Advance to the next phase, recording timing.
    pub fn advance(&mut self, next: SwapPhase, current_time_ms: u64) {
        let elapsed = current_time_ms.saturating_sub(self.phase_start_ms);

        match self.phase {
            SwapPhase::Quiescing => self.timing.quiesce_ms = elapsed,
            SwapPhase::Snapshotting => self.timing.snapshot_ms = elapsed,
            SwapPhase::Swapping => self.timing.load_ms = elapsed,
            SwapPhase::Restoring => self.timing.restore_ms = elapsed,
            SwapPhase::Resuming => self.timing.resume_ms = elapsed,
            _ => {}
        }

        self.phase = next;
        self.phase_start_ms = current_time_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_timing_total() {
        let timing = PhaseTiming {
            quiesce_ms: 50,
            snapshot_ms: 100,
            load_ms: 200,
            validate_ms: 10,
            restore_ms: 80,
            health_check_ms: 30,
            resume_ms: 5,
        };
        assert_eq!(timing.total(), 475);
    }

    #[test]
    fn tracker_advance() {
        let mut tracker = HotSwapTracker::new("gui");
        assert_eq!(tracker.phase, SwapPhase::Idle);

        tracker.advance(SwapPhase::Quiescing, 0);
        tracker.advance(SwapPhase::Snapshotting, 50);
        assert_eq!(tracker.timing.quiesce_ms, 50);
        assert_eq!(tracker.phase, SwapPhase::Snapshotting);
    }

    #[test]
    fn budget_check() {
        let timing = PhaseTiming {
            quiesce_ms: 500,
            snapshot_ms: 500,
            load_ms: 1000,
            validate_ms: 100,
            restore_ms: 200,
            health_check_ms: 100,
            resume_ms: 200,
        };
        let outcome = HotSwapOutcome::failure(
            "gui".to_string(),
            SwapPhase::Restoring,
            "timeout".to_string(),
            true,
            timing,
        );
        assert!(outcome.exceeds_warm_budget());
    }
}
