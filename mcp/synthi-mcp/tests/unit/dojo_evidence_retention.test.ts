import { describe, expect, it } from "vitest";
import {
  buildDojoEvidenceRetentionPlan,
  evaluateDojoEvidenceRetention,
} from "../../src/dojo/evidence/retention.js";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRetentionClass } from "../../src/dojo/evidence/types.js";

describe("Dojo evidence retention policy", () => {
  it("preserves append-only ledger rows while marking expired artifacts for purge", () => {
    const decision = evaluateDojoEvidenceRetention(recordFixture({
      record_id: "evidence-expired",
      retention_class: "ephemeral",
      created_at: "2026-06-01T00:00:00.000Z",
    }), {
      now: "2026-06-11T00:00:00.000Z",
      policy: {
        class_ttl_ms: { ephemeral: days(2) },
        purge_grace_ms: days(1),
      },
    });

    expect(decision).toEqual(expect.objectContaining({
      record_id: "evidence-expired",
      disposition: "purge_artifact",
      artifact_action: "purge",
      ledger_record_action: "preserve_append_only_record",
      expires_at: "2026-06-03T00:00:00.000Z",
      purge_eligible_at: "2026-06-04T00:00:00.000Z",
      blocked_by: [],
    }));
  });

  it("uses redaction grace before purge grace", () => {
    const decision = evaluateDojoEvidenceRetention(recordFixture({
      record_id: "evidence-redact",
      retention_class: "standard",
      created_at: "2026-06-01T00:00:00.000Z",
    }), {
      now: "2026-06-04T12:00:00.000Z",
      policy: {
        class_ttl_ms: { standard: days(2) },
        redaction_grace_ms: 0,
        purge_grace_ms: days(7),
      },
    });

    expect(decision.disposition).toBe("redact_artifact");
    expect(decision.artifact_action).toBe("redact");
    expect(decision.redaction_eligible_at).toBe("2026-06-03T00:00:00.000Z");
    expect(decision.purge_eligible_at).toBe("2026-06-10T00:00:00.000Z");
  });

  it("blocks deletion when legal hold is active even if the record is old", () => {
    const decision = evaluateDojoEvidenceRetention(recordFixture({
      record_id: "evidence-hold",
      retention_class: "legal_hold",
      legal_hold: true,
      created_at: "2020-01-01T00:00:00.000Z",
    }), {
      now: "2026-06-11T00:00:00.000Z",
      policy: {
        class_ttl_ms: { legal_hold: days(1) },
      },
    });

    expect(decision).toEqual(expect.objectContaining({
      disposition: "blocked_legal_hold",
      artifact_action: "retain",
      ledger_record_action: "preserve_append_only_record",
      expires_at: null,
      blocked_by: ["evidence_legal_hold_active"],
    }));
  });

  it("fails closed for records created in the future", () => {
    const decision = evaluateDojoEvidenceRetention(recordFixture({
      record_id: "evidence-future",
      created_at: "2026-06-12T00:00:00.000Z",
    }), {
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(decision.disposition).toBe("retain");
    expect(decision.blocked_by).toEqual(["evidence_retention_record_created_in_future"]);
  });

  it("builds a scoped retention plan and reports excluded records", () => {
    const plan = buildDojoEvidenceRetentionPlan({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
      policy: {
        class_ttl_ms: { ephemeral: days(1), standard: days(365) },
        purge_grace_ms: 0,
      },
      records: [
        recordFixture({ record_id: "expired", retention_class: "ephemeral", created_at: "2026-06-01T00:00:00.000Z" }),
        recordFixture({ record_id: "active", retention_class: "standard", created_at: "2026-06-10T00:00:00.000Z" }),
        recordFixture({ record_id: "other-tenant", tenant_id: "tenant-b" }),
      ],
    });

    expect(plan).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.evidenceRetentionPlan.v1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      record_count: 2,
      disposition_counts: {
        retain: 1,
        redact_artifact: 0,
        purge_artifact: 1,
        blocked_legal_hold: 0,
      },
      blocked_by: ["evidence_retention_scope_excluded:1"],
    }));
    expect(plan.decisions.map((decision) => decision.record_id)).toEqual(["expired", "active"]);
  });
});

function recordFixture(overrides: Partial<DojoEvidenceLedgerRecord> = {}): DojoEvidenceLedgerRecord {
  const retentionClass = overrides.retention_class ?? "standard";
  return {
    schema_version: "synthi.dojo.evidenceRecord.v1",
    record_id: "evidence-a",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    kind: "checkride",
    artifact_uri: "sha256://artifact-a",
    artifact_sha256: "a".repeat(64),
    redaction_manifest_sha256: "b".repeat(64),
    claim_ids: ["checkride_passed"],
    previous_hash: "0".repeat(64),
    record_hash: "c".repeat(64),
    ledger_head_hash: "c".repeat(64),
    signer_key_id: "key-a",
    signature: "hmac-sha256:".concat("d".repeat(64)),
    created_at: "2026-06-01T00:00:00.000Z",
    created_by: "dojo-checkride",
    retention_class: retentionClass as DojoEvidenceRetentionClass,
    legal_hold: retentionClass === "legal_hold",
    source_refs: ["trace:trace-a"],
    ...overrides,
  };
}

function days(value: number): number {
  return value * 24 * 60 * 60 * 1000;
}
