import { randomUUID } from "node:crypto";
import {
  type DojoGraphEdge,
  type DojoGraphNode,
  type DojoGraphMode,
  type DojoSkillGraph,
  validateDojoSkillGraph,
} from "./types.js";
import { evaluateDojoGuardrailPredicate } from "./guardrail_runtime.js";
import { evaluateDojoGraphAssertions, type DojoAssertionRuntimeResult } from "./assertion_runtime.js";
import { decideDojoRollbackForAssertionFailure, noRollbackRequired, type DojoRollbackDecision } from "./rollback_runtime.js";
import {
  createFakeDojoSubstrateExecutor,
  type DojoSubstrateExecutionResult,
  type DojoSubstrateExecutor,
} from "./substrate_executor.js";

export type DojoGraphNodeRunStatus = "completed" | "blocked" | "skipped" | "paused";
export type DojoGraphRunStatus = "completed" | "blocked" | "failed" | "paused";

export interface DojoGraphNodeRunResult {
  node_id: string;
  kind: DojoGraphNode["kind"];
  status: DojoGraphNodeRunStatus;
  blocked_by: string[];
  assertion_results: DojoAssertionRuntimeResult[];
  rollback_decision: DojoRollbackDecision;
  substrate_result?: DojoSubstrateExecutionResult;
  control_flow?: {
    selected_edge_id?: string;
    selected_to_node_id?: string;
    skipped_by?: string[];
  };
}

export interface DojoGraphRunResult {
  ok: boolean;
  status: DojoGraphRunStatus;
  mode: DojoGraphMode;
  run_id: string;
  node_results: DojoGraphNodeRunResult[];
  blocked_by: string[];
  evidence_refs: string[];
  resume_state?: DojoGraphResumeState;
}

export interface DojoGraphProofValidationResult {
  ok: boolean;
  blocked_by: string[];
}

export type DojoGraphProofValidator = (input: {
  graph: DojoSkillGraph;
  node: DojoGraphNode;
  mode: DojoGraphMode;
  proof_capsule: unknown;
  inputs: Record<string, unknown>;
}) => DojoGraphProofValidationResult | Promise<DojoGraphProofValidationResult>;

export interface DojoGraphExpiryState {
  expired_skill?: boolean;
  expired_node_ids?: string[];
  expired_triggers?: string[];
}

export type DojoHumanDecision = "approved" | "denied";

export interface DojoGraphResumeState {
  paused_node_id: string;
  decision_key: string;
  completed_node_ids: string[];
}

export interface DojoGraphEvidenceEvent {
  schema_version: "synthi.dojo.graphEvidenceEvent.v1";
  run_id: string;
  graph_id: string;
  skill_id: string;
  graph_version: string;
  node_id: string;
  node_kind: DojoGraphNode["kind"];
  status: DojoGraphNodeRunStatus;
  blocked_by: string[];
  evidence_policy: string[];
  guardrail_ids: string[];
  proof_required: boolean;
  proof_claims: string[];
  case_law_refs: string[];
  assertion_ids: string[];
  substrate_status?: DojoSubstrateExecutionResult["status"];
  substrate?: DojoSubstrateExecutionResult["substrate"];
  substrate_evidence_refs: string[];
  created_at: string;
}

export type DojoGraphEvidenceWriter = (
  event: DojoGraphEvidenceEvent
) => string | void | Promise<string | void>;

export interface DojoSkillGraphRuntimeInput {
  graph: DojoSkillGraph;
  run_id?: string;
  mode?: DojoGraphMode;
  inputs?: Record<string, unknown>;
  expiry_state?: DojoGraphExpiryState;
  human_decisions?: Record<string, DojoHumanDecision>;
  resume_state?: DojoGraphResumeState;
  proof_capsule?: unknown;
  proof_validator?: DojoGraphProofValidator;
  allow_self_attested_proof?: boolean;
  substrate_executor?: DojoSubstrateExecutor;
  evidence_writer?: DojoGraphEvidenceWriter;
}

export class DojoSkillGraphRuntime {
  validateGraph(graph: DojoSkillGraph) {
    return validateDojoSkillGraph(graph);
  }

