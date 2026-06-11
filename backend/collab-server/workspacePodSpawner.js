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
 *   2. Collab server calls spawner.ensurePod(runtimeScope, userId).
 *   3. Spawner creates a Deployment "rt-<base32-hmac>" if none exists.
 *   4. Spawner uses the Watch API to wait until the pod reaches Running
 *      with a valid PodIP and all containers ready.
 *   5. Spawner returns { name, created, podIP, podName } to the caller.
 *   6. On every heartbeat from the frontend, spawner.touch(runtimeScope) updates
 *      the lastActive annotation.
 *   7. A periodic culler deletes Deployments whose lastActive > IDLE_TIMEOUT.
 *   8. On signaling disconnect, spawner.teardown(runtimeScope) deletes immediately.
 *   9. On SIGTERM, the spawner logs active sessions and optionally cleans up.
 */

const k8s = require('@kubernetes/client-node');
const { runtimeResourceId, metadataHash, dnsLabelValue } = require('./runtimeIdentity');
const { ensureRuntimeFilesystem, releaseRuntimeFilesystem } = require('./runtimeFilesystem');

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
const WORKSPACE_DATA_PVC = (process.env.WORKSPACE_DATA_PVC || 'collab-data-pvc').trim();
const WORKSPACE_DATA_MOUNT = (process.env.WORKSPACE_DATA_MOUNT || '/data').trim();
const WORKSPACE_REPOS_PATH = (process.env.WORKSPACE_REPOS_PATH || `${WORKSPACE_DATA_MOUNT.replace(/\/+$/, '')}/repos`).trim();
const PREVIEW_SIDECAR_PORT = parseSinglePort(process.env.SYNTHI_PREVIEW_SIDECAR_PORT, 18080);
const PREVIEW_SIDECAR_PREFIX = normalizePreviewPrefix(process.env.SYNTHI_PREVIEW_SIDECAR_PREFIX || '/__synthi_preview');
const PREVIEW_SIDECAR_IMAGE = (process.env.SYNTHI_PREVIEW_SIDECAR_IMAGE || 'node:20-alpine').trim();

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

function deploymentName(sessionId) {
  return runtimeResourceId(sessionId);
}

function serviceName(sessionId) {
  return runtimeResourceId(sessionId);
}

function runtimeLabels(sessionId, userId) {
  return {
    app: 'workspace',
    'synthi/runtime-id': runtimeResourceId(sessionId),
    ...(userId ? { 'synthi/user-hash': metadataHash(userId) } : {}),
    'app.kubernetes.io/part-of': 'synthi-ide',
    'app.kubernetes.io/managed-by': 'workspace-spawner',
  };
}

function runtimeAnnotations(sessionId, userId, metadata = {}) {
  return {
    'synthi/lastActive': String(Date.now()),
    'synthi/runtimeScopeFull': sessionId,
    ...(metadata.workspaceSlug ? { 'synthi/workspaceSlug': String(metadata.workspaceSlug) } : {}),
    ...(metadata.runtimeKind ? { 'synthi/runtimeKind': dnsLabelValue(metadata.runtimeKind) } : {}),
    ...(userId ? { 'synthi/userIdHash': metadataHash(userId) } : {}),
    ...(metadata.filesystemUserId ? { 'synthi/filesystemUserIdHash': metadataHash(metadata.filesystemUserId) } : {}),
  };
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

function parseSinglePort(value, fallback) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return fallback;
}

function normalizePreviewPrefix(value) {
  const raw = String(value || '').trim() || '/__synthi_preview';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || '/__synthi_preview';
}

function safePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_@.\-]/g, '_');
}

function workspaceDirForMetadata(metadata = {}) {
  const slug = String(metadata.workspaceSlug || '').trim();
  if (!slug) return WORKSPACE_REPOS_PATH;
  const fsUser = safePathSegment(metadata.filesystemUserId || '');
  return fsUser
    ? `${WORKSPACE_REPOS_PATH.replace(/\/+$/, '')}/${slug}/${fsUser}`
    : `${WORKSPACE_REPOS_PATH.replace(/\/+$/, '')}/${slug}`;
}

