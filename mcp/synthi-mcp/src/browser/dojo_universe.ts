import { createHash } from "node:crypto";
import type {
  DojoGuardrail,
  DojoScenario,
  DojoScenarioResult,
  DojoSkill,
  DojoSkillReadinessLevel,
} from "./dojo.js";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  validateDojoAffordancePrPlan,
  type DojoAffordancePatchOperation,
  type DojoAffordancePrPlan,
} from "../dojo/source/affordance_pr_plan.js";

export interface DojoLifecycleReport {
  schema_version: "synthi.dojo.lifecycleReport.v1";
  lifecycle_id: string;
  skill_id: string;
  status: "draft" | "active" | "expires_soon" | "expired" | "blocked";
  entrustment_level: string;
  readiness_level: DojoSkillReadinessLevel;
  issued_at: string;
  expires_at: string;
  days_until_expiry: number | null;
  recertification: {
    required: boolean;
    downgrade_to: string | null;
    triggers: string[];
    smallest_actions: string[];
  };
  release_gates: Array<{
    gate_id: string;
    label: string;
    status: "passed" | "blocked" | "approval_required";
    evidence_refs: string[];
  }>;
}

export interface DojoGovernanceReport {
  schema_version: "synthi.dojo.governanceReport.v1";
  governance_id: string;
  skill_id: string;
  workspace_id: string;
  approval_queue: Array<{ action: string; constraints: string[]; reason: string }>;
  policy_gates: Array<{ gate_id: string; label: string; enforced_by: string[]; status: "active" | "needs_review" }>;
  audit_report: {
    proof_required: boolean;
    evidence_claims: string[];
    blocked_actions: string[];
    case_law_refs: string[];
    generated_artifact_policy: string;
  };
  compliance_exports: string[];
  review_workflows: string[];
}

export interface DojoUniverseMetrics {
  schema_version: "synthi.dojo.metrics.v1";
  generated_at: string;
  skill_count: number;
  technical: {
    average_checkride_pass_rate: number;
    average_coverage_score: number;
    average_attack_success_rate: number;
    node_graduation_to_mcp_percent: number;
    false_allow_rate: number;
    false_block_rate: number;
    recertification_due_count: number;
  };
  business: {
    published_skill_count: number;
    reviewable_artifact_sets: number;
    mcp_backed_skill_count: number;
    source_affordance_patch_count: number;
    skills_at_srl7_or_higher: number;
  };
  trust: {
    proof_required_percent: number;
    risky_action_gate_percent: number;
    skills_with_case_law_percent: number;
    stale_or_expired_license_count: number;
    high_risk_ui_fallback_count: number;
  };
}

export interface DojoEvidenceLedger {
  schema_version: "synthi.dojo.evidenceLedger.v1";
  ledger_id: string;
  skill_id: string;
  workspace_id: string;
  storage_model: {
    live_state_store: "encrypted_workspace_store";
    repo_export_policy: "metadata_and_redacted_references_only";
    production_data_allowed_in_organoid: false;
    secrets_allowed_in_repo: false;
  };
  retention_policy: {
    evidence_refs_only: boolean;
    screenshots_redacted_by_default: boolean;
    recertify_after_days: number;
  };
  records: Array<{
    record_id: string;
    kind: "trace" | "scenario" | "checkride" | "case_law" | "guardrail" | "license" | "proof" | "artifact";
    ref: string;
    redaction: "none" | "metadata_only" | "redacted";
    hash: string;
    previous_hash: string | null;
  }>;
  head_hash: string;
}

export interface DojoSourceAffordancePrPlan {
  schema_version: "synthi.dojo.sourceAffordancePrPlan.v1";
  plan_id: string;
  skill_id: string;
  workflow_id: string;
  readiness: "ready_for_review" | "source_mapping_needed" | "not_applicable";
  patch_count: number;
  files: Array<{
    file_path: string;
    source_anchor_id?: string;
    patches: Array<{
      patch_id: string;
      action_id: string;
      intent: string;
      suggested_attribute: string;
      risk_annotation: string;
      success_hook: string;
      proof_hook: string;
      review_required: boolean;
    }>;
  }>;
  typed_patch_plan: DojoAffordancePrPlan;
  generated_tests: Array<{ path: string; purpose: string }>;
  review_checklist: string[];
}

