export type TherapeuticAuthorityLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type TherapeuticDecision = "approved" | "denied" | "needs_human_approval";
export type TherapeuticProofTier = 0 | 1 | 2 | 3;
export type TherapeuticClaimResult = "pass" | "fail" | "not_checked";
export type TherapeuticClaimCategory = "machine_verifiable" | "human_reviewed" | "narrative";
export type TherapeuticAccessMode = "read_only" | "write";
export type TherapeuticRiskLevel = "low" | "medium" | "high" | "critical";
export type TherapeuticProbeOutputSchemaType = "string" | "number" | "boolean" | "object";

export interface TherapeuticAuthorityDose {
  id: string;
  task_id: string;
  level: TherapeuticAuthorityLevel;
  scope: string;
  permitted_tools: string[];
  permitted_data_classes: string[];
  forbidden_data_classes: string[];
  mutation_allowed: boolean;
  max_blast_radius: string;
  expiration_condition: string;
  revoke_plan: string;
  expected_effect: string;
  measured_effect?: string;
  side_effects: string[];
  decision: TherapeuticDecision;
}

export interface TherapeuticUncertainty {
  id: string;
  description: string;
  current_confidence: number;
  possible_causes: string[];
  useful_probes: string[];
  blocking_status: "open" | "reduced" | "blocked" | "resolved";
  severity: TherapeuticRiskLevel;
}

export interface TherapeuticProbeContract {
  name: string;
  purpose: string;
  task_class: string;
  required_authority_dose: TherapeuticAuthorityLevel;
  required_data_classes: string[];
  forbidden_data_classes: string[];
  input_schema: Record<string, string>;
  allowed_output_shape: string[];
  allowed_output_schema: Record<string, TherapeuticProbeOutputSchemaType>;
  forbidden_outputs: string[];
  privacy_cost: number;
  expected_information_gain: number;
  sensitivity_level: TherapeuticRiskLevel;
  failure_modes: string[];
  verifier: "allowed_shape" | "schema_and_shape";
  cache_policy: "none" | "per_task" | "case_law_template";
}

export interface TherapeuticProjectionProbe {
  id: string;
  task_id: string;
  name: string;
  task_class: string;
  target_uncertainty: string;
  required_authority_dose: TherapeuticAuthorityLevel;
  required_data_classes: string[];
  forbidden_data_classes: string[];
  input_schema: Record<string, string>;
  allowed_output_shape: string[];
  allowed_output_schema: Record<string, TherapeuticProbeOutputSchemaType>;
  privacy_cost: number;
  expected_information_gain: number;
  actual_information_gain: number;
  confidence: number;
  status: "available" | "completed" | "failed" | "blocked";
  result_summary: Record<string, unknown>;
  failure_modes: string[];
  verifier: "allowed_shape" | "schema_and_shape";
  allowed_output_shape_valid: boolean;
}

export interface TherapeuticAccessRequest {
  id: string;
  task_id: string;
  authority_dose: TherapeuticAuthorityLevel;
  scope: string;
  mode: TherapeuticAccessMode;
  data_classes: string[];
  tools: string[];
  expiration: string;
  revocable: boolean;
  purpose: string;
}

export interface TherapeuticMachineClaim {
  claim: string;
  expected: unknown;
  evidence: string;
  verifier:
    | "trace_lookup"
    | "equality_check"
    | "scope_subset_check"
    | "permission_diff_check"
    | "forbidden_class_check"
    | "expiration_check"
    | "revocation_check"
    | "mutation_separation_check"
    | "probe_output_shape_check";
  result: TherapeuticClaimResult;
  actual?: unknown;
  critical: boolean;
}

export interface TherapeuticHumanReviewedClaim {
  claim: string;
  reviewer_role: string;
  status: "approved" | "rejected" | "pending";
  rationale: string;
}

export interface TherapeuticNarrativeClaim {
  claim: string;
  status: "context_only";
}

export interface TherapeuticStrictProofCapsule {
  id: string;
  task_id: string;
  requested_access: TherapeuticAccessRequest;
  current_authority_dose: TherapeuticAuthorityLevel;
  requested_authority_dose: TherapeuticAuthorityLevel;
  machine_verifiable_claims: TherapeuticMachineClaim[];
  human_reviewed_claims: TherapeuticHumanReviewedClaim[];
  unverifiable_narrative_claims: TherapeuticNarrativeClaim[];
  evidence_links: string[];
  verifier_results: string[];
  failed_claims: string[];
  risk_score: number;
  minimality_score: number;
  approved: boolean;
  reviewer: string;
  timestamp: string;
}

export interface TherapeuticEscalationJustification {
  id: string;
  task_id: string;
  current_dose: TherapeuticAuthorityLevel;
  requested_dose: TherapeuticAuthorityLevel;
  blocked_by: string[];
  probes_attempted: string[];
  probe_results: Record<string, unknown>[];
  remaining_uncertainty: string[];
  requested_delta: string;
  why_minimal: string;
  why_lower_doses_are_insufficient: string;
  expected_information_gain: number;
  expected_risk: number;
  human_approval_required: boolean;
  rollback_or_revoke_plan: string;
}

export interface TherapeuticBlockedOverreachAttempt {
  requested_access: TherapeuticAccessRequest;
  decision: "denied";
  reason: string[];
  suggested_alternative: string[];
}

export interface TherapeuticTrace {
  schema_version: "synthi.dojo.therapeuticTrace.v1";
  task_id: string;
  task_class: string;
  user_goal: string;
  current_authority_dose: TherapeuticAuthorityLevel;
  uncertainties: TherapeuticUncertainty[];
  authority_doses: TherapeuticAuthorityDose[];
  projection_probes: TherapeuticProjectionProbe[];
  escalation_justifications: TherapeuticEscalationJustification[];
  proof_capsules: TherapeuticStrictProofCapsule[];
  blocked_overreach_attempts: TherapeuticBlockedOverreachAttempt[];
  suggested_lower_risk_alternatives: string[];
  human_overrides: string[];
  final_outcome: "diagnosed" | "blocked" | "remediated" | "in_progress";
  diagnosis: string;
  remediation_plan: string;
  avoided_access: string[];
  over_escalation_flags: string[];
  under_escalation_flags: string[];
  learned_policy_delta: string[];
}

export interface TherapeuticPolicy {
  policy_id: string;
  max_authority_dose: TherapeuticAuthorityLevel;
  forbidden_data_classes: string[];
  allowed_projection_probes: string[];
  mutation_allowed: boolean;
  sensitive_data_classes: string[];
  broad_data_classes: string[];
  broad_scopes: string[];
  human_approval_required_for: TherapeuticAuthorityLevel[];
}

