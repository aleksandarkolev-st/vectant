/**
 * LocalWorkerSpawner — Dynamic 1:1 workspace worker lifecycle manager for
 * local docker-compose development.
 *
 * Mirrors the public API of workspacePodSpawner.js but uses the Docker
 * Engine API (via dockerode + /var/run/docker.sock) instead of Kubernetes.
 * Each active session maps to a single worker container named
 * "workspace-<sanitised-session-id>" with SESSION_ID wired into its env.
 *
 * The signaling server multiplexes peers by (session_id, role), so a
 * dedicated container per session is the local equivalent of the cloud's
 * per-session Deployment: it removes the "only one workspace can connect"
 * footgun caused by the old static `worker` service in docker-compose.yml.
 */

const Docker = require('dockerode');

// ── Config ─────────────────────────────────────────────────────────────────

const DOCKER_SOCKET = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'synthi-worker:local';
const WORKER_NETWORK = process.env.WORKER_NETWORK || 'synthi-ide_default';
const WORKER_SIGNALING_URL = process.env.WORKER_SIGNALING_URL || 'ws://signaling-server:9000';
const WORKER_COLLAB_URL = process.env.WORKER_COLLAB_URL || 'http://collab-server:1234';
const WORKER_AI_BACKEND_URL = process.env.WORKER_AI_BACKEND_URL || 'http://ai-engine:8000';
const WORKER_GST_DEBUG = process.env.WORKER_GST_DEBUG || '2';
const WORKER_LOG_LEVEL = process.env.WORKER_LOG_LEVEL || 'debug';

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min
const CULL_INTERVAL_MS = Number(process.env.CULL_INTERVAL_MS) || 60 * 1000;    // 1 min
const MAX_WORKSPACE_CONTAINERS = Number(process.env.MAX_WORKSPACE_PODS) || 50;

const MANAGED_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_VALUE = 'workspace-spawner-local';

// ── Docker client ──────────────────────────────────────────────────────────

const docker = new Docker({ socketPath: DOCKER_SOCKET });

// ── Session tracking ───────────────────────────────────────────────────────

/** sessionId -> { lastActive, containerId, userId } */
const activeSessions = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function safeName(sessionId) {
  return String(sessionId).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
}

function containerName(sessionId) {
  return `workspace-${safeName(sessionId)}`;
}

function getActiveWorkspaceCount() {
  return activeSessions.size;
}