export interface DojoPackageReadiness {
  schema_version: "synthi.dojo.packageReadiness.v1";
  skill_id: string;
  enterprise: Array<{ package: string; status: "ready" | "partial" | "blocked"; evidence: string[]; gaps: string[] }>;
  personal: Array<{ package: string; status: "ready" | "partial" | "blocked"; evidence: string[]; gaps: string[] }>;
}

export interface DojoTimeMachineDebugReport {
  schema_version: "synthi.dojo.timeMachineDebugger.v1";
  debug_id: string;
  skill_id: string;
  workflow_id: string;
  question: string;
  baseline: {
    scenario_id: string | null;
    mutation_kind: string | null;
    status: string;
    finding: string;
  };
  counterfactual: {
    changed_variable: string;
    expected_status_after_change: "passed" | "blocked";
    causal_finding: string;
    license_impact: string;
  };
  guardrails: DojoGuardrail[];
  replay_plan: Array<{ step: string; simulator_tier: number; expected_evidence: string[] }>;
}

export interface DojoUniverseDossier {
  schema_version: "synthi.dojo.universeDossier.v1";
  dossier_id: string;
  generated_at: string;
  skill_id: string;
  workspace_id: string;
  product_loop: string[];
  lifecycle: DojoLifecycleReport;
  governance: DojoGovernanceReport;
  metrics: DojoUniverseMetrics;
  evidence_ledger: DojoEvidenceLedger;
  source_affordance_pr_plan: DojoSourceAffordancePrPlan;
  package_readiness: DojoPackageReadiness;
  time_machine_debugger: DojoTimeMachineDebugReport;
  dual_experience: {
    personal_skill_card: Record<string, unknown>;
    enterprise_cortex_summary: Record<string, unknown>;
  };
}

export interface DojoOrganizationRegistry {
  schema_version: "synthi.dojo.organizationRegistry.v1";
  generated_at: string;
  skill_count: number;
  competencies: Array<{
    skill_id: string;
    workspace_id: string;
    name: string;
    entrustment_level: string;
    readiness_level: number;
    status: string;
    proof_required: boolean;
    published_tools: string[];
    case_law_count: number;
    antibody_count: number;
    next_recertification: string;
  }>;
  case_law_registry: Array<{ case_id: string; skill_id: string; title: string; status: string; binding_scope: string; rule: string }>;
  antibody_registry: Array<{ antibody_id: string; skill_id: string; trigger: string; response: string; binding_scope: string }>;
  metrics: DojoUniverseMetrics;
}

export function buildDojoUniverseDossier(
  skill: DojoSkill,
  allSkills: DojoSkill[] = [skill],
  options: { now?: string; question?: string; mutation_kind?: string } = {}
): DojoUniverseDossier {
  const now = options.now ?? new Date().toISOString();
  return {
    schema_version: "synthi.dojo.universeDossier.v1",
    dossier_id: `universe_${hash(`${skill.skill_id}:${skill.skill_version}:${now}`)}`,
    generated_at: now,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    product_loop: [
      "teach_mode_trace",
      "skill_seed",
      "skill_cortex",
      "workspace_organoid",
      "workflow_wind_tunnel",
      "skill_checkride",
      "failure_case_law",
      "guardrails",
      "entrustment_license",
      "proof_carrying_skill_capsule",
      "mcp_skill_bus",
      "production_agent_call",
      "new_evidence_and_case_law",
    ],
    lifecycle: buildDojoLifecycleReport(skill, { now }),
    governance: buildDojoGovernanceReport(skill),
    metrics: buildDojoUniverseMetrics(allSkills, { now }),
    evidence_ledger: buildDojoEvidenceLedger(skill),
    source_affordance_pr_plan: buildDojoSourceAffordancePrPlan(skill),
    package_readiness: buildDojoPackageReadiness(skill),
    time_machine_debugger: runDojoTimeMachineDebugger(skill, {
      question: options.question,
      mutation_kind: options.mutation_kind,
    }),
    dual_experience: {
      personal_skill_card: {
        ...skill.skill_card,
        entrustment_dial: entrustmentDialFor(skill),
        proof_badge: skill.skill_card.proof_badge,
        undo_backpack: skill.rollback_policy,
      },
      enterprise_cortex_summary: {
        skill_id: skill.skill_id,
        workflow_graph_id: skill.workflow_graph_id,
        vivarium_id: skill.vivarium_id,
        source_anchor_count: skill.source_links.length,
        published_tools: skill.published_tools,
        proof_required: skill.skill_passport.proof_required,
        case_law_refs: skill.case_law_refs,
        artifact_sets: [".synthi/dojo/skills", ".synthi/dojo/workflows", ".synthi/dojo/mcp"],
      },
    },
  };
}

