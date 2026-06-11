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
  license_context: { skill_id: string; license_id: string; license_version: string; action: string };
}): DojoApiToolInvocationValidation {
  const blockedBy: string[] = [];
  if (!input.args["proof_capsule"] || typeof input.args["proof_capsule"] !== "object") {
    blockedBy.push("api_tool_proof_capsule_required");
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
