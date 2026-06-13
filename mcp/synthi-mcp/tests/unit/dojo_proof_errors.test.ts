import { beforeEach, describe, expect, it } from "vitest";
import {
  dojoProofRefusalCategoryFor,
  normalizeDojoProofErrorCode,
} from "../../src/dojo/proof/errors.js";
import {
  buildDojoSkill,
  dojoSkillRegistry,
  issueDojoProofCapsule,
  validateDojoProofCapsule,
} from "../../src/browser/dojo.js";
import { evaluateDojoLicenseKernel } from "../../src/browser/dojo_license_kernel.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { verifiedProofEvidenceInput } from "./dojo_test_fixtures.js";

beforeEach(() => {
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
});

describe("Dojo proof error taxonomy", () => {
  it("normalizes proof and license failure reasons to stable codes", () => {
    expect(normalizeDojoProofErrorCode("proof_capsule_not_issued_by_registry")).toBe("proof_capsule_not_issued");
    expect(normalizeDojoProofErrorCode("missing_evidence_claim:checkride_passed")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("evidence_claim_refs_missing:checkride_passed")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("missing_context_claim:workspace_verified")).toBe("proof_context_claim_unverified");
    expect(normalizeDojoProofErrorCode("app_origin_mismatch")).toBe("origin_mismatch");
    expect(normalizeDojoProofErrorCode("guardrail_not_active:guard_1")).toBe("guardrail_failed");
    expect(normalizeDojoProofErrorCode("approval_constraint:human_confirmation_required")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("approval_not_granted")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("approval_evidence_required")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("license_expiry_invalid")).toBe("license_expired");
    expect(normalizeDojoProofErrorCode("proof_self_attestation_not_allowed_in_production")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("unexpected-low-level-detail")).toBe("unknown");
  });

  it("maps normalized codes to refusal categories", () => {
    expect(dojoProofRefusalCategoryFor("proof_capsule_replay_detected")).toBe("proof_replay_or_revocation");
    expect(dojoProofRefusalCategoryFor("proof_evidence_claim_unverified")).toBe("claim_verification_failed");
    expect(dojoProofRefusalCategoryFor("action_not_licensed")).toBe("license_scope_failed");
    expect(dojoProofRefusalCategoryFor("guardrail_failed")).toBe("approval_or_guardrail_required");
  });

  it("adds normalized error codes to capsule validation failures", () => {
    const skill = buildDojoSkill(workflowContract(), {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    const tampered = { ...capsule, context_claims: { workspace_verified: false } };
    const validation = validateDojoProofCapsule(skill, tampered, "run_workflow", "2026-06-11T00:01:00.000Z");

    expect(validation.ok).toBe(false);
    expect(validation.blocked_by).toEqual(expect.arrayContaining([
      "proof_capsule_signature_invalid",
      "missing_context_claim:workspace_verified",
    ]));
    expect(validation.error_codes).toEqual(expect.arrayContaining([
      "proof_signature_invalid",
      "proof_context_claim_unverified",
    ]));
  });

  it("adds normalized error codes to license-kernel registry failures", () => {
    const skill = buildDojoSkill(workflowContract(), {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    dojoSkillRegistry.publish(skill);
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    const decision = evaluateDojoLicenseKernel({
      skill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(decision.ok).toBe(false);
    expect(decision.blocked_by).toContain("proof_capsule_not_issued_by_registry");
    expect(decision.error_codes).toContain("proof_capsule_not_issued");
    expect(decision.validation.error_codes).toContain("proof_capsule_not_issued");
  });

  it("blocks license-kernel execution when license expiry metadata is malformed", () => {
    const skill = buildDojoSkill(workflowContract(), {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    const malformedLicenseSkill = {
      ...skill,
      license_expires_at: "not-a-date",
    };
    dojoSkillRegistry.publish(malformedLicenseSkill);
    const capsule = issueDojoProofCapsule(malformedLicenseSkill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(malformedLicenseSkill),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    dojoSkillRegistry.recordProofCapsule(capsule);

    const decision = evaluateDojoLicenseKernel({
      skill: malformedLicenseSkill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(decision.ok).toBe(false);
    expect(decision.status).toBe("blocked");
    expect(decision.blocked_by).toContain("license_expiry_invalid");
    expect(decision.error_codes).toContain("license_expired");
    expect(decision.validation.error_codes).toContain("license_expired");
  });

  it("blocks proof capsules when persisted record metadata no longer matches the capsule", () => {
    const store = new InMemoryDojoSkillStore();
    dojoSkillRegistry.useStoreForTests(store);
    const skill = buildDojoSkill(workflowContract(), {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    dojoSkillRegistry.publish(skill);
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const record = dojoSkillRegistry.recordProofCapsule(capsule, { tenant_id: "tenant-a" });
    store.saveProofRecord({
      ...record,
      tenant_id: "tenant-b",
      workspace_id: "workspace-b",
      license_id: "license-other",
      license_version: "2.0.0",
      key_id: "key-other",
      signature_algorithm: "ed25519",
      issued_at: "2026-06-11T00:00:30.000Z",
      expires_at: "2026-06-11T00:30:00.000Z",
      substrate_claim: capsule.substrate_claim === "mcp" ? "dom" : "mcp",
      evidence_record_ids: ["evidence-other"],
      ledger_checkpoint_hash: "ledger-other",
    });

    const decision = evaluateDojoLicenseKernel({
      skill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      tool_args: { tenant_id: "tenant-a" },
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(decision.ok).toBe(false);
    expect(decision.blocked_by).toEqual(expect.arrayContaining([
      "proof_record_tenant_mismatch",
      "proof_record_workspace_mismatch",
      "proof_record_license_mismatch",
      "proof_record_license_version_mismatch",
      "proof_record_key_mismatch",
      "proof_record_signature_algorithm_mismatch",
      "proof_record_issued_at_mismatch",
      "proof_record_expires_at_mismatch",
      "proof_record_substrate_mismatch",
      "proof_record_evidence_mismatch",
      "proof_record_ledger_checkpoint_mismatch",
    ]));
    expect(decision.error_codes).toContain("proof_capsule_registry_mismatch");
    expect(decision.validation.error_codes).toContain("proof_capsule_registry_mismatch");
  });

  it("requires approved actor context before allowing gated license actions", () => {
    const skill = buildDojoSkill(workflowContract(), {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    const gatedSkill = {
      ...skill,
      permission_license: {
        ...skill.permission_license,
        gated_actions: [
          ...skill.permission_license.gated_actions,
          { action: "run_workflow", constraints: ["human_confirmation_required"] },
        ],
        approval_requirements: [...new Set([...skill.permission_license.approval_requirements, "run_workflow"])],
      },
    };
    dojoSkillRegistry.publish(gatedSkill);
    const capsule = issueDojoProofCapsule(gatedSkill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(gatedSkill),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    dojoSkillRegistry.recordProofCapsule(capsule);

    const missingApproval = evaluateDojoLicenseKernel({
      skill: gatedSkill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(missingApproval).toEqual(expect.objectContaining({
      ok: false,
      status: "approval_required",
      error_codes: ["approval_required"],
      blocked_by: expect.arrayContaining([
        "approval_constraint:human_confirmation_required",
        "approval_required",
        "approval_not_granted",
        "approval_actor_required",
        "approval_actor_type_required",
        "approval_evidence_required",
      ]),
    }));

    const booleanOnlyApproval = evaluateDojoLicenseKernel({
      skill: gatedSkill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      tool_args: {
        approval_id: "approval-a",
        approval_granted: true,
        approval_evidence_ref: "evidence:approval-a",
        actor_id: "reviewer-a",
        actor_type: "human",
      },
      now: "2026-06-11T00:01:30.000Z",
    });

    expect(booleanOnlyApproval).toEqual(expect.objectContaining({
      ok: false,
      status: "approval_required",
      blocked_by: expect.arrayContaining(["approval_not_granted"]),
      error_codes: ["approval_required"],
    }));

    const approved = evaluateDojoLicenseKernel({
      skill: gatedSkill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      tool_args: {
        approval_id: "approval-a",
        approval_status: "approved",
        actor_id: "reviewer-a",
        actor_type: "human",
        approval_evidence_ref: "evidence:approval-a",
      },
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      blocked_by: [],
      error_codes: [],
      runtime_claims: expect.objectContaining({
        actor_id: "reviewer-a",
        actor_type: "human",
        approval_id: "approval-a",
        approval_evidence_ref: "evidence:approval-a",
      }),
    }));
    expect(approved.validation).toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      blocked_by: [],
      error_codes: [],
    }));
  });
});

function workflowContract() {
  return compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract;
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
