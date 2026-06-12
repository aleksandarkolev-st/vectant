import type { QueryResult, QueryResultRow } from "pg";
import { dojoPostgresMigrationStatements } from "./migrations.js";
import type { DojoAuditActor, DojoAuditStore, DojoProofCapsuleRecord, DojoProofConsumeResult } from "./interfaces.js";

export interface DojoPostgresQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface DojoPostgresClient extends DojoPostgresQueryable {
  release?(): void;
}

export interface DojoPostgresConnectable extends DojoPostgresQueryable {
  connect?(): Promise<DojoPostgresClient>;
}

export interface PostgresDojoProofStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

export type DojoPostgresProofConsumeResult = DojoProofConsumeResult;

interface ProofRecordRow {
  tenant_id: string;
  workspace_id: string;
  capsule_id: string;
  skill_id: string;
  license_id: string | null;
  requested_action: string;
  nonce: string | null;
  proof_json: unknown;
  issued_at: Date | string;
  expires_at: Date | string;
  status: DojoProofCapsuleRecord["status"];
  first_used_at: Date | string | null;
  last_validated_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

const DOJO_POSTGRES_MIGRATION_ADVISORY_LOCK_ID = 770110011;

export async function applyDojoPostgresMigrations(queryable: DojoPostgresConnectable): Promise<void> {
  const client: DojoPostgresClient = queryable.connect ? await queryable.connect() : queryable;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [DOJO_POSTGRES_MIGRATION_ADVISORY_LOCK_ID]);
    for (const statement of dojoPostgresMigrationStatements()) {
      await client.query(statement);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [DOJO_POSTGRES_MIGRATION_ADVISORY_LOCK_ID]);
    } finally {
      client.release?.();
    }
  }
}