export function buildDojoOrganizationRegistry(
  skills: DojoSkill[],
  options: { now?: string } = {}
): DojoOrganizationRegistry {
  const now = options.now ?? new Date().toISOString();
  return {
    schema_version: "synthi.dojo.organizationRegistry.v1",
    generated_at: now,
    skill_count: skills.length,
    competencies: skills.map((skill) => {
      const lifecycle = buildDojoLifecycleReport(skill, { now });
      return {
        skill_id: skill.skill_id,
        workspace_id: skill.workspace_id,
        name: skill.name,
        entrustment_level: skill.entrustment_level,
        readiness_level: skill.skill_readiness_level,
        status: lifecycle.status,
        proof_required: skill.skill_passport.proof_required,
        published_tools: skill.published_tools,
        case_law_count: skill.case_law.length,
        antibody_count: skill.antibodies.length,
        next_recertification: skill.license_expires_at,
      };
    }),
    case_law_registry: skills.flatMap((skill) => skill.case_law.map((item) => ({
      case_id: item.case_id,
      skill_id: skill.skill_id,
      title: item.title,
      status: item.status,
      binding_scope: item.binding_scope,
      rule: item.rule_created,
    }))),
    antibody_registry: skills.flatMap((skill) => skill.antibodies.map((item) => ({
      antibody_id: item.antibody_id,
      skill_id: skill.skill_id,
      trigger: item.trigger,
      response: item.response,
      binding_scope: item.binding_scope,
    }))),
    metrics: buildDojoUniverseMetrics(skills, { now }),
  };
}

export function buildDojoLifecycleReport(skill: DojoSkill, options: { now?: string } = {}): DojoLifecycleReport {
  const now = options.now ?? new Date().toISOString();
  const expiryMs = Date.parse(skill.license_expires_at);
  const nowMs = Date.parse(now);
  const daysUntilExpiry = Number.isFinite(expiryMs) && Number.isFinite(nowMs)
    ? Math.ceil((expiryMs - nowMs) / 86_400_000)
    : null;
  const expired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
  const expiresSoon = daysUntilExpiry !== null && daysUntilExpiry <= 7;
  const blocked = skill.entrustment_level === "EX" || skill.checkride.critical_failures > 0;
  const recertRequired = blocked || expired || skill.retrain_triggers.length > 0 && expiresSoon;
  return {
    schema_version: "synthi.dojo.lifecycleReport.v1",
    lifecycle_id: `lifecycle_${hash(`${skill.skill_id}:${skill.permission_license.license_id}:${skill.license_expires_at}`)}`,
    skill_id: skill.skill_id,
    status: blocked ? "blocked" : expired ? "expired" : expiresSoon ? "expires_soon" : skill.published_tools.length ? "active" : "draft",
    entrustment_level: skill.entrustment_level,
    readiness_level: skill.skill_readiness_level,
    issued_at: skill.permission_license.issued_at,
    expires_at: skill.license_expires_at,
    days_until_expiry: daysUntilExpiry,
    recertification: {
      required: recertRequired,
      downgrade_to: blocked || expired ? "EX" : expiresSoon ? "E1" : null,
      triggers: skill.retrain_triggers.map((trigger) => trigger.condition),
      smallest_actions: lifecycleActionsFor(skill, recertRequired),
    },
    release_gates: [
      {
        gate_id: "license_scope",
        label: "Requested action is in the current license scope.",
        status: skill.permission_license.allowed_actions.some((action) => action.action === "run_workflow") ? "passed" : "blocked",
        evidence_refs: [skill.permission_license.license_id],
      },
      {
        gate_id: "proof_capsule",
        label: "Production action must carry a valid proof capsule.",
        status: skill.skill_passport.proof_required ? "approval_required" : "passed",
        evidence_refs: [skill.assurance_case.assurance_case_id],
      },
      {
        gate_id: "guardrails_active",
        label: "Binding case-law guardrails are active.",
        status: skill.guardrails.length > 0 ? "passed" : "blocked",
        evidence_refs: skill.guardrails.map((guardrail) => guardrail.guardrail_id),
      },
    ],
  };
}

