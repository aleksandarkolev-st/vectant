import type { QueryResult, QueryResultRow } from "pg";
import { dojoPostgresMigrationStatements } from "./migrations.js";
import type { DojoProofCapsuleRecord } from "./interfaces.js";

export interface DojoPostgresQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface PostgresDojoProofStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
}

export interface DojoPostgresProofConsumeResult {
  ok: boolean;
  record: DojoProofCapsuleRecord | null;
  status: "used" | "missing" | "already_used" | "revoked";
  blocked_by: string[];
}

interface ProofRecordRow {
  capsule_id: string;
  skill_id: string;
  requested_action: string;
  nonce: string | null;
  issued_at: Date | string;
  expires_at: Date | string;
  status: DojoProofCapsuleRecord["status"];
  first_used_at: Date | string | null;
  last_validated_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

export async function applyDojoPostgresMigrations(queryable: DojoPostgresQueryable): Promise<void> {
  for (const statement of dojoPostgresMigrationStatements()) {
    await queryable.query(statement);
  }
}

export class PostgresDojoProofStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;

  constructor(options: PostgresDojoProofStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async saveProofRecord(record: DojoProofCapsuleRecord): Promise<DojoProofCapsuleRecord> {
    await this.queryable.query(
      `INSERT INTO dojo_proof_records (
        tenant_id,
        workspace_id,
        capsule_id,
        skill_id,
        requested_action,
        nonce,
        status,
        issued_at,
        expires_at,
        first_used_at,
        last_validated_at,
        revoked_at,
        revoked_reason,
        proof_json,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13, $14::jsonb, now())
      ON CONFLICT (tenant_id, capsule_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        skill_id = EXCLUDED.skill_id,
        requested_action = EXCLUDED.requested_action,
        nonce = EXCLUDED.nonce,
        status = EXCLUDED.status,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        first_used_at = EXCLUDED.first_used_at,
        last_validated_at = EXCLUDED.last_validated_at,
        revoked_at = EXCLUDED.revoked_at,
        revoked_reason = EXCLUDED.revoked_reason,
        proof_json = EXCLUDED.proof_json,
        updated_at = now()`,
      [
        this.tenantId,
        this.workspaceId,
        record.capsule_id,
        record.skill_id,
        record.requested_action,
        record.nonce ?? null,
        record.status,
        record.issued_at,
        record.expires_at,
        record.first_used_at ?? null,
        record.last_validated_at ?? null,
        record.revoked_at ?? null,
        record.revoked_reason ?? null,
        JSON.stringify({ capsule_id: record.capsule_id, nonce: record.nonce ?? null }),
      ]
    );
    const saved = await this.getProofRecord(record.capsule_id);
    if (!saved) throw new Error("dojo_postgres_proof_save_failed");
    return saved;
  }

  async getProofRecord(capsuleId: string): Promise<DojoProofCapsuleRecord | null> {
    const result = await this.queryable.query<ProofRecordRow>(
      `SELECT capsule_id, skill_id, requested_action, nonce, issued_at, expires_at, status,
        first_used_at, last_validated_at, revoked_at, revoked_reason
      FROM dojo_proof_records
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3`,
      [this.tenantId, this.workspaceId, capsuleId]
    );
    return rowToProofRecord(result.rows[0]);
  }

  async listProofRecords(): Promise<DojoProofCapsuleRecord[]> {
    const result = await this.queryable.query<ProofRecordRow>(
      `SELECT capsule_id, skill_id, requested_action, nonce, issued_at, expires_at, status,
        first_used_at, last_validated_at, revoked_at, revoked_reason
      FROM dojo_proof_records
      WHERE tenant_id = $1 AND workspace_id = $2
      ORDER BY issued_at ASC, capsule_id ASC`,
      [this.tenantId, this.workspaceId]
    );
    return result.rows.map(rowToProofRecord).filter((record): record is DojoProofCapsuleRecord => record !== null);
  }

  async revokeProofCapsule(
    capsuleId: string,
    reason: string,
    now: string = new Date().toISOString()
  ): Promise<DojoProofCapsuleRecord | null> {
    const result = await this.queryable.query<ProofRecordRow>(
      `UPDATE dojo_proof_records
      SET status = 'revoked',
        revoked_at = $4::timestamptz,
        revoked_reason = $5,
        updated_at = now()
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3
      RETURNING capsule_id, skill_id, requested_action, nonce, issued_at, expires_at, status,
        first_used_at, last_validated_at, revoked_at, revoked_reason`,
      [this.tenantId, this.workspaceId, capsuleId, now, reason]
    );
    return rowToProofRecord(result.rows[0]);
  }

  async markProofCapsuleUsed(
    capsuleId: string,
    runId: string,
    now: string = new Date().toISOString()
  ): Promise<DojoPostgresProofConsumeResult> {
    const result = await this.queryable.query<ProofRecordRow>(
      `UPDATE dojo_proof_records
      SET status = 'used',
        first_used_at = COALESCE(first_used_at, $4::timestamptz),
        last_validated_at = $4::timestamptz,
        proof_json = jsonb_set(COALESCE(proof_json, '{}'::jsonb), '{last_run_id}', to_jsonb($5::text), true),
        updated_at = now()
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3 AND status = 'issued'
      RETURNING capsule_id, skill_id, requested_action, nonce, issued_at, expires_at, status,
        first_used_at, last_validated_at, revoked_at, revoked_reason`,
      [this.tenantId, this.workspaceId, capsuleId, now, runId]
    );
    const consumed = rowToProofRecord(result.rows[0]);
    if (consumed) return { ok: true, record: consumed, status: "used", blocked_by: [] };

    const current = await this.getProofRecord(capsuleId);
    if (!current) {
      return { ok: false, record: null, status: "missing", blocked_by: ["proof_capsule_not_issued_by_registry"] };
    }
    if (current.status === "revoked") {
      return { ok: false, record: current, status: "revoked", blocked_by: ["proof_capsule_revoked"] };
    }
    if (current.status === "used") {
      return { ok: false, record: current, status: "already_used", blocked_by: ["proof_capsule_replay_detected"] };
    }
    return { ok: false, record: current, status: "missing", blocked_by: ["proof_capsule_not_issued_by_registry"] };
  }
}

function rowToProofRecord(row: ProofRecordRow | undefined): DojoProofCapsuleRecord | null {
  if (!row) return null;
  return {
    capsule_id: row.capsule_id,
    skill_id: row.skill_id,
    requested_action: row.requested_action,
    nonce: row.nonce ?? undefined,
    issued_at: iso(row.issued_at),
    expires_at: iso(row.expires_at),
    status: row.status,
    first_used_at: isoOpt(row.first_used_at),
    last_validated_at: isoOpt(row.last_validated_at),
    revoked_at: isoOpt(row.revoked_at),
    revoked_reason: row.revoked_reason ?? undefined,
  };
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_${field}_required`);
  return trimmed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOpt(value: Date | string | null): string | undefined {
  return value == null ? undefined : iso(value);
}
