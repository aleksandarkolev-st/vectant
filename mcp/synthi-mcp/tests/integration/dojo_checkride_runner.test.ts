import { describe, expect, it } from "vitest";
import { runDojoExecutableCheckride } from "../../src/dojo/checkride/runner.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo executable checkride runner", () => {
  it("uses runtime and oracle evidence so happy path alone is not enough when risk scenario fails", async () => {
    const baseline = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "baseline",
      layer: "skill",
      risk_tags: ["baseline"],
    }));
    const duplicate = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_entity",
      layer: "risk",
      risk_tags: ["ambiguous_entity_match"],
    }));

    const report = await runDojoExecutableCheckride({
      graph: graphFixture(),
      scenarios: [baseline, duplicate],
      base_inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      observed_evidence_by_scenario: {
        [baseline.scenario_id]: ["graph_run_result", "oracle_result"],
        [duplicate.scenario_id]: ["graph_run_result"],
      },
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.executableCheckrideReport.v1",
      scenario_count: 2,
      passed_scenarios: 1,
      failed_scenarios: 1,
      critical_failures: 1,
      production_recommendation: "blocked",
    }));
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario_id: baseline.scenario_id, status: "passed", graph_status: "completed" }),
      expect.objectContaining({
        scenario_id: duplicate.scenario_id,
        status: "failed",
        blocked_by: ["oracle_stable_entity_identity_missing"],
      }),
    ]));
    expect(report.license_constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenario_id: duplicate.scenario_id,
        constraint_kind: "requires_guardrail",
      }),
    ]));
  });

  it("records blocked risk scenarios as license constraints with evidence records", async () => {
    const authExpiry = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "auth_expiry",
      layer: "risk",
      risk_tags: ["auth_expired"],
    }));

    const report = await runDojoExecutableCheckride({
      graph: graphFixture(),
      scenarios: [authExpiry],
      base_inputs: {
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      observed_evidence_by_scenario: {
        [authExpiry.scenario_id]: ["identity_policy_state"],
      },
      evidence_context: {
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        skill_id: "skill-a",
        created_at: "2026-06-11T00:00:00.000Z",
        created_by: "checkride-test",
        run_id_prefix: "run",
      },
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      blocked_scenarios: 1,
      failed_scenarios: 0,
      critical_failures: 0,
      production_recommendation: "constrained",
    }));
    expect(report.license_constraints).toEqual([
      expect.objectContaining({
        scenario_id: authExpiry.scenario_id,
        mutation_kind: "auth_expiry",
        constraint_kind: "ask_before",
      }),
    ]);
    expect(report.results[0]?.evidence_record).toEqual(expect.objectContaining({
      kind: "scenario",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      claim_ids: expect.arrayContaining(["scenario_oracle:blocked", "scenario_expectation:met"]),
    }));
    expect(report.evidence_refs[0]).toContain("evidence:evidence_oracle_");
  });

  it("treats unquarantined prompt injection document scenarios as critical guardrail failures", async () => {
    const promptInjection = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "prompt_injection_unquarantined",
      layer: "risk",
      risk_tags: ["prompt_injection", "untrusted_document"],
    }));

    const report = await runDojoExecutableCheckride({
      graph: graphFixture(),
      scenarios: [promptInjection],
      base_inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      observed_evidence_by_scenario: {
        [promptInjection.scenario_id]: ["graph_run_result", "document_instruction_quarantine"],
      },
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      scenario_count: 1,
      passed_scenarios: 0,
      failed_scenarios: 1,
      critical_failures: 1,
      production_recommendation: "blocked",
    }));
    expect(report.results).toEqual([
      expect.objectContaining({
        scenario_id: promptInjection.scenario_id,
        mutation_kind: "prompt_injection_unquarantined",
        status: "failed",
        blocked_by: ["oracle_document_instruction_not_quarantined"],
      }),
    ]);
    expect(report.license_constraints).toEqual([
      expect.objectContaining({
        scenario_id: promptInjection.scenario_id,
        mutation_kind: "prompt_injection_unquarantined",
        constraint_kind: "requires_guardrail",
      }),
    ]);
  });
});

function graphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-a",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        node_id: "action",
        kind: "Action",
        label: "Submit invoice",
        risk: "dangerous",
        action: "run_workflow",
        preconditions: ["workspace_verified == true"],
        postconditions: ["submission_state == success"],
        guardrails: [
          {
            guardrail_id: "guard_client_stable_id",
            predicate: "client_id_verified == true",
            severity: "block",
          },
        ],
        proof: {
          required: true,
          required_claims: ["checkride_passed", "workspace_verified"],
          required_guardrails: ["guard_client_stable_id"],
        },
        assertions: [
          {
            assertion_id: "assert_submission_state",
            description: "Submission state is success.",
            required: true,
          },
        ],
        substrate_options: ["dom"],
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: [],
        metadata: {
          rollback_policy: {
            strategy: "human_checkpoint",
            checkpoints: ["pre_mutation_confirmation"],
          },
        },
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
