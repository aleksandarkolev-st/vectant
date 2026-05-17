// ============================================================
// CANDIDATE QUEUE
// ============================================================
// FIFO queue of candidates awaiting processing.  At most one
// candidate is "active" (Loading/HealthChecking).  Incoming
// builds are queued and supersede any older pending candidates.
// ============================================================

use std::collections::VecDeque;

use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::candidate::{Candidate, CandidateSummary};
use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

/// Maximum pending candidates before oldest are discarded.
const MAX_PENDING: usize = 4;

/// Thread-safe candidate queue for a single preview session.
pub struct CandidateQueue {
    preview_id: String,
    generation: u64,
    pending: VecDeque<Candidate>,
    active: Option<Candidate>,
    completed: Vec<CandidateSummary>,
    max_completed_history: usize,
}

impl CandidateQueue {
    pub fn new(preview_id: &str) -> Self {
        Self {
            preview_id: preview_id.to_string(),
            generation: 0,
            pending: VecDeque::new(),
            active: None,
            completed: Vec::new(),
            max_completed_history: 32,
        }
    }

    /// Enqueue a new candidate from a build manifest.
    /// Supersedes any older pending candidates.
    pub fn enqueue(
        &mut self,
        mut manifest: BuildManifest,
        decision: ReloadDecision,
        state_strategy: StateStrategy,
    ) -> u64 {
        self.generation += 1;
        let gen = self.generation;

        if manifest.preview_id != self.preview_id {
            // Expected when subsequent compiles generate a new session_id on
            // the frontend — the queue keeps its original preview_id as the
            // canonical identity for this preview session. Gated behind
            // debug_log! so it only shows with SYNTHI_WORKER_VERBOSE=1.
            crate::debug_log!(
                "[CandidateQueue] Normalizing new manifest preview ({}) to queue preview ({})",
                manifest.preview_id,
                self.preview_id
            );
            manifest.preview_id = self.preview_id.clone();
        }

        let candidate = Candidate::new(manifest, gen, decision, state_strategy);

        // If queue is at capacity, discard oldest pending
        while self.pending.len() >= MAX_PENDING {
            if let Some(mut old) = self.pending.pop_front() {
                old.discard();
                self.archive(CandidateSummary::from(&old));
            }
        }

        self.pending.push_back(candidate);
        gen
    }

    /// Take the next pending candidate and make it active.
    /// Returns None if queue is empty or there's already an active candidate.
    pub fn activate_next(&mut self) -> Option<&mut Candidate> {
        if self.active.is_some() {
            return None;
        }
        if let Some(mut c) = self.pending.pop_front() {
            c.begin_load();
            self.active = Some(c);
            self.active.as_mut()
        } else {
            None
        }
    }

    /// Get a mutable reference to the active candidate.
    pub fn active_mut(&mut self) -> Option<&mut Candidate> {
        self.active.as_mut()
    }

    /// Get a reference to the active candidate.
    pub fn active(&self) -> Option<&Candidate> {
        self.active.as_ref()
    }

    /// Complete the active candidate (promote or rollback).
    /// Moves it to the completed history.
    pub fn complete_active(&mut self) -> Option<CandidateSummary> {
        if let Some(c) = self.active.take() {
            let summary = CandidateSummary::from(&c);
            self.archive(summary.clone());
            Some(summary)
        } else {
            None
        }
    }

    /// Discard all pending candidates (e.g., on kill switch).
    pub fn drain_pending(&mut self) -> Vec<CandidateSummary> {
        let mut discarded = Vec::new();
        while let Some(mut c) = self.pending.pop_front() {
            c.discard();
            let summary = CandidateSummary::from(&c);
            self.archive(summary.clone());
            discarded.push(summary);
        }
        discarded
    }

    /// Number of pending candidates.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Whether there is an active candidate in flight.
    pub fn has_active(&self) -> bool {
        self.active.is_some()
    }

    /// Current generation counter.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Preview session that owns this queue.
    pub fn preview_id(&self) -> &str {
        &self.preview_id
    }

    /// Completed candidate history (newest last).
    pub fn history(&self) -> &[CandidateSummary] {
        &self.completed
    }

    /// Last completed candidate.
    pub fn last_completed(&self) -> Option<&CandidateSummary> {
        self.completed.last()
    }

    fn archive(&mut self, summary: CandidateSummary) {
        self.completed.push(summary);
        if self.completed.len() > self.max_completed_history {
            self.completed.remove(0);
        }
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildSlot, HealthcheckStrategy};

    fn manifest(hash: &str) -> BuildManifest {
        BuildManifest {
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
        }
    }

    #[test]
    fn enqueue_and_activate() {
        let mut q = CandidateQueue::new("p1");
        q.enqueue(
            manifest("a"),
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        q.enqueue(
            manifest("b"),
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        assert_eq!(q.pending_count(), 2);
        assert_eq!(q.generation(), 2);

        let active = q.activate_next().unwrap();
        assert_eq!(active.id.artifact_hash, "a");
        assert_eq!(active.state, CandidateState::Loading);

        // Can't activate another while one is active
        assert!(q.activate_next().is_none());
    }

    #[test]
    fn complete_and_history() {
        let mut q = CandidateQueue::new("p1");
        q.enqueue(
            manifest("a"),
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        q.activate_next();
        let summary = q.complete_active().unwrap();
        assert_eq!(summary.artifact_hash, "a");
        assert_eq!(q.history().len(), 1);
        assert!(!q.has_active());
    }

    #[test]
    fn overflow_discards_oldest() {
        let mut q = CandidateQueue::new("p1");
        for i in 0..6 {
            q.enqueue(
                manifest(&format!("h{i}")),
                ReloadDecision::WarmReload,
                StateStrategy::PreservePointer,
            );
        }
        // MAX_PENDING = 4, so 2 were discarded
        assert_eq!(q.pending_count(), 4);
        assert_eq!(q.history().len(), 2); // discarded go to history
    }
}
