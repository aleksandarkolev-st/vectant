# HANDOFF — Implement "Program ↔ Workspace file sync (foundation)"

> Paste everything below the line into a fresh Opus 4.8 chat opened in this repo
> (`C:\Users\HP\source\repos\synthi-ide`). It is self-contained: context + guardrails + tasks.

---

You are implementing an **already-approved spec** in the **synthi / Vectant** codebase (a production
cloud web IDE). Read the spec in full FIRST, then implement it task-by-task with strict TDD, committing
per task.

**Spec (read it completely before anything else):**
`docs/superpowers/specs/2026-06-21-program-workspace-file-sync-design.md`

## Mission (one paragraph)
Make a curated container/GUI program (first: **DBeaver**, which runs in the per-workspace runtime and is
streamed via KasmVNC) read/write the **same `/workspace` files as the editor**, with changes flowing
**both ways**: a file a program creates/edits appears **live** in the editor file tree and opens with the
right content; a file the user edits in the editor is visible to the program on disk. This is the
**filesystem foundation** slice — NOT the DB/networking or credential-handoff slices (those are explicitly
out of scope; do not start them).

## Project map
- `synthi/` — Next.js frontend + API routes (Node runtime). Tests: **vitest**.
- `backend/collab-server/` — Node collaboration server: Y-Sweet doc sync, terminals, the per-workspace
  runtime launch, and the filesystem watcher. Tests: **`node:test`**.
- `mcp/synthi-mcp/` (TS), `backend/synthi-webrtc-compiler/worker/` (Rust), `ai-backend/` (Python) —
  **not touched** in this slice.
- Deployed on GKE. The per-workspace runtime is a **Sysbox pod** (prod) or a **hybrid docker container**
  (local). Both mount the **same workspace files**.

## Grounded architecture facts — verify by READING the cited code; do NOT assume
1. **Workspace is already shared.** The runtime pod mounts the same `collab-data-pvc` as collab-server,
   confined via `subPath` to the workspace repo dir at **`/workspace`**
   (`backend/collab-server/runtimePodSpec.js`). Local: the hybrid runtime container mounts the shared
   `collab-data` volume (`docker-compose.yml` → `WORKSPACE_DATA_VOLUME`). Persistence is not the issue.
2. **disk→editor pipeline ALREADY EXISTS.** `backend/collab-server/fsWatcherService.js` watches the repo
   dir with `fs.watch` and emits `fs-change`. `server.js` consumes via `registerChangeListener`:
   `~:1135` (git refresh) and `~:1162` (**out-of-band write detection** → hash-compare → **Y-Sweet doc
   invalidation** so Monaco refetches fresh disk content; self-saves skipped via `fileHashCache`).
   So once an `fs-change` fires for a program write, the editor already reacts correctly.
3. **editor→disk path ALREADY EXISTS.** `flushWorkspaceDocsToDisk(slug, userId)` (`server.js:877`)
   flushes Y-Sweet docs (`workspace:<slug>:user:<userId>:<filePath>`) to disk — but is currently called
   **only at program launch** (`server.js:1943`).
4. **container mount pattern ALREADY EXISTS.** The devcontainer/Dockerfile mappers use
   `docker run --rm … -v "$PWD":/workspace -w /workspace <image>`
   (`synthi/src/lib/programs/devcontainer.js:~157`, `dockerfile.js:~51`). The launch runs with cwd
   `/workspace`, so `"$PWD"` is the workspace.

**The only real gaps (what you build):**
- (a) the `@vectant/dbeaver` recipe doesn't mount the workspace into the program container;
- (b) `fs.watch`/inotify **does not fire for writes another pod/container makes** to the shared volume,
  so the existing pipeline never triggers for a program's writes → add a **polling fallback**;
- (c) the editor→disk flush isn't **continuous** → make it run while a program session is active.

## Files you will touch (read these first)
- `synthi/src/lib/programs/defaultPrograms.js` — `@vectant/dbeaver` recipe `launch` (add workspace mount;
  factor a small shared helper so all container/webGui programs get it).
- `synthi/src/lib/programs/devcontainer.js` / `dockerfile.js` — mirror their existing `-v "$PWD":/workspace`.
- `backend/collab-server/fsWatcherService.js` — add the polling/stat-diff fallback emitting the SAME
  `fs-change` events; reuse `shouldIgnore`, `MAX_EVENTS_PER_BATCH`, `isWatcherPaused`, `isStagingLocked`.
- `backend/collab-server/server.js` — `flushWorkspaceDocsToDisk` (877), the `registerChangeListener`
  consumers (1135/1162), launch-time flush (1943); wire continuous flush while a program session is active.
- `backend/collab-server/shadowContinuousProducer.js` — CHECK FIRST for an existing continuous-flush
  mechanism to extend rather than duplicate.
