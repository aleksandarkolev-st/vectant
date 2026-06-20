'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseExecExitCode, pickRuntimeScopeForSlug } = require('../runtimePodTerminal');

test('parseExecExitCode maps a Success status to 0', () => {
  assert.equal(parseExecExitCode({ status: 'Success' }), 0);
});

test('parseExecExitCode reads a NonZeroExitCode from details.causes', () => {
  const status = {
    status: 'Failure',
    reason: 'NonZeroExitCode',
    details: { causes: [{ reason: 'ExitCode', message: '2' }] },
  };
  assert.equal(parseExecExitCode(status), 2);
});

test('parseExecExitCode treats a Failure without an ExitCode cause as 1', () => {
  assert.equal(parseExecExitCode({ status: 'Failure', reason: 'InternalError', details: { causes: [] } }), 1);
});

test('parseExecExitCode returns null for an unknown/absent status', () => {
  assert.equal(parseExecExitCode(null), null);
  assert.equal(parseExecExitCode({}), null);
});

test('pickRuntimeScopeForSlug finds the runtimeScope for a slug among active sessions', () => {
  const sessions = [
    { slug: 'other', runtimeScope: 'scope-other' },
    { slug: 'team', runtimeScope: 'scope-team' },
  ];
  assert.equal(pickRuntimeScopeForSlug(sessions, 'team'), 'scope-team');
  assert.equal(pickRuntimeScopeForSlug(sessions, 'missing'), null);
  assert.equal(pickRuntimeScopeForSlug(null, 'team'), null);
});
