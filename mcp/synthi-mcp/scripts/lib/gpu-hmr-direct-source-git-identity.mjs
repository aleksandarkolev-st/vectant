import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.direct_source_git_identity.v1';
export const DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY =
  'git_commit_tree_identity_only_not_gpu_hmr_success';
export const EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION =
  'synthi.gpu_hmr.exact_commit_git_blob_snapshot.v1';
export const EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY =
  'exact_commit_source_build_git_blob_snapshot_support_only_not_gpu_hmr_runtime_or_dispatch_authority';

const SHA256_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXACT_COMMIT_SELECTION_KINDS = new Set(['source', 'build']);
const EXACT_COMMIT_REQUEST_KEYS = new Set([
  'repositoryRoot',
  'commitOid',
  'sourceRootRelativePath',
  'sourcePaths',
  'buildPaths',
  'generatedArtifacts',
  'compileManifestArtifacts',
  'expectedPathSetHash',
  'expectedManifestHash',
]);
const EXACT_COMMIT_AUTHORITY_BOOLEAN_KEYS = new Set([
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'cansatisfygpuhmrproof',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
]);

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

function gitObjectCommand(cwd, args, { encoding = 'utf8', allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return encoding === 'buffer' ? Buffer.alloc(0) : '';
    const stderr = String(error?.stderr ?? '').trim();
    const detail = stderr || String(error?.message ?? error);
    throw new Error(`exact-commit Git object inspection failed (${args.join(' ')}): ${detail}`);
  }
}

function gitObjectText(cwd, args, options = {}) {
  return String(gitObjectCommand(cwd, args, {
    ...options,
    encoding: 'utf8',
  })).trim();
}

function gitObjectBuffer(cwd, args, options = {}) {
  return gitObjectCommand(cwd, args, {
    ...options,
    encoding: 'buffer',
  });
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

function isSynthiArtifactPath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const segments = normalized.split('/').map((segment) => segment.toLowerCase());
  return segments.includes('.synthi') || segments.includes('.synthi_split_meta.json');
}

function normalizedClaimKey(value) {
  return String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function valueWasSupplied(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function assertNoExactCommitAuthorityClaims(
  value,
  label,
  { allowSupportIdentity = false, seen = new WeakSet() } = {},
) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizedClaimKey(key);
    const domainAuthorityClaim = (
      ['gpuhmr', 'runtime', 'dispatch'].some((domain) => normalizedKey.includes(domain))
      && ['accept', 'success', 'satisfy', 'proof', 'authority']
        .some((claim) => normalizedKey.includes(claim))
    );
    if (
      (EXACT_COMMIT_AUTHORITY_BOOLEAN_KEYS.has(normalizedKey) || domainAuthorityClaim)
      && entry !== false
      && valueWasSupplied(entry)
    ) {
      throw new Error(
        `exact-commit Git blob snapshot rejects GPU HMR, runtime, or dispatch authority claims in ${label}`,
      );
    }
    if (
      normalizedKey.includes('authority')
      && valueWasSupplied(entry)
      && (
        !allowSupportIdentity
        || !['proofauthority', 'authorityscope'].includes(normalizedKey)
      )
    ) {
      throw new Error(
        `exact-commit Git blob snapshot rejects caller-supplied authority claims in ${label}`,
      );
    }
    if (entry && typeof entry === 'object') {
      assertNoExactCommitAuthorityClaims(entry, label, { allowSupportIdentity, seen });
    }
  }
}

function assertNoSuppliedExactCommitArtifacts(request, seen = new WeakSet()) {
  if (!request || typeof request !== 'object' || seen.has(request)) return;
  seen.add(request);
  for (const [key, value] of Object.entries(request ?? {})) {
    const normalizedKey = normalizedClaimKey(key);
    if (
      valueWasSupplied(value)
      && (
        normalizedKey.includes('generatedartifact')
        || normalizedKey.includes('compilemanifest')
      )
    ) {
      throw new Error(
        'exact-commit Git blob snapshot refuses supplied generated or compile-manifest artifacts',
      );
    }
    if (value && typeof value === 'object') {
      assertNoSuppliedExactCommitArtifacts(value, seen);
    }
  }
}

