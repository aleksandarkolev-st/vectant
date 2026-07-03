'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const repoCache = require('../repoCache');
const activityRegistry = require('../codesiteActivityRegistry');
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

function withControlPlaneActiveList(workspaceSlug, activeTransactions, fn) {
  const previousBaseUrl = process.env.SYNTHI_CODESITE_API_BASE_URL;
  const previousFetch = global.fetch;
  const calls = [];
  process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://codesite.test/api/workspace/{workspace_slug}/codesite';
  global.fetch = async (url) => {
    calls.push(String(url));
    assert.equal(
      String(url),
      `http://codesite.test/api/workspace/${encodeURIComponent(workspaceSlug)}/codesite/transactions/active`,
    );
    return new Response(JSON.stringify({ activeTransactions }), { status: 200 });
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      if (previousBaseUrl === undefined) {
        delete process.env.SYNTHI_CODESITE_API_BASE_URL;
      } else {
        process.env.SYNTHI_CODESITE_API_BASE_URL = previousBaseUrl;
      }
      global.fetch = previousFetch;
    });
}

test('active CodeSite workspace prep fails before real repo materialization', async () => {
  activityRegistry.resetRegistry();
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
    await withControlPlaneActiveList('codesite-prep-proof', [{
      id: 'txn-prep',
      mutationLeaseId: 'lease-prep',
      agentSessionId: 'agent-prep',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
    }], async () => {
      await assert.rejects(
        () => workspacePrepManager.ensureWorkspacePrepared('codesite-prep-proof', 'user-1', {
          trigger: 'workspace_prepare_api',
          codesiteContext: {
            active: true,
            transactionId: 'txn-prep',
            mutationLeaseId: 'lease-prep',
            agentSessionId: 'agent-prep',
            actorUserId: 'user-1',
            effectiveUserId: 'user-1',
          },
        }),
        (error) => error.code === 'CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION' && error.status === 409,
      );
    });
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('workspace prep reads active transaction authority before repo materialization', async () => {
  activityRegistry.resetRegistry();
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
    await withControlPlaneActiveList('codesite-prep-control-plane-proof', [{
      id: 'txn-prep-control',
      transactionId: 'txn-prep-control',
      mutationLeaseId: 'lease-prep-control',
      agentSessionId: 'agent-prep-control',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
    }], async (authorityCalls) => {
      await assert.rejects(
        () => workspacePrepManager.ensureWorkspacePrepared('codesite-prep-control-plane-proof', 'user-1', {
          trigger: 'workspace_load',
        }),
        (error) => (
          error.code === 'CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION'
          && error.status === 409
          && error.details.activeTransactions[0].transactionId === 'txn-prep-control'
          && error.details.activeTransactions[0].authoritative === true
        ),
      );
      assert.deepEqual(authorityCalls, [
        'http://codesite.test/api/workspace/codesite-prep-control-plane-proof/codesite/transactions/active',
      ]);
    });
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('workspace prep fails before repo materialization when registry has active transaction', async () => {
  activityRegistry.resetRegistry();
  activityRegistry.markTransactionActive({
    workspaceSlug: 'codesite-prep-registry-proof',
    transactionId: 'txn-prep-registry',
    mutationLeaseId: 'lease-prep-registry',
    actorUserId: 'user-1',
    effectiveUserId: 'user-1',
  });
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
      () => workspacePrepManager.ensureWorkspacePrepared('codesite-prep-registry-proof', 'user-1', {
        trigger: 'workspace_load',
      }),
      (error) => (
        error.code === 'CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION'
        && error.status === 503
        && error.details.reason === 'active_authority_unavailable'
        && error.details.authorityError === 'CODESITE_ACTIVITY_CONTROL_PLANE_UNAVAILABLE'
        && error.details.activeTransactions[0].transactionId === 'txn-prep-registry'
      ),
    );
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});
