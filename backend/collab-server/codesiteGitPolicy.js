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
  'discard',
  'discard-lines',
  'mark-resolved',
  'resolve-ours',
  'resolve-theirs',
]);

const REPO_WORKTREE_ACTIONS = new Set([
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
]);

const GIT_REF_ACTIONS = new Set([
  'check-merge-conflicts',
  'commit',
  'fetch',
  'push',
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

const CODE_SITE_GIT_BOUNDARY_ACTIONS = new Set([
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

function shouldRunCodeSiteGitBoundary(action) {
  return CODE_SITE_GIT_BOUNDARY_ACTIONS.has(String(action || ''));
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
  shouldRunCodeSiteGitBoundary,
};