function assertExactCommitRequestFields(request) {
  const unsupported = Object.keys(request).filter((key) => !EXACT_COMMIT_REQUEST_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `exact-commit Git blob snapshot request contains unsupported fields: ${unsupported.join(', ')}`,
    );
  }
}

function strictGitRelativePath(value, label, { allowRepositoryRoot = false } = {}) {
  if (typeof value !== 'string') throw new Error(`invalid ${label}: ${value}`);
  if (allowRepositoryRoot && value === '.') return value;
  if (
    !value
    || value === '.'
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  return value;
}

function compareGitPaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizedExactCommitSelections(sourcePaths, buildPaths) {
  if (!Array.isArray(sourcePaths) || !Array.isArray(buildPaths)) {
    throw new Error('exact-commit Git blob snapshot requires sourcePaths and buildPaths arrays');
  }
  const selections = [
    ...sourcePaths.map((selectedPath) => ({
      path: strictGitRelativePath(selectedPath, 'selected source path'),
      kind: 'source',
    })),
    ...buildPaths.map((selectedPath) => ({
      path: strictGitRelativePath(selectedPath, 'selected build path'),
      kind: 'build',
    })),
  ];
  if (selections.length === 0) {
    throw new Error('exact-commit Git blob snapshot requires at least one source or build path');
  }
  const paths = new Set();
  for (const selection of selections) {
    if (!EXACT_COMMIT_SELECTION_KINDS.has(selection.kind)) {
      throw new Error(`unsupported exact-commit Git blob selection kind: ${selection.kind}`);
    }
    if (paths.has(selection.path)) {
      throw new Error(`duplicate exact-commit Git blob snapshot path: ${selection.path}`);
    }
    if (isSynthiArtifactPath(selection.path)) {
      throw new Error(
        `exact-commit Git blob snapshot path is inside a Synthi artifact namespace: ${selection.path}`,
      );
    }
    paths.add(selection.path);
  }
  return selections.sort((left, right) => compareGitPaths(left.path, right.path));
}

function optionalExpectedContentHash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized && !SHA256_CONTENT_HASH_PATTERN.test(normalized)) {
    throw new Error(`exact-commit Git blob snapshot requires a content-addressed ${label}`);
  }
  return normalized;
}

function sameCanonicalPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function exactCommitRepositoryRoot(repositoryRoot) {
  if (!repositoryRoot) {
    throw new Error('exact-commit Git blob snapshot requires repositoryRoot');
  }
  let requestedRoot;
  try {
    requestedRoot = realpathSync(path.resolve(repositoryRoot));
  } catch (error) {
    throw new Error(
      `exact-commit Git blob snapshot repository root is unavailable: ${error?.message ?? error}`,
    );
  }
  const bare = gitObjectText(requestedRoot, ['rev-parse', '--is-bare-repository']) === 'true';
  const reportedRoot = realpathSync(gitObjectText(
    requestedRoot,
    bare
      ? ['rev-parse', '--absolute-git-dir']
      : ['rev-parse', '--show-toplevel'],
  ));
  if (!sameCanonicalPath(requestedRoot, reportedRoot)) {
    throw new Error(
      `exact-commit Git repository root mismatch: supplied ${requestedRoot} reported ${reportedRoot}`,
    );
  }
  return requestedRoot;
}

function exactGitObjectFormat(repoRoot, commitOid) {
  const objectFormat = gitObjectText(repoRoot, ['rev-parse', '--show-object-format'], {
    allowFailure: true,
  }) || (commitOid.length === 64 ? 'sha256' : 'sha1');
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error(`unsupported exact-commit Git object format: ${objectFormat}`);
  }
  const expectedOidLength = objectFormat === 'sha256' ? 64 : 40;
  if (commitOid.length !== expectedOidLength) {
    throw new Error(
      `exact-commit Git commit object id does not match repository object format ${objectFormat}`,
    );
  }
  return objectFormat;
}

function exactGitObjectOid(value, objectFormat, label) {
  const text = String(value ?? '').trim().toLowerCase();
  const expectedLength = objectFormat === 'sha256' ? 64 : 40;
  if (text.length !== expectedLength || !/^[a-f0-9]+$/.test(text)) {
    throw new Error(`${label} is not a full ${objectFormat} Git object id`);
  }
  return text;
}

