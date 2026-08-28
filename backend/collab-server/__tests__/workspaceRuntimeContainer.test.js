'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const {
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
  RUNTIME_IMAGE,
  runtimeWorkspaceDirectory,
  volumeSubpathForPath,
} = require('../workspaceRuntimeContainer');

test('runtimeContainerName is deterministic and docker-safe per (slug,userId)', () => {
  const a = runtimeContainerName('My_Repo', '242593757');
  assert.match(a, /^workspace-runtime-[a-z0-9-]+$/);
  assert.equal(a, runtimeContainerName('My_Repo', '242593757'));
  assert.notEqual(a, runtimeContainerName('My_Repo', 'other-user'));
  assert.notEqual(a, runtimeContainerName('My_Repo', '242593757', { codeSiteQuarantineRoot: '/tmp/q1' }));
  assert.match(runtimeContainerName('My_Repo', '242593757', { codeSiteQuarantineRoot: '/tmp/q1' }), /codesite-[a-f0-9]{10}$/);
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

test('volumeSubpathForPath derives safe named-volume subpaths', () => {
  assert.equal(volumeSubpathForPath('/data/codesitefs-quarantine/repo/txn', '/data'), 'codesitefs-quarantine/repo/txn');
  assert.equal(volumeSubpathForPath('/tmp/codesitefs-quarantine/repo/txn', '/data'), '');
});

test('runtimeWorkspaceDirectory preserves the exact nested root and rejects escapes', () => {
  assert.equal(runtimeWorkspaceDirectory('packages/backend'), '/workspace/packages/backend');
  assert.equal(runtimeWorkspaceDirectory('packages\\backend'), '/workspace/packages/backend');
  assert.throws(() => runtimeWorkspaceDirectory('../outside'), /invalid_relative_workspace_path/);
  assert.throws(() => runtimeWorkspaceDirectory('/outside'), /invalid_relative_workspace_path/);
});

const { createRuntimeManager } = require('../workspaceRuntimeContainer');

function fakeDocker() {
  const created = [];
  const containers = new Map();
  const execs = [];
  function fakeStream() {
    const handlers = {};
    const stream = { on: (event, callback) => { handlers[event] = callback; return stream; }, write: () => {}, end: () => {} };
    setImmediate(() => { if (handlers.end) handlers.end(); });
    return stream;
  }
  return {
    created,
    containers,
    execs,
    createContainer: async (opts) => {
      created.push(opts);
      const id = `id-${opts.name}`;
      const c = {
        id,
        start: async () => { containers.get(id).running = true; },
        inspect: async () => ({ Id: id, State: { Running: containers.get(id).running }, Config: { Labels: opts.Labels || {} } }),
        remove: async () => { containers.delete(id); },
        exec: async (execOpts = {}) => {
          execs.push(execOpts);
          return {
            start: async () => fakeStream(),
            inspect: async () => ({ ExitCode: execOpts.__exitCode ?? 0 }),
            resize: async () => {},
          };
        },
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

function overlayOptions({
  transactionId = 'txn-1',
  baseRoot = '/tmp/codesite-repo/repo/u1',
  overlayRoot = '/tmp/codesite-overlay/repo/txn-1',
  upperRoot = '/tmp/codesite-overlay/repo/txn-1/upper',
  workRoot = '/tmp/codesite-overlay/repo/txn-1/work',
  overlayId = upperRoot,
} = {}) {
  return {
    codesiteContext: { active: true, transactionId },
    codeSiteBaseRoot: baseRoot,
    codeSiteOverlayRoot: overlayRoot,
    codeSiteOverlayUpperRoot: upperRoot,
    codeSiteOverlayWorkRoot: workRoot,
    codeSiteOverlayId: overlayId,
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
  assert.ok(opts.Env.includes('RUNTIME_WORKSPACE_UMASK=0002'));
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

test('probeOverlayCapability verifies a live Linux daemon and the configured runtime image', async () => {
  const docker = fakeDocker();
  docker.ping = async () => 'OK';
  docker.info = async () => ({ OSType: 'linux' });
  docker.getImage = (name) => ({ inspect: async () => ({ Id: `image:${name}` }) });
  const mgr = createRuntimeManager({ docker });

  assert.deepEqual(await mgr.probeOverlayCapability(), {
    ok: true,
    code: 'docker_overlay_runtime_ready',
  });
});

test('probeOverlayCapability does not claim capability without a working daemon probe', async () => {
  const mgr = createRuntimeManager({ docker: fakeDocker() });
  assert.deepEqual(await mgr.probeOverlayCapability(), {
    ok: false,
    code: 'docker_runtime_probe_unavailable',
  });
});

test('read-write runtimes use a scoped shared group instead of world-write access', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, sharedWorkspaceGid: '1000', workspaceUmask: '0002' });
  await mgr.ensureRuntimeContainer('repo', 'u1');

  const setup = docker.execs[0];
  assert.equal(setup.User, 'root');
  assert.match(setup.Cmd.join('\n'), /shared_gid=\"1000\"/);
  assert.match(setup.Cmd.join('\n'), /chmod g\+rwx,g\+s/);
  assert.match(setup.Cmd.join('\n'), /chmod g\+rw/);
  assert.ok(docker.created[0].Env.includes('RUNTIME_WORKSPACE_UMASK=0002'));
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

test('CodeSite active runtime containers require explicit overlay roots', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(
    () => mgr.ensureRuntimeContainer('repo', 'u1', { codesiteContext: { active: true, transactionId: 'txn-1' } }),
    /codesite_runtime_overlay_required/,
  );
  assert.equal(docker.created.length, 0);
});

test('CodeSite runtime containers mount readonly base plus writable overlay parent', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions());
  const opts = docker.created[0];
  assert.match(opts.name, /^workspace-runtime-repo-u1-codesite-[a-f0-9]{10}$/);
  assert.equal(opts.Labels['vectant/codesite-workspace-mode'], 'codesite-overlay');
  assert.equal(opts.Labels['vectant/codesite-transaction-id'], 'txn-1');
  assert.equal(opts.Labels['vectant/codesite-base-readonly'], 'true');
  assert.ok(opts.HostConfig.Binds.includes('/tmp/codesite-repo/repo/u1:/codesite/base:ro'));
  assert.ok(opts.HostConfig.Binds.includes('/tmp/codesite-overlay/repo/txn-1:/codesite/overlay'));
  assert.ok(!opts.HostConfig.Binds.some((bind) => bind.includes(':/workspace')));
  assert.ok(opts.Env.includes('CODESITE_WORKSPACE_OVERLAY=1'));
  assert.ok(opts.Env.includes('CODESITE_OVERLAY_UPPER=/codesite/overlay/upper'));
  assert.ok(opts.Env.includes('CODESITE_OVERLAY_WORK=/codesite/overlay/work'));
  assert.equal(docker.execs[0].User, 'root');
  assert.match(docker.execs[0].Cmd.join(' '), /mount -t overlay/);
  assert.match(docker.execs[0].Cmd.join(' '), /upperdir=\/codesite\/overlay\/upper/);
  assert.match(docker.execs[0].Cmd.join(' '), /PROBE_DIR=.*rootless-probe/);
});

test('CodeSite overlay setup failure removes the container and rejects', async () => {
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (opts) => {
    const c = await origCreate(opts);
    c.exec = async (execOpts = {}) => {
      docker.execs.push(execOpts);
      return {
        start: async () => {
          const stream = new PassThrough();
          setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ ExitCode: 42 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });

  await assert.rejects(
    () => mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions()),
    (error) => error.code === 'CODESITE_RUNTIME_OVERLAY_UNAVAILABLE',
  );
  assert.equal(docker.containers.size, 0);
});

test('CodeSite overlay upper root participates in runtime identity when transaction id repeats', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/first', upperRoot: '/tmp/codesite-overlay/repo/txn-1/first/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/first/work', overlayId: 'first' }));
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/second', upperRoot: '/tmp/codesite-overlay/repo/txn-1/second/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/second/work', overlayId: 'second' }));

  assert.equal(docker.created.length, 2);
  assert.notEqual(docker.created[0].name, docker.created[1].name);
  assert.notEqual(
    docker.created[0].Labels['vectant/codesite-overlay-id'],
    docker.created[1].Labels['vectant/codesite-overlay-id'],
  );
});

test('CodeSite runtime volume mounts use overlay subpaths in dataVolume mode', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, dataVolume: 'synthi-ide_collab-data', reposSubpath: 'repos', dataVolumeRoot: '/data' });
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions({
    baseRoot: '/data/repos/repo/u1',
    overlayRoot: '/data/codesitefs-overlay/repo/txn-1',
    upperRoot: '/data/codesitefs-overlay/repo/txn-1/upper',
    workRoot: '/data/codesitefs-overlay/repo/txn-1/work',
  }));
  const mounts = docker.created[0].HostConfig.Mounts;
  assert.deepEqual(mounts.map((mount) => [mount.Target, mount.ReadOnly || false, mount.VolumeOptions.Subpath]), [
    ['/codesite/base', true, 'repos/repo/u1'],
    ['/codesite/overlay', false, 'codesitefs-overlay/repo/txn-1'],
  ]);
});

test('ensureRuntimeContainer reuses a running container (no second create)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(docker.created.length, 1);
});

