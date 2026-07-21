import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { verifyWindowsArtifactCasSnapshot } from './gpu-hmr-windows-artifact-cas-snapshot.mjs';

export const CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION = 'synthi.cas.artifact_locator.v1';

export const GPU_HMR_ARTIFACT_CAS_MANIFEST_SCHEMA_VERSION = CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION;

export const GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.artifact_transport_evidence.v1';

export const GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION =
  'synthi.gpu_hmr.shared_artifact_addressing.v1';

export const DEFAULT_GPU_HMR_CAS_URI_SCHEME = 'synthi-cas';

export const GPU_HMR_ARTIFACT_CAS_MAX_VALIDATED_BYTES = 1024 * 1024 * 1024;

export const SUPPORTED_GPU_HMR_ARTIFACT_TRANSPORTS = Object.freeze([
  'cas_shared_volume',
  'cas_tmpfs',
  'direct_worker_path',
  'serialized_fallback',
]);

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const ARTIFACT_MANIFEST_PROOF_AUTHORITIES = new Set(['transport_integrity_only']);
const SHARED_STORAGE_PROOF_AUTHORITIES = new Set(['shared_artifact_addressing_only']);
const IMMUTABLE_VALIDATION_SNAPSHOTS = new WeakSet();

export const ARTIFACT_CAS_LOCATOR_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxArrayLength: 2048,
  maxObjectKeys: 256,
  maxStringBytes: 512 * 1024,
  maxTotalBytes: 1024 * 1024,
});

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

export function sha256Bytes(bytes) {
  return `sha256:${sha256Digest(bytes)}`;
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value ?? ''), 'utf8'));
}

export function artifactIdForHash(hash) {
  const normalized = normalizeSha256Hash(hash);
  return `artifact:${normalized}`;
}

export const artifactIdFromHash = artifactIdForHash;

export function hashFromArtifactId(value) {
  const artifactId = normalizeArtifactId(value);
  return artifactId.slice('artifact:'.length);
}

