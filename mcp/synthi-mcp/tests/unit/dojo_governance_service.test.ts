import { describe, expect, it } from "vitest";
import type { DojoSkill } from "../../src/browser/dojo.js";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import type { DojoPermissionUpgradeRequestRecord } from "../../src/dojo/store/interfaces.js";
import {
  buildDojoGovernanceServiceView,
  buildDojoComplianceEvidencePack,
  queryDojoApprovalQueue,
  queryDojoAuditExports,
  queryDojoCaseLawReviewQueue,
  queryDojoLicenseHealth,
  queryDojoPolicyGates,
  queryDojoRecertificationQueue,
  queryDojoSkillRegistry,
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
    skill_passport: {
      proof_required: true,
      license_expires_at: expiresAt,
      evidence_refs: ["evidence-passport"],
    },
    permission_license: {
      license_id: `license-${input.skillId}`,
      license_version: "1.0.0",
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
