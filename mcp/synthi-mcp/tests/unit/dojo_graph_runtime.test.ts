import { describe, expect, it } from "vitest";
import { DojoSkillGraphRuntime, evaluateStaticCondition } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo graph runtime skeleton", () => {
  it("executes a valid production graph when proof and preconditions are satisfied", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        proof_capsule_valid: true,
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
      node_results: expect.arrayContaining([
        expect.objectContaining({ node_id: "trigger", status: "completed" }),
        expect.objectContaining({ node_id: "action_submit", status: "completed" }),
      ]),
      blocked_by: [],
    }));
  });

  it("blocks a node when static preconditions fail", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: { proof_capsule_valid: true, client_id_verified: true },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["precondition_failed:workspace_verified == true"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          blocked_by: ["precondition_failed:workspace_verified == true"],
        }),
      ]),
    }));
  });

  it("blocks production proof-required actions without proof", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: { workspace_verified: true, client_id_verified: true },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_missing"],
    }));
  });

  it("blocks execution when graph validation fails", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const invalid = graphFixture();
    invalid.nodes = invalid.nodes.map((node) =>
      node.node_id === "action_submit" ? { ...node, guardrails: [] } : node
    );

    await expect(runtime.execute({
      graph: invalid,
      inputs: { workspace_verified: true, proof_capsule_valid: true },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      node_results: [],
      blocked_by: ["dangerous_action_guardrail_required"],
    }));
  });

  it("evaluates simple equality preconditions", () => {
    expect(evaluateStaticCondition("workspace_verified == true", { workspace_verified: true })).toBe(true);
    expect(evaluateStaticCondition("amount == 50", { amount: 50 })).toBe(true);
    expect(evaluateStaticCondition("currency == EUR", { currency: "EUR" })).toBe(true);
    expect(evaluateStaticCondition("currency == \"EUR\"", { currency: "EUR" })).toBe(true);
    expect(evaluateStaticCondition("workspace_verified == true", { workspace_verified: false })).toBe(false);
    expect(evaluateStaticCondition("unsupported > 1", { unsupported: 2 })).toBe(false);
  });
});

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
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}
