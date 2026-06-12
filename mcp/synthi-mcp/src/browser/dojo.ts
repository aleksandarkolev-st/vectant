import { createHash, randomUUID } from "node:crypto";
import type { PrivateWorkflowToolManifestV7 } from "./private_tool_manifest.js";
import type { WorkflowContractV7, WorkflowLimitationV7, WorkflowStepContractV7 } from "./workflow.js";
import {
  buildDojoEvidenceLedger,
  buildDojoGovernanceReport,
  buildDojoLifecycleReport,
  buildDojoOrganizationRegistry,
  buildDojoSourceAffordancePrPlan,
  buildDojoUniverseDossier,
  buildDojoUniverseMetrics,
  runDojoTimeMachineDebugger,
} from "./dojo_universe.js";
import {
  createDefaultDojoSkillStore,
  InMemoryDojoSkillStore,
  type DojoAuditActor,
  type DojoCaseLawRecordFilter,
  type DojoControlPlaneStore,
  type DojoPermissionUpgradeRequestFilter,
  type DojoPermissionUpgradeRequestRecord,
  type DojoProofConsumeResult,
  type DojoProofCapsuleRecord,
} from "./dojo_store.js";
import type { DojoCaseLawRecord } from "../dojo/case_law/registry.js";
import { normalizeDojoProofErrorCodes, type DojoProofErrorCode } from "../dojo/proof/errors.js";
import type { DojoPublishedWorkflowBinding } from "../dojo/store/published_workflow_index.js";
import { resolveDojoEvidenceClaims } from "../dojo/evidence/verifier.js";
import type { DojoEvidenceClaimResult } from "../dojo/evidence/claims.js";
import type { DojoEvidenceLedgerRecord } from "../dojo/evidence/types.js";
import {
  buildDojoRedactedEvidenceExportManifest,
  type DojoRedactedEvidenceExportManifest,
} from "../dojo/evidence/export.js";
import {
  DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
  DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV,
  DOJO_PROOF_SIGNING_COMMAND_ENV,
  DOJO_PROOF_SIGNING_KEY_ENV,
  DOJO_PROOF_SIGNING_KEY_ID_ENV,
  DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
} from "../dojo/config/enforcement.js";
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  createEd25519DojoProofVerifier,
  createExternalCommandDojoProofSigner,
  createLocalHmacDojoProofSigner,
  encodeDojoProofSignatureEnvelope,
  parseDojoProofSignatureEnvelope,
  type DojoProofSigner,
  type DojoProofSigningAlgorithm,
  type DojoProofVerifier,
} from "../dojo/proof/signing.js";
import { compileDojoSkillGraphForSkill } from "../dojo/graph/compiler.js";
import { toDojoScenarioDefinitions } from "../dojo/vivarium/scenario_dsl.js";
import { buildDojoMcpSkillManifest } from "../dojo/mcp/manifest_signing.js";

export type DojoEntrustmentLevel = "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "EX";
export type DojoSkillReadinessLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type DojoExecutionSubstrate = "vision" | "dom" | "source" | "api" | "mcp";
export type DojoScenarioTier = 0 | 1 | 2 | 3 | 4 | 5;
export type DojoCheckrideLayer = "knowledge" | "risk" | "skill";
export type DojoCheckrideStatus = "passed" | "failed" | "blocked";
export type DojoWorkflowNodeKind =
  | "Trigger"
  | "Input"
  | "Observe"
  | "Locate"
  | "Action"
  | "Assertion"
  | "Branch"
  | "Permission"
  | "Guardrail"
  | "Retry"
  | "Artifact"
  | "Subskill"
  | "Human"
  | "Rollback"
  | "Memory"
  | "Adversary"
  | "Checkride"
  | "Proof"
  | "CaseLaw"
  | "Expiry";

export interface DojoInputField {
  name: string;
  label: string;
  value_shape: string;
  required: boolean;
  redacted: boolean;
}

export interface DojoCondition {
  condition_id: string;
  kind: "precondition" | "postcondition" | "guardrail" | "license" | "evidence";
  label: string;
  source: "workflow" | "dojo" | "case_law";
}

export interface DojoAssertion {
  assertion_id: string;
  label: string;
  required: boolean;
  source: "workflow" | "dojo" | "case_law";
}

export interface DojoFailureMode {
  failure_mode_id: string;
  type: string;
  label: string;
  severity: "low" | "medium" | "high" | "critical";
  source: "workflow" | "scenario" | "case_law";
}

export interface DojoRiskClue {
  risk_id: string;
  label: string;
  severity: "low" | "medium" | "high" | "critical";
  source_step_id?: string;
}

export interface DojoSourceAnchor {
  anchor_id: string;
  kind: "source" | "api" | "ui";
  label: string;
  source_step_id?: string;
  file_path?: string;
  line?: number;
}

export interface DojoOpenQuestion {
  question_id: string;
  label: string;
  reason: string;
}

export interface DojoSkillSeed {
  schema_version: "synthi.dojo.skillSeed.v1";
  seed_id: string;
  workspace_id: string;
  workflow_id: string;
  observed_trace: {
    workflow_id: string;
    app_origin: string;
    route_pattern?: string;
    step_count: number;
  };
  inferred_intent: string;
  involved_entities: Array<{ entity_id: string; label: string; source: "input" | "target" | "route" }>;
  input_schema: DojoInputField[];
  output_schema: {
    success_assertions: string[];
    evidence: string[];
  };
  candidate_preconditions: DojoCondition[];
  candidate_success_assertions: DojoAssertion[];
  candidate_failure_modes: DojoFailureMode[];
  touched_surfaces: Array<{
    surface_id: string;
    kind: string;
    replay: string;
    step_ids: string[];
  }>;
  touched_data_models: Array<{ model_id: string; label: string; source: "parameter" | "target" | "route" }>;
  policy_clues: Array<{ policy_id: string; label: string; source: "auth" | "mutation" | "origin" | "license" }>;
  risk_clues: DojoRiskClue[];
  source_or_api_anchors: DojoSourceAnchor[];
  unknowns: DojoOpenQuestion[];
  generated_at: string;
}

export interface DojoScenario {
  scenario_id: string;
  title: string;
  layer: DojoCheckrideLayer;
  simulator_tier: DojoScenarioTier;
  mutation_kind: string;
  expected_behavior: string;
  risk_tags: string[];
  generated_from: "seed" | "case_law" | "dojo_template";
}

export interface DojoScenarioResult {
  scenario_id: string;
  layer: DojoCheckrideLayer;
  status: DojoCheckrideStatus;
  critical: boolean;
  finding: string;
  guardrail_suggestion?: string;
  evidence_refs: string[];
}

export interface DojoCheckrideReport {
  schema_version: "synthi.dojo.checkrideReport.v1";
  checkride_id: string;
  skill_id: string;
  workflow_id: string;
  started_at: string;
  finished_at: string;
  knowledge: { passed: number; total: number };
  risk: { passed: number; total: number };
  skill: { passed: number; total: number };
  critical_failures: number;
  blocked_scenarios: number;
  results: DojoScenarioResult[];
  entrustment_recommendation: DojoEntrustmentLevel;
  readiness_level: DojoSkillReadinessLevel;
  coverage_score: number;
  limitations: string[];
}

export interface DojoSkillCase {
  case_id: string;
  title: string;
  date: string;
  source_skill_id: string;
  source_run_id: string;
  finding: string;
  impact: string;
  rule_created: string;
  applies_to: string[];
  binding_scope: "skill" | "workspace" | "organization";
  status: "proposed" | "binding" | "deprecated";
  evidence_refs: string[];
}

export interface DojoGuardrail {
  guardrail_id: string;
  title: string;
  rule: string;
  blocks_actions: string[];
  source_case_id?: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface DojoLicenseAction {
  action: string;
  constraints: string[];
}

export interface DojoEvidenceRequirement {
  claim: string;
  required: boolean;
}

export interface DojoProofRequirement {
  required_context_claims: string[];
  required_evidence_claims: string[];
  required_guardrails: string[];
}

export interface DojoPermissionLicense {
  schema_version: "synthi.dojo.permissionLicense.v1";
  license_id: string;
  skill_id: string;
  license_version: string;
  entrustment_level: DojoEntrustmentLevel;
  autonomy_level: "observe" | "practice" | "draft" | "edit" | "submit_limited" | "submit_gated" | "blocked";
  allowed_actions: DojoLicenseAction[];
  gated_actions: DojoLicenseAction[];
  blocked_actions: DojoLicenseAction[];
  evidence_requirements: DojoEvidenceRequirement[];
  approval_requirements: string[];
  substrate_requirements: Array<{ action: string; allowed_substrates: DojoExecutionSubstrate[] }>;
  proof_requirements: DojoProofRequirement;
  expiry_policy: {
    expires_on: string[];
    recertify_after_days: number;
  };
  issued_at: string;
}

export interface DojoEvidenceClaim {
  claim: string;
  satisfied: boolean;
  evidence_refs?: string[];
}

export interface DojoProofCarryingSkillCapsule {
  schema_version: "synthi.dojo.proofCapsule.v1";
  capsule_id: string;
  skill_id: string;
  skill_version: string;
  requested_action: string;
  license_version: string;
  entrustment_level: DojoEntrustmentLevel;
  issuer: string;
  key_id: string;
  nonce: string;
  context_claims: Record<string, unknown>;
  evidence_claims: DojoEvidenceClaim[];
  evidence_record_ids: string[];
  ledger_checkpoint_hash?: string;
  guardrails_active: string[];
  substrate_claim: DojoExecutionSubstrate;
  assurance_case_ref: string;
  issued_at: string;
  expires_at: string;
  signature_algorithm: DojoProofSigningAlgorithm;
  signature: string;
}

export interface DojoAssuranceCase {
  schema_version: "synthi.dojo.assuranceCase.v1";
  assurance_case_id: string;
  skill_id: string;
  claim: string;
  context: string;
  argument: string;
  evidence_refs: string[];
  limits: string[];
  expiration: string[];
}

export interface DojoSkillCard {
  title: string;
  status: string;
  can_do_alone: string[];
  will_ask_before: string[];
  will_not_do: string[];
  practiced: string;
  found_and_fixed: string;
  proof_badge: string;
}

export interface DojoSkillPassport {
  passport_id: string;
  skill_id: string;
  skill_version: string;
  entrustment_level: DojoEntrustmentLevel;
  readiness_level: DojoSkillReadinessLevel;
  checkride_id: string;
  license_id: string;
  assurance_case_id: string;
  proof_required: boolean;
  coverage_score: number;
  attack_success_rate: number;
  license_expires_at: string;
  published_tools: string[];
  issued_at: string;
}

export interface DojoNodeMemory {
  confidence: number;
  rehearsal_count: number;
  failures_seen: string[];
  last_success_at?: string;
  expiry_triggers: string[];
  cost_profile: {
    simulator_tier: DojoScenarioTier;
    estimated_tokens: number;
    estimated_ms: number;
  };
}

export interface DojoWorkflowNode {
  node_id: string;
  kind: DojoWorkflowNodeKind;
  label: string;
  source_step_id?: string;
  substrate?: DojoExecutionSubstrate;
  guardrail_refs: string[];
  case_refs: string[];
  inputs: string[];
  outputs: string[];
  memory: DojoNodeMemory;
  metadata: Record<string, unknown>;
}

export interface DojoWorkflowEdge {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  condition?: string;
  learned_from: string[];
  confidence: number;
}

export interface DojoLearnedTransition {
  from_node_id: string;
  to_node_id: string;
  observed_in: string[];
  confidence: number;
  reason: string;
}

export interface DojoSkillCortex {
  schema_version: "synthi.dojo.skillCortex.v1";
  workflow_graph_id: string;
  skill_id: string;
  workflow_id: string;
  skill_seed_id: string;
  app_model_version: string;
  nodes: DojoWorkflowNode[];
  edges: DojoWorkflowEdge[];
  learned_transitions: DojoLearnedTransition[];
  entry_node_id: string;
  exit_node_ids: string[];
  generated_at: string;
}

export interface DojoRun {
  run_id: string;
  skill_id: string;
  workflow_id: string;
  scenario_id?: string;
  mode: "ghost" | "vivarium" | "counterfactual" | "evil_twin" | "checkride";
  simulator_tier: DojoScenarioTier;
  substrate: DojoExecutionSubstrate;
  status: DojoCheckrideStatus;
  started_at: string;
  finished_at: string;
  finding: string;
  guardrails_triggered: string[];
  license_checks: Array<{ action: string; status: "allowed" | "blocked" | "approval_required"; blocked_by: string[] }>;
  cost: {
    estimated_tokens: number;
    estimated_ms: number;
    model_calls: number;
  };
  evidence_refs: string[];
}

export interface DojoWorkspaceOrganoid {
  schema_version: "synthi.dojo.workspaceOrganoid.v1";
  organoid_id: string;
  skill_id: string;
  skill_seed_id: string;
  workspace_id: string;
  generated_at: string;
  version: string;
  tissues: {
    ui: Record<string, unknown>;
    data: Record<string, unknown>;
    policy: Record<string, unknown>;
    identity: Record<string, unknown>;
    document: Record<string, unknown>;
    api: Record<string, unknown>;
    failure: Record<string, unknown>;
    adversary: Record<string, unknown>;
    evidence: Record<string, unknown>;
    source: Record<string, unknown>;
    license: Record<string, unknown>;
  };
  scenario_refs: string[];
  safety_constraints: string[];
  data_policy: {
    production_data_allowed: boolean;
    redact_screenshots_by_default: boolean;
    synthetic_data_only: boolean;
  };
}

export interface DojoWindTunnelReport {
  schema_version: "synthi.dojo.windTunnelReport.v1";
  wind_tunnel_id: string;
  skill_id: string;
  workflow_id: string;
  generated_at: string;
  scenario_count: number;
  run_count: number;
  runs: DojoRun[];
  summary: {
    passed: number;
    failed: number;
    blocked: number;
    cheapest_sufficient_tier: DojoScenarioTier;
    stop_reason: string;
  };
}

export interface DojoCounterfactualTwinReport {
  schema_version: "synthi.dojo.counterfactualTwinReport.v1";
  twin_id: string;
  skill_id: string;
  workflow_id: string;
  generated_at: string;
  variants: Array<{
    variant_id: string;
    scenario_id: string;
    mutation_kind: string;
    cheapest_sufficient_tier: DojoScenarioTier;
    expected_behavior: string;
    observed_behavior: string;
    outcome: DojoCheckrideStatus;
    reason: string;
  }>;
  recommended_substrate: DojoExecutionSubstrate;
  promoted_scenarios: string[];
}

export interface DojoEvilTwinReport {
  schema_version: "synthi.dojo.evilTwinReport.v1";
  red_team_id: string;
  skill_id: string;
  workflow_id: string;
  generated_at: string;
  attacks: Array<{
    attack_id: string;
    scenario_id: string;
    mutation_kind: string;
    strategy: string;
    expected_refusal: string;
    status: "caught" | "escaped" | "blocked";
    finding: string;
    guardrail_refs: string[];
    case_refs: string[];
  }>;
  attack_success_rate: number;
  hardened_by: string[];
}

export interface DojoAntibody {
  antibody_id: string;
  case_id: string;
  guardrail_id: string;
  trigger: string;
  response: string;
  applies_to: string[];
  binding_scope: "skill" | "workspace" | "organization";
  evidence_refs: string[];
  created_at: string;
}

export interface DojoSkillGenome {
  schema_version: "synthi.dojo.skillGenome.v1";
  genome_id: string;
  skill_id: string;
  pattern_id: string;
  intent_fingerprint: string;
  entity_shapes: string[];
  input_shapes: string[];
  risk_tags: string[];
  guardrail_patterns: string[];
  license_shape: {
    entrustment_level: DojoEntrustmentLevel;
    allowed_actions: string[];
    gated_actions: string[];
    blocked_actions: string[];
  };
  portable_to: string[];
  shared_without: string[];
  generated_at: string;
}

export interface DojoAgentReadyUiContract {
  schema_version: "synthi.dojo.agentReadyUiContract.v1";
  contract_id: string;
  skill_id: string;
  workflow_id: string;
  target_app_origin: string;
  actions: Array<{
    action_id: string;
    label: string;
    source_step_id: string;
    stable_locator: string | null;
    fallback_locators: string[];
    source_anchor_id?: string;
    required_inputs: string[];
    allowed_substrates: DojoExecutionSubstrate[];
    success_condition: string;
    risk_tags: string[];
    proof_claims: string[];
  }>;
  refusal_contracts: Array<{ guardrail_id: string; refusal: string }>;
  generated_at: string;
}

export interface DojoCostControlPolicy {
  schema_version: "synthi.dojo.costControlPolicy.v1";
  policy_id: string;
  skill_id: string;
  default_budget: {
    max_scenarios: number;
    max_simulator_tier: DojoScenarioTier;
    max_runs: number;
    max_model_calls: number;
    max_estimated_tokens: number;
    max_estimated_ms: number;
  };
  tier_policy: Array<{ tier: DojoScenarioTier; use_for: string[]; max_runs: number }>;
  stop_conditions: string[];
  revalidation_policy: {
    recertify_after_days: number;
    triggers: string[];
  };
  generated_at: string;
}

export interface DojoTrainingReport {
  schema_version: "synthi.dojo.trainingReport.v1";
  training_report_id: string;
  skill_id: string;
  workflow_id: string;
  generated_at: string;
  run_refs: string[];
  summary: {
    scenario_count: number;
    run_count: number;
    coverage_score: number;
    readiness_level: DojoSkillReadinessLevel;
    entrustment_level: DojoEntrustmentLevel;
    guardrail_count: number;
    antibody_count: number;
    attack_success_rate: number;
  };
  readiness_decision: string;
  limitations: string[];
  evidence_refs: string[];
}

export interface DojoRollbackPolicy {
  strategy: "none" | "human_checkpoint" | "same_session_restore" | "ci_fixture_reset";
  checkpoints: string[];
  requires_human_before: string[];
}

export interface DojoEvidencePolicy {
  required_claims: string[];
  accepted_evidence_refs: string[];
  screenshot_redaction: "always" | "when_sensitive" | "never";
  production_artifact_policy: "metadata_only" | "redacted_payloads" | "full_payloads";
}

export interface DojoAuthRequirement {
  requirement_id: string;
  durability: string;
  required: boolean;
  reason: string;
}

export interface DojoRetrainTrigger {
  trigger_id: string;
  source: "app" | "policy" | "incident" | "evidence" | "schedule";
  condition: string;
}

export interface DojoSkill {
  schema_version: "synthi.dojo.skill.v1";
  skill_id: string;
  workspace_id: string;
  workflow_id: string;
  skill_version: string;
  app_model_version: string;
  workflow_graph_id: string;
  vivarium_id: string;
  name: string;
  intent: string;
  app_origin: string;
  skill_seed: DojoSkillSeed;
  skill_cortex: DojoSkillCortex;
  workspace_organoid: DojoWorkspaceOrganoid;
  scenarios: DojoScenario[];
  wind_tunnel: DojoWindTunnelReport;
  counterfactual_twin: DojoCounterfactualTwinReport;
  evil_twin: DojoEvilTwinReport;
  checkride: DojoCheckrideReport;
  case_law: DojoSkillCase[];
  antibodies: DojoAntibody[];
  guardrails: DojoGuardrail[];
  permission_license: DojoPermissionLicense;
  entrustment_level: DojoEntrustmentLevel;
  skill_readiness_level: DojoSkillReadinessLevel;
  proof_capsule_schema: Record<string, unknown>;
  assurance_case: DojoAssuranceCase;
  skill_card: DojoSkillCard;
  skill_passport: DojoSkillPassport;
  skill_genome: DojoSkillGenome;
  agent_ready_ui_contract: DojoAgentReadyUiContract;
  cost_control_policy: DojoCostControlPolicy;
  training_report: DojoTrainingReport;
  rollback_policy: DojoRollbackPolicy;
  evidence_policy: DojoEvidencePolicy;
  source_links: DojoSourceAnchor[];
  auth_requirements: DojoAuthRequirement[];
  data_sensitivity: "none" | "low" | "medium" | "high";
  confidence: number;
  coverage_score: number;
  attack_success_rate: number;
  false_allow_rate: number;
  false_block_rate: number;
  last_trained_at: string;
  license_expires_at: string;
  retrain_triggers: DojoRetrainTrigger[];
  training_runs: DojoRun[];
  checkride_runs: string[];
  case_law_refs: string[];
  published_tools: string[];
  execution_substrates: DojoExecutionSubstrate[];
  preferred_substrate: DojoExecutionSubstrate;
  published_tool_name?: string;
  private_tool_manifest?: PrivateWorkflowToolManifestV7;
  generated_at: string;
}

export interface DojoRepoArtifact {
  path: string;
  content: string;
  content_type: "application/json" | "text/markdown" | "text/typescript";
  sensitive: false;
}

export interface DojoProofValidation {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  error?: string;
  blocked_by: string[];
  error_codes: DojoProofErrorCode[];
  license: {
    skill_id: string;
    license_version: string;
    entrustment_level: DojoEntrustmentLevel;
  };
}

export class DojoProofEvidenceClaimError extends Error {
  readonly code = "dojo_proof_evidence_claim_unverified" as const;
  readonly failed_results: DojoEvidenceClaimResult[];

