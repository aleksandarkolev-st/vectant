import type { DojoAssertion, DojoGuardrail, DojoSkill, DojoSourceAnchor } from "../../browser/dojo.js";
import type { WorkflowContractV7, WorkflowStepContractV7 } from "../../browser/workflow.js";
import {
  type DojoGraphEdge,
  type DojoGraphApiBinding,
  type DojoGraphNode,
  type DojoGraphNodeRisk,
  type DojoGraphSourceBinding,
  type DojoSkillGraph,
  validateDojoSkillGraph,
} from "./types.js";
import { normalizeDojoGuardrailPredicate } from "./guardrail_predicates.js";

export interface DojoGraphCompileResult {
  graph: DojoSkillGraph;
  validation: ReturnType<typeof validateDojoSkillGraph>;
}

export function compileDojoSkillGraphForSkill(
  skill: DojoSkill,
  input: {
    mode?: DojoSkillGraph["mode"];
    graph_version?: string;
    created_at?: string;
  } = {}
): DojoGraphCompileResult {
  const mode = input.mode ?? "production";
  const graph: DojoSkillGraph = {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: `graph_${skill.skill_id}_${skill.skill_version}`,
    skill_id: skill.skill_id,
    skill_version: skill.skill_version,
    graph_version: input.graph_version ?? `graph_${skill.skill_version}`,
    mode,
    created_at: input.created_at ?? skill.generated_at,
    nodes: [
      triggerNode(),
      inputNode(skill),
      permissionNode(skill),
      ...skill.guardrails.map(guardrailNode),
      proofNode(skill),
      actionNode(skill),
      assertionNode(skill.skill_seed.candidate_success_assertions),
    ],
    edges: graphEdges(skill),
  };
  return { graph, validation: validateDojoSkillGraph(graph) };
}

export function compileDojoSkillGraphFromContract(
  contract: WorkflowContractV7,
  skill: DojoSkill,
  input: {
    mode?: DojoSkillGraph["mode"];
    graph_version?: string;
    created_at?: string;
  } = {}
): DojoGraphCompileResult {
  const skillForContract = {
    ...skill,
    workflow_id: contract.workflowId,
  };
  if (contract.steps.length === 0) {
    return compileDojoSkillGraphForSkill(skillForContract, input);
  }
  const mode = input.mode ?? "production";
  const actionNodes = actionNodesForContractSteps(contract, skillForContract);
  const graph: DojoSkillGraph = {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: `graph_${skillForContract.skill_id}_${skillForContract.skill_version}`,
    skill_id: skillForContract.skill_id,
    skill_version: skillForContract.skill_version,
    graph_version: input.graph_version ?? `graph_${skillForContract.skill_version}`,
    mode,
    created_at: input.created_at ?? skillForContract.generated_at,
    nodes: [
      triggerNode(),
      inputNode(skillForContract),
      permissionNode(skillForContract),
      ...skillForContract.guardrails.map(guardrailNode),
      proofNode(skillForContract),
      ...actionNodes,
      assertionNode(skillForContract.skill_seed.candidate_success_assertions),
    ],
    edges: graphEdgesForActionSequence(skillForContract, actionNodes.map((node) => node.node_id)),
  };
  return { graph, validation: validateDojoSkillGraph(graph) };
}

function triggerNode(): DojoGraphNode {
  return baseNode("trigger", "Trigger", "MCP skill invocation", "safe");
}

function inputNode(skill: DojoSkill): DojoGraphNode {
  return {
    ...baseNode("input", "Input", "Validate input schema", "safe"),
    postconditions: skill.skill_seed.input_schema.map((field) => `${field.name}_accepted`),
    metadata: { input_schema: skill.skill_seed.input_schema },
  };
}

function permissionNode(skill: DojoSkill): DojoGraphNode {
  return {
    ...baseNode("permission", "Permission", `Entrustment ${skill.permission_license.entrustment_level}`, "safe"),
    preconditions: [`entrustment_level == ${skill.permission_license.entrustment_level}`],
    evidence_policy: ["license_scope_checked"],
    metadata: { license_id: skill.permission_license.license_id },
  };
}

function guardrailNode(guardrail: DojoGuardrail): DojoGraphNode {
  const normalized = normalizeDojoGuardrailPredicate({
    rule: guardrail.rule,
    title: guardrail.title,
    guardrail_id: guardrail.guardrail_id,
  });
  const predicate = preActionRuntimePredicateForGuardrail(normalized.predicate);
  return {
    ...baseNode(guardrail.guardrail_id, "Guardrail", guardrail.title, "safe"),
    guardrails: [{
      guardrail_id: guardrail.guardrail_id,
      predicate,
      severity: "block",
    }],
    case_law_refs: guardrail.source_case_id ? [guardrail.source_case_id] : [],
    metadata: {
      blocks_actions: guardrail.blocks_actions,
      predicate_source: normalized.source,
      original_rule: normalized.original_rule,
      ...(normalized.generated_context_key ? { generated_context_key: normalized.generated_context_key } : {}),
    },
  };
}

