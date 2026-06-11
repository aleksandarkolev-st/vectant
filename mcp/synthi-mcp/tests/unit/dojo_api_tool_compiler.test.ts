import { describe, expect, it } from "vitest";
import {
  compileDojoApiBackedMcpTool,
  validateDojoApiBackedToolInvocation,
} from "../../src/dojo/api/api_tool_compiler.js";
import { inferDojoApiEndpointCandidateFromTrace } from "../../src/dojo/api/endpoint_inference.js";

describe("Dojo API-backed MCP tool compiler", () => {
  it("compiles an approved mutation endpoint into a proof-gated strict MCP tool contract", () => {
    const candidate = approvedMutationCandidate();
    const result = compileDojoApiBackedMcpTool({
      candidate,
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, issues: [] }));
    expect(result.tool).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.apiBackedMcpTool.v1",
      tool_name: "synthi_api_save_invoice",
      candidate_id: candidate.candidate_id,
      method: "POST",
      path: "/api/invoices",
      proof_required: true,
      auth_scope: "invoice:write",
      idempotency_key_location: "header",
      rollback_strategy: "compensating_call",
      postcondition: "invoice.status == 'saved'",
      schema_digest: expect.stringMatching(/^sha256:/),
      enforcement: {
        proof_capsule_required: true,
        license_kernel_required: true,
        evidence_write_required: true,
        postcondition_assertion_required: true,
        idempotency_required: true,
      },
    }));
    expect(result.tool?.input_schema).toEqual(expect.objectContaining({
      type: "object",
      required: ["proof_capsule", "request", "idempotency_key"],
      additionalProperties: false,
    }));
  });

  it("refuses to compile candidates that have not passed API review gates", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { amount: 42 },
    });

    expect(compileDojoApiBackedMcpTool({
      candidate,
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
    })).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_review_approval_required" }),
        expect.objectContaining({ issue_id: "api_candidate_idempotency_required" }),
        expect.objectContaining({ issue_id: "api_candidate_proof_claim_mapping_required" }),
      ]),
    }));
  });

  it("validates invocation proof, license context, idempotency, and request payload before execution", () => {
    const compiled = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
    });
    const tool = compiled.tool!;

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: { request: { amount: 42 } },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "wrong-license",
        license_version: "1.0.0",
        action: "run_workflow",
      },
    })).toEqual({
      ok: false,
      blocked_by: [
        "api_tool_proof_capsule_required",
        "api_tool_idempotency_key_required",
        "api_tool_license_mismatch",
      ],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { capsule_id: "capsule-a" },
        request: { amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
      },
    })).toEqual({ ok: true, blocked_by: [] });
  });
});

function approvedMutationCandidate() {
  return {
    ...inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { client_id: "client-a", amount: 42 },
      response_body: { invoice_id: "invoice-a", status: "saved" },
      source_ref: "trace:save-invoice",
    }),
    auth_scope: "invoice:write",
    idempotency_key_location: "header" as const,
    rollback_strategy: "compensating_call" as const,
    postcondition: "invoice.status == 'saved'",
    proof_claim_mapping: { workspace_verified: "tenant.workspace_id", checkride_passed: "dojo.checkride" },
    review_status: "approved" as const,
  };
}
