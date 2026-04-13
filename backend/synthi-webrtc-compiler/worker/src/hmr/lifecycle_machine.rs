// ============================================================
// PREVIEW LIFECYCLE STATE MACHINE (RUST)
// ============================================================
// Validated transition engine for the Rust-side of the preview
// lifecycle. Ensures only valid transitions occur and emits
// structured transition events for telemetry.
// ============================================================

use std::fmt;
use std::time::Instant;

use crate::hmr::preview_lifecycle::PreviewLifecycleState;

/// Validated lifecycle state machine.
pub struct LifecycleStateMachine {
    state: PreviewLifecycleState,
    preview_id: String,
    last_transition: Instant,
    transition_count: u64,
}

/// Error when an invalid transition is attempted.
#[derive(Debug)]
pub struct InvalidTransition {
    pub from: PreviewLifecycleState,
    pub to: PreviewLifecycleState,
}

impl fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid transition: {:?} → {:?}", self.from, self.to)
    }
}

impl LifecycleStateMachine {
    pub fn new(preview_id: impl Into<String>) -> Self {
        Self {
            state: PreviewLifecycleState::Idle,
            preview_id: preview_id.into(),
            last_transition: Instant::now(),
            transition_count: 0,
        }
    }

    pub fn state(&self) -> PreviewLifecycleState {
        self.state
    }

    pub fn preview_id(&self) -> &str {
        &self.preview_id
    }

    pub fn transition_count(&self) -> u64 {
        self.transition_count
    }

    /// Elapsed time since the last transition.
    pub fn elapsed_in_state(&self) -> std::time::Duration {
        self.last_transition.elapsed()
    }

    /// Attempt a transition. Returns the elapsed time in the previous
    /// state, or an error if the transition is not valid.
    pub fn transition(
        &mut self,
        to: PreviewLifecycleState,
    ) -> Result<std::time::Duration, InvalidTransition> {
        if !Self::is_valid_transition(self.state, to) {
            return Err(InvalidTransition {
                from: self.state,
                to,
            });
        }
        let elapsed = self.last_transition.elapsed();
        self.state = to;
        self.last_transition = Instant::now();
        self.transition_count += 1;
        Ok(elapsed)
    }

    /// Force transition without validation (recovery path).
    pub fn force_transition(&mut self, to: PreviewLifecycleState) -> std::time::Duration {
        let elapsed = self.last_transition.elapsed();
        self.state = to;
        self.last_transition = Instant::now();
        self.transition_count += 1;
        elapsed
    }

    /// Static table of valid transitions.
    fn is_valid_transition(from: PreviewLifecycleState, to: PreviewLifecycleState) -> bool {
        use PreviewLifecycleState::*;
        matches!(
            (from, to),
            // Normal forward path
            (Idle, CompileRequested)
                | (CompileRequested, Compiling)
                | (Compiling, CompileFinished)
                | (Compiling, CompileFailed)
                | (CompileFinished, ReloadPlanned)
                | (ReloadPlanned, ReloadApplying)
                | (ReloadApplying, ReloadApplied)
                | (ReloadApplying, ReloadRolledBack)
                | (ReloadApplied, Idle)
                | (ReloadApplied, CompileRequested)
                // Recovery / error paths
                | (ReloadRolledBack, CompileRequested)
                | (ReloadRolledBack, Idle)
                | (CompileFailed, CompileRequested)
                | (CompileFailed, Idle)
                | (CrashRecovered, CompileRequested)
                | (CrashRecovered, Idle)
                | (CrashFatal, FullRestart)
                | (FullRestart, Idle)
                // Crash from any active state
                | (Compiling, CrashRecovered)
                | (Compiling, CrashFatal)
                | (ReloadApplying, CrashRecovered)
                | (ReloadApplying, CrashFatal)
                | (ReloadApplied, CrashRecovered)
                | (ReloadApplied, CrashFatal)
                | (Idle, CrashRecovered)
                | (Idle, CrashFatal)
                // Re-compile while in applied or idle
                | (Idle, Idle) // idempotent
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::preview_lifecycle::PreviewLifecycleState::*;

    #[test]
    fn happy_path() {
        let mut sm = LifecycleStateMachine::new("p1");
        assert_eq!(sm.state(), Idle);

        sm.transition(CompileRequested).unwrap();
        sm.transition(Compiling).unwrap();
        sm.transition(CompileFinished).unwrap();
        sm.transition(ReloadPlanned).unwrap();
        sm.transition(ReloadApplying).unwrap();
        sm.transition(ReloadApplied).unwrap();
        sm.transition(Idle).unwrap();

        assert_eq!(sm.transition_count(), 7);
    }

    #[test]
    fn invalid_transition() {
        let mut sm = LifecycleStateMachine::new("p1");
        let result = sm.transition(ReloadApplied);
        assert!(result.is_err());
    }

    #[test]
    fn recovery_from_crash() {
        let mut sm = LifecycleStateMachine::new("p1");
        sm.transition(CompileRequested).unwrap();
        sm.transition(Compiling).unwrap();
        sm.transition(CrashRecovered).unwrap();
        sm.transition(CompileRequested).unwrap();
        assert_eq!(sm.state(), CompileRequested);
    }

    #[test]
    fn force_transition_bypasses_validation() {
        let mut sm = LifecycleStateMachine::new("p1");
        sm.force_transition(ReloadApplied);
        assert_eq!(sm.state(), ReloadApplied);
    }

    #[test]
    fn compile_failure_recovery() {
        let mut sm = LifecycleStateMachine::new("p1");
        sm.transition(CompileRequested).unwrap();
        sm.transition(Compiling).unwrap();
        sm.transition(CompileFailed).unwrap();
        sm.transition(CompileRequested).unwrap(); // retry
        assert_eq!(sm.state(), CompileRequested);
    }
}