function proofNode(skill: DojoSkill): DojoGraphNode {
  return {
    ...baseNode("proof", "Proof", "Validate proof capsule", "safe"),
    proof: {
      required: true,
      required_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      required_guardrails: skill.permission_license.proof_requirements.required_guardrails,
    },
    evidence_policy: ["proof_validation_recorded"],
  };
}

function actionNode(skill: DojoSkill): DojoGraphNode {
  const risk = actionRisk(skill);
  const guardrails = graphGuardrailsForSkill(skill);
  const evidencePolicy = ["append_action_trace", "append_postcondition_evidence"];
  const actionGuardrails = [
    ...guardrails,
    ...intrinsicActionGuardrailsFor({
      risk,
      evidence_policy: evidencePolicy,
      assertions: skill.skill_seed.candidate_success_assertions,
    }),
  ];
  const sourceBindings = sourceBindingsForSkill(skill);
  const apiBindings = apiBindingsForSkill(skill);
  return {
    ...baseNode("action", "Action", skill.published_tool_name ?? "Workflow replay", risk),
    action: "run_workflow",
    preconditions: [],
    postconditions: skill.skill_seed.candidate_success_assertions.map((assertion) => assertion.label),
    guardrails: actionGuardrails,
    proof: {
      required: true,
      required_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      required_guardrails: skill.permission_license.proof_requirements.required_guardrails,
    },
    assertions: skill.skill_seed.candidate_success_assertions.map(assertionRequirement),
    substrate_options: skill.execution_substrates,
    evidence_policy: evidencePolicy,
    case_law_refs: skill.case_law.map((item) => item.case_id),
    expiry_triggers: skill.permission_license.expiry_policy.expires_on,
    source_bindings: sourceBindings,
    api_bindings: apiBindings,
    metadata: {
      rollback_policy: skill.rollback_policy,
      guardrail_predicates: actionGuardrails.map((guardrail) => ({
        guardrail_id: guardrail.guardrail_id,
        predicate: guardrail.predicate,
      })),
      source_anchor_ids: sourceBindings.map((binding) => binding.anchor_id),
      api_anchor_ids: apiBindings.map((binding) => binding.anchor_id),
      ...(apiBindings.length === 1 && apiBindings[0]?.api_candidate_id ? { api_candidate_id: apiBindings[0].api_candidate_id } : {}),
      ...(apiBindings.length > 0
        ? { api_candidate_ids: apiBindings.map((binding) => binding.api_candidate_id).filter(isNonEmptyString) }
        : {}),
    },
  };
}

function actionNodesForContractSteps(contract: WorkflowContractV7, skill: DojoSkill): DojoGraphNode[] {
  const usedNodeIds = new Set<string>();
  return contract.steps.map((step, index) => actionNodeForContractStep({
    contract,
    skill,
    step,
    nodeId: uniqueActionNodeId(step, index, usedNodeIds),
  }));
}

