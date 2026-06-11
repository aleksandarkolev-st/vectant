import type { DojoSkillReadinessLevel } from "../../browser/dojo.js";
import type { DojoExecutableCheckrideReport } from "./runner.js";

export interface DojoSkillReadinessInput {
  raw_trace_exists: boolean;
  seed_exists: boolean;
  graph_compiled: boolean;
  assertions_defined: boolean;
  organoid_generated: boolean;
  checkride?: DojoExecutableCheckrideReport;
  shadow_runs_match?: boolean;
  limited_production_license_issued?: boolean;
  stable_substrate_available?: boolean;
  monitoring_active?: boolean;
  case_law_feedback_active?: boolean;
}

export interface DojoSkillReadinessDecision {
  level: DojoSkillReadinessLevel;
  blocked_by: string[];
  next_required: string[];
}

export function decideDojoSkillReadiness(input: DojoSkillReadinessInput): DojoSkillReadinessDecision {
  if (!input.raw_trace_exists) return readiness(0, ["srl_raw_trace_missing"], ["Capture a human demonstration trace."]);
  if (!input.seed_exists) return readiness(0, ["srl_seed_missing"], ["Extract a Skill Seed."]);
  if (!input.graph_compiled) return readiness(1, ["srl_graph_missing"], ["Compile an executable Skill Cortex graph."]);
  if (!input.assertions_defined) return readiness(2, ["srl_assertions_missing"], ["Define postcondition assertions."]);
  if (!input.organoid_generated) return readiness(3, ["srl_organoid_missing"], ["Generate a synthetic workspace organoid."]);
  if (!input.checkride) return readiness(4, ["srl_checkride_missing"], ["Run an executable checkride."]);
  if (input.checkride.critical_failures > 0 || input.checkride.failed_scenarios > 0) {
    return readiness(4, ["srl_checkride_failures_open"], ["Resolve failed checkride scenarios before SRL 5."]);
  }
  if (!input.shadow_runs_match) return readiness(5, ["srl_shadow_runs_missing_or_mismatched"], ["Pass shadow runs against human actions."]);
  if (!input.limited_production_license_issued) return readiness(6, ["srl_limited_license_missing"], ["Issue a limited production license."]);
  if (!input.stable_substrate_available) return readiness(7, ["srl_stable_substrate_missing"], ["Promote at least one stable substrate."]);
  if (!input.monitoring_active || !input.case_law_feedback_active) {
    return readiness(8, ["srl_operational_feedback_missing"], ["Enable monitoring and case-law feedback."]);
  }
  return readiness(9, [], []);
}

function readiness(
  level: DojoSkillReadinessLevel,
  blockedBy: string[],
  nextRequired: string[]
): DojoSkillReadinessDecision {
  return {
    level,
    blocked_by: blockedBy,
    next_required: nextRequired,
  };
}
