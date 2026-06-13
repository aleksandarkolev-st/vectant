import type { DojoPermissionLicense, DojoSkill, DojoSkillReadinessLevel } from "../../browser/dojo.js";
import type { DojoCaseLawBindingScope, DojoCaseLawRecord, DojoCaseLawStatus } from "../case_law/registry.js";
import type { DojoSourceSnapshot } from "../source/source_snapshot.js";
import type { DojoPublishedWorkflowBinding } from "./published_workflow_index.js";

export type MaybePromise<T> = T | Promise<T>;

export interface DojoStoreTransactionOptions {
  mode: "read" | "write";
  reason: string;
}

export interface DojoStoreTransaction {
  transaction_id: string;
  mode: DojoStoreTransactionOptions["mode"];
  started_at: string;
}

export interface DojoTransactionalStore {
  withTransaction?<T>(
    options: DojoStoreTransactionOptions,
    operation: (transaction: DojoStoreTransaction) => MaybePromise<T>
  ): MaybePromise<T>;
}

export interface DojoProofCapsuleRecord {
  tenant_id?: string;
  workspace_id?: string;
  capsule_id: string;
  skill_id: string;
  license_id?: string;
  license_version?: string;
  requested_action: string;
  nonce?: string;
  key_id?: string;
  signature_algorithm?: string;
  substrate_claim?: string;
  evidence_record_ids?: string[];
  ledger_checkpoint_hash?: string;
  issued_at: string;
  expires_at: string;
  status: "issued" | "used" | "revoked";
  issued_by?: DojoAuditActor;
  first_used_at?: string;
  last_validated_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
  revoked_by?: DojoAuditActor;
  revocation_evidence_refs?: string[];
}

export type DojoProofConsumeStatus = "used" | "missing" | "already_used" | "revoked";

export interface DojoProofConsumeResult {
  ok: boolean;
  record: DojoProofCapsuleRecord | null;
  status: DojoProofConsumeStatus;
  blocked_by: string[];
}

export type DojoPermissionUpgradeRequestStatus = "pending" | "not_required" | "approved" | "denied" | "superseded";

export interface DojoPermissionUpgradeRequestRecord {
  schema_version: "synthi.dojo.permissionUpgradeRequest.v1";
  request_id: string;
  skill_id: string;
  workflow_id: string;
  workspace_id: string;
  license_id: string;
  license_version: string;
  requested_action: string;
  current_entrustment_level: string;
  required_steps: string[];
  status: DojoPermissionUpgradeRequestStatus;
  evidence_refs: string[];
  requested_at: string;
  requested_by: DojoAuditActor;
  reviewed_at?: string;
  reviewed_by?: DojoAuditActor;
  review_reason?: string;
  decision_evidence_refs?: string[];
  request_context: {
    request_id: string;
    correlation_id: string;
  };
}

export interface DojoPermissionUpgradeRequestFilter {
  request_id?: string;
  skill_id?: string;
  workflow_id?: string;
  requested_action?: string;
  status?: DojoPermissionUpgradeRequestStatus;
  limit?: number;
}

export interface DojoCaseLawRecordFilter {
  case_id?: string;
  status?: DojoCaseLawStatus;
  binding_scope?: DojoCaseLawBindingScope;
  applies_to?: string;
  limit?: number;
}

export interface DojoGhostShadowEvidenceRecord {
  schema_version: "synthi.dojo.ghostShadowEvidence.v1";
  tenant_id: string;
  workspace_id: string;
  evidence_id: string;
  run_id: string;
  skill_id: string;
  workflow_id: string;
  license_id: string;
  evidence_kind: "shadow";
  production_mutations_executed: false;
  action_matches: boolean;
  observed_label: string;
  planned_label: string;
  observed_human_action: Record<string, unknown>;
  agent_planned_action: Record<string, unknown>;
  license_status: "licensed" | "blocked";
  guardrail_refs: string[];
  evidence_refs: string[];
  entrustment_impact: Record<string, unknown>;
  created_at: string;
  created_by: DojoAuditActor;
  request_context: {
    request_id: string;
    correlation_id: string;
  };
}

export interface DojoGhostShadowEvidenceFilter {
  evidence_id?: string;
  run_id?: string;
  skill_id?: string;
  workflow_id?: string;
  action_matches?: boolean;
  limit?: number;
}

export interface DojoSkillStore {
  saveSkill(skill: DojoSkill): void;
  getSkill(skillId: string): DojoSkill | null;
  getSkillByWorkflowId(workflowId: string): DojoSkill | null;
  getSkillByPublishedToolName(toolName: string): DojoSkill | null;
  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null;
  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null;
  listSkills(): DojoSkill[];
}

export type DojoStoredSkillStatus = "draft" | "published" | "expired" | "revoked";

