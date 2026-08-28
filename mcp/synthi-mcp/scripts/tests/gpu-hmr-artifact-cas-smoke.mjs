import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_CAS_LOCATOR_LIMITS,
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
  snapshotPortableArtifactCasManifestInput,
  validateArtifactLocator,
  validateSharedArtifactAddressing,
  writeArtifactToCas,
} from '../lib/gpu-hmr-artifact-cas.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cas-smoke-'));
const bytes = Buffer.from('gpu hmr artifact transport bytes\n', 'utf8');
const contentHash = sha256Bytes(bytes);
const artifactId = artifactIdFromHash(contentHash);
const readableBytesAccepted = true;

const boundedSparsePath = path.join(root, 'bounded-sparse-artifact.bin');
await writeFile(boundedSparsePath, Buffer.alloc(0));
await truncate(boundedSparsePath, 2048);
const boundedSparseManifest = structuredClone(await locatorFromBytes({
  bytes,
  localPath: boundedSparsePath,
  mediaType: 'application/octet-stream',
  role: 'bounded_sparse_artifact',
  transportKind: 'direct_worker_path',
}));
delete boundedSparseManifest.manifestHash;
const boundedSparseValidation = await validateArtifactLocator(boundedSparseManifest, {
  allowedRoots: [root],
  requireReadableBytes: true,
  maxReadableByteLength: 1024,
});
assert.equal(boundedSparseValidation.accepted, false);
assert.ok(boundedSparseValidation.reasons.includes(
  'artifact_cas_readable_byte_length_exceeds_limit',
));

assert.equal(normalizeSha256Hash(contentHash), contentHash);
assert.equal(normalizeSha256Hash(contentHash.slice('sha256:'.length)), contentHash);
assert.equal(normalizeArtifactId(artifactId), artifactId);
assert.equal(hashFromArtifactId(artifactId), contentHash);
assert.equal(idsMatchHashes([artifactId], [contentHash]), true);
assert.equal(idsMatchHashes([artifactId], ['sha256:0000000000000000000000000000000000000000000000000000000000000000']), false);

const mutableManifestInput = {
  schemaVersion: CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  storage: {
    kind: 'cas',
    relativePath: 'sha256/00/original',
  },
  aliases: ['original'],
};
const portableManifestSnapshot =
  snapshotPortableArtifactCasManifestInput(mutableManifestInput);
assert.ok(portableManifestSnapshot);
assert.equal(Object.isFrozen(portableManifestSnapshot), true);
assert.equal(Object.isFrozen(portableManifestSnapshot.storage), true);
assert.equal(Object.isFrozen(portableManifestSnapshot.aliases), true);
mutableManifestInput.storage.relativePath = 'sha256/ff/mutated';
mutableManifestInput.aliases[0] = 'mutated';
assert.equal(
  portableManifestSnapshot.storage.relativePath,
  'sha256/00/original',
);
assert.deepEqual(portableManifestSnapshot.aliases, ['original']);

let unsafeManifestGetterCalls = 0;
const accessorManifestInput = {};
Object.defineProperty(accessorManifestInput, 'contentHash', {
  enumerable: true,
  get() {
    unsafeManifestGetterCalls += 1;
    return contentHash;
  },
});
assert.equal(
  snapshotPortableArtifactCasManifestInput(accessorManifestInput),
  null,
);
const proxiedManifestInput = new Proxy({}, {
  get() {
    unsafeManifestGetterCalls += 1;
    throw new Error('portable manifest snapshot must not invoke proxy getters');
  },
});
assert.equal(
  snapshotPortableArtifactCasManifestInput(proxiedManifestInput),
  null,
);
assert.equal(unsafeManifestGetterCalls, 0);

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
assert.equal(sharedAccepted.accepted, readableBytesAccepted);
assert.equal(sharedAccepted.sharedStorage.accepted, true);
assert.equal(sharedAccepted.sharedMountCount, 2);
assert.deepEqual(sharedAccepted.sharedMountRoles, ['mcp', 'worker']);
assert.equal(Object.isFrozen(sharedAccepted.sharedStorage), true);
assert.equal(Object.isFrozen(sharedAccepted.sharedMountRoles), true);

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
assert.equal(portableAccepted.accepted, readableBytesAccepted);
assert.equal(portableAccepted.resolvedFromRelativePath, true);
assert.equal(portableAccepted.readableContentHash, contentHash);
assert.equal(portableAccepted.localPath, null);
assert.equal(portableAccepted.local_path, null);
assert.equal(portableAccepted.supportPath, await realpath(consumerPath));
assert.equal(path.relative(consumerRoot, portableAccepted.supportPath).startsWith('..'), false);
assert.equal(portableAccepted.pathReusableAsProof, false);
assert.equal(portableAccepted.pathProofAuthority, 'support_locator_only');
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

