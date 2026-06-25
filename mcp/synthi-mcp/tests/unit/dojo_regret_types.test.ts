import { describe, expect, it } from "vitest";
import { InMemoryRegretMemoryStore } from "../../src/dojo/regret/store.js";
import type { BranchTrace, ChoiceScene, CounterfactualRun, PolicyDelta } from "../../src/dojo/regret/types.js";

describe("Dojo regret memory types and store", () => {
  it("stores counterfactual runs and branch traces by evidence reference, not raw proof blobs", () => {
    const store = new InMemoryRegretMemoryStore();
    const run: CounterfactualRun = {
      schema_version: "synthi.dojo.regret.counterfactualRun.v1",
      counterfactual_run_id: "cfr-1",
      run_kind: "graph_execution",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      task_class: "invoice_submit",
      base_state_hash: "sha256:base",
      branch_ids: ["branch-api"],
      evidence_ids: ["ledger://run/start"],
      created_at: "2026-06-24T00:00:00.000Z",
      retention_policy: "ephemeral_trace",
    };
    const trace: BranchTrace = {
      schema_version: "synthi.dojo.regret.branchTrace.v1",
      branch_id: "branch-api",
      counterfactual_run_id: "cfr-1",
      branch_kind: "source_api_substrate",
      status: "passed",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      task_class: "invoice_submit",
      base_state_hash: "sha256:base",
      blocked_by: [],
      detector_evidence_ids: ["ledger://detector/api"],
      oracle_evidence_ids: ["ledger://oracle/rollback"],
      selection_evidence_ids: [],
      evidence_ids: ["ledger://detector/api", "ledger://oracle/rollback"],
      summary: "API branch passed happy path and rollback oracle.",
      created_at: "2026-06-24T00:00:01.000Z",
      retention_policy: "ephemeral_trace",
    };

    expect(store.putCounterfactualRun(run)).toEqual(run);
    expect(store.putBranchTrace(trace)).toEqual(trace);
    expect(store.getCounterfactualRun("cfr-1")).toEqual(run);
    expect(store.listBranchTraces("cfr-1")).toEqual([trace]);
    expect(JSON.stringify(trace)).not.toContain("proof_blob");
  });

  it("represents generated-but-unshown branches only as none exposure in choice scenes", () => {
    const scene: ChoiceScene = {
      schema_version: "synthi.dojo.regret.choiceScene.v1",
      choice_scene_id: "scene-1",
      counterfactual_run_id: "cfr-1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      task_class: "invoice_submit",
      base_state_hash: "sha256:base",
      available_branch_ids: ["branch-dom", "branch-api"],
      visible_branch_ids: ["branch-dom"],
      opened_branch_ids: ["branch-dom"],
      compared_branch_ids: [],
      selected_branch_id: "branch-dom",
      cancelled: false,
      ambiguity_flags: [],
      evidence_ids: ["ledger://choice/scene"],
      created_at: "2026-06-24T00:00:02.000Z",
    };

    expect(scene.available_branch_ids).toContain("branch-api");
    expect(scene.visible_branch_ids).not.toContain("branch-api");
    expect(scene.opened_branch_ids).not.toContain("branch-api");
  });

  it("returns promoted planning hints while ignoring disabled and expired deltas", () => {
    const store = new InMemoryRegretMemoryStore();
    const base: PolicyDelta = {
      schema_version: "synthi.dojo.regret.policyDelta.v1",
      policy_delta_id: "delta-api",
      delta_kind: "prefer_substrate",
      status: "promoted",
      confidence: "high",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      task_class: "invoice_submit",
      base_state_hash: "sha256:base",
      rationale: "Repeated rollback evidence supports API branch planning.",
      source_counterfactual_run_id: "cfr-1",
      source_branch_id: "branch-api",
      source_choice_scene_id: "scene-1",
      evidence_ids: ["ledger://choice/scene", "ledger://oracle/rollback"],
      created_at: "2026-06-24T00:00:03.000Z",
    };
    store.putPolicyDelta(base);
    store.putPolicyDelta({ ...base, policy_delta_id: "delta-disabled", status: "disabled" });
    store.putPolicyDelta({ ...base, policy_delta_id: "delta-expired", expires_at: "2026-06-23T00:00:00.000Z" });

    expect(store.listPlanningHints({
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      task_class: "invoice_submit",
      now: "2026-06-24T00:00:00.000Z",
    })).toEqual([{
      skillId: "skill-a",
      taskClass: "invoice_submit",
      hintKind: "prefer_substrate",
      confidence: "high",
      evidenceIds: ["ledger://choice/scene", "ledger://oracle/rollback"],
    }]);
  });
});
