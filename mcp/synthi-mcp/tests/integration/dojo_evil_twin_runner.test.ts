import { describe, expect, it } from "vitest";
import {
  runDojoEvilTwin,
  extractDojoEvilTwinAssumptions,
  hardenDojoEvilTwinAttacks,
} from "../../src/dojo/vivarium/evil_twin.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo Evil Twin runtime", () => {
  it("measures attack success from observed Vivarium outcomes", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "duplicate_entity", risk_tags: ["ambiguous_entity_match"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "fake_success", risk_tags: ["fake_success", "evidence_required"] })),
    ];

    const report = await runDojoEvilTwin({
      graph: graphFixture(),
      scenarios,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(extractDojoEvilTwinAssumptions(graphFixture(), scenarios)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "entity_uniqueness", attack_mutation_kind: "duplicate_entity" }),
      expect.objectContaining({ kind: "stable_success_signal", attack_mutation_kind: "fake_success" }),
    ]));
    expect(report).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.evilTwinRuntimeReport.v1",
      attack_count: 2,
      attack_success_rate: 1,
      hardened_by: expect.arrayContaining([
        "require_stable_entity_identity_guardrail",
        "require_durable_state_assertion",
      ]),
    }));
    expect(report.attacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mutation_kind: "duplicate_entity",
        status: "escaped",
        attack_succeeded: true,
        blocked_by: ["oracle_stable_entity_identity_missing"],
      }),
      expect.objectContaining({
        mutation_kind: "fake_success",
        status: "escaped",
        attack_succeeded: true,
        blocked_by: ["oracle_durable_state_evidence_missing"],
      }),
    ]));
  });

  it("classifies auth-expiry attacks as caught when the graph blocks on auth preconditions", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "auth_expiry", risk_tags: ["auth_expired"] })),
    ];

    const report = await runDojoEvilTwin({
      graph: graphFixture({ requireAuth: true }),
      scenarios,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      attack_count: 1,
      attack_success_rate: 0,
    }));
    expect(report.attacks[0]).toEqual(expect.objectContaining({
      mutation_kind: "auth_expiry",
      status: "caught",
      attack_succeeded: false,
      blocked_by: ["precondition_failed:auth_valid == true"],
    }));
  });

  it("reruns attacks after guardrail hardening and reduces attack success rate", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "duplicate_entity", risk_tags: ["ambiguous_entity_match"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "fake_success", risk_tags: ["fake_success", "evidence_required"] })),
    ];

    const hardening = await hardenDojoEvilTwinAttacks({
      graph: graphFixture(),
      scenarios,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(hardening).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.evilTwinHardeningReport.v1",
      before: expect.objectContaining({ attack_success_rate: 1 }),
      after: expect.objectContaining({ attack_success_rate: 0 }),
      applied_guardrails: expect.arrayContaining([
        expect.objectContaining({
          guardrail_id: "guard_stable_entity_identity",
          predicate: "duplicate_display_name_count <= 1",
        }),
        expect.objectContaining({
          guardrail_id: "guard_no_fake_success",
          predicate: "fake_success == false",
        }),
      ]),
    }));
    expect(hardening.after.attacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mutation_kind: "duplicate_entity",
        status: "caught",
        blocked_by: ["guardrail_failed:guard_stable_entity_identity"],
      }),
      expect.objectContaining({
        mutation_kind: "fake_success",
        status: "caught",
        blocked_by: ["guardrail_failed:guard_no_fake_success"],
      }),
    ]));
  });
});

function graphFixture(input: { requireAuth?: boolean } = {}): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: input.requireAuth ? "graph-evil-auth" : "graph-evil",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        node_id: "action",
        kind: "Action",
        label: "Synthetic action",
        risk: "safe",
        preconditions: input.requireAuth ? ["auth_valid == true"] : [],
        postconditions: [],
        guardrails: [],
        assertions: [],
        substrate_options: ["dom"],
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: [],
      },
    ],
    edges: [],
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
