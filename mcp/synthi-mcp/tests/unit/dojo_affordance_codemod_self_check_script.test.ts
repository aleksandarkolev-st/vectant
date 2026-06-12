// @ts-nocheck
import { describe, expect, it } from "vitest";
import { buildAffordanceCodemodEvidenceManifest } from "../../scripts/dojo-affordance-codemod-self-check.mjs";

describe("Dojo affordance codemod self-check script", () => {
  it("builds digest evidence for before-fail and after-pass reports", () => {
    const report = {
      operation_ids: ["patch_stable_locator_invoice_save", "patch_proof_hook_invoice_save"],
      generated_test_path: "/tmp/fixture/src/__tests__/InvoiceForm.dojo-affordance.test.ts",
      patched_source_path: "/tmp/fixture/src/InvoiceForm.jsx",
      before_contract: { ok: false },
      wrong_target_contract: { ok: false },
      after_contract: { ok: true },
      before_vitest: { ok: false },
      wrong_target_vitest: { ok: false },
      after_vitest: { ok: true },
      target_matchers: [
        {
          operation_id: "patch_stable_locator_invoice_save",
          target_component: "InvoiceForm",
          target_match: { role: "button", text: "Save invoice" },
        },
      ],
    };
    const serialized = JSON.stringify(report, null, 2);
    const evidence = buildAffordanceCodemodEvidenceManifest({
      report,
      reportPath: "/tmp/dojo-affordance-codemod-self-check.json",
      serialized,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
      report_path: "/tmp/dojo-affordance-codemod-self-check.json",
      report_bytes: Buffer.byteLength(serialized),
      before_failed: true,
      target_aware_contract: true,
      after_passed: true,
      operation_ids: ["patch_stable_locator_invoice_save", "patch_proof_hook_invoice_save"],
      target_matchers: [
        {
          operation_id: "patch_stable_locator_invoice_save",
          target_component: "InvoiceForm",
          target_match: { role: "button", text: "Save invoice" },
        },
      ],
    }));
    expect(evidence.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps evidence compatibility for older single-operation reports", () => {
    const evidence = buildAffordanceCodemodEvidenceManifest({
      report: {
        operation_id: "patch_stable_locator_invoice_save",
        before_contract: { ok: false },
        wrong_target_contract: { ok: false },
        after_contract: { ok: true },
        before_vitest: { ok: false },
        wrong_target_vitest: { ok: false },
        after_vitest: { ok: true },
      },
      reportPath: "/tmp/report.json",
      serialized: "{}",
    });

    expect(evidence.operation_ids).toEqual(["patch_stable_locator_invoice_save"]);
  });
});