  constructor(failedResults: DojoEvidenceClaimResult[]) {
    super(`dojo_proof_evidence_claim_unverified:${failedResults.map((result) => result.claim_id).join(",")}`);
    this.name = "DojoProofEvidenceClaimError";
    this.failed_results = failedResults;
  }
}

export function isDojoProofEvidenceClaimError(error: unknown): error is DojoProofEvidenceClaimError {
  return error instanceof DojoProofEvidenceClaimError;
}

export class DojoSkillRegistry {
  constructor(private store: DojoControlPlaneStore = createDefaultDojoSkillStore()) {}

  publish(skill: DojoSkill): DojoSkill {
    const clone = cloneJson(skill);
    this.store.saveSkill(clone);
    return cloneJson(clone);
  }

  get(skillId: string): DojoSkill | null {
    return this.store.getSkill(skillId);
  }

  getByWorkflowId(workflowId: string): DojoSkill | null {
    return this.store.getSkillByWorkflowId(workflowId);
  }

  getByPublishedToolName(toolName: string): DojoSkill | null {
    return this.store.getSkillByPublishedToolName(toolName);
  }

  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null {
    return this.store.getPublishedWorkflowBindingByWorkflowId(workflowId);
  }

  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null {
    return this.store.getPublishedWorkflowBindingByToolName(toolName);
  }

  list(): DojoSkill[] {
    return this.store.listSkills()
      .sort((a, b) => a.name.localeCompare(b.name) || a.skill_id.localeCompare(b.skill_id))
      .map(cloneJson);
  }

  recordProofCapsule(capsule: DojoProofCarryingSkillCapsule, options: { tenant_id?: string } = {}): DojoProofCapsuleRecord {
    const skill = this.get(capsule.skill_id);
    const record: DojoProofCapsuleRecord = {
      ...(options.tenant_id ? { tenant_id: options.tenant_id } : {}),
      ...(skill?.workspace_id ? { workspace_id: skill.workspace_id } : {}),
      capsule_id: capsule.capsule_id,
      skill_id: capsule.skill_id,
      ...(skill?.permission_license.license_id ? { license_id: skill.permission_license.license_id } : {}),
      license_version: capsule.license_version,
      requested_action: capsule.requested_action,
      nonce: capsule.nonce,
      key_id: capsule.key_id,
      signature_algorithm: capsule.signature_algorithm,
      substrate_claim: capsule.substrate_claim,
      evidence_record_ids: [...capsule.evidence_record_ids],
      ...(capsule.ledger_checkpoint_hash ? { ledger_checkpoint_hash: capsule.ledger_checkpoint_hash } : {}),
      issued_at: capsule.issued_at,
      expires_at: capsule.expires_at,
      status: "issued",
    };
    this.store.saveProofRecord(record);
    return cloneJson(record);
  }

  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null {
    return this.store.getProofRecord(capsuleId);
  }

  consumeProofCapsule(capsuleId: string, options: { run_id?: string; now?: string } = {}): DojoProofConsumeResult {
    const now = options.now ?? new Date().toISOString();
    const runId = options.run_id ?? `dojo_run_${shortHash(`${capsuleId}:${now}`)}`;
    const result = this.store.markProofCapsuleUsed(capsuleId, runId, now);
    return cloneJson(result);
  }

  markProofCapsuleValidated(capsuleId: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    const record = this.store.markProofCapsuleValidated(capsuleId, now);
    return record ? cloneJson(record) : null;
  }

  markProofCapsuleUsed(capsuleId: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    return this.consumeProofCapsule(capsuleId, { now }).record;
  }

  revokeProofCapsule(capsuleId: string, reason: string, now?: string, revokedBy?: DojoAuditActor): DojoProofCapsuleRecord | null {
    return this.store.revokeProofCapsule(capsuleId, reason, now, revokedBy);
  }

  listProofRecords(): DojoProofCapsuleRecord[] {
    return this.store.listProofRecords();
  }

  recordPermissionUpgradeRequest(record: DojoPermissionUpgradeRequestRecord): DojoPermissionUpgradeRequestRecord {
    this.store.savePermissionUpgradeRequest(record);
    return cloneJson(record);
  }

  listPermissionUpgradeRequests(filter?: DojoPermissionUpgradeRequestFilter): DojoPermissionUpgradeRequestRecord[] {
    return this.store.listPermissionUpgradeRequests(filter);
  }

  recordCaseLawRecord(record: DojoCaseLawRecord): DojoCaseLawRecord {
    this.store.saveCaseLawRecord(record);
    return cloneJson(record);
  }

  getCaseLawRecord(caseId: string): DojoCaseLawRecord | null {
    return this.store.getCaseLawRecord(caseId);
  }

  listCaseLawRecords(filter?: DojoCaseLawRecordFilter): DojoCaseLawRecord[] {
    return this.store.listCaseLawRecords(filter);
  }

  useStoreForTests(store: DojoControlPlaneStore = new InMemoryDojoSkillStore()): void {
    this.store = store;
  }

  resetForTests(): void {
    this.store.clear();
  }
}

export const dojoSkillRegistry = new DojoSkillRegistry();

export function extractDojoSkillSeed(
  contract: WorkflowContractV7,
  options: { workspace_id?: string; now?: string } = {}
): DojoSkillSeed {
  const now = options.now ?? new Date().toISOString();
  const workspaceId = options.workspace_id ?? workflowWorkspaceId(contract);
  const seedId = `seed_${shortHash([contract.workflowId, contract.name, String(contract.steps.length)].join(":"))}`;
  const assertions = successAssertions(contract);
  const surfaces = touchedSurfaces(contract);
  const sourceAnchors = sourceAnchorsFor(contract);
  const riskClues = riskCluesFor(contract);

  return {
    schema_version: "synthi.dojo.skillSeed.v1",
    seed_id: seedId,
    workspace_id: workspaceId,
    workflow_id: contract.workflowId,
    observed_trace: {
      workflow_id: contract.workflowId,
      app_origin: contract.appOrigin,
      ...(contract.routePattern ? { route_pattern: contract.routePattern } : {}),
      step_count: contract.steps.length,
    },
    inferred_intent: contract.description || contract.name,
    involved_entities: involvedEntitiesFor(contract),
    input_schema: contract.parameters.map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      value_shape: parameter.valueShape,
      required: parameter.required,
      redacted: parameter.redacted,
    })),
    output_schema: {
      success_assertions: assertions.map((assertion) => assertion.label),
      evidence: evidenceRefsFor(contract),
    },
    candidate_preconditions: preconditionsFor(contract),
    candidate_success_assertions: assertions,
    candidate_failure_modes: failureModesFor(contract),
    touched_surfaces: surfaces,
    touched_data_models: dataModelsFor(contract),
    policy_clues: policyCluesFor(contract),
    risk_clues: riskClues,
    source_or_api_anchors: sourceAnchors,
    unknowns: unknownsFor(contract, sourceAnchors, riskClues),
    generated_at: now,
  };
}

export function generateDojoVivariumScenarios(seed: DojoSkillSeed): DojoScenario[] {
  const templates: Array<Omit<DojoScenario, "scenario_id">> = [
    {
      title: "Happy path replay",
      layer: "skill",
      simulator_tier: 0,
      mutation_kind: "baseline",
      expected_behavior: "Complete the demonstrated workflow and satisfy every success assertion.",
      risk_tags: ["baseline"],
      generated_from: "seed",
    },
    {
      title: "Missing required input",
      layer: "knowledge",
      simulator_tier: 0,
      mutation_kind: "input_omission",
      expected_behavior: "Stop before action and request the missing required input.",
      risk_tags: ["input_validation"],
      generated_from: "dojo_template",
    },
    {
      title: "Duplicate display entity",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "duplicate_entity",
      expected_behavior: "Do not choose by display name alone; require a stable verified identifier.",
      risk_tags: ["ambiguous_entity_match"],
      generated_from: "dojo_template",
    },
    {
      title: "Stale entity identifier",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "stale_entity",
      expected_behavior: "Re-observe the entity and block if the identifier no longer matches the intended record.",
      risk_tags: ["stale_data"],
      generated_from: "dojo_template",
    },
    {
      title: "Changed control copy",
      layer: "skill",
      simulator_tier: 1,
      mutation_kind: "label_change",
      expected_behavior: "Relocate by stable source or accessibility affordance instead of brittle button text.",
      risk_tags: ["locator_drift"],
      generated_from: "dojo_template",
    },
    {
      title: "Duplicate control labels",
      layer: "risk",
      simulator_tier: 1,
      mutation_kind: "duplicate_label",
      expected_behavior: "Choose only a scoped, semantically correct target; otherwise stop for review.",
      risk_tags: ["ambiguous_locator"],
      generated_from: "dojo_template",
    },
    {
      title: "Delayed hydration",
      layer: "skill",
      simulator_tier: 1,
      mutation_kind: "hydration_delay",
      expected_behavior: "Wait for interactability before acting and classify timeout separately from locator drift.",
      risk_tags: ["hydration_delay"],
      generated_from: "dojo_template",
    },
    {
      title: "Slow network completion",
      layer: "skill",
      simulator_tier: 2,
      mutation_kind: "network_latency",
      expected_behavior: "Wait for the expected completion marker before accepting success.",
      risk_tags: ["network_failure"],
      generated_from: "dojo_template",
    },
    {
      title: "Fake visual success",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "fake_success",
      expected_behavior: "Reject a visual success signal unless the durable state or request evidence also matches.",
      risk_tags: ["fake_success", "evidence_required"],
      generated_from: "dojo_template",
    },
    {
      title: "Application validation error",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "validation_error",
      expected_behavior: "Classify the visible validation error and avoid retrying the same invalid action.",
      risk_tags: ["app_validation"],
      generated_from: "dojo_template",
    },
    {
      title: "Auth expires mid-flow",
      layer: "risk",
      simulator_tier: 3,
      mutation_kind: "auth_expiry",
      expected_behavior: "Stop and require a valid checkpoint or refresh provider before continuing.",
      risk_tags: ["auth_expired"],
      generated_from: "dojo_template",
    },
    {
      title: "Unexpected route change",
      layer: "risk",
      simulator_tier: 1,
      mutation_kind: "route_change",
      expected_behavior: "Block if the workflow leaves the expected workspace route without an allowed transition.",
      risk_tags: ["route_changed"],
      generated_from: "dojo_template",
    },
    {
      title: "Mobile viewport",
      layer: "skill",
      simulator_tier: 1,
      mutation_kind: "viewport_mobile",
      expected_behavior: "Use semantic locators that survive compact layout changes.",
      risk_tags: ["viewport_variant"],
      generated_from: "dojo_template",
    },
    {
      title: "Reduced motion variant",
      layer: "skill",
      simulator_tier: 1,
      mutation_kind: "reduced_motion",
      expected_behavior: "Do not depend on animation-only timing or transient visual positions.",
      risk_tags: ["motion_variant"],
      generated_from: "dojo_template",
    },
    {
      title: "Reordered collection",
      layer: "risk",
      simulator_tier: 1,
      mutation_kind: "reordered_rows",
      expected_behavior: "Select records by stable identity rather than row order.",
      risk_tags: ["table_order"],
      generated_from: "dojo_template",
    },
    {
      title: "Hidden required field",
      layer: "knowledge",
      simulator_tier: 1,
      mutation_kind: "hidden_required_field",
      expected_behavior: "Detect the missing field and stop with a useful question instead of submitting.",
      risk_tags: ["input_validation"],
      generated_from: "dojo_template",
    },
    {
      title: "Feature flag variant",
      layer: "skill",
      simulator_tier: 1,
      mutation_kind: "feature_flag",
      expected_behavior: "Use the licensed affordance or block when a variant removes the expected path.",
      risk_tags: ["ui_variant"],
      generated_from: "dojo_template",
    },
    {
      title: "Partial API failure",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "partial_write",
      expected_behavior: "Do not accept success until durable postconditions prove that no partial failure remains.",
      risk_tags: ["partial_failure", "evidence_required"],
      generated_from: "dojo_template",
    },
    {
      title: "Permission downgraded",
      layer: "risk",
      simulator_tier: 2,
      mutation_kind: "permission_change",
      expected_behavior: "Block execution when the current role is outside the licensed context.",
      risk_tags: ["permission_change"],
      generated_from: "dojo_template",
    },
    {
      title: "Destructive action adjacent to safe action",
      layer: "risk",
      simulator_tier: 1,
      mutation_kind: "destructive_adjacency",
      expected_behavior: "Never invoke blocked destructive actions as a fallback for a missing safe affordance.",
      risk_tags: ["destructive_write"],
      generated_from: "dojo_template",
    },
  ];

  return templates.map((template, index) => ({
    scenario_id: `${seed.seed_id}_scenario_${String(index + 1).padStart(2, "0")}_${slug(template.mutation_kind)}`,
    ...template,
  }));
}

