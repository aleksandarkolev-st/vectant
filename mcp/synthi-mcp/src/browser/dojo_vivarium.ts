import type { DojoRun, DojoScenario, DojoScenarioResult, DojoSkill } from "./dojo.js";
import { compileDojoSkillGraphForSkill } from "../dojo/graph/compiler.js";
import { DojoVivariumRunner, type DojoScenarioRunResult } from "../dojo/vivarium/runner.js";
import { toDojoScenarioDefinition } from "../dojo/vivarium/scenario_dsl.js";

export interface DojoVivariumScenarioRun {
  schema_version: "synthi.dojo.vivariumScenarioRun.v1";
  ok: boolean;
  skill_id: string;
  workflow_id: string;
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
  run_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  runs: DojoVivariumScenarioRun[];
  stop_reason: string;
}

export async function runDojoVivariumScenario(
  skill: DojoSkill,
  input: { scenario_id?: string; mutation_kind?: string; now?: string } = {}
): Promise<DojoVivariumScenarioRun> {
  const scenario = selectScenario(skill, input);
  if (!scenario) throw new Error("dojo_scenario_not_found");

  const now = input.now ?? new Date().toISOString();
  const scenarioRun = await executeMaterializedScenario(skill, scenario, now);
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
    scenario,
    materialized_fixture: materializedFixtureFor(skill, scenario, scenarioRun),
    result,
    run,
    evidence_refs: evidenceRefs,
    guardrails,
  };
}

export async function runDojoWindTunnel(
  skill: DojoSkill,
  input: { max_scenarios?: number; now?: string } = {}
): Promise<DojoWindTunnelExecution> {
  const max = Math.max(1, Math.min(skill.scenarios.length, Number(input.max_scenarios ?? skill.scenarios.length)));
  const runs: DojoVivariumScenarioRun[] = [];
  for (const scenario of skill.scenarios.slice(0, max)) {
    runs.push(await runDojoVivariumScenario(skill, { scenario_id: scenario.scenario_id, now: input.now }));
  }
  return {
    schema_version: "synthi.dojo.windTunnelExecution.v1",
    ok: runs.every((run) => run.result.status === "passed" || run.result.status === "blocked"),
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    run_count: runs.length,
    pass_count: runs.filter((run) => run.result.status === "passed").length,
    fail_count: runs.filter((run) => run.result.status === "failed").length,
    blocked_count: runs.filter((run) => run.result.status === "blocked").length,
    runs,
    stop_reason: runs.length < skill.scenarios.length ? "scenario_budget_reached" : skill.cost_control_policy.stop_conditions[0] ?? "scenario_set_complete",
  };
}

async function executeMaterializedScenario(
  skill: DojoSkill,
  scenario: DojoScenario,
  now: string
): Promise<DojoScenarioRunResult> {
  const definition = toDojoScenarioDefinition(scenario, {
    target_graph_node_ids: ["action"],
    input_overrides: syntheticInputOverridesFor(skill, scenario),
  });
  const runner = new DojoVivariumRunner();
  const materialized = runner.materialize({
    skill_id: skill.skill_id,
    scenario: definition,
    seed: scenario.scenario_id,
    now,
  });
  const compiled = compileDojoSkillGraphForSkill(skill, {
    mode: "checkride",
    created_at: now,
  });
  return await runner.run({
    materialized,
    graph: compiled.graph,
    run_id: `vivarium_${Date.now().toString(36)}_${scenario.scenario_id.slice(-12)}`,
    inputs: graphInputsForScenario(skill),
    observed_evidence: observedEvidenceHintsForScenario(scenario),
    now,
  });
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
  scenarioRun: DojoScenarioRunResult
): DojoVivariumScenarioRun["materialized_fixture"] {
  return {
    simulator_tier: scenario.simulator_tier,
    synthetic_data_only: true,
    tissues: {
      fixture: {
        materialized_id: scenarioRun.materialized_id,
        materialization_hash: scenarioRun.fixture_materialization_hash,
        observed_evidence: scenarioRun.observed_evidence,
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

function graphInputsForScenario(skill: DojoSkill): Record<string, unknown> {
  return {
    entrustment_level: skill.permission_license.entrustment_level,
    workspace_verified: true,
    client_id_verified: true,
    line_items_total_verified: true,
    source_anchor_current: true,
    approval_status: "approved",
    assertion_results: Object.fromEntries(
      skill.skill_seed.candidate_success_assertions.map((assertion) => [assertion.assertion_id, true])
    ),
  };
}

function observedEvidenceHintsForScenario(scenario: DojoScenario): string[] {
  const evidence = ["graph_run_result", "oracle_result"];
  if (scenario.mutation_kind === "auth_expiry" || scenario.mutation_kind === "permission_change") {
    evidence.push("identity_policy_state");
  }
  return evidence;
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
