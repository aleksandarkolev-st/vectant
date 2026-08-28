import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSkill, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import {
  createInProcessDojoHostedRuntimeGateway,
  type DojoHostedRuntimeEvidenceWriter,
} from "../../src/dojo/runtime/hosted_runtime_gateway.js";
import { PostgresDojoHostedRuntimeSessionStore } from "../../src/dojo/runtime/postgres_hosted_runtime_store.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoHostedRuntimeSessionStore integration", () => {
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
    workspaceId = "workspace_runtime_session_store";
    skill = skillFixture(workspaceId, "Submit invoice");
    await seedWorkspaceAndSkill(pool, tenantId, workspaceId, skill);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists gateway-created hosted runtime sessions and revocation updates", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const sessionStore = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const gateway = createInProcessDojoHostedRuntimeGateway({
      audit_store: auditStore,
      store: sessionStore,
      random_id: idSequence(["session-a", "runtime-a", "credential-a"]),
      random_secret: secretSequence(["runtime-secret-a"]),
    });

    const created = await gateway.createSession({
      tenant: tenant(tenantId, workspaceId),
      skill_id: skill.skill_id,
      run_id: "run-runtime-a",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://workspace.example.test/any-path"],
      ttl_ms: 900_000,
      credential_ttl_ms: 60_000,
      sensitive_workspace: true,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected_runtime_session_create_success");
    expect(created.session).toEqual(expect.objectContaining({
      session_id: "dojo_runtime_session_session-a",
      runtime_id: "dojo_runtime_runtime-a",
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
      run_id: "run-runtime-a",
      workspace_origin: "https://workspace.example.test",
      origin_allowlist: ["https://workspace.example.test"],
      credential_id: "runtime_cred_credential-a",
      redaction_policy: { screenshots: true },
      egress_policy: { local_network_allowed: false },
      audit_event_refs: [created.audit_event_id],
    }));
    expect(created.session).not.toHaveProperty("credential_secret");
    expect(created.session.credential_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await sessionStore.getSession({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      session_id: created.session.session_id,
    })).toEqual(created.session);

    const revoked = await gateway.revokeSession({
      tenant: tenant(tenantId, workspaceId),
      session_id: created.session.session_id,
      reason: "operator_revoked",
      now: "2026-06-11T00:02:00.000Z",
    });

    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error("expected_runtime_session_revoke_success");
    expect(revoked.session).toEqual(expect.objectContaining({
      status: "revoked",
      revoked_at: "2026-06-11T00:02:00.000Z",
      revoked_reason: "operator_revoked",
      audit_event_refs: [created.audit_event_id, revoked.audit_event_id],
    }));
    expect(await auditStore.listAuditEvents({ entity_kind: "runtime_session" })).toEqual([
      expect.objectContaining({
        event_type: "runtime_session_created",
        entity_id: created.session.session_id,
      }),
      expect.objectContaining({
        event_type: "runtime_session_revoked",
        entity_id: created.session.session_id,
        details: expect.objectContaining({ reason: "operator_revoked" }),
      }),
    ]);
  });

  it("authorizes actions through a Postgres-backed hosted runtime session and persists evidence refs", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const sessionStore = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const evidence = new MemoryRuntimeEvidenceWriter();
    const gateway = createInProcessDojoHostedRuntimeGateway({
      audit_store: auditStore,
      store: sessionStore,
      evidence_writer: evidence,
      random_id: idSequence(["session-b", "runtime-b", "credential-b"]),
      random_secret: secretSequence(["runtime-secret-b"]),
    });
    const created = await gateway.createSession({
      tenant: tenant(tenantId, workspaceId),
      skill_id: skill.skill_id,
      run_id: "run-runtime-b",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://workspace.example.test"],
      ttl_ms: 900_000,
      credential_ttl_ms: 60_000,
      now: "2026-06-11T00:00:00.000Z",
    });
    if (!created.ok) throw new Error("expected_runtime_session_create_success");

    const decision = await gateway.authorizeAction({
      tenant: tenant(tenantId, workspaceId),
      session_id: created.session.session_id,
      skill_id: skill.skill_id,
      run_id: "run-runtime-b",
      action_kind: "graph_action",
      url: "https://workspace.example.test/app/invoices",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
      details: { graph_node_id: "action_submit_invoice" },
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: true,
      status: "authorized",
      blocked_by: [],
      evidence_record_ids: ["runtime-evidence-001"],
    }));
    expect(JSON.stringify(evidence.records)).not.toContain(created.credentials.credential_secret);
    expect(await sessionStore.getSession({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      session_id: created.session.session_id,
    })).toEqual(expect.objectContaining({
      evidence_refs: ["runtime-evidence-001"],
      audit_event_refs: [created.audit_event_id, decision.audit_event_id],
    }));
  });

  it("enforces tenant boundaries for persisted hosted runtime sessions", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedWorkspaceAndSkill(pool, otherTenantId, workspaceId, skill);
    const tenantStore = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const otherStore = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: otherTenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const session = runtimeSessionFixture({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
    });

    await tenantStore.saveSession(session);

    expect(await tenantStore.getSession({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      session_id: session.session_id,
    })).toEqual(expect.objectContaining({ session_id: session.session_id }));
    expect(await otherStore.getSession({
      tenant_id: otherTenantId,
      workspace_id: workspaceId,
      session_id: session.session_id,
    })).toBeNull();
    expect(await otherStore.listSessions({
      tenant_id: otherTenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
    })).toEqual([]);
  });

  it("rejects malformed session records before Postgres writes", async () => {
    const store = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });

    await expect(store.saveSession(runtimeSessionFixture({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
      schema_version: "invalid" as any,
    }))).rejects.toThrow("dojo_runtime_session_schema_version_invalid");

    await expect(store.saveSession(runtimeSessionFixture({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skill.skill_id,
      credential_sha256: "not-a-digest",
    }))).rejects.toThrow("dojo_runtime_session_credential_sha256_invalid");
  });
});

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
    created_by: { actor_id: "runtime-session-test", actor_type: "service" },
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

