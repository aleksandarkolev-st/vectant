import { createHash, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { DojoPostgresQueryable } from "../store/postgres_proof_store.js";
import type { TherapeuticDurableRuntimeState, TherapeuticTenantScope } from "./index.js";

export interface TherapeuticProductionRuntimeStateRecord {
  schema_version: "synthi.dojo.therapeuticProductionRuntimeStateRecord.v1";
  tenant_scope: TherapeuticTenantScope;
  task_id: string;
  record_id: string;
  state_sha256: string;
  state: TherapeuticDurableRuntimeState;
  created_at: string;
  created_by: string;
}

export interface AppendTherapeuticProductionRuntimeStateInput {
  tenant_scope: TherapeuticTenantScope;
  task_id: string;
  state: TherapeuticDurableRuntimeState;
  state_sha256?: string;
  created_at?: string;
  created_by?: string;
  record_id?: string;
}

export interface GetTherapeuticProductionRuntimeStateInput {
  tenant_id: string;
  workspace_id: string;
  record_id: string;
}

interface TherapeuticRuntimeStateRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  record_id: string;
  task_id: string;
  state_sha256: string;
  state_text: string;
  created_at: Date | string;
  created_by: string;
}

export class PostgresTherapeuticProductionRuntimeStateStore {
  constructor(private readonly queryable: DojoPostgresQueryable) {}

  async appendState(
    input: AppendTherapeuticProductionRuntimeStateInput
  ): Promise<TherapeuticProductionRuntimeStateRecord> {
    const tenantScope = normalizeTenantScope(input.tenant_scope);
    const state = input.state;
    assertStateScope(state, tenantScope);
    const taskId = requiredId(input.task_id, "task_id");
    if (state.trace.task_id !== taskId) {
      throw new Error("therapeutic_runtime_state_task_mismatch");
    }
    const stateText = JSON.stringify(state);
    const stateSha256 = sha256(stateText);
    if (input.state_sha256 && input.state_sha256 !== stateSha256) {
      throw new Error("therapeutic_runtime_state_hash_mismatch");
    }
    const recordId = input.record_id?.trim() || `therapeutic-runtime-state-${randomUUID()}`;
    const createdAt = input.created_at ?? new Date().toISOString();
    const createdBy = input.created_by?.trim() || tenantScope.actor_id || "therapeutic-production-runtime";
    const result = await this.queryable.query<TherapeuticRuntimeStateRow>(
      `INSERT INTO dojo_therapeutic_runtime_states (
        tenant_id,
        workspace_id,
        record_id,
        task_id,
        state_sha256,
        state_text,
        state_json,
        created_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9)
      RETURNING tenant_id, workspace_id, record_id, task_id, state_sha256, state_text, created_at, created_by`,
      [
        tenantScope.tenant_id,
        tenantScope.workspace_id,
        recordId,
        taskId,
        stateSha256,
        stateText,
        stateText,
        createdAt,
        createdBy,
      ]
    );
    const record = rowToRecord(result.rows[0]);
    if (!record) throw new Error("therapeutic_runtime_state_append_failed");
    return record;
  }

  async getState(
    input: GetTherapeuticProductionRuntimeStateInput
  ): Promise<TherapeuticProductionRuntimeStateRecord | null> {
    const tenantId = requiredId(input.tenant_id, "tenant_id");
    const workspaceId = requiredId(input.workspace_id, "workspace_id");
    const recordId = requiredId(input.record_id, "record_id");
    const result = await this.queryable.query<TherapeuticRuntimeStateRow>(
      `SELECT tenant_id, workspace_id, record_id, task_id, state_sha256, state_text, created_at, created_by
      FROM dojo_therapeutic_runtime_states
      WHERE tenant_id = $1 AND workspace_id = $2 AND record_id = $3`,
      [tenantId, workspaceId, recordId]
    );
    return rowToRecord(result.rows[0]);
  }
}

function rowToRecord(row: TherapeuticRuntimeStateRow | undefined): TherapeuticProductionRuntimeStateRecord | null {
  if (!row) return null;
  const state = JSON.parse(row.state_text) as TherapeuticDurableRuntimeState;
  const stateSha256 = sha256(row.state_text);
  if (stateSha256 !== row.state_sha256) {
    throw new Error("therapeutic_runtime_state_stored_hash_mismatch");
  }
  return {
    schema_version: "synthi.dojo.therapeuticProductionRuntimeStateRecord.v1",
    tenant_scope: {
      tenant_id: row.tenant_id,
      workspace_id: row.workspace_id,
      ...(state.tenant_scope.actor_id ? { actor_id: state.tenant_scope.actor_id } : {}),
      ...(state.tenant_scope.data_region ? { data_region: state.tenant_scope.data_region } : {}),
    },
    task_id: row.task_id,
    record_id: row.record_id,
    state_sha256: row.state_sha256,
    state,
    created_at: toIso(row.created_at),
    created_by: row.created_by,
  };
}

function assertStateScope(state: TherapeuticDurableRuntimeState, tenantScope: TherapeuticTenantScope): void {
  if (state.schema_version !== "synthi.dojo.therapeuticRuntimeState.v1") {
    throw new Error("therapeutic_runtime_state_schema_invalid");
  }
  if (
    state.tenant_scope.tenant_id !== tenantScope.tenant_id
    || state.tenant_scope.workspace_id !== tenantScope.workspace_id
  ) {
    throw new Error("therapeutic_runtime_state_scope_mismatch");
  }
}

function normalizeTenantScope(scope: TherapeuticTenantScope): TherapeuticTenantScope {
  return {
    tenant_id: requiredId(scope.tenant_id, "tenant_id"),
    workspace_id: requiredId(scope.workspace_id, "workspace_id"),
    ...(scope.actor_id?.trim() ? { actor_id: scope.actor_id.trim() } : {}),
    ...(scope.data_region?.trim() ? { data_region: scope.data_region.trim() } : {}),
  };
}

function requiredId(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`therapeutic_runtime_state_${label}_required`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
