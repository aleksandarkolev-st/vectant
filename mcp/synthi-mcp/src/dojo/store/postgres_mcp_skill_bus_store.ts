import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  dojoMcpManifestRequiresProof,
  validateDojoMcpSkillManifest,
  type DojoMcpSkillManifestV1,
} from "../mcp/manifest_signing.js";
import type {
  DojoAuditActor,
  DojoAuditStore,
  DojoMcpDirectCallPolicy,
  DojoMcpToolInvocationFilter,
  DojoMcpToolInvocationRecord,
  DojoMcpToolRegistrationFilter,
  DojoMcpToolRegistrationRecord,
  DojoMcpToolRegistrationStatus,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoMcpSkillBusStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SaveDojoMcpToolRegistrationOptions {
  status?: DojoMcpToolRegistrationStatus;
  registered_at?: string;
}

export interface RecordDojoMcpToolInvocationInput {
  invocation_id: string;
  tool_registration_id?: string;
  tool_name: string;
  tool_version?: string;
  skill_id?: string;
  actor: DojoAuditActor;
  requested_action: string;
  status: DojoMcpToolInvocationRecord["status"];
  proof_capsule_id?: string;
  audit_event_id?: string;
  invocation_json?: Record<string, unknown>;
  created_at?: string;
}

interface ToolRegistrationRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  tool_registration_id: string;
  tool_name: string;
  tool_version: string;
  skill_id: string;
  license_id: string | null;
  manifest_digest: string;
  signed_manifest: string;
  proof_required: boolean;
  direct_call_policy: DojoMcpDirectCallPolicy;
  status: DojoMcpToolRegistrationRecord["status"];
  registered_at: Date | string;
  revoked_at: Date | string | null;
  manifest_json: unknown;
}

interface ToolInvocationRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  invocation_id: string;
  tool_registration_id: string | null;
  tool_name: string;
  tool_version: string | null;
  skill_id: string | null;
  actor_id: string;
  actor_type: DojoAuditActor["actor_type"];
  requested_action: string;
  status: DojoMcpToolInvocationRecord["status"];
  proof_capsule_id: string | null;
  audit_event_id: string | null;
  invocation_json: unknown;
  created_at: Date | string;
}

export class PostgresDojoMcpSkillBusStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: PostgresDojoMcpSkillBusStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-mcp-skill-bus-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-mcp-skill-bus-store";
    this.correlationId = options.correlation_id ?? this.requestId;
    this.env = options.env ?? process.env;
  }

  async saveToolRegistration(
    manifest: DojoMcpSkillManifestV1,
    options: SaveDojoMcpToolRegistrationOptions = {}
  ): Promise<DojoMcpToolRegistrationRecord> {
    const validation = validateDojoMcpSkillManifest(manifest, {
      env: this.env,
      expected_skill_id: manifest.skill.skill_id,
      expected_tool_name: manifest.tool.name,
    });
    if (!validation.ok) {
      throw new Error(`dojo_postgres_mcp_manifest_invalid:${validation.blocked_by.join(",")}`);
    }
    if (manifest.skill.workspace_id !== this.workspaceId) {
      throw new Error("dojo_postgres_mcp_manifest_workspace_mismatch");
    }
    if (!manifest.tool.name?.trim()) {
      throw new Error("dojo_postgres_mcp_manifest_tool_name_required");
    }
    const record = toolRegistrationRecordForManifest(manifest, {
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      status: options.status ?? "active",
      registered_at: options.registered_at ?? manifest.issued_at,
    });
    await this.queryable.query(
      `INSERT INTO dojo_tool_registrations (
        tenant_id,
        workspace_id,
        tool_registration_id,
        tool_name,
        tool_version,
        skill_id,
        license_id,
        manifest_digest,
        signed_manifest,
        proof_required,
        direct_call_policy,
        status,
        registered_at,
        revoked_at,
        manifest_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz, $15::jsonb)
      ON CONFLICT (tenant_id, workspace_id, tool_name, tool_version) DO UPDATE SET
        skill_id = EXCLUDED.skill_id,
        license_id = EXCLUDED.license_id,
        manifest_digest = EXCLUDED.manifest_digest,
        signed_manifest = EXCLUDED.signed_manifest,
        proof_required = EXCLUDED.proof_required,
        direct_call_policy = EXCLUDED.direct_call_policy,
        status = EXCLUDED.status,
        revoked_at = EXCLUDED.revoked_at,
        manifest_json = EXCLUDED.manifest_json`,
      [
        record.tenant_id,
        record.workspace_id,
        record.tool_registration_id,
        record.tool_name,
        record.tool_version,
        record.skill_id,
        record.license_id ?? null,
        record.manifest_digest,
        record.signed_manifest,
        record.proof_required,
        record.direct_call_policy,
        record.status,
        record.registered_at,
        record.revoked_at ?? null,
        JSON.stringify(record.manifest_json),
      ]
    );
    const saved = await this.getToolRegistration(record.tool_registration_id);
    if (!saved) throw new Error("dojo_postgres_mcp_tool_registration_save_failed");
    return saved;
  }

  async getToolRegistration(toolRegistrationId: string): Promise<DojoMcpToolRegistrationRecord | null> {
    const result = await this.queryable.query<ToolRegistrationRow>(
      `SELECT tenant_id, workspace_id, tool_registration_id, tool_name, tool_version,
        skill_id, license_id, manifest_digest, signed_manifest, proof_required,
        direct_call_policy, status, registered_at, revoked_at, manifest_json
      FROM dojo_tool_registrations
      WHERE tenant_id = $1 AND workspace_id = $2 AND tool_registration_id = $3`,
      [this.tenantId, this.workspaceId, toolRegistrationId]
    );
    return rowToToolRegistration(result.rows[0]);
  }

  async getActiveToolRegistrationByTool(
    toolName: string,
    toolVersion?: string
  ): Promise<DojoMcpToolRegistrationRecord | null> {
    const values: unknown[] = [this.tenantId, this.workspaceId, toolName];
    const predicates = ["tenant_id = $1", "workspace_id = $2", "tool_name = $3", "status = 'active'"];
    if (toolVersion) {
      values.push(toolVersion);
      predicates.push(`tool_version = $${values.length}`);
    }
    const result = await this.queryable.query<ToolRegistrationRow>(
      `SELECT tenant_id, workspace_id, tool_registration_id, tool_name, tool_version,
        skill_id, license_id, manifest_digest, signed_manifest, proof_required,
        direct_call_policy, status, registered_at, revoked_at, manifest_json
      FROM dojo_tool_registrations
      WHERE ${predicates.join(" AND ")}
      ORDER BY registered_at DESC, tool_registration_id ASC
      LIMIT 1`,
      values
    );
    return rowToToolRegistration(result.rows[0]);
  }

  async listToolRegistrations(
    filter: DojoMcpToolRegistrationFilter = {}
  ): Promise<DojoMcpToolRegistrationRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "tool_registration_id", filter.tool_registration_id);
    addOptionalPredicate(predicates, values, "tool_name", filter.tool_name);
    addOptionalPredicate(predicates, values, "tool_version", filter.tool_version);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "license_id", filter.license_id);
    addOptionalPredicate(predicates, values, "status", filter.status);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<ToolRegistrationRow>(
      `SELECT tenant_id, workspace_id, tool_registration_id, tool_name, tool_version,
        skill_id, license_id, manifest_digest, signed_manifest, proof_required,
        direct_call_policy, status, registered_at, revoked_at, manifest_json
      FROM dojo_tool_registrations
      WHERE ${predicates.join(" AND ")}
      ORDER BY registered_at DESC, tool_name ASC, tool_version ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToToolRegistration).filter((record): record is DojoMcpToolRegistrationRecord => record !== null);
  }

  async revokeToolRegistration(
    toolRegistrationId: string,
    revokedAt: string = new Date().toISOString()
  ): Promise<DojoMcpToolRegistrationRecord | null> {
    const result = await this.queryable.query<ToolRegistrationRow>(
      `UPDATE dojo_tool_registrations
      SET status = 'revoked',
        revoked_at = $4::timestamptz
      WHERE tenant_id = $1 AND workspace_id = $2 AND tool_registration_id = $3
      RETURNING tenant_id, workspace_id, tool_registration_id, tool_name, tool_version,
        skill_id, license_id, manifest_digest, signed_manifest, proof_required,
        direct_call_policy, status, registered_at, revoked_at, manifest_json`,
      [this.tenantId, this.workspaceId, toolRegistrationId, revokedAt]
    );
    return rowToToolRegistration(result.rows[0]);
  }

  async recordToolInvocation(input: RecordDojoMcpToolInvocationInput): Promise<DojoMcpToolInvocationRecord> {
    const createdAt = input.created_at ?? new Date().toISOString();
    const invocationJson = {
      ...(input.invocation_json ?? {}),
      blocked_by: Array.isArray(input.invocation_json?.["blocked_by"]) ? input.invocation_json?.["blocked_by"] : undefined,
    };
    const auditEventId = input.audit_event_id ?? await this.appendInvocationAudit(input, createdAt);
    const result = await this.queryable.query<ToolInvocationRow>(
      `INSERT INTO dojo_tool_invocations (
        tenant_id,
        workspace_id,
        invocation_id,
        tool_registration_id,
        tool_name,
        tool_version,
        skill_id,
        actor_id,
        actor_type,
        requested_action,
        status,
        proof_capsule_id,
        audit_event_id,
        invocation_json,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz)
      ON CONFLICT (tenant_id, workspace_id, invocation_id) DO UPDATE SET
        tool_registration_id = EXCLUDED.tool_registration_id,
        tool_name = EXCLUDED.tool_name,
        tool_version = EXCLUDED.tool_version,
        skill_id = EXCLUDED.skill_id,
        actor_id = EXCLUDED.actor_id,
        actor_type = EXCLUDED.actor_type,
        requested_action = EXCLUDED.requested_action,
        status = EXCLUDED.status,
        proof_capsule_id = EXCLUDED.proof_capsule_id,
        audit_event_id = EXCLUDED.audit_event_id,
        invocation_json = EXCLUDED.invocation_json
      RETURNING tenant_id, workspace_id, invocation_id, tool_registration_id,
        tool_name, tool_version, skill_id, actor_id, actor_type, requested_action,
        status, proof_capsule_id, audit_event_id, invocation_json, created_at`,
      [
        this.tenantId,
        this.workspaceId,
        input.invocation_id,
        input.tool_registration_id ?? null,
        input.tool_name,
        input.tool_version ?? null,
        input.skill_id ?? null,
        input.actor.actor_id,
        input.actor.actor_type,
        input.requested_action,
        input.status,
        input.proof_capsule_id ?? null,
        auditEventId ?? null,
        JSON.stringify(stripUndefined(invocationJson)),
        createdAt,
      ]
    );
    const record = rowToToolInvocation(result.rows[0]);
    if (!record) throw new Error("dojo_postgres_mcp_tool_invocation_save_failed");
    return record;
  }

  async listToolInvocations(
    filter: DojoMcpToolInvocationFilter = {}
  ): Promise<DojoMcpToolInvocationRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "invocation_id", filter.invocation_id);
    addOptionalPredicate(predicates, values, "tool_registration_id", filter.tool_registration_id);
    addOptionalPredicate(predicates, values, "tool_name", filter.tool_name);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "actor_id", filter.actor_id);
    addOptionalPredicate(predicates, values, "requested_action", filter.requested_action);
    addOptionalPredicate(predicates, values, "status", filter.status);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<ToolInvocationRow>(
      `SELECT tenant_id, workspace_id, invocation_id, tool_registration_id,
        tool_name, tool_version, skill_id, actor_id, actor_type, requested_action,
        status, proof_capsule_id, audit_event_id, invocation_json, created_at
      FROM dojo_tool_invocations
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, invocation_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToToolInvocation).filter((record): record is DojoMcpToolInvocationRecord => record !== null);
  }

  private async appendInvocationAudit(
    input: RecordDojoMcpToolInvocationInput,
    createdAt: string
  ): Promise<string | undefined> {
    if (!this.auditStore) return undefined;
    const audit = await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: input.actor,
      event_type: input.status === "allowed" || input.status === "completed"
        ? "mcp_tool_invocation_allowed"
        : "mcp_tool_invocation_blocked",
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "mcp_tool_invocation",
      entity_id: input.invocation_id,
      details: {
        tool_registration_id: input.tool_registration_id,
        tool_name: input.tool_name,
        tool_version: input.tool_version,
        skill_id: input.skill_id,
        requested_action: input.requested_action,
        status: input.status,
        proof_capsule_id: input.proof_capsule_id,
        ...(input.invocation_json ?? {}),
      },
      created_at: createdAt,
    });
    return audit.audit_event_id;
  }
}

