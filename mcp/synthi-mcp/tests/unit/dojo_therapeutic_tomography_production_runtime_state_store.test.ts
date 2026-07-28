import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { DojoPostgresQueryable } from "../../src/dojo/store/postgres_proof_store.js";
import {
  PostgresTherapeuticProductionRuntimeStateStore,
} from "../../src/dojo/tomography/production_runtime_state_store.js";
import type { TherapeuticDurableRuntimeState } from "../../src/dojo/tomography/index.js";

interface RuntimeStateRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  record_id: string;
  task_id: string;
  state_sha256: string;
  state_text: string;
  created_at: string;
  created_by: string;
}

class MemoryTherapeuticRuntimeStateQueryable implements DojoPostgresQueryable {
  readonly rows: RuntimeStateRow[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>> {
    if (text.includes("INSERT INTO dojo_therapeutic_runtime_states")) {
      const row: RuntimeStateRow = {
        tenant_id: String(values?.[0]),
        workspace_id: String(values?.[1]),
        record_id: String(values?.[2]),
        task_id: String(values?.[3]),
        state_sha256: String(values?.[4]),
        state_text: String(values?.[5]),
        created_at: String(values?.[7]),
        created_by: String(values?.[8]),
      };
      this.rows.push(row);
      return result([row as T], 1);
    }
    if (text.includes("FROM dojo_therapeutic_runtime_states")) {
      const row = this.rows.find((candidate) =>
        candidate.tenant_id === values?.[0]
        && candidate.workspace_id === values?.[1]
        && candidate.record_id === values?.[2]
      );
      return result(row ? [row as T] : [], row ? 1 : 0);
    }
    throw new Error(`unexpected_query:${text}`);
  }
}

describe("PostgresTherapeuticProductionRuntimeStateStore", () => {
  it("appends and reconstructs exact production runtime state text", async () => {
    const queryable = new MemoryTherapeuticRuntimeStateQueryable();
    const store = new PostgresTherapeuticProductionRuntimeStateStore(queryable);
    const state = therapeuticState();
    const stateSha256 = sha256(JSON.stringify(state));

    const appended = await store.appendState({
      tenant_scope: state.tenant_scope,
      task_id: "production_incident_response_001",
      state,
      state_sha256: stateSha256,
      created_at: "2026-07-01T00:00:00.000Z",
      created_by: "agent-prod-001",
      record_id: "record-prod-001",
    });
    const reconstructed = await store.getState({
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      record_id: appended.record_id,
    });

    expect(appended.state_sha256).toBe(stateSha256);
    expect(reconstructed?.state).toEqual(state);
    expect(sha256(JSON.stringify(reconstructed?.state))).toBe(stateSha256);
    expect(reconstructed?.tenant_scope).toEqual({
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      data_region: "us-central1",
    });
  });

  it("rejects hash and tenant scope mismatches before persistence", async () => {
    const queryable = new MemoryTherapeuticRuntimeStateQueryable();
    const store = new PostgresTherapeuticProductionRuntimeStateStore(queryable);
    const state = therapeuticState();

    await expect(store.appendState({
      tenant_scope: state.tenant_scope,
      task_id: "production_incident_response_001",
      state,
      state_sha256: "0".repeat(64),
    })).rejects.toThrow("therapeutic_runtime_state_hash_mismatch");

    await expect(store.appendState({
      tenant_scope: { ...state.tenant_scope, workspace_id: "other-workspace" },
      task_id: "production_incident_response_001",
      state,
    })).rejects.toThrow("therapeutic_runtime_state_scope_mismatch");

    expect(queryable.rows).toHaveLength(0);
  });
});

function therapeuticState(): TherapeuticDurableRuntimeState {
  return {
    schema_version: "synthi.dojo.therapeuticRuntimeState.v1",
    tenant_scope: {
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      data_region: "us-central1",
    },
    trace: {
      task_id: "production_incident_response_001",
      task_kind: "incident_response",
      operator_intent: "restore service",
      requested_action: "restart_healthy_canary",
      narrative: "Production incident probe and scoped remediation.",
      domain: "sre",
      evidence: [],
    },
    store: {
      evidence_records: [],
      audit_records: [],
      grants: [],
      proof_statuses: {},
      proof_decision_records: [],
      checkride_reports: [],
      policy_learning_records: [],
      review_requests: [],
      remediation_verifications: [],
      tenant_scope: {
        tenant_id: "tenant-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "agent-prod-001",
        data_region: "us-central1",
      },
    },
    persisted_at: "2026-07-01T00:00:00.000Z",
  } as TherapeuticDurableRuntimeState;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function result<T extends QueryResultRow>(rows: T[], rowCount: number): QueryResult<T> {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}
