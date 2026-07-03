'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const activityRegistry = require('../codesiteActivityRegistry');
const { codeSiteContextFromRequest } = require('../codesiteFs');

test('CodeSite activity registry tracks and closes writable transactions by workspace', () => {
  activityRegistry.resetRegistry();
  try {
    const record = activityRegistry.markTransactionActive({
      workspaceSlug: 'registry-proof',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
      source: 'unit-test',
    }, { now: 1_000, ttlMs: 10_000 });

    assert.equal(record.workspaceSlug, 'registry-proof');
    assert.equal(record.transactionId, 'txn-1');
    assert.equal(activityRegistry.isWorkspaceActive('registry-proof', { now: 2_000 }), true);
    assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('registry-proof', { now: 2_000 }).map((item) => item.transactionId), ['txn-1']);

    const closed = activityRegistry.markTransactionClosed({
      workspaceSlug: 'registry-proof',
      transactionId: 'txn-1',
      status: 'committed',
      source: 'unit-test',
    }, { now: 3_000 });

    assert.equal(closed.transactionId, 'txn-1');
    assert.equal(closed.status, 'committed');
    assert.equal(activityRegistry.isWorkspaceActive('registry-proof', { now: 4_000 }), false);
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('CodeSite request contexts publish active transaction state to the registry', () => {
  activityRegistry.resetRegistry();
  try {
    const context = codeSiteContextFromRequest({
      headers: {
        'x-codesite-transaction-id': 'txn-context',
        'x-codesite-lease-id': 'lease-context',
        'x-codesite-agent-session-id': 'agent-context',
        'x-user-id': 'user-1',
      },
    }, {}, {
      workspaceSlug: 'registry-context-proof',
      effectiveUserId: 'user-1',
    });

    assert.equal(context.active, true);
    assert.equal(context.workspaceSlug, 'registry-context-proof');
    assert.deepEqual(
      activityRegistry.activeTransactionsForWorkspace('registry-context-proof').map((item) => ({
        transactionId: item.transactionId,
        mutationLeaseId: item.mutationLeaseId,
        agentSessionId: item.agentSessionId,
        actorUserId: item.actorUserId,
      })),
      [{
        transactionId: 'txn-context',
        mutationLeaseId: 'lease-context',
        agentSessionId: 'agent-context',
        actorUserId: 'user-1',
      }],
    );
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('blocked landing attempts remain active until an explicit close event', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'registry-blocked-proof',
      transactionId: 'txn-blocked',
      status: 'blocked',
    }, { now: 10_000, ttlMs: 60_000 });

    assert.equal(activityRegistry.isWorkspaceActive('registry-blocked-proof', { now: 11_000 }), true);
    assert.equal(activityRegistry.activeTransactionsForWorkspace('registry-blocked-proof', { now: 11_000 })[0].status, 'blocked');

    activityRegistry.markTransactionClosed({
      workspaceSlug: 'registry-blocked-proof',
      transactionId: 'txn-blocked',
      status: 'aborted',
    }, { now: 12_000 });

    assert.equal(activityRegistry.isWorkspaceActive('registry-blocked-proof', { now: 13_000 }), false);
  } finally {
    activityRegistry.resetRegistry();
  }
});
