//! Full Access support policy primitives.
//!
//! This module deliberately models the privileged mode separately from the
//! review-first path.  It contains no renderer-facing secrets and defaults to
//! deny for unknown capabilities, fields, scopes, stale receipts, and budget
//! exhaustion.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FULL_ACCESS_POLICY_MAJOR: u16 = 1;
pub const MAX_GRAPH_NODE_BYTES: u64 = 262_144;
pub const MAX_GRAPH_NODES: usize = 20_000;
pub const MAX_PROCESS_RECORDS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullAccessCapability {
    Enroll,
    AutoApprovalEnable,
    GraphRead,
    GraphNodeRequest,
    CommandExecute,
    CommandContextRead,
    WorkspaceFileMutate,
    WorkspaceFileRevert,
    ProcessInventory,
    ProcessListenerMetadata,
    LocalPortDiscover,
    LocalPortUse,
}

impl FullAccessCapability {
    pub fn wire_name(&self) -> &'static str {
        match self {
            Self::Enroll => "support.full_access.enroll",
            Self::AutoApprovalEnable => "support.auto_approval.enable",
            Self::GraphRead => "support.full_access.graph.read",
            Self::GraphNodeRequest => "support.full_access.graph.node.request",
            Self::CommandExecute => "support.full_access.command.execute",
            Self::CommandContextRead => "support.full_access.command.context.read",
            Self::WorkspaceFileMutate => "support.full_access.workspace.file.mutate",
            Self::WorkspaceFileRevert => "support.full_access.workspace.file.revert",
            Self::ProcessInventory => "support.full_access.process.inventory",
            Self::ProcessListenerMetadata => "support.full_access.process.listener_metadata",
            Self::LocalPortDiscover => "support.full_access.local_port.discover",
            Self::LocalPortUse => "support.full_access.local_port.use",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskClass {
    A,
    B,
    C,
    D,
    E,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullAccessPolicy {
    pub organization_enabled: bool,
    pub emergency_paused: bool,
    pub mandatory_reconsent_version: u32,
    pub policy_major: u16,
    pub allowed_capabilities: BTreeSet<FullAccessCapability>,
    pub allowed_actors: BTreeSet<String>,
    pub max_bytes_per_request: u64,
    pub max_bytes_per_session: u64,
    pub max_requests_per_minute: u32,
    pub max_concurrent_reads: u16,
    pub max_process_records: usize,
    pub allowed_command_executables: BTreeSet<String>,
    pub max_command_timeout_seconds: u64,
    pub max_command_output_bytes: usize,
    pub max_command_concurrency: u16,
    pub allowed_loopback_ports: BTreeSet<u16>,
}

impl Default for FullAccessPolicy {
    fn default() -> Self {
        Self {
            organization_enabled: false,
            emergency_paused: false,
            mandatory_reconsent_version: 1,
            policy_major: FULL_ACCESS_POLICY_MAJOR,
            allowed_capabilities: BTreeSet::new(),
            allowed_actors: BTreeSet::new(),
            max_bytes_per_request: MAX_GRAPH_NODE_BYTES,
            max_bytes_per_session: 2 * 1024 * 1024,
            max_requests_per_minute: 30,
            max_concurrent_reads: 2,
            max_process_records: MAX_PROCESS_RECORDS,
            allowed_command_executables: BTreeSet::new(),
            max_command_timeout_seconds: 60,
            max_command_output_bytes: 65_536,
            max_command_concurrency: 1,
            allowed_loopback_ports: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullAccessConsentReceipt {
    pub consent_id: String,
    pub session_id: String,
    pub account_id: String,
    pub organization_id: String,
    pub support_actor: String,
    pub device_fingerprint: String,
    pub workspace_hash: String,
    pub capabilities: BTreeSet<FullAccessCapability>,
    pub auto_approval_enabled: bool,
    pub policy_version: String,
    pub scanner_version: String,
    pub app_version: String,
    pub policy_major: u16,
    // Legacy receipts deserialize for audit/export continuity, but version 0
    // cannot satisfy the current policy's mandatory re-consent version.
    #[serde(default)]
    pub reconsent_version: u32,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub paused_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub local_confirmation: String,
}

impl FullAccessConsentReceipt {
    pub fn is_active_for(
        &self,
        binding: &ReceiptBinding<'_>,
        now: DateTime<Utc>,
    ) -> Result<(), FullAccessDenied> {
        if self.paused_at.is_some() || self.revoked_at.is_some() || now >= self.expires_at {
            return Err(FullAccessDenied::ConsentInactive);
        }
        if self.session_id != binding.session_id
            || self.account_id != binding.account_id
            || self.organization_id != binding.organization_id
            || self.support_actor != binding.actor
            || self.device_fingerprint != binding.device_fingerprint
            || self.workspace_hash != binding.workspace_hash
            || self.policy_version != binding.policy_version
            || self.scanner_version != binding.scanner_version
            || self.app_version != binding.app_version
            || self.policy_major != binding.policy_major
            || self.reconsent_version != binding.reconsent_version
        {
            return Err(FullAccessDenied::ReceiptBindingMismatch);
        }
        if !self.capabilities.contains(&binding.capability) {
            return Err(FullAccessDenied::CapabilityDenied);
        }
        Ok(())
    }
}

pub struct ReceiptBinding<'a> {
    pub session_id: &'a str,
    pub account_id: &'a str,
    pub organization_id: &'a str,
    pub actor: &'a str,
    pub device_fingerprint: &'a str,
    pub workspace_hash: &'a str,
    pub policy_version: &'a str,
    pub scanner_version: &'a str,
    pub app_version: &'a str,
    pub policy_major: u16,
    pub reconsent_version: u32,
    pub capability: FullAccessCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FullAccessBudget {
    pub bytes_sent: u64,
    pub requests_this_minute: u32,
    pub active_reads: u16,
    pub active_commands: u16,
    pub paused: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FullAccessState {
    pub policy: FullAccessPolicy,
    pub receipt: Option<FullAccessConsentReceipt>,
    pub graph: HashMap<String, GraphNode>,
    pub budget: FullAccessBudget,
    pub process_visibility_paused: bool,
    pub command_cancel: Arc<AtomicBool>,
}

impl FullAccessState {
    pub fn revoke(&mut self) {
        self.command_cancel.store(true, Ordering::Release);
        if let Some(receipt) = &mut self.receipt {
            receipt.revoked_at = Some(Utc::now());
        }
        self.graph.clear();
        self.budget.paused = true;
        self.process_visibility_paused = true;
    }

    pub fn pause(&mut self) {
        self.command_cancel.store(true, Ordering::Release);
        if let Some(receipt) = &mut self.receipt {
            receipt.paused_at = Some(Utc::now());
        }
        self.budget.paused = true;
        self.process_visibility_paused = true;
    }
}
impl FullAccessBudget {
    pub fn reserve(
        &mut self,
        policy: &FullAccessPolicy,
        bytes: u64,
    ) -> Result<(), FullAccessDenied> {
        if self.paused
            || bytes > policy.max_bytes_per_request
            || self.bytes_sent.saturating_add(bytes) > policy.max_bytes_per_session
            || self.requests_this_minute >= policy.max_requests_per_minute
        {
            self.paused = true;
            return Err(FullAccessDenied::BudgetExhausted);
        }
        self.bytes_sent += bytes;
        self.requests_this_minute += 1;
        Ok(())
    }
    pub fn finish_read(&mut self) {
        self.active_reads = self.active_reads.saturating_sub(1);
    }

    pub fn reserve_command(&mut self, policy: &FullAccessPolicy) -> Result<(), FullAccessDenied> {
        if self.paused || self.active_commands >= policy.max_command_concurrency {
            return Err(FullAccessDenied::BudgetExhausted);
        }
        self.active_commands += 1;
        Ok(())
    }

    pub fn finish_command(&mut self) {
        self.active_commands = self.active_commands.saturating_sub(1);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeState {
    Available,
    AutoRequestable,
    LocallyRedacted,
    Blocked,
    Expired,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub node_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub size: u64,
    pub classification: RiskClass,
    pub state: GraphNodeState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRequest {
    pub request_id: String,
    pub node_id: String,
    pub expected_content_hash: String,
    pub field: String,
    pub range_start: Option<u64>,
    pub range_end: Option<u64>,
    pub max_bytes: u64,
    pub reason: String,
}

pub fn validate_graph_request(
    nodes: &HashMap<String, GraphNode>,
    request: &GraphRequest,
    policy: &FullAccessPolicy,
) -> Result<(), FullAccessDenied> {
    if request.request_id.len() < 3
        || request.request_id.len() > 128
        || request.node_id.is_empty()
        || request.reason.trim().is_empty()
        || request.max_bytes == 0
        || request.max_bytes > policy.max_bytes_per_request
        || !matches!(
            request.field.as_str(),
            "content" | "metadata" | "symbols" | "diagnostic"
        )
    {
        return Err(FullAccessDenied::MalformedRequest);
    }
    let node = nodes
        .get(&request.node_id)
        .ok_or(FullAccessDenied::UnknownGraphNode)?;
    if !matches!(
        node.state,
        GraphNodeState::Available | GraphNodeState::AutoRequestable
    ) || node.content_hash != request.expected_content_hash
    {
        return Err(FullAccessDenied::StaleTarget);
    }
    if node.classification == RiskClass::E {
        return Err(FullAccessDenied::SensitiveTarget);
    }
    if let (Some(start), Some(end)) = (request.range_start, request.range_end) {
        if start >= end || end > node.size {
            return Err(FullAccessDenied::MalformedRequest);
        }
    }
    Ok(())
}

pub fn safe_workspace_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.is_empty()
        && !path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SanitizedProcessRecord {
    pub identity_hash: String,
    pub executable_name: String,
    pub category: String,
    pub age_seconds: u64,
    pub loopback_ports: Vec<u16>,
    pub bind_address_class: String,
    pub workspace_related: bool,
    pub inclusion_reason: String,
    pub freshness_ms: u64,
}
#[allow(clippy::too_many_arguments)] // OS adapter fields are independently sanitized at this boundary.
pub fn sanitized_process_record(
    identity_material: &str,
    executable_name: &str,
    category: &str,
    age_seconds: u64,
    ports: Vec<u16>,
    workspace_related: bool,
    reason: &str,
    freshness_ms: u64,
) -> Result<SanitizedProcessRecord, FullAccessDenied> {
    if executable_name.contains(['/', '\\'])
        || executable_name.len() > 128
        || ports.contains(&0)
        || reason.len() > 128
    {
        return Err(FullAccessDenied::MalformedRequest);
    }
    let mut h = Sha256::new();
    h.update(b"vectant-process-identity-v1\0");
    h.update(identity_material.as_bytes());
    Ok(SanitizedProcessRecord {
        identity_hash: format!("sha256:{}", hex::encode(h.finalize())),
        executable_name: executable_name.to_string(),
        category: category.to_string(),
        age_seconds,
        loopback_ports: ports,
        bind_address_class: "loopback".to_string(),
        workspace_related,
        inclusion_reason: reason.to_string(),
        freshness_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FullAccessDenied {
    OrganizationDisabled,
    EmergencyPaused,
    CapabilityDenied,
    ActorDenied,
    ConsentInactive,
    ReceiptBindingMismatch,
    BudgetExhausted,
    UnknownGraphNode,
    StaleTarget,
    SensitiveTarget,
    MalformedRequest,
}

pub fn authorize(
    policy: &FullAccessPolicy,
    receipt: &FullAccessConsentReceipt,
    binding: &ReceiptBinding<'_>,
    now: DateTime<Utc>,
) -> Result<(), FullAccessDenied> {
    if !policy.organization_enabled {
        return Err(FullAccessDenied::OrganizationDisabled);
    }
    if policy.emergency_paused {
        return Err(FullAccessDenied::EmergencyPaused);
    }
    if !policy.allowed_capabilities.contains(&binding.capability) {
        return Err(FullAccessDenied::CapabilityDenied);
    }
    if !policy.allowed_actors.contains(binding.actor) {
        return Err(FullAccessDenied::ActorDenied);
    }
    receipt.is_active_for(binding, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn policy() -> FullAccessPolicy {
        let mut policy = FullAccessPolicy {
            organization_enabled: true,
            ..Default::default()
        };
        policy.allowed_actors.insert("support_agent".into());
        policy
            .allowed_capabilities
            .insert(FullAccessCapability::GraphNodeRequest);
        policy
    }

    fn receipt(now: DateTime<Utc>) -> FullAccessConsentReceipt {
        FullAccessConsentReceipt {
            consent_id: "consent_12345678".into(),
            session_id: "sess_12345678".into(),
            account_id: "acct_1".into(),
            organization_id: "org_1".into(),
            support_actor: "support_agent".into(),
            device_fingerprint: "sha256:device".into(),
            workspace_hash: "sha256:workspace".into(),
            capabilities: [FullAccessCapability::GraphNodeRequest]
                .into_iter()
                .collect(),
            auto_approval_enabled: true,
            policy_version: "policy-1".into(),
            scanner_version: "scanner-1".into(),
            app_version: "1.0.0".into(),
            policy_major: FULL_ACCESS_POLICY_MAJOR,
            reconsent_version: 1,
            created_at: now,
            expires_at: now + Duration::minutes(10),
            paused_at: None,
            revoked_at: None,
            local_confirmation: "native_button".into(),
        }
    }

    fn binding() -> ReceiptBinding<'static> {
        ReceiptBinding {
            session_id: "sess_12345678",
            account_id: "acct_1",
            organization_id: "org_1",
            actor: "support_agent",
            device_fingerprint: "sha256:device",
            workspace_hash: "sha256:workspace",
            policy_version: "policy-1",
            scanner_version: "scanner-1",
            app_version: "1.0.0",
            policy_major: FULL_ACCESS_POLICY_MAJOR,
            reconsent_version: 1,
            capability: FullAccessCapability::GraphNodeRequest,
        }
    }

    #[test]
    fn authorization_requires_every_independent_control() {
        let now = Utc::now();
        let policy = policy();
        let receipt = receipt(now);
        let receipt_binding = binding();
        assert!(authorize(&policy, &receipt, &receipt_binding, now).is_ok());
        let mut disabled = policy.clone();
        disabled.organization_enabled = false;
        assert_eq!(
            authorize(&disabled, &receipt, &receipt_binding, now),
            Err(FullAccessDenied::OrganizationDisabled)
        );
        let mut changed = binding();
        changed.workspace_hash = "sha256:other";
        assert_eq!(
            authorize(&policy, &receipt, &changed, now),
            Err(FullAccessDenied::ReceiptBindingMismatch)
        );
        let mut reconsent_changed = binding();
        reconsent_changed.reconsent_version = 2;
        assert_eq!(
            authorize(&policy, &receipt, &reconsent_changed, now),
            Err(FullAccessDenied::ReceiptBindingMismatch)
        );
    }

    #[test]
    fn legacy_receipts_deserialize_for_audit_but_fail_current_reconsent_binding() {
        let now = Utc::now();
        let mut value = serde_json::to_value(receipt(now)).unwrap();
        value.as_object_mut().unwrap().remove("reconsent_version");
        let legacy: FullAccessConsentReceipt = serde_json::from_value(value).unwrap();
        assert_eq!(legacy.reconsent_version, 0);
        assert_eq!(
            authorize(&policy(), &legacy, &binding(), now),
            Err(FullAccessDenied::ReceiptBindingMismatch)
        );
    }

    #[test]
    fn graph_requests_reject_everything_stale_and_sensitive_targets() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "node_a".into(),
            GraphNode {
                node_id: "node_a".into(),
                relative_path: "src/lib.rs".into(),
                content_hash: "sha256:current".into(),
                size: 100,
                classification: RiskClass::B,
                state: GraphNodeState::AutoRequestable,
            },
        );
        let request = GraphRequest {
            request_id: "req_12345678".into(),
            node_id: "node_a".into(),
            expected_content_hash: "sha256:current".into(),
            field: "content".into(),
            range_start: Some(0),
            range_end: Some(20),
            max_bytes: 20,
            reason: "inspect compiler error".into(),
        };
        assert!(validate_graph_request(&nodes, &request, &policy()).is_ok());
        let mut broad = request.clone();
        broad.field = "everything".into();
        assert_eq!(
            validate_graph_request(&nodes, &broad, &policy()),
            Err(FullAccessDenied::MalformedRequest)
        );
        let mut stale = request.clone();
        stale.expected_content_hash = "sha256:old".into();
        assert_eq!(
            validate_graph_request(&nodes, &stale, &policy()),
            Err(FullAccessDenied::StaleTarget)
        );
        nodes.get_mut("node_a").unwrap().classification = RiskClass::E;
        assert_eq!(
            validate_graph_request(&nodes, &request, &policy()),
            Err(FullAccessDenied::SensitiveTarget)
        );
    }

    #[test]
    fn budgets_pause_exactly_at_the_limit_and_process_data_is_sanitized() {
        let mut p = policy();
        p.max_bytes_per_session = 10;
        p.max_bytes_per_request = 10;
        let mut budget = FullAccessBudget::default();
        assert!(budget.reserve(&p, 10).is_ok());
        budget.finish_read();
        assert_eq!(
            budget.reserve(&p, 1),
            Err(FullAccessDenied::BudgetExhausted)
        );
        assert!(budget.paused);
        let mut command_budget = FullAccessBudget::default();
        p.max_command_concurrency = 1;
        assert!(command_budget.reserve_command(&p).is_ok());
        assert_eq!(
            command_budget.reserve_command(&p),
            Err(FullAccessDenied::BudgetExhausted)
        );
        command_budget.finish_command();
        assert!(command_budget.reserve_command(&p).is_ok());
        assert!(sanitized_process_record(
            "pid:10:start:1",
            "server.exe",
            "workspace",
            5,
            vec![3000],
            true,
            "workspace listener",
            20
        )
        .is_ok());
        assert!(matches!(
            sanitized_process_record(
                "pid:10",
                "C:\\secret\\server.exe",
                "workspace",
                5,
                vec![3000],
                true,
                "workspace listener",
                20
            ),
            Err(FullAccessDenied::MalformedRequest)
        ));
        assert!(safe_workspace_relative_path("src/lib.rs"));
        assert!(!safe_workspace_relative_path("../secret"));
    }
}
