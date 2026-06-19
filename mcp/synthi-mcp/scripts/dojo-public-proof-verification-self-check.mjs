#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Agent Dojo public proof
 * verification: external verification, Ed25519 public keys, ledger-bound
 * evidence claims, tamper/context rejection, key custody status policy, and
 * public verification bundle exports that omit private or HMAC secrets.
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

export const DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES = [
  "tests/unit/dojo_public_proof_verifier.test.ts",
  "tests/unit/dojo_proof_public_verification_export.test.ts",
];

export const DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES = [
  "public_proof_verifies_evidence_backed_capsule",
  "public_proof_blocks_tampered_context",
  "public_proof_verifies_ed25519_public_key",
  "public_proof_requires_evidence_claim_refs",
  "public_proof_requires_valid_ledger_checkpoint",
  "public_proof_rejects_invalid_timestamp_window",
  "public_proof_rejects_invalid_validation_time",
  "public_proof_verifies_key_custody_record",
  "public_proof_allows_retired_key_verification",
  "public_proof_blocks_revoked_key_without_forensic",
  "public_verification_bundle_exports_public_keys_only",
  "public_verification_bundle_exports_key_custody_metadata",
  "public_verification_bundle_filters_tenant_keys",
  "public_verification_bundle_marks_unavailable_keys",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-public-proof-verification"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo public proof verification evidence output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoPublicProofVerificationSelfCheck({ outDir });
  console.log(`[ok] Dojo public proof verification self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoPublicProofVerificationSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-public-proof-verification"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing public proof verification test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-public-proof-verification.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
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
    "Dojo public proof verification evidence self-check builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun?.stdout ? `${builderSummary}${testRun.stdout}` : builderSummary;
  const stderrParts = [];
  if (testRun?.stderr) stderrParts.push(testRun.stderr);
  if (jsonReportError) stderrParts.push(jsonReportError);
  const stderr = stderrParts.length > 0 ? `${stderrParts.join("\n")}\n` : "";
  const stdoutPath = path.join(outputDir, "dojo-public-proof-verification.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-public-proof-verification.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoPublicProofVerificationEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-public-proof-verification.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_public_proof_verification_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoPublicProofVerificationEvidenceManifest({
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
  const capabilityCoverage = buildPublicProofVerificationCapabilityCoverage({
    capabilities: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildPublicProofVerificationBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    public_proof_verification_contract: {
      external_verifier_required: true,
      ed25519_public_key_required: true,
      evidence_claim_ledger_binding_required: true,
      tamper_and_context_blocks_required: true,
      timestamp_window_required: true,
      proof_key_custody_policy_required: true,
      public_export_required: true,
      key_custody_metadata_export_required: true,
      private_secret_exclusion_required: true,
      tenant_scoped_key_export_required: true,
      unavailable_key_marking_required: true,
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
    test_execution: testRun
      ? {
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
      }
      : null,
    ...(error ? { error } : {}),
  };
}

function buildPublicProofVerificationCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildPublicProofVerificationBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
  public_proof_verifies_evidence_backed_capsule: includes("evidence-backed capsule", "external verifier"),
  public_proof_blocks_tampered_context: includes("tampered", "context-mismatched"),
  public_proof_verifies_ed25519_public_key: includes("ed25519 capsule", "public key material"),
  public_proof_requires_evidence_claim_refs: includes("required evidence claims", "no evidence refs"),
  public_proof_requires_valid_ledger_checkpoint: includes("malformed ledger checkpoint"),
  public_proof_rejects_invalid_timestamp_window: includes("non-forward proof timestamp windows"),
  public_proof_rejects_invalid_validation_time: includes("verifier timestamp is malformed"),
  public_proof_verifies_key_custody_record: includes("proof-key custody record"),
  public_proof_allows_retired_key_verification: includes("retired proof keys", "historical capsules"),
  public_proof_blocks_revoked_key_without_forensic: includes("revoked proof keys", "forensic verification"),
  public_verification_bundle_exports_public_keys_only: includes("public verification bundle", "without private material"),
  public_verification_bundle_exports_key_custody_metadata: includes("public verification bundle", "custody metadata"),
  public_verification_bundle_filters_tenant_keys: includes("tenant-scoped", "public verification bundle"),
  public_verification_bundle_marks_unavailable_keys: includes("non-public or revoked key records unavailable"),
};
