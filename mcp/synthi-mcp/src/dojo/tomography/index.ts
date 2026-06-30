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

export interface TherapeuticOutcomeMetrics {
  authority_efficiency_score: number;
  unnecessary_access_avoided_count: number;
  minimal_escalation_validity_rate: number;
  machine_verifiable_claim_ratio: number;
  narrative_only_escalation_block_rate: number;
  over_escalation_rate: number;
  under_escalation_rate: number;
  data_exposure_score: number;
  probe_information_gain: number;
  proof_valid_escalation_rate: number;
  revocation_success_rate: number;
  post_remediation_success_rate: number;
  human_override_rate: number;
}

export interface TherapeuticProofDecisionRecord {
  decision_id: string;
  task_id: string;
  request_id: string;
  decision: TherapeuticDecision;
  tier: TherapeuticProofTier;
  decision_mechanism: TherapeuticProofRoute["decision_mechanism"];
  verification_latency_ms: number;
  llm_reviewed: boolean;
  human_reviewed: boolean;
  token_count: number;
  cache_hit: boolean;
  probe_bundle_success: boolean;
  blocked_by: string[];
  created_at: string;
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

export interface TherapeuticPostconditionCheckResult {
  check: string;
  status: "passed" | "failed";
  evidence_ref: string;
  observed: string;
}

export interface TherapeuticRemediationVerification {
  verification_id: string;
  task_id: string;
  remediation_id: string;
  status: "passed" | "failed";
  postcondition_results: TherapeuticPostconditionCheckResult[];
  verified_at: string;
  blocked_by: string[];
}

export interface TherapeuticRemediationVerificationResult {
  verification: TherapeuticRemediationVerification;
  trace: TherapeuticTrace;
  evidence_refs: string[];
  audit_refs: string[];
}

export type TherapeuticGrantStatus = "active" | "expired" | "revoked";
export type TherapeuticProbeAdapter = (input: {
  contract: TherapeuticProbeContract;
  trace: TherapeuticTrace;
  probe_input: Record<string, unknown>;
}) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface TherapeuticTemporaryGrant {
  grant_id: string;
  task_id: string;
  access_request: TherapeuticAccessRequest;
  proof_capsule_id?: string;
  status: TherapeuticGrantStatus;
  approved_at: string;
  expires_at: string;
  revoked_at?: string;
  revoked_by?: string;
  revocation_status?: "success" | "failure";
  revocation_reason?: string;
}

export interface TherapeuticEvidenceRecord {
  evidence_id: string;
  task_id: string;
  kind:
    | "access_decision"
    | "probe_result"
    | "proof_capsule"
    | "temporary_grant"
    | "revocation"
    | "remediation"
    | "checkride"
    | "policy_learning"
    | "review_request"
    | "review_decision"
    | "diagnosis"
    | "postcondition_verification";
  created_at: string;
  payload: Record<string, unknown>;
}

export interface TherapeuticAuditRecord {
  audit_id: string;
  task_id: string;
  event_type:
    | "access_denied"
    | "access_approved"
    | "probe_completed"
    | "probe_blocked"
    | "proof_recorded"
    | "grant_revoked"
    | "grant_revoke_failed"
    | "tool_bypass_blocked"
    | "remediation_denied"
    | "remediation_approved"
    | "review_requested"
    | "review_approved"
    | "review_denied"
    | "diagnosis_recorded"
    | "postcondition_verified"
    | "postcondition_failed";
  created_at: string;
  details: Record<string, unknown>;
}

export interface TherapeuticRuntimeStore {
  evidence_records: TherapeuticEvidenceRecord[];
  audit_records: TherapeuticAuditRecord[];
  grants: TherapeuticTemporaryGrant[];
  proof_statuses: Record<string, "issued" | "used" | "revoked">;
  proof_decision_records: TherapeuticProofDecisionRecord[];
  checkride_reports: TherapeuticCheckrideReport[];
  policy_learning_records: TherapeuticPolicyLearningRecord[];
  review_requests: TherapeuticReviewRequest[];
  remediation_verifications: TherapeuticRemediationVerification[];
}

export interface TherapeuticRuntimeAccessResult {
  decision: TherapeuticDecision;
  broker_decision: TherapeuticBrokerDecision;
  grant?: TherapeuticTemporaryGrant;
  review_request?: TherapeuticReviewRequest;
  trace: TherapeuticTrace;
  evidence_refs: string[];
  audit_refs: string[];
}

export interface TherapeuticProbeExecutionResult {
  decision: "completed" | "blocked";
  probe?: TherapeuticProjectionProbe;
  blocked_by: string[];
  trace: TherapeuticTrace;
  evidence_refs: string[];
  audit_refs: string[];
}

export interface TherapeuticDiagnosisRecordResult {
  trace: TherapeuticTrace;
  evidence_refs: string[];
  audit_refs: string[];
}

export interface TherapeuticProtectedToolSpec {
  tool_name: string;
  data_classes: string[];
  mode: TherapeuticAccessMode;
  scope: string;
}

export interface TherapeuticProtectedToolDispatchResult {
  decision: TherapeuticDecision;
  blocked_by: string[];
  grant?: TherapeuticTemporaryGrant;
  evidence_refs: string[];
  audit_refs: string[];
}

export type TherapeuticCheckrideKind =
  | "over_escalation"
  | "under_escalation"
  | "strict_proof_capsule"
  | "adversarial_probe_output"
  | "source_drift"
  | "emergency_escalation";

export interface TherapeuticCheckrideResult {
  checkride_id: string;
  kind: TherapeuticCheckrideKind;
  status: "passed" | "failed" | "blocked";
  finding: string;
  evidence_refs: string[];
  blocked_by: string[];
  policy_delta?: TherapeuticPolicyDeltaRecord;
  case_law_record?: TherapeuticCaseLawRecord;
}

export interface TherapeuticPolicyDeltaRecord {
  schema_version: "synthi.dojo.therapeuticPolicyDelta.v1";
  policy_delta_id: string;
  status: "hypothesis";
  task_class: string;
  delta_kind: "prefer_probe" | "add_guardrail" | "tighten_proof_gate" | "emergency_escalation_review";
  rationale: string;
  evidence_refs: string[];
  created_at: string;
  auto_grants_broader_access: false;
}

export interface TherapeuticCaseLawRecord {
  schema_version: "synthi.dojo.therapeuticCaseLaw.v1";
  case_id: string;
  status: "proposed";
  task_class: string;
  finding: string;
  rule_created: string;
  confidence: number;
  evidence_refs: string[];
  created_at: string;
  expires_at: string;
  revalidation_status: "current" | "expired";
  auto_grants_broader_access: false;
}

export interface TherapeuticCheckrideReport {
  schema_version: "synthi.dojo.therapeuticCheckrideReport.v1";
  report_id: string;
  task_id: string;
  task_class: string;
  generated_at: string;
  results: TherapeuticCheckrideResult[];
  passed_count: number;
  failed_count: number;
  blocked_count: number;
  policy_delta_records: TherapeuticPolicyDeltaRecord[];
  case_law_records: TherapeuticCaseLawRecord[];
  auto_grants_broader_future_access: false;
}

export interface TherapeuticReviewRequest {
  review_id: string;
  task_id: string;
  request: TherapeuticAccessRequest;
  tier: TherapeuticProofTier;
  decision_mechanism: TherapeuticProofRoute["decision_mechanism"];
  required_gates: string[];
  proof_capsule_id?: string;
  deterministic_claim_results: TherapeuticMachineClaim[];
  judgment_claims: TherapeuticHumanReviewedClaim[];
  narrative_claims: TherapeuticNarrativeClaim[];
  status: "pending" | "approved" | "denied";
  reviewer_role?: string;
  rationale?: string;
  created_at: string;
  reviewed_at?: string;
  auto_grants_broader_access: false;
}

export interface TherapeuticPolicyLearningRecord {
  schema_version: "synthi.dojo.therapeuticPolicyLearning.v1";
  learning_id: string;
  task_class: string;
  learning_kind:
    | "prefer_probe_sequence"
    | "avoid_unnecessary_access"
    | "tighten_workspace_boundary"
    | "emergency_escalation_review"
    | "proof_claim_pattern";
  recommendation: string;
  confidence: number;
  supporting_evidence_refs: string[];
  source_trace_ids: string[];
  source_checkride_report_ids: string[];
  created_at: string;
  expires_at: string;
  revalidation_status: "current" | "expired";
  auto_grants_broader_access: false;
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
  {
    name: "redacted_failure_cluster",
    purpose: "Cluster failures using redacted examples and aggregate labels only.",
    task_class: "ml_quality_drop",
    required_authority_dose: 3,
    required_data_classes: ["redacted_failure_cluster"],
    forbidden_data_classes: ["raw_prod_logs", "customer_identifiers", "prompts", "raw_responses"],
    input_schema: { affected_segment: "string", time_window: "string" },
    allowed_output_shape: ["cluster_label", "cluster_size", "affected_segment", "confidence", "time_window"],
    allowed_output_schema: {
      cluster_label: "string",
      cluster_size: "number",
      affected_segment: "string",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["raw_user_logs", "customer_identifiers", "prompts", "raw_responses"],
    privacy_cost: 3,
    expected_information_gain: 7,
    sensitivity_level: "medium",
    failure_modes: ["redaction_unavailable", "cluster_too_small"],
    verifier: "schema_and_shape",
    cache_policy: "per_task",
  },
  {
    name: "embedding_neighborhood_drift",
    purpose: "Compare aggregate embedding neighborhood movement without exposing vectors or raw examples.",
    task_class: "ml_quality_drop",
    required_authority_dose: 4,
    required_data_classes: ["aggregate_embedding_statistics"],
    forbidden_data_classes: ["raw_embeddings", "raw_user_logs", "customer_identifiers"],
    input_schema: { affected_segment: "string", time_window: "string" },
    allowed_output_shape: ["neighborhood_shift_score", "affected_segment", "nearest_cluster_label", "confidence", "time_window"],
    allowed_output_schema: {
      neighborhood_shift_score: "number",
      affected_segment: "string",
      nearest_cluster_label: "string",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["raw_embeddings", "raw_examples", "customer_identifiers"],
    privacy_cost: 2,
    expected_information_gain: 6,
    sensitivity_level: "low",
    failure_modes: ["embedding_stats_missing", "window_not_indexed"],
    verifier: "schema_and_shape",
    cache_policy: "per_task",
  },
  {
    name: "serving_config_diff",
    purpose: "Read a schema-limited serving configuration diff for one service or route.",
    task_class: "ml_quality_drop",
    required_authority_dose: 6,
    required_data_classes: ["scoped_service_config"],
    forbidden_data_classes: ["secrets", "admin_privileges", "full_production_config"],
    input_schema: { service_name: "string", time_window: "string" },
    allowed_output_shape: ["service_name", "changed_keys", "risk_level", "confidence", "time_window"],
    allowed_output_schema: {
      service_name: "string",
      changed_keys: "object",
      risk_level: "string",
      confidence: "number",
      time_window: "string",
    },
    forbidden_outputs: ["secrets", "tokens", "full_config_dump", "customer_identifiers"],
    privacy_cost: 4,
    expected_information_gain: 7,
    sensitivity_level: "medium",
    failure_modes: ["service_not_scoped", "config_history_missing"],
    verifier: "schema_and_shape",
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

export function createTherapeuticRuntimeStore(): TherapeuticRuntimeStore {
  return {
    evidence_records: [],
    audit_records: [],
    grants: [],
    proof_statuses: {},
    proof_decision_records: [],
    checkride_reports: [],
    policy_learning_records: [],
    review_requests: [],
    remediation_verifications: [],
  };
}

export async function executeTherapeuticProbe(input: {
  trace: TherapeuticTrace;
  contract: TherapeuticProbeContract;
  probe_input?: Record<string, unknown>;
  adapter?: TherapeuticProbeAdapter;
  adapters?: Record<string, TherapeuticProbeAdapter>;
  store?: TherapeuticRuntimeStore;
  now?: string;
}): Promise<TherapeuticProbeExecutionResult> {
  const now = input.now ?? new Date().toISOString();
  const blockedBy = probeExecutionBlockedBy(input.trace, input.contract, input.probe_input ?? {});
  const adapter = input.adapter ?? input.adapters?.[input.contract.name] ?? THERAPEUTIC_DEFAULT_PROBE_ADAPTERS[input.contract.name];
  if (!adapter) blockedBy.push("probe_adapter_missing");
  if (blockedBy.length > 0 || !adapter) {
    const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "probe_blocked", now, {
      probe_name: input.contract.name,
      blocked_by: uniqueStrings(blockedBy),
    });
    return {
      decision: "blocked",
      blocked_by: uniqueStrings(blockedBy),
      trace: input.trace,
      evidence_refs: [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }

  const output = await adapter({
    contract: input.contract,
    trace: input.trace,
    probe_input: input.probe_input ?? {},
  });
  const outputValid = probeOutputShapeValid(input.contract, output);
  if (!outputValid) {
    const probe = buildProjectionProbe({
      id: therapeuticId("probe", [input.trace.task_id, input.contract.name, now]),
      task_id: input.trace.task_id,
      contract: input.contract,
      target_uncertainty: targetUncertaintyForProbe(input.trace, input.contract),
      result_summary: output,
      actual_information_gain: 0,
      confidence: 0,
      status: "failed",
    });
    input.trace.projection_probes.push(probe);
    const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "probe_result", now, {
      probe,
      blocked_by: ["probe_output_shape_invalid"],
    });
    const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "probe_blocked", now, {
      probe_name: input.contract.name,
      blocked_by: ["probe_output_shape_invalid"],
      evidence_id: evidence?.evidence_id,
    });
    return {
      decision: "blocked",
      probe,
      blocked_by: ["probe_output_shape_invalid"],
      trace: input.trace,
      evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }

  const probe = buildProjectionProbe({
    id: therapeuticId("probe", [input.trace.task_id, input.contract.name, now]),
    task_id: input.trace.task_id,
    contract: input.contract,
    target_uncertainty: targetUncertaintyForProbe(input.trace, input.contract),
    result_summary: output,
    actual_information_gain: input.contract.expected_information_gain,
    confidence: probeConfidenceFromOutput(output),
  });
  input.trace.projection_probes.push(probe);
  input.trace.current_authority_dose = clampAuthorityLevel(Math.max(input.trace.current_authority_dose, input.contract.required_authority_dose));
  updateUncertaintyAfterProbe(input.trace, probe);
  const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "probe_result", now, { probe });
  const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "probe_completed", now, {
    probe_name: input.contract.name,
    evidence_id: evidence?.evidence_id,
  });
  return {
    decision: "completed",
    probe,
    blocked_by: [],
    trace: input.trace,
    evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
    audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
  };
}

export function enforceTherapeuticAccessRequest(input: {
  trace: TherapeuticTrace;
  request: TherapeuticAccessRequest;
  proof_capsule?: TherapeuticStrictProofCapsule;
  store?: TherapeuticRuntimeStore;
  policy?: TherapeuticPolicy;
  now?: string;
}): TherapeuticRuntimeAccessResult {
  const startedAt = Date.now();
  const now = input.now ?? new Date().toISOString();
  const lifecycleBlockedBy = proofLifecycleBlockedBy(input.proof_capsule, input.store);
  const brokerDecision = lifecycleBlockedBy.length > 0
    ? {
        decision: "denied" as const,
        tier: classifyTherapeuticProofRoute({ request: input.request, policy: input.policy }).tier,
        blocked_by: lifecycleBlockedBy,
        suggested_alternatives: lowerRiskAlternatives(input.trace, input.policy ?? THERAPEUTIC_DEFAULT_POLICY),
        ...(input.proof_capsule ? { proof_capsule: input.proof_capsule } : {}),
      }
    : evaluateAuthorityBroker({
        trace: input.trace,
        request: input.request,
        policy: input.policy,
        proof_capsule: input.proof_capsule,
      });
  appendTherapeuticProofDecisionRecord(input.store, input.trace, input.request, brokerDecision, now, Date.now() - startedAt);
  if (input.proof_capsule) {
    input.store && (input.store.proof_statuses[input.proof_capsule.id] ??= "issued");
    if (!input.trace.proof_capsules.some((capsule) => capsule.id === input.proof_capsule?.id)) {
      input.trace.proof_capsules.push(input.proof_capsule);
    }
  }
  const evidenceRefs: string[] = [];
  const auditRefs: string[] = [];
  const decisionEvidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "access_decision", now, {
    request: input.request,
    broker_decision: brokerDecision,
  });
  if (decisionEvidence) evidenceRefs.push(`evidence:${decisionEvidence.evidence_id}`);
  const eventType = brokerDecision.decision === "approved" ? "access_approved" : "access_denied";
  const audit = appendTherapeuticAudit(input.store, input.trace.task_id, eventType, now, {
    request: input.request,
    broker_decision: brokerDecision,
    evidence_id: decisionEvidence?.evidence_id,
  });
  if (audit) auditRefs.push(`audit:${audit.audit_id}`);

  if (brokerDecision.decision !== "approved") {
    const reviewRequest = brokerDecision.decision === "needs_human_approval"
      ? appendTherapeuticReviewRequest({
          trace: input.trace,
          store: input.store,
          request: input.request,
          broker_decision: brokerDecision,
          proof_capsule: input.proof_capsule,
          now,
        })
      : undefined;
    if (reviewRequest) {
      const reviewEvidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "review_request", now, { review_request: reviewRequest });
      if (reviewEvidence) evidenceRefs.push(`evidence:${reviewEvidence.evidence_id}`);
      const reviewAudit = appendTherapeuticAudit(input.store, input.trace.task_id, "review_requested", now, {
        review_id: reviewRequest.review_id,
        request_id: input.request.id,
        tier: brokerDecision.tier,
      });
      if (reviewAudit) auditRefs.push(`audit:${reviewAudit.audit_id}`);
    }
    recordDeniedAccessOnTrace(input.trace, input.request, brokerDecision);
    return {
      decision: brokerDecision.decision,
      broker_decision: brokerDecision,
      ...(reviewRequest ? { review_request: reviewRequest } : {}),
      trace: input.trace,
      evidence_refs: evidenceRefs,
      audit_refs: auditRefs,
    };
  }

