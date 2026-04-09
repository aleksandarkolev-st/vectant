// ============================================================
// CANDIDATE PROMOTION POLICY
// ============================================================
// Determines whether a validated candidate should be promoted
// to live, based on configurable policies: health checks,
// latency budgets, rollout flags, and cooldown windows.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::hmr::candidate::{Candidate, CandidateState};
use crate::hmr::health_check::HealthCheckResult;

/// Promotion policy verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PromotionVerdict {
    /// Promote immediately.
    Promote,
    /// Defer — need more health data or cooldown not elapsed.
    Defer { reason: String },
    /// Reject — hard failure, do not promote.
    Reject { reason: String },
}

/// Configurable promotion policy.
#[derive(Debug, Clone)]
pub struct PromotionPolicy {
    /// Require health check to pass before promotion.
    pub require_health_check: bool,

    /// Maximum latency for the health check itself (ms).
    pub max_health_latency_ms: u64,

    /// Minimum time since candidate creation before promotion (ms).
    /// Prevents promoting too quickly on flaky builds.
    pub min_age_ms: u64,

    /// Maximum age before candidate is considered stale (ms).
    pub max_age_ms: u64,

    /// Whether to enforce the warm reload latency budget (2.5s).
    pub enforce_latency_budget: bool,

    /// Maximum total reload time for promotion (ms).
    pub max_total_reload_ms: u64,
}

impl Default for PromotionPolicy {
    fn default() -> Self {
        Self {
            require_health_check: true,
            max_health_latency_ms: 1000,
            min_age_ms: 0,
            max_age_ms: 30_000,
            enforce_latency_budget: true,
            max_total_reload_ms: 2500,
        }
    }
}

/// Evaluate whether a candidate should be promoted.
pub fn evaluate_promotion(
    candidate: &Candidate,
    policy: &PromotionPolicy,
    total_reload_ms: u64,
) -> PromotionVerdict {
    // Must be in Validated state
    if candidate.state != CandidateState::Validated {
        return PromotionVerdict::Reject {
            reason: format!("candidate in {:?} state, not Validated", candidate.state),
        };
    }

    // Check health result if required
    if policy.require_health_check {
        match &candidate.health_result {
            None => {
                return PromotionVerdict::Defer {
                    reason: "awaiting health check result".into(),
                };
            }
            Some(HealthCheckResult::Unhealthy { reason, .. }) => {
                return PromotionVerdict::Reject {
                    reason: format!("health check failed: {}", reason),
                };
            }
            Some(HealthCheckResult::Healthy { latency_ms }) => {
                if *latency_ms > policy.max_health_latency_ms {
                    return PromotionVerdict::Reject {
                        reason: format!(
                            "health check latency {}ms exceeds max {}ms",
                            latency_ms, policy.max_health_latency_ms
                        ),
                    };
                }
            }
            Some(HealthCheckResult::Pass) | Some(HealthCheckResult::Skip { .. }) => {
                // Acceptable
            }
            Some(HealthCheckResult::Timeout { .. }) => {
                return PromotionVerdict::Reject {
                    reason: "health check timed out".into(),
                };
            }
        }
    }

    // Check age bounds
    let age_ms = candidate.age().as_millis() as u64;
    if age_ms < policy.min_age_ms {
        return PromotionVerdict::Defer {
            reason: format!(
                "candidate age {}ms below minimum {}ms",
                age_ms, policy.min_age_ms
            ),
        };
    }
    if age_ms > policy.max_age_ms {
        return PromotionVerdict::Reject {
            reason: format!(
                "candidate age {}ms exceeds maximum {}ms (stale)",
                age_ms, policy.max_age_ms
            ),
        };
    }

    // Latency budget enforcement
    if policy.enforce_latency_budget && total_reload_ms > policy.max_total_reload_ms {
        return PromotionVerdict::Reject {
            reason: format!(
                "total reload time {}ms exceeds budget {}ms",
                total_reload_ms, policy.max_total_reload_ms
            ),
        };
    }

    PromotionVerdict::Promote
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn validated_candidate() -> Candidate {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "hash1".into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            extension: Default::default(),
        };
        let mut c = Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms: 50 });
        c
    }

    #[test]
    fn promote_on_success() {
        let c = validated_candidate();
        let policy = PromotionPolicy::default();
        assert_eq!(evaluate_promotion(&c, &policy, 400), PromotionVerdict::Promote);
    }

    #[test]
    fn reject_on_budget_exceeded() {
        let c = validated_candidate();
        let policy = PromotionPolicy::default();
        match evaluate_promotion(&c, &policy, 5000) {
            PromotionVerdict::Reject { reason } => {
                assert!(reason.contains("budget"));
            }
            other => panic!("Expected Reject, got {:?}", other),
        }
    }

    #[test]
    fn reject_on_wrong_state() {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "hash1".into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            extension: Default::default(),
        };
        let c = Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        match evaluate_promotion(&c, &PromotionPolicy::default(), 400) {
            PromotionVerdict::Reject { reason } => {
                assert!(reason.contains("Built"));
            }
            other => panic!("Expected Reject, got {:?}", other),
        }
    }
}
