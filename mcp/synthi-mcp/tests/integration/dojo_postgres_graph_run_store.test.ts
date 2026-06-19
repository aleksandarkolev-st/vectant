import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runDojoExecutableCheckride } from "../../src/dojo/checkride/runner.js";
import { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import { PostgresDojoGraphRunStore } from "../../src/dojo/store/postgres_graph_run_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoGraphRunStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let skillId: string;
  let skillVersion: string;
  let graph: DojoSkillGraph;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_graph_run";
    skillId = "skill_graph_run";
    skillVersion = "skill_v1";
    graph = graphFixture(skillId, skillVersion);
    await seedSkillVersion(pool, tenantId, workspaceId, skillId, skillVersion);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists skill graphs, node memories, and graph execution runs", async () => {
    const store = new PostgresDojoGraphRunStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });

    const graphRecord = await store.saveSkillGraph(graph, { created_by: "graph-compiler-test" });

    expect(graphRecord).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      graph_id: graph.graph_id,
      skill_id: skillId,
      status: "checkride",
      validation: expect.objectContaining({ ok: true }),
      graph_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(await store.listNodeMemories({ graph_id: graph.graph_id })).toEqual([
      expect.objectContaining({
        node_id: "action_submit",
        node_kind: "Action",
        confidence: 0.91,
        evidence_refs: ["evidence:node-action"],
        memory_json: expect.objectContaining({
          node: expect.objectContaining({ node_id: "action_submit" }),
        }),
      }),
      expect.objectContaining({ node_id: "trigger", node_kind: "Trigger" }),
    ]);

    const runtime = new DojoSkillGraphRuntime();
    const run = await runtime.execute({
      graph,
      run_id: "graph_run_a",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        submission_state: "success",
        assertion_results: { assert_submission_state: true },
      },
      evidence_writer: (event) => `ledger://${event.run_id}/${event.node_id}`,
    });
    const savedRun = await store.saveGraphRun(run, {
      graph_id: graph.graph_id,
      skill_id: graph.skill_id,
      started_at: "2026-06-11T00:00:00.000Z",
      completed_at: "2026-06-11T00:00:01.000Z",
      created_by: "graph-runtime-test",
    });

    expect(savedRun).toEqual(expect.objectContaining({
      graph_run_id: "graph_run_a",
      graph_id: graph.graph_id,
      skill_id: skillId,
      mode: "checkride",
      status: "completed",
      blocked_by: [],
      evidence_refs: ["ledger://graph_run_a/trigger", "ledger://graph_run_a/action_submit"],
      result: expect.objectContaining({ run_id: "graph_run_a", ok: true }),
    }));
    expect(await store.getGraphRun("graph_run_a")).toEqual(savedRun);
  });

  it("persists executable checkride reports and scenario runs from observed runtime evidence", async () => {
    const store = new PostgresDojoGraphRunStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    await store.saveSkillGraph(graph, { created_by: "graph-compiler-test" });
    const baseline = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "baseline",
      layer: "skill",
      risk_tags: ["baseline"],
    }));
    const report = await runDojoExecutableCheckride({
      graph,
      scenarios: [baseline],
      base_inputs: {
        workspace_verified: true,
        client_id_verified: true,
        submission_state: "success",
        assertion_results: { assert_submission_state: true },
      },
      observed_evidence_by_scenario: {
        [baseline.scenario_id]: ["graph_run_result", "graph_node_evidence", "oracle_result"],
      },
      evidence_context: {
        tenant_id: tenantId,
        workspace_id: workspaceId,
        skill_id: graph.skill_id,
        created_at: "2026-06-11T00:00:00.000Z",
        created_by: "checkride-test",
        run_id_prefix: "run",
      },
      now: "2026-06-11T00:00:00.000Z",
    });

    const checkride = await store.saveCheckrideRun(report, {
      skill_version: graph.skill_version,
      created_by: "checkride-test",
      entrustment_level: "E3",
      readiness_level: 5,
    });
    const scenario = await store.saveScenarioRun(report.results[0]!, {
      checkride_run_id: checkride.checkride_run_id,
      skill_id: graph.skill_id,
      started_at: "2026-06-11T00:00:00.000Z",
      completed_at: "2026-06-11T00:00:01.000Z",
      created_by: "checkride-test",
    });

    expect(checkride).toEqual(expect.objectContaining({
      checkride_run_id: report.checkride_id,
      skill_id: graph.skill_id,
      skill_version: graph.skill_version,
      graph_id: graph.graph_id,
      status: "passed",
      entrustment_level: "E3",
      readiness_level: 5,
      evidence_record_ids: report.results[0]?.evidence_record ? [report.results[0].evidence_record.record_id] : [],
      score_json: expect.objectContaining({
        coverage_score: 1,
        production_recommendation: "allowed",
      }),
      report: expect.objectContaining({ checkride_id: report.checkride_id }),
    }));
    expect(scenario).toEqual(expect.objectContaining({
      scenario_run_id: report.results[0]?.scenario_run.run_id,
      scenario_id: baseline.scenario_id,
      checkride_run_id: checkride.checkride_run_id,
      skill_id: graph.skill_id,
      status: "passed",
      oracle_status: "pass",
      fixture_sha256: report.results[0]?.fixture.materialization_hash,
      evidence_record_ids: report.results[0]?.evidence_record ? [report.results[0].evidence_record.record_id] : [],
    }));
    expect(await store.getCheckrideRun(report.checkride_id)).toEqual(checkride);
    expect(await store.getScenarioRun(report.results[0]!.scenario_run.run_id)).toEqual(scenario);
  });

  it("rejects invalid graph records before persistence and isolates graph reads by tenant", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkillVersion(pool, otherTenantId, workspaceId, skillId, skillVersion);
    const tenantStore = new PostgresDojoGraphRunStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoGraphRunStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    await tenantStore.saveSkillGraph(graph, { created_by: "graph-compiler-test" });

    expect(await tenantStore.getSkillGraph(graph.graph_id)).toEqual(expect.objectContaining({ graph_id: graph.graph_id }));
    expect(await otherStore.getSkillGraph(graph.graph_id)).toBeNull();
    await expect(tenantStore.saveSkillGraph({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.node_id === "action_submit"
          ? { ...node, guardrails: [] }
          : node
      ),
    })).rejects.toThrow(/dojo_postgres_graph_invalid/);
  });
});

