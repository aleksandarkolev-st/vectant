import type { QueryResultRow } from "pg";
import type { DojoPostgresQueryable } from "../store/postgres_proof_store.js";
import type {
  DojoHostedRuntimeSessionRecord,
  DojoHostedRuntimeSessionStore,
  DojoHostedRuntimeSessionStatus,
} from "./hosted_runtime_gateway.js";

export interface PostgresDojoHostedRuntimeSessionStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
}

interface RuntimeSessionRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  runtime_id: string;
  organization_id: string;
  skill_id: string;
  run_id: string;
  actor_id: string;
  actor_type: DojoHostedRuntimeSessionRecord["actor_type"];
  workspace_url: string;
  workspace_origin: string;
  origin_allowlist: string[] | null;
  status: DojoHostedRuntimeSessionStatus;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  credential_id: string;
  credential_sha256: string;
  credential_expires_at: Date | string;
  local_network_allowed: boolean;
  redact_screenshots: boolean;
  audit_event_refs: string[] | null;
  evidence_refs: string[] | null;
}

const RUNTIME_SESSION_COLUMNS = `tenant_id, workspace_id, session_id, runtime_id, organization_id,
  skill_id, run_id, actor_id, actor_type, workspace_url, workspace_origin, origin_allowlist, status,
  created_at, expires_at, revoked_at, revoked_reason, credential_id, credential_sha256,
  credential_expires_at, local_network_allowed, redact_screenshots, audit_event_refs, evidence_refs`;

