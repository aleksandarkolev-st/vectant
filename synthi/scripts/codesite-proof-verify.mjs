#!/usr/bin/env node
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REQUIRED_FIELDS = [
  'schemaVersion',
  'projectId',
  'transactionId',
  'mutationLeaseId',
  'readSetDigest',
  'writeSetDigest',
  'invariants',
  'evidenceRefs',
  'portableDigest',
  'proofSignature',
];

const PROOF_SIGNATURE_SCHEMA_VERSION = 'synthi.codesite.proofSignature.v1';
const DEFAULT_PROOF_AUTHORITY_ID = 'codesite-local-proof-authority';
const DEFAULT_PROOF_AUTHORITY_SECRET = 'synthi-codesite-local-proof-authority-development-only';

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.bundlePath) {
    printUsage(args.help ? 0 : 1);
    return;
  }

  const result = verifyProofBundleFile(args.bundlePath, {
    trailersPath: args.trailersPath,
    requireTrailers: args.requireTrailers,
    repoPath: args.repoPath,
    commitSha: args.commitSha,
    requireGitCommit: args.requireGitCommit,
    authoritySecret: args.authoritySecret,
    trustedKeysPath: args.trustedKeysPath,
    allowEmbeddedPublicKey: args.allowEmbeddedPublicKey,
    requireTrustedAuthority: args.requireTrustedAuthority,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

export function verifyProofBundleFile(bundlePath, options = {}) {
  const absoluteBundlePath = path.resolve(bundlePath);
  const errors = [];
  const warnings = [];
  let bundle = null;

  try {
    bundle = JSON.parse(fs.readFileSync(absoluteBundlePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_unreadable'],
      errors: [error?.message || String(error)],
      bundlePath: absoluteBundlePath,
    };
  }

  const schemaVersionOk = bundle.schemaVersion === 'synthi.codesite.proofBundle.v1';
  if (!schemaVersionOk) errors.push('schemaVersion must be synthi.codesite.proofBundle.v1');

  const missingFields = REQUIRED_FIELDS.filter((field) => bundle[field] == null || bundle[field] === '');
  if (missingFields.length > 0) errors.push(`missing required fields: ${missingFields.join(', ')}`);

  if (!Array.isArray(bundle.invariants)) errors.push('invariants must be an array');
  if (!Array.isArray(bundle.evidenceRefs)) errors.push('evidenceRefs must be an array');
  if (!isDigest(bundle.readSetDigest)) errors.push('readSetDigest must be a sha256 digest');
  if (!isDigest(bundle.writeSetDigest)) errors.push('writeSetDigest must be a sha256 digest');
  if (bundle.incidentReplayDigest && !isDigest(bundle.incidentReplayDigest)) {
    errors.push('incidentReplayDigest must be a sha256 digest when present');
  }
  if (bundle.bundleDigest && !isDigest(bundle.bundleDigest)) {
    errors.push('bundleDigest must be a sha256 digest when present');
  }

  const { portableDigest, proofSignature, ...unsigned } = bundle;
  const expectedPortableDigest = digest(unsigned);
  const legacyDatePortableDigest = legacyDateObjectDigest(unsigned);
  const legacyDateDigestMatched = Boolean(
    portableDigest
    && legacyDatePortableDigest
    && portableDigest === legacyDatePortableDigest
  );
  if (!portableDigest) {
    warnings.push('portableDigest is absent; canonical digest was computed but cannot be compared');
  } else if (portableDigest !== expectedPortableDigest && !legacyDateDigestMatched) {
    errors.push('portableDigest mismatch');
  } else if (legacyDateDigestMatched) {
    warnings.push('portableDigest matches legacy Date-object canonicalization; regenerate the proof bundle to use ISO timestamp canonicalization');
  }
  const signatureResult = verifyProofSignature({ ...unsigned, portableDigest }, proofSignature, options);
  errors.push(...signatureResult.errors);
  warnings.push(...signatureResult.warnings);

  const trailerResult = verifyTrailers(bundle, options);
  errors.push(...trailerResult.errors);
  warnings.push(...trailerResult.warnings);

  const reasonCodes = [];
  if (schemaVersionOk) reasonCodes.push('proof_bundle_schema_valid');
  if (missingFields.length === 0) reasonCodes.push('proof_bundle_required_fields_present');
  if (portableDigest && (portableDigest === expectedPortableDigest || legacyDateDigestMatched)) {
    reasonCodes.push('proof_bundle_digest_valid');
  }
  if (signatureResult.checked) reasonCodes.push(...signatureResult.reasonCodes);
  if (legacyDateDigestMatched) reasonCodes.push('proof_bundle_legacy_date_digest_valid');
  if (trailerResult.checked) reasonCodes.push(...trailerResult.reasonCodes);
  if (warnings.length > 0) reasonCodes.push('proof_bundle_warnings_present');
  if (errors.length > 0) reasonCodes.push('proof_bundle_verification_failed');

  return {
    ok: errors.length === 0,
    reasonCodes,
    errors,
    warnings,
    bundlePath: absoluteBundlePath,
    trailersPath: trailerResult.trailersPath,
    gitCommit: trailerResult.gitCommit,
    expectedPortableDigest,
    legacyDatePortableDigest,
    observedPortableDigest: portableDigest || null,
    signature: signatureResult,
    transactionId: bundle.transactionId || null,
    mutationLeaseId: bundle.mutationLeaseId || null,
    readSetDigest: bundle.readSetDigest || null,
    writeSetDigest: bundle.writeSetDigest || null,
    blackBoxDigest: bundle.incidentReplayDigest || bundle.bundleDigest || portableDigest || expectedPortableDigest,
  };
}

function verifyTrailers(bundle, options) {
  const trailersPath = options.trailersPath ? path.resolve(options.trailersPath) : null;
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : null;
  const commitSha = normalizeCommitSha(options.commitSha || options.commit || bundle.commitSha);
  const errors = [];
  const warnings = [];
  const reasonCodes = [];
  let trailerText = null;
  let gitCommit = null;

  if (repoPath && commitSha) {
    try {
      const commitMessage = gitOutput(repoPath, ['show', '-s', '--format=%B', commitSha]);
      const resolvedCommitSha = gitOutput(repoPath, ['rev-parse', '--verify', `${commitSha}^{commit}`]);
      const treeSha = gitOutput(repoPath, ['show', '-s', '--format=%T', resolvedCommitSha]);
      trailerText = commitMessage;
      gitCommit = {
        repoPath,
        requestedCommitSha: commitSha,
        commitSha: resolvedCommitSha,
        treeSha,
        messageDigest: digest(commitMessage),
      };
      reasonCodes.push('proof_git_commit_loaded');
    } catch (error) {
      errors.push(`git commit unreadable: ${error?.message || String(error)}`);
      return { checked: false, errors, warnings, trailersPath, gitCommit, reasonCodes };
    }
  } else if (options.requireGitCommit) {
    errors.push('git commit verification is required but --repo and --commit were not both provided');
    return { checked: false, errors, warnings, trailersPath, gitCommit, reasonCodes };
  } else if (trailersPath) {
    try {
      trailerText = fs.readFileSync(trailersPath, 'utf8');
    } catch (error) {
      errors.push(`commit trailers unreadable: ${error?.message || String(error)}`);
      return { checked: false, errors, warnings, trailersPath, gitCommit, reasonCodes };
    }
  } else {
    if (options.requireTrailers) errors.push('commit trailers are required but no trailers file or git commit was provided');
    return { checked: false, errors, warnings, trailersPath, gitCommit, reasonCodes };
  }

  let trailers = {};
  trailers = parseTrailers(trailerText);

  const expected = {
    'CodeSite-Project': bundle.projectId,
    'CodeSite-Flight': bundle.displayCallsign,
    'CodeSite-Clearance': bundle.mutationLeaseId,
    'CodeSite-Landing': bundle.landingStatus,
    'CodeSite-Transaction': bundle.transactionId,
    'CodeSite-Lease': bundle.mutationLeaseId,
    'CodeSite-Read-Set': bundle.readSetDigest,
    'CodeSite-Write-Set': bundle.writeSetDigest,
    'CodeSite-Invariants': Array.isArray(bundle.invariants) ? bundle.invariants.join(',') : null,
    'CodeSite-Black-Box': bundle.incidentReplayDigest || bundle.bundleDigest || bundle.portableDigest,
    'CodeSite-Proof-Digest': bundle.portableDigest,
    'CodeSite-Proof-Authority': bundle.proofSignature?.keyId,
    'CodeSite-Proof-Signature': bundle.proofSignature?.signature,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue == null || expectedValue === '') continue;
    const observed = trailers[key];
    if (observed !== expectedValue) {
      errors.push(`commit trailer ${key} mismatch: expected ${expectedValue}, observed ${observed || '<missing>'}`);
    }
  }
  if (errors.length === 0) {
    reasonCodes.push('proof_commit_trailers_match');
    if (gitCommit) reasonCodes.push('proof_git_commit_trailers_match');
  }
  return { checked: true, errors, warnings, trailersPath, gitCommit, reasonCodes };
}

function gitOutput(repoPath, args) {
  return String(execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }) || '').trim();
}

