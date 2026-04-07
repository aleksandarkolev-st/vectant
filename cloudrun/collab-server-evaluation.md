# Collab Server Cloud Run Evaluation

## Decision

No-Go for direct lift-and-shift in the current repo state.

## Why it is blocked

1. `collab-server` still uses `/data/repos` as a live repo cache and as durable auth-token storage on the PVC.
2. The git paths assume local filesystem access to working trees, which Cloud Run does not provide.
3. The service also owns dynamic workspace pod creation, which is fine from a control-plane standpoint, but it is currently bundled together with the repo-cache and git-working-tree behavior.

## What is still compatible with Cloud Run

- HTTP APIs.
- WebSockets and notification streams.
- Calls to the Kubernetes API for workspace provisioning.

## Required refactor before migration

1. Split the control-plane HTTP and websocket layer from the local repo-cache layer.
2. Move repo state and auth persistence off the PVC and into GCS, Cloud SQL, or another shared store.
3. Keep the spawner logic in the stateless control-plane service.

## Recommendation

Move `frontend`, `ai-gateway`, and `ai-engine` first.
Revisit `collab-server` only after the git/repo cache has been separated from the runtime.