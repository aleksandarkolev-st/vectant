'use strict';

const path = require('path');

/**
 * Per-workspace rootless-Docker runtime container lifecycle.
 *
 * Mirrors localWorkerSpawner.js but manages ONE runtime container per
 * (workspaceSlug,userId) instead of per signaling session. Only `container`-type
 * programs route here (hybrid Phase 1); the runtime container runs its own
 * rootless dockerd, so `docker`/`docker compose` inside it never touch the host
 * socket and cannot see another workspace's containers.
 */

const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE || 'vectant-runtime:local';
const RUNTIME_NETWORK = process.env.WORKER_NETWORK || 'synthi-ide_default';
const RUNTIME_IDLE_TTL_MS = Number(process.env.RUNTIME_IDLE_TTL_MS) || 10 * 60 * 1000;
const MAX_RUNTIME_CONTAINERS = Number(process.env.MAX_RUNTIME_CONTAINERS) || 25;
const REPOS_DIR = process.env.REPOS_DIR || '/data/repos';
// Outer-container privilege. Dev (Docker Desktop/WSL2) needs it so rootless
// dockerd can set up user namespaces; prod (k8s + Sysbox) sets RUNTIME_PRIVILEGED=0
// and supplies a runtimeClass instead. Defaults ON; any value other than '0'/'false' is on.
const RUNTIME_PRIVILEGED = !['0', 'false', 'no'].includes(String(process.env.RUNTIME_PRIVILEGED ?? '').toLowerCase());

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
}

/** Deterministic, docker-safe container name per workspace+user. */
function runtimeContainerName(slug, userId) {
  return `workspace-runtime-${safeName(`${slug}-${userId}`)}`;
}

/** On the shared compose network the container is reachable by its name. */
function runtimeContainerHost(slug, userId) {
  return runtimeContainerName(slug, userId);
}

/** Idle-cull decision (pure). */
function shouldCull(entry, now, ttlMs = RUNTIME_IDLE_TTL_MS) {
  return now - entry.lastActive > ttlMs;
}

/**
 * @param {object} opts
 * @param {object} opts.docker - dockerode-compatible client (injected for tests)
 * @param {number} [opts.maxContainers]
 * @param {string} [opts.reposDir]
 */
function createRuntimeManager({
  docker,
  maxContainers = MAX_RUNTIME_CONTAINERS,
  reposDir = REPOS_DIR,
  image = RUNTIME_IMAGE,
  network = RUNTIME_NETWORK,
  privileged = RUNTIME_PRIVILEGED,
  logger = console,
} = {}) {
  if (!docker) throw new TypeError('docker client is required');
  /** key `${slug} ${userId}` -> { containerId, lastActive } */
  const sessions = new Map();
  const keyOf = (slug, userId) => `${slug} ${userId}`;

  async function ensureRuntimeContainer(slug, userId) {
    const name = runtimeContainerName(slug, userId);
    const key = keyOf(slug, userId);
    const now = Date.now();

    const tracked = sessions.get(key);
    if (tracked) {
      try {
        const info = await docker.getContainer(tracked.containerId).inspect();
        if (info.State.Running) {
          tracked.lastActive = now;
          return { name, host: name, containerId: tracked.containerId, created: false };
        }
        try { await docker.getContainer(tracked.containerId).remove({ force: true }); } catch (_) {}
      } catch (_) {}
      sessions.delete(key);
    }

    if (sessions.size >= maxContainers) {
      throw new Error(`Runtime container cap reached (${maxContainers})`);
    }

    // Per-user workspace dir on the host-side named volume, bind-mounted into /workspace.
    const hostRepoDir = path.posix.join(reposDir, safeName(slug), safeName(userId));
    const createOpts = {
      name,
      Image: image,
      Labels: {
        'vectant/runtime': 'workspace-runtime-local',
        'vectant/slug': String(slug),
        'vectant/userId': String(userId),
        'vectant/lastActive': String(now),
      },
      HostConfig: {
        // Privileged on the OUTER container lets rootless dockerd set up its user
        // namespaces in the Docker Desktop/WSL2 dev stack. Prod (k8s + Sysbox)
        // sets RUNTIME_PRIVILEGED=0 and supplies a runtimeClass instead.
        Privileged: privileged,
        NetworkMode: network,
        Binds: [`${hostRepoDir}:/workspace`],
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
    };

    const container = await docker.createContainer(createOpts);
    await container.start();
    sessions.set(key, { containerId: container.id, lastActive: now });
    logger.log(`[RuntimeContainer] Started ${name} (slug=${slug}, userId=${userId})`);
    return { name, host: name, containerId: container.id, created: true };
  }

  function touch(slug, userId) {
    const s = sessions.get(keyOf(slug, userId));
    if (s) s.lastActive = Date.now();
  }

  async function teardown(slug, userId) {
    const key = keyOf(slug, userId);
    const s = sessions.get(key);
    sessions.delete(key);
    const id = s?.containerId || runtimeContainerName(slug, userId);
    try {
      const c = docker.getContainer(id);
      try { await c.stop({ t: 5 }); } catch (_) {}
      await c.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) logger.warn(`[RuntimeContainer] teardown ${id}: ${err.message}`);
    }
  }

  async function cullIdle(now = Date.now()) {
    for (const [key, entry] of [...sessions.entries()]) {
      if (shouldCull(entry, now)) {
        const [slug, userId] = key.split(' ');
        await teardown(slug, userId);
      }
    }
  }

  async function execInRuntime(slug, userId, { command, env = {}, tty = true } = {}) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();

    const Env = Object.entries(env)
      .filter(([k, v]) => typeof k === 'string' && v != null)
      .map(([k, v]) => `${k}=${v}`);

    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: ['/bin/sh', '-lc', String(command)],
      Env,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      WorkingDir: '/workspace',
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });

    const dataCbs = new Set();
    const exitCbs = new Set();
    stream.on('data', (chunk) => { for (const cb of dataCbs) cb(chunk.toString('utf8')); });
    stream.on('end', async () => {
      let exitCode = null;
      try { exitCode = (await exec.inspect()).ExitCode; } catch (_) {}
      for (const cb of exitCbs) cb({ exitCode });
    });

    const ptyProcess = {
      onData: (cb) => { dataCbs.add(cb); return { dispose: () => dataCbs.delete(cb) }; },
      onExit: (cb) => { exitCbs.add(cb); return { dispose: () => exitCbs.delete(cb) }; },
      write: (data) => { try { stream.write(data); } catch (_) {} },
      kill: () => { try { stream.end(); } catch (_) {} },
    };
    return { ptyProcess, stop: () => ptyProcess.kill() };
  }

  return { ensureRuntimeContainer, touch, teardown, cullIdle, execInRuntime, _sessions: sessions };
}

module.exports = {
  RUNTIME_IMAGE,
  RUNTIME_NETWORK,
  RUNTIME_IDLE_TTL_MS,
  MAX_RUNTIME_CONTAINERS,
  REPOS_DIR,
  RUNTIME_PRIVILEGED,
  safeName,
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
  createRuntimeManager,
};
