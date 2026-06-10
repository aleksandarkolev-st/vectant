'use strict';

const DEFAULT_HEADLESS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_CAP = 50_000;

const BLOCKED_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCS_BUCKET',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_PORT',
  'REDIS_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'PRISMA_DATABASE_URL',
  // NOTE: DOCKER_HOST is intentionally NOT key-blocked. A per-workspace runtime
  // container sets DOCKER_HOST to its own in-container rootless socket so that
  // `docker`/`docker compose` work inside container programs. The HOST socket is
  // still denied by VALUE via BLOCKED_ENV_VALUE_FRAGMENTS below.
  'DOCKER_SOCKET',
  'DOCKER_CERT_PATH',
  'YSWEET_AUTH_KEY',
  'NEXTAUTH_SECRET',
  'AUTH_SECRET',
]);

const BLOCKED_ENV_PREFIXES = [
  'DATABASE_',
  'GCP_',
  'GOOGLE_',
  'KUBERNETES_',
  'K8S_',
  'POSTGRES_',
  'REDIS_',
  'PRISMA_',
  'YSWEET_',
  'NEXTAUTH_',
  'SYNTHI_PLATFORM_',
  'SYNTHI_DB_',
  'SYNTHI_GCS_',
];

const BLOCKED_ENV_VALUE_FRAGMENTS = [
  '/var/run/docker.sock',
  '\\\\.\\pipe\\docker_engine',
];

function toPublicManagedSession(record) {
  if (!record) {
    return null;
  }

  const {
    runtime,
    idleTimer,
    healthTimer,
    health,
    runtimeDataDisposable,
    runtimeExitDisposable,
    launchRequest,
    ...publicRecord
  } = record;

  return {
    ...publicRecord,
    activePorts: [...publicRecord.activePorts],
  };
}

function normalizePorts(value) {
  const ports = Array.isArray(value) ? value : [];
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0))].sort((left, right) => left - right);
}

const RUNNING_STATES = ['starting', 'running', 'unhealthy'];

function samePorts(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Attribute a globally-detected port set to managed sessions.
 *   1. Each running session claims its declared ports that are currently live.
 *   2. Any still-unclaimed live port is given to the single running session that
 *      declared NO ports (the auto-binding dev-server case); ambiguous → dropped.
 * @returns {Map<string, number[]>} sessionId → attributed ports (sorted, deduped)
 */
function attributeSessionPorts({ sessions = [], detectedPorts = [] } = {}) {
  const detected = new Set(normalizePorts(detectedPorts));
  const running = sessions.filter((s) => RUNNING_STATES.includes(s.state));
  const result = new Map();
  const claimed = new Set();

  for (const session of running) {
    const declared = normalizePorts(session.declaredPorts || []);
    const live = declared.filter((port) => detected.has(port));
    result.set(session.sessionId, live);
    live.forEach((port) => claimed.add(port));
  }

  const undeclaredLive = [...detected].filter((port) => !claimed.has(port));
  const noDeclared = running.filter((s) => normalizePorts(s.declaredPorts || []).length === 0);
  if (undeclaredLive.length && noDeclared.length === 1) {
    const target = noDeclared[0].sessionId;
    result.set(target, normalizePorts([...(result.get(target) || []), ...undeclaredLive]));
  }

  return result;
}

/**
 * Choose the primary web port for the App surface from a session's attributed
 * ports: null when there are none, else the first declared port that is live,
 * else the lowest attributed port. Port ownership is already decided by
 * attributeSessionPorts, so no runtime-type gate is applied here.
 */
function selectWebPort({ declaredPorts = [] } = {}, attributedPorts = []) {
  const ports = normalizePorts(attributedPorts);
  if (!ports.length) return null;
  const declaredLive = normalizePorts(declaredPorts).find((port) => ports.includes(port));
  return declaredLive ?? ports[0];
}

function cloneEvent(event) {
  return {
    ...event,
    data: event.data == null ? null : { ...event.data },
  };
}

function buildManagedRuntimeEnv(baseEnv = process.env, overrides = {}) {
  const merged = {
    ...(baseEnv || {}),
    ...(overrides || {}),
  };

  for (const key of Object.keys(merged)) {
    const upperKey = key.toUpperCase();
    const value = merged[key];
    if (BLOCKED_ENV_KEYS.has(upperKey) || BLOCKED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      delete merged[key];
      continue;
    }

    if (
      typeof value === 'string' &&
      BLOCKED_ENV_VALUE_FRAGMENTS.some((fragment) => value.toLowerCase().includes(fragment.toLowerCase()))
    ) {
      delete merged[key];
    }
  }

  return merged;
}

/**
 * Compose an install/launch recipe into one shell command.
 *
 * `cd "<workingDir>" && <install[0]> && ... && <launch>` — real recipe
 * semantics: a failed install step short-circuits the `&&` chain before launch
 * and exits non-zero, which the existing exit handler marks as `crashed`.
 */
function composeProgramCommand({ install = [], launch, workingDir = '' } = {}) {
  const parts = [];
  if (workingDir) {
    parts.push(`cd "${String(workingDir).replace(/"/g, '\\"')}"`);
  }
  for (const step of Array.isArray(install) ? install : []) {
    if (typeof step === 'string' && step.trim()) {
      parts.push(step.trim());
    }
  }
  const launchCmd = String(launch || '').trim();
  if (launchCmd) {
    parts.push(launchCmd);
  }
  return parts.join(' && ');
}

const HEALTH_MIN_INTERVAL_MS = 2000;
const HEALTH_DEFAULT_INTERVAL_MS = 10_000;

function clampHealthInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return HEALTH_DEFAULT_INTERVAL_MS;
  return Math.max(HEALTH_MIN_INTERVAL_MS, ms);
}

