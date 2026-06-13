import { createHash } from "node:crypto";
import {
  type DojoApiCandidateReview,
  type DojoApiCandidateReviewIssue,
  type DojoApiEndpointCandidate,
  type DojoApiMethod,
  type DojoApiMutationClass,
  isMutationCandidate,
} from "./types.js";

export interface DojoNetworkTraceEndpointInput {
  method: string;
  url: string;
  request_body?: unknown;
  response_body?: unknown;
  status?: number;
  source_ref?: string;
}

export function inferDojoApiEndpointCandidateFromTrace(
  input: DojoNetworkTraceEndpointInput
): DojoApiEndpointCandidate {
  const method = normalizeMethod(input.method);
  const parsedUrl = parsedUrlFromInput(input.url);
  const path = parsedUrl.pathname;
  const query = queryObjectFromUrl(parsedUrl);
  const querySchema = inferShape(query);
  return {
    schema_version: "synthi.dojo.apiEndpointCandidate.v1",
    candidate_id: `api_candidate_${shortHash(`${method}:${path}:${canonicalJson(query)}:${canonicalJson(input.request_body ?? {})}`)}`,
    method,
    path,
    ...(hasObjectProperties(querySchema) ? { query_schema: querySchema } : {}),
    request_schema: inferShape(input.request_body),
    response_schema: inferShape(input.response_body),
    mutation_class: mutationClassFor(method, path),
    proof_claim_mapping: {},
    review_status: "candidate",
    inferred_from: [input.source_ref ?? `network:${method}:${path}`],
  };
}

export function reviewDojoApiEndpointCandidate(candidate: DojoApiEndpointCandidate): DojoApiCandidateReview {
  const issues: DojoApiCandidateReviewIssue[] = [];
  if (!candidate.path.trim()) issues.push(errorIssue("api_candidate_path_required", "API candidate requires a path."));
  if (candidate.review_status !== "approved") {
    issues.push(errorIssue("api_candidate_review_approval_required", "API candidate requires explicit approval before promotion."));
  }
  if (isMutationCandidate(candidate)) {
    if (!candidate.auth_scope?.trim()) issues.push(errorIssue("api_candidate_auth_scope_required", "Mutation API candidates require auth scope."));
    if (!candidate.idempotency_key_location) issues.push(errorIssue("api_candidate_idempotency_required", "Mutation API candidates require idempotency key policy."));
    if (!candidate.rollback_strategy) issues.push(errorIssue("api_candidate_rollback_required", "Mutation API candidates require rollback strategy."));
    if (!candidate.postcondition?.trim()) issues.push(errorIssue("api_candidate_postcondition_required", "Mutation API candidates require postcondition."));
    if (Object.keys(candidate.proof_claim_mapping).length === 0) {
      issues.push(errorIssue("api_candidate_proof_claim_mapping_required", "Mutation API candidates require proof claim mapping."));
    }
  }
  return {
    ok_to_promote: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function normalizeMethod(method: string): DojoApiMethod {
  const normalized = method.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) return normalized as DojoApiMethod;
  throw new Error("dojo_api_method_unsupported");
}

function parsedUrlFromInput(url: string): URL {
  try {
    return new URL(url, "https://synthetic.local");
  } catch {
    throw new Error("dojo_api_url_invalid");
  }
}

function queryObjectFromUrl(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of [...new Set(url.searchParams.keys())].sort()) {
    const values = url.searchParams.getAll(key);
    if (values.length === 1) {
      query[key] = values[0] ?? "";
    } else if (values.length > 1) {
      query[key] = values;
    }
  }
  return query;
}

function mutationClassFor(method: DojoApiMethod, path: string): DojoApiMutationClass {
  if (method === "GET") return "read";
  if (method === "POST" && /delete|remove/i.test(path)) return "delete";
  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "DELETE") return "delete";
  return "side_effect";
}

function inferShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      type: "array",
      ...(first !== undefined ? { items: inferShape(first) } : {}),
    };
  }
  if (typeof value !== "object" || value === null) return { type: typeName(value) };
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([key, nested]) => [key, inferShape(nested)])
    ),
    required: entries.map(([key]) => key),
    additionalProperties: false,
  };
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (value === undefined) return "null";
  return typeof value;
}

function hasObjectProperties(schema: Record<string, unknown>): boolean {
  const properties = schema["properties"];
  return Boolean(properties && typeof properties === "object" && !Array.isArray(properties) && Object.keys(properties).length > 0);
}

function errorIssue(issueId: string, message: string): DojoApiCandidateReviewIssue {
  return { issue_id: issueId, severity: "error", message };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}
