import { createHash } from "node:crypto";
import { reviewDojoApiEndpointCandidate } from "./endpoint_inference.js";
import { type DojoApiCandidateReviewIssue, type DojoApiEndpointCandidate, isMutationCandidate } from "./types.js";

export interface DojoApiBackedMcpTool {
  schema_version: "synthi.dojo.apiBackedMcpTool.v1";
  tool_name: string;
  tool_version: string;
  candidate_id: string;
  method: DojoApiEndpointCandidate["method"];
  path: string;
  skill_id: string;
  license_id: string;
  license_version: string;
  action: string;
  auth_scope: string | null;
  proof_required: true;
  proof_claim_mapping: Record<string, string>;
  idempotency_key_location: DojoApiEndpointCandidate["idempotency_key_location"] | null;
  rollback_strategy: DojoApiEndpointCandidate["rollback_strategy"] | null;
  postcondition: string | null;
  input_schema: Record<string, unknown>;
  schema_digest: string;
  enforcement: {
    proof_capsule_required: true;
    license_kernel_required: true;
    evidence_write_required: true;
    postcondition_assertion_required: boolean;
    idempotency_required: boolean;
  };
}

export interface DojoApiToolCompileResult {
  ok: boolean;
  tool?: DojoApiBackedMcpTool;
  issues: DojoApiCandidateReviewIssue[];
}

export interface DojoApiToolInvocationValidation {
  ok: boolean;
  blocked_by: string[];
}

export interface DojoApiToolLicenseContext {
  skill_id: string;
  license_id: string;
  license_version: string;
  action: string;
  auth_scopes?: string[];
}

export function compileDojoApiBackedMcpTool(input: {
  candidate: DojoApiEndpointCandidate;
  skill_id: string;
  license_id: string;
  license_version: string;
  action?: string;
  tool_name?: string;
  tool_version?: string;
}): DojoApiToolCompileResult {
  const review = reviewDojoApiEndpointCandidate(input.candidate);
  if (!review.ok_to_promote) return { ok: false, issues: review.issues };
  const mutation = isMutationCandidate(input.candidate);
  const inputSchema = buildToolInputSchema(input.candidate, mutation);
  const tool: DojoApiBackedMcpTool = {
    schema_version: "synthi.dojo.apiBackedMcpTool.v1",
    tool_name: input.tool_name ?? `synthi_api_${slug(`${input.action ?? input.candidate.mutation_class}_${input.candidate.path}`)}`,
    tool_version: input.tool_version ?? "1.0.0",
    candidate_id: input.candidate.candidate_id,
    method: input.candidate.method,
    path: input.candidate.path,
    skill_id: input.skill_id,
    license_id: input.license_id,
    license_version: input.license_version,
    action: input.action ?? actionForCandidate(input.candidate),
    auth_scope: input.candidate.auth_scope ?? null,
    proof_required: true,
    proof_claim_mapping: { ...input.candidate.proof_claim_mapping },
    idempotency_key_location: input.candidate.idempotency_key_location ?? null,
    rollback_strategy: input.candidate.rollback_strategy ?? null,
    postcondition: input.candidate.postcondition ?? null,
    input_schema: inputSchema,
    schema_digest: digestObject(inputSchema),
    enforcement: {
      proof_capsule_required: true,
      license_kernel_required: true,
      evidence_write_required: true,
      postcondition_assertion_required: mutation,
      idempotency_required: mutation,
    },
  };
  return { ok: true, tool, issues: [] };
}

