// Local replay/eval capture for AI editor features.
//
// This is intentionally browser-local: no upload, no secrets path, and bounded
// storage. It gives us enough request/outcome material to replay prompt/context
// changes offline without turning product telemetry into a code exfiltration
// channel.

const STORAGE_KEY = 'synthi.ai.replay.v1';
const MAX_EVENTS = 300;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STRING_CHARS = 12 * 1024;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 6;

let _state = null;
let _persistTimer = null;
let _seq = 0;

const isBrowser = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const defaultState = () => ({ events: [] });

const loadState = () => {
  if (!isBrowser()) return defaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (_) {
    return defaultState();
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
  }, 500);
};

const safeClone = (value, depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}\n...[truncated ${value.length - MAX_STRING_CHARS} chars]`
      : value;
  }
  if (type === 'number' || type === 'boolean') return value;
  if (type !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeClone(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return out;
  }

  const out = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = safeClone(value[key], depth + 1, seen);
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    out.__truncatedKeys = keys.length - MAX_OBJECT_KEYS;
  }
  return out;
};

const fitEvent = (event) => {
  let fitted = event;
  try {
    const raw = JSON.stringify(fitted);
    if (raw.length <= MAX_EVENT_BYTES) return fitted;
    fitted = {
      ...event,
      payload: {
        summary: event.payload?.summary || null,
        omitted: `event exceeded ${MAX_EVENT_BYTES} bytes`,
      },
    };
  } catch (_) {
    fitted = {
      ...event,
      payload: { omitted: 'event was not serializable' },
    };
  }
  return fitted;
};

export const createReplayId = (prefix = 'ai') => {
  _seq = (_seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}`;
};

export const recordAiReplaySample = ({
  feature,
  phase,
  requestId = null,
  payload = {},
}) => {
  if (!feature || !phase) return null;
  const event = fitEvent({
    ts: Date.now(),
    feature,
    phase,
    requestId,
    payload: safeClone(payload),
  });
  const s = state();
  s.events.push(event);
  if (s.events.length > MAX_EVENTS) {
    s.events = s.events.slice(-MAX_EVENTS);
  }
  schedulePersist();
  return event;
};

export const aiReplaySnapshot = ({ feature = null, requestId = null, limit = MAX_EVENTS } = {}) => {
  const events = state().events.filter((event) => {
    if (feature && event.feature !== feature) return false;
    if (requestId !== null && event.requestId !== requestId) return false;
    return true;
  });
  return events.slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit) || MAX_EVENTS)));
};

export const clearAiReplaySamples = () => {
  state().events = [];
  persist();
};

export const exportAiReplayJson = (opts = {}) =>
  JSON.stringify(aiReplaySnapshot(opts), null, 2);

if (isBrowser()) {
  try {
    window.__synthiAiReplay__ = {
      snapshot: aiReplaySnapshot,
      exportJson: exportAiReplayJson,
      clear: clearAiReplaySamples,
    };
  } catch (_) { /* ignored */ }
}
