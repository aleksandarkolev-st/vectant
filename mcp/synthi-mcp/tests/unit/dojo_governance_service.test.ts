import { describe, expect, it } from "vitest";
import type { DojoSkill } from "../../src/browser/dojo.js";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import type {
  DojoGovernanceScheduledJobItem,
  DojoGovernanceScheduledJobKind,
  DojoGovernanceScheduledJobStatus,
} from "../../src/dojo/governance/service.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import { buildDojoProofKeyRecord } from "../../src/dojo/proof/key_registry.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";
import type {
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditStore,
  DojoPermissionUpgradeRequestRecord,
} from "../../src/dojo/store/interfaces.js";
import {
  authorizeDojoGovernanceAction,
  buildDojoGovernanceServiceView,
  buildDojoComplianceEvidenceArchiveManifest,
  buildDojoComplianceEvidencePack,
  decideDojoCaseLawReview,
  decideDojoPermissionUpgradeRequest,
  persistDojoScheduledJobRunAuditEvents,
  queryDojoApprovalQueue,
  queryDojoAuditExports,
  queryDojoCaseLawReviewQueue,
  queryDojoLicenseHealth,
  queryDojoPolicyGates,
  queryDojoRecertificationQueue,
  queryDojoScheduledJobs,
  queryDojoSkillRegistry,
  revokeDojoSkillLicense,
  runDojoScheduledGovernanceJobs,
} from "../../src/dojo/governance/service.js";

