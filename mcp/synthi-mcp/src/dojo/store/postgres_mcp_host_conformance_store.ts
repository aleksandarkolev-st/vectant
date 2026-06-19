import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type {
  DojoAuditActor,
  DojoAuditStore,
  DojoMcpHostConformanceResultFilter,
  DojoMcpHostConformanceResultRecord,
  DojoMcpHostConformanceStatus,
  DojoMcpHostKind,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoMcpHostConformanceStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

export interface SaveDojoMcpHostConformanceResultInput {
  conformance_result_id?: string;
  host_url: string;
  host_kind?: DojoMcpHostKind;
  status: DojoMcpHostConformanceStatus;
  report_json: Record<string, unknown>;
  report_sha256?: string;
  created_at?: string;
  created_by?: string;
}

interface McpHostConformanceResultRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  conformance_result_id: string;
  host_url: string;
  host_kind: DojoMcpHostKind;
  status: DojoMcpHostConformanceStatus;
  report_sha256: string;
  report_json: unknown;
  created_at: Date | string;
  created_by: string;
}

export class PostgresDojoMcpHostConformanceStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoMcpHostConformanceStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-mcp-host-conformance-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-mcp-host-conformance-store";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async saveConformanceResult(
    input: SaveDojoMcpHostConformanceResultInput
  ): Promise<DojoMcpHostConformanceResultRecord> {
    const createdAt = input.created_at ?? new Date().toISOString();
    const hostUrl = requiredId(input.host_url, "host_url");
    const hostKind = input.host_kind ?? hostKindForMcpConformanceHost(hostUrl);
    assertHostKindMatchesUrl(hostUrl, hostKind);
    assertConformanceStatus(input.status);
    const reportJson = normalizeJsonObject<Record<string, unknown>>(input.report_json);
    const reportSha256 = reportSha256ForConformanceReport(reportJson);
    if (input.report_sha256 && hexDigest(input.report_sha256) !== reportSha256) {
      throw new Error("dojo_postgres_mcp_host_conformance_report_digest_mismatch");
    }
    const record: DojoMcpHostConformanceResultRecord = {
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      conformance_result_id: input.conformance_result_id
        ? requiredId(input.conformance_result_id, "conformance_result_id")
        : conformanceResultIdForReport({
          tenant_id: this.tenantId,
          workspace_id: this.workspaceId,
          host_url: hostUrl,
          created_at: createdAt,
          report_sha256: reportSha256,
        }),
      host_url: hostUrl,
      host_kind: hostKind,
      status: input.status,
      report_sha256: reportSha256,
      report_json: reportJson,
      created_at: createdAt,
      created_by: input.created_by ?? this.auditActor.actor_id,
    };

    const result = await this.queryable.query<McpHostConformanceResultRow>(
      `INSERT INTO dojo_mcp_host_conformance_results (
        tenant_id,
        workspace_id,
        conformance_result_id,
        host_url,
        host_kind,
        status,
        report_sha256,
        report_json,
        created_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10)
      ON CONFLICT (tenant_id, workspace_id, conformance_result_id) DO UPDATE SET
        host_url = EXCLUDED.host_url,
        host_kind = EXCLUDED.host_kind,
        status = EXCLUDED.status,
        report_sha256 = EXCLUDED.report_sha256,
        report_json = EXCLUDED.report_json,
        created_at = EXCLUDED.created_at,
        created_by = EXCLUDED.created_by
      RETURNING tenant_id, workspace_id, conformance_result_id, host_url, host_kind,
        status, report_sha256, report_json, created_at, created_by`,
      [
        record.tenant_id,
        record.workspace_id,
        record.conformance_result_id,
        record.host_url,
        record.host_kind,
        record.status,
        record.report_sha256,
        JSON.stringify(record.report_json),
        record.created_at,
        record.created_by,
      ]
    );
    const saved = rowToConformanceResult(result.rows[0]);
    if (!saved) throw new Error("dojo_postgres_mcp_host_conformance_save_failed");
    await this.appendConformanceAudit(saved);
    return saved;
  }

  async getConformanceResult(conformanceResultId: string): Promise<DojoMcpHostConformanceResultRecord | null> {
    const result = await this.queryable.query<McpHostConformanceResultRow>(
      `SELECT tenant_id, workspace_id, conformance_result_id, host_url, host_kind,
        status, report_sha256, report_json, created_at, created_by
      FROM dojo_mcp_host_conformance_results
      WHERE tenant_id = $1 AND workspace_id = $2 AND conformance_result_id = $3`,
      [this.tenantId, this.workspaceId, conformanceResultId]
    );
    return rowToConformanceResult(result.rows[0]);
  }

  async listConformanceResults(
    filter: DojoMcpHostConformanceResultFilter = {}
  ): Promise<DojoMcpHostConformanceResultRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "conformance_result_id", filter.conformance_result_id);
    addOptionalPredicate(predicates, values, "host_url", filter.host_url);
    addOptionalPredicate(predicates, values, "host_kind", filter.host_kind);
    addOptionalPredicate(predicates, values, "status", filter.status);
    addOptionalPredicate(predicates, values, "created_by", filter.created_by);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<McpHostConformanceResultRow>(
      `SELECT tenant_id, workspace_id, conformance_result_id, host_url, host_kind,
        status, report_sha256, report_json, created_at, created_by
      FROM dojo_mcp_host_conformance_results
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, conformance_result_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToConformanceResult).filter((record): record is DojoMcpHostConformanceResultRecord => record !== null);
  }

  private async appendConformanceAudit(record: DojoMcpHostConformanceResultRecord): Promise<void> {
    if (!this.auditStore) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: this.auditActor,
      event_type: "mcp_host_conformance_recorded",
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "mcp_host_conformance_result",
      entity_id: record.conformance_result_id,
      details: {
        host_kind: record.host_kind,
        host_url: record.host_url,
        status: record.status,
        report_sha256: record.report_sha256,
      },
      created_at: record.created_at,
    });
  }
}

export function conformanceResultIdForReport(input: {
  tenant_id: string;
  workspace_id: string;
  host_url: string;
  created_at: string;
  report_sha256: string;
}): string {
  return `mcpconf_${shortHash([
    input.tenant_id,
    input.workspace_id,
    input.host_url,
    input.created_at,
    input.report_sha256,
  ].join("\u0000"))}`;
}

export function reportSha256ForConformanceReport(report: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(report)).digest("hex");
}

export function hostKindForMcpConformanceHost(hostUrl: string): DojoMcpHostKind {
  const value = requiredId(hostUrl, "host_url");
  try {
    const url = new URL(value);
    return isLoopbackHost(url.hostname) ? "local_loopback" : "deployed_non_loopback";
  } catch {
    throw new Error("dojo_postgres_mcp_host_conformance_host_url_invalid");
  }
}

function assertHostKindMatchesUrl(hostUrl: string, hostKind: DojoMcpHostKind): void {
  assertHostKind(hostKind);
  const inferred = hostKindForMcpConformanceHost(hostUrl);
  if (inferred !== hostKind) {
    throw new Error(`dojo_postgres_mcp_host_conformance_host_kind_mismatch:${inferred}:${hostKind}`);
  }
}

function rowToConformanceResult(row: McpHostConformanceResultRow | undefined): DojoMcpHostConformanceResultRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    conformance_result_id: row.conformance_result_id,
    host_url: row.host_url,
    host_kind: row.host_kind,
    status: row.status,
    report_sha256: row.report_sha256,
    report_json: normalizeJsonObject<Record<string, unknown>>(row.report_json),
    created_at: iso(row.created_at),
    created_by: row.created_by,
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

function assertConformanceStatus(status: DojoMcpHostConformanceStatus): void {
  if (!["passed", "failed", "skipped"].includes(status)) {
    throw new Error(`dojo_postgres_mcp_host_conformance_status_invalid:${String(status)}`);
  }
}

function assertHostKind(hostKind: DojoMcpHostKind): void {
  if (!["local_loopback", "deployed_non_loopback"].includes(hostKind)) {
    throw new Error(`dojo_postgres_mcp_host_conformance_host_kind_invalid:${String(hostKind)}`);
  }
}

function hexDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("dojo_postgres_mcp_host_conformance_report_digest_invalid");
  }
  return digest.toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(value)) return true;
  return /^127\./.test(value);
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
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error(`dojo_postgres_mcp_host_conformance_${field}_required`);
  return trimmed;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
