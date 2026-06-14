'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Force local mode BEFORE requiring the spawner so module-load does not init a
// real k8s client (no kubeconfig in CI). In local mode appsApi/coreApi/watcher
// are undefined — which also proves the gated no-op paths never touch k8s.
process.env.SPAWNER_MODE = 'local';
const spawner = require('../workspacePodSpawner');

// S2-T15 — the /api/spawner/ensure call-site does `spawner.spawnRuntimePod?.(...)`;
// in k8s mode the function must exist on the spawner surface.
test('workspacePodSpawner exports spawnRuntimePod', () => {
  assert.equal(typeof spawner.spawnRuntimePod, 'function');
});

// S2-T11 — dark by default: with RUNTIME_BACKEND unset the runtime backend is OFF,
// so spawnRuntimePod is a no-op (and never touches k8s — appsApi is undefined here).
test('spawnRuntimePod no-ops when the sysbox runtime flag is off', async () => {
  const prev = process.env.RUNTIME_BACKEND;
  try {
    delete process.env.RUNTIME_BACKEND;
    const result = await spawner.spawnRuntimePod('ws-a:u1', 'u1', {
      workspaceSlug: 'repo',
      filesystemUserId: '1',
    });
    assert.deepEqual(result, { skipped: true, reason: 'runtime_backend_disabled' });
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_BACKEND;
    else process.env.RUNTIME_BACKEND = prev;
  }
});

// S2-T12 — even with the flag ON, local dev (SPAWNER_MODE=local) has no Sysbox/k8s;
// spawnRuntimePod must bypass so the existing workspaceRuntimeContainer.js path owns
// local container runtimes. (Module was required in local mode above.)
test('spawnRuntimePod local-bypasses when SPAWNER_MODE=local even if the flag is on', async () => {
  const prev = process.env.RUNTIME_BACKEND;
  try {
    process.env.RUNTIME_BACKEND = 'sysbox-pod';
    const result = await spawner.spawnRuntimePod('ws-a:u1', 'u1', {
      workspaceSlug: 'repo',
      filesystemUserId: '1',
    });
    assert.deepEqual(result, { skipped: true, reason: 'local_mode' });
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_BACKEND;
    else process.env.RUNTIME_BACKEND = prev;
  }
});

// S2-T13 — pure idle-cull decision (no k8s): select runtime deployments whose
// lastActive is older than the timeout; fresh ones are kept; a missing annotation
// is treated as idle (mirrors the worker culler's `|| 0` default).
test('runtimeCullDecision selects idle runtime deployments and excludes fresh ones', () => {
  const now = 1_000_000;
  const timeoutMs = 10_000;
  const deployments = [
    { metadata: { name: 'rt-aaa-rt', annotations: { 'synthi/lastActive': String(now - 20_000), 'synthi/runtimeScopeFull': 'ws-a:u1' } } },
    { metadata: { name: 'rt-bbb-rt', annotations: { 'synthi/lastActive': String(now - 5_000), 'synthi/runtimeScopeFull': 'ws-b:u2' } } },
    { metadata: { name: 'rt-ccc-rt', annotations: {} } },
  ];
  const toCull = spawner.runtimeCullDecision(deployments, now, timeoutMs);
  assert.deepEqual(toCull.map((d) => d.name).sort(), ['rt-aaa-rt', 'rt-ccc-rt']);
  assert.equal(toCull.find((d) => d.name === 'rt-aaa-rt').sessionId, 'ws-a:u1');
});

// S2-T14 — pure capacity guard mirroring the worker's MAX_WORKSPACE_PODS check.
test('runtimeAtCapacity is true only at or above the max', () => {
  assert.equal(spawner.runtimeAtCapacity(4, 5), false);
  assert.equal(spawner.runtimeAtCapacity(5, 5), true);
  assert.equal(spawner.runtimeAtCapacity(6, 5), true);
});

// S2-T16 — DEFERRED (written + skipped): create + dockerd-ready watch needs a
// working Sysbox substrate (sysbox-runc on the node) to actually run a pod.
test('runtime pod reaches dockerd-ready on a real Sysbox cluster', { skip: 'integration — blocked on nestybox/sysbox#1006 substrate' }, () => {});

// S2-T17 — DEFERRED (written + skipped): live cross-tenant subPath confinement —
// proving one workspace cannot read another's files needs a real mounted PVC.
test('runtime pod cannot read another tenant files (subPath confinement)', { skip: 'security integration — blocked on nestybox/sysbox#1006 substrate' }, () => {});
