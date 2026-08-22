'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  shouldUseContainerTerminal,
  codeSiteTerminalLaunchMode,
  codeSiteTerminalReattachDecision,
  agentSessionReattachDecision,
} = require('../terminalRouting');
const {
  runtimeTerminalTarget,
  programRuntimeTarget,
  codeSiteProgramRuntimeTarget,
  codeSiteProgramRuntimeLaunchMode,
  buildRuntimeShellScript,
  pickRuntimeScopeForSlug,
} = require('../runtimePodTerminal');

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

test('CodeSite terminal launch mode blocks host shells and permits container overlay runtime', () => {
  assert.equal(codeSiteTerminalLaunchMode({
    codeSiteContext: null,
    workspaceSlug: 'repo',
  }), 'normal');

  assert.equal(codeSiteTerminalLaunchMode({
    codeSiteContext: { active: true },
    workspaceSlug: 'repo',
  }), 'block-host');

  assert.equal(codeSiteTerminalLaunchMode({
    codeSiteContext: { active: true },
    usesRuntimePodTerminal: true,
    workspaceSlug: 'repo',
  }), 'block-runtime');

  assert.equal(codeSiteTerminalLaunchMode({
    codeSiteContext: { active: true },
    usesRuntimePodTerminal: true,
    enableContainerRuntime: true,
    workspaceRuntime: {},
    workspaceSlug: 'repo',
  }), 'overlay-runtime');

  assert.equal(codeSiteTerminalLaunchMode({
    codeSiteContext: { active: true },
    enableContainerRuntime: true,
    workspaceRuntime: {},
    workspaceSlug: 'repo',
  }), 'overlay-runtime');
});

test('CodeSite terminal reattach blocks unmanaged or mismatched existing sessions', () => {
  const request = {
    active: true,
    workspaceSlug: 'repo',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
  };
  assert.deepEqual(codeSiteTerminalReattachDecision({
    codeSiteContext: null,
    existingSession: { codesiteContext: null },
  }), { ok: true });
  assert.equal(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: { codesiteContext: null },
  }).reason, 'existing_session_unmanaged');
  assert.equal(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: {
      codesiteContext: { active: true, workspaceSlug: 'repo', transactionId: 'txn-2', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' },
      runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
    },
  }).reason, 'transaction_mismatch');
  assert.equal(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: {
      codesiteContext: { active: true, workspaceSlug: 'repo', transactionId: 'txn-1', mutationLeaseId: 'lease-2', agentSessionId: 'agent-1' },
      runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
    },
  }).reason, 'lease_mismatch');
  assert.equal(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: {
      codesiteContext: { active: true, workspaceSlug: 'repo', transactionId: 'txn-1', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' },
    },
  }).reason, 'overlay_missing');
});

test('CodeSite terminal reattach permits only matching overlay-backed sessions', () => {
  const request = {
    active: true,
    workspaceSlug: 'repo',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
  };
  assert.deepEqual(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: {
      codesiteContext: { active: true, workspaceSlug: 'repo', transactionId: 'txn-1', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' },
      runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
    },
  }), { ok: true });
  assert.deepEqual(codeSiteTerminalReattachDecision({
    codeSiteContext: request,
    existingSession: {
      codesiteContext: { active: true, workspaceSlug: 'repo', transactionId: 'txn-1', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' },
      codesiteQuarantine: { mountMode: 'docker-overlay', overlayId: 'overlay-1' },
    },
  }), { ok: true });
});

function completeAgentBinding(overrides = {}) {
  return {
    workspaceSlug: 'repo',
    collaborationSessionId: 'collab-1',
    ownerUserId: 'owner-1',
    collaborationUserId: 'member-1',
    effectiveWorkspaceUserId: 'workspace-user-1',
    projectId: 'project-1',
    agentSessionId: 'agent-1',
    displayCallsign: 'CODEX-01',
    agentProvider: 'codex',
    providerSessionRef: 'provider-session-1',
    runtimeScope: 'runtime-1',
    terminalSessionId: 'terminal-1',
    runtimeSessionId: null,
    activeMutationLeaseId: null,
    activeTransactionId: null,
    ...overrides,
  };
}

test('agent reattach permits unmanaged sessions and exact server-derived bindings', () => {
  assert.deepEqual(agentSessionReattachDecision(), { ok: true });
  const binding = completeAgentBinding();
  assert.deepEqual(agentSessionReattachDecision({
    requestedBinding: { ...binding },
    existingSession: { codeSiteAgentBinding: { ...binding } },
  }), { ok: true });
});