export function validateDojoApiBackedToolInvocation(input: {
  tool: DojoApiBackedMcpTool;
  args: Record<string, unknown>;
  license_context: DojoApiToolLicenseContext;
}): DojoApiToolInvocationValidation {
  const blockedBy: string[] = [];
  const proofCapsule = objectRecord(input.args["proof_capsule"]);
  if (!proofCapsule) {
    blockedBy.push("api_tool_proof_capsule_required");
  } else {
    requireMatchingProofField(proofCapsule, "capsule_id", undefined, "api_tool_proof_capsule_id_required", blockedBy);
    requireMatchingProofField(proofCapsule, "nonce", undefined, "api_tool_proof_nonce_required", blockedBy);
    requireMatchingProofField(
      proofCapsule,
      "skill_id",
      input.tool.skill_id,
      "api_tool_proof_skill_required",
      blockedBy,
      "api_tool_proof_skill_mismatch"
    );
    requireMatchingProofField(
      proofCapsule,
      "license_id",
      input.tool.license_id,
      "api_tool_proof_license_required",
      blockedBy,
      "api_tool_proof_license_mismatch"
    );
    requireMatchingProofField(
      proofCapsule,
      "license_version",
      input.tool.license_version,
      "api_tool_proof_license_version_required",
      blockedBy,
      "api_tool_proof_license_version_mismatch"
    );
    requireMatchingProofField(
      proofCapsule,
      "requested_action",
      input.tool.action,
      "api_tool_proof_action_required",
      blockedBy,
      "api_tool_proof_action_mismatch"
    );
    requireProofEvidenceBacked(proofCapsule, Object.keys(input.tool.proof_claim_mapping), blockedBy);
  }
  if (input.tool.enforcement.idempotency_required && typeof input.args["idempotency_key"] !== "string") {
    blockedBy.push("api_tool_idempotency_key_required");
  }
  if (!input.args["request"] || typeof input.args["request"] !== "object" || Array.isArray(input.args["request"])) {
    blockedBy.push("api_tool_request_required");
  }
  if (input.license_context.skill_id !== input.tool.skill_id) blockedBy.push("api_tool_skill_mismatch");
  if (input.license_context.license_id !== input.tool.license_id) blockedBy.push("api_tool_license_mismatch");
  if (input.license_context.license_version !== input.tool.license_version) blockedBy.push("api_tool_license_version_mismatch");
  if (input.license_context.action !== input.tool.action) blockedBy.push("api_tool_action_mismatch");
  if (input.tool.auth_scope && !input.license_context.auth_scopes?.includes(input.tool.auth_scope)) {
    blockedBy.push("api_tool_auth_scope_missing");
  }
  return {
    ok: blockedBy.length === 0,
    blocked_by: blockedBy,
  };
}

function buildToolInputSchema(candidate: DojoApiEndpointCandidate, mutation: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      proof_capsule: {
        type: "object",
        description: "Proof capsule validated by the Dojo skill bus before this API-backed tool executes.",
      },
      request: candidate.request_schema,
      ...(mutation
        ? {
            idempotency_key: {
              type: "string",
              description: `Required idempotency key carried in ${candidate.idempotency_key_location}.`,
            },
          }
        : {}),
    },
    required: mutation ? ["proof_capsule", "request", "idempotency_key"] : ["proof_capsule", "request"],
    additionalProperties: false,
  };
}

function actionForCandidate(candidate: DojoApiEndpointCandidate): string {
  return candidate.mutation_class === "read" ? "read_api" : "run_workflow";
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "endpoint";
}

function digestObject(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireMatchingProofField(
  proofCapsule: Record<string, unknown>,
  fieldName: string,
  expectedValue: string | undefined,
  missingCode: string,
  blockedBy: string[],
  mismatchCode?: string
): void {
  const value = proofCapsule[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    blockedBy.push(missingCode);
    return;
  }
  if (expectedValue !== undefined && value !== expectedValue) {
    blockedBy.push(mismatchCode ?? missingCode);
  }
}

function requireProofEvidenceBacked(
  proofCapsule: Record<string, unknown>,
  requiredClaims: string[],
  blockedBy: string[]
): void {
  const evidenceRecordIds = proofCapsule["evidence_record_ids"];
  if (!Array.isArray(evidenceRecordIds) || evidenceRecordIds.every((item) => typeof item !== "string" || item.trim().length === 0)) {
    blockedBy.push("api_tool_proof_evidence_records_required");
  }
  if (typeof proofCapsule["ledger_checkpoint_hash"] !== "string" || proofCapsule["ledger_checkpoint_hash"].trim().length === 0) {
    blockedBy.push("api_tool_proof_ledger_checkpoint_required");
  }

  const evidenceClaims = parseProofEvidenceClaims(proofCapsule["evidence_claims"]);
  for (const claim of requiredClaims) {
    const evidenceClaim = evidenceClaims.find((item) => item.claim === claim);
    if (!evidenceClaim) {
      blockedBy.push(`api_tool_proof_evidence_claim_missing:${claim}`);
      continue;
    }
    if (evidenceClaim.satisfied !== true) {
      blockedBy.push(`api_tool_proof_evidence_claim_unverified:${claim}`);
      continue;
    }
    if (evidenceClaim.evidence_refs.length === 0) {
      blockedBy.push(`api_tool_proof_evidence_claim_refs_required:${claim}`);
    }
  }
}

function parseProofEvidenceClaims(value: unknown): Array<{ claim: string; satisfied: boolean; evidence_refs: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record["claim"] !== "string" || record["claim"].trim().length === 0) return [];
    const refs = Array.isArray(record["evidence_refs"])
      ? record["evidence_refs"].filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
      : [];
    return [{
      claim: record["claim"],
      satisfied: record["satisfied"] === true,
      evidence_refs: refs,
    }];
  });
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
