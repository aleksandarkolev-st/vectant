import type { DojoRun, DojoScenario, DojoScenarioResult, DojoSkill } from "./dojo.js";
import { compileDojoSkillGraphForSkill } from "../dojo/graph/compiler.js";
import type { DojoMaterializedFixture } from "../dojo/vivarium/fixture_materializer.js";
import { DojoVivariumRunner, type DojoMaterializedScenario, type DojoScenarioRunResult } from "../dojo/vivarium/runner.js";
import { toDojoScenarioDefinition } from "../dojo/vivarium/scenario_dsl.js";
import type { DojoTenantContext } from "../dojo/mcp/execution_policy_gate.js";

export interface DojoVivariumScenarioRun {
  schema_version: "synthi.dojo.vivariumScenarioRun.v1";
  ok: boolean;
  skill_id: string;
  workflow_id: string;
  tenant_context?: DojoTenantContext;
  scenario: DojoScenario;
  materialized_fixture: {
    simulator_tier: number;
    synthetic_data_only: true;
    tissues: Record<string, unknown>;
    input_overrides: Record<string, unknown>;
    expected_behavior: string;
  };
  result: DojoScenarioResult;
  run: DojoRun;
  evidence_refs: string[];
  guardrails: string[];
}

export interface DojoWindTunnelExecution {
  schema_version: "synthi.dojo.windTunnelExecution.v1";
  ok: boolean;
  skill_id: string;
  workflow_id: string;
  tenant_context?: DojoTenantContext;
  run_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  runs: DojoVivariumScenarioRun[];
  stop_reason: string;
}

export async function runDojoVivariumScenario(
  skill: DojoSkill,
  input: { scenario_id?: string; mutation_kind?: string; now?: string; tenant_context?: DojoTenantContext } = {}
): Promise<DojoVivariumScenarioRun> {
  const scenario = selectScenario(skill, input);
  if (!scenario) throw new Error("dojo_scenario_not_found");

  const now = input.now ?? new Date().toISOString();
  const execution = await executeMaterializedScenario(skill, scenario, now, input.tenant_context);
  const scenarioRun = execution.scenario_run;
  const result = scenarioResultForRun(scenario, scenarioRun);
  const guardrails = guardrailsForResult(skill, result);
  const evidenceRefs = [
    `workflow:${skill.workflow_id}`,
    `organoid:${skill.workspace_organoid.organoid_id}`,
    `scenario:${scenario.scenario_id}`,
    ...scenarioRun.evidence_refs,
  ];
  const run: DojoRun = {
    run_id: scenarioRun.run_id,
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    scenario_id: scenario.scenario_id,
    mode: scenario.layer === "risk" ? "evil_twin" : "vivarium",
    simulator_tier: scenario.simulator_tier,
    substrate: skill.preferred_substrate,
    status: result.status,
    started_at: scenarioRun.started_at,
    finished_at: scenarioRun.completed_at,
    finding: result.finding,
    guardrails_triggered: guardrails,
    license_checks: [{
      action: "run_workflow",
      status: result.status === "passed" ? "allowed" : "blocked",
      blocked_by: result.status === "passed" ? [] : guardrails.length ? guardrails : scenarioRun.oracle_result.blocked_by,
    }],
    cost: {
      estimated_tokens: 0,
      estimated_ms: scenarioRun.budget.max_estimated_ms,
      model_calls: scenarioRun.budget.max_model_calls,
    },
    evidence_refs: evidenceRefs,
  };

  return {
    schema_version: "synthi.dojo.vivariumScenarioRun.v1",
    ok: result.status === "passed",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    ...(input.tenant_context ? { tenant_context: cloneTenantContext(input.tenant_context) } : {}),
    scenario,
    materialized_fixture: materializedFixtureFor(skill, scenario, execution),
    result,
    run,
    evidence_refs: evidenceRefs,
    guardrails,
  };
}

