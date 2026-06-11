import {
  validateDojoProofCapsule,
  type DojoProofCarryingSkillCapsule,
  type DojoProofValidation,
  type DojoSkill,
} from "./dojo.js";
import type { DojoSkillRegistry } from "./dojo.js";
import type { DojoProofCapsuleRecord } from "./dojo_store.js";

export interface DojoLicenseKernelDecision {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  validation: DojoProofValidation;
  blocked_by: string[];
  proof_record?: DojoProofCapsuleRecord | null;
  runtime_claims: {
    workspace_id: string;
    app_origin: string;
    requested_action: string;
    dry_run: boolean;
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
  const blockedBy: string[] = [];
  const validation = validateDojoProofCapsule(input.skill, input.proof_capsule, input.requested_action, now);
  blockedBy.push(...validation.blocked_by);

  const record = input.registry.getProofRecord(input.proof_capsule.capsule_id);
  if (!record) {
    blockedBy.push("proof_capsule_not_issued_by_registry");
  } else {
    if (record.status === "revoked") blockedBy.push("proof_capsule_revoked");
    if (!dryRun && record.status === "used") blockedBy.push("proof_capsule_replay_detected");
    if (record.skill_id !== input.skill.skill_id) blockedBy.push("proof_record_skill_mismatch");
    if (record.requested_action !== input.requested_action) blockedBy.push("proof_record_action_mismatch");
    if (record.nonce && record.nonce !== input.proof_capsule.nonce) blockedBy.push("proof_record_nonce_mismatch");
  }

  if (Date.parse(input.skill.license_expires_at) <= Date.parse(now)) {
    blockedBy.push("license_expired");
  }

  const toolArgs = input.tool_args ?? {};
  const workspaceArg = stringOpt(toolArgs["workspace_id"]) ?? stringOpt(toolArgs["workspace"]);
  if (workspaceArg && workspaceArg !== input.skill.workspace_id) {
    blockedBy.push("workspace_mismatch");
  }

  const urlArg = stringOpt(toolArgs["url"]) ?? stringOpt(toolArgs["workspace_url"]) ?? stringOpt(toolArgs["preview_url"]);
  if (urlArg) {
    try {
      const origin = new URL(urlArg).origin;
      if (input.skill.app_origin && origin !== input.skill.app_origin) blockedBy.push("app_origin_mismatch");
    } catch {
      blockedBy.push("app_origin_unparseable");
    }
  }

  if (input.proof_capsule.context_claims["workspace_verified"] !== true) {
    blockedBy.push("runtime_workspace_not_verified");
  }

  const status = blockedBy.length > 0
    ? "blocked"
    : validation.status === "approval_required"
    ? "approval_required"
    : "allowed";

  return {
    ok: status === "allowed",
    status,
    validation: {
      ...validation,
      ok: status === "allowed",
      status,
      error: status === "allowed" ? undefined : validation.error ?? (status === "approval_required" ? "dojo_action_requires_approval" : "dojo_license_kernel_blocked"),
      blocked_by: blockedBy,
    },
    blocked_by: blockedBy,
    proof_record: record,
    runtime_claims: {
      workspace_id: input.skill.workspace_id,
      app_origin: input.skill.app_origin,
      requested_action: input.requested_action,
      dry_run: dryRun,
    },
  };
}

export function markDojoProofExecution(input: {
  registry: DojoSkillRegistry;
  proof_capsule: DojoProofCarryingSkillCapsule;
  now?: string;
}): DojoProofCapsuleRecord | null {
  return input.registry.markProofCapsuleUsed(input.proof_capsule.capsule_id, input.now);
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
