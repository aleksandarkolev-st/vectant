// NEP telemetry — Phase 3.
//
// Counters per session, persisted to localStorage so they survive reloads.
// Uploaded via /api/next-edit/telemetry on a debounced cadence. The kill
// switch reads from the SAME backing store so a degenerate session can flip
// itself off without waiting for the upload to land.
//
// Definitions (Plan Section 7, with the "Why-not-A" gaps resolved):
//   - predictions_emitted: counted at the FIRST `>>>>>>> REPLACE` boundary
//     observed for a stream. Streams that produce zero blocks count 0.
//     Streams that produce 3 blocks count 3. This pins the denominator of
//     `validation_rejection_rate` so the kill switch is well-defined.
//   - predictions_validated: passed Section 2 validator (N=1 SEARCH, or
//     SEARCH ALL with N≥1 in Phase 2).
//   - predictions_accepted: user pressed Tab and apply landed.
//
// Rejection-reason breakdown is stored as a flat counter map keyed by the
// REJECT_REASONS values from lib/nextEdit.

const STORAGE_KEY = 'synthi.nep.telemetry.v1';
const KILL_KEY = 'synthi.nep.killed.v1';
const UPLOAD_ENDPOINT = '/api/next-edit/telemetry';
const UPLOAD_BATCH_MAX = 200;
const UPLOAD_DEBOUNCE_MS = 8000;

// Plan Section 7 thresholds, with an early-phase override per Section 10:
// internal-only Phase 1 may not reach N≥200 emissions over 7 days, so the
// floor is dormant below that. Set NEXT_PUBLIC_NEP_KILL_MIN to lower in dev.
export const NEP_KILL_THRESHOLDS = Object.freeze({
  ACCEPT_RATE_FLOOR: 0.25,
  REJECT_RATE_CEILING: 0.40,
  N_KILL_MIN: 200,
  WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
});

const DEFAULT_STATE = () => ({
  // Lifetime counters (since installed). Useful for the dashboard but not
  // used by the kill switch — that runs on the rolling window.
  emitted: 0,
  validated: 0,
  accepted: 0,
  rejection_reasons: {},
  // Rolling window: array of `{ ts, kind, reason? }` events. Trimmed when
  // older than WINDOW_MS or when the array exceeds 5000 entries (~150 KB).
  events: [],
  fires_total: 0,
  killed_at: null,
  killed_reason: null,
});

const isBrowser = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const loadState = () => {
  if (!isBrowser()) return DEFAULT_STATE();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE();
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE(), ...parsed };
  } catch (_) {
    return DEFAULT_STATE();
  }
};

let _state = null;
let _flushTimer = null;
let _uploadTimer = null;
const PENDING_FLUSH_MS = 800;

const state = () => {
  if (_state === null) _state = loadState();
  return _state;
};

const persist = () => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state()));
  } catch (_) { /* quota — silent */ }
};

const trim = () => {
  const s = state();
  const cutoff = Date.now() - NEP_KILL_THRESHOLDS.WINDOW_MS;
  if (s.events.length === 0) return;
  if (s.events[0].ts >= cutoff && s.events.length < 5000) return;
  s.events = s.events.filter((e) => e.ts >= cutoff).slice(-5000);
};

const scheduleFlush = () => {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    persist();
    maybeRunKillSwitch();
  }, PENDING_FLUSH_MS);
};

const scheduleUpload = () => {
  if (!isBrowser()) return;
  if (_uploadTimer) return;
  _uploadTimer = setTimeout(async () => {
    _uploadTimer = null;
    await flushEventsToServer();
  }, UPLOAD_DEBOUNCE_MS);
};

/**
 * Record a single telemetry event. Accepted kinds:
 *   - 'fire'        — request issued
 *   - 'emitted'     — stream produced a parseable block
 *   - 'validated'   — block passed validator
 *   - 'accepted'    — user accepted (apply landed)
 *   - 'rejected'    — block rejected; `reason` is one of REJECT_REASONS
 */
