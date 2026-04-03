# Deployment Review Plan

## Scope
- Audit all production images, build steps, manifests, and public routing for the beta deployment on GCP.
- Trace frontend runtime connections for collab, terminal, AI gateway, signaling, and worker-related flows.
- Identify budget-conscious fixes that make the beta deploy correctly without overprovisioning.

## Checklist
- [x] Review image build sources and Cloud Build substitutions.
- [x] Review Kubernetes Deployments, Services, and Ingress routing.
- [x] Trace frontend environment variables and runtime endpoint construction.
- [x] Trace backend service-to-service URLs for collab, gateway, signaling, and worker.
- [x] Identify root causes for terminal, AI gateway, and worker connection failures.
- [x] Apply minimal configuration or code fixes.
- [x] Validate manifests and summarize a reliable deployment sequence.

## Review
- Confirmed live cluster issues before patching:
	- `ai-gateway`, `signaling-server`, and `y-sweet` were `UNHEALTHY` at the GKE ingress.
	- Terminal WebSocket upgrades reached `collab-server`, but PTY shells exited immediately because the container had no `/bin/bash`.
	- The static `worker` deployment crashed on `invalid turn server credentials` because the Rust worker treated STUN-only entries as TURN password credentials.
	- Browser AI/code-intel requests fell back to `localhost:8000` when public env vars were missing from the built frontend bundle.
	- The frontend compiler client did not ensure per-session worker pods before connecting to signaling.
- Changes applied:
	- Hardened terminal shell fallback and sanitized `HOME` in `backend/collab-server/terminalService.js`.
	- Fixed TURN parsing in `backend/synthi-webrtc-compiler/worker/src/main.rs`.
	- Wired compiler client spawner ensure/heartbeat flow in `synthi/src/services/compilerClient.js`.
	- Added missing AI/code-intel public env wiring in `cloudbuild.yaml`, `k8s/configmap.yaml`, and `k8s/frontend.yaml`.
	- Added GKE health-checkable websocket backend configs for gateway/signaling, removed the unused public Y-Sweet ingress route, and exposed required AI engine HTTP paths.
	- Disabled the static worker deployment in favor of dynamic per-session workers.
- Validation completed:
	- `get_errors` reported no issues in the edited files.
	- `kubectl apply --dry-run=client` succeeded for the changed Kubernetes manifests.

## Runtime Stabilization Plan

### Scope
- Repair worker runtime packaging so workspace pods can launch the VS Code server bridge.
- Remove bootstrap behavior that masks real toolchain binaries inside worker pods.
- Make git authentication survive collab restarts for existing workspace repos.
- Redeploy targeted fixes and verify the affected workspace flow end-to-end.

### Checklist
- [x] Patch the worker image to ship required VS Code bridge assets.
- [x] Remove empty `clangd`/`rustc`/`tsc` shims from dynamic and static worker bootstraps.
- [x] Add durable per-workspace git token persistence on the collab PVC.
- [x] Validate edited files locally.
- [x] Redeploy collab and worker images to `synthi-beta-cluster`.
- [ ] Re-test VS Code server readiness, cpp LSP startup, and git fetch on the live workspace.

### Review
- Live workspace pod `workspace-y3jmn3x7-6948ddfb8-jfm7w` reproduced the remaining runtime issues.
- Worker logs confirmed `vscode-server-manager.js not found`, which explains the browser-side VS Code ready timeout.
- The workspace bootstrap still writes empty `/usr/local/bin/clangd`, `/usr/local/bin/rustc`, and `/usr/local/bin/tsc` files, which can shadow the real toolchain and break LSP/tool execution.
- Frontend git flows already reload the token from localStorage for fetch/pull/push, so the remaining `AUTH_FAILED` path needs server-side durability rather than another frontend-only fix.
- Live cluster now runs the `f9e33bbe-runtimefix1` collab and worker images, and recreated workspace `y3jmn3x7` contains the expected VS Code bridge assets plus Node 20.
- Fresh worker logs no longer show `vscode-server-manager.js not found`; the manager starts, the preload bridge connects, and `clangd` is actively serving hover/code-action requests for C++ files.
- The remaining live git failure is scoped to legacy auth state: `/data/repos/_auth` is still empty for `y3jmn3x7`, so this workspace needs one successful token-bearing fetch/pull/push after the upgrade to seed persistence.
- Follow-up repo fix applied: `backend/collab-server/server.js` now uses the resolved effective repo owner for `init`/`clone` bootstrap paths so guests do not persist auth against the wrong repo scope.
- Live collab-server rollout now runs `europe-west10-docker.pkg.dev/overview-synti/synthi/synthi-collab-server:authscopefix-20260401092848`, so the effective-user bootstrap fix is active in the beta cluster.

