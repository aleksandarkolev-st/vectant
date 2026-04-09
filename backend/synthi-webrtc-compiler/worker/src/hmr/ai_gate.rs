// ============================================================
// AI GATE
// ============================================================
// Explicit gate controlling when AI endpoints are called during
// compilation. Enforces the invariant: AI must NOT be in the
// steady-state hot path for adapted projects.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::hmr::loop_classifier::CompileLoop;

/// Reason the AI gate blocked or allowed a call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AiGateDecision {
    /// AI call allowed.
    Allowed { reason: String },

    /// AI call blocked.
    Blocked { reason: String },
}

impl AiGateDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, AiGateDecision::Allowed { .. })
    }
}

/// Tracks AI call statistics for telemetry.
#[derive(Debug)]
pub struct AiGateStats {
    calls_allowed: AtomicU64,
    calls_blocked: AtomicU64,
    loop_a_compiles: AtomicU64,
    loop_b_compiles: AtomicU64,
}

impl AiGateStats {
    pub fn new() -> Self {
        Self {
            calls_allowed: AtomicU64::new(0),
            calls_blocked: AtomicU64::new(0),
            loop_a_compiles: AtomicU64::new(0),
            loop_b_compiles: AtomicU64::new(0),
        }
    }

    pub fn record_allowed(&self) {
        self.calls_allowed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_blocked(&self) {
        self.calls_blocked.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_compile(&self, loop_type: CompileLoop) {
        match loop_type {
            CompileLoop::LoopA => self.loop_a_compiles.fetch_add(1, Ordering::Relaxed),
            CompileLoop::LoopB => self.loop_b_compiles.fetch_add(1, Ordering::Relaxed),
        };
    }

    pub fn snapshot(&self) -> AiGateStatsSnapshot {
        AiGateStatsSnapshot {
            calls_allowed: self.calls_allowed.load(Ordering::Relaxed),
            calls_blocked: self.calls_blocked.load(Ordering::Relaxed),
            loop_a_compiles: self.loop_a_compiles.load(Ordering::Relaxed),
            loop_b_compiles: self.loop_b_compiles.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiGateStatsSnapshot {
    pub calls_allowed: u64,
    pub calls_blocked: u64,
    pub loop_a_compiles: u64,
    pub loop_b_compiles: u64,
}

impl AiGateStatsSnapshot {
    /// Fraction of compiles that used the deterministic path.
    pub fn loop_a_ratio(&self) -> f64 {
        let total = self.loop_a_compiles + self.loop_b_compiles;
        if total == 0 {
            return 0.0;
        }
        self.loop_a_compiles as f64 / total as f64
    }
}

/// The AI gate. Checks whether an AI endpoint call should be
/// allowed based on the current compile loop.
pub struct AiGate {
    stats: Arc<AiGateStats>,
}

impl AiGate {
    pub fn new() -> Self {
        Self {
            stats: Arc::new(AiGateStats::new()),
        }
    }

    /// Check whether an AI call should be allowed.
    ///
    /// In Loop A, AI calls are blocked (deterministic path).
    /// In Loop B, AI calls are allowed (adaptation/rescue path).
    pub fn check(&self, loop_type: CompileLoop, endpoint: &str) -> AiGateDecision {
        self.stats.record_compile(loop_type);

        match loop_type {
            CompileLoop::LoopA => {
                self.stats.record_blocked();
                AiGateDecision::Blocked {
                    reason: format!(
                        "Loop A (deterministic): AI endpoint '{}' blocked",
                        endpoint
                    ),
                }
            }
            CompileLoop::LoopB => {
                self.stats.record_allowed();
                AiGateDecision::Allowed {
                    reason: format!(
                        "Loop B (AI-assisted): AI endpoint '{}' allowed",
                        endpoint
                    ),
                }
            }
        }
    }

    /// Get a snapshot of the gate statistics.
    pub fn stats(&self) -> AiGateStatsSnapshot {
        self.stats.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_a_blocks_ai() {
        let gate = AiGate::new();
        let decision = gate.check(CompileLoop::LoopA, "/refactor/split");
        assert!(!decision.is_allowed());
    }

    #[test]
    fn loop_b_allows_ai() {
        let gate = AiGate::new();
        let decision = gate.check(CompileLoop::LoopB, "/refactor/split");
        assert!(decision.is_allowed());
    }

    #[test]
    fn stats_tracking() {
        let gate = AiGate::new();
        gate.check(CompileLoop::LoopA, "/refactor/split");
        gate.check(CompileLoop::LoopA, "/refactor/delta");
        gate.check(CompileLoop::LoopB, "/refactor/split");

        let stats = gate.stats();
        assert_eq!(stats.calls_blocked, 2);
        assert_eq!(stats.calls_allowed, 1);
        assert_eq!(stats.loop_a_compiles, 2);
        assert_eq!(stats.loop_b_compiles, 1);
        assert!((stats.loop_a_ratio() - 0.666).abs() < 0.01);
    }
}
