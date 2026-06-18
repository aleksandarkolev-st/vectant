#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo case-law runtime,
 * refusal explanation, and antibody matching behavior. The focused Vitest
 * suites run first and this script validates their JSON report before writing
 * evidence.
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

export const DOJO_CASE_LAW_RUNTIME_TEST_FILES = [
  "tests/unit/dojo_case_law_registry.test.ts",
  "tests/unit/dojo_case_law_refusal.test.ts",
  "tests/unit/dojo_antibody_matcher.test.ts",
  "tests/integration/dojo_case_law_guardrail_runtime.test.ts",
  "tests/unit/dojo_tools.test.ts",
];

export const DOJO_CASE_LAW_RUNTIME_CAPABILITIES = [
  "case_law_registry_proposes_unbound_cases",
  "case_law_registry_lists_approved_binding_scope",
  "case_law_registry_excludes_deprecated",
  "case_law_registry_requires_evidence",
  "case_law_registry_rejects_invalid_lifecycle_review",
  "case_law_registry_allows_approval_only_from_proposed",
  "case_law_registry_blocks_overturned_superseded_synthesis",
  "case_law_registry_preserves_explicit_predicates",
  "case_law_record_enforces_rbac_before_proposal",
  "guardrail_runtime_ignores_proposed_case_law",
  "guardrail_runtime_synthesizes_stable_identity",
  "guardrail_runtime_binds_and_blocks_graph_actions",
  "guardrail_runtime_executes_explicit_predicates",
  "refusal_explainer_cites_case_law_evidence_next_step",
  "refusal_explainer_falls_back_to_block_reason",
  "refusal_explainer_ignores_unrelated_non_guardrail",
  "refusal_explainer_ignores_inactive_stale_refs",
  "antibody_matcher_proposes_without_binding",
  "antibody_matcher_ignores_inactive_cases",
  "antibody_matcher_ignores_unrelated_safe_nodes",
  "antibody_matcher_deterministic_order_ids",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-case-law-runtime"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo case-law runtime output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoCaseLawRuntimeSelfCheck({ outDir });
  console.log(`[ok] Dojo case-law runtime self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoCaseLawRuntimeSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-case-law-runtime"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_CASE_LAW_RUNTIME_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing case-law runtime test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-case-law-runtime.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_CASE_LAW_RUNTIME_TEST_FILES,
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
    "Dojo case-law runtime self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_CASE_LAW_RUNTIME_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-case-law-runtime.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-case-law-runtime.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoCaseLawRuntimeEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_CASE_LAW_RUNTIME_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-case-law-runtime.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_case_law_runtime_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoCaseLawRuntimeEvidenceManifest({
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
  const capabilityCoverage = buildCaseLawRuntimeCapabilityCoverage({
    capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildCaseLawRuntimeBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_CASE_LAW_RUNTIME_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    case_law_contract: {
      case_law_registry_required: true,
      reviewed_evidence_required: true,
      case_law_record_rbac_required: true,
      proposed_cases_nonbinding_required: true,
      approved_binding_scope_required: true,
      deprecated_cases_excluded_required: true,
      guardrail_synthesis_required: true,
      explicit_predicate_preservation_required: true,
      graph_binding_required: true,
      runtime_guardrail_block_required: true,
      refusal_case_citation_required: true,
      inactive_case_suppression_required: true,
      antibody_matching_required: true,
      antibody_proposed_only_required: true,
      antibody_private_data_redaction_required: true,
      local_practice_required: true,
      local_checkride_required: true,
      deterministic_antibody_ids_required: true,
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
    test_execution: testRun ? {
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
    } : null,
  };
}

function buildCaseLawRuntimeCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildCaseLawRuntimeBudgetEvaluation({
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
  case_law_registry_proposes_unbound_cases: includes("creates proposed cases", "does not bind"),
  case_law_registry_lists_approved_binding_scope: includes("returns approved binding cases", "matching scope"),
  case_law_registry_excludes_deprecated: includes("removes deprecated cases", "binding lookup"),
  case_law_registry_requires_evidence: includes("requires evidence", "proposed case law"),
  case_law_registry_rejects_invalid_lifecycle_review: includes("rejects invalid lifecycle", "review metadata"),
  case_law_registry_allows_approval_only_from_proposed: includes("allows each case-law approval", "proposed state"),
  case_law_registry_blocks_overturned_superseded_synthesis: includes("does not synthesize guardrails", "overturned", "superseded"),
  case_law_registry_preserves_explicit_predicates: includes("preserves explicit reviewed guardrail predicates"),
  case_law_record_enforces_rbac_before_proposal: includes("enforces rbac", "production case-law recording", "mcp tool"),
  guardrail_runtime_ignores_proposed_case_law: includes("does not synthesize guardrails", "proposed case law"),
  guardrail_runtime_synthesizes_stable_identity: includes("synthesizes a stable identity guardrail"),
  guardrail_runtime_binds_and_blocks_graph_actions: includes("binds approved case-law guardrails", "blocks runtime execution"),
  guardrail_runtime_executes_explicit_predicates: includes("executes explicit reviewed case-law predicates"),
  refusal_explainer_cites_case_law_evidence_next_step: includes("cites case law", "evidence", "next step"),
  refusal_explainer_falls_back_to_block_reason: includes("falls back to block reasons"),
  refusal_explainer_ignores_unrelated_non_guardrail: includes("does not cite unrelated case law", "non-guardrail proof blocks"),
  refusal_explainer_ignores_inactive_stale_refs: includes("does not cite inactive case law", "stale graph reference"),
  antibody_matcher_proposes_without_binding: includes("proposes inherited guardrails", "without binding"),
  antibody_matcher_ignores_inactive_cases: includes("does not propose antibodies", "proposed", "deprecated", "superseded", "overturned"),
  antibody_matcher_ignores_unrelated_safe_nodes: includes("ignores unrelated safe action nodes"),
  antibody_matcher_deterministic_order_ids: includes("orders candidates by confidence", "deterministic candidate ids"),
};
