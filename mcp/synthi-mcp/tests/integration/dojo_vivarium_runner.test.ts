import { describe, expect, it } from "vitest";
import { DojoVivariumRunner } from "../../src/dojo/vivarium/runner.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo Vivarium runner", () => {
  it("runs a baseline scenario through materialized fixtures, graph runtime, and oracle", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "baseline",
      layer: "skill",
      risk_tags: ["baseline"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      tenant: tenantContext(),
      seed: "baseline-seed",
      now: "2026-06-11T00:00:00.000Z",
    });

    const result = await runner.run({
      materialized,
      graph: graphFixture(),
      tenant: tenantContext(),
      run_id: "scenario-run-baseline",
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(materialized.fixture.synthetic_data_only).toBe(true);
    expect(materialized.tenant_context).toEqual(expect.objectContaining({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      request_id: "vivarium-runtime-test",
    }));
    expect(result).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.scenarioRunResult.v1",
      run_id: "scenario-run-baseline",
      tenant_context: expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        correlation_id: "vivarium-runtime-test-correlation",
      }),
      status: "passed",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["graph_run_result", "graph_node_evidence", "oracle_result"]),
      evidence_refs: expect.arrayContaining([
        "dojo-graph://scenario-run-baseline/trigger",
        "dojo-graph://scenario-run-baseline/action",
        "dojo-oracle://scenario-run-baseline/oracle_seed-a_scenario_baseline",
      ]),
    }));
  });

  it("classifies fake success as failed from observed fixture state instead of visual success", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "fake_success",
      layer: "risk",
      risk_tags: ["fake_success", "evidence_required"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "fake-success-seed",
    });

    const result = await runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-fake-success",
    });

    expect(materialized.fixture.api_state.fake_success).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      expectation_met: true,
      oracle_result: expect.objectContaining({
        blocked_by: ["oracle_durable_state_evidence_missing"],
        finding: "Scenario produced fake visual success without durable state evidence.",
      }),
    }));
  });

  it("passes prompt injection scenarios only when document instructions are quarantined", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "prompt_injection",
      layer: "risk",
      risk_tags: ["prompt_injection", "untrusted_document"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "prompt-injection-seed",
    });

    const result = await runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-prompt-injection",
    });

    expect(materialized.fixture.document_state.prompt_injection_present).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      status: "passed",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["document_instruction_quarantine"]),
      oracle_result: expect.objectContaining({
        blocked_by: [],
      }),
    }));
  });

  it("generates deterministic run IDs and timestamps when a run clock is supplied", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      seed: "deterministic-run-seed",
      now: "2026-06-11T00:00:00.000Z",
    });
    const first = await runner.run({
      materialized,
      graph: graphFixture(),
      now: "2026-06-11T00:00:01.000Z",
    });
    const second = await runner.run({
      materialized,
      graph: graphFixture(),
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(first.run_id).toBe(second.run_id);
    expect(first.started_at).toBe("2026-06-11T00:00:01.000Z");
    expect(first.completed_at).toBe("2026-06-11T00:00:01.000Z");
    expect(first.evidence_refs).toEqual(expect.arrayContaining([
      `dojo-oracle://${first.run_id}/${first.oracle_result.oracle_id}`,
    ]));
  });

  it("classifies exhausted scenario budget as a blocked run instead of throwing", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      seed: "budget-exhausted-seed",
    });

    await expect(runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-budget-exhausted",
      budget: {
        ...materialized.definition.budget,
        max_runs: 0,
      },
      now: "2026-06-11T00:00:01.000Z",
    })).resolves.toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: false,
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["dojo_scenario_budget_max_runs_exhausted"],
        evidence_refs: ["dojo-budget://scenario-run-budget-exhausted"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["dojo_scenario_budget_max_runs_exhausted"],
      }),
      observed_evidence: expect.arrayContaining(["graph_run_result", "oracle_result", "scenario_budget_state"]),
      evidence_refs: expect.arrayContaining([
        "dojo-budget://scenario-run-budget-exhausted",
        "dojo-oracle://scenario-run-budget-exhausted/oracle_seed-a_scenario_baseline",
      ]),
    }));
  });

  it("classifies runtime execution failures as blocked scenario runs", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      seed: "runtime-failure-seed",
    });

    await expect(runner.run({
      materialized,
      graph: graphFixture(),
      runtime: throwingRuntime(),
      run_id: "scenario-run-runtime-failed",
      now: "2026-06-11T00:00:01.000Z",
    })).resolves.toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: false,
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["dojo_graph_runtime_failed"],
        evidence_refs: ["dojo-graph-runtime://scenario-run-runtime-failed/failed"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["dojo_graph_runtime_failed"],
      }),
      evidence_refs: expect.arrayContaining([
        "dojo-graph-runtime://scenario-run-runtime-failed/failed",
        "dojo-oracle://scenario-run-runtime-failed/oracle_seed-a_scenario_baseline",
      ]),
    }));
  });

  it("proves fixture reset is deterministic for the materialized scenario seed", () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "duplicate_entity",
        risk_tags: ["ambiguous_entity_match"],
      })),
      tenant: tenantContext(),
      seed: "duplicate-reset-seed",
    });

    expect(runner.reset({ materialized })).toEqual(expect.objectContaining({
      ok: true,
      materialized_id: materialized.materialized_id,
      tenant_context: expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
      }),
      scenario_id: materialized.definition.scenario_id,
      materialization_hash: materialized.fixture.materialization_hash,
      blocked_by: [],
    }));
  });
});

function tenantContext() {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "runner-test",
    actor_type: "agent" as const,
    roles: ["dojo:test"],
    request_id: "vivarium-runtime-test",
    correlation_id: "vivarium-runtime-test-correlation",
  };
}

function graphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-vivarium",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("action", "Action", "Synthetic action"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_action",
        from_node_id: "trigger",
        to_node_id: "action",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function throwingRuntime(): DojoSkillGraphRuntime {
  return {
    validateGraph: () => ({ ok: true, issues: [] }),
    execute: async () => {
      throw new Error("graph runtime unavailable");
    },
  } as DojoSkillGraphRuntime;
}

function safeNode(
  nodeId: string,
  kind: DojoSkillGraph["nodes"][number]["kind"],
  label: string
): DojoSkillGraph["nodes"][number] {
  return {
    node_id: nodeId,
    kind,
    label,
    risk: "safe",
    preconditions: [],
    postconditions: [],
    guardrails: [],
    assertions: [],
    substrate_options: kind === "Action" ? ["dom"] : [],
    evidence_policy: kind === "Action" ? ["append_action_trace"] : [],
    case_law_refs: [],
    expiry_triggers: [],
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
