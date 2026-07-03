'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const repoCache = require('../repoCache');
const workspacePrepManager = require('../workspacePrepManager');

function patchRepoCache(overrides) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = repoCache[key];
    repoCache[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) {
      repoCache[key] = value;
    }
  };
}

test('active CodeSite workspace prep fails before real repo materialization', async () => {
  const calls = [];
  const restore = patchRepoCache({
    acquire: async (...args) => {
      calls.push(['acquire', ...args]);
      return '/tmp/should-not-materialize';
    },
    release: (...args) => {
      calls.push(['release', ...args]);
    },
  });
  try {
    await assert.rejects(
      () => workspacePrepManager.ensureWorkspacePrepared('codesite-prep-proof', 'user-1', {
        trigger: 'workspace_prepare_api',
        codesiteContext: {
          active: true,
          transactionId: 'txn-prep',
          mutationLeaseId: 'lease-prep',
        },
      }),
      (error) => error.code === 'CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION' && error.status === 409,
    );
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