  async execute(input: DojoSkillGraphRuntimeInput): Promise<DojoGraphRunResult> {
    const mode = input.mode ?? input.graph.mode;
    const graph = { ...input.graph, mode };
    const runId = input.run_id ?? createGraphRunId(graph);
    const validation = validateDojoSkillGraph(graph);
    if (!validation.ok) {
      return {
        ok: false,
        status: "blocked",
        mode,
        run_id: runId,
        node_results: [],
        blocked_by: validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.issue_id),
        evidence_refs: [],
      };
    }

    const inputs = input.inputs ?? {};
    const substrateExecutor = input.substrate_executor ?? createFakeDojoSubstrateExecutor();
    const nodeResults: DojoGraphNodeRunResult[] = [];
    const evidenceRefs: string[] = [];
    const skippedNodes = new Map<string, string[]>();
    const resumeCompletedNodeIds = new Set(input.resume_state?.completed_node_ids ?? []);
    for (const node of executionNodesForGraph(graph)) {
      if (resumeCompletedNodeIds.has(node.node_id)) {
        const skippedResult: DojoGraphNodeRunResult = {
          node_id: node.node_id,
          kind: node.kind,
          status: "skipped",
          blocked_by: [],
          assertion_results: [],
          rollback_decision: noRollbackRequired(),
          control_flow: { skipped_by: ["resume_already_completed"] },
        };
        nodeResults.push(skippedResult);
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, skippedResult));
        continue;
      }

      const skippedBy = skippedNodes.get(node.node_id);
      if (skippedBy) {
        const skippedResult: DojoGraphNodeRunResult = {
          node_id: node.node_id,
          kind: node.kind,
          status: "skipped",
          blocked_by: [],
          assertion_results: [],
          rollback_decision: noRollbackRequired(),
          control_flow: { skipped_by: skippedBy },
        };
        nodeResults.push(skippedResult);
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, skippedResult));
        continue;
      }

      const blockedBy = blockedByForNode(node, mode, inputs, input.expiry_state);
      const proofBlockedBy = blockedBy.length === 0
        ? await proofBlockedByForNode(node, mode, graph, input, inputs)
        : [];
      blockedBy.push(...proofBlockedBy);
      const result: DojoGraphNodeRunResult = {
        node_id: node.node_id,
        kind: node.kind,
        status: blockedBy.length > 0 ? "blocked" : "completed",
        blocked_by: blockedBy,
        assertion_results: [],
        rollback_decision: noRollbackRequired(),
      };
      nodeResults.push(result);
      if (blockedBy.length > 0) {
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, result));
        return {
          ok: false,
          status: "blocked",
          mode,
          run_id: runId,
          node_results: nodeResults,
          blocked_by: blockedBy,
          evidence_refs: evidenceRefs,
        };
      }

      if (node.kind === "Human") {
        const humanDecision = humanDecisionForNode(node, input.human_decisions);
        if (humanDecision.status === "paused") {
          const pausedResult: DojoGraphNodeRunResult = {
            ...result,
            status: "paused",
            blocked_by: humanDecision.blocked_by,
          };
          nodeResults[nodeResults.length - 1] = pausedResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, pausedResult));
          return {
            ok: false,
            status: "paused",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: humanDecision.blocked_by,
            evidence_refs: evidenceRefs,
            resume_state: {
              paused_node_id: node.node_id,
              decision_key: humanDecision.decision_key,
              completed_node_ids: completedNodeIdsForResume(nodeResults),
            },
          };
        }
        if (humanDecision.status === "blocked") {
          const blockedResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: humanDecision.blocked_by,
          };
          nodeResults[nodeResults.length - 1] = blockedResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, blockedResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: humanDecision.blocked_by,
            evidence_refs: evidenceRefs,
          };
        }
      }

      if (node.kind === "Action") {
        const substrateResult = await substrateExecutor.execute({ node, mode, inputs });
        if (!substrateResult.ok) {
          const substrateNodeResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: substrateResult.blocked_by,
            substrate_result: substrateResult,
          };
          nodeResults[nodeResults.length - 1] = substrateNodeResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, substrateNodeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: substrateResult.blocked_by,
            evidence_refs: evidenceRefs,
          };
        }
        nodeResults[nodeResults.length - 1] = {
          ...result,
          substrate_result: substrateResult,
        };
      }

      if (node.kind === "Branch") {
        const branchDecision = decideBranch(node, graph, inputs);
        if (!branchDecision.ok) {
          const branchResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: branchDecision.blocked_by,
          };
          nodeResults[nodeResults.length - 1] = branchResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, branchResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: branchDecision.blocked_by,
            evidence_refs: evidenceRefs,
          };
        }
        for (const [nodeId, reasons] of branchDecision.skipped_nodes) {
          const existing = skippedNodes.get(nodeId) ?? [];
          skippedNodes.set(nodeId, [...existing, ...reasons]);
        }
        nodeResults[nodeResults.length - 1] = {
          ...result,
          control_flow: {
            selected_edge_id: branchDecision.selected_edge.edge_id,
            selected_to_node_id: branchDecision.selected_edge.to_node_id,
          },
        };
      }

      const assertionResults = evaluateDojoGraphAssertions(node.assertions, inputs);
      const assertionBlockedBy = assertionResults.flatMap((assertion) => assertion.blocked_by);
      if (assertionBlockedBy.length > 0) {
        const rollbackDecision = decideDojoRollbackForAssertionFailure(node);
        const blockedWithRollback = [...assertionBlockedBy, ...rollbackDecision.blocked_by];
        const assertionResult: DojoGraphNodeRunResult = {
          node_id: node.node_id,
          kind: node.kind,
          status: "blocked",
          blocked_by: blockedWithRollback,
          assertion_results: assertionResults,
          rollback_decision: rollbackDecision,
        };
        nodeResults[nodeResults.length - 1] = assertionResult;
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, assertionResult));
        return {
          ok: false,
          status: "blocked",
          mode,
          run_id: runId,
          node_results: nodeResults,
          blocked_by: blockedWithRollback,
          evidence_refs: evidenceRefs,
        };
      }

      nodeResults[nodeResults.length - 1] = {
        ...nodeResults[nodeResults.length - 1]!,
        assertion_results: assertionResults,
      };
      evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, nodeResults[nodeResults.length - 1]!));
    }

    return {
      ok: true,
      status: "completed",
      mode,
      run_id: runId,
      node_results: nodeResults,
      blocked_by: [],
      evidence_refs: evidenceRefs,
    };
  }
}

