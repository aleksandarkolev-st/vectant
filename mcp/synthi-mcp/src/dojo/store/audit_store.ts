import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type {
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditEventType,
  DojoAuditStore,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

interface AuditEventRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  audit_event_id: string;
  actor_id: string;
  actor_type: "human" | "agent" | "service";
  event_type: DojoAuditEventType;
  request_id: string;
  correlation_id: string;
  entity_kind: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | string | null;
  created_at: Date | string;
}

export interface PostgresDojoAuditStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
}

export class PostgresDojoAuditStore implements DojoAuditStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;

  constructor(options: PostgresDojoAuditStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async appendAuditEvent(event: DojoAuditEventInput): Promise<DojoAuditEventRecord> {
    if (event.tenant_id !== this.tenantId) throw new Error("dojo_audit_tenant_mismatch");
    if (event.workspace_id !== this.workspaceId) throw new Error("dojo_audit_workspace_mismatch");
    const auditEventId = event.audit_event_id ?? randomUUID();
    const createdAt = event.created_at ?? new Date().toISOString();
    const result = await this.queryable.query<AuditEventRow>(
      `INSERT INTO dojo_audit_events (
        tenant_id,
        workspace_id,
        audit_event_id,
        actor_id,
        actor_type,
        event_type,
        request_id,
        correlation_id,
        entity_kind,
        entity_id,
        details,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
      RETURNING tenant_id, workspace_id, audit_event_id, actor_id, actor_type, event_type,
        request_id, correlation_id, entity_kind, entity_id, details, created_at`,
      [
        this.tenantId,
        this.workspaceId,
        auditEventId,
        event.actor.actor_id,
        event.actor.actor_type,
        event.event_type,
        event.request_id,
        event.correlation_id,
        event.entity_kind ?? null,
        event.entity_id ?? null,
        JSON.stringify(event.details ?? {}),
        createdAt,
      ]
    );
    const record = rowToAuditRecord(result.rows[0]);
    if (!record) throw new Error("dojo_audit_append_failed");
    return record;
  }

  async listAuditEvents(filter: DojoAuditEventListFilter = {}): Promise<DojoAuditEventRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "event_type", filter.event_type);
    addOptionalPredicate(predicates, values, "entity_kind", filter.entity_kind);
    addOptionalPredicate(predicates, values, "entity_id", filter.entity_id);
    addOptionalPredicate(predicates, values, "correlation_id", filter.correlation_id);
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    values.push(limit);
    const result = await this.queryable.query<AuditEventRow>(
      `SELECT tenant_id, workspace_id, audit_event_id, actor_id, actor_type, event_type,
        request_id, correlation_id, entity_kind, entity_id, details, created_at
      FROM dojo_audit_events
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at ASC, audit_event_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToAuditRecord).filter((record): record is DojoAuditEventRecord => record !== null);
  }
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

function rowToAuditRecord(row: AuditEventRow | undefined): DojoAuditEventRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    audit_event_id: row.audit_event_id,
    actor: {
      actor_id: row.actor_id,
      actor_type: row.actor_type,
    },
    event_type: row.event_type,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    entity_kind: row.entity_kind ?? undefined,
    entity_id: row.entity_id ?? undefined,
    details: normalizeDetails(row.details),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

function normalizeDetails(details: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!details) return {};
  if (typeof details === "string") return JSON.parse(details) as Record<string, unknown>;
  return details;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_audit_${field}_required`);
  return trimmed;
}