- Tests: `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`,
  `backend/collab-server/__tests__/*.test.js`.

## HARD GUARDRAILS
- **Branch:** work ONLY on `feat/docker-sysbox-engine`. NEVER push to `main`/`dev` without explicit
  approval. `git push origin feat/docker-sysbox-engine` only.
- **TDD, no exceptions:** for each task write the failing test → run it, CONFIRM it fails for the right
  reason → minimal implementation → run, CONFIRM green → commit. Evidence before claims.
- **Commit per task.** End every commit message with exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Do NOT commit `synthi/Dockerfile`** — it has a local-only `npm install` tweak and shows as Modified;
  leave it unstaged. **Stage only your task's files explicitly** — never `git add -A` / `git add .`.
- **PowerShell commit gotcha:** multi-line here-strings can mangle the message and feed it to `git add`.
  Use `git commit -F <tempfile>` (write the message with the Write tool) or a single-line `-m`.
- **Surgical:** touch only what the task needs; match surrounding style; no unrelated refactors; remove
  only orphans your change creates.
- **Security (must hold):** mount ONLY `/workspace` (the user's own per-workspace dir, subPath-confined) —
  never host paths, never docker.sock, never another workspace. The KasmVNC kiosk (no terminal/desktop/
  browser to escape to) is unchanged. Programs are slug-routed / per-workspace.
- **Hardcoded values:** poll interval + enable flag MUST be env-driven (e.g. `SYNTHI_FS_POLL_INTERVAL_MS`,
  `SYNTHI_FS_POLL_ENABLED`); mount path is the universal `/workspace`.

## EXACT test commands
- collab-server (ALWAYS scope paths + timeout — bare `node --test` hangs on a handle leak):
  `cd backend/collab-server; node --test --test-timeout=20000 __tests__/<file>.test.js`
- synthi: `cd synthi; npx vitest run src/lib/programs/<file>.test.js`
- `node --check backend/collab-server/<file>.js` on touched modules.

## Tasks (do in order, TDD each, commit each)
1. **Recipe workspace mount.** Failing test: the `@vectant/dbeaver` recipe `launch` contains
   `-v "$PWD":/workspace -w /workspace`. Implement a shared helper used by the recipe (and reusable by
   other container programs). Green → commit.
2. **fsWatcher polling fallback.** Failing test(s): given two tree snapshots, the diff emits `fs-change`
   for added/modified/deleted entries, honors `shouldIgnore` + the bulk cap + pause/staging suppression,
   and is env-gated (off by default → no-op). Implement; reuse the existing event shape so
   `registerChangeListener` consumers need NO change. Green → commit.
3. **Continuous editor→disk flush.** First read `shadowContinuousProducer.js`. Failing test: while a
   `webGui`/`container` program session is active, the flush runs for that session's `slug`+`workspaceUserId`
   on save/idle (mock `flushWorkspaceDocsToDisk`). Implement (debounced; reuse the existing flush).
   Green → commit. NB: §6 of the spec — the watch dir and the program's `/workspace` target and the flush
   userId must all be the SAME per-user dir; verify the path alignment.
4. **Local e2e (docker-compose).** Build `backend/gui-images/gui-base` then `…/dbeaver`, make the image
   reachable to the hybrid runtime (load it into the runtime's docker, or set `VECTANT_DBEAVER_IMAGE`),
   `docker compose up -d`, `POST http://localhost:3000/api/programs/seed-defaults`, open localhost:3000 →
   workspace → Programs → launch DBeaver. DEMONSTRATE: create a file in DBeaver → it appears in the editor
   tree + opens with correct content; edit a file in the editor → visible to DBeaver on disk. Capture
   evidence. (MCP exec/launch tools won't work locally — they need the Sysbox pod; that's expected and out
   of scope here.)
5. **Wrap.** Hardcoded-values audit; update `tasks/lessons.md` if you were corrected; update
   `tasks/todo.md` (mark this slice done, note the next slices: DB/networking, credential hand-off);
   1–2 sentence plain-words recap; push `feat/docker-sysbox-engine`.

## Done = 
Both suites green (show the output), local round-trip demonstrated with evidence, `synthi/Dockerfile`
NOT committed, `tasks/todo.md` updated, branch pushed. Do not begin the follow-on slices.

## Read these lessons before starting (`tasks/lessons.md`)
- the collab-server `node --test` hang (scope with explicit paths + `--test-timeout`);
- the PowerShell here-string commit-message gotcha (use `git commit -F`);
- the **workspaceUserId vs Prisma `User.id`** nuance (NextAuth JWT, no adapter → `session.user.id` is the
  OAuth provider id, distinct from the DB id) — relevant to which userId the flush + watch dir use;
- ground designs on CURRENT reads, not stale assumptions.
