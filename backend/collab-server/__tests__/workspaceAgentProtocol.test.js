'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MANAGED_SECTION_END,
  MANAGED_SECTION_START,
  WORKSPACE_AGENT_INSTRUCTIONS_PATH,
  provisionWorkspaceAgentProtocol,
  upsertWorkspaceAgentProtocol,
} = require('../workspaceAgentProtocol');

test('workspace protocol preserves surrounding content and upserts its managed section', () => {
  const initial = '# Local notes\n\nKeep these instructions.';
  const first = upsertWorkspaceAgentProtocol(initial);
  const second = upsertWorkspaceAgentProtocol(first.replace('smallest appropriate', 'incorrect'));

  assert.match(first, /Keep these instructions/);
  assert.match(first, /cheapest capable routing sub-agent/);
  assert.equal((second.match(new RegExp(MANAGED_SECTION_START, 'g')) || []).length, 1);
  assert.equal((second.match(new RegExp(MANAGED_SECTION_END, 'g')) || []).length, 1);
  assert.match(second, /smallest appropriate execution sub-agent/);
});

test('workspace protocol is provisioned under the hidden Synthi directory and is idempotent', async () => {
  const repoPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'synthi-agent-protocol-'));
  try {
    const first = await provisionWorkspaceAgentProtocol(repoPath);
    const instructionPath = path.join(repoPath, ...WORKSPACE_AGENT_INSTRUCTIONS_PATH.split('/'));
    const content = await fs.promises.readFile(instructionPath, 'utf8');
    const second = await provisionWorkspaceAgentProtocol(repoPath);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.match(content, /synthi_route_atomic_task/);
    assert.match(content, /Do not expose the full tool catalog/);
  } finally {
    await fs.promises.rm(repoPath, { recursive: true, force: true });
  }
});
