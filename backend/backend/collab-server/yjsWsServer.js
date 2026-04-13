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

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Set<WebSocket> }>} */
const rooms = new Map();

function getRoom(docName, initialContent) {
  let room = rooms.get(docName);
  if (room) return room;

  const doc = new Y.Doc();
  if (initialContent) {
    doc.getText('monaco').insert(0, initialContent);
  }
  const awareness = new awarenessProtocol.Awareness(doc);

  // Clean up when the last client disconnects
  awareness.on('update', (/** @type {{ added: number[], updated: number[], removed: number[] }} */ changes, origin) => {
    const changedClients = changes.added.concat(changes.updated).concat(changes.removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
    const msg = encoding.toUint8Array(encoder);
    room.conns.forEach((ws) => {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    });
  });

  room = { doc, awareness, conns: new Set() };
  rooms.set(docName, room);
  return room;
}

/**
 * Handle a new WebSocket connection for a Yjs document room.
 * @param {WebSocket} ws
 * @param {string} docName
 * @param {string} [initialContent] - Optional content to seed newly created rooms from disk
 */
function setupConnection(ws, docName, initialContent = null) {
  const room = getRoom(docName, initialContent);
  room.conns.add(ws);

  ws.binaryType = 'arraybuffer';

  // Send initial sync step 1
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
              client.send(buf);
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
      console.error('[YjsWS] Message handling error:', err.message);
    }
  });

  ws.on('close', () => {
    room.conns.delete(ws);
    // Remove awareness state for this connection
    if (room.awareness.states.has(ws)) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [ws], null);
    }
    // GC empty rooms after a delay
    if (room.conns.size === 0) {
      setTimeout(() => {
        if (room.conns.size === 0) {
          room.doc.destroy();
          rooms.delete(docName);
        }
      }, 30000);
    }
  });
}

module.exports = { setupConnection };
