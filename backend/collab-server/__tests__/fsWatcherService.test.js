'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsw = require('../fsWatcherService');
const {
  diffSnapshots,
  computePollEvents,
  isFsPollingEnabled,
  getFsPollIntervalMs,
  buildDirSnapshot,
  runPollCycle,
  activeWatchers,
  registerChangeListener,
  acquireStagingLock,
  pauseWatcher,
  resumeWatcher,
} = fsw;

/** Build a snapshot Map from a plain object of relPath → {mtimeMs,size,isDir}. */
function snap(obj) {
  return new Map(Object.entries(obj));
}

test('diffSnapshots reports added, modified, and deleted entries with the right kind', () => {
  const prev = snap({
    'keep.txt': { mtimeMs: 1, size: 10, isDir: false },
    'edit.sql': { mtimeMs: 1, size: 20, isDir: false },
    'gone.txt': { mtimeMs: 1, size: 5, isDir: false },
  });
  const next = snap({
    'keep.txt': { mtimeMs: 1, size: 10, isDir: false }, // unchanged → no event
    'edit.sql': { mtimeMs: 2, size: 25, isDir: false }, // mtime+size changed → modified
    'new/dir': { mtimeMs: 9, size: 0, isDir: true },    // added dir
    'query.sql': { mtimeMs: 9, size: 99, isDir: false }, // added file
  });

  const events = diffSnapshots(prev, next);
  const byPath = Object.fromEntries(events.map((e) => [e.path, e.kind]));

  assert.equal(byPath['edit.sql'], 'file');
  assert.equal(byPath['query.sql'], 'file');
  assert.equal(byPath['new/dir'], 'dir');
  assert.equal(byPath['gone.txt'], 'deleted');
  assert.ok(!('keep.txt' in byPath), 'unchanged entry must not emit an event');
});

test('computePollEvents drops shouldIgnore paths', () => {
  const prev = snap({});
  const next = snap({
    'src/app.js': { mtimeMs: 2, size: 1, isDir: false },
    'node_modules/left-pad/index.js': { mtimeMs: 2, size: 1, isDir: false },
    'app.lock': { mtimeMs: 2, size: 1, isDir: false },
  });
  const events = computePollEvents('slug-ign', prev, next);
  const paths = events.map((e) => e.path);
  assert.deepEqual(paths, ['src/app.js']);
});

test('computePollEvents suppresses staging-locked paths', () => {
  const slug = 'slug-stage';
  acquireStagingLock(slug, 'locked.sql');
  const prev = snap({});
  const next = snap({
    'locked.sql': { mtimeMs: 2, size: 1, isDir: false },
    'free.sql': { mtimeMs: 2, size: 1, isDir: false },
  });
  const events = computePollEvents(slug, prev, next);
  assert.deepEqual(events.map((e) => e.path), ['free.sql']);
});

test('computePollEvents returns nothing while the watcher is paused (git op)', () => {
  const slug = 'slug-paused';
  pauseWatcher(slug);
  try {
    const prev = snap({});
    const next = snap({ 'a.txt': { mtimeMs: 2, size: 1, isDir: false } });
    assert.deepEqual(computePollEvents(slug, prev, next), []);
  } finally {
    resumeWatcher(slug, 0);
  }
});

test('computePollEvents collapses to a single bulk event past MAX_EVENTS_PER_BATCH', () => {
  const prev = snap({});
  const nextObj = {};
  for (let i = 0; i < 80; i++) nextObj[`f${i}.txt`] = { mtimeMs: 2, size: 1, isDir: false };
  const events = computePollEvents('slug-bulk', prev, snap(nextObj));
  assert.deepEqual(events, [{ path: '/', kind: 'bulk' }]);
});

test('fs polling is env-gated and off by default', () => {
  const saved = process.env.SYNTHI_FS_POLL_ENABLED;
  try {
    delete process.env.SYNTHI_FS_POLL_ENABLED;
    assert.equal(isFsPollingEnabled(), false);
    process.env.SYNTHI_FS_POLL_ENABLED = '1';
    assert.equal(isFsPollingEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.SYNTHI_FS_POLL_ENABLED;
    else process.env.SYNTHI_FS_POLL_ENABLED = saved;
  }
});

test('getFsPollIntervalMs defaults to 2000 and honors the env override', () => {
  const saved = process.env.SYNTHI_FS_POLL_INTERVAL_MS;
  try {
    delete process.env.SYNTHI_FS_POLL_INTERVAL_MS;
    assert.equal(getFsPollIntervalMs(), 2000);
    process.env.SYNTHI_FS_POLL_INTERVAL_MS = '500';
    assert.equal(getFsPollIntervalMs(), 500);
  } finally {
    if (saved === undefined) delete process.env.SYNTHI_FS_POLL_INTERVAL_MS;
    else process.env.SYNTHI_FS_POLL_INTERVAL_MS = saved;
  }
});

test('buildDirSnapshot walks the tree but skips ignored dir contents and .git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-snap-'));
  try {
    fs.writeFileSync(path.join(dir, 'real.sql'), 'select 1');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.js'), 'noise');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');

    const snapshot = buildDirSnapshot(dir);
    assert.ok(snapshot.has('real.sql'));
    assert.ok(snapshot.has('sub/nested.txt'));
    assert.ok(!snapshot.has('node_modules/pkg.js'), 'must not descend into node_modules');
    assert.ok(!snapshot.has('.git'), '.git must be ignored entirely');
    assert.ok(!snapshot.has('.git/HEAD'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPollCycle seeds on first run, then dispatches the diff to the change listeners', () => {
  const slug = 'slug-cycle';
  const received = [];
  const broadcast = [];
  const entry = {
    watcher: { close() {} },
    refCount: 1,
    pendingEvents: new Map(),
    debounceTimer: null,
    listeners: new Set([(msg) => broadcast.push(msg)]),
    rootDir: '/virtual/repo',
    snapshot: null,
    pollTimer: null,
  };
  activeWatchers.set(slug, entry);
  const unregister = registerChangeListener((change) => received.push(change));

  try {
    // First cycle: only seeds the baseline, emits nothing.
    const first = runPollCycle(slug, () => snap({ 'a.sql': { mtimeMs: 1, size: 1, isDir: false } }));
    assert.deepEqual(first, []);
    assert.equal(received.length, 0);

    // Second cycle: a program wrote query.sql → diff dispatched both ways.
    const second = runPollCycle(slug, () => snap({
      'a.sql': { mtimeMs: 1, size: 1, isDir: false },
      'query.sql': { mtimeMs: 2, size: 7, isDir: false },
    }));
    assert.deepEqual(second, [{ path: 'query.sql', kind: 'file' }]);

    // Global listener (server.js shape): { slug, rootDir, events }
    assert.equal(received.length, 1);
    assert.equal(received[0].slug, slug);
    assert.equal(received[0].rootDir, '/virtual/repo');
    assert.deepEqual(received[0].events, [{ path: 'query.sql', kind: 'file' }]);

    // Per-watcher broadcast (tree refresh shape): { type:'fs-change', slug, events }
    assert.equal(broadcast.length, 1);
    assert.equal(broadcast[0].type, 'fs-change');
    assert.deepEqual(broadcast[0].events, [{ path: 'query.sql', kind: 'file' }]);
  } finally {
    unregister();
    activeWatchers.delete(slug);
  }
});
