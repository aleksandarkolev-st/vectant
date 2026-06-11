import { describe, expect, it } from "vitest";
import { decideDojoEntrustment } from "../../src/dojo/checkride/entrustment.js";
import type { DojoExecutableCheckrideReport } from "../../src/dojo/checkride/runner.js";

describe("Dojo entrustment policy", () => {
  it("blocks production entrustment on critical failures", () => {
    expect(decideDojoEntrustment({
      checkride: reportFixture({ critical_failures: 1, failed_scenarios: 1, production_recommendation: "blocked" }),
      guardrails_active: true,
      evidence_backed: true,
      evidence_fresh: true,
    })).toEqual(expect.objectContaining({
      level: "EX",
      production_recommendation: "blocked",
      blocked_by: ["entrustment_critical_failure"],
    }));
  });

  it("requires active guardrails and evidence before E3", () => {
    expect(decideDojoEntrustment({
      checkride: reportFixture({ coverage_score: 0.75 }),
      guardrails_active: false,
      evidence_backed: true,
      evidence_fresh: true,
    })).toEqual(expect.objectContaining({
      level: "E2",
      blocked_by: ["entrustment_guardrails_inactive"],
    }));

    expect(decideDojoEntrustment({
      checkride: reportFixture({ coverage_score: 0.75 }),
      guardrails_active: true,
      evidence_backed: false,
      evidence_fresh: true,
    })).toEqual(expect.objectContaining({
      level: "E1",
      production_recommendation: "blocked",
      blocked_by: ["entrustment_evidence_missing"],
    }));
  });

  it("downgrades stale evidence and prevents E4 on shadow mismatch", () => {
    expect(decideDojoEntrustment({
      checkride: reportFixture({ coverage_score: 1 }),
      guardrails_active: true,
      evidence_backed: true,
      evidence_fresh: false,
      stable_substrate_available: true,
      shadow_runs_match: true,
    })).toEqual(expect.objectContaining({
      level: "EX",
      blocked_by: ["entrustment_evidence_stale"],
    }));

    expect(decideDojoEntrustment({
      checkride: reportFixture({ coverage_score: 1 }),
      guardrails_active: true,
      evidence_backed: true,
      evidence_fresh: true,
      stable_substrate_available: true,
      shadow_runs_match: false,
    })).toEqual(expect.objectContaining({
      level: "E3",
      limitations: ["Shadow run mismatch prevents E4 upgrade."],
    }));
  });
});

function reportFixture(overrides: Partial<DojoExecutableCheckrideReport> = {}): DojoExecutableCheckrideReport {
  return {
    schema_version: "synthi.dojo.executableCheckrideReport.v1",
    checkride_id: "checkride-a",
    skill_id: "skill-a",
    graph_id: "graph-a",
    started_at: "2026-06-11T00:00:00.000Z",
    finished_at: "2026-06-11T00:00:00.000Z",
    scenario_count: 2,
    passed_scenarios: 2,
    failed_scenarios: 0,
    blocked_scenarios: 0,
    critical_failures: 0,
    coverage_score: 1,
    production_recommendation: "allowed",
    license_constraints: [],
    results: [],
    evidence_refs: ["evidence:checkride-a"],
    ...overrides,
  };
}
