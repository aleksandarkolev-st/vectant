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
  const recomputedBindingHash = contentHash(stableJson(manifestProjection(evidence)));
  if (
    evidence?.schemaVersion !== COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY
    || !Array.isArray(evidence?.entries)
    || !Number.isSafeInteger(evidence?.entryCount)
    || evidence.entryCount !== evidence.entries.length
    || !Number.isSafeInteger(evidence?.fileCount)
    || !Number.isSafeInteger(evidence?.directoryCount)
    || !Number.isSafeInteger(evidence?.symbolicLinkCount)
    || evidence.fileCount + evidence.directoryCount + evidence.symbolicLinkCount
      !== evidence.entryCount
    || !Number.isSafeInteger(evidence?.totalByteLength)
    || !Number.isSafeInteger(evidence?.maxEntryCount)
    || evidence.entryCount > evidence.maxEntryCount
    || !Number.isSafeInteger(evidence?.maxByteLength)
    || evidence.totalByteLength > evidence.maxByteLength
    || evidence?.sourceBindingHash !== recomputedBindingHash
    || evidence?.sourcePathIdentityHash !== pathIdentityHash(sourcePath)
    || evidence?.acceptedAsSourceTreeBindingEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
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
  return Object.freeze({
    evidence: Object.freeze(evidence),
    sourceTreeBindingEvidence,
    sourceTreePostBindingEvidence,
    snapshotTreeBindingEvidence,
    snapshotHostPath: canonicalSnapshot,
  });
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
    snapshot?.snapshotHostPath !== path.resolve(snapshotHostPath)
    || evidence?.schemaVersion !== COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY
    || evidence?.sourceBindingHash !== sourceTreeBindingEvidence.sourceBindingHash
    || evidence?.sourceBindingHash !== sourceTreePostBindingEvidence.sourceBindingHash
    || evidence?.sourceBindingHash !== snapshotTreeBindingEvidence.sourceBindingHash
    || evidence?.sourceTreeBindingEvidenceHash !== sourceTreeBindingEvidence.evidenceHash
    || evidence?.sourceTreePostBindingEvidenceHash
      !== sourceTreePostBindingEvidence.evidenceHash
    || evidence?.snapshotTreeBindingEvidenceHash !== snapshotTreeBindingEvidence.evidenceHash
    || evidence?.sourcePathIdentityHash !== sourceTreeBindingEvidence.sourcePathIdentityHash
    || evidence?.snapshotPathIdentityHash !== snapshotTreeBindingEvidence.sourcePathIdentityHash
    || evidence?.entryCount !== snapshotTreeBindingEvidence.entryCount
    || evidence?.totalByteLength !== snapshotTreeBindingEvidence.totalByteLength
    || evidence?.snapshotMaterialized !== true
    || evidence?.acceptedAsSourceTreeSnapshotEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
  ) {
    throw new Error('cold_build_source_tree_snapshot_evidence_invalid');
  }
  return snapshot;
}
