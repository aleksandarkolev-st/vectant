'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldUseContainerTerminal } = require('../terminalService');

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
