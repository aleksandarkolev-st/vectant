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

function runVerifier(args) {
  const script = path.join(process.cwd(), 'scripts/codesite-proof-verify.mjs');
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
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
    const bundlePath = path.join(root, 'txn-1.proof.json');
    const trailersPath = path.join(root, 'txn-1.trailers.txt');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(trailersPath, formatCommitTrailers(bundle));

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

  it('accepts legacy proof bundles hashed with Date-object canonicalization and warns to regenerate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-proof-cli-'));
    roots.push(root);
    const bundle = makeBundle();
    bundle.portableDigest = legacyDateDigest(bundle);
    const bundlePath = path.join(root, 'txn-1.legacy-date.proof.json');
    const trailersPath = path.join(root, 'txn-1.legacy-date.trailers.txt');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(trailersPath, formatCommitTrailers(bundle));

    const result = runVerifier(['--bundle', bundlePath, '--trailers', trailersPath, '--require-trailers']);

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      reasonCodes: expect.arrayContaining([
        'proof_bundle_digest_valid',
        'proof_bundle_legacy_date_digest_valid',
        'proof_bundle_warnings_present',
      ]),
      warnings: expect.arrayContaining([
        expect.stringContaining('legacy Date-object canonicalization'),
      ]),
    });
  });
});
