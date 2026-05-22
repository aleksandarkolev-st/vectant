/**
 * WorkspacePodSpawner — Dynamic 1:1 workspace pod lifecycle manager.
 *
 * Uses the K8s API to create/delete a Deployment per active user session.
 * Each Deployment runs a single replica of the WebRTC compiler worker.
 *
 * Design choices:
 *
 *   Deployment over Job — Jobs are for batch/one-shot work that runs to
 *   completion.  Workspace sessions are interactive and long-lived; the pod
 *   must stay running until the user disconnects.  A Deployment with 1 replica
 *   gives us automatic restart-on-crash and rolling update for image changes.
 *
 *   SESSION_ID via env var — Env vars are set once at pod creation and are
 *   immutable for the pod's lifetime, which matches our invariant: one pod
 *   serves exactly one session.  Env vars are visible only inside the pod
 *   (not logged by K8s by default) and cannot be mutated by the user's code
 *   because the worker binary reads them at startup before dropping to the
 *   sandboxed runner process.
 *
 * Lifecycle:
 *   1. Frontend opens a WebSocket for workspace X, user Y.
 *   2. Collab server calls spawner.ensurePod(sessionId, userId).
 *   3. Spawner creates a Deployment "workspace-<sessionId>" if none exists.
 *   4. Spawner uses the Watch API to wait until the pod reaches Running
 *      with a valid PodIP and all containers ready.
 *   5. Spawner returns { name, created, podIP, podName } to the caller.
 *   6. On every heartbeat from the frontend, spawner.touch(sessionId) updates
 *      the lastActive annotation.
 *   7. A periodic culler deletes Deployments whose lastActive > IDLE_TIMEOUT.
 *   8. On signaling disconnect, spawner.teardown(sessionId) deletes immediately.
 *   9. On SIGTERM, the spawner logs active sessions and optionally cleans up.
 */

const k8s = require('@kubernetes/client-node');
const config = require('./config');

// ── Config ─────────────────────────────────────────────────────────────────

const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'REGISTRY/synthi-worker:latest';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min
const CULL_INTERVAL_MS = Number(process.env.CULL_INTERVAL_MS) || 60 * 1000;    // 1 min
const MAX_WORKSPACE_PODS = Number(process.env.MAX_WORKSPACE_PODS) || 50;
const POD_READY_TIMEOUT_MS = Number(process.env.POD_READY_TIMEOUT_MS) || 120_000; // 2 min
const WORKSPACE_NODE_SELECTOR_KEY = (process.env.WORKSPACE_NODE_SELECTOR_KEY || 'cloud.google.com/gke-nodepool').trim();
const WORKSPACE_NODE_SELECTOR_VALUE = (process.env.WORKSPACE_NODE_SELECTOR_VALUE || 'workspace-pool').trim();
const WORKSPACE_NODE_TAINT_KEY = (process.env.WORKSPACE_NODE_TAINT_KEY || 'workload').trim();
const WORKSPACE_NODE_TAINT_VALUE = (process.env.WORKSPACE_NODE_TAINT_VALUE || 'workspace').trim();
const WORKSPACE_NODE_TAINT_EFFECT = (process.env.WORKSPACE_NODE_TAINT_EFFECT || 'NoSchedule').trim();

// ── K8s client ─────────────────────────────────────────────────────────────

let appsApi, coreApi, watcher;

if (process.env.SPAWNER_MODE === 'local') {
  console.log('[Spawner] SPAWNER_MODE=local — K8s client disabled');
} else {
  const kc = new k8s.KubeConfig();

  // In-cluster when running inside a pod; otherwise use local kubeconfig.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }

  appsApi = kc.makeApiClient(k8s.AppsV1Api);
  coreApi = kc.makeApiClient(k8s.CoreV1Api);
  watcher = new k8s.Watch(kc);
}

// ── Session tracking ──────────────────────────────────────────────────────

/** Track sessions managed by this process instance. */
const activeSessions = new Set();

