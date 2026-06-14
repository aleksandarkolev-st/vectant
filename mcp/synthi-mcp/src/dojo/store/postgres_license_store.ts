import type { QueryResultRow } from "pg";
import type { DojoPermissionLicense, DojoSkillReadinessLevel } from "../../browser/dojo.js";
import type {
  DojoAuditActor,
  DojoAuditStore,
  DojoLicenseListFilter,
  DojoLicenseStore,
  DojoPermissionLicenseRecord,
  DojoPermissionLicenseVersionRecord,
  DojoStoredLicenseStatus,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoLicenseStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
}

export interface SaveDojoLicenseOptions {
  readiness_level: DojoSkillReadinessLevel;
  status?: DojoStoredLicenseStatus;
  expires_at?: string;
  created_by?: DojoAuditActor;
  now?: string;
}

interface LicenseRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  license_id: string;
  skill_id: string;
  license_version: string;
  status: DojoStoredLicenseStatus;
  entrustment_level: DojoPermissionLicense["entrustment_level"];
  readiness_level: number;
  license_json: unknown;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LicenseVersionRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  license_id: string;
  license_version: string;
  skill_id: string;
  status: DojoStoredLicenseStatus;
  entrustment_level: DojoPermissionLicense["entrustment_level"];
  readiness_level: number;
  license_json: unknown;
  created_at: Date | string;
  created_by: string | null;
}

export class PostgresDojoLicenseStore implements DojoLicenseStore {
  readonly store_contract_kind = "license" as const;

  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;

  constructor(options: PostgresDojoLicenseStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-license-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-license-store";
    this.correlationId = options.correlation_id ?? this.requestId;
  }

