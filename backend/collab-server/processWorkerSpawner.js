/**
 * ProcessWorkerSpawner — per-session worker process manager for
 * bare-metal local development (no Docker, no Kubernetes).
 *
 * Same public surface as workspacePodSpawner.js / localWorkerSpawner.js,
 * but each active session is backed by a child `worker` process on the
 * host machine with SESSION_ID injected into its env.  Useful when the
 * developer runs `cargo run`-style services directly on their laptop.
 *
 * Config (env vars):
 *   WORKER_CMD           Shell command to launch the worker. Default:
 *                        "cargo run --release --bin worker"
 *   WORKER_CWD           Working directory for the spawn. Default:
 *                        <repo>/backend/synthi-webrtc-compiler/worker
 *   WORKER_SIGNALING_URL Default ws://127.0.0.1:9000
 *   WORKER_COLLAB_URL    Default http://127.0.0.1:1234
 *   WORKER_AI_BACKEND_URL Default http://127.0.0.1:8000
 *   WORKER_LOG_LEVEL     Default "debug"
 *   WORKER_LOG_DIR       If set, stdout/stderr are piped to
 *                        <dir>/workspace-<slug>.log; else inherited.
 *   IDLE_TIMEOUT_MS      Default 600_000 (10 min)
 *   CULL_INTERVAL_MS     Default 60_000 (1 min)
 *   MAX_WORKSPACE_PODS   Default 50
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const lifecycle = require('./sessionLifecycle');

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_WORKER_CWD = path.resolve(__dirname, '..', 'synthi-webrtc-compiler', 'worker');
const WORKER_CMD = process.env.WORKER_CMD || 'cargo run --release --bin worker';
const WORKER_CWD = process.env.WORKER_CWD || DEFAULT_WORKER_CWD;
const WORKER_SIGNALING_URL = process.env.WORKER_SIGNALING_URL || 'ws://127.0.0.1:9000';
const WORKER_COLLAB_URL = process.env.WORKER_COLLAB_URL || 'http://127.0.0.1:1234';
const WORKER_AI_BACKEND_URL = process.env.WORKER_AI_BACKEND_URL || 'http://127.0.0.1:8000';
const WORKER_LOG_LEVEL = process.env.WORKER_LOG_LEVEL || 'debug';
const WORKER_LOG_DIR = process.env.WORKER_LOG_DIR || '';

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
const CULL_INTERVAL_MS = Number(process.env.CULL_INTERVAL_MS) || 60 * 1000;
const MAX_WORKSPACE_PROCESSES = Number(process.env.MAX_WORKSPACE_PODS) || 50;

// ── Session tracking ───────────────────────────────────────────────────────

/** sessionId -> { lastActive, child, userId, name } */
const activeSessions = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function safeName(sessionId) {
  return String(sessionId).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
}

function processName(sessionId) {
  return `workspace-${safeName(sessionId)}`;
}

function getActiveWorkspaceCount() {
  return activeSessions.size;
}

function openLogStream(name) {
  if (!WORKER_LOG_DIR) return null;
  try {
    fs.mkdirSync(WORKER_LOG_DIR, { recursive: true });
    return fs.createWriteStream(path.join(WORKER_LOG_DIR, `${name}.log`), { flags: 'a' });
  } catch (err) {
    console.warn(`[ProcessSpawner] Failed to open log file for ${name}:`, err.message);
    return null;
  }
}

// ── Create / ensure ────────────────────────────────────────────────────────

