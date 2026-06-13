import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSkill, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import {
  createDojoHostedRuntimeGatewayFromEnv,
  type DojoHostedRuntimeGatewayResolution,
} from "../../src/dojo/runtime/hosted_runtime_gateway_resolver.js";
import { PostgresDojoHostedRuntimeSessionStore } from "../../src/dojo/runtime/postgres_hosted_runtime_store.js";
import type { DojoHostedRuntimeEvidenceWriter } from "../../src/dojo/runtime/hosted_runtime_gateway.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import type {
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditStore,
} from "../../src/dojo/store/interfaces.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("Dojo hosted runtime gateway resolver Postgres integration", () => {
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
    workspaceId = "workspace_runtime_resolver";
    skill = skillFixture(workspaceId, "Approve claim");
    await seedWorkspaceAndSkill(pool, tenantId, workspaceId, skill);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("selects the Postgres-backed hosted runtime gateway from control-plane env", async () => {
    const memoryAudit = new MemoryAuditStore();
    const evidence = new MemoryRuntimeEvidenceWriter();
    const resolution = await createDojoHostedRuntimeGatewayFromEnv({
      env: {
        SYNTHI_DOJO_CONTROL_PLANE_STORE: "postgres",
        SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL: postgresUrl,
      },
      audit_store: memoryAudit,
      evidence_writer: evidence,
    });
    try {
      expect(resolution).toEqual(expect.objectContaining({
        ok: true,
        store_kind: "postgres",
        production_capable: true,
      }));
      if (!resolution.ok) throw new Error("expected_postgres_gateway_resolution");

      const created = await resolution.gateway.createSession({
        tenant: tenant(tenantId, workspaceId),
        skill_id: skill.skill_id,
        run_id: "run-runtime-resolver",
        workspace_url: "https://workspace.example.test/app",
        origin_allowlist: ["https://workspace.example.test"],
        ttl_ms: 900_000,
        credential_ttl_ms: 60_000,
        now: "2026-06-11T00:00:00.000Z",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("expected_runtime_session_create_success");

      const sessionStore = new PostgresDojoHostedRuntimeSessionStore({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        queryable: pool,
      });
      expect(await sessionStore.getSession({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        session_id: created.session.session_id,
      })).toEqual(expect.objectContaining({
        session_id: created.session.session_id,
        tenant_id: tenantId,
        workspace_id: workspaceId,
        skill_id: skill.skill_id,
        run_id: "run-runtime-resolver",
        audit_event_refs: [created.audit_event_id],
      }));

      const postgresAudit = new PostgresDojoAuditStore({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        queryable: pool,
      });
      expect(await postgresAudit.listAuditEvents({ entity_id: created.session.session_id })).toEqual([
        expect.objectContaining({
          audit_event_id: created.audit_event_id,
          event_type: "runtime_session_created",
        }),
      ]);
      expect(memoryAudit.events).toEqual([
        expect.objectContaining({
          audit_event_id: created.audit_event_id,
          event_type: "runtime_session_created",
        }),
      ]);

      const decision = await resolution.gateway.authorizeAction({
        tenant: tenant(tenantId, workspaceId),
        session_id: created.session.session_id,
        skill_id: skill.skill_id,
        run_id: "run-runtime-resolver",
        action_kind: "proof_gated_tool",
        url: "https://workspace.example.test/app/claims",
        credential_id: created.credentials.credential_id,
        credential_secret: created.credentials.credential_secret,
        now: "2026-06-11T00:00:30.000Z",
        details: { requested_action: "run_workflow" },
      });
      expect(decision).toEqual(expect.objectContaining({
        ok: true,
        evidence_record_ids: ["runtime-evidence-001"],
      }));
      expect(await sessionStore.getSession({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        session_id: created.session.session_id,
      })).toEqual(expect.objectContaining({
        evidence_refs: ["runtime-evidence-001"],
        audit_event_refs: [created.audit_event_id, decision.audit_event_id],
      }));
      expect(JSON.stringify(evidence.records)).not.toContain(created.credentials.credential_secret);
    } finally {
      await closeResolution(resolution);
    }
  });
});

async function closeResolution(resolution: DojoHostedRuntimeGatewayResolution): Promise<void> {
  if (resolution.ok && resolution.close) await resolution.close();
}

async function seedWorkspaceAndSkill(
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
  await new PostgresDojoSkillStore({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    queryable: pool,
  }).saveSkill(skill, {
    created_by: { actor_id: "runtime-resolver-test", actor_type: "service" },
    now: "2026-06-11T00:00:00.000Z",
  });
}

function tenant(tenantId: string, workspaceId: string): DojoTenantContext {
  return {
    tenant_id: tenantId,
    organization_id: "org_a",
    workspace_id: workspaceId,
    actor_id: "agent-runtime",
    actor_type: "agent",
    roles: ["dojo:runtime"],
    request_id: `request-${tenantId}-${workspaceId}`,
    correlation_id: `correlation-${tenantId}-${workspaceId}`,
  };
}

class MemoryAuditStore implements DojoAuditStore {
  readonly events: DojoAuditEventRecord[] = [];

  appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
    const record: DojoAuditEventRecord = {
      audit_event_id: event.audit_event_id ?? `audit-${this.events.length + 1}`,
      tenant_id: event.tenant_id,
      workspace_id: event.workspace_id,
      actor: { ...event.actor },
      event_type: event.event_type,
      request_id: event.request_id,
      correlation_id: event.correlation_id,
      entity_kind: event.entity_kind,
      entity_id: event.entity_id,
      details: { ...(event.details ?? {}) },
      created_at: event.created_at ?? "2026-06-11T00:00:00.000Z",
    };
    this.events.push(record);
    return record;
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): DojoAuditEventRecord[] {
    return this.events
      .filter((event) => !filter.event_type || event.event_type === filter.event_type)
      .filter((event) => !filter.entity_kind || event.entity_kind === filter.entity_kind)
      .filter((event) => !filter.entity_id || event.entity_id === filter.entity_id)
      .filter((event) => !filter.correlation_id || event.correlation_id === filter.correlation_id);
  }
}

class MemoryRuntimeEvidenceWriter implements DojoHostedRuntimeEvidenceWriter {
  readonly records: Array<{ session_id: string; action_kind: string; details?: Record<string, unknown> }> = [];

  appendRuntimeActionEvidence(input: Parameters<DojoHostedRuntimeEvidenceWriter["appendRuntimeActionEvidence"]>[0]) {
    const recordId = `runtime-evidence-${String(this.records.length + 1).padStart(3, "0")}`;
    this.records.push({
      session_id: input.session.session_id,
      action_kind: input.action_kind,
      details: input.details,
    });
    return { record_id: recordId };
  }
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
    url: "https://app.example.test/claims",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