export function buildDojoGovernanceReport(skill: DojoSkill): DojoGovernanceReport {
  return {
    schema_version: "synthi.dojo.governanceReport.v1",
    governance_id: `governance_${hash(`${skill.skill_id}:${skill.permission_license.license_id}`)}`,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    approval_queue: skill.permission_license.gated_actions.map((action) => ({
      action: action.action,
      constraints: action.constraints,
      reason: "Action is licensed only with explicit approval or extra evidence.",
    })),
    policy_gates: [
      ...skill.guardrails.map((guardrail) => ({
        gate_id: guardrail.guardrail_id,
        label: guardrail.title,
        enforced_by: guardrail.source_case_id ? [guardrail.source_case_id] : [],
        status: "active" as const,
      })),
      ...skill.permission_license.substrate_requirements.map((requirement) => ({
        gate_id: `substrate_${hash(`${requirement.action}:${requirement.allowed_substrates.join(",")}`)}`,
        label: `${requirement.action} substrate limited to ${requirement.allowed_substrates.join(", ")}`,
        enforced_by: [skill.permission_license.license_id],
        status: requirement.allowed_substrates.length > 0 ? "active" as const : "needs_review" as const,
      })),
    ],
    audit_report: {
      proof_required: skill.skill_passport.proof_required,
      evidence_claims: skill.permission_license.evidence_requirements.map((claim) => claim.claim),
      blocked_actions: skill.permission_license.blocked_actions.map((action) => action.action),
      case_law_refs: skill.case_law_refs,
      generated_artifact_policy: "repo artifacts contain metadata and redacted references only",
    },
    compliance_exports: [
      "skill_assurance_case",
      "permission_license",
      "proof_capsule_schema",
      "case_law",
      "redacted_evidence_manifest",
      "training_report",
    ],
    review_workflows: [
      "security_review_license_scope",
      "engineering_review_source_affordances",
      "operations_review_approval_queue",
      "recertify_on_drift_or_incident",
    ],
  };
}

export function buildDojoUniverseMetrics(skills: DojoSkill[], options: { now?: string } = {}): DojoUniverseMetrics {
  const now = options.now ?? new Date().toISOString();
  const list = skills.length > 0 ? skills : [];
  const count = list.length;
  const riskyActions = list.flatMap((skill) => [...skill.permission_license.gated_actions, ...skill.permission_license.blocked_actions]);
  const mcpBacked = list.filter((skill) => skill.execution_substrates.includes("mcp") || skill.published_tools.length > 0).length;
  const sourcePatchCount = list.reduce((sum, skill) => sum + buildDojoSourceAffordancePrPlan(skill).patch_count, 0);
  const expiredCount = list.filter((skill) => buildDojoLifecycleReport(skill, { now }).status === "expired").length;
  return {
    schema_version: "synthi.dojo.metrics.v1",
    generated_at: now,
    skill_count: count,
    technical: {
      average_checkride_pass_rate: avg(list.map((skill) => passRate(skill.checkride.results))),
      average_coverage_score: avg(list.map((skill) => skill.coverage_score)),
      average_attack_success_rate: avg(list.map((skill) => skill.attack_success_rate)),
      node_graduation_to_mcp_percent: ratio(mcpBacked, count),
      false_allow_rate: avg(list.map((skill) => skill.false_allow_rate)),
      false_block_rate: avg(list.map((skill) => skill.false_block_rate)),
      recertification_due_count: list.filter((skill) => buildDojoLifecycleReport(skill, { now }).recertification.required).length,
    },
    business: {
      published_skill_count: list.filter((skill) => skill.published_tools.length > 0).length,
      reviewable_artifact_sets: count,
      mcp_backed_skill_count: mcpBacked,
      source_affordance_patch_count: sourcePatchCount,
      skills_at_srl7_or_higher: list.filter((skill) => skill.skill_readiness_level >= 7).length,
    },
    trust: {
      proof_required_percent: ratio(list.filter((skill) => skill.skill_passport.proof_required).length, count),
      risky_action_gate_percent: ratio(riskyActions.length, Math.max(riskyActions.length + list.flatMap((skill) => skill.permission_license.allowed_actions).length, 1)),
      skills_with_case_law_percent: ratio(list.filter((skill) => skill.case_law.length > 0).length, count),
      stale_or_expired_license_count: expiredCount,
      high_risk_ui_fallback_count: list.filter((skill) => skill.preferred_substrate === "vision" && skill.permission_license.gated_actions.length > 0).length,
    },
  };
}