  if (input.proof_capsule) input.store && (input.store.proof_statuses[input.proof_capsule.id] = "used");
  const grant: TherapeuticTemporaryGrant = {
    grant_id: therapeuticId("grant", [input.trace.task_id, input.request.id, now]),
    task_id: input.trace.task_id,
    access_request: cloneJson(input.request),
    ...(input.proof_capsule ? { proof_capsule_id: input.proof_capsule.id } : {}),
    status: "active",
    approved_at: now,
    expires_at: grantExpiresAt(input.request, now),
  };
  input.store?.grants.push(grant);
  input.trace.authority_doses.push(authorityDoseForGrant(grant, brokerDecision));
  input.trace.current_authority_dose = clampAuthorityLevel(Math.max(input.trace.current_authority_dose, input.request.authority_dose));
  const grantEvidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "temporary_grant", now, { grant });
  if (grantEvidence) evidenceRefs.push(`evidence:${grantEvidence.evidence_id}`);
  return {
    decision: "approved",
    broker_decision: brokerDecision,
    grant,
    trace: input.trace,
    evidence_refs: evidenceRefs,
    audit_refs: auditRefs,
  };
}

export function reviewTherapeuticAccessRequest(input: {
  trace: TherapeuticTrace;
  store: TherapeuticRuntimeStore;
  review_id: string;
  status: "approved" | "denied";
  reviewer_role: string;
  rationale: string;
  now?: string;
  policy?: TherapeuticPolicy;
}): TherapeuticRuntimeAccessResult {
  const now = input.now ?? new Date().toISOString();
  const review = input.store.review_requests.find((candidate) =>
    candidate.review_id === input.review_id && candidate.task_id === input.trace.task_id
  );
  if (!review || review.status !== "pending") {
    const brokerDecision: TherapeuticBrokerDecision = {
      decision: "denied",
      tier: review?.tier ?? 2,
      blocked_by: [review ? "review_already_resolved" : "review_request_missing"],
      suggested_alternatives: [],
    };
    const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "review_denied", now, {
      review_id: input.review_id,
      blocked_by: brokerDecision.blocked_by,
    });
    return {
      decision: "denied",
      broker_decision: brokerDecision,
      trace: input.trace,
      evidence_refs: [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }
  review.status = input.status;
  review.reviewer_role = input.reviewer_role;
  review.rationale = input.rationale;
  review.reviewed_at = now;
  const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "review_decision", now, { review_request: review });
  const audit = appendTherapeuticAudit(input.store, input.trace.task_id, input.status === "approved" ? "review_approved" : "review_denied", now, {
    review_id: review.review_id,
    request_id: review.request.id,
    reviewer_role: input.reviewer_role,
  });
  if (input.status === "denied") {
    const brokerDecision: TherapeuticBrokerDecision = {
      decision: "denied",
      tier: review.tier,
      blocked_by: ["human_review_denied"],
      suggested_alternatives: lowerRiskAlternatives(input.trace, input.policy ?? THERAPEUTIC_DEFAULT_POLICY),
    };
    return {
      decision: "denied",
      broker_decision: brokerDecision,
      review_request: review,
      trace: input.trace,
      evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }
  const proofCapsule = review.proof_capsule_id
    ? input.trace.proof_capsules.find((capsule) => capsule.id === review.proof_capsule_id)
    : undefined;
  if (proofCapsule && !hasApprovedHumanClaim(proofCapsule)) {
    proofCapsule.human_reviewed_claims.push({
      claim: review.tier === 3 ? "high_risk_access_human_approved" : "judgment_claim_human_approved",
      reviewer_role: input.reviewer_role,
      status: "approved",
      rationale: input.rationale,
    });
  }
  const result = enforceTherapeuticAccessRequest({
    trace: input.trace,
    store: input.store,
    request: review.request,
    ...(proofCapsule ? { proof_capsule: proofCapsule } : {}),
    policy: input.policy,
    now,
  });
  return {
    ...result,
    review_request: review,
    evidence_refs: [
      ...(evidence ? [`evidence:${evidence.evidence_id}`] : []),
      ...result.evidence_refs,
    ],
    audit_refs: [
      ...(audit ? [`audit:${audit.audit_id}`] : []),
      ...result.audit_refs,
    ],
  };
}

export function dispatchProtectedTherapeuticTool(input: {
  trace: TherapeuticTrace;
  tool: TherapeuticProtectedToolSpec;
  store: TherapeuticRuntimeStore;
  now?: string;
}): TherapeuticProtectedToolDispatchResult {
  const now = input.now ?? new Date().toISOString();
  expireTherapeuticGrants({ trace: input.trace, store: input.store, now });
  const matchingGrant = input.store.grants.find((grant) =>
    grant.task_id === input.trace.task_id
    && grant.status === "active"
    && grant.access_request.tools.includes(input.tool.tool_name)
    && grant.access_request.mode === input.tool.mode
    && grant.access_request.scope === input.tool.scope
    && input.tool.data_classes.every((dataClass) => grant.access_request.data_classes.includes(dataClass))
  );
  if (!matchingGrant) {
    const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "access_decision", now, {
      tool: input.tool,
      decision: "denied",
      blocked_by: ["broker_required", "active_scoped_grant_missing"],
    });
    const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "tool_bypass_blocked", now, {
      tool: input.tool,
      evidence_id: evidence?.evidence_id,
      blocked_by: ["broker_required", "active_scoped_grant_missing"],
    });
    return {
      decision: "denied",
      blocked_by: ["broker_required", "active_scoped_grant_missing"],
      evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }
  return {
    decision: "approved",
    blocked_by: [],
    grant: matchingGrant,
    evidence_refs: [],
    audit_refs: [],
  };
}