const semanticSharedAlias = {
  schema_version: sharedWritten.sharedStorage.schemaVersion,
  address_kind: sharedWritten.sharedStorage.addressing,
  artifact_hash: sharedWritten.sharedStorage.contentHash.toUpperCase(),
  content_address: sharedWritten.sharedStorage.relativePath.replaceAll('/', '\\'),
  mount_count: sharedWritten.sharedStorage.mountCount,
  mount_roles: [...sharedWritten.sharedStorage.mountRoles].reverse(),
  shared_mounts: [...sharedWritten.sharedStorage.mounts].reverse().map((mount) => ({
    name: mount.role,
    mount_root: `${mount.root}/`,
    local_path: mount.path.replaceAll('/', '\\'),
    address_kind: mount.addressKind,
    readable_bytes_proven: mount.readableBytesProven,
  })),
  manifest_only: true,
  accepted_for_gpu_hmr: false,
  gpu_hmr_success: false,
  authority: sharedWritten.sharedStorage.proofAuthority,
};
const semanticSharedAliasResult = validateSharedArtifactAddressing(semanticSharedAlias, {
  expectedContentHash: contentHash,
  expectedRelativePath: casRelativePathForHash(contentHash),
  transportKind: 'cas_shared_volume',
});
assert.equal(semanticSharedAliasResult.accepted, true);

const unsupportedSharedAuthorityResult = validateSharedArtifactAddressing({
  ...sharedWritten.sharedStorage,
  proofAuthority: 'full_gpu_hmr_proof_authority',
}, {
  expectedContentHash: contentHash,
  expectedRelativePath: casRelativePathForHash(contentHash),
  transportKind: 'cas_shared_volume',
});
assert.equal(unsupportedSharedAuthorityResult.accepted, false);
assert.ok(unsupportedSharedAuthorityResult.reasons.includes('shared_artifact_addressing_alias_invalid'));

