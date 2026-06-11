import { createHash, randomUUID } from "node:crypto";
import type { PrivateWorkflowToolManifestV7 } from "./private_tool_manifest.js";
import type { WorkflowContractV7, WorkflowLimitationV7, WorkflowStepContractV7 } from "./workflow.js";

export type DojoEntrustmentLevel = "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "EX";
export type DojoSkillReadinessLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type DojoExecutionSubstrate = "vision" | "dom" | "source" | "api" | "mcp";
export type DojoScenarioTier = 0 | 1 | 2 | 3 | 4 | 5;
export type DojoCheckrideLayer = "knowledge" | "risk" | "skill";
export type DojoCheckrideStatus = "passed" | "failed" | "blocked";

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
  context_claims: Record<string, unknown>;
  evidence_claims: DojoEvidenceClaim[];
  guardrails_active: string[];
  substrate_claim: DojoExecutionSubstrate;
  assurance_case_ref: string;
  issued_at: string;
  expires_at: string;
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
  skill_id: string;
  skill_version: string;
  entrustment_level: DojoEntrustmentLevel;
  readiness_level: DojoSkillReadinessLevel;
  checkride_id: string;
  license_id: string;
  assurance_case_id: string;
  proof_required: boolean;
}

export interface DojoSkill {
  schema_version: "synthi.dojo.skill.v1";
  skill_id: string;
  workspace_id: string;
  workflow_id: string;
  skill_version: string;
  name: string;
  intent: string;
  app_origin: string;
  skill_seed: DojoSkillSeed;
  scenarios: DojoScenario[];
  checkride: DojoCheckrideReport;
  case_law: DojoSkillCase[];
  guardrails: DojoGuardrail[];
  permission_license: DojoPermissionLicense;
  entrustment_level: DojoEntrustmentLevel;
  skill_readiness_level: DojoSkillReadinessLevel;
  proof_capsule_schema: Record<string, unknown>;
  assurance_case: DojoAssuranceCase;
  skill_card: DojoSkillCard;
  skill_passport: DojoSkillPassport;
  execution_substrates: DojoExecutionSubstrate[];
  preferred_substrate: DojoExecutionSubstrate;
  published_tool_name?: string;
  private_tool_manifest?: PrivateWorkflowToolManifestV7;
  generated_at: string;
}

export interface DojoRepoArtifact {
  path: string;
  content: string;
  content_type: "application/json" | "text/markdown";
  sensitive: false;
}

export interface DojoProofValidation {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  error?: string;
  blocked_by: string[];
  license: {
    skill_id: string;
    license_version: string;
    entrustment_level: DojoEntrustmentLevel;
  };
}

export class DojoSkillRegistry {
  private readonly bySkillId = new Map<string, DojoSkill>();
  private readonly byWorkflowId = new Map<string, string>();

  publish(skill: DojoSkill): DojoSkill {
    const clone = cloneJson(skill);
    this.bySkillId.set(clone.skill_id, clone);
    this.byWorkflowId.set(clone.workflow_id, clone.skill_id);
    return cloneJson(clone);
  }

  get(skillId: string): DojoSkill | null {
    const skill = this.bySkillId.get(skillId);
    return skill ? cloneJson(skill) : null;
  }

  getByWorkflowId(workflowId: string): DojoSkill | null {
    const skillId = this.byWorkflowId.get(workflowId);
    return skillId ? this.get(skillId) : null;
  }

  list(): DojoSkill[] {
    return [...this.bySkillId.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.skill_id.localeCompare(b.skill_id))
      .map(cloneJson);
  }

  resetForTests(): void {
    this.bySkillId.clear();
    this.byWorkflowId.clear();
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
  const substrates = executionSubstratesFor(contract, options.private_tool_manifest);
  const preferredSubstrate = substrates.includes("mcp")
    ? "mcp"
    : substrates.includes("source")
    ? "source"
    : substrates.includes("dom")
    ? "dom"
    : "vision";

  return {
    schema_version: "synthi.dojo.skill.v1",
    skill_id: skillId,
    workspace_id: seed.workspace_id,
    workflow_id: contract.workflowId,
    skill_version: skillVersion,
    name: contract.name,
    intent: contract.description || contract.name,
    app_origin: contract.appOrigin,
    skill_seed: seed,
    scenarios,
    checkride,
    case_law: caseLaw,
    guardrails,
    permission_license: license,
    entrustment_level: license.entrustment_level,
    skill_readiness_level: checkride.readiness_level,
    proof_capsule_schema: proofCapsuleSchemaFor(license),
    assurance_case: assuranceCase,
    skill_card: skillCardFor(contract, checkride, guardrails, license),
    skill_passport: {
      skill_id: skillId,
      skill_version: skillVersion,
      entrustment_level: license.entrustment_level,
      readiness_level: checkride.readiness_level,
      checkride_id: checkride.checkride_id,
      license_id: license.license_id,
      assurance_case_id: assuranceCase.assurance_case_id,
      proof_required: license.proof_requirements.required_evidence_claims.length > 0,
    },
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
    substrate_claim?: DojoExecutionSubstrate;
    expires_at?: string;
    now?: string;
  } = {}
): DojoProofCarryingSkillCapsule {
  const now = input.now ?? new Date().toISOString();
  const expiresAt = input.expires_at ?? new Date(Date.parse(now) + 15 * 60_000).toISOString();
  const capsuleWithoutSignature = {
    schema_version: "synthi.dojo.proofCapsule.v1" as const,
    capsule_id: `capsule_${randomUUID()}`,
    skill_id: skill.skill_id,
    skill_version: skill.skill_version,
    requested_action: requestedAction,
    license_version: skill.permission_license.license_version,
    entrustment_level: skill.entrustment_level,
    context_claims: input.context_claims ?? {},
    evidence_claims: input.evidence_claims ?? defaultEvidenceClaimsFor(skill),
    guardrails_active: skill.guardrails.map((guardrail) => guardrail.guardrail_id),
    substrate_claim: input.substrate_claim ?? skill.preferred_substrate,
    assurance_case_ref: skill.assurance_case.assurance_case_id,
    issued_at: now,
    expires_at: expiresAt,
  };
  return {
    ...capsuleWithoutSignature,
    signature: signatureForCapsule(capsuleWithoutSignature),
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
  if (Date.parse(capsule.expires_at) <= Date.parse(now)) blockedBy.push("proof_capsule_expired");
  if (capsule.signature !== signatureForCapsule(unsignedCapsule(capsule))) blockedBy.push("proof_capsule_signature_invalid");

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
      license: licenseSummary(license),
    };
  }

