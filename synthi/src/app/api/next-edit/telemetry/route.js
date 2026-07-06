import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { REJECT_REASONS } from '@/lib/nextEdit';

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
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ALLOWED_EVENT_KINDS = new Set(['fire', 'emitted', 'validated', 'accepted', 'rejected', 'skipped', 'dismissed']);
const ALLOWED_REJECTION_REASONS = new Set([...Object.values(REJECT_REASONS), 'unknown']);

// In-process ring of recent events. Newest first; trim from the tail when
// the byte budget is exceeded.
const _ring = [];
let _ringBytes = 0;

const unauthorized = () => NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

async function requireTelemetryActor() {
  const actor = await resolveActor();
  if (!actor) return { response: unauthorized() };
  const rl = checkLimit(`user:${actor.userId}:next-edit-telemetry`, RATE_LIMITS.telemetry);
  if (!rl.ok) {
    return {
      response: NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 }),
    };
  }
  return { actor };
}

function normalizeEvent(evt, now = Date.now()) {
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return null;
  if (!ALLOWED_EVENT_KINDS.has(evt.kind)) return null;

  const ts = typeof evt.ts === 'number' && Number.isFinite(evt.ts) ? Math.trunc(evt.ts) : now;
  if (ts < now - MAX_EVENT_AGE_MS || ts > now + MAX_FUTURE_SKEW_MS) return null;

  const normalized = { ts, kind: evt.kind };
  if (evt.kind === 'rejected') {
    normalized.reason = ALLOWED_REJECTION_REASONS.has(evt.reason) ? evt.reason : 'unknown';
  }
  return normalized;
}

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
  const gate = await requireTelemetryActor();
  if (gate.response) return gate.response;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 });
  }
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  let accepted = 0;
  for (const evt of events) {
    const normalized = normalizeEvent(evt);
    if (!normalized) continue;
    _ring.unshift(normalized);
    _ringBytes += JSON.stringify(normalized).length;
    accepted += 1;
  }
  trimRing();
  return NextResponse.json({ ok: true, accepted, ring_size: _ring.length });
}

export async function GET(request) {
  const gate = await requireTelemetryActor();
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const windowMs = Number(url.searchParams.get('window_ms') || '') ||
    7 * 24 * 60 * 60 * 1000;
  return NextResponse.json({
    aggregate: aggregate(windowMs),
    ring_size: _ring.length,
    ring_bytes: _ringBytes,
  });
}

export function __resetTelemetryForTests() {
  _ring.length = 0;
  _ringBytes = 0;
}
