# HANDOFF PROMPT — "Real programs in the workspace" (Vectant/synthi)

> Paste everything below into a fresh Opus 4.8 chat. It is self-contained. Read it
> fully before doing anything. Then **re-read the current files on the current commit
> before trusting any specific claim here** — code may have moved since this was written
> (2026-06-16).

---

You are Claude (Opus 4.8) continuing work on **synthi / Vectant**, a production cloud web
IDE (Next.js frontend + Node collab-server + Rust worker + Python AI engine, deployed on
GKE). You are picking up an in-flight, multi-session effort. Act like a careful staff
engineer: plan before coding, verify with real evidence before claiming anything works,
and never take a destructive or outward-facing action without explicit approval.

Working directory: `C:\Users\HP\source\repos\synthi-ide`. OS: Windows 11 (PowerShell +
Git Bash both available). Git branch you must stay on: **`feat/docker-sysbox-engine`**.

## 0. The mission right now

Phase 2 (a production-safe, per-workspace **Docker runtime on GKE via Sysbox**) is
**code-complete and live-validated** (details below). The current task is the next phase:
**"real programs in the workspace"** — making real third-party programs (Docker first,
GUIs and others later) actually run **with their UI rendered inside the workspace**, on
top of the validated sysbox runtime. This is the product north-star: a workspace that is
effectively a remote computer, not just a showcase of web apps the user builds. (See the
`vectant-product-vision` memory.)

We are **mid-brainstorm** on the first slice of this phase. A design has been presented
and is **awaiting the user's final approval** (see §6). Do NOT jump to code. The flow is:
confirm the design with the user → write the spec → `superpowers:writing-plans` → TDD
implementation.

## 1. NON-NEGOTIABLE GUARDRAILS (security + process) — read twice

- **NEVER expose the host `/var/run/docker.sock` to a user pod. NEVER run a user pod
  privileged.** Sysbox provides the isolation (root-in-userns). A user gets their OWN
  isolated per-workspace dockerd, never a shared/host one.
- **Per-workspace dockerd, never shared.** Workspace files mount via `subPath` on
  `collab-data-pvc`.
- **Digest-pin EVERY image.** Re-host third-party images into Artifact Registry
  (`europe-west10-docker.pkg.dev/vectant-proj/synthi`). CI greps for mutable `:latest`
  (`reject-mutable-images` in `cloudbuild.yaml`) and there is a trivy CRITICAL gate.
- **Zero regression to local dev.** The `ENABLE_CONTAINER_RUNTIME` host-socket / hybrid
  path must keep working. Everything new is **flag-gated** behind `RUNTIME_BACKEND=sysbox-pod`
  (default OFF). Flag off ⇒ byte-for-byte current behavior.
- **GPU** is strictly on-demand / metered / never-warm / released on idle (not in this slice).
- **Branch discipline:** work ONLY on `feat/docker-sysbox-engine`. NEVER push to
  `dev`/`origin/main`, open a PR, merge, or force-push a shared branch WITHOUT explicit
  user approval. Committing to the feature branch is fine; the user has approved pushing
  this feature branch.
- **Cluster discipline (scratch-first):** validate Sysbox ONLY on a throwaway scratch
  cluster, NEVER on prod (`synthi-beta-cluster`, REGULAR channel — auto-upgrades wipe
  sysbox). **Before ANY `kubectl apply`, verify `kubectl config current-context` is the
  scratch cluster, not prod.** Tear scratch infra down with `--quiet --async` and confirm
  `clusters list` shows prod only (billing stopped) when done.
- For anything hard to reverse or outward-facing, confirm first.

## 2. Workflow rules (from CLAUDE.md + the active skills)

- **Plan-mode default** for any non-trivial task (3+ steps / architectural decisions).
  Write the plan to `tasks/todo.md` with checkable items; check in before implementing.
- **Strict TDD** (red→green per task) — this project uses it throughout. See the
  `superpowers:test-driven-development` skill. Commit per task.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Verification before completion** (`superpowers:verification-before-completion`): run
  the real commands and quote real output before claiming success. Never declare a
  backgrounded command done from a mid-flight probe — wait for it to finish.