export function runDojoCheckride(
  seed: DojoSkillSeed,
  scenarios: DojoScenario[],
  contract: WorkflowContractV7,
  options: { now?: string } = {}
): DojoCheckrideReport {
  const now = options.now ?? new Date().toISOString();
  const results = scenarios.map((scenario) => evaluateScenario(seed, scenario, contract));
  const knowledge = layerTotals(results, "knowledge");
  const risk = layerTotals(results, "risk");
  const skill = layerTotals(results, "skill");
  const criticalFailures = results.filter((result) => result.critical && result.status === "failed").length;
  const blockedScenarios = results.filter((result) => result.status === "blocked").length;
  const passed = results.filter((result) => result.status === "passed").length;
  const coverageScore = scenarios.length > 0 ? Number((passed / scenarios.length).toFixed(2)) : 0;
  const entrustment = entrustmentRecommendation(contract, criticalFailures, blockedScenarios, coverageScore);
  return {
    schema_version: "synthi.dojo.checkrideReport.v1",
    checkride_id: `checkride_${shortHash(`${seed.seed_id}:${now}:${results.map((r) => `${r.scenario_id}:${r.status}`).join("|")}`)}`,
    skill_id: skillIdFor(contract),
    workflow_id: contract.workflowId,
    started_at: now,
    finished_at: now,
    knowledge,
    risk,
    skill,
    critical_failures: criticalFailures,
    blocked_scenarios: blockedScenarios,
    results,
    entrustment_recommendation: entrustment,
    readiness_level: readinessLevelFor(contract, entrustment, coverageScore),
    coverage_score: coverageScore,
    limitations: [...new Set(contract.limitations)],
  };
}

export function buildDojoSkill(
  contract: WorkflowContractV7,
  options: {
    workspace_id?: string;
    now?: string;
    private_tool_manifest?: PrivateWorkflowToolManifestV7;
    published_tool_name?: string;
  } = {}
): DojoSkill {
  const now = options.now ?? new Date().toISOString();
  const seed = extractDojoSkillSeed(contract, { workspace_id: options.workspace_id, now });
  const scenarios = generateDojoVivariumScenarios(seed);
  const checkride = runDojoCheckride(seed, scenarios, contract, { now });
  const caseLaw = caseLawFor(checkride, contract, now);
  const guardrails = guardrailsFor(contract, caseLaw);
  const license = licenseFor(contract, checkride, guardrails, now);
  const assuranceCase = assuranceCaseFor(contract, checkride, license, caseLaw);
  const skillId = skillIdFor(contract);
  const skillVersion = "1.0.0";
  const appModelVersion = appModelVersionFor(contract);
  const substrates = executionSubstratesFor(contract, options.private_tool_manifest);
  const preferredSubstrate = substrates.includes("mcp")
    ? "mcp"
    : substrates.includes("source")
    ? "source"
    : substrates.includes("dom")
    ? "dom"
    : "vision";
  const publishedTools = options.published_tool_name ? [options.published_tool_name] : [];
  const licenseExpiresAt = licenseExpiresAtFor(now, license);
  const workspaceOrganoid = workspaceOrganoidFor(skillId, seed, scenarios, license, now);
  const windTunnel = windTunnelFor(skillId, contract.workflowId, scenarios, checkride, guardrails, license, preferredSubstrate, now);
  const counterfactualTwin = counterfactualTwinFor(skillId, contract.workflowId, scenarios, checkride, preferredSubstrate, now);
  const evilTwin = evilTwinFor(skillId, contract.workflowId, scenarios, checkride, guardrails, caseLaw, now);
  const antibodies = antibodiesFor(caseLaw, guardrails, now);
  const skillCortex = skillCortexFor(
    contract,
    seed,
    skillId,
    appModelVersion,
    guardrails,
    caseLaw,
    license,
    substrates,
    preferredSubstrate,
    checkride,
    now
  );
  const skillGenome = skillGenomeFor(skillId, seed, guardrails, license, now);
  const agentReadyUiContract = agentReadyUiContractFor(contract, seed, skillId, license, substrates, preferredSubstrate, now);
  const costControlPolicy = costControlPolicyFor(skillId, scenarios, license, now);
  const trainingReport = trainingReportFor(
    skillId,
    contract.workflowId,
    windTunnel,
    checkride,
    guardrails,
    antibodies,
    evilTwin,
    license,
    now
  );

  return {
    schema_version: "synthi.dojo.skill.v1",
    skill_id: skillId,
    workspace_id: seed.workspace_id,
    workflow_id: contract.workflowId,
    skill_version: skillVersion,
    app_model_version: appModelVersion,
    workflow_graph_id: skillCortex.workflow_graph_id,
    vivarium_id: workspaceOrganoid.organoid_id,
    name: contract.name,
    intent: contract.description || contract.name,
    app_origin: contract.appOrigin,
    skill_seed: seed,
    skill_cortex: skillCortex,
    workspace_organoid: workspaceOrganoid,
    scenarios,
    wind_tunnel: windTunnel,
    counterfactual_twin: counterfactualTwin,
    evil_twin: evilTwin,
    checkride,
    case_law: caseLaw,
    antibodies,
    guardrails,
    permission_license: license,
    entrustment_level: license.entrustment_level,
    skill_readiness_level: checkride.readiness_level,
    proof_capsule_schema: proofCapsuleSchemaFor(license),
    assurance_case: assuranceCase,
    skill_card: skillCardFor(contract, checkride, guardrails, license),
    skill_passport: {
      passport_id: `passport_${shortHash(`${skillId}:${skillVersion}:${license.license_id}`)}`,
      skill_id: skillId,
      skill_version: skillVersion,
      entrustment_level: license.entrustment_level,
      readiness_level: checkride.readiness_level,
      checkride_id: checkride.checkride_id,
      license_id: license.license_id,
      assurance_case_id: assuranceCase.assurance_case_id,
      proof_required: license.proof_requirements.required_evidence_claims.length > 0,
      coverage_score: checkride.coverage_score,
      attack_success_rate: evilTwin.attack_success_rate,
      license_expires_at: licenseExpiresAt,
      published_tools: publishedTools,
      issued_at: now,
    },
    skill_genome: skillGenome,
    agent_ready_ui_contract: agentReadyUiContract,
    cost_control_policy: costControlPolicy,
    training_report: trainingReport,
    rollback_policy: rollbackPolicyFor(contract),
    evidence_policy: evidencePolicyFor(contract, license),
    source_links: seed.source_or_api_anchors,
    auth_requirements: authRequirementsFor(contract),
    data_sensitivity: dataSensitivityFor(contract),
    confidence: confidenceFor(checkride, evilTwin),
    coverage_score: checkride.coverage_score,
    attack_success_rate: evilTwin.attack_success_rate,
    false_allow_rate: evilTwin.attack_success_rate,
    false_block_rate: falseBlockRateFor(checkride),
    last_trained_at: now,
    license_expires_at: licenseExpiresAt,
    retrain_triggers: retrainTriggersFor(license),
    training_runs: windTunnel.runs,
    checkride_runs: [checkride.checkride_id],
    case_law_refs: caseLaw.map((item) => item.case_id),
    published_tools: publishedTools,
    execution_substrates: substrates,
    preferred_substrate: preferredSubstrate,
    ...(options.published_tool_name ? { published_tool_name: options.published_tool_name } : {}),
    ...(options.private_tool_manifest ? { private_tool_manifest: cloneJson(options.private_tool_manifest) } : {}),
    generated_at: now,
  };
}

export function issueDojoProofCapsule(
  skill: DojoSkill,
  requestedAction: string,
  input: {
    context_claims?: Record<string, unknown>;
    evidence_claims?: DojoEvidenceClaim[];
    evidence_ledger_records?: DojoEvidenceLedgerRecord[];
    evidence_max_age_ms?: number;
    ledger_checkpoint_hash?: string;
    require_verified_evidence?: boolean;
    tenant_id?: string;
    substrate_claim?: DojoExecutionSubstrate;
    expires_at?: string;
    now?: string;
  } = {}
): DojoProofCarryingSkillCapsule {
  const now = input.now ?? new Date().toISOString();
  const expiresAt = input.expires_at ?? new Date(Date.parse(now) + 15 * 60_000).toISOString();
  const evidence = evidenceClaimsForProofIssue(skill, input, now);
  const signer = dojoProofSigner();
  const capsuleWithoutSignature = {
    schema_version: "synthi.dojo.proofCapsule.v1" as const,
    capsule_id: `capsule_${randomUUID()}`,
    skill_id: skill.skill_id,
    skill_version: skill.skill_version,
    requested_action: requestedAction,
    license_version: skill.permission_license.license_version,
    entrustment_level: skill.entrustment_level,
    issuer: dojoProofIssuer(),
    key_id: signer.key_id,
    nonce: randomUUID(),
    context_claims: input.context_claims ?? {},
    evidence_claims: evidence.claims,
    evidence_record_ids: evidence.recordIds,
    ...(evidence.ledgerCheckpointHash ? { ledger_checkpoint_hash: evidence.ledgerCheckpointHash } : {}),
    guardrails_active: skill.guardrails.map((guardrail) => guardrail.guardrail_id),
    substrate_claim: input.substrate_claim ?? skill.preferred_substrate,
    assurance_case_ref: skill.assurance_case.assurance_case_id,
    issued_at: now,
    expires_at: expiresAt,
    signature_algorithm: signer.algorithm,
  };
  return {
    ...capsuleWithoutSignature,
    signature: signatureForCapsule(capsuleWithoutSignature, signer),
  };
}

export function validateDojoProofCapsule(
  skill: DojoSkill,
  capsule: DojoProofCarryingSkillCapsule,
  requestedAction: string,
  now: string = new Date().toISOString()
): DojoProofValidation {
  const blockedBy: string[] = [];
  const license = skill.permission_license;

  if (capsule.schema_version !== "synthi.dojo.proofCapsule.v1") blockedBy.push("proof_capsule_schema_version_mismatch");
  if (capsule.skill_id !== skill.skill_id) blockedBy.push("proof_capsule_skill_mismatch");
  if (capsule.skill_version !== skill.skill_version) blockedBy.push("proof_capsule_skill_version_mismatch");
  if (capsule.license_version !== license.license_version) blockedBy.push("proof_capsule_license_version_mismatch");
  if (capsule.requested_action !== requestedAction) blockedBy.push("proof_capsule_action_mismatch");
  if (capsule.issuer !== dojoProofIssuer()) blockedBy.push("proof_capsule_issuer_mismatch");
  if (capsule.key_id !== dojoProofKeyId()) blockedBy.push("proof_capsule_key_mismatch");
  if (capsule.signature_algorithm !== "hmac-sha256" && capsule.signature_algorithm !== "ed25519") {
    blockedBy.push("proof_capsule_signature_algorithm_mismatch");
  }
  if (!capsule.nonce) blockedBy.push("proof_capsule_nonce_missing");
  if (Date.parse(capsule.expires_at) <= Date.parse(now)) blockedBy.push("proof_capsule_expired");
  if (!verifyCapsuleSignature(capsule)) blockedBy.push("proof_capsule_signature_invalid");

  const blockedAction = license.blocked_actions.find((action) => action.action === requestedAction);
  if (blockedAction) blockedBy.push(`blocked_action:${blockedAction.action}`);

  const allowedAction = license.allowed_actions.find((action) => action.action === requestedAction);
  const gatedAction = license.gated_actions.find((action) => action.action === requestedAction);
  if (!allowedAction && !gatedAction) blockedBy.push(`action_not_licensed:${requestedAction}`);

  for (const claim of license.proof_requirements.required_context_claims) {
    if (capsule.context_claims[claim] !== true) blockedBy.push(`missing_context_claim:${claim}`);
  }
  const satisfiedEvidence = new Set(
    capsule.evidence_claims
      .filter((claim) => claim.satisfied)
      .map((claim) => claim.claim)
  );
  for (const claim of license.proof_requirements.required_evidence_claims) {
    if (!satisfiedEvidence.has(claim)) blockedBy.push(`missing_evidence_claim:${claim}`);
  }
  for (const guardrail of license.proof_requirements.required_guardrails) {
    if (!capsule.guardrails_active.includes(guardrail)) blockedBy.push(`guardrail_not_active:${guardrail}`);
  }

  const substrateRequirement = license.substrate_requirements.find((requirement) => requirement.action === requestedAction);
  if (substrateRequirement && !substrateRequirement.allowed_substrates.includes(capsule.substrate_claim)) {
    blockedBy.push(`substrate_not_allowed:${capsule.substrate_claim}`);
  }

  if (blockedBy.length > 0) {
    return {
      ok: false,
      status: "blocked",
      error: "dojo_proof_capsule_invalid",
      blocked_by: blockedBy,
      error_codes: normalizeDojoProofErrorCodes(blockedBy),
      license: licenseSummary(license),
    };
  }

  if (gatedAction) {
    return {
      ok: false,
      status: "approval_required",
      error: "dojo_action_requires_approval",
      blocked_by: gatedAction.constraints,
      error_codes: ["approval_required"],
      license: licenseSummary(license),
    };
  }

  return {
    ok: true,
    status: "allowed",
    blocked_by: [],
    error_codes: [],
    license: licenseSummary(license),
  };
}

export function exportDojoRepoArtifacts(skill: DojoSkill): DojoRepoArtifact[] {
  const root = `.synthi/dojo/skills/${skillPathSegment(skill)}`;
  const segment = skillPathSegment(skill);
  const caseArtifacts = skill.case_law.map((item): DojoRepoArtifact => ({
    path: `.synthi/dojo/cases/${segment}.${slug(item.case_id)}.case.md`,
    content_type: "text/markdown",
    sensitive: false,
    content: caseLawItemMarkdown(skill, item),
  }));
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  return [
    {
      path: `${root}/seed.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.skill_seed),
    },
    {
      path: `${root}/skill.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(redactedSkillArtifact(skill)),
    },
    {
      path: `${root}/skill.graph.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skillGraphArtifact(skill)),
    },
    {
      path: `${root}/vivarium.manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(vivariumArtifact(skill)),
    },
    {
      path: `${root}/wind-tunnel.report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.wind_tunnel),
    },
    {
      path: `${root}/counterfactual-twin.report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.counterfactual_twin),
    },
    {
      path: `${root}/evil-twin.report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.evil_twin),
    },
    {
      path: `${root}/checkride.report.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: checkrideMarkdown(skill),
    },
    {
      path: `${root}/assurance.case.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: assuranceMarkdown(skill),
    },
    {
      path: `${root}/license.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.permission_license),
    },
    {
      path: `${root}/proof-capsule.schema.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.proof_capsule_schema),
    },
    {
      path: `${root}/guardrails.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.guardrails),
    },
    {
      path: `${root}/antibodies.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.antibodies),
    },
    {
      path: `${root}/case-law.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: caseLawMarkdown(skill),
    },
    {
      path: `${root}/skill-passport.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.skill_passport),
    },
    {
      path: `${root}/skill-genome.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.skill_genome),
    },
    {
      path: `${root}/agent-ready-ui-contract.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.agent_ready_ui_contract),
    },
    {
      path: `${root}/cost-control.policy.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.cost_control_policy),
    },
    {
      path: `${root}/training-report.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: trainingReportMarkdown(skill),
    },
    {
      path: `${root}/training-report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.training_report),
    },
    {
      path: `${root}/universe.dossier.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoUniverseDossier(skill, [skill])),
    },
    {
      path: `${root}/lifecycle.report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoLifecycleReport(skill)),
    },
    {
      path: `${root}/governance.report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoGovernanceReport(skill)),
    },
    {
      path: `${root}/source-affordance-pr-plan.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoSourceAffordancePrPlan(skill)),
    },
    {
      path: `${root}/metrics.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoUniverseMetrics([skill])),
    },
    {
      path: `${root}/evidence-ledger.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoEvidenceLedger(skill)),
    },
    {
      path: `${root}/time-machine-debugger.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(runDojoTimeMachineDebugger(skill)),
    },
    {
      path: `${root}/evidence-manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(evidenceManifestFor(skill)),
    },
    {
      path: `${root}/playwright.spec.ts`,
      content_type: "text/typescript",
      sensitive: false,
      content: playwrightSpecFor(skill),
    },
    {
      path: `${root}/mcp.manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoMcpSkillManifest(skill)),
    },
    {
      path: `.synthi/dojo/workflows/${segment}.graph.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skillGraphArtifact(skill)),
    },
    {
      path: `.synthi/dojo/organoids/${segment}.organoid.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(vivariumArtifact(skill)),
    },
    {
      path: `.synthi/dojo/guardrails/${segment}.guardrails.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.guardrails),
    },
    {
      path: `.synthi/dojo/licenses/${segment}.license.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.permission_license),
    },
    {
      path: `.synthi/dojo/antibodies/${segment}.antibodies.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.antibodies),
    },
    ...caseArtifacts,
    {
      path: `.synthi/dojo/reports/${segment}.training-report.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: trainingReportMarkdown(skill),
    },
    {
      path: `.synthi/dojo/evidence/${segment}.redacted-evidence-manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(redactedEvidenceExportManifestFor(skill)),
    },
    {
      path: `.synthi/dojo/evidence/${segment}.ledger.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoEvidenceLedger(skill)),
    },
    {
      path: `.synthi/dojo/governance/${segment}.governance-report.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoGovernanceReport(skill)),
    },
    {
      path: `.synthi/dojo/source/${segment}.affordance-pr-plan.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoSourceAffordancePrPlan(skill)),
    },
    {
      path: `.synthi/dojo/registry/${segment}.universe-dossier.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoUniverseDossier(skill, [skill])),
    },
    {
      path: `.synthi/dojo/registry/organization-registry.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoOrganizationRegistry([skill])),
    },
    {
      path: `.synthi/dojo/playwright/${segment}.spec.ts`,
      content_type: "text/typescript",
      sensitive: false,
      content: playwrightSpecFor(skill),
    },
    {
      path: `.synthi/dojo/mcp/${segment}.manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(buildDojoMcpSkillManifest(skill)),
    },
  ];
}

