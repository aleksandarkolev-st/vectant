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

export interface DojoAuditStore {
  readonly store_contract_kind?: "audit";
}

export interface DojoCaseLawStore {
  readonly store_contract_kind?: "case_law";
}

export interface DojoSourceContractStore {
  readonly store_contract_kind?: "source_contract";
}