test('agent reattach fails closed when only one side is attached or an identity is incomplete', () => {
  const binding = completeAgentBinding();
  assert.equal(agentSessionReattachDecision({
    requestedBinding: binding,
    existingSession: {},
  }).reason, 'attachment_state_mismatch');
  assert.equal(agentSessionReattachDecision({
    requestedBinding: null,
    existingSession: { codeSiteAgentBinding: binding },
  }).reason, 'attachment_state_mismatch');
  assert.equal(agentSessionReattachDecision({
    requestedBinding: completeAgentBinding({ ownerUserId: '' }),
    existingSession: { codeSiteAgentBinding: binding },
  }).reason, 'identity_incomplete');
  assert.equal(agentSessionReattachDecision({
    requestedBinding: completeAgentBinding({ terminalSessionId: null }),
    existingSession: { codeSiteAgentBinding: binding },
  }).reason, 'runtime_identity_incomplete');
  const missingTransactionIdentity = completeAgentBinding();
  delete missingTransactionIdentity.activeTransactionId;
  assert.equal(agentSessionReattachDecision({
    requestedBinding: missingTransactionIdentity,
    existingSession: { codeSiteAgentBinding: binding },
  }).reason, 'transaction_identity_incomplete');
});

test('agent reattach rejects every mismatched ownership, provider, runtime, and transaction identity', () => {
  const binding = completeAgentBinding();
  const mismatches = {
    workspaceSlug: 'other-repo',
    collaborationSessionId: 'collab-2',
    ownerUserId: 'owner-2',
    collaborationUserId: 'member-2',
    effectiveWorkspaceUserId: 'workspace-user-2',
    projectId: 'project-2',
    agentSessionId: 'agent-2',
    displayCallsign: 'CLAUDE-02',
    agentProvider: 'claude',
    providerSessionRef: 'provider-session-2',
    runtimeScope: 'runtime-2',
    terminalSessionId: 'terminal-2',
    runtimeSessionId: 'runtime-session-2',
    activeMutationLeaseId: 'lease-2',
    activeTransactionId: 'transaction-2',
  };
  for (const [field, value] of Object.entries(mismatches)) {
    const decision = agentSessionReattachDecision({
      requestedBinding: completeAgentBinding({ [field]: value }),
      existingSession: { codeSiteAgentBinding: binding },
    });
    assert.equal(decision.ok, false, field);
    assert.equal(decision.reason, `${field}_mismatch`, field);
    assert.equal(JSON.stringify(decision).includes(value), false, `${field} value leaked`);
  }
});

// S3-T1 — Slice 3: when the Sysbox runtime backend is on, the terminal must exec
// into the RUNTIME pod's `runtime` container (the workspace's own dockerd lives
// there, so `docker`/`kind` work); when off, preserve the worker-pod path.
test('runtimeTerminalTarget picks the runtime container under the sysbox flag, else the worker', () => {
  assert.deepEqual(runtimeTerminalTarget(true), { useSysboxRuntime: true, container: 'runtime' });
  assert.deepEqual(runtimeTerminalTarget(false), { useSysboxRuntime: false, container: 'worker' });
});

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
test('codeSiteProgramRuntimeTarget: active container + hybrid → hybrid even when sysbox is enabled', () => {
  assert.equal(codeSiteProgramRuntimeTarget({
    codeSiteContext: { active: true },
    runtimeType: 'container',
    sysboxEnabled: true,
    hasHybrid: true,
  }).target, 'hybrid');
  assert.equal(codeSiteProgramRuntimeTarget({
    codeSiteContext: null,
    runtimeType: 'container',
    sysboxEnabled: true,
    hasHybrid: true,
  }).target, 'sysbox-pod');
});
test('programRuntimeTarget: container + hybrid only → hybrid', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: true }).target, 'hybrid');
});
test('programRuntimeTarget: container + neither → unavailable', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: false }).target, 'unavailable');
});

test('CodeSite program runtime mode blocks headless host launches and permits hybrid overlay runtime', () => {
  assert.equal(codeSiteProgramRuntimeLaunchMode({
    codeSiteContext: null,
    runtimeType: 'container',
    sysboxEnabled: true,
    hasHybrid: true,
  }), 'normal');
  assert.equal(codeSiteProgramRuntimeLaunchMode({
    codeSiteContext: { active: true },
    runtimeType: 'web',
    sysboxEnabled: true,
    hasHybrid: true,
  }), 'block-host');
  assert.equal(codeSiteProgramRuntimeLaunchMode({
    codeSiteContext: { active: true },
    runtimeType: 'container',
    sysboxEnabled: false,
    hasHybrid: true,
  }), 'overlay-runtime');
  assert.equal(codeSiteProgramRuntimeLaunchMode({
    codeSiteContext: { active: true },
    runtimeType: 'container',
    sysboxEnabled: true,
    hasHybrid: true,
  }), 'overlay-runtime');
  assert.equal(codeSiteProgramRuntimeLaunchMode({
    codeSiteContext: { active: true },
    runtimeType: 'container',
    sysboxEnabled: true,
    hasHybrid: false,
  }), 'block-runtime');
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
