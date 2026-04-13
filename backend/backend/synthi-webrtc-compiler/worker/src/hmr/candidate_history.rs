// ============================================================
// CANDIDATE HISTORY LOG
// ============================================================
// Persistent, bounded log of completed candidate lifecycles.
// Supports querying by preview session, state, time range,
// and provides aggregate statistics for telemetry.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::hmr::candidate::{CandidateState, CandidateSummary};

/// Maximum entries retained in the history log.
const MAX_HISTORY: usize = 256;

/// A single history entry with additional metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub summary: CandidateSummary,
    pub timestamp_epoch_ms: u64,
}

/// Aggregate statistics from the history log.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryStats {
    pub total: usize,
    pub promoted: usize,
    pub rolled_back: usize,
    pub discarded: usize,
    pub avg_age_ms: u64,
    pub promotion_rate: f64,
}

/// Bounded candidate history log.
pub struct CandidateHistory {
    entries: VecDeque<HistoryEntry>,
    max_entries: usize,
}

impl CandidateHistory {
    pub fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries: MAX_HISTORY,
        }
    }

    pub fn with_capacity(max: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(max.min(MAX_HISTORY)),
            max_entries: max.min(MAX_HISTORY),
        }
    }

    /// Record a completed candidate.
    pub fn record(&mut self, summary: CandidateSummary, timestamp_epoch_ms: u64) {
        if self.entries.len() >= self.max_entries {
            self.entries.pop_front();
        }
        self.entries.push_back(HistoryEntry {
            summary,
            timestamp_epoch_ms,
        });
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// All entries (oldest first).
    pub fn entries(&self) -> impl Iterator<Item = &HistoryEntry> {
        self.entries.iter()
    }

    /// Entries for a specific preview session.
    pub fn for_preview<'a>(&'a self, preview_id: &'a str) -> impl Iterator<Item = &'a HistoryEntry> + 'a {
        self.entries
            .iter()
            .filter(move |e| e.summary.preview_id == preview_id)
    }

    /// Entries that ended in a specific state.
    pub fn by_state(&self, state: CandidateState) -> impl Iterator<Item = &HistoryEntry> + '_ {
        self.entries.iter().filter(move |e| e.summary.state == state)
    }

    /// Entries within a time range.
    pub fn in_range(
        &self,
        start_ms: u64,
        end_ms: u64,
    ) -> impl Iterator<Item = &HistoryEntry> + '_ {
        self.entries
            .iter()
            .filter(move |e| e.timestamp_epoch_ms >= start_ms && e.timestamp_epoch_ms <= end_ms)
    }

    /// Last N entries.
    pub fn last_n(&self, n: usize) -> Vec<&HistoryEntry> {
        self.entries.iter().rev().take(n).collect()
    }

    /// Aggregate statistics.
    pub fn stats(&self) -> HistoryStats {
        if self.entries.is_empty() {
            return HistoryStats::default();
        }

        let total = self.entries.len();
        let promoted = self
            .entries
            .iter()
            .filter(|e| e.summary.state == CandidateState::Promoted)
            .count();
        let rolled_back = self
            .entries
            .iter()
            .filter(|e| e.summary.state == CandidateState::RolledBack)
            .count();
        let discarded = self
            .entries
            .iter()
            .filter(|e| e.summary.state == CandidateState::Discarded)
            .count();

        let total_age: u64 = self.entries.iter().map(|e| e.summary.age_ms).sum();
        let avg_age_ms = total_age / total as u64;
        let promotion_rate = promoted as f64 / total as f64;

        HistoryStats {
            total,
            promoted,
            rolled_back,
            discarded,
            avg_age_ms,
            promotion_rate,
        }
    }

    /// Clear history.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl Default for CandidateHistory {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(preview: &str, gen: u64, state: CandidateState, age: u64) -> CandidateSummary {
        CandidateSummary {
            preview_id: preview.into(),
            generation: gen,
            artifact_hash: format!("h{gen}"),
            state,
            decision: "WarmReload".into(),
            rollback_reason: None,
            age_ms: age,
        }
    }

    #[test]
    fn record_and_query() {
        let mut h = CandidateHistory::new();
        h.record(summary("p1", 1, CandidateState::Promoted, 200), 1000);
        h.record(summary("p1", 2, CandidateState::RolledBack, 300), 2000);
        h.record(summary("p2", 1, CandidateState::Promoted, 150), 3000);

        assert_eq!(h.len(), 3);
        assert_eq!(h.for_preview("p1").count(), 2);
        assert_eq!(h.by_state(CandidateState::Promoted).count(), 2);
    }

    #[test]
    fn stats() {
        let mut h = CandidateHistory::new();
        h.record(summary("p1", 1, CandidateState::Promoted, 200), 1000);
        h.record(summary("p1", 2, CandidateState::Promoted, 400), 2000);
        h.record(summary("p1", 3, CandidateState::RolledBack, 300), 3000);

        let stats = h.stats();
        assert_eq!(stats.total, 3);
        assert_eq!(stats.promoted, 2);
        assert_eq!(stats.rolled_back, 1);
        assert_eq!(stats.avg_age_ms, 300);
        assert!((stats.promotion_rate - 0.6667).abs() < 0.01);
    }

    #[test]
    fn bounded() {
        let mut h = CandidateHistory::with_capacity(3);
        for i in 0..5 {
            h.record(summary("p1", i, CandidateState::Promoted, 100), i * 1000);
        }
        assert_eq!(h.len(), 3);
        // Oldest two should be evicted
        let first = h.entries().next().unwrap();
        assert_eq!(first.summary.generation, 2);
    }
}
