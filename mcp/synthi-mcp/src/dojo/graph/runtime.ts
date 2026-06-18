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
import {
  decideDojoRollbackForAssertionFailure,
  decideDojoRollbackNodeExecution,
  noRollbackRequired,
  type DojoRollbackDecision,
} from "./rollback_runtime.js";
import {
  createFakeDojoSubstrateExecutor,
  type DojoSubstrateExecutionResult,
  type DojoSubstrateExecutor,
} from "./substrate_executor.js";
import {
  createDefaultDojoGraphNodeRegistry,
  validateDojoGraphNodeRegistryForGraph,
  type DojoGraphNodeHandler,
  type DojoGraphNodeRegistry,
} from "./node_registry.js";
import { isParseableDojoGuardrailPredicate } from "./guardrail_predicates.js";
import { validateDojoTenantContext, type DojoTenantContext } from "../mcp/execution_policy_gate.js";

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
  source_binding_ids: string[];
  api_binding_ids: string[];
  rollback_status?: DojoRollbackDecision["status"];
  rollback_strategy?: DojoRollbackDecision["strategy"];
  rollback_requires_human_review?: boolean;
  rollback_checkpoints?: string[];
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
  tenant?: DojoTenantContext;
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
  preflight_only?: boolean;
  substrate_executor?: DojoSubstrateExecutor;
  node_registry?: DojoGraphNodeRegistry;
  evidence_writer?: DojoGraphEvidenceWriter;
  now?: string;
}

export class DojoSkillGraphRuntime {
  validateGraph(graph: DojoSkillGraph) {
    return validateDojoSkillGraph(graph);
  }

