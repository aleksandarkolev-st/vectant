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

  it("extracts expanded attack assumptions for stale identity, stable order, policy, and document trust", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "stale_entity", risk_tags: ["stale_data"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "network_latency", risk_tags: ["latency"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "permission_change", risk_tags: ["permission_change"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "reordered_rows", risk_tags: ["unstable_order"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "invalid_value", risk_tags: ["currency_mismatch", "invalid_value"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "ambiguous_document_name", risk_tags: ["ambiguous_file"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "prompt_injection", risk_tags: ["prompt_injection", "untrusted_document"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "approval_unavailable", risk_tags: ["approval_unavailable"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "destructive_adjacency", risk_tags: ["destructive_write"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "button_hidden_menu", risk_tags: ["ui_tissue"] })),
    ];
    const assumptions = extractDojoEvilTwinAssumptions(richGraphFixture(), scenarios);

    expect(assumptions.map((assumption) => assumption.kind)).toEqual(expect.arrayContaining([
      "entity_freshness",
      "api_latency",
      "role_permission",
      "stable_table_order",
      "currency_validity",
      "file_identity",
      "document_trust",
      "approval_availability",
      "destructive_adjacency",
      "input_visibility",
    ]));
    expect(assumptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "stable_table_order",
        attack_mutation_kind: "reordered_rows",
        node_ids: expect.arrayContaining(["observe", "locate", "action", "assertion"]),
        evidence: expect.arrayContaining([
          expect.stringContaining("table order can change"),
        ]),
      }),
      expect.objectContaining({
        kind: "document_trust",
        attack_mutation_kind: "prompt_injection",
        node_ids: expect.arrayContaining(["artifact", "action", "assertion"]),
        evidence: expect.arrayContaining([
          expect.stringContaining("document text can contain untrusted task instructions"),
        ]),
      }),
      expect.objectContaining({
        kind: "approval_availability",
        attack_mutation_kind: "approval_unavailable",
        node_ids: expect.arrayContaining(["permission", "human", "action"]),
      }),
    ]));
  });

  it("runs expanded attack assumptions through Vivarium scenario outcomes", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "stale_entity", risk_tags: ["stale_data"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "reordered_rows", risk_tags: ["unstable_order"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "prompt_injection_unquarantined", risk_tags: ["prompt_injection", "untrusted_document"] })),
      toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "approval_unavailable", risk_tags: ["approval_unavailable"] })),
    ];

    const report = await runDojoEvilTwin({
      graph: richGraphFixture(),
      scenarios,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report.attack_count).toBe(scenarios.length);
    expect(report.assumptions.map((assumption) => assumption.kind)).toEqual(expect.arrayContaining([
      "entity_freshness",
      "stable_table_order",
      "document_trust",
      "approval_availability",
    ]));
    expect(report.attacks.map((attack) => attack.mutation_kind)).toEqual(expect.arrayContaining([
      "stale_entity",
      "reordered_rows",
      "prompt_injection_unquarantined",
      "approval_unavailable",
    ]));
    expect(report.attacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mutation_kind: "prompt_injection_unquarantined",
        assumption_kind: "document_trust",
        attack_succeeded: true,
      }),
      expect.objectContaining({
        mutation_kind: "approval_unavailable",
        assumption_kind: "approval_availability",
        blocked_by: expect.arrayContaining([expect.any(String)]),
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

  it("passes substrate executor hooks through targeted attack runs", async () => {
    const scenarios = [
      toDojoScenarioDefinition(scenarioFixture({
        mutation_kind: "fake_success",
        risk_tags: ["fake_success", "evidence_required"],
      })),
    ];

    const report = await runDojoEvilTwin({
      graph: apiGraphFixture(),
      scenarios,
      base_inputs: {
        license_allowed_substrates: ["api"],
      },
      substrate_executor: {
        execute: async () => ({
          ok: true,
          status: "executed",
          substrate: "api",
          blocked_by: [],
          evidence_refs: ["api-evidence:evil-twin"],
          api_tool_execution: {
            ok: true,
            status: "executed",
            blocked_by: [],
            validation: { ok: true, blocked_by: [] },
            response: {
              status: 200,
              body: {
                visual_success: true,
                durable_success: false,
              },
            },
            evidence_record_id: "api-evidence:evil-twin",
          },
        }),
      },
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      attack_count: 1,
      attack_success_rate: 0,
    }));
    expect(report.attacks[0]).toEqual(expect.objectContaining({
      mutation_kind: "fake_success",
      status: "caught",
      attack_succeeded: false,
      blocked_by: ["assertion_failed:api_response.body.durable_success", "rollback_human_review_required"],
      scenario_run: expect.objectContaining({
        graph_result: expect.objectContaining({
          node_results: [
            expect.objectContaining({
              substrate_result: expect.objectContaining({
                ok: true,
                substrate: "api",
                evidence_refs: ["api-evidence:evil-twin"],
                api_tool_execution: expect.objectContaining({
                  response: expect.objectContaining({
                    body: expect.objectContaining({ durable_success: false }),
                  }),
                }),
              }),
              assertion_results: [
                expect.objectContaining({
                  assertion_id: "api_response.body.durable_success",
                  status: "failed",
                  observed: false,
                }),
              ],
            }),
          ],
        }),
      }),
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

function richGraphFixture(): DojoSkillGraph {
  const baseNode = {
    risk: "safe" as const,
    preconditions: [],
    postconditions: [],
    guardrails: [],
    assertions: [],
    substrate_options: ["dom"],
    evidence_policy: ["append_action_trace"],
    case_law_refs: [],
    expiry_triggers: [],
  };
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-evil-rich",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      { ...baseNode, node_id: "input", kind: "Input", label: "Synthetic input" },
      { ...baseNode, node_id: "observe", kind: "Observe", label: "Observe synthetic state" },
      { ...baseNode, node_id: "locate", kind: "Locate", label: "Locate target" },
      { ...baseNode, node_id: "permission", kind: "Permission", label: "Check permission" },
      { ...baseNode, node_id: "human", kind: "Human", label: "Human approval" },
      { ...baseNode, node_id: "artifact", kind: "Artifact", label: "Document artifact" },
      { ...baseNode, node_id: "action", kind: "Action", label: "Synthetic action" },
      { ...baseNode, node_id: "assertion", kind: "Assertion", label: "Synthetic assertion" },
    ],
    edges: [],
  };
}

function apiGraphFixture(): DojoSkillGraph {
  const base = graphFixture();
  return {
    ...base,
    nodes: [
      {
        ...base.nodes[0]!,
        assertions: [
          {
            assertion_id: "api_response.body.durable_success",
            description: "API response confirms durable success.",
            required: true,
          },
        ],
        substrate_options: ["api"],
        metadata: {
          rollback_policy: {
            strategy: "human_checkpoint",
            checkpoints: ["pre_mutation_confirmation"],
          },
        },
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
