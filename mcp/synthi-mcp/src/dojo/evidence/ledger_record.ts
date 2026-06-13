import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput, DojoLedgerCheckpoint } from "./types.js";

const ZERO_HASH = "0".repeat(64);
const HMAC_SHA256_PREFIX = "hmac-sha256:";

export interface DojoEvidenceRecordSigner {
  signer_key_id: string;
  sign(payload: string): string;
}

export interface DojoEvidenceRecordSignatureVerifier {
  signer_key_id: string;
  verify(payload: string, signature: string): boolean;
}

export interface DojoEvidenceRecordBuildOptions {
  signer?: DojoEvidenceRecordSigner;
  require_signature?: boolean;
}

export interface DojoEvidenceRecordSignatureVerification {
  ok: boolean;
  signer_key_id: string | null;
  blocked_by: string[];
}

export function buildDojoEvidenceLedgerRecord(
  input: DojoEvidenceRecordInput,
  options: DojoEvidenceRecordBuildOptions = {}
): DojoEvidenceLedgerRecord {
  if (options.require_signature && !options.signer) {
    throw new Error("dojo_evidence_signature_required");
  }
  if (options.signer && input.signer_key_id !== undefined && input.signer_key_id !== options.signer.signer_key_id) {
    throw new Error("dojo_evidence_signer_key_mismatch");
  }
  const normalized = normalizeEvidenceRecordInput({
    ...input,
    signer_key_id: options.signer?.signer_key_id ?? input.signer_key_id,
  });
  const material = {
    schema_version: "synthi.dojo.evidenceRecord.v1",
    ...normalized,
  } satisfies Omit<DojoEvidenceLedgerRecord, "record_hash" | "ledger_head_hash" | "signature">;
  const recordHash = sha256Hex(canonicalJson(evidenceRecordHashPayload(material)));
  const unsignedRecord = {
    ...material,
    record_hash: recordHash,
    ledger_head_hash: recordHash,
  };
  const signature = options.signer ? options.signer.sign(canonicalJson(evidenceRecordSignaturePayload(unsignedRecord))) : null;
  if (options.require_signature && !signature) {
    throw new Error("dojo_evidence_signature_required");
  }
  return {
    ...unsignedRecord,
    signature,
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

export function evidenceRecordSignaturePayload(record: Omit<DojoEvidenceLedgerRecord, "signature">): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.evidenceRecordSignature.v1",
    record_id: record.record_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    record_hash: record.record_hash,
    ledger_head_hash: record.ledger_head_hash,
    signer_key_id: record.signer_key_id,
  };
}

export function createHmacDojoEvidenceRecordSigner(input: {
  signer_key_id: string;
  secret: string;
}): DojoEvidenceRecordSigner & DojoEvidenceRecordSignatureVerifier {
  const signerKeyId = requireNonEmpty(input.signer_key_id, "signer_key_id");
  const secret = requireNonEmpty(input.secret, "signature_secret");
  return {
    signer_key_id: signerKeyId,
    sign(payload: string): string {
      return `${HMAC_SHA256_PREFIX}${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
    },
    verify(payload: string, signature: string): boolean {
      const expected = `${HMAC_SHA256_PREFIX}${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
      return safeEqual(signature, expected);
    },
  };
}

export function verifyDojoEvidenceLedgerRecordSignature(
  record: DojoEvidenceLedgerRecord,
  verifiers: readonly DojoEvidenceRecordSignatureVerifier[]
): DojoEvidenceRecordSignatureVerification {
  if (!record.signer_key_id || !record.signature) {
    return {
      ok: false,
      signer_key_id: record.signer_key_id,
      blocked_by: ["dojo_evidence_signature_missing"],
    };
  }
  if (!record.signature.startsWith(HMAC_SHA256_PREFIX) || !/^[a-f0-9]{64}$/i.test(record.signature.slice(HMAC_SHA256_PREFIX.length))) {
    return {
      ok: false,
      signer_key_id: record.signer_key_id,
      blocked_by: ["dojo_evidence_signature_invalid"],
    };
  }
  const verifier = verifiers.find((candidate) => candidate.signer_key_id === record.signer_key_id);
  if (!verifier) {
    return {
      ok: false,
      signer_key_id: record.signer_key_id,
      blocked_by: ["dojo_evidence_signature_key_unknown"],
    };
  }
  const ok = verifier.verify(canonicalJson(evidenceRecordSignaturePayload(record)), record.signature);
  return {
    ok,
    signer_key_id: record.signer_key_id,
    blocked_by: ok ? [] : ["dojo_evidence_signature_invalid"],
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
  if (input.signer_key_id !== undefined) requireNonEmpty(input.signer_key_id, "signer_key_id");
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

function requireNonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`dojo_evidence_${field}_required`);
  return value.trim();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