describe("Dojo governance service", () => {
  it("reports expired and active license health", () => {
    const health = queryDojoLicenseHealth({
      skills: [
        skillFixture({ skillId: "skill-expired", expiresAt: "2026-06-01T00:00:00.000Z" }),
        skillFixture({ skillId: "skill-active", expiresAt: "2026-07-11T00:00:00.000Z" }),
      ],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(health[0]).toEqual(expect.objectContaining({
      skill_id: "skill-expired",
      status: "expired",
      days_until_expiry: -10,
    }));
    expect(health[1]).toEqual(expect.objectContaining({
      skill_id: "skill-active",
      status: "active",
      days_until_expiry: 30,
      evidence_refs: expect.arrayContaining([
        "skill:skill-active",
        expect.stringMatching(/^license:/),
        "evidence-passport",
        "evidence-training",
      ]),
    }));
  });

  it("reports revoked licenses before expiry checks", () => {
    const [health] = queryDojoLicenseHealth({
      skills: [
        skillFixture({
          skillId: "skill-revoked",
          expiresAt: "2026-07-11T00:00:00.000Z",
          entrustmentLevel: "EX",
          autonomyLevel: "blocked",
        }),
      ],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(health).toEqual(expect.objectContaining({
      status: "revoked",
      autonomy_level: "blocked",
    }));
  });

  it("fails closed when license health expiry metadata is malformed", () => {
    const [health] = queryDojoLicenseHealth({
      skills: [
        skillFixture({
          skillId: "skill-invalid-expiry",
          expiresAt: "not-a-date",
        }),
      ],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(health).toEqual(expect.objectContaining({
      skill_id: "skill-invalid-expiry",
      status: "revoked",
      days_until_expiry: null,
      recertification_triggers: expect.arrayContaining(["license_expiry_invalid"]),
    }));
  });

  it("authorizes governance actions from generic RBAC roles", () => {
    expect(authorizeDojoGovernanceAction({
      action: "permission_upgrade_review",
      tenant_context: tenantContextFixture({ roles: ["dojo:license:review"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:license:review"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "case_law_review",
      tenant_context: tenantContextFixture({ roles: ["dojo:operator"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:operator"],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "license_revocation",
      tenant_context: tenantContextFixture({ roles: ["finance:reviewer"] }),
      policy: {
        action_roles: {
          license_revocation: ["finance:reviewer"],
        },
      },
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["finance:reviewer"],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "license_recertification",
      tenant_context: tenantContextFixture({ roles: ["dojo:license:recertify"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:license:recertify"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "compliance_export",
      tenant_context: tenantContextFixture({ roles: ["dojo:auditor"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:auditor"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "skill_publication",
      tenant_context: tenantContextFixture({ roles: ["dojo:skill:publish"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:skill:publish"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "checkride_run",
      tenant_context: tenantContextFixture({ roles: ["dojo:checkride:run"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:checkride:run"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "practice_run",
      tenant_context: tenantContextFixture({ roles: ["dojo:practice:run"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:practice:run"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "registry_view",
      tenant_context: tenantContextFixture({ roles: ["dojo:registry:view"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:registry:view"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "metrics_view",
      tenant_context: tenantContextFixture({ roles: ["dojo:metrics:view"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:metrics:view"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "artifact_export",
      tenant_context: tenantContextFixture({ roles: ["dojo:auditor"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:auditor"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "source_drift_expiry",
      tenant_context: tenantContextFixture({ roles: ["dojo:source:apply"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:source:apply"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "source_snapshot_capture",
      tenant_context: tenantContextFixture({ roles: ["source-registry"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["source-registry"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "source_drift_detection",
      tenant_context: tenantContextFixture({ roles: ["dojo:source:review"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:source:review"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "source_affordance_pr_prepare",
      tenant_context: tenantContextFixture({ roles: ["source-registry"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["source-registry"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "source_affordance_pr_branch",
      tenant_context: tenantContextFixture({ roles: ["dojo:source:apply"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:source:apply"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "api_tool_prepare",
      tenant_context: tenantContextFixture({ roles: ["dojo:source:review"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:source:review"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "api_tool_publish",
      tenant_context: tenantContextFixture({ roles: ["dojo:api-tool:publish"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:api-tool:publish"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "hosted_runtime_session_create",
      tenant_context: tenantContextFixture({ roles: ["dojo:runtime:create"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:runtime:create"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "case_law_record",
      tenant_context: tenantContextFixture({ roles: ["dojo:case-law:record"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:case-law:record"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "proof_capsule_issue",
      tenant_context: tenantContextFixture({ roles: ["dojo:proof:issue"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:proof:issue"],
      blocked_by: [],
    }));

    expect(authorizeDojoGovernanceAction({
      action: "proof_capsule_revoke",
      tenant_context: tenantContextFixture({ roles: ["dojo:proof:revoke"] }),
    })).toEqual(expect.objectContaining({
      ok: true,
      matched_roles: ["dojo:proof:revoke"],
      blocked_by: [],
    }));
  });

  it("fails closed for governance actions without required RBAC roles", () => {
    expect(authorizeDojoGovernanceAction({
      action: "governance_view",
      tenant_context: tenantContextFixture({ roles: [] }),
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "governance_actor_roles_required",
        "governance_role_required:dojo:governance:view|dojo:auditor",
      ]),
    }));

    expect(authorizeDojoGovernanceAction({
      action: "case_law_review",
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "governance_tenant_context_required",
        "governance_actor_required",
      ]),
    }));
  });

  it("records permission upgrade approval and denial decisions with review evidence", () => {
    const skill = skillFixture({ skillId: "skill-review" });
    const request = permissionUpgradeRequestFixture(skill);
    const approved = decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:02:00.000Z",
      reason: "Checkride evidence reviewed.",
      evidence_refs: ["evidence-review"],
    });
    const denied = decideDojoPermissionUpgradeRequest({
      request,
      decision: "denied",
      decided_by: { actor_id: "reviewer-b", actor_type: "human" },
      decided_at: "2026-06-11T00:03:00.000Z",
      reason: "Risk scenario still failing.",
      evidence_refs: ["evidence-denial"],
    });

    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      status: "applied",
      blocked_by: [],
      audit_event: expect.objectContaining({
        event_type: "approval_granted",
        actor: { actor_id: "reviewer-a", actor_type: "human" },
        evidence_refs: ["evidence-review"],
      }),
      request: expect.objectContaining({
        status: "approved",
        reviewed_at: "2026-06-11T00:02:00.000Z",
        reviewed_by: { actor_id: "reviewer-a", actor_type: "human" },
        review_reason: "Checkride evidence reviewed.",
        decision_evidence_refs: ["evidence-review"],
        evidence_refs: [`skill:${skill.skill_id}`, "evidence-review"],
      }),
    }));
    expect(denied).toEqual(expect.objectContaining({
      ok: true,
      audit_event: expect.objectContaining({ event_type: "approval_denied" }),
      request: expect.objectContaining({
        status: "denied",
        reviewed_by: { actor_id: "reviewer-b", actor_type: "human" },
        decision_evidence_refs: ["evidence-denial"],
      }),
    }));
  });

  it("enforces RBAC for permission upgrade review decisions when tenant context is supplied", () => {
    const skill = skillFixture({ skillId: "skill-rbac-review" });
    const request = permissionUpgradeRequestFixture(skill);

    const rejected = decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:02:00.000Z",
      evidence_refs: ["evidence-review"],
      tenant_context: tenantContextFixture({ actorId: "reviewer-a", roles: ["dojo:viewer"] }),
    });
    const approved = decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:02:00.000Z",
      evidence_refs: ["evidence-review"],
      tenant_context: tenantContextFixture({ actorId: "reviewer-a", roles: ["dojo:approval:review"] }),
    });

    expect(rejected).toEqual(expect.objectContaining({
      ok: false,
      error: "permission_upgrade_reviewer_role_required",
      blocked_by: ["governance_role_required:dojo:approval:review|dojo:license:review"],
      rbac_authorization: expect.objectContaining({
        action: "permission_upgrade_review",
        roles: ["dojo:viewer"],
      }),
    }));
    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      rbac_authorization: expect.objectContaining({
        action: "permission_upgrade_review",
        matched_roles: ["dojo:approval:review"],
      }),
    }));
  });

  it("rejects permission upgrade decisions when the request is no longer pending", () => {
    const request = permissionUpgradeRequestFixture(skillFixture({ skillId: "skill-final" }));
    request.status = "approved";

    const result = decideDojoPermissionUpgradeRequest({
      request,
      decision: "denied",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:04:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "rejected",
      error: "permission_upgrade_request_not_pending",
      blocked_by: ["request_status:approved"],
      request: expect.objectContaining({ status: "approved" }),
    }));
  });

  it("rejects permission upgrade decisions without reviewer attribution, timestamp, and evidence", () => {
    const request = permissionUpgradeRequestFixture(skillFixture({ skillId: "skill-review-required" }));

    expect(decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "", actor_type: "human" },
      decided_at: "2026-06-11T00:04:00.000Z",
      evidence_refs: ["evidence-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "permission_upgrade_reviewer_required",
      blocked_by: ["reviewer_actor_missing"],
    }));
    expect(decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: undefined as never },
      decided_at: "2026-06-11T00:04:00.000Z",
      evidence_refs: ["evidence-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "permission_upgrade_reviewer_actor_type_required",
      blocked_by: ["reviewer_actor_type_invalid"],
    }));
    expect(decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "not-a-date",
      evidence_refs: ["evidence-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "permission_upgrade_review_timestamp_invalid",
      blocked_by: ["review_timestamp_invalid"],
    }));
    expect(decideDojoPermissionUpgradeRequest({
      request,
      decision: "approved",
      decided_by: { actor_id: "reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:04:00.000Z",
      evidence_refs: [],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "permission_upgrade_review_evidence_required",
      blocked_by: ["review_evidence_missing"],
    }));
  });

  it("records case-law approval and deprecation decisions with review evidence", () => {
    const proposed = externalCaseFixture();
    const approved = decideDojoCaseLawReview({
      case_law: proposed,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:06:00.000Z",
      reason: "Evidence reviewed.",
      evidence_refs: ["evidence-case-review"],
    });
    const deprecated = decideDojoCaseLawReview({
      case_law: approved.case_law,
      decision: "deprecated",
      decided_by: { actor_id: "case-reviewer-b", actor_type: "human" },
      decided_at: "2026-06-11T00:07:00.000Z",
      reason: "Superseded by narrower rule.",
      evidence_refs: ["evidence-superseded"],
      superseded_by: "case-narrower-rule",
    });

    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      status: "applied",
      blocked_by: [],
      audit_event: expect.objectContaining({
        event_type: "case_law_approved",
        actor: { actor_id: "case-reviewer-a", actor_type: "human" },
        reason: "Evidence reviewed.",
        evidence_refs: ["evidence-case-review"],
      }),
      case_law: expect.objectContaining({
        case_id: "case-external",
        status: "approved",
        reviewer: "case-reviewer-a",
        updated_at: "2026-06-11T00:06:00.000Z",
        evidence_refs: ["evidence-external", "evidence-case-review"],
      }),
    }));
    expect(deprecated).toEqual(expect.objectContaining({
      ok: true,
      audit_event: expect.objectContaining({
        event_type: "case_law_deprecated",
        actor: { actor_id: "case-reviewer-b", actor_type: "human" },
        reason: "Superseded by narrower rule.",
      }),
      case_law: expect.objectContaining({
        status: "deprecated",
        reviewer: "case-reviewer-b",
        superseded_by: "case-narrower-rule",
        evidence_refs: ["evidence-external", "evidence-case-review", "evidence-superseded"],
      }),
    }));
  });

  it("enforces RBAC for case-law review decisions when tenant context is supplied", () => {
    const proposed = externalCaseFixture();
    const rejected = decideDojoCaseLawReview({
      case_law: proposed,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:06:00.000Z",
      evidence_refs: ["evidence-case-review"],
      tenant_context: tenantContextFixture({ actorId: "case-reviewer-a", roles: ["dojo:approval:review"] }),
    });
    const approved = decideDojoCaseLawReview({
      case_law: proposed,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:06:00.000Z",
      evidence_refs: ["evidence-case-review"],
      tenant_context: tenantContextFixture({ actorId: "case-reviewer-a", roles: ["dojo:case-law:review"] }),
    });

    expect(rejected).toEqual(expect.objectContaining({
      ok: false,
      error: "case_law_reviewer_role_required",
      blocked_by: ["governance_role_required:dojo:case-law:review"],
    }));
    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      rbac_authorization: expect.objectContaining({
        action: "case_law_review",
        matched_roles: ["dojo:case-law:review"],
      }),
    }));
  });

  it("rejects case-law approval when the record is no longer proposed", () => {
    const record = externalCaseFixture();
    record.status = "approved";

    const result = decideDojoCaseLawReview({
      case_law: record,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:08:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "rejected",
      error: "case_law_review_not_pending",
      blocked_by: ["case_law_status:approved"],
      case_law: expect.objectContaining({ status: "approved" }),
    }));
  });

  it("rejects case-law review decisions without reviewer attribution, timestamp, and evidence", () => {
    const record = externalCaseFixture();

    expect(decideDojoCaseLawReview({
      case_law: record,
      decision: "approved",
      decided_by: { actor_id: "", actor_type: "human" },
      decided_at: "2026-06-11T00:08:00.000Z",
      evidence_refs: ["evidence-case-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "case_law_reviewer_required",
      blocked_by: ["reviewer_actor_missing"],
    }));
    expect(decideDojoCaseLawReview({
      case_law: record,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: undefined as never },
      decided_at: "2026-06-11T00:08:00.000Z",
      evidence_refs: ["evidence-case-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "case_law_reviewer_actor_type_required",
      blocked_by: ["reviewer_actor_type_invalid"],
    }));
    expect(decideDojoCaseLawReview({
      case_law: record,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "not-a-date",
      evidence_refs: ["evidence-case-review"],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "case_law_review_timestamp_invalid",
      blocked_by: ["review_timestamp_invalid"],
    }));
    expect(decideDojoCaseLawReview({
      case_law: record,
      decision: "approved",
      decided_by: { actor_id: "case-reviewer-a", actor_type: "human" },
      decided_at: "2026-06-11T00:08:00.000Z",
      evidence_refs: [],
    })).toEqual(expect.objectContaining({
      ok: false,
      error: "case_law_review_evidence_required",
      blocked_by: ["review_evidence_missing"],
    }));
  });

  it("revokes licenses by deriving blocked scope from existing license actions", () => {
    const skill = skillFixture({
      skillId: "skill-revoke",
      gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
      blockedActions: [{ action: "delete_invoice", constraints: ["never_delete"] }],
      approvalRequirements: ["security_review"],
    });

    const result = revokeDojoSkillLicense({
      skill,
      reason: "operator_escalation",
      revoked_at: "2026-06-11T00:05:00.000Z",
      revoked_by: { actor_id: "operator-a", actor_type: "human" },
      evidence_refs: ["evidence-revocation"],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "applied",
      previous_license_version: "1.0.0",
      revoked_license_version: "1.0.1",
      blocked_actions: ["delete_invoice", "run_workflow", "submit_invoice"],
      audit_event: expect.objectContaining({
        event_type: "license_revoked",
        actor: { actor_id: "operator-a", actor_type: "human" },
        evidence_refs: ["evidence-revocation"],
      }),
    }));
    expect(result.skill).toEqual(expect.objectContaining({
      entrustment_level: "EX",
      skill_readiness_level: 5,
      license_expires_at: "2026-06-11T00:05:00.000Z",
      last_trained_at: "2026-06-11T00:05:00.000Z",
      permission_license: expect.objectContaining({
        license_version: "1.0.1",
        autonomy_level: "blocked",
        allowed_actions: [],
        gated_actions: [],
        approval_requirements: [],
        blocked_actions: [
          { action: "delete_invoice", constraints: ["never_delete", "revoked:operator_escalation"] },
          { action: "run_workflow", constraints: ["proof_capsule_valid", "revoked:operator_escalation"] },
          { action: "submit_invoice", constraints: ["manager_approval", "revoked:operator_escalation"] },
        ],
      }),
      skill_card: expect.objectContaining({
        can_do_alone: [],
        will_ask_before: [],
        will_not_do: ["delete_invoice", "run_workflow", "submit_invoice"],
      }),
      skill_passport: expect.objectContaining({
        entrustment_level: "EX",
        readiness_level: 5,
        license_expires_at: "2026-06-11T00:05:00.000Z",
      }),
      training_report: expect.objectContaining({
        readiness_decision: "License revoked: operator_escalation. Recertification required before production execution.",
        limitations: ["baseline_limit", "revoked:operator_escalation"],
        evidence_refs: ["evidence-training", "evidence-revocation"],
      }),
    }));
    expect(result.skill.retrain_triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "incident", condition: "license_revoked:operator_escalation" }),
    ]));
  });

  it("requires explicit reason and actor attribution for license revocation", () => {
    const skill = skillFixture({ skillId: "skill-revoke-required-audit" });

    expect(() => revokeDojoSkillLicense({
      skill,
      reason: "",
      revoked_by: { actor_id: "operator-a", actor_type: "human" },
    })).toThrow("dojo_license_revocation_reason_required");

    expect(() => revokeDojoSkillLicense({
      skill,
      reason: "policy_review",
      revoked_by: { actor_id: "", actor_type: "human" },
    })).toThrow("dojo_license_revocation_actor_required");

    expect(() => revokeDojoSkillLicense({
      skill,
      reason: "policy_review",
      revoked_by: { actor_id: "operator-a", actor_type: undefined as never },
    })).toThrow("dojo_license_revocation_actor_type_required");

    expect(() => revokeDojoSkillLicense({
      skill,
      reason: "policy_review",
      revoked_by: { actor_id: "operator-a", actor_type: "human" },
      evidence_refs: [],
    })).toThrow("dojo_license_revocation_evidence_required");
  });

  it("enforces RBAC for license revocation when tenant context is supplied", () => {
    const skill = skillFixture({ skillId: "skill-revoke-rbac" });

    expect(() => revokeDojoSkillLicense({
      skill,
      reason: "policy_review",
      revoked_at: "2026-06-11T00:05:00.000Z",
      revoked_by: { actor_id: "operator-a", actor_type: "human" },
      evidence_refs: ["evidence-revocation"],
      tenant_context: tenantContextFixture({ actorId: "operator-a", roles: ["dojo:auditor"] }),
    })).toThrow("dojo_license_revocation_role_required:governance_role_required:dojo:license:revoke");

    const revoked = revokeDojoSkillLicense({
      skill,
      reason: "policy_review",
      revoked_at: "2026-06-11T00:05:00.000Z",
      revoked_by: { actor_id: "operator-a", actor_type: "human" },
      evidence_refs: ["evidence-revocation"],
      tenant_context: tenantContextFixture({ actorId: "operator-a", roles: ["dojo:license:revoke"] }),
    });

    expect(revoked).toEqual(expect.objectContaining({
      ok: true,
      rbac_authorization: expect.objectContaining({
        action: "license_revocation",
        matched_roles: ["dojo:license:revoke"],
      }),
    }));
  });

  it("builds approval queue items from gated actions and explicit requirements", () => {
    const skill = skillFixture({
      skillId: "skill-a",
      gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
      approvalRequirements: ["security_review"],
    });
    const queue = queryDojoApprovalQueue({
      skills: [skill],
      permission_upgrade_requests: [permissionUpgradeRequestFixture(skill)],
    });

    expect(queue).toEqual([
      expect.objectContaining({
        skill_id: "skill-a",
        action: "commit_mutation",
        source: "permission_upgrade_request",
        status: "pending",
        request_id: "upgrade-skill-a",
        evidence_refs: [`skill:${skill.skill_id}`],
      }),
      expect.objectContaining({
        skill_id: "skill-a",
        action: "security_review",
        source: "license_approval_requirement",
        status: "pending",
      }),
      expect.objectContaining({
        skill_id: "skill-a",
        action: "submit_invoice",
        source: "license_gated_action",
        status: "pending",
      }),
    ]);
  });

  it("builds case-law review queue from skill-local and external proposed records", () => {
    const skill = skillFixture({
      skillId: "skill-a",
      caseLaw: [{
        case_id: "case-local",
        title: "Duplicate client",
        date: "2026-06-11T00:00:00.000Z",
        source_skill_id: "skill-a",
        source_run_id: "run-a",
        finding: "Duplicate client display name.",
        impact: "Wrong client may be mutated.",
        rule_created: "Require stable client ID.",
        applies_to: ["submit_invoice"],
        binding_scope: "workspace",
        status: "proposed",
        evidence_refs: ["evidence-a"],
      }],
    });
    const external = externalCaseFixture();

    const queue = queryDojoCaseLawReviewQueue({
      skills: [skill],
      case_law_records: [external],
    });

    expect(queue).toEqual([
      expect.objectContaining({ case_id: "case-external", status: "proposed", workspace_id: "workspace-a" }),
      expect.objectContaining({ case_id: "case-local", status: "proposed", workspace_id: "workspace-a" }),
    ]);
  });

  it("builds dashboard metrics from health and queues", () => {
    const view = buildDojoGovernanceServiceView({
      skills: [
        skillFixture({ skillId: "skill-expired", expiresAt: "2026-06-01T00:00:00.000Z" }),
        skillFixture({
          skillId: "skill-active",
          expiresAt: "2026-07-11T00:00:00.000Z",
          gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
        }),
      ],
      case_law_records: [externalCaseFixture()],
      permission_upgrade_requests: [permissionUpgradeRequestFixture(skillFixture({ skillId: "skill-active" }))],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(view).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceService.v1",
      metrics: {
        skill_count: 2,
        active_license_count: 1,
        expired_license_count: 1,
        pending_approval_count: 2,
        case_law_review_count: 1,
        policy_gate_count: 3,
        recertification_count: 3,
        compliance_artifact_count: 3,
      },
    }));
    expect(view.skill_registry).toHaveLength(2);
    expect(view.policy_gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate_id: "proof_skill-active", name: "Proof capsule required" }),
      expect.objectContaining({ gate_id: "approval_skill-active_submit_invoice" }),
    ]));
    expect(view.recertification_queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill_id: "skill-expired", status: "overdue", priority: "high" }),
    ]));
    expect(view.scheduled_jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "expire_stale_license", skill_id: "skill-expired", status: "ready", priority: "high" }),
      expect.objectContaining({ kind: "notify_approver", skill_id: "skill-active", status: "ready" }),
      expect.objectContaining({ kind: "review_case_law", queue_id: "case_law_case-external", status: "ready" }),
      expect.objectContaining({ kind: "archive_compliance_evidence", status: "ready" }),
      expect.objectContaining({ kind: "recompute_registry_metrics", status: "ready" }),
    ]));
    expect(view.audit_exports).toEqual(expect.arrayContaining([
      expect.objectContaining({ export_id: "skill_assurance_case", status: "available" }),
    ]));
    expect(view.compliance_evidence_pack).toEqual(expect.objectContaining({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact_id: "skill_assurance_case", status: "available" }),
        expect.objectContaining({ artifact_id: "license_and_proof_audit", status: "available" }),
        expect.objectContaining({ artifact_id: "case_law_registry", status: "available" }),
      ]),
    }));
  });

  it("includes stored control-plane audit events in audit exports and compliance pack", () => {
    const skill = skillFixture({ skillId: "skill-audited" });
    const auditEvent: DojoAuditEventRecord = {
      tenant_id: "tenant-a",
      workspace_id: skill.workspace_id,
      audit_event_id: "audit-control-plane-001",
      actor: { actor_id: "dojo-agent", actor_type: "agent" },
      event_type: "ghost_shadow_evidence_recorded",
      request_id: "request-control-plane-001",
      correlation_id: "correlation-control-plane-001",
      entity_kind: "ghost_shadow_evidence",
      entity_id: "ghost-evidence-control-plane-001",
      details: {
        skill_id: skill.skill_id,
        run_id: "ghost-run-control-plane-001",
        production_mutations_executed: false,
      },
      created_at: "2026-06-11T00:06:00.000Z",
    };
    const view = buildDojoGovernanceServiceView({
      skills: [skill],
      audit_events: [auditEvent],
      now: "2026-06-11T00:07:00.000Z",
    });

    expect(view.audit_exports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        export_id: "control_plane_audit",
        status: "available",
        record_count: 1,
        audit_event_refs: ["audit:audit-control-plane-001"],
        event_type_counts: { ghost_shadow_evidence_recorded: 1 },
      }),
    ]));
    expect(view.compliance_evidence_pack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: "control_plane_audit",
        status: "available",
        evidence_refs: ["audit:audit-control-plane-001"],
      }),
    ]));
    expect(view.compliance_evidence_pack.missing_artifacts).not.toContain("control_plane_audit");
  });

  it("surfaces malformed license expiry in governance metrics and recertification queue", () => {
    const view = buildDojoGovernanceServiceView({
      skills: [
        skillFixture({
          skillId: "skill-invalid-expiry",
          expiresAt: "not-a-date",
        }),
      ],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(view.license_health).toEqual([
      expect.objectContaining({
        skill_id: "skill-invalid-expiry",
        status: "revoked",
        recertification_triggers: expect.arrayContaining(["license_expiry_invalid"]),
      }),
    ]);
    expect(view.metrics).toEqual(expect.objectContaining({
      active_license_count: 0,
      expired_license_count: 1,
      recertification_count: 2,
    }));
    expect(view.recertification_queue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skill_id: "skill-invalid-expiry",
        reason: "license_expiry_invalid",
        status: "overdue",
        priority: "high",
      }),
    ]));
  });

  it("plans scheduled governance jobs from normalized queues", () => {
    const expired = skillFixture({ skillId: "skill-expired", expiresAt: "2026-06-01T00:00:00.000Z" });
    const active = skillFixture({
      skillId: "skill-active",
      gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
    });
    const caseLawRecord = externalCaseFixture();
    const permissionUpgrade = permissionUpgradeRequestFixture(active);
    const health = queryDojoLicenseHealth({
      skills: [expired, active],
      now: "2026-06-11T00:00:00.000Z",
    });
    const approvalQueue = queryDojoApprovalQueue({
      skills: [expired, active],
      permission_upgrade_requests: [permissionUpgrade],
    });
    const caseLawQueue = queryDojoCaseLawReviewQueue({
      skills: [expired, active],
      case_law_records: [caseLawRecord],
    });
    const recertificationQueue = queryDojoRecertificationQueue({
      skills: [expired, active],
      health,
      now: "2026-06-11T00:00:00.000Z",
    });
    const auditExports = queryDojoAuditExports({
      skills: [expired, active],
      case_law_review_queue: caseLawQueue,
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const compliancePack = buildDojoComplianceEvidencePack({
      skills: [expired, active],
      case_law_review_queue: caseLawQueue,
      audit_exports: auditExports,
      generated_at: "2026-06-11T00:00:00.000Z",
    });

    const jobs = queryDojoScheduledJobs({
      generated_at: "2026-06-11T00:00:00.000Z",
      license_health: health,
      approval_queue: approvalQueue,
      case_law_review_queue: caseLawQueue,
      recertification_queue: recertificationQueue,
      audit_exports: auditExports,
      compliance_evidence_pack: compliancePack,
    });

    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "expire_stale_license",
        skill_id: expired.skill_id,
        status: "ready",
        priority: "high",
        evidence_refs: expect.arrayContaining(["skill:skill-expired", "evidence-passport"]),
      }),
      expect.objectContaining({
        kind: "run_recertification",
        skill_id: expired.skill_id,
        status: "ready",
        reason: "license_expired",
      }),
      expect.objectContaining({
        kind: "notify_approver",
        queue_id: `permission_upgrade_${permissionUpgrade.request_id}`,
        status: "ready",
        priority: "high",
      }),
      expect.objectContaining({
        kind: "review_case_law",
        queue_id: `case_law_${caseLawRecord.case_id}`,
        status: "ready",
        evidence_refs: caseLawRecord.evidence_refs,
      }),
      expect.objectContaining({
        kind: "archive_compliance_evidence",
        status: "ready",
        priority: "low",
        blocked_by: [],
      }),
      expect.objectContaining({
        kind: "recompute_registry_metrics",
        status: "ready",
        priority: "low",
      }),
    ]));
    expect(jobs.every((job) => job.job_id.startsWith(`scheduled_${job.kind}_`))).toBe(true);
  });

  it("blocks scheduled recertification jobs when evidence references are missing", () => {
    const jobs = queryDojoScheduledJobs({
      generated_at: "2026-06-11T00:00:00.000Z",
      license_health: [],
      approval_queue: [],
      case_law_review_queue: [],
      recertification_queue: [{
        queue_id: "recert_skill-empty_missing-evidence",
        skill_id: "skill-empty",
        skill_name: "Skill empty",
        reason: "license_expiring",
        due_at: "2026-06-12T00:00:00.000Z",
        status: "due",
        priority: "medium",
        evidence_refs: [],
      }],
      audit_exports: [],
      compliance_evidence_pack: {
        pack_id: "governance_pack_empty",
        generated_at: "2026-06-11T00:00:00.000Z",
        artifacts: [],
        missing_artifacts: [],
        retention_class: "regulated",
      },
    });

    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run_recertification",
        skill_id: "skill-empty",
        status: "blocked",
        blocked_by: ["recertification_evidence_refs_missing"],
      }),
    ]));
  });

  it("executes scheduled jobs with handler contract and audit results", async () => {
    const expired = skillFixture({ skillId: "skill-expired", expiresAt: "2026-06-01T00:00:00.000Z" });
    const health = queryDojoLicenseHealth({
      skills: [expired],
      now: "2026-06-11T00:00:00.000Z",
    });
    const recertificationQueue = queryDojoRecertificationQueue({
      skills: [expired],
      health,
      now: "2026-06-11T00:00:00.000Z",
    });
    const jobs = queryDojoScheduledJobs({
      generated_at: "2026-06-11T00:00:00.000Z",
      license_health: health,
      approval_queue: [],
      case_law_review_queue: [],
      recertification_queue: recertificationQueue,
      audit_exports: [],
      compliance_evidence_pack: {
        pack_id: "governance_pack_empty",
        generated_at: "2026-06-11T00:00:00.000Z",
        artifacts: [],
        missing_artifacts: [],
        retention_class: "regulated",
      },
    });
    const handled: string[] = [];
    const run = await runDojoScheduledGovernanceJobs({
      jobs: jobs.filter((job) => job.kind === "run_recertification" || job.kind === "expire_stale_license"),
      actor: { actor_id: "governance-scheduler", actor_type: "service" },
      tenant_context: tenantContextFixture({ actorId: "governance-scheduler", roles: ["dojo:operator"] }),
      now: "2026-06-11T01:00:00.000Z",
      handlers: {
        run_recertification: ({ job, now }) => {
          handled.push(`${job.kind}:${job.skill_id}:${now}`);
          return {
            ok: true,
            evidence_refs: [`recertification-run:${job.queue_id}`],
            details: { checkride_mode: "scheduled_recertification" },
          };
        },
        expire_stale_license: ({ job }) => {
          handled.push(`${job.kind}:${job.skill_id}`);
          return {
            ok: true,
            status: "skipped",
            evidence_refs: [`expiry-reviewed:${job.queue_id}`],
            details: { reason: "already_expired_by_license_health" },
          };
        },
      },
    });

    expect(handled).toEqual(expect.arrayContaining([
      expect.stringMatching(/^run_recertification:skill-expired:2026-06-11T01:00:00\.000Z$/),
    ]));
    expect(run).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceScheduledJobRun.v1",
      generated_at: "2026-06-11T01:00:00.000Z",
      attempted_count: 2,
      applied_count: 1,
      skipped_count: 1,
      blocked_count: 0,
      failed_count: 0,
    }));
    expect(run.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run_recertification",
        status: "applied",
        evidence_refs: expect.arrayContaining(["recertification-run:recert_skill-expired_license_expired"]),
        audit_event: expect.objectContaining({
          event_type: "governance_scheduled_job_completed",
          actor: { actor_id: "governance-scheduler", actor_type: "service" },
          skill_id: "skill-expired",
          license_id: "license-skill-expired",
        }),
        details: { checkride_mode: "scheduled_recertification" },
      }),
      expect.objectContaining({
        kind: "expire_stale_license",
        status: "skipped",
        audit_event: expect.objectContaining({ event_type: "governance_scheduled_job_completed" }),
      }),
    ]));
  });

  it("fails closed when scheduled jobs are not ready or handlers are missing", async () => {
    const waitingJob = scheduledJobFixture({
      jobId: "scheduled_waiting",
      kind: "run_recertification",
      status: "waiting",
      skillId: "skill-waiting",
    });
    const readyWithoutHandler = scheduledJobFixture({
      jobId: "scheduled_ready_missing_handler",
      kind: "notify_approver",
      status: "ready",
      skillId: "skill-notify",
    });
    const throwingJob = scheduledJobFixture({
      jobId: "scheduled_throwing_handler",
      kind: "review_case_law",
      status: "ready",
      skillId: "skill-case",
    });
    const run = await runDojoScheduledGovernanceJobs({
      jobs: [waitingJob, readyWithoutHandler, throwingJob],
      actor: { actor_id: "governance-scheduler", actor_type: "service" },
      now: "2026-06-11T01:05:00.000Z",
      handlers: {
        review_case_law: () => {
          throw new Error("case law reviewer unavailable");
        },
      },
    });

    expect(run).toEqual(expect.objectContaining({
      applied_count: 0,
      blocked_count: 2,
      failed_count: 1,
    }));
    expect(run.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        job_id: "scheduled_waiting",
        status: "blocked",
        blocked_by: ["scheduled_job_not_ready:waiting"],
        audit_event: expect.objectContaining({ event_type: "governance_scheduled_job_blocked" }),
      }),
      expect.objectContaining({
        job_id: "scheduled_ready_missing_handler",
        status: "blocked",
        blocked_by: ["scheduled_job_handler_missing:notify_approver"],
        audit_event: expect.objectContaining({ event_type: "governance_scheduled_job_blocked" }),
      }),
      expect.objectContaining({
        job_id: "scheduled_throwing_handler",
        status: "failed",
        blocked_by: ["scheduled_job_handler_failed"],
        error: "case law reviewer unavailable",
        audit_event: expect.objectContaining({ event_type: "governance_scheduled_job_failed" }),
      }),
    ]));
  });

  it("blocks scheduled job execution when the scheduler actor is invalid", async () => {
    const run = await runDojoScheduledGovernanceJobs({
      jobs: [scheduledJobFixture({ jobId: "scheduled_actor_invalid", kind: "recompute_registry_metrics" })],
      actor: { actor_id: "", actor_type: undefined as never },
      now: "2026-06-11T01:10:00.000Z",
      handlers: {
        recompute_registry_metrics: () => ({ ok: true }),
      },
    });

    expect(run).toEqual(expect.objectContaining({
      attempted_count: 1,
      applied_count: 0,
      blocked_count: 1,
      failed_count: 0,
    }));
    expect(run.results[0]).toEqual(expect.objectContaining({
      status: "blocked",
      blocked_by: ["scheduled_job_actor_required", "scheduled_job_actor_type_required"],
      audit_event: expect.objectContaining({ event_type: "governance_scheduled_job_blocked" }),
    }));
  });

  it("persists scheduled job audit results with tenant scoped audit context", async () => {
    const auditStore = new MemoryAuditStore();
    const run = await runDojoScheduledGovernanceJobs({
      jobs: [scheduledJobFixture({ jobId: "scheduled_persist_audit", kind: "recompute_registry_metrics" })],
      actor: { actor_id: "governance-scheduler", actor_type: "service" },
      now: "2026-06-11T01:15:00.000Z",
      handlers: {
        recompute_registry_metrics: () => ({
          ok: true,
          evidence_refs: ["metrics:recomputed"],
          details: { metric_count: 6 },
        }),
      },
    });

    const persistence = await persistDojoScheduledJobRunAuditEvents({
      run,
      audit_store: auditStore,
      tenant_context: tenantContextFixture({
        actorId: "governance-scheduler",
        roles: ["dojo:operator"],
      }),
      request_id: "request-scheduled-audit",
      correlation_id: "correlation-scheduled-audit",
    });

    expect(persistence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceScheduledJobAuditPersistence.v1",
      persisted_count: 1,
      blocked_count: 0,
    }));
    expect(auditStore.events).toEqual([
      expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        event_type: "governance_scheduled_job_completed",
        request_id: "request-scheduled-audit",
        correlation_id: "correlation-scheduled-audit",
        entity_kind: "governance_scheduled_job",
        entity_id: "scheduled_persist_audit",
        details: expect.objectContaining({
          kind: "recompute_registry_metrics",
          status: "applied",
          evidence_refs: expect.arrayContaining(["metrics:recomputed"]),
        }),
      }),
    ]);
  });

  it("blocks scheduled job audit persistence when workspace scope does not match tenant context", async () => {
    const auditStore = new MemoryAuditStore();
    const run = await runDojoScheduledGovernanceJobs({
      jobs: [
        {
          ...scheduledJobFixture({
            jobId: "scheduled_workspace_mismatch",
            kind: "review_case_law",
            skillId: "skill-case",
          }),
          workspace_id: "workspace-b",
        },
      ],
      actor: { actor_id: "governance-scheduler", actor_type: "service" },
      now: "2026-06-11T01:20:00.000Z",
      handlers: {
        review_case_law: () => ({ ok: true, evidence_refs: ["case-law:reviewed"] }),
      },
    });

    const persistence = await persistDojoScheduledJobRunAuditEvents({
      run,
      audit_store: auditStore,
      tenant_context: tenantContextFixture({
        actorId: "governance-scheduler",
        roles: ["dojo:operator"],
      }),
    });

    expect(persistence).toEqual(expect.objectContaining({
      persisted_count: 0,
      blocked_count: 1,
    }));
    expect(persistence.results[0]).toEqual(expect.objectContaining({
      status: "blocked",
      blocked_by: ["scheduled_job_audit_workspace_mismatch"],
    }));
    expect(auditStore.events).toEqual([]);
  });

  it("builds skill registry and policy gates from licenses and binding case law", () => {
    const skill = skillFixture({
      skillId: "skill-a",
      ownerId: "owner-a",
      publishedToolName: "synthi_app_skill_a",
      gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
      blockedActions: [{ action: "delete_invoice", constraints: ["never_delete"] }],
      caseLaw: [{
        case_id: "case-binding",
        title: "Stable client ID",
        date: "2026-06-11T00:00:00.000Z",
        source_skill_id: "skill-a",
        source_run_id: "run-a",
        finding: "Duplicate display name.",
        impact: "Wrong entity mutation.",
        rule_created: "Require stable client ID.",
        applies_to: ["submit_invoice"],
        binding_scope: "workspace",
        status: "binding",
        evidence_refs: ["evidence-binding"],
      }],
    });
    const health = queryDojoLicenseHealth({ skills: [skill], now: "2026-06-11T00:00:00.000Z" });

    expect(queryDojoSkillRegistry({
      skills: [skill],
      health,
      now: "2026-06-11T00:00:00.000Z",
    })).toEqual([
      expect.objectContaining({
        skill_id: "skill-a",
        owner: "owner-a",
        published_tool_name: "synthi_app_skill_a",
        license_status: "active",
      }),
    ]);
    expect(queryDojoPolicyGates({ skills: [skill] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate_id: "approval_skill-a_submit_invoice", severity: "medium" }),
      expect.objectContaining({ gate_id: "blocked_skill-a_delete_invoice", status: "blocked", severity: "critical" }),
      expect.objectContaining({ gate_id: "case_case-binding", owner: "case_law", evidence_refs: ["evidence-binding"] }),
      expect.objectContaining({ gate_id: "proof_skill-a", severity: "high" }),
    ]));
  });

  it("builds recertification, audit export, and compliance pack views", () => {
    const expiring = skillFixture({ skillId: "skill-expiring", expiresAt: "2026-06-15T00:00:00.000Z" });
    const health = queryDojoLicenseHealth({
      skills: [expiring],
      now: "2026-06-11T00:00:00.000Z",
    });
    const recertificationQueue = queryDojoRecertificationQueue({
      skills: [expiring],
      health,
      now: "2026-06-11T00:00:00.000Z",
    });
    const auditExports = queryDojoAuditExports({
      skills: [expiring],
      case_law_review_queue: [],
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const pack = buildDojoComplianceEvidencePack({
      skills: [expiring],
      case_law_review_queue: [],
      audit_exports: auditExports,
      generated_at: "2026-06-11T00:00:00.000Z",
    });

    expect(recertificationQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "license_expiring", status: "due", priority: "medium" }),
      expect.objectContaining({ reason: "recertify_after_30_days", status: "due", priority: "medium" }),
    ]));
    expect(auditExports).toEqual([
      expect.objectContaining({ export_id: "skill_assurance_case", status: "available", record_count: 1 }),
      expect.objectContaining({ export_id: "license_history", status: "available", record_count: 1 }),
      expect.objectContaining({ export_id: "case_law_registry", status: "missing", record_count: 0 }),
    ]);
    expect(pack.pack_id).toMatch(/^governance_pack_/);
    expect(pack.missing_artifacts).toEqual(["case_law_registry"]);
    expect(pack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact_id: "license_and_proof_audit", status: "available" }),
      expect.objectContaining({ artifact_id: "case_law_registry", status: "missing" }),
    ]));

    const withCaseLaw = skillFixture({
      skillId: "skill-with-case-law",
      caseLaw: [{
        case_id: "case-approved",
        title: "Approved duplicate guardrail",
        date: "2026-06-11",
        finding: "Duplicate entities require stable IDs.",
        impact: "Wrong entity could be updated.",
        rule_created: "stable_id_verified == true",
        applies_to: ["submit_invoice"],
        evidence_refs: ["evidence-case-approved"],
        status: "binding",
        binding_scope: "workspace",
        guardrail_id: "guard-approved",
      }],
    });
    const caseLawAuditExports = queryDojoAuditExports({
      skills: [withCaseLaw],
      case_law_review_queue: [],
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const caseLawPack = buildDojoComplianceEvidencePack({
      skills: [withCaseLaw],
      case_law_review_queue: [],
      audit_exports: caseLawAuditExports,
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    expect(caseLawAuditExports).toEqual(expect.arrayContaining([
      expect.objectContaining({ export_id: "case_law_registry", status: "available", record_count: 1 }),
    ]));
    expect(caseLawPack.missing_artifacts).toEqual([]);
    expect(caseLawPack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: "case_law_registry",
        status: "available",
        evidence_refs: ["evidence-case-approved"],
      }),
    ]));
  });

  it("builds tenant-scoped compliance archive manifests for complete packs", () => {
    const withCaseLaw = skillFixture({
      skillId: "skill-archive-ready",
      caseLaw: [{
        case_id: "case-archive-approved",
        title: "Approved archive guardrail",
        date: "2026-06-11",
        finding: "Archived governance packs must include case law evidence.",
        impact: "Compliance export would be incomplete without the binding case.",
        rule_created: "case_law_registry_complete == true",
        applies_to: ["run_workflow"],
        evidence_refs: ["evidence-case-archive"],
        status: "binding",
        binding_scope: "workspace",
        guardrail_id: "guard-archive-approved",
      }],
    });
    const auditExports = queryDojoAuditExports({
      skills: [withCaseLaw],
      case_law_review_queue: [],
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const completePack = buildDojoComplianceEvidencePack({
      skills: [withCaseLaw],
      case_law_review_queue: [],
      audit_exports: auditExports,
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const archivedAt = "2026-06-11T01:00:00.000Z";
    const archive = buildDojoComplianceEvidenceArchiveManifest({
      tenant_context: tenantContextFixture({ actorId: "archive-runner", roles: ["dojo:governance:schedule"] }),
      compliance_evidence_pack: completePack,
      archived_at: archivedAt,
    });
    const archiveAgain = buildDojoComplianceEvidenceArchiveManifest({
      tenant_context: tenantContextFixture({ actorId: "archive-runner", roles: ["dojo:governance:schedule"] }),
      compliance_evidence_pack: completePack,
      archived_at: archivedAt,
    });

    expect(archive).toEqual(expect.objectContaining({ ok: true }));
    expect(archiveAgain).toEqual(archive);
    if (!archive.ok) throw new Error("expected archive manifest");
    expect(archive.manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.complianceEvidenceArchive.v1",
      archive_id: expect.stringMatching(/^compliance_archive_[a-f0-9]{16}$/),
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      pack_id: completePack.pack_id,
      pack_generated_at: completePack.generated_at,
      archived_at: archivedAt,
      retention_class: "standard",
      artifact_count: completePack.artifacts.length,
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence_refs: expect.arrayContaining(["evidence-case-archive"]),
    }));
    expect(archive.manifest.artifacts.map((artifact) => artifact.artifact_id)).toEqual(
      [...archive.manifest.artifacts.map((artifact) => artifact.artifact_id)].sort()
    );

    const missingPack = buildDojoComplianceEvidencePack({
      skills: [skillFixture({ skillId: "skill-archive-missing" })],
      case_law_review_queue: [],
      audit_exports: queryDojoAuditExports({
        skills: [skillFixture({ skillId: "skill-archive-missing" })],
        case_law_review_queue: [],
        generated_at: "2026-06-11T00:00:00.000Z",
      }),
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const blockedArchive = buildDojoComplianceEvidenceArchiveManifest({
      tenant_context: tenantContextFixture(),
      compliance_evidence_pack: missingPack,
      archived_at: archivedAt,
    });
    expect(blockedArchive).toEqual({
      ok: false,
      blocked_by: ["compliance_artifact_missing:case_law_registry"],
      missing_artifacts: ["case_law_registry"],
    });
  });

  it("adds executable entrustment provenance to compliance packs when runtime checkride snapshots exist", () => {
    const skill = skillFixture({
      skillId: "skill-executable-entrustment",
      executableEntrustment: executableEntrustmentFixture("checkride-executable-001"),
    });
    const auditExports = queryDojoAuditExports({
      skills: [skill],
      case_law_review_queue: [],
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const pack = buildDojoComplianceEvidencePack({
      skills: [skill],
      case_law_review_queue: [],
      audit_exports: auditExports,
      generated_at: "2026-06-11T00:00:00.000Z",
    });

    expect(pack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: "executable_entrustment_provenance",
        status: "available",
        evidence_refs: expect.arrayContaining([
          "checkride:checkride-executable-001",
          "evidence:scenario-001",
          "ledger_checkpoint:ledger-head-001",
        ]),
      }),
    ]));
    expect(pack.missing_artifacts).not.toContain("executable_entrustment_provenance");
  });

  it("adds proof public verification custody to the compliance pack when proof keys are supplied", () => {
    const skill = skillFixture({ skillId: "skill-proof-key-export" });
    const keyPair = generateEd25519DojoProofKeyPair("ed25519-governance-compliance");
    const auditExports = queryDojoAuditExports({
      skills: [skill],
      case_law_review_queue: [],
      generated_at: "2026-06-11T00:00:00.000Z",
    });
    const pack = buildDojoComplianceEvidencePack({
      skills: [skill],
      case_law_review_queue: [],
      audit_exports: auditExports,
      proof_key_records: [
        buildDojoProofKeyRecord({
          tenant_id: "tenant-a",
          key_id: keyPair.key_id,
          issuer: "dojo-proof-service",
          algorithm: "ed25519",
          public_key_pem: keyPair.public_key_pem,
          status: "active",
          created_at: "2026-06-11T00:00:00.000Z",
        }),
      ],
      generated_at: "2026-06-11T00:00:00.000Z",
    });

    expect(pack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: "proof_public_verification",
        title: "Proof Public Verification Bundle",
        status: "available",
        evidence_refs: [`proof_key:${keyPair.key_id}`],
      }),
    ]));
    expect(pack.missing_artifacts).not.toContain("proof_public_verification");
  });
});

