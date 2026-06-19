import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  verifyDojoSourceSnapshot,
  type DojoSourceSnapshot,
  type DojoSourceTokenSnapshot,
} from "../source/source_snapshot.js";
import type {
  DojoAppReleaseRecord,
  DojoAuditActor,
  DojoAuditStore,
  DojoSourceContractStore,
  DojoSourceSnapshotListFilter,
  DojoSourceTokenListFilter,
  DojoStoredSourceRisk,
  DojoStoredSourceSubstrate,
  DojoStoredSourceTokenRecord,
} from "./interfaces.js";
import type {
  DojoPostgresClient,
  DojoPostgresConnectable,
  DojoPostgresQueryable,
} from "./postgres_proof_store.js";

export interface PostgresDojoSourceRegistryStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresConnectable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

export interface DojoSourceSnapshotSaveOptions {
  signing_keys_by_id: Record<string, string>;
  source_map_sha256?: string;
  framework_adapter?: string;
  created_by?: DojoAuditActor;
}

interface SourceSnapshotRow extends QueryResultRow {
  snapshot_json: unknown;
}

interface SourceTokenRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  snapshot_id: string;
  token_id: string;
  component_path: string;
  route: string | null;
  stable_action_name: string | null;
  source_locator: string;
  risk: DojoStoredSourceRisk;
  proof_required: boolean;
  allowed_substrate: DojoStoredSourceSubstrate;
  compatibility_status: DojoStoredSourceTokenRecord["compatibility_status"];
  token_json: unknown;
  created_at: Date | string;
}

interface AppReleaseRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  app_release_id: string;
  app_origin: string;
  app_version: string;
  commit_sha: string | null;
  source_map_sha256: string | null;
  framework_adapter: string | null;
  status: DojoAppReleaseRecord["status"];
  created_at: Date | string;
  created_by: string | null;
}

