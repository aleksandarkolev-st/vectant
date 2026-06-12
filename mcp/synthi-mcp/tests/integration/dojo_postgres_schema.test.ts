import { describe, expect, it } from "vitest";
import {
  DOJO_POSTGRES_MIGRATIONS,
  DOJO_POSTGRES_REQUIRED_TABLES,
  assertUniqueMigrationIds,
  dojoPostgresMigrationSql,
  dojoPostgresMigrationStatements,
} from "../../src/dojo/store/migrations.js";

describe("Dojo Postgres schema migration", () => {
  it("emits repeat-safe DDL for each required foundation table", () => {
    const sql = normalizedSql(dojoPostgresMigrationSql());

    expect(sql).toContain("-- 001_dojo_control_plane_foundation:");
    for (const table of DOJO_POSTGRES_REQUIRED_TABLES) {
      expect(sql).toContain(`create table if not exists ${table}`);
    }
    expect(sql).toContain("create index if not exists dojo_skills_workflow_idx");
    expect(sql).toContain("create index if not exists dojo_proof_records_status_idx");
    expect(sql).toContain("create index if not exists dojo_audit_events_correlation_idx");
    expect(dojoPostgresMigrationSql()).toBe(dojoPostgresMigrationSql());
  });

  it("defines tenant and workspace foreign-key boundaries", () => {
    const statements = normalizedStatements();

    expect(statements["dojo_workspaces"]).toContain("tenant_id text not null references dojo_tenants(tenant_id) on delete restrict");
    expect(statements["dojo_skills"]).toContain(
      "foreign key (tenant_id, workspace_id) references dojo_workspaces(tenant_id, workspace_id) on delete restrict"
    );
    expect(statements["dojo_licenses"]).toContain(
      "foreign key (tenant_id, skill_id) references dojo_skills(tenant_id, skill_id) on delete restrict"
    );
    expect(statements["dojo_proof_records"]).toContain(
      "foreign key (tenant_id, workspace_id) references dojo_workspaces(tenant_id, workspace_id) on delete restrict"
    );
    expect(statements["dojo_audit_events"]).toContain(
      "foreign key (tenant_id, workspace_id) references dojo_workspaces(tenant_id, workspace_id) on delete restrict"
    );
  });

  it("defines proof replay and status constraints", () => {
    const proofRecords = normalizedStatements()["dojo_proof_records"];

    expect(proofRecords).toContain("primary key (tenant_id, capsule_id)");
    expect(proofRecords).toContain("unique (tenant_id, nonce)");
    expect(proofRecords).toContain("check (status in ('issued', 'used', 'revoked'))");
    expect(proofRecords).toContain("requested_action text not null");
    expect(proofRecords).toContain("issued_at timestamptz not null");
    expect(proofRecords).toContain("expires_at timestamptz not null");
  });

  it("requires audit actor and correlation context", () => {
    const auditEvents = normalizedStatements()["dojo_audit_events"];

    expect(auditEvents).toContain("actor_id text not null");
    expect(auditEvents).toContain("actor_type text not null");
    expect(auditEvents).toContain("request_id text not null");
    expect(auditEvents).toContain("correlation_id text not null");
    expect(auditEvents).toContain("check (actor_type in ('human', 'agent', 'service'))");
  });

  it("defines append-only evidence ledger tables and hash constraints", () => {
    const evidenceRecords = normalizedStatements()["dojo_evidence_records"];
    const checkpoints = normalizedStatements()["dojo_ledger_checkpoints"];

    expect(evidenceRecords).toContain("primary key (tenant_id, workspace_id, record_id)");
    expect(evidenceRecords).toContain("unique (tenant_id, workspace_id, record_hash)");
    expect(evidenceRecords).toContain(
      "foreign key (tenant_id, workspace_id) references dojo_workspaces(tenant_id, workspace_id) on delete restrict"
    );
    expect(evidenceRecords).toContain("check (artifact_sha256 ~ '^[a-fa-f0-9]{64}$')");
    expect(evidenceRecords).toContain("check (retention_class in ('ephemeral', 'standard', 'regulated', 'legal_hold'))");
    expect(checkpoints).toContain("primary key (tenant_id, workspace_id, checkpoint_id)");
    expect(checkpoints).toContain("check (record_count >= 0)");
  });

  it("defines hosted runtime session custody with tenant, skill, credential, and status constraints", () => {
    const runtimeSessions = normalizedStatements()["dojo_runtime_sessions"];

    expect(runtimeSessions).toContain("primary key (tenant_id, workspace_id, session_id)");
    expect(runtimeSessions).toContain(
      "foreign key (tenant_id, workspace_id) references dojo_workspaces(tenant_id, workspace_id) on delete restrict"
    );
    expect(runtimeSessions).toContain(
      "foreign key (tenant_id, skill_id) references dojo_skills(tenant_id, skill_id) on delete restrict"
    );
    expect(runtimeSessions).toContain("origin_allowlist text[] not null default array[]::text[]");
    expect(runtimeSessions).toContain("credential_sha256 text not null");
    expect(runtimeSessions).toContain("check (credential_sha256 ~ '^[a-fa-f0-9]{64}$')");
    expect(runtimeSessions).toContain("check (status in ('active', 'revoked', 'expired'))");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_runtime_sessions_skill_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_runtime_sessions_run_idx");
  });

  it("rejects duplicate migration identifiers before SQL generation", () => {
    expect(() => assertUniqueMigrationIds([
      DOJO_POSTGRES_MIGRATIONS[0],
      { ...DOJO_POSTGRES_MIGRATIONS[0], description: "duplicate" },
    ])).toThrow("duplicate_dojo_postgres_migration:001_dojo_control_plane_foundation");
  });
});

function normalizedStatements(): Record<string, string> {
  const tableStatements: Record<string, string> = {};
  for (const statement of dojoPostgresMigrationStatements()) {
    const normalized = normalizedSql(statement);
    const match = normalized.match(/^create table if not exists ([a-z_]+)/);
    if (match?.[1]) tableStatements[match[1]] = normalized;
  }
  return tableStatements;
}

function normalizedSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, " ").trim();
}