  async saveLicense(
    license: DojoPermissionLicense,
    options: SaveDojoLicenseOptions
  ): Promise<DojoPermissionLicenseRecord> {
    assertLicenseShape(license);
    const readinessLevel = normalizedReadinessLevel(options.readiness_level);
    const status = options.status ?? "active";
    assertLicenseStatus(status);
    const now = options.now ?? new Date().toISOString();
    const createdAt = license.issued_at || now;
    const actor = options.created_by ?? this.auditActor;
    const result = await this.queryable.query<LicenseRow>(
      `INSERT INTO dojo_licenses (
        tenant_id,
        workspace_id,
        license_id,
        skill_id,
        license_version,
        status,
        entrustment_level,
        readiness_level,
        license_json,
        expires_at,
        revoked_at,
        revoked_reason,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz, $12, $13::timestamptz, $14::timestamptz)
      ON CONFLICT (tenant_id, license_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        skill_id = EXCLUDED.skill_id,
        license_version = EXCLUDED.license_version,
        status = EXCLUDED.status,
        entrustment_level = EXCLUDED.entrustment_level,
        readiness_level = EXCLUDED.readiness_level,
        license_json = EXCLUDED.license_json,
        expires_at = EXCLUDED.expires_at,
        revoked_at = EXCLUDED.revoked_at,
        revoked_reason = EXCLUDED.revoked_reason,
        updated_at = EXCLUDED.updated_at
      RETURNING tenant_id, workspace_id, license_id, skill_id, license_version,
        status, entrustment_level, readiness_level, license_json, expires_at,
        revoked_at, revoked_reason, created_at, updated_at`,
      [
        this.tenantId,
        this.workspaceId,
        license.license_id,
        license.skill_id,
        license.license_version,
        status,
        license.entrustment_level,
        readinessLevel,
        JSON.stringify(license),
        options.expires_at ?? null,
        null,
        null,
        createdAt,
        now,
      ]
    );
    await this.queryable.query(
      `INSERT INTO dojo_license_versions (
        tenant_id,
        workspace_id,
        license_id,
        license_version,
        skill_id,
        status,
        entrustment_level,
        readiness_level,
        license_json,
        created_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11)
      ON CONFLICT (tenant_id, workspace_id, license_id, license_version) DO UPDATE SET
        skill_id = EXCLUDED.skill_id,
        status = EXCLUDED.status,
        entrustment_level = EXCLUDED.entrustment_level,
        readiness_level = EXCLUDED.readiness_level,
        license_json = EXCLUDED.license_json,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        license.license_id,
        license.license_version,
        license.skill_id,
        status,
        license.entrustment_level,
        readinessLevel,
        JSON.stringify(license),
        createdAt,
        actor.actor_id,
      ]
    );
    const saved = rowToLicense(result.rows[0]);
    if (!saved) throw new Error("dojo_postgres_license_save_failed");
    await this.appendLicenseAudit("license_issued", saved, actor);
    return saved;
  }

  async getLicense(licenseId: string): Promise<DojoPermissionLicenseRecord | null> {
    const result = await this.queryable.query<LicenseRow>(
      `SELECT tenant_id, workspace_id, license_id, skill_id, license_version,
        status, entrustment_level, readiness_level, license_json, expires_at,
        revoked_at, revoked_reason, created_at, updated_at
      FROM dojo_licenses
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3`,
      [this.tenantId, this.workspaceId, licenseId]
    );
    return rowToLicense(result.rows[0]);
  }

  async getLicenseVersion(
    licenseId: string,
    licenseVersion: string
  ): Promise<DojoPermissionLicenseVersionRecord | null> {
    const result = await this.queryable.query<LicenseVersionRow>(
      `SELECT tenant_id, workspace_id, license_id, license_version, skill_id,
        status, entrustment_level, readiness_level, license_json, created_at, created_by
      FROM dojo_license_versions
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3 AND license_version = $4`,
      [this.tenantId, this.workspaceId, licenseId, licenseVersion]
    );
    return rowToLicenseVersion(result.rows[0]);
  }

  async listLicenses(filter: DojoLicenseListFilter = {}): Promise<DojoPermissionLicenseRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "license_id", filter.license_id);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "license_version", filter.license_version);
    addOptionalPredicate(predicates, values, "status", filter.status);
    addOptionalPredicate(predicates, values, "entrustment_level", filter.entrustment_level);
    addOptionalNumberPredicate(predicates, values, "readiness_level", filter.readiness_level);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<LicenseRow>(
      `SELECT tenant_id, workspace_id, license_id, skill_id, license_version,
        status, entrustment_level, readiness_level, license_json, expires_at,
        revoked_at, revoked_reason, created_at, updated_at
      FROM dojo_licenses
      WHERE ${predicates.join(" AND ")}
      ORDER BY updated_at DESC, license_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToLicense).filter((record): record is DojoPermissionLicenseRecord => record !== null);
  }