export function revokeTherapeuticGrant(input: {
  trace: TherapeuticTrace;
  store: TherapeuticRuntimeStore;
  grant_id: string;
  reason: string;
  revoked_by?: string;
  now?: string;
}): TherapeuticTemporaryGrant | null {
  const now = input.now ?? new Date().toISOString();
  const grant = input.store.grants.find((candidate) => candidate.grant_id === input.grant_id && candidate.task_id === input.trace.task_id);
  if (!grant || grant.status === "revoked") {
    appendTherapeuticAudit(input.store, input.trace.task_id, "grant_revoke_failed", now, {
      grant_id: input.grant_id,
      reason: input.reason,
      blocked_by: [grant ? "grant_already_revoked" : "grant_missing"],
    });
    return null;
  }
  grant.status = "revoked";
  grant.revoked_at = now;
  grant.revoked_by = input.revoked_by ?? "therapeutic-runtime";
  grant.revocation_status = "success";
  grant.revocation_reason = input.reason;
  appendTherapeuticEvidence(input.store, input.trace.task_id, "revocation", now, { grant });
  appendTherapeuticAudit(input.store, input.trace.task_id, "grant_revoked", now, {
    grant_id: grant.grant_id,
    reason: input.reason,
  });
  return grant;
}

export function expireTherapeuticGrants(input: {
  trace: TherapeuticTrace;
  store: TherapeuticRuntimeStore;
  now?: string;
}): TherapeuticTemporaryGrant[] {
  const now = input.now ?? new Date().toISOString();
  const expired: TherapeuticTemporaryGrant[] = [];
  for (const grant of input.store.grants) {
    if (grant.task_id !== input.trace.task_id || grant.status !== "active") continue;
    if (grant.expires_at > now) continue;
    grant.status = "expired";
    grant.revoked_at = now;
    grant.revoked_by = "therapeutic-runtime";
    grant.revocation_status = "success";
    grant.revocation_reason = "expired";
    expired.push(grant);
    appendTherapeuticEvidence(input.store, input.trace.task_id, "revocation", now, { grant });
    appendTherapeuticAudit(input.store, input.trace.task_id, "grant_revoked", now, {
      grant_id: grant.grant_id,
      reason: "expired",
    });
  }
  return expired;
}

export function revokeTherapeuticTaskGrants(input: {
  trace: TherapeuticTrace;
  store: TherapeuticRuntimeStore;
  reason?: string;
  now?: string;
}): TherapeuticTemporaryGrant[] {
  const revoked: TherapeuticTemporaryGrant[] = [];
  for (const grant of input.store.grants.filter((candidate) => candidate.task_id === input.trace.task_id && candidate.status === "active")) {
    const result = revokeTherapeuticGrant({
      trace: input.trace,
      store: input.store,
      grant_id: grant.grant_id,
      reason: input.reason ?? "task_end",
      now: input.now,
    });
    if (result) revoked.push(result);
  }
  return revoked;
}

