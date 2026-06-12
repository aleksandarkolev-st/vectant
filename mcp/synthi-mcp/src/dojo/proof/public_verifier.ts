import {
  canonicalDojoProofPayload,
  parseDojoProofSignatureEnvelope,
  type DojoProofSigningAlgorithm,
  type DojoProofVerifier,
} from "./signing.js";

export interface DojoPublicProofCapsule {
  schema_version: string;
  capsule_id: string;
  skill_id: string;
  skill_version: string;
  requested_action: string;
  license_version: string;
  issuer: string;
  key_id: string;
  nonce: string;
  ledger_checkpoint_hash?: string;
  evidence_claims?: DojoPublicProofEvidenceClaim[];
  evidence_record_ids?: string[];
  issued_at: string;
  expires_at: string;
  signature_algorithm: DojoProofSigningAlgorithm;
  signature: string;
  [key: string]: unknown;
}

export interface DojoPublicProofEvidenceClaim {
  claim: string;
  satisfied: boolean;
  evidence_refs?: string[];
}

export interface DojoPublicProofVerification {
  ok: boolean;
  status: "verified" | "blocked";
  checked_at: string;
  capsule_id?: string;
  key_id?: string;
  signature_verified: boolean;
  blocked_by: string[];
}

export function verifyDojoProofCapsulePublic(input: {
  capsule: DojoPublicProofCapsule;
  verifier: DojoProofVerifier;
  expected?: {
    issuer?: string;
    key_id?: string;
    skill_id?: string;
    skill_version?: string;
    license_version?: string;
    requested_action?: string;
    ledger_checkpoint_hash?: string;
    required_evidence_claims?: string[];
  };
  require_ledger_checkpoint?: boolean;
  now?: string;
}): DojoPublicProofVerification {
  const checkedAt = input.now ?? new Date().toISOString();
  const blockedBy: string[] = [];
  const capsule = input.capsule;

  if (capsule.schema_version !== "synthi.dojo.proofCapsule.v1") blockedBy.push("proof_capsule_schema_version_mismatch");
  if (!capsule.capsule_id) blockedBy.push("proof_capsule_id_missing");
  if (!capsule.nonce) blockedBy.push("proof_capsule_nonce_missing");
  if (input.expected?.issuer && capsule.issuer !== input.expected.issuer) blockedBy.push("proof_capsule_issuer_mismatch");
  if (input.expected?.key_id && capsule.key_id !== input.expected.key_id) blockedBy.push("proof_capsule_key_mismatch");
  if (input.expected?.skill_id && capsule.skill_id !== input.expected.skill_id) blockedBy.push("proof_capsule_skill_mismatch");
  if (input.expected?.skill_version && capsule.skill_version !== input.expected.skill_version) blockedBy.push("proof_capsule_skill_version_mismatch");
  if (input.expected?.license_version && capsule.license_version !== input.expected.license_version) blockedBy.push("proof_capsule_license_version_mismatch");
  if (input.expected?.requested_action && capsule.requested_action !== input.expected.requested_action) blockedBy.push("proof_capsule_action_mismatch");
  if (input.expected?.ledger_checkpoint_hash && capsule.ledger_checkpoint_hash !== input.expected.ledger_checkpoint_hash) {
    blockedBy.push("proof_capsule_ledger_checkpoint_mismatch");
  }
  if (input.require_ledger_checkpoint && !capsule.ledger_checkpoint_hash) blockedBy.push("proof_capsule_ledger_checkpoint_missing");
  if (capsule.ledger_checkpoint_hash && !isSha256Hex(capsule.ledger_checkpoint_hash)) {
    blockedBy.push("proof_capsule_ledger_checkpoint_invalid");
  }
  const requiredEvidenceClaims = input.expected?.required_evidence_claims ?? [];
  if (requiredEvidenceClaims.length > 0) {
    const evidenceClaims = parsePublicEvidenceClaims(capsule.evidence_claims);
    if (!evidenceClaims) {
      blockedBy.push("proof_capsule_evidence_claims_invalid");
    } else {
      const satisfiedClaims = new Map(
        evidenceClaims
          .filter((claim) => claim.satisfied)
          .map((claim) => [claim.claim, claim])
      );
      for (const claim of requiredEvidenceClaims) {
        const evidenceClaim = satisfiedClaims.get(claim);
        if (!evidenceClaim) {
          blockedBy.push(`proof_capsule_evidence_claim_missing:${claim}`);
        } else if (!hasEvidenceRefs(evidenceClaim)) {
          blockedBy.push(`proof_capsule_evidence_claim_refs_missing:${claim}`);
        }
      }
    }
  }
  if (capsule.signature_algorithm !== input.verifier.algorithm) blockedBy.push("proof_capsule_signature_algorithm_mismatch");
  if (capsule.key_id !== input.verifier.key_id) blockedBy.push("proof_capsule_key_mismatch");
  const issuedAtMs = parseTimestamp(capsule.issued_at);
  const expiresAtMs = parseTimestamp(capsule.expires_at);
  const checkedAtMs = parseTimestamp(checkedAt);
  if (issuedAtMs === undefined) blockedBy.push("proof_capsule_issued_at_invalid");
  if (expiresAtMs === undefined) blockedBy.push("proof_capsule_expires_at_invalid");
  if (checkedAtMs === undefined) blockedBy.push("proof_validation_time_invalid");
  if (issuedAtMs !== undefined && expiresAtMs !== undefined && expiresAtMs <= issuedAtMs) {
    blockedBy.push("proof_capsule_expires_at_not_after_issued_at");
  }
  if (expiresAtMs !== undefined && checkedAtMs !== undefined && expiresAtMs <= checkedAtMs) {
    blockedBy.push("proof_capsule_expired");
  }

  const signatureVerified = verifySignature(capsule, input.verifier);
  if (!signatureVerified) blockedBy.push("proof_capsule_signature_invalid");

  return {
    ok: blockedBy.length === 0,
    status: blockedBy.length === 0 ? "verified" : "blocked",
    checked_at: checkedAt,
    capsule_id: capsule.capsule_id,
    key_id: capsule.key_id,
    signature_verified: signatureVerified,
    blocked_by: [...new Set(blockedBy)],
  };
}

function verifySignature(capsule: DojoPublicProofCapsule, verifier: DojoProofVerifier): boolean {
  try {
    const envelope = parseDojoProofSignatureEnvelope({
      algorithm: capsule.signature_algorithm,
      key_id: capsule.key_id,
      signature: capsule.signature,
    });
    if (envelope.algorithm !== verifier.algorithm || envelope.key_id !== verifier.key_id) return false;
    const { signature: _signature, ...unsignedCapsule } = capsule;
    return verifier.verify(canonicalDojoProofPayload(unsignedCapsule), envelope);
  } catch {
    return false;
  }
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function parsePublicEvidenceClaims(value: unknown): DojoPublicProofEvidenceClaim[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims: DojoPublicProofEvidenceClaim[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.claim !== "string" || !record.claim.trim()) return undefined;
    if (typeof record.satisfied !== "boolean") return undefined;
    if (record.evidence_refs !== undefined) {
      if (!Array.isArray(record.evidence_refs)) return undefined;
      if (!record.evidence_refs.every((ref) => typeof ref === "string")) return undefined;
    }
    claims.push({
      claim: record.claim,
      satisfied: record.satisfied,
      evidence_refs: record.evidence_refs as string[] | undefined,
    });
  }
  return claims;
}

function hasEvidenceRefs(claim: DojoPublicProofEvidenceClaim): boolean {
  return claim.evidence_refs?.some((ref) => ref.trim().length > 0) === true;
}
