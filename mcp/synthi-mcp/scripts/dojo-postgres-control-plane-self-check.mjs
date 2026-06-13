#!/usr/bin/env node
/*
 * Run the durable Agent Dojo Postgres control-plane gate and emit a
 * digest-backed evidence manifest. This gate intentionally requires a real
 * Postgres test URL so durable proof consume, evidence ledger, audit events,
 * and proof issuance cannot be hidden behind skipped integration tests.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES = [
  "tests/integration/dojo_postgres_schema.test.ts",
  "tests/integration/dojo_postgres_proof_store.test.ts",
  "tests/integration/dojo_evidence_ledger_store.test.ts",
  "tests/integration/dojo_audit_store.test.ts",
  "tests/integration/dojo_postgres_skill_store.test.ts",
  "tests/integration/dojo_postgres_license_store.test.ts",
  "tests/integration/dojo_postgres_tool_control_plane.test.ts",
  "tests/integration/dojo_postgres_governance_store.test.ts",
  "tests/integration/dojo_postgres_source_registry_store.test.ts",
  "tests/integration/dojo_postgres_mcp_skill_bus_store.test.ts",
  "tests/integration/dojo_postgres_graph_run_store.test.ts",
  "tests/integration/dojo_postgres_hosted_runtime_store.test.ts",
  "tests/integration/dojo_hosted_runtime_gateway_resolver.test.ts",
  "tests/integration/dojo_postgres_mcp_host_conformance_store.test.ts",
  "tests/integration/dojo_proof_ledger_tool.test.ts",
];

export const DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES = [
  "durable_proof_store",
  "atomic_proof_consume",
  "concurrent_replay_prevention",
  "tenant_isolation",
  "maturity_control_plane_schema",
  "source_snapshot_registry_schema",
  "source_registry_repository",
  "graph_registry_schema",
  "graph_run_repository",
  "executable_run_registry_schema",
  "governance_registry_schema",
  "governance_repository",
  "mcp_skill_bus_registry_schema",
  "mcp_skill_bus_repository",
  "runtime_session_repository",
  "mcp_host_conformance_repository",
  "evidence_ledger_append_verify",
  "evidence_tamper_detection",
  "audit_event_repository",
  "skill_repository",
  "license_repository",
  "tool_control_plane_publish_read_path",
  "tool_control_plane_proof_lifecycle_path",
  "postgres_evidence_proof_issuance",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-postgres-control-plane"));
  const artifacts = await runDojoPostgresControlPlaneSelfCheck({ outDir });
  console.log(`[ok] Dojo Postgres control-plane self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoPostgresControlPlaneSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
  env = process.env,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-postgres-control-plane"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Postgres control-plane test files: ${missing.join(", ")}`);

  const postgresUrl = String(env.SYNTHI_DOJO_POSTGRES_TEST_URL || "").trim();
  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);

  if (!postgresUrl) {
    const evidence = buildDojoPostgresControlPlaneEvidenceManifest({
      now,
      exitCode: null,
      signal: null,
      durationMs: 0,
      basicRunDurationMs: null,
      testFiles: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
      stdout: "",
      stderr: "SYNTHI_DOJO_POSTGRES_TEST_URL is required\n",
      stdoutPath: path.join(outputDir, "dojo-postgres-control-plane.stdout.log"),
      stderrPath: path.join(outputDir, "dojo-postgres-control-plane.stderr.log"),
      jsonReport: null,
      jsonReportPath: path.join(outputDir, "dojo-postgres-control-plane.vitest.json"),
      jsonReportText: "",
      timeoutMs,
      postgresUrl,
      error: "postgres_test_url_missing",
    });
    await writeEvidenceFiles({ outputDir, evidence, stdout: "", stderr: "SYNTHI_DOJO_POSTGRES_TEST_URL is required\n", jsonReportText: "" });
    throw new Error("dojo_postgres_control_plane_self_check_failed:postgres_test_url_missing");
  }

  const startedAt = performance.now();
  const baseEnv = {
    ...env,
    SYNTHI_DOJO_POSTGRES_TEST_URL: postgresUrl,
  };
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    env: baseEnv,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const basicRunDurationMs = performance.now() - startedAt;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-postgres-control-plane.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-postgres-control-plane.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-postgres-control-plane.vitest.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);

  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ], {
    cwd: MCP_ROOT,
    env: baseEnv,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const jsonStdout = String(jsonResult.stdout ?? "");
  const jsonStderr = String(jsonResult.stderr ?? "");
  await writeFile(path.join(outputDir, "dojo-postgres-control-plane.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-postgres-control-plane.json-reporter.stderr.log"), jsonStderr);

  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const evidence = buildDojoPostgresControlPlaneEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
    stdout,
    stderr: [stderr, jsonStderr].filter(Boolean).join("\n"),
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    jsonReportText,
    timeoutMs,
    postgresUrl,
    error: result.error?.message ?? jsonResult.error?.message ?? jsonReportError,
  });
  const evidencePath = await writeEvidenceFiles({
    outputDir,
    evidence,
    stdout,
    stderr: evidence.stderr_path === stderrPath ? stderr : [stderr, jsonStderr].filter(Boolean).join("\n"),
    jsonReportText,
  });
  if (result.error) throw new Error(`dojo_postgres_control_plane_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_postgres_control_plane_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_postgres_control_plane_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_postgres_control_plane_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_postgres_control_plane_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoPostgresControlPlaneEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  basicRunDurationMs,
  testFiles,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  jsonReport,
  jsonReportPath,
  jsonReportText,
  timeoutMs = 120000,
  postgresUrl,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildControlPlaneCapabilityCoverage({
    capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildPostgresControlPlaneBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    durationMs,
    timeoutMs,
    postgresUrl,
    error,
  });
  const redactedConnection = redactPostgresConnection(postgresUrl);
  return {
    schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    postgres_url_configured: Boolean(String(postgresUrl || "").trim()),
    postgres_connection: redactedConnection,
    env_requirements: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
    configured_capabilities: [...DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    basic_run_duration_ms: typeof basicRunDurationMs === "number" ? Number(basicRunDurationMs.toFixed(3)) : null,
    budget_evaluation: budgetEvaluation,
    json_report_path: jsonReportPath ?? null,
    json_report_sha256: sha256(jsonReportText ?? (jsonReport ? JSON.stringify(jsonReport) : "")),
    json_report_bytes: Buffer.byteLength(jsonReportText ?? (jsonReport ? JSON.stringify(jsonReport) : "")),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    budget: {
      self_check_timeout_ms: timeoutMs,
      intended_gate: "durable_control_plane_focused_integration",
    },
    ...(error ? { error } : {}),
  };
}

export function buildControlPlaneCapabilityCoverage({ capabilities, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return capabilities.map((capability) => {
    const matchers = capabilityMatchers(capability);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizeCapabilityText(title);
      return matchers.some((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      capability,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildPostgresControlPlaneBudgetEvaluation({ capabilityCoverage, testSummary, durationMs, timeoutMs, postgresUrl, error }) {
  const checks = {
    postgres_url_configured: Boolean(String(postgresUrl || "").trim()),
    no_spawn_error: !error,
    no_failed_tests: testSummary.failed_tests === 0,
    no_pending_tests: testSummary.pending_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    all_test_files_reported: testSummary.reported_test_file_count === DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    self_check_within_timeout: durationMs <= timeoutMs,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

async function writeEvidenceFiles({ outputDir, evidence, stdout, stderr, jsonReportText }) {
  const stdoutPath = path.join(outputDir, "dojo-postgres-control-plane.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-postgres-control-plane.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-postgres-control-plane.vitest.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  if (!existsSync(jsonReportPath)) await writeFile(jsonReportPath, jsonReportText || "");
  const evidencePath = path.join(outputDir, "dojo-postgres-control-plane.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return evidencePath;
}

function capabilityMatchers(capability) {
  const normalized = normalizeCapabilityText(capability);
  const aliases = {
    durable_proof_store: ["persists reads lists and revokes proof records", "postgresdojoproofstore persists"],
    atomic_proof_consume: ["atomically consumes an issued proof exactly once"],
    concurrent_replay_prevention: ["allows only one winner during concurrent proof consume"],
    tenant_isolation: ["prevents cross tenant proof reads", "isolates ledger reads by tenant"],
    maturity_control_plane_schema: ["emits repeat safe ddl for each required foundation table"],
    source_snapshot_registry_schema: ["defines release scoped source snapshot custody"],
    source_registry_repository: [
      "postgresdojosourceregistrystore persists verified app releases source snapshots source tokens and audit events",
      "postgresdojosourceregistrystore rejects tampered or unverified source snapshots",
    ],
    graph_registry_schema: ["defines graph node memory and license version registries"],
    graph_run_repository: [
      "postgresdojographrunstore persists skill graphs node memories and graph execution runs",
      "postgresdojographrunstore persists executable checkride reports and scenario runs",
    ],
    executable_run_registry_schema: ["defines executable checkride and scenario run registries"],
    governance_registry_schema: ["defines governance case law antibody and approval registries"],
    governance_repository: [
      "postgresdojogovernancestore persists permission upgrade requests",
      "postgresdojogovernancestore persists case law records",
    ],
    mcp_skill_bus_registry_schema: ["defines mcp skill bus registration invocation and conformance custody"],
    mcp_skill_bus_repository: [
      "postgresdojomcpskillbusstore persists signed tool registrations",
      "postgresdojomcpskillbusstore records mcp tool invocations with audit custody",
    ],
    runtime_session_repository: [
      "postgresdojohostedruntimesessionstore integration persists gateway created hosted runtime sessions and revocation updates",
      "postgresdojohostedruntimesessionstore integration authorizes actions through a postgres backed hosted runtime session",
      "dojo hosted runtime gateway resolver postgres integration selects the postgres backed hosted runtime gateway from control plane env",
    ],
    mcp_host_conformance_repository: [
      "postgresdojomcphostconformancestore persists conformance reports with digest custody",
      "postgresdojomcphostconformancestore filters conformance reports by host kind and status",
    ],
    evidence_ledger_append_verify: ["appends evidence records advances checkpoints and verifies the chain"],
    evidence_tamper_detection: ["detects tampered evidence records", "detects tampered ledger checkpoint"],
    audit_event_repository: ["persists audit actor request correlation entity and details", "records proof issue use rejection and revoke events"],
    skill_repository: [
      "postgresdojoskillstore persists skills and published workflow bindings by tenant scope",
      "postgresdojoskillstore persists skill version records and audit custody",
    ],
    license_repository: [
      "postgresdojolicensestore persists licenses and version history by tenant scope",
      "postgresdojolicensestore revokes licenses with audit custody",
    ],
    tool_control_plane_publish_read_path: [
      "dojo tool postgres control plane wiring persists production durable skill publication and lists competencies from postgres after local reset",
    ],
    tool_control_plane_proof_lifecycle_path: [
      "dojo tool postgres control plane wiring uses postgres skill and proof records for production validation consumption and replay after local process loss",
    ],
    postgres_evidence_proof_issuance: ["issues a production proof capsule from evidence record ids resolved through postgres"],
  };
  return [...new Set([normalized, ...(aliases[capability] ?? [])].map(normalizeCapabilityText))];
}

function redactPostgresConnection(value) {
  const text = String(value || "").trim();
  if (!text) {
    return {
      configured: false,
      parseable: false,
    };
  }
  try {
    const url = new URL(text);
    return {
      configured: true,
      parseable: true,
      protocol: url.protocol.replace(/:$/, ""),
      host_class: classifyHost(url.hostname),
      port_configured: Boolean(url.port),
      database_configured: Boolean(url.pathname && url.pathname !== "/"),
      username_configured: Boolean(url.username),
      password_configured: Boolean(url.password),
      password_redacted: true,
    };
  } catch (err) {
    return {
      configured: true,
      parseable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function classifyHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (!value) return "missing";
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(value)) return "loopback";
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return "private";
  const match = value.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return "private";
  return "remote_or_named";
}

function normalizeCapabilityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
