// ============================================================
// CANDIDATE PROMOTION / ROLLBACK PROTOCOL
// ============================================================
// Defines the contract for promoting a new candidate to "live"
// or rolling back to the previous module when health checks fail.
//
// The candidate model:
//   1. Build produces a new artifact (candidate)
//   2. Candidate is loaded alongside the current (live) module
//   3. Health check runs against the candidate
//   4. On success: candidate is promoted, old is unloaded
//   5. On failure: candidate is discarded, old stays live
// ============================================================

use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

/// Identifies a specific candidate within a preview session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateId {
    pub preview_id: String,
    pub generation: u64,
    pub artifact_hash: String,
}

/// State of a candidate through its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CandidateState {
    /// Candidate artifact has been built.
    Built,
    /// Candidate is being loaded into the runtime.
    Loading,
    /// Candidate is loaded; health check is running.
    HealthChecking,
    /// Candidate passed health check; promotion pending.
    Validated,
    /// Candidate is now live — old module has been unloaded.
    Promoted,
    /// Candidate was rolled back; old module is still live.
    RolledBack,
    /// Candidate was discarded (e.g., superseded by a newer build).
    Discarded,
}

/// A single candidate through its lifecycle.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: CandidateId,
    pub state: CandidateState,
    pub manifest: BuildManifest,
    pub decision: ReloadDecision,
    pub state_strategy: StateStrategy,
    pub health_result: Option<HealthCheckResult>,
    pub rollback_reason: Option<String>,
    pub created_at: Instant,
    pub promoted_at: Option<Instant>,
}

impl Candidate {
    pub fn new(
        manifest: BuildManifest,
        generation: u64,
        decision: ReloadDecision,
        state_strategy: StateStrategy,
    ) -> Self {
        let id = CandidateId {
            preview_id: manifest.preview_id.clone(),
            generation,
            artifact_hash: manifest.artifact_hash.clone(),
        };
        Self {
            id,
            state: CandidateState::Built,
            manifest,
            decision,
            state_strategy,
            health_result: None,
            rollback_reason: None,
            created_at: Instant::now(),
            promoted_at: None,
        }
    }

    /// Time elapsed since candidate was created.
    pub fn age(&self) -> std::time::Duration {
        self.created_at.elapsed()
    }

    /// Mark candidate as loading.
    pub fn begin_load(&mut self) {
        self.state = CandidateState::Loading;
    }

    /// Mark candidate as health-checking.
    pub fn begin_health_check(&mut self) {
        self.state = CandidateState::HealthChecking;
    }

    /// Record health check result.
    pub fn record_health(&mut self, result: HealthCheckResult) {
        self.health_result = Some(result.clone());
        if result.is_healthy() {
            self.state = CandidateState::Validated;
        } else {
            self.state = CandidateState::RolledBack;
            self.rollback_reason = result
                .failure_reason()
                .map(|s| s.to_string())
                .or_else(|| Some("health_check_failed".into()));
        }
    }

    /// Promote candidate to live.
    pub fn promote(&mut self) {
        self.state = CandidateState::Promoted;
        self.promoted_at = Some(Instant::now());
    }

    /// Rollback candidate with a reason.
    pub fn rollback(&mut self, reason: impl Into<String>) {
        self.state = CandidateState::RolledBack;
        self.rollback_reason = Some(reason.into());
    }

    /// Discard candidate (superseded).
    pub fn discard(&mut self) {
        self.state = CandidateState::Discarded;
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            CandidateState::Promoted | CandidateState::RolledBack | CandidateState::Discarded
        )
    }
}

/// Serializable summary of a candidate lifecycle for notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateSummary {
    pub preview_id: String,
    pub generation: u64,
    pub artifact_hash: String,
    pub state: CandidateState,
    pub decision: String,
    pub rollback_reason: Option<String>,
    pub age_ms: u64,
}

impl From<&Candidate> for CandidateSummary {
    fn from(c: &Candidate) -> Self {
        Self {
            preview_id: c.id.preview_id.clone(),
            generation: c.id.generation,
            artifact_hash: c.id.artifact_hash.clone(),
            state: c.state,
            decision: format!("{:?}", c.decision),
            rollback_reason: c.rollback_reason.clone(),
            age_ms: c.age().as_millis() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildSlot, HealthcheckStrategy, SnapshotMode};

    fn test_manifest() -> BuildManifest {
        BuildManifest {
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
        }
    }

    #[test]
    fn candidate_lifecycle_promote() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        assert_eq!(c.state, CandidateState::Built);

        c.begin_load();
        assert_eq!(c.state, CandidateState::Loading);

        c.begin_health_check();
        assert_eq!(c.state, CandidateState::HealthChecking);

        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        assert_eq!(c.state, CandidateState::Validated);

        c.promote();
        assert_eq!(c.state, CandidateState::Promoted);
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_lifecycle_rollback() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Unhealthy {
            reason: "segfault".into(),
            latency_ms: 5,
        });
        assert_eq!(c.state, CandidateState::RolledBack);
        assert_eq!(c.rollback_reason.as_deref(), Some("segfault"));
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_discard() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::ColdReload,
            StateStrategy::SnapshotRestore,
        );
        c.discard();
        assert_eq!(c.state, CandidateState::Discarded);
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_summary() {
        let c = Candidate::new(
            test_manifest(),
            42,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        let summary = CandidateSummary::from(&c);
        assert_eq!(summary.generation, 42);
        assert_eq!(summary.preview_id, "p1");
    }
}
