# Glossary

Terms used across Vectant ADE. Each entry links the system that owns it.

## Product & trust

- **Vectant Local Support** — the product: a read-only, session-scoped, workspace-scoped bridge between one local dev environment and one Vectant support session. Local app stays final authority. See [[Dojo Codesite Local Support]], `PRODUCT.md`.
- **Synthi** — the AI development environment (the Next.js app and, broadly, the whole platform). See [[Synthi Frontend]].
- **Fail closed** — design principle #4: missing/stale/invalid state ⇒ safe denial with zero bytes sent plus a local event. Applies to every boundary check ([[Collab Server]] codesite guards, [[MCP Synthi]] security/, [[Rust Systems]] local-support).
- **Proof, not reassurance** — design principle #1: every consequential state exposes real source/actor/scope/decision/outcome. Drives the proof-ledger culture (see [[GPU HMR System]]).

## Sessions & workspaces

- **Collab session** — one collaboration between a human and (optionally) agents, managed by [[Collab Server]] (`SessionManager.js`, `sessionLifecycle.js`).
- **Workspace** — a scoped project directory mounted into a runtime container; lifecycle in `workspaceManager.js` + `workspacePodSpawner.js`.
- **Runtime container / runtime pod** — where code runs; spec'd by `runtimePodSpec.js`, filesystem via `runtimeFilesystem.js`.
- **y-sweet** — Yjs CRDT document server backing collaborative buffers; bridged by `ySweetBridge.js`/`yjsWsServer.js`. See [[Supporting Services]].

## Agents

- **MCP** — Model Context Protocol; agents reach tools through [[MCP Synthi]].
- **Agent session attach** — filing an execution plan on `agent-sessions/:id/execution-plans`; channels may auto-open only in direct-preferred mode. See [[Dojo Codesite Local Support]].
- **Agent runner** — containerized agent execution image (`ai-backend/agent-runner`). See [[Supporting Services]].
- **Dojo** — agent training/vivarium environment with release gates. See [[Dojo Codesite Local Support]].
- **Codesite** — governed agent construction area with boundaries (ActiveBoundary), trust levels (ControlPlaneTrust), host-write sentinel, quarantine. See [[Dojo Codesite Local Support]].

## GPU HMR

- **GPU HMR** — Hot Module Reload for GPU compute: swap changed kernels into a *running* process without restart. See [[GPU HMR System]].
- **Deterministic split** — zero-LLM static split of shader/compute sources into reloadable units (sidecar approach that succeeded on gfx1201).
- **Sidecar / hold-alive runner** — companion process keeping device/context alive so modules can hot-swap in-process.
- **gfx1201** — AMD RDNA4 device (RX 9070 XT) — the validated target.
- **Proof ledger** — append-only record of visual before/after/diff evidence per validation run.

## Infra

- **signaling-server** — WebRTC signaling (Rust) for browser↔runtime streams. See [[Rust Systems]].
- **coturn** — TURN/STUN relay for NAT traversal in compose stack.
- **AI gateway** — Node proxy in front of LLM providers (`ai-backend/gateway`). See [[Supporting Services]].
- **Shadow runs** — non-user-facing continuous agent/codegen runs (`shadow_continuous` in ai-engine + collab producer). See [[AI Engine]].

## Related

[[00 Home|🏠 Home]]
