#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY,
  DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION,
  EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY,
  EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION,
  inspectDirectSourceGitIdentity,
  materializeDirectSourceGitSnapshot,
  materializeExactCommitGitBlobSnapshot,
  verifyDirectSourceGitIdentity,
  verifyExactCommitGitBlobIdentity,
} from '../lib/gpu-hmr-direct-source-git-identity.mjs';

function git(root, args) {
  return String(execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
}

function expectFailure(run, expectedMessage) {
  try {
    run();
  } catch (error) {
    if (String(error?.message ?? error).includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`expected failure containing: ${expectedMessage}`);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'synthi-direct-source-git-'));
try {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'include'), { recursive: true });
  const firstSourceContent = '#include "config.h"\nint main(){return 0;}\n';
  const firstBuildContent = 'compile = source\nmode = initial\n';
  writeFileSync(path.join(root, 'src', 'main.cpp'), firstSourceContent);
  writeFileSync(path.join(root, 'src', 'build.plan'), firstBuildContent);
  writeFileSync(path.join(root, 'include', 'config.h'), '#pragma once\nconstexpr int kValue = 7;\n');
  writeFileSync(path.join(root, '.gitignore'), 'src/ignored-generated.h\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'gpu-hmr-self-check@example.invalid']);
  git(root, ['config', 'user.name', 'GPU HMR Self Check']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'immutable source fixture']);

  const firstCommit = git(root, ['rev-parse', 'HEAD']);
  const sourceFilePaths = ['include/config.h', 'src/main.cpp'];
  const snapshot = materializeDirectSourceGitSnapshot({
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceFilePaths,
  });
  const sourceManifestHash = snapshot.manifestHash;
  if (
    snapshot.files.length !== sourceFilePaths.length
    || snapshot.files.some((entry) => typeof entry.inline !== 'string')
    || snapshot.files.some((entry) => !entry.gitBlobOid)
    || snapshot.identity.sourceBlobSetHash !== snapshot.identity.source_blob_set_hash
  ) {
    throw new Error(`pinned Git blob materialization was incomplete: ${JSON.stringify(snapshot)}`);
  }
  const identity = inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash,
    sourceFilePaths,
  });
  if (
    identity.schemaVersion !== DIRECT_SOURCE_GIT_IDENTITY_SCHEMA_VERSION
    || identity.proofAuthority !== DIRECT_SOURCE_GIT_IDENTITY_AUTHORITY
    || identity.commitOid !== firstCommit
    || identity.accepted !== true
    || identity.worktreeClean !== true
    || identity.acceptedForGpuHmr !== false
    || identity.gpuHmrSuccess !== false
    || identity.canSatisfyRuntimeProof !== false
  ) {
    throw new Error(`valid immutable Git identity was not preserved: ${JSON.stringify(identity)}`);
  }
  const verified = verifyDirectSourceGitIdentity({
    declaredIdentity: identity,
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash,
    sourceFilePaths,
  });
  if (verified.identityHash !== identity.identityHash) {
    throw new Error('recomputed immutable Git identity hash changed');
  }

  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash: `sha256:${'0'.repeat(64)}`,
    sourceFilePaths,
  }), 'manifest hash does not match pinned Git blob bytes');

  expectFailure(() => verifyDirectSourceGitIdentity({
    declaredIdentity: {
      ...identity,
      identityHash: `sha256:${'0'.repeat(64)}`,
      identity_hash: `sha256:${'0'.repeat(64)}`,
    },
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'identity mismatch for identityHash');

  const secondBuildContent = 'compile = source\nmode = advanced\n';
  writeFileSync(path.join(root, 'README.md'), 'second immutable commit\n');
  writeFileSync(path.join(root, 'src', 'build.plan'), secondBuildContent);
  git(root, ['add', 'README.md', 'src/build.plan']);
  git(root, ['commit', '-m', 'advance head']);
  const secondCommit = git(root, ['rev-parse', 'HEAD']);
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'Git commit mismatch');

  writeFileSync(path.join(root, 'src', 'main.cpp'), 'int main(){return 1;}\n');

  const exactCommitRequest = {
    repositoryRoot: root,
    commitOid: firstCommit,
    sourceRootRelativePath: 'src',
    sourcePaths: ['main.cpp'],
    buildPaths: ['build.plan'],
    generatedArtifacts: [],
    compileManifestArtifacts: [],
  };
  const exactSnapshot = materializeExactCommitGitBlobSnapshot(exactCommitRequest);
  const exactIdentity = exactSnapshot.identity;
  const exactSource = exactSnapshot.files.find((entry) => entry.kind === 'source');
  const exactBuild = exactSnapshot.files.find((entry) => entry.kind === 'build');
  const firstRootTree = git(root, ['rev-parse', `${firstCommit}^{tree}`]);
  const firstSourceTree = git(root, ['rev-parse', `${firstCommit}:src`]);
  if (
    git(root, ['rev-parse', 'HEAD']) !== secondCommit
    || !git(root, ['status', '--porcelain']).includes('src/main.cpp')
    || exactSource?.inline !== firstSourceContent
    || exactBuild?.inline !== firstBuildContent
    || exactBuild.inline === secondBuildContent
    || exactIdentity.schemaVersion !== EXACT_COMMIT_GIT_BLOB_SNAPSHOT_SCHEMA_VERSION
    || exactIdentity.proofAuthority !== EXACT_COMMIT_GIT_BLOB_SNAPSHOT_AUTHORITY
    || exactIdentity.repositoryRoot !== '.'
    || exactIdentity.commitOid !== firstCommit
    || exactIdentity.rootTreeOid !== firstRootTree
    || exactIdentity.sourceRootRelativePath !== 'src'
    || exactIdentity.sourceTreeOid !== firstSourceTree
    || exactIdentity.pathSetHash !== exactSnapshot.pathSetHash
    || exactIdentity.manifestHash !== exactSnapshot.manifestHash
    || exactIdentity.fileManifest.length !== 2
    || exactIdentity.fileManifest.some((entry) =>
      !entry.path
      || !entry.repositoryPath
      || !entry.gitBlobOid
      || !entry.gitMode
      || !/^sha256:[a-f0-9]{64}$/.test(entry.contentHash)
      || !Number.isSafeInteger(entry.byteLength)
    )
    || exactIdentity.supportOnly !== true
    || exactIdentity.authorityScope !== 'source_build_git_blob_snapshot_support_only'
    || exactIdentity.acceptedForGpuHmr !== false
    || exactIdentity.gpuHmrSuccess !== false
    || exactIdentity.canSatisfyGpuHmrProof !== false
    || exactIdentity.canSatisfyRuntimeProof !== false
    || exactIdentity.canSatisfyDispatchProof !== false
    || exactIdentity.sourceBytesOrigin !== 'git_objects_only'
    || exactIdentity.gitObjectReadsOnly !== true
    || exactIdentity.headCommitRequired !== false
    || exactIdentity.worktreeStateInspected !== false
  ) {
    throw new Error(
      `older exact-commit Git blob snapshot was not object-bound support: ${JSON.stringify(exactSnapshot)}`,
    );
  }

  const exactSnapshotWithExpectedHashes = materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    expectedPathSetHash: exactSnapshot.pathSetHash,
    expectedManifestHash: exactSnapshot.manifestHash,
  });
  if (exactSnapshotWithExpectedHashes.identity.identityHash !== exactIdentity.identityHash) {
    throw new Error('exact-commit Git blob snapshot identity changed with matching expectations');
  }
  const verifiedExactIdentity = verifyExactCommitGitBlobIdentity({
    declaredIdentity: exactIdentity,
    ...exactCommitRequest,
  });
  if (verifiedExactIdentity.identityHash !== exactIdentity.identityHash) {
    throw new Error('recomputed exact-commit Git blob snapshot identity changed');
  }

  const forgedCommitIdentity = structuredClone(exactIdentity);
  forgedCommitIdentity.commitOid = secondCommit;
  forgedCommitIdentity.commit_oid = secondCommit;
  expectFailure(() => verifyExactCommitGitBlobIdentity({
    declaredIdentity: forgedCommitIdentity,
    ...exactCommitRequest,
  }), 'identity mismatch for commitOid');

  const forgedPathIdentity = structuredClone(exactIdentity);
  forgedPathIdentity.fileManifest[0].path = 'forged/path';
  forgedPathIdentity.file_manifest[0].path = 'forged/path';
  expectFailure(() => verifyExactCommitGitBlobIdentity({
    declaredIdentity: forgedPathIdentity,
    ...exactCommitRequest,
  }), 'identity mismatch for fileManifest');

  const forgedHashIdentity = structuredClone(exactIdentity);
  forgedHashIdentity.fileManifest[0].contentHash = `sha256:${'0'.repeat(64)}`;
  forgedHashIdentity.file_manifest[0].contentHash = `sha256:${'0'.repeat(64)}`;
  expectFailure(() => verifyExactCommitGitBlobIdentity({
    declaredIdentity: forgedHashIdentity,
    ...exactCommitRequest,
  }), 'identity mismatch for fileManifest');

  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    expectedPathSetHash: `sha256:${'0'.repeat(64)}`,
  }), 'path-set hash mismatch');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    expectedManifestHash: `sha256:${'0'.repeat(64)}`,
  }), 'manifest hash mismatch');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    commitOid: firstCommit.slice(0, 12),
  }), 'must be a full Git object id');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    sourcePaths: ['missing.source'],
  }), 'selected path is missing from commit');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    sourcePaths: ['../outside.source'],
  }), 'unsafe selected source path');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    sourcePaths: ['/absolute.source'],
  }), 'unsafe selected source path');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    repositoryRoot: path.join(root, 'src'),
  }), 'repository root mismatch');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    buildPaths: ['main.cpp'],
  }), 'duplicate exact-commit Git blob snapshot path');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    generatedArtifacts: [{ path: 'output/generated.unit' }],
  }), 'refuses supplied generated or compile-manifest artifacts');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    compileManifestArtifacts: [{ path: 'output/compile.manifest' }],
  }), 'refuses supplied generated or compile-manifest artifacts');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...exactCommitRequest,
    gpuHmrSuccess: true,
  }), 'rejects GPU HMR, runtime, or dispatch authority claims');

  const forgedRuntimeAuthority = structuredClone(exactIdentity);
  forgedRuntimeAuthority.canSatisfyRuntimeProof = true;
  forgedRuntimeAuthority.can_satisfy_runtime_proof = true;
  expectFailure(() => verifyExactCommitGitBlobIdentity({
    declaredIdentity: forgedRuntimeAuthority,
    ...exactCommitRequest,
  }), 'rejects GPU HMR, runtime, or dispatch authority claims');

  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: secondCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'worktree is dirty');
  git(root, ['restore', '--source=HEAD', '--', 'src/main.cpp']);

  writeFileSync(path.join(root, 'src', 'ignored-generated.h'), '#pragma once\n');
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: secondCommit,
    sourceManifestHash,
    sourceFilePaths: [...sourceFilePaths, 'src/ignored-generated.h'],
  }), 'not present in the immutable commit');
  rmSync(path.join(root, 'src', 'ignored-generated.h'));

  mkdirSync(path.join(root, 'src', 'nested', '.synthi', 'generated', 'gpu'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'nested', '.synthi', 'generated', 'gpu', 'device.hip'),
    'precompiled\n',
  );
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: secondCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'preexisting Synthi artifact');
  rmSync(path.join(root, 'src', 'nested'), { recursive: true, force: true });

  mkdirSync(path.join(root, 'src', 'group'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'group', 'unit.source'), 'plain UTF-8 source\n');
  writeFileSync(path.join(root, 'src', 'binary.asset'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  writeFileSync(path.join(root, 'src', 'invalid-utf8.asset'), Buffer.from([0xc3, 0x28]));
  git(root, ['add', 'src/group/unit.source', 'src/binary.asset', 'src/invalid-utf8.asset']);
  git(root, ['commit', '-m', 'add object type edge cases']);
  const objectEdgeCommit = git(root, ['rev-parse', 'HEAD']);
  const objectEdgeRequest = {
    repositoryRoot: root,
    commitOid: objectEdgeCommit,
    sourceRootRelativePath: 'src',
    sourcePaths: ['main.cpp'],
    buildPaths: [],
  };
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...objectEdgeRequest,
    sourcePaths: ['group'],
  }), 'selected path is not a blob');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...objectEdgeRequest,
    sourcePaths: ['binary.asset'],
  }), 'Git blob is binary');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...objectEdgeRequest,
    sourcePaths: ['invalid-utf8.asset'],
  }), 'Git blob is not valid UTF-8');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...objectEdgeRequest,
    commitOid: '0'.repeat(40),
  }), 'does not resolve to a commit object');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    ...objectEdgeRequest,
    sourceRootRelativePath: 'src/main.cpp',
  }), 'source root does not resolve to a tree');

  mkdirSync(path.join(root, '.synthi', 'project'), { recursive: true });
  writeFileSync(path.join(root, '.synthi', 'project', 'main.cpp'), 'int main(){return 0;}\n');
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: path.join(root, '.synthi', 'project'),
    requestedCommit: secondCommit,
    sourceManifestHash,
    sourceFilePaths: ['main.cpp'],
  }), 'inside a preexisting Synthi artifact namespace');
  rmSync(path.join(root, '.synthi'), { recursive: true, force: true });

  mkdirSync(path.join(root, 'generated'), { recursive: true });
  const committedMarker = path.join(root, 'generated', '.synthi_split_meta.json');
  writeFileSync(committedMarker, '{}\n');
  git(root, ['add', 'generated/.synthi_split_meta.json']);
  git(root, ['commit', '-m', 'commit forbidden Synthi marker']);
  const markerCommit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-index', '--skip-worktree', 'generated/.synthi_split_meta.json']);
  rmSync(committedMarker);
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: markerCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'committed Synthi artifact');
  expectFailure(() => materializeExactCommitGitBlobSnapshot({
    repositoryRoot: root,
    commitOid: markerCommit,
    sourceRootRelativePath: '.',
    sourcePaths: ['src/main.cpp'],
    buildPaths: [],
  }), 'contains a Synthi artifact namespace');

  console.log('direct source immutable and exact-commit Git identity self-check passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