function decodeExactGitPath(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(`exact-commit Git tree contains a non-UTF-8 ${label}`);
  }
}

function parseExactCommitTreeEntries(buffer, objectFormat) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const recordEnd = buffer.indexOf(0, offset);
    if (recordEnd < 0) {
      throw new Error('exact-commit Git tree output is not NUL terminated');
    }
    const record = buffer.subarray(offset, recordEnd);
    offset = recordEnd + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('exact-commit Git tree entry is malformed');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) throw new Error('exact-commit Git tree entry is malformed');
    const [mode, type, rawOid] = metadata;
    if (!/^[0-7]{6}$/.test(mode) || !['blob', 'tree', 'commit'].includes(type)) {
      throw new Error('exact-commit Git tree entry metadata is malformed');
    }
    const oid = exactGitObjectOid(rawOid, objectFormat, 'exact-commit Git tree entry object id');
    const repoPath = strictGitRelativePath(
      decodeExactGitPath(record.subarray(tab + 1), 'tree path'),
      'exact-commit Git tree path',
    );
    entries.push({ mode, type, oid, repoPath });
  }
  return entries;
}

function literalTopLevelGitPathspec(repoPath) {
  return `:(top,literal)${repoPath}`;
}

function exactCommitTreeEntry(repoRoot, commitOid, objectFormat, repoPath) {
  const entries = parseExactCommitTreeEntries(gitObjectBuffer(repoRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    commitOid,
    '--',
    literalTopLevelGitPathspec(repoPath),
  ]), objectFormat);
  const exactEntries = entries.filter((entry) => entry.repoPath === repoPath);
  if (exactEntries.length > 1) {
    throw new Error(`exact-commit Git tree path resolved more than once: ${repoPath}`);
  }
  return exactEntries[0] ?? null;
}

function exactCommitSubtreeEntries(
  repoRoot,
  commitOid,
  objectFormat,
  sourceRootRelativePath,
) {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commitOid];
  if (sourceRootRelativePath !== '.') {
    args.push('--', literalTopLevelGitPathspec(sourceRootRelativePath));
  }
  return parseExactCommitTreeEntries(gitObjectBuffer(repoRoot, args), objectFormat);
}

function decodeExactCommitTextBlob(bytes, selectedPath) {
  if (bytes.includes(0)) {
    throw new Error(`exact-commit Git blob is binary: ${selectedPath}`);
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`exact-commit Git blob is not valid UTF-8: ${selectedPath}`);
  }
  if (
    !Buffer.from(content, 'utf8').equals(bytes)
    || [...content].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(codePoint);
    })
  ) {
    throw new Error(`exact-commit Git blob is binary: ${selectedPath}`);
  }
  return content;
}

function exactCommitRepoPath(sourceRootRelativePath, selectedPath) {
  return sourceRootRelativePath === '.'
    ? selectedPath
    : `${sourceRootRelativePath}/${selectedPath}`;
}

function exactCommitPathFromRepo(sourceRootRelativePath, repoPath) {
  if (sourceRootRelativePath === '.') {
    return strictGitRelativePath(repoPath, 'exact-commit Git repository path');
  }
  const prefix = `${sourceRootRelativePath}/`;
  if (!repoPath.startsWith(prefix)) {
    throw new Error(
      `exact-commit Git path is outside the selected source root: ${repoPath}`,
    );
  }
  return strictGitRelativePath(
    repoPath.slice(prefix.length),
    'exact-commit Git subtree path',
  );
}

