import { describe, expect, it } from "vitest";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput } from "../../src/dojo/evidence/types.js";
import {
  buildDojoEvidenceArtifactCustodyReceipt,
  buildDojoEvidenceCustodyManifest,
  isExternalStorageUri,
  verifyDojoEvidenceCustody,
} from "../../src/dojo/evidence/custody.js";

const NOW = "2026-06-11T00:00:00.000Z";
const ARTIFACT_HASH = "a".repeat(64);
const REDACTION_HASH = "b".repeat(64);

describe("Dojo evidence artifact custody receipts", () => {
  it("builds provider-neutral custody receipts bound to ledger records", () => {
    const record = evidenceRecordFor({ recordId: "evidence-a" });
    const receipt = custodyReceiptFor(record, {
      artifactUri: "s3://dojo-evidence-prod/tenant-a/workspace-a/evidence-a.json",
      storageKey: "tenant-a/workspace-a/evidence-a.json",
      storageVersion: "version-001",
    });
    const manifest = buildDojoEvidenceCustodyManifest({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [receipt],
      generated_at: NOW,
    });

    expect(receipt).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.evidenceArtifactCustodyReceipt.v1",
      evidence_record_id: "evidence-a",
      artifact_sha256: record.artifact_sha256,
      ledger_head_hash: record.ledger_head_hash,
      storage_provider: "object_store",
      encryption_key_ref: "kms://tenant-a/evidence-key",
      receipt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.evidenceCustodyManifest.v1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      evidence_record_count: 1,
      receipt_count: 1,
      verification: expect.objectContaining({
        ok: true,
        blocked_by: [],
      }),
    }));
  });

  it("fails closed when custody receipts are missing for ledger records", () => {
    const record = evidenceRecordFor({ recordId: "evidence-missing-custody" });

    expect(verifyDojoEvidenceCustody({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [],
      checked_at: NOW,
    })).toEqual(expect.objectContaining({
      ok: false,
      missing_record_ids: ["evidence-missing-custody"],
      blocked_by: ["evidence_custody_receipts_missing"],
    }));
  });

  it("fails closed when custody receipt material disagrees with the ledger record", () => {
    const record = evidenceRecordFor({ recordId: "evidence-mismatch" });
    const wrongDigestReceipt = {
      ...custodyReceiptFor(record),
      artifact_sha256: "c".repeat(64),
    };
    const wrongHeadReceipt = {
      ...custodyReceiptFor(record, { artifactUri: "gs://dojo-evidence/tenant-a/workspace-a/evidence-mismatch.json" }),
      ledger_head_hash: "d".repeat(64),
    };
    const tamperedReceipt = {
      ...custodyReceiptFor(record, { artifactUri: "azblob://dojo-evidence/tenant-a/workspace-a/evidence-mismatch.json" }),
      storage_key: "tenant-a/workspace-a/other.json",
    };

    for (const receipt of [wrongDigestReceipt, wrongHeadReceipt, tamperedReceipt]) {
      expect(verifyDojoEvidenceCustody({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        records: [record],
        receipts: [receipt],
        checked_at: NOW,
      })).toEqual(expect.objectContaining({
        ok: false,
        mismatched_record_ids: ["evidence-mismatch"],
        blocked_by: ["evidence_custody_receipt_record_mismatch"],
      }));
    }
  });

  it("rejects local-only artifact URIs when external custody is required", () => {
    const record = evidenceRecordFor({ recordId: "evidence-local-uri" });
    const receipt = custodyReceiptFor(record, {
      artifactUri: "file:///tmp/dojo-evidence/evidence-local-uri.json",
    });

    expect(verifyDojoEvidenceCustody({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [receipt],
      checked_at: NOW,
    })).toEqual(expect.objectContaining({
      ok: false,
      non_external_receipt_ids: [receipt.receipt_id],
      blocked_by: ["evidence_custody_external_storage_required"],
    }));
    expect(verifyDojoEvidenceCustody({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [receipt],
      checked_at: NOW,
      require_external_storage: false,
    })).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
    }));
  });

  it("checks tenant scope and duplicate custody receipt IDs", () => {
    const record = evidenceRecordFor({ recordId: "evidence-scoped" });
    const scopedOutReceipt = custodyReceiptFor(record, {
      tenantId: "tenant-b",
      receiptId: "receipt-duplicate",
    });
    const first = custodyReceiptFor(record, { receiptId: "receipt-duplicate" });
    const second = custodyReceiptFor(record, {
      receiptId: "receipt-duplicate",
      artifactUri: "https://evidence.example.test/tenant-a/workspace-a/evidence-scoped-copy.json",
      storageKey: "tenant-a/workspace-a/evidence-scoped-copy.json",
    });

    expect(verifyDojoEvidenceCustody({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [scopedOutReceipt],
      checked_at: NOW,
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "evidence_custody_receipt_scope_mismatch",
        "evidence_custody_receipts_missing",
      ]),
    }));
    expect(verifyDojoEvidenceCustody({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      records: [record],
      receipts: [first, second],
      checked_at: NOW,
    })).toEqual(expect.objectContaining({
      ok: false,
      duplicate_receipt_ids: ["receipt-duplicate"],
      blocked_by: ["evidence_custody_duplicate_receipt_ids"],
    }));
  });

  it("classifies storage URIs without binding to one cloud provider", () => {
    expect(isExternalStorageUri("s3://bucket/key")).toBe(true);
    expect(isExternalStorageUri("gs://bucket/key")).toBe(true);
    expect(isExternalStorageUri("azblob://account/container/key")).toBe(true);
    expect(isExternalStorageUri("https://evidence.example.test/object")).toBe(true);
    expect(isExternalStorageUri("file:///tmp/evidence.json")).toBe(false);
    expect(isExternalStorageUri("memory://evidence")).toBe(false);
    expect(isExternalStorageUri("dojo-artifact://local/report.json")).toBe(false);
    expect(isExternalStorageUri("http://127.0.0.1:4321/evidence.json")).toBe(false);
  });

  it("validates custody receipt required fields and timestamps", () => {
    const record = evidenceRecordFor({ recordId: "evidence-required-fields" });
    expect(() => custodyReceiptFor(record, { storageKey: "" })).toThrow("dojo_evidence_custody_storage_key_required");
    expect(() => custodyReceiptFor(record, { artifactSha256: "not-a-digest" })).toThrow(
      "dojo_evidence_custody_artifact_sha256_sha256_required"
    );
    expect(() => custodyReceiptFor(record, { writtenAt: "not-a-date" })).toThrow(
      "dojo_evidence_custody_written_at_timestamp_required"
    );
  });
});

