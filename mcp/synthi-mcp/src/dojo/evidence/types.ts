export type DojoEvidenceArtifactKind =
  | "trace"
  | "scenario"
  | "checkride"
  | "case_law"
  | "guardrail"
  | "license"
  | "proof"
  | "artifact"
  | "audit";

export type DojoEvidenceRetentionClass = "ephemeral" | "standard" | "regulated" | "legal_hold";

export interface DojoEvidenceRecordInput {
  record_id: string;
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  run_id: string;
  kind: DojoEvidenceArtifactKind;
  artifact_uri: string;
  artifact_sha256: string;
  redaction_manifest_sha256?: string;
  claim_ids: string[];
  previous_hash?: string;
  signer_key_id?: string;
  created_at: string;
  created_by: string;
  retention_class: DojoEvidenceRetentionClass;
  legal_hold?: boolean;
  source_refs?: string[];
}

export interface DojoEvidenceLedgerRecord extends Omit<
  DojoEvidenceRecordInput,
  "previous_hash" | "redaction_manifest_sha256" | "signer_key_id" | "legal_hold" | "source_refs"
> {
  schema_version: "synthi.dojo.evidenceRecord.v1";
  previous_hash: string;
  redaction_manifest_sha256: string | null;
  signer_key_id: string | null;
  source_refs: string[];
  legal_hold: boolean;
  record_hash: string;
  ledger_head_hash: string;
  signature: string | null;
}

export interface DojoLedgerCheckpoint {
  schema_version: "synthi.dojo.ledgerCheckpoint.v1";
  tenant_id: string;
  workspace_id: string;
  ledger_head_hash: string;
  record_count: number;
  created_at: string;
}

export interface DojoLedgerVerification {
  ok: boolean;
  checked_at: string;
  ledger_head_hash?: string;
  failed_record_id?: string;
  blocked_by: string[];
}
