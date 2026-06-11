import { describe, expect, it } from "vitest";
import type { DojoSkill } from "../../src/browser/dojo.js";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import {
  buildDojoGovernanceServiceView,
  queryDojoApprovalQueue,
  queryDojoCaseLawReviewQueue,
  queryDojoLicenseHealth,
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
    const queue = queryDojoApprovalQueue({
      skills: [
        skillFixture({
          skillId: "skill-a",
          gatedActions: [{ action: "submit_invoice", constraints: ["manager_approval"] }],
          approvalRequirements: ["security_review"],
        }),
      ],
    });

    expect(queue).toEqual([
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
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(view).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceService.v1",
      metrics: {
        skill_count: 2,
        active_license_count: 1,
        expired_license_count: 1,
        pending_approval_count: 1,
        case_law_review_count: 1,
      },
    }));
  });
});

function skillFixture(input: {
  skillId: string;
  expiresAt?: string;
  entrustmentLevel?: DojoSkill["entrustment_level"];
  autonomyLevel?: DojoSkill["permission_license"]["autonomy_level"];
  gatedActions?: Array<{ action: string; constraints: string[] }>;
  approvalRequirements?: string[];
  caseLaw?: DojoSkill["case_law"];
}): DojoSkill {
  const expiresAt = input.expiresAt ?? "2026-07-11T00:00:00.000Z";
  return {
    skill_id: input.skillId,
    name: `Skill ${input.skillId}`,
    workspace_id: "workspace-a",
    license_expires_at: expiresAt,
    entrustment_level: input.entrustmentLevel ?? "E3",
    skill_readiness_level: 7,
    retrain_triggers: [{ trigger_id: "trigger-a", source: "schedule", condition: "recertify_after_30_days" }],
    case_law: input.caseLaw ?? [],
    skill_passport: {
      proof_required: true,
      license_expires_at: expiresAt,
    },
    permission_license: {
      license_id: `license-${input.skillId}`,
      license_version: "1.0.0",
      autonomy_level: input.autonomyLevel ?? "submit_limited",
      allowed_actions: [{ action: "run_workflow", constraints: ["proof_capsule_valid"] }],
      gated_actions: input.gatedActions ?? [],
      blocked_actions: [],
      approval_requirements: input.approvalRequirements ?? [],
      expiry_policy: {
        expires_on: ["app_release_drift"],
        recertify_after_days: 30,
      },
    },
  } as unknown as DojoSkill;
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
