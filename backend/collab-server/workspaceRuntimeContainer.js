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
// When collab-server itself runs as a container (compose/prod), the per-user repo
// dir lives on the SHARED `collab-data` named volume — a host-path bind would point
// the daemon at a non-existent host path. Set WORKSPACE_DATA_VOLUME to that named
// volume so the runtime container mounts the per-user subpath into /workspace via
// the same volume. Empty (default) → host-path bind (collab-server running directly
// on the host / dev-direct). REPOS_VOLUME_SUBPATH is the repo prefix WITHIN the
// volume (collab-data mounts at /data, repos at /data/repos → prefix 'repos').
const WORKSPACE_DATA_VOLUME = process.env.WORKSPACE_DATA_VOLUME || '';
const REPOS_VOLUME_SUBPATH = process.env.REPOS_VOLUME_SUBPATH || 'repos';
// Outer-container privilege. Dev (Docker Desktop/WSL2) needs it so rootless
// dockerd can set up user namespaces; prod (k8s + Sysbox) sets RUNTIME_PRIVILEGED=0
// and supplies a runtimeClass instead. Defaults ON; any value other than '0'/'false' is on.
const RUNTIME_PRIVILEGED = !['0', 'false', 'no'].includes(String(process.env.RUNTIME_PRIVILEGED ?? '').toLowerCase());

// Host/shell system env vars that must come from the runtime container, NOT be
// inherited from collab-server's process when exec'ing a container program.
const HOST_ENV_DENYLIST = new Set([
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'LOGNAME', 'SHELL', 'SHLVL',
  'HOSTNAME', 'TMPDIR', 'TERM', 'NODE_ENV', '_',
]);

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
  dataVolume = WORKSPACE_DATA_VOLUME,
  reposSubpath = REPOS_VOLUME_SUBPATH,
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

    // Slow path: a container with this name may already exist but not be tracked
    // in-memory (collab-server restart, or a prior failed launch). Adopt it if
    // running; otherwise remove it so the create below doesn't 409-conflict.
    try {
      const existing = docker.getContainer(name);
      const info = await existing.inspect();
      if (info && info.State && info.State.Running) {
        sessions.set(key, { containerId: info.Id, lastActive: now });
        return { name, host: name, containerId: info.Id, created: false };
      }
      try { await existing.remove({ force: true }); } catch (_) {}
    } catch (err) {
      if (err && err.statusCode !== 404) throw err; // 404 = no such container → create below
    }

    if (sessions.size >= maxContainers) {
      throw new Error(`Runtime container cap reached (${maxContainers})`);
    }

    // Mount the per-user repo dir into /workspace. Two modes:
    //  - dataVolume set (compose/prod, collab-server is a container): mount the
    //    SHARED named volume with a per-user Subpath so the runtime container and
    //    collab-server see the exact same files. A host-path bind would fail here
    //    because the daemon resolves bind sources on the host, not inside collab.
    //  - dataVolume empty (collab-server on the host): bind the host path directly.
    const workspaceMount = dataVolume
      ? {
          Mounts: [{
            Type: 'volume',
            Source: dataVolume,
            Target: '/workspace',
            VolumeOptions: { Subpath: path.posix.join(reposSubpath, safeName(slug), safeName(userId)) },
          }],
        }
      : { Binds: [`${path.posix.join(reposDir, safeName(slug), safeName(userId))}:/workspace`] };
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
        ...workspaceMount,
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
    };

    const container = await docker.createContainer(createOpts);
    await container.start();
    sessions.set(key, { containerId: container.id, lastActive: now });
    // Use the structured-logger convention (event, data). console (the test
    // default) also accepts this. NB: collab-server's logger has no `.log`.
    logger.info('runtime_container_started', { name, slug, userId });
    return { name, host: name, containerId: container.id, created: true };
  }

  /**
   * Wait until the rootless dockerd INSIDE the runtime container is accepting
   * connections. The container starts in seconds but its daemon takes ~15-25s to
   * be ready, so a program's first `docker ...` command races it. The launch path
   * awaits this between ensureRuntimeContainer and execInRuntime. Returns true if
   * ready, false on timeout.
   */
  async function waitForRuntimeReady(slug, userId, { timeoutMs = 45000, intervalMs = 3000 } = {}) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const exec = await docker.getContainer(s.containerId).exec({
          Cmd: ['docker', 'info', '--format', '{{.ServerVersion}}'],
          AttachStdout: true, AttachStderr: true,
        });
        const stream = await exec.start({});
        await new Promise((res) => {
          if (stream && typeof stream.on === 'function') {
            stream.on('data', () => {});
            stream.on('end', res);
            stream.on('error', res);
          }
          setTimeout(res, intervalMs);
        });
        const info = await exec.inspect();
        if (info && info.ExitCode === 0) return true;
      } catch (_) { /* daemon not up yet */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    logger.warn('runtime_daemon_not_ready', { slug, userId, timeoutMs });
    return false;
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
      if (err.statusCode !== 404) logger.warn('runtime_container_teardown_failed', { id }, err);
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

    // Forward the program's declared env, but NEVER the host/shell system vars
    // inherited from collab-server's process — the runtime container provides its
    // own HOME (/home/rootless), PATH (where `docker` lives), and DOCKER_HOST.
    // Overriding HOME with collab's /home/synthi crashed the program ("mkdir
    // /home/synthi: permission denied"); overriding PATH would hide `docker`.
    const Env = Object.entries(env)
      .filter(([k, v]) => typeof k === 'string' && v != null && !HOST_ENV_DENYLIST.has(k.toUpperCase()))
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

  /**
   * Open an interactive login shell (`bash -l`) inside the runtime container for
   * the in-app terminal. Unlike execInRuntime (which runs one program command),
   * this is a long-lived TTY the user drives directly, so it adds resize(). The
   * shell's environment (PATH, git identity, claude CLI, sudo) comes from the
   * runtime IMAGE via `bash -l`, not from collab-server's process — so there is
   * nothing host-leaked to scrub here; we only set TERM + a friendly PS1.
   * @returns {{ ptyProcess: {onData,onExit,write,kill,resize}, stop } }
   */
  async function execInteractiveShell(slug, userId, { cols = 80, rows = 24 } = {}) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();

    // ~/<workspace> style prompt parity with the host-shell terminal. /workspace
    // is the mount target; show it as "~/workspace" so the path reads cleanly.
    const PS1 = String.raw`\[\e[36m\]~/workspace\[\e[0m\]$ `;
    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: ['/bin/bash', '-l'],
      User: 'rootless',
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', `PS1=${PS1}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/workspace',
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    // Apply the initial terminal size once the exec is live. Docker's resize
    // API is { h: rows, w: cols }. Best-effort — a daemon hiccup here must not
    // kill the session.
    try { await exec.resize({ h: rows, w: cols }); } catch (_) {}

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
      resize: (c, r) => { exec.resize({ h: r, w: c }).catch(() => {}); },
    };
    return { ptyProcess, stop: () => ptyProcess.kill() };
  }

  /**
   * Run a single command in the runtime container and resolve its collected
   * stdout+stderr as a string. Non-TTY (so the dockerode stream is the raw,
   * un-multiplexed-enough output we just concatenate — adequate for parsing
   * /proc/net/tcp). Used by the container port monitor. Best-effort: resolves
   * '' on stream error so a transient daemon hiccup doesn't reject the poll.
   */
  async function runOnce(slug, userId, argv) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();
    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: argv,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({});
    return await new Promise((resolve) => {
      let buf = '';
      if (stream && typeof stream.on === 'function') {
        stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(buf));
      } else {
        resolve('');
      }
    });
  }

  return { ensureRuntimeContainer, waitForRuntimeReady, touch, teardown, cullIdle, execInRuntime, execInteractiveShell, runOnce, _sessions: sessions };
}

module.exports = {
  RUNTIME_IMAGE,
  RUNTIME_NETWORK,
  RUNTIME_IDLE_TTL_MS,
  MAX_RUNTIME_CONTAINERS,
  REPOS_DIR,
  RUNTIME_PRIVILEGED,
  WORKSPACE_DATA_VOLUME,
  REPOS_VOLUME_SUBPATH,
  safeName,
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
  createRuntimeManager,
};
