import { createHash } from "node:crypto";
import type { DojoGraphEvidenceEvent, DojoGraphRunResult } from "../graph/runtime.js";
import type { DojoSkillGraph } from "../graph/types.js";
import type { BranchTrace, RegretBranchKind } from "./types.js";
import { uniqueRegretStrings } from "./types.js";

export function normalizeGraphRunBranchTrace(input: {
  graph: DojoSkillGraph;
  graph_result: DojoGraphRunResult;
  graph_evidence_events: DojoGraphEvidenceEvent[];
  counterfactual_run_id: string;
  tenant_id: string;
  workspace_id: string;
  task_class: string;
  base_state_hash: string;
  branch_kind: RegretBranchKind;
  now: string;
}): BranchTrace {
  const graphResult = input.graph_result;
  const evidenceIds = uniqueRegretStrings([
    ...graphResult.evidence_refs,
    ...input.graph_evidence_events.map((event) => `dojo-graph-event://${event.run_id}/${event.node_id}`),
  ]);
  const status = graphResult.ok
    ? "passed"
    : graphResult.status === "blocked" || graphResult.status === "paused"
      ? "blocked"
      : "failed";
  const substrate = uniqueRegretStrings(
    graphResult.node_results
      .map((result) => result.substrate_result?.substrate)
      .filter((value) => typeof value === "string")
      .map((value) => String(value))
  )[0];
  return {
    schema_version: "synthi.dojo.regret.branchTrace.v1",
    branch_id: `branch_${shortHash([
      input.counterfactual_run_id,
      graphResult.run_id,
      input.branch_kind,
      graphResult.status,
    ].join("|"))}`,
    counterfactual_run_id: input.counterfactual_run_id,
    branch_kind: input.branch_kind,
    status,
    graph_mode: graphResult.mode,
    ...(substrate ? { substrate } : {}),
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    skill_id: input.graph.skill_id,
    skill_version_id: input.graph.skill_version,
    graph_run_id: graphResult.run_id,
    task_class: input.task_class,
    base_state_hash: input.base_state_hash,
    blocked_by: uniqueRegretStrings(graphResult.blocked_by),
    detector_evidence_ids: evidenceIds,
    oracle_evidence_ids: [],
    selection_evidence_ids: [],
    evidence_ids: evidenceIds,
    summary: summaryForGraphRun(input.graph, graphResult),
    created_at: input.now,
    retention_policy: "ephemeral_trace",
  };
}

function summaryForGraphRun(graph: DojoSkillGraph, result: DojoGraphRunResult): string {
  const completed = result.node_results.filter((node) => node.status === "completed").length;
  const blocked = result.node_results.filter((node) => node.status === "blocked").length;
  return `${graph.graph_id} ${result.status}: ${completed} completed, ${blocked} blocked.`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
