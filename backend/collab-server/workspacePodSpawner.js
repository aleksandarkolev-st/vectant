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

const fs = require('fs');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const { runtimeResourceId, metadataHash, dnsLabelValue } = require('./runtimeIdentity');
const { ensureRuntimeFilesystem, releaseRuntimeFilesystem } = require('./runtimeFilesystem');
const { buildRuntimeDeployment, buildRuntimeService, runtimeDeploymentName, isSysboxRuntimeEnabled, RUNTIME_MANAGED_BY, RUNTIME_DOCKER_DATA_SUBDIR } = require('./runtimePodSpec');
const { persistentRuntimeEnvEntries, persistentRuntimeShellSetup } = require('./runtimePersistence');
const lifecycle = require('./sessionLifecycle');

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
const PREVIEW_SIDECAR_TIMEOUT_MS = parsePositiveInt(process.env.SYNTHI_PREVIEW_SIDECAR_TIMEOUT_MS, 30_000);
const PREVIEW_PORT_PROBE_TIMEOUT_MS = parsePositiveInt(process.env.SYNTHI_PREVIEW_PORT_PROBE_TIMEOUT_MS, 1_500);
const PREVIEW_PUBLIC_DOMAIN = (process.env.SYNTHI_PREVIEW_PUBLIC_DOMAIN || '').trim();
const PREVIEW_PUBLIC_PROTOCOL = (process.env.SYNTHI_PREVIEW_PUBLIC_PROTOCOL || 'https').trim();
const PREVIEW_SCAN_PORTS = (process.env.SYNTHI_PREVIEW_SCAN_PORTS || '').trim();
const PREVIEW_EXCLUDE_PORTS = (
  process.env.SYNTHI_PREVIEW_EXCLUDE_PORTS ||
  process.env.SYNTHI_PREVIEW_INFRA_PORTS ||
  ''
).trim();
const WORKFLOW_BRIDGE_IMAGE = (process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_IMAGE || '').trim();
const WORKFLOW_BRIDGE_PORT = parseSinglePort(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT, 9466);
const WORKFLOW_EXTERNAL_OPEN_BODY_LIMIT_BYTES = parsePositiveInt(process.env.SYNTHI_BROWSER_EXTERNAL_OPEN_BODY_LIMIT_BYTES, 20_000);
const WORKFLOW_EXTERNAL_OPEN_TIMEOUT_MS = parsePositiveInt(process.env.SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS, 15_000);
const HOSTED_BROWSER_CDP_PORT = parseSinglePort(process.env.SYNTHI_HOSTED_BROWSER_CDP_PORT, 9222);
const HOSTED_BROWSER_VIEW_PORT = parseSinglePort(process.env.SYNTHI_HOSTED_BROWSER_VIEW_PORT, 6080);
const HOSTED_BROWSER_VNC_PORT = parseSinglePort(process.env.SYNTHI_HOSTED_BROWSER_VNC_PORT, 5900);

