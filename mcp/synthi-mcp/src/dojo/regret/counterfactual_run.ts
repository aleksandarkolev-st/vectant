import { createHash } from "node:crypto";
import {
  DojoSkillGraphRuntime,
  type DojoGraphEvidenceEvent,
  type DojoGraphRunResult,
  type DojoSkillGraphRuntimeInput,
} from "../graph/runtime.js";
import type { DojoSkillGraph } from "../graph/types.js";
import type { RegretMemoryStore } from "./store.js";
import type { BranchTrace, CounterfactualRun, RegretBranchKind } from "./types.js";
import { normalizeGraphRunBranchTrace } from "./branch_trace.js";
import { uniqueRegretStrings } from "./types.js";

export interface RegretGraphCaptureResult {
  graph_result: DojoGraphRunResult;
  counterfactual_run: CounterfactualRun;
  branch_trace: BranchTrace;
  graph_evidence_events: DojoGraphEvidenceEvent[];
}

export async function executeGraphWithRegretCapture(input: {
  runtime?: DojoSkillGraphRuntime;
  runtime_input: DojoSkillGraphRuntimeInput;
  store?: RegretMemoryStore;
  tenant_id: string;
  workspace_id: string;
  task_class: string;
  branch_kind?: RegretBranchKind;
  base_state_hash?: string;
  now?: string;
}): Promise<RegretGraphCaptureResult> {
  const runtime = input.runtime ?? new DojoSkillGraphRuntime();
  const graph = input.runtime_input.graph;
  const graphEvents: DojoGraphEvidenceEvent[] = [];
  const existingEvidenceWriter = input.runtime_input.evidence_writer;
  const graphResult = await runtime.execute({
    ...input.runtime_input,
    evidence_writer: async (event) => {
      graphEvents.push(event);
      const ref = await existingEvidenceWriter?.(event);
      return typeof ref === "string" && ref.trim() ? ref : `dojo-graph://${event.run_id}/${event.node_id}`;
    },
  });
  const now = input.now ?? new Date().toISOString();
  const baseStateHash = input.base_state_hash ?? baseStateHashForGraph(graph);
  const counterfactualRun = createCounterfactualRunForGraph({
    graph,
    graph_result: graphResult,
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    task_class: input.task_class,
    base_state_hash: baseStateHash,
    now,
  });
  const branchTrace = normalizeGraphRunBranchTrace({
    graph,
    graph_result: graphResult,
    graph_evidence_events: graphEvents,
    counterfactual_run_id: counterfactualRun.counterfactual_run_id,
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    task_class: input.task_class,
    base_state_hash: baseStateHash,
    branch_kind: input.branch_kind ?? "baseline",
    now,
  });
  await input.store?.putCounterfactualRun({
    ...counterfactualRun,
    branch_ids: [branchTrace.branch_id],
    evidence_ids: uniqueRegretStrings([...counterfactualRun.evidence_ids, ...branchTrace.evidence_ids]),
  });
  await input.store?.putBranchTrace(branchTrace);
  return {
    graph_result: graphResult,
    counterfactual_run: {
      ...counterfactualRun,
      branch_ids: [branchTrace.branch_id],
      evidence_ids: uniqueRegretStrings([...counterfactualRun.evidence_ids, ...branchTrace.evidence_ids]),
    },
    branch_trace: branchTrace,
    graph_evidence_events: graphEvents,
  };
}

export function createCounterfactualRunForGraph(input: {
  graph: DojoSkillGraph;
  graph_result: DojoGraphRunResult;
  tenant_id: string;
  workspace_id: string;
  task_class: string;
  base_state_hash: string;
  now: string;
}): CounterfactualRun {
  return {
    schema_version: "synthi.dojo.regret.counterfactualRun.v1",
    counterfactual_run_id: `counterfactual_${shortHash([
      input.graph.graph_id,
      input.graph_result.run_id,
      input.base_state_hash,
    ].join("|"))}`,
    run_kind: "graph_execution",
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    skill_id: input.graph.skill_id,
    skill_version_id: input.graph.skill_version,
    graph_run_id: input.graph_result.run_id,
    task_class: input.task_class,
    base_state_hash: input.base_state_hash,
    branch_ids: [],
    evidence_ids: [...input.graph_result.evidence_refs],
    created_at: input.now,
    retention_policy: "ephemeral_trace",
  };
}

function baseStateHashForGraph(graph: DojoSkillGraph): string {
  return `sha256:${shortHash(JSON.stringify({
    graph_id: graph.graph_id,
    graph_version: graph.graph_version,
    mode: graph.mode,
    node_ids: graph.nodes.map((node) => node.node_id).sort(),
    edge_ids: graph.edges.map((edge) => edge.edge_id).sort(),
  }))}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
