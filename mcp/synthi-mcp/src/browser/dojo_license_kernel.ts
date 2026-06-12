import {
  validateDojoProofCapsule,
  type DojoProofCarryingSkillCapsule,
  type DojoProofValidation,
  type DojoSkill,
} from "./dojo.js";
import type { DojoSkillRegistry } from "./dojo.js";
import type { DojoProofCapsuleRecord, DojoProofConsumeResult } from "./dojo_store.js";
import { normalizeDojoProofErrorCodes, type DojoProofErrorCode } from "../dojo/proof/errors.js";

export interface DojoLicenseKernelDecision {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  validation: DojoProofValidation;
  blocked_by: string[];
  error_codes: DojoProofErrorCode[];
  proof_record?: DojoProofCapsuleRecord | null;
  runtime_claims: {
    workspace_id: string;
    app_origin: string;
    requested_action: string;
    dry_run: boolean;
    actor_id?: string;
    actor_type?: "human" | "agent" | "service";
    approval_id?: string;
  };
}

export function evaluateDojoLicenseKernel(input: {
  skill: DojoSkill;
  registry: DojoSkillRegistry;
  proof_capsule: DojoProofCarryingSkillCapsule;
  requested_action: string;
  tool_args?: Record<string, unknown>;
  dry_run?: boolean;
  now?: string;
}): DojoLicenseKernelDecision {
  const now = input.now ?? new Date().toISOString();
  const dryRun = input.dry_run === true;
  const toolArgs = input.tool_args ?? {};
  const validation = validateDojoProofCapsule(input.skill, input.proof_capsule, input.requested_action, now);
  const approval = evaluateApprovalContext(input.skill, input.requested_action, validation, toolArgs);
  const hardBlockedBy: string[] = validation.status === "blocked" ? [...validation.blocked_by] : [];
  const approvalBlockedBy: string[] = validation.status === "approval_required" && !approval.satisfied
    ? validation.blocked_by.map((reason) => `approval_constraint:${reason}`)
    : [];

  const record = input.registry.getProofRecord(input.proof_capsule.capsule_id);
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

  if (Date.parse(input.skill.license_expires_at) <= Date.parse(now)) {
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
    runtime_claims: {
      workspace_id: input.skill.workspace_id,
      app_origin: input.skill.app_origin,
      requested_action: input.requested_action,
      dry_run: dryRun,
      ...(approval.actor_id ? { actor_id: approval.actor_id } : {}),
      ...(approval.actor_type ? { actor_type: approval.actor_type } : {}),
      ...(approval.approval_id ? { approval_id: approval.approval_id } : {}),
    },
  };
}

function evaluateApprovalContext(
  skill: DojoSkill,
  requestedAction: string,
  validation: DojoProofValidation,
  toolArgs: Record<string, unknown>
): {
  required: boolean;
  satisfied: boolean;
  blocked_by: string[];
  actor_id?: string;
  actor_type?: "human" | "agent" | "service";
  approval_id?: string;
} {
  const required = validation.status === "approval_required"
    || skill.permission_license.approval_requirements.includes(requestedAction)
    || skill.permission_license.gated_actions.some((action) => action.action === requestedAction);
  const actorId = stringOpt(toolArgs["actor_id"]) ?? stringOpt(toolArgs["actor"]);
  const actorType = actorTypeOpt(toolArgs["actor_type"]);
  const approvalId = stringOpt(toolArgs["approval_id"]);
  const approvalStatus = approvalStatusOpt(toolArgs);
  const blockedBy: string[] = [];

  if (!required) {
    return {
      required: false,
      satisfied: false,
      blocked_by: [],
      ...(actorId ? { actor_id: actorId } : {}),
      ...(actorType ? { actor_type: actorType } : {}),
      ...(approvalId ? { approval_id: approvalId } : {}),
    };
  }

  if (!approvalId) blockedBy.push("approval_required");
  if (approvalStatus !== "approved") blockedBy.push("approval_not_granted");
  if (!actorId) blockedBy.push("approval_actor_required");
  if (!actorType) blockedBy.push("approval_actor_type_required");

  return {
    required: true,
    satisfied: blockedBy.length === 0,
    blocked_by: blockedBy,
    ...(actorId ? { actor_id: actorId } : {}),
    ...(actorType ? { actor_type: actorType } : {}),
    ...(approvalId ? { approval_id: approvalId } : {}),
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

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
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

function actorTypeOpt(value: unknown): "human" | "agent" | "service" | undefined {
  return value === "human" || value === "agent" || value === "service" ? value : undefined;
}

function approvalStatusOpt(toolArgs: Record<string, unknown>): "approved" | "denied" | "pending" | undefined {
  const status = stringOpt(toolArgs["approval_status"]);
  if (status === "approved" || status === "denied" || status === "pending") return status;
  if (toolArgs["approval_granted"] === true || toolArgs["approved"] === true) return "approved";
  if (toolArgs["approval_granted"] === false || toolArgs["approved"] === false) return "denied";
  return undefined;
}
