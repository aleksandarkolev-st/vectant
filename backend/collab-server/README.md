# Synthi Collaboration Server

This directory contains a small y-websocket-based collaboration server used by the Synthi IDE to synchronize file contents in real-time among multiple clients.

Getting started (development):

1. Install dependencies

```powershell
cd backend/collab-server
# If you encounter peer dependency errors with npm v7+/v8+ use:
# npm install --legacy-peer-deps
# or explicitly install compatible yjs version declared in package.json
npm install
```

2. Run the server (defaults to port 1234)

```powershell
npm start
```

Notes:
- The server prefers LevelDB persistence (y-leveldb) at ./data/collab-leveldb to persist Yjs documents across restarts, but it is optional.
- If the `y-leveldb` package isn't available on your platform/registry, the server will fall back to an in-memory persistence (non-persistent) so the server still runs. For production you should install and enable `y-leveldb` or configure another persistence layer.
- For production, place this behind a robust HTTP(S) reverse proxy, secure with authentication, and use a persistent, backed store.