export function idsMatchHashes(ids = [], hashes = []) {
  const artifactIds = Array.isArray(ids) ? ids : [ids];
  const contentHashes = Array.isArray(hashes) ? hashes : [hashes];
  if (artifactIds.length !== contentHashes.length) return false;
  for (let index = 0; index < artifactIds.length; index += 1) {
    try {
      if (hashFromArtifactId(artifactIds[index]) !== normalizeSha256Hash(contentHashes[index])) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function normalizeSha256Hash(value) {
  if (typeof value !== 'string') {
    throw new Error('sha256_hash_must_be_string');
  }
  const trimmed = value.trim().toLowerCase();
  const digest = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new Error('sha256_hash_invalid');
  }
  return `sha256:${digest}`;
}

export function normalizeArtifactId(value) {
  if (typeof value !== 'string') {
    throw new Error('artifact_id_must_be_string');
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith('artifact:sha256:')) {
    throw new Error('artifact_id_invalid_prefix');
  }
  return `artifact:${normalizeSha256Hash(trimmed.slice('artifact:'.length))}`;
}

export function digestFromHash(hash) {
  return normalizeSha256Hash(hash).slice('sha256:'.length);
}

export function casRelativePathForHash(hash) {
  const digest = digestFromHash(hash);
  return path.posix.join('sha256', digest.slice(0, 2), digest);
}

export function casUriForHash(hash, options = {}) {
  const digest = digestFromHash(hash);
  const scheme = normalizeUriScheme(options.scheme ?? DEFAULT_GPU_HMR_CAS_URI_SCHEME);
  const namespace = normalizeCasSegment(options.namespace ?? options.sessionNamespace ?? 'default');
  return `${scheme}://${namespace}/sha256/${digest}`;
}

export function defaultCasRootFromEnv(env = process.env) {
  return text(env.SYNTHI_GPU_HMR_CAS_ROOT)
    ?? text(env.SYNTHI_GPU_HMR_SHARED_ARTIFACT_ROOT)
    ?? text(env.SYNTHI_ARTIFACT_CAS_ROOT)
    ?? null;
}

export function defaultSharedCasMountsFromEnv(env = process.env) {
  const raw = text(
    env.SYNTHI_GPU_HMR_SHARED_CAS_MOUNTS_JSON
    ?? env.SYNTHI_GPU_HMR_CAS_MOUNTS_JSON
    ?? env.SYNTHI_SHARED_ARTIFACT_MOUNTS_JSON,
  );
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('shared_cas_mounts_json_invalid');
  }
  return normalizeSharedCasMounts(parsed);
}

export async function buildArtifactCasManifest(input = {}) {
  const bytes = await resolveInputBytes(input);
  const contentHash = sha256Bytes(bytes);
  const byteLength = bytes.byteLength;
  const sessionNamespace = normalizeCasSegment(input.sessionNamespace ?? input.namespace ?? 'default');
  const role = normalizeCasSegment(input.role ?? 'artifact');
  const mediaType = normalizeMediaType(input.mediaType ?? 'application/octet-stream');
  const producer = normalizeProducer(input.producer);
  const transportKind = normalizeTransportKind(input.transportKind ?? (
    input.localPath || input.path ? 'direct_worker_path' : 'serialized_fallback'
  ));
  const artifactUri = input.artifactUri
    ? normalizeCasUri(input.artifactUri, { expectedHash: contentHash })
    : casUriForHash(contentHash, {
      scheme: input.uriScheme ?? DEFAULT_GPU_HMR_CAS_URI_SCHEME,
      sessionNamespace,
    });
  const manifest = {
    schemaVersion: CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
    artifactId: artifactIdForHash(contentHash),
    contentHash,
    artifactKind: normalizeCasSegment(input.artifactKind ?? 'binary_artifact'),
    byteLength,
    mediaType,
    role,
    producer,
    producerSubsystem: input.producerSubsystem ? normalizeCasSegment(input.producerSubsystem) : producer.name,
    sessionNamespace,
    artifactUri,
    transport: {
      kind: transportKind,
      contentAddressed: true,
      manifestOnly: true,
      bytesEmbedded: false,
      hotPathOptimized: transportKind !== 'serialized_fallback',
    },
    proofAuthority: 'transport_integrity_only',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  };
  const localPath = text(input.localPath ?? input.path);
  const relativePath = input.relativePath ? normalizeRelativeCasPath(input.relativePath) : null;
  const includeLocalPath = input.includeLocalPath !== false && input.portable !== true;
  if (localPath || relativePath) {
    manifest.storage = {
      kind: transportKind,
      ...(includeLocalPath && localPath ? { localPath: path.resolve(localPath) } : {}),
      relativePath,
    };
  }
  const sharedStorage = buildSharedArtifactAddressing({
    contentHash,
    relativePath: input.relativePath,
    mounts: firstPresent(input.sharedCasMounts, input.shared_cas_mounts, input.sharedMounts, input.shared_mounts),
  });
  if (sharedStorage !== null) {
    manifest.sharedStorage = sharedStorage;
    manifest.shared_storage = clonePortableData(sharedStorage).value;
  }
  manifest.manifestHash = artifactManifestHash(manifest);
  return manifest;
}

export const locatorFromBytes = buildArtifactCasManifest;

export async function writeArtifactToCas(bytes, options = {}) {
  const configuredRoot = text(options.artifactRoot) ?? defaultCasRootFromEnv();
  if (!configuredRoot) {
    throw new Error('artifact_cas_root_required');
  }
  const root = path.resolve(configuredRoot);
  const inputBytes = toBuffer(bytes);
  const contentHash = sha256Bytes(inputBytes);
  const relativePath = casRelativePathForHash(contentHash);
  const targetPath = assertPathInsideRoot(root, path.join(root, ...relativePath.split('/')));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFileIfAbsent(targetPath, inputBytes);
  const existingBytes = await readFile(targetPath);
  if (sha256Bytes(existingBytes) !== contentHash || existingBytes.byteLength !== inputBytes.byteLength) {
    throw new Error('artifact_cas_existing_content_mismatch');
  }
  return buildArtifactCasManifest({
    bytes: inputBytes,
    localPath: targetPath,
    relativePath,
    artifactKind: options.artifactKind,
    mediaType: options.mediaType,
    producer: options.producer,
    producerSubsystem: options.producerSubsystem,
    sessionNamespace: options.sessionNamespace,
    namespace: options.namespace,
    role: options.role,
    transportKind: options.transportKind ?? transportKindForRoot(root),
    uriScheme: options.uriScheme,
    artifactRoot: root,
    includeLocalPath: options.includeLocalPath,
    portable: options.portable,
    sharedCasMounts: sharedCasMountsOption(options),
  });
}

export async function validateArtifactCasManifest(manifest, options = {}) {
  const reasons = [];
  const gaps = [];
  const safeManifest = clonePortableData(manifest);
  const normalized = safeManifest.ok && isObject(safeManifest.value)
    ? safeManifest.value
    : {};
  const result = {
    schemaVersion: GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
    accepted: false,
    acceptedAsTransportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only',
    manifestHash: null,
    contentHash: null,
    artifactId: null,
    artifactUri: null,
    transportKind: null,
    byteLength: null,
    mediaType: null,
    // Paths are support locators only and are never reusable byte proof.
    localPath: null,
    local_path: null,
    supportPath: null,
    support_path: null,
    pathReusableAsProof: false,
    path_reusable_as_proof: false,
    pathProofAuthority: 'support_locator_only',
    path_proof_authority: 'support_locator_only',
    verifiedByteHash: null,
    verified_byte_hash: null,
    verifiedByteLength: null,
    verified_byte_length: null,
    verifiedSnapshotIdentity: null,
    verified_snapshot_identity: null,
    snapshotProofAuthority: 'verified_handle_snapshot_only',
    snapshot_proof_authority: 'verified_handle_snapshot_only',
    reasons,
    gaps,
  };

  const fail = (reason) => {
    reasons.push(reason);
  };
  const maxReadableByteLength = options.maxReadableByteLength === undefined
    ? GPU_HMR_ARTIFACT_CAS_MAX_VALIDATED_BYTES
    : options.maxReadableByteLength;
  if (
    !Number.isSafeInteger(maxReadableByteLength)
    || maxReadableByteLength < 1
    || maxReadableByteLength > GPU_HMR_ARTIFACT_CAS_MAX_VALIDATED_BYTES
  ) {
    fail('artifact_cas_readable_byte_limit_invalid');
  }

  if (!safeManifest.ok || !isObject(safeManifest.value)) {
    fail('artifact_cas_manifest_unsafe');
  }

  const schemaVersion = resolveAliasGroup(normalized, ['schemaVersion', 'schema_version'], (value) => {
    if (typeof value !== 'string') throw new Error('schema_version_invalid');
    return value;
  });
  if (!schemaVersion.ok) {
    fail('artifact_cas_schema_version_alias_conflict');
  } else if (schemaVersion.value !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail('artifact_cas_manifest_schema_invalid');
  }

  const contentHashAlias = resolveAliasGroup(normalized, [
    'contentHash', 'content_hash', 'artifactHash', 'artifact_hash',
    'artifactContentHash', 'artifact_content_hash', 'ramBytesHash', 'ram_bytes_hash', 'hash',
  ], normalizeSha256Hash);
  let contentHash = contentHashAlias.value ?? null;
  if (!contentHashAlias.ok) {
    fail('artifact_cas_content_hash_alias_conflict');
    contentHash = null;
  } else if (!contentHashAlias.present) {
    fail('artifact_cas_content_hash_invalid');
  } else {
    result.contentHash = contentHash;
  }

  const artifactIdAlias = resolveAliasGroup(normalized, [
    'artifactId', 'artifact_id', 'selectedArtifactId', 'selected_artifact_id', 'ramBlobId', 'ram_blob_id',
  ], normalizeArtifactId);
  if (!artifactIdAlias.ok) {
    fail('artifact_cas_artifact_id_alias_conflict');
  } else if (!artifactIdAlias.present) {
    fail('artifact_cas_artifact_id_invalid');
  } else {
    const artifactId = artifactIdAlias.value;
    result.artifactId = artifactId;
    if (contentHash && artifactId !== artifactIdForHash(contentHash)) {
      fail('artifact_cas_artifact_id_hash_mismatch');
    }
  }

  const byteLengthAlias = resolveAliasGroup(normalized, [
    'byteLength', 'byte_length', 'artifactBytes', 'artifact_bytes', 'contentBytes', 'content_bytes',
  ], normalizeByteLength);
  if (!byteLengthAlias.ok) {
    fail('artifact_cas_byte_length_alias_conflict');
  } else if (!byteLengthAlias.present) {
    fail('artifact_cas_byte_length_invalid');
  } else {
    result.byteLength = byteLengthAlias.value;
  }

  const mediaType = resolveAliasGroup(normalized, ['mediaType', 'media_type'], normalizeMediaType);
  if (!mediaType.ok || !mediaType.present) {
    fail('artifact_cas_media_type_invalid');
  } else {
    result.mediaType = mediaType.value;
  }

  const role = resolveAliasGroup(normalized, ['role', 'artifactRole', 'artifact_role'], normalizeCasSegment);
  if (!role.ok || !role.present) {
    fail('artifact_cas_role_invalid');
  }

  const artifactKind = resolveAliasGroup(normalized, ['artifactKind', 'artifact_kind'], normalizeCasSegment);
  if (!artifactKind.ok) {
    fail('artifact_cas_artifact_kind_alias_conflict');
  } else if (artifactKind.present && !artifactKind.value) {
    fail('artifact_cas_artifact_kind_invalid');
  }

  const sessionNamespace = resolveAliasGroup(
    normalized,
    ['sessionNamespace', 'session_namespace', 'namespace'],
    normalizeCasSegment,
  );
  if (!sessionNamespace.ok || !sessionNamespace.present) {
    fail('artifact_cas_session_namespace_invalid');
  }

  const artifactUri = resolveAliasGroup(
    normalized,
    ['artifactUri', 'artifact_uri'],
    (value) => normalizeCasUri(value, { expectedHash: contentHash }),
  );
  if (!artifactUri.ok || !artifactUri.present) {
    fail('artifact_cas_uri_invalid');
  } else {
    result.artifactUri = artifactUri.value;
  }

  const transport = safeRecord(normalized.transport) ?? {};
  if (normalized.transport !== undefined && normalized.transport !== null && Object.keys(transport).length === 0) {
    fail('artifact_cas_transport_unsafe');
  }
  const transportKind = resolveAliasGroup(transport, ['kind', 'transportKind', 'transport_kind'], normalizeTransportKind);
  if (!transportKind.ok || !transportKind.present) {
    fail('artifact_cas_transport_kind_invalid');
  } else {
    result.transportKind = transportKind.value;
  }

  const contentAddressed = resolveAliasGroup(
    transport,
    ['contentAddressed', 'content_addressed'],
    normalizeBoolean,
  );
  if (!contentAddressed.ok || contentAddressed.value !== true) fail('artifact_cas_transport_not_content_addressed');
  const bytesEmbedded = resolveAliasGroup(transport, ['bytesEmbedded', 'bytes_embedded'], normalizeBoolean);
  if (!bytesEmbedded.ok) fail('artifact_cas_transport_bytes_embedded_alias_conflict');
  if (bytesEmbedded.value === true) gaps.push('artifact_cas_manifest_embeds_bytes');
  if (transportKind.value === 'serialized_fallback') gaps.push('serialized_artifact_transport_fallback');

  const sharedStorageAlias = resolveAliasGroup(
    normalized,
    ['sharedStorage', 'shared_storage'],
    canonicalSharedStorage,
  );
  if (!sharedStorageAlias.ok) {
    fail('artifact_cas_shared_storage_alias_conflict');
  } else if (sharedStorageAlias.present) {
    const sharedStorage = firstPresent(normalized.sharedStorage, normalized.shared_storage);
    const shared = validateSharedArtifactAddressing(sharedStorage, {
      expectedContentHash: contentHash,
      expectedRelativePath: contentHash ? casRelativePathForHash(contentHash) : null,
      transportKind: transportKind.value,
    });
    result.sharedStorage = shared;
    result.shared_storage = shared;
    result.sharedMountCount = shared.mountCount;
    result.shared_mount_count = shared.mountCount;
    result.sharedMountRoles = shared.mountRoles;
    result.shared_mount_roles = shared.mountRoles;
    for (const reason of shared.reasons) fail(reason);
    gaps.push(...shared.gaps);
  }

  const acceptedForGpuHmr = resolveAliasGroup(
    normalized,
    ['acceptedForGpuHmr', 'accepted_for_gpu_hmr'],
    normalizeBoolean,
  );
  const gpuHmrSuccess = resolveAliasGroup(
    normalized,
    ['gpuHmrSuccess', 'gpu_hmr_success'],
    normalizeBoolean,
  );
  if (!acceptedForGpuHmr.ok || !gpuHmrSuccess.ok) {
    fail('artifact_cas_success_alias_conflict');
  }
  if (
    aliasGroupContains(normalized, ['acceptedForGpuHmr', 'accepted_for_gpu_hmr'], true)
    || aliasGroupContains(normalized, ['gpuHmrSuccess', 'gpu_hmr_success'], true)
  ) {
    fail('artifact_cas_manifest_claims_gpu_hmr_success');
  }

  const proofAuthority = resolveAliasGroup(
    normalized,
    ['proofAuthority', 'proof_authority', 'authority'],
    normalizeArtifactManifestAuthority,
  );
  if (!proofAuthority.ok) {
    fail('artifact_cas_proof_authority_alias_conflict');
  }

  result.manifestHash = artifactManifestHash(normalized);
  const manifestHash = resolveNullableAliasGroup(
    normalized,
    ['manifestHash', 'manifest_hash'],
    normalizeSha256Hash,
  );
  if (!manifestHash.ok) {
    fail('artifact_cas_manifest_hash_alias_conflict');
  } else if (manifestHash.present && manifestHash.value !== result.manifestHash) {
    fail('artifact_cas_manifest_hash_mismatch');
  }

  const storageAlias = resolveAliasGroup(normalized, ['storage', 'artifactStorage', 'artifact_storage'], canonicalStorage);
  if (!storageAlias.ok) fail('artifact_cas_storage_alias_conflict');
  let storage = EMPTY_STORAGE;
  if (storageAlias.ok && storageAlias.present) {
    try {
      storage = normalizeStorageDescriptor(
        firstPresent(normalized.storage, normalized.artifactStorage, normalized.artifact_storage),
      );
    } catch {
      fail('artifact_cas_storage_invalid');
    }
  }
  const localPath = storage.localPath;
  if (localPath) {
    const roots = normalizeAllowedRoots(options.allowedRoots, options.artifactRoot);
    if (roots.length === 0) {
      fail('artifact_cas_allowed_root_required_for_local_path');
    } else {
      const inside = await resolveInsideAnyRoot(localPath, roots);
      if (!inside.accepted) {
        fail('artifact_cas_local_path_outside_allowed_roots');
      } else {
        setSupportPath(result, inside.path);
        if (storage.relativePath) {
          try {
            const expected = contentHash ? casRelativePathForHash(contentHash) : null;
            const actual = normalizeRelativeCasPath(storage.relativePath);
            if (expected && actual !== expected) fail('artifact_cas_relative_path_hash_mismatch');
          } catch {
            fail('artifact_cas_relative_path_invalid');
          }
        }
        if (options.requireReadableBytes === true) {
          await validateReadableBytes(
            inside.requestedPath ?? inside.path,
            roots,
            result,
            fail,
            maxReadableByteLength,
          );
        }
      }
    }
  } else if (options.requireReadableBytes === true && contentHash) {
    const roots = normalizeAllowedRoots(options.allowedRoots, options.artifactRoot);
    if (roots.length === 0) {
      fail('artifact_cas_allowed_root_required_for_relative_path');
    } else {
      let relativePath;
      try {
        relativePath = normalizeRelativeCasPath(storage.relativePath ?? casRelativePathForHash(contentHash));
        const expected = casRelativePathForHash(contentHash);
        if (relativePath !== expected) fail('artifact_cas_relative_path_hash_mismatch');
      } catch {
        fail('artifact_cas_relative_path_invalid');
      }
      if (relativePath) {
        const resolved = await resolveRelativePathInsideAnyRoot(relativePath, roots);
        if (!resolved.accepted) {
          fail('artifact_cas_relative_path_unreadable');
        } else {
          setSupportPath(result, resolved.path);
          result.resolvedFromRelativePath = true;
          result.resolved_from_relative_path = true;
          await validateReadableBytes(
            resolved.requestedPath ?? resolved.path,
            roots,
            result,
            fail,
            maxReadableByteLength,
          );
        }
      }
    }
  } else if (options.requireReadableBytes === true) {
    fail('artifact_cas_readable_path_required');
  }

  if (reasons.length === 0) {
    result.accepted = true;
    result.acceptedAsTransportEvidence = true;
  }
  return finalizeValidationSnapshot(result);
}

export const validateArtifactLocator = validateArtifactCasManifest;

export function artifactCasManifestEvidence(_manifest, validation) {
  const trustedSnapshot = Boolean(
    validation
    && typeof validation === 'object'
    && IMMUTABLE_VALIDATION_SNAPSHOTS.has(validation),
  );
  const snapshot = immutableValidationSnapshot(validation);
  const accepted = trustedSnapshot && snapshot.accepted === true;
  const reasons = [
    ...(Array.isArray(snapshot.reasons) ? snapshot.reasons : []),
    ...(trustedSnapshot ? [] : ['artifact_cas_validation_snapshot_untrusted']),
  ];
  return freezeSnapshot({
    schemaVersion: GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
    accepted,
    acceptedAsTransportEvidence: snapshot.acceptedAsTransportEvidence === true && accepted,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: snapshot.proofAuthority ?? null,
    contentHash: snapshot.contentHash ?? null,
    artifactId: snapshot.artifactId ?? null,
    artifactUri: snapshot.artifactUri ?? null,
    transportKind: snapshot.transportKind ?? null,
    byteLength: snapshot.byteLength ?? null,
    mediaType: snapshot.mediaType ?? null,
    manifestHash: snapshot.manifestHash ?? null,
    localPath: null,
    local_path: null,
    supportPath: snapshot.supportPath ?? null,
    support_path: snapshot.support_path ?? snapshot.supportPath ?? null,
    pathReusableAsProof: false,
    path_reusable_as_proof: false,
    pathProofAuthority: snapshot.pathProofAuthority ?? null,
    path_proof_authority: snapshot.path_proof_authority ?? snapshot.pathProofAuthority ?? null,
    verifiedByteHash: snapshot.verifiedByteHash ?? null,
    verified_byte_hash: snapshot.verified_byte_hash ?? snapshot.verifiedByteHash ?? null,
    verifiedByteLength: snapshot.verifiedByteLength ?? null,
    verified_byte_length: snapshot.verified_byte_length ?? snapshot.verifiedByteLength ?? null,
    verifiedSnapshotIdentity: snapshot.verifiedSnapshotIdentity ?? null,
    verified_snapshot_identity:
      snapshot.verified_snapshot_identity ?? snapshot.verifiedSnapshotIdentity ?? null,
    snapshotProofAuthority: snapshot.snapshotProofAuthority ?? null,
    snapshot_proof_authority:
      snapshot.snapshot_proof_authority ?? snapshot.snapshotProofAuthority ?? null,
    readableContentHash: snapshot.readableContentHash ?? null,
    readable_content_hash: snapshot.readableContentHash ?? null,
    readableByteLength: snapshot.readableByteLength ?? null,
    readable_byte_length: snapshot.readableByteLength ?? null,
    readableFileIdentity: snapshot.readableFileIdentity ?? null,
    readable_file_identity: snapshot.readable_file_identity ?? snapshot.readableFileIdentity ?? null,
    readableFileIdentityProven: snapshot.readableFileIdentityProven === true,
    readable_file_identity_proven: snapshot.readableFileIdentityProven === true,
    readablePathSafetyProven: snapshot.readablePathSafetyProven === true,
    readable_path_safety_proven: snapshot.readablePathSafetyProven === true,
    readableReparsePointCheck: snapshot.readableReparsePointCheck ?? null,
    readable_reparse_point_check: snapshot.readableReparsePointCheck ?? null,
    sharedStorageAccepted: snapshot.sharedStorage?.accepted ?? snapshot.shared_storage?.accepted ?? null,
    shared_storage_accepted: snapshot.sharedStorage?.accepted ?? snapshot.shared_storage?.accepted ?? null,
    sharedMountCount: snapshot.sharedMountCount ?? snapshot.shared_mount_count ?? 0,
    shared_mount_count: snapshot.sharedMountCount ?? snapshot.shared_mount_count ?? 0,
    sharedMountRoles: snapshot.sharedMountRoles ?? snapshot.shared_mount_roles ?? [],
    shared_mount_roles: snapshot.sharedMountRoles ?? snapshot.shared_mount_roles ?? [],
    reasons: [...new Set(reasons)],
    gaps: Array.isArray(snapshot.gaps) ? snapshot.gaps : [],
  });
}

export function collectArtifactLocators(value) {
  const locators = [];
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!isObject(entry)) return;
    const maybeSchema = entry.schemaVersion ?? entry.schema_version;
    if (
      maybeSchema === CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
      || entry.artifactId
      || entry.selectedArtifactId
      || entry.contentHash
      || entry.artifactHash
      || entry.artifactContentHash
      || entry.ramBytesHash
    ) {
      locators.push(entry);
    }
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return locators;
}