export class PostgresDojoHostedRuntimeSessionStore implements DojoHostedRuntimeSessionStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;

  constructor(options: PostgresDojoHostedRuntimeSessionStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async saveSession(record: DojoHostedRuntimeSessionRecord): Promise<DojoHostedRuntimeSessionRecord> {
    this.assertScope(record);
    return this.upsert(record);
  }

  async updateSession(record: DojoHostedRuntimeSessionRecord): Promise<DojoHostedRuntimeSessionRecord> {
    this.assertScope(record);
    return this.upsert(record);
  }

  async getSession(input: {
    tenant_id: string;
    workspace_id: string;
    session_id: string;
  }): Promise<DojoHostedRuntimeSessionRecord | null> {
    if (input.tenant_id !== this.tenantId || input.workspace_id !== this.workspaceId) return null;
    const result = await this.queryable.query<RuntimeSessionRow>(
      `SELECT ${RUNTIME_SESSION_COLUMNS}
      FROM dojo_runtime_sessions
      WHERE tenant_id = $1 AND workspace_id = $2 AND session_id = $3`,
      [this.tenantId, this.workspaceId, input.session_id]
    );
    return rowToSession(result.rows[0]);
  }

  async listSessions(input: {
    tenant_id: string;
    workspace_id: string;
    skill_id?: string;
    run_id?: string;
  }): Promise<DojoHostedRuntimeSessionRecord[]> {
    if (input.tenant_id !== this.tenantId || input.workspace_id !== this.workspaceId) return [];
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    if (input.skill_id) {
      values.push(input.skill_id);
      predicates.push(`skill_id = $${values.length}`);
    }
    if (input.run_id) {
      values.push(input.run_id);
      predicates.push(`run_id = $${values.length}`);
    }
    const result = await this.queryable.query<RuntimeSessionRow>(
      `SELECT ${RUNTIME_SESSION_COLUMNS}
      FROM dojo_runtime_sessions
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at ASC, session_id ASC`,
      values
    );
    return result.rows.map(rowToSession).filter((session): session is DojoHostedRuntimeSessionRecord => session !== null);
  }

  private async upsert(record: DojoHostedRuntimeSessionRecord): Promise<DojoHostedRuntimeSessionRecord> {
    const result = await this.queryable.query<RuntimeSessionRow>(
      `INSERT INTO dojo_runtime_sessions (
        tenant_id,
        workspace_id,
        session_id,
        runtime_id,
        organization_id,
        skill_id,
        run_id,
        actor_id,
        actor_type,
        workspace_url,
        workspace_origin,
        origin_allowlist,
        status,
        created_at,
        expires_at,
        revoked_at,
        revoked_reason,
        credential_id,
        credential_sha256,
        credential_expires_at,
        local_network_allowed,
        redact_screenshots,
        audit_event_refs,
        evidence_refs,
        session_json,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12::text[], $13, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17,
        $18, $19, $20::timestamptz, $21, $22, $23::text[], $24::text[], $25::jsonb, now()
      )
      ON CONFLICT (tenant_id, workspace_id, session_id) DO UPDATE SET
        runtime_id = EXCLUDED.runtime_id,
        organization_id = EXCLUDED.organization_id,
        skill_id = EXCLUDED.skill_id,
        run_id = EXCLUDED.run_id,
        actor_id = EXCLUDED.actor_id,
        actor_type = EXCLUDED.actor_type,
        workspace_url = EXCLUDED.workspace_url,
        workspace_origin = EXCLUDED.workspace_origin,
        origin_allowlist = EXCLUDED.origin_allowlist,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at,
        revoked_at = EXCLUDED.revoked_at,
        revoked_reason = EXCLUDED.revoked_reason,
        credential_id = EXCLUDED.credential_id,
        credential_sha256 = EXCLUDED.credential_sha256,
        credential_expires_at = EXCLUDED.credential_expires_at,
        local_network_allowed = EXCLUDED.local_network_allowed,
        redact_screenshots = EXCLUDED.redact_screenshots,
        audit_event_refs = EXCLUDED.audit_event_refs,
        evidence_refs = EXCLUDED.evidence_refs,
        session_json = EXCLUDED.session_json,
        updated_at = now()
      RETURNING ${RUNTIME_SESSION_COLUMNS}`,
      [
        this.tenantId,
        this.workspaceId,
        record.session_id,
        record.runtime_id,
        record.organization_id,
        record.skill_id,
        record.run_id,
        record.actor_id,
        record.actor_type,
        record.workspace_url,
        record.workspace_origin,
        record.origin_allowlist,
        record.status,
        record.created_at,
        record.expires_at,
        record.revoked_at ?? null,
        record.revoked_reason ?? null,
        record.credential_id,
        record.credential_sha256,
        record.credential_expires_at,
        record.egress_policy.local_network_allowed,
        record.redaction_policy.screenshots,
        record.audit_event_refs,
        record.evidence_refs,
        JSON.stringify(record),
      ]
    );
    const saved = rowToSession(result.rows[0]);
    if (!saved) throw new Error("dojo_runtime_session_save_failed");
    return saved;
  }

  private assertScope(record: DojoHostedRuntimeSessionRecord): void {
    if (record.tenant_id !== this.tenantId) throw new Error("dojo_runtime_session_tenant_mismatch");
    if (record.workspace_id !== this.workspaceId) throw new Error("dojo_runtime_session_workspace_mismatch");
  }
}

export function rowToSession(row: RuntimeSessionRow | undefined): DojoHostedRuntimeSessionRecord | null {
  if (!row) return null;
  return {
    schema_version: "synthi.dojo.hostedRuntimeSession.v1",
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    runtime_id: row.runtime_id,
    organization_id: row.organization_id,
    skill_id: row.skill_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    workspace_url: row.workspace_url,
    workspace_origin: row.workspace_origin,
    origin_allowlist: [...(row.origin_allowlist ?? [])],
    status: row.status,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
    ...(row.revoked_reason ? { revoked_reason: row.revoked_reason } : {}),
    credential_id: row.credential_id,
    credential_sha256: row.credential_sha256,
    credential_expires_at: iso(row.credential_expires_at),
    egress_policy: {
      local_network_allowed: row.local_network_allowed,
    },
    redaction_policy: {
      screenshots: row.redact_screenshots,
    },
    audit_event_refs: [...(row.audit_event_refs ?? [])],
    evidence_refs: [...(row.evidence_refs ?? [])],
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_runtime_session_${field}_required`);
  return trimmed;
}
