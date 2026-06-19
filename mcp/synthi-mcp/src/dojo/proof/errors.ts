export const DOJO_PROOF_ERROR_CODES = [
  "proof_capsule_missing",
  "proof_capsule_invalid",
  "proof_capsule_not_issued",
  "proof_capsule_revoked",
  "proof_capsule_replay_detected",
  "proof_capsule_registry_mismatch",
  "proof_tenant_context_invalid",
  "proof_signature_invalid",
  "proof_key_unavailable",
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
  if (
    reason === "proof_capsule_missing" ||
    reason === "dojo_proof_capsule_required" ||
    reason === "api_tool_proof_capsule_required"
  ) {
    return "proof_capsule_missing";
  }
  if (reason === "proof_capsule_revoked" || reason === "proof_key_revoked" || reason === "dojo_proof_key_revoked") return "proof_capsule_revoked";
  if (reason === "proof_capsule_replay_detected") return "proof_capsule_replay_detected";
  if (reason === "proof_capsule_not_issued_by_registry" || reason === "proof_capsule_not_issued") return "proof_capsule_not_issued";
  if (
    reason === "proof_tenant_required" ||
    reason === "proof_organization_required" ||
    reason === "proof_workspace_required" ||
    reason === "proof_actor_required" ||
    reason === "proof_actor_type_required" ||
    reason === "proof_roles_invalid" ||
    reason === "proof_request_required" ||
    reason === "proof_correlation_required"
  ) {
    return "proof_tenant_context_invalid";
  }
  if (isRuntimeTenantContextFailure(reason)) return "proof_tenant_context_invalid";
  if (reason.startsWith("proof_record_")) return "proof_capsule_registry_mismatch";
  if (reason === "proof_capsule_signature_invalid" || reason === "proof_capsule_signature_algorithm_mismatch") return "proof_signature_invalid";
  if (reason.startsWith("proof_key_") || reason.startsWith("dojo_proof_key_")) {
    return "proof_key_unavailable";
  }
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
    reason === "proof_capsule_issued_at_invalid" ||
    reason === "proof_capsule_expires_at_invalid" ||
    reason === "proof_capsule_expires_at_not_after_issued_at" ||
    reason === "proof_validation_time_invalid" ||
    reason === "proof_capsule_expired" ||
    reason === "proof_self_attestation_not_allowed_in_production" ||
    reason === "dojo_proof_signer_not_production_ready" ||
    reason === "dojo_proof_signer_external_required" ||
    reason === "proof_validator_missing" ||
    reason === "api_tool_proof_validator_required" ||
    reason === "api_tool_proof_validation_failed" ||
    reason === "api_tool_graph_proof_required" ||
    reason === "api_tool_graph_proof_mismatch" ||
    reason === "api_tool_proof_capsule_id_required" ||
    reason === "api_tool_proof_nonce_required" ||
    reason === "api_tool_proof_skill_required" ||
    reason === "api_tool_proof_skill_mismatch" ||
    reason === "api_tool_proof_license_required" ||
    reason === "api_tool_proof_license_mismatch" ||
    reason === "api_tool_proof_license_version_required" ||
    reason === "api_tool_proof_license_version_mismatch" ||
    reason === "api_tool_proof_action_required" ||
    reason === "api_tool_proof_action_mismatch" ||
    reason === "dojo_mcp_proof_skill_mismatch" ||
    reason === "dojo_mcp_proof_skill_version_mismatch" ||
    reason === "dojo_mcp_proof_license_version_mismatch" ||
    reason === "dojo_mcp_proof_action_mismatch" ||
    reason === "dojo_mcp_skill_bus_proof_validator_unconfigured" ||
    reason === "dojo_proof_capsule_invalid"
  ) {
    return "proof_capsule_invalid";
  }
  if (reason.startsWith("missing_context_claim:") || reason === "runtime_workspace_not_verified") return "proof_context_claim_unverified";
  if (
    reason.startsWith("missing_evidence_claim:") ||
    reason.startsWith("evidence_claim_missing:") ||
    reason.startsWith("evidence_claim_scope_mismatch:") ||
    reason.startsWith("evidence_claim_stale:") ||
    reason.startsWith("evidence_claim_unverified:") ||
    reason.startsWith("evidence_claim_refs_missing:") ||
    reason.startsWith("evidence_claim_record_ref_missing:") ||
    reason.startsWith("evidence_claim_ref_invalid:") ||
    reason.startsWith("evidence_claim_ref_record_missing:") ||
    reason.startsWith("evidence_claim_ledger_checkpoint_missing:") ||
    reason.startsWith("api_tool_proof_evidence_claim_missing:") ||
    reason.startsWith("api_tool_proof_evidence_claim_unverified:") ||
    reason.startsWith("api_tool_proof_evidence_claim_refs_required:") ||
    reason === "evidence_ledger_checkpoint_without_records" ||
    reason === "proof_capsule_ledger_checkpoint_missing" ||
    reason === "proof_capsule_evidence_records_missing" ||
    reason === "proof_capsule_evidence_record_ids_invalid" ||
    reason === "api_tool_proof_evidence_records_required" ||
    reason === "api_tool_proof_ledger_checkpoint_required" ||
    reason === "proof_evidence_claim_unverified"
  ) {
    return "proof_evidence_claim_unverified";
  }
  if (reason === "license_expired" || reason === "license_expiry_invalid" || reason === "license_record_expiry_invalid") return "license_expired";
  if (
    reason === "license_revoked" ||
    reason === "license_superseded" ||
    reason === "license_record_missing" ||
    reason.startsWith("license_record_")
  ) return "license_revoked";
  if (
    reason.startsWith("blocked_action:") ||
    reason.startsWith("action_not_licensed:") ||
    reason === "api_tool_skill_mismatch" ||
    reason === "api_tool_license_mismatch" ||
    reason === "api_tool_license_version_mismatch" ||
    reason === "api_tool_action_mismatch" ||
    reason === "api_tool_auth_scope_missing"
  ) {
    return "action_not_licensed";
  }
  if (
    reason.startsWith("substrate_not_allowed:") ||
    reason === "substrate_not_allowed" ||
    reason === "dojo_mcp_proof_substrate_not_allowed"
  ) return "substrate_not_allowed";
  if (reason === "workspace_mismatch") return "workspace_mismatch";
  if (reason === "app_origin_mismatch" || reason === "app_origin_unparseable" || reason === "origin_mismatch") return "origin_mismatch";
  if (
    reason === "dojo_action_requires_approval" ||
    reason === "approval_required" ||
    reason === "approval_not_granted" ||
    reason === "approval_actor_required" ||
    reason === "approval_actor_type_required" ||
    reason === "approval_evidence_required" ||
    reason === "approval_evidence_claim_unverified" ||
    reason.startsWith("approval_constraint:")
  ) {
    return "approval_required";
  }
  if (reason.startsWith("guardrail_not_active:") || reason === "guardrail_failed") return "guardrail_failed";
  if (
    reason === "dojo_execution_policy_blocked" ||
    reason === "published_skill_mapping_unknown" ||
    reason === "api_tool_idempotency_key_required" ||
    reason === "api_tool_request_required" ||
    reason === "api_tool_compiled_tool_required" ||
    reason === "api_tool_transport_required" ||
    reason === "api_tool_mock_response_forbidden_in_production" ||
    reason === "api_tool_network_transport_required_in_production" ||
    reason === "api_tool_mock_response_or_network_transport_required" ||
    reason === "api_tool_base_url_required" ||
    reason === "api_tool_base_url_invalid" ||
    reason === "api_tool_base_url_origin_mismatch" ||
    reason === "api_tool_transport_failed" ||
    reason === "api_tool_evidence_writer_required" ||
    reason === "api_tool_evidence_write_failed" ||
    reason === "api_tool_evidence_record_id_required" ||
    reason === "substrate_executor_required"
  ) {
    return "dojo_execution_policy_blocked";
  }
  return "unknown";
}

function isRuntimeTenantContextFailure(reason: string): boolean {
  return /^(dojo_execution|graph_runtime|runtime|dojo_mcp)_(tenant|organization|workspace|actor|actor_type|roles|request|correlation)_(required|invalid)$/.test(reason)
    || /^tenant_context_(tenant_id|organization_id|workspace_id|actor_id|actor_type|roles|request_id|correlation_id)_(missing|invalid)$/.test(reason);
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
    case "proof_key_unavailable":
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
    case "proof_tenant_context_invalid":
    case "dojo_execution_policy_blocked":
      return "runtime_context_failed";
    case "approval_required":
    case "guardrail_failed":
      return "approval_or_guardrail_required";
    case "unknown":
      return "unknown";
  }
}
