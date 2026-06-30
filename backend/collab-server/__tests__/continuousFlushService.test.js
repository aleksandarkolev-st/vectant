'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  createContinuousFlushService,
  needsContinuousFlush,
  getFlushIntervalMs,
  getFlushDebounceMs,
  isContinuousFlushEnabled,
} = require('../continuousFlushService');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFlush() {
  const calls = [];
  const fn = (slug, userId, scope) => { calls.push([slug, userId, scope]); };
  return { calls, fn };
}

test('needsContinuousFlush is true only for container/webGui programs', () => {
  assert.equal(needsContinuousFlush({ runtimeType: 'container' }), true);
  assert.equal(needsContinuousFlush({ runtimeType: 'web', webGui: true }), true);
  assert.equal(needsContinuousFlush({ runtimeType: 'web' }), false);
  assert.equal(needsContinuousFlush({ runtimeType: 'cli' }), false);
  assert.equal(needsContinuousFlush(null), false);
});

test('registerSession ignores program types that do not read /workspace', () => {
  const { fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 20, debounceMs: 10 });
  try {
    assert.equal(svc.registerSession({ sessionId: 's1', slug: 'repo', userId: 'u1', config: { runtimeType: 'web' } }), false);
    assert.equal(svc.registerSession({ sessionId: 's2', slug: 'repo', userId: 'u1', config: { runtimeType: 'container' } }), true);
  } finally {
    svc.stop();
  }
});

test('notifySave flushes the active session\'s slug+userId (debounced)', async () => {
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 100000, debounceMs: 15 });
  try {
    svc.registerSession({ sessionId: 's1', slug: 'repo-a', userId: 'user-42', config: { runtimeType: 'container' } });
    svc.notifySave('repo-a');
    svc.notifySave('repo-a'); // rapid second save → debounce coalesces to one flush
    assert.equal(calls.length, 0, 'flush is debounced, not synchronous');
    await delay(50);
    assert.deepEqual(calls.map(([slug, userId]) => [slug, userId]), [['repo-a', 'user-42']]);
  } finally {
    svc.stop();
  }
});

test('notifySave for a slug with no active flush-needing session does nothing', async () => {
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 100000, debounceMs: 15 });
  try {
    svc.registerSession({ sessionId: 's1', slug: 'repo-a', userId: 'u1', config: { runtimeType: 'container' } });
    svc.notifySave('other-repo');
    await delay(50);
    assert.equal(calls.length, 0);
  } finally {
    svc.stop();
  }
});

test('the periodic flush runs while a session is active and stops after unregister', async () => {
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 20, debounceMs: 100000 });
  try {
    svc.registerSession({ sessionId: 's1', slug: 'repo', userId: 'u1', config: { runtimeType: 'container' } });
    await delay(75);
    assert.ok(calls.length >= 1, 'periodic flush should have fired at least once');
    assert.ok(calls.every(([s, u]) => s === 'repo' && u === 'u1'));

    svc.unregisterSession('s1');
    const after = calls.length;
    await delay(75);
    assert.equal(calls.length, after, 'no flush after the last session is unregistered');
  } finally {
    svc.stop();
  }
});

test('continuous flush carries CodeSite context to periodic and save-triggered flushes', async () => {
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 20, debounceMs: 15 });
  const codesiteContext = { active: true, transactionId: 'txn-1' };
  try {
    svc.registerSession({
      sessionId: 's1',
      slug: 'repo',
      userId: 'u1',
      config: { runtimeType: 'container' },
      codesiteContext,
    });
    await delay(30);
    svc.notifySave('repo');
    await delay(50);

    assert.ok(calls.length >= 2, 'periodic and save-triggered flushes should both run');
    assert.ok(calls.every(([, , scope]) => scope.codesiteContext?.transactionId === 'txn-1'));
  } finally {
    svc.stop();
  }
});

test('a session that is no longer active is pruned and stops being flushed', async () => {
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({
    flushFn: fn,
    isSessionActive: () => false, // manager reports the session already gone
    intervalMs: 20,
    debounceMs: 100000,
  });
  try {
    svc.registerSession({ sessionId: 's1', slug: 'repo', userId: 'u1', config: { runtimeType: 'container' } });
    await delay(75);
    assert.equal(calls.length, 0, 'a dead session must not be flushed');
  } finally {
    svc.stop();
  }
});

test('continuous flush is env-gated by SYNTHI_CONTINUOUS_FLUSH_ENABLED', async () => {
  const saved = process.env.SYNTHI_CONTINUOUS_FLUSH_ENABLED;
  const { calls, fn } = makeFlush();
  const svc = createContinuousFlushService({ flushFn: fn, intervalMs: 20, debounceMs: 15 });
  try {
    process.env.SYNTHI_CONTINUOUS_FLUSH_ENABLED = '0';
    assert.equal(isContinuousFlushEnabled(), false);
    assert.equal(svc.registerSession({ sessionId: 's1', slug: 'repo', userId: 'u1', config: { runtimeType: 'container' } }), false);
    svc.notifySave('repo');
    await delay(50);
    assert.equal(calls.length, 0);
  } finally {
    svc.stop();
    if (saved === undefined) delete process.env.SYNTHI_CONTINUOUS_FLUSH_ENABLED;
    else process.env.SYNTHI_CONTINUOUS_FLUSH_ENABLED = saved;
  }
});

test('flush interval + debounce are env-driven with sane defaults', () => {
  const savedI = process.env.SYNTHI_FLUSH_INTERVAL_MS;
  const savedD = process.env.SYNTHI_FLUSH_DEBOUNCE_MS;
  try {
    delete process.env.SYNTHI_FLUSH_INTERVAL_MS;
    delete process.env.SYNTHI_FLUSH_DEBOUNCE_MS;
    assert.equal(getFlushIntervalMs(), 1500);
    assert.equal(getFlushDebounceMs(), 400);
    process.env.SYNTHI_FLUSH_INTERVAL_MS = '3000';
    process.env.SYNTHI_FLUSH_DEBOUNCE_MS = '800';
    assert.equal(getFlushIntervalMs(), 3000);
    assert.equal(getFlushDebounceMs(), 800);
  } finally {
    if (savedI === undefined) delete process.env.SYNTHI_FLUSH_INTERVAL_MS; else process.env.SYNTHI_FLUSH_INTERVAL_MS = savedI;
    if (savedD === undefined) delete process.env.SYNTHI_FLUSH_DEBOUNCE_MS; else process.env.SYNTHI_FLUSH_DEBOUNCE_MS = savedD;
  }
});
