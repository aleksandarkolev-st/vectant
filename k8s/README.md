# Synthi IDE — GKE Deployment Guide

## Architecture Overview

```
                         ┌──────────────────────────────────────────────────┐
                         │          GCP HTTPS Load Balancer (Ingress)       │
                         │     synthi.example.com — TLS termination        │
                         └──────┬──────────┬─────────────┬─────────────────┘
                                │          │             │
                    /           │  /collab  │  /signal    │  /gateway
                    ▼           ▼          ▼             ▼
            ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐
            │ Frontend   │ │ Collab   │ │ Signaling │ │ AI Gateway│
            │ (Next.js)  │ │ Server   │ │ Server    │ │ (Node.js) │
            │ :3000  ×2+ │ │ :1234 ×1 │ │ :9000 ×2+ │ │ :7070 ×2+ │
            └─────┬──────┘ └────┬─────┘ └─────┬─────┘ └─────┬─────┘
                  │             │              │              │
                  │     ┌───── │ ─────────────│──────────────┘
                  │     │      │              │
                  ▼     ▼      │              ▼
            ┌──────────────┐   │       ┌───────────┐
            │  PostgreSQL  │   │       │   Redis   │
            │  :5432 ×1    │   │       │  :6379 ×1 │
            └──────────────┘   │       └───────────┘
                               │
                               ▼
                        ┌──────────────┐      ┌───────────────┐
                        │   AI Engine  │      │    Worker      │
                        │  (FastAPI)   │◄─────│  (Rust+GST)   │
                        │  :8000 ×1+   │      │  ×N (1/user)  │
                        └──────────────┘      └───────────────┘
```

## Services

| Service | Image | Port | Replicas | Scaling |
|---------|-------|------|----------|---------|
| **Frontend** (Next.js) | `synthi-frontend` | 3000 | 2 | HPA (2–8, CPU 70%) |
| **Collab Server** (Node.js) | `synthi-collab-server` | 1234 | 1 | Recreate (LevelDB) |
| **Signaling Server** (Rust) | `synthi-signaling-server` | 9000 | 2 | Manual (stateless) |
| **AI Gateway** (Node.js) | `synthi-ai-gateway` | 7070 | 2 | HPA (2–6, CPU 70%) |
| **AI Engine** (Python) | `synthi-ai-engine` | 8000 | 1 | Manual / HPA |
| **Worker** (Rust+GStreamer) | `synthi-worker` | — | 0 static | Dynamic via collab spawner (1 pod = 1 session) |
| **PostgreSQL** | `postgres:16-alpine` | 5432 | 1 | StatefulSet |
| **Redis** | `redis:7-alpine` | 6379 | 1 | Single |

## Quick Start

### Prerequisites

1. A GKE cluster with Workload Identity enabled
2. `gcloud` and `kubectl` configured
3. A container registry (Artifact Registry recommended)
4. A static IP and DNS record

```bash
# Reserve a global static IP
gcloud compute addresses create synthi-ip --global

# Verify
gcloud compute addresses describe synthi-ip --global
```

### Build & Push Images

Replace `REGISTRY` with your Artifact Registry path (e.g., `us-central1-docker.pkg.dev/overview-synti/synthi`).

```bash
REGISTRY=us-central1-docker.pkg.dev/overview-synti/synthi

# Frontend
cd synthi
docker build -t $REGISTRY/synthi-frontend:latest .
docker push $REGISTRY/synthi-frontend:latest

# Collab Server
cd backend/collab-server
docker build -t $REGISTRY/synthi-collab-server:latest .
docker push $REGISTRY/synthi-collab-server:latest

# AI Engine
cd ai-backend/ai-engine
docker build -t $REGISTRY/synthi-ai-engine:latest .
docker push $REGISTRY/synthi-ai-engine:latest

# AI Gateway
cd ai-backend/gateway
docker build -t $REGISTRY/synthi-ai-gateway:latest .
docker push $REGISTRY/synthi-ai-gateway:latest

# Signaling Server
cd backend/synthi-webrtc-compiler/signaling-server
docker build -t $REGISTRY/synthi-signaling-server:latest .
docker push $REGISTRY/synthi-signaling-server:latest

# Worker
cd backend/synthi-webrtc-compiler/worker
docker build -t $REGISTRY/synthi-worker:latest .
docker push $REGISTRY/synthi-worker:latest
```

