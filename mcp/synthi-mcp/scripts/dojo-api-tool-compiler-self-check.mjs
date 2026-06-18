#!/usr/bin/env node
/*
 * Run the focused Agent Dojo API-backed tool compiler gate and emit a
 * digest-backed evidence manifest. This makes source/API graduation proof
 * explicit instead of relying on buried unit-test names.
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

export const DOJO_API_TOOL_COMPILER_TEST_FILES = [
  "tests/unit/dojo_api_candidate.test.ts",
  "tests/unit/dojo_api_tool_compiler.test.ts",
  "tests/unit/dojo_substrate_executor.test.ts",
  "tests/unit/dojo_tools.test.ts",
];

export const DOJO_API_TOOL_COMPILER_CAPABILITIES = [
  "api_candidate_infers_network_trace",
  "api_candidate_blocks_unreviewed_mutation",
  "api_candidate_requires_mutation_safety_fields",
  "api_candidate_requires_strict_response_schema",
  "api_tool_compiles_proof_gated_strict_contract",
  "api_tool_validates_proof_license_idempotency_and_payload",
  "api_tool_requires_api_substrate_proof_claim",
  "api_tool_enforces_strict_input_schema",
  "api_tool_executes_with_idempotency_postcondition_and_evidence",
  "api_tool_blocks_transport_on_proof_or_license_failure",
  "api_tool_preserves_evidence_on_postcondition_failure",
  "substrate_rejects_unapproved_api_candidate",
  "substrate_requires_compiled_api_tool_for_production",
  "substrate_executes_compiled_api_with_transport_and_evidence_callbacks",
  "substrate_blocks_graph_api_proof_mismatch",
  "substrate_blocks_non_api_graph_proof_for_api_execution",
  "substrate_prefers_safest_licensed_substrate",
  "api_tool_public_surface_prepares_reviewed_contract",
  "api_tool_public_surface_publishes_api_backed_manifest",
  "api_tool_public_surface_requires_reviewer_evidence_before_publication",
  "api_tool_public_surface_runs_compiled_tool",
  "api_tool_public_surface_runs_published_tool_name_via_skill_bus",
  "api_tool_public_surface_blocks_unpublished_compiled_tool_in_production",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-api-tool-compiler"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo API tool compiler output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoApiToolCompilerSelfCheck({ outDir });
  console.log(`[ok] Dojo API tool compiler self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoApiToolCompilerSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-api-tool-compiler"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_API_TOOL_COMPILER_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing API tool compiler test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-api-tool-compiler.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_API_TOOL_COMPILER_TEST_FILES,
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
    "Dojo API tool compiler self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_API_TOOL_COMPILER_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-api-tool-compiler.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-api-tool-compiler.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoApiToolCompilerEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    basicRunDurationMs: null,
    testFiles: DOJO_API_TOOL_COMPILER_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-api-tool-compiler.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_api_tool_compiler_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoApiToolCompilerEvidenceManifest({
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
  timeoutMs = 120000,
  error,
  testRun,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildApiToolCompilerCapabilityCoverage({
    capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildApiToolCompilerBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_API_TOOL_COMPILER_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    promotion_contract: {
      reviewed_candidate_required: true,
      proof_capsule_required: true,
      license_kernel_required: true,
      idempotency_required: true,
      auth_scope_required: true,
      strict_input_schema_required: true,
      postcondition_required: true,
      evidence_write_required: true,
      graph_proof_match_required: true,
      api_substrate_proof_claim_required: true,
      production_candidate_only_execution_allowed: false,
      self_check_executes_tests_required: true,
    },
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
    ...(error ? { error } : {}),
  };
}

export function buildApiToolCompilerCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildApiToolCompilerBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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

function capabilityMatchers(capability) {
  switch (capability) {
    case "api_candidate_infers_network_trace":
      return ["infers a simple endpoint candidate", "network trace"];
    case "api_candidate_blocks_unreviewed_mutation":
      return ["does not promote mutation candidates", "without idempotency"];
    case "api_candidate_requires_mutation_safety_fields":
      return ["allows approved mutation candidates", "required safety fields"];
    case "api_candidate_requires_strict_response_schema":
      return ["does not promote approved candidates", "permissive response schemas"];
    case "api_tool_compiles_proof_gated_strict_contract":
      return ["compiles an approved mutation endpoint", "proof gated strict"];
    case "api_tool_validates_proof_license_idempotency_and_payload":
      return ["validates invocation proof", "license context", "idempotency"];
    case "api_tool_requires_api_substrate_proof_claim":
      return ["requires api tool proof substrate mismatch", "before reusable proof validation"];
    case "api_tool_enforces_strict_input_schema":
      return ["enforces the compiled api tool input schema"];
    case "api_tool_executes_with_idempotency_postcondition_and_evidence":
      return ["executes approved api backed tools", "idempotency", "evidence"];
    case "api_tool_blocks_transport_on_proof_or_license_failure":
      return ["does not call the api transport", "proof or license validation fails"];
    case "api_tool_preserves_evidence_on_postcondition_failure":
      return ["blocks execution when api postconditions fail", "preserving evidence"];
    case "substrate_rejects_unapproved_api_candidate":
      return ["rejects checkride api substrate actions", "without approved candidate"];
    case "substrate_requires_compiled_api_tool_for_production":
      return ["rejects production api candidate only execution", "compiled api tool"];
    case "substrate_executes_compiled_api_with_transport_and_evidence_callbacks":
      return ["executes compiled api substrate", "transport", "evidence callbacks"];
    case "substrate_blocks_graph_api_proof_mismatch":
      return ["does not execute compiled api transport", "graph proof and api proof do not match"];
    case "substrate_blocks_non_api_graph_proof_for_api_execution":
      return ["does not execute compiled api transport", "graph proof is not api bound"];
    case "substrate_prefers_safest_licensed_substrate":
      return ["prefers the safest licensed substrate"];
    case "api_tool_public_surface_prepares_reviewed_contract":
      return ["prepares a reviewed api backed mcp tool contract", "network trace metadata"];
    case "api_tool_public_surface_publishes_api_backed_manifest":
      return ["publishes a reviewed api backed mcp tool", "skill manifest"];
    case "api_tool_public_surface_requires_reviewer_evidence_before_publication":
      return ["publishes a reviewed api backed mcp tool", "reviewer evidence"];
    case "api_tool_public_surface_runs_compiled_tool":
      return ["runs a compiled api backed mcp tool", "proof validation", "postcondition", "evidence"];
    case "api_tool_public_surface_runs_published_tool_name_via_skill_bus":
      return ["runs a published api backed mcp tool", "tool name", "skill bus dispatch"];
    case "api_tool_public_surface_blocks_unpublished_compiled_tool_in_production":
      return ["blocks direct compiled api backed tool execution", "production", "published through the skill bus"];
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
