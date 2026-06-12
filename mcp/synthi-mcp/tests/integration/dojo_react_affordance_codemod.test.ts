import { describe, expect, it } from "vitest";
import {
  applyReactAffordanceCodemodPlan,
  evaluateReactAffordanceContract,
  generateReactAffordanceVitestContractTest,
  parseReactSourceOrThrow,
} from "../../src/dojo/source/codemod.js";
import { proofHookPatchOperation, stableLocatorPatchOperation } from "../../src/dojo/source/affordance_pr_plan.js";

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

  it("adds a proof hook while preserving the reviewed click handler", () => {
    const operation = proofHookPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
      hook_name: "assertDojoProof",
    });

    const result = applyReactAffordanceCodemodPlan(invoiceFormSourceWithProofHook(), [operation]);
    const second = applyReactAffordanceCodemodPlan(result.source, [operation]);

    expect(result).toEqual(expect.objectContaining({
      changed: true,
      applied_operations: [operation.operation_id],
    }));
    expect(result.source).toContain("assertDojoProof(\"invoice.save\")");
    expect(result.source).toContain("return (onSave)(event);");
    expect(() => parseReactSourceOrThrow(result.source)).not.toThrow();
    expect(second).toEqual(expect.objectContaining({
      changed: false,
      applied_operations: [],
      skipped_operations: [operation.operation_id],
      source: result.source,
    }));
  });

  it("patches the matched action when a component has multiple actions", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      target_match: { role: "button", text: "Delete invoice" },
      affordance_id: "invoice.delete",
    });

    const result = applyReactAffordanceCodemodPlan(multiActionInvoiceFormSource(), [operation]);

    expect(result).toEqual(expect.objectContaining({
      changed: true,
      applied_operations: [operation.operation_id],
    }));
    expect(openingTagForText(result.source, "Save invoice")).not.toContain("data-agent-action");
    expect(openingTagForText(result.source, "Delete invoice")).toContain("data-agent-action=\"invoice.delete\"");
    expect(() => parseReactSourceOrThrow(result.source)).not.toThrow();
  });

  it("adds proof hook to the matched action without wrapping neighboring actions", () => {
    const operation = proofHookPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      target_match: { role: "button", text: "Save invoice" },
      affordance_id: "invoice.save",
      hook_name: "assertDojoProof",
    });

    const result = applyReactAffordanceCodemodPlan(multiActionInvoiceFormSourceWithProofHook(), [operation]);

    expect(openingTagForText(result.source, "Save invoice")).toContain("assertDojoProof(\"invoice.save\")");
    expect(openingTagForText(result.source, "Delete invoice")).not.toContain("assertDojoProof");
    expect(result.source).toContain("return (onSave)(event);");
    expect(result.source).toContain("onClick={onDelete}");
    expect(() => parseReactSourceOrThrow(result.source)).not.toThrow();
  });

  it("fails closed when target match criteria are ambiguous", () => {
    const operation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      target_match: { role: "button", text: "Submit" },
      affordance_id: "invoice.submit",
    });

    expect(() => applyReactAffordanceCodemodPlan(ambiguousActionSource(), [operation]))
      .toThrow(/dojo_react_codemod_target_ambiguous/);
  });

  it("generates contract tests that fail before the patch and pass after it", () => {
    const stableOperation = stableLocatorPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
    });
    const proofOperation = proofHookPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
      hook_name: "assertDojoProof",
    });

    const before = evaluateReactAffordanceContract(invoiceFormSourceWithProofHook(), [stableOperation, proofOperation]);
    const patched = applyReactAffordanceCodemodPlan(invoiceFormSourceWithProofHook(), [stableOperation, proofOperation]);
    const after = evaluateReactAffordanceContract(patched.source, [stableOperation, proofOperation]);
    const generatedTest = generateReactAffordanceVitestContractTest({
      source_file_path: "src/InvoiceForm.jsx",
      test_file_path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts",
      component_name: "InvoiceForm",
      operations: [stableOperation, proofOperation],
    });

    expect(before).toEqual({
      ok: false,
      checked_operations: [stableOperation.operation_id, proofOperation.operation_id],
      missing_operations: [
        {
          operation_id: stableOperation.operation_id,
          expected: "data-agent-action=\"invoice.save\"",
        },
        {
          operation_id: proofOperation.operation_id,
          expected: "assertDojoProof(\"invoice.save\")",
        },
      ],
    });
    expect(after).toEqual({
      ok: true,
      checked_operations: [stableOperation.operation_id, proofOperation.operation_id],
      missing_operations: [],
    });
    expect(generatedTest).toEqual(expect.objectContaining({
      path: "src/__tests__/InvoiceForm.dojo-affordance.test.ts",
      required_operations: [stableOperation.operation_id, proofOperation.operation_id],
    }));
    expect(generatedTest.source).toContain("../InvoiceForm.jsx");
    expect(generatedTest.source).toContain("data-agent-action=\\\"invoice.save\\\"");
    expect(generatedTest.source).toContain("assertDojoProof(\\\"invoice.save\\\")");
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

  it("fails closed when a proof hook operation names a hook that is not in scope", () => {
    const operation = proofHookPatchOperation({
      file_path: "src/InvoiceForm.jsx",
      target_component: "InvoiceForm",
      affordance_id: "invoice.save",
      hook_name: "assertDojoProof",
    });

    expect(() => applyReactAffordanceCodemodPlan(invoiceFormSource(), [operation]))
      .toThrow(/dojo_react_codemod_proof_hook_not_in_scope/);
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

function invoiceFormSourceWithProofHook(): string {
  return `
function assertDojoProof(affordanceId) {
  return affordanceId;
}

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

function multiActionInvoiceFormSource(): string {
  return `
export function InvoiceForm({ onSave, onDelete }) {
  return (
    <form>
      <button type="button" onClick={onSave}>Save invoice</button>
      <button type="button" onClick={onDelete}>Delete invoice</button>
    </form>
  );
}
`;
}

function multiActionInvoiceFormSourceWithProofHook(): string {
  return `
function assertDojoProof(affordanceId) {
  return affordanceId;
}

export function InvoiceForm({ onSave, onDelete }) {
  return (
    <form>
      <button type="button" onClick={onSave}>Save invoice</button>
      <button type="button" onClick={onDelete}>Delete invoice</button>
    </form>
  );
}
`;
}

function ambiguousActionSource(): string {
  return `
export function InvoiceForm({ onSubmitPrimary, onSubmitSecondary }) {
  return (
    <form>
      <button type="button" onClick={onSubmitPrimary}>Submit</button>
      <button type="button" onClick={onSubmitSecondary}>Submit</button>
    </form>
  );
}
`;
}

function openingTagForText(source: string, text: string): string {
  const textIndex = source.indexOf(text);
  expect(textIndex).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf("<", textIndex);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, textIndex);
}