function evidenceRecordFor(input: {
  recordId: string;
  tenantId?: string;
  workspaceId?: string;
}): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    ...baseEvidenceRecordInput(),
    record_id: input.recordId,
    tenant_id: input.tenantId ?? "tenant-a",
    workspace_id: input.workspaceId ?? "workspace-a",
  });
}

function custodyReceiptFor(
  record: DojoEvidenceLedgerRecord,
  overrides: {
    receiptId?: string;
    tenantId?: string;
    workspaceId?: string;
    artifactUri?: string;
    artifactSha256?: string;
    storageKey?: string;
    storageVersion?: string;
    writtenAt?: string;
  } = {}
) {
  return buildDojoEvidenceArtifactCustodyReceipt({
    receipt_id: overrides.receiptId,
    tenant_id: overrides.tenantId ?? record.tenant_id,
    workspace_id: overrides.workspaceId ?? record.workspace_id,
    evidence_record_id: record.record_id,
    artifact_uri: overrides.artifactUri ?? `s3://dojo-evidence-prod/${record.tenant_id}/${record.workspace_id}/${record.record_id}.json`,
    artifact_sha256: overrides.artifactSha256 ?? record.artifact_sha256,
    storage_provider: "object_store",
    storage_region: "us-east-1",
    storage_key: overrides.storageKey ?? `${record.tenant_id}/${record.workspace_id}/${record.record_id}.json`,
    storage_version: overrides.storageVersion,
    encryption_key_ref: "kms://tenant-a/evidence-key",
    ledger_head_hash: record.ledger_head_hash,
    written_at: overrides.writtenAt ?? NOW,
    written_by: "dojo-evidence-writer",
    retention_until: "2026-07-11T00:00:00.000Z",
    legal_hold: false,
  });
}

function baseEvidenceRecordInput(): DojoEvidenceRecordInput {
  return {
    record_id: "evidence-a",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    kind: "trace",
    artifact_uri: "sha256://trace-a",
    artifact_sha256: ARTIFACT_HASH,
    redaction_manifest_sha256: REDACTION_HASH,
    claim_ids: ["workspace_verified"],
    previous_hash: "0".repeat(64),
    signer_key_id: "key-a",
    created_at: NOW,
    created_by: "dojo-test",
    retention_class: "standard",
    legal_hold: false,
    source_refs: ["trace:trace-a"],
  };
}
