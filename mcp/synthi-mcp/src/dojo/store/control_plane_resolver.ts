import { Pool } from "pg";
import {
  DOJO_CONTROL_PLANE_POSTGRES_URL_ENV,
  DOJO_CONTROL_PLANE_STORE_ENV,
  resolveDojoControlPlaneStoreConfig,
  resolveDojoEnforcementConfig,
} from "../config/enforcement.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import { PostgresDojoAuditStore } from "./audit_store.js";
import { PostgresDojoGovernanceStore } from "./postgres_governance_store.js";
import { PostgresDojoLicenseStore } from "./postgres_license_store.js";
import {
  applyDojoPostgresMigrations,
  PostgresDojoProofStore,
  type DojoPostgresConnectable,
  type DojoPostgresQueryable,
} from "./postgres_proof_store.js";
import { PostgresDojoSkillStore } from "./postgres_skill_store.js";

export interface DojoControlPlaneStoreResolutionOptions {
  tenant: DojoTenantContext;
  env?: NodeJS.ProcessEnv;
  queryable?: DojoPostgresConnectable;
  apply_migrations?: boolean;
  app_origin?: string;
}

export type DojoControlPlaneStoreResolution =
  | {
    ok: true;
    store_kind: "postgres";
    production_capable: true;
    configured_env: string[];
    blocked_by: [];
    queryable: DojoPostgresQueryable;
    audit_store: PostgresDojoAuditStore;
    skill_store: PostgresDojoSkillStore;
    license_store: PostgresDojoLicenseStore;
    proof_store: PostgresDojoProofStore;
    governance_store: PostgresDojoGovernanceStore;
    close?: () => Promise<void>;
  }
  | {
    ok: false;
    store_kind: string;
    production_capable: boolean;
    configured_env: string[];
    blocked_by: string[];
  };

export async function createDojoControlPlaneStoresFromEnv(
  options: DojoControlPlaneStoreResolutionOptions
): Promise<DojoControlPlaneStoreResolution> {
  const env = options.env ?? process.env;
  const enforcement = resolveDojoEnforcementConfig(env);
  const storeConfig = resolveDojoControlPlaneStoreConfig(env);
  if (enforcement.production_enforcement && enforcement.require_durable_store && !storeConfig.production_capable) {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      production_capable: storeConfig.production_capable,
      configured_env: storeConfig.configured_env,
      blocked_by: ["control_plane_store_not_production_capable", ...storeConfig.blocked_by],
    };
  }
  if (storeConfig.store_kind !== "postgres" || !storeConfig.production_capable) {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      production_capable: storeConfig.production_capable,
      configured_env: storeConfig.configured_env,
      blocked_by: ["control_plane_postgres_store_required", ...storeConfig.blocked_by],
    };
  }

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

  const queryable = options.queryable ?? new Pool({ connectionString });
  if (options.apply_migrations !== false) {
    await applyDojoPostgresMigrations(queryable);
  }
  await ensureDojoTenantWorkspace({
    queryable,
    tenant: options.tenant,
    app_origin: options.app_origin,
  });

  const auditStore = new PostgresDojoAuditStore({
    tenant_id: options.tenant.tenant_id,
    workspace_id: options.tenant.workspace_id,
    queryable,
  });
  const actor = {
    actor_id: options.tenant.actor_id,
    actor_type: options.tenant.actor_type,
  };
  const baseStoreOptions = {
    tenant_id: options.tenant.tenant_id,
    workspace_id: options.tenant.workspace_id,
    queryable,
    audit_store: auditStore,
    audit_actor: actor,
    request_id: options.tenant.request_id,
    correlation_id: options.tenant.correlation_id,
  };

  return {
    ok: true,
    store_kind: "postgres",
    production_capable: true,
    configured_env: storeConfig.configured_env,
    blocked_by: [],
    queryable,
    audit_store: auditStore,
    skill_store: new PostgresDojoSkillStore(baseStoreOptions),
    license_store: new PostgresDojoLicenseStore(baseStoreOptions),
    proof_store: new PostgresDojoProofStore(baseStoreOptions),
    governance_store: new PostgresDojoGovernanceStore(baseStoreOptions),
    close: options.queryable ? undefined : async () => {
      if ("end" in queryable && typeof queryable.end === "function") {
        await queryable.end();
      }
    },
  };
}

export async function ensureDojoTenantWorkspace(input: {
  queryable: DojoPostgresQueryable;
  tenant: DojoTenantContext;
  app_origin?: string;
}): Promise<void> {
  const tenant = input.tenant;
  await input.queryable.query(
    `INSERT INTO dojo_tenants (
      tenant_id,
      organization_id,
      display_name,
      data_region
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET
      organization_id = COALESCE(EXCLUDED.organization_id, dojo_tenants.organization_id),
      data_region = COALESCE(EXCLUDED.data_region, dojo_tenants.data_region),
      updated_at = now()`,
    [
      tenant.tenant_id,
      tenant.organization_id,
      tenant.tenant_id,
      tenant.data_region ?? null,
    ]
  );
  await input.queryable.query(
    `INSERT INTO dojo_workspaces (
      tenant_id,
      workspace_id,
      organization_id,
      app_origin,
      data_region
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET
      organization_id = COALESCE(EXCLUDED.organization_id, dojo_workspaces.organization_id),
      app_origin = COALESCE(EXCLUDED.app_origin, dojo_workspaces.app_origin),
      data_region = COALESCE(EXCLUDED.data_region, dojo_workspaces.data_region),
      updated_at = now()`,
    [
      tenant.tenant_id,
      tenant.workspace_id,
      tenant.organization_id,
      input.app_origin ?? null,
      tenant.data_region ?? null,
    ]
  );
}

export function dojoControlPlanePostgresConnectionStringFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const explicit = nonEmpty(env[DOJO_CONTROL_PLANE_POSTGRES_URL_ENV]);
  if (explicit) return explicit;
  const store = nonEmpty(env[DOJO_CONTROL_PLANE_STORE_ENV]);
  if (store && isPostgresUrl(store)) return store;
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPostgresUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://");
}
