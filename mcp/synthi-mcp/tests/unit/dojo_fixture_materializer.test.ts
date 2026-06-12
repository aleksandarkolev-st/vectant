import { describe, expect, it } from "vitest";
import { materializeDojoSyntheticFixture } from "../../src/dojo/vivarium/fixture_materializer.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo synthetic fixture materializer", () => {
  it("creates duplicate entity fixtures with same display name and different stable IDs", () => {
    const fixture = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_entity",
      risk_tags: ["ambiguous_entity_match"],
    })), { seed: "duplicate-seed" });

    expect(fixture.synthetic_data_only).toBe(true);
    expect(fixture.records).toHaveLength(2);
    expect(fixture.records[0]?.display_name).toBe(fixture.records[1]?.display_name);
    expect(fixture.records[0]?.stable_id).not.toBe(fixture.records[1]?.stable_id);
    expect(fixture.materialization_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects production data references", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "baseline" }));
    definition.fixture_requirements[0] = {
      ...definition.fixture_requirements[0]!,
      production_data_refs: ["prod://customer/123"],
    };

    expect(() => materializeDojoSyntheticFixture(definition)).toThrow(/dojo_scenario_definition_invalid|dojo_fixture_production_data_ref_forbidden/);
  });

  it("materializes stale entity, missing field, and threshold breach fixture states", () => {
    const stale = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "stale_entity",
      risk_tags: ["stale_data"],
    })));
    expect(stale.records.some((record) => record.stale)).toBe(true);

    const missing = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "input_omission",
      risk_tags: ["input_validation"],
      layer: "knowledge",
    }), {
      input_overrides: { client_name: "" },
    }));
    expect(missing.missing_fields).toEqual(["client_name"]);

    const threshold = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "threshold_breach",
      risk_tags: ["policy_threshold"],
    })));
    expect(threshold.threshold_breaches).toEqual([{ field: "amount", value: 501, threshold: 500 }]);
  });

  it("materializes prompt injection document fixtures as quarantined synthetic tissue", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "prompt_injection",
      risk_tags: ["prompt_injection", "untrusted_document"],
    }));
    const fixture = materializeDojoSyntheticFixture(definition, { seed: "prompt-seed" });
    const second = materializeDojoSyntheticFixture(definition, { seed: "prompt-seed" });

    expect(fixture.synthetic_data_only).toBe(true);
    expect(fixture.document_state.prompt_injection_present).toBe(true);
    expect(fixture.document_state.instruction_quarantined).toBe(true);
    expect(fixture.document_state.documents.some((document) => document.prompt_injection_present)).toBe(true);
    expect(fixture.document_state.documents.every((document) => document.file_name.startsWith("synthetic_"))).toBe(true);
    expect(definition.fixture_requirements.some((fixtureRequirement) => fixtureRequirement.kind === "fake_documents")).toBe(true);
    expect(definition.mutation_scopes).toContain("document");
    expect(definition.oracle.observed_evidence_required).toContain("document_instruction_quarantine");
    expect(second).toEqual(fixture);
  });

  it("materializes unquarantined prompt injection document fixtures as failed synthetic tissue", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "prompt_injection_unquarantined",
      risk_tags: ["prompt_injection", "untrusted_document"],
    }));
    const fixture = materializeDojoSyntheticFixture(definition, { seed: "prompt-unquarantined-seed" });
    const promptDocument = fixture.document_state.documents.find((document) => document.prompt_injection_present);

    expect(fixture.synthetic_data_only).toBe(true);
    expect(fixture.document_state.prompt_injection_present).toBe(true);
    expect(fixture.document_state.instruction_quarantined).toBe(false);
    expect(promptDocument).toEqual(expect.objectContaining({
      prompt_injection_present: true,
      instruction_quarantined: false,
    }));
    expect(definition.fixture_requirements.some((fixtureRequirement) => fixtureRequirement.kind === "fake_documents")).toBe(true);
    expect(definition.mutation_scopes).toContain("document");
    expect(definition.oracle.observed_evidence_required).toContain("document_instruction_quarantine");
  });

  it("materializes missing and corrupted document tissue states", () => {
    const missingDocumentField = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "missing_document_field",
      risk_tags: ["document_validation"],
    })));
    expect(missingDocumentField.document_state.missing_fields).toEqual(["amount"]);

    const corruptedDocument = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "corrupted_document",
      risk_tags: ["document_validation"],
    })));
    expect(corruptedDocument.document_state.corrupted_document_count).toBe(1);
    expect(corruptedDocument.document_state.documents[0]?.corrupted).toBe(true);
  });

  it("is deterministic for the same scenario and seed", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_entity",
      risk_tags: ["ambiguous_entity_match"],
    }));
    const first = materializeDojoSyntheticFixture(definition, { seed: "stable-seed" });
    const second = materializeDojoSyntheticFixture(definition, { seed: "stable-seed" });

    expect(second).toEqual(first);
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