export async function runDojoWindTunnel(
  skill: DojoSkill,
  input: { max_scenarios?: number; now?: string; tenant_context?: DojoTenantContext } = {}
): Promise<DojoWindTunnelExecution> {
  const max = Math.max(1, Math.min(skill.scenarios.length, Number(input.max_scenarios ?? skill.scenarios.length)));
  const runs: DojoVivariumScenarioRun[] = [];
  for (const scenario of skill.scenarios.slice(0, max)) {
    runs.push(await runDojoVivariumScenario(skill, {
      scenario_id: scenario.scenario_id,
      now: input.now,
      tenant_context: input.tenant_context,
    }));
  }
  return {
    schema_version: "synthi.dojo.windTunnelExecution.v1",
    ok: runs.every((run) => run.result.status === "passed" || run.result.status === "blocked"),
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    ...(input.tenant_context ? { tenant_context: cloneTenantContext(input.tenant_context) } : {}),
    run_count: runs.length,
    pass_count: runs.filter((run) => run.result.status === "passed").length,
    fail_count: runs.filter((run) => run.result.status === "failed").length,
    blocked_count: runs.filter((run) => run.result.status === "blocked").length,
    runs,
    stop_reason: runs.length < skill.scenarios.length ? "scenario_budget_reached" : skill.cost_control_policy.stop_conditions[0] ?? "scenario_set_complete",
  };
}

interface DojoMaterializedScenarioExecution {
  materialized: DojoMaterializedScenario;
  scenario_run: DojoScenarioRunResult;
  graph_inputs: Record<string, unknown>;
  requested_observed_evidence: string[];
}

async function executeMaterializedScenario(
  skill: DojoSkill,
  scenario: DojoScenario,
  now: string,
  tenantContext?: DojoTenantContext
): Promise<DojoMaterializedScenarioExecution> {
  const definition = toDojoScenarioDefinition(scenario, {
    target_graph_node_ids: ["action"],
    input_overrides: syntheticInputOverridesFor(skill, scenario),
  });
  const runner = new DojoVivariumRunner();
  const materialized = runner.materialize({
    skill_id: skill.skill_id,
    scenario: definition,
    ...(tenantContext ? { tenant: tenantContext } : {}),
    seed: scenario.scenario_id,
    now,
  });
  const compiled = compileDojoSkillGraphForSkill(skill, {
    mode: "checkride",
    created_at: now,
  });
  const graphInputs = buildDojoVivariumGraphInputsForFixture(skill, materialized.fixture);
  const requestedObservedEvidence = observedEvidenceForScenario(materialized.fixture, graphInputs);
  const scenarioRun = await runner.run({
    materialized,
    graph: compiled.graph,
    ...(tenantContext ? { tenant: tenantContext } : {}),
    inputs: graphInputs,
    observed_evidence: requestedObservedEvidence,
    now,
  });
  return {
    materialized,
    scenario_run: scenarioRun,
    graph_inputs: graphInputs,
    requested_observed_evidence: requestedObservedEvidence,
  };
}

function cloneTenantContext(tenant: DojoTenantContext): DojoTenantContext {
  return {
    ...tenant,
    roles: [...tenant.roles],
  };
}

function selectScenario(skill: DojoSkill, input: { scenario_id?: string; mutation_kind?: string }): DojoScenario | null {
  if (input.scenario_id) return skill.scenarios.find((scenario) => scenario.scenario_id === input.scenario_id) ?? null;
  if (input.mutation_kind) return skill.scenarios.find((scenario) => scenario.mutation_kind === input.mutation_kind) ?? null;
  return skill.scenarios[0] ?? null;
}

