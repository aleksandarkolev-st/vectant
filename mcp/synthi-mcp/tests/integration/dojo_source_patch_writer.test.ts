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
import { buildDojoGeneratedSourcePatchBundle } from "../../src/dojo/source/patch_bundle.js";
import { writeDojoGeneratedSourcePatchBundle } from "../../src/dojo/source/patch_writer.js";

const require = createRequire(import.meta.url);

describe("Dojo source patch writer", () => {
  it("writes bundle-declared source and contract tests under the workspace root", async () => {
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan: planFixture(),
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-source-patch-writer-"));

    const result = await writeDojoGeneratedSourcePatchBundle({ bundle, workspace_root: workspaceRoot });

    expect(result).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.sourcePatchWriteResult.v1",
      plan_id: bundle.plan_id,
      workspace_root: path.resolve(workspaceRoot),
      ok: true,
      issues: [],
    }));
    expect(result.written_files.map((file) => ({ kind: file.kind, path: file.path, written: file.written }))).toEqual([
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

  it("rejects traversal paths instead of writing outside the workspace root", async () => {
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan: planFixture(),
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-source-patch-writer-"));
    const escapePath = `../${path.basename(workspaceRoot)}-outside/InvoiceForm.jsx`;
    const unsafeBundle = {
      ...bundle,
      modified_files: bundle.modified_files.map((file) => ({ ...file, path: escapePath })),
    };

    const result = await writeDojoGeneratedSourcePatchBundle({ bundle: unsafeBundle, workspace_root: workspaceRoot });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "source_patch_path_unsafe",
        path: escapePath,
      }),
    ]));
    await expect(access(path.resolve(workspaceRoot, escapePath))).rejects.toThrow();
  });

  it("rejects duplicate bundle output paths", async () => {
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan: planFixture(),
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });
    const duplicateBundle = {
      ...bundle,
      generated_tests: bundle.generated_tests.map((file) => ({ ...file, path: "src/invoices/InvoiceForm.jsx" })),
    };
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-source-patch-writer-"));

    const result = await writeDojoGeneratedSourcePatchBundle({ bundle: duplicateBundle, workspace_root: workspaceRoot });

    expect(result.ok).toBe(false);
    expect(result.written_files).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_id: "source_patch_duplicate_output_path",
        path: "src/invoices/InvoiceForm.jsx",
      }),
    ]));
  });

  it("supports dry runs without mutating the workspace", async () => {
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan: planFixture(),
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dojo-source-patch-writer-"));

    const result = await writeDojoGeneratedSourcePatchBundle({ bundle, workspace_root: workspaceRoot, dry_run: true });

    expect(result.ok).toBe(true);
    expect(result.written_files.every((file) => file.written === false)).toBe(true);
    await expect(access(path.join(workspaceRoot, "src/invoices/InvoiceForm.jsx"))).rejects.toThrow();
  });
});

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
