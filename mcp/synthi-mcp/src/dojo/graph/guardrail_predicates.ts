import { createHash } from "node:crypto";

export type DojoGuardrailPredicateSource = "native" | "normalized" | "generated_key";

export interface DojoNormalizedGuardrailPredicate {
  predicate: string;
  source: DojoGuardrailPredicateSource;
  original_rule: string;
  generated_context_key?: string;
}

export function normalizeDojoGuardrailPredicate(input: {
  rule: string;
  title?: string;
  guardrail_id?: string;
}): DojoNormalizedGuardrailPredicate {
  const originalRule = input.rule.trim();
  if (isParseableDojoGuardrailPredicate(originalRule)) {
    return { predicate: originalRule, source: "native", original_rule: originalRule };
  }

  const fallbackRule = originalRule || input.title?.trim() || input.guardrail_id?.trim() || "guardrail";
  const normalized = `${input.title ?? ""} ${input.rule} ${input.guardrail_id ?? ""}`.toLowerCase();
  const knownPredicate = predicateForKnownGuardrailText(normalized);
  if (knownPredicate) {
    return {
      predicate: knownPredicate,
      source: "normalized",
      original_rule: fallbackRule,
      generated_context_key: contextKeyForDojoGuardrailPredicate(knownPredicate) ?? undefined,
    };
  }

  const generatedKey = `guardrail_${shortHash(fallbackRule)}`;
  return {
    predicate: `${generatedKey} == true`,
    source: "generated_key",
    original_rule: fallbackRule,
    generated_context_key: generatedKey,
  };
}

export function isParseableDojoGuardrailPredicate(predicate: string): boolean {
  const trimmed = predicate.trim();
  if (!trimmed) return false;

  const membership = trimmed.match(/^([a-zA-Z0-9_.-]+)\s+in\s+(\[.*\])$/);
  if (membership?.[2]) return parseArrayLiteral(membership[2]);

  const comparison = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (comparison?.[3]) return !/^[<>=!]/.test(comparison[3].trim());

  return /^[a-zA-Z0-9_.-]+$/.test(trimmed);
}

export function contextKeyForDojoGuardrailPredicate(predicate: string): string | null {
  const trimmed = predicate.trim();
  const comparison = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:==\s*true)?$/);
  if (comparison?.[1]) return comparison[1];
  if (/^[a-zA-Z0-9_.-]+$/.test(trimmed)) return trimmed;
  return null;
}

function predicateForKnownGuardrailText(text: string): string | null {
  if (
    text.includes("stable")
      && (text.includes("entity") || text.includes("identifier") || text.includes(" id") || text.includes("client") || text.includes("record"))
  ) {
    return "client_id_verified == true";
  }
  if (text.includes("source") && (text.includes("anchor") || text.includes("affordance") || text.includes("backed") || text.includes("contract"))) {
    return "source_anchor_current == true";
  }
  if (text.includes("durable") || text.includes("success assertion") || text.includes("postcondition") || text.includes("state evidence")) {
    return "durable_state_evidence == true";
  }
  if (text.includes("approval") || text.includes("review") || text.includes("human")) {
    return "human_review_ready == true";
  }
  return null;
}

function parseArrayLiteral(raw: string): boolean {
  try {
    return Array.isArray(JSON.parse(raw) as unknown);
  } catch {
    return false;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
