import type { DojoRun, DojoScenario, DojoScenarioResult, DojoSkill } from "./dojo.js";

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

export function runDojoVivariumScenario(
  skill: DojoSkill,
  input: { scenario_id?: string; mutation_kind?: string; now?: string } = {}
): DojoVivariumScenarioRun {
  const scenario = selectScenario(skill, input);
  if (!scenario) throw new Error("dojo_scenario_not_found");
  const result = skill.checkride.results.find((item) => item.scenario_id === scenario.scenario_id) ?? fallbackResult(scenario, skill);
  const now = input.now ?? new Date().toISOString();
  const guardrails = guardrailsForResult(skill, result);
  const evidenceRefs = [
    `workflow:${skill.workflow_id}`,
    `organoid:${skill.workspace_organoid.organoid_id}`,
    `scenario:${scenario.scenario_id}`,
    ...result.evidence_refs,
  ];
  const run: DojoRun = {
    run_id: `vivarium_${Date.now().toString(36)}_${scenario.scenario_id.slice(-12)}`,
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    scenario_id: scenario.scenario_id,
    mode: scenario.layer === "risk" ? "evil_twin" : "vivarium",
    simulator_tier: scenario.simulator_tier,
    substrate: skill.preferred_substrate,
    status: result.status,
    started_at: now,
    finished_at: now,
    finding: result.finding,
    guardrails_triggered: guardrails,
    license_checks: [{
      action: "run_workflow",
      status: result.status === "passed" ? "allowed" : "blocked",
      blocked_by: result.status === "passed" ? [] : guardrails.length ? guardrails : [scenario.mutation_kind],
    }],
    cost: {
      estimated_tokens: 0,
      estimated_ms: 50 + scenario.simulator_tier * 25,
      model_calls: 0,
    },
    evidence_refs: evidenceRefs,
  };
  return {
    schema_version: "synthi.dojo.vivariumScenarioRun.v1",
    ok: result.status === "passed",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    scenario,
    materialized_fixture: materializedFixtureFor(skill, scenario),
    result,
    run,
    evidence_refs: evidenceRefs,
    guardrails,
  };
}

export function runDojoWindTunnel(
  skill: DojoSkill,
  input: { max_scenarios?: number; now?: string } = {}
): DojoWindTunnelExecution {
  const max = Math.max(1, Math.min(skill.scenarios.length, Number(input.max_scenarios ?? skill.scenarios.length)));
  const runs = skill.scenarios.slice(0, max).map((scenario) =>
    runDojoVivariumScenario(skill, { scenario_id: scenario.scenario_id, now: input.now })
  );
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

function selectScenario(skill: DojoSkill, input: { scenario_id?: string; mutation_kind?: string }): DojoScenario | null {
  if (input.scenario_id) return skill.scenarios.find((scenario) => scenario.scenario_id === input.scenario_id) ?? null;
  if (input.mutation_kind) return skill.scenarios.find((scenario) => scenario.mutation_kind === input.mutation_kind) ?? null;
  return skill.scenarios[0] ?? null;
}

function fallbackResult(scenario: DojoScenario, skill: DojoSkill): DojoScenarioResult {
  return {
    scenario_id: scenario.scenario_id,
    layer: scenario.layer,
    status: "blocked",
    critical: false,
    finding: "Scenario was materialized but has no checkride result; recertification is required before production use.",
    guardrail_suggestion: "Run a checkride for this scenario before expanding the license.",
    evidence_refs: [`workflow:${skill.workflow_id}`, `scenario:${scenario.scenario_id}`],
  };
}

function materializedFixtureFor(skill: DojoSkill, scenario: DojoScenario): DojoVivariumScenarioRun["materialized_fixture"] {
  const inputOverrides = Object.fromEntries(skill.skill_seed.input_schema.map((input) => [
    input.name,
    syntheticValueFor(input.value_shape, scenario.mutation_kind),
  ]));
  return {
    simulator_tier: scenario.simulator_tier,
    synthetic_data_only: true,
    tissues: {
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
    input_overrides: inputOverrides,
    expected_behavior: scenario.expected_behavior,
  };
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
