'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildRuntimeDeployment, buildRuntimeService, isSysboxRuntimeEnabled } = require('../runtimePodSpec');
const { runtimeResourceId } = require('../runtimeIdentity');

// T1 — the core security invariant: the per-workspace runtime pod runs under the
// Sysbox RuntimeClass and is NEVER privileged (Sysbox provides the isolation).
test('runtime deployment uses the sysbox-runc RuntimeClass and is never privileged', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  assert.equal(dep.kind, 'Deployment');
  const podSpec = dep.spec.template.spec;
  assert.equal(podSpec.runtimeClassName, 'sysbox-runc');
  assert.ok(Array.isArray(podSpec.containers) && podSpec.containers.length > 0, 'has at least one container');
  for (const c of podSpec.containers) {
    const priv = c.securityContext && c.securityContext.privileged;
    assert.notEqual(priv, true, `container ${c.name} must not be privileged`);
  }
});

// T2 — tenant confinement: the runtime sees only its own workspace dir via subPath.
test('mounts collab-data-pvc at /workspace confined to the workspace subPath', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const podSpec = dep.spec.template.spec;
  const vol = (podSpec.volumes || []).find(
    (v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === 'collab-data-pvc',
  );
  assert.ok(vol, 'collab-data-pvc volume present');
  const runtime = podSpec.containers.find((c) => c.name === 'runtime');
  const mount = (runtime.volumeMounts || []).find((m) => m.name === vol.name);
  assert.ok(mount, 'runtime container mounts the workspace volume');
  assert.equal(mount.mountPath, '/workspace');
  assert.equal(mount.subPath, 'repos/my-repo/242593757');
});

