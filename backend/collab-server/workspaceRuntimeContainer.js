'use strict';

const crypto = require('crypto');
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
const WORKSPACE_DATA_VOLUME_ROOT = process.env.WORKSPACE_DATA_VOLUME_ROOT || '/data';
const RUNTIME_SHARED_GID = /^\d+$/.test(String(process.env.SYNTHI_RUNTIME_SHARED_GID || ''))
  ? String(process.env.SYNTHI_RUNTIME_SHARED_GID)
  : '';
const RUNTIME_WORKSPACE_UMASK = /^(?:0?[0-7]{3,4})$/.test(String(process.env.SYNTHI_RUNTIME_WORKSPACE_UMASK || ''))
  ? String(process.env.SYNTHI_RUNTIME_WORKSPACE_UMASK)
  : '0002';
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

function runtimeWorkspaceDirectory(workspaceRelativePath = '') {
  const normalized = String(workspaceRelativePath || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '/workspace';
  if (normalized.startsWith('/') || path.win32.isAbsolute(normalized)) {
    throw new Error('workspace_runtime_invalid_relative_workspace_path');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('workspace_runtime_invalid_relative_workspace_path');
  }
  return path.posix.join('/workspace', ...parts);
}

function createDockerExecTextDecoder({ tty = true } = {}) {
  let pending = Buffer.alloc(0);
  const decode = (chunk, emit) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
    if (tty) {
      emit(buffer.toString('utf8'));
      return;
    }
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    while (pending.length >= 8) {
      if (!isDockerMultiplexHeader(pending)) {
        emit(pending.toString('utf8'));
        pending = Buffer.alloc(0);
        return;
      }
      const frameLength = pending.readUInt32BE(4);
      if (pending.length < 8 + frameLength) return;
      const payload = pending.subarray(8, 8 + frameLength);
      if (payload.length) emit(payload.toString('utf8'));
      pending = pending.subarray(8 + frameLength);
    }
  };
  const flush = (emit) => {
    if (pending.length) emit(pending.toString('utf8'));
    pending = Buffer.alloc(0);
  };
  return { decode, flush };
}

function isDockerMultiplexHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  const streamType = buffer[0];
  return (streamType === 1 || streamType === 2)
    && buffer[1] === 0
    && buffer[2] === 0
    && buffer[3] === 0;
}

function safeName(value, max = 40) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, max);
}

function shortDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

function codeSiteQuarantineRoot(options = {}) {
  return options.codeSiteQuarantineRoot || options.quarantineRoot || options.codesiteQuarantine?.root || '';
}

function codeSiteOverlayRoots(options = {}) {
  const overlay = options.codesiteOverlay || options.codeSiteOverlay || {};
  const upperRoot = options.codeSiteOverlayUpperRoot || options.overlayUpperRoot || overlay.upperRoot || '';
  const workRoot = options.codeSiteOverlayWorkRoot || options.overlayWorkRoot || overlay.workRoot || '';
  const inferredOverlayRoot = upperRoot && workRoot && path.posix.dirname(upperRoot) === path.posix.dirname(workRoot)
    ? path.posix.dirname(upperRoot)
    : '';
  return {
    baseRoot: options.codeSiteBaseRoot || options.baseRoot || overlay.baseRoot || '',
    overlayRoot: options.codeSiteOverlayRoot || options.overlayRoot || overlay.root || inferredOverlayRoot,
    upperRoot,
    workRoot,
  };
}

function hasCodeSiteOverlay(options = {}) {
  const roots = codeSiteOverlayRoots(options);
  return Boolean(roots.baseRoot && roots.upperRoot && roots.workRoot);
}

function runtimeWorkspaceMode(options = {}) {
  if (hasCodeSiteOverlay(options)) return 'codesite-overlay';
  if (codeSiteQuarantineRoot(options)) return 'quarantine';
  if (options.codeSiteReadonly || options.readonlyWorkspace) return 'readonly';
  return 'readwrite';
}

