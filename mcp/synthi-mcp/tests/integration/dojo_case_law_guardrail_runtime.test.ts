import { describe, expect, it } from "vitest";
import {
  bindCaseLawGuardrailsToGraph,
  synthesizeDojoGuardrailFromCase,
} from "../../src/dojo/case_law/guardrail_synthesizer.js";
import { createDojoCaseLawFromFailure, InMemoryDojoCaseLawRegistry } from "../../src/dojo/case_law/registry.js";
import { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo case-law guardrail runtime binding", () => {
  it("does not synthesize guardrails for proposed case law", () => {
    expect(synthesizeDojoGuardrailFromCase(caseFixture("proposed"))).toBeNull();
  });

  it("synthesizes a stable identity guardrail from approved duplicate-display case law", () => {
    const binding = synthesizeDojoGuardrailFromCase(caseFixture("approved"));
    expect(binding).toEqual(expect.objectContaining({
      case_id: expect.stringMatching(/^case_/),
      guardrail: expect.objectContaining({
        predicate: "stable_entity_identity == true",
        severity: "block",
      }),
      blocked_actions: ["run_workflow"],
    }));
  });

  it("binds approved case-law guardrails onto graph actions and blocks runtime execution", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const graph = bindCaseLawGuardrailsToGraph(graphFixture(), [caseFixture("approved")]);

    expect(graph.nodes[0]?.guardrails).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: "stable_entity_identity == true" }),
    ]));
    expect(graph.nodes[0]?.case_law_refs).toEqual(expect.arrayContaining([expect.stringMatching(/^case_/)]));

    await expect(runtime.execute({
      graph,
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        proof_capsule_valid: true,
        stable_entity_identity: false,
        assertion_results: { assert_submission_state: true },
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: [expect.stringMatching(/^guardrail_failed:case_guard_case_/)],
    }));
  });
});

function caseFixture(status: "proposed" | "approved") {
  const registry = new InMemoryDojoCaseLawRegistry();
  const record = registry.propose(createDojoCaseLawFromFailure({
    source_skill_id: "skill-a",
    source_run_id: "run-a",
    scenario_id: "scenario-a",
    mutation_kind: "duplicate_entity",
    finding: "Duplicate display name caused unsafe selection.",
    impact: "Wrong record may be mutated.",
    rule_created: "Require stable ID before mutation.",
    applies_to: ["run_workflow"],
    binding_scope: { kind: "workspace", id: "workspace-a" },
    evidence_refs: ["evidence:oracle-a"],
    now: "2026-06-11T00:00:00.000Z",
  }));
  if (status === "approved") {
    return registry.approve(record.case_id, { reviewer: "reviewer-a", now: "2026-06-11T01:00:00.000Z" });
  }
  return record;
}

function graphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-a",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "production",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        node_id: "action_submit",
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
      },
    ],
    edges: [],
  };
}