function idSequence(values: string[]): () => string {
  const queue = [...values];
  return () => queue.shift() ?? "id";
}

function secretSequence(values: string[]): () => string {
  const queue = [...values];
  return () => queue.shift() ?? "secret";
}

class MemoryRuntimeEvidenceWriter implements DojoHostedRuntimeEvidenceWriter {
  readonly records: Array<{
    action_kind: string;
    url_origin: string;
    session_id: string;
    details?: Record<string, unknown>;
  }> = [];

  appendRuntimeActionEvidence(input: Parameters<DojoHostedRuntimeEvidenceWriter["appendRuntimeActionEvidence"]>[0]) {
    const recordId = `runtime-evidence-${String(this.records.length + 1).padStart(3, "0")}`;
    this.records.push({
      action_kind: input.action_kind,
      url_origin: input.url_origin,
      session_id: input.session.session_id,
      details: input.details,
    });
    return { record_id: recordId };
  }
}

function runtimeSessionFixture(
  overrides: Partial<ReturnType<typeof baseRuntimeSessionFixture>> = {}
): ReturnType<typeof baseRuntimeSessionFixture> {
  return {
    ...baseRuntimeSessionFixture(),
    ...overrides,
  };
}

function baseRuntimeSessionFixture() {
  return {
    schema_version: "synthi.dojo.hostedRuntimeSession.v1" as const,
    session_id: "runtime-session-fixture",
    runtime_id: "runtime-fixture",
    tenant_id: "tenant-fixture",
    organization_id: "org_a",
    workspace_id: "workspace-fixture",
    skill_id: "skill-fixture",
    run_id: "run-fixture",
    actor_id: "agent-runtime",
    actor_type: "agent" as const,
    workspace_url: "https://workspace.example.test/app",
    workspace_origin: "https://workspace.example.test",
    origin_allowlist: ["https://workspace.example.test"],
    status: "active" as const,
    created_at: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
    credential_id: "credential-fixture",
    credential_sha256: "a".repeat(64),
    credential_expires_at: "2026-06-11T00:05:00.000Z",
    egress_policy: {
      local_network_allowed: false,
    },
    redaction_policy: {
      screenshots: true,
    },
    audit_event_refs: ["audit-fixture"],
    evidence_refs: [],
  };
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
