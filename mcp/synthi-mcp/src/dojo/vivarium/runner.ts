import { createHash } from "node:crypto";
import { DojoSkillGraphRuntime, type DojoGraphEvidenceEvent, type DojoGraphRunResult } from "../graph/runtime.js";
import type {
  DojoSubstrateExecutionResult,
  DojoSubstrateExecutor,
} from "../graph/substrate_executor.js";
import { selectDojoExecutionSubstrate } from "../graph/substrate_executor.js";
import type { DojoSkillGraph } from "../graph/types.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import { type DojoMaterializedFixture, materializeDojoSyntheticFixture } from "./fixture_materializer.js";
import { evaluateDojoScenarioOracle, type DojoScenarioOracleEvaluation, type DojoScenarioOracleStatus } from "./oracle.js";
import type { DojoScenarioBudget, DojoScenarioDefinition } from "./scenario_dsl.js";
import {
  startDojoApiFaultServer,
  type DojoApiFaultBehavior,
  type DojoApiFaultServerState,
} from "./api_fault_server.js";

const TARGET_POSTCONDITION_DESCENDANT_KINDS = new Set<string>(["Assertion", "Artifact", "Rollback"]);

export interface DojoMaterializedScenario {
  schema_version: "synthi.dojo.materializedScenario.v1";
  materialized_id: string;
  skill_id: string;
  tenant_context?: DojoTenantContext;
  definition: DojoScenarioDefinition;
  fixture: DojoMaterializedFixture;
  materialized_at: string;
}

export interface DojoScenarioRunResult {
  schema_version: "synthi.dojo.scenarioRunResult.v1";
  run_id: string;
  scenario_id: string;
  mutation_kind: string;
  materialized_id: string;
  tenant_context?: DojoTenantContext;
  fixture_materialization_hash: string;
  status: DojoScenarioOracleStatus;
  expectation_met: boolean;
  graph_result: DojoGraphRunResult;
  oracle_result: DojoScenarioOracleEvaluation;
  api_fault?: DojoApiFaultExecution;
  observed_evidence: string[];
  evidence_refs: string[];
  started_at: string;
  completed_at: string;
  budget: DojoScenarioBudget;
  budget_usage: DojoScenarioBudgetUsage;
}

export interface DojoApiFaultExecution {
  schema_version: "synthi.dojo.apiFaultExecution.v1";
  behavior: DojoApiFaultBehavior;
  url: string;
  request_count: number;
  response_status: number;
  response_body: unknown;
  durable_state: DojoApiFaultServerState["durable_state"];
  evidence_refs: string[];
}

export interface DojoScenarioBudgetUsage {
  elapsed_ms: number;
  model_calls: number;
  max_runs: number;
  max_estimated_ms: number;
  max_model_calls: number;
}

export interface DojoFixtureResetResult {
  schema_version: "synthi.dojo.fixtureResetResult.v1";
  ok: boolean;
  materialized_id: string;
  tenant_context?: DojoTenantContext;
  scenario_id: string;
  fixture_id: string;
  reset_profile_id: string;
  reset_seed: string;
  materialization_hash: string;
  blocked_by: string[];
}

export class DojoVivariumRunner {
  materialize(input: {
    skill_id: string;
    scenario: DojoScenarioDefinition;
    tenant?: DojoTenantContext;
    seed?: string;
    now?: string;
  }): DojoMaterializedScenario {
    const fixture = materializeDojoSyntheticFixture(input.scenario, { seed: input.seed });
    return {
      schema_version: "synthi.dojo.materializedScenario.v1",
      materialized_id: `materialized_${input.scenario.scenario_id}_${fixture.materialization_hash.slice(0, 12)}`,
      skill_id: input.skill_id,
      ...(input.tenant ? { tenant_context: cloneTenantContext(input.tenant) } : {}),
      definition: input.scenario,
      fixture,
      materialized_at: input.now ?? new Date().toISOString(),
    };
  }