// T3 — pod identity: app:runtime label, deterministic synthi/runtime-id, and
// hostUsers:false (k8s userns ≥1.30). Selector must match the pod template labels.
test('runtime pod has hostUsers:false and app:runtime identity labels', () => {
  const sessionId = 'ws-abc:user-1';
  const dep = buildRuntimeDeployment({
    sessionId,
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const tmpl = dep.spec.template;
  assert.equal(tmpl.spec.hostUsers, false);
  assert.equal(tmpl.metadata.labels.app, 'runtime');
  assert.equal(tmpl.metadata.labels['synthi/runtime-id'], runtimeResourceId(sessionId));
  // the Deployment selector must match the pod labels (else the Deployment is invalid)
  assert.equal(dep.spec.selector.matchLabels.app, 'runtime');
  assert.equal(dep.spec.selector.matchLabels['synthi/runtime-id'], runtimeResourceId(sessionId));
});

// T4 — scheduling: lands on the dedicated sysbox node pool and tolerates its taint
// (env-driven defaults, SEPARATE from the worker's workspace-pool scheduling).
test('runtime pod schedules onto the sysbox pool with the sysbox taint toleration', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const podSpec = dep.spec.template.spec;
  assert.equal(podSpec.nodeSelector['cloud.google.com/gke-nodepool'], 'sysbox-pool');
  const tol = (podSpec.tolerations || []).find((t) => t.key === 'workload' && t.value === 'sysbox');
  assert.ok(tol, 'tolerates workload=sysbox');
  assert.equal(tol.effect, 'NoSchedule');
});

// T5 — the runtime container runs the runtime image, and DOCKER_HOST points at the
// pod's OWN in-pod unix socket (never a host socket / tcp). Workspace identity is
// threaded through (slug, runtime scope, fs user).
test('runtime container runs the runtime image and points DOCKER_HOST at its own in-pod socket', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const runtime = dep.spec.template.spec.containers.find((c) => c.name === 'runtime');
  assert.ok(runtime.image, 'runtime container has an image');
  const env = Object.fromEntries((runtime.env || []).map((e) => [e.name, e.value]));
  assert.match(env.DOCKER_HOST || '', /^unix:\/\//, 'DOCKER_HOST is an in-pod unix socket');
  assert.equal(env.SYNTHI_WORKSPACE_SLUG, 'my-repo');
  assert.equal(env.SYNTHI_RUNTIME_SCOPE, 'ws-abc:user-1');
  assert.equal(env.SYNTHI_RUNTIME_FS_USER_ID, '242593757');
});

// T6 — dark-launch flag: the Sysbox runtime backend is OFF unless RUNTIME_BACKEND
// is exactly 'sysbox-pod'. Read at call time so it can be toggled at runtime/tests.
test('isSysboxRuntimeEnabled is gated on RUNTIME_BACKEND=sysbox-pod (default off)', () => {
  const prev = process.env.RUNTIME_BACKEND;
  try {
    delete process.env.RUNTIME_BACKEND;
    assert.equal(isSysboxRuntimeEnabled(), false);
    process.env.RUNTIME_BACKEND = 'sysbox-pod';
    assert.equal(isSysboxRuntimeEnabled(), true);
    process.env.RUNTIME_BACKEND = 'host-socket';
    assert.equal(isSysboxRuntimeEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_BACKEND;
    else process.env.RUNTIME_BACKEND = prev;
  }
});

// S2-T8 — the runtime Deployment and the worker Deployment for the SAME session
// must NOT share a name (both would otherwise be `runtimeResourceId(sessionId)` and
// 409-collide). The runtime name is derived from the session id (for traceability)
// but distinct; the `synthi/runtime-id` label still ties it to the session.
test('runtime Deployment name is distinct from the worker resource id', () => {
  const sessionId = 'ws-abc:user-1';
  const dep = buildRuntimeDeployment({
    sessionId,
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const workerName = runtimeResourceId(sessionId);
  assert.notEqual(dep.metadata.name, workerName, 'runtime name must differ from the worker Deployment name');
  assert.ok(dep.metadata.name.startsWith(workerName), 'runtime name is derived from the session resource id');
  assert.equal(dep.spec.template.metadata.labels['synthi/runtime-id'], workerName, 'identity label still ties it to the session');
});

// S2-T9 — the runtime pod must be managed-by `runtime-spawner`, NOT `workspace-spawner`.
// The worker culler/count filter on `managed-by=workspace-spawner`; sharing it would
// make the worker culler delete runtime pods (they carry no lastActive annotation).
test('runtime pods are managed-by runtime-spawner (not workspace-spawner)', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  assert.equal(dep.metadata.labels['app.kubernetes.io/managed-by'], 'runtime-spawner');
  assert.equal(dep.spec.template.metadata.labels['app.kubernetes.io/managed-by'], 'runtime-spawner');
});

// S2-T10 — readiness must mean "dockerd is up", not merely "pod Running". A readiness
// probe that execs a docker-daemon check lets the existing all-containers-ready watch
// double as the dockerd-ready gate. Still never privileged (Sysbox provides isolation).
test('runtime container has a dockerd-readiness probe and stays non-privileged', () => {
  const dep = buildRuntimeDeployment({
    sessionId: 'ws-abc:user-1',
    userId: 'user-1',
    metadata: { workspaceSlug: 'my-repo', filesystemUserId: '242593757' },
  });
  const runtime = dep.spec.template.spec.containers.find((c) => c.name === 'runtime');
  assert.ok(runtime.readinessProbe, 'runtime container has a readinessProbe');
  const cmd = (runtime.readinessProbe.exec && runtime.readinessProbe.exec.command) || [];
  assert.ok(cmd.join(' ').includes('docker'), 'readiness probe checks the docker daemon');
  assert.notEqual(runtime.securityContext && runtime.securityContext.privileged, true);
});

// S4-T1 — Slice 4: the runtime pod's preview Service. Headless, selects app=runtime
// pods, exposes the preview-sidecar port, and is NAMED distinctly from the worker
// Service (worker Service = runtimeResourceId; runtime must not collide).
test('buildRuntimeService is a headless Service for the runtime pod on the preview port', () => {
  const sessionId = 'ws-abc:user-1';
  const svc = buildRuntimeService(sessionId);
  assert.equal(svc.kind, 'Service');
  assert.notEqual(svc.metadata.name, runtimeResourceId(sessionId), 'distinct from the worker Service name');
  assert.ok(svc.metadata.name.startsWith(runtimeResourceId(sessionId)), 'derived from the session resource id');
  assert.equal(svc.spec.clusterIP, 'None', 'headless');
  assert.equal(svc.spec.selector.app, 'runtime');
  assert.equal(svc.spec.selector['synthi/runtime-id'], runtimeResourceId(sessionId));
  const port = (svc.spec.ports || []).find((p) => p.name === 'preview-proxy');
  assert.ok(port, 'exposes the preview-proxy port');
  assert.ok(Number.isInteger(port.port) && port.port > 0, 'preview-proxy port is a valid port');
});

// S4-T2 — DEFERRED (written + skipped): ports opened inside the runtime pod are
// detected (k8s-exec port monitor) and reachable via the preview sidecar+Service +
// PREVIEW_TARGET_TEMPLATE. Needs a live Sysbox cluster.
test('runtime pod opened ports surface in the Ports panel and proxy', { skip: 'integration — blocked on nestybox/sysbox#1006 substrate' }, () => {});
