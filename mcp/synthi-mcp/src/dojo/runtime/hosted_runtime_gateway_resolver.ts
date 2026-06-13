import { Pool } from "pg";
import {
  DOJO_REQUIRE_DURABLE_STORE_ENV,
  resolveDojoControlPlaneStoreConfig,
  resolveDojoEnforcementConfig,
} from "../config/enforcement.js";
import type { DojoAuditEventInput, DojoAuditEventListFilter, DojoAuditEventRecord, DojoAuditStore } from "../store/interfaces.js";
import { PostgresDojoAuditStore } from "../store/audit_store.js";
import {
  applyDojoPostgresMigrations,
  type DojoPostgresConnectable,
  type DojoPostgresQueryable,
} from "../store/postgres_proof_store.js";
import { dojoControlPlanePostgresConnectionStringFromEnv } from "../store/control_plane_resolver.js";
export { dojoControlPlanePostgresConnectionStringFromEnv } from "../store/control_plane_resolver.js";
import {
  createInProcessDojoHostedRuntimeGateway,
  InMemoryDojoHostedRuntimeSessionStore,
  type DojoHostedRuntimeEvidenceWriter,
  type DojoHostedRuntimeGateway,
  type DojoHostedRuntimeSessionRecord,
  type DojoHostedRuntimeSessionStore,
} from "./hosted_runtime_gateway.js";
import { PostgresDojoHostedRuntimeSessionStore } from "./postgres_hosted_runtime_store.js";

export interface DojoHostedRuntimeGatewayResolverOptions {
  env?: NodeJS.ProcessEnv;
  audit_store: DojoAuditStore;
  evidence_writer?: DojoHostedRuntimeEvidenceWriter;
  queryable?: DojoPostgresConnectable;
  apply_migrations?: boolean;
}

export type DojoHostedRuntimeGatewayResolution =
  | {
    ok: true;
    gateway: DojoHostedRuntimeGateway;
    store_kind: "memory" | "postgres";
    production_capable: boolean;
    configured_env: string[];
    blocked_by: string[];
    close?: () => Promise<void>;
  }
  | {
    ok: false;
    store_kind: string;
    production_capable: boolean;
    configured_env: string[];
    blocked_by: string[];
  };

export async function createDojoHostedRuntimeGatewayFromEnv(
  options: DojoHostedRuntimeGatewayResolverOptions
): Promise<DojoHostedRuntimeGatewayResolution> {
  const env = options.env ?? process.env;
  const enforcement = resolveDojoEnforcementConfig(env);
  const storeConfig = resolveDojoControlPlaneStoreConfig(env);
  const requiresProductionStore = enforcement.production_enforcement && enforcement.require_durable_store;
  if (requiresProductionStore && !storeConfig.production_capable) {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      production_capable: false,
      configured_env: [
        ...(enforcement.require_durable_store ? [DOJO_REQUIRE_DURABLE_STORE_ENV] : []),
        ...storeConfig.configured_env,
      ],
      blocked_by: [
        "hosted_runtime_control_plane_store_not_production_capable",
        ...storeConfig.blocked_by,
      ],
    };
  }

  if (storeConfig.store_kind === "postgres" && storeConfig.production_capable) {
    const connectionString = options.queryable ? undefined : dojoControlPlanePostgresConnectionStringFromEnv(env);
    if (!options.queryable && !connectionString) {
      return {
        ok: false,
        store_kind: "postgres",
        production_capable: false,
        configured_env: storeConfig.configured_env,
        blocked_by: ["control_plane_postgres_url_missing"],
      };
    }
    const pool = options.queryable ?? new Pool({ connectionString });
    if (options.apply_migrations !== false) {
      await applyDojoPostgresMigrations(pool);
    }
    const postgresAuditStore = new RoutedPostgresDojoAuditStore(pool);
    const auditStore = new MirroredDojoAuditStore(options.audit_store, postgresAuditStore);
    const gateway = createInProcessDojoHostedRuntimeGateway({
      audit_store: auditStore,
      store: new RoutedPostgresDojoHostedRuntimeSessionStore(pool),
      evidence_writer: options.evidence_writer,
    });
    return {
      ok: true,
      gateway,
      store_kind: "postgres",
      production_capable: true,
      configured_env: storeConfig.configured_env,
      blocked_by: [],
      close: options.queryable ? undefined : async () => {
        if ("end" in pool && typeof pool.end === "function") {
          await pool.end();
        }
      },
    };
  }

  return {
    ok: true,
    gateway: createInProcessDojoHostedRuntimeGateway({
      audit_store: options.audit_store,
      store: new InMemoryDojoHostedRuntimeSessionStore(),
      evidence_writer: options.evidence_writer,
    }),
    store_kind: "memory",
    production_capable: false,
    configured_env: storeConfig.configured_env,
    blocked_by: storeConfig.blocked_by,
  };
}

class RoutedPostgresDojoHostedRuntimeSessionStore implements DojoHostedRuntimeSessionStore {
  constructor(private readonly queryable: DojoPostgresQueryable) {}

  saveSession(record: DojoHostedRuntimeSessionRecord): Promise<DojoHostedRuntimeSessionRecord> {
    return this.store(record.tenant_id, record.workspace_id).saveSession(record);
  }

  getSession(input: {
    tenant_id: string;
    workspace_id: string;
    session_id: string;
  }): Promise<DojoHostedRuntimeSessionRecord | null> {
    return this.store(input.tenant_id, input.workspace_id).getSession(input);
  }

  updateSession(record: DojoHostedRuntimeSessionRecord): Promise<DojoHostedRuntimeSessionRecord> {
    return this.store(record.tenant_id, record.workspace_id).updateSession(record);
  }

  listSessions(input: {
    tenant_id: string;
    workspace_id: string;
    skill_id?: string;
    run_id?: string;
  }): Promise<DojoHostedRuntimeSessionRecord[]> {
    return this.store(input.tenant_id, input.workspace_id).listSessions(input);
  }

  private store(tenantId: string, workspaceId: string): PostgresDojoHostedRuntimeSessionStore {
    return new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: this.queryable,
    });
  }
}

class RoutedPostgresDojoAuditStore implements DojoAuditStore {
  constructor(private readonly queryable: DojoPostgresQueryable) {}

  appendAuditEvent(event: DojoAuditEventInput): Promise<DojoAuditEventRecord> {
    return this.store(event.tenant_id, event.workspace_id).appendAuditEvent(event);
  }

  listAuditEvents(_filter: DojoAuditEventListFilter = {}): Promise<DojoAuditEventRecord[]> {
    throw new Error("dojo_routed_postgres_audit_store_list_requires_tenant_scope");
  }

  private store(tenantId: string, workspaceId: string): PostgresDojoAuditStore {
    return new PostgresDojoAuditStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: this.queryable,
    });
  }
}

class MirroredDojoAuditStore implements DojoAuditStore {
  constructor(
    private readonly primary: DojoAuditStore,
    private readonly mirror: DojoAuditStore
  ) {}

  async appendAuditEvent(event: DojoAuditEventInput): Promise<DojoAuditEventRecord> {
    const primary = await this.primary.appendAuditEvent(event);
    await this.mirror.appendAuditEvent({
      ...event,
      audit_event_id: primary.audit_event_id,
      created_at: primary.created_at,
    });
    return primary;
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): Promise<DojoAuditEventRecord[]> | DojoAuditEventRecord[] {
    return this.primary.listAuditEvents(filter);
  }
}