// ── Helpers ────────────────────────────────────────────────────────────────

/** Sanitise a sessionId into a valid K8s name suffix (lowercase alphanum + dash). */
function safeName(sessionId) {
  return sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
}

function deploymentName(sessionId) {
  return `workspace-${safeName(sessionId)}`;
}

function serviceName(sessionId) {
  return `ws-svc-${safeName(sessionId)}`;
}

function buildWorkspaceScheduling() {
  const nodeSelector = WORKSPACE_NODE_SELECTOR_KEY && WORKSPACE_NODE_SELECTOR_VALUE
    ? { [WORKSPACE_NODE_SELECTOR_KEY]: WORKSPACE_NODE_SELECTOR_VALUE }
    : undefined;

  const tolerations = WORKSPACE_NODE_TAINT_KEY && WORKSPACE_NODE_TAINT_VALUE
    ? [{
        key: WORKSPACE_NODE_TAINT_KEY,
        operator: 'Equal',
        value: WORKSPACE_NODE_TAINT_VALUE,
        effect: WORKSPACE_NODE_TAINT_EFFECT,
      }]
    : [];

  return { nodeSelector, tolerations };
}

// ── Watch API: Wait for pod readiness ─────────────────────────────────────

/**
 * Watch pods for a session until one reaches Running with a PodIP and all
 * containers ready.  Returns { podIP, podName } or throws on timeout.
 *
 * @param {string} sessionId
 * @returns {Promise<{podIP: string, podName: string}>}
 */
function waitForPodRunning(sessionId) {
  return new Promise((resolve, reject) => {
    const labelSelector = `synthi/session=${safeName(sessionId)}`;
    const watchPath = `/api/v1/namespaces/${NAMESPACE}/pods`;
    let resolved = false;
    let watchReq = null;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (watchReq) {
          try { watchReq.destroy(); } catch (_) { /* ignore */ }
        }
        reject(new Error(`Pod for session ${sessionId} did not become Ready within ${POD_READY_TIMEOUT_MS}ms`));
      }
    }, POD_READY_TIMEOUT_MS);

    watcher.watch(
      watchPath,
      { labelSelector },
      (phase, pod) => {
        if (resolved) return;

        // Check for Running phase with a PodIP
        if (pod?.status?.phase === 'Running' && pod?.status?.podIP) {
          const containerStatuses = pod.status.containerStatuses || [];
          const allReady = containerStatuses.length > 0 &&
            containerStatuses.every(c => c.ready);

          if (allReady) {
            resolved = true;
            clearTimeout(timer);
            if (watchReq) {
              try { watchReq.destroy(); } catch (_) { /* ignore */ }
            }
            resolve({ podIP: pod.status.podIP, podName: pod.metadata.name });
          }
        }
      },
      (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err || new Error('Watch stream closed unexpectedly'));
        }
      },
    ).then(req => {
      watchReq = req;
    });
  });
}

// ── Dynamic Service per workspace ─────────────────────────────────────────

/**
 * Create a ClusterIP Service pointing at the workspace pod.
 * Idempotent — 409 Conflict means it already exists.
 */
async function ensureService(sessionId) {
  const name = serviceName(sessionId);
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        app: 'workspace',
        'synthi/session': safeName(sessionId),
        'app.kubernetes.io/managed-by': 'workspace-spawner',
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        app: 'workspace',
        'synthi/session': safeName(sessionId),
      },
      ports: [
        { name: 'health', port: 8080, targetPort: 8080 },
      ],
    },
  };

  try {
    await coreApi.createNamespacedService(NAMESPACE, service);
    console.log(`[Spawner] Created Service: ${name}`);
  } catch (err) {
    if (err.response?.statusCode === 409) {
      // Already exists — fine
    } else {
      console.error(`[Spawner] Service creation failed for ${name}:`, err.message);
    }
  }
}

/**
 * Delete the per-workspace Service.
 */
