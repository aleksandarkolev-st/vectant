import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  type DojoAffordancePrPlan,
} from "../../src/dojo/source/affordance_pr_plan.js";
import { createDojoGeneratedPrGitBranch } from "../../src/dojo/source/pr_branch_git.js";
import {
  buildDojoGeneratedPrBranchPlan,
  buildDojoGeneratedPrMetadata,
} from "../../src/dojo/source/pr_generator.js";
import { buildDojoGeneratedSourcePatchBundle } from "../../src/dojo/source/patch_bundle.js";

const require = createRequire(import.meta.url);

describe("Dojo generated PR git branch workflow", () => {
  it("creates a generated branch, applies planned files, and proves the generated contract test", async () => {
    const repoRoot = await initializedFixtureRepo();
    const { branchPlan, bundle } = readyBranchPlanFixture();

    const result = await createDojoGeneratedPrGitBranch({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      repository_root: repoRoot,
    });

    expect(result).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.generatedPrGitBranchResult.v1",
      repository_root: path.resolve(repoRoot),
      branch_name: branchPlan.branch_name,
      dry_run: false,
      ok: true,
      issues: [],
    }));
    expect(currentGitBranch(repoRoot)).toBe(branchPlan.branch_name);
    expect(result.apply_result?.applied_files.map((file) => ({ kind: file.kind, path: file.path, written: file.written }))).toEqual([
      { kind: "source", path: "src/invoices/InvoiceForm.jsx", written: true },
      { kind: "contract_test", path: "src/invoices/__tests__/invoiceform.dojo-affordance.test.ts", written: true },
    ]);

    await writeFile(path.join(repoRoot, "vitest.config.mjs"), `export default { test: { environment: "node", include: ["src/**/*.test.ts"] } };\n`);
    const patchedSource = await readFile(path.join(repoRoot, "src/invoices/InvoiceForm.jsx"), "utf8");
    expect(patchedSource).toContain("data-agent-action=\"invoice.save\"");
    expect(patchedSource).toContain("assertDojoProof(\"invoice.save\")");

    const vitestRun = runVitest(repoRoot);
    expect(vitestRun.status, vitestRun.stdout + vitestRun.stderr).toBe(0);
  });

  it("dry-runs branch creation without switching branches or writing files", async () => {
    const repoRoot = await initializedFixtureRepo();
    const originalBranch = currentGitBranch(repoRoot);
    const { branchPlan, bundle } = readyBranchPlanFixture();

    const result = await createDojoGeneratedPrGitBranch({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      repository_root: repoRoot,
      dry_run: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.apply_result?.applied_files.every((file) => file.written === false)).toBe(true);
    expect(currentGitBranch(repoRoot)).toBe(originalBranch);
    await expect(access(path.join(repoRoot, "src/invoices/__tests__/invoiceform.dojo-affordance.test.ts"))).rejects.toThrow();
  });

  it("blocks branch creation when the worktree is dirty by default", async () => {
    const repoRoot = await initializedFixtureRepo();
    const originalBranch = currentGitBranch(repoRoot);
    const { branchPlan, bundle } = readyBranchPlanFixture();
    await writeFile(path.join(repoRoot, "src/invoices/InvoiceForm.jsx"), `${invoiceFormSource()}\n// dirty local edit\n`);

    const result = await createDojoGeneratedPrGitBranch({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      repository_root: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_id: "generated_pr_git_worktree_dirty" }),
    ]));
    expect(currentGitBranch(repoRoot)).toBe(originalBranch);
    await expect(access(path.join(repoRoot, "src/invoices/__tests__/invoiceform.dojo-affordance.test.ts"))).rejects.toThrow();
  });

  it("blocks branch creation when the generated branch already exists", async () => {
    const repoRoot = await initializedFixtureRepo();
    const originalBranch = currentGitBranch(repoRoot);
    const { branchPlan, bundle } = readyBranchPlanFixture();
    runGit(repoRoot, ["branch", branchPlan.branch_name]);

    const result = await createDojoGeneratedPrGitBranch({
      branch_plan: branchPlan,
      patch_bundle: bundle,
      repository_root: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_id: "generated_pr_git_branch_exists" }),
    ]));
    expect(currentGitBranch(repoRoot)).toBe(originalBranch);
  });
});

async function initializedFixtureRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-git-"));
  await mkdir(path.join(repoRoot, "src/invoices"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/invoices/InvoiceForm.jsx"), invoiceFormSource());
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.email", "dojo-self-check@example.test"]);
  runGit(repoRoot, ["config", "user.name", "Dojo Self Check"]);
  runGit(repoRoot, ["add", "src/invoices/InvoiceForm.jsx"]);
  runGit(repoRoot, ["commit", "-m", "seed invoice fixture"]);
  return repoRoot;
}

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
  });
  return { branchPlan, bundle };
}

function runGit(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

function currentGitBranch(repoRoot: string): string {
  return runGit(repoRoot, ["branch", "--show-current"]).stdout.trim();
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
