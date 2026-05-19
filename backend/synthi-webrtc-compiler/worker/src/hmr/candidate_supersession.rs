// ============================================================
// CANDIDATE SUPERSESSION
// ============================================================
// Logic for determining when a newer candidate should supersede
// an older one.  Used by the candidate queue to short-circuit
// in-flight candidates when a newer build arrives.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::candidate::{Candidate, CandidateState};

/// Supersession verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupersessionVerdict {
    /// The newer candidate supersedes — discard the older one.
    Supersede,
    /// The older candidate should finish (e.g., it's nearly promoted).
    LetFinish,
    /// Same artifact — skip the newer candidate.
    Duplicate,
}

/// Policy for supersession decisions.
#[derive(Debug, Clone)]
pub struct SupersessionPolicy {
    /// Never supersede if the older candidate is already past health check.
    pub protect_validated: bool,
    /// Always supersede regardless of state.
    pub aggressive: bool,
}

impl Default for SupersessionPolicy {
    fn default() -> Self {
        Self {
            protect_validated: true,
            aggressive: false,
        }
    }
}

/// Decide whether a newer candidate should supersede an active older one.
pub fn should_supersede(
    active: &Candidate,
    newer_artifact_hash: &str,
    policy: &SupersessionPolicy,
) -> SupersessionVerdict {
    // Same artifact — no point in replacing.
    if active.id.artifact_hash == newer_artifact_hash {
        return SupersessionVerdict::Duplicate;
    }

    // Already terminal — nothing to supersede.
    if active.is_terminal() {
        return SupersessionVerdict::LetFinish;
    }

    // Aggressive mode always supersedes.
    if policy.aggressive {
        return SupersessionVerdict::Supersede;
    }

    // If validated and policy protects validated, let it finish.
    if policy.protect_validated && active.state == CandidateState::Validated {
        return SupersessionVerdict::LetFinish;
    }

    // In Loading or HealthChecking — supersede with newer.
    match active.state {
        CandidateState::Built | CandidateState::Loading | CandidateState::HealthChecking => {
            SupersessionVerdict::Supersede
        }
        _ => SupersessionVerdict::LetFinish,
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::health_check::HealthCheckResult;
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn make_candidate(hash: &str) -> Candidate {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: hash.into(),
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
        Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        )
    }

    #[test]
    fn duplicate_hash() {
        let c = make_candidate("abc");
        assert_eq!(
            should_supersede(&c, "abc", &SupersessionPolicy::default()),
            SupersessionVerdict::Duplicate
        );
    }

    #[test]
    fn supersede_loading() {
        let mut c = make_candidate("abc");
        c.begin_load();
        assert_eq!(
            should_supersede(&c, "def", &SupersessionPolicy::default()),
            SupersessionVerdict::Supersede
        );
    }

    #[test]
    fn protect_validated() {
        let mut c = make_candidate("abc");
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        assert_eq!(c.state, CandidateState::Validated);
        assert_eq!(
            should_supersede(&c, "def", &SupersessionPolicy::default()),
            SupersessionVerdict::LetFinish
        );
    }

    #[test]
    fn aggressive_overrides() {
        let mut c = make_candidate("abc");
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        let policy = SupersessionPolicy {
            protect_validated: true,
            aggressive: true,
        };
        assert_eq!(
            should_supersede(&c, "def", &policy),
            SupersessionVerdict::Supersede
        );
    }
}
