import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

export const COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA =
  'synthi.gpu_hmr.cold_build_source_tree_binding.v1';
export const COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY =
  'recomputed_source_tree_bytes_only_not_gpu_hmr_success';
export const COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA =
  'synthi.gpu_hmr.cold_build_source_tree_snapshot.v1';
export const COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY =
  'private_content_bound_snapshot_only_not_gpu_hmr_success';
export const COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.cold_build_source_tree_snapshot_receipt.v1';
export const COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_AUTHORITY =
  'serialized_source_tree_snapshot_evidence_only_not_gpu_hmr_success';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PINNED_SOURCE_TREE_SNAPSHOTS = new WeakMap();
const SOURCE_TREE_BINDING_EVIDENCE_KEYS = [
  'schemaVersion',
  'entries',
  'entryCount',
  'fileCount',
  'directoryCount',
  'symbolicLinkCount',
  'totalByteLength',
  'proofAuthority',
  'sourceBindingHash',
  'sourcePathIdentityHash',
  'maxEntryCount',
  'maxByteLength',
  'acceptedAsSourceTreeBindingEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
];
const SOURCE_TREE_SNAPSHOT_EVIDENCE_KEYS = [
  'schemaVersion',
  'proofAuthority',
  'sourceBindingHash',
  'sourceTreeBindingEvidenceHash',
  'sourceTreePostBindingEvidenceHash',
  'snapshotTreeBindingEvidenceHash',
  'sourcePathIdentityHash',
  'snapshotPathIdentityHash',
  'entryCount',
  'totalByteLength',
  'snapshotMaterialized',
  'acceptedAsSourceTreeSnapshotEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
];
const SOURCE_TREE_SNAPSHOT_KEYS = [
  'evidence',
  'sourceTreeBindingEvidence',
  'sourceTreePostBindingEvidence',
  'snapshotTreeBindingEvidence',
  'snapshotHostPath',
];
const SOURCE_TREE_SNAPSHOT_RECEIPT_KEYS = [
  'schemaVersion',
  'proofAuthority',
  'sourceTreeBindingEvidence',
  'sourceTreePostBindingEvidence',
  'snapshotTreeBindingEvidence',
  'snapshotEvidence',
  'acceptedAsSourceTreeSnapshotReceipt',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
];

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function requireSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`cold_build_source_tree_${name}_invalid`);
  }
  return value;
}

function requireHostPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error('cold_build_source_tree_path_invalid');
  }
  return path.resolve(value);
}

function normalizedPathIdentity(value) {
  return path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
}

function pathIdentityHash(value) {
  return contentHash(normalizedPathIdentity(value));
}

function sameFileMetadata(left, right) {
  return left?.size === right?.size
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid
    && left?.gid === right?.gid
    && left?.mtimeNs === right?.mtimeNs
    && left?.ctimeNs === right?.ctimeNs;
}

function samePathFileIdentity(left, right) {
  if (process.platform === 'win32') {
    return typeof left?.ino === 'bigint'
      && left.ino !== 0n
      && left.ino === right?.ino;
  }
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameOpenFileIdentity(left, right) {
  return typeof left?.dev === 'bigint'
    && typeof left?.ino === 'bigint'
    && left.ino !== 0n
    && left.dev === right?.dev
    && left.ino === right?.ino;
}

async function readStableRegularFile(filePath, maxByteLength) {
  const beforePath = await lstat(filePath, { bigint: true });
  const handle = await open(filePath, 'r');
  let verificationHandle = null;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxByteLength)) {
      throw new Error('cold_build_source_tree_byte_limit_exceeded');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    verificationHandle = await open(filePath, 'r');
    const verification = await verificationHandle.stat({ bigint: true });
    const finalPath = await lstat(filePath, { bigint: true });
    if (
      beforePath.isSymbolicLink()
      || pathAfter.isSymbolicLink()
      || finalPath.isSymbolicLink()
      || !samePathFileIdentity(beforePath, pathAfter)
      || !samePathFileIdentity(pathAfter, finalPath)
      || !samePathFileIdentity(finalPath, verification)
      || !sameOpenFileIdentity(before, after)
      || !sameOpenFileIdentity(after, verification)
      || !sameFileMetadata(beforePath, before)
      || !sameFileMetadata(before, after)
      || !sameFileMetadata(after, pathAfter)
      || !sameFileMetadata(pathAfter, verification)
      || !sameFileMetadata(verification, finalPath)
      || BigInt(bytes.byteLength) !== verification.size
    ) {
      throw new Error('cold_build_source_tree_file_identity_changed');
    }
    return { bytes, metadata: verification };
  } finally {
    await verificationHandle?.close().catch(() => {});
    await handle.close();
  }
}

function isPathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sourceRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function manifestProjection(evidence) {
  return {
    schemaVersion: evidence?.schemaVersion,
    entries: evidence?.entries,
    entryCount: evidence?.entryCount,
    fileCount: evidence?.fileCount,
    directoryCount: evidence?.directoryCount,
    symbolicLinkCount: evidence?.symbolicLinkCount,
    totalByteLength: evidence?.totalByteLength,
  };
}

function sourceTreeRelativePathAccepted(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 32 * 1024
    || /[\0\r\n]/.test(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function sourceTreeEntryAccepted(entry) {
  if (!sourceTreeRelativePathAccepted(entry?.path)) return false;
  if (entry.kind === 'file') {
    return exactKeys(entry, ['path', 'kind', 'mode', 'byteLength', 'contentHash'])
      && Number.isSafeInteger(entry.mode)
      && entry.mode >= 0
      && entry.mode <= 0o777
      && Number.isSafeInteger(entry.byteLength)
      && entry.byteLength >= 0
      && SHA256_PATTERN.test(entry.contentHash ?? '');
  }
  if (entry.kind === 'directory') {
    return exactKeys(entry, ['path', 'kind', 'mode'])
      && Number.isSafeInteger(entry.mode)
      && entry.mode >= 0
      && entry.mode <= 0o777;
  }
  if (entry.kind === 'symbolic_link') {
    if (
      !exactKeys(entry, ['path', 'kind', 'target'])
      || typeof entry.target !== 'string'
      || entry.target.length === 0
      || Buffer.byteLength(entry.target, 'utf8') > 32 * 1024
      || /[\0\r\n]/.test(entry.target)
      || path.posix.isAbsolute(entry.target)
      || path.win32.isAbsolute(entry.target)
    ) {
      return false;
    }
    const targetFromRoot = path.posix.normalize(path.posix.join(
      path.posix.dirname(entry.path),
      entry.target,
    ));
    return targetFromRoot === '.' || sourceTreeRelativePathAccepted(targetFromRoot);
  }
  return false;
}

function sourceTreeBindingEvidenceAccepted(evidence) {
  if (
    !exactKeys(evidence, SOURCE_TREE_BINDING_EVIDENCE_KEYS)
    || evidence.schemaVersion !== COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA
    || evidence.proofAuthority !== COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY
    || !Array.isArray(evidence.entries)
    || !Number.isSafeInteger(evidence.entryCount)
    || evidence.entryCount < 0
    || evidence.entryCount !== evidence.entries.length
    || !Number.isSafeInteger(evidence.fileCount)
    || evidence.fileCount < 0
    || !Number.isSafeInteger(evidence.directoryCount)
    || evidence.directoryCount < 0
    || !Number.isSafeInteger(evidence.symbolicLinkCount)
    || evidence.symbolicLinkCount < 0
    || !Number.isSafeInteger(evidence.totalByteLength)
    || evidence.totalByteLength < 0
    || !Number.isSafeInteger(evidence.maxEntryCount)
    || evidence.maxEntryCount < 1
    || evidence.entryCount > evidence.maxEntryCount
    || !Number.isSafeInteger(evidence.maxByteLength)
    || evidence.maxByteLength < 1
    || evidence.totalByteLength > evidence.maxByteLength
    || !SHA256_PATTERN.test(evidence.sourceBindingHash ?? '')
    || !SHA256_PATTERN.test(evidence.sourcePathIdentityHash ?? '')
    || !SHA256_PATTERN.test(evidence.evidenceHash ?? '')
    || evidence.acceptedAsSourceTreeBindingEvidence !== true
    || evidence.acceptedForGpuHmr !== false
    || evidence.gpuHmrSuccess !== false
    || evidence.canSatisfyRuntimeProof !== false
    || evidence.canSatisfyDispatchProof !== false
  ) {
    return false;
  }

  const entryKinds = new Map();
  let fileCount = 0;
  let directoryCount = 0;
  let symbolicLinkCount = 0;
  let totalByteLength = 0;
  for (const entry of evidence.entries) {
    if (!sourceTreeEntryAccepted(entry) || entryKinds.has(entry.path)) return false;
    entryKinds.set(entry.path, entry.kind);
    if (entry.kind === 'file') {
      fileCount += 1;
      totalByteLength += entry.byteLength;
      if (!Number.isSafeInteger(totalByteLength)) return false;
    } else if (entry.kind === 'directory') {
      directoryCount += 1;
    } else {
      symbolicLinkCount += 1;
    }
  }
  for (const entryPath of entryKinds.keys()) {
    const parts = entryPath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (entryKinds.get(parts.slice(0, index).join('/')) !== 'directory') return false;
    }
  }

  return evidence.fileCount === fileCount
    && evidence.directoryCount === directoryCount
    && evidence.symbolicLinkCount === symbolicLinkCount
    && fileCount + directoryCount + symbolicLinkCount === evidence.entryCount
    && evidence.totalByteLength === totalByteLength
    && evidence.sourceBindingHash === contentHash(stableJson(manifestProjection(evidence)))
    && evidence.evidenceHash === recomputeEvidenceHash(evidence);
}

function sourceTreeSnapshotEvidenceAccepted(evidence) {
  const hashFields = [
    'sourceBindingHash',
    'sourceTreeBindingEvidenceHash',
    'sourceTreePostBindingEvidenceHash',
    'snapshotTreeBindingEvidenceHash',
    'sourcePathIdentityHash',
    'snapshotPathIdentityHash',
    'evidenceHash',
  ];
  return exactKeys(evidence, SOURCE_TREE_SNAPSHOT_EVIDENCE_KEYS)
    && evidence.schemaVersion === COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA
    && evidence.proofAuthority === COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY
    && hashFields.every((name) => SHA256_PATTERN.test(evidence[name] ?? ''))
    && Number.isSafeInteger(evidence.entryCount)
    && evidence.entryCount >= 0
    && Number.isSafeInteger(evidence.totalByteLength)
    && evidence.totalByteLength >= 0
    && evidence.snapshotMaterialized === true
    && evidence.acceptedAsSourceTreeSnapshotEvidence === true
    && evidence.acceptedForGpuHmr === false
    && evidence.gpuHmrSuccess === false
    && evidence.canSatisfyRuntimeProof === false
    && evidence.canSatisfyDispatchProof === false
    && evidence.evidenceHash === recomputeEvidenceHash(evidence);
}

function sourceTreeSnapshotMaterialAccepted({
  sourceTreeBindingEvidence,
  sourceTreePostBindingEvidence,
  snapshotTreeBindingEvidence,
  snapshotEvidence,
} = {}) {
  const bindings = [
    sourceTreeBindingEvidence,
    sourceTreePostBindingEvidence,
    snapshotTreeBindingEvidence,
  ];
  if (
    bindings.some((binding) => !sourceTreeBindingEvidenceAccepted(binding))
    || !sourceTreeSnapshotEvidenceAccepted(snapshotEvidence)
  ) {
    return false;
  }
  const sourceManifest = stableJson(manifestProjection(sourceTreeBindingEvidence));
  return bindings.every((binding) => binding.sourceBindingHash === snapshotEvidence.sourceBindingHash)
    && bindings.every((binding) => stableJson(manifestProjection(binding)) === sourceManifest)
    && sourceTreeBindingEvidence.evidenceHash
      === snapshotEvidence.sourceTreeBindingEvidenceHash
    && sourceTreePostBindingEvidence.evidenceHash
      === snapshotEvidence.sourceTreePostBindingEvidenceHash
    && snapshotTreeBindingEvidence.evidenceHash
      === snapshotEvidence.snapshotTreeBindingEvidenceHash
    && sourceTreeBindingEvidence.sourcePathIdentityHash
      === sourceTreePostBindingEvidence.sourcePathIdentityHash
    && sourceTreeBindingEvidence.sourcePathIdentityHash
      === snapshotEvidence.sourcePathIdentityHash
    && snapshotTreeBindingEvidence.sourcePathIdentityHash
      === snapshotEvidence.snapshotPathIdentityHash
    && snapshotEvidence.sourcePathIdentityHash !== snapshotEvidence.snapshotPathIdentityHash
    && sourceTreeBindingEvidence.maxEntryCount === sourceTreePostBindingEvidence.maxEntryCount
    && sourceTreeBindingEvidence.maxEntryCount === snapshotTreeBindingEvidence.maxEntryCount
    && sourceTreeBindingEvidence.maxByteLength === sourceTreePostBindingEvidence.maxByteLength
    && sourceTreeBindingEvidence.maxByteLength === snapshotTreeBindingEvidence.maxByteLength
    && bindings.every((binding) => binding.entryCount === snapshotEvidence.entryCount)
    && bindings.every((binding) => binding.totalByteLength === snapshotEvidence.totalByteLength);
}

function sourceTreeSnapshotReceiptMaterial(snapshot) {
  return {
    sourceTreeBindingEvidence: snapshot?.sourceTreeBindingEvidence,
    sourceTreePostBindingEvidence: snapshot?.sourceTreePostBindingEvidence,
    snapshotTreeBindingEvidence: snapshot?.snapshotTreeBindingEvidence,
    snapshotEvidence: snapshot?.evidence,
  };
}

export async function computeColdBuildSourceTreeBinding(sourceHostPath, {
  maxEntryCount,
  maxByteLength,
} = {}) {
  const entryLimit = requireSafeInteger(maxEntryCount, 'entry_limit');
  const byteLimit = requireSafeInteger(maxByteLength, 'byte_limit');
  const requestedRoot = requireHostPath(sourceHostPath);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root, { bigint: true });
  const requestedRootMetadata = await lstat(requestedRoot, { bigint: true });
  if (
    rootMetadata.isSymbolicLink()
    || requestedRootMetadata.isSymbolicLink()
    || !rootMetadata.isDirectory()
    || !samePathFileIdentity(rootMetadata, requestedRootMetadata)
  ) {
    throw new Error('cold_build_source_tree_root_invalid');
  }
  const entries = [];
  let totalByteLength = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let symbolicLinkCount = 0;
  const walk = async (directoryPath) => {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(
      Buffer.from(left.name),
      Buffer.from(right.name),
    ));
    for (const child of children) {
      if (/[\0\r\n]/.test(child.name)) {
        throw new Error('cold_build_source_tree_path_invalid');
      }
      const absolutePath = path.join(directoryPath, child.name);
      const relativePath = sourceRelativePath(root, absolutePath);
      if (
        !relativePath
        || relativePath.startsWith('../')
        || path.posix.isAbsolute(relativePath)
        || path.win32.isAbsolute(relativePath)
      ) {
        throw new Error('cold_build_source_tree_path_invalid');
      }
      if (entries.length >= entryLimit) {
        throw new Error('cold_build_source_tree_entry_limit_exceeded');
      }
      const symbolicMetadata = await lstat(absolutePath, { bigint: true });
      if (symbolicMetadata.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const resolvedTarget = path.resolve(directoryPath, target);
        if (path.isAbsolute(target) || !isPathWithin(resolvedTarget, root)) {
          throw new Error('cold_build_source_tree_symlink_escape');
        }
        entries.push({
          path: relativePath,
          kind: 'symbolic_link',
          target: target.split(path.sep).join('/'),
        });
        symbolicLinkCount += 1;
        continue;
      }
      if (symbolicMetadata.isDirectory()) {
        entries.push({
          path: relativePath,
          kind: 'directory',
          mode: Number(symbolicMetadata.mode & 0o777n),
        });
        directoryCount += 1;
        await walk(absolutePath);
        continue;
      }
      if (!symbolicMetadata.isFile()) {
        throw new Error('cold_build_source_tree_special_file_refused');
      }
      const remainingBytes = byteLimit - totalByteLength;
      if (remainingBytes < 0) {
        throw new Error('cold_build_source_tree_byte_limit_exceeded');
      }
      const stableFile = await readStableRegularFile(absolutePath, remainingBytes);
      totalByteLength += stableFile.bytes.byteLength;
      if (totalByteLength > byteLimit) {
        throw new Error('cold_build_source_tree_byte_limit_exceeded');
      }
      entries.push({
        path: relativePath,
        kind: 'file',
        mode: Number(stableFile.metadata.mode & 0o777n),
        byteLength: stableFile.bytes.byteLength,
        contentHash: contentHash(stableFile.bytes),
      });
      fileCount += 1;
    }
  };
  await walk(root);
  const manifest = {
    schemaVersion: COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA,
    entries,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    symbolicLinkCount,
    totalByteLength,
  };
  const sourceBindingHash = contentHash(stableJson(manifest));
  const evidence = {
    ...manifest,
    proofAuthority: COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY,
    sourceBindingHash,
    sourcePathIdentityHash: pathIdentityHash(root),
    maxEntryCount: entryLimit,
    maxByteLength: byteLimit,
    acceptedAsSourceTreeBindingEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  return evidence;
}

