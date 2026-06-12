import { describe, expect, it } from "vitest";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceLedgerRecord } from "../../src/dojo/evidence/types.js";
import { buildDojoRedactedEvidenceExportManifest } from "../../src/dojo/evidence/export.js";
import {
  dojoRedactionDigestHex,
  redactDojoEvidenceArtifact,
} from "../../src/dojo/evidence/redaction.js";

const NOW = "2026-06-11T00:00:00.000Z";

describe("Dojo redacted evidence export", () => {
  it("exports redacted evidence metadata without raw artifact content", () => {
    const content = sensitiveTrace();
    const redaction = redactDojoEvidenceArtifact({
      artifact_kind: "trace",
      content,
      created_at: NOW,
    });
    const record = evidenceRecordFor({
      artifact_sha256: dojoRedactionDigestHex(redaction.manifest.original_sha256),
      redaction_manifest_sha256: dojoRedactionDigestHex(redaction.manifest.manifest_sha256),
    });

    const manifest = buildDojoRedactedEvidenceExportManifest({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      generated_at: NOW,
      artifacts: [{
        artifact_id: "trace-a",
        artifact_kind: "trace",
        content,
        evidence_record: record,
      }],
    });

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("polek");
    expect(manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.redactedEvidenceExport.v1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      artifact_count: 1,
      blocked_by: [],
    }));
    expect(manifest.artifacts[0]).toEqual(expect.objectContaining({
      artifact_id: "trace-a",
      artifact_kind: "trace",
      evidence_record_id: "evidence-a",
      original_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      redacted_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      redaction_manifest_sha256: record.redaction_manifest_sha256,
      redaction_count: expect.any(Number),
      source_refs: ["trace:trace-a"],
    }));
  });

  it("fails closed when a bound evidence record lacks redaction metadata", () => {
    const content = sensitiveTrace();
    const redaction = redactDojoEvidenceArtifact({
      artifact_kind: "trace",
      content,
      created_at: NOW,
    });
    const record = evidenceRecordFor({
      artifact_sha256: dojoRedactionDigestHex(redaction.manifest.original_sha256),
      redaction_manifest_sha256: undefined,
    });

    expect(() => buildDojoRedactedEvidenceExportManifest({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      generated_at: NOW,
      artifacts: [{
        artifact_id: "trace-a",
        artifact_kind: "trace",
        content,
        evidence_record: record,
      }],
    })).toThrow("dojo_evidence_export_redaction_manifest_required");
  });

  it("fails closed when a bound evidence record disagrees with redaction metadata", () => {
    const content = sensitiveTrace();
    const redaction = redactDojoEvidenceArtifact({
      artifact_kind: "trace",
      content,
      created_at: NOW,
    });
    const record = evidenceRecordFor({
      artifact_sha256: dojoRedactionDigestHex(redaction.manifest.original_sha256),
      redaction_manifest_sha256: "c".repeat(64),
    });

    expect(() => buildDojoRedactedEvidenceExportManifest({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      generated_at: NOW,
      artifacts: [{
        artifact_id: "trace-a",
        artifact_kind: "trace",
        content,
        evidence_record: record,
      }],
    })).toThrow("dojo_evidence_export_redaction_manifest_mismatch");
  });

  it("fails closed when a bound evidence record has different tenant scope", () => {
    const content = sensitiveTrace();
    const redaction = redactDojoEvidenceArtifact({
      artifact_kind: "trace",
      content,
      created_at: NOW,
    });
    const record = evidenceRecordFor({
      tenant_id: "tenant-b",
      artifact_sha256: dojoRedactionDigestHex(redaction.manifest.original_sha256),
      redaction_manifest_sha256: dojoRedactionDigestHex(redaction.manifest.manifest_sha256),
    });

    expect(() => buildDojoRedactedEvidenceExportManifest({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      generated_at: NOW,
      artifacts: [{
        artifact_id: "trace-a",
        artifact_kind: "trace",
        content,
        evidence_record: record,
      }],
    })).toThrow("dojo_evidence_export_tenant_scope_mismatch");
  });

  it("normalizes prefixed redaction digests to ledger-compatible raw SHA-256 values", () => {
    expect(dojoRedactionDigestHex(`sha256:${"A".repeat(64)}`)).toBe("a".repeat(64));
    expect(dojoRedactionDigestHex("b".repeat(64))).toBe("b".repeat(64));
    expect(() => dojoRedactionDigestHex("sha256:not-a-digest")).toThrow("dojo_redaction_sha256_digest_invalid");
  });
});

function sensitiveTrace(): Record<string, unknown> {
  return {
    url: "https://app.example.test/invoices",
    headers: {
      Authorization: "Bearer secret-token",
    },
    form: {
      email: "person@example.test",
      attachment: "C:\\Users\\polek\\Downloads\\invoice.pdf",
    },
  };
}

function evidenceRecordFor(overrides: {
  tenant_id?: string;
  workspace_id?: string;
  artifact_sha256: string;
  redaction_manifest_sha256?: string;
}): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    record_id: "evidence-a",
    tenant_id: overrides.tenant_id ?? "tenant-a",
    workspace_id: overrides.workspace_id ?? "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    kind: "trace",
    artifact_uri: "sha256://trace-a",
    artifact_sha256: overrides.artifact_sha256,
    redaction_manifest_sha256: overrides.redaction_manifest_sha256,
    claim_ids: ["workspace_verified"],
    previous_hash: "0".repeat(64),
    signer_key_id: "key-a",
    created_at: NOW,
    created_by: "dojo-test",
    retention_class: "standard",
    legal_hold: false,
    source_refs: ["trace:trace-a"],
  });
}