function normalizeCommitSha(value) {
  const sha = String(value || '').trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

function parseTrailers(text) {
  const trailers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (match) trailers[match[1]] = match[2].trim();
  }
  return trailers;
}

function verifyProofSignature(unsignedBundle, proofSignature, options = {}) {
  const errors = [];
  const warnings = [];
  if (!proofSignature || typeof proofSignature !== 'object') {
    errors.push('proofSignature is required');
    return {
      checked: false,
      ok: false,
      reasonCodes: ['proof_bundle_signature_missing'],
      errors,
      warnings,
    };
  }
  const envelope = {
    schemaVersion: proofSignature.schemaVersion || proofSignature.schema_version || null,
    algorithm: proofSignature.algorithm || null,
    keyId: proofSignature.keyId || proofSignature.key_id || null,
    authority: proofSignature.authority || null,
    signedAt: proofSignature.signedAt || proofSignature.signed_at || null,
    payloadDigest: proofSignature.payloadDigest || proofSignature.payload_digest || null,
    signature: proofSignature.signature || null,
    publicKeyPem: proofSignature.publicKeyPem || proofSignature.public_key_pem || null,
  };
  if (envelope.schemaVersion !== PROOF_SIGNATURE_SCHEMA_VERSION) {
    errors.push(`proofSignature.schemaVersion must be ${PROOF_SIGNATURE_SCHEMA_VERSION}`);
  }
  const expectedPayloadDigest = unsignedBundle.portableDigest || digest(unsignedBundle);
  if (envelope.payloadDigest !== expectedPayloadDigest) {
    errors.push(`proofSignature payloadDigest mismatch: expected ${expectedPayloadDigest}, observed ${envelope.payloadDigest || '<missing>'}`);
  }
  if (!envelope.keyId) errors.push('proofSignature.keyId is required');
  if (!envelope.signature) errors.push('proofSignature.signature is required');
  if (errors.length) {
    return {
      checked: true,
      ok: false,
      reasonCodes: ['proof_bundle_signature_invalid'],
      errors,
      warnings,
      keyId: envelope.keyId || null,
      algorithm: envelope.algorithm || null,
    };
  }
  const signingPayload = stableJson({
    bundle: unsignedBundle,
    signature: {
      schemaVersion: envelope.schemaVersion,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      authority: envelope.authority,
      signedAt: envelope.signedAt,
      payloadDigest: envelope.payloadDigest,
    },
  });
  let ok = false;
  let publicKeySource = null;
  const requireTrustedAuthority = requiresTrustedProofAuthority(options);
  if (envelope.algorithm === 'hmac-sha256') {
    const secret = options.authoritySecret
      || proofAuthorityEnvValue('SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET')
      || process.env.AUTH_SECRET
      || process.env.NEXTAUTH_SECRET
      || DEFAULT_PROOF_AUTHORITY_SECRET;
    if (requireTrustedAuthority && secret === DEFAULT_PROOF_AUTHORITY_SECRET) {
      errors.push('trusted proof authority is required; development fallback secret rejected');
      return {
        checked: true,
        ok: false,
        reasonCodes: ['proof_bundle_signature_trusted_authority_required'],
        errors,
        warnings: ['proof signature development fallback secret rejected'],
        keyId: envelope.keyId,
        algorithm: envelope.algorithm,
      };
    }
    const expected = crypto.createHmac('sha256', secret).update(signingPayload).digest('base64url');
    ok = timingSafeEqualString(parseSignatureValue(envelope.signature, 'hmac-sha256', envelope.keyId), expected);
    if (secret === DEFAULT_PROOF_AUTHORITY_SECRET) {
      warnings.push('proof signature verified with development fallback secret');
    }
  } else if (envelope.algorithm === 'ed25519') {
    const keyResolution = resolveTrustedPublicKey(envelope, {
      ...options,
      allowEmbeddedPublicKey: requireTrustedAuthority ? false : options.allowEmbeddedPublicKey,
    });
    const publicKeyPem = keyResolution?.publicKeyPem;
    publicKeySource = keyResolution?.source || null;
    if (!publicKeyPem) {
      errors.push(requireTrustedAuthority ? 'trusted Ed25519 public key is required; embedded public key rejected' : 'trusted Ed25519 public key is required');
    } else {
      try {
        ok = crypto.verify(
          null,
          Buffer.from(signingPayload, 'utf8'),
          publicKeyPem,
          Buffer.from(parseSignatureValue(envelope.signature, 'ed25519', envelope.keyId), 'base64url'),
        );
      } catch (error) {
        errors.push(`proofSignature verification failed: ${error?.message || String(error)}`);
      }
      if (ok && keyResolution.source === 'embedded') {
        warnings.push('proof signature verified with embedded public key; provide --trusted-keys for authority pinning');
      }
    }
  } else {
    errors.push(`unsupported proofSignature algorithm: ${envelope.algorithm || '<missing>'}`);
  }
  if (!ok && errors.length === 0) errors.push('proofSignature cryptographic verification failed');
  return {
    checked: true,
    ok,
    reasonCodes: ok ? ['proof_bundle_signature_valid'] : ['proof_bundle_signature_invalid'],
    errors,
    warnings,
    keyId: envelope.keyId,
    algorithm: envelope.algorithm,
    publicKeySource,
  };
}