  async run(input: {
    materialized: DojoMaterializedScenario;
    graph: DojoSkillGraph;
    tenant?: DojoTenantContext;
    runtime?: DojoSkillGraphRuntime;
    substrate_executor?: DojoSubstrateExecutor;
    run_id?: string;
    budget?: DojoScenarioBudget;
    inputs?: Record<string, unknown>;
    observed_evidence?: string[];
    model_calls_used?: number;
    now?: string;
  }): Promise<DojoScenarioRunResult> {
    const budget = input.budget ?? input.materialized.definition.budget;
    const runtime = input.runtime ?? new DojoSkillGraphRuntime();
    const tenantContext = input.tenant ?? input.materialized.tenant_context;
    const graphEvents: DojoGraphEvidenceEvent[] = [];
    const startedAt = input.now ?? new Date().toISOString();
    const runId = input.run_id ?? createScenarioRunId(input.materialized, input.graph, startedAt);
    let completedAt = input.now ?? new Date().toISOString();
    const targetedGraph = graphForScenarioTargets(input.graph, input.materialized.definition.target_graph_node_ids);
    if (!targetedGraph.ok) {
      return blockedScenarioRunResult({
        materialized: input.materialized,
        tenant: tenantContext,
        graph: input.graph,
        run_id: runId,
        started_at: startedAt,
        completed_at: completedAt,
        budget,
        budget_usage: budgetUsage(budget, startedAt, completedAt, 0),
        blocked_by: targetedGraph.blocked_by,
        observed_evidence: input.observed_evidence ?? [],
      });
    }
    if (budget.max_runs < 1) {
      return blockedScenarioRunResult({
        materialized: input.materialized,
        tenant: tenantContext,
        graph: input.graph,
        run_id: runId,
        started_at: startedAt,
        completed_at: completedAt,
        budget,
        budget_usage: budgetUsage(budget, startedAt, completedAt, 0),
        blocked_by: ["dojo_scenario_budget_max_runs_exhausted"],
        observed_evidence: input.observed_evidence ?? [],
      });
    }

    let apiFaultExecution: DojoApiFaultExecution | undefined;
    const scenarioSubstrateExecutor = input.substrate_executor
      ?? createApiFaultScenarioSubstrateExecutor({
        materialized: input.materialized,
        run_id: runId,
        budget,
        recordExecution: (execution) => {
          apiFaultExecution = execution;
        },
      });
    let graphResult: DojoGraphRunResult;
    try {
      graphResult = await runtime.execute({
        graph: targetedGraph.graph,
        run_id: runId,
        mode: "checkride",
        now: startedAt,
        inputs: {
          ...input.materialized.definition.input_overrides,
          ...fixtureInputs(input.materialized.fixture),
          ...(input.inputs ?? {}),
        },
        evidence_writer: (event) => {
          graphEvents.push(event);
          return `dojo-graph://${event.run_id}/${event.node_id}`;
        },
        ...(scenarioSubstrateExecutor ? { substrate_executor: scenarioSubstrateExecutor } : {}),
      });
    } catch {
      graphResult = blockedGraphRunResult(runId, ["dojo_graph_runtime_failed"], [
        `dojo-graph-runtime://${runId}/failed`,
      ]);
    }
    completedAt = input.now ?? new Date().toISOString();
    const usage = budgetUsage(
      budget,
      startedAt,
      completedAt,
      input.model_calls_used ?? modelCallsUsedFromInputs(input.inputs)
    );
    const budgetBlockedBy = budgetBlockedByForUsage(usage);
    if (budgetBlockedBy.length > 0) {
      graphResult = {
        ...graphResult,
        ok: false,
        status: "blocked",
        blocked_by: [...new Set([...graphResult.blocked_by, ...budgetBlockedBy])],
        evidence_refs: [...graphResult.evidence_refs, `dojo-budget://${runId}`],
      };
    }
    const observedEvidence = observedEvidenceForRun(input.materialized, graphResult, graphEvents, [
      ...(budgetBlockedBy.length > 0 ? ["scenario_budget_state"] : []),
      ...apiFaultObservedEvidence(apiFaultExecution),
      ...(input.observed_evidence ?? []),
    ]);
    const oracleResult = evaluateDojoScenarioOracle({
      definition: input.materialized.definition,
      fixture: input.materialized.fixture,
      graph_result: graphResult,
      observed_evidence: observedEvidence,
    });
    return {
      schema_version: "synthi.dojo.scenarioRunResult.v1",
      run_id: runId,
      scenario_id: input.materialized.definition.scenario_id,
      mutation_kind: input.materialized.definition.mutation_kind,
      materialized_id: input.materialized.materialized_id,
      ...(tenantContext ? { tenant_context: cloneTenantContext(tenantContext) } : {}),
      fixture_materialization_hash: input.materialized.fixture.materialization_hash,
      status: oracleResult.status,
      expectation_met: oracleResult.expectation_met,
      graph_result: graphResult,
      oracle_result: oracleResult,
      ...(apiFaultExecution ? { api_fault: apiFaultExecution } : {}),
      observed_evidence: observedEvidence,
      evidence_refs: [
        ...graphResult.evidence_refs,
        ...(apiFaultExecution?.evidence_refs ?? []),
        `dojo-oracle://${runId}/${oracleResult.oracle_id}`,
      ],
      started_at: startedAt,
      completed_at: completedAt,
      budget,
      budget_usage: usage,
    };
  }

