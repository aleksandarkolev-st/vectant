'use strict';

const { PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const spawner = require('./spawner');
const { isSysboxRuntimeEnabled } = require('./runtimePodSpec');
const { persistentRuntimeShellSetup } = require('./runtimePersistence');

const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const CONTAINER_NAME = process.env.SYNTHI_TERMINAL_K8S_CONTAINER || 'worker';
// Sysbox runtime pod: terminals route into its `runtime` container (matches
// runtimePodSpec.buildRuntimeDeployment) where the workspace's own dockerd lives;
// the workspace is mounted at /workspace there (vs the worker's WORKSPACE_DIR).
const RUNTIME_POD_CONTAINER = 'runtime';
const RUNTIME_POD_WORKSPACE_MOUNT = '/workspace';

function sanitizeDimension(value, fallback, max) {
  const number = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, number));
}

class ResizablePassThrough extends PassThrough {
  constructor({ cols = 80, rows = 24 } = {}) {
    super();
    this.columns = sanitizeDimension(cols, 80, 500);
    this.rows = sanitizeDimension(rows, 24, 200);
  }

  resize(cols, rows) {
    this.columns = sanitizeDimension(cols, this.columns, 500);
    this.rows = sanitizeDimension(rows, this.rows, 200);
    this.emit('resize');
  }
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function shouldUseRuntimePodTerminal(runtimeScope) {
  return Boolean(
    runtimeScope &&
    process.env.SYNTHI_TERMINAL_BACKEND === 'k8s-exec' &&
    spawner.mode === 'k8s'
  );
}

/**
 * Pure terminal-target selector. When the Sysbox per-workspace runtime backend is
 * ON, terminals exec into the RUNTIME pod's `runtime` container (the workspace's
 * own dockerd lives there, so `docker`/`kind` work). When OFF, preserve the
 * existing worker-pod k8s-exec path (`worker` container). Read at call time so it
 * tracks the flag (and is unit-testable by passing the value explicitly).
 */
function runtimeTerminalTarget(sysboxEnabled = isSysboxRuntimeEnabled()) {
  return sysboxEnabled
    ? { useSysboxRuntime: true, container: RUNTIME_POD_CONTAINER }
    : { useSysboxRuntime: false, container: CONTAINER_NAME };
}

/**
 * Pure launch-target decision for a managed program (Slice 1 — real programs).
 * `container` programs route to the Sysbox runtime pod when the backend is on
 * (precedence over the dev-hybrid container), else the hybrid runtime container,
 * else `unavailable` (fail loud — never the docker-less headless PTY, where
 * DOCKER_HOST is scrubbed). Non-container programs always use the headless PTY.
 */
function programRuntimeTarget({ runtimeType, sysboxEnabled, hasHybrid } = {}) {
  if (runtimeType !== 'container') return { target: 'headless' };
  if (sysboxEnabled) return { target: 'sysbox-pod' };
  if (hasHybrid) return { target: 'hybrid' };
  return { target: 'unavailable' };
}

/**
 * Resolve a workspace's runtime scope (= its collab session id) from its slug,
 * among the active runtime sessions ([{slug, runtimeScope}]). The program-launch
 * payload carries slug, not the collab session id; the runtime pod is pre-warmed
 * at workspace mount so its Deployment is listed by the time a program launches.
 */
function pickRuntimeScopeForSlug(sessions, slug) {
  const list = Array.isArray(sessions) ? sessions : [];
  const match = list.find((s) => s && s.slug === slug && s.runtimeScope);
  return match ? match.runtimeScope : null;
}

function kubeConfig() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  return kc;
}

class RuntimePodPty {
  constructor({ ws, stdin, stdout, stderr, pid }) {
    this._ws = ws;
    this._stdin = stdin;
    this._stdout = stdout;
    this.pid = pid;
    this._dataHandlers = new Set();
    this._exitHandlers = new Set();
    this._exited = false;

    const forward = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const handler of this._dataHandlers) {
        try { handler(text); } catch (_) { /* ignore listener failures */ }
      }
    };

    stdout.on('data', forward);
    stderr.on('data', forward);

    const exit = (code = 0, signal = null) => {
      if (this._exited) return;
      this._exited = true;
      for (const handler of this._exitHandlers) {
        try { handler({ exitCode: code, signal }); } catch (_) { /* ignore listener failures */ }
      }
    };

    ws.on('close', () => exit(0, null));
    ws.on('error', () => exit(1, 'error'));
  }

  onData(handler) {
    this._dataHandlers.add(handler);
    return { dispose: () => this._dataHandlers.delete(handler) };
  }

  onExit(handler) {
    this._exitHandlers.add(handler);
    return { dispose: () => this._exitHandlers.delete(handler) };
  }

  write(data) {
    if (this._stdin.destroyed || this._stdin.writableEnded) return;
    this._stdin.write(data);
  }

  resize(cols, rows) {
    if (typeof this._stdout?.resize !== 'function') return;
    this._stdout.resize(cols, rows);
  }

  kill() {
    try { this._stdin.end('exit\n'); } catch (_) { /* ignore */ }
    try { this._ws.close(); } catch (_) { /* ignore */ }
  }
}

