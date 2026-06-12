import { describe, expect, it } from "vitest";
import { evaluateDojoGuardrailPredicate } from "../../src/dojo/graph/guardrail_runtime.js";
import { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo guardrail runtime", () => {
  it("evaluates equality, inequality, numeric comparison, truth, and membership predicates", () => {
    const context = {
      client_id_verified: true,
      amount: 50,
      currency: "EUR",
      approval_status: "pending",
    };

    expect(evaluateDojoGuardrailPredicate("client_id_verified == true", context).ok).toBe(true);
    expect(evaluateDojoGuardrailPredicate("approval_status != denied", context).ok).toBe(true);
    expect(evaluateDojoGuardrailPredicate("amount <= 500", context).ok).toBe(true);
    expect(evaluateDojoGuardrailPredicate("currency in [\"EUR\",\"USD\"]", context).ok).toBe(true);
    expect(evaluateDojoGuardrailPredicate("client_id_verified", context).ok).toBe(true);
  });

  it("returns explicit failure reasons for failed predicates", () => {
    expect(evaluateDojoGuardrailPredicate("duplicate_display_name_count == 0", {
      duplicate_display_name_count: 2,
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["guardrail_comparison_failed"],
      actual: 2,
      expected: 0,
    }));

    expect(evaluateDojoGuardrailPredicate("currency in [\"EUR\"]", { currency: "USD" })).toEqual(
      expect.objectContaining({ ok: false, blocked_by: ["guardrail_membership_failed"] })
    );
    expect(evaluateDojoGuardrailPredicate("unsupported >== 1", { unsupported: 1 })).toEqual(
      expect.objectContaining({ ok: false, blocked_by: ["guardrail_predicate_unsupported"] })
    );
  });

  it("blocks graph execution when a block-severity guardrail fails", async () => {
    const runtime = new DojoSkillGraphRuntime();

    await expect(runtime.execute({
      graph: graphFixture(),
      inputs: {
        workspace_verified: true,
        client_id_verified: false,
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["guardrail_failed:guard_client_stable_id"],
    }));
  });
});

function graphFixture(): DojoSkillGraph {
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
        substrate_options: ["dom"],
        evidence_policy: ["append_action_trace"],
        case_law_refs: [],
        expiry_triggers: [],
      },
    ],
    edges: [],
  };
}
