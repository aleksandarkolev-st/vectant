import type { DojoGraphGuardrailRequirement, DojoSkillGraph } from "../graph/types.js";
import { isDojoCaseLawBindingActive, type DojoCaseLawRecord } from "./registry.js";

export interface DojoCaseLawGuardrailBinding {
  case_id: string;
  guardrail: DojoGraphGuardrailRequirement;
  blocked_actions: string[];
  evidence_refs: string[];
}

export function synthesizeDojoGuardrailFromCase(caseLaw: DojoCaseLawRecord): DojoCaseLawGuardrailBinding | null {
  if (!isDojoCaseLawBindingActive(caseLaw)) return null;
  return {
    case_id: caseLaw.case_id,
    guardrail: {
      guardrail_id: `case_guard_${caseLaw.case_id}`,
      predicate: predicateForCase(caseLaw),
      severity: "block",
    },
    blocked_actions: caseLaw.applies_to.length > 0 ? caseLaw.applies_to : ["*"],
    evidence_refs: [...caseLaw.evidence_refs],
  };
}

export function bindCaseLawGuardrailsToGraph(
  graph: DojoSkillGraph,
  caseLawRecords: DojoCaseLawRecord[]
): DojoSkillGraph {
  const bindings = caseLawRecords
    .map(synthesizeDojoGuardrailFromCase)
    .filter((binding): binding is DojoCaseLawGuardrailBinding => binding !== null);

  if (bindings.length === 0) {
    return cloneGraph(graph);
  }

  return {
    ...cloneGraph(graph),
    nodes: graph.nodes.map((node) => {
      if (node.kind !== "Action") return { ...node };
      const nodeBindings = bindings.filter((binding) =>
        binding.blocked_actions.includes("*") || (node.action ? binding.blocked_actions.includes(node.action) : false)
      );
      if (nodeBindings.length === 0) return { ...node };
      const guardrails = [...node.guardrails];
      const caseLawRefs = new Set(node.case_law_refs);
      for (const binding of nodeBindings) {
        if (!guardrails.some((guardrail) => guardrail.guardrail_id === binding.guardrail.guardrail_id)) {
          guardrails.push(binding.guardrail);
        }
        caseLawRefs.add(binding.case_id);
      }
      return {
        ...node,
        guardrails,
        case_law_refs: [...caseLawRefs].sort(),
      };
    }),
  };
}

function predicateForCase(caseLaw: DojoCaseLawRecord): string {
  const material = `${caseLaw.title} ${caseLaw.finding} ${caseLaw.rule_created}`.toLowerCase();
  if (material.includes("stable id") || material.includes("stable identifier") || material.includes("stable entity")) {
    return "stable_entity_identity == true";
  }
  if (material.includes("duplicate")) {
    return "duplicate_display_name_count == 0";
  }
  if (material.includes("approval")) {
    return "approval_status != denied";
  }
  if (material.includes("durable") || material.includes("fake success") || material.includes("partial")) {
    return "durable_state_evidence == true";
  }
  return `case_${caseLaw.case_id}_satisfied == true`;
}

function cloneGraph(graph: DojoSkillGraph): DojoSkillGraph {
  return JSON.parse(JSON.stringify(graph)) as DojoSkillGraph;
}
