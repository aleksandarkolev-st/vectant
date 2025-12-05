const http = require('http');
const WebSocket = require('ws');
// y-websocket exports have changed across versions and some environments do
// not allow accessing internal subpaths via package exports. Try a few
// common locations and fall back with a clear error message.
let setupWSConnection = null;
try {
  setupWSConnection = require('y-websocket/bin/utils.js').setupWSConnection;
  console.log('[Collab] loaded setupWSConnection from y-websocket/bin/utils.js');
} catch (errA) {
  try {
    setupWSConnection = require('y-websocket/dist/bin/utils.cjs').setupWSConnection;
    console.log('[Collab] loaded setupWSConnection from y-websocket/dist/bin/utils.cjs');
  } catch (errB) {
    try {
      // Some versions export helpers from the package root
      setupWSConnection = require('y-websocket').setupWSConnection;
      console.log('[Collab] loaded setupWSConnection from y-websocket (root export)');
    } catch (errC) {
      console.error('[Collab] Unable to load setupWSConnection from y-websocket.');
      console.error('Tried a few locations and failed. Please ensure you have a compatible y-websocket package installed.');
      console.error('Errors (most recent first):', errC?.message || errC, errB?.message || errB, errA?.message || errA);
      process.exit(1);
    }
  }
}
const Y = require('yjs');

// LevelDB persistence is optional — some environments (or registries) may not
// provide a compatible `y-leveldb` binary. Try to load it and fall back to
// an in-memory persistence implementation if it's not available.
let LeveldbPersistence = null;
try {
  LeveldbPersistence = require('y-leveldb').LeveldbPersistence;
  console.log('[Collab] y-leveldb persistence available');
} catch (e) {
  console.warn('[Collab] y-leveldb not available, using in-memory persistence fallback');
}

const PORT = process.env.COLLAB_PORT || 1234;

// Use LevelDB persistence when available, otherwise use an in-memory fallback
let persistence;
if (LeveldbPersistence) {
  persistence = new LeveldbPersistence('./data/collab-leveldb');
} else {
  // Simple in-memory persistence that encodes/decodes Yjs state updates
  class InMemoryPersistence {
    constructor() {
      this.store = new Map();
    }

    async bindState(docName, ydoc) {
      const update = this.store.get(docName);
      if (update) {
        try {
          Y.applyUpdate(ydoc, update);
        } catch (e) {
          console.warn('[Collab] failed to apply stored update for', docName, e?.message || e);
        }
      }
    }

    async writeState(docName, ydoc) {
      try {
        const update = Y.encodeStateAsUpdate(ydoc);
        this.store.set(docName, update);
      } catch (e) {
        console.warn('[Collab] failed to encode state for', docName, e?.message || e);
      }
    }
  }

  persistence = new InMemoryPersistence();
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Synthi collaboration server is running');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  // setupWSConnection handles the y-websocket protocol for a Y.Doc room
  setupWSConnection(ws, req, {
    persistence
  });
});

server.on('upgrade', (request, socket, head) => {
  // We accept all WebSocket connections at any path (room name encoded in path)
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`Collaboration server (y-websocket) listening on port ${PORT}`);
});
