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
import { createDojoLicenseKernel, evaluateDojoLicenseKernel } from "../../src/dojo/license/kernel.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import type { DojoPermissionLicenseRecord } from "../../src/dojo/store/interfaces.js";
import { verifiedProofEvidenceInput } from "./dojo_test_fixtures.js";

beforeEach(() => {
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
});

describe("Dojo proof error taxonomy", () => {
  it("exposes the license kernel through the stable Dojo module boundary", () => {
    expect(createDojoLicenseKernel().evaluate).toBe(evaluateDojoLicenseKernel);
  });

  it("normalizes proof and license failure reasons to stable codes", () => {
    expect(normalizeDojoProofErrorCode("proof_capsule_not_issued_by_registry")).toBe("proof_capsule_not_issued");
    expect(normalizeDojoProofErrorCode("missing_evidence_claim:checkride_passed")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("evidence_claim_missing:guardrails_active")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("evidence_claim_scope_mismatch:workspace_verified")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("evidence_claim_stale:evidence_fresh")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("evidence_claim_refs_missing:checkride_passed")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("missing_context_claim:workspace_verified")).toBe("proof_context_claim_unverified");
    expect(normalizeDojoProofErrorCode("app_origin_mismatch")).toBe("origin_mismatch");
    expect(normalizeDojoProofErrorCode("guardrail_not_active:guard_1")).toBe("guardrail_failed");
    expect(normalizeDojoProofErrorCode("approval_constraint:human_confirmation_required")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("approval_not_granted")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("approval_evidence_required")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("approval_evidence_claim_unverified")).toBe("approval_required");
    expect(normalizeDojoProofErrorCode("license_record_missing")).toBe("license_revoked");
    expect(normalizeDojoProofErrorCode("license_superseded")).toBe("license_revoked");
    expect(normalizeDojoProofErrorCode("license_record_expiry_invalid")).toBe("license_expired");
    expect(normalizeDojoProofErrorCode("license_expiry_invalid")).toBe("license_expired");
    expect(normalizeDojoProofErrorCode("proof_self_attestation_not_allowed_in_production")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("proof_validator_missing")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("api_tool_proof_capsule_required")).toBe("proof_capsule_missing");
    expect(normalizeDojoProofErrorCode("api_tool_proof_validator_required")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("api_tool_graph_proof_required")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("api_tool_graph_proof_mismatch")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_proof_skill_mismatch")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_proof_skill_version_mismatch")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_proof_license_version_mismatch")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_proof_action_mismatch")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_skill_bus_proof_validator_unconfigured")).toBe("proof_capsule_invalid");
    expect(normalizeDojoProofErrorCode("dojo_mcp_proof_substrate_not_allowed")).toBe("substrate_not_allowed");
    expect(normalizeDojoProofErrorCode("api_tool_proof_evidence_claim_unverified:checkride_passed")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("api_tool_proof_evidence_records_required")).toBe("proof_evidence_claim_unverified");
    expect(normalizeDojoProofErrorCode("api_tool_auth_scope_missing")).toBe("action_not_licensed");
    expect(normalizeDojoProofErrorCode("api_tool_compiled_tool_required")).toBe("dojo_execution_policy_blocked");
    expect(normalizeDojoProofErrorCode("api_tool_transport_required")).toBe("dojo_execution_policy_blocked");
    expect(normalizeDojoProofErrorCode("api_tool_evidence_writer_required")).toBe("dojo_execution_policy_blocked");
    expect(normalizeDojoProofErrorCode("api_tool_evidence_write_failed")).toBe("dojo_execution_policy_blocked");
    expect(normalizeDojoProofErrorCode("substrate_executor_required")).toBe("dojo_execution_policy_blocked");
    expect(normalizeDojoProofErrorCode("substrate_not_allowed")).toBe("substrate_not_allowed");
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

    const strictSelfAttestedApproval = evaluateDojoLicenseKernel({
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
      now: "2026-06-11T00:02:00.000Z",
      require_verified_approval_evidence: true,
    });

    expect(strictSelfAttestedApproval).toEqual(expect.objectContaining({
      ok: false,
      status: "approval_required",
      blocked_by: expect.arrayContaining(["approval_evidence_claim_unverified"]),
      error_codes: ["approval_required"],
    }));

    const baseEvidence = verifiedProofEvidenceInput(gatedSkill).evidence_ledger_records[0]!;
    const approvalEvidence = buildDojoEvidenceLedgerRecord({
      record_id: "approval-a",
      tenant_id: "legacy-local-tenant",
      workspace_id: gatedSkill.workspace_id,
      skill_id: gatedSkill.skill_id,
      run_id: `approval-${gatedSkill.skill_id}`,
      kind: "audit",
      artifact_uri: "memory://dojo/tests/approval-a",
      artifact_sha256: "d".repeat(64),
      claim_ids: ["approval_granted"],
      previous_hash: baseEvidence.record_hash,
      created_at: "2026-06-11T00:00:30.000Z",
      created_by: "dojo-test-fixture",
      retention_class: "ephemeral",
    });
    const approvalCapsule = issueDojoProofCapsule(gatedSkill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_claims: [{ claim: "approval_granted", satisfied: true, evidence_refs: ["evidence:approval-a"] }],
      evidence_ledger_records: [baseEvidence, approvalEvidence],
      require_verified_evidence: true,
      now: "2026-06-11T00:01:00.000Z",
      expires_at: "2026-06-11T00:16:00.000Z",
    });
    dojoSkillRegistry.recordProofCapsule(approvalCapsule);

    const verifiedApproval = evaluateDojoLicenseKernel({
      skill: gatedSkill,
      registry: dojoSkillRegistry,
      proof_capsule: approvalCapsule,
      requested_action: "run_workflow",
      tool_args: {
        approval_id: "approval-a",
        actor_id: "reviewer-a",
        actor_type: "human",
        approval_evidence_ref: "evidence:approval-a",
      },
      now: "2026-06-11T00:02:00.000Z",
      require_verified_approval_evidence: true,
    });

    expect(verifiedApproval).toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      blocked_by: [],
      error_codes: [],
      runtime_claims: expect.objectContaining({
        approval_evidence_verified: true,
        approval_evidence_record_ids: ["approval-a"],
      }),
    }));
  });

  it("honors durable license record status when required", () => {
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
    dojoSkillRegistry.recordProofCapsule(capsule);
    const activeLicenseRecord = licenseRecordFor(skill, "active");

    expect(evaluateDojoLicenseKernel({
      skill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      license_record: activeLicenseRecord,
      require_durable_license: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      blocked_by: [],
      error_codes: [],
      license_record: expect.objectContaining({ status: "active" }),
    }));

    expect(evaluateDojoLicenseKernel({
      skill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      license_record: null,
      require_durable_license: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expect.arrayContaining(["license_record_missing"]),
      error_codes: ["license_revoked"],
    }));

    expect(evaluateDojoLicenseKernel({
      skill,
      registry: dojoSkillRegistry,
      proof_capsule: capsule,
      requested_action: "run_workflow",
      license_record: {
        ...activeLicenseRecord,
        status: "revoked",
        revoked_at: "2026-06-11T00:00:30.000Z",
        revoked_reason: "operator_policy_change",
      },
      require_durable_license: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expect.arrayContaining(["license_revoked"]),
      error_codes: ["license_revoked"],
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

function licenseRecordFor(skill: ReturnType<typeof buildDojoSkill>, status: DojoPermissionLicenseRecord["status"]): DojoPermissionLicenseRecord {
  return {
    tenant_id: "legacy-local-tenant",
    workspace_id: skill.workspace_id,
    license_id: skill.permission_license.license_id,
    skill_id: skill.skill_id,
    license_version: skill.permission_license.license_version,
    status,
    entrustment_level: skill.permission_license.entrustment_level,
    readiness_level: skill.readiness_level,
    license_json: skill.permission_license,
    expires_at: skill.license_expires_at,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
  };
}
