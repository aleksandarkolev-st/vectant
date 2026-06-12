#!/usr/bin/env node
/*
 * Lightweight Dojo T8 gate. It does not replace the long-running soak harness;
 * it proves the chaos/fault paths are executable and emits timing evidence that
 * nightly jobs can compare over time.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_CHAOS_PERFORMANCE_TEST_FILES = [
  "tests/integration/dojo_api_fault_server.test.ts",
  "tests/integration/dojo_vivarium_runner.test.ts",
  "tests/integration/dojo_checkride_runner.test.ts",
  "tests/integration/dojo_evil_twin_runner.test.ts",
];

export const DOJO_CHAOS_SCENARIOS = [
  "api_timeout",
  "partial_write",
  "fake_success_ui",
  "validation_error",
  "downstream_failure",
  "duplicate_entity_fixture",
  "prompt_injection_fixture",
  "runtime_oracle_classification",
  "evil_twin_attack_hardening",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-chaos-performance"));
  const artifacts = await runDojoChaosPerformanceSelfCheck({ outDir });
  console.log(`[ok] Dojo chaos/performance self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoChaosPerformanceSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-chaos-performance"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_CHAOS_PERFORMANCE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing chaos/performance test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const started = performance.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const durationMs = performance.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-chaos-performance.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-chaos-performance.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoChaosPerformanceEvidenceManifest({
    now,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    testFiles: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    scenarios: DOJO_CHAOS_SCENARIOS,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    error: result.error ? result.error.message : undefined,
  });
  const evidencePath = path.join(outputDir, "dojo-chaos-performance.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (result.error) throw new Error(`dojo_chaos_performance_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_chaos_performance_self_check_failed:exit_${result.status}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoChaosPerformanceEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  testFiles,
  scenarios,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  error,
}) {
  return {
    schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
    tested_chaos_scenarios: [...scenarios],
    scenario_count: scenarios.length,
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    budget: {
      self_check_timeout_ms: 120000,
      intended_gate: "lightweight_preflight_not_long_soak",
    },
    ...(error ? { error } : {}),
  };
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
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