function executionNodesForGraph(graph: DojoSkillGraph): DojoGraphNode[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const incomingNodeIds = new Set(graph.edges.map((edge) => edge.to_node_id));
  const triggerNodeIds = graph.nodes
    .filter((node) => node.kind === "Trigger")
    .map((node) => node.node_id);
  const rootNodeIds = triggerNodeIds.length > 0
    ? triggerNodeIds
    : graph.nodes.filter((node) => !incomingNodeIds.has(node.node_id)).map((node) => node.node_id);
  const queue = rootNodeIds.length > 0 ? [...rootNodeIds] : graph.nodes.slice(0, 1).map((node) => node.node_id);
  const visited = new Set<string>();
  const ordered: DojoGraphNode[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (!node) continue;
    visited.add(nodeId);
    ordered.push(node);
    for (const edge of graph.edges.filter((candidate) => candidate.from_node_id === nodeId)) {
      if (!visited.has(edge.to_node_id)) queue.push(edge.to_node_id);
    }
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.node_id)) ordered.push(node);
  }
  return ordered;
}

async function emitGraphNodeEvidence(
  input: DojoSkillGraphRuntimeInput,
  graph: DojoSkillGraph,
  runId: string,
  node: DojoGraphNode,
  result: DojoGraphNodeRunResult
): Promise<string> {
  const fallbackRef = `dojo-graph://${runId}/${node.node_id}`;
  const emittedRef = await input.evidence_writer?.({
    schema_version: "synthi.dojo.graphEvidenceEvent.v1",
    run_id: runId,
    graph_id: graph.graph_id,
    skill_id: graph.skill_id,
    graph_version: graph.graph_version,
    node_id: node.node_id,
    node_kind: node.kind,
    status: result.status,
    blocked_by: result.blocked_by,
    evidence_policy: [...node.evidence_policy],
    guardrail_ids: node.guardrails.map((guardrail) => guardrail.guardrail_id),
    proof_required: node.proof?.required === true,
    proof_claims: [...(node.proof?.required_claims ?? [])],
    case_law_refs: [...node.case_law_refs],
    assertion_ids: result.assertion_results.map((assertion) => assertion.assertion_id),
    ...(result.substrate_result ? { substrate_status: result.substrate_result.status } : {}),
    ...(result.substrate_result?.substrate ? { substrate: result.substrate_result.substrate } : {}),
    substrate_evidence_refs: [...(result.substrate_result?.evidence_refs ?? [])],
    created_at: new Date().toISOString(),
  });
  return typeof emittedRef === "string" && emittedRef.trim() ? emittedRef : fallbackRef;
}

