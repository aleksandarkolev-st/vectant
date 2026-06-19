'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldUseContainerTerminal } = require('../terminalService');
const { runtimeTerminalTarget, programRuntimeTarget, buildRuntimeShellScript, pickRuntimeScopeForSlug } = require('../runtimePodTerminal');

test('shouldUseContainerTerminal requires the flag, a runtime manager, and a slug', () => {
  const rt = {};
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: rt, workspaceSlug: 'repo' }), true);
  // missing flag
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: false, workspaceRuntime: rt, workspaceSlug: 'repo' }), false);
  // missing runtime manager (flag on but container runtime not constructed)
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: null, workspaceSlug: 'repo' }), false);
  // missing slug (can't resolve a per-workspace container)
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: rt, workspaceSlug: '' }), false);
});

// S3-T1 — Slice 3: when the Sysbox runtime backend is on, the terminal must exec
// into the RUNTIME pod's `runtime` container (the workspace's own dockerd lives
// there, so `docker`/`kind` work); when off, preserve the worker-pod path.
test('runtimeTerminalTarget picks the runtime container under the sysbox flag, else the worker', () => {
  assert.deepEqual(runtimeTerminalTarget(true), { useSysboxRuntime: true, container: 'runtime' });
  assert.deepEqual(runtimeTerminalTarget(false), { useSysboxRuntime: false, container: 'worker' });
});

// S3-T2 — DEFERRED (written + skipped): a real terminal execs into the runtime pod
// and `docker build/run/compose` work against the workspace's own daemon.
test('terminal execs into the runtime pod and docker works', { skip: 'integration — blocked on nestybox/sysbox#1006 substrate' }, () => {});

// Slice-1 (real programs) — pure launch-target decision for a managed program.
// container + sysbox → the runtime pod (precedence); container + hybrid only →
// the dev-hybrid container; container + neither → unavailable (fail loud);
// non-container → the headless PTY.
test('programRuntimeTarget: non-container is always headless', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'web', sysboxEnabled: true, hasHybrid: true }).target, 'headless');
});
test('programRuntimeTarget: container + sysbox → sysbox-pod (precedence over hybrid)', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: true, hasHybrid: true }).target, 'sysbox-pod');
});
test('programRuntimeTarget: container + hybrid only → hybrid', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: true }).target, 'hybrid');
});
test('programRuntimeTarget: container + neither → unavailable', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: false }).target, 'unavailable');
});

// Slice-1 — the shared runtime shell-script builder runs the program command in
// /workspace with env exports, and never injects DOCKER_HOST (it is inherited from
// the runtime container's own pod-level env).
test('buildRuntimeShellScript: runs the program command in /workspace with env exports, no DOCKER_HOST injected', () => {
  const s = buildRuntimeShellScript({ env: { FOO: 'bar' }, cwd: '/workspace', finalCommand: 'docker compose up' });
  assert.match(s, /export FOO='bar'/);
  assert.match(s, /export WORKSPACE_DIR='\/workspace'/);
  assert.match(s, /cd "\$WORKSPACE_DIR"/);
  assert.match(s, /docker compose up$/);
  assert.equal(/DOCKER_HOST/.test(s), false);
});

// Slice-1 — resolve a workspace's runtime scope from its slug among the active
// runtime sessions (the launch payload carries slug, not the collab session id).
test('pickRuntimeScopeForSlug matches slug → runtimeScope, else null', () => {
  const sessions = [{ slug: 'a', runtimeScope: 's-a' }, { slug: 'b', runtimeScope: 's-b' }];
  assert.equal(pickRuntimeScopeForSlug(sessions, 'b'), 's-b');
  assert.equal(pickRuntimeScopeForSlug(sessions, 'z'), null);
  assert.equal(pickRuntimeScopeForSlug(null, 'b'), null);
});