export class PostgresDojoProofStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoProofStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-proof-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-proof-store";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async saveProofRecord(record: DojoProofCapsuleRecord): Promise<DojoProofCapsuleRecord> {
    this.assertRecordScope(record);
    await this.queryable.query(
      `INSERT INTO dojo_proof_records (
        tenant_id,
        workspace_id,
        capsule_id,
        skill_id,
        license_id,
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14, $15::jsonb, now())
      ON CONFLICT (tenant_id, capsule_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        skill_id = EXCLUDED.skill_id,
        license_id = EXCLUDED.license_id,
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
        record.license_id ?? null,
        record.requested_action,
        record.nonce ?? null,
        record.status,
        record.issued_at,
        record.expires_at,
        record.first_used_at ?? null,
        record.last_validated_at ?? null,
        record.revoked_at ?? null,
        record.revoked_reason ?? null,
        JSON.stringify(proofRecordJson(record)),
      ]
    );
    const saved = await this.getProofRecord(record.capsule_id);
    if (!saved) throw new Error("dojo_postgres_proof_save_failed");
    await this.appendProofAudit("proof_issued", saved, {
      requested_action: saved.requested_action,
      proof_status: saved.status,
    });
    return saved;
  }

  async getProofRecord(capsuleId: string): Promise<DojoProofCapsuleRecord | null> {
    const result = await this.queryable.query<ProofRecordRow>(
      `SELECT tenant_id, workspace_id, capsule_id, skill_id, license_id, requested_action, nonce, proof_json,
        issued_at, expires_at, status, first_used_at, last_validated_at, revoked_at, revoked_reason
      FROM dojo_proof_records
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3`,
      [this.tenantId, this.workspaceId, capsuleId]
    );
    return rowToProofRecord(result.rows[0]);
  }

  async listProofRecords(): Promise<DojoProofCapsuleRecord[]> {
    const result = await this.queryable.query<ProofRecordRow>(
      `SELECT tenant_id, workspace_id, capsule_id, skill_id, license_id, requested_action, nonce, proof_json,
        issued_at, expires_at, status, first_used_at, last_validated_at, revoked_at, revoked_reason
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
    now: string = new Date().toISOString(),
    revokedBy?: DojoAuditActor
  ): Promise<DojoProofCapsuleRecord | null> {
    const result = await this.queryable.query<ProofRecordRow>(
      `UPDATE dojo_proof_records
      SET status = 'revoked',
        revoked_at = $4::timestamptz,
        revoked_reason = $5,
        updated_at = now()
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3
      RETURNING tenant_id, workspace_id, capsule_id, skill_id, license_id, requested_action, nonce, proof_json,
        issued_at, expires_at, status, first_used_at, last_validated_at, revoked_at, revoked_reason`,
      [this.tenantId, this.workspaceId, capsuleId, now, reason]
    );
    const revoked = rowToProofRecord(result.rows[0]);
    if (revoked) {
      await this.appendProofAudit("proof_revoked", revoked, {
        requested_action: revoked.requested_action,
        proof_status: revoked.status,
        revoked_reason: reason,
        ...(revokedBy ? { revoked_by: revokedBy } : {}),
      });
    }
    return revoked;
  }

  async markProofCapsuleValidated(
    capsuleId: string,
    now: string = new Date().toISOString()
  ): Promise<DojoProofCapsuleRecord | null> {
    const result = await this.queryable.query<ProofRecordRow>(
      `UPDATE dojo_proof_records
      SET last_validated_at = $4::timestamptz,
        updated_at = now()
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3
      RETURNING tenant_id, workspace_id, capsule_id, skill_id, license_id, requested_action, nonce, proof_json,
        issued_at, expires_at, status, first_used_at, last_validated_at, revoked_at, revoked_reason`,
      [this.tenantId, this.workspaceId, capsuleId, now]
    );
    const validated = rowToProofRecord(result.rows[0]);
    if (validated) {
      await this.appendProofAudit("proof_validated", validated, {
        requested_action: validated.requested_action,
        proof_status: validated.status,
        validated_at: now,
      });
    }
    return validated;
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
      RETURNING tenant_id, workspace_id, capsule_id, skill_id, license_id, requested_action, nonce, proof_json,
        issued_at, expires_at, status, first_used_at, last_validated_at, revoked_at, revoked_reason`,
      [this.tenantId, this.workspaceId, capsuleId, now, runId]
    );
    const consumed = rowToProofRecord(result.rows[0]);
    if (consumed) {
      await this.appendProofAudit("proof_used", consumed, {
        requested_action: consumed.requested_action,
        proof_status: consumed.status,
        run_id: runId,
      });
      return { ok: true, record: consumed, status: "used", blocked_by: [] };
    }

    const current = await this.getProofRecord(capsuleId);
    if (!current) {
      await this.appendProofRejectedAudit(capsuleId, ["proof_capsule_not_issued_by_registry"], runId);
      return { ok: false, record: null, status: "missing", blocked_by: ["proof_capsule_not_issued_by_registry"] };
    }
    if (current.status === "revoked") {
      await this.appendProofAudit("proof_rejected", current, {
        requested_action: current.requested_action,
        proof_status: current.status,
        run_id: runId,
        blocked_by: ["proof_capsule_revoked"],
      });
      return { ok: false, record: current, status: "revoked", blocked_by: ["proof_capsule_revoked"] };
    }
    if (current.status === "used") {
      await this.appendProofAudit("proof_rejected", current, {
        requested_action: current.requested_action,
        proof_status: current.status,
        run_id: runId,
        blocked_by: ["proof_capsule_replay_detected"],
      });
      return { ok: false, record: current, status: "already_used", blocked_by: ["proof_capsule_replay_detected"] };
    }
    await this.appendProofAudit("proof_rejected", current, {
      requested_action: current.requested_action,
      proof_status: current.status,
      run_id: runId,
      blocked_by: ["proof_capsule_not_issued_by_registry"],
    });
    return { ok: false, record: current, status: "missing", blocked_by: ["proof_capsule_not_issued_by_registry"] };
  }

  private async appendProofAudit(
    eventType: "proof_issued" | "proof_validated" | "proof_used" | "proof_rejected" | "proof_revoked",
    record: DojoProofCapsuleRecord,
    details: Record<string, unknown>
  ): Promise<void> {
    if (!this.auditStore) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: this.auditActor,
      event_type: eventType,
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "proof_capsule",
      entity_id: record.capsule_id,
      details: {
        skill_id: record.skill_id,
        ...details,
      },
    });
  }

  private async appendProofRejectedAudit(capsuleId: string, blockedBy: string[], runId: string): Promise<void> {
    if (!this.auditStore) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: this.auditActor,
      event_type: "proof_rejected",
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "proof_capsule",
      entity_id: capsuleId,
      details: {
        run_id: runId,
        blocked_by: blockedBy,
      },
    });
  }

  private assertRecordScope(record: DojoProofCapsuleRecord): void {
    if (record.tenant_id && record.tenant_id !== this.tenantId) throw new Error("dojo_postgres_proof_tenant_mismatch");
    if (record.workspace_id && record.workspace_id !== this.workspaceId) throw new Error("dojo_postgres_proof_workspace_mismatch");
  }
}

function rowToProofRecord(row: ProofRecordRow | undefined): DojoProofCapsuleRecord | null {
  if (!row) return null;
  const metadata = proofRecordMetadata(row.proof_json);
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    capsule_id: row.capsule_id,
    skill_id: row.skill_id,
    ...(row.license_id ? { license_id: row.license_id } : {}),
    ...metadata,
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

function proofRecordJson(record: DojoProofCapsuleRecord): Record<string, unknown> {
  return stripUndefined({
    capsule_id: record.capsule_id,
    nonce: record.nonce,
    license_version: record.license_version,
    key_id: record.key_id,
    signature_algorithm: record.signature_algorithm,
    substrate_claim: record.substrate_claim,
    evidence_record_ids: record.evidence_record_ids,
    ledger_checkpoint_hash: record.ledger_checkpoint_hash,
  });
}

function proofRecordMetadata(value: unknown): Partial<DojoProofCapsuleRecord> {
  if (!value || typeof value !== "object") return {};
  const object = value as Record<string, unknown>;
  return stripUndefined({
    license_version: stringOpt(object["license_version"]),
    key_id: stringOpt(object["key_id"]),
    signature_algorithm: stringOpt(object["signature_algorithm"]),
    substrate_claim: stringOpt(object["substrate_claim"]),
    evidence_record_ids: stringArrayOpt(object["evidence_record_ids"]),
    ledger_checkpoint_hash: stringOpt(object["ledger_checkpoint_hash"]),
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayOpt(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length === value.length ? strings : undefined;
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
