import type {
  BranchTrace,
  ChoiceScene,
  RegretCounterfactualStrength,
  RegretExposureLevel,
} from "./types.js";

export function exposureLevelForBranch(scene: ChoiceScene, branchId: string): RegretExposureLevel {
  if (scene.selected_branch_id === branchId) return "selected";
  if (scene.compared_branch_ids.includes(branchId)) return "compared";
  if (scene.opened_branch_ids.includes(branchId)) return "opened";
  if (scene.visible_branch_ids.includes(branchId)) return "shown";
  return "none";
}

export function counterfactualStrengthForBranch(input: {
  scene: ChoiceScene;
  branch: BranchTrace;
}): RegretCounterfactualStrength {
  const exposure = exposureLevelForBranch(input.scene, input.branch.branch_id);
  if (input.scene.cancelled || input.scene.ambiguity_flags.includes("cancellation")) return "none";
  if (!input.scene.available_branch_ids.includes(input.branch.branch_id)) return "none";
  if (exposure === "none") return "none";
  if (input.branch.evidence_ids.length === 0) return "none";
  if (input.scene.evidence_ids.length === 0) return "none";
  if (input.scene.ambiguity_flags.includes("branches_not_comparable")) return "weak";
  if (input.scene.ambiguity_flags.includes("base_state_changed")) return "weak";
  if (input.scene.selected_branch_id === input.branch.branch_id) return exposure === "selected" ? "medium" : "weak";
  if (
    input.scene.arbiter_recommended_branch_id === input.branch.branch_id
    && input.scene.selected_branch_id
    && input.scene.selected_branch_id !== input.branch.branch_id
    && exposure === "opened"
  ) {
    return "strong";
  }
  if (exposure === "compared") return "medium";
  if (exposure === "opened") return "medium";
  return "weak";
}

export function branchPreferenceLessonAllowed(input: {
  scene: ChoiceScene;
  branch: BranchTrace;
}): boolean {
  const strength = counterfactualStrengthForBranch(input);
  if (strength !== "strong") return false;
  if (!input.scene.selected_branch_id) return false;
  if (input.scene.selected_branch_id === input.branch.branch_id) return false;
  return input.branch.evidence_ids.length > 0
    && input.branch.detector_evidence_ids.length + input.branch.oracle_evidence_ids.length > 0
    && input.scene.evidence_ids.length > 0;
}
