export const DOJO_PROOF_ERROR_CODES = [
  "proof_capsule_missing",
  "proof_capsule_invalid",
  "proof_capsule_not_issued",
  "proof_capsule_revoked",
  "proof_capsule_replay_detected",
  "proof_capsule_registry_mismatch",
  "proof_signature_invalid",
  "proof_context_claim_unverified",
  "proof_evidence_claim_unverified",
  "license_expired",
  "license_revoked",
  "action_not_licensed",
  "substrate_not_allowed",
  "workspace_mismatch",
  "origin_mismatch",
  "approval_required",
  "guardrail_failed",
  "dojo_execution_policy_blocked",
  "unknown",
] as const;

export type DojoProofErrorCode = (typeof DOJO_PROOF_ERROR_CODES)[number];

export type DojoProofRefusalCategory =
  | "missing_or_invalid_proof"
  | "proof_replay_or_revocation"
  | "claim_verification_failed"
  | "license_scope_failed"
  | "runtime_context_failed"
  | "approval_or_guardrail_required"
  | "unknown";

export function normalizeDojoProofErrorCode(reason: string): DojoProofErrorCode {
  if (reason === "proof_capsule_missing" || reason === "dojo_proof_capsule_required") return "proof_capsule_missing";
  if (reason === "proof_capsule_revoked") return "proof_capsule_revoked";
  if (reason === "proof_capsule_replay_detected") return "proof_capsule_replay_detected";
  if (reason === "proof_capsule_not_issued_by_registry" || reason === "proof_capsule_not_issued") return "proof_capsule_not_issued";
  if (reason.startsWith("proof_record_")) return "proof_capsule_registry_mismatch";
  if (reason === "proof_capsule_signature_invalid" || reason === "proof_capsule_signature_algorithm_mismatch") return "proof_signature_invalid";
  if (
    reason === "proof_capsule_schema_version_mismatch" ||
    reason === "proof_capsule_skill_mismatch" ||
    reason === "proof_capsule_skill_version_mismatch" ||
    reason === "proof_capsule_license_version_mismatch" ||
    reason === "proof_capsule_action_mismatch" ||
    reason === "proof_capsule_issuer_mismatch" ||
    reason === "proof_capsule_key_mismatch" ||
    reason === "proof_capsule_nonce_missing" ||
    reason === "proof_capsule_ledger_checkpoint_invalid" ||
    reason === "proof_capsule_expired" ||
    reason === "dojo_proof_capsule_invalid"
  ) {
    return "proof_capsule_invalid";
  }
  if (reason.startsWith("missing_context_claim:") || reason === "runtime_workspace_not_verified") return "proof_context_claim_unverified";
  if (reason.startsWith("missing_evidence_claim:") || reason === "proof_evidence_claim_unverified") return "proof_evidence_claim_unverified";
  if (reason === "license_expired") return "license_expired";
  if (reason === "license_revoked") return "license_revoked";
  if (reason.startsWith("blocked_action:") || reason.startsWith("action_not_licensed:")) return "action_not_licensed";
  if (reason.startsWith("substrate_not_allowed:")) return "substrate_not_allowed";
  if (reason === "workspace_mismatch") return "workspace_mismatch";
  if (reason === "app_origin_mismatch" || reason === "app_origin_unparseable" || reason === "origin_mismatch") return "origin_mismatch";
  if (
    reason === "dojo_action_requires_approval" ||
    reason === "approval_required" ||
    reason === "approval_not_granted" ||
    reason === "approval_actor_required" ||
    reason === "approval_actor_type_required" ||
    reason.startsWith("approval_constraint:")
  ) {
    return "approval_required";
  }
  if (reason.startsWith("guardrail_not_active:") || reason === "guardrail_failed") return "guardrail_failed";
  if (reason === "dojo_execution_policy_blocked" || reason === "published_skill_mapping_unknown") return "dojo_execution_policy_blocked";
  return "unknown";
}

export function normalizeDojoProofErrorCodes(reasons: string[]): DojoProofErrorCode[] {
  return [...new Set(reasons.map(normalizeDojoProofErrorCode))];
}

export function dojoProofRefusalCategoryFor(code: DojoProofErrorCode): DojoProofRefusalCategory {
  switch (code) {
    case "proof_capsule_missing":
    case "proof_capsule_invalid":
    case "proof_capsule_not_issued":
    case "proof_signature_invalid":
      return "missing_or_invalid_proof";
    case "proof_capsule_revoked":
    case "proof_capsule_replay_detected":
    case "proof_capsule_registry_mismatch":
      return "proof_replay_or_revocation";
    case "proof_context_claim_unverified":
    case "proof_evidence_claim_unverified":
      return "claim_verification_failed";
    case "license_expired":
    case "license_revoked":
    case "action_not_licensed":
    case "substrate_not_allowed":
      return "license_scope_failed";
    case "workspace_mismatch":
    case "origin_mismatch":
    case "dojo_execution_policy_blocked":
      return "runtime_context_failed";
    case "approval_required":
    case "guardrail_failed":
      return "approval_or_guardrail_required";
    case "unknown":
      return "unknown";
  }
}