const equalSemanticSharedAliases = {
  ...sharedWritten,
  shared_storage: semanticSharedAlias,
  manifestHash: null,
};
const equalSemanticSharedAliasesResult = await validateArtifactLocator(equalSemanticSharedAliases, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(equalSemanticSharedAliasesResult.accepted, readableBytesAccepted);

for (const forgedMountAliases of [
  { role: 'forged_role' },
  { root: '/forged-root' },
  { path: '/forged-path' },
  { addressKind: 'forged_address_kind' },
]) {
  const conflictingSharedAlias = {
    ...semanticSharedAlias,
    shared_mounts: [
      { ...semanticSharedAlias.shared_mounts[0], ...forgedMountAliases },
      semanticSharedAlias.shared_mounts[1],
    ],
  };
  const conflictingSharedAliasResult = await validateArtifactLocator({
    ...sharedWritten,
    shared_storage: conflictingSharedAlias,
    manifestHash: null,
  }, {
    artifactRoot: root,
    allowedRoots: [root],
    requireReadableBytes: true,
  });
  assert.equal(conflictingSharedAliasResult.accepted, false);
  assert.ok(conflictingSharedAliasResult.reasons.includes('artifact_cas_shared_storage_alias_conflict'));
}

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
assert.equal(accepted.accepted, readableBytesAccepted);
assert.equal(accepted.acceptedAsTransportEvidence, readableBytesAccepted);
assert.equal(accepted.acceptedForGpuHmr, false);
assert.equal(accepted.gpuHmrSuccess, false);
assert.equal(accepted.readableContentHash, contentHash);
assert.equal(accepted.pathReusableAsProof, false);
assert.equal(accepted.pathProofAuthority, 'support_locator_only');
assert.equal(accepted.verifiedByteHash, contentHash);
assert.equal(accepted.verifiedByteLength, bytes.byteLength);
assert.equal(accepted.localPath, null);
assert.equal(accepted.local_path, null);
assert.equal(accepted.supportPath, await realpath(written.storage.localPath));
assert.equal(Object.isFrozen(accepted), true);
assert.equal(Object.isFrozen(accepted.reasons), true);
if (process.platform === 'win32') {
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.acceptedAsTransportEvidence, true);
  assert.equal(accepted.readableReparsePointCheck, 'native_handle_relative_no_reparse_chain');
  assert.equal(accepted.readablePathSafetyProven, true);
  assert.equal(typeof accepted.readableFileIdentity, 'string');
  assert.equal(accepted.readableFileIdentityProven, true);
  assert.equal(typeof accepted.verifiedSnapshotIdentity, 'object');
  assert.match(accepted.verifiedSnapshotIdentity.final.fileId128, /^[0-9a-f]{32}$/);
  assert.deepEqual(accepted.reasons, []);
  assert.deepEqual(accepted.gaps, []);
} else {
  assert.equal(accepted.readableFileIdentityProven, true);
  assert.equal(typeof accepted.verifiedSnapshotIdentity, 'string');
}