export interface TherapeuticBrokerDecision {
  decision: TherapeuticDecision;
  tier: TherapeuticProofTier;
  blocked_by: string[];
  suggested_alternatives: string[];
  proof_capsule?: TherapeuticStrictProofCapsule;
}

export interface TherapeuticProofRoute {
  tier: TherapeuticProofTier;
  decision_mechanism: "auto_allow" | "deterministic_verifier" | "human_or_llm_review" | "high_risk_human_approval";
  required_gates: string[];
}

export interface TherapeuticActionScore {
  action: string;
  score: number;
  expected_information_gain: number;
  expected_task_progress: number;
  privacy_cost: number;
  blast_radius_cost: number;
  mutation_risk: number;
  time_cost: number;
  compliance_cost: number;
}

export interface TherapeuticProbeBundle {
  name: string;
  task_class: string;
  probes: TherapeuticProbeContract[];
  required_authority_dose: TherapeuticAuthorityLevel;
  required_data_classes: string[];
  forbidden_data_classes: string[];
  privacy_cost: number;
  expected_information_gain: number;
  decision: "allowed" | "denied";
  denied_by: string[];
}

export interface TherapeuticCachedProofTemplate {
  template_id: string;
  task_class: string;
  required_probe_sequence: string[];
  requested_authority_dose: TherapeuticAuthorityLevel;
  requested_data_classes: string[];
  scope_prefixes: string[];
  required_claims: string[];
  forbidden_data_classes: string[];
  expiration_required: boolean;
  revocation_required: boolean;
}

export interface TherapeuticProofCacheDecision {
  cache_hit: boolean;
  template_id: string | null;
  reusable: boolean;
  blocked_by: string[];
}

export interface TherapeuticProofMetrics {
  proof_verification_latency_p50: number;
  proof_verification_latency_p95: number;
  percent_decisions_deterministic: number;
  percent_decisions_llm_reviewed: number;
  percent_decisions_human_reviewed: number;
  average_tokens_per_access_decision: number;
  cached_proof_hit_rate: number;
  probe_bundle_success_rate: number;
  tier_1_auto_approval_rate: number;
  tier_3_escalation_rate: number;
}

export interface TherapeuticRemediationProposal {
  id: string;
  task_id: string;
  diagnosis_verified: boolean;
  proposed_change: string;
  requested_access: TherapeuticAccessRequest;
  blast_radius: string;
  rollback_plan: string;
  postcondition_checks: string[];
  human_approval: TherapeuticHumanReviewedClaim | null;
}

export interface TherapeuticRemediationGateDecision {
  decision: TherapeuticDecision;
  blocked_by: string[];
  required_gates: string[];
}

