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
    expect(proofRecords).toContain(
      "foreign key (tenant_id, license_id) references dojo_licenses(tenant_id, license_id) on delete restrict"
    );
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

  it("defines release-scoped source snapshot custody", () => {
    const appReleases = normalizedStatements()["dojo_app_releases"];
    const sourceSnapshots = normalizedStatements()["dojo_source_snapshots"];
    const sourceTokens = normalizedStatements()["dojo_source_tokens"];

    expect(appReleases).toContain("primary key (tenant_id, workspace_id, app_release_id)");
    expect(appReleases).toContain("unique (tenant_id, workspace_id, app_origin, app_version)");
    expect(sourceSnapshots).toContain(
      "foreign key (tenant_id, workspace_id, app_release_id) references dojo_app_releases(tenant_id, workspace_id, app_release_id) on delete restrict"
    );
    expect(sourceSnapshots).toContain("signer_key_id text not null");
    expect(sourceSnapshots).toContain("signature text not null");
    expect(sourceTokens).toContain("primary key (tenant_id, workspace_id, snapshot_id, token_id)");
    expect(sourceTokens).toContain("foreign key (tenant_id, workspace_id, snapshot_id) references dojo_source_snapshots(tenant_id, workspace_id, snapshot_id) on delete cascade");
    expect(sourceTokens).toContain("check (allowed_substrate in ('vision', 'dom', 'source', 'api', 'mcp'))");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_source_snapshots_release_idx");
  });

  it("defines graph, node-memory, and license-version registries", () => {
    const skillGraphs = normalizedStatements()["dojo_skill_graphs"];
    const nodeMemories = normalizedStatements()["dojo_node_memories"];
    const graphRuns = normalizedStatements()["dojo_graph_execution_runs"];
    const licenseVersions = normalizedStatements()["dojo_license_versions"];

    expect(skillGraphs).toContain("primary key (tenant_id, workspace_id, graph_id)");
    expect(skillGraphs).toContain(
      "foreign key (tenant_id, skill_id, skill_version) references dojo_skill_versions(tenant_id, skill_id, skill_version) on delete cascade"
    );
    expect(skillGraphs).toContain("check (status in ('draft', 'checkride', 'licensed', 'expired', 'revoked'))");
    expect(nodeMemories).toContain("primary key (tenant_id, workspace_id, graph_id, node_id)");
    expect(nodeMemories).toContain(
      "foreign key (tenant_id, workspace_id, graph_id) references dojo_skill_graphs(tenant_id, workspace_id, graph_id) on delete cascade"
    );
    expect(nodeMemories).toContain("check (confidence is null or (confidence >= 0 and confidence <= 1))");
    expect(graphRuns).toContain("primary key (tenant_id, workspace_id, graph_run_id)");
    expect(graphRuns).toContain(
      "foreign key (tenant_id, workspace_id, graph_id) references dojo_skill_graphs(tenant_id, workspace_id, graph_id) on delete restrict"
    );
    expect(graphRuns).toContain("check (mode in ('practice', 'checkride', 'shadow', 'production'))");
    expect(graphRuns).toContain("check (status in ('completed', 'blocked', 'failed', 'paused'))");
    expect(licenseVersions).toContain("primary key (tenant_id, workspace_id, license_id, license_version)");
    expect(licenseVersions).toContain("check (readiness_level >= 0 and readiness_level <= 9)");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_graph_execution_runs_graph_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_graph_execution_runs_skill_idx");
  });

  it("defines executable checkride and scenario run registries", () => {
    const checkrideRuns = normalizedStatements()["dojo_checkride_runs"];
    const scenarioRuns = normalizedStatements()["dojo_scenario_runs"];

    expect(checkrideRuns).toContain("primary key (tenant_id, workspace_id, checkride_run_id)");
    expect(checkrideRuns).toContain(
      "foreign key (tenant_id, skill_id, skill_version) references dojo_skill_versions(tenant_id, skill_id, skill_version) on delete restrict"
    );
    expect(checkrideRuns).toContain("check (status in ('queued', 'running', 'passed', 'failed', 'blocked', 'canceled'))");
    expect(scenarioRuns).toContain("primary key (tenant_id, workspace_id, scenario_run_id)");
    expect(scenarioRuns).toContain(
      "foreign key (tenant_id, workspace_id, checkride_run_id) references dojo_checkride_runs(tenant_id, workspace_id, checkride_run_id) on delete restrict"
    );
    expect(scenarioRuns).toContain("check (oracle_status in ('pass', 'fail', 'block', 'needs_human'))");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_checkride_runs_skill_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_scenario_runs_checkride_idx");
  });

  it("defines governance case-law, antibody, and approval registries", () => {
    const caseLaw = normalizedStatements()["dojo_case_law"];
    const antibodies = normalizedStatements()["dojo_antibodies"];
    const approvals = normalizedStatements()["dojo_approvals"];

    expect(caseLaw).toContain("primary key (tenant_id, workspace_id, case_id)");
    expect(caseLaw).toContain("applies_to text[] not null default array[]::text[]");
    expect(caseLaw).toContain("check (binding_scope_kind in ('tenant', 'organization', 'workspace', 'skill'))");
    expect(caseLaw).toContain("check (status in ('proposed', 'approved', 'deprecated'))");
    expect(caseLaw).toContain("check (cardinality(evidence_refs) > 0)");
    expect(antibodies).toContain("primary key (tenant_id, workspace_id, antibody_id)");
    expect(antibodies).toContain(
      "foreign key (tenant_id, workspace_id, source_case_id) references dojo_case_law(tenant_id, workspace_id, case_id) on delete restrict"
    );
    expect(antibodies).toContain("guardrail_predicate text not null");
    expect(approvals).toContain("primary key (tenant_id, workspace_id, approval_id)");
    expect(approvals).toContain("workflow_id text not null");
    expect(approvals).toContain("license_version text not null");
    expect(approvals).toContain("current_entrustment_level text not null");
    expect(approvals).toContain("check (status in ('pending', 'approved', 'denied', 'superseded'))");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_case_law_scope_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_case_law_applies_to_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_approvals_status_idx");
    expect(normalizedSql(dojoPostgresMigrationSql())).toContain("create index if not exists dojo_approvals_workflow_idx");
  });

  it("defines MCP skill-bus registration, invocation, and conformance custody", () => {
    const toolRegistrations = normalizedStatements()["dojo_tool_registrations"];
    const toolInvocations = normalizedStatements()["dojo_tool_invocations"];
    const conformanceResults = normalizedStatements()["dojo_mcp_host_conformance_results"];

    expect(toolRegistrations).toContain("primary key (tenant_id, workspace_id, tool_registration_id)");
    expect(toolRegistrations).toContain("unique (tenant_id, workspace_id, tool_name, tool_version)");
    expect(toolRegistrations).toContain("proof_required boolean not null default true");
    expect(toolRegistrations).toContain("check (direct_call_policy in ('blocked', 'dojo_dispatcher_only', 'practice_only'))");
    expect(toolInvocations).toContain("primary key (tenant_id, workspace_id, invocation_id)");
    expect(toolInvocations).toContain(
      "foreign key (tenant_id, workspace_id, tool_registration_id) references dojo_tool_registrations(tenant_id, workspace_id, tool_registration_id) on delete restrict"
    );
    expect(toolInvocations).toContain("check (status in ('allowed', 'blocked', 'failed', 'completed'))");
    expect(conformanceResults).toContain("primary key (tenant_id, workspace_id, conformance_result_id)");
    expect(conformanceResults).toContain("check (host_kind in ('local_loopback', 'deployed_non_loopback'))");
    expect(conformanceResults).toContain("check (report_sha256 ~ '^[a-fa-f0-9]{64}$')");
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
