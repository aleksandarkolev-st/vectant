# Implementation plan — Phase 2 Sysbox per-workspace Docker runtime on GKE

**Spec:** `docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md`
**Branch:** `feat/docker-sysbox-engine` (all work here; never land on `dev` without explicit approval)
**Strategy:** each slice is independently verifiable, **flag-gated** (`RUNTIME_BACKEND=sysbox-pod`), merged dark, and
validated on a **scratch GKE cluster** before anything is flipped on. Local-dev `ENABLE_CONTAINER_RUNTIME` path stays
untouched (zero regression) throughout.

**Sequencing rule:** Slices 0→5 are the core path and run in order. The five **spikes** from spec §10 are acceptance
gates, not afterthoughts — a slice that depends on a spike does **not** ship until that spike passes. Slices 6–8 layer on.

---

## Slice 0 — Sysbox cluster substrate *(infra only, no app code)*

**Goal:** a GKE node pool that can run `runtimeClassName: sysbox-runc` pods, with the install surviving node churn.

**Tasks**
1. Create node pool `sysbox-pool`: image type `ubuntu_containerd`, `--no-enable-secure-boot`, machine ≥4 vCPU,
   label `sysbox-install=yes`, taint `workload=sysbox:NoSchedule`. Disable/tightly-window node auto-upgrade.
2. Re-host the Sysbox installer + CRI-O images in Artifact Registry, **digest-pinned**; pin the Nestybox manifests to a
   fixed release. Add them under `k8s/sysbox/` + wire into `kustomization.yaml`.
3. Apply the three manifests (RBAC, `sysbox-deploy-k8s` DaemonSet, `sysbox-runtimeclass`).

**Tests / acceptance**
- A hand-authored pod (`runtimeClassName: sysbox-runc`, no `privileged`) on `sysbox-pool` runs `docker run hello-world`
  rootless. Confirm `docker info` shows rootless and the host has **no** privileged container and **no** socket exposure.
- **Spike 5 (node-upgrade rehearsal):** trigger a node upgrade/recreate; confirm the DaemonSet re-installs and a
  sysbox-runc pod recovers within the maintenance window. Codify PDB + warm-floor + maintenance-window policy.

**Gate:** must pass the vuln scan (`reject-mutable-images` + CRITICAL gate) for all re-hosted images.

---

## Slice 1 — Hardened runtime image

**Goal:** the per-workspace runtime image that runs rootless `dockerd` under Sysbox with the user toolchain.

**Tasks**
1. Evolve `backend/runtime-image/` (`vectant-runtime`) for the Sysbox model: normal rootless `dockerd` entrypoint
   (Sysbox supplies the userns — **drop the `--privileged`-style dind hacks**), toolchain: docker CLI + compose, `kind`,
   `kubectl`, `helm`, git (+ identity), `claude` CLI, sudo, `HOME`/PS1 parity (carry over Phase-2a env parity).
2. Build via Kaniko in `cloudbuild.yaml`; **digest-pin**; slim/patch to pass the **CRITICAL-vuln gate** (dind bases carry
   CVEs — budget real time here).

**Tests / acceptance**
- Image builds in the prod pipeline and passes the vuln scan.
- A pod from this image under `sysbox-runc` starts `dockerd` and runs `docker run hello-world`, `docker compose up`,
  `kind create cluster`, and `kubectl version` (against a dummy kubeconfig).

---

## Slice 2 — `spawnRuntimePod()` in the spawner

**Goal:** collab-server creates/tears-down a per-workspace runtime pod, parallel to the existing worker pod.

**Tasks**
1. Add `spawnRuntimePod(sessionId, userId, metadata)` to `workspacePodSpawner.js`, mirroring `ensurePod()`'s lifecycle
   (labels `app: runtime` + `synthi/runtime-id`, annotations, ready-watch, cull, `MAX_WORKSPACE_PODS`-style guard,
   teardown). Pod spec: `runtimeClassName: sysbox-runc`, `hostUsers: false`, nodeSelector `sysbox-pool` + toleration,
   **`collab-data-pvc` mounted with `subPath: <workspace-dir>` at `/workspace`**, runtime image, env (`DOCKER_HOST`
   in-pod socket, workspace slug/scope, FS user). Call `ensureRuntimeFilesystem(... pin:true)` before create.
2. Add a **dockerd-ready** check to the ready-watch (not just pod Running).
3. Flag-gate on `RUNTIME_BACKEND=sysbox-pod` (default off → no behavior change).

**Tests / acceptance**
- Unit: runtime-pod spec shape (runtimeClassName, subPath mount path = workspace dir, no `privileged`, toleration/
  nodeSelector), cull/max-guard pure logic, teardown releases the FS pin.
