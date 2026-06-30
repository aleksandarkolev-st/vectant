'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  codeSiteGitActionAttempts,
  shouldRunCodeSiteGitBoundary,
} = require('../codesiteGitPolicy');

test('maps path-scoped index actions to git_index attempts', () => {
  assert.deepEqual(codeSiteGitActionAttempts('stage', { filePath: 'src/app.js' }), [{
    path: 'src/app.js',
    kind: 'stage',
    tool: 'git_index',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('unstage-lines', { filePath: 'src/app.js' }), [{
    path: 'src/app.js',
    kind: 'unstage-lines',
    tool: 'git_index',
  }]);
});

test('maps repo-wide worktree actions to broad git_worktree attempts', () => {
  for (const action of [
    'abort-merge',
    'init',
    'clone',
    'checkout',
    'discard-all',
    'pull',
    'merge-branch',
    'stash-push',
    'stash-pop',
    'stash-apply',
    'interactive-rebase',
    'rebase-abort',
    'rebase-continue',
    'cherry-pick',
    'revert',
  ]) {
    assert.deepEqual(codeSiteGitActionAttempts(action), [{
      path: '**',
      kind: action,
      tool: 'git_worktree',
    }]);
  }
});

test('maps path-scoped worktree actions to git_worktree attempts', () => {
  for (const action of [
    'discard',
    'discard-lines',
    'mark-resolved',
    'resolve-ours',
    'resolve-theirs',
  ]) {
    assert.deepEqual(codeSiteGitActionAttempts(action, { filePath: 'src/app.js' }), [{
      path: 'src/app.js',
      kind: action,
      tool: 'git_worktree',
    }]);
  }
});

test('marks git actions whose callbacks run through the CodeSiteFS boundary', () => {
  for (const action of [
    'abort-merge',
    'add-remote',
    'check-merge-conflicts',
    'checkout',
    'cherry-pick',
    'commit',
    'create-tag',
    'delete-tag',
    'discard',
    'discard-all',
    'discard-lines',
    'fetch',
    'interactive-rebase',
    'mark-resolved',
    'merge-branch',
    'pull',
    'push',
    'push-tag',
    'rebase-abort',
    'rebase-continue',
    'remove-remote',
    'resolve-ours',
    'resolve-theirs',
    'revert',
    'set-remote-url',
    'stage',
    'stage-all',
    'stage-lines',
    'stash-apply',
    'stash-drop',
    'stash-pop',
    'stash-push',
    'unstage',
    'unstage-all',
    'unstage-lines',
  ]) {
    assert.equal(shouldRunCodeSiteGitBoundary(action), true, action);
  }

  for (const action of [
    'init',
    'clone',
    'status',
  ]) {
    assert.equal(shouldRunCodeSiteGitBoundary(action), false, action);
  }
});

test('maps tags, stash refs, and remotes to ref/config attempts', () => {
  assert.deepEqual(codeSiteGitActionAttempts('commit'), [{
    path: '**',
    kind: 'commit',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('fetch'), [{
    path: '**',
    kind: 'fetch',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('check-merge-conflicts'), [{
    path: '**',
    kind: 'check-merge-conflicts',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('push'), [{
    path: '**',
    kind: 'push',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('create-tag'), [{
    path: '**',
    kind: 'create-tag',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('stash-drop'), [{
    path: '**',
    kind: 'stash-drop',
    tool: 'git_refs',
  }]);
  assert.deepEqual(codeSiteGitActionAttempts('set-remote-url'), [{
    path: '**',
    kind: 'set-remote-url',
    tool: 'git_config',
  }]);
});

test('leaves read-only and already path-gated file actions unmapped', () => {
  assert.deepEqual(codeSiteGitActionAttempts('status'), []);
  assert.deepEqual(codeSiteGitActionAttempts('diff'), []);
  assert.deepEqual(codeSiteGitActionAttempts('write-file'), []);
});