export function verifyColdBuildSourceTreeBindingEvidence(evidence, sourceHostPath) {
  const sourcePath = requireHostPath(sourceHostPath);
  if (
    !sourceTreeBindingEvidenceAccepted(evidence)
    || evidence.sourcePathIdentityHash !== pathIdentityHash(sourcePath)
  ) {
    throw new Error('cold_build_source_tree_binding_evidence_invalid');
  }
  return evidence;
}

export async function materializeColdBuildSourceTreeSnapshot(
  sourceHostPath,
  snapshotHostPath,
  limits = {},
) {
  const requestedSource = requireHostPath(sourceHostPath);
  const requestedSnapshot = requireHostPath(snapshotHostPath);
  const canonicalSource = await realpath(requestedSource);
  const snapshotParent = await realpath(path.dirname(requestedSnapshot));
  if (
    isPathWithin(requestedSnapshot, canonicalSource)
    || isPathWithin(canonicalSource, requestedSnapshot)
    || !isPathWithin(requestedSnapshot, snapshotParent)
  ) {
    throw new Error('cold_build_source_tree_snapshot_path_invalid');
  }
  try {
    await lstat(requestedSnapshot);
    throw new Error('cold_build_source_tree_snapshot_path_exists');
  } catch (error) {
    if (error?.message === 'cold_build_source_tree_snapshot_path_exists') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }

  const sourceTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
    requestedSource,
    limits,
  );
  await cp(canonicalSource, requestedSnapshot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    verbatimSymlinks: true,
  });
  const canonicalSnapshot = await realpath(requestedSnapshot);
  const snapshotMetadata = await lstat(canonicalSnapshot, { bigint: true });
  if (snapshotMetadata.isSymbolicLink() || !snapshotMetadata.isDirectory()) {
    throw new Error('cold_build_source_tree_snapshot_path_invalid');
  }
  const snapshotTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
    canonicalSnapshot,
    limits,
  );
  const sourceTreePostBindingEvidence = await computeColdBuildSourceTreeBinding(
    requestedSource,
    limits,
  );
  if (
    sourceTreeBindingEvidence.sourceBindingHash
      !== snapshotTreeBindingEvidence.sourceBindingHash
    || sourceTreeBindingEvidence.sourceBindingHash
      !== sourceTreePostBindingEvidence.sourceBindingHash
  ) {
    throw new Error('cold_build_source_tree_snapshot_binding_mismatch');
  }
  const evidence = {
    schemaVersion: COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA,
    proofAuthority: COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY,
    sourceBindingHash: sourceTreeBindingEvidence.sourceBindingHash,
    sourceTreeBindingEvidenceHash: sourceTreeBindingEvidence.evidenceHash,
    sourceTreePostBindingEvidenceHash: sourceTreePostBindingEvidence.evidenceHash,
    snapshotTreeBindingEvidenceHash: snapshotTreeBindingEvidence.evidenceHash,
    sourcePathIdentityHash: sourceTreeBindingEvidence.sourcePathIdentityHash,
    snapshotPathIdentityHash: snapshotTreeBindingEvidence.sourcePathIdentityHash,
    entryCount: snapshotTreeBindingEvidence.entryCount,
    totalByteLength: snapshotTreeBindingEvidence.totalByteLength,
    snapshotMaterialized: true,
    acceptedAsSourceTreeSnapshotEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  const snapshot = Object.freeze({
    evidence: Object.freeze(evidence),
    sourceTreeBindingEvidence,
    sourceTreePostBindingEvidence,
    snapshotTreeBindingEvidence,
    snapshotHostPath: canonicalSnapshot,
  });
  PINNED_SOURCE_TREE_SNAPSHOTS.set(snapshot, Object.freeze({
    sourceHostPath: canonicalSource,
    snapshotHostPath: canonicalSnapshot,
    evidence: snapshot.evidence,
    sourceTreeBindingEvidence,
    sourceTreePostBindingEvidence,
    snapshotTreeBindingEvidence,
    materialHash: contentHash(stableJson(sourceTreeSnapshotReceiptMaterial(snapshot))),
  }));
  return snapshot;
}

