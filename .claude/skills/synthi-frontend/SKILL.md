---
name: synthi-frontend
description: 'Use when working on the Synthi frontend (Next.js web IDE at synthi/): Monaco/editor, Yjs collab, WebRTC compile signaling, AI chat/gateway, healing flows, Redux state, docking window manager, git UI, terminal, emulator, NextAuth, Prisma, Next.js API routes.'
argument-hint: 'Describe the frontend task, component, or failure you want to work on.'
user-invocable: true
disable-model-invocation: false
---

# Synthi Frontend

Skill for the Next.js web IDE at `synthi/`. Use this when the task touches the editor shell, file tree, collab, chat, AI healing, compiler signaling, previews, git UI, auth, or any Next.js API route.

## When to Use

- Any change under `synthi/` (the frontend is ONE Next.js app; there is no alternate frontend)
- Editor shell, file tree, tabs, command palette, docking panels
- CRDT / Yjs collab, Y-Sweet wiring, awareness cursors
- AI chat UI, analyzer gateway WebSocket, AI healing suggestions
- Compile status, HMR indicator, compiler manifest polling
- Terminal (xterm.js), emulator preview, git UI
- NextAuth + Prisma, `synthi/src/app/api/**` routes

## Stack (pin these before guessing)

- Next.js 15 (App Router) with Turbopack dev, webpack build (`next.config.mjs`)
- React 19, Redux Toolkit (single store, slice-per-feature)
- Monaco via `@codingame/monaco-vscode-editor-api` + `monaco-languageclient` for LSP
- Yjs 13 + `y-websocket` over a CRDT web worker (`workers/collab-crdt.worker.js`)
- `next-auth` v4 (Google + GitHub), Prisma 6 on Postgres
- TailwindCSS 4, Radix UI, Sonner
- xterm.js 5 for the terminal pane

Entry: `synthi/src/app/workspace/[slug]/page.jsx` is the IDE shell. `synthi/src/app/page.jsx` is login/dashboard.

## Directory Map (synthi/src/)

- `app/` — Next.js App Router. Pages + `api/` route handlers.
- `components/` — Feature components (see table below).
- `hooks/` — 40+ custom hooks. Collab, AI, compiler, extensions, analytics.
- `redux/` — Store + slices. Single source of truth for UI state.
- `services/` — Long-lived clients to backend (collab, compile, analyzer gateway, git, PR).
- `workers/` — Dedicated Web Workers (CRDT worker lives here).
- `lib/` — Pure utilities (theme engine, hmr-runtime, diagnostics normalizer).
- `extensions/` — In-app extension system (manifest loader + sandbox).
- `themes/` — Builtin color-scheme JSON.
- `server/` — Server-only auth helpers.
- `utils/` — Misc helpers.

Top-level `synthi/prisma/` — Prisma schema (Postgres). Minimal: `User`, `Workspace`, many-to-many via `UserWorkspaces`. No file-content storage in DB — workspace state lives in Y-Sweet + git repos on collab-server.

## Subsystem Cheat-Sheet

Go here first when the task mentions:

| Subsystem | Authoritative files |
|-----------|---------------------|
| IDE shell + layout | `app/workspace/[slug]/page.jsx`, `components/docking-wm/` |
| File tree / tabs / active file | `redux/workspaceSlice.js`, `app/workspace/[slug]/FileTree.jsx` |
| Monaco editor | `app/workspace/[slug]/Editor/Editor.jsx` + `services/MonacoSocketAdapter.js` |
| CRDT collab (live) | `services/collabClient.js` → `services/crdtWorkerBridge.js` → `workers/collab-crdt.worker.js` |
| Y-Sweet session + tokens | `services/collabSessionService.js` |
| Compile / WebRTC signaling | `services/compilerClient.js`, `hooks/useCompiler.js`, `hooks/useCompileManifestListener.js` |
| AI chat UI | `components/chat/AIChatWindow.jsx`, `hooks/useAnalyzerGateway.js` |
| AI gateway transport | `services/analyzerGatewayClient.js` (WS to `ai-gateway:7070/ws`) |
| AI healing (all entry points) | `hooks/useAIHealing.js`, `hooks/useProactiveAnalysis.js`, `services/preCompileHealer.js`, `services/runtimeErrorInterceptor.js`, `redux/healingSlice.js` |
| Terminal | `app/workspace/TerminalPane.jsx`, `app/workspace/TerminalManager.jsx` |
| Git UI (big) | `components/git/GitStatus.jsx` (huge), `services/gitClient.js`, `redux/gitSlice.js` |
| PR UI | `components/git/PRDetail.jsx`, `services/prClient.js`, `redux/prSlice.js` |
| Emulator preview | `components/emulator/*` + `uiSlice.showEmulatorPreview` |
| Auth | `src/app/auth.js`, `src/app/api/auth/[...nextauth]`, `src/app/SessionProvider.jsx` |
| Themes | `redux/themeSlice.js`, `lib/theme-engine.js`, `themes/*.json` |

