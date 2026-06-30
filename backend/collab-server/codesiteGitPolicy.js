'use strict';

const PATH_SCOPED_INDEX_ACTIONS = new Set([
  'stage',
  'stage-lines',
  'unstage',
  'unstage-lines',
]);

const REPO_INDEX_ACTIONS = new Set([
  'stage-all',
  'unstage-all',
]);

const PATH_SCOPED_WORKTREE_ACTIONS = new Set([
  'discard-lines',
]);

const REPO_WORKTREE_ACTIONS = new Set([
  'checkout',
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
]);

const GIT_REF_ACTIONS = new Set([
  'create-tag',
  'delete-tag',
  'push-tag',
  'stash-drop',
]);

const GIT_CONFIG_ACTIONS = new Set([
  'add-remote',
  'remove-remote',
  'set-remote-url',
]);

function codeSiteGitActionAttempts(action, data = {}) {
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction) return [];

  if (PATH_SCOPED_INDEX_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, data.filePath || '**', 'git_index')];
  }
  if (REPO_INDEX_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, '**', 'git_index')];
  }
  if (PATH_SCOPED_WORKTREE_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, data.filePath || '**', 'git_worktree')];
  }
  if (REPO_WORKTREE_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, '**', 'git_worktree')];
  }
  if (GIT_REF_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, '**', 'git_refs')];
  }
  if (GIT_CONFIG_ACTIONS.has(normalizedAction)) {
    return [gitAttempt(normalizedAction, '**', 'git_config')];
  }
  return [];
}

function gitAttempt(kind, targetPath, tool) {
  return {
    path: targetPath,
    kind,
    tool,
  };
}

module.exports = {
  codeSiteGitActionAttempts,
};
