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
 *   4. Spawner annotates the Deployment with `synthi/lastActive = Date.now()`.
 *   5. On every heartbeat from the frontend, spawner.touch(sessionId) updates
 *      the annotation.
 *   6. A periodic culler deletes Deployments whose lastActive > IDLE_TIMEOUT.
 *   7. On signaling disconnect, spawner.teardown(sessionId) deletes immediately.
 */

const k8s = require('@kubernetes/client-node');
const config = require('./config');

// ── Config ─────────────────────────────────────────────────────────────────

const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'REGISTRY/synthi-worker:latest';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min
const CULL_INTERVAL_MS = Number(process.env.CULL_INTERVAL_MS) || 60 * 1000;    // 1 min

// ── K8s client ─────────────────────────────────────────────────────────────

const kc = new k8s.KubeConfig();

// In-cluster when running inside a pod; otherwise use local kubeconfig.
if (process.env.KUBERNETES_SERVICE_HOST) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}

const appsApi = kc.makeApiClient(k8s.AppsV1Api);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Sanitise a sessionId into a valid K8s name suffix (lowercase alphanum + dash). */
function safeName(sessionId) {
  return sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
}

function deploymentName(sessionId) {
  return `workspace-${safeName(sessionId)}`;
}

// ── Core API ───────────────────────────────────────────────────────────────

/**
 * Ensure a workspace pod exists for the given session.
 * Idempotent — if the Deployment already exists it is a no-op that just
 * bumps the lastActive annotation.
 *
 * @param {string} sessionId — Unique session identifier (workspace-slug + userId hash)
 * @param {string} userId    — Opaque user identifier for labelling
 * @returns {Promise<{name: string, created: boolean}>}
 */
async function ensurePod(sessionId, userId) {
  const name = deploymentName(sessionId);

  // 1. Check if it already exists — fast path.
  try {
    const { body: existing } = await appsApi.readNamespacedDeployment(name, NAMESPACE);
    // Bump activity timestamp.
    existing.metadata.annotations = existing.metadata.annotations || {};
    existing.metadata.annotations['synthi/lastActive'] = String(Date.now());
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, existing, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
    return { name, created: false };
  } catch (err) {
    if (err.response && err.response.statusCode === 404) {
      // Doesn't exist yet — fall through to creation.
    } else {
      throw err;
    }
  }

  // 2. Create the Deployment.
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
          },
          containers: [
            {
              name: 'worker',
              image: WORKER_IMAGE,
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
                  name: 'GCP_PROJECT_ID',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'GCP_PROJECT_ID' } },
                },
                {
                  name: 'GCS_BUCKET_NAME',
                  valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'GCS_BUCKET_NAME' } },
                },
                { name: 'GST_DEBUG', value: '2' },
                { name: 'DISPLAY', value: ':99' },
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
    return { name, created: true };
  } catch (err) {
    // Race condition: another request created it between our check and create.
    if (err.response && err.response.statusCode === 409) {
      console.log(`[Spawner] Deployment ${name} already exists (conflict), treating as success.`);
      return { name, created: false };
    }
    throw err;
  }
}

/**
 * Update the lastActive annotation for a session.
 * Called on heartbeats to prevent the culler from killing active sessions.
 */
async function touch(sessionId) {
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
 * Immediately delete the workspace Deployment for a session.
 * Called when the signaling server reports both peers disconnected.
 */
async function teardown(sessionId) {
  const name = deploymentName(sessionId);
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
};
