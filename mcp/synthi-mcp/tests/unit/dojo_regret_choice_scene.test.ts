import { describe, expect, it } from "vitest";
import { createBranchFossilFromChoice } from "../../src/dojo/regret/choice_scene.js";
import {
  branchPreferenceLessonAllowed,
  counterfactualStrengthForBranch,
  exposureLevelForBranch,
} from "../../src/dojo/regret/exposure.js";
import type { BranchTrace, ChoiceScene } from "../../src/dojo/regret/types.js";

describe("Dojo regret choice scenes", () => {
  it("assigns no strength to generated branches that were never shown", () => {
    const scene = choiceScene({
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom"],
      opened_branch_ids: ["branch-dom"],
      selected_branch_id: "branch-dom",
    });
    const apiBranch = branchTrace("branch-api");

    expect(exposureLevelForBranch(scene, "branch-api")).toBe("none");
    expect(counterfactualStrengthForBranch({ scene, branch: apiBranch })).toBe("none");
    expect(branchPreferenceLessonAllowed({ scene, branch: apiBranch })).toBe(false);
  });

  it("keeps shown unopened branches weak", () => {
    const scene = choiceScene({
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom", "branch-api"],
      opened_branch_ids: ["branch-dom"],
      selected_branch_id: "branch-dom",
    });

    expect(exposureLevelForBranch(scene, "branch-api")).toBe("shown");
    expect(counterfactualStrengthForBranch({ scene, branch: branchTrace("branch-api") })).toBe("weak");
  });

  it("allows a strong lesson only when an opened arbiter winner was overridden with evidence", () => {
    const scene = choiceScene({
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom", "branch-api"],
      opened_branch_ids: ["branch-dom", "branch-api"],
      selected_branch_id: "branch-dom",
      arbiter_recommended_branch_id: "branch-api",
    });
    const apiBranch = branchTrace("branch-api");

    expect(counterfactualStrengthForBranch({ scene, branch: apiBranch })).toBe("strong");
    expect(branchPreferenceLessonAllowed({ scene, branch: apiBranch })).toBe(true);
  });

  it("blocks branch preference lessons for ambiguous cancellation", () => {
    const scene = choiceScene({
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom", "branch-api"],
      opened_branch_ids: ["branch-dom", "branch-api"],
      selected_branch_id: undefined,
      arbiter_recommended_branch_id: "branch-api",
      cancelled: true,
      ambiguity_flags: ["cancellation"],
    });
    const apiBranch = branchTrace("branch-api");

    expect(counterfactualStrengthForBranch({ scene, branch: apiBranch })).toBe("none");
    expect(branchPreferenceLessonAllowed({ scene, branch: apiBranch })).toBe(false);
  });

  it("creates compact fossils with redacted evidence references", () => {
    const scene = choiceScene({
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom", "branch-api"],
      opened_branch_ids: ["branch-dom", "branch-api"],
      selected_branch_id: "branch-dom",
      arbiter_recommended_branch_id: "branch-api",
    });
    const fossil = createBranchFossilFromChoice({
      scene,
      branch: branchTrace("branch-api"),
      now: "2026-06-24T00:10:00.000Z",
    });

    expect(fossil).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.regret.branchFossil.v1",
      branch_id: "branch-api",
      exposure_level: "opened",
      counterfactual_strength: "strong",
      retention_policy: "compact_fossil",
      evidence_ids: [
        "ledger://branch/branch-api",
        "ledger://choice/scene",
        "ledger://detector/branch-api",
        "ledger://oracle/branch-api",
      ],
    }));
  });
});

function choiceScene(overrides: Partial<ChoiceScene>): ChoiceScene {
  return {
    schema_version: "synthi.dojo.regret.choiceScene.v1",
    choice_scene_id: "scene-1",
    counterfactual_run_id: "cfr-1",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    task_class: "invoice_submit",
    base_state_hash: "sha256:base",
    available_branch_ids: [],
    visible_branch_ids: [],
    opened_branch_ids: [],
    compared_branch_ids: [],
    cancelled: false,
    ambiguity_flags: [],
    evidence_ids: ["ledger://choice/scene"],
    created_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

function branchTrace(branchId: string): BranchTrace {
  return {
    schema_version: "synthi.dojo.regret.branchTrace.v1",
    branch_id: branchId,
    counterfactual_run_id: "cfr-1",
    branch_kind: "source_api_substrate",
    status: "passed",
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