export function verifyColdBuildSourceTreeSnapshot(
  snapshot,
  sourceHostPath,
  snapshotHostPath,
) {
  const sourceTreeBindingEvidence = verifyColdBuildSourceTreeBindingEvidence(
    snapshot?.sourceTreeBindingEvidence,
    sourceHostPath,
  );
  const sourceTreePostBindingEvidence = verifyColdBuildSourceTreeBindingEvidence(
    snapshot?.sourceTreePostBindingEvidence,
    sourceHostPath,
  );
  const snapshotTreeBindingEvidence = verifyColdBuildSourceTreeBindingEvidence(
    snapshot?.snapshotTreeBindingEvidence,
    snapshotHostPath,
  );
  const evidence = snapshot?.evidence;
  if (
    !exactKeys(snapshot, SOURCE_TREE_SNAPSHOT_KEYS)
    || snapshot.snapshotHostPath !== path.resolve(snapshotHostPath)
    || !sourceTreeSnapshotMaterialAccepted({
      sourceTreeBindingEvidence,
      sourceTreePostBindingEvidence,
      snapshotTreeBindingEvidence,
      snapshotEvidence: evidence,
    })
  ) {
    throw new Error('cold_build_source_tree_snapshot_evidence_invalid');
  }
  return snapshot;
}