export function buildSharedArtifactAddressing(input = {}) {
  const mounts = normalizeSharedCasMounts(input.mounts);
  if (mounts.length === 0) return null;
  const contentHash = normalizeSha256Hash(input.contentHash);
  const relativePath = normalizeRelativeCasPath(input.relativePath ?? casRelativePathForHash(contentHash));
  return {
    schemaVersion: GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION,
    addressing: 'content_addressed_relative_path',
    contentHash,
    relativePath,
    mountCount: mounts.length,
    mountRoles: mounts.map((mount) => mount.role).sort(),
    mounts: mounts.map((mount) => ({
      role: mount.role,
      root: mount.root,
      path: joinMountPath(mount.root, relativePath),
      addressKind: mount.addressKind,
      readableBytesProven: false,
    })),
    manifestOnly: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'shared_artifact_addressing_only',
  };
}

export function validateSharedArtifactAddressing(sharedStorage, options = {}) {
  const reasons = [];
  const gaps = [];
  const safeShared = clonePortableData(sharedStorage);
  let shared = null;
  if (safeShared.ok && isObject(safeShared.value)) {
    try {
      shared = normalizeSharedStorageDescriptor(safeShared.value);
    } catch {
      reasons.push('shared_artifact_addressing_alias_invalid');
    }
  } else {
    reasons.push('shared_artifact_addressing_unsafe');
  }
  shared ??= {
    schemaVersion: null,
    addressing: null,
    contentHash: null,
    relativePath: null,
    mountCount: null,
    mountRoles: null,
    mounts: [],
    manifestOnly: null,
    acceptedForGpuHmr: null,
    gpuHmrSuccess: null,
    proofAuthority: null,
  };
  const result = {
    schemaVersion: GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION,
    accepted: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'shared_artifact_addressing_only',
    contentHash: null,
    relativePath: null,
    mountCount: 0,
    mountRoles: [],
    reasons,
    gaps,
  };

  if (shared.schemaVersion !== GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION) {
    reasons.push('shared_artifact_addressing_schema_invalid');
  }
  if (shared.addressing !== 'content_addressed_relative_path') {
    reasons.push('shared_artifact_addressing_kind_invalid');
  }
  if (shared.acceptedForGpuHmr === true || shared.gpuHmrSuccess === true) {
    reasons.push('shared_artifact_addressing_claims_gpu_hmr_success');
  }
  if (!['cas_shared_volume', 'cas_tmpfs'].includes(options.transportKind)) {
    reasons.push('shared_artifact_addressing_requires_cas_transport');
  }
  if (shared.manifestOnly !== true) {
    reasons.push('shared_artifact_addressing_manifest_only_required');
  }

  if (!shared.contentHash) {
    reasons.push('shared_artifact_addressing_content_hash_invalid');
  } else {
    result.contentHash = shared.contentHash;
    if (options.expectedContentHash && result.contentHash !== normalizeSha256Hash(options.expectedContentHash)) {
      reasons.push('shared_artifact_addressing_content_hash_mismatch');
    }
  }

  if (!shared.relativePath) {
    reasons.push('shared_artifact_addressing_relative_path_invalid');
  } else {
    result.relativePath = shared.relativePath;
    if (options.expectedRelativePath && result.relativePath !== normalizeRelativeCasPath(options.expectedRelativePath)) {
      reasons.push('shared_artifact_addressing_relative_path_mismatch');
    }
  }

  const seenRoles = new Set();
  const normalizedMounts = [];
  for (const mount of shared.mounts) {
    if (seenRoles.has(mount.role)) {
      reasons.push('shared_artifact_addressing_mount_role_duplicate');
      continue;
    }
    seenRoles.add(mount.role);
    const expectedPath = result.relativePath ? joinMountPath(mount.root, result.relativePath) : null;
    if (
      expectedPath
      && (
        !mount.path
        || normalizePortablePath(mount.path) !== normalizePortablePath(expectedPath)
      )
    ) {
      reasons.push('shared_artifact_addressing_mount_path_mismatch');
    }
    normalizedMounts.push(mount);
  }
  if (normalizedMounts.length === 0) {
    reasons.push('shared_artifact_addressing_mounts_missing');
  }
  result.mountCount = normalizedMounts.length;
  result.mountRoles = normalizedMounts.map((mount) => mount.role).sort();
  if (shared.mountCount !== null && shared.mountCount !== result.mountCount) {
    reasons.push('shared_artifact_addressing_mount_count_mismatch');
  }
  if (shared.mountRoles !== null && stableJson(shared.mountRoles) !== stableJson(result.mountRoles)) {
    reasons.push('shared_artifact_addressing_mount_roles_mismatch');
  }
  if (!normalizedMounts.some((mount) => mount.role === 'worker')) {
    gaps.push('shared_artifact_worker_mount_not_declared');
  }
  if (!normalizedMounts.some((mount) => mount.role === 'mcp')) {
    gaps.push('shared_artifact_mcp_mount_not_declared');
  }
  if (normalizedMounts.length < 2) {
    gaps.push('shared_artifact_single_mount_only');
  }

  if (reasons.length === 0) {
    result.accepted = true;
  }
  return result;
}

