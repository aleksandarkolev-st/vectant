// ============================================================
// AI FALLBACK CHAIN
// ============================================================
// Defines the fallback strategy when AI is unavailable or
// returns an unusable response.  Each level in the chain is
// tried in sequence until one succeeds.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::ai_request_contract::AiRequestReason;

/// A fallback level in the chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FallbackLevel {
    /// Retry with the same AI backend.
    RetryAi { delay_ms: u64 },
    /// Use cached AI response from a previous identical request.
    UseCachedResponse,
    /// Apply a pre-built heuristic rule.
    HeuristicRule { rule_name: String },
    /// Use the deterministic planner's best-effort decision.
    PlannerBestEffort,
    /// Fall back to cold reload (always works).
    ColdReload,
    /// Fall back to full restart (nuclear option).
    FullRestart,
}

/// The complete fallback chain for a request type.
#[derive(Debug, Clone)]
pub struct FallbackChain {
    pub reason: AiRequestReason,
    pub levels: Vec<FallbackLevel>,
}

/// Build the fallback chain for a given request reason.
pub fn build_fallback_chain(reason: AiRequestReason) -> FallbackChain {
    let levels = match reason {
        AiRequestReason::SplitUnknown => vec![
            FallbackLevel::RetryAi { delay_ms: 1000 },
            FallbackLevel::UseCachedResponse,
            FallbackLevel::HeuristicRule {
                rule_name: "path_based_split".into(),
            },
            FallbackLevel::PlannerBestEffort,
            FallbackLevel::FullRestart,
        ],

        AiRequestReason::HealingNeeded => vec![
            FallbackLevel::RetryAi { delay_ms: 500 },
            FallbackLevel::UseCachedResponse,
            FallbackLevel::HeuristicRule {
                rule_name: "common_error_patches".into(),
            },
            FallbackLevel::ColdReload,
            FallbackLevel::FullRestart,
        ],

        AiRequestReason::AdapterAdaptation => vec![
            FallbackLevel::RetryAi { delay_ms: 2000 },
            FallbackLevel::UseCachedResponse,
            FallbackLevel::PlannerBestEffort,
            FallbackLevel::ColdReload,
        ],

        AiRequestReason::MigrationGuidance => vec![
            FallbackLevel::RetryAi { delay_ms: 1000 },
            FallbackLevel::HeuristicRule {
                rule_name: "identity_migration".into(),
            },
            FallbackLevel::PlannerBestEffort,
            FallbackLevel::ColdReload,
        ],

        AiRequestReason::RetryExhausted => vec![
            // Already exhausted retries, go straight to deterministic fallbacks
            FallbackLevel::PlannerBestEffort,
            FallbackLevel::ColdReload,
            FallbackLevel::FullRestart,
        ],
    };

    FallbackChain { reason, levels }
}

/// Track progress through the fallback chain.
#[derive(Debug)]
pub struct FallbackTracker {
    chain: FallbackChain,
    current_level: usize,
    attempts_at_level: u32,
    max_retries_per_level: u32,
}

/// Result of advancing the fallback chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FallbackAdvance {
    /// Try this fallback level.
    Try(FallbackLevel),
    /// All levels exhausted.
    Exhausted,
}

impl FallbackTracker {
    pub fn new(chain: FallbackChain) -> Self {
        Self {
            chain,
            current_level: 0,
            attempts_at_level: 0,
            max_retries_per_level: 2,
        }
    }

    /// Get the current fallback level.
    pub fn current(&self) -> FallbackAdvance {
        if self.current_level >= self.chain.levels.len() {
            FallbackAdvance::Exhausted
        } else {
            FallbackAdvance::Try(self.chain.levels[self.current_level].clone())
        }
    }

    /// Mark the current level as failed and advance.
    pub fn advance(&mut self) -> FallbackAdvance {
        self.attempts_at_level += 1;

        // For retry levels, allow multiple attempts
        if let Some(FallbackLevel::RetryAi { .. }) = self.chain.levels.get(self.current_level) {
            if self.attempts_at_level < self.max_retries_per_level {
                return self.current();
            }
        }

        // Move to next level
        self.current_level += 1;
        self.attempts_at_level = 0;
        self.current()
    }

    /// How many levels remain.
    pub fn remaining_levels(&self) -> usize {
        self.chain.levels.len().saturating_sub(self.current_level)
    }

    /// Whether we've exhausted all options.
    pub fn is_exhausted(&self) -> bool {
        self.current_level >= self.chain.levels.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_chain_structure() {
        let chain = build_fallback_chain(AiRequestReason::SplitUnknown);
        assert_eq!(chain.levels.len(), 5);
        assert!(matches!(chain.levels[0], FallbackLevel::RetryAi { .. }));
        assert_eq!(chain.levels[4], FallbackLevel::FullRestart);
    }

    #[test]
    fn tracker_advances() {
        let chain = build_fallback_chain(AiRequestReason::RetryExhausted);
        let mut tracker = FallbackTracker::new(chain);

        assert!(matches!(
            tracker.current(),
            FallbackAdvance::Try(FallbackLevel::PlannerBestEffort)
        ));
        tracker.advance();
        assert!(matches!(
            tracker.current(),
            FallbackAdvance::Try(FallbackLevel::ColdReload)
        ));
        tracker.advance();
        assert!(matches!(
            tracker.current(),
            FallbackAdvance::Try(FallbackLevel::FullRestart)
        ));
        tracker.advance();
        assert_eq!(tracker.current(), FallbackAdvance::Exhausted);
    }

    #[test]
    fn retry_allows_multiple_attempts() {
        let chain = build_fallback_chain(AiRequestReason::SplitUnknown);
        let mut tracker = FallbackTracker::new(chain);

        // First attempt at RetryAi
        assert!(matches!(
            tracker.current(),
            FallbackAdvance::Try(FallbackLevel::RetryAi { .. })
        ));

        // First advance stays at RetryAi (attempt 1 < max 2)
        let next = tracker.advance();
        assert!(matches!(
            next,
            FallbackAdvance::Try(FallbackLevel::RetryAi { .. })
        ));

        // Second advance moves past RetryAi
        let next = tracker.advance();
        assert!(matches!(
            next,
            FallbackAdvance::Try(FallbackLevel::UseCachedResponse)
        ));
    }
}
