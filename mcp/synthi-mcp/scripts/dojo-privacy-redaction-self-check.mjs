#!/usr/bin/env node
/*
 * Run the focused Agent Dojo privacy/redaction gate and emit digest-backed
 * evidence. This promotes existing privacy tests into a release artifact:
 * evidence redaction, auth checkpoint custody, browser broker privacy, private
 * tool secret minimization, broker audit redaction, and operator screenshot
 * minimization.
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

export const DOJO_PRIVACY_REDACTION_TEST_FILES = [
  "tests/unit/dojo_evidence_redaction.test.ts",
  "tests/unit/dojo_evidence_export.test.ts",
  "tests/unit/auth_checkpoint.test.ts",
  "tests/unit/browser_broker.test.ts",
  "tests/unit/private_tool_manifest.test.ts",
  "tests/unit/broker_security_hardening.test.ts",
  "tests/unit/operator_bridge.test.ts",
];

export const DOJO_PRIVACY_REDACTION_CAPABILITIES = [
  "evidence_redaction_manifest",
  "raw_text_secret_redaction",
  "redacted_evidence_export",
  "auth_checkpoint_secret_custody",
  "browser_origin_privacy_boundary",
  "screenshot_consent_boundary",
  "private_tool_secret_minimization",
  "broker_audit_redaction",
  "operator_queue_screenshot_minimization",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-privacy-redaction"));
  const artifacts = await runDojoPrivacyRedactionSelfCheck({ outDir });
  console.log(`[ok] Dojo privacy/redaction self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoPrivacyRedactionSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 180000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-privacy-redaction"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_PRIVACY_REDACTION_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing privacy/redaction test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_PRIVACY_REDACTION_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const basicRunDurationMs = performance.now() - startedAt;
  const stdout = String(result.stdout ?? "");
  const basicStderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-privacy-redaction.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-privacy-redaction.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-privacy-redaction.vitest.json");
  await writeFile(stdoutPath, stdout);

  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_PRIVACY_REDACTION_TEST_FILES,
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
  await writeFile(path.join(outputDir, "dojo-privacy-redaction.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-privacy-redaction.json-reporter.stderr.log"), jsonStderr);
  const stderr = [basicStderr, jsonStderr].filter(Boolean).join("\n");
  await writeFile(stderrPath, stderr);
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const evidence = buildDojoPrivacyRedactionEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_PRIVACY_REDACTION_TEST_FILES,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    jsonReportText,
    timeoutMs,
    error: result.error?.message ?? jsonResult.error?.message ?? jsonReportError,
  });
  const evidencePath = path.join(outputDir, "dojo-privacy-redaction.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.error) throw new Error(`dojo_privacy_redaction_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_privacy_redaction_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_privacy_redaction_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_privacy_redaction_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_privacy_redaction_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true, evidence.budget_evaluation.failed_checks.join(","));
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoPrivacyRedactionEvidenceManifest({
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
  timeoutMs = 180000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildPrivacyCapabilityCoverage({
    capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildPrivacyRedactionBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_PRIVACY_REDACTION_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_PRIVACY_REDACTION_CAPABILITIES.length,
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
    ...(error ? { error } : {}),
  };
}

export function buildPrivacyCapabilityCoverage({ capabilities, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return capabilities.map((capability) => {
    const matchers = privacyCapabilityMatchers(capability);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizePrivacyText(title);
      return matchers.some((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      capability,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildPrivacyRedactionBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
  const checks = {
    no_spawn_error: !error,
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

function privacyCapabilityMatchers(capability) {
  switch (capability) {
    case "evidence_redaction_manifest":
      return ["redacts sensitive trace and storage fields", "verifiable manifest", "redacts bearer tokens", "structured user entered text and file name fields"];
    case "raw_text_secret_redaction":
      return ["redacts raw header and serialized json secret strings"];
    case "redacted_evidence_export":
      return ["redacted evidence metadata without raw artifact content", "fails closed when a bound evidence record lacks redaction metadata"];
    case "auth_checkpoint_secret_custody":
      return ["does not persist raw storage state", "encrypts persisted auth checkpoints", "rejects raw refresh provider secret values"];
    case "browser_origin_privacy_boundary":
      return ["returns no screenshot dom console or network data for denied origins", "privacy boundary"];
    case "screenshot_consent_boundary":
      return ["requires explicit screenshot consent", "popup screenshot consent"];
    case "private_tool_secret_minimization":
      return [
        "does not persist captured secret values",
        "marks secret shaped parameters as password",
        "redacted secret shaped parameters",
        "encrypted workflow artifacts",
        "not expose secret",
      ];
    case "broker_audit_redaction":
      return ["redacts secret keys", "redacts subscriber fanout", "redacts replay results"];
    case "operator_queue_screenshot_minimization":
      return ["lists pending entries without screenshots", "returns full entry with screenshot"];
    default:
      return [capability.replaceAll("_", " ")];
  }
}

function normalizePrivacyText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_/()]+/g, " ")
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
