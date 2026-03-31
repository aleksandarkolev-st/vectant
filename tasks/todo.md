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