  async listLicenseVersions(
    filter: DojoLicenseListFilter = {}
  ): Promise<DojoPermissionLicenseVersionRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "license_id", filter.license_id);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "license_version", filter.license_version);
    addOptionalPredicate(predicates, values, "status", filter.status);
    addOptionalPredicate(predicates, values, "entrustment_level", filter.entrustment_level);
    addOptionalNumberPredicate(predicates, values, "readiness_level", filter.readiness_level);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<LicenseVersionRow>(
      `SELECT tenant_id, workspace_id, license_id, license_version, skill_id,
        status, entrustment_level, readiness_level, license_json, created_at, created_by
      FROM dojo_license_versions
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, license_id ASC, license_version DESC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToLicenseVersion).filter((record): record is DojoPermissionLicenseVersionRecord => record !== null);
  }

  async revokeLicense(
    licenseId: string,
    reason: string,
    now: string = new Date().toISOString(),
    revokedBy: DojoAuditActor = this.auditActor,
    options: {
      revoked_license?: DojoPermissionLicense;
      readiness_level?: DojoSkillReadinessLevel;
      expires_at?: string;
    } = {}
  ): Promise<DojoPermissionLicenseRecord | null> {
    const revokedLicense = options.revoked_license;
    if (revokedLicense) {
      assertLicenseShape(revokedLicense);
      if (revokedLicense.license_id !== licenseId) {
        throw new Error("dojo_postgres_license_revocation_license_id_mismatch");
      }
      if (options.readiness_level === undefined) {
        throw new Error("dojo_postgres_license_revocation_readiness_level_required");
      }
    }
    const readinessLevel = options.readiness_level === undefined
      ? null
      : normalizedReadinessLevel(options.readiness_level);
    const result = await this.queryable.query<LicenseRow>(
      `UPDATE dojo_licenses
      SET status = 'revoked',
        license_version = COALESCE($6, license_version),
        entrustment_level = COALESCE($7, entrustment_level),
        readiness_level = COALESCE($8, readiness_level),
        license_json = COALESCE($9::jsonb, license_json),
        expires_at = COALESCE($10::timestamptz, expires_at),
        revoked_at = $4::timestamptz,
        revoked_reason = $5,
        updated_at = $4::timestamptz
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3
      RETURNING tenant_id, workspace_id, license_id, skill_id, license_version,
        status, entrustment_level, readiness_level, license_json, expires_at,
        revoked_at, revoked_reason, created_at, updated_at`,
      [
        this.tenantId,
        this.workspaceId,
        licenseId,
        now,
        requiredId(reason, "revoked_reason"),
        revokedLicense?.license_version ?? null,
        revokedLicense?.entrustment_level ?? null,
        readinessLevel,
        revokedLicense ? JSON.stringify(revokedLicense) : null,
        options.expires_at ?? null,
      ]
    );
    const revoked = rowToLicense(result.rows[0]);
    if (!revoked) return null;
    await this.queryable.query(
      `UPDATE dojo_license_versions
      SET status = 'revoked'
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3`,
      [this.tenantId, this.workspaceId, revoked.license_id]
    );
    if (revokedLicense) {
      await this.queryable.query(
        `INSERT INTO dojo_license_versions (
          tenant_id,
          workspace_id,
          license_id,
          license_version,
          skill_id,
          status,
          entrustment_level,
          readiness_level,
          license_json,
          created_at,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, 'revoked', $6, $7, $8::jsonb, $9::timestamptz, $10)
        ON CONFLICT (tenant_id, workspace_id, license_id, license_version) DO UPDATE SET
          skill_id = EXCLUDED.skill_id,
          status = 'revoked',
          entrustment_level = EXCLUDED.entrustment_level,
          readiness_level = EXCLUDED.readiness_level,
          license_json = EXCLUDED.license_json,
          created_by = EXCLUDED.created_by`,
        [
          this.tenantId,
          this.workspaceId,
          revokedLicense.license_id,
          revokedLicense.license_version,
          revokedLicense.skill_id,
          revokedLicense.entrustment_level,
          readinessLevel,
          JSON.stringify(revokedLicense),
          now,
          revokedBy.actor_id,
        ]
      );
    }
    await this.appendLicenseAudit("license_revoked", revoked, revokedBy, { revoked_reason: reason });
    return revoked;
  }

  async expireLicense(
    licenseId: string,
    reason: string,
    now: string = new Date().toISOString(),
    expiredBy: DojoAuditActor = this.auditActor,
    options: {
      expires_at?: string;
    } = {}
  ): Promise<DojoPermissionLicenseRecord | null> {
    const effectiveExpiresAt = options.expires_at ?? now;
    const result = await this.queryable.query<LicenseRow>(
      `UPDATE dojo_licenses
      SET status = 'expired',
        expires_at = CASE
          WHEN expires_at IS NULL THEN $4::timestamptz
          WHEN expires_at > $4::timestamptz THEN $4::timestamptz
          ELSE expires_at
        END,
        revoked_reason = $5,
        updated_at = $6::timestamptz
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3 AND status = 'active'
      RETURNING tenant_id, workspace_id, license_id, skill_id, license_version,
        status, entrustment_level, readiness_level, license_json, expires_at,
        revoked_at, revoked_reason, created_at, updated_at`,
      [
        this.tenantId,
        this.workspaceId,
        licenseId,
        effectiveExpiresAt,
        requiredId(reason, "expired_reason"),
        now,
      ]
    );
    const expired = rowToLicense(result.rows[0]);
    if (!expired) return null;
    await this.queryable.query(
      `UPDATE dojo_license_versions
      SET status = 'expired'
      WHERE tenant_id = $1 AND workspace_id = $2 AND license_id = $3`,
      [this.tenantId, this.workspaceId, expired.license_id]
    );
    await this.appendLicenseAudit("license_expired", expired, expiredBy, {
      expired_reason: reason,
      expires_at: expired.expires_at,
    });
    return expired;
  }

  private async appendLicenseAudit(
    eventType: "license_issued" | "license_expired" | "license_revoked",
    record: DojoPermissionLicenseRecord,
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
      entity_kind: "permission_license",
      entity_id: record.license_id,
      details: {
        skill_id: record.skill_id,
        license_version: record.license_version,
        status: record.status,
        entrustment_level: record.entrustment_level,
        readiness_level: record.readiness_level,
        ...details,
      },
      created_at: eventType === "license_issued" ? record.created_at : record.updated_at,
    });
  }
}

function rowToLicense(row: LicenseRow | undefined): DojoPermissionLicenseRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    license_id: row.license_id,
    skill_id: row.skill_id,
    license_version: row.license_version,
    status: row.status,
    entrustment_level: row.entrustment_level,
    readiness_level: normalizedReadinessLevel(row.readiness_level),
    license_json: normalizeJsonObject<DojoPermissionLicense>(row.license_json),
    ...(row.expires_at ? { expires_at: iso(row.expires_at) } : {}),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
    ...(row.revoked_reason ? { revoked_reason: row.revoked_reason } : {}),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function rowToLicenseVersion(row: LicenseVersionRow | undefined): DojoPermissionLicenseVersionRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    license_id: row.license_id,
    license_version: row.license_version,
    skill_id: row.skill_id,
    status: row.status,
    entrustment_level: row.entrustment_level,
    readiness_level: normalizedReadinessLevel(row.readiness_level),
    license_json: normalizeJsonObject<DojoPermissionLicense>(row.license_json),
    created_at: iso(row.created_at),
    ...(row.created_by ? { created_by: row.created_by } : {}),
  };
}

function assertLicenseShape(license: DojoPermissionLicense): void {
  if (license.schema_version !== "synthi.dojo.permissionLicense.v1") {
    throw new Error("dojo_postgres_license_schema_version_invalid");
  }
  requiredId(license.license_id, "license_id");
  requiredId(license.skill_id, "skill_id");
  requiredId(license.license_version, "license_version");
  requiredId(license.issued_at, "issued_at");
  if (!["E0", "E1", "E2", "E3", "E4", "E5", "EX"].includes(license.entrustment_level)) {
    throw new Error(`dojo_postgres_license_entrustment_level_invalid:${String(license.entrustment_level)}`);
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

function addOptionalNumberPredicate(
  predicates: string[],
  values: unknown[],
  column: string,
  value: number | undefined
): void {
  if (typeof value !== "number") return;
  values.push(normalizedReadinessLevel(value));
  predicates.push(`${column} = $${values.length}`);
}

function assertLicenseStatus(status: DojoStoredLicenseStatus): void {
  if (!["active", "expired", "revoked", "superseded"].includes(status)) {
    throw new Error(`dojo_postgres_license_status_invalid:${String(status)}`);
  }
}

function normalizedReadinessLevel(value: number): DojoSkillReadinessLevel {
  if (!Number.isInteger(value) || value < 0 || value > 9) {
    throw new Error(`dojo_postgres_license_readiness_level_invalid:${String(value)}`);
  }
  return value as DojoSkillReadinessLevel;
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
  if (!trimmed) throw new Error(`dojo_postgres_license_${field}_required`);
  return trimmed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
