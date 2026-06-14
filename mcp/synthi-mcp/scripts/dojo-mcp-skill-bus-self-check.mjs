#!/usr/bin/env node
/*
 * Build a digest-backed evidence manifest for the Agent Dojo MCP Skill Bus:
 * signed competency manifests, authorization, version pinning, proof-gated
 * dispatch, rate limits, audit custody, durable registration, and tenant
 * isolation.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_MCP_SKILL_BUS_TEST_FILES = [
  "tests/unit/dojo_mcp_manifest_signing.test.ts",
  "tests/unit/dojo_mcp_skill_bus.test.ts",
  "tests/integration/dojo_postgres_mcp_skill_bus_store.test.ts",
];

export const DOJO_MCP_SKILL_BUS_CAPABILITIES = [
  "mcp_manifest_builds_stable_signed_competency_manifest",
  "mcp_manifest_ed25519_public_verification",
  "mcp_manifest_derives_proof_required_from_license",
  "mcp_manifest_rejects_tampering_wrong_keys",
  "mcp_manifest_detects_default_local_signing_keys",
  "mcp_manifest_fails_closed_missing_ed25519_private_key",
  "mcp_manifest_rejects_invalid_algorithm",
  "mcp_skill_bus_lists_tenant_visible_licensed_competencies",
  "mcp_skill_bus_resolves_signed_manifest_with_authorization_version_checks",
  "mcp_skill_bus_blocks_ambiguous_tool_names",
  "mcp_skill_bus_dispatches_after_proof_validation_with_dry_run_side_effect_free",
  "mcp_skill_bus_fails_closed_without_proof_consumer",
  "mcp_skill_bus_validates_dispatch_through_proof_service",
  "mcp_skill_bus_consumes_proof_before_non_dry_dispatch",
  "mcp_skill_bus_requires_manifest_constraints_when_passport_stale",
  "mcp_skill_bus_blocks_manifest_unbound_proofs",
  "mcp_skill_bus_propagates_executor_blocks",
  "mcp_skill_bus_fails_closed_on_extension_errors",
  "mcp_skill_bus_rate_limits_before_proof_or_execution",
  "mcp_skill_bus_keeps_rate_limit_scopes_independent",
  "mcp_skill_bus_emits_structured_audit_events",
  "postgres_mcp_skill_bus_persists_signed_registrations_and_revocation",
  "postgres_mcp_skill_bus_records_invocations_with_audit_custody",
  "postgres_mcp_skill_bus_rejects_invalid_or_workspace_mismatched_manifests",
  "postgres_mcp_skill_bus_enforces_tenant_boundaries",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-mcp-skill-bus"));
  if (args["prepare-output-dir"]) {
    await mkdir(outDir, { recursive: true });
    console.log(`[ok] prepared Dojo MCP Skill Bus output dir - dir=${outDir}`);
    return;
  }
  const artifacts = await runDojoMcpSkillBusSelfCheck({ outDir });
  console.log(`[ok] Dojo MCP Skill Bus self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoMcpSkillBusSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 180000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-mcp-skill-bus"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_MCP_SKILL_BUS_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing MCP Skill Bus test files: ${missing.join(", ")}`);
  const startedAt = performance.now();
  const jsonReportPath = path.resolve(args["from-json"] || args["vitest-json"] || path.join(outputDir, "dojo-mcp-skill-bus.vitest.json"));
  const shouldRunTests = args["run-tests"] === "1"
    || args["run-tests"] === "true"
    || (!existsSync(jsonReportPath) && args["no-run-tests"] !== "1" && args["no-run-tests"] !== "true");
  const testRun = shouldRunTests
    ? await runMcpSkillBusVitestJson({ jsonReportPath, timeoutMs })
    : null;
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const durationMs = performance.now() - startedAt;
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const builderSummary = [
    "Dojo MCP Skill Bus self-check evidence builder",
    `vitest_json=${jsonReportPath}`,
    `vitest_executed=${testRun ? "true" : "false"}`,
    `test_files=${DOJO_MCP_SKILL_BUS_TEST_FILES.join(",")}`,
    `reported_tests=${testSummary.total_tests}`,
    `reported_test_files=${testSummary.reported_test_file_count}`,
  ].join("\n") + "\n";
  const stdout = testRun ? `${builderSummary}\n${testRun.stdout}` : builderSummary;
  const stderr = [
    testRun?.stderr ?? "",
    jsonReportError ? `${jsonReportError}\n` : "",
  ].filter(Boolean).join("\n");
  const stdoutPath = path.join(outputDir, "dojo-mcp-skill-bus.evidence-builder.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-mcp-skill-bus.evidence-builder.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoMcpSkillBusEvidenceManifest({
    now,
    exitCode: testRun?.exitCode ?? (jsonReport?.success === true ? 0 : 1),
    signal: testRun?.signal ?? null,
    durationMs,
    testFiles: DOJO_MCP_SKILL_BUS_TEST_FILES,
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
  const evidencePath = path.join(outputDir, "dojo-mcp-skill-bus.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (jsonReportError) throw new Error(`dojo_mcp_skill_bus_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

async function runMcpSkillBusVitestJson({ jsonReportPath, timeoutMs }) {
  await mkdir(path.dirname(jsonReportPath), { recursive: true });
  const vitestBin = require.resolve("vitest/vitest.mjs");
  const args = [
    vitestBin,
    "run",
    ...DOJO_MCP_SKILL_BUS_TEST_FILES,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ];
  const command = process.execPath;
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: MCP_ROOT,
      env: { ...process.env, CI: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode: 1,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        durationMs: performance.now() - startedAt,
        timedOut,
        error: `vitest_spawn_error:${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode: code ?? 1,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
        timedOut,
        error: timedOut ? "vitest_timeout" : undefined,
      });
    });
  });
}

export function buildDojoMcpSkillBusEvidenceManifest({
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
  const capabilityCoverage = buildMcpSkillBusCapabilityCoverage({
    capabilities: DOJO_MCP_SKILL_BUS_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildMcpSkillBusBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_MCP_SKILL_BUS_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    mcp_skill_bus_contract: {
      certified_competency_listing_required: true,
      tenant_authorization_required: true,
      signed_manifest_required: true,
      manifest_signature_verification_required: true,
      manifest_tamper_rejection_required: true,
      manifest_production_readiness_required: true,
      version_pinning_required: true,
      ambiguous_tool_block_required: true,
      proof_validation_required: true,
      proof_consume_required: true,
      proof_binding_required: true,
      dry_run_side_effect_free_required: true,
      fail_closed_required: true,
      executor_block_propagation_required: true,
      rate_limit_required: true,
      audit_events_required: true,
      durable_registration_required: true,
      revocation_required: true,
      durable_invocation_custody_required: true,
      tenant_boundary_required: true,
      direct_call_policy_required: true,
      postgres_registry_required: true,
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

function buildMcpSkillBusCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildMcpSkillBusBudgetEvaluation({
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
  mcp_manifest_builds_stable_signed_competency_manifest: includes("builds a stable signed competency manifest"),
  mcp_manifest_ed25519_public_verification: includes("signs manifests with ed25519", "public key material only"),
  mcp_manifest_derives_proof_required_from_license: includes("derives proof-required from license constraints"),
  mcp_manifest_rejects_tampering_wrong_keys: includes("rejects tampered manifest fields", "wrong signing keys"),
  mcp_manifest_detects_default_local_signing_keys: includes("detects default local signing keys"),
  mcp_manifest_fails_closed_missing_ed25519_private_key: includes("fails closed", "ed25519", "lacks private key material"),
  mcp_manifest_rejects_invalid_algorithm: includes("reports invalid manifest signing algorithm"),
  mcp_skill_bus_lists_tenant_visible_licensed_competencies: includes("lists only tenant-visible licensed competencies"),
  mcp_skill_bus_resolves_signed_manifest_with_authorization_version_checks: includes("resolves signed tool manifests", "authorization", "version checks"),
  mcp_skill_bus_blocks_ambiguous_tool_names: includes("blocks ambiguous tool names"),
  mcp_skill_bus_dispatches_after_proof_validation_with_dry_run_side_effect_free: includes("dispatches only after proof validation", "dry runs side-effect free"),
  mcp_skill_bus_fails_closed_without_proof_consumer: includes("fails closed", "no proof consumer"),
  mcp_skill_bus_validates_dispatch_through_proof_service: includes("validate dispatch proofs", "reusable proof capsule service"),
  mcp_skill_bus_consumes_proof_before_non_dry_dispatch: includes("consumes proof before non-dry dispatch"),
  mcp_skill_bus_requires_manifest_constraints_when_passport_stale: includes("requires proof from full manifest constraints", "passport metadata is stale"),
  mcp_skill_bus_blocks_manifest_unbound_proofs: includes("blocks proofs that are not bound", "resolved skill manifest"),
  mcp_skill_bus_propagates_executor_blocks: includes("propagates executor-level blocks"),
  mcp_skill_bus_fails_closed_on_extension_errors: includes("fails closed", "extension points throw"),
  mcp_skill_bus_rate_limits_before_proof_or_execution: includes("rate-limits dispatch", "before proof validation or execution"),
  mcp_skill_bus_keeps_rate_limit_scopes_independent: includes("keeps rate-limit scopes independent"),
  mcp_skill_bus_emits_structured_audit_events: includes("emits structured audit events"),
  postgres_mcp_skill_bus_persists_signed_registrations_and_revocation: includes("persists signed tool registrations", "revocation state"),
  postgres_mcp_skill_bus_records_invocations_with_audit_custody: includes("records mcp tool invocations", "audit custody"),
  postgres_mcp_skill_bus_rejects_invalid_or_workspace_mismatched_manifests: includes("rejects invalid or workspace-mismatched signed manifests"),
  postgres_mcp_skill_bus_enforces_tenant_boundaries: includes("enforces tenant boundaries", "tool registrations", "invocations"),
};