async function findContainerByName(name) {
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    return { container: c, info };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// ── Create / ensure ────────────────────────────────────────────────────────

async function ensurePod(sessionId, userId) {
  if (!sessionId) throw new Error('sessionId is required');
  const name = containerName(sessionId);
  const now = Date.now();

  // Fast path: session already tracked in-memory and container is running.
  const tracked = activeSessions.get(sessionId);
  if (tracked) {
    try {
      const c = docker.getContainer(tracked.containerId);
      const info = await c.inspect();
      if (info.State.Running) {
        tracked.lastActive = now;
        return { name, created: false, podName: name, containerId: tracked.containerId };
      }
      // Container exists but is not running — remove and recreate below.
      try { await c.remove({ force: true }); } catch (_) { /* ignore */ }
    } catch (_) {
      // Container disappeared — fall through and recreate.
    }
    activeSessions.delete(sessionId);
  }

  // Slow path: check for an existing container by name (e.g. after a
  // collab-server restart) before creating a new one.
  const existing = await findContainerByName(name).catch(() => null);
  if (existing) {
    if (existing.info.State.Running) {
      activeSessions.set(sessionId, {
        lastActive: now,
        containerId: existing.info.Id,
        userId,
      });
      return { name, created: false, podName: name, containerId: existing.info.Id };
    }
    try { await existing.container.remove({ force: true }); } catch (_) { /* ignore */ }
  }

  if (activeSessions.size >= MAX_WORKSPACE_CONTAINERS) {
    throw new Error(`Workspace container cap reached (${MAX_WORKSPACE_CONTAINERS})`);
  }

  const env = [
    `SESSION_ID=${sessionId}`,
    `SIGNALING_URL=${WORKER_SIGNALING_URL}`,
    `COLLAB_SERVER_URL=${WORKER_COLLAB_URL}`,
    `AI_BACKEND_URL=${WORKER_AI_BACKEND_URL}`,
    `GST_DEBUG=${WORKER_GST_DEBUG}`,
    'DISPLAY=:99',
    `SYNTHI_LOG_LEVEL=${WORKER_LOG_LEVEL}`,
  ];

  const createOpts = {
    name,
    Image: WORKER_IMAGE,
    Env: env,
    Labels: {
      [MANAGED_LABEL]: MANAGED_VALUE,
      'synthi/session': safeName(sessionId),
      'synthi/sessionIdRaw': String(sessionId),
      'synthi/userId': String(userId || ''),
      'synthi/lastActive': String(now),
    },
    HostConfig: {
      NetworkMode: WORKER_NETWORK,
      AutoRemove: false,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
    },
  };

  let container;
  try {
    container = await docker.createContainer(createOpts);
  } catch (err) {
    // Fallback: image might not be pulled locally. Try to pull, then retry.
    if (err.statusCode === 404 && /No such image/i.test(err.message || '')) {
      console.log(`[LocalSpawner] Image ${WORKER_IMAGE} not found, attempting pull…`);
      await new Promise((resolve, reject) => {
        docker.pull(WORKER_IMAGE, (pullErr, stream) => {
          if (pullErr) return reject(pullErr);
          docker.modem.followProgress(stream, (doneErr) => doneErr ? reject(doneErr) : resolve());
        });
      });
      container = await docker.createContainer(createOpts);
    } else {
      throw err;
    }
  }

  await container.start();

  activeSessions.set(sessionId, {
    lastActive: now,
    containerId: container.id,
    userId,
  });

  console.log(`[LocalSpawner] Started worker container ${name} (session=${sessionId}, userId=${userId})`);
  return { name, created: true, podName: name, containerId: container.id };
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

async function touch(sessionId) {
  const entry = activeSessions.get(sessionId);
  if (entry) {
    entry.lastActive = Date.now();
  }
}

// ── Teardown ───────────────────────────────────────────────────────────────

async function teardown(sessionId) {
  const name = containerName(sessionId);
  const entry = activeSessions.get(sessionId);
  activeSessions.delete(sessionId);

  const containerId = entry?.containerId || name;
  try {
    const c = docker.getContainer(containerId);
    try { await c.stop({ t: 5 }); } catch (stopErr) {
      if (stopErr.statusCode !== 304 && stopErr.statusCode !== 404) {
        console.warn(`[LocalSpawner] stop failed for ${name}:`, stopErr.message);
      }
    }
    await c.remove({ force: true });
    console.log(`[LocalSpawner] Torn down worker container ${name}`);
  } catch (err) {
    if (err.statusCode !== 404) {
      console.error(`[LocalSpawner] teardown failed for ${name}:`, err.message);
    }
  }
}

// ── Culler ─────────────────────────────────────────────────────────────────

async function cullIdleWorkspaces() {
  const now = Date.now();

  for (const [sid, entry] of activeSessions.entries()) {
    if (now - entry.lastActive > IDLE_TIMEOUT_MS) {
      console.log(`[LocalSpawner/Culler] Culling idle session ${sid} (idle=${Math.round((now - entry.lastActive) / 1000)}s)`);
      await teardown(sid);
    }
  }

  // Also sweep any orphaned containers we manage (e.g. leaked by a previous
  // collab-server crash) whose label timestamp is older than the timeout.
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${MANAGED_VALUE}`] },
    });
    for (const c of containers) {
      const sid = c.Labels?.['synthi/sessionIdRaw'];
      if (!sid || activeSessions.has(sid)) continue;
      const lastActive = Number(c.Labels?.['synthi/lastActive'] || 0);
      if (now - lastActive > IDLE_TIMEOUT_MS) {
        console.log(`[LocalSpawner/Culler] Removing orphan container ${c.Names?.[0] || c.Id}`);
        try { await docker.getContainer(c.Id).remove({ force: true }); } catch (_) { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('[LocalSpawner/Culler] Orphan sweep failed:', err.message);
  }
}

// ── Culler timer ───────────────────────────────────────────────────────────

let cullerInterval = null;

function startCuller() {
  if (cullerInterval) return;
  cullerInterval = setInterval(cullIdleWorkspaces, CULL_INTERVAL_MS);
  if (cullerInterval.unref) cullerInterval.unref();
  console.log(`[LocalSpawner/Culler] Started (interval=${CULL_INTERVAL_MS}ms, timeout=${IDLE_TIMEOUT_MS}ms)`);
}

function stopCuller() {
  if (cullerInterval) {
    clearInterval(cullerInterval);
    cullerInterval = null;
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`[LocalSpawner] Received ${signal}, ${activeSessions.size} active session(s).`);
  stopCuller();

  if (process.env.SPAWNER_CLEANUP_ON_SHUTDOWN === 'true') {
    console.log('[LocalSpawner] SPAWNER_CLEANUP_ON_SHUTDOWN=true, tearing down all sessions...');
    const ids = [...activeSessions.keys()];
    await Promise.allSettled(ids.map(sid =>
      teardown(sid).catch(err =>
        console.error(`[LocalSpawner] Cleanup error for ${sid}:`, err.message)
      )
    ));
  }
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
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
  }

  const sessionId = parsed.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    res.writeHead(400);
    res.end('Missing session_id');
    return;
  }

  console.log(`[LocalSpawner] Received session-ended webhook for session=${sessionId}`);
  await teardown(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ensurePod,
  touch,
  teardown,
  cullIdleWorkspaces,
  startCuller,
  stopCuller,
  handleSessionEnded,
  gracefulShutdown,
  getActiveWorkspaceCount,
};
