import { describe, expect, it } from "vitest";
import {
  DojoSkillGraphRuntime,
  evaluateStaticCondition,
  type DojoGraphEvidenceEvent,
} from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo graph runtime skeleton", () => {
  it("executes a valid production graph when proof and preconditions are satisfied", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["dom"],
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

  it("executes nodes in graph edge order rather than node array order", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const graph = graphFixture();
    graph.nodes = [...graph.nodes].reverse();

    const result = await runtime.execute({
      graph,
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["dom"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
    }));
    expect(result.node_results.map((nodeResult) => nodeResult.node_id)).toEqual(["trigger", "action_submit"]);
  });

  it("emits graph run evidence events with stable run and node refs", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const events: DojoGraphEvidenceEvent[] = [];

    await expect(runtime.execute({
      graph: graphFixture(),
      run_id: "graph-run-1",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["dom"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      evidence_writer: (event) => {
        events.push(event);
        return `ledger://${event.run_id}/${event.node_id}`;
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      run_id: "graph-run-1",
      evidence_refs: [
        "ledger://graph-run-1/trigger",
        "ledger://graph-run-1/action_submit",
      ],
    }));
    expect(events).toEqual([
      expect.objectContaining({
        schema_version: "synthi.dojo.graphEvidenceEvent.v1",
        run_id: "graph-run-1",
        graph_id: "graph-a",
        skill_id: "skill-a",
        node_id: "trigger",
        status: "completed",
      }),
      expect.objectContaining({
        run_id: "graph-run-1",
        node_id: "action_submit",
        status: "completed",
        guardrail_ids: ["guard_client_stable_id"],
        proof_required: true,
        proof_claims: ["checkride_passed", "workspace_verified"],
        case_law_refs: [],
        substrate_status: "executed",
        substrate: "dom",
        substrate_evidence_refs: ["substrate:dom:action_submit"],
        assertion_ids: ["assert_submission_state"],
        evidence_policy: ["append_action_trace"],
      }),
    ]);
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

  it("blocks explicit production proof nodes before action execution", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const validatedNodeIds: string[] = [];

    const result = await runtime.execute({
      graph: proofNodeGraphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: ({ node }) => {
        validatedNodeIds.push(node.node_id);
        return { ok: false, blocked_by: ["proof_capsule_revoked"] };
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_revoked"],
    }));
    expect(result.node_results.map((nodeResult) => nodeResult.node_id)).toEqual(["trigger", "proof_gate"]);
    expect(result.node_results[1]).toEqual(expect.objectContaining({
      node_id: "proof_gate",
      kind: "Proof",
      status: "blocked",
      blocked_by: ["proof_capsule_revoked"],
    }));
    expect(validatedNodeIds).toEqual(["proof_gate"]);
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

  it("allows a retry node while attempts are below the configured limit", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: retryGraphFixture(),
      mode: "practice",
      inputs: { retry_attempts: { submit_invoice: 1 } },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
      node_results: expect.arrayContaining([
        expect.objectContaining({ node_id: "retry_submit", status: "completed" }),
      ]),
    }));
  });

  it("blocks a retry node once the configured attempt limit is reached", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: retryGraphFixture(),
      mode: "practice",
      inputs: { retry_attempts: { submit_invoice: 2 } },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["retry_limit_exceeded:submit_invoice"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "retry_submit",
          status: "blocked",
          blocked_by: ["retry_limit_exceeded:submit_invoice"],
        }),
      ]),
    }));
  });

  it("blocks retry nodes that do not declare a retry policy", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const graph = retryGraphFixture();
    graph.nodes = graph.nodes.map((node) =>
      node.node_id === "retry_submit" ? { ...node, metadata: undefined } : node
    );

    await expect(runtime.execute({
      graph,
      mode: "practice",
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["retry_policy_missing"],
    }));
  });

  it("pauses at a human node and returns resume state when approval is missing", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: humanGraphFixture(),
      mode: "practice",
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "paused",
      blocked_by: ["human_decision_required:supervisor_approval"],
      resume_state: {
        paused_node_id: "human_approval",
        decision_key: "supervisor_approval",
        completed_node_ids: ["trigger"],
      },
      node_results: expect.arrayContaining([
        expect.objectContaining({ node_id: "trigger", status: "completed" }),
        expect.objectContaining({
          node_id: "human_approval",
          status: "paused",
          blocked_by: ["human_decision_required:supervisor_approval"],
        }),
      ]),
    }));
  });

  it("resumes after human approval without rerunning completed nodes", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: humanGraphFixture(),
      mode: "practice",
      resume_state: {
        paused_node_id: "human_approval",
        decision_key: "supervisor_approval",
        completed_node_ids: ["trigger"],
      },
      human_decisions: { supervisor_approval: "approved" },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "completed",
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "trigger",
          status: "skipped",
          control_flow: expect.objectContaining({ skipped_by: ["resume_already_completed"] }),
        }),
        expect.objectContaining({ node_id: "human_approval", status: "completed" }),
        expect.objectContaining({ node_id: "action_after_approval", status: "completed" }),
      ]),
    }));
  });

  it("blocks when a human decision is denied", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: humanGraphFixture(),
      mode: "practice",
      human_decisions: { supervisor_approval: "denied" },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["human_decision_denied:supervisor_approval"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "human_approval",
          status: "blocked",
          blocked_by: ["human_decision_denied:supervisor_approval"],
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
    expect(evaluateStaticCondition("amount <= 500", { amount: 50 })).toBe(true);
    expect(evaluateStaticCondition("approval_status != denied", { approval_status: "pending" })).toBe(true);
    expect(evaluateStaticCondition("currency == EUR", { currency: "EUR" })).toBe(true);
    expect(evaluateStaticCondition("currency == \"EUR\"", { currency: "EUR" })).toBe(true);
    expect(evaluateStaticCondition("currency in [\"EUR\",\"USD\"]", { currency: "EUR" })).toBe(true);
    expect(evaluateStaticCondition("workspace_verified", { workspace_verified: true })).toBe(true);
    expect(evaluateStaticCondition("workspace_verified == true", { workspace_verified: false })).toBe(false);
    expect(evaluateStaticCondition("amount <= 500", { amount: 501 })).toBe(false);
    expect(evaluateStaticCondition("unsupported >== 1", { unsupported: 2 })).toBe(false);
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

function proofNodeGraphFixture(): DojoSkillGraph {
  const graph = graphFixture();
  const trigger = graph.nodes.find((node) => node.node_id === "trigger")!;
  const action = graph.nodes.find((node) => node.node_id === "action_submit")!;
  return {
    ...graph,
    graph_id: "graph-proof-node",
    nodes: [
      trigger,
      {
        node_id: "proof_gate",
        kind: "Proof",
        label: "Validate proof capsule",
        risk: "safe",
        preconditions: [],
        postconditions: [],
        guardrails: [],
        proof: {
          required: true,
          required_claims: ["checkride_passed", "workspace_verified"],
          required_guardrails: ["guard_client_stable_id"],
        },
        assertions: [],
        substrate_options: [],
        evidence_policy: ["proof_validation_recorded"],
        case_law_refs: [],
        expiry_triggers: [],
      },
      action,
    ],
    edges: [
      {
        edge_id: "edge_trigger_proof",
        from_node_id: "trigger",
        to_node_id: "proof_gate",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_proof_action",
        from_node_id: "proof_gate",
        to_node_id: "action_submit",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function humanGraphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-human",
    skill_id: "skill-human",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "practice",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      {
        ...safeNode("human_approval", "Human", "Request supervisor approval"),
        metadata: { decision_key: "supervisor_approval" },
      },
      safeNode("action_after_approval", "Action", "Submit after approval"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_human",
        from_node_id: "trigger",
        to_node_id: "human_approval",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_human_action",
        from_node_id: "human_approval",
        to_node_id: "action_after_approval",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function retryGraphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-retry",
    skill_id: "skill-retry",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "practice",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      {
        ...safeNode("retry_submit", "Retry", "Retry submit invoice"),
        metadata: { attempt_key: "submit_invoice", max_attempts: 2 },
      },
      safeNode("action_submit", "Action", "Submit invoice"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_retry",
        from_node_id: "trigger",
        to_node_id: "retry_submit",
        confidence: 1,
        observed_variants: [],
      },
      {
        edge_id: "edge_retry_action",
        from_node_id: "retry_submit",
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
