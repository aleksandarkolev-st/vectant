'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const workspaceManager = require('../workspaceManager');

test.beforeEach(() => {
  workspaceManager.workspaces.clear();
});

test('shows imported workspaces in recent-only queries by default', () => {
  workspaceManager.addWorkspace('repo-1', 'https://github.com/acme/app.git', 'owner@example.com', 'Imported app', {
    source: 'import',
  });
  workspaceManager.addWorkspace('created-1', 'https://github.com/acme/app-created.git', 'owner@example.com', 'Created app');

  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com', { recentOnly: true }).map((workspace) => workspace.slug),
    ['repo-1', 'created-1'],
  );
  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com').map((workspace) => workspace.slug),
    ['repo-1', 'created-1'],
  );
});

test('can explicitly hide short-lived workspaces from recent-only queries', () => {
  workspaceManager.addWorkspace('scratch-1', null, 'owner@example.com', 'Scratch app', {
    source: 'scratch',
    showInRecent: false,
  });

  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com', { recentOnly: true }).map((workspace) => workspace.slug),
    [],
  );
  assert.deepEqual(
    workspaceManager.getWorkspaces('owner@example.com').map((workspace) => workspace.slug),
    ['scratch-1'],
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
