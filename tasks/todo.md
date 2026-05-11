# C++ Compile / HMR Stress Test 2026-05-11

## Scope
- Stress test C++ compile + HMR in workspace nzl1wr9x via Playwright.
- Find errors, fix them, redeploy to docker.

## What was wrong
1. **ai-engine `/data:ro` + uid mismatch** — `/code-intel/index` 500'd on every workspace load with "Read-only file system: '/data/repos/<slug>/.code_intel'". Even after dropping `:ro`, ai-engine ran as uid 999 while collab-server's `/data` tree is owned 1001:1001 → "Permission denied".
2. **Worker LSP send-retry spam** — `dc_send_with_backpressure` would burn 20+40+80+160+320 ≈ 620 ms of exponential backoff per call even when the WebRTC DataChannel was permanently `Closed`. With LSP servers (cpp + java) producing diagnostics continuously after a peer disconnect, the worker log filled with `[lsp] send error (retry N/5): DataChannel is not opened`.

## Fixes
- `docker-compose.yml`: drop `:ro` on `ai-engine` `collab-data` mount; update comment.
- `ai-backend/ai-engine/Dockerfile`: pin appuser to uid/gid 1001 to match the `/data/repos` ownership written by collab-server.
- `backend/synthi-webrtc-compiler/worker/src/main.rs`: fast-fail `dc_send_with_backpressure` / `dc_send_text_with_backpressure` if `ready_state()` is not `Open` (both pre-send and after each transient error). Stops the retry loop the instant the channel goes closed.

## Deploy
- `docker compose build ai-engine && docker compose up -d ai-engine` ✅
- `docker compose build worker && docker compose up -d worker` ✅
- Verified: ai-engine `whoami` → uid 1001, `touch /data/wt` succeeds; worker logs free of `[lsp] send error (retry N/5)` spam; `/code-intel/index` no longer 500s on workspace load.

## Known not-fixed (out of scope for this run)
- Playwright Chromium ↔ Docker-network WebRTC ICE fails (browser host candidates not reachable from worker container). This silently hangs the "Run" button: clicks do nothing if the compile DataChannel never opened. Real users running Chrome on the host don't hit this, but the silent-hang UX is still a bug worth a follow-up (timeout + error toast in `compilerClient.compile()`).
- `/git/<slug>/fetch` 400 — unauthenticated git fetch path; separate concern.
- VS Code Server install fails (`tar: trailing garbage ignored`) — unrelated to C++ HMR.

---

# Docker Compose EOF Investigation

## Scope
- Determine whether the local `docker compose build frontend` failure is caused by the frontend app build or by Docker/BuildKit losing the session.
- Confirm why the output references both `frontend` and `ai-engine` even when only `frontend` was requested.
- Summarize the most likely root cause and the next minimal diagnostic or workaround.

## Checklist
- [in-progress] Trace the compose and Dockerfile path for `frontend` and `ai-engine`.
- [not-started] Run minimal Docker daemon and buildx diagnostics around the EOF.
- [not-started] Summarize the failure mode and next action.

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

## Hybrid Step 7 and 8 Default-Pool Retirement

### Scope
- Retire the remaining legacy GKE frontend, ai-gateway, ai-engine, and postgres workloads from `default-pool`.
- Prove the standalone ALB is stable after DNS cutover and keep the old ingress at zero beta-domain traffic before pool deletion.
- Delete `default-pool` without breaking the core collab/signaling/y-sweet path.

### Checklist
- [x] Fix the standalone collab backend unhealthy report.
- [x] Point collab and worker AI traffic at the Cloud Run ai-engine URL.
- [x] Move Redis onto `core-pool`.
- [x] Scale legacy GKE frontend, ai-gateway, ai-engine, and postgres to zero.
- [x] Prove `beta.synthi.app` uses the standalone ALB and the old ingress has zero beta-domain traffic for 15 minutes.
- [x] Drain and delete `default-pool`.
- [x] Summarize the steady-state idle burn delta.

### Review
- Root cause of the standalone collab unhealthy report was missing firewall coverage for Google health-check source ranges to the collab ports. `ops/gcp/ensure-standalone-edge-alb.ps1` now reconciles `synthi-edge-gke-hc-fw`, and `synthi-edge-collab-bs` became `HEALTHY` after the rule was applied.
- `k8s/configmap.yaml` now points `CODE_INTEL_URL` and `BACKEND_URL` at `https://synthi-ai-engine-767721372193.europe-west10.run.app`, and a live collab restart verified the Cloud Run ai-engine `/health` endpoint returns `200 OK` from inside the cluster.
- `k8s/redis.yaml` now pins Redis to `core-pool`, and Redis was migrated live before the default-pool drain.
- `k8s/frontend.yaml`, `k8s/ai-gateway.yaml`, `k8s/ai-engine.yaml`, and `k8s/postgres.yaml` were aligned to the live kustomize-managed selectors so `kubectl apply` could scale them cleanly to zero instead of failing on immutable selector or StatefulSet drift.
- The standalone ALB stayed stable through the cutover window. Post-cutover checks reported `old_beta_15m=0`, `new_5xx_15m=0`, and synthetic requests to `/`, `/collab/debug/status`, `/signal/health`, `/ysweet/ready`, and `/gateway/health` all returned the expected `302` IAP redirect.
- The `default-pool` deletion was blocked initially by regional CPU and in-use-address quotas, so the safe fix was a rolling pool swap: drain one default node, resize `default-pool` down by one, resize `core-pool` up by one, and repeat. Final steady state is three `core-pool` nodes and zero `default-pool` nodes.
- Post-delete verification shows only `core-pool` nodes remain, all synthi and cluster-system pods are running there, and the standalone ALB backends for collab, signaling, and y-sweet all report `HEALTHY`.
- Approximate steady-state idle burn for the always-on node layer dropped from about `$157.65/month` (`3 x e2-standard-2` default nodes plus `1 x e2-small` core node) to about `$32.85/month` (`3 x e2-small` core nodes), a reduction of about `$124.80/month` or `79%`. This excludes Cloud Run request-driven usage and assumes public on-demand Compute Engine list pricing over `730` hours/month.