const snakeOnlyManifestHash = { ...written, manifest_hash: written.manifestHash };
delete snakeOnlyManifestHash.manifestHash;
const snakeOnlyManifestHashResult = await validateArtifactLocator(snakeOnlyManifestHash, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(snakeOnlyManifestHashResult.accepted, readableBytesAccepted);
assert.equal(snakeOnlyManifestHashResult.manifestHash, written.manifestHash);

const equalManifestHashAliases = {
  ...written,
  manifest_hash: written.manifestHash,
};
const equalManifestHashAliasesResult = await validateArtifactLocator(equalManifestHashAliases, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(equalManifestHashAliasesResult.accepted, readableBytesAccepted);
assert.equal(equalManifestHashAliasesResult.manifestHash, written.manifestHash);
assert.equal(equalManifestHashAliasesResult.manifestHash, snakeOnlyManifestHashResult.manifestHash);

const conflictingManifestHashAliases = {
  ...written,
  manifest_hash: `sha256:${'f'.repeat(64)}`,
};
const conflictingManifestHashAliasesResult = await validateArtifactLocator(conflictingManifestHashAliases, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingManifestHashAliasesResult.accepted, false);
assert.ok(conflictingManifestHashAliasesResult.reasons.includes('artifact_cas_manifest_hash_alias_conflict'));

const nullManifestHashConflictResult = await validateArtifactLocator({
  ...written,
  manifest_hash: null,
}, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(nullManifestHashConflictResult.accepted, false);
assert.ok(nullManifestHashConflictResult.reasons.includes('artifact_cas_manifest_hash_alias_conflict'));

const evidence = artifactCasManifestEvidence(written, accepted);
assert.equal(evidence.acceptedAsTransportEvidence, readableBytesAccepted);
assert.equal(evidence.acceptedForGpuHmr, false);
assert.equal(evidence.gpuHmrSuccess, false);
assert.equal(evidence.proofAuthority, 'transport_integrity_only');
assert.equal(evidence.contentHash, accepted.contentHash);
assert.equal(evidence.artifactId, accepted.artifactId);
assert.equal(evidence.artifactUri, accepted.artifactUri);
assert.equal(evidence.transportKind, accepted.transportKind);
assert.equal(evidence.byteLength, accepted.byteLength);
assert.equal(evidence.manifestHash, accepted.manifestHash);
assert.equal(evidence.verifiedByteHash, accepted.verifiedByteHash);
assert.equal(evidence.verifiedByteLength, accepted.verifiedByteLength);
assert.equal(evidence.verifiedSnapshotIdentity, accepted.verifiedSnapshotIdentity);
assert.equal(evidence.readableContentHash, accepted.readableContentHash);
assert.equal(evidence.readableByteLength, accepted.readableByteLength);
assert.equal(evidence.readableFileIdentity, accepted.readableFileIdentity);
assert.equal(evidence.readableFileIdentityProven, accepted.readableFileIdentityProven);
assert.equal(evidence.localPath, null);
assert.equal(evidence.local_path, null);
assert.equal(evidence.supportPath, accepted.supportPath);
assert.equal(evidence.pathReusableAsProof, false);
assert.equal(evidence.pathProofAuthority, 'support_locator_only');
assert.equal(Object.isFrozen(evidence), true);

const reconstructedValidationEvidence = artifactCasManifestEvidence(
  written,
  structuredClone(accepted),
);
assert.equal(reconstructedValidationEvidence.accepted, false);
assert.equal(reconstructedValidationEvidence.acceptedAsTransportEvidence, false);
assert.ok(
  reconstructedValidationEvidence.reasons.includes(
    'artifact_cas_validation_snapshot_untrusted',
  ),
);

const mutableManifest = {
  ...written,
  transport: { ...written.transport },
  storage: { ...written.storage },
};
const immutableValidation = await validateArtifactLocator(mutableManifest, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
const evidenceBeforeManifestMutation = artifactCasManifestEvidence(mutableManifest, immutableValidation);
mutableManifest.contentHash = `sha256:${'e'.repeat(64)}`;
mutableManifest.artifactId = `artifact:sha256:${'e'.repeat(64)}`;
mutableManifest.artifactUri = `synthi-cas://forged/sha256/${'e'.repeat(64)}`;
mutableManifest.byteLength = 1;
mutableManifest.manifestHash = `sha256:${'e'.repeat(64)}`;
mutableManifest.transport.kind = 'serialized_fallback';
mutableManifest.storage.localPath = path.join(root, 'mutated-after-validation.bin');
const evidenceAfterManifestMutation = artifactCasManifestEvidence(mutableManifest, immutableValidation);
assert.deepEqual(evidenceAfterManifestMutation, evidenceBeforeManifestMutation);
assert.equal(evidenceAfterManifestMutation.contentHash, contentHash);
assert.equal(evidenceAfterManifestMutation.artifactId, artifactId);
assert.equal(evidenceAfterManifestMutation.artifactUri, written.artifactUri);
assert.equal(evidenceAfterManifestMutation.transportKind, written.transport.kind);
assert.equal(evidenceAfterManifestMutation.byteLength, bytes.byteLength);
assert.equal(evidenceAfterManifestMutation.localPath, null);

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

const readableLinkPath = path.join(root, 'readable-artifact-link');
let readableLinkCreated = false;
try {
  await symlink(written.storage.localPath, readableLinkPath, 'file');
  readableLinkCreated = true;
} catch {
  readableLinkCreated = false;
}
if (readableLinkCreated) {
  const reparseLocator = {
    ...written,
    storage: {
      ...written.storage,
      localPath: readableLinkPath,
      relativePath: null,
    },
    manifestHash: null,
  };
  const reparseLocatorResult = await validateArtifactLocator(reparseLocator, {
    artifactRoot: root,
    allowedRoots: [root],
    requireReadableBytes: true,
  });
  assert.equal(reparseLocatorResult.accepted, false);
  assert.ok(reparseLocatorResult.reasons.includes('artifact_cas_local_path_reparse_point'));
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
  selectedArtifactId: written.artifactId,
  artifactContentHash: written.contentHash,
  contentBytes: written.byteLength,
  manifestHash: null,
};
delete legacyAliasLocator.artifactId;
delete legacyAliasLocator.contentHash;
const legacyAliasResult = await validateArtifactLocator(legacyAliasLocator, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(legacyAliasResult.accepted, readableBytesAccepted);

const conflictingHashAlias = {
  ...written,
  artifactHash: `sha256:${'f'.repeat(64)}`,
  manifestHash: null,
};
const conflictingHashAliasResult = await validateArtifactLocator(conflictingHashAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingHashAliasResult.accepted, false);
assert.ok(conflictingHashAliasResult.reasons.includes('artifact_cas_content_hash_alias_conflict'));

const conflictingLengthAlias = {
  ...written,
  artifactBytes: written.byteLength + 1,
  manifestHash: null,
};
const conflictingLengthAliasResult = await validateArtifactLocator(conflictingLengthAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingLengthAliasResult.accepted, false);
assert.ok(conflictingLengthAliasResult.reasons.includes('artifact_cas_byte_length_alias_conflict'));

const conflictingRoleAlias = {
  ...written,
  artifactRole: 'before_frame',
  manifestHash: null,
};
const conflictingRoleAliasResult = await validateArtifactLocator(conflictingRoleAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingRoleAliasResult.accepted, false);
assert.ok(conflictingRoleAliasResult.reasons.includes('artifact_cas_role_invalid'));

const conflictingStoragePathAlias = {
  ...written,
  storage: {
    ...written.storage,
    local_path: path.join(root, 'forged-artifact.bin'),
  },
  manifestHash: null,
};
const conflictingStoragePathAliasResult = await validateArtifactLocator(conflictingStoragePathAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingStoragePathAliasResult.accepted, false);
assert.ok(conflictingStoragePathAliasResult.reasons.includes('artifact_cas_storage_alias_conflict'));

const conflictingAuthorityAlias = {
  ...written,
  authority: 'gpu_hmr_success_authority',
  manifestHash: null,
};
const conflictingAuthorityAliasResult = await validateArtifactLocator(conflictingAuthorityAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingAuthorityAliasResult.accepted, false);
assert.ok(conflictingAuthorityAliasResult.reasons.includes('artifact_cas_proof_authority_alias_conflict'));

for (const unsupportedAuthority of [
  'gpu_hmr_acceptance_authority',
  'full_gpu_hmr_proof_authority',
  'acceptance_and_success_authority',
  ' transport_integrity_only ',
]) {
  const unsupportedAuthorityResult = await validateArtifactLocator({
    ...written,
    proofAuthority: unsupportedAuthority,
    manifestHash: null,
  }, {
    artifactRoot: root,
    allowedRoots: [root],
    requireReadableBytes: false,
  });
  assert.equal(unsupportedAuthorityResult.accepted, false);
  assert.ok(unsupportedAuthorityResult.reasons.includes('artifact_cas_proof_authority_alias_conflict'));
}

const conflictingSuccessAlias = {
  ...written,
  gpu_hmr_success: true,
  manifestHash: null,
};
const conflictingSuccessAliasResult = await validateArtifactLocator(conflictingSuccessAlias, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(conflictingSuccessAliasResult.accepted, false);
assert.ok(conflictingSuccessAliasResult.reasons.includes('artifact_cas_success_alias_conflict'));
assert.ok(conflictingSuccessAliasResult.reasons.includes('artifact_cas_manifest_claims_gpu_hmr_success'));

const equalDuplicateAliases = {
  ...written,
  contentHash: written.contentHash.toUpperCase(),
  artifactHash: written.contentHash,
  hash: written.contentHash,
  artifact_id: written.artifactId,
  selectedArtifactId: written.artifactId,
  byte_length: written.byteLength,
  artifactBytes: written.byteLength,
  artifactRole: written.role,
  proof_authority: written.proofAuthority,
  authority: written.proofAuthority,
  accepted_for_gpu_hmr: false,
  gpu_hmr_success: false,
  artifact_uri: written.artifactUri,
  transport: {
    ...written.transport,
    transportKind: written.transport.kind,
    content_addressed: true,
  },
  storage: {
    ...written.storage,
    local_path: written.storage.localPath,
    relative_path: written.storage.relativePath,
    contentAddress: written.storage.relativePath,
  },
  artifactStorage: {
    ...written.storage,
    local_path: written.storage.localPath,
    relative_path: written.storage.relativePath,
    contentAddress: written.storage.relativePath,
  },
  manifestHash: null,
};
const equalDuplicateAliasesResult = await validateArtifactLocator(equalDuplicateAliases, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: true,
});
assert.equal(equalDuplicateAliasesResult.accepted, readableBytesAccepted);

const accessorLocator = { ...written, manifestHash: null };
Object.defineProperty(accessorLocator, 'artifactHash', {
  enumerable: true,
  get() {
    throw new Error('accessor must not run');
  },
});
const accessorLocatorResult = await validateArtifactLocator(accessorLocator);
assert.equal(accessorLocatorResult.accepted, false);
assert.ok(accessorLocatorResult.reasons.includes('artifact_cas_manifest_unsafe'));

const proxyLocatorResult = await validateArtifactLocator(new Proxy({ ...written, manifestHash: null }, {}));
assert.equal(proxyLocatorResult.accepted, false);
assert.ok(proxyLocatorResult.reasons.includes('artifact_cas_manifest_unsafe'));

const symbolLocator = { ...written, manifestHash: null, [Symbol('untrusted')]: true };
const symbolLocatorResult = await validateArtifactLocator(symbolLocator);
assert.equal(symbolLocatorResult.accepted, false);
assert.ok(symbolLocatorResult.reasons.includes('artifact_cas_manifest_unsafe'));

for (const unsafeExtension of [
  { undefinedAtRoot: undefined },
  { nestedUndefined: { value: undefined } },
  { manifest_hash: undefined },
  { negativeZeroAtRoot: -0 },
  { nestedNegativeZero: { value: -0 } },
]) {
  const unsafeResult = await validateArtifactLocator({
    ...written,
    ...unsafeExtension,
    manifestHash: null,
  });
  assert.equal(unsafeResult.accepted, false);
  assert.ok(unsafeResult.reasons.includes('artifact_cas_manifest_unsafe'));
}

const validateGraphExtension = (extension) => validateArtifactLocator({
  ...written,
  ...extension,
  manifestHash: null,
}, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: false,
});

const nestedValueAtDepth = (depth) => {
  let value = 'depth-boundary';
  for (let current = depth - 1; current >= 1; current -= 1) value = { next: value };
  return value;
};
assert.equal((await validateGraphExtension({ depthBoundary: nestedValueAtDepth(
  ARTIFACT_CAS_LOCATOR_LIMITS.maxDepth,
) })).accepted, true);
assert.equal((await validateGraphExtension({ depthOverBound: nestedValueAtDepth(
  ARTIFACT_CAS_LOCATOR_LIMITS.maxDepth + 1,
) })).accepted, false);

const arrayBoundary = new Array(ARTIFACT_CAS_LOCATOR_LIMITS.maxArrayLength).fill(null);
assert.equal((await validateGraphExtension({ arrayBoundary })).accepted, true);
const arrayOverBound = new Array(ARTIFACT_CAS_LOCATOR_LIMITS.maxArrayLength + 1).fill(null);
assert.equal((await validateGraphExtension({ arrayOverBound })).accepted, false);

const objectBoundary = Object.fromEntries(Array.from(
  { length: ARTIFACT_CAS_LOCATOR_LIMITS.maxObjectKeys },
  (_, index) => [`key_${index}`, null],
));
assert.equal((await validateGraphExtension({ objectBoundary })).accepted, true);
const objectOverBound = { ...objectBoundary, one_key_over: null };
assert.equal((await validateGraphExtension({ objectOverBound })).accepted, false);

const descriptorSafeWideObject = Object.fromEntries(Array.from(
  { length: ARTIFACT_CAS_LOCATOR_LIMITS.maxObjectKeys + 1 },
  (_, index) => [`wide_${index}`, null],
));
const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
let descriptorMaterializations = 0;
Object.getOwnPropertyDescriptors = (...args) => {
  descriptorMaterializations += 1;
  return originalGetOwnPropertyDescriptors(...args);
};
try {
  const descriptorSafeWideResult = await validateGraphExtension({ descriptorSafeWideObject });
  assert.equal(descriptorSafeWideResult.accepted, false);
  assert.ok(descriptorSafeWideResult.reasons.includes('artifact_cas_manifest_unsafe'));
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
}
assert.equal(descriptorMaterializations, 0);

const zeroValueResult = await validateGraphExtension({ collisionNumber: 0 });
assert.equal(zeroValueResult.accepted, true);
assert.equal(zeroValueResult.localPath, null);
assert.equal(zeroValueResult.local_path, null);
assert.equal(zeroValueResult.supportPath, await realpath(written.storage.localPath));
assert.equal(zeroValueResult.pathReusableAsProof, false);
const negativeZeroValueResult = await validateGraphExtension({ collisionNumber: -0 });
assert.equal(negativeZeroValueResult.accepted, false);

const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-cas-snapshot-'));
const snapshotPath = path.join(snapshotRoot, 'artifact.bin');
await writeFile(snapshotPath, bytes);
const snapshotLocator = await locatorFromBytes({
  bytes,
  localPath: snapshotPath,
  mediaType: 'application/octet-stream',
  producer: { name: 'cas_smoke', kind: 'self_check' },
  sessionNamespace: 'cas-smoke-session',
  role: 'snapshot_test',
});
const snapshotValidation = await validateArtifactLocator(snapshotLocator, {
  artifactRoot: snapshotRoot,
  allowedRoots: [snapshotRoot],
  requireReadableBytes: true,
});
assert.equal(snapshotValidation.accepted, readableBytesAccepted);
assert.equal(snapshotValidation.verifiedByteHash, contentHash);
assert.equal(snapshotValidation.verifiedByteLength, bytes.byteLength);
assert.equal(snapshotValidation.pathReusableAsProof, false);
assert.equal(snapshotValidation.pathProofAuthority, 'support_locator_only');
assert.equal(snapshotValidation.localPath, null);
assert.equal(snapshotValidation.local_path, null);
assert.equal(snapshotValidation.supportPath, await realpath(snapshotPath));
if (process.platform === 'win32') {
  assert.equal(typeof snapshotValidation.verifiedSnapshotIdentity, 'object');
  assert.match(snapshotValidation.verifiedSnapshotIdentity.final.fileId128, /^[0-9a-f]{32}$/);
  assert.deepEqual(snapshotValidation.gaps, []);
} else {
  assert.ok(snapshotValidation.verifiedSnapshotIdentity);
}
await writeFile(snapshotPath, Buffer.from('mutated after validation\n', 'utf8'));
assert.notEqual(sha256Bytes(await readFile(snapshotPath)), snapshotValidation.verifiedByteHash);
assert.equal(snapshotValidation.verifiedByteHash, contentHash);

const stringBoundary = 'x'.repeat(ARTIFACT_CAS_LOCATOR_LIMITS.maxStringBytes);
assert.equal((await validateGraphExtension({ stringBoundary })).accepted, true);
const stringOverBound = `${stringBoundary}x`;
assert.equal((await validateGraphExtension({ stringOverBound })).accepted, false);

const portableNodeCount = (value, seen = new WeakSet()) => {
  let count = 1;
  if (!value || typeof value !== 'object') return count;
  if (seen.has(value)) throw new Error('test graph must not repeat objects');
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) count += portableNodeCount(child, seen);
  return count;
};
const makeNodeBudget = (nodeCount) => {
  if (nodeCount === 1) return null;
  const value = [];
  let remaining = nodeCount - 1;
  while (remaining > 0) {
    if (remaining === 1) {
      value.push(null);
      remaining -= 1;
    } else {
      const leaves = Math.min(ARTIFACT_CAS_LOCATOR_LIMITS.maxArrayLength, remaining - 1);
      value.push(new Array(leaves).fill(null));
      remaining -= leaves + 1;
    }
  }
  return value;
};
const nodeBudgetBase = { ...written, manifestHash: null, nodeBudget: null };
const baseNodesWithoutBudget = portableNodeCount(nodeBudgetBase) - 1;
const exactNodeBudget = makeNodeBudget(ARTIFACT_CAS_LOCATOR_LIMITS.maxNodes - baseNodesWithoutBudget);
assert.equal((await validateGraphExtension({ nodeBudget: exactNodeBudget })).accepted, true);
const overNodeBudget = makeNodeBudget(ARTIFACT_CAS_LOCATOR_LIMITS.maxNodes - baseNodesWithoutBudget + 1);
assert.equal((await validateGraphExtension({ nodeBudget: overNodeBudget })).accepted, false);

const portableByteCount = (value, seen = new WeakSet()) => {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value)) throw new Error('test graph must not repeat objects');
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + portableByteCount(entry, seen), 0);
  }
  return Object.entries(value).reduce(
    (total, [key, entry]) => total + Buffer.byteLength(key, 'utf8') + portableByteCount(entry, seen),
    0,
  );
};
const totalByteBoundary = {
  ...written,
  manifestHash: null,
  bytePaddingA: 'x'.repeat(ARTIFACT_CAS_LOCATOR_LIMITS.maxStringBytes),
  bytePaddingB: '',
};
const remainingBytes = ARTIFACT_CAS_LOCATOR_LIMITS.maxTotalBytes - portableByteCount(totalByteBoundary);
assert.ok(remainingBytes >= 0 && remainingBytes <= ARTIFACT_CAS_LOCATOR_LIMITS.maxStringBytes);
totalByteBoundary.bytePaddingB = 'x'.repeat(remainingBytes);
assert.equal(portableByteCount(totalByteBoundary), ARTIFACT_CAS_LOCATOR_LIMITS.maxTotalBytes);
const totalByteBoundaryResult = await validateArtifactLocator(totalByteBoundary, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: false,
});
assert.equal(totalByteBoundaryResult.accepted, true);
const totalByteOverBound = { ...totalByteBoundary, bytePaddingB: `${totalByteBoundary.bytePaddingB}x` };
assert.equal((await validateArtifactLocator(totalByteOverBound, {
  artifactRoot: root,
  allowedRoots: [root],
  requireReadableBytes: false,
})).accepted, false);

