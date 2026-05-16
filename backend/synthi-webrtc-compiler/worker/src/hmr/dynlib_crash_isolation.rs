// ============================================================
// DYNLIB CRASH ISOLATION
// ============================================================
// Wraps dynlib function calls with crash-isolation guards.
// If user code in the loaded library segfaults, panics, or
// hangs, the guard catches it and triggers rollback instead
// of taking down the host process.
// ============================================================

use serde::{Deserialize, Serialize};

/// Kind of crash that was caught.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrashKind {
    /// SIGSEGV / access violation.
    Segfault,
    /// SIGABRT or assertion failure.
    Abort,
    /// Function didn't return within timeout.
    Timeout,
    /// Rust panic or C++ exception.
    Panic,
    /// Return code indicated error.
    ErrorReturn,
    /// Unknown crash.
    Unknown,
}

/// Information about a detected crash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashReport {
    pub kind: CrashKind,
    pub symbol_name: String,
    pub message: String,
    pub occurred_at_ms: u64,
    /// Whether a state snapshot was taken before the call.
    pub state_snapshot_available: bool,
}

/// Configuration for crash isolation.
#[derive(Debug, Clone)]
pub struct CrashIsolationConfig {
    /// Maximum time for any single ABI call (millis).
    pub call_timeout_ms: u64,
    /// Whether to fork-isolate risky calls.
    pub use_fork_isolation: bool,
    /// Maximum consecutive crashes before permanent fault.
    pub max_consecutive_crashes: u32,
}

impl Default for CrashIsolationConfig {
    fn default() -> Self {
        Self {
            call_timeout_ms: 5000,
            use_fork_isolation: false,
            max_consecutive_crashes: 3,
        }
    }
}

/// Guard that wraps dynlib function invocations.
pub struct CrashGuard {
    config: CrashIsolationConfig,
    consecutive_crashes: u32,
    total_crashes: u32,
    permanently_faulted: bool,
    last_crash: Option<CrashReport>,
}

impl CrashGuard {
    pub fn new(config: CrashIsolationConfig) -> Self {
        Self {
            config,
            consecutive_crashes: 0,
            total_crashes: 0,
            permanently_faulted: false,
            last_crash: None,
        }
    }

    /// Whether the guard has permanently faulted (too many crashes).
    pub fn is_faulted(&self) -> bool {
        self.permanently_faulted
    }

    /// Record a successful call — resets consecutive counter.
    pub fn record_success(&mut self) {
        self.consecutive_crashes = 0;
    }

    /// Record a crash.
    pub fn record_crash(&mut self, report: CrashReport) {
        self.consecutive_crashes += 1;
        self.total_crashes += 1;
        self.last_crash = Some(report);

        if self.consecutive_crashes >= self.config.max_consecutive_crashes {
            self.permanently_faulted = true;
        }
    }

    /// Simulate executing a function with crash guard.
    ///
    /// In production: fork-isolate or signal-handle around the actual fn ptr call.
    /// Returns Ok(return_code) or Err(CrashReport).
    pub fn guarded_call(
        &mut self,
        symbol_name: &str,
        simulated_return: Result<i32, CrashKind>,
        now_ms: u64,
        has_state_snapshot: bool,
    ) -> Result<i32, CrashReport> {
        if self.permanently_faulted {
            return Err(CrashReport {
                kind: CrashKind::Unknown,
                symbol_name: symbol_name.into(),
                message: "guard permanently faulted".into(),
                occurred_at_ms: now_ms,
                state_snapshot_available: has_state_snapshot,
            });
        }

        match simulated_return {
            Ok(rc) if rc >= 0 => {
                self.record_success();
                Ok(rc)
            }
            Ok(rc) => {
                // Negative return code = error
                let report = CrashReport {
                    kind: CrashKind::ErrorReturn,
                    symbol_name: symbol_name.into(),
                    message: format!("returned error code {}", rc),
                    occurred_at_ms: now_ms,
                    state_snapshot_available: has_state_snapshot,
                };
                self.record_crash(report.clone());
                Err(report)
            }
            Err(kind) => {
                let report = CrashReport {
                    kind,
                    symbol_name: symbol_name.into(),
                    message: format!("{:?} in {}", kind, symbol_name),
                    occurred_at_ms: now_ms,
                    state_snapshot_available: has_state_snapshot,
                };
                self.record_crash(report.clone());
                Err(report)
            }
        }
    }

    /// Total crash count.
    pub fn total_crashes(&self) -> u32 {
        self.total_crashes
    }

    /// Last crash report.
    pub fn last_crash(&self) -> Option<&CrashReport> {
        self.last_crash.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_resets_counter() {
        let mut guard = CrashGuard::new(CrashIsolationConfig::default());
        let _ = guard.guarded_call("hmr_on_update", Err(CrashKind::Segfault), 100, false);
        assert_eq!(guard.consecutive_crashes, 1);

        let _ = guard.guarded_call("hmr_on_update", Ok(0), 200, false);
        assert_eq!(guard.consecutive_crashes, 0);
    }

    #[test]
    fn faults_after_threshold() {
        let mut guard = CrashGuard::new(CrashIsolationConfig {
            max_consecutive_crashes: 2,
            ..Default::default()
        });
        let _ = guard.guarded_call("hmr_on_update", Err(CrashKind::Abort), 100, false);
        assert!(!guard.is_faulted());
        let _ = guard.guarded_call("hmr_on_update", Err(CrashKind::Abort), 200, false);
        assert!(guard.is_faulted());
    }

    #[test]
    fn faulted_guard_rejects_calls() {
        let mut guard = CrashGuard::new(CrashIsolationConfig {
            max_consecutive_crashes: 1,
            ..Default::default()
        });
        let _ = guard.guarded_call("hmr_init", Err(CrashKind::Segfault), 100, false);
        assert!(guard.is_faulted());

        let result = guard.guarded_call("hmr_on_update", Ok(0), 200, false);
        assert!(result.is_err());
    }

    #[test]
    fn negative_return_is_error() {
        let mut guard = CrashGuard::new(CrashIsolationConfig::default());
        let result = guard.guarded_call("hmr_on_render", Ok(-1), 100, true);
        assert!(result.is_err());
        let report = result.unwrap_err();
        assert_eq!(report.kind, CrashKind::ErrorReturn);
        assert!(report.state_snapshot_available);
    }
}
