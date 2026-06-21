#!/usr/bin/env node
/*
 * Run the focused Agent Dojo managed-key proof-signing gate and emit a
 * digest-backed evidence manifest. Local execution proves the production
 * signing contract. Release-candidate evidence must also attach an observed
 * managed-key service signing artifact through the release observation input.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarizeVitestJsonReport } from "./dojo-chaos-performance-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const require = createRequire(import.meta.url);

export const DOJO_MANAGED_KEY_SIGNING_TEST_FILES = [
  "tests/unit/dojo_proof_signing.test.ts",
  "tests/unit/deployment_readiness.test.ts",
  "tests/unit/dojo_enforcement_config.test.ts",
  "tests/unit/dojo_public_proof_verifier.test.ts",
];

export const DOJO_MANAGED_KEY_SIGNING_CAPABILITIES = [
  "managed_key_service_signer_verifies_with_public_key",
  "managed_key_service_requires_command_and_key_uri",
  "managed_key_service_rejects_uri_mismatch",
  "managed_key_service_rejects_local_custody_metadata",
  "production_readiness_accepts_managed_key_service",
  "production_readiness_rejects_incomplete_managed_key_service",
  "production_readiness_rejects_local_signing_material",
  "external_signing_requirement_rejects_local_custody",
  "public_verifier_accepts_ed25519_key_material",
];

export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION = "synthi.dojo.managedKeySigningReleaseObservation.v1";

export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_ENV = "SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH";

export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS = [
  "managed_key_service_observed",
  "managed_key_uri_observed",
  "managed_key_custody_observed",
  "signature_verified_with_public_key",
  "public_key_material_observed",
  "signer_config_redacted",
  "no_private_key_material_exported",
  "signer_outage_fail_closed_observed",
  "uri_mismatch_rejected_observed",
  "local_custody_rejected_observed",
  "release_artifact_digest_observed",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-managed-key-signing"));
  const artifacts = await runDojoManagedKeySigningSelfCheck({ outDir });
  console.log(`[ok] Dojo managed-key signing self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoManagedKeySigningSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-managed-key-signing"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_MANAGED_KEY_SIGNING_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing managed-key signing test files: ${missing.join(", ")}`);

  const vitestPath = resolveVitestPath();
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const basicRunDurationMs = performance.now() - startedAt;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-managed-key-signing.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-managed-key-signing.stderr.log");
  const jsonReportPath = path.join(outputDir, "dojo-managed-key-signing.vitest.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const jsonResult = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const jsonStdout = String(jsonResult.stdout ?? "");
  const jsonStderr = String(jsonResult.stderr ?? "");
  await writeFile(path.join(outputDir, "dojo-managed-key-signing.json-reporter.stdout.log"), jsonStdout);
  await writeFile(path.join(outputDir, "dojo-managed-key-signing.json-reporter.stderr.log"), jsonStderr);
  const jsonReportError = existsSync(jsonReportPath) ? undefined : `json_report_missing:${jsonReportPath}`;
  const jsonReportText = jsonReportError ? "" : await readFile(jsonReportPath, "utf8");
  const jsonReport = jsonReportError ? null : JSON.parse(jsonReportText);
  const releaseObservationPath = args["release-observation"] || process.env[DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_ENV];
  const releaseObservation = await loadDojoManagedKeySigningReleaseObservation({
    observationPath: releaseObservationPath,
    now,
  });
  const durationMs = performance.now() - startedAt;
  const testExecution = {
    command: process.execPath,
    args: [
      vitestPath,
      "run",
      ...DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
      "--reporter=basic",
    ],
    exit_code: result.status ?? null,
    signal: result.signal ?? null,
    duration_ms: Number(basicRunDurationMs.toFixed(3)),
    timed_out: result.error?.code === "ETIMEDOUT",
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
  };
  const evidence = buildDojoManagedKeySigningEvidenceManifest({
    now,
    exitCode: result.status ?? jsonResult.status,
    signal: result.signal ?? jsonResult.signal,
    durationMs,
    basicRunDurationMs,
    testFiles: DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
    stdout,
    stderr: [stderr, jsonStderr].filter(Boolean).join("\n"),
    stdoutPath,
    stderrPath,
    jsonReport,
    jsonReportPath,
    jsonReportText,
    timeoutMs,
    testExecution,
    error: result.error?.message ?? jsonResult.error?.message ?? jsonReportError,
    releaseObservation,
  });
  const evidencePath = path.join(outputDir, "dojo-managed-key-signing.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (result.error) throw new Error(`dojo_managed_key_signing_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_managed_key_signing_self_check_failed:exit_${result.status}`);
  if (jsonResult.error) throw new Error(`dojo_managed_key_signing_json_report_failed:${jsonResult.error.message}`);
  if (jsonResult.status !== 0) throw new Error(`dojo_managed_key_signing_json_report_failed:exit_${jsonResult.status}`);
  if (jsonReportError) throw new Error(`dojo_managed_key_signing_json_report_failed:${jsonReportError}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoManagedKeySigningEvidenceManifest({
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
  testExecution,
  error,
  releaseObservation,
}) {
  const testSummary = summarizeVitestJsonReport(jsonReport);
  const capabilityCoverage = buildManagedKeySigningCapabilityCoverage({
    capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
    jsonReport,
  });
  const budgetEvaluation = buildManagedKeySigningBudgetEvaluation({
    capabilityCoverage,
    testSummary,
    testFiles,
    durationMs,
    timeoutMs,
    error,
  });
  return {
    schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error && budgetEvaluation.ok,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    configured_capabilities: [...DOJO_MANAGED_KEY_SIGNING_CAPABILITIES],
    tested_capabilities: capabilityCoverage.filter((item) => item.covered).map((item) => item.capability),
    missing_capabilities: capabilityCoverage.filter((item) => !item.covered).map((item) => item.capability),
    capability_coverage: capabilityCoverage,
    capability_count: capabilityCoverage.filter((item) => item.covered).length,
    configured_capability_count: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    capability_coverage_complete: capabilityCoverage.every((item) => item.covered),
    signing_contract: {
      provider: "managed-key-service",
      algorithm: "ed25519",
      request_schema_version: "synthi.dojo.managedKeySignerRequest.v1",
      response_schema_version: "synthi.dojo.managedKeySignerResponse.v1",
      key_custody: "managed",
      required_request_fields: ["schema_version", "algorithm", "key_id", "key_uri", "payload"],
      required_response_fields: ["schema_version", "algorithm", "key_id", "key_uri", "key_custody", "signature"],
      production_private_key_material_allowed: false,
      public_verifier_material_required: true,
      release_managed_key_observation_required: releaseObservation?.release_ready === true,
    },
    release_managed_key_observation: normalizeDojoManagedKeySigningReleaseObservation(releaseObservation, { now }),
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    reported_test_file_count: testSummary.reported_test_file_count,
    test_summary: testSummary,
    test_execution: testExecution ?? null,
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
    ...(error ? { error } : {}),
  };
}

export async function loadDojoManagedKeySigningReleaseObservation({ observationPath, now = new Date().toISOString() } = {}) {
  if (!observationPath) {
    return buildDojoManagedKeySigningSelfCheckObservation({ now });
  }
  const resolvedPath = path.resolve(String(observationPath));
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  return normalizeDojoManagedKeySigningReleaseObservation(extractManagedKeySigningReleaseObservation(parsed), {
    now,
    observationPath: resolvedPath,
  });
}

export function buildDojoManagedKeySigningSelfCheckObservation({ now = new Date().toISOString() } = {}) {
  return {
    schema_version: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
    source: "unit_self_check",
    scope: "self_check",
    observed_at: now,
    observed: false,
    release_ready: false,
    provider: "managed-key-service",
    algorithm: "ed25519",
    key_id: "",
    key_uri: "",
    key_custody: "managed",
    signature_verified: false,
    public_key_sha256: "",
    signed_payload_sha256: "",
    signature_sha256: "",
    checks: Object.fromEntries(DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS.map((check) => [check, false])),
    redacted_config: {
      command_redacted: true,
      args_redacted: true,
      env_redacted: true,
      private_key_material_present: false,
      secret_values_present: false,
    },
    artifact_refs: [],
    reason: "focused managed-key signing unit self-check does not observe a live managed signing service",
  };
}

export function normalizeDojoManagedKeySigningReleaseObservation(observation, { now = new Date().toISOString(), observationPath } = {}) {
  const source = observation && typeof observation === "object" ? observation : {};
  const checks = source.checks && typeof source.checks === "object" ? source.checks : {};
  const redactedConfig = source.redacted_config && typeof source.redacted_config === "object" ? source.redacted_config : {};
  return {
    schema_version: source.schema_version || DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
    source: String(source.source || "unknown"),
    scope: String(source.scope || "unknown"),
    observed_at: String(source.observed_at || now),
    observed: source.observed === true,
    release_ready: source.release_ready === true,
    provider: String(source.provider || ""),
    algorithm: String(source.algorithm || ""),
    key_id: String(source.key_id || ""),
    key_uri: String(source.key_uri || ""),
    key_custody: String(source.key_custody || ""),
    signature_verified: source.signature_verified === true,
    public_key_sha256: String(source.public_key_sha256 || ""),
    signed_payload_sha256: String(source.signed_payload_sha256 || ""),
    signature_sha256: String(source.signature_sha256 || ""),
    checks: Object.fromEntries(DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS.map((check) => [check, checks[check] === true])),
    redacted_config: {
      command_redacted: redactedConfig.command_redacted === true,
      args_redacted: redactedConfig.args_redacted === true,
      env_redacted: redactedConfig.env_redacted === true,
      private_key_material_present: redactedConfig.private_key_material_present === true,
      secret_values_present: redactedConfig.secret_values_present === true,
    },
    artifact_refs: Array.isArray(source.artifact_refs)
      ? source.artifact_refs.map((ref) => ({
        kind: String(ref?.kind || "artifact"),
        artifact_path: String(ref?.artifact_path || ""),
        artifact_sha256: String(ref?.artifact_sha256 || ""),
      }))
      : [],
    ...(observationPath ? { observation_path: observationPath } : {}),
    ...(source.reason ? { reason: String(source.reason) } : {}),
  };
}

function extractManagedKeySigningReleaseObservation(parsed) {
  if (parsed?.schema_version === DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION) return parsed;
  if (parsed?.release_managed_key_observation) return parsed.release_managed_key_observation;
  return parsed;
}

export function buildManagedKeySigningCapabilityCoverage({ capabilities, jsonReport }) {
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

function buildManagedKeySigningBudgetEvaluation({ capabilityCoverage, testSummary, testFiles, durationMs, timeoutMs, error }) {
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
    case "managed_key_service_signer_verifies_with_public_key":
      return ["signs through a managed key service signer", "verifies"];
    case "managed_key_service_requires_command_and_key_uri":
      return ["requires managed key service command", "key uri"];
    case "managed_key_service_rejects_uri_mismatch":
      return ["managed key service returns mismatched custody metadata"];
    case "managed_key_service_rejects_local_custody_metadata":
      return ["managed key service returns mismatched custody metadata"];
    case "production_readiness_accepts_managed_key_service":
      return ["passes production readiness", "managed key service proof signing"];
    case "production_readiness_rejects_incomplete_managed_key_service":
      return ["fails production readiness", "incomplete managed key service proof signing"];
    case "production_readiness_rejects_local_signing_material":
      return ["fails production readiness", "local ed25519 proof signing material"];
    case "external_signing_requirement_rejects_local_custody":
      return ["requires external custody", "external proof signing is required"];
    case "public_verifier_accepts_ed25519_key_material":
      return ["verifies an ed25519 capsule", "public key material"];
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

function resolveVitestPath() {
  try {
    return require.resolve("vitest/vitest.mjs");
  } catch {
    return path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  }
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}