export class PostgresDojoSourceRegistryStore implements DojoSourceContractStore {
  readonly store_contract_kind = "source_contract" as const;

  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresConnectable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoSourceRegistryStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-source-registry-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-source-registry-store";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async saveSourceSnapshot(
    snapshot: DojoSourceSnapshot,
    options: DojoSourceSnapshotSaveOptions
  ): Promise<DojoSourceSnapshot> {
    this.assertSnapshotScope(snapshot);
    const verification = verifyDojoSourceSnapshot(snapshot, { signing_keys_by_id: options.signing_keys_by_id });
    if (!verification.ok) {
      throw new Error(`dojo_postgres_source_snapshot_unverified:${verification.blocked_by.join(",")}`);
    }
    const appRelease = appReleaseRecordForSnapshot(snapshot, {
      source_map_sha256: options.source_map_sha256,
      framework_adapter: options.framework_adapter,
      created_by: options.created_by?.actor_id ?? this.auditActor.actor_id,
    });
    await this.withWriteTransaction(async (client) => {
      await upsertAppRelease(client, appRelease);
      await client.query(
        `INSERT INTO dojo_source_snapshots (
          tenant_id,
          workspace_id,
          snapshot_id,
          app_release_id,
          app_origin,
          app_version,
          commit_sha,
          source_map_sha256,
          snapshot_sha256,
          signer_key_id,
          signature,
          snapshot_json,
          created_at,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::timestamptz, $14)
        ON CONFLICT (tenant_id, workspace_id, snapshot_id) DO UPDATE SET
          app_release_id = EXCLUDED.app_release_id,
          app_origin = EXCLUDED.app_origin,
          app_version = EXCLUDED.app_version,
          commit_sha = EXCLUDED.commit_sha,
          source_map_sha256 = EXCLUDED.source_map_sha256,
          snapshot_sha256 = EXCLUDED.snapshot_sha256,
          signer_key_id = EXCLUDED.signer_key_id,
          signature = EXCLUDED.signature,
          snapshot_json = EXCLUDED.snapshot_json,
          created_by = EXCLUDED.created_by`,
        [
          this.tenantId,
          this.workspaceId,
          snapshot.snapshot_id,
          appRelease.app_release_id,
          snapshot.app_origin,
          snapshot.app_version,
          snapshot.commit_sha,
          options.source_map_sha256 ?? null,
          snapshot.snapshot_hash,
          snapshot.signer_key_id,
          snapshot.snapshot_signature,
          JSON.stringify(snapshot),
          snapshot.created_at,
          options.created_by?.actor_id ?? this.auditActor.actor_id,
        ]
      );
      await client.query(
        `DELETE FROM dojo_source_tokens
        WHERE tenant_id = $1 AND workspace_id = $2 AND snapshot_id = $3`,
        [this.tenantId, this.workspaceId, snapshot.snapshot_id]
      );
      for (const token of snapshot.source_tokens) {
        const stored = sourceTokenRecordForSnapshot(snapshot, token);
        await client.query(
          `INSERT INTO dojo_source_tokens (
            tenant_id,
            workspace_id,
            snapshot_id,
            token_id,
            component_path,
            route,
            stable_action_name,
            source_locator,
            risk,
            proof_required,
            allowed_substrate,
            compatibility_status,
            token_json,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz)`,
          [
            stored.tenant_id,
            stored.workspace_id,
            stored.snapshot_id,
            stored.token_id,
            stored.component_path,
            stored.route,
            stored.stable_action_name,
            stored.source_locator,
            stored.risk,
            stored.proof_required,
            stored.allowed_substrate,
            stored.compatibility_status,
            JSON.stringify(stored.token_json),
            stored.created_at,
          ]
        );
      }
    });
    const saved = await this.getSourceSnapshot(snapshot.snapshot_id);
    if (!saved) throw new Error("dojo_postgres_source_snapshot_save_failed");
    await this.appendSourceContractAudit(saved, appRelease, options.created_by);
    return saved;
  }

  async getSourceSnapshot(snapshotId: string): Promise<DojoSourceSnapshot | null> {
    const result = await this.queryable.query<SourceSnapshotRow>(
      `SELECT snapshot_json
      FROM dojo_source_snapshots
      WHERE tenant_id = $1 AND workspace_id = $2 AND snapshot_id = $3`,
      [this.tenantId, this.workspaceId, snapshotId]
    );
    return result.rows[0] ? normalizeJsonObject<DojoSourceSnapshot>(result.rows[0].snapshot_json) : null;
  }

  async listSourceSnapshots(filter: DojoSourceSnapshotListFilter = {}): Promise<DojoSourceSnapshot[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "app_release_id", filter.app_release_id);
    addOptionalPredicate(predicates, values, "app_origin", filter.app_origin);
    addOptionalPredicate(predicates, values, "app_version", filter.app_version);
    addOptionalPredicate(predicates, values, "commit_sha", filter.commit_sha);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<SourceSnapshotRow>(
      `SELECT snapshot_json
      FROM dojo_source_snapshots
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, snapshot_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => normalizeJsonObject<DojoSourceSnapshot>(row.snapshot_json));
  }

  async getAppRelease(appReleaseId: string): Promise<DojoAppReleaseRecord | null> {
    const result = await this.queryable.query<AppReleaseRow>(
      `SELECT tenant_id, workspace_id, app_release_id, app_origin, app_version, commit_sha,
        source_map_sha256, framework_adapter, status, created_at, created_by
      FROM dojo_app_releases
      WHERE tenant_id = $1 AND workspace_id = $2 AND app_release_id = $3`,
      [this.tenantId, this.workspaceId, appReleaseId]
    );
    return rowToAppRelease(result.rows[0]);
  }

  async getSourceToken(snapshotId: string, tokenId: string): Promise<DojoStoredSourceTokenRecord | null> {
    const result = await this.queryable.query<SourceTokenRow>(
      `SELECT tenant_id, workspace_id, snapshot_id, token_id, component_path, route,
        stable_action_name, source_locator, risk, proof_required, allowed_substrate,
        compatibility_status, token_json, created_at
      FROM dojo_source_tokens
      WHERE tenant_id = $1 AND workspace_id = $2 AND snapshot_id = $3 AND token_id = $4`,
      [this.tenantId, this.workspaceId, snapshotId, tokenId]
    );
    return rowToSourceToken(result.rows[0]);
  }

  async listSourceTokens(filter: DojoSourceTokenListFilter = {}): Promise<DojoStoredSourceTokenRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "snapshot_id", filter.snapshot_id);
    addOptionalPredicate(predicates, values, "token_id", filter.token_id);
    addOptionalPredicate(predicates, values, "route", filter.route);
    addOptionalPredicate(predicates, values, "stable_action_name", filter.stable_action_name);
    addOptionalPredicate(predicates, values, "risk", filter.risk);
    addOptionalPredicate(predicates, values, "allowed_substrate", filter.allowed_substrate);
    addOptionalPredicate(predicates, values, "compatibility_status", filter.compatibility_status);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<SourceTokenRow>(
      `SELECT tenant_id, workspace_id, snapshot_id, token_id, component_path, route,
        stable_action_name, source_locator, risk, proof_required, allowed_substrate,
        compatibility_status, token_json, created_at
      FROM dojo_source_tokens
      WHERE ${predicates.join(" AND ")}
      ORDER BY snapshot_id ASC, token_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToSourceToken).filter((record): record is DojoStoredSourceTokenRecord => record !== null);
  }

  private async withWriteTransaction<T>(operation: (client: DojoPostgresQueryable) => Promise<T>): Promise<T> {
    if (!this.queryable.connect) return operation(this.queryable);
    const client: DojoPostgresClient = await this.queryable.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release?.();
    }
  }

  private assertSnapshotScope(snapshot: DojoSourceSnapshot): void {
    if (snapshot.tenant_id !== this.tenantId) throw new Error("dojo_postgres_source_snapshot_tenant_mismatch");
    if (snapshot.workspace_id !== this.workspaceId) throw new Error("dojo_postgres_source_snapshot_workspace_mismatch");
  }

  private async appendSourceContractAudit(
    snapshot: DojoSourceSnapshot,
    appRelease: DojoAppReleaseRecord,
    actor?: DojoAuditActor
  ): Promise<void> {
    if (!this.auditStore) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: actor ?? this.auditActor,
      event_type: "source_contract_changed",
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "source_snapshot",
      entity_id: snapshot.snapshot_id,
      details: {
        app_release_id: appRelease.app_release_id,
        app_origin: snapshot.app_origin,
        app_version: snapshot.app_version,
        commit_sha: snapshot.commit_sha,
        snapshot_hash: snapshot.snapshot_hash,
        source_token_ids: snapshot.source_token_ids,
      },
    });
  }
}