### Configure Secrets

Production deploys use `k8s/external-secrets.yaml`, which syncs the
`synthi-secrets` Kubernetes Secret from GCP Secret Manager. Create the remote
secrets named in that manifest before applying `k8s/`.

Set `synthi-runtime-id-secret` once and keep it stable. It is used to derive
opaque `rt-...` runtime pod/service names; rotating it changes those names and
breaks existing preview routes until runtimes are recreated.

For a local/manual deployment without External Secrets Operator, copy
`k8s/secrets.yaml.example` to `k8s/secrets.yaml`, replace every placeholder with
real base64-encoded values, and swap the foundation resource in
`k8s/kustomization.yaml` from `external-secrets.yaml` to `secrets.yaml`:

```bash
echo -n 'your-actual-secret' | base64
```

### Configure Domain

Search-and-replace `synthi.example.com` in:
- `k8s/configmap.yaml` — public URLs
- `k8s/ingress.yaml` — Ingress host + ManagedCertificate

### Configure DNS

After reserving the static IP and deploying the Ingress, set up DNS:

```bash
# Get the static IP address
gcloud compute addresses describe synthi-ip --global --format='value(address)'
```

Create a DNS A record pointing your domain to this IP:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | synthi.example.com | *(output of above command)* | 300 |

**ManagedCertificate provisioning:**
- GCP will **not** provision the SSL certificate until DNS resolves to the static IP
- Certificate provisioning takes 10–60 minutes after DNS propagation
- Check status: `kubectl describe managedcertificate synthi-cert -n synthi`
- Status transitions: `Provisioning` → `Active`

**HTTP to HTTPS redirect:**
The Ingress uses a `FrontendConfig` to redirect all HTTP traffic to HTTPS with a 301 status code. No additional configuration needed.

### Configure Registry

Image references in all manifests default to `us-central1-docker.pkg.dev/overview-synti/synthi/`.
To use a different registry, override via Kustomize:

```bash
cd k8s
kustomize edit set image \
  us-central1-docker.pkg.dev/overview-synti/synthi/synthi-frontend=YOUR_REGISTRY/synthi-frontend:v1.0 \
  us-central1-docker.pkg.dev/overview-synti/synthi/synthi-collab-server=YOUR_REGISTRY/synthi-collab-server:v1.0 \
  # ...etc
```

### CI/CD (Cloud Build)

The project includes a `cloudbuild.yaml` at the repo root that automates build and deploy:

```bash
# One-time setup: create Artifact Registry
gcloud artifacts repositories create synthi \
  --repository-format=docker --location=us-central1 --project=overview-synti

# Grant Cloud Build permissions
PROJECT_NUM=$(gcloud projects describe overview-synti --format='value(projectNumber)')
gcloud projects add-iam-policy-binding overview-synti \
  --member="serviceAccount:${PROJECT_NUM}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding overview-synti \
  --member="serviceAccount:${PROJECT_NUM}@cloudbuild.gserviceaccount.com" \
  --role="roles/container.developer"

# Create trigger (push to main)
gcloud builds triggers create github \
  --name="synthi-deploy-main" \
  --repo-name="synthi-ide" --repo-owner="YOUR_ORG" \
  --branch-pattern="^main$" --build-config="cloudbuild.yaml" \
  --project=overview-synti
```

### Deploy

