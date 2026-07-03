'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const activityRegistry = require('../codesiteActivityRegistry');
const { handleCodeSiteActivityRequest } = require('../codesiteActivityEndpoint');

const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-activity-endpoint-registry-'));
const previousPersistence = activityRegistry.configurePersistence({
  enabled: true,
  filePath: path.join(registryDir, 'active-transactions.json'),
});

test.after(() => {
  activityRegistry.resetRegistry();
  activityRegistry.configurePersistence(previousPersistence);
  fs.rmSync(registryDir, { recursive: true, force: true });
});

async function withActivityServer(t, fn) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const match = url.pathname.match(/^\/codesite\/activity\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    await handleCodeSiteActivityRequest(decodeURIComponent(match[1]), req, res, {
      activityRegistry,
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return fn(`http://127.0.0.1:${address.port}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('CodeSite activity endpoint rejects unauthenticated posts without changing registry state', async (t) => {
  activityRegistry.resetRegistry();
  t.after(() => activityRegistry.resetRegistry());
  await withEnv({
    COLLAB_INTERNAL_TOKEN: 'internal-test-token',
    SYNTHI_COLLAB_INTERNAL_TOKEN: undefined,
    SYNTHI_CODESITE_API_BASE_URL: 'http://app.test/api/workspace/{workspace_slug}/codesite',
  }, async () => {
    await withActivityServer(t, async (baseUrl) => {
      const result = await requestJson(`${baseUrl}/codesite/activity/acme`, {
        method: 'POST',
        body: JSON.stringify({
          event: 'transaction_opened',
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          status: 'open',
          controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
        }),
      });

      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'codesite_activity_auth_required');
      assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('acme'), []);
    });
  });
});

test('CodeSite activity endpoint fails closed when internal token is not configured', async (t) => {
  activityRegistry.resetRegistry();
  t.after(() => activityRegistry.resetRegistry());
  await withEnv({
    COLLAB_INTERNAL_TOKEN: undefined,
    SYNTHI_COLLAB_INTERNAL_TOKEN: undefined,
    SYNTHI_CODESITE_API_BASE_URL: 'http://app.test/api/workspace/{workspace_slug}/codesite',
  }, async () => {
    await withActivityServer(t, async (baseUrl) => {
      const result = await requestJson(`${baseUrl}/codesite/activity/acme`, {
        method: 'POST',
        headers: { 'x-collab-internal-token': 'anything' },
        body: JSON.stringify({
          event: 'transaction_opened',
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          status: 'open',
          controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
        }),
      });

      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'codesite_activity_auth_unconfigured');
      assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('acme'), []);
    });
  });
});

test('CodeSite activity endpoint records trusted active locks only with internal auth', async (t) => {
  activityRegistry.resetRegistry();
  t.after(() => activityRegistry.resetRegistry());
  await withEnv({
    COLLAB_INTERNAL_TOKEN: undefined,
    SYNTHI_COLLAB_INTERNAL_TOKEN: 'synthi-internal-test-token',
    SYNTHI_CODESITE_API_BASE_URL: 'http://app.test/api/workspace/{workspace_slug}/codesite',
  }, async () => {
    await withActivityServer(t, async (baseUrl) => {
      const result = await requestJson(`${baseUrl}/codesite/activity/acme`, {
        method: 'POST',
        headers: {
          'x-collab-internal-token': 'synthi-internal-test-token',
          'x-user-id': 'user-1',
          'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
        },
        body: JSON.stringify({
          event: 'transaction_opened',
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'agent-1',
          effectiveUserId: 'user-1',
          status: 'open',
        }),
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.action, 'active');
      assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('acme').map((item) => ({
        transactionId: item.transactionId,
        mutationLeaseId: item.mutationLeaseId,
        actorUserId: item.actorUserId,
        effectiveUserId: item.effectiveUserId,
        controlPlaneUrl: item.controlPlaneUrl,
        controlPlaneTrusted: item.controlPlaneTrusted,
        authoritative: item.authoritative,
      })), [{
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        actorUserId: 'user-1',
        effectiveUserId: 'user-1',
        controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
        controlPlaneTrusted: true,
        authoritative: true,
      }]);
    });
  });
});

test('CodeSite activity endpoint rejects internally authenticated active locks without configured authority origin', async (t) => {
  activityRegistry.resetRegistry();
  t.after(() => activityRegistry.resetRegistry());
  await withEnv({
    COLLAB_INTERNAL_TOKEN: 'internal-test-token',
    SYNTHI_COLLAB_INTERNAL_TOKEN: undefined,
    SYNTHI_CODESITE_API_BASE_URL: undefined,
    CODESITE_API_BASE_URL: undefined,
    SYNTHI_CODESITE_BASE_URL: undefined,
    SYNTHI_APP_INTERNAL_URL: undefined,
    SYNTHI_APP_URL: undefined,
    SYNTHI_PUBLIC_APP_URL: undefined,
    NEXTAUTH_URL: undefined,
  }, async () => {
    await withActivityServer(t, async (baseUrl) => {
      const result = await requestJson(`${baseUrl}/codesite/activity/acme`, {
        method: 'POST',
        headers: {
          'x-collab-internal-token': 'internal-test-token',
          'x-codesite-control-plane-url': 'http://evil.test/api/workspace/acme/codesite',
        },
        body: JSON.stringify({
          event: 'transaction_opened',
          transactionId: 'txn-1',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'agent-1',
          actorUserId: 'user-1',
          effectiveUserId: 'user-1',
          status: 'open',
        }),
      });

      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'codesite_activity_control_plane_url_required');
      assert.deepEqual(activityRegistry.activeTransactionsForWorkspace('acme'), []);
    });
  });
});
