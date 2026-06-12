import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresDojoHostedRuntimeSessionStore } from "../../src/dojo/runtime/postgres_hosted_runtime_store.js";
import type { DojoHostedRuntimeSessionRecord } from "../../src/dojo/runtime/hosted_runtime_gateway.js";
import type { DojoPostgresQueryable } from "../../src/dojo/store/postgres_proof_store.js";

describe("PostgresDojoHostedRuntimeSessionStore", () => {
  it("saves, reads, updates, and lists tenant-scoped runtime sessions", async () => {
    const queryable = new RuntimeSessionQueryableFake();
    const store = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable,
    });

    const saved = await store.saveSession(runtimeSession({ session_id: "session-a" }));
    expect(saved).toEqual(expect.objectContaining({
      session_id: "session-a",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      status: "active",
      origin_allowlist: ["https://workspace.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    }));

    const read = await store.getSession({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      session_id: "session-a",
    });
    expect(read).toEqual(saved);
    expect(await store.getSession({
      tenant_id: "tenant-b",
      workspace_id: "workspace-a",
      session_id: "session-a",
    })).toBeNull();

    const updated = await store.updateSession({
      ...saved,
      status: "revoked",
      revoked_at: "2026-06-11T00:01:00.000Z",
      revoked_reason: "operator_revoked",
      audit_event_refs: [...saved.audit_event_refs, "audit-2"],
      evidence_refs: [...saved.evidence_refs, "evidence-1"],
    });
    expect(updated).toEqual(expect.objectContaining({
      status: "revoked",
      revoked_at: "2026-06-11T00:01:00.000Z",
      revoked_reason: "operator_revoked",
      audit_event_refs: ["audit-1", "audit-2"],
      evidence_refs: ["evidence-1"],
    }));

    await store.saveSession(runtimeSession({ session_id: "session-b", run_id: "run-b" }));
    expect(await store.listSessions({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
    })).toHaveLength(2);
    expect(await store.listSessions({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      run_id: "run-a",
    })).toEqual([updated]);
  });

  it("rejects writes outside the configured tenant and workspace scope", async () => {
    const store = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      queryable: new RuntimeSessionQueryableFake(),
    });

    await expect(store.saveSession(runtimeSession({ tenant_id: "tenant-b" }))).rejects.toThrow("dojo_runtime_session_tenant_mismatch");
    await expect(store.updateSession(runtimeSession({ workspace_id: "workspace-b" }))).rejects.toThrow("dojo_runtime_session_workspace_mismatch");
  });
});

class RuntimeSessionQueryableFake implements DojoPostgresQueryable {
  private readonly rows = new Map<string, RuntimeSessionRowFake>();

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    const normalized = text.toLowerCase().replace(/\s+/g, " ");
    if (normalized.includes("insert into dojo_runtime_sessions")) {
      const row = rowFromValues(values);
      this.rows.set(key(row.tenant_id, row.workspace_id, row.session_id), row);
      return result([row as T]);
    }
    if (normalized.includes("from dojo_runtime_sessions") && normalized.includes("session_id = $3")) {
      return result(optionalRow(this.rows.get(key(String(values[0]), String(values[1]), String(values[2]))) as T | undefined));
    }
    if (normalized.includes("from dojo_runtime_sessions")) {
      const tenantId = String(values[0]);
      const workspaceId = String(values[1]);
      const hasSkillFilter = normalized.includes("skill_id = $");
      const hasRunFilter = normalized.includes("run_id = $");
      const skillId = hasSkillFilter ? String(values[2]) : undefined;
      const runId = hasRunFilter ? String(values[hasSkillFilter ? 3 : 2]) : undefined;
      const rows = [...this.rows.values()]
        .filter((row) => row.tenant_id === tenantId)
        .filter((row) => row.workspace_id === workspaceId)
        .filter((row) => !skillId || row.skill_id === skillId)
        .filter((row) => !runId || row.run_id === runId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.session_id.localeCompare(b.session_id));
      return result(rows as T[]);
    }
    throw new Error(`unexpected_query:${text}`);
  }
}

interface RuntimeSessionRowFake extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  runtime_id: string;
  organization_id: string;
  skill_id: string;
  run_id: string;
  actor_id: string;
  actor_type: "human" | "agent" | "service";
  workspace_url: string;
  workspace_origin: string;
  origin_allowlist: string[];
  status: "active" | "revoked" | "expired";
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  credential_id: string;
  credential_sha256: string;
  credential_expires_at: string;
  local_network_allowed: boolean;
  redact_screenshots: boolean;
  audit_event_refs: string[];
  evidence_refs: string[];
}

function rowFromValues(values: readonly unknown[]): RuntimeSessionRowFake {
  return {
    tenant_id: String(values[0]),
    workspace_id: String(values[1]),
    session_id: String(values[2]),
    runtime_id: String(values[3]),
    organization_id: String(values[4]),
    skill_id: String(values[5]),
    run_id: String(values[6]),
    actor_id: String(values[7]),
    actor_type: values[8] as RuntimeSessionRowFake["actor_type"],
    workspace_url: String(values[9]),
    workspace_origin: String(values[10]),
    origin_allowlist: [...(values[11] as string[])],
    status: values[12] as RuntimeSessionRowFake["status"],
    created_at: String(values[13]),
    expires_at: String(values[14]),
    revoked_at: values[15] ? String(values[15]) : null,
    revoked_reason: values[16] ? String(values[16]) : null,
    credential_id: String(values[17]),
    credential_sha256: String(values[18]),
    credential_expires_at: String(values[19]),
    local_network_allowed: Boolean(values[20]),
    redact_screenshots: Boolean(values[21]),
    audit_event_refs: [...(values[22] as string[])],
    evidence_refs: [...(values[23] as string[])],
  };
}

function result<T extends QueryResultRow>(rows: T[] | T | undefined): QueryResult<T> {
  const normalized = rows === undefined ? [] : Array.isArray(rows) ? rows : [rows];
  return {
    command: "SELECT",
    rowCount: normalized.length,
    oid: 0,
    fields: [],
    rows: normalized,
  };
}

function optionalRow<T extends QueryResultRow>(row: T | undefined): T[] {
  return row ? [row] : [];
}

function key(tenantId: string, workspaceId: string, sessionId: string): string {
  return `${tenantId}\u0000${workspaceId}\u0000${sessionId}`;
}

function runtimeSession(overrides: Partial<DojoHostedRuntimeSessionRecord> = {}): DojoHostedRuntimeSessionRecord {
  return {
    schema_version: "synthi.dojo.hostedRuntimeSession.v1",
    session_id: "session-a",
    runtime_id: "runtime-a",
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    run_id: "run-a",
    actor_id: "agent-a",
    actor_type: "agent",
    workspace_url: "https://workspace.example.test/app",
    workspace_origin: "https://workspace.example.test",
    origin_allowlist: ["https://workspace.example.test"],
    status: "active",
    created_at: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
    credential_id: "credential-a",
    credential_sha256: "a".repeat(64),
    credential_expires_at: "2026-06-11T00:05:00.000Z",
    egress_policy: {
      local_network_allowed: false,
    },
    redaction_policy: {
      screenshots: true,
    },
    audit_event_refs: ["audit-1"],
    evidence_refs: [],
    ...overrides,
  };
}
