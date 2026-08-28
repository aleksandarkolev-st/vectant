'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SYNTHI_CODESITE_TOKEN = process.env.SYNTHI_CODESITE_TOKEN || 'test-token';

const {
  createRuntimeObservationPublisher,
} = require('../runtimeObservationPublisher');

test('maps managed runtime transitions onto normalized observation payloads', () => {
  const publisher = createRuntimeObservationPublisher({ fetchImpl: null });
  const payload = publisher.buildObservationPayload({
    producerKind: 'program_runtime_adapter',
    producerEventId: 'state_changed:2026-08-22T12:00:00.000Z',
    occurredAt: '2026-08-22T12:00:00.000Z',
    runtimeSessionId: 'rt-1',
    projectId: 'project-1',
    state: 'crashed',
    exitCode: 17,
    stopReason: 'process_exit',
  });
  assert.equal(payload.eventType, 'runtime_observed');
  assert.equal(payload.producer.kind, 'program_runtime_adapter');
  assert.deepEqual(payload.refs.runtimeSessionIds, ['rt-1']);
  assert.equal(payload.fact.observationKind, 'crashed');
  assert.equal(payload.fact.exitCode, 17);
  assert.ok(payload.fact.reasonCodes.includes('stop_reason_process_exit'));
});

test('ignores transitions without coordination value', () => {
  const publisher = createRuntimeObservationPublisher({ fetchImpl: null });
  assert.equal(publisher.buildObservationPayload({
    producerKind: 'program_runtime_adapter',
    producerEventId: 'x',
    runtimeSessionId: 'rt-1',
    projectId: 'p1',
    state: 'starting',
  }), null);
});

test('handleRuntimeEvent skips sessions without a project binding', async () => {
  const publisher = createRuntimeObservationPublisher({ fetchImpl: async () => ({ ok: true }) });
  const published = await publisher.handleRuntimeEvent({
    type: 'state_changed',
    createdAt: new Date().toISOString(),
    data: { state: 'crashed', exitCode: 2 },
    session: { sessionId: 'rt-no-project', workspaceSlug: 'acme' },
  });
  assert.equal(published, false);
});

test('publishes crash observations to the control plane with the internal token', async () => {
  const calls = [];
  const publisher = createRuntimeObservationPublisher({
    resolveBaseUrl: (_explicit, slug) => `http://codesite.test/api/workspace/${slug}/codesite`,
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return { ok: true, status: 201 };
    },
  });
  const published = await publisher.handleRuntimeEvent({
    type: 'state_changed',
    createdAt: '2026-08-22T12:00:05.000Z',
    data: { state: 'crashed', exitCode: 3 },
    session: { sessionId: 'rt-live', workspaceSlug: 'acme-proof', projectId: 'proj-9' },
  });
  assert.equal(published, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/workspace\/acme-proof\/codesite\/projects\/proj-9\/observations$/);
  assert.match(String(calls[0].headers.authorization), /^Bearer /);
  assert.equal(calls[0].body.fact.observationKind, 'crashed');
  const health = await publisher.reportHealth();
  assert.equal(health.published, 1);
  assert.equal(health.failed, 0);
});

test('records failures without throwing so telemetry never breaks runtimes', async () => {
  const publisher = createRuntimeObservationPublisher({
    resolveBaseUrl: () => 'http://codesite.test',
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  const published = await publisher.handleRuntimeEvent({
    type: 'state_changed',
    createdAt: new Date().toISOString(),
    data: { state: 'stopped' },
    session: { sessionId: 'rt-2', workspaceSlug: 'acme', projectId: 'p' },
  });
  assert.equal(published, false);
  const health = await publisher.reportHealth();
  assert.equal(health.failed, 1);
  await assert.doesNotReject(() => publisher.handleRuntimeEvent({
    type: 'state_changed',
    createdAt: new Date().toISOString(),
    data: { state: 'running' },
    session: { sessionId: 'rt-3', workspaceSlug: 'acme', projectId: 'p' },
  }));
});
