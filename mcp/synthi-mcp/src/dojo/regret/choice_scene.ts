import { createHash } from "node:crypto";
import type { BranchTrace, BranchFossil, ChoiceScene } from "./types.js";
import { counterfactualStrengthForBranch, exposureLevelForBranch } from "./exposure.js";
import { uniqueRegretStrings } from "./types.js";

export function createBranchFossilFromChoice(input: {
  scene: ChoiceScene;
  branch: BranchTrace;
  summary?: string;
  now?: string;
  expires_at?: string;
}): BranchFossil {
  const exposureLevel = exposureLevelForBranch(input.scene, input.branch.branch_id);
  const strength = counterfactualStrengthForBranch({ scene: input.scene, branch: input.branch });
  const evidenceIds = uniqueRegretStrings([
    ...input.branch.evidence_ids,
    ...input.branch.detector_evidence_ids,
    ...input.branch.oracle_evidence_ids,
    ...input.branch.selection_evidence_ids,
    ...input.scene.evidence_ids,
  ]);
  return {
    schema_version: "synthi.dojo.regret.branchFossil.v1",
    fossil_id: `fossil_${shortHash([
      input.scene.choice_scene_id,
      input.branch.branch_id,
      exposureLevel,
      strength,
    ].join("|"))}`,
    counterfactual_run_id: input.scene.counterfactual_run_id,
    branch_id: input.branch.branch_id,
    tenant_id: input.scene.tenant_id,
    workspace_id: input.scene.workspace_id,
    ...(input.scene.skill_id ? { skill_id: input.scene.skill_id } : {}),
    ...(input.scene.skill_version_id ? { skill_version_id: input.scene.skill_version_id } : {}),
    ...(input.scene.graph_run_id ? { graph_run_id: input.scene.graph_run_id } : {}),
    ...(input.scene.vivarium_run_id ? { vivarium_run_id: input.scene.vivarium_run_id } : {}),
    ...(input.scene.checkride_run_id ? { checkride_run_id: input.scene.checkride_run_id } : {}),
    task_class: input.scene.task_class,
    base_state_hash: input.scene.base_state_hash,
    exposure_level: exposureLevel,
    counterfactual_strength: strength,
    ambiguity_flags: uniqueRegretStrings(input.scene.ambiguity_flags) as BranchFossil["ambiguity_flags"],
    summary: input.summary ?? input.branch.summary,
    evidence_ids: evidenceIds,
    created_at: input.now ?? input.scene.created_at,
    ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    retention_policy: "compact_fossil",
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
