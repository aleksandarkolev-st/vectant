# Environments and Ports

> Wiring of the local compose stack and its env-var groups. Full service-by-service detail: [[Infra Deployment]].

## Compose services (docker-compose.yml)

Top-level services declared: `postgres`, `redis`, `y-sweet`, `runtime-image` (build), `frontend-migrate`, `frontend`, `collab-server`, `signaling-server`, `ai-engine`, `agent-runner-image` (build), `ai-gateway`, `coturn`, `mcp`. Named volumes include `worker`, `ysweet-data`, `postgres-data`, `collab-data`, `codesite-shadow-scratch`, `agent-credentials`, `agent-egress`.

GPU variants: `docker-compose.gpu-amd.yml` (RX 9070 XT / gfx1201 — primary dev target), `docker-compose.nvidia.yml`; port overrides in `docker-compose.local-ports.yml`.

## Gotchas (learned live)

- **env_file does not feed `${VAR}` substitution** — pass `--env-file .env.local` explicitly to `docker compose`.
- Worker DNS crash-loop ⇒ usually the **signaling-server died first**; check upstream before restarting workers.
- Named-volume dirs must be pre-created in-image *after* `adduser`, else root-owned.
- Containers exit over time; `docker start <svc>` revives them.
- The running stack belongs to this checkout (`Desktop\vectant-ade`), not Downloads — verify via `config_files` label.

## Env var groups (.env.example)

| Group | Consumers | Examples |
|---|---|---|
| Database | postgres, synthi (Prisma), collab-server | `POSTGRES_*`, `DATABASE_URL` |
| Auth | frontend, collab-server | next-auth secrets, JWT |
| AI split | ai-engine, gateway | `SYNTHI_SPLIT_PROVIDER`, `SYNTHI_SPLIT_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (openrouter `/v1` works) |
| WebRTC | signaling-server, coturn, frontend | turn credentials, `turn-credentials` API route |
| Collab/runtime | collab-server, runtime container | workspace roots, registry, ports |
| MCP/agents | mcp, agent-runner | broker endpoints, egress policy |
| Cloud | k8s/cloudrun only | GCP project, buckets (`@google-cloud/storage`) |

Exact per-service env mapping: see source analysis `docs/obsidian-src/infra-deployment.md` (repo) → summarized in [[Infra Deployment]].

## Related

[[Architecture Overview]] · [[Infra Deployment]]
