'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const activityRegistry = require('../codesiteActivityRegistry');
const {
  assertCodeSiteWorkspaceMutationAllowed,
  contextMatchesActiveTransaction,
} = require('../codesiteActiveBoundary');

test('active workspace boundary rejects contextless real-tree mutations', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-proof',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
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

test('active workspace boundary allows matching transaction context', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'active-boundary-match',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      status: 'open',
    });

    const active = assertCodeSiteWorkspaceMutationAllowed('active-boundary-match', {
      active: true,
      workspaceSlug: 'active-boundary-match',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
    }, {
      operation: 'write-file',
      tool: 'file_write',
      attempts: [{ path: 'src/app.js', tool: 'file_write' }],
    });

    assert.equal(active.length, 1);
    assert.equal(contextMatchesActiveTransaction({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
    }, active[0]), true);
  } finally {
    activityRegistry.resetRegistry();
  }
});