function normalizeSharedCasMounts(value) {
  if (value === undefined || value === null) return [];
  const source = isObject(value) && Array.isArray(value.mounts)
    ? value.mounts
    : Array.isArray(value)
      ? value
      : isObject(value) && (value.role || value.root)
        ? [value]
        : isObject(value)
          ? Object.entries(value).map(([role, root]) => ({ role, root }))
          : [];
  return source
    .map((mount) => normalizeSharedCasMount(mount))
    .filter((mount) => mount !== null);
}

function normalizeSharedCasMount(mount) {
  try {
    const normalized = normalizeSharedMountDescriptor(mount);
    return {
      role: normalized.role,
      root: normalized.root,
      addressKind: normalized.addressKind,
    };
  } catch {
    return null;
  }
}

function normalizePortableRoot(value) {
  const normalized = text(value);
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    throw new Error('shared_artifact_root_invalid');
  }
  return normalizePortablePath(normalized).replace(/\/+$/g, '') || '/';
}

function joinMountPath(root, relativePath) {
  const normalizedRoot = normalizePortableRoot(root);
  const normalizedRelative = normalizeRelativeCasPath(relativePath);
  return `${normalizedRoot}/${normalizedRelative}`;
}

function normalizePortablePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizePortableDeclaredPath(value) {
  const normalized = text(value);
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    throw new Error('shared_artifact_path_invalid');
  }
  return normalizePortablePath(normalized);
}

