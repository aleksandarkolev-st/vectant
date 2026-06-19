import { createHash } from "node:crypto";
import { reviewDojoApiEndpointCandidate } from "./endpoint_inference.js";
import { type DojoApiCandidateReviewIssue, type DojoApiEndpointCandidate, isMutationCandidate } from "./types.js";
import { evaluateDojoGuardrailPredicate, type DojoGuardrailPredicateResult } from "../graph/guardrail_runtime.js";

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
  query_schema: Record<string, unknown> | null;
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

export type DojoApiToolProofValidator = (input: {
  tool: DojoApiBackedMcpTool;
  proof_capsule: Record<string, unknown>;
  requested_action: string;
  license_context: DojoApiToolLicenseContext;
  args: Record<string, unknown>;
}) => DojoApiToolInvocationValidation | Promise<DojoApiToolInvocationValidation>;

export interface DojoApiToolHttpRequest {
  method: DojoApiEndpointCandidate["method"];
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface DojoApiToolHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface DojoApiToolExecutionEvidence {
  schema_version: "synthi.dojo.apiToolExecutionEvidence.v1";
  tool_name: string;
  tool_version: string;
  skill_id: string;
  license_id: string;
  license_version: string;
  action: string;
  candidate_id: string;
  request_digest: string;
  response_digest: string;
  proof_capsule_id: string;
  idempotency_key?: string;
  postcondition?: string;
  postcondition_ok?: boolean;
  blocked_by: string[];
}

export interface DojoApiToolExecutionResult {
  ok: boolean;
  status: "executed" | "blocked";
  blocked_by: string[];
  validation: DojoApiToolInvocationValidation;
  proof_validation?: DojoApiToolInvocationValidation;
  request?: DojoApiToolHttpRequest;
  response?: DojoApiToolHttpResponse;
  postcondition?: DojoGuardrailPredicateResult;
  evidence_record_id?: string;
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
    query_schema: input.candidate.query_schema ?? null,
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

export async function executeDojoApiBackedToolInvocation(input: {
  tool: DojoApiBackedMcpTool;
  args: Record<string, unknown>;
  license_context: DojoApiToolLicenseContext;
  validate_proof?: DojoApiToolProofValidator;
  transport: (request: DojoApiToolHttpRequest) => DojoApiToolHttpResponse | Promise<DojoApiToolHttpResponse>;
  write_evidence: (evidence: DojoApiToolExecutionEvidence) => string | Promise<string>;
}): Promise<DojoApiToolExecutionResult> {
  const validation = validateDojoApiBackedToolInvocation({
    tool: input.tool,
    args: input.args,
    license_context: input.license_context,
  });
  if (!validation.ok) {
    return { ok: false, status: "blocked", blocked_by: validation.blocked_by, validation };
  }

  const proofCapsule = objectRecord(input.args["proof_capsule"]);
  if (!proofCapsule) {
    const proofValidation = { ok: false, blocked_by: ["api_tool_proof_capsule_required"] };
    return { ok: false, status: "blocked", blocked_by: proofValidation.blocked_by, validation, proof_validation: proofValidation };
  }
  const proofValidation = await validateApiToolProof({
    tool: input.tool,
    proof_capsule: proofCapsule,
    requested_action: input.tool.action,
    license_context: input.license_context,
    args: input.args,
    validate_proof: input.validate_proof,
  });
  if (!proofValidation.ok) {
    return {
      ok: false,
      status: "blocked",
      blocked_by: proofValidation.blocked_by,
      validation,
      proof_validation: proofValidation,
    };
  }

  const request = buildHttpRequest(input.tool, input.args);
  let response: DojoApiToolHttpResponse;
  try {
    response = await input.transport(request);
  } catch {
    return {
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_transport_failed"],
      validation,
      proof_validation: proofValidation,
      request,
    };
  }

  const blockedBy: string[] = [];
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 400) {
    blockedBy.push("api_tool_http_status_failed");
  }
  const postcondition = input.tool.postcondition
    ? evaluateDojoGuardrailPredicate(
        input.tool.postcondition,
        apiPostconditionContext(input.tool.postcondition, request, response)
      )
    : undefined;
  if (postcondition && !postcondition.ok) {
    blockedBy.push(...postcondition.blocked_by.map((reason) => `api_tool_postcondition_${reason}`));
  }

  const idempotencyKey = typeof input.args["idempotency_key"] === "string" ? input.args["idempotency_key"] : undefined;
  const evidence: DojoApiToolExecutionEvidence = {
    schema_version: "synthi.dojo.apiToolExecutionEvidence.v1",
    tool_name: input.tool.tool_name,
    tool_version: input.tool.tool_version,
    skill_id: input.tool.skill_id,
    license_id: input.tool.license_id,
    license_version: input.tool.license_version,
    action: input.tool.action,
    candidate_id: input.tool.candidate_id,
    request_digest: digestObject(request),
    response_digest: digestObject(response),
    proof_capsule_id: typeof proofCapsule?.["capsule_id"] === "string" ? proofCapsule["capsule_id"] : "",
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(input.tool.postcondition ? { postcondition: input.tool.postcondition } : {}),
    ...(postcondition ? { postcondition_ok: postcondition.ok } : {}),
    blocked_by: blockedBy,
  };