export function buildDojoEvidenceLedger(skill: DojoSkill): DojoEvidenceLedger {
  const refs = [
    { kind: "trace" as const, ref: `workflow:${skill.workflow_id}` },
    ...skill.scenarios.map((scenario) => ({ kind: "scenario" as const, ref: `scenario:${scenario.scenario_id}` })),
    { kind: "checkride" as const, ref: skill.checkride.checkride_id },
    ...skill.case_law.map((item) => ({ kind: "case_law" as const, ref: item.case_id })),
    ...skill.guardrails.map((item) => ({ kind: "guardrail" as const, ref: item.guardrail_id })),
    { kind: "license" as const, ref: skill.permission_license.license_id },
    { kind: "proof" as const, ref: skill.assurance_case.assurance_case_id },
    { kind: "artifact" as const, ref: `.synthi/dojo/skills/${slug(skill.name)}` },
  ];
  let previous: string | null = null;
  const records = refs.map((item, index) => {
    const recordId = `evidence_${String(index + 1).padStart(3, "0")}_${hash(`${skill.skill_id}:${item.kind}:${item.ref}`)}`;
    const digest = hash(JSON.stringify({ recordId, item, previous }));
    const record = {
      record_id: recordId,
      kind: item.kind,
      ref: item.ref,
      redaction: item.kind === "artifact" || item.kind === "trace" ? "metadata_only" as const : "redacted" as const,
      hash: digest,
      previous_hash: previous,
    };
    previous = digest;
    return record;
  });
  return {
    schema_version: "synthi.dojo.evidenceLedger.v1",
    ledger_id: `ledger_${hash(`${skill.skill_id}:${records.at(-1)?.hash ?? "empty"}`)}`,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    storage_model: {
      live_state_store: "encrypted_workspace_store",
      repo_export_policy: "metadata_and_redacted_references_only",
      production_data_allowed_in_organoid: false,
      secrets_allowed_in_repo: false,
    },
    retention_policy: {
      evidence_refs_only: true,
      screenshots_redacted_by_default: skill.evidence_policy.screenshot_redaction !== "never",
      recertify_after_days: skill.permission_license.expiry_policy.recertify_after_days,
    },
    records,
    head_hash: records.at(-1)?.hash ?? hash("empty"),
  };
}

