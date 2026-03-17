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
| **Worker** (Rust+GStreamer) | `synthi-worker` | — | 2 | Manual (1 pod = 1 session) |
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

Edit `k8s/secrets.yaml` — replace every `Q0hBTkdFTUU=` placeholder with your real base64-encoded values:

```bash
echo -n 'your-actual-secret' | base64
```

### Configure Domain

Search-and-replace `synthi.example.com` in:
- `k8s/configmap.yaml` — public URLs
- `k8s/ingress.yaml` — Ingress host + ManagedCertificate

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

# Run Prisma migrations (one-time)
kubectl exec -n synthi deploy/frontend -- npx prisma migrate deploy

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

# Test internal connectivity
kubectl exec -n synthi deploy/ai-gateway -- wget -qO- http://ai-engine:8000/docs | head -5
kubectl exec -n synthi deploy/worker -- wget -qO- http://collab-server:1234/turn-credentials
```

## Important Notes

### NEXT_PUBLIC_ Environment Variables
These are baked into the JavaScript bundle at **build time**, not runtime. You must either:
- Set them as `ARG` / `ENV` in the Dockerfile
- Or use a multi-stage build that runs `next build` with the correct values

### WebSocket Timeout
The GCE Ingress default backend timeout is 30s, which kills WebSocket connections. The `BackendConfig` resources in `ingress.yaml` set a 1-hour timeout for WS services.

### Worker Scaling
Each worker pod handles exactly ONE user session. Scale `replicas` in `worker.yaml` to match your expected concurrent users. For dynamic scaling, consider KEDA with a custom metric (active signaling sessions).

### Collab Server HA
The collab server holds Yjs documents in memory and uses LevelDB on disk — it cannot be trivially replicated. Options:
1. **Sticky sessions** — use `sessionAffinity: ClientIP` on the Service
2. **Redis-backed Yjs** — replace y-leveldb with y-redis for shared state
3. **Accept single-replica** — adequate for most deployments; GCS is the durable store

### Production Hardening
- [ ] Replace `secrets.yaml` with GCP Secret Manager + External Secrets Operator
- [ ] Enable Workload Identity for GCS access (remove GCP_CLIENT_EMAIL/KEY)
- [ ] Set up Cloud SQL instead of in-cluster PostgreSQL
- [ ] Set up Memorystore instead of in-cluster Redis
- [ ] Add NetworkPolicies to restrict pod-to-pod traffic
- [ ] Add PodDisruptionBudgets for frontend, gateway, signaling
- [ ] Configure Cloud Armor WAF rules on the Ingress
- [ ] Set up Cloud Monitoring alerts for pod restarts and error rates
