#!/usr/bin/env node
/*
 * Prove the Agent-Ready UI affordance codemod and generated test artifact.
 *
 * The harness writes a controlled React fixture, generates a Vitest contract
 * test for the reviewed affordance, proves the generated test fails before
 * patching, applies the codemod, then proves the same generated test passes.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-affordance-codemod-self-check"));
  const report = await runAffordanceCodemodSelfCheck({ outDir });
  console.log(`[ok] Dojo affordance codemod self-check passed - report=${report.report_path} evidence=${report.evidence_path}`);
}

export async function runAffordanceCodemodSelfCheck({ outDir }) {
  const modules = await importBuiltSourceModules();
  const fixtureDir = path.join(outDir, "fixture");
  const sourcePath = path.join(fixtureDir, "src", "InvoiceForm.jsx");
  const testPath = path.join(fixtureDir, "src", "__tests__", "InvoiceForm.dojo-affordance.test.ts");
  const vitestConfigPath = path.join(fixtureDir, "vitest.config.mjs");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });

  const stableOperation = modules.stableLocatorPatchOperation({
    file_path: "src/InvoiceForm.jsx",
    target_component: "InvoiceForm",
    target_match: { role: "button", text: "Save invoice" },
    affordance_id: "invoice.save",
  });
  const proofOperation = modules.proofHookPatchOperation({
    file_path: "src/InvoiceForm.jsx",
    target_component: "InvoiceForm",
    target_match: { role: "button", text: "Save invoice" },
    affordance_id: "invoice.save",
    hook_name: "assertDojoProof",
  });
  const operations = [stableOperation, proofOperation];
  const generatedTest = modules.generateReactAffordanceVitestContractTest({
    source_file_path: "src/InvoiceForm.jsx",
    test_file_path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts",
    component_name: "InvoiceForm",
    operations,
  });

  const originalSource = invoiceFormSource();
  await writeFile(sourcePath, originalSource);
  await writeFile(testPath, generatedTest.source);
  await writeFile(vitestConfigPath, fixtureVitestConfigSource());

  const beforeContract = modules.evaluateReactAffordanceContract(await readFile(sourcePath, "utf8"), operations);
  assert.equal(beforeContract.ok, false, "generated affordance contract should fail before patch");
  const beforeRun = await runGeneratedVitest({ testPath, fixtureDir, configPath: vitestConfigPath });
  assert.equal(beforeRun.ok, false, "generated Vitest contract should fail before codemod patch");

  await writeFile(sourcePath, wrongTargetInvoiceFormSource());
  const wrongTargetContract = modules.evaluateReactAffordanceContract(await readFile(sourcePath, "utf8"), operations);
  assert.equal(wrongTargetContract.ok, false, "generated affordance contract should fail when affordances are on the wrong target");
  const wrongTargetRun = await runGeneratedVitest({ testPath, fixtureDir, configPath: vitestConfigPath });
  assert.equal(wrongTargetRun.ok, false, "generated Vitest contract should fail when affordances are on the wrong target");

  await writeFile(sourcePath, originalSource);
  const patched = modules.applyReactAffordanceCodemodPlan(await readFile(sourcePath, "utf8"), operations);
  assert.equal(patched.changed, true, "codemod should patch the fixture once");
  await writeFile(sourcePath, patched.source);

  const afterContract = modules.evaluateReactAffordanceContract(await readFile(sourcePath, "utf8"), operations);
  assert.equal(afterContract.ok, true, "generated affordance contract should pass after patch");
  const afterRun = await runGeneratedVitest({ testPath, fixtureDir, configPath: vitestConfigPath });
  assert.equal(afterRun.ok, true, "generated Vitest contract should pass after codemod patch");

  const report = {
    schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
    generated_at: new Date().toISOString(),
    operation_ids: operations.map((operation) => operation.operation_id),
    generated_test_path: testPath,
    patched_source_path: sourcePath,
    fixture_vitest_config_path: vitestConfigPath,
    before_contract: beforeContract,
    wrong_target_contract: wrongTargetContract,
    after_contract: afterContract,
    before_vitest: summarizeVitestRun(beforeRun),
    wrong_target_vitest: summarizeVitestRun(wrongTargetRun),
    after_vitest: summarizeVitestRun(afterRun),
    applied_operations: patched.applied_operations,
    skipped_operations: patched.skipped_operations,
    target_matchers: operations.map((operation) => ({
      operation_id: operation.operation_id,
      target_component: operation.target_component,
      target_match: operation.target_match ?? null,
    })),
  };
  const artifacts = await writeAffordanceCodemodArtifacts({ outDir, report });
  return { ...report, ...artifacts };
}

export function buildAffordanceCodemodEvidenceManifest({ report, reportPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(report);
  return {
    schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
    generated_at: new Date().toISOString(),
    report_path: reportPath,
    report_sha256: sha256(body),
    report_bytes: Buffer.byteLength(body),
    before_failed: report?.before_contract?.ok === false && report?.before_vitest?.ok === false,
    target_aware_contract: report?.wrong_target_contract?.ok === false && report?.wrong_target_vitest?.ok === false,
    after_passed: report?.after_contract?.ok === true && report?.after_vitest?.ok === true,
    operation_ids: Array.isArray(report?.operation_ids) ? report.operation_ids : report?.operation_id ? [report.operation_id] : [],
    generated_test_path: report?.generated_test_path ?? null,
    patched_source_path: report?.patched_source_path ?? null,
    target_matchers: Array.isArray(report?.target_matchers) ? report.target_matchers : [],
  };
}

async function writeAffordanceCodemodArtifacts({ outDir, report }) {
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "dojo-affordance-codemod-self-check.json");
  const evidencePath = path.join(outDir, "dojo-affordance-codemod-self-check.evidence.json");
  const serialized = JSON.stringify(report, null, 2);
  const evidence = buildAffordanceCodemodEvidenceManifest({
    report,
    reportPath,
    serialized,
  });
  await writeFile(reportPath, serialized);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return {
    report_path: reportPath,
    evidence_path: evidencePath,
    evidence,
  };
}

async function importBuiltSourceModules() {
  const affordancePlanModule = path.join(MCP_ROOT, "dist", "dojo", "source", "affordance_pr_plan.js");
  const codemodModule = path.join(MCP_ROOT, "dist", "dojo", "source", "codemod.js");
  try {
    const [plan, codemod] = await Promise.all([
      import(pathToFileURL(affordancePlanModule).href),
      import(pathToFileURL(codemodModule).href),
    ]);
    return {
      stableLocatorPatchOperation: plan.stableLocatorPatchOperation,
      proofHookPatchOperation: plan.proofHookPatchOperation,
      applyReactAffordanceCodemodPlan: codemod.applyReactAffordanceCodemodPlan,
      evaluateReactAffordanceContract: codemod.evaluateReactAffordanceContract,
      generateReactAffordanceVitestContractTest: codemod.generateReactAffordanceVitestContractTest,
    };
  } catch (err) {
    throw new Error(`dojo_affordance_codemod_dist_missing: run npm --prefix mcp/synthi-mcp run build first (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function runGeneratedVitest({ testPath, fixtureDir, configPath }) {
  const vitestBin = path.join(MCP_ROOT, "node_modules", "vitest", "vitest.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      vitestBin,
      "run",
      testPath,
      "--root",
      fixtureDir,
      "--config",
      configPath,
    ], {
      cwd: MCP_ROOT,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code, signal) => {
      resolve({
        ok: code === 0,
        exit_code: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function summarizeVitestRun(run) {
  return {
    ok: run.ok,
    exit_code: run.exit_code,
    signal: run.signal,
    stdout_tail: tail(run.stdout),
    stderr_tail: tail(run.stderr),
  };
}

function tail(value) {
  const text = String(value || "").trim();
  return text.length > 1200 ? text.slice(-1200) : text;
}

function invoiceFormSource() {
  return `function assertDojoProof(affordanceId) {
  return affordanceId;
}

export function InvoiceForm({ onSave }) {
  return (
    <form>
      <label>
        Client
        <input name="client" />
      </label>
      <button type="button" onClick={() => undefined}>Preview invoice</button>
      <button type="button" onClick={onSave}>Save invoice</button>
    </form>
  );
}
`;
}

function wrongTargetInvoiceFormSource() {
  return `function assertDojoProof(affordanceId) {
  return affordanceId;
}

export function InvoiceForm({ onSave }) {
  return (
    <form>
      <label>
        Client
        <input name="client" />
      </label>
      <button type="button" data-agent-action="invoice.save" onClick={(event) => { assertDojoProof("invoice.save"); return (() => undefined)(event); }}>Preview invoice</button>
      <button type="button" onClick={onSave}>Save invoice</button>
    </form>
  );
}
`;
}

function fixtureVitestConfigSource() {
  return `export default {
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
};
`;
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
