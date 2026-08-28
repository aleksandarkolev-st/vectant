# Sysbox runtime substrate (Phase 2, Slice 0)

Provisions the **Sysbox** (`runtimeClassName: sysbox-runc`) substrate that lets a
per-workspace pod run a full Docker daemon with **no privileged container and no
host docker.sock** — Sysbox isolates the pod as *root-inside-a-user-namespace*,
mapped to unprivileged host UIDs.

Spec: [`docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md`](../../docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md) §4 ·
Plan: [`docs/superpowers/plans/2026-06-12-sysbox-runtime-phase2-plan.md`](../../docs/superpowers/plans/2026-06-12-sysbox-runtime-phase2-plan.md) (Slice 0)

## Why a dedicated SCRATCH cluster (not a pool on prod)

Prod `synthi-beta-cluster` is on the **REGULAR** release channel. On a channel-enrolled
cluster GKE **does not allow permanently disabling node auto-upgrade** — only deferral
via a *maintenance exclusion*. Node upgrades recreate nodes from the base Ubuntu image,
which **wipes the on-node Sysbox install**. A throwaway cluster on `--release-channel=None`
lets us pin the version and pass `--no-enable-autoupgrade`, giving full control to validate
Slice 0 and rehearse the upgrade-recovery spike with zero risk to prod.

## Files

| File | What |
|---|---|
| `sysbox-install.yaml` | Vendored + pinned Sysbox **v0.7.0** install (DaemonSet + RuntimeClass `sysbox-runc`, kube-system). 2 local mods vs upstream — see its header; audit by diffing against the pinned Source URL in that header. |
| `kustomization.yaml` | Standalone kustomization (NOT wired into `k8s/kustomization.yaml`, which would force everything into the `synthi` namespace and break the install). |
| `create-scratch-cluster.ps1` | Idempotent cluster + `sysbox-pool` provisioner. |
| `smoke-pod.yaml` | Acceptance test: dockerd in a `sysbox-runc` pod, **no privileged**. |

## Runbook

### B1–B2 · Create the cluster + sysbox-pool  *(gated — confirm before running)*
```powershell
pwsh k8s/sysbox/create-scratch-cluster.ps1
```
Creates `synthi-sysbox-scratch` (Standard, zonal `europe-west10-a`, channel `None`) and
`sysbox-pool` (`ubuntu_containerd`, e2-standard-4, Secure Boot OFF, no auto-upgrade/repair,
label `sysbox-install=yes`, taint `workload=sysbox:NoSchedule`), then points kubectl at it.

### B3 · Re-host + digest-pin the Sysbox image
The vendored manifest points at our Artifact Registry copy; push it and pin the digest:
```powershell
$SRC = "registry.nestybox.com/nestybox/sysbox-deploy-k8s:v0.7.0-0"   # fallback: nestybox/sysbox-deploy-k8s:v0.7.0-0 (Docker Hub)
$DST = "europe-west10-docker.pkg.dev/vectant-proj/synthi/sysbox-deploy-k8s:v0.7.0-0"
gcloud auth configure-docker europe-west10-docker.pkg.dev
docker pull $SRC
docker tag  $SRC $DST
docker push $DST
# capture the immutable digest and pin it into sysbox-install.yaml:
gcloud artifacts docker images describe $DST --format='value(image_summary.digest)'
# -> edit sysbox-install.yaml: image: ...sysbox-deploy-k8s:v0.7.0-0@sha256:<digest>
```
> One pull/push at a time (lessons: concurrent docker ops fight the daemon). The
> `synthi` AR repo already exists (it hosts the app images).

### B4 · Install Sysbox
```powershell
kubectl apply -k k8s/sysbox/
kubectl -n kube-system rollout status ds/sysbox-deploy-k8s --timeout=300s
kubectl get runtimeclass sysbox-runc
kubectl get nodes -l sysbox-install=yes -L sysbox-runtime   # expect sysbox-runtime=running once installed
```
The installer drops `sysbox-runc` + CRI-O on the node and reconfigures kubelet (~1–2 min),
then labels the node `sysbox-runtime=running` (which the RuntimeClass selects on).

