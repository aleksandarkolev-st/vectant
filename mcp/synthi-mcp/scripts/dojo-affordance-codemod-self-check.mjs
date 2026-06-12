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
  const vitestConfigPath = path.join(fixtureDir, "vitest.config.mjs");

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
  const sourcePatchPlan = {
    schema_version: "synthi.dojo.affordancePrPlan.v1",
    plan_id: "affordance_codemod_self_check",
    app_origin: "https://app.example.test",
    app_version: "self-check",
    operations,
    required_tests: ["generated_vitest_contract"],
    review_gates: ["code_owner"],
  };
  const originalSource = invoiceFormSource();
  const sourcePatchBundle = modules.buildDojoGeneratedSourcePatchBundle({
    plan: sourcePatchPlan,
    files: [{ path: "src/InvoiceForm.jsx", source: originalSource }],
  });
  assert.equal(sourcePatchBundle.ok, true, "source patch bundle should be generated without errors");
  assert.equal(sourcePatchBundle.modified_files.length, 1, "source patch bundle should include one modified fixture file");
  assert.equal(sourcePatchBundle.generated_tests.length, 1, "source patch bundle should include one generated contract test");

  const sourcePath = path.join(fixtureDir, sourcePatchBundle.modified_files[0].path);
  const testPath = path.join(fixtureDir, sourcePatchBundle.generated_tests[0].path);
  const generatedTest = sourcePatchBundle.generated_tests[0];
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });

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

  const patchWriteResult = await modules.writeDojoGeneratedSourcePatchBundle({
    bundle: sourcePatchBundle,
    workspace_root: fixtureDir,
  });
  assert.equal(patchWriteResult.ok, true, "source patch writer should write the generated bundle");
  assert.equal(patchWriteResult.written_files.length, 2, "source patch writer should write source and generated test artifacts");

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
    source_patch_bundle: summarizeSourcePatchBundle(sourcePatchBundle),
    source_patch_write_result: summarizeSourcePatchWriteResult(patchWriteResult),
    before_vitest: summarizeVitestRun(beforeRun),
    wrong_target_vitest: summarizeVitestRun(wrongTargetRun),
    after_vitest: summarizeVitestRun(afterRun),
    applied_operations: sourcePatchBundle.modified_files.flatMap((file) => file.applied_operations),
    skipped_operations: sourcePatchBundle.modified_files.flatMap((file) => file.skipped_operations),
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
    patch_bundle_ok: report?.source_patch_bundle?.ok === true,
    patch_bundle_modified_file_count: Array.isArray(report?.source_patch_bundle?.modified_files)
      ? report.source_patch_bundle.modified_files.length
      : 0,
    patch_bundle_generated_test_count: Array.isArray(report?.source_patch_bundle?.generated_tests)
      ? report.source_patch_bundle.generated_tests.length
      : 0,
    patch_write_ok: report?.source_patch_write_result?.ok === true,
    patch_write_file_count: Array.isArray(report?.source_patch_write_result?.written_files)
      ? report.source_patch_write_result.written_files.length
      : 0,
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
    const [plan, codemod, patchWriter] = await Promise.all([
      import(pathToFileURL(affordancePlanModule).href),
      import(pathToFileURL(codemodModule).href),
      import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "source", "patch_writer.js")).href),
    ]);
    return {
      stableLocatorPatchOperation: plan.stableLocatorPatchOperation,
      proofHookPatchOperation: plan.proofHookPatchOperation,
      applyReactAffordanceCodemodPlan: codemod.applyReactAffordanceCodemodPlan,
      evaluateReactAffordanceContract: codemod.evaluateReactAffordanceContract,
      generateReactAffordanceVitestContractTest: codemod.generateReactAffordanceVitestContractTest,
      buildDojoGeneratedSourcePatchBundle: (await import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "source", "patch_bundle.js")).href)).buildDojoGeneratedSourcePatchBundle,
      writeDojoGeneratedSourcePatchBundle: patchWriter.writeDojoGeneratedSourcePatchBundle,
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

function summarizeSourcePatchBundle(bundle) {
  return {
    schema_version: bundle.schema_version,
    plan_id: bundle.plan_id,
    ok: bundle.ok,
    issue_count: bundle.issues.length,
    modified_files: bundle.modified_files.map((file) => ({
      path: file.path,
      before_sha256: file.before_sha256,
      after_sha256: file.after_sha256,
      changed: file.changed,
      applied_operations: file.applied_operations,
      skipped_operations: file.skipped_operations,
    })),
    generated_tests: bundle.generated_tests.map((test) => ({
      path: test.path,
      required_operations: test.required_operations,
    })),
  };
}

function summarizeSourcePatchWriteResult(result) {
  return {
    schema_version: result.schema_version,
    plan_id: result.plan_id,
    workspace_root: result.workspace_root,
    ok: result.ok,
    issue_count: result.issues.length,
    written_files: result.written_files.map((file) => ({
      kind: file.kind,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      written: file.written,
    })),
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
