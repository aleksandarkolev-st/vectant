import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDojoGeneratedSourcePatchBundle } from "../../src/dojo/source/patch_bundle.js";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  type DojoAffordancePrPlan,
} from "../../src/dojo/source/affordance_pr_plan.js";

const require = createRequire(import.meta.url);

describe("Dojo generated source patch bundle", () => {
  it("creates patched source and generated contract tests that execute", async () => {
    const plan = planFixture();
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan,
      files: [{ path: "src/invoices/InvoiceForm.jsx", source: invoiceFormSource() }],
    });

    expect(bundle).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.generatedSourcePatchBundle.v1",
      plan_id: plan.plan_id,
      ok: true,
      issues: [],
    }));
    expect(bundle.modified_files).toEqual([
      expect.objectContaining({
        path: "src/invoices/InvoiceForm.jsx",
        changed: true,
        applied_operations: [
          "patch_stable_locator_invoice_save",
          "patch_proof_hook_invoice_save",
        ],
        before_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        after_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(bundle.modified_files[0]?.source).toContain("data-agent-action=\"invoice.save\"");
    expect(bundle.modified_files[0]?.source).toContain("assertDojoProof(\"invoice.save\")");
    expect(bundle.generated_tests).toEqual([
      expect.objectContaining({
        path: "src/invoices/__tests__/invoiceform.dojo-affordance.test.ts",
        required_operations: [
          "patch_stable_locator_invoice_save",
          "patch_proof_hook_invoice_save",
        ],
      }),
    ]);

    const run = await runGeneratedBundleVitest(bundle);
    expect(run.status).toBe(0);
  });

  it("reports missing source files instead of inventing source content", () => {
    const bundle = buildDojoGeneratedSourcePatchBundle({
      plan: planFixture(),
      files: [],
    });

    expect(bundle).toEqual(expect.objectContaining({
      ok: false,
      modified_files: [],
      generated_tests: [],
      issues: [
        {
          issue_id: "source_patch_file_missing",
          severity: "error",
          file_path: "src/invoices/InvoiceForm.jsx",
          message: "Source file is missing for generated patch: src/invoices/InvoiceForm.jsx",
        },
      ],
    }));
  });
});

async function runGeneratedBundleVitest(bundle: ReturnType<typeof buildDojoGeneratedSourcePatchBundle>) {
  const root = await mkdtemp(path.join(tmpdir(), "dojo-source-patch-bundle-"));
  const configPath = path.join(root, "vitest.config.mjs");
  await writeFile(configPath, `export default { test: { environment: "node", include: ["src/**/*.test.ts"] } };\n`);
  for (const file of bundle.modified_files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.source);
  }
  for (const test of bundle.generated_tests) {
    const target = path.join(root, test.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, test.source);
  }
  const vitestBin = require.resolve("vitest/vitest.mjs");
  return spawnSync(process.execPath, [
    vitestBin,
    "run",
    "--root",
    root,
    "--config",
    configPath,
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
    required_tests: ["npm test -- InvoiceForm.dojo-affordance"],
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
