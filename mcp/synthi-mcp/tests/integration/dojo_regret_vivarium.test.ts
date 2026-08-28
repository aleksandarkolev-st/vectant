import { describe, expect, it } from "vitest";
import type { DojoScenario } from "../../src/browser/dojo.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import { DojoVivariumRunner } from "../../src/dojo/vivarium/runner.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";

describe("Dojo regret vivarium counterfactual branches", () => {
  it("runs comparable branches from one reset profile and records quarantined mutation trials", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "duplicate_entity",
        risk_tags: ["ambiguous_entity_match", "api_conflict"],
      }), {
        expected_outcome_overrides: { duplicate_entity: "block" },
      }),
      tenant: tenantContext(),
      seed: "regret-vivarium-duplicate-seed",
      now: "2026-06-24T02:00:00.000Z",
    });

    const result = await runner.runCounterfactualBranches({
      materialized,
      graph: graphFixture(),
      tenant: tenantContext(),
      now: "2026-06-24T02:00:01.000Z",
      branches: [
        { branch_id: "branch-baseline", branch_kind: "baseline" },
        { branch_id: "branch-mutation", branch_kind: "mutation_trial", mutation_trial: true },
      ],
    });

    expect(result.counterfactual_run).toEqual(expect.objectContaining({
      run_kind: "vivarium",
      base_state_hash: materialized.fixture.materialization_hash,
      branch_ids: ["branch-baseline", "branch-mutation"],
    }));
    expect(result.reset_results).toHaveLength(2);
    expect(result.reset_results.every((reset) => reset.ok && reset.materialization_hash === materialized.fixture.materialization_hash)).toBe(true);
    expect(result.branch_traces.map((trace) => trace.base_state_hash)).toEqual([
      materialized.fixture.materialization_hash,
      materialized.fixture.materialization_hash,
    ]);
    expect(result.mutation_trials).toEqual([
      expect.objectContaining({
        branch_id: "branch-mutation",
        quarantine: true,
        auto_apply_allowed: false,
      }),
    ]);
  });

  it("keeps failed proof and oracle outcomes blocked even when mutation novelty is present", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "fake_success_mutation",
        risk_tags: ["fake_success", "evidence_required", "mutation"],
      })),
      seed: "regret-vivarium-fake-success-seed",
    });

    const result = await runner.runCounterfactualBranches({
      materialized,
      graph: graphFixture(),
      branches: [{ branch_id: "branch-mutation", branch_kind: "mutation_trial", mutation_trial: true }],
    });

    expect(result.scenario_runs[0]).toEqual(expect.objectContaining({
      status: "failed",
      expectation_met: true,
    }));
    expect(result.branch_traces[0]).toEqual(expect.objectContaining({
      branch_kind: "mutation_trial",
      status: "failed",
    }));
    expect(result.mutation_trials[0]).toEqual(expect.objectContaining({
      proof_passed: false,
      quarantine: true,
      auto_apply_allowed: false,
    }));
    expect(result.mutation_trials[0]?.novelty_score).toBeGreaterThan(0);
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
    graph_id: "graph-vivarium-regret",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-24T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("action", "Action", "Synthetic action"),
    ],
    edges: [{
      edge_id: "edge_trigger_action",
      from_node_id: "trigger",
      to_node_id: "action",
      confidence: 1,
      observed_variants: [],
    }],
  };
}

function safeNode(nodeId: string, kind: DojoSkillGraph["nodes"][number]["kind"], label: string): DojoSkillGraph["nodes"][number] {
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