  async execute(input: DojoSkillGraphRuntimeInput): Promise<DojoGraphRunResult> {
    const mode = input.mode ?? input.graph.mode;
    const graph = { ...input.graph, mode };
    const runId = input.run_id ?? createGraphRunId(graph);
    if (mode === "production") {
      const tenantBlockedBy = validateDojoTenantContext(input.tenant, "graph_runtime");
      if (tenantBlockedBy.length > 0) {
        return {
          ok: false,
          status: "blocked",
          mode,
          run_id: runId,
          node_results: [],
          blocked_by: tenantBlockedBy,
          evidence_refs: [],
        };
      }
    }
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
    const nodeRegistry = input.node_registry ?? createDefaultDojoGraphNodeRegistry();
    const registryValidation = validateDojoGraphNodeRegistryForGraph(graph, nodeRegistry);
    if (!registryValidation.ok) {
      return {
        ok: false,
        status: "blocked",
        mode,
        run_id: runId,
        node_results: [],
        blocked_by: [
          ...registryValidation.missing_handlers.map((kind) => `node_handler_missing:${kind}`),
          ...registryValidation.duplicate_handlers.map((kind) => `node_handler_duplicate:${kind}`),
        ],
        evidence_refs: [],
      };
    }

    const inputs = input.inputs ?? {};
    const substrateExecutor = input.substrate_executor ?? (mode === "production" ? undefined : createFakeDojoSubstrateExecutor());
    const nodeResults: DojoGraphNodeRunResult[] = [];
    const evidenceRefs: string[] = [];
    const skippedNodes = new Map<string, string[]>();
    const resumeCompletedNodeIds = new Set(input.resume_state?.completed_node_ids ?? []);
    const executionNodes = executionNodesForGraph(graph);
    const resumeContext = resumeContextForGraph(input.resume_state, executionNodes);
    try {
      for (const node of executionNodes) {
      const handler = nodeRegistry.get(node.kind);
      if (!handler) {
        const missingHandlerResult: DojoGraphNodeRunResult = {
          node_id: node.node_id,
          kind: node.kind,
          status: "blocked",
          blocked_by: [`node_handler_missing:${node.kind}`],
          assertion_results: [],
          rollback_decision: noRollbackRequired(),
        };
        nodeResults.push(missingHandlerResult);
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, missingHandlerResult));
        return {
          ok: false,
          status: "blocked",
          mode,
          run_id: runId,
          node_results: nodeResults,
          blocked_by: missingHandlerResult.blocked_by,
          evidence_refs: evidenceRefs,
        };
      }

      if (resumeCompletedNodeIds.has(node.node_id)) {
        const resumeBlockedBy = resumeBlockedByForCompletedNode(node, handler, mode, resumeContext);
        if (resumeBlockedBy.length > 0) {
          const blockedResumeResult: DojoGraphNodeRunResult = {
            node_id: node.node_id,
            kind: node.kind,
            status: "blocked",
            blocked_by: resumeBlockedBy,
            assertion_results: [],
            rollback_decision: noRollbackRequired(),
          };
          nodeResults.push(blockedResumeResult);
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, blockedResumeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: resumeBlockedBy,
            evidence_refs: evidenceRefs,
          };
        }

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

      const blockedBy = blockedByForNode(node, handler, mode, inputs, input.expiry_state);
      const proofBlockedBy = blockedBy.length === 0
        ? await proofBlockedByForNode(node, handler, mode, graph, input, inputs)
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

      if (input.preflight_only === true && handler.preflight_skips_execution) {
        const preflightResult: DojoGraphNodeRunResult = {
          ...result,
          status: "skipped",
          control_flow: { skipped_by: ["graph_preflight_only"] },
        };
        nodeResults[nodeResults.length - 1] = preflightResult;
        evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, preflightResult));
        continue;
      }

      if (handler.requires_human_decision) {
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

      if (handler.executes_rollback) {
        const rollbackDecision = decideDojoRollbackNodeExecution(node);
        const rollbackBlockedBy = rollbackDecision.status === "rollback_available"
          ? []
          : rollbackDecision.blocked_by.length > 0
            ? rollbackDecision.blocked_by
            : [`rollback_unavailable:${rollbackDecision.strategy}`];
        const rollbackNodeResult: DojoGraphNodeRunResult = {
          ...result,
          status: rollbackBlockedBy.length > 0 ? "blocked" : "completed",
          blocked_by: rollbackBlockedBy,
          rollback_decision: rollbackDecision,
        };
        nodeResults[nodeResults.length - 1] = rollbackNodeResult;
        if (rollbackBlockedBy.length > 0) {
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, rollbackNodeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: rollbackBlockedBy,
            evidence_refs: evidenceRefs,
          };
        }
      }

      if (handler.executes_substrate) {
        const actionSubstrateExecutor = substrateExecutor;
        const actionPreflightBlockedBy = productionActionEvidenceBlockedBy(node, mode, input);
        if (actionPreflightBlockedBy.length > 0) {
          const substrateNodeResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: actionPreflightBlockedBy,
          };
          nodeResults[nodeResults.length - 1] = substrateNodeResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, substrateNodeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: actionPreflightBlockedBy,
            evidence_refs: evidenceRefs,
          };
        }
        if (!actionSubstrateExecutor) {
          const substrateNodeResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: ["substrate_executor_required"],
          };
          nodeResults[nodeResults.length - 1] = substrateNodeResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, substrateNodeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: ["substrate_executor_required"],
            evidence_refs: evidenceRefs,
          };
        }
        let substrateResult: DojoSubstrateExecutionResult;
        try {
          substrateResult = await actionSubstrateExecutor.execute({ node, mode, inputs, proof_capsule: input.proof_capsule });
        } catch {
          const substrateNodeResult: DojoGraphNodeRunResult = {
            ...result,
            status: "blocked",
            blocked_by: ["substrate_executor_failed"],
          };
          nodeResults[nodeResults.length - 1] = substrateNodeResult;
          evidenceRefs.push(await emitGraphNodeEvidence(input, graph, runId, node, substrateNodeResult));
          return {
            ok: false,
            status: "blocked",
            mode,
            run_id: runId,
            node_results: nodeResults,
            blocked_by: ["substrate_executor_failed"],
            evidence_refs: evidenceRefs,
          };
        }
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

      if (handler.evaluates_branch) {
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

      const assertionContext = assertionContextForNode(inputs, nodeResults[nodeResults.length - 1]);
      const assertionResults = [
        ...evaluateDojoGraphAssertions(node.assertions, assertionContext),
        ...evaluateDojoGraphPostconditions(node.postconditions, assertionContext),
      ];
      const assertionBlockedBy = assertionResults.flatMap((assertion) => assertion.blocked_by);
      if (assertionBlockedBy.length > 0) {
        const rollbackDecision = decideDojoRollbackForAssertionFailure(node);
        const blockedWithRollback = [...assertionBlockedBy, ...rollbackDecision.blocked_by];
        const previousNodeResult = nodeResults[nodeResults.length - 1];
        const assertionResult: DojoGraphNodeRunResult = {
          ...(previousNodeResult ?? {}),
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
    } catch (error) {
      if (error instanceof DojoGraphEvidenceWriteError) {
        return blockedByEvidenceWriteFailure(error, mode, runId, nodeResults, evidenceRefs);
      }
      throw error;
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

class DojoGraphEvidenceWriteError extends Error {
  readonly node_id: string;
  readonly blocked_by: string[];

  constructor(nodeId: string, blockedBy: string[]) {
    super(`dojo_graph_evidence_write_failed:${nodeId}`);
    this.node_id = nodeId;
    this.blocked_by = blockedBy;
  }
}

function blockedByEvidenceWriteFailure(
  error: DojoGraphEvidenceWriteError,
  mode: DojoGraphMode,
  runId: string,
  nodeResults: DojoGraphNodeRunResult[],
  evidenceRefs: string[]
): DojoGraphRunResult {
  for (let index = nodeResults.length - 1; index >= 0; index -= 1) {
    const result = nodeResults[index];
    if (!result || result.node_id !== error.node_id) continue;
    nodeResults[index] = {
      ...result,
      status: "blocked",
      blocked_by: [...new Set([...result.blocked_by, ...error.blocked_by])],
    };
    break;
  }
  return {
    ok: false,
    status: "blocked",
    mode,
    run_id: runId,
    node_results: nodeResults,
    blocked_by: error.blocked_by,
    evidence_refs: evidenceRefs,
  };
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

interface DojoGraphResumeContext {
  paused_node_id?: string;
  paused_node_known: boolean;
  paused_node_index?: number;
  execution_index_by_node_id: Map<string, number>;
}

function resumeContextForGraph(
  resumeState: DojoGraphResumeState | undefined,
  executionNodes: DojoGraphNode[]
): DojoGraphResumeContext {
  const executionIndexByNodeId = new Map(executionNodes.map((node, index) => [node.node_id, index]));
  const pausedNodeId = resumeState?.paused_node_id;
  const pausedNodeIndex = pausedNodeId ? executionIndexByNodeId.get(pausedNodeId) : undefined;
  return {
    paused_node_id: pausedNodeId,
    paused_node_known: pausedNodeId ? pausedNodeIndex !== undefined : false,
    paused_node_index: pausedNodeIndex,
    execution_index_by_node_id: executionIndexByNodeId,
  };
}

function resumeBlockedByForCompletedNode(
  node: DojoGraphNode,
  handler: DojoGraphNodeHandler,
  mode: DojoGraphMode,
  resumeContext: DojoGraphResumeContext
): string[] {
  if (mode !== "production") return [];

  const blockedBy: string[] = [];
  if (!resumeContext.paused_node_id || !resumeContext.paused_node_known) {
    blockedBy.push("resume_paused_node_unknown");
  } else {
    const nodeIndex = resumeContext.execution_index_by_node_id.get(node.node_id);
    if (nodeIndex === undefined || resumeContext.paused_node_index === undefined || nodeIndex >= resumeContext.paused_node_index) {
      blockedBy.push(`resume_completed_node_not_before_pause:${node.node_id}`);
    }
  }

  if (nodeHasResumeSensitiveObligations(node, handler)) {
    blockedBy.push(`resume_completed_node_untrusted:${node.node_id}`);
  }

  return uniqueStrings(blockedBy);
}

function nodeHasResumeSensitiveObligations(node: DojoGraphNode, handler: DojoGraphNodeHandler): boolean {
  return handler.executes_substrate
    || handler.validates_proof_in_production
    || handler.requires_human_decision
    || handler.executes_rollback
    || handler.evaluates_branch
    || handler.evaluates_retry_policy
    || handler.evaluates_case_law_binding
    || node.proof?.required === true
    || node.guardrails.length > 0
    || node.assertions.length > 0
    || node.postconditions.length > 0
    || node.evidence_policy.length > 0
    || node.case_law_refs.length > 0
    || node.expiry_triggers.length > 0;
}

function assertionContextForNode(
  inputs: Record<string, unknown>,
  nodeResult: DojoGraphNodeRunResult | undefined
): Record<string, unknown> {
  const flattenedAssertionResults = isRecord(inputs["assertion_results"])
    ? { ...(inputs["assertion_results"] as Record<string, unknown>) }
    : {};
  if (!nodeResult?.substrate_result) return { ...inputs, ...flattenedAssertionResults };
  const substrateResult = nodeResult.substrate_result;
  const apiExecution = substrateResult.api_tool_execution;
  const apiResponse = apiExecution?.response
    ? {
        status: apiExecution.response.status,
        headers: { ...(apiExecution.response.headers ?? {}) },
        body: apiExecution.response.body,
      }
    : undefined;
  return {
    ...inputs,
    ...flattenedAssertionResults,
    substrate_executed: substrateResult.ok,
    substrate_status: substrateResult.status,
    substrate: substrateResult.substrate,
    substrate_evidence_refs: [...substrateResult.evidence_refs],
    ...(apiExecution ? {
      api_tool_executed: apiExecution.ok,
      api_tool_status: apiExecution.status,
      api_tool_blocked_by: [...apiExecution.blocked_by],
      api_postcondition_ok: apiExecution.postcondition?.ok,
      api_response: apiResponse,
    } : {}),
  };
}

function evaluateDojoGraphPostconditions(
  postconditions: string[],
  context: Record<string, unknown>
): DojoAssertionRuntimeResult[] {
  return postconditions.map((postcondition) => evaluateDojoGraphPostcondition(postcondition, context));
}

function evaluateDojoGraphPostcondition(
  postcondition: string,
  context: Record<string, unknown>
): DojoAssertionRuntimeResult {
  const normalized = postcondition.trim();
  const assertionId = `postcondition:${normalized || "(empty)"}`;
  if (!normalized || !isParseableDojoGuardrailPredicate(normalized)) {
    return {
      assertion_id: assertionId,
      required: false,
      status: "skipped",
      ok: true,
      blocked_by: [],
    };
  }

  const result = evaluateDojoGuardrailPredicate(normalized, context);
  if (result.ok) {
    return {
      assertion_id: assertionId,
      required: true,
      status: "passed",
      ok: true,
      blocked_by: [],
      observed: postconditionObservation(result),
    };
  }

  return {
    assertion_id: assertionId,
    required: true,
    status: "failed",
    ok: false,
    blocked_by: [`postcondition_failed:${normalized}`],
    observed: postconditionObservation(result),
  };
}

function postconditionObservation(result: ReturnType<typeof evaluateDojoGuardrailPredicate>): Record<string, unknown> {
  return {
    predicate: result.predicate,
    ...(result.operator ? { operator: result.operator } : {}),
    ...(result.actual !== undefined ? { actual: result.actual } : {}),
    ...(result.expected !== undefined ? { expected: result.expected } : {}),
    ...(result.blocked_by.length > 0 ? { blocked_by: [...result.blocked_by] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function emitGraphNodeEvidence(
  input: DojoSkillGraphRuntimeInput,
  graph: DojoSkillGraph,
  runId: string,
  node: DojoGraphNode,
  result: DojoGraphNodeRunResult
): Promise<string> {
  const fallbackRef = `dojo-graph://${runId}/${node.node_id}`;
  const mode = input.mode ?? graph.mode;
  try {
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
      case_law_refs: requiredCaseLawRefsForNode(node),
      source_binding_ids: (node.source_bindings ?? []).map((binding) => binding.binding_id),
      api_binding_ids: (node.api_bindings ?? []).map((binding) => binding.binding_id),
      rollback_status: result.rollback_decision.status,
      rollback_strategy: result.rollback_decision.strategy,
      rollback_requires_human_review: result.rollback_decision.requires_human_review,
      rollback_checkpoints: [...result.rollback_decision.checkpoints],
      assertion_ids: result.assertion_results.map((assertion) => assertion.assertion_id),
      ...(result.substrate_result ? { substrate_status: result.substrate_result.status } : {}),
      ...(result.substrate_result?.substrate ? { substrate: result.substrate_result.substrate } : {}),
      substrate_evidence_refs: [...(result.substrate_result?.evidence_refs ?? [])],
      created_at: input.now ?? new Date().toISOString(),
    });
    const normalizedRef = typeof emittedRef === "string" ? emittedRef.trim() : "";
    if (productionActionRequiresLedgerBackedEvidence(node, mode, result)) {
      if (!normalizedRef) {
        throw new DojoGraphEvidenceWriteError(node.node_id, ["graph_evidence_record_missing"]);
      }
      if (!isLedgerBackedGraphEvidenceRef(normalizedRef)) {
        throw new DojoGraphEvidenceWriteError(node.node_id, ["graph_evidence_record_unbacked"]);
      }
    }
    return normalizedRef || fallbackRef;
  } catch (error) {
    if (error instanceof DojoGraphEvidenceWriteError) throw error;
    throw new DojoGraphEvidenceWriteError(node.node_id, ["graph_evidence_write_failed"]);
  }
}

function productionActionRequiresLedgerBackedEvidence(
  node: DojoGraphNode,
  mode: DojoGraphMode,
  result: DojoGraphNodeRunResult
): boolean {
  return mode === "production" && node.kind === "Action" && node.evidence_policy.length > 0 && result.status === "completed";
}

function isLedgerBackedGraphEvidenceRef(ref: string): boolean {
  return ref.startsWith("evidence:") || ref.startsWith("ledger://");
}

function createGraphRunId(graph: DojoSkillGraph): string {
  return `dojo_run_${graph.skill_id}_${randomUUID()}`;
}

function blockedByForNode(
  node: DojoGraphNode,
  handler: DojoGraphNodeHandler,
  mode: DojoGraphMode,
  inputs: Record<string, unknown>,
  expiryState?: DojoGraphExpiryState
): string[] {
  const expiryBlockedBy = expiryBlockedByForNode(node, expiryState);
  if (expiryBlockedBy.length > 0) return expiryBlockedBy;

  const retryBlockedBy = handler.evaluates_retry_policy ? retryBlockedByForNode(node, inputs) : [];
  if (retryBlockedBy.length > 0) return retryBlockedBy;

  const caseLawBlockedBy = handler.evaluates_case_law_binding ? caseLawBlockedByForNode(node, inputs) : [];
  if (caseLawBlockedBy.length > 0) return caseLawBlockedBy;

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

function productionActionEvidenceBlockedBy(
  node: DojoGraphNode,
  mode: DojoGraphMode,
  input: DojoSkillGraphRuntimeInput
): string[] {
  if (mode !== "production" || node.kind !== "Action") return [];
  if (node.evidence_policy.length === 0) return [];
  return input.evidence_writer ? [] : ["graph_evidence_writer_required"];
}

function caseLawBlockedByForNode(node: DojoGraphNode, inputs: Record<string, unknown>): string[] {
  if (node.kind !== "CaseLaw") return [];

  const requiredCaseIds = requiredCaseLawRefsForNode(node);
  if (requiredCaseIds.length === 0) return ["case_law_refs_missing"];

  const bindings = parseCaseLawBindingState(inputs["case_law_bindings"]);
  if (!bindings) return ["case_law_binding_state_missing"];

  const blockedBy: string[] = [];
  for (const caseId of requiredCaseIds) {
    if (!bindings.has(caseId)) {
      blockedBy.push(`case_law_binding_missing:${caseId}`);
      continue;
    }
    if (bindings.get(caseId) !== true) {
      blockedBy.push(`case_law_not_binding:${caseId}`);
    }
  }
  return blockedBy;
}

function requiredCaseLawRefsForNode(node: DojoGraphNode): string[] {
  return uniqueStrings([
    ...node.case_law_refs,
    ...stringArrayMetadata(node, "required_case_law_refs"),
  ]);
}

function parseCaseLawBindingState(value: unknown): Map<string, boolean> | null {
  if (Array.isArray(value)) {
    const activeIds = uniqueStrings(value.filter((item): item is string => typeof item === "string"));
    if (activeIds.length === 0) return null;
    return new Map(activeIds.map((caseId) => [caseId, true]));
  }
  if (!value || typeof value !== "object") return null;
  const bindings = new Map<string, boolean>();
  for (const [rawCaseId, rawStatus] of Object.entries(value as Record<string, unknown>)) {
    const caseId = rawCaseId.trim();
    if (!caseId) continue;
    bindings.set(caseId, isActiveCaseLawBindingStatus(rawStatus));
  }
  return bindings.size > 0 ? bindings : null;
}

function isActiveCaseLawBindingStatus(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["active", "approved", "binding", "bound"].includes(value.trim().toLowerCase());
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

function stringArrayMetadata(node: DojoGraphNode, key: string): string[] {
  const value = node.metadata?.[key];
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === "string")) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
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
  handler: DojoGraphNodeHandler,
  mode: DojoGraphMode,
  graph: DojoSkillGraph,
  input: DojoSkillGraphRuntimeInput,
  inputs: Record<string, unknown>
): Promise<string[]> {
  if (!nodeRequiresProductionProofValidation(node, handler, mode)) return [];
  if (input.allow_self_attested_proof === true && inputs["proof_capsule_valid"] === true) {
    return ["proof_self_attestation_not_allowed_in_production"];
  }
  if (!input.proof_capsule) return ["proof_capsule_missing"];
  if (!input.proof_validator) return ["proof_validator_missing"];
  let result: DojoGraphProofValidationResult;
  try {
    result = await input.proof_validator({
      graph,
      node,
      mode,
      proof_capsule: input.proof_capsule,
      inputs,
    });
  } catch {
    return ["proof_validator_failed"];
  }
  if (!result.ok) return result.blocked_by.length > 0 ? result.blocked_by : ["proof_capsule_invalid"];
  return [];
}

function nodeRequiresProductionProofValidation(
  node: DojoGraphNode,
  handler: DojoGraphNodeHandler,
  mode: DojoGraphMode
): boolean {
  if (mode !== "production") return false;
  if (node.proof?.required !== true) return false;
  return handler.validates_proof_in_production;
}

export function evaluateStaticCondition(condition: string, inputs: Record<string, unknown>): boolean {
  return evaluateDojoGuardrailPredicate(condition, inputs).ok;
}