function evaluateScenario(
  seed: DojoSkillSeed,
  scenario: DojoScenario,
  contract: WorkflowContractV7
): DojoScenarioResult {
  const evidenceRefs = [`workflow:${contract.workflowId}`, `scenario:${scenario.scenario_id}`];
  const hasMutation = contract.mutationBoundaryPlan.mutationSteps.length > 0;
  const hasStableIdentity = seed.input_schema.some((input) => isStableIdentifier(input.name))
    || seed.involved_entities.some((entity) => isStableIdentifier(entity.entity_id));
  const sourceLinked = contract.sourceIdentityCoverage.status !== "missing";
  const hasSuccessAssertion = seed.candidate_success_assertions.length > 0;
  const hasDurableEvidence = seed.output_schema.evidence.some((evidence) => /request|api|source|assert|postcondition/i.test(evidence));

  if (scenario.mutation_kind === "baseline") {
    const passed = contract.steps.length > 0 && hasSuccessAssertion;
    return scenarioResult(scenario, passed ? "passed" : "failed", !passed && hasMutation, passed
      ? "Demonstrated path has actions and success assertions."
      : "The demonstrated path lacks enough action or success assertion evidence.", evidenceRefs);
  }

  if (scenario.mutation_kind === "input_omission" || scenario.mutation_kind === "hidden_required_field") {
    const passed = seed.input_schema.length === 0 || seed.input_schema.every((input) => input.required);
    return scenarioResult(scenario, passed ? "passed" : "failed", hasMutation, passed
      ? "Required inputs are explicit in the skill seed."
      : "One or more inferred inputs are not explicitly required.", evidenceRefs, "Require explicit input validation before licensed execution.");
  }

  if (scenario.mutation_kind === "duplicate_entity" || scenario.mutation_kind === "stale_entity" || scenario.mutation_kind === "reordered_rows") {
    const passed = hasStableIdentity;
    return scenarioResult(scenario, passed ? "passed" : "failed", hasMutation, passed
      ? "A stable identifier is available for entity-sensitive action."
      : "The skill could select the wrong entity when labels or row order are ambiguous.", evidenceRefs, "Require stable entity id verification before action.");
  }

  if (scenario.mutation_kind === "label_change" || scenario.mutation_kind === "duplicate_label" || scenario.mutation_kind === "feature_flag") {
    const passed = sourceLinked || contract.steps.every((step) => step.locatorPlan.confidence === "high");
    return scenarioResult(scenario, passed ? "passed" : "failed", false, passed
      ? "The workflow has source identity or high-confidence semantic locators."
      : "The workflow still depends on weak or ambiguous UI targets.", evidenceRefs, "Require source-backed affordances for ambiguous targets.");
  }

  if (scenario.mutation_kind === "hydration_delay" || scenario.mutation_kind === "network_latency") {
    const passed = contract.failureClasses.includes("hydrationDelay") || contract.failureClasses.includes("networkFailure") || contract.steps.length > 0;
    return scenarioResult(scenario, passed ? "passed" : "blocked", false, passed
      ? "Replay planning includes timing/failure classification."
      : "No replay timing evidence is available.", evidenceRefs);
  }

  if (scenario.mutation_kind === "fake_success" || scenario.mutation_kind === "partial_write") {
    const passed = !hasMutation || hasDurableEvidence;
    return scenarioResult(scenario, passed ? "passed" : "failed", hasMutation, passed
      ? "Success is backed by durable evidence or the workflow is read-only."
      : "A mutating workflow needs durable postcondition evidence beyond visible success.", evidenceRefs, "Require durable postcondition evidence before accepting success.");
  }

  if (scenario.mutation_kind === "validation_error") {
    const passed = contract.failureClasses.includes("appValidationError") || hasSuccessAssertion;
    return scenarioResult(scenario, passed ? "passed" : "failed", hasMutation, passed
      ? "Validation failure is represented in the workflow contract."
      : "Validation failure handling is not explicit.", evidenceRefs, "Block repeated submit after visible validation failure.");
  }

  if (scenario.mutation_kind === "auth_expiry") {
    const passed = !contract.authPlan.required || contract.authPlan.durability === "refreshProvider" || contract.authPlan.durability === "ciTestAuth";
    return scenarioResult(scenario, passed ? "passed" : "blocked", contract.authPlan.required, passed
      ? "Auth is either not required or has unattended durability."
      : "Auth-required workflow lacks unattended auth durability.", evidenceRefs, "Require active auth checkpoint or refresh provider.");
  }

  if (scenario.mutation_kind === "route_change") {
    const passed = Boolean(contract.routePattern || contract.appOrigin);
    return scenarioResult(scenario, passed ? "passed" : "blocked", false, passed
      ? "The contract scopes execution to an application origin or route."
      : "The contract lacks a route or origin scope.", evidenceRefs);
  }

  if (scenario.mutation_kind === "permission_change" || scenario.mutation_kind === "destructive_adjacency") {
    const passed = !hasMutation || contract.publishPlan.mutationMode !== "readOnly";
    return scenarioResult(scenario, passed ? "passed" : "failed", hasMutation, passed
      ? "Mutation-sensitive execution is isolated, gated, or confirm-before-commit."
      : "Mutation-sensitive execution lacks an explicit gate.", evidenceRefs, "Route risky actions through license and approval gates.");
  }

  return scenarioResult(scenario, "passed", false, "No blocking static risk was detected for this scenario.", evidenceRefs);
}

function scenarioResult(
  scenario: DojoScenario,
  status: DojoCheckrideStatus,
  critical: boolean,
  finding: string,
  evidenceRefs: string[],
  guardrailSuggestion?: string
): DojoScenarioResult {
  return {
    scenario_id: scenario.scenario_id,
    layer: scenario.layer,
    status,
    critical,
    finding,
    ...(guardrailSuggestion ? { guardrail_suggestion: guardrailSuggestion } : {}),
    evidence_refs: evidenceRefs,
  };
}

function layerTotals(results: DojoScenarioResult[], layer: DojoCheckrideLayer): { passed: number; total: number } {
  const layerResults = results.filter((result) => result.layer === layer);
  return {
    passed: layerResults.filter((result) => result.status === "passed").length,
    total: layerResults.length,
  };
}

function entrustmentRecommendation(
  contract: WorkflowContractV7,
  criticalFailures: number,
  blockedScenarios: number,
  coverageScore: number
): DojoEntrustmentLevel {
  if (contract.steps.length === 0) return "E0";
  if (criticalFailures > 0) return contract.mutationBoundaryPlan.mutationSteps.length > 0 ? "E2" : "E1";
  if (blockedScenarios > 0) return "E2";
  if (coverageScore < 0.7) return "E2";
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) return contract.publishPlan.mutationMode === "ciOnly" ? "E3" : "E2";
  if (contract.sourceIdentityCoverage.status === "complete") return "E4";
  return "E3";
}

function readinessLevelFor(
  contract: WorkflowContractV7,
  entrustment: DojoEntrustmentLevel,
  coverageScore: number
): DojoSkillReadinessLevel {
  if (contract.steps.length === 0) return 0;
  if (entrustment === "E0") return 1;
  if (entrustment === "E1") return 4;
  if (entrustment === "E2") return coverageScore >= 0.7 ? 5 : 4;
  if (entrustment === "E3") return 7;
  if (entrustment === "E4") return 8;
  if (entrustment === "E5") return 9;
  return 0;
}

function caseLawFor(checkride: DojoCheckrideReport, contract: WorkflowContractV7, now: string): DojoSkillCase[] {
  return checkride.results
    .filter((result) => result.status !== "passed")
    .map((result, index) => {
      const scenarioKind = result.scenario_id.split("_").slice(-1)[0] ?? "scenario";
      const rule = result.guardrail_suggestion ?? `Block or ask for review when ${scenarioKind} invalidates the demonstrated workflow.`;
      return {
        case_id: `case_${shortHash(`${checkride.checkride_id}:${result.scenario_id}`)}`,
        title: titleCase(scenarioKind.replace(/-/g, " ")),
        date: now.slice(0, 10),
        source_skill_id: skillIdFor(contract),
        source_run_id: checkride.checkride_id,
        finding: result.finding,
        impact: result.critical ? "Could cause an unsafe or wrong production action." : "Could make replay unreliable or ambiguous.",
        rule_created: rule,
        applies_to: [...new Set(["workflow", ...contract.steps.map((step) => step.action.kind)])],
        binding_scope: "skill",
        status: result.critical || result.guardrail_suggestion ? "binding" : "proposed",
        evidence_refs: result.evidence_refs,
      };
    });
}

function guardrailsFor(contract: WorkflowContractV7, cases: DojoSkillCase[]): DojoGuardrail[] {
  const fromCases = cases
    .filter((item) => item.status === "binding")
    .map((item): DojoGuardrail => ({
      guardrail_id: `guard_${shortHash(item.case_id)}`,
      title: item.title,
      rule: item.rule_created,
      blocks_actions: ["run_workflow", ...mutationActionNames(contract)],
      source_case_id: item.case_id,
      severity: item.impact.includes("unsafe") || item.impact.includes("wrong") ? "high" : "medium",
    }));
  const limitationGuards = contract.limitations.map((limitation): DojoGuardrail => ({
    guardrail_id: `guard_${slug(limitation)}`,
    title: titleCase(limitation),
    rule: limitationGuardrailRule(limitation),
    blocks_actions: limitation === "mutationRequiresIsolation" ? ["run_workflow"] : ["publish_unattended_tool"],
    severity: limitation === "mutationRequiresIsolation" ? "high" : "medium",
  }));
  return dedupeBy([...fromCases, ...limitationGuards], (guardrail) => guardrail.guardrail_id);
}

function licenseFor(
  contract: WorkflowContractV7,
  checkride: DojoCheckrideReport,
  guardrails: DojoGuardrail[],
  now: string
): DojoPermissionLicense {
  const entrustment = checkride.entrustment_recommendation;
  const allowed: DojoLicenseAction[] = [{ action: "observe", constraints: ["exact_origin_consent_required"] }];
  const gated: DojoLicenseAction[] = [];
  const blocked: DojoLicenseAction[] = [];

  if (entrustment !== "E0") {
    allowed.push({ action: "practice_vivarium", constraints: ["synthetic_data_only"] });
  }
  if (entrustment === "E2" || entrustment === "E3" || entrustment === "E4" || entrustment === "E5") {
    allowed.push({ action: "run_prefix_validation", constraints: ["no_mutation_execution"] });
  }
  if (entrustment === "E3" || entrustment === "E4" || entrustment === "E5") {
    allowed.push({
      action: "run_workflow",
      constraints: ["proof_capsule_valid", "guardrails_active", "licensed_context_only"],
    });
  } else {
    blocked.push({
      action: "run_workflow",
      constraints: ["checkride_or_license_scope_not_sufficient"],
    });
  }

  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) {
    gated.push({
      action: "commit_mutation",
      constraints: contract.publishPlan.mutationMode === "ciOnly"
        ? ["ci_isolated_replay_required"]
        : ["human_confirmation_required", "ci_isolated_replay_recommended"],
    });
  }

  blocked.push(
    { action: "delete", constraints: ["destructive_action_not_licensed_by_teach_trace"] },
    { action: "payment", constraints: ["financial_side_effect_not_inferred_from_workflow"] },
    { action: "permission_change", constraints: ["identity_or_access_control_change_not_licensed"] }
  );

  return {
    schema_version: "synthi.dojo.permissionLicense.v1",
    license_id: `license_${shortHash(`${contract.workflowId}:${checkride.checkride_id}:${entrustment}`)}`,
    skill_id: skillIdFor(contract),
    license_version: "1.0.0",
    entrustment_level: entrustment,
    autonomy_level: autonomyLevelFor(entrustment),
    allowed_actions: allowed,
    gated_actions: gated,
    blocked_actions: blocked,
    evidence_requirements: [
      { claim: "checkride_passed", required: true },
      { claim: "success_assertions_defined", required: true },
      { claim: "guardrails_active", required: true },
    ],
    approval_requirements: gated.map((action) => action.action),
    substrate_requirements: [
      {
        action: "run_workflow",
        allowed_substrates: contract.publishPlan.unattendedReady ? ["mcp", "api", "dom"] : ["mcp", "dom"],
      },
    ],
    proof_requirements: {
      required_context_claims: ["workspace_verified"],
      required_evidence_claims: ["checkride_passed", "success_assertions_defined", "guardrails_active"],
      required_guardrails: guardrails.map((guardrail) => guardrail.guardrail_id),
    },
    expiry_policy: {
      expires_on: ["app_release", "policy_change", "incident", "evidence_stale"],
      recertify_after_days: 30,
    },
    issued_at: now,
  };
}

function assuranceCaseFor(
  contract: WorkflowContractV7,
  checkride: DojoCheckrideReport,
  license: DojoPermissionLicense,
  cases: DojoSkillCase[]
): DojoAssuranceCase {
  const evidenceRefs = [
    `workflow:${contract.workflowId}`,
    `checkride:${checkride.checkride_id}`,
    `license:${license.license_id}`,
    ...cases.map((item) => `case:${item.case_id}`),
  ];
  return {
    schema_version: "synthi.dojo.assuranceCase.v1",
    assurance_case_id: `assurance_${shortHash(`${contract.workflowId}:${checkride.checkride_id}`)}`,
    skill_id: skillIdFor(contract),
    claim: `This skill is licensed at ${license.entrustment_level} for ${contract.name} under tested workspace conditions.`,
    context: `${contract.appOrigin || "unknown origin"}; workflow ${contract.workflowId}; ${contract.steps.length} taught step(s).`,
    argument: `The skill seed produced ${checkride.results.length} synthetic scenarios. Checkride result: knowledge ${checkride.knowledge.passed}/${checkride.knowledge.total}, risk ${checkride.risk.passed}/${checkride.risk.total}, skill ${checkride.skill.passed}/${checkride.skill.total}, critical failures ${checkride.critical_failures}.`,
    evidence_refs: evidenceRefs,
    limits: [...new Set([...contract.limitations, ...license.blocked_actions.map((action) => action.action)])],
    expiration: license.expiry_policy.expires_on,
  };
}

function skillCardFor(
  contract: WorkflowContractV7,
  checkride: DojoCheckrideReport,
  guardrails: DojoGuardrail[],
  license: DojoPermissionLicense
): DojoSkillCard {
  return {
    title: contract.name,
    status: `Licensed ${license.entrustment_level}`,
    can_do_alone: license.allowed_actions.map((action) => action.action),
    will_ask_before: license.gated_actions.map((action) => action.action),
    will_not_do: license.blocked_actions.map((action) => action.action),
    practiced: `${checkride.results.length} synthetic cases`,
    found_and_fixed: `${guardrails.length} guardrail${guardrails.length === 1 ? "" : "s"}`,
    proof_badge: license.proof_requirements.required_evidence_claims.length > 0 ? "Proof required" : "Proof optional",
  };
}

