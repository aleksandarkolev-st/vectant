import { describe, expect, it } from "vitest";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import { InMemoryDojoEvidenceClaimVerifier, resolveDojoEvidenceClaims } from "../../src/dojo/evidence/verifier.js";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput } from "../../src/dojo/evidence/types.js";

describe("Dojo evidence claim verifier", () => {
  it("verifies claims backed by fresh evidence records", () => {
    const records = [
      evidenceRecord("record-a", ["workspace_verified", "checkride_passed"], "2026-06-11T00:00:00.000Z"),
    ];

    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified", "checkride_passed"],
      records,
      checked_at: "2026-06-11T00:05:00.000Z",
      max_age_ms: 10 * 60 * 1000,
    })).toEqual([
      expect.objectContaining({
        claim_id: "workspace_verified",
        ok: true,
        status: "verified",
        evidence_record_ids: ["record-a"],
      }),
      expect.objectContaining({
        claim_id: "checkride_passed",
        ok: true,
        status: "verified",
        evidence_record_ids: ["record-a"],
      }),
    ]);
  });

  it("returns missing for claims without backing records", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["guardrails_active"],
      records: [evidenceRecord("record-a", ["workspace_verified"], "2026-06-11T00:00:00.000Z")],
      checked_at: "2026-06-11T00:05:00.000Z",
    })).toEqual([
      {
        claim_id: "guardrails_active",
        ok: false,
        status: "missing",
        evidence_record_ids: [],
        checked_at: "2026-06-11T00:05:00.000Z",
        blocked_by: ["evidence_claim_missing:guardrails_active"],
      },
    ]);
  });

  it("returns stale when evidence is older than the requested max age", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified"],
      records: [evidenceRecord("record-old", ["workspace_verified"], "2026-06-10T00:00:00.000Z")],
      checked_at: "2026-06-11T00:00:00.000Z",
      max_age_ms: 60 * 1000,
    })).toEqual([
      {
        claim_id: "workspace_verified",
        ok: false,
        status: "stale",
        evidence_record_ids: ["record-old"],
        checked_at: "2026-06-11T00:00:00.000Z",
        blocked_by: ["evidence_claim_stale:workspace_verified"],
      },
    ]);
  });

  it("fails claims when the verification timestamp is malformed", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified"],
      records: [evidenceRecord("record-a", ["workspace_verified"], "2026-06-11T00:00:00.000Z")],
      checked_at: "not-a-date",
      max_age_ms: 60 * 1000,
    })).toEqual([
      {
        claim_id: "workspace_verified",
        ok: false,
        status: "failed",
        evidence_record_ids: ["record-a"],
        checked_at: "not-a-date",
        blocked_by: ["evidence_claim_checked_at_invalid:workspace_verified"],
      },
    ]);
  });

  it("fails claims backed only by records with malformed timestamps", () => {
    const malformedRecord = {
      ...evidenceRecord("record-malformed", ["workspace_verified"], "2026-06-11T00:00:00.000Z"),
      created_at: "not-a-date",
    };

    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified"],
      records: [malformedRecord],
      checked_at: "2026-06-11T00:05:00.000Z",
      max_age_ms: 60 * 1000,
    })).toEqual([
      {
        claim_id: "workspace_verified",
        ok: false,
        status: "failed",
        evidence_record_ids: ["record-malformed"],
        checked_at: "2026-06-11T00:05:00.000Z",
        blocked_by: ["evidence_record_timestamp_invalid:workspace_verified"],
      },
    ]);
  });

  it("fails claims backed only by records created after the verification time", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified"],
      records: [evidenceRecord("record-future", ["workspace_verified"], "2026-06-11T00:10:00.000Z")],
      checked_at: "2026-06-11T00:05:00.000Z",
      max_age_ms: 60 * 1000,
    })).toEqual([
      {
        claim_id: "workspace_verified",
        ok: false,
        status: "failed",
        evidence_record_ids: ["record-future"],
        checked_at: "2026-06-11T00:05:00.000Z",
        blocked_by: ["evidence_record_created_after_check:workspace_verified"],
      },
    ]);
  });

  it("fails claims backed only by records outside the requested evidence scope", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["workspace_verified"],
      records: [
        evidenceRecord("record-other-workspace", ["workspace_verified"], "2026-06-11T00:00:00.000Z", {
          workspace_id: "workspace-other",
        }),
      ],
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      checked_at: "2026-06-11T00:05:00.000Z",
      max_age_ms: 10 * 60 * 1000,
    })).toEqual([
      {
        claim_id: "workspace_verified",
        ok: false,
        status: "failed",
        evidence_record_ids: ["record-other-workspace"],
        checked_at: "2026-06-11T00:05:00.000Z",
        blocked_by: ["evidence_claim_scope_mismatch:workspace_verified"],
      },
    ]);
  });

  it("treats evidence_fresh as a freshness claim over any evidence record", () => {
    expect(resolveDojoEvidenceClaims({
      claim_ids: ["evidence_fresh"],
      records: [evidenceRecord("record-a", ["workspace_verified"], "2026-06-10T23:59:30.000Z")],
      checked_at: "2026-06-11T00:00:00.000Z",
      max_age_ms: 60 * 1000,
    })).toEqual([
      expect.objectContaining({
        claim_id: "evidence_fresh",
        ok: true,
        status: "verified",
        evidence_record_ids: ["record-a"],
      }),
    ]);
  });

  it("deduplicates requested claims and supports the async verifier interface", async () => {
    const verifier = new InMemoryDojoEvidenceClaimVerifier();
    const result = await verifier.resolveClaims({
      claim_ids: ["workspace_verified", "workspace_verified"],
      records: [evidenceRecord("record-a", ["workspace_verified"], "2026-06-11T00:00:00.000Z")],
      checked_at: "2026-06-11T00:00:00.000Z",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ ok: true, status: "verified" }));
  });
});

function evidenceRecord(
  recordId: string,
  claimIds: string[],
  createdAt: string,
  overrides: Partial<DojoEvidenceRecordInput> = {}
): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    ...baseInput(recordId, createdAt),
    ...overrides,
    claim_ids: claimIds,
  });
}

function baseInput(recordId: string, createdAt: string): DojoEvidenceRecordInput {
  return {
    record_id: recordId,
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    kind: "checkride",
    artifact_uri: `sha256://${recordId}`,
    artifact_sha256: "a".repeat(64),
    redaction_manifest_sha256: "b".repeat(64),
    claim_ids: ["workspace_verified"],
    previous_hash: "0".repeat(64),
    created_at: createdAt,
    created_by: "dojo-checkride",
    retention_class: "standard",
  };
}