function runtimeIdentityOptions(options = {}) {
  const mode = runtimeWorkspaceMode(options);
  if (mode === 'codesite-overlay') {
    const roots = codeSiteOverlayRoots(options);
    const identity = options.codeSiteOverlayId ||
      options.overlayId ||
      options.codesiteContext?.transactionId ||
      `${roots.baseRoot}:${roots.overlayRoot}:${roots.upperRoot}:${roots.workRoot}`;
    return { mode, overlayId: shortDigest(identity) };
  }
  if (mode !== 'quarantine') return { mode };
  const identity = options.codeSiteQuarantineId ||
    options.quarantineId ||
    options.codesiteContext?.transactionId ||
    codeSiteQuarantineRoot(options);
  return { mode, quarantineId: shortDigest(identity) };
}

function volumeSubpathForPath(fullPath, volumeRoot = WORKSPACE_DATA_VOLUME_ROOT) {
  if (!fullPath || !volumeRoot) return '';
  const normalizedRoot = path.posix.resolve(volumeRoot);
  const normalizedPath = path.posix.resolve(fullPath);
  const relative = path.posix.relative(normalizedRoot, normalizedPath);
  if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) return '';
  return relative;
}

/** Deterministic, docker-safe container name per workspace+user. */
function runtimeContainerName(slug, userId, options = {}) {
  const { mode, quarantineId, overlayId } = runtimeIdentityOptions(options);
  if (mode === 'codesite-overlay') {
    return `workspace-runtime-${safeName(`${slug}-${userId}`, 30)}-codesite-${overlayId}`;
  }
  if (mode === 'quarantine') {
    return `workspace-runtime-${safeName(`${slug}-${userId}`, 30)}-codesite-${quarantineId}`;
  }
  const suffix = mode === 'readonly' ? '-codesite-ro' : '';
  return `workspace-runtime-${safeName(`${slug}-${userId}${suffix}`)}`;
}

