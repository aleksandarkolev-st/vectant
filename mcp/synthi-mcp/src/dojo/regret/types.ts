import type { DojoGraphMode } from "../graph/types.js";

export type RegretCounterfactualRunKind =
  | "graph_execution"
  | "vivarium"
  | "wind_tunnel"
  | "checkride";

export type RegretBranchKind =
  | "baseline"
  | "conservative_graph"
  | "source_api_substrate"
  | "guardrail_heavy"
  | "latency_optimized"
  | "novel_runtime"
  | "mutation_trial";

export type RegretBranchStatus = "selected" | "passed" | "failed" | "blocked" | "near_miss" | "not_run";
export type RegretExposureLevel = "none" | "shown" | "opened" | "compared" | "selected";
export type RegretCounterfactualStrength = "none" | "weak" | "medium" | "strong";
export type RegretAmbiguityFlag =
  | "cancellation"
  | "timeout"
  | "selector_unclear"
  | "base_state_changed"
  | "evidence_incomplete"
  | "branches_not_comparable"
  | "arbiter_absent";

export type RegretRetentionPolicy = "ephemeral_trace" | "compact_fossil" | "regulated" | "disabled";

export type RegretPolicyDeltaKind =
  | "prefer_substrate"
  | "avoid_substrate"
  | "add_guardrail"
  | "add_assertion"
  | "split_node"
  | "narrow_scope"
  | "increase_oracle_budget"
  | "include_mutation_trial";

export type RegretPolicyDeltaStatus = "hypothesis" | "promoted" | "disabled" | "expired" | "contradicted";
export type RegretConfidence = "low" | "medium" | "high";

export interface RegretScope {
  tenant_id: string;
  workspace_id: string;
  skill_id?: string;
  skill_version_id?: string;
  graph_run_id?: string;
  vivarium_run_id?: string;
  checkride_run_id?: string;
  task_class: string;
  base_state_hash: string;
}

export interface CounterfactualRun extends RegretScope {
  schema_version: "synthi.dojo.regret.counterfactualRun.v1";
  counterfactual_run_id: string;
  run_kind: RegretCounterfactualRunKind;
  base_state_hash: string;
  branch_ids: string[];
  evidence_ids: string[];
  created_at: string;
  expires_at?: string;
  retention_policy: RegretRetentionPolicy;
}

export interface BranchTrace extends RegretScope {
  schema_version: "synthi.dojo.regret.branchTrace.v1";
  branch_id: string;
  counterfactual_run_id: string;
  branch_kind: RegretBranchKind;
  status: RegretBranchStatus;
  graph_mode?: DojoGraphMode;
  substrate?: string;
  blocked_by: string[];
  detector_evidence_ids: string[];
  oracle_evidence_ids: string[];
  selection_evidence_ids: string[];
  evidence_ids: string[];
  summary: string;
  created_at: string;
  expires_at?: string;
  retention_policy: RegretRetentionPolicy;
}

export interface ChoiceScene extends RegretScope {
  schema_version: "synthi.dojo.regret.choiceScene.v1";
  choice_scene_id: string;
  counterfactual_run_id: string;
  available_branch_ids: string[];
  visible_branch_ids: string[];
  opened_branch_ids: string[];
  compared_branch_ids: string[];
  selected_branch_id?: string;
  arbiter_recommended_branch_id?: string;
  cancelled: boolean;
  ambiguity_flags: RegretAmbiguityFlag[];
  evidence_ids: string[];
  created_at: string;
}

export interface BranchFossil extends RegretScope {
  schema_version: "synthi.dojo.regret.branchFossil.v1";
  fossil_id: string;
  counterfactual_run_id: string;
  branch_id: string;
  exposure_level: RegretExposureLevel;
  counterfactual_strength: RegretCounterfactualStrength;
  ambiguity_flags: RegretAmbiguityFlag[];
  summary: string;
  lesson?: string;
  evidence_ids: string[];
  redaction_manifest_sha256?: string;
  created_at: string;
  expires_at?: string;
  retention_policy: RegretRetentionPolicy;
}

export interface PolicyDelta extends RegretScope {
  schema_version: "synthi.dojo.regret.policyDelta.v1";
  policy_delta_id: string;
  delta_kind: RegretPolicyDeltaKind;
  status: RegretPolicyDeltaStatus;
  confidence: RegretConfidence;
  rationale: string;
  source_counterfactual_run_id: string;
  source_branch_id: string;
  source_choice_scene_id: string;
  evidence_ids: string[];
  promoted_at?: string;
  promoted_by?: string;
  disabled_at?: string;
  disabled_by?: string;
  expires_at?: string;
  created_at: string;
}

export interface RegretPlanningHint {
  skillId: string;
  taskClass: string;
  hintKind: RegretPolicyDeltaKind;
  confidence: RegretConfidence;
  evidenceIds: string[];
  expiresAt?: string;
}

export interface MutationTrial extends RegretScope {
  schema_version: "synthi.dojo.regret.mutationTrial.v1";
  mutation_trial_id: string;
  counterfactual_run_id: string;
  branch_id: string;
  quarantine: true;
  auto_apply_allowed: false;
  proof_passed: boolean;
  novelty_score: number;
  evidence_ids: string[];
  created_at: string;
}

export interface AcceptedSurprise extends RegretScope {
  schema_version: "synthi.dojo.regret.acceptedSurprise.v1";
  accepted_surprise_id: string;
  branch_id: string;
  novelty_score: number;
  proof_evidence_ids: string[];
  selection_evidence_ids: string[];
  created_at: string;
}

export function uniqueRegretStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function isValidRegretTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
