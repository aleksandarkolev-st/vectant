import type { QueryResultRow } from "pg";
import {
  buildDojoProofKeyRecord,
  type DojoProofKeyRecord,
  type DojoProofKeyResolution,
} from "../proof/key_registry.js";
import {
  createEd25519DojoProofVerifier,
  type DojoProofSigningAlgorithm,
} from "../proof/signing.js";
import type { DojoAuditActor, DojoAuditEventType, DojoAuditStore } from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoProofKeyRegistryOptions {
  tenant_id: string;
  queryable: DojoPostgresQueryable;
  workspace_id?: string;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

interface ProofKeyRow extends QueryResultRow {
  tenant_id: string;
  key_id: string;
  issuer: string;
  algorithm: DojoProofSigningAlgorithm;
  public_key_pem: string;
  status: DojoProofKeyRecord["status"];
  created_at: Date | string;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
  retain_for_forensic_verification: boolean;
  key_json: unknown;
}

export class PostgresDojoProofKeyRegistry {
  private readonly tenantId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly workspaceId?: string;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoProofKeyRegistryOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.queryable = options.queryable;
    this.workspaceId = optionalId(options.workspace_id, "workspace_id");
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-proof-key-registry", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-proof-key-registry";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async upsert(record: DojoProofKeyRecord): Promise<DojoProofKeyRecord> {
    this.assertRecordTenant(record);
    const normalized = buildDojoProofKeyRecord(record);
    await this.queryable.query(
      `INSERT INTO dojo_proof_keys (
        tenant_id,
        key_id,
        issuer,
        algorithm,
        public_key_pem,
        status,
        created_at,
        rotated_at,
        revoked_at,
        retain_for_forensic_verification,
        key_json,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11::jsonb, now())
      ON CONFLICT (tenant_id, key_id) DO UPDATE SET
        issuer = EXCLUDED.issuer,
        algorithm = EXCLUDED.algorithm,
        public_key_pem = EXCLUDED.public_key_pem,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        rotated_at = EXCLUDED.rotated_at,
        revoked_at = EXCLUDED.revoked_at,
        retain_for_forensic_verification = EXCLUDED.retain_for_forensic_verification,
        key_json = EXCLUDED.key_json,
        updated_at = now()`,
      [
        this.tenantId,
        normalized.key_id,
        normalized.issuer,
        normalized.algorithm,
        normalized.public_key_pem,
        normalized.status,
        normalized.created_at,
        normalized.rotated_at ?? null,
        normalized.revoked_at ?? null,
        normalized.retain_for_forensic_verification,
        JSON.stringify(normalized),
      ]
    );
    const saved = await this.get({ key_id: normalized.key_id });
    if (!saved) throw new Error("dojo_postgres_proof_key_save_failed");
    await this.appendAudit("proof_key_upserted", saved, {
      issuer: saved.issuer,
      algorithm: saved.algorithm,
      signing_provider: saved.signing_provider,
      key_custody: saved.key_custody,
      proof_key_status: saved.status,
    });
    return saved;
  }

  async get(input: { tenant_id?: string; key_id: string }): Promise<DojoProofKeyRecord | null> {
    if (!this.isRequestedTenant(input.tenant_id)) return null;
    const keyId = requiredId(input.key_id, "key_id");
    const result = await this.queryable.query<ProofKeyRow>(
      `SELECT tenant_id, key_id, issuer, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at,
        retain_for_forensic_verification, key_json
      FROM dojo_proof_keys
      WHERE tenant_id = $1 AND key_id = $2`,
      [this.tenantId, keyId]
    );
    return rowToProofKeyRecord(result.rows[0]);
  }

  async list(tenantId: string = this.tenantId): Promise<DojoProofKeyRecord[]> {
    if (!this.isRequestedTenant(tenantId)) return [];
    const result = await this.queryable.query<ProofKeyRow>(
      `SELECT tenant_id, key_id, issuer, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at,
        retain_for_forensic_verification, key_json
      FROM dojo_proof_keys
      WHERE tenant_id = $1
      ORDER BY created_at ASC, key_id ASC`,
      [this.tenantId]
    );
    return result.rows.map(rowToProofKeyRecord).filter((record): record is DojoProofKeyRecord => record !== null);
  }

  async active(input: {
    tenant_id?: string;
    issuer?: string;
    algorithm?: DojoProofSigningAlgorithm;
  } = {}): Promise<DojoProofKeyRecord | null> {
    if (!this.isRequestedTenant(input.tenant_id)) return null;
    const values: unknown[] = [this.tenantId];
    const filters = ["tenant_id = $1", "status = 'active'"];
    if (input.issuer) {
      values.push(input.issuer);
      filters.push(`issuer = $${values.length}`);
    }
    if (input.algorithm) {
      values.push(input.algorithm);
      filters.push(`algorithm = $${values.length}`);
    }
    const result = await this.queryable.query<ProofKeyRow>(
      `SELECT tenant_id, key_id, issuer, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at,
        retain_for_forensic_verification, key_json
      FROM dojo_proof_keys
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC, key_id DESC
      LIMIT 1`,
      values
    );
    return rowToProofKeyRecord(result.rows[0]);
  }

  async rotate(input: { tenant_id?: string; key_id: string; rotated_at: string }): Promise<DojoProofKeyRecord> {
    this.assertRequestedTenant(input.tenant_id);
    requireTimestamp(input.rotated_at, "rotated_at");
    const result = await this.queryable.query<ProofKeyRow>(
      `UPDATE dojo_proof_keys
      SET status = 'retired',
        rotated_at = $3::timestamptz,
        key_json = jsonb_set(jsonb_set(key_json, '{status}', to_jsonb('retired'::text), true), '{rotated_at}', to_jsonb($3::text), true),
        updated_at = now()
      WHERE tenant_id = $1 AND key_id = $2 AND status <> 'revoked'
      RETURNING tenant_id, key_id, issuer, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at,
        retain_for_forensic_verification, key_json`,
      [this.tenantId, requiredId(input.key_id, "key_id"), input.rotated_at]
    );
    const rotated = rowToProofKeyRecord(result.rows[0]);
    if (!rotated) {
      const current = await this.get({ key_id: input.key_id });
      if (current?.status === "revoked") throw new Error("dojo_proof_key_revoked");
      throw new Error("dojo_proof_key_not_found");
    }
    await this.appendAudit("proof_key_rotated", rotated, {
      issuer: rotated.issuer,
      algorithm: rotated.algorithm,
      signing_provider: rotated.signing_provider,
      key_custody: rotated.key_custody,
      proof_key_status: rotated.status,
      rotated_at: rotated.rotated_at,
    });
    return rotated;
  }

  async revoke(input: {
    tenant_id?: string;
    key_id: string;
    revoked_at: string;
    retain_for_forensic_verification?: boolean;
  }): Promise<DojoProofKeyRecord> {
    this.assertRequestedTenant(input.tenant_id);
    requireTimestamp(input.revoked_at, "revoked_at");
    const retain = input.retain_for_forensic_verification === true;
    const result = await this.queryable.query<ProofKeyRow>(
      `UPDATE dojo_proof_keys
      SET status = 'revoked',
        revoked_at = $3::timestamptz,
        retain_for_forensic_verification = $4,
        key_json = jsonb_set(
          jsonb_set(
            jsonb_set(key_json, '{status}', to_jsonb('revoked'::text), true),
            '{revoked_at}',
            to_jsonb($3::text),
            true
          ),
          '{retain_for_forensic_verification}',
          to_jsonb($4::boolean),
          true
        ),
        updated_at = now()
      WHERE tenant_id = $1 AND key_id = $2
      RETURNING tenant_id, key_id, issuer, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at,
        retain_for_forensic_verification, key_json`,
      [this.tenantId, requiredId(input.key_id, "key_id"), input.revoked_at, retain]
    );
    const revoked = rowToProofKeyRecord(result.rows[0]);
    if (!revoked) throw new Error("dojo_proof_key_not_found");
    await this.appendAudit("proof_key_revoked", revoked, {
      issuer: revoked.issuer,
      algorithm: revoked.algorithm,
      signing_provider: revoked.signing_provider,
      key_custody: revoked.key_custody,
      proof_key_status: revoked.status,
      revoked_at: revoked.revoked_at,
      retain_for_forensic_verification: revoked.retain_for_forensic_verification,
    });
    return revoked;
  }

  async resolveVerifier(input: {
    tenant_id?: string;
    key_id: string;
    allow_forensic_verification?: boolean;
  }): Promise<DojoProofKeyResolution> {
    if (!this.isRequestedTenant(input.tenant_id)) {
      return {
        ok: false,
        status: "not_found",
        blocked_by: ["proof_key_not_found"],
      };
    }
    const key = await this.get({ key_id: input.key_id });
    if (!key) {
      return {
        ok: false,
        status: "not_found",
        blocked_by: ["proof_key_not_found"],
      };
    }
    if (key.status === "revoked" && !(input.allow_forensic_verification && key.retain_for_forensic_verification)) {
      return {
        ok: false,
        status: "blocked",
        key,
        blocked_by: ["proof_key_revoked"],
      };
    }
    if (key.algorithm !== "ed25519") {
      return {
        ok: false,
        status: "blocked",
        key,
        blocked_by: ["proof_key_public_verifier_unavailable"],
      };
    }
    return {
      ok: true,
      status: "resolved",
      key,
      verifier: createEd25519DojoProofVerifier({
        key_id: key.key_id,
        public_key_pem: key.public_key_pem,
      }),
      blocked_by: [],
    };
  }

  private assertRecordTenant(record: DojoProofKeyRecord): void {
    if (record.tenant_id !== this.tenantId) throw new Error("dojo_postgres_proof_key_tenant_mismatch");
  }

  private isRequestedTenant(tenantId: string | undefined): boolean {
    return tenantId === undefined || tenantId === this.tenantId;
  }

  private assertRequestedTenant(tenantId: string | undefined): void {
    if (!this.isRequestedTenant(tenantId)) throw new Error("dojo_postgres_proof_key_tenant_mismatch");
  }

  private async appendAudit(eventType: DojoAuditEventType, record: DojoProofKeyRecord, details: Record<string, unknown>): Promise<void> {
    if (!this.auditStore || !this.workspaceId) return;
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: this.auditActor,
      event_type: eventType,
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "proof_key",
      entity_id: record.key_id,
      details,
    });
  }
}

function rowToProofKeyRecord(row: ProofKeyRow | undefined): DojoProofKeyRecord | null {
  if (!row) return null;
  const keyJson = proofKeyJson(row.key_json);
  return buildDojoProofKeyRecord({
    tenant_id: row.tenant_id,
    key_id: row.key_id,
    issuer: row.issuer,
    algorithm: row.algorithm,
    public_key_pem: row.public_key_pem,
    status: row.status,
    created_at: iso(row.created_at),
    ...(typeof keyJson?.signing_provider === "string" ? { signing_provider: keyJson.signing_provider as DojoProofKeyRecord["signing_provider"] } : {}),
    ...(typeof keyJson?.key_custody === "string" ? { key_custody: keyJson.key_custody as DojoProofKeyRecord["key_custody"] } : {}),
    ...(typeof keyJson?.key_uri === "string" ? { key_uri: keyJson.key_uri } : {}),
    ...(row.rotated_at ? { rotated_at: iso(row.rotated_at) } : {}),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
    retain_for_forensic_verification: row.retain_for_forensic_verification,
  });
}

function proofKeyJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_proof_key_${field}_required`);
  return trimmed;
}

function optionalId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredId(value, field);
}

function requireTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`dojo_postgres_proof_key_${field}_invalid`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
