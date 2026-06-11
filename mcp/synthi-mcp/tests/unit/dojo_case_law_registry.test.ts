import { describe, expect, it } from "vitest";
import {
  createDojoCaseLawFromFailure,
  InMemoryDojoCaseLawRegistry,
} from "../../src/dojo/case_law/registry.js";

describe("Dojo case law registry", () => {
  it("creates proposed cases from failed runs but does not bind them until approved", () => {
    const registry = new InMemoryDojoCaseLawRegistry();
    const record = caseFixture();

    registry.propose(record);
    expect(registry.get(record.case_id)).toEqual(expect.objectContaining({
      status: "proposed",
      evidence_refs: ["evidence:oracle-a"],
    }));
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-a" })).toEqual([]);
  });

  it("returns approved binding cases for matching scope", () => {
    const registry = new InMemoryDojoCaseLawRegistry();
    const record = registry.propose(caseFixture());
    const approved = registry.approve(record.case_id, { reviewer: "reviewer-a", now: "2026-06-11T01:00:00.000Z" });

    expect(approved).toEqual(expect.objectContaining({
      status: "approved",
      reviewer: "reviewer-a",
    }));
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-a" })).toEqual([
      expect.objectContaining({ case_id: record.case_id, status: "approved" }),
    ]);
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-b" })).toEqual([]);
  });

  it("removes deprecated cases from binding lookup", () => {
    const registry = new InMemoryDojoCaseLawRegistry();
    const record = registry.propose(caseFixture());
    registry.approve(record.case_id, { reviewer: "reviewer-a", now: "2026-06-11T01:00:00.000Z" });
    const deprecated = registry.deprecate(record.case_id, {
      superseded_by: "case-next",
      reviewer: "reviewer-b",
      now: "2026-06-11T02:00:00.000Z",
    });

    expect(deprecated).toEqual(expect.objectContaining({
      status: "deprecated",
      superseded_by: "case-next",
    }));
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-a" })).toEqual([]);
  });

  it("requires evidence for proposed case law", () => {
    expect(() => createDojoCaseLawFromFailure({
      source_skill_id: "skill-a",
      source_run_id: "run-a",
      scenario_id: "scenario-a",
      mutation_kind: "duplicate_entity",
      finding: "Duplicate display name caused unsafe selection.",
      impact: "Wrong record may be mutated.",
      rule_created: "Require stable ID before mutation.",
      applies_to: ["run_workflow"],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      evidence_refs: [],
      now: "2026-06-11T00:00:00.000Z",
    })).toThrow(/dojo_case_law_evidence_required/);
  });
});

function caseFixture() {
  return createDojoCaseLawFromFailure({
    source_skill_id: "skill-a",
    source_run_id: "run-a",
    scenario_id: "scenario-a",
    mutation_kind: "duplicate_entity",
    finding: "Duplicate display name caused unsafe selection.",
    impact: "Wrong record may be mutated.",
    rule_created: "Require stable ID before mutation.",
    applies_to: ["run_workflow"],
    binding_scope: { kind: "workspace", id: "workspace-a" },
    evidence_refs: ["evidence:oracle-a"],
    now: "2026-06-11T00:00:00.000Z",
  });
}
