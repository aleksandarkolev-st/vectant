// ============================================================
// CANDIDATE STATE NOTIFICATIONS
// ============================================================
// Serializable notification payloads for candidate lifecycle
// events.  These are sent to the frontend via WebRTC data
// channel so the UI can show real-time candidate progress.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::candidate::{CandidateState, CandidateSummary};
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::promotion_policy::PromotionVerdict;

/// Notification event type for candidate lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum CandidateNotification {
    /// A new candidate has been enqueued.
    Enqueued {
        preview_id: String,
        generation: u64,
        artifact_hash: String,
    },

    /// Candidate started loading.
    Loading { preview_id: String, generation: u64 },

    /// Candidate health check started.
    HealthCheckStarted { preview_id: String, generation: u64 },

    /// Health check completed.
    HealthCheckCompleted {
        preview_id: String,
        generation: u64,
        result: HealthCheckResult,
    },

    /// Candidate was promoted to live.
    Promoted {
        preview_id: String,
        generation: u64,
        total_reload_ms: u64,
    },

    /// Candidate was rolled back.
    RolledBack {
        preview_id: String,
        generation: u64,
        reason: String,
    },

    /// Candidate was discarded (superseded or stale).
    Discarded {
        preview_id: String,
        generation: u64,
        reason: String,
    },

    /// Promotion verdict for informational display.
    PromotionDecision {
        preview_id: String,
        generation: u64,
        verdict: PromotionVerdict,
    },
}

impl CandidateNotification {
    /// Convenience: create from a CandidateSummary.
    pub fn from_summary(summary: &CandidateSummary) -> Self {
        match summary.state {
            CandidateState::Promoted => CandidateNotification::Promoted {
                preview_id: summary.preview_id.clone(),
                generation: summary.generation,
                total_reload_ms: summary.age_ms,
            },
            CandidateState::RolledBack => CandidateNotification::RolledBack {
                preview_id: summary.preview_id.clone(),
                generation: summary.generation,
                reason: summary
                    .rollback_reason
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
            },
            CandidateState::Discarded => CandidateNotification::Discarded {
                preview_id: summary.preview_id.clone(),
                generation: summary.generation,
                reason: "superseded".into(),
            },
            _ => CandidateNotification::Loading {
                preview_id: summary.preview_id.clone(),
                generation: summary.generation,
            },
        }
    }

    /// JSON-serialize for WebRTC data channel.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_enqueued() {
        let notif = CandidateNotification::Enqueued {
            preview_id: "p1".into(),
            generation: 1,
            artifact_hash: "abc".into(),
        };
        let json = notif.to_json();
        assert!(json.contains("Enqueued"));
        assert!(json.contains("abc"));
    }

    #[test]
    fn serialize_promoted() {
        let notif = CandidateNotification::Promoted {
            preview_id: "p1".into(),
            generation: 5,
            total_reload_ms: 400,
        };
        let json = notif.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["event"], "Promoted");
        assert_eq!(parsed["data"]["total_reload_ms"], 400);
    }

    #[test]
    fn roundtrip() {
        let notif = CandidateNotification::RolledBack {
            preview_id: "p1".into(),
            generation: 3,
            reason: "health failed".into(),
        };
        let json = notif.to_json();
        let back: CandidateNotification = serde_json::from_str(&json).unwrap();
        match back {
            CandidateNotification::RolledBack { reason, .. } => {
                assert_eq!(reason, "health failed");
            }
            _ => panic!("Wrong variant"),
        }
    }
}