  let evidenceRecordId: string;
  try {
    evidenceRecordId = await input.write_evidence(evidence);
  } catch {
    return {
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_evidence_write_failed"],
      validation,
      proof_validation: proofValidation,
      request,
      response,
      ...(postcondition ? { postcondition } : {}),
    };
  }
  if (!evidenceRecordId.trim()) {
    return {
      ok: false,
      status: "blocked",
      blocked_by: ["api_tool_evidence_record_id_required"],
      validation,
      proof_validation: proofValidation,
      request,
      response,
      ...(postcondition ? { postcondition } : {}),
    };
  }

  return {
    ok: blockedBy.length === 0,
    status: blockedBy.length === 0 ? "executed" : "blocked",
    blocked_by: blockedBy,
    validation,
    proof_validation: proofValidation,
    request,
    response,
    ...(postcondition ? { postcondition } : {}),
    evidence_record_id: evidenceRecordId,
  };
}

async function validateApiToolProof(input: {
  tool: DojoApiBackedMcpTool;
  proof_capsule: Record<string, unknown>;
  requested_action: string;
  license_context: DojoApiToolLicenseContext;
  args: Record<string, unknown>;
  validate_proof?: DojoApiToolProofValidator;
}): Promise<DojoApiToolInvocationValidation> {
  if (!input.validate_proof) {
    return { ok: false, blocked_by: ["api_tool_proof_validator_required"] };
  }
  try {
    const result = await input.validate_proof({
      tool: input.tool,
      proof_capsule: input.proof_capsule,
      requested_action: input.requested_action,
      license_context: input.license_context,
      args: input.args,
    });
    const blockedBy = [...(result.blocked_by ?? [])];
    if (!result.ok && blockedBy.length === 0) blockedBy.push("api_tool_proof_validation_failed");
    return {
      ok: result.ok === true && blockedBy.length === 0,
      blocked_by: blockedBy,
    };
  } catch {
    return { ok: false, blocked_by: ["api_tool_proof_validation_failed"] };
  }
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
    requireMatchingProofField(
      proofCapsule,
      "substrate_claim",
      "api",
      "api_tool_proof_substrate_required",
      blockedBy,
      "api_tool_proof_substrate_mismatch"
    );
    requireProofEvidenceBacked(proofCapsule, Object.keys(input.tool.proof_claim_mapping), blockedBy);
  }
  if (input.tool.enforcement.idempotency_required && typeof input.args["idempotency_key"] !== "string") {
    blockedBy.push("api_tool_idempotency_key_required");
  }
  if (!input.args["request"] || typeof input.args["request"] !== "object" || Array.isArray(input.args["request"])) {
    blockedBy.push("api_tool_request_required");
  } else {
    blockedBy.push(...validateToolInputSchema(input.tool.input_schema, input.args));
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

function validateToolInputSchema(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const blockedBy: string[] = [];
  const schemaProperties = objectRecord(schema["properties"]) ?? {};
  const topLevelAdditional = schema["additionalProperties"];
  if (topLevelAdditional === false) {
    const allowed = new Set(Object.keys(schemaProperties));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) blockedBy.push(`api_tool_input_schema_additional_property:${key}`);
    }
  }

  const requestSchema = objectRecord(schemaProperties["request"]);
  if (requestSchema) {
    blockedBy.push(...validateJsonSchemaSubset(requestSchema, args["request"], "request", "api_tool_request_schema"));
  }
  const querySchema = objectRecord(schemaProperties["query"]);
  if (querySchema) {
    blockedBy.push(...validateJsonSchemaSubset(querySchema, args["query"], "query", "api_tool_query_schema"));
  }
  return [...new Set(blockedBy)];
}

function validateJsonSchemaSubset(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  codePrefix: string
): string[] {
  const blockedBy: string[] = [];
  const type = schemaType(schema);
  if (type && !matchesJsonSchemaType(value, type)) {
    return [`${codePrefix}_type_mismatch:${path}`];
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonEqual(value, schema["const"])) {
    blockedBy.push(`${codePrefix}_const_mismatch:${path}`);
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => jsonEqual(value, item))) {
    blockedBy.push(`${codePrefix}_enum_mismatch:${path}`);
  }

  if ((type === "object" || (!type && objectRecord(value))) && objectRecord(value)) {
    const record = value as Record<string, unknown>;
    const properties = objectRecord(schema["properties"]) ?? {};
    const required = stringArray(schema["required"]);
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        blockedBy.push(`${codePrefix}_required:${joinSchemaPath(path, key)}`);
      }
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          blockedBy.push(`${codePrefix}_additional_property:${joinSchemaPath(path, key)}`);
        }
      }
    }
    for (const [key, nestedSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const nested = objectRecord(nestedSchema);
      if (nested) {
        blockedBy.push(...validateJsonSchemaSubset(nested, record[key], joinSchemaPath(path, key), codePrefix));
      }
    }
  }

  if ((type === "array" || (!type && Array.isArray(value))) && Array.isArray(value)) {
    const itemSchema = objectRecord(schema["items"]);
    if (itemSchema) {
      value.forEach((item, index) => {
        blockedBy.push(...validateJsonSchemaSubset(itemSchema, item, `${path}[${index}]`, codePrefix));
      });
    }
  }

  return blockedBy;
}

