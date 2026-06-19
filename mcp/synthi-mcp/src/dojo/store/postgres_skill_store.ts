import type { QueryResultRow } from "pg";
import type { DojoSkill } from "../../browser/dojo.js";
import {
  publishedToolNamesForSkill,
  publishedWorkflowBindingForSkill,
  type DojoPublishedWorkflowBinding,
} from "./published_workflow_index.js";
import type {
  DojoAuditActor,
  DojoAuditStore,
  DojoDurableSkillStore,
  DojoSkillListFilter,
  DojoSkillVersionListFilter,
  DojoStoredSkillRecord,
  DojoStoredSkillStatus,
  DojoStoredSkillVersionRecord,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoSkillStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

export interface SaveDojoSkillOptions {
  status?: DojoStoredSkillStatus;
  created_by?: DojoAuditActor;
  now?: string;
}

interface SkillRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  workflow_id: string;
  name: string;
  status: DojoStoredSkillStatus;
  current_skill_version: string | null;
  skill_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SkillVersionRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  skill_version: string;
  graph_version: string | null;
  seed_json: unknown;
  graph_json: unknown;
  created_at: Date | string;
  created_by: string | null;
}

export class PostgresDojoSkillStore implements DojoDurableSkillStore {
  readonly store_contract_kind = "skill" as const;

  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoSkillStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-skill-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-skill-store";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async saveSkill(skill: DojoSkill, options: SaveDojoSkillOptions = {}): Promise<DojoStoredSkillRecord> {
    assertSkillShape(skill);
    if (skill.workspace_id !== this.workspaceId) {
      throw new Error("dojo_postgres_skill_workspace_mismatch");
    }
    const now = options.now ?? new Date().toISOString();
    const createdAt = skill.generated_at || now;
    const actor = options.created_by ?? this.auditActor;
    const status = options.status ?? inferredSkillStatus(skill);
    assertSkillStatus(status);
    const result = await this.queryable.query<SkillRow>(
      `INSERT INTO dojo_skills (
        tenant_id,
        workspace_id,
        skill_id,
        workflow_id,
        name,
        status,
        current_skill_version,
        skill_json,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz)
      ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        workflow_id = EXCLUDED.workflow_id,
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        current_skill_version = EXCLUDED.current_skill_version,
        skill_json = EXCLUDED.skill_json,
        updated_at = EXCLUDED.updated_at
      RETURNING tenant_id, workspace_id, skill_id, workflow_id, name, status,
        current_skill_version, skill_json, created_at, updated_at`,
      [
        this.tenantId,
        this.workspaceId,
        skill.skill_id,
        skill.workflow_id,
        skill.name,
        status,
        skill.skill_version,
        JSON.stringify(skill),
        createdAt,
        now,
      ]
    );
    await this.queryable.query(
      `INSERT INTO dojo_skill_versions (
        tenant_id,
        workspace_id,
        skill_id,
        skill_version,
        graph_version,
        seed_json,
        graph_json,
        created_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz, $9)
      ON CONFLICT (tenant_id, skill_id, skill_version) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        graph_version = EXCLUDED.graph_version,
        seed_json = EXCLUDED.seed_json,
        graph_json = EXCLUDED.graph_json,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        skill.skill_id,
        skill.skill_version,
        graphVersionForSkill(skill),
        JSON.stringify(skill.skill_seed),
        JSON.stringify(skill.skill_cortex),
        createdAt,
        actor.actor_id,
      ]
    );
    const saved = rowToSkillRecord(result.rows[0]);
    if (!saved) throw new Error("dojo_postgres_skill_save_failed");
    await this.appendSkillAudit("skill_created", saved, actor);
    await this.appendSkillAudit("skill_version_created", saved, actor, {
      skill_version: skill.skill_version,
      graph_version: graphVersionForSkill(skill),
    });
    return saved;
  }

  async getSkillRecord(skillId: string): Promise<DojoStoredSkillRecord | null> {
    const result = await this.queryable.query<SkillRow>(
      `SELECT tenant_id, workspace_id, skill_id, workflow_id, name, status,
        current_skill_version, skill_json, created_at, updated_at
      FROM dojo_skills
      WHERE tenant_id = $1 AND workspace_id = $2 AND skill_id = $3`,
      [this.tenantId, this.workspaceId, skillId]
    );
    return rowToSkillRecord(result.rows[0]);
  }

  async getSkill(skillId: string): Promise<DojoSkill | null> {
    const record = await this.getSkillRecord(skillId);
    return record?.skill_json ?? null;
  }

  async getSkillByWorkflowId(workflowId: string): Promise<DojoSkill | null> {
    const records = await this.listSkillRecords({ workflow_id: workflowId, limit: 1 });
    return records[0]?.skill_json ?? null;
  }

  async getSkillByPublishedToolName(toolName: string): Promise<DojoSkill | null> {
    const records = await this.listSkillRecords({ published_tool_name: toolName, limit: 1 });
    return records[0]?.skill_json ?? null;
  }

  async getPublishedWorkflowBindingByWorkflowId(
    workflowId: string
  ): Promise<DojoPublishedWorkflowBinding | null> {
    const skill = await this.getSkillByWorkflowId(workflowId);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  async getPublishedWorkflowBindingByToolName(toolName: string): Promise<DojoPublishedWorkflowBinding | null> {
    const skill = await this.getSkillByPublishedToolName(toolName);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  async listSkillRecords(filter: DojoSkillListFilter = {}): Promise<DojoStoredSkillRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "workflow_id", filter.workflow_id);
    addOptionalPredicate(predicates, values, "status", filter.status);
    if (filter.published_tool_name) {
      values.push(filter.published_tool_name);
      predicates.push(
        `(skill_json ->> 'published_tool_name' = $${values.length} OR COALESCE(skill_json -> 'published_tools', '[]'::jsonb) ? $${values.length})`
      );
    }
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<SkillRow>(
      `SELECT tenant_id, workspace_id, skill_id, workflow_id, name, status,
        current_skill_version, skill_json, created_at, updated_at
      FROM dojo_skills
      WHERE ${predicates.join(" AND ")}
      ORDER BY updated_at DESC, skill_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToSkillRecord).filter((record): record is DojoStoredSkillRecord => record !== null);
  }

  async listSkills(filter: DojoSkillListFilter = {}): Promise<DojoSkill[]> {
    const records = await this.listSkillRecords(filter);
    return records.map((record) => record.skill_json);
  }

  async getSkillVersion(skillId: string, skillVersion: string): Promise<DojoStoredSkillVersionRecord | null> {
    const result = await this.queryable.query<SkillVersionRow>(
      `SELECT tenant_id, workspace_id, skill_id, skill_version, graph_version,
        seed_json, graph_json, created_at, created_by
      FROM dojo_skill_versions
      WHERE tenant_id = $1 AND workspace_id = $2 AND skill_id = $3 AND skill_version = $4`,
      [this.tenantId, this.workspaceId, skillId, skillVersion]
    );
    return rowToSkillVersion(result.rows[0]);
  }

  async listSkillVersions(
    filter: DojoSkillVersionListFilter = {}
  ): Promise<DojoStoredSkillVersionRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "skill_version", filter.skill_version);
    addOptionalPredicate(predicates, values, "graph_version", filter.graph_version);
    addOptionalPredicate(predicates, values, "created_by", filter.created_by);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<SkillVersionRow>(
      `SELECT tenant_id, workspace_id, skill_id, skill_version, graph_version,
        seed_json, graph_json, created_at, created_by
      FROM dojo_skill_versions
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, skill_id ASC, skill_version DESC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToSkillVersion).filter((record): record is DojoStoredSkillVersionRecord => record !== null);
  }

  private async appendSkillAudit(
    eventType: "skill_created" | "skill_version_created",
    record: DojoStoredSkillRecord,
    actor: DojoAuditActor,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    if (!this.auditStore) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor,
      event_type: eventType,
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: eventType === "skill_created" ? "skill" : "skill_version",
      entity_id: eventType === "skill_created" ? record.skill_id : `${record.skill_id}:${record.current_skill_version}`,
      details: {
        skill_id: record.skill_id,
        workflow_id: record.workflow_id,
        current_skill_version: record.current_skill_version,
        status: record.status,
        published_tool_names: publishedToolNamesForSkill(record.skill_json),
        ...details,
      },
      created_at: eventType === "skill_created" ? record.created_at : record.updated_at,
    });
  }
}

function rowToSkillRecord(row: SkillRow | undefined): DojoStoredSkillRecord | null {
  if (!row || !row.current_skill_version) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    skill_id: row.skill_id,
    workflow_id: row.workflow_id,
    name: row.name,
    status: row.status,
    current_skill_version: row.current_skill_version,
    skill_json: normalizeJsonObject<DojoSkill>(row.skill_json),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function rowToSkillVersion(row: SkillVersionRow | undefined): DojoStoredSkillVersionRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    skill_id: row.skill_id,
    skill_version: row.skill_version,
    ...(row.graph_version ? { graph_version: row.graph_version } : {}),
    seed_json: normalizeJsonObject<DojoSkill["skill_seed"]>(row.seed_json),
    graph_json: normalizeJsonObject<DojoSkill["skill_cortex"]>(row.graph_json),
    created_at: iso(row.created_at),
    ...(row.created_by ? { created_by: row.created_by } : {}),
  };
}

function assertSkillShape(skill: DojoSkill): void {
  if (skill.schema_version !== "synthi.dojo.skill.v1") {
    throw new Error("dojo_postgres_skill_schema_version_invalid");
  }
  requiredId(skill.skill_id, "skill_id");
  requiredId(skill.workspace_id, "workspace_id");
  requiredId(skill.workflow_id, "workflow_id");
  requiredId(skill.skill_version, "skill_version");
  requiredId(skill.name, "name");
  if (!skill.skill_seed || typeof skill.skill_seed !== "object") {
    throw new Error("dojo_postgres_skill_seed_required");
  }
  if (!skill.skill_cortex || typeof skill.skill_cortex !== "object") {
    throw new Error("dojo_postgres_skill_cortex_required");
  }
}

function inferredSkillStatus(skill: DojoSkill): DojoStoredSkillStatus {
  return publishedToolNamesForSkill(skill).length > 0 ? "published" : "draft";
}

function graphVersionForSkill(skill: DojoSkill): string | undefined {
  const cortex = skill.skill_cortex as unknown as Record<string, unknown>;
  if (typeof cortex["graph_version"] === "string" && cortex["graph_version"].trim()) {
    return cortex["graph_version"].trim();
  }
  if (typeof cortex["workflow_graph_id"] === "string" && cortex["workflow_graph_id"].trim()) {
    return cortex["workflow_graph_id"].trim();
  }
  if (typeof skill.workflow_graph_id === "string" && skill.workflow_graph_id.trim()) {
    return skill.workflow_graph_id.trim();
  }
  return undefined;
}

function assertSkillStatus(status: DojoStoredSkillStatus): void {
  if (!["draft", "published", "expired", "revoked"].includes(status)) {
    throw new Error(`dojo_postgres_skill_status_invalid:${String(status)}`);
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

function requiredId(value: string, field: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error(`dojo_postgres_skill_${field}_required`);
  return trimmed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
