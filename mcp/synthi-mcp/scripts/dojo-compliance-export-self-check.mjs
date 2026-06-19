#!/usr/bin/env node
/*
 * Run the focused Agent Dojo compliance export gate and emit digest-backed
 * evidence. This proves that compliance packs, audit exports, and redacted
 * evidence exports are covered by executable tests before a milestone/release
 * can claim compliance export readiness.
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

export const DOJO_COMPLIANCE_EXPORT_TEST_FILES = [
  "tests/unit/dojo_tools.test.ts",
  "tests/unit/dojo_governance_service.test.ts",
  "tests/unit/dojo_evidence_export.test.ts",
  "tests/unit/dojo_proof_public_verification_export.test.ts",
];

export const DOJO_COMPLIANCE_EXPORT_CAPABILITIES = [
  "tool_authorized_compliance_export",
  "compliance_pack_view_model",
  "control_plane_audit_export",
  "compliance_archive_fail_closed",
  "executable_entrustment_compliance_artifact",
  "redacted_evidence_export",
  "redaction_fail_closed",
  "source_ref_redaction",
  "proof_public_verification_export",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-compliance-export"));
  const artifacts = await runDojoComplianceExportSelfCheck({ outDir });
  console.log(`[ok] Dojo compliance export self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoComplianceExportSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 180000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-compliance-export"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_COMPLIANCE_EXPORT_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing compliance export test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_COMPLIANCE_EXPORT_TEST_FILES,
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
  const stdoutPath = path.join(outputDir, "dojo-compliance-export.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-compliance-export.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-compliance-export.vitest.json");
  await writeFile(stdoutPath, stdout);

  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_COMPLIANCE_EXPORT_TEST_FILES,
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
  await writeFile(path.join(outputDir, "dojo-compliance-export.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-compliance-export.json-reporter.stderr.log"), jsonStderr);
  const stderr = [basicStderr, jsonStderr].filter(Boolean).join("\n");
  await writeFile(stderrPath, stderr);
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const evidence = buildDojoComplianceExportEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-compliance-export.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.error) throw new Error(`dojo_compliance_export_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_compliance_export_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_compliance_export_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_compliance_export_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_compliance_export_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true, evidence.budget_evaluation.failed_checks.join(","));
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoComplianceExportEvidenceManifest({
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
  const capabilityCoverage = buildComplianceCapabilityCoverage({
    capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildComplianceExportBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.complianceExportEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_COMPLIANCE_EXPORT_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.length,
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

export function buildComplianceCapabilityCoverage({ capabilities, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return capabilities.map((capability) => {
    const matchers = complianceCapabilityMatchers(capability);
    const evidenceTitles = titles.filter((title) => {
      const normalizedTitle = normalizeComplianceText(title);
      return matchers.some((matcher) => normalizedTitle.includes(matcher));
    });
    return {
      capability,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildComplianceExportBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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

function complianceCapabilityMatchers(capability) {
  switch (capability) {
    case "tool_authorized_compliance_export":
      return ["production skill operations and exports", "export_compliance_pack"];
    case "compliance_pack_view_model":
      return ["compliance pack views", "compliance pack"];
    case "control_plane_audit_export":
      return ["control plane audit", "audit exports"];
    case "compliance_archive_fail_closed":
      return ["compliance archive tenant context or timestamp"];
    case "executable_entrustment_compliance_artifact":
      return ["executable entrustment provenance", "compliance packs"];
    case "redacted_evidence_export":
      return ["redacted evidence metadata", "raw artifact content"];
    case "redaction_fail_closed":
      return ["fails closed when a bound evidence record", "redaction metadata"];
    case "source_ref_redaction":
      return ["redacting source refs", "source refs"];
    case "proof_public_verification_export":
      return ["proof public verification bundle", "public verification bundle"];
    default:
      return [capability.replaceAll("_", " ")];
  }
}

function normalizeComplianceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
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