export const THERAPEUTIC_ML_QUALITY_DROP_PROBES: TherapeuticProbeContract[] = [
  {
    name: "eval_slice_compare",
    purpose: "Compare aggregate evaluation quality by segment and time window.",
    task_class: "ml_quality_drop",
    required_authority_dose: 2,
    required_data_classes: ["aggregate_evaluation_reports"],
    forbidden_data_classes: ["raw_prod_logs", "customer_identifiers", "model_weights"],
    input_schema: { time_window: "string", metric: "string" },
    allowed_output_shape: ["affected_segment", "quality_delta", "confidence", "time_window"],
    allowed_output_schema: {
      affected_segment: "string",
      quality_delta: "number",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["raw_user_logs", "customer_identifiers", "prompts", "full_database_rows"],
    privacy_cost: 1,
    expected_information_gain: 8,
    sensitivity_level: "low",
    failure_modes: ["segment_unavailable", "metric_missing"],
    verifier: "allowed_shape",
    cache_policy: "case_law_template",
  },
  {
    name: "feature_drift_summary",
    purpose: "Identify aggregate feature-distribution shifts without raw feature rows.",
    task_class: "ml_quality_drop",
    required_authority_dose: 4,
    required_data_classes: ["aggregate_feature_statistics"],
    forbidden_data_classes: ["raw_training_rows", "raw_user_logs", "customer_identifiers"],
    input_schema: { affected_segment: "string", time_window: "string" },
    allowed_output_shape: ["top_feature", "drift_score", "affected_segment", "confidence", "time_window"],
    allowed_output_schema: {
      top_feature: "string",
      drift_score: "number",
      affected_segment: "string",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["raw_training_rows", "full_feature_table", "customer_identifiers"],
    privacy_cost: 2,
    expected_information_gain: 9,
    sensitivity_level: "low",
    failure_modes: ["feature_stats_missing", "segment_not_indexed"],
    verifier: "allowed_shape",
    cache_policy: "case_law_template",
  },
  {
    name: "model_route_compare",
    purpose: "Compare aggregate traffic routing across model versions.",
    task_class: "ml_quality_drop",
    required_authority_dose: 2,
    required_data_classes: ["aggregate_route_statistics"],
    forbidden_data_classes: ["raw_prod_logs", "customer_identifiers"],
    input_schema: { time_window: "string" },
    allowed_output_shape: ["route_changed", "route_delta", "confidence", "time_window"],
    allowed_output_schema: {
      route_changed: "boolean",
      route_delta: "number",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["raw_requests", "customer_identifiers"],
    privacy_cost: 1,
    expected_information_gain: 6,
    sensitivity_level: "low",
    failure_modes: ["route_stats_missing"],
    verifier: "allowed_shape",
    cache_policy: "per_task",
  },
  {
    name: "feature_lineage_hash",
    purpose: "Read lineage and transform hashes for one evidence-supported feature.",
    task_class: "ml_quality_drop",
    required_authority_dose: 5,
    required_data_classes: ["feature_lineage_hash"],
    forbidden_data_classes: ["raw_prod_logs", "raw_training_rows", "full_feature_table"],
    input_schema: { feature_name: "string" },
    allowed_output_shape: ["feature_name", "training_transform_hash", "serving_transform_hash", "skew_detected", "confidence"],
    allowed_output_schema: {
      feature_name: "string",
      training_transform_hash: "string",
      serving_transform_hash: "string",
      skew_detected: "boolean",
      confidence: "number",
    },
    forbidden_outputs: ["raw_feature_values", "customer_identifiers", "full_lineage_graph"],
    privacy_cost: 3,
    expected_information_gain: 8,
    sensitivity_level: "medium",
    failure_modes: ["feature_not_found", "hash_unavailable"],
    verifier: "allowed_shape",
    cache_policy: "per_task",
  },
];

export const THERAPEUTIC_DEFAULT_POLICY: TherapeuticPolicy = {
  policy_id: "therapeutic_tomography_default_v1",
  max_authority_dose: 7,
  forbidden_data_classes: ["raw_prod_logs", "full_database", "model_weights", "admin_privileges"],
  allowed_projection_probes: THERAPEUTIC_ML_QUALITY_DROP_PROBES.map((probe) => probe.name),
  mutation_allowed: false,
  sensitive_data_classes: ["raw_prod_logs", "full_database", "model_weights", "customer_identifiers", "admin_privileges"],
  broad_data_classes: ["raw_prod_logs", "full_database", "model_weights", "admin_privileges"],
  broad_scopes: ["production", "all", "global", "*"],
  human_approval_required_for: [7, 8],
};

export const THERAPEUTIC_PROOF_CACHE_TEMPLATES: TherapeuticCachedProofTemplate[] = [
  {
    template_id: "ml_quality_drop_feature_lineage_v1",
    task_class: "ml_quality_drop",
    required_probe_sequence: ["eval_slice_compare", "feature_drift_summary"],
    requested_authority_dose: 5,
    requested_data_classes: ["feature_lineage_hash"],
    scope_prefixes: ["feature:"],
    required_claims: [
      "lower_risk_probe_attempted",
      "completed_probe_outputs_shape_valid",
      "requested_scope_is_supported_minimal_scope",
      "request_is_read_only",
      "forbidden_data_not_requested",
      "expiration_defined",
      "revocation_defined",
    ],
    forbidden_data_classes: ["raw_prod_logs", "full_database", "model_weights", "admin_privileges"],
    expiration_required: true,
    revocation_required: true,
  },
];

export function scoreTherapeuticAction(input: {
  action: string;
  expected_information_gain: number;
  expected_task_progress: number;
  privacy_cost?: number;
  blast_radius_cost?: number;
  mutation_risk?: number;
  time_cost?: number;
  compliance_cost?: number;
}): TherapeuticActionScore {
  const privacyCost = input.privacy_cost ?? 0;
  const blastRadiusCost = input.blast_radius_cost ?? 0;
  const mutationRisk = input.mutation_risk ?? 0;
  const timeCost = input.time_cost ?? 0;
  const complianceCost = input.compliance_cost ?? 0;
  return {
    action: input.action,
    expected_information_gain: input.expected_information_gain,
    expected_task_progress: input.expected_task_progress,
    privacy_cost: privacyCost,
    blast_radius_cost: blastRadiusCost,
    mutation_risk: mutationRisk,
    time_cost: timeCost,
    compliance_cost: complianceCost,
    score: input.expected_information_gain
      + input.expected_task_progress
      - privacyCost
      - blastRadiusCost
      - mutationRisk
      - timeCost
      - complianceCost,
  };
}

export function buildSafeProbeBundle(input: {
  name: string;
  task_class: string;
  current_authority_dose: TherapeuticAuthorityLevel;
  contracts: TherapeuticProbeContract[];
  policy?: TherapeuticPolicy;
  max_probe_count?: number;
  max_bundle_authority_dose?: TherapeuticAuthorityLevel;
}): TherapeuticProbeBundle {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const maxProbeCount = Math.max(1, input.max_probe_count ?? 3);
  const maxBundleAuthorityDose = input.max_bundle_authority_dose ?? 4;
  const probes = input.contracts
    .filter((contract) => contract.task_class === input.task_class)
    .filter((contract) => policy.allowed_projection_probes.includes(contract.name))
    .filter((contract) => contract.required_authority_dose <= maxBundleAuthorityDose)
    .filter((contract) => contract.sensitivity_level === "low")
    .filter((contract) => contract.required_data_classes.every((dataClass) => !policy.sensitive_data_classes.includes(dataClass)))
    .sort((left, right) => {
      const scoreDelta = probeUsefulnessRatio(right) - probeUsefulnessRatio(left);
      if (scoreDelta !== 0) return scoreDelta;
      return left.required_authority_dose - right.required_authority_dose;
    })
    .slice(0, maxProbeCount);
  const requiredDataClasses = uniqueStrings(probes.flatMap((probe) => probe.required_data_classes));
  const forbiddenDataClasses = uniqueStrings(probes.flatMap((probe) => probe.forbidden_data_classes));
  const deniedBy: string[] = [];
  if (probes.length === 0) deniedBy.push("no_safe_probe_available");
  if (requiredDataClasses.some((dataClass) => policy.forbidden_data_classes.includes(dataClass))) deniedBy.push("forbidden_data_required");
  if (probes.some((probe) => probe.required_authority_dose > policy.max_authority_dose)) deniedBy.push("authority_dose_exceeds_policy");
  return {
    name: input.name,
    task_class: input.task_class,
    probes,
    required_authority_dose: maxAuthorityDose(probes),
    required_data_classes: requiredDataClasses,
    forbidden_data_classes: forbiddenDataClasses,
    privacy_cost: probes.reduce((sum, probe) => sum + probe.privacy_cost, 0),
    expected_information_gain: probes.reduce((sum, probe) => sum + probe.expected_information_gain, 0),
    decision: deniedBy.length === 0 ? "allowed" : "denied",
    denied_by: deniedBy,
  };
}

export function selectLowestRiskProbe(input: {
  task_class: string;
  uncertainty_id: string;
  current_authority_dose: TherapeuticAuthorityLevel;
  contracts: TherapeuticProbeContract[];
  policy?: TherapeuticPolicy;
  attempted_probe_names?: string[];
}): TherapeuticProbeContract | null {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const attempted = new Set(input.attempted_probe_names ?? []);
  const candidates = input.contracts
    .filter((contract) => contract.task_class === input.task_class)
    .filter((contract) => !attempted.has(contract.name))
    .filter((contract) => policy.allowed_projection_probes.includes(contract.name))
    .filter((contract) => contract.required_authority_dose <= Math.max(input.current_authority_dose, 2))
    .filter((contract) => contract.forbidden_data_classes.every((item) => !contract.required_data_classes.includes(item)));
  candidates.sort((left, right) => {
    const leftScore = probeUsefulnessRatio(left);
    const rightScore = probeUsefulnessRatio(right);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.required_authority_dose - right.required_authority_dose;
  });
  return candidates[0] ?? null;
}

export function evaluateProofCache(input: {
  trace: TherapeuticTrace;
  request: TherapeuticAccessRequest;
  proof_capsule: TherapeuticStrictProofCapsule;
  templates?: TherapeuticCachedProofTemplate[];
}): TherapeuticProofCacheDecision {
  const templates = input.templates ?? THERAPEUTIC_PROOF_CACHE_TEMPLATES;
  for (const template of templates) {
    const blockedBy = proofTemplateBlockedBy(template, input.trace, input.request, input.proof_capsule);
    if (blockedBy.length === 0) {
      return {
        cache_hit: true,
        template_id: template.template_id,
        reusable: true,
        blocked_by: [],
      };
    }
  }
  return {
    cache_hit: false,
    template_id: null,
    reusable: false,
    blocked_by: ["no_matching_safe_template"],
  };
}

export function evaluateUnderEscalation(input: {
  trace: TherapeuticTrace;
  severity?: TherapeuticRiskLevel;
  blocked_uncertainty_ids?: string[];
  available_requests?: TherapeuticAccessRequest[];
  policy?: TherapeuticPolicy;
}): { under_escalated: boolean; recommended_request: TherapeuticAccessRequest | null; flags: string[] } {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const severity = input.severity ?? highestTraceSeverity(input.trace);
  const blockedIds = new Set(input.blocked_uncertainty_ids ?? input.trace.uncertainties
    .filter((uncertainty) => uncertainty.blocking_status === "blocked")
    .map((uncertainty) => uncertainty.id));
  const completed = new Set(completedProbeNames(input.trace));
  const usableRequests = (input.available_requests ?? [])
    .filter((request) => request.authority_dose <= policy.max_authority_dose)
    .filter((request) => request.mode === "read_only")
    .filter((request) => request.data_classes.every((dataClass) => !policy.forbidden_data_classes.includes(dataClass)))
    .sort((left, right) => left.authority_dose - right.authority_dose);
  const flags: string[] = [];
  if (blockedIds.size > 0) flags.push("uncertainty_blocked");
  if (["high", "critical"].includes(severity)) flags.push("serious_incident");
  if (completed.size > 0) flags.push("lower_risk_probe_attempted");
  if (usableRequests.length > 0) flags.push("scoped_read_only_escalation_available");
  const underEscalated = flags.includes("uncertainty_blocked")
    && flags.includes("serious_incident")
    && flags.includes("lower_risk_probe_attempted")
    && flags.includes("scoped_read_only_escalation_available");
  return {
    under_escalated: underEscalated,
    recommended_request: underEscalated ? usableRequests[0] ?? null : null,
    flags,
  };
}

export function evaluateRemediationGate(input: {
  trace: TherapeuticTrace;
  proposal: TherapeuticRemediationProposal;
  policy?: TherapeuticPolicy;
}): TherapeuticRemediationGateDecision {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const blockedBy: string[] = [];
  const requiredGates = ["diagnosis_proof_gate", "remediation_proposal_gate", "write_authority_gate", "rollback_gate", "postcondition_verification_gate"];
  if (!input.proposal.diagnosis_verified || input.trace.final_outcome !== "diagnosed") blockedBy.push("diagnosis_not_verified");
  if (input.proposal.requested_access.mode !== "write") blockedBy.push("write_access_not_requested_for_remediation");
  if (input.proposal.requested_access.authority_dose < 7) blockedBy.push("write_authority_dose_too_low");
  if (!policy.mutation_allowed) blockedBy.push("mutation_not_allowed_by_policy");
  if (!input.proposal.blast_radius.trim()) blockedBy.push("blast_radius_missing");
  if (!input.proposal.rollback_plan.trim()) blockedBy.push("rollback_plan_missing");
  if (input.proposal.postcondition_checks.length === 0) blockedBy.push("postcondition_checks_missing");
  if (input.proposal.human_approval?.status !== "approved") blockedBy.push("human_approval_required");
  if (input.proposal.requested_access.data_classes.some((dataClass) => policy.forbidden_data_classes.includes(dataClass))) {
    blockedBy.push("forbidden_data_requested");
  }
  return {
    decision: blockedBy.length === 0 ? "approved" : "denied",
    blocked_by: uniqueStrings(blockedBy),
    required_gates: requiredGates,
  };
}

export function summarizeProofMetrics(input: {
  decisions: Array<TherapeuticBrokerDecision & {
    verification_latency_ms?: number;
    llm_reviewed?: boolean;
    human_reviewed?: boolean;
    token_count?: number;
    cache_hit?: boolean;
    probe_bundle_success?: boolean;
  }>;
}): TherapeuticProofMetrics {
  const decisions = input.decisions;
  const latencies = decisions.map((decision) => decision.verification_latency_ms ?? 0).sort((left, right) => left - right);
  return {
    proof_verification_latency_p50: percentile(latencies, 0.5),
    proof_verification_latency_p95: percentile(latencies, 0.95),
    percent_decisions_deterministic: percent(decisions, (decision) => decision.tier <= 1 && !decision.llm_reviewed && !decision.human_reviewed),
    percent_decisions_llm_reviewed: percent(decisions, (decision) => decision.llm_reviewed === true),
    percent_decisions_human_reviewed: percent(decisions, (decision) => decision.human_reviewed === true || decision.tier === 3),
    average_tokens_per_access_decision: average(decisions.map((decision) => decision.token_count ?? 0)),
    cached_proof_hit_rate: percent(decisions, (decision) => decision.cache_hit === true),
    probe_bundle_success_rate: percent(decisions, (decision) => decision.probe_bundle_success === true),
    tier_1_auto_approval_rate: percent(decisions.filter((decision) => decision.tier === 1), (decision) => decision.decision === "approved"),
    tier_3_escalation_rate: percent(decisions, (decision) => decision.tier === 3),
  };
}

export function buildProjectionProbe(input: {
  id: string;
  task_id: string;
  contract: TherapeuticProbeContract;
  target_uncertainty: string;
  result_summary: Record<string, unknown>;
  actual_information_gain: number;
  confidence: number;
  status?: TherapeuticProjectionProbe["status"];
}): TherapeuticProjectionProbe {
  return {
    id: input.id,
    task_id: input.task_id,
    name: input.contract.name,
    task_class: input.contract.task_class,
    target_uncertainty: input.target_uncertainty,
    required_authority_dose: input.contract.required_authority_dose,
    required_data_classes: [...input.contract.required_data_classes],
    forbidden_data_classes: [...input.contract.forbidden_data_classes],
    input_schema: { ...input.contract.input_schema },
    allowed_output_shape: [...input.contract.allowed_output_shape],
    allowed_output_schema: { ...input.contract.allowed_output_schema },
    privacy_cost: input.contract.privacy_cost,
    expected_information_gain: input.contract.expected_information_gain,
    actual_information_gain: input.actual_information_gain,
    confidence: input.confidence,
    status: input.status ?? "completed",
    result_summary: { ...input.result_summary },
    failure_modes: [...input.contract.failure_modes],
    verifier: input.contract.verifier,
    allowed_output_shape_valid: probeOutputShapeValid(input.contract, input.result_summary),
  };
}

export function evaluateAuthorityBroker(input: {
  trace: TherapeuticTrace;
  request: TherapeuticAccessRequest;
  policy?: TherapeuticPolicy;
  proof_capsule?: TherapeuticStrictProofCapsule;
}): TherapeuticBrokerDecision {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const blockedBy: string[] = [];
  const alternatives = lowerRiskAlternatives(input.trace, policy);
  const proofRoute = classifyTherapeuticProofRoute({ request: input.request, policy });
  const tier = proofRoute.tier;
  const includesForbidden = input.request.data_classes.some((dataClass) => policy.forbidden_data_classes.includes(dataClass));
  const includesSensitive = input.request.data_classes.some((dataClass) => policy.sensitive_data_classes.includes(dataClass));
  const broad = isBroadAccessRequest(input.request, policy);
  const diagnosticEscalationNeedsProof = tier >= 1 && input.request.authority_dose >= 5;
  if (input.request.authority_dose > policy.max_authority_dose) blockedBy.push("authority_dose_exceeds_policy");
  if (includesForbidden) blockedBy.push("forbidden_data_requested");
  if (input.request.mode === "write" && !policy.mutation_allowed) blockedBy.push("mutation_not_allowed_by_policy");
  if (broad && alternatives.length > 0) blockedBy.push("lower_risk_probe_available");
  if (broad && completedProbeNames(input.trace).length === 0) blockedBy.push("no_probe_attempted");
  if ((includesSensitive || diagnosticEscalationNeedsProof) && !input.proof_capsule) blockedBy.push("strict_proof_capsule_required");
  if (input.proof_capsule && !input.proof_capsule.approved) blockedBy.push("strict_proof_capsule_invalid");
  if (policy.human_approval_required_for.includes(input.request.authority_dose) && !hasApprovedHumanClaim(input.proof_capsule)) {
    blockedBy.push("human_approval_required");
  }
  if (blockedBy.length > 0) {
    return {
      decision: "denied",
      tier,
      blocked_by: uniqueStrings(blockedBy),
      suggested_alternatives: alternatives,
      ...(input.proof_capsule ? { proof_capsule: input.proof_capsule } : {}),
    };
  }
  return {
    decision: tier >= 2 && !hasApprovedHumanClaim(input.proof_capsule) ? "needs_human_approval" : "approved",
    tier,
    blocked_by: [],
    suggested_alternatives: [],
    ...(input.proof_capsule ? { proof_capsule: input.proof_capsule } : {}),
  };
}

export function routeTherapeuticProof(input: {
  request: TherapeuticAccessRequest;
  policy?: TherapeuticPolicy;
}): TherapeuticProofTier {
  return classifyTherapeuticProofRoute(input).tier;
}

export function classifyTherapeuticProofRoute(input: {
  request: TherapeuticAccessRequest;
  policy?: TherapeuticPolicy;
}): TherapeuticProofRoute {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  if (input.request.authority_dose <= 1 && input.request.mode === "read_only") {
    return { tier: 0, decision_mechanism: "auto_allow", required_gates: ["light_trace_log"] };
  }
  if (input.request.mode === "write" || input.request.authority_dose >= 7) {
    return {
      tier: 3,
      decision_mechanism: "high_risk_human_approval",
      required_gates: ["deterministic_verifier", "strict_proof_capsule", "human_approval", "rollback_plan", "postcondition_check"],
    };
  }
  if (input.request.data_classes.some((dataClass) => policy.sensitive_data_classes.includes(dataClass)) || isBroadAccessRequest(input.request, policy)) {
    return {
      tier: 3,
      decision_mechanism: "high_risk_human_approval",
      required_gates: ["deterministic_verifier", "strict_proof_capsule", "forbidden_data_gate", "human_approval"],
    };
  }
  if (isAmbiguousScopedRequest(input.request)) {
    return {
      tier: 2,
      decision_mechanism: "human_or_llm_review",
      required_gates: ["deterministic_verifier", "strict_proof_capsule", "judgment_claim_review"],
    };
  }
  return {
    tier: 1,
    decision_mechanism: "deterministic_verifier",
    required_gates: ["trace_lookup_gate", "probe_output_schema_gate", "scope_subset_gate", "forbidden_data_gate", "expiration_gate", "revocation_gate"],
  };
}

export function buildStrictProofCapsule(input: {
  id: string;
  task_id: string;
  trace: TherapeuticTrace;
  request: TherapeuticAccessRequest;
  current_authority_dose: TherapeuticAuthorityLevel;
  supported_scope_values?: string[];
  policy?: TherapeuticPolicy;
  machine_verifiable_claims?: TherapeuticMachineClaim[];
  human_reviewed_claims?: TherapeuticHumanReviewedClaim[];
  unverifiable_narrative_claims?: TherapeuticNarrativeClaim[];
  timestamp?: string;
  reviewer?: string;
}): TherapeuticStrictProofCapsule {
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const supportedScopeValues = input.supported_scope_values?.length
    ? input.supported_scope_values
    : inferSupportedScopeValues(input.trace);
  const machineClaims = input.machine_verifiable_claims ?? verifyMachineClaims({
      trace: input.trace,
      request: input.request,
      supported_scope_values: supportedScopeValues,
      policy,
    });
  const failedClaims = machineClaims
    .filter((claim) => claim.result === "fail")
    .map((claim) => claim.claim);
  const criticalFailures = machineClaims.some((claim) => claim.critical && claim.result !== "pass");
  const narrativeOnly = machineClaims.length === 0 && (input.human_reviewed_claims ?? []).length === 0;
  if (narrativeOnly) failedClaims.push("narrative_only_proof");
  const riskScore = authorityRiskScore(input.request, policy);
  const minimalityScore = minimalityScoreForRequest(input.request, supportedScopeValues, failedClaims);
  const approved = !criticalFailures
    && !narrativeOnly
    && minimalityScore >= 0.75
    && riskScore < 10
    && (input.request.mode === "read_only" || hasApprovedHumanClaim({
      human_reviewed_claims: input.human_reviewed_claims ?? [],
    }));
  return {
    id: input.id,
    task_id: input.task_id,
    requested_access: cloneJson(input.request),
    current_authority_dose: input.current_authority_dose,
    requested_authority_dose: input.request.authority_dose,
    machine_verifiable_claims: machineClaims,
    human_reviewed_claims: [...(input.human_reviewed_claims ?? [])],
    unverifiable_narrative_claims: [...(input.unverifiable_narrative_claims ?? [])],
    evidence_links: machineClaims
      .filter((claim) => claim.result === "pass")
      .map((claim) => claim.evidence),
    verifier_results: machineClaims.map((claim) => `${claim.claim}:${claim.result}`),
    failed_claims: uniqueStrings(failedClaims),
    risk_score: riskScore,
    minimality_score: minimalityScore,
    approved,
    reviewer: input.reviewer ?? "deterministic-proof-router",
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export function buildMlQualityDropTherapeuticDemoTrace(now = "2026-06-28T00:00:00.000Z"): TherapeuticTrace {
  const taskId = "quality_drop_demo_001";
  const initialTrace = emptyTherapeuticTrace({
    task_id: taskId,
    task_class: "ml_quality_drop",
    user_goal: "Diagnose why a production AI model dropped 9% in quality.",
    current_authority_dose: 2,
  });
  initialTrace.uncertainties.push({
    id: "quality_drop_cause",
    description: "Which segment and feature caused the quality drop?",
    current_confidence: 0.2,
    possible_causes: ["data_drift", "model_routing", "train_serve_skew", "evaluation_pipeline_change"],
    useful_probes: ["eval_slice_compare", "feature_drift_summary", "model_route_compare"],
    blocking_status: "open",
    severity: "high",
  });
  const rawLogsRequest: TherapeuticAccessRequest = {
    id: "access_raw_logs_001",
    task_id: taskId,
    authority_dose: 8,
    scope: "production",
    mode: "read_only",
    data_classes: ["raw_prod_logs"],
    tools: ["log_query"],
    expiration: "end_of_task",
    revocable: true,
    purpose: "Agent requested raw logs before lower-risk probes.",
  };
  const denied = evaluateAuthorityBroker({ trace: initialTrace, request: rawLogsRequest });
  initialTrace.blocked_overreach_attempts.push({
    requested_access: rawLogsRequest,
    decision: "denied",
    reason: denied.blocked_by,
    suggested_alternative: denied.suggested_alternatives,
  });
  initialTrace.suggested_lower_risk_alternatives.push(...denied.suggested_alternatives);

  const evalProbe = buildProjectionProbe({
    id: "probe_eval_slice_001",
    task_id: taskId,
    contract: contractByName("eval_slice_compare"),
    target_uncertainty: "quality_drop_cause",
    result_summary: {
      affected_segment: "enterprise_users",
      quality_delta: -0.09,
      confidence: 0.84,
      time_window: "last_24h",
    },
    actual_information_gain: 7,
    confidence: 0.84,
  });
  const driftProbe = buildProjectionProbe({
    id: "probe_feature_drift_001",
    task_id: taskId,
    contract: contractByName("feature_drift_summary"),
    target_uncertainty: "quality_drop_cause",
    result_summary: {
      top_feature: "customer_plan",
      drift_score: 0.91,
      affected_segment: "enterprise_users",
      confidence: 0.88,
      time_window: "last_24h",
    },
    actual_information_gain: 8,
    confidence: 0.88,
  });
  initialTrace.projection_probes.push(evalProbe, driftProbe);
  initialTrace.current_authority_dose = 4;

  const lineageRequest: TherapeuticAccessRequest = {
    id: "access_lineage_customer_plan_001",
    task_id: taskId,
    authority_dose: 5,
    scope: "feature:customer_plan",
    mode: "read_only",
    data_classes: ["feature_lineage_hash"],
    tools: ["feature_lineage_hash"],
    expiration: "end_of_task",
    revocable: true,
    purpose: "Verify whether customer_plan drift is train/serve skew.",
  };
  const proofCapsule = buildStrictProofCapsule({
    id: "proof_001",
    task_id: taskId,
    trace: initialTrace,
    request: lineageRequest,
    current_authority_dose: 4,
    supported_scope_values: ["feature:customer_plan"],
    human_reviewed_claims: [{
      claim: "lineage_access_is_reasonable_next_step",
      reviewer_role: "ml_engineer",
      status: "approved",
      rationale: "customer_plan drift is the strongest current machine-verifiable lead.",
    }],
    unverifiable_narrative_claims: [{
      claim: "Agent believes lineage will confirm train/serve skew.",
      status: "context_only",
    }],
    timestamp: now,
  });
  const brokerDecision = evaluateAuthorityBroker({
    trace: initialTrace,
    request: lineageRequest,
    proof_capsule: proofCapsule,
  });
  initialTrace.proof_capsules.push(proofCapsule);
  initialTrace.escalation_justifications.push({
    id: "escalation_lineage_customer_plan_001",
    task_id: taskId,
    current_dose: 4,
    requested_dose: 5,
    blocked_by: brokerDecision.blocked_by,
    probes_attempted: completedProbeNames(initialTrace),
    probe_results: initialTrace.projection_probes.map((probe) => ({
      name: probe.name,
      result_summary: probe.result_summary,
    })),
    remaining_uncertainty: ["train_serve_skew_confirmation"],
    requested_delta: "read-only lineage hash for feature:customer_plan",
    why_minimal: "The requested scope is the one feature identified by aggregate drift.",
    why_lower_doses_are_insufficient: "Aggregate probes identified the segment and feature but cannot compare training and serving transform hashes.",
    expected_information_gain: 8,
    expected_risk: 3,
    human_approval_required: false,
    rollback_or_revoke_plan: "expire and revoke at end_of_task",
  });
  initialTrace.authority_doses.push({
    id: "dose_lineage_customer_plan_001",
    task_id: taskId,
    level: 5,
    scope: "feature:customer_plan",
    permitted_tools: ["feature_lineage_hash"],
    permitted_data_classes: ["feature_lineage_hash"],
    forbidden_data_classes: ["raw_prod_logs", "full_database", "model_weights", "admin_privileges", "write_access"],
    mutation_allowed: false,
    max_blast_radius: "single_feature_lineage_hash",
    expiration_condition: "end_of_task",
    revoke_plan: "revoke temporary lineage grant when trace closes",
    expected_effect: "confirm or reject train/serve skew for customer_plan",
    measured_effect: "training_transform_hash != serving_transform_hash",
    side_effects: [],
    decision: brokerDecision.decision === "approved" ? "approved" : "denied",
  });
  initialTrace.current_authority_dose = 5;
  initialTrace.final_outcome = "diagnosed";
  initialTrace.diagnosis = "train_serve_skew in customer_plan transformation";
  initialTrace.remediation_plan = "Prepare a separate remediation proof before any serving transform write; include blast-radius estimate, rollback, and postcondition checks.";
  initialTrace.avoided_access = ["raw_prod_logs", "full_database", "model_weights", "admin_privileges", "write_access"];
  initialTrace.learned_policy_delta = [
    "For ml_quality_drop, prefer eval_slice_compare and feature_drift_summary before lineage.",
    "Approve one-feature read-only lineage when aggregate drift identifies a single suspicious feature and forbidden classes are absent.",
  ];
  return initialTrace;
}

export function emptyTherapeuticTrace(input: {
  task_id: string;
  task_class: string;
  user_goal: string;
  current_authority_dose?: TherapeuticAuthorityLevel;
}): TherapeuticTrace {
  return {
    schema_version: "synthi.dojo.therapeuticTrace.v1",
    task_id: input.task_id,
    task_class: input.task_class,
    user_goal: input.user_goal,
    current_authority_dose: input.current_authority_dose ?? 0,
    uncertainties: [],
    authority_doses: [],
    projection_probes: [],
    escalation_justifications: [],
    proof_capsules: [],
    blocked_overreach_attempts: [],
    suggested_lower_risk_alternatives: [],
    human_overrides: [],
    final_outcome: "in_progress",
    diagnosis: "",
    remediation_plan: "",
    avoided_access: [],
    over_escalation_flags: [],
    under_escalation_flags: [],
    learned_policy_delta: [],
  };
}

function verifyMachineClaims(input: {
  trace: TherapeuticTrace;
  request: TherapeuticAccessRequest;
  supported_scope_values: string[];
  policy: TherapeuticPolicy;
}): TherapeuticMachineClaim[] {
  const completedProbes = input.trace.projection_probes.filter((probe) => probe.status === "completed");
  const lowerRiskCompletedProbes = completedProbes.filter((probe) => probe.required_authority_dose < input.request.authority_dose);
  const completedProbeNamesValue = lowerRiskCompletedProbes.map((probe) => probe.name);
  return [
    claim(
      "lower_risk_probe_attempted",
      "at_least_one_completed_lower_risk_probe",
      "trace.projection_probes[required_authority_dose < access_request.authority_dose].status",
      "trace_lookup",
      lowerRiskCompletedProbes.length > 0,
      completedProbeNamesValue,
      input.request.authority_dose > 1
    ),
    claim(
      "completed_probe_outputs_shape_valid",
      true,
      "trace.projection_probes.completed.allowed_output_shape_valid",
      "probe_output_shape_check",
      lowerRiskCompletedProbes.length > 0 && lowerRiskCompletedProbes.every((probe) => probe.allowed_output_shape_valid === true),
      lowerRiskCompletedProbes.map((probe) => ({ name: probe.name, allowed_output_shape_valid: probe.allowed_output_shape_valid })),
      input.request.authority_dose > 1
    ),
    ...buildEvidenceValueClaims(input.trace),
    claim("requested_scope_is_supported_minimal_scope", input.supported_scope_values, "access_request.scope", "scope_subset_check", input.supported_scope_values.includes(input.request.scope), input.request.scope, true),
    claim("request_is_read_only", true, "access_request.mode", "permission_diff_check", input.request.mode === "read_only", input.request.mode, true),
    claim("forbidden_data_not_requested", input.policy.forbidden_data_classes, "access_request.data_classes", "forbidden_class_check", input.request.data_classes.every((item) => !input.policy.forbidden_data_classes.includes(item)), input.request.data_classes, true),
    claim("expiration_defined", true, "access_request.expiration", "expiration_check", Boolean(input.request.expiration.trim()), input.request.expiration, true),
    claim("revocation_defined", true, "access_request.revocable", "revocation_check", input.request.revocable === true, input.request.revocable, true),
    claim("diagnosis_request_has_no_write_access", true, "access_request.mode", "mutation_separation_check", input.request.mode !== "write", input.request.mode, true),
  ];
}

function buildEvidenceValueClaims(trace: TherapeuticTrace): TherapeuticMachineClaim[] {
  const claims: TherapeuticMachineClaim[] = [];
  for (const probe of trace.projection_probes.filter((item) => item.status === "completed")) {
    for (const [key, value] of Object.entries(probe.result_summary)) {
      if (!isClaimWorthyProbeValue(value)) continue;
      claims.push(claim(
        `${probe.name}_${key}_identified`,
        value,
        `trace.projection_probes.${probe.name}.output.${key}`,
        "equality_check",
        true,
        value,
        false
      ));
    }
  }
  return claims;
}

function isClaimWorthyProbeValue(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "boolean";
}

export function inferSupportedScopeValues(trace: TherapeuticTrace): string[] {
  const scopes = new Set<string>();
  for (const probe of trace.projection_probes) {
    for (const [key, value] of Object.entries(probe.result_summary)) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const normalized = value.trim();
      if (key === "top_feature" || key === "feature_name") scopes.add(`feature:${normalized}`);
      if (key === "affected_segment" || key === "segment") scopes.add(`segment:${normalized}`);
      if (key === "service_name") scopes.add(`service:${normalized}`);
      if (key === "route_name" || key === "model_route") scopes.add(`route:${normalized}`);
    }
  }
  return [...scopes];
}

function claim(
  claimName: string,
  expected: unknown,
  evidence: string,
  verifier: TherapeuticMachineClaim["verifier"],
  ok: boolean,
  actual: unknown,
  critical: boolean
): TherapeuticMachineClaim {
  return {
    claim: claimName,
    expected,
    evidence,
    verifier,
    result: ok ? "pass" : "fail",
    actual,
    critical,
  };
}

function probeOutputShapeValid(contract: TherapeuticProbeContract, output: Record<string, unknown>): boolean {
  const allowed = new Set(contract.allowed_output_shape);
  const schemaEntries = Object.entries(contract.allowed_output_schema);
  return Object.keys(output).every((key) => allowed.has(key))
    && schemaEntries.every(([key, type]) => valueMatchesSchemaType(output[key], type))
    && contract.forbidden_outputs.every((key) => !containsForbiddenOutputMarker(output, key));
}

function valueMatchesSchemaType(value: unknown, type: TherapeuticProbeOutputSchemaType): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function containsForbiddenOutputMarker(value: unknown, marker: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenOutputMarker(item, marker));
  return Object.entries(value as Record<string, unknown>).some(([key, nestedValue]) => (
    key === marker || containsForbiddenOutputMarker(nestedValue, marker)
  ));
}

function probeUsefulnessRatio(contract: TherapeuticProbeContract): number {
  const cost = Math.max(1, contract.privacy_cost + contract.required_authority_dose);
  return contract.expected_information_gain / cost;
}

function isBroadAccessRequest(request: TherapeuticAccessRequest, policy: TherapeuticPolicy): boolean {
  return policy.broad_scopes.includes(request.scope.toLowerCase())
    || request.data_classes.some((dataClass) => policy.broad_data_classes.includes(dataClass))
    || request.authority_dose >= 8;
}

function isAmbiguousScopedRequest(request: TherapeuticAccessRequest): boolean {
  const scopedTargets = request.scope
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return scopedTargets.length > 1
    || request.data_classes.some((dataClass) => [
      "redacted_failure_cluster",
      "redacted_failure_samples",
      "scoped_service_config",
      "multi_feature_lineage",
    ].includes(dataClass))
    || request.tools.length > 1;
}

function lowerRiskAlternatives(trace: TherapeuticTrace, policy: TherapeuticPolicy): string[] {
  const attempted = new Set(completedProbeNames(trace));
  return policy.allowed_projection_probes.filter((probeName) => !attempted.has(probeName)).slice(0, 3);
}

function completedProbeNames(trace: TherapeuticTrace): string[] {
  return trace.projection_probes
    .filter((probe) => probe.status === "completed")
    .map((probe) => probe.name);
}

function probeByName(trace: TherapeuticTrace, name: string): TherapeuticProjectionProbe | undefined {
  return trace.projection_probes.find((probe) => probe.name === name);
}

function authorityRiskScore(request: TherapeuticAccessRequest, policy: TherapeuticPolicy): number {
  let score = request.authority_dose;
  if (request.mode === "write") score += 4;
  score += request.data_classes.filter((dataClass) => policy.sensitive_data_classes.includes(dataClass)).length * 3;
  if (isBroadAccessRequest(request, policy)) score += 5;
  if (!request.revocable) score += 2;
  if (!request.expiration.trim()) score += 2;
  return score;
}

function minimalityScoreForRequest(
  request: TherapeuticAccessRequest,
  supportedScopeValues: string[],
  failedClaims: string[]
): number {
  let score = 1;
  if (!supportedScopeValues.includes(request.scope)) score -= 0.35;
  if (request.data_classes.length > 1) score -= Math.min(0.3, (request.data_classes.length - 1) * 0.1);
  if (failedClaims.includes("requested_scope_is_supported_minimal_scope")) score -= 0.35;
  if (request.authority_dose >= 8) score -= 0.5;
  return Math.max(0, Number(score.toFixed(3)));
}

function proofTemplateBlockedBy(
  template: TherapeuticCachedProofTemplate,
  trace: TherapeuticTrace,
  request: TherapeuticAccessRequest,
  proofCapsule: TherapeuticStrictProofCapsule
): string[] {
  const blockedBy: string[] = [];
  if (trace.task_class !== template.task_class) blockedBy.push("task_class_mismatch");
  if (request.authority_dose !== template.requested_authority_dose) blockedBy.push("authority_dose_mismatch");
  if (!template.scope_prefixes.some((prefix) => request.scope.startsWith(prefix))) blockedBy.push("scope_prefix_mismatch");
  if (!arraySubset(template.requested_data_classes, request.data_classes)) blockedBy.push("data_class_mismatch");
  if (request.data_classes.some((dataClass) => template.forbidden_data_classes.includes(dataClass))) blockedBy.push("forbidden_data_requested");
  if (template.expiration_required && !request.expiration.trim()) blockedBy.push("expiration_missing");
  if (template.revocation_required && request.revocable !== true) blockedBy.push("revocation_missing");
  if (!containsOrderedSubsequence(completedProbeNames(trace), template.required_probe_sequence)) blockedBy.push("probe_sequence_mismatch");
  const passedClaims = new Set(proofCapsule.machine_verifiable_claims
    .filter((claim) => claim.result === "pass")
    .map((claim) => claim.claim));
  for (const claim of template.required_claims) {
    if (!passedClaims.has(claim)) blockedBy.push(`required_claim_missing:${claim}`);
  }
  if (!proofCapsule.approved) blockedBy.push("proof_capsule_not_approved");
  return uniqueStrings(blockedBy);
}

function maxAuthorityDose(probes: TherapeuticProbeContract[]): TherapeuticAuthorityLevel {
  const level = probes.reduce((max, probe) => Math.max(max, probe.required_authority_dose), 0);
  return clampAuthorityLevel(level);
}

function clampAuthorityLevel(level: number): TherapeuticAuthorityLevel {
  if (level <= 0) return 0;
  if (level >= 8) return 8;
  return level as TherapeuticAuthorityLevel;
}

function highestTraceSeverity(trace: TherapeuticTrace): TherapeuticRiskLevel {
  const order: TherapeuticRiskLevel[] = ["low", "medium", "high", "critical"];
  return trace.uncertainties
    .map((uncertainty) => uncertainty.severity)
    .sort((left, right) => order.indexOf(right) - order.indexOf(left))[0] ?? "medium";
}

function containsOrderedSubsequence(values: string[], expected: string[]): boolean {
  let cursor = 0;
  for (const value of values) {
    if (value === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

function arraySubset(expectedSubset: string[], actualValues: string[]): boolean {
  const actual = new Set(actualValues);
  return expectedSubset.every((value) => actual.has(value));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return Number((values[index] ?? 0).toFixed(3));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function percent<T>(values: T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 0;
  return Number(((values.filter(predicate).length / values.length) * 100).toFixed(3));
}

function hasApprovedHumanClaim(capsule: Pick<TherapeuticStrictProofCapsule, "human_reviewed_claims"> | undefined): boolean {
  return capsule?.human_reviewed_claims.some((claim) => claim.status === "approved") === true;
}

function contractByName(name: string): TherapeuticProbeContract {
  const contract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === name);
  if (!contract) throw new Error(`therapeutic_probe_contract_missing:${name}`);
  return contract;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