  reset(input: { materialized: DojoMaterializedScenario }): DojoFixtureResetResult {
    const resetFixture = materializeDojoSyntheticFixture(input.materialized.definition, {
      seed: input.materialized.fixture.seed,
    });
    const ok = resetFixture.materialization_hash === input.materialized.fixture.materialization_hash;
    return {
      schema_version: "synthi.dojo.fixtureResetResult.v1",
      ok,
      materialized_id: input.materialized.materialized_id,
      ...(input.materialized.tenant_context ? { tenant_context: cloneTenantContext(input.materialized.tenant_context) } : {}),
      scenario_id: input.materialized.definition.scenario_id,
      fixture_id: input.materialized.fixture.fixture_id,
      reset_profile_id: input.materialized.fixture.reset_evidence.reset_profile_id,
      reset_seed: input.materialized.fixture.reset_evidence.reset_seed,
      materialization_hash: resetFixture.materialization_hash,
      blocked_by: ok ? [] : ["fixture_reset_not_deterministic"],
    };
  }
}

function blockedScenarioRunResult(input: {
  materialized: DojoMaterializedScenario;
  tenant?: DojoTenantContext;
  graph: DojoSkillGraph;
  run_id: string;
  started_at: string;
  completed_at: string;
  budget: DojoScenarioBudget;
  budget_usage: DojoScenarioBudgetUsage;
  blocked_by: string[];
  observed_evidence: string[];
}): DojoScenarioRunResult {
  const graphResult = blockedGraphRunResult(input.run_id, input.blocked_by, [`dojo-budget://${input.run_id}`]);
  const observedEvidence = observedEvidenceForRun(input.materialized, graphResult, [], [
    ...input.observed_evidence,
    "scenario_budget_state",
  ]);
  const oracleResult = evaluateDojoScenarioOracle({
    definition: input.materialized.definition,
    fixture: input.materialized.fixture,
    graph_result: graphResult,
    observed_evidence: observedEvidence,
  });
  return {
    schema_version: "synthi.dojo.scenarioRunResult.v1",
    run_id: input.run_id,
    scenario_id: input.materialized.definition.scenario_id,
    mutation_kind: input.materialized.definition.mutation_kind,
    materialized_id: input.materialized.materialized_id,
    ...(input.tenant ? { tenant_context: cloneTenantContext(input.tenant) } : {}),
    fixture_materialization_hash: input.materialized.fixture.materialization_hash,
    status: oracleResult.status,
    expectation_met: oracleResult.expectation_met,
    graph_result: graphResult,
    oracle_result: oracleResult,
    observed_evidence: observedEvidence,
    evidence_refs: [...graphResult.evidence_refs, `dojo-oracle://${input.run_id}/${oracleResult.oracle_id}`],
    started_at: input.started_at,
    completed_at: input.completed_at,
    budget: input.budget,
    budget_usage: input.budget_usage,
  };
}

function blockedGraphRunResult(runId: string, blockedBy: string[], evidenceRefs: string[]): DojoGraphRunResult {
  return {
    ok: false,
    status: "blocked",
    mode: "checkride",
    run_id: runId,
    node_results: [],
    blocked_by: [...blockedBy],
    evidence_refs: [...evidenceRefs],
  };
}