## Redux Slices

Single store at `redux/store.js`. Reducer keys and source files:

| State key | Slice file |
|-----------|-----------|
| `workspace` | `redux/workspaceSlice.js` — files tree, open tabs, active file, dirty markers, save thunks |
| `ui` | `redux/uiSlice.js` — terminal open, emulator visible, tree orientation, focus, auto-save/auto-complete |
| `git` | `redux/gitSlice.js` — branch, status, staged/unstaged, merge state |
| `pr` | `redux/prSlice.js` — pull requests, reviews, comments |
| `healing` | `redux/healingSlice.js` — AI suggestions, pending fixes, config, confirmation toggle |
| `extensions` | `redux/extensionSlice.js` — loaded extensions, debug mode |
| `theme` | `redux/themeSlice.js` — active + custom themes, user overrides |
| `compileManifest` | `redux/compileManifestSlice.js` — compile progress, manifest timestamps |
| `layout` | `components/docking-wm/state/layout-slice.js` — docking-wm panels, sizes (lives under the feature dir, not under `redux/`) |

UI prefs are hydrated from `localStorage` keys `synthi:ui`, `synthi:openTabs:${slug}`, `synthi:activeTab:${slug}` via `loadUiPrefs()`. `showEmulatorPreview` is intentionally scrubbed — do not persist it.

## Backend Wiring (env vars)

Public (browser-visible, default shown for local compose):

- `NEXT_PUBLIC_COLLAB_SERVER_URL` — collab-server HTTP (`http://localhost:1234`)
- `NEXT_PUBLIC_COLLAB_PORT` — `1234`
- `NEXT_PUBLIC_YSWEET_URL` — Y-Sweet REST (`http://localhost:8180` externally, `http://y-sweet:8080` inside compose)
- `NEXT_PUBLIC_COMPILE_SIGNAL_URL` — signaling WS (`ws://localhost:9000`)
- `NEXT_PUBLIC_GATEWAY_WS_URL` — AI gateway WS (`ws://localhost:7070/ws`)
- `NEXT_PUBLIC_TERMINAL_URL` — terminal WS (falls back to collab-server)
- `NEXT_PUBLIC_CODE_INTEL_URL` — AI engine direct (optional)
- `NEXT_PUBLIC_ICE_SERVERS` — JSON STUN/TURN list
- `NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER` — toggles ephemeral worker

Server-only (used in API routes):

