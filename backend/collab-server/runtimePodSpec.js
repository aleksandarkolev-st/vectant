'use strict';

/**
 * runtimePodSpec — pure builder for the per-workspace Sysbox runtime pod.
 *
 * Kept separate from workspacePodSpawner.js (which loads the k8s client at
 * require-time) so the spec shape can be unit-tested without a cluster.
 * Mirrors the worker Deployment shape from ensurePod(), but for the RUNTIME
 * pod: rootless dockerd under Sysbox — runtimeClassName sysbox-runc, NO
 * privileged, NO host docker.sock. Sysbox provides the isolation.
 */

const { runtimeResourceId, metadataHash } = require('./runtimeIdentity');

// ── Config (env-driven, mirrors workspacePodSpawner.js) ──────────────────────
const NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const WORKSPACE_DATA_PVC = (process.env.WORKSPACE_DATA_PVC || 'collab-data-pvc').trim();
// Subdir under the PVC root that holds the per-workspace git repos. The worker
// mounts the whole PVC at /data and uses /data/repos/<slug>/<user>; the runtime
// pod mounts the SAME PVC but confined to that dir via subPath.
const RUNTIME_REPOS_SUBDIR = 'repos';
const RUNTIME_WORKSPACE_MOUNT = '/workspace';
const RUNTIME_DATA_VOLUME_NAME = 'workspace-data';

// Runtime-pod scheduling — SEPARATE from the worker's workspace-pool knobs so the
// two untrusted workloads stay on their own node pools. Defaults target sysbox-pool.
const RUNTIME_NODE_SELECTOR_KEY = (process.env.RUNTIME_NODE_SELECTOR_KEY || 'cloud.google.com/gke-nodepool').trim();
const RUNTIME_NODE_SELECTOR_VALUE = (process.env.RUNTIME_NODE_SELECTOR_VALUE || 'sysbox-pool').trim();
const RUNTIME_NODE_TAINT_KEY = (process.env.RUNTIME_NODE_TAINT_KEY || 'workload').trim();
const RUNTIME_NODE_TAINT_VALUE = (process.env.RUNTIME_NODE_TAINT_VALUE || 'sysbox').trim();
const RUNTIME_NODE_TAINT_EFFECT = (process.env.RUNTIME_NODE_TAINT_EFFECT || 'NoSchedule').trim();

// The per-workspace runtime image (rootless dockerd + toolchain under Sysbox).
// Prod sets this to the digest-pinned AR image via the synthi-config ConfigMap.
const RUNTIME_POD_IMAGE = (process.env.RUNTIME_POD_IMAGE || 'vectant-runtime:local').trim();
// DOCKER_HOST points at the pod's OWN in-pod daemon socket — never a host socket.
const RUNTIME_DOCKER_HOST = (process.env.RUNTIME_DOCKER_HOST || 'unix:///var/run/docker.sock').trim();

// managed-by label value. The worker uses 'workspace-spawner'; the runtime uses
// this DISTINCT value so the worker culler/count never match (and delete) runtime
// pods. The spawner imports this to build its count/cull label selectors, so this
// is the single source of truth — keep them from drifting.
const RUNTIME_MANAGED_BY = 'runtime-spawner';

// Preview-proxy sidecar port for the runtime pod's Service (Slice 4). Mirrors the
// worker's SYNTHI_PREVIEW_SIDECAR_PORT so a single env drives both pods.
const PREVIEW_SIDECAR_PORT = (() => {
  const p = Number(process.env.SYNTHI_PREVIEW_SIDECAR_PORT);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 18080;
})();

// Hibernate (Slice 5): optionally persist the rootful daemon's data dir so the
// image/build cache survives idle-cull → respawn (resume restores a WARM docker,
// not a cold re-pull). Off by default (ephemeral /var/lib/docker = current
// behavior); read at call time so it can be toggled without a restart / in tests.
const RUNTIME_DOCKER_DATA_MOUNT = '/var/lib/docker';
const RUNTIME_DOCKER_DATA_SUBDIR = 'docker-data';
function isRuntimeDockerDataPersisted() {
  return ['1', 'true', 'yes'].includes(String(process.env.RUNTIME_PERSIST_DOCKER_DATA || '').trim().toLowerCase());
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function safePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_@.\-]/g, '_');
}

/**
 * Path of the workspace's repo dir RELATIVE to the PVC root — used as the
 * subPath so the runtime pod (and the user's docker) sees only its own files.
 * Matches workspacePodSpawner.workspaceDirForMetadata (minus the /data mount).
 */
function workspaceSubPath(metadata = {}) {
  const slug = String(metadata.workspaceSlug || '').trim();
  if (!slug) return RUNTIME_REPOS_SUBDIR;
  const fsUser = safePathSegment(metadata.filesystemUserId || '');
  return fsUser
    ? `${RUNTIME_REPOS_SUBDIR}/${slug}/${fsUser}`
    : `${RUNTIME_REPOS_SUBDIR}/${slug}`;
}

/** Pod identity labels for the RUNTIME pod (app: runtime, distinct from worker). */
function runtimeLabels(sessionId, userId) {
  return {
    app: 'runtime',
    'synthi/runtime-id': runtimeResourceId(sessionId),
    ...(userId ? { 'synthi/user-hash': metadataHash(userId) } : {}),
    'app.kubernetes.io/part-of': 'synthi-ide',
    'app.kubernetes.io/managed-by': RUNTIME_MANAGED_BY,
  };
}

/**
 * Deployment name for the RUNTIME pod. MUST differ from the worker Deployment
 * name (which is `runtimeResourceId(sessionId)`) so a session's worker and
 * runtime pods can coexist in the same namespace without a 409 name collision.
 * Derived from the session resource id (so it's traceable) with an `-rt` suffix.
 */
