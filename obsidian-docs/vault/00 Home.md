# Vectant ADE — Technical Documentation

> Obsidian vault for the **vectant-ade** repository (`C:\Users\polek\Desktop\hermes-abuse\vectant-ade`).
> Product: **Vectant Local Support** — a trust-sensitive, read-only, session-scoped AI development environment ("Synthi") with GPU hot-module-reload, agent dojo, and mediated agent channels.

## Start here

- [[00 Home|🏠 Home]] — navigation hub (map of content)
- [[Architecture Overview]] — the whole system on one page
- [[Repository Map]] — every top-level directory explained
- [[Glossary]] — Vectant/Synthi vocabulary

## Systems (deep dives)

| System | Note | What it is |
|---|---|---|
| Frontend | [[Synthi Frontend]] | Next.js 15 app — IDE UI, API routes, Prisma |
| Collab Server | [[Collab Server]] | Node control plane: sessions, workspaces, terminals |
| Runtime & WebRTC | [[Rust Systems]] | WebRTC compiler worker + Local Support desktop app (Rust) |
| AI Engine | [[AI Engine]] | Python service: LLM orchestration, analysis, jobs |
| MCP Server | [[MCP Synthi]] | TypeScript MCP tool server for agents |
| GPU HMR | [[GPU HMR System]] | Flagship: deterministic split + live GPU hot reload |
| Dojo / Codesite / Local Support | [[Dojo Codesite Local Support]] | Agent training ground, governance, trust model |
| Supporting Services | [[Supporting Services]] | y-sweet, gateway, agent-runner, mcp packages, extension |
| Infra & Deployment | [[Infra Deployment]] | Compose, K8s, Cloud Build, ops |

## Complete file index

All 5,228 repo files individually indexed with content-derived descriptors:
[[File Index - Synthi Frontend|Frontend]] · [[File Index - Backend Services|Backend]] · [[File Index - AI Backend|AI]] · [[File Index - MCP Server|MCP]] · [[File Index - Infra Config|Infra]] · [[File Index - Docs and Meta|Docs]] · [[File Index - Packages|Packages]] · [[File Index - Extensions and Root|Root]] · [[File Index - Tests and Tooling|Tooling]]

## Exhaustive area references

Module-by-module deep dives (every route/component/file with line citations):

[[Area - Synthi App Routes|Synthi App Routes]] · [[Area - Synthi UI Components|Synthi UI Components]] · [[Area - Synthi Lib and Data|Synthi Lib and Data]] · [[Area - Collab Server Modules|Collab Server Modules]] · [[Area - AI Engine Endpoints|AI Engine Endpoints]] · [[Area - MCP Tool Catalog|MCP Tool Catalog]] · [[Area - Rust Worker Modules|Rust Worker Modules]] · [[Area - Local Support Internals|Local Support Internals]] · [[Area - Infra File Reference|Infra File Reference]] · [[Area - Supporting Services Internals|Supporting Services Internals]] · [[Area - GPU HMR Pipeline Files|GPU HMR Pipeline Files]]

## Visuals

[[Graphics]] — dark-themed architecture posters & flow diagrams (SVG)

## Cross-cutting

- [[Dependency Graph]] — who calls whom, logical deps per system
- [[Data Flow Walkthroughs]] — end-to-end request lifecycles
- [[Docs and Tooling]] — annotated catalog of all 90+ docs/*.md files
- [[Scripts and Tooling]] — scripts/, e2e/, tests/, probe/
- [[Environments and Ports]] — env vars, port map, compose wiring

## Provenance

Generated 2026-08-25 from the repo working tree at `main` (commit `ce74771af`). Source analyses live in `docs/obsidian-src/` in the repo; each system note links its source file.