function proofCapsuleSchemaFor(license: DojoPermissionLicense): Record<string, unknown> {
  return {
    type: "object",
    required: [
      "schema_version",
      "skill_id",
      "skill_version",
      "requested_action",
      "license_version",
      "entrustment_level",
      "context_claims",
      "evidence_claims",
      "guardrails_active",
      "substrate_claim",
      "assurance_case_ref",
      "issued_at",
      "expires_at",
      "signature",
    ],
    properties: {
      schema_version: { const: "synthi.dojo.proofCapsule.v1" },
      skill_id: { const: license.skill_id },
      license_version: { const: license.license_version },
      requested_action: { type: "string" },
      context_claims: {
        type: "object",
        required: license.proof_requirements.required_context_claims,
      },
      evidence_claims: {
        type: "array",
        items: {
          type: "object",
          required: ["claim", "satisfied"],
          properties: {
            claim: { type: "string" },
            satisfied: { type: "boolean" },
          },
        },
      },
      guardrails_active: {
        type: "array",
        items: { type: "string" },
      },
      signature: { type: "string" },
    },
  };
}

function appModelVersionFor(contract: WorkflowContractV7): string {
  const sourceShape = {
    appOrigin: contract.appOrigin,
    routePattern: contract.routePattern ?? null,
    sourceStatus: contract.sourceIdentityCoverage.status,
    stepShape: contract.steps.map((step) => ({
      action: step.action.kind,
      surface: step.surfacePlan.kind,
      replay: step.surfacePlan.replay,
      source: step.sourcePlan.status,
      locator: step.locatorPlan.confidence,
    })),
  };
  return `app_model_${shortHash(stableStringify(sourceShape))}`;
}

function licenseExpiresAtFor(now: string, license: DojoPermissionLicense): string {
  const started = Date.parse(now);
  const base = Number.isFinite(started) ? started : Date.now();
  return new Date(base + license.expiry_policy.recertify_after_days * 24 * 60 * 60 * 1000).toISOString();
}

function workspaceOrganoidFor(
  skillId: string,
  seed: DojoSkillSeed,
  scenarios: DojoScenario[],
  license: DojoPermissionLicense,
  now: string
): DojoWorkspaceOrganoid {
  return {
    schema_version: "synthi.dojo.workspaceOrganoid.v1",
    organoid_id: `organoid_${seed.seed_id}`,
    skill_id: skillId,
    skill_seed_id: seed.seed_id,
    workspace_id: seed.workspace_id,
    generated_at: now,
    version: "0.1.0",
    tissues: {
      ui: { surfaces: seed.touched_surfaces, affordance_count: seed.source_or_api_anchors.filter((anchor) => anchor.kind === "ui").length },
      data: { models: seed.touched_data_models, inputs: seed.input_schema.map(redactedInputField) },
      policy: { clues: seed.policy_clues, license_actions: license.allowed_actions.map((action) => action.action) },
      identity: { auth_required: seed.policy_clues.some((clue) => clue.source === "auth"), workspace_id: seed.workspace_id },
      document: { synthetic_only: true, generated_documents: [] },
      api: { anchors: seed.source_or_api_anchors.filter((anchor) => anchor.kind === "api") },
      failure: { modes: seed.candidate_failure_modes },
      adversary: {
        scenarios: scenarios.filter((scenario) => scenario.layer === "risk").map((scenario) => scenario.scenario_id),
        mutation_kinds: [...new Set(scenarios.filter((scenario) => scenario.layer === "risk").map((scenario) => scenario.mutation_kind))],
      },
      evidence: { expected: seed.output_schema.evidence, assertions: seed.candidate_success_assertions.map((assertion) => assertion.assertion_id) },
      source: { anchors: seed.source_or_api_anchors },
      license: { license_id: license.license_id, entrustment_level: license.entrustment_level },
    },
    scenario_refs: scenarios.map((scenario) => scenario.scenario_id),
    safety_constraints: ["synthetic_data_only", "no_secrets_in_repo_artifacts", "no_production_mutation"],
    data_policy: { production_data_allowed: false, redact_screenshots_by_default: true, synthetic_data_only: true },
  };
}

