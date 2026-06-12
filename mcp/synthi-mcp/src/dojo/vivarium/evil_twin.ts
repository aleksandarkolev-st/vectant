import type { DojoSkillGraph } from "../graph/types.js";
import { DojoVivariumRunner, type DojoScenarioRunResult } from "./runner.js";
import type { DojoScenarioDefinition } from "./scenario_dsl.js";

export type DojoEvilTwinAssumptionKind =
  | "entity_uniqueness"
  | "stable_success_signal"
  | "auth_continuity"
  | "api_atomicity"
  | "input_visibility";

export interface DojoEvilTwinAssumption {
  assumption_id: string;
  kind: DojoEvilTwinAssumptionKind;
  node_ids: string[];
  evidence: string[];
  attack_mutation_kind: string;
}

export interface DojoEvilTwinAttackRun {
  attack_id: string;
  scenario_id: string;
  mutation_kind: string;
  assumption_kind: DojoEvilTwinAssumptionKind;
  status: "caught" | "escaped" | "passed";
  attack_succeeded: boolean;
  finding: string;
  blocked_by: string[];
  hardening_suggestions: string[];
  scenario_run: DojoScenarioRunResult;
}

export interface DojoEvilTwinRuntimeReport {
  schema_version: "synthi.dojo.evilTwinRuntimeReport.v1";
  graph_id: string;
  skill_id: string;
  attack_count: number;
  attack_success_rate: number;
  assumptions: DojoEvilTwinAssumption[];
  attacks: DojoEvilTwinAttackRun[];
  hardened_by: string[];
}

export async function runDojoEvilTwin(input: {
  graph: DojoSkillGraph;
  scenarios: DojoScenarioDefinition[];
  runner?: DojoVivariumRunner;
  max_attacks?: number;
  observed_evidence_by_scenario?: Record<string, string[]>;
  now?: string;
}): Promise<DojoEvilTwinRuntimeReport> {
  const assumptions = extractDojoEvilTwinAssumptions(input.graph, input.scenarios);
  const runner = input.runner ?? new DojoVivariumRunner();
  const attacks: DojoEvilTwinAttackRun[] = [];
  const attackableScenarios = input.scenarios
    .filter((scenario) => assumptions.some((assumption) => assumption.attack_mutation_kind === scenario.mutation_kind))
    .slice(0, Math.max(1, input.max_attacks ?? input.scenarios.length));

  for (const scenario of attackableScenarios) {
    const assumption = assumptions.find((item) => item.attack_mutation_kind === scenario.mutation_kind) ?? assumptions[0];
    if (!assumption) continue;
    const materialized = runner.materialize({
      skill_id: input.graph.skill_id,
      scenario,
      now: input.now,
    });
    const scenarioRun = await runner.run({
      materialized,
      graph: input.graph,
      run_id: `evil_twin_${scenario.scenario_id}`,
      observed_evidence: input.observed_evidence_by_scenario?.[scenario.scenario_id] ?? ["graph_run_result", "oracle_result"],
      now: input.now,
    });
    attacks.push(attackRunForScenario(assumption, scenarioRun));
  }

  const successfulAttacks = attacks.filter((attack) => attack.attack_succeeded).length;
  return {
    schema_version: "synthi.dojo.evilTwinRuntimeReport.v1",
    graph_id: input.graph.graph_id,
    skill_id: input.graph.skill_id,
    attack_count: attacks.length,
    attack_success_rate: attacks.length > 0 ? Number((successfulAttacks / attacks.length).toFixed(2)) : 0,
    assumptions,
    attacks,
    hardened_by: [...new Set(attacks.flatMap((attack) => attack.hardening_suggestions))],
  };
}