export interface DojoStoredSkillRecord {
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  workflow_id: string;
  name: string;
  status: DojoStoredSkillStatus;
  current_skill_version: string;
  skill_json: DojoSkill;
  created_at: string;
  updated_at: string;
}

export interface DojoStoredSkillVersionRecord {
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  skill_version: string;
  graph_version?: string;
  seed_json: DojoSkill["skill_seed"];
  graph_json: DojoSkill["skill_cortex"];
  created_at: string;
  created_by?: string;
}

export interface DojoSkillListFilter {
  skill_id?: string;
  workflow_id?: string;
  status?: DojoStoredSkillStatus;
  published_tool_name?: string;
  limit?: number;
}

export interface DojoSkillVersionListFilter {
  skill_id?: string;
  skill_version?: string;
  graph_version?: string;
  created_by?: string;
  limit?: number;
}

export interface DojoDurableSkillStore {
  readonly store_contract_kind?: "skill";
  saveSkill(
    skill: DojoSkill,
    options?: {
      status?: DojoStoredSkillStatus;
      created_by?: DojoAuditActor;
      now?: string;
    }
  ): MaybePromise<DojoStoredSkillRecord>;
  getSkillRecord(skillId: string): MaybePromise<DojoStoredSkillRecord | null>;
  getSkill(skillId: string): MaybePromise<DojoSkill | null>;
  getSkillByWorkflowId(workflowId: string): MaybePromise<DojoSkill | null>;
  getSkillByPublishedToolName(toolName: string): MaybePromise<DojoSkill | null>;
  getPublishedWorkflowBindingByWorkflowId(workflowId: string): MaybePromise<DojoPublishedWorkflowBinding | null>;
  getPublishedWorkflowBindingByToolName(toolName: string): MaybePromise<DojoPublishedWorkflowBinding | null>;
  listSkillRecords(filter?: DojoSkillListFilter): MaybePromise<DojoStoredSkillRecord[]>;
  listSkills(filter?: DojoSkillListFilter): MaybePromise<DojoSkill[]>;
  getSkillVersion(skillId: string, skillVersion: string): MaybePromise<DojoStoredSkillVersionRecord | null>;
  listSkillVersions(filter?: DojoSkillVersionListFilter): MaybePromise<DojoStoredSkillVersionRecord[]>;
}

export interface DojoProofStore {
  saveProofRecord(record: DojoProofCapsuleRecord): void;
  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null;
  listProofRecords(): DojoProofCapsuleRecord[];
  markProofCapsuleValidated(capsuleId: string, now?: string): DojoProofCapsuleRecord | null;
  markProofCapsuleUsed(capsuleId: string, runId: string, now?: string): DojoProofConsumeResult;
  revokeProofCapsule(
    capsuleId: string,
    reason: string,
    now?: string,
    revokedBy?: DojoAuditActor,
    evidenceRefs?: string[]
  ): DojoProofCapsuleRecord | null;
}

export interface DojoControlPlaneStore extends DojoSkillStore, DojoProofStore, DojoApprovalStore, DojoCaseLawStore, DojoGhostShadowEvidenceStore, DojoAuditStore, DojoTransactionalStore {
  clear(): void;
}

export type DojoStoredLicenseStatus = "active" | "expired" | "revoked" | "superseded";

