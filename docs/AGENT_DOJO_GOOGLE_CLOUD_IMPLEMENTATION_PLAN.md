# Agent Dojo Google Cloud Implementation Plan

**Status:** implementation plan, not a deployment log  
**Date:** 2026-06-19  
**Repo:** `vectant-ade`  
**Branch prepared on:** `dojo/gcp-cloud-implementation-plan`  
**Target project:** `vectant-proj`  
**Target cluster:** `synthi-beta-cluster` in `europe-west10-a`  
**Primary domain:** `beta.vectant.dev`  

This document describes the Google Cloud work needed to host the Agent Dojo
enterprise release path described by `docs/AGENT_DOJO_RELEASE_GATE_RUNBOOK.md`.
It intentionally separates the existing beta application deployment from the
additional infrastructure required to claim mature Dojo production readiness.

The plan does not require hardcoded one-off edge-case behavior. All resource
names below are environment parameters or documented defaults for the current
production target.

---

## Executive Summary

The core Synthi application is already hosted on Google Cloud:

- GKE cluster: `synthi-beta-cluster`
- Artifact Registry repository: `europe-west10-docker.pkg.dev/vectant-proj/synthi`
- Static global IP: `synthi-ip`
- HTTPS load balancer and managed certificate for `beta.vectant.dev`
- Wildcard preview routing for `*.preview.vectant.dev`
- Runtime node pool: `workspace-pool`
- GCS bucket: `vectant-synthi-cloud-storage`

The Agent Dojo enterprise release path is partially hosted and the production
deploy entrypoints now render the Dojo release overlay by default. That makes
the live beta path exercise the release substrate, but Google Cloud still needs
production-grade evidence before mature enterprise readiness can be claimed:

- Cloud SQL or equivalent external Postgres for durable Dojo control plane
- external Redis or equivalent production cache/coordination store
- Cloud KMS or an approved managed signing service for proof signing
- Secret Manager values for all Dojo release secrets
- External Secrets synchronization into the `synthi` namespace
- deployed `dojo-mcp-host` behind `/dojo/mcp`
- Kubernetes read access from operator/CI machines
- release evidence proving the hosted MCP path, durable stores, signing, and
  non-loopback workflow runtime

Do not claim Dojo enterprise production readiness until the preflight inventory,
blocker report, deployed conformance, and enterprise release gates are clean.

---

## Current Hosting Architecture

### Production Application Path

The existing app uses this architecture:

```text
GitHub Actions
  -> Cloud Build
  -> Artifact Registry images
  -> GKE kustomize render/apply
  -> GKE Deployments
  -> GCP HTTPS Load Balancer
  -> beta.vectant.dev
```

Public routing currently resolves through a GKE-managed HTTPS load balancer:

```text
https://beta.vectant.dev/          -> frontend
https://beta.vectant.dev/collab    -> collab-server
https://beta.vectant.dev/signal    -> signaling-server
https://beta.vectant.dev/gateway   -> ai-gateway
https://*.preview.vectant.dev/     -> collab preview proxy
```

Runtime workspaces are spawned dynamically by the collab server. Each active
runtime gets a Kubernetes Deployment/Service using an opaque runtime ID. The
workflow bridge and hosted browser run in the runtime pod path when configured.

### Current Repo Deployment Surfaces

Important files:

- `.github/workflows/deploy-prod.yml`
  - submits Cloud Build through GitHub Actions Workload Identity
  - supports manual `kustomize_dir` and `kustomize_load_restrictor`

- `cloudbuild.yaml`
  - builds application images
  - builds `synthi-browser-workflow-bridge`
  - conditionally builds `synthi-mcp-http` for the Dojo release overlay
  - renders a selected kustomize directory
  - replaces registry and image tag placeholders before applying
  - runs Prisma migration before rollout
  - waits for deployment rollouts

- `k8s/`
  - base beta-compatible application stack
  - includes in-cluster Postgres and Redis
  - suitable for beta app hosting, not sufficient as enterprise Dojo proof

