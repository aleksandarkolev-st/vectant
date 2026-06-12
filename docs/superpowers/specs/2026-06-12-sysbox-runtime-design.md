# Production Sysbox per-workspace Docker runtime on GKE — Phase 2 design

**Date:** 2026-06-12
**Status:** Design proposed — pending user review, then implementation plan
**Branch:** `feat/docker-sysbox-engine` (off `dev` @ `3fc52afc`; do NOT land on `dev` without explicit approval)
**Realizes:** the "Phase 2: prod execution (k8s pod per workspace + Sysbox), HPA/quota, registry cache" follow-on named in
`docs/superpowers/specs/2026-06-09-native-docker-execution-phase1-design.md`.
**Supersedes the dev-only path:** the `ENABLE_CONTAINER_RUNTIME=1` rootless-DinD-on-host-Docker-socket runtime
(`workspaceRuntimeContainer.js`) is the **local-dev** mechanism. Production uses a Sysbox pod, no host socket.

> ⚠️ **Grounding caveat.** Five technical areas in this spec (nested GPU, hibernate resume latency, egress abuse
> controls, full cost model, and parts of the image-cache strategy) could NOT be web-validated this session — the
> research workflow was throttled (8/10 agents hit a session limit). Only **Sysbox-on-GKE** and **image-cache (partial)**
> were validated. Every un-validated claim is tagged **[VALIDATE]** and is restated as an explicit spike in §10. Do not
> treat [VALIDATE] items as settled.

---

## 1. Goal

Let a paying user run their own containers — `docker build` / `docker run` / `docker compose up`, `kind`/`k3s`,
`kubectl`/`helm` to their own clusters, and (on demand) GPU ML containers — **inside their workspace, in production on
GKE**, with isolation strong enough for untrusted multi-tenant code: **no host Docker socket, no privileged container,
no cross-workspace access**, and a cost structure that survives a paid plan.

The engine is **Sysbox** (`runtimeClassName: sysbox-runc`) running **rootless `dockerd` inside a per-workspace pod**.

## 2. Grounded reconciliation — what already exists on the branch

The cloud-deploy line (now merged into `dev`/this branch) already built most of the production substrate. The design
**builds on** it; it does not replace it.

| Existing component | What it does today | How Phase 2 uses it |
|---|---|---|
| `workspacePodSpawner.js` `ensurePod()` | Creates one **per-session worker Deployment** (`app: workspace`, name `rt-<hmac>`) via the k8s API, on node pool `workspace-pool`, mounting the shared **`collab-data-pvc`** at `WORKSPACE_DATA_MOUNT`; idle tracked via `synthi/lastActive` annotation; `MAX_WORKSPACE_PODS` guard; `SPAWNER_MODE=local` bypass. | Add a **parallel `spawnRuntimePod()`** that creates the Sysbox runtime Deployment. Reuse the exact lifecycle shape (labels, annotations, ready-watch, cull, max-guard). |
| `collab-data-pvc` (shared, RWX) | One cluster-wide data volume mounted into all workspace pods; per-workspace repo dir hydrated onto it. | Runtime pod mounts the **same PVC at `subPath: <workspace-dir>`** → editor and `docker build .` see one tree; **subPath confines each pod to its own dir** (tenant isolation on shared storage). |
| `runtimeFilesystem.js` `ensureRuntimeFilesystem()` | Hydrates the workspace git repo onto disk (lock + cache-pin keyed by `runtimeScope`); `release…` on teardown. | Runtime pod spawn calls the **same hydrate+pin** before creating the pod (the spawner already does this for the worker). This is also the **hibernate persistence mechanism** — state lives in git/GCS, re-hydrated on resume. |
| `runtimePodTerminal.js` (`SYNTHI_TERMINAL_BACKEND=k8s-exec`) | k8s `Exec` (`bash --login -i`) into the worker pod, gated on `k8s-exec` + `spawner.mode=k8s`. | Re-point the exec at the **runtime pod** (where `dockerd` lives). The three-way terminal routing collapses to this in prod. |
| `containerPortMonitor.js` / `/wsport/<slug>/<port>/` (Phase 2b) | Detects in-container LISTEN ports via `/proc/net/tcp`; additive workspace-scoped reverse proxy. | `runOnce` runs via **k8s `pods/exec`** into the runtime pod instead of `docker exec`; `/wsport` proxies to the runtime pod's IP/Service. |
| `spawner-rbac.yaml` (`collab-server-sa` → Role `workspace-spawner`) | `deployments` (CRUD+watch), `pods` (get/list/watch), **`pods/exec`** (create), `services` (CRUD). Bound to GCP SA `synthi-gcs-sa@vectant-proj`. | **No RBAC change needed**: the runtime Deployment merely *references* the cluster-scoped `RuntimeClass` (allowed via `deployments:create`); the PVC is static (referenced, not created). |
| `network-policies.yaml` | `default-deny-ingress` + per-app allow; `app: workspace` accepts ingress only from `collab-server:8080`. **No egress policy.** | Inter-workspace ingress is already denied. **Add** egress policy + bandwidth caps + abuse monitoring for `app: runtime` (and `app: workspace`) — purely additive. |
| `cloudbuild.yaml` / `deploy-prod.sh` | Kaniko build, **`reject-mutable-images`** (no `:latest`, digest-pinned), **CRITICAL-vuln scan gate**, `kubectl apply -k k8s/` to GKE `synthi-beta-cluster` (project `vectant-proj`, region `europe-west10`). | Runtime image + Sysbox-installer images must be **re-hosted in Artifact Registry, digest-pinned, and pass the vuln gate**. New manifests go in `k8s/` + `kustomization.yaml`. |