export function buildDojoSourceAffordancePrPlan(skill: DojoSkill): DojoSourceAffordancePrPlan {
  const files = new Map<string, DojoSourceAffordancePrPlan["files"][number]>();
  const typedOperations: DojoAffordancePatchOperation[] = [];
  for (const action of skill.agent_ready_ui_contract.actions) {
    const anchor = action.source_anchor_id
      ? skill.source_links.find((item) => item.anchor_id === action.source_anchor_id)
      : skill.source_links.find((item) => item.source_step_id === action.source_step_id);
    const filePath = anchor?.file_path ?? "UNMAPPED_SOURCE_AFFORDANCES.md";
    const targetComponent = inferReactComponentName(filePath, action.label);
    const targetMatch = { role: "action" as const, text: action.label };
    const row = files.get(filePath) ?? { file_path: filePath, ...(anchor?.anchor_id ? { source_anchor_id: anchor.anchor_id } : {}), patches: [] };
    row.patches.push({
      patch_id: `patch_${hash(`${skill.skill_id}:${action.action_id}:${filePath}`)}`,
      action_id: action.action_id,
      intent: `Expose ${action.label} as a stable agent affordance.`,
      suggested_attribute: action.stable_locator ?? `data-synthi-action="${slug(action.label)}"`,
      risk_annotation: `data-synthi-risk="${action.risk_tags[0] ?? "workflow_action"}"`,
      success_hook: `data-synthi-success="${slug(action.success_condition)}"`,
      proof_hook: `data-synthi-proof-required="${action.proof_claims.length > 0 ? "true" : "false"}"`,
      review_required: action.allowed_substrates.includes("vision") || !action.stable_locator,
    });
    typedOperations.push(stableLocatorPatchOperation({
      file_path: filePath,
      target_component: targetComponent,
      target_match: targetMatch,
      affordance_id: action.action_id,
      locator_attribute: "data-agent-action",
    }));
    if (action.proof_claims.length > 0) {
      typedOperations.push(proofHookPatchOperation({
        file_path: filePath,
        target_component: targetComponent,
        target_match: targetMatch,
        affordance_id: action.action_id,
        hook_name: "assertDojoProof",
      }));
    }
    files.set(filePath, row);
  }
  const patchCount = [...files.values()].reduce((sum, file) => sum + file.patches.length, 0);
  const typedPatchPlan: DojoAffordancePrPlan = {
    schema_version: "synthi.dojo.affordancePrPlan.v1",
    plan_id: `typed_source_pr_${hash(`${skill.skill_id}:${typedOperations.map((operation) => operation.operation_id).join(":")}`)}`,
    app_origin: skill.app_origin,
    app_version: skill.app_model_version,
    operations: typedOperations,
    required_tests: [
      `npm test -- ${slug(skill.name)}.dojo-affordance`,
      "npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check",
    ],
    review_gates: [
      "code_owner",
      "security_for_risky_action",
      "dojo_checkride_after_source_patch",
    ],
  };
  const typedPatchPlanValidation = validateDojoAffordancePrPlan(typedPatchPlan);
  return {
    schema_version: "synthi.dojo.sourceAffordancePrPlan.v1",
    plan_id: `source_pr_${hash(`${skill.skill_id}:${patchCount}:${skill.source_links.length}`)}`,
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    readiness: patchCount === 0 ? "not_applicable" : skill.source_links.length > 0 ? "ready_for_review" : "source_mapping_needed",
    patch_count: patchCount,
    files: [...files.values()].sort((a, b) => a.file_path.localeCompare(b.file_path)),
    typed_patch_plan: {
      ...typedPatchPlan,
      review_gates: typedPatchPlanValidation.ok
        ? typedPatchPlan.review_gates
        : [...typedPatchPlan.review_gates, ...typedPatchPlanValidation.issues.map((issue) => `fix_${issue.issue_id}`)],
    },
    generated_tests: [
      { path: `.synthi/dojo/playwright/${slug(skill.name)}.spec.ts`, purpose: "Verify agent-visible affordances remain reachable." },
      { path: `.synthi/dojo/reports/${slug(skill.name)}.training-report.md`, purpose: "Review post-affordance checkride evidence." },
    ],
    review_checklist: [
      "Confirm no raw secrets or production data are embedded in affordance metadata.",
      "Confirm every risky action has a proof or approval hook.",
      "Confirm stable locators are scoped to the intended route and workspace.",
      "Re-run Dojo checkride after merging source affordance changes.",
    ],
  };
}

