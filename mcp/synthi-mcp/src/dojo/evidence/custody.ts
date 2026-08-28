import { canonicalJson, sha256Hex } from "./ledger_record.js";
import type { DojoEvidenceLedgerRecord } from "./types.js";

export type DojoEvidenceStorageProvider =
  | "object_store"
  | "content_addressed_store"
  | "database_blob_store"
  | "external_archive";

export interface DojoEvidenceArtifactCustodyReceiptInput {
  receipt_id?: string;
  tenant_id: string;
  workspace_id: string;
  evidence_record_id: string;
  artifact_uri: string;
  artifact_sha256: string;
  storage_provider: DojoEvidenceStorageProvider;
  storage_region?: string;
  storage_key: string;
  storage_version?: string;
  encryption_key_ref: string;
  ledger_head_hash: string;
  written_at: string;
  written_by: string;
  retention_until?: string;
  legal_hold?: boolean;
  previous_receipt_hash?: string;
}

export interface DojoEvidenceArtifactCustodyReceipt extends Required<
  Omit<
    DojoEvidenceArtifactCustodyReceiptInput,
    "receipt_id" | "storage_region" | "storage_version" | "retention_until" | "legal_hold" | "previous_receipt_hash"
  >
> {
  schema_version: "synthi.dojo.evidenceArtifactCustodyReceipt.v1";
  receipt_id: string;
  storage_region: string | null;
  storage_version: string | null;
  retention_until: string | null;
  legal_hold: boolean;
  previous_receipt_hash: string | null;
  receipt_hash: string;
}

export interface DojoEvidenceCustodyManifest {
  schema_version: "synthi.dojo.evidenceCustodyManifest.v1";
  tenant_id: string;
  workspace_id: string;
  generated_at: string;
  require_external_storage: boolean;
  evidence_record_count: number;
  receipt_count: number;
  receipts: DojoEvidenceArtifactCustodyReceipt[];
  verification: DojoEvidenceCustodyVerification;
}

export interface DojoEvidenceCustodyVerification {
  ok: boolean;
  checked_at: string;
  require_external_storage: boolean;
  record_count: number;
  receipt_count: number;
  missing_record_ids: string[];
  mismatched_record_ids: string[];
  non_external_receipt_ids: string[];
  duplicate_receipt_ids: string[];
  blocked_by: string[];
}

