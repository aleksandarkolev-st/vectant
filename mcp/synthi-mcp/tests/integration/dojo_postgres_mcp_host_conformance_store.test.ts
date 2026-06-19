import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import {
  PostgresDojoMcpHostConformanceStore,
  conformanceResultIdForReport,
  hostKindForMcpConformanceHost,
  reportSha256ForConformanceReport,
} from "../../src/dojo/store/postgres_mcp_host_conformance_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoMcpHostConformanceStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_mcp_host_conformance";
    await seedWorkspace(pool, tenantId, workspaceId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists conformance reports with digest custody and audit events", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoMcpHostConformanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "release-operator", actor_type: "service" },
      request_id: "request-mcp-host-conformance",
      correlation_id: "correlation-mcp-host-conformance",
    });
    const report = conformanceReportFixture({
      host_url: "https://mcp.example.test/mcp",
      release_gate_ok: true,
    });
    const createdAt = "2026-06-11T00:00:00.000Z";
    const expectedDigest = reportSha256ForConformanceReport(report);

    const saved = await store.saveConformanceResult({
      host_url: "https://mcp.example.test/mcp",
      status: "passed",
      report_json: report,
      report_sha256: `sha256:${expectedDigest}`,
      created_at: createdAt,
      created_by: "release-operator",
    });

    expect(saved).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      conformance_result_id: conformanceResultIdForReport({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        host_url: "https://mcp.example.test/mcp",
        created_at: createdAt,
        report_sha256: expectedDigest,
      }),
      host_kind: "deployed_non_loopback",
      status: "passed",
      report_sha256: expectedDigest,
      report_json: expect.objectContaining({
        schema_version: "synthi.dojo.mcpHostConformance.release.v1",
        release_gate: expect.objectContaining({ ok: true }),
      }),
    }));
    expect(await store.getConformanceResult(saved.conformance_result_id)).toEqual(saved);
    expect(await auditStore.listAuditEvents({ entity_kind: "mcp_host_conformance_result" })).toEqual([
      expect.objectContaining({
        event_type: "mcp_host_conformance_recorded",
        entity_id: saved.conformance_result_id,
        details: expect.objectContaining({
          host_kind: "deployed_non_loopback",
          status: "passed",
          report_sha256: expectedDigest,
        }),
      }),
    ]);
  });

  it("filters conformance reports by host kind and status", async () => {
    const store = new PostgresDojoMcpHostConformanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const passed = await store.saveConformanceResult({
      conformance_result_id: "conf_remote_passed",
      host_url: "https://mcp.example.test/mcp",
      status: "passed",
      report_json: conformanceReportFixture({ host_url: "https://mcp.example.test/mcp", release_gate_ok: true }),
      created_at: "2026-06-11T00:02:00.000Z",
      created_by: "release-operator",
    });
    const failed = await store.saveConformanceResult({
      conformance_result_id: "conf_remote_failed",
      host_url: "https://mcp.example.test/mcp",
      status: "failed",
      report_json: conformanceReportFixture({ host_url: "https://mcp.example.test/mcp", release_gate_ok: false }),
      created_at: "2026-06-11T00:01:00.000Z",
      created_by: "release-operator",
    });
    const local = await store.saveConformanceResult({
      conformance_result_id: "conf_local_skipped",
      host_url: "http://127.0.0.1:3000/mcp",
      status: "skipped",
      report_json: conformanceReportFixture({ host_url: "http://127.0.0.1:3000/mcp", release_gate_ok: false }),
      created_at: "2026-06-11T00:03:00.000Z",
      created_by: "dev-operator",
    });

    expect(await store.listConformanceResults({ host_kind: "deployed_non_loopback" })).toEqual([
      expect.objectContaining({ conformance_result_id: passed.conformance_result_id }),
      expect.objectContaining({ conformance_result_id: failed.conformance_result_id }),
    ]);
    expect(await store.listConformanceResults({ status: "skipped" })).toEqual([
      expect.objectContaining({ conformance_result_id: local.conformance_result_id }),
    ]);
    expect(await store.listConformanceResults({ created_by: "release-operator", limit: 1 })).toEqual([
      expect.objectContaining({ conformance_result_id: passed.conformance_result_id }),
    ]);
  });

  it("rejects digest mismatch and false host-kind claims before persistence", async () => {
    const store = new PostgresDojoMcpHostConformanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const report = conformanceReportFixture({ host_url: "https://mcp.example.test/mcp", release_gate_ok: true });

    await expect(store.saveConformanceResult({
      host_url: "https://mcp.example.test/mcp",
      status: "passed",
      report_json: report,
      report_sha256: "0".repeat(64),
    })).rejects.toThrow("dojo_postgres_mcp_host_conformance_report_digest_mismatch");

    await expect(store.saveConformanceResult({
      host_url: "http://127.0.0.1:3000/mcp",
      host_kind: "deployed_non_loopback",
      status: "passed",
      report_json: report,
    })).rejects.toThrow("dojo_postgres_mcp_host_conformance_host_kind_mismatch");
  });

  it("enforces tenant boundaries for conformance results", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedWorkspace(pool, otherTenantId, workspaceId);
    const tenantStore = new PostgresDojoMcpHostConformanceStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoMcpHostConformanceStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    const saved = await tenantStore.saveConformanceResult({
      conformance_result_id: "conf_tenant_isolated",
      host_url: "https://mcp.example.test/mcp",
      status: "passed",
      report_json: conformanceReportFixture({ host_url: "https://mcp.example.test/mcp", release_gate_ok: true }),
      created_at: "2026-06-11T00:04:00.000Z",
      created_by: "release-operator",
    });

    expect(await tenantStore.getConformanceResult(saved.conformance_result_id)).toEqual(expect.objectContaining({
      conformance_result_id: saved.conformance_result_id,
    }));
    expect(await otherStore.getConformanceResult(saved.conformance_result_id)).toBeNull();
    expect(await otherStore.listConformanceResults({ host_url: "https://mcp.example.test/mcp" })).toEqual([]);
  });

  it("classifies host URLs into schema host kinds without treating loopback as deployed", () => {
    expect(hostKindForMcpConformanceHost("http://127.0.0.1:3000/mcp")).toBe("local_loopback");
    expect(hostKindForMcpConformanceHost("http://localhost:3000/mcp")).toBe("local_loopback");
    expect(hostKindForMcpConformanceHost("https://mcp.example.test/mcp")).toBe("deployed_non_loopback");
  });
});

async function seedWorkspace(pool: Pool, tenantId: string, workspaceId: string): Promise<void> {
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
}

function conformanceReportFixture(input: {
  host_url: string;
  release_gate_ok: boolean;
}): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.mcpHostConformance.release.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    conformance: {
      ok: input.release_gate_ok,
      mcp_host_class: input.host_url.includes("127.0.0.1") ? "loopback" : "remote",
      non_loopback_mcp_host: !input.host_url.includes("127.0.0.1"),
    },
    config: {
      mcp_host_url: input.host_url,
      execute_production: true,
      raw_backing_tool_required: true,
    },
    release_gate: {
      ok: input.release_gate_ok,
      failed: input.release_gate_ok ? 0 : 1,
    },
    steps: [
      { name: "initialize", ok: true },
      { name: "proof-gated Dojo skill", ok: input.release_gate_ok },
    ],
  };
}
