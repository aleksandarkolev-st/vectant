#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for the Agent Dojo hosted runtime
 * gateway. The focused Vitest suites run first and this script validates their
 * JSON report before writing release-gate evidence.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES = [
  "tests/unit/dojo_hosted_runtime_gateway.test.ts",
  "tests/unit/dojo_hosted_runtime_gateway_resolver.test.ts",
  "tests/unit/dojo_hosted_runtime_postgres_store.test.ts",
];

export const DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES = [
  "hosted_runtime_normalizes_origin_allowlists",
  "hosted_runtime_creates_tenant_bound_short_lived_sessions_without_secret_persistence",
  "hosted_runtime_rejects_unsafe_session_configuration_before_credentials",
  "hosted_runtime_requires_skill_and_run_binding",
  "hosted_runtime_rejects_invalid_timestamps_as_auditable_blocks",
  "hosted_runtime_blocks_local_network_without_explicit_egress_opt_in",
  "hosted_runtime_authorizes_only_matching_context_and_writes_evidence",
  "hosted_runtime_blocks_credential_origin_egress_and_run_mismatch",
  "hosted_runtime_fails_closed_when_evidence_writer_missing",
  "hosted_runtime_requires_revocation_reason",
  "hosted_runtime_blocks_expired_and_revoked_sessions",
  "hosted_runtime_resolver_provides_development_memory_mode",
  "hosted_runtime_resolver_requires_production_capable_durable_store",
  "hosted_runtime_resolver_uses_explicit_postgres_control_plane_env",
  "hosted_runtime_postgres_store_persists_and_lists_tenant_scoped_sessions",
  "hosted_runtime_postgres_store_rejects_cross_scope_writes",
  "hosted_runtime_postgres_store_rejects_malformed_records",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-hosted-runtime-gateway"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo hosted runtime gateway output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoHostedRuntimeGatewaySelfCheck({ outDir });
  console.log(`[ok] Dojo hosted runtime gateway self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoHostedRuntimeGatewaySelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-hosted-runtime-gateway"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing hosted runtime gateway test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-hosted-runtime-gateway.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo hosted runtime gateway self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-hosted-runtime-gateway.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-hosted-runtime-gateway.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoHostedRuntimeGatewayEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    jsonReportText,
    timeoutMs,
    error: jsonReportError,
  });
  const evidencePath = path.join(outputDir, "dojo-hosted-runtime-gateway.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_hosted_runtime_gateway_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoHostedRuntimeGatewayEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  testFiles,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  jsonReport,
  jsonReportPath,
  jsonReportText,
  timeoutMs = 120000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildHostedRuntimeGatewayCapabilityCoverage({
    capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildHostedRuntimeGatewayBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    hosted_runtime_contract: {
      tenant_scoped_sessions_required: true,
      short_lived_credentials_required: true,
      stored_secret_redaction_required: true,
      origin_allowlist_required: true,
      local_network_policy_required: true,
      screenshot_redaction_required: true,
      skill_run_binding_required: true,
      audit_events_required: true,
      evidence_write_required: true,
      fail_closed_on_missing_evidence_writer_required: true,
      revocation_and_expiry_required: true,
      durable_store_production_requirement_required: true,
      postgres_session_store_required: true,
      malformed_record_rejection_required: true,
    },
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
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
    ...(error ? { error } : {}),
  };
}

export function buildHostedRuntimeGatewayCapabilityCoverage({ capabilities, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return capabilities.map((capability) => {
    const matchers = capabilityMatchers(capability);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizeText(title);
      return matchers.every((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      capability,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildHostedRuntimeGatewayBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
  const checks = {
    no_report_error: !error,
    no_failed_tests: testSummary.failed_tests === 0,
    no_skipped_tests: testSummary.pending_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    all_test_files_reported: testSummary.reported_test_file_count === testFiles.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    self_check_within_timeout: durationMs <= timeoutMs,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    failed_checks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  };
}

function capabilityMatchers(capability) {
  switch (capability) {
    case "hosted_runtime_normalizes_origin_allowlists":
      return ["normalizes origin allowlists", "url origin"];
    case "hosted_runtime_creates_tenant_bound_short_lived_sessions_without_secret_persistence":
      return ["creates tenant bound short lived sessions", "without exposing credential secrets"];
    case "hosted_runtime_rejects_unsafe_session_configuration_before_credentials":
      return ["rejects unsafe session configuration", "before credentials are issued"];
    case "hosted_runtime_requires_skill_and_run_binding":
      return ["rejects sessions", "not bound to a skill and run"];
    case "hosted_runtime_rejects_invalid_timestamps_as_auditable_blocks":
      return ["rejects invalid timestamps", "auditable blocks"];
    case "hosted_runtime_blocks_local_network_without_explicit_egress_opt_in":
      return ["rejects local network hosted sessions", "unless egress is explicitly allowed"];
    case "hosted_runtime_authorizes_only_matching_context_and_writes_evidence":
      return ["authorizes runtime actions only with matching tenant skill run origin credential", "evidence write"];
    case "hosted_runtime_blocks_credential_origin_egress_and_run_mismatch":
      return ["blocks action attempts", "wrong credentials", "origin drift", "local network egress", "run mismatch"];
    case "hosted_runtime_fails_closed_when_evidence_writer_missing":
      return ["fails closed", "evidence cannot be written"];
    case "hosted_runtime_requires_revocation_reason":
      return ["rejects empty revocation reasons"];
    case "hosted_runtime_blocks_expired_and_revoked_sessions":
      return ["expires and revokes sessions", "before authorizing further actions"];
    case "hosted_runtime_resolver_provides_development_memory_mode":
      return ["resolver uses an in memory hosted runtime store", "development compatibility"];
    case "hosted_runtime_resolver_requires_production_capable_durable_store":
      return ["resolver fails closed", "production requires", "durable control plane store"];
    case "hosted_runtime_resolver_uses_explicit_postgres_control_plane_env":
      return ["resolver resolves postgres connection strings", "explicit control plane env"];
    case "hosted_runtime_postgres_store_persists_and_lists_tenant_scoped_sessions":
      return ["postgresdojohostedruntimesessionstore saves reads updates and lists", "tenant scoped runtime sessions"];
    case "hosted_runtime_postgres_store_rejects_cross_scope_writes":
      return ["postgresdojohostedruntimesessionstore rejects writes", "configured tenant and workspace scope"];
    case "hosted_runtime_postgres_store_rejects_malformed_records":
      return ["postgresdojohostedruntimesessionstore rejects malformed runtime session records"];
    default:
      return [normalizeText(capability)];
  }
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}