```bash
# Apply everything in dependency order
kubectl apply -k k8s/

# Run Prisma migrations (via dedicated Job with Cloud SQL Auth Proxy)
IMAGE_TAG=<immutable build tag>
kubectl delete job prisma-migrate -n synthi --ignore-not-found
sed "s|synthi-prisma-migrate:build-tag-required|synthi-prisma-migrate:${IMAGE_TAG}|g" \
  k8s/prisma-migrate-job.yaml | kubectl apply -f -
kubectl wait --for=condition=complete job/prisma-migrate -n synthi --timeout=120s
kubectl logs job/prisma-migrate -n synthi -c migrate

# Verify
kubectl get pods -n synthi
kubectl get ingress -n synthi
```

### Verify Connectivity

```bash
# Check all pods are running
kubectl get pods -n synthi -w

# Check Ingress got an IP (may take 5-10 min for GCE LB provisioning)
kubectl get ingress -n synthi synthi-ingress

# Confirm gateway and signaling backends are healthy at the load balancer
kubectl get ingress synthi-ingress -n synthi -o jsonpath="{.metadata.annotations.ingress\.kubernetes\.io/backends}"

# Test internal connectivity
kubectl exec -n synthi deploy/ai-gateway -- wget -qO- http://ai-engine:8000/docs | head -5
kubectl exec -n synthi deploy/collab-server -c collab -- wget -qO- http://127.0.0.1:1234/turn-credentials
```

## Important Notes

### NEXT_PUBLIC_ Environment Variables
These are baked into the JavaScript bundle at **build time**, not runtime. You must either:
- Set them as `ARG` / `ENV` in the Dockerfile
- Or use a multi-stage build that runs `next build` with the correct values

### WebSocket Timeout
The GCE Ingress default backend timeout is 30s, which kills WebSocket connections. The `BackendConfig` resources in `ingress.yaml` set a 1-hour timeout for WS services.

### Worker Scaling
Static worker replicas are kept at `0`. The collab server creates a one-replica Deployment per active runtime scope via `/api/spawner/ensure`, keeps it alive with `/api/spawner/touch`, and tears it down when the signaling session ends. Each runtime pod includes a preview sidecar on the configured internal sidecar port, so user dev servers can keep binding localhost-only app ports such as `3000` or `5173`.

### Runtime Filesystem Storage
Runtime pods and the collab server both mount `/data/repos`, so `collab-data-pvc` must use ReadWriteMany storage when pods can schedule on different node pools. The production manifest defaults to GKE Filestore CSI `enterprise-multishare-rwx`; override the StorageClass if your cluster uses another RWX Filestore or NFS class.

### WebSocket Health Checks
For GKE Ingress, timeout settings alone are not enough. Each public WebSocket backend also needs a valid HTTP health target. In this deployment:
- `collab-server` uses `/debug/status` on port `1234`
- `ai-gateway` uses `/gateway/health` on port `7070`
- `signaling-server` uses a lightweight sidecar health endpoint on port `8080`

### Collab Server HA
The collab server holds Yjs documents in memory and uses LevelDB on disk — it cannot be trivially replicated. Options:
1. **Sticky sessions** — use `sessionAffinity: ClientIP` on the Service
2. **Redis-backed Yjs** — replace y-leveldb with y-redis for shared state
3. **Accept single-replica** — adequate for most deployments; GCS is the durable store

### Production Hardening
- [x] Replace `secrets.yaml` with GCP Secret Manager + External Secrets Operator
- [x] Enable Workload Identity for GCS access (remove GCP_CLIENT_EMAIL/KEY)
- [ ] Set up Cloud SQL instead of in-cluster PostgreSQL
- [ ] Set up Memorystore instead of in-cluster Redis
- [x] Add NetworkPolicies to restrict pod-to-pod traffic
- [x] Add PodDisruptionBudgets for frontend, gateway, signaling
- [x] HTTP → HTTPS 301 redirect via FrontendConfig
- [x] Prisma migration Job with Cloud SQL Auth Proxy sidecar
- [ ] Configure Cloud Armor WAF rules on the Ingress
- [ ] Set up Cloud Monitoring alerts for pod restarts and error rates
