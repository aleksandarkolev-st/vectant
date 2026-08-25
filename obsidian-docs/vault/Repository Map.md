# Repository Map

> 5,142 tracked files (excluding `.git`, `node_modules`, build output, data volumes).
> Monorepo root: `C:\Users\polek\Desktop\hermes-abuse\vectant-ade` — npm workspaces: `synthi`, `mcp/synthi-mcp`, `packages/*`.

## File census by language

| Ext | Count | Where |
|---|---|---|
| .json | 915 | configs, package manifests, fixtures |
| .js | 887 | collab-server, packages, gateway, scripts |
| .rs | 564 | synthi-webrtc-compiler worker, local-support app |
| .py | 489 | ai-engine |
| .ts | 487 | mcp/synthi-mcp, synthi libs |
| .jsx/.tsx | ~700 | synthi UI components/pages |
| .md | 314 | docs/, plans, proofs, this vault's sources |
| .mjs | 240 | ESM tooling, synthi scripts |
| .proto | 72 | WebRTC compiler gRPC contracts |
| .sql | 44 | Prisma migrations |

## Top-level layout

```
vectant-ade/
├── synthi/                  Next.js 15 frontend+API  → [[Synthi Frontend]]      (~1,191 files)
├── backend/
│   ├── collab-server/       Node control plane       → [[Collab Server]]
│   ├── synthi-webrtc-compiler/  Rust WebRTC worker   → [[Rust Systems]]
│   ├── vectant-local-support-app/ Rust desktop app    → [[Rust Systems]], [[Dojo Codesite Local Support]]
│   ├── y-sweet/             Yjs CRDT server (vendored)
│   ├── backend/             ⚠ nested mirror/duplicate of backend/* → [[Rust Systems]]
│   └── gui-images/, runtime-image/              Docker image assets
├── ai-backend/
│   ├── ai-engine/           Python AI service        → [[AI Engine]]
│   ├── gateway/             Node AI gateway          → [[Supporting Services]]
│   └── agent-runner/        Agent container image    → [[Supporting Services]]
├── mcp/synthi-mcp/          TypeScript MCP server    → [[MCP Synthi]]
├── packages/                Shared JS packages       → [[Supporting Services]]
│   ├── atomic-orchestrator/  task planning + execution lifecycle
│   ├── mcp-hub/              MCP client hub w/ SSRF guard
│   └── programs-mcp/         program manifest MCP tools
├── extensions/vectant-oauth-relay/  Browser extension → [[Supporting Services]]
├── docs/                    158 design docs + proofs → [[Docs and Tooling]]
├── k8s/, ops/, cloudrun/, cloudbuild.yaml           → [[Infra Deployment]]
├── docker-compose*.yml      Local stack definition   → [[Environments and Ports]]
├── e2e/, tests/, probe/, scripts/, tasks/           → [[Scripts and Tooling]]
├── tmp/                     Proof-run artifacts (1,160 files; generated evidence, not source)
├── .visual-proof/, screenshots/     Visual proof captures
├── PRODUCT.md               Product charter (trust model) 
└── .env.example             All service env vars
```

## Notes

- `backend/backend/` is a near-duplicate of parts of `backend/` (verified via the synthi-webrtc-compiler mirror); treat `backend/<name>` as canonical.
- `tmp/` holds acceptance-proof artifacts from validation runs (codesite-*-proof, filesystem-boundary-proof, etc.) — evidence trail, not shipped code.
- Root oddities: `gitstatus_dev.jsx` / `gitstatus_themes.jsx` (large JSX scratch files), `compact-vhdx.ps1`, `count_files_loc.ps1`, `list-sources.ps1` (Windows maintenance scripts), `new-prompt.md` (scratch), `test-build-arg.Dockerfile` (CI probe).

## Complete file index

Every one of the repo's 5,228 files, described from its actual source content:

- [[File Index - Synthi Frontend]] (1,191 files)
- [[File Index - Backend Services]] (897)
- [[File Index - AI Backend]] (692+156 tests)
- [[File Index - MCP Server]] (699)
- [[File Index - Docs and Meta]] (1,417)
- [[File Index - Extensions and Root]] (195)
- [[File Index - Infra Config]] (44)
- [[File Index - Packages]] (33)
- [[File Index - Tests and Tooling]] (51)

## Related

[[Architecture Overview]] · [[Dependency Graph]] · [[Glossary]]
