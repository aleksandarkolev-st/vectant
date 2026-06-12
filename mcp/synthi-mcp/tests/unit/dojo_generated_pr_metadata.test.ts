import { describe, expect, it } from "vitest";
import {
  buildDojoGeneratedPrMetadata,
  validateDojoGeneratedPrMetadata,
} from "../../src/dojo/source/pr_generator.js";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  type DojoAffordancePrPlan,
} from "../../src/dojo/source/affordance_pr_plan.js";

describe("Dojo generated PR metadata", () => {
  it("builds reviewable metadata with caller-supplied code owners and proof impact", () => {
    const plan = planFixture();
    const metadata = buildDojoGeneratedPrMetadata({
      plan,
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      source_snapshot_id: "source_snapshot_a",
      branch_prefix: "dojo/source-affordance",
      generated_by: "unit_test_dojo",
      code_owner_rules: [
        { path_prefix: "src/invoices/", owners: ["@billing-team", "@security-review"] },
      ],
      artifact_refs: [
        { kind: "patch_plan", path: ".synthi/dojo/source/save_invoice.affordance-pr-plan.json" },
      ],
    });

    expect(validateDojoGeneratedPrMetadata(metadata)).toEqual({ ok: true, issues: [] });
    expect(metadata).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.generatedSourcePrMetadata.v1",
      plan_id: plan.plan_id,
      app_origin: plan.app_origin,
      app_version: plan.app_version,
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      source_snapshot_id: "source_snapshot_a",
      branch_name: expect.stringMatching(/^dojo\/source-affordance\/plan-save-invoice-[a-f0-9]{12}$/),
      generated_by: "unit_test_dojo",
      promotion_blockers: [],
      proof_impact: "1 proof hook operation must remain bound to the reviewed target affordance.",
    }));
    expect(metadata.operations.map((operation) => operation.operation_id)).toEqual([
      "patch_stable_locator_invoice_save",
      "patch_proof_hook_invoice_save",
    ]);
    expect(metadata.review_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement_id: "review_code-owner",
        gate: "code_owner",
        owners: ["@billing-team", "@security-review"],
        paths: ["src/invoices/InvoiceForm.jsx"],
      }),
      expect.objectContaining({
        requirement_id: "review_security-for-risky-action",
        gate: "security_for_risky_action",
        owners: [],
        operation_ids: ["patch_proof_hook_invoice_save"],
      }),
      expect.objectContaining({
        requirement_id: "review_dojo-checkride-after-source-patch",
        gate: "dojo_checkride_after_source_patch",
      }),
    ]));
    expect(metadata.body).toContain("patch_proof_hook_invoice_save");
    expect(metadata.body).toContain("npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check");
    expect(metadata.body).toContain("@billing-team, @security-review");
  });

  it("keeps code owner ownership external and records unresolved owner blockers", () => {
    const metadata = buildDojoGeneratedPrMetadata({
      plan: planFixture(),
      code_owner_rules: [],
    });

    expect(metadata.review_requirements.find((requirement) => requirement.gate === "code_owner")).toEqual(
      expect.objectContaining({
        owners: [],
        paths: ["src/invoices/InvoiceForm.jsx"],
      })
    );
    expect(metadata.promotion_blockers).toEqual(["generated_pr_code_owner_unresolved:src/invoices/InvoiceForm.jsx"]);
  });

  it("matches code owner globs without relying on a fixed source path", () => {
    const metadata = buildDojoGeneratedPrMetadata({
      plan: {
        ...planFixture(),
        operations: [
          stableLocatorPatchOperation({
            file_path: "src/workflows/nested/WorkflowButton.tsx",
            target_component: "WorkflowButton",
            target_match: { role: "button", text: "Run" },
            affordance_id: "workflow.run",
          }),
        ],
      },
      code_owner_rules: [
        { glob: "src/workflows/**/*.tsx", owners: ["@workflow-platform"] },
      ],
    });

    expect(metadata.review_requirements.find((requirement) => requirement.gate === "code_owner")).toEqual(
      expect.objectContaining({ owners: ["@workflow-platform"] })
    );
    expect(metadata.promotion_blockers).toEqual([]);
  });

  it("rejects unsafe generated branch metadata", () => {
    const metadata = buildDojoGeneratedPrMetadata({
      plan: planFixture(),
      branch_name: "../unsafe branch",
    });

    expect(validateDojoGeneratedPrMetadata(metadata)).toEqual({
      ok: false,
      issues: [
        {
          issue_id: "generated_pr_branch_name_invalid",
          severity: "error",
          message: "Branch name must be a safe git branch ref segment.",
        },
      ],
    });
  });
});

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
    required_tests: [
      "npm test -- InvoiceForm.dojo-affordance",
      "npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check",
    ],
    review_gates: [
      "code_owner",
      "security_for_risky_action",
      "dojo_checkride_after_source_patch",
    ],
  };
}