function createGraphRunId(graph: DojoSkillGraph): string {
  return `dojo_run_${graph.skill_id}_${randomUUID()}`;
}

function blockedByForNode(
  node: DojoGraphNode,
  mode: DojoGraphMode,
  inputs: Record<string, unknown>,
  expiryState?: DojoGraphExpiryState
): string[] {
  const expiryBlockedBy = expiryBlockedByForNode(node, expiryState);
  if (expiryBlockedBy.length > 0) return expiryBlockedBy;

  const retryBlockedBy = retryBlockedByForNode(node, inputs);
  if (retryBlockedBy.length > 0) return retryBlockedBy;

  const blockedBy = node.preconditions
    .filter((condition) => !evaluateStaticCondition(condition, inputs))
    .map((condition) => `precondition_failed:${condition}`);
  if (blockedBy.length > 0) return blockedBy;
  for (const guardrail of node.guardrails) {
    const result = evaluateDojoGuardrailPredicate(guardrail.predicate, inputs);
    if (!result.ok && guardrail.severity === "block") {
      blockedBy.push(`guardrail_failed:${guardrail.guardrail_id}`);
    }
  }
  return blockedBy;
}

function expiryBlockedByForNode(node: DojoGraphNode, expiryState?: DojoGraphExpiryState): string[] {
  if (!expiryState) return [];
  if (expiryState.expired_skill === true) return ["skill_expired"];

  const expiredNodeIds = new Set(expiryState.expired_node_ids ?? []);
  if (expiredNodeIds.has(node.node_id)) return [`node_expired:${node.node_id}`];

  const expiredTriggers = new Set(expiryState.expired_triggers ?? []);
  const activeTrigger = node.expiry_triggers.find((trigger) => expiredTriggers.has(trigger));
  return activeTrigger ? [`expiry_trigger_active:${activeTrigger}`] : [];
}

type DojoHumanNodeDecision =
  | {
      status: "approved";
      decision_key: string;
      blocked_by: [];
    }
  | {
      status: "paused" | "blocked";
      decision_key: string;
      blocked_by: string[];
    };

function humanDecisionForNode(
  node: DojoGraphNode,
  humanDecisions?: Record<string, DojoHumanDecision>
): DojoHumanNodeDecision {
  const decisionKey = stringMetadata(node, "decision_key") ?? node.node_id;
  const decision = humanDecisions?.[decisionKey];
  if (decision === "approved") {
    return { status: "approved", decision_key: decisionKey, blocked_by: [] };
  }
  if (decision === "denied") {
    return {
      status: "blocked",
      decision_key: decisionKey,
      blocked_by: [`human_decision_denied:${decisionKey}`],
    };
  }
  return {
    status: "paused",
    decision_key: decisionKey,
    blocked_by: [`human_decision_required:${decisionKey}`],
  };
}

function completedNodeIdsForResume(nodeResults: DojoGraphNodeRunResult[]): string[] {
  return nodeResults
    .filter((result) => result.status === "completed")
    .map((result) => result.node_id);
}

function retryBlockedByForNode(node: DojoGraphNode, inputs: Record<string, unknown>): string[] {
  if (node.kind !== "Retry") return [];

  const maxAttempts = integerMetadata(node, "max_attempts") ?? integerMetadata(node, "retry_limit");
  if (maxAttempts === undefined || maxAttempts < 1) return ["retry_policy_missing"];

  const attemptKey = stringMetadata(node, "attempt_key") ?? node.node_id;
  const attemptCount = retryAttemptCountForKey(inputs, attemptKey);
  return attemptCount >= maxAttempts ? [`retry_limit_exceeded:${attemptKey}`] : [];
}