- `k8s/overlays/dojo-release-gate/`
  - production release overlay used by the default deploy entrypoints
  - base `k8s/` remains available for beta-compatible rollback/debug deploys
  - adds Dojo production enforcement config
  - adds release-only external secret contracts
  - adds `dojo-mcp-host`
  - patches ingress with `/dojo/mcp`
  - removes base in-cluster Redis config from the runtime config map
  - omits in-cluster Redis/Postgres workloads and their NetworkPolicies

- `mcp/synthi-mcp/scripts/dojo-gcp-release-inventory.mjs`
  - read-only Google Cloud/Kubernetes inventory

- `mcp/synthi-mcp/scripts/dojo-gcp-release-blockers.mjs`
  - converts inventory into operator-facing blockers

---

## Live Inventory Findings From 2026-06-19

Read-only `gcloud` checks found:

- active account: `aleksandar.kolev@vectant.dev`
- active project: `vectant-proj`
- GKE cluster exists and is running
- Artifact Registry repository exists
- static IP exists and is in use
- GCS bucket exists
- URL map includes `beta.vectant.dev` and `*.preview.vectant.dev`
- managed certificate for `beta.vectant.dev` is active
- preview wildcard certificate exists
- Cloud Build API is enabled

Read-only checks also found blockers:

- no Cloud Build triggers are configured in the project
  - this may be acceptable if GitHub Actions is the intended deploy trigger
- Cloud SQL Admin API is not enabled or not visible
- Memorystore Redis API is not enabled or not visible
- Cloud KMS API is not enabled or not visible
- Secret Manager inventory returned no expected Dojo release secrets
- Kubernetes inspection from the local machine is blocked by missing
  `gke-gcloud-auth-plugin.exe`
- current URL map does not include `/dojo/mcp`
- no `dojo-mcp-host` backend service is visible

The generated blocker report was written to:

```text
tmp/dojo-gcp-release-blockers-live-inspect/dojo-gcp-release-blockers.md
```

This generated artifact is local evidence only and should not be committed.

---

## Target Dojo Enterprise Architecture

The mature hosted Dojo path should look like this:

```text
Agent / MCP client
  -> HTTPS load balancer / IAP
  -> /dojo/mcp
  -> dojo-mcp-host Deployment
  -> Dojo proof validator
  -> Dojo license kernel
  -> durable proof/control-plane Postgres
  -> evidence ledger Postgres
  -> managed proof-signing service
  -> runtime workflow bridge / hosted browser session
  -> evidence and audit records
```

Data dependencies:

```text
Secret Manager
  -> External Secrets Operator
  -> synthi-secrets Kubernetes Secret
  -> dojo-mcp-host and runtime workflow bridge env

Cloud SQL Postgres
  -> Dojo control plane state
  -> proof replay records
  -> evidence ledger records

Cloud KMS or signing service
  -> proof capsule signatures
  -> manifest signatures

Memorystore Redis
  -> production cache/session/coordination where required by app services
```

The Dojo overlay is the production deploy default. Passing release gates is
still required before claiming Dojo enterprise production readiness.

---

## Required Google Cloud Work

### 1. Fix Local And CI Kubernetes Authentication

Current local `kubectl` cannot authenticate because the GKE auth plugin is
missing.

Required actions:

```powershell
gcloud components install gke-gcloud-auth-plugin
gcloud container clusters get-credentials synthi-beta-cluster `
  --zone europe-west10-a `
  --project vectant-proj
kubectl get namespace synthi
```

CI/Cloud Build must also be verified. The current Cloud Build uses separate
`gcloud` and `kubectl` builders. Confirm the `kubectl` builder can authenticate
against modern GKE clusters. If it cannot, replace the deploy step with a Cloud
SDK image that includes `gke-gcloud-auth-plugin`, or install the plugin in the
deploy step before running `kubectl`.

Acceptance:

- `kubectl get namespace synthi` succeeds from the operator machine
- Cloud Build deploy step can run `kubectl get namespace synthi`
- no release inventory item fails because of missing Kubernetes credentials

### 2. Enable Or Grant Visibility To Required APIs

Required APIs for the Dojo enterprise path:

```text
artifactregistry.googleapis.com
cloudbuild.googleapis.com
container.googleapis.com
compute.googleapis.com
secretmanager.googleapis.com
iamcredentials.googleapis.com
cloudkms.googleapis.com
sqladmin.googleapis.com
redis.googleapis.com
storage.googleapis.com
certificatemanager.googleapis.com
logging.googleapis.com
monitoring.googleapis.com
```

Known missing or not visible from the latest inventory:

```text
cloudkms.googleapis.com
sqladmin.googleapis.com
redis.googleapis.com
```

Required actions:

```powershell
gcloud services enable cloudkms.googleapis.com `
  sqladmin.googleapis.com `
  redis.googleapis.com `
  --project vectant-proj
```

This is a cloud-state change and should be run only after operator approval.

Acceptance:

- `gcloud services list --enabled --project vectant-proj` includes all required APIs
- release inventory no longer reports `api:*` blockers

### 3. Provision Durable Postgres For Dojo

The base `k8s/` stack includes in-cluster Postgres. That is not acceptable as
enterprise Dojo evidence for proof replay, durable control-plane state, or the
evidence ledger.

Required decision:

- use one Cloud SQL instance with separate databases for control plane and
  evidence ledger, or
- use separate Cloud SQL instances for isolation

Recommended initial production shape:

```text
Cloud SQL instance: synthi-prod-postgres
Region: europe-west10
Databases:
  synthi
  synthi_dojo_control_plane
  synthi_dojo_evidence_ledger
Users:
  synthi_app
  synthi_dojo_control_plane
  synthi_dojo_evidence_ledger
```

Required Secret Manager values:

```text
synthi-dojo-control-plane-postgres-url
synthi-dojo-evidence-ledger-postgres-url
```

Implementation notes:

- prefer private IP connectivity from GKE
- avoid embedding database credentials in manifests
- use least-privilege database users
- set automated backups and point-in-time recovery before release evidence
- run Dojo migrations before deploying the overlay as production-ready

Acceptance:

- Cloud SQL inventory can verify the configured instance
- release inventory confirms the expected Cloud SQL instance
- Dojo control-plane and evidence-ledger connection strings exist in Secret Manager
- migration jobs succeed against the target database

### 4. Provision External Redis Or Confirm An Approved Alternative

The Dojo release overlay expects `REDIS_URL` from Secret Manager and removes
the base in-cluster Redis URL from the config map.

Recommended resource:

```text
Memorystore Redis instance: synthi-prod-redis
Region: europe-west10
```

Required Secret Manager value:

```text
synthi-redis-url
```

Acceptance:

- `redis.googleapis.com` is enabled
- release inventory can verify `synthi-prod-redis`
- `REDIS_URL` is available through External Secrets
- app services no longer depend on in-cluster Redis for Dojo release proof

### 5. Provision Managed Signing

Dojo proof capsules and MCP manifests must not rely on local default signing
keys in production.

Required decision:

- Cloud KMS asymmetric signing, or
- approved managed signing service invoked through a locked-down command

Recommended shape:

```text
KMS key ring: synthi-dojo
KMS key: dojo-proof-signing
Algorithm: elliptic curve signing compatible with the Dojo verifier
```

Required Secret Manager values:

```text
synthi-dojo-proof-signing-key-id
synthi-dojo-proof-signing-command
synthi-dojo-proof-signing-command-args
synthi-dojo-proof-signing-managed-key-uri
synthi-dojo-proof-signing-public-key-pem
synthi-dojo-mcp-manifest-key-id
synthi-dojo-mcp-manifest-private-key-pem
synthi-dojo-mcp-manifest-public-key-pem
```

If private MCP manifest signing remains PEM-based initially, document that as
a temporary controlled release limitation. Proof capsule signing should move to
managed custody before mature release.

Acceptance:

- production readiness rejects default/local proof signing
- a proof capsule can be verified outside the issuing process
- key ID and public key are available for validation
- release evidence includes managed-key signing observation

### 6. Populate Secret Manager

The Dojo release overlay derives expected secret contracts from rendered
kustomize output. These remote Secret Manager names must exist:

```text
synthi-redis-url
synthi-dojo-control-plane-postgres-url
synthi-dojo-evidence-ledger-postgres-url
synthi-dojo-proof-signing-key-id
synthi-dojo-proof-signing-command
synthi-dojo-proof-signing-command-args
synthi-dojo-proof-signing-managed-key-uri
synthi-dojo-proof-signing-public-key-pem
synthi-dojo-mcp-manifest-key-id
synthi-dojo-mcp-manifest-private-key-pem
synthi-dojo-mcp-manifest-public-key-pem
synthi-dojo-mcp-bearer-token
synthi-dojo-hosted-browser-cdp-url
synthi-dojo-hosted-browser-workspace-url
synthi-dojo-release-workspace-id
synthi-dojo-release-agent-id
synthi-private-workflow-tool-store-file
synthi-private-workflow-tool-scope
synthi-auth-checkpoint-store-file
synthi-auth-checkpoint-scope
```

Do not commit secret payloads. Do not print secret payloads in logs. Inventory
should check only names, synchronization status, and digest metadata where
appropriate.

Acceptance:

- `gcloud secrets list --project vectant-proj` includes all required remote names
- Kubernetes `ExternalSecret` resources sync into `synthi-secrets`
- release inventory has no `secret_inventory` blockers

### 7. Verify External Secrets Operator

The base and Dojo release overlay expect an External Secrets `SecretStore`
named `gcp-secret-manager`.

Required checks:

```powershell
kubectl get secretstore gcp-secret-manager -n synthi
kubectl get externalsecret -n synthi
kubectl describe externalsecret synthi-secrets -n synthi
kubectl describe externalsecret synthi-dojo-release-secrets -n synthi
```

Acceptance:

- External Secrets Operator is installed
- `SecretStore` can read from GCP Secret Manager
- `synthi-secrets` exists
- `synthi-dojo-release-secrets` syncs required Dojo keys into a dedicated
  Kubernetes Secret, so the base `synthi-secrets` ExternalSecret does not
  overwrite Dojo release-only keys during refresh

### 8. Deploy The Dojo Release Overlay

Only deploy after inventory blockers for APIs, Cloud SQL, Redis, secrets, and
Kubernetes context are resolved.

Manual GitHub Actions path:

```text
Workflow: Deploy Production
Inputs:
  kustomize_dir: k8s/overlays/dojo-release-gate
  kustomize_load_restrictor: LoadRestrictionsNone
  image_tag: optional immutable release tag
