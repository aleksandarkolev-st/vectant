# Design — Make Default Programs Runnable in the Workspace

**Date:** 2026-06-09 · **Branch:** `tool-compatibility` · **Builds on:** Slice 3 Phase 5 + default-marketplace-programs.

## Goal
Make installed programs (and the `@vectant/*` defaults specifically) actually *run* in a workspace and be viewable in the App tab. Today three things block that: (1) the program runtime resolves the wrong workspace directory, so a launched program runs against empty/shared files; (2) the App-tab iframe is blocked by CSP; (3) the defaults are bare recipes with no project to run. One cohesive effort fixes all three, in dependency order.

## Component 1 (foundational) — Workspace-dir consistency
**Problem (verified live):** the IDE stores a workspace's files under `repos/<slug>/<session.user.id>` (the GitHub id, e.g. `242593757`) — `page.jsx`/`Editor.jsx`/`TerminalPane.jsx` all key collab identity off `session.user.id || email`. But `resolveActor()` returns the **DB `User.id`** (a cuid), and every program-runtime call threads that cuid into `resolveWorkspaceCwd(slug, cuid)`, which (cuid subdir absent) falls back to the **shared** `repos/<slug>` dir. So `discoverManifest`, `launchInstalledProgram`, and install all operate on the wrong, empty directory → 404 manifests, dev servers that serve nothing.

**Fix:**
- `synthi/src/lib/integrations/session.js` — `resolveActor()` returns an additional `workspaceUserId = session.user.id || session.user.email` (the exact value the IDE uses for the repo dir). Keep `userId` = DB cuid for DB FK records.
- Switch program-runtime **cwd-resolution** callers from `actor.userId` → `actor.workspaceUserId`:
  - `publish/route.js`: `discoverManifest(slug, actor.workspaceUserId)`
  - `install/route.js`: `discoverManifest(slug, actor.workspaceUserId)`
  - `[installId]/launch/route.js`: `launchInstalledProgram({ …, userId: actor.workspaceUserId })`
  - the new scaffold route (Component 3)
- **DB records keep the cuid** (`installedByUserId`, `grantedByUserId`, `startedByUserId` = `actor.userId`). Only the filesystem/cwd resolution uses `workspaceUserId`.

**Why safe:** `resolveWorkspaceCwd` already sanitizes the id (`_safeUserId`) and the IDE feeds it the same `session.user.id || email`, so the dirs line up byte-for-byte. This also fixes the earlier `@n964u0lg/web`-class publish/install 404s (was worked around by hand-placing the manifest at the shared root).

**Tests:** `resolveActor` returns both ids (mock `getServerSession` + the prisma user lookup); route tests assert `discoverManifest`/`launchInstalledProgram` receive `workspaceUserId`, and DB-record writes still use `userId`.

## Component 2 — App-tab CSP fix
**Problem (verified live):** the App tab iframes `${COLLAB_BASE}/port/<N>/` (the collab-server origin, `http://localhost:1234`), but the frontend CSP is `frame-src 'self' blob:` → the browser blocks the cross-origin frame ("this content is blocked"), regardless of whether a server is running. COEP `credentialless` already permits the cross-origin embed; only `frame-src` is too narrow.

**Fix:**
- New `synthi/src/lib/security/csp.js` — `buildContentSecurityPolicy(collabUrl)` returns the CSP string with `new URL(collabUrl).origin` appended to `frame-src` (gracefully ignores a missing/invalid URL).
- `next.config.mjs` calls `buildContentSecurityPolicy(process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234')` instead of the inline array. All other directives unchanged.
- **Tests:** the helper includes the collab origin in `frame-src` for an http/https URL; falls back to `'self' blob:` only when the URL is missing/invalid; the other directives are preserved.

> Scope note: `frame-src` is the minimal correct fix. Routing the port proxy through Next (same-origin) is a larger alternative we explicitly deferred.

## Component 3 — Scaffold-a-starter
**New file:** `synthi/src/lib/programs/scaffoldTemplates.js`
- `SCAFFOLD_TEMPLATES` — minimal inline starters keyed by default name, each `[{ path, contents }]` (write-only-if-missing). v1 set: `nextjs-dev`, `vite-react`, `flask-api`, `static-site`, `node-worker` (NOT `lazygit`/`devcontainer` — nothing to scaffold). Each is 1–4 tiny files (e.g. `package.json` + an entry file).
- `getScaffoldTemplate(packageId)` maps `@vectant/<name>` → its file list (or null); `SCAFFOLDABLE_PACKAGE_IDS` is the set of scaffoldable packageIds (shared by the route + UI).

