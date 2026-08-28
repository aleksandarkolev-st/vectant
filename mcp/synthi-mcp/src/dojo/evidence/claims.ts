export const DOJO_SUPPORTED_EVIDENCE_CLAIMS = [
  "workspace_verified",
  "checkride_passed",
  "success_assertions_defined",
  "guardrails_active",
  "durable_state_evidence",
  "evidence_fresh",
  "critical_failures_open",
  "client_id_verified",
  "line_items_total_verified",
  "origin_verified",
  "substrate_allowed",
  "source_anchor_current",
  "approval_not_required",
  "approval_granted",
  "counterfactual_run_started",
  "branch_trace_normalized",
  "branch_detector_result",
  "choice_scene_recorded",
  "branch_fossil_created",
  "regret_lesson_extracted",
  "policy_delta_proposed",
  "policy_delta_promoted",
  "mutation_trial_started",
  "mutation_trial_completed",
] as const;

export type DojoEvidenceClaimId = (typeof DOJO_SUPPORTED_EVIDENCE_CLAIMS)[number] | (string & {});
export type DojoEvidenceClaimSourceKind =
  | "trace"
  | "scenario"
  | "checkride"
  | "case_law"
  | "guardrail"
  | "license"
  | "proof"
  | "artifact"
  | "audit";

export const DOJO_EVIDENCE_CLAIM_SOURCE_KINDS: Partial<Record<
  (typeof DOJO_SUPPORTED_EVIDENCE_CLAIMS)[number],
  readonly DojoEvidenceClaimSourceKind[]
>> = {
  workspace_verified: ["trace", "scenario", "checkride", "audit"],
  checkride_passed: ["checkride"],
  success_assertions_defined: ["checkride", "artifact"],
  guardrails_active: ["guardrail", "case_law", "checkride"],
  durable_state_evidence: ["scenario", "checkride", "artifact"],
  critical_failures_open: ["checkride", "case_law", "audit"],
  client_id_verified: ["trace", "scenario", "checkride", "artifact"],
  line_items_total_verified: ["trace", "scenario", "checkride", "artifact"],
  origin_verified: ["trace", "scenario", "checkride", "audit"],
  substrate_allowed: ["license", "proof", "checkride", "audit"],
  source_anchor_current: ["artifact", "trace", "audit"],
  approval_not_required: ["license", "audit", "checkride"],
  approval_granted: ["audit", "license"],
  counterfactual_run_started: ["trace", "scenario", "checkride", "audit"],
  branch_trace_normalized: ["trace", "scenario", "checkride", "audit"],
  branch_detector_result: ["scenario", "checkride", "guardrail", "proof"],
  choice_scene_recorded: ["trace", "scenario", "checkride", "audit"],
  branch_fossil_created: ["trace", "scenario", "checkride", "audit"],
  regret_lesson_extracted: ["trace", "scenario", "checkride", "audit"],
  policy_delta_proposed: ["audit", "case_law", "guardrail", "license"],
  policy_delta_promoted: ["audit", "case_law", "guardrail", "license"],
  mutation_trial_started: ["scenario", "checkride", "guardrail"],
  mutation_trial_completed: ["scenario", "checkride", "guardrail"],
};

export function allowedEvidenceKindsForClaim(claimId: DojoEvidenceClaimId): readonly DojoEvidenceClaimSourceKind[] | undefined {
  return DOJO_EVIDENCE_CLAIM_SOURCE_KINDS[claimId as (typeof DOJO_SUPPORTED_EVIDENCE_CLAIMS)[number]];
}

export type DojoEvidenceClaimStatus = "verified" | "missing" | "stale" | "failed";

export interface DojoEvidenceClaimResult {
  claim_id: DojoEvidenceClaimId;
  ok: boolean;
  status: DojoEvidenceClaimStatus;
  evidence_record_ids: string[];
  checked_at: string;
  blocked_by: string[];
}