function actionNodeForContractStep({
  contract,
  skill,
  step,
  nodeId,
}: {
  contract: WorkflowContractV7;
  skill: DojoSkill;
  step: WorkflowStepContractV7;
  nodeId: string;
}): DojoGraphNode {
  const risk = step.mutation ? actionRisk(skill) : "safe";
  const guardrails = step.mutation ? graphGuardrailsForSkill(skill) : [];
  const assertions = step.mutation ? skill.skill_seed.candidate_success_assertions.map(assertionRequirement) : [];
  const evidencePolicy = step.mutation
    ? ["append_action_trace", "append_postcondition_evidence"]
    : ["append_action_trace"];
  const actionGuardrails = [
    ...guardrails,
    ...intrinsicActionGuardrailsFor({
      risk,
      evidence_policy: evidencePolicy,
      assertions: step.mutation ? skill.skill_seed.candidate_success_assertions : [],
    }),
  ];
  const sourceBindings = sourceBindingsForSkill(skill, step.stepId);
  const apiBindings = apiBindingsForSkill(skill, step.stepId);
  return {
    ...baseNode(nodeId, "Action", step.label || step.intent || step.action.kind, risk),
    action: step.action.kind,
    preconditions: [],
    postconditions: [...step.expectedEffects],
    guardrails: actionGuardrails,
    proof: {
      required: true,
      required_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      required_guardrails: step.mutation ? skill.permission_license.proof_requirements.required_guardrails : [],
    },
    assertions,
    substrate_options: skill.execution_substrates,
    evidence_policy: evidencePolicy,
    case_law_refs: step.mutation ? skill.case_law.map((item) => item.case_id) : [],
    expiry_triggers: skill.permission_license.expiry_policy.expires_on,
    source_bindings: sourceBindings,
    api_bindings: apiBindings,
    metadata: {
      workflow_id: contract.workflowId,
      workflow_step_id: step.stepId,
      event_seq: step.eventSeq,
      intent: step.intent,
      action_kind: step.action.kind,
      action_target: step.action.target ?? null,
      value_ref: step.action.valueRef ?? null,
      locator_plan: step.locatorPlan,
      source_plan: step.sourcePlan,
      api_plan: step.apiPlan ?? null,
      semantic_plan: step.semanticPlan ?? null,
      surface_plan: step.surfacePlan,
      expected_effects: step.expectedEffects,
      limitations: step.limitations,
      mutation: step.mutation ?? null,
      rollback_policy: step.mutation ? skill.rollback_policy : [],
      guardrail_predicates: actionGuardrails.map((guardrail) => ({
        guardrail_id: guardrail.guardrail_id,
        predicate: guardrail.predicate,
      })),
      source_anchor_ids: sourceBindings.map((binding) => binding.anchor_id),
      api_anchor_ids: apiBindings.map((binding) => binding.anchor_id),
      ...(apiBindings.length === 1 && apiBindings[0]?.api_candidate_id ? { api_candidate_id: apiBindings[0].api_candidate_id } : {}),
      ...(apiBindings.length > 0
        ? { api_candidate_ids: apiBindings.map((binding) => binding.api_candidate_id).filter(isNonEmptyString) }
        : {}),
    },
  };
}

function graphGuardrailsForSkill(skill: DojoSkill) {
  return skill.guardrails.map((guardrail) => {
    const normalized = normalizeDojoGuardrailPredicate({
      rule: guardrail.rule,
      title: guardrail.title,
      guardrail_id: guardrail.guardrail_id,
    });
    return {
      guardrail_id: guardrail.guardrail_id,
      predicate: preActionRuntimePredicateForGuardrail(normalized.predicate),
      severity: "block" as const,
    };
  });
}

function preActionRuntimePredicateForGuardrail(predicate: string): string {
  return predicate.trim() === "durable_state_evidence == true"
    ? "durable_state_verification_available == true"
    : predicate;
}

function intrinsicActionGuardrailsFor(input: {
  risk: DojoGraphNodeRisk;
  evidence_policy: string[];
  assertions: DojoAssertion[];
}) {
  if (input.risk === "safe") return [];
  const requiresPostconditionEvidence = input.evidence_policy.includes("append_postcondition_evidence")
    || input.assertions.some((assertion) => assertion.required);
  if (!requiresPostconditionEvidence) return [];
  return [{
    guardrail_id: "guard_durable_postcondition_evidence",
    predicate: "durable_state_verification_available == true",
    severity: "block" as const,
  }];
}

function sourceBindingsForSkill(skill: DojoSkill, sourceStepId?: string): DojoGraphSourceBinding[] {
  return uniqueAnchorsForSkill(skill)
    .filter((anchor) => anchor.kind === "source")
    .filter((anchor) => sourceStepId === undefined || anchor.source_step_id === sourceStepId)
    .map((anchor) => ({
      binding_id: `source_binding_${anchor.anchor_id}`,
      anchor_id: anchor.anchor_id,
      kind: "source" as const,
      label: anchor.label,
      ...(anchor.source_step_id ? { source_step_id: anchor.source_step_id } : {}),
      ...(anchor.source_id ? { source_id: anchor.source_id } : {}),
      ...(anchor.file_path ? { file_path: anchor.file_path } : {}),
      ...(anchor.line ? { line: anchor.line } : {}),
    }));
}

function apiBindingsForSkill(skill: DojoSkill, sourceStepId?: string): DojoGraphApiBinding[] {
  return uniqueAnchorsForSkill(skill)
    .filter((anchor) => anchor.kind === "api")
    .filter((anchor) => sourceStepId === undefined || anchor.source_step_id === sourceStepId)
    .map((anchor) => ({
      binding_id: `api_binding_${anchor.anchor_id}`,
      anchor_id: anchor.anchor_id,
      kind: "api" as const,
      label: anchor.label,
      ...(anchor.source_step_id ? { source_step_id: anchor.source_step_id } : {}),
      ...(anchor.api_candidate_id ? { api_candidate_id: anchor.api_candidate_id } : {}),
      ...(anchor.method ? { method: anchor.method } : {}),
      ...(anchor.path ? { path: anchor.path } : {}),
      ...(anchor.proof_claim_mapping ? { proof_claim_mapping: { ...anchor.proof_claim_mapping } } : {}),
    }));
}

