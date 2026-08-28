import {
  validateDojoProofCapsule,
  type DojoProofCarryingSkillCapsule,
  type DojoProofValidation,
  type DojoSkill,
} from "./dojo.js";
import type { DojoSkillRegistry } from "./dojo.js";
import type { DojoProofCapsuleRecord, DojoProofConsumeResult } from "./dojo_store.js";
import { normalizeDojoProofErrorCodes, type DojoProofErrorCode } from "../dojo/proof/errors.js";
import type { DojoProofVerifier } from "../dojo/proof/signing.js";
import type { DojoEvidenceClaimResult } from "../dojo/evidence/claims.js";
import type { DojoPermissionLicenseRecord } from "../dojo/store/interfaces.js";

export interface DojoLicenseKernelDecision {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  validation: DojoProofValidation;
  blocked_by: string[];
  error_codes: DojoProofErrorCode[];
  proof_record?: DojoProofCapsuleRecord | null;
  license_record?: DojoPermissionLicenseRecord | null;
  runtime_claims: {
    tenant_id?: string;
    organization_id?: string;
    workspace_id: string;
    app_origin: string;
    requested_action: string;
    dry_run: boolean;
    actor_id?: string;
    actor_type?: "human" | "agent" | "service";
    roles?: string[];
    request_id?: string;
    correlation_id?: string;
    approval_id?: string;
    approval_evidence_ref?: string;
    approval_evidence_verified?: boolean;
    approval_evidence_record_ids?: string[];
  };
}