function skillFixture(input: {
  skillId: string;
  expiresAt?: string;
  entrustmentLevel?: DojoSkill["entrustment_level"];
  autonomyLevel?: DojoSkill["permission_license"]["autonomy_level"];
  gatedActions?: Array<{ action: string; constraints: string[] }>;
  approvalRequirements?: string[];
  blockedActions?: Array<{ action: string; constraints: string[] }>;
  caseLaw?: DojoSkill["case_law"];
  ownerId?: string;
  publishedToolName?: string;
  executableEntrustment?: DojoSkill["executable_entrustment"];
}): DojoSkill {
  const expiresAt = input.expiresAt ?? "2026-07-11T00:00:00.000Z";
  return {
    skill_id: input.skillId,
    workflow_id: `workflow-${input.skillId}`,
    name: `Skill ${input.skillId}`,
    workspace_id: "workspace-a",
    owner_id: input.ownerId ?? "",
    published_tool_name: input.publishedToolName ?? "",
    updated_at: "2026-06-11T00:00:00.000Z",
    license_expires_at: expiresAt,
    entrustment_level: input.entrustmentLevel ?? "E3",
    skill_readiness_level: 7,
    retrain_triggers: [{ trigger_id: "trigger-a", source: "schedule", condition: "recertify_after_30_days" }],
    case_law: input.caseLaw ?? [],
    skill_card: {
      title: `Skill ${input.skillId}`,
      status: "Licensed",
      can_do_alone: ["run_workflow"],
      will_ask_before: (input.gatedActions ?? []).map((action) => action.action),
      will_not_do: (input.blockedActions ?? []).map((action) => action.action),
      practiced: "Practice complete",
      found_and_fixed: "No critical issues",
      proof_badge: "Proof required",
    },
    skill_passport: {
      proof_required: true,
      entrustment_level: input.entrustmentLevel ?? "E3",
      readiness_level: 7,
      license_id: `license-${input.skillId}`,
      license_expires_at: expiresAt,
      issued_at: "2026-06-11T00:00:00.000Z",
      evidence_refs: ["evidence-passport"],
    },
    executable_entrustment: input.executableEntrustment,
    permission_license: {
      license_id: `license-${input.skillId}`,
      license_version: "1.0.0",
      entrustment_level: input.entrustmentLevel ?? "E3",
      autonomy_level: input.autonomyLevel ?? "submit_limited",
      allowed_actions: [{ action: "run_workflow", constraints: ["proof_capsule_valid"] }],
      gated_actions: input.gatedActions ?? [],
      blocked_actions: input.blockedActions ?? [],
      approval_requirements: input.approvalRequirements ?? [],
      expiry_policy: {
        expires_on: ["app_release_drift"],
        recertify_after_days: 30,
      },
    },
    training_report: {
      summary: {
        readiness_level: 7,
        entrustment_level: input.entrustmentLevel ?? "E3",
      },
      readiness_decision: "Ready for limited production.",
      limitations: ["baseline_limit"],
      evidence_refs: ["evidence-training"],
    },
    last_trained_at: "2026-06-11T00:00:00.000Z",
  } as unknown as DojoSkill;
}

