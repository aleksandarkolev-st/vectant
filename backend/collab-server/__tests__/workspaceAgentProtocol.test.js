'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ATOMIC_AGENT_PROTOCOL,
} = require('../workspaceAgentProtocol');

test('the atomic protocol remains a canonical payload and no longer provisions a hidden agent file', () => {
  assert.match(ATOMIC_AGENT_PROTOCOL, /synthi_route_atomic_task/);
  assert.match(ATOMIC_AGENT_PROTOCOL, /Do not expose the full tool catalog/);
  assert.equal(Object.prototype.hasOwnProperty.call(require('../workspaceAgentProtocol'), 'provisionWorkspaceAgentProtocol'), false);
});
