import { verify as nodeVerify } from 'node:crypto';

export function verifyDojoProofCapsulePublicWithKeyRecord(input = {}) {
  const checkedAt = input.now || new Date().toISOString();
  const capsule = input.capsule || {};
  const proofKey = input.proof_key || {};
  const proofKeyBlockedBy = proofKeyRecordBlockedBy(proofKey, input.allow_forensic_verification === true);
  const verifier = verifierForProofKey(proofKey);
  if (!verifier) {
    return {
      ok: false,
      status: 'blocked',
      checked_at: checkedAt,
      capsule_id: capsule.capsule_id,
      key_id: capsule.key_id,
      proof_key_status: proofKey.status,
      proof_key_issuer: proofKey.issuer,
      proof_key_signing_provider: proofKey.signing_provider,
      proof_key_custody: proofKey.key_custody,
      signature_verified: false,
      blocked_by: unique([
        ...proofKeyBlockedBy,
        'proof_key_public_verifier_unavailable',
      ]),
    };
  }

  const verification = verifyDojoProofCapsulePublic({
    capsule,
    verifier,
    expected: {
      ...(input.expected || {}),
      issuer: input.expected?.issuer || proofKey.issuer,
      key_id: input.expected?.key_id || proofKey.key_id,
    },
    require_ledger_checkpoint: input.require_ledger_checkpoint,
    now: checkedAt,
  });
  const blockedBy = unique([...proofKeyBlockedBy, ...verification.blocked_by]);
  return {
    ...verification,
    ok: blockedBy.length === 0,
    status: blockedBy.length === 0 ? 'verified' : 'blocked',
    proof_key_status: proofKey.status,
    proof_key_issuer: proofKey.issuer,
    proof_key_signing_provider: proofKey.signing_provider,
    proof_key_custody: proofKey.key_custody,
    blocked_by: blockedBy,
  };
}

