'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
  RUNTIME_IMAGE,
} = require('../workspaceRuntimeContainer');

test('runtimeContainerName is deterministic and docker-safe per (slug,userId)', () => {
  const a = runtimeContainerName('My_Repo', '242593757');
  assert.match(a, /^workspace-runtime-[a-z0-9-]+$/);
  assert.equal(a, runtimeContainerName('My_Repo', '242593757'));
  assert.notEqual(a, runtimeContainerName('My_Repo', 'other-user'));
});

test('runtimeContainerHost equals the container name (compose DNS on the shared network)', () => {
  assert.equal(runtimeContainerHost('repo', 'u1'), runtimeContainerName('repo', 'u1'));
});

test('shouldCull is true only past the idle TTL', () => {
  const ttl = 1000;
  assert.equal(shouldCull({ lastActive: 0 }, 999, ttl), false);
  assert.equal(shouldCull({ lastActive: 0 }, 1001, ttl), true);
});

test('RUNTIME_IMAGE defaults to synthi-runtime:local', () => {
  assert.equal(RUNTIME_IMAGE, 'synthi-runtime:local');
});

const { createRuntimeManager } = require('../workspaceRuntimeContainer');

function fakeDocker() {
  const created = [];
  const containers = new Map();
  return {
    created,
    containers,
    createContainer: async (opts) => {
      created.push(opts);
      const id = `id-${opts.name}`;
      const c = {
        id,
        start: async () => { containers.get(id).running = true; },
        inspect: async () => ({ Id: id, State: { Running: containers.get(id).running } }),
        remove: async () => { containers.delete(id); },
        exec: async () => ({
          start: async () => ({ on: () => {}, write: () => {}, end: () => {} }),
        }),
      };
      containers.set(id, { running: false, c, name: opts.name });
      return c;
    },
    getContainer: (id) => {
      const found = [...containers.values()].find((e) => e.c.id === id || e.name === id);
      if (!found) { const e = new Error('no such container'); e.statusCode = 404; throw e; }
      return found.c;
    },
    listContainers: async () => [],
  };
}

test('ensureRuntimeContainer creates + starts a privileged container on the shared network', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  const res = await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(res.name, 'workspace-runtime-repo-u1');
  assert.equal(docker.created.length, 1);
  const opts = docker.created[0];
  assert.equal(opts.Image, 'synthi-runtime:local');
  assert.equal(opts.HostConfig.Privileged, true);
  assert.equal(opts.HostConfig.NetworkMode, 'synthi-ide_default');
  assert.ok(opts.HostConfig.Binds.some((b) => b.endsWith(':/workspace')));
});

test('ensureRuntimeContainer reuses a running container (no second create)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(docker.created.length, 1);
});

test('teardown removes the container and forgets the session', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.teardown('repo', 'u1');
  assert.equal(docker.containers.size, 0);
});

test('ensureRuntimeContainer enforces the max-container cap', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, maxContainers: 1 });
  await mgr.ensureRuntimeContainer('a', 'u1');
  await assert.rejects(() => mgr.ensureRuntimeContainer('b', 'u2'), /cap reached/i);
});

test('execInRuntime returns a ptyProcess-shaped handle (onData/onExit/kill)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  const handle = await mgr.execInRuntime('repo', 'u1', { command: 'echo hi', env: { FOO: 'bar' } });
  assert.equal(typeof handle.ptyProcess.onData, 'function');
  assert.equal(typeof handle.ptyProcess.onExit, 'function');
  assert.equal(typeof handle.ptyProcess.kill, 'function');
  const d = handle.ptyProcess.onData(() => {});
  assert.equal(typeof d.dispose, 'function');
});