function graphForScenarioTargets(
  graph: DojoSkillGraph,
  targetGraphNodeIds: string[]
): { ok: true; graph: DojoSkillGraph } | { ok: false; blocked_by: string[] } {
  const targetIds = [...new Set(targetGraphNodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))];
  if (targetIds.length === 0) return { ok: true, graph };

  const nodesById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const missingTargets = targetIds.filter((nodeId) => !nodesById.has(nodeId));
  if (missingTargets.length > 0) {
    return {
      ok: false,
      blocked_by: missingTargets.map((nodeId) => `dojo_scenario_target_graph_node_missing:${nodeId}`),
    };
  }

  const incomingEdgesByTarget = new Map<string, DojoSkillGraph["edges"]>();
  for (const edge of graph.edges) {
    const incoming = incomingEdgesByTarget.get(edge.to_node_id) ?? [];
    incoming.push(edge);
    incomingEdgesByTarget.set(edge.to_node_id, incoming);
  }

  const requiredNodeIds = new Set<string>();
  const queue = [...targetIds];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || requiredNodeIds.has(nodeId)) continue;
    requiredNodeIds.add(nodeId);
    for (const edge of incomingEdgesByTarget.get(nodeId) ?? []) {
      if (!requiredNodeIds.has(edge.from_node_id)) queue.push(edge.from_node_id);
    }
  }
  for (const nodeId of postconditionDescendantNodeIds(graph, targetIds, nodesById)) {
    requiredNodeIds.add(nodeId);
  }

  return {
    ok: true,
    graph: {
      ...graph,
      nodes: graph.nodes.filter((node) => requiredNodeIds.has(node.node_id)),
      edges: graph.edges.filter((edge) => requiredNodeIds.has(edge.from_node_id) && requiredNodeIds.has(edge.to_node_id)),
    },
  };
}

function postconditionDescendantNodeIds(
  graph: DojoSkillGraph,
  targetIds: string[],
  nodesById: Map<string, DojoSkillGraph["nodes"][number]>
): Set<string> {
  const outgoingEdgesBySource = new Map<string, DojoSkillGraph["edges"]>();
  for (const edge of graph.edges) {
    const outgoing = outgoingEdgesBySource.get(edge.from_node_id) ?? [];
    outgoing.push(edge);
    outgoingEdgesBySource.set(edge.from_node_id, outgoing);
  }

  const included = new Set<string>();
  const queue = [...targetIds];
  const visited = new Set<string>(targetIds);
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    for (const edge of outgoingEdgesBySource.get(nodeId) ?? []) {
      if (visited.has(edge.to_node_id)) continue;
      visited.add(edge.to_node_id);
      const child = nodesById.get(edge.to_node_id);
      if (!child || !TARGET_POSTCONDITION_DESCENDANT_KINDS.has(child.kind)) {
        continue;
      }
      included.add(child.node_id);
      queue.push(child.node_id);
    }
  }
  return included;
}

function cloneTenantContext(tenant: DojoTenantContext): DojoTenantContext {
  return {
    ...tenant,
    roles: [...tenant.roles],
  };
}

function fixtureInputs(fixture: DojoMaterializedFixture): Record<string, unknown> {
  return {
    synthetic_fixture_id: fixture.fixture_id,
    synthetic_materialization_hash: fixture.materialization_hash,
    auth_valid: !fixture.identity_state.auth_expired,
    role: fixture.identity_state.role,
    permission_downgraded: fixture.identity_state.permission_downgraded,
    missing_permission_count: fixture.identity_state.missing_permissions.length,
    workspace_changed: fixture.identity_state.workspace_changed,
    expected_workspace_id: fixture.identity_state.expected_workspace_id,
    current_workspace_id: fixture.identity_state.current_workspace_id,
    identity_approver_unavailable: fixture.identity_state.approver_unavailable,
    policy_approval_required: fixture.policy_state.approval_required,
    policy_unavailable_approver: fixture.policy_state.unavailable_approver,
    policy_blocked_action_count: fixture.policy_state.blocked_actions.length,
    policy_threshold_count: fixture.policy_state.thresholds.length,
    duplicate_display_name_count: duplicateDisplayNameCount(fixture),
    partial_write: fixture.api_state.partial_write,
    fake_success: fixture.api_state.fake_success,
    prompt_injection_present: fixture.document_state.prompt_injection_present,
    document_instruction_quarantined: fixture.document_state.instruction_quarantined,
    corrupted_document_count: fixture.document_state.corrupted_document_count,
  };
}

