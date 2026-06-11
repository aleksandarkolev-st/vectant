import type { DojoEntrustmentLevel } from "../../browser/dojo.js";
import type { DojoExecutableCheckrideReport } from "./runner.js";

export interface DojoEntrustmentPolicyInput {
  checkride: DojoExecutableCheckrideReport;
  guardrails_active: boolean;
  evidence_backed: boolean;
  evidence_fresh: boolean;
  stable_substrate_available?: boolean;
  shadow_runs_match?: boolean;
  coverage_threshold_e3?: number;
  coverage_threshold_e5?: number;
}

export interface DojoEntrustmentDecision {
  level: DojoEntrustmentLevel;
  production_recommendation: "allowed" | "constrained" | "blocked";
  blocked_by: string[];
  limitations: string[];
  evidence_refs: string[];
}

export function decideDojoEntrustment(input: DojoEntrustmentPolicyInput): DojoEntrustmentDecision {
  const blockedBy: string[] = [];
  const limitations: string[] = [];
  const checkride = input.checkride;

  if (!input.evidence_fresh) {
    blockedBy.push("entrustment_evidence_stale");
    return decision("EX", "blocked", blockedBy, ["Evidence is stale; recertification is required."], checkride.evidence_refs);
  }
  if (checkride.critical_failures > 0) {
    blockedBy.push("entrustment_critical_failure");
    return decision("EX", "blocked", blockedBy, ["Critical risk scenario failed."], checkride.evidence_refs);
  }
  if (!input.evidence_backed) {
    blockedBy.push("entrustment_evidence_missing");
    return decision("E1", "blocked", blockedBy, ["Checkride lacks evidence-backed oracle records."], checkride.evidence_refs);
  }

  const e3Threshold = input.coverage_threshold_e3 ?? 0.5;
  if (!input.guardrails_active || checkride.coverage_score < e3Threshold) {
    if (!input.guardrails_active) blockedBy.push("entrustment_guardrails_inactive");
    if (checkride.coverage_score < e3Threshold) blockedBy.push("entrustment_coverage_below_e3");
    limitations.push("Limited to supervised or development execution until guardrails and coverage improve.");
    return decision("E2", checkride.production_recommendation === "blocked" ? "blocked" : "constrained", blockedBy, limitations, checkride.evidence_refs);
  }

  if (checkride.license_constraints.length > 0) {
    limitations.push(...checkride.license_constraints.map((constraint) => constraint.reason));
    return decision("E3", "constrained", blockedBy, limitations, checkride.evidence_refs);
  }

  if (input.stable_substrate_available && input.shadow_runs_match) {
    const e5Threshold = input.coverage_threshold_e5 ?? 0.9;
    if (checkride.coverage_score >= e5Threshold) {
      return decision("E5", "allowed", blockedBy, limitations, checkride.evidence_refs);
    }
    return decision("E4", "allowed", blockedBy, limitations, checkride.evidence_refs);
  }

  if (input.shadow_runs_match === false) {
    limitations.push("Shadow run mismatch prevents E4 upgrade.");
  }
  return decision("E3", "allowed", blockedBy, limitations, checkride.evidence_refs);
}

function decision(
  level: DojoEntrustmentLevel,
  productionRecommendation: DojoEntrustmentDecision["production_recommendation"],
  blockedBy: string[],
  limitations: string[],
  evidenceRefs: string[]
): DojoEntrustmentDecision {
  return {
    level,
    production_recommendation: productionRecommendation,
    blocked_by: blockedBy,
    limitations,
    evidence_refs: evidenceRefs,
  };
}
