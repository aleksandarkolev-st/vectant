#!/usr/bin/env node
/*
 * Run the focused Agent Dojo security/abuse gate and emit a digest-backed
 * evidence manifest. This is intentionally narrower than the full release
 * suite: it makes T7 executable in CI without requiring hosted infrastructure.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_SECURITY_ABUSE_TEST_FILES = [
  "tests/unit/dojo_proof_errors.test.ts",
  "tests/unit/dojo_proof_claims.test.ts",
  "tests/unit/dojo_proof_capsule_ed25519.test.ts",
  "tests/unit/dojo_public_proof_verifier.test.ts",
  "tests/unit/dojo_proof_signing.test.ts",
  "tests/unit/dojo_execution_policy_gate.test.ts",
  "tests/unit/dojo_private_tool_gate.test.ts",
  "tests/unit/dojo_browser_workflow_gate.test.ts",
  "tests/unit/dojo_evidence_claim_verifier.test.ts",
  "tests/unit/dojo_guardrail_runtime.test.ts",
  "tests/unit/dojo_fixture_materializer.test.ts",
  "tests/unit/dojo_scenario_oracle.test.ts",
  "tests/unit/security.test.ts",
];

export const DOJO_SECURITY_ABUSE_CLASSES = [
  "proof_signature_tampering",
  "proof_context_tampering",
  "proof_replay_or_missing_capsule",
  "raw_private_tool_bypass",
  "raw_browser_workflow_bypass",
  "evidence_claim_missing_or_stale",
  "guardrail_failure",
  "prompt_injection_scanning",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-security-abuse"));
  const artifacts = await runDojoSecurityAbuseSelfCheck({ outDir });
  console.log(`[ok] Dojo security/abuse self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoSecurityAbuseSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-security-abuse"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_SECURITY_ABUSE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing security test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_SECURITY_ABUSE_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const basicRunDurationMs = performance.now() - startedAt;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-security-abuse.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-security-abuse.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-security-abuse.vitest.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_SECURITY_ABUSE_TEST_FILES,
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
  await writeFile(path.join(outputDir, "dojo-security-abuse.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-security-abuse.json-reporter.stderr.log"), jsonStderr);
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReport = jsonReportError ? null : await readVitestJsonReport(jsonReportPath);
  const durationMs = performance.now() - startedAt;
  const evidence = buildDojoSecurityAbuseEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
    stdout,
    stderr: [stderr, jsonStderr].filter(Boolean).join("\n"),
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    timeoutMs,
    error: result.error?.message ?? jsonResult.error?.message ?? jsonReportError,
  });
  const evidencePath = path.join(outputDir, "dojo-security-abuse.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (result.error) throw new Error(`dojo_security_abuse_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_security_abuse_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_security_abuse_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_security_abuse_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_security_abuse_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoSecurityAbuseEvidenceManifest({
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
  timeoutMs = 120000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const abuseCoverage = buildAbuseClassCoverage({ abuseClasses: DOJO_SECURITY_ABUSE_CLASSES, jsonReport });
  const budgetEvaluation = buildSecurityAbuseBudgetEvaluation({
    abuseCoverage,
    testSummary,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.securityAbuseEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_abuse_classes: [...DOJO_SECURITY_ABUSE_CLASSES],
    tested_abuse_classes: abuseCoverage.filter((item) => item.covered).map((item) => item.abuse_class),
    missing_abuse_classes: abuseCoverage.filter((item) => !item.covered).map((item) => item.abuse_class),
    abuse_class_coverage: abuseCoverage,
    abuse_class_count: abuseCoverage.filter((item) => item.covered).length,
    configured_abuse_class_count: DOJO_SECURITY_ABUSE_CLASSES.length,
    abuse_class_coverage_complete: abuseCoverage.every((item) => item.covered),
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    basic_run_duration_ms: typeof basicRunDurationMs === "number" ? Number(basicRunDurationMs.toFixed(3)) : null,
    budget_evaluation: budgetEvaluation,
    json_report_path: jsonReportPath ?? null,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...(error ? { error } : {}),
  };
}

export function buildAbuseClassCoverage({ abuseClasses, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return abuseClasses.map((abuseClass) => {
    const matchers = abuseClassMatchers(abuseClass);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizeAbuseText(title);
      return matchers.some((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      abuse_class: abuseClass,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildSecurityAbuseBudgetEvaluation({ abuseCoverage, testSummary, durationMs, timeoutMs, error }) {
  const checks = {
    no_spawn_error: !error,
    no_failed_tests: testSummary.failed_tests === 0,
    all_reported_tests_passed: testSummary.total_tests > 0 && testSummary.passed_tests === testSummary.total_tests,
    abuse_class_coverage_complete: abuseCoverage.every((item) => item.covered),
    self_check_within_timeout: durationMs <= timeoutMs,
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

function abuseClassMatchers(abuseClass) {
  const normalized = normalizeAbuseText(abuseClass);
  const aliases = {
    proof_signature_tampering: ["tampered", "signature", "wrong ed25519 key"],
    proof_context_tampering: ["context mismatched", "context-mismatched", "context claim"],
    proof_replay_or_missing_capsule: ["requires proof", "missing capsule", "without validated dojo dispatcher context", "proof capsule not issued"],
    raw_private_tool_bypass: ["backing private tool direct call", "private tool direct call"],
    raw_browser_workflow_bypass: ["raw replay", "raw workflow replay"],
    evidence_claim_missing_or_stale: ["missing evidence", "backing evidence is stale", "returns stale"],
    guardrail_failure: ["guardrail fails", "guardrail failed", "block-severity guardrail fails"],
    prompt_injection_scanning: ["ignore previous instructions", "prompt injection", "instructions are not quarantined"],
  };
  return [...new Set([normalized, ...(aliases[abuseClass] ?? [])].map(normalizeAbuseText))];
}

function normalizeAbuseText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
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
