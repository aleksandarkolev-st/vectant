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

  it("classifies invalid value scenarios as data validation tissue", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "invalid_value",
      risk_tags: ["input_validation", "invalid_value"],
      layer: "risk",
    }), {
      input_overrides: { amount: -1 },
    });

    expect(definition.mutation_scopes).toEqual(["ui", "data"]);
    expect(definition.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_database_state",
      "synthetic_dom_snapshot",
      "fake_validation_errors",
    ]);
    expect(definition.oracle).toEqual(expect.objectContaining({
      kind: "expected_block",
      expected_outcome: "block",
      observed_evidence_required: expect.arrayContaining(["invalid_value_state"]),
    }));
    expect(validateDojoScenarioDefinition(definition).ok).toBe(true);
  });

  it("classifies document tissue scenarios with specific evidence requirements", () => {
    const cases = [
      ["missing_document_field", "document_missing_field_state"],
      ["corrupted_document", "document_corrupted_state"],
      ["ambiguous_document_name", "document_ambiguous_name_state"],
    ] as const;

    for (const [mutationKind, requiredEvidence] of cases) {
      const definition = toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: mutationKind,
        risk_tags: ["document_validation"],
      }));

      expect(definition.mutation_scopes).toEqual(["document", "ui"]);
      expect(definition.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
        "fake_documents",
        "synthetic_dom_snapshot",
      ]);
      expect(definition.oracle.observed_evidence_required).toEqual(expect.arrayContaining([
        "document_tissue_state",
        requiredEvidence,
      ]));
      expect(validateDojoScenarioDefinition(definition).ok).toBe(true);
    }
  });

  it("classifies UI tissue scenarios with specific evidence requirements", () => {
    const cases = [
      ["label_change", ["ui_tissue_state", "ui_label_change_state"]],
      ["duplicate_label", ["ui_tissue_state", "ui_duplicate_label_state"]],
      ["button_moved", ["ui_tissue_state", "ui_layout_mutation_state", "ui_control_moved_state"]],
      ["button_hidden_menu", ["ui_tissue_state", "ui_layout_mutation_state", "ui_control_moved_state", "ui_hidden_menu_state"]],
      ["validation_below_fold", ["ui_tissue_state", "ui_layout_mutation_state", "ui_validation_surface_state"]],
      ["reordered_rows", ["ui_tissue_state", "ui_layout_mutation_state", "ui_control_moved_state", "ui_table_reorder_state"]],
      ["destructive_adjacency", ["ui_tissue_state", "ui_layout_mutation_state", "ui_destructive_adjacency_state"]],
      ["modal_appears", ["ui_tissue_state", "ui_layout_mutation_state", "ui_modal_interruption_state"]],
    ] as const;

    for (const [mutationKind, requiredEvidence] of cases) {
      const definition = toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: mutationKind,
        risk_tags: ["ui_tissue"],
      }));

      expect(definition.mutation_scopes).toContain("ui");
      expect(definition.fixture_requirements.map((fixture) => fixture.kind)).toContain("synthetic_dom_snapshot");
      expect(definition.oracle.observed_evidence_required).toEqual(expect.arrayContaining([...requiredEvidence]));
      expect(validateDojoScenarioDefinition(definition).ok).toBe(true);
    }
  });

  it("classifies policy tissue scenarios with thresholds and unavailable approvals", () => {
    const threshold = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "threshold_breach",
      risk_tags: ["policy_threshold"],
    }));
    expect(threshold.mutation_scopes).toEqual(["policy", "data", "ui"]);
    expect(threshold.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_database_state",
      "fake_approvals",
      "synthetic_dom_snapshot",
    ]);
    expect(threshold.oracle.expected_outcome).toBe("block");
    expect(threshold.oracle.observed_evidence_required).toContain("policy_tissue_state");
    expect(validateDojoScenarioDefinition(threshold).ok).toBe(true);

    const approvalUnavailable = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "approval_unavailable",
      risk_tags: ["approval_unavailable"],
    }));
    expect(approvalUnavailable.mutation_scopes).toEqual(["policy", "ui"]);
    expect(approvalUnavailable.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_approvals",
      "synthetic_dom_snapshot",
    ]);
    expect(approvalUnavailable.oracle.expected_outcome).toBe("block");
    expect(approvalUnavailable.oracle.observed_evidence_required).toContain("policy_tissue_state");
    expect(validateDojoScenarioDefinition(approvalUnavailable).ok).toBe(true);
  });

  it("classifies expanded identity tissue scenarios for permissions and workspace context", () => {
    const missingPermission = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "missing_permission",
      risk_tags: ["missing_permission"],
    }));
    expect(missingPermission.mutation_scopes).toEqual(["identity", "policy"]);
    expect(missingPermission.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_auth_session",
      "fake_approvals",
    ]);
    expect(missingPermission.oracle.expected_outcome).toBe("block");
    expect(missingPermission.oracle.observed_evidence_required).toContain("identity_policy_state");
    expect(validateDojoScenarioDefinition(missingPermission).ok).toBe(true);

    const workspaceChange = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "workspace_change",
      risk_tags: ["workspace_changed"],
    }));
    expect(workspaceChange.mutation_scopes).toEqual(["identity", "policy"]);
    expect(workspaceChange.fixture_requirements.map((fixture) => fixture.kind)).toEqual([
      "fake_auth_session",
      "fake_approvals",
    ]);
    expect(workspaceChange.oracle.expected_outcome).toBe("block");
    expect(workspaceChange.oracle.observed_evidence_required).toContain("identity_policy_state");
    expect(validateDojoScenarioDefinition(workspaceChange).ok).toBe(true);
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
