import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.direct_source_git_identity.v1';
export const DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY =
  'git_commit_tree_identity_only_not_gpu_hmr_success';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function contentHash(value) {
  return `sha256:${sha256Hex(typeof value === 'string' ? value : stableJson(value))}`;
}

function cleanRelativePath(value, label) {
  const text = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const normalized = path.posix.normalize(text);
  if (
    !normalized
    || normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.includes('\0')
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return normalized;
}

function gitText(cwd, args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
  } catch (error) {
    if (allowFailure) return '';
    const stderr = String(error?.stderr ?? '').trim();
    const detail = stderr || String(error?.message ?? error);
    throw new Error(`direct source Git inspection failed (${args.join(' ')}): ${detail}`);
  }
}

function gitBuffer(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    const detail = stderr || String(error?.message ?? error);
    throw new Error(`direct source Git inspection failed (${args.join(' ')}): ${detail}`);
  }
}

function fullCommitOid(value, label = 'source commit') {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) {
    throw new Error(`${label} must be a full Git object id`);
  }
  return text;
}

function gitPathspec(relativeRoot) {
  return relativeRoot === '.' ? '.' : `:(top,literal)${relativeRoot}`;
}

function sourcePathInRepo(relativeRoot, sourcePath) {
  const cleanSourcePath = cleanRelativePath(sourcePath, 'direct source file path');
  return relativeRoot === '.'
    ? cleanSourcePath
    : `${relativeRoot}/${cleanSourcePath}`;
}

function sourcePathFromRepo(relativeRoot, repoPath) {
  if (relativeRoot === '.') return cleanRelativePath(repoPath, 'committed source path');
  const prefix = `${relativeRoot}/`;
  if (!repoPath.startsWith(prefix)) {
    throw new Error(`committed source path is outside the submitted source root: ${repoPath}`);
  }
  return cleanRelativePath(repoPath.slice(prefix.length), 'committed source path');
}

function statusForSubmittedRoot(repoRoot, pathspec) {
  return gitBuffer(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    pathspec,
  ]);
}

function assertStableHead(repoRoot, expectedCommit, phase) {
  const observed = fullCommitOid(
    gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    `Git HEAD commit ${phase}`,
  );
  if (observed !== expectedCommit) {
    throw new Error(
      `direct source Git HEAD changed ${phase}: expected ${expectedCommit} but observed ${observed}`,
    );
  }
}

function assertCleanSubmittedRoot(repoRoot, pathspec, phase) {
  if (statusForSubmittedRoot(repoRoot, pathspec).length > 0) {
    throw new Error(`direct source Git worktree is dirty within the submitted source root ${phase}`);
  }
}

function decodeUtf8Source(buffer, sourcePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`direct source file is not valid UTF-8: ${sourcePath}`);
  }
}

function parseCommittedTreeEntries(buffer) {
  const entries = new Map();
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('direct source Git tree entry is malformed');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const repoPath = cleanRelativePath(record.slice(tab + 1), 'committed source path');
    if (!mode || !type || !oid) {
      throw new Error(`direct source Git tree entry is malformed: ${repoPath}`);
    }
    entries.set(repoPath, { mode, type, oid, repoPath });
  }
  return entries;
}

function sourceFileHashEntry(entry) {
  return {
    path: entry.path,
    contentHash: entry.contentHash,
    content_hash: entry.content_hash,
    byteLength: entry.byteLength,
    byte_length: entry.byte_length,
  };
}

function preexistingSynthiArtifact(sourceRoot) {
  const candidates = [
    '.synthi',
    '.synthi_split_meta.json',
  ];
  return candidates.find((candidate) => existsSync(path.join(sourceRoot, candidate))) ?? null;
}

function normalizedDeclaredIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function declaredValue(value, camel, snake) {
  return value?.[camel] ?? value?.[snake] ?? null;
}

