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
        if (ev.code === 4000) {
          post({ type: 'doc-invalidated', key });
          // Destroy BEFORE the provider can schedule a reconnect so it sees
          // shouldConnect === false and aborts.
          destroyDocInternal(key);
        } else if (ev.code !== 1000) {
          // Non-clean close (network blip, ping timeout, etc.)
          post({ type: 'seed-reset', key });
          const entry = docs.get(key);
          if (entry) entry.seeded = false;
        }
      });
    }
  };
}

function ensureDocInternal(key, params) {
  if (docs.has(key)) return docs.get(key);

  const doc = new Y.Doc();
  const provider = new WebsocketProvider(serverUrl, key, doc, {
    connect: true,
    params: params || {},
    WebSocketPolyfill: makeInvalidationAwareWS(key),
  });
  const ytext = doc.getText('monaco');
  const entry = { doc, provider, ytext, applyingLocal: false, seeded: false };

  // ── Y.Text observer — only forward REMOTE deltas to the main thread ──
  ytext.observe((event) => {
    if (entry.applyingLocal) return; // local edits already came FROM main thread
    const delta = event.delta;
    if (!delta || delta.length === 0) return;
    const fullText = ytext.toString();
    post({ type: 'remote-delta', key, delta, fullText, length: fullText.length });
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
  }

  docs.set(key, entry);
  return entry;
}

function destroyDocInternal(key) {
  const entry = docs.get(key);
  if (!entry) return;
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
        post({
          type: 'doc-ready',
          key: msg.key,
          synced: !!entry.provider.synced,
          content: entry.ytext.toString(),
          length: entry.ytext.length,
          wsconnected: !!entry.provider.wsconnected,
        });
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
        entry.provider.awareness.setLocalState(msg.state);
        break;
      }

      case 'set-awareness-field': {
        const entry = docs.get(msg.key);
        if (!entry?.provider?.awareness) return;
        entry.provider.awareness.setLocalStateField(msg.field, msg.value);
        break;
      }

      case 'clear-awareness': {
        const entry = docs.get(msg.key);
        if (!entry?.provider?.awareness) return;
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
