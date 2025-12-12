import { api } from '@/services/api';
import { fileCache } from '@/services/fileCache';

const PRIORITY = { high: 3, medium: 2, low: 1 };

function makeTaskKey(slug, path) {
  return `${slug}::${path}`;
}

export class LoadScheduler {
  constructor() {
    this._queue = []; // tasks
    this._inFlight = new Map(); // key -> { promise, priority, controller, background }
    this._running = 0;
    this._maxConcurrent = 2;

    this._lowPools = new Map(); // slug -> { paths, idx }
  }

  cancelBackground() {
    // Abort in-flight background tasks
    for (const [key, rec] of this._inFlight.entries()) {
      if (rec.background) {
        try { rec.controller?.abort(); } catch (_) {}
      }
    }

    // Cancel queued background tasks and settle their promises
    const keep = [];
    for (const t of this._queue) {
      const rec = this._inFlight.get(t.key);
      const isBg = rec ? rec.background : t.background;
      if (isBg) this._settleCancelled(t);
      else keep.push(t);
    }
    this._queue = keep;
  }

  setLowPriorityPool(slug, paths = []) {
    this._lowPools.set(slug, { paths: Array.from(paths), idx: 0 });
    this._kickIdle();
  }

  requestFileContent(slug, filePath, options = {}) {
    const priority = PRIORITY[options.priority] || PRIORITY.high;
    const background = !!options.background;

    // Cache hit: resolve immediately and touch LRU.
    const cached = fileCache.get(filePath);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const key = makeTaskKey(slug, filePath);
    const existing = this._inFlight.get(key);
    if (existing) {
      // Upgrade priority if needed.
      if (priority > existing.priority) existing.priority = priority;
      if (!background) existing.background = false;

      // Also upgrade any queued task instance.
      for (const t of this._queue) {
        if (t.key !== key) continue;
        if (priority > t.priority) t.priority = priority;
        if (!background) t.background = false;
      }

      if (priority === PRIORITY.high) this._yieldToHighPriority();
      return existing.promise;
    }

    const controller = options.signal ? null : new AbortController();
    const signal = options.signal || controller.signal;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

    const task = {
      slug,
      filePath,
      key,
      priority,
      background,
      signal,
      controller,
      resolve,
      reject,
    };

    this._queue.push(task);
    this._inFlight.set(key, { promise, priority, controller, background });

    if (priority === PRIORITY.high) this._yieldToHighPriority();
    this._pump();

    return promise;
  }

  prefetch(slug, candidates = [], options = {}) {
    const priority = options.priority || 'medium';
    const background = true;

    // Sort small files first if sizes were provided as objects.
    const paths = candidates
      .map(c => (typeof c === 'string' ? { path: c, size: Infinity } : { path: c.path, size: c.size ?? Infinity }))
      .filter(c => !!c.path);

    paths.sort((a, b) => (a.size - b.size) || a.path.localeCompare(b.path));

    for (const c of paths) {
      if (fileCache.has(c.path)) continue;
      this.requestFileContent(slug, c.path, { priority, background });
    }
  }

  _yieldToHighPriority() {
    // Abort in-flight background work so user-triggered loads win.
    for (const rec of this._inFlight.values()) {
      if (rec.background) {
        try { rec.controller?.abort(); } catch (_) {}
      }
    }

    // Drop queued background tasks and settle their promises.
    const keep = [];
    for (const t of this._queue) {
      const rec = this._inFlight.get(t.key);
      const isBg = rec ? rec.background : t.background;
      if (isBg) this._settleCancelled(t);
      else keep.push(t);
    }
    this._queue = keep;
  }

  _settleCancelled(task) {
    try {
      this._inFlight.delete(task.key);
    } catch (_) {}
    try {
      // Background tasks should not bubble cancellation.
      task.resolve(undefined);
    } catch (_) {}
  }

  _pump() {
    while (this._running < this._maxConcurrent) {
      const nextIdx = this._pickNextTaskIndex();
      if (nextIdx === -1) break;
      const task = this._queue.splice(nextIdx, 1)[0];
      this._start(task);
    }

    if (this._running === 0) {
      this._kickIdle();
    }
  }

  _pickNextTaskIndex() {
    if (!this._queue.length) return -1;
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < this._queue.length; i++) {
      const t = this._queue[i];
      const score = t.priority;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  async _start(task) {
    this._running++;

    const key = task.key;
    const inFlight = this._inFlight.get(key);
    if (inFlight) {
      inFlight.priority = task.priority;
      inFlight.background = task.background;
    }

    try {
      const content = await api.fetchFileContent(task.slug, task.filePath, { signal: task.signal });
      // Cache population happens on resolution
      fileCache.set(task.filePath, content);
      task.resolve(content);
    } catch (e) {
      // Background tasks swallow cancellations to avoid unhandled rejections.
      if (task.signal?.aborted && task.background) {
        task.resolve(undefined);
      } else {
        task.reject(e);
      }
    } finally {
      this._inFlight.delete(key);
      this._running--;
      this._pump();
    }
  }

  _kickIdle() {
    if (typeof window === 'undefined') return;

    const run = () => {
      try {
        this._enqueueNextLowPriority();
        this._pump();
      } catch (_) {}
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 200);
    }
  }

  _enqueueNextLowPriority() {
    // Only enqueue when there's no high/medium work.
    if (this._queue.some(t => t.priority >= PRIORITY.medium) || this._running > 0) return;

    for (const [slug, pool] of this._lowPools.entries()) {
      let enqueued = 0;
      while (pool.idx < pool.paths.length && enqueued < 4) {
        const p = pool.paths[pool.idx++];
        if (!p) continue;
        if (fileCache.has(p)) continue;
        this.requestFileContent(slug, p, { priority: 'low', background: true });
        enqueued++;
      }
    }
  }
}

export const loadScheduler = new LoadScheduler();