```

Manual script path:

```bash
GCLOUD_BIN="/path/to/gcloud" scripts/deploy-prod.sh \
  --project vectant-proj \
  --region europe-west10 \
  --cluster synthi-beta-cluster \
  --zone europe-west10-a \
  --kustomize-dir k8s/overlays/dojo-release-gate \
  --kustomize-load-restrictor LoadRestrictionsNone
```

Expected new deployed objects:

```text
Deployment/dojo-mcp-host
Service/dojo-mcp-host
BackendConfig/dojo-mcp-host-backend-config
Ingress path /dojo/mcp
ExternalSecret/synthi-dojo-release-secrets
```

Acceptance:

- `kubectl rollout status deployment/dojo-mcp-host -n synthi` succeeds
- URL map includes `/dojo/mcp`
- backend service for `dojo-mcp-host` exists
- IAP is enabled on the MCP backend
- MCP bearer header uses `X-Synthi-Dojo-Mcp-Token`
- public access without IAP/app token is blocked

### 9. Run Release Inventory And Blocker Summary

After deployment, run:

```powershell
$env:PROJECT_ID = "vectant-proj"
$env:REGION = "europe-west10"
$env:ZONE = "europe-west10-a"
$env:CLUSTER = "synthi-beta-cluster"
$env:K8S_NAMESPACE = "synthi"
$env:AR_REPO = "synthi"
$env:DOMAIN = "beta.vectant.dev"
$env:GCS_BUCKET = "vectant-synthi-cloud-storage"
$env:CLOUD_SQL_INSTANCE = "synthi-prod-postgres"
$env:REDIS_INSTANCE = "synthi-prod-redis"