function resolveTrustedPublicKey(envelope, options = {}) {
  const trustedKeys = loadTrustedKeys(options.trustedKeysPath);
  const trusted = trustedKeys?.[envelope.keyId];
  const trustedSource = options.trustedKeysPath ? 'trusted_keys_file' : 'trusted_keys_env';
  if (trusted?.publicKeyPem) return { publicKeyPem: trusted.publicKeyPem, source: trustedSource };
  if (trusted?.public_key_pem) return { publicKeyPem: trusted.public_key_pem, source: trustedSource };
  const envKeyId = process.env.SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID || DEFAULT_PROOF_AUTHORITY_ID;
  const envPublicKey = proofAuthorityEnvValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM');
  if (envPublicKey && envKeyId === envelope.keyId) {
    return { publicKeyPem: envPublicKey, source: 'trusted_env_key' };
  }
  return options.allowEmbeddedPublicKey !== false && envelope.publicKeyPem
    ? { publicKeyPem: envelope.publicKeyPem, source: 'embedded' }
    : null;
}

function loadTrustedKeys(trustedKeysPath) {
  if (!trustedKeysPath) {
    try {
      const publicKeysJson = proofAuthorityEnvValue('SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON');
      const parsed = publicKeysJson
        ? JSON.parse(publicKeysJson)
        : null;
      return normalizeTrustedKeys(parsed);
    } catch (_) {
      return null;
    }
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(trustedKeysPath), 'utf8'));
  return normalizeTrustedKeys(parsed);
}

