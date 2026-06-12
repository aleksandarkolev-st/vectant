import { DojoSkillGraphRuntime, type DojoGraphEvidenceEvent, type DojoGraphRunResult } from "../graph/runtime.js";
import type { DojoSkillGraph } from "../graph/types.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import { type DojoMaterializedFixture, materializeDojoSyntheticFixture } from "./fixture_materializer.js";
import { evaluateDojoScenarioOracle, type DojoScenarioOracleEvaluation, type DojoScenarioOracleStatus } from "./oracle.js";
import type { DojoScenarioBudget, DojoScenarioDefinition } from "./scenario_dsl.js";

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
  observed_evidence: string[];
  evidence_refs: string[];
  started_at: string;
  completed_at: string;
  budget: DojoScenarioBudget;
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
    run_id?: string;
    budget?: DojoScenarioBudget;
    inputs?: Record<string, unknown>;
    observed_evidence?: string[];
    now?: string;
  }): Promise<DojoScenarioRunResult> {
    const budget = input.budget ?? input.materialized.definition.budget;
    if (budget.max_runs < 1) {
      throw new Error("dojo_scenario_budget_max_runs_exhausted");
    }

    const runtime = input.runtime ?? new DojoSkillGraphRuntime();
    const runId = input.run_id ?? `scenario_run_${input.materialized.definition.scenario_id}_${Date.now().toString(36)}`;
    const tenantContext = input.tenant ?? input.materialized.tenant_context;
    const graphEvents: DojoGraphEvidenceEvent[] = [];
    const startedAt = input.now ?? new Date().toISOString();
    const graphResult = await runtime.execute({
      graph: input.graph,
      run_id: runId,
      mode: "checkride",
      inputs: {
        ...input.materialized.definition.input_overrides,
        ...fixtureInputs(input.materialized.fixture),
        ...(input.inputs ?? {}),
      },
      evidence_writer: (event) => {
        graphEvents.push(event);
        return `dojo-graph://${event.run_id}/${event.node_id}`;
      },
    });
    const observedEvidence = observedEvidenceForRun(input.materialized, graphResult, graphEvents, input.observed_evidence ?? []);
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
      observed_evidence: observedEvidence,
      evidence_refs: [...graphResult.evidence_refs, `dojo-oracle://${runId}/${oracleResult.oracle_id}`],
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      budget,
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
  if (materialized.fixture.identity_state.auth_expired || materialized.fixture.identity_state.permission_downgraded) {
    observed.add("identity_policy_state");
  }
  if (materialized.fixture.api_state.partial_write) observed.add("partial_write_state");
  if (materialized.fixture.document_state.prompt_injection_present && materialized.fixture.document_state.instruction_quarantined) {
    observed.add("document_instruction_quarantine");
  }
  if (materialized.fixture.document_state.corrupted_document_count > 0 || materialized.fixture.document_state.missing_fields.length > 0) {
    observed.add("document_tissue_state");
  }
  return [...observed].sort();
}

function duplicateDisplayNameCount(fixture: DojoMaterializedFixture): number {
  const counts = new Map<string, number>();
  for (const record of fixture.records) {
    counts.set(record.display_name, (counts.get(record.display_name) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}