function retryAttemptCountForKey(inputs: Record<string, unknown>, attemptKey: string): number {
  const retryAttempts = inputs["retry_attempts"];
  if (retryAttempts && typeof retryAttempts === "object" && !Array.isArray(retryAttempts)) {
    const value = (retryAttempts as Record<string, unknown>)[attemptKey];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  const value = inputs["retry_attempt"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function integerMetadata(node: DojoGraphNode, key: string): number | undefined {
  const value = node.metadata?.[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value;
}

function stringMetadata(node: DojoGraphNode, key: string): string | undefined {
  const value = node.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

type DojoBranchDecision =
  | {
      ok: true;
      selected_edge: DojoGraphEdge;
      skipped_nodes: Map<string, string[]>;
    }
  | {
      ok: false;
      blocked_by: string[];
    };

function decideBranch(
  node: DojoGraphNode,
  graph: DojoSkillGraph,
  inputs: Record<string, unknown>
): DojoBranchDecision {
  const outgoing = graph.edges.filter((edge) => edge.from_node_id === node.node_id);
  if (outgoing.length === 0) {
    return { ok: false, blocked_by: ["branch_edge_missing"] };
  }

  const selected = outgoing.find((edge) => edge.condition ? evaluateStaticCondition(edge.condition, inputs) : false)
    ?? outgoing.find((edge) => !edge.condition);
  if (!selected) {
    return { ok: false, blocked_by: ["branch_condition_unmatched"] };
  }

  return {
    ok: true,
    selected_edge: selected,
    skipped_nodes: skippedNodesForUnchosenBranchEdges(graph, node.node_id, selected, outgoing),
  };
}

function skippedNodesForUnchosenBranchEdges(
  graph: DojoSkillGraph,
  branchNodeId: string,
  selectedEdge: DojoGraphEdge,
  outgoing: DojoGraphEdge[]
): Map<string, string[]> {
  const adjacency = buildAdjacency(graph.edges);
  const selectedReachable = reachableNodeIds(selectedEdge.to_node_id, adjacency);
  const skipped = new Map<string, string[]>();
  for (const edge of outgoing) {
    if (edge.edge_id === selectedEdge.edge_id) continue;
    const unchosenReachable = reachableNodeIds(edge.to_node_id, adjacency);
    for (const nodeId of unchosenReachable) {
      if (nodeId === branchNodeId || selectedReachable.has(nodeId)) continue;
      const existing = skipped.get(nodeId) ?? [];
      skipped.set(nodeId, [...existing, `branch_not_selected:${branchNodeId}`]);
    }
  }
  return skipped;
}

function buildAdjacency(edges: DojoGraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = adjacency.get(edge.from_node_id) ?? [];
    adjacency.set(edge.from_node_id, [...existing, edge.to_node_id]);
  }
  return adjacency;
}

function reachableNodeIds(startNodeId: string, adjacency: Map<string, string[]>): Set<string> {
  const reachable = new Set<string>();
  const stack = [startNodeId];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      if (!reachable.has(nextNodeId)) stack.push(nextNodeId);
    }
  }
  return reachable;
}

async function proofBlockedByForNode(
  node: DojoGraphNode,
  mode: DojoGraphMode,
  graph: DojoSkillGraph,
  input: DojoSkillGraphRuntimeInput,
  inputs: Record<string, unknown>
): Promise<string[]> {
  if (!nodeRequiresProductionProofValidation(node, mode)) return [];
  if (input.allow_self_attested_proof === true && inputs["proof_capsule_valid"] === true) return [];
  if (!input.proof_capsule) return ["proof_capsule_missing"];
  if (!input.proof_validator) return ["proof_validator_missing"];
  const result = await input.proof_validator({
    graph,
    node,
    mode,
    proof_capsule: input.proof_capsule,
    inputs,
  });
  if (!result.ok) return result.blocked_by.length > 0 ? result.blocked_by : ["proof_capsule_invalid"];
  return [];
}

function nodeRequiresProductionProofValidation(node: DojoGraphNode, mode: DojoGraphMode): boolean {
  if (mode !== "production") return false;
  if (node.proof?.required !== true) return false;
  return node.kind === "Action" || node.kind === "Proof";
}

export function evaluateStaticCondition(condition: string, inputs: Record<string, unknown>): boolean {
  return evaluateDojoGuardrailPredicate(condition, inputs).ok;
}
