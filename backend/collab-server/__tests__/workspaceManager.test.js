'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const workspaceManager = require('../workspaceManager');

test.beforeEach(() => {
  workspaceManager.workspaces.clear();
});

test('hides imported workspaces from recent-only queries', () => {
  workspaceManager.addWorkspace('repo-1', 'https://github.com/acme/app.git', 'owner@example.com', 'Imported app', {
    source: 'import',
    showInRecent: false,
  });
  workspaceManager.addWorkspace('ai-1', 'https://github.com/acme/ai-app.git', 'owner@example.com', 'AI app', {
    source: 'ai',
    showInRecent: true,
  });

  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com', { recentOnly: true }).map((workspace) => workspace.slug),
    ['ai-1'],
  );
  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com').map((workspace) => workspace.slug),
    ['repo-1', 'ai-1'],
  );
});

test('promotes an existing workspace when later marked recent', () => {
  workspaceManager.addWorkspace('shared', null, 'owner@example.com', 'Imported once', {
    source: 'import',
    showInRecent: false,
  });
  workspaceManager.addWorkspace('shared', null, 'owner@example.com', 'AI generated', {
    source: 'ai',
    showInRecent: true,
  });

  const recent = workspaceManager.getWorkspaces('owner@example.com', { recentOnly: true });

  assert.equal(recent.length, 1);
  assert.equal(recent[0].slug, 'shared');
  assert.equal(recent[0].name, 'AI generated');
  assert.equal(recent[0].showInRecent, true);
});