/** Coerce a manifest health target to a PATH only — never an absolute URL/host. */
function healthPath(target) {
  let path = String(target || '/').trim();
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // strip scheme://host if present
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

function defaultHttpProbe(url) {
  return new Promise((resolve) => {
    try {
      const req = require('http').get(url, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
      });
      req.setTimeout(2000, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.on('error', () => resolve({ ok: false, status: 0 }));
    } catch (_) {
      resolve({ ok: false, status: 0 });
    }
  });
}

function createProgramRuntimeManager(options = {}) {
  const {
    activeSessions,
    headlessTtlMs = DEFAULT_HEADLESS_TTL_MS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    outputCap = DEFAULT_OUTPUT_CAP,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logger = console,
    now = () => Date.now(),
    launchRuntime = null,
    getActivePorts = () => [],
    baseEnv = process.env,
    probeHost = process.env.PROXY_TARGET_HOST || '127.0.0.1',
    httpProbe = defaultHttpProbe,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;
  const managedSessions = new Map();

  if (!activeSessions || typeof activeSessions.get !== 'function' || typeof activeSessions.delete !== 'function') {
    throw new TypeError('activeSessions map is required');
  }

  function clearManagedIdleTimer(record) {
    if (record?.idleTimer) {
      clearTimeoutFn(record.idleTimer);
      record.idleTimer = null;
    }
  }

  function appendManagedSessionEvent(record, type, data = null) {
    const event = {
      type,
      createdAt: now(),
      data: data == null ? null : { ...data },
    };

    record.events.push(event);
    return cloneEvent(event);
  }

  function disposeManagedRuntimeListeners(record) {
    try { record?.runtimeDataDisposable?.dispose?.(); } catch (_) {}
    try { record?.runtimeExitDisposable?.dispose?.(); } catch (_) {}
    if (record) {
      record.runtimeDataDisposable = null;
      record.runtimeExitDisposable = null;
    }
  }

  function scheduleManagedIdleTimer(sessionId) {
    const idleTimer = setTimeoutFn(async () => {
      const record = managedSessions.get(sessionId);
      if (!record) {
        return;
      }

      const idleForMs = now() - record.lastActivityAt;
      if (!['starting', 'running', 'unhealthy'].includes(record.state)) {
        return;
      }
      if (idleForMs < idleTtlMs) {
        clearManagedIdleTimer(record);
        record.idleTimer = scheduleManagedIdleTimer(sessionId);
        return;
      }

      await stopManagedSession(sessionId, { reason: 'idle_cull' });
    }, idleTtlMs);

    if (typeof idleTimer?.unref === 'function') {
      idleTimer.unref();
    }

    return idleTimer;
  }

  function rescheduleManagedIdleTimer(record) {
    clearManagedIdleTimer(record);
    record.idleTimer = scheduleManagedIdleTimer(record.sessionId);
  }

  function attachManagedRuntimeListeners(record) {
    const ptyProcess = record?.runtime?.ptyProcess;
    if (!ptyProcess) {
      return;
    }

    record.runtimeDataDisposable = ptyProcess.onData?.((chunk) => {
      appendManagedSessionOutput(record.sessionId, chunk);
    }) || null;

    record.runtimeExitDisposable = ptyProcess.onExit?.((payload = {}) => {
      finalizeManagedSessionExit(record.sessionId, payload.exitCode ?? null);
    }) || null;
  }

  function finalizeManagedSessionExit(sessionId, exitCode = null) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }

    clearManagedIdleTimer(record);
    clearManagedHealthTimer(record);
    disposeManagedRuntimeListeners(record);
    record.runtime = null;
    record.exitCode = exitCode;
    record.lastActivityAt = now();

    if (record.stopReason) {
      record.state = 'stopped';
    } else if ((exitCode ?? 0) === 0) {
      record.state = 'stopped';
      record.stopReason = 'process_exit';
    } else {
      record.state = 'crashed';
      record.stopReason = 'process_exit';
    }

    appendManagedSessionEvent(record, 'state_changed', {
      state: record.state,
      exitCode: record.exitCode,
      stopReason: record.stopReason,
    });

    return toPublicManagedSession(record);
  }

  function appendManagedSessionOutput(sessionId, chunk) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }

    const text = String(chunk || '');
    if (!text) {
      return toPublicManagedSession(record);
    }

    const previousState = record.state;
    record.state = 'running';
    record.lastActivityAt = now();
    record.lastOutputAt = record.lastActivityAt;
    record.output = `${record.output}${text}`;
    if (record.output.length > outputCap) {
      const alreadyTruncated = record.outputTruncated;
      record.output = record.output.slice(-outputCap);
      record.outputTruncated = true;
      if (!alreadyTruncated) {
        appendManagedSessionEvent(record, 'output_truncated', {
          outputCap,
        });
      }
    }
    if (previousState !== 'running') {
      appendManagedSessionEvent(record, 'state_changed', { state: 'running' });
    }
    rescheduleManagedIdleTimer(record);

    return toPublicManagedSession(record);
  }

  function createHeadlessSessionLifecycle(sessionId, { ptyProcess, bufferDisposable } = {}) {
    if (!sessionId) {
      throw new TypeError('sessionId is required');
    }
    if (!ptyProcess || typeof ptyProcess.kill !== 'function') {
      throw new TypeError('ptyProcess.kill is required');
    }

    let bufferingStopped = false;
    const stopBuffering = () => {
      if (bufferingStopped) {
        return;
      }
      bufferingStopped = true;
      try { bufferDisposable?.dispose?.(); } catch (_) {}
    };

    const orphanTimer = setTimeoutFn(() => {
      const session = activeSessions.get(sessionId);
      if (!session || !session.headless) {
        return;
      }

      logger.warn(
        `[Terminal] Headless session ${sessionId} orphaned for ${headlessTtlMs}ms - killing PTY`
      );
      stopBuffering();
      try { ptyProcess.kill(); } catch (_) {}
      activeSessions.delete(sessionId);
    }, headlessTtlMs);

    if (typeof orphanTimer?.unref === 'function') {
      orphanTimer.unref();
    }

    return {
      stopBuffering,
      orphanTimer,
    };
  }

  function promoteHeadlessSession(session) {
    if (!session) {
      return session;
    }

    if (session.orphanTimer) {
      clearTimeoutFn(session.orphanTimer);
    }
    if (typeof session.stopBuffering === 'function') {
      session.stopBuffering();
    }

    return session;
  }

  async function launchManagedSession({
    sessionId,
    workspaceSlug,
    userId = '',
    command,
    env = {},
    runtimeType = 'cli',
    title = null,
    metadata = null,
    ports = [],
    health = null,
  } = {}) {
    if (typeof launchRuntime !== 'function') {
      throw new TypeError('launchRuntime is required');
    }

    const trimmedCommand = String(command || '').trim();
    if (!sessionId) {
      throw new TypeError('sessionId is required');
    }
    if (!workspaceSlug) {
      throw new TypeError('workspaceSlug is required');
    }
    if (!trimmedCommand) {
      throw new TypeError('command is required');
    }

    const currentTime = now();
    const safeEnv = buildManagedRuntimeEnv(baseEnv, env);
    // Phase 2 surfaces *declared* manifest ports immediately (Phase 3 adds
    // live auto-detection via refreshManagedSessionPorts).
    const declaredPorts = normalizePorts(ports);

    const existing = managedSessions.get(sessionId);
    if (existing?.runtime) {
      await stopManagedSession(sessionId, { reason: 'restart', state: 'starting' });
    }

    const runtime = await launchRuntime({
      sessionId,
      workspaceSlug,
      userId,
      command: trimmedCommand,
      env: safeEnv,
      runtimeType,
      title,
      metadata,
    });

    const record = {
      sessionId,
      workspaceSlug,
      userId,
      runtimeType,
      title: title || trimmedCommand,
      state: 'starting',
      startedAt: currentTime,
      lastActivityAt: currentTime,
      lastOutputAt: null,
      output: '',
      outputTruncated: false,
      activePorts: declaredPorts,
      webPort: selectWebPort({ declaredPorts }, declaredPorts),
      declaredPorts,
      health: health && typeof health === 'object' ? health : null,
      healthState: 'unknown',
      healthTimer: null,
      exitCode: null,
      stopReason: null,
      metadata,
      commandPreview: trimmedCommand,
      events: [],
      launchRequest: {
        sessionId,
        workspaceSlug,
        userId,
        command: trimmedCommand,
        env,
        runtimeType,
        title,
        metadata,
        ports: declaredPorts,
        health: health && typeof health === 'object' ? health : null,
      },
      runtime,
      runtimeDataDisposable: null,
      runtimeExitDisposable: null,
      idleTimer: null,
    };

    managedSessions.set(sessionId, record);
    attachManagedRuntimeListeners(record);
    record.idleTimer = scheduleManagedIdleTimer(sessionId);
    scheduleManagedHealthCheck(record);
    appendManagedSessionEvent(record, 'launched', {
      workspaceSlug,
      runtimeType,
      title: record.title,
    });

    return toPublicManagedSession(record);
  }

  /**
   * Launch a managed session from a NormalizedProgramConfig recipe: compose the
   * install + launch commands, carry declared env (scrubbed) + declared ports.
   */
  async function launchManagedProgram({ sessionId, workspaceSlug, userId = '', config, title = null, metadata = null } = {}) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('config is required');
    }
    const command = composeProgramCommand(config);
    return launchManagedSession({
      sessionId,
      workspaceSlug,
      userId,
      command,
      env: config.env || {},
      runtimeType: config.runtimeType || 'cli',
      title: title || config.displayName || config.packageId || null,
      ports: Array.isArray(config.ports) ? config.ports : [],
      health: config.health || null,
      metadata: metadata || {
        packageId: config.packageId || null,
        version: config.version || null,
        source: config.source || null,
      },
    });
  }

  async function stopManagedSession(sessionId, { reason = 'user_stop', state = 'stopped' } = {}) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }

    clearManagedIdleTimer(record);
    clearManagedHealthTimer(record);
    disposeManagedRuntimeListeners(record);

    const runtime = record.runtime;
    record.runtime = null;
    record.state = state;
    record.stopReason = reason;
    record.lastActivityAt = now();

    try { runtime?.stop?.(); } catch (_) {}
    try { runtime?.ptyProcess?.kill?.(); } catch (_) {}

    appendManagedSessionEvent(record, 'state_changed', {
      state: record.state,
      stopReason: record.stopReason,
    });

    return toPublicManagedSession(record);
  }

  async function restartManagedSession(sessionId) {
    const record = managedSessions.get(sessionId);
    if (!record?.launchRequest) {
      return null;
    }

    return launchManagedSession(record.launchRequest);
  }

  /**
   * Re-attribute a globally-detected port set across all managed sessions and
   * update each session's activePorts/webPort, emitting `ports_updated` only on
   * an actual change. Returns the public snapshots that changed.
   */
  function recomputeManagedPorts(detectedPorts) {
    const sessions = [...managedSessions.values()].map((record) => ({
      sessionId: record.sessionId,
      state: record.state,
      declaredPorts: record.declaredPorts || [],
    }));
    const attribution = attributeSessionPorts({ sessions, detectedPorts });
    const updated = [];

    for (const [sessionId, ports] of attribution) {
      const record = managedSessions.get(sessionId);
      if (!record) {
        continue;
      }
      const nextWebPort = selectWebPort({ declaredPorts: record.declaredPorts || [] }, ports);
      if (samePorts(record.activePorts, ports) && record.webPort === nextWebPort) {
        continue;
      }
      record.activePorts = ports;
      record.webPort = nextWebPort;
      record.lastActivityAt = now();
      appendManagedSessionEvent(record, 'ports_updated', {
        activePorts: [...ports],
        webPort: nextWebPort,
      });
      updated.push(toPublicManagedSession(record));
    }

    return updated;
  }

  async function refreshManagedSessionPorts(sessionId) {
    const detected = normalizePorts(await Promise.resolve(getActivePorts()));
    recomputeManagedPorts(detected);
    return getManagedSession(sessionId);
  }

  function clearManagedHealthTimer(record) {
    if (record?.healthTimer) {
      clearIntervalFn(record.healthTimer);
      record.healthTimer = null;
    }
  }

  /**
   * Run one HTTP health probe against the session's OWN web port. The manifest
   * health target is treated as a path only (`healthPath` strips any scheme/host),
   * so a manifest can never aim the probe at an arbitrary host (SSRF guard).
   */
  async function probeManagedSessionHealth(sessionId) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }
    if (!record.health || record.health.type !== 'http' || !record.webPort || !RUNNING_STATES.includes(record.state)) {
      return toPublicManagedSession(record);
    }

    const url = `http://${probeHost}:${record.webPort}${healthPath(record.health.target)}`;
    let ok = false;
    try {
      const result = await httpProbe(url);
      ok = !!result && result.ok === true;
    } catch (_) {
      ok = false;
    }

    const nextState = ok ? 'ok' : 'unhealthy';
    if (record.healthState !== nextState) {
      record.healthState = nextState;
      appendManagedSessionEvent(record, 'health_changed', { healthState: nextState });
    }
    return toPublicManagedSession(record);
  }

  function scheduleManagedHealthCheck(record) {
    if (!record?.health || record.health.type !== 'http') {
      return;
    }
    clearManagedHealthTimer(record);
    const interval = clampHealthInterval(record.health.intervalMs);
    const timer = setIntervalFn(() => {
      probeManagedSessionHealth(record.sessionId).catch(() => {});
    }, interval);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    record.healthTimer = timer;
  }

  function getManagedSession(sessionId) {
    return toPublicManagedSession(managedSessions.get(sessionId));
  }

  function getManagedRuntime(sessionId) {
    return managedSessions.get(sessionId)?.runtime || null;
  }

  function listManagedSessions() {
    return [...managedSessions.values()].map(toPublicManagedSession);
  }

  function listManagedSessionEvents(sessionId) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return [];
    }

    return record.events.map(cloneEvent);
  }

  return {
    buildManagedRuntimeEnv,
    createHeadlessSessionLifecycle,
    finalizeManagedSessionExit,
    getManagedRuntime,
    getManagedSession,
    launchManagedSession,
    launchManagedProgram,
    listManagedSessionEvents,
    listManagedSessions,
    probeManagedSessionHealth,
    recomputeManagedPorts,
    refreshManagedSessionPorts,
    restartManagedSession,
    stopManagedSession,
    promoteHeadlessSession,
  };
}

module.exports = {
  createProgramRuntimeManager,
  DEFAULT_HEADLESS_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_OUTPUT_CAP,
  buildManagedRuntimeEnv,
  composeProgramCommand,
  attributeSessionPorts,
  selectWebPort,
  samePorts,
  healthPath,
  clampHealthInterval,
};