node mcp/synthi-mcp/scripts/dojo-gcp-release-inventory.mjs `
  --execute `
  --project=$env:PROJECT_ID `
  --region=$env:REGION `
  --zone=$env:ZONE `
  --cluster=$env:CLUSTER `
  --namespace=$env:K8S_NAMESPACE `
  --artifact-repository=$env:AR_REPO `
  --gcs-bucket=$env:GCS_BUCKET `
  --cloud-sql-instance=$env:CLOUD_SQL_INSTANCE `
  --redis-instance=$env:REDIS_INSTANCE `
  --domain=$env:DOMAIN `
  --expected-inventory-from-rendered-kustomization=k8s/overlays/dojo-release-gate `
  --out-dir=tmp/dojo-gcp-release-inventory

node mcp/synthi-mcp/scripts/dojo-gcp-release-blockers.mjs `
  --inventory-report=tmp/dojo-gcp-release-inventory/dojo-gcp-release-inventory.json `
  --out-dir=tmp/dojo-gcp-release-blockers
```

Acceptance:

- blocker report says `Release ready: yes`
- no warnings are promoted to blockers in strict mode
- generated evidence is archived outside the repo

### 10. Run Dojo Enterprise Release Gates

After hosting dependencies are ready:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs `
  --scope enterprise-release `
  --execute `
  --continue-on-failure `
  --fail-on-missing-env

node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs `
  --release-gate-run-report tmp/dojo-release-gate-runner/dojo-release-gate-runner-report.json `
  --release-gate-run-evidence tmp/dojo-release-gate-runner/dojo-release-gate-runner.evidence.json
```

Required live gate classes:

- hosted runtime gateway observation
- managed-key signing observation
- deployed MCP host conformance
- private tool host conformance
- proof replay and revocation checks
- security/abuse checks
- chaos/performance/soak evidence appropriate to release scope
- visual evidence where UI/runtime surfaces are involved

Acceptance:

- `promotion_ready=true`
- no release-critical gate is skipped
- evidence manifests contain real command results, not placeholder logs
- visual evidence exists for any UI or browser-runtime path claimed in release

---

## Security And Policy Changes Needed

### Network Policy

The cluster currently reports network policy disabled. If the release claim
depends on Kubernetes `NetworkPolicy`, enable enforcement or explicitly remove
that as a claimed control.

Recommended:

- enable Dataplane V2 or network policy enforcement on a planned maintenance
  window
- verify all existing NetworkPolicy resources are enforced after enablement

### RBAC

The cluster description reported insecure RBAC binding flags. Review and
correct before enterprise release if still present:

```text
enableInsecureBindingSystemAuthenticated
enableInsecureBindingSystemUnauthenticated
```

### Cloud Build Deploy Auth

Confirm Cloud Build has least privilege:

- Artifact Registry writer
- GKE deploy permissions scoped to target cluster
- IAM service account user only where needed
- Secret access only for build-time secrets that are truly required

### IAP And MCP Tokens

Dojo MCP host must enforce both:

- outer access: IAP or equivalent authenticated ingress
- app-layer MCP bearer token through `X-Synthi-Dojo-Mcp-Token`

The IAP token and MCP bearer token are different controls and should remain
separate.

---

## Rollout Order

1. Fix local and CI Kubernetes auth.
2. Re-run read-only inventory to establish a clean baseline for currently
   deployed beta resources.
3. Enable or get visibility into required APIs.
4. Provision external Postgres.
5. Provision external Redis or approved equivalent.
6. Provision managed proof-signing.
7. Populate Secret Manager with required names and payloads.
8. Verify External Secrets sync into the `synthi` namespace.
9. Run inventory and blocker summary.
10. Deploy or re-deploy the Dojo release overlay only after explicit release
   approval, then verify blockers are resolved.
11. Run hosted MCP and runtime conformance gates.
12. Run enterprise release gates.
13. Archive evidence manifest and visual artifacts.
14. Promote only if all release blockers are clear.

---

## Rollback Plan

Dojo release overlay rollback should not roll back the entire beta app unless
the base app is affected.

Rollback options:

1. Re-run Cloud Build or GitHub Actions with:

```text
kustomize_dir: k8s
kustomize_load_restrictor: empty
```

2. If only MCP host is unhealthy:

```powershell
kubectl rollout undo deployment/dojo-mcp-host -n synthi
```

3. If ingress routing is bad:

- revert the overlay or ingress path patch
- re-render and apply the previous known-good manifest

4. If external store credentials are bad:

- rotate/fix Secret Manager payloads
- force External Secrets refresh
- restart only affected deployments after sync

Rollback acceptance:

- `/`, `/collab`, `/signal`, `/gateway`, and preview routes remain healthy
- `/dojo/mcp` is either healthy or intentionally absent
- no production action can bypass proof enforcement because of rollback

---

## Validation Commands

Run local harness checks before cloud rollout:

```powershell
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:runner:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:verify:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:package-readiness:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:kustomize-overlay:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:gcp-release-inventory:self-check
npm --prefix mcp/synthi-mcp run proof:dojo:gcp-release-blockers:self-check
```

Render overlay locally before deploying:

```powershell
kubectl kustomize --load-restrictor=LoadRestrictionsNone k8s/overlays/dojo-release-gate > tmp/dojo-release-overlay.yaml
Select-String -Path tmp/dojo-release-overlay.yaml -Pattern "build-tag-required"
Select-String -Path tmp/dojo-release-overlay.yaml -Pattern "/dojo/mcp"
Select-String -Path tmp/dojo-release-overlay.yaml -Pattern "dojo-mcp-host"
```

Run cloud inventory before and after rollout:

```powershell
node mcp/synthi-mcp/scripts/dojo-gcp-release-inventory.mjs --execute `
  --project=vectant-proj `
  --region=europe-west10 `
  --zone=europe-west10-a `
  --cluster=synthi-beta-cluster `
  --namespace=synthi `
  --artifact-repository=synthi `
  --gcs-bucket=vectant-synthi-cloud-storage `
  --cloud-sql-instance=synthi-prod-postgres `
  --redis-instance=synthi-prod-redis `
  --domain=beta.vectant.dev `
  --expected-inventory-from-rendered-kustomization=k8s/overlays/dojo-release-gate `
  --out-dir=tmp/dojo-gcp-release-inventory
