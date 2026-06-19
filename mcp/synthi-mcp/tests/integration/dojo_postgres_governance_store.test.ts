import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoGovernanceStore } from "../../src/dojo/store/postgres_governance_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import type {
  DojoPermissionUpgradeRequestRecord,
} from "../../src/dojo/store/interfaces.js";
import type { DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoGovernanceStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let skillId: string;
  let licenseId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_governance";
    skillId = "skill_governance";
    licenseId = "license_governance";
    await seedSkill(pool, tenantId, workspaceId, skillId);
    await seedLicense(pool, tenantId, workspaceId, skillId, licenseId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists permission-upgrade requests, filters them by governance fields, and emits audit events", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
    });
    const pending = permissionUpgradeRequest("approval_request_a", { status: "pending" });

    await store.savePermissionUpgradeRequest(pending);

    expect(await store.listPermissionUpgradeRequests({ workflow_id: pending.workflow_id })).toEqual([
      expect.objectContaining({
        request_id: "approval_request_a",
        status: "pending",
        requested_action: "submit_invoice",
      }),
    ]);
    expect(await store.listPermissionUpgradeRequests({ requested_action: "other_action" })).toEqual([]);

    const approved = permissionUpgradeRequest("approval_request_a", {
      status: "approved",
      reviewed_at: "2026-06-11T00:10:00.000Z",
      reviewed_by: { actor_id: "reviewer-a", actor_type: "human" },
      review_reason: "evidence complete",
      decision_evidence_refs: ["evidence:approval-decision"],
    });
    await store.savePermissionUpgradeRequest(approved);

    expect(await store.listPermissionUpgradeRequests({ status: "approved", limit: 1 })).toEqual([
      expect.objectContaining({
        request_id: "approval_request_a",
        status: "approved",
        reviewed_by: { actor_id: "reviewer-a", actor_type: "human" },
      }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "permission_upgrade_request" })).toEqual([
      expect.objectContaining({ event_type: "permission_upgrade_requested", entity_id: "approval_request_a" }),
      expect.objectContaining({ event_type: "approval_granted", entity_id: "approval_request_a" }),
    ]);
  });

  it("persists case law records, filters by binding scope and action, and emits audit events", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "case-law-service", actor_type: "service" },
    });
    const proposed = caseLawRecord("case_duplicate_client", { status: "proposed" });

    await store.saveCaseLawRecord(proposed);

    expect(await store.getCaseLawRecord("case_duplicate_client")).toEqual(expect.objectContaining({
      case_id: "case_duplicate_client",
      status: "proposed",
      applies_to: ["submit_invoice", "update_client"],
    }));
    expect(await store.listCaseLawRecords({
      binding_scope: { kind: "skill", id: skillId },
      applies_to: "submit_invoice",
    })).toEqual([
      expect.objectContaining({ case_id: "case_duplicate_client" }),
    ]);

    const approved = caseLawRecord("case_duplicate_client", {
      status: "approved",
      reviewer: "reviewer-a",
      updated_at: "2026-06-11T00:15:00.000Z",
    });
    await store.saveCaseLawRecord(approved);

    expect(await store.listCaseLawRecords({ status: "approved" })).toEqual([
      expect.objectContaining({
        case_id: "case_duplicate_client",
        reviewer: "reviewer-a",
      }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "case_law" })).toEqual([
      expect.objectContaining({ event_type: "case_law_proposed", entity_id: "case_duplicate_client" }),
      expect.objectContaining({ event_type: "case_law_approved", entity_id: "case_duplicate_client" }),
    ]);
  });

  it("enforces tenant and workspace boundaries for governance records", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkill(pool, otherTenantId, workspaceId, skillId);
    await seedLicense(pool, otherTenantId, workspaceId, skillId, licenseId);
    const tenantStore = new PostgresDojoGovernanceStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoGovernanceStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    await tenantStore.savePermissionUpgradeRequest(permissionUpgradeRequest("approval_isolated", { status: "pending" }));
    await tenantStore.saveCaseLawRecord(caseLawRecord("case_isolated", { status: "proposed" }));

    expect(await tenantStore.listPermissionUpgradeRequests({ request_id: "approval_isolated" })).toHaveLength(1);
    expect(await otherStore.listPermissionUpgradeRequests({ request_id: "approval_isolated" })).toEqual([]);
    expect(await tenantStore.getCaseLawRecord("case_isolated")).toEqual(expect.objectContaining({ case_id: "case_isolated" }));
    expect(await otherStore.getCaseLawRecord("case_isolated")).toBeNull();

    await expect(tenantStore.savePermissionUpgradeRequest({
      ...permissionUpgradeRequest("approval_wrong_workspace", { status: "pending" }),
      workspace_id: "workspace_other",
    })).rejects.toThrow("dojo_postgres_governance_workspace_mismatch");
  });

  function permissionUpgradeRequest(
    requestId: string,
    overrides: Partial<DojoPermissionUpgradeRequestRecord>
  ): DojoPermissionUpgradeRequestRecord {
    return {
      schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
      request_id: requestId,
      skill_id: skillId,
      workflow_id: `workflow_${skillId}`,
      workspace_id: workspaceId,
      license_id: licenseId,
      license_version: "license_v1",
      requested_action: "submit_invoice",
      current_entrustment_level: "E2",
      required_steps: ["review_duplicate_client_evidence"],
      status: "pending",
      evidence_refs: ["evidence:approval-request"],
      requested_at: "2026-06-11T00:00:00.000Z",
      requested_by: { actor_id: "agent-a", actor_type: "agent" },
      request_context: {
        request_id: "request-a",
        correlation_id: "correlation-a",
      },
      ...overrides,
    };
  }

  function caseLawRecord(caseId: string, overrides: Partial<DojoCaseLawRecord>): DojoCaseLawRecord {
    return {
      schema_version: "synthi.dojo.caseLaw.v1",
      case_id: caseId,
      title: "Duplicate Client",
      finding: "Display names are not stable identifiers.",
      impact: "The skill can update the wrong client record.",
      rule_created: "client_id_verified == true",
      applies_to: ["submit_invoice", "update_client"],
      binding_scope: { kind: "skill", id: skillId },
      status: "proposed",
      evidence_refs: ["evidence:case-law"],
      appeal_status: "none",
      created_at: "2026-06-11T00:00:00.000Z",
      updated_at: "2026-06-11T00:00:00.000Z",
      ...overrides,
    };
  }
});

async function seedSkill(pool: Pool, tenantId: string, workspaceId: string, skillId: string): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_tenants (tenant_id, organization_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, "org_a", tenantId]
  );
  await pool.query(
    `INSERT INTO dojo_workspaces (tenant_id, workspace_id, organization_id, app_origin)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
    [tenantId, workspaceId, "org_a", "https://app.example.test"]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
    [tenantId, workspaceId, skillId, `workflow_${skillId}`, "Governance Test Skill", "skill_v1", JSON.stringify({ skill_id: skillId })]
  );
}

async function seedLicense(
  pool: Pool,
  tenantId: string,
  workspaceId: string,
  skillId: string,
  licenseId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_licenses (
      tenant_id,
      workspace_id,
      license_id,
      skill_id,
      license_version,
      status,
      entrustment_level,
      readiness_level,
      license_json
    ) VALUES ($1, $2, $3, $4, $5, 'active', 'E3', 7, $6::jsonb)
    ON CONFLICT (tenant_id, license_id) DO NOTHING`,
    [
      tenantId,
      workspaceId,
      licenseId,
      skillId,
      "license_v1",
      JSON.stringify({ license_id: licenseId, skill_id: skillId, license_version: "license_v1" }),
    ]
  );
}
