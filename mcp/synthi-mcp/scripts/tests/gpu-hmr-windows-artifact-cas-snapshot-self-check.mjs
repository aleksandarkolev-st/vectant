#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_AUTHORITY,
  WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_SCHEMA_VERSION,
  WINDOWS_ARTIFACT_CAS_VERIFIER_SOURCE_HASH,
  verifyWindowsArtifactCasSnapshot,
} from '../lib/gpu-hmr-windows-artifact-cas-snapshot.mjs';

const falseAuthorityFields = [
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
];

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertSupportOnly(result) {
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.schemaVersion, WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_SCHEMA_VERSION);
  assert.equal(result.authority, WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_AUTHORITY);
  for (const field of falseAuthorityFields) assert.equal(result[field], false, field);
}

async function main() {
  const unsafe = await verifyWindowsArtifactCasSnapshot({
    allowedRoot: 'C:\\not-used',
    relativePath: 'artifact.bin',
    testPipeName: 'forbidden',
  });
  assertSupportOnly(unsafe);
  assert.equal(unsafe.acceptedAsSnapshotEvidence, false);
  assert.deepEqual(unsafe.gaps, ['windows_artifact_cas_snapshot_input_field_invalid']);

  if (process.platform !== 'win32') {
    const unavailable = await verifyWindowsArtifactCasSnapshot({
      allowedRoot: '/tmp',
      relativePath: 'artifact.bin',
    });
    assertSupportOnly(unavailable);
    assert.equal(unavailable.acceptedAsSnapshotEvidence, false);
    assert.deepEqual(unavailable.gaps, ['windows_artifact_cas_snapshot_platform_unavailable']);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'synthi.gpu_hmr.windows_artifact_cas_snapshot_self_check.v1',
      skipped: true,
      reason: 'windows_only',
    })}\n`);
    return;
  }

  const base = await mkdtemp(path.join(os.tmpdir(), 'synthi-win-cas-bridge-'));
  const root = path.join(base, 'allowed-root');
  const nested = path.join(root, 'nested');
  const relativePath = 'nested/artifact.bin';
  const artifactPath = path.join(nested, 'artifact.bin');
  const bytes = Buffer.from('native Windows CAS snapshot bridge\n', 'utf8');
  const expectedSha256 = sha256(bytes);
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(artifactPath, bytes);
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = path.join(base, 'attacker-selected-system-root');
    let result;
    try {
      result = await verifyWindowsArtifactCasSnapshot({
        allowedRoot: root,
        relativePath,
        expectedSha256,
        expectedByteLength: bytes.byteLength,
        maxByteLength: 1024,
      });
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }
    assertSupportOnly(result);
    assert.equal(result.acceptedAsSnapshotEvidence, true, result.gaps.join(','));
    assert.deepEqual(result.gaps, []);
    assert.equal(result.helperSourceHash, WINDOWS_ARTIFACT_CAS_VERIFIER_SOURCE_HASH);
    assert.match(result.interpreterHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.normalizedSupportPath, relativePath);
    assert.equal(result.sha256, expectedSha256);
    assert.equal(result.byteLength, bytes.byteLength);
    assert.equal(result.snapshotIdentity.components.length, 2);
    assert.equal(result.snapshotIdentity.before.numberOfLinks, 1);
    assert.equal(result.snapshotIdentity.after.numberOfLinks, 1);
    assert.equal(Object.isFrozen(result.nativeSnapshot), true);

    const wrongHash = await verifyWindowsArtifactCasSnapshot({
      allowedRoot: root,
      relativePath,
      expectedSha256: `sha256:${'0'.repeat(64)}`,
      expectedByteLength: bytes.byteLength,
      maxByteLength: 1024,
    });
    assertSupportOnly(wrongHash);
    assert.equal(wrongHash.acceptedAsSnapshotEvidence, false);
    assert.ok(wrongHash.gaps.includes(
      'native_windows_artifact_cas_snapshot:expected_sha256_mismatch',
    ));

    const moduleSource = await readFile(
      new URL('../lib/gpu-hmr-windows-artifact-cas-snapshot.mjs', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      moduleSource,
      /^\s*if\s*\([^\n]*(?:project|repository|profile|fixture|backend|engine|scenario)(?:Name|Id)?\b/im,
    );
    assert.doesNotMatch(moduleSource, /TestPipeName|TestHoldFinalHandleMilliseconds/);
    assert.doesNotMatch(moduleSource, /['"]-File['"]/);
    assert.match(moduleSource, /process\.report\.getReport\(\)\.sharedObjects/);
    assert.match(moduleSource, /gzipSync\(normalizedHelperBytes/);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.windows_artifact_cas_snapshot_self_check.v1',
    skipped: false,
    ok: true,
    verifierSourceHash: WINDOWS_ARTIFACT_CAS_VERIFIER_SOURCE_HASH,
  })}\n`);
}

await main();
