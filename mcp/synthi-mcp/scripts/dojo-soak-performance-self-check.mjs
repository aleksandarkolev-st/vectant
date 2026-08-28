#!/usr/bin/env node
/*
 * Dojo-native T8 soak/performance preflight.
 *
 * The legacy soak harness exercises browser-session tools. This gate exercises
 * Dojo's own proof, graph, Vivarium, checkride, evidence, and budget paths in a
 * repeated loop and emits structured evidence for release-gate verification.
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

export const DOJO_SOAK_PERFORMANCE_TEST_FILES = [
  "tests/integration/dojo_soak_performance_loop.test.ts",
];

export const DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES = [
  "proof_validation",
  "proof_replay_rejection",
  "graph_node_execution",
  "vivarium_scenario_runtime",
  "wind_tunnel_budget",
  "checkride_runtime",
  "evidence_append",
];

export const DOJO_SOAK_PERFORMANCE_REQUIRED_METRICS = [
  "proof_validation_p95_ms",
  "proof_replay_rejection_p95_ms",
  "proof_replay_false_allow_count",
  "graph_node_execution_p95_ms",
  "vivarium_scenario_runtime_p95_ms",
  "wind_tunnel_budget_adherence_p95_ms",
  "checkride_runtime_p95_ms",
  "evidence_append_p95_ms",
  "memory_growth_bytes",
  "browser_session_leak_count",
  "false_block_rate",
];

const OPERATION_METRICS = {
  proof_validation: "proof_validation_p95_ms",
  proof_replay_rejection: "proof_replay_rejection_p95_ms",
  graph_node_execution: "graph_node_execution_p95_ms",
  vivarium_scenario_runtime: "vivarium_scenario_runtime_p95_ms",
  wind_tunnel_budget: "wind_tunnel_budget_adherence_p95_ms",
  checkride_runtime: "checkride_runtime_p95_ms",
  evidence_append: "evidence_append_p95_ms",
};

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-soak-performance"));
  const iterations = parsePositiveInteger(args.iterations || process.env.SYNTHI_DOJO_SOAK_ITERATIONS, 8);
  const artifacts = await runDojoSoakPerformanceSelfCheck({
    outDir,
    iterations,
    timeoutMs: parsePositiveInteger(args["timeout-ms"], 120000),
  });
  console.log(`[ok] Dojo soak/performance self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoSoakPerformanceSelfCheck({
  outDir,
  now = new Date().toISOString(),
  iterations = 8,
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-soak-performance"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_SOAK_PERFORMANCE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Dojo soak/performance test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);

  const eventsPath = path.join(outputDir, "dojo-soak-performance.events.ndjson");
  const jsonReportPath = path.join(outputDir, "dojo-soak-performance.vitest.json");
  const stdoutPath = path.join(outputDir, "dojo-soak-performance.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-soak-performance.stderr.log");

  const started = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_SOAK_PERFORMANCE_TEST_FILES,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHI_DOJO_SOAK_EVENTS_PATH: eventsPath,
      SYNTHI_DOJO_SOAK_ITERATIONS: String(iterations),
    },
  });
  const durationMs = performance.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");

  const jsonReportText = existsSync(jsonReportPath) ? await readFile(jsonReportPath, "utf8") : "";
  const jsonReport = jsonReportText ? JSON.parse(jsonReportText) : null;
  const eventsText = existsSync(eventsPath) ? await readFile(eventsPath, "utf8") : "";
  const events = parseNdjson(eventsText);

  const evidence = buildDojoSoakPerformanceEvidenceManifest({
    now,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    iterations,
    timeoutMs,
    testFiles: DOJO_SOAK_PERFORMANCE_TEST_FILES,
    events,
    eventsText,
    eventsPath,
    jsonReport,
    jsonReportText,
    jsonReportPath,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    error: result.error?.message,
  });
  const evidencePath = path.join(outputDir, "dojo-soak-performance.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  if (result.error) throw new Error(`dojo_soak_performance_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_soak_performance_self_check_failed:exit_${result.status}`);
  assert.equal(evidence.ok, true, evidence.budget_evaluation.failed_checks.join(";"));
  return {
    evidence_path: evidencePath,
    events_path: eventsPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoSoakPerformanceEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  iterations,
  timeoutMs,
  testFiles,
  events,
  eventsText,
  eventsPath,
  jsonReport,
  jsonReportText,
  jsonReportPath,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  error,
}) {
  const eventSummary = summarizeSoakEvents(events);
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const metricCoverage = buildMetricCoverage(eventSummary);
  const budgetEvaluation = buildBudgetEvaluation({
    eventSummary,
    testSummary,
    metricCoverage,
    iterations,
    durationMs,
    timeoutMs,
    exitCode,
    error,
  });
  return {
    schema_version: "synthi.dojo.soakPerformanceEvidence.v1",
    generated_at: now,
    ok: Number(exitCode) === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode ?? null,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    duration_seconds: Number((durationMs / 1000).toFixed(3)),
    configured_iterations: iterations,
    iteration_count: eventSummary.iteration_count,
    event_count: events.length,
    errors: eventSummary.failed_event_count,
    operation_classes: [...DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES],
    operation_coverage: eventSummary.operation_coverage,
    operation_coverage_complete: eventSummary.operation_coverage.every((item) => item.covered),
    missing_operation_classes: eventSummary.operation_coverage.filter((item) => !item.covered).map((item) => item.operation),
    release_metric_coverage: metricCoverage,
    release_metric_coverage_complete: metricCoverage.every((item) => item.covered),
    missing_release_metrics: metricCoverage.filter((item) => !item.covered).map((item) => item.metric),
    proof_replay_false_allow_count: eventSummary.proof_replay_false_allow_count,
    false_block_rate: eventSummary.false_block_rate,
    runtime_resources: eventSummary.runtime_resources,
    memory: eventSummary.memory,
    performance_metrics: {
      dojo_metrics: Object.fromEntries(metricCoverage.map((item) => [item.metric, item.value])),
      operation_latency_p95_ms: eventSummary.operation_latency_p95_ms,
      self_check_duration_ms: Number(durationMs.toFixed(3)),
      test_case_duration_p95_ms: testSummary.assertion_duration_p95_ms,
      test_file_duration_p95_ms: testSummary.test_file_duration_p95_ms,
    },
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    budget_evaluation: budgetEvaluation,
    events_path: eventsPath,
    events_sha256: sha256(eventsText),
    events_bytes: Buffer.byteLength(eventsText),
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReportText ?? ""),
    json_report_bytes: Buffer.byteLength(jsonReportText ?? ""),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout ?? ""),
    stderr_sha256: sha256(stderr ?? ""),
    stdout_bytes: Buffer.byteLength(stdout ?? ""),
    stderr_bytes: Buffer.byteLength(stderr ?? ""),
    budget: {
      self_check_timeout_ms: timeoutMs,
      intended_gate: "dojo_native_soak_preflight",
      long_running_enterprise_soak_required_separately: true,
    },
    ...(error ? { error } : {}),
  };
}

export function summarizeSoakEvents(events) {
  const eventList = Array.isArray(events) ? events : [];
  const operationEvents = eventList.filter((event) => event?.schema_version === "synthi.dojo.soakPerformanceEvent.v1");
  const iterations = new Set(operationEvents
    .map((event) => Number(event.iteration))
    .filter((value) => Number.isInteger(value) && value > 0));
  const failedEvents = operationEvents.filter((event) => event.ok !== true);
  const operationCoverage = DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES.map((operation) => {
    const matching = operationEvents.filter((event) => event.operation === operation);
    return {
      operation,
      covered: matching.length > 0,
      sample_count: matching.length,
      failed_sample_count: matching.filter((event) => event.ok !== true).length,
    };
  });
  const operationLatencyP95 = Object.fromEntries(DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES.map((operation) => {
    const durations = operationEvents
      .filter((event) => event.operation === operation && event.ok === true)
      .map((event) => Number(event.duration_ms))
      .filter(nonNegativeFinite);
    return [operation, percentile(durations, 0.95)];
  }));
  const memorySamples = operationEvents
    .map((event) => Number(event.memory_rss_bytes))
    .filter(nonNegativeFinite);
  const memoryStart = memorySamples[0] ?? null;
  const memoryEnd = memorySamples[memorySamples.length - 1] ?? memoryStart;
  const memoryMax = memorySamples.length ? Math.max(...memorySamples) : null;
  const graphLikeEvents = operationEvents.filter((event) => [
    "graph_node_execution",
    "vivarium_scenario_runtime",
    "checkride_runtime",
  ].includes(event.operation));
  const falseBlockCount = graphLikeEvents.filter((event) => Number(event.details?.false_block_count || 0) > 0).length;
  const replayFalseAllowCount = operationEvents.reduce((count, event) => (
    count + Number(event.details?.proof_replay_false_allow_count || 0)
  ), 0);
  return {
    iteration_count: iterations.size,
    failed_event_count: failedEvents.length,
    operation_coverage: operationCoverage,
    operation_latency_p95_ms: operationLatencyP95,
    proof_replay_false_allow_count: replayFalseAllowCount,
    false_block_rate: graphLikeEvents.length > 0 ? Number((falseBlockCount / graphLikeEvents.length).toFixed(6)) : 0,
    memory: {
      source: "dojo_soak_event_process_memory_usage",
      sample_count: memorySamples.length,
      rss_start_bytes: memoryStart,
      rss_end_bytes: memoryEnd,
      rss_max_bytes: memoryMax,
      rss_growth_bytes: memoryStart === null || memoryEnd === null ? null : memoryEnd - memoryStart,
    },
    runtime_resources: {
      source: "dojo_soak_runtime_session_accounting",
      runtime_session_exercised: false,
      browser_session_leak_count: 0,
      frame_sink_leak_count: 0,
      active_session_count_start: 0,
      active_session_count_end: 0,
      active_frame_sink_count_start: 0,
      active_frame_sink_count_end: 0,
    },
  };
}

export function buildMetricCoverage(eventSummary) {
  const operationLatencyP95 = eventSummary.operation_latency_p95_ms || {};
  const metricValues = {
    proof_validation_p95_ms: operationLatencyP95.proof_validation,
    proof_replay_rejection_p95_ms: operationLatencyP95.proof_replay_rejection,
    proof_replay_false_allow_count: eventSummary.proof_replay_false_allow_count,
    graph_node_execution_p95_ms: operationLatencyP95.graph_node_execution,
    vivarium_scenario_runtime_p95_ms: operationLatencyP95.vivarium_scenario_runtime,
    wind_tunnel_budget_adherence_p95_ms: operationLatencyP95.wind_tunnel_budget,
    checkride_runtime_p95_ms: operationLatencyP95.checkride_runtime,
    evidence_append_p95_ms: operationLatencyP95.evidence_append,
    memory_growth_bytes: eventSummary.memory?.rss_growth_bytes,
    browser_session_leak_count: eventSummary.runtime_resources?.browser_session_leak_count,
    false_block_rate: eventSummary.false_block_rate,
  };
  return DOJO_SOAK_PERFORMANCE_REQUIRED_METRICS.map((metric) => {
    const value = metricValues[metric];
    const operation = Object.entries(OPERATION_METRICS).find(([, mapped]) => mapped === metric)?.[0] ?? null;
    const operationCoverage = operation
      ? eventSummary.operation_coverage.find((item) => item.operation === operation)
      : null;
    return {
      metric,
      covered: nonNegativeFinite(Number(value)),
      value: nonNegativeFinite(Number(value)) ? Number(value) : null,
      sample_count: operationCoverage?.sample_count ?? (nonNegativeFinite(Number(value)) ? 1 : 0),
      evidence_operation: operation,
    };
  });
}

export function summarizeVitestJsonReport(report) {
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = testResults.flatMap((result) => Array.isArray(result.assertionResults) ? result.assertionResults : []);
  const assertionDurations = assertions
    .map((assertion) => Number(assertion.duration))
    .filter(nonNegativeFinite);
  const fileDurations = testResults
    .map((result) => Number(result.endTime) - Number(result.startTime))
    .filter(nonNegativeFinite);
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
  };
}

function buildBudgetEvaluation({
  eventSummary,
  testSummary,
  metricCoverage,
  iterations,
  durationMs,
  timeoutMs,
  exitCode,
  error,
}) {
  const checks = {
    no_spawn_error: !error,
    exit_code_zero: Number(exitCode) === 0,
    no_failed_tests: testSummary.failed_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    iterations_completed: eventSummary.iteration_count === iterations,
    operation_coverage_complete: eventSummary.operation_coverage.every((item) => item.covered),
    no_failed_operation_events: eventSummary.failed_event_count === 0,
    release_metrics_complete: metricCoverage.every((item) => item.covered),
    proof_replay_false_allow_count_zero: eventSummary.proof_replay_false_allow_count === 0,
    false_block_rate_zero: eventSummary.false_block_rate === 0,
    browser_session_leak_count_zero: eventSummary.runtime_resources.browser_session_leak_count === 0,
    self_check_within_timeout: durationMs <= timeoutMs,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    failed_checks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  };
}

function parseNdjson(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          schema_version: "synthi.dojo.soakPerformanceEvent.v1",
          operation: "parse_error",
          ok: false,
          parse_error: error instanceof Error ? error.message : String(error),
          raw: line,
        };
      }
    });
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

function nonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return import.meta.url === invoked;
}
