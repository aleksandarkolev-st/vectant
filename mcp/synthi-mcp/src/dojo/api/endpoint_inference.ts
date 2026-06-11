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
  const path = pathFromUrl(input.url);
  return {
    schema_version: "synthi.dojo.apiEndpointCandidate.v1",
    candidate_id: `api_candidate_${shortHash(`${method}:${path}:${JSON.stringify(input.request_body ?? {})}`)}`,
    method,
    path,
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

function pathFromUrl(url: string): string {
  try {
    return new URL(url, "https://synthetic.local").pathname;
  } catch {
    throw new Error("dojo_api_url_invalid");
  }
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { type: typeof value };
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, { type: typeName(nested) }])
    ),
  };
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function errorIssue(issueId: string, message: string): DojoApiCandidateReviewIssue {
  return { issue_id: issueId, severity: "error", message };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