function scenarioResultForRun(scenario: DojoScenario, scenarioRun: DojoScenarioRunResult): DojoScenarioResult {
  return {
    scenario_id: scenario.scenario_id,
    layer: scenario.layer,
    status: dojoStatusForOracleStatus(scenarioRun.status),
    critical: scenario.layer === "risk" && scenarioRun.status === "failed",
    finding: scenarioRun.oracle_result.finding,
    guardrail_suggestion: scenarioRun.oracle_result.blocked_by.length > 0
      ? `Harden scenario ${scenario.mutation_kind}: ${scenarioRun.oracle_result.blocked_by.join(", ")}.`
      : "Scenario executed against materialized synthetic fixtures.",
    evidence_refs: scenarioRun.evidence_refs,
  };
}

function dojoStatusForOracleStatus(status: DojoScenarioRunResult["status"]): DojoScenarioResult["status"] {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "blocked";
}

function materializedFixtureFor(
  skill: DojoSkill,
  scenario: DojoScenario,
  execution: DojoMaterializedScenarioExecution
): DojoVivariumScenarioRun["materialized_fixture"] {
  const { materialized, scenario_run: scenarioRun } = execution;
  const fixture = materialized.fixture;
  return {
    simulator_tier: scenario.simulator_tier,
    synthetic_data_only: true,
    tissues: {
      fixture: {
        materialized_id: scenarioRun.materialized_id,
        fixture_id: fixture.fixture_id,
        scenario_id: fixture.scenario_id,
        mutation_kind: fixture.mutation_kind,
        synthetic_data_only: fixture.synthetic_data_only,
        seed: fixture.seed,
        materialization_hash: scenarioRun.fixture_materialization_hash,
        source_definition_hash: fixture.source_definition_hash,
        observed_evidence: scenarioRun.observed_evidence,
        requested_observed_evidence: execution.requested_observed_evidence,
        graph_inputs: execution.graph_inputs,
        records: fixture.records,
        missing_fields: fixture.missing_fields,
        threshold_breaches: fixture.threshold_breaches,
        ui_state: fixture.ui_state,
        api_state: fixture.api_state,
        api_fault: scenarioRun.api_fault ?? null,
        identity_state: fixture.identity_state,
        document_state: fixture.document_state,
        reset_evidence: fixture.reset_evidence,
      },
      oracle: scenarioRun.oracle_result,
      ui: skill.workspace_organoid.tissues.ui,
      data: {
        ...skill.workspace_organoid.tissues.data,
        mutation_kind: scenario.mutation_kind,
      },
      policy: skill.workspace_organoid.tissues.policy,
      identity: skill.workspace_organoid.tissues.identity,
      api: skill.workspace_organoid.tissues.api,
      evidence: skill.workspace_organoid.tissues.evidence,
      license: skill.workspace_organoid.tissues.license,
    },
    input_overrides: syntheticInputOverridesFor(skill, scenario),
    expected_behavior: scenario.expected_behavior,
  };
}

function syntheticInputOverridesFor(skill: DojoSkill, scenario: DojoScenario): Record<string, string> {
  return Object.fromEntries(skill.skill_seed.input_schema.map((input) => [
    input.name,
    syntheticValueFor(input.value_shape, scenario.mutation_kind),
  ]));
}

export function buildDojoVivariumGraphInputsForFixture(
  skill: DojoSkill,
  fixture: DojoMaterializedFixture
): Record<string, unknown> {
  const workspaceVerified = workspaceVerifiedForFixture(fixture);
  const clientIdVerified = clientIdentityVerifiedForFixture(fixture);
  const lineItemsTotalVerified = lineItemsTotalVerifiedForFixture(fixture);
  const sourceAnchorCurrent = sourceAnchorCurrentForFixture(fixture);
  const durableStateEvidence = durableStateEvidenceForFixture(fixture);
  const humanReviewReady = workspaceVerified && !fixture.identity_state.permission_downgraded;
  const visualPostconditionsObserved = visualPostconditionsObservedForFixture(fixture);
  return {
    entrustment_level: skill.permission_license.entrustment_level,
    workspace_verified: workspaceVerified,
    client_id_verified: clientIdVerified,
    line_items_total_verified: lineItemsTotalVerified,
    source_anchor_current: sourceAnchorCurrent,
    durable_state_evidence: durableStateEvidence,
    human_review_ready: humanReviewReady,
    approval_status: humanReviewReady ? "approved" : "denied",
    assertion_results: Object.fromEntries(
      skill.skill_seed.candidate_success_assertions.map((assertion) => [
        assertion.assertion_id,
        visualPostconditionsObserved,
      ])
    ),
  };
}