```

---

## Open Decisions

1. **Cloud Build trigger source**
   - GitHub Actions is currently the likely production entrypoint.
   - Project-level Cloud Build triggers are absent.
   - Decide whether to keep GitHub Actions only or add a Cloud Build GitHub
     trigger.

2. **Postgres topology**
   - One Cloud SQL instance with separate databases is simpler.
   - Separate instances provide stronger blast-radius isolation.

3. **Signing custody**
   - Cloud KMS is the cleanest Google Cloud-native answer.
   - A custom signing service is acceptable only if it has equivalent audit,
     isolation, and key-rotation properties.

4. **NetworkPolicy enforcement**
   - Current manifests include policies, but cluster enforcement must be
     verified.

5. **Dojo host exposure model**
   - `/dojo/mcp` behind the same `beta.vectant.dev` load balancer is the
     current overlay design.
   - A dedicated host such as `dojo-mcp.beta.vectant.dev` may be cleaner if
     IAP, audit, rate limits, or client configuration diverge.

6. **Release evidence archive location**
   - Recommended prefix:

```text
gs://vectant-synthi-cloud-storage/release-evidence/dojo/<release-tag>/
```

---

## Do Not Claim Until Complete

Do not claim:

- mature Dojo hosted production readiness
- production-grade proof signing
- durable evidence ledger custody
- deployed MCP host conformance
- non-loopback hosted runtime conformance
- enterprise release gate pass

Safe current claim:

```text
The base Synthi application is hosted on Google Cloud. The repo contains an
Agent Dojo release overlay and release-gate tooling, and production deploy
entrypoints render that overlay by default. The Dojo enterprise release path
still requires live inventory, blocker, deployed MCP host, hosted runtime, and
enterprise gate evidence before it can be claimed production-ready.
```
