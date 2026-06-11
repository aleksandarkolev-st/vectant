# Design — Default Marketplace Programs + Programs Panel UI Redesign

**Date:** 2026-06-09 · **Branch:** `tool-compatibility` · **Builds on:** Slice 3 Phase 5 v1 (Open Marketplace).

## Goal
1. Seed a small set of **official default programs** into the marketplace so it's populated for *every* user, independent of whether they've published their own — installable through the existing consent→install flow, shown with a **Verified** badge.
2. Redesign the **whole Programs panel** so it's visually polished and consistent with the rest of the app (brand tokens, card system, gradient accents).

Non-goal: changing the store/route/consent logic. The Phase-5 model already supports non-`local` publishers end-to-end; this task is **seed data + UI + tests only**.

## Why no backend logic changes
- **Browse:** `listPublishedPrograms({q})` returns every `MarketplaceProgram` with `publisher != 'local'`. Seeded `publisher:'vectant'` rows appear automatically (ordered by `installCount desc`).
- **Install:** `getPublishedProgramVersion(packageId, version)` resolves any non-`local` publisher and returns the parsed manifest from its `ProgramVersion`. `POST /programs/install` with `{packageId:'@vectant/…', version}` already installs + bumps `installCount`.
- **Verified:** `toPublicMarketplaceProgram` already returns `verified`. The UI just needs to render the badge.

Verified against the live stack during Phase-5 testing (install of a non-`local` publisher `@n964u0lg/web` worked through these exact paths).

## Component 1 — Default catalog (canonical source of truth)
**New file:** `synthi/src/lib/programs/defaultPrograms.js`
- Exports `DEFAULT_PROGRAM_RECIPES` — an array of raw recipe entries (the canonical, human-readable catalog; later reused by the post-slices "AI recipe-awareness" backlog item, so structure it for reuse: each entry has `name`, the recipe fields, and a `kind` of either `'manifest'` (a `vectant.programs.json`-style object) or `'devcontainer'` (a `devcontainer.json`-style object)).
- Exports `buildDefaultPrograms()` — for each entry: `'manifest'` recipes go through `parseProgramManifest`, `'devcontainer'` recipes go through `importDevcontainer(...).config`. Both paths apply the **same fail-closed validation** as any user recipe (a bad default fails the test, not production). Returns `{ packageId: '@vectant/<name>', config }[]`.
- Exports `ensureDefaultPrograms(prismaClient)` — idempotent: for each, upsert a `MarketplaceProgram` (`packageId:'@vectant/<name>'`, `publisher:'vectant'`, `verified:true`, `displayName:config.displayName`, `description`, `latestVersion:config.version`, `publishedByUserId:null`) + upsert its `ProgramVersion` (`manifestJson = JSON.stringify(config)`, `ports`). Mirrors `publishProgram`'s upsert shape. **Never decrements/zeroes `installCount`** (upsert `update` must not touch it) so re-seeding preserves reputation.

**The default set** — deliberately spans runtime types (not just web), so the catalog shows the full range Vectant supports. `permissions` = `['program.launch']`, plus `'network.outbound'` where an install step fetches deps; web recipes also imply `'ports.expose'`.

| name | displayName | kind / runtimeType | launch | ports | install |
|---|---|---|---|---|---|
| `nextjs-dev` | Next.js Dev Server | manifest / web | `npm run dev` | 3000 | `npm install` |
| `vite-react` | Vite + React | manifest / web | `npm run dev` | 5173 | `npm install` |
| `flask-api` | Flask API | manifest / web | `flask run --host 0.0.0.0 --port 5000` | 5000 | `pip install -r requirements.txt` |
| `static-site` | Static Site | manifest / web | `npx http-server -p 8080` | 8080 | — |
| `node-worker` | Background Worker | manifest / background | `node worker.js` | — | `npm install` |
| `lazygit` | lazygit (Git TUI) | manifest / tui | `lazygit` | — | — |
| `devcontainer` | Dev Container | devcontainer / web | (from `postStartCommand`) | 3000 | (from `postCreateCommand`) |

**Dev Container default (the "Docker" entry):** built by feeding a representative `devcontainer.json` through the existing `importDevcontainer()` — honest and code-reusing, NOT faked:
```json
{ "name": "Dev Container", "version": "1.0.0",
  "image": "mcr.microsoft.com/devcontainers/universal:2",
  "forwardPorts": [3000],
  "postCreateCommand": "npm install",
  "postStartCommand": "npm run dev" }
```
→ `runtimeType:'web'`, port 3000, `install:['npm install']`, `launch:'npm run dev'`, `source:'devcontainer.json'`, `sourceHints.containerImage` = the image. Its `description` makes the limitation explicit: *"Containerized dev environment (devcontainer.json / Docker image). Runs in Vectant's managed runtime today; native Docker execution is on the roadmap."* **Real container execution is NOT introduced here** — the sandbox still blocks `docker.sock`/privileged; native Docker is its own future slice (see Deferred).

