import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  PostgresDojoProofStore,
  applyDojoPostgresMigrations,
} from "../../src/dojo/store/postgres_proof_store.js";
import type { DojoProofCapsuleRecord } from "../../src/dojo/store/interfaces.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoProofStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let skillId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_a";
    skillId = "skill_a";
    await seedSkill(pool, tenantId, workspaceId, skillId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists, reads, lists, and revokes proof records by tenant scope", async () => {
    const store = new PostgresDojoProofStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const record = proofRecord("capsule_a", skillId);

    await store.saveProofRecord(record);

    expect(await store.getProofRecord("capsule_a")).toEqual(expect.objectContaining({
      capsule_id: "capsule_a",
      status: "issued",
      nonce: "nonce_capsule_a",
    }));
    expect(await store.listProofRecords()).toEqual([
      expect.objectContaining({ capsule_id: "capsule_a" }),
    ]);

    const revoked = await store.revokeProofCapsule("capsule_a", "unit_test_revoked", "2026-06-11T00:05:00.000Z");
    expect(revoked).toEqual(expect.objectContaining({
      capsule_id: "capsule_a",
      status: "revoked",
      revoked_reason: "unit_test_revoked",
      revoked_at: "2026-06-11T00:05:00.000Z",
    }));
  });

  it("atomically consumes an issued proof exactly once", async () => {
    const store = new PostgresDojoProofStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    await store.saveProofRecord(proofRecord("capsule_once", skillId));

    const first = await store.markProofCapsuleUsed("capsule_once", "run_1", "2026-06-11T00:02:00.000Z");
    const second = await store.markProofCapsuleUsed("capsule_once", "run_2", "2026-06-11T00:03:00.000Z");

    expect(first).toEqual(expect.objectContaining({
      ok: true,
      status: "used",
      blocked_by: [],
      record: expect.objectContaining({ first_used_at: "2026-06-11T00:02:00.000Z" }),
    }));
    expect(second).toEqual(expect.objectContaining({
      ok: false,
      status: "already_used",
      blocked_by: ["proof_capsule_replay_detected"],
    }));
  });

  it("allows only one winner during concurrent proof consume", async () => {
    const store = new PostgresDojoProofStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    await store.saveProofRecord(proofRecord("capsule_race", skillId));

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.markProofCapsuleUsed("capsule_race", `run_${index}`, "2026-06-11T00:04:00.000Z")
    ));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => result.status)).toEqual(
      Array(7).fill("already_used")
    );
  });

  it("prevents cross-tenant proof reads", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkill(pool, otherTenantId, workspaceId, skillId);
    const tenantStore = new PostgresDojoProofStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoProofStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    await tenantStore.saveProofRecord(proofRecord("capsule_isolated", skillId));

    expect(await tenantStore.getProofRecord("capsule_isolated")).toEqual(expect.objectContaining({
      capsule_id: "capsule_isolated",
    }));
    expect(await otherStore.getProofRecord("capsule_isolated")).toBeNull();
  });
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
    [tenantId, workspaceId, skillId, `workflow_${skillId}`, "Proof Test Skill", "skill_v1", JSON.stringify({ skill_id: skillId })]
  );
}

function proofRecord(capsuleId: string, skillId: string): DojoProofCapsuleRecord {
  return {
    capsule_id: capsuleId,
    skill_id: skillId,
    requested_action: "run_workflow",
    nonce: `nonce_${capsuleId}`,
    issued_at: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
    status: "issued",
  };
}
