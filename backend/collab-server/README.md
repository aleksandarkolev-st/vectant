# Synthi Collaboration Server

REST + WebSocket notification server for the Synthi IDE. Handles file CRUD, git operations, workspace management, terminal proxy, GCS sync, and Y-Sweet CRDT token issuance.

**CRDT document editing** (real-time collaborative text sync) is handled by the
[Y-Sweet](https://github.com/jamsocket/y-sweet) pod — not this server.  Clients
connect to Y-Sweet directly for document WebSocket connections.

Getting started (development):

1. Install dependencies

```powershell
cd backend/collab-server
npm install
```

2. Run the server (defaults to port 1234)

```powershell
npm start
```

Notes:
- Requires a running Y-Sweet instance (default: `http://localhost:8080`). Configure via `YSWEET_URL` env var.
- Uses a local directory for ephemeral git repo cache. Configure via `REPOS_DIR` env var.
- For production, place behind an HTTPS reverse proxy with authentication.