**Seed runner — an env-flag-gated API route** (`POST /api/programs/seed-defaults`): calls `ensureDefaultPrograms(prisma)` inside Next's runtime. Gated by `resolveActor()` (401 if unauthenticated) **and** `process.env.ENABLE_PROGRAM_SEED === '1'` (404 otherwise, so it's inert in normal operation). Returns the seeded count. Rationale for a route over a standalone `node` script: the app's `src/lib` modules use extensionless ESM imports (`from './manifest'`) that only a Next/Vite resolver handles — raw `node` can't import them (confirmed on Windows: `ERR_UNSUPPORTED_ESM_URL_SCHEME`), and the route runs inside the app's exact module graph + DB connection. To seed live: set `ENABLE_PROGRAM_SEED=1` in the frontend env (already recreating the container for the UI rebuild), POST the route once from the authenticated browser, confirm 7 rows, then unset. Auto-seed on boot / deploy is **deferred** (YAGNI; documented).

## Component 2 — Programs panel UI redesign (`ProgramsPanel.jsx`)
Restyle the whole panel against existing brand tokens (`--bg-surface`, `--bg-elevated`, `--border-subtle`, `--brand-gradient-horizontal`, `--accent-primary`, `--text-muted`, `--text-secondary`). **All `data-testid`s and hook wiring preserved — behavior unchanged.**

- **Shared card chrome:** one consistent rounded card (padding, subtle border, hover lift via transition) used by Installed / Marketplace / Running / Recent items. Extract a small presentational helper/components within the file (`SectionHeader`, `IconTile`, badge) to keep it DRY; if the file grows unwieldy, split the marketplace card into its own component file under `components/programs/`.
- **Marketplace section:** search field with a leading search icon + on-brand focus ring; cards show an icon tile, `displayName`, the program `description` (so the type — "Background Worker", "Dev Container", etc. — is legible without a runtime chip), `packageId · N installs`, a **Verified** badge (gradient-tinted pill with a check glyph) when `verified`, and a clean Install button (ghost/secondary). Cards are runtime-agnostic (no port shown) so non-web defaults render cleanly. Polished empty state ("No published programs yet" with icon) and a loading state. (A per-card runtime-type chip is **deferred** — `runtimeType` lives in the version manifest, not the `MarketplaceProgram` row, so surfacing it would need a denormalized column; the `description` carries the type for now.)
- **Header / Launch Command / Publish / Install-from-manifest:** aligned spacing and typography; primary actions use the brand gradient, secondary use ghost/outline; section labels use the muted uppercase tracking style already in the panel.
- **Consent prompt:** unchanged (already on-brand).
- Respect `prefers-reduced-motion` for any hover/transition (snap, no motion) to match the app's motion policy.

## Testing (TDD, red→green, commit per task)
1. `defaultPrograms.test.js` — every default builds cleanly (manifest recipes via `parseProgramManifest`, the devcontainer recipe via `importDevcontainer`), covering the **non-web** types (a `background` and a `tui` default produce valid configs with no ports; the `devcontainer` default yields `source:'devcontainer.json'` + `sourceHints.containerImage` + a derived `launch`); `buildDefaultPrograms()` yields `@vectant/<name>` packageIds; `ensureDefaultPrograms` calls the hoisted prisma mock's `marketplaceProgram.upsert` + `programVersion.upsert` with `publisher:'vectant'`, `verified:true`, and an `update` clause that does **not** write `installCount`.
2. Seed route (`seedDefaultsRoute.test.js`) — `401` unauthenticated; `404` when `ENABLE_PROGRAM_SEED` is unset; `200` + `ensureDefaultPrograms` invoked when authenticated + flag set (mock `resolveActor` + `ensureDefaultPrograms`).
3. UI (`programsPanelInstall.test.jsx` extension) — a `verified` marketplace item renders a `data-testid="verified-badge-@vectant/nextjs-dev"`; a seeded default program lists and installs via the existing `installPublishedProgram` path; existing tests stay green.
4. Full regression: `npx vitest run` from `synthi/` (tolerate only the known empty `preview-store.test.js` stub) + backend `node --test` unchanged + `prisma generate`/`db push` in sync (no schema change).

## Live verification (after the suite is green)
Rebuild the frontend image (needed for the new route + UI; check Docker free space first per the disk gate), set `ENABLE_PROGRAM_SEED=1` on the frontend service + recreate it, POST `/api/programs/seed-defaults` from the authenticated browser, then confirm the marketplace lists the 7 `@vectant/*` starters with Verified badges; install one into a workspace through consent and confirm `installCount` bumps. Unset the flag afterward.

## Constraints
Branch `tool-compatibility` only (no merge/PR/finish). TDD only; no `next build`/`docker build` without checking disk. Stage specific files only; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No schema change (additive Phase-5 columns already applied). Don't touch the known noise files. Don't fork the catalog description — `defaultPrograms.js` is the single source of truth (the post-slices AI-awareness backlog item renders from it).

## Deferred (not in this task)
- **Native Docker / container runtime — its own future slice.** Real container execution (a `container`/`docker` runtime type, mounting `docker.sock` or a DinD sidecar into the managed session, plus the security review to safely relax the current host-escape block) is a substantial, security-sensitive effort. This task ships only the catalog-visible **Dev Container** recipe, which runs in the managed session today. Captured in `tasks/todo.md` backlog.
- Per-card runtime-type chip / filter in the marketplace (needs a denormalized `runtimeType` column on `MarketplaceProgram`).
- Auto-seed defaults on app boot / deploy migration.
- Per-default icons/logos (use a generic runtime icon for now).
- The post-slices "AI recipe-awareness" backlog item (system-prompt/context for recipe authoring + external CLI agents) — captured in `tasks/todo.md`.
