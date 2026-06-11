import { describe, expect, it } from "vitest";
import {
  buildDojoEvidenceLedgerRecord,
  buildDojoLedgerCheckpoint,
  canonicalJson,
} from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceRecordInput } from "../../src/dojo/evidence/types.js";

const ARTIFACT_HASH = "a".repeat(64);
const REDACTION_HASH = "b".repeat(64);
const PREVIOUS_HASH = "c".repeat(64);

describe("Dojo evidence ledger record schema", () => {
  it("builds stable record hashes from canonical material fields", () => {
    const left = buildDojoEvidenceLedgerRecord({
      ...baseInput(),
      claim_ids: ["workspace_verified", "checkride_passed", "workspace_verified"],
      source_refs: ["route:/invoices", "component:InvoiceForm"],
    });
    const right = buildDojoEvidenceLedgerRecord({
      ...baseInput(),
      claim_ids: ["checkride_passed", "workspace_verified"],
      source_refs: ["component:InvoiceForm", "route:/invoices"],
    });

    expect(left.record_hash).toBe(right.record_hash);
    expect(left.ledger_head_hash).toBe(left.record_hash);
    expect(left.previous_hash).toBe(PREVIOUS_HASH);
    expect(left.claim_ids).toEqual(["checkride_passed", "workspace_verified"]);
    expect(left.source_refs).toEqual(["component:InvoiceForm", "route:/invoices"]);
    expect(left.signature).toBeNull();
  });

  it("changes record hash when material evidence fields change", () => {
    const baseline = buildDojoEvidenceLedgerRecord(baseInput());
    const changedArtifact = buildDojoEvidenceLedgerRecord({
      ...baseInput(),
      artifact_sha256: "d".repeat(64),
    });
    const changedPrevious = buildDojoEvidenceLedgerRecord({
      ...baseInput(),
      previous_hash: "e".repeat(64),
    });

    expect(changedArtifact.record_hash).not.toBe(baseline.record_hash);
    expect(changedPrevious.record_hash).not.toBe(baseline.record_hash);
  });

  it("normalizes retention legal hold and nullable redaction fields", () => {
    const record = buildDojoEvidenceLedgerRecord({
      ...baseInput(),
      redaction_manifest_sha256: undefined,
      retention_class: "legal_hold",
    });

    expect(record.redaction_manifest_sha256).toBeNull();
    expect(record.legal_hold).toBe(true);
  });

  it("validates SHA-256 digests and required identifiers", () => {
    expect(() => buildDojoEvidenceLedgerRecord({ ...baseInput(), artifact_sha256: "not-a-digest" })).toThrow(
      "dojo_evidence_artifact_sha256_sha256_required"
    );
    expect(() => buildDojoEvidenceLedgerRecord({ ...baseInput(), record_id: "" })).toThrow(
      "dojo_evidence_record_id_required"
    );
  });

  it("builds ledger checkpoints with validated head hash and count", () => {
    const checkpoint = buildDojoLedgerCheckpoint({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      ledger_head_hash: PREVIOUS_HASH,
      record_count: 3,
      created_at: "2026-06-11T00:00:00.000Z",
    });

    expect(checkpoint).toEqual({
      schema_version: "synthi.dojo.ledgerCheckpoint.v1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      ledger_head_hash: PREVIOUS_HASH,
      record_count: 3,
      created_at: "2026-06-11T00:00:00.000Z",
    });
    expect(() => buildDojoLedgerCheckpoint({ ...checkpoint, record_count: -1 })).toThrow(
      "dojo_ledger_record_count_invalid"
    );
  });

  it("canonicalizes object key order recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe("{\"a\":{\"c\":3,\"d\":2},\"b\":1}");
  });
});

function baseInput(): DojoEvidenceRecordInput {
  return {
    record_id: "evidence-a",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    kind: "checkride",
    artifact_uri: "sha256://artifact-a",
    artifact_sha256: ARTIFACT_HASH,
    redaction_manifest_sha256: REDACTION_HASH,
    claim_ids: ["checkride_passed"],
    previous_hash: PREVIOUS_HASH,
    signer_key_id: "key-a",
    created_at: "2026-06-11T00:00:00.000Z",
    created_by: "dojo-checkride",
    retention_class: "standard",
    legal_hold: false,
    source_refs: ["trace:trace-a"],
  };
}
