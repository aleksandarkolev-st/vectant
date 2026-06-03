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
  'DOCKER_HOST',
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
      activePorts: [],
      webPort: null,
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
      },
      runtime,
      runtimeDataDisposable: null,
      runtimeExitDisposable: null,
      idleTimer: null,
    };

    managedSessions.set(sessionId, record);
    attachManagedRuntimeListeners(record);
    record.idleTimer = scheduleManagedIdleTimer(sessionId);
    appendManagedSessionEvent(record, 'launched', {
      workspaceSlug,
      runtimeType,
      title: record.title,
    });

    return toPublicManagedSession(record);
  }

  async function stopManagedSession(sessionId, { reason = 'user_stop', state = 'stopped' } = {}) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }

    clearManagedIdleTimer(record);
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

  async function refreshManagedSessionPorts(sessionId) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }

    const ports = normalizePorts(await Promise.resolve(getActivePorts(record)));
    record.activePorts = ports;
    record.webPort = ports[0] ?? null;
    record.lastActivityAt = now();
    appendManagedSessionEvent(record, 'ports_updated', {
      activePorts: [...record.activePorts],
      webPort: record.webPort,
    });

    return toPublicManagedSession(record);
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
    listManagedSessionEvents,
    listManagedSessions,
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
};