function uniqueAnchorsForSkill(skill: DojoSkill): DojoSourceAnchor[] {
  const byId = new Map<string, DojoSourceAnchor>();
  for (const anchor of [...skill.skill_seed.source_or_api_anchors, ...skill.source_links]) {
    if (!anchor.anchor_id.trim()) continue;
    byId.set(anchor.anchor_id, anchor);
  }
  return [...byId.values()];
}

function assertionNode(assertions: DojoAssertion[]): DojoGraphNode {
  return {
    ...baseNode("assertion", "Assertion", "Verify postconditions", "safe"),
    assertions: assertions.map(assertionRequirement),
    evidence_policy: ["append_assertion_result"],
  };
}

function assertionRequirement(assertion: DojoAssertion) {
  return {
    assertion_id: assertion.assertion_id,
    description: assertion.label,
    required: assertion.required,
  };
}

function graphEdges(skill: DojoSkill): DojoGraphEdge[] {
  return graphEdgesForActionSequence(skill, ["action"]);
}

function graphEdgesForActionSequence(skill: DojoSkill, actionNodeIds: string[]): DojoGraphEdge[] {
  const normalizedActionNodeIds = actionNodeIds.length > 0 ? actionNodeIds : ["action"];
  const guardrailEdges = skill.guardrails.map((guardrail): DojoGraphEdge => ({
    edge_id: `edge_permission_${guardrail.guardrail_id}`,
    from_node_id: "permission",
    to_node_id: guardrail.guardrail_id,
    confidence: 1,
    observed_variants: [],
  }));
  const guardrailToProofEdges = skill.guardrails.map((guardrail): DojoGraphEdge => ({
    edge_id: `edge_${guardrail.guardrail_id}_proof`,
    from_node_id: guardrail.guardrail_id,
    to_node_id: "proof",
    confidence: 1,
    observed_variants: [],
  }));
  const actionEdges = normalizedActionNodeIds.flatMap((nodeId, index): DojoGraphEdge[] => {
    if (index === 0) return [edge(`edge_proof_${nodeId}`, "proof", nodeId)];
    const previousNodeId = normalizedActionNodeIds[index - 1]!;
    return [edge(`edge_${previousNodeId}_${nodeId}`, previousNodeId, nodeId)];
  });
  const finalActionNodeId = normalizedActionNodeIds[normalizedActionNodeIds.length - 1]!;
  return [
    edge("edge_trigger_input", "trigger", "input"),
    edge("edge_input_permission", "input", "permission"),
    ...guardrailEdges,
    ...(skill.guardrails.length === 0 ? [edge("edge_permission_proof", "permission", "proof")] : guardrailToProofEdges),
    ...actionEdges,
    edge(`edge_${finalActionNodeId}_assertion`, finalActionNodeId, "assertion"),
  ];
}

function edge(edgeId: string, from: string, to: string): DojoGraphEdge {
  return {
    edge_id: edgeId,
    from_node_id: from,
    to_node_id: to,
    confidence: 1,
    observed_variants: [],
  };
}

function baseNode(
  nodeId: string,
  kind: DojoGraphNode["kind"],
  label: string,
  risk: DojoGraphNodeRisk
): DojoGraphNode {
  return {
    node_id: nodeId,
    kind,
    label,
    risk,
    preconditions: [],
    postconditions: [],
    guardrails: [],
    assertions: [],
    substrate_options: [],
    evidence_policy: [],
    case_law_refs: [],
    expiry_triggers: [],
  };
}

function actionRisk(skill: DojoSkill): DojoGraphNodeRisk {
  return skill.permission_license.gated_actions.length > 0 || skill.permission_license.blocked_actions.length > 0
    ? "dangerous"
    : "mutation";
}

function uniqueActionNodeId(step: WorkflowStepContractV7, index: number, usedNodeIds: Set<string>): string {
  const base = `action_${sanitizeGraphId(step.stepId || `step_${index + 1}`)}`;
  let candidate = base;
  let suffix = 2;
  while (usedNodeIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNodeIds.add(candidate);
  return candidate;
}

function sanitizeGraphId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "step";
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
