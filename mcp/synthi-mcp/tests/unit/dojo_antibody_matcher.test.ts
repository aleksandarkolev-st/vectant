import { describe, expect, it } from "vitest";
import { matchDojoCaseLawAntibodies } from "../../src/dojo/case_law/antibody_matcher.js";
import { createDojoCaseLawFromFailure, InMemoryDojoCaseLawRegistry, type DojoCaseLawRecord } from "../../src/dojo/case_law/registry.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo case-law antibody matcher", () => {
  it("proposes inherited guardrails for related action nodes without binding them directly", () => {
    const approved = approvedDuplicateClientCase();
    const [candidate] = matchDojoCaseLawAntibodies({
      source_case_law: [approved],
      target_graph: graphFixture(),
      binding_scope: { kind: "workspace", id: "workspace-b" },
      now: "2026-06-11T02:00:00.000Z",
    });

    expect(candidate).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.antibodyCandidate.v1",
      antibody_id: expect.stringMatching(/^antibody_[a-f0-9]{16}$/),
      source_case_id: approved.case_id,
      target_skill_id: "skill-b",
      target_graph_id: "graph-b",
      target_node_id: "action_submit_invoice",
      binding_scope: { kind: "workspace", id: "workspace-b" },
      status: "proposed",
      private_data_transferred: false,
      local_practice_required: true,
      local_checkride_required: true,
      inherited_guardrail: expect.objectContaining({
        guardrail_id: `case_guard_${approved.case_id}`,
        predicate: "stable_entity_identity == true",
        severity: "block",
      }),
    }));
    expect(candidate?.confidence).toBeGreaterThanOrEqual(0.45);
    expect(candidate?.match_reasons).toEqual(expect.arrayContaining([
      "action_match:run_workflow",
      expect.stringMatching(/^context_token_overlap:/),
    ]));
    expect(candidate?.source_evidence_ref_count).toBe(1);
    expect(candidate?.source_evidence_ref_digests).toEqual([expect.stringMatching(/^sha256:[a-f0-9]{64}$/)]);
    expect(JSON.stringify(candidate)).not.toContain("evidence:oracle-a");
  });

  it("does not propose antibodies from proposed, deprecated, superseded, or overturned case law", () => {
    const registry = new InMemoryDojoCaseLawRegistry();
    const proposed = registry.propose(caseFixture());
    const approved = registry.approve(proposed.case_id, { reviewer: "reviewer-a", now: "2026-06-11T01:00:00.000Z" });
    const deprecated = registry.deprecate(proposed.case_id, {
      superseded_by: "case-replacement",
      reviewer: "reviewer-b",
      now: "2026-06-11T02:00:00.000Z",
    });

    expect(matchDojoCaseLawAntibodies({
      source_case_law: [
        proposed,
        deprecated,
        { ...approved, superseded_by: "case-replacement" },
        { ...approved, appeal_status: "overturned" },
      ],
      target_graph: graphFixture(),
      now: "2026-06-11T03:00:00.000Z",
    })).toEqual([]);
  });

  it("ignores unrelated safe action nodes below the confidence threshold", () => {
    expect(matchDojoCaseLawAntibodies({
      source_case_law: [approvedDuplicateClientCase()],
      target_graph: graphFixture({
        nodes: [
          {
            ...actionNodeFixture(),
            node_id: "action_read_dashboard",
            label: "Read account dashboard",
            risk: "safe",
            action: "read_dashboard",
            preconditions: [],
            postconditions: [],
            guardrails: [],
            proof: undefined,
            assertions: [],
            substrate_options: ["dom"],
          },
        ],
      }),
      now: "2026-06-11T02:00:00.000Z",
    })).toEqual([]);
  });

  it("orders candidates by confidence and keeps deterministic candidate IDs", () => {
    const graph = graphFixture({
      nodes: [
        actionNodeFixture(),
        {
          ...actionNodeFixture(),
          node_id: "action_submit_invoice_api",
          label: "Submit invoice through API with stable client identity",
          action: "run_workflow",
          substrate_options: ["api"],
        },
      ],
    });

    const first = matchDojoCaseLawAntibodies({
      source_case_law: [approvedDuplicateClientCase()],
      target_graph: graph,
      now: "2026-06-11T02:00:00.000Z",
    });
    const second = matchDojoCaseLawAntibodies({
      source_case_law: [approvedDuplicateClientCase()],
      target_graph: graph,
      now: "2026-06-11T02:00:00.000Z",
    });

    expect(first.map((candidate) => candidate.antibody_id)).toEqual(second.map((candidate) => candidate.antibody_id));
    expect(first.map((candidate) => candidate.confidence)).toEqual([...first.map((candidate) => candidate.confidence)].sort((left, right) => right - left));
  });
});

function approvedDuplicateClientCase(): DojoCaseLawRecord {
  const registry = new InMemoryDojoCaseLawRegistry();
  const proposed = registry.propose(caseFixture());
  return registry.approve(proposed.case_id, {
    reviewer: "reviewer-a",
    now: "2026-06-11T01:00:00.000Z",
  });
}

function caseFixture(): DojoCaseLawRecord {
  return createDojoCaseLawFromFailure({
    source_skill_id: "skill-a",
    source_run_id: "run-a",
    scenario_id: "scenario-a",
    mutation_kind: "duplicate_entity",
    finding: "Duplicate display name caused unsafe client selection.",
    impact: "Wrong client invoice may be submitted.",
    rule_created: "Require stable entity identity before invoice submission.",
    applies_to: ["run_workflow"],
    binding_scope: { kind: "workspace", id: "workspace-a" },
    evidence_refs: ["evidence:oracle-a"],
    now: "2026-06-11T00:00:00.000Z",
  });
}

function graphFixture(overrides: Partial<DojoSkillGraph> = {}): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-b",
    skill_id: "skill-b",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "production",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [actionNodeFixture()],
    edges: [],
    ...overrides,
  };
}

function actionNodeFixture(): DojoSkillGraph["nodes"][number] {
  return {
    node_id: "action_submit_invoice",
    kind: "Action",
    label: "Submit invoice for selected client",
    risk: "dangerous",
    action: "run_workflow",
    preconditions: ["workspace_verified == true", "client_id_verified == true"],
    postconditions: ["invoice_submission_state == success"],
    guardrails: [
      {
        guardrail_id: "guard_client_id_verified",
        predicate: "client_id_verified == true",
        severity: "block",
      },
    ],
    proof: {
      required: true,
      required_claims: ["checkride_passed", "workspace_verified"],
      required_guardrails: ["guard_client_id_verified"],
    },
    assertions: [
      {
        assertion_id: "assert_invoice_submission",
        description: "Invoice submission succeeded for selected client.",
        required: true,
      },
    ],
    substrate_options: ["dom"],
    evidence_policy: ["append_action_trace"],
    case_law_refs: [],
    expiry_triggers: [],
  };
}
