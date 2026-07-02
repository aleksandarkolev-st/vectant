import crypto from 'crypto';
import { digest } from './policy';
import { stableJson } from './json';

const PROOF_SIGNATURE_SCHEMA_VERSION = 'synthi.codesite.proofSignature.v1';
const DEFAULT_PROOF_AUTHORITY_ID = 'codesite-local-proof-authority';
const DEFAULT_PROOF_AUTHORITY_SECRET = 'synthi-codesite-local-proof-authority-development-only';

export function buildProofBundle({
  project,
  transaction,
  mutationLease,
  proofBundle,
  incidents = [],
  landingRuns = [],
  lineProvenance = [],
} = {}) {
  const payload = {
    schemaVersion: 'synthi.codesite.proofBundle.v1',
    projectId: project?.id || proofBundle?.projectId || transaction?.projectId,
    workspaceSlug: project?.workspaceSlug || null,
    transactionId: transaction?.id || proofBundle?.transactionId,
    mutationLeaseId: mutationLease?.id || transaction?.mutationLeaseId,
    displayCallsign: mutationLease?.displayCallsign || null,
    landingStatus: proofBundle?.landingStatus || proofBundle?.landing_status || landingStatusForRuns(landingRuns),
    readSetDigest: proofBundle?.readSetDigest || digest(transaction?.readSet || []),
    writeSetDigest: proofBundle?.writeSetDigest || digest(transaction?.writeSet || []),
    invariants: proofBundle?.invariants || transaction?.invariants || [],
    evidenceRefs: proofBundle?.evidenceRefs || [],
    dojoEvidenceRefs: proofBundle?.dojoEvidenceRefs || [],
    repoState: proofBundle?.repoState || null,
    incidentReplayDigest: proofBundle?.incidentReplayDigest || null,
    bundleDigest: proofBundle?.bundleDigest || null,
    incidents: incidents.map((incident) => ({
      id: incident.id,
      severity: incident.severity,
      category: incident.category,
      replayDigest: incident.replayDigest,
    })),
    lineProvenance: lineProvenance.map((row) => ({
      filePath: row.filePath,
      lineAnchor: row.lineAnchor,
      startLine: row.startLine || null,
      endLine: row.endLine || null,
      displayCallsign: row.displayCallsign,
      reasonRef: row.reasonRef || null,
      evidenceRefs: row.evidenceRefs || [],
      dojoSourceRefs: row.dojoSourceRefs || [],
      proofBundleId: row.proofBundleId,
      processAncestry: row.processAncestry || [],
      promptSummary: row.promptSummary || null,
    })),
    createdAt: normalizeProofTimestamp(proofBundle?.createdAt) || new Date().toISOString(),
  };
  const portableDigest = digest(payload);
  const unsignedBundle = {
    ...payload,
    portableDigest,
  };
  const existingSignature = normalizeProofSignature(proofBundle?.proofSignature || proofBundle?.proof_signature);
  const signatureVerification = existingSignature
    ? verifyProofSignatureEnvelope(unsignedBundle, existingSignature, { allowEmbeddedPublicKey: true })
    : { ok: false };
  return {
    ...unsignedBundle,
    proofSignature: signatureVerification.ok
      ? existingSignature
      : signProofBundle(unsignedBundle),
  };
}

function landingStatusForRuns(runs = []) {
  if (!runs.length) return null;
  if (runs.some((run) => ['failed', 'blocked', 'red'].includes(String(run.status || '').toLowerCase()))) {
    return 'go-around';
  }
  const latest = runs.at(-1);
  return latest?.status || 'landed';
}

function normalizeProofTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

export function proofCommitTrailers(proofBundle) {
  const bundle = proofBundle?.schemaVersion === 'synthi.codesite.proofBundle.v1'
    ? proofBundle
    : buildProofBundle({ proofBundle });
  return {
    'CodeSite-Project': bundle.projectId,
    'CodeSite-Flight': bundle.displayCallsign,
    'CodeSite-Clearance': bundle.mutationLeaseId,
    'CodeSite-Landing': bundle.landingStatus,
    'CodeSite-Transaction': bundle.transactionId,
    'CodeSite-Lease': bundle.mutationLeaseId,
    'CodeSite-Read-Set': bundle.readSetDigest,
    'CodeSite-Write-Set': bundle.writeSetDigest,
    'CodeSite-Invariants': (bundle.invariants || []).join(','),
    'CodeSite-Black-Box': bundle.incidentReplayDigest || bundle.bundleDigest || bundle.portableDigest,
    'CodeSite-Proof-Digest': bundle.portableDigest,
    'CodeSite-Proof-Authority': bundle.proofSignature?.keyId,
    'CodeSite-Proof-Signature': bundle.proofSignature?.signature,
  };
}