export function createColdBuildSourceTreeSnapshotReceipt(snapshot) {
  const pinned = PINNED_SOURCE_TREE_SNAPSHOTS.get(snapshot);
  const material = sourceTreeSnapshotReceiptMaterial(snapshot);
  const materialHash = contentHash(stableJson(material));
  let snapshotValid = false;
  if (pinned) {
    try {
      snapshotValid = verifyColdBuildSourceTreeSnapshot(
        snapshot,
        pinned.sourceHostPath,
        pinned.snapshotHostPath,
      ) === snapshot;
    } catch {
      snapshotValid = false;
    }
  }
  if (
    !pinned
    || !snapshotValid
    || pinned.snapshotHostPath !== snapshot?.snapshotHostPath
    || pinned.evidence !== snapshot?.evidence
    || pinned.sourceTreeBindingEvidence !== snapshot?.sourceTreeBindingEvidence
    || pinned.sourceTreePostBindingEvidence !== snapshot?.sourceTreePostBindingEvidence
    || pinned.snapshotTreeBindingEvidence !== snapshot?.snapshotTreeBindingEvidence
    || pinned.materialHash !== materialHash
  ) {
    throw new Error('cold_build_source_tree_snapshot_receipt_source_invalid');
  }

  const receipt = {
    schemaVersion: COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA,
    proofAuthority: COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_AUTHORITY,
    ...structuredClone(material),
    acceptedAsSourceTreeSnapshotReceipt: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  receipt.evidenceHash = recomputeEvidenceHash(receipt);
  return receipt;
}

export function verifyColdBuildSourceTreeSnapshotReceipt(receipt) {
  if (
    !exactKeys(receipt, SOURCE_TREE_SNAPSHOT_RECEIPT_KEYS)
    || receipt.schemaVersion !== COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA
    || receipt.proofAuthority !== COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_AUTHORITY
    || !sourceTreeSnapshotMaterialAccepted(receipt)
    || receipt.acceptedAsSourceTreeSnapshotReceipt !== true
    || receipt.acceptedForGpuHmr !== false
    || receipt.gpuHmrSuccess !== false
    || receipt.canSatisfyRuntimeProof !== false
    || receipt.canSatisfyDispatchProof !== false
    || !SHA256_PATTERN.test(receipt.evidenceHash ?? '')
    || receipt.evidenceHash !== recomputeEvidenceHash(receipt)
  ) {
    throw new Error('cold_build_source_tree_snapshot_receipt_invalid');
  }
  return receipt;
}
