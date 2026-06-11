import { describe, expect, it } from "vitest";
import { decideDojoSkillReadiness } from "../../src/dojo/checkride/readiness.js";
import type { DojoExecutableCheckrideReport } from "../../src/dojo/checkride/runner.js";

describe("Dojo skill readiness policy", () => {
  it("advances through seed, graph, assertions, organoid, and checkride maturity", () => {
    expect(decideDojoSkillReadiness({
      raw_trace_exists: true,
      seed_exists: true,
      graph_compiled: false,
      assertions_defined: false,
      organoid_generated: false,
    })).toEqual(expect.objectContaining({
      level: 1,
      blocked_by: ["srl_graph_missing"],
    }));

    expect(decideDojoSkillReadiness({
      raw_trace_exists: true,
      seed_exists: true,
      graph_compiled: true,
      assertions_defined: true,
      organoid_generated: true,
    })).toEqual(expect.objectContaining({
      level: 4,
      blocked_by: ["srl_checkride_missing"],
    }));
  });

  it("requires passing checkride for SRL 5 and limited production license for SRL 7", () => {
    expect(decideDojoSkillReadiness({
      raw_trace_exists: true,
      seed_exists: true,
      graph_compiled: true,
      assertions_defined: true,
      organoid_generated: true,
      checkride: reportFixture({ failed_scenarios: 1 }),
    })).toEqual(expect.objectContaining({
      level: 4,
      blocked_by: ["srl_checkride_failures_open"],
    }));

    expect(decideDojoSkillReadiness({
      raw_trace_exists: true,
      seed_exists: true,
      graph_compiled: true,
      assertions_defined: true,
      organoid_generated: true,
      checkride: reportFixture(),
      shadow_runs_match: true,
      limited_production_license_issued: false,
    })).toEqual(expect.objectContaining({
      level: 6,
      blocked_by: ["srl_limited_license_missing"],
    }));
  });

  it("reaches SRL 9 only with stable substrate and operational feedback", () => {
    expect(decideDojoSkillReadiness({
      raw_trace_exists: true,
      seed_exists: true,
      graph_compiled: true,
      assertions_defined: true,
      organoid_generated: true,
      checkride: reportFixture(),
      shadow_runs_match: true,
      limited_production_license_issued: true,
      stable_substrate_available: true,
      monitoring_active: true,
      case_law_feedback_active: true,
    })).toEqual({
      level: 9,
      blocked_by: [],
      next_required: [],
    });
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
