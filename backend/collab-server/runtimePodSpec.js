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
    'app.kubernetes.io/managed-by': 'workspace-spawner',
  };
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
  const name = runtimeResourceId(sessionId);
  const labels = runtimeLabels(sessionId, userId);
  const selectorLabels = {
    app: 'runtime',
    'synthi/runtime-id': runtimeResourceId(sessionId),
  };
  const scheduling = buildRuntimeScheduling();
  const filesystemUserId = metadata.filesystemUserId || metadata.filesystem_user_id || userId;

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
              volumeMounts: [
                {
                  name: RUNTIME_DATA_VOLUME_NAME,
                  mountPath: RUNTIME_WORKSPACE_MOUNT,
                  subPath: workspaceSubPath(metadata),
                },
              ],
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

module.exports = {
  buildRuntimeDeployment,
  workspaceSubPath,
  runtimeLabels,
  buildRuntimeScheduling,
  isSysboxRuntimeEnabled,
};