async function deleteService(sessionId) {
  const name = serviceName(sessionId);
  try {
    await coreApi.deleteNamespacedService(name, NAMESPACE);
  } catch (err) {
    if (err.response?.statusCode !== 404) {
      console.error(`[Spawner] Service deletion failed for ${name}:`, err.message);
    }
  }
}

// ── Max-pods guard ────────────────────────────────────────────────────────

/**
 * Count active spawner-managed workspace Deployments.
 * @returns {Promise<number>}
 */
async function getActiveWorkspaceCount() {
  try {
    const { body } = await appsApi.listNamespacedDeployment(
      NAMESPACE,
      undefined, undefined, undefined, undefined,
      'app.kubernetes.io/managed-by=workspace-spawner',
    );
    return body.items.length;
  } catch (err) {
    console.error('[Spawner] Failed to count workspaces:', err.message);
    return activeSessions.size; // Fallback to local tracking
  }
}

// ── Core API ───────────────────────────────────────────────────────────────

/**
 * Ensure a workspace pod exists for the given session.
 * Idempotent — if the Deployment already exists it is a no-op that just
 * bumps the lastActive annotation.
 *
 * @param {string} sessionId — Unique session identifier (workspace-slug + userId hash)
 * @param {string} userId    — Opaque user identifier for labelling
 * @returns {Promise<{name: string, created: boolean, podIP: string|null, podName: string|null}>}
 */
