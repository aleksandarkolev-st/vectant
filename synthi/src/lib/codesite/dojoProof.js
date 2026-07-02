import { digest } from './policy';
import { verifyDojoProofCapsulePublicWithKeyRecord } from './dojoPublicVerifier';

export function buildCodeSiteDojoProofInput(body = {}) {
  const capsule = parseObject(body.dojoProofCapsule || body.dojo_proof_capsule || body.proofCapsule || body.proof_capsule);
  const proofKey = parseObject(body.dojoProofKey || body.dojo_proof_key || body.proofKey || body.proof_key);
  const expected = parseObject(body.dojoExpected || body.dojo_expected || body.expectedDojoProof || body.expected_dojo_proof);
  const evidenceRefs = asArray(body.dojoEvidenceRefs || body.dojo_evidence_refs || capsule?.evidence_record_ids || [])
    .map((ref) => String(ref).trim())
    .filter(Boolean);
  const implementationStatus = parseObject(body.implementationStatus || body.implementation_status) || {
    executable: false,
    productionRuntime: false,
  };
  return {
    proofRef: body.dojoProofRef || body.dojo_proof_ref || capsule?.capsule_id || null,
    licenseRef: body.dojoLicenseRef || body.dojo_license_ref || capsule?.license_id || capsule?.license_ref || capsule?.license_version || null,
    evidenceRefs,
    ledgerCheckpointHash: body.dojoLedgerCheckpointHash || body.dojo_ledger_checkpoint_hash || capsule?.ledger_checkpoint_hash || null,
    decisionDigest: body.dojoDecisionDigest || body.dojo_decision_digest || null,
    implementationStatus,
    capsule,
    proofKey,
    expected: {
      ...expected,
      ...(body.dojoRequestedAction || body.dojo_requested_action ? { requested_action: body.dojoRequestedAction || body.dojo_requested_action } : {}),
      ...(body.dojoSkillId || body.dojo_skill_id ? { skill_id: body.dojoSkillId || body.dojo_skill_id } : {}),
      ...(body.dojoSkillVersion || body.dojo_skill_version ? { skill_version: body.dojoSkillVersion || body.dojo_skill_version } : {}),
      ...(body.dojoLicenseVersion || body.dojo_license_version ? { license_version: body.dojoLicenseVersion || body.dojo_license_version } : {}),
      ...(body.dojoRequiredEvidenceClaims || body.dojo_required_evidence_claims
        ? { required_evidence_claims: asArray(body.dojoRequiredEvidenceClaims || body.dojo_required_evidence_claims) }
        : {}),
    },
    requireLedgerCheckpoint: body.dojoRequireLedgerCheckpoint !== false && body.dojo_require_ledger_checkpoint !== false,
    allowForensicVerification: body.dojoAllowForensicVerification === true || body.dojo_allow_forensic_verification === true,
  };
}

export async function verifyCodeSiteDojoProof(dojoProof = {}, context = {}) {
  const proof = {
    ...dojoProof,
    evidenceRefs: asArray(dojoProof.evidenceRefs),
    implementationStatus: dojoProof.implementationStatus || { executable: false, productionRuntime: false },
  };
  const checkedAt = new Date().toISOString();
  if (!proof.capsule || !proof.proofKey) {
    return finalizeDojoProof(proof, {
      ok: false,
      status: 'blocked',
      checkedAt,
      source: 'codesite_dojo_public_verifier',
      signatureVerified: false,
      blockedBy: [
        ...(!proof.capsule ? ['dojo_public_proof_capsule_required'] : []),
        ...(!proof.proofKey ? ['dojo_public_proof_key_required'] : []),
      ],
    });
  }

  try {
    const expected = buildExpectedProof(proof, context);
    const verification = verifyDojoProofCapsulePublicWithKeyRecord({
      capsule: proof.capsule,
      proof_key: proof.proofKey,
      expected,
      require_ledger_checkpoint: proof.requireLedgerCheckpoint !== false,
      allow_forensic_verification: proof.allowForensicVerification === true,
    });
    const normalized = {
      ok: verification.ok === true,
      status: verification.status || (verification.ok ? 'verified' : 'blocked'),
      checkedAt: verification.checked_at || checkedAt,
      source: 'dojo_public_proof_verifier',
      capsuleId: verification.capsule_id,
      keyId: verification.key_id,
      proofKeyStatus: verification.proof_key_status,
      proofKeyIssuer: verification.proof_key_issuer,
      proofKeySigningProvider: verification.proof_key_signing_provider,
      proofKeyCustody: verification.proof_key_custody,
      signatureVerified: verification.signature_verified === true,
      blockedBy: asArray(verification.blocked_by),
      expected,
    };
    return finalizeDojoProof(proof, normalized);
  } catch (error) {
    return finalizeDojoProof(proof, {
      ok: false,
      status: 'blocked',
      checkedAt,
      source: 'codesite_dojo_public_verifier',
      signatureVerified: false,
      blockedBy: ['dojo_public_proof_verifier_unavailable'],
      error: error?.message || String(error),
    });
  }
}

export function summarizeCodeSiteDojoProof(dojoProof = {}) {
  return {
    proofRef: dojoProof.proofRef || null,
    licenseRef: dojoProof.licenseRef || null,
    evidenceRefs: asArray(dojoProof.evidenceRefs),
    ledgerCheckpointHash: dojoProof.ledgerCheckpointHash || null,
    decisionDigest: dojoProof.decisionDigest || null,
    implementationStatus: dojoProof.implementationStatus || null,
    verification: dojoProof.verification || null,
  };
}

function buildExpectedProof(proof, context = {}) {
  const expected = {
    ...(proof.expected || {}),
  };
  if (proof.ledgerCheckpointHash && !expected.ledger_checkpoint_hash) {
    expected.ledger_checkpoint_hash = proof.ledgerCheckpointHash;
  }
  if (!expected.requested_action && context.requestedAction) {
    expected.requested_action = context.requestedAction;
  }
  if (!Array.isArray(expected.required_evidence_claims) && context.requiredEvidenceClaims?.length) {
    expected.required_evidence_claims = context.requiredEvidenceClaims;
  }
  return expected;
}

function finalizeDojoProof(proof, verification) {
  const verificationDigest = digest({
    ok: verification.ok,
    status: verification.status,
    source: verification.source,
    capsuleId: verification.capsuleId || proof.capsule?.capsule_id || proof.proofRef || null,
    keyId: verification.keyId || proof.proofKey?.key_id || null,
    signatureVerified: verification.signatureVerified === true,
    blockedBy: asArray(verification.blockedBy),
    expected: verification.expected || null,
  });
  return {
    ...proof,
    proofRef: proof.proofRef || proof.capsule?.capsule_id || null,
    licenseRef: proof.licenseRef || proof.capsule?.license_id || proof.capsule?.license_ref || proof.capsule?.license_version || null,
    evidenceRefs: proof.evidenceRefs.length > 0 ? proof.evidenceRefs : asArray(proof.capsule?.evidence_record_ids),
    ledgerCheckpointHash: proof.ledgerCheckpointHash || proof.capsule?.ledger_checkpoint_hash || null,
    decisionDigest: verificationDigest,
    verification: {
      ...verification,
      blockedBy: asArray(verification.blockedBy),
      digest: verificationDigest,
    },
  };
}

function parseObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