function requiresTrustedProofAuthority(options = {}) {
  if (options.requireTrustedAuthority != null) return options.requireTrustedAuthority === true;
  const envValue = String(process.env.SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'required'].includes(envValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(envValue)) return false;
  return process.env.NODE_ENV === 'production';
}

function normalizeTrustedKeys(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed
      .filter((item) => item?.keyId || item?.key_id)
      .map((item) => [item.keyId || item.key_id, item]));
  }
  return parsed;
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

function parseArgs(argv) {
  const args = {
    bundlePath: null,
    trailersPath: null,
    requireTrailers: false,
    repoPath: null,
    commitSha: null,
    requireGitCommit: false,
    authoritySecret: null,
    trustedKeysPath: null,
    allowEmbeddedPublicKey: true,
    requireTrustedAuthority: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--bundle') {
      args.bundlePath = argv[++index];
    } else if (arg === '--trailers') {
      args.trailersPath = argv[++index];
    } else if (arg === '--require-trailers') {
      args.requireTrailers = true;
    } else if (arg === '--repo') {
      args.repoPath = argv[++index];
    } else if (arg === '--commit') {
      args.commitSha = argv[++index];
    } else if (arg === '--require-git-commit') {
      args.requireGitCommit = true;
    } else if (arg === '--authority-secret') {
      args.authoritySecret = argv[++index];
    } else if (arg === '--trusted-keys') {
      args.trustedKeysPath = argv[++index];
    } else if (arg === '--no-embedded-public-key') {
      args.allowEmbeddedPublicKey = false;
    } else if (arg === '--require-trusted-authority') {
      args.requireTrustedAuthority = true;
    } else if (!args.bundlePath) {
      args.bundlePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write([
    'Usage: node scripts/codesite-proof-verify.mjs --bundle <proof.json> [--trailers <trailers.txt>] [--repo <repo> --commit <sha> --require-git-commit] [--require-trailers] [--trusted-keys keys.json] [--require-trusted-authority]',
    '',
    'Verifies a portable CodeSite proof bundle outside the UI and emits JSON.',
    '',
  ].join('\n'));
  process.exitCode = code;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function legacyDateObjectDigest(unsigned) {
  if (!unsigned || typeof unsigned.createdAt !== 'string') return null;
  return digest({ ...unsigned, createdAt: {} });
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function isDigest(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''));
}

function proofAuthorityEnvValue(key) {
  const direct = process.env[key];
  if (direct) return direct;
  const filePath = process.env[`${key}_FILE`];
  if (!filePath) return undefined;
  return fs.readFileSync(resolveProofAuthorityFilePath(filePath), 'utf8');
}

function resolveProofAuthorityFilePath(filePath) {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot(), filePath);
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi' ? path.dirname(process.cwd()) : process.cwd();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
