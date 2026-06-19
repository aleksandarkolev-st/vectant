import { describe, expect, it } from "vitest";
import {
  createDojoHostedRuntimeGatewayFromEnv,
  dojoControlPlanePostgresConnectionStringFromEnv,
} from "../../src/dojo/runtime/hosted_runtime_gateway_resolver.js";
import type {
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditStore,
} from "../../src/dojo/store/interfaces.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";

describe("Dojo hosted runtime gateway resolver", () => {
  it("uses an in-memory hosted runtime store for development compatibility", async () => {
    const audit = new MemoryAuditStore();
    const resolution = await createDojoHostedRuntimeGatewayFromEnv({
      env: {},
      audit_store: audit,
    });

    expect(resolution).toEqual(expect.objectContaining({
      ok: true,
      store_kind: "memory",
      production_capable: false,
    }));
    if (!resolution.ok) throw new Error("expected_hosted_runtime_gateway_resolution");
    const created = await resolution.gateway.createSession({
      tenant: tenant("tenant-a", "workspace-a"),
      skill_id: "skill-a",
      run_id: "run-a",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://workspace.example.test"],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(created.ok).toBe(true);
    expect(audit.events.map((event) => event.event_type)).toEqual(["runtime_session_created"]);
  });

  it("fails closed when production requires a durable control-plane store without a production-capable backend", async () => {
    const resolution = await createDojoHostedRuntimeGatewayFromEnv({
      env: {
        SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "1",
        SYNTHI_DOJO_REQUIRE_DURABLE_STORE: "1",
        SYNTHI_DOJO_STORE_FILE: "/var/lib/synthi/dojo.enc.json",
        SYNTHI_DOJO_STORE_KEY: "dojo-store-secret",
        SYNTHI_DOJO_STORE_SCOPE: "tenant-a:workspace-a",
      },
      audit_store: new MemoryAuditStore(),
    });

    expect(resolution).toEqual(expect.objectContaining({
      ok: false,
      store_kind: "encrypted_file",
      production_capable: false,
      configured_env: expect.arrayContaining([
        "SYNTHI_DOJO_REQUIRE_DURABLE_STORE",
        "SYNTHI_DOJO_STORE_FILE",
        "SYNTHI_DOJO_STORE_KEY",
        "SYNTHI_DOJO_STORE_SCOPE",
      ]),
      blocked_by: expect.arrayContaining([
        "hosted_runtime_control_plane_store_not_production_capable",
        "control_plane_store_encrypted_file_not_production_capable",
      ]),
    }));
  });

  it("resolves Postgres connection strings from explicit control-plane env", () => {
    expect(dojoControlPlanePostgresConnectionStringFromEnv({
      SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL: "postgres://dojo-control-plane",
    })).toBe("postgres://dojo-control-plane");
    expect(dojoControlPlanePostgresConnectionStringFromEnv({
      SYNTHI_DOJO_CONTROL_PLANE_STORE: "postgresql://dojo-control-plane",
    })).toBe("postgresql://dojo-control-plane");
    expect(dojoControlPlanePostgresConnectionStringFromEnv({
      SYNTHI_DOJO_CONTROL_PLANE_STORE: "postgres",
    })).toBeUndefined();
  });
});

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

function tenant(tenantId: string, workspaceId: string): DojoTenantContext {
  return {
    tenant_id: tenantId,
    organization_id: "org-a",
    workspace_id: workspaceId,
    actor_id: "agent-a",
    actor_type: "agent",
    roles: ["dojo:runtime"],
    request_id: `request-${tenantId}-${workspaceId}`,
    correlation_id: `correlation-${tenantId}-${workspaceId}`,
  };
}
