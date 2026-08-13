'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createWorkspaceInstructionProjectionObservability,
  safeDetails,
} = require('../workspaceInstructionProjectionObservability');

test('projection observability aggregates outcomes without retaining instruction bodies', () => {
  let clock = 10;
  const calls = [];
  const metrics = createWorkspaceInstructionProjectionObservability({
    now: () => ++clock,
    logger: { info: (event, details) => calls.push({ event, details }) },
  });
  metrics.record('workspace_instruction_projection_reconciled', {
    workspaceId: 'workspace-a', path: 'AGENTS.md', content: 'never log me', block: 'never log me',
  });
  metrics.record('workspace_instruction_projection_failed', { reason: 'conflict', content: 'never log me' });
  metrics.record('workspace_instruction_projection_failed', { reason: 'conflict' });

  assert.deepEqual(metrics.snapshot(), {
    events: {
      workspace_instruction_projection_reconciled: 1,
      workspace_instruction_projection_failed: 2,
    },
    failures: { conflict: 2 },
    lastEventAt: 13,
  });
  assert.deepEqual(calls[0].details, { workspaceId: 'workspace-a', path: 'AGENTS.md' });
  assert.deepEqual(safeDetails({ content: 'hidden', instructionText: 'hidden', path: 'safe' }), { path: 'safe' });
});
