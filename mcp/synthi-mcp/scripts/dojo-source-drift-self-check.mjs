#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo source snapshot and
 * drift expiry coverage. The Vitest JSON report is produced by the release
 * gate command, then this script verifies the report covers every required
 * source-drift capability before writing evidence.
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

export const DOJO_SOURCE_DRIFT_TEST_FILES = [
  "tests/unit/dojo_source_snapshot.test.ts",
  "tests/unit/dojo_source_drift.test.ts",
];

export const DOJO_SOURCE_DRIFT_CAPABILITIES = [
  "source_snapshot_hashes_deterministically",
  "source_snapshot_scopes_tokens_by_release_commit",
  "source_snapshot_changes_hash_on_material_change",
  "source_snapshot_includes_source_content_hashes",
  "source_snapshot_rejects_invalid_hashes",
  "source_snapshot_rejects_duplicate_token_ids",
  "source_snapshot_detects_tampering_and_missing_keys",
  "source_drift_expires_changed_source_tokens",
  "source_drift_ignores_unrelated_token_change",
  "source_drift_marks_removed_tokens",
  "source_drift_expires_stable_token_content_change",
  "source_drift_reports_added_risky_affordances",
  "source_drift_rejects_unverified_snapshots",
  "source_drift_applies_license_store_expiry",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-source-drift"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo source drift output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoSourceDriftSelfCheck({ outDir });
  console.log(`[ok] Dojo source drift self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoSourceDriftSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-source-drift"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_SOURCE_DRIFT_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing source drift test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-source-drift.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo source drift self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_SOURCE_DRIFT_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-source-drift.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-source-drift.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoSourceDriftEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_SOURCE_DRIFT_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-source-drift.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_source_drift_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoSourceDriftEvidenceManifest({
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
  const capabilityCoverage = buildSourceDriftCapabilityCoverage({
    capabilities: DOJO_SOURCE_DRIFT_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildSourceDriftBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.sourceDriftEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_SOURCE_DRIFT_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    source_drift_contract: {
      release_scoped_snapshot_required: true,
      signed_snapshot_verification_required: true,
      source_content_hash_required: true,
      changed_token_expiry_required: true,
      removed_token_expiry_required: true,
      added_risky_affordance_review_required: true,
      unrelated_token_no_expiry_required: true,
      tamper_rejection_required: true,
      license_store_expiry_application_required: true,
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

export function buildSourceDriftCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildSourceDriftBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
    case "source_snapshot_hashes_deterministically":
      return ["hashes the same release scoped snapshot", "deterministically"];
    case "source_snapshot_scopes_tokens_by_release_commit":
      return ["scopes source tokens", "app release", "commit"];
    case "source_snapshot_changes_hash_on_material_change":
      return ["changes snapshot hash", "source token material"];
    case "source_snapshot_includes_source_content_hashes":
      return ["normalizes source content hashes", "signed snapshot material"];
    case "source_snapshot_rejects_invalid_hashes":
      return ["rejects invalid source content hashes"];
    case "source_snapshot_rejects_duplicate_token_ids":
      return ["rejects duplicate source token ids"];
    case "source_snapshot_detects_tampering_and_missing_keys":
      return ["detects tampered source snapshot material", "missing signing keys"];
    case "source_drift_expires_changed_source_tokens":
      return ["expires graph nodes", "changed source tokens"];
    case "source_drift_ignores_unrelated_token_change":
      return ["does not expire", "unrelated source tokens"];
    case "source_drift_marks_removed_tokens":
      return ["marks removed source tokens", "drift"];
    case "source_drift_expires_stable_token_content_change":
      return ["expires bound nodes", "source content changes", "stable token"];
    case "source_drift_reports_added_risky_affordances":
      return ["reports newly added risky affordances", "review"];
    case "source_drift_rejects_unverified_snapshots":
      return ["rejects drift reports", "unverifiable source snapshots"];
    case "source_drift_applies_license_store_expiry":
      return ["applies source drift expiry triggers", "license store"];
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