export const recordNepEvent = (kind, payload = {}) => {
  const s = state();
  const ts = Date.now();
  s.events.push({ ts, kind, ...payload });
  if (kind === 'fire') s.fires_total += 1;
  if (kind === 'emitted') s.emitted += 1;
  if (kind === 'validated') s.validated += 1;
  if (kind === 'accepted') s.accepted += 1;
  if (kind === 'rejected') {
    const reason = payload?.reason || 'unknown';
    s.rejection_reasons[reason] = (s.rejection_reasons[reason] || 0) + 1;
  }
  trim();
  scheduleFlush();
  scheduleUpload();
};

/**
 * Compute the rolling-window stats. Returns `{ emitted, validated, accepted,
 * accept_rate, reject_rate, n_total }` over the last WINDOW_MS.
 */
export const rollingStats = () => {
  const s = state();
  const cutoff = Date.now() - NEP_KILL_THRESHOLDS.WINDOW_MS;
  const events = s.events.filter((e) => e.ts >= cutoff);
  let emitted = 0, validated = 0, accepted = 0;
  for (const e of events) {
    if (e.kind === 'emitted') emitted += 1;
    else if (e.kind === 'validated') validated += 1;
    else if (e.kind === 'accepted') accepted += 1;
  }
  const accept_rate = validated > 0 ? accepted / validated : null;
  const reject_rate = emitted > 0 ? (emitted - validated) / emitted : null;
  return { emitted, validated, accepted, accept_rate, reject_rate, n_total: emitted };
};

/**
 * Kill-switch evaluator. Sets the local flag when the rolling-window OR
 * condition is satisfied with N ≥ N_KILL_MIN — small samples produce
 * misleading rates and shouldn't trigger a kill. Plan: accept_rate < 25%
 * OR reject_rate > 40% (catches plausible-but-wrong + hallucination).
 */
export const maybeRunKillSwitch = () => {
  const s = state();
  if (s.killed_at) return { killed: true, reason: s.killed_reason };

  const stats = rollingStats();
  if ((stats.n_total ?? 0) < NEP_KILL_THRESHOLDS.N_KILL_MIN) {
    return { killed: false, reason: null };
  }

  const failures = [];
  if (stats.accept_rate !== null && stats.accept_rate < NEP_KILL_THRESHOLDS.ACCEPT_RATE_FLOOR) {
    failures.push(`accept_rate=${stats.accept_rate.toFixed(3)} < ${NEP_KILL_THRESHOLDS.ACCEPT_RATE_FLOOR}`);
  }
  if (stats.reject_rate !== null && stats.reject_rate > NEP_KILL_THRESHOLDS.REJECT_RATE_CEILING) {
    failures.push(`reject_rate=${stats.reject_rate.toFixed(3)} > ${NEP_KILL_THRESHOLDS.REJECT_RATE_CEILING}`);
  }
  if (!failures.length) return { killed: false, reason: null };

  s.killed_at = Date.now();
  s.killed_reason = failures.join(' | ');
  if (isBrowser()) {
    try { window.localStorage.setItem(KILL_KEY, JSON.stringify({ at: s.killed_at, reason: s.killed_reason })); }
    catch (_) { /* quota — silent */ }
  }
  persist();
  if (typeof console !== 'undefined') {
    console.warn('[NEP] kill switch flipped:', s.killed_reason);
  }
  return { killed: true, reason: s.killed_reason };
};

/**
 * Synchronous kill check — read at every NEP fire so a tripped session
 * stops issuing requests immediately.
 *
 * Honours BOTH the local rolling-window kill (this browser's session has
 * a bad accept_rate) and a cached server-side kill (ops flipped the global
 * flag via /api/next-edit/flag). The server-side check is fetched
 * asynchronously by checkServerKill below; this function is the synchronous
 * gate that reads the cached result.
 */
