#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo Skill Passport and
 * consumer Skill Card contracts: report-only status, license/readiness/proof
 * scope, published tool visibility, card action grouping, proof badge state,
 * practice/guardrail counts, and safe passport export metadata.
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

export const DOJO_SKILL_PASSPORT_TEST_FILES = [
  "tests/unit/dojo_skill_passport.test.ts",
];

export const DOJO_SKILL_PASSPORT_CAPABILITIES = [
  "skill_passport_report_only_status",
  "skill_passport_license_readiness_scope",
  "skill_passport_proof_coverage_attack_scope",
  "skill_passport_published_tool_scope",
  "skill_card_allowed_ask_before_blocked_scope",
  "skill_card_proof_badge_matches_passport",
  "skill_card_practice_guardrail_counts",
  "skill_passport_repo_export",
  "skill_passport_export_redacts_raw_payloads",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-skill-passport"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo Skill Passport evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoSkillPassportSelfCheck({ outDir });
  console.log(`[ok] Dojo Skill Passport self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoSkillPassportSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-skill-passport"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_SKILL_PASSPORT_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Skill Passport test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-skill-passport.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo Skill Passport evidence self-check builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_SKILL_PASSPORT_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-skill-passport.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-skill-passport.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoSkillPassportEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_SKILL_PASSPORT_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-skill-passport.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_skill_passport_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoSkillPassportEvidenceManifest({
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
  const capabilityCoverage = buildSkillPassportCapabilityCoverage({
    capabilities: DOJO_SKILL_PASSPORT_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildSkillPassportBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.skillPassportEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_SKILL_PASSPORT_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    skill_passport_contract: {
      report_only_status_required: true,
      license_scope_required: true,
      readiness_scope_required: true,
      proof_scope_required: true,
      coverage_and_attack_metrics_required: true,
      published_tool_scope_required: true,
      skill_card_action_grouping_required: true,
      proof_badge_required: true,
      practice_guardrail_counts_required: true,
      passport_export_required: true,
      raw_payload_redaction_required: true,
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

function buildSkillPassportCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildSkillPassportBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
  skill_passport_report_only_status: includes("report-only passport"),
  skill_passport_license_readiness_scope: includes("license", "readiness"),
  skill_passport_proof_coverage_attack_scope: includes("proof", "coverage", "attack"),
  skill_passport_published_tool_scope: includes("published-tool scope"),
  skill_card_allowed_ask_before_blocked_scope: includes("allowed", "ask-before", "blocked"),
  skill_card_proof_badge_matches_passport: includes("proof badge"),
  skill_card_practice_guardrail_counts: includes("practice", "guardrail counts"),
  skill_passport_repo_export: includes("exports the skill passport artifact"),
  skill_passport_export_redacts_raw_payloads: includes("free of raw production payloads"),
};
