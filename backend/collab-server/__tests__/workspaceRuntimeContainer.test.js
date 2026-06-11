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

test('RUNTIME_IMAGE defaults to vectant-runtime:local', () => {
  assert.equal(RUNTIME_IMAGE, 'vectant-runtime:local');
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
  assert.equal(opts.Image, 'vectant-runtime:local');
  assert.equal(opts.HostConfig.Privileged, true);
  assert.equal(opts.HostConfig.NetworkMode, 'synthi-ide_default');
  assert.ok(opts.HostConfig.Binds.some((b) => b.endsWith(':/workspace')));
  // labels use the vectant namespace
  assert.equal(opts.Labels['vectant/runtime'], 'workspace-runtime-local');
  assert.equal(opts.Labels['vectant/slug'], 'repo');
});

test('createRuntimeManager honours privileged=false (prod Sysbox path)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, privileged: false });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(docker.created[0].HostConfig.Privileged, false);
});

test('with a dataVolume, the per-user repo is mounted into /workspace via a volume Subpath (not a host bind)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, dataVolume: 'synthi-ide_collab-data', reposSubpath: 'repos' });
  await mgr.ensureRuntimeContainer('My_Repo', '242593757');
  const hc = docker.created[0].HostConfig;
  assert.equal(hc.Binds, undefined, 'must not use a host-path bind in volume mode');
  assert.equal(hc.Mounts.length, 1);
  const m = hc.Mounts[0];
  assert.equal(m.Type, 'volume');
  assert.equal(m.Source, 'synthi-ide_collab-data');
  assert.equal(m.Target, '/workspace');
  // safeName lowercases/sanitizes slug+user; subpath is repos/<slug>/<user>
  assert.equal(m.VolumeOptions.Subpath, 'repos/my-repo/242593757');
});

test('ensureRuntimeContainer reuses a running container (no second create)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(docker.created.length, 1);
});

test('ensureRuntimeContainer adopts an existing running container after a restart (no 409)', async () => {
  const docker = fakeDocker();
  const m1 = createRuntimeManager({ docker });
  await m1.ensureRuntimeContainer('repo', 'u1');
  // simulate a collab-server restart: a fresh manager with empty in-memory state
  // but the container still exists in the (shared) daemon.
  const m2 = createRuntimeManager({ docker });
  const res = await m2.ensureRuntimeContainer('repo', 'u1');
  assert.equal(res.created, false, 'should adopt, not recreate');
  assert.equal(docker.created.length, 1, 'no second createContainer (would 409)');
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

test('execInRuntime drops host/shell env (HOME/PATH) but forwards app env', async () => {
  let execOpts = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => { execOpts = opts; return { start: async () => ({ on: () => {}, write: () => {}, end: () => {} }) }; };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.execInRuntime('repo', 'u1', { command: 'echo hi', env: { HOME: '/home/synthi', PATH: '/x', MY_APP: 'v1' } });
  assert.ok(!execOpts.Env.some((e) => e.startsWith('HOME=')), 'HOME must be dropped');
  assert.ok(!execOpts.Env.some((e) => e.startsWith('PATH=')), 'PATH must be dropped');
  assert.ok(execOpts.Env.includes('MY_APP=v1'), 'app env must be forwarded');
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

test('execInteractiveShell opens a bash -l TTY exec in /workspace as rootless and wires resize', async () => {
  let execOpts = null;
  let resizeArg = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => {
      execOpts = opts;
      return {
        start: async () => ({ on: () => {}, write: () => {}, end: () => {} }),
        resize: async ({ h, w }) => { resizeArg = { h, w }; },
        inspect: async () => ({ ExitCode: 0 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');

  const handle = await mgr.execInteractiveShell('repo', 'u1', { cols: 120, rows: 40 });

  // Interactive login shell, in the workspace, as the rootless user, with a TTY.
  assert.deepEqual(execOpts.Cmd, ['/bin/bash', '-l']);
  assert.equal(execOpts.WorkingDir, '/workspace');
  assert.equal(execOpts.User, 'rootless');
  assert.equal(execOpts.Tty, true);
  assert.equal(execOpts.AttachStdin, true);
  assert.ok(execOpts.Env.includes('TERM=xterm-256color'), 'TERM must be set for a real terminal');

  // PTY-shaped handle + resize.
  assert.equal(typeof handle.ptyProcess.onData, 'function');
  assert.equal(typeof handle.ptyProcess.onExit, 'function');
  assert.equal(typeof handle.ptyProcess.write, 'function');
  assert.equal(typeof handle.ptyProcess.kill, 'function');
  assert.equal(typeof handle.ptyProcess.resize, 'function');

  // Initial size is applied after start (h=rows, w=cols — Docker's resize order).
  assert.deepEqual(resizeArg, { h: 40, w: 120 });
  handle.ptyProcess.resize(80, 24);
  assert.deepEqual(resizeArg, { h: 24, w: 80 });
});

test('execInteractiveShell throws if the runtime container was not started', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(() => mgr.execInteractiveShell('repo', 'u1', { cols: 80, rows: 24 }), /not started/i);
});
