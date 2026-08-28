# Architecture Overview

> One-page map of vectant-ade: what each system is, how they connect, and where truth lives.
> Deep dives: [[Synthi Frontend]] · [[Collab Server]] · [[AI Engine]] · [[MCP Synthi]] · [[Rust Systems]] · [[GPU HMR System]] · [[Dojo Codesite Local Support]] · [[Supporting Services]] · [[Infra Deployment]]

## The product in one paragraph

**Vectant ADE ("Synthi")** is a cloud AI development environment: a Next.js 15 IDE where humans and AI agents co-edit code in real time inside containerized workspaces. Its flagship capability is **GPU hot-module-reload** — swapping edited GPU compute modules into *running* processes without restart (validated on AMD RX 9070 XT). Around it sits a trust infrastructure: **CodeSite** governance for agents, a **Dojo** training vivarium with release gates, **mediated agent channels**, and the read-only, session-scoped **Local Support** bridge. Design law per `PRODUCT.md`: *show proof, not reassurance; fail closed.*

## Systems at a glance

```mermaid
flowchart LR
    subgraph Browser
        FE["Synthi Frontend<br/>Next.js 15 :3000"]
    end
    subgraph Control plane
        CS["Collab Server<br/>Node :1234"]
        YS["y-sweet :8180<br/>(CRDT store)"]
    end
    subgraph Media path
        SIG["signaling-server :9000<br/>(Rust)"]
        COT["coturn"]
        WRK["WebRTC Worker<br/>(Rust + GStreamer)"]
    end
    subgraph AI
        GW["ai-gateway :7071<br/>(WS⇄HTTP edge)"]
        AE["ai-engine :8000<br/>(Python)"]
        RUN["agent-runner<br/>(disposable container)"]
    end
    subgraph Agents
        AGT["Agent hosts<br/>(Claude Code/Codex/MCP clients)"]
        MCP["synthi-mcp<br/>(TypeScript MCP server)"]
    end
    PG[("postgres")]
    RD[("redis")]

    FE -->|"ws (buffers, terminal, git)"| CS
    CS -->|REST @y-sweet/sdk| YS
    CS <-- "webhook: session-ended"| SIG
    SIG --- RD
    FE -->|ws SDP/ICE| SIG
    SIG <-->|presence, TURN minting| MCP
    WRK <-->|WebRTC media + datachannels| FE
    FE -->|ws| GW --> AE
    AE -->|docker run| RUN
    WRK -->|"HTTP: /refactor/split,<br/>diff_patch, heal"| AE
    AGT <-->|stdio / HTTP| MCP
    MCP -->|codesite REST| FE
```

## Where truth lives

| Concern | Source of truth | Owner |
|---|---|---|
| Users, auth, projects, sessions metadata | PostgreSQL via Prisma | [[Synthi Frontend]] (`prisma/schema.prisma`, 56 models) |
| Files on disk, workspaces, terminals | Host filesystem + leveldb | [[Collab Server]] |
| Collaborative buffers | y-sweet CRDT store | [[Supporting Services]] |
| GPU/HMR state | Running worker process | [[Rust Systems]] + [[GPU HMR System]] |
| Agent tool surface | MCP registry | [[MCP Synthi]] |
| Evidence/proofs | Proof ledgers + `tmp/*-proof` | [[GPU HMR System]], [[Dojo Codesite Local Support]] |

## The five load-bearing flows

1. **Open an IDE session** — browser ⇄ collab-server (ws): workspace mount, file tree, Monaco via LSP, terminal PTY, git ops; buffers sync through y-sweet. → [[Data Flow Walkthroughs]]
2. **Stream an emulator/runtime** — browser ⇄ signaling-server (SDP/ICE via coturn) ⇄ Rust WebRTC worker (GStreamer → WebRTC video + datachannels).
3. **AI edit loop** — editor events → ai-gateway → ai-engine (split/diff/heal/verify) → files rewritten → [[GPU HMR System]] swaps kernels live; proof ledger records before/after visuals.
4. **Agent at work** — agent host attaches to a session ([[Dojo Codesite Local Support]] handshake) → drives tools via [[MCP Synthi]] → every consequential action gated by CodeSite boundaries.
5. **Local support session** — local Rust app pairs with a support session; read-only, redacted, revocable; UI proves exactly what was sent/blocked.

## Logical dependency summary

Per-system inbound/outbound tables live in [[Dependency Graph]]. Shortest form:

- frontend ⟶ collab-server, y-sweet, signaling, ai-gateway, postgres
- collab-server ⟶ y-sweet, redis?, docker/k8s runtime, signaling webhook
- signaling ⟶ redis, coturn, worker; notifies collab-server
- worker ⟶ ai-engine (refactor APIs); media ⟶ browser
- ai-engine ⟶ provider LLMs (via gateway/env), docker (agent-runner); never compiles user code itself
- synthi-mcp ⟶ signaling, worker datachannels, vision LLMs, frontend REST (codesite/integrations), optional postgres, CDP browsers
- packages (atomic-orchestrator, mcp-hub, programs-mcp) are libraries consumed by frontend + synthi-mcp

## Environments

Local dev = `docker compose` ([[Environments and Ports]]); production = GKE with sysbox + dojo release gate overlay ([[Infra Deployment]]).

[[00 Home|🏠 Back to Home]]