## Hybrid Step 2 Practical Rollout

### Scope
- Roll out workspace-pool-aware collab spawning with a controlled maintenance restart.
- Preserve the live worker image pin while applying the new ConfigMap keys.
- Validate that new workspace pods land on `workspace-pool` and reap after the reduced idle timeout.

### Checklist
- [x] Build and push explicit collab image `workspacepoolfix-20260402112432`.
- [x] Pin `k8s/configmap.yaml` worker image to `f9e33bbe-runtimefix1`.
- [x] Pin `k8s/collab-server.yaml` to `workspacepoolfix-20260402112432`.
- [x] Apply `synthi-config` and `collab-server` manifests to the live cluster.
- [x] Validate `/api/spawner/ensure` creates a workspace on `workspace-pool`.
- [x] Validate idle reap after ~3 minutes without activity.

### Review
- `workspace-pool` already exists live with autoscaling, workspace labels, and the `workload=workspace:NoSchedule` taint.
- The remaining live gap before this rollout is config drift: the current `synthi-config` in-cluster does not yet expose the workspace selector and toleration keys.
- The collab rollout must use an explicit image tag, not `:latest`, to avoid regressing the working beta deployment during maintenance.
- `kubectl apply -f k8s/configmap.yaml` succeeded, so the live `synthi-config` now exposes the workspace selector and toleration keys while preserving `WORKER_IMAGE=f9e33bbe-runtimefix1`.
- The initial collab apply failed because the repo Deployment selector had drifted from the live kustomize-managed selector. `k8s/collab-server.yaml` was updated to include the live `app.kubernetes.io/managed-by` and `app.kubernetes.io/part-of` selector labels so future applies are clean.
- The controlled maintenance rollout completed successfully and `collab-server` is now running `europe-west10-docker.pkg.dev/overview-synti/synthi/synthi-collab-server:workspacepoolfix-20260402112432`.
- Synthetic validation session `step2-smoke-20260402113350` created deployment `workspace-step2-smoke-20260402113350`; its Deployment requested `nodeSelector cloud.google.com/gke-nodepool=workspace-pool`, tolerated `workload=workspace:NoSchedule`, and the running pod landed on node pool `workspace-pool`.
- Collab logs confirmed idle culling: `[Culler] Deleting idle workspace workspace-step2-smoke-20260402113350 (session=step2-smoke-20260402113350, idle=193s)`, and the workspace Deployment no longer exists in the cluster.

## Hybrid Step 4 Cloud Run Dark Deploy

### Scope
- Deploy `synthi-ai-engine`, `synthi-ai-gateway`, and `synthi-frontend` to Cloud Run with no public-serving ingress.
- Provision the shared Serverless VPC Access connector, runtime identities, and Secret Manager inputs required by those services.
- Validate private connectivity to the live Redis/Postgres tier before any ALB cutover.

### Checklist
- [x] Enable Cloud Run, Secret Manager, and Serverless VPC Access APIs.
- [x] Create Cloud Run runtime service accounts and required IAM bindings.
- [x] Seed Secret Manager from the live `synthi-secrets` data with a Cloud Run-compatible `DATABASE_URL`.
- [x] Create the `synthi-serverless-ew10` VPC connector.
- [x] Deploy `synthi-ai-engine` and `synthi-ai-gateway` dark to Cloud Run.
- [x] Deploy `synthi-frontend` dark to Cloud Run.
- [x] Validate connector reachability to Redis and Postgres.
- [x] Validate the new Cloud Run services are not publicly serving traffic.

