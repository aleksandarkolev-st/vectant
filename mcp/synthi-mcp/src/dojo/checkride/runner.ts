import { createHash } from "node:crypto";
import type { DojoGraphRunResult } from "../graph/runtime.js";
import type { DojoSkillGraph } from "../graph/types.js";
import type { DojoMaterializedFixture } from "../vivarium/fixture_materializer.js";
import {
  buildDojoScenarioOracleEvidenceRecordInput,
  type DojoScenarioOracleEvaluation,
  type DojoScenarioOracleEvidenceContext,
} from "../vivarium/oracle.js";
import { DojoVivariumRunner, type DojoScenarioRunResult } from "../vivarium/runner.js";
import type { DojoScenarioDefinition } from "../vivarium/scenario_dsl.js";
import type { DojoEvidenceRecordInput } from "../evidence/types.js";

export interface DojoExecutableCheckrideScenarioResult {
  scenario_id: string;
  mutation_kind: string;
  status: DojoScenarioOracleEvaluation["status"];
  expectation_met: boolean;
  graph_status: DojoGraphRunResult["status"];
  finding: string;
  blocked_by: string[];
  graph_run: DojoGraphRunResult;
  fixture: DojoMaterializedFixture;
  oracle: DojoScenarioOracleEvaluation;
  scenario_run: DojoScenarioRunResult;
  evidence_record?: DojoEvidenceRecordInput;
}

export interface DojoCheckrideLicenseConstraint {
  scenario_id: string;
  mutation_kind: string;
  constraint_kind: "exclude_context" | "ask_before" | "requires_guardrail";
  reason: string;
}

export interface DojoExecutableCheckrideReport {
  schema_version: "synthi.dojo.executableCheckrideReport.v1";
  checkride_id: string;
  skill_id: string;
  graph_id: string;
  started_at: string;
  finished_at: string;
  scenario_count: number;
  passed_scenarios: number;
  failed_scenarios: number;
  blocked_scenarios: number;
  critical_failures: number;
  coverage_score: number;
  production_recommendation: "allowed" | "constrained" | "blocked";
  license_constraints: DojoCheckrideLicenseConstraint[];
  results: DojoExecutableCheckrideScenarioResult[];
  evidence_refs: string[];
}

export interface DojoExecutableCheckrideInput {
  graph: DojoSkillGraph;
  scenarios: DojoScenarioDefinition[];
  base_inputs?: Record<string, unknown>;
  scenario_inputs?: Record<string, Record<string, unknown>>;
  observed_evidence_by_scenario?: Record<string, string[]>;
  evidence_context?: Omit<DojoScenarioOracleEvidenceContext, "run_id"> & { run_id_prefix?: string };
  now?: string;
}

export async function runDojoExecutableCheckride(
  input: DojoExecutableCheckrideInput
): Promise<DojoExecutableCheckrideReport> {
  const now = input.now ?? new Date().toISOString();
  const vivarium = new DojoVivariumRunner();
  const results: DojoExecutableCheckrideScenarioResult[] = [];

  for (const scenario of input.scenarios) {
    const runId = `${input.evidence_context?.run_id_prefix ?? "checkride"}_${scenario.scenario_id}`;
    const materialized = vivarium.materialize({
      skill_id: input.graph.skill_id,
      scenario,
      now,
    });
    const scenarioInputs = {
      ...(input.base_inputs ?? {}),
      ...(input.scenario_inputs?.[scenario.scenario_id] ?? {}),
    };
    const scenarioRun = await vivarium.run({
      materialized,
      graph: input.graph,
      run_id: runId,
      inputs: scenarioInputs,
      observed_evidence: input.observed_evidence_by_scenario?.[scenario.scenario_id] ?? ["graph_run_result", "oracle_result"],
      now,
    });
    const graphRun = scenarioRun.graph_result;
    const oracle = scenarioRun.oracle_result;
    const evidenceRecord = input.evidence_context
      ? buildDojoScenarioOracleEvidenceRecordInput(oracle, {
          ...input.evidence_context,
          run_id: runId,
        })
      : undefined;

    results.push({
      scenario_id: scenario.scenario_id,
      mutation_kind: scenario.mutation_kind,
      status: oracle.status,
      expectation_met: oracle.expectation_met,
      graph_status: graphRun.status,
      finding: oracle.finding,
      blocked_by: oracle.blocked_by,
      graph_run: graphRun,
      fixture: materialized.fixture,
      oracle,
      scenario_run: scenarioRun,
      ...(evidenceRecord ? { evidence_record: evidenceRecord } : {}),
    });
  }

  const failedScenarios = results.filter((result) => result.status === "failed").length;
  const blockedScenarios = results.filter((result) => result.status === "blocked" || result.status === "needs_human").length;
  const passedScenarios = results.filter((result) => result.status === "passed").length;
  const criticalFailures = results.filter((result) => result.status === "failed" && isCriticalMutation(result.mutation_kind)).length;
  const licenseConstraints = licenseConstraintsFor(results);
  return {
    schema_version: "synthi.dojo.executableCheckrideReport.v1",
    checkride_id: `checkride_${shortHash(`${input.graph.graph_id}:${now}:${results.map((result) => `${result.scenario_id}:${result.status}`).join("|")}`)}`,
    skill_id: input.graph.skill_id,
    graph_id: input.graph.graph_id,
    started_at: now,
    finished_at: now,
    scenario_count: results.length,
    passed_scenarios: passedScenarios,
    failed_scenarios: failedScenarios,
    blocked_scenarios: blockedScenarios,
    critical_failures: criticalFailures,
    coverage_score: results.length > 0 ? Number((passedScenarios / results.length).toFixed(2)) : 0,
    production_recommendation: productionRecommendation(criticalFailures, licenseConstraints),
    license_constraints: licenseConstraints,
    results,
    evidence_refs: results.flatMap((result) => result.evidence_record ? [`evidence:${result.evidence_record.record_id}`] : [`oracle:${result.oracle.oracle_id}`]),
  };
}

function licenseConstraintsFor(results: DojoExecutableCheckrideScenarioResult[]): DojoCheckrideLicenseConstraint[] {
  return results
    .filter((result) => result.status !== "passed")
    .map((result): DojoCheckrideLicenseConstraint => {
      if (result.status === "blocked" || result.status === "needs_human") {
        return {
          scenario_id: result.scenario_id,
          mutation_kind: result.mutation_kind,
          constraint_kind: "ask_before",
          reason: `Scenario ${result.mutation_kind} blocked; license must ask before this context or exclude it.`,
        };
      }
      return {
        scenario_id: result.scenario_id,
        mutation_kind: result.mutation_kind,
        constraint_kind: isCriticalMutation(result.mutation_kind) ? "requires_guardrail" : "exclude_context",
        reason: `Scenario ${result.mutation_kind} failed; production license cannot include this context without hardening.`,
      };
    });
}

function productionRecommendation(
  criticalFailures: number,
  constraints: DojoCheckrideLicenseConstraint[]
): DojoExecutableCheckrideReport["production_recommendation"] {
  if (criticalFailures > 0) return "blocked";
  if (constraints.length > 0) return "constrained";
  return "allowed";
}

function isCriticalMutation(mutationKind: string): boolean {
  return [
    "duplicate_entity",
    "stale_entity",
    "fake_success",
    "partial_write",
    "permission_change",
    "destructive_adjacency",
  ].includes(mutationKind);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
