import { describe, expect, it } from "vitest";
import { DojoVivariumRunner } from "../../src/dojo/vivarium/runner.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
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
      seed: "baseline-seed",
      now: "2026-06-11T00:00:00.000Z",
    });

    const result = await runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-baseline",
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(materialized.fixture.synthetic_data_only).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.scenarioRunResult.v1",
      run_id: "scenario-run-baseline",
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

  it("proves fixture reset is deterministic for the materialized scenario seed", () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "duplicate_entity",
        risk_tags: ["ambiguous_entity_match"],
      })),
      seed: "duplicate-reset-seed",
    });

    expect(runner.reset({ materialized })).toEqual(expect.objectContaining({
      ok: true,
      materialized_id: materialized.materialized_id,
      scenario_id: materialized.definition.scenario_id,
      materialization_hash: materialized.fixture.materialization_hash,
      blocked_by: [],
    }));
  });
});

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