function observedEvidenceForScenario(
  fixture: DojoMaterializedFixture,
  graphInputs: Record<string, unknown>
): string[] {
  const evidence = new Set<string>();
  if (graphInputs["client_id_verified"] === true && fixture.records.length > 0) {
    evidence.add("stable_entity_identity");
  }
  if (graphInputs["durable_state_evidence"] === true) {
    evidence.add("durable_state_evidence");
  }
  if (graphInputs["line_items_total_verified"] === true) {
    evidence.add("line_items_total_verified");
  }
  return [...evidence].sort();
}

function workspaceVerifiedForFixture(fixture: DojoMaterializedFixture): boolean {
  return !fixture.identity_state.auth_expired;
}

function clientIdentityVerifiedForFixture(fixture: DojoMaterializedFixture): boolean {
  return fixture.records.length > 0
    && duplicateDisplayNameCount(fixture) <= 1
    && !fixture.records.some((record) => record.stale);
}

function duplicateDisplayNameCount(fixture: DojoMaterializedFixture): number {
  const counts = new Map<string, number>();
  for (const record of fixture.records) {
    counts.set(record.display_name, (counts.get(record.display_name) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function lineItemsTotalVerifiedForFixture(fixture: DojoMaterializedFixture): boolean {
  return fixture.missing_fields.length === 0
    && fixture.threshold_breaches.length === 0
    && fixture.document_state.missing_fields.length === 0
    && fixture.document_state.corrupted_document_count === 0
    && !fixture.api_state.validation_error;
}

function sourceAnchorCurrentForFixture(fixture: DojoMaterializedFixture): boolean {
  return fixture.ui_state.route === "/synthetic/workspace";
}

function durableStateEvidenceForFixture(fixture: DojoMaterializedFixture): boolean {
  return !fixture.api_state.fake_success
    && !fixture.api_state.partial_write
    && !fixture.api_state.validation_error;
}

function visualPostconditionsObservedForFixture(fixture: DojoMaterializedFixture): boolean {
  return workspaceVerifiedForFixture(fixture)
    && !fixture.identity_state.permission_downgraded
    && !fixture.api_state.validation_error
    && fixture.missing_fields.length === 0
    && fixture.document_state.corrupted_document_count === 0;
}

function syntheticValueFor(shape: string, mutationKind: string): string {
  if (/email/i.test(shape)) return mutationKind === "duplicate_entity" ? "duplicate@example.test" : "agent@example.test";
  if (/number|amount|currency/i.test(shape)) return mutationKind === "partial_write" ? "500.01" : "42";
  if (/file/i.test(shape)) return mutationKind === "fake_success" ? "synthetic-injected-document.pdf" : "synthetic-document.pdf";
  if (/id|identifier/i.test(shape)) return mutationKind === "stale_entity" ? "stale-id" : "verified-id";
  return mutationKind === "duplicate_entity" ? "Duplicate synthetic record" : "Synthetic value";
}

function guardrailsForResult(skill: DojoSkill, result: DojoScenarioResult): string[] {
  if (result.status === "passed") return [];
  const cases = skill.case_law.filter((item) => result.evidence_refs.some((ref) => item.evidence_refs.includes(ref)));
  const caseIds = new Set(cases.map((item) => item.case_id));
  return skill.guardrails
    .filter((guardrail) => guardrail.source_case_id && caseIds.has(guardrail.source_case_id))
    .map((guardrail) => guardrail.guardrail_id);
}
