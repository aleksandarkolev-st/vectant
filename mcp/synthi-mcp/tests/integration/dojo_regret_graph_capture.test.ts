import { describe, expect, it } from "vitest";
import { executeGraphWithRegretCapture } from "../../src/dojo/regret/counterfactual_run.js";
import { InMemoryRegretMemoryStore } from "../../src/dojo/regret/store.js";
import { createFakeDojoSubstrateExecutor } from "../../src/dojo/graph/substrate_executor.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo regret graph capture", () => {
  it("normalizes graph execution into counterfactual run and branch trace evidence references", async () => {
    const store = new InMemoryRegretMemoryStore();
    const result = await executeGraphWithRegretCapture({
      store,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      task_class: "invoice_submit",
      base_state_hash: "sha256:reset-profile-a",
      now: "2026-06-24T01:00:00.000Z",
      runtime_input: {
        graph: graphFixture(),
        run_id: "graph-run-regret",
        mode: "practice",
        inputs: { workspace_verified: true, assertion_results: { assert_saved: true } },
        proof_capsule: { raw_secret_proof_blob: "do-not-store" },
        substrate_executor: createFakeDojoSubstrateExecutor(),
        evidence_writer: (event) => `ledger://${event.run_id}/${event.node_id}`,
      },
    });

    expect(result.graph_result).toEqual(expect.objectContaining({ ok: true, status: "completed" }));
    expect(result.counterfactual_run).toEqual(expect.objectContaining({
      run_kind: "graph_execution",
      branch_ids: [result.branch_trace.branch_id],
      evidence_ids: [
        "dojo-graph-event://graph-run-regret/action",
        "dojo-graph-event://graph-run-regret/trigger",
        "ledger://graph-run-regret/action",
        "ledger://graph-run-regret/trigger",
      ],
    }));
    expect(result.branch_trace).toEqual(expect.objectContaining({
      status: "passed",
      graph_mode: "practice",
      evidence_ids: [
        "dojo-graph-event://graph-run-regret/action",
        "dojo-graph-event://graph-run-regret/trigger",
        "ledger://graph-run-regret/action",
        "ledger://graph-run-regret/trigger",
      ],
    }));
    expect(JSON.stringify(result.branch_trace)).not.toContain("raw_secret_proof_blob");
    expect(store.listBranchTraces(result.counterfactual_run.counterfactual_run_id)).toHaveLength(1);
  });

  it("records blocked branches as near-miss evidence without claiming selection", async () => {
    const result = await executeGraphWithRegretCapture({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      task_class: "invoice_submit",
      branch_kind: "guardrail_heavy",
      base_state_hash: "sha256:reset-profile-a",
      now: "2026-06-24T01:00:00.000Z",
      runtime_input: {
        graph: graphFixture(),
        run_id: "graph-run-blocked",
        mode: "practice",
        inputs: { workspace_verified: false },
        evidence_writer: (event) => `ledger://${event.run_id}/${event.node_id}`,
      },
    });

    expect(result.graph_result.ok).toBe(false);
    expect(result.branch_trace).toEqual(expect.objectContaining({
      branch_kind: "guardrail_heavy",
      status: "blocked",
      selection_evidence_ids: [],
      blocked_by: ["precondition_failed:workspace_verified == true"],
    }));
  });
});

function graphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-regret",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "practice",
    created_at: "2026-06-24T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      {
        ...safeNode("action", "Action", "Save invoice"),
        preconditions: ["workspace_verified == true"],
        postconditions: ["assert_saved == true"],
        substrate_options: ["dom"],
      },
    ],
    edges: [{
      edge_id: "edge_trigger_action",
      from_node_id: "trigger",
      to_node_id: "action",
      confidence: 1,
      observed_variants: [],
    }],
  };
}

function safeNode(nodeId: string, kind: DojoSkillGraph["nodes"][number]["kind"], label: string): DojoSkillGraph["nodes"][number] {
  return {
    node_id: nodeId,
    kind,
    label,
    risk: "safe",
    preconditions: [],
    postconditions: [],
    guardrails: [],
    assertions: [],
    substrate_options: [],
    evidence_policy: [],
    case_law_refs: [],
    expiry_triggers: [],
  };
}
