import { describe, expect, it } from "vitest";
import {
  compileDojoApiBackedMcpTool,
  executeDojoApiBackedToolInvocation,
  validateDojoApiBackedToolInvocation,
  type DojoApiToolExecutionEvidence,
  type DojoApiToolHttpRequest,
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
      args: { request: { client_id: "client-a", amount: 42 } },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "wrong-license",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
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
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({ ok: true, blocked_by: [] });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { ...proofCapsuleFixture(), requested_action: "delete_invoice" },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_proof_action_mismatch"],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { ...proofCapsuleFixture(), substrate_claim: "dom" },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_proof_substrate_mismatch"],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { ...proofCapsuleFixture(), substrate_claim: undefined },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_proof_substrate_required"],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:read"],
      },
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_auth_scope_missing"],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: {
          ...proofCapsuleFixture(),
          evidence_record_ids: [],
          ledger_checkpoint_hash: "",
          evidence_claims: [
            { claim: "workspace_verified", satisfied: true, evidence_refs: [] },
            { claim: "checkride_passed", satisfied: false, evidence_refs: ["evidence:checkride"] },
          ],
        },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({
      ok: false,
      blocked_by: [
        "api_tool_proof_evidence_records_required",
        "api_tool_proof_ledger_checkpoint_required",
        "api_tool_proof_evidence_claim_refs_required:workspace_verified",
        "api_tool_proof_evidence_claim_unverified:checkride_passed",
      ],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: {
          ...proofCapsuleFixture(),
          evidence_record_ids: ["evidence-workspace"],
          evidence_claims: [
            { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
            { claim: "checkride_passed", satisfied: true, evidence_refs: ["external-checkride-record"] },
          ],
        },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: {
        skill_id: "dojo_save_invoice",
        license_id: "license_save_invoice",
        license_version: "1.0.0",
        action: "run_workflow",
        auth_scopes: ["invoice:write"],
      },
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_proof_evidence_claim_ref_unbound:checkride_passed"],
    });
  });

  it("requires API tool proof substrate mismatch checks before reusable proof validation", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
    }).tool!;
    const requests: DojoApiToolHttpRequest[] = [];
    const evidenceRecords: DojoApiToolExecutionEvidence[] = [];

    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { ...proofCapsuleFixture(), substrate_claim: "dom" },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => {
        throw new Error("proof validator must not run after API substrate mismatch");
      },
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { status: "saved" } };
      },
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-a";
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_proof_substrate_mismatch"],
    }));
    expect(requests).toEqual([]);
    expect(evidenceRecords).toEqual([]);
  });

  it("enforces the compiled API tool input schema before transport execution", () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: {
        ...approvedMutationCandidate(),
        request_schema: {
          type: "object",
          properties: {
            client_id: { type: "string" },
            amount: { type: "number" },
          },
          required: ["client_id", "amount"],
          additionalProperties: false,
        },
      },
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
    }).tool!;

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { amount: "42", currency: "EUR" },
        idempotency_key: "idem-a",
        debug: true,
      },
      license_context: licenseContext(),
    })).toEqual({
      ok: false,
      blocked_by: [
        "api_tool_input_schema_additional_property:debug",
        "api_tool_request_schema_required:request.client_id",
        "api_tool_request_schema_additional_property:request.currency",
        "api_tool_request_schema_type_mismatch:request.amount",
      ],
    });
  });

  it("validates and forwards reviewed API query parameters", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: {
        ...approvedMutationCandidate(),
        ...inferDojoApiEndpointCandidateFromTrace({
          method: "POST",
          url: "/api/invoices/search?workspace=workspace-a",
          request_body: { client_id: "client-a", amount: 42 },
          response_body: { invoice_id: "invoice-a", status: "saved" },
        }),
        auth_scope: "invoice:write",
        idempotency_key_location: "header" as const,
        rollback_strategy: "compensating_call" as const,
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: { workspace_verified: "tenant.workspace_id", checkride_passed: "dojo.checkride" },
        review_status: "approved" as const,
      },
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_search_invoice",
    }).tool!;

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_query_schema_type_mismatch:query"],
    });

    expect(validateDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a", debug: "1" },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
    })).toEqual({
      ok: false,
      blocked_by: ["api_tool_query_schema_additional_property:query.debug"],
    });

    const requests: DojoApiToolHttpRequest[] = [];
    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => ({ ok: true, blocked_by: [] }),
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { invoice_id: "invoice-a", status: "saved" } };
      },
      write_evidence: () => "evidence:api-tool-query",
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      expect.objectContaining({
        path: "/api/invoices/search",
        query: { workspace: "workspace-a" },
      }),
    ]);
  });

  it("executes approved API-backed tools with idempotency, postcondition, and evidence", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
    }).tool!;
    const requests: DojoApiToolHttpRequest[] = [];
    const evidenceRecords: DojoApiToolExecutionEvidence[] = [];
    const proofValidations: string[] = [];

    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: ({ proof_capsule, requested_action }) => {
        proofValidations.push(`${proof_capsule["capsule_id"]}:${requested_action}`);
        return { ok: true, blocked_by: [] };
      },
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { invoice_id: "invoice-a", status: "saved" } };
      },
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-a";
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "executed",
      blocked_by: [],
      evidence_record_id: "evidence:api-tool-a",
      postcondition: expect.objectContaining({
        ok: true,
        predicate: "invoice.status == 'saved'",
        actual: "saved",
      }),
    }));
    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/invoices",
        headers: { "Idempotency-Key": "idem-a" },
        query: {},
        body: { client_id: "client-a", amount: 42 },
      }),
    ]);
    expect(evidenceRecords).toEqual([
      expect.objectContaining({
        schema_version: "synthi.dojo.apiToolExecutionEvidence.v1",
        tool_name: "synthi_api_save_invoice",
        proof_capsule_id: "capsule-a",
        idempotency_key: "idem-a",
        postcondition: "invoice.status == 'saved'",
        postcondition_ok: true,
        blocked_by: [],
        request_digest: expect.stringMatching(/^sha256:/),
        response_digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(proofValidations).toEqual(["capsule-a:run_workflow"]);
  });

  it("evaluates API postconditions against both request and response values", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: {
        ...approvedMutationCandidate(),
        postcondition: "invoice.amount == request.amount",
      },
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
    }).tool!;

    const matched = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => ({ ok: true, blocked_by: [] }),
      transport: () => ({ status: 201, body: { invoice: { amount: 42 } } }),
      write_evidence: () => "evidence:api-tool-matched-postcondition",
    });

    expect(matched).toEqual(expect.objectContaining({
      ok: true,
      status: "executed",
      postcondition: expect.objectContaining({
        ok: true,
        actual: 42,
        expected: 42,
      }),
    }));

    const mismatched = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-b",
      },
      license_context: licenseContext(),
      validate_proof: () => ({ ok: true, blocked_by: [] }),
      transport: () => ({ status: 201, body: { invoice: { amount: 41 } } }),
      write_evidence: () => "evidence:api-tool-mismatched-postcondition",
    });

    expect(mismatched).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_postcondition_guardrail_comparison_failed"],
      postcondition: expect.objectContaining({
        ok: false,
        actual: 41,
        expected: 42,
      }),
    }));
  });

  it("does not call the API transport when proof or license validation fails", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
    }).tool!;
    const requests: DojoApiToolHttpRequest[] = [];
    const evidenceRecords: DojoApiToolExecutionEvidence[] = [];

    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: { request: { client_id: "client-a", amount: 42 } },
      license_context: licenseContext(),
      validate_proof: () => {
        throw new Error("proof validator must not run after local validation failure");
      },
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { status: "saved" } };
      },
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-a";
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expect.arrayContaining([
        "api_tool_proof_capsule_required",
        "api_tool_idempotency_key_required",
      ]),
    }));
    expect(requests).toEqual([]);
    expect(evidenceRecords).toEqual([]);

    const mismatchedSubstrate = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: { ...proofCapsuleFixture(), substrate_claim: "dom" },
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => {
        throw new Error("proof validator must not run after substrate mismatch");
      },
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { status: "saved" } };
      },
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-a";
      },
    });

    expect(mismatchedSubstrate).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_proof_substrate_mismatch"],
    }));
    expect(requests).toEqual([]);
    expect(evidenceRecords).toEqual([]);
  });

  it("does not call the API transport when reusable proof validation blocks execution", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
    }).tool!;
    const requests: DojoApiToolHttpRequest[] = [];
    const evidenceRecords: DojoApiToolExecutionEvidence[] = [];

    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => ({ ok: false, blocked_by: ["proof_capsule_replay_detected"] }),
      transport: (request) => {
        requests.push(request);
        return { status: 201, body: { status: "saved" } };
      },
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-a";
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_replay_detected"],
      proof_validation: {
        ok: false,
        blocked_by: ["proof_capsule_replay_detected"],
      },
    }));
    expect(requests).toEqual([]);
    expect(evidenceRecords).toEqual([]);
  });

  it("blocks execution when API postconditions fail while preserving evidence", async () => {
    const tool = compileDojoApiBackedMcpTool({
      candidate: approvedMutationCandidate(),
      skill_id: "dojo_save_invoice",
      license_id: "license_save_invoice",
      license_version: "1.0.0",
      action: "run_workflow",
    }).tool!;
    const evidenceRecords: DojoApiToolExecutionEvidence[] = [];

    const result = await executeDojoApiBackedToolInvocation({
      tool,
      args: {
        proof_capsule: proofCapsuleFixture(),
        request: { client_id: "client-a", amount: 42 },
        idempotency_key: "idem-a",
      },
      license_context: licenseContext(),
      validate_proof: () => ({ ok: true, blocked_by: [] }),
      transport: () => ({ status: 200, body: { status: "draft" } }),
      write_evidence: (evidence) => {
        evidenceRecords.push(evidence);
        return "evidence:api-tool-failed-postcondition";
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_postcondition_guardrail_comparison_failed"],
      evidence_record_id: "evidence:api-tool-failed-postcondition",
      postcondition: expect.objectContaining({
        ok: false,
        actual: "draft",
        expected: "saved",
      }),
    }));
    expect(evidenceRecords).toEqual([
      expect.objectContaining({
        postcondition_ok: false,
        blocked_by: ["api_tool_postcondition_guardrail_comparison_failed"],
      }),
    ]);
  });
});

function proofCapsuleFixture() {
  return {
    capsule_id: "capsule-a",
    nonce: "nonce-a",
    skill_id: "dojo_save_invoice",
    license_id: "license_save_invoice",
    license_version: "1.0.0",
    requested_action: "run_workflow",
    substrate_claim: "api",
    evidence_record_ids: ["evidence-workspace", "evidence-checkride"],
    ledger_checkpoint_hash: "sha256:checkpoint-a",
    evidence_claims: [
      { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
      { claim: "checkride_passed", satisfied: true, evidence_refs: ["evidence-checkride"] },
    ],
  };
}

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

function licenseContext() {
  return {
    skill_id: "dojo_save_invoice",
    license_id: "license_save_invoice",
    license_version: "1.0.0",
    action: "run_workflow",
    auth_scopes: ["invoice:write"],
  };
}