- `COLLAB_SERVER_URL` — internal URL for `/api/chat`, `/api/agent`
- `DATABASE_URL` — Prisma → Postgres
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_ID` / `GITHUB_SECRET`, `NEXTAUTH_SECRET`

Browser connects to: Y-Sweet (REST for token), collab-server (WS for yjs relay + HTTP for files/git/terminal), signaling-server (WS for WebRTC), ai-gateway (WS for AI actions). It does NOT hit ai-engine directly in normal flows.

## Next.js API Routes (synthi/src/app/api/)

- `auth/[...nextauth]` — NextAuth callbacks.
- `chat/` — AI chat streaming (reads `COLLAB_SERVER_URL`).
- `agent/` — Agent runner (reads `COLLAB_SERVER_URL`).
- `completion/` — inline code completion.
- `format/` — code formatting.
- `workspace/[workspaceId]/` — workspace metadata via Prisma.
- `github/` — OAuth token exchange, PR operations, GitHub API proxying.
- `extensions/` — extension manifest fetching.
- `turn-credentials/` — issues Cloudflare TURN tokens for WebRTC.
- `theme-generate/` — LLM-generated theme endpoint.

Rule of thumb: if the frontend needs a server secret, it goes through one of these routes. Anything that can use only a WS/HTTP backend with a session token goes direct from the browser.

## Critical Gotchas (read before editing)

1. **Monaco single-instance is non-negotiable.** `next.config.mjs` aliases `monaco-editor` → `@codingame/monaco-vscode-editor-api` on BOTH the Turbopack and webpack sides. If LSP (hover, go-to-def, completions) breaks, check alias drift first. Never add a bare `import * from 'monaco-editor'` that bypasses the alias.

2. **Yjs single-instance is non-negotiable.** Two Yjs copies = silent awareness + delta corruption. The webpack + turbopack configs also dedupe `yjs`.

3. **CRDT runs in a worker.** `collabClient.js` does NOT own a `Y.Doc` on the main thread. Local edits are sent to `workers/collab-crdt.worker.js` as offset-based ops via `crdtWorkerBridge`. Remote deltas come back and are applied to Monaco's text model. If you're "fixing" by touching the main-thread doc, you're in the wrong file.

4. **COEP: credentialless** is required for `SharedArrayBuffer` inside the worker. Next middleware/headers in `next.config.mjs` set this. If the worker silently fails, check COEP/COOP headers.

5. **`GitStatus.jsx` is enormous** (kitchen-sink for status/stage/diff/conflict). Any edit here risks regressions across the whole git UI — make the smallest possible change.

6. **Healing has four entry points**, all feed `healingSlice`:
   - proactive background → `useProactiveAnalysis`
   - runtime errors → `runtimeErrorInterceptor`
   - pre-compile → `preCompileHealer`
   - manual (Ctrl+K) → `useAIHealing`
   Don't add a fifth — extend one.

7. **Compile manifest pipeline is currently dormant on the worker side.** `useCompileManifestListener` subscribes to `synthi:compile-manifest` CustomEvents on `window` and dispatches into `compileManifestSlice`. The frontend side is fully wired — StatusBar pill, CompileErrorCard, ConfidenceWarning all read this slice. **But the Rust worker does not yet emit the event**, so the slice stays at its initial null state by design. If you're "fixing" manifest UI, first check whether the worker is emitting; otherwise your fix is in the wrong layer.

8. **`output: 'standalone'`** in `next.config.mjs` — production build emits `.next/standalone/` with a minimal `node_modules`. Do not rely on devDependencies at runtime.

9. **No Zustand / Context for app state** — it's all Redux. If you see a prop-drilled setter, it's almost certainly wrong and there's already a slice for it.

10. **Two docking systems are in use, not one.** `components/docking-wm/` is the newer window-manager family. `components/docking/` is also live — `app/workspace/[slug]/page.jsx` imports `DockablePanel`, `DockablePanelProvider`, `PANEL_STATE`, `DOCK_POSITION` from it. `components/dock/` is older still. Before extending docking behaviour, trace which family the surface actually uses; don't assume the new one is the only one.

## Typical Failure Modes

- "Editor won't load" → Monaco alias drift, or the model got detached by a rogue Yjs delta. Check browser console for `require` resolving `monaco-editor` directly.
- "Cursors / edits don't sync" → worker crashed (check devtools → Workers tab), Y-Sweet token expired, or `NEXT_PUBLIC_YSWEET_URL` is wrong for environment.
- "Chat returns error immediately" → gateway WS didn't connect, or ai-engine missing `GEMINI_API_KEY`. See `synthi-ai-backend` skill.
- "Compile never finishes" → signaling WS URL wrong, or worker not spawned by collab-server. See `synthi-backend` skill.
- "Auth loops" → `NEXTAUTH_SECRET` missing, or OAuth callback URL mismatch with provider config.
- "Prisma error in API route" → `DATABASE_URL` not set; API route crashes before handler runs.

## Scripts

- `npm run dev` — `next dev --turbopack`
- `npm run build` — node polyfill bundling, then `next build` (webpack)
- `npm run start` — `next start` (prod)
- `npm run lint` — ESLint (non-blocking at build time)

## What Good Output Looks Like

For frontend tasks, the answer should typically name:

- the slice that owns the state (or a reason a new slice is needed)
- the service / hook that owns the transport
- which backend URL env var is involved, if any
- which Next.js API route handles the secret-bearing side, if any
- the smallest file to change (avoid `GitStatus.jsx` if you can)

Do not propose fixes that add a second Monaco, a second Yjs, or a second CRDT authority.