### Review
- All three Cloud Run services are live in `europe-west10` with `run.googleapis.com/ingress=internal-and-cloud-load-balancing`, `minScale=0`, and the shared `synthi-serverless-ew10` connector.
- Deployed service URLs are:
	- `synthi-ai-engine`: `https://synthi-ai-engine-767721372193.europe-west10.run.app`
	- `synthi-ai-gateway`: `https://synthi-ai-gateway-767721372193.europe-west10.run.app`
	- `synthi-frontend`: `https://synthi-frontend-767721372193.europe-west10.run.app`
- The Cloud Run manifests were corrected to use explicit image tags, Knative `valueFrom.secretKeyRef` secret syntax, and Service-level ingress annotations.
- A Cloud Run job `synthi-vpc-smoke` reached the live private endpoints successfully: `10.72.3.8:5432` open and `10.72.2.11:6379` open.
- Direct workstation requests to the new run.app URLs returned `404`, which confirms the services are not publicly serving traffic before the standalone ALB cutover.

## Hybrid Step 5 and 6 Edge + Core Migration

### Scope
- Provision a standalone global external Application Load Balancer in front of the Cloud Run frontend/AI services and the GKE collab, signaling, and y-sweet services.
- Restore the missing public `/ysweet` route while preserving the direct ai-engine paths the current frontend still calls.
- Move `collab-server`, `signaling-server`, and `y-sweet` onto the dedicated `core-pool`.

### Checklist
- [x] Create the standalone global external ALB resources.
- [x] Create serverless NEGs for `synthi-frontend`, `synthi-ai-gateway`, and `synthi-ai-engine`.
- [x] Reuse the standalone zonal GKE NEGs for `collab-server`, `signaling-server`, and `y-sweet`.
- [x] Recreate the route map for `/`, `/collab/*`, `/signal/*`, `/ysweet/*`, and `/gateway/*`.
- [x] Preserve direct ai-engine routes `/code-intel/*`, `/classify/*`, `/provenance/*`, `/analyze/*`, `/heal/*`, and `/health/*`.
- [x] Mirror IAP onto the standalone backend services using the existing `iap-oauth-secret` credentials.
- [x] Create the `core-pool` and move `collab-server`, `signaling-server`, and `y-sweet` onto it.
- [x] Fix the stuck `y-sweet` rollout by switching to a no-surge single-node rollout strategy.

### Review
- Standalone ALB resources are live under names including `synthi-edge-ip`, `synthi-edge-url-map`, `synthi-edge-https-proxy`, and the backend services `synthi-edge-frontend-bs`, `synthi-edge-gateway-bs`, `synthi-edge-ai-engine-bs`, `synthi-edge-collab-bs`, `synthi-edge-signaling-bs`, and `synthi-edge-ysweet-bs`.
- The standalone IP is `34.49.90.162` and the URL map now includes `/ysweet` plus the original direct ai-engine public paths.
- HTTPS host-header smoke tests against `beta.synthi.app` on the standalone IP returned `302` for `/`, `/collab/debug/status`, `/signal/health`, `/ysweet/ready`, `/gateway/health`, and `/health`, which confirms the route map and IAP redirect behavior are active.
- `collab-server`, `signaling-server`, and `y-sweet` all run on `core-pool` in the live cluster.
- `y-sweet` initially deadlocked because the single-node `core-pool` could not host both rollout revisions at once. `k8s/y-sweet.yaml` now uses `maxSurge: 0` and `maxUnavailable: 1`, and the rollout has converged to a single live replica.
- `signaling-server` is healthy at the standalone ALB, and `y-sweet` is healthy on its new live endpoint after the rollout convergence.
- `collab-server` is reachable on both `10.72.1.7:1234/healthz` and `10.72.1.7:1235/debug/status` from a Cloud Run VPC-connected probe. The ALB helper was updated to health-check the native app endpoint `1235 /debug/status`, while control-plane `get-health` output may lag immediately after that update.
- The legacy ingress-managed collab backend also reports `UNHEALTHY`, so the remaining collab health-reporting mismatch appears inherited from the prior edge path rather than introduced by the standalone ALB migration.