function sha256Digest(bytes) {
  return createHash('sha256').update(toBuffer(bytes)).digest('hex');
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  throw new Error('artifact_bytes_must_be_buffer_or_string');
}

async function resolveInputBytes(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'bytes')) {
    return toBuffer(input.bytes);
  }
  const localPath = text(input.localPath ?? input.path);
  if (!localPath) {
    throw new Error('artifact_bytes_or_path_required');
  }
  return readFile(localPath);
}

function normalizeMediaType(value) {
  const normalized = text(value);
  if (!normalized || normalized.length > 160 || /[\r\n]/.test(normalized)) {
    throw new Error('media_type_invalid');
  }
  return normalized.toLowerCase();
}

function normalizeProducer(value) {
  if (typeof value === 'string') return { name: normalizeCasSegment(value) };
  const object = isObject(value) ? value : {};
  return {
    name: normalizeCasSegment(object.name ?? 'unspecified_producer'),
    kind: object.kind ? normalizeCasSegment(object.kind) : 'generic',
  };
}

function normalizeTransportKind(value) {
  const normalized = text(value);
  if (!SUPPORTED_GPU_HMR_ARTIFACT_TRANSPORTS.includes(normalized)) {
    throw new Error('artifact_transport_kind_unsupported');
  }
  return normalized;
}

function normalizeCasSegment(value) {
  const normalized = text(value);
  if (!normalized || !SAFE_SEGMENT_RE.test(normalized)) {
    throw new Error('cas_segment_invalid');
  }
  return normalized;
}

function normalizeUriScheme(value) {
  const normalized = text(value)?.toLowerCase();
  if (!normalized || !SAFE_URI_SCHEME_RE.test(normalized)) {
    throw new Error('artifact_uri_scheme_invalid');
  }
  return normalized;
}

function normalizeCasUri(value, options = {}) {
  const uri = text(value);
  if (!uri) throw new Error('artifact_uri_missing');
  const parsed = new URL(uri);
  const parsedScheme = normalizeUriScheme(parsed.protocol.slice(0, -1));
  if (parsedScheme !== DEFAULT_GPU_HMR_CAS_URI_SCHEME) {
    throw new Error('artifact_uri_scheme_unsupported');
  }
  const namespace = normalizeCasSegment(parsed.hostname);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'sha256' || !SHA256_DIGEST_RE.test(parts[1])) {
    throw new Error('artifact_uri_path_invalid');
  }
  if (options.expectedHash) {
    const expectedDigest = digestFromHash(options.expectedHash);
    if (parts[1] !== expectedDigest) {
      throw new Error('artifact_uri_hash_mismatch');
    }
  }
  return `${DEFAULT_GPU_HMR_CAS_URI_SCHEME}://${namespace}/sha256/${parts[1]}`;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const EMPTY_STORAGE = Object.freeze({ localPath: null, relativePath: null });

function resolveAliasGroup(object, aliases, normalize) {
  let present = false;
  let value;
  try {
    for (const alias of aliases) {
      if (!Object.hasOwn(object, alias)) continue;
      const candidate = object[alias];
      if (candidate === undefined || candidate === null) continue;
      const normalized = normalize(candidate);
      if (!present) {
        present = true;
        value = normalized;
      } else if (normalized !== value) {
        return { ok: false, present: true, value: null };
      }
    }
  } catch {
    return { ok: false, present, value: null };
  }
  return { ok: true, present, value: present ? value : null };
}

function resolveNullableAliasGroup(object, aliases, normalize) {
  let supplied = false;
  let value;
  try {
    for (const alias of aliases) {
      if (!Object.hasOwn(object, alias) || object[alias] === undefined) continue;
      const normalized = object[alias] === null ? null : normalize(object[alias]);
      if (!supplied) {
        supplied = true;
        value = normalized;
      } else if (normalized !== value) {
        return { ok: false, present: true, value: null };
      }
    }
  } catch {
    return { ok: false, present: supplied, value: null };
  }
  return { ok: true, present: supplied && value !== null, value: value ?? null };
}

function aliasGroupContains(object, aliases, expected) {
  return aliases.some((alias) => Object.hasOwn(object, alias) && object[alias] === expected);
}

function clonePortableData(value, limits = ARTIFACT_CAS_LOCATOR_LIMITS) {
  let clonedRoot;
  let nodes = 0;
  let totalBytes = 0;
  const seen = new WeakSet();
  const tasks = [{ source: value, depth: 0, assign: (cloned) => { clonedRoot = cloned; } }];

  const consumeString = (entry) => {
    const bytes = Buffer.byteLength(entry, 'utf8');
    if (bytes > limits.maxStringBytes) throw new Error('portable_data_string_limit');
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw new Error('portable_data_total_bytes_limit');
  };

  try {
    while (tasks.length > 0) {
      const task = tasks.pop();
      nodes += 1;
      if (nodes > limits.maxNodes || task.depth > limits.maxDepth) {
        return { ok: false, value: null };
      }

      const source = task.source;
      if (source === null || typeof source === 'boolean') {
        task.assign(source);
        continue;
      }
      if (source === undefined) return { ok: false, value: null };
      if (typeof source === 'string') {
        consumeString(source);
        task.assign(source);
        continue;
      }
      if (typeof source === 'number') {
        if (!Number.isFinite(source) || Object.is(source, -0)) return { ok: false, value: null };
        task.assign(source);
        continue;
      }
      if (typeof source !== 'object' || utilTypes.isProxy(source) || seen.has(source)) {
        return { ok: false, value: null };
      }
      seen.add(source);
      if (Object.getOwnPropertySymbols(source).length !== 0) return { ok: false, value: null };

      if (Array.isArray(source)) {
        if (Object.getPrototypeOf(source) !== Array.prototype) return { ok: false, value: null };
        const lengthDescriptor = Object.getOwnPropertyDescriptor(source, 'length');
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxArrayLength) {
          return { ok: false, value: null };
        }
        const keys = Object.keys(source);
        if (keys.length !== length) return { ok: false, value: null };
        const ownNames = Object.getOwnPropertyNames(source);
        if (ownNames.length !== length + 1 || !ownNames.includes('length')) {
          return { ok: false, value: null };
        }
        const cloned = new Array(length);
        task.assign(cloned);
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            return { ok: false, value: null };
          }
          tasks.push({
            source: descriptor.value,
            depth: task.depth + 1,
            assign: (entry) => { cloned[index] = entry; },
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(source);
      if (prototype !== Object.prototype && prototype !== null) return { ok: false, value: null };
      const keys = Object.keys(source);
      if (keys.length > limits.maxObjectKeys) return { ok: false, value: null };
      const ownNames = Object.getOwnPropertyNames(source);
      if (ownNames.length !== keys.length) return { ok: false, value: null };
      const cloned = Object.create(null);
      task.assign(cloned);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          return { ok: false, value: null };
        }
        consumeString(key);
        tasks.push({
          source: descriptor.value,
          depth: task.depth + 1,
          assign: (entry) => { cloned[key] = entry; },
        });
      }
    }
    return { ok: true, value: clonedRoot };
  } catch {
    return { ok: false, value: null };
  }
}