function windTunnelFor(
  skillId: string,
  workflowId: string,
  scenarios: DojoScenario[],
  checkride: DojoCheckrideReport,
  guardrails: DojoGuardrail[],
  license: DojoPermissionLicense,
  preferredSubstrate: DojoExecutionSubstrate,
  now: string
): DojoWindTunnelReport {
  const resultByScenario = new Map(checkride.results.map((result) => [result.scenario_id, result]));
  const runs = scenarios.map((scenario) => {
    const result = resultByScenario.get(scenario.scenario_id);
    const status = result?.status ?? "blocked";
    const licenseCheck = licenseCheckFor(license, "practice_vivarium");
    return {
      run_id: `run_${shortHash(`${skillId}:${scenario.scenario_id}:${status}`)}`,
      skill_id: skillId,
      workflow_id: workflowId,
      scenario_id: scenario.scenario_id,
      mode: "vivarium" as const,
      simulator_tier: scenario.simulator_tier,
      substrate: preferredSubstrate,
      status,
      started_at: now,
      finished_at: now,
      finding: result?.finding ?? "Scenario was generated but not evaluated.",
      guardrails_triggered: guardrailRefsForResult(result, guardrails),
      license_checks: [licenseCheck],
      cost: costForScenario(scenario, 0),
      evidence_refs: result?.evidence_refs ?? [`scenario:${scenario.scenario_id}`],
    };
  });
  const passed = runs.filter((run) => run.status === "passed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const blocked = runs.filter((run) => run.status === "blocked").length;
  return {
    schema_version: "synthi.dojo.windTunnelReport.v1",
    wind_tunnel_id: `wind_${shortHash(`${skillId}:${checkride.checkride_id}`)}`,
    skill_id: skillId,
    workflow_id: workflowId,
    generated_at: now,
    scenario_count: scenarios.length,
    run_count: runs.length,
    runs,
    summary: {
      passed,
      failed,
      blocked,
      cheapest_sufficient_tier: cheapestSufficientTier(scenarios, checkride),
      stop_reason: checkride.critical_failures > 0 ? "critical_failure_hardened_by_guardrail" : "budget_complete",
    },
  };
}

function counterfactualTwinFor(
  skillId: string,
  workflowId: string,
  scenarios: DojoScenario[],
  checkride: DojoCheckrideReport,
  preferredSubstrate: DojoExecutionSubstrate,
  now: string
): DojoCounterfactualTwinReport {
  const resultByScenario = new Map(checkride.results.map((result) => [result.scenario_id, result]));
  const variants = scenarios
    .filter((scenario) => scenario.mutation_kind !== "baseline")
    .map((scenario) => {
      const result = resultByScenario.get(scenario.scenario_id);
      return {
        variant_id: `variant_${shortHash(`${skillId}:${scenario.scenario_id}:${scenario.mutation_kind}`)}`,
        scenario_id: scenario.scenario_id,
        mutation_kind: scenario.mutation_kind,
        cheapest_sufficient_tier: scenario.simulator_tier,
        expected_behavior: scenario.expected_behavior,
        observed_behavior: result?.finding ?? "No observation was recorded for this variant.",
        outcome: result?.status ?? "blocked",
        reason: tierReason(scenario.simulator_tier, scenario.mutation_kind),
      };
    });
  return {
    schema_version: "synthi.dojo.counterfactualTwinReport.v1",
    twin_id: `twin_${shortHash(`${skillId}:${workflowId}:${variants.length}`)}`,
    skill_id: skillId,
    workflow_id: workflowId,
    generated_at: now,
    variants,
    recommended_substrate: preferredSubstrate,
    promoted_scenarios: variants
      .filter((variant) => variant.outcome !== "passed")
      .map((variant) => variant.scenario_id),
  };
}

function evilTwinFor(
  skillId: string,
  workflowId: string,
  scenarios: DojoScenario[],
  checkride: DojoCheckrideReport,
  guardrails: DojoGuardrail[],
  cases: DojoSkillCase[],
  now: string
): DojoEvilTwinReport {
  const resultByScenario = new Map(checkride.results.map((result) => [result.scenario_id, result]));
  const attacks = scenarios
    .filter((scenario) => scenario.layer === "risk")
    .map((scenario) => {
      const result = resultByScenario.get(scenario.scenario_id);
      const guardrailRefs = guardrailRefsForResult(result, guardrails);
      const caseRefs = cases
        .filter((item) => result?.evidence_refs.some((ref) => item.evidence_refs.includes(ref)))
        .map((item) => item.case_id);
      const status = result?.status === "blocked"
        ? "blocked" as const
        : result?.status === "failed" && guardrailRefs.length === 0
        ? "escaped" as const
        : "caught" as const;
      return {
        attack_id: `attack_${shortHash(`${skillId}:${scenario.scenario_id}:${scenario.mutation_kind}`)}`,
        scenario_id: scenario.scenario_id,
        mutation_kind: scenario.mutation_kind,
        strategy: attackStrategyFor(scenario),
        expected_refusal: scenario.expected_behavior,
        status,
        finding: result?.finding ?? "No result was recorded for this adversarial scenario.",
        guardrail_refs: guardrailRefs,
        case_refs: caseRefs,
      };
    });
  const escaped = attacks.filter((attack) => attack.status === "escaped").length;
  return {
    schema_version: "synthi.dojo.evilTwinReport.v1",
    red_team_id: `evil_${shortHash(`${skillId}:${workflowId}:${attacks.length}`)}`,
    skill_id: skillId,
    workflow_id: workflowId,
    generated_at: now,
    attacks,
    attack_success_rate: attacks.length > 0 ? Number((escaped / attacks.length).toFixed(2)) : 0,
    hardened_by: [...new Set(attacks.flatMap((attack) => [...attack.guardrail_refs, ...attack.case_refs]))],
  };
}

function antibodiesFor(cases: DojoSkillCase[], guardrails: DojoGuardrail[], now: string): DojoAntibody[] {
  return cases.map((item) => {
    const guardrail = guardrails.find((candidate) => candidate.source_case_id === item.case_id);
    const guardrailId = guardrail?.guardrail_id ?? `guard_${shortHash(item.case_id)}`;
    return {
      antibody_id: `antibody_${shortHash(`${item.case_id}:${guardrailId}`)}`,
      case_id: item.case_id,
      guardrail_id: guardrailId,
      trigger: item.finding,
      response: guardrail?.rule ?? item.rule_created,
      applies_to: item.applies_to,
      binding_scope: item.binding_scope,
      evidence_refs: item.evidence_refs,
      created_at: now,
    };
  });
}

function skillCortexFor(
  contract: WorkflowContractV7,
  seed: DojoSkillSeed,
  skillId: string,
  appModelVersion: string,
  guardrails: DojoGuardrail[],
  cases: DojoSkillCase[],
  license: DojoPermissionLicense,
  substrates: DojoExecutionSubstrate[],
  preferredSubstrate: DojoExecutionSubstrate,
  checkride: DojoCheckrideReport,
  now: string
): DojoSkillCortex {
  const workflowGraphId = `graph_${shortHash(`${skillId}:${appModelVersion}:${checkride.checkride_id}`)}`;
  const nodes: DojoWorkflowNode[] = [];
  const edges: DojoWorkflowEdge[] = [];
  const addNode = (node: Omit<DojoWorkflowNode, "memory"> & { memory?: Partial<DojoNodeMemory> }) => {
    nodes.push({
      ...node,
      memory: nodeMemoryFor(checkride, node.memory),
    });
  };
  const addEdge = (from: string, to: string, condition = "default", learnedFrom: string[] = [`workflow:${contract.workflowId}`], confidence = checkride.coverage_score) => {
    edges.push({
      edge_id: `edge_${shortHash(`${workflowGraphId}:${from}:${to}:${condition}`)}`,
      from_node_id: from,
      to_node_id: to,
      condition,
      learned_from: learnedFrom,
      confidence: Number(confidence.toFixed(2)),
    });
  };

  addNode({
    node_id: "trigger",
    kind: "Trigger",
    label: "MCP skill call",
    substrate: "mcp",
    guardrail_refs: [],
    case_refs: [],
    inputs: [],
    outputs: ["input"],
    metadata: { published_actions: license.allowed_actions.map((action) => action.action) },
  });
  addNode({
    node_id: "input",
    kind: "Input",
    label: "Validate input schema",
    guardrail_refs: [],
    case_refs: [],
    inputs: seed.input_schema.map((input) => input.name),
    outputs: ["permission"],
    metadata: { fields: seed.input_schema.map(redactedInputField) },
  });
  addNode({
    node_id: "permission",
    kind: "Permission",
    label: license.entrustment_level,
    guardrail_refs: guardrails.map((guardrail) => guardrail.guardrail_id),
    case_refs: cases.map((item) => item.case_id),
    inputs: ["input"],
    outputs: ["proof"],
    metadata: { autonomy_level: license.autonomy_level, license_id: license.license_id },
  });
  addNode({
    node_id: "proof",
    kind: "Proof",
    label: "Validate proof capsule",
    guardrail_refs: guardrails.map((guardrail) => guardrail.guardrail_id),
    case_refs: cases.map((item) => item.case_id),
    inputs: license.proof_requirements.required_context_claims,
    outputs: ["observe"],
    metadata: { evidence_claims: license.proof_requirements.required_evidence_claims },
  });

  guardrails.forEach((guardrail) => addNode({
    node_id: guardrail.guardrail_id,
    kind: "Guardrail",
    label: guardrail.title,
    guardrail_refs: [guardrail.guardrail_id],
    case_refs: guardrail.source_case_id ? [guardrail.source_case_id] : [],
    inputs: ["permission"],
    outputs: ["proof"],
    metadata: { rule: guardrail.rule, severity: guardrail.severity, blocks_actions: guardrail.blocks_actions },
    memory: { failures_seen: guardrail.source_case_id ? [guardrail.source_case_id] : [] },
  }));
  cases.forEach((item) => addNode({
    node_id: item.case_id,
    kind: "CaseLaw",
    label: item.title,
    guardrail_refs: guardrails.filter((guardrail) => guardrail.source_case_id === item.case_id).map((guardrail) => guardrail.guardrail_id),
    case_refs: [item.case_id],
    inputs: item.evidence_refs,
    outputs: ["permission"],
    metadata: { finding: item.finding, rule_created: item.rule_created, status: item.status },
    memory: { failures_seen: [item.case_id] },
  }));

  const stepNodeIds: string[] = [];
  for (const step of contract.steps) {
    const observeId = `observe_${step.stepId}`;
    const locateId = `locate_${step.stepId}`;
    const actionId = `action_${step.stepId}`;
    const assertionId = `assert_${step.stepId}`;
    const stepCaseRefs = cases
      .filter((item) => item.applies_to.includes(step.action.kind))
      .map((item) => item.case_id);
    const stepGuardrailRefs = guardrails
      .filter((guardrail) => guardrail.blocks_actions.includes(`mutation:${step.mutation?.kind}:${step.stepId}`) || guardrail.blocks_actions.includes("run_workflow"))
      .map((guardrail) => guardrail.guardrail_id);
    addNode({
      node_id: observeId,
      kind: "Observe",
      label: `Observe before ${step.label}`,
      source_step_id: step.stepId,
      substrate: preferredSubstrate,
      guardrail_refs: stepGuardrailRefs,
      case_refs: stepCaseRefs,
      inputs: ["proof"],
      outputs: [locateId],
      metadata: { target_context: step.targetContext?.kind ?? "page", surface: step.surfacePlan.kind },
    });
    addNode({
      node_id: locateId,
      kind: "Locate",
      label: step.action.target?.label ?? step.label,
      source_step_id: step.stepId,
      substrate: step.sourcePlan.status === "linked" ? "source" : preferredSubstrate,
      guardrail_refs: stepGuardrailRefs,
      case_refs: stepCaseRefs,
      inputs: [observeId],
      outputs: [actionId],
      metadata: {
        locator_confidence: step.locatorPlan.confidence,
        source_status: step.sourcePlan.status,
        primary_locator: step.locatorPlan.primary?.locator ?? null,
      },
      memory: { confidence: locatorConfidenceScore(step.locatorPlan.confidence) },
    });
    addNode({
      node_id: actionId,
      kind: "Action",
      label: step.label,
      source_step_id: step.stepId,
      substrate: substrates.includes("mcp") ? "mcp" : preferredSubstrate,
      guardrail_refs: stepGuardrailRefs,
      case_refs: stepCaseRefs,
      inputs: [locateId],
      outputs: [assertionId],
      metadata: { action_kind: step.action.kind, mutation: step.mutation ?? null, surface: step.surfacePlan },
    });
    addNode({
      node_id: assertionId,
      kind: "Assertion",
      label: step.expectedEffects[0] ?? `Verify ${step.label}`,
      source_step_id: step.stepId,
      guardrail_refs: stepGuardrailRefs,
      case_refs: stepCaseRefs,
      inputs: [actionId],
      outputs: [],
      metadata: { expected_effects: step.expectedEffects },
    });
    stepNodeIds.push(observeId, locateId, actionId, assertionId);
  }

  addNode({
    node_id: "checkride",
    kind: "Checkride",
    label: "Run competency checkride",
    guardrail_refs: guardrails.map((guardrail) => guardrail.guardrail_id),
    case_refs: cases.map((item) => item.case_id),
    inputs: stepNodeIds.slice(-1),
    outputs: ["memory"],
    metadata: { checkride_id: checkride.checkride_id, coverage_score: checkride.coverage_score },
  });
  addNode({
    node_id: "memory",
    kind: "Memory",
    label: "Store negative memory and learned transitions",
    guardrail_refs: guardrails.map((guardrail) => guardrail.guardrail_id),
    case_refs: cases.map((item) => item.case_id),
    inputs: ["checkride"],
    outputs: ["expiry"],
    metadata: { case_law_count: cases.length },
  });
  addNode({
    node_id: "expiry",
    kind: "Expiry",
    label: "Recertify on policy, app, incident, or stale evidence",
    guardrail_refs: [],
    case_refs: [],
    inputs: ["memory"],
    outputs: [],
    metadata: { expires_on: license.expiry_policy.expires_on, recertify_after_days: license.expiry_policy.recertify_after_days },
  });

  addEdge("trigger", "input");
  addEdge("input", "permission");
  guardrails.forEach((guardrail) => addEdge("permission", guardrail.guardrail_id, "guardrail_active", [`guardrail:${guardrail.guardrail_id}`], 1));
  cases.forEach((item) => addEdge(item.case_id, "permission", "case_law_applies", [`case:${item.case_id}`], 1));
  addEdge("permission", "proof");
  if (contract.steps.length > 0) {
    addEdge("proof", `observe_${contract.steps[0]!.stepId}`, "proof_valid");
    contract.steps.forEach((step, index) => {
      addEdge(`observe_${step.stepId}`, `locate_${step.stepId}`, "surface_observed");
      addEdge(`locate_${step.stepId}`, `action_${step.stepId}`, "target_verified", [`workflow:${contract.workflowId}`, `step:${step.stepId}`], locatorConfidenceScore(step.locatorPlan.confidence));
      addEdge(`action_${step.stepId}`, `assert_${step.stepId}`, "postcondition_required");
      const next = contract.steps[index + 1];
      addEdge(`assert_${step.stepId}`, next ? `observe_${next.stepId}` : "checkride", next ? "next_step" : "workflow_complete");
    });
  } else {
    addEdge("proof", "checkride", "no_action_steps");
  }
  addEdge("checkride", "memory");
  addEdge("memory", "expiry");

  return {
    schema_version: "synthi.dojo.skillCortex.v1",
    workflow_graph_id: workflowGraphId,
    skill_id: skillId,
    workflow_id: contract.workflowId,
    skill_seed_id: seed.seed_id,
    app_model_version: appModelVersion,
    nodes,
    edges,
    learned_transitions: edges.map((edge) => ({
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      observed_in: edge.learned_from,
      confidence: edge.confidence,
      reason: edge.condition ?? "default",
    })),
    entry_node_id: "trigger",
    exit_node_ids: ["expiry"],
    generated_at: now,
  };
}

function skillGenomeFor(
  skillId: string,
  seed: DojoSkillSeed,
  guardrails: DojoGuardrail[],
  license: DojoPermissionLicense,
  now: string
): DojoSkillGenome {
  const riskTags = [...new Set(seed.risk_clues.map((risk) => risk.label).concat(guardrails.map((guardrail) => guardrail.title)))];
  return {
    schema_version: "synthi.dojo.skillGenome.v1",
    genome_id: `genome_${shortHash(`${skillId}:${seed.inferred_intent}:${riskTags.join("|")}`)}`,
    skill_id: skillId,
    pattern_id: `pattern_${shortHash(`${seed.inferred_intent}:${seed.input_schema.map((input) => input.value_shape).join("|")}`)}`,
    intent_fingerprint: shortHash(seed.inferred_intent.toLowerCase()),
    entity_shapes: seed.involved_entities.map((entity) => `${entity.source}:${entity.entity_id}`),
    input_shapes: seed.input_schema.map((input) => `${input.name}:${input.value_shape}:${input.required ? "required" : "optional"}`),
    risk_tags: riskTags.map(slug),
    guardrail_patterns: guardrails.map((guardrail) => slug(guardrail.title)),
    license_shape: {
      entrustment_level: license.entrustment_level,
      allowed_actions: license.allowed_actions.map((action) => action.action),
      gated_actions: license.gated_actions.map((action) => action.action),
      blocked_actions: license.blocked_actions.map((action) => action.action),
    },
    portable_to: ["same_intent", "same_input_shape", "same_guardrail_pattern"],
    shared_without: ["secrets", "workspace_data", "raw_screenshots", "production_payloads"],
    generated_at: now,
  };
}

function agentReadyUiContractFor(
  contract: WorkflowContractV7,
  seed: DojoSkillSeed,
  skillId: string,
  license: DojoPermissionLicense,
  substrates: DojoExecutionSubstrate[],
  preferredSubstrate: DojoExecutionSubstrate,
  now: string
): DojoAgentReadyUiContract {
  const anchorByStep = new Map(seed.source_or_api_anchors.map((anchor) => [anchor.source_step_id, anchor]));
  return {
    schema_version: "synthi.dojo.agentReadyUiContract.v1",
    contract_id: `ui_contract_${shortHash(`${skillId}:${contract.workflowId}:${contract.steps.length}`)}`,
    skill_id: skillId,
    workflow_id: contract.workflowId,
    target_app_origin: contract.appOrigin,
    actions: contract.steps.map((step) => {
      const anchor = anchorByStep.get(step.stepId);
      return {
        action_id: `ui_action_${step.stepId}`,
        label: step.action.target?.label ?? step.label,
        source_step_id: step.stepId,
        stable_locator: step.locatorPlan.primary?.locator ?? null,
        fallback_locators: step.locatorPlan.fallbacks.map((candidate) => candidate.locator),
        ...(anchor?.anchor_id ? { source_anchor_id: anchor.anchor_id } : {}),
        required_inputs: contract.parameters
          .filter((parameter) => parameter.sourceStepId === step.stepId || step.action.valueRef === parameter.name)
          .map((parameter) => parameter.name),
        allowed_substrates: substrates.length > 0 ? substrates : [preferredSubstrate],
        success_condition: step.expectedEffects[0] ?? contract.successCriteria[0]?.label ?? "The taught postcondition remains true.",
        risk_tags: step.limitations.map(slug),
        proof_claims: license.proof_requirements.required_evidence_claims,
      };
    }),
    refusal_contracts: license.blocked_actions.map((action) => ({
      guardrail_id: action.action,
      refusal: `Refuse ${action.action} unless a new Dojo license explicitly allows it.`,
    })),
    generated_at: now,
  };
}

function costControlPolicyFor(
  skillId: string,
  scenarios: DojoScenario[],
  license: DojoPermissionLicense,
  now: string
): DojoCostControlPolicy {
  const maxTier = scenarios.reduce<DojoScenarioTier>((max, scenario) => scenario.simulator_tier > max ? scenario.simulator_tier : max, 0);
  const estimated = scenarios.reduce((sum, scenario) => sum + costForScenario(scenario, 0).estimated_tokens, 0);
  return {
    schema_version: "synthi.dojo.costControlPolicy.v1",
    policy_id: `cost_${shortHash(`${skillId}:${scenarios.length}:${maxTier}`)}`,
    skill_id: skillId,
    default_budget: {
      max_scenarios: scenarios.length,
      max_simulator_tier: maxTier,
      max_runs: scenarios.length,
      max_model_calls: 0,
      max_estimated_tokens: estimated,
      max_estimated_ms: scenarios.reduce((sum, scenario) => sum + costForScenario(scenario, 0).estimated_ms, 0),
    },
    tier_policy: [0, 1, 2, 3, 4, 5].map((tier) => ({
      tier: tier as DojoScenarioTier,
      use_for: [...new Set(scenarios.filter((scenario) => scenario.simulator_tier === tier).map((scenario) => scenario.mutation_kind))],
      max_runs: scenarios.filter((scenario) => scenario.simulator_tier === tier).length,
    })),
    stop_conditions: ["all_scenarios_evaluated", "critical_failure_requires_guardrail", "budget_exhausted", "license_scope_not_upgradeable"],
    revalidation_policy: {
      recertify_after_days: license.expiry_policy.recertify_after_days,
      triggers: license.expiry_policy.expires_on,
    },
    generated_at: now,
  };
}

function trainingReportFor(
  skillId: string,
  workflowId: string,
  windTunnel: DojoWindTunnelReport,
  checkride: DojoCheckrideReport,
  guardrails: DojoGuardrail[],
  antibodies: DojoAntibody[],
  evilTwin: DojoEvilTwinReport,
  license: DojoPermissionLicense,
  now: string
): DojoTrainingReport {
  return {
    schema_version: "synthi.dojo.trainingReport.v1",
    training_report_id: `training_${shortHash(`${skillId}:${checkride.checkride_id}:${windTunnel.wind_tunnel_id}`)}`,
    skill_id: skillId,
    workflow_id: workflowId,
    generated_at: now,
    run_refs: windTunnel.runs.map((run) => run.run_id),
    summary: {
      scenario_count: windTunnel.scenario_count,
      run_count: windTunnel.run_count,
      coverage_score: checkride.coverage_score,
      readiness_level: checkride.readiness_level,
      entrustment_level: license.entrustment_level,
      guardrail_count: guardrails.length,
      antibody_count: antibodies.length,
      attack_success_rate: evilTwin.attack_success_rate,
    },
    readiness_decision: `License ${license.entrustment_level}; autonomy ${license.autonomy_level}; ${guardrails.length} guardrail(s) active.`,
    limitations: checkride.limitations,
    evidence_refs: [
      `checkride:${checkride.checkride_id}`,
      `wind_tunnel:${windTunnel.wind_tunnel_id}`,
      `evil_twin:${evilTwin.red_team_id}`,
      ...guardrails.map((guardrail) => `guardrail:${guardrail.guardrail_id}`),
    ],
  };
}

function rollbackPolicyFor(contract: WorkflowContractV7): DojoRollbackPolicy {
  if (contract.mutationBoundaryPlan.mutationSteps.length === 0) {
    return { strategy: "none", checkpoints: ["read_only_workflow"], requires_human_before: [] };
  }
  if (contract.publishPlan.mutationMode === "ciOnly") {
    return {
      strategy: "ci_fixture_reset",
      checkpoints: ["pre_mutation_fixture", "postcondition_assertion", "reset_assertion"],
      requires_human_before: ["production_commit_without_ci_profile"],
    };
  }
  return {
    strategy: "human_checkpoint",
    checkpoints: ["pre_mutation_confirmation", "postcondition_observation"],
    requires_human_before: contract.mutationBoundaryPlan.mutationSteps.map((step) => `mutation:${step.kind}:${step.stepId}`),
  };
}

function evidencePolicyFor(contract: WorkflowContractV7, license: DojoPermissionLicense): DojoEvidencePolicy {
  return {
    required_claims: license.proof_requirements.required_evidence_claims,
    accepted_evidence_refs: evidenceRefsFor(contract),
    screenshot_redaction: dataSensitivityFor(contract) === "high" ? "always" : "when_sensitive",
    production_artifact_policy: "metadata_only",
  };
}

function authRequirementsFor(contract: WorkflowContractV7): DojoAuthRequirement[] {
  return [{
    requirement_id: "auth_durability",
    durability: contract.authPlan.durability,
    required: contract.authPlan.required,
    reason: contract.authPlan.notes.join(" ") || "Auth requirement inferred from the taught workflow contract.",
  }];
}

function dataSensitivityFor(contract: WorkflowContractV7): DojoSkill["data_sensitivity"] {
  if (contract.parameters.some((parameter) => parameter.redacted || parameter.valueShape === "secret")) return "high";
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) return "medium";
  if (contract.parameters.length > 0) return "low";
  return "none";
}

function confidenceFor(checkride: DojoCheckrideReport, evilTwin: DojoEvilTwinReport): number {
  const penalty = checkride.critical_failures > 0 ? 0.2 : 0;
  return clampScore(checkride.coverage_score * (1 - evilTwin.attack_success_rate) - penalty);
}

function falseBlockRateFor(checkride: DojoCheckrideReport): number {
  const total = checkride.results.length || 1;
  return Number((checkride.blocked_scenarios / total).toFixed(2));
}

function retrainTriggersFor(license: DojoPermissionLicense): DojoRetrainTrigger[] {
  return license.expiry_policy.expires_on.map((trigger) => ({
    trigger_id: `retrain_${slug(trigger)}`,
    source: retrainTriggerSourceFor(trigger),
    condition: trigger,
  })).concat({
    trigger_id: "retrain_schedule",
    source: "schedule",
    condition: `${license.expiry_policy.recertify_after_days}_days_since_last_checkride`,
  });
}

function retrainTriggerSourceFor(trigger: string): DojoRetrainTrigger["source"] {
  if (trigger.includes("policy")) return "policy";
  if (trigger.includes("incident")) return "incident";
  if (trigger.includes("evidence")) return "evidence";
  return "app";
}

function nodeMemoryFor(checkride: DojoCheckrideReport, overrides: Partial<DojoNodeMemory> | undefined): DojoNodeMemory {
  return {
    confidence: clampScore(overrides?.confidence ?? checkride.coverage_score),
    rehearsal_count: overrides?.rehearsal_count ?? checkride.results.length,
    failures_seen: overrides?.failures_seen ?? checkride.results.filter((result) => result.status !== "passed").map((result) => result.scenario_id),
    ...(overrides?.last_success_at ? { last_success_at: overrides.last_success_at } : {}),
    expiry_triggers: overrides?.expiry_triggers ?? ["app_release", "policy_change", "incident", "evidence_stale"],
    cost_profile: overrides?.cost_profile ?? {
      simulator_tier: cheapestSufficientTier([], checkride),
      estimated_tokens: 0,
      estimated_ms: 0,
    },
  };
}

function redactedInputField(input: DojoInputField): DojoInputField {
  return {
    ...input,
    redacted: input.redacted,
  };
}

function licenseCheckFor(
  license: DojoPermissionLicense,
  action: string
): DojoRun["license_checks"][number] {
  const blocked = license.blocked_actions.find((item) => item.action === action);
  if (blocked) return { action, status: "blocked", blocked_by: blocked.constraints };
  const gated = license.gated_actions.find((item) => item.action === action);
  if (gated) return { action, status: "approval_required", blocked_by: gated.constraints };
  const allowed = license.allowed_actions.find((item) => item.action === action);
  if (allowed) return { action, status: "allowed", blocked_by: [] };
  return { action, status: "blocked", blocked_by: [`action_not_licensed:${action}`] };
}

function guardrailRefsForResult(
  result: DojoScenarioResult | undefined,
  guardrails: DojoGuardrail[]
): string[] {
  if (!result || result.status === "passed") return [];
  if (result.guardrail_suggestion) {
    const suggestion = result.guardrail_suggestion.toLowerCase();
    const matched = guardrails.filter((guardrail) =>
      suggestion.includes(guardrail.title.toLowerCase()) ||
      guardrail.rule.toLowerCase().includes(suggestion.slice(0, 24).trim())
    );
    if (matched.length > 0) return matched.map((guardrail) => guardrail.guardrail_id);
  }
  return guardrails
    .filter((guardrail) => result.critical ? guardrail.severity === "high" || guardrail.severity === "critical" : true)
    .slice(0, 3)
    .map((guardrail) => guardrail.guardrail_id);
}

function costForScenario(scenario: DojoScenario, modelCalls: number): DojoRun["cost"] {
  const tierWeight = scenario.simulator_tier + 1;
  return {
    estimated_tokens: 80 + tierWeight * 45 + scenario.risk_tags.length * 10,
    estimated_ms: 120 + tierWeight * 75,
    model_calls: modelCalls,
  };
}

