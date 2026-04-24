/* eslint-env worker */
// ─────────────────────────────────────────────────────────────────────────────
// CRDT Worker — Runs Yjs document lifecycle + y-websocket sync on a dedicated
// background thread so that *all* binary CRDT encoding / decoding and WebSocket
// message parsing happen off the main thread and never block user keystrokes.
//
// Communication with the main thread is via structured-cloneable postMessage
// payloads.  The main thread never touches Y.Doc or WebsocketProvider directly.
// ─────────────────────────────────────────────────────────────────────────────

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

// ── State ───────────────────────────────────────────────────────────────────
const docs = new Map(); // key → Entry { doc, provider, ytext, applyingLocal }
let serverUrl = 'ws://localhost:1234';

// Tunables for the WebsocketProvider.
//   MAX_BACKOFF_MS — cap for the provider's internal reconnect delay.  The
//     default (2500ms) is aggressive enough to storm the server when many
//     tabs reconnect after a deploy.  30s keeps the UI responsive while
//     still letting a restarting server catch its breath.
//   RESYNC_INTERVAL_MS — periodic full resync; guards against silent drops
//     where the TCP socket stays open but sync messages were lost.
//   JITTER_WINDOW_MS — randomized delay before the FIRST connect, to spread
//     reconnect bursts across the fleet so we don't all hit the server in
//     the same 50ms window.
const MAX_BACKOFF_MS = 30_000;
const RESYNC_INTERVAL_MS = 20_000;
const JITTER_WINDOW_MS = 300;

// Note on offline edits: Yjs treats the Y.Doc as the source of truth, not
// the network.  Edits made while the provider is disconnected land in the
// local Y.Doc immediately and are batched into a sync step 2 as soon as
// the provider reconnects.  No additional queue is required — but we MUST
// keep the Y.Doc alive across reconnects (we do; only fatal close codes
// destroy it).

// WebSocket close-code classification.
//   Recoverable: transient issues; the provider will reconnect and resync.
//   Fatal:      the server told us to stop; reseeding with the stale state
//               would corrupt the shared document.
//   Ambiguous:  treat as recoverable but mark the doc as un-seeded so the
//               next connection re-fetches authoritative content.
const RECOVERABLE_CLOSE_CODES = new Set([
  1001, // going away (browser unload or server shutdown)
  1006, // abnormal closure (network blip)
  1011, // server error
  1012, // service restart
  1013, // try again later
  1014, // bad gateway
]);
const FATAL_CLOSE_CODES = new Set([
  4000, // doc invalidated — handled separately above
  4001, // auth/permission revoked
  4403, // forbidden
]);

function classifyCloseCode(code) {
  if (RECOVERABLE_CLOSE_CODES.has(code)) return 'recoverable';
  if (FATAL_CLOSE_CODES.has(code)) return 'fatal';
  // 1008 (policy violation), 1009 (message too big), and similar indicate a
  // client bug rather than a network blip — reconnecting with the same
  // message would just loop.  Treat as ambiguous so the client gets a chance
  // to recover with fresh state.
  return 'ambiguous';
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const post = (msg) => self.postMessage(msg);

/**
 * Build a WebSocket subclass that intercepts special close codes from the
 * collab server.  Close code 4000 means "doc invalidated" — the server-side
 * Yjs doc was destroyed (e.g. after a file revert or git checkout) and
 * reconnecting with the stale CRDT state would cause duplication.
 */
function makeInvalidationAwareWS(key) {
  return class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener('close', (ev) => {
        const entry = docs.get(key);
        if (entry?.suppressCloseHandling) return;
        if (ev.code === 4000) {
          post({ type: 'doc-invalidated', key });
          // Destroy BEFORE the provider can schedule a reconnect so it sees
          // shouldConnect === false and aborts.
          destroyDocInternal(key);
          return;
        }
        if (ev.code === 1000) return; // clean close — nothing to do

        const kind = classifyCloseCode(ev.code);
        post({
          type: 'seed-reset',
          key,
          code: ev.code,
          reason: ev.reason || '',
          kind,
        });
        if (kind === 'recoverable') {
          resetDocInternal(key);
          return;
        }
        if (kind === 'fatal') {
          // Server explicitly rejected us — stop reconnecting to avoid a
          // connection storm.  The main thread will see the seed-reset and
          // can surface an auth error to the user.
          destroyDocInternal(key);
          return;
        }
        // Ambiguous: leave the provider to retry with exponential backoff
        // (y-websocket default) but mark the doc un-seeded so initial
        // content is re-fetched on reconnect.
        if (entry) entry.seeded = false;
      });
    }
  };
}