## Post-Ingress Cleanup Follow-Through

### Scope
- Remove ingress-era manifests and service annotations from the repo so the old GKE ingress stack cannot be recreated.
- Give the standalone ALB its own managed certificate and make it self-sufficient for Cloud Run IAP.
- Delete the remaining live ingress-era GCLB and Kubernetes resources after confirming standalone ownership is complete.

### Checklist
- [x] Remove `k8s/ingress.yaml` from the repo and from `k8s/kustomization.yaml`.
- [x] Remove ingress-only BackendConfig annotations from the retained services.
- [x] Update `ops/gcp/ensure-standalone-edge-alb.ps1` to manage its own cert and Cloud Run IAP service identity.
- [x] Provision the IAP service identity and restore the public `302` IAP flow for Cloud Run-backed routes.
- [ ] Delete the remaining live ingress-era Kubernetes and GCLB resources.

### Review
- Repo cleanup is complete: `k8s/ingress.yaml` is deleted, `k8s/kustomization.yaml` no longer references ingress, and ingress-era BackendConfig annotations were removed from `frontend`, `ai-gateway`, `collab-server`, and `signaling-server` service manifests.
- `ops/gcp/ensure-standalone-edge-alb.ps1` now defaults to a dedicated managed certificate name `synthi-edge-cert`, creates the IAP service identity through the Service Usage REST API, and grants the IAP service agent `roles/run.invoker` on `synthi-frontend`, `synthi-ai-gateway`, and `synthi-ai-engine` before updating the standalone backend services.
- The live Cloud Run IAP failure was fixed by generating the IAP service identity for project `767721372193`. After that change, `https://beta.synthi.app/` and workspace routes resumed returning the expected Google IAP `302` redirect instead of the `IAP service account is not provisioned` error.
- Final live deletion of the old ingress-era resources is currently blocked only by expired local `gcloud` credentials. `gcloud` can list the active account but cannot refresh access tokens non-interactively, so `kubectl` and `gcloud compute` mutations now require a fresh interactive `gcloud auth login` before the old `synthi-ingress` and `k8s1`/`k8s2` load-balancer resources can be deleted safely.

## Test Repair and Workspace Import Reliability

### Scope
- Green the remaining pre-existing targeted frontend and ai-engine test failures without changing current runtime semantics.
- Make workspace clone/import resilient when the secondary app-side workspace registration call is delayed or unavailable.
- Keep the fix minimal and aligned with the post-migration architecture where the browser is already authenticated against the main app.

### Checklist
- [x] Update stale frontend tests to match current docking and AI suppression behavior.
- [x] Update the targeted ai-engine registry tests to match current language-scoped rule semantics.
- [x] Make collab clone workspace registration best-effort instead of fatal after a successful clone.
- [x] Have the dashboard explicitly ensure the workspace record exists in the app before redirecting.
- [x] Re-run the targeted frontend and ai-engine suites.

### Review
- `aiSuppressedRules.test.js` now imports the module with a direct relative path and its `mergeRemote` expectation acknowledges the local pending op before asserting remote replacement.
- `layout-ops.test.js` now builds its fixture without the placeholder root tab group and asserts against the current `findTabGroup`, `collectTabIds`, `walkTree`, and `resizeSplit` APIs.
- `test_rule_registry.py` now validates the current mix of global and language-scoped rules instead of assuming every registry entry is `languages={"*"}`.
- `backend/collab-server/server.js` no longer turns a successful clone into a hard failure when the secondary app-side workspace registration call cannot be completed; the result now reports registration state for callers.
- `synthi/src/app/page.jsx` now explicitly posts to `/api/workspace` after a successful clone, so the authenticated frontend ensures the workspace DB row exists before redirecting.
- Targeted verification passed: `vitest` reported `47 passed`, and `pytest test/test_cache.py test/test_rule_registry.py -q` reported `17 passed`.

## Navbar Logo PNG Swap

### Scope
- Replace the workspace navbar logo with the provided Vectant PNG assets for light and dark themes.
- Stop using the recreated SVG wordmarks and restore the repo SVG assets to their original state.
- Rebuild the frontend container and verify the updated navbar at localhost.

### Checklist
- [ ] Copy the provided Vectant PNG assets into `synthi/public`.
- [ ] Update `TopNav.jsx` to use the PNG assets by theme.
- [ ] Restore the original `synthi-logo.svg` and `synthi-dark-logo.svg` files.
- [ ] Rebuild and restart the frontend service.
- [ ] Verify the updated navbar renders at `http://localhost:3000`.