function safeRecord(value) {
  const cloned = clonePortableData(value);
  return cloned.ok && isObject(cloned.value) ? cloned.value : null;
}

function normalizeByteLength(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('byte_length_invalid');
  }
  return value;
}

function normalizeBoolean(value) {
  if (typeof value !== 'boolean') throw new Error('boolean_invalid');
  return value;
}

function normalizeExactAuthority(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error('proof_authority_invalid');
  }
  return value;
}

function normalizeArtifactManifestAuthority(value) {
  return normalizeExactAuthority(value, ARTIFACT_MANIFEST_PROOF_AUTHORITIES);
}

function normalizeSharedStorageAuthority(value) {
  return normalizeExactAuthority(value, SHARED_STORAGE_PROOF_AUTHORITIES);
}

function normalizeLocalPath(value) {
  const normalized = text(value);
  if (!normalized || /[\0\r\n]/.test(normalized)) throw new Error('local_path_invalid');
  return path.resolve(normalized);
}

function canonicalStorage(value) {
  return stableJson(normalizeStorageDescriptor(value));
}

function artifactManifestHash(value) {
  const cloned = clonePortableData(value);
  if (!cloned.ok || !isObject(cloned.value)) throw new Error('artifact_manifest_hash_input_invalid');
  delete cloned.value.manifestHash;
  delete cloned.value.manifest_hash;
  // V1 hashes always reserve this canonical field, regardless of accepted alias spelling.
  cloned.value.manifestHash = undefined;
  return sha256Text(stableJson(cloned.value));
}

function normalizeStorageDescriptor(value) {
  const storage = safeRecord(value);
  if (!storage) throw new Error('storage_invalid');
  const localPath = resolveAliasGroup(storage, ['localPath', 'local_path', 'path'], normalizeLocalPath);
  const relativePath = resolveAliasGroup(
    storage,
    ['relativePath', 'relative_path', 'contentAddress', 'content_address'],
    normalizeRelativeCasPath,
  );
  const kind = resolveAliasGroup(storage, ['kind', 'transportKind', 'transport_kind'], normalizeTransportKind);
  if (!localPath.ok || !relativePath.ok || !kind.ok) throw new Error('storage_alias_conflict');
  return {
    kind: kind.value,
    localPath: localPath.value,
    relativePath: relativePath.value,
  };
}

function canonicalSharedStorage(value) {
  return stableJson(normalizeSharedStorageDescriptor(value));
}

function normalizeSharedStorageDescriptor(value) {
  const shared = safeRecord(value);
  if (!shared) throw new Error('shared_storage_invalid');
  const schemaVersion = resolveAliasGroup(shared, ['schemaVersion', 'schema_version'], normalizeExactString);
  const addressing = resolveAliasGroup(
    shared,
    ['addressing', 'addressKind', 'address_kind'],
    normalizeCasSegment,
  );
  const contentHash = resolveAliasGroup(
    shared,
    ['contentHash', 'content_hash', 'artifactHash', 'artifact_hash', 'hash'],
    normalizeSha256Hash,
  );
  const relativePath = resolveAliasGroup(
    shared,
    ['relativePath', 'relative_path', 'contentAddress', 'content_address'],
    normalizeRelativeCasPath,
  );
  const mountCount = resolveAliasGroup(shared, ['mountCount', 'mount_count'], normalizeByteLength);
  const mountRoles = resolveStructuredAliasGroup(
    shared,
    ['mountRoles', 'mount_roles'],
    normalizeSharedMountRoles,
  );
  const mounts = resolveStructuredAliasGroup(
    shared,
    ['mounts', 'sharedMounts', 'shared_mounts'],
    normalizeSharedMountList,
  );
  const manifestOnly = resolveAliasGroup(shared, ['manifestOnly', 'manifest_only'], normalizeBoolean);
  const acceptedForGpuHmr = resolveAliasGroup(
    shared,
    ['acceptedForGpuHmr', 'accepted_for_gpu_hmr'],
    normalizeBoolean,
  );
  const gpuHmrSuccess = resolveAliasGroup(shared, ['gpuHmrSuccess', 'gpu_hmr_success'], normalizeBoolean);
  const proofAuthority = resolveAliasGroup(
    shared,
    ['proofAuthority', 'proof_authority', 'authority'],
    normalizeSharedStorageAuthority,
  );
  if (
    !schemaVersion.ok || !addressing.ok || !contentHash.ok || !relativePath.ok
    || !mountCount.ok || !mountRoles.ok || !mounts.ok || !manifestOnly.ok
    || !acceptedForGpuHmr.ok || !gpuHmrSuccess.ok || !proofAuthority.ok
  ) {
    throw new Error('shared_storage_alias_conflict');
  }
  return {
    schemaVersion: schemaVersion.value,
    addressing: addressing.value,
    contentHash: contentHash.value,
    relativePath: relativePath.value,
    mountCount: mountCount.value,
    mountRoles: mountRoles.value,
    mounts: mounts.value ?? [],
    manifestOnly: manifestOnly.value,
    acceptedForGpuHmr: acceptedForGpuHmr.value,
    gpuHmrSuccess: gpuHmrSuccess.value,
    proofAuthority: proofAuthority.value,
  };
}

function normalizeSharedMountDescriptor(value) {
  const mount = safeRecord(value);
  if (!mount) throw new Error('shared_mount_invalid');
  const role = resolveAliasGroup(mount, ['role', 'name'], normalizeCasSegment);
  const root = resolveAliasGroup(mount, ['root', 'mountRoot', 'mount_root'], normalizePortableRoot);
  const declaredPath = resolveAliasGroup(
    mount,
    ['path', 'localPath', 'local_path', 'contentAddress', 'content_address'],
    normalizePortableDeclaredPath,
  );
  const addressKind = resolveAliasGroup(
    mount,
    ['addressKind', 'address_kind'],
    normalizeCasSegment,
  );
  const readableBytesProven = resolveAliasGroup(
    mount,
    ['readableBytesProven', 'readable_bytes_proven'],
    normalizeBoolean,
  );
  if (
    !role.ok || !role.present || !root.ok || !root.present
    || !declaredPath.ok || !addressKind.ok || !readableBytesProven.ok
  ) {
    throw new Error('shared_mount_alias_conflict');
  }
  return {
    role: role.value,
    root: root.value,
    path: declaredPath.value,
    addressKind: addressKind.present ? addressKind.value : 'shared_bind_mount',
    readableBytesProven: readableBytesProven.present ? readableBytesProven.value : false,
  };
}

