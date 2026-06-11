import { type DojoGraphNode, type DojoGraphMode, type DojoSkillGraph, validateDojoSkillGraph } from "./types.js";
import { evaluateDojoGuardrailPredicate } from "./guardrail_runtime.js";
import { evaluateDojoGraphAssertions, type DojoAssertionRuntimeResult } from "./assertion_runtime.js";
import { decideDojoRollbackForAssertionFailure, noRollbackRequired, type DojoRollbackDecision } from "./rollback_runtime.js";

export type DojoGraphNodeRunStatus = "completed" | "blocked" | "skipped";
export type DojoGraphRunStatus = "completed" | "blocked" | "failed";

export interface DojoGraphNodeRunResult {
  node_id: string;
  kind: DojoGraphNode["kind"];
  status: DojoGraphNodeRunStatus;
  blocked_by: string[];
  assertion_results: DojoAssertionRuntimeResult[];
  rollback_decision: DojoRollbackDecision;
}

export interface DojoGraphRunResult {
  ok: boolean;
  status: DojoGraphRunStatus;
  mode: DojoGraphMode;
  node_results: DojoGraphNodeRunResult[];
  blocked_by: string[];
}

export interface DojoSkillGraphRuntimeInput {
  graph: DojoSkillGraph;
  mode?: DojoGraphMode;
  inputs?: Record<string, unknown>;
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
    const nodeResults: DojoGraphNodeRunResult[] = [];
    for (const node of graph.nodes) {
      const blockedBy = blockedByForNode(node, mode, inputs);
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
        ...result,
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

function blockedByForNode(node: DojoGraphNode, mode: DojoGraphMode, inputs: Record<string, unknown>): string[] {
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
  if (mode === "production" && node.kind === "Action" && node.proof?.required === true && inputs["proof_capsule_valid"] !== true) {
    blockedBy.push("proof_capsule_missing");
  }
  return blockedBy;
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