**Corrected assumptions (important):**
- The worker pod is **not** `drop ALL` — it runs `runAsUser: 0` + `allowPrivilegeEscalation: true` (Xvfb/GStreamer). The
  worker's hardening is a *separate concern*; Sysbox hardens the **user-docker layer**, which is what this spec covers.
- There is **no GPU** in the system today (software encode). GPU is net-new infra.
- Persistence is a **shared RWX PVC + git/GCS**, not per-workspace disks.

## 3. Architecture — Approach 1 (dedicated Sysbox runtime pod)

```
                 collab-server (Deployment, k8s API client, spawner)
                        │ spawnRuntimePod()        │ ensurePod() [existing]
                        ▼                          ▼
   ┌─────────────────────────────────┐   ┌──────────────────────────────┐
   │  RUNTIME pod   app: runtime      │   │  WORKER pod   app: workspace │
   │  runtimeClassName: sysbox-runc   │   │  (compile/preview/GUI)       │
   │  node pool: sysbox-pool          │   │  node pool: workspace-pool   │
   │  rootless dockerd (NO privileged)│   │  runAsUser 0 (Xvfb)          │
   │  docker/compose/kind/kubectl     │   │                              │
   │  mounts collab-data-pvc          │   │  mounts collab-data-pvc      │
   │     subPath: <workspace-dir>     │   │     (workspace dir)          │
   └───────────────┬─────────────────┘   └──────────────────────────────┘
                   │ both mount the SAME shared RWX PVC (no co-scheduling needed)
                   ▼
        /wsport/<slug>/<port>/  ← collab-server proxy → runtime pod IP/Service
        terminal ← k8s Exec (pods/exec) into runtime pod
```

- **One runtime pod per workspace** (keyed by runtime scope), separate from the worker pod, each on its own node pool,
  both reaching the shared `collab-data-pvc`. **No co-scheduling** (the earlier RWO constraint is gone — RWX shared
  volume).
- **Two untrusted workloads stay in separate sandboxes**: your compiled-plugin RCE worker and the user's arbitrary
  Docker never share a pod, namespaces, or (by default) a node pool.
- Rejected alternatives (recorded): **(2) one consolidated Sysbox pod** hosting worker+dockerd — conflates the two
  untrusted workloads, loosens the boundary, contradicts Phase-1's don't-couple decision; **(3) pod-as-docker-host**
  (worker as nested container) — biggest re-architecture, muddiest boundary, least payoff.

## 4. Sysbox node pool & install  *(validated — high confidence)*

