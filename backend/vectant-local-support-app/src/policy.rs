use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Classification {
    L0,
    L1,
    L2,
    L3,
    L4,
    L5,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecisionKind {
    Allow,
    Deny,
    ApprovalRequired,
    RedactThenApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredApproval {
    pub scope: ApprovalScope,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalScope {
    Once,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecision {
    pub decision: DecisionKind,
    pub reason: String,
    pub classification: Classification,
    pub required_approval: Option<RequiredApproval>,
    pub redaction_required: bool,
    pub log_user_visible: bool,
}

impl PolicyDecision {
    pub fn deny(reason: impl Into<String>, classification: Classification) -> Self {
        Self {
            decision: DecisionKind::Deny,
            reason: reason.into(),
            classification,
            required_approval: None,
            redaction_required: false,
            log_user_visible: true,
        }
    }

    pub fn allow(reason: impl Into<String>, classification: Classification) -> Self {
        Self {
            decision: DecisionKind::Allow,
            reason: reason.into(),
            classification,
            required_approval: None,
            redaction_required: false,
            log_user_visible: true,
        }
    }

    pub fn approval(
        reason: impl Into<String>,
        classification: Classification,
        message: impl Into<String>,
    ) -> Self {
        Self {
            decision: DecisionKind::ApprovalRequired,
            reason: reason.into(),
            classification,
            required_approval: Some(RequiredApproval {
                scope: ApprovalScope::Once,
                message: message.into(),
            }),
            redaction_required: false,
            log_user_visible: true,
        }
    }

    pub fn redact_then_approval(
        reason: impl Into<String>,
        classification: Classification,
        message: impl Into<String>,
    ) -> Self {
        Self {
            decision: DecisionKind::RedactThenApproval,
            reason: reason.into(),
            classification,
            required_approval: Some(RequiredApproval {
                scope: ApprovalScope::Once,
                message: message.into(),
            }),
            redaction_required: true,
            log_user_visible: true,
        }
    }
}