function previewSidecarScript() {
  return [
    "'use strict';",
    "const http = require('http');",
    "const net = require('net');",
    "const { URL } = require('url');",
    "const LISTEN_PORT = Number(process.env.SYNTHI_PREVIEW_SIDECAR_PORT || '18080');",
    "const PREFIX = normalizePrefix(process.env.SYNTHI_PREVIEW_SIDECAR_PREFIX || '/__synthi_preview');",
    "const TIMEOUT_MS = Number(process.env.SYNTHI_PREVIEW_SIDECAR_TIMEOUT_MS || '30000');",
    "function normalizePrefix(value) { const raw = String(value || '').trim() || '/__synthi_preview'; const withSlash = raw.startsWith('/') ? raw : '/' + raw; return withSlash.replace(/\\/+$/, '') || '/__synthi_preview'; }",
    "function sendJson(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }",
    "function parsePreviewUrl(rawUrl) {",
    "  const url = new URL(rawUrl || '/', 'http://preview.local');",
    "  if (url.pathname === '/healthz') return { health: true };",
    "  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;",
    "  const suffix = url.pathname.slice(PREFIX.length);",
    "  const match = /^\\/(\\d+)(\\/.*)?$/.exec(suffix);",
    "  if (!match) return null;",
    "  const port = Number(match[1]);",
    "  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;",
    "  return { port, path: (match[2] || '/') + url.search };",
    "}",
    "function upstreamHeaders(headers, port) {",
    "  const next = { ...headers, host: 'localhost:' + port };",
    "  delete next['proxy-connection'];",
    "  return next;",
    "}",
    "function proxyHttp(req, res) {",
    "  const parsed = parsePreviewUrl(req.url);",
    "  if (parsed && parsed.health) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }",
    "  if (!parsed) { sendJson(res, 404, { error: 'invalid_preview_path' }); return; }",
    "  const upstream = http.request({",
    "    hostname: 'localhost',",
    "    port: parsed.port,",
    "    path: parsed.path,",
    "    method: req.method,",
    "    headers: upstreamHeaders(req.headers, parsed.port),",
    "    timeout: TIMEOUT_MS,",
    "    autoSelectFamily: true,",
    "  }, (upstreamRes) => {",
    "    const headers = { ...upstreamRes.headers };",
    "    headers['access-control-allow-origin'] = headers['access-control-allow-origin'] || '*';",
    "    res.writeHead(upstreamRes.statusCode || 502, headers);",
    "    upstreamRes.pipe(res, { end: true });",
    "  });",
    "  upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));",
    "  upstream.on('error', (err) => {",
    "    if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unreachable', port: parsed.port, detail: err.message });",
    "    else res.destroy(err);",
    "  });",
    "  req.pipe(upstream, { end: true });",
    "}",
    "function proxyWs(req, socket, head) {",
    "  const parsed = parsePreviewUrl(req.url);",
    "  if (!parsed || parsed.health) { socket.destroy(); return; }",
    "  const upstream = net.connect({ host: 'localhost', port: parsed.port, autoSelectFamily: true }, () => {",
    "    const reqLine = req.method + ' ' + parsed.path + ' HTTP/1.1\\r\\n';",
    "    const headers = Object.entries(upstreamHeaders(req.headers, parsed.port))",
    "      .map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join(', ') : value))",
    "      .join('\\r\\n');",
    "    upstream.write(reqLine + headers + '\\r\\n\\r\\n');",
    "    if (head && head.length) upstream.write(head);",
    "    upstream.pipe(socket);",
    "    socket.pipe(upstream);",
    "  });",
    "  upstream.setTimeout(TIMEOUT_MS, () => { upstream.destroy(); socket.destroy(); });",
    "  upstream.on('error', () => socket.destroy());",
    "  socket.on('error', () => upstream.destroy());",
    "}",
    "const server = http.createServer(proxyHttp);",
    "server.on('upgrade', proxyWs);",
    "server.listen(LISTEN_PORT, '0.0.0.0', () => console.log('[PreviewSidecar] listening on :' + LISTEN_PORT + ' prefix=' + PREFIX));",
  ].join('\n');
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
    const labelSelector = `synthi/runtime-id=${runtimeResourceId(sessionId)}`;
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

async function getReadyPodForSession(sessionId) {
  const labelSelector = `synthi/runtime-id=${runtimeResourceId(sessionId)}`;
  try {
    const { body } = await coreApi.listNamespacedPod(
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector,
    );
    for (const pod of body.items || []) {
      if (pod?.status?.phase !== 'Running' || !pod?.status?.podIP) continue;
      const containerStatuses = pod.status.containerStatuses || [];
      const allReady = containerStatuses.length > 0 &&
        containerStatuses.every(c => c.ready);
      if (allReady) {
        return { podIP: pod.status.podIP, podName: pod.metadata.name };
      }
    }
  } catch (err) {
    console.warn(`[Spawner] Failed to list ready pod for ${runtimeResourceId(sessionId)}:`, err.message);
  }
  return { podIP: null, podName: null };
}

// ── Dynamic Service per workspace ─────────────────────────────────────────

/**
 * Create a ClusterIP Service pointing at the workspace pod.
 * Idempotent — 409 Conflict means it already exists.
 */
async function ensureService(sessionId) {
  const name = serviceName(sessionId);
  const labels = runtimeLabels(sessionId, null);
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels,
      annotations: {
        'synthi/runtimeScopeFull': sessionId,
      },
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: 'None',
      selector: {
        app: 'workspace',
        'synthi/runtime-id': runtimeResourceId(sessionId),
      },
      ports: [
        { name: 'preview-proxy', port: PREVIEW_SIDECAR_PORT, targetPort: PREVIEW_SIDECAR_PORT },
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
 * @param {string} sessionId — Full runtime scope
 * @param {string} userId    — Actor user identifier; stored only as HMAC metadata
 * @returns {Promise<{name: string, created: boolean, podIP: string|null, podName: string|null}>}
 */
async function ensurePod(sessionId, userId, metadata = {}) {
  // Local-dev bypass: no K8s available — the single docker-compose worker
  // registers as __legacy__ and the signaling server routes any session to it.
  if (process.env.SPAWNER_MODE === 'local') {
    console.log(`[Spawner] local mode — skipping K8s for session=${sessionId}`);
    activeSessions.add(sessionId);
    return { name: 'local-worker', created: false, podIP: null, podName: null };
  }

  const name = deploymentName(sessionId);
  const workspaceScheduling = buildWorkspaceScheduling();
  const labels = runtimeLabels(sessionId, userId);
  const annotations = runtimeAnnotations(sessionId, userId, metadata);
  const filesystemUserId = metadata.filesystemUserId || metadata.filesystem_user_id || userId;
  const hydrateAndPinRuntimeFs = async () => {
    if (!metadata.workspaceSlug) return null;
    return ensureRuntimeFilesystem({
      workspaceSlug: metadata.workspaceSlug,
      filesystemUserId,
      runtimeScope: sessionId,
      pin: true,
      reason: 'workspace_pod',
    });
  };

  // 1. Check if it already exists — fast path.
  try {
    const { body: existing } = await appsApi.readNamespacedDeployment(name, NAMESPACE);
    await hydrateAndPinRuntimeFs();
    // Bump activity timestamp.
    existing.metadata.annotations = existing.metadata.annotations || {};
    existing.metadata.annotations['synthi/lastActive'] = String(Date.now());
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, existing, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
    activeSessions.add(sessionId);
    try {
      const readyPod = await getReadyPodForSession(sessionId);
      if (readyPod.podName) return { name, created: false, ...readyPod };
      return { name, created: false, ...(await waitForPodRunning(sessionId)) };
    } catch (readyErr) {
      activeSessions.delete(sessionId);
      releaseRuntimeFilesystem(sessionId);
      throw readyErr;
    }
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

  await hydrateAndPinRuntimeFs();

  // 3. Create the Deployment.
  const workspaceDir = workspaceDirForMetadata({ ...metadata, filesystemUserId });
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels,
      annotations,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'workspace',
          'synthi/runtime-id': runtimeResourceId(sessionId),
        },
      },
      template: {
        metadata: {
          labels,
          annotations,
        },
        spec: {
          terminationGracePeriodSeconds: 15,
          securityContext: {
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          serviceAccountName: 'workspace-runtime-sa',
          ...(workspaceScheduling.nodeSelector ? { nodeSelector: workspaceScheduling.nodeSelector } : {}),
          ...(workspaceScheduling.tolerations.length ? { tolerations: workspaceScheduling.tolerations } : {}),
          containers: [
            {
              name: 'worker',
              image: WORKER_IMAGE,
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: true,
              },
              command: ['/bin/bash', '-c'],
              args: [
                `export PATH="/usr/local/cargo/bin:/usr/local/bin:\${PATH}"
exec worker`,
              ],
              env: [
                { name: 'SESSION_ID', value: sessionId },
                { name: 'SYNTHI_RUNTIME_SCOPE', value: sessionId },
                { name: 'RUNTIME_RESOURCE_ID', value: runtimeResourceId(sessionId) },
                { name: 'USER_ID', value: userId },
                { name: 'USER_ID_HASH', value: metadataHash(userId) },
                { name: 'SYNTHI_WORKSPACE_SLUG', value: String(metadata.workspaceSlug || '') },
                { name: 'SYNTHI_RUNTIME_KIND', value: String(metadata.runtimeKind || '') },
                { name: 'SYNTHI_RUNTIME_FS_USER_ID', value: String(filesystemUserId || '') },
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
                { name: 'WORKSPACE_ROOT', value: WORKSPACE_REPOS_PATH },
                { name: 'REPOS_DIR', value: WORKSPACE_REPOS_PATH },
                { name: 'SYNTHI_REPOS_PATH', value: WORKSPACE_REPOS_PATH },
                { name: 'WORKSPACE_DIR', value: workspaceDir },
              ],
              resources: {
                requests: { cpu: '2', memory: '4Gi' },
                limits: { cpu: '6', memory: '12Gi' },
              },
              livenessProbe: {
                exec: { command: ['pgrep', '-f', 'worker'] },
                initialDelaySeconds: 10,
                periodSeconds: 15,
              },
              volumeMounts: [
                { name: 'dshm', mountPath: '/dev/shm' },
                { name: 'tmp', mountPath: '/tmp' },
                ...(WORKSPACE_DATA_PVC ? [{ name: 'workspace-data', mountPath: WORKSPACE_DATA_MOUNT }] : []),
              ],
            },
            {
              name: 'preview-proxy',
              image: PREVIEW_SIDECAR_IMAGE,
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: true,
              },
              command: ['node', '-e', previewSidecarScript()],
              env: [
                { name: 'SYNTHI_PREVIEW_SIDECAR_PORT', value: String(PREVIEW_SIDECAR_PORT) },
                { name: 'SYNTHI_PREVIEW_SIDECAR_PREFIX', value: PREVIEW_SIDECAR_PREFIX },
              ],
              ports: [
                { name: 'preview-proxy', containerPort: PREVIEW_SIDECAR_PORT },
              ],
              resources: {
                requests: { cpu: '25m', memory: '64Mi' },
                limits: { cpu: '250m', memory: '256Mi' },
              },
              readinessProbe: {
                httpGet: { path: '/healthz', port: PREVIEW_SIDECAR_PORT },
                initialDelaySeconds: 1,
                periodSeconds: 5,
              },
              livenessProbe: {
                httpGet: { path: '/healthz', port: PREVIEW_SIDECAR_PORT },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            },
          ],
          volumes: [
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
            ...(WORKSPACE_DATA_PVC ? [{ name: 'workspace-data', persistentVolumeClaim: { claimName: WORKSPACE_DATA_PVC } }] : []),
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
      releaseRuntimeFilesystem(sessionId);
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
    releaseRuntimeFilesystem(sessionId);
    return;
  }
  const name = deploymentName(sessionId);
  activeSessions.delete(sessionId);
  releaseRuntimeFilesystem(sessionId);

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
        const sid = dep.metadata.annotations?.['synthi/runtimeScopeFull'] || '?';
        console.log(`[Culler] Deleting idle workspace ${depName} (session=${sid}, idle=${Math.round((now - lastActive) / 1000)}s)`);

        // Delete the associated Service.
        await deleteService(sid);
        activeSessions.delete(sid);
        releaseRuntimeFilesystem(sid);

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
