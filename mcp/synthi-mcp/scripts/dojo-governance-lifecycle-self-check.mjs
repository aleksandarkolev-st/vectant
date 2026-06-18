#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo governance lifecycle
 * behavior. The self-check can run the focused Vitest suite itself and records
 * that execution in the evidence manifest.
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

export const DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES = [
  "tests/unit/dojo_tools.test.ts",
  "tests/unit/dojo_governance_service.test.ts",
  "tests/unit/dojo_postgres_governance_store_rbac.test.ts",
];

export const DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES = [
  "governance_reports_expired_and_active_license_health",
  "governance_reports_revoked_licenses_before_expiry",
  "governance_fails_closed_on_malformed_license_expiry",
  "governance_enforces_rbac_for_review_and_revocation",
  "governance_enforces_rbac_for_recertification",
  "governance_store_enforces_rbac_before_persisting_reviewed_records",
  "governance_records_permission_upgrade_decisions_with_evidence",
  "governance_rejects_non_pending_permission_upgrade_decisions",
  "governance_requires_permission_upgrade_review_attribution_time_evidence",
  "governance_records_case_law_review_decisions_with_evidence",
  "governance_rejects_non_pending_case_law_review",
  "governance_requires_case_law_review_attribution_time_evidence",
  "governance_revokes_license_to_blocked_scope_with_audit",
  "governance_requires_license_revocation_reason_actor_evidence",
  "governance_builds_approval_queue",
  "governance_builds_case_law_review_queue",
  "governance_builds_dashboard_metrics",
  "governance_includes_control_plane_audit_exports",
  "governance_surfaces_malformed_expiry_in_recertification_queue",
  "governance_builds_skill_registry_and_policy_gates",
  "governance_builds_recertification_audit_export_and_compliance_views",
  "governance_adds_proof_public_verification_custody",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-governance-lifecycle"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo governance lifecycle output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoGovernanceLifecycleSelfCheck({ outDir });
  console.log(`[ok] Dojo governance lifecycle self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoGovernanceLifecycleSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-governance-lifecycle"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing governance lifecycle test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-governance-lifecycle.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
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
    "Dojo governance lifecycle self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-governance-lifecycle.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-governance-lifecycle.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoGovernanceLifecycleEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-governance-lifecycle.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_governance_lifecycle_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoGovernanceLifecycleEvidenceManifest({
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
  const capabilityCoverage = buildGovernanceLifecycleCapabilityCoverage({
    capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildGovernanceLifecycleBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    governance_contract: {
      license_health_required: true,
      approval_queue_required: true,
      approval_decision_audit_required: true,
      rbac_required: true,
      recertification_rbac_required: true,
      store_rbac_required: true,
      case_law_review_required: true,
      license_revocation_required: true,
      recertification_queue_required: true,
      policy_gates_required: true,
      audit_export_required: true,
      compliance_pack_required: true,
      proof_public_verification_custody_required: true,
      malformed_expiry_fails_closed_required: true,
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

export function buildGovernanceLifecycleCapabilityCoverage({ capabilities, jsonReport }) {
  const titles = summarizeVitestJsonReport(jsonReport).assertion_titles;
  return capabilities.map((capability) => {
    const evidenceTitles = evidenceTitlesForCapability(capability, titles);
    return {
      capability,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
}

function buildGovernanceLifecycleBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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

function evidenceTitlesForCapability(capability, titles) {
  if (capability === "governance_enforces_rbac_for_review_and_revocation") {
    const requiredTitleMatchers = [
      ["authorizes governance actions", "generic rbac roles"],
      ["fails closed", "governance actions", "required rbac roles"],
      ["enforces rbac", "permission upgrade review"],
      ["enforces rbac", "case law review"],
      ["enforces rbac", "license revocation"],
      ["enforces rbac", "production license revocation", "mcp tool"],
    ];
    const matched = [];
    for (const matchers of requiredTitleMatchers) {
      const title = titles.find((candidate) => {
        const normalizedTitle = normalizeText(candidate);
        return matchers.every((matcher) => normalizedTitle.includes(matcher));
      });
      if (!title) return [];
      matched.push(title);
    }
    return matched;
  }
  if (capability === "governance_enforces_rbac_for_recertification") {
    const requiredTitleMatchers = [
      ["authorizes governance actions", "generic rbac roles"],
      ["enforces rbac", "production license recertification", "mcp tool"],
    ];
    const matched = [];
    for (const matchers of requiredTitleMatchers) {
      const title = titles.find((candidate) => {
        const normalizedTitle = normalizeText(candidate);
        return matchers.every((matcher) => normalizedTitle.includes(matcher));
      });
      if (!title) return [];
      matched.push(title);
    }
    return matched;
  }
  if (capability === "governance_store_enforces_rbac_before_persisting_reviewed_records") {
    const requiredTitleMatchers = [
      ["postgresdojogovernancestore rbac enforcement", "rejects reviewed permission upgrade records before sql"],
      ["postgresdojogovernancestore rbac enforcement", "rejects reviewed case law records before sql"],
      ["postgresdojogovernancestore rbac enforcement", "rejects reviewed records before sql", "review actor differs"],
      ["postgresdojogovernancestore rbac enforcement", "allows reviewed governance records", "required role"],
    ];
    const matched = [];
    for (const matchers of requiredTitleMatchers) {
      const title = titles.find((candidate) => {
        const normalizedTitle = normalizeText(candidate);
        return matchers.every((matcher) => normalizedTitle.includes(matcher));
      });
      if (!title) return [];
      matched.push(title);
    }
    return matched;
  }
  const matchers = capabilityMatchers(capability);
  return titles.filter((title) => {
    const normalizedTitle = normalizeText(title);
    return matchers.every((matcher) => normalizedTitle.includes(matcher));
  });
}

function capabilityMatchers(capability) {
  switch (capability) {
    case "governance_reports_expired_and_active_license_health":
      return ["reports expired and active license health"];
    case "governance_reports_revoked_licenses_before_expiry":
      return ["reports revoked licenses before expiry checks"];
    case "governance_fails_closed_on_malformed_license_expiry":
      return ["fails closed", "license health expiry metadata", "malformed"];
    case "governance_enforces_rbac_for_review_and_revocation":
      return ["enforces rbac"];
    case "governance_enforces_rbac_for_recertification":
      return ["enforces rbac", "recertification"];
    case "governance_store_enforces_rbac_before_persisting_reviewed_records":
      return ["postgres dojo governance store rbac enforcement"];
    case "governance_records_permission_upgrade_decisions_with_evidence":
      return ["records permission upgrade approval and denial decisions", "review evidence"];
    case "governance_rejects_non_pending_permission_upgrade_decisions":
      return ["rejects permission upgrade decisions", "no longer pending"];
    case "governance_requires_permission_upgrade_review_attribution_time_evidence":
      return ["rejects permission upgrade decisions", "reviewer attribution", "timestamp", "evidence"];
    case "governance_records_case_law_review_decisions_with_evidence":
      return ["records case law approval and deprecation decisions", "review evidence"];
    case "governance_rejects_non_pending_case_law_review":
      return ["rejects case law approval", "no longer proposed"];
    case "governance_requires_case_law_review_attribution_time_evidence":
      return ["rejects case law review decisions", "reviewer attribution", "timestamp", "evidence"];
    case "governance_revokes_license_to_blocked_scope_with_audit":
      return ["revokes licenses", "blocked scope"];
    case "governance_requires_license_revocation_reason_actor_evidence":
      return ["requires explicit reason", "actor attribution", "license revocation"];
    case "governance_builds_approval_queue":
      return ["builds approval queue items"];
    case "governance_builds_case_law_review_queue":
      return ["builds case law review queue"];
    case "governance_builds_dashboard_metrics":
      return ["builds dashboard metrics"];
    case "governance_includes_control_plane_audit_exports":
      return ["includes stored control plane audit events", "audit exports", "compliance pack"];
    case "governance_surfaces_malformed_expiry_in_recertification_queue":
      return ["surfaces malformed license expiry", "recertification queue"];
    case "governance_builds_skill_registry_and_policy_gates":
      return ["builds skill registry", "policy gates"];
    case "governance_builds_recertification_audit_export_and_compliance_views":
      return ["builds recertification", "audit export", "compliance pack views"];
    case "governance_adds_proof_public_verification_custody":
      return ["adds proof public verification custody", "compliance pack"];
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
