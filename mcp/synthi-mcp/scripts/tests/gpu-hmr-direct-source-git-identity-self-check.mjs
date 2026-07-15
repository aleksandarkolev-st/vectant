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
  inspectDirectSourceGitIdentity,
  materializeDirectSourceGitSnapshot,
  verifyDirectSourceGitIdentity,
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
  writeFileSync(path.join(root, 'src', 'main.cpp'), '#include "config.h"\nint main(){return 0;}\n');
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

  writeFileSync(path.join(root, 'README.md'), 'second immutable commit\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'advance head']);
  const secondCommit = git(root, ['rev-parse', 'HEAD']);
  expectFailure(() => inspectDirectSourceGitIdentity({
    sourceRoot: root,
    requestedCommit: firstCommit,
    sourceManifestHash,
    sourceFilePaths,
  }), 'Git commit mismatch');

  writeFileSync(path.join(root, 'src', 'main.cpp'), 'int main(){return 1;}\n');
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

  console.log('direct source immutable Git identity self-check passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
