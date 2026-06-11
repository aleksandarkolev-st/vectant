import type { DojoSkill } from "../../browser/dojo.js";
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
  capsule_id: string;
  skill_id: string;
  requested_action: string;
  nonce?: string;
  issued_at: string;
  expires_at: string;
  status: "issued" | "used" | "revoked";
  first_used_at?: string;
  last_validated_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
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
  revokeProofCapsule(capsuleId: string, reason: string, now?: string): DojoProofCapsuleRecord | null;
}

export interface DojoControlPlaneStore extends DojoSkillStore, DojoProofStore, DojoTransactionalStore {
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
  | "guardrail_activated"
  | "source_contract_changed"
  | "skill_expired"
  | "permission_upgrade_requested"
  | "approval_granted"
  | "approval_denied";

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
  readonly store_contract_kind?: "case_law";
}

export interface DojoSourceContractStore {
  readonly store_contract_kind?: "source_contract";
}