/**
 * Build the `bash -lc` script run inside the runtime pod: export the given env,
 * cd into the workspace mount, then run `finalCommand`. Shared by the interactive
 * terminal (createRuntimePodPty) and the program exec (createRuntimePodProgram).
 * DOCKER_HOST is never added here — it is inherited from the runtime container's
 * own pod-level env. Optional `setup` (e.g. persistentRuntimeShellSetup()) is
 * injected right after the env exports.
 */
function buildRuntimeShellScript({ env = {}, cwd, finalCommand, setup }) {
  const exports = Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  return [
    exports,
    setup,
    `export WORKSPACE_DIR=${shellQuote(cwd)}`,
    'mkdir -p "$WORKSPACE_DIR"',
    'cd "$WORKSPACE_DIR"',
    finalCommand,
  ].filter(Boolean).join('; ');
}

async function createRuntimePodPty({
  runtimeScope,
  workspaceSlug,
  actorUserId,
  filesystemUserId,
  cwd,
  env = {},
  cols = 80,
  rows = 24,
}) {
  if (!runtimeScope) throw new Error('runtimeScope is required for runtime pod terminal');
  const safeCols = sanitizeDimension(cols, 80, 500);
  const safeRows = sanitizeDimension(rows, 24, 200);

  // Route to the Sysbox runtime pod (its own dockerd) when the flag is on; else
  // preserve the worker-pod exec. effectiveCwd is the runtime pod's /workspace
  // mount in the sysbox case (vs the worker's passed-in cwd).
  const target = runtimeTerminalTarget();
  const actor = actorUserId || filesystemUserId || runtimeScope;
  const podMeta = { workspaceSlug, runtimeKind: 'terminal', filesystemUserId };
  const pod = target.useSysboxRuntime
    ? await spawner.spawnRuntimePod(runtimeScope, actor, podMeta)
    : await spawner.ensurePod(runtimeScope, actor, podMeta);
  if (!pod?.podName) {
    throw new Error(`Runtime pod for ${runtimeScope} is not ready`);
  }
  const effectiveCwd = target.useSysboxRuntime ? RUNTIME_POD_WORKSPACE_MOUNT : cwd;

  const terminalEnv = {
    ...env,
    TERM: env.TERM || 'xterm-256color',
    COLORTERM: env.COLORTERM || 'truecolor',
    COLUMNS: String(safeCols),
    LINES: String(safeRows),
  };
  const commandScript = buildRuntimeShellScript({
    env: terminalEnv,
    cwd: effectiveCwd,
    setup: persistentRuntimeShellSetup(),
    finalCommand: `stty rows ${safeRows} cols ${safeCols} 2>/dev/null || true; exec /bin/bash --login -i`,
  });

  const stdout = new ResizablePassThrough({ cols: safeCols, rows: safeRows });
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const exec = new k8s.Exec(kubeConfig());
  const ws = await exec.exec(
    NAMESPACE,
    pod.podName,
    target.container,
    ['/bin/bash', '-lc', commandScript],
    stdout,
    stderr,
    stdin,
    true,
    () => {},
  );

  return {
    ptyProcess: new RuntimePodPty({
      ws,
      stdin,
      stdout,
      stderr,
      pid: pod.podName,
    }),
    shell: '/bin/bash',
    podName: pod.podName,
  };
}

/**
 * Non-interactive program exec into the ready Sysbox runtime pod's `runtime`
 * container. Streams stdout/stderr via RuntimePodPty (onData/onExit/kill) so it
 * plugs into the managed-session listeners. DOCKER_HOST is inherited from the
 * container's own pod-level env — never injected here.
 */
async function createRuntimePodProgram({ runtimeScope, workspaceSlug, userId, command, env = {}, cols = 120, rows = 30 }) {
  if (!runtimeScope) throw new Error('runtimeScope is required for runtime pod program');
  const actor = userId || runtimeScope;
  await spawner.spawnRuntimePod(runtimeScope, actor, { workspaceSlug, runtimeKind: 'program', filesystemUserId: userId });
  const ready = await waitForReadyRuntimePod(runtimeScope);
  if (!ready || !ready.podName) throw new Error('runtime_pod_not_ready');

  const safeCols = sanitizeDimension(cols, 120, 500);
  const safeRows = sanitizeDimension(rows, 30, 200);
  const script = buildRuntimeShellScript({
    env: { ...env, TERM: env.TERM || 'xterm-256color', COLUMNS: String(safeCols), LINES: String(safeRows) },
    cwd: RUNTIME_POD_WORKSPACE_MOUNT,
    finalCommand: command,
  });
  const stdout = new ResizablePassThrough({ cols: safeCols, rows: safeRows });
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const exec = new k8s.Exec(kubeConfig());
  const ws = await exec.exec(NAMESPACE, ready.podName, RUNTIME_POD_CONTAINER, ['/bin/bash', '-lc', script], stdout, stderr, stdin, true, () => {});
  return {
    ptyProcess: new RuntimePodPty({ ws, stdin, stdout, stderr, pid: ready.podName }),
    runtimeScope,
    podName: ready.podName,
  };
}

