export interface DojoPostgresMigration {
  id: string;
  description: string;
  statements: string[];
}

export const DOJO_POSTGRES_REQUIRED_TABLES = [
  "dojo_tenants",
  "dojo_workspaces",
  "dojo_skills",
  "dojo_skill_versions",
  "dojo_licenses",
  "dojo_proof_records",
  "dojo_evidence_records",
  "dojo_ledger_checkpoints",
  "dojo_audit_events",
] as const;

export type DojoPostgresRequiredTable = (typeof DOJO_POSTGRES_REQUIRED_TABLES)[number];

export const DOJO_POSTGRES_MIGRATIONS: DojoPostgresMigration[] = [
  {
    id: "001_dojo_control_plane_foundation",
    description: "Create tenant-scoped Dojo control-plane tables for skills, licenses, proof records, and audit events.",
    statements: [
      `CREATE TABLE IF NOT EXISTS dojo_tenants (
        tenant_id TEXT PRIMARY KEY,
        organization_id TEXT,
        display_name TEXT NOT NULL,
        data_region TEXT,
        encryption_key_ref TEXT,
        retention_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_workspaces (
        tenant_id TEXT NOT NULL REFERENCES dojo_tenants(tenant_id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL,
        organization_id TEXT,
        app_origin TEXT,
        data_region TEXT,
        policy_set JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, workspace_id)
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_skills (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        current_skill_version TEXT,
        skill_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, skill_id),
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        UNIQUE (tenant_id, workspace_id, workflow_id)
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_skill_versions (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        graph_version TEXT,
        seed_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT,
        PRIMARY KEY (tenant_id, skill_id, skill_version),
        FOREIGN KEY (tenant_id, skill_id) REFERENCES dojo_skills(tenant_id, skill_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_licenses (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        license_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        license_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        entrustment_level TEXT NOT NULL,
        readiness_level INTEGER NOT NULL,
        license_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, license_id),
        FOREIGN KEY (tenant_id, skill_id) REFERENCES dojo_skills(tenant_id, skill_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        UNIQUE (tenant_id, skill_id, license_version),
        CHECK (status IN ('active', 'expired', 'revoked', 'superseded'))
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_proof_records (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        capsule_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        license_id TEXT,
        requested_action TEXT NOT NULL,
        nonce TEXT,
        status TEXT NOT NULL,
        issued_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        first_used_at TIMESTAMPTZ,
        last_validated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        proof_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, capsule_id),
        FOREIGN KEY (tenant_id, skill_id) REFERENCES dojo_skills(tenant_id, skill_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, license_id) REFERENCES dojo_licenses(tenant_id, license_id) ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        UNIQUE (tenant_id, nonce),
        CHECK (status IN ('issued', 'used', 'revoked'))
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_audit_events (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        audit_event_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        request_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        entity_kind TEXT,
        entity_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, audit_event_id),
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        CHECK (actor_type IN ('human', 'agent', 'service'))
      )`,
      "CREATE INDEX IF NOT EXISTS dojo_workspaces_tenant_idx ON dojo_workspaces (tenant_id, workspace_id)",
      "CREATE INDEX IF NOT EXISTS dojo_skills_workflow_idx ON dojo_skills (tenant_id, workspace_id, workflow_id)",
      "CREATE INDEX IF NOT EXISTS dojo_skills_status_idx ON dojo_skills (tenant_id, workspace_id, status)",
      "CREATE INDEX IF NOT EXISTS dojo_skill_versions_created_idx ON dojo_skill_versions (tenant_id, skill_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS dojo_licenses_skill_idx ON dojo_licenses (tenant_id, skill_id, status)",
      "CREATE INDEX IF NOT EXISTS dojo_proof_records_status_idx ON dojo_proof_records (tenant_id, workspace_id, status)",
      "CREATE INDEX IF NOT EXISTS dojo_proof_records_skill_idx ON dojo_proof_records (tenant_id, skill_id, requested_action)",
      "CREATE INDEX IF NOT EXISTS dojo_audit_events_created_idx ON dojo_audit_events (tenant_id, workspace_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS dojo_audit_events_correlation_idx ON dojo_audit_events (tenant_id, correlation_id)",
    ],
  },
  {
    id: "002_dojo_evidence_ledger",
    description: "Create append-only evidence ledger records and ledger checkpoints.",
    statements: [
      `CREATE TABLE IF NOT EXISTS dojo_evidence_records (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_uri TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        redaction_manifest_sha256 TEXT,
        claim_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        ledger_head_hash TEXT NOT NULL,
        signer_key_id TEXT,
        signature TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL,
        retention_class TEXT NOT NULL,
        legal_hold BOOLEAN NOT NULL DEFAULT false,
        source_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        record_json JSONB NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, record_id),
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, skill_id) REFERENCES dojo_skills(tenant_id, skill_id) ON DELETE RESTRICT,
        UNIQUE (tenant_id, workspace_id, record_hash),
        CHECK (artifact_sha256 ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (previous_hash ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (record_hash ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (ledger_head_hash ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (redaction_manifest_sha256 IS NULL OR redaction_manifest_sha256 ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (retention_class IN ('ephemeral', 'standard', 'regulated', 'legal_hold'))
      )`,
      `CREATE TABLE IF NOT EXISTS dojo_ledger_checkpoints (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        ledger_head_hash TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, checkpoint_id),
        FOREIGN KEY (tenant_id, workspace_id) REFERENCES dojo_workspaces(tenant_id, workspace_id) ON DELETE RESTRICT,
        CHECK (ledger_head_hash ~ '^[A-Fa-f0-9]{64}$'),
        CHECK (record_count >= 0)
      )`,
      "CREATE INDEX IF NOT EXISTS dojo_evidence_records_run_idx ON dojo_evidence_records (tenant_id, workspace_id, run_id)",
      "CREATE INDEX IF NOT EXISTS dojo_evidence_records_skill_idx ON dojo_evidence_records (tenant_id, workspace_id, skill_id, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS dojo_evidence_records_claim_idx ON dojo_evidence_records USING GIN (claim_ids)",
      "CREATE INDEX IF NOT EXISTS dojo_ledger_checkpoints_head_idx ON dojo_ledger_checkpoints (tenant_id, workspace_id, created_at DESC)",
    ],
  },
];

export function dojoPostgresMigrationSql(migrations: DojoPostgresMigration[] = DOJO_POSTGRES_MIGRATIONS): string {
  assertUniqueMigrationIds(migrations);
  return migrations
    .flatMap((migration) => [
      `-- ${migration.id}: ${migration.description}`,
      ...migration.statements.map((statement) => `${trimSql(statement)};`),
    ])
    .join("\n\n") + "\n";
}

export function dojoPostgresMigrationStatements(
  migrations: DojoPostgresMigration[] = DOJO_POSTGRES_MIGRATIONS
): string[] {
  assertUniqueMigrationIds(migrations);
  return migrations.flatMap((migration) => migration.statements.map(trimSql));
}

export function assertUniqueMigrationIds(migrations: DojoPostgresMigration[]): void {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`duplicate_dojo_postgres_migration:${migration.id}`);
    ids.add(migration.id);
  }
}

function trimSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