function ensureDocInternal(key, params) {
  if (docs.has(key)) return docs.get(key);

  const doc = new Y.Doc();
  // Spread initial connection attempts over JITTER_WINDOW_MS so we don't
  // all slam the server at the same instant after a deploy.  We create the
  // provider with connect:false and flip connect() on after a jittered
  // microtask delay.
  const jitter = Math.floor(Math.random() * JITTER_WINDOW_MS);
  const provider = new WebsocketProvider(serverUrl, key, doc, {
    connect: false,
    params: params || {},
    WebSocketPolyfill: makeInvalidationAwareWS(key),
    maxBackoffTime: MAX_BACKOFF_MS,
    resyncInterval: RESYNC_INTERVAL_MS,
  });
  setTimeout(() => {
    // Guard against late-destroy racing with jittered connect.
    const current = docs.get(key);
    if (!current || current.provider !== provider) return;
    try { provider.connect(); } catch (_) { /* provider already destroyed */ }
  }, jitter);
  const ytext = doc.getText('monaco');
  const entry = {
    doc,
    provider,
    ytext,
    applyingLocal: false,
    seeded: false,
    params: params || {},
    localAwarenessState: null,
    suppressCloseHandling: false,
  };

  // ── Y.Text observer — only forward REMOTE deltas to the main thread ──
  // Coalesce bursts of remote deltas (e.g. when an LLM streams many small
  // inserts) onto a single microtask flush.  When only one delta arrives we
  // forward it incrementally; when multiple arrive in the same task we send
  // an empty delta and rely on the main thread's full-text fallback, since
  // later deltas' offsets no longer reference the initial model state.
  let pendingDeltas = null;
  let flushScheduled = false;
  const flushPending = () => {
    flushScheduled = false;
    if (!pendingDeltas || pendingDeltas.length === 0) return;
    const fullText = ytext.toString();
    const delta = pendingDeltas.length === 1 ? pendingDeltas[0] : [];
    pendingDeltas = null;
    post({ type: 'remote-delta', key, delta, fullText, length: fullText.length });
  };
  ytext.observe((event) => {
    if (entry.applyingLocal) return; // local edits already came FROM main thread
    const delta = event.delta;
    if (!delta || delta.length === 0) return;
    if (!pendingDeltas) pendingDeltas = [];
    pendingDeltas.push(delta);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushPending);
    }
  });

  // ── Provider status ───────────────────────────────────────────────────
  provider.on('status', (ev) => {
    post({
      type: 'provider-status',
      key,
      status: ev.status,
      wsconnected: !!provider.wsconnected,
      wsconnecting: !!provider.wsconnecting,
    });
  });

  // ── Sync event ────────────────────────────────────────────────────────
  provider.on('sync', (isSynced) => {
    if (isSynced) {
      post({
        type: 'provider-synced',
        key,
        content: ytext.toString(),
        length: ytext.length,
      });
    }
  });

  // ── Awareness changes ─────────────────────────────────────────────────
  if (provider.awareness) {
    provider.awareness.on('change', (changes) => {
      const states = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        states.push({ clientId, state });
      });
      post({
        type: 'awareness-update',
        key,
        states,
        changes, // { added, updated, removed }
        localClientId: provider.awareness.clientID,
      });
    });

    queueMicrotask(() => {
      const activeEntry = docs.get(key);
      if (activeEntry?.localAwarenessState) {
        try {
          provider.awareness.setLocalState(activeEntry.localAwarenessState);
        } catch (_) {}
      }
    });
  }

  docs.set(key, entry);
  return entry;
}

