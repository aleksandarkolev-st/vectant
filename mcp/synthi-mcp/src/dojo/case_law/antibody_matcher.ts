import { createHash } from "node:crypto";
import type { DojoGraphGuardrailRequirement, DojoSkillGraph, DojoGraphNode } from "../graph/types.js";
import { synthesizeDojoGuardrailFromCase } from "./guardrail_synthesizer.js";
import { isDojoCaseLawBindingActive, type DojoCaseLawBindingScope, type DojoCaseLawRecord } from "./registry.js";

export interface DojoAntibodyCandidate {
  schema_version: "synthi.dojo.antibodyCandidate.v1";
  antibody_id: string;
  source_case_id: string;
  target_skill_id: string;
  target_graph_id: string;
  target_node_id: string;
  binding_scope: DojoCaseLawBindingScope;
  status: "proposed";
  confidence: number;
  inherited_guardrail: DojoGraphGuardrailRequirement;
  match_reasons: string[];
  source_evidence_ref_count: number;
  source_evidence_ref_digests: string[];
  private_data_transferred: false;
  local_practice_required: true;
  local_checkride_required: true;
  created_at: string;
}

export interface DojoAntibodyMatchInput {
  source_case_law: DojoCaseLawRecord[];
  target_graph: DojoSkillGraph;
  binding_scope?: DojoCaseLawBindingScope;
  now: string;
  min_confidence?: number;
}

export function matchDojoCaseLawAntibodies(input: DojoAntibodyMatchInput): DojoAntibodyCandidate[] {
  const minConfidence = Number.isFinite(input.min_confidence) ? Number(input.min_confidence) : 0.45;
  const candidates: DojoAntibodyCandidate[] = [];
  for (const record of input.source_case_law) {
    if (!isDojoCaseLawBindingActive(record)) continue;
    const binding = synthesizeDojoGuardrailFromCase(record);
    if (!binding) continue;
    for (const node of input.target_graph.nodes) {
      if (node.kind !== "Action") continue;
      const match = scoreAntibodyMatch({ record, node, blockedActions: binding.blocked_actions });
      if (match.confidence < minConfidence) continue;
      candidates.push({
        schema_version: "synthi.dojo.antibodyCandidate.v1",
        antibody_id: antibodyIdFor(record.case_id, input.target_graph.graph_id, node.node_id, binding.guardrail.predicate),
        source_case_id: record.case_id,
        target_skill_id: input.target_graph.skill_id,
        target_graph_id: input.target_graph.graph_id,
        target_node_id: node.node_id,
        binding_scope: input.binding_scope ?? {
          kind: "skill",
          id: input.target_graph.skill_id,
        },
        status: "proposed",
        confidence: match.confidence,
        inherited_guardrail: { ...binding.guardrail },
        match_reasons: match.reasons,
        source_evidence_ref_count: record.evidence_refs.length,
        source_evidence_ref_digests: record.evidence_refs.map(evidenceDigest).sort(),
        private_data_transferred: false,
        local_practice_required: true,
        local_checkride_required: true,
        created_at: input.now,
      });
    }
  }
  return candidates.sort((left, right) =>
    right.confidence - left.confidence
    || left.source_case_id.localeCompare(right.source_case_id)
    || left.target_node_id.localeCompare(right.target_node_id)
  );
}

function scoreAntibodyMatch(input: {
  record: DojoCaseLawRecord;
  node: DojoGraphNode;
  blockedActions: string[];
}): { confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (input.node.action && (input.blockedActions.includes("*") || input.blockedActions.includes(input.node.action))) {
    score += 0.5;
    reasons.push(`action_match:${input.node.action}`);
  }
  const caseTokens = tokensFor([
    input.record.title,
    input.record.finding,
    input.record.impact,
    input.record.rule_created,
    input.record.guardrail_predicate ?? "",
    input.record.applies_to.join(" "),
  ]);
  const nodeTokens = tokensFor([
    input.node.label,
    input.node.action ?? "",
    input.node.preconditions.join(" "),
    input.node.postconditions.join(" "),
    input.node.guardrails.map((guardrail) => guardrail.predicate).join(" "),
    input.node.assertions.map((assertion) => assertion.description).join(" "),
    input.node.substrate_options.join(" "),
  ]);
  const tokenOverlap = [...caseTokens].filter((token) => nodeTokens.has(token)).sort();
  if (tokenOverlap.length > 0) {
    score += Math.min(0.35, tokenOverlap.length * 0.08);
    reasons.push(`context_token_overlap:${tokenOverlap.slice(0, 8).join(",")}`);
  }
  if (input.node.risk === "dangerous") {
    score += 0.15;
    reasons.push("dangerous_action");
  } else if (input.node.risk === "mutation") {
    score += 0.1;
    reasons.push("mutation_action");
  }
  return {
    confidence: Number(Math.min(1, score).toFixed(3)),
    reasons,
  };
}

function tokensFor(values: string[]): Set<string> {
  return new Set(values
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3)
    .filter((value) => !STOP_TOKENS.has(value)));
}

function antibodyIdFor(caseId: string, graphId: string, nodeId: string, predicate: string): string {
  return `antibody_${shortHash(`${caseId}:${graphId}:${nodeId}:${predicate}`)}`;
}

function evidenceDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "true",
  "false",
  "required",
  "require",
  "before",
  "after",
]);
