#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for the Agent Dojo generated PR
 * workflow: review metadata, source patch bundle, patch writer, branch applier,
 * git branch creation, and generated contract tests.
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

export const DOJO_GENERATED_PR_TEST_FILES = [
  "tests/unit/dojo_generated_pr_metadata.test.ts",
  "tests/integration/dojo_generated_source_patch_bundle.test.ts",
  "tests/integration/dojo_source_patch_writer.test.ts",
  "tests/integration/dojo_generated_pr_branch_applier.test.ts",
  "tests/integration/dojo_generated_pr_git_branch.test.ts",
];

export const DOJO_GENERATED_PR_CAPABILITIES = [
  "generated_pr_metadata_reviewable_with_code_owners_and_proof_impact",
  "generated_pr_metadata_externalizes_code_owner_ownership",
  "generated_pr_metadata_matches_code_owner_globs",
  "generated_pr_metadata_rejects_unsafe_branch_names",
  "generated_pr_metadata_builds_reviewable_branch_plan",
  "generated_pr_metadata_blocks_invalid_metadata_or_bundle",
  "generated_source_patch_bundle_creates_patches_and_contract_tests",
  "generated_source_patch_bundle_rejects_missing_source",
  "source_patch_writer_writes_declared_source_and_tests",
  "source_patch_writer_rejects_path_traversal",
  "source_patch_writer_rejects_duplicate_outputs",
  "source_patch_writer_supports_dry_run",
  "source_patch_writer_rejects_stale_source",
  "source_patch_writer_is_idempotent",
  "generated_pr_branch_applier_applies_ready_plan_and_tests",
  "generated_pr_branch_applier_supports_dry_run",
  "generated_pr_branch_applier_rejects_hash_mismatch",
  "generated_pr_branch_applier_rejects_unresolved_blockers",
  "generated_pr_git_branch_creates_branch_and_tests",
  "generated_pr_git_branch_supports_dry_run",
  "generated_pr_git_branch_rejects_dirty_worktree",
  "generated_pr_git_branch_rejects_existing_branch",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-generated-pr"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo generated PR output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoGeneratedPrSelfCheck({ outDir });
  console.log(`[ok] Dojo generated PR self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoGeneratedPrSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 180000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-generated-pr"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_GENERATED_PR_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing generated PR test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-generated-pr.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo generated PR self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_GENERATED_PR_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-generated-pr.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-generated-pr.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoGeneratedPrEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_GENERATED_PR_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-generated-pr.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_generated_pr_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoGeneratedPrEvidenceManifest({
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
  timeoutMs = 180000,
  error,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildGeneratedPrCapabilityCoverage({
    capabilities: DOJO_GENERATED_PR_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildGeneratedPrBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.generatedPrEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_GENERATED_PR_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_GENERATED_PR_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    generated_pr_contract: {
      reviewable_metadata_required: true,
      caller_supplied_code_owner_rules_required: true,
      proof_impact_required: true,
      code_owner_glob_matching_required: true,
      unsafe_branch_rejection_required: true,
      branch_plan_required: true,
      promotion_blocker_required: true,
      source_patch_bundle_required: true,
      missing_source_rejection_required: true,
      generated_contract_tests_required: true,
      patch_writer_required: true,
      path_traversal_rejection_required: true,
      duplicate_output_rejection_required: true,
      dry_run_required: true,
      stale_source_rejection_required: true,
      idempotent_write_required: true,
      branch_applier_required: true,
      file_hash_verification_required: true,
      unresolved_blocker_rejection_required: true,
      git_branch_creation_required: true,
      dirty_worktree_rejection_required: true,
      existing_branch_rejection_required: true,
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
  };
}

function buildGeneratedPrCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildGeneratedPrBudgetEvaluation({
  capabilityCoverage,
  testSummary,
  testFiles,
  durationMs,
  timeoutMs,
  error,
}) {
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
    failed_checks: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
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
  generated_pr_metadata_reviewable_with_code_owners_and_proof_impact: includes("builds reviewable metadata", "code owners", "proof impact"),
  generated_pr_metadata_externalizes_code_owner_ownership: includes("keeps code owner ownership external"),
  generated_pr_metadata_matches_code_owner_globs: includes("matches code owner globs"),
  generated_pr_metadata_rejects_unsafe_branch_names: includes("rejects unsafe generated branch metadata"),
  generated_pr_metadata_builds_reviewable_branch_plan: includes("builds a reviewable branch plan"),
  generated_pr_metadata_blocks_invalid_metadata_or_bundle: includes("keeps branch plans blocked", "metadata", "bundle"),
  generated_source_patch_bundle_creates_patches_and_contract_tests: includes("creates patched source", "generated contract tests"),
  generated_source_patch_bundle_rejects_missing_source: includes("reports missing source files", "instead of inventing"),
  source_patch_writer_writes_declared_source_and_tests: includes("writes bundle-declared source", "contract tests"),
  source_patch_writer_rejects_path_traversal: includes("rejects traversal paths"),
  source_patch_writer_rejects_duplicate_outputs: includes("rejects duplicate bundle output paths"),
  source_patch_writer_supports_dry_run: includes("supports dry runs", "without mutating the workspace"),
  source_patch_writer_rejects_stale_source: includes("rejects stale source files"),
  source_patch_writer_is_idempotent: includes("already-current source files", "idempotent no-op"),
  generated_pr_branch_applier_applies_ready_plan_and_tests: includes("applies a ready generated branch plan", "generated contract test"),
  generated_pr_branch_applier_supports_dry_run: includes("branch applicator", "supports dry runs"),
  generated_pr_branch_applier_rejects_hash_mismatch: includes("rejects file hash mismatches"),
  generated_pr_branch_applier_rejects_unresolved_blockers: includes("rejects branch plans with unresolved promotion blockers"),
  generated_pr_git_branch_creates_branch_and_tests: includes("creates a generated branch", "proves the generated contract test"),
  generated_pr_git_branch_supports_dry_run: includes("dry-runs branch creation"),
  generated_pr_git_branch_rejects_dirty_worktree: includes("blocks branch creation", "worktree is dirty"),
  generated_pr_git_branch_rejects_existing_branch: includes("blocks branch creation", "generated branch already exists"),
};
