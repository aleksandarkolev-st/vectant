import { describe, expect, it } from "vitest";
import { validateAgentReadyUiContract, type AgentReadyUiContract } from "../../src/dojo/source/agent_ready_ui_contract.js";

describe("Dojo Agent-Ready UI Contract linter", () => {
  it("passes a valid risky action contract with stable locator, proof hook, and success hook", () => {
    expect(validateAgentReadyUiContract(contractFixture())).toEqual({ ok: true, issues: [] });
  });

  it("fails risky actions missing proof hooks", () => {
    const contract = contractFixture({
      actions: [{
        ...actionFixture(),
        proof_hook: "",
      }],
    });

    expect(validateAgentReadyUiContract(contract)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          issue_id: "ui_proof_hook_required_for_risky_action",
          affordance_id: "invoice.save",
        }),
      ]),
    }));
  });

  it("fails missing stable locator, success hook, accessibility label, and blocked contexts", () => {
    const contract = contractFixture({
      actions: [{
        ...actionFixture(),
        risk: "dangerous",
        stable_locator: "",
        success_hook: "",
        accessibility_label: "",
        blocked_contexts: [],
      }],
    });

    expect(validateAgentReadyUiContract(contract).issues.map((issue) => issue.issue_id)).toEqual(expect.arrayContaining([
      "ui_stable_locator_required",
      "ui_success_hook_required_for_risky_action",
      "ui_accessibility_label_required",
      "ui_blocked_contexts_required_for_dangerous_action",
    ]));
  });

  it("warns when proof requirement does not match risk and approval policy", () => {
    const contract = contractFixture({
      actions: [{
        ...actionFixture(),
        risk: "safe",
        approval_policy: "none",
        proof_required: true,
        proof_hook: "assertProof",
        success_hook: undefined,
      }],
    });

    expect(validateAgentReadyUiContract(contract)).toEqual(expect.objectContaining({
      ok: true,
      issues: [
        expect.objectContaining({
          severity: "warning",
          issue_id: "ui_proof_requirement_review_recommended",
        }),
      ],
    }));
  });
});

function contractFixture(overrides: Partial<AgentReadyUiContract> = {}): AgentReadyUiContract {
  return {
    schema_version: "synthi.dojo.agentReadyUiContract.v1",
    contract_id: "contract-a",
    app_origin: "https://app.example.test",
    app_version: "2026.06.11",
    actions: [actionFixture()],
    ...overrides,
  };
}

function actionFixture(): AgentReadyUiContract["actions"][number] {
  return {
    affordance_id: "invoice.save",
    component: "InvoiceForm",
    route: "/invoices",
    role: "button",
    risk: "mutation",
    required_inputs: ["client_name"],
    success_condition: "invoice.status == saved",
    approval_policy: "ask_before",
    stable_locator: "[data-agent-action=\"invoice.save\"]",
    proof_required: true,
    proof_hook: "assertDojoProof",
    success_hook: "assertInvoiceSaved",
    accessibility_label: "Save invoice",
    allowed_substrate: ["dom", "source"],
    blocked_contexts: ["duplicate_client"],
    source_version: "abc123",
    contract_version: "1.0.0",
  };
}
