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
  issued_at: string;
  expires_at: string;
  signature_algorithm: DojoProofSigningAlgorithm;
  signature: string;
  [key: string]: unknown;
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
  if (capsule.signature_algorithm !== input.verifier.algorithm) blockedBy.push("proof_capsule_signature_algorithm_mismatch");
  if (capsule.key_id !== input.verifier.key_id) blockedBy.push("proof_capsule_key_mismatch");
  if (!validTimestamp(capsule.issued_at)) blockedBy.push("proof_capsule_issued_at_invalid");
  if (!validTimestamp(capsule.expires_at)) {
    blockedBy.push("proof_capsule_expires_at_invalid");
  } else if (Date.parse(capsule.expires_at) <= Date.parse(checkedAt)) {
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

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
