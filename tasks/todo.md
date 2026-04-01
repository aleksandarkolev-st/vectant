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