// ── Sysbox runtime-pod config (Slice 2; dark behind RUNTIME_BACKEND=sysbox-pod) ──
// Separate caps/timeouts from the worker's so the two untrusted workloads are
// tuned independently; default to the worker's values when unset.
const MAX_RUNTIME_PODS = Number(process.env.MAX_RUNTIME_PODS) || MAX_WORKSPACE_PODS;
const RUNTIME_IDLE_TIMEOUT_MS = Number(process.env.RUNTIME_IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS;
const RUNTIME_CULL_INTERVAL_MS = Number(process.env.RUNTIME_CULL_INTERVAL_MS) || CULL_INTERVAL_MS;
const RUNTIME_POD_READY_TIMEOUT_MS = Number(process.env.RUNTIME_POD_READY_TIMEOUT_MS) || POD_READY_TIMEOUT_MS;

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

function cleanupReason(options, fallback = 'teardown') {
  if (typeof options === 'string') return options;
  return options?.reason || fallback;
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

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function runtimeWorkflowStoreDir(sessionId, metadata = {}) {
  return `${workspaceDirForMetadata(metadata).replace(/\/+$/, '')}/.synthi/workflows/${safePathSegment(runtimeResourceId(sessionId))}`;
}

function runtimeWorkspaceUrl(metadata = {}) {
  const appUrl = (process.env.SYNTHI_APP_INTERNAL_URL || 'http://frontend.synthi.svc.cluster.local:3000').replace(/\/+$/, '');
  const slug = String(metadata.workspaceSlug || '').trim();
  return slug ? `${appUrl}/workspace/${encodeURIComponent(slug)}` : appUrl;
}

function workflowBridgeContainers(sessionId, metadata = {}) {
  if (!WORKFLOW_BRIDGE_IMAGE) return [];

  const storeDir = runtimeWorkflowStoreDir(sessionId, metadata);
  const workspaceUrl = runtimeWorkspaceUrl(metadata);
  const runtimeId = runtimeResourceId(sessionId);
  const workspaceId = String(metadata.workspaceSlug || runtimeId);
  const workspaceDataMount = WORKSPACE_DATA_PVC ? [{ name: 'workspace-data', mountPath: WORKSPACE_DATA_MOUNT }] : [];

  return [
    {
      name: 'workflow-bridge',
      image: WORKFLOW_BRIDGE_IMAGE,
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        allowPrivilegeEscalation: true,
      },
      command: ['node', 'dist/browser_workflow_bridge/standalone.js'],
      env: [
        { name: 'SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST', value: '0.0.0.0' },
        { name: 'SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT', value: String(WORKFLOW_BRIDGE_PORT) },
        {
          name: 'SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN',
          valueFrom: { secretKeyRef: { name: 'synthi-secrets', key: 'SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN' } },
        },
        { name: 'SYNTHI_HOSTED_BROWSER_CDP_URL', value: `http://127.0.0.1:${HOSTED_BROWSER_CDP_PORT}` },
        { name: 'SYNTHI_PREVIEW_SIDECAR_PORT', value: String(PREVIEW_SIDECAR_PORT) },
        { name: 'SYNTHI_PREVIEW_SIDECAR_PREFIX', value: PREVIEW_SIDECAR_PREFIX },
        { name: 'SYNTHI_PREVIEW_PUBLIC_DOMAIN', value: PREVIEW_PUBLIC_DOMAIN },
        { name: 'SYNTHI_PREVIEW_PUBLIC_PROTOCOL', value: PREVIEW_PUBLIC_PROTOCOL },
        { name: 'SYNTHI_BROWSER_EXTERNAL_OPEN_BODY_LIMIT_BYTES', value: String(WORKFLOW_EXTERNAL_OPEN_BODY_LIMIT_BYTES) },
        { name: 'SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS', value: String(WORKFLOW_EXTERNAL_OPEN_TIMEOUT_MS) },
        { name: 'SYNTHI_WORKSPACE_ID', value: workspaceId },
        { name: 'SYNTHI_WORKSPACE_URL', value: workspaceUrl },
        { name: 'SYNTHI_HOSTED_BROWSER_WORKSPACE_URL', value: workspaceUrl },
        { name: 'SYNTHI_HOSTED_BROWSER_RUNTIME_ID', value: runtimeId },
        { name: 'SYNTHI_WORKFLOW_RUNTIME_SCOPE', value: sessionId },
        { name: 'SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE', value: sessionId },
        { name: 'SYNTHI_AUTH_CHECKPOINT_SCOPE', value: sessionId },
        {
          name: 'SYNTHI_COLLAB_SERVER_URL',
          valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'COLLAB_SERVER_URL' } },
        },
        {
          name: 'COLLAB_SERVER_URL',
          valueFrom: { configMapKeyRef: { name: 'synthi-config', key: 'COLLAB_SERVER_URL' } },
        },
        { name: 'SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE', value: `${storeDir}/private-tools.enc.json` },
        {
          name: 'SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY',
          valueFrom: { secretKeyRef: { name: 'synthi-secrets', key: 'SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY' } },
        },
        { name: 'SYNTHI_AUTH_CHECKPOINT_STORE_FILE', value: `${storeDir}/auth-checkpoints.enc.json` },
        {
          name: 'SYNTHI_AUTH_CHECKPOINT_STORE_KEY',
          valueFrom: { secretKeyRef: { name: 'synthi-secrets', key: 'SYNTHI_AUTH_CHECKPOINT_STORE_KEY' } },
        },
        { name: 'SYNTHI_VISION_BACKEND', value: 'agent_side' },
      ],
      ports: [
        { name: 'workflow', containerPort: WORKFLOW_BRIDGE_PORT },
      ],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
      readinessProbe: {
        httpGet: { path: '/healthz', port: WORKFLOW_BRIDGE_PORT },
        initialDelaySeconds: 2,
        periodSeconds: 5,
      },
      livenessProbe: {
        httpGet: { path: '/healthz', port: WORKFLOW_BRIDGE_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 15,
      },
      volumeMounts: workspaceDataMount,
    },
    {
      name: 'hosted-browser',
      image: WORKFLOW_BRIDGE_IMAGE,
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        allowPrivilegeEscalation: true,
      },
      command: ['/bin/bash', '-lc'],
      args: [
        [
          'set -euo pipefail',
          'export DISPLAY="${DISPLAY:-:99}"',
          'BROWSER="$(node -e "const { chromium } = require(\'playwright-core\'); process.stdout.write(chromium.executablePath())")"',
          'VIEW_SIZE="${SYNTHI_HOSTED_BROWSER_VIEW_SIZE:-1366x768x24}"',
          'WINDOW_SIZE="${SYNTHI_HOSTED_BROWSER_WINDOW_SIZE:-1366,768}"',
          'rm -f /tmp/.X99-lock',
          'Xvfb "$DISPLAY" -screen 0 "$VIEW_SIZE" -ac +extension GLX +render -noreset &',
          'XVFB_PID="$!"',
          'sleep 0.5',
          'x11vnc -display "$DISPLAY" -localhost -nopw -shared -forever -rfbport "$SYNTHI_HOSTED_BROWSER_VNC_PORT" -quiet &',
          'VNC_PID="$!"',
          'websockify --web=/usr/share/novnc "$SYNTHI_HOSTED_BROWSER_VIEW_PORT" "127.0.0.1:$SYNTHI_HOSTED_BROWSER_VNC_PORT" &',
          'NOVNC_PID="$!"',
          '"$BROWSER" --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-address=0.0.0.0 --remote-debugging-port="$SYNTHI_HOSTED_BROWSER_CDP_PORT" --user-data-dir=/tmp/synthi-chrome-profile --window-size="$WINDOW_SIZE" --start-maximized about:blank &',
          'BROWSER_PID="$!"',
          'trap \'kill "$BROWSER_PID" "$NOVNC_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true\' EXIT TERM INT',
          'wait "$BROWSER_PID"',
        ].join('\n'),
      ],
      env: [
        { name: 'SYNTHI_HOSTED_BROWSER_CDP_PORT', value: String(HOSTED_BROWSER_CDP_PORT) },
        { name: 'SYNTHI_HOSTED_BROWSER_VIEW_PORT', value: String(HOSTED_BROWSER_VIEW_PORT) },
        { name: 'SYNTHI_HOSTED_BROWSER_VNC_PORT', value: String(HOSTED_BROWSER_VNC_PORT) },
      ],
      ports: [
        { name: 'cdp', containerPort: HOSTED_BROWSER_CDP_PORT },
        { name: 'browser-view', containerPort: HOSTED_BROWSER_VIEW_PORT },
      ],
      resources: {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '2', memory: '2Gi' },
      },
      readinessProbe: {
        exec: {
          command: [
            'node',
            '-e',
            `Promise.all([fetch('http://127.0.0.1:${HOSTED_BROWSER_CDP_PORT}/json/version'),fetch('http://127.0.0.1:${HOSTED_BROWSER_VIEW_PORT}/vnc.html')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))`,
          ],
        },
        initialDelaySeconds: 3,
        periodSeconds: 5,
      },
      livenessProbe: {
        exec: {
          command: [
            'node',
            '-e',
            `Promise.all([fetch('http://127.0.0.1:${HOSTED_BROWSER_CDP_PORT}/json/version'),fetch('http://127.0.0.1:${HOSTED_BROWSER_VIEW_PORT}/vnc.html')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))`,
          ],
        },
        initialDelaySeconds: 15,
        periodSeconds: 20,
      },
      volumeMounts: [
        { name: 'dshm', mountPath: '/dev/shm' },
        { name: 'tmp', mountPath: '/tmp' },
      ],
    },
  ];
}

