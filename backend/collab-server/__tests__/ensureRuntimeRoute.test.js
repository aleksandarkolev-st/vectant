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

test('handleEnsureRuntime triggers ensure + background readiness and returns warming', async () => {
  const rt = fakeRuntime();
  const res = await handleEnsureRuntime({ workspaceRuntime: rt, slug: 'repo', userId: 'u1' });
  assert.equal(res.status, 202);
  assert.equal(res.body.warming, true);
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

test('handleEnsureRuntime 400s on a missing slug', async () => {
  const rt = fakeRuntime();
  const res = await handleEnsureRuntime({ workspaceRuntime: rt, slug: '', userId: 'u1' });
  assert.equal(res.status, 400);
});
