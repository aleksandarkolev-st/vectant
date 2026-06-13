import { isParseableDojoGuardrailPredicate } from "./guardrail_predicates.js";

export type DojoGraphNodeKind =
  | "Trigger"
  | "Input"
  | "Observe"
  | "Locate"
  | "Action"
  | "Assertion"
  | "Branch"
  | "Permission"
  | "Guardrail"
  | "Retry"
  | "Artifact"
  | "Subskill"
  | "Human"
  | "Rollback"
  | "Memory"
  | "Adversary"
  | "Checkride"
  | "Proof"
  | "CaseLaw"
  | "Expiry";

export type DojoGraphNodeRisk = "safe" | "mutation" | "dangerous";
export type DojoGraphMode = "practice" | "checkride" | "shadow" | "production";

export interface DojoGraphGuardrailRequirement {
  guardrail_id: string;
  predicate: string;
  severity: "info" | "warn" | "block";
}

export interface DojoGraphProofRequirement {
  required: boolean;
  required_claims: string[];
  required_guardrails: string[];
}

export interface DojoGraphAssertionRequirement {
  assertion_id: string;
  description: string;
  required: boolean;
}

export interface DojoGraphSourceBinding {
  binding_id: string;
  anchor_id: string;
  kind: "source";
  label: string;
  source_step_id?: string;
  source_id?: string;
  file_path?: string;
  line?: number;
}

export interface DojoGraphApiBinding {
  binding_id: string;
  anchor_id: string;
  kind: "api";
  label: string;
  source_step_id?: string;
  api_candidate_id?: string;
  method?: string;
  path?: string;
  proof_claim_mapping?: Record<string, string>;
}

export interface DojoGraphNode {
  node_id: string;
  kind: DojoGraphNodeKind;
  label: string;
  risk: DojoGraphNodeRisk;
  action?: string;
  preconditions: string[];
  postconditions: string[];
  guardrails: DojoGraphGuardrailRequirement[];
  proof?: DojoGraphProofRequirement;
  assertions: DojoGraphAssertionRequirement[];
  substrate_options: string[];
  evidence_policy: string[];
  case_law_refs: string[];
  expiry_triggers: string[];
  source_bindings?: DojoGraphSourceBinding[];
  api_bindings?: DojoGraphApiBinding[];
  metadata?: Record<string, unknown>;
}

export interface DojoGraphEdge {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  condition?: string;
  confidence: number;
  observed_variants: string[];
}

export interface DojoSkillGraph {
  schema_version: "synthi.dojo.skillGraph.v1";
  graph_id: string;
  skill_id: string;
  skill_version: string;
  graph_version: string;
  mode: DojoGraphMode;
  nodes: DojoGraphNode[];
  edges: DojoGraphEdge[];
  created_at: string;
}

export interface DojoGraphValidationIssue {
  issue_id: string;
  severity: "error" | "warning";
  node_id?: string;
  edge_id?: string;
  message: string;
}

export interface DojoGraphValidation {
  ok: boolean;
  issues: DojoGraphValidationIssue[];
}

