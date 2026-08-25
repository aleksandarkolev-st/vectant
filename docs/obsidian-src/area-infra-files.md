# Area: Infra & Deployment Files — Per-File Analysis

> Repo: `vectant-ade` (Synthi IDE / Vectant ADE). Every infra file gets its own section with line refs like `docker-compose.yml:L10`.
> Deployment reality in one line: **local dev = docker-compose (Windows/Docker Desktop friendly), prod beta + Agent Dojo release gate = GKE via Cloud Build** (`k8s/overlays/dojo-release-gate` is the deploy default), Cloud Run YAMLs are legacy.

## Table of Contents

1. [[#docker-compose.yml]]
2. [[#Overlay compose files]] (`docker-compose.nvidia.yml`, `docker-compose.gpu-amd.yml`, `docker-compose.local-ports.yml`)
3. [[#k8s base manifests]]
4. [[#k8s/sysbox/ — Sysbox runtime substrate]]
5. [[#k8s/overlays/dojo-release-gate/ — release-gate overlay]]
6. [[#cloudbuild.yaml]]
7. [[#scripts/deploy-prod.sh]]
8. [[#GitHub Actions workflows (.github/workflows)]]
9. [[#cloudrun/ legacy services]]
10. [[#ops/ PowerShell provisioners]]
11. [[#.env.example]]
12. [[#Dockerfiles]]

---

# 1. docker-compose.yml

Single file, 530 lines. Three logical bands: infrastructure (L2–61), core services (L63–420), WebRTC/MCP tier (L444–520). Named volumes at L522–527 (`ysweet-data`, `postgres-data`, `collab-data`, `codesite-shadow-scratch`, `agent-credentials`); one extra network `agent-egress` (L529–531). All host binds are `127.0.0.1:`-prefixed so nothing is LAN-exposed by accident.

## 1.1 postgres (L4–19)

| Aspect | Value |
|---|---|
| Image | `postgres:16-alpine@sha256:16bc17c64…` (digest-pinned, L5) |
| Ports | `127.0.0.1:${POSTGRES_HOST_PORT:-5432}:5432` (L11) |
| Env | `POSTGRES_USER=synthi`, `POSTGRES_PASSWORD=password`, `POSTGRES_DB=synthi` (L6–9, local-only creds) |
| Volumes | named `postgres-data:/var/lib/postgresql/data` (L13) |
| Healthcheck | `pg_isready -U synthi`, 5s interval / 5s timeout / 5 retries (L16–19) |
| Restart | `unless-stopped` (L14) |
| depends_on | none |

## 1.2 redis (L21–30)

Image `redis:7-alpine@sha256:6ab0b6e7…` (L22, digest-pinned). Port `127.0.0.1:${REDIS_HOST_PORT:-6379}:6379` (L24). Healthcheck `redis-cli ping` 5s/3s/5 retries (L27–30). No persistence — used for collab version history and signaling pub/sub.

## 1.3 y-sweet (L32–49)

Built from `backend/y-sweet/Dockerfile` → image `synthi-y-sweet`. Port `127.0.0.1:${YSWEET_HOST_PORT:-8180}:8080` (L38). Volume `ysweet-data:/data` (L40). Command `y-sweet serve /data --host 0.0.0.0 --port 8080` (L42). `Y_SWEET_AUTH_KEY=dev-secret` (L44) matches collab-server's L248. Healthcheck is a bash `/dev/tcp` probe on 8080 with 12 retries (L46–49).

## 1.4 runtime-image (L51–61)

Build-only service ("exits immediately"): builds `backend/runtime-image/Dockerfile` as `vectant-runtime:local` so a plain `docker compose up --build` produces the per-workspace runtime image without a separate docker build step (comment L51–53). `entrypoint ["/bin/sh","-c"]` + `command ["exit 0"]` (L59–60), `restart: "no"`.

## 1.5 frontend-migrate (L65–86)

One-shot Prisma migrate against compose Postgres before the app starts.
- Build: repo-root context, `synthi/Dockerfile`, **target `builder`** (L69) — reuses the frontend build stage instead of a dedicated image (contrast with prod's `synthi-prisma-migrate`).
- Build args L70–78: all `NEXT_PUBLIC_*` defaults derived from `${*_HOST_PORT}` vars (COLLAB 1234, YSWEET 8180, SIGNAL ws 9000, GATEWAY_WS 7071, CODE_INTEL/AI_ENGINE 8081).
- `command: ["npx","prisma","migrate","deploy"]` (L80); `DATABASE_URL: postgresql://synthi:***@postgres:5432/synthi` (L82).
- `depends_on: postgres: service_healthy` (L83–85); `restart: "no"` (L86).

## 1.6 frontend (L88–212)

Next.js 15 standalone app; the largest service block.
- Build L89–102: root context + `synthi/Dockerfile` (npm-workspace resolution of `@synthi/mcp-hub`, comment L90–91), same 8 `NEXT_PUBLIC_*` args as migrate.
- `env_file: ./.env.local` optional (L103–105).
- Ports L108–109: `127.0.0.1:${FRONTEND_HOST_PORT:-3000}:3000`.
- Volumes L110–122:
  - `.:/workspace:ro` (L113) — read-only workspace mirror for CodeSite snapshot validation;
  - `codesite-shadow-scratch:/workspace-shadow` (L119) — writable shadow-merge scratch; startup chown because named volumes only inherit image dir owner on first mount (comment L117–118);
  - `./tmp/codesite-dojo-proof/app-artifacts:/codesite-app-artifacts` (L122) — CodeSite proof artifact projection root.
- Environment highlights (L123–195): `NEXTAUTH_URL` (L126), `SYNTHI_APP_INTERNAL_URL=http://frontend:3000` (L127), `SYNTHI_CODESITE_TOKEN` default `local-compose-codesite-token` (L132), **`COLLAB_INTERNAL_TOKEN` required with `:?` error** (L136), Jupyter allow flags (L139–140), `AUTH_SECRET`/`NEXTAUTH_SECRET` defaulting to `local-compose-auth-secret` (L143–144), compose DB URL (L146), `SYNTHI_CODESITE_ARTIFACT_ROOT=/codesite-app-artifacts` (L147), shadow-runner command JSON + allowed root `/workspace-shadow` (L153–155), GCP metadata project `overview-synti` / bucket `synthi-cloud-storage` (L157–158), empty Cloudflare TURN + local TURN `turn:localhost:3478` creds synthi/synthi (L160–165), `CODE_INTEL_URL=http://ai-engine:8000` (L170, compose hostname not localhost), `COLLAB_SERVER_URL=http://collab-server:1234` (L177), `ENABLE_CONTAINER_RUNTIME=1` (L180), and the full `SYNTHI_CODESITE_PROOF_AUTHORITY_*` family incl. `_FILE` variants (L185–195).
- depends_on L196–206: `frontend-migrate service_completed_successfully`, `postgres healthy`, `y-sweet healthy`, `ai-engine started`, `collab-server started`.
- Healthcheck L207–212: node fetch of the internal readiness route `/api/workspace/__codesite_readiness__/codesite/readiness` with Bearer `SYNTHI_CODESITE_TOKEN`; 15s/5s/4 retries, start_period 20s.

## 1.7 collab-server (L214–313)

Node REST+WS hub. Build `./backend/collab-server` (L216–217). Port `127.0.0.1:${COLLAB_HOST_PORT:-1234}:1234` (L219).

Environment (L220–286): `COLLAB_PORT=1234`; `AUTH_SECRET`/`NEXTAUTH_SECRET` shared with frontend for terminal gateway JWT verification (L225–226); `SPAWNER_MODE=local` (L227); `SYNTHI_WORKSPACE_AUTH_BYPASS` passthrough (L228); local TURN pointed at `turn:coturn:3478` (L230–232); `CORS_ORIGIN` (L234); `SYNTHI_CODESITE_API_BASE_URL=http://frontend:3000/api/workspace/{workspace_slug}/codesite` (L239); `SYNTHI_CODESITE_TOKEN` must match frontend (L242); **`COLLAB_INTERNAL_TOKEN` same required-`:?` pattern as frontend** (L245); `CODE_INTEL_URL=http://ai-engine:8000` (L246); `YSWEET_URL`+`YSWEET_AUTH_KEY=dev-secret` (L247–248); `REDIS_URL=redis://redis:6379` — comment notes silent no-op of save-file-version history without it (L252); `REPOS_DIR`/`REPO_CACHE_DIR=/data/repos` (L254–255); `WORKSPACE_INSTRUCTION_METADATA_DIR=/data/...` on the writable volume because the image runs unprivileged (L259); container-runtime hybrid Phase 1 vars: `ENABLE_CONTAINER_RUNTIME=1` (L267), `RUNTIME_IMAGE=vectant-runtime:local` (L268), `WORKER_IMAGE=synthi-ide-worker:latest` (L274, matches compose tag to avoid Docker Hub 404), `WORKSPACE_DATA_VOLUME=vectant-ade_collab-data` (named volume not host bind — comment L275–278), shared gid/umask L283–284, `WORKER_NETWORK=vectant-ade_default` (L286).

Volumes L287–291: `collab-data:/data`; **`/var/run/docker.sock` bind** (L291) "used ONLY to manage per-workspace runtime containers", never mounted into runtimes (comment L289–290).

`group_add` L296–298: socket gid (`DOCKER_SOCKET_GID:-0`) + `SYNTHI_RUNTIME_SHARED_GID:-1000` so unprivileged synthi can use the root-owned socket and co-edit setgid workspace tree.

depends_on L299–307: redis healthy, y-sweet healthy, ai-engine started, `runtime-image completed_successfully`.

Healthcheck L308–313: node fetch `http://127.0.0.1:1234/codesite/readiness`, 15s/5s/4, start_period 20s.

## 1.8 signaling-server (L315–329)

Build `./backend/synthi-webrtc-compiler/signaling-server`. Port `127.0.0.1:${SIGNALING_HOST_PORT:-9000}:9000` (L320). Env: `SIGNALING_PORT=9000`, `REDIS_URL`, `COLLAB_SERVER_URL=http://collab-server:1234` (L322–324). depends_on redis healthy + collab started (L325–329). No healthcheck (K8s manifest adds tcpSocket probes instead).

## 1.9 ai-engine (L331–393)

Python FastAPI code-intel/RAG/failure-distiller service.
- Port mapping L338–341 keeps container port **8000 stable** while host defaults to 8081 (Windows host may bind 8000 already — comment).
- Volumes L348–354: `collab-data:/data` (**read-write required** — CodeIntel persists `.code_intel` index inside workspaces, previously 500'd RO, comment L342–347); second **docker.sock bind** for Failure Distiller capsules only (L354), which launch network-disabled, capability-dropped containers.
- `group_add: ["0"]` (L355–357) for Docker Desktop socket gid.
- Env L358–388: model `gemini-3.1-flash-lite-preview` (L359); workers/auth-disable knobs L361–362; critical comment L363–369: **do NOT redeclare GEMINI/OPENAI API keys here with `${VAR:-}` interpolation** — an empty value overrides `.env.local` and silently strips keys (embedder 500s); agent runner plumbing L372–379 (`vectant-agent-runner:local`, network `vectant-ade_agent-egress`, workspace volume `vectant-ade_collab-data` root `/data`, credentials volume `vectant-ade_agent-credentials` provisioned out-of-band, never inherited env); `SYNTHI_REPOS_PATH=/data/repos` (L384) with comment why there is NO depends_on cycle back to collab-server; `VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES` pinned `python:3.12-slim@sha256:2c941e86…` (L387) + `--pull=never` note.
- depends_on L389–393: `agent-runner-image completed_successfully` (image must exist before capsule acceptance).

## 1.10 agent-runner-image (L395–403)

Second build-only service: builds `ai-backend/agent-runner` as `vectant-agent-runner:local`, `command ["/bin/true"]`, `restart: "no"`, attached to `agent-egress` network (L402–403).

## 1.11 ai-gateway (L405–419)

Node WS→HTTP proxy. Port `127.0.0.1:${AI_GATEWAY_HOST_PORT:-7071}:7070` (L410). Env: `GATEWAY_PORT=7070`, `GATEWAY_WS_PATH=/ws`, `BACKEND_URL=http://ai-engine:8000`, `GATEWAY_CLUSTER=false`, auth disabled + insecure-local allowed (L412–417). depends_on ai-engine (L418–419).

## 1.12 coturn (L421–442)

TURN relay. Image `coturn/coturn:4.7.0-r2@sha256:203b9bf5…` (L422, digest-pinned). Ports L423–426: TCP+UDP 3478 and UDP relay range `49152-49200` (all loopback-bound). Inline command flags L428–440: `--no-tls --no-dtls --lt-cred-mech --user=synthi:synthi --realm=synthi.local --fingerprint --min-port=49152 --max-port=49200 --verbose --log-file=stdout`. No healthcheck; `restart: unless-stopped`.

## 1.13 mcp (L444–466)

Sleeper MCP container for live tests. Root-context build of `mcp/synthi-mcp/Dockerfile` (matches Cloud Build layout, L452–456). Only exposed port: Prometheus metrics `127.0.0.1:${MCP_METRICS_HOST_PORT:-9464}:9464` (L457–460). Comment L444–450 explains why it must share the worker subnet: direct host-ICE pairing avoids coturn's self-peer 403 (`CREATE_PERMISSION`). `AI_BACKEND_URL=http://ai-engine:8000` (L465). depends_on signaling-server + worker (L461–463).

## 1.14 worker (L468–520)

Rust+GStreamer WebRTC compile/stream worker.
- Build args L472–475: `WORKER_CARGO_FEATURES=${WORKER_CARGO_FEATURES:-gpu-hmr}`, `INSTALL_ROCM=false` — GPU toolchains come from overlays, base stays CI-safe.
- `restart: unless-stopped` (L482) with rationale comment: dead worker otherwise hangs every compile silently.
- Env L483–509: no SESSION_ID → registers `__legacy__` accepting any browser session (L484–486); `DISPLAY=:99`; `GST_DEBUG=2`; `RUST_BACKTRACE`/`RUST_LIB_BACKTRACE=full` (panic root-causing comments L496–500); verbose flags L504–505; `SYNTHI_GPU_HMR=${...:-0}` + `HSA_ENABLE_DXG_DETECTION` (L508–509) — base stack host-only so health/proof gates don't depend on `/dev/dxg`.
- Volumes: `collab-data:/data:ro` (L511).
- Hardening L512–516: `cap_drop: [ALL]`, `no-new-privileges:true`, `ipc: private`, `shm_size: "8gb"` (GStreamer/shared-mem).
- depends_on signaling-server + collab-server (L518–520).

## 1.15 Digest pinning inventory

Digest-pinned images: postgres (L5), redis (L22), coturn (L422), failure-distiller allowlist python (L387). Everything else is locally built tags. The `reject-mutable-images` CI step (see cloudbuild §6) enforces the same discipline for K8s manifests but does not parse this file.

---

# 2. Overlay compose files

## 2.1 docker-compose.nvidia.yml (36 lines)

NVIDIA/CUDA override; usage header L3–5 (`build worker` then `up -d --force-recreate worker mcp frontend`). Requires NVIDIA Container Toolkit (L7).
- `ai-engine.environment` (L12–15): `SYNTHI_GPU_VENDOR_HINT=cuda`, `SYNTHI_GPU_ARCH_HINT=${SYNTHI_GPU_ARCH:-}`.
- `worker` (L17–35): image override `${SYNTHI_WORKER_GPU_IMAGE:-vectant-ade-worker-gpu:local}` built from **`Dockerfile.gpu`** with `WORKER_CARGO_FEATURES=gpu-hmr`, `INSTALL_ROCM=true` (universal CUDA+ROCm image, header L8–9); env sets `SYNTHI_GPU_HMR=1`, vendor auto, CUDA_HOME/ROCM_PATH/LIBRARY_PATH/LD_LIBRARY_PATH chains (L28–31), `NVIDIA_VISIBLE_DEVICES=all`, `NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,video` (L32–33), clears `HSA_ENABLE_DXG_DETECTION` (L34); `gpus: all` (L35).

## 2.2 docker-compose.gpu-amd.yml (34 lines)

AMD/ROCm override for RX 9070 XT Windows/WSL (`/dev/dxg` + librocdxg bridge, header L3–5).
- `ai-engine`: `SYNTHI_GPU_VENDOR_HINT=rocm` (L10).
- `worker` (L13–34): same `Dockerfile.gpu` universal image; adds `SYNTHI_GPU_ARCH`/hints (L24–25), same CUDA+ROCm library paths (L26–29), **sets `HSA_ENABLE_DXG_DETECTION=1`** (L30), device `/dev/dxg:/dev/dxg` (L31–32), and ro-bind `/usr/lib/wsl/lib/libdxcore.so` into the container (L33–34). No `gpus:` key — AMD path relies on the dxg device node.

## 2.3 docker-compose.local-ports.yml (5 lines)

Minimal override: remaps redis to host `127.0.0.1:16379:6379` using Compose `!override` tag (L3–4) so it replaces rather than merges the base port list. Used when 6379 is taken on the host.

---

# 3. k8s base manifests

Namespace `synthi` throughout; `kustomization.yaml` is the entry point (`kubectl apply -k k8s/`). All app images use the placeholder tag `build-tag-required` that deploy tooling sed-replaces (see §6).

## 3.1 k8s/kustomization.yaml (57 lines)

- Header L1–22 documents manual apply order as an alternative to kustomize.
- `namespace: synthi` (L26).
- Resources in 5 groups (L28–53): foundation (namespace, configmap, spawner-rbac), datastores (postgres, redis), backend services (ai-engine, ai-gateway, y-sweet, collab-server, signaling-server), frontend+worker, hardening (**preview-certificate.yaml**, ingress, network-policies, PDBs).
- `commonLabels` L55–57: `app.kubernetes.io/managed-by: kustomize`, `app.kubernetes.io/part-of: synthi-ide`.
- Notably **absent**: `external-secrets.yaml` and both migrate Jobs (managed by CI, see cloudbuild §6) — though external-secrets IS included via overlays.

## 3.2 k8s/namespace.yaml (9 lines)

Single Namespace `synthi` with label `app.kubernetes.io/part-of: synthi-ide` (L4–9).

## 3.3 k8s/configmap.yaml — `synthi-config` (~60 keys, 128 lines)

Grouped key inventory:

| Group | Keys (L refs) |
|---|---|
| GCP | `GCP_PROJECT_ID=vectant-proj`, `GCS_BUCKET_NAME=vectant-synthi-cloud-storage`, `GCS_WORKSPACE_PREFIX=workspaces` (L13–15) |
| Cluster-internal URLs | `COLLAB_SERVER_URL`, `YSWEET_URL`, `CODE_INTEL_URL`, `BACKEND_URL` (ai-engine:8000), `SIGNALING_URL` (ws :9000), `REDIS_URL` (L18–23; all `<svc>.synthi.svc.cluster.local`) |
| Browser workflow bridge / hosted browser | `SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL=""`, `_TARGET_TEMPLATE=http://{runtimeId}.synthi…:{bridgePort}`, `_PORT=9466`; `SYNTHI_HOSTED_BROWSER_CDP_PORT=9222`, CDP target template + topology `runtime-service`, VIEW_PORT 6080, VNC_PORT 5900; bridge IMAGE AR ref `…synthi-browser-workflow-bridge:build-tag-required` (L26–36); external-open body limit/timeout L35–36 |
| Preview routing (Slice 4) | `SYNTHI_PREVIEW_TARGET_TEMPLATE` → `{runtimeId}-rt…{sidecarPort}{sidecarPrefix}/{port}` pod-local sidecar so user apps may bind localhost-only ports (L37–39 comment); PUBLIC_PREFIX `/collab`, PUBLIC_DOMAIN `preview.vectant.dev`, PROTOCOL https, SIDECAR_PORT 18080, SIDECAR_PREFIX `/__synthi_preview`, timeouts L45–46, SIDECAR_IMAGE `node:20-alpine`, SCAN_PORTS "", EXCLUDE_PORTS `8001,18000` (L48–52) |
| Terminal / spawner posture | `SYNTHI_TERMINAL_PORT_POOL=""`, `SYNTHI_TERMINAL_BACKEND=k8s-exec`, `SYNTHI_NO_JAIL=1`, `SYNTHI_TERMINAL_SCOPE_PORTS=false` (separate runtime pods → no port collisions, L56–59), `SYNTHI_PREVIEW_BIND_HOST=""` (L53–60) |
| Workspace data | `WORKSPACE_DATA_PVC=collab-data-pvc`, `WORKSPACE_DATA_MOUNT=/data`, `WORKSPACE_REPOS_PATH=/data/repos` (L61–63) |
| Public URLs | `NEXTAUTH_URL/CORS_ORIGIN/SYNTHI_PUBLIC_APP_URL=https://beta.vectant.dev`, internal app URL frontend:3000 (L66–69) |
| CodeSite authority | `SYNTHI_CODESITE_API_BASE_URL=http://frontend…:3000/api/workspace/{workspace_slug}/codesite` — MUST be set or hydration throws `active_authority_unavailable` blocking every runtime (comment L70–74, value L75) |
| NEXT_PUBLIC_* (bake-time) | collab/ysweet `https://beta.vectant.dev/collab`, COLLAB_PORT 443, signal `wss://beta.vectant.dev/signal`, gateway ws `/gateway/ws`, code-intel & ai-engine same-origin, `NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=true`, loopback auth bridge path, OAuth relay extension zip URL (L79–88) |
| Runtime callback bridge limits | body/response limit bytes, preview chars, timeout ms, OAuth relay TTL 300000 (L91–95) |
| Feature flags | `GCS_SYNC_ON_FLUSH=true`, `CODE_INTEL_AUTO_INDEX=true`, `FLUSH_DEBOUNCE_MS=150`, `TURN_CREDENTIAL_TTL=86400` (L98–101) |
| Worker tuning + images | `SYNTHI_LOG_LEVEL=info`, `SYNTHI_ISOLATION_MODEL=single_worker`, `WORKER_IMAGE=…synthi-worker:build-tag-required` (L104–107), `RUNTIME_POD_IMAGE=…vectant-runtime:build-tag-required` — rootful dind for Sysbox, read only when `RUNTIME_BACKEND=sysbox-pod`; header notes rootful build not yet validated at time of writing, TODO trivy gate (L108–116); Slice-4 preview note (one template per deploy) L117–122 |
| Node targeting | `WORKSPACE_NODE_SELECTOR_KEY/VALUE = cloud.google.com/gke-nodepool / workspace-pool`, taint key/value/effect `workload/workspace/NoSchedule` (L124–128) |

## 3.4 k8s/frontend.yaml — Deployment `frontend` + Service (272 lines)

Deployment (L12–251):
- replicas 2 (L22); podAntiAffinity preferred per-hostname (L39–49).
- Pod securityContext `runAsUser/runAsGroup: 0` (root — pragmatic, L35–37); `serviceAccountName: frontend-sa` (L38).
- Container image `…synthi/synthi-frontend:build-tag-required` (L52), port 3000 `http`.
- Env from secrets (`secretKeyRef synthi-secrets`): AUTH_SECRET, NEXTAUTH_SECRET, GOOGLE/GITHUB OAuth creds, `COLLAB_INTERNAL_TOKEN` (required, distinct from CodeSite token — comment L102–103), DATABASE_URL, AI_BACKEND_AUTH_TOKEN, GEMINI_API_KEY, optional OPENAI_API_KEY, optional Cloudflare TURN pair, `SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN`, `SYNTHI_RUNTIME_ID_SECRET` (L57–211). Optional secret: SYNTHI_CODESITE_TOKEN (missing degrades instead of crash-looping, L93–101).
- Env from configMap: NEXTAUTH_URL, COLLAB_SERVER_URL, OAuth relay TTL/URL, CODE_INTEL_URL (+ reused as AI_ENGINE_URL, L136–140), GCP ids, browser-workflow bridge trio, hosted-browser view port, preview domain/protocol/prefix, TURN TTL.
- Resources: req 200m/256Mi, lim 1 CPU/1Gi (L230–236).
- readinessProbe: exec node-fetch of the codesite readiness route w/ bearer token (L237–245); livenessProbe: GET /api/auth/providers:3000 (L246–251).
Service (L253–272): NodePort 3000, NEG annotation `cloud.google.com/neg {"ingress": true}` (L264) + BackendConfig `frontend-backend-config` (L263).

## 3.5 k8s/collab-server.yaml — Deployment + PVC + 2 Services (559 lines)

Header L1–13: stateless for CRDT (y-sweet handles docs), PVC only for repo cache; safe to multi-replica once repos are sharded.

Deployment (L14–500):
- replicas 1, **strategy Recreate** (L24–27) because of RWX/PVC semantics; nodeSelector default-pool; SA collab-server-sa.
- Two containers:
  - `collab` (L47–442): image `…synthi-collab-server:build-tag-required`, containerPort 1235 `app` (the app listens on 1235 behind an edge proxy). Env ~70 entries: NODE_OPTIONS max-old-space 2048; preview/bridge/hosted-browser knobs mirrored from configmap (L68–182 incl. WORKSPACE_PREP_* aliases L218–227); CORS/CODE_INTEL/AI_BACKEND_AUTH_TOKEN; `ENABLE_CODESITE_DOCKER_RUNTIME=0` — must be off because /var/run/docker.sock doesn't exist in pods and defaults ON in code (comment L260–266); CodeSite token optional + COLLAB_INTERNAL_TOKEN required (L270–282); AUTH/NEXTAUTH secrets NOT optional — missing fails closed on every terminal WS upgrade with 503 gateway_auth_unconfigured (comment L283–288); YSWEET_URL + optional auth key; REPOS_DIR/REPO_CACHE_DIR /data/repos, REPO_CACHE_DELETE_ON_EVICT=false; GCS trio + flags; TURN optional pair; spawner env K8S_NAMESPACE, WORKER_IMAGE, workspace node selector/taint quartet, IDLE_TIMEOUT_MS 300000, MAX_WORKSPACE_PODS 10, POD_READY_TIMEOUT_MS 300000, SPAWNER_CLEANUP_ON_SHUTDOWN=false (L367–407); literal REDIS_URL redis://redis.synthi…:6379 (L408–409). Volume mount `collab-data:/data` (L410–412). Resources req 500m/1Gi, lim 2/3Gi (L413–419). Readiness/liveness both GET `/debug/status`:1235 — deliberately NOT `/codesite/readiness`, which round-trips through the frontend and would deadlock a cold start under Recreate (long rationale comment L420–431).
  - `edge-proxy` (L443–496): `nginx:1.27-alpine@sha256:65645c7b…` digest-pinned; heredoc nginx.conf listening on **1234** (`http-ws` public port) with WS upgrade map, `/healthz` static 200, proxy_pass to 127.0.0.1:1235 with 3600s read/send timeouts (WS longevity). Tiny resources (25m→100m CPU). Readiness+liveness on `/healthz`:1234.
- Pod volume `collab-data` → PVC `collab-data-pvc` (L497–500).

PVC (L501–519): **RWX** `standard-rwx` storageClass (no enterprise multishare quota in europe-west10, comment L511–514), 100Gi shared runtime filesystem pool.

Services: `collab-server` NodePort 1234 with BackendConfig `collab-backend-config` + NEG (L521–539); `collab-preview` identical selector/port but separate BackendConfig `preview-backend-config` (L541–559) so preview subdomain traffic can carry its own policy.

## 3.6 k8s/ai-engine.yaml — Deployment + Service (104 lines)

- Deployment replicas 2, RollingUpdate maxSurge 0/maxUnavailable 1 (conservative memory footprint, L18–22); runAsUser/Group 0.
- Image `…synthi-ai-engine:build-tag-required`, port 8000.
- Env: GEMINI_API_KEY (required), OPENAI_API_KEY (optional), AI_BACKEND_AUTH_TOKEN (all from synthi-secrets, L45–60).
- Command uvicorn args L62–68: host 0.0.0.0, port 8000, `--workers=2`, keep-alive 120.
- Resources req 250m/512Mi, lim 2 CPU/2Gi; probes GET `/health`:8000 (readiness 10s delay, liveness 15s/30s).
- Service: ClusterIP 8000 (no NEG — cluster-internal only, L89–104).

## 3.7 k8s/ai-gateway.yaml — Deployment + Service (113 lines)

- Replicas 2 with hostname anti-affinity (L34–44); root pod SC.
- Image `…synthi-ai-gateway:build-tag-required`, containerPort 7070 `ws`.
- Env: GATEWAY_PORT 7070, **GATEWAY_WS_PATH=/gateway/ws** (differs from compose `/ws`), BACKEND_URL from configmap, GATEWAY_CLUSTER=false ("k8s handles scaling", L61–63), AI_BACKEND_AUTH_TOKEN, `GATEWAY_JWT_SECRET ← secret AUTH_SECRET` (L69–72).
- Resources 100m/128Mi → 500m/512Mi; probes `/gateway/health`:7070.
- Service NodePort 7070 + NEG + `gateway-backend-config`.

## 3.8 k8s/redis.yaml — Deployment + Service (74 lines)

Ephemeral signaling pub/sub Redis; "consider Memorystore" note (L7). Replicas 1, default-pool, root SC. Image digest-pinned same as compose (`redis:7-alpine@sha256:6ab0b6e7…`, L39) with args `--maxmemory 64mb --maxmemory-policy allkeys-lru` (L40). Resources 50m/64Mi → 250m/128Mi; exec `redis-cli ping` probes. Plain ClusterIP Service 6379.

## 3.9 k8s/postgres.yaml — StatefulSet + headless Service (109 lines)

Header recommends Cloud SQL for real prod; manifest suits staging/small prod (L6–8).
- StatefulSet `postgres`, serviceName postgres, replicas 1, default-pool, root SC.
- Digest-pinned postgres:16-alpine (same digest as compose, L39). Env POSTGRES_USER/PASSWORD/DB from synthi-secrets; `PGDATA=/var/lib/postgresql/data/pgdata` (subdir trick, L58–59).
- volumeClaimTemplate `postgres-data`: RWO, default StorageClass (pd-standard; premium-rwo suggestion L89), 10Gi.
- Probes `pg_isready -U synthi`; resources 250m/256Mi → 1 CPU/1Gi.
- Headless Service (`clusterIP: None`) port 5432 (L94–109).

## 3.10 k8s/y-sweet.yaml — Deployment + Service + HPA (133 lines)

- Deployment replicas 1 ("beta floor — single warm relay until Cloud Run cutover", L22), RollingUpdate surge 0/unavailable 1; default-pool; SA y-sweet-sa.
- Image `ghcr.io/jamsocket/y-sweet:latest@sha256:d61ba0fa…` (tag+digest, L48). Args serve --host 0.0.0.0 --port 8080.
- Env `Y_SWEET_STORE=gcs://$(GCS_BUCKET_NAME)/ysweet` (env-dependent expansion, L61–62) with bucket from configmap; Y_SWEET_AUTH_KEY optional from secret.
- tcpSocket probes :8080; resources 100m/128Mi → 1/512Mi.
- Service ClusterIP 8080 `http-ws`.
- HPA `y-sweet-hpa` (L112–133): min 1 max 4, CPU target 70%.

## 3.11 k8s/signaling-server.yaml — Deployment + Service + HPA (140 lines)

- Deployment replicas 1 (header says design supports 2+ via Redis pub/sub); default-pool + anti-affinity; root SC.
- Main container `signaling`: image `…synthi-signaling-server:build-tag-required`, port 9000 ws; env SIGNALING_PORT, REDIS_URL from configmap, COLLAB_SERVER_URL literal `http://collab-server:1234`; tiny resources (50m/32Mi → 250m/128Mi); tcpSocket probes.
- Sidecar `healthz` (L77–91): `hashicorp/http-echo:0.2.3@sha256:ba27d460…` serving "ok" on 8080 — gives the GCLB a plain HTTP health endpoint since the Rust binary only speaks WS.
- Service NodePort exposing BOTH 9000 (ws) and 8080 (health) + `signaling-backend-config` + NEG (L93–114).
- HPA `signaling-server-hpa`: 1→4 @ 70% CPU (L119–140).

## 3.12 k8s/worker.yaml — Deployment (163 lines, disabled)

Header L1–23 documents three scaling approaches; this manifest uses manual-with-downward-API (SESSION_ID = pod name). **`replicas: 0`** (L33): collab-server spawns worker pods dynamically instead.
- Targets workspace-pool via nodeSelector (L48–50), tolerates `workload=workspace:NoSchedule` (L51–55), SA workspace-runtime-sa, anti-affinity spread, terminationGracePeriod 15s (GStreamer drain, L67).
- Container: image `…synthi-worker:build-tag-required`, `allowPrivilegeEscalation: true` (needed by compile toolchain), command wraps PATH then `exec worker` (L75–79). Env: SESSION_ID downward API, SIGNALING_URL/COLLAB_SERVER_URL/AI_BACKEND_URL(→CODE_INTEL_URL key)/GCP ids from configmap, AI_BACKEND_AUTH_TOKEN secret, GST_DEBUG=2, DISPLAY=:99, log level + isolation model from configmap.
- Resources **req 2 CPU/4Gi, lim 6 CPU/12Gi** (L137–143).
- Liveness = `pgrep -f worker` (no inbound ports, L145–149). Mounts: `dshm` emptyDir Memory 512Mi (/dev/shm IncrementalCache) + `tmp` emptyDir 2Gi (L151–163). fsGroup 1000 + RuntimeDefault seccomp at pod level (L42–47).

## 3.13 k8s/ingress.yaml — cert, FrontendConfig, 5 BackendConfigs, Ingress (200 lines)

| Resource | Lines | Key facts |
|---|---|---|
| ManagedCertificate `synthi-managed-cert` | L1–10 | domain beta.vectant.dev |
| FrontendConfig `synthi-frontend-config` | L12–23 | HTTP→HTTPS redirect, MOVED_PERMANENTLY_DEFAULT |
| BackendConfig `frontend-backend-config` | L24–45 | IAP enabled, timeout 300s, drain 30s, healthCheck HTTP `/api/auth/providers`:3000 (15s/5s, 1 healthy / 3 unhealthy) |
| BackendConfig `collab-backend-config` | L46–67 | IAP, **timeoutSec 3600** (WS), healthCheck `/healthz`:1234 |
| BackendConfig `preview-backend-config` | L68–91 | same shape as collab; comment: preview subdomains are public routes behind the same identity boundary |
| BackendConfig `gateway-backend-config` | L92–113 | IAP, 3600s, healthCheck `/gateway/health`:7070 |
| BackendConfig `signaling-backend-config` | L114–135 | IAP, 3600s, healthCheck `/`:8080 (the http-echo sidecar) |
| Ingress `synthi-ingress` | L136–200 | class gce; allow-http true + global static IP `synthi-ip` + managed cert + FrontendConfig annotations; TLS section lists wildcard `*.preview.vectant.dev` via Secret `preview-wildcard-tls` (cert-manager); defaultBackend frontend:3000 |

Route table (rules L159–200):

| Host | Path | Backend |
|---|---|---|
| beta.vectant.dev | /collab | collab-server:1234 |
| beta.vectant.dev | /signal | signaling-server:9000 |
| beta.vectant.dev | /gateway | ai-gateway:7070 |
| beta.vectant.dev | / (default) | frontend:3000 |
| *.preview.vectant.dev | / | collab-preview:1234 |

## 3.14 k8s/preview-certificate.yaml (35 lines)

cert-manager: ClusterIssuer `letsencrypt-preview-dns` (ACME prod server, email aleksandar.kolev@vectant.dev, **DNS-01 solver scoped to dnsZone preview.vectant.dev via CloudDNS project vectant-proj**, L8–19) + Certificate `preview-wildcard-cert` issuing Secret `preview-wildcard-tls` for `preview.vectant.dev` + `*.preview.vectant.dev` (L21–35). This is what backs the ingress TLS block.

## 3.15 k8s/network-policies.yaml (351 lines) — rule groups

Requires Dataplane V2/Calico (header L5–8). Grouped:

1. **default-deny-ingress** (L12–23): namespace-wide deny-all ingress baseline.
2. **GCLB → public services** (L25–127): four near-identical policies allowing Google LB health-check/proxy CIDRs `35.191.0.0/16` + `130.211.0.0/22` to frontend:3000 (L29–49), collab-server:1234 (L54–74), signaling-server:9000+8080 (L79–101), ai-gateway:7070 (L106–126).
3. **Cluster-internal allows**: y-sweet accepts only collab-server:8080 (L131–150); ai-engine accepts ai-gateway/collab-server/app=workspace pods on 8000 (L155–180); redis accepts collab-server + signaling-server on 6379 (L184–207); postgres accepts frontend + app=prisma-migrate pods on 5432 (L212–234) — note migrate Job template labels itself app=prisma-migrate so it passes this policy.
4. **Workspace pods ingress** (L238–274): app=workspace accepts collab-server on 8080+18080 (health/preview sidecar), frontend on 9466 (workflow bridge), dojo-mcp-host on 9222 (CDP).
5. **Runtime pods ingress** (Slice 4, L277–302): app=runtime ← collab-server :18080 only (preview sidecar). Mirrors #4; inert until RUNTIME_BACKEND=sysbox-pod.
6. **runtime-egress-hardening** (Slice 6, L305–351): app=runtime egress = DNS UDP/TCP 53 to ALL destinations (long validated-on-Dataplane-V2 comment why kube-dns podSelector fails: NodeLocal DNSCache answers from node IP in 10/8, L329–336) + `0.0.0.0/0` except RFC1918 trio + 169.254.0.0/16 (blocks lateral movement AND the metadata server; L344–351). Deferred items noted L313–314 (bandwidth cap, Falco flow logs, dedicated egress IPs).

## 3.16 k8s/pod-disruption-budgets.yaml (72 lines)

Four PDBs, all `minAvailable: 1`, policy/v1: `frontend-pdb` (L12–24), `ai-gateway-pdb` (L26–38), `signaling-server-pdb` (L40–54), `y-sweet-pdb` (L56–71). Comments cite expected HPA ranges (frontend 2–8, gateway 2–6). No PDB for collab-server (Recreate strategy makes it moot) or postgres (single replica).

## 3.17 k8s/spawner-rbac.yaml (104 lines)

- 4 ServiceAccounts, all annotated to GCP SA `synthi-gcs-sa@vectant-proj.iam.gserviceaccount.com` via Workload Identity (L17–51): `collab-server-sa`, `frontend-sa`, `y-sweet-sa`, `workspace-runtime-sa`.
- Role `workspace-spawner` (L53–88): deployments get/list/create/patch/delete/watch; pods get/list/watch; pods/log get; **pods/exec get+create** (terminal service); services get/list/create/delete; jobs get/list/create/delete/watch; jobs/status get/watch. Comment names the opaque `rt-<base32-hmac>` naming scheme.
- RoleBinding `collab-server-spawner` binds collab-server-sa to that Role (L90–104).

## 3.18 k8s/external-secrets.yaml (142 lines)

Prereqs header: ESO helm install, create-gcp-secrets.sh, workload-identity-setup.sh (L4–15).
- ServiceAccount `eso-service-account` annotated `iam.gke.io/gcp-service-account: synthi-eso-sa@vectant-proj…` (L18–26).
- SecretStore `gcp-secret-manager` (gcpsm, projectID vectant-proj, workloadIdentity clusterLocation europe-west10-a / clusterName synthi-beta-cluster / SA ref eso-service-account, L30–47).
- ExternalSecret `synthi-secrets`: refreshInterval 1h, target name `synthi-secrets` matching all existing secretKeyRefs, **creationPolicy Orphan** (don't take over manual Secrets) + deletionPolicy Retain (L58–66). Mapped keys (remoteRef → secretKey):
  - Postgres: synthi-database-url, -postgres-user/-password/-db (L68–80)
  - NextAuth/OAuth: auth-secret, nextauth-secret, google client id/secret, github id/secret (L83–100)
  - AI/runtime tokens: ai-backend-auth-token, runtime-id-secret, token-encryption-key, browser-workflow-bridge-token, private-workflow-tool-store-key, auth-checkpoint-store-key, gemini-api-key (L103–123)
  - Y-Sweet: ysweet-auth-key (L126–128)
  - CodeSite split trust boundaries: codesite-token + collab-internal-token with explicit do-not-reuse comments (L131–142)

## 3.19 k8s/prisma-migrate-job.yaml (63 lines)

Batch Job `prisma-migrate`, ns synthi. Usage header shows the canonical CI invocation pattern (delete job → sed tag → apply → wait complete → logs, L9–15). Rationale for Job vs initContainer (idempotent/decoupled/auditable/backoffLimit) L17–22. **Deliberately excluded from kustomization** (L24–25). Spec: backoffLimit 3, activeDeadlineSeconds 300, ttlSecondsAfterFinished 3600; container `migrate` image `…synthi-prisma-migrate:build-tag-required`, env DATABASE_URL from synthi-secrets; resources 100m/256Mi → 500m/512Mi; restartPolicy Never; root SC.

## 3.20 k8s/dojo-postgres-migrate-job.yaml (42 lines)

Second migration Job for Dojo schemas. Intentionally not in kustomization; applied explicitly by Cloud Build after ESO sync and BEFORE app rollout so failure stops release cleanly (header L6–8). backoffLimit **0** (fail-fast), activeDeadlineSeconds 300, ttl 3600. Container reuses the `synthi-mcp-http` image running `npm run proof:dojo:postgres:migrate -- --out-dir /tmp/dojo-postgres-migrate` (L33–37); envFrom **both** `synthi-secrets` and `synthi-dojo-release-secrets` (L38–42) — needs the overlay's release secrets to exist first.

## 3.21 k8s/secrets.yaml.example (59 lines)

Manual-secret fallback template (gitignored when copied to secrets.yaml): Opaque Secret `synthi-secrets` with CHANGEME_BASE64 placeholders grouped Postgres / NextAuth-OAuth / GCS service account (GCP_CLIENT_EMAIL+PRIVATE_KEY) / Cloudflare TURN / AI keys incl. OPENAI_API_KEY, SYNTHI_RUNTIME_ID_SECRET (HMAC for rt-names, don't rotate casually), SYNTHI_TOKEN_ENCRYPTION_KEY (32-byte b64), workflow-bridge token, private-workflow-tool + auth-checkpoint store keys, GEMINI_API_KEY, COLLAB_INTERNAL_TOKEN (distinct from codesite token).

## 3.22 k8s/create-gcp-secrets.sh (73 lines) & k8s/workload-identity-setup.sh (126 lines)

create-gcp-secrets.sh: parses **remoteRef.key entries out of both external-secrets.yaml and the dojo overlay's dojo-release-external-secrets.yaml via awk** (L23–41), creates each empty Secret Manager secret idempotently (`gcloud secrets describe` check, L54–61), prints add-version instructions. PROJECT_ID default vectant-proj.

workload-identity-setup.sh: creates 3 GCP SAs — synthi-grants: synthi-gcs-sa (storage.objectAdmin on gs://vectant-synthi-cloud-storage via gsutil, L55–59), synthi-eso-sa (roles/secretmanager.secretAccessor, L62–68), synthi-dojo-mcp-sa (roles/cloudkms.signerVerifier on keyring synthi-dojo / key dojo-proof-signing, env-overridable location/keyring/key, L70–78). Then WI bindings: 4 KSA→synthi-gcs-sa, eso-service-account→synthi-eso-sa, dojo-mcp-host-sa→synthi-dojo-mcp-sa (L85–113). Ends with verification listing + smoke-test hint (L118–126).

---

# 4. k8s/sysbox/ — Sysbox runtime substrate (Phase 2 Slice 0)

Purpose: `runtimeClassName: sysbox-runc` substrate so a per-workspace pod runs a full Docker daemon with **no privileged flag and no host docker.sock** (root-inside-userns mapped to unprivileged host UIDs).

## 4.1 sysbox/README.md (115 lines)

Explains the dedicated SCRATCH cluster decision: prod synthi-beta-cluster is REGULAR channel where node auto-upgrade can only be deferred, and upgrades wipe the on-node install; scratch uses channel None + pinned version + no autoupgrade (L11–18). File table (L20–27). Runbook B1–C2: create cluster/pool (gated), rehost+digest-pin the sysbox image into AR (one pull/push at a time lesson, L39–53), apply DaemonSet (~1–2 min, node gets label sysbox-runtime=running), smoke test proving userns dind without privileged, and Spike-5 upgrade re-convergence rehearsal (delete the GCE instance, watch self-heal, record recovery window, L77–88). Operational policy codified: warm node floor ≥1, maintenance-exclusion strategy on prod, PDB for runtime pods later, honest "resuming" UI state during reinstall window (L90–103). Teardown + promotion checklist (add sysbox image to cloudbuild vuln scan list) L104–116.

## 4.2 sysbox/kustomization.yaml (18 lines)

Standalone on purpose: NO namespace override and NO labels — the top-level kustomization would force the DaemonSet/SA out of kube-system and mutate the cluster-scoped RuntimeClass (header L6–10). Single resource sysbox-install.yaml; targets nodes labeled sysbox-install=yes.

## 4.3 sysbox/sysbox-install.yaml (210 lines, vendored v0.7.0)

Vendored from nestybox upstream with exactly two documented local mods (audit instructions L6): (1) added toleration for taint `workload=sysbox:NoSchedule` (L87–91); (2) image re-hosted to `europe-west10-docker.pkg.dev/vectant-proj/synthi/sysbox-deploy-k8s:v0.7.0-0@sha256:c7859de4…` (L94–95) passing reject-mutable-images.
Contents: SA `sysbox-label-node` + ClusterRole/Binding (nodes get/patch, pods get/list/delete/watch, L25–55); ConfigMap `sysbox-operational-attributes` (empty MGR/FS configs, L56–64); **privileged DaemonSet** `sysbox-deploy-k8s` (privileged is expected here — it installs sysbox-runc+CRI-O on the node) with nodeSelector sysbox-install=yes, NODE_NAME downward env, 16 hostPath mounts (etc/dbus/systemd/sysctl/bin dirs/var-lib, L148–196), rollingUpdate maxUnavailable 1 (L197–200); cluster-scoped **RuntimeClass `sysbox-runc`** with handler sysbox-runc and scheduling nodeSelector sysbox-runtime=running (L202–210).

## 4.4 sysbox/smoke-pod.yaml (58 lines)

Acceptance test (Slice 0 step C1): Pod `sysbox-smoke-test` in default ns with `runtimeClassName: sysbox-runc`, **`hostUsers: false`** — REQUIRED for the containerd CRI userns path; without it sandbox creation fails with `mount through procfd: operation not permitted` (issue #1006 symptom; needs k8s ≥1.33 + containerd ≥2.0.5; prod runtimePodSpec.js already sets it — comment L26–32). Toleration workload=sysbox. Container runs `docker:27-dind` fully-qualified with DOCKER_TLS_CERTDIR empty, **`privileged: false`** — the whole thesis (L49–52). 250m/512Mi → 1/1Gi. Verification commands in header (docker run hello-world, SecurityOptions expect `name=userns`).

## 4.5 sysbox/create-scratch-cluster.ps1 (97 lines)

Idempotent provisioner (existence detected via gcloud describe EXIT CODE, not stdout — background-run capture bug documented L12–15; $ErrorActionPreference Continue so native stderr doesn't derail control flow, L21–23). Params: project vectant-proj, zone europe-west10-a, cluster synthi-sysbox-scratch pinned to 1.35.3-gke.2190000 (prod parity), default pool e2-medium ×1. Creates: cluster with `--release-channel None`, shielded nodes ON but Secure Boot OFF, **`--enable-dataplane-v2`** (required to ENFORCE NetworkPolicy egress hardening; legacy dataplane doesn't), pd-standard 50GB (billing lesson #36 vs regional SSD quota), no autoupgrade/autorepair; then `sysbox-pool`: UBUNTU_CONTAINERD (COS unsupported by Sysbox — RO rootfs), e2-standard-4, num-nodes 1 warm floor, no auto-upgrade/repair, labels sysbox-install=yes, taints workload=sysbox:NoSchedule, Secure Boot stays OFF so Sysbox can load unsigned shiftfs module (comment L82–84). Ends with get-credentials + next-step hints.

---

# 5. k8s/overlays/dojo-release-gate/ — release-gate overlay

The production deploy default (both deploy-prod.yml and deploy-prod.sh point `_KUSTOMIZE_DIR` here). Opt-in: base `k8s/` stays beta-compatible.

## 5.1 kustomization.yaml (71 lines)

- namespace synthi; resources = the full base set **plus** `dojo-release-external-secrets.yaml` and `dojo-mcp-host.yaml` (L9–26). Notably includes external-secrets.yaml (base kustomization does not).
- patches (L28–64):
  1. `dojo-release-config.yaml` — configmap posture values.
  2. `redis-secret-env.patch.yaml` — REDIS_URL from release secret on collab + signaling.
  3. JSON patch targeting Ingress synthi-ingress → adds `/dojo/mcp` and 3 `/therapeutic/*` routes.
  4. Inline remove op: deletes `/data/REDIS_URL` from ConfigMap synthi-config.
  5–6. Inline `$patch: delete` of NetworkPolicies `allow-to-redis` and `allow-to-postgres` (in-cluster datastores are gone in this render).
- labels block with includeSelectors:false/includeTemplates:true re-applying the two common labels (L66–72).

## 5.2 README.md (100 lines)

Documents the three-fold purpose: remove in-cluster Postgres+Redis (+ their NetworkPolicies), route Redis through synced `synthi-dojo-release-secrets/REDIS_URL`, add fail-closed Dojo production posture, expose therapeutic runtime endpoints, sync Dojo-only Secret Manager values via ESO (L8–20). Render command requires `--load-restrictor LoadRestrictionsNone` because bases live directly under k8s/ not k8s/base/ (L24–41); validation via `node mcp/synthi-mcp/scripts/dojo-kustomize-overlay-check.mjs --expected-dojo-mcp-host=$env:DOMAIN --expected-dojo-mcp-path=/dojo/mcp --expected-dojo-mcp-bearer-header=X-Synthi-Dojo-Mcp-Token` (L31–36). Lists the ~37 required Secret Manager names added by the overlay (L50–89) incl. all 16 `synthi-therapeutic-prod-*`. Policy notes: proof-signing private key deliberately NOT synced (must use managed-key-service / signing command); MCP manifest signer still uses a local Ed25519 key pending managed-signer maturity (L91–95); therapeutic URLs must be externally reachable HTTPS or the gate rejects loopback/test/demo/file values (L97–101).

## 5.3 dojo-release-config.yaml (24 lines)

ConfigMap synthi-config additive keys:
- Fail-closed posture: SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1, REQUIRE_DURABLE_STORE=1, CONTROL_PLANE_STORE=postgres, REQUIRE_EXTERNAL_SIGNING=1, PROOF_SIGNING_PROVIDER=managed-key-service, REQUIRE_EVIDENCE_LEDGER=1, EVIDENCE_LEDGER_STORE=postgres (L7–13).
- MCP manifest identity: ISSUER=synthi-dojo-skill-bus-prod, ALGORITHM=ed25519 (L14–15).
- **SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED="0"** — flag-gated OFF because the 16 therapeutic secrets were never created; ESO couldn't sync the ExternalSecret at all and blocked every unrelated service (comment L16–19, incident detailed in §5.6).
- Hosted browser hardening: ORIGIN_ALLOWLIST=https://beta.vectant.dev, SESSION_TTL_MS=3600000, REDACT_SCREENSHOTS=true (L21–23). TENANT_ID=vectant (L24).

## 5.4 dojo-release-external-secrets.yaml (95 lines)

ExternalSecret `synthi-dojo-release-secrets`: refreshInterval 1h, same SecretStore, **creationPolicy Owner** (contrast Orphan for synthi-secrets), deletionPolicy Retain (L9–16). Synced keys: REDIS_URL←synthi-redis-url; dojo control-plane + evidence-ledger Postgres URLs; proof-signing quintet (key-id/command/command-args/managed-key-uri/public-key-pem); MCP manifest trio (key-id/private-pem/public-pem); MCP bearer token; hosted-browser CDP + workspace URLs; workspace/agent ids; private-workflow-tool trio (store-file/scope/store-key); auth-checkpoint trio (store-file/scope/store-key).
The big comment block (L54–65) records the outage: the 16 SYNTHI_THERAPEUTIC_PROD_* entries were wired in on 2026-07-01 (a6eefa6aa) but never created in vectant-proj → SecretSyncedError "Secret does not exist" → deploy blocked at `kubectl wait externalsecret/synthi-dojo-release-secrets` taking every unrelated service down (builds 41bc0262/d53d7cd2 failed exactly there); removal + feature flag documented as restore path.

## 5.5 dojo-mcp-host.yaml (283 lines)

Five documents:

| Doc | Lines | Content |
|---|---|---|
| BackendConfig `dojo-mcp-host-backend-config` | L1–21 | IAP enabled, timeout 3600s, drain 30s, healthCheck `/healthz`:9467 |
| ServiceAccount `dojo-mcp-host-sa` | L23–32 | WI-annotated to `synthi-dojo-mcp-sa@vectant-proj…` |
| Deployment `dojo-mcp-host` | L33–223 | replicas 1, Recreate strategy, default-pool |
| PVC `dojo-mcp-data-pvc` | L225–238 | standard-rwo RWO 1Gi |
| Service `dojo-mcp-host` | L240–260 | NodePort 9467 http-mcp + BackendConfig + NEG annotation |
| NetworkPolicy `allow-to-dojo-mcp-host` | L262–283 | GCLB CIDRs only → :9467 |

Deployment containers:
- `dojo-mcp-host` (L59–126): image `…synthi-mcp-http:build-tag-required`, port 9467. **envFrom everything**: configmap synthi-config + secret synthi-secrets + secret synthi-dojo-release-secrets (L65–71). Env pins HTTP host/port/path (`/dojo/mcp`) + health path + **bearer header `X-Synthi-Dojo-Mcp-Token`** (L73–82); vision backend agent_side; hosted-browser CDP topology forced to **same-pod** with CDP URL loopback expansion `http://127.0.0.1:$(SYNTHI_HOSTED_BROWSER_CDP_PORT)` and empty target template override (L85–94). Probes on /healthz (readiness 5s/10s/t3/f3; liveness 10s/20s/t5/f3). Resources 250m/512Mi → 1 CPU/1Gi. Hardened SC: allowPrivilegeEscalation false, drop ALL caps (L122–126). Mounts dojo-mcp-data at /var/lib/synthi/dojo.
- `hosted-browser` sidecar (L127–212): image `…synthi-browser-workflow-bridge:build-tag-required`; long bash script launches Xvfb :99 (1366x768x24), x11vnc localhost-bound, websockify/noVNC on VIEW_PORT, then Playwright-resolved Chromium with remote debugging bound 0.0.0.0 on CDP_PORT and profile under /tmp; trap-based cleanup waiting on browser PID (L130–160). Readiness+liveness exec probes fetch BOTH `http://127.0.0.1:$CDP/json/version` AND noVNC vnc.html (L177–196). Resources 200m/512Mi → 2 CPU/2Gi; runs as root w/ allowPrivilegeEscalation true (needed for X stack). dshm 512Mi Memory + tmp 2Gi emptyDirs.

## 5.6 dojo-mcp-ingress.patch.yaml (40 lines)

JSON6902 additions to Ingress rule[0] paths index 3..6, each Prefix → service dojo-mcp-host:9467: `/dojo/mcp`, `/therapeutic/runtime-authorization`, `/therapeutic/runtime-state`, `/therapeutic/incident-response`.

## 5.7 redis-secret-env.patch.yaml (37 lines)

Strategic-merge patches replacing the literal/config REDIS_URL env on Deployment/collab-server container `collab` and Deployment/signaling-server container `signaling` with `valueFrom.secretKeyRef {synthi-dojo-release-secrets / REDIS_URL}` ($patch: replace). Pairs with the kustomization's deletion of the configmap REDIS_URL key so nothing points at the removed in-cluster Redis.

---

# 6. cloudbuild.yaml (554 lines)

Trigger: push to main (header L4). Build = parallel Kaniko, deploy = kubectl.

## 6.1 Substitutions & options (L27–60)

_REGION europe-west10, _GKE_CLUSTER synthi-beta-cluster, _GKE_ZONE europe-west10-a, _REGISTRY derived `${_REGION}-docker.pkg.dev/${PROJECT_ID}/synthi`, _MANIFEST_SOURCE_REGISTRY hardcoded to the AR repo (sed source), _IMAGE_TAG=${BUILD_ID} default, _KUSTOMIZE_DIR + _DOJO_RELEASE_KUSTOMIZE_DIR both defaulting to the overlay, _KUSTOMIZE_LOAD_RESTRICTOR=LoadRestrictionsNone. Nine `_NEXT_PUBLIC_*` bake-time substitutions mirror the configmap public URLs (L40–48). _WORKER_INSTALL_ROCM=false; _ENABLE_VULNERABILITY_SCAN=false (beta velocity; L49–50). Options: E2_HIGHCPU_32, 200GB disk, CLOUD_LOGGING_ONLY, dynamic_substitutions true. Timeout 3600s (L554).

## 6.2 Step graph

```
reject-mutable-images ──┬─ prepare-frontend-env ── build-frontend ── build-signaling ── build-worker
                        ├─ build-collab-server
                        ├─ build-ai-engine          } all fan into vulnerability-scan-images
                        ├─ build-ai-gateway         }
                        ├─ build-prisma-migrate     }
                        ├─ build-browser-workflow-bridge }
                        ├─ build-dojo-mcp-host      }
                        ├─ build-runtime-image      }
                        └──────────────► get-gke-credentials ► verify-kubectl-auth ► deploy-to-gke
```

## 6.3 Steps detail

1. **reject-mutable-images** (L63–76): gcloud builder digest-pinned; grep -RInE over Dockerfile*/yaml/yml for bare `:latest` refs in FROM/image:/name:/--destination= excluding cloudbuild.yaml itself; fails the build on mutable tags. Supply-chain gate #1.
   - Comment block L78–93 explains why CodeSite proof suite + release gate do NOT run here (Cloud Build source is a tarball without .git; provenance validation needs host git; steps existed 2026-07-03→07-05 and never passed; removed 2026-07-28). Manual submits therefore have NO CodeSite gate unless run on host first.
2. **prepare-frontend-env** (L100–127): ubuntu:25.10 digest-pinned writes synthi/.env.production from the _NEXT_PUBLIC_* substitutions for Kaniko layer caching.
3. **build-frontend** (L130–149): Kaniko executor pinned by digest; dockerfile synthi/Dockerfile, root context dir:///workspace (workspace resolution comment), destination synthi-frontend:${_IMAGE_TAG}, 9 NEXT_PUBLIC build-args, cache true ttl 168h.
4. **build-collab-server** (L152–160): backend/collab-server context → synthi-collab-server.
5. **build-ai-engine** (L163–171): → synthi-ai-engine.
6. **build-ai-gateway** (L174–182): → synthi-ai-gateway.
7. **build-signaling** (L185–193): waits on build-frontend (serialization heuristic), own context → synthi-signaling-server.
8. **build-worker** (L196–206): waits signaling; INSTALL_ROCM arg passthrough; timeout 1800s (large Rust/GStreamer image).
9. **build-prisma-migrate** (L209–217): synthi/Dockerfile.migrate, context synthi/ → synthi-prisma-migrate.
10. **build-browser-workflow-bridge** (L220–229): mcp/synthi-mcp/Dockerfile.workflow-bridge, ROOT context (mcp-hub file dependency comment), cache=false → synthi-browser-workflow-bridge.
11. **build-dojo-mcp-host** (L232–259): kaniko debug image w/ busybox shell; normalizes KUSTOMIZE_DIR and skips silently (exit 0) unless it equals DOJO_RELEASE_KUSTOMIZE_DIR; else builds mcp/synthi-mcp/Dockerfile.http root-context → synthi-mcp-http:${_IMAGE_TAG}, cache=false. Conditional release-gate-only image.
12. **build-runtime-image** (L262–279): backend/runtime-image/Dockerfile with ROOTFUL args: RUNTIME_BASE=docker:dind@sha256:ad68e89b…, RUNTIME_USER=root, RUNTIME_HOME=/root, DOCKER_SOCK=/var/run/docker.sock (rootless variant crash-loops under Sysbox — rootlesskit can't nest userns, comment L262–266) → vectant-runtime:${_IMAGE_TAG}.
13. **vulnerability-scan-images** (L287–341): trivy 0.71.0 pinned; skipped unless _ENABLE_VULNERABILITY_SCAN=true; scans CRITICAL severity exit-code 1 across the whole fleet (frontend, collab, ai-engine, ai-gateway, signaling, worker, prisma-migrate, workflow-bridge; + synthi-mcp-http when overlay selected); runtime image scanned separately honoring committed waiver file `backend/runtime-image/.trivyignore` (known base-bundled grpc CVE).
14. **get-gke-credentials** (L347–367): after ALL builds+scan; gcloud get-credentials.
15. **verify-kubectl-auth** (L369–378): `kubectl get namespace synthi` sanity.
16. **deploy-to-gke** (L380–552): the meat — see below.

## 6.4 deploy-to-gke internals

- Guards: normalize+validate kustomize dir (no absolute/no `..`, must contain kustomization.yaml), load restrictor must be LoadRestrictionsNone if set, manifest source registry non-empty (L395–420).
- Render-once pattern: `kubectl kustomize` → `.cloudbuild/synthi-k8s.yaml`, sed registry → _REGISTRY and `build-tag-required` → tag, then **grep-fails if any placeholder survives** (L422–437). Prevents briefly rolling Deployments to placeholder images.
- `apply_rendered_manifest()` (L439–468): apply; on failure parses "Deployment … is invalid: spec.selector" errors (immutable selector drift) and self-heals by delete/wait/reapply of affected Deployments only.
- Dojo branch (when KUSTOMIZE_DIR == DOJO_RELEASE_KUSTOMIZE_DIR):
  - `bash scripts/validate-dojo-release-render.sh "$RENDERED"` contract check (L471–472).
  - awk extracts ONLY ExternalSecret/SecretStore/eso-SA docs from the render into synthi-secret-prereqs.yaml, fails if empty, applies them, then **blocks on `kubectl wait --for=condition=Ready` for BOTH externalsecret/synthi-secrets and externalsecret/synthi-dojo-release-secrets (180s)** — this is exactly where the therapeutic-secrets outage surfaced (L474–497).
  - Dojo migrations: delete job → sed-tag k8s/dojo-postgres-migrate-job.yaml → apply → wait complete 300s; on failure dumps migrate logs and exits non-zero; success tails last 100 log lines (L499–508).
- Prisma migrations always: same delete→sed→apply→wait→logs pattern against k8s/prisma-migrate-job.yaml (L510–518).
- Applies full rendered manifest, then Dojo-branch cleanup deletes leftover in-cluster beta workloads: deployment+service redis, statefulset+service postgres, networkpolicies allow-to-redis/allow-to-postgres (--ignore-not-found) (L520–533).
- Rollout gates: frontend, collab-server, ai-engine, ai-gateway, signaling-server (300s each); Dojo branch additionally waits dojo-mcp-host then seeds competency via `kubectl exec … npm run live:dojo:seed-release-competency`; non-overlay deploys still wait for a pre-existing dojo-mcp-host if present (L535–548).

---

# 7. scripts/deploy-prod.sh (187 lines)

Host-side wrapper that submits the Cloud Build above. Flag parser (L51–107): --project/--region/--cluster/--zone/--registry/--tag/--kustomize-dir/--kustomize-load-restrictor/--branch/--push/--allow-dirty. Defaults identical to prod reality (vectant-proj, europe-west10[-a], synthi-beta-cluster, overlay dir, LoadRestrictionsNone).
Pipeline: requires git+gcloud (L109–117) → cd repo root (L119–120) → registry default derived (L122–124) → **tag default `prod-<UTC timestamp>-<12-char sha>`**, validated `^[A-Za-z0-9_.-]+$` (L126–135) → normalize kustomize dir + reject absolute/`..`/missing kustomization.yaml + restrict load-restrictor value (L137–156) → refuse dirty checkout unless --allow-dirty (prints first 40 status lines, L158–165) → optional `git push origin HEAD:<branch>` (L167–170) → prints an echo summary → `gcloud builds submit` with .gcloudignore and the substitution string carrying REGION/CLUSTER/ZONE/REGISTRY/IMAGE_TAG/KUSTOMIZE_DIR/KUSTOMIZE_LOAD_RESTRICTOR (L183–187).

---

# 8. GitHub Actions workflows (.github/workflows)

## 8.1 deploy-prod.yml (107 lines) — THE production pipeline entrypoint

- Triggers: push main + workflow_dispatch with inputs image_tag / kustomize_dir (default overlay) / kustomize_load_restrictor (default LoadRestrictionsNone) (L3–22).
- `permissions: contents: read, id-token: write` (Workload Identity Federation auth); concurrency group production-deploy, cancel-in-progress false (serialized deploys, L24–30).
- Env defaults match GCP project/cluster/zone/registry (L32–37).
- Job `deploy` (ubuntu-latest, 75-min timeout):
  1. Checkout (v4).
  2. Node 20 setup.
  3. **CodeSite release gate on the runner host**: `npm --prefix synthi run codesite:release-gate -- --proof-root tmp/codesite-dojo-proof` (L54–55) — this is why cloudbuild doesn't run it (git provenance needs a real checkout).
  4. google-github-actions/auth@v2 via secrets GCP_WORKLOAD_IDENTITY_PROVIDER + GCP_DEPLOY_SERVICE_ACCOUNT (L57–61); setup-gcloud.
  5. Submit step (L66–107): computes IMAGE_TAG default `prod-${GITHUB_SHA::12}-${GITHUB_RUN_NUMBER}`, validates charset; normalizes/validates kustomize dir + load restrictor identically to deploy-prod.sh; `gcloud builds submit` with .gcloudignore and substitutions.

## 8.2 ci.yml (91 lines) — scoped test CI

Path-filtered (packages/programs-mcp, programs hostEscape/manifest libs, failure-distiller files, workflow itself) on push+PR (L7–26). Jobs:
- `programs-mcp` (node 20): isolated npm install inside packages/programs-mcp (`--workspaces=false` to skip Monaco-heavy monorepo, comment L43–46) + `npm test`.
- `failure-distiller-benchmark` (py 3.12 + node 20): pytest install, `npm ci --ignore-scripts` in synthi (vitest runner), threshold-enforced `python bench/failure_distiller/run.py` producing json+md artifacts uploaded even on failure (L55–92).

## 8.3 codesite-tests.yml (102 lines)

Dedicated CodeSite control-plane/collab/MCP test CI ("test image separation" — prod images never carry tests; Linux runners exercise POSIX symlink/permission paths Windows can't, header L3–7). Path filters on codesite lib/api routes, prisma, collab-server, mcp/synthi-mcp. Job `control-plane` (node 22): full workspace `npm ci --ignore-scripts`, prisma generate, schema validation, then vitest suites (continues past L50: collab + MCP tool tests).

## 8.4 local-support-security.yml (327 lines)

Local-support desktop app security CI. PR + push(main/dev/feature/**) gated by paths (backend/vectant-local-support-app, local-support API/components/lib, prisma, six local-support spec files, sibling workflows) (L3–38). contents: read only. Runs the security-oriented test suites for the local support surface (admin/desktop-shell/live-cloud/live-daemon/live-relay/transparency specs).

## 8.5 local-support-release.yml (218 lines)

Manual (workflow_dispatch) signed Windows release builder. Input channel choice internal/beta/stable (L4–11). Concurrency local-support-signing serialized. Job `build-and-sign` on windows-latest in GH environment `local-support-signing` with Tauri updater keys + Windows PFX cert + updater endpoint pulled from environment secrets (L17–24); first step hard-fails if any protected signing input is missing (L31–40); builds and signs the Tauri desktop shell and publishes updater artifacts.

## 8.6 local-support-staging-e2e.yml (52 lines)

Manual dispatch staging gate, environment `local-support-staging`. Two jobs:
- `protected-staging` (ubuntu): Playwright chromium smoke `tests/local-support-staging-smoke.spec.ts` against LOCAL_SUPPORT_STAGING_BASE_URL with admin token secret (L14–33).
- `installed-desktop` (windows): installs Rust and exercises the installed-desktop + daemon boundary gate (L34–52).

---

# 9. cloudrun/ legacy services

Status per `cloudrun/README.md` (50 lines): **legacy migration notes only** — current prod + Dojo release path is GKE; do not apply these YAMLs until regenerated for target project/registry/domain/SAs/secrets (L3–7). Documents hybrid split (Cloud Run frontend/gateway/engine; GKE core-pool support tier; workspace-pool min 0), the ingress blocker (GKE Ingress owns path routing and would clobber manual URL-map edits), preferred cutover via standalone external ALB + serverless NEGs, simpler separate-hostnames alternative, VPC connector cost guidance, ordered rollout (L9–50).

All three services share: Knative serving.v1, GA launch stage, `run.googleapis.com/ingress: internal-and-cloud-load-balancing` (private + behind LB), startup-cpu-boost, VPC connector `synthi-serverless-ew10` with `private-ranges-only` egress, minScale 0.

| File | Service | Scale/concurrency | Image (stale tag) | Notes |
|---|---|---|---|---|
| ai-engine.service.yaml (46 L) | synthi-ai-engine | max 4, cc 8, 300s | overview-synti AR uuid tag 4e639d76 | uvicorn workers=2 port 8000; secrets GOOGLE_AI_API_KEY + OPENAI_API_KEY (Secret Manager `latest`); SA synthi-ai-engine-run@overview-synti; 2 CPU/2Gi |
| ai-gateway.service.yaml (37 L) | synthi-ai-gateway | max 6, cc 50 | same stale tag | GATEWAY_WS_PATH=/gateway/ws; BACKEND_URL hardcoded to engine's run.app URL; 1 CPU/512Mi |
| frontend.service.yaml (103 L) | synthi-frontend | max 5, cc 80 | same stale tag | **Cloud SQL instance annotation** overview-synti:europe-west10:synthi-dev (L17); beta.synthi.app public URLs (pre-vectant.dev era); CODE_INTEL/AI_ENGINE point at engine run.app; secrets AUTH/NEXTAUTH/OAUTH pair/DATABASE_URL/COLLAB_INTERNAL_TOKEN/CLOUDFLARE TURN; SA synthi-frontend-run@overview-synti; 1 CPU/1Gi |

Also cloudrun/collab-server-evaluation.md exists (evaluation notes for why collab stayed on GKE).

---

# 10. ops/ PowerShell provisioners

## 10.1 ops/cloudrun/ensure-vpc-connector.ps1 (51 lines)

Idempotent Serverless VPC Access connector provisioner. Params: PROJECT_ID from env (required), region europe-west10, network default, name synthi-serverless-ew10, cidr 10.8.0.0/28, min 2/max 3 instances, e2-micro. Enables run+vpcaccess APIs (L19–20), lists connectors filtered by name and updates-or-creates accordingly (L22–47), closing note repeats README guidance about baseline cost vs zero-idle economics (L49–51).

## 10.2 ops/gke/ensure-hybrid-node-pools.ps1 (125 lines)

Idempotent node-pool provisioner for the hybrid layout. Params: cluster synthi-beta-cluster zone europe-west10-a; core-pool (e2-small, min=max=1, label pool-role=core); workspace-pool (**n2-standard-16, autoscale 0→2**, initial bootstrap node when min=0 because GKE demands num-nodes≥1 — comment L70–77, pd-balanced 50GB, taint workload=workspace:NoSchedule, labels workload/pool-role=workspace). Update-vs-create branching preserves existing pools' autoscaling settings (L48–68). Closing warnings: don't drain default-pool until support tier migrated; workspace pods target pool via configmap selector+taint (L122–126).

## 10.3 ops/gcp/ensure-standalone-edge-alb.ps1 (491 lines)

The Cloud Run migration load balancer builder (README option 1). Fully idempotent ensure-* functions over gcloud:
- Helpers: Invoke-GcloudValue/Json wrappers, existence checks for global resources/regional+zonal NEGs (L42–81).
- Resolves GKE node tag from instance names `gke-<cluster>-*-node` (L83–104); project number (L106–108).
- IAP plumbing: generateServiceIdentity REST call tolerating 409 (L110–127); grants roles/run.invoker on the three Cloud Run services to `service-<n>@gcp-sa-iap…` (L129–139).
- Firewall `synthi-edge-gke-hc-fw`: allow 35.191.0.0/16,130.211.0.0/22 → tcp 1234/1235/8080/9000 targeted at node tag (L141–169).
- Global static IP synthi-edge-ip; Google-managed SSL cert for $DOMAIN (env DOMAIN required) (L171–192).
- Reads IAP OAuth client_id/secret from k8s Secret `iap-oauth-secret` ns synthi (L198–204).
- Serverless NEGs for synthi-frontend/-ai-gateway/-ai-engine (regional); waits for pre-existing zonal NEGs collab-server-alb-neg / signaling-server-alb-neg / y-sweet-alb-neg (created by k8s NEG annotations) (L206–225, 448–454).
- Health checks: collab `:1235/debug/status`, signaling `:8080/`, ysweet `:8080/ready` (15s interval, thresholds 1/2) (L227–248, 456–458).
- Backend services EXTERNAL_MANAGED: serverless ones without HC (frontend 300s drain 30, gateway 3600 drain 60, engine 30s drain 0); zonal GKE ones with HC (collab/signaling/ysweet 3600 drain 60), attached RATE balancing maxRatePerEndpoint 100 (L250–313, 460–472).
- IAP enabled on ALL six backend services with OAuth creds (L315–322, 474–479).
- URL map import (heredoc YAML, L324–403): defaultService frontend; host matcher for $Domain routing /collab→collab, /signal→signal, /ysweet→ysweet, /gateway→gateway, and the ai-engine API fan (/code-intel, /classify, /provenance, /analyze, /heal, /health) → engine; includes 6 url-map `tests:` assertions (L374–393).
- Target HTTPS proxy + global forwarding rule :443 (L405–432); final echo of address/cert/urlmap (L485–491).

---

# 11. .env.example

Root `.env.example` (59 lines): "Copy to .env.local for docker compose. Never commit .env.local." (L1). Complete var list grouped by **consumer**:

| Consumer | Vars (line refs) |
|---|---|
| NextAuth / gateway auth | NEXTAUTH_SECRET, AUTH_SECRET, GATEWAY_JWT_SECRET (L3–6); optional dev bypass NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS with disposable-stacks-only warning (L8) |
| Frontend ↔ collab-server bridge | COLLAB_INTERNAL_TOKEN — unique high-entropy per env, same value both sides (L10–12) |
| Postgres (compose) | DATABASE_URL=postgres://synthi:***@postgres:5432/synthi, POSTGRES_HOST_PORT=5432 (L14–16) |
| OAuth providers | GITHUB_ID/SECRET, GOOGLE_CLIENT_ID/SECRET (L18–21) |
| GCP storage | GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY (L23–25) |
| AI providers | AI_BACKEND_AUTH_TOKEN, GOOGLE_AI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY (L27–30) |
| Browser workflow bridge / hosted browser / preview discovery | SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL (empty in k8s; template routing), _TARGET_TEMPLATE, _PORT=9466, SYNTHI_PREVIEW_DISCOVERY_PORTS, SYNTHI_PREVIEW_SCAN_PORTS, SYNTHI_HOSTED_BROWSER_CDP_PORT=9222, SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN, SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY, SYNTHI_AUTH_CHECKPOINT_STORE_KEY (L32–42) |
| CodeSite managed-agent landing (ai-engine controller only) | SYNTHI_CODESITE_AGENT_OVERLAY_ROOT (dedicated dir on collab-data outside every checkout), SYNTHI_CODESITE_CONTROL_PLANE_URL (HTTPS origin), SYNTHI_CODESITE_FINALIZER_COMMAND (JSON argv in isolated worktree) (L44–53) |
| Runtime naming | SYNTHI_RUNTIME_ID_SECRET — stable HMAC for rt-… pod/service names; do not rotate casually or preview routes change (L55–59) |

Notable absences vs docker-compose.yml defaults: host-port knobs (COLLAB_HOST_PORT etc.) are compose-interpolated but not listed here; SYNTHI_CODESITE_TOKEN is not present (local default baked into compose).

Companion examples (not root scope, listed for completeness): `synthi/.env.example` (63 L) covers MCP SSRF allowlist/call timeout/internal API token, COLLAB_INTERNAL_TOKEN, git-provider Slice-2 OAuth vars incl. GITLAB and GitHub-reuse rules, rate limit; `mcp/synthi-mcp/.env.example` (70 L) covers session/signaling URLs, external-tool PAT wiring (SYNTHI_API_URL/SYNTHI_PAT/workspace slug), vision backend selection + Gemini key fallback order, load-path precedence (--env-file → SYNTHI_ENV_FILE → local .env); `backend/collab-server/.env.example` (157 L) mirrors config.js parsing (REPOS_DIR, REPO_CACHE_DELETE_ON_EVICT prod=false guidance, deprecated LEVELDB_DIR, YSWEET_* …).

---

# 12. Dockerfiles

All base images digest-pinned unless noted. Shared uid convention: 1001 = service user (collab synthi / ai-engine appuser / gateway synthi / frontend nextjs), 1000 = workspace runner, 10001 = agent-runner.

## 12.1 synthi/Dockerfile — frontend (134 lines)

Header: npm-WORKSPACE build from MONOREPO ROOT because of @synthi/mcp-hub transpile; both compose (`context: .`) and cloudbuild (`dir:///workspace`) use it (L1–17).
- Stage deps (node:20-alpine@sha256:fb4cd12c…, L20): libc6-compat; copies ROOT package.json+lockfile plus every workspace manifest needed to resolve the graph (synthi, packages/mcp-hub, mcp/synthi-mcp) then `npm ci` (L26–32).
- Stage builder (L35–92): node_modules from deps; copies atomic-orchestrator + mcp-hub + synthi sources; ARG block of 10 NEXT_PUBLIC_* build args (L50–59); hard-fails if the three critical public URLs are missing (L61–67); regenerates `.env.production.local` writing only non-empty values (so Cloud Build's committed .env.production beta defaults survive when args are blank, L69–85); `npx prisma generate`; `next build` standalone with NODE_OPTIONS max-old-space 4096 (Monaco+Yjs OOM guard, L92).
- Stage runner (L95–134): same pinned alpine base; installs git (shadow merge worktrees need real git, L101–105); creates system group/user 1001 nextjs; pre-creates /workspace-shadow owned nextjs so named-volume first-mount inherits ownership (L107–110); copies monorepo-rooted standalone output preserving layout (entry `node synthi/server.js`, L112–117), static assets, public/, hoisted Prisma client (.prisma) + schema dir, scripts/ for the shadow runner (L119–126); USER nextjs; EXPOSE 3000; HOSTNAME 0.0.0.0.

## 12.2 synthi/Dockerfile.migrate — prisma migrate image (28 lines)

Single stage node:20-alpine (same digest). Installs global `prisma@6.17.1` (standalone output lacks the CLI — rationale header L1–9), copies only `prisma/` schema+migrations, USER node, ENTRYPOINT prisma, CMD migrate deploy --schema=/app/prisma/schema.prisma.

## 12.3 ai-backend/ai-engine/Dockerfile (49 lines)

Two-stage python:3.10-slim@sha256:a3699f90…. Builder installs build-essential (tiktoken/numpy compile) and wheels requirements.txt to /build/wheels (L12–20). Runtime: PYTHONDONTWRITEBYTECODE/PYTHONUNBUFFERED; apt-installs **docker.io docker-cli git** (Failure Distiller capsule launches through the host daemon via mounted socket) then pip-installs from wheels, compiler-free (L23–36); COPY app; creates appuser uid/gid 1001 matching collab-server's ownership of /data/repos — without it CodeIntel 500s writing `<workspace>/.code_intel` (comment L40–44); EXPOSE 8000; CMD python run_server.py.

## 12.4 ai-backend/gateway/Dockerfile (24 lines)

Single-stage node:20-alpine (pinned). npm ci --omit=dev; copies server.js; non-root user synthi 1001; EXPOSE 7070; CMD node server.js. No native modules (header).

## 12.5 ai-backend/agent-runner/Dockerfile (20 lines)

Disposable coding-agent harness image. Base node:22-bookworm-slim@sha256:a17d50af…. ARGs CODEX_VERSION=0.149.0, CLAUDE_CODE_VERSION=2.1.240, HERMES_AGENT_VERSION=0.19.0. Installs python3+venv/git/ca-certs; global npm @openai/codex + @anthropic-ai/claude-code; venv at /opt/hermes with hermes-agent==0.19.0; group/user agent 10001; entrypoint script copied --chmod=0555; USER 10001:10001; PATH includes /opt/hermes/bin; WORKDIR /workspace.

## 12.6 backend/collab-server/Dockerfile (71 lines)

Two-stage node:20 (Debian bookworm, NOT digest-pinned here — full node needed for node-pty ABI parity between stages, header L1–8). Builder: npm ci. Runtime:
- Global install `@anthropic-ai/claude-code` for the in-app terminal (L24–26).
- Creates synthi 1001 WITH home dir (--create-home) so terminalService can repoint HOME for GIT_CONFIG_GLOBAL/NPM_CONFIG_USERCONFIG/CLAUDE_CONFIG_DIR (L28–32).
- Copies node_modules (native .node binaries) + app chown'd; pre-creates /data/repos.
- System git identity "Synthi Autocommit" (L43–44).
- apt: sudo (**NOPASSWD sudoers entry for synthi** — deliberate: interactive terminal installs, server itself unprivileged, L46–58), python3-venv/pip (PEP 668 workaround for program recipes), curl/ca-certs.
- Downloads lazygit 0.44.1 release tarball to /usr/local/bin (not packaged in Debian, L60–65).
- USER synthi; EXPOSE 1234; CMD `node --openssl-legacy-provider server.js`.

## 12.7 backend/runtime-image/Dockerfile — DUAL-build runtime (90 lines)

One Dockerfile, two identities via ARGs (header L3–18):
- DEFAULT (rootless): base docker:dind-rootless@sha256:41825fb1…, USER rootless, HOME /home/rootless, socket /run/user/1000/docker.sock — LOCAL DEV HYBRID run privileged under Docker Desktop by collab-server's workspaceRuntimeContainer.js.
- SYSBOX PROD override (cloudbuild step 11): RUNTIME_BASE=docker:dind@sha256:ad68e89b…, RUNTIME_USER=root, RUNTIME_HOME=/root, DOCKER_SOCK=/var/run/docker.sock — normal rootful dind made safe by Sysbox userns; the rootless variant crash-loops there (rootlesskit can't nest userns, validated 2026-06-15).
Layer inventory: apk nodejs/npm/python3/pip/git/lazygit/curl/bash (default-program toolchain); global http-server (static programs); global claude-code (terminal parity Phase 2a); kubectl+helm (Alpine community); kind v0.32.0 binary verified against pinned SHA-256 (L57–63); passwordless sudo for target user; system git identity; writable HOME + custom PS1 prompt; ENV DOCKER_HOST=unix://${DOCKER_SOCK} baked so every docker exec talks to the workspace's own daemon while recipe-supplied DOCKER_HOST is scrubbed (L83–87); final USER ${RUNTIME_USER}, WORKDIR /workspace.

## 12.8 backend/y-sweet/Dockerfile (13 lines)

FROM ghcr.io/jamsocket/y-sweet:latest@sha256:d61ba0fa… (tag+digest since GHCR publishes under latest; binary reports 0.9.1). VOLUME /data; CMD y-sweet serve /data --host 0.0.0.0 --port 8080.

## 12.9 backend/synthi-webrtc-compiler/signaling-server/Dockerfile (34 lines)

rust:1.88-bookworm@sha256:af306cfa… builder (clang/libclang/llvm for ring etc.) → debian:bookworm-slim@sha256:67b30a61… runtime with ca-certificates+libssl3 (redis crate TLS/DNS); single signaling-server binary; non-root user `signaling`; SIGNALING_PORT 9000; ENTRYPOINT signaling-server.

## 12.10 worker Dockerfile family (backend/synthi-webrtc-compiler/worker/)

Three variants share the same two-stage shape (rust builder with gstreamer/x11/sdl2/protobuf dev headers + dummy-src crate cache honoring the vendored/stun patch, then heavy runtime):

- **Dockerfile** (`backend/synthi-webrtc-compiler/worker/Dockerfile`, 233 L) — canonical ROCm/WSL-focused universal image.
  - Builder L15–64: WORKER_CARGO_FEATURES arg gates feature build; vendored tree copied BEFORE dummy cargo build ([patch.crates-io] resolves during lockfile processing, comment L39–42); real build touches main.rs first.
  - Runtime ubuntu:25.10@sha256:4a9232cc…: GCC 15 from Questing archive for C++26 (rationale L77–89; update-alternatives for gcc/g++/cc/c++; libxml2 soname shim), openjdk-17-jdk FULL (AWT/X11 needs libawt_xawt.so, comment L95–97), SDL2/GL/GLU/GLEW/OpenMP stack, conditional ROCm 7.2.1 SDK from repo.radeon.com noble repo pinned priority 600 + ROCDXG 1.2.0 deb for RX 9070 XT/gfx1201 WSL (INSTALL_ROCM arg, L116–135), ROCM/RUSTUP/CARGO env paths; Node 20.20.2 official tarball + typescript + typescript-language-server (VS Code bridge needs modern Node, L143–158); rustup-init 1.28.2 archive-hash-verified stable minimal (no curl|sh, L160–174); GStreamer full plugin set good/bad/ugly/libav; Xvfb + matchbox-window-manager + xdotool; clangd + rust-analyzer LSP servers; compiles cpp_src gpu-native-launch-observer shim to /usr/local/lib (L204–209); copies worker+runner binaries + vscode-server-manager.js/ext-host-preload.js/esm-vscode-hook.mjs; deletes stock ubuntu user so `runner` takes UID 1000 (parity with tooling assumptions, L218–223); ENTRYPOINT ["worker"], no exposed ports (outbound-only).
- **Dockerfile.gpu** (~5.8 KB) — universal CUDA+ROCm release image used by BOTH GPU overlays: same builder; runtime nvidia/cuda:12.8.0-devel-ubuntu24.04 (NOT digest-pinned); auto-selects gcc-14/13; headless JDK + mesa utils; installs both GStreamer and ROCm toolchains; compose overlays handle only device exposure (header L1–5).
- **Dockerfile.cuda** (~4.5 KB) — CUDA sibling without the ROCm layer, for NVIDIA hosts using docker-compose.nvidia.yml; identical builder; slimmer runtime plugin set.

## 12.11 mcp/synthi-mcp family

- **Dockerfile** (36 L) — compose `mcp` sleeper. Root-context npm-workspace build (mcp-hub sibling resolution, header L10–15); node:22-slim@sha256:689c1104… (glibc required by sharp/ffmpeg prebuilts, comment L20–23); npm ci --workspaces=false; tsc build; **CMD sleep infinity** — live-test.mjs docker-execs each run (L34–36).
- **Dockerfile.http** (23 L) — Dojo MCP HTTP host image (synthi-mcp-http in cloudbuild/k8s). Dev-deps included tsc build asserting dist/http.js exists; bakes SYNTHI_MCP_HTTP_HOST/PORT(9467)/PATH(/mcp)/HEALTH_PATH; EXPOSE 9467; CMD node dist/http.js. K8s overlay overrides PATH to /dojo/mcp at runtime.
- **Dockerfile.workflow-bridge** (24 L) — browser workflow bridge + hosted browser runtime image (synthi-browser-workflow-bridge). Base **mcr.microsoft.com/playwright:v1.60.0-noble** (ships Chromium + deps); apt novnc/websockify/x11vnc/xvfb (the sidecar's X/VNC stack lives IN this image); dev-deps tsc; asserts dist/browser_workflow_bridge/standalone.js; CMD node that file.

---

# Cross-cutting observations

1. **Two migration jobs, one pattern**: delete → sed tag → apply → wait complete → dump logs; both excluded from kustomize, orchestrated by cloudbuild (prisma always, dojo only on overlay path). Failure semantics differ: backoffLimit 3 vs 0.
2. **Secret trust boundaries are explicit everywhere**: SYNTHI_CODESITE_TOKEN vs COLLAB_INTERNAL_TOKEN ("do not reuse" comments appear in compose, k8s manifests, ESO mapping, secrets example, cloudrun frontend).
3. **Digest pinning is enforced**, not aspirational — reject-mutable-images greps every deploy; sysbox image re-hosted+pinned; trivy gate opt-in behind _ENABLE_VULNERABILITY_SCAN.
4. **The overlay render contract is load-bearing**: LoadRestrictionsNone requirement stems from bases living directly under k8s/; three independent call sites (README render, cloudbuild guard, workflow submit) validate the same constraints.
5. **Known sharp edge**: ESO ExternalSecrets fail atomically — one missing Secret Manager key blocks the whole synthi-secrets/dojo-release-secrets sync and therefore the deploy; the therapeutic-prod removal comment documents a live incident and the flag-gate recovery path.
