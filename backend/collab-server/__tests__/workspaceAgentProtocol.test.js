'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PASSIVE_WORKSPACE_INSTRUCTIONS,
} = require('../workspaceAgentProtocol');

test('the passive default projects the host-neutral atomic routing protocol', () => {
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /Vectant Atomic Agent Protocol/);
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /cheapest capable routing worker/);
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /selected skill instructions/);
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /synthi_route_atomic_task/);
  assert.match(PASSIVE_WORKSPACE_INSTRUCTIONS, /Vectant-managed workspace resources/);
  assert.equal(Object.prototype.hasOwnProperty.call(require('../workspaceAgentProtocol'), 'provisionWorkspaceAgentProtocol'), false);
});
