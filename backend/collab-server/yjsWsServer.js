/**
 * yjsWsServer.js — Minimal Yjs WebSocket relay server.
 *
 * Implements the y-websocket sync protocol so multiple browser tabs
 * can collaborate on the same Yjs document via the collab-server.
 * Replaces Y-Sweet's WebSocket endpoint (which isn't available in
 * y-sweet serve 0.9.x).
 */

const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const messageSync = 0;
const messageAwareness = 1;

// Limits to prevent unbounded resource use.  When over MAX_ROOMS, creating a
// new room fails fast rather than allowing an attacker to OOM the server.
// GC_GRACE_MS is the idle period before an empty room's Y.Doc is destroyed.
const MAX_ROOMS = 5000;
const GC_GRACE_MS = 30_000;
// Close code used when rejecting connections because we're at capacity.
const CLOSE_TRY_AGAIN_LATER = 1013;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Set<WebSocket>, gcTimer: any }>} */
const rooms = new Map();

function getRoom(docName, initialContent) {
  let room = rooms.get(docName);
  if (room) {
    // Cancel any pending GC — the room is live again.
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = null;
    }
    return room;
  }

  if (rooms.size >= MAX_ROOMS) {
    // Signal caller to reject — don't silently allow unbounded growth.
    return null;
  }

  const doc = new Y.Doc();
  if (initialContent) {
    doc.getText('monaco').insert(0, initialContent);
  }
  const awareness = new awarenessProtocol.Awareness(doc);

  // Clean up when the last client disconnects
  awareness.on('update', (/** @type {{ added: number[], updated: number[], removed: number[] }} */ changes, _origin) => {
    const changedClients = changes.added.concat(changes.updated).concat(changes.removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
    const msg = encoding.toUint8Array(encoder);
    room.conns.forEach((ws) => {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.send(msg); } catch (_) { /* client may be closing */ }
      }
    });
  });

  room = { doc, awareness, conns: new Set(), gcTimer: null };
  rooms.set(docName, room);
  return room;
}

function destroyRoom(docName) {
  const room = rooms.get(docName);
  if (!room) return;
  try { room.awareness.destroy(); } catch (_) { /* ignore */ }
  try { room.doc.destroy(); } catch (_) { /* ignore */ }
  rooms.delete(docName);
}

/**
 * Handle a new WebSocket connection for a Yjs document room.
 * @param {WebSocket} ws
 * @param {string} docName
 * @param {string} [initialContent] - Optional content to seed newly created rooms from disk
 */
function setupConnection(ws, docName, initialContent = null) {
  const room = getRoom(docName, initialContent);
  if (!room) {
    console.warn(`[YjsWS] Rejected connection for ${docName}: at MAX_ROOMS (${MAX_ROOMS})`);
    try { ws.close(CLOSE_TRY_AGAIN_LATER, 'server_at_capacity'); } catch (_) {}
    return;
  }
  room.conns.add(ws);

  ws.binaryType = 'arraybuffer';

  // Send initial sync step 1
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));

    // Send current awareness states
    const awarenessStates = room.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder2 = encoding.createEncoder();
      encoding.writeVarUint(encoder2, messageAwareness);
      encoding.writeVarUint8Array(encoder2,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys()))
      );
      ws.send(encoding.toUint8Array(encoder2));
    }
  } catch (err) {
    console.error('[YjsWS] Initial sync send failed:', err.message);
    try { ws.close(1011, 'initial_sync_failed'); } catch (_) {}
    return;
  }

  ws.on('message', (data) => {
    try {
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      const decoder = decoding.createDecoder(buf);
      const msgType = decoding.readVarUint(decoder);

      if (msgType === messageSync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, null);
        const reply = encoding.toUint8Array(encoder);
        // If reply has content beyond the message type header, send it
        if (encoding.length(encoder) > 1) {
          ws.send(reply);
        }
        // Broadcast doc updates to other clients (sync step 2 / update)
        if (buf.length > 0) {
          room.conns.forEach((client) => {
            if (client !== ws && client.readyState === 1) {
              try { client.send(buf); } catch (_) { /* ignore */ }
            }
          });
        }
      } else if (msgType === messageAwareness) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(decoder),
          ws
        );
      }
    } catch (err) {
      // Protocol errors are likely from a buggy/hostile client — close the
      // socket so the client is forced to reconnect cleanly rather than
      // staying wedged in an inconsistent state.
      console.error('[YjsWS] Message handling error:', err.message);
      try { ws.close(1002, 'protocol_error'); } catch (_) {}
    }
  });

  ws.on('close', () => {
    room.conns.delete(ws);
    // Remove awareness state for this connection
    try {
      if (room.awareness.states.has(ws)) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [ws], null);
      }
    } catch (_) { /* awareness may have been destroyed by a previous GC cycle */ }

    // GC empty rooms after a grace period.  If a client reconnects before
    // the timer fires, getRoom() cancels it.
    if (room.conns.size === 0 && !room.gcTimer) {
      room.gcTimer = setTimeout(() => {
        const current = rooms.get(docName);
        if (!current) return;
        // Only destroy if still empty AND still the same room object (not
        // replaced by a fresh getRoom() call during the grace window).
        if (current === room && current.conns.size === 0) {
          try { destroyRoom(docName); }
          catch (err) { console.error('[YjsWS] room destroy failed:', err.message); }
        } else {
          room.gcTimer = null;
        }
      }, GC_GRACE_MS);
      if (typeof room.gcTimer.unref === 'function') room.gcTimer.unref();
    }
  });

  ws.on('error', (err) => {
    console.warn('[YjsWS] Socket error on', docName, ':', err.message);
  });
}

/**
 * Return the live 'monaco' text of an open room, or null if no room exists.
 * This is the authoritative editor content (the frontend syncs here via
 * y-websocket), so disk-flush paths must read from here — NOT Y-Sweet, which
 * is not in the editor's sync path.
 */
function getRoomText(docName) {
  const room = rooms.get(docName);
  if (!room) return null;
  try { return room.doc.getText('monaco').toString(); }
  catch (_) { return null; }
}

/** Doc names of all currently-open rooms (live/connected editor docs). */
function listRoomNames() {
  return [...rooms.keys()];
}

module.exports = { setupConnection, MAX_ROOMS, getRoomText, listRoomNames };
