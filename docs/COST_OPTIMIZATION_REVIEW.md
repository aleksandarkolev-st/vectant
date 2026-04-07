# Cost Optimization Review

## Spot VMs

### Recommendation

No-Go for the primary workspace pool.

### Why

- Developer sessions are interactive and stateful.
- Spot interruptions would translate directly into dropped IDE sessions and lost momentum.
- The savings are real, but the user experience penalty is high for the main beta path.

### Safe use

Go for a secondary overflow pool or non-critical preview workloads once reconnect and session-resume behavior is proven.

## Workspace bin-packing

### Current request profile

- Requests: `500m CPU / 1Gi RAM`
- Limits: `2 CPU / 4Gi RAM`

### Recommendation

Keep the current limits, but profile a lower default request class for beta.

- Conservative beta target: `400m CPU / 768Mi RAM`
- Aggressive target after measurement: `350m CPU / 768Mi RAM`
- Heavy C++ or Java workspaces should stay at `500m / 1Gi`

### Why

- CPU is the first scheduler constraint on the current cluster.
- Lowering requests increases sessions per node without cutting burst headroom because the limits remain unchanged.
- Larger workspace nodes such as `e2-standard-4` reduce per-node overhead and usually pack better than many small nodes.

## Cloud Logging exclusions

### Recommendation

Drop low-value collab debug and heartbeat noise before it reaches long-term storage.

### Example exclusion filter: collab debug noise

```text
resource.type="k8s_container"
resource.labels.namespace_name="synthi"
resource.labels.container_name="collab"
(severity="DEFAULT" OR jsonPayload.level="debug")
```

### Example exclusion filter: workspace heartbeat churn

```text
resource.type="k8s_container"
resource.labels.namespace_name="synthi"
resource.labels.container_name="collab"
(textPayload=~"\\[Spawner\\] touch" OR textPayload=~"\\[Culler\\] Started")
```

### Example exclusion filter: successful health probes

```text
resource.type="k8s_container"
resource.labels.namespace_name="synthi"
resource.labels.container_name="collab"
httpRequest.status=200
httpRequest.requestUrl=~"/debug/status"
```

## Go / No-Go Summary

- Spot VMs for primary active workspaces: No-Go.
- Spot VMs for overflow or disposable preview capacity: Go.
- Lower workspace requests after measurement: Go.
- Exclude collab debug and heartbeat logs: Go.
- Add a VPC connector to every Cloud Run service: No-Go. Only do this for services that truly need private VPC access.