test('CodeSite overlay and ordinary runtime containers do not reuse each other', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions());
  assert.equal(docker.created.length, 2);
  assert.equal(docker.created[0].name, 'workspace-runtime-repo-u1');
  assert.match(docker.created[1].name, /^workspace-runtime-repo-u1-codesite-[a-f0-9]{10}$/);
});

test('CodeSite overlay runtime identity isolates same-transaction overlays', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a', upperRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a/work', overlayId: 'overlay-a' }));
  await mgr.ensureRuntimeContainer('repo', 'u1', overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b', upperRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b/work', overlayId: 'overlay-b' }));
  assert.equal(docker.created.length, 2);
  assert.notEqual(docker.created[0].name, docker.created[1].name);
  assert.ok(docker.created[0].HostConfig.Binds.includes('/tmp/codesite-overlay/repo/txn-1/overlay-a:/codesite/overlay'));
  assert.ok(docker.created[1].HostConfig.Binds.includes('/tmp/codesite-overlay/repo/txn-1/overlay-b:/codesite/overlay'));
});

test('teardown removes the selected CodeSite overlay runtime container', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  const optionsA = overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a', upperRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-a/work', overlayId: 'overlay-a' });
  const optionsB = overlayOptions({ overlayRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b', upperRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b/upper', workRoot: '/tmp/codesite-overlay/repo/txn-1/overlay-b/work', overlayId: 'overlay-b' });
  const first = await mgr.ensureRuntimeContainer('repo', 'u1', optionsA);
  const second = await mgr.ensureRuntimeContainer('repo', 'u1', optionsB);
  await mgr.teardown('repo', 'u1', optionsA);
  assert.throws(() => docker.getContainer(first.containerId), /no such container/);
  assert.ok(await docker.getContainer(second.containerId).inspect());
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

