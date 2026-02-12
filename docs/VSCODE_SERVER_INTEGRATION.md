# Path A: VS Code Server Integration Architecture

## Overview

This document describes the **Path A** implementation for running Node-only VS Code extensions: instead of executing VSIX code through a custom shimmed Node.js host (`remote-ext-host.js`), we delegate to a **real VS Code Server** (code-server) that provides a genuine Extension Host with full `vscode.*` API coverage.

## The Problem

VSIX extensions only run inside VS Code's Extension Host. The `vscode` module is injected by VS Code at runtime — it is **not** a normal Node module. Installing the npm package `vscode` does not fix runtime errors; it only provides typings.

Our previous approach (`remote-ext-host.js`) tried to manually shim the `vscode` API, hook `require()`, and eval extension code. This works for trivial first-party extensions, but breaks for real marketplace extensions that rely on:

- Deep API surfaces (`vscode.debug`, `vscode.tasks`, `vscode.scm`, etc.)
- The real Extension Host Protocol (typed binary RPC)
- Extension dependency resolution
- Proper source maps, `__dirname`, relative paths

## Three-Tier Extension Hosting

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Extension Routing                                │
│                                                                          │
│  manifest.browser ────────► LOCAL WEB WORKER (hardened)                  │
│  exists?                    ├─ Syntax highlighting, themes               │
│                             ├─ Simple commands                           │
│                             └─ Lightweight web extensions                │
│                                                                          │
│  manifest.main ───────────► VS CODE SERVER (preferred)  ← Path A        │
│  (Node-only)                ├─ Full vscode.* API                         │
│                             ├─ Real Extension Host                       │
│                             ├─ All marketplace extensions                │
│                             └─ Installed as real VSIX                    │
│                                                                          │
│  (fallback) ──────────────► CUSTOM REMOTE HOST (legacy)  ← Path C       │
│                             ├─ Shimmed vscode API                        │
│                             ├─ First-party extensions only               │
│                             └─ Falls back if server unavailable          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Architecture

### Backend

```
backend/synthi-webrtc-compiler/worker/
├── remote-ext-host.js           ← Legacy custom host (still used as fallback)
└── vscode-server-manager.js     ← NEW: manages VS Code Server lifecycle
```

**vscode-server-manager.js** is a Node.js process spawned by the Rust WebRTC worker. It:

1. **Downloads** the VS Code Server binary (code-server) if not present
2. **Starts** the server per-workspace (unique port per slug)
3. **Installs** VSIX files into the server's extensions directory
4. **Health-checks** the server and auto-restarts on crash
5. Communicates via **newline-delimited JSON over stdin/stdout** (same protocol as remote-ext-host.js)

The Rust worker spawns it when it receives a DataChannel with label `vscode-server?slug=...`.

### Frontend

```
synthi/src/extensions/bridge/
├── WorkerProxy.js               ← Local web worker proxy (unchanged)
├── RemoteExtHostProxy.js        ← Legacy custom remote host proxy (unchanged)
├── VSCodeServerProxy.js         ← NEW: proxy to vscode-server-manager
└── MainThreadBridge.js          ← UPDATED: three-tier routing
```

**VSCodeServerProxy.js** provides:
- JSON-RPC over DataChannel (same interface as RemoteExtHostProxy)
- Server lifecycle management (start/stop)
- VSIX installation (marketplace ID or base64 data)
- Server connection info (for WebSocket tunnel to real Extension Host)
- Event subscription (server status, install events)

**MainThreadBridge** additions:
- `connectVSCodeServer(channel)` — connect to the server manager
- `startVSCodeServer(slug)` — start the server for a workspace
- `installExtensionOnServer(id, vsixBase64)` — install VSIX
- `installMarketplaceExtensionOnServer(id)` — install from marketplace
- `getExtensionHostTarget(manifest)` — routing decision logic
- `getVSCodeServerConnectionInfo()` — get WebSocket URL