export function buildDojoPackageReadiness(skill: DojoSkill): DojoPackageReadiness {
  const hasLicense = skill.permission_license.allowed_actions.length + skill.permission_license.gated_actions.length > 0;
  const hasHardening = skill.workspace_organoid.scenario_refs.length > 0 && skill.evil_twin.attacks.length > 0;
  const hasSourcePlan = buildDojoSourceAffordancePrPlan(skill).patch_count > 0;
  return {
    schema_version: "synthi.dojo.packageReadiness.v1",
    skill_id: skill.skill_id,
    enterprise: [
      packageRow("Dojo Builder", skill.skill_seed.input_schema.length >= 0 && skill.skill_cortex.nodes.length > 0, [
        skill.skill_seed.seed_id,
        skill.skill_cortex.workflow_graph_id,
        skill.private_tool_manifest?.tool_name ?? "private_tool_manifest_preview",
      ]),
      packageRow("Dojo Governance", hasLicense && skill.skill_passport.proof_required, [
        skill.permission_license.license_id,
        skill.proof_capsule_schema["$id"] ? String(skill.proof_capsule_schema["$id"]) : "proof_capsule_schema",
      ]),
      packageRow("Dojo Hardening", hasHardening, [
        skill.workspace_organoid.organoid_id,
        skill.wind_tunnel.wind_tunnel_id,
        skill.evil_twin.red_team_id,
      ]),
      packageRow("Dojo Source-Aware", hasSourcePlan || skill.source_links.length > 0, [
        skill.agent_ready_ui_contract.contract_id,
        buildDojoSourceAffordancePrPlan(skill).plan_id,
      ], hasSourcePlan ? [] : ["source_mapping_needed"]),
      packageRow("Dojo Assurance", Boolean(skill.assurance_case.assurance_case_id && skill.case_law_refs), [
        skill.assurance_case.assurance_case_id,
        skill.checkride.checkride_id,
      ]),
    ],
    personal: [
      packageRow("Personal Dojo", Boolean(skill.skill_card.title), [skill.skill_passport.passport_id]),
      packageRow("Personal Pro", Boolean(skill.skill_genome.genome_id && skill.antibodies.length >= 0), [skill.skill_genome.genome_id]),
      packageRow("Family or Team", skill.skill_genome.portable_to.length > 0, [skill.skill_genome.pattern_id]),
    ],
  };
}

export function runDojoTimeMachineDebugger(
  skill: DojoSkill,
  input: { question?: string; mutation_kind?: string; scenario_id?: string } = {}
): DojoTimeMachineDebugReport {
  const scenario = selectScenario(skill, input);
  const result = scenario
    ? skill.checkride.results.find((item) => item.scenario_id === scenario.scenario_id) ?? null
    : null;
  const guardrails = relatedGuardrails(skill, scenario, result);
  const mutationKind = scenario?.mutation_kind ?? input.mutation_kind ?? "unknown";
  const changedVariable = variableForMutation(mutationKind);
  const expectedStatus = result?.status === "passed" ? "passed" : "blocked";
  return {
    schema_version: "synthi.dojo.timeMachineDebugger.v1",
    debug_id: `debug_${hash(`${skill.skill_id}:${scenario?.scenario_id ?? "none"}:${input.question ?? ""}`)}`,
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    question: input.question ?? `What if ${changedVariable} changed during this workflow?`,
    baseline: {
      scenario_id: scenario?.scenario_id ?? null,
      mutation_kind: scenario?.mutation_kind ?? null,
      status: result?.status ?? "not_recorded",
      finding: result?.finding ?? "No matching checkride result was recorded.",
    },
    counterfactual: {
      changed_variable: changedVariable,
      expected_status_after_change: expectedStatus,
      causal_finding: result?.status === "passed"
        ? `The skill already handles ${mutationKind} under its current evidence.`
        : `Changing ${changedVariable} invalidates the current license unless the linked guardrail is satisfied.`,
      license_impact: result?.status === "passed"
        ? "No license downgrade is required for this counterfactual."
        : `Keep ${skill.name} at ${skill.entrustment_level} or lower until recertification passes this branch.`,
    },
    guardrails,
    replay_plan: [
      { step: "replay_static_trace", simulator_tier: 0, expected_evidence: [`workflow:${skill.workflow_id}`] },
      { step: "mutate_counterfactual_variable", simulator_tier: scenario?.simulator_tier ?? 1, expected_evidence: scenario ? [`scenario:${scenario.scenario_id}`] : [] },
      { step: "rerun_checkride_branch", simulator_tier: scenario?.simulator_tier ?? 1, expected_evidence: [skill.checkride.checkride_id] },
    ],
  };
}