- **Self-improvement:** after any user correction, add a lesson to `tasks/lessons.md`.
- **Surgical, minimal, YAGNI.** Match existing style. Don't refactor unrelated code.
- **Skills to use:** `synthi-frontend` and `synthi-backend` (codebase guides),
  `superpowers:brainstorming` (we're in it), then `superpowers:writing-plans`, then
  `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
  Invoke a skill via the Skill tool before the matching work.
- **Memory:** there is a file-based memory dir; honor `end-of-implementation-summary`
  (give a 1-2 sentence plain recap when an implementation finishes) and
  `hardcoded-values-audit` (audit new values after each slice — they must be env-driven
  or universal standards, never env-specific/secret).
- **Subagents:** fine for parallel research, BUT they share the account session limit and
  can fail mid-run; if recon subagents fail, do the recon yourself (it also keeps findings
  in the main context). Only spawn agents when it clearly helps; the user has not asked
  for multi-agent orchestration.

## 3. Environment gotchas that WILL bite you (hard-won)

- **gcloud auth expires constantly.** Non-interactive token refresh fails with
  *"Reauthentication failed. cannot prompt during non-interactive execution"* (org reauth
  policy). You CANNOT fix it from a tool — the USER must run `gcloud auth login` in their
  terminal. Verify it worked with `gcloud auth print-access-token` (must print a token)
  BEFORE relying on any gcloud/kubectl call. Active account: `aleksandar.georgiev@vectant.dev`,
  project `vectant-proj`.
- **`node --test` MUST be scoped** or it hangs forever:
  `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` (run from
  repo root). Frontend tests: `cd synthi && npx vitest run [filenamePattern]`.
- **Docker Desktop** (on D:) is GUI-only — it cannot be launched headlessly, and it
  crashes under disk pressure. Don't depend on it for unattended work. (This slice is
  prod-sysbox only, so you should not need it.)
- **`gcloud ... | tail` masks exit codes/errors** (a stocked-out op printed "still
  running" with pipe exit 0). Check operations explicitly:
  `gcloud container operations list --filter="targetLink~<cluster>"` → `statusMessage`.
- **`Edit`/`Write` require a prior `Read` of the file in the current session** (even for
  files that exist) — read before writing.
- Windows paths: `kubectl`/`gcloud`/`node` accept forward slashes in args; Git Bash
  `[ -f "C:\..." ]` mis-evaluates backslash paths (use `Read`/`Test-Path` to check files).

## 4. Current state — what is DONE (do not redo)

All on `feat/docker-sysbox-engine`, **pushed to origin** (HEAD was `0cbfb297` at handoff):

- **Phase 2 sysbox (9 slices)**: code-complete, dark, unit-tested. #1006 was defeated by
  `hostUsers: false` (lesson #29). Rootful `docker:dind` under sysbox (NOT rootless — lesson #31).
- **Deferred bits done this session (A1–A5), committed + pushed:**
  - A1 `1013f2c5` — trivy CRITICAL gate in `cloudbuild.yaml` (`vulnerability-scan-runtime`, gates deploy).
  - A2 `a0775cbe` — per-pod egress bandwidth cap (`RUNTIME_EGRESS_BANDWIDTH` → `kubernetes.io/egress-bandwidth`).
  - A3 `ac717828` — `purgeRuntimeData()` docker-data cleanup primitive (permanent-delete; wiring to a Next.js DELETE route is a noted follow-up).
  - A4 `161ca93a` — `runtimeLifecycleSnapshot()` (dark `runtime` field on the session lifecycle endpoint).
  - A5 `42409139` — frontend: `runtime-ports` → `portsSlice.setRuntimePorts` → PortsPanel `/runtime/<scope>/port/N`; `getProgramSessionAppUrl(runtimeScope)`.
  - `631a0b19` — **Slice 6 egress DNS fix** (see lesson #34): the kube-dns podSelector rule broke DNS under GKE NodeLocal DNSCache; changed to allow UDP/TCP :53 to all.
  - `88fef6ba`, `0cbfb297` — Dataplane-V2 scratch script + validation docs/lessons.
  - SKIPPED (premature, no plan-tier system): Slice-5 "tiered idle timeout by plan."
- **Live-validated this session on a throwaway Dataplane-V2 GKE cluster** (then torn down):
  Slice 1+A1 (CI image build + trivy gate pass), substrate, **S2** (real `buildRuntimeDeployment`
  Ready: sysbox-runc, hostUsers:false, non-priv, egress-bandwidth=50M, /workspace + /var/lib/docker
  subPaths), **S3** (`docker run hello-world` in-pod, root-in-userns, kind/kubectl/helm run),
  **S4** (real `parseListeningPorts` on real `/proc/net/tcp` → reachable HTTP 200), **S5**
  (scale 0→1: workspace files + docker image survived; **20s** resume), **S6** (egress matrix:
  metadata+internal BLOCKED, public ALLOWED — incl. the DNS bug fix), **Slice 7** (pulled
  busybox through an AR remote-repo pull-through cache; caveat: `--registry-mirror` needs
  daemon-level AR creds in prod).
- **Slice 8 (GPU):** pod-spec hook validated; the live CUDA spike was **deferred** —
  GPU capacity unavailable (europe-west10 has no GPU hardware; europe-west1-b T4 stocked out),
  and nested `docker run --gpus` will need nvidia-container-toolkit baked into the runtime
  image regardless. See lesson #33 + `tasks/todo.md` "Slice-8 forward list".
- **Suites green:** backend `node --test` 79 pass + 5 skip / 0 fail; frontend ports vitest 13 pass.
- **All scratch infra deleted; prod untouched.**

Validation helpers (regenerate if missing) live in `%TEMP%`: `gen-runtime.js` (emits the
real `buildRuntimeDeployment` + Service as a k8s List; supports `GEN_GPU`/`GEN_GPU_POOL`),
`scratch-ns-pvc.yaml`. Re-spin script: `k8s/sysbox/create-scratch-cluster.ps1` (now passes
`--enable-dataplane-v2`, required to ENFORCE the egress NetworkPolicy). AR images that
persist for fast re-spin: `vectant-runtime:scratch`, `sysbox-deploy-k8s:v0.7.0-0`.

## 5. Programs surface — survey findings (the codebase map)

How a program runs TODAY:
```
ProgramsPanel.jsx → programsClient.js → /api/workspace/[slug]/programs* → runtimeClient.js
  → collab-server: programRuntimeManager.launchManagedProgram
      → composeProgramCommand ("cd && install && launch")
      → launchManagedSession → injected launchRuntime  ➜  a headless PTY
         (env scrubbed via buildManagedRuntimeEnv: DOCKER_HOST is BLOCKED)
```
- Session UI: `synthi/src/components/programs/ProgramSessionPanel.jsx` — tabs App / Logs /
  Terminal / Ports / Health / Settings. **App tab**: web `<iframe>` for web/container types
  (URL via `getProgramSessionAppUrl`), a **stub** "GUI stream surface" for `gui`,
  waiting/no-port otherwise. Polls `fetchProgramSession` every 5s.
- Runtime types (`synthi/src/lib/programs/manifest.js`): `['web','cli','tui','background','gui','container']`
  — **`container` is already a valid type**, and `deriveSurfaces` gives it an App surface.
- `synthi/src/lib/programs/devcontainer.js` already parses a documented devcontainer.json
  subset (rejects host bind mounts / docker.sock / privileged → `host_escape`). Reuse it
  for the repo-detect entry point.
- Backend authority: `backend/collab-server/programRuntimeManager.js` — runs managed
  headless PTY sessions; has **zero** sysbox/`RUNTIME_BACKEND` awareness and **scrubs
  `DOCKER_HOST`** (so a `container` program currently canNOT run docker). Injected
  `launchRuntime` is wired in `backend/collab-server/server.js` (also where the Slice-4
  runtime port monitor + `runtimeRunOnce` live).
- Sysbox runtime (validated, dark, SEPARATE): `backend/collab-server/runtimePodSpec.js`
  (`buildRuntimeDeployment`, `buildRuntimeService`, `isSysboxRuntimeEnabled`),
  `workspacePodSpawner.js` (`spawnRuntimePod`, cull, `runtimeLifecycleSnapshot`),
  `runtimePodTerminal.js` (`runtimeRunOnce`, the k8s-exec path; Slice-3 `createRuntimePodPty`
  routes terminals into the runtime pod when the flag is on). Ports detected in the pod →
  `runtime-ports` event → frontend `portsSlice` (A5).

**THE GAP (= this phase):** the programs surface and the validated sysbox runtime are not
connected. `container` programs execute via the DOCKER_HOST-scrubbed managed PTY, so real
docker is blocked. The work is to route container programs into the per-workspace sysbox
runtime (real dockerd) and surface their web UI.

## 6. Brainstorm decisions LOCKED + the design awaiting approval

User decisions so far (do not relitigate):
1. **First experience:** real Docker program with its **web UI** rendered in the workspace.
2. **Entry points:** **BOTH** a marketplace/manifest `container` recipe AND repo
   auto-detection (`docker-compose.yml` / `devcontainer.json` / `Dockerfile`).
3. **Approach A, PROD-SYSBOX ONLY:** route container programs into the per-workspace
   sysbox runtime pod. (Dev-hybrid path + its known compose bind-mount fix are OUT of this
   slice. First-class per-container "docker dashboard" objects = Approach B, deferred.)

The DESIGN presented to the user (awaiting their explicit approval — confirm before spec):

- **Execution seam** (`programRuntimeManager.js` + the `launchRuntime` injection in
  `server.js`): when `RUNTIME_BACKEND=sysbox-pod` AND the program is `container`-type (or a
  repo-detected docker project), exec the composed command (`cd /workspace && docker compose up …`)
  **inside the runtime pod's `runtime` container**, reusing the Slice-3 exec path; stream
  output back as the session's logs. Leave `DOCKER_HOST` intact **only on this path** (the
  command runs inside the runtime container, whose dockerd socket is its own). The
  managed-PTY path keeps scrubbing it — no change.
- **Port → web UI surfacing (the meatiest piece):** a container's published port opens
  inside the sysbox pod (collab-server's localhost scanner can't see it), but the Slice-4
  runtime port monitor does. For sysbox-routed container sessions, feed those
  runtime-detected ports through the existing `attributeSessionPorts` into the session's
  `activePorts`, and stamp the session with its `runtimeScope`. `ProgramSessionPanel` then
  builds the App-tab iframe + Ports links as `/runtime/<scope>/port/N` (the A5
  `getProgramSessionAppUrl(runtimeScope)` path — just pass the scope through).
- **Entry points (one execution core, two thin adapters):** recipe = existing install/launch
  flow with `runtimeType: container`; repo-detect = scan for compose/devcontainer/Dockerfile
  → map to a container config (reuse `devcontainer.js` + a thin compose detector) → same
  execution. Optionally seed one `@vectant/*` container example.
- **Security:** container runs in the validated sysbox pod (non-priv, hostUsers:false,
  egress-hardened, host docker.sock unreachable). User manifests still can't request host
  escape (existing `host_escape` rejections stay) — the platform PROVIDES an isolated
  per-workspace dockerd. Flag-gated, dark by default.
- **Testing:** unit (node/vitest) for the routing decision, per-path DOCKER_HOST handling,
  runtime-ports→activePorts wiring, repo-detect mapping; live on a scratch cluster (launch
  a real `docker compose` program → web UI in the App tab; terminal execs into the runtime;
  logs stream).
- **Non-goals (slice 1):** GUI streaming (separate spec — see sysbox design §11),
  Approach-B container dashboard, dev-hybrid path, multi-service orchestration UI,
  image-build cache tuning beyond Slice 5/7.

The open question put to the user was whether the **port→App-tab integration** is right and
whether anything should be added/cut before writing the spec.

## 7. Your immediate next steps (in order)

1. Read this whole file, then **re-read the key files in §5 on the current commit** (lesson
   #24: never trust a prior analysis without re-reading current code).
2. Resume `superpowers:brainstorming` at the approval gate: confirm the §6 design with the
   user (or accept their approval if they paste it). Adjust if they request changes.
3. Write the spec to `docs/superpowers/specs/2026-06-16-real-programs-in-workspace-design.md`,
   self-review (placeholders/consistency/scope/ambiguity), commit, and ask the user to review it.
4. After spec approval, invoke `superpowers:writing-plans` → write the implementation plan
   to `tasks/todo.md` → get sign-off → implement via strict TDD, committing per task.
5. Validate live only on a fresh scratch cluster (verify context first!), then tear it down.

## 8. Reference docs to read (don't reinvent)

- `tasks/todo.md` — the running log; the most recent section is this session's sysbox
  validation results + the Slice-8 forward list.
- `tasks/lessons.md` — 35 lessons. Most relevant here: **#21** (scoped node --test), **#24**
  (re-read current files), **#25** (subagent session limits), **#29** (#1006 = hostUsers),
  **#31** (rootful dind under sysbox), **#33** (GPU quota≠hardware≠capacity), **#34**
  (NodeLocal DNSCache egress break), **#35** (Dataplane-V2 backend-identity egress).
- `docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md` — the Phase-2 runtime design
  (§5 lazy spawn on first terminal/container-program use; §6 terminal & port routing; §11
  declares GUI-app streaming a SEPARATE spec).
- `docs/superpowers/specs/2026-06-09-native-docker-execution-phase1-design.md` and
  `docs/superpowers/specs/2026-06-11-terminal-container-runtime-design.md` — prior
  (dev-hybrid) thinking on container execution; useful background, but this slice is
  prod-sysbox only.
- The memory dir (`...\memory\MEMORY.md` index): `vectant-product-vision` (north-star),
  `sysbox-070-cri-blocker` (RESOLVED), `hardcoded-values-audit`, `end-of-implementation-summary`.

## 9. Definition of done for the first slice

A user with `RUNTIME_BACKEND=sysbox-pod` enabled can launch a real `container` program
(via recipe AND via repo detection); it runs `docker`/`compose` in their isolated
per-workspace sysbox dockerd; its published web port renders in the program's App tab via
`/runtime/<scope>/port/N`; the Terminal tab execs into the runtime; logs stream. Flag OFF
⇒ zero behavior change. Unit tests green; one live end-to-end demo on a scratch cluster
captured as evidence; hardcoded-values audit clean; `tasks/todo.md` + `tasks/lessons.md`
updated; plain-words recap given. Nothing pushed beyond `feat/docker-sysbox-engine` without
explicit approval.

— End of handoff —
