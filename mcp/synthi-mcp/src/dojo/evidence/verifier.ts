import type { DojoEvidenceLedgerRecord } from "./types.js";
import type { DojoEvidenceClaimId, DojoEvidenceClaimResult } from "./claims.js";

const DEFAULT_EVIDENCE_FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DojoEvidenceClaimVerifierInput {
  claim_ids: DojoEvidenceClaimId[];
  records: DojoEvidenceLedgerRecord[];
  checked_at?: string;
  max_age_ms?: number;
}

export interface DojoEvidenceClaimVerifier {
  resolveClaims(input: DojoEvidenceClaimVerifierInput): Promise<DojoEvidenceClaimResult[]>;
}

export class InMemoryDojoEvidenceClaimVerifier implements DojoEvidenceClaimVerifier {
  async resolveClaims(input: DojoEvidenceClaimVerifierInput): Promise<DojoEvidenceClaimResult[]> {
    return resolveDojoEvidenceClaims(input);
  }
}

export function resolveDojoEvidenceClaims(input: DojoEvidenceClaimVerifierInput): DojoEvidenceClaimResult[] {
  const checkedAt = input.checked_at ?? new Date().toISOString();
  const maxAgeMs = input.max_age_ms;
  const uniqueClaims = [...new Set(input.claim_ids)];
  return uniqueClaims.map((claimId) => resolveClaim({
    claim_id: claimId,
    records: input.records,
    checked_at: checkedAt,
    max_age_ms: claimId === "evidence_fresh" ? maxAgeMs ?? DEFAULT_EVIDENCE_FRESH_MAX_AGE_MS : maxAgeMs,
  }));
}

function resolveClaim(input: {
  claim_id: DojoEvidenceClaimId;
  records: DojoEvidenceLedgerRecord[];
  checked_at: string;
  max_age_ms?: number;
}): DojoEvidenceClaimResult {
  const candidateRecords = input.claim_id === "evidence_fresh"
    ? input.records
    : input.records.filter((record) => record.claim_ids.includes(input.claim_id));
  if (candidateRecords.length === 0) {
    return {
      claim_id: input.claim_id,
      ok: false,
      status: "missing",
      evidence_record_ids: [],
      checked_at: input.checked_at,
      blocked_by: [`evidence_claim_missing:${input.claim_id}`],
    };
  }

  const freshRecords = input.max_age_ms === undefined
    ? candidateRecords
    : candidateRecords.filter((record) => evidenceAgeMs(record, input.checked_at) <= input.max_age_ms!);
  if (freshRecords.length === 0) {
    return {
      claim_id: input.claim_id,
      ok: false,
      status: "stale",
      evidence_record_ids: candidateRecords.map((record) => record.record_id),
      checked_at: input.checked_at,
      blocked_by: [`evidence_claim_stale:${input.claim_id}`],
    };
  }

  return {
    claim_id: input.claim_id,
    ok: true,
    status: "verified",
    evidence_record_ids: freshRecords.map((record) => record.record_id),
    checked_at: input.checked_at,
    blocked_by: [],
  };
}

function evidenceAgeMs(record: DojoEvidenceLedgerRecord, checkedAt: string): number {
  return Date.parse(checkedAt) - Date.parse(record.created_at);
}