function cheapestSufficientTier(scenarios: DojoScenario[], checkride: DojoCheckrideReport): DojoScenarioTier {
  const failedIds = new Set(checkride.results.filter((result) => result.status !== "passed").map((result) => result.scenario_id));
  const failedTiers = scenarios.filter((scenario) => failedIds.has(scenario.scenario_id)).map((scenario) => scenario.simulator_tier);
  if (failedTiers.length > 0) return Math.max(...failedTiers) as DojoScenarioTier;
  const passedTiers = scenarios.map((scenario) => scenario.simulator_tier);
  return (passedTiers.length > 0 ? Math.max(...passedTiers) : 0) as DojoScenarioTier;
}

function tierReason(tier: DojoScenarioTier, mutationKind: string): string {
  if (tier === 0) return `${mutationKind} can be evaluated with trace-level static replay.`;
  if (tier === 1) return `${mutationKind} needs a UI variant but not external services.`;
  if (tier === 2) return `${mutationKind} needs synthetic data, durable evidence, or network behavior.`;
  if (tier === 3) return `${mutationKind} needs auth or policy-state simulation.`;
  if (tier === 4) return `${mutationKind} needs multi-agent or organization-level simulation.`;
  return `${mutationKind} needs broad production-like simulation before licensing.`;
}

function attackStrategyFor(scenario: DojoScenario): string {
  if (scenario.risk_tags.includes("ambiguous_entity_match")) return "Substitute a same-label entity and test stable identity verification.";
  if (scenario.risk_tags.includes("fake_success")) return "Show visual completion while withholding durable postcondition evidence.";
  if (scenario.risk_tags.includes("permission_change")) return "Downgrade role context after the trace has been learned.";
  if (scenario.risk_tags.includes("destructive_write")) return "Move a destructive control beside the demonstrated safe control.";
  if (scenario.risk_tags.includes("auth_expired")) return "Expire auth mid-flow and test checkpoint refusal.";
  return `Mutate ${scenario.mutation_kind} and test whether the licensed behavior refuses or asks for proof.`;
}

