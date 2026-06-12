# Handoff prompt — implement the GKE Sysbox per-workspace Docker runtime (Phase 2)

> Copy everything below the line into a **new Opus 4.8 chat** in this repo to start implementation.

---

You are implementing **Phase 2: a production-safe, per-workspace Docker runtime on GKE** for **Vectant/synthi** — a
cloud web IDE where each user gets an isolated workspace. The goal of this work: let a paying user run their **own**
containers (`docker build`/`run`/`compose`, `kind`/`k3s`, `kubectl`/`helm` to their own clusters, on-demand GPU ML) **inside
their workspace, in production**, with isolation strong enough for untrusted multi-tenant code.

## Read these first (do not skip)

1. **Spec (design of record):** `docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md`
2. **Implementation plan (phased slices):** `docs/superpowers/plans/2026-06-12-sysbox-runtime-phase2-plan.md`
3. **Phase 1 context:** `docs/superpowers/specs/2026-06-09-native-docker-execution-phase1-design.md`
4. **Project rules:** `CLAUDE.md` (plan mode, subagents, verification, `tasks/todo.md`, `tasks/lessons.md`).

Then **report your understanding back to the user and wait** before writing code. Use the brainstorming/plan skills if
anything is ambiguous. **Branch:** you are on `feat/docker-sysbox-engine` — all work lands here.

## The architecture in one paragraph

A **dedicated per-workspace "runtime pod"** (`app: runtime`, `runtimeClassName: sysbox-runc`) runs **rootless `dockerd`**
on a new `sysbox-pool` node pool — **no privileged container, no host Docker socket**. It is **separate** from the existing
compile/preview "worker pod" (`app: workspace`). Both mount the **shared `collab-data-pvc`**; the runtime pod mounts it
with **`subPath: <workspace-dir>`** so a user's docker sees only its own files. Terminals `Exec` into the runtime pod via
k8s `pods/exec`; ports surface via the existing `/wsport/<slug>/<port>/` proxy. The spawner (`workspacePodSpawner.js`)
gets a `spawnRuntimePod()` parallel to its existing `ensurePod()`. Everything is **flag-gated** (`RUNTIME_BACKEND=sysbox-pod`),
merged dark, and validated on a **scratch cluster** first.

## NON-NEGOTIABLE GUARDRAILS

**Branch & git**
- Work **only** on `feat/docker-sysbox-engine`. **Never** push to `dev`/`origin`, open a PR, or merge to `dev` **without
  explicit user approval.** **Never** force-push a shared branch.
- `dev` diverges from your local often. **Before any push:** `git fetch`, then check `git log --oneline dev..origin/dev`
  (must be empty for a clean fast-forward). If it's non-empty, **reconcile by merging** `origin/dev` in (never force) and
  resolve conflicts. Many "conflicts" here are **CRLF whole-file churn** — confirm with a whitespace-ignoring diff
  (`diff -w --strip-trailing-cr`) and resolve disjoint changes with `git merge-file` on LF-normalized stages.

**Security invariants (a breakout of any one fails the whole design)**
- **Never** expose the host `/var/run/docker.sock` to a user pod. **Never** run a user pod `privileged`. Sysbox provides
  the isolation (root-inside-userns → unprivileged on host).
- **Per-workspace `dockerd`** — never a shared daemon. `docker ps` in workspace B must never see A's containers.
- **`subPath`-mount** the shared `collab-data-pvc` so a runtime pod sees only its workspace dir. Add a security test that
  workspace B cannot read A's tree.

**Supply chain (the prod pipeline enforces this — it will fail your build otherwise)**
- **Digest-pin every image.** `cloudbuild.yaml`'s `reject-mutable-images` step bans `:latest`. Re-host third-party
  images (Sysbox installer, CRI-O) in **Artifact Registry** by digest.
- Images must **pass the CRITICAL-vuln scan gate.** `dind`-derived bases carry CVEs — budget time to slim/patch.
- New manifests go in `k8s/` and must be wired into `k8s/kustomization.yaml` (`deploy-prod.sh` does `kubectl apply -k k8s/`).

**Rollout**
- **Flag-gate** with `RUNTIME_BACKEND=sysbox-pod` (default off). Merge dark. Validate on a **scratch GKE cluster**.
  **Never** flip the flag on `dev`/prod until the spikes below pass.
- Keep the **local-dev `ENABLE_CONTAINER_RUNTIME` host-socket path working** (zero regression) at every step.

## FIVE validation spikes — these areas are UNVALIDATED

The grounding research workflow was **session-limit throttled** (only Sysbox-on-GKE and image-cache landed). Do **not**
build on these until you've proven them:
1. **Sysbox + nested GPU** — single-GPU `docker run --gpus` inside a Sysbox pod is reported *experimental/single-GPU/CRI-O
   pull issues*. PoC it; if it fails, use **pod-level GPU** (give the runtime pod the GPU, run CUDA non-nested). Gate any
   GPU promise on this.
2. **Hibernate resume latency** — measure real cold-resume (schedule + pull + rootless dockerd); set an honest SLO.
3. **Egress abuse controls** — choose detector + bandwidth-cap + dedicated egress IPs + auto-suspend; tune false positives.
4. **Cost model** — validate real europe-west10 pricing against the per-tier numbers.
5. **Node-auto-upgrade re-convergence** — auto-upgrade **wipes** the Sysbox node install; rehearse an upgrade and confirm
   the DaemonSet re-installs before relying on it. Disable/window auto-upgrade on `sysbox-pool` + keep a warm node floor + PDBs.

