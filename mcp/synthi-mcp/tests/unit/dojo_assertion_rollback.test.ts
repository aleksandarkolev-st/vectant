import { describe, expect, it } from "vitest";
import { evaluateDojoGraphAssertions } from "../../src/dojo/graph/assertion_runtime.js";
import { decideDojoRollbackForAssertionFailure } from "../../src/dojo/graph/rollback_runtime.js";
import { DojoSkillGraphRuntime as BaseDojoSkillGraphRuntime, type DojoSkillGraphRuntimeInput } from "../../src/dojo/graph/runtime.js";
import { createFakeDojoSubstrateExecutor } from "../../src/dojo/graph/substrate_executor.js";
import type { DojoGraphNode, DojoSkillGraph } from "../../src/dojo/graph/types.js";

class DojoSkillGraphRuntime extends BaseDojoSkillGraphRuntime {
  execute(input: DojoSkillGraphRuntimeInput) {
    return super.execute({ tenant: tenantFixture(), ...input });
  }
}

describe("Dojo assertion and rollback runtime", () => {
  it("evaluates required, optional, and missing assertion results", () => {
    expect(evaluateDojoGraphAssertions([
      { assertion_id: "assert_a", description: "A", required: true },
      { assertion_id: "assert_b", description: "B", required: true },
      { assertion_id: "assert_c", description: "C", required: false },
    ], {
      assertion_results: {
        assert_a: true,
        assert_b: false,
      },
    })).toEqual([
      expect.objectContaining({ assertion_id: "assert_a", ok: true, status: "passed" }),
      expect.objectContaining({ assertion_id: "assert_b", ok: false, status: "failed", blocked_by: ["assertion_failed:assert_b"] }),
      expect.objectContaining({ assertion_id: "assert_c", ok: true, status: "skipped" }),
    ]);

    expect(evaluateDojoGraphAssertions([
      { assertion_id: "assert_missing", description: "Missing", required: true },
    ], {})).toEqual([
      expect.objectContaining({ ok: false, status: "missing", blocked_by: ["assertion_missing:assert_missing"] }),
    ]);
  });

  it("resolves assertion IDs from observed dotted-path context", () => {
    expect(evaluateDojoGraphAssertions([
      { assertion_id: "api_response.body.durable_success", description: "API durable state committed.", required: true },
      { assertion_id: "api_response.body.visual_success", description: "Visual success shown.", required: true },
    ], {
      api_response: {
        body: {
          durable_success: false,
          visual_success: true,
        },
      },
    })).toEqual([
      expect.objectContaining({
        assertion_id: "api_response.body.durable_success",
        ok: false,
        status: "failed",
        blocked_by: ["assertion_failed:api_response.body.durable_success"],
        observed: false,
      }),
      expect.objectContaining({
        assertion_id: "api_response.body.visual_success",
        ok: true,
        status: "passed",
        observed: true,
      }),
    ]);
  });

  it("creates a rollback decision when required assertion failure has no rollback path", () => {
    expect(decideDojoRollbackForAssertionFailure(actionNode({ strategy: "none", checkpoints: ["pre_mutation"] }))).toEqual(
      expect.objectContaining({
        status: "needs_human",
        strategy: "none",
        requires_human_review: true,
        blocked_by: ["rollback_unavailable_human_review_required"],
      })
    );

    expect(decideDojoRollbackForAssertionFailure(actionNode({ strategy: "same_session_restore", checkpoints: ["pre_mutation"] }))).toEqual(
      expect.objectContaining({
        status: "rollback_available",
        strategy: "same_session_restore",
        requires_human_review: false,
        blocked_by: [],
      })
    );
  });

  it("blocks graph execution when a required assertion fails and reports rollback requirement", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture({ strategy: "none", checkpoints: ["pre_mutation"] }),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["dom"],
        assertion_results: { assert_submission_state: false },
      },
      proof_capsule: { capsule_id: "capsule-a" },
      proof_validator: validProofValidator,
      substrate_executor: createFakeDojoSubstrateExecutor(),
      evidence_writer: (event) => `dojo-graph://${event.run_id}/${event.node_id}`,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expect.arrayContaining([
        "assertion_failed:assert_submission_state",
        "postcondition_failed:submission_state == success",
        "rollback_unavailable_human_review_required",
      ]),
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          rollback_decision: expect.objectContaining({
            status: "needs_human",
            requires_human_review: true,
          }),
        }),
      ]),
    }));
  });

  it("evaluates action assertions against observed API substrate response fields", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: apiAssertionGraphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: true,
        license_allowed_substrates: ["api"],
      },
      proof_capsule: { capsule_id: "capsule-api" },
      proof_validator: validProofValidator,
      evidence_writer: (event) => `dojo-graph://${event.run_id}/${event.node_id}`,
      substrate_executor: {
        execute: async () => ({
          ok: true,
          status: "executed",
          substrate: "api",
          blocked_by: [],
          evidence_refs: ["api-evidence:durable-state-check"],
          api_tool_execution: {
            ok: true,
            status: "executed",
            blocked_by: [],
            validation: { ok: true, blocked_by: [] },
            response: {
              status: 200,
              body: {
                visual_success: true,
                durable_success: false,
              },
            },
            evidence_record_id: "api-evidence:durable-state-check",
          },
        }),
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expect.arrayContaining([
        "assertion_failed:api_response.body.durable_success",
        "postcondition_failed:submission_state == success",
        "rollback_unavailable_human_review_required",
      ]),
      node_results: expect.arrayContaining([
        expect.objectContaining({
          node_id: "action_submit",
          status: "blocked",
          assertion_results: expect.arrayContaining([
            expect.objectContaining({
              assertion_id: "api_response.body.durable_success",
              status: "failed",
              observed: false,
            }),
          ]),
          substrate_result: expect.objectContaining({
            ok: true,
            substrate: "api",
          }),
        }),
      ]),
    }));
  });
});

const validProofValidator = () => ({ ok: true, blocked_by: [] });

function tenantFixture() {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "agent-a",
    actor_type: "agent" as const,
    roles: ["agent"],
    request_id: "req-assertion-runtime-a",
    correlation_id: "corr-assertion-runtime-a",
  };
}

function graphFixture(rollbackPolicy: Record<string, unknown>): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-a",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "production",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [actionNode(rollbackPolicy)],
    edges: [],
  };
}

function apiAssertionGraphFixture(): DojoSkillGraph {
  return {
    ...graphFixture({ strategy: "none", checkpoints: ["pre_mutation"] }),
    nodes: [
      {
        ...actionNode({ strategy: "none", checkpoints: ["pre_mutation"] }),
        assertions: [
          {
            assertion_id: "api_response.body.durable_success",
            description: "API response confirms durable success.",
            required: true,
          },
        ],
        substrate_options: ["api"],
      },
    ],
  };
}

function actionNode(rollbackPolicy: Record<string, unknown>): DojoGraphNode {
  return {
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
    substrate_options: ["dom"],
    evidence_policy: ["append_action_trace"],
    case_law_refs: [],
    expiry_triggers: [],
    metadata: { rollback_policy: rollbackPolicy },
  };
}
