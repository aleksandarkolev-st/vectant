import { createHash } from "node:crypto";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput, DojoLedgerCheckpoint } from "./types.js";

const ZERO_HASH = "0".repeat(64);

export function buildDojoEvidenceLedgerRecord(input: DojoEvidenceRecordInput): DojoEvidenceLedgerRecord {
  const normalized = normalizeEvidenceRecordInput(input);
  const material = {
    schema_version: "synthi.dojo.evidenceRecord.v1",
    ...normalized,
  } satisfies Omit<DojoEvidenceLedgerRecord, "record_hash" | "ledger_head_hash" | "signature">;
  const recordHash = sha256Hex(canonicalJson(evidenceRecordHashPayload(material)));
  return {
    ...material,
    record_hash: recordHash,
    ledger_head_hash: recordHash,
    signature: null,
  };
}

export function buildDojoLedgerCheckpoint(input: {
  tenant_id: string;
  workspace_id: string;
  ledger_head_hash: string;
  record_count: number;
  created_at: string;
}): DojoLedgerCheckpoint {
  requireNonEmpty(input.tenant_id, "tenant_id");
  requireNonEmpty(input.workspace_id, "workspace_id");
  requireSha256(input.ledger_head_hash, "ledger_head_hash");
  if (!Number.isInteger(input.record_count) || input.record_count < 0) {
    throw new Error("dojo_ledger_record_count_invalid");
  }
  requireIsoTimestamp(input.created_at, "created_at");
  return {
    schema_version: "synthi.dojo.ledgerCheckpoint.v1",
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    ledger_head_hash: input.ledger_head_hash,
    record_count: input.record_count,
    created_at: input.created_at,
  };
}

export function evidenceRecordHashPayload(record: Omit<DojoEvidenceLedgerRecord, "record_hash" | "ledger_head_hash" | "signature">): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    record_id: record.record_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    skill_id: record.skill_id,
    run_id: record.run_id,
    kind: record.kind,
    artifact_uri: record.artifact_uri,
    artifact_sha256: record.artifact_sha256,
    redaction_manifest_sha256: record.redaction_manifest_sha256,
    claim_ids: [...record.claim_ids].sort(),
    previous_hash: record.previous_hash,
    signer_key_id: record.signer_key_id,
    created_at: record.created_at,
    created_by: record.created_by,
    retention_class: record.retention_class,
    legal_hold: record.legal_hold,
    source_refs: [...record.source_refs].sort(),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeEvidenceRecordInput(input: DojoEvidenceRecordInput): Omit<DojoEvidenceLedgerRecord, "schema_version" | "record_hash" | "ledger_head_hash" | "signature"> {
  requireNonEmpty(input.record_id, "record_id");
  requireNonEmpty(input.tenant_id, "tenant_id");
  requireNonEmpty(input.workspace_id, "workspace_id");
  requireNonEmpty(input.skill_id, "skill_id");
  requireNonEmpty(input.run_id, "run_id");
  requireNonEmpty(input.kind, "kind");
  requireNonEmpty(input.artifact_uri, "artifact_uri");
  requireSha256(input.artifact_sha256, "artifact_sha256");
  if (input.redaction_manifest_sha256 !== undefined) requireSha256(input.redaction_manifest_sha256, "redaction_manifest_sha256");
  if (input.previous_hash !== undefined) requireSha256(input.previous_hash, "previous_hash");
  requireIsoTimestamp(input.created_at, "created_at");
  requireNonEmpty(input.created_by, "created_by");
  return {
    ...input,
    previous_hash: input.previous_hash ?? ZERO_HASH,
    redaction_manifest_sha256: input.redaction_manifest_sha256 ?? null,
    signer_key_id: input.signer_key_id ?? null,
    claim_ids: [...new Set(input.claim_ids)].sort(),
    source_refs: [...new Set(input.source_refs ?? [])].sort(),
    legal_hold: input.legal_hold === true || input.retention_class === "legal_hold",
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`dojo_evidence_${field}_required`);
}

function requireSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`dojo_evidence_${field}_sha256_required`);
}

function requireIsoTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`dojo_evidence_${field}_timestamp_required`);
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForCanonicalJson(item)])
  );
}
