'use strict';

const { PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const spawner = require('./spawner');

const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const CONTAINER_NAME = process.env.SYNTHI_TERMINAL_K8S_CONTAINER || 'worker';

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

  const pod = await spawner.ensurePod(runtimeScope, actorUserId || filesystemUserId || runtimeScope, {
    workspaceSlug,
    runtimeKind: 'terminal',
    filesystemUserId,
  });
  if (!pod?.podName) {
    throw new Error(`Runtime pod for ${runtimeScope} is not ready`);
  }

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
    `export WORKSPACE_DIR=${shellQuote(cwd)}`,
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
    CONTAINER_NAME,
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

module.exports = {
  shouldUseRuntimePodTerminal,
  createRuntimePodPty,
};