export function recordTherapeuticDiagnosis(input: {
  trace: TherapeuticTrace;
  diagnosis: string;
  evidence_refs?: string[];
  remediation_plan?: string;
  store?: TherapeuticRuntimeStore;
  now?: string;
}): TherapeuticDiagnosisRecordResult {
  const now = input.now ?? new Date().toISOString();
  input.trace.final_outcome = "diagnosed";
  input.trace.diagnosis = input.diagnosis;
  if (input.remediation_plan) input.trace.remediation_plan = input.remediation_plan;
  const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "diagnosis", now, {
    diagnosis: input.diagnosis,
    remediation_plan: input.remediation_plan ?? input.trace.remediation_plan,
    evidence_refs: input.evidence_refs ?? therapeuticTraceEvidenceRefs(input.trace, input.store),
  });
  const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "diagnosis_recorded", now, {
    diagnosis: input.diagnosis,
    evidence_id: evidence?.evidence_id,
  });
  return {
    trace: input.trace,
    evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
    audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
  };
}

export function executeTherapeuticRemediation(input: {
  trace: TherapeuticTrace;
  proposal: TherapeuticRemediationProposal;
  store?: TherapeuticRuntimeStore;
  policy?: TherapeuticPolicy;
  now?: string;
}): TherapeuticRuntimeAccessResult {
  const now = input.now ?? new Date().toISOString();
  const gate = evaluateRemediationGate({
    trace: input.trace,
    proposal: input.proposal,
    policy: input.policy,
  });
  if (gate.decision !== "approved") {
    const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "remediation", now, {
      proposal: input.proposal,
      gate,
    });
    const audit = appendTherapeuticAudit(input.store, input.trace.task_id, "remediation_denied", now, {
      proposal_id: input.proposal.id,
      blocked_by: gate.blocked_by,
      evidence_id: evidence?.evidence_id,
    });
    return {
      decision: "denied",
      broker_decision: {
        decision: "denied",
        tier: 3,
        blocked_by: gate.blocked_by,
        suggested_alternatives: [],
      },
      trace: input.trace,
      evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
      audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
    };
  }
  const proofCapsule = buildStrictProofCapsule({
    id: therapeuticId("proof_remediation", [input.trace.task_id, input.proposal.id, now]),
    task_id: input.trace.task_id,
    trace: input.trace,
    request: input.proposal.requested_access,
    current_authority_dose: input.trace.current_authority_dose,
    policy: input.policy,
    machine_verifiable_claims: [
      claim("diagnosis_verified", true, "remediation_proposal.diagnosis_verified", "trace_lookup", input.proposal.diagnosis_verified === true, input.proposal.diagnosis_verified, true),
      claim("rollback_plan_defined", true, "remediation_proposal.rollback_plan", "trace_lookup", input.proposal.rollback_plan.trim().length > 0, input.proposal.rollback_plan, true),
      claim("postcondition_checks_defined", true, "remediation_proposal.postcondition_checks", "trace_lookup", input.proposal.postcondition_checks.length > 0, input.proposal.postcondition_checks, true),
      claim("write_scope_matches_diagnosis_scope", input.proposal.requested_access.scope, "remediation_proposal.requested_access.scope", "scope_subset_check", inferSupportedScopeValues(input.trace).includes(input.proposal.requested_access.scope), input.proposal.requested_access.scope, true),
      claim("forbidden_data_not_requested", (input.policy ?? THERAPEUTIC_DEFAULT_POLICY).forbidden_data_classes, "access_request.data_classes", "forbidden_class_check", input.proposal.requested_access.data_classes.every((item) => !(input.policy ?? THERAPEUTIC_DEFAULT_POLICY).forbidden_data_classes.includes(item)), input.proposal.requested_access.data_classes, true),
      claim("expiration_defined", true, "access_request.expiration", "expiration_check", Boolean(input.proposal.requested_access.expiration.trim()), input.proposal.requested_access.expiration, true),
      claim("revocation_defined", true, "access_request.revocable", "revocation_check", input.proposal.requested_access.revocable === true, input.proposal.requested_access.revocable, true),
    ],
    human_reviewed_claims: input.proposal.human_approval ? [input.proposal.human_approval] : [],
    timestamp: now,
    reviewer: input.proposal.human_approval?.reviewer_role ?? "human_reviewer",
  });
  proofCapsule.approved = proofCapsule.failed_claims.length === 0
    && proofCapsule.human_reviewed_claims.some((claim) => claim.status === "approved");
  const result = enforceTherapeuticAccessRequest({
    trace: input.trace,
    request: input.proposal.requested_access,
    proof_capsule: proofCapsule,
    store: input.store,
    policy: input.policy,
    now,
  });
  appendTherapeuticEvidence(input.store, input.trace.task_id, "remediation", now, {
    proposal: input.proposal,
    gate,
    grant_id: result.grant?.grant_id,
  });
  appendTherapeuticAudit(input.store, input.trace.task_id, result.decision === "approved" ? "remediation_approved" : "remediation_denied", now, {
    proposal_id: input.proposal.id,
    grant_id: result.grant?.grant_id,
    blocked_by: result.broker_decision.blocked_by,
  });
  if (result.decision === "approved") {
    input.trace.final_outcome = "remediated";
    input.trace.remediation_plan = input.proposal.proposed_change;
  }
  return result;
}

export function verifyTherapeuticRemediationPostconditions(input: {
  trace: TherapeuticTrace;
  store?: TherapeuticRuntimeStore;
  remediation_id: string;
  postcondition_results: TherapeuticPostconditionCheckResult[];
  now?: string;
}): TherapeuticRemediationVerificationResult {
  const now = input.now ?? new Date().toISOString();
  const blockedBy = input.postcondition_results.length === 0
    ? ["postcondition_results_missing"]
    : input.postcondition_results
        .filter((result) => result.status !== "passed")
        .map((result) => `postcondition_failed:${result.check}`);
  const verification: TherapeuticRemediationVerification = {
    verification_id: therapeuticId("remediation_verification", [input.trace.task_id, input.remediation_id, now]),
    task_id: input.trace.task_id,
    remediation_id: input.remediation_id,
    status: blockedBy.length === 0 ? "passed" : "failed",
    postcondition_results: input.postcondition_results.map((result) => cloneJson(result)),
    verified_at: now,
    blocked_by: uniqueStrings(blockedBy),
  };
  input.store?.remediation_verifications.push(verification);
  const evidence = appendTherapeuticEvidence(input.store, input.trace.task_id, "postcondition_verification", now, {
    verification,
  });
  const audit = appendTherapeuticAudit(
    input.store,
    input.trace.task_id,
    verification.status === "passed" ? "postcondition_verified" : "postcondition_failed",
    now,
    {
      verification_id: verification.verification_id,
      remediation_id: input.remediation_id,
      blocked_by: verification.blocked_by,
      evidence_id: evidence?.evidence_id,
    }
  );
  if (verification.status === "failed") {
    input.trace.final_outcome = "blocked";
    input.trace.under_escalation_flags = uniqueStrings([
      ...input.trace.under_escalation_flags,
      "remediation_postcondition_failed",
    ]);
  }
  return {
    verification,
    trace: input.trace,
    evidence_refs: evidence ? [`evidence:${evidence.evidence_id}`] : [],
    audit_refs: audit ? [`audit:${audit.audit_id}`] : [],
  };
}

export function runTherapeuticTomographyCheckrides(input: {
  trace: TherapeuticTrace;
  store?: TherapeuticRuntimeStore;
  policy?: TherapeuticPolicy;
  available_requests?: TherapeuticAccessRequest[];
  existing_case_law_records?: TherapeuticCaseLawRecord[];
  now?: string;
}): TherapeuticCheckrideReport {
  const now = input.now ?? new Date().toISOString();
  const policy = input.policy ?? THERAPEUTIC_DEFAULT_POLICY;
  const existingCaseLawRecords = input.existing_case_law_records
    ?? input.store?.checkride_reports.flatMap((report) => report.case_law_records)
    ?? [];
  const evidenceRefs = therapeuticTraceEvidenceRefs(input.trace, input.store);
  const results: TherapeuticCheckrideResult[] = [
    overEscalationCheckride(input.trace, policy, evidenceRefs, now),
    underEscalationCheckride(input.trace, input.available_requests ?? [], policy, evidenceRefs, now),
    strictProofCapsuleCheckride(input.trace, evidenceRefs, now),
    adversarialProbeOutputCheckride(input.trace, evidenceRefs, now),
    sourceDriftCheckride(input.trace, evidenceRefs, now, existingCaseLawRecords),
    emergencyEscalationCheckride(input.trace, evidenceRefs, now),
  ];
  const policyDeltaRecords = results.flatMap((result) => result.policy_delta ? [result.policy_delta] : []);
  const caseLawRecords = results.flatMap((result) => result.case_law_record ? [result.case_law_record] : []);
  const report: TherapeuticCheckrideReport = {
    schema_version: "synthi.dojo.therapeuticCheckrideReport.v1",
    report_id: therapeuticId("therapeutic_checkride", [input.trace.task_id, now, results.map((result) => `${result.kind}:${result.status}`).join("|")]),
    task_id: input.trace.task_id,
    task_class: input.trace.task_class,
    generated_at: now,
    results,
    passed_count: results.filter((result) => result.status === "passed").length,
    failed_count: results.filter((result) => result.status === "failed").length,
    blocked_count: results.filter((result) => result.status === "blocked").length,
    policy_delta_records: policyDeltaRecords,
    case_law_records: caseLawRecords,
    auto_grants_broader_future_access: false,
  };
  if (input.store) input.store.checkride_reports.push(report);
  appendTherapeuticEvidence(input.store, input.trace.task_id, "checkride", now, { report });
  return report;
}