export function appReleaseIdForSourceSnapshot(snapshot: Pick<
  DojoSourceSnapshot,
  "tenant_id" | "workspace_id" | "app_origin" | "app_version"
>): string {
  return `apprel_${shortHash([
    snapshot.tenant_id,
    snapshot.workspace_id,
    snapshot.app_origin,
    snapshot.app_version,
  ].join("\u0000"))}`;
}

export function sourceSnapshotRiskToStoredRisk(risk: DojoSourceTokenSnapshot["risk"]): DojoStoredSourceRisk {
  if (risk === "mutation") return "medium";
  if (risk === "dangerous") return "high";
  return "safe";
}

function appReleaseRecordForSnapshot(
  snapshot: DojoSourceSnapshot,
  options: {
    source_map_sha256?: string;
    framework_adapter?: string;
    created_by?: string;
  }
): DojoAppReleaseRecord {
  return {
    tenant_id: snapshot.tenant_id,
    workspace_id: snapshot.workspace_id,
    app_release_id: appReleaseIdForSourceSnapshot(snapshot),
    app_origin: snapshot.app_origin,
    app_version: snapshot.app_version,
    commit_sha: snapshot.commit_sha,
    ...(options.source_map_sha256 ? { source_map_sha256: options.source_map_sha256 } : {}),
    ...(options.framework_adapter ? { framework_adapter: options.framework_adapter } : {}),
    status: "active",
    created_at: snapshot.created_at,
    ...(options.created_by ? { created_by: options.created_by } : {}),
  };
}

