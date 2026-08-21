'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PASSIVE_WORKSPACE_INSTRUCTIONS,
} = require('../workspaceAgentProtocol');

test('the passive default contains workspace context rather than an agent-specific protocol', () => {
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /Vectant environment configuration/);
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /Vectant-managed workspace resources/);
  assert.doesNotMatch(PASSIVE_WORKSPACE_INSTRUCTIONS, /synthi_route_atomic_task|sub-agent|MCP/i);
  assert.equal(Object.prototype.hasOwnProperty.call(require('../workspaceAgentProtocol'), 'provisionWorkspaceAgentProtocol'), false);
});
