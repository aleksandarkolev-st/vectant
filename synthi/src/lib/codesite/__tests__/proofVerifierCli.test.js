import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProofBundle, formatCommitTrailers } from '../proof.js';

const roots = [];

function makeBundle() {
  return buildProofBundle({
    project: { id: 'project-1', workspaceSlug: 'acme' },
    transaction: {
      id: 'txn-1',
      projectId: 'project-1',
      mutationLeaseId: 'lease-1',
      readSet: ['api/auth/signup.ts'],
      writeSet: ['api/auth/signup.ts'],
      invariants: ['typecheck:pass', 'security:pass'],
    },
    mutationLease: { id: 'lease-1', displayCallsign: 'CODEX-04' },
    landingRuns: [{ id: 'landing-1', status: 'landed-with-punch' }],
    proofBundle: {
      id: 'proof-1',
      transactionId: 'txn-1',
      readSetDigest: `sha256:${'a'.repeat(64)}`,
      writeSetDigest: `sha256:${'b'.repeat(64)}`,
      invariants: ['typecheck:pass', 'security:pass'],
      evidenceRefs: ['test:auth_signup', 'runtime:event:typecheck'],
      repoState: { evidenceDigest: `sha256:${'c'.repeat(64)}` },
      incidentReplayDigest: `sha256:${'d'.repeat(64)}`,
      bundleDigest: `sha256:${'e'.repeat(64)}`,
      createdAt: new Date('2026-06-30T11:30:00.000Z'),
    },
  });
}

const PROOF_AUTHORITY_ENV_KEYS = [
  'SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON',
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'NODE_ENV',
];

function runVerifier(args, envOverrides = {}) {
  const script = path.join(process.cwd(), 'scripts/codesite-proof-verify.mjs');
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value == null) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function withProofAuthorityEnvCleared(callback) {
  return withProcessEnv(Object.fromEntries(PROOF_AUTHORITY_ENV_KEYS.map((key) => [key, null])), callback);
}

function withProcessEnv(overrides, callback) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function legacyDateDigest(bundle) {
  const { portableDigest, ...unsigned } = bundle;
  return `sha256:${crypto.createHash('sha256').update(stableJson({
    ...unsigned,
    createdAt: {},
  })).digest('hex')}`;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

describe('CodeSite proof verifier CLI', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies a portable proof bundle and matching commit trailers outside the UI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = makeBundle();
    expect(bundle.createdAt).toBe('2026-06-30T11:30:00.000Z');
    expect(bundle.landingStatus).toBe('landed-with-punch');
    const bundlePath = path.join(root, 'txn-1.proof.json');
    const trailersPath = path.join(root, 'txn-1.trailers.txt');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(trailersPath, formatCommitTrailers(bundle));
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Project: project-1');
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Flight: CODEX-04');
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Clearance: lease-1');
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Landing: landed-with-punch');
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Proof-Digest: sha256:');
    expect(fs.readFileSync(trailersPath, 'utf8')).toContain('CodeSite-Proof-Signature: hmac-sha256:');

    const result = runVerifier(['--bundle', bundlePath, '--trailers', trailersPath, '--require-trailers']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.json).toMatchObject({
      ok: true,
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      reasonCodes: expect.arrayContaining([
        'proof_bundle_schema_valid',
        'proof_bundle_required_fields_present',
        'proof_bundle_digest_valid',
        'proof_bundle_signature_valid',
        'proof_commit_trailers_match',
      ]),
    });
  });

  it('fails when a proof bundle digest is tampered after export', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = makeBundle();
    bundle.writeSetDigest = `sha256:${'f'.repeat(64)}`;
    const bundlePath = path.join(root, 'txn-1.tampered.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const result = runVerifier(['--bundle', bundlePath]);

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      reasonCodes: expect.arrayContaining(['proof_bundle_verification_failed']),
      errors: expect.arrayContaining(['portableDigest mismatch']),
    });
  });

  it('rejects development HMAC proof authority when trusted authority is required', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = withProofAuthorityEnvCleared(() => makeBundle());
    const bundlePath = path.join(root, 'txn-1.dev-hmac.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const result = runVerifier(['--bundle', bundlePath, '--require-trusted-authority'], {
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      AUTH_SECRET: null,
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_signature_trusted_authority_required',
        'proof_bundle_verification_failed',
      ]),
      errors: expect.arrayContaining([
        expect.stringContaining('trusted proof authority is required'),
      ]),
    });
  });

  it('verifies an Ed25519 proof with a pinned trusted key without embedded-key warnings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const keyId = 'codesite-proof-ed25519-test';
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const bundle = withProcessEnv({
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID: keyId,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: privateKeyPem,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: publicKeyPem,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      AUTH_SECRET: null,
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    }, () => makeBundle());
    const bundlePath = path.join(root, 'txn-1.ed25519.proof.json');
    const keysPath = path.join(root, 'trusted-keys.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(keysPath, JSON.stringify({
      [keyId]: {
        algorithm: 'ed25519',
        publicKeyPem,
      },
    }, null, 2));

    const result = runVerifier(['--bundle', bundlePath, '--trusted-keys', keysPath, '--require-trusted-authority'], {
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      AUTH_SECRET: null,
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_signature_valid',
      ]),
      signature: {
        publicKeySource: 'trusted_keys_file',
      },
    });
    expect(result.json.reasonCodes).not.toContain('proof_bundle_warnings_present');
    expect(result.json.warnings).not.toContain(
      'proof signature verified with embedded public key; provide --trusted-keys for authority pinning',
    );
  });

  it('fails when portable proof fields required by the schema are missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = makeBundle();
    delete bundle.portableDigest;
    const bundlePath = path.join(root, 'txn-1.missing-portable.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const result = runVerifier(['--bundle', bundlePath]);

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      reasonCodes: expect.arrayContaining(['proof_bundle_verification_failed']),
      errors: expect.arrayContaining([expect.stringContaining('missing required fields: portableDigest')]),
    });
  });

  it('fails legacy digest-only proof when the signature no longer binds the payload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = makeBundle();
    bundle.portableDigest = legacyDateDigest(bundle);
    const bundlePath = path.join(root, 'txn-1.legacy-date.proof.json');
    const trailersPath = path.join(root, 'txn-1.legacy-date.trailers.txt');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(trailersPath, formatCommitTrailers(bundle));

    const result = runVerifier(['--bundle', bundlePath, '--trailers', trailersPath, '--require-trailers']);

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_signature_invalid',
        'proof_bundle_verification_failed',
      ]),
      errors: expect.arrayContaining([
        expect.stringContaining('proofSignature payloadDigest mismatch'),
      ]),
    });
  });
});
