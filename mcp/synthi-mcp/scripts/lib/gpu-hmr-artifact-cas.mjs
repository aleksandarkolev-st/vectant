import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION = 'synthi.cas.artifact_locator.v1';

export const GPU_HMR_ARTIFACT_CAS_MANIFEST_SCHEMA_VERSION = CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION;

export const GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.artifact_transport_evidence.v1';

export const GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION =
  'synthi.gpu_hmr.shared_artifact_addressing.v1';

export const DEFAULT_GPU_HMR_CAS_URI_SCHEME = 'synthi-cas';

export const SUPPORTED_GPU_HMR_ARTIFACT_TRANSPORTS = Object.freeze([
  'cas_shared_volume',
  'cas_tmpfs',
  'direct_worker_path',
  'serialized_fallback',
]);

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;

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
    manifest.shared_storage = sharedStorage;
  }
  manifest.manifestHash = sha256Text(stableJson({ ...manifest, manifestHash: undefined }));
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
  const normalized = isObject(manifest) ? manifest : {};
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
    reasons,
    gaps,
  };

  const fail = (reason) => {
    reasons.push(reason);
  };

  if (normalized.schemaVersion !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail('artifact_cas_manifest_schema_invalid');
  }

  let contentHash = null;
  try {
    contentHash = normalizeSha256Hash(firstPresent(
      normalized.contentHash,
      normalized.artifactHash,
      normalized.artifactContentHash,
      normalized.ramBytesHash,
    ));
    result.contentHash = contentHash;
  } catch {
    fail('artifact_cas_content_hash_invalid');
  }

  try {
    const artifactId = normalizeArtifactId(firstPresent(
      normalized.artifactId,
      normalized.selectedArtifactId,
      normalized.ramBlobId,
    ));
    result.artifactId = artifactId;
    if (contentHash && artifactId !== artifactIdForHash(contentHash)) {
      fail('artifact_cas_artifact_id_hash_mismatch');
    }
  } catch {
    fail('artifact_cas_artifact_id_invalid');
  }

  const byteLength = firstPresent(normalized.byteLength, normalized.artifactBytes, normalized.contentBytes);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail('artifact_cas_byte_length_invalid');
  } else {
    result.byteLength = byteLength;
  }

  try {
    result.mediaType = normalizeMediaType(normalized.mediaType);
  } catch {
    fail('artifact_cas_media_type_invalid');
  }

  try {
    normalizeCasSegment(normalized.role);
  } catch {
    fail('artifact_cas_role_invalid');
  }

  if (normalized.artifactKind) {
    try {
      normalizeCasSegment(normalized.artifactKind);
    } catch {
      fail('artifact_cas_artifact_kind_invalid');
    }
  }

  try {
    normalizeCasSegment(normalized.sessionNamespace);
  } catch {
    fail('artifact_cas_session_namespace_invalid');
  }

  try {
    result.artifactUri = normalizeCasUri(normalized.artifactUri, { expectedHash: contentHash });
  } catch {
    fail('artifact_cas_uri_invalid');
  }

  const transport = isObject(normalized.transport) ? normalized.transport : {};
  try {
    result.transportKind = normalizeTransportKind(transport.kind);
  } catch {
    fail('artifact_cas_transport_kind_invalid');
  }
  if (transport.contentAddressed !== true) fail('artifact_cas_transport_not_content_addressed');
  if (transport.bytesEmbedded === true) gaps.push('artifact_cas_manifest_embeds_bytes');
  if (transport.kind === 'serialized_fallback') gaps.push('serialized_artifact_transport_fallback');

  const sharedStorage = firstObject(normalized.sharedStorage, normalized.shared_storage);
  if (sharedStorage !== null) {
    const shared = validateSharedArtifactAddressing(sharedStorage, {
      expectedContentHash: contentHash,
      expectedRelativePath: contentHash ? casRelativePathForHash(contentHash) : null,
      transportKind: transport.kind,
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

  if (
    normalized.acceptedForGpuHmr === true
    || normalized.accepted_for_gpu_hmr === true
    || normalized.gpuHmrSuccess === true
    || normalized.gpu_hmr_success === true
  ) {
    fail('artifact_cas_manifest_claims_gpu_hmr_success');
  }

  const manifestHashInput = { ...normalized, manifestHash: undefined };
  result.manifestHash = sha256Text(stableJson(manifestHashInput));
  if (normalized.manifestHash && normalized.manifestHash !== result.manifestHash) {
    fail('artifact_cas_manifest_hash_mismatch');
  }

  const storage = isObject(normalized.storage) ? normalized.storage : {};
  const localPath = text(storage.localPath);
  if (localPath) {
    const roots = normalizeAllowedRoots(options.allowedRoots, options.artifactRoot);
    if (roots.length === 0) {
      fail('artifact_cas_allowed_root_required_for_local_path');
    } else {
      const inside = await resolveInsideAnyRoot(localPath, roots);
      if (!inside.accepted) {
        fail('artifact_cas_local_path_outside_allowed_roots');
      } else {
        result.localPath = inside.path;
        result.local_path = inside.path;
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
          await validateReadableBytes(inside.path, result, fail);
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
          result.localPath = resolved.path;
          result.local_path = resolved.path;
          result.resolvedFromRelativePath = true;
          result.resolved_from_relative_path = true;
          await validateReadableBytes(resolved.path, result, fail);
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
  return result;
}

export const validateArtifactLocator = validateArtifactCasManifest;

export function artifactCasManifestEvidence(manifest, validation) {
  const accepted = validation?.accepted === true;
  return {
    schemaVersion: GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
    accepted,
    acceptedAsTransportEvidence: accepted,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only',
    contentHash: manifest?.contentHash ?? null,
    artifactId: manifest?.artifactId ?? null,
    artifactUri: manifest?.artifactUri ?? null,
    transportKind: manifest?.transport?.kind ?? null,
    sharedStorageAccepted: validation?.sharedStorage?.accepted ?? validation?.shared_storage?.accepted ?? null,
    shared_storage_accepted: validation?.sharedStorage?.accepted ?? validation?.shared_storage?.accepted ?? null,
    sharedMountCount: validation?.sharedMountCount ?? validation?.shared_mount_count ?? 0,
    shared_mount_count: validation?.sharedMountCount ?? validation?.shared_mount_count ?? 0,
    sharedMountRoles: validation?.sharedMountRoles ?? validation?.shared_mount_roles ?? [],
    shared_mount_roles: validation?.sharedMountRoles ?? validation?.shared_mount_roles ?? [],
    manifestHash: validation?.manifestHash ?? manifest?.manifestHash ?? null,
    reasons: Array.isArray(validation?.reasons) ? validation.reasons : [],
    gaps: Array.isArray(validation?.gaps) ? validation.gaps : [],
  };
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
  const shared = isObject(sharedStorage) ? sharedStorage : {};
  const mounts = Array.isArray(shared.mounts) ? shared.mounts : [];
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
  if (
    shared.acceptedForGpuHmr === true
    || shared.accepted_for_gpu_hmr === true
    || shared.gpuHmrSuccess === true
    || shared.gpu_hmr_success === true
  ) {
    reasons.push('shared_artifact_addressing_claims_gpu_hmr_success');
  }
  if (!['cas_shared_volume', 'cas_tmpfs'].includes(options.transportKind)) {
    reasons.push('shared_artifact_addressing_requires_cas_transport');
  }
  if (shared.manifestOnly !== true) {
    reasons.push('shared_artifact_addressing_manifest_only_required');
  }

  try {
    result.contentHash = normalizeSha256Hash(shared.contentHash);
    if (options.expectedContentHash && result.contentHash !== normalizeSha256Hash(options.expectedContentHash)) {
      reasons.push('shared_artifact_addressing_content_hash_mismatch');
    }
  } catch {
    reasons.push('shared_artifact_addressing_content_hash_invalid');
  }

  try {
    result.relativePath = normalizeRelativeCasPath(shared.relativePath ?? shared.relative_path);
    if (options.expectedRelativePath && result.relativePath !== normalizeRelativeCasPath(options.expectedRelativePath)) {
      reasons.push('shared_artifact_addressing_relative_path_mismatch');
    }
  } catch {
    reasons.push('shared_artifact_addressing_relative_path_invalid');
  }

  const seenRoles = new Set();
  const normalizedMounts = [];
  for (const mount of mounts) {
    const normalized = normalizeSharedCasMount(mount);
    if (normalized === null) {
      reasons.push('shared_artifact_addressing_mount_invalid');
      continue;
    }
    if (seenRoles.has(normalized.role)) {
      reasons.push('shared_artifact_addressing_mount_role_duplicate');
      continue;
    }
    seenRoles.add(normalized.role);
    const expectedPath = result.relativePath ? joinMountPath(normalized.root, result.relativePath) : null;
    const declaredPath = text(mount.path ?? mount.localPath ?? mount.local_path);
    if (expectedPath && declaredPath && normalizePortablePath(declaredPath) !== normalizePortablePath(expectedPath)) {
      reasons.push('shared_artifact_addressing_mount_path_mismatch');
    }
    normalizedMounts.push(normalized);
  }
  if (normalizedMounts.length === 0) {
    reasons.push('shared_artifact_addressing_mounts_missing');
  }
  result.mountCount = normalizedMounts.length;
  result.mountRoles = normalizedMounts.map((mount) => mount.role).sort();
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

function firstObject(...values) {
  for (const value of values) {
    if (isObject(value)) return value;
  }
  return null;
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
  const object = isObject(mount) ? mount : {};
  try {
    return {
      role: normalizeCasSegment(object.role ?? object.name),
      root: normalizePortableRoot(object.root ?? object.mountRoot ?? object.mount_root),
      addressKind: normalizeCasSegment(object.addressKind ?? object.address_kind ?? 'shared_bind_mount'),
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
    return { accepted: false, path: lexical.path, root: lexical.root };
  }
  for (const root of roots) {
    try {
      const rootRealPath = await realpath(path.resolve(root));
      if (sameOrInside(candidateRealPath, rootRealPath)) {
        return { accepted: true, path: candidateRealPath, root: rootRealPath };
      }
    } catch {
      // Keep checking remaining allowed roots.
    }
  }
  return { accepted: false, path: candidateRealPath, root: null };
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

async function validateReadableBytes(localPath, result, fail) {
  let fileStat;
  try {
    fileStat = await stat(localPath);
  } catch {
    fail('artifact_cas_local_path_unreadable');
    return;
  }
  if (!fileStat.isFile()) {
    fail('artifact_cas_local_path_not_file');
    return;
  }
  const bytes = await readFile(localPath);
  const fileHash = sha256Bytes(bytes);
  if (result.contentHash && fileHash !== result.contentHash) {
    fail('artifact_cas_readable_hash_mismatch');
  }
  if (Number.isSafeInteger(result.byteLength) && bytes.byteLength !== result.byteLength) {
    fail('artifact_cas_readable_byte_length_mismatch');
  }
  result.readableByteLength = bytes.byteLength;
  result.readableContentHash = fileHash;
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
