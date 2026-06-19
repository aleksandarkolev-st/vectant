# Path A: VS Code Server Integration Architecture

## Overview

This document describes the **Path A** implementation for running Node-only VS Code extensions: we delegate to a **real VS Code Server** (code-server) that provides a genuine Extension Host with full `vscode.*` API coverage, with `ext-host-preload.js` injected via `NODE_OPTIONS` to wrap the real API and relay UI events back to the browser.

## The Problem

VSIX extensions only run inside VS Code's Extension Host. The `vscode` module is injected by VS Code at runtime — it is **not** a normal Node module. Installing the npm package `vscode` does not fix runtime errors; it only provides typings.

Our previous approach (`remote-ext-host.js`, now deleted) tried to manually shim the `vscode` API, hook `require()`, and eval extension code. This worked for trivial first-party extensions, but broke for real marketplace extensions that rely on:

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
│  manifest.main ───────────► VS CODE SERVER                              │
│  (Node-only)                ├─ Full vscode.* API                         │
│                             ├─ Real Extension Host                       │
│                             ├─ All marketplace extensions                │
│                             ├─ ext-host-preload.js wraps real API        │
│                             └─ Installed as real VSIX                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Architecture

### Backend

```
backend/synthi-webrtc-compiler/worker/
├── vscode-server-manager.js     ← Manages VS Code Server lifecycle
└── ext-host-preload.js          ← Injected into Extension Host via NODE_OPTIONS
```

**vscode-server-manager.js** is a Node.js process spawned by the Rust WebRTC worker. It:

1. **Downloads** the VS Code Server binary (code-server) if not present
2. **Starts** the server per-workspace (unique port per slug)
3. **Installs** VSIX files into the server's extensions directory
4. **Health-checks** the server and auto-restarts on crash
5. **Injects** `ext-host-preload.js` into the Extension Host via `NODE_OPTIONS`
6. **Runs a TCP bridge** for ext-host-preload.js to send events back
7. Communicates via **newline-delimited JSON over stdin/stdout**

The Rust worker spawns it when it receives a DataChannel with label `vscode-server?slug=...`.

### Frontend

```
synthi/src/extensions/bridge/
├── WorkerProxy.js               ← Local web worker proxy
├── VSCodeServerProxy.js         ← Proxy to vscode-server-manager
└── MainThreadBridge.js          ← Two-tier routing (local + server)
```

**VSCodeServerProxy.js** provides:
- JSON-RPC over DataChannel for server lifecycle management
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
│  ├ connectVSCode() │─── DataChannel ──────► │  Worker      │──spawn──► vscode-server-manager.js
│                    │                        │              │               │
│  MainThreadBridge  │                        └──────────────┘               │
│  ├ WorkerProxy     │◄── postMessage ──► Web Worker (hardened)              │
│  └ VSCodeServerPxy │◄── DataChannel ──► vscode-server-manager.js          │
│                    │                           │                           │
│                    │     WebSocket tunnel       │     spawns               │
│                    │◄─── (over DataChannel) ──► VS Code Server ◄──────────┘
│                    │                            (code-server)
└────────────────────┘                            ├── Real Extension Host
                                                  │   └── ext-host-preload.js
                                                  │       └── TCP bridge → manager
                                                  └── Full vscode.* API
```

## Extension Install Flow

### Local (Browser) Extensions
```
VSIX → parseVSIX() → extract browser bundle → load in Web Worker → eval → activate
```

### VS Code Server Extensions (Path A)
```
Marketplace install → parseVSIX() → detect Node-only → installMarketplaceExtensionOnServer(id)
  → vscode-server-manager → code-server --install-extension <id>
  → VS Code Server reloads → Extension Host activates it with full API
  → ext-host-preload.js wraps API and relays events via TCP bridge

Local/private VSIX install → parseVSIX() + preserve original VSIX bytes
  → detect Node-only → installExtensionOnServer(id, vsixBase64)
  → vscode-server-manager writes a temp VSIX and runs code-server --install-extension <file>
  → Extension Host activates it with full API and bridged UI events
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

1. **VS Code Server available** → Full extension support for marketplace IDs and uploaded VSIX bytes
2. **Server unavailable** → Node-only extensions are marked `pending-remote`, while grammars/themes still work locally
3. **Web-only extensions** → Always work in the local Web Worker regardless
4. **Missing install source** → Server-only extensions fail with an actionable reason instead of retrying a bogus marketplace install

## What Changes for Existing Code

### No Breaking Changes
- The existing Web Worker path is untouched
- All existing hooks, Redux state, and components remain compatible
- IndexedDB persistence is unchanged

### Removed (Legacy)
- `remote-ext-host.js` — deleted (shimmed vscode API was fundamentally broken)
- `RemoteExtHostProxy.js` — deleted (browser-side proxy for the old path)
- `ext-host` DataChannel in Rust worker — replaced with deprecation stub
- `createExtHostChannel()` in compilerClient — removed

### New Capabilities
- Real marketplace extensions work out of the box
- No custom vscode API shimming needed for server extensions
- Server-installed extensions get proper dependency resolution
- Extensions see the real filesystem, debugger, etc.

## Next Steps

Implemented:

1. **Rust worker integration** — `vscode-server?slug=...` DataChannel spawning for `vscode-server-manager.js`
2. **WebSocket tunnel** — DataChannel-backed HTTP/WebSocket proxy for code-server assets and sockets
3. **UI integration** — status bar/sidebar state, contribution hydration, tree/webview event forwarding
4. **Preload bridge** — patched Extension Host entrypoints plus TCP bridge for UI/auth/command events

Remaining reliability work:

1. Keep install-source metadata covered by tests for marketplace, uploaded VSIX, and manual code installs.
2. Continue validating real extensions with UI contributions, auth/device-code flows, and large server responses.
3. Treat verbose manager logging as a smoke-test path so diagnostics never crash the server manager.
