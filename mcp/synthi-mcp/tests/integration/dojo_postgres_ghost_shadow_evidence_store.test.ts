import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoGhostShadowEvidenceStore } from "../../src/dojo/store/postgres_ghost_shadow_evidence_store.js";
import type { DojoGhostShadowEvidenceRecord } from "../../src/dojo/store/interfaces.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoGhostShadowEvidenceStore", () => {
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
    tenantId = `tenant_ghost_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_ghost";
    skillId = "skill_ghost";
    licenseId = "license_ghost";
    await seedSkill(pool, tenantId, workspaceId, skillId);
    await seedLicense(pool, tenantId, workspaceId, skillId, licenseId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists Ghost Mode shadow evidence by tenant scope and filters operational fields", async () => {
    const store = new PostgresDojoGhostShadowEvidenceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const first = ghostShadowEvidence("ghost_evidence_a", { action_matches: true });
    const second = ghostShadowEvidence("ghost_evidence_b", {
      run_id: "ghost_run_b",
      action_matches: false,
      planned_label: "",
      guardrail_refs: ["guardrail:stable-id-required"],
      evidence_refs: ["skill:skill_ghost", "license:license_ghost", "ghost:ghost_run_b", "guardrail:stable-id-required"],
      created_at: "2026-06-11T00:01:00.000Z",
    });

    await expect(store.saveGhostShadowEvidence(first)).resolves.toEqual(expect.objectContaining({
      evidence_id: "ghost_evidence_a",
      action_matches: true,
      production_mutations_executed: false,
    }));
    await store.saveGhostShadowEvidence(second);

    await expect(store.listGhostShadowEvidence({ skill_id: skillId })).resolves.toEqual([
      expect.objectContaining({ evidence_id: "ghost_evidence_b", action_matches: false, planned_label: "" }),
      expect.objectContaining({ evidence_id: "ghost_evidence_a", action_matches: true }),
    ]);
    await expect(store.listGhostShadowEvidence({ action_matches: false })).resolves.toEqual([
      expect.objectContaining({
        evidence_id: "ghost_evidence_b",
        guardrail_refs: ["guardrail:stable-id-required"],
      }),
    ]);
    await expect(store.listGhostShadowEvidence({ run_id: "ghost_run_a" })).resolves.toEqual([
      expect.objectContaining({ evidence_id: "ghost_evidence_a" }),
    ]);
  });

  it("enforces tenant scope and rejects mutating evidence", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkill(pool, otherTenantId, workspaceId, skillId);
    await seedLicense(pool, otherTenantId, workspaceId, skillId, licenseId);
    const tenantStore = new PostgresDojoGhostShadowEvidenceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const otherStore = new PostgresDojoGhostShadowEvidenceStore({
      tenant_id: otherTenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });

    await tenantStore.saveGhostShadowEvidence(ghostShadowEvidence("ghost_evidence_isolated", {}));

    await expect(tenantStore.listGhostShadowEvidence({ evidence_id: "ghost_evidence_isolated" })).resolves.toHaveLength(1);
    await expect(otherStore.listGhostShadowEvidence({ evidence_id: "ghost_evidence_isolated" })).resolves.toEqual([]);
    await expect(tenantStore.saveGhostShadowEvidence({
      ...ghostShadowEvidence("ghost_evidence_mutating", {}),
      production_mutations_executed: true,
    } as unknown as DojoGhostShadowEvidenceRecord)).rejects.toThrow("dojo_postgres_ghost_shadow_evidence_production_mutation_invalid");
  });

  function ghostShadowEvidence(
    evidenceId: string,
    overrides: Partial<DojoGhostShadowEvidenceRecord>
  ): DojoGhostShadowEvidenceRecord {
    return {
      schema_version: "synthi.dojo.ghostShadowEvidence.v1",
      tenant_id: tenantId,
      workspace_id: workspaceId,
      evidence_id: evidenceId,
      run_id: "ghost_run_a",
      skill_id: skillId,
      workflow_id: `workflow_${skillId}`,
      license_id: licenseId,
      evidence_kind: "shadow",
      production_mutations_executed: false,
      action_matches: true,
      observed_label: "click:Open details",
      planned_label: "click:Open details",
      observed_human_action: { action: "click", name: "Open details" },
      agent_planned_action: { action: "click", name: "Open details" },
      license_status: "licensed",
      guardrail_refs: [],
      evidence_refs: ["skill:skill_ghost", "license:license_ghost", "ghost:ghost_run_a"],
      entrustment_impact: {
        upgrade_allowed: true,
        recommended_entrustment: "E3",
      },
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: { actor_id: "ghost-mode-agent", actor_type: "agent" },
      request_context: {
        request_id: "req-ghost-store",
        correlation_id: "corr-ghost-store",
      },
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
    [
      tenantId,
      workspaceId,
      skillId,
      `workflow_${skillId}`,
      "Ghost Mode Test Skill",
      "skill_v1",
      JSON.stringify({ skill_id: skillId }),
    ]
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