function executableEntrustmentFixture(checkrideId: string): NonNullable<DojoSkill["executable_entrustment"]> {
  return {
    schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
    source: "publish",
    checkride_id: checkrideId,
    generated_at: "2026-06-11T00:00:30.000Z",
    started_at: "2026-06-11T00:00:00.000Z",
    finished_at: "2026-06-11T00:00:30.000Z",
    scenario_count: 3,
    passed_scenarios: 2,
    failed_scenarios: 0,
    blocked_scenarios: 1,
    critical_failures: 0,
    coverage_score: 0.92,
    production_recommendation: "constrained",
    license_constraints: [{
      scenario_id: "scenario-duplicate-entity",
      mutation_kind: "duplicate_entity",
      constraint_kind: "requires_guardrail",
      reason: "Require stable entity identity before mutation.",
    }],
    entrustment_decision: {
      level: "E3",
      production_recommendation: "constrained",
      blocked_by: [],
      limitations: ["duplicate_entity_requires_guardrail"],
      evidence_refs: ["evidence:scenario-001"],
    },
    readiness_decision: {
      level: 7,
      blocked_by: [],
      next_required: ["shadow_run_before_E4"],
    },
    evidence_refs: ["evidence:scenario-001"],
    ledger_checkpoint_hashes: ["ledger-head-001"],
  };
}

