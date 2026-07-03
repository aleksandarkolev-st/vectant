'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gitService = require('../gitService');
const { ensureRuntimeFilesystem } = require('../runtimeFilesystem');

function patchGitService(overrides) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = gitService[key];
    gitService[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) {
      gitService[key] = value;
    }
  };
}

test('active CodeSite runtime filesystem refuses real repo provisioning before overlay launch', async () => {
  const calls = [];
  const restore = patchGitService({
    isUserRepoInitialized: () => false,
    initRepo: async (...args) => {
      calls.push(['initRepo', ...args]);
      return { success: true };
    },
    ensureUserRepo: async (...args) => {
      calls.push(['ensureUserRepo', ...args]);
      return { path: '/tmp/should-not-run', created: true };
    },
    getEffectiveRepoPath: () => '/tmp/should-not-run',
  });
  try {
    await assert.rejects(
      () => ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-codesite-proof',
        filesystemUserId: 'user-1',
        reason: 'interactive_terminal',
        codesiteContext: {
          active: true,
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
        },
      }),
      (error) => error.code === 'CODESITE_RUNTIME_FILESYSTEM_PROVISIONING_REQUIRED',
    );
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('active CodeSite runtime filesystem reuses an already initialized repo without hydrating', async () => {
  const calls = [];
  const restore = patchGitService({
    isUserRepoInitialized: () => true,
    initRepo: async (...args) => {
      calls.push(['initRepo', ...args]);
      return { success: true };
    },
    ensureUserRepo: async (...args) => {
      calls.push(['ensureUserRepo', ...args]);
      return { path: '/tmp/should-not-run', created: true };
    },
    getEffectiveRepoPath: (slug, userId) => `/tmp/${slug}/${userId}`,
  });
  try {
    const result = await ensureRuntimeFilesystem({
      workspaceSlug: 'runtime-codesite-ready',
      filesystemUserId: 'user-1',
      reason: 'program_runtime_hybrid',
      codesiteContext: {
        active: true,
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
      },
    });
    assert.equal(result.path, '/tmp/runtime-codesite-ready/user-1');
    assert.equal(result.created, false);
    assert.equal(result.reusedExisting, true);
    assert.equal(result.codeSiteProvisioningSkipped, true);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('inactive runtime filesystem keeps legacy hydration behavior', async () => {
  const calls = [];
  const restore = patchGitService({
    initRepo: async (...args) => {
      calls.push(['initRepo', ...args]);
      return { success: true };
    },
    ensureUserRepo: async (...args) => {
      calls.push(['ensureUserRepo', ...args]);
      return { path: '/tmp/runtime-legacy/user-1', created: true };
    },
    getEffectiveRepoPath: (slug, userId) => `/tmp/${slug}/${userId || ''}`,
  });
  try {
    const result = await ensureRuntimeFilesystem({
      workspaceSlug: 'runtime-legacy',
      filesystemUserId: 'user-1',
      reason: 'ordinary_runtime',
    });
    assert.equal(result.path, '/tmp/runtime-legacy/user-1');
    assert.equal(result.created, true);
    assert.deepEqual(calls, [
      ['initRepo', 'runtime-legacy', null, 'user-1'],
      ['ensureUserRepo', 'runtime-legacy', 'user-1'],
    ]);
  } finally {
    restore();
  }
});