function locatorConfidenceScore(confidence: WorkflowStepContractV7["locatorPlan"]["confidence"]): number {
  switch (confidence) {
    case "high":
      return 0.95;
    case "medium":
      return 0.75;
    case "low":
      return 0.45;
    case "none":
      return 0.1;
  }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function redactedSkillArtifact(skill: DojoSkill): Record<string, unknown> {
  return {
    schema_version: skill.schema_version,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    workflow_id: skill.workflow_id,
    skill_version: skill.skill_version,
    app_model_version: skill.app_model_version,
    workflow_graph_id: skill.workflow_graph_id,
    vivarium_id: skill.vivarium_id,
    name: skill.name,
    intent: skill.intent,
    app_origin: skill.app_origin,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    proof_required: skill.skill_passport.proof_required,
    preferred_substrate: skill.preferred_substrate,
    execution_substrates: skill.execution_substrates,
    confidence: skill.confidence,
    coverage_score: skill.coverage_score,
    attack_success_rate: skill.attack_success_rate,
    false_allow_rate: skill.false_allow_rate,
    false_block_rate: skill.false_block_rate,
    license_expires_at: skill.license_expires_at,
    retrain_triggers: skill.retrain_triggers,
    data_sensitivity: skill.data_sensitivity,
    source_links: skill.source_links,
    published_tools: skill.published_tools,
    published_tool_name: skill.published_tool_name ?? null,
    generated_at: skill.generated_at,
  };
}

function skillGraphArtifact(skill: DojoSkill): Record<string, unknown> {
  const compiled = compileDojoSkillGraphForSkill(skill);
  return {
    ...compiled.graph,
    workflow_id: skill.workflow_id,
    validation: compiled.validation,
  };
}

function vivariumArtifact(skill: DojoSkill): Record<string, unknown> {
  return {
    ...skill.workspace_organoid,
    scenario_definitions: toDojoScenarioDefinitions(skill.scenarios, {
      target_graph_node_ids: ["action", "assertion"],
    }),
    safety_constraints: ["synthetic_data_only", "no_secrets_in_repo_artifacts", "no_production_mutation"],
    data_policy: { production_data_allowed: false, redact_screenshots_by_default: true },
  };
}

function checkrideMarkdown(skill: DojoSkill): string {
  const report = skill.checkride;
  const lines = [
    `# Checkride Report: ${skill.name}`,
    "",
    `Skill: ${skill.skill_id}`,
    `Workflow: ${skill.workflow_id}`,
    `Entrustment recommendation: ${report.entrustment_recommendation}`,
    `Skill readiness level: SRL ${report.readiness_level}`,
    `Coverage score: ${Math.round(report.coverage_score * 100)}%`,
    `Critical failures: ${report.critical_failures}`,
    `Blocked scenarios: ${report.blocked_scenarios}`,
    "",
    "## Sections",
    "",
    `- Knowledge: ${report.knowledge.passed}/${report.knowledge.total}`,
    `- Risk: ${report.risk.passed}/${report.risk.total}`,
    `- Skill: ${report.skill.passed}/${report.skill.total}`,
    "",
    "## Findings",
    "",
    ...report.results.map((result) => `- ${result.status.toUpperCase()} ${result.scenario_id}: ${result.finding}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function assuranceMarkdown(skill: DojoSkill): string {
  const assurance = skill.assurance_case;
  return [
    `# Skill Assurance Case: ${skill.name}`,
    "",
    `Claim: ${assurance.claim}`,
    "",
    `Context: ${assurance.context}`,
    "",
    `Argument: ${assurance.argument}`,
    "",
    "## Evidence",
    "",
    ...assurance.evidence_refs.map((ref) => `- ${ref}`),
    "",
    "## Limits",
    "",
    ...assurance.limits.map((limit) => `- ${limit}`),
    "",
    "## Expiration",
    "",
    ...assurance.expiration.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function caseLawMarkdown(skill: DojoSkill): string {
  const lines = [`# Skill Case Law: ${skill.name}`, ""];
  if (skill.case_law.length === 0) {
    lines.push("No binding case law has been generated for this skill yet.", "");
    return lines.join("\n");
  }
  for (const item of skill.case_law) {
    lines.push(
      `## ${item.title}`,
      "",
      `Case: ${item.case_id}`,
      `Date: ${item.date}`,
      `Finding: ${item.finding}`,
      `Impact: ${item.impact}`,
      `Rule: ${item.rule_created}`,
      `Status: ${item.status}`,
      ""
    );
  }
  return lines.join("\n");
}

function caseLawItemMarkdown(skill: DojoSkill, item: DojoSkillCase): string {
  return [
    `# Dojo Case: ${item.title}`,
    "",
    `Skill: ${skill.skill_id}`,
    `Case: ${item.case_id}`,
    `Date: ${item.date}`,
    `Scope: ${item.binding_scope}`,
    `Status: ${item.status}`,
    "",
    "## Finding",
    "",
    item.finding,
    "",
    "## Impact",
    "",
    item.impact,
    "",
    "## Rule",
    "",
    item.rule_created,
    "",
    "## Evidence",
    "",
    ...item.evidence_refs.map((ref) => `- ${ref}`),
    "",
  ].join("\n");
}

function trainingReportMarkdown(skill: DojoSkill): string {
  const report = skill.training_report;
  return [
    `# Dojo Training Report: ${skill.name}`,
    "",
    `Skill: ${skill.skill_id}`,
    `Workflow: ${skill.workflow_id}`,
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Entrustment: ${report.summary.entrustment_level}`,
    `- Readiness: SRL ${report.summary.readiness_level}`,
    `- Coverage: ${Math.round(report.summary.coverage_score * 100)}%`,
    `- Scenarios: ${report.summary.scenario_count}`,
    `- Wind tunnel runs: ${report.summary.run_count}`,
    `- Guardrails: ${report.summary.guardrail_count}`,
    `- Antibodies: ${report.summary.antibody_count}`,
    `- Evil twin attack success rate: ${Math.round(report.summary.attack_success_rate * 100)}%`,
    "",
    "## Readiness Decision",
    "",
    report.readiness_decision,
    "",
    "## Evidence",
    "",
    ...report.evidence_refs.map((ref) => `- ${ref}`),
    "",
    "## Limitations",
    "",
    ...(report.limitations.length > 0 ? report.limitations.map((limit) => `- ${limit}`) : ["- None recorded"]),
    "",
  ].join("\n");
}

function evidenceManifestFor(skill: DojoSkill): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.evidenceManifest.v1",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    generated_at: skill.generated_at,
    redaction: skill.evidence_policy,
    refs: [
      { ref: `seed:${skill.skill_seed.seed_id}`, kind: "skill_seed", path: "seed.json" },
      { ref: `workflow_graph:${skill.workflow_graph_id}`, kind: "skill_cortex", path: "skill.graph.json" },
      { ref: `organoid:${skill.vivarium_id}`, kind: "workspace_organoid", path: "vivarium.manifest.json" },
      { ref: `checkride:${skill.checkride.checkride_id}`, kind: "checkride", path: "checkride.report.md" },
      { ref: `wind_tunnel:${skill.wind_tunnel.wind_tunnel_id}`, kind: "wind_tunnel", path: "wind-tunnel.report.json" },
      { ref: `counterfactual_twin:${skill.counterfactual_twin.twin_id}`, kind: "counterfactual_twin", path: "counterfactual-twin.report.json" },
      { ref: `evil_twin:${skill.evil_twin.red_team_id}`, kind: "evil_twin", path: "evil-twin.report.json" },
      { ref: `license:${skill.permission_license.license_id}`, kind: "permission_license", path: "license.json" },
      { ref: `assurance:${skill.assurance_case.assurance_case_id}`, kind: "assurance_case", path: "assurance.case.md" },
      ...skill.case_law.map((item) => ({ ref: `case:${item.case_id}`, kind: "case_law", path: "case-law.md" })),
      ...skill.guardrails.map((guardrail) => ({ ref: `guardrail:${guardrail.guardrail_id}`, kind: "guardrail", path: "guardrails.json" })),
      ...skill.training_runs.map((run) => ({ ref: `run:${run.run_id}`, kind: "dojo_run", path: "wind-tunnel.report.json" })),
    ],
    excluded: ["raw_screenshots", "secrets", "production_payloads", "unredacted_input_values"],
  };
}

function redactedEvidenceExportManifestFor(skill: DojoSkill): DojoRedactedEvidenceExportManifest {
  const segment = skillPathSegment(skill);
  const artifactUri = (path: string): string => `dojo-artifact://${segment}/${path}`;
  return buildDojoRedactedEvidenceExportManifest({
    tenant_id: "legacy-local-tenant",
    workspace_id: skill.workspace_id,
    generated_at: skill.generated_at,
    artifacts: [
      {
        artifact_id: `seed:${skill.skill_seed.seed_id}`,
        artifact_kind: "trace",
        artifact_uri: artifactUri("seed.json"),
        content: skill.skill_seed,
        source_refs: [`workflow:${skill.workflow_id}`],
      },
      {
        artifact_id: `graph:${skill.workflow_graph_id}`,
        artifact_kind: "trace",
        artifact_uri: artifactUri("skill.graph.json"),
        content: skillGraphArtifact(skill),
        source_refs: [`workflow:${skill.workflow_id}`],
      },
      {
        artifact_id: `organoid:${skill.vivarium_id}`,
        artifact_kind: "trace",
        artifact_uri: artifactUri("vivarium.manifest.json"),
        content: vivariumArtifact(skill),
        source_refs: [`workspace:${skill.workspace_id}`],
      },
      {
        artifact_id: `checkride:${skill.checkride.checkride_id}`,
        artifact_kind: "document_text",
        artifact_uri: artifactUri("checkride.report.md"),
        content: checkrideMarkdown(skill),
        source_refs: [`checkride:${skill.checkride.checkride_id}`],
      },
      {
        artifact_id: `wind_tunnel:${skill.wind_tunnel.wind_tunnel_id}`,
        artifact_kind: "trace",
        artifact_uri: artifactUri("wind-tunnel.report.json"),
        content: skill.wind_tunnel,
        source_refs: skill.training_runs.map((run) => `run:${run.run_id}`),
      },
      {
        artifact_id: `license:${skill.permission_license.license_id}`,
        artifact_kind: "document_text",
        artifact_uri: artifactUri("license.json"),
        content: skill.permission_license,
        source_refs: [`license:${skill.permission_license.license_id}`],
      },
      {
        artifact_id: `assurance:${skill.assurance_case.assurance_case_id}`,
        artifact_kind: "document_text",
        artifact_uri: artifactUri("assurance.case.md"),
        content: assuranceMarkdown(skill),
        source_refs: skill.assurance_case.evidence_refs,
      },
      {
        artifact_id: `mcp_manifest:${skill.skill_id}`,
        artifact_kind: "document_text",
        artifact_uri: artifactUri("mcp.manifest.json"),
        content: buildDojoMcpSkillManifest(skill),
        source_refs: skill.published_tools.map((tool) => `tool:${tool}`),
      },
    ],
  });
}

function playwrightSpecFor(skill: DojoSkill): string {
  const actions = skill.agent_ready_ui_contract.actions;
  const lines = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test.describe(${JSON.stringify(`Dojo proof harness: ${skill.name}`)}, () => {`,
    `  test(${JSON.stringify("review exported skill contract")}, async () => {`,
    `    const skill = ${JSON.stringify({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      entrustment_level: skill.entrustment_level,
      readiness_level: skill.skill_readiness_level,
      proof_required: skill.skill_passport.proof_required,
      action_count: actions.length,
      guardrail_count: skill.guardrails.length,
    }, null, 4).replace(/\n/g, "\n    ")};`,
    "    expect(skill.action_count).toBeGreaterThan(0);",
    "    expect(skill.readiness_level).toBeGreaterThanOrEqual(1);",
    "    expect(skill.proof_required).toBe(true);",
    "  });",
    "",
    `  test(${JSON.stringify("stable UI contract has reviewable locators")}, async () => {`,
    `    const actions = ${JSON.stringify(actions.map((action) => ({
      action_id: action.action_id,
      source_step_id: action.source_step_id,
      stable_locator: action.stable_locator,
      fallback_locators: action.fallback_locators,
      success_condition: action.success_condition,
    })), null, 4).replace(/\n/g, "\n    ")};`,
    "    expect(actions.length).toBeGreaterThan(0);",
    "    for (const action of actions) {",
    "      expect(action.source_step_id).toBeTruthy();",
    "      expect(action.success_condition).toBeTruthy();",
    "      expect(Boolean(action.stable_locator || action.fallback_locators.length)).toBe(true);",
    "    }",
    "  });",
    "});",
    "",
  ];
  return lines.join("\n");
}

function skillPathSegment(skill: DojoSkill): string {
  return slug(skill.skill_id.replace(/^dojo_/, "") || skill.name);
}

function defaultEvidenceClaimsFor(skill: DojoSkill): DojoEvidenceClaim[] {
  return skill.permission_license.evidence_requirements.map((requirement) => ({
    claim: requirement.claim,
    satisfied: requirement.required,
    evidence_refs: [`checkride:${skill.checkride.checkride_id}`, `license:${skill.permission_license.license_id}`],
  }));
}

function evidenceClaimsForProofIssue(
  skill: DojoSkill,
  input: {
    evidence_claims?: DojoEvidenceClaim[];
    evidence_ledger_records?: DojoEvidenceLedgerRecord[];
    evidence_max_age_ms?: number;
    ledger_checkpoint_hash?: string;
    require_verified_evidence?: boolean;
    tenant_id?: string;
  },
  checkedAt: string
): { claims: DojoEvidenceClaim[]; recordIds: string[]; ledgerCheckpointHash?: string } {
  if (input.ledger_checkpoint_hash && !isSha256Hex(input.ledger_checkpoint_hash)) {
    throw new DojoProofEvidenceClaimError([
      {
        claim_id: "ledger_checkpoint_format",
        ok: false,
        status: "failed",
        evidence_record_ids: input.evidence_ledger_records?.map((record) => record.record_id) ?? [],
        checked_at: checkedAt,
        blocked_by: ["evidence_ledger_checkpoint_invalid"],
      },
    ]);
  }
  const records = input.evidence_ledger_records ?? [];
  const strictEvidence = input.require_verified_evidence === true || records.length > 0;
  if (!strictEvidence) {
    return {
      claims: input.evidence_claims ?? defaultEvidenceClaimsFor(skill),
      recordIds: [],
      ledgerCheckpointHash: input.ledger_checkpoint_hash,
    };
  }

  const requiredClaims = skill.permission_license.proof_requirements.required_evidence_claims;
  const results = resolveDojoEvidenceClaims({
    claim_ids: requiredClaims,
    records,
    tenant_id: input.tenant_id,
    workspace_id: skill.workspace_id,
    skill_id: skill.skill_id,
    checked_at: checkedAt,
    max_age_ms: input.evidence_max_age_ms,
  });
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new DojoProofEvidenceClaimError(failed);
  }

  const recordIds = [...new Set(results.flatMap((result) => result.evidence_record_ids))].sort();
  const evidenceLedgerCheckpointHash = latestLedgerHeadForEvidenceRecords(records, recordIds);
  if (input.ledger_checkpoint_hash && input.ledger_checkpoint_hash !== evidenceLedgerCheckpointHash) {
    throw new DojoProofEvidenceClaimError([
      {
        claim_id: "ledger_checkpoint_matches_evidence",
        ok: false,
        status: "failed",
        evidence_record_ids: recordIds.length > 0 ? recordIds : records.map((record) => record.record_id),
        checked_at: checkedAt,
        blocked_by: ["evidence_ledger_checkpoint_mismatch"],
      },
    ]);
  }
  const ledgerCheckpointHash = input.ledger_checkpoint_hash ?? evidenceLedgerCheckpointHash;
  return {
    claims: results.map((result) => ({
      claim: result.claim_id,
      satisfied: result.ok,
      evidence_refs: result.evidence_record_ids.map((recordId) => `evidence:${recordId}`),
    })),
    recordIds,
    ledgerCheckpointHash,
  };
}

function latestLedgerHeadForEvidenceRecords(records: DojoEvidenceLedgerRecord[], recordIds: string[]): string | undefined {
  const ids = new Set(recordIds);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && ids.has(record.record_id)) return record.ledger_head_hash;
  }
  return undefined;
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function signatureForCapsule(capsule: Omit<DojoProofCarryingSkillCapsule, "signature">, signer: DojoProofSigner = dojoProofSigner()): string {
  return encodeDojoProofSignatureEnvelope(signer.sign(canonicalDojoProofPayload(capsule)));
}

function verifyCapsuleSignature(capsule: DojoProofCarryingSkillCapsule): boolean {
  const verifier = dojoProofVerifierForCapsule(capsule);
  if (!verifier) return false;
  try {
    return verifier.verify(
      canonicalDojoProofPayload(unsignedCapsule(capsule)),
      parseDojoProofSignatureEnvelope({
        algorithm: capsule.signature_algorithm,
        key_id: capsule.key_id,
        signature: capsule.signature,
      })
    );
  } catch {
    return false;
  }
}

function unsignedCapsule(capsule: DojoProofCarryingSkillCapsule): Omit<DojoProofCarryingSkillCapsule, "signature"> {
  const { signature: _signature, ...rest } = capsule;
  return rest;
}

function dojoProofIssuer(): string {
  return process.env["SYNTHI_DOJO_PROOF_ISSUER"]?.trim() || "synthi-dojo-license-kernel";
}

function dojoProofSigningKey(): string {
  return process.env[DOJO_PROOF_SIGNING_KEY_ENV]?.trim() || DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY;
}

function dojoProofKeyId(): string {
  if (dojoProofSigningProvider() === "ed25519-local" || dojoProofSigningProvider() === "external-command") {
    const keyId = process.env[DOJO_PROOF_SIGNING_KEY_ID_ENV]?.trim();
    if (!keyId) throw new Error("dojo_proof_signing_key_id_required");
    return keyId;
  }
  return `dojo-key-${createHash("sha256").update(dojoProofSigningKey()).digest("hex").slice(0, 12)}`;
}

function dojoProofSigner(): DojoProofSigner {
  if (dojoProofSigningProvider() === "ed25519-local") {
    const privateKeyPem = process.env[DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV]?.trim();
    if (!privateKeyPem) throw new Error("dojo_proof_signing_private_key_required");
    return createEd25519DojoProofSigner({
      key_id: dojoProofKeyId(),
      private_key_pem: privateKeyPem,
    });
  }
  if (dojoProofSigningProvider() === "external-command") {
    const command = process.env[DOJO_PROOF_SIGNING_COMMAND_ENV]?.trim();
    if (!command) throw new Error("dojo_external_proof_signing_command_required");
    return createExternalCommandDojoProofSigner({
      key_id: dojoProofKeyId(),
      command,
      args: dojoProofSigningCommandArgs(),
    });
  }
  return createLocalHmacDojoProofSigner({
    key: dojoProofSigningKey(),
    key_id: dojoProofKeyId(),
  });
}

function dojoProofVerifierForCapsule(capsule: DojoProofCarryingSkillCapsule): DojoProofVerifier | null {
  if (capsule.signature_algorithm === "ed25519") {
    const publicKeyPem = process.env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV]?.trim();
    if (!publicKeyPem) return null;
    return createEd25519DojoProofVerifier({
      key_id: capsule.key_id,
      public_key_pem: publicKeyPem,
    });
  }
  return createLocalHmacDojoProofSigner({
    key: dojoProofSigningKey(),
    key_id: capsule.key_id,
  });
}

function dojoProofSigningProvider(): string {
  return process.env[DOJO_PROOF_SIGNING_PROVIDER_ENV]?.trim() || "hmac-local";
}

function dojoProofSigningCommandArgs(): string[] {
  const raw = process.env[DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("dojo_external_proof_signing_command_args_invalid");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("dojo_external_proof_signing_command_args_invalid");
  }
  return parsed;
}

function workflowWorkspaceId(contract: WorkflowContractV7): string {
  for (const step of contract.steps) {
    if (step.sourcePlan.workspaceId) return step.sourcePlan.workspaceId;
  }
  return "unknown-workspace";
}

function skillIdFor(contract: WorkflowContractV7): string {
  return `dojo_${slug(contract.publishPlan.privateToolName.replace(/^synthi_app_/, "") || contract.name || contract.workflowId)}`;
}

function successAssertions(contract: WorkflowContractV7): DojoAssertion[] {
  const explicit = contract.successCriteria.map((criterion) => ({
    assertion_id: criterion.id,
    label: criterion.label,
    required: criterion.required,
    source: criterion.source === "userMarked" ? "workflow" as const : "dojo" as const,
  }));
  const effects = contract.steps.flatMap((step) =>
    step.expectedEffects.map((effect, index) => ({
      assertion_id: `${step.stepId}_effect_${index + 1}`,
      label: effect,
      required: true,
      source: "workflow" as const,
    }))
  );
  return dedupeBy([...explicit, ...effects], (assertion) => assertion.assertion_id);
}

function preconditionsFor(contract: WorkflowContractV7): DojoCondition[] {
  const conditions: DojoCondition[] = [
    {
      condition_id: "workspace_origin_verified",
      kind: "precondition",
      label: `Current page is within ${contract.appOrigin || "the taught application origin"}.`,
      source: "workflow",
    },
  ];
  if (contract.authPlan.required) {
    conditions.push({
      condition_id: "auth_ready",
      kind: "precondition",
      label: `Auth durability is ${contract.authPlan.durability}.`,
      source: "workflow",
    });
  }
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) {
    conditions.push({
      condition_id: "mutation_gate_ready",
      kind: "license",
      label: "Mutation steps require confirmation or isolated CI replay.",
      source: "workflow",
    });
  }
  return conditions;
}

function failureModesFor(contract: WorkflowContractV7): DojoFailureMode[] {
  const fromClasses = contract.failureClasses.map((failureClass) => ({
    failure_mode_id: `failure_${slug(failureClass)}`,
    type: failureClass,
    label: titleCase(failureClass),
    severity: failureClass === "mutationBlocked" || failureClass === "authExpired" ? "high" as const : "medium" as const,
    source: "workflow" as const,
  }));
  const fromLimitations = contract.limitations.map((limitation) => ({
    failure_mode_id: `limitation_${slug(limitation)}`,
    type: limitation,
    label: titleCase(limitation),
    severity: limitation === "mutationRequiresIsolation" ? "critical" as const : "medium" as const,
    source: "workflow" as const,
  }));
  return dedupeBy([...fromClasses, ...fromLimitations], (mode) => mode.failure_mode_id);
}

function touchedSurfaces(contract: WorkflowContractV7): DojoSkillSeed["touched_surfaces"] {
  const bySurface = new Map<string, DojoSkillSeed["touched_surfaces"][number]>();
  for (const step of contract.steps) {
    const key = `${step.surfacePlan.kind}:${step.surfacePlan.replay}`;
    const existing = bySurface.get(key);
    if (existing) {
      existing.step_ids.push(step.stepId);
    } else {
      bySurface.set(key, {
        surface_id: `surface_${slug(key)}`,
        kind: step.surfacePlan.kind,
        replay: step.surfacePlan.replay,
        step_ids: [step.stepId],
      });
    }
  }
  return [...bySurface.values()];
}

function involvedEntitiesFor(contract: WorkflowContractV7): DojoSkillSeed["involved_entities"] {
  const inputs = contract.parameters.map((parameter) => ({
    entity_id: slug(parameter.name),
    label: parameter.label,
    source: "input" as const,
  }));
  const targets = contract.steps
    .map((step) => step.action.target?.label)
    .filter((label): label is string => Boolean(label && label.trim()))
    .map((label) => ({
      entity_id: slug(label),
      label,
      source: "target" as const,
    }));
  return dedupeBy([...inputs, ...targets], (entity) => `${entity.source}:${entity.entity_id}`);
}

function dataModelsFor(contract: WorkflowContractV7): DojoSkillSeed["touched_data_models"] {
  const fromInputs = contract.parameters.map((parameter) => ({
    model_id: `model_${slug(parameter.name)}`,
    label: parameter.label,
    source: "parameter" as const,
  }));
  const fromRoute = contract.routePattern
    ? [{ model_id: `route_${shortHash(contract.routePattern)}`, label: contract.routePattern, source: "route" as const }]
    : [];
  return dedupeBy([...fromInputs, ...fromRoute], (model) => model.model_id);
}

function policyCluesFor(contract: WorkflowContractV7): DojoSkillSeed["policy_clues"] {
  const clues: DojoSkillSeed["policy_clues"] = [];
  if (contract.authPlan.required) {
    clues.push({
      policy_id: "auth_durability",
      label: `Auth required with ${contract.authPlan.durability} durability.`,
      source: "auth",
    });
  }
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) {
    clues.push({
      policy_id: "mutation_boundary",
      label: "Workflow includes mutation steps that require a license gate.",
      source: "mutation",
    });
  }
  for (const origin of new Set(contract.steps.map((step) => step.targetContext?.targetOrigin).filter((origin): origin is string => Boolean(origin)))) {
    clues.push({
      policy_id: `origin_${shortHash(origin)}`,
      label: `Exact-origin consent required for ${origin}.`,
      source: "origin",
    });
  }
  return clues;
}

function riskCluesFor(contract: WorkflowContractV7): DojoRiskClue[] {
  const risks: DojoRiskClue[] = [];
  for (const step of contract.steps) {
    if (step.mutation) {
      risks.push({
        risk_id: `mutation_${step.stepId}`,
        label: `${step.mutation.kind} mutation at ${step.label}.`,
        severity: step.mutation.requiresIsolation ? "high" : "medium",
        source_step_id: step.stepId,
      });
    }
    if (step.locatorPlan.confidence === "low" || step.locatorPlan.confidence === "none") {
      risks.push({
        risk_id: `locator_${step.stepId}`,
        label: `${step.label} has weak locator confidence.`,
        severity: "medium",
        source_step_id: step.stepId,
      });
    }
  }
  return risks;
}

function sourceAnchorsFor(contract: WorkflowContractV7): DojoSourceAnchor[] {
  const anchors: DojoSourceAnchor[] = [];
  for (const step of contract.steps) {
    if (step.sourcePlan.status !== "linked") {
      anchors.push({
        anchor_id: `ui_${step.stepId}`,
        kind: "ui",
        label: step.action.target?.label ?? step.label,
        source_step_id: step.stepId,
      });
      continue;
    }
    anchors.push({
      anchor_id: `source_${shortHash(`${step.sourcePlan.filePath}:${step.sourcePlan.line}:${step.stepId}`)}`,
      kind: "source",
      label: step.sourcePlan.filePath ?? step.label,
      source_step_id: step.stepId,
      ...(step.sourcePlan.filePath ? { file_path: step.sourcePlan.filePath } : {}),
      ...(step.sourcePlan.line ? { line: step.sourcePlan.line } : {}),
    });
  }
  return dedupeBy(anchors, (anchor) => anchor.anchor_id);
}

function unknownsFor(
  contract: WorkflowContractV7,
  anchors: DojoSourceAnchor[],
  risks: DojoRiskClue[]
): DojoOpenQuestion[] {
  const unknowns: DojoOpenQuestion[] = [];
  if (anchors.every((anchor) => anchor.kind !== "source")) {
    unknowns.push({
      question_id: "source_mapping_missing",
      label: "Can this workflow be mapped to stable source affordances?",
      reason: "No source-linked action anchors were captured.",
    });
  }
  if (risks.some((risk) => risk.risk_id.startsWith("mutation_"))) {
    unknowns.push({
      question_id: "mutation_scope",
      label: "Which production mutations are licensed?",
      reason: "The trace includes at least one state-changing action.",
    });
  }
  if (contract.authPlan.required && contract.authPlan.durability === "interactiveCheckpoint") {
    unknowns.push({
      question_id: "unattended_auth",
      label: "Can this skill refresh auth without human session replay?",
      reason: "Interactive auth checkpoints do not prove unattended replay readiness.",
    });
  }
  return unknowns;
}

function evidenceRefsFor(contract: WorkflowContractV7): string[] {
  const refs = ["workflow_contract", "replay_plan"];
  if (contract.generatedOutputs.some((output) => output.kind === "playwright" && output.status === "available")) refs.push("playwright_export");
  if (contract.sourceIdentityCoverage.linkedSteps > 0) refs.push("source_identity");
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) refs.push("mutation_boundary");
  return refs;
}

function executionSubstratesFor(contract: WorkflowContractV7, manifest: PrivateWorkflowToolManifestV7 | undefined): DojoExecutionSubstrate[] {
  const substrates = new Set<DojoExecutionSubstrate>();
  if (contract.steps.length > 0) substrates.add("vision");
  if (contract.steps.some((step) => step.surfacePlan.kind === "dom" && step.surfacePlan.replay !== "blocked")) substrates.add("dom");
  if (contract.sourceIdentityCoverage.linkedSteps > 0) substrates.add("source");
  if (manifest && manifest.status !== "blocked") substrates.add("mcp");
  return [...substrates];
}

function mutationActionNames(contract: WorkflowContractV7): string[] {
  return contract.mutationBoundaryPlan.mutationSteps.map((step) => `mutation:${step.kind}:${step.stepId}`);
}

function limitationGuardrailRule(limitation: WorkflowLimitationV7): string {
  switch (limitation) {
    case "mutationRequiresIsolation":
      return "Mutation replay must use confirmation or isolated CI before production execution.";
    case "sourceIdentityMissing":
      return "Prefer source-backed affordance metadata before unattended execution.";
    case "lowConfidenceLocator":
      return "Block unattended execution when the target locator confidence remains low.";
    case "iframeNeedsFrameLocator":
      return "Require durable frame-locator context before replaying iframe actions.";
    case "popupOrMultiTab":
      return "Require explicit target ownership and origin consent for popup or multi-tab replay.";
    case "canvasCoordinateOnly":
      return "Do not use canvas coordinates as production proof without app-level semantics.";
    case "closedShadowDomBlocked":
      return "Require app-level affordances for closed Shadow DOM targets.";
    case "pointerDragUnreliable":
      return "Require explicit drag semantics or human review before replaying pointer-drag actions.";
    case "crossOriginTrace":
      return "Require exact target-origin consent before replaying cross-origin workflow steps.";
    case "redactedInputValue":
      return "Require caller-supplied parameters for redacted input values.";
    case "unresolvedStep":
      return "Resolve ambiguous workflow steps before publishing unattended capability.";
    default:
      return "Review and harden this workflow limitation before production execution.";
  }
}

function autonomyLevelFor(level: DojoEntrustmentLevel): DojoPermissionLicense["autonomy_level"] {
  switch (level) {
    case "E0":
      return "observe";
    case "E1":
      return "practice";
    case "E2":
      return "draft";
    case "E3":
      return "submit_limited";
    case "E4":
      return "submit_gated";
    case "E5":
      return "submit_gated";
    case "EX":
      return "blocked";
  }
}

function licenseSummary(license: DojoPermissionLicense): DojoProofValidation["license"] {
  return {
    skill_id: license.skill_id,
    license_version: license.license_version,
    entrustment_level: license.entrustment_level,
  };
}

function isStableIdentifier(value: string): boolean {
  return /(^|_)(id|uuid|key|slug|number|code)$/.test(value.toLowerCase());
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .replace(/^synthi_app_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "workflow";
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = keyFor(item);
    if (!out.has(key)) out.set(key, item);
  }
  return [...out.values()];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
