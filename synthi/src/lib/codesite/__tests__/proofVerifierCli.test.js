import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProofBundle, formatCommitTrailers } from '../proof.js';

const roots = [];

// synthi package root, resolved from this file's location so the suite is
// independent of the vitest process cwd (repo-local harness runs with
// cwd=synthi; CI harness runs from its own temp dir).
const SYNTHI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPO_ROOT = path.dirname(SYNTHI_ROOT);

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
  'SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON',
  'SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE',
  'SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY',
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'NODE_ENV',
];

function runVerifier(args, envOverrides = {}) {
  const script = path.join(SYNTHI_ROOT, 'scripts/codesite-proof-verify.mjs');
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

function runGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return String(result.stdout || '').trim();
}

function initProofRepo(root, message) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'codesite@example.test']);
  runGit(repo, ['config', 'user.name', 'CodeSite Test']);
  fs.writeFileSync(path.join(repo, 'proof.txt'), 'proof\n');
  runGit(repo, ['add', 'proof.txt']);
  runGit(repo, ['commit', '-m', message]);
  return {
    repo,
    commitSha: runGit(repo, ['rev-parse', 'HEAD']),
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

  it('verifies proof trailers from the actual git commit object', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-git-'));
    roots.push(root);
    const bundle = makeBundle();
    const bundlePath = path.join(root, 'txn-1.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    const message = [
      'Land proof',
      '',
      formatCommitTrailers(bundle),
    ].join('\n');
    const { repo, commitSha } = initProofRepo(root, message);

    const result = runVerifier([
      '--bundle',
      bundlePath,
      '--repo',
      repo,
      '--commit',
      commitSha,
      '--require-git-commit',
    ]);

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      reasonCodes: expect.arrayContaining([
        'proof_git_commit_loaded',
        'proof_commit_trailers_match',
        'proof_git_commit_trailers_match',
      ]),
      gitCommit: {
        commitSha,
        requestedCommitSha: commitSha,
        messageDigest: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('fails when the actual git commit trailers do not match even if a sidecar trailer file does', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-git-'));
    roots.push(root);
    const bundle = makeBundle();
    const bundlePath = path.join(root, 'txn-1.proof.json');
    const trailersPath = path.join(root, 'txn-1.trailers.txt');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(trailersPath, formatCommitTrailers(bundle));
    const { repo, commitSha } = initProofRepo(root, [
      'Land proof without CodeSite trailers',
      '',
      'CodeSite-Proof-Digest: sha256:forged',
    ].join('\n'));

    const result = runVerifier([
      '--bundle',
      bundlePath,
      '--trailers',
      trailersPath,
      '--repo',
      repo,
      '--commit',
      commitSha,
      '--require-git-commit',
    ]);

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_verification_failed',
      ]),
      errors: expect.arrayContaining([
        expect.stringContaining('commit trailer CodeSite-Project mismatch'),
        expect.stringContaining('commit trailer CodeSite-Proof-Digest mismatch'),
      ]),
      gitCommit: {
        commitSha,
      },
    });
    expect(result.json.reasonCodes).not.toContain('proof_git_commit_trailers_match');
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

  it('refuses to sign when no proof authority is configured', () => {
    expect(() => withProofAuthorityEnvCleared(() => makeBundle()))
      .toThrow(/CodeSite proof authority is unconfigured/);
  });

  it('refuses to sign a trusted proof bundle with application auth secret fallback', () => {
    expect(() => withProcessEnv({
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE: null,
      SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY: '1',
      AUTH_SECRET: 'app-session-secret',
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    }, () => makeBundle())).toThrow(/trusted CodeSite proof authority requires/);
  });

  it('rejects application auth secret fallback when verifier requires a trusted authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = withProcessEnv({
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE: null,
      SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY: null,
      AUTH_SECRET: 'app-session-secret',
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    }, () => makeBundle());
    const bundlePath = path.join(root, 'txn-1.auth-secret-hmac.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const result = runVerifier(['--bundle', bundlePath, '--require-trusted-authority'], {
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE: null,
      AUTH_SECRET: 'app-session-secret',
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
        expect.stringContaining('AUTH_SECRET is not an explicit proof authority'),
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

  it('signs and verifies an Ed25519 proof from authority file inputs', () => {
    const repoRoot = REPO_ROOT;
    const relativeRoot = path.join('tmp', `codesite-proof-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const root = path.join(repoRoot, relativeRoot);
    fs.mkdirSync(root, { recursive: true });
    roots.push(root);
    const keyId = 'codesite-proof-ed25519-file-test';
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPath = path.join(root, 'proof-authority.private.pem');
    const publicKeyPath = path.join(root, 'proof-authority.public.pem');
    const publicKeysPath = path.join(root, 'trusted-proof-authorities.json');
    const privateKeyRelativePath = path.posix.join(relativeRoot, 'proof-authority.private.pem');
    const publicKeyRelativePath = path.posix.join(relativeRoot, 'proof-authority.public.pem');
    const publicKeysRelativePath = path.posix.join(relativeRoot, 'trusted-proof-authorities.json');
    fs.writeFileSync(privateKeyPath, privateKeyPem);
    fs.writeFileSync(publicKeyPath, publicKeyPem);
    fs.writeFileSync(publicKeysPath, JSON.stringify({
      [keyId]: {
        algorithm: 'ed25519',
        publicKeyPem,
      },
    }, null, 2));

    const bundle = withProcessEnv({
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_KEY_ID: keyId,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE: privateKeyRelativePath,
      SYNTHI_CODESITE_PROOF_AUTHORITY_BASE_DIR: REPO_ROOT,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE: publicKeyRelativePath,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE: null,
      AUTH_SECRET: null,
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    }, () => makeBundle());
    const bundlePath = path.join(root, 'txn-1.ed25519-file.proof.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const result = runVerifier(['--bundle', bundlePath, '--require-trusted-authority', '--no-embedded-public-key'], {
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PRIVATE_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEY_PEM_FILE: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON: null,
      SYNTHI_CODESITE_PROOF_AUTHORITY_PUBLIC_KEYS_JSON_FILE: publicKeysRelativePath,
      SYNTHI_CODESITE_PROOF_AUTHORITY_BASE_DIR: REPO_ROOT,
      AUTH_SECRET: null,
      NEXTAUTH_SECRET: null,
      NODE_ENV: 'development',
    });

    expect(bundle.proofSignature).toMatchObject({
      algorithm: 'ed25519',
      keyId,
    });
    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_signature_valid',
      ]),
      signature: {
        publicKeySource: 'trusted_keys_env',
      },
    });
    expect(result.json.reasonCodes).not.toContain('proof_bundle_warnings_present');
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