function postDocReady(key, entry) {
  if (!entry) return;
  post({
    type: 'doc-ready',
    key,
    synced: !!entry.provider?.synced,
    content: entry.ytext?.toString() || '',
    length: entry.ytext?.length || 0,
    wsconnected: !!entry.provider?.wsconnected,
  });
}

function resetDocInternal(key) {
  const existing = docs.get(key);
  if (!existing) return null;

  const params = existing.params || {};
  const localAwarenessState = existing.localAwarenessState || null;

  existing.suppressCloseHandling = true;
  docs.delete(key);
  try { existing.provider.destroy(); } catch (_) {}
  try { existing.doc.destroy(); } catch (_) {}

  const nextEntry = ensureDocInternal(key, params);
  nextEntry.seeded = false;
  nextEntry.localAwarenessState = localAwarenessState;
  if (nextEntry.provider?.awareness && localAwarenessState) {
    try {
      nextEntry.provider.awareness.setLocalState(localAwarenessState);
    } catch (_) {}
  }
  postDocReady(key, nextEntry);
  return nextEntry;
}

function destroyDocInternal(key) {
  const entry = docs.get(key);
  if (!entry) return;
  entry.suppressCloseHandling = true;
  try { entry.provider.destroy(); } catch (_) {}
  try { entry.doc.destroy(); } catch (_) {}
  docs.delete(key);
}

