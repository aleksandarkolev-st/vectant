import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  artifactCasManifestEvidence,
  artifactIdFromHash,
  casRelativePathForHash,
  collectArtifactLocators,
  hashFromArtifactId,
  idsMatchHashes,
  locatorFromBytes,
  normalizeArtifactId,
  normalizeSha256Hash,
  sha256Bytes,
  validateArtifactLocator,
  writeArtifactToCas,
} from '../lib/gpu-hmr-artifact-cas.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cas-smoke-'));
const bytes = Buffer.from('gpu hmr artifact transport bytes\n', 'utf8');
const contentHash = sha256Bytes(bytes);
const artifactId = artifactIdFromHash(contentHash);

assert.equal(normalizeSha256Hash(contentHash), contentHash);
assert.equal(normalizeSha256Hash(contentHash.slice('sha256:'.length)), contentHash);
assert.equal(normalizeArtifactId(artifactId), artifactId);
assert.equal(hashFromArtifactId(artifactId), contentHash);
assert.equal(idsMatchHashes([artifactId], [contentHash]), true);
assert.equal(idsMatchHashes([artifactId], ['sha256:0000000000000000000000000000000000000000000000000000000000000000']), false);

const locator = await locatorFromBytes({
  bytes,
  mediaType: 'application/octet-stream',
  artifactKind: 'proof_input',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  producerSubsystem: 'artifact_transport',
  sessionNamespace: 'cas-smoke-session',
  role: 'before_frame',
});

assert.equal(locator.schemaVersion, CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION);
assert.equal(locator.contentHash, contentHash);
assert.equal(locator.artifactId, artifactId);
assert.equal(locator.acceptedForGpuHmr, false);
assert.equal(locator.gpuHmrSuccess, false);

const written = await writeArtifactToCas(bytes, {
  artifactRoot: root,
  mediaType: 'image/png',
  artifactKind: 'visual_frame',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  producerSubsystem: 'visual_proof',
  sessionNamespace: 'cas-smoke-session',
  role: 'after_frame',
});

assert.equal(written.contentHash, contentHash);
assert.equal(written.storage.relativePath, casRelativePathForHash(contentHash));
assert.equal(await readFile(written.storage.localPath, 'utf8'), bytes.toString('utf8'));

const writtenAgain = await writeArtifactToCas(bytes, {
  artifactRoot: root,
  mediaType: 'image/png',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  sessionNamespace: 'cas-smoke-session',
  role: 'after_frame',
});
assert.equal(writtenAgain.artifactUri, written.artifactUri);
assert.equal(writtenAgain.storage.localPath, written.storage.localPath);

const accepted = await validateArtifactLocator(written, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(accepted.accepted, true);
assert.equal(accepted.acceptedAsTransportEvidence, true);
assert.equal(accepted.acceptedForGpuHmr, false);
assert.equal(accepted.gpuHmrSuccess, false);
assert.equal(accepted.readableContentHash, contentHash);

const evidence = artifactCasManifestEvidence(written, accepted);
assert.equal(evidence.acceptedAsTransportEvidence, true);
assert.equal(evidence.acceptedForGpuHmr, false);
assert.equal(evidence.gpuHmrSuccess, false);
assert.equal(evidence.proofAuthority, 'transport_integrity_only');

const forgedDigest = 'f'.repeat(64);
const forgedHash = `sha256:${forgedDigest}`;
const forgedDigestLocator = {
  ...written,
  contentHash: forgedHash,
  artifactId: artifactIdFromHash(forgedHash),
  artifactUri: `synthi-cas://cas-smoke-session/sha256/${forgedDigest}`,
  storage: {
    ...written.storage,
    relativePath: casRelativePathForHash(forgedHash),
  },
  manifestHash: null,
};
const forgedDigestResult = await validateArtifactLocator(forgedDigestLocator, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(forgedDigestResult.accepted, false);
assert.ok(forgedDigestResult.reasons.includes('artifact_cas_readable_hash_mismatch'));

const forgedLength = { ...written, byteLength: written.byteLength + 1, manifestHash: null };
const forgedLengthResult = await validateArtifactLocator(forgedLength, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(forgedLengthResult.accepted, false);
assert.ok(forgedLengthResult.reasons.includes('artifact_cas_readable_byte_length_mismatch'));

const escapedPath = {
  ...written,
  storage: {
    ...written.storage,
    localPath: path.resolve(root, '..', 'outside.bin'),
  },
  manifestHash: null,
};
const escapedPathResult = await validateArtifactLocator(escapedPath, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: false,
});
assert.equal(escapedPathResult.accepted, false);
assert.ok(escapedPathResult.reasons.includes('artifact_cas_local_path_outside_allowed_roots'));

const serializedFallback = await locatorFromBytes({
  bytes,
  transportKind: 'serialized_fallback',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  sessionNamespace: 'cas-smoke-session',
});
const fallbackResult = await validateArtifactLocator(serializedFallback);
assert.equal(fallbackResult.accepted, true);
assert.ok(fallbackResult.gaps.includes('serialized_artifact_transport_fallback'));
assert.equal(fallbackResult.acceptedForGpuHmr, false);

const legacyAliasLocator = {
  ...written,
  artifactId: undefined,
  contentHash: undefined,
  selectedArtifactId: written.artifactId,
  artifactContentHash: written.contentHash,
  contentBytes: written.byteLength,
  manifestHash: null,
};
const legacyAliasResult = await validateArtifactLocator(legacyAliasLocator, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(legacyAliasResult.accepted, true);

const collected = collectArtifactLocators({
  nested: {
    locators: [written],
    unrelated: { ok: true },
  },
});
assert.equal(collected.length, 1);
assert.equal(collected[0].artifactId, written.artifactId);

console.log('gpu-hmr artifact CAS smoke passed');