export function verifyDojoProofCapsulePublic(input = {}) {
  const checkedAt = input.now || new Date().toISOString();
  const blockedBy = [];
  const capsule = input.capsule || {};
  const expected = input.expected || {};
  const verifier = input.verifier || {};

  if (capsule.schema_version !== 'synthi.dojo.proofCapsule.v1') blockedBy.push('proof_capsule_schema_version_mismatch');
  if (!capsule.capsule_id) blockedBy.push('proof_capsule_id_missing');
  if (!capsule.nonce) blockedBy.push('proof_capsule_nonce_missing');
  if (expected.issuer && capsule.issuer !== expected.issuer) blockedBy.push('proof_capsule_issuer_mismatch');
  if (expected.key_id && capsule.key_id !== expected.key_id) blockedBy.push('proof_capsule_key_mismatch');
  if (expected.skill_id && capsule.skill_id !== expected.skill_id) blockedBy.push('proof_capsule_skill_mismatch');
  if (expected.skill_version && capsule.skill_version !== expected.skill_version) blockedBy.push('proof_capsule_skill_version_mismatch');
  if (expected.license_version && capsule.license_version !== expected.license_version) blockedBy.push('proof_capsule_license_version_mismatch');
  if (expected.requested_action && capsule.requested_action !== expected.requested_action) blockedBy.push('proof_capsule_action_mismatch');
  if (expected.ledger_checkpoint_hash && capsule.ledger_checkpoint_hash !== expected.ledger_checkpoint_hash) {
    blockedBy.push('proof_capsule_ledger_checkpoint_mismatch');
  }
  if (input.require_ledger_checkpoint && !capsule.ledger_checkpoint_hash) blockedBy.push('proof_capsule_ledger_checkpoint_missing');
  if (capsule.ledger_checkpoint_hash && !isSha256Hex(capsule.ledger_checkpoint_hash)) {
    blockedBy.push('proof_capsule_ledger_checkpoint_invalid');
  }

  const evidenceRecordIds = parsePublicEvidenceRecordIds(capsule.evidence_record_ids);
  const hasLedgerCheckpoint = typeof capsule.ledger_checkpoint_hash === 'string' && capsule.ledger_checkpoint_hash.trim().length > 0;
  if (capsule.evidence_record_ids !== undefined && evidenceRecordIds.length !== capsule.evidence_record_ids.length) {
    blockedBy.push('proof_capsule_evidence_record_ids_invalid');
  }

  const requiredEvidenceClaims = Array.isArray(expected.required_evidence_claims) ? expected.required_evidence_claims : [];
  if ((requiredEvidenceClaims.length > 0 || evidenceRecordIds.length > 0) && !hasLedgerCheckpoint) {
    blockedBy.push('proof_capsule_ledger_checkpoint_missing');
  }
  if ((requiredEvidenceClaims.length > 0 || hasLedgerCheckpoint) && evidenceRecordIds.length === 0) {
    blockedBy.push('proof_capsule_evidence_records_missing');
  }
  if (requiredEvidenceClaims.length > 0) {
    const evidenceClaims = parsePublicEvidenceClaims(capsule.evidence_claims);
    if (!evidenceClaims) {
      blockedBy.push('proof_capsule_evidence_claims_invalid');
    } else {
      const satisfiedClaims = new Map(
        evidenceClaims
          .filter((claim) => claim.satisfied)
          .map((claim) => [claim.claim, claim]),
      );
      for (const claim of requiredEvidenceClaims) {
        const evidenceClaim = satisfiedClaims.get(claim);
        if (!evidenceClaim) {
          blockedBy.push(`proof_capsule_evidence_claim_missing:${claim}`);
        } else if (!hasEvidenceRefs(evidenceClaim)) {
          blockedBy.push(`proof_capsule_evidence_claim_refs_missing:${claim}`);
        } else {
          blockedBy.push(...publicEvidenceClaimLedgerBindingFailures(evidenceClaim, evidenceRecordIds, hasLedgerCheckpoint));
        }
      }
    }
  }

  if (capsule.signature_algorithm !== verifier.algorithm) blockedBy.push('proof_capsule_signature_algorithm_mismatch');
  if (capsule.key_id !== verifier.key_id) blockedBy.push('proof_capsule_key_mismatch');
  const issuedAtMs = parseTimestamp(capsule.issued_at);
  const expiresAtMs = parseTimestamp(capsule.expires_at);
  const checkedAtMs = parseTimestamp(checkedAt);
  if (issuedAtMs === undefined) blockedBy.push('proof_capsule_issued_at_invalid');
  if (expiresAtMs === undefined) blockedBy.push('proof_capsule_expires_at_invalid');
  if (checkedAtMs === undefined) blockedBy.push('proof_validation_time_invalid');
  if (issuedAtMs !== undefined && expiresAtMs !== undefined && expiresAtMs <= issuedAtMs) {
    blockedBy.push('proof_capsule_expires_at_not_after_issued_at');
  }
  if (expiresAtMs !== undefined && checkedAtMs !== undefined && expiresAtMs <= checkedAtMs) {
    blockedBy.push('proof_capsule_expired');
  }

  const signatureVerified = verifySignature(capsule, verifier);
  if (!signatureVerified) blockedBy.push('proof_capsule_signature_invalid');

  return {
    ok: blockedBy.length === 0,
    status: blockedBy.length === 0 ? 'verified' : 'blocked',
    checked_at: checkedAt,
    capsule_id: capsule.capsule_id,
    key_id: capsule.key_id,
    signature_verified: signatureVerified,
    blocked_by: unique(blockedBy),
  };
}

function verifySignature(capsule, verifier) {
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

function verifierForProofKey(key) {
  if (key.algorithm !== 'ed25519') return null;
  if (typeof key.public_key_pem !== 'string' || !key.public_key_pem.trim()) return null;
  return {
    algorithm: 'ed25519',
    key_id: key.key_id,
    verify(payload, signature) {
      if (signature.algorithm !== 'ed25519' || signature.key_id !== key.key_id) return false;
      const rawSignature = signature.signature.startsWith('ed25519:')
        ? signature.signature.slice('ed25519:'.length)
        : signature.signature;
      return nodeVerify(null, Buffer.from(payload, 'utf8'), key.public_key_pem, Buffer.from(rawSignature, 'base64url'));
    },
  };
}

function proofKeyRecordBlockedBy(key = {}, allowForensicVerification) {
  const blockedBy = [];
  if (key.schema_version !== 'synthi.dojo.proofKey.v1') blockedBy.push('proof_key_schema_version_mismatch');
  if (!String(key.key_id || '').trim()) blockedBy.push('proof_key_id_missing');
  if (!String(key.issuer || '').trim()) blockedBy.push('proof_key_issuer_missing');
  if (!String(key.public_key_pem || '').trim()) blockedBy.push('proof_key_public_key_missing');
  if (key.algorithm !== 'ed25519') blockedBy.push('proof_key_public_verifier_unavailable');
  if (key.status !== 'active' && key.status !== 'retired' && key.status !== 'revoked') {
    blockedBy.push('proof_key_status_invalid');
  }
  if (key.status === 'revoked' && !(allowForensicVerification && key.retain_for_forensic_verification)) {
    blockedBy.push('proof_key_revoked');
  }
  if (!isValidTimestamp(key.created_at)) blockedBy.push('proof_key_created_at_invalid');
  if (key.rotated_at !== undefined && !isValidTimestamp(key.rotated_at)) blockedBy.push('proof_key_rotated_at_invalid');
  if (key.revoked_at !== undefined && !isValidTimestamp(key.revoked_at)) blockedBy.push('proof_key_revoked_at_invalid');
  return blockedBy;
}

function canonicalDojoProofPayload(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDojoProofPayload).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalDojoProofPayload(value[key])}`).join(',')}}`;
}

