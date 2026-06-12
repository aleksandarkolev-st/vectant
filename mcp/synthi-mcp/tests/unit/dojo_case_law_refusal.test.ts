import { describe, expect, it } from "vitest";
import { bindCaseLawGuardrailsToGraph } from "../../src/dojo/case_law/guardrail_synthesizer.js";
import { explainDojoRuntimeRefusal } from "../../src/dojo/case_law/refusal.js";
import { createDojoCaseLawFromFailure, InMemoryDojoCaseLawRegistry } from "../../src/dojo/case_law/registry.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";

describe("Dojo case-law refusal explanation", () => {
  it("cites case law, evidence, guardrail, and next step for runtime blocks", () => {
    const registry = new InMemoryDojoCaseLawRegistry();
    const proposed = registry.propose(createDojoCaseLawFromFailure({
      source_skill_id: "skill-a",
      source_run_id: "run-a",
      scenario_id: "scenario-a",
      mutation_kind: "duplicate_entity",
      finding: "Duplicate display name caused unsafe selection.",
      impact: "Wrong record may be mutated.",
      rule_created: "Require stable ID before mutation.",
      applies_to: ["run_workflow"],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      evidence_refs: ["evidence:oracle-a", "evidence:graph-a"],
      now: "2026-06-11T00:00:00.000Z",
    }));
    const approved = registry.approve(proposed.case_id, {
      reviewer: "reviewer-a",
      now: "2026-06-11T01:00:00.000Z",
    });
    const graph = bindCaseLawGuardrailsToGraph(graphFixture(), [approved]);
    const blockedBy = [`guardrail_failed:case_guard_${approved.case_id}`];

    expect(explainDojoRuntimeRefusal({
      graph,
      blocked_action: "run_workflow",
      blocked_by: blockedBy,
      case_law: [approved],
    })).toEqual({
      schema_version: "synthi.dojo.runtimeRefusalExplanation.v1",
      blocked_action: "run_workflow",
      blocked_by: blockedBy,
      rule: "Require stable ID before mutation.",
      guardrail_refs: [`case_guard_${approved.case_id}`],
      case_law_citations: [
        {
          case_id: approved.case_id,
          title: "Duplicate Entity",
          finding: "Duplicate display name caused unsafe selection.",
          rule_created: "Require stable ID before mutation.",
          evidence_refs: ["evidence:graph-a", "evidence:oracle-a"],
        },
      ],
      evidence_refs: ["evidence:graph-a", "evidence:oracle-a"],
      smallest_allowed_next_step: "Satisfy the cited case-law rule or request reviewer approval before run_workflow.",
    });
  });

  it("falls back to block reasons when no case citation is available", () => {
    expect(explainDojoRuntimeRefusal({
      graph: graphFixture(),
      blocked_action: "run_workflow",
      blocked_by: ["proof_capsule_missing"],
      case_law: [],
    })).toEqual(expect.objectContaining({
      rule: "Resolve block reason: proof_capsule_missing",
      case_law_citations: [],
      smallest_allowed_next_step: "Provide the missing proof, approval, or runtime condition before run_workflow.",
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
        node_id: "action",
        kind: "Action",
        label: "Run workflow",
        risk: "safe",
        action: "run_workflow",
        preconditions: [],
        postconditions: [],
        guardrails: [],
        assertions: [],
        substrate_options: ["dom"],
        evidence_policy: [],
        case_law_refs: [],
        expiry_triggers: [],
      },
    ],
    edges: [],
  };
}
