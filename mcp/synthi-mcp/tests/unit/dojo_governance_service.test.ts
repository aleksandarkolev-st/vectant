import { describe, expect, it } from "vitest";
import type { DojoSkill } from "../../src/browser/dojo.js";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import type { DojoPermissionUpgradeRequestRecord } from "../../src/dojo/store/interfaces.js";
import {
  buildDojoGovernanceServiceView,
  buildDojoComplianceEvidencePack,
  decideDojoCaseLawReview,
  decideDojoPermissionUpgradeRequest,
  queryDojoApprovalQueue,
  queryDojoAuditExports,
  queryDojoCaseLawReviewQueue,
  queryDojoLicenseHealth,
  queryDojoPolicyGates,
  queryDojoRecertificationQueue,
  queryDojoSkillRegistry,
  revokeDojoSkillLicense,
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