const ZERO_HASH = "0".repeat(64);
const BLOCKED_STORAGE_PROTOCOLS = new Set(["", "about:", "blob:", "data:", "dojo-artifact:", "file:", "memory:"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function buildDojoEvidenceArtifactCustodyReceipt(
  input: DojoEvidenceArtifactCustodyReceiptInput
): DojoEvidenceArtifactCustodyReceipt {
  const normalized = normalizeReceiptInput(input);
  const receiptId = input.receipt_id?.trim()
    || `custody_${sha256Hex(canonicalJson(receiptIdPayload(normalized))).slice(0, 16)}`;
  const material = {
    schema_version: "synthi.dojo.evidenceArtifactCustodyReceipt.v1",
    receipt_id: receiptId,
    ...normalized,
  } satisfies Omit<DojoEvidenceArtifactCustodyReceipt, "receipt_hash">;
  return {
    ...material,
    receipt_hash: sha256Hex(canonicalJson(custodyReceiptHashPayload(material))),
  };
}

export function buildDojoEvidenceCustodyManifest(input: {
  tenant_id: string;
  workspace_id: string;
  records: DojoEvidenceLedgerRecord[];
  receipts: DojoEvidenceArtifactCustodyReceipt[];
  generated_at?: string;
  require_external_storage?: boolean;
}): DojoEvidenceCustodyManifest {
  const tenantId = requiredString(input.tenant_id, "tenant_id");
  const workspaceId = requiredString(input.workspace_id, "workspace_id");
  const generatedAt = input.generated_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("dojo_evidence_custody_generated_at_timestamp_required");
  }
  const receipts = input.receipts
    .map(cloneReceipt)
    .sort((left, right) => left.evidence_record_id.localeCompare(right.evidence_record_id) || left.receipt_id.localeCompare(right.receipt_id));
  const verification = verifyDojoEvidenceCustody({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    records: input.records,
    receipts,
    checked_at: generatedAt,
    require_external_storage: input.require_external_storage !== false,
  });
  return {
    schema_version: "synthi.dojo.evidenceCustodyManifest.v1",
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: generatedAt,
    require_external_storage: input.require_external_storage !== false,
    evidence_record_count: input.records.length,
    receipt_count: receipts.length,
    receipts,
    verification,
  };
}

export function verifyDojoEvidenceCustody(input: {
  tenant_id: string;
  workspace_id: string;
  records: DojoEvidenceLedgerRecord[];
  receipts: DojoEvidenceArtifactCustodyReceipt[];
  checked_at?: string;
  require_external_storage?: boolean;
}): DojoEvidenceCustodyVerification {
  const tenantId = requiredString(input.tenant_id, "tenant_id");
  const workspaceId = requiredString(input.workspace_id, "workspace_id");
  const checkedAt = input.checked_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(checkedAt))) {
    return failedVerification({
      checked_at: checkedAt,
      require_external_storage: input.require_external_storage !== false,
      record_count: input.records.length,
      receipt_count: input.receipts.length,
      blocked_by: ["evidence_custody_checked_at_invalid"],
    });
  }
  const requireExternal = input.require_external_storage !== false;
  const records = input.records.filter((record) => record.tenant_id === tenantId && record.workspace_id === workspaceId);
  const recordsById = new Map(records.map((record) => [record.record_id, record]));
  const receipts = input.receipts.filter((receipt) => receipt.tenant_id === tenantId && receipt.workspace_id === workspaceId);
  const receiptIds = receipts.map((receipt) => receipt.receipt_id);
  const duplicateReceiptIds = duplicateStrings(receiptIds);
  const receiptByRecord = new Map<string, DojoEvidenceArtifactCustodyReceipt>();
  const mismatchedRecordIds = new Set<string>();
  const nonExternalReceiptIds = new Set<string>();

  for (const receipt of receipts) {
    const record = recordsById.get(receipt.evidence_record_id);
    if (!record) {
      mismatchedRecordIds.add(receipt.evidence_record_id);
      continue;
    }
    if (receipt.artifact_sha256 !== record.artifact_sha256 || receipt.ledger_head_hash !== record.ledger_head_hash) {
      mismatchedRecordIds.add(receipt.evidence_record_id);
    }
    if (receipt.receipt_hash !== sha256Hex(canonicalJson(custodyReceiptHashPayload({ ...receipt, receipt_hash: undefined })))) {
      mismatchedRecordIds.add(receipt.evidence_record_id);
    }
    if (requireExternal && !isExternalStorageUri(receipt.artifact_uri)) {
      nonExternalReceiptIds.add(receipt.receipt_id);
    }
    receiptByRecord.set(receipt.evidence_record_id, receipt);
  }

  const missingRecordIds = records
    .filter((record) => !receiptByRecord.has(record.record_id))
    .map((record) => record.record_id)
    .sort();
  const blockedBy = [
    ...(input.records.length !== records.length ? ["evidence_custody_record_scope_mismatch"] : []),
    ...(input.receipts.length !== receipts.length ? ["evidence_custody_receipt_scope_mismatch"] : []),
    ...(missingRecordIds.length > 0 ? ["evidence_custody_receipts_missing"] : []),
    ...(mismatchedRecordIds.size > 0 ? ["evidence_custody_receipt_record_mismatch"] : []),
    ...(nonExternalReceiptIds.size > 0 ? ["evidence_custody_external_storage_required"] : []),
    ...(duplicateReceiptIds.length > 0 ? ["evidence_custody_duplicate_receipt_ids"] : []),
  ];
  return {
    ok: blockedBy.length === 0,
    checked_at: checkedAt,
    require_external_storage: requireExternal,
    record_count: records.length,
    receipt_count: receipts.length,
    missing_record_ids: missingRecordIds,
    mismatched_record_ids: [...mismatchedRecordIds].sort(),
    non_external_receipt_ids: [...nonExternalReceiptIds].sort(),
    duplicate_receipt_ids: duplicateReceiptIds,
    blocked_by: blockedBy,
  };
}

export function isExternalStorageUri(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (BLOCKED_STORAGE_PROTOCOLS.has(parsed.protocol)) return false;
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return false;
  }
  return true;
}

function normalizeReceiptInput(input: DojoEvidenceArtifactCustodyReceiptInput): Omit<
  DojoEvidenceArtifactCustodyReceipt,
  "schema_version" | "receipt_id" | "receipt_hash"
