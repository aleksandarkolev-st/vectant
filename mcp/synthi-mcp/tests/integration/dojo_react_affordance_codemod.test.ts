import { describe, expect, it } from "vitest";
import {
  applyReactAffordanceCodemodPlan,
  evaluateReactAffordanceContract,
  generateReactAffordanceVitestContractTest,
  parseReactSourceOrThrow,
} from "../../src/dojo/source/codemod.js";
import { stableLocatorPatchOperation } from "../../src/dojo/source/affordance_pr_plan.js";

describe("Dojo React affordance codemod", () => {
  it("adds a stable action ID without altering existing button behavior", () => {
    const source = invoiceFormSource();
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
    });

    const result = applyReactAffordanceCodemodPlan(source, [operation]);

    expect(result).toEqual(expect.objectContaining({
      changed: true,
      applied_operations: [operation.operation_id],
    }));
    expect(result.source).toContain("data-agent-action=\"invoice.save\"");
    expect(result.source).toContain("onClick={onSave}");
    expect(result.source).toContain("Save invoice");
    expect(() => parseReactSourceOrThrow(result.source)).not.toThrow();
  });

  it("is idempotent on a second application", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
    });
    const first = applyReactAffordanceCodemodPlan(invoiceFormSource(), [operation]);
    const second = applyReactAffordanceCodemodPlan(first.source, [operation]);

    expect(second).toEqual(expect.objectContaining({
      changed: false,
      applied_operations: [],
      skipped_operations: [operation.operation_id],
      source: first.source,
    }));
  });

  it("generates contract tests that fail before the patch and pass after it", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
    });

    const before = evaluateReactAffordanceContract(invoiceFormSource(), [operation]);
    const patched = applyReactAffordanceCodemodPlan(invoiceFormSource(), [operation]);
    const after = evaluateReactAffordanceContract(patched.source, [operation]);
    const generatedTest = generateReactAffordanceVitestContractTest({
      source_file_path: "src/InvoiceForm.jsx",
      test_file_path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts",
      component_name: "InvoiceForm",
      operations: [operation],
    });

    expect(before).toEqual({
      ok: false,
      checked_operations: [operation.operation_id],
      missing_operations: [{
        operation_id: operation.operation_id,
        expected: "data-agent-action=\"invoice.save\"",
      }],
    });
    expect(after).toEqual({
      ok: true,
      checked_operations: [operation.operation_id],
      missing_operations: [],
    });
    expect(generatedTest).toEqual(expect.objectContaining({
      path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts",
      required_operations: [operation.operation_id],
    }));
    expect(generatedTest.source).toContain("../InvoiceForm.jsx");
    expect(generatedTest.source).toContain("data-agent-action=\\\"invoice.save\\\"");
    expect(() => parseReactSourceOrThrow(generatedTest.source)).not.toThrow();
  });

  it("fails when the target component cannot be found", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "MissingForm",
      affordance_id: "invoice.save",
    });

    expect(() => applyReactAffordanceCodemodPlan(invoiceFormSource(), [operation])).toThrow(/dojo_react_codemod_target_not_found/);
  });
});

function invoiceFormSource(): string {
  return `
export function InvoiceForm({ onSave }) {
  return (
    <form>
      <label>
        Client
        <input name="client" />
      </label>
      <button type="button" onClick={onSave}>Save invoice</button>
    </form>
  );
}
`;
}