async function upsertAppRelease(
  queryable: DojoPostgresQueryable,
  release: DojoAppReleaseRecord
): Promise<void> {
  await queryable.query(
    `INSERT INTO dojo_app_releases (
      tenant_id,
      workspace_id,
      app_release_id,
      app_origin,
      app_version,
      commit_sha,
      source_map_sha256,
      framework_adapter,
      status,
      release_json,
      created_at,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $12)
    ON CONFLICT (tenant_id, workspace_id, app_origin, app_version) DO UPDATE SET
      commit_sha = EXCLUDED.commit_sha,
      source_map_sha256 = EXCLUDED.source_map_sha256,
      framework_adapter = EXCLUDED.framework_adapter,
      status = EXCLUDED.status,
      release_json = EXCLUDED.release_json`,
    [
      release.tenant_id,
      release.workspace_id,
      release.app_release_id,
      release.app_origin,
      release.app_version,
      release.commit_sha,
      release.source_map_sha256 ?? null,
      release.framework_adapter ?? null,
      release.status,
      JSON.stringify(release),
      release.created_at,
      release.created_by ?? null,
    ]
  );
}

function sourceTokenRecordForSnapshot(
  snapshot: DojoSourceSnapshot,
  token: DojoSourceTokenSnapshot
): DojoStoredSourceTokenRecord {
  const risk = sourceSnapshotRiskToStoredRisk(token.risk);
  return {
    tenant_id: snapshot.tenant_id,
    workspace_id: snapshot.workspace_id,
    snapshot_id: snapshot.snapshot_id,
    token_id: token.token_id,
    component_path: componentPathFromSourceLocator(token.source_locator),
    route: token.route,
    stable_action_name: token.action ?? token.token_id,
    source_locator: token.source_locator,
    risk,
    proof_required: risk !== "safe",
    allowed_substrate: "source",
    compatibility_status: "current",
    token_json: {
      ...token,
      release_key: `${snapshot.app_origin}@${snapshot.app_version}:${snapshot.commit_sha}:${token.token_id}`,
    },
    created_at: snapshot.created_at,
  };
}

function rowToAppRelease(row: AppReleaseRow | undefined): DojoAppReleaseRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    app_release_id: row.app_release_id,
    app_origin: row.app_origin,
    app_version: row.app_version,
    commit_sha: row.commit_sha ?? "",
    ...(row.source_map_sha256 ? { source_map_sha256: row.source_map_sha256 } : {}),
    ...(row.framework_adapter ? { framework_adapter: row.framework_adapter } : {}),
    status: row.status,
    created_at: iso(row.created_at),
    ...(row.created_by ? { created_by: row.created_by } : {}),
  };
}

function rowToSourceToken(row: SourceTokenRow | undefined): DojoStoredSourceTokenRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    snapshot_id: row.snapshot_id,
    token_id: row.token_id,
    component_path: row.component_path,
    route: row.route ?? "",
    stable_action_name: row.stable_action_name ?? row.token_id,
    source_locator: row.source_locator,
    risk: row.risk,
    proof_required: row.proof_required,
    allowed_substrate: row.allowed_substrate,
    compatibility_status: row.compatibility_status,
    token_json: normalizeJsonObject<Record<string, unknown>>(row.token_json),
    created_at: iso(row.created_at),
  };
}

function addOptionalPredicate(
  predicates: string[],
  values: unknown[],
  column: string,
  value: string | undefined
): void {
  if (!value) return;
  values.push(value);
  predicates.push(`${column} = $${values.length}`);
}

function componentPathFromSourceLocator(sourceLocator: string): string {
  return sourceLocator.replace(/:\d+(?::\d+)?$/, "");
}

function normalizeJsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedLimit(value: number | undefined): number {
  return Number.isFinite(value) && typeof value === "number" && value > 0
    ? Math.max(1, Math.min(Math.floor(value), 500))
    : 100;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_source_registry_${field}_required`);
  return trimmed;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
