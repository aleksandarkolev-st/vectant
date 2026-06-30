'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { codeSiteGitActionAttempts } = require('../codesiteGitPolicy');

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
    'init',
    'clone',
    'checkout',
    'pull',
    'merge-branch',
    'stash-pop',
    'stash-apply',
    'interactive-rebase',
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

test('maps tags, stash refs, and remotes to ref/config attempts', () => {
  assert.deepEqual(codeSiteGitActionAttempts('commit'), [{
    path: '**',
    kind: 'commit',
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
