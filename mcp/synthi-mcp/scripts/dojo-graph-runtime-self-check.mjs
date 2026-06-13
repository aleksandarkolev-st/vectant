#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for the Agent Dojo executable graph
 * runtime. The focused graph Vitest suites run first and this script validates
 * their JSON report before writing release-gate evidence.
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

export const DOJO_GRAPH_RUNTIME_TEST_FILES = [
  "tests/unit/dojo_graph_types.test.ts",
  "tests/unit/dojo_graph_compiler.test.ts",
  "tests/unit/dojo_graph_runtime.test.ts",
];

export const DOJO_GRAPH_RUNTIME_CAPABILITIES = [
  "graph_ir_validates_production_proof_guardrail_assertion_coverage",
  "graph_ir_rejects_dangerous_actions_without_guardrails",
  "graph_ir_rejects_production_actions_without_proof",
  "graph_ir_rejects_proof_without_required_claims",
  "graph_ir_rejects_unbound_proof_guardrails",
  "graph_ir_rejects_mutations_without_assertions",
  "graph_ir_rejects_non_executable_guardrail_predicates",
  "graph_ir_validates_node_preconditions",
  "graph_ir_validates_edge_references_and_confidence",
  "graph_ir_validates_branch_predicates",
  "graph_ir_rejects_unreachable_nodes",
  "graph_compiler_emits_validated_ir",
  "graph_compiler_inserts_permission_guardrail_proof_assertion",
  "graph_compiler_preserves_source_api_bindings",
  "graph_compiler_adapts_repo_artifacts",
  "graph_runtime_executes_production_with_valid_proof",
  "graph_runtime_executes_edge_order",
  "graph_runtime_emits_evidence_events",
  "graph_runtime_blocks_evidence_write_failure",
  "graph_runtime_requires_ledger_backed_evidence_refs",
  "graph_runtime_blocks_failed_preconditions",
  "graph_runtime_blocks_missing_proof",
  "graph_runtime_blocks_invalid_proof",
  "graph_runtime_blocks_proof_validator_failure",
  "graph_runtime_requires_substrate_executor",
  "graph_runtime_blocks_substrate_executor_failure",
  "graph_runtime_requires_graph_evidence_writer",
  "graph_runtime_executes_explicit_proof_nodes",
  "graph_runtime_requires_proof_validator",
  "graph_runtime_rejects_self_attested_proof",
  "graph_runtime_blocks_expired_nodes",
  "graph_runtime_blocks_active_expiry_triggers",
  "graph_runtime_selects_matching_branches",
  "graph_runtime_selects_default_branches",
  "graph_runtime_blocks_unmatched_branches",
  "graph_runtime_allows_retry_within_limit",
  "graph_runtime_blocks_retry_limit",
  "graph_runtime_requires_retry_policy",
  "graph_runtime_executes_binding_case_law",
  "graph_runtime_blocks_inactive_case_law",
  "graph_runtime_executes_available_rollback",
  "graph_runtime_blocks_unavailable_rollback_without_human_review",
  "graph_runtime_pauses_for_human_decisions",
  "graph_runtime_resumes_after_human_approval",
  "graph_runtime_blocks_human_denial",
  "graph_runtime_blocks_invalid_graphs",
  "graph_runtime_blocks_unreachable_actions",
  "graph_runtime_evaluates_predicate_dsl",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-graph-runtime"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo graph runtime output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoGraphRuntimeSelfCheck({ outDir });
  console.log(`[ok] Dojo graph runtime self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoGraphRuntimeSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-graph-runtime"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_GRAPH_RUNTIME_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing graph runtime test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-graph-runtime.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo graph runtime self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_GRAPH_RUNTIME_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-graph-runtime.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-graph-runtime.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoGraphRuntimeEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_GRAPH_RUNTIME_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-graph-runtime.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_graph_runtime_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoGraphRuntimeEvidenceManifest({
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
  const capabilityCoverage = buildGraphRuntimeCapabilityCoverage({
    capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildGraphRuntimeBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_GRAPH_RUNTIME_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    graph_runtime_contract: {
      graph_ir_validation_required: true,
      graph_compiler_required: true,
      source_api_binding_required: true,
      production_execution_required: true,
      edge_order_required: true,
      evidence_events_required: true,
      ledger_backed_evidence_required: true,
      preconditions_required: true,
      proof_gate_required: true,
      substrate_executor_required: true,
      expiry_required: true,
      branch_runtime_required: true,
      retry_runtime_required: true,
      case_law_runtime_required: true,
      rollback_runtime_required: true,
      human_resume_required: true,
      validation_fail_closed_required: true,
      predicate_dsl_required: true,
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

export function buildGraphRuntimeCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildGraphRuntimeBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
    case "graph_ir_validates_production_proof_guardrail_assertion_coverage":
      return ["validates a minimal production graph", "proof guardrail and assertion coverage"];
    case "graph_ir_rejects_dangerous_actions_without_guardrails":
      return ["rejects dangerous actions without guardrails"];
    case "graph_ir_rejects_production_actions_without_proof":
      return ["rejects production actions without explicit proof requirements"];
    case "graph_ir_rejects_proof_without_required_claims":
      return ["rejects production proof requirements without required claims"];
    case "graph_ir_rejects_unbound_proof_guardrails":
      return ["rejects dangerous production action proof", "not bound to blocking guardrails"];
    case "graph_ir_rejects_mutations_without_assertions":
      return ["rejects mutation actions without assertions"];
    case "graph_ir_rejects_non_executable_guardrail_predicates":
      return ["rejects guardrail predicates", "not executable"];
    case "graph_ir_validates_node_preconditions":
      return ["validates executable node preconditions", "malformed precondition predicates"];
    case "graph_ir_validates_edge_references_and_confidence":
      return ["rejects edges that reference missing nodes", "invalid confidence"];
    case "graph_ir_validates_branch_predicates":
      return ["validates executable edge conditions", "malformed branch predicates"];
    case "graph_ir_rejects_unreachable_nodes":
      return ["rejects graph nodes", "not reachable"];
    case "graph_compiler_emits_validated_ir":
      return ["graph compiler compiles", "validated graph ir"];
    case "graph_compiler_inserts_permission_guardrail_proof_assertion":
      return ["inserts permission guardrail proof and assertion semantics"];
    case "graph_compiler_preserves_source_api_bindings":
      return ["preserves source and api bindings"];
    case "graph_compiler_adapts_repo_artifacts":
      return ["adapts existing repo graph artifacts"];
    case "graph_runtime_executes_production_with_valid_proof":
      return ["executes a valid production graph", "proof and preconditions"];
    case "graph_runtime_executes_edge_order":
      return ["executes nodes in graph edge order"];
    case "graph_runtime_emits_evidence_events":
      return ["emits graph run evidence events"];
    case "graph_runtime_blocks_evidence_write_failure":
      return ["returns a blocked run", "graph evidence writing fails"];
    case "graph_runtime_requires_ledger_backed_evidence_refs":
      return ["blocks production actions", "ledger backed ref"];
    case "graph_runtime_blocks_failed_preconditions":
      return ["blocks a node when static preconditions fail"];
    case "graph_runtime_blocks_missing_proof":
      return ["blocks production proof required actions without proof"];
    case "graph_runtime_blocks_invalid_proof":
      return ["blocks production proof required actions", "proof validation fails"];
    case "graph_runtime_blocks_proof_validator_failure":
      return ["blocks production proof required actions", "proof validation throws"];
    case "graph_runtime_requires_substrate_executor":
      return ["blocks production action execution", "without an explicit substrate executor"];
    case "graph_runtime_blocks_substrate_executor_failure":
      return ["blocks production action execution", "substrate executor throws"];
    case "graph_runtime_requires_graph_evidence_writer":
      return ["blocks production action execution", "without an explicit graph evidence writer"];
    case "graph_runtime_executes_explicit_proof_nodes":
      return ["blocks explicit production proof nodes", "before action execution"];
    case "graph_runtime_requires_proof_validator":
      return ["blocks production proof required actions without a validator"];
    case "graph_runtime_rejects_self_attested_proof":
      return ["rejects self attested proof"];
    case "graph_runtime_blocks_expired_nodes":
      return ["blocks an explicitly expired node"];
    case "graph_runtime_blocks_active_expiry_triggers":
      return ["blocks a node when one of its expiry triggers is active"];
    case "graph_runtime_selects_matching_branches":
      return ["selects a matching branch path"];
    case "graph_runtime_selects_default_branches":
      return ["selects a default branch path"];
    case "graph_runtime_blocks_unmatched_branches":
      return ["blocks a branch node", "no outgoing edge condition matches"];
    case "graph_runtime_allows_retry_within_limit":
      return ["allows a retry node", "below the configured limit"];
    case "graph_runtime_blocks_retry_limit":
      return ["blocks a retry node once", "attempt limit is reached"];
    case "graph_runtime_requires_retry_policy":
      return ["blocks retry nodes", "do not declare a retry policy"];
    case "graph_runtime_executes_binding_case_law":
      return ["executes case law nodes", "referenced cases are binding"];
    case "graph_runtime_blocks_inactive_case_law":
      return ["blocks case law nodes", "binding state is missing or inactive"];
    case "graph_runtime_executes_available_rollback":
      return ["executes rollback nodes", "available rollback policy"];
    case "graph_runtime_blocks_unavailable_rollback_without_human_review":
      return ["blocks rollback nodes", "unavailable without human review"];
    case "graph_runtime_pauses_for_human_decisions":
      return ["pauses at a human node", "approval is missing"];
    case "graph_runtime_resumes_after_human_approval":
      return ["resumes after human approval"];
    case "graph_runtime_blocks_human_denial":
      return ["blocks when a human decision is denied"];
    case "graph_runtime_blocks_invalid_graphs":
      return ["blocks execution when graph validation fails"];
    case "graph_runtime_blocks_unreachable_actions":
      return ["blocks unreachable action nodes"];
    case "graph_runtime_evaluates_predicate_dsl":
      return ["evaluates simple equality preconditions"];
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