function preexistingSynthiArtifact(sourceRoot) {
  const vcsControlDirectories = new Set(['.git', '.hg', '.svn']);
  const walk = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (isSynthiArtifactPath(relativePath)) return relativePath;
      if (
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && !vcsControlDirectories.has(entry.name.toLowerCase())
      ) {
        const nested = walk(path.join(directory, entry.name), relativePath);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(sourceRoot);
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
  if (
    isSynthiArtifactPath(sourceRootRelativePath)
    || path.resolve(sourceRootReal).split(path.sep).some((segment) =>
      segment.toLowerCase() === '.synthi'
      || segment.toLowerCase() === '.synthi_split_meta.json'
    )
  ) {
    throw new Error('direct source root is inside a preexisting Synthi artifact namespace');
  }
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
  const committedSynthiArtifact = [...committedEntries.keys()]
    .map((repoPath) => sourcePathFromRepo(sourceRootRelativePath, repoPath))
    .find(isSynthiArtifactPath);
  if (committedSynthiArtifact) {
    throw new Error(
      `direct source cold path contains committed Synthi artifact: ${committedSynthiArtifact}`,
    );
  }
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

// This object-only API is intentionally separate from the clean-HEAD contract above.
export function materializeExactCommitGitBlobSnapshot(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('exact-commit Git blob snapshot requires an object request');
  }
  assertNoExactCommitAuthorityClaims(request, 'materialization request');
  assertNoSuppliedExactCommitArtifacts(request);
  assertExactCommitRequestFields(request);

  const {
    repositoryRoot,
    commitOid,
    sourceRootRelativePath: rawSourceRootRelativePath = '.',
    sourcePaths = [],
    buildPaths = [],
    expectedPathSetHash = '',
    expectedManifestHash = '',
  } = request;
  const requestedCommitOid = fullCommitOid(commitOid, 'exact-commit Git source commit');
  const sourceRootRelativePath = strictGitRelativePath(
    rawSourceRootRelativePath,
    'exact-commit Git source root',
    { allowRepositoryRoot: true },
  );
  if (isSynthiArtifactPath(sourceRootRelativePath)) {
    throw new Error(
      'exact-commit Git blob snapshot source root is inside a Synthi artifact namespace',
    );
  }
  const selections = normalizedExactCommitSelections(sourcePaths, buildPaths);
  const declaredPathSetHash = optionalExpectedContentHash(
    expectedPathSetHash,
    'expectedPathSetHash',
  );
  const declaredManifestHash = optionalExpectedContentHash(
    expectedManifestHash,
    'expectedManifestHash',
  );

  const repoRoot = exactCommitRepositoryRoot(repositoryRoot);
  const objectFormat = exactGitObjectFormat(repoRoot, requestedCommitOid);
  const commitType = gitObjectText(repoRoot, [
    'cat-file',
    '-t',
    requestedCommitOid,
  ], { allowFailure: true });
  if (commitType !== 'commit') {
    throw new Error(
      `exact-commit Git source commit does not resolve to a commit object: ${requestedCommitOid}`,
    );
  }
  const resolvedCommitOid = exactGitObjectOid(gitObjectText(repoRoot, [
    'rev-parse',
    '--verify',
    `${requestedCommitOid}^{commit}`,
  ]), objectFormat, 'resolved exact-commit Git source commit');
  if (resolvedCommitOid !== requestedCommitOid) {
    throw new Error(
      `exact-commit Git commit mismatch: requested ${requestedCommitOid} resolved ${resolvedCommitOid}`,
    );
  }

  const rootTreeOid = exactGitObjectOid(gitObjectText(repoRoot, [
    'rev-parse',
    '--verify',
    `${resolvedCommitOid}^{tree}`,
  ]), objectFormat, 'exact-commit Git root tree object id');
  let sourceTreeOid = rootTreeOid;
  if (sourceRootRelativePath !== '.') {
    const sourceRootEntry = exactCommitTreeEntry(
      repoRoot,
      resolvedCommitOid,
      objectFormat,
      sourceRootRelativePath,
    );
    if (!sourceRootEntry) {
      throw new Error(
        `exact-commit Git source root is missing from commit: ${sourceRootRelativePath}`,
      );
    }
    if (sourceRootEntry.type !== 'tree') {
      throw new Error(
        `exact-commit Git source root does not resolve to a tree: ${sourceRootRelativePath}`,
      );
    }
    sourceTreeOid = sourceRootEntry.oid;
  }

  const committedSubtreeEntries = exactCommitSubtreeEntries(
    repoRoot,
    resolvedCommitOid,
    objectFormat,
    sourceRootRelativePath,
  );
  const committedSynthiArtifact = committedSubtreeEntries
    .map((entry) => exactCommitPathFromRepo(sourceRootRelativePath, entry.repoPath))
    .find(isSynthiArtifactPath);
  if (committedSynthiArtifact) {
    throw new Error(
      `exact-commit Git source root contains a Synthi artifact namespace: ${committedSynthiArtifact}`,
    );
  }

  const files = selections.map((selection) => {
    const repoPath = exactCommitRepoPath(sourceRootRelativePath, selection.path);
    const entry = exactCommitTreeEntry(
      repoRoot,
      resolvedCommitOid,
      objectFormat,
      repoPath,
    );
    if (!entry) {
      throw new Error(`exact-commit Git selected path is missing from commit: ${repoPath}`);
    }
    if (entry.type !== 'blob') {
      throw new Error(`exact-commit Git selected path is not a blob: ${repoPath}`);
    }
    if (!['100644', '100755'].includes(entry.mode)) {
      throw new Error(`exact-commit Git selected path is not a regular file blob: ${repoPath}`);
    }
    const committedPath = exactCommitPathFromRepo(sourceRootRelativePath, entry.repoPath);
    if (committedPath !== selection.path) {
      throw new Error(
        `exact-commit Git path mismatch: selected ${selection.path} resolved ${committedPath}`,
      );
    }
    const bytes = gitObjectBuffer(repoRoot, ['cat-file', 'blob', entry.oid]);
    const inline = decodeExactCommitTextBlob(bytes, selection.path);
    const fileContentHash = `sha256:${sha256Hex(bytes)}`;
    return {
      kind: selection.kind,
      path: selection.path,
      repositoryPath: repoPath,
      repository_path: repoPath,
      inline,
      contentHash: fileContentHash,
      content_hash: fileContentHash,
      byteLength: bytes.length,
      byte_length: bytes.length,
      gitBlobOid: entry.oid,
      git_blob_oid: entry.oid,
      gitMode: entry.mode,
      git_mode: entry.mode,
    };
  });
  const fileManifest = files.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    repositoryPath: entry.repositoryPath,
    gitBlobOid: entry.gitBlobOid,
    gitMode: entry.gitMode,
    contentHash: entry.contentHash,
    byteLength: entry.byteLength,
  }));
  const pathSetHash = contentHash(fileManifest.map((entry) => entry.repositoryPath));
  const manifestHash = contentHash(fileManifest);
  if (declaredPathSetHash && declaredPathSetHash !== pathSetHash) {
    throw new Error(
      `exact-commit Git path-set hash mismatch: declared ${declaredPathSetHash} actual ${pathSetHash}`,
    );
  }
  if (declaredManifestHash && declaredManifestHash !== manifestHash) {
    throw new Error(
      `exact-commit Git manifest hash mismatch: declared ${declaredManifestHash} actual ${manifestHash}`,
    );
  }

  const sourceFileCount = fileManifest.filter((entry) => entry.kind === 'source').length;
  const buildFileCount = fileManifest.filter((entry) => entry.kind === 'build').length;
  const repositoryTreeBindingHash = contentHash({
    repositoryRoot: '.',
    rootTreeOid,
    sourceRootRelativePath,
    sourceTreeOid,
  });
  const identitySeed = {
    schemaVersion: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION,
    proofAuthority: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY,
    supportOnly: true,
    authorityScope: 'source_build_git_blob_snapshot_support_only',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyGpuHmrProof: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    vcs: 'git',
    objectFormat,
    repositoryRoot: '.',
    commitOid: resolvedCommitOid,
    rootTreeOid,
    sourceRootRelativePath,
    sourceTreeOid,
    repositoryTreeBindingHash,
    pathSetHash,
    manifestHash,
    fileManifest,
    selectedFileCount: fileManifest.length,
    sourceFileCount,
    buildFileCount,
    sourceBytesOrigin: 'git_objects_only',
    gitObjectReadsOnly: true,
    headCommitRequired: false,
    worktreeStateInspected: false,
  };
  const identityHash = contentHash(identitySeed);
  const evidenceRef = `exact-commit-git-blob-snapshot:${identityHash}`;
  const identity = {
    schemaVersion: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION,
    schema_version: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION,
    proofAuthority: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY,
    proof_authority: EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY,
    accepted: true,
    acceptedAsExactCommitGitBlobSnapshot: true,
    accepted_as_exact_commit_git_blob_snapshot: true,
    supportOnly: true,
    support_only: true,
    authorityScope: 'source_build_git_blob_snapshot_support_only',
    authority_scope: 'source_build_git_blob_snapshot_support_only',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyGpuHmrProof: false,
    can_satisfy_gpu_hmr_proof: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    vcs: 'git',
    objectFormat,
    object_format: objectFormat,
    repositoryRoot: '.',
    repository_root: '.',
    commitOid: resolvedCommitOid,
    commit_oid: resolvedCommitOid,
    rootTreeOid,
    root_tree_oid: rootTreeOid,
    sourceRootRelativePath,
    source_root_relative_path: sourceRootRelativePath,
    sourceTreeOid,
    source_tree_oid: sourceTreeOid,
    repositoryTreeBindingHash,
    repository_tree_binding_hash: repositoryTreeBindingHash,
    pathSetHash,
    path_set_hash: pathSetHash,
    manifestHash,
    manifest_hash: manifestHash,
    fileManifest,
    file_manifest: fileManifest,
    selectedFileCount: fileManifest.length,
    selected_file_count: fileManifest.length,
    sourceFileCount,
    source_file_count: sourceFileCount,
    buildFileCount,
    build_file_count: buildFileCount,
    sourceBytesOrigin: 'git_objects_only',
    source_bytes_origin: 'git_objects_only',
    gitObjectReadsOnly: true,
    git_object_reads_only: true,
    headCommitRequired: false,
    head_commit_required: false,
    worktreeStateInspected: false,
    worktree_state_inspected: false,
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
    pathSetHash,
    path_set_hash: pathSetHash,
    manifestHash,
    manifest_hash: manifestHash,
  };
}

