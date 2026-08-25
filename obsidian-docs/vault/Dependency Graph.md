# Dependency Graph

> Logical dependencies between systems, grounded in the source analyses (see each note's "Logical dependencies" section). File-level references in the per-system notes.

## Adjacency matrix (who initiates contact)

| From ↓ / To → | frontend | collab | y-sweet | signaling | worker | ai-engine | gateway | mcp | postgres | redis |
|---|---|---|---|---|---|---|---|---|---|---|
| **Synthi Frontend** | — | ✔ ws | ✔ (Yjs) | ✔ ws SDP | ✔ WebRTC | via gateway | ✔ ws | ✔ REST (codesite/integrations) | ✔ Prisma | — |
| **Collab Server** | ✔ SSE/ws | — | ✔ SDK | ✔ webhook recv | manages lifecycle | — | — | — | indirect* | ? |
| **y-sweet** | ✔ ws | ✔ API | — | — | — | — | — | — | — | — |
| **Signaling** | ✔ ws | ✔ webhook out | — | — | ✔ ws | — | — | ✔ ws | — | ✔ pub/sub |
| **WebRTC Worker** | ✔ media+DC | — | — | ✔ register | — | ✔ HTTP refactor APIs | — | ✔ DCs | — | — |
| **AI Engine** | — | — | — | — | serves worker | — | served by gw | — | — | — |
| **AI Gateway** | serves FE ws | — | — | — | — | ✔ HTTP proxy | — | — | — | — |
| **synthi-mcp** | ✔ REST | — | — | ✔ ws | ✔ DCs | — | — | — | optional (dojo) | — |
| **agent-runner** | — | spawned pods? | — | — | — | spawned by AE | — | as MCP client | — | — |

\* collab-server persistence is leveldb + filesystem; postgres is owned by the frontend app. Confirm exact edges in [[Collab Server]].

## Per-system logical deps (condensed)

### Synthi Frontend ([[Synthi Frontend]])
- **Owns**: Postgres schema (56 models), auth (next-auth), BFF API routes (~25 domains).
- **Depends on**: collab-server (`NEXT_PUBLIC_COLLAB_SERVER_URL`), y-sweet for buffers, signaling for streams, ai-gateway/ai-engine for AI, `@synthi/mcp-hub` workspace package, Gemini direct (`@google/genai`).
- **Depended on by**: humans; oauth-relay extension posts back to `/api/oauth-relay/callback`.

### Collab Server ([[Collab Server]])
- **Owns**: session/workspace lifecycle, terminals, git service, codesite control-plane guards, leveldb persistence, CRDT relay glue.
- **Depends on**: docker/k8s runtime (spawning runtime containers), y-sweet SDK, filesystem.
- **Depended on by**: frontend (all IDE traffic), signaling-server (session-ended webhook).

### AI Engine ([[AI Engine]])
- **Owns**: ~166 HTTP routes: split/diff-patch/heal/verify pipeline, code_intel, analyzer/healing, shadow genome runs.
- **Depends on**: LLM providers (via env: `SYNTHI_SPLIT_PROVIDER`, OpenRouter-compatible base URLs), docker socket for agent-runner capsules.
- **Depended on by**: Rust worker (primary client), ai-gateway (edge), MCP tools indirectly.

### synthi-mcp ([[MCP Synthi]])
- **Outbound**: signaling server (register/presence/TURN minting), worker datachannels (build-log/terminal/compile), Anthropic/Gemini/local vision APIs, frontend REST (`SYNTHI_API_URL` + PAT) for external tool resolution + audit, CodeSite API, optional Postgres (dojo evidence ledger), CDP browser runtimes, external MCP servers via `@synthi/mcp-hub`.
- **Inbound**: agent hosts (stdio/HTTP+bearer), IDE browser-workflow bridge, operator bridge UI, Prometheus scraper.

### Rust Systems ([[Rust Systems]])
- WebRTC compiler worker ⟶ signaling (registration), ai-engine (refactor/split/heal calls), browser (media + datachannels); GStreamer-based.
- Local Support app ⟶ Vectant support session (mediated, read-only); the trust surface from `PRODUCT.md`.
- signaling-server ⟶ redis pub/sub (multi-pod), coturn for relays.

### Packages & extensions ([[Supporting Services]])
- `atomic-orchestrator` ← imported by synthi agent-routing libs.
- `mcp-hub` ← synthi API routes + synthi-mcp (SSRF-guarded external MCP proxy).
- `programs-mcp` ← stdio MCP server registered via repo `.mcp.json` ("vectant-programs").
- `oauth-relay` extension ⟶ POSTs OAuth callbacks to synthi.

## Startup order (compose, simplified)

postgres → redis → y-sweet → signaling (+coturn) → collab-server → frontend(+migrate) → ai-engine → ai-gateway → mcp.
Worker/agent images are build stages (`runtime-image`, `agent-runner-image`). Details + healthchecks: [[Infra Deployment]] · [[Environments and Ports]].

## Failure coupling (observed live)

- Worker DNS crash-loop ⇒ signaling-server died first (upstream dependency).
- Frontend CSP injects collab origin — mis-set `NEXT_PUBLIC_COLLAB_SERVER_URL` breaks LSP/buffers, not just panels.
- ai-engine 503s propagate to split/heal flows but NOT to plain editing (degraded, not blocked) — by design: local authority stays with the user's machine ([[Dojo Codesite Local Support]]).

[[00 Home|🏠 Back to Home]]
