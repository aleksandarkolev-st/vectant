// ============================================================
// ROLLBACK NOTIFICATION
// ============================================================
// Produces a serializable notification when a candidate is
// rolled back, for dispatch to the frontend over WebRTC.
// ============================================================

use serde::Serialize;

use crate::hmr::candidate::{Candidate, CandidateState};

/// Notification sent to the frontend when a reload is rolled back.
#[derive(Debug, Clone, Serialize)]
pub struct RollbackNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub status: &'static str,
    pub preview_id: String,
    pub generation: u64,
    pub artifact_set_identity: String,
    pub reason: String,
    pub reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message: Option<String>,
}

impl RollbackNotification {
    /// Create a rollback notification from a rolled-back candidate.
    pub fn from_candidate(candidate: &Candidate) -> Option<Self> {
        if candidate.state != CandidateState::RolledBack {
            return None;
        }

        let reason = candidate
            .rollback_reason
            .clone()
            .unwrap_or_else(|| "unknown".into());

        let reason_code = classify_rollback_reason(&reason);

        Some(Self {
            msg_type: "hmr-status",
            status: "rejected",
            preview_id: candidate.id().preview_id().to_string(),
            generation: candidate.id().generation(),
            artifact_set_identity: candidate.id().artifact_set_identity().to_string(),
            reason: reason.clone(),
            reason_code,
            user_message: Some(format!("Reload rolled back: {}", reason)),
        })
    }
}

/// Map human-readable reasons to telemetry reason codes.
fn classify_rollback_reason(reason: &str) -> String {
    let lower = reason.to_lowercase();
    if lower.contains("abi") || lower.contains("incompatible") {
        "abi_incompatible".into()
    } else if lower.contains("crash") || lower.contains("segfault") || lower.contains("sigsegv") {
        "candidate_crash".into()
    } else if lower.contains("schema") || lower.contains("migration") {
        "schema_mismatch".into()
    } else if lower.contains("symbol") || lower.contains("missing") {
        "symbol_missing".into()
    } else if lower.contains("timeout") || lower.contains("health") {
        "health_timeout".into()
    } else {
        "unknown".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    const ARTIFACT_HASH: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn test_manifest() -> BuildManifest {
        BuildManifest::new(
            "preview",
            "open-vocabulary-label",
            "observed-mechanism",
            0,
            BuildSlot::Custom("opaque-transaction".into()),
            "/build/output.bin",
            ARTIFACT_HASH,
        )
    }

    #[test]
    fn rollback_notification() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        )
        .unwrap();
        let expected_identity = c.id().artifact_set_identity().to_string();
        c.rollback("ABI incompatible: missing symbol");
        let notif = RollbackNotification::from_candidate(&c).unwrap();
        assert_eq!(notif.status, "rejected");
        assert_eq!(notif.reason_code, "abi_incompatible");
        assert_eq!(notif.artifact_set_identity, expected_identity);
    }

    #[test]
    fn no_notification_for_promoted() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        )
        .unwrap();
        c.promote();
        assert!(RollbackNotification::from_candidate(&c).is_none());
    }

    #[test]
    fn crash_reason_classification() {
        assert_eq!(
            classify_rollback_reason("segfault in init()"),
            "candidate_crash"
        );
        assert_eq!(
            classify_rollback_reason("health check timeout"),
            "health_timeout"
        );
        assert_eq!(
            classify_rollback_reason("schema migration failed"),
            "schema_mismatch"
        );
    }
}