export const isNepKilled = () => {
  if (!isBrowser()) return false;
  // Local kill.
  try {
    const raw = window.localStorage.getItem(KILL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.at) return true;
    }
  } catch (_) { /* fall through to server-cache check */ }
  // Server kill (cached).
  if (_serverKillCache && Date.now() < _serverKillExpiry && _serverKillCache.killed) {
    return true;
  }
  return false;
};

// Server-side kill cache. checkServerKill() refreshes this on a TTL.
let _serverKillCache = null;
let _serverKillExpiry = 0;
let _serverKillInflight = null;

/**
 * Refresh the server-side kill cache. Call before every NEP fire — the
 * function is cheap on cache hit (a Date.now() compare) and on miss it
 * issues a single GET that's cacheable on the edge.
 *
 * Returns the current effective kill state.
 */
export const checkServerKill = async () => {
  if (!isBrowser()) return false;
  if (Date.now() < _serverKillExpiry && _serverKillCache) {
    return _serverKillCache.killed;
  }
  if (_serverKillInflight) return _serverKillInflight;
  _serverKillInflight = (async () => {
    try {
      const res = await fetch('/api/next-edit/flag', { method: 'GET' });
      if (!res.ok) return false;
      const data = await res.json();
      const ttlMs = Math.max(15, Number(data?.cache_ttl_seconds || 60)) * 1000;
      _serverKillCache = {
        killed: data?.enabled === false,
        reason: data?.reason || null,
      };
      _serverKillExpiry = Date.now() + ttlMs;
      return _serverKillCache.killed;
    } catch (_) {
      // On network error keep last-known state. If we've never fetched,
      // default to NOT killed — a transient flag-endpoint outage shouldn't
      // disable NEP for everyone.
      return _serverKillCache?.killed || false;
    } finally {
      _serverKillInflight = null;
    }
  })();
  return _serverKillInflight;
};

/**
 * Manual re-enable — clears the kill flag. The plan calls for "manual
 * re-enable required" after the switch trips. Exposed on `window.__synthiNep__`
 * for live operator action; not bound to a UI element on purpose.
 */
export const resetKillSwitch = () => {
  const s = state();
  s.killed_at = null;
  s.killed_reason = null;
  if (isBrowser()) {
    try { window.localStorage.removeItem(KILL_KEY); } catch (_) { /* silent */ }
  }
  persist();
};

/**
 * Snapshot for the replay harness / dashboard. Returns a deep copy so the
 * caller can serialise without locking out further updates.
 */
export const telemetrySnapshot = () => {
  const s = state();
  return {
    emitted: s.emitted,
    validated: s.validated,
    accepted: s.accepted,
    fires_total: s.fires_total,
    rejection_reasons: { ...s.rejection_reasons },
    rolling: rollingStats(),
    killed_at: s.killed_at,
    killed_reason: s.killed_reason,
  };
};

/**
 * Drain pending events for upload. Returns the events removed; caller is
 * responsible for shipping them. On error, caller should re-enqueue so we
 * don't lose data on transient network failures.
 */
export const drainEventsForUpload = (max = UPLOAD_BATCH_MAX) => {
  const s = state();
  const out = s.events.slice(0, max);
  s.events = s.events.slice(max);
  persist();
  return out;
};

const flushEventsToServer = async () => {
  if (!isBrowser()) return;
  const events = drainEventsForUpload();
  if (!events.length) return;
  try {
    await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  } catch (_) {
    // Re-enqueue on failure; preserve order by prepending.
    const s = state();
    s.events = [...events, ...s.events];
    persist();
  }
};

// Wire the operator console handle. Doesn't render anything; just exposes
// the snapshot + reset to a developer who hits F12.
if (isBrowser()) {
  try {
    window.__synthiNep__ = {
      snapshot: telemetrySnapshot,
      resetKillSwitch,
      rollingStats,
      maybeRunKillSwitch,
      flushEventsToServer,
    };
  } catch (_) { /* ignore */ }
}
