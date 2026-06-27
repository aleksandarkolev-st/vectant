import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION,
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
  validateSharedArtifactAddressing,
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

const sharedWritten = await writeArtifactToCas(bytes, {
  artifactRoot: root,
  mediaType: 'image/png',
  artifactKind: 'visual_frame',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  producerSubsystem: 'visual_proof',
  sessionNamespace: 'cas-smoke-session',
  role: 'after_frame',
  sharedCasMounts: [
    { role: 'worker', root: '/shared/synthi-cas' },
    { role: 'mcp', root: '/shared/synthi-cas' },
  ],
});
assert.equal(sharedWritten.sharedStorage.schemaVersion, GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION);
assert.equal(sharedWritten.sharedStorage.contentHash, contentHash);
assert.equal(sharedWritten.sharedStorage.relativePath, casRelativePathForHash(contentHash));
assert.deepEqual(sharedWritten.sharedStorage.mountRoles, ['mcp', 'worker']);
assert.equal(sharedWritten.sharedStorage.mounts[0].path.endsWith(casRelativePathForHash(contentHash)), true);
assert.equal(sharedWritten.sharedStorage.acceptedForGpuHmr, false);
assert.equal(sharedWritten.sharedStorage.gpuHmrSuccess, false);

const sharedAccepted = await validateArtifactLocator(sharedWritten, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(sharedAccepted.accepted, true);
assert.equal(sharedAccepted.sharedStorage.accepted, true);
assert.equal(sharedAccepted.sharedMountCount, 2);
assert.deepEqual(sharedAccepted.sharedMountRoles, ['mcp', 'worker']);

const sharedEvidence = artifactCasManifestEvidence(sharedWritten, sharedAccepted);
assert.equal(sharedEvidence.sharedStorageAccepted, true);
assert.equal(sharedEvidence.sharedMountCount, 2);
assert.deepEqual(sharedEvidence.sharedMountRoles, ['mcp', 'worker']);
assert.equal(sharedEvidence.acceptedForGpuHmr, false);
assert.equal(sharedEvidence.gpuHmrSuccess, false);

const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-cas-consumer-'));
const consumerRelativePath = casRelativePathForHash(contentHash);
const consumerPath = path.join(consumerRoot, ...consumerRelativePath.split('/'));
await mkdir(path.dirname(consumerPath), { recursive: true });
await writeFile(consumerPath, bytes);
const portableLocator = {
  ...sharedWritten,
  storage: {
    kind: sharedWritten.storage.kind,
    relativePath: consumerRelativePath,
  },
  manifestHash: null,
};
const portableAccepted = await validateArtifactLocator(portableLocator, {
  artifactRoot: consumerRoot,
  allowedRoots: [consumerRoot],
  requireReadableBytes: true,
});
assert.equal(portableAccepted.accepted, true);
assert.equal(portableAccepted.resolvedFromRelativePath, true);
assert.equal(portableAccepted.readableContentHash, contentHash);
assert.equal(portableAccepted.localPath, await realpath(consumerPath));
assert.equal(path.relative(consumerRoot, portableAccepted.localPath).startsWith('..'), false);
assert.equal(portableAccepted.acceptedForGpuHmr, false);
assert.equal(portableAccepted.gpuHmrSuccess, false);

const forgedSharedPath = {
  ...sharedWritten.sharedStorage,
  mounts: [
    { ...sharedWritten.sharedStorage.mounts[0], path: '/shared/synthi-cas/sha256/ff/not-the-hash' },
    sharedWritten.sharedStorage.mounts[1],
  ],
};
const forgedSharedPathResult = validateSharedArtifactAddressing(forgedSharedPath, {
  expectedContentHash: contentHash,
  expectedRelativePath: casRelativePathForHash(contentHash),
  transportKind: 'cas_shared_volume',
});
assert.equal(forgedSharedPathResult.accepted, false);
assert.ok(forgedSharedPathResult.reasons.includes('shared_artifact_addressing_mount_path_mismatch'));

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

const snakeCaseSuccessClaim = {
  ...written,
  accepted_for_gpu_hmr: true,
  gpu_hmr_success: true,
  manifestHash: null,
};
const snakeCaseSuccessClaimResult = await validateArtifactLocator(snakeCaseSuccessClaim, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(snakeCaseSuccessClaimResult.accepted, false);
assert.ok(snakeCaseSuccessClaimResult.reasons.includes('artifact_cas_manifest_claims_gpu_hmr_success'));

const outsideRoot = path.join(root, '..', 'synthi-cas-smoke-outside');
await mkdir(outsideRoot, { recursive: true });
const outsideFile = path.join(outsideRoot, 'escaped.bin');
await writeFile(outsideFile, bytes);
const linkPath = path.join(root, 'escaped-link');
let symlinkCreated = false;
try {
  await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  symlinkCreated = true;
} catch {
  symlinkCreated = false;
}
if (symlinkCreated) {
  const symlinkEscape = {
    ...written,
    storage: {
      ...written.storage,
      localPath: path.join(linkPath, 'escaped.bin'),
      relativePath: null,
    },
    manifestHash: null,
  };
  const symlinkEscapeResult = await validateArtifactLocator(symlinkEscape, {
    artifactRoot: root,
    allowedRoots: [root],
    requireReadableBytes: true,
  });
  assert.equal(symlinkEscapeResult.accepted, false);
  assert.ok(symlinkEscapeResult.reasons.includes('artifact_cas_local_path_outside_allowed_roots'));
}

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