async function ensurePod(sessionId, userId) {
  // Local-dev bypass: no K8s available — the single docker-compose worker
  // registers as __legacy__ and the signaling server routes any session to it.
  if (process.env.SPAWNER_MODE === 'local') {
    console.log(`[Spawner] local mode — skipping K8s for session=${sessionId}`);
    activeSessions.add(sessionId);
    return { name: 'local-worker', created: false, podIP: null, podName: null };
  }

  const name = deploymentName(sessionId);
  const workspaceScheduling = buildWorkspaceScheduling();

  // 1. Check if it already exists — fast path.
  try {
    const { body: existing } = await appsApi.readNamespacedDeployment(name, NAMESPACE);
    // Bump activity timestamp.
    existing.metadata.annotations = existing.metadata.annotations || {};
    existing.metadata.annotations['synthi/lastActive'] = String(Date.now());
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, existing, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
    activeSessions.add(sessionId);
    return { name, created: false, podIP: null, podName: null };
  } catch (err) {
    if (err.response && err.response.statusCode === 404) {
      // Doesn't exist yet — fall through to creation.
    } else {
      throw err;
    }
  }

  // 2. Max-pods guard.
  const currentCount = await getActiveWorkspaceCount();
  if (currentCount >= MAX_WORKSPACE_PODS) {
    throw new Error(`Workspace limit reached (${MAX_WORKSPACE_PODS}). Try again later.`);
  }

  // 3. Create the Deployment.
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        app: 'workspace',
        'synthi/session': safeName(sessionId),
        'synthi/user': safeName(userId),
        'app.kubernetes.io/part-of': 'synthi-ide',
        'app.kubernetes.io/managed-by': 'workspace-spawner',
      },
      annotations: {
        'synthi/lastActive': String(Date.now()),
        'synthi/sessionId': sessionId,
        'synthi/userId': userId,
      },
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'workspace',
          'synthi/session': safeName(sessionId),
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'workspace',
            'synthi/session': safeName(sessionId),
            'synthi/user': safeName(userId),
          },
        },
        spec: {
          terminationGracePeriodSeconds: 15,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          ...(workspaceScheduling.nodeSelector ? { nodeSelector: workspaceScheduling.nodeSelector } : {}),
          ...(workspaceScheduling.tolerations.length ? { tolerations: workspaceScheduling.tolerations } : {}),
          containers: [
            {
              name: 'worker',
              image: WORKER_IMAGE,
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              command: ['/bin/bash', '-c'],
              args: [
                `export PATH="/usr/local/cargo/bin:/usr/local/bin:\${PATH}"
exec worker`,
              ],
              env: [
                { name: 'SESSION_ID', value: sessionId },
                { name: 'USER_ID', value: userId },
                {
                  name: 'SIGNALING_URL',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'SIGNALING_URL' } },
                },
                {
                  name: 'COLLAB_SERVER_URL',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'COLLAB_SERVER_URL' } },
                },
                {
                  name: 'AI_BACKEND_URL',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'CODE_INTEL_URL' } },
                },
                {
                  name: 'AI_BACKEND_AUTH_TOKEN',
                  valueFrom: { secretKeyRef: { name: 'synthi-secrets', key: 'AI_BACKEND_AUTH_TOKEN' } },
                },
                {
                  name: 'GCP_PROJECT_ID',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'GCP_PROJECT_ID' } },
                },
                {
                  name: 'GCS_BUCKET_NAME',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'GCS_BUCKET_NAME' } },
                },
                { name: 'GST_DEBUG', value: '2' },
                { name: 'DISPLAY', value: ':99' },
                {
                  name: 'SYNTHI_LOG_LEVEL',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'SYNTHI_LOG_LEVEL' } },
                },
                {
                  name: 'SYNTHI_ISOLATION_MODEL',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'SYNTHI_ISOLATION_MODEL' } },
                },
              ],
              resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2', memory: '4Gi' },
              },
              livenessProbe: {
                exec: { command: ['pgrep', '-f', 'worker'] },
                initialDelaySeconds: 10,
                periodSeconds: 15,
              },
              volumeMounts: [
                { name: 'dshm', mountPath: '/dev/shm' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
          ],
        },
      },
    },
  };

  try {
    await appsApi.createNamespacedDeployment(NAMESPACE, deployment);
    console.log(`[Spawner] Created workspace pod: ${name} (session=${sessionId}, user=${userId})`);
    activeSessions.add(sessionId);
  } catch (err) {
    // Race condition: another request created it between our check and create.
    if (err.response && err.response.statusCode === 409) {
      console.log(`[Spawner] Deployment ${name} already exists (conflict), treating as success.`);
      activeSessions.add(sessionId);
    } else {
      throw err;
    }
  }

  // 4. Create ClusterIP Service (non-fatal on failure).
  await ensureService(sessionId);

  // 5. Wait for pod to become Running with a PodIP.
  try {
    const { podIP, podName } = await waitForPodRunning(sessionId);
    console.log(`[Spawner] Pod ${podName} is Running (IP=${podIP})`);
    return { name, created: true, podIP, podName };
  } catch (err) {
    // Timeout: tear down the failed deployment to avoid ghost pods.
    console.error(`[Spawner] Pod readiness timeout for ${name}, tearing down:`, err.message);
    await teardown(sessionId);
    throw new Error(`Workspace pod failed to start within ${POD_READY_TIMEOUT_MS / 1000}s`);
  }
}

/**
 * Update the lastActive annotation for a session.
 * Called on heartbeats to prevent the culler from killing active sessions.
 */
async function touch(sessionId) {
  if (process.env.SPAWNER_MODE === 'local') return;
  const name = deploymentName(sessionId);
  const patch = {
    metadata: {
      annotations: {
        'synthi/lastActive': String(Date.now()),
      },
    },
  };
  try {
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, patch, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
  } catch (err) {
    // 404 is expected if the pod was already culled.
    if (err.response && err.response.statusCode !== 404) {
      console.error(`[Spawner] touch() failed for ${name}:`, err.message);
    }
  }
}

/**
 * Immediately delete the workspace Deployment and Service for a session.
 * Called when the signaling server reports both peers disconnected.
 */
async function teardown(sessionId) {
  if (process.env.SPAWNER_MODE === 'local') {
    activeSessions.delete(sessionId);
    return;
  }
  const name = deploymentName(sessionId);
  activeSessions.delete(sessionId);

  // Delete Service first (non-fatal).
  await deleteService(sessionId);

  // Delete Deployment.
  try {
    await appsApi.deleteNamespacedDeployment(name, NAMESPACE);
    console.log(`[Spawner] Deleted workspace pod: ${name}`);
  } catch (err) {
    if (err.response && err.response.statusCode === 404) {
      // Already gone — not an error.
      return;
    }
    console.error(`[Spawner] teardown() failed for ${name}:`, err.message);
  }
}

