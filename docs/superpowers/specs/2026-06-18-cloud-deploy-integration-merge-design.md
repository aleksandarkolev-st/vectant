# Integrate the cloud-deploy trunk into the sysbox-programs branch — Slice 2 design

**Date:** 2026-06-18
**Status:** Design proposed — pending user review, then implementation plan
**Branch:** `feat/docker-sysbox-engine` — merge `origin/main` **IN**; do NOT push beyond this branch (or land on `main`/`dev`) without explicit approval.
**Why now:** an audit of the remote found `origin/main` (= the `cloud-deploy` trunk) had advanced **51 commits** in our exact domain — a parallel "hosted-runtime preview discovery + workspace browser viewer + terminal OAuth-relay" effort — while our branch built the sysbox per-workspace Docker runtime + programs-on-sysbox. The two lines are **complementary, not contradictory**, but will collide on merge and share two design concerns (preview/port discovery; "app UI in workspace" surface). This slice integrates them on one base before further feature work.

## 1. Goal & scope

One base where slice-1 (sysbox container programs) and main's preview/browser/OAuth work **coexist**, **both full test suites green**, and **both preview surfaces remain functional** — plus one small convergence win: adopt main's infra-port filtering in our runtime port attribution so the program App tab never surfaces dockerd (2376) or other infra ports.

**In scope:** the merge, conflict resolution (6 files), the infra-port filter adoption, full-suite + live re-validation.
**Out of scope (deferred):** unifying the two discovery pipelines into one; retiring our k8s-exec runtime port monitor; re-validating main's OAuth/browser features (already trunk-tested); any push to `main`/`dev`.

## 2. Branch relationship & mechanism

- `feat/docker-sysbox-engine` vs `origin/main`: **225 ahead / 51 behind** (diverged). vs `origin/dev`: **94 ahead / 0 behind** (we strictly contain dev).
- **Merge, not rebase.** Rebasing 225 commits onto main rewrites history and forces a push of a shared branch — unacceptable. `git merge origin/main` creates one merge commit on our branch, preserves history, and is reversible (`git merge --abort` / reset to pre-merge SHA). Record the pre-merge HEAD (`33515abe…`) for rollback.

## 3. Conflict resolution plan

The read-only trial merge (`git merge-tree --write-tree origin/main HEAD`, git 2.43) auto-merges everything except **6 files**. Per-file strategy:

| File | Conflict | Resolution |
|---|---|---|
| `backend/collab-server/workspacePodSpawner.js` | both heavily edited | **Additive union.** Keep main's `previewSidecarScript` discovery + `workflowBridgeContainers` + browser-viewer + runtime persistence + prod-eviction **and** our `spawnRuntimePod`/`buildRuntimeService`/`runtimeLifecycleSnapshot`/`listActiveRuntimeSessions`/`getReadyRuntimePodForSession`/`purgeRuntimeData`. Merge the shared top-of-file constants block (take both sides' consts). These are mostly disjoint functions. |
| `backend/collab-server/runtimePodTerminal.js` | both edited | **Additive union.** Main's runtime-persistence + OAuth hooks **and** our `createRuntimePodProgram`/`buildRuntimeShellScript`/`programRuntimeTarget`/`pickRuntimeScopeForSlug` + `module.exports` (merge both export lists). |
| `backend/collab-server/terminalService.js` | both edited | **Additive union** of both sides' edits; verify the OAuth-relay path and our terminal routing both survive. |
| `synthi/package-lock.json` | lock drift | **Regenerate, never hand-merge.** Accept the merged `synthi/package.json`, then `npm install --package-lock-only --cache D:/npm-cache-tmp` (route the cache to D: — C: has ~1.9 GB free and npm ENOSPC'd there during the local rebuild). |
| `synthi/src/app/workspace/ActivityBar.jsx` | both add a panel | **Union** both activity-bar entries (ours: programs; main's: workspace browser). |
| `synthi/src/components/docking-wm/components/DockingActivityBar.jsx` | both add a panel | **Union** both panel registrations. |

**Discipline:** read every conflict hunk — do NOT blind-union. The only danger is if both sides edited the *same* function body (vs adding adjacent functions); resolve those by hand preserving both behaviors. `server.js` auto-merges (our `launchRuntime` branch and main's OAuth additions are in different regions) but will be re-read post-merge to confirm intent survived.

## 4. Pre-merge cleanup

Working tree must be clean before merging (uncommitted edits to merge-touched files block/tangle a merge):
- **Revert** the two docker-detour artifacts: `git checkout -- synthi/Dockerfile` (the `npm ci`→`npm install` local workaround) and `git checkout -- package-lock.json` (root, partial regen). They were local-rebuild workarounds, never slice content; the lock is regenerated anyway.
- Leave untracked `memory/` and `tasks/handoff-real-programs-in-workspace.md` (harmless; not committed).

## 5. Convergence win — infra-port filtering in runtime attribution

Main's preview sidecar excludes infra ports (an `INFRA_PORTS` set: sidecar/bridge/CDP/VNC/view ports) and filters to HTTP app ports. Our `recomputeRuntimeScopePorts` currently attributes *every* detected port — so dockerd's `2376` (seen in the Slice-4 live scan `[2376,8000]`) could be surfaced as a program's "app port."

**Change:** in `recomputeRuntimeScopePorts`, filter a configurable infra-port set out of `detectedPorts` before attribution — at minimum `2376` (dockerd) and the preview-sidecar port. Env-driven (`RUNTIME_INFRA_PORTS`, default `2376` + the sidecar port) so it's not a hardcoded literal (hardcoded-values-audit).

**TDD:** red→green unit test in `programRuntimeManager.test.js` — `recomputeRuntimeScopePorts(scope, [2376, 8080])` attributes only `8080` to a same-scope session; `2376` is dropped.

## 6. Verification

1. **Both full suites green (the safety net):** backend `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` (now includes main's `runtimePersistence.test.js` + any browser-bridge tests + ours) → 0 fail; frontend `cd synthi && npx vitest run` over the programs + workspace areas → 0 fail. Note pass/skip deltas.
2. **Boot/syntax:** `node --check backend/collab-server/server.js` (the auto-merged big file) + the merged collab-server modules.
3. **Lockfile sanity:** regenerated `synthi/package-lock.json` resolves (no `npm ci` drift — the very issue from the docker detour).
4. **Live re-validation (requested):** on a fresh scratch cluster, bring up the runtime pod built from the **merged** `workspacePodSpawner.js` (now carrying main's preview-sidecar changes) and re-run the slice-1 gate — `docker compose up` in the sysbox pod → published port surfaces (and, with §5, infra ports excluded) → HTTP 200 via the preview path → logs + terminal exec. Confirms main's merged sidecar/runtime edits didn't regress the sysbox runtime. Verify `kubectl config current-context` = scratch before any apply; tear down after (`--quiet --async`; confirm prod-only).

## 7. Risks

- **Same-function edits** on both sides (vs adjacent additions) — mitigated by hunk-by-hunk review + both suites.
- **package-lock regeneration** may bump transitive versions within ranges — suites catch breakage; acceptable for a dev base.
- **Surface-area increase** — the merge pulls main's 51 commits (browser bridge, OAuth relay). We rely on main's own tests + ours; we do not re-audit trunk features.
- **Rollback:** if the merge goes wrong, `git merge --abort` (pre-commit) or `git reset --hard 33515abe…` (post-commit, pre-push) restores the branch.

## 8. Hardcoded-values audit

Only one new value: `RUNTIME_INFRA_PORTS` (env-driven, default `2376` + sidecar port — universal/derived, not env-specific/secret). Everything else inherited from the two merged lines. Full audit at slice end.
