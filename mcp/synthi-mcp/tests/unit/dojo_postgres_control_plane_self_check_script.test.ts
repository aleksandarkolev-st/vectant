// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildControlPlaneCapabilityCoverage,
  buildDojoPostgresControlPlaneEvidenceManifest,
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "../../scripts/dojo-postgres-control-plane-self-check.mjs";

describe("Dojo Postgres control-plane self-check script", () => {
  it("maps Vitest assertion titles to every durable control-plane capability", () => {
    const coverage = buildControlPlaneCapabilityCoverage({
      capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
      jsonReport: postgresVitestReportFixture(),
    });

    expect(coverage).toHaveLength(DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length);
    expect(coverage.every((item) => item.covered)).toBe(true);
    expect(coverage.map((item) => item.capability)).toEqual(DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES);
  });

  it("builds redacted evidence and fails closed when the Postgres URL is missing", () => {
    const evidence = buildDojoPostgresControlPlaneEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: null,
      signal: null,
      durationMs: 0,
      basicRunDurationMs: null,
      testFiles: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
      stdout: "",
      stderr: "SYNTHI_DOJO_POSTGRES_TEST_URL is required\n",
      stdoutPath: "/tmp/dojo-postgres-control-plane.stdout.log",
      stderrPath: "/tmp/dojo-postgres-control-plane.stderr.log",
      jsonReport: null,
      jsonReportPath: "/tmp/dojo-postgres-control-plane.vitest.json",
      jsonReportText: "",
      postgresUrl: "",
      error: "postgres_test_url_missing",
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.postgres_url_configured).toBe(false);
    expect(evidence.postgres_connection).toEqual({ configured: false, parseable: false });
    expect(evidence.budget_evaluation.checks.postgres_url_configured).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain("password");
  });

  it("redacts password-bearing Postgres URLs from evidence", () => {
    const evidence = buildDojoPostgresControlPlaneEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 100,
      basicRunDurationMs: 50,
      testFiles: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
      stdout: "ok\n",
      stderr: "",
      stdoutPath: "/tmp/stdout.log",
      stderrPath: "/tmp/stderr.log",
      jsonReport: postgresVitestReportFixture(),
      jsonReportPath: "/tmp/report.json",
      jsonReportText: JSON.stringify(postgresVitestReportFixture()),
      postgresUrl: "postgres://user:super-secret@127.0.0.1:15432/synthi",
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.postgres_connection).toEqual(expect.objectContaining({
      configured: true,
      parseable: true,
      host_class: "loopback",
      password_configured: true,
      password_redacted: true,
    }));
    expect(JSON.stringify(evidence)).not.toContain("super-secret");
    expect(JSON.stringify(evidence)).not.toContain("127.0.0.1:15432");
  });
});

function postgresVitestReportFixture() {
  const fileTitles = [
    [
      "Dojo Postgres schema migration emits repeat-safe DDL for each required foundation table",
      "Dojo Postgres schema migration defines release-scoped source snapshot custody",
      "Dojo Postgres schema migration defines graph, node-memory, and license-version registries",
      "Dojo Postgres schema migration defines executable checkride and scenario run registries",
      "Dojo Postgres schema migration defines governance case-law, antibody, and approval registries",
      "Dojo Postgres schema migration defines MCP skill-bus registration, invocation, and conformance custody",
    ],
    [
      "PostgresDojoProofStore persists, reads, lists, and revokes proof records by tenant scope",
      "PostgresDojoProofStore atomically consumes an issued proof exactly once",
      "PostgresDojoProofStore allows only one winner during concurrent proof consume",
      "PostgresDojoProofStore prevents cross-tenant proof reads",
    ],
    [
      "PostgresDojoEvidenceLedgerStore appends evidence records, advances checkpoints, and verifies the chain",
      "PostgresDojoEvidenceLedgerStore detects tampered evidence records",
    ],
    [
      "PostgresDojoAuditStore persists audit actor, request, correlation, entity, and details",
    ],
    [
      "PostgresDojoSkillStore persists skills and published workflow bindings by tenant scope",
      "PostgresDojoSkillStore persists skill version records and audit custody",
    ],
    [
      "PostgresDojoLicenseStore persists licenses and version history by tenant scope",
      "PostgresDojoLicenseStore revokes licenses with audit custody",
    ],
    [
      "Dojo tool Postgres control-plane wiring persists production durable skill publication and lists competencies from Postgres after local reset",
      "Dojo tool Postgres control-plane wiring revokes production licenses through Postgres and reads revoked license health after local reset",
      "Dojo tool Postgres control-plane wiring recertifies a production skill through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring persists permission upgrade request and review through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring persists case law proposal and review through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring records Ghost Mode shadow evidence through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring persists Vivarium scenario runs through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring persists Wind Tunnel scenario runs through Postgres after local reset",
      "Dojo tool Postgres control-plane wiring uses Postgres skill and proof records for production validation, consumption, and replay after local process loss",
    ],
    [
      "PostgresDojoGhostShadowEvidenceStore persists Ghost Mode shadow evidence by tenant scope and filters operational fields",
      "PostgresDojoGhostShadowEvidenceStore enforces tenant scope and rejects mutating evidence",
    ],
    [
      "PostgresDojoGovernanceStore persists permission-upgrade requests, filters them by governance fields, and emits audit events",
      "PostgresDojoGovernanceStore persists case law records, filters by binding scope and action, and emits audit events",
    ],
    [
      "PostgresDojoSourceRegistryStore persists verified app releases, source snapshots, source tokens, and audit events",
      "PostgresDojoSourceRegistryStore rejects tampered or unverified source snapshots before writing registry rows",
    ],
    [
      "PostgresDojoMcpSkillBusStore persists signed tool registrations and revocation state by tenant scope",
      "PostgresDojoMcpSkillBusStore records MCP tool invocations with audit custody",
    ],
    [
      "PostgresDojoGraphRunStore persists skill graphs, node memories, and graph execution runs",
      "PostgresDojoGraphRunStore persists executable checkride reports and scenario runs from observed runtime evidence",
    ],
    [
      "PostgresDojoHostedRuntimeSessionStore integration persists gateway-created hosted runtime sessions and revocation updates",
      "PostgresDojoHostedRuntimeSessionStore integration authorizes actions through a Postgres-backed hosted runtime session and persists evidence refs",
    ],
    [
      "Dojo hosted runtime gateway resolver Postgres integration selects the Postgres-backed hosted runtime gateway from control-plane env",
    ],
    [
      "PostgresDojoMcpHostConformanceStore persists conformance reports with digest custody and audit events",
      "PostgresDojoMcpHostConformanceStore filters conformance reports by host kind and status",
    ],
    [
      "Dojo proof issuance from Postgres evidence ledger issues a production proof capsule from evidence record IDs resolved through Postgres",
    ],
  ];
  const titles = fileTitles.flat();
  return {
    success: true,
    numTotalTests: titles.length,
    numPassedTests: titles.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: fileTitles.map((assertionTitles, fileIndex) => ({
        startTime: 1000 + fileIndex * 100,
        endTime: 1100 + fileIndex * 100,
        assertionResults: assertionTitles.map((fullName, index) => ({
          fullName,
          title: fullName,
          status: "passed",
          duration: index + 1,
        })),
      })),
  };
}
