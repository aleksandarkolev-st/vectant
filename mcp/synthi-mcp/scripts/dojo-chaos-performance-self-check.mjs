#!/usr/bin/env node
/*
 * Lightweight Dojo T8 gate. It does not replace the long-running soak harness;
 * it proves the chaos/fault paths are executable and emits timing evidence that
 * nightly jobs can compare over time.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_CHAOS_PERFORMANCE_TEST_FILES = [
  "tests/unit/dojo_fixture_materializer.test.ts",
  "tests/integration/dojo_api_fault_server.test.ts",
  "tests/integration/dojo_vivarium_runner.test.ts",
  "tests/integration/dojo_checkride_runner.test.ts",
  "tests/integration/dojo_evil_twin_runner.test.ts",
];

export const DOJO_CHAOS_SCENARIOS = [
  "api_timeout",
  "partial_write",
  "fake_success_ui",
  "validation_error",
  "downstream_failure",
  "duplicate_entity_fixture",
  "prompt_injection_fixture",
  "runtime_oracle_classification",
  "evil_twin_attack_hardening",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-chaos-performance"));
  const artifacts = await runDojoChaosPerformanceSelfCheck({ outDir });
  console.log(`[ok] Dojo chaos/performance self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoChaosPerformanceSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-chaos-performance"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_CHAOS_PERFORMANCE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing chaos/performance test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const started = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const basicRunDurationMs = performance.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-chaos-performance.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-chaos-performance.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-chaos-performance.vitest.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const jsonStdout = String(jsonResult.stdout ?? "");
  const jsonStderr = String(jsonResult.stderr ?? "");
  await writeFile(path.join(outputDir, "dojo-chaos-performance.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-chaos-performance.json-reporter.stderr.log"), jsonStderr);
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReport = jsonReportError ? null : await readVitestJsonReport(jsonReportPath);
  const durationMs = performance.now() - started;
  const evidence = buildDojoChaosPerformanceEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    scenarios: DOJO_CHAOS_SCENARIOS,
    stdout,
    stderr: [stderr, jsonStderr].filter(Boolean).join("\n"),
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    timeoutMs,
    error: result.error?.message ?? jsonResult.error?.message ?? jsonReportError,
  });
  const evidencePath = path.join(outputDir, "dojo-chaos-performance.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (result.error) throw new Error(`dojo_chaos_performance_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_chaos_performance_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_chaos_performance_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_chaos_performance_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_chaos_performance_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoChaosPerformanceEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  basicRunDurationMs,
  testFiles,
  scenarios,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  jsonReport,
  jsonReportPath,
  timeoutMs = 120000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const scenarioCoverage = buildScenarioCoverage({ scenarios, jsonReport });
  const performanceMetrics = buildPerformanceMetrics({ durationMs, testSummary });
  const budgetEvaluation = buildBudgetEvaluation({
    scenarioCoverage,
    performanceMetrics,
    testSummary,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_chaos_scenarios: [...scenarios],
    tested_chaos_scenarios: scenarioCoverage.filter((item) => item.covered).map((item) => item.scenario),
    missing_chaos_scenarios: scenarioCoverage.filter((item) => !item.covered).map((item) => item.scenario),
    scenario_coverage: scenarioCoverage,
    scenario_count: scenarioCoverage.filter((item) => item.covered).length,
    configured_scenario_count: scenarios.length,
    scenario_coverage_complete: scenarioCoverage.every((item) => item.covered),
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    performance_metrics: performanceMetrics,
    basic_run_duration_ms: typeof basicRunDurationMs === "number" ? Number(basicRunDurationMs.toFixed(3)) : null,
    budget_evaluation: budgetEvaluation,
    json_report_path: jsonReportPath ?? null,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    budget: {
      self_check_timeout_ms: timeoutMs,
      intended_gate: "lightweight_preflight_not_long_soak",
    },
    ...(error ? { error } : {}),
  };
}

export function summarizeVitestJsonReport(report) {
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = testResults.flatMap((result) => Array.isArray(result.assertionResults) ? result.assertionResults : []);
  const assertionDurations = assertions
    .map((assertion) => Number(assertion.duration))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const fileDurations = testResults
    .map((result) => Number(result.endTime) - Number(result.startTime))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    success: report?.success === true,
    total_tests: numberOrZero(report?.numTotalTests),
    passed_tests: numberOrZero(report?.numPassedTests),
    failed_tests: numberOrZero(report?.numFailedTests),
    pending_tests: numberOrZero(report?.numPendingTests),
    total_suites: numberOrZero(report?.numTotalTestSuites),
    passed_suites: numberOrZero(report?.numPassedTestSuites),
    failed_suites: numberOrZero(report?.numFailedTestSuites),
    reported_test_file_count: testResults.length,
    assertion_duration_p95_ms: percentile(assertionDurations, 0.95),
    test_file_duration_p95_ms: percentile(fileDurations, 0.95),
    assertion_titles: assertions.map((assertion) => String(assertion.fullName || assertion.title || "")).filter(Boolean),
  };
}

export function buildScenarioCoverage({ scenarios, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return scenarios.map((scenario) => {
    const matchers = scenarioMatchers(scenario);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizeScenarioText(title);
      return matchers.some((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      scenario,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildPerformanceMetrics({ durationMs, testSummary }) {
  return {
    self_check_duration_ms: Number(durationMs.toFixed(3)),
    test_case_duration_p95_ms: testSummary.assertion_duration_p95_ms,
    test_file_duration_p95_ms: testSummary.test_file_duration_p95_ms,
    failed_test_count: testSummary.failed_tests,
    passed_test_count: testSummary.passed_tests,
  };
}

function buildBudgetEvaluation({ scenarioCoverage, performanceMetrics, testSummary, timeoutMs, error }) {
  const checks = {
    no_spawn_error: !error,
    no_failed_tests: testSummary.failed_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    scenario_coverage_complete: scenarioCoverage.every((item) => item.covered),
    self_check_within_timeout: performanceMetrics.self_check_duration_ms <= timeoutMs,
    test_case_p95_recorded: Number.isFinite(performanceMetrics.test_case_duration_p95_ms),
    test_file_p95_recorded: Number.isFinite(performanceMetrics.test_file_duration_p95_ms),
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

async function readVitestJsonReport(jsonReportPath) {
  const raw = await readFile(jsonReportPath, "utf8");
  return JSON.parse(raw);
}

function scenarioMatchers(scenario) {
  const normalized = normalizeScenarioText(scenario);
  const aliases = {
    api_timeout: ["timeout"],
    partial_write: ["partial write"],
    fake_success_ui: ["fake visual success", "fake success"],
    validation_error: ["validation error"],
    downstream_failure: ["downstream failure"],
    duplicate_entity_fixture: ["duplicate", "duplicate entity"],
    prompt_injection_fixture: ["prompt injection"],
    runtime_oracle_classification: ["oracle", "classifies"],
    evil_twin_attack_hardening: ["evil twin", "attack hardening", "hardening"],
  };
  return [...new Set([normalized, ...(aliases[scenario] ?? [])].map(normalizeScenarioText))];
}

function normalizeScenarioText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(3));
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