export function extractDojoEvilTwinAssumptions(
  graph: DojoSkillGraph,
  scenarios: DojoScenarioDefinition[] = []
): DojoEvilTwinAssumption[] {
  const nodeIds = graph.nodes.map((node) => node.node_id);
  const assumptions: DojoEvilTwinAssumption[] = [];
  if (hasScenario(scenarios, "duplicate_entity")) {
    assumptions.push({
      assumption_id: `assumption_${graph.graph_id}_entity_uniqueness`,
      kind: "entity_uniqueness",
      node_ids: nodeIds,
      evidence: ["Scenario catalog contains duplicate-entity mutation."],
      attack_mutation_kind: "duplicate_entity",
    });
  }
  if (hasScenario(scenarios, "fake_success")) {
    assumptions.push({
      assumption_id: `assumption_${graph.graph_id}_stable_success_signal`,
      kind: "stable_success_signal",
      node_ids: graph.nodes.filter((node) => node.kind === "Action" || node.kind === "Assertion").map((node) => node.node_id),
      evidence: ["Scenario catalog contains fake-success mutation."],
      attack_mutation_kind: "fake_success",
    });
  }
  if (hasScenario(scenarios, "partial_write")) {
    assumptions.push({
      assumption_id: `assumption_${graph.graph_id}_api_atomicity`,
      kind: "api_atomicity",
      node_ids: graph.nodes.filter((node) => node.kind === "Action").map((node) => node.node_id),
      evidence: ["Scenario catalog contains partial-write mutation."],
      attack_mutation_kind: "partial_write",
    });
  }
  if (hasScenario(scenarios, "auth_expiry") || hasScenario(scenarios, "permission_change")) {
    assumptions.push({
      assumption_id: `assumption_${graph.graph_id}_auth_continuity`,
      kind: "auth_continuity",
      node_ids: nodeIds,
      evidence: ["Scenario catalog contains identity or permission mutation."],
      attack_mutation_kind: hasScenario(scenarios, "auth_expiry") ? "auth_expiry" : "permission_change",
    });
  }
  if (hasScenario(scenarios, "hidden_required_field") || hasScenario(scenarios, "input_omission")) {
    assumptions.push({
      assumption_id: `assumption_${graph.graph_id}_input_visibility`,
      kind: "input_visibility",
      node_ids: graph.nodes.filter((node) => node.kind === "Input" || node.kind === "Action").map((node) => node.node_id),
      evidence: ["Scenario catalog contains hidden or omitted input mutation."],
      attack_mutation_kind: hasScenario(scenarios, "hidden_required_field") ? "hidden_required_field" : "input_omission",
    });
  }
  return assumptions;
}

function attackRunForScenario(
  assumption: DojoEvilTwinAssumption,
  scenarioRun: DojoScenarioRunResult
): DojoEvilTwinAttackRun {
  const attackSucceeded = scenarioRun.oracle_result.status === "failed"
    || (!scenarioRun.oracle_result.expectation_met && scenarioRun.graph_result.status === "completed");
  return {
    attack_id: `attack_${assumption.kind}_${scenarioRun.scenario_id}`,
    scenario_id: scenarioRun.scenario_id,
    mutation_kind: scenarioRun.mutation_kind,
    assumption_kind: assumption.kind,
    status: attackSucceeded ? "escaped" : scenarioRun.oracle_result.status === "blocked" || scenarioRun.oracle_result.status === "needs_human" ? "caught" : "passed",
    attack_succeeded: attackSucceeded,
    finding: scenarioRun.oracle_result.finding,
    blocked_by: scenarioRun.oracle_result.blocked_by,
    hardening_suggestions: hardeningSuggestionsFor(scenarioRun),
    scenario_run: scenarioRun,
  };
}

function hardeningSuggestionsFor(scenarioRun: DojoScenarioRunResult): string[] {
  return scenarioRun.oracle_result.blocked_by.map((reason) => {
    if (reason.includes("stable_entity_identity")) return "require_stable_entity_identity_guardrail";
    if (reason.includes("durable_state_evidence")) return "require_durable_state_assertion";
    if (reason.includes("partial_write")) return "require_api_atomicity_assertion";
    return `harden:${reason}`;
  });
}

function hasScenario(scenarios: DojoScenarioDefinition[], mutationKind: string): boolean {
  return scenarios.some((scenario) => scenario.mutation_kind === mutationKind);
}
