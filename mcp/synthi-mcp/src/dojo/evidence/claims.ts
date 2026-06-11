export const DOJO_SUPPORTED_EVIDENCE_CLAIMS = [
  "workspace_verified",
  "checkride_passed",
  "guardrails_active",
  "evidence_fresh",
  "critical_failures_open",
  "client_id_verified",
  "line_items_total_verified",
  "origin_verified",
  "substrate_allowed",
  "source_anchor_current",
  "approval_not_required",
  "approval_granted",
] as const;

export type DojoEvidenceClaimId = (typeof DOJO_SUPPORTED_EVIDENCE_CLAIMS)[number] | (string & {});

export type DojoEvidenceClaimStatus = "verified" | "missing" | "stale" | "failed";

export interface DojoEvidenceClaimResult {
  claim_id: DojoEvidenceClaimId;
  ok: boolean;
  status: DojoEvidenceClaimStatus;
  evidence_record_ids: string[];
  checked_at: string;
  blocked_by: string[];
}
