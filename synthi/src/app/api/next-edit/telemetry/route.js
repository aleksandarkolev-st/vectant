import { NextResponse } from 'next/server';

// NEP telemetry aggregator (Phase 3).
//
// Two responsibilities:
//   1. POST: receive a batch of events from a session, aggregate into a
//      simple in-process counter ring. Replace with the real metrics sink
//      (Prometheus, BigQuery, etc) keyed by user/session in production.
//   2. GET: return the current rolling-window aggregate so a dashboard can
//      render `accept_rate / reject_rate / per-reason breakdown`.
//
// Kill-switch enforcement is currently CLIENT-SIDE (the client checks its
// own rolling window and flips its local flag). The server endpoint is
// authoritative for the aggregate; a server-side kill (ops can flip a
// pinned flag without touching every client's localStorage) lands when we
// wire NEP's flag into the existing feature-flag plumbing. For now this
// endpoint serves the dashboard.

const MAX_EVENTS_PER_BATCH = 500;
const MAX_RING_BYTES = 1 * 1024 * 1024; // 1 MB max retained in-process

// In-process ring of recent events. Newest first; trim from the tail when
// the byte budget is exceeded.
const _ring = [];
let _ringBytes = 0;

const trimRing = () => {
  while (_ringBytes > MAX_RING_BYTES && _ring.length > 0) {
    const dropped = _ring.pop();
    _ringBytes -= JSON.stringify(dropped).length;
  }
};

const aggregate = (windowMs = 7 * 24 * 60 * 60 * 1000) => {
  const cutoff = Date.now() - windowMs;
  let emitted = 0, validated = 0, accepted = 0;
  const reasons = {};
  for (const evt of _ring) {
    if (!evt?.ts || evt.ts < cutoff) continue;
    if (evt.kind === 'emitted') emitted += 1;
    else if (evt.kind === 'validated') validated += 1;
    else if (evt.kind === 'accepted') accepted += 1;
    else if (evt.kind === 'rejected') {
      const r = evt.reason || 'unknown';
      reasons[r] = (reasons[r] || 0) + 1;
    }
  }
  const accept_rate = validated > 0 ? accepted / validated : null;
  const reject_rate = emitted > 0 ? (emitted - validated) / emitted : null;
  return { emitted, validated, accepted, accept_rate, reject_rate, reasons, window_ms: windowMs };
};

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 });
  }
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    if (typeof evt.ts !== 'number') evt.ts = Date.now();
    _ring.unshift(evt);
    _ringBytes += JSON.stringify(evt).length;
  }
  trimRing();
  return NextResponse.json({ ok: true, accepted: events.length, ring_size: _ring.length });
}

export async function GET(request) {
  const url = new URL(request.url);
  const windowMs = Number(url.searchParams.get('window_ms') || '') ||
    7 * 24 * 60 * 60 * 1000;
  return NextResponse.json({
    aggregate: aggregate(windowMs),
    ring_size: _ring.length,
    ring_bytes: _ringBytes,
  });
}
