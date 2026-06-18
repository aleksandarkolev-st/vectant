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
    expect(threshold.policy_state.thresholds).toEqual([
      expect.objectContaining({
        field: "amount",
        operator: "<=",
        limit: 500,
        observed_value: 501,
        action: "submit_synthetic_action",
      }),
    ]);
    expect(threshold.policy_state.blocked_actions).toEqual([
      expect.objectContaining({
        action: "submit_synthetic_action",
        reason: "amount_threshold_exceeded",
        severity: "review",
        source: "threshold",
      }),
    ]);
    expect(threshold.policy_state.approval_required).toBe(true);
  });

  it("materializes invalid data values without production data", () => {
    const invalid = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "invalid_value",
      risk_tags: ["input_validation", "invalid_value"],
    }), {
      input_overrides: { amount: -1 },
    }), { seed: "invalid-value-seed" });
    const generatedInvalid = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "invalid_value",
      risk_tags: ["input_validation", "invalid_value"],
    })), { seed: "invalid-generated-seed" });
    const secondGeneratedInvalid = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "invalid_value",
      risk_tags: ["input_validation", "invalid_value"],
    })), { seed: "invalid-generated-seed" });

    expect(invalid.synthetic_data_only).toBe(true);
    expect(invalid.invalid_values).toEqual([
      {
        field: "amount",
        value: -1,
        expected_type: "number",
        reason: "scenario_input_override_invalid",
      },
    ]);
    expect(invalid.records[0]?.fields).toEqual(expect.objectContaining({ amount: -1 }));
    expect(invalid.ui_state.validation_messages).toEqual([
      expect.objectContaining({ field: "amount", message: "Synthetic validation requires amount" }),
    ]);
    expect(generatedInvalid.invalid_values).toEqual([
      expect.objectContaining({ field: "amount", value: -1, expected_type: "number", reason: "below_minimum" }),
      expect.objectContaining({
        field: "currency",
        value: expect.stringMatching(/^SYNTHETIC_INVALID_CURRENCY_[a-f0-9]{6}$/),
        expected_type: "currency",
        reason: "unsupported_currency",
      }),
    ]);
    expect(generatedInvalid.materialization_hash).toBe(secondGeneratedInvalid.materialization_hash);
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

  it("materializes role downgrade permission change identity tissue as a blocked synthetic state", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "permission_change",
      risk_tags: ["permission_change"],
    }));
    const fixture = materializeDojoSyntheticFixture(definition, { seed: "permission-change-seed" });

    expect(fixture.synthetic_data_only).toBe(true);
    expect(fixture.identity_state).toEqual(expect.objectContaining({
      role: "viewer",
      auth_expired: false,
      permission_downgraded: true,
      missing_permissions: [],
      workspace_changed: false,
      approver_unavailable: false,
    }));
    expect(fixture.identity_state.current_workspace_id).toBe(fixture.identity_state.expected_workspace_id);
    expect(definition.fixture_requirements.map((requirement) => requirement.kind)).toEqual([
      "fake_auth_session",
      "fake_approvals",
    ]);
    expect(definition.mutation_scopes).toEqual(["identity", "policy"]);
    expect(definition.oracle.expected_outcome).toBe("block");
    expect(definition.oracle.observed_evidence_required).toContain("identity_policy_state");
  });

  it("materializes expanded identity tissue for auth expiry, missing permissions, and workspace changes", () => {
    const expiredAuth = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "auth_expiry",
      risk_tags: ["auth_expired"],
    })), { seed: "identity-auth-expiry-seed" });
    expect(expiredAuth.identity_state).toEqual(expect.objectContaining({
      auth_expired: true,
      role: "editor",
      missing_permissions: [],
      workspace_changed: false,
    }));

    const missingPermission = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "missing_permission",
      risk_tags: ["missing_permission"],
    })), { seed: "identity-permission-seed" });
    expect(missingPermission.identity_state.missing_permissions).toHaveLength(1);
    expect(missingPermission.identity_state.missing_permissions[0]).toMatch(/^synthetic_permission_[a-f0-9]{12}$/);
    expect(missingPermission.policy_state.blocked_actions).toEqual([
      expect.objectContaining({
        action: "submit_synthetic_action",
        reason: "required_permission_missing",
        source: "permission",
      }),
    ]);

    const workspaceChange = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "workspace_change",
      risk_tags: ["workspace_changed"],
    })), { seed: "identity-workspace-seed" });
    expect(workspaceChange.identity_state.workspace_changed).toBe(true);
    expect(workspaceChange.identity_state.current_workspace_id).not.toBe(workspaceChange.identity_state.expected_workspace_id);
    expect(workspaceChange.identity_state.current_workspace_id).toMatch(/^synthetic_workspace_[a-f0-9]{12}$/);
    expect(workspaceChange.policy_state.blocked_actions).toEqual([
      expect.objectContaining({
        action: "submit_synthetic_action",
        reason: "workspace_context_changed",
        source: "permission",
      }),
    ]);
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

  it("materializes ambiguous document names with distinct synthetic document IDs", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "ambiguous_document_name",
      risk_tags: ["document_validation"],
    }));
    const fixture = materializeDojoSyntheticFixture(definition, { seed: "ambiguous-document-seed" });
    const second = materializeDojoSyntheticFixture(definition, { seed: "ambiguous-document-seed" });
    const fileNames = new Set(fixture.document_state.documents.map((document) => document.file_name));
    const documentIds = new Set(fixture.document_state.documents.map((document) => document.document_id));

    expect(fixture.synthetic_data_only).toBe(true);
    expect(fixture.document_state.documents).toHaveLength(2);
    expect(fileNames.size).toBe(1);
    expect(documentIds.size).toBe(2);
    expect(fixture.document_state.ambiguous_file_name_groups).toEqual([
      {
        file_name: fixture.document_state.documents[0]?.file_name,
        document_ids: [...documentIds].sort(),
      },
    ]);
    expect(definition.fixture_requirements.some((fixtureRequirement) => fixtureRequirement.kind === "fake_documents")).toBe(true);
    expect(definition.oracle.observed_evidence_required).toContain("document_tissue_state");
    expect(second).toEqual(fixture);
  });

  it("materializes UI tissue mutations for layout, labels, validation, and destructive adjacency", () => {
    const labelChange = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "label_change",
      risk_tags: ["locator_drift"],
    })), { seed: "ui-label-seed" });
    expect(labelChange.ui_state.label_changed).toBe(true);
    expect(labelChange.ui_state.labels).toContain("Synthetic changed label");

    const duplicateLabel = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_label",
      risk_tags: ["ambiguous_locator"],
    })), { seed: "ui-duplicate-seed" });
    expect(duplicateLabel.ui_state.duplicate_labels).toEqual(["Synthetic action", "Synthetic action"]);
    expect(duplicateLabel.ui_state.controls.filter((control) => control.label === "Synthetic action")).toHaveLength(2);

    const hiddenRequired = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "hidden_required_field",
      risk_tags: ["input_validation"],
    })), { seed: "ui-hidden-field-seed" });
    expect(hiddenRequired.ui_state.hidden_fields).toEqual(["synthetic_required_field"]);
    expect(hiddenRequired.ui_state.validation_messages).toEqual([
      expect.objectContaining({
        field: "synthetic_required_field",
        location: "below_fold",
        visible: true,
      }),
    ]);
    expect(hiddenRequired.ui_state.layout_mutations).toContain("validation_below_fold");

    const validationBelowFold = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "validation_below_fold",
      risk_tags: ["input_validation"],
    })), { seed: "ui-validation-below-fold-seed" });
    expect(validationBelowFold.missing_fields).toEqual(["synthetic_required_field"]);
    expect(validationBelowFold.ui_state.validation_messages).toEqual([
      expect.objectContaining({
        field: "synthetic_required_field",
        location: "below_fold",
        visible: true,
      }),
    ]);
    expect(validationBelowFold.ui_state.layout_mutations).toContain("validation_below_fold");

    const reorderedRows = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "reordered_rows",
      risk_tags: ["table_order"],
    })), { seed: "ui-table-seed" });
    expect(reorderedRows.ui_state.table_order).toEqual(reorderedRows.records.map((record) => record.stable_id).reverse());
    expect(reorderedRows.ui_state.layout_mutations).toContain("table_rows_reordered");

    const destructiveAdjacency = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "destructive_adjacency",
      risk_tags: ["destructive_write"],
    })), { seed: "ui-destructive-seed" });
    expect(destructiveAdjacency.ui_state.destructive_adjacency).toBe(true);
    expect(destructiveAdjacency.ui_state.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        destructive: true,
        location: "adjacent",
        visible: true,
      }),
    ]));
    expect(destructiveAdjacency.policy_state.blocked_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "delete_synthetic_record",
        reason: "destructive_action_adjacent_to_safe_action",
        severity: "block",
        source: "destructive_adjacency",
      }),
    ]));
  });

  it("materializes policy approval blockers without production policy data", () => {
    const approvalUnavailable = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "approval_unavailable",
      risk_tags: ["approval_unavailable"],
    })), { seed: "policy-approval-seed" });

    expect(approvalUnavailable.synthetic_data_only).toBe(true);
    expect(approvalUnavailable.identity_state.approver_unavailable).toBe(true);
    expect(approvalUnavailable.policy_state.unavailable_approver).toBe(true);
    expect(approvalUnavailable.policy_state.approval_required).toBe(true);
    expect(approvalUnavailable.policy_state.blocked_actions).toEqual([
      expect.objectContaining({
        action: "submit_synthetic_action",
        reason: "required_approver_unavailable",
        severity: "block",
        source: "approval",
      }),
    ]);
    expect(approvalUnavailable.materialization_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("materializes adaptive UI tissue for menu-hidden controls, mobile viewport, motion, hydration, feature flags, and modal interruption", () => {
    const buttonMoved = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "button_moved",
      risk_tags: ["locator_drift"],
    })), { seed: "ui-button-moved-seed" });
    expect(buttonMoved.ui_state.layout_mutations).toContain("control_position_changed");
    expect(buttonMoved.ui_state.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: "menu",
        moved: true,
      }),
    ]));

    const hiddenMenu = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "button_hidden_menu",
      risk_tags: ["ui_variant"],
    })), { seed: "ui-menu-seed" });
    expect(hiddenMenu.ui_state.layout_mutations).toContain("control_hidden_in_menu");
    expect(hiddenMenu.ui_state.menu_hidden_controls).toHaveLength(1);

    const mobile = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "viewport_mobile",
      risk_tags: ["viewport_variant"],
    })), { seed: "ui-mobile-seed" });
    expect(mobile.ui_state.viewport).toBe("mobile");
    expect(mobile.ui_state.controls.some((control) => control.moved)).toBe(true);

    const reducedMotion = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "reduced_motion",
      risk_tags: ["motion_variant"],
    })), { seed: "ui-motion-seed" });
    expect(reducedMotion.ui_state.reduced_motion).toBe(true);

    const hydrationDelay = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "hydration_delay",
      risk_tags: ["hydration_delay"],
    })), { seed: "ui-hydration-seed" });
    expect(hydrationDelay.ui_state.hydration_delay_ms).toBeGreaterThan(0);
    expect(hydrationDelay.ui_state.hydration_delay_ms).toBeLessThanOrEqual(500);

    const featureFlag = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "feature_flag",
      risk_tags: ["ui_variant"],
    })), { seed: "ui-feature-seed" });
    expect(featureFlag.ui_state.feature_flags).toHaveLength(1);
    expect(featureFlag.ui_state.layout_mutations).toContain("control_hidden_in_menu");

    const modal = materializeDojoSyntheticFixture(toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "modal_appears",
      risk_tags: ["ui_variant"],
    })), { seed: "ui-modal-seed" });
    expect(modal.ui_state.modal_present).toBe(true);
    expect(modal.ui_state.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "modal",
        visible: true,
      }),
    ]));
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
