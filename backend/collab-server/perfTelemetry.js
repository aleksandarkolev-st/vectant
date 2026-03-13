/**
 * perfTelemetry.js — High-Resolution Performance Telemetry for Synthi Collab Server
 *
 * Provides a lightweight instrumentation layer that:
 *   1. Wraps critical backend operations with high-resolution timers (process.hrtime.bigint)
 *   2. Logs and flags any operation exceeding THRESHOLD_MS (default 50ms)
 *   3. Tracks p50/p90/p99 latencies per operation category for dashboard consumption
 *   4. Detects event-loop blocking via a periodic heartbeat
 *
 * Categories:
 *   - git:*       — All git CLI operations (status, stage, commit, push…)
 *   - fs:*        — File system reads/writes
 *   - ast:*       — AST parsing / code-intel operations
 *   - ai:*        — AI context retrieval and analysis proxy
 *   - collab:*    — Yjs persistence, document binding, hash computation
 *
 * Usage:
 *   const { withTelemetry, getMetrics, resetMetrics } = require('./perfTelemetry');
 *
 *   // Wrap an async function:
 *   const result = await withTelemetry('git:status', () => gitService.getStatus(slug));
 *
 *   // Wrap a sync function:
 *   const hash = withTelemetry.sync('collab:hash', () => computeHash(content));
 *
 *   // Retrieve metrics snapshot:
 *   const snapshot = getMetrics();  // { 'git:status': { count, p50, p90, p99, max, flagged }, ... }
 */

'use strict';

// ── Configuration ────────────────────────────────────────────────────────────

/** Operations above this threshold are flagged in logs */
const THRESHOLD_MS = 50;

/** Maximum number of latency samples retained per category (circular buffer) */
const MAX_SAMPLES = 1000;

/** Event-loop monitor heartbeat interval */
const EL_MONITOR_INTERVAL_MS = 500;

/** Event-loop block detection threshold */
const EL_BLOCK_THRESHOLD_MS = 100;

// ── Internal State ───────────────────────────────────────────────────────────

/** @type {Map<string, { samples: Float64Array, idx: number, count: number, max: number, flagged: number }>} */
const categories = new Map();

function getOrCreateCategory(name) {
  if (!categories.has(name)) {
    categories.set(name, {
      samples: new Float64Array(MAX_SAMPLES),
      idx: 0,
      count: 0,
      max: 0,
      flagged: 0,
    });
  }
  return categories.get(name);
}

function recordLatency(name, durationMs) {
  const cat = getOrCreateCategory(name);
  cat.samples[cat.idx] = durationMs;
  cat.idx = (cat.idx + 1) % MAX_SAMPLES;
  cat.count++;
  if (durationMs > cat.max) cat.max = durationMs;

  if (durationMs > THRESHOLD_MS) {
    cat.flagged++;
    console.warn(
      `[PERF] ⚠ SLOW ${name}: ${durationMs.toFixed(2)}ms (threshold: ${THRESHOLD_MS}ms)`
    );
  }
}

// ── Percentile Calculation ───────────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

function computePercentiles(cat) {
  const usedCount = Math.min(cat.count, MAX_SAMPLES);
  if (usedCount === 0) return { p50: 0, p90: 0, p99: 0 };
  const slice = Array.from(cat.samples.subarray(0, usedCount)).sort((a, b) => a - b);
  return {
    p50: percentile(slice, 50),
    p90: percentile(slice, 90),
    p99: percentile(slice, 99),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Wrap an async function with high-resolution timing.
 * @param {string} name — Category name (e.g. 'git:status')
 * @param {() => Promise<T>} fn — The async function to instrument
 * @returns {Promise<T>}
 * @template T
 */
async function withTelemetry(name, fn) {
  const start = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;
    recordLatency(name, durationMs);
  }
}

/**
 * Wrap a synchronous function with high-resolution timing.
 * @param {string} name — Category name
 * @param {() => T} fn — The sync function to instrument
 * @returns {T}
 * @template T
 */
withTelemetry.sync = function syncTelemetry(name, fn) {
  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;
    recordLatency(name, durationMs);
  }
};

/**
 * Get a snapshot of all telemetry metrics.
 * @returns {Object<string, { count: number, p50: number, p90: number, p99: number, max: number, flagged: number }>}
 */
function getMetrics() {
  const snapshot = {};
  for (const [name, cat] of categories) {
    const pcts = computePercentiles(cat);
    snapshot[name] = {
      count: cat.count,
      p50: Math.round(pcts.p50 * 100) / 100,
      p90: Math.round(pcts.p90 * 100) / 100,
      p99: Math.round(pcts.p99 * 100) / 100,
      max: Math.round(cat.max * 100) / 100,
      flagged: cat.flagged,
    };
  }
  return snapshot;
}

/**
 * Reset all metrics (useful for testing or periodic rotation).
 */
function resetMetrics() {
  categories.clear();
}

// ── Event-Loop Blocking Monitor ──────────────────────────────────────────────

let _elMonitorTimer = null;
let _elLastTick = process.hrtime.bigint();
let _elBlockCount = 0;

function startEventLoopMonitor() {
  if (_elMonitorTimer) return;
  _elLastTick = process.hrtime.bigint();

  _elMonitorTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - _elLastTick) / 1e6;
    const drift = elapsedMs - EL_MONITOR_INTERVAL_MS;

    if (drift > EL_BLOCK_THRESHOLD_MS) {
      _elBlockCount++;
      console.warn(
        `[PERF] ⚠ Event-loop blocked for ~${drift.toFixed(0)}ms ` +
        `(expected ${EL_MONITOR_INTERVAL_MS}ms, actual ${elapsedMs.toFixed(0)}ms). ` +
        `Total blocks: ${_elBlockCount}`
      );
      recordLatency('eventloop:block', drift);
    }

    _elLastTick = now;
  }, EL_MONITOR_INTERVAL_MS);

  // Don't keep the process alive just for monitoring
  if (_elMonitorTimer.unref) _elMonitorTimer.unref();
}

function stopEventLoopMonitor() {
  if (_elMonitorTimer) {
    clearInterval(_elMonitorTimer);
    _elMonitorTimer = null;
  }
}

function getEventLoopBlockCount() {
  return _elBlockCount;
}

// ── Express/HTTP Middleware ───────────────────────────────────────────────────

/**
 * Returns a request timing function for HTTP handlers.
 * Wraps the handler so every request is timed and logged.
 *
 * @param {string} category — Telemetry category prefix (e.g. 'http:git')
 * @param {string} action — Action name (e.g. 'status')
 * @param {(req, res) => Promise<void>} handler
 * @returns {(req, res) => Promise<void>}
 */
function instrumentHandler(category, action, handler) {
  const name = `${category}:${action}`;
  return async (req, res) => {
    const start = process.hrtime.bigint();
    try {
      await handler(req, res);
    } finally {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1e6;
      recordLatency(name, durationMs);
    }
  };
}

// ── Auto-start event-loop monitor ────────────────────────────────────────────
startEventLoopMonitor();

module.exports = {
  withTelemetry,
  getMetrics,
  resetMetrics,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopBlockCount,
  instrumentHandler,
  THRESHOLD_MS,
};
