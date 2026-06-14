import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import type { DojoPostgresQueryable } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoGovernanceStore } from "../../src/dojo/store/postgres_governance_store.js";
import type { DojoPermissionUpgradeRequestRecord } from "../../src/dojo/store/interfaces.js";

describe("PostgresDojoGovernanceStore RBAC enforcement", () => {
  it("rejects reviewed permission-upgrade records before SQL when RBAC context is missing", async () => {
    const queryable = fakeQueryable();
    const store = new PostgresDojoGovernanceStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
      require_rbac: true,
    });

    await expect(store.savePermissionUpgradeRequest(permissionUpgradeRequestFixture({
      status: "approved",
      reviewed_by: { actor_id: "reviewer-a", actor_type: "human" },
      reviewed_at: "2026-06-11T00:05:00.000Z",
      decision_evidence_refs: ["evidence:review"],
    }))).rejects.toThrow(
      "dojo_postgres_governance_permission_upgrade_reviewer_role_required:governance_tenant_context_required"
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("rejects reviewed case-law records before SQL when the actor lacks the review role", async () => {
    const queryable = fakeQueryable();
    const store = new PostgresDojoGovernanceStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
      require_rbac: true,
      tenant_context: tenantContextFixture({ actorId: "case-reviewer-a", roles: ["dojo:viewer"] }),
    });

    await expect(store.saveCaseLawRecord(caseLawRecordFixture({
      status: "approved",
      reviewer: "case-reviewer-a",
      updated_at: "2026-06-11T00:10:00.000Z",
    }))).rejects.toThrow(
      "dojo_postgres_governance_case_law_reviewer_role_required:governance_role_required:dojo:case-law:review"
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("rejects reviewed records before SQL when the review actor differs from tenant context", async () => {
    const queryable = fakeQueryable();
    const store = new PostgresDojoGovernanceStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
      require_rbac: true,
      tenant_context: tenantContextFixture({ actorId: "reviewer-a", roles: ["dojo:approval:review"] }),
    });

    await expect(store.savePermissionUpgradeRequest(permissionUpgradeRequestFixture({
      status: "denied",
      reviewed_by: { actor_id: "reviewer-b", actor_type: "human" },
      reviewed_at: "2026-06-11T00:06:00.000Z",
      decision_evidence_refs: ["evidence:denial"],
    }))).rejects.toThrow("dojo_postgres_governance_permission_upgrade_review_actor_mismatch");
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("allows reviewed governance records when RBAC context has the required role", async () => {
    const queryable = fakeQueryable();
    const permissionStore = new PostgresDojoGovernanceStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
      require_rbac: true,
      tenant_context: tenantContextFixture({ actorId: "reviewer-a", roles: ["dojo:approval:review"] }),
    });

    await permissionStore.savePermissionUpgradeRequest(permissionUpgradeRequestFixture({
      status: "approved",
      reviewed_by: { actor_id: "reviewer-a", actor_type: "human" },
      reviewed_at: "2026-06-11T00:05:00.000Z",
      decision_evidence_refs: ["evidence:review"],
    }));

    const caseLawStore = new PostgresDojoGovernanceStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
      require_rbac: true,
      tenant_context: tenantContextFixture({ actorId: "case-reviewer-a", roles: ["dojo:case-law:review"] }),
    });
    await caseLawStore.saveCaseLawRecord(caseLawRecordFixture({
      status: "approved",
      reviewer: "case-reviewer-a",
      updated_at: "2026-06-11T00:10:00.000Z",
    }));

    expect(queryable.query).toHaveBeenCalledTimes(2);
  });
});

function fakeQueryable(): DojoPostgresQueryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => ({
      command: "INSERT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [],
    } satisfies QueryResult<QueryResultRow>)),
  };
}

function permissionUpgradeRequestFixture(
  overrides: Partial<DojoPermissionUpgradeRequestRecord> = {}
): DojoPermissionUpgradeRequestRecord {
  return {
    schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
    request_id: "approval-request-a",
    skill_id: "skill-a",
    workflow_id: "workflow-a",
    workspace_id: "workspace-a",
    license_id: "license-a",
    license_version: "1.0.0",
    requested_action: "submit_invoice",
    current_entrustment_level: "E2",
    required_steps: ["review_checkride_evidence"],
    status: "pending",
    evidence_refs: ["evidence:request"],
    requested_at: "2026-06-11T00:00:00.000Z",
    requested_by: { actor_id: "agent-a", actor_type: "agent" },
    request_context: {
      request_id: "request-a",
      correlation_id: "correlation-a",
    },
    ...overrides,
  };
}

function caseLawRecordFixture(overrides: Partial<DojoCaseLawRecord> = {}): DojoCaseLawRecord {
  return {
    schema_version: "synthi.dojo.caseLaw.v1",
    case_id: "case-a",
    title: "Duplicate client",
    finding: "Display name alone does not identify a client.",
    impact: "The wrong client record can be mutated.",
    rule_created: "client_id_verified == true",
    applies_to: ["submit_invoice"],
    binding_scope: { kind: "workspace", id: "workspace-a" },
    status: "proposed",
    evidence_refs: ["evidence:case"],
    appeal_status: "none",
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function tenantContextFixture(input: {
  actorId: string;
  roles: string[];
}): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: input.actorId,
    actor_type: "human",
    roles: input.roles,
    request_id: "request-rbac",
    correlation_id: "correlation-rbac",
  };
}
