import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import {
  PostgresDojoProofStore,
  applyDojoPostgresMigrations,
} from "../../src/dojo/store/postgres_proof_store.js";
import type { DojoAuditActor, DojoProofCapsuleRecord } from "../../src/dojo/store/interfaces.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoAuditStore", () => {
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
    tenantId = `tenant_audit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_a";
    skillId = "skill_a";
    await seedSkill(pool, tenantId, workspaceId, skillId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists audit actor, request, correlation, entity, and details", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });

    const written = await auditStore.appendAuditEvent({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      actor: { actor_id: "operator_a", actor_type: "human" },
      event_type: "license_revoked",
      request_id: "req_a",
      correlation_id: "corr_a",
      entity_kind: "license",
      entity_id: "license_a",
      details: { reason: "unit_test", skill_id: skillId },
      created_at: "2026-06-11T00:05:00.000Z",
    });

    expect(written).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      actor: { actor_id: "operator_a", actor_type: "human" },
      event_type: "license_revoked",
      request_id: "req_a",
      correlation_id: "corr_a",
      entity_kind: "license",
      entity_id: "license_a",
      details: { reason: "unit_test", skill_id: skillId },
    }));
    expect(await auditStore.listAuditEvents({ event_type: "license_revoked" })).toEqual([
      expect.objectContaining({ audit_event_id: written.audit_event_id }),
    ]);
    expect(await auditStore.listAuditEvents({ correlation_id: "corr_a" })).toHaveLength(1);
  });

  it("records proof issue, use, rejection, and revoke events from the proof repository", async () => {
    const auditActor: DojoAuditActor = { actor_id: "proof_service", actor_type: "service" };
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const proofStore = new PostgresDojoProofStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: auditActor,
      request_id: "req_proof",
      correlation_id: "corr_proof",
    });

    await proofStore.saveProofRecord(proofRecord("capsule_a", skillId));
    await proofStore.markProofCapsuleValidated("capsule_a", "2026-06-11T00:01:00.000Z");
    await proofStore.markProofCapsuleUsed("capsule_a", "run_1", "2026-06-11T00:02:00.000Z");
    await proofStore.markProofCapsuleUsed("capsule_a", "run_2", "2026-06-11T00:03:00.000Z");
    await proofStore.saveProofRecord(proofRecord("capsule_b", skillId));
    await proofStore.revokeProofCapsule("capsule_b", "operator_revoked", "2026-06-11T00:04:00.000Z");

    const events = await auditStore.listAuditEvents({ correlation_id: "corr_proof" });
    expect(events.map((event) => event.event_type)).toEqual([
      "proof_issued",
      "proof_validated",
      "proof_used",
      "proof_rejected",
      "proof_issued",
      "proof_revoked",
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: auditActor,
        event_type: "proof_validated",
        entity_kind: "proof_capsule",
        entity_id: "capsule_a",
        details: expect.objectContaining({ validated_at: "2026-06-11T00:01:00.000Z" }),
      }),
      expect.objectContaining({
        actor: auditActor,
        entity_kind: "proof_capsule",
        entity_id: "capsule_a",
        details: expect.objectContaining({ run_id: "run_1" }),
      }),
      expect.objectContaining({
        event_type: "proof_rejected",
        details: expect.objectContaining({ blocked_by: ["proof_capsule_replay_detected"] }),
      }),
      expect.objectContaining({
        event_type: "proof_revoked",
        entity_id: "capsule_b",
        details: expect.objectContaining({ revoked_reason: "operator_revoked" }),
      }),
    ]));
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
    [tenantId, workspaceId, skillId, `workflow_${skillId}`, "Audit Test Skill", "skill_v1", JSON.stringify({ skill_id: skillId })]
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
