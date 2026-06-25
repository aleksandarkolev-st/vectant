import { describe, expect, it } from "vitest";
import { promotePolicyDelta } from "../../src/dojo/regret/policy_delta.js";
import { extractDeterministicRegretLesson } from "../../src/dojo/regret/regret_arbiter.js";
import type { BranchTrace, ChoiceScene } from "../../src/dojo/regret/types.js";

describe("Dojo regret arbiter", () => {
  it("extracts deterministic override lessons with evidence-backed policy deltas", () => {
    const result = extractDeterministicRegretLesson({
      scene: strongOverrideScene(),
      branch: branchTrace("branch-api", "passed"),
      now: "2026-06-24T00:20:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      lesson: expect.objectContaining({
        strength: "strong",
        branch_id: "branch-api",
        evidence_ids: [
          "ledger://branch/branch-api",
          "ledger://choice/scene",
          "ledger://detector/branch-api",
          "ledger://oracle/branch-api",
        ],
        policy_delta: expect.objectContaining({
          status: "hypothesis",
          delta_kind: "prefer_substrate",
          evidence_ids: [
            "ledger://branch/branch-api",
            "ledger://choice/scene",
            "ledger://detector/branch-api",
            "ledger://oracle/branch-api",
          ],
        }),
      }),
    }));
  });

  it("rejects weak or unshown signals before creating policy", () => {
    const scene = strongOverrideScene({
      visible_branch_ids: ["branch-dom"],
      opened_branch_ids: ["branch-dom"],
    });

    expect(extractDeterministicRegretLesson({
      scene,
      branch: branchTrace("branch-api", "passed"),
    })).toEqual({
      ok: false,
      blocked_by: [
        "regret_branch_preference_not_allowed",
        "regret_signal_strength_insufficient:none",
      ],
    });
  });

  it("rejects ambiguous cancellation instead of producing a branch preference lesson", () => {
    expect(extractDeterministicRegretLesson({
      scene: strongOverrideScene({
        selected_branch_id: undefined,
        cancelled: true,
        ambiguity_flags: ["cancellation"],
      }),
      branch: branchTrace("branch-api", "passed"),
    })).toEqual({
      ok: false,
      blocked_by: [
        "regret_ambiguity:cancellation",
        "regret_branch_preference_not_allowed",
        "regret_signal_strength_insufficient:none",
      ],
    });
  });

  it("promotes policy deltas only with reviewer and promotion evidence", () => {
    const result = extractDeterministicRegretLesson({
      scene: strongOverrideScene(),
      branch: branchTrace("branch-api", "passed"),
    });
    if (!result.ok) throw new Error("expected lesson");

    expect(() => promotePolicyDelta({
      delta: result.lesson.policy_delta,
      promoted_at: "2026-06-24T00:30:00.000Z",
      promoted_by: " ",
      evidence_ids: ["ledger://review/promotion"],
    })).toThrow("regret_policy_delta_promoter_required");

    expect(promotePolicyDelta({
      delta: result.lesson.policy_delta,
      promoted_at: "2026-06-24T00:30:00.000Z",
      promoted_by: "reviewer-a",
      evidence_ids: ["ledger://review/promotion"],
    })).toEqual(expect.objectContaining({
      status: "promoted",
      promoted_by: "reviewer-a",
      evidence_ids: [
        "ledger://branch/branch-api",
        "ledger://choice/scene",
        "ledger://detector/branch-api",
        "ledger://oracle/branch-api",
        "ledger://review/promotion",
      ],
    }));
  });
});

function strongOverrideScene(overrides: Partial<ChoiceScene> = {}): ChoiceScene {
  return {
    schema_version: "synthi.dojo.regret.choiceScene.v1",
    choice_scene_id: "scene-1",
    counterfactual_run_id: "cfr-1",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    task_class: "invoice_submit",
    base_state_hash: "sha256:base",
    available_branch_ids: ["branch-dom", "branch-api"],
    visible_branch_ids: ["branch-dom", "branch-api"],
    opened_branch_ids: ["branch-dom", "branch-api"],
    compared_branch_ids: [],
    selected_branch_id: "branch-dom",
    arbiter_recommended_branch_id: "branch-api",
    cancelled: false,
    ambiguity_flags: [],
    evidence_ids: ["ledger://choice/scene"],
    created_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

function branchTrace(branchId: string, status: BranchTrace["status"]): BranchTrace {
  return {
    schema_version: "synthi.dojo.regret.branchTrace.v1",
    branch_id: branchId,
    counterfactual_run_id: "cfr-1",
    branch_kind: "source_api_substrate",
    status,
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    task_class: "invoice_submit",
    base_state_hash: "sha256:base",
    blocked_by: [],
    detector_evidence_ids: [`ledger://detector/${branchId}`],
    oracle_evidence_ids: [`ledger://oracle/${branchId}`],
    selection_evidence_ids: [],
    evidence_ids: [`ledger://branch/${branchId}`],
    summary: "Branch passed with rollback proof.",
    created_at: "2026-06-24T00:00:01.000Z",
    retention_policy: "ephemeral_trace",
  };
}