/** Poll for the ready runtime pod (all containers ready ⇒ dockerd answered its probe). */
async function waitForReadyRuntimePod(runtimeScope, { attempts = 40, intervalMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const ready = typeof spawner.getReadyRuntimePodForSession === 'function'
      ? await spawner.getReadyRuntimePodForSession(runtimeScope)
      : null;
    if (ready && ready.podName) return ready;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { podName: null };
}

/**
 * One-shot exec into the runtime pod's `runtime` container; resolves the collected
 * stdout. Used by the runtime port monitor (Slice 4) to read /proc/net/tcp[6].
 * Non-TTY, best-effort: resolves '' if the pod isn't ready or the exec errors, so a
 * transient hiccup never breaks the scan. Live-validated only on a Sysbox cluster.
 */
async function runtimeRunOnce(runtimeScope, argv) {
  if (!runtimeScope || !Array.isArray(argv) || argv.length === 0) return '';
  const ready = typeof spawner.getReadyRuntimePodForSession === 'function'
    ? await spawner.getReadyRuntimePodForSession(runtimeScope)
    : null;
  if (!ready || !ready.podName) return '';
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buf = '';
  stdout.on('data', (chunk) => { buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); });
  const exec = new k8s.Exec(kubeConfig());
  return await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(buf); } };
    exec.exec(NAMESPACE, ready.podName, RUNTIME_POD_CONTAINER, argv, stdout, stderr, null, false, () => done())
      .then((ws) => { if (ws && typeof ws.on === 'function') { ws.on('close', done); ws.on('error', done); } })
      .catch(() => done());
  });
}

/**
 * Parse a Kubernetes Exec completion V1Status into a numeric exit code.
 * Success ⇒ 0. A NonZeroExitCode failure carries the code in
 * details.causes[reason=ExitCode].message. Any other Failure ⇒ 1. Unknown ⇒ null.
 */
function parseExecExitCode(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.status === 'Success') return 0;
  const causes = status.details && Array.isArray(status.details.causes) ? status.details.causes : [];
  const exitCause = causes.find((c) => c && c.reason === 'ExitCode');
  if (exitCause && exitCause.message != null) {
    const code = Number(exitCause.message);
    return Number.isFinite(code) ? code : 1;
  }
  return status.status === 'Failure' ? 1 : null;
}

/**
 * One-shot, non-interactive command exec into the Sysbox runtime pod's `runtime`
 * container (where the workspace's own dockerd lives, DOCKER_HOST inherited from
 * the pod env; workspace mounted at /workspace). Routed purely by `runtimeScope`
 * (slug-derived) — never by a user id. Returns { stdout, stderr, exitCode,
 * timedOut } with stdout/stderr captured separately. Live-validated on a Sysbox
 * cluster (k8s-exec). Throws `runtime_pod_not_ready` if no ready pod.
 */
async function runtimeExecOnce(runtimeScope, command, { timeoutMs = 30000 } = {}) {
  if (!runtimeScope) throw new Error('runtime_pod_not_ready');
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');
  const ready = typeof spawner.getReadyRuntimePodForSession === 'function'
    ? await spawner.getReadyRuntimePodForSession(runtimeScope)
    : null;
  if (!ready || !ready.podName) throw new Error('runtime_pod_not_ready');

  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  let stdout = '';
  let stderr = '';
  const MAX_OUT = 50000;
  stdoutStream.on('data', (c) => { if (stdout.length < MAX_OUT) stdout += Buffer.isBuffer(c) ? c.toString('utf8') : String(c); });
  stderrStream.on('data', (c) => { if (stderr.length < MAX_OUT) stderr += Buffer.isBuffer(c) ? c.toString('utf8') : String(c); });

  const exec = new k8s.Exec(kubeConfig());
  const cappedTimeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 60000);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let wsRef = null;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      timedOut = true;
      try { wsRef?.close?.(); } catch (_) {}
      finish({ stdout, stderr, exitCode: null, timedOut: true });
    }, cappedTimeout);

    exec
      .exec(NAMESPACE, ready.podName, RUNTIME_POD_CONTAINER, ['/bin/bash', '-lc', cmd], stdoutStream, stderrStream, null, false,
        (status) => finish({ stdout, stderr, exitCode: parseExecExitCode(status), timedOut }))
      .then((ws) => {
        wsRef = ws;
        if (ws && typeof ws.on === 'function') ws.on('error', () => finish({ stdout, stderr, exitCode: null, timedOut }));
      })
      .catch((err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

module.exports = {
  shouldUseRuntimePodTerminal,
  runtimeTerminalTarget,
  programRuntimeTarget,
  pickRuntimeScopeForSlug,
  buildRuntimeShellScript,
  createRuntimePodPty,
  createRuntimePodProgram,
  runtimeRunOnce,
  runtimeExecOnce,
  parseExecExitCode,
};
