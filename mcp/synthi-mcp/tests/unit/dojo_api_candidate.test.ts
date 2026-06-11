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
    }));
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
