import { describe, expect, it } from "vitest";
import { compileDojoApiBackedMcpTool } from "../../src/dojo/api/api_tool_compiler.js";
import { inferDojoApiEndpointCandidateFromTrace } from "../../src/dojo/api/endpoint_inference.js";
import { createFakeDojoSubstrateExecutor } from "../../src/dojo/graph/substrate_executor.js";
import { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo substrate executor", () => {
  it("rejects API substrate actions without approved candidate", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: "api-a" } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      substrate_executor: createFakeDojoSubstrateExecutor(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_candidate_not_approved"],
    }));
  });

  it("rejects production substrate execution without an explicit license substrate policy", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["dom"] }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["license_substrate_policy_missing"],
    }));
  });

  it("rejects UI fallback when license allows only API or MCP substrates", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["dom"] }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api", "mcp"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["substrate_not_allowed"],
    }));
  });

  it("executes approved API substrate and records substrate evidence", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: "api-a" } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        approved_api_candidates: ["api-a"],
        license_allowed_substrates: ["api"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      node_results: expect.arrayContaining([
        expect.objectContaining({
          substrate_result: expect.objectContaining({
            ok: true,
            substrate: "api",
            evidence_refs: ["substrate:api:action_submit"],
          }),
        }),
      ]),
    }));
  });

  it("rejects self-attested API candidate approval that is not bound to a reviewed candidate", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: "api-a" } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        approved_api_candidate: true,
        license_allowed_substrates: ["api"],
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      substrate_executor: createFakeDojoSubstrateExecutor(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_candidate_not_approved"],
    }));
  });

  it("executes API substrate only when a compiled API tool invocation passes proof and license preflight", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const tool = compiledApiTool();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: proofCapsuleFixture(),
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "license-a",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:write"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      node_results: expect.arrayContaining([
        expect.objectContaining({
          substrate_result: expect.objectContaining({
            ok: true,
            substrate: "api",
          }),
        }),
      ]),
    }));

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: proofCapsuleFixture(),
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "wrong-license",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:write"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_license_mismatch"],
    }));

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: { ...proofCapsuleFixture(), requested_action: "delete_invoice" },
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "license-a",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:write"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_proof_action_mismatch"],
    }));

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: proofCapsuleFixture(),
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "license-a",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:read"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_auth_scope_missing"],
    }));
  });

  it("executes compiled API substrate through transport and evidence callbacks", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const tool = compiledApiTool();
    const requests: unknown[] = [];
    const evidenceRecords: unknown[] = [];

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: proofCapsuleFixture(),
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "license-a",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:write"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      substrate_executor: createFakeDojoSubstrateExecutor({
        api_transport: (request) => {
          requests.push(request);
          return { status: 201, body: { status: "saved" } };
        },
        write_api_evidence: (evidence) => {
          evidenceRecords.push(evidence);
          return "evidence:api-substrate-a";
        },
      }),
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      node_results: expect.arrayContaining([
        expect.objectContaining({
          substrate_result: expect.objectContaining({
            ok: true,
            substrate: "api",
            evidence_refs: ["evidence:api-substrate-a"],
            api_tool_execution: expect.objectContaining({
              ok: true,
              evidence_record_id: "evidence:api-substrate-a",
            }),
          }),
        }),
      ]),
    }));
    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/invoices",
        headers: { "Idempotency-Key": "idem-a" },
      }),
    ]);
    expect(evidenceRecords).toEqual([
      expect.objectContaining({
        tool_name: "synthi_api_save_invoice",
        proof_capsule_id: "capsule-a",
        postcondition_ok: true,
        blocked_by: [],
      }),
    ]);
  });

  it("keeps API execution evidence on blocked substrate postconditions", async () => {
    const runtime = new DojoSkillGraphRuntime();
    const tool = compiledApiTool();

    await expect(runtime.execute({
      graph: graphFixture({ substrate_options: ["api"], metadata: { api_candidate_id: tool.candidate_id } }),
      mode: "production",
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
        compiled_api_tool: tool,
        api_tool_args: {
          proof_capsule: proofCapsuleFixture(),
          request: { amount: 42 },
          idempotency_key: "idem-a",
        },
        license_context: {
          skill_id: "skill-a",
          license_id: "license-a",
          license_version: "1.0.0",
          action: "run_workflow",
          auth_scopes: ["invoice:write"],
        },
        assertion_results: { assert_submission_state: true },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      substrate_executor: createFakeDojoSubstrateExecutor({
        api_transport: () => ({ status: 200, body: { status: "draft" } }),
        write_api_evidence: () => "evidence:api-substrate-failed-postcondition",
      }),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_postcondition_guardrail_comparison_failed"],
      node_results: expect.arrayContaining([
        expect.objectContaining({
          substrate_result: expect.objectContaining({
            ok: false,
            substrate: "api",
            evidence_refs: ["evidence:api-substrate-failed-postcondition"],
            api_tool_execution: expect.objectContaining({
              ok: false,
              evidence_record_id: "evidence:api-substrate-failed-postcondition",
            }),
          }),
        }),
      ]),
    }));
  });
});

const validProofValidator = () => ({ ok: true, blocked_by: [] });

function graphFixture(input: { substrate_options: string[]; metadata?: Record<string, unknown> }): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-a",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "production",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        node_id: "action_submit",
        kind: "Action",
        label: "Submit invoice",
        risk: "dangerous",
        action: "run_workflow",
        preconditions: ["workspace_verified == true"],
        postconditions: ["submission_state == success"],
        guardrails: [
          {
            guardrail_id: "guard_client_stable_id",
            predicate: "client_id_verified == true",
            severity: "block",
          },
        ],
        proof: {
          required: true,
          required_claims: ["checkride_passed", "workspace_verified"],
          required_guardrails: ["guard_client_stable_id"],
        },
        assertions: [
          {
            assertion_id: "assert_submission_state",
            description: "Submission state is success.",
            required: true,
          },
        ],
        substrate_options: input.substrate_options,
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: [],
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    ],
    edges: [],
  };
}

function compiledApiTool() {
  const candidate = {
    ...inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { amount: 42 },
      response_body: { invoice_id: "invoice-a", status: "saved" },
    }),
    auth_scope: "invoice:write",
    idempotency_key_location: "header" as const,
    rollback_strategy: "compensating_call" as const,
    postcondition: "invoice.status == 'saved'",
    proof_claim_mapping: { workspace_verified: "tenant.workspace_id" },
    review_status: "approved" as const,
  };
  const compiled = compileDojoApiBackedMcpTool({
    candidate,
    skill_id: "skill-a",
    license_id: "license-a",
    license_version: "1.0.0",
    action: "run_workflow",
    tool_name: "synthi_api_save_invoice",
  });
  if (!compiled.tool) throw new Error("compiled_api_tool_fixture_failed");
  return compiled.tool;
}

function proofCapsuleFixture() {
  return {
    capsule_id: "capsule-a",
    nonce: "nonce-a",
    skill_id: "skill-a",
    license_id: "license-a",
    license_version: "1.0.0",
    requested_action: "run_workflow",
    evidence_record_ids: ["evidence-workspace"],
    ledger_checkpoint_hash: "sha256:checkpoint-a",
    evidence_claims: [
      { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
    ],
  };
}