function lifecycleActionsFor(skill: DojoSkill, required: boolean): string[] {
  if (!required) return ["no_recertification_required"];
  const actions = ["rerun_checkride", "refresh_proof_capsule_schema"];
  if (skill.attack_success_rate > 0) actions.push("harden_escaped_evil_twin_attacks");
  if (skill.source_links.length === 0) actions.push("add_source_identity_or_agent_ready_ui_contract");
  if (skill.permission_license.blocked_actions.some((action) => action.action === "run_workflow")) actions.push("resolve_license_blockers");
  return actions;
}

function packageRow(
  name: string,
  ready: boolean,
  evidence: string[],
  gaps: string[] = []
): { package: string; status: "ready" | "partial" | "blocked"; evidence: string[]; gaps: string[] } {
  return {
    package: name,
    status: ready ? "ready" : evidence.length ? "partial" : "blocked",
    evidence: evidence.filter(Boolean),
    gaps,
  };
}

function entrustmentDialFor(skill: DojoSkill): string {
  if (skill.entrustment_level === "E0") return "Observe only";
  if (skill.entrustment_level === "E1") return "Practice only";
  if (skill.entrustment_level === "E2") return "Draft only";
  if (skill.entrustment_level === "E3") return "Act under limits";
  if (skill.entrustment_level === "E4" || skill.entrustment_level === "E5") return "Act under license";
  return "Blocked";
}

function selectScenario(skill: DojoSkill, input: { mutation_kind?: string; scenario_id?: string }): DojoScenario | null {
  if (input.scenario_id) return skill.scenarios.find((scenario) => scenario.scenario_id === input.scenario_id) ?? null;
  if (input.mutation_kind) return skill.scenarios.find((scenario) => scenario.mutation_kind === input.mutation_kind) ?? null;
  const failed = skill.checkride.results.find((result) => result.status !== "passed");
  if (failed) return skill.scenarios.find((scenario) => scenario.scenario_id === failed.scenario_id) ?? null;
  return skill.scenarios[0] ?? null;
}

function relatedGuardrails(skill: DojoSkill, scenario: DojoScenario | null, result: DojoScenarioResult | null): DojoGuardrail[] {
  if (!scenario && !result) return skill.guardrails.slice(0, 3);
  const caseIds = new Set(
    skill.case_law
      .filter((item) => result?.evidence_refs.some((ref) => item.evidence_refs.includes(ref)))
      .map((item) => item.case_id)
  );
  const matched = skill.guardrails.filter((guardrail) => guardrail.source_case_id && caseIds.has(guardrail.source_case_id));
  return matched.length > 0 ? matched : skill.guardrails.filter((guardrail) => guardrail.blocks_actions.includes("run_workflow")).slice(0, 3);
}

function variableForMutation(mutationKind: string): string {
  if (/duplicate|entity|row|stale/i.test(mutationKind)) return "stable_entity_identity";
  if (/success|partial|api|network/i.test(mutationKind)) return "durable_success_evidence";
  if (/auth|permission/i.test(mutationKind)) return "current_actor_authorization";
  if (/label|viewport|feature|hydration/i.test(mutationKind)) return "agent_ready_ui_affordance";
  if (/destructive|delete/i.test(mutationKind)) return "destructive_action_guard";
  return "workflow_context";
}

function passRate(results: DojoScenarioResult[]): number {
  if (results.length === 0) return 0;
  return Number((results.filter((result) => result.status === "passed").length / results.length).toFixed(2));
}

function avg(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return Number((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(2));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(2));
}

function inferReactComponentName(filePath: string, actionLabel: string): string {
  const fileName = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
  return pascalCase(fileName) || pascalCase(actionLabel) || "AgentReadyAffordance";
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "dojo_skill";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