function observedEvidenceForRun(
  materialized: DojoMaterializedScenario,
  graphResult: DojoGraphRunResult,
  graphEvents: DojoGraphEvidenceEvent[],
  explicitEvidence: string[]
): string[] {
  const observed = new Set<string>(["graph_run_result", "oracle_result", ...explicitEvidence]);
  if (graphResult.evidence_refs.length > 0 || graphEvents.length > 0) observed.add("graph_node_evidence");
  if (
    materialized.fixture.identity_state.auth_expired
    || materialized.fixture.identity_state.permission_downgraded
    || materialized.fixture.identity_state.missing_permissions.length > 0
    || materialized.fixture.identity_state.workspace_changed
    || materialized.fixture.identity_state.approver_unavailable
  ) {
    observed.add("identity_policy_state");
  }
  if (
    materialized.fixture.policy_state.thresholds.length > 0
    || materialized.fixture.policy_state.blocked_actions.length > 0
    || materialized.fixture.policy_state.approval_required
    || materialized.fixture.policy_state.unavailable_approver
  ) {
    observed.add("policy_tissue_state");
  }
  if (materialized.fixture.api_state.partial_write) observed.add("partial_write_state");
  if (materialized.fixture.document_state.prompt_injection_present && materialized.fixture.document_state.instruction_quarantined) {
    observed.add("document_instruction_quarantine");
  }
  if (
    materialized.fixture.document_state.corrupted_document_count > 0
    || materialized.fixture.document_state.missing_fields.length > 0
    || materialized.fixture.document_state.ambiguous_file_name_groups.length > 0
  ) {
    observed.add("document_tissue_state");
  }
  return [...observed].sort();
}

async function executeApiFaultServerForScenario(
  materialized: DojoMaterializedScenario,
  runId: string,
  budget: DojoScenarioBudget
): Promise<DojoApiFaultExecution | undefined> {
  const behavior = apiFaultBehaviorForScenario(materialized);
  if (!behavior) return undefined;

  const server = await startDojoApiFaultServer({
    behavior,
    timeout_ms: Math.max(1, Math.min(250, budget.max_estimated_ms)),
  });
  try {
    const response = await fetch(`${server.url}/synthetic/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(apiFaultPayload(materialized)),
    });
    const responseBody = await response.json() as unknown;
    return {
      schema_version: "synthi.dojo.apiFaultExecution.v1",
      behavior,
      url: server.url,
      request_count: server.state.requests.length,
      response_status: response.status,
      response_body: responseBody,
      durable_state: cloneDurableApiState(server.state.durable_state),
      evidence_refs: [`dojo-api-fault://${runId}/${behavior}`],
    };
  } finally {
    await server.close();
  }
}

function apiFaultBehaviorForScenario(materialized: DojoMaterializedScenario): DojoApiFaultBehavior | undefined {
  const requiresApiServer = materialized.definition.fixture_requirements.some((fixture) => fixture.kind === "fake_api_server");
  if (!requiresApiServer) return undefined;
  if (materialized.fixture.api_state.fake_success) return "fake_success";
  if (materialized.fixture.api_state.partial_write) return "partial_write";
  if (materialized.fixture.api_state.validation_error) return "validation_error";
  if (materialized.fixture.api_state.latency_ms > 0) return "timeout";
  if (materialized.definition.mutation_kind === "downstream_failure") return "downstream_failure";
  return "success";
}

function apiFaultPayload(materialized: DojoMaterializedScenario): Record<string, unknown> {
  return {
    scenario_id: materialized.definition.scenario_id,
    mutation_kind: materialized.definition.mutation_kind,
    fixture_id: materialized.fixture.fixture_id,
    materialization_hash: materialized.fixture.materialization_hash,
    input_overrides: materialized.definition.input_overrides,
    record_ids: materialized.fixture.records.map((record) => record.stable_id),
  };
}

function cloneDurableApiState(state: DojoApiFaultServerState["durable_state"]): DojoApiFaultServerState["durable_state"] {
  return {
    committed: state.committed,
    partial: state.partial,
    validation_error: state.validation_error,
    fake_success: state.fake_success,
    downstream_failed: state.downstream_failed,
    records: state.records.map((record) => ({ ...record })),
  };
}

