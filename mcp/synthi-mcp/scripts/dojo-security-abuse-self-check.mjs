#!/usr/bin/env node
/*
 * Run the focused Agent Dojo security/abuse gate and emit a digest-backed
 * evidence manifest. This is intentionally narrower than the full release
 * suite: it makes T7 executable in CI without requiring hosted infrastructure.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_SECURITY_ABUSE_TEST_FILES = [
  "tests/unit/dojo_proof_errors.test.ts",
  "tests/unit/dojo_proof_claims.test.ts",
  "tests/unit/dojo_proof_capsule_ed25519.test.ts",
  "tests/unit/dojo_public_proof_verifier.test.ts",
  "tests/unit/dojo_proof_signing.test.ts",
  "tests/unit/dojo_execution_policy_gate.test.ts",
  "tests/unit/dojo_private_tool_gate.test.ts",
  "tests/unit/dojo_browser_workflow_gate.test.ts",
  "tests/unit/dojo_evidence_claim_verifier.test.ts",
  "tests/unit/dojo_guardrail_runtime.test.ts",
  "tests/unit/security.test.ts",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-security-abuse"));
  const artifacts = await runDojoSecurityAbuseSelfCheck({ outDir });
  console.log(`[ok] Dojo security/abuse self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoSecurityAbuseSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 120000,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-security-abuse"));
  await mkdir(outputDir, { recursive: true });
  const missing = DOJO_SECURITY_ABUSE_TEST_FILES.filter((file) => !existsSync(path.join(MCP_ROOT, file)));
  assert.deepEqual(missing, [], `missing security test files: ${missing.join(", ")}`);

  const vitestPath = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  assert.equal(existsSync(vitestPath), true, `missing vitest executable: ${vitestPath}`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...DOJO_SECURITY_ABUSE_TEST_FILES,
    "--reporter=basic",
  ], {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const finishedAt = Date.now();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = path.join(outputDir, "dojo-security-abuse.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-security-abuse.stderr.log");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const evidence = buildDojoSecurityAbuseEvidenceManifest({
    now,
    exitCode: result.status,
    signal: result.signal,
    durationMs: finishedAt - startedAt,
    testFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    error: result.error ? result.error.message : undefined,
  });
  const evidencePath = path.join(outputDir, "dojo-security-abuse.evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (result.error) throw new Error(`dojo_security_abuse_self_check_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`dojo_security_abuse_self_check_failed:exit_${result.status}`);
  assert.equal(evidence.ok, true);
  return {
    evidence_path: evidencePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoSecurityAbuseEvidenceManifest({
  now,
  exitCode,
  signal,
  durationMs,
  testFiles,
  stdout,
  stderr,
  stdoutPath,
  stderrPath,
  error,
}) {
  const blockedClasses = [
    "proof_signature_tampering",
    "proof_context_tampering",
    "proof_replay_or_missing_capsule",
    "raw_private_tool_bypass",
    "raw_browser_workflow_bypass",
    "evidence_claim_missing_or_stale",
    "guardrail_failure",
    "prompt_injection_scanning",
  ];
  return {
    schema_version: "synthi.dojo.securityAbuseEvidence.v1",
    generated_at: now,
    ok: exitCode === 0 && !error,
    exit_code: exitCode,
    signal: signal ?? null,
    duration_ms: durationMs,
    tested_abuse_classes: blockedClasses,
    test_files: [...testFiles],
    test_file_count: testFiles.length,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
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