> {
  requiredString(input.tenant_id, "tenant_id");
  requiredString(input.workspace_id, "workspace_id");
  requiredString(input.evidence_record_id, "evidence_record_id");
  requiredString(input.artifact_uri, "artifact_uri");
  requiredSha256(input.artifact_sha256, "artifact_sha256");
  requiredString(input.storage_provider, "storage_provider");
  requiredString(input.storage_key, "storage_key");
  requiredString(input.encryption_key_ref, "encryption_key_ref");
  requiredSha256(input.ledger_head_hash, "ledger_head_hash");
  requiredTimestamp(input.written_at, "written_at");
  requiredString(input.written_by, "written_by");
  if (input.retention_until !== undefined) requiredTimestamp(input.retention_until, "retention_until");
  if (input.previous_receipt_hash !== undefined) requiredSha256(input.previous_receipt_hash, "previous_receipt_hash");
  if (!["object_store", "content_addressed_store", "database_blob_store", "external_archive"].includes(input.storage_provider)) {
    throw new Error("dojo_evidence_custody_storage_provider_invalid");
  }
  return {
    tenant_id: input.tenant_id.trim(),
    workspace_id: input.workspace_id.trim(),
    evidence_record_id: input.evidence_record_id.trim(),
    artifact_uri: input.artifact_uri.trim(),
    artifact_sha256: input.artifact_sha256.toLowerCase(),
    storage_provider: input.storage_provider,
    storage_region: input.storage_region?.trim() || null,
    storage_key: input.storage_key.trim(),
    storage_version: input.storage_version?.trim() || null,
    encryption_key_ref: input.encryption_key_ref.trim(),
    ledger_head_hash: input.ledger_head_hash.toLowerCase(),
    written_at: input.written_at,
    written_by: input.written_by.trim(),
    retention_until: input.retention_until ?? null,
    legal_hold: input.legal_hold === true,
    previous_receipt_hash: input.previous_receipt_hash?.toLowerCase() ?? null,
  };
}

function receiptIdPayload(input: Omit<DojoEvidenceArtifactCustodyReceipt, "schema_version" | "receipt_id" | "receipt_hash">): Record<string, unknown> {
  return {
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    evidence_record_id: input.evidence_record_id,
    artifact_uri: input.artifact_uri,
    storage_provider: input.storage_provider,
    storage_key: input.storage_key,
    storage_version: input.storage_version,
    written_at: input.written_at,
  };
}

function custodyReceiptHashPayload(
  receipt: Omit<DojoEvidenceArtifactCustodyReceipt, "receipt_hash"> | (Omit<DojoEvidenceArtifactCustodyReceipt, "receipt_hash"> & { receipt_hash?: undefined })
): Record<string, unknown> {
  return {
    schema_version: receipt.schema_version,
    receipt_id: receipt.receipt_id,
    tenant_id: receipt.tenant_id,
    workspace_id: receipt.workspace_id,
    evidence_record_id: receipt.evidence_record_id,
    artifact_uri: receipt.artifact_uri,
    artifact_sha256: receipt.artifact_sha256,
    storage_provider: receipt.storage_provider,
    storage_region: receipt.storage_region,
    storage_key: receipt.storage_key,
    storage_version: receipt.storage_version,
    encryption_key_ref: receipt.encryption_key_ref,
    ledger_head_hash: receipt.ledger_head_hash,
    written_at: receipt.written_at,
    written_by: receipt.written_by,
    retention_until: receipt.retention_until,
    legal_hold: receipt.legal_hold,
    previous_receipt_hash: receipt.previous_receipt_hash,
  };
}

function cloneReceipt(receipt: DojoEvidenceArtifactCustodyReceipt): DojoEvidenceArtifactCustodyReceipt {
  return JSON.parse(JSON.stringify(receipt)) as DojoEvidenceArtifactCustodyReceipt;
}

function duplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated].sort();
}

function failedVerification(input: {
  checked_at: string;
  require_external_storage: boolean;
  record_count: number;
  receipt_count: number;
  blocked_by: string[];
}): DojoEvidenceCustodyVerification {
  return {
    ok: false,
    checked_at: input.checked_at,
    require_external_storage: input.require_external_storage,
    record_count: input.record_count,
    receipt_count: input.receipt_count,
    missing_record_ids: [],
    mismatched_record_ids: [],
    non_external_receipt_ids: [],
    duplicate_receipt_ids: [],
    blocked_by: input.blocked_by,
  };
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_evidence_custody_${field}_required`);
  return trimmed;
}

function requiredSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`dojo_evidence_custody_${field}_sha256_required`);
  }
}

function requiredTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`dojo_evidence_custody_${field}_timestamp_required`);
  }
}