- Integration (scratch cluster): opening a workspace creates a runtime pod; `kubectl exec` into it runs docker; tearing
  the workspace down deletes the pod.
- **Security test:** runtime pod for workspace B cannot read workspace A's files (subPath confinement); `docker ps` in B
  doesn't list A's containers; no host `/var/run/docker.sock` reachable.

---

## Slice 3 — Terminal routing into the runtime pod

**Goal:** `docker` works in the workspace terminal in prod.

**Tasks**
1. Extend `runtimePodTerminal.js` / `terminalService.js` so that when `RUNTIME_BACKEND=sysbox-pod` (+ `k8s-exec` +
   `spawner.mode=k8s`), terminals `Exec` into the **runtime pod** (by `synthi/runtime-id`), not the worker. Preserve the
   3-way fallback for local dev.
2. Keep the editor-doc flush (yjs → disk) on terminal create.

**Tests / acceptance**
- Unit: routing predicate selects the runtime pod under the flag; falls back correctly when off.
- Integration: a terminal in a real workspace runs `docker build`/`run`/`compose` against the workspace's own daemon.
- Regression: local-dev terminal path (host shell / `ENABLE_CONTAINER_RUNTIME`) unchanged; collab-server suite stays
  green (`node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js`).

---

## Slice 4 — Port routing

**Goal:** ports a user opens inside the runtime pod surface in the Ports panel and open via `/wsport`.

**Tasks**
1. Make `containerPortMonitor.runOnce` execute via **k8s `pods/exec`** into the runtime pod (reuse `/proc/net/tcp[6]`
   parse + baseline-subtraction).
2. Point the `/wsport/<slug>/<port>/` proxy at the runtime pod's IP/Service.

**Tests / acceptance**
- Unit: port parse + baseline logic unchanged under the new transport.
- Integration: `python -m http.server 8000` in the runtime pod appears in the Ports panel and renders via `/wsport`
  (COEP/CORP intact).

---

## Slice 5 — Lifecycle & hibernate

**Goal:** idle workspaces cost ≈ storage only; resume restores files + working docker.

**Tasks**
1. Idle-cull the runtime pod on `synthi/lastActive` (tiered timeout by plan); persist via `collab-data-pvc` + git/GCS;
   recreate + re-hydrate on resume.
2. Surface honest `starting`/`resuming` states in the UI.

**Tests / acceptance**
- Integration: idle workspace scales both pods to 0; reopening restores the file tree and a working `dockerd`;
  in-PVC image/build cache survives.
- **Spike 2 (resume latency):** measure cold-resume; set an SLO; decide warm-pool/pre-pull if too slow.

---

## Slice 6 — Egress controls + abuse monitoring  *(depends on Spike 3)*

**Tasks:** egress `NetworkPolicy` for `app: runtime` (DNS + registries + general internet), per-pod bandwidth cap,
abuse detector (Cilium/Falco/flow-logs), dedicated egress IPs, **auto-hibernate on abuse**.
**Acceptance:** legit pulls/installs + user-app API calls work; a simulated miner/port-scan is detected and the workspace
auto-suspended; false-positive rate acceptable on a normal-usage soak.

---

## Slice 7 — Image pull-through cache  *(image-cache partially validated)*

**Tasks:** stand up an AR **remote repository** (or `registry:2` mirror); configure each workspace `dockerd` to use it;
persist build cache on the PVC subPath.
**Acceptance:** a second workspace pulling the same base image hits the cache (measure pull-time + egress delta).

---

## Slice 8 — GPU on-demand  *(GATED on Spike 1)*

**Tasks:** **Spike 1 first** — single-GPU `docker run --gpus` nested inside a Sysbox pod on a GKE GPU node; if it fails,
implement **pod-level GPU** (give the runtime pod the `nvidia.com/gpu` + nvidia runtime, run CUDA at pod level). Then:
on-demand GPU runtime pod, time-boxed, metered, **never warm**, released on idle.
**Acceptance:** a CUDA container runs; GPU is released on idle/timeout; a billing/metering hook fires; a user cannot leave
a GPU running 24/7.

---

## Cross-cutting guardrails (apply to every slice)

- **Verify before "done":** run the relevant tests and show output; never claim green without evidence.
- **Digest-pin every image**, pass the CRITICAL-vuln gate; new manifests → `k8s/` + `kustomization.yaml`.
- **One `docker build` at a time**, `--progress=plain`, read the `.output` file (see lessons — concurrent builds looked
  like 5-hour hangs).
- **Never** push to `dev`/`origin` or flip a prod flag without explicit user approval; **never** force-push a shared
  branch.
- Keep the local-dev path working at every step.
