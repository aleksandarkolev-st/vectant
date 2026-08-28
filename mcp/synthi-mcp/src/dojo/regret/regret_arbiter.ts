import type { BranchTrace, ChoiceScene, PolicyDelta } from "./types.js";
import { branchPreferenceLessonAllowed, counterfactualStrengthForBranch } from "./exposure.js";
import { createPolicyDeltaHypothesis } from "./policy_delta.js";

export interface RegretArbiterLesson {
  schema_version: "synthi.dojo.regret.lesson.v1";
  lesson_id: string;
  counterfactual_run_id: string;
  branch_id: string;
  choice_scene_id: string;
  strength: "strong";
  lesson: string;
  evidence_ids: string[];
  policy_delta: PolicyDelta;
}

export type RegretArbiterResult =
  | { ok: true; lesson: RegretArbiterLesson; blocked_by: [] }
  | { ok: false; lesson?: undefined; blocked_by: string[] };

export function extractDeterministicRegretLesson(input: {
  scene: ChoiceScene;
  branch: BranchTrace;
  lesson?: string;
  now?: string;
}): RegretArbiterResult {
  const blockedBy: string[] = [];
  const strength = counterfactualStrengthForBranch(input);
  if (strength !== "strong") blockedBy.push(`regret_signal_strength_insufficient:${strength}`);
  if (!branchPreferenceLessonAllowed(input)) blockedBy.push("regret_branch_preference_not_allowed");
  if (input.scene.ambiguity_flags.length > 0) {
    blockedBy.push(...input.scene.ambiguity_flags.map((flag) => `regret_ambiguity:${flag}`));
  }
  if (input.branch.evidence_ids.length === 0) blockedBy.push("regret_branch_evidence_required");
  if (input.scene.evidence_ids.length === 0) blockedBy.push("regret_choice_scene_evidence_required");
  if (blockedBy.length > 0) return { ok: false, blocked_by: [...new Set(blockedBy)].sort() };

  const lesson = input.lesson ?? lessonForBranch(input.branch);
  const policyDelta = createPolicyDeltaHypothesis({
    scene: input.scene,
    branch: input.branch,
    rationale: lesson,
    confidence: "medium",
    now: input.now,
  });
  return {
    ok: true,
    blocked_by: [],
    lesson: {
      schema_version: "synthi.dojo.regret.lesson.v1",
      lesson_id: `lesson_${policyDelta.policy_delta_id.replace(/^policy_delta_/, "")}`,
      counterfactual_run_id: input.scene.counterfactual_run_id,
      branch_id: input.branch.branch_id,
      choice_scene_id: input.scene.choice_scene_id,
      strength: "strong",
      lesson,
      evidence_ids: [...policyDelta.evidence_ids],
      policy_delta: policyDelta,
    },
  };
}

function lessonForBranch(branch: BranchTrace): string {
  if (branch.branch_kind === "source_api_substrate" && branch.status !== "failed" && branch.status !== "blocked") {
    return "Evidence-backed source/API branch should be considered in future graph planning with proof requirements intact.";
  }
  if (branch.status === "blocked" || branch.status === "failed") {
    return "Evidence-backed near miss should increase future guardrail or oracle coverage before promotion.";
  }
  return "Evidence-backed branch comparison should affect future practice coverage before policy promotion.";
}