function assertDeclaredIdentityMatches(declaredIdentity, actual) {
  const declared = normalizedDeclaredIdentity(declaredIdentity);
  if (!declared) {
    throw new Error('direct_local_git_repo_path requires immutableSourceIdentity evidence');
  }
  if (
    declared.acceptedForGpuHmr === true
    || declared.accepted_for_gpu_hmr === true
    || declared.gpuHmrSuccess === true
    || declared.gpu_hmr_success === true
    || declared.canSatisfyRuntimeProof === true
    || declared.can_satisfy_runtime_proof === true
    || declared.canSatisfyDispatchProof === true
    || declared.can_satisfy_dispatch_proof === true
  ) {
    throw new Error('direct source Git identity must not claim GPU HMR, runtime, or dispatch authority');
  }
  const required = [
    ['schemaVersion', 'schema_version'],
    ['proofAuthority', 'proof_authority'],
    ['objectFormat', 'object_format'],
    ['commitOid', 'commit_oid'],
    ['rootTreeOid', 'root_tree_oid'],
    ['sourceTreeOid', 'source_tree_oid'],
    ['sourceRootRelativePath', 'source_root_relative_path'],
    ['sourceManifestHash', 'source_manifest_hash'],
    ['sourcePathSetHash', 'source_path_set_hash'],
    ['selectedSourceFileCount', 'selected_source_file_count'],
    ['worktreeClean', 'worktree_clean'],
    ['identityHash', 'identity_hash'],
  ];
  for (const [camel, snake] of required) {
    const declaredField = String(declaredValue(declared, camel, snake) ?? '');
    const actualField = String(actual[camel] ?? '');
    if (!declaredField || declaredField !== actualField) {
      throw new Error(
        `direct source Git identity mismatch for ${camel}: declared ${declaredField || 'missing'} actual ${actualField || 'missing'}`,
      );
    }
  }
  if (
    declared.accepted !== true
    || declaredValue(
      declared,
      'acceptedAsImmutableSourceIdentity',
      'accepted_as_immutable_source_identity',
    ) !== true
    || declaredValue(declared, 'worktreeClean', 'worktree_clean') !== true
    || declaredValue(declared, 'acceptedForGpuHmr', 'accepted_for_gpu_hmr') !== false
    || declaredValue(declared, 'gpuHmrSuccess', 'gpu_hmr_success') !== false
    || declaredValue(declared, 'canSatisfyRuntimeProof', 'can_satisfy_runtime_proof') !== false
    || declaredValue(declared, 'canSatisfyDispatchProof', 'can_satisfy_dispatch_proof') !== false
  ) {
    throw new Error('direct source Git identity declaration is not an accepted clean-tree observation');
  }
}

