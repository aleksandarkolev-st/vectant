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
      api_fault: expect.objectContaining({
        behavior: "fake_success",
        request_count: 1,
        response_status: 200,
        durable_state: expect.objectContaining({
          committed: false,
          fake_success: true,
          records: [],
        }),
        evidence_refs: ["dojo-api-fault://scenario-run-fake-success/fake_success"],
      }),
      observed_evidence: expect.arrayContaining(["api_fault_server_executed", "fake_success_visual_only"]),
      evidence_refs: expect.arrayContaining(["dojo-api-fault://scenario-run-fake-success/fake_success"]),
      graph_result: expect.objectContaining({
        node_results: expect.arrayContaining([
          expect.objectContaining({
            node_id: "action",
            substrate_result: expect.objectContaining({
              status: "executed",
              evidence_refs: ["dojo-api-fault://scenario-run-fake-success/fake_success"],
            }),
          }),
        ]),
      }),
      oracle_result: expect.objectContaining({
        blocked_by: ["oracle_durable_state_evidence_missing"],
        finding: "Scenario produced fake visual success without durable state evidence.",
      }),
    }));
  });

  it("executes partial-write scenarios against the API fault server and exposes durable state", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "partial_write",
      layer: "risk",
      risk_tags: ["partial_failure", "evidence_required"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "partial-write-seed",
    });

    const result = await runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-partial-write",
    });

    expect(result.api_fault).toEqual(expect.objectContaining({
      behavior: "partial_write",
      request_count: 1,
      response_status: 207,
      durable_state: expect.objectContaining({
        committed: false,
        partial: true,
        records: [expect.objectContaining({
          synthetic_record_id: expect.stringMatching(/^record_[a-f0-9]{12}_partial$/),
          write_state: "partial",
        })],
      }),
    }));
    expect(result.observed_evidence).toEqual(expect.arrayContaining([
      "api_fault_server_executed",
      "partial_write_state",
    ]));
    expect(result.evidence_refs).toEqual(expect.arrayContaining([
      "dojo-api-fault://scenario-run-partial-write/partial_write",
    ]));
    expect(result.oracle_result).toEqual(expect.objectContaining({
      status: "failed",
      blocked_by: ["oracle_partial_write_detected"],
    }));
  });

  it("does not execute API fault fixtures when graph preconditions block before the action", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "fake_success",
      layer: "risk",
      risk_tags: ["fake_success", "evidence_required"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "blocked-before-action-seed",
    });

    const result = await runner.run({
      materialized,
      graph: actionPreconditionGraphFixture(),
      run_id: "scenario-run-blocked-before-api-fault",
    });

    expect(result.api_fault).toBeUndefined();
    expect(result.evidence_refs).not.toContain("dojo-api-fault://scenario-run-blocked-before-api-fault/fake_success");
    expect(result.observed_evidence).not.toContain("api_fault_server_executed");
    expect(result.graph_result).toEqual(expect.objectContaining({
      status: "blocked",
      blocked_by: ["precondition_failed:action_ready == true"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action",
          status: "blocked",
          blocked_by: ["precondition_failed:action_ready == true"],
        }),
      ]),
    }));
    expect(result.graph_result.node_results.find((node) => node.node_id === "action")).not.toHaveProperty("substrate_result");
    expect(result.oracle_result).toEqual(expect.objectContaining({
      status: "blocked",
      blocked_by: ["precondition_failed:action_ready == true"],
    }));
  });

  it("emits policy tissue evidence when policy fixtures block scenario execution", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "threshold_breach",
      layer: "risk",
      risk_tags: ["policy_threshold"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "policy-threshold-seed",
    });

    const result = await runner.run({
      materialized,
      graph: policyGateGraphFixture(),
      run_id: "scenario-run-policy-threshold",
    });

    expect(materialized.fixture.policy_state.thresholds).toEqual([
      expect.objectContaining({
        field: "amount",
        limit: 500,
        observed_value: 501,
      }),
    ]);
    expect(materialized.fixture.policy_state.blocked_actions).toEqual([
      expect.objectContaining({
        source: "threshold",
        reason: "amount_threshold_exceeded",
      }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["policy_tissue_state"]),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["precondition_failed:policy_blocked_action_count == 0"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        expected_outcome: "block",
        observed_evidence: expect.arrayContaining(["policy_tissue_state"]),
      }),
    }));
  });

  it("emits expanded identity evidence when workspace context changes block execution", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "workspace_change",
      layer: "risk",
      risk_tags: ["workspace_changed"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "identity-workspace-runner-seed",
    });

    const result = await runner.run({
      materialized,
      graph: workspaceGateGraphFixture(),
      run_id: "scenario-run-workspace-change",
    });

    expect(materialized.fixture.identity_state.workspace_changed).toBe(true);
    expect(materialized.fixture.identity_state.current_workspace_id).not.toBe(materialized.fixture.identity_state.expected_workspace_id);
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["identity_policy_state"]),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["precondition_failed:workspace_changed == false"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        expected_outcome: "block",
        observed_evidence: expect.arrayContaining(["identity_policy_state"]),
      }),
    }));
  });

  it("emits invalid value evidence when invalid data blocks execution", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "invalid_value",
      layer: "risk",
      risk_tags: ["input_validation", "invalid_value"],
    }), {
      input_overrides: { amount: -1 },
    });
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "invalid-value-seed",
    });

    const result = await runner.run({
      materialized,
      graph: invalidValueGateGraphFixture(),
      run_id: "scenario-run-invalid-value",
    });

    expect(materialized.fixture.invalid_values).toEqual([
      expect.objectContaining({ field: "amount", value: -1, reason: "scenario_input_override_invalid" }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["invalid_value_state"]),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["precondition_failed:invalid_value_count == 0"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        expected_outcome: "block",
        observed_evidence: expect.arrayContaining(["invalid_value_state"]),
      }),
    }));
  });

  it("emits stale entity data tissue evidence when stale IDs block execution", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "stale_entity",
      layer: "risk",
      risk_tags: ["stale_data"],
    }), {
      expected_outcome_overrides: { stale_entity: "block" },
    });
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "stale-entity-runner-seed",
    });

    const result = await runner.run({
      materialized,
      graph: staleEntityGateGraphFixture(),
      run_id: "scenario-run-stale-entity",
    });

    expect(materialized.fixture.records.filter((record) => record.stale)).toHaveLength(1);
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["data_tissue_state", "stale_entity_state"]),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["precondition_failed:stale_entity_count == 0"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        expected_outcome: "block",
        observed_evidence: expect.arrayContaining(["data_tissue_state", "stale_entity_state"]),
      }),
    }));
  });

  it("emits missing field data tissue evidence when required synthetic fields block execution", async () => {
    const runner = new DojoVivariumRunner();
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "hidden_required_field",
      layer: "knowledge",
      risk_tags: ["input_validation"],
    }));
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "missing-field-runner-seed",
    });

    const result = await runner.run({
      materialized,
      graph: missingFieldGateGraphFixture(),
      run_id: "scenario-run-missing-field",
    });

    expect(materialized.fixture.missing_fields).toEqual(["synthetic_required_field"]);
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: true,
      observed_evidence: expect.arrayContaining(["data_tissue_state", "missing_field_state"]),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["precondition_failed:missing_field_count == 0"],
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        expected_outcome: "block",
        observed_evidence: expect.arrayContaining(["data_tissue_state", "missing_field_state"]),
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

  it("blocks completed scenario runs that exceed time or model-call budgets", async () => {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      seed: "budget-overrun-seed",
    });

    await expect(runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-budget-overrun",
      budget: {
        ...materialized.definition.budget,
        max_estimated_ms: 0,
        max_model_calls: 0,
      },
      model_calls_used: 1,
      now: "2026-06-11T00:00:01.000Z",
    })).resolves.toEqual(expect.objectContaining({
      status: "blocked",
      expectation_met: false,
      budget_usage: expect.objectContaining({
        elapsed_ms: 0,
        model_calls: 1,
        max_estimated_ms: 0,
        max_model_calls: 0,
      }),
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: expect.arrayContaining([
          "dojo_scenario_budget_time_exhausted",
          "dojo_scenario_budget_model_calls_exhausted",
        ]),
        evidence_refs: expect.arrayContaining(["dojo-budget://scenario-run-budget-overrun"]),
      }),
      oracle_result: expect.objectContaining({
        status: "blocked",
        blocked_by: expect.arrayContaining([
          "dojo_scenario_budget_time_exhausted",
          "dojo_scenario_budget_model_calls_exhausted",
        ]),
      }),
      observed_evidence: expect.arrayContaining(["scenario_budget_state"]),
      evidence_refs: expect.arrayContaining(["dojo-budget://scenario-run-budget-overrun"]),
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

  it("executes only targeted graph nodes and required ancestors", async () => {
    const runner = new DojoVivariumRunner();
    const definition = {
      ...toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      target_graph_node_ids: ["target_action"],
    };
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "targeted-graph-seed",
    });

    const result = await runner.run({
      materialized,
      graph: branchingGraphFixture(),
      run_id: "scenario-run-targeted-graph",
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(result.graph_result.node_results.map((node) => node.node_id)).toEqual(["trigger", "target_action"]);
    expect(result.graph_result.evidence_refs).toEqual([
      "dojo-graph://scenario-run-targeted-graph/trigger",
      "dojo-graph://scenario-run-targeted-graph/target_action",
    ]);
    expect(result.graph_result.node_results.some((node) => node.node_id === "untargeted_action")).toBe(false);
  });

  it("keeps postcondition assertion descendants when slicing targeted scenarios", async () => {
    const runner = new DojoVivariumRunner();
    const definition = {
      ...toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      target_graph_node_ids: ["target_action"],
    };
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "targeted-assertion-graph-seed",
    });

    const result = await runner.run({
      materialized,
      graph: branchingGraphWithAssertionFixture(),
      run_id: "scenario-run-targeted-assertion-graph",
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(result.graph_result.node_results.map((node) => node.node_id)).toEqual([
      "trigger",
      "target_action",
      "target_assertion",
    ]);
    expect(result.graph_result.evidence_refs).toEqual([
      "dojo-graph://scenario-run-targeted-assertion-graph/trigger",
      "dojo-graph://scenario-run-targeted-assertion-graph/target_action",
      "dojo-graph://scenario-run-targeted-assertion-graph/target_assertion",
    ]);
    expect(result.graph_result.node_results.some((node) => node.node_id === "untargeted_action")).toBe(false);
  });

  it("blocks scenarios that reference missing target graph nodes", async () => {
    const runner = new DojoVivariumRunner();
    const definition = {
      ...toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "baseline",
        layer: "skill",
        risk_tags: ["baseline"],
      })),
      target_graph_node_ids: ["missing_action"],
    };
    const materialized = runner.materialize({
      skill_id: "skill-a",
      scenario: definition,
      seed: "missing-target-seed",
    });

    await expect(runner.run({
      materialized,
      graph: graphFixture(),
      run_id: "scenario-run-missing-target",
      now: "2026-06-11T00:00:01.000Z",
    })).resolves.toEqual(expect.objectContaining({
      status: "blocked",
      graph_result: expect.objectContaining({
        status: "blocked",
        blocked_by: ["dojo_scenario_target_graph_node_missing:missing_action"],
      }),
      oracle_result: expect.objectContaining({
        blocked_by: ["dojo_scenario_target_graph_node_missing:missing_action"],
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

function branchingGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("target_action", "Action", "Targeted synthetic action"),
      safeNode("untargeted_action", "Action", "Untargeted synthetic action"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_target",
        from_node_id: "trigger",
        to_node_id: "target_action",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_trigger_untargeted",
        from_node_id: "trigger",
        to_node_id: "untargeted_action",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function branchingGraphWithAssertionFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("target_action", "Action", "Targeted synthetic action"),
      safeNode("target_assertion", "Assertion", "Verify targeted postcondition"),
      safeNode("untargeted_action", "Action", "Untargeted synthetic action"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_target",
        from_node_id: "trigger",
        to_node_id: "target_action",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_target_assertion",
        from_node_id: "target_action",
        to_node_id: "target_assertion",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_trigger_untargeted",
        from_node_id: "trigger",
        to_node_id: "untargeted_action",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function actionPreconditionGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["action_ready == true"],
        }
      : node),
  };
}

function policyGateGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["policy_blocked_action_count == 0"],
        }
      : node),
  };
}

function workspaceGateGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["workspace_changed == false"],
        }
      : node),
  };
}

function invalidValueGateGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["invalid_value_count == 0"],
        }
      : node),
  };
}

function staleEntityGateGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["stale_entity_count == 0"],
        }
      : node),
  };
}

function missingFieldGateGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture(),
    nodes: graphFixture().nodes.map((node) => node.node_id === "action"
      ? {
          ...node,
          preconditions: ["missing_field_count == 0"],
        }
      : node),
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
