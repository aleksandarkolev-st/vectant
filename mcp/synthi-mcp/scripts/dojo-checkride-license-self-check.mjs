#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for executable Dojo checkrides and
 * license maturity policy: graph/Vivarium runtime evidence, oracle decisions,
 * license constraints, entrustment levels, and SRL progression.
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

export const DOJO_CHECKRIDE_LICENSE_TEST_FILES = [
  "tests/integration/dojo_checkride_runner.test.ts",
  "tests/unit/dojo_entrustment_policy.test.ts",
  "tests/unit/dojo_srl_policy.test.ts",
];

export const DOJO_CHECKRIDE_LICENSE_CAPABILITIES = [
  "checkride_runtime_oracle_blocks_happy_path_only",
  "checkride_blocked_scenario_emits_license_constraint_and_evidence_record",
  "checkride_prompt_injection_is_critical_guardrail_failure",
  "checkride_substrate_assertion_failure_requires_human_review",
  "entrustment_blocks_critical_failures",
  "entrustment_requires_guardrails_and_evidence_for_e3",
  "entrustment_downgrades_stale_evidence_and_shadow_mismatch",
  "srl_advances_seed_graph_assertions_organoid_checkride",
  "srl_requires_passing_checkride_and_limited_license",
  "srl_reaches_9_with_stable_substrate_and_feedback",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-checkride-license"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo checkride/license evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoCheckrideLicenseSelfCheck({ outDir });
  console.log(`[ok] Dojo checkride/license self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoCheckrideLicenseSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-checkride-license"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_CHECKRIDE_LICENSE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing checkride/license test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-checkride-license.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo checkride/license evidence self-check builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_CHECKRIDE_LICENSE_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-checkride-license.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-checkride-license.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoCheckrideLicenseEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_CHECKRIDE_LICENSE_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-checkride-license.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_checkride_license_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoCheckrideLicenseEvidenceManifest({
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
  const capabilityCoverage = buildCheckrideLicenseCapabilityCoverage({
    capabilities: DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildCheckrideLicenseBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_CHECKRIDE_LICENSE_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    checkride_license: {
      executable_checkride_required: true,
      graph_runtime_required: true,
      vivarium_oracle_required: true,
      observed_evidence_required: true,
      evidence_record_required: true,
      license_constraints_required: true,
      critical_failure_block_required: true,
      substrate_assertion_required: true,
      entrustment_policy_required: true,
      guardrail_evidence_e3_required: true,
      stale_evidence_downgrade_required: true,
      shadow_mismatch_limit_required: true,
      srl_policy_required: true,
      limited_license_srl7_required: true,
      operational_feedback_srl9_required: true,
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

function buildCheckrideLicenseCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildCheckrideLicenseBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
  checkride_runtime_oracle_blocks_happy_path_only: includes("runtime and oracle evidence", "happy path alone is not enough"),
  checkride_blocked_scenario_emits_license_constraint_and_evidence_record: includes("blocked risk scenarios", "license constraints", "evidence records"),
  checkride_prompt_injection_is_critical_guardrail_failure: includes("prompt injection document scenarios", "critical guardrail failures"),
  checkride_substrate_assertion_failure_requires_human_review: includes("substrate executor hooks", "executable checkride runs"),
  entrustment_blocks_critical_failures: includes("blocks production entrustment", "critical failures"),
  entrustment_requires_guardrails_and_evidence_for_e3: includes("requires active guardrails and evidence", "e3"),
  entrustment_downgrades_stale_evidence_and_shadow_mismatch: includes("downgrades stale evidence", "shadow mismatch"),
  srl_advances_seed_graph_assertions_organoid_checkride: includes("advances through seed", "graph", "assertions", "organoid", "checkride"),
  srl_requires_passing_checkride_and_limited_license: includes("requires passing checkride", "limited production license"),
  srl_reaches_9_with_stable_substrate_and_feedback: includes("srl 9", "stable substrate", "operational feedback"),
};
