import { describe, expect, it } from "vitest";
import { type DojoSkillGraph, validateDojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo Skill Graph IR", () => {
  it("validates a minimal production graph with proof, guardrail, and assertion coverage", () => {
    expect(validateDojoSkillGraph(minimalGraph())).toEqual({ ok: true, issues: [] });
  });

  it("rejects dangerous actions without guardrails", () => {
    const graph = minimalGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.node_id === "action_submit" ? { ...node, guardrails: [] } : node
    );

    expect(validateDojoSkillGraph(graph)).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          issue_id: "dangerous_action_guardrail_required",
          node_id: "action_submit",
        }),
      ],
    });
  });

  it("rejects production actions without explicit proof requirements", () => {
    const graph = minimalGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.node_id === "action_submit" ? { ...node, proof: undefined } : node
    );

    expect(validateDojoSkillGraph(graph).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "production_action_proof_required",
        node_id: "action_submit",
      }),
    ]));
  });

  it("rejects mutation actions without assertions", () => {
    const graph = minimalGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.node_id === "action_submit" ? { ...node, assertions: [] } : node
    );

    expect(validateDojoSkillGraph(graph).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "mutation_assertion_required",
        node_id: "action_submit",
      }),
    ]));
  });

  it("rejects guardrail predicates that are not executable", () => {
    const graph = minimalGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.node_id === "action_submit"
        ? {
            ...node,
            guardrails: node.guardrails.map((guardrail) => ({
              ...guardrail,
              predicate: "Require a stable client identifier before submit.",
            })),
          }
        : node
    );

    expect(validateDojoSkillGraph(graph).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "guardrail_predicate_parseable_required",
        node_id: "action_submit",
      }),
    ]));
  });

  it("rejects edges that reference missing nodes or invalid confidence", () => {
    const graph = minimalGraph();
    graph.edges.push({
      edge_id: "edge_bad",
      from_node_id: "missing",
      to_node_id: "action_submit",
      confidence: 1.5,
      observed_variants: [],
    });

    expect(validateDojoSkillGraph(graph).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_id: "edge_from_node_missing", edge_id: "edge_bad" }),
      expect.objectContaining({ issue_id: "edge_confidence_invalid", edge_id: "edge_bad" }),
    ]));
  });
});

function minimalGraph(): DojoSkillGraph {
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
        node_id: "trigger",
        kind: "Trigger",
        label: "Skill invocation",
        risk: "safe",
        preconditions: [],
        postconditions: [],
        guardrails: [],
        assertions: [],
        substrate_options: [],
        evidence_policy: [],
        case_law_refs: [],
        expiry_triggers: [],
      },
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
        substrate_options: ["dom", "mcp"],
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: ["source_drift"],
      },
    ],
    edges: [
      {
        edge_id: "edge_trigger_action",
        from_node_id: "trigger",
        to_node_id: "action_submit",
        confidence: 0.98,
        observed_variants: [],
      },
    ],
  };
}