function permissionUpgradeRequestFixture(skill: DojoSkill): DojoPermissionUpgradeRequestRecord {
  return {
    schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
    request_id: `upgrade-${skill.skill_id}`,
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    workspace_id: skill.workspace_id,
    license_id: skill.permission_license.license_id,
    license_version: skill.permission_license.license_version,
    requested_action: "commit_mutation",
    current_entrustment_level: skill.entrustment_level,
    required_steps: ["rerun_checkride_for_requested_action"],
    status: "pending",
    evidence_refs: [`skill:${skill.skill_id}`],
    requested_at: "2026-06-11T00:01:00.000Z",
    requested_by: { actor_id: "unit-test", actor_type: "agent" },
    request_context: {
      request_id: `upgrade-${skill.skill_id}`,
      correlation_id: `upgrade-${skill.skill_id}-correlation`,
    },
  };
}

function scheduledJobFixture(input: {
  jobId: string;
  kind: DojoGovernanceScheduledJobKind;
  status?: DojoGovernanceScheduledJobStatus;
  skillId?: string;
}): DojoGovernanceScheduledJobItem {
  const skillId = input.skillId ?? `skill-${input.kind}`;
  return {
    job_id: input.jobId,
    kind: input.kind,
    status: input.status ?? "ready",
    priority: "medium",
    due_at: "2026-06-11T01:00:00.000Z",
    reason: `scheduled ${input.kind}`,
    evidence_refs: [`evidence:${input.jobId}`],
    blocked_by: [],
    next_step: `Handle ${input.kind} through injected governance scheduler handler.`,
    queue_id: `queue-${input.jobId}`,
    skill_id: skillId,
    workspace_id: "workspace-a",
    license_id: `license-${skillId}`,
  };
}

