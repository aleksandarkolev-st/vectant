'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gitService = require('../gitService');
const activityRegistry = require('../codesiteActivityRegistry');
const {
  ensureRuntimeFilesystem,
  releaseRuntimeFilesystem,
  setWorkspaceInstructionProjectionRuntimeForTests,
} = require('../runtimeFilesystem');

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

test('active CodeSite runtime filesystem refuses real repo provisioning before overlay launch', async () => {
  activityRegistry.resetRegistry();
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
    await withControlPlaneActiveList('runtime-codesite-proof', [{
      id: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
    }], async () => {
      await assert.rejects(
        () => ensureRuntimeFilesystem({
          workspaceSlug: 'runtime-codesite-proof',
          filesystemUserId: 'user-1',
          reason: 'interactive_terminal',
          codesiteContext: {
            active: true,
            transactionId: 'txn-1',
            mutationLeaseId: 'lease-1',
            agentSessionId: 'agent-1',
            actorUserId: 'user-1',
            effectiveUserId: 'user-1',
          },
        }),
        (error) => error.code === 'CODESITE_RUNTIME_FILESYSTEM_PROVISIONING_REQUIRED',
      );
    });
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('active CodeSite runtime filesystem reuses an already initialized repo without hydrating', async () => {
  activityRegistry.resetRegistry();
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
    await withControlPlaneActiveList('runtime-codesite-ready', [{
      id: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
    }], async () => {
      const result = await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-codesite-ready',
        filesystemUserId: 'user-1',
        reason: 'program_runtime_hybrid',
        codesiteContext: {
          active: true,
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'agent-1',
          actorUserId: 'user-1',
          effectiveUserId: 'user-1',
        },
      });
      assert.equal(result.path, '/tmp/runtime-codesite-ready/user-1');
      assert.equal(result.created, false);
      assert.equal(result.reusedExisting, true);
      assert.equal(result.codeSiteProvisioningSkipped, true);
    });
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('runtime filesystem blocks legacy hydration when workspace has a recorded active CodeSite transaction', async () => {
  activityRegistry.resetRegistry();
  activityRegistry.markTransactionActive({
    workspaceSlug: 'runtime-registry-guard',
    transactionId: 'txn-registry',
    mutationLeaseId: 'lease-registry',
    actorUserId: 'user-1',
    effectiveUserId: 'user-1',
  });
  const calls = [];
  const restore = patchGitService({
    initRepo: async (...args) => {
      calls.push(['initRepo', ...args]);
      return { success: true };
    },
    ensureUserRepo: async (...args) => {
      calls.push(['ensureUserRepo', ...args]);
      return { path: '/tmp/should-not-run', created: true };
    },
    getEffectiveRepoPath: (slug, userId) => `/tmp/${slug}/${userId || ''}`,
  });
  try {
    await assert.rejects(
      () => ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-registry-guard',
        filesystemUserId: 'user-1',
        reason: 'ordinary_runtime',
      }),
      (error) => (
        error.code === 'CODESITE_RUNTIME_FILESYSTEM_ACTIVE_TRANSACTION'
        && error.status === 503
        && error.details.reason === 'active_authority_unavailable'
        && error.details.authorityError === 'CODESITE_ACTIVITY_CONTROL_PLANE_UNAVAILABLE'
        && error.details.activeTransactions[0].transactionId === 'txn-registry'
      ),
    );
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('runtime filesystem reads active transaction authority before legacy hydration', async () => {
  activityRegistry.resetRegistry();
  const calls = [];
  const restore = patchGitService({
    initRepo: async (...args) => {
      calls.push(['initRepo', ...args]);
      return { success: true };
    },
    ensureUserRepo: async (...args) => {
      calls.push(['ensureUserRepo', ...args]);
      return { path: '/tmp/should-not-run', created: true };
    },
    getEffectiveRepoPath: (slug, userId) => `/tmp/${slug}/${userId || ''}`,
  });
  try {
    await withControlPlaneActiveList('runtime-control-plane-guard', [{
      id: 'txn-runtime-control',
      transactionId: 'txn-runtime-control',
      mutationLeaseId: 'lease-runtime-control',
      agentSessionId: 'agent-runtime-control',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
    }], async (authorityCalls) => {
      await assert.rejects(
        () => ensureRuntimeFilesystem({
          workspaceSlug: 'runtime-control-plane-guard',
          filesystemUserId: 'user-1',
          reason: 'ordinary_runtime',
        }),
        (error) => (
          error.code === 'CODESITE_RUNTIME_FILESYSTEM_ACTIVE_TRANSACTION'
          && error.status === 409
          && error.details.activeTransactions[0].transactionId === 'txn-runtime-control'
          && error.details.activeTransactions[0].authoritative === true
        ),
      );
      assert.deepEqual(authorityCalls, [
        'http://codesite.test/api/workspace/runtime-control-plane-guard/codesite/transactions/active',
      ]);
    });
    assert.deepEqual(calls, []);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('inactive runtime filesystem keeps legacy hydration behavior', async () => {
  activityRegistry.resetRegistry();
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
    await withControlPlaneActiveList('runtime-legacy', [], async () => {
      const result = await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-legacy',
        filesystemUserId: 'user-1',
        reason: 'ordinary_runtime',
      });
      assert.equal(result.path, '/tmp/runtime-legacy/user-1');
      assert.equal(result.created, true);
    });
    assert.deepEqual(calls, [
      ['initRepo', 'runtime-legacy', null, 'user-1'],
      ['ensureUserRepo', 'runtime-legacy', 'user-1'],
    ]);
  } finally {
    activityRegistry.resetRegistry();
    restore();
  }
});

test('terminal/runtime hydration reconciles passive instructions only after the effective checkout exists', async () => {
  activityRegistry.resetRegistry();
  const calls = [];
  const restoreProjectionRuntime = setWorkspaceInstructionProjectionRuntimeForTests({
    reconcile: async (input) => {
      calls.push(input);
      return { skipped: false, projections: [{ path: 'AGENTS.md', ownership: 'synthetic-only' }] };
    },
    cleanup: async () => ({ skipped: true }),
  });
  const restore = patchGitService({
    initRepo: async () => ({ success: true }),
    ensureUserRepo: async () => ({ path: '/tmp/runtime-projection/user-1', created: true }),
  });
  try {
    await withControlPlaneActiveList('runtime-projection', [], async () => {
      const result = await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-projection',
        filesystemUserId: 'user-1',
        runtimeScope: 'projection-terminal',
        pin: true,
        reason: 'interactive_terminal',
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        workspaceId: 'runtime-projection',
        repositoryRoot: '/tmp/runtime-projection/user-1',
      });
      assert.deepEqual(result.instructionProjection.projections, [{ path: 'AGENTS.md', ownership: 'synthetic-only' }]);
      assert.equal(Object.hasOwn(result.instructionProjection, 'canonicalBlock'), false);
    });
  } finally {
    await releaseRuntimeFilesystem('projection-terminal');
    restoreProjectionRuntime();
    activityRegistry.resetRegistry();
    restore();
  }
});

test('terminal/runtime hydration carries the exact nested opened directory through projection and cleanup', async () => {
  activityRegistry.resetRegistry();
  const reconciliations = [];
  const cleanupCalls = [];
  const workspaceRoot = '/tmp/runtime-nested/user-1';
  const activeWorkspacePath = 'packages/backend';
  const restoreProjectionRuntime = setWorkspaceInstructionProjectionRuntimeForTests({
    reconcile: async (input) => {
      reconciliations.push(input);
      return {
        skipped: false,
        activeWorkspaceRoot: `${workspaceRoot}/packages/backend`,
        activeWorkspacePath,
        projections: [{ path: 'AGENTS.md', ownership: 'synthetic-only' }],
      };
    },
    cleanup: async (input) => {
      cleanupCalls.push(input);
      return { skipped: false, projections: [] };
    },
  });
  const restore = patchGitService({
    initRepo: async () => ({ success: true }),
    ensureUserRepo: async () => ({ path: workspaceRoot, created: true }),
    getEffectiveRepoPath: () => workspaceRoot,
  });
  try {
    await withControlPlaneActiveList('runtime-nested', [], async () => {
      const result = await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-nested',
        filesystemUserId: 'user-1',
        activeWorkspacePath,
        runtimeScope: 'terminal:nested-root',
        pin: true,
        reason: 'interactive_terminal',
      });
      assert.equal(result.activeWorkspaceRoot, `${workspaceRoot}/packages/backend`);
      assert.equal(result.activeWorkspacePath, activeWorkspacePath);
      assert.deepEqual(reconciliations, [{
        workspaceId: 'runtime-nested',
        repositoryRoot: workspaceRoot,
        activeWorkspacePath,
      }]);

      const release = await releaseRuntimeFilesystem('terminal:nested-root');
      assert.equal(release.skipped, false);
      assert.deepEqual(cleanupCalls, [{
        workspaceId: 'runtime-nested',
        repositoryRoot: workspaceRoot,
        activeWorkspacePath,
      }]);
    });
  } finally {
    await releaseRuntimeFilesystem('terminal:nested-root');
    restoreProjectionRuntime();
    activityRegistry.resetRegistry();
    restore();
  }
});