async function ensurePod(sessionId, userId) {
  if (!sessionId) throw new Error('sessionId is required');
  const name = processName(sessionId);
  const now = Date.now();

  const tracked = activeSessions.get(sessionId);
  if (tracked && tracked.child && tracked.child.exitCode === null && !tracked.child.killed) {
    tracked.lastActive = now;
    lifecycle.markReady(sessionId);
    return { name, created: false, podName: name, pid: tracked.child.pid };
  }
  if (tracked) activeSessions.delete(sessionId);

  if (activeSessions.size >= MAX_WORKSPACE_PROCESSES) {
    throw new Error(`Workspace process cap reached (${MAX_WORKSPACE_PROCESSES})`);
  }

  lifecycle.markWarming(sessionId, { stage: "process_spawn", stage_progress_pct: 10 });

  const env = {
    ...process.env,
    SESSION_ID: sessionId,
    SIGNALING_URL: WORKER_SIGNALING_URL,
    COLLAB_SERVER_URL: WORKER_COLLAB_URL,
    AI_BACKEND_URL: WORKER_AI_BACKEND_URL,
    SYNTHI_LOG_LEVEL: WORKER_LOG_LEVEL,
  };

  const child = spawn('sh', ['-lc', WORKER_CMD], {
    cwd: WORKER_CWD,
    env,
    detached: false,
    stdio: WORKER_LOG_DIR ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (WORKER_LOG_DIR) {
    const stream = openLogStream(name);
    if (stream) {
      child.stdout?.pipe(stream, { end: false });
      child.stderr?.pipe(stream, { end: false });
    }
  }

  activeSessions.set(sessionId, { lastActive: now, child, userId, name });
  lifecycle.markReady(sessionId);

  child.on('exit', (code, signal) => {
    console.log(`[ProcessSpawner] ${name} exited (code=${code}, signal=${signal})`);
    const current = activeSessions.get(sessionId);
    if (current && current.child === child) {
      activeSessions.delete(sessionId);
    }
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      lifecycle.markCrashed(sessionId, `exit code=${code} signal=${signal}`);
    } else {
      lifecycle.markTerminated(sessionId, `exit code=${code} signal=${signal}`);
    }
  });

  console.log(`[ProcessSpawner] Started ${name} pid=${child.pid} (session=${sessionId}, userId=${userId})`);
  return { name, created: true, podName: name, pid: child.pid };
}

/**
 * Lifecycle snapshot — mirror of localWorkerSpawner.lifecycleSnapshot.
 */
async function lifecycleSnapshot(sessionId) {
  const entry = activeSessions.get(sessionId);
  const advisory = lifecycle.snapshot(sessionId);
  if (!entry) {
    return { ...advisory, pod_running: false, spawner_tracked: false };
  }
  const child = entry.child;
  const running = child && child.exitCode === null && !child.killed;
  if (!running && advisory.state !== "terminated" && advisory.state !== "crashed") {
    lifecycle.markCrashed(sessionId, "process_not_running");
  }
  return {
    ...lifecycle.snapshot(sessionId),
    pod_running: Boolean(running),
    spawner_tracked: true,
    last_active: entry.lastActive,
    pid: child?.pid,
  };
}

/**
 * Warm endpoint — trigger ensurePod asynchronously; poll /lifecycle for progress.
 */
async function warm(sessionId, userId) {
  if (!sessionId) throw new Error('sessionId is required');
  lifecycle.markWarming(sessionId, { stage: "warm_triggered", stage_progress_pct: 5 });
  ensurePod(sessionId, userId).catch((err) => {
    console.error(`[ProcessSpawner] warm ensurePod failed for ${sessionId}:`, err.message);
    lifecycle.markCrashed(sessionId, `warm_failed: ${err.message}`);
  });
  return lifecycle.snapshot(sessionId);
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

async function touch(sessionId) {
  const entry = activeSessions.get(sessionId);
  if (entry) entry.lastActive = Date.now();
}

// ── Teardown ───────────────────────────────────────────────────────────────

async function teardown(sessionId) {
  const entry = activeSessions.get(sessionId);
  activeSessions.delete(sessionId);
  if (!entry || !entry.child) {
    lifecycle.markTerminated(sessionId, "teardown_untracked");
    return;
  }

  const child = entry.child;
  if (child.exitCode !== null || child.killed) {
    lifecycle.markTerminated(sessionId, "teardown_already_exited");
    return;
  }

  try {
    child.kill('SIGTERM');
    // Escalate to SIGKILL if the worker doesn't exit within 5s.
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    }, 5000).unref?.();
    console.log(`[ProcessSpawner] Torn down ${entry.name} pid=${child.pid}`);
  } catch (err) {
    console.warn(`[ProcessSpawner] kill failed for ${entry.name}:`, err.message);
  }
}

// ── Culler ─────────────────────────────────────────────────────────────────

async function cullIdleWorkspaces() {
  const now = Date.now();
  for (const [sid, entry] of activeSessions.entries()) {
    if (now - entry.lastActive > IDLE_TIMEOUT_MS) {
      console.log(`[ProcessSpawner/Culler] Culling idle session ${sid} (idle=${Math.round((now - entry.lastActive) / 1000)}s)`);
      await teardown(sid);
    }
  }
}

let cullerInterval = null;

function startCuller() {
  if (cullerInterval) return;
  cullerInterval = setInterval(cullIdleWorkspaces, CULL_INTERVAL_MS);
  if (cullerInterval.unref) cullerInterval.unref();
  console.log(`[ProcessSpawner/Culler] Started (interval=${CULL_INTERVAL_MS}ms, timeout=${IDLE_TIMEOUT_MS}ms)`);
}

function stopCuller() {
  if (cullerInterval) {
    clearInterval(cullerInterval);
    cullerInterval = null;
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`[ProcessSpawner] Received ${signal}, ${activeSessions.size} active session(s).`);
  stopCuller();
  const ids = [...activeSessions.keys()];
  await Promise.allSettled(ids.map(sid =>
    teardown(sid).catch(err =>
      console.error(`[ProcessSpawner] Cleanup error for ${sid}:`, err.message)
    )
  ));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── HTTP handler for signaling disconnect webhook ──────────────────────────

async function handleSessionEnded(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let parsed;
  try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }

  const sessionId = parsed.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    res.writeHead(400); res.end('Missing session_id'); return;
  }

  console.log(`[ProcessSpawner] Received session-ended webhook for session=${sessionId}`);
  await teardown(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ensurePod,
  touch,
  teardown,
  warm,
  lifecycleSnapshot,
  cullIdleWorkspaces,
  startCuller,
  stopCuller,
  handleSessionEnded,
  gracefulShutdown,
  getActiveWorkspaceCount,
};