export function learnTherapeuticPolicyPatterns(input: {
  traces: TherapeuticTrace[];
  store?: TherapeuticRuntimeStore;
  checkride_reports?: TherapeuticCheckrideReport[];
  now?: string;
}): TherapeuticPolicyLearningRecord[] {
  const now = input.now ?? new Date().toISOString();
  const traces = input.traces.filter((trace) => trace.task_id.trim().length > 0);
  const reports = input.checkride_reports ?? input.store?.checkride_reports ?? [];
  const records: TherapeuticPolicyLearningRecord[] = [];
  const tracesByTaskClass = new Map<string, TherapeuticTrace[]>();
  for (const trace of traces) {
    const list = tracesByTaskClass.get(trace.task_class) ?? [];
    list.push(trace);
    tracesByTaskClass.set(trace.task_class, list);
  }
  for (const [taskClass, classTraces] of tracesByTaskClass.entries()) {
    const successfulMinimalTraces = classTraces.filter((trace) =>
      (trace.final_outcome === "diagnosed" || trace.final_outcome === "remediated")
      && trace.projection_probes.some((probe) => probe.status === "completed" && probe.allowed_output_shape_valid)
      && trace.blocked_overreach_attempts.some((attempt) => attempt.suggested_alternative.length > 0)
    );
    if (successfulMinimalTraces.length > 0) {
      const probeSequence = mostCommonProbeSequence(successfulMinimalTraces);
      if (probeSequence.length > 0) {
        records.push(therapeuticLearningRecord({
          taskClass,
          kind: "prefer_probe_sequence",
          recommendation: `Prefer ${probeSequence.join(" -> ")} before requesting scoped authority for ${taskClass}.`,
          confidence: learningConfidence(successfulMinimalTraces.length, classTraces.length),
          traces: successfulMinimalTraces,
          reports,
          evidenceRefs: learningEvidenceRefs(successfulMinimalTraces, input.store),
          now,
        }));
      }
    }
    const avoidedAccess = uniqueStrings(classTraces.flatMap((trace) => trace.avoided_access));
    if (avoidedAccess.length > 0) {
      records.push(therapeuticLearningRecord({
        taskClass,
        kind: "avoid_unnecessary_access",
        recommendation: `Treat ${avoidedAccess.join(", ")} as usually unnecessary during ${taskClass} diagnosis while lower-risk probes remain available.`,
        confidence: learningConfidence(classTraces.filter((trace) => trace.avoided_access.length > 0).length, classTraces.length),
        traces: classTraces,
        reports,
        evidenceRefs: learningEvidenceRefs(classTraces, input.store),
        now,
      }));
    }
    const failedOrBlockedCheckrides = reports.filter((report) =>
      report.task_class === taskClass && report.results.some((result) => result.status === "failed" || result.status === "blocked")
    );
    if (failedOrBlockedCheckrides.some((report) => report.results.some((result) => result.kind === "emergency_escalation"))) {
      records.push(therapeuticLearningRecord({
        taskClass,
        kind: "emergency_escalation_review",
        recommendation: `Review emergency escalation thresholds for ${taskClass}; learning record is advisory and cannot grant broader authority.`,
        confidence: learningConfidence(failedOrBlockedCheckrides.length, Math.max(reports.filter((report) => report.task_class === taskClass).length, 1)),
        traces: classTraces,
        reports: failedOrBlockedCheckrides,
        evidenceRefs: learningEvidenceRefs(classTraces, input.store),
        now,
      }));
    }
    const proofClaimNames = uniqueStrings(classTraces.flatMap((trace) =>
      trace.proof_capsules.flatMap((capsule) =>
        capsule.machine_verifiable_claims.filter((claim) => claim.critical && claim.result === "pass").map((claim) => claim.claim)
      )
    ));
    if (proofClaimNames.length > 0) {
      records.push(therapeuticLearningRecord({
        taskClass,
        kind: "proof_claim_pattern",
        recommendation: `Reuse critical machine-verifiable claim pattern for ${taskClass}: ${proofClaimNames.slice(0, 8).join(", ")}.`,
        confidence: learningConfidence(classTraces.filter((trace) => trace.proof_capsules.some((capsule) => capsule.approved)).length, classTraces.length),
        traces: classTraces,
        reports,
        evidenceRefs: learningEvidenceRefs(classTraces, input.store),
        now,
      }));
    }
  }
  if (input.store) {
    input.store.policy_learning_records.push(...records);
    for (const record of records) {
      appendTherapeuticEvidence(input.store, record.source_trace_ids[0] ?? "therapeutic_policy_learning", "policy_learning", now, { record });
    }
  }
  return records;
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

export function summarizeTherapeuticOutcomeMetrics(input: {
  trace: TherapeuticTrace;
  store?: TherapeuticRuntimeStore;
}): TherapeuticOutcomeMetrics {
  const trace = input.trace;
  const store = input.store;
  const totalAuthorityCost = trace.authority_doses.reduce((sum, dose) => sum + dose.level + (dose.mutation_allowed ? 4 : 0), 0)
    + trace.projection_probes.reduce((sum, probe) => sum + probe.privacy_cost, 0);
  const taskSuccess = trace.final_outcome === "diagnosed" || trace.final_outcome === "remediated" ? 1 : 0;
  const proofCapsules = trace.proof_capsules;
  const totalClaims = proofCapsules.reduce((sum, capsule) =>
    sum + capsule.machine_verifiable_claims.length + capsule.human_reviewed_claims.length + capsule.unverifiable_narrative_claims.length, 0);
  const machineClaims = proofCapsules.reduce((sum, capsule) => sum + capsule.machine_verifiable_claims.length, 0);
  const narrativeOnlyDenied = proofCapsules.filter((capsule) => capsule.failed_claims.includes("narrative_only_proof")).length;
  const grants = store?.grants ?? [];
  const completedRevocations = grants.filter((grant) =>
    (grant.status === "revoked" || grant.status === "expired") && grant.revocation_status === "success"
  ).length;
  const remediationVerifications = store?.remediation_verifications ?? [];
  const approvedEscalations = trace.authority_doses.filter((dose) => dose.decision === "approved");
  const humanReviewedDecisions = store?.proof_decision_records.filter((record) => record.human_reviewed).length ?? 0;
  return {
    authority_efficiency_score: totalAuthorityCost > 0 ? roundMetric(taskSuccess / totalAuthorityCost) : taskSuccess,
    unnecessary_access_avoided_count: trace.avoided_access.length,
    minimal_escalation_validity_rate: percent(approvedEscalations, (dose) => dose.scope !== "production" && !dose.mutation_allowed),
    machine_verifiable_claim_ratio: totalClaims > 0 ? roundMetric(machineClaims / totalClaims) : 0,
    narrative_only_escalation_block_rate: percent(proofCapsules, (capsule) => capsule.failed_claims.includes("narrative_only_proof")),
    over_escalation_rate: percent(trace.blocked_overreach_attempts, (attempt) => attempt.suggested_alternative.length === 0),
    under_escalation_rate: trace.under_escalation_flags.length > 0 ? 100 : 0,
    data_exposure_score: roundMetric(trace.authority_doses.reduce((sum, dose) => sum + dose.permitted_data_classes.length * dose.level, 0)),
    probe_information_gain: roundMetric(average(trace.projection_probes.map((probe) => probe.actual_information_gain))),
    proof_valid_escalation_rate: percent(proofCapsules, (capsule) => capsule.approved),
    revocation_success_rate: grants.length > 0 ? percent(grants, (grant) => (grant.status === "revoked" || grant.status === "expired") && grant.revocation_status === "success") : 100,
    post_remediation_success_rate: remediationVerifications.length > 0 ? percent(remediationVerifications, (verification) => verification.status === "passed") : 0,
    human_override_rate: store?.proof_decision_records.length ? roundMetric((humanReviewedDecisions / store.proof_decision_records.length) * 100) : 0,
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

export const THERAPEUTIC_DEFAULT_PROBE_ADAPTERS: Record<string, TherapeuticProbeAdapter> = {
  eval_slice_compare: ({ probe_input }) => ({
    affected_segment: stringFromInput(probe_input, "affected_segment", "enterprise_users"),
    quality_delta: numberFromInput(probe_input, "quality_delta", -0.09),
    confidence: numberFromInput(probe_input, "confidence", 0.84),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
  feature_drift_summary: ({ probe_input, trace }) => ({
    top_feature: stringFromInput(probe_input, "top_feature", "customer_plan"),
    drift_score: numberFromInput(probe_input, "drift_score", 0.91),
    affected_segment: stringFromInput(probe_input, "affected_segment", firstTraceString(trace, "affected_segment", "enterprise_users")),
    confidence: numberFromInput(probe_input, "confidence", 0.88),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
  model_route_compare: ({ probe_input }) => ({
    route_changed: boolFromInput(probe_input, "route_changed", false),
    route_delta: numberFromInput(probe_input, "route_delta", 0.02),
    confidence: numberFromInput(probe_input, "confidence", 0.74),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
  feature_lineage_hash: ({ probe_input, trace }) => ({
    feature_name: stringFromInput(probe_input, "feature_name", firstTraceString(trace, "top_feature", "customer_plan")),
    training_transform_hash: stringFromInput(probe_input, "training_transform_hash", "sha256:training-customer-plan-v3"),
    serving_transform_hash: stringFromInput(probe_input, "serving_transform_hash", "sha256:serving-customer-plan-v2"),
    skew_detected: boolFromInput(probe_input, "skew_detected", true),
    confidence: numberFromInput(probe_input, "confidence", 0.9),
  }),
  redacted_failure_cluster: ({ probe_input, trace }) => ({
    cluster_label: stringFromInput(probe_input, "cluster_label", "plan-name-mismatch"),
    cluster_size: numberFromInput(probe_input, "cluster_size", 43),
    affected_segment: stringFromInput(probe_input, "affected_segment", firstTraceString(trace, "affected_segment", "enterprise_users")),
    confidence: numberFromInput(probe_input, "confidence", 0.81),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
  embedding_neighborhood_drift: ({ probe_input, trace }) => ({
    neighborhood_shift_score: numberFromInput(probe_input, "neighborhood_shift_score", 0.62),
    affected_segment: stringFromInput(probe_input, "affected_segment", firstTraceString(trace, "affected_segment", "enterprise_users")),
    nearest_cluster_label: stringFromInput(probe_input, "nearest_cluster_label", "plan-name-mismatch"),
    confidence: numberFromInput(probe_input, "confidence", 0.76),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
  serving_config_diff: ({ probe_input }) => ({
    service_name: stringFromInput(probe_input, "service_name", "ranking-api"),
    changed_keys: objectFromInput(probe_input, "changed_keys", { customer_plan_transform: "version_changed" }),
    risk_level: stringFromInput(probe_input, "risk_level", "medium"),
    confidence: numberFromInput(probe_input, "confidence", 0.79),
    time_window: stringFromInput(probe_input, "time_window", "last_24h"),
  }),
};

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

function roundMetric(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(3));
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

function probeExecutionBlockedBy(
  trace: TherapeuticTrace,
  contract: TherapeuticProbeContract,
  probeInput: Record<string, unknown>
): string[] {
  const blockedBy: string[] = [];
  if (trace.task_class !== contract.task_class) blockedBy.push("probe_task_class_mismatch");
  if (!THERAPEUTIC_DEFAULT_POLICY.allowed_projection_probes.includes(contract.name)) blockedBy.push("probe_not_allowed_by_policy");
  if (contract.required_data_classes.some((dataClass) => THERAPEUTIC_DEFAULT_POLICY.forbidden_data_classes.includes(dataClass))) {
    blockedBy.push("probe_requires_forbidden_data");
  }
  for (const [key, expectedType] of Object.entries(contract.input_schema)) {
    const value = probeInput[key];
    if (value === undefined) continue;
    if (expectedType === "string" && typeof value !== "string") blockedBy.push(`probe_input_type_mismatch:${key}`);
    if (expectedType === "number" && (typeof value !== "number" || !Number.isFinite(value))) blockedBy.push(`probe_input_type_mismatch:${key}`);
    if (expectedType === "boolean" && typeof value !== "boolean") blockedBy.push(`probe_input_type_mismatch:${key}`);
  }
  return uniqueStrings(blockedBy);
}

function targetUncertaintyForProbe(trace: TherapeuticTrace, contract: TherapeuticProbeContract): string {
  return trace.uncertainties.find((uncertainty) => uncertainty.useful_probes.includes(contract.name))?.id
    ?? trace.uncertainties[0]?.id
    ?? "task_uncertainty";
}

function probeConfidenceFromOutput(output: Record<string, unknown>): number {
  return typeof output["confidence"] === "number" && Number.isFinite(output["confidence"])
    ? Math.max(0, Math.min(1, output["confidence"]))
    : 0.5;
}

function updateUncertaintyAfterProbe(trace: TherapeuticTrace, probe: TherapeuticProjectionProbe): void {
  const uncertainty = trace.uncertainties.find((item) => item.id === probe.target_uncertainty);
  if (!uncertainty || probe.status !== "completed") return;
  uncertainty.current_confidence = Math.max(
    uncertainty.current_confidence,
    Math.min(0.95, Number((probe.confidence * 0.9).toFixed(3)))
  );
  uncertainty.blocking_status = uncertainty.current_confidence >= 0.8 ? "reduced" : uncertainty.blocking_status;
}

function appendTherapeuticEvidence(
  store: TherapeuticRuntimeStore | undefined,
  taskId: string,
  kind: TherapeuticEvidenceRecord["kind"],
  now: string,
  payload: Record<string, unknown>
): TherapeuticEvidenceRecord | undefined {
  if (!store) return undefined;
  const record: TherapeuticEvidenceRecord = {
    evidence_id: therapeuticId("evidence", [taskId, kind, now, String(store.evidence_records.length)]),
    task_id: taskId,
    kind,
    created_at: now,
    payload: cloneJson(payload),
  };
  store.evidence_records.push(record);
  return record;
}

function appendTherapeuticAudit(
  store: TherapeuticRuntimeStore | undefined,
  taskId: string,
  eventType: TherapeuticAuditRecord["event_type"],
  now: string,
  details: Record<string, unknown>
): TherapeuticAuditRecord | undefined {
  if (!store) return undefined;
  const record: TherapeuticAuditRecord = {
    audit_id: therapeuticId("audit", [taskId, eventType, now, String(store.audit_records.length)]),
    task_id: taskId,
    event_type: eventType,
    created_at: now,
    details: cloneJson(details),
  };
  store.audit_records.push(record);
  return record;
}

function appendTherapeuticProofDecisionRecord(
  store: TherapeuticRuntimeStore | undefined,
  trace: TherapeuticTrace,
  request: TherapeuticAccessRequest,
  decision: TherapeuticBrokerDecision,
  now: string,
  verificationLatencyMs: number
): TherapeuticProofDecisionRecord | undefined {
  if (!store) return undefined;
  const route = classifyTherapeuticProofRoute({ request });
  const record: TherapeuticProofDecisionRecord = {
    decision_id: therapeuticId("proof_decision", [trace.task_id, request.id, now, String(store.proof_decision_records.length)]),
    task_id: trace.task_id,
    request_id: request.id,
    decision: decision.decision,
    tier: decision.tier,
    decision_mechanism: route.decision_mechanism,
    verification_latency_ms: Math.max(0, verificationLatencyMs),
    llm_reviewed: false,
    human_reviewed: decision.tier === 3 || hasApprovedHumanClaim(decision.proof_capsule),
    token_count: 0,
    cache_hit: decision.proof_capsule
      ? evaluateProofCache({
          trace,
          request,
          proof_capsule: decision.proof_capsule,
        }).cache_hit
      : false,
    probe_bundle_success: trace.projection_probes.some((probe) => probe.status === "completed" && probe.allowed_output_shape_valid),
    blocked_by: [...decision.blocked_by],
    created_at: now,
  };
  store.proof_decision_records.push(record);
  return record;
}

function appendTherapeuticReviewRequest(input: {
  trace: TherapeuticTrace;
  store?: TherapeuticRuntimeStore;
  request: TherapeuticAccessRequest;
  broker_decision: TherapeuticBrokerDecision;
  proof_capsule?: TherapeuticStrictProofCapsule;
  now: string;
}): TherapeuticReviewRequest | undefined {
  if (!input.store) return undefined;
  const existing = input.store.review_requests.find((review) =>
    review.task_id === input.trace.task_id
    && review.request.id === input.request.id
    && review.status === "pending"
  );
  if (existing) return existing;
  const route = classifyTherapeuticProofRoute({ request: input.request });
  const review: TherapeuticReviewRequest = {
    review_id: therapeuticId("therapeutic_review", [input.trace.task_id, input.request.id, input.now]),
    task_id: input.trace.task_id,
    request: cloneJson(input.request),
    tier: input.broker_decision.tier,
    decision_mechanism: route.decision_mechanism,
    required_gates: [...route.required_gates],
    ...(input.proof_capsule ? { proof_capsule_id: input.proof_capsule.id } : {}),
    deterministic_claim_results: input.proof_capsule?.machine_verifiable_claims.map((claim) => cloneJson(claim)) ?? [],
    judgment_claims: input.proof_capsule?.human_reviewed_claims.map((claim) => cloneJson(claim)) ?? [],
    narrative_claims: input.proof_capsule?.unverifiable_narrative_claims.map((claim) => cloneJson(claim)) ?? [],
    status: "pending",
    created_at: input.now,
    auto_grants_broader_access: false,
  };
  input.store.review_requests.push(review);
  return review;
}

function recordDeniedAccessOnTrace(
  trace: TherapeuticTrace,
  request: TherapeuticAccessRequest,
  decision: TherapeuticBrokerDecision
): void {
  if (decision.blocked_by.includes("lower_risk_probe_available") || decision.blocked_by.includes("forbidden_data_requested")) {
    trace.blocked_overreach_attempts.push({
      requested_access: cloneJson(request),
      decision: "denied",
      reason: [...decision.blocked_by],
      suggested_alternative: [...decision.suggested_alternatives],
    });
  }
  trace.suggested_lower_risk_alternatives = uniqueStrings([
    ...trace.suggested_lower_risk_alternatives,
    ...decision.suggested_alternatives,
  ]);
}

function proofLifecycleBlockedBy(
  proofCapsule: TherapeuticStrictProofCapsule | undefined,
  store: TherapeuticRuntimeStore | undefined
): string[] {
  if (!proofCapsule || !store) return [];
  const status = store.proof_statuses[proofCapsule.id];
  if (status === "used") return ["proof_capsule_replay"];
  if (status === "revoked") return ["proof_capsule_revoked"];
  const expiration = grantExpiresAt(proofCapsule.requested_access, proofCapsule.timestamp);
  if (expiration <= new Date().toISOString()) return ["proof_capsule_stale"];
  return [];
}

function grantExpiresAt(request: TherapeuticAccessRequest, now: string): string {
  if (request.expiration === "end_of_task") return "9999-12-31T23:59:59.999Z";
  if (request.expiration.endsWith("m")) {
    const minutes = Number.parseInt(request.expiration.slice(0, -1), 10);
    if (Number.isFinite(minutes) && minutes > 0) return new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
  }
  const parsed = new Date(request.expiration);
  return Number.isNaN(parsed.getTime()) ? "9999-12-31T23:59:59.999Z" : parsed.toISOString();
}

function authorityDoseForGrant(
  grant: TherapeuticTemporaryGrant,
  decision: TherapeuticBrokerDecision
): TherapeuticAuthorityDose {
  const request = grant.access_request;
  return {
    id: therapeuticId("dose", [grant.grant_id]),
    task_id: grant.task_id,
    level: request.authority_dose,
    scope: request.scope,
    permitted_tools: [...request.tools],
    permitted_data_classes: [...request.data_classes],
    forbidden_data_classes: [...THERAPEUTIC_DEFAULT_POLICY.forbidden_data_classes],
    mutation_allowed: request.mode === "write",
    max_blast_radius: request.scope,
    expiration_condition: request.expiration,
    revoke_plan: request.revocable ? "temporary grant is revoked on task end or explicit revoke" : "manual review required",
    expected_effect: request.purpose,
    side_effects: [],
    decision: decision.decision,
  };
}

function therapeuticId(prefix: string, parts: string[]): string {
  let hash = 0;
  const value = parts.join("\u0000");
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return `${prefix}_${Math.abs(hash).toString(16)}`;
}

function stringFromInput(input: Record<string, unknown>, key: string, fallback: string): string {
  return typeof input[key] === "string" && input[key].trim().length > 0 ? input[key].trim() : fallback;
}

function numberFromInput(input: Record<string, unknown>, key: string, fallback: number): number {
  return typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] : fallback;
}

function boolFromInput(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof input[key] === "boolean" ? input[key] : fallback;
}

function objectFromInput(input: Record<string, unknown>, key: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fallback;
}

function firstTraceString(trace: TherapeuticTrace, key: string, fallback: string): string {
  for (const probe of trace.projection_probes) {
    const value = probe.result_summary[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function overEscalationCheckride(
  trace: TherapeuticTrace,
  policy: TherapeuticPolicy,
  evidenceRefs: string[],
  now: string
): TherapeuticCheckrideResult {
  const broadWhileProbeAvailable = trace.blocked_overreach_attempts.some((attempt) =>
    isBroadAccessRequest(attempt.requested_access, policy) && attempt.suggested_alternative.length > 0
  );
  return checkrideResult({
    trace,
    kind: "over_escalation",
    status: broadWhileProbeAvailable ? "passed" : "failed",
    finding: broadWhileProbeAvailable
      ? "Broad sensitive access was blocked while lower-risk probes existed."
      : "No evidence proves broad sensitive access was blocked before lower-risk probes.",
    evidenceRefs,
    blockedBy: broadWhileProbeAvailable ? [] : ["over_escalation_guard_not_observed"],
    now,
    deltaKind: "add_guardrail",
    rule: "Deny broad sensitive diagnostic access while contract-bound lower-risk probes remain available.",
  });
}

function underEscalationCheckride(
  trace: TherapeuticTrace,
  availableRequests: TherapeuticAccessRequest[],
  policy: TherapeuticPolicy,
  evidenceRefs: string[],
  now: string
): TherapeuticCheckrideResult {
  const under = evaluateUnderEscalation({ trace, available_requests: availableRequests, policy });
  return checkrideResult({
    trace,
    kind: "under_escalation",
    status: under.under_escalated ? "failed" : "passed",
    finding: under.under_escalated
      ? "Serious blocked uncertainty has a scoped read-only escalation available but unused."
      : "No serious blocked uncertainty is stuck below an available scoped read-only escalation.",
    evidenceRefs,
    blockedBy: under.under_escalated ? under.flags : [],
    now,
    deltaKind: "emergency_escalation_review",
    rule: "Escalate serious blocked uncertainty to the smallest scoped read-only request after lower-risk probes are exhausted.",
  });
}

function strictProofCapsuleCheckride(
  trace: TherapeuticTrace,
  evidenceRefs: string[],
  now: string
): TherapeuticCheckrideResult {
  const invalidCapsules = trace.proof_capsules.filter((capsule) =>
    capsule.failed_claims.length > 0
    || capsule.machine_verifiable_claims.length === 0
    || capsule.machine_verifiable_claims.some((claim) => claim.critical && claim.result !== "pass")
  );
  return checkrideResult({
    trace,
    kind: "strict_proof_capsule",
    status: invalidCapsules.length === 0 && trace.proof_capsules.length > 0 ? "passed" : "failed",
    finding: invalidCapsules.length === 0 && trace.proof_capsules.length > 0
      ? "Strict proof capsules separate machine, human, and narrative claims with passing critical gates."
      : "Strict proof capsule evidence is missing or has failed critical claims.",
    evidenceRefs,
    blockedBy: invalidCapsules.length > 0 ? invalidCapsules.flatMap((capsule) => capsule.failed_claims) : ["strict_proof_capsule_missing"],
    now,
    deltaKind: "tighten_proof_gate",
    rule: "Sensitive escalation requires machine-verifiable proof with no failed critical claims.",
  });
}

function adversarialProbeOutputCheckride(
  trace: TherapeuticTrace,
  evidenceRefs: string[],
  now: string
): TherapeuticCheckrideResult {
  const contract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary");
  if (!contract) {
    return checkrideResult({
      trace,
      kind: "adversarial_probe_output",
      status: "blocked",
      finding: "Adversarial probe output checkride could not find a probe contract to attack.",
      evidenceRefs,
      blockedBy: ["probe_contract_missing"],
      now,
      deltaKind: "tighten_proof_gate",
      rule: "Adversarial probe-output checkrides require at least one executable probe contract.",
    });
  }
  const leakyProbe = buildProjectionProbe({
    id: "checkride_adversarial_probe",
    task_id: trace.task_id,
    contract,
    target_uncertainty: trace.uncertainties[0]?.id ?? "task_uncertainty",
    result_summary: {
      top_feature: "customer_plan",
      drift_score: 0.9,
      affected_segment: "enterprise_users",
      confidence: 0.9,
      time_window: "last_24h",
      raw_training_rows: [{ customer_id: "leak" }],
    },
    actual_information_gain: 0,
    confidence: 0,
    status: "failed",
  });
  return checkrideResult({
    trace,
    kind: "adversarial_probe_output",
    status: leakyProbe.allowed_output_shape_valid ? "failed" : "passed",
    finding: leakyProbe.allowed_output_shape_valid
      ? "Leaky probe output was not rejected by the schema gate."
      : "Leaky probe output fails closed under allowed-shape and forbidden-output validation.",
    evidenceRefs,
    blockedBy: leakyProbe.allowed_output_shape_valid ? ["adversarial_probe_leak_accepted"] : [],
    now,
    deltaKind: "tighten_proof_gate",
    rule: "Probe adapters must fail closed when output includes forbidden raw or identifying fields.",
  });
}

function sourceDriftCheckride(
  trace: TherapeuticTrace,
  evidenceRefs: string[],
  now: string,
  existingCaseLawRecords: TherapeuticCaseLawRecord[] = []
): TherapeuticCheckrideResult {
  const staleCapsules = trace.proof_capsules.filter((capsule) =>
    Date.parse(capsule.timestamp) > 0 && Date.parse(capsule.timestamp) < Date.parse(now) - 7 * 24 * 60 * 60 * 1000
  );
  const expiredCaseLaw = existingCaseLawRecords.filter((record) => Date.parse(record.expires_at) <= Date.parse(now));
  const hasEvidenceLinks = trace.proof_capsules.every((capsule) => capsule.evidence_links.length > 0);
  const passed = staleCapsules.length === 0 && hasEvidenceLinks && expiredCaseLaw.length === 0;
  return checkrideResult({
    trace,
    kind: "source_drift",
    status: passed ? "passed" : "blocked",
    finding: passed
      ? "Proof capsules and case-law records are current enough for this checkride and retain evidence links."
      : "Proof capsules or case-law records need source-drift recertification or evidence-link refresh.",
    evidenceRefs,
    blockedBy: [
      ...(staleCapsules.length > 0 ? ["stale_proof_capsule"] : []),
      ...(hasEvidenceLinks ? [] : ["proof_capsule_evidence_links_missing"]),
      ...(expiredCaseLaw.length > 0 ? ["expired_case_law"] : []),
    ],
    now,
    deltaKind: "add_guardrail",
    rule: "Revalidate therapeutic proof capsules and case law when source evidence drifts, expires, or evidence links are missing.",
  });
}

function emergencyEscalationCheckride(
  trace: TherapeuticTrace,
  evidenceRefs: string[],
  now: string
): TherapeuticCheckrideResult {
  const hasCriticalBlocked = trace.uncertainties.some((uncertainty) =>
    uncertainty.severity === "critical" && uncertainty.blocking_status === "blocked"
  );
  const hasHumanOverride = trace.human_overrides.length > 0;
  const passed = !hasCriticalBlocked || hasHumanOverride || trace.under_escalation_flags.length > 0;
  return checkrideResult({
    trace,
    kind: "emergency_escalation",
    status: passed ? "passed" : "blocked",
    finding: passed
      ? "Emergency escalation path is either not needed or has an explicit human/under-escalation signal."
      : "Critical blocked uncertainty lacks an emergency escalation review signal.",
    evidenceRefs,
    blockedBy: passed ? [] : ["critical_blocked_uncertainty_without_emergency_review"],
    now,
    deltaKind: "emergency_escalation_review",
    rule: "Critical blocked uncertainty must trigger human emergency escalation review without granting automatic broad access.",
  });
}

function checkrideResult(input: {
  trace: TherapeuticTrace;
  kind: TherapeuticCheckrideKind;
  status: TherapeuticCheckrideResult["status"];
  finding: string;
  evidenceRefs: string[];
  blockedBy: string[];
  now: string;
  deltaKind: TherapeuticPolicyDeltaRecord["delta_kind"];
  rule: string;
}): TherapeuticCheckrideResult {
  const checkrideId = therapeuticId("therapeutic_checkride_case", [input.trace.task_id, input.kind, input.finding]);
  const evidenceRefs = input.evidenceRefs.length > 0 ? input.evidenceRefs : [`trace:${input.trace.task_id}`];
  const policyDelta = input.status === "passed" || input.status === "failed"
    ? therapeuticPolicyDelta(input.trace, input.deltaKind, input.finding, evidenceRefs, input.now)
    : undefined;
  const caseLaw = input.status === "failed" || input.status === "blocked"
    ? therapeuticCaseLaw(input.trace, input.finding, input.rule, evidenceRefs, input.now)
    : undefined;
  return {
    checkride_id: checkrideId,
    kind: input.kind,
    status: input.status,
    finding: input.finding,
    evidence_refs: evidenceRefs,
    blocked_by: uniqueStrings(input.blockedBy),
    ...(policyDelta ? { policy_delta: policyDelta } : {}),
    ...(caseLaw ? { case_law_record: caseLaw } : {}),
  };
}

function therapeuticPolicyDelta(
  trace: TherapeuticTrace,
  deltaKind: TherapeuticPolicyDeltaRecord["delta_kind"],
  rationale: string,
  evidenceRefs: string[],
  now: string
): TherapeuticPolicyDeltaRecord {
  return {
    schema_version: "synthi.dojo.therapeuticPolicyDelta.v1",
    policy_delta_id: therapeuticId("therapeutic_policy_delta", [trace.task_id, deltaKind, rationale]),
    status: "hypothesis",
    task_class: trace.task_class,
    delta_kind: deltaKind,
    rationale,
    evidence_refs: uniqueStrings(evidenceRefs),
    created_at: now,
    auto_grants_broader_access: false,
  };
}

function therapeuticCaseLaw(
  trace: TherapeuticTrace,
  finding: string,
  rule: string,
  evidenceRefs: string[],
  now: string
): TherapeuticCaseLawRecord {
  return {
    schema_version: "synthi.dojo.therapeuticCaseLaw.v1",
    case_id: therapeuticId("therapeutic_case", [trace.task_id, finding, rule]),
    status: "proposed",
    task_class: trace.task_class,
    finding,
    rule_created: rule,
    confidence: therapeuticCaseLawConfidence(trace),
    evidence_refs: uniqueStrings(evidenceRefs),
    created_at: now,
    expires_at: addDaysIso(now, 90),
    revalidation_status: "current",
    auto_grants_broader_access: false,
  };
}

function therapeuticTraceEvidenceRefs(trace: TherapeuticTrace, store: TherapeuticRuntimeStore | undefined): string[] {
  return uniqueStrings([
    `trace:${trace.task_id}`,
    ...trace.projection_probes.map((probe) => `probe:${probe.id}`),
    ...trace.proof_capsules.map((capsule) => `proof:${capsule.id}`),
    ...(store?.evidence_records.map((record) => `evidence:${record.evidence_id}`) ?? []),
    ...(store?.audit_records.map((record) => `audit:${record.audit_id}`) ?? []),
  ]);
}

function mostCommonProbeSequence(traces: TherapeuticTrace[]): string[] {
  const counts = new Map<string, number>();
  for (const trace of traces) {
    const sequence = uniqueStrings(trace.projection_probes
      .filter((probe) => probe.status === "completed" && probe.allowed_output_shape_valid)
      .sort((left, right) => left.required_authority_dose - right.required_authority_dose)
      .map((probe) => probe.name));
    if (sequence.length === 0) continue;
    const key = sequence.join("|");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  return best ? best.split("|") : [];
}

function learningConfidence(matches: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, Number((matches / total).toFixed(2))));
}

function learningEvidenceRefs(traces: TherapeuticTrace[], store: TherapeuticRuntimeStore | undefined): string[] {
  return uniqueStrings(traces.flatMap((trace) => therapeuticTraceEvidenceRefs(trace, store)));
}

function therapeuticLearningRecord(input: {
  taskClass: string;
  kind: TherapeuticPolicyLearningRecord["learning_kind"];
  recommendation: string;
  confidence: number;
  traces: TherapeuticTrace[];
  reports: TherapeuticCheckrideReport[];
  evidenceRefs: string[];
  now: string;
}): TherapeuticPolicyLearningRecord {
  const traceIds = uniqueStrings(input.traces.map((trace) => trace.task_id));
  const reportIds = uniqueStrings(input.reports.map((report) => report.report_id));
  return {
    schema_version: "synthi.dojo.therapeuticPolicyLearning.v1",
    learning_id: therapeuticId("therapeutic_policy_learning", [
      input.taskClass,
      input.kind,
      input.recommendation,
      traceIds.join("|"),
    ]),
    task_class: input.taskClass,
    learning_kind: input.kind,
    recommendation: input.recommendation,
    confidence: input.confidence,
    supporting_evidence_refs: uniqueStrings(input.evidenceRefs),
    source_trace_ids: traceIds,
    source_checkride_report_ids: reportIds,
    created_at: input.now,
    expires_at: addDaysIso(input.now, 90),
    revalidation_status: "current",
    auto_grants_broader_access: false,
  };
}

function therapeuticCaseLawConfidence(trace: TherapeuticTrace): number {
  const approvedProofRatio = percent(trace.proof_capsules, (capsule) => capsule.approved) / 100;
  const validProbeRatio = percent(trace.projection_probes, (probe) => probe.status === "completed" && probe.allowed_output_shape_valid) / 100;
  const evidenceScore = trace.proof_capsules.some((capsule) => capsule.evidence_links.length > 0) ? 0.1 : 0;
  return Math.max(0.1, Math.min(1, Number(((approvedProofRatio * 0.45) + (validProbeRatio * 0.45) + evidenceScore).toFixed(2))));
}

function addDaysIso(now: string, days: number): string {
  const parsed = Date.parse(now);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}