test('last terminal release cleans passive instruction projections after all sessions close', async () => {
  activityRegistry.resetRegistry();
  const cleanupCalls = [];
  const restoreProjectionRuntime = setWorkspaceInstructionProjectionRuntimeForTests({
    reconcile: async () => ({ skipped: false, projections: [] }),
    cleanup: async (input) => {
      cleanupCalls.push(input);
      return { skipped: false, removed: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] };
    },
  });
  const restore = patchGitService({
    initRepo: async () => ({ success: true }),
    ensureUserRepo: async () => ({ path: '/tmp/runtime-cleanup/user-1', created: true }),
    getEffectiveRepoPath: (slug, userId) => `/tmp/${slug}/${userId || ''}`,
  });
  try {
    await withControlPlaneActiveList('runtime-cleanup', [], async () => {
      await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-cleanup',
        filesystemUserId: 'user-1',
        runtimeScope: 'terminal:cleanup-one',
        pin: true,
        reason: 'interactive_terminal',
      });
      await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-cleanup',
        filesystemUserId: 'user-1',
        runtimeScope: 'terminal:cleanup-two',
        pin: true,
        reason: 'interactive_terminal',
      });

      const firstRelease = await releaseRuntimeFilesystem('terminal:cleanup-one');
      assert.deepEqual(firstRelease, { skipped: true, reason: 'workspace_runtime_still_pinned' });
      assert.deepEqual(cleanupCalls, []);

      const lastRelease = await releaseRuntimeFilesystem('terminal:cleanup-two');
      assert.deepEqual(lastRelease, {
        skipped: false,
        removed: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
      });
      assert.deepEqual(cleanupCalls, [{
        workspaceId: 'runtime-cleanup',
        repositoryRoot: '/tmp/runtime-cleanup/user-1',
      }]);
    });
  } finally {
    await releaseRuntimeFilesystem('terminal:cleanup-one');
    await releaseRuntimeFilesystem('terminal:cleanup-two');
    restoreProjectionRuntime();
    activityRegistry.resetRegistry();
    restore();
  }
});
