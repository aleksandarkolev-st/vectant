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

export type DojoGraphNodeRunStatus = "completed" | "blocked" | "skipped";
export type DojoGraphRunStatus = "completed" | "blocked" | "failed";

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
  node_results: DojoGraphNodeRunResult[];
  blocked_by: string[];
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

export interface DojoSkillGraphRuntimeInput {
  graph: DojoSkillGraph;
  mode?: DojoGraphMode;
  inputs?: Record<string, unknown>;
  expiry_state?: DojoGraphExpiryState;
  proof_capsule?: unknown;
  proof_validator?: DojoGraphProofValidator;
  allow_self_attested_proof?: boolean;
  substrate_executor?: DojoSubstrateExecutor;
}

export class DojoSkillGraphRuntime {
  validateGraph(graph: DojoSkillGraph) {
    return validateDojoSkillGraph(graph);
  }

  async execute(input: DojoSkillGraphRuntimeInput): Promise<DojoGraphRunResult> {
    const mode = input.mode ?? input.graph.mode;
    const graph = { ...input.graph, mode };
    const validation = validateDojoSkillGraph(graph);
    if (!validation.ok) {
      return {
        ok: false,
        status: "blocked",
        mode,
        node_results: [],
        blocked_by: validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.issue_id),
      };
    }

    const inputs = input.inputs ?? {};
    const substrateExecutor = input.substrate_executor ?? createFakeDojoSubstrateExecutor();
    const nodeResults: DojoGraphNodeRunResult[] = [];
    const skippedNodes = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const skippedBy = skippedNodes.get(node.node_id);
      if (skippedBy) {
        nodeResults.push({
          node_id: node.node_id,
          kind: node.kind,
          status: "skipped",
          blocked_by: [],
          assertion_results: [],
          rollback_decision: noRollbackRequired(),
          control_flow: { skipped_by: skippedBy },
        });
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
        return {
          ok: false,
          status: "blocked",
          mode,
          node_results: nodeResults,
          blocked_by: blockedBy,
        };
      }

      if (node.kind === "Action") {
        const substrateResult = await substrateExecutor.execute({ node, inputs });
        if (!substrateResult.ok) {
          const substrateNodeResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: substrateResult.blocked_by,
            substrate_result: substrateResult,
          };
          nodeResults[nodeResults.length - 1] = substrateNodeResult;
          return {
            ok: false,
            status: "blocked",
            mode,
            node_results: nodeResults,
            blocked_by: substrateResult.blocked_by,
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
          return {
            ok: false,
            status: "blocked",
            mode,
            node_results: nodeResults,
            blocked_by: branchDecision.blocked_by,
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
        return {
          ok: false,
          status: "blocked",
          mode,
          node_results: nodeResults,
          blocked_by: blockedWithRollback,
        };
      }

      nodeResults[nodeResults.length - 1] = {
        ...nodeResults[nodeResults.length - 1]!,
        assertion_results: assertionResults,
      };
    }

    return {
      ok: true,
      status: "completed",
      mode,
      node_results: nodeResults,
      blocked_by: [],
    };
  }
}

function blockedByForNode(
  node: DojoGraphNode,
  mode: DojoGraphMode,
  inputs: Record<string, unknown>,
  expiryState?: DojoGraphExpiryState
): string[] {
  const expiryBlockedBy = expiryBlockedByForNode(node, expiryState);
  if (expiryBlockedBy.length > 0) return expiryBlockedBy;

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
  if (mode !== "production" || node.kind !== "Action" || node.proof?.required !== true) return [];
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

export function evaluateStaticCondition(condition: string, inputs: Record<string, unknown>): boolean {
  const match = condition.match(/^([a-zA-Z0-9_.-]+)\s*==\s*(true|false|[-]?\d+(?:\.\d+)?|".*"|'.*'|[a-zA-Z0-9_.:-]+)$/);
  if (!match) return false;
  const [, key, rawExpected] = match;
  if (!key || rawExpected === undefined) return false;
  const actual = inputs[key];
  const expected = parseExpectedValue(rawExpected);
  return actual === expected;
}

function parseExpectedValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}