const sparseArray = new Array(2);
sparseArray[0] = null;
assert.equal((await validateGraphExtension({ sparseArray })).accepted, false);
const cyclicGraph = {};
cyclicGraph.self = cyclicGraph;
assert.equal((await validateGraphExtension({ cyclicGraph })).accepted, false);
const repeatedGraph = { value: 'repeated' };
assert.equal((await validateGraphExtension({ repeatedGraphA: repeatedGraph, repeatedGraphB: repeatedGraph })).accepted, false);

const hardlinkAlias = path.join(root, 'hardlink-alias.bin');
await link(written.storage.localPath, hardlinkAlias);
try {
  const hardlinkedResult = await validateArtifactLocator(written, {
    artifactRoot: root,
    allowedRoots: [root],
    requireReadableBytes: true,
  });
  assert.equal(hardlinkedResult.accepted, false);
  assert.ok(
    hardlinkedResult.reasons.includes('artifact_cas_hardlink_count_invalid')
      || hardlinkedResult.gaps.some((gap) => gap.includes('final_link_count_invalid')),
  );
} finally {
  await unlink(hardlinkAlias);
}

const collected = collectArtifactLocators({
  nested: {
    locators: [written],
    unrelated: { ok: true },
  },
});
assert.equal(collected.length, 1);
assert.equal(collected[0].artifactId, written.artifactId);

console.log('gpu-hmr artifact CAS smoke passed');
