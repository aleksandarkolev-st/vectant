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

export function inspectDirectSourceGitIdentity({
  sourceRoot,
  requestedCommit = '',
  sourceManifestHash,
  sourceFilePaths,
} = {}) {
  if (!sourceRoot) throw new Error('direct source Git identity requires sourceRoot');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(sourceManifestHash ?? ''))) {
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

  const artifact = preexistingSynthiArtifact(sourceRootReal);
  if (artifact) {
    throw new Error(`direct source cold path contains preexisting Synthi artifact: ${artifact}`);
  }

  const pathspec = gitPathspec(sourceRootRelativePath);
  const status = gitBuffer(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    pathspec,
  ]);
  if (status.length > 0) {
    throw new Error('direct source Git worktree is dirty within the submitted source root');
  }

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

  const committedPathsOutput = gitBuffer(repoRoot, sourceRootRelativePath === '.'
    ? ['ls-tree', '-r', '-z', '--name-only', headCommit]
    : ['ls-tree', '-r', '-z', '--name-only', headCommit, '--', pathspec]);
  const committedPaths = new Set(
    committedPathsOutput.toString('utf8').split('\0').filter(Boolean),
  );
  const missingCommittedPaths = selectedSourcePaths
    .map((sourcePath) => sourcePathInRepo(sourceRootRelativePath, sourcePath))
    .filter((sourcePath) => !committedPaths.has(sourcePath));
  if (missingCommittedPaths.length > 0) {
    throw new Error(
      `direct source files are not present in the immutable commit: ${missingCommittedPaths.join(', ')}`,
    );
  }

  const objectFormat = gitText(repoRoot, ['rev-parse', '--show-object-format'], {
    allowFailure: true,
  }) || (headCommit.length === 64 ? 'sha256' : 'sha1');
  const sourcePathSetHash = contentHash(selectedSourcePaths);
  const identitySeed = {
    schemaVersion: DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION,
    vcs: 'git',
    objectFormat,
    commitOid: headCommit,
    rootTreeOid,
    sourceTreeOid,
    sourceRootRelativePath,
    sourceManifestHash: String(sourceManifestHash).toLowerCase(),
    sourcePathSetHash,
    selectedSourceFileCount: selectedSourcePaths.length,
    worktreeClean: true,
  };
  const identityHash = contentHash(identitySeed);
  const evidenceRef = `direct-source-git-identity:${identityHash}`;
  return {
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
    sourceManifestHash: String(sourceManifestHash).toLowerCase(),
    source_manifest_hash: String(sourceManifestHash).toLowerCase(),
    sourcePathSetHash,
    source_path_set_hash: sourcePathSetHash,
    selectedSourceFileCount: selectedSourcePaths.length,
    selected_source_file_count: selectedSourcePaths.length,
    worktreeClean: true,
    worktree_clean: true,
    identityHash,
    identity_hash: identityHash,
    evidenceRef,
    evidence_ref: evidenceRef,
  };
}

export function verifyDirectSourceGitIdentity({
  declaredIdentity,
  ...inspection
} = {}) {
  const actual = inspectDirectSourceGitIdentity(inspection);
  assertDeclaredIdentityMatches(declaredIdentity, actual);
  return actual;
}