**collab-server:** `POST /program-runtime/:slug/scaffold` `{ userId, files:[{path,contents}] }` → `resolveWorkspaceCwd(slug, userId)` → for each file: reject path-escape (must resolve inside cwd; reuse the manifest path-validation approach), **skip if it already exists**, else write it (mkdir -p parent). Returns `{ written: string[], skipped: string[] }`. Never clobbers.

**runtimeClient:** `scaffoldProgram({ workspaceSlug, userId, files })` → POSTs the collab route.

**Next route:** `POST /api/workspace/[slug]/programs/scaffold` `{ packageId }` (owner/admin via `canWriteScope`) → `getScaffoldTemplate(packageId)` (404 if none) → `scaffoldProgram({ slug, userId: actor.workspaceUserId, files })` → returns `{ written, skipped }`.

**UI (`ProgramsPanel.jsx`):** installed programs whose `packageId ∈ SCAFFOLDABLE_PACKAGE_IDS` get a **"Set up project"** action. Click → a confirm prompt ("Scaffold an `<displayName>` starter into this workspace? Writes N files; existing files are skipped.") → call scaffold → on success toast the written/skipped counts → then run the existing launch (`handleLaunchInstall`) and open the session tab. `programsClient.scaffoldProgram(slug, packageId)` added.

**Security:** path-traversal guard on every file path (contained in cwd); never overwrite; owner/admin gated; the scaffold writes only the small declared template (no arbitrary client-supplied files — the Next route ignores any client `files` and uses the server-side template).

**Tests:** `scaffoldTemplates` validity (each file has a non-empty path+contents; package.json parses); collab scaffold writes-missing-only + path-escape rejection (`node --test`); Next route (owner gated 403; unknown packageId 404; calls collab with `workspaceUserId` + the server template); UI (action shows only for scaffoldable installs; confirm → scaffold → launch).

## Production cost considerations
- **Defaults add ~no cost.** The catalog is DB rows; browse/install is DB I/O. Adding the 7 `@vectant/*` programs does not raise infra cost.
- **Cost is program *execution*, inside the workspace's *existing* pod.** Prod runs programs as processes inside the per-workspace worker pod (`workspacePodSpawner.js`, k8s; dev: `localWorkerSpawner.js`, docker) that already exists while the workspace is open — launching a program does **not** spin up new infra. Marginal cost = in-pod CPU/RAM/disk.
- **Bounds already enforced:** idle-cull stops sessions after `DEFAULT_IDLE_TTL_MS` (10 min) idle; `DEFAULT_OUTPUT_CAP` (50k); stop=kill. Abandoned dev servers are reaped.
- **This design is cost-conscious by construction:** scaffolding is explicit + confirmed (no auto-launch), `install ≠ launch` (nothing runs until the user starts it), and scaffold writes a few KB.
- **The real prod cost levers are infra/config, tracked separately** (see Deferred): per-workspace pod CPU/mem limits, pod **scale-to-zero** on idle, per-workspace volume **disk quota** (node_modules from install/scaffold is the main growth), a per-workspace **concurrent-session cap**, and an optional npm/pip registry cache to cut egress.

## Testing & verification
TDD throughout (vitest from `synthi/`, `node --test` for collab). No schema change. One frontend **and** collab-server rebuild at the end live-verifies the full chain in a real workspace: install a default → "Set up project" (confirm) → starter files appear in the editor (proving Component 1) → launch → `npm install && npm run dev` runs in the correct dir → web-port auto-detected → **App tab embeds the running server** (proving Component 2). Disk-gate: check Docker free space before the rebuild.

## Constraints
Branch `tool-compatibility` only (no merge/PR/finish). TDD only; no `next build`/`docker build` without checking disk. Run vitest from `synthi/`. Stage specific files only; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No schema change. Don't touch the known noise files.

## Deferred (not in this effort)
- **Production cost controls for the program runtime** (own track): per-workspace concurrent-session cap, pod CPU/mem limits + scale-to-zero on idle, per-workspace disk quota + node_modules cleanup, npm/pip registry cache. Cross-cutting prod-readiness; pairs with Slice-3 quotas + Slice-7 observability (cost visibility). → add to `tasks/todo.md` backlog.
- Scaffolding for user-published programs (a manifest `scaffold` field) — v1 is `@vectant/*`-only via server-side templates.
- "New workspace from template" entry point (we chose scaffold-into-current-workspace).
- Same-origin port proxy (alternative to the CSP `frame-src` fix).
- Resolving the broader cuid-vs-provider-id identity model beyond cwd (DB records intentionally keep the cuid).