  if (gatedAction) {
    return {
      ok: false,
      status: "approval_required",
      error: "dojo_action_requires_approval",
      blocked_by: gatedAction.constraints,
      license: licenseSummary(license),
    };
  }

  return {
    ok: true,
    status: "allowed",
    blocked_by: [],
    license: licenseSummary(license),
  };
}

export function exportDojoRepoArtifacts(skill: DojoSkill): DojoRepoArtifact[] {
  const root = `.synthi/dojo/skills/${skillPathSegment(skill)}`;
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
      path: `${root}/case-law.md`,
      content_type: "text/markdown",
      sensitive: false,
      content: caseLawMarkdown(skill),
    },
    {
      path: `${root}/mcp.manifest.json`,
      content_type: "application/json",
      sensitive: false,
      content: json(skill.private_tool_manifest ?? {
        kind: "dojoMcpSkillBusManifest",
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        published_tool_name: skill.published_tool_name ?? null,
      }),
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

function redactedSkillArtifact(skill: DojoSkill): Record<string, unknown> {
  return {
    schema_version: skill.schema_version,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    workflow_id: skill.workflow_id,
    skill_version: skill.skill_version,
    name: skill.name,
    intent: skill.intent,
    app_origin: skill.app_origin,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    proof_required: skill.skill_passport.proof_required,
    preferred_substrate: skill.preferred_substrate,
    execution_substrates: skill.execution_substrates,
    published_tool_name: skill.published_tool_name ?? null,
    generated_at: skill.generated_at,
  };
}

function skillGraphArtifact(skill: DojoSkill): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    nodes: [
      { id: "trigger", kind: "Trigger", label: "MCP skill call" },
      { id: "input", kind: "Input", label: "Validate input schema", inputs: skill.skill_seed.input_schema },
      { id: "permission", kind: "Permission", label: skill.permission_license.entrustment_level },
      ...skill.guardrails.map((guardrail) => ({
        id: guardrail.guardrail_id,
        kind: "Guardrail",
        label: guardrail.title,
        rule: guardrail.rule,
      })),
      { id: "proof", kind: "Proof", label: "Validate proof capsule" },
      { id: "action", kind: "Action", label: skill.published_tool_name ?? "Workflow replay" },
      { id: "assertion", kind: "Assertion", label: "Verify success assertions" },
    ],
    edges: [
      ["trigger", "input"],
      ["input", "permission"],
      ["permission", "proof"],
      ...skill.guardrails.map((guardrail) => ["permission", guardrail.guardrail_id]),
      ["proof", "action"],
      ["action", "assertion"],
    ],
  };
}

function vivariumArtifact(skill: DojoSkill): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.workspaceOrganoid.v1",
    organoid_id: `organoid_${skill.skill_seed.seed_id}`,
    skill_seed_id: skill.skill_seed.seed_id,
    workspace_id: skill.workspace_id,
    generated_at: skill.generated_at,
    version: "0.1.0",
    tissues: {
      ui: { surfaces: skill.skill_seed.touched_surfaces },
      data: { models: skill.skill_seed.touched_data_models, inputs: skill.skill_seed.input_schema },
      policy: { clues: skill.skill_seed.policy_clues },
      identity: { auth_required: skill.skill_seed.policy_clues.some((clue) => clue.source === "auth") },
      document: { synthetic_only: true },
      api: { anchors: skill.skill_seed.source_or_api_anchors.filter((anchor) => anchor.kind === "api") },
      failure: { modes: skill.skill_seed.candidate_failure_modes },
      adversary: { scenarios: skill.scenarios.filter((scenario) => scenario.layer === "risk").map((scenario) => scenario.scenario_id) },
      evidence: { expected: skill.skill_seed.output_schema.evidence },
      source: { anchors: skill.skill_seed.source_or_api_anchors },
      license: { license_id: skill.permission_license.license_id },
    },
    scenarios: skill.scenarios,
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

function signatureForCapsule(capsule: Omit<DojoProofCarryingSkillCapsule, "signature">): string {
  return `sha256:${createHash("sha256").update(stableStringify(capsule)).digest("hex")}`;
}

function unsignedCapsule(capsule: DojoProofCarryingSkillCapsule): Omit<DojoProofCarryingSkillCapsule, "signature"> {
  const { signature: _signature, ...rest } = capsule;
  return rest;
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
