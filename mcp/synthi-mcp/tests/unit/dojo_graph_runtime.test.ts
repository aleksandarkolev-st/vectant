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
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
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
      inputs: { client_id_verified: true, assertion_results: { assert_submission_state: true } },
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
      inputs: { workspace_verified: true, client_id_verified: true, assertion_results: { assert_submission_state: true } },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_missing"],
    }));
  });

  it("blocks production proof-required actions when proof validation fails", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: () => ({ ok: false, blocked_by: ["proof_capsule_signature_invalid"] }),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_signature_invalid"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          blocked_by: ["proof_capsule_signature_invalid"],
        }),
      ]),
    }));
  });

  it("blocks production proof-required actions without a validator", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_validator_missing"],
    }));
  });

  it("blocks an explicitly expired node before proof or substrate execution", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      expiry_state: { expired_node_ids: ["action_submit"] },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["node_expired:action_submit"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          blocked_by: ["node_expired:action_submit"],
        }),
      ]),
    }));
  });

  it("blocks a node when one of its expiry triggers is active", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      expiry_state: { expired_triggers: ["source_drift"] },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["expiry_trigger_active:source_drift"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          blocked_by: ["expiry_trigger_active:source_drift"],
        }),
      ]),
    }));
  });

  it("selects a matching branch path and skips unchosen branch-only nodes", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: branchGraphFixture(),
      mode: "practice",
      inputs: { duplicate_display_name_count: 2 },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "branch_duplicate_client",
          status: "completed",
          control_flow: expect.objectContaining({
            selected_edge_id: "edge_branch_duplicate",
            selected_to_node_id: "action_duplicate",
          }),
        }),
        expect.objectContaining({
          node_id: "action_unique",
          status: "skipped",
          control_flow: expect.objectContaining({
            skipped_by: ["branch_not_selected:branch_duplicate_client"],
          }),
        }),
        expect.objectContaining({ node_id: "action_duplicate", status: "completed" }),
        expect.objectContaining({ node_id: "assertion", status: "completed" }),
      ]),
    }));
  });

  it("selects a default branch path when no conditional edge matches", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: branchGraphFixture({ includeDefault: true }),
      mode: "practice",
      inputs: { duplicate_display_name_count: 0 },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "branch_duplicate_client",
          status: "completed",
          control_flow: expect.objectContaining({
            selected_edge_id: "edge_branch_default",
            selected_to_node_id: "action_unique",
          }),
        }),
        expect.objectContaining({ node_id: "action_unique", status: "completed" }),
        expect.objectContaining({ node_id: "action_duplicate", status: "skipped" }),
      ]),
    }));
  });

  it("blocks a branch node when no outgoing edge condition matches", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: branchGraphFixture(),
      mode: "practice",
      inputs: { duplicate_display_name_count: 0 },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["branch_condition_unmatched"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "branch_duplicate_client",
          status: "blocked",
          blocked_by: ["branch_condition_unmatched"],
        }),
      ]),
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
      inputs: { workspace_verified: true },
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

const validProofValidator = () => ({ ok: true, blocked_by: [] });

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

function branchGraphFixture(input: { includeDefault?: boolean } = {}): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-branch",
    skill_id: "skill-branch",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "practice",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("branch_duplicate_client", "Branch", "Choose duplicate client path"),
      safeNode("action_unique", "Action", "Proceed with selected client"),
      safeNode("action_duplicate", "Action", "Ask for stable client ID"),
      safeNode("assertion", "Assertion", "Verify branch outcome"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_branch",
        from_node_id: "trigger",
        to_node_id: "branch_duplicate_client",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: input.includeDefault ? "edge_branch_default" : "edge_branch_unique",
        from_node_id: "branch_duplicate_client",
        to_node_id: "action_unique",
        ...(input.includeDefault ? {} : { condition: "duplicate_display_name_count == 1" }),
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_branch_duplicate",
        from_node_id: "branch_duplicate_client",
        to_node_id: "action_duplicate",
        condition: "duplicate_display_name_count == 2",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_unique_assertion",
        from_node_id: "action_unique",
        to_node_id: "assertion",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_duplicate_assertion",
        from_node_id: "action_duplicate",
        to_node_id: "assertion",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
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
    evidence_policy: [],
    case_law_refs: [],
    expiry_triggers: [],
  };
}