export function inspectExactCommitGitBlobIdentity(request = {}) {
  return materializeExactCommitGitBlobSnapshot(request).identity;
}

function assertExactCommitGitBlobIdentityMatches(declaredIdentity, actualIdentity) {
  if (!declaredIdentity || typeof declaredIdentity !== 'object' || Array.isArray(declaredIdentity)) {
    throw new Error('exact-commit Git blob snapshot verification requires declaredIdentity');
  }
  assertNoExactCommitAuthorityClaims(
    declaredIdentity,
    'declared identity',
    { allowSupportIdentity: true },
  );
  const fields = [
    'schemaVersion',
    'proofAuthority',
    'accepted',
    'acceptedAsExactCommitGitBlobSnapshot',
    'supportOnly',
    'authorityScope',
    'acceptedForGpuHmr',
    'gpuHmrSuccess',
    'canSatisfyGpuHmrProof',
    'canSatisfyRuntimeProof',
    'canSatisfyDispatchProof',
    'objectFormat',
    'repositoryRoot',
    'commitOid',
    'rootTreeOid',
    'sourceRootRelativePath',
    'sourceTreeOid',
    'repositoryTreeBindingHash',
    'pathSetHash',
    'manifestHash',
    'fileManifest',
    'selectedFileCount',
    'sourceFileCount',
    'buildFileCount',
    'sourceBytesOrigin',
    'gitObjectReadsOnly',
    'headCommitRequired',
    'worktreeStateInspected',
    'identityHash',
    'evidenceRef',
  ];
  for (const field of fields) {
    if (stableJson(declaredIdentity[field]) !== stableJson(actualIdentity[field])) {
      throw new Error(`exact-commit Git blob identity mismatch for ${field}`);
    }
  }
  if (stableJson(declaredIdentity) !== stableJson(actualIdentity)) {
    throw new Error('exact-commit Git blob identity contains undeclared or mismatched fields');
  }
}

export function verifyExactCommitGitBlobIdentity({
  declaredIdentity,
  ...request
} = {}) {
  const actual = inspectExactCommitGitBlobIdentity(request);
  assertExactCommitGitBlobIdentityMatches(declaredIdentity, actual);
  return actual;
}
