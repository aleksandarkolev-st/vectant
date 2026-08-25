# Vectant ADE — Obsidian Documentation

Complete technical documentation for this repository, formatted as an [Obsidian](https://obsidian.md/) vault (plain Markdown + wikilinks — readable anywhere, best in Obsidian).

**Open it:** Obsidian → *Open folder as vault* → select `obsidian-docs/vault/`.

## Layout

| Path | Contents |
|---|---|
| `vault/00 Home.md` | Navigation hub |
| `vault/*.md` | System deep dives, cross-cutting maps, glossary |
| `vault/Area - *.md` | Exhaustive per-module references (every route/component/file with `path:LNN` citations) |
| `vault/File Index/` | All ~5,200 repo files individually indexed with content-derived descriptors |
| `vault/Graphics/` + `vault/*.svg` | Dark-themed architecture posters & flow diagrams (render inline in Obsidian) |

## Regenerating

Sources of truth live in the repo:

```bash
# 1. Deep-dive source analyses -> docs/obsidian-src/*.md
#    (authored by analysis agents; edit these to update content)

# 2. Rebuild the 10 core vault notes from sources:
py -3.12 scripts/assemble_obsidian_vault.py

# 3. Rebuild the exhaustive Area notes:
py -3.12 scripts/assemble_area_notes.py

# 4. Rebuild the complete file index (docs/file-index/):
py -3.12 scripts/build_file_index.py
```

The vault copy under `obsidian-docs/vault/` is a build artifact — regenerate after changing sources.

## What's documented

- **Synthi Frontend** — Next.js 15 IDE: routes, all 56 Prisma models, Redux, services, security headers
- **Collab Server** — endpoint surface, session/workspace lifecycle, terminals, git service, CodeSite guards
- **AI Engine** — ~166 endpoints, LLM layer, three-verifier doctrine, shadow/genome runs
- **MCP Server** — 275-tool catalog, transports, broker, channels/wire protocol, dojo/codesite tools
- **Rust Systems** — WebRTC worker (267 files) + signaling server; Local Support desktop app internals
- **GPU HMR** — deterministic split → hipcc → dual-slot live swap on gfx1201, proof ledger, wall-times
- **Dojo / CodeSite / Local Support** — agent trust infrastructure (licenses E0–EX, MutationLease, pairing)
- **Supporting Services** — packages, y-sweet, ai-gateway, agent-runner, oauth-relay extension
- **Infra & Deployment** — compose stack, GKE topology, dojo release-gate overlay, CI/CD
- **Docs & Tooling** — annotated catalog of all 158 docs/*.md files plus scripts/e2e/tests inventory

Generated 2026-08-25 from working tree at `main` (`ce74771af`).
