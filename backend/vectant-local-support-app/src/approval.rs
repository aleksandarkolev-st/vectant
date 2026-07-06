use std::collections::HashMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audit::ConsentReceipt;
use crate::policy::Classification;
use crate::workspace::{FileReadRequest, FileReadResponse};

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
            },
        );
        public_response
    }

    pub fn approve(&mut self, approval_id: &str) -> Option<(FileReadResponse, ConsentReceipt)> {
        let queued = self.pending.get_mut(approval_id)?;
        if queued.status != ApprovalStatus::Pending {
            return None;
        }
        queued.status = ApprovalStatus::Approved;
        let mut review = queued.local_review.clone();
        review.approval_id = Some(queued.approval_id.clone());
        let receipt = ConsentReceipt {
            approval_id: queued.approval_id.clone(),
            request_id: queued.request.request_id.clone(),
            session_id: queued.request.session_id.clone(),
            actor: queued.request.actor.clone(),
            capability: queued.request.capability.clone(),
            target_display: review.path_display.clone(),
            classification: review.classification.clone(),
            content_sha256: review.content_sha256.clone(),
            scope: "once".to_string(),
            granted_at: Utc::now(),
            expires_at: queued.request.expires_at.clone(),
            policy_version: review.policy_version.clone(),
            scanner_version: review.scanner_version.clone(),
        };
        Some((review, receipt))
    }

    pub fn deny(&mut self, approval_id: &str) -> bool {
        let Some(queued) = self.pending.get_mut(approval_id) else {
            return false;
        };
        queued.status = ApprovalStatus::Denied;
        queued.local_review.content = None;
        true
    }

    pub fn revoke_all(&mut self) {
        for queued in self.pending.values_mut() {
            if queued.status == ApprovalStatus::Pending {
                queued.status = ApprovalStatus::Revoked;
                queued.local_review.content = None;
            }
        }
    }

    pub fn pending_len(&self) -> usize {
        self.pending
            .values()
            .filter(|queued| queued.status == ApprovalStatus::Pending)
            .count()
    }

    pub fn get(&self, approval_id: &str) -> Option<&QueuedApproval> {
        self.pending.get(approval_id)
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

pub fn denied_approval_response(request_id: &str, approval_id: &str) -> FileReadResponse {
    FileReadResponse {
        request_id: request_id.to_string(),
        approval_id: Some(approval_id.to_string()),
        decision: "denied".to_string(),
        path_display: approval_id.to_string(),
        classification: Classification::L5,
        bytes_sent: 0,
        content_sha256: None,
        redactions: Vec::new(),
        scanner_version: crate::SCANNER_VERSION.to_string(),
        policy_version: crate::POLICY_VERSION.to_string(),
        user_visible_message: Some("Approval was denied or no longer pending. Nothing was sent.".to_string()),
        content: None,
    }
}
