// Simple smoke test for collab server: connects and attempts to open a room
const WebSocket = require('ws');

const URL = process.env.COLLAB_WS || 'ws://localhost:1234/my-test-room';

const ws = new WebSocket(URL);

ws.on('open', () => {
  console.log('Connected to collab server at', URL);
  // y-websocket exchanges a small hello; we won't speak the protocol directly here, but connection alone asserts the socket is reachable.
  ws.close();
});

ws.on('error', (err) => {
  console.error('Connection error:', err.message || err);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Connection closed (expected)');
  process.exit(0);
});