async function seedSkillVersion(
  pool: Pool,
  tenantId: string,
  workspaceId: string,
  skillId: string,
  skillVersion: string
): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_tenants (tenant_id, organization_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, "org_a", tenantId]
  );
  await pool.query(
    `INSERT INTO dojo_workspaces (tenant_id, workspace_id, organization_id, app_origin)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
    [tenantId, workspaceId, "org_a", "https://app.example.test"]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, status, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, 'published', $6, $7::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
    [tenantId, workspaceId, skillId, `workflow_${skillId}`, "Graph Run Test Skill", skillVersion, JSON.stringify({ skill_id: skillId })]
  );
  await pool.query(
    `INSERT INTO dojo_skill_versions (tenant_id, workspace_id, skill_id, skill_version, graph_version, seed_json, graph_json, created_by)
    VALUES ($1, $2, $3, $4, 'graph_v1', '{}'::jsonb, '{}'::jsonb, 'test')
    ON CONFLICT (tenant_id, skill_id, skill_version) DO NOTHING`,
    [tenantId, workspaceId, skillId, skillVersion]
  );
}

function graphFixture(skillId: string, skillVersion: string): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: `graph_${skillId}`,
    skill_id: skillId,
    skill_version: skillVersion,
    graph_version: "graph_v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        node_id: "trigger",
        kind: "Trigger",
        label: "Start",
        risk: "safe",
        preconditions: [],
        postconditions: [],
        guardrails: [],
        assertions: [],
        substrate_options: [],
        evidence_policy: [],
        case_law_refs: [],
        expiry_triggers: [],
      },
      {
        node_id: "action_submit",
        kind: "Action",
        label: "Submit invoice",
        risk: "dangerous",
        action: "run_workflow",
        preconditions: ["workspace_verified == true"],
        postconditions: ["submission_state == success"],
        guardrails: [
          {
            guardrail_id: "guard_client_stable_id",
            predicate: "client_id_verified == true",
            severity: "block",
          },
        ],
        proof: {
          required: true,
          required_claims: ["checkride_passed", "workspace_verified"],
          required_guardrails: ["guard_client_stable_id"],
        },
        assertions: [
          {
            assertion_id: "assert_submission_state",
            description: "Submission state is success.",
            required: true,
          },
        ],
        substrate_options: ["dom"],
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: [],
        metadata: {
          confidence: 0.91,
          evidence_refs: ["evidence:node-action"],
          rollback_policy: {
            strategy: "human_checkpoint",
          },
        },
      },
    ],
    edges: [
      {
        edge_id: "edge_trigger_action",
        from_node_id: "trigger",
        to_node_id: "action_submit",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function scenarioFixture(overrides: Partial<DojoScenario>): DojoScenario {
  const mutationKind = overrides.mutation_kind ?? "baseline";
  return {
    scenario_id: `seed-a_scenario_${mutationKind}`,
    title: "Synthetic scenario",
    layer: overrides.layer ?? "risk",
    simulator_tier: overrides.simulator_tier ?? 2,
    mutation_kind: mutationKind,
    expected_behavior: "Exercise the skill against a synthetic fixture.",
    risk_tags: overrides.risk_tags ?? [],
    generated_from: overrides.generated_from ?? "dojo_template",
  };
}
