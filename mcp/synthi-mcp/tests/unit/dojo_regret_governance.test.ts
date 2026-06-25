import { describe, expect, it } from "vitest";
import {
  deleteWorkspaceRegretMemory,
  disableRegretPolicyDelta,
  inspectRegretPolicyDeltas,
  promoteRegretPolicyDelta,
} from "../../src/dojo/regret/service.js";
import { InMemoryRegretMemoryStore } from "../../src/dojo/regret/store.js";
import type { PolicyDelta } from "../../src/dojo/regret/types.js";

describe("Dojo regret governance controls", () => {
  it("allows authorized reviewers to inspect, promote, disable, and delete regret memory", async () => {
    const store = new InMemoryRegretMemoryStore();
    store.putPolicyDelta(policyDelta());

    await expect(inspectRegretPolicyDeltas({
      store,
      workspace_id: "workspace-a",
      tenant_context: tenantContext(["dojo:regret:view"]),
      require_rbac: true,
    })).resolves.toEqual(expect.objectContaining({
      policy_deltas: [expect.objectContaining({ policy_delta_id: "delta-a" })],
      rbac_authorization: expect.objectContaining({ ok: true }),
    }));

    await expect(promoteRegretPolicyDelta({
      store,
      policy_delta_id: "delta-a",
      promoted_at: "2026-06-24T04:00:00.000Z",
      promoted_by: "reviewer-a",
      evidence_ids: ["ledger://review/promotion"],
      tenant_context: tenantContext(["dojo:regret:review"]),
      require_rbac: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "applied",
      policy_delta: expect.objectContaining({
        status: "promoted",
        evidence_ids: ["ledger://branch/a", "ledger://choice/a", "ledger://review/promotion"],
      }),
    }));

    await expect(disableRegretPolicyDelta({
      store,
      policy_delta_id: "delta-a",
      disabled_at: "2026-06-24T04:10:00.000Z",
      disabled_by: "reviewer-a",
      tenant_context: tenantContext(["dojo:regret:review"]),
      require_rbac: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      policy_delta: expect.objectContaining({ status: "disabled" }),
    }));

    await expect(deleteWorkspaceRegretMemory({
      store,
      workspace_id: "workspace-a",
      deleted_at: "2026-06-24T04:20:00.000Z",
      deleted_by: "admin-a",
      tenant_context: tenantContext(["dojo:regret:delete"]),
      require_rbac: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      deleted_count: 1,
    }));
  });

  it("rejects regret controls without required governance role", async () => {
    const store = new InMemoryRegretMemoryStore();
    store.putPolicyDelta(policyDelta());

    await expect(promoteRegretPolicyDelta({
      store,
      policy_delta_id: "delta-a",
      promoted_at: "2026-06-24T04:00:00.000Z",
      promoted_by: "reviewer-a",
      evidence_ids: ["ledger://review/promotion"],
      tenant_context: tenantContext(["dojo:registry:view"]),
      require_rbac: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "rejected",
      blocked_by: ["governance_role_required:dojo:regret:review|dojo:governance:view"],
    }));
  });
});

function policyDelta(): PolicyDelta {
  return {
    schema_version: "synthi.dojo.regret.policyDelta.v1",
    policy_delta_id: "delta-a",
    delta_kind: "prefer_substrate",
    status: "hypothesis",
    confidence: "medium",
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    task_class: "invoice_submit",
    base_state_hash: "sha256:base",
    rationale: "API-backed branch needs rollback proof before promotion.",
    source_counterfactual_run_id: "cfr-a",
    source_branch_id: "branch-a",
    source_choice_scene_id: "choice-a",
    evidence_ids: ["ledger://branch/a", "ledger://choice/a"],
    created_at: "2026-06-24T04:00:00.000Z",
  };
}

function tenantContext(roles: string[]) {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "reviewer-a",
    actor_type: "human" as const,
    roles,
    request_id: "regret-governance-test",
    correlation_id: "regret-governance-test-correlation",
  };
}
