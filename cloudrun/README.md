# Hybrid GKE + Cloud Run Migration Notes

## Target split

- Cloud Run: frontend, ai-gateway, ai-engine.
- GKE core-pool: only the support services that cannot yet leave Kubernetes.
- GKE workspace-pool: autoscaled workspace workers with min-nodes=0.

## Critical ingress blocker

The current beta entrypoint is a GKE Ingress that owns path routing for `/`, `/collab`, `/signal`, `/gateway`, and `/ysweet`.
That controller only manages Kubernetes backends. It will overwrite any manual URL map edits, so it is not a safe place to bolt Cloud Run onto the existing load balancer.

## Safe frontend cutover options

1. Preferred: replace the current GKE-managed ingress with a standalone external Application Load Balancer.
2. Use a serverless NEG for the Cloud Run frontend.
3. Keep the remaining GKE services on backend services or NEGs for `/collab`, `/signal`, `/gateway`, and `/ysweet`.
4. Move DNS only after the standalone ALB is serving the full route map.

## Simpler beta alternative

Use separate hostnames during migration.

- `beta.synthi.app` or `app.beta.synthi.app` -> Cloud Run frontend.
- `collab.beta.synthi.app` -> GKE collab-server.
- `signal.beta.synthi.app` -> GKE signaling-server.
- `gateway.beta.synthi.app` -> Cloud Run or GKE ai-gateway.
- `ysweet.beta.synthi.app` -> GKE y-sweet.

This is easier to cut over, but it requires updating the public frontend env vars and reviewing CORS.

## VPC connector guidance

Only attach a Serverless VPC Access connector to a Cloud Run service that must reach private VPC targets.
It introduces a fixed baseline cost, so it should not be used on every service by default.

## Ordered rollout

1. Create `core-pool` and `workspace-pool`.
2. Deploy the frontend, ai-gateway, and ai-engine Cloud Run services.
3. Stand up a standalone ALB or temporary migration subdomains.
4. Shift traffic to the Cloud Run frontend.
5. Drain the old default GKE pool only after the always-on support tier no longer depends on it.