import type { DojoSkillGraph } from "../graph/types.js";
import type { DojoSkillGraphRuntime } from "../graph/runtime.js";
import type { DojoSubstrateExecutor } from "../graph/substrate_executor.js";
import { DojoVivariumRunner, type DojoMaterializedScenario, type DojoScenarioRunResult } from "./runner.js";
import type { DojoScenarioBudget, DojoScenarioDefinition } from "./scenario_dsl.js";

export type DojoEvilTwinAssumptionKind =
  | "entity_uniqueness"
  | "entity_freshness"
  | "stable_success_signal"
  | "auth_continuity"
  | "role_permission"
  | "api_atomicity"
  | "api_latency"
  | "input_visibility"
  | "stable_table_order"
  | "currency_validity"
  | "file_identity"
  | "document_trust"
  | "approval_availability"
  | "policy_threshold"
  | "destructive_adjacency";

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

export interface DojoEvilTwinHardeningReport {
  schema_version: "synthi.dojo.evilTwinHardeningReport.v1";
  graph_id: string;
  before: DojoEvilTwinRuntimeReport;
  after: DojoEvilTwinRuntimeReport;
  applied_guardrails: Array<{
    guardrail_id: string;
    predicate: string;
    source_suggestion: string;
  }>;
}

type DojoEvilTwinNodeSelector =
  | "all"
  | "action"
  | "action_assertion"
  | "input_action"
  | "observe_locate_action"
  | "artifact_action"
  | "permission_action";

interface DojoEvilTwinAssumptionRule {
  kind: DojoEvilTwinAssumptionKind;
  mutation_kinds: string[];
  node_selector: DojoEvilTwinNodeSelector;
  evidence_label: string;
}

const DOJO_EVIL_TWIN_ASSUMPTION_RULES: DojoEvilTwinAssumptionRule[] = [
  {
    kind: "entity_uniqueness",
    mutation_kinds: ["duplicate_entity"],
    node_selector: "observe_locate_action",
    evidence_label: "entity uniqueness can be invalidated by duplicate candidates",
  },
  {
    kind: "entity_freshness",
    mutation_kinds: ["stale_entity"],
    node_selector: "observe_locate_action",
    evidence_label: "entity freshness can be invalidated by stale IDs or versions",
  },
  {
    kind: "stable_success_signal",
    mutation_kinds: ["fake_success", "misleading_toast"],
    node_selector: "action_assertion",
    evidence_label: "visual success signals can diverge from durable state",
  },
  {
    kind: "api_atomicity",
    mutation_kinds: ["partial_write", "downstream_failure"],
    node_selector: "action_assertion",
    evidence_label: "API writes may be partial or downstream-dependent",
  },
  {
    kind: "api_latency",
    mutation_kinds: ["network_latency"],
    node_selector: "action_assertion",
    evidence_label: "API responses may be delayed or time out",
  },
  {
    kind: "auth_continuity",
    mutation_kinds: ["auth_expiry"],
    node_selector: "all",
    evidence_label: "authentication can expire mid-flow",
  },
  {
    kind: "role_permission",
    mutation_kinds: ["permission_change", "missing_permission"],
    node_selector: "permission_action",
    evidence_label: "roles and permissions can change before execution",
  },
  {
    kind: "input_visibility",
    mutation_kinds: [
      "input_omission",
      "hidden_required_field",
      "button_moved",
      "button_hidden_menu",
      "validation_below_fold",
      "modal_appears",
    ],
    node_selector: "input_action",
    evidence_label: "inputs and controls may move, hide, or become interrupted",
  },
  {
    kind: "stable_table_order",
    mutation_kinds: ["reordered_rows"],
    node_selector: "observe_locate_action",
    evidence_label: "table order can change while row identity remains stable",
  },
  {
    kind: "currency_validity",
    mutation_kinds: ["invalid_value"],
    node_selector: "input_action",
    evidence_label: "input values such as currency or amount may violate schema",
  },
  {
    kind: "file_identity",
    mutation_kinds: ["missing_document_field", "corrupted_document", "ambiguous_document_name"],
    node_selector: "artifact_action",
    evidence_label: "documents can be missing, corrupted, or ambiguously named",
  },
  {
    kind: "document_trust",
    mutation_kinds: ["prompt_injection", "prompt_injection_unquarantined"],
    node_selector: "artifact_action",
    evidence_label: "document text can contain untrusted task instructions",
  },
  {
    kind: "approval_availability",
    mutation_kinds: ["approval_unavailable"],
    node_selector: "permission_action",
    evidence_label: "required approvers may be unavailable",
  },
  {
    kind: "policy_threshold",
    mutation_kinds: ["threshold_breach"],
    node_selector: "permission_action",
    evidence_label: "policy thresholds may require approval or block execution",
  },
  {
    kind: "destructive_adjacency",
    mutation_kinds: ["destructive_adjacency"],
    node_selector: "action",
    evidence_label: "destructive controls can be adjacent to safe controls",
  },
];

export async function runDojoEvilTwin(input: {
  graph: DojoSkillGraph;
  scenarios: DojoScenarioDefinition[];
  runner?: DojoVivariumRunner;
  runtime?: DojoSkillGraphRuntime;
  substrate_executor?: DojoSubstrateExecutor;
  scenario_runtimes?: Record<string, DojoSkillGraphRuntime>;
  scenario_substrate_executors?: Record<string, DojoSubstrateExecutor>;
  max_attacks?: number;
  base_inputs?: Record<string, unknown>;
  scenario_inputs?: Record<string, Record<string, unknown>>;
  build_inputs?: (input: {
    scenario: DojoScenarioDefinition;
    materialized: DojoMaterializedScenario;
    base_inputs: Record<string, unknown>;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  budget_by_scenario?: Record<string, DojoScenarioBudget>;
  model_calls_used_by_scenario?: Record<string, number>;
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
    const baseInputs = input.base_inputs ?? {};
    const builtInputs = await input.build_inputs?.({
      scenario,
      materialized,
      base_inputs: baseInputs,
    }) ?? {};
    const scenarioRun = await runner.run({
      materialized,
      graph: input.graph,
      run_id: `evil_twin_${scenario.scenario_id}`,
      runtime: input.scenario_runtimes?.[scenario.scenario_id] ?? input.runtime,
      substrate_executor: input.scenario_substrate_executors?.[scenario.scenario_id] ?? input.substrate_executor,
      budget: input.budget_by_scenario?.[scenario.scenario_id],
      inputs: {
        ...baseInputs,
        ...builtInputs,
        ...(input.scenario_inputs?.[scenario.scenario_id] ?? {}),
      },
      observed_evidence: input.observed_evidence_by_scenario?.[scenario.scenario_id] ?? ["graph_run_result", "oracle_result"],
      model_calls_used: input.model_calls_used_by_scenario?.[scenario.scenario_id],
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
  const assumptions: DojoEvilTwinAssumption[] = [];
  const seen = new Set<string>();
  for (const rule of DOJO_EVIL_TWIN_ASSUMPTION_RULES) {
    for (const scenario of scenarios) {
      if (!rule.mutation_kinds.includes(scenario.mutation_kind)) continue;
      const key = `${rule.kind}:${scenario.mutation_kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const selectedNodeIds = nodeIdsForAssumption(graph, rule.node_selector);
      assumptions.push({
        assumption_id: `assumption_${slugId(graph.graph_id)}_${rule.kind}_${slugId(scenario.mutation_kind)}`,
        kind: rule.kind,
        node_ids: selectedNodeIds.length > 0 ? selectedNodeIds : graph.nodes.map((node) => node.node_id),
        evidence: [
          `Scenario ${scenario.scenario_id} contains ${scenario.mutation_kind} mutation.`,
          rule.evidence_label,
          `Risk tags: ${scenario.provenance.risk_tags.length > 0 ? scenario.provenance.risk_tags.join(",") : "none"}.`,
        ],
        attack_mutation_kind: scenario.mutation_kind,
      });
    }
  }
  return assumptions;
}

export async function hardenDojoEvilTwinAttacks(input: {
  graph: DojoSkillGraph;
  scenarios: DojoScenarioDefinition[];
  runner?: DojoVivariumRunner;
  runtime?: DojoSkillGraphRuntime;
  substrate_executor?: DojoSubstrateExecutor;
  scenario_runtimes?: Record<string, DojoSkillGraphRuntime>;
  scenario_substrate_executors?: Record<string, DojoSubstrateExecutor>;
  max_attacks?: number;
  base_inputs?: Record<string, unknown>;
  scenario_inputs?: Record<string, Record<string, unknown>>;
  build_inputs?: (input: {
    scenario: DojoScenarioDefinition;
    materialized: DojoMaterializedScenario;
    base_inputs: Record<string, unknown>;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  budget_by_scenario?: Record<string, DojoScenarioBudget>;
  model_calls_used_by_scenario?: Record<string, number>;
  observed_evidence_by_scenario?: Record<string, string[]>;
  now?: string;
}): Promise<DojoEvilTwinHardeningReport> {
  const before = await runDojoEvilTwin(input);
  const hardening = hardeningGuardrailsFor(before.hardened_by);
  const hardenedGraph = applyHardeningGuardrails(input.graph, hardening);
  const after = await runDojoEvilTwin({
    ...input,
    graph: hardenedGraph,
  });
  return {
    schema_version: "synthi.dojo.evilTwinHardeningReport.v1",
    graph_id: input.graph.graph_id,
    before,
    after,
    applied_guardrails: hardening,
  };
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

function hardeningGuardrailsFor(suggestions: string[]): Array<{
  guardrail_id: string;
  predicate: string;
  source_suggestion: string;
}> {
  const guardrails = new Map<string, { guardrail_id: string; predicate: string; source_suggestion: string }>();
  for (const suggestion of suggestions) {
    if (suggestion === "require_stable_entity_identity_guardrail") {
      guardrails.set("guard_stable_entity_identity", {
        guardrail_id: "guard_stable_entity_identity",
        predicate: "duplicate_display_name_count <= 1",
        source_suggestion: suggestion,
      });
    }
    if (suggestion === "require_durable_state_assertion") {
      guardrails.set("guard_no_fake_success", {
        guardrail_id: "guard_no_fake_success",
        predicate: "fake_success == false",
        source_suggestion: suggestion,
      });
    }
    if (suggestion === "require_api_atomicity_assertion") {
      guardrails.set("guard_no_partial_write", {
        guardrail_id: "guard_no_partial_write",
        predicate: "partial_write == false",
        source_suggestion: suggestion,
      });
    }
  }
  return [...guardrails.values()];
}

function applyHardeningGuardrails(
  graph: DojoSkillGraph,
  guardrails: Array<{ guardrail_id: string; predicate: string; source_suggestion: string }>
): DojoSkillGraph {
  if (guardrails.length === 0) return graph;
  return {
    ...graph,
    graph_version: `${graph.graph_version}+evil-twin-hardening`,
    nodes: graph.nodes.map((node) => {
      if (node.kind !== "Action") return node;
      const existingIds = new Set(node.guardrails.map((guardrail) => guardrail.guardrail_id));
      return {
        ...node,
        guardrails: [
          ...node.guardrails,
          ...guardrails
            .filter((guardrail) => !existingIds.has(guardrail.guardrail_id))
            .map((guardrail) => ({
              guardrail_id: guardrail.guardrail_id,
              predicate: guardrail.predicate,
              severity: "block" as const,
            })),
        ],
      };
    }),
  };
}

function nodeIdsForAssumption(graph: DojoSkillGraph, selector: DojoEvilTwinNodeSelector): string[] {
  const kindsBySelector: Record<Exclude<DojoEvilTwinNodeSelector, "all">, string[]> = {
    action: ["Action"],
    action_assertion: ["Action", "Assertion"],
    input_action: ["Input", "Observe", "Locate", "Action"],
    observe_locate_action: ["Observe", "Locate", "Action", "Assertion"],
    artifact_action: ["Artifact", "Action", "Assertion"],
    permission_action: ["Permission", "Human", "Action"],
  };
  if (selector === "all") return graph.nodes.map((node) => node.node_id);
  const allowedKinds = new Set(kindsBySelector[selector]);
  return graph.nodes.filter((node) => allowedKinds.has(node.kind)).map((node) => node.node_id);
}

function slugId(value: string): string {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
