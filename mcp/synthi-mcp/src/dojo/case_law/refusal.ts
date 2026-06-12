import type { DojoSkillGraph } from "../graph/types.js";
import type { DojoCaseLawRecord } from "./registry.js";

export interface DojoRuntimeRefusalExplanation {
  schema_version: "synthi.dojo.runtimeRefusalExplanation.v1";
  blocked_action: string;
  blocked_by: string[];
  rule: string;
  guardrail_refs: string[];
  case_law_citations: Array<{
    case_id: string;
    title: string;
    finding: string;
    rule_created: string;
    evidence_refs: string[];
  }>;
  evidence_refs: string[];
  smallest_allowed_next_step: string;
}

export function explainDojoRuntimeRefusal(input: {
  graph: DojoSkillGraph;
  blocked_action: string;
  blocked_by: string[];
  case_law: DojoCaseLawRecord[];
}): DojoRuntimeRefusalExplanation {
  const guardrailRefs = guardrailRefsFromBlockedBy(input.blocked_by);
  const matchingActionNodes = input.graph.nodes.filter((node) =>
    node.kind === "Action" && (!node.action || node.action === input.blocked_action)
  );
  const matchingCaseIds = new Set(
    matchingActionNodes
      .filter((node) =>
        guardrailRefs.length === 0 || node.guardrails.some((guardrail) => guardrailRefs.includes(guardrail.guardrail_id))
      )
      .flatMap((node) => node.case_law_refs)
  );
  const citations = input.case_law
    .filter((record) => matchingCaseIds.has(record.case_id))
    .map((record) => ({
      case_id: record.case_id,
      title: record.title,
      finding: record.finding,
      rule_created: record.rule_created,
      evidence_refs: [...record.evidence_refs],
    }));
  const matchingGuardrail = matchingActionNodes
    .flatMap((node) => node.guardrails)
    .find((guardrail) => guardrailRefs.includes(guardrail.guardrail_id));
  const rule = citations[0]?.rule_created
    ?? (matchingGuardrail ? `Satisfy guardrail predicate: ${matchingGuardrail.predicate}` : `Resolve block reason: ${input.blocked_by.join(", ") || "unknown"}`);
  return {
    schema_version: "synthi.dojo.runtimeRefusalExplanation.v1",
    blocked_action: input.blocked_action,
    blocked_by: [...input.blocked_by],
    rule,
    guardrail_refs: guardrailRefs,
    case_law_citations: citations,
    evidence_refs: [...new Set(citations.flatMap((citation) => citation.evidence_refs))].sort(),
    smallest_allowed_next_step: citations.length > 0
      ? `Satisfy the cited case-law rule or request reviewer approval before ${input.blocked_action}.`
      : `Provide the missing proof, approval, or runtime condition before ${input.blocked_action}.`,
  };
}

function guardrailRefsFromBlockedBy(blockedBy: string[]): string[] {
  return blockedBy
    .map((reason) => reason.match(/^guardrail_failed:(.+)$/)?.[1])
    .filter((guardrailId): guardrailId is string => Boolean(guardrailId));
}