// ── Message Router ──────────────────────────────────────────────────────────
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg?.type) return;

  try {
    switch (msg.type) {
      // ── Configuration ──────────────────────────────────────────────────
      case 'configure': {
        if (msg.serverUrl) serverUrl = msg.serverUrl;
        break;
      }

      // ── Doc lifecycle ──────────────────────────────────────────────────
      case 'ensure-doc': {
        const entry = ensureDocInternal(msg.key, msg.params);
        postDocReady(msg.key, entry);
        break;
      }

      // ── Local changes from Monaco → Yjs ────────────────────────────────
      case 'local-changes': {
        const entry = docs.get(msg.key);
        if (!entry) return;
        entry.applyingLocal = true;
        try {
          entry.doc.transact(() => {
            const changes = msg.changes;
            for (let i = changes.length - 1; i >= 0; i--) {
              const c = changes[i];
              if (c.rangeLength > 0) entry.ytext.delete(c.rangeOffset, c.rangeLength);
              if (c.text.length > 0) entry.ytext.insert(c.rangeOffset, c.text);
            }
          });
        } catch (err) {
          // Fallback: full replace using the model text sent from main thread
          try {
            if (msg.fullText != null) {
              entry.applyingLocal = true; // keep flag set during fallback
              entry.doc.transact(() => {
                if (entry.ytext.length > 0) entry.ytext.delete(0, entry.ytext.length);
                entry.ytext.insert(0, msg.fullText);
              });
            }
          } catch (_) {}
          post({ type: 'error', key: msg.key, error: 'local-changes failed: ' + (err?.message || err) });
        } finally {
          entry.applyingLocal = false;
        }
        break;
      }

      // ── Seeding ────────────────────────────────────────────────────────
      case 'seed-content': {
        const entry = docs.get(msg.key);
        if (!entry) return;
        if (entry.seeded && !msg.force) return;
        if (entry.ytext.length > 0 && !msg.force) {
          entry.seeded = true;
          post({
            type: 'seed-skipped',
            key: msg.key,
            reason: 'ytext-has-content',
            content: entry.ytext.toString(),
            length: entry.ytext.length,
          });
          return;
        }
        // Note: NOT gated by applyingLocal — seed inserts should be forwarded
        // to the main thread as remote-delta so the model gets the content.
        entry.doc.transact(() => {
          if (entry.ytext.length > 0) entry.ytext.delete(0, entry.ytext.length);
          if (msg.content) entry.ytext.insert(0, msg.content);
        });
        entry.seeded = true;
        post({ type: 'seed-applied', key: msg.key });
        break;
      }

      case 'mark-seeded': {
        const entry = docs.get(msg.key);
        if (entry) entry.seeded = true;
        break;
      }

      case 'reset-seed-flag': {
        const entry = docs.get(msg.key);
        if (entry) entry.seeded = false;
        break;
      }

      // ── Content queries ────────────────────────────────────────────────
      case 'get-content': {
        const entry = docs.get(msg.key);
        post({
          type: 'content-response',
          key: msg.key,
          requestId: msg.requestId,
          content: entry ? entry.ytext.toString() : '',
          length: entry ? entry.ytext.length : 0,
          seeded: entry ? entry.seeded : false,
        });
        break;
      }

      // ── Content reset (e.g. merge conflict resolution) ─────────────────
      case 'reset-content': {
        const entry = docs.get(msg.key);
        if (!entry) return;
        entry.doc.transact(() => {
          if (entry.ytext.length > 0) entry.ytext.delete(0, entry.ytext.length);
          if (msg.content) entry.ytext.insert(0, msg.content);
        });
        entry.seeded = false;
        break;
      }

      // ── Awareness ──────────────────────────────────────────────────────
      case 'set-awareness-state': {
        const entry = docs.get(msg.key);
        if (!entry?.provider?.awareness) return;
        entry.localAwarenessState = msg.state;
        entry.provider.awareness.setLocalState(msg.state);
        break;
      }

      case 'set-awareness-field': {
        const entry = docs.get(msg.key);
        if (!entry?.provider?.awareness) return;
        entry.localAwarenessState = {
          ...(entry.provider.awareness.getLocalState() || entry.localAwarenessState || {}),
          [msg.field]: msg.value,
        };
        entry.provider.awareness.setLocalStateField(msg.field, msg.value);
        break;
      }

      case 'clear-awareness': {
        const entry = docs.get(msg.key);
        if (!entry?.provider?.awareness) return;
        entry.localAwarenessState = null;
        entry.provider.awareness.setLocalState(null);
        break;
      }

      case 'get-awareness-states': {
        const entry = docs.get(msg.key);
        const states = [];
        if (entry?.provider?.awareness) {
          entry.provider.awareness.getStates().forEach((state, clientId) => {
            states.push({ clientId, state });
          });
        }
        post({
          type: 'awareness-states-response',
          key: msg.key,
          requestId: msg.requestId,
          states,
          localClientId: entry?.provider?.awareness?.clientID ?? null,
        });
        break;
      }

      // ── Doc existence check ────────────────────────────────────────────
      case 'has-doc': {
        const entry = docs.get(msg.key);
        post({
          type: 'has-doc-response',
          key: msg.key,
          requestId: msg.requestId,
          exists: !!entry,
          synced: !!entry?.provider?.synced,
          wsconnected: !!entry?.provider?.wsconnected,
        });
        break;
      }

      // ── Destruction ────────────────────────────────────────────────────
      case 'destroy-doc': {
        destroyDocInternal(msg.key);
        break;
      }

      case 'destroy-prefix': {
        const toDestroy = [];
        for (const key of docs.keys()) {
          if (key.startsWith(msg.prefix)) toDestroy.push(key);
        }
        for (const key of toDestroy) destroyDocInternal(key);
        post({ type: 'prefix-destroyed', prefix: msg.prefix, count: toDestroy.length });
        break;
      }

      case 'disconnect-all': {
        for (const key of [...docs.keys()]) destroyDocInternal(key);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', key: msg.key, error: err?.message || String(err) });
  }
};

// Signal readiness to the main thread
post({ type: 'ready' });
