---
area: infra-config
generated: 2026-08-25
files: 44
---

# File Index — infra-config (44 files)

Kinds: asset: 1, source/config: 43


## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `cloudrun/README.md` | 2 | Hybrid GKE + Cloud Run Migration Notes |
| `cloudrun/ai-engine.service.yaml` | 1 | Service "synthi-ai-engine" |
| `cloudrun/ai-gateway.service.yaml` | 1 | Service "synthi-ai-gateway" |
| `cloudrun/collab-server-evaluation.md` | 1 | Collab Server Cloud Run Evaluation |
| `cloudrun/frontend.service.yaml` | 3 | Service "synthi-frontend" |
| `k8s/README.md` | 18 | Synthi IDE — GKE Deployment Guide |
| `k8s/ai-engine.yaml` | 3 | Synthi IDE — AI Engine (Python FastAPI, uvicorn) |
| `k8s/ai-gateway.yaml` | 3 | Synthi IDE — AI Gateway (Node.js WebSocket → AI Engine proxy) |
| `k8s/collab-server.yaml` | 21 | Synthi IDE — Collab Server (Node.js, REST + WS notifications) |
| `k8s/configmap.yaml` | 8 | Synthi IDE — ConfigMap (non-sensitive, shared configuration) |
| `k8s/create-gcp-secrets.sh` | 2 | Synthi IDE — Create GCP Secret Manager Secrets |
| `k8s/dojo-postgres-migrate-job.yaml` | 1 | Synthi IDE - Agent Dojo Postgres Migration Job |
| `k8s/external-secrets.yaml` | 6 | Synthi IDE — External Secrets (GCP Secret Manager → K8s Secrets) |
| `k8s/frontend.yaml` | 10 | Synthi IDE — Next.js Frontend |
| `k8s/ingress.yaml` | 4 | ManagedCertificate "synthi-managed-cert" |
| `k8s/kustomization.yaml` | 2 | Synthi IDE — Kustomization (apply all manifests in order) |
| `k8s/namespace.yaml` | 617 | Synthi IDE — GKE Namespace |
| `k8s/network-policies.yaml` | 9 | Synthi IDE — Network Policies |
| `k8s/overlays/dojo-release-gate/README.md` | 4 | Agent Dojo Release-Gate Overlay |
| `k8s/overlays/dojo-release-gate/dojo-mcp-host.yaml` | 8 | BackendConfig "dojo-mcp-host-backend-config" |
| `k8s/overlays/dojo-release-gate/dojo-mcp-ingress.patch.yaml` | 815 | path: /spec/rules/0/http/paths/3 |
| `k8s/overlays/dojo-release-gate/dojo-release-config.yaml` | 1 | ConfigMap "synthi-config" |
| `k8s/overlays/dojo-release-gate/dojo-release-external-secrets.yaml` | 3 | ExternalSecret "synthi-dojo-release-secrets" |
| `k8s/overlays/dojo-release-gate/kustomization.yaml` | 1 | Opt-in overlay for Agent Dojo enterprise release-gate candidates. |
| `k8s/overlays/dojo-release-gate/redis-secret-env.patch.yaml` | 812 | Deployment "collab-server" |
| `k8s/pod-disruption-budgets.yaml` | 2 | Synthi IDE — PodDisruptionBudgets |
| `k8s/postgres.yaml` | 3 | Synthi IDE — PostgreSQL (StatefulSet + PVC) |
| `k8s/preview-certificate.yaml` | 830 | ClusterIssuer "letsencrypt-preview-dns" |
| `k8s/prisma-migrate-job.yaml` | 2 | Synthi IDE — Prisma Migration Job |
| `k8s/redis.yaml` | 2 | Synthi IDE — Redis (signaling Pub/Sub) |

## asset

| File | Bytes | Note |
|---|---|---|
| `k8s/secrets.yaml.example` | 3 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `k8s/signaling-server.yaml` | 4 | Synthi IDE — Signaling Server (Rust, 2+ replicas, Redis Pub/Sub) |
| `k8s/spawner-rbac.yaml` | 3 | Synthi IDE — RBAC for Workspace Spawner |
| `k8s/sysbox/README.md` | 6 | Sysbox runtime substrate (Phase 2, Slice 0) |
| `k8s/sysbox/create-scratch-cluster.ps1` | 5 | Slice 0 — create the Sysbox SCRATCH cluster + sysbox-pool on GKE. |
| `k8s/sysbox/kustomization.yaml` | 1 | Sysbox install — STANDALONE kustomization (cluster-scoped node infra) |
| `k8s/sysbox/smoke-pod.yaml` | 3 | Sysbox acceptance smoke test (Slice 0, step C1) |
| `k8s/sysbox/sysbox-install.yaml` | 7 | Sysbox install (Community Edition) — VENDORED + PINNED |
| `k8s/worker.yaml` | 6 | Synthi IDE — WebRTC Compiler Worker (Rust + GStreamer) |
| `k8s/workload-identity-setup.sh` | 5 | Synthi IDE — Workload Identity Setup |
| `k8s/y-sweet.yaml` | 4 | Synthi IDE — Y-Sweet (Yrs/CRDT document server) |
| `ops/cloudrun/ensure-vpc-connector.ps1` | 1 | [string]$ProjectId = $env:PROJECT_ID, |
| `ops/gcp/ensure-standalone-edge-alb.ps1` | 18 | [string]$ProjectId = $env:PROJECT_ID, |
| `ops/gke/ensure-hybrid-node-pools.ps1` | 3 | [string]$ProjectId = 'vectant-proj', |


---
[[Repository Map]] · [[00 Home|🏠 Home]]
