import type { DojoSkill } from "../../browser/dojo.js";
import type { DojoCaseLawBindingScope, DojoCaseLawRecord, DojoCaseLawStatus } from "../case_law/registry.js";
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
  first_used_at?: string;
  last_validated_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
  revoked_by?: DojoAuditActor;
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

export interface DojoSkillStore {
  saveSkill(skill: DojoSkill): void;
  getSkill(skillId: string): DojoSkill | null;
  getSkillByWorkflowId(workflowId: string): DojoSkill | null;
  getSkillByPublishedToolName(toolName: string): DojoSkill | null;
  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null;
  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null;
  listSkills(): DojoSkill[];
}

export interface DojoProofStore {
  saveProofRecord(record: DojoProofCapsuleRecord): void;
  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null;
  listProofRecords(): DojoProofCapsuleRecord[];
  markProofCapsuleValidated(capsuleId: string, now?: string): DojoProofCapsuleRecord | null;
  markProofCapsuleUsed(capsuleId: string, runId: string, now?: string): DojoProofConsumeResult;
  revokeProofCapsule(capsuleId: string, reason: string, now?: string, revokedBy?: DojoAuditActor): DojoProofCapsuleRecord | null;
}

export interface DojoControlPlaneStore extends DojoSkillStore, DojoProofStore, DojoApprovalStore, DojoCaseLawStore, DojoTransactionalStore {
  clear(): void;
}

export interface DojoLicenseStore {
  readonly store_contract_kind?: "license";
}

export interface DojoEvidenceStore {
  readonly store_contract_kind?: "evidence";
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
  | "runtime_action_blocked";

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

export interface DojoSourceContractStore {
  readonly store_contract_kind?: "source_contract";
}
