export type DojoApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type DojoApiMutationClass = "read" | "create" | "update" | "delete" | "side_effect";
export type DojoApiReviewStatus = "candidate" | "approved" | "rejected";

export interface DojoApiEndpointCandidate {
  schema_version: "synthi.dojo.apiEndpointCandidate.v1";
  candidate_id: string;
  method: DojoApiMethod;
  path: string;
  request_schema: Record<string, unknown>;
  response_schema: Record<string, unknown>;
  auth_scope?: string;
  mutation_class: DojoApiMutationClass;
  idempotency_key_location?: "header" | "body" | "query";
  rollback_strategy?: "none" | "compensating_call" | "delete_draft" | "human_review";
  postcondition?: string;
  proof_claim_mapping: Record<string, string>;
  review_status: DojoApiReviewStatus;
  inferred_from: string[];
}

export interface DojoApiCandidateReviewIssue {
  issue_id: string;
  severity: "error" | "warning";
  message: string;
}

export interface DojoApiCandidateReview {
  ok_to_promote: boolean;
  issues: DojoApiCandidateReviewIssue[];
}

export function isMutationCandidate(candidate: DojoApiEndpointCandidate): boolean {
  return candidate.mutation_class !== "read" || candidate.method !== "GET";
}
