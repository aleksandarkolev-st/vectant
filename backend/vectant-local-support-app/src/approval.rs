use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::audit::ConsentReceipt;
use crate::policy::Classification;
use crate::workspace::{FileReadRequest, FileReadResponse};

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalReviewSummary {
    pub approval_id: String,
    pub request_id: String,
    pub actor: String,
    pub reason: String,
    pub capability: String,
    pub target_display: String,
    pub classification: Classification,
    pub expires_at: String,
    pub content_sha256: Option<String>,
    pub redactions: Vec<String>,
    pub redacted_preview: String,
    pub bytes_sent: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedApproval {
    pub approval_id: String,
    pub request: FileReadRequest,
    pub local_review: FileReadResponse,
    pub status: ApprovalStatus,
    #[serde(skip)]
    local_approval_secret_hash: String,
}

#[derive(Debug, Default)]
pub struct ApprovalQueue {
    pending: HashMap<String, QueuedApproval>,
}

impl ApprovalQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn queue_file_review(
        &mut self,
        request: FileReadRequest,
        local_review: FileReadResponse,
    ) -> FileReadResponse {
        if local_review.decision == "denied" {
            return local_review;
        }

        let approval_id = format!("appr_{}", Uuid::new_v4());
        let public_response = public_pending_response(&local_review, &approval_id);
        self.pending.insert(
            approval_id.clone(),
            QueuedApproval {
                approval_id,
                request,
                local_review,
                status: ApprovalStatus::Pending,
                local_approval_secret_hash: hash_local_approval_secret(
                    &generate_local_approval_secret(),
                ),
            },
        );
        public_response
    }

    pub fn approve(&mut self, approval_id: &str) -> Option<(FileReadResponse, ConsentReceipt)> {
        if !is_safe_approval_id(approval_id) {
            return None;
        }
        self.approve_at(approval_id, Utc::now())
    }

    pub fn approve_with_secret(
        &mut self,
        approval_id: &str,
        local_approval_secret: &str,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        if !is_safe_approval_id(approval_id) {
            return None;
        }
        self.approve_with_secret_at(approval_id, local_approval_secret, Utc::now())
    }

    pub fn approve_with_secret_at(
        &mut self,
        approval_id: &str,
        local_approval_secret: &str,
        now: DateTime<Utc>,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        if !self.local_approval_secret_matches(approval_id, local_approval_secret) {
            return None;
        }
        self.approve_at(approval_id, now)
    }

    pub fn approve_with_secret_and_current_review(
        &mut self,
        approval_id: &str,
        local_approval_secret: &str,
        current_review: FileReadResponse,
        now: DateTime<Utc>,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        if !self.local_approval_secret_matches(approval_id, local_approval_secret) {
            return None;
        }
        self.approve_revalidated_at(approval_id, current_review, now)
    }

    pub fn approve_at(
        &mut self,
        approval_id: &str,
        now: DateTime<Utc>,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        self.approve_at_inner(approval_id, now, None, ApprovalStatus::Pending)
    }

    pub fn approve_revalidated_at(
        &mut self,
        approval_id: &str,
        current_review: FileReadResponse,
        now: DateTime<Utc>,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        self.approve_at_inner(
            approval_id,
            now,
            Some(current_review),
            ApprovalStatus::Pending,
        )
    }

    pub fn release_granted_at(
        &mut self,
        approval_id: &str,
        current_review: FileReadResponse,
        now: DateTime<Utc>,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        self.approve_at_inner(
            approval_id,
            now,
            Some(current_review),
            ApprovalStatus::Approved,
        )
    }

    fn approve_at_inner(
        &mut self,
        approval_id: &str,
        now: DateTime<Utc>,
        current_review: Option<FileReadResponse>,
        required_status: ApprovalStatus,
    ) -> Option<(FileReadResponse, ConsentReceipt)> {
        if !is_safe_approval_id(approval_id) {
            return None;
        }
        let mut queued = self.pending.remove(approval_id)?;
        if queued.status != required_status {
            return None;
        }
        let expires_at = DateTime::parse_from_rfc3339(&queued.request.expires_at)
            .ok()?
            .with_timezone(&Utc);
        if expires_at <= now {
            queued.local_review.content = None;
            return None;
        }
        queued.status = ApprovalStatus::Approved;
        let mut review = match current_review {
            Some(current) if review_still_matches(&queued.local_review, &current) => current,
            Some(_) => return None,
            None => queued.local_review.clone(),
        };
        review.approval_id = Some(queued.approval_id.clone());
        let receipt = ConsentReceipt {
            approval_id: queued.approval_id.clone(),
            request_id: queued.request.request_id.clone(),
            session_id: queued.request.session_id.clone(),
            account_id: queued.request.account_id.clone(),
            org_id: queued.request.org_id.clone(),
            workspace_id: queued.request.workspace_id.clone(),
            device_fingerprint: queued.request.device_fingerprint.clone(),
            actor: queued.request.actor.clone(),
            capability: queued.request.capability.clone(),
            target_display: review.path_display.clone(),
            classification: review.classification.clone(),
            content_sha256: review.content_sha256.clone(),
            scope: "once".to_string(),
            granted_at: now,
            expires_at: queued.request.expires_at.clone(),
            policy_version: review.policy_version.clone(),
            scanner_version: review.scanner_version.clone(),
            bytes_sent: 0,
            redaction_count: review.redactions.len(),
        };
        Some((review, receipt))
    }

    pub fn deny(&mut self, approval_id: &str) -> bool {
        if !is_safe_approval_id(approval_id) {
            return false;
        }
        let Some(queued) = self.pending.get_mut(approval_id) else {
            return false;
        };
        queued.status = ApprovalStatus::Denied;
        queued.local_review.content = None;
        true
    }

    pub fn grant_for_local_release(&mut self, approval_id: &str) -> bool {
        if !is_safe_approval_id(approval_id) {
            return false;
        }
        let Some(queued) = self.pending.get_mut(approval_id) else {
            return false;
        };
        let unexpired = DateTime::parse_from_rfc3339(&queued.request.expires_at)
            .map(|expires| expires.with_timezone(&Utc) > Utc::now())
            .unwrap_or(false);
        if queued.status != ApprovalStatus::Pending || queued.local_review.content.is_none() {
            return false;
        }
        if !unexpired {
            queued.local_review.content = None;
            return false;
        }
        queued.status = ApprovalStatus::Approved;
        true
    }

    pub fn pending_review_summaries(&self) -> Vec<ApprovalReviewSummary> {
        let mut summaries = self
            .pending
            .values()
            .filter(|queued| queued.status == ApprovalStatus::Pending)
            .map(|queued| ApprovalReviewSummary {
                approval_id: queued.approval_id.clone(),
                request_id: queued.request.request_id.clone(),
                actor: queued.request.actor.clone(),
                reason: queued.request.reason.clone(),
                capability: queued.request.capability.clone(),
                target_display: queued.local_review.path_display.clone(),
                classification: queued.local_review.classification.clone(),
                expires_at: queued.request.expires_at.clone(),
                content_sha256: queued.local_review.content_sha256.clone(),
                redactions: queued.local_review.redactions.clone(),
                redacted_preview: queued.local_review.content.clone().unwrap_or_default(),
                bytes_sent: 0,
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| left.approval_id.cmp(&right.approval_id));
        summaries
    }

    pub fn deny_with_secret(&mut self, approval_id: &str, local_approval_secret: &str) -> bool {
        if !is_safe_approval_id(approval_id) {
            return false;
        }
        if !self.local_approval_secret_matches(approval_id, local_approval_secret) {
            return false;
        }
        self.deny(approval_id)
    }

    pub fn revoke_all(&mut self) {
        for queued in self.pending.values_mut() {
            if matches!(
                queued.status,
                ApprovalStatus::Pending | ApprovalStatus::Approved
            ) {
                queued.status = ApprovalStatus::Revoked;
                queued.local_review.content = None;
            }
        }
    }

    pub fn request_for_approval(&self, approval_id: &str) -> Option<FileReadRequest> {
        if !is_safe_approval_id(approval_id) {
            return None;
        }
        let queued = self.pending.get(approval_id)?;
        if queued.status != ApprovalStatus::Pending {
            return None;
        }
        Some(queued.request.clone())
    }

    pub fn pending_len(&self) -> usize {
        self.pending
            .values()
            .filter(|queued| queued.status == ApprovalStatus::Pending)
            .count()
    }

    pub fn get(&self, approval_id: &str) -> Option<&QueuedApproval> {
        if !is_safe_approval_id(approval_id) {
            return None;
        }
        self.pending.get(approval_id)
    }

    pub fn set_local_approval_secret_for_test(
        &mut self,
        approval_id: &str,
        local_approval_secret: &str,
    ) -> bool {
        if !is_safe_approval_id(approval_id) {
            return false;
        }
        let Some(queued) = self.pending.get_mut(approval_id) else {
            return false;
        };
        queued.local_approval_secret_hash = hash_local_approval_secret(local_approval_secret);
        true
    }

    fn local_approval_secret_matches(
        &self,
        approval_id: &str,
        local_approval_secret: &str,
    ) -> bool {
        if !is_safe_approval_id(approval_id) {
            return false;
        }
        let Some(queued) = self.pending.get(approval_id) else {
            return false;
        };
        !local_approval_secret.is_empty()
            && constant_time_eq(
                queued.local_approval_secret_hash.as_bytes(),
                hash_local_approval_secret(local_approval_secret).as_bytes(),
            )
    }
}

fn public_pending_response(local_review: &FileReadResponse, approval_id: &str) -> FileReadResponse {
    FileReadResponse {
        request_id: local_review.request_id.clone(),
        approval_id: Some(approval_id.to_string()),
        decision: "approval_queued".to_string(),
        path_display: local_review.path_display.clone(),
        classification: local_review.classification.clone(),
        bytes_sent: 0,
        content_sha256: local_review.content_sha256.clone(),
        redactions: local_review.redactions.clone(),
        scanner_version: local_review.scanner_version.clone(),
        policy_version: local_review.policy_version.clone(),
        user_visible_message: Some(
            "Queued for local review. No file content was sent before approval.".to_string(),
        ),
        content: None,
    }
}

fn review_still_matches(original: &FileReadResponse, current: &FileReadResponse) -> bool {
    current.decision != "denied"
        && current.content.is_some()
        && original.content_sha256.is_some()
        && original.content_sha256 == current.content_sha256
}

pub fn denied_approval_response(request_id: &str, approval_id: &str) -> FileReadResponse {
    let path_display = if is_safe_approval_id(approval_id) {
        approval_id.to_string()
    } else {
        "approval_request".to_string()
    };
    FileReadResponse {
        request_id: request_id.to_string(),
        approval_id: Some(path_display.clone()),
        decision: "denied".to_string(),
        path_display,
        classification: Classification::L5,
        bytes_sent: 0,
        content_sha256: None,
        redactions: Vec::new(),
        scanner_version: crate::SCANNER_VERSION.to_string(),
        policy_version: crate::POLICY_VERSION.to_string(),
        user_visible_message: Some(
            "Approval was denied or no longer pending. Nothing was sent.".to_string(),
        ),
        content: None,
    }
}

pub fn is_safe_approval_id(value: &str) -> bool {
    value.starts_with("appr_")
        && value.len() <= 64
        && value.len() >= "appr_".len() + 8
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn generate_local_approval_secret() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn hash_local_approval_secret(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-local-approval-secret:");
    hasher.update(value.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
