import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSkill, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoSkillStore", () => {
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
    workspaceId = "workspace_skill_store";
    skill = skillFixture(workspaceId, "Submit invoice");
    await seedWorkspace(pool, tenantId, workspaceId, skill.app_origin);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists skills and published workflow bindings by tenant scope", async () => {
    const store = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });

    const saved = await store.saveSkill(skill, {
      created_by: { actor_id: "skill-certifier", actor_type: "human" },
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(saved).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      name: skill.name,
      status: "published",
      current_skill_version: skill.skill_version,
      skill_json: expect.objectContaining({
        schema_version: "synthi.dojo.skill.v1",
        skill_id: skill.skill_id,
        published_tool_name: skill.published_tool_name,
      }),
      created_at: skill.generated_at,
      updated_at: "2026-06-11T00:01:00.000Z",
    }));
    expect(await store.getSkill(skill.skill_id)).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      published_tool_name: skill.published_tool_name,
    }));
    expect(await store.getSkillByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
    }));
    expect(await store.getSkillByPublishedToolName(skill.published_tool_name!)).toEqual(expect.objectContaining({
      workflow_id: skill.workflow_id,
    }));
    expect(await store.listSkillRecords({ published_tool_name: skill.published_tool_name })).toEqual([
      expect.objectContaining({ skill_id: skill.skill_id }),
    ]);
    expect(await store.getPublishedWorkflowBindingByWorkflowId(skill.workflow_id)).toEqual({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_names: [skill.published_tool_name],
    });
    expect(await store.getPublishedWorkflowBindingByToolName(skill.published_tool_name!)).toEqual({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_names: [skill.published_tool_name],
    });
  });

  it("persists skill version records and audit custody", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "skill-store-service", actor_type: "service" },
      request_id: "request-skill-store",
      correlation_id: "correlation-skill-store",
    });

    await store.saveSkill(skill, {
      created_by: { actor_id: "skill-certifier", actor_type: "human" },
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(await store.getSkillVersion(skill.skill_id, skill.skill_version)).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
      skill_version: skill.skill_version,
      graph_version: skill.workflow_graph_id,
      seed_json: expect.objectContaining({
        seed_id: skill.skill_seed.seed_id,
        workflow_id: skill.workflow_id,
      }),
      graph_json: expect.objectContaining({
        schema_version: "synthi.dojo.skillCortex.v1",
        workflow_graph_id: skill.workflow_graph_id,
      }),
      created_by: "skill-certifier",
    }));
    expect(await store.listSkillVersions({ skill_id: skill.skill_id, created_by: "skill-certifier" })).toEqual([
      expect.objectContaining({ skill_version: skill.skill_version }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "skill" })).toEqual([
      expect.objectContaining({
        event_type: "skill_created",
        entity_id: skill.skill_id,
        actor: { actor_id: "skill-certifier", actor_type: "human" },
        details: expect.objectContaining({
          workflow_id: skill.workflow_id,
          published_tool_names: [skill.published_tool_name],
        }),
      }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "skill_version" })).toEqual([
      expect.objectContaining({
        event_type: "skill_version_created",
        entity_id: `${skill.skill_id}:${skill.skill_version}`,
        actor: { actor_id: "skill-certifier", actor_type: "human" },
        details: expect.objectContaining({
          skill_version: skill.skill_version,
          graph_version: skill.workflow_graph_id,
        }),
      }),
    ]);
  });

  it("rejects invalid skill shape and workspace mismatch before persistence", async () => {
    const store = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });

    await expect(store.saveSkill({
      ...skill,
      schema_version: "invalid" as any,
    })).rejects.toThrow("dojo_postgres_skill_schema_version_invalid");

    await expect(store.saveSkill({
      ...skill,
      workspace_id: "other_workspace",
    })).rejects.toThrow("dojo_postgres_skill_workspace_mismatch");
  });

  it("enforces tenant boundaries for skills and versions", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedWorkspace(pool, otherTenantId, workspaceId, skill.app_origin);
    const tenantStore = new PostgresDojoSkillStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoSkillStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    const saved = await tenantStore.saveSkill(skill, {
      created_by: { actor_id: "skill-certifier", actor_type: "human" },
    });

    expect(await tenantStore.getSkillRecord(saved.skill_id)).toEqual(expect.objectContaining({
      skill_id: saved.skill_id,
    }));
    expect(await otherStore.getSkill(saved.skill_id)).toBeNull();
    expect(await otherStore.getSkillByWorkflowId(skill.workflow_id)).toBeNull();
    expect(await otherStore.getSkillByPublishedToolName(skill.published_tool_name!)).toBeNull();
    expect(await otherStore.listSkillVersions({ skill_id: saved.skill_id })).toEqual([]);
  });
});

async function seedWorkspace(
  pool: Pool,
  tenantId: string,
  workspaceId: string,
  appOrigin: string
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
    [tenantId, workspaceId, "org_a", appOrigin]
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
