// Inline-completion telemetry. Mirrors the NEP pattern in nepTelemetry.js
// but with the smaller event vocabulary the inline path actually uses.
//
// Event kinds:
//   - 'fire'         — request issued (auto or manual trigger)
//   - 'cache_hit'    — request short-circuited by an LRU hit
//   - 'visible'      — first sanitised non-empty suggestion pushed to cache
//   - 'accepted'     — user accepted via Tab / inline-suggest commit
//   - 'cancelled'    — request superseded or explicitly cancelled
//   - 'rejected'     — request returned but produced nothing useful
//   - 'dismissed'    — visible suggestion was cleared without accept
//   - 'accept_blocked' / 'accept_adjusted' — user tried Tab on an unstable multiline suggestion
//
// Per-event optional payload fields: { reason, request_id, latency_ms, language, source }.
// Stored in localStorage so dashboards survive reloads. No server upload by
// default — the data is for the dashboard / replay harness to consume on
// demand. Wire an upload here if/when ops needs it (mirror flushEventsToServer
// from nepTelemetry).

const STORAGE_KEY = 'synthi.aicompletion.telemetry.v1';
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EVENTS = 5000;
const PERSIST_DEBOUNCE_MS = 800;

const isBrowser = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const DEFAULT_STATE = () => ({
  fire: 0,
  cache_hit: 0,
  visible: 0,
  accepted: 0,
  cancelled: 0,
  rejected: 0,
  dismissed: 0,
  accept_blocked: 0,
  accept_adjusted: 0,
  events: [], // { ts, kind, ...payload }
});

let _state = null;
let _persistTimer = null;

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

const state = () => {
  if (_state === null) _state = loadState();
  return _state;
};

const persist = () => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state()));
  } catch (_) { /* quota */ }
};

const schedulePersist = () => {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
};

const trim = () => {
  const s = state();
  const cutoff = Date.now() - WINDOW_MS;
  if (!s.events.length) return;
  if (s.events[0].ts >= cutoff && s.events.length < MAX_EVENTS) return;
  s.events = s.events.filter((e) => e.ts >= cutoff).slice(-MAX_EVENTS);
};

export const recordAiCompletionEvent = (kind, payload = {}) => {
  const s = state();
  const ts = Date.now();
  s.events.push({ ts, kind, ...payload });
  if (typeof s[kind] === 'number') s[kind] += 1;
  trim();
  schedulePersist();
};

/**
 * Rolling-window aggregates over the last WINDOW_MS. The accept-rate
 * denominator is `visible` (a request that never produced visible text
 * couldn't have been accepted). Cache-hit rate is over fires.
 *
 * Multi-line stats split visible/accepted by suggestion size (lines > 1)
 * so we can measure the cost of letting the model emit full units. If
 * `multiline_accept_rate` falls well below `accept_rate`, the structural
 * cap in truncateToFirstUnit is too generous and we're surfacing
 * speculative siblings the user routinely rejects.
 */
export const aiCompletionRollingStats = () => {
  const s = state();
  const cutoff = Date.now() - WINDOW_MS;
  const counts = {
    fire: 0,
    cache_hit: 0,
    visible: 0,
    accepted: 0,
    cancelled: 0,
    rejected: 0,
    dismissed: 0,
    accept_blocked: 0,
    accept_adjusted: 0,
  };
  let multiline_visible = 0;
  let multiline_accepted = 0;
  for (const e of s.events) {
    if (e.ts < cutoff) continue;
    if (counts[e.kind] !== undefined) counts[e.kind] += 1;
    if (e.kind === 'visible' && (e.lines || 0) > 1) multiline_visible += 1;
    if (e.kind === 'accepted' && (e.lines || 0) > 1) multiline_accepted += 1;
  }
  const accept_rate = counts.visible > 0 ? counts.accepted / counts.visible : null;
  const cache_hit_rate = counts.fire > 0 ? counts.cache_hit / (counts.fire + counts.cache_hit) : null;
  const multiline_accept_rate = multiline_visible > 0 ? multiline_accepted / multiline_visible : null;
  return {
    ...counts,
    accept_rate,
    cache_hit_rate,
    multiline_visible,
    multiline_accepted,
    multiline_accept_rate,
  };
};

export const aiCompletionSnapshot = () => {
  const s = state();
  return {
    fire: s.fire,
    cache_hit: s.cache_hit,
    visible: s.visible,
    accepted: s.accepted,
    cancelled: s.cancelled,
    rejected: s.rejected,
    dismissed: s.dismissed,
    accept_blocked: s.accept_blocked,
    accept_adjusted: s.accept_adjusted,
    rolling: aiCompletionRollingStats(),
  };
};

if (isBrowser()) {
  try {
    // Mirror the __synthiNep__ console handle so an operator can read the
    // inline-completion stats from DevTools without a UI surface.
    window.__synthiAiCompletion__ = {
      snapshot: aiCompletionSnapshot,
      rolling: aiCompletionRollingStats,
    };
  } catch (_) { /* ignored */ }
}