// ── Culler ──────────────────────────────────────────────────────────────────

/**
 * Scan all spawner-managed Deployments and delete any whose lastActive
 * annotation is older than IDLE_TIMEOUT_MS.
 */
async function cullIdleWorkspaces() {
  try {
    const { body } = await appsApi.listNamespacedDeployment(
      NAMESPACE,
      undefined, undefined, undefined, undefined,
      'app.kubernetes.io/managed-by=workspace-spawner',
    );

    const now = Date.now();
    for (const dep of body.items) {
      const lastActive = Number(dep.metadata.annotations?.['synthi/lastActive'] || 0);
      if (now - lastActive > IDLE_TIMEOUT_MS) {
        const depName = dep.metadata.name;
        const sid = dep.metadata.annotations?.['synthi/sessionId'] || '?';
        console.log(`[Culler] Deleting idle workspace ${depName} (session=${sid}, idle=${Math.round((now - lastActive) / 1000)}s)`);

        // Delete the associated Service.
        await deleteService(sid);
        activeSessions.delete(sid);

        try {
          await appsApi.deleteNamespacedDeployment(depName, NAMESPACE);
        } catch (delErr) {
          if (delErr.response?.statusCode !== 404) {
            console.error(`[Culler] Failed to delete ${depName}:`, delErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Culler] Scan failed:', err.message);
  }
}

// ── Culler timer ───────────────────────────────────────────────────────────

let cullerInterval = null;

function startCuller() {
  if (process.env.SPAWNER_MODE === 'local') return;
  if (cullerInterval) return;
  cullerInterval = setInterval(cullIdleWorkspaces, CULL_INTERVAL_MS);
  // Unref so the timer doesn't keep the process alive on shutdown.
  if (cullerInterval.unref) cullerInterval.unref();
  console.log(`[Culler] Started (interval=${CULL_INTERVAL_MS}ms, timeout=${IDLE_TIMEOUT_MS}ms)`);
}

function stopCuller() {
  if (cullerInterval) {
    clearInterval(cullerInterval);
    cullerInterval = null;
  }
}

// ── SIGTERM / SIGINT graceful shutdown ──────────────────────────────────────

/**
 * On process shutdown, log active sessions and optionally clean them up.
 * By default, we do NOT teardown pods — the culler on the next instance
 * startup will handle orphans.  Set SPAWNER_CLEANUP_ON_SHUTDOWN=true
 * to force teardown of all tracked sessions.
 */
async function gracefulShutdown(signal) {
  console.log(`[Spawner] Received ${signal}, ${activeSessions.size} active session(s).`);
  stopCuller();

  for (const sid of activeSessions) {
    console.log(`[Spawner] Active session at shutdown: ${deploymentName(sid)} (session=${sid})`);
  }

  if (process.env.SPAWNER_CLEANUP_ON_SHUTDOWN === 'true') {
    console.log('[Spawner] SPAWNER_CLEANUP_ON_SHUTDOWN=true, tearing down all sessions...');
    const promises = [...activeSessions].map(sid =>
      teardown(sid).catch(err =>
        console.error(`[Spawner] Cleanup error for ${sid}:`, err.message)
      )
    );
    await Promise.allSettled(promises);
  }

  console.log('[Spawner] Shutdown cleanup complete.');
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── HTTP handler for signaling disconnect webhook ──────────────────────────

/**
 * Handle POST /api/spawner/session-ended
 * Body: { session_id: string }
 *
 * Called by the signaling server when both peers in a session disconnect.
 */
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

  console.log(`[Spawner] Received session-ended webhook for session=${sessionId}`);
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