## COST DISCIPLINE (this is the make-or-break of the whole feature)

- **Hibernate-on-idle is the lever:** ~**$5–12/user/mo** (idle = storage only) vs ~**$36–100** always-warm. Tiered idle
  timeout by plan. Idle workspaces must scale pods to 0.
- **GPU strictly on-demand, time-boxed, metered, NEVER warm.** A user must be unable to leave a GPU running 24/7.
- **Sysbox warm node floor** (Ubuntu, ≥4 vCPU, can't fully scale to zero) is a real baseline — size it tightly.
- **Shared `collab-data-pvc`**, not per-workspace disks. **Pull-through image cache** so N workspaces pulling `node:20`
  cost one cached copy.

## OPERATIONAL LESSONS (concrete gotchas from the prior session — heed them)

- **One `docker build` at a time**, `--progress=plain`, and read the `.output` file. Two concurrent builds piped through
  `Select-Object -Last` once looked like a **5-hour hang** — they were actually fighting over the daemon.
- **Windows/MSYS:** prefix `MSYS_NO_PATHCONV=1` for `docker exec -w /app …` (else "Cwd must be an absolute path").
- **Tests:** scope `node --test` to `backend/collab-server/__tests__/*.test.js` **with `--test-timeout=20000`**. Bare
  `node --test` **hangs** (it discovers extra files that open handles). The collab-server suite is **55** `node:test` tests.
- **`WORKER_IMAGE`** must point at a real registry tag (a `synthi-worker:local` default once caused a pull-404). In prod
  it's set via the `synthi-config` ConfigMap by `deploy-prod.sh`.
- **Subagents/workflows can hit session limits.** Don't blind-retry; when a recon subagent fails, do the recon yourself
  with `Read`/`Grep`.
- **Verify before claiming "done"** (CLAUDE.md): run the tests, show the output, ask "would a staff engineer approve
  this?" Evidence before assertions.

## INHERITED CODE YOU BUILD ON (already on the branch — do not reinvent)

- `backend/collab-server/workspacePodSpawner.js` `ensurePod()` — the lifecycle pattern to **mirror** for
  `spawnRuntimePod()` (labels, annotations, ready-watch, cull, `MAX_WORKSPACE_PODS`, `SPAWNER_MODE=local` bypass). It
  already mounts `collab-data-pvc` and calls `ensureRuntimeFilesystem(... pin:true)`.
- `backend/collab-server/runtimeFilesystem.js` `ensureRuntimeFilesystem()` — hydrate+pin the workspace git repo on disk
  (this **is** the hibernate persistence mechanism; state lives in git/GCS).
- `backend/collab-server/runtimePodTerminal.js` — k8s `Exec` terminal (gated on `SYNTHI_TERMINAL_BACKEND=k8s-exec` +
  `spawner.mode=k8s`); extend to target the **runtime** pod.
- `backend/collab-server/containerPortMonitor.js` + the `/wsport/<slug>/<port>/` proxy — re-transport `runOnce` via
  `pods/exec`; point the proxy at the runtime pod.
- `k8s/spawner-rbac.yaml` — `collab-server-sa` already has `deployments` + `pods/exec` + `services`; **no RBAC change
  needed** (RuntimeClass is referenced, PVC is static). Only add `persistentvolumeclaims` verbs *if* you ever move to
  per-workspace PVCs (you shouldn't for v1).
- `k8s/network-policies.yaml` — ingress-only today (inter-workspace ingress already denied); **add** egress policy in Slice 6.
- **GKE facts:** project `vectant-proj`, cluster `synthi-beta-cluster`, region `europe-west10`, namespace `synthi`,
  Artifact Registry, kustomize `k8s/`, build/deploy via `cloudbuild.yaml` + `scripts/deploy-prod.sh`. Node-pool targeting
  is env-driven: `WORKSPACE_NODE_SELECTOR_KEY/VALUE` (default `cloud.google.com/gke-nodepool=workspace-pool`).

## LOCKED DECISIONS — do not relitigate

GKE **Standard** node pools · **Sysbox** (`sysbox-runc`) · **Approach 1** (dedicated runtime pod, separate from worker) ·
**hibernate-on-idle, tiered by plan** · GPU **on-demand/metered** · egress **open + monitored + auto-suspend** ·
paid/pro users (warm-but-few).

## OUT OF SCOPE

GUI-app streaming in "program windows" (separate spec) · hardening the worker's own `runAsUser:0` sandbox · per-workspace
PVCs · multi-GPU · deploying to Vectant's *own* prod cluster from a workspace.

## PROCESS (per CLAUDE.md)

Plan mode for non-trivial work · write the plan to `tasks/todo.md`, check in before building · update `tasks/lessons.md`
after any correction · keep changes minimal-impact · **after each slice, run a hardcoded-values audit** (prod-bound app) ·
**end every completed slice with a 1–2 sentence plain-words recap.**

## START HERE

1. Read the spec + plan + `CLAUDE.md`. Report understanding; wait for the user.
2. **Slice 0 is infrastructure** (node pool, Sysbox install) and likely needs the user's `gcloud`/cluster creds — **ask;
   don't assume access.** Offer to script it (`k8s/sysbox/`, pinned manifests) for the user to apply.
3. Proceed slice by slice (plan → TDD → verify), flag-gated, scratch-cluster-first. Do the relevant **spike** before any
   slice that depends on it (GPU, egress, hibernate SLO, cost).
