#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for the Agent-Ready UI Contract
 * schema/linter: risky action proof hooks, proof-required policy, stable
 * locators, success hooks, accessibility labels, blocked contexts, enum
 * validation, malformed array handling, and proof/risk mismatch warnings.
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

export const DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES = [
  "tests/unit/dojo_agent_ready_ui_contract.test.ts",
];

export const DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES = [
  "agent_ready_ui_contract_accepts_valid_risky_contract",
  "agent_ready_ui_contract_requires_proof_hook",
  "agent_ready_ui_contract_requires_proof_for_risky_action",
  "agent_ready_ui_contract_requires_stable_locator_success_hook_accessibility_label_blocked_contexts",
  "agent_ready_ui_contract_rejects_invalid_runtime_enums",
  "agent_ready_ui_contract_handles_malformed_arrays",
  "agent_ready_ui_contract_warns_proof_risk_mismatch",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-agent-ready-ui-contract"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo Agent-Ready UI Contract evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoAgentReadyUiContractSelfCheck({ outDir });
  console.log(`[ok] Dojo Agent-Ready UI Contract self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoAgentReadyUiContractSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-agent-ready-ui-contract"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Agent-Ready UI Contract test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-agent-ready-ui-contract.vitest.json"));
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const stdout = [
    "Dojo Agent-Ready UI Contract evidence self-check builder",
    `vitest_json=${jsonReportPath}`,
    `test_files=${DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stderr = jsonReportError ? `${jsonReportError}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-agent-ready-ui-contract.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-agent-ready-ui-contract.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoAgentReadyUiContractEvidenceManifest({
    now,
    exitCode: jsonReport?.success === true ? 0 : 1,
    signal: null,
    durationMs,
    testFiles: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-agent-ready-ui-contract.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_agent_ready_ui_contract_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoAgentReadyUiContractEvidenceManifest({
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
  const capabilityCoverage = buildAgentReadyUiContractCapabilityCoverage({
    capabilities: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildAgentReadyUiContractBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    agent_ready_ui_contract: {
      schema_linter_required: true,
      stable_locator_required: true,
      success_hook_required: true,
      proof_hook_required: true,
      proof_required_for_risky_action_required: true,
      accessibility_label_required: true,
      blocked_contexts_required: true,
      runtime_enum_validation_required: true,
      malformed_array_safety_required: true,
      proof_risk_mismatch_warning_required: true,
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

function buildAgentReadyUiContractCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildAgentReadyUiContractBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
  agent_ready_ui_contract_accepts_valid_risky_contract: includes("valid risky action contract", "stable locator", "proof hook", "success hook"),
  agent_ready_ui_contract_requires_proof_hook: includes("risky actions missing proof hooks"),
  agent_ready_ui_contract_requires_proof_for_risky_action: includes("proof hook", "opt out of proof"),
  agent_ready_ui_contract_requires_stable_locator_success_hook_accessibility_label_blocked_contexts: includes("missing stable locator", "success hook", "accessibility label", "blocked contexts"),
  agent_ready_ui_contract_rejects_invalid_runtime_enums: includes("runtime-invalid enum values"),
  agent_ready_ui_contract_handles_malformed_arrays: includes("malformed substrate and blocked context arrays"),
  agent_ready_ui_contract_warns_proof_risk_mismatch: includes("warns when proof requirement does not match risk"),
};
