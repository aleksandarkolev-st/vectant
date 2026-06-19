import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSkill, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoLicenseStore } from "../../src/dojo/store/postgres_license_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoLicenseStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let skill: DojoSkill;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_license_store";
    skill = skillFixture(workspaceId, "Submit invoice");
    await seedSkill(pool, tenantId, workspaceId, skill);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists licenses and version history by tenant scope", async () => {
    const store = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const saved = await store.saveLicense(skill.permission_license, {
      readiness_level: skill.skill_readiness_level,
      expires_at: skill.license_expires_at,
      created_by: { actor_id: "certifier-a", actor_type: "human" },
      now: "2026-06-11T00:01:00.000Z",
    });
    const upgradedLicense = {
      ...skill.permission_license,
      license_version: "1.0.1",
      issued_at: "2026-06-11T00:02:00.000Z",
    };
    const upgraded = await store.saveLicense(upgradedLicense, {
      readiness_level: 8,
      expires_at: "2026-07-11T00:02:00.000Z",
      created_by: { actor_id: "certifier-b", actor_type: "human" },
      now: "2026-06-11T00:02:00.000Z",
    });

    expect(saved).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      license_id: skill.permission_license.license_id,
      skill_id: skill.skill_id,
      license_version: skill.permission_license.license_version,
      status: "active",
      readiness_level: skill.skill_readiness_level,
      expires_at: skill.license_expires_at,
      license_json: expect.objectContaining({
        license_id: skill.permission_license.license_id,
        allowed_actions: expect.any(Array),
      }),
    }));
    expect(upgraded).toEqual(expect.objectContaining({
      license_version: "1.0.1",
      readiness_level: 8,
    }));
    expect(await store.getLicense(skill.permission_license.license_id)).toEqual(expect.objectContaining({
      license_version: "1.0.1",
    }));
    expect(await store.getLicenseVersion(skill.permission_license.license_id, "1.0.0")).toEqual(expect.objectContaining({
      license_version: "1.0.0",
      created_by: "certifier-a",
    }));
    expect(await store.listLicenseVersions({ license_id: skill.permission_license.license_id })).toEqual([
      expect.objectContaining({ license_version: "1.0.1" }),
      expect.objectContaining({ license_version: "1.0.0" }),
    ]);
    expect(await store.listLicenses({ skill_id: skill.skill_id, status: "active" })).toEqual([
      expect.objectContaining({ license_id: skill.permission_license.license_id }),
    ]);
  });

  it("revokes licenses with audit custody", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "license-operator", actor_type: "service" },
      request_id: "request-license-store",
      correlation_id: "correlation-license-store",
    });
    await store.saveLicense(skill.permission_license, {
      readiness_level: skill.skill_readiness_level,
      expires_at: skill.license_expires_at,
      created_by: { actor_id: "certifier-a", actor_type: "human" },
      now: "2026-06-11T00:01:00.000Z",
    });

    const revoked = await store.revokeLicense(
      skill.permission_license.license_id,
      "case-law conflict",
      "2026-06-11T00:05:00.000Z",
      { actor_id: "reviewer-a", actor_type: "human" }
    );

    expect(revoked).toEqual(expect.objectContaining({
      status: "revoked",
      revoked_at: "2026-06-11T00:05:00.000Z",
      revoked_reason: "case-law conflict",
    }));
    expect(await store.getLicenseVersion(skill.permission_license.license_id, skill.permission_license.license_version)).toEqual(expect.objectContaining({
      status: "revoked",
    }));
    expect(await auditStore.listAuditEvents({ entity_kind: "permission_license" })).toEqual([
      expect.objectContaining({
        event_type: "license_issued",
        entity_id: skill.permission_license.license_id,
      }),
      expect.objectContaining({
        event_type: "license_revoked",
        entity_id: skill.permission_license.license_id,
        details: expect.objectContaining({
          revoked_reason: "case-law conflict",
          status: "revoked",
        }),
      }),
    ]);
  });

  it("expires licenses with audit custody", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "license-operator", actor_type: "service" },
      request_id: "request-license-expiry",
      correlation_id: "correlation-license-expiry",
    });
    await store.saveLicense(skill.permission_license, {
      readiness_level: skill.skill_readiness_level,
      expires_at: "2026-07-11T00:00:00.000Z",
      created_by: { actor_id: "certifier-a", actor_type: "human" },
      now: "2026-06-11T00:01:00.000Z",
    });

    const expired = await store.expireLicense(
      skill.permission_license.license_id,
      "source_drift:snapshot-a->snapshot-b tokens=save-button nodes=action_submit",
      "2026-06-12T00:00:00.000Z",
      { actor_id: "source-drift-monitor", actor_type: "service" }
    );

    expect(expired).toEqual(expect.objectContaining({
      status: "expired",
      expires_at: "2026-06-12T00:00:00.000Z",
      revoked_reason: "source_drift:snapshot-a->snapshot-b tokens=save-button nodes=action_submit",
    }));
    expect(await store.expireLicense(
      skill.permission_license.license_id,
      "source_drift:duplicate",
      "2026-06-12T00:05:00.000Z",
      { actor_id: "source-drift-monitor", actor_type: "service" }
    )).toBeNull();
    expect(await store.getLicense(skill.permission_license.license_id)).toEqual(expect.objectContaining({
      status: "expired",
      revoked_reason: "source_drift:snapshot-a->snapshot-b tokens=save-button nodes=action_submit",
    }));
    expect(await store.getLicenseVersion(skill.permission_license.license_id, skill.permission_license.license_version)).toEqual(expect.objectContaining({
      status: "expired",
    }));
    expect(await auditStore.listAuditEvents({ entity_kind: "permission_license" })).toEqual([
      expect.objectContaining({
        event_type: "license_issued",
        entity_id: skill.permission_license.license_id,
      }),
      expect.objectContaining({
        event_type: "license_expired",
        entity_id: skill.permission_license.license_id,
        actor: { actor_id: "source-drift-monitor", actor_type: "service" },
        details: expect.objectContaining({
          expired_reason: "source_drift:snapshot-a->snapshot-b tokens=save-button nodes=action_submit",
          status: "expired",
          expires_at: "2026-06-12T00:00:00.000Z",
        }),
      }),
    ]);
  });

  it("rejects invalid license shape and readiness before persistence", async () => {
    const store = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });

    await expect(store.saveLicense({
      ...skill.permission_license,
      schema_version: "invalid" as any,
    }, {
      readiness_level: skill.skill_readiness_level,
    })).rejects.toThrow("dojo_postgres_license_schema_version_invalid");
    await expect(store.saveLicense(skill.permission_license, {
      readiness_level: 12 as any,
    })).rejects.toThrow("dojo_postgres_license_readiness_level_invalid");
  });

  it("enforces tenant boundaries for licenses and versions", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkill(pool, otherTenantId, workspaceId, skill);
    const tenantStore = new PostgresDojoLicenseStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoLicenseStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });
    const saved = await tenantStore.saveLicense(skill.permission_license, {
      readiness_level: skill.skill_readiness_level,
      expires_at: skill.license_expires_at,
    });

    expect(await tenantStore.getLicense(saved.license_id)).toEqual(expect.objectContaining({
      license_id: saved.license_id,
    }));
    expect(await otherStore.getLicense(saved.license_id)).toBeNull();
    expect(await otherStore.listLicenseVersions({ license_id: saved.license_id })).toEqual([]);
  });
});

