import { describe, expect, it } from "vitest";
import {
  buildDojoSkill,
  issueDojoProofCapsule,
  validateDojoProofCapsule,
} from "../../src/browser/dojo.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceLedgerRecord } from "../../src/dojo/evidence/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

describe("Dojo proof issuance evidence claims", () => {
  it("signs verified evidence record IDs and ledger checkpoint into strict proof capsules", () => {
    const skill = skillFixture();
    const record = evidenceRecord("evidence-a", skill.skill_id, skill.permission_license.proof_requirements.required_evidence_claims, "2026-06-11T00:00:00.000Z");

    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [record],
      require_verified_evidence: true,
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(capsule.evidence_record_ids).toEqual(["evidence-a"]);
    expect(capsule.ledger_checkpoint_hash).toBe(record.ledger_head_hash);
    expect(capsule.evidence_claims).toEqual(
      skill.permission_license.proof_requirements.required_evidence_claims.map((claim) => ({
        claim,
        satisfied: true,
        evidence_refs: ["evidence:evidence-a"],
      }))
    );
    expect(validateDojoProofCapsule(skill, capsule, "run_workflow", "2026-06-11T00:06:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
    );
  });

  it("blocks strict proof issuance when required evidence claims are missing", () => {
    const skill = skillFixture();
    const [firstClaim] = skill.permission_license.proof_requirements.required_evidence_claims;
    const record = evidenceRecord("evidence-a", skill.skill_id, [firstClaim ?? "workspace_verified"], "2026-06-11T00:00:00.000Z");

    expect(() => issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [record],
      require_verified_evidence: true,
      now: "2026-06-11T00:05:00.000Z",
    })).toThrow(/dojo_proof_evidence_claim_unverified:/);
  });

  it("blocks strict proof issuance when backing evidence is stale", () => {
    const skill = skillFixture();
    const record = evidenceRecord("evidence-old", skill.skill_id, skill.permission_license.proof_requirements.required_evidence_claims, "2026-06-10T00:00:00.000Z");

    expect(() => issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [record],
      evidence_max_age_ms: 60 * 1000,
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
    })).toThrow(/dojo_proof_evidence_claim_unverified:/);
  });

  it("keeps development-compatible proof issuance available without strict evidence", () => {
    const skill = skillFixture();

    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(capsule.evidence_record_ids).toEqual([]);
    expect(capsule.ledger_checkpoint_hash).toBeUndefined();
    expect(capsule.evidence_claims.length).toBeGreaterThan(0);
    expect(validateDojoProofCapsule(skill, capsule, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
    );
  });
});

function skillFixture() {
  return buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
  });
}

function evidenceRecord(recordId: string, skillId: string, claimIds: string[], createdAt: string): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    record_id: recordId,
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: skillId,
    run_id: "run-a",
    kind: "checkride",
    artifact_uri: `sha256://${recordId}`,
    artifact_sha256: "a".repeat(64),
    redaction_manifest_sha256: "b".repeat(64),
    claim_ids: claimIds,
    previous_hash: "0".repeat(64),
    created_at: createdAt,
    created_by: "dojo-checkride",
    retention_class: "standard",
  });
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