function normalizeSharedMountList(value) {
  if (!Array.isArray(value)) throw new Error('shared_mounts_invalid');
  return value
    .map((mount) => normalizeSharedMountDescriptor(mount))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizeSharedMountRoles(value) {
  if (!Array.isArray(value)) throw new Error('shared_mount_roles_invalid');
  return value.map(normalizeCasSegment).sort();
}

function resolveStructuredAliasGroup(object, aliases, normalize) {
  const canonical = resolveAliasGroup(object, aliases, (value) => stableJson(normalize(value)));
  if (!canonical.ok || !canonical.present) return canonical;
  return {
    ok: true,
    present: true,
    value: normalize(firstPresent(...aliases.map((alias) => object[alias]))),
  };
}

function normalizeExactString(value) {
  if (typeof value !== 'string') throw new Error('string_invalid');
  return value;
}

function sharedCasMountsOption(options = {}) {
  const explicit = firstPresent(
    options.sharedCasMounts,
    options.shared_cas_mounts,
    options.sharedMounts,
    options.shared_mounts,
  );
  return explicit === undefined ? defaultSharedCasMountsFromEnv() : explicit;
}

function normalizeRelativeCasPath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (
    parts.length !== 3
    || parts[0] !== 'sha256'
    || parts[1].length !== 2
    || !SHA256_DIGEST_RE.test(parts[2])
    || parts[1] !== parts[2].slice(0, 2)
  ) {
    throw new Error('relative_cas_path_invalid');
  }
  return path.posix.join(...parts);
}

function normalizeAllowedRoots(roots, artifactRoot) {
  const values = [];
  if (Array.isArray(roots)) values.push(...roots);
  if (artifactRoot) values.push(artifactRoot);
  return [...new Set(values.map(text).filter(Boolean).map((root) => path.resolve(root)))];
}

async function resolveInsideAnyRoot(candidate, roots) {
  const resolved = path.resolve(candidate);
  const lexical = resolveInsideAnyRootLexical(resolved, roots);
  if (!lexical.accepted) return lexical;
  let candidateRealPath;
  try {
    candidateRealPath = await realpath(lexical.path);
  } catch {
    return { accepted: false, path: lexical.path, requestedPath: lexical.path, root: lexical.root };
  }
  for (const root of roots) {
    try {
      const rootRealPath = await realpath(path.resolve(root));
      if (sameOrInside(candidateRealPath, rootRealPath)) {
        return {
          accepted: true,
          path: candidateRealPath,
          requestedPath: lexical.path,
          root: rootRealPath,
        };
      }
    } catch {
      // Keep checking remaining allowed roots.
    }
  }
  return { accepted: false, path: candidateRealPath, requestedPath: lexical.path, root: null };
}

async function resolveRelativePathInsideAnyRoot(relativePath, roots) {
  const normalized = normalizeRelativeCasPath(relativePath);
  for (const root of roots) {
    const candidate = path.join(path.resolve(root), ...normalized.split('/'));
    const inside = await resolveInsideAnyRoot(candidate, [root]);
    if (inside.accepted) return inside;
  }
  return { accepted: false, path: null, root: null };
}

function resolveInsideAnyRootLexical(candidate, roots) {
  const resolved = path.resolve(candidate);
  for (const root of roots) {
    try {
      const inside = assertPathInsideRoot(root, resolved);
      return { accepted: true, path: inside, root: path.resolve(root) };
    } catch {
      // Keep checking remaining allowed roots.
    }
  }
  return { accepted: false, path: resolved, root: null };
}

function assertPathInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rootCmp = caseNormalizedPath(resolvedRoot);
  const candidateCmp = caseNormalizedPath(resolvedCandidate);
  const relative = path.relative(rootCmp, candidateCmp);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw new Error('path_outside_root');
}

