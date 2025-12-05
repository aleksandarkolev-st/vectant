Synthi — Collaboration architecture and how it works

Overview

This project now includes first-class collaborative editing support using Yjs (CRDT) and a lightweight y-websocket server for real-time synchronization. Goals:

- Multiple users can open the same workspace and edit files at the same time.
- Edits are merged automatically using CRDT semantics (no locking required for most workflows).
- Presence and cursors are shared via the awareness API.
- Server-side persistence is handled by LevelDB at backend/collab-server/data/collab-leveldb for durability.

Components

1) Collab server (backend/collab-server)
   - y-websocket server listening on port 1234 (configurable via COLLAB_PORT env).
   - Uses LevelDB persistence (y-leveldb) to store Yjs documents across restarts when available; if `y-leveldb` is not present the server will still run using an in-memory persistence fallback (not durable).

2) Client integration (synthi/src/services/collabClient.js)
   - Creates a Y.Doc per workspace file using the naming pattern: `workspace:{slug}:{path}`
   - Connects through the WebsocketProvider to the collab server
   - Provides a safe Monaco <-> Y.Text binding inside `collabClient` to avoid re-entrancy and edit-command exceptions in Monaco.
     This binding is compatible with `y-monaco` but implemented inline to be robust across environments and to prevent the "invalid edit" errors that can appear when remote edits are applied while Monaco is processing view events.
   - Sets awareness state for the local user (id, name, color)

3) Editor wiring
   - Editor will attach the active Monaco editor instance to the collab binding automatically (when loaded) and seed content if empty.
   - Presence indicators appear in the Editor header.

Security & Production Notes

- Authentication: Ensure that the collab server requires clients to authenticate before connecting (e.g., by validating JWTs in the upgrade request or running the collab server behind an authenticated reverse proxy). Unauthenticated write access is unsafe in production.
- Scaling: Consider using a Redis-based persistence or shared awareness when running multiple collab server instances behind a load balancer. y-websocket supports external persistence and message routers.
- Audit / Backup: Persist Yjs documents in a separate DB and export snapshots to allow auditing and backups.

Developer quickstart

1) Start the collab server:

```powershell
cd backend/collab-server
npm install
npm start
```

2) Start the frontend (in a separate terminal):

```powershell
cd synthi
npm install
npm run dev
```

3) Open two browser windows to the same workspace (e.g. http://localhost:3000/workspace/your-slug) and you should be able to collaboratively edit the same file.

Further improvements (recommendations)

- Add authentication checks on the server for WebSocket upgrade requests and include the user's identity in awareness.
- Add richer presence UI: cursor colors, selections, user initials, and an active editors list.
- Add server-side moderation/ACLs to control who can edit vs view workspaces.
- Add end-to-end encryption for very sensitive code bases.
- Add an optional OT fallback for environments that require OT semantics for specific features.

*** End of collaboration notes