export function materializeDirectSourceGitSnapshot({
  sourceRoot,
  requestedCommit = '',
  sourceManifestHash = '',
  sourceFilePaths,
} = {}) {
  if (!sourceRoot) throw new Error('direct source Git identity requires sourceRoot');
  const declaredSourceManifestHash = String(sourceManifestHash ?? '').trim().toLowerCase();
  if (declaredSourceManifestHash && !/^sha256:[a-f0-9]{64}$/.test(declaredSourceManifestHash)) {
    throw new Error('direct source Git identity requires a content-addressed sourceManifestHash');
  }
  const selectedSourcePaths = [...new Set(
    (Array.isArray(sourceFilePaths) ? sourceFilePaths : [])
      .map((entry) => cleanRelativePath(entry, 'direct source file path')),
  )].sort();
  if (selectedSourcePaths.length === 0) {
    throw new Error('direct source Git identity requires at least one selected source file');
  }

  const sourceRootReal = realpathSync(path.resolve(sourceRoot));
  const repoRoot = realpathSync(gitText(sourceRootReal, ['rev-parse', '--show-toplevel']));
  const relativeRootRaw = path.relative(repoRoot, sourceRootReal).replace(/\\/g, '/');
  if (relativeRootRaw.startsWith('../') || path.isAbsolute(relativeRootRaw)) {
    throw new Error('direct source root is outside its reported Git repository root');
  }
  const sourceRootRelativePath = relativeRootRaw || '.';
  const headCommit = fullCommitOid(
    gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    'Git HEAD commit',
  );
  const expectedCommit = requestedCommit
    ? fullCommitOid(requestedCommit, 'requested source commit')
    : headCommit;
  if (expectedCommit !== headCommit) {
    throw new Error(
      `direct source Git commit mismatch: requested ${expectedCommit} but source root HEAD is ${headCommit}`,
    );
  }

  assertStableHead(repoRoot, expectedCommit, 'before source materialization');

  const artifact = preexistingSynthiArtifact(sourceRootReal);
  if (artifact) {
    throw new Error(`direct source cold path contains preexisting Synthi artifact: ${artifact}`);
  }

  const pathspec = gitPathspec(sourceRootRelativePath);
  assertCleanSubmittedRoot(repoRoot, pathspec, 'before source materialization');

  const rootTreeOid = fullCommitOid(
    gitText(repoRoot, ['rev-parse', `${headCommit}^{tree}`]),
    'Git root tree object id',
  );
  const sourceTreeOid = sourceRootRelativePath === '.'
    ? rootTreeOid
    : fullCommitOid(
        gitText(repoRoot, ['rev-parse', `${headCommit}:${sourceRootRelativePath}`]),
        'Git source subtree object id',
      );
  const sourceTreeType = gitText(repoRoot, ['cat-file', '-t', sourceTreeOid]);
  if (sourceTreeType !== 'tree') {
    throw new Error(`direct source root does not resolve to a Git tree: ${sourceRootRelativePath}`);
  }

  const committedTreeOutput = gitBuffer(repoRoot, sourceRootRelativePath === '.'
    ? ['ls-tree', '-r', '-z', headCommit]
    : ['ls-tree', '-r', '-z', headCommit, '--', pathspec]);
  const committedEntries = parseCommittedTreeEntries(committedTreeOutput);
  const selectedEntries = selectedSourcePaths.map((sourcePath) => {
    const repoPath = sourcePathInRepo(sourceRootRelativePath, sourcePath);
    return { sourcePath, repoPath, entry: committedEntries.get(repoPath) ?? null };
  });
  const missingCommittedPaths = selectedEntries
    .filter(({ entry }) => !entry)
    .map(({ repoPath }) => repoPath);
  if (missingCommittedPaths.length > 0) {
    throw new Error(
      `direct source files are not present in the immutable commit: ${missingCommittedPaths.join(', ')}`,
    );
  }

  const nonBlobPaths = selectedEntries
    .filter(({ entry }) => entry?.type !== 'blob')
    .map(({ repoPath }) => repoPath);
  if (nonBlobPaths.length > 0) {
    throw new Error(`direct source files do not resolve to Git blobs: ${nonBlobPaths.join(', ')}`);
  }

  const files = selectedEntries.map(({ sourcePath, repoPath, entry }) => {
    const bytes = gitBuffer(repoRoot, ['cat-file', 'blob', entry.oid]);
    const content = decodeUtf8Source(bytes, sourcePath);
    const committedSourcePath = sourcePathFromRepo(sourceRootRelativePath, repoPath);
    if (committedSourcePath !== sourcePath) {
      throw new Error(
        `direct source Git path normalization mismatch: selected ${sourcePath} committed ${committedSourcePath}`,
      );
    }
    const fileHash = `sha256:${sha256Hex(bytes)}`;
    return {
      path: sourcePath,
      inline: content,
      contentHash: fileHash,
      content_hash: fileHash,
      byteLength: bytes.length,
      byte_length: bytes.length,
      gitBlobOid: entry.oid,
      git_blob_oid: entry.oid,
      gitMode: entry.mode,
      git_mode: entry.mode,
    };
  });
  const fileManifest = files.map(sourceFileHashEntry);
  const computedSourceManifestHash = contentHash(fileManifest);
  if (
    declaredSourceManifestHash
    && declaredSourceManifestHash !== computedSourceManifestHash
  ) {
    throw new Error(
      `direct source manifest hash does not match pinned Git blob bytes: declared ${declaredSourceManifestHash} actual ${computedSourceManifestHash}`,
    );
  }

  assertStableHead(repoRoot, expectedCommit, 'after source materialization');
  assertCleanSubmittedRoot(repoRoot, pathspec, 'after source materialization');

  const objectFormat = gitText(repoRoot, ['rev-parse', '--show-object-format'], {
    allowFailure: true,
  }) || (headCommit.length === 64 ? 'sha256' : 'sha1');
  const sourcePathSetHash = contentHash(selectedSourcePaths);
  const sourceBlobManifest = files.map((entry) => ({
    path: entry.path,
    gitBlobOid: entry.gitBlobOid,
    gitMode: entry.gitMode,
    contentHash: entry.contentHash,
    byteLength: entry.byteLength,
  }));
  const sourceBlobSetHash = contentHash(sourceBlobManifest);
  const identitySeed = {
    schemaVersion: DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION,
    vcs: 'git',
    objectFormat,
    commitOid: headCommit,
    rootTreeOid,
    sourceTreeOid,
    sourceRootRelativePath,
    sourceManifestHash: computedSourceManifestHash,
    sourcePathSetHash,
    sourceBlobSetHash,
    selectedSourceFileCount: selectedSourcePaths.length,
    worktreeClean: true,
  };
  const identityHash = contentHash(identitySeed);
  const evidenceRef = `direct-source-git-identity:${identityHash}`;
  const identity = {
    schemaVersion: DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION,
    schema_version: DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION,
    proofAuthority: DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY,
    proof_authority: DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY,
    accepted: true,
    acceptedAsImmutableSourceIdentity: true,
    accepted_as_immutable_source_identity: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    vcs: 'git',
    objectFormat,
    object_format: objectFormat,
    commitOid: headCommit,
    commit_oid: headCommit,
    rootTreeOid,
    root_tree_oid: rootTreeOid,
    sourceTreeOid,
    source_tree_oid: sourceTreeOid,
    sourceRootRelativePath,
    source_root_relative_path: sourceRootRelativePath,
    sourceManifestHash: computedSourceManifestHash,
    source_manifest_hash: computedSourceManifestHash,
    sourcePathSetHash,
    source_path_set_hash: sourcePathSetHash,
    sourceBlobSetHash,
    source_blob_set_hash: sourceBlobSetHash,
    sourceBlobManifest,
    source_blob_manifest: sourceBlobManifest,
    selectedSourceFileCount: selectedSourcePaths.length,
    selected_source_file_count: selectedSourcePaths.length,
    worktreeClean: true,
    worktree_clean: true,
    identityHash,
    identity_hash: identityHash,
    evidenceRef,
    evidence_ref: evidenceRef,
  };
  return {
    identity,
    files,
    fileManifest,
    file_manifest: fileManifest,
    manifestHash: computedSourceManifestHash,
    manifest_hash: computedSourceManifestHash,
  };
}

export function inspectDirectSourceGitIdentity(inspection = {}) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(inspection.sourceManifestHash ?? ''))) {
    throw new Error('direct source Git identity requires a content-addressed sourceManifestHash');
  }
  return materializeDirectSourceGitSnapshot(inspection).identity;
}

export function verifyDirectSourceGitIdentity({
  declaredIdentity,
  ...inspection
} = {}) {
  const actual = inspectDirectSourceGitIdentity(inspection);
  assertDeclaredIdentityMatches(declaredIdentity, actual);
  return actual;
}