- **Dedicated node pool** `sysbox-pool`: image type **`ubuntu_containerd`** (COS is unsupported — read-only rootfs, no
  shiftfs), **Secure Boot disabled** (`--no-enable-secure-boot`, else the installer can't load shiftfs), machine
  **≥4 vCPU**, **label** `sysbox-install=yes` + **taint** `workload=sysbox:NoSchedule` (runtime pods tolerate it; nothing
  else lands there).
- **Install** the three Nestybox manifests (RBAC, `sysbox-deploy-k8s` DaemonSet, `sysbox-runtimeclass`) → creates
  `RuntimeClass sysbox-runc`. The DaemonSet is a privileged/hostPath/hostPID installer — permitted on GKE **Standard**
  (you own the node OS); it drops `sysbox-runc` + CRI-O onto the node and reconfigures kubelet (~1–2 min/node).
- **Supply chain:** pin the manifests to a fixed Sysbox release and **re-host the installer + CRI-O images in Artifact
  Registry by digest** to satisfy `reject-mutable-images` + the CRITICAL-vuln gate.
- **Runtime pods** set `runtimeClassName: sysbox-runc` (+ `hostUsers: false` on k8s ≥1.30) and run a normal rootless
  `dockerd` — Sysbox provides the user-namespace isolation, so **no `privileged`, no host socket**.
- **Operational risk #1 — node auto-upgrade/repair wipes the install** (nodes recreate from the base Ubuntu image). The
  DaemonSet re-converges automatically, but there's a ~1–2 min window where `sysbox-runc` is absent and runtime pods
  can't start. **Mitigate:** disable or tightly-window auto-upgrade on `sysbox-pool`, set a maintenance window, keep a
  **small warm node floor** (matches "warm-but-few"), add PDBs, and **rehearse an upgrade** to confirm re-convergence
  before launch.
- **Operational risk #2 — autoscaler cold-start**: each scaled-up node runs the full installer (~1–2 min) before it can
  host runtime pods. Pre-pull/mirror installer images; keep the warm floor.
- **Support posture:** Sysbox community edition (OSS); Nestybox was acquired by Docker and Sysbox-EE is wound down —
  we bet on the OSS maintenance cadence. Acceptable, but pin versions and own the install.

## 5. Lifecycle & hibernate

- **Spawn** (lazy): on first terminal / `container`-program use in a workspace, `spawnRuntimePod()` hydrates+pins the
  workspace FS and creates the runtime Deployment; collab-server waits for `dockerd` ready (mirror the worker's
  ready-watch + a dockerd health check).
- **Idle detect:** reuse the existing `synthi/lastActive` annotation + cull loop; activity = terminal I/O, program runs,
  port activity. Idle timeout is **tiered by plan** (e.g. free-ish 15 min, pro hours, premium never).
- **Hibernate = scale to 0** (delete the runtime + worker pods); **state persists** in `collab-data-pvc` + git/GCS
  (no CRIU). Idle workspace cost ≈ storage only.
- **Resume:** recreate the pod bound to the same PVC subPath; re-hydrate; `dockerd` warms. **[VALIDATE]** resume latency
  (pod schedule + image pull + rootless dockerd start) — target "a few seconds," but rootless `dockerd` + fuse-overlayfs
  can be slower; measure before promising a number.
- **Unavoidably lost on hibernate:** running containers/processes (the user restarts them; a later nicety: auto
  `compose up` on resume). Documented limitation.

## 6. Terminal & port routing

- **Terminal:** in prod the three-way routing (pod-exec → container-exec → host-shell) collapses to **k8s `Exec` into the
  runtime pod**. Extend `runtimePodTerminal.js` to target the runtime pod by its `synthi/runtime-id` label; `dockerd` is
  reachable at the in-pod rootless socket (`DOCKER_HOST` set by the runtime image entrypoint, outside the scrubbed
  per-program env). `pods/exec` RBAC already exists.
- **Editor-doc flush** (yjs rooms → disk) on terminal/program create stays, so `docker build` sees latest edits.
- **Ports:** `containerPortMonitor` runs `runOnce` via **`pods/exec`** into the runtime pod (parsing `/proc/net/tcp[6]`,
  baseline-subtracting infra ports — unchanged logic, new transport). `/wsport/<slug>/<port>/` proxies to the runtime
  pod's IP/Service (resolved from the pod, like the worker). COEP/CORP headers and the Ports panel unchanged.

## 7. Security model

- **Isolation:** Sysbox runs the pod's processes as **root inside a user namespace**, mapped to unprivileged host UIDs —
  *stronger* host isolation than the current shared-kernel pods, with **no `privileged` and no host Docker socket**. A
  container breakout lands as an unprivileged, namespaced user.
- **Tenant isolation on shared storage:** mount `collab-data-pvc` with **`subPath: <workspace-dir>`** so the runtime pod
  (and the user's docker) sees only its own files. A security test asserts workspace B cannot read workspace A's tree.
- **No cross-workspace containers:** each workspace has its own `dockerd`; `docker ps` in B never lists A's containers
  (security test).
- **Egress (net-new, additive):** add an egress `NetworkPolicy` for `app: runtime` (allow DNS, package registries, and
  general internet by default — these workloads need it), plus **per-pod bandwidth caps** and **abuse monitoring**
  (crypto-mining / port-scan heuristics) with **auto-hibernate on abuse**. **[VALIDATE]** the exact control set + a
  low-false-positive detector + dedicated egress IPs so abuse doesn't poison shared IPs.
- **Images:** the runtime image (`vectant-runtime`, rootless-docker base + toolchain) must be **digest-pinned and pass
  the CRITICAL-vuln gate** — `dind`-derived images carry CVEs; budget time to slim/patch it.
- **RBAC:** unchanged (references RuntimeClass; PVC static). If per-workspace PVCs are ever adopted, add
  `persistentvolumeclaims` verbs then — not now.
- **Worker note:** the worker's `runAsUser:0`/priv-esc is a *separate* hardening item, out of scope here.

## 8. GPU — on-demand only

- **Net-new** GPU node pool (no GPU exists today). **[VALIDATE]** Sysbox research flags **nested** GPU passthrough
  (user `docker run --gpus` inside the pod's dockerd) as **experimental / single-GPU-only / CRI-O short-name pull
  issues**. → **Design rule: attach the GPU at the *runtime-pod* level** (k8s `nvidia.com/gpu` request + nvidia runtime),
  run the CUDA workload at pod level, **not nested**, until a single-GPU nested PoC proves out.
- **Strictly on-demand, time-boxed, metered**: a GPU request re-creates the runtime pod with a GPU on the GPU pool (or a
  separate ephemeral GPU runtime), billed by the minute, never warm. A user leaving a GPU idle 24/7 must be impossible.

## 9. Image cache & cost  *(image-cache partially validated; cost [VALIDATE])*

- **Image cache:** a **pull-through registry mirror** (Artifact Registry **remote repositories**, or a `registry:2`
  mirror) so N workspaces pulling `node:20` cost one cached copy; **build cache persisted** on the workspace's
  `collab-data-pvc` subPath; BuildKit remote cache optional. Base-layer *sharing across* per-workspace rootless daemons
  is limited by fuse-overlayfs — the mirror is the main lever, not dedup.
- **Cost posture (design intent — [VALIDATE] with real GCP pricing):** hibernate-on-idle keeps non-GPU cost ≈
  **$5–12/user/mo** vs **$36–100 always-warm**; GPU is a metered add-on (~$0.35–1+/GPU-hr). The Sysbox warm node floor
  (Ubuntu, ≥4 vCPU, can't scale fully to zero on the runtime pool) is a real baseline cost — size it tightly per tier.

## 10. Risks / required spikes (the throttled-research items — do these BEFORE building on them)

1. **Sysbox + nested GPU PoC** — prove (or disprove) single-GPU `docker run --gpus` inside a Sysbox pod on GKE; if it
   fails, lock in pod-level GPU. Gate any GPU launch promise on this.
2. **Hibernate resume-latency measurement** — measure real cold-resume (schedule + pull + rootless dockerd) and set an
   honest SLO; decide if a warm-pool/pre-pull is needed.
3. **Egress abuse-control design** — choose the detector (Cilium/Falco/flow-logs), bandwidth-cap mechanism, dedicated
   egress IPs, and the auto-suspend path; tune for low false positives.
4. **Cost-model validation** — real europe-west10 pricing for the co-located node shape, shared Filestore/PVC, Cloud NAT
   egress, AR storage, and GPU/hr; confirm the per-tier numbers.
5. **Node-auto-upgrade re-convergence rehearsal** — trigger an upgrade on `sysbox-pool`, confirm the DaemonSet
   re-installs and runtime pods recover; codify the maintenance-window + PDB + warm-floor policy.

## 11. Non-goals, testing, rollout

- **Non-goals:** GUI-app streaming in program windows (separate spec); replacing the worker's sandbox; per-workspace
  PVCs; multi-GPU; shipping to Vectant's *own* prod cluster from a workspace.
- **Testing:** unit (spawnRuntimePod spec shape, subPath mount, terminal-routing gate, port-monitor via pods/exec);
  integration on a scratch GKE cluster with `sysbox-pool` (docker run/build/compose, kind, kubectl-to-external); security
  (cross-workspace fs + `docker ps` isolation, no host socket, no privileged); the five spikes above as acceptance gates.
- **Rollout / flags:** gate behind a new flag (e.g. `RUNTIME_BACKEND=sysbox-pod` alongside `SPAWNER_MODE=k8s` +
  `SYNTHI_TERMINAL_BACKEND=k8s-exec`); merge dark; flip on a scratch cluster first; never on `dev`/prod until the spikes
  pass. Local dev keeps the `ENABLE_CONTAINER_RUNTIME` host-socket path untouched (zero regression).
