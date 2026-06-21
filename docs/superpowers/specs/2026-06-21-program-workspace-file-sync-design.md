# Spec — Program ↔ Workspace file sync (foundation)

> Status: approved design (brainstormed 2026-06-21). Next phase: `writing-plans` → TDD.
> Branch: `feat/docker-sysbox-engine`. Flag-/marker-gated; zero behavior change when a program
> doesn't opt in. This is the FIRST slice of "programs fully connected to the workspace" — the
> filesystem foundation that DB/networking + credential-handoff slices build on.

## 1. Goal & scope

A program (first: **DBeaver**) running in the per-workspace runtime reads/writes the **same
`/workspace` files** as the editor, and changes flow **both ways**:

- a file a program **creates or edits** appears **live** in the editor file tree and opens with the
  correct content;
- a file the user **edits in the editor** is visible to the program on disk.

**In scope (this slice):** the bidirectional file round-trip for `container`/`webGui` programs, working
**identically in the local hybrid runtime and the Sysbox pod** (one mechanism), verified locally first.

**Out of scope (later slices):** cross-program networking / DBeaver↔a DB program; the KasmVNC
credential hand-off into the App-tab iframe; persistence of program state across restarts; a real-time
push agent inside the runtime (polling is the v1 mechanism).

## 2. Locked decisions (from the brainstorm)

1. **Success scenario = files round-trip** (program↔editor, both directions), one program (DBeaver).
2. **One unified mechanism** for local hybrid + Sysbox pod; **build + verify locally** (docker-compose),
   then it carries to GKE unchanged.
3. **Polling-based detection** of cross-writer changes (≈1–2s, debounced) — simple, topology-agnostic,
   no agent inside the runtime. A real-time push agent is a later optimization.
4. **Reuse the existing disk→editor pipeline** — do NOT build a new editor notify path.

## 3. Key architecture facts (grounded — do not re-derive wrong)

- **The workspace is already shared.** The Sysbox runtime pod mounts the **same `collab-data-pvc`** as
  the worker/collab-server, confined to the workspace's repo dir via **`subPath`** at **`/workspace`**
  (`backend/collab-server/runtimePodSpec.js`: `RUNTIME_WORKSPACE_MOUNT='/workspace'`,
  `workspaceSubPath(metadata)`, `claimName: WORKSPACE_DATA_PVC`). Locally, the hybrid runtime container
  mounts the shared `collab-data` volume (`docker-compose.yml`: `WORKSPACE_DATA_VOLUME`). Persistence is
  NOT the problem.
- **The disk→editor pipeline already exists.** `fsWatcherService.js` watches `repos/<slug>/…` with
  `fs.watch` and emits `fs-change` events. `server.js` consumes them via `registerChangeListener`:
  - line ~1135 → git-status refresh;
  - line ~1162 → **out-of-band write detection**: for any *non-editor* writer (terminal, AI agent),
    hash-compares disk vs the last editor write and **invalidates the Y-Sweet doc** so connected Monaco
    clients refetch fresh disk content (self-saves are skipped via `fileHashCache`); file-tree refresh
    is broadcast to clients.
  So once an `fs-change` event fires for a program's write, the editor **already** reacts correctly
  (tree refresh + Y-Sweet invalidation + git refresh).
- **The editor→disk path already exists.** `flushWorkspaceDocsToDisk(slug, userId)` (`server.js:877`)
  flushes the workspace's Y-Sweet docs (`workspace:<slug>:user:<userId>:<filePath>`) to disk. It is
  currently called **only at program launch** (`server.js:1943`).
- **The container-mount pattern already exists.** The devcontainer/Dockerfile mappers launch with
  `docker run --rm … -v "$PWD":/workspace -w /workspace <image>` (`synthi/src/lib/programs/devcontainer.js:157`,
  `dockerfile.js:51`). `createRuntimePodProgram` runs the launch command with **cwd `/workspace`**, so
  `"$PWD"` is the workspace there; the hybrid `execInRuntime` runs in the workspace cwd too.

**The only real gaps:** (a) the DBeaver recipe doesn't mount the workspace into the program container;
(b) `fs.watch`/inotify **does not fire for writes made by another pod/container** on the shared volume,
so the existing pipeline never triggers for a program's writes; (c) the editor→disk flush isn't
continuous, so a program reading disk sees content only as fresh as the last launch.

## 4. Components

### 4.1 Workspace mount into the program container
Add the workspace bind-mount to the program launch command for `container`/`webGui` programs, mirroring
the existing devcontainer mapper: `… -v "$PWD":/workspace -w /workspace <image>`. Implement as a small
shared helper (so every container program gets it consistently) and use it in the `@vectant/dbeaver`
recipe `launch` (`synthi/src/lib/programs/defaultPrograms.js`). Files a program writes under
`/workspace` then land on the shared volume — the same per-workspace repo dir the editor uses.