export function toolRegistrationIdForManifest(
  tenantId: string,
  workspaceId: string,
  manifest: DojoMcpSkillManifestV1
): string {
  return `toolreg_${shortHash([
    tenantId,
    workspaceId,
    manifest.tool.name ?? "",
    manifest.tool.version,
    manifest.manifest_digest,
  ].join("\u0000"))}`;
}

function toolRegistrationRecordForManifest(
  manifest: DojoMcpSkillManifestV1,
  scope: {
    tenant_id: string;
    workspace_id: string;
    status: DojoMcpToolRegistrationRecord["status"];
    registered_at: string;
  }
): DojoMcpToolRegistrationRecord {
  return {
    tenant_id: scope.tenant_id,
    workspace_id: scope.workspace_id,
    tool_registration_id: toolRegistrationIdForManifest(scope.tenant_id, scope.workspace_id, manifest),
    tool_name: manifest.tool.name ?? "",
    tool_version: manifest.tool.version,
    skill_id: manifest.skill.skill_id,
    license_id: manifest.license.license_id,
    manifest_digest: hexDigest(manifest.manifest_digest),
    signed_manifest: JSON.stringify(manifest),
    proof_required: dojoMcpManifestRequiresProof(manifest),
    direct_call_policy: directCallPolicyForManifest(manifest),
    status: scope.status,
    registered_at: scope.registered_at,
    manifest_json: normalizeJsonObject<Record<string, unknown>>(manifest),
  };
}

