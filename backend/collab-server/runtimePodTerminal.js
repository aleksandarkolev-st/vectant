'use strict';

const { PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const spawner = require('./spawner');
const { isSysboxRuntimeEnabled } = require('./runtimePodSpec');

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
  const exports = Object.entries(terminalEnv)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  const commandScript = [
    exports,
    `export WORKSPACE_DIR=${shellQuote(effectiveCwd)}`,
    'mkdir -p "$WORKSPACE_DIR"',
    'cd "$WORKSPACE_DIR"',
    `stty rows ${safeRows} cols ${safeCols} 2>/dev/null || true`,
    'exec /bin/bash --login -i',
  ].filter(Boolean).join('; ');

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

module.exports = {
  shouldUseRuntimePodTerminal,
  runtimeTerminalTarget,
  programRuntimeTarget,
  createRuntimePodPty,
  runtimeRunOnce,
};