async function validateReadableBytes(
  localPath,
  roots,
  result,
  fail,
  maxReadableByteLength,
) {
  if (
    !Number.isSafeInteger(maxReadableByteLength)
    || maxReadableByteLength < 1
    || maxReadableByteLength > GPU_HMR_ARTIFACT_CAS_MAX_VALIDATED_BYTES
  ) {
    fail('artifact_cas_readable_byte_limit_invalid');
    return;
  }
  if (
    Number.isSafeInteger(result.byteLength)
    && result.byteLength > maxReadableByteLength
  ) {
    fail('artifact_cas_readable_byte_length_exceeds_limit');
    return;
  }
  const windowsReparseDetectionPartial = process.platform === 'win32';
  if (windowsReparseDetectionPartial) {
    await validateWindowsReadableBytes(
      localPath,
      roots,
      result,
      fail,
      maxReadableByteLength,
    );
    return;
  }
  const noFollowSupported = !windowsReparseDetectionPartial
    && Number.isInteger(fsConstants.O_NOFOLLOW)
    && fsConstants.O_NOFOLLOW > 0;
  result.readableNoFollowSupported = noFollowSupported;
  result.readable_no_follow_supported = noFollowSupported;
  result.readableReparsePointCheck = windowsReparseDetectionPartial
    ? 'windows_lstat_reparse_detection_partial_fail_closed'
    : noFollowSupported
      ? 'kernel_no_follow_and_lstat'
      : 'lstat_only_no_follow_unsupported';
  result.readable_reparse_point_check = result.readableReparsePointCheck;
  result.readablePathSafetyProven = false;
  result.readable_path_safety_proven = false;
  let handle = null;
  try {
    const pathBefore = await resolveInsideAnyRoot(localPath, roots);
    if (!pathBefore.accepted) {
      fail('artifact_cas_local_path_outside_allowed_roots');
      return;
    }
    const linkBefore = await lstat(localPath, { bigint: true });
    if (linkBefore.isSymbolicLink()) {
      fail('artifact_cas_local_path_reparse_point');
      return;
    }
    if (!linkBefore.isFile()) {
      fail('artifact_cas_local_path_not_file');
      return;
    }

    const openFlags = noFollowSupported
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      : fsConstants.O_RDONLY;
    handle = await open(localPath, openFlags);
    const handleBefore = await handle.stat({ bigint: true });
    const pathStatBefore = await stat(localPath, { bigint: true });
    if (!handleBefore.isFile()) {
      fail('artifact_cas_local_path_not_file');
      return;
    }
    if (handleBefore.size > BigInt(maxReadableByteLength)) {
      fail('artifact_cas_readable_byte_length_exceeds_limit');
      return;
    }
    if (
      Number.isSafeInteger(result.byteLength)
      && handleBefore.size !== BigInt(result.byteLength)
    ) {
      fail('artifact_cas_readable_byte_length_mismatch');
      return;
    }
    if (handleBefore.nlink !== 1n || pathStatBefore.nlink !== 1n) {
      fail('artifact_cas_hardlink_count_invalid');
      return;
    }
    if (!windowsReparseDetectionPartial && !sameFileIdentity(handleBefore, pathStatBefore)) {
      fail('artifact_cas_local_path_identity_changed');
      return;
    }

    const streamed = await hashOpenFileHandle(handle, maxReadableByteLength);
    if (streamed.exceeded) {
      fail('artifact_cas_readable_byte_length_exceeds_limit');
      return;
    }
    const fileHash = streamed.contentHash;
    result.readableByteLength = streamed.byteLength;
    result.readableContentHash = fileHash;
    result.verifiedByteLength = streamed.byteLength;
    result.verified_byte_length = streamed.byteLength;
    result.verifiedByteHash = fileHash;
    result.verified_byte_hash = fileHash;

    const handleAfter = await handle.stat({ bigint: true });
    const linkAfter = await lstat(localPath, { bigint: true });
    const pathStatAfter = await stat(localPath, { bigint: true });
    const pathAfter = await resolveInsideAnyRoot(localPath, roots);
    if (linkAfter.isSymbolicLink()) {
      fail('artifact_cas_local_path_reparse_point');
      return;
    }
    if (
      !pathAfter.accepted
      || caseNormalizedPath(pathBefore.path) !== caseNormalizedPath(pathAfter.path)
      || handleAfter.nlink !== 1n
      || pathStatAfter.nlink !== 1n
      || (!windowsReparseDetectionPartial && !sameFileIdentity(handleBefore, handleAfter))
      || (!windowsReparseDetectionPartial && !sameFileIdentity(handleBefore, pathStatAfter))
      || (!windowsReparseDetectionPartial && !sameFileSnapshot(handleBefore, handleAfter))
      || (windowsReparseDetectionPartial && !sameSnapshotMetadata(handleBefore, handleAfter))
    ) {
      fail('artifact_cas_local_path_identity_changed');
      return;
    }
    result.readableFileIdentity = windowsReparseDetectionPartial ? null : fileIdentity(handleBefore);
    result.readable_file_identity = result.readableFileIdentity;
    result.readableFileIdentityProven = result.readableFileIdentity !== null;
    result.readable_file_identity_proven = result.readableFileIdentityProven;
    if (!windowsReparseDetectionPartial && !result.readableFileIdentityProven) {
      fail('artifact_cas_file_identity_unsupported');
      return;
    }
    result.verifiedSnapshotIdentity = windowsReparseDetectionPartial ? null : fileSnapshotIdentity(handleBefore);
    result.verified_snapshot_identity = result.verifiedSnapshotIdentity;
    result.readablePathSafetyProven = noFollowSupported && !windowsReparseDetectionPartial;
    result.readable_path_safety_proven = result.readablePathSafetyProven;
    if (result.contentHash && fileHash !== result.contentHash) {
      fail('artifact_cas_readable_hash_mismatch');
    }
    if (Number.isSafeInteger(result.byteLength) && streamed.byteLength !== result.byteLength) {
      fail('artifact_cas_readable_byte_length_mismatch');
    }
    if (windowsReparseDetectionPartial) {
      fail('artifact_cas_windows_readable_bytes_native_handle_chain_attestation_required');
      fail('artifact_cas_windows_reparse_detection_partial');
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail('artifact_cas_local_path_reparse_point');
    } else {
      fail('artifact_cas_local_path_unreadable');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validateWindowsReadableBytes(
  localPath,
  roots,
  result,
  fail,
  maxReadableByteLength,
) {
  result.readableNoFollowSupported = true;
  result.readable_no_follow_supported = true;
  result.readableReparsePointCheck = 'native_handle_relative_no_reparse_chain';
  result.readable_reparse_point_check = result.readableReparsePointCheck;
  result.readablePathSafetyProven = false;
  result.readable_path_safety_proven = false;
  const lexical = resolveInsideAnyRootLexical(localPath, roots);
  if (!lexical.accepted || lexical.root === null) {
    fail('artifact_cas_local_path_outside_allowed_roots');
    return;
  }
  const relativePath = path.relative(lexical.root, lexical.path).replaceAll('\\', '/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    fail('artifact_cas_windows_snapshot_relative_path_invalid');
    return;
  }
  let snapshot;
  try {
    snapshot = await verifyWindowsArtifactCasSnapshot({
      allowedRoot: lexical.root,
      relativePath,
      expectedSha256: result.contentHash ?? undefined,
      expectedByteLength: Number.isSafeInteger(result.byteLength)
        ? result.byteLength
        : undefined,
      maxByteLength: Number.isSafeInteger(result.byteLength)
        ? Math.min(maxReadableByteLength, Math.max(1, result.byteLength))
        : maxReadableByteLength,
    });
  } catch {
    fail('artifact_cas_windows_native_snapshot_bridge_failed');
    return;
  }
  if (snapshot.acceptedAsSnapshotEvidence !== true) {
    result.gaps.push(...snapshot.gaps);
    if (snapshot.gaps.includes(
      'native_windows_artifact_cas_snapshot:final_byte_length_exceeds_maximum',
    )) {
      fail('artifact_cas_readable_byte_length_exceeds_limit');
    } else if (snapshot.gaps.includes(
      'native_windows_artifact_cas_snapshot:expected_sha256_mismatch',
    )) {
      fail('artifact_cas_readable_hash_mismatch');
    } else if (snapshot.gaps.includes(
      'native_windows_artifact_cas_snapshot:expected_byte_length_mismatch',
    )) {
      fail('artifact_cas_readable_byte_length_mismatch');
    } else {
      fail('artifact_cas_windows_native_snapshot_rejected');
    }
    return;
  }
  result.readableByteLength = snapshot.byteLength;
  result.readableContentHash = snapshot.sha256;
  result.verifiedByteLength = snapshot.byteLength;
  result.verified_byte_length = snapshot.byteLength;
  result.verifiedByteHash = snapshot.sha256;
  result.verified_byte_hash = snapshot.sha256;
  result.readableFileIdentity = [
    snapshot.snapshotIdentity.final.volumeSerialNumber,
    snapshot.snapshotIdentity.final.fileId128,
  ].join(':');
  result.readable_file_identity = result.readableFileIdentity;
  result.readableFileIdentityProven = true;
  result.readable_file_identity_proven = true;
  result.verifiedSnapshotIdentity = snapshot.snapshotIdentity;
  result.verified_snapshot_identity = snapshot.snapshotIdentity;
  result.snapshotProofAuthority = snapshot.authority;
  result.snapshot_proof_authority = snapshot.authority;
  result.readablePathSafetyProven = true;
  result.readable_path_safety_proven = true;
}

async function hashOpenFileHandle(handle, maxReadableByteLength) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteLength = 0;
  while (true) {
    const remaining = maxReadableByteLength - byteLength;
    const requested = Math.min(buffer.byteLength, remaining + 1);
    const { bytesRead } = await handle.read(buffer, 0, requested, null);
    if (bytesRead === 0) break;
    byteLength += bytesRead;
    if (byteLength > maxReadableByteLength) {
      return { exceeded: true, byteLength, contentHash: null };
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  return {
    exceeded: false,
    byteLength,
    contentHash: `sha256:${hash.digest('hex')}`,
  };
}

function fileIdentity(fileStat) {
  if (process.platform === 'win32') return null;
  if (typeof fileStat?.ino !== 'bigint' || fileStat.ino === 0n) {
    return null;
  }
  return typeof fileStat.dev === 'bigint' ? `${fileStat.dev}:${fileStat.ino}` : null;
}

function sameFileIdentity(left, right) {
  if (process.platform === 'win32') return false;
  const leftIdentity = fileIdentity(left);
  return leftIdentity !== null && leftIdentity === fileIdentity(right);
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && sameSnapshotMetadata(left, right);
}

function sameSnapshotMetadata(left, right) {
  return left.isFile()
    && right.isFile()
    && left.nlink === 1n
    && right.nlink === 1n
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileSnapshotIdentity(fileStat) {
  const identity = fileIdentity(fileStat);
  if (identity === null) return null;
  return `${identity}:size:${fileStat.size}:mtime-ns:${fileStat.mtimeNs}:ctime-ns:${fileStat.ctimeNs}`;
}

function setSupportPath(result, localPath) {
  result.supportPath = localPath;
  result.support_path = localPath;
}

function immutableValidationSnapshot(value) {
  if (value && typeof value === 'object' && IMMUTABLE_VALIDATION_SNAPSHOTS.has(value)) {
    return value;
  }
  const cloned = clonePortableData(value);
  return freezeSnapshot(cloned.ok && isObject(cloned.value) ? cloned.value : Object.create(null));
}

function finalizeValidationSnapshot(value) {
  const snapshot = freezeSnapshot(value);
  IMMUTABLE_VALIDATION_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function freezeSnapshot(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  return Object.freeze(value);
}

async function writeFileIfAbsent(targetPath, bytes) {
  let handle = null;
  try {
    handle = await open(targetPath, 'wx');
    await handle.writeFile(bytes);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    if (handle) await handle.close();
  }
}

function transportKindForRoot(root) {
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  if (sameOrInside(resolved, path.resolve('/dev/shm'))) return 'cas_tmpfs';
  if (sameOrInside(resolved, tmp)) return 'cas_tmpfs';
  return 'cas_shared_volume';
}

function sameOrInside(candidate, root) {
  const candidateCmp = caseNormalizedPath(candidate);
  const rootCmp = caseNormalizedPath(root);
  const relative = path.relative(rootCmp, candidateCmp);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function caseNormalizedPath(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