### C1 · Acceptance smoke test
```powershell
kubectl apply -f k8s/sysbox/smoke-pod.yaml
kubectl wait --for=condition=Ready pod/sysbox-smoke-test --timeout=180s
kubectl exec sysbox-smoke-test -- docker run --rm hello-world
kubectl exec sysbox-smoke-test -- docker info --format '{{.SecurityOptions}}'   # expect name=userns
# Prove the security invariants:
kubectl get pod sysbox-smoke-test -o jsonpath='{.spec.containers[0].securityContext.privileged}'  # expect <empty>/false
kubectl exec sysbox-smoke-test -- ls /var/run/docker.sock   # the pod's OWN sock; host sock is NOT mounted
kubectl delete -f k8s/sysbox/smoke-pod.yaml
```

### C2 · Spike 5 — upgrade re-convergence rehearsal
Auto-upgrade WILL wipe the install on prod; prove the DaemonSet self-heals. Fast method
(recreate the node), then confirm recovery:
```powershell
# delete the GCE instance backing the sysbox node; the MIG recreates a fresh Ubuntu node
$NODE = kubectl get nodes -l sysbox-install=yes -o jsonpath='{.items[0].metadata.name}'
gcloud compute instances delete $NODE --zone europe-west10-a --project vectant-proj
# watch: new node joins -> DaemonSet re-runs -> sysbox-runtime=running returns -> smoke pod schedules again
kubectl get nodes -l sysbox-install=yes -L sysbox-runtime -w
```
True-to-risk variant: `gcloud container clusters upgrade synthi-sysbox-scratch --node-pool sysbox-pool --zone europe-west10-a`.
**Record the recovery window** (node-ready → `sysbox-runtime=running`) here after the run.

## Operational policy (codified — Slice 0 deliverable)

- **Warm node floor:** keep ≥1 `sysbox-pool` node always (no scale-to-zero on the pool
  itself), so a Sysbox-ready node always exists; size per tier later.
- **Upgrades:**
  - *Scratch (channel None):* auto-upgrade/repair OFF — version is pinned.
  - *Prod (channel REGULAR):* can't disable — set a **maintenance exclusion** ("No minor or
    node upgrades") on `sysbox-pool` + a narrow **maintenance window**, and rely on the
    validated DaemonSet re-convergence. End-of-support forced upgrades are unavoidable.
- **PDB:** runtime pods (Slice 2+) get a PodDisruptionBudget to cap voluntary-disruption
  concurrency; the install itself relies on warm-floor + surge so a ready node remains.
- **Honest resume state:** during the ~1–2 min re-install window after a node recreate,
  runtime pods are Pending — surface a "resuming" state (ties into Slice 5).

## Teardown
```powershell
gcloud container clusters delete synthi-sysbox-scratch --zone europe-west10-a --project vectant-proj
gcloud artifacts docker images delete europe-west10-docker.pkg.dev/vectant-proj/synthi/sysbox-deploy-k8s:v0.7.0-0 --delete-tags
```
To uninstall Sysbox but keep a cluster: `kubectl apply -f https://raw.githubusercontent.com/nestybox/sysbox/v0.7.0/sysbox-k8s-manifests/sysbox-uninstall.yaml` (then remove the install DaemonSet).

## Promoting to prod (later — not Slice 0)
- The runtime-pod manifests (Slice 2+) live in the `synthi` namespace and wire into the
  **top-level** `k8s/kustomization.yaml` — NOT this standalone one.
- Add the re-hosted Sysbox image to `cloudbuild.yaml`'s `vulnerability-scan` list.
- On prod, use the maintenance-exclusion + warm-floor + re-convergence policy above.
