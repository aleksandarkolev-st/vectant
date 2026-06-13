import type { QueryResultRow } from "pg";
import type {
  DojoGhostShadowEvidenceFilter,
  DojoGhostShadowEvidenceRecord,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoGhostShadowEvidenceStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
}

interface GhostShadowEvidenceRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  evidence_json: unknown;
}

export class PostgresDojoGhostShadowEvidenceStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;

  constructor(options: PostgresDojoGhostShadowEvidenceStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async saveGhostShadowEvidence(record: DojoGhostShadowEvidenceRecord): Promise<DojoGhostShadowEvidenceRecord> {
    assertGhostShadowEvidenceRecord(record, this.tenantId, this.workspaceId);
    await this.queryable.query(
      `INSERT INTO dojo_ghost_shadow_evidence (
        tenant_id,
        workspace_id,
        evidence_id,
        run_id,
        skill_id,
        workflow_id,
        license_id,
        action_matches,
        license_status,
        guardrail_refs,
        evidence_refs,
        evidence_json,
        created_at,
        created_by,
        request_id,
        correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::jsonb, $13::timestamptz, $14, $15, $16)
      ON CONFLICT (tenant_id, workspace_id, evidence_id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        skill_id = EXCLUDED.skill_id,
        workflow_id = EXCLUDED.workflow_id,
        license_id = EXCLUDED.license_id,
        action_matches = EXCLUDED.action_matches,
        license_status = EXCLUDED.license_status,
        guardrail_refs = EXCLUDED.guardrail_refs,
        evidence_refs = EXCLUDED.evidence_refs,
        evidence_json = EXCLUDED.evidence_json,
        created_at = EXCLUDED.created_at,
        created_by = EXCLUDED.created_by,
        request_id = EXCLUDED.request_id,
        correlation_id = EXCLUDED.correlation_id`,
      [
        this.tenantId,
        this.workspaceId,
        record.evidence_id,
        record.run_id,
        record.skill_id,
        record.workflow_id,
        record.license_id,
        record.action_matches,
        record.license_status,
        uniqueStrings(record.guardrail_refs),
        uniqueStrings(record.evidence_refs),
        JSON.stringify(record),
        record.created_at,
        record.created_by.actor_id,
        record.request_context.request_id,
        record.request_context.correlation_id,
      ]
    );
    const saved = (await this.listGhostShadowEvidence({ evidence_id: record.evidence_id, limit: 1 }))[0];
    if (!saved) throw new Error("dojo_postgres_ghost_shadow_evidence_save_failed");
    return saved;
  }

  async listGhostShadowEvidence(
    filter: DojoGhostShadowEvidenceFilter = {}
  ): Promise<DojoGhostShadowEvidenceRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "evidence_id", filter.evidence_id);
    addOptionalPredicate(predicates, values, "run_id", filter.run_id);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "workflow_id", filter.workflow_id);
    if (typeof filter.action_matches === "boolean") {
      values.push(filter.action_matches);
      predicates.push(`action_matches = $${values.length}`);
    }
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<GhostShadowEvidenceRow>(
      `SELECT tenant_id, workspace_id, evidence_json
      FROM dojo_ghost_shadow_evidence
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, evidence_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => {
      const record = normalizeJsonObject<DojoGhostShadowEvidenceRecord>(row.evidence_json);
      return {
        ...record,
        tenant_id: row.tenant_id,
        workspace_id: row.workspace_id,
      };
    });
  }
}

function assertGhostShadowEvidenceRecord(
  record: DojoGhostShadowEvidenceRecord,
  tenantId: string,
  workspaceId: string
): void {
  if (record.schema_version !== "synthi.dojo.ghostShadowEvidence.v1") {
    throw new Error("dojo_postgres_ghost_shadow_evidence_schema_version_invalid");
  }
  if (record.tenant_id !== tenantId) throw new Error("dojo_postgres_ghost_shadow_evidence_tenant_mismatch");
  if (record.workspace_id !== workspaceId) throw new Error("dojo_postgres_ghost_shadow_evidence_workspace_mismatch");
  for (const [field, value] of Object.entries({
    evidence_id: record.evidence_id,
    run_id: record.run_id,
    skill_id: record.skill_id,
    workflow_id: record.workflow_id,
    license_id: record.license_id,
    created_at: record.created_at,
    created_by: record.created_by?.actor_id,
    request_id: record.request_context?.request_id,
    correlation_id: record.request_context?.correlation_id,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`dojo_postgres_ghost_shadow_evidence_${field}_required`);
    }
  }
  if (record.evidence_kind !== "shadow") throw new Error("dojo_postgres_ghost_shadow_evidence_kind_invalid");
  if (record.production_mutations_executed !== false) {
    throw new Error("dojo_postgres_ghost_shadow_evidence_production_mutation_invalid");
  }
  if (record.license_status !== "licensed" && record.license_status !== "blocked") {
    throw new Error("dojo_postgres_ghost_shadow_evidence_license_status_invalid");
  }
  if (typeof record.observed_label !== "string" || typeof record.planned_label !== "string") {
    throw new Error("dojo_postgres_ghost_shadow_evidence_action_label_invalid");
  }
  if (!["human", "agent", "service"].includes(record.created_by.actor_type)) {
    throw new Error("dojo_postgres_ghost_shadow_evidence_actor_type_invalid");
  }
  if (!Array.isArray(record.evidence_refs) || uniqueStrings(record.evidence_refs).length === 0) {
    throw new Error("dojo_postgres_ghost_shadow_evidence_refs_required");
  }
  if (Number.isNaN(Date.parse(record.created_at))) {
    throw new Error("dojo_postgres_ghost_shadow_evidence_created_at_invalid");
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

function normalizeJsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedLimit(value: number | undefined): number {
  return Number.isFinite(value) && typeof value === "number" && value > 0
    ? Math.max(1, Math.min(Math.floor(value), 500))
    : 100;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_ghost_shadow_evidence_${field}_required`);
  return trimmed;
}