function apiFaultObservedEvidence(apiFault: DojoApiFaultExecution | undefined): string[] {
  if (!apiFault) return [];
  const evidence = new Set<string>(["api_fault_server_executed"]);
  if (apiFault.durable_state.committed) evidence.add("durable_state_evidence");
  if (apiFault.durable_state.partial) evidence.add("partial_write_state");
  if (apiFault.durable_state.validation_error) evidence.add("api_validation_error_state");
  if (apiFault.durable_state.fake_success) evidence.add("fake_success_visual_only");
  if (apiFault.durable_state.downstream_failed) evidence.add("api_downstream_failure_state");
  return [...evidence].sort();
}

function createApiFaultScenarioSubstrateExecutor(input: {
  materialized: DojoMaterializedScenario;
  run_id: string;
  budget: DojoScenarioBudget;
  recordExecution: (execution: DojoApiFaultExecution) => void;
}): DojoSubstrateExecutor | undefined {
  if (!apiFaultBehaviorForScenario(input.materialized)) return undefined;
  return {
    execute: async (request): Promise<DojoSubstrateExecutionResult> => {
      const substrateSelection = selectDojoExecutionSubstrate({
        node_substrate_options: request.node.substrate_options,
        inputs: request.inputs,
        mode: request.mode ?? "checkride",
      });
      if (!substrateSelection.ok) {
        return {
          ok: false,
          status: "blocked",
          blocked_by: substrateSelection.blocked_by,
          evidence_refs: [],
        };
      }
      const execution = await executeApiFaultServerForScenario(input.materialized, input.run_id, input.budget);
      if (!execution) {
        return {
          ok: false,
          status: "blocked",
          substrate: substrateSelection.substrate,
          blocked_by: ["api_fault_server_required"],
          evidence_refs: [],
        };
      }
      input.recordExecution(execution);
      const blockedBy = apiFaultSubstrateBlockedBy(execution);
      return {
        ok: blockedBy.length === 0,
        status: blockedBy.length === 0 ? "executed" : "blocked",
        substrate: substrateSelection.substrate,
        blocked_by: blockedBy,
        evidence_refs: [...execution.evidence_refs],
      };
    },
  };
}

function apiFaultSubstrateBlockedBy(execution: DojoApiFaultExecution): string[] {
  if (execution.behavior === "validation_error") return ["api_fault_validation_error"];
  if (execution.behavior === "timeout") return ["api_fault_timeout"];
  if (execution.behavior === "downstream_failure") return ["api_fault_downstream_failure"];
  if (execution.response_status >= 400) return [`api_fault_response_status:${execution.response_status}`];
  return [];
}

function budgetUsage(
  budget: DojoScenarioBudget,
  startedAt: string,
  completedAt: string,
  modelCalls: number
): DojoScenarioBudgetUsage {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
    ? Math.max(0, completedMs - startedMs)
    : 0;
  return {
    elapsed_ms: elapsedMs,
    model_calls: Math.max(0, Math.trunc(modelCalls)),
    max_runs: budget.max_runs,
    max_estimated_ms: budget.max_estimated_ms,
    max_model_calls: budget.max_model_calls,
  };
}

function budgetBlockedByForUsage(usage: DojoScenarioBudgetUsage): string[] {
  const blockedBy: string[] = [];
  if (usage.max_estimated_ms < 1 || usage.elapsed_ms > usage.max_estimated_ms) {
    blockedBy.push("dojo_scenario_budget_time_exhausted");
  }
  if (usage.max_model_calls < 0 || usage.model_calls > usage.max_model_calls) {
    blockedBy.push("dojo_scenario_budget_model_calls_exhausted");
  }
  return blockedBy;
}

function modelCallsUsedFromInputs(inputs: Record<string, unknown> | undefined): number {
  const value = inputs?.["model_calls_used"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function duplicateDisplayNameCount(fixture: DojoMaterializedFixture): number {
  const counts = new Map<string, number>();
  for (const record of fixture.records) {
    counts.set(record.display_name, (counts.get(record.display_name) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function createScenarioRunId(materialized: DojoMaterializedScenario, graph: DojoSkillGraph, startedAt: string): string {
  const digest = createHash("sha256")
    .update([
      materialized.materialized_id,
      materialized.fixture.materialization_hash,
      graph.graph_id,
      graph.graph_version,
      startedAt,
    ].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `scenario_run_${materialized.definition.scenario_id}_${digest}`;
}