async function seedSkill(
  pool: Pool,
  tenantId: string,
  workspaceId: string,
  skill: DojoSkill
): Promise<void> {
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
    [tenantId, workspaceId, "org_a", skill.app_origin]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, status, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, 'published', $6, $7::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
    [tenantId, workspaceId, skill.skill_id, skill.workflow_id, skill.name, skill.skill_version, JSON.stringify(skill)]
  );
  await pool.query(
    `INSERT INTO dojo_skill_versions (
      tenant_id,
      workspace_id,
      skill_id,
      skill_version,
      graph_version,
      seed_json,
      graph_json,
      created_at,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz, $9)
    ON CONFLICT (tenant_id, skill_id, skill_version) DO NOTHING`,
    [
      tenantId,
      workspaceId,
      skill.skill_id,
      skill.skill_version,
      skill.skill_cortex.graph_version,
      JSON.stringify(skill.skill_seed),
      JSON.stringify(skill.skill_cortex),
      skill.permission_license.issued_at,
      "license-store-test",
    ]
  );
}

function skillFixture(workspaceId: string, label: string): DojoSkill {
  const workflow = compileWorkflowContract([
    event({
      event_id: label.toLowerCase().replace(/\s+/g, "_"),
      action: "click",
      element: { role: "button", name: label, source_id: `source.${label.toLowerCase().replace(/\s+/g, ".")}` },
      locator_candidates: [
        { kind: "role", locator: `page.getByRole("button", { name: "${label}" })`, confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract;
  const manifest = generatePrivateWorkflowToolManifest(workflow);
  return buildDojoSkill(workflow, {
    workspace_id: workspaceId,
    now: "2026-06-11T00:00:00.000Z",
    private_tool_manifest: manifest,
    published_tool_name: manifest.tool_name,
  });
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/invoices",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