export function formatCommitTrailers(proofBundle) {
  return Object.entries(proofCommitTrailers(proofBundle))
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function verifyProofBundle(bundle, options = {}) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reasonCodes: ['invalid_bundle'] };
  }
  const { portableDigest, proofSignature, ...unsigned } = bundle;
  const expected = digest(unsigned);
  const legacyDateDigest = legacyDateObjectDigest(unsigned);
  const legacyDateDigestMatched = Boolean(portableDigest && legacyDateDigest && portableDigest === legacyDateDigest);
  const digestOk = Boolean(portableDigest && (portableDigest === expected || legacyDateDigestMatched));
  const requireSignature = options.requireSignature !== false;
  const signatureResult = verifyProofSignatureEnvelope({ ...unsigned, portableDigest }, proofSignature, options);
  const signatureOk = !requireSignature || signatureResult.ok;
  const ok = digestOk && signatureOk;
  return {
    ok,
    reasonCodes: [
      ...(digestOk ? ['proof_bundle_digest_valid'] : ['proof_bundle_digest_mismatch']),
      ...(legacyDateDigestMatched ? ['proof_bundle_legacy_date_digest_valid'] : []),
      ...signatureResult.reasonCodes,
      ...(!signatureOk ? ['proof_bundle_signature_required'] : []),
    ],
    expectedDigest: expected,
    legacyDateDigest,
    observedDigest: portableDigest || null,
    signature: signatureResult,
    canonicalJson: stableJson(unsigned),
  };
}

function legacyDateObjectDigest(unsigned) {
  if (!unsigned || typeof unsigned.createdAt !== 'string') return null;
  return digest({ ...unsigned, createdAt: {} });
}

export function signProofBundle(unsignedBundle, options = {}) {
  const authority = resolveProofAuthority(options);
  const envelope = {
    schemaVersion: PROOF_SIGNATURE_SCHEMA_VERSION,
    algorithm: authority.algorithm,
    keyId: authority.keyId,
    authority: authority.authority,
    signedAt: normalizeProofTimestamp(options.signedAt) || new Date().toISOString(),
    payloadDigest: unsignedBundle.portableDigest || digest(unsignedBundle),
  };
  const signingPayload = proofSignaturePayload(unsignedBundle, envelope);
  if (authority.algorithm === 'ed25519') {
    const signature = crypto
      .sign(null, Buffer.from(signingPayload, 'utf8'), authority.privateKey)
      .toString('base64url');
    return {
      ...envelope,
      signature: `ed25519:${authority.keyId}:${signature}`,
      publicKeyPem: authority.publicKeyPem,
    };
  }
  const signature = crypto
    .createHmac('sha256', authority.secret)
    .update(signingPayload)
    .digest('base64url');
  return {
    ...envelope,
    signature: `hmac-sha256:${authority.keyId}:${signature}`,
  };
}

export function verifyProofSignatureEnvelope(unsignedBundle, proofSignature, options = {}) {
  const envelope = normalizeProofSignature(proofSignature);
  if (!envelope) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_signature_missing'],
      warnings: [],
    };
  }
  if (envelope.schemaVersion !== PROOF_SIGNATURE_SCHEMA_VERSION) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_signature_schema_invalid'],
      warnings: [],
      keyId: envelope.keyId || null,
    };
  }
  const payloadDigest = unsignedBundle.portableDigest || digest(unsignedBundle);
  if (envelope.payloadDigest !== payloadDigest) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_signature_payload_digest_mismatch'],
      warnings: [],
      keyId: envelope.keyId || null,
      expectedPayloadDigest: payloadDigest,
      observedPayloadDigest: envelope.payloadDigest || null,
    };
  }
  const signingPayload = proofSignaturePayload(unsignedBundle, envelope);
  const requireTrustedAuthority = requiresTrustedProofAuthority(options);
  if (envelope.algorithm === 'ed25519') {
    return verifyEd25519Signature(signingPayload, envelope, {
      ...options,
      allowEmbeddedPublicKey: requireTrustedAuthority ? false : options.allowEmbeddedPublicKey,
      requireTrustedAuthority,
    });
  }
  if (envelope.algorithm === 'hmac-sha256') {
    return verifyHmacSignature(signingPayload, envelope, { ...options, requireTrustedAuthority });
  }
  return {
    ok: false,
    reasonCodes: ['proof_bundle_signature_algorithm_unsupported'],
    warnings: [],
    keyId: envelope.keyId || null,
    algorithm: envelope.algorithm || null,
  };
}

function verifyHmacSignature(signingPayload, envelope, options = {}) {
  const secret = options.authoritySecret
    || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET')
    || envValue('AUTH_SECRET')
    || envValue('NEXTAUTH_SECRET')
    || DEFAULT_PROOF_AUTHORITY_SECRET;
  if (options.requireTrustedAuthority && secret === DEFAULT_PROOF_AUTHORITY_SECRET) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_signature_trusted_authority_required'],
      warnings: ['proof_bundle_signature_default_development_secret_rejected'],
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
    };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingPayload)
    .digest('base64url');
  const observed = parseSignatureValue(envelope.signature, 'hmac-sha256', envelope.keyId);
  const ok = timingSafeEqualString(observed, expected);
  return {
    ok,
    reasonCodes: ok ? ['proof_bundle_signature_valid'] : ['proof_bundle_signature_invalid'],
    warnings: secret === DEFAULT_PROOF_AUTHORITY_SECRET ? ['proof_bundle_signature_default_development_secret'] : [],
    keyId: envelope.keyId,
    algorithm: envelope.algorithm,
  };
}

