import { describe, expect, it } from "vitest";
import {
  DOJO_SCENARIO_BASE_BUDGET_MS,
  DOJO_SCENARIO_TIER_BUDGET_MS,
  scenarioBudgetMsForTier,
  toDojoScenarioDefinition,
  toDojoScenarioDefinitions,
  validateDojoScenarioDefinition,
} from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo scenario DSL", () => {
  it("validates duplicate entity scenario definitions with deterministic fixtures", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_entity",
      risk_tags: ["ambiguous_entity_match"],
    }), {
      target_graph_node_ids: ["action", "assertion"],
      input_overrides: { client_name: "Duplicate synthetic record" },
    });

    expect(definition).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.scenarioDefinition.v1",
      mutation_kind: "duplicate_entity",
      mutation_scopes: ["data", "ui"],
      target_graph_node_ids: ["action", "assertion"],
      reset_profile: expect.objectContaining({
        strategy: "deterministic_seed",
        seed: "seed-a_scenario_duplicate_entity",
      }),
    }));
    expect(definition.fixture_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "fake_database_state", synthetic_data_only: true, production_data_refs: [] }),
      expect.objectContaining({ kind: "synthetic_dom_snapshot", synthetic_data_only: true, production_data_refs: [] }),
    ]));
    expect(validateDojoScenarioDefinition(definition)).toEqual({ ok: true, issues: [] });
  });

  it("validates fake success scenario definitions with evidence oracle requirements", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "fake_success",
      risk_tags: ["fake_success", "evidence_required"],
      layer: "risk",
    }));

    expect(definition.oracle).toEqual(expect.objectContaining({
      kind: "evidence_claim",
      expected_outcome: "fail",
      observed_evidence_required: expect.arrayContaining(["durable_state_evidence"]),
    }));
    expect(definition.fixture_requirements.map((fixture) => fixture.kind)).toEqual(expect.arrayContaining([
      "synthetic_dom_snapshot",
      "fake_api_server",
      "fake_database_state",
    ]));
    expect(validateDojoScenarioDefinition(definition).ok).toBe(true);
  });

  it("classifies ambiguous document-name scenarios as synthetic document tissue", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "ambiguous_document_name",
      risk_tags: ["document_validation"],
    }));

    expect(definition.mutation_scopes).toEqual(["document", "ui"]);
    expect(definition.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_documents",
      "synthetic_dom_snapshot",
    ]);
    expect(definition.oracle.observed_evidence_required).toContain("document_tissue_state");
    expect(validateDojoScenarioDefinition(definition).ok).toBe(true);
  });

  it("uses a tiered wall-clock budget that is stable under parallel integration load", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "fake_success",
      simulator_tier: 2,
      risk_tags: ["fake_success", "evidence_required"],
    }));

    expect(definition.budget).toEqual(expect.objectContaining({
      max_runs: 1,
      max_estimated_ms: DOJO_SCENARIO_BASE_BUDGET_MS + 2 * DOJO_SCENARIO_TIER_BUDGET_MS,
      max_model_calls: 0,
    }));
    expect(scenarioBudgetMsForTier(-1)).toBe(DOJO_SCENARIO_BASE_BUDGET_MS);
    expect(scenarioBudgetMsForTier(2.9)).toBe(DOJO_SCENARIO_BASE_BUDGET_MS + 2 * DOJO_SCENARIO_TIER_BUDGET_MS);
  });

  it("rejects invalid scenarios without oracle or synthetic fixtures", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "baseline" }));
    const invalid = {
      ...definition,
      oracle: undefined as unknown as typeof definition.oracle,
      fixture_requirements: [],
    };

    expect(validateDojoScenarioDefinition(invalid)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "scenario_oracle_required" }),
        expect.objectContaining({ issue_id: "scenario_fixture_required" }),
      ]),
    }));
  });

  it("converts current generated scenario shape to DSL-compatible definitions", () => {
    const definitions = toDojoScenarioDefinitions([
      scenarioFixture({ mutation_kind: "baseline", layer: "skill", risk_tags: ["baseline"] }),
      scenarioFixture({ mutation_kind: "auth_expiry", layer: "risk", risk_tags: ["auth_expired"] }),
    ]);

    expect(definitions).toHaveLength(2);
    expect(definitions.every((definition) => validateDojoScenarioDefinition(definition).ok)).toBe(true);
    expect(definitions[1]).toEqual(expect.objectContaining({
      mutation_kind: "auth_expiry",
      mutation_scopes: ["identity", "policy"],
      oracle: expect.objectContaining({ expected_outcome: "block" }),
    }));
  });
});

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