### 4.2 Polling fallback in `fsWatcherService`
Augment `backend/collab-server/fsWatcherService.js` so that, in addition to `fs.watch` (which catches
in-pod editor/terminal writes), it **periodically stat-diffs the watched tree** (recursive readdir +
mtime/size snapshot, env-configurable interval, default ≈2000ms, debounced) and emits the **same
`fs-change` events** for entries that changed since the last snapshot — catching writes inotify misses
(another pod's/container's writes to the shared volume). Reuse the existing ignore rules (`shouldIgnore`,
`IGNORED_DIRS`/`IGNORED_PATTERNS`), the `MAX_EVENTS_PER_BATCH` bulk guard, and respect the existing
`isWatcherPaused` (git ops) + `isStagingLocked` suppression. **No downstream changes** — the existing
`registerChangeListener` consumers (Y-Sweet invalidation, git refresh, tree broadcast) already handle
the events. Polling is per-active-watcher and ref-counted like the inotify watcher; the interval is
opt-in/env-gated so it's a no-op when off.

### 4.3 Continuous editor→disk flush
Make the workspace's Y-Sweet→disk flush happen **continuously while a `webGui`/`container` program
session is active**, not only at launch — debounced on editor save/idle and/or a periodic flush keyed by
the active program session — so a program reading `/workspace` sees current editor content. Reuse
`flushWorkspaceDocsToDisk(slug, userId)`. Before building, **check `shadowContinuousProducer.js`** for an
existing continuous-flush mechanism to extend rather than duplicate. The flush requires the
**workspaceUserId** (the per-user doc prefix) — see §6.

## 5. Data flow

- **Program → editor:** DBeaver writes `query.sql` under `/workspace` → polling fallback (4.2) detects
  it → emits `fs-change` → existing `registerChangeListener` invalidates the Y-Sweet doc + refreshes the
  tree + git → the file appears in the editor and opens with the on-disk content.
- **Editor → program:** user edits `schema.sql` in Monaco → Y-Sweet doc updates → continuous flush (4.3)
  writes it to `/workspace` → DBeaver (reading disk) sees the current content.

## 6. Identity & path-alignment (must verify during implementation)

- `flushWorkspaceDocsToDisk` keys docs by **workspaceUserId** (`workspace:<slug>:user:<userId>:…`), and
  the runtime repo dir is per-user (`workspaceSubPath`). The continuous flush must run for the **same
  workspaceUserId** whose files the program mounts, and the **polling watcher must watch the exact dir
  the program writes to** (collab-server watch root == runtime program `/workspace` target on the PVC).
  Confirm these paths line up (per-user subPath) — a mismatch means the editor watches a different dir
  than the program writes. This is the same workspaceUserId nuance noted in
  `tasks/todo.md` (Slice-3 Group E residual).

## 7. Security

- The program reads/writes the **user's own** files in their **own** per-workspace runtime
  (slug-routed). No cross-tenant exposure. Only `/workspace` is mounted (subPath-confined on the PVC) —
  **no host paths**, no docker.sock, no other workspace. The KasmVNC kiosk lockdown is unchanged.
- The polling watcher reads only the already-watched workspace tree; it changes detection, not access.

## 8. Conflict model (inherited)

Program writes are treated exactly like the existing **out-of-band writers** (terminal/AI): the
`server.js:1162` handler hash-compares and invalidates the Y-Sweet doc so clients refetch the new disk
content; self-initiated editor saves are skipped via `fileHashCache`. A file open with **unsaved** editor
edits that a program also writes resolves the same way it does for terminal/AI writes today
(disk content is refetched). No new conflict UX in this slice; if a stronger "changed on disk" prompt is
wanted, it's a follow-up that applies uniformly to all out-of-band writers.

## 9. Hardcoded-values audit

The polling interval, enable flag, and any batch caps must be **env-driven** (e.g.
`SYNTHI_FS_POLL_INTERVAL_MS`, `SYNTHI_FS_POLL_ENABLED`); the workspace mount path is universal
(`/workspace`, matching the existing mappers). Full audit at slice end (per the hardcoded-values-audit
memory).

## 10. Testing (TDD)

- **Unit:**
  - the workspace-mount helper produces `-v "$PWD":/workspace -w /workspace <image>` and the DBeaver
    recipe `launch` includes it (`synthi` vitest).
  - `fsWatcherService` polling: given two directory snapshots, the diff emits `fs-change` events for
    added/modified/deleted entries, honors `shouldIgnore`, the bulk cap, and pause/staging suppression
    (collab-server `node:test`).
  - continuous-flush trigger fires `flushWorkspaceDocsToDisk` for the active session's slug+userId on
    save/idle (collab-server `node:test`, mock the flush).
- **Integration:** an external (non-editor) write into the watched dir → polling emits `fs-change` →
  the existing invalidation listener is invoked for that file (mock the Y-Sweet invalidation boundary).
- **Local e2e (docker-compose):** open a workspace, launch DBeaver, **create a file in DBeaver → it
  appears in the editor tree and opens with the right content**; **edit a file in the editor → the
  change is visible to DBeaver on disk**. (Requires `vectant-dbeaver` loaded into the local hybrid
  runtime's docker + the recipe mount.)

## 11. Verification / gate

Both suites green (backend `node --test` scoped with explicit paths + timeout; frontend `vitest` over
programs/fs); `node --check` on touched collab-server modules; the local docker-compose round-trip above
demonstrated. No GKE cluster required for this slice (the mechanism is topology-agnostic and validated
locally); the Sysbox path inherits it unchanged.

## 12. Non-goals (this slice)

Cross-program networking / DBeaver↔DB; KasmVNC credential hand-off; program-state persistence across
restarts; a real-time runtime-side push agent; a new conflict-resolution UX. These are follow-on slices
that build on this foundation.
