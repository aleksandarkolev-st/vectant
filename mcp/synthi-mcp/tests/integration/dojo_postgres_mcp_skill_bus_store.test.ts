import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSkill, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { buildDojoMcpSkillManifest } from "../../src/dojo/mcp/manifest_signing.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import {
  PostgresDojoMcpSkillBusStore,
  toolRegistrationIdForManifest,
} from "../../src/dojo/store/postgres_mcp_skill_bus_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoMcpSkillBusStore", () => {
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
    workspaceId = "workspace_mcp_skill_bus";
    skill = skillFixture(workspaceId, "Submit invoice");
    await seedSkillAndLicense(pool, tenantId, workspaceId, skill);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists signed tool registrations and revocation state by tenant scope", async () => {
    const env = manifestEnv();
    const manifest = buildDojoMcpSkillManifest(skill, { env });
    const store = new PostgresDojoMcpSkillBusStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      env,
    });

    const saved = await store.saveToolRegistration(manifest);

    expect(saved).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      tool_registration_id: toolRegistrationIdForManifest(tenantId, workspaceId, manifest),
      tool_name: manifest.tool.name,
      tool_version: manifest.tool.version,
      skill_id: skill.skill_id,
      license_id: skill.permission_license.license_id,
      manifest_digest: manifest.manifest_digest.slice("sha256:".length),
      proof_required: true,
      direct_call_policy: "dojo_dispatcher_only",
      status: "active",
      manifest_json: expect.objectContaining({
        manifest_id: manifest.manifest_id,
        signature: manifest.signature,
      }),
    }));
    expect(await store.getActiveToolRegistrationByTool(saved.tool_name, saved.tool_version)).toEqual(
      expect.objectContaining({ tool_registration_id: saved.tool_registration_id })
    );
    expect(await store.listToolRegistrations({ skill_id: skill.skill_id, status: "active" })).toEqual([
      expect.objectContaining({ tool_registration_id: saved.tool_registration_id }),
    ]);

    const revoked = await store.revokeToolRegistration(saved.tool_registration_id, "2026-06-11T00:05:00.000Z");

    expect(revoked).toEqual(expect.objectContaining({
      status: "revoked",
      revoked_at: "2026-06-11T00:05:00.000Z",
    }));
    expect(await store.getActiveToolRegistrationByTool(saved.tool_name, saved.tool_version)).toBeNull();
  });

  it("records MCP tool invocations with audit custody", async () => {
    const env = manifestEnv();
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoMcpSkillBusStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      env,
      request_id: "request-mcp-store",
      correlation_id: "correlation-mcp-store",
    });
    const manifest = buildDojoMcpSkillManifest(skill, { env });
    const registration = await store.saveToolRegistration(manifest);

    const blocked = await store.recordToolInvocation({
      invocation_id: "invocation_blocked",
      tool_registration_id: registration.tool_registration_id,
      tool_name: registration.tool_name,
      tool_version: registration.tool_version,
      skill_id: skill.skill_id,
      actor: { actor_id: "agent-a", actor_type: "agent" },
      requested_action: "run_workflow",
      status: "blocked",
      invocation_json: {
        blocked_by: ["dojo_proof_capsule_required"],
      },
      created_at: "2026-06-11T00:01:00.000Z",
    });
    const allowed = await store.recordToolInvocation({
      invocation_id: "invocation_allowed",
      tool_registration_id: registration.tool_registration_id,
      tool_name: registration.tool_name,
      tool_version: registration.tool_version,
      skill_id: skill.skill_id,
      actor: { actor_id: "agent-a", actor_type: "agent" },
      requested_action: "run_workflow",
      status: "allowed",
      proof_capsule_id: "capsule-a",
      invocation_json: {
        proof_capsule_id: "capsule-a",
      },
      created_at: "2026-06-11T00:02:00.000Z",
    });

    expect(blocked).toEqual(expect.objectContaining({
      audit_event_id: expect.any(String),
      status: "blocked",
      invocation_json: expect.objectContaining({ blocked_by: ["dojo_proof_capsule_required"] }),
    }));
    expect(allowed).toEqual(expect.objectContaining({
      audit_event_id: expect.any(String),
      status: "allowed",
      proof_capsule_id: "capsule-a",
    }));
    expect(await store.listToolInvocations({ tool_registration_id: registration.tool_registration_id })).toEqual([
      expect.objectContaining({ invocation_id: "invocation_allowed" }),
      expect.objectContaining({ invocation_id: "invocation_blocked" }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "mcp_tool_invocation" })).toEqual([
      expect.objectContaining({
        event_type: "mcp_tool_invocation_blocked",
        entity_id: "invocation_blocked",
        details: expect.objectContaining({
          tool_registration_id: registration.tool_registration_id,
          blocked_by: ["dojo_proof_capsule_required"],
        }),
      }),
      expect.objectContaining({
        event_type: "mcp_tool_invocation_allowed",
        entity_id: "invocation_allowed",
        details: expect.objectContaining({
          proof_capsule_id: "capsule-a",
        }),
      }),
    ]);
  });

  it("rejects invalid or workspace-mismatched signed manifests before registration", async () => {
    const env = manifestEnv();
    const store = new PostgresDojoMcpSkillBusStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      env,
    });
    const manifest = buildDojoMcpSkillManifest(skill, { env });

    await expect(store.saveToolRegistration({
      ...manifest,
      tool: {
        ...manifest.tool,
        version: "tampered-version",
      },
    })).rejects.toThrow(/dojo_postgres_mcp_manifest_invalid/);

    const otherWorkspaceSkill = skillFixture("workspace_other", "Submit invoice");
    const otherManifest = buildDojoMcpSkillManifest(otherWorkspaceSkill, { env });
    await expect(store.saveToolRegistration(otherManifest)).rejects.toThrow(
      "dojo_postgres_mcp_manifest_workspace_mismatch"
    );
  });

  it("enforces tenant boundaries for tool registrations and invocations", async () => {
    const env = manifestEnv();
    const otherTenantId = `${tenantId}_other`;
    await seedSkillAndLicense(pool, otherTenantId, workspaceId, skill);
    const tenantStore = new PostgresDojoMcpSkillBusStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool, env });
    const otherStore = new PostgresDojoMcpSkillBusStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool, env });
    const manifest = buildDojoMcpSkillManifest(skill, { env });
    const registration = await tenantStore.saveToolRegistration(manifest);
    await tenantStore.recordToolInvocation({
      invocation_id: "invocation_isolated",
      tool_registration_id: registration.tool_registration_id,
      tool_name: registration.tool_name,
      tool_version: registration.tool_version,
      skill_id: skill.skill_id,
      actor: { actor_id: "agent-a", actor_type: "agent" },
      requested_action: "run_workflow",
      status: "allowed",
      created_at: "2026-06-11T00:03:00.000Z",
    });

    expect(await tenantStore.getToolRegistration(registration.tool_registration_id)).toEqual(expect.objectContaining({
      tool_registration_id: registration.tool_registration_id,
    }));
    expect(await otherStore.getToolRegistration(registration.tool_registration_id)).toBeNull();
    expect(await tenantStore.listToolInvocations({ invocation_id: "invocation_isolated" })).toHaveLength(1);
    expect(await otherStore.listToolInvocations({ invocation_id: "invocation_isolated" })).toEqual([]);
  });
});

async function seedSkillAndLicense(
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
    ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8::jsonb)
    ON CONFLICT (tenant_id, license_id) DO NOTHING`,
    [
      tenantId,
      workspaceId,
      skill.permission_license.license_id,
      skill.skill_id,
      skill.permission_license.license_version,
      skill.entrustment_level,
      skill.skill_readiness_level,
      JSON.stringify(skill.permission_license),
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

function manifestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYNTHI_DOJO_MCP_MANIFEST_ISSUER: "postgres-skill-bus-test",
    SYNTHI_DOJO_MCP_MANIFEST_KEY_ID: "postgres-skill-bus-key",
    SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY: "postgres-skill-bus-secret",
  };
}
