#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo Vivarium runtime,
 * executable checkride, and Evil Twin behavior. The focused Vitest suites run
 * first and this script validates their JSON report before writing evidence.
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

export const DOJO_VIVARIUM_RUNTIME_TEST_FILES = [
  "tests/unit/dojo_scenario_dsl.test.ts",
  "tests/unit/dojo_fixture_materializer.test.ts",
  "tests/unit/dojo_scenario_oracle.test.ts",
  "tests/integration/dojo_api_fault_server.test.ts",
  "tests/integration/dojo_vivarium_runner.test.ts",
  "tests/integration/dojo_checkride_runner.test.ts",
  "tests/integration/dojo_evil_twin_runner.test.ts",
];

export const DOJO_VIVARIUM_RUNTIME_CAPABILITIES = [
  "scenario_dsl_validates_duplicate_entity",
  "scenario_dsl_validates_fake_success_oracle",
  "scenario_dsl_classifies_invalid_value_data_tissue",
  "scenario_dsl_classifies_document_tissue_specific_evidence",
  "scenario_dsl_classifies_ui_tissue_specific_evidence",
  "scenario_dsl_classifies_misleading_toast_ui_tissue",
  "scenario_dsl_classifies_policy_tissue_scenarios",
  "scenario_dsl_classifies_expanded_identity_tissue_scenarios",
  "scenario_dsl_classifies_route_tissue_scenarios",
  "scenario_dsl_classifies_downstream_failure_api_tissue",
  "scenario_dsl_rejects_missing_oracle_or_fixtures",
  "scenario_dsl_converts_generated_scenarios",
  "fixture_materializer_creates_duplicate_stable_ids",
  "fixture_materializer_rejects_production_data_refs",
  "fixture_materializer_materializes_stale_missing_threshold_states",
  "fixture_materializer_materializes_invalid_value_data_tissue",
  "fixture_materializer_materializes_policy_tissue",
  "fixture_materializer_materializes_expanded_identity_tissue",
  "fixture_materializer_materializes_route_tissue",
  "fixture_materializer_materializes_downstream_failure_api_tissue",
  "fixture_materializer_quarantines_prompt_injection_documents",
  "fixture_materializer_blocks_role_downgrade_identity_tissue",
  "fixture_materializer_fails_unquarantined_prompt_injection",
  "fixture_materializer_materializes_missing_corrupted_documents",
  "fixture_materializer_materializes_ambiguous_document_names",
  "fixture_materializer_materializes_ui_tissue_mutations",
  "fixture_materializer_is_deterministic",
  "scenario_oracle_classifies_expected_block",
  "scenario_oracle_fails_duplicate_without_stable_identity",
  "scenario_oracle_passes_required_evidence",
  "scenario_oracle_fails_missing_required_evidence",
  "scenario_oracle_requires_prompt_injection_quarantine",
  "scenario_oracle_fails_unquarantined_prompt_injection",
  "scenario_oracle_appends_ledger_ready_evidence",
  "api_fault_server_returns_fake_visual_success_without_commit",
  "api_fault_server_exposes_partial_write",
  "api_fault_server_supports_error_timeout_downstream",
  "vivarium_runner_executes_baseline_through_fixtures_graph_oracle",
  "vivarium_runner_classifies_fake_success_from_state",
  "vivarium_runner_executes_partial_write_faults",
  "vivarium_runner_executes_validation_error_api_tissue",
  "vivarium_runner_executes_latency_timeout_api_tissue",
  "vivarium_runner_executes_downstream_failure_api_tissue",
  "vivarium_runner_emits_policy_tissue_evidence",
  "vivarium_runner_emits_expanded_identity_evidence",
  "vivarium_runner_emits_invalid_value_evidence",
  "vivarium_runner_emits_stale_entity_data_tissue_evidence",
  "vivarium_runner_emits_missing_field_data_tissue_evidence",
  "vivarium_runner_emits_missing_document_field_tissue_evidence",
  "vivarium_runner_emits_corrupted_document_tissue_evidence",
  "vivarium_runner_emits_ambiguous_document_name_tissue_evidence",
  "vivarium_runner_emits_ui_tissue_evidence",
  "vivarium_runner_emits_misleading_toast_ui_evidence",
  "vivarium_runner_emits_route_tissue_evidence",
  "vivarium_runner_requires_prompt_injection_quarantine",
  "vivarium_runner_uses_deterministic_run_clock",
  "vivarium_runner_blocks_exhausted_budget",
  "vivarium_runner_blocks_completed_budget_overruns",
  "vivarium_runner_blocks_runtime_execution_failures",
  "vivarium_runner_executes_targeted_nodes_and_ancestors",
  "vivarium_runner_keeps_targeted_postcondition_assertions",
  "vivarium_runner_blocks_missing_target_nodes",
  "vivarium_runner_proves_deterministic_reset",
  "checkride_runner_rejects_happy_path_only_when_risk_fails",
  "checkride_runner_records_blocked_risk_license_constraints",
  "checkride_runner_marks_unquarantined_prompt_injection_critical",
  "checkride_runner_passes_substrate_hooks",
  "evil_twin_measures_attack_success_from_observed_outcomes",
  "evil_twin_catches_auth_expiry_attacks",
  "evil_twin_passes_substrate_hooks",
  "evil_twin_hardening_reduces_attack_success_rate",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-vivarium-runtime"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo Vivarium runtime output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoVivariumRuntimeSelfCheck({ outDir });
  console.log(`[ok] Dojo Vivarium runtime self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoVivariumRuntimeSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 180000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-vivarium-runtime"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_VIVARIUM_RUNTIME_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing Vivarium runtime test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-vivarium-runtime.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_VIVARIUM_RUNTIME_TEST_FILES,
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
    "Dojo Vivarium runtime self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_VIVARIUM_RUNTIME_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-vivarium-runtime.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-vivarium-runtime.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoVivariumRuntimeEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_VIVARIUM_RUNTIME_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-vivarium-runtime.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_vivarium_runtime_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoVivariumRuntimeEvidenceManifest({
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
  testRun,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildVivariumRuntimeCapabilityCoverage({
    capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildVivariumRuntimeBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_VIVARIUM_RUNTIME_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    vivarium_contract: {
      scenario_dsl_required: true,
      synthetic_fixture_materialization_required: true,
      synthetic_only_policy_required: true,
      oracle_required: true,
      ledger_ready_oracle_evidence_required: true,
      api_fault_server_required: true,
      fake_success_state_detection_required: true,
      partial_write_detection_required: true,
      api_downstream_failure_tissue_required: true,
      prompt_injection_quarantine_required: true,
      ambiguous_document_names_required: true,
      document_tissue_specific_evidence_required: true,
      ui_tissue_mutations_required: true,
      ui_tissue_specific_evidence_required: true,
      misleading_toast_tissue_required: true,
      route_tissue_required: true,
      policy_tissue_required: true,
      expanded_identity_tissue_required: true,
      invalid_value_data_tissue_required: true,
      stale_missing_data_tissue_required: true,
      api_validation_latency_tissue_required: true,
      deterministic_reset_required: true,
      budget_enforcement_required: true,
      targeted_graph_execution_required: true,
      targeted_postcondition_descendants_required: true,
      executable_checkride_required: true,
      license_constraints_from_blocked_risk_required: true,
      critical_guardrail_failure_required: true,
      substrate_hook_passthrough_required: true,
      evil_twin_attack_measurement_required: true,
      evil_twin_hardening_loop_required: true,
      self_check_executes_tests_required: true,
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

export function buildVivariumRuntimeCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildVivariumRuntimeBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
    case "scenario_dsl_validates_duplicate_entity":
      return ["scenario dsl validates duplicate entity scenario definitions", "deterministic fixtures"];
    case "scenario_dsl_validates_fake_success_oracle":
      return ["scenario dsl validates fake success scenario definitions", "evidence oracle"];
    case "scenario_dsl_classifies_invalid_value_data_tissue":
      return ["scenario dsl classifies invalid value scenarios", "data validation tissue"];
    case "scenario_dsl_classifies_document_tissue_specific_evidence":
      return ["scenario dsl classifies document tissue scenarios", "specific evidence requirements"];
    case "scenario_dsl_classifies_ui_tissue_specific_evidence":
      return ["scenario dsl classifies ui tissue scenarios", "specific evidence requirements"];
    case "scenario_dsl_classifies_misleading_toast_ui_tissue":
      return ["scenario dsl classifies misleading toast ui tissue", "specific evidence requirements"];
    case "scenario_dsl_classifies_policy_tissue_scenarios":
      return ["scenario dsl classifies policy tissue scenarios", "thresholds and unavailable approvals"];
    case "scenario_dsl_classifies_expanded_identity_tissue_scenarios":
      return ["scenario dsl classifies expanded identity tissue scenarios", "permissions and workspace context"];
    case "scenario_dsl_classifies_route_tissue_scenarios":
      return ["scenario dsl classifies route change scenarios", "synthetic page route tissue"];
    case "scenario_dsl_classifies_downstream_failure_api_tissue":
      return ["scenario dsl classifies downstream failure scenarios", "api fault tissue"];
    case "scenario_dsl_rejects_missing_oracle_or_fixtures":
      return ["scenario dsl rejects invalid scenarios", "without oracle or synthetic fixtures"];
    case "scenario_dsl_converts_generated_scenarios":
      return ["scenario dsl converts current generated scenario shape"];
    case "fixture_materializer_creates_duplicate_stable_ids":
      return ["synthetic fixture materializer creates duplicate entity fixtures", "different stable ids"];
    case "fixture_materializer_rejects_production_data_refs":
      return ["synthetic fixture materializer rejects production data references"];
    case "fixture_materializer_materializes_stale_missing_threshold_states":
      return ["materializes stale entity missing field and threshold breach fixture states"];
    case "fixture_materializer_materializes_invalid_value_data_tissue":
      return ["synthetic fixture materializer materializes invalid data values", "without production data"];
    case "fixture_materializer_materializes_policy_tissue":
      return ["synthetic fixture materializer materializes policy approval blockers", "without production policy data"];
    case "fixture_materializer_materializes_expanded_identity_tissue":
      return ["synthetic fixture materializer materializes expanded identity tissue", "auth expiry missing permissions and workspace changes"];
    case "fixture_materializer_materializes_route_tissue":
      return ["synthetic fixture materializer materializes route change tissue", "deterministic synthetic page route"];
    case "fixture_materializer_materializes_downstream_failure_api_tissue":
      return ["synthetic fixture materializer materializes downstream api failures", "synthetic api fault tissue"];
    case "fixture_materializer_quarantines_prompt_injection_documents":
      return ["materializes prompt injection document fixtures", "quarantined synthetic tissue"];
    case "fixture_materializer_blocks_role_downgrade_identity_tissue":
      return ["materializes role downgrade permission change identity tissue", "blocked synthetic state"];
    case "fixture_materializer_fails_unquarantined_prompt_injection":
      return ["materializes unquarantined prompt injection document fixtures", "failed synthetic tissue"];
    case "fixture_materializer_materializes_missing_corrupted_documents":
      return ["materializes missing and corrupted document tissue states"];
    case "fixture_materializer_materializes_ambiguous_document_names":
      return ["synthetic fixture materializer materializes ambiguous document names", "distinct synthetic document ids"];
    case "fixture_materializer_materializes_ui_tissue_mutations":
      return ["synthetic fixture materializer materializes ui tissue mutations", "layout labels validation and destructive adjacency"];
    case "fixture_materializer_is_deterministic":
      return ["synthetic fixture materializer is deterministic", "same scenario and seed"];
    case "scenario_oracle_classifies_expected_block":
      return ["scenario oracle classifies an expected block"];
    case "scenario_oracle_fails_duplicate_without_stable_identity":
      return ["scenario oracle classifies duplicate entity completion", "without stable identity evidence"];
    case "scenario_oracle_passes_required_evidence":
      return ["scenario oracle classifies successful graph completion", "required evidence"];
    case "scenario_oracle_fails_missing_required_evidence":
      return ["scenario oracle fails completed graph results", "without required observed evidence"];
    case "scenario_oracle_requires_prompt_injection_quarantine":
      return ["scenario oracle requires quarantine evidence", "prompt injection document"];
    case "scenario_oracle_fails_unquarantined_prompt_injection":
      return ["scenario oracle fails prompt injection document scenarios", "instructions are not quarantined"];
    case "scenario_oracle_appends_ledger_ready_evidence":
      return ["scenario oracle builds and appends ledger ready oracle evidence records"];
    case "api_fault_server_returns_fake_visual_success_without_commit":
      return ["api fault server returns fake visual success", "durable state remains uncommitted"];
    case "api_fault_server_exposes_partial_write":
      return ["api fault server leaves an oracle detectable partial write"];
    case "api_fault_server_supports_error_timeout_downstream":
      return ["api fault server supports success validation error timeout and downstream failure"];
    case "vivarium_runner_executes_baseline_through_fixtures_graph_oracle":
      return ["vivarium runner runs a baseline scenario", "materialized fixtures graph runtime and oracle"];
    case "vivarium_runner_classifies_fake_success_from_state":
      return ["vivarium runner classifies fake success", "observed fixture state"];
    case "vivarium_runner_executes_partial_write_faults":
      return ["vivarium runner executes partial write scenarios", "api fault server"];
    case "vivarium_runner_executes_validation_error_api_tissue":
      return ["vivarium runner executes validation error api tissue", "api fault server"];
    case "vivarium_runner_executes_latency_timeout_api_tissue":
      return ["vivarium runner executes latency api tissue", "timeout through the api fault server"];
    case "vivarium_runner_executes_downstream_failure_api_tissue":
      return ["vivarium runner executes downstream failure api tissue", "api fault server"];
    case "vivarium_runner_emits_policy_tissue_evidence":
      return ["vivarium runner emits policy tissue evidence", "policy fixtures block scenario execution"];
    case "vivarium_runner_emits_expanded_identity_evidence":
      return ["vivarium runner emits expanded identity evidence", "workspace context changes block execution"];
    case "vivarium_runner_emits_invalid_value_evidence":
      return ["vivarium runner emits invalid value evidence", "invalid data blocks execution"];
    case "vivarium_runner_emits_stale_entity_data_tissue_evidence":
      return ["vivarium runner emits stale entity data tissue evidence", "stale ids block execution"];
    case "vivarium_runner_emits_missing_field_data_tissue_evidence":
      return ["vivarium runner emits missing field data tissue evidence", "required synthetic fields block execution"];
    case "vivarium_runner_emits_missing_document_field_tissue_evidence":
      return ["vivarium runner emits missing field document tissue evidence", "materialized documents"];
    case "vivarium_runner_emits_corrupted_document_tissue_evidence":
      return ["vivarium runner emits corrupted document tissue evidence", "materialized documents"];
    case "vivarium_runner_emits_ambiguous_document_name_tissue_evidence":
      return ["vivarium runner emits ambiguous name document tissue evidence", "distinct synthetic document ids"];
    case "vivarium_runner_emits_ui_tissue_evidence":
      return ["vivarium runner emits ui tissue evidence", "layout label table modal and adjacency mutations"];
    case "vivarium_runner_emits_misleading_toast_ui_evidence":
      return ["vivarium runner emits misleading toast ui evidence", "materialized false success toast state"];
    case "vivarium_runner_emits_route_tissue_evidence":
      return ["vivarium runner emits route tissue evidence", "synthetic page route changes"];
    case "vivarium_runner_requires_prompt_injection_quarantine":
      return ["vivarium runner passes prompt injection scenarios", "document instructions are quarantined"];
    case "vivarium_runner_uses_deterministic_run_clock":
      return ["vivarium runner generates deterministic run ids and timestamps", "run clock"];
    case "vivarium_runner_blocks_exhausted_budget":
      return ["vivarium runner classifies exhausted scenario budget", "blocked run"];
    case "vivarium_runner_blocks_completed_budget_overruns":
      return ["vivarium runner blocks completed scenario runs", "exceed time or model call budgets"];
    case "vivarium_runner_blocks_runtime_execution_failures":
      return ["vivarium runner classifies runtime execution failures", "blocked scenario runs"];
    case "vivarium_runner_executes_targeted_nodes_and_ancestors":
      return ["vivarium runner executes only targeted graph nodes", "required ancestors"];
    case "vivarium_runner_keeps_targeted_postcondition_assertions":
      return ["vivarium runner keeps postcondition assertion descendants", "targeted scenarios"];
    case "vivarium_runner_blocks_missing_target_nodes":
      return ["vivarium runner blocks scenarios", "missing target graph nodes"];
    case "vivarium_runner_proves_deterministic_reset":
      return ["vivarium runner proves fixture reset is deterministic"];
    case "checkride_runner_rejects_happy_path_only_when_risk_fails":
      return ["executable checkride runner uses runtime and oracle evidence", "happy path alone is not enough"];
    case "checkride_runner_records_blocked_risk_license_constraints":
      return ["executable checkride runner records blocked risk scenarios", "license constraints"];
    case "checkride_runner_marks_unquarantined_prompt_injection_critical":
      return ["executable checkride runner treats unquarantined prompt injection", "critical guardrail failures"];
    case "checkride_runner_passes_substrate_hooks":
      return ["executable checkride runner passes substrate executor hooks"];
    case "evil_twin_measures_attack_success_from_observed_outcomes":
      return ["evil twin runtime measures attack success", "observed vivarium outcomes"];
    case "evil_twin_catches_auth_expiry_attacks":
      return ["evil twin runtime classifies auth expiry attacks", "graph blocks on auth preconditions"];
    case "evil_twin_passes_substrate_hooks":
      return ["evil twin runtime passes substrate executor hooks"];
    case "evil_twin_hardening_reduces_attack_success_rate":
      return ["evil twin runtime reruns attacks after guardrail hardening", "reduces attack success rate"];
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
