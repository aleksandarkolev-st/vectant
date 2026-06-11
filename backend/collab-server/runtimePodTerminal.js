'use strict';

const { PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const spawner = require('./spawner');

const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const CONTAINER_NAME = process.env.SYNTHI_TERMINAL_K8S_CONTAINER || 'worker';

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

  resize() {
    // Kubernetes exec does not expose a portable terminal resize hook through
    // the client used here. The shell still works; it just keeps its initial PTY.
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
}) {
  if (!runtimeScope) throw new Error('runtimeScope is required for runtime pod terminal');

  const pod = await spawner.ensurePod(runtimeScope, actorUserId || filesystemUserId || runtimeScope, {
    workspaceSlug,
    runtimeKind: 'terminal',
  });
  if (!pod?.podName) {
    throw new Error(`Runtime pod for ${runtimeScope} is not ready`);
  }

  const exports = Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  const commandScript = [
    exports,
    `export WORKSPACE_DIR=${shellQuote(cwd)}`,
    'mkdir -p "$WORKSPACE_DIR"',
    'cd "$WORKSPACE_DIR"',
    'exec /bin/bash --login -i',
  ].filter(Boolean).join('; ');

  const stdout = new PassThrough();
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
