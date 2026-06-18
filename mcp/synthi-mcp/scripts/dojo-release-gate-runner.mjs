#!/usr/bin/env node
/*
 * Plan and optionally execute Dojo release-gate commands from the authoritative
 * release-gate manifest. The runner records per-gate stdout/stderr digests so
 * local, milestone, and release runs can be audited without treating console
 * logs as proof by themselves.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDojoReleaseGateManifest,
  DOJO_ENTERPRISE_RELEASE_GATE_IDS,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  DOJO_RELEASE_GATE_COMMANDS,
  DOJO_RELEASE_GATE_IDS,
  validateDojoReleaseGateManifest,
} from "./dojo-release-gate-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gate-runner");
const DEFAULT_PACKAGE_JSON = "mcp/synthi-mcp/package.json";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const RUNNER_SCHEMA_VERSION = "synthi.dojo.releaseGateRun.v1";
const GATE_LOG_SCHEMA_VERSION = "synthi.dojo.releaseGateCommandLog.v1";
const ARTIFACT_FRESHNESS_TOLERANCE_MS = 2000;

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(String(args["out-dir"] || DEFAULT_OUT_DIR));
  if (truthy(args["self-check"])) {
    const result = await runSelfCheck({ outDir });
    console.log(`[ok] Dojo release gate runner self-check passed - report=${result.report_path} evidence=${result.evidence_path}`);
    return;
  }

  const scope = String(args.scope || "minimal-pr");
  const dryRun = truthy(args["dry-run"]) || !truthy(args.execute);
  const result = await runDojoReleaseGateRunner({
    scope,
    dryRun,
    execute: truthy(args.execute),
    outDir,
    manifest: args.manifest ? await readJsonFile(path.resolve(String(args.manifest))) : undefined,
    gateIds: argList(args.gate || args.gates),
    failOnMissingEnv: truthy(args["fail-on-missing-env"]),
    continueOnFailure: truthy(args["continue-on-failure"]),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : DEFAULT_TIMEOUT_MS,
    env: process.env,
  });
  if (!result.report.ok) {
    throw new Error(`dojo_release_gate_runner_failed:${result.report.errors.join(";")}`);
  }
  console.log(`[ok] Dojo release gate ${dryRun ? "plan" : "run"} written - report=${result.report_path} evidence=${result.evidence_path}`);
  if (!result.report.promotion_ready) {
    console.log(`[info] promotion_ready=false complete=${result.report.complete} skipped=${result.report.counts.skipped} failed=${result.report.counts.failed}`);
  }
}

export async function runDojoReleaseGateRunner({
  scope = "minimal-pr",
  dryRun = true,
  execute = false,
  outDir = DEFAULT_OUT_DIR,
  gateIds = [],
  failOnMissingEnv = false,
  continueOnFailure = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  executor = runGateCommand,
  generatedAt = new Date().toISOString(),
  manifest: suppliedManifest,
} = {}) {
  await mkdir(outDir, { recursive: true });
  const packageScripts = await readPackageScriptsForReleaseGates();
  const manifest = suppliedManifest || buildDojoReleaseGateManifest({ generatedAt, packageScripts });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  const plan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope,
    gateIds,
    env,
    failOnMissingEnv,
  });
  const results = dryRun || !execute
    ? plan.gates.map((gatePlan) => buildDryRunGateResult(gatePlan))
    : await executeDojoReleaseGatePlan({
      plan,
      outDir,
      env,
      timeoutMs,
      continueOnFailure,
      executor,
    });
  const report = buildDojoReleaseGateRunReport({
    manifest,
    manifestValidation: validation,
    plan,
    results,
    scope,
    dryRun: dryRun || !execute,
    generatedAt,
  });
  const reportPath = path.join(outDir, "dojo-release-gate-runner-report.json");
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, serializedReport, "utf8");
  const evidence = buildDojoReleaseGateRunEvidenceManifest({
    report,
    reportPath,
    serialized: serializedReport,
  });
  const evidencePath = path.join(outDir, "dojo-release-gate-runner.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    report_path: reportPath,
    evidence_path: evidencePath,
    report,
    evidence,
    plan,
    results,
  };
}

export function buildDojoReleaseGateExecutionPlan({
  manifest,
  scope = "minimal-pr",
  gateIds = [],
  env = process.env,
  failOnMissingEnv = false,
} = {}) {
  const selectedIds = gateIds.length > 0
    ? gateIds
    : selectDojoReleaseGateIds(manifest, { scope });
  const gatesById = new Map((manifest?.gates || []).map((gate) => [gate.id, gate]));
  const unknownGateIds = selectedIds.filter((id) => !gatesById.has(id));
  const gates = selectedIds
    .filter((id) => gatesById.has(id))
    .map((id) => {
      const gate = gatesById.get(id);
      const missingEnv = missingRequiredEnv(gate, env);
      const skipReason = missingEnv.length > 0 && !failOnMissingEnv
        ? "missing_required_env"
        : gate.script_exists === false
          ? "missing_package_script"
          : null;
      return {
        gate_id: gate.id,
        tier: gate.tier,
        required_for: [...(gate.required_for || [])],
        evidence_kind: gate.evidence_kind,
        package_json: gate.package_json || DEFAULT_PACKAGE_JSON,
        package_script: gate.package_script || null,
        display_command: gate.command || null,
        execution_spec: buildDojoReleaseGateCommandSpec(gate),
        expected_artifacts: expectedGateArtifacts(gate),
        requires_env: [...(gate.requires_env || [])],
        missing_env: missingEnv,
        status: skipReason ? "skipped" : "planned",
        skip_reason: skipReason,
        fail_if_missing_env: Boolean(failOnMissingEnv && missingEnv.length > 0),
      };
    });
  return {
    schema_version: "synthi.dojo.releaseGateExecutionPlan.v1",
    scope,
    selected_gate_ids: selectedIds,
    unknown_gate_ids: unknownGateIds,
    gate_count: gates.length,
    gates,
  };
}

export function selectDojoReleaseGateIds(manifest, { scope = "minimal-pr" } = {}) {
  const normalized = normalizeScope(scope);
  if (normalized === "minimal-pr") return [...(manifest?.minimal_pr_gate_ids || DOJO_MINIMAL_PR_GATE_IDS)];
  if (normalized === "milestone") return [...(manifest?.milestone_gate_ids || DOJO_MILESTONE_GATE_IDS)];
  if (normalized === "release") return [...(manifest?.release_gate_ids || DOJO_RELEASE_GATE_IDS)];
  if (normalized === "enterprise-release") return [...(manifest?.enterprise_release_gate_ids || DOJO_ENTERPRISE_RELEASE_GATE_IDS)];
  if (normalized === "nightly") {
    return (manifest?.gates || [])
      .filter((gate) => gate.required_for?.includes("nightly") || gate.tier === "T8")
      .map((gate) => gate.id);
  }
  throw new Error(`unknown_dojo_release_gate_scope:${scope}`);
}

export function buildDojoReleaseGateCommandSpec(gate) {
  if (!gate?.package_script) {
    return {
      executable: null,
      args: [],
      cwd: REPO_ROOT,
      cwd_display: normalizeRepoPath(REPO_ROOT),
      canonical_command: gate?.command || "",
      error: "missing_package_script",
    };
  }
  const packageJson = gate.package_json || DEFAULT_PACKAGE_JSON;
  const prefix = normalizeRepoPath(path.dirname(packageJson));
  const extraArgs = inferNpmExtraArgs(gate);
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["--prefix", prefix, "run", gate.package_script];
  if (extraArgs.length > 0) args.push("--", ...extraArgs);
  return {
    executable,
    args,
    cwd: REPO_ROOT,
    cwd_display: normalizeRepoPath(REPO_ROOT),
    package_prefix: prefix,
    canonical_command: ["npm", "--prefix", prefix, "run", gate.package_script, ...(extraArgs.length ? ["--", ...extraArgs] : [])].join(" "),
  };
}

export async function executeDojoReleaseGatePlan({
  plan,
  outDir,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  continueOnFailure = false,
  executor = runGateCommand,
} = {}) {
  const results = [];
  for (const gatePlan of plan.gates) {
    if (gatePlan.status === "skipped") {
      results.push(buildSkippedGateResult(gatePlan));
      continue;
    }
    if (gatePlan.fail_if_missing_env) {
      results.push({
        ...buildSkippedGateResult(gatePlan),
        status: "failed",
        failure_reason: "missing_required_env",
      });
      if (!continueOnFailure) break;
      continue;
    }
    const result = await executor({
      gatePlan,
      outDir,
      env,
      timeoutMs,
    });
    results.push(result);
    if (result.status === "failed" && !continueOnFailure) break;
  }
  return results;
}

export function buildDojoReleaseGateRunReport({
  manifest,
  manifestValidation,
  plan,
  results,
  scope,
  dryRun,
  generatedAt = new Date().toISOString(),
} = {}) {
  const counts = {
    selected: plan?.selected_gate_ids?.length || 0,
    planned: results.filter((result) => result.status === "planned").length,
    executed: results.filter((result) => result.executed).length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
  const errors = [];
  if (!manifestValidation?.ok) errors.push(...(manifestValidation?.errors || ["manifest_invalid"]));
  for (const id of plan?.unknown_gate_ids || []) errors.push(`unknown_gate:${id}`);
  for (const result of results || []) {
    if (result.status === "failed") errors.push(`gate_failed:${result.gate_id}:${result.failure_reason || result.exit_code}`);
  }
  const gateCoverage = summarizeRunnerGateResultCoverage({
    selectedGateIds: plan?.selected_gate_ids || [],
    results: results || [],
  });
  errors.push(...gateCoverage.errors);
  const allSelectedCovered = gateCoverage.ok && (plan?.unknown_gate_ids || []).length === 0;
  const complete = !dryRun
    && allSelectedCovered
    && counts.failed === 0
    && counts.skipped === 0
    && counts.passed === counts.selected;
  return {
    schema_version: RUNNER_SCHEMA_VERSION,
    run_id: `dojo-release-gate-run-${randomUUID()}`,
    generated_at: generatedAt,
    scope: normalizeScope(scope),
    dry_run: Boolean(dryRun),
    ok: errors.length === 0,
    complete,
    promotion_ready: complete,
    errors,
    manifest: {
      schema_version: manifest?.schema_version,
      sha256: sha256(JSON.stringify(manifest || {})),
      validation_ok: Boolean(manifestValidation?.ok),
      validation_errors: manifestValidation?.errors || [],
      gate_count: Array.isArray(manifest?.gates) ? manifest.gates.length : 0,
    },
    plan: {
      schema_version: plan?.schema_version,
      scope: plan?.scope,
      selected_gate_ids: plan?.selected_gate_ids || [],
      unknown_gate_ids: plan?.unknown_gate_ids || [],
      gate_count: plan?.gate_count || 0,
    },
    counts,
    results,
  };
}

function summarizeRunnerGateResultCoverage({ selectedGateIds, results }) {
  const selected = Array.isArray(selectedGateIds) ? selectedGateIds.map(String) : [];
  const selectedSet = new Set(selected);
  const resultIds = (Array.isArray(results) ? results : [])
    .map((result) => result?.gate_id)
    .filter((gateId) => typeof gateId === "string" && gateId.length > 0)
    .map(String);
  const resultCounts = new Map();
  for (const gateId of resultIds) {
    resultCounts.set(gateId, (resultCounts.get(gateId) || 0) + 1);
  }
  const errors = [];
  for (const gateId of selected) {
    if (!resultCounts.has(gateId)) errors.push(`runner_selected_gate_result_missing:${gateId}`);
  }
  for (const [gateId, count] of resultCounts.entries()) {
    if (count > 1) errors.push(`runner_duplicate_result_gate:${gateId}`);
    if (!selectedSet.has(gateId)) errors.push(`runner_unselected_result_gate:${gateId}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function buildDojoReleaseGateRunEvidenceManifest({ report, reportPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(report);
  const results = Array.isArray(report?.results) ? report.results : [];
  const producedArtifactCount = results.reduce((count, result) => (
    count + (Array.isArray(result.produced_artifacts) ? result.produced_artifacts.length : 0)
  ), 0);
  const commandLogDigestCount = results.filter((result) => result.stdout_sha256 && result.stderr_sha256).length;
  return {
    schema_version: "synthi.dojo.releaseGateRunEvidence.v1",
    generated_at: new Date().toISOString(),
    report_path: reportPath,
    report_sha256: sha256(body),
    report_bytes: Buffer.byteLength(body),
    run_id: report?.run_id,
    scope: report?.scope,
    dry_run: Boolean(report?.dry_run),
    ok: Boolean(report?.ok),
    complete: Boolean(report?.complete),
    promotion_ready: Boolean(report?.promotion_ready),
    selected_gate_count: report?.counts?.selected || 0,
    executed_gate_count: report?.counts?.executed || 0,
    passed_gate_count: report?.counts?.passed || 0,
    failed_gate_count: report?.counts?.failed || 0,
    skipped_gate_count: report?.counts?.skipped || 0,
    produced_artifact_count: producedArtifactCount,
    command_log_digest_count: commandLogDigestCount,
  };
}

async function runGateCommand({ gatePlan, outDir, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const logDir = path.join(outDir, "logs");
  await mkdir(logDir, { recursive: true });
  const { executable, args, cwd } = gatePlan.execution_spec;
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    try {
      child = spawn(executable, args, {
        cwd: path.isAbsolute(cwd) ? cwd : path.resolve(REPO_ROOT, cwd),
        env: { ...env, CI: "1" },
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      writeGateCommandResult({
        gatePlan,
        logDir,
        stdout,
        stderr,
        startedAtIso,
        durationMs: performance.now() - startedAt,
        exitCode: 1,
        signal: null,
        timedOut,
        failureReason: `spawn_error:${stderr}`,
      }).then(resolve, (writeError) => {
        resolve({
          gate_id: gatePlan.gate_id,
          tier: gatePlan.tier,
          status: "failed",
          executed: true,
          command: gatePlan.execution_spec.canonical_command,
          exit_code: 1,
          failure_reason: `spawn_error:${writeError instanceof Error ? writeError.message : String(writeError)}`,
        });
      });
      return;
    }
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
    child.on("error", async (error) => {
      clearTimeout(timer);
      stderr += stderr ? `\n${error.message}` : error.message;
      resolve(await writeGateCommandResult({
        gatePlan,
        logDir,
        stdout,
        stderr,
        startedAtIso,
        durationMs: performance.now() - startedAt,
        exitCode: 1,
        signal: null,
        timedOut,
        failureReason: `spawn_error:${error.message}`,
      }));
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      resolve(await writeGateCommandResult({
        gatePlan,
        logDir,
        stdout,
        stderr,
        startedAtIso,
        durationMs: performance.now() - startedAt,
        exitCode: code ?? 1,
        signal,
        timedOut,
        failureReason: timedOut ? "timeout" : undefined,
      }));
    });
  });
}

async function writeGateCommandResult({
  gatePlan,
  logDir,
  stdout,
  stderr,
  startedAtIso,
  durationMs,
  exitCode,
  signal,
  timedOut,
  failureReason,
}) {
  const stdoutPath = path.join(logDir, `${gatePlan.gate_id}.stdout.log`);
  const stderrPath = path.join(logDir, `${gatePlan.gate_id}.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const producedArtifacts = await collectDojoReleaseGateProducedArtifacts({
    expectedArtifacts: gatePlan.expected_artifacts,
    freshAfterIso: startedAtIso,
  });
  const missingExpectedArtifacts = producedArtifacts
    .filter((artifact) => artifact.required && !artifact.exists)
    .map((artifact) => artifact.kind);
  const staleExpectedArtifacts = producedArtifacts
    .filter((artifact) => artifact.required && artifact.exists && artifact.fresh === false)
    .map((artifact) => artifact.kind);
  const status = exitCode === 0 && !timedOut && missingExpectedArtifacts.length === 0 && staleExpectedArtifacts.length === 0
    ? "passed"
    : "failed";
  return {
    schema_version: GATE_LOG_SCHEMA_VERSION,
    gate_id: gatePlan.gate_id,
    tier: gatePlan.tier,
    status,
    executed: true,
    started_at: startedAtIso,
    duration_ms: Math.round(durationMs),
    command: gatePlan.execution_spec.canonical_command,
    exit_code: exitCode,
    signal,
    timed_out: Boolean(timedOut),
    failure_reason: status === "failed"
      ? failureReason || (missingExpectedArtifacts.length > 0
        ? `expected_artifact_missing:${missingExpectedArtifacts.join(",")}`
        : staleExpectedArtifacts.length > 0
          ? `expected_artifact_stale:${staleExpectedArtifacts.join(",")}`
        : "nonzero_exit")
      : null,
    stdout_path: normalizeRepoPath(path.relative(REPO_ROOT, stdoutPath)),
    stderr_path: normalizeRepoPath(path.relative(REPO_ROOT, stderrPath)),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    expected_artifacts: gatePlan.expected_artifacts,
    produced_artifacts: producedArtifacts,
    missing_expected_artifacts: missingExpectedArtifacts,
    stale_expected_artifacts: staleExpectedArtifacts,
  };
}

function buildDryRunGateResult(gatePlan) {
  if (gatePlan.status === "skipped") return buildSkippedGateResult(gatePlan);
  return {
    gate_id: gatePlan.gate_id,
    tier: gatePlan.tier,
    status: "planned",
    executed: false,
    command: gatePlan.execution_spec.canonical_command,
    expected_artifacts: gatePlan.expected_artifacts,
    requires_env: gatePlan.requires_env,
    missing_env: gatePlan.missing_env,
  };
}

function buildSkippedGateResult(gatePlan) {
  return {
    gate_id: gatePlan.gate_id,
    tier: gatePlan.tier,
    status: "skipped",
    executed: false,
    skip_reason: gatePlan.skip_reason || "not_executed",
    command: gatePlan.execution_spec.canonical_command,
    expected_artifacts: gatePlan.expected_artifacts,
    requires_env: gatePlan.requires_env,
    missing_env: gatePlan.missing_env,
  };
}

export async function collectDojoReleaseGateProducedArtifacts({
  expectedArtifacts,
  freshAfterIso,
  freshnessToleranceMs = ARTIFACT_FRESHNESS_TOLERANCE_MS,
} = {}) {
  const candidates = [
    ["report", expectedArtifacts?.report_path],
    ["evidence", expectedArtifacts?.evidence_path],
    ["events", expectedArtifacts?.events_path],
  ].filter(([, artifactPath]) => Boolean(artifactPath));
  const artifacts = [];
  const freshAfterMs = Number.isFinite(Date.parse(String(freshAfterIso)))
    ? Date.parse(String(freshAfterIso))
    : null;
  for (const [kind, artifactPath] of candidates) {
    const absolutePath = resolveExpectedArtifactPath(artifactPath);
    try {
      const bytes = await readFile(absolutePath);
      const info = await stat(absolutePath);
      const fresh = freshAfterMs === null
        ? null
        : info.mtimeMs + freshnessToleranceMs >= freshAfterMs;
      artifacts.push({
        kind,
        path: normalizeRepoPath(path.relative(REPO_ROOT, absolutePath)),
        exists: true,
        required: true,
        bytes: bytes.length,
        sha256: sha256(bytes),
        modified_at: info.mtime.toISOString(),
        mtime_ms: Number(info.mtimeMs.toFixed(3)),
        ...(freshAfterMs !== null ? {
          fresh_after: new Date(freshAfterMs).toISOString(),
          fresh_after_tolerance_ms: freshnessToleranceMs,
          fresh,
        } : {}),
      });
    } catch (error) {
      artifacts.push({
        kind,
        path: normalizeRepoPath(path.relative(REPO_ROOT, absolutePath)),
        exists: false,
        required: true,
        error_code: error?.code || "read_failed",
      });
    }
  }
  return artifacts;
}

async function runSelfCheck({ outDir }) {
  const packageScripts = await readPackageScriptsForReleaseGates();
  const manifest = buildDojoReleaseGateManifest({
    generatedAt: "2026-06-11T00:00:00.000Z",
    packageScripts,
  });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  assert.equal(validation.ok, true, validation.errors.join(";"));

  const minimalPlan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope: "minimal-pr",
    env: {},
  });
  assert.deepEqual(minimalPlan.selected_gate_ids, DOJO_MINIMAL_PR_GATE_IDS);
  assert(!minimalPlan.selected_gate_ids.some((id) => id.includes("host_conformance")));
  assert(!minimalPlan.gates.some((gate) => gate.tier === "T5" || gate.tier === "T8"));

  const milestonePlan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope: "milestone",
    env: {},
  });
  assert(milestonePlan.gates.some((gate) => gate.gate_id === "dojo_postgres_control_plane_self_check" && gate.status === "skipped"));

  const enterpriseReleasePlan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope: "enterprise-release",
    env: {},
  });
  assert.equal(enterpriseReleasePlan.scope, "enterprise-release");
  assert.deepEqual(enterpriseReleasePlan.selected_gate_ids, manifest.enterprise_release_gate_ids);
  for (const gateId of manifest.release_gate_ids) {
    assert(enterpriseReleasePlan.selected_gate_ids.includes(gateId), `enterprise_release_missing_release_gate:${gateId}`);
  }
  assert(enterpriseReleasePlan.gates.some((gate) => gate.tier === "T8" && gate.gate_id === "soak_performance"));

  const fakeOutDir = path.join(outDir, "self-check-fake-run");
  const fakePlan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope: "minimal-pr",
    gateIds: ["mcp_typecheck", "frontend_dojo_unit_tests"],
    env: {},
  });
  const fakeResults = await executeDojoReleaseGatePlan({
    plan: fakePlan,
    outDir: fakeOutDir,
    executor: async ({ gatePlan, outDir: runOutDir }) => {
      const logDir = path.join(runOutDir, "logs");
      await mkdir(logDir, { recursive: true });
      return writeGateCommandResult({
        gatePlan,
        logDir,
        stdout: `ok:${gatePlan.gate_id}\n`,
        stderr: "",
        startedAtIso: "2026-06-11T00:00:00.000Z",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
    },
  });
  const report = buildDojoReleaseGateRunReport({
    manifest,
    manifestValidation: validation,
    plan: fakePlan,
    results: fakeResults,
    scope: "minimal-pr",
    dryRun: false,
    generatedAt: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(report.ok, true);
  assert.equal(report.promotion_ready, true);
  assert.equal(report.counts.passed, 2);

  return runDojoReleaseGateRunner({
    scope: "milestone",
    dryRun: true,
    execute: false,
    outDir,
    env: {},
    generatedAt: "2026-06-11T00:00:00.000Z",
  });
}

async function readPackageScriptsForReleaseGates() {
  const packageJsonPaths = new Set(DOJO_RELEASE_GATE_COMMANDS.map((gate) => gate.package_json || DEFAULT_PACKAGE_JSON));
  const entries = [];
  for (const packageJsonPath of packageJsonPaths) {
    const absolutePath = path.resolve(REPO_ROOT, packageJsonPath);
    const parsed = JSON.parse(await readFile(absolutePath, "utf8"));
    entries.push([normalizeRepoPath(packageJsonPath), parsed.scripts || {}]);
  }
  return Object.fromEntries(entries);
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function expectedGateArtifacts(gate) {
  return {
    report_path: gate.default_report_path || gate.default_summary_path || null,
    evidence_path: gate.default_evidence_path || null,
    events_path: gate.default_events_path || null,
    evidence_kind: gate.evidence_kind,
  };
}

function resolveExpectedArtifactPath(value) {
  return path.isAbsolute(String(value)) ? String(value) : path.resolve(REPO_ROOT, String(value));
}

function missingRequiredEnv(gate, env = process.env) {
  return (gate.requires_env || []).filter((key) => !truthy(env[key]));
}

function inferNpmExtraArgs(gate) {
  const command = String(gate?.command || "");
  const separatorIndex = command.indexOf(" -- ");
  if (separatorIndex < 0) return [];
  return splitCommandArgs(command.slice(separatorIndex + 4));
}

function splitCommandArgs(value) {
  const args = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function normalizeScope(scope) {
  const normalized = String(scope || "minimal-pr").trim().toLowerCase().replace(/_/g, "-");
  if (["pr", "minimal", "minimal-pr"].includes(normalized)) return "minimal-pr";
  if (["milestone", "milestone-exit"].includes(normalized)) return "milestone";
  if (["release", "release-candidate"].includes(normalized)) return "release";
  if (["enterprise", "enterprise-release"].includes(normalized)) return "enterprise-release";
  if (["nightly"].includes(normalized)) return "nightly";
  return normalized;
}

function normalizeRepoPath(value) {
  return String(value).replace(/\\/g, "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    const value = !next || next.startsWith("--") ? "1" : next;
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
    if (next && !next.startsWith("--")) i += 1;
  }
  return parsed;
}

function argList(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
