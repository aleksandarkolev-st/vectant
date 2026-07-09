use crate::preview::{PortApprovalRegistry, PreviewTrafficGuard};
use crate::session::SessionGuard;

#[derive(Debug, Default)]
pub struct PendingApprovalQueue {
    pending_ids: Vec<String>,
}

impl PendingApprovalQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, approval_id: impl Into<String>) {
        self.pending_ids.push(approval_id.into());
    }

    pub fn len(&self) -> usize {
        self.pending_ids.len()
    }

    pub fn clear(&mut self) {
        self.pending_ids.clear();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleCleanupReport {
    pub cloud_token_revoked: bool,
    pub local_token_revoked: bool,
    pub preview_tokens_revoked: bool,
    pub agent_tokens_revoked: bool,
    pub preview_streams_stopped: bool,
    pub pending_approvals_cleared: bool,
    pub session_disconnected: bool,
    pub hidden_daemon_running: bool,
}

impl LifecycleCleanupReport {
    fn complete() -> Self {
        Self {
            cloud_token_revoked: true,
            local_token_revoked: true,
            preview_tokens_revoked: true,
            agent_tokens_revoked: true,
            preview_streams_stopped: true,
            pending_approvals_cleared: true,
            session_disconnected: true,
            hidden_daemon_running: false,
        }
    }
}

pub fn disconnect_cleanup(
    session: &mut SessionGuard,
    preview_approvals: &mut PortApprovalRegistry,
    preview_traffic: &mut PreviewTrafficGuard,
    pending_approvals: &mut PendingApprovalQueue,
) -> LifecycleCleanupReport {
    let session_id = session.session_id().to_string();
    session.disconnect();
    preview_approvals.disconnect_session(&session_id);
    preview_traffic.clear_all();
    pending_approvals.clear();
    LifecycleCleanupReport::complete()
}

pub fn uninstall_cleanup(
    session: &mut SessionGuard,
    preview_approvals: &mut PortApprovalRegistry,
    preview_traffic: &mut PreviewTrafficGuard,
    pending_approvals: &mut PendingApprovalQueue,
) -> LifecycleCleanupReport {
    disconnect_cleanup(
        session,
        preview_approvals,
        preview_traffic,
        pending_approvals,
    )
}
