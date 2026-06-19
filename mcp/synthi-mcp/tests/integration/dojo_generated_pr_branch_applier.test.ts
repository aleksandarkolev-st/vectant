import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  type DojoAffordancePrPlan,
} from "../../src/dojo/source/affordance_pr_plan.js";
import { applyDojoGeneratedPrBranchPlan } from "../../src/dojo/source/pr_branch_applier.js";
import {
  buildDojoGeneratedPrBranchPlan,
  buildDojoGeneratedPrMetadata,
} from "../../src/dojo/source/pr_generator.js";
import { buildDojoGeneratedSourcePatchBundle } from "../../src/dojo/source/patch_bundle.js";

const require = createRequire(import.meta.url);

describe("Dojo generated PR branch applicator", () => {
  it("applies a ready generated branch plan and proves the generated contract test", async () => {
    const { branchPlan, bundle } = readyBranchPlanFixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-apply-"));

    const result = await applyDojoGeneratedPrBranchPlan({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      workspace_root: workspaceRoot,
    });

    expect(result).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.generatedPrBranchApplyResult.v1",
      plan_id: branchPlan.plan_id,
      branch_name: branchPlan.branch_name,
      base_ref: branchPlan.base_ref,
      workspace_root: path.resolve(workspaceRoot),
      dry_run: false,
      ok: true,
      issues: [],
    }));
    expect(result.applied_files.map((file) => ({ kind: file.kind, path: file.path, written: file.written }))).toEqual([
      { kind: "source", path: "src/invoices/InvoiceForm.jsx", written: true },
      { kind: "contract_test", path: "src/invoices/__tests__/invoiceform.dojo-affordance.test.ts", written: true },
    ]);

    await writeFile(path.join(workspaceRoot, "vitest.config.mjs"), `export default { test: { environment: "node", include: ["src/**/*.test.ts"] } };\n`);
    const patchedSource = await readFile(path.join(workspaceRoot, "src/invoices/InvoiceForm.jsx"), "utf8");
    expect(patchedSource).toContain("data-agent-action=\"invoice.save\"");
    expect(patchedSource).toContain("assertDojoProof(\"invoice.save\")");

    const vitestRun = runVitest(workspaceRoot);
    expect(vitestRun.status, vitestRun.stdout + vitestRun.stderr).toBe(0);
  });

  it("supports dry runs without mutating the target workspace", async () => {
    const { branchPlan, bundle } = readyBranchPlanFixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-apply-"));

    const result = await applyDojoGeneratedPrBranchPlan({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      workspace_root: workspaceRoot,
      dry_run: true,
    });

    expect(result.ok).toBe(true);
    expect(result.applied_files.every((file) => file.written === false)).toBe(true);
    await expect(access(path.join(workspaceRoot, "src/invoices/InvoiceForm.jsx"))).rejects.toThrow();
  });

  it("rejects file hash mismatches before writing generated files", async () => {
    const { branchPlan, bundle } = readyBranchPlanFixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-apply-"));
    const mismatchedBranchPlan = {
      ...branchPlan,
      file_writes: branchPlan.file_writes.map((file, index) =>
        index === 0 ? { ...file, sha256: "0".repeat(64) } : file
      ),
    };

    const result = await applyDojoGeneratedPrBranchPlan({
      branch_plan: mismatchedBranchPlan,
      patch_bundle: bundle,
      workspace_root: workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.write_result).toBeUndefined();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "generated_pr_branch_file_hash_mismatch",
        path: "src/invoices/InvoiceForm.jsx",
      }),
    ]));
    await expect(access(path.join(workspaceRoot, "src/invoices/InvoiceForm.jsx"))).rejects.toThrow();
  });

  it("rejects branch plans with unresolved promotion blockers before writing", async () => {
    const plan = planFixture();
    const metadata = buildDojoGeneratedPrMetadata({
      plan,
      code_owner_rules: [],
    });
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan,
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });
    const branchPlan = buildDojoGeneratedPrBranchPlan({
      metadata,
      patch_bundle: bundle,
      base_ref: "main",
    });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-apply-"));

    const result = await applyDojoGeneratedPrBranchPlan({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      workspace_root: workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.write_result).toBeUndefined();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "generated_pr_branch_plan_not_ready",
      }),
      expect.objectContaining({
        issue_id: "generated_pr_branch_plan_promotion_blocker",
      }),
    ]));
    await expect(access(path.join(workspaceRoot, "src/invoices/InvoiceForm.jsx"))).rejects.toThrow();
  });
});

function readyBranchPlanFixture() {
  const plan = planFixture();
  const metadata = buildDojoGeneratedPrMetadata({
    plan,
    code_owner_rules: [{ path_prefix: "src/invoices/", owners: ["@billing-team"] }],
  });
  const bundle = buildDojoGeneratedSourcePatchBundle({
    plan,
    files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
  });
  const branchPlan = buildDojoGeneratedPrBranchPlan({
    metadata,
    patch_bundle: bundle,
    base_ref: "main",
  });
  return { branchPlan, bundle };
}

function runVitest(workspaceRoot: string) {
  const vitestBin = require.resolve("vitest/vitest.mjs");
  return spawnSync(process.execPath, [
    vitestBin,
    "run",
    "--root",
    workspaceRoot,
    "--config",
    path.join(workspaceRoot, "vitest.config.mjs"),
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
}

function planFixture(): DojoAffordancePrPlan {
  return {
    schema_version: "synthi.dojo.affordancePrPlan.v1",
    plan_id: "plan-save-invoice",
    app_origin: "https://app.example.test",
    app_version: "2026.06.12",
    operations: [
      stableLocatorPatchOperation({
        file_path: "src/invoices/InvoiceForm.jsx",
        target_component: "InvoiceForm",
        target_match: { role: "button", text: "Save invoice" },
        affordance_id: "invoice.save",
      }),
      proofHookPatchOperation({
        file_path: "src/invoices/InvoiceForm.jsx",
        target_component: "InvoiceForm",
        target_match: { role: "button", text: "Save invoice" },
        affordance_id: "invoice.save",
        hook_name: "assertDojoProof",
      }),
    ],
    required_tests: ["generated_vitest_contract"],
    review_gates: ["code_owner"],
  };
}

function invoiceFormSource(): string {
  return `function assertDojoProof(affordanceId) {
  return affordanceId;
}

export function InvoiceForm({ onSave }) {
  return (
    <form>
      <button type="button" onClick={() => undefined}>Preview invoice</button>
      <button type="button" onClick={onSave}>Save invoice</button>
    </form>
  );
}
`;
}
