import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildDojoSourceSnapshot, type DojoSourceSnapshot } from "../../src/dojo/source/source_snapshot.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import {
  appReleaseIdForSourceSnapshot,
  PostgresDojoSourceRegistryStore,
} from "../../src/dojo/store/postgres_source_registry_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoSourceRegistryStore", () => {
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
    workspaceId = "workspace_source_registry";
    await seedWorkspace(pool, tenantId, workspaceId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists verified app releases, source snapshots, source tokens, and audit events", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const store = new PostgresDojoSourceRegistryStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "source-registry-test", actor_type: "service" },
      request_id: "request-source-registry",
      correlation_id: "correlation-source-registry",
    });
    const snapshot = sourceSnapshot("2026.06.11");

    await store.saveSourceSnapshot(snapshot, {
      signing_keys_by_id: sourceSigningKeys(),
      source_map_sha256: "a".repeat(64),
      framework_adapter: "react",
      created_by: { actor_id: "source-capture-agent", actor_type: "agent" },
    });

    expect(await store.getSourceSnapshot(snapshot.snapshot_id)).toEqual(snapshot);
    expect(await store.listSourceSnapshots({ app_origin: snapshot.app_origin, app_version: snapshot.app_version })).toEqual([
      snapshot,
    ]);
    expect(await store.getAppRelease(appReleaseIdForSourceSnapshot(snapshot))).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      app_origin: snapshot.app_origin,
      app_version: snapshot.app_version,
      commit_sha: snapshot.commit_sha,
      framework_adapter: "react",
      source_map_sha256: "a".repeat(64),
      status: "active",
    }));
    expect(await store.listSourceTokens({ snapshot_id: snapshot.snapshot_id })).toEqual([
      expect.objectContaining({
        token_id: "save-button",
        route: "/invoices",
        stable_action_name: "saveInvoice",
        risk: "medium",
        proof_required: true,
        allowed_substrate: "source",
        compatibility_status: "current",
        token_json: expect.objectContaining({
          token_id: "save-button",
          release_key: `${snapshot.app_origin}@${snapshot.app_version}:${snapshot.commit_sha}:save-button`,
        }),
      }),
      expect.objectContaining({
        token_id: "total-field",
        route: "/invoices",
        stable_action_name: "total-field",
        risk: "safe",
        proof_required: false,
      }),
    ]);
    expect(await auditStore.listAuditEvents({ entity_kind: "source_snapshot" })).toEqual([
      expect.objectContaining({
        event_type: "source_contract_changed",
        entity_id: snapshot.snapshot_id,
        actor: { actor_id: "source-capture-agent", actor_type: "agent" },
        details: expect.objectContaining({
          app_release_id: appReleaseIdForSourceSnapshot(snapshot),
          source_token_ids: ["save-button", "total-field"],
        }),
      }),
    ]);
  });

  it("rejects tampered or unverified source snapshots before writing registry rows", async () => {
    const store = new PostgresDojoSourceRegistryStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const snapshot = sourceSnapshot("2026.06.11");
    const tampered: DojoSourceSnapshot = {
      ...snapshot,
      source_tokens: snapshot.source_tokens.map((token) =>
        token.token_id === "save-button"
          ? { ...token, source_locator: "src/routes/invoices/InvoiceForm.jsx:99" }
          : token
      ),
    };

    await expect(store.saveSourceSnapshot(tampered, {
      signing_keys_by_id: sourceSigningKeys(),
    })).rejects.toThrow(/dojo_postgres_source_snapshot_unverified/);
    await expect(store.saveSourceSnapshot(snapshot, {
      signing_keys_by_id: {},
    })).rejects.toThrow(/dojo_postgres_source_snapshot_unverified/);
    expect(await store.listSourceSnapshots()).toEqual([]);
    expect(await store.listSourceTokens()).toEqual([]);
  });

  it("enforces tenant and workspace boundaries for source registry reads", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedWorkspace(pool, otherTenantId, workspaceId);
    const tenantStore = new PostgresDojoSourceRegistryStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoSourceRegistryStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });
    const snapshot = sourceSnapshot("2026.06.11");

    await tenantStore.saveSourceSnapshot(snapshot, { signing_keys_by_id: sourceSigningKeys() });

    expect(await tenantStore.getSourceSnapshot(snapshot.snapshot_id)).toEqual(expect.objectContaining({
      snapshot_id: snapshot.snapshot_id,
    }));
    expect(await otherStore.getSourceSnapshot(snapshot.snapshot_id)).toBeNull();
    expect(await tenantStore.getSourceToken(snapshot.snapshot_id, "save-button")).toEqual(expect.objectContaining({
      token_id: "save-button",
    }));
    expect(await otherStore.getSourceToken(snapshot.snapshot_id, "save-button")).toBeNull();
  });

  it("rejects source snapshots with mismatched explicit tenant or workspace scope", async () => {
    const store = new PostgresDojoSourceRegistryStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const snapshot = sourceSnapshot("2026.06.11");

    await expect(store.saveSourceSnapshot({
      ...snapshot,
      tenant_id: `${tenantId}_other`,
    }, { signing_keys_by_id: sourceSigningKeys() })).rejects.toThrow("dojo_postgres_source_snapshot_tenant_mismatch");

    await expect(store.saveSourceSnapshot({
      ...snapshot,
      workspace_id: `${workspaceId}_other`,
    }, { signing_keys_by_id: sourceSigningKeys() })).rejects.toThrow("dojo_postgres_source_snapshot_workspace_mismatch");
  });

  function sourceSnapshot(appVersion: string): DojoSourceSnapshot {
    return buildDojoSourceSnapshot({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      app_origin: "https://app.example.test",
      app_version: appVersion,
      commit_sha: `commit-${appVersion}`,
      source_root: "C:\\repo\\synthi",
      signer_key_id: "source-key-a",
      signing_key: sourceSigningKey(),
      source_tokens: [
        {
          token_id: "total-field",
          route: "/invoices",
          component: "InvoiceForm",
          source_locator: "src\\routes\\invoices\\InvoiceForm.jsx:24",
          risk: "safe",
        },
        {
          token_id: "save-button",
          route: "/invoices",
          component: "InvoiceForm",
          action: "saveInvoice",
          source_locator: "src\\routes\\invoices\\InvoiceForm.jsx:42",
          risk: "mutation",
        },
      ],
      created_at: "2026-06-11T00:00:00.000Z",
    });
  }
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

function sourceSigningKeys(): Record<string, string> {
  return { "source-key-a": sourceSigningKey() };
}

function sourceSigningKey(): string {
  return "source-signing-secret-a";
}
