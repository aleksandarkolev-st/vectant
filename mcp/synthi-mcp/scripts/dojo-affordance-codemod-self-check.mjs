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
  const planSlug = slugForId(sourcePatchPlan.plan_id);
  const codeOwnerRules = codeOwnerRulesForGeneratedBundle(sourcePatchBundle, [process.env.SYNTHI_DOJO_SELF_CHECK_CODE_OWNER || "@dojo-self-check-review"]);
  const generatedPrMetadata = modules.buildDojoGeneratedPrMetadata({
    plan: sourcePatchPlan,
    skill_id: `${sourcePatchPlan.plan_id}_skill`,
    license_id: `${sourcePatchPlan.plan_id}_license`,
    code_owner_rules: codeOwnerRules,
    artifact_refs: [
      { kind: "patch_plan", path: `.synthi/dojo/source/${planSlug}.affordance-pr-plan.json` },
      { kind: "contract_test", path: sourcePatchBundle.generated_tests[0].path },
    ],
  });
  const generatedPrBranchPlan = modules.buildDojoGeneratedPrBranchPlan({
    metadata: generatedPrMetadata,
    patch_bundle: sourcePatchBundle,
    base_ref: process.env.SYNTHI_DOJO_AFFORDANCE_PR_BASE_REF || "main",
  });
  assert.equal(generatedPrBranchPlan.ready_to_apply, true, "generated PR branch plan should be ready for the controlled fixture");
  assert.equal(generatedPrBranchPlan.file_writes.length, 2, "generated PR branch plan should include source and contract test writes");

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

  const branchApplyResult = await modules.applyDojoGeneratedPrBranchPlan({
    branch_plan: generatedPrBranchPlan,
    patch_bundle: sourcePatchBundle,
    workspace_root: fixtureDir,
  });
  assert.equal(branchApplyResult.ok, true, "generated PR branch applicator should apply the generated bundle");
  assert.equal(branchApplyResult.applied_files.length, 2, "generated PR branch applicator should apply source and contract test artifacts");
  const patchWriteResult = branchApplyResult.write_result;
  assert.ok(patchWriteResult, "generated PR branch applicator should include the source patch write result");
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
    generated_pr_metadata: summarizeGeneratedPrMetadata(generatedPrMetadata),
    generated_pr_branch_plan: summarizeGeneratedPrBranchPlan(generatedPrBranchPlan),
    generated_pr_branch_apply_result: summarizeGeneratedPrBranchApplyResult(branchApplyResult),
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
    generated_pr_branch_plan_ready: report?.generated_pr_branch_plan?.ready_to_apply === true,
    generated_pr_branch_plan_file_count: Array.isArray(report?.generated_pr_branch_plan?.file_writes)
      ? report.generated_pr_branch_plan.file_writes.length
      : 0,
    generated_pr_branch_apply_ok: report?.generated_pr_branch_apply_result?.ok === true,
    generated_pr_branch_apply_file_count: Array.isArray(report?.generated_pr_branch_apply_result?.applied_files)
      ? report.generated_pr_branch_apply_result.applied_files.length
      : 0,
    generated_pr_review_gate_count: Array.isArray(report?.generated_pr_metadata?.review_requirements)
      ? report.generated_pr_metadata.review_requirements.length
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
  const prGeneratorModule = path.join(MCP_ROOT, "dist", "dojo", "source", "pr_generator.js");
  const prBranchApplierModule = path.join(MCP_ROOT, "dist", "dojo", "source", "pr_branch_applier.js");
  try {
    const [plan, codemod, prGenerator, prBranchApplier] = await Promise.all([
      import(pathToFileURL(affordancePlanModule).href),
      import(pathToFileURL(codemodModule).href),
      import(pathToFileURL(prGeneratorModule).href),
      import(pathToFileURL(prBranchApplierModule).href),
    ]);
    return {
      stableLocatorPatchOperation: plan.stableLocatorPatchOperation,
      proofHookPatchOperation: plan.proofHookPatchOperation,
      applyReactAffordanceCodemodPlan: codemod.applyReactAffordanceCodemodPlan,
      evaluateReactAffordanceContract: codemod.evaluateReactAffordanceContract,
      generateReactAffordanceVitestContractTest: codemod.generateReactAffordanceVitestContractTest,
      buildDojoGeneratedPrMetadata: prGenerator.buildDojoGeneratedPrMetadata,
      buildDojoGeneratedPrBranchPlan: prGenerator.buildDojoGeneratedPrBranchPlan,
      buildDojoGeneratedSourcePatchBundle: (await import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "source", "patch_bundle.js")).href)).buildDojoGeneratedSourcePatchBundle,
      applyDojoGeneratedPrBranchPlan: prBranchApplier.applyDojoGeneratedPrBranchPlan,
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

function slugForId(value) {
  return String(value || "dojo-plan")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dojo-plan";
}

function codeOwnerRulesForGeneratedBundle(bundle, owners) {
  const paths = [
    ...bundle.modified_files.map((file) => file.path),
    ...bundle.generated_tests.map((file) => file.path),
  ].filter(Boolean);
  const prefixes = Array.from(new Set(paths.map((filePath) => pathPrefixForGeneratedFile(filePath))));
  return prefixes.map((path_prefix) => ({ path_prefix, owners }));
}

function pathPrefixForGeneratedFile(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
  if (directory.includes("/__tests__/")) {
    return directory.slice(0, directory.indexOf("/__tests__/") + 1);
  }
  return directory || normalized;
}

function summarizeGeneratedPrMetadata(metadata) {
  return {
    schema_version: metadata.schema_version,
    plan_id: metadata.plan_id,
    branch_name: metadata.branch_name,
    review_requirements: metadata.review_requirements.map((requirement) => ({
      gate: requirement.gate,
      owners: requirement.owners,
      paths: requirement.paths,
      operation_ids: requirement.operation_ids,
    })),
    artifact_refs: metadata.artifact_refs,
    promotion_blockers: metadata.promotion_blockers,
  };
}

function summarizeGeneratedPrBranchPlan(plan) {
  return {
    schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    branch_name: plan.branch_name,
    base_ref: plan.base_ref ?? null,
    checkout_strategy: plan.checkout_strategy,
    ready_to_apply: plan.ready_to_apply,
    file_writes: plan.file_writes.map((file) => ({
      kind: file.kind,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      operation_ids: file.operation_ids,
    })),
    required_tests: plan.required_tests,
    promotion_blockers: plan.promotion_blockers,
  };
}

function summarizeGeneratedPrBranchApplyResult(result) {
  return {
    schema_version: result.schema_version,
    plan_id: result.plan_id,
    branch_name: result.branch_name,
    base_ref: result.base_ref ?? null,
    checkout_strategy: result.checkout_strategy,
    workspace_root: result.workspace_root,
    dry_run: result.dry_run,
    ok: result.ok,
    issue_count: result.issues.length,
    applied_files: result.applied_files.map((file) => ({
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