export function evaluateDojoLicenseKernel(input: {
  skill: DojoSkill;
  registry: DojoSkillRegistry;
  proof_record?: DojoProofCapsuleRecord | null;
  license_record?: DojoPermissionLicenseRecord | null;
  require_durable_license?: boolean;
  proof_capsule: DojoProofCarryingSkillCapsule;
  requested_action: string;
  tool_args?: Record<string, unknown>;
  dry_run?: boolean;
  now?: string;
  evidence_claim_results?: DojoEvidenceClaimResult[];
  require_verified_approval_evidence?: boolean;
  proof_validation_options?: {
    now?: string;
    issuer?: string;
    expected_key_id?: string;
    verifier?: DojoProofVerifier | null;
  };
}): DojoLicenseKernelDecision {
  const now = input.now ?? new Date().toISOString();
  const dryRun = input.dry_run === true;
  const toolArgs = input.tool_args ?? {};
  const validation = validateDojoProofCapsule(
    input.skill,
    input.proof_capsule,
    input.requested_action,
    input.proof_validation_options ?? now
  );
  const approval = evaluateApprovalContext({
    skill: input.skill,
    requested_action: input.requested_action,
    proof_capsule: input.proof_capsule,
    validation,
    tool_args: toolArgs,
    evidence_claim_results: input.evidence_claim_results ?? [],
    require_verified_approval_evidence: input.require_verified_approval_evidence === true,
  });
  const tenantId = stringOpt(toolArgs["tenant_id"]) ?? stringOpt(toolArgs["tenant"]);
  const organizationId = stringOpt(toolArgs["organization_id"]) ?? stringOpt(toolArgs["organization"]);
  const requestId = stringOpt(toolArgs["request_id"]);
  const correlationId = stringOpt(toolArgs["correlation_id"]);
  const roles = stringArrayOpt(toolArgs["roles"]);
  const hardBlockedBy: string[] = validation.status === "blocked" ? [...validation.blocked_by] : [];
  const approvalBlockedBy: string[] = validation.status === "approval_required" && !approval.satisfied
    ? validation.blocked_by.map((reason) => `approval_constraint:${reason}`)
    : [];

  const record = input.proof_record === undefined
    ? input.registry.getProofRecord(input.proof_capsule.capsule_id)
    : input.proof_record;
  if (!record) {
    hardBlockedBy.push("proof_capsule_not_issued_by_registry");
  } else {
    if (record.status === "revoked") hardBlockedBy.push("proof_capsule_revoked");
    if (!dryRun && record.status === "used") hardBlockedBy.push("proof_capsule_replay_detected");
    if (record.skill_id !== input.skill.skill_id) hardBlockedBy.push("proof_record_skill_mismatch");
    if (record.requested_action !== input.requested_action) hardBlockedBy.push("proof_record_action_mismatch");
    if (record.nonce && record.nonce !== input.proof_capsule.nonce) hardBlockedBy.push("proof_record_nonce_mismatch");
    hardBlockedBy.push(...proofRecordMetadataMismatches(record, input.skill, input.proof_capsule, toolArgs));
  }
  hardBlockedBy.push(...durableLicenseRecordFailures({
    license_record: input.license_record,
    require_durable_license: input.require_durable_license === true,
    skill: input.skill,
    now,
  }));

  const licenseExpiresAtMs = parseTimestamp(input.skill.license_expires_at);
  const nowMs = parseTimestamp(now);
  if (licenseExpiresAtMs === undefined) {
    hardBlockedBy.push("license_expiry_invalid");
  } else if (nowMs !== undefined && licenseExpiresAtMs <= nowMs) {
    hardBlockedBy.push("license_expired");
  }

  const workspaceArg = stringOpt(toolArgs["workspace_id"]) ?? stringOpt(toolArgs["workspace"]);
  if (workspaceArg && workspaceArg !== input.skill.workspace_id) {
    hardBlockedBy.push("workspace_mismatch");
  }

  const urlArg = stringOpt(toolArgs["url"]) ?? stringOpt(toolArgs["workspace_url"]) ?? stringOpt(toolArgs["preview_url"]);
  if (urlArg) {
    try {
      const origin = new URL(urlArg).origin;
      if (input.skill.app_origin && origin !== input.skill.app_origin) hardBlockedBy.push("app_origin_mismatch");
    } catch {
      hardBlockedBy.push("app_origin_unparseable");
    }
  }

  if (input.proof_capsule.context_claims["workspace_verified"] !== true) {
    hardBlockedBy.push("runtime_workspace_not_verified");
  }

  if (approval.required && !approval.satisfied) approvalBlockedBy.push(...approval.blocked_by);

  const blockedBy = [...hardBlockedBy, ...approvalBlockedBy];
  const status = hardBlockedBy.length > 0
    ? "blocked"
    : approvalBlockedBy.length > 0
    ? "approval_required"
    : "allowed";
  const errorCodes = normalizedLicenseKernelErrorCodes(blockedBy, status);

  return {
    ok: status === "allowed",
    status,
    validation: {
      ...validation,
      ok: status === "allowed",
      status,
      error: status === "allowed" ? undefined : validation.error ?? (status === "approval_required" ? "dojo_action_requires_approval" : "dojo_license_kernel_blocked"),
      blocked_by: blockedBy,
      error_codes: errorCodes,
    },
    blocked_by: blockedBy,
    error_codes: errorCodes,
    proof_record: record,
    license_record: input.license_record,
    runtime_claims: {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...(organizationId ? { organization_id: organizationId } : {}),
      workspace_id: input.skill.workspace_id,
      app_origin: input.skill.app_origin,
      requested_action: input.requested_action,
      dry_run: dryRun,
      ...(approval.actor_id ? { actor_id: approval.actor_id } : {}),
      ...(approval.actor_type ? { actor_type: approval.actor_type } : {}),
      ...(roles.length ? { roles } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(approval.approval_id ? { approval_id: approval.approval_id } : {}),
      ...(approval.approval_evidence_ref ? { approval_evidence_ref: approval.approval_evidence_ref } : {}),
      ...(approval.evidence_verified ? { approval_evidence_verified: true } : {}),
      ...(approval.evidence_record_ids.length ? { approval_evidence_record_ids: approval.evidence_record_ids } : {}),
    },
  };
}

function evaluateApprovalContext(input: {
  skill: DojoSkill;
  requested_action: string;
  proof_capsule: DojoProofCarryingSkillCapsule;
  validation: DojoProofValidation;
  tool_args: Record<string, unknown>;
  evidence_claim_results: DojoEvidenceClaimResult[];
  require_verified_approval_evidence: boolean;
}): {
  required: boolean;
  satisfied: boolean;
  blocked_by: string[];
  actor_id?: string;
  actor_type?: "human" | "agent" | "service";
  approval_id?: string;
  approval_evidence_ref?: string;
  evidence_verified: boolean;
  evidence_record_ids: string[];
} {
  const required = input.validation.status === "approval_required"
    || input.skill.permission_license.approval_requirements.includes(input.requested_action)
    || input.skill.permission_license.gated_actions.some((action) => action.action === input.requested_action);
  const actorId = stringOpt(input.tool_args["actor_id"]) ?? stringOpt(input.tool_args["actor"]);
  const actorType = actorTypeOpt(input.tool_args["actor_type"]);
  const approvalId = stringOpt(input.tool_args["approval_id"]);
  const approvalEvidenceRef = stringOpt(input.tool_args["approval_evidence_ref"]);
  const approvalStatus = approvalStatusOpt(input.tool_args);
  const verifiedEvidence = verifiedApprovalEvidence({
    proof_capsule: input.proof_capsule,
    evidence_claim_results: input.evidence_claim_results,
    approval_evidence_ref: approvalEvidenceRef,
  });
  const blockedBy: string[] = [];

  if (!required) {
    return {
      required: false,
      satisfied: false,
      blocked_by: [],
      ...(actorId ? { actor_id: actorId } : {}),
      ...(actorType ? { actor_type: actorType } : {}),
      ...(approvalId ? { approval_id: approvalId } : {}),
      ...(approvalEvidenceRef ? { approval_evidence_ref: approvalEvidenceRef } : {}),
      evidence_verified: false,
      evidence_record_ids: [],
    };
  }

  if (!approvalId) blockedBy.push("approval_required");
  const approvedByVerifiedEvidence = input.require_verified_approval_evidence && verifiedEvidence.satisfied;
  if (approvalStatus !== "approved" && !approvedByVerifiedEvidence) blockedBy.push("approval_not_granted");
  if (!actorId) blockedBy.push("approval_actor_required");
  if (!actorType) blockedBy.push("approval_actor_type_required");
  if (!approvalEvidenceRef) blockedBy.push("approval_evidence_required");
  if (input.require_verified_approval_evidence && !verifiedEvidence.satisfied) {
    blockedBy.push("approval_evidence_claim_unverified");
  }

  return {
    required: true,
    satisfied: blockedBy.length === 0,
    blocked_by: blockedBy,
    ...(actorId ? { actor_id: actorId } : {}),
    ...(actorType ? { actor_type: actorType } : {}),
    ...(approvalId ? { approval_id: approvalId } : {}),
    ...(approvalEvidenceRef ? { approval_evidence_ref: approvalEvidenceRef } : {}),
    evidence_verified: verifiedEvidence.satisfied,
    evidence_record_ids: verifiedEvidence.evidence_record_ids,
  };
}

function verifiedApprovalEvidence(input: {
  proof_capsule: DojoProofCarryingSkillCapsule;
  evidence_claim_results: DojoEvidenceClaimResult[];
  approval_evidence_ref?: string;
}): {
  satisfied: boolean;
  evidence_record_ids: string[];
} {
  const requiredRecordId = evidenceRecordIdFromRef(input.approval_evidence_ref);
  const resultRecordIds = input.evidence_claim_results
    .filter((claim) => claim.claim_id === "approval_granted" && claim.ok)
    .flatMap((claim) => claim.evidence_record_ids);
  const capsuleRecordIds = input.proof_capsule.evidence_claims
    .filter((claim) => claim.claim === "approval_granted" && claim.satisfied)
    .flatMap((claim) => evidenceRecordIdsFromRefs(claim.evidence_refs));
  const evidenceRecordIds = uniqueStrings([...resultRecordIds, ...capsuleRecordIds]);
  return {
    satisfied: requiredRecordId ? evidenceRecordIds.includes(requiredRecordId) : evidenceRecordIds.length > 0,
    evidence_record_ids: evidenceRecordIds,
  };
}

function proofRecordMetadataMismatches(
  record: DojoProofCapsuleRecord,
  skill: DojoSkill,
  capsule: DojoProofCarryingSkillCapsule,
  toolArgs: Record<string, unknown>
): string[] {
  const blockedBy: string[] = [];
  const tenantArg = stringOpt(toolArgs["tenant_id"]) ?? stringOpt(toolArgs["tenant"]);

  if (record.tenant_id && tenantArg && record.tenant_id !== tenantArg) {
    blockedBy.push("proof_record_tenant_mismatch");
  }
  if (record.workspace_id && record.workspace_id !== skill.workspace_id) {
    blockedBy.push("proof_record_workspace_mismatch");
  }
  if (record.license_id && record.license_id !== skill.permission_license.license_id) {
    blockedBy.push("proof_record_license_mismatch");
  }
  if (record.license_version && record.license_version !== capsule.license_version) {
    blockedBy.push("proof_record_license_version_mismatch");
  }
  if (record.key_id && record.key_id !== capsule.key_id) {
    blockedBy.push("proof_record_key_mismatch");
  }
  if (record.signature_algorithm && record.signature_algorithm !== capsule.signature_algorithm) {
    blockedBy.push("proof_record_signature_algorithm_mismatch");
  }
  if (record.issued_at !== capsule.issued_at) {
    blockedBy.push("proof_record_issued_at_mismatch");
  }
  if (record.expires_at !== capsule.expires_at) {
    blockedBy.push("proof_record_expires_at_mismatch");
  }
  if (record.substrate_claim && record.substrate_claim !== capsule.substrate_claim) {
    blockedBy.push("proof_record_substrate_mismatch");
  }
  if (record.ledger_checkpoint_hash && record.ledger_checkpoint_hash !== capsule.ledger_checkpoint_hash) {
    blockedBy.push("proof_record_ledger_checkpoint_mismatch");
  }
  if (
    record.evidence_record_ids &&
    !sameStringSet(record.evidence_record_ids, capsule.evidence_record_ids)
  ) {
    blockedBy.push("proof_record_evidence_mismatch");
  }

  return blockedBy;
}

function durableLicenseRecordFailures(input: {
  license_record?: DojoPermissionLicenseRecord | null;
  require_durable_license: boolean;
  skill: DojoSkill;
  now: string;
}): string[] {
  const record = input.license_record;
  if (!record) return input.require_durable_license ? ["license_record_missing"] : [];
  const blockedBy: string[] = [];
  const skillLicense = input.skill.permission_license;
  if (record.skill_id !== input.skill.skill_id) blockedBy.push("license_record_skill_mismatch");
  if (record.workspace_id !== input.skill.workspace_id) blockedBy.push("license_record_workspace_mismatch");
  if (record.license_id !== skillLicense.license_id) blockedBy.push("license_record_license_mismatch");
  if (record.license_version !== skillLicense.license_version) blockedBy.push("license_record_license_version_mismatch");
  if (record.status === "revoked") blockedBy.push("license_revoked");
  if (record.status === "expired") blockedBy.push("license_expired");
  if (record.status === "superseded") blockedBy.push("license_superseded");
  const nowMs = parseTimestamp(input.now);
  const recordExpiresAt = record.expires_at;
  const recordExpiresAtMs = recordExpiresAt ? parseTimestamp(recordExpiresAt) : undefined;
  if (recordExpiresAt && recordExpiresAtMs === undefined) blockedBy.push("license_record_expiry_invalid");
  if (nowMs !== undefined && recordExpiresAtMs !== undefined && recordExpiresAtMs <= nowMs) {
    blockedBy.push("license_expired");
  }
  return blockedBy;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function evidenceRecordIdFromRef(ref: string | undefined): string | undefined {
  if (!ref?.startsWith("evidence:")) return undefined;
  const recordId = ref.slice("evidence:".length).trim();
  return recordId.length > 0 ? recordId : undefined;
}

function evidenceRecordIdsFromRefs(refs: string[] | undefined): string[] {
  return uniqueStrings((refs ?? [])
    .map(evidenceRecordIdFromRef)
    .filter((recordId): recordId is string => Boolean(recordId)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizedLicenseKernelErrorCodes(
  blockedBy: string[],
  status: DojoLicenseKernelDecision["status"]
): DojoProofErrorCode[] {
  const codes = normalizeDojoProofErrorCodes(blockedBy);
  if (status === "approval_required" && !codes.includes("approval_required")) codes.push("approval_required");
  return codes;
}

export function markDojoProofExecution(input: {
  registry: DojoSkillRegistry;
  proof_capsule: DojoProofCarryingSkillCapsule;
  run_id?: string;
  now?: string;
}): DojoProofConsumeResult {
  return input.registry.consumeProofCapsule(input.proof_capsule.capsule_id, {
    run_id: input.run_id,
    now: input.now,
  });
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayOpt(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function actorTypeOpt(value: unknown): "human" | "agent" | "service" | undefined {
  return value === "human" || value === "agent" || value === "service" ? value : undefined;
}

function approvalStatusOpt(toolArgs: Record<string, unknown>): "approved" | "denied" | "pending" | undefined {
  const status = stringOpt(toolArgs["approval_status"]);
  if (status === "approved" || status === "denied" || status === "pending") return status;
  return undefined;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