/** On the shared compose network the container is reachable by its name. */
function runtimeContainerHost(slug, userId, options = {}) {
  return runtimeContainerName(slug, userId, options);
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
  dataVolumeRoot = WORKSPACE_DATA_VOLUME_ROOT,
  sharedWorkspaceGid = RUNTIME_SHARED_GID,
  workspaceUmask = RUNTIME_WORKSPACE_UMASK,
  logger = console,
} = {}) {
  if (!docker) throw new TypeError('docker client is required');
  /** key `${slug} ${userId}` -> { containerId, lastActive } */
  const sessions = new Map();
  const keyOf = (slug, userId, options = {}) => {
    const { mode, quarantineId, overlayId } = runtimeIdentityOptions(options);
    const identity = overlayId || quarantineId || '';
    return `${slug} ${userId} ${mode}${identity ? `:${identity}` : ''}`;
  };
  const sessionEntry = (containerId, slug, userId, options, now, name) => ({
    containerId,
    slug,
    userId,
    runtimeIdentity: runtimeIdentityOptions(options),
    runtimeOptions: { ...options },
    host: name || runtimeContainerName(slug, userId, options),
    lastActive: now,
  });

  async function ensureRuntimeContainer(slug, userId, options = {}) {
    const quarantineRoot = codeSiteQuarantineRoot(options);
    const overlayRoots = codeSiteOverlayRoots(options);
    if (options.codesiteContext?.active && !hasCodeSiteOverlay(options)) {
      const error = new Error('codesite_runtime_overlay_required');
      error.code = 'CODESITE_RUNTIME_OVERLAY_REQUIRED';
      throw error;
    }
    if (hasCodeSiteOverlay(options) && !options.codesiteContext?.transactionId) {
      const error = new Error('codesite_runtime_overlay_transaction_required');
      error.code = 'CODESITE_RUNTIME_OVERLAY_TRANSACTION_REQUIRED';
      throw error;
    }
    const mode = runtimeWorkspaceMode(options);
    const name = runtimeContainerName(slug, userId, options);
    const key = keyOf(slug, userId, options);
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
        const labels = info.Config?.Labels || info.Labels || {};
        const existingMode = labels['vectant/codesite-workspace-mode'] || (mode === 'readwrite' ? 'readwrite' : '');
        if (existingMode !== mode) {
          const error = new Error('codesite_runtime_container_mode_mismatch');
          error.code = 'CODESITE_RUNTIME_CONTAINER_MODE_MISMATCH';
          throw error;
        }
        if (mode === 'quarantine' || mode === 'codesite-overlay') {
          const identity = runtimeIdentityOptions(options);
          const expected = mode === 'codesite-overlay' ? identity.overlayId : identity.quarantineId;
          const actual = mode === 'codesite-overlay'
            ? labels['vectant/codesite-overlay-id'] || ''
            : labels['vectant/codesite-quarantine-id'] || '';
          if (actual && actual !== expected) {
            const error = new Error('codesite_runtime_identity_mismatch');
            error.code = 'CODESITE_RUNTIME_IDENTITY_MISMATCH';
            throw error;
          }
        }
        sessions.set(key, sessionEntry(info.Id, slug, userId, options, now, name));
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
    const readonlyWorkspace = mode === 'readonly';
    const quarantineVolumeSubpath = quarantineRoot
      ? (options.codeSiteQuarantineVolumeSubpath || volumeSubpathForPath(quarantineRoot, dataVolumeRoot))
      : '';
    if (mode === 'quarantine' && dataVolume && !quarantineVolumeSubpath) {
      const error = new Error('codesite_runtime_quarantine_volume_unavailable');
      error.code = 'CODESITE_RUNTIME_QUARANTINE_VOLUME_UNAVAILABLE';
      throw error;
    }
    const workspaceMount = mode === 'codesite-overlay'
      ? codeSiteOverlayWorkspaceMount({
          dataVolume,
          dataVolumeRoot,
          overlayRoots,
        })
      : dataVolume
      ? {
          Mounts: [{
            Type: 'volume',
            Source: dataVolume,
            Target: '/workspace',
            ReadOnly: readonlyWorkspace,
            VolumeOptions: {
              Subpath: mode === 'quarantine'
                ? quarantineVolumeSubpath
                : path.posix.join(reposSubpath, safeName(slug), safeName(userId)),
            },
          }],
        }
      : {
          Binds: [
            `${mode === 'quarantine' ? quarantineRoot : path.posix.join(reposDir, safeName(slug), safeName(userId))}:/workspace${readonlyWorkspace ? ':ro' : ''}`,
          ],
        };
    const runtimeEnv = [];
    runtimeEnv.push(`RUNTIME_WORKSPACE_UMASK=${workspaceUmask}`);
    // The collab server and rootless runtime have distinct UIDs.  They share
    // only this workspace group, never broad world-write permissions.
    if (readonlyWorkspace) {
      runtimeEnv.push('CODESITE_WORKSPACE_READONLY=1', 'SYNTHI_CODESITE_WORKSPACE_READONLY=1');
    }
    if (mode === 'quarantine') {
      runtimeEnv.push('CODESITE_WORKSPACE_QUARANTINED=1', 'SYNTHI_CODESITE_WORKSPACE_QUARANTINED=1');
      runtimeEnv.push('CODESITE_QUARANTINE_ROOT=/workspace');
    }
    if (mode === 'codesite-overlay') {
      runtimeEnv.push('CODESITE_WORKSPACE_OVERLAY=1', 'SYNTHI_CODESITE_WORKSPACE_OVERLAY=1');
      runtimeEnv.push('CODESITE_BASE_ROOT=/codesite/base', 'CODESITE_OVERLAY_ROOT=/codesite/overlay', 'CODESITE_OVERLAY_UPPER=/codesite/overlay/upper', 'CODESITE_OVERLAY_WORK=/codesite/overlay/work');
    }
    const { quarantineId, overlayId } = runtimeIdentityOptions(options);
    const createOpts = {
      name,
      Image: image,
      Labels: {
        'vectant/runtime': 'workspace-runtime-local',
        'vectant/slug': String(slug),
        'vectant/userId': String(userId),
        'vectant/codesite-workspace-mode': mode,
        ...(mode === 'quarantine' ? {
          'vectant/codesite-transaction-id': String(options.codesiteContext?.transactionId || ''),
          'vectant/codesite-quarantine-id': quarantineId,
        } : {}),
        ...(mode === 'codesite-overlay' ? {
          'vectant/codesite-transaction-id': String(options.codesiteContext?.transactionId || ''),
          'vectant/codesite-overlay-id': overlayId,
          'vectant/codesite-base-readonly': 'true',
        } : {}),
        'vectant/lastActive': String(now),
      },
      Env: runtimeEnv.length ? runtimeEnv : undefined,
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
    try {
      await container.start();
      if (mode === 'codesite-overlay') {
        await setupCodeSiteOverlayMount(container);
      } else if (mode === 'readwrite' && sharedWorkspaceGid) {
        await setupSharedWorkspaceAccess(container, sharedWorkspaceGid);
      }
    } catch (error) {
      try { await container.remove({ force: true }); } catch (_) {}
      const wrapped = error?.code ? error : new Error(error?.message || 'codesite_runtime_overlay_unavailable');
      if (mode === 'codesite-overlay' && !wrapped.code) wrapped.code = 'CODESITE_RUNTIME_OVERLAY_UNAVAILABLE';
      throw wrapped;
    }
    sessions.set(key, sessionEntry(container.id, slug, userId, options, now, name));
    // Use the structured-logger convention (event, data). console (the test
    // default) also accepts this. NB: collab-server's logger has no `.log`.
    logger.info('runtime_container_started', { name, slug, userId, mode });
    return { name, host: name, containerId: container.id, created: true };
  }

  /**
   * Wait until the rootless dockerd INSIDE the runtime container is accepting
   * connections. The container starts in seconds but its daemon takes ~15-25s to
   * be ready, so a program's first `docker ...` command races it. The launch path
   * awaits this between ensureRuntimeContainer and execInRuntime. Returns true if
   * ready, false on timeout.
   */
  async function waitForRuntimeReady(slug, userId, options = {}) {
    const { timeoutMs = 45000, intervalMs = 3000 } = options;
    const s = sessions.get(keyOf(slug, userId, options));
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

  function touch(slug, userId, options = {}) {
    const s = sessions.get(keyOf(slug, userId, options));
    if (s) s.lastActive = Date.now();
  }

  async function teardown(slug, userId, options = {}) {
    const key = keyOf(slug, userId, options);
    const s = sessions.get(key);
    sessions.delete(key);
    const id = s?.containerId || runtimeContainerName(slug, userId, options);
    await removeRuntimeContainer(id);
  }

  function listRuntimeSessions() {
    return [...sessions.values()].map((entry) => ({
      slug: entry.slug,
      userId: entry.userId,
      mode: entry.runtimeIdentity?.mode || 'readwrite',
      host: entry.host || runtimeContainerName(entry.slug, entry.userId, entry.runtimeOptions),
      containerId: entry.containerId,
      runtimeOptions: { ...(entry.runtimeOptions || {}) },
      runtimeIdentity: { ...(entry.runtimeIdentity || {}) },
      lastActive: entry.lastActive,
    }));
  }

  async function removeRuntimeContainer(id) {
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
        sessions.delete(key);
        await removeRuntimeContainer(entry.containerId);
      }
    }
  }

  async function execInRuntime(slug, userId, { command, env = {}, tty = true, ...runtimeOptions } = {}) {
    const s = sessions.get(keyOf(slug, userId, runtimeOptions));
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
      // Login profiles may reset umask, so apply it after their initialization
      // and before executing the requested command.
      Cmd: ['/bin/sh', '-lc', 'exec /bin/sh -lc \'umask "$RUNTIME_WORKSPACE_UMASK"; exec /bin/sh -c "$1"\' sh "$1"', 'sh', String(command)],
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
    const decoder = createDockerExecTextDecoder({ tty });
    stream.on('data', (chunk) => {
      decoder.decode(chunk, (text) => {
        for (const cb of dataCbs) cb(text);
      });
    });
    stream.on('end', async () => {
      decoder.flush((text) => {
        for (const cb of dataCbs) cb(text);
      });
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
  async function execInteractiveShell(slug, userId, {
    cols = 80,
    rows = 24,
    env = {},
    workspaceRelativePath = '',
    ...runtimeOptions
  } = {}) {
    const s = sessions.get(keyOf(slug, userId, runtimeOptions));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();

    // ~/<workspace> style prompt parity with the host-shell terminal. /workspace
    // is the mount target; show it as "~/workspace" so the path reads cleanly.
    const workingDirectory = runtimeWorkspaceDirectory(workspaceRelativePath);
    const workspaceLabel = workingDirectory === '/workspace'
      ? '~/workspace'
      : `~/workspace/${workingDirectory.slice('/workspace/'.length)}`;
    const PS1 = String.raw`\[\e[36m\]${workspaceLabel}\[\e[0m\]$ `;
    const Env = [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      `PS1=${PS1}`,
      ...Object.entries(env)
        .filter(([k, v]) => typeof k === 'string' && v != null && !HOST_ENV_DENYLIST.has(k.toUpperCase()))
        .map(([k, v]) => `${k}=${v}`),
    ];
    const exec = await docker.getContainer(s.containerId).exec({
      // Preserve normal login setup, then retain its environment in an
      // interactive shell whose umask is the workspace collaboration policy.
      Cmd: ['/bin/bash', '-lc', 'exec /bin/bash -l -c \'umask "$RUNTIME_WORKSPACE_UMASK"; exec /bin/bash\''],
      User: 'rootless',
      Env,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: workingDirectory,
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
  async function runOnce(slug, userId, argv, runtimeOptions = {}) {
    const s = sessions.get(keyOf(slug, userId, runtimeOptions));
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

  return { ensureRuntimeContainer, waitForRuntimeReady, touch, teardown, cullIdle, execInRuntime, execInteractiveShell, runOnce, listRuntimeSessions, _sessions: sessions };
}

function codeSiteOverlayWorkspaceMount({ dataVolume, dataVolumeRoot, overlayRoots }) {
  const overlayRoot = overlayRoots.overlayRoot ||
    (overlayRoots.upperRoot && overlayRoots.workRoot && path.posix.dirname(overlayRoots.upperRoot) === path.posix.dirname(overlayRoots.workRoot)
      ? path.posix.dirname(overlayRoots.upperRoot)
      : '');
  if (!overlayRoot) {
    const error = new Error('codesite_runtime_overlay_root_unavailable');
    error.code = 'CODESITE_RUNTIME_OVERLAY_ROOT_UNAVAILABLE';
    throw error;
  }
  if (dataVolume) {
    const baseSubpath = volumeSubpathForPath(overlayRoots.baseRoot, dataVolumeRoot);
    const overlaySubpath = volumeSubpathForPath(overlayRoot, dataVolumeRoot);
    if (!baseSubpath || !overlaySubpath) {
      const error = new Error('codesite_runtime_overlay_volume_unavailable');
      error.code = 'CODESITE_RUNTIME_OVERLAY_VOLUME_UNAVAILABLE';
      throw error;
    }
    return {
      Mounts: [
        {
          Type: 'volume',
          Source: dataVolume,
          Target: '/codesite/base',
          ReadOnly: true,
          VolumeOptions: { Subpath: baseSubpath },
        },
        {
          Type: 'volume',
          Source: dataVolume,
          Target: '/codesite/overlay',
          VolumeOptions: { Subpath: overlaySubpath },
        },
      ],
    };
  }
  return {
    Binds: [
      `${overlayRoots.baseRoot}:/codesite/base:ro`,
      `${overlayRoot}:/codesite/overlay`,
    ],
  };
}

async function setupCodeSiteOverlayMount(container) {
  const script = [
    'set -eu',
    'mkdir -p /workspace /codesite/base /codesite/overlay/upper /codesite/overlay/work',
    'chown -R rootless:rootless /codesite/overlay/upper /codesite/overlay/work 2>/dev/null || true',
    'if touch /codesite/base/.codesite-write-probe 2>/dev/null; then rm -f /codesite/base/.codesite-write-probe; exit 73; fi',
    'if ! mountpoint -q /workspace 2>/dev/null; then',
    '  mount -t overlay overlay -o lowerdir=/codesite/base,upperdir=/codesite/overlay/upper,workdir=/codesite/overlay/work /workspace || fuse-overlayfs -o lowerdir=/codesite/base -o upperdir=/codesite/overlay/upper -o workdir=/codesite/overlay/work /workspace',
    'fi',
    'test -r /codesite/base',
    'test -w /workspace',
    'touch /workspace/.codesite-overlay-write-probe && rm -f /workspace/.codesite-overlay-write-probe',
    'if command -v su >/dev/null 2>&1; then',
    '  probe_dir="$(find /workspace -mindepth 1 -maxdepth 4 -type d 2>/dev/null | head -n 1 || true)"',
    '  if [ -n "$probe_dir" ]; then',
    '    env PROBE_DIR="$probe_dir" su rootless -c \'touch "$PROBE_DIR/.codesite-overlay-rootless-probe" && rm -f "$PROBE_DIR/.codesite-overlay-rootless-probe"\'',
    '  else',
    '    su rootless -c \'touch /workspace/.codesite-overlay-rootless-probe && rm -f /workspace/.codesite-overlay-rootless-probe\'',
    '  fi',
    'fi',
    '(grep -E " /workspace .* - (overlay|fuse-overlayfs|fuse\\.fuse-overlayfs) " /proc/self/mountinfo >/dev/null) || (findmnt -n -T /workspace 2>/dev/null | grep -E "overlay|fuse-overlayfs" >/dev/null) || (mount | grep " on /workspace " | grep -E "overlay|fuse-overlayfs" >/dev/null)',
  ].join('\n');
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-lc', script],
    User: 'root',
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  await waitForExecStream(stream, 30_000);
  const info = typeof exec.inspect === 'function' ? await exec.inspect() : { ExitCode: 0 };
  if (info?.ExitCode !== 0) {
    const error = new Error('codesite_runtime_overlay_unavailable');
    error.code = 'CODESITE_RUNTIME_OVERLAY_UNAVAILABLE';
    error.exitCode = info?.ExitCode;
    throw error;
  }
}

async function setupSharedWorkspaceAccess(container, groupId) {
  const script = [
    'set -eu',
    'test -d /workspace',
    `shared_gid=${JSON.stringify(groupId)}`,
    // Directory setgid inherits the collaboration group for every new child.
    'find /workspace -xdev -type d -exec chgrp "$shared_gid" {} + -exec chmod g+rwx,g+s {} +',
    // Preserve executable bits while allowing either trusted workspace actor
    // to update ordinary files.  find does not follow symlinks.
    'find /workspace -xdev -type f -exec chgrp "$shared_gid" {} + -exec chmod g+rw {} +',
  ].join('\n');
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-lc', script],
    User: 'root',
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  await waitForExecStream(stream, 30_000);
  const info = typeof exec.inspect === 'function' ? await exec.inspect() : { ExitCode: 0 };
  if (info?.ExitCode !== 0) {
    const error = new Error('workspace_runtime_shared_access_unavailable');
    error.code = 'WORKSPACE_RUNTIME_SHARED_ACCESS_UNAVAILABLE';
    error.exitCode = info?.ExitCode;
    throw error;
  }
}

async function waitForExecStream(stream, timeoutMs = 30_000) {
  if (!stream || typeof stream.on !== 'function') return;
  await new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    stream.on('data', () => {});
    stream.on('end', finish);
    stream.on('error', finish);
    timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
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
  WORKSPACE_DATA_VOLUME_ROOT,
  safeName,
  volumeSubpathForPath,
  runtimeContainerName,
  runtimeContainerHost,
  runtimeWorkspaceDirectory,
  shouldCull,
  createRuntimeManager,
};