**useExtensions hook** additions:
- Automatically connects to VS Code Server on WebRTC connection
- Starts server for the current workspace
- Routes Node-only extensions to server instead of custom host
- Falls back gracefully if server is unavailable
- Exposes `vscodeServerState`, `installOnVSCodeServer()`, `getVSCodeServerInfo()`

## Communication Flow

```
                          Browser                    Rust Worker              Backend
┌────────────────────┐                        ┌──────────────┐
│  useExtensions()   │                        │              │
│  ├ initSystem()    │                        │  WebRTC      │
│  ├ connectRemote() │─── DataChannel ──────► │  Worker      │──spawn──► remote-ext-host.js
│  └ connectVSCode() │─── DataChannel ──────► │              │──spawn──► vscode-server-manager.js
│                    │                        │              │               │
│  MainThreadBridge  │                        └──────────────┘               │
│  ├ WorkerProxy     │◄── postMessage ──► Web Worker (hardened)              │
│  ├ RemoteExtProxy  │◄── DataChannel ──► remote-ext-host.js                │
│  └ VSCodeServerPxy │◄── DataChannel ──► vscode-server-manager.js          │
│                    │                           │                           │
│                    │     WebSocket tunnel       │     spawns               │
│                    │◄─── (over DataChannel) ──► VS Code Server ◄──────────┘
│                    │                            (code-server)
└────────────────────┘                            └── Real Extension Host
                                                      └── Full vscode.* API
```

## Extension Install Flow

### Local (Browser) Extensions
```
VSIX → parseVSIX() → extract browser bundle → load in Web Worker → eval → activate
```

### VS Code Server Extensions (Path A — preferred for Node-only)
```
VSIX → parseVSIX() → detect Node-only → installMarketplaceExtensionOnServer(id)
  → vscode-server-manager → code-server --install-extension <id>
  → VS Code Server reloads → Extension Host activates it with full API
```

### Custom Remote Host Extensions (Legacy fallback)
```
VSIX → parseVSIX() → extract Node code → loadExtension on remote-ext-host.js
  → write to /tmp → require() with shimmed vscode → activate (limited API)
```

## Configuration

Environment variables for the backend:

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNTHI_VSCODE_SERVER_DIR` | `~/.synthi/vscode-server` | Root directory for server binary and data |
| `SYNTHI_VSCODE_SERVER_BIN` | (auto-detected) | Explicit path to code-server binary |
| `SYNTHI_VSCODE_SERVER_VERSION` | `stable` | Server version to download |
| `SYNTHI_VSCODE_PORT_START` | `18000` | Port range start for dynamic allocation |
| `SYNTHI_VSCODE_PORT_END` | `18999` | Port range end |

## Fallback Strategy

The system degrades gracefully:

1. **VS Code Server available** → Full extension support, marketplace install
2. **Only custom remote host** → Limited shimmed API, first-party extensions
3. **Neither available** → Extensions marked `pending-remote`, grammars/themes still work locally
4. **Web-only extensions** → Always work in the local Web Worker regardless

## What Changes for Existing Code

### No Breaking Changes
- The existing Web Worker path is untouched
- The existing remote-ext-host.js path still works as a fallback
- All existing hooks, Redux state, and components remain compatible
- IndexedDB persistence is unchanged

### New Capabilities
- Real marketplace extensions work out of the box
- No custom vscode API shimming needed for server extensions
- Server-installed extensions get proper dependency resolution
- Extensions see the real filesystem, debugger, etc.

## Next Steps

1. **Rust worker integration** — Add `vscode-server` DataChannel label handling to spawn the manager
2. **WebSocket tunnel** — Implement DataChannel↔TCP bridging in Rust for the Extension Host Protocol
3. **UI integration** — Add VS Code Server status to the extension panel
4. **Testing** — Install real marketplace extensions (ESLint, Prettier, GitLens) and verify