function runtimeDeploymentName(sessionId) {
  return `${runtimeResourceId(sessionId)}-rt`;
}

/** nodeSelector + tolerations confining the runtime pod to the sysbox node pool. */
function buildRuntimeScheduling() {
  const nodeSelector = RUNTIME_NODE_SELECTOR_KEY && RUNTIME_NODE_SELECTOR_VALUE
    ? { [RUNTIME_NODE_SELECTOR_KEY]: RUNTIME_NODE_SELECTOR_VALUE }
    : undefined;
  const tolerations = RUNTIME_NODE_TAINT_KEY && RUNTIME_NODE_TAINT_VALUE
    ? [{
        key: RUNTIME_NODE_TAINT_KEY,
        operator: 'Equal',
        value: RUNTIME_NODE_TAINT_VALUE,
        effect: RUNTIME_NODE_TAINT_EFFECT,
      }]
    : [];
  return { nodeSelector, tolerations };
}

/**
 * Dark-launch gate. The Sysbox per-workspace runtime backend is OFF unless
 * RUNTIME_BACKEND is exactly 'sysbox-pod'. Read at call time so it can be flipped
 * without a process restart and toggled in tests.
 */
function isSysboxRuntimeEnabled() {
  return String(process.env.RUNTIME_BACKEND || '').trim() === 'sysbox-pod';
}

function buildRuntimeDeployment({ sessionId, userId, metadata = {} } = {}) {
  const name = runtimeDeploymentName(sessionId);
  const labels = runtimeLabels(sessionId, userId);
  const selectorLabels = {
    app: 'runtime',
    'synthi/runtime-id': runtimeResourceId(sessionId),
  };
  const scheduling = buildRuntimeScheduling();
  const filesystemUserId = metadata.filesystemUserId || metadata.filesystem_user_id || userId;

  // Workspace files at /workspace (subPath-confined). When docker-data persistence
  // is on (Slice 5 hibernate), also mount a per-runtime PVC subPath at /var/lib/docker
  // so the image/build cache survives idle-cull → respawn.
  const runtimeVolumeMounts = [
    { name: RUNTIME_DATA_VOLUME_NAME, mountPath: RUNTIME_WORKSPACE_MOUNT, subPath: workspaceSubPath(metadata) },
  ];
  if (isRuntimeDockerDataPersisted()) {
    runtimeVolumeMounts.push({
      name: RUNTIME_DATA_VOLUME_NAME,
      mountPath: RUNTIME_DOCKER_DATA_MOUNT,
      subPath: `${RUNTIME_DOCKER_DATA_SUBDIR}/${runtimeResourceId(sessionId)}`,
    });
  }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NAMESPACE, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels },
        spec: {
          ...(scheduling.nodeSelector ? { nodeSelector: scheduling.nodeSelector } : {}),
          ...(scheduling.tolerations.length ? { tolerations: scheduling.tolerations } : {}),
          hostUsers: false,
          runtimeClassName: 'sysbox-runc',
          containers: [
            {
              name: 'runtime',
              image: RUNTIME_POD_IMAGE,
              env: [
                { name: 'DOCKER_HOST', value: RUNTIME_DOCKER_HOST },
                { name: 'SESSION_ID', value: sessionId },
                { name: 'SYNTHI_RUNTIME_SCOPE', value: sessionId },
                { name: 'RUNTIME_RESOURCE_ID', value: runtimeResourceId(sessionId) },
                { name: 'SYNTHI_WORKSPACE_SLUG', value: String(metadata.workspaceSlug || '') },
                { name: 'SYNTHI_RUNTIME_FS_USER_ID', value: String(filesystemUserId || '') },
              ],
              // Readiness = "dockerd answers", not merely "pod Running". This makes
              // the all-containers-ready watch double as the dockerd-ready gate.
              // `docker info` talks to the in-pod daemon via DOCKER_HOST above.
              // High failureThreshold tolerates rootless dockerd's cold start.
              readinessProbe: {
                exec: { command: ['sh', '-c', 'docker info >/dev/null 2>&1'] },
                initialDelaySeconds: 3,
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 12,
              },
              volumeMounts: runtimeVolumeMounts,
            },
          ],
          volumes: [
            {
              name: RUNTIME_DATA_VOLUME_NAME,
              persistentVolumeClaim: { claimName: WORKSPACE_DATA_PVC },
            },
          ],
        },
      },
    },
  };
}

/**
 * Headless ClusterIP Service for the RUNTIME pod's preview-proxy sidecar (Slice 4).
 * Named distinctly from the worker Service (= runtimeResourceId) so they coexist,
 * selects app=runtime pods, and exposes the preview sidecar port. The preview proxy
 * targets this Service (via PREVIEW_TARGET_TEMPLATE) to reach ports the user opens
 * inside the runtime pod.
 */
function buildRuntimeService(sessionId) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: runtimeDeploymentName(sessionId),
      namespace: NAMESPACE,
      labels: runtimeLabels(sessionId, null),
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: 'None',
      selector: {
        app: 'runtime',
        'synthi/runtime-id': runtimeResourceId(sessionId),
      },
      ports: [
        { name: 'preview-proxy', port: PREVIEW_SIDECAR_PORT, targetPort: PREVIEW_SIDECAR_PORT },
      ],
    },
  };
}

module.exports = {
  buildRuntimeDeployment,
  buildRuntimeService,
  runtimeDeploymentName,
  workspaceSubPath,
  runtimeLabels,
  buildRuntimeScheduling,
  isSysboxRuntimeEnabled,
  isRuntimeDockerDataPersisted,
  RUNTIME_MANAGED_BY,
  PREVIEW_SIDECAR_PORT,
};