test('ensureRuntimeContainer rejects adoption when an existing CodeSite container has wrong mode labels', async () => {
  const docker = fakeDocker();
  const options = overlayOptions();
  const name = runtimeContainerName('repo', 'u1', options);
  const stale = await docker.createContainer({
    name,
    Labels: { 'vectant/codesite-workspace-mode': 'readwrite' },
    HostConfig: { Binds: [`${options.codeSiteBaseRoot}:/codesite/base:ro`] },
  });
  await stale.start();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(
    () => mgr.ensureRuntimeContainer('repo', 'u1', options),
    /codesite_runtime_container_mode_mismatch/,
  );
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

test('execInteractiveShell opens a bash -l TTY exec in the exact opened workspace directory as rootless and wires resize', async () => {
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

  const handle = await mgr.execInteractiveShell('repo', 'u1', {
    cols: 120,
    rows: 40,
    workspaceRelativePath: 'packages/backend',
    env: {
      CODESITE_TRANSACTION_ID: 'txn-1',
      CODESITE_MUTATION_LEASE_ID: 'lease-1',
      PATH: '/host/bin',
    },
  });

  // Interactive login shell, in the workspace, as the rootless user, with a TTY.
  assert.deepEqual(execOpts.Cmd, ['/bin/bash', '-lc', 'exec /bin/bash -l -c \'umask "$RUNTIME_WORKSPACE_UMASK"; exec /bin/bash\'']);
  assert.equal(execOpts.WorkingDir, '/workspace/packages/backend');
  assert.equal(execOpts.User, 'rootless');
  assert.equal(execOpts.Tty, true);
  assert.equal(execOpts.AttachStdin, true);
  assert.ok(execOpts.Env.includes('TERM=xterm-256color'), 'TERM must be set for a real terminal');
  assert.ok(execOpts.Env.includes('CODESITE_TRANSACTION_ID=txn-1'), 'CodeSite transaction id must reach runtime shells');
  assert.ok(execOpts.Env.includes('CODESITE_MUTATION_LEASE_ID=lease-1'), 'CodeSite lease id must reach runtime shells');
  assert.ok(!execOpts.Env.includes('PATH=/host/bin'), 'host PATH must stay scrubbed');

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

test('runOnce execs argv and resolves the collected stdout', async () => {
  let execOpts = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => {
      execOpts = opts;
      return {
        start: async () => {
          const handlers = {};
          const stream = { on: (ev, cb) => { handlers[ev] = cb; return stream; } };
          setImmediate(() => {
            handlers.data && handlers.data(Buffer.from('hello-stdout'));
            handlers.end && handlers.end();
          });
          return stream;
        },
        inspect: async () => ({ ExitCode: 0 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');

  const out = await mgr.runOnce('repo', 'u1', ['/bin/sh', '-lc', 'cat /proc/net/tcp']);
  assert.equal(execOpts.Cmd[0], '/bin/sh');
  assert.equal(execOpts.AttachStdout, true);
  assert.equal(execOpts.Tty, false);
  assert.equal(out, 'hello-stdout');
});

test('listRuntimeSessions exposes explicit overlay session identity for port routing', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  const options = overlayOptions();
  const runtime = await mgr.ensureRuntimeContainer('repo', 'u1', options);

  const sessions = mgr.listRuntimeSessions();
  assert.equal(sessions.length, 1);
  assert.deepEqual({
    slug: sessions[0].slug,
    userId: sessions[0].userId,
    mode: sessions[0].mode,
    host: sessions[0].host,
    containerId: sessions[0].containerId,
  }, {
    slug: 'repo',
    userId: 'u1',
    mode: 'codesite-overlay',
    host: runtime.name,
    containerId: runtime.containerId,
  });
  assert.equal(sessions[0].runtimeOptions.codeSiteOverlayUpperRoot, options.codeSiteOverlayUpperRoot);
});

test('runOnce can address an overlay runtime session by runtime options', async () => {
  let execOpts = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => {
      execOpts = opts;
      return {
        start: async () => {
          const handlers = {};
          const stream = { on: (ev, cb) => { handlers[ev] = cb; return stream; } };
          setImmediate(() => {
            handlers.data && handlers.data(Buffer.from('overlay-stdout'));
            handlers.end && handlers.end();
          });
          return stream;
        },
        inspect: async () => ({ ExitCode: 0 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  const options = overlayOptions();
  await mgr.ensureRuntimeContainer('repo', 'u1', options);

  const out = await mgr.runOnce('repo', 'u1', ['/bin/sh', '-lc', 'cat /proc/net/tcp'], options);
  assert.equal(execOpts.Cmd[0], '/bin/sh');
  assert.equal(out, 'overlay-stdout');
});

test('runOnce throws if the runtime container was not started', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(() => mgr.runOnce('repo', 'u1', ['/bin/sh', '-lc', 'true']), /not started/i);
});