export function validateDojoSkillGraph(graph: DojoSkillGraph): DojoGraphValidation {
  const issues: DojoGraphValidationIssue[] = [];
  const nodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (!node.node_id.trim()) {
      issues.push(errorIssue("node_id_required", "Graph node is missing node_id."));
      continue;
    }
    if (nodeIds.has(node.node_id)) {
      issues.push(errorIssue("duplicate_node_id", `Duplicate graph node id: ${node.node_id}.`, node.node_id));
    }
    nodeIds.add(node.node_id);
    if (!node.label.trim()) {
      issues.push(errorIssue("node_label_required", `Graph node ${node.node_id} is missing label.`, node.node_id));
    }
    if (node.kind === "Action" && node.risk === "dangerous" && node.guardrails.length === 0) {
      issues.push(errorIssue("dangerous_action_guardrail_required", "Dangerous action nodes require at least one guardrail.", node.node_id));
    }
    if (node.kind === "Action" && node.risk !== "safe" && node.assertions.length === 0) {
      issues.push(errorIssue("mutation_assertion_required", "Mutation action nodes require at least one assertion.", node.node_id));
    }
    if (graph.mode === "production" && node.kind === "Action" && node.proof?.required !== true) {
      issues.push(errorIssue("production_action_proof_required", "Production action nodes require an explicit proof requirement.", node.node_id));
    }
    if (graph.mode === "production" && (node.kind === "Action" || node.kind === "Proof") && node.proof?.required === true) {
      if (node.proof.required_claims.length === 0) {
        issues.push(errorIssue("production_proof_claims_required", "Production proof requirements must include at least one required claim.", node.node_id));
      }
    }
    if (graph.mode === "production" && node.kind === "Action" && node.risk === "dangerous" && node.proof?.required === true) {
      const blockingGuardrailIds = new Set(
        node.guardrails
          .filter((guardrail) => guardrail.severity === "block")
          .map((guardrail) => guardrail.guardrail_id)
      );
      if (node.proof.required_guardrails.length === 0) {
        issues.push(errorIssue(
          "production_action_proof_guardrails_required",
          "Dangerous production action proof must require the blocking guardrails that protect the action.",
          node.node_id
        ));
      }
      for (const guardrailId of node.proof.required_guardrails) {
        if (!blockingGuardrailIds.has(guardrailId)) {
          issues.push(errorIssue(
            "production_action_proof_guardrail_not_bound",
            `Production proof requires guardrail ${guardrailId}, but it is not a blocking guardrail on node ${node.node_id}.`,
            node.node_id
          ));
        }
      }
    }
    for (const binding of node.source_bindings ?? []) {
      if (!binding.binding_id.trim()) {
        issues.push(errorIssue("source_binding_id_required", `Source binding on node ${node.node_id} is missing binding_id.`, node.node_id));
      }
      if (!binding.anchor_id.trim()) {
        issues.push(errorIssue("source_binding_anchor_required", `Source binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} is missing anchor_id.`, node.node_id));
      }
      if (binding.kind !== "source") {
        issues.push(errorIssue("source_binding_kind_invalid", `Source binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} must have kind source.`, node.node_id));
      }
      if (!binding.label.trim()) {
        issues.push(errorIssue("source_binding_label_required", `Source binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} is missing label.`, node.node_id));
      }
    }
    for (const binding of node.api_bindings ?? []) {
      if (!binding.binding_id.trim()) {
        issues.push(errorIssue("api_binding_id_required", `API binding on node ${node.node_id} is missing binding_id.`, node.node_id));
      }
      if (!binding.anchor_id.trim()) {
        issues.push(errorIssue("api_binding_anchor_required", `API binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} is missing anchor_id.`, node.node_id));
      }
      if (binding.kind !== "api") {
        issues.push(errorIssue("api_binding_kind_invalid", `API binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} must have kind api.`, node.node_id));
      }
      if (!binding.label.trim()) {
        issues.push(errorIssue("api_binding_label_required", `API binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} is missing label.`, node.node_id));
      }
      if (binding.proof_claim_mapping !== undefined) {
        for (const [claimId, evidenceRef] of Object.entries(binding.proof_claim_mapping)) {
          if (!claimId.trim() || !evidenceRef.trim()) {
            issues.push(errorIssue("api_binding_proof_mapping_invalid", `API binding ${binding.binding_id || "(unknown)"} on node ${node.node_id} has an invalid proof claim mapping.`, node.node_id));
          }
        }
      }
    }
    for (const precondition of node.preconditions) {
      if (!isParseableDojoGuardrailPredicate(precondition)) {
        issues.push(errorIssue(
          "node_precondition_parseable_required",
          `Precondition on node ${node.node_id} must use an executable predicate.`,
          node.node_id
        ));
      }
    }
    for (const guardrail of node.guardrails) {
      if (!isParseableDojoGuardrailPredicate(guardrail.predicate)) {
        issues.push(errorIssue(
          "guardrail_predicate_parseable_required",
          `Guardrail ${guardrail.guardrail_id} on node ${node.node_id} must use an executable predicate.`,
          node.node_id
        ));
      }
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from_node_id)) {
      issues.push(errorIssue("edge_from_node_missing", `Edge references missing from_node_id: ${edge.from_node_id}.`, undefined, edge.edge_id));
    }
    if (!nodeIds.has(edge.to_node_id)) {
      issues.push(errorIssue("edge_to_node_missing", `Edge references missing to_node_id: ${edge.to_node_id}.`, undefined, edge.edge_id));
    }
    if (edge.confidence < 0 || edge.confidence > 1) {
      issues.push(errorIssue("edge_confidence_invalid", "Edge confidence must be between 0 and 1.", undefined, edge.edge_id));
    }
    if (edge.condition && !isParseableDojoGuardrailPredicate(edge.condition)) {
      issues.push(errorIssue(
        "edge_condition_parseable_required",
        `Edge ${edge.edge_id} condition must use an executable predicate.`,
        undefined,
        edge.edge_id
      ));
    }
  }

  for (const unreachableNodeId of unreachableNodeIds(graph, nodeIds)) {
    issues.push(errorIssue(
      "graph_node_unreachable",
      `Graph node ${unreachableNodeId} is not reachable from an execution root.`,
      unreachableNodeId
    ));
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function unreachableNodeIds(graph: DojoSkillGraph, nodeIds: Set<string>): string[] {
  if (graph.nodes.length === 0) return [];
  const incomingNodeIds = new Set(
    graph.edges
      .map((edge) => edge.to_node_id)
      .filter((nodeId) => nodeIds.has(nodeId))
  );
  const triggerNodeIds = graph.nodes
    .filter((node) => node.kind === "Trigger")
    .map((node) => node.node_id);
  const rootNodeIds = triggerNodeIds.length > 0
    ? triggerNodeIds
    : graph.nodes.filter((node) => !incomingNodeIds.has(node.node_id)).map((node) => node.node_id);
  const fallbackRootNodeId = graph.nodes[0]?.node_id;
  const queue = rootNodeIds.length > 0
    ? [...rootNodeIds]
    : fallbackRootNodeId
      ? [fallbackRootNodeId]
      : [];
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId) || !nodeIds.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of graph.edges) {
      if (edge.from_node_id === nodeId && nodeIds.has(edge.to_node_id) && !reachable.has(edge.to_node_id)) {
        queue.push(edge.to_node_id);
      }
    }
  }
  return graph.nodes
    .map((node) => node.node_id)
    .filter((nodeId) => !reachable.has(nodeId))
    .sort();
}

function errorIssue(
  issueId: string,
  message: string,
  nodeId?: string,
  edgeId?: string
): DojoGraphValidationIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(nodeId ? { node_id: nodeId } : {}),
    ...(edgeId ? { edge_id: edgeId } : {}),
    message,
  };
}