function verifyEd25519Signature(signingPayload, envelope, options = {}) {
  const keyResolution = resolveTrustedEd25519PublicKey(envelope, options);
  const publicKeyPem = keyResolution?.publicKeyPem;
  if (!publicKeyPem) {
    return {
      ok: false,
      reasonCodes: [options.requireTrustedAuthority ? 'proof_bundle_signature_trusted_authority_required' : 'proof_bundle_signature_public_key_required'],
      warnings: [],
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
    };
  }
  const observed = parseSignatureValue(envelope.signature, 'ed25519', envelope.keyId);
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(signingPayload, 'utf8'),
      publicKeyPem,
      Buffer.from(observed, 'base64url'),
    );
  } catch (_) {
    ok = false;
  }
  return {
    ok,
    reasonCodes: ok ? ['proof_bundle_signature_valid'] : ['proof_bundle_signature_invalid'],
    warnings: ok && keyResolution.source === 'embedded' ? ['proof_bundle_signature_embedded_public_key_used'] : [],
    keyId: envelope.keyId,
    algorithm: envelope.algorithm,
    publicKeySource: keyResolution.source,
  };
}

function proofSignaturePayload(unsignedBundle, envelope) {
  const { signature: _signature, publicKeyPem: _publicKeyPem, ...signingEnvelope } = envelope || {};
  return stableJson({
    bundle: unsignedBundle,
    signature: signingEnvelope,
  });
}

function requiresTrustedProofAuthority(options = {}) {
  if (options.requireTrustedAuthority != null) return options.requireTrustedAuthority === true;
  const envValueRaw = String(envValue('SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY') || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'required'].includes(envValueRaw)) return true;
  if (['0', 'false', 'no', 'off'].includes(envValueRaw)) return false;
  return envValue('NODE_ENV') === 'production';
}

function normalizeProofSignature(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    schemaVersion: input.schemaVersion || input.schema_version || null,
    algorithm: input.algorithm || null,
    keyId: input.keyId || input.key_id || null,
    authority: input.authority || null,
    signedAt: input.signedAt || input.signed_at || null,
    payloadDigest: input.payloadDigest || input.payload_digest || null,
    signature: input.signature || null,
    publicKeyPem: input.publicKeyPem || input.public_key_pem || null,
  };
}

function resolveProofAuthority(options = {}) {
  const keyId = options.keyId
    || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID')
    || DEFAULT_PROOF_AUTHORITY_ID;
  const authority = options.authority
    || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_NAME')
    || 'CodeSite Proof Authority';
  const privateKeyPem = options.privateKeyPem || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM');
  if (privateKeyPem) {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKeyPem = options.publicKeyPem
      || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM')
      || crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return {
      algorithm: 'ed25519',
      keyId,
      authority,
      privateKey,
      publicKeyPem,
    };
  }
  return {
    algorithm: 'hmac-sha256',
    keyId,
    authority,
    secret: options.authoritySecret
      || envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET')
      || envValue('AUTH_SECRET')
      || envValue('NEXTAUTH_SECRET')
      || DEFAULT_PROOF_AUTHORITY_SECRET,
  };
}

function resolveTrustedEd25519PublicKey(envelope, options = {}) {
  const trustedKeys = options.trustedKeys || parseTrustedKeys(envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON'));
  const trusted = trustedKeys?.[envelope.keyId];
  if (trusted?.algorithm && trusted.algorithm !== 'ed25519') return null;
  if (trusted?.publicKeyPem) return { publicKeyPem: trusted.publicKeyPem, source: 'trusted_keys' };
  if (trusted?.public_key_pem) return { publicKeyPem: trusted.public_key_pem, source: 'trusted_keys' };
  const envKeyId = envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID') || DEFAULT_PROOF_AUTHORITY_ID;
  const envPublicKey = envValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM');
  if (envPublicKey && envKeyId === envelope.keyId) return { publicKeyPem: envPublicKey, source: 'trusted_env_key' };
  return options.allowEmbeddedPublicKey !== false && envelope.publicKeyPem
    ? { publicKeyPem: envelope.publicKeyPem, source: 'embedded' }
    : null;
}

function parseTrustedKeys(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed
        .filter((item) => item?.keyId || item?.key_id)
        .map((item) => [item.keyId || item.key_id, item]));
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function parseSignatureValue(signature, algorithm, keyId) {
  const prefix = `${algorithm}:${keyId}:`;
  const value = String(signature || '');
  return value.startsWith(prefix) ? value.slice(prefix.length) : '';
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function envValue(key) {
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}