function directCallPolicyForManifest(manifest: DojoMcpSkillManifestV1): DojoMcpDirectCallPolicy {
  return manifest.tool.direct_call_policy === "blocked_outside_dojo_dispatcher"
    ? "dojo_dispatcher_only"
    : "blocked";
}

function rowToToolRegistration(row: ToolRegistrationRow | undefined): DojoMcpToolRegistrationRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    tool_registration_id: row.tool_registration_id,
    tool_name: row.tool_name,
    tool_version: row.tool_version,
    skill_id: row.skill_id,
    ...(row.license_id ? { license_id: row.license_id } : {}),
    manifest_digest: row.manifest_digest,
    signed_manifest: row.signed_manifest,
    proof_required: row.proof_required,
    direct_call_policy: row.direct_call_policy,
    status: row.status,
    registered_at: iso(row.registered_at),
    revoked_at: isoOpt(row.revoked_at),
    manifest_json: normalizeJsonObject<Record<string, unknown>>(row.manifest_json),
  };
}

function rowToToolInvocation(row: ToolInvocationRow | undefined): DojoMcpToolInvocationRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    invocation_id: row.invocation_id,
    ...(row.tool_registration_id ? { tool_registration_id: row.tool_registration_id } : {}),
    tool_name: row.tool_name,
    ...(row.tool_version ? { tool_version: row.tool_version } : {}),
    ...(row.skill_id ? { skill_id: row.skill_id } : {}),
    actor: {
      actor_id: row.actor_id,
      actor_type: row.actor_type,
    },
    requested_action: row.requested_action,
    status: row.status,
    ...(row.proof_capsule_id ? { proof_capsule_id: row.proof_capsule_id } : {}),
    ...(row.audit_event_id ? { audit_event_id: row.audit_event_id } : {}),
    invocation_json: normalizeJsonObject<Record<string, unknown>>(row.invocation_json),
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

function hexDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("dojo_postgres_mcp_manifest_digest_invalid");
  }
  return digest;
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
  if (!trimmed) throw new Error(`dojo_postgres_mcp_${field}_required`);
  return trimmed;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOpt(value: Date | string | null): string | undefined {
  return value == null ? undefined : iso(value);
}