function buildHttpRequest(tool: DojoApiBackedMcpTool, args: Record<string, unknown>): DojoApiToolHttpRequest {
  const requestBody = cloneJson(args["request"] ?? {});
  const request: DojoApiToolHttpRequest = {
    method: tool.method,
    path: tool.path,
    headers: {},
    query: queryRecordFromArgs(args["query"]),
    body: requestBody,
  };
  const idempotencyKey = typeof args["idempotency_key"] === "string" ? args["idempotency_key"] : undefined;
  if (idempotencyKey && tool.idempotency_key_location) {
    if (tool.idempotency_key_location === "header") {
      request.headers["Idempotency-Key"] = idempotencyKey;
    } else if (tool.idempotency_key_location === "query") {
      request.query["idempotency_key"] = idempotencyKey;
    } else if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
      request.body = { ...(request.body as Record<string, unknown>), idempotency_key: idempotencyKey };
    }
  }
  return request;
}

function buildToolInputSchema(candidate: DojoApiEndpointCandidate, mutation: boolean): Record<string, unknown> {
  const queryRequired = hasSchemaProperties(candidate.query_schema);
  const required = [
    "proof_capsule",
    "request",
    ...(queryRequired ? ["query"] : []),
    ...(mutation ? ["idempotency_key"] : []),
  ];
  return {
    type: "object",
    properties: {
      proof_capsule: {
        type: "object",
        description: "Proof capsule validated by the Dojo skill bus before this API-backed tool executes.",
      },
      request: candidate.request_schema,
      ...(candidate.query_schema ? { query: candidate.query_schema } : {}),
      ...(mutation
        ? {
            idempotency_key: {
              type: "string",
              description: `Required idempotency key carried in ${candidate.idempotency_key_location}.`,
            },
          }
        : {}),
    },
    required,
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

function queryRecordFromArgs(value: unknown): Record<string, string> {
  const record = objectRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, nested]) => typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean")
      .map(([key, nested]): [string, string] => [key, String(nested)])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function hasSchemaProperties(schema: Record<string, unknown> | undefined): boolean {
  const properties = schema ? objectRecord(schema["properties"]) : null;
  return Boolean(properties && Object.keys(properties).length > 0);
}

function schemaType(schema: Record<string, unknown>): string | null {
  const type = schema["type"];
  if (typeof type === "string" && type.trim().length > 0) return type.trim();
  if (Array.isArray(type)) {
    const types = type.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    const onlyType = types[0];
    return types.length === 1 && onlyType ? onlyType.trim() : null;
  }
  return null;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function joinSchemaPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
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
  const evidenceRecordIdSet = new Set(
    Array.isArray(evidenceRecordIds)
      ? evidenceRecordIds
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .flatMap(evidenceRecordReferenceKeys)
      : []
  );
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
      continue;
    }
    const unboundRefs = evidenceClaim.evidence_refs.filter((ref) =>
      evidenceRecordReferenceKeys(ref).every((key) => !evidenceRecordIdSet.has(key))
    );
    if (unboundRefs.length > 0) {
      blockedBy.push(`api_tool_proof_evidence_claim_ref_unbound:${claim}`);
    }
  }
}

function evidenceRecordReferenceKeys(value: string): string[] {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith("evidence:") ? trimmed.slice("evidence:".length) : trimmed;
  return [...new Set([trimmed, withoutPrefix, `evidence:${withoutPrefix}`])];
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

function apiPostconditionContext(
  postcondition: string,
  request: DojoApiToolHttpRequest,
  response: DojoApiToolHttpResponse
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    "http.status": response.status,
    "response.status": response.status,
    status_code: response.status,
  };
  if (response.body && typeof response.body === "object" && !Array.isArray(response.body)) {
    const flattened = flattenObject(response.body as Record<string, unknown>);
    Object.assign(context, flattened);
    for (const [path, value] of Object.entries(flattened)) {
      context[`response.${path}`] = value;
    }
  }
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
    for (const [path, value] of Object.entries(flattenObject(request.body as Record<string, unknown>))) {
      context[`request.${path}`] = value;
    }
  }
  for (const [path, value] of Object.entries(request.query)) {
    context[`request.query.${path}`] = value;
  }
  const key = postcondition.match(/^([a-zA-Z0-9_.-]+)\s*(?:==|!=|<=|>=|<|>|\s+in\s+)/)?.[1];
  if (key && context[key] === undefined && key.includes(".")) {
    const suffix = key.split(".").slice(1).join(".");
    if (suffix && context[suffix] !== undefined) context[key] = context[suffix];
  }
  return context;
}

function flattenObject(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        return [[path, nested], ...Object.entries(flattenObject(nested as Record<string, unknown>, path))];
      }
      return [[path, nested]];
    })
  );
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
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
