'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handleEnsureRuntime } = require('../ensureRuntime');

function fakeRuntime() {
  const calls = { ensure: [], wait: [] };
  return {
    calls,
    ensureRuntimeContainer: async (slug, userId) => { calls.ensure.push([slug, userId]); },
    waitForRuntimeReady: async (slug, userId) => { calls.wait.push([slug, userId]); return true; },
  };
}

function fakeFilesystem() {
  const calls = [];
  return {
    calls,
    ensureFilesystem: async (options) => { calls.push(options); },
  };
}

test('handleEnsureRuntime triggers ensure + background readiness and returns warming', async () => {
  const rt = fakeRuntime();
  const filesystem = fakeFilesystem();
  const res = await handleEnsureRuntime({
    workspaceRuntime: rt,
    slug: 'repo',
    userId: 'u1',
    ensureFilesystem: filesystem.ensureFilesystem,
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.warming, true);
  assert.deepEqual(filesystem.calls, [{ workspaceSlug: 'repo', filesystemUserId: 'u1', reason: 'runtime_prewarm' }]);
  assert.deepEqual(rt.calls.ensure[0], ['repo', 'u1']);
  // readiness is awaited in the background; give the microtask queue a tick
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rt.calls.wait[0], ['repo', 'u1']);
});

test('handleEnsureRuntime is a no-op (200) when container runtime is disabled', async () => {
  const res = await handleEnsureRuntime({ workspaceRuntime: null, slug: 'repo', userId: 'u1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
});

test('handleEnsureRuntime blocks active CodeSite prewarm without starting a container', async () => {
  const rt = fakeRuntime();
  const filesystem = fakeFilesystem();
  const res = await handleEnsureRuntime({
    workspaceRuntime: rt,
    slug: 'repo',
    userId: 'u1',
    codesiteContext: { active: true, transactionId: 'txn-1' },
    codesiteMetadata: { active: true, transactionId: 'txn-1' },
    ensureFilesystem: filesystem.ensureFilesystem,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'codesite_runtime_quarantine_unavailable');
  assert.deepEqual(rt.calls.ensure, []);
  assert.deepEqual(filesystem.calls, []);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rt.calls.wait, []);
});

test('handleEnsureRuntime 400s on a missing slug', async () => {
  const rt = fakeRuntime();
  const res = await handleEnsureRuntime({ workspaceRuntime: rt, slug: '', userId: 'u1' });
  assert.equal(res.status, 400);
});
