'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldUseContainerTerminal } = require('../terminalService');
const { runtimeTerminalTarget } = require('../runtimePodTerminal');

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
