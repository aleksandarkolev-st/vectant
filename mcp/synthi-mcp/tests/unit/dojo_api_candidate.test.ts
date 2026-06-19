import { describe, expect, it } from "vitest";
import {
  inferDojoApiEndpointCandidateFromTrace,
  reviewDojoApiEndpointCandidate,
} from "../../src/dojo/api/endpoint_inference.js";

describe("Dojo API endpoint candidate contract", () => {
  it("infers a simple endpoint candidate from network trace metadata", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "https://app.example.test/api/invoices",
      request_body: { client_id: "client-a", amount: 42 },
      response_body: { invoice_id: "invoice-a", status: "saved" },
      source_ref: "trace:event-save",
    });

    expect(candidate).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.apiEndpointCandidate.v1",
      method: "POST",
      path: "/api/invoices",
      mutation_class: "create",
      review_status: "candidate",
      inferred_from: ["trace:event-save"],
    }));
    expect(candidate.request_schema).toEqual(expect.objectContaining({
      type: "object",
      properties: expect.objectContaining({
        amount: { type: "number" },
      }),
      required: ["amount", "client_id"],
      additionalProperties: false,
    }));
  });

  it("infers reviewed query parameters separately from endpoint path", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "GET",
      url: "https://app.example.test/api/search?q=invoice&page=2",
      response_body: { count: 1 },
    });

    expect(candidate.path).toBe("/api/search");
    expect(candidate.query_schema).toEqual({
      type: "object",
      properties: {
        page: { type: "string" },
        q: { type: "string" },
      },
      required: ["page", "q"],
      additionalProperties: false,
    });
  });

  it("does not promote mutation candidates without idempotency, rollback, auth, postcondition, and proof mapping", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { amount: 42 },
    });

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_review_approval_required" }),
        expect.objectContaining({ issue_id: "api_candidate_auth_scope_required" }),
        expect.objectContaining({ issue_id: "api_candidate_idempotency_required" }),
        expect.objectContaining({ issue_id: "api_candidate_rollback_required" }),
        expect.objectContaining({ issue_id: "api_candidate_postcondition_required" }),
        expect.objectContaining({ issue_id: "api_candidate_proof_claim_mapping_required" }),
      ]),
    }));
  });

  it("infers generic mutation safety hints without auto-promoting the candidate", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "PATCH",
      url: "/api/invoices/invoice-a",
      request_body: { amount: 42 },
      request_headers: {
        "Idempotency-Key": "idem-123",
        Authorization: "Bearer opaque-token-that-must-not-be-copied",
      },
      auth_scope_hint: "invoice:write",
      rollback_strategy_hint: "compensating_call",
      postcondition_hint: "invoice.amount == request.amount",
      proof_claim_mapping_hint: {
        workspace_verified: "tenant.workspace_id",
      },
    });

    expect(candidate).toEqual(expect.objectContaining({
      auth_scope: "invoice:write",
      idempotency_key_location: "header",
      rollback_strategy: "compensating_call",
      postcondition: "invoice.amount == request.amount",
      proof_claim_mapping: { workspace_verified: "tenant.workspace_id" },
      review_status: "candidate",
      inferred_from: expect.arrayContaining([
        "trace_hint:auth_scope",
        "trace_hint:rollback_strategy",
        "trace_hint:postcondition",
        "trace_hint:proof_claim_mapping",
        "network:idempotency_key_header",
      ]),
    }));
    expect(JSON.stringify(candidate)).not.toContain("opaque-token-that-must-not-be-copied");
    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_review_approval_required" }),
      ]),
    }));
  });

  it("detects body and query idempotency carriers from generic trace shape", () => {
    const bodyCandidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { amount: 42, idempotency_key: "idem-body" },
    });
    const queryCandidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices?idempotencyKey=idem-query",
      request_body: { amount: 42 },
    });

    expect(bodyCandidate.idempotency_key_location).toBe("body");
    expect(bodyCandidate.inferred_from).toContain("network:idempotency_key_body");
    expect(queryCandidate.idempotency_key_location).toBe("query");
    expect(queryCandidate.inferred_from).toContain("network:idempotency_key_query");
  });

  it("does not invent safety approval fields from raw auth headers or response bodies", () => {
    const candidate = inferDojoApiEndpointCandidateFromTrace({
      method: "POST",
      url: "/api/invoices",
      request_body: { amount: 42 },
      request_headers: {
        Authorization: "Bearer opaque-token",
      },
      response_body: { invoice_id: "invoice-a", status: "saved" },
    });

    expect(candidate.auth_scope).toBeUndefined();
    expect(candidate.postcondition).toBeUndefined();
    expect(candidate.rollback_strategy).toBeUndefined();
    expect(candidate.proof_claim_mapping).toEqual({});
    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_auth_scope_required" }),
        expect.objectContaining({ issue_id: "api_candidate_postcondition_required" }),
        expect.objectContaining({ issue_id: "api_candidate_proof_claim_mapping_required" }),
      ]),
    }));
  });

  it("allows approved mutation candidates with required safety fields", () => {
    const candidate = {
      ...inferDojoApiEndpointCandidateFromTrace({
        method: "PATCH",
        url: "/api/invoices/invoice-a",
        request_body: { amount: 42 },
      }),
      auth_scope: "invoice:write",
      idempotency_key_location: "header" as const,
      rollback_strategy: "compensating_call" as const,
      postcondition: "invoice.amount == request.amount",
      proof_claim_mapping: { workspace_verified: "tenant.workspace_id" },
      review_status: "approved" as const,
    };

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual({ ok_to_promote: true, issues: [] });
  });

  it("does not promote approved candidates with permissive request schemas", () => {
    const candidate = {
      ...inferDojoApiEndpointCandidateFromTrace({
        method: "POST",
        url: "/api/invoices",
        request_body: { amount: 42 },
      }),
      request_schema: {
        type: "object",
        properties: {
          invoice: {
            type: "object",
            properties: { amount: { type: "number" } },
          },
        },
        required: ["invoice"],
      },
      auth_scope: "invoice:write",
      idempotency_key_location: "header" as const,
      rollback_strategy: "compensating_call" as const,
      postcondition: "invoice.amount == request.invoice.amount",
      proof_claim_mapping: { workspace_verified: "tenant.workspace_id" },
      review_status: "approved" as const,
    };

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_request_schema_strict_required" }),
      ]),
    }));
  });

  it("does not promote approved candidates with permissive query schemas", () => {
    const candidate = {
      ...inferDojoApiEndpointCandidateFromTrace({
        method: "GET",
        url: "/api/invoices?workspace=west",
      }),
      query_schema: {
        type: "object",
        properties: { workspace: { type: "string" } },
      },
      review_status: "approved" as const,
    };

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_query_schema_strict_required" }),
      ]),
    }));
  });

  it("does not promote approved candidates with permissive response schemas", () => {
    const candidate = {
      ...inferDojoApiEndpointCandidateFromTrace({
        method: "GET",
        url: "/api/invoices/invoice-a",
        response_body: { invoice_id: "invoice-a", status: "saved" },
      }),
      response_schema: {
        type: "object",
        properties: {
          invoice_id: { type: "string" },
          status: { type: "string" },
        },
      },
      review_status: "approved" as const,
    };

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual(expect.objectContaining({
      ok_to_promote: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ issue_id: "api_candidate_response_schema_strict_required" }),
      ]),
    }));
  });

  it("does not require mutation safety fields for approved read candidates", () => {
    const candidate = {
      ...inferDojoApiEndpointCandidateFromTrace({
        method: "GET",
        url: "/api/invoices/invoice-a",
      }),
      review_status: "approved" as const,
    };

    expect(reviewDojoApiEndpointCandidate(candidate)).toEqual({ ok_to_promote: true, issues: [] });
  });
});
