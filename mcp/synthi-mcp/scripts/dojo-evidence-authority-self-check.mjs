#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for Dojo evidence authority:
 * canonical ledger records, record signatures, claim verification, fail-closed
 * ledger resolution, redaction/export controls, and proof issuance that depends
 * on verified ledger-backed evidence rather than caller assertions.
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

export const DOJO_EVIDENCE_AUTHORITY_TEST_FILES = [
  "tests/unit/dojo_evidence_record.test.ts",
  "tests/unit/dojo_evidence_claim_verifier.test.ts",
  "tests/unit/dojo_evidence_ledger_resolver.test.ts",
  "tests/unit/dojo_evidence_redaction.test.ts",
  "tests/unit/dojo_evidence_export.test.ts",
  "tests/unit/dojo_evidence_retention.test.ts",
  "tests/unit/dojo_evidence_custody.test.ts",
  "tests/unit/dojo_proof_claims.test.ts",
];

export const DOJO_EVIDENCE_AUTHORITY_CAPABILITIES = [
  "evidence_record_canonical_hash_chain",
  "evidence_record_signature_tamper_detection",
  "evidence_claim_verifier_fresh_missing_stale_scope_kind",
  "evidence_claim_verifier_requires_strict_scope",
  "evidence_ledger_resolver_fails_closed",
  "evidence_redaction_manifest_tamper_detection",
  "evidence_export_redacts_and_requires_ledger_records",
  "evidence_retention_policy_legal_hold_and_artifact_disposal",
  "evidence_external_storage_custody_receipts",
  "proof_issuance_requires_verified_evidence_records",
  "production_proof_issuance_rejects_unverified_claims",
  "proof_validation_rejects_self_attested_or_unreferenced_claims",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-evidence-authority"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo evidence authority output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoEvidenceAuthoritySelfCheck({ outDir });
  console.log(`[ok] Dojo evidence authority self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoEvidenceAuthoritySelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-evidence-authority"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_EVIDENCE_AUTHORITY_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing evidence authority test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-evidence-authority.vitest.json"));
  const shouldRunTests = shouldRunVitestForSelfCheck(args, jsonReportPath, existsSync);
  const testRun = shouldRunTests
    ? await runVitestJsonForSelfCheck({
      testFiles: DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
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
    "Dojo evidence authority self-check builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_EVIDENCE_AUTHORITY_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-evidence-authority.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-evidence-authority.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoEvidenceAuthorityEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-evidence-authority.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_evidence_authority_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoEvidenceAuthorityEvidenceManifest({
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
  const capabilityCoverage = buildEvidenceAuthorityCapabilityCoverage({
    capabilities: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildEvidenceAuthorityBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    evidence_authority: {
      canonical_record_hash_required: true,
      record_signature_verification_required: true,
      tamper_detection_required: true,
      claim_freshness_required: true,
      claim_scope_required: true,
      strict_claim_scope_required: true,
      claim_kind_required: true,
      ledger_resolver_fail_closed_required: true,
      redaction_manifest_required: true,
      redacted_export_required: true,
      evidence_retention_policy_required: true,
      legal_hold_blocks_disposal_required: true,
      external_storage_custody_receipts_required: true,
      proof_issue_claim_verification_required: true,
      production_proof_issue_rejects_unverified_claims_required: true,
      proof_validation_rejects_self_attested_claims_required: true,
      durable_postgres_ledger_gate_required: true,
      durable_postgres_ledger_gate_id: "dojo_postgres_control_plane_self_check",
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
    ...(error ? { error } : {}),
  };
}

function buildEvidenceAuthorityCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildEvidenceAuthorityBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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

const anyOf = (...matchers) => (title) => matchers.some((matcher) => matcher(title));

const CAPABILITY_MATCHERS = {
  evidence_record_canonical_hash_chain: anyOf(
    includes("stable record hashes", "canonical material fields"),
    includes("changes record hash", "material evidence fields"),
  ),
  evidence_record_signature_tamper_detection: anyOf(
    includes("signs evidence records", "verifier-compatible payload"),
    includes("detects tampered or untrusted evidence record signatures"),
  ),
  evidence_claim_verifier_fresh_missing_stale_scope_kind: anyOf(
    includes("verifies claims backed by fresh evidence records"),
    includes("returns missing for claims without backing records"),
    includes("returns stale when evidence is older"),
    includes("outside the requested evidence scope"),
    includes("wrong evidence kind"),
  ),
  evidence_claim_verifier_requires_strict_scope: anyOf(
    includes("fails strict verification", "required evidence scope is missing"),
  ),
  evidence_ledger_resolver_fails_closed: anyOf(
    includes("fails closed when record ids are missing"),
    includes("does not resolve production evidence from inline stores"),
    includes("requires a postgres connection url"),
  ),
  evidence_redaction_manifest_tamper_detection: anyOf(
    includes("redacts sensitive trace and storage fields"),
    includes("detects redacted content or manifest tampering"),
    includes("replaces binary screenshot evidence"),
  ),
  evidence_export_redacts_and_requires_ledger_records: anyOf(
    includes("exports redacted evidence metadata without raw artifact content"),
    includes("bound evidence record lacks redaction metadata"),
    includes("bound evidence record has different tenant scope"),
    includes("requires a ledger evidence record for external artifact uris"),
  ),
  evidence_retention_policy_legal_hold_and_artifact_disposal: anyOf(
    includes("preserves append-only ledger rows", "expired artifacts", "purge"),
    includes("uses redaction grace before purge grace"),
    includes("blocks deletion when legal hold is active"),
    includes("builds a scoped retention plan"),
  ),
  evidence_external_storage_custody_receipts: anyOf(
    includes("provider-neutral custody receipts", "ledger records"),
    includes("custody receipts are missing", "ledger records"),
    includes("local-only artifact uris", "external custody"),
    includes("tenant scope", "duplicate custody receipt ids"),
  ),
  proof_issuance_requires_verified_evidence_records: anyOf(
    includes("signs verified evidence record ids", "ledger checkpoint"),
    includes("blocks strict proof issuance when required evidence claims are missing"),
    includes("blocks strict proof issuance when supplied evidence record material is tampered"),
    includes("blocks strict proof issuance when backing evidence is stale"),
  ),
  production_proof_issuance_rejects_unverified_claims: anyOf(
    includes("blocks production proof issuance", "ledger-backed evidence"),
  ),
  proof_validation_rejects_self_attested_or_unreferenced_claims: anyOf(
    includes("development-compatible proof construction", "blocks validation without ledger evidence"),
    includes("caller-supplied evidence refs are not backed by ledger records"),
    includes("satisfied evidence claims have no evidence references"),
  ),
};
