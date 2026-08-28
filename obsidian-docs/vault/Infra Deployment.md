---
tags: "infra", "docker", "k8s"
system: Infrastructure & Deployment
source-repo: vectant-ade
generated: 2026-08-25
---

# Infrastructure & Deployment

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/infra-deployment.md` in the repo. All paths below are repo-relative unless noted.

---
title: Infrastructure & Deployment Analysis
source: vectant-ade repository survey (docker-compose*, k8s/, cloudbuild.yaml, cloudrun/, ops/, k8s/sysbox/)
date: 2026-08-25
tags: [infra, deployment, gke, docker-compose, cloudbuild, cloudrun, sysbox]
---

**Infra & Deployment — vectant-ade (Synthi IDE)**

The repo ships **four distinct deployment surfaces** for the same service fleet:

| Surface | Entry point | Status |
|---|---|---|
| **Local Docker Compose** | `docker-compose.yml` (+ GPU/local-port overrides) | Primary dev stack, heavily commented, security-hardened |
| **GKE production/beta** | `k8s/` kustomize base | Live beta at `beta.vectant.dev`, project `vectant-proj`, region `europe-west10` |
| **GKE "Dojo release gate"** | `k8s/overlays/dojo-release-gate/` | Production deploy default; swaps in-cluster Postgres/Redis for Cloud SQL/Memorystore via External Secrets |
| **Cloud Run** | `cloudrun/*.service.yaml` | **Legacy migration notes only** — README says do not apply as release-gate infra |

Plus a fifth auxiliary substrate: **Sysbox scratch cluster** (`k8s/sysbox/`) for validating unprivileged Docker-in-Pod runtimes.

CI/CD is Google Cloud Build (`cloudbuild.yaml`, Kaniko builds → kubectl rollout), driven either by `scripts/deploy-prod.sh` or the GitHub Actions workflow `.github/workflows/deploy-prod.yml` (Workload Identity federation).

---

## 1. Local Docker Compose stack

### 1.1 Service inventory (14 services)

| Service | Image / build | Host→container port | Volumes | Depends on |
|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` pinned by digest | `127.0.0.1:${POSTGRES_HOST_PORT:-5432}`→5432 | `postgres-data:/var/lib/postgresql/data` | — |
| `redis` | `redis:7-alpine` pinned by digest | `127.0.0.1:${REDIS_HOST_PORT:-6379}`→6379 | — | — |
| `y-sweet` | build `backend/y-sweet/Dockerfile` (wraps digest-pinned `ghcr.io/jamsocket/y-sweet`) → image `synthi-y-sweet` | `${YSWEET_HOST_PORT:-8180}`→8080 | `ysweet-data:/data`; cmd `y-sweet serve /data --host 0.0.0.0 --port 8080`; auth key `dev-secret` | — |
| `runtime-image` | build `backend/runtime-image/Dockerfile` → `vectant-runtime:local`; **build-only service**: entrypoint `exit 0`, `restart: no` | — | — | — |
| `frontend-migrate` | same build as frontend, `target: builder`; runs `npx prisma migrate deploy`; `restart: no` | — | — | postgres (healthy) |
| `frontend` | build context **repo root**, dockerfile `synthi/Dockerfile` (npm-workspace build so `@synthi/mcp-hub` resolves); multi-stage Next.js 15 standalone | `${FRONTEND_HOST_PORT:-3000}`→3000 | `.:/workspace:ro` (CodeSite snapshot mirror), `codesite-shadow-scratch:/workspace-shadow`, `./tmp/codesite-dojo-proof/app-artifacts:/codesite-app-artifacts` | frontend-migrate (completed), postgres (healthy), y-sweet (healthy), ai-engine, collab-server (started) |
| `collab-server` | build `backend/collab-server/Dockerfile` | `${COLLAB_HOST_PORT:-1234}`→1234 | `collab-data:/data`; **host `/var/run/docker.sock` bind** (runtime-container management only, never passed to program env); `group_add` for socket gid + shared gid 1000 | redis (healthy), y-sweet (healthy), ai-engine, runtime-image (completed) |
| `signaling-server` | build `backend/synthi-webrtc-compiler/signaling-server/Dockerfile` | `${SIGNALING_HOST_PORT:-9000}`→9000 | — | redis (healthy), collab-server |
| `ai-engine` | build `ai-backend/ai-engine/Dockerfile` (FastAPI/uvicorn) | `${AI_ENGINE_HOST_PORT:-8081}`→8000 (host 8000 deliberately avoided — Windows bind conflicts) | `collab-data:/data` (**rw** — code-intel index persists under `<workspace>/.code_intel`); `/var/run/docker.sock` (Failure Distiller capsules only); `group_add: ["0"]` | agent-runner-image (completed) |
| `agent-runner-image` | build `ai-backend/agent-runner/Dockerfile` → `vectant-agent-runner:local`; build-only (`command: [/bin/true]`), on `agent-egress` network | — | — | — |
| `ai-gateway` | build `ai-backend/gateway/Dockerfile` (Node WS→HTTP bridge) | `${AI_GATEWAY_HOST_PORT:-7071}`→7070 | — | ai-engine |
| `coturn` | `coturn/coturn:4.7.0-r2` pinned by digest | `3478` tcp+udp, relay `49152-49200`/udp (all 127.0.0.1) | — | — |
| `mcp` | build **root context**, `mcp/synthi-mcp/Dockerfile` → Synthi MCP sleeper container | `${MCP_METRICS_HOST_PORT:-9464}`→9464 (Prometheus scrape) | — | signaling-server, worker |
| `worker` | build `backend/synthi-webrtc-compiler/worker/Dockerfile`, args `WORKER_CARGO_FEATURES=gpu-hmr`, `INSTALL_ROCM=false` (base stays CPU/host-only) | none (outbound WS only) | `collab-data:/data:ro`; `cap_drop: ALL`; `no-new-privileges:true`; `shm_size 8gb`; `ipc private` | signaling-server, collab-server |

### 1.2 Compose volumes & networks

Named volumes: `postgres-data`, `ysweet-data`, `collab-data` (the shared workspace filesystem used by frontend RO-mirror logic, collab-server, ai-engine, worker, runtime containers, Failure Distiller), `codesite-shadow-scratch`, `agent-credentials` (provisioned out-of-band from secret manager for agent harnesses).

Networks: implicit `default` plus explicit `agent-egress`. Agent runner containers are launched on `vectant-ade_agent-egress`; per-workspace runtime containers join `vectant-ade_default` (see `WORKER_NETWORK`). All host port bindings are loopback-only (`127.0.0.1:` prefix) except coturn's relay range which is also bound to localhost.

### 1.3 Startup order (compose dependency graph)

```
postgres ──healthy──► frontend-migrate ──completed──► frontend
redis ────healthy──► collab-server ◄──started── y-sweet(healthy)
y-sweet ──healthy──►        ▲                    │
runtime-image ─completed──► │                    ▼
agent-runner-image ─completed► ai-engine ─started─┘ (frontend, collab)
redis/y-sweet ──► signaling-server ──► mcp, worker
ai-engine ◄──── ai-gateway
```

Notable: there's a deliberate *cycle avoidance* comment — ai-engine shares the `collab-data` volume with collab-server but does not declare `depends_on: collab-server`, because collab-server already depends on ai-engine.

### 1.4 Environment variable groups (compose)

- **Auth/shared secrets**: `AUTH_SECRET`/`NEXTAUTH_SECRET` (default `local-compose-auth-secret` locally), `COLLAB_INTERNAL_TOKEN` (`:?` required — compose fails fast without it), `SYNTHI_CODESITE_TOKEN` (default `local-compose-codesite-token`), `GATEWAY_JWT_SECRET` (.env).
- **Database**: `DATABASE_URL=postgresql://synthi:***@postgres:5432/synthi` forced to the compose service (never a host URL). Postgres user/db `synthi`.
- **Inter-service URLs (server-side)**: `COLLAB_SERVER_URL=http://collab-server:1234`, `YSWEET_URL=http://y-sweet:8080`, `CODE_INTEL_URL=http://ai-engine:8000`, `BACKEND_URL=http://ai-engine:8000`, `REDIS_URL=redis://redis:6379`, `SIGNALING_URL=ws://signaling-server:9000`, `SYNTHI_APP_INTERNAL_URL=http://frontend:3000`, `SYNTHI_CODESITE_API_BASE_URL=http://frontend:3000/api/workspace/{slug}/codesite`.
- **Browser-side URLs (baked at `next build` time as build args)**: all `NEXT_PUBLIC_*` derived from host-port vars — `NEXT_PUBLIC_COLLAB_SERVER_URL=http://localhost:${COLLAB_HOST_PORT:-1234}`, `NEXT_PUBLIC_YSWEET_URL=http://localhost:${YSWEET_HOST_PORT:-8180}`, `NEXT_PUBLIC_COMPILE_SIGNAL_URL=ws://localhost:${SIGNALING_HOST_PORT:-9000}`, `NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:${AI_GATEWAY_HOST_PORT:-7071}/ws`, `NEXT_PUBLIC_CODE_INTEL_URL` / `NEXT_PUBLIC_AI_ENGINE_URL=http://localhost:${AI_ENGINE_HOST_PORT:-8081}`, plus optional `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS`.
- **Runtime-container management (collab-server)**: `ENABLE_CONTAINER_RUNTIME=1`, `RUNTIME_IMAGE=vectant-runtime:local`, `WORKER_IMAGE=synthi-ide-worker:latest` (re-pointed from nonexistent `synthi-worker:local` to avoid Docker Hub 404), `WORKSPACE_DATA_VOLUME=vectant-ade_collab-data` (named volume, because a host bind would resolve on the host and be empty), `WORKER_NETWORK=vectant-ade_default`, `SYNTHI_RUNTIME_SHARED_GID=1000`, `SYNTHI_RUNTIME_WORKSPACE_UMASK=0002`, `SPAWNER_MODE=local`.
- **Agent/Failure-Distiller (ai-engine)**: `SYNTHI_AGENT_RUNNER_IMAGE=vectant-agent-runner:local`, `SYNTHI_AGENT_RUNNER_NETWORK=vectant-ade_agent-egress`, `SYNTHI_AGENT_WORKSPACE_VOLUME=vectant-ade_collab-data` (+`_ROOT=/data`), `SYNTHI_AGENT_CREDENTIALS_VOLUME=vectant-ade_agent-credentials`, `VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES` (digest-pinned `python:3.12-slim`; executor runs `--pull=never`), `AI_ENGINE_AUTH_DISABLED=true` (local).
- **CodeSite proof authority**: family of `SYNTHI_CODESITE_PROOF_AUTHORITY_*` vars incl. `_FILE` indirection for ephemeral Ed25519 keys; shadow runner config `SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON`, `..._ALLOWED_ROOT=/workspace-shadow`, `..._ALLOW_INLINE_COMMANDS=1`; artifact root `SYNTHI_CODESITE_ARTIFACT_ROOT=/codesite-app-artifacts`.
- **TURN/WebRTC**: local coturn creds `synthi:synthi`, `LOCAL_TURN_URL=turn:localhost:${TURN_HOST_PORT:-3478}` (frontend) / `turn:coturn:3478` (collab), `JUPYTER_ALLOW_DOCKER_HOST`, `JUPYTER_ALLOW_PRIVATE_HTTP`.
- **Worker/GStreamer/Rust**: `GST_DEBUG=2`, `DISPLAY=:99`, `RUST_BACKTRACE=full`, `RUST_LIB_BACKTRACE=full`, `SYTHI_LOG_LEVEL=debug`, `SYNTHI_GPU_HMR=${...:-0}` (off in base), `HSA_ENABLE_DXG_DETECTION`.
- **Storage metadata**: `GCP_PROJECT_ID=overview-synti`, `GCS_BUCKET_NAME=synthi-cloud-storage` (compose) vs `vectant-proj` / `vectant-synthi-cloud-storage` (k8s ConfigMap) — two different GCP projects for dev vs prod.
- Secret-bearing provider keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, OAuth creds) come **only** from gitignored `.env.local` via optional `env_file:` — comments warn that redeclaring them as empty `"${VAR:-}"` in `environment:` silently strips them and breaks embeddings.

### 1.5 Healthchecks (compose)

- postgres: `pg_isready -U synthi` (5s interval ×5 retries)
- redis: `redis-cli ping`
- y-sweet: bash `/dev/tcp/127.0.0.1/8080` probe (12 retries)
- frontend: node fetch of `/api/workspace/__codesite_readiness__/codesite/readiness` with bearer `SYNTHI_CODESITE_TOKEN` (15s×4, start period 20s)
- collab-server: node fetch of `/codesite/readiness` on :1234
- worker: intentionally none — relies on `restart: unless-stopped` so panics auto-recover instead of hanging every compile.

### 1.6 Overrides

- `docker-compose.gpu-amd.yml` — AMD/ROCm on WSL2 (RX 9070 XT): rebuilds worker with `Dockerfile.gpu` (`INSTALL_ROCM=true`, features `gpu-hmr`), exposes `/dev/dxg`, mounts WSL `libdxcore.so`, sets `CUDA_HOME`/`ROCM_PATH`/`LD_LIBRARY_PATH`, `HSA_ENABLE_DXG_DETECTION=1`, hints `SYNTHI_GPU_VENDOR_HINT=rocm` on ai-engine.
- `docker-compose.nvidia.yml` — NVIDIA toolkit: same universal GPU image (both CUDA and ROCm/HIP toolchains shipped in one image; manifest selects nvcc or hipcc per project), `gpus: all`, `NVIDIA_VISIBLE_DEVICES=all`, driver caps compute/utility/graphics/video, clears dxg detection.
- `docker-compose.local-ports.yml` — single override moving redis to host `16379`.

---

## 2. GKE topology (`k8s/`)

Namespace: **`synthi`**. All images reference Artifact Registry `europe-west10-docker.pkg.dev/vectant-proj/synthi/<name>:build-tag-required` — the placeholder tag is sed-replaced with the immutable build tag by Cloud Build/deploy script before apply, so raw `kubectl apply -k k8s/` never rolls pods to a placeholder.

### 2.1 Kustomization layers & apply order

`kustomization.yaml` resources in order:
1. Foundation — `namespace.yaml`, `configmap.yaml` (`synthi-config`), `spawner-rbac.yaml`
2. Datastores — `postgres.yaml` (StatefulSet), `redis.yaml`
3. Backends — `ai-engine.yaml`, `ai-gateway.yaml`, `y-sweet.yaml`, `collab-server.yaml`, `signaling-server.yaml`
4. Frontend/workers — `frontend.yaml`, `worker.yaml`
5. Hardening — `preview-certificate.yaml`, `ingress.yaml`, `network-policies.yaml`, `pod-disruption-budgets.yaml`

Common labels `app.kubernetes.io/part-of: synthi-ide`, managed-by kustomize. **Not** in the kustomization: `prisma-migrate-job.yaml`, `dojo-postgres-migrate-job.yaml` (run explicitly by CI), `external-secrets.yaml` is included in the Dojo overlay only (the README documents swapping it for manual `secrets.yaml` in the base when ESO isn't installed), `sysbox/` (deliberately standalone kustomization).

### 2.2 Workload matrix

| Workload | Kind / replicas | Image | Ports | Node pool | Resources (req/lim) | Probes |
|---|---|---|---|---|---|---|
| frontend | Deployment ×2, anti-affinity, rolling | synthi-frontend | 3000 (NodePort + NEG + BackendConfig) | default | 200m/256Mi → 1 CPU/1Gi | readiness: node-fetch codesite readiness w/ token; liveness: GET `/api/auth/providers` |
| collab-server | Deployment ×1, **Recreate**, `NODE_OPTIONS=--max-old-space-size=2048` | synthi-collab-server | app **1235**, edge-proxy nginx sidecar listens **1234** with WS upgrade + 3600s timeouts | default | 500m/1Gi → 2/3Gi (app); 25m/32Mi → 100m/64Mi (proxy) | readiness/liveness `/debug/status`:1235 (NOT `/codesite/readiness` — documented deadlock rationale); proxy `/healthz`:1234 |
| signaling-server | Deployment ×1 + HPA 1–4 @70% CPU | synthi-signaling-server | 9000 ws; **healthz sidecar** `hashicorp/http-echo` :8080 | default | tiny (50m/32Mi → 250m/128Mi) | tcpSocket :9000; LB health hits sidecar :8080 |
| ai-engine | Deployment ×2, maxSurge 0/maxUnavailable 1, uvicorn `--workers 2` | synthi-ai-engine | 8000 ClusterIP (no NEG) | default | 250m/512Mi → 2/2Gi | httpGet `/health` |
| ai-gateway | Deployment ×2, anti-affinity, cluster mode off | synthi-ai-gateway | 7070 (NodePort + NEG) | default | 100m/128Mi → 500m/512Mi | `/gateway/health` |
| y-sweet | Deployment ×1 + HPA 1–4 @70% ("beta floor until Cloud Run cutover"), GCS store `gcs://$BUCKET/ysweet` | ghcr.io/jamsocket/y-sweet digest-pinned | 8080 | default | 100m/128Mi → 1/512Mi | tcpSocket :8080 |
| worker | Deployment **replicas 0** — dynamic spawn only (collab spawner creates 1-pod Deployments `rt-<hmac>` per session; ensure/touch/teardown lifecycle) | synthi-worker | none inbound; SESSION_ID = pod name via Downward API | **workspace-pool** + toleration `workload=workspace:NoSchedule` | 2 CPU/4Gi → 6/12Gi; dshm emptyDir 512Mi + tmp 2Gi; grace 15s | exec `pgrep -f worker` |
| postgres | StatefulSet ×1, headless svc, PGDATA subpath, 10Gi RWO template (default StorageClass) | postgres:16-alpine digest | 5432 | default | 250m/256Mi → 1/1Gi | pg_isready |
| redis | Deployment ×1, `--maxmemory 64mb --maxmemory-policy allkeys-lru` | redis:7-alpine digest | 6379 | default | 50m/64Mi → 250m/128Mi | redis-cli ping |
| dojo-mcp-host (overlay only) | Deployment ×1 Recreate, 2 containers: `synthi-mcp-http` (:9467 MCP + /healthz) + `synthi-browser-workflow-bridge` hosted-browser sidecar (Xvfb/x11vnc/websockify/noVNC + Playwright Chromium CDP :9222, view :6080, VNC :5900) | synthi-mcp-http / synthi-browser-workflow-bridge | 9467 NodePort + NEG | default | 250m/512Mi → 1/1Gi (mcp, cap-drop ALL); 200m/512Mi → 2/2Gi (browser, runAsRoot) | exec probes on CDP+noVNC endpoints |

Persistent volumes: `collab-data-pvc` **100Gi RWX `standard-rwx`** (Filestore CSI; mounted `/data` by collab-server and shared with runtime pods — RWX required because pods span node pools; enterprise-multishare-rwx documented as prod alternative), `postgres-data` 10Gi RWO, overlay adds `dojo-mcp-data-pvc` 1Gi RWO standard-rwo at `/var/lib/synthi/dojo`.

### 2.3 Configuration surface

`configmap.yaml` (`synthi-config`) carries ~60 keys grouped as: GCP identity (`vectant-proj`, bucket `vectant-synthi-cloud-storage`, prefix `workspaces`), cluster-internal DNS URLs (`*.synthi.svc.cluster.local`), preview machinery (`SYNTHI_PREVIEW_TARGET_TEMPLATE=http://{runtimeId}-rt.synthi.svc.cluster.local:{sidecarPort}{prefix}/{port}`, public domain `preview.vectant.dev`, sidecar image node:20-alpine, excluded infra ports `8001,18000`), hosted-browser bridge/CDP templates (`{runtimeId}.synthi.svc.cluster.local`), terminal backend `k8s-exec`, `SYNTHI_NO_JAIL=1`, scoped-ports disabled (separate runtime pods ⇒ no :5173 collisions), public URLs (`https://beta.vectant.dev`, NEXT_PUBLIC_* pointing at same-origin paths `/collab`, `/signal`, `/gateway/ws`), feature flags (`GCS_SYNC_ON_FLUSH=true`, `CODE_INTEL_AUTO_INDEX=true`), worker tuning, spawner node-selector/taint for `workspace-pool`, and images (`WORKER_IMAGE`, `RUNTIME_POD_IMAGE` rootful-dind-under-Sysbox, both `build-tag-required` placeholders).

Secrets: production path is **External Secrets Operator** (`external-secrets.yaml`) — `SecretStore` gcpsm project `vectant-proj` via Workload Identity SA `synthi-eso-sa@…` bound to cluster `synthi-beta-cluster` (europe-west10-a); one `ExternalSecret` syncs ~20 keys into K8s Secret `synthi-secrets` hourly (refresh 1h, creationPolicy Orphan, deletion Retain). Keys cover DATABASE_URL + POSTGRES_*, AUTH/NEXTAUTH secrets, Google/GitHub OAuth, AI tokens (`AI_BACKEND_AUTH_TOKEN`, `GEMINI_API_KEY`, optional OPENAI), runtime identity/token-encryption keys, browser-workflow-bridge token, YSWEET_AUTH_KEY, and the two deliberately separate internal tokens `SYNTHI_CODESITE_TOKEN` and `COLLAB_INTERNAL_TOKEN`. Manual fallback: `secrets.yaml.example` (gitignored real copy). Helper scripts: `create-gcp-secrets.sh` (awk-parses both ExternalSecret manifests → `gcloud secrets create` with automatic replication), `workload-identity-setup.sh` (creates `synthi-gcs-sa` storage.objectAdmin on the bucket, `synthi-eso-sa` secretAccessor, `synthi-dojo-mcp-sa` cloudkms.signerVerifier, WI bindings).

RBAC (`spawner-rbac.yaml`): Role `workspace-spawner` grants collab-server-sa management of Deployments (get/list/create/patch/delete/watch), Pods (get/list/watch), pods/log, **pods/exec** (terminal service), Services (get/list/create/delete), batch/Jobs + status (workspace prep). Four SAs (`collab-server-sa`, `frontend-sa`, `y-sweet-sa`, `workspace-runtime-sa`) annotated to GSA `synthi-gcs-sa@` for GCS via Workload Identity.

### 2.4 Ingress, TLS, and load-balancer wiring

- `ManagedCertificate` for `beta.vectant.dev`; global static IP `synthi-ip`; ingress class `gce`; `FrontendConfig` forces HTTP→HTTPS 301.
- Ingress routes: `beta.vectant.dev` → `/collab`→collab-server:1234, `/signal`→signaling:9000, `/gateway`→ai-gateway:7070, `/`→frontend:3000; second rule host `*.preview.vectant.dev` → `collab-preview` Service (same pods, port 1234). Default backend = frontend.
- Five `BackendConfig`s, **all with `iap.enabled: true`** (identity boundary over everything incl. preview subdomains), WS timeout 3600s for collab/gateway/signaling/preview, 300s for frontend, connection draining 30s, and explicit GCLB health-check paths matching the probe endpoints (`/healthz`:1234, `/gateway/health`:7070, `/`:8080 sidecar, `/api/auth/providers`:3000).
- Preview wildcard TLS: cert-manager `ClusterIssuer letsencrypt-preview-dns` (Let's Encrypt DNS-01 via Cloud DNS, zone `preview.vectant.dev`) + Certificate issuing secret `preview-wildcard-tls` for `preview.vectant.dev` + wildcard; requires the cert-manager WI/DNS setup documented in `k8s/README.md`. Public preview origin pattern: `https://p<port>-rt-<runtime-id>.preview.vectant.dev/` keeps HMR websockets/cookies/service workers at root origin; the `/collab/runtime/.../port/...` path proxy remains debug-only.

### 2.5 NetworkPolicies

Default-deny ingress on the whole namespace, then explicit allowances:

- GCLB health-check/proxy CIDRs (`35.191.0.0/16`, `130.211.0.0/22`) → frontend:3000, collab-server:1234, signaling:9000+8080, ai-gateway:7070.
- y-sweet:8080 ← collab-server only; ai-engine:8000 ← gateway/collab/workspace pods; redis:6379 ← collab-server + signaling; postgres:5432 ← DB consumers.
- `runtime-egress-hardening` (egress, selects `app=runtime`, inert until runtime pods exist): DNS :53 any destination (documented NodeLocal DNSCache caveat — a kube-dns podSelector broke resolution because the responder is the node in 10/8), then public internet only — `0.0.0.0/0` minus RFC1918 and `169.254.0.0/16` (blocks lateral movement + GKE metadata server credential theft). Requires Dataplane V2/Calico. Deferred: bandwidth caps, flow-log abuse detection, dedicated egress IPs.

### 2.6 PodDisruptionBudgets

`minAvailable: 1` for frontend, ai-gateway, signaling-server, y-sweet. Nothing for collab-server (single-replica Recreate), datastores, or workers.

### 2.7 Migration Jobs

- `prisma-migrate-job.yaml` — Job `prisma-migrate`, image `synthi-prisma-migrate` (built from `synthi/Dockerfile.migrate`: node:20-alpine + global `prisma@6.17.1` + schema, USER node, entrypoint `prisma migrate deploy`), backoffLimit 3, deadline 300s, TTL 1h, DATABASE_URL from `synthi-secrets`. Explicitly excluded from kustomization — triggered manually or by CI after each render.
- `dojo-postgres-migrate-job.yaml` — Job `dojo-postgres-migrate` using the `synthi-mcp-http` image running `npm run proof:dojo:postgres:migrate`, envFrom both `synthi-secrets` and `synthi-dojo-release-secrets`; backoffLimit 0 (fail the release cleanly). Applied by Cloud Build between External-Secret sync and app rollout.

### 2.8 Dynamic runtime pods (spawner model)

Static `worker` replicas stay 0. Collab-server's spawner creates per-runtime Deployments named `rt-<base32-hmac(SYNTHI_RUNTIME_ID_SECRET)>` with a preview sidecar (port 18080, prefix `/__synthi_preview`) so user dev servers can keep binding localhost-only ports; idle timeout 5 min, MAX_WORKSPACE_PODS 10, pod-ready timeout 5 min, cleanup-on-shutdown off. Eviction is memory-only in prod (`REPO_CACHE_DELETE_ON_EVICT=false`) so `/data/repos/<workspace>/<fs-user>` persists on the RWX PVC, including terminal CLI/auth state under `.synthi/runtime`. Two backend modes: `ENABLE_CODESITE_DOCKER_RUNTIME=0` in-cluster (docker.sock absent; must stay off or every ensure-runtime ENOENTs), workspaces come from the k8s spawner; `RUNTIME_POD_IMAGE` (rootful dind under Sysbox RuntimeClass) selected when `RUNTIME_BACKEND=sysbox-pod`.

---

## 3. Dojo release-gate overlay (`k8s/overlays/dojo-release-gate/`)

Production deploy default. Base `k8s/` stays untouched for beta rollback. Composition: all base resources **except** postgres.yaml and redis.yaml, plus `dojo-release-external-secrets.yaml` and `dojo-mcp-host.yaml`.

Transformations:
1. Removes in-cluster Postgres/Redis manifests and their NetworkPolicies ($patch delete), removes `REDIS_URL` from `synthi-config`.
2. Patches collab-server + signaling-server `REDIS_URL` to read `synthi-dojo-release-secrets/REDIS_URL` (Memorystore).
3. `dojo-release-config.yaml` writes fail-closed posture into `synthi-config`: `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1`, durable store required, control-plane/evidence-ledger stores = postgres, external signing required (`managed-key-service`), MCP manifest issuer `synthi-dojo-skill-bus-prod` ed25519, hosted-browser origin allowlist `https://beta.vectant.dev`, session TTL 1h, screenshot redaction, tenant `vectant`, and `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED=0` (flipped only once the 16 `synthi-therapeutic-prod-*` Secret Manager entries exist — they never did, which blocked the entire production deploy until gated off).
4. Ingress patch adds four paths to the `beta.vectant.dev` rule: `/dojo/mcp`, `/therapeutic/runtime-authorization`, `/therapeutic/runtime-state`, `/therapeutic/incident-response` → dojo-mcp-host:9467.
5. Second ExternalSecret `synthi-dojo-release-secrets` (creationPolicy Owner, refresh 1h) syncing ~22 release-only keys (Dojo agent/workspace IDs, auth-checkpoint scope/store, control-plane + evidence-ledger postgres URLs, proof-signing key id/command/managed-key URI/public PEM, MCP manifest key trio + bearer token, therapeutic runtime/probe/store URLs+tokens+tenant/org/workspace/actor identities, hosted-browser CDP/workspace URLs, workflow-tool scope/store keys). Proof-signing **private** key deliberately absent — prod signing must use managed-key-service/KMS; the MCP manifest signer still holds an Ed25519 private key (acknowledged gap).
6. Render contract validated pre-deploy by `scripts/validate-dojo-render.sh` / `node mcp/synthi-mcp/scripts/dojo-kustomize-overlay-check.mjs` against `$DOMAIN`; `LoadRestrictionsNone` required because bases live directly under `k8s/` rather than `k8s/base/`. README forbids claiming enterprise readiness until the GCP inventory preflight passes (Cloud SQL, Memorystore, KMS/signing, Secret Manager, ESO, MCP-host conformance, hosted-runtime evidence).

---

## 4. Sysbox substrate (`k8s/sysbox/`)

Standalone kustomization (never referenced by the main one — the main file would force kube-system resources into `synthi` and mutate the cluster-scoped RuntimeClass). Contents: vendored/pinned **Sysbox v0.7.0** install DaemonSet + RuntimeClass `sysbox-runc` (image re-hosted to Artifact Registry and digest-pinned; 2 local modifications flagged for audit), smoke pod (dockerd inside `sysbox-runc` pod, no privileged flag, requires `hostUsers:false`-style userns support k8s≥1.33/containerd≥2.0.5), scratch-cluster provisioner (`create-scratch-cluster.ps1`: `synthi-sysbox-scratch`, zonal europe-west10-a, release channel None, no autoupgrade — because REGULAR-channel clusters wipe on-node Sysbox at upgrade), and a full runbook with acceptance test (`docker run hello-world` + `SecurityOptions` contains `userns`), node-recreate self-heal rehearsal, warm-node-floor policy, maintenance-exclusion policy for eventual prod promotion, teardown.

Why it matters: the per-workspace `vectant-runtime` image is built **two ways from one Dockerfile** — default rootless dind for local Docker Desktop hybrid mode, and rootful (`RUNTIME_USER=root`, `docker:dind` base) for Sysbox pods where the userns isolation comes from Sysbox itself. The rootless variant crash-loops under Sysbox (rootlesskit cannot nest a user namespace) — recorded as a validated lesson. ConfigMap note: the rootful toolchain image hadn't been produced/validated yet at time of writing (live Slice-2 proof used stock `docker:27-dind`); a TODO demands a Trivy CRITICAL gate in CI before enabling the backend in prod.

---

## 5. CI/CD

### 5.1 `cloudbuild.yaml` (single pipeline: build → scan → deploy)

Machine `E2_HIGHCPU_32`, 200GB disk, overall timeout 3600s, dynamic substitutions. Defaults: region `europe-west10`, cluster `synthi-beta-cluster` / zone `europe-west10-a`, registry `${REGION}-docker.pkg.dev/${PROJECT_ID}/synthi`, image tag `${BUILD_ID}`, kustomize dir `k8s/overlays/dojo-release-gate`.

Steps:
1. `reject-mutable-images` — greps all Dockerfiles/YAML for unpinned `:latest` refs (excl. cloudbuild.yaml itself); hard-fails.
2. `prepare-frontend-env` — writes `synthi/.env.production` with the ten `NEXT_PUBLIC_*` values (substitution-overridable per environment).
3. Parallel Kaniko builds, layer-cached (168h TTL), all builder images themselves digest-pinned: frontend (root context, 9 build args, fails build if the three required NEXT_PUBLIC args are missing), collab-server, ai-engine, ai-gateway, signaling (waits frontend), worker (waits signaling, 1800s step timeout, `INSTALL_ROCM` arg), prisma-migrate (`synthi/Dockerfile.migrate`), browser-workflow-bridge (root context, no cache), **conditionally** dojo-mcp-host `synthi-mcp-http` (skips unless `_KUSTOMIZE_DIR == _DOJO_RELEASE_KUSTOMIZE_DIR`), runtime-image with rootful Sysbox args.
4. Optional `vulnerability-scan-images` (Trivy 0.71.0, CRITICAL-only, exit-code 1) — opt-in via `_ENABLE_VULNERABILITY_SCAN=true`; scans all nine images plus runtime image with its committed `.trivyignore` waiver.
5. Deploy: get GKE credentials → verify namespace → `deploy-to-gke`, which renders kustomize **once**, seds manifest-source-registry → target registry and `build-tag-required` → tag, verifies no placeholder survives, guards kustomize dir traversal, then:
   - Dojo path: validate render contract → extract & apply ESO prerequisites (awk-split ExternalSecrets/SecretStore/eso-SA) → `kubectl wait` Ready for both externalsecrets → run `dojo-postgres-migrate` Job (wait complete, else dump logs & fail).
   - Run `prisma-migrate` Job (delete/recreate, wait ≤300s, tail logs).
   - Apply rendered manifest, with an automatic recovery path for immutable-selector drift (delete + recreate offending Deployments).
   - Dojo path: delete leftover in-cluster `deployment/redis`, `statefulset/postgres` + their Services/NetworkPolicies from the namespace.
   - Rollout status waits (frontend, collab-server, ai-engine, ai-gateway, signaling, + dojo-mcp-host on Dojo path) → seed Dojo release competency via `kubectl exec`.
   
   A long comment records history: CodeSite proof suite + release gate intentionally do **not** run inside Cloud Build (tarball upload lacks `.git`; provenance checks hard-fail) — they run on the host in the GitHub workflow; two in-build attempts (2026-07-03/05) never passed and were removed 2026-07-28, meaning a manual `gcloud builds submit` has no CodeSite gate.

### 5.2 Operator paths

- `scripts/deploy-prod.sh` — wraps `gcloud builds submit` with production defaults (project `vectant-proj`, registry europe-west10, cluster synthi-beta-cluster, overlay dir, LoadRestrictionsNone, tag `prod-<UTC ts>-<git sha>`); refuses dirty checkouts unless `--allow-dirty`; `--push` pushes HEAD to main first.
- `.github/workflows/deploy-prod.yml` — on push to main: Node setup → **CodeSite release gate on the runner** (`npm --prefix synthi run codesite:release-gate -- --proof-root tmp/codesite-dojo-proof`, validating git merge-base provenance) → gcloud auth via Workload Identity Federation (repo secrets `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`) → submit the same Cloud Build. Other workflows: `ci.yml`, `codesite-tests.yml`, `local-support-*`.
- Node pools: `ops/gke/ensure-hybrid-node-pools.ps1` creates/updates `core-pool` (e2-small ×1) and `workspace-pool` (n2-standard-16, min 0 / max 2, label+taint `workload=workspace:NoSchedule`; bootstrap-node workaround for min-nodes=0 creation constraint). `scripts/configure-workspace-node-pool.sh` is the leaner n2-standard-4 variant recommended for closed beta (scale-to-zero when idle runtimes drain).

---

## 6. Cloud Run assets (legacy / migration-in-progress)

`cloudrun/README.md` marks these as **legacy migration notes**; do not apply as release-gate infrastructure until regenerated for the target project/registry/domain/SAs/secrets (they still point at old project `overview-synti` and `beta.synthi.app`).

- Target split: Cloud Run gets frontend (maxScale 5, concurrency 80), ai-gateway (maxScale 6, concurrency 50), ai-engine (maxScale 4, concurrency 8, uvicorn 2 workers); GKE keeps support services + autoscaled workspace pool. All three Knative `Service` manifests use internal-and-cloud-LB ingress, serverless VPC connector `synthi-serverless-ew10` with `private-ranges-only` egress, startup CPU boost, Secret Manager `secretKeyRef`s, frontend additionally mounts Cloud SQL instance `overview-synti:europe-west10:synthi-dev`.
- `cloudrun/collab-server-evaluation.md`: explicit **No-Go** — collab-server couples live repo cache + durable auth-token storage on a PVC filesystem with its control plane; needs refactor before any lift-and-shift.
- Ingress blocker documented: the GKE Ingress owns the URL map and will overwrite manual edits; safe cutover requires a standalone external ALB (serverless NEGs for Cloud Run backends + zonal NEGs for GKE backends) before DNS shift — or simpler per-subdomain split (`app.`/`collab.`/`signal.`/`gateway.`/`ysweet.`).
- `ops/cloudrun/ensure-vpc-connector.ps1` — idempotent connector create/update (e2-micro, 2–3 instances, 10.8.0.0/28), with cost warning (baseline cost kills zero-idle economics; attach only where VPC reachability is required).
- `ops/gcp/ensure-standalone-edge-alb.ps1` — ~490-line idempotent provisioner for the migration ALB: global IP + managed SSL cert, serverless NEGs (frontend/gateway/engine) + zonal NEGs for GKE collab/signaling/y-sweet (with HC firewall rule scoped to GCLB ranges and resolved cluster node tags), backend services (serverless vs instance-group flavors), URL map import, HTTPS proxy, forwarding rule, IAP service-identity enablement.

---

## 7. Cross-cutting architecture docs

- **`docs/CONTAINER_FIRST_ARCHITECTURE.md`** — infra-relevant principle: server filesystem is the single source of truth. Yjs text changes auto-flush to `repos/{slug}/{path}` after a 150 ms debounce (collab-server), AI analysis requests carry **paths only**; ai-engine fetches content from collab-server (`/analyze/container`), with a 500 ms client debounce guaranteeing disk freshness. Explains why collab-data is shared rw with ai-engine.
- **`docs/SECURITY_SANDBOXING.md`** — blunt threat model for the HMR compiler ("RCE by design"). Implemented: supervisor/worker process isolation (default; in-process needs `SYNTHI_UNSAFE_INPROCESS=1`), binary MsgPack IPC, hard SIGKILL timeouts, ABI fingerprint/layout_hash gating memcpy. Missing for prod: seccomp-bpf whitelist, chroot/pivot_root, capability drop, env whitelisting, resource rlimits, network proxying — Phases 2–4 all TODO. Recommended end-state maps to the container-isolation mode that Sysbox + `runtime-egress-hardening` begin to deliver.
- **`docs/AUTH_REMOTE_HOST_SUPPORT.md`** — remote-host extension auth surface (VS Code API shims, GitHub device flow, URI-handler callback delivery, persisted sessions/secret stores, workspace-dir remapping to git top-level, default repos path `collab-server/repos/<slug>` → ties the runtime filesystem layout to auth persistence).
- **`docs/DEPLOYMENT_CHECKLIST.md`** — despite the name, this is a checklist for one AI-output-quality fix (streamed chat-response validation), not general infra; its deploy steps are plain Next.js build/restart with a rollback plan. Treat infra deployment guidance as living in `k8s/README.md` + `docs/AGENT_DOJO_RELEASE_GATE_RUNBOOK.md` instead.

---

## 8. Observations, risks, and inconsistencies

1. **Two GCP projects in play**: compose defaults to `overview-synti` / `synthi-cloud-storage`; k8s to `vectant-proj` / `vectant-synthi-cloud-storage`; Cloud Run YAML still references `overview-synti` and `beta.synthi.app`. Migration artifacts are stale relative to the current domain/project.
2. **Secret hygiene asymmetry**: compose embeds working dev fallbacks (`AUTH_SECRET=local-compose-auth-secret`, TURN `synthi:synthi`, y-sweet `dev-secret`, postgres `password`) guarded by `:?`-required `COLLAB_INTERNAL_TOKEN` only. Fine for local; the fail-fast pattern is applied inconsistently across the other secrets.
3. **Docker socket exposure**: both collab-server and ai-engine mount `/var/run/docker.sock` locally (mitigated by comments: never exposed to program env, capsule allowlist digest-pinned, `--pull=never`), but this remains the highest-trust surface in the dev stack; the k8s equivalent replaces it with the spawner RBAC + Sysbox path.
4. **Single-replica chokepoints**: collab-server (Recreate, in-memory Yjs + LevelDB heritage; README lists sticky-session/y-redis options), y-sweet floor 1 (until "Cloud Run cutover"), postgres StatefulSet ×1 — all acknowledged SPOFs with documented mitigations pending.
5. **Placeholder-tag discipline is good but load-bearing**: every manifest depends on the sed replace of `build-tag-required`; the pipeline double-checks no residue, and manual deploys are warned off raw `apply -k`.
6. **IAP everywhere**: all BackendConfigs enable IAP including preview subdomains; anything bypassing GCLB (e.g., direct NEG paths, Cloud Run during migration) must replicate that boundary.
7. **Health-probe subtleties encoded as comments**: collab readiness deadlock avoidance (`/debug/status` vs `/codesite/readiness`), GCE 30s WS-timeout fix via BackendConfig, signaling sidecar HTTP health target for the LB, DNS-via-node-local-dns NetworkPolicy pitfall — these are hard-won operational lessons worth preserving in any refactor.
8. **Repo housekeeping noise**: stray top-level files (`test-build-arg.Dockerfile`, an accidental `~/` directory, `temp.js`) sit next to the deployment configs; the `.gcloudignore` already works around untracked worktrees tripping the mutable-image guard on local builds.
9. **Therapeutic endpoint gating**: `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED=0` exists purely because 16 required Secret Manager entries were never created — the fastest concrete unlock for re-enabling the full Dojo production posture.

---

## Related notes

[[Environments and Ports]] · [[Repository Map]]

[[00 Home|🏠 Back to Home]]
