'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const activityRegistry = require('../codesiteActivityRegistry');
const { codeSiteContextFromRequest } = require('../codesiteFs');

const registryDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codesite-activity-registry-file-'));
const previousPersistence = activityRegistry.configurePersistence({
  enabled: true,
  filePath: path.join(registryDir, 'active-transactions.json'),
});

test.after(async () => {
  activityRegistry.resetRegistry();
  activityRegistry.configurePersistence(previousPersistence);
  await fs.rm(registryDir, { recursive: true, force: true });
});

async function withTempRegistryPersistence(t, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-activity-registry-'));
  const filePath = path.join(dir, 'active-transactions.json');
  const previous = activityRegistry.configurePersistence({ enabled: true, filePath });
  activityRegistry.resetRegistry();
  t.after(async () => {
    activityRegistry.resetRegistry();
    activityRegistry.configurePersistence(previous);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return fn({ dir, filePath });
}

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

async function withCodeSiteOriginEnv(env, fn) {
  const keys = [
    'SYNTHI_CODESITE_API_BASE_URL',
    'CODESITE_API_BASE_URL',
    'SYNTHI_CODESITE_BASE_URL',
    'SYNTHI_APP_INTERNAL_URL',
    'SYNTHI_APP_URL',
    'SYNTHI_PUBLIC_APP_URL',
    'NEXTAUTH_URL',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('CodeSite activity registry tracks and closes writable transactions by workspace', () => {
  activityRegistry.resetRegistry();
  try {
    const now = Date.now();
    const record = activityRegistry.markTransactionActive({
      workspaceSlug: 'registry-proof',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      status: 'open',
      source: 'unit-test',
    }, { now, ttlMs: 10_000 });

    assert.equal(record.workspaceSlug, 'registry-proof');
    assert.equal(record.transactionId, 'txn-1');
    assert.equal(activityRegistry.isWorkspaceActive('registry-proof', { now: now + 1_000 }), true);
    assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('registry-proof', { now: now + 1_000 }).map((item) => item.transactionId), ['txn-1']);

    const closed = activityRegistry.markTransactionClosed({
      workspaceSlug: 'registry-proof',
      transactionId: 'txn-1',
      status: 'committed',
      source: 'unit-test',
    }, { now: now + 2_000 });

    assert.equal(closed.transactionId, 'txn-1');
    assert.equal(closed.status, 'committed');
    assert.equal(activityRegistry.isWorkspaceActive('registry-proof', { now: now + 3_000 }), false);
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('CodeSite activity registry persists active transactions and reloads after memory loss', async (t) => {
  await withTempRegistryPersistence(t, async ({ filePath }) => {
    activityRegistry.markTransactionActive({
      workspaceSlug: 'registry-durable-proof',
      transactionId: 'txn-durable',
      mutationLeaseId: 'lease-durable',
      agentSessionId: 'agent-durable',
      actorUserId: 'actor-1',
      effectiveUserId: 'owner-1',
      controlPlaneUrl: 'http://codesite.test/api/workspace/registry-durable-proof/codesite',
      status: 'open',
      source: 'next_codesite_route',
    }, { now: 20_000, ttlMs: 60_000 });

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.records.length, 1);
    assert.equal(persisted.records[0].authoritative, true);
    assert.equal(persisted.records[0].controlPlaneUrl, 'http://codesite.test/api/workspace/registry-durable-proof/codesite');

    activityRegistry.resetRegistry({ persist: false });
    assert.deepEqual(
      activityRegistry.activeTransactionsForWorkspace('registry-durable-proof', { now: 21_000 }).map((item) => ({
        transactionId: item.transactionId,
        mutationLeaseId: item.mutationLeaseId,
        agentSessionId: item.agentSessionId,
        actorUserId: item.actorUserId,
        effectiveUserId: item.effectiveUserId,
        controlPlaneUrl: item.controlPlaneUrl,
        authoritative: item.authoritative,
      })),
      [{
        transactionId: 'txn-durable',
        mutationLeaseId: 'lease-durable',
        agentSessionId: 'agent-durable',
        actorUserId: 'actor-1',
        effectiveUserId: 'owner-1',
        controlPlaneUrl: 'http://codesite.test/api/workspace/registry-durable-proof/codesite',
        authoritative: true,
      }],
    );

    activityRegistry.markTransactionClosed({
      workspaceSlug: 'registry-durable-proof',
      transactionId: 'txn-durable',
      status: 'committed',
    }, { now: 22_000 });

    activityRegistry.resetRegistry({ persist: false });
    assert.equal(activityRegistry.isWorkspaceActive('registry-durable-proof', { now: 23_000 }), false);
  });
});

test('CodeSite activity registry refreshes active transactions from control-plane authority', async (t) => {
  await withTempRegistryPersistence(t, async () => {
    await withConfiguredCodeSiteBase(async () => {
      const calls = [];
      const fetch = async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({
          activeTransactions: [
            {
              id: 'txn-control',
              mutationLeaseId: 'lease-control',
              agentSessionId: 'agent-control',
              actorUserId: 'actor-control',
              effectiveUserId: 'owner-control',
              status: 'open',
            },
            {
              id: 'txn-blocked',
              mutationLeaseId: 'lease-blocked',
              agentSessionId: 'agent-blocked',
              actorUserId: 'actor-control',
              effectiveUserId: 'owner-control',
              status: 'blocked',
            },
            {
              id: 'txn-validated',
              mutationLeaseId: 'lease-validated',
              agentSessionId: 'agent-validated',
              actorUserId: 'actor-control',
              effectiveUserId: 'owner-control',
              status: 'validated',
            },
          ],
        }), { status: 200 });
      };

      const active = await activityRegistry.refreshWorkspaceFromControlPlane('registry-control-proof', {
        controlPlaneUrl: 'http://codesite.test/api/workspace/registry-control-proof/codesite',
        fetch,
        now: 30_000,
      });

      assert.deepEqual(calls, ['http://codesite.test/api/workspace/registry-control-proof/codesite/transactions/active']);
      assert.deepEqual(active.map((item) => ({
        transactionId: item.transactionId,
        status: item.status,
        authoritative: item.authoritative,
        controlPlaneTrusted: item.controlPlaneTrusted,
        controlPlaneUrl: item.controlPlaneUrl,
      })), [
        {
          transactionId: 'txn-control',
          status: 'open',
          authoritative: true,
          controlPlaneTrusted: true,
          controlPlaneUrl: 'http://codesite.test/api/workspace/registry-control-proof/codesite',
        },
        {
          transactionId: 'txn-blocked',
          status: 'blocked',
          authoritative: true,
          controlPlaneTrusted: true,
          controlPlaneUrl: 'http://codesite.test/api/workspace/registry-control-proof/codesite',
        },
        {
          transactionId: 'txn-validated',
          status: 'validated',
          authoritative: true,
          controlPlaneTrusted: true,
          controlPlaneUrl: 'http://codesite.test/api/workspace/registry-control-proof/codesite',
        },
      ]);

      const cleared = await activityRegistry.refreshWorkspaceFromControlPlane('registry-control-proof', {
        controlPlaneUrl: 'http://codesite.test/api/workspace/registry-control-proof/codesite',
        fetch: async () => new Response(JSON.stringify({ activeTransactions: [] }), { status: 200 }),
        now: 31_000,
      });
      assert.deepEqual(cleared, []);
      assert.equal(activityRegistry.isWorkspaceActive('registry-control-proof', { now: 32_000 }), false);
    });
  });
});

test('CodeSite activity registry rejects untrusted caller-supplied control-plane authority', async (t) => {
  await withTempRegistryPersistence(t, async () => {
    await withConfiguredCodeSiteBase(async () => {
      let fetchCalled = false;
      await assert.rejects(
        () => activityRegistry.refreshWorkspaceFromControlPlane('registry-untrusted-control', {
          controlPlaneUrl: 'http://evil.test/api/workspace/registry-untrusted-control/codesite',
          fetch: async () => {
            fetchCalled = true;
            return new Response(JSON.stringify({ activeTransactions: [] }), { status: 200 });
          },
        }),
        (error) => (
          error.code === 'CODESITE_ACTIVITY_CONTROL_PLANE_UNAVAILABLE'
          && error.details?.reason === 'untrusted_control_plane_url'
        ),
      );
      assert.equal(fetchCalled, false);
    });
  });
});

test('CodeSite activity registry fails closed when mandatory active authority has no configured URL', async (t) => {
  await withTempRegistryPersistence(t, async () => {
    await withCodeSiteOriginEnv({}, async () => {
      await assert.rejects(
        () => activityRegistry.refreshWorkspaceFromControlPlane('registry-missing-authority', {
          requireAuthority: true,
          fetch: async () => new Response(JSON.stringify({ activeTransactions: [] }), { status: 200 }),
        }),
        (error) => (
          error.code === 'CODESITE_ACTIVITY_CONTROL_PLANE_UNAVAILABLE'
          && error.details?.reason === 'missing_control_plane_url'
        ),
      );
    });
  });
});

test('CodeSite request contexts do not publish self-declared active authority to the registry', () => {
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
    assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('registry-context-proof'), []);
  } finally {
    activityRegistry.resetRegistry();
  }
});

test('authoritative CodeSite contexts publish active transaction state to the registry', () => {
  activityRegistry.resetRegistry();
  try {
    activityRegistry.recordCodeSiteContext({
      active: true,
      authoritative: true,
      authoritativeSource: 'control_plane_transaction',
      workspaceSlug: 'registry-context-proof',
      transactionId: 'txn-context',
      mutationLeaseId: 'lease-context',
      agentSessionId: 'agent-context',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      controlPlaneUrl: 'http://codesite.test/api/workspace/registry-context-proof/codesite',
      authoritativeTransactionStatus: 'open',
    });

    assert.deepEqual(
      activityRegistry.activeTransactionsForWorkspace('registry-context-proof').map((item) => ({
        transactionId: item.transactionId,
        mutationLeaseId: item.mutationLeaseId,
        agentSessionId: item.agentSessionId,
        actorUserId: item.actorUserId,
        effectiveUserId: item.effectiveUserId,
        controlPlaneUrl: item.controlPlaneUrl,
        authoritative: item.authoritative,
      })),
      [{
        transactionId: 'txn-context',
        mutationLeaseId: 'lease-context',
        agentSessionId: 'agent-context',
        actorUserId: 'user-1',
        effectiveUserId: 'user-1',
        controlPlaneUrl: 'http://codesite.test/api/workspace/registry-context-proof/codesite',
        authoritative: true,
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