function tenantContextFixture(input: {
  actorId?: string;
  roles?: string[];
} = {}): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: input.actorId ?? "governance-reviewer",
    actor_type: "human",
    roles: input.roles ?? ["dojo:operator"],
    request_id: "request-governance-rbac",
    correlation_id: "correlation-governance-rbac",
  };
}

class MemoryAuditStore implements DojoAuditStore {
  readonly events: DojoAuditEventRecord[] = [];

  appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
    const record: DojoAuditEventRecord = {
      tenant_id: event.tenant_id,
      workspace_id: event.workspace_id,
      audit_event_id: event.audit_event_id ?? `audit-${this.events.length + 1}`,
      actor: { ...event.actor },
      event_type: event.event_type,
      request_id: event.request_id,
      correlation_id: event.correlation_id,
      entity_kind: event.entity_kind,
      entity_id: event.entity_id,
      details: { ...(event.details ?? {}) },
      created_at: event.created_at ?? "2026-06-11T00:00:00.000Z",
    };
    this.events.push(record);
    return record;
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): DojoAuditEventRecord[] {
    return this.events
      .filter((event) => !filter.event_type || event.event_type === filter.event_type)
      .filter((event) => !filter.entity_kind || event.entity_kind === filter.entity_kind)
      .filter((event) => !filter.entity_id || event.entity_id === filter.entity_id)
      .filter((event) => !filter.correlation_id || event.correlation_id === filter.correlation_id)
      .slice(0, filter.limit ?? this.events.length)
      .map((event) => ({
        ...event,
        actor: { ...event.actor },
        details: { ...event.details },
      }));
  }
}

function externalCaseFixture(): DojoCaseLawRecord {
  return {
    schema_version: "synthi.dojo.caseLaw.v1",
    case_id: "case-external",
    title: "External duplicate client",
    finding: "Duplicate client display name.",
    impact: "Wrong client may be mutated.",
    rule_created: "Require stable client ID.",
    applies_to: ["submit_invoice"],
    binding_scope: { kind: "workspace", id: "workspace-a" },
    status: "proposed",
    evidence_refs: ["evidence-external"],
    appeal_status: "none",
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
  };
}
