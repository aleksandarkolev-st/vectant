import { createHash } from "node:crypto";
import type { BranchTrace, ChoiceScene, PolicyDelta, RegretPolicyDeltaKind } from "./types.js";
import { uniqueRegretStrings } from "./types.js";

export function createPolicyDeltaHypothesis(input: {
  scene: ChoiceScene;
  branch: BranchTrace;
  delta_kind?: RegretPolicyDeltaKind;
  rationale: string;
  confidence?: PolicyDelta["confidence"];
  now?: string;
  expires_at?: string;
}): PolicyDelta {
  const evidenceIds = uniqueRegretStrings([
    ...input.scene.evidence_ids,
    ...input.branch.evidence_ids,
    ...input.branch.detector_evidence_ids,
    ...input.branch.oracle_evidence_ids,
    ...input.branch.selection_evidence_ids,
  ]);
  if (evidenceIds.length === 0) throw new Error("regret_policy_delta_evidence_required");
  const deltaKind = input.delta_kind ?? policyDeltaKindForBranch(input.branch);
  const createdAt = input.now ?? input.scene.created_at;
  return {
    schema_version: "synthi.dojo.regret.policyDelta.v1",
    policy_delta_id: `policy_delta_${shortHash([
      input.scene.choice_scene_id,
      input.branch.branch_id,
      deltaKind,
      input.rationale,
    ].join("|"))}`,
    delta_kind: deltaKind,
    status: "hypothesis",
    confidence: input.confidence ?? "medium",
    tenant_id: input.scene.tenant_id,
    workspace_id: input.scene.workspace_id,
    ...(input.scene.skill_id ? { skill_id: input.scene.skill_id } : {}),
    ...(input.scene.skill_version_id ? { skill_version_id: input.scene.skill_version_id } : {}),
    ...(input.scene.graph_run_id ? { graph_run_id: input.scene.graph_run_id } : {}),
    ...(input.scene.vivarium_run_id ? { vivarium_run_id: input.scene.vivarium_run_id } : {}),
    ...(input.scene.checkride_run_id ? { checkride_run_id: input.scene.checkride_run_id } : {}),
    task_class: input.scene.task_class,
    base_state_hash: input.scene.base_state_hash,
    rationale: input.rationale.trim(),
    source_counterfactual_run_id: input.scene.counterfactual_run_id,
    source_branch_id: input.branch.branch_id,
    source_choice_scene_id: input.scene.choice_scene_id,
    evidence_ids: evidenceIds,
    ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    created_at: createdAt,
  };
}

export function promotePolicyDelta(input: {
  delta: PolicyDelta;
  promoted_at: string;
  promoted_by: string;
  evidence_ids: string[];
}): PolicyDelta {
  const promotedBy = input.promoted_by.trim();
  const evidenceIds = uniqueRegretStrings([...input.delta.evidence_ids, ...input.evidence_ids]);
  if (!promotedBy) throw new Error("regret_policy_delta_promoter_required");
  if (evidenceIds.length === 0) throw new Error("regret_policy_delta_promotion_evidence_required");
  return {
    ...input.delta,
    status: "promoted",
    promoted_at: input.promoted_at,
    promoted_by: promotedBy,
    evidence_ids: evidenceIds,
  };
}

function policyDeltaKindForBranch(branch: BranchTrace): RegretPolicyDeltaKind {
  if (branch.branch_kind === "source_api_substrate") {
    return branch.status === "blocked" || branch.status === "failed" ? "avoid_substrate" : "prefer_substrate";
  }
  if (branch.branch_kind === "guardrail_heavy") return "add_guardrail";
  if (branch.branch_kind === "mutation_trial") return "include_mutation_trial";
  return "add_assertion";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
