#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo Ghost Mode:
 * non-mutating shadow runs, mismatch entrustment blocking, audit custody,
 * compliance-pack visibility, and durable tenant-scoped shadow evidence.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";
import {
  runVitestJsonForSelfCheck,
  shouldRunVitestForSelfCheck,
} from "./dojo-vitest-self-check-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_GHOST_MODE_EVIDENCE_TEST_FILES = [
  "tests/unit/dojo_ghost_mode_tool.test.ts",
  "tests/integration/dojo_postgres_ghost_shadow_evidence_store.test.ts",
];

export const DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES = [
  "ghost_mode_runs_without_production_mutation",
  "ghost_mode_records_shadow_evidence",
  "ghost_mode_records_audit_custody",
  "ghost_mode_blocks_mismatch_entrustment_upgrade",
  "ghost_mode_surfaces_shadow_evidence_in_compliance_pack",
  "postgres_ghost_shadow_persists_tenant_scoped_evidence",
  "postgres_ghost_shadow_filters_operational_fields",
  "postgres_ghost_shadow_enforces_tenant_boundaries",
  "postgres_ghost_shadow_rejects_mutating_evidence",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-ghost-mode-evidence"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo Ghost Mode evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoGhostModeEvidenceSelfCheck({ outDir });
  console.log(`[ok] Dojo Ghost Mode evidence self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoGhostModeEvidenceSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-ghost-mode-evidence"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Ghost Mode evidence test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-ghost-mode-evidence.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
      jsonReportPath,
      timeoutMs,
      cwd: MCP_ROOT,
    })
    : null;
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const builderSummary = [
    "Dojo Ghost Mode evidence self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun?.stdout ? `${builderSummary}${testRun.stdout}` : builderSummary;
  const stderrParts = [];
  if (testRun?.stderr) stderrParts.push(testRun.stderr);
  if (jsonReportError) stderrParts.push(jsonReportError);
  const stderr = stderrParts.length > 0 ? `${stderrParts.join("\n")}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-ghost-mode-evidence.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-ghost-mode-evidence.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoGhostModeEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    jsonReportText,
    timeoutMs,
    error: jsonReportError ?? testRun?.error,
    testRun,
  });
  const evidencePath = path.join(outputDir, "dojo-ghost-mode-evidence.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_ghost_mode_evidence_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoGhostModeEvidenceManifest({
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
  testRun,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildGhostModeCapabilityCoverage({
    capabilities: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildGhostModeBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.ghostModeEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    ghost_mode_contract: {
      non_mutating_shadow_run_required: true,
      shadow_evidence_record_required: true,
      audit_custody_required: true,
      mismatch_entrustment_block_required: true,
      compliance_pack_visibility_required: true,
      durable_shadow_evidence_store_required: true,
      tenant_boundary_required: true,
      production_mutation_rejection_required: true,
      operational_filtering_required: true,
      self_check_executes_tests_required: true,
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
    test_execution: testRun
      ? {
        command: testRun.command,
        args: testRun.args,
        exit_code: testRun.exitCode,
        signal: testRun.signal ?? null,
        duration_ms: Number(testRun.durationMs.toFixed(3)),
        timed_out: testRun.timedOut,
        stdout_sha256: sha256(testRun.stdout),
        stderr_sha256: sha256(testRun.stderr),
        stdout_bytes: Buffer.byteLength(testRun.stdout),
        stderr_bytes: Buffer.byteLength(testRun.stderr),
      }
      : null,
    ...(error ? { error } : {}),
  };
}

function buildGhostModeCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildGhostModeBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
  ghost_mode_runs_without_production_mutation: includes("records non-mutating shadow evidence"),
  ghost_mode_records_shadow_evidence: includes("records non-mutating shadow evidence", "shadow evidence"),
  ghost_mode_records_audit_custody: includes("audit custody"),
  ghost_mode_blocks_mismatch_entrustment_upgrade: includes("mismatch entrustment block"),
  ghost_mode_surfaces_shadow_evidence_in_compliance_pack: includes("compliance-pack visibility"),
  postgres_ghost_shadow_persists_tenant_scoped_evidence: includes("persists ghost mode shadow evidence", "tenant scope"),
  postgres_ghost_shadow_filters_operational_fields: includes("filters operational fields"),
  postgres_ghost_shadow_enforces_tenant_boundaries: includes("enforces tenant scope"),
  postgres_ghost_shadow_rejects_mutating_evidence: includes("rejects mutating evidence"),
};