export interface DojoPermissionLicenseRecord {
  tenant_id: string;
  workspace_id: string;
  license_id: string;
  skill_id: string;
  license_version: string;
  status: DojoStoredLicenseStatus;
  entrustment_level: DojoPermissionLicense["entrustment_level"];
  readiness_level: DojoSkillReadinessLevel;
  license_json: DojoPermissionLicense;
  expires_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface DojoPermissionLicenseVersionRecord {
  tenant_id: string;
  workspace_id: string;
  license_id: string;
  license_version: string;
  skill_id: string;
  status: DojoStoredLicenseStatus;
  entrustment_level: DojoPermissionLicense["entrustment_level"];
  readiness_level: DojoSkillReadinessLevel;
  license_json: DojoPermissionLicense;
  created_at: string;
  created_by?: string;
}

export interface DojoLicenseListFilter {
  license_id?: string;
  skill_id?: string;
  license_version?: string;
  status?: DojoStoredLicenseStatus;
  entrustment_level?: DojoPermissionLicense["entrustment_level"];
  readiness_level?: DojoSkillReadinessLevel;
  limit?: number;
}

export interface DojoLicenseStore {
  readonly store_contract_kind?: "license";
  saveLicense(
    license: DojoPermissionLicense,
    options: {
      readiness_level: DojoSkillReadinessLevel;
      status?: DojoStoredLicenseStatus;
      expires_at?: string;
      created_by?: DojoAuditActor;
      now?: string;
    }
  ): MaybePromise<DojoPermissionLicenseRecord>;
  getLicense(licenseId: string): MaybePromise<DojoPermissionLicenseRecord | null>;
  getLicenseVersion(licenseId: string, licenseVersion: string): MaybePromise<DojoPermissionLicenseVersionRecord | null>;
  listLicenses(filter?: DojoLicenseListFilter): MaybePromise<DojoPermissionLicenseRecord[]>;
  listLicenseVersions(filter?: DojoLicenseListFilter): MaybePromise<DojoPermissionLicenseVersionRecord[]>;
  revokeLicense(
    licenseId: string,
    reason: string,
    now?: string,
    revokedBy?: DojoAuditActor,
    options?: {
      revoked_license?: DojoPermissionLicense;
      readiness_level?: DojoSkillReadinessLevel;
      expires_at?: string;
    }
  ): MaybePromise<DojoPermissionLicenseRecord | null>;
}

export interface DojoEvidenceStore {
  readonly store_contract_kind?: "evidence";
}

export interface DojoGhostShadowEvidenceStore {
  saveGhostShadowEvidence(record: DojoGhostShadowEvidenceRecord): void;
  listGhostShadowEvidence(filter?: DojoGhostShadowEvidenceFilter): DojoGhostShadowEvidenceRecord[];
}

export interface DojoApprovalStore {
  readonly store_contract_kind?: "approval";
  savePermissionUpgradeRequest(record: DojoPermissionUpgradeRequestRecord): void;
  listPermissionUpgradeRequests(filter?: DojoPermissionUpgradeRequestFilter): DojoPermissionUpgradeRequestRecord[];
}

export type DojoAuditActorType = "human" | "agent" | "service";

export type DojoAuditEventType =
  | "skill_created"
  | "skill_version_created"
  | "checkride_run_started"
  | "checkride_run_completed"
  | "license_issued"
  | "license_revoked"
  | "proof_issued"
  | "proof_validated"
  | "proof_used"
  | "proof_rejected"
  | "proof_revoked"
  | "case_law_proposed"
  | "case_law_approved"
  | "case_law_deprecated"
  | "guardrail_activated"
  | "source_contract_changed"
  | "skill_expired"
  | "permission_upgrade_requested"
  | "approval_granted"
  | "approval_denied"
  | "runtime_session_created"
  | "runtime_session_rejected"
  | "runtime_session_revoked"
  | "runtime_action_authorized"
  | "runtime_action_blocked"
  | "mcp_host_conformance_recorded"
  | "mcp_tool_invocation_allowed"
  | "mcp_tool_invocation_blocked"
  | "ghost_shadow_evidence_recorded";

export interface DojoAuditActor {
  actor_id: string;
  actor_type: DojoAuditActorType;
}

export interface DojoAuditEventInput {
  tenant_id: string;
  workspace_id: string;
  audit_event_id?: string;
  actor: DojoAuditActor;
  event_type: DojoAuditEventType;
  request_id: string;
  correlation_id: string;
  entity_kind?: string;
  entity_id?: string;
  details?: Record<string, unknown>;
  created_at?: string;
}

export interface DojoAuditEventRecord {
  tenant_id: string;
  workspace_id: string;
  audit_event_id: string;
  actor: DojoAuditActor;
  event_type: DojoAuditEventType;
  request_id: string;
  correlation_id: string;
  entity_kind?: string;
  entity_id?: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface DojoAuditEventListFilter {
  event_type?: DojoAuditEventType;
  entity_kind?: string;
  entity_id?: string;
  correlation_id?: string;
  limit?: number;
}

export interface DojoAuditStore {
  appendAuditEvent(event: DojoAuditEventInput): MaybePromise<DojoAuditEventRecord>;
  listAuditEvents(filter?: DojoAuditEventListFilter): MaybePromise<DojoAuditEventRecord[]>;
}

export interface DojoCaseLawStore {
  saveCaseLawRecord(record: DojoCaseLawRecord): void;
  getCaseLawRecord(caseId: string): DojoCaseLawRecord | null;
  listCaseLawRecords(filter?: DojoCaseLawRecordFilter): DojoCaseLawRecord[];
}

export type DojoStoredSourceRisk = "safe" | "low" | "medium" | "high" | "critical";
export type DojoStoredSourceSubstrate = "vision" | "dom" | "source" | "api" | "mcp";
export type DojoSourceCompatibilityStatus = "current" | "drifted" | "deprecated" | "blocked";

export interface DojoAppReleaseRecord {
  tenant_id: string;
  workspace_id: string;
  app_release_id: string;
  app_origin: string;
  app_version: string;
  commit_sha: string;
  source_map_sha256?: string;
  framework_adapter?: string;
  status: "active" | "superseded" | "revoked";
  created_at: string;
  created_by?: string;
}

export interface DojoStoredSourceTokenRecord {
  tenant_id: string;
  workspace_id: string;
  snapshot_id: string;
  token_id: string;
  component_path: string;
  route: string;
  stable_action_name: string;
  source_locator: string;
  risk: DojoStoredSourceRisk;
  proof_required: boolean;
  allowed_substrate: DojoStoredSourceSubstrate;
  compatibility_status: DojoSourceCompatibilityStatus;
  token_json: Record<string, unknown>;
  created_at: string;
}

export interface DojoSourceSnapshotListFilter {
  app_release_id?: string;
  app_origin?: string;
  app_version?: string;
  commit_sha?: string;
  limit?: number;
}

export interface DojoSourceTokenListFilter {
  snapshot_id?: string;
  token_id?: string;
  route?: string;
  stable_action_name?: string;
  risk?: DojoStoredSourceRisk;
  allowed_substrate?: DojoStoredSourceSubstrate;
  compatibility_status?: DojoSourceCompatibilityStatus;
  limit?: number;
}

export interface DojoSourceContractStore {
  readonly store_contract_kind?: "source_contract";
  saveSourceSnapshot(
    snapshot: DojoSourceSnapshot,
    options: {
      signing_keys_by_id: Record<string, string>;
      source_map_sha256?: string;
      framework_adapter?: string;
      created_by?: DojoAuditActor;
    }
  ): MaybePromise<DojoSourceSnapshot>;
  getSourceSnapshot(snapshotId: string): MaybePromise<DojoSourceSnapshot | null>;
  listSourceSnapshots(filter?: DojoSourceSnapshotListFilter): MaybePromise<DojoSourceSnapshot[]>;
  getSourceToken(snapshotId: string, tokenId: string): MaybePromise<DojoStoredSourceTokenRecord | null>;
  listSourceTokens(filter?: DojoSourceTokenListFilter): MaybePromise<DojoStoredSourceTokenRecord[]>;
}

export type DojoMcpToolRegistrationStatus = "active" | "revoked" | "superseded";
export type DojoMcpDirectCallPolicy = "blocked" | "dojo_dispatcher_only" | "practice_only";
export type DojoMcpToolInvocationStatus = "allowed" | "blocked" | "failed" | "completed";

export interface DojoMcpToolRegistrationRecord {
  tenant_id: string;
  workspace_id: string;
  tool_registration_id: string;
  tool_name: string;
  tool_version: string;
  skill_id: string;
  license_id?: string;
  manifest_digest: string;
  signed_manifest: string;
  proof_required: boolean;
  direct_call_policy: DojoMcpDirectCallPolicy;
  status: DojoMcpToolRegistrationStatus;
  registered_at: string;
  revoked_at?: string;
  manifest_json: Record<string, unknown>;
}

export interface DojoMcpToolRegistrationFilter {
  tool_registration_id?: string;
  tool_name?: string;
  tool_version?: string;
  skill_id?: string;
  license_id?: string;
  status?: DojoMcpToolRegistrationStatus;
  limit?: number;
}

export interface DojoMcpToolInvocationRecord {
  tenant_id: string;
  workspace_id: string;
  invocation_id: string;
  tool_registration_id?: string;
  tool_name: string;
  tool_version?: string;
  skill_id?: string;
  actor: DojoAuditActor;
  requested_action: string;
  status: DojoMcpToolInvocationStatus;
  proof_capsule_id?: string;
  audit_event_id?: string;
  invocation_json: Record<string, unknown>;
  created_at: string;
}

export interface DojoMcpToolInvocationFilter {
  invocation_id?: string;
  tool_registration_id?: string;
  tool_name?: string;
  skill_id?: string;
  actor_id?: string;
  requested_action?: string;
  status?: DojoMcpToolInvocationStatus;
  limit?: number;
}

export type DojoMcpHostConformanceStatus = "passed" | "failed" | "skipped";
export type DojoMcpHostKind = "local_loopback" | "deployed_non_loopback";

export interface DojoMcpHostConformanceResultRecord {
  tenant_id: string;
  workspace_id: string;
  conformance_result_id: string;
  host_url: string;
  host_kind: DojoMcpHostKind;
  status: DojoMcpHostConformanceStatus;
  report_sha256: string;
  report_json: Record<string, unknown>;
  created_at: string;
  created_by: string;
}

export interface DojoMcpHostConformanceResultFilter {
  conformance_result_id?: string;
  host_url?: string;
  host_kind?: DojoMcpHostKind;
  status?: DojoMcpHostConformanceStatus;
  created_by?: string;
  limit?: number;
}
