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
      source_patch_bundle: {
        ok: true,
        modified_files: [{ path: "/tmp/fixture/src/InvoiceForm.jsx" }],
        generated_tests: [{ path: "/tmp/fixture/src/__tests__/InvoiceForm.dojo-affordance.test.ts" }],
      },
      generated_pr_metadata: {
        review_requirements: [{ gate: "code_owner" }, { gate: "security_for_risky_action" }],
      },
      generated_pr_branch_plan: {
        ready_to_apply: true,
        file_writes: [
          { kind: "source", path: "src/InvoiceForm.jsx" },
          { kind: "contract_test", path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts" },
        ],
      },
      generated_pr_branch_apply_result: {
        ok: true,
        applied_files: [
          { kind: "source", path: "src/InvoiceForm.jsx" },
          { kind: "contract_test", path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts" },
        ],
      },
      source_patch_write_result: {
        ok: true,
        written_files: [
          { kind: "source", path: "src/InvoiceForm.jsx" },
          { kind: "contract_test", path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts" },
        ],
      },
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
      patch_bundle_ok: true,
      patch_bundle_modified_file_count: 1,
      patch_bundle_generated_test_count: 1,
      patch_write_ok: true,
      patch_write_file_count: 2,
      generated_pr_branch_plan_ready: true,
      generated_pr_branch_plan_file_count: 2,
      generated_pr_branch_apply_ok: true,
      generated_pr_branch_apply_file_count: 2,
      generated_pr_review_gate_count: 2,
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
        source_patch_bundle: { ok: true, modified_files: [], generated_tests: [] },
        generated_pr_metadata: { review_requirements: [] },
        generated_pr_branch_plan: { ready_to_apply: false, file_writes: [] },
        generated_pr_branch_apply_result: { ok: false, applied_files: [] },
        source_patch_write_result: { ok: true, written_files: [] },
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
