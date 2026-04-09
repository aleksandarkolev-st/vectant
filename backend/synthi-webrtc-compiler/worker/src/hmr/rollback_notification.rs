// ============================================================
// ROLLBACK NOTIFICATION
// ============================================================
// Produces a serializable notification when a candidate is
// rolled back, for dispatch to the frontend over WebRTC.
// ============================================================

use serde::Serialize;

use crate::hmr::candidate::{Candidate, CandidateState};
use crate::hmr::health_check::HealthCheckResult;

/// Notification sent to the frontend when a reload is rolled back.
#[derive(Debug, Clone, Serialize)]
pub struct RollbackNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub status: &'static str,
    pub preview_id: String,
    pub generation: u64,
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
            preview_id: candidate.id.preview_id.clone(),
            generation: candidate.id.generation,
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
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn test_manifest() -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/t.so".into(),
            artifact_hash: "h".into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 0,
            extension: Default::default(),
        }
    }

    #[test]
    fn rollback_notification() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        c.rollback("ABI incompatible: missing symbol");
        let notif = RollbackNotification::from_candidate(&c).unwrap();
        assert_eq!(notif.status, "rejected");
        assert_eq!(notif.reason_code, "abi_incompatible");
    }

    #[test]
    fn no_notification_for_promoted() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        c.promote();
        assert!(RollbackNotification::from_candidate(&c).is_none());
    }

    #[test]
    fn crash_reason_classification() {
        assert_eq!(classify_rollback_reason("segfault in init()"), "candidate_crash");
        assert_eq!(classify_rollback_reason("health check timeout"), "health_timeout");
        assert_eq!(classify_rollback_reason("schema migration failed"), "schema_mismatch");
    }
}
