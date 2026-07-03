'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const activityRegistry = require('../codesiteActivityRegistry');
const {
  assertCodeSiteWorkspaceMutationAllowed,
  assertCodeSiteWorkspaceMutationAllowedAsync,
  contextMatchesActiveTransaction,
} = require('../codesiteActiveBoundary');

const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-active-boundary-registry-'));
const previousPersistence = activityRegistry.configurePersistence({
  enabled: true,
  filePath: path.join(registryDir, 'active-transactions.json'),
});

test.after(() => {
  activityRegistry.resetRegistry();
  activityRegistry.configurePersistence(previousPersistence);
  fs.rmSync(registryDir, { recursive: true, force: true });
});

async function withConfiguredCodeSiteBase(fn) {
  const previous = process.env.SYNTHI_CODESITE_API_BASE_URL;
  process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://codesite.test/api/workspace/{workspace_slug}/codesite';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.SYNTHI_CODESITE_API_BASE_URL;
    } else {
      process.env.SYNTHI_CODESITE_API_BASE_URL = previous;
    }
  }
}

test('active workspace boundary rejects contextless real-tree mutations', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-proof',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      source: 'next_codesite_route',
      status: 'open',
    });

    assert.throws(
      () => assertCodeSiteWorkspaceMutationAllowed('active-boundary-proof', {
        active: false,
        workspaceSlug: 'active-boundary-proof',
      }, {
        operation: 'write-file',
        tool: 'file_write',
        attempts: [{ path: 'src/app.js', tool: 'file_write' }],
      }),
      (error) => (
        error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'src/app.js'
        && error.event.details.reason_codes.includes('codesite_active_workspace_context_required')
        && error.event.details.active_transactions[0].transactionId === 'txn-1'
      ),
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('active workspace boundary rejects mismatched transaction context', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-mismatch',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      source: 'next_codesite_route',
      status: 'open',
    });

    assert.throws(
      () => assertCodeSiteWorkspaceMutationAllowed('active-boundary-mismatch', {
        active: true,
        workspaceSlug: 'active-boundary-mismatch',
        transactionId: 'txn-2',
        mutationLeaseId: 'lease-2',
      }, {
        operation: 'rename-item',
        tool: 'file_rename',
        attempts: [{ path: 'src/new.js', tool: 'file_rename' }],
      }),
      (error) => (
        error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_active_workspace_context_mismatch')
      ),
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('active workspace boundary requires the active lease when the lock has one', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-lease-required',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      source: 'next_codesite_route',
      status: 'open',
    });

    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
    }, activityRegistry.activeTransactionsForWorkspace('active-boundary-lease-required')[0]), false);

    assert.throws(
      () => assertCodeSiteWorkspaceMutationAllowed('active-boundary-lease-required', {
        active: true,
        workspaceSlug: 'active-boundary-lease-required',
        transactionId: 'txn-1',
      }, {
        operation: 'write-file',
        tool: 'file_write',
        attempts: [{ path: 'src/app.js', tool: 'file_write' }],
      }),
      (error) => (
        error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_active_workspace_context_mismatch')
      ),
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('active workspace boundary requires matching agent and user identities when present', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-identity-required',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
      source: 'next_codesite_route',
      status: 'open',
    });
    const active = activityRegistry.activeTransactionsForWorkspace('active-boundary-identity-required')[0];

    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
    }, {
      ...active,
      agentSessionId: null,
    }), false);
    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-2',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
    }, active), false);
    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'other-owner',
    }, active), false);
    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
    }, active), true);

    assert.throws(
      () => assertCodeSiteWorkspaceMutationAllowed('active-boundary-identity-required', {
        active: true,
        workspaceSlug: 'active-boundary-identity-required',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        actorUserId: 'actor-2',
        effectiveUserId: 'owner-1',
      }, {
        operation: 'write-file',
        tool: 'file_write',
        attempts: [{ path: 'src/app.js', tool: 'file_write' }],
      }),
      (error) => (
        error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_active_workspace_context_mismatch')
        && error.event.details.active_transactions[0].agentSessionId === 'agent-1'
      ),
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('active workspace boundary allows matching transaction context', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-match',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
      source: 'next_codesite_route',
      status: 'open',
    });

    const active = assertCodeSiteWorkspaceMutationAllowed('active-boundary-match', {
      active: true,
      workspaceSlug: 'active-boundary-match',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
    }, {
      operation: 'write-file',
      tool: 'file_write',
      attempts: [{ path: 'src/app.js', tool: 'file_write' }],
    });

    assert.equal(active.length, 1);
    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
    }, active[0]), true);
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('active workspace boundary does not authorize writes from blocked transactions', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-blocked',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      source: 'next_codesite_route',
      status: 'blocked',
    });

    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
    }, activityRegistry.activeTransactionsForWorkspace('active-boundary-blocked')[0]), false);

    assert.throws(
      () => assertCodeSiteWorkspaceMutationAllowed('active-boundary-blocked', {
        active: true,
        workspaceSlug: 'active-boundary-blocked',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
      }, {
        operation: 'write-file',
        tool: 'file_write',
        attempts: [{ path: 'src/app.js', tool: 'file_write' }],
      }),
      (error) => (
        error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_active_workspace_context_mismatch')
      ),
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('async active workspace boundary refreshes from control-plane before allowing a matching context', async () => {
  activityRegistry.resetRegistry();
  try {
    await withConfiguredCodeSiteBase(async () => {
      const fetch = async (url) => {
        assert.equal(String(url), 'http://codesite.test/api/workspace/active-boundary-control/codesite/transactions/active');
        return new Response(JSON.stringify({
          activeTransactions: [{
            id: 'txn-1',
            mutationLeaseId: 'lease-1',
            agentSessionId: 'agent-1',
            actorUserId: 'actor-1',
            effectiveUserId: 'owner-1',
            status: 'open',
          }],
        }), { status: 200 });
      };

      const active = await assertCodeSiteWorkspaceMutationAllowedAsync('active-boundary-control', {
        active: true,
        workspaceSlug: 'active-boundary-control',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        actorUserId: 'actor-1',
        effectiveUserId: 'owner-1',
        controlPlaneUrl: 'http://codesite.test/api/workspace/active-boundary-control/codesite',
      }, {
        operation: 'write-file',
        tool: 'file_write',
        attempts: [{ path: 'src/app.js', tool: 'file_write' }],
      }, { fetch });

      assert.equal(active.length, 1);
      assert.equal(active[0].source, 'control_plane_active_list');
    });
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('async active workspace boundary fails closed when configured authority is unavailable', async () => {
  activityRegistry.resetRegistry();
  try {
    await withConfiguredCodeSiteBase(async () => {
      await assert.rejects(
        () => assertCodeSiteWorkspaceMutationAllowedAsync('active-boundary-authority-down', {
          active: false,
          workspaceSlug: 'active-boundary-authority-down',
          controlPlaneUrl: 'http://codesite.test/api/workspace/active-boundary-authority-down/codesite',
        }, {
          operation: 'write-file',
          tool: 'file_write',
          attempts: [{ path: 'src/app.js', tool: 'file_write' }],
        }, {
          fetch: async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
        }),
        (error) => (
          error.code === 'CODESITE_WRITE_DENIED'
          && error.status === 503
          && error.event.details.reason_codes.includes('codesite_active_workspace_authority_unavailable')
        ),
      );
    });
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('async active workspace boundary rejects caller-supplied untrusted control-plane URLs before fetch', async () => {
  activityRegistry.resetRegistry();
  try {
    await withConfiguredCodeSiteBase(async () => {
      let fetchCalled = false;
      await assert.rejects(
        () => assertCodeSiteWorkspaceMutationAllowedAsync('active-boundary-untrusted-url', {
          active: true,
          workspaceSlug: 'active-boundary-untrusted-url',
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          controlPlaneUrl: 'http://evil.test/api/workspace/active-boundary-untrusted-url/codesite',
        }, {
          operation: 'write-file',
          tool: 'file_write',
          attempts: [{ path: 'src/app.js', tool: 'file_write' }],
        }, {
          fetch: async () => {
            fetchCalled = true;
            return new Response(JSON.stringify({ activeTransactions: [] }), { status: 200 });
          },
        }),
        (error) => (
          error.code === 'CODESITE_WRITE_DENIED'
          && error.status === 503
          && error.cause?.details?.reason === 'untrusted_control_plane_url'
        ),
      );
      assert.equal(fetchCalled, false);
    });
  } finally {
    activityRegistry.resetRegistry();
  }
});
