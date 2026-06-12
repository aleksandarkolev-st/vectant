import { describe, expect, it } from "vitest";
import {
  proofHookPatchOperation,
  stableLocatorPatchOperation,
  validateDojoAffordancePrPlan,
  type DojoAffordancePrPlan,
} from "../../src/dojo/source/affordance_pr_plan.js";

describe("Dojo affordance PR plan contract", () => {
  it("validates stable locator patch operations", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      target_match: { role: "button", text: "Save invoice" },
      affordance_id: "invoice.save",
    });

    expect(validateDojoAffordancePrPlan(planFixture([operation]))).toEqual({ ok: true, issues: [] });
    expect(operation.after).toBe("data-agent-action=\"invoice.save\"");
    expect(operation.target_match).toEqual({ role: "button", text: "Save invoice" });
  });

  it("validates proof hook patch operations", () => {
    const operation = proofHookPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
      hook_name: "assertDojoProof",
    });

    expect(validateDojoAffordancePrPlan(planFixture([operation]))).toEqual({ ok: true, issues: [] });
    expect(operation.validation_expectation).toContain("assertDojoProof");
  });

  it("rejects malformed stable locator and proof hook operations", () => {
    const plan = planFixture([
      {
        ...stableLocatorPatchOperation({
          file_path: "src/InvoiceForm.jsx",
          target_component: "InvoiceForm",
          affordance_id: "invoice.save",
        }),
        after: "className=\"save\"",
      },
      {
        ...proofHookPatchOperation({
          file_path: "src/InvoiceForm.jsx",
          target_component: "InvoiceForm",
          affordance_id: "invoice.save",
          hook_name: "assertDojoProof",
        }),
        after: "assert-dojo-proof",
      },
    ]);

    expect(validateDojoAffordancePrPlan(plan).issues.map((issue) => issue.issue_id)).toEqual(expect.arrayContaining([
      "affordance_patch_stable_locator_invalid",
      "affordance_patch_proof_hook_invalid",
    ]));
  });

  it("rejects empty or malformed target matchers", () => {
    const plan = planFixture([
      {
        ...stableLocatorPatchOperation({
          file_path: "src/InvoiceForm.jsx",
          target_component: "InvoiceForm",
          affordance_id: "invoice.save",
        }),
        target_match: {},
      },
      {
        ...stableLocatorPatchOperation({
          file_path: "src/InvoiceForm.jsx",
          target_component: "InvoiceForm",
          affordance_id: "invoice.delete",
        }),
        target_match: { attribute: { name: "1-invalid", value: "delete" } },
      },
    ]);

    expect(validateDojoAffordancePrPlan(plan).issues.map((issue) => issue.issue_id)).toEqual(expect.arrayContaining([
      "affordance_patch_target_match_empty",
      "affordance_patch_target_attribute_invalid",
    ]));
  });
});

function planFixture(operations: DojoAffordancePrPlan["operations"]): DojoAffordancePrPlan {
  return {
    schema_version: "synthi.dojo.affordancePrPlan.v1",
    plan_id: "plan-a",
    app_origin: "https://app.example.test",
    app_version: "2026.06.11",
    operations,
    required_tests: ["npm test -- InvoiceForm"],
    review_gates: ["code_owner", "security_for_risky_action"],
  };
}