function parseDojoProofSignatureEnvelope(input = {}) {
  if (input.algorithm === 'hmac-sha256') {
    if (!String(input.signature || '').startsWith('hmac-sha256:')) throw new Error('dojo_proof_signature_envelope_invalid');
    return {
      algorithm: 'hmac-sha256',
      key_id: input.key_id,
      signature: input.signature,
    };
  }
  const prefix = 'ed25519:';
  if (!String(input.signature || '').startsWith(prefix)) throw new Error('dojo_proof_signature_envelope_invalid');
  const rest = input.signature.slice(prefix.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex < 1) {
    return {
      algorithm: 'ed25519',
      key_id: input.key_id,
      signature: input.signature,
    };
  }
  const keyId = rest.slice(0, separatorIndex);
  const rawSignature = rest.slice(separatorIndex + 1);
  if (!keyId || !rawSignature) throw new Error('dojo_proof_signature_envelope_invalid');
  return {
    algorithm: 'ed25519',
    key_id: keyId,
    signature: `${prefix}${rawSignature}`,
  };
}

function parsePublicEvidenceRecordIds(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item) => typeof item === 'string' && item.trim().length > 0));
}

function publicEvidenceClaimLedgerBindingFailures(claim, evidenceRecordIds, hasLedgerCheckpoint) {
  const knownRecordIds = new Set(evidenceRecordIds);
  const blockedBy = [];
  const ledgerRefs = (claim.evidence_refs || []).filter((ref) => typeof ref === 'string' && ref.startsWith('evidence:'));
  if (ledgerRefs.length === 0) {
    blockedBy.push(`proof_capsule_evidence_claim_record_ref_missing:${claim.claim}`);
  }
  for (const ref of ledgerRefs) {
    const recordId = ref.slice('evidence:'.length).trim();
    if (!recordId) {
      blockedBy.push(`proof_capsule_evidence_claim_ref_invalid:${claim.claim}`);
      continue;
    }
    if (!knownRecordIds.has(recordId)) {
      blockedBy.push(`proof_capsule_evidence_claim_ref_record_missing:${claim.claim}`);
    }
    if (!hasLedgerCheckpoint) {
      blockedBy.push(`proof_capsule_evidence_claim_ledger_checkpoint_missing:${claim.claim}`);
    }
  }
  return blockedBy;
}

function parsePublicEvidenceClaims(value) {
  if (!Array.isArray(value)) return undefined;
  const claims = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    if (typeof item.claim !== 'string' || !item.claim.trim()) return undefined;
    if (typeof item.satisfied !== 'boolean') return undefined;
    if (item.evidence_refs !== undefined) {
      if (!Array.isArray(item.evidence_refs)) return undefined;
      if (!item.evidence_refs.every((ref) => typeof ref === 'string')) return undefined;
    }
    claims.push({
      claim: item.claim,
      satisfied: item.satisfied,
      evidence_refs: item.evidence_refs,
    });
  }
  return claims;
}

function hasEvidenceRefs(claim) {
  return claim.evidence_refs?.some((ref) => ref.trim().length > 0) === true;
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidTimestamp(value) {
  return parseTimestamp(value) !== undefined;
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function unique(items) {
  return [...new Set(items)];
}
