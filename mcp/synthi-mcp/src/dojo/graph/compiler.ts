import type { DojoAssertion, DojoGuardrail, DojoSkill } from "../../browser/dojo.js";
import type { WorkflowContractV7 } from "../../browser/workflow.js";
import {
  type DojoGraphEdge,
  type DojoGraphNode,
  type DojoGraphNodeRisk,
  type DojoSkillGraph,
  validateDojoSkillGraph,
} from "./types.js";

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
  return compileDojoSkillGraphForSkill({
    ...skill,
    workflow_id: contract.workflowId,
  }, input);
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
  return {
    ...baseNode(guardrail.guardrail_id, "Guardrail", guardrail.title, "safe"),
    guardrails: [{
      guardrail_id: guardrail.guardrail_id,
      predicate: guardrail.rule,
      severity: "block",
    }],
    case_law_refs: guardrail.source_case_id ? [guardrail.source_case_id] : [],
    metadata: { blocks_actions: guardrail.blocks_actions },
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
  return {
    ...baseNode("action", "Action", skill.published_tool_name ?? "Workflow replay", risk),
    action: "run_workflow",
    preconditions: ["proof_capsule_valid == true"],
    postconditions: skill.skill_seed.candidate_success_assertions.map((assertion) => assertion.label),
    guardrails: skill.guardrails.map((guardrail) => ({
      guardrail_id: guardrail.guardrail_id,
      predicate: guardrail.rule,
      severity: "block",
    })),
    proof: {
      required: true,
      required_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      required_guardrails: skill.permission_license.proof_requirements.required_guardrails,
    },
    assertions: skill.skill_seed.candidate_success_assertions.map(assertionRequirement),
    substrate_options: skill.execution_substrates,
    evidence_policy: ["append_action_trace", "append_postcondition_evidence"],
    case_law_refs: skill.case_law.map((item) => item.case_id),
    expiry_triggers: skill.permission_license.expiry_policy.expires_on,
    metadata: { rollback_policy: skill.rollback_policy },
  };
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
  return [
    edge("edge_trigger_input", "trigger", "input"),
    edge("edge_input_permission", "input", "permission"),
    ...guardrailEdges,
    ...(skill.guardrails.length === 0 ? [edge("edge_permission_proof", "permission", "proof")] : guardrailToProofEdges),
    edge("edge_proof_action", "proof", "action"),
    edge("edge_action_assertion", "action", "assertion"),
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
