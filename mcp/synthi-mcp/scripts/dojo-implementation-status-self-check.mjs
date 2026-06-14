#!/usr/bin/env node
/*
 * Build digest-backed evidence for the Agent Dojo implementation-status
 * truth baseline. This gate proves the status registry, maturity manifest, and
 * current claim boundaries remain synchronized with unit coverage.
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

export const DOJO_IMPLEMENTATION_STATUS_TEST_FILES = [
  "tests/unit/dojo_implementation_status.test.ts",
];

export const DOJO_IMPLEMENTATION_STATUS_CAPABILITIES = [
  "status_vocabulary_stable",
  "all_dojo_tools_classified",
  "maturity_manifest_synced",
  "unknown_tools_default_planned",
  "graph_projection_and_vivarium_runtime_boundary",
  "proof_dispatch_declares_hosted_runtime_boundary",
  "ghost_mode_non_mutating_shadow_boundary",
  "control_plane_writes_not_runtime_enforcement",
  "report_artifacts_do_not_overclaim_runtime",
  "proof_issuing_evidence_aware_signer_configurable",
  "metadata_clone_prevents_registry_mutation",
  "no_mature_production_runtime_claims",
  "executable_surfaces_precise_runtime_scope",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-implementation-status"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo implementation-status evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoImplementationStatusSelfCheck({ outDir });
  console.log(`[ok] Dojo implementation-status self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoImplementationStatusSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 60000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-implementation-status"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_IMPLEMENTATION_STATUS_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing implementation-status test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-implementation-status.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo implementation-status evidence self-check builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_IMPLEMENTATION_STATUS_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-implementation-status.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-implementation-status.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoImplementationStatusEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-implementation-status.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_implementation_status_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoImplementationStatusEvidenceManifest({
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
  timeoutMs = 60000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildImplementationStatusCapabilityCoverage({
    capabilities: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildImplementationStatusBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.implementationStatusEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    implementation_status_contract: {
      stable_vocabulary_required: true,
      every_tool_classified_required: true,
      machine_manifest_sync_required: true,
      unknown_tool_fails_planned_required: true,
      production_runtime_claim_boundary_required: true,
      runtime_scope_required_for_executable_required: true,
      report_surface_no_overclaim_required: true,
      proof_dispatch_hosted_runtime_boundary_required: true,
      ghost_mode_non_mutating_boundary_required: true,
      control_plane_write_boundary_required: true,
      immutable_metadata_required: true,
    },
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    budget_evaluation: budgetEvaluation,
    json_report_path: jsonReportPath ?? null,
    json_report_sha256: jsonReportText ? sha256(jsonReportText) : null,
    json_report_bytes: jsonReportText ? Buffer.byteLength(jsonReportText) : 0,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...(error ? { error } : {}),
  };
}

function buildImplementationStatusCapabilityCoverage({ capabilities, jsonReport }) {
  const assertions = assertionTitles(jsonReport);
  return capabilities.map((capability) => {
    const matcher = CAPABILITY_MATCHERS[capability];
    const matches = assertions.filter((title) => matcher?.(title) === true);
    return {
      capability,
      covered: matches.length > 0,
      matched_assertions: matches,
    };
  });
}

function buildImplementationStatusBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
  const checks = {
    no_report_error: !error,
    no_failed_tests: testSummary.failed_tests === 0,
    no_skipped_tests: testSummary.pending_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    all_test_files_reported: testSummary.reported_test_file_count === testFiles.length,
    self_check_within_timeout: durationMs <= timeoutMs,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    failed_checks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  };
}

function assertionTitles(jsonReport) {
  return (jsonReport?.testResults ?? [])
    .flatMap((result) => result.assertionResults ?? [])
    .map((assertion) => String(assertion.fullName || assertion.title || ""))
    .filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const includes = (...needles) => (title) => {
  const normalized = title.toLowerCase();
  return needles.every((needle) => normalized.includes(needle));
};

const CAPABILITY_MATCHERS = {
  status_vocabulary_stable: includes("stable maturity status vocabulary"),
  all_dojo_tools_classified: includes("classifies every current dojo mcp tool"),
  maturity_manifest_synced: includes("machine-readable maturity manifest", "sync"),
  unknown_tools_default_planned: includes("does not classify unknown tool names as executable"),
  graph_projection_and_vivarium_runtime_boundary: includes("graph report surfaces", "vivarium runs", "executable fixtures"),
  proof_dispatch_declares_hosted_runtime_boundary: includes("proof-gated execution path", "hosted runtime authorization"),
  ghost_mode_non_mutating_shadow_boundary: includes("ghost mode", "non-mutating executable shadow-evidence"),
  control_plane_writes_not_runtime_enforcement: includes("permission upgrade requests", "control-plane writes"),
  report_artifacts_do_not_overclaim_runtime: includes("report artifacts", "without implying mature runtime backing"),
  proof_issuing_evidence_aware_signer_configurable: includes("proof issuing", "evidence-aware", "production signer configurable"),
  metadata_clone_prevents_registry_mutation: includes("cloned metadata", "cannot mutate the registry"),
  no_mature_production_runtime_claims: includes("does not currently claim mature production runtime execution"),
  executable_surfaces_precise_runtime_scope: includes("executable surfaces", "precise non-empty runtime scope"),
};