function runtimeSharedVolumes() {
  return [
    { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
    { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
    ...(WORKSPACE_DATA_PVC ? [{ name: 'workspace-data', persistentVolumeClaim: { claimName: WORKSPACE_DATA_PVC } }] : []),
  ];
}

function stableTemplateAnnotations(annotations = {}) {
  const stable = { ...annotations };
  delete stable['synthi/lastActive'];
  delete stable['synthi/runtimeKind'];
  return stable;
}

function reconciledTemplateAnnotations(annotations = {}) {
  return {
    ...stableTemplateAnnotations(annotations),
    'synthi/lastActive': null,
    'synthi/runtimeKind': null,
  };
}

function runtimeDeploymentReconcilePatch(sessionId, userId, metadata = {}, labels = {}, annotations = {}) {
  const filesystemUserId = metadata.filesystemUserId || metadata.filesystem_user_id || userId;
  const workflowContainers = workflowBridgeContainers(sessionId, { ...metadata, filesystemUserId });
  const patch = {
    metadata: {
      labels,
      annotations,
    },
  };

  if (workflowContainers.length > 0) {
    patch.spec = {
      template: {
        metadata: {
          labels,
          annotations: reconciledTemplateAnnotations(annotations),
        },
        spec: {
          containers: workflowContainers,
          volumes: runtimeSharedVolumes(),
        },
      },
    };
  }

  return patch;
}

function previewSidecarScript() {
  return [
    "'use strict';",
    "const http = require('http');",
    "const net = require('net');",
    "const fs = require('fs');",
    "const { URL } = require('url');",
    "const LISTEN_PORT = Number(process.env.SYNTHI_PREVIEW_SIDECAR_PORT || '18080');",
    "const PREFIX = normalizePrefix(process.env.SYNTHI_PREVIEW_SIDECAR_PREFIX || '/__synthi_preview');",
    `const TIMEOUT_MS = Number(process.env.SYNTHI_PREVIEW_SIDECAR_TIMEOUT_MS || '${PREVIEW_SIDECAR_TIMEOUT_MS}');`,
    `const PORT_PROBE_TIMEOUT_MS = Math.max(250, Math.min(Number(process.env.SYNTHI_PREVIEW_PORT_PROBE_TIMEOUT_MS || '${PREVIEW_PORT_PROBE_TIMEOUT_MS}'), TIMEOUT_MS));`,
    "const INFRA_PORTS = new Set([",
    "  LISTEN_PORT,",
    "  Number(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT || 0),",
    "  Number(process.env.SYNTHI_HOSTED_BROWSER_CDP_PORT || 0),",
    "  Number(process.env.SYNTHI_HOSTED_BROWSER_VIEW_PORT || 0),",
    "  Number(process.env.SYNTHI_HOSTED_BROWSER_VNC_PORT || 0),",
    "  ...parsePortList(process.env.SYNTHI_PREVIEW_EXCLUDE_PORTS || process.env.SYNTHI_PREVIEW_INFRA_PORTS || ''),",
    "].filter((port) => Number.isInteger(port) && port > 0));",
    "function normalizePrefix(value) { const raw = String(value || '').trim() || '/__synthi_preview'; const withSlash = raw.startsWith('/') ? raw : '/' + raw; return withSlash.replace(/\\/+$/, '') || '/__synthi_preview'; }",
    "function sendJson(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }",
    "function parsePortList(value) {",
    "  const ports = new Set();",
    "  for (const rawPart of String(value || '').split(',')) {",
    "    const part = rawPart.trim();",
    "    if (!part) continue;",
    "    const range = /^(\\d+)\\s*-\\s*(\\d+)$/.exec(part);",
    "    if (range) {",
    "      const start = Number(range[1]);",
    "      const end = Number(range[2]);",
    "      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;",
    "      const low = Math.max(1, Math.min(start, end));",
    "      const high = Math.min(65535, Math.max(start, end));",
    "      for (let port = low; port <= high; port += 1) ports.add(port);",
    "      continue;",
    "    }",
    "    const port = Number(part);",
    "    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);",
    "  }",
    "  return [...ports];",
    "}",
    "function discoverProcListeningPorts(file) {",
    "  try {",
    "    const lines = fs.readFileSync(file, 'utf8').trim().split('\\n').slice(1);",
    "    return lines.flatMap((line) => {",
    "      const parts = line.trim().split(/\\s+/);",
    "      if (parts[3] !== '0A') return [];",
    "      const local = parts[1] || '';",
    "      const portHex = local.split(':').pop();",
    "      const port = Number.parseInt(portHex, 16);",
    "      return Number.isInteger(port) && port > 0 && port <= 65535 ? [port] : [];",
    "    });",
    "  } catch (_) {",
    "    return [];",
    "  }",
    "}",
    "function discoverListeningPorts() {",
    "  const ports = new Set([",
    "    ...discoverProcListeningPorts('/proc/net/tcp'),",
    "    ...discoverProcListeningPorts('/proc/net/tcp6'),",
    "    ...parsePortList(process.env.SYNTHI_PREVIEW_SCAN_PORTS || ''),",
    "  ]);",
    "  return [...ports]",
    "    .filter((port) => !INFRA_PORTS.has(port))",
    "    .sort((a, b) => a - b);",
    "}",
    "function probeHttpPort(port) {",
    "  return new Promise((resolve) => {",
    "    const req = http.request({",
    "      hostname: 'localhost',",
    "      port,",
    "      path: '/',",
    "      method: 'HEAD',",
    "      timeout: PORT_PROBE_TIMEOUT_MS,",
    "      autoSelectFamily: true,",
    "    }, (probeRes) => {",
    "      probeRes.resume();",
    "      resolve(true);",
    "    });",
    "    req.on('timeout', () => req.destroy(new Error('preview_probe_timeout')));",
    "    req.on('error', () => resolve(false));",
    "    req.end();",
    "  });",
    "}",
    "async function discoverActivePreviewPorts() {",
    "  const ports = discoverListeningPorts();",
    "  const results = await Promise.all(ports.map(async (port) => ({ port, http: await probeHttpPort(port) })));",
    "  return results.filter((result) => result.http).map((result) => result.port);",
    "}",
    "function parsePreviewUrl(rawUrl) {",
    "  const url = new URL(rawUrl || '/', 'http://preview.local');",
    "  if (url.pathname === '/healthz') return { health: true };",
    "  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;",
    "  const suffix = url.pathname.slice(PREFIX.length);",
    "  if (suffix === '/ports') return { ports: true };",
    "  const match = /^\\/(\\d+)(\\/.*)?$/.exec(suffix);",
    "  if (!match) return null;",
    "  const port = Number(match[1]);",
    "  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;",
    "  return { port, path: (match[2] || '/') + url.search };",
    "}",
    "function upstreamHeaders(headers, port) {",
    "  const next = { ...headers, host: 'localhost:' + port };",
    "  delete next['proxy-connection'];",
    "  next['accept-encoding'] = 'identity';",
    "  return next;",
    "}",
    "async function proxyHttp(req, res) {",
    "  let parsed;",
    "  try { parsed = parsePreviewUrl(req.url); }",
    "  catch (err) { sendJson(res, 400, { error: 'invalid_preview_url', detail: err.message }); return; }",
    "  if (parsed && parsed.health) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }",
    "  if (parsed && parsed.ports) {",
    "    const activePorts = await discoverActivePreviewPorts();",
    "    sendJson(res, 200, { activePorts, source: 'runtime_sidecar' });",
    "    return;",
    "  }",
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
function watchPodReady({ labelSelector, timeoutMs, describe }) {
  return new Promise((resolve, reject) => {
    const watchPath = `/api/v1/namespaces/${NAMESPACE}/pods`;
    let resolved = false;
    let watchReq = null;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (watchReq) {
          try { watchReq.destroy(); } catch (_) { /* ignore */ }
        }
        reject(new Error(`Pod for ${describe} did not become Ready within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    watcher.watch(
      watchPath,
      { labelSelector },
      (_phase, pod) => {
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

// Scope the worker watch to app=workspace: the runtime pod shares the same
// synthi/runtime-id, so without the app label this would also match (and resolve
// on) the runtime pod.
function waitForPodRunning(sessionId) {
  return watchPodReady({
    labelSelector: `app=workspace,synthi/runtime-id=${runtimeResourceId(sessionId)}`,
    timeoutMs: POD_READY_TIMEOUT_MS,
    describe: `session ${sessionId}`,
  });
}

// Runtime-pod readiness — scoped to app=runtime. "All containers ready" already
// implies dockerd-ready because the runtime container's readinessProbe execs
// `docker info` (see runtimePodSpec.js).
function waitForRuntimePodReady(sessionId) {
  return watchPodReady({
    labelSelector: `app=runtime,synthi/runtime-id=${runtimeResourceId(sessionId)}`,
    timeoutMs: RUNTIME_POD_READY_TIMEOUT_MS,
    describe: `runtime ${sessionId}`,
  });
}

async function getReadyPodForSession(sessionId) {
  const labelSelector = `app=workspace,synthi/runtime-id=${runtimeResourceId(sessionId)}`;
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

async function getPodSnapshotForSession(sessionId) {
  const labelSelector = `app=workspace,synthi/runtime-id=${runtimeResourceId(sessionId)}`;
  try {
    const { body } = await coreApi.listNamespacedPod(
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector,
    );
    const pods = Array.isArray(body?.items) ? body.items : [];
    if (!pods.length) {
      return {
        pod_running: false,
        pod_ready: false,
        pod_name: null,
        pod_ip: null,
        pod_phase: 'missing',
        container_ready_count: 0,
        container_count: 0,
      };
    }

    const pod = pods.find(p => p?.status?.phase === 'Running') || pods[0];
    const statuses = pod?.status?.containerStatuses || [];
    const readyCount = statuses.filter(c => c.ready).length;
    const allReady = statuses.length > 0 && readyCount === statuses.length;
    return {
      pod_running: pod?.status?.phase === 'Running',
      pod_ready: allReady,
      pod_name: pod?.metadata?.name || null,
      pod_ip: pod?.status?.podIP || null,
      pod_phase: pod?.status?.phase || 'unknown',
      container_ready_count: readyCount,
      container_count: statuses.length,
    };
  } catch (err) {
    console.warn(`[Spawner] Failed to get pod snapshot for ${runtimeResourceId(sessionId)}:`, err.message);
    return {
      pod_running: false,
      pod_ready: false,
      pod_name: null,
      pod_ip: null,
      pod_phase: 'unknown',
      container_ready_count: 0,
      container_count: 0,
    };
  }
}

// ── Dynamic Service per workspace ─────────────────────────────────────────

function normalizeServicePort(port = {}) {
  return {
    name: String(port.name || ''),
    port: Number(port.port),
    targetPort: String(port.targetPort ?? port.port ?? ''),
    protocol: String(port.protocol || 'TCP'),
  };
}

function sameStringMap(left = {}, right = {}) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && String(left[key]) === String(right[key]));
}

function serviceNeedsReconcile(existing, selector, ports) {
  if (!existing?.spec) return true;
  if (!sameStringMap(existing.spec.selector || {}, selector)) return true;

  const existingPorts = (existing.spec.ports || []).map(normalizeServicePort);
  const desiredPorts = (ports || []).map(normalizeServicePort);
  if (existingPorts.length !== desiredPorts.length) return true;

  const byName = new Map(existingPorts.map((port) => [port.name, port]));
  return desiredPorts.some((desired) => {
    const current = byName.get(desired.name);
    return !current ||
      current.port !== desired.port ||
      current.targetPort !== desired.targetPort ||
      current.protocol !== desired.protocol;
  });
}

function k8sErrorMessage(err) {
  return err?.body?.message ||
    err?.response?.body?.message ||
    err?.response?.body?.error ||
    err?.message ||
    String(err);
}

/**
 * Create a ClusterIP Service pointing at the workspace pod.
 * Idempotent — 409 Conflict means it already exists.
 */
async function ensureService(sessionId) {
  const name = serviceName(sessionId);
  const labels = runtimeLabels(sessionId, null);
  const annotations = {
    'synthi/runtimeScopeFull': sessionId,
  };
  const selector = {
    app: 'workspace',
    'synthi/runtime-id': runtimeResourceId(sessionId),
  };
  const ports = [
    { name: 'preview-proxy', port: PREVIEW_SIDECAR_PORT, targetPort: PREVIEW_SIDECAR_PORT },
    ...(WORKFLOW_BRIDGE_IMAGE ? [{ name: 'workflow', port: WORKFLOW_BRIDGE_PORT, targetPort: WORKFLOW_BRIDGE_PORT }] : []),
  ];
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels,
      annotations,
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: 'None',
      selector,
      ports,
    },
  };

  try {
    await coreApi.createNamespacedService(NAMESPACE, service);
    console.log(`[Spawner] Created Service: ${name}`);
  } catch (err) {
    if (err.response?.statusCode === 409) {
      try {
        const { body: existingService } = await coreApi.readNamespacedService(name, NAMESPACE);
        if (!serviceNeedsReconcile(existingService, selector, ports)) {
          return;
        }
        await coreApi.patchNamespacedService(
          name,
          NAMESPACE,
          {
            metadata: { labels, annotations },
            spec: { selector, ports },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
          },
        );
        console.log(`[Spawner] Reconciled Service: ${name}`);
      } catch (patchErr) {
        console.error(`[Spawner] Service reconciliation failed for ${name}:`, k8sErrorMessage(patchErr));
      }
    } else {
      console.error(`[Spawner] Service creation failed for ${name}:`, k8sErrorMessage(err));
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
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, runtimeDeploymentReconcilePatch(
      sessionId,
      userId,
      { ...metadata, filesystemUserId },
      labels,
      annotations,
    ), undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
    activeSessions.add(sessionId);
    await ensureService(sessionId);
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
  const persistentEnv = persistentRuntimeEnvEntries(workspaceDir);
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
          annotations: stableTemplateAnnotations(annotations),
        },
        spec: {
          terminationGracePeriodSeconds: 15,
          securityContext: {
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
${persistentRuntimeShellSetup()}
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
                ...persistentEnv,
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
                { name: 'SYNTHI_PREVIEW_SIDECAR_TIMEOUT_MS', value: String(PREVIEW_SIDECAR_TIMEOUT_MS) },
                { name: 'SYNTHI_PREVIEW_PORT_PROBE_TIMEOUT_MS', value: String(PREVIEW_PORT_PROBE_TIMEOUT_MS) },
                { name: 'SYNTHI_PREVIEW_SCAN_PORTS', value: PREVIEW_SCAN_PORTS },
                { name: 'SYNTHI_PREVIEW_EXCLUDE_PORTS', value: PREVIEW_EXCLUDE_PORTS },
                { name: 'SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT', value: String(WORKFLOW_BRIDGE_PORT) },
                { name: 'SYNTHI_HOSTED_BROWSER_CDP_PORT', value: String(HOSTED_BROWSER_CDP_PORT) },
                { name: 'SYNTHI_HOSTED_BROWSER_VIEW_PORT', value: String(HOSTED_BROWSER_VIEW_PORT) },
                { name: 'SYNTHI_HOSTED_BROWSER_VNC_PORT', value: String(HOSTED_BROWSER_VNC_PORT) },
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
            ...workflowBridgeContainers(sessionId, { ...metadata, filesystemUserId }),
          ],
          volumes: [
            ...runtimeSharedVolumes(),
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
    await teardown(sessionId, { reason: 'readiness_timeout' });
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

  // Keep the per-session runtime pod alive too (self-gated; no-op when flag off).
  await touchRuntime(sessionId);
}

/**
 * Reconcile Kubernetes state into the common lifecycle endpoint.
 */
async function lifecycleSnapshot(sessionId) {
  if (process.env.SPAWNER_MODE === 'local') {
    return {
      ...lifecycle.snapshot(sessionId),
      pod_running: false,
      pod_ready: false,
      spawner_tracked: activeSessions.has(sessionId),
      k8s_deployment: false,
    };
  }

  const name = deploymentName(sessionId);
  const advisory = lifecycle.snapshot(sessionId);
  let deploymentExists = false;

  try {
    await appsApi.readNamespacedDeployment(name, NAMESPACE);
    deploymentExists = true;
  } catch (err) {
    if (err.response?.statusCode !== 404) {
      throw err;
    }
  }

  if (!deploymentExists) {
    if (advisory.state !== 'unknown' && advisory.state !== 'terminated') {
      lifecycle.markTerminated(sessionId, 'deployment_missing');
    }
    return {
      ...lifecycle.snapshot(sessionId),
      pod_running: false,
      pod_ready: false,
      spawner_tracked: activeSessions.has(sessionId),
      k8s_deployment: false,
      deployment_name: name,
    };
  }

  const pod = await getPodSnapshotForSession(sessionId);
  if (pod.pod_ready) {
    const current = lifecycle.snapshot(sessionId).state;
    if (current !== 'running' && current !== 'migrating') {
      lifecycle.markReady(sessionId);
    }
  } else if (pod.pod_phase === 'Failed') {
    lifecycle.markCrashed(sessionId, 'pod_failed');
  } else {
    lifecycle.markWarming(sessionId, {
      stage: pod.pod_running ? 'containers_starting' : 'pod_scheduled',
      stage_progress_pct: pod.pod_running ? 70 : 40,
      estimated_ready_at: Date.now() + 30_000,
    });
  }

  return {
    ...lifecycle.snapshot(sessionId),
    ...pod,
    spawner_tracked: activeSessions.has(sessionId),
    k8s_deployment: true,
    deployment_name: name,
  };
}

/**
 * Pre-warm a Kubernetes runtime without blocking the HTTP request.
 */
async function warm(sessionId, userId, metadata = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  lifecycle.markWarming(sessionId, {
    stage: 'warm_triggered',
    stage_progress_pct: 5,
    estimated_ready_at: Date.now() + 60_000,
  });
  ensurePod(sessionId, userId, metadata).then(() => {
    lifecycle.markReady(sessionId);
  }).catch((err) => {
    console.error(`[Spawner] warm ensurePod failed for ${sessionId}:`, err.message);
    lifecycle.markCrashed(sessionId, `warm_failed: ${err.message}`);
  });
  return lifecycle.snapshot(sessionId);
}

/**
 * Immediately delete the workspace Deployment and Service for a session.
 * Called when the signaling server reports both peers disconnected.
 */
async function teardown(sessionId, options = {}) {
  const reason = cleanupReason(options);
  if (process.env.SPAWNER_MODE === 'local') {
    activeSessions.delete(sessionId);
    releaseRuntimeFilesystem(sessionId);
    lifecycle.markTerminated(sessionId, reason);
    return;
  }
  const name = deploymentName(sessionId);
  activeSessions.delete(sessionId);
  releaseRuntimeFilesystem(sessionId);
  lifecycle.markTerminated(sessionId, reason);

  // Tear down the per-session Sysbox runtime pod too (self-gated; no-op when flag
  // off). Done before the worker delete so an early 404-return can't skip it.
  await runtimeTeardown(sessionId, reason).catch((err) =>
    console.error(`[RuntimeSpawner] teardown error for ${sessionId}:`, err.message));

  // Delete Service first (non-fatal).
  await deleteService(sessionId);

  // Delete Deployment.
  try {
    await appsApi.deleteNamespacedDeployment(name, NAMESPACE);
    console.log(`[Spawner] Deleted workspace pod: ${name} (reason=${reason})`);
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

        if (sid && sid !== '?') {
          await teardown(sid, { reason: 'idle_timeout' });
          continue;
        }

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
let runtimeCullerInterval = null;

function startCuller() {
  if (process.env.SPAWNER_MODE === 'local') return;
  if (!cullerInterval) {
    cullerInterval = setInterval(cullIdleWorkspaces, CULL_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive on shutdown.
    if (cullerInterval.unref) cullerInterval.unref();
    console.log(`[Culler] Started (interval=${CULL_INTERVAL_MS}ms, timeout=${IDLE_TIMEOUT_MS}ms)`);
  }
  // Runtime-pod culler — cullIdleRuntimePods self-gates on the flag, so it's safe
  // to always start in k8s (lets a flag flip-on take effect without a restart).
  if (!runtimeCullerInterval) {
    runtimeCullerInterval = setInterval(cullIdleRuntimePods, RUNTIME_CULL_INTERVAL_MS);
    if (runtimeCullerInterval.unref) runtimeCullerInterval.unref();
    console.log(`[RuntimeCuller] Started (interval=${RUNTIME_CULL_INTERVAL_MS}ms, timeout=${RUNTIME_IDLE_TIMEOUT_MS}ms)`);
  }
}

function stopCuller() {
  if (cullerInterval) {
    clearInterval(cullerInterval);
    cullerInterval = null;
  }
  if (runtimeCullerInterval) {
    clearInterval(runtimeCullerInterval);
    runtimeCullerInterval = null;
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
      teardown(sid, { reason: 'shutdown_cleanup' }).catch(err =>
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
  await teardown(sessionId, { reason: 'session_ended' });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Sysbox runtime pod (Slice 2 — dark behind RUNTIME_BACKEND=sysbox-pod) ─────
//
// A per-workspace "runtime pod" runs rootless dockerd under the sysbox-runc
// RuntimeClass on the sysbox node pool, SEPARATE from the compile/preview worker
// pod. It mirrors the worker lifecycle (create / dockerd-ready watch / idle cull /
// capacity guard / teardown-releases-FS-pin) but with its OWN identity so the two
// never interfere: distinct Deployment name (`*-rt`), distinct managed-by label
// (`runtime-spawner`), and its own refcounted FS-pin scope (so the workspace repo
// stays pinned until BOTH the worker and the runtime release it).
//
// Every function self-gates on isSysboxRuntimeEnabled(), so with the flag off the
// wiring in teardown()/touch()/startCuller() is a zero-cost no-op.

/** Pure capacity guard — true once the active runtime-pod count reaches the cap. */
function runtimeAtCapacity(count, max) {
  return count >= max;
}

/**
 * Pure idle-cull decision for runtime Deployments. Returns [{ name, sessionId }]
 * for each Deployment whose synthi/lastActive is older than timeoutMs. A missing
 * annotation counts as idle (mirrors the worker culler's `|| 0` default).
 */
function runtimeCullDecision(deployments, now, timeoutMs) {
  const out = [];
  for (const dep of deployments || []) {
    const annotations = (dep && dep.metadata && dep.metadata.annotations) || {};
    const lastActive = Number(annotations['synthi/lastActive'] || 0);
    if (now - lastActive > timeoutMs) {
      out.push({
        name: dep.metadata && dep.metadata.name,
        sessionId: annotations['synthi/runtimeScopeFull'] || null,
      });
    }
  }
  return out;
}

/** FS-pin scope for the runtime pod — distinct from the worker's sessionId scope. */
function runtimePinScope(sessionId) {
  return runtimeDeploymentName(sessionId);
}

/** Count active runtime Deployments (managed-by=runtime-spawner). */
async function getActiveRuntimeCount() {
  try {
    const { body } = await appsApi.listNamespacedDeployment(
      NAMESPACE, undefined, undefined, undefined, undefined,
      `app.kubernetes.io/managed-by=${RUNTIME_MANAGED_BY}`,
    );
    return body.items.length;
  } catch (err) {
    console.error('[RuntimeSpawner] Failed to count runtime pods:', err.message);
    return 0;
  }
}

/**
 * Pure mapper: runtime Deployment list → active runtime sessions for the Slice-4
 * port monitor — { runtimeScope (full session id), slug }. Deployments missing the
 * runtimeScope annotation are skipped (can't address their pod/preview).
 */
function runtimeSessionsFromDeployments(deployments) {
  const out = [];
  for (const dep of deployments || []) {
    const ann = (dep && dep.metadata && dep.metadata.annotations) || {};
    const runtimeScope = ann['synthi/runtimeScopeFull'];
    if (runtimeScope) out.push({ runtimeScope, slug: ann['synthi/workspaceSlug'] || '' });
  }
  return out;
}

/** List active runtime sessions ([{runtimeScope, slug}]) for the runtime port monitor. */
async function listActiveRuntimeSessions() {
  try {
    const { body } = await appsApi.listNamespacedDeployment(
      NAMESPACE, undefined, undefined, undefined, undefined,
      `app.kubernetes.io/managed-by=${RUNTIME_MANAGED_BY}`,
    );
    return runtimeSessionsFromDeployments(body.items || []);
  } catch (err) {
    console.error('[RuntimeSpawner] Failed to list runtime sessions:', err.message);
    return [];
  }
}

/** Return the ready runtime pod for a session ({podIP,podName} or nulls). */
async function getReadyRuntimePodForSession(sessionId) {
  const labelSelector = `app=runtime,synthi/runtime-id=${runtimeResourceId(sessionId)}`;
  try {
    const { body } = await coreApi.listNamespacedPod(
      NAMESPACE, undefined, undefined, undefined, undefined, labelSelector,
    );
    for (const pod of body.items || []) {
      if (pod?.status?.phase !== 'Running' || !pod?.status?.podIP) continue;
      const statuses = pod.status.containerStatuses || [];
      if (statuses.length > 0 && statuses.every((c) => c.ready)) {
        return { podIP: pod.status.podIP, podName: pod.metadata.name };
      }
    }
  } catch (err) {
    console.warn(`[RuntimeSpawner] Failed to list ready runtime pod for ${runtimeResourceId(sessionId)}:`, err.message);
  }
  return { podIP: null, podName: null };
}

/**
 * Preview-proxy sidecar for the RUNTIME pod (Slice 4) — mirrors the worker's
 * sidecar: forwards /__synthi_preview/<port> → localhost:port inside the pod, so
 * ports the user opens in the runtime pod are reachable via the preview proxy.
 */
function buildRuntimePreviewSidecar() {
  return {
    name: 'preview-proxy',
    image: PREVIEW_SIDECAR_IMAGE,
    securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: true },
    command: ['node', '-e', previewSidecarScript()],
    env: [
      { name: 'SYNTHI_PREVIEW_SIDECAR_PORT', value: String(PREVIEW_SIDECAR_PORT) },
      { name: 'SYNTHI_PREVIEW_SIDECAR_PREFIX', value: PREVIEW_SIDECAR_PREFIX },
    ],
    ports: [{ name: 'preview-proxy', containerPort: PREVIEW_SIDECAR_PORT }],
    resources: {
      requests: { cpu: '25m', memory: '64Mi' },
      limits: { cpu: '250m', memory: '256Mi' },
    },
    readinessProbe: { httpGet: { path: '/healthz', port: PREVIEW_SIDECAR_PORT }, initialDelaySeconds: 1, periodSeconds: 5 },
    livenessProbe: { httpGet: { path: '/healthz', port: PREVIEW_SIDECAR_PORT }, initialDelaySeconds: 5, periodSeconds: 10 },
  };
}

/** Create the runtime pod's preview Service (idempotent; 409 = already exists). */
async function ensureRuntimeService(sessionId) {
  const service = buildRuntimeService(sessionId);
  try {
    await coreApi.createNamespacedService(NAMESPACE, service);
    console.log(`[RuntimeSpawner] Created runtime Service: ${service.metadata.name}`);
  } catch (err) {
    if (err.response?.statusCode !== 409) {
      console.error('[RuntimeSpawner] runtime Service creation failed:', err.message);
    }
  }
}

/** Delete the runtime pod's preview Service. */
async function deleteRuntimeService(sessionId) {
  try {
    await coreApi.deleteNamespacedService(runtimeDeploymentName(sessionId), NAMESPACE);
  } catch (err) {
    if (err.response?.statusCode !== 404) {
      console.error('[RuntimeSpawner] runtime Service deletion failed:', err.message);
    }
  }
}

/**
 * Ensure the per-workspace Sysbox runtime pod exists for a session.
 * Dark-launched: a no-op unless RUNTIME_BACKEND=sysbox-pod. Mirrors ensurePod().
 *
 * @returns {Promise<object>} {name, created, podIP, podName} on success, or
 *   {skipped, reason} when the runtime backend is off / running in local mode.
 */
async function spawnRuntimePod(sessionId, userId, metadata = {}) {
  // Dark-launch gate — OFF unless RUNTIME_BACKEND=sysbox-pod. No k8s touched.
  if (!isSysboxRuntimeEnabled()) {
    return { skipped: true, reason: 'runtime_backend_disabled' };
  }
  // Local dev has no Sysbox/k8s — the rootless-docker path lives in
  // workspaceRuntimeContainer.js; leave it untouched.
  if (process.env.SPAWNER_MODE === 'local') {
    return { skipped: true, reason: 'local_mode' };
  }

  const name = runtimeDeploymentName(sessionId);
  const filesystemUserId = metadata.filesystemUserId || metadata.filesystem_user_id || userId;
  const pinScope = runtimePinScope(sessionId);
  const pinRuntimeFs = async () => {
    if (!metadata.workspaceSlug) return null;
    return ensureRuntimeFilesystem({
      workspaceSlug: metadata.workspaceSlug,
      filesystemUserId,
      runtimeScope: pinScope,
      pin: true,
      reason: 'runtime_pod',
    });
  };

  // 1. Fast path — runtime Deployment already exists: bump activity + return ready.
  try {
    await appsApi.readNamespacedDeployment(name, NAMESPACE);
    await pinRuntimeFs();
    await touchRuntime(sessionId);
    await ensureRuntimeService(sessionId);
    try {
      const ready = await getReadyRuntimePodForSession(sessionId);
      if (ready.podName) return { name, created: false, ...ready };
      return { name, created: false, ...(await waitForRuntimePodReady(sessionId)) };
    } catch (readyErr) {
      releaseRuntimeFilesystem(pinScope);
      throw readyErr;
    }
  } catch (err) {
    if (!(err.response && err.response.statusCode === 404)) throw err;
    // 404 → does not exist; fall through to creation.
  }

  // 2. Capacity guard (mirrors the worker's MAX_WORKSPACE_PODS).
  const count = await getActiveRuntimeCount();
  if (runtimeAtCapacity(count, MAX_RUNTIME_PODS)) {
    throw new Error(`Runtime limit reached (${MAX_RUNTIME_PODS}). Try again later.`);
  }

  // 3. Pin the workspace FS under the runtime's OWN scope before create.
  await pinRuntimeFs();

  // 4. Build spec + stamp lifecycle annotations (lastActive drives the culler).
  const deployment = buildRuntimeDeployment({ sessionId, userId, metadata });
  const annotations = runtimeAnnotations(sessionId, userId, metadata);
  deployment.metadata.annotations = { ...(deployment.metadata.annotations || {}), ...annotations };
  deployment.spec.template.metadata.annotations = {
    ...(deployment.spec.template.metadata.annotations || {}),
    ...annotations,
  };
  // Preview-proxy sidecar so ports opened inside the runtime pod are reachable via
  // the preview proxy (Slice 4) — mirrors the worker pod.
  deployment.spec.template.spec.containers.push(buildRuntimePreviewSidecar());

  try {
    await appsApi.createNamespacedDeployment(NAMESPACE, deployment);
    console.log(`[RuntimeSpawner] Created runtime pod: ${name} (session=${sessionId})`);
  } catch (err) {
    if (err.response && err.response.statusCode === 409) {
      console.log(`[RuntimeSpawner] Runtime deployment ${name} already exists (conflict).`);
    } else {
      releaseRuntimeFilesystem(pinScope);
      throw err;
    }
  }

  // Create the runtime preview Service (non-fatal) so opened ports are reachable.
  await ensureRuntimeService(sessionId);

  // 5. Wait for dockerd-ready (runtime container readinessProbe → all-ready).
  try {
    const ready = await waitForRuntimePodReady(sessionId);
    console.log(`[RuntimeSpawner] Runtime pod ${ready.podName} is dockerd-ready (IP=${ready.podIP})`);
    return { name, created: true, ...ready };
  } catch (err) {
    console.error(`[RuntimeSpawner] Runtime readiness timeout for ${name}, tearing down:`, err.message);
    await runtimeTeardown(sessionId, 'runtime_readiness_timeout');
    throw new Error(`Runtime pod failed to become dockerd-ready within ${RUNTIME_POD_READY_TIMEOUT_MS / 1000}s`);
  }
}

/** Bump the runtime Deployment's lastActive (heartbeat). Self-gated. */
async function touchRuntime(sessionId) {
  if (!isSysboxRuntimeEnabled()) return;
  if (process.env.SPAWNER_MODE === 'local') return;
  const name = runtimeDeploymentName(sessionId);
  const patch = { metadata: { annotations: { 'synthi/lastActive': String(Date.now()) } } };
  try {
    await appsApi.patchNamespacedDeployment(name, NAMESPACE, patch, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    });
  } catch (err) {
    if (err.response && err.response.statusCode !== 404) {
      console.error(`[RuntimeSpawner] touchRuntime() failed for ${name}:`, err.message);
    }
  }
}

/** Delete the runtime Deployment + release its FS pin. Self-gated. */
async function runtimeTeardown(sessionId, reason = 'teardown') {
  if (!isSysboxRuntimeEnabled()) return;
  releaseRuntimeFilesystem(runtimePinScope(sessionId));
  if (process.env.SPAWNER_MODE === 'local') return;
  const name = runtimeDeploymentName(sessionId);
  await deleteRuntimeService(sessionId);
  try {
    await appsApi.deleteNamespacedDeployment(name, NAMESPACE);
    console.log(`[RuntimeSpawner] Deleted runtime pod: ${name} (reason=${reason})`);
  } catch (err) {
    if (err.response && err.response.statusCode === 404) return;
    console.error(`[RuntimeSpawner] runtimeTeardown() failed for ${name}:`, err.message);
  }
}

// ── Permanent-delete cleanup (Slice 5) ───────────────────────────────────────
// runtimeTeardown() deletes the pod but KEEPS the persisted docker-data subPath by
// design (warm resume after idle-cull). When a workspace is permanently DELETED,
// that image/build cache becomes an orphan on the PVC — purge it. collab-server
// mounts the SAME collab-data-pvc at WORKSPACE_DATA_MOUNT, so the docker-data dir is
// a plain local path here (sibling of repos/); no k8s Job is needed to remove it.
//
// CROSS-SERVICE FOLLOW-UP: the only permanent-delete path today is the Next.js
// `DELETE /api/workspace` route, which removes GCS + the DB row but does NOT call
// collab-server, so this docker-data dir (and repos/<slug>/<user>) is currently
// orphaned on the PVC. Wiring that route to a small collab purge endpoint that
// invokes purgeRuntimeData(sessionId) per session closes the gap (tracked in
// tasks/todo.md). Exported now so that flow can call it.

/** Absolute path of a session's persisted docker-data dir on the mounted PVC. */
function runtimeDockerDataDir(sessionId) {
  return path.join(WORKSPACE_DATA_MOUNT, RUNTIME_DOCKER_DATA_SUBDIR, runtimeResourceId(sessionId));
}

/**
 * Permanently remove a session's persisted docker image/build cache. Safe to call
 * unconditionally: the rm is force+recursive, so it's a no-op when the dir never
 * existed (docker-data persistence off). No-ops in local dev (no PVC mounted).
 */
async function purgeRuntimeData(sessionId) {
  if (process.env.SPAWNER_MODE === 'local') return { skipped: true, reason: 'local_mode' };
  const dir = runtimeDockerDataDir(sessionId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { purged: true, dir };
  } catch (err) {
    console.error(`[RuntimeSpawner] purgeRuntimeData() failed for ${dir}:`, err.message);
    return { purged: false, dir, error: err.message };
  }
}

/**
 * Observable lifecycle of the Sysbox RUNTIME pod for a session (Slice 5). Coarse,
 * derived from the Deployment status in one API call: absent | starting | ready |
 * stopped. Self-gated — {skipped} when the flag is off or in local dev — so the
 * /api/session/:id/lifecycle response stays byte-identical when sysbox is dark.
 * (The frontend may surface a fresh `starting` after a prior idle-cull as
 * "resuming"; that is not observable from k8s alone, since cull deletes the
 * Deployment — the distinction is the caller's, not the cluster's.)
 */
async function runtimeLifecycleSnapshot(sessionId) {
  if (!isSysboxRuntimeEnabled()) return { skipped: true, reason: 'runtime_backend_disabled' };
  if (process.env.SPAWNER_MODE === 'local') return { skipped: true, reason: 'local_mode' };
  const name = runtimeDeploymentName(sessionId);
  try {
    const { body } = await appsApi.readNamespacedDeployment(name, NAMESPACE);
    const status = body.status || {};
    const replicas = Number(status.replicas || 0);
    const readyReplicas = Number(status.readyReplicas || 0);
    const runtime_ready = readyReplicas >= 1;
    let state;
    if (runtime_ready) state = 'ready';
    else if (replicas >= 1) state = 'starting';
    else state = 'stopped';
    return {
      state,
      runtime_deployment: true,
      runtime_ready,
      replicas,
      ready_replicas: readyReplicas,
      deployment_name: name,
    };
  } catch (err) {
    if (err.response && err.response.statusCode === 404) {
      return { state: 'absent', runtime_deployment: false, runtime_ready: false, deployment_name: name };
    }
    throw err;
  }
}

/** Cull idle runtime pods (own timeout, own managed-by selector). Self-gated. */
async function cullIdleRuntimePods() {
  if (!isSysboxRuntimeEnabled()) return;
  try {
    const { body } = await appsApi.listNamespacedDeployment(
      NAMESPACE, undefined, undefined, undefined, undefined,
      `app.kubernetes.io/managed-by=${RUNTIME_MANAGED_BY}`,
    );
    const toCull = runtimeCullDecision(body.items || [], Date.now(), RUNTIME_IDLE_TIMEOUT_MS);
    for (const { name, sessionId } of toCull) {
      console.log(`[RuntimeCuller] Deleting idle runtime ${name} (session=${sessionId || '?'})`);
      if (sessionId) {
        await runtimeTeardown(sessionId, 'idle_timeout');
      } else {
        try {
          await appsApi.deleteNamespacedDeployment(name, NAMESPACE);
        } catch (delErr) {
          if (delErr.response?.statusCode !== 404) {
            console.error(`[RuntimeCuller] Failed to delete ${name}:`, delErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[RuntimeCuller] Scan failed:', err.message);
  }
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ensurePod,
  warm,
  lifecycleSnapshot,
  touch,
  teardown,
  cullIdleWorkspaces,
  startCuller,
  stopCuller,
  handleSessionEnded,
  gracefulShutdown,
  getActiveWorkspaceCount,
  // Sysbox runtime pod (Slice 2, dark behind RUNTIME_BACKEND=sysbox-pod)
  spawnRuntimePod,
  runtimeTeardown,
  purgeRuntimeData,
  runtimeDockerDataDir,
  runtimeLifecycleSnapshot,
  touchRuntime,
  cullIdleRuntimePods,
  getActiveRuntimeCount,
  getReadyRuntimePodForSession,
  listActiveRuntimeSessions,
  runtimeSessionsFromDeployments,
  runtimeCullDecision,
  runtimeAtCapacity,
};
