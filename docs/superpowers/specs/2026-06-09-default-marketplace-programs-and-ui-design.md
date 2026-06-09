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
- Exports `DEFAULT_PROGRAM_MANIFESTS` — an array of 5 raw recipe objects (the canonical, human-readable catalog; later reused by the post-slices "AI recipe-awareness" backlog item, so structure it for reuse: each entry has `name`, `displayName`, `description`, and the manifest fields).
- Exports `buildDefaultPrograms()` — runs each raw recipe through `parseProgramManifest` (so the defaults are validated by the **same fail-closed rules** as any recipe; a bad default fails the test, not production), returning `{ packageId: '@vectant/<name>', config }[]`.
- Exports `ensureDefaultPrograms(prismaClient)` — idempotent: for each, upsert a `MarketplaceProgram` (`packageId:'@vectant/<name>'`, `publisher:'vectant'`, `verified:true`, `displayName`, `description`, `latestVersion:config.version`, `publishedByUserId:null`) + upsert its `ProgramVersion` (`manifestJson = JSON.stringify(config)`, `ports`). Mirrors `publishProgram`'s upsert shape. **Never decrements/zeroes `installCount`** (upsert `update` must not touch it) so re-seeding preserves reputation.

**The 5 starters** (all `runtimeType: web`; `permissions` = `['program.launch']`, plus `'network.outbound'` where an install step fetches deps):

| name | displayName | launch | ports | install | permissions |
|---|---|---|---|---|---|
| `nextjs-dev` | Next.js Dev Server | `npm run dev` | 3000 | `npm install` | launch, network.outbound |
| `vite-react` | Vite + React | `npm run dev` | 5173 | `npm install` | launch, network.outbound |
| `flask-api` | Flask API | `flask run --host 0.0.0.0 --port 5000` | 5000 | `pip install -r requirements.txt` | launch, network.outbound |
| `express-api` | Express API | `npm start` | 3000 | `npm install` | launch, network.outbound |
| `static-site` | Static Site | `npx http-server -p 8080` | 8080 | — | launch |

**Seed runner:** `synthi/prisma/seedDefaultPrograms.mjs` — imports the real Prisma client + `ensureDefaultPrograms`, runs it, logs a summary, disconnects. Run on demand (`node prisma/seedDefaultPrograms.mjs`) against the live DB now. Auto-run on boot / deploy wiring is **deferred** (YAGNI here; documented).

## Component 2 — Programs panel UI redesign (`ProgramsPanel.jsx`)
Restyle the whole panel against existing brand tokens (`--bg-surface`, `--bg-elevated`, `--border-subtle`, `--brand-gradient-horizontal`, `--accent-primary`, `--text-muted`, `--text-secondary`). **All `data-testid`s and hook wiring preserved — behavior unchanged.**

- **Shared card chrome:** one consistent rounded card (padding, subtle border, hover lift via transition) used by Installed / Marketplace / Running / Recent items. Extract a small presentational helper/components within the file (`SectionHeader`, `IconTile`, badge) to keep it DRY; if the file grows unwieldy, split the marketplace card into its own component file under `components/programs/`.
- **Marketplace section:** search field with a leading search icon + on-brand focus ring; cards show an icon tile, `displayName`, `packageId · N installs`, a **Verified** badge (gradient-tinted pill with a check glyph) when `verified`, and a clean Install button (ghost/secondary). Polished empty state ("No published programs yet" with icon) and a loading state.
- **Header / Launch Command / Publish / Install-from-manifest:** aligned spacing and typography; primary actions use the brand gradient, secondary use ghost/outline; section labels use the muted uppercase tracking style already in the panel.
- **Consent prompt:** unchanged (already on-brand).
- Respect `prefers-reduced-motion` for any hover/transition (snap, no motion) to match the app's motion policy.

## Testing (TDD, red→green, commit per task)
1. `defaultPrograms.test.js` — every default parses cleanly through `parseProgramManifest` (valid `runtimeType`, ports in range, known scopes); `buildDefaultPrograms()` yields `@vectant/<name>` packageIds; `ensureDefaultPrograms` calls the hoisted prisma mock's `marketplaceProgram.upsert` + `programVersion.upsert` with `publisher:'vectant'`, `verified:true`, and an `update` clause that does **not** write `installCount`.
2. UI (`programsPanelInstall.test.jsx` extension) — a `verified` marketplace item renders a `data-testid="verified-badge-@vectant/nextjs-dev"`; a seeded default program lists and installs via the existing `installPublishedProgram` path; existing tests stay green.
3. Full regression: `npx vitest run` from `synthi/` (tolerate only the known empty `preview-store.test.js` stub) + backend `node --test` unchanged + `prisma generate`/`db push` in sync (no schema change).

## Live verification (after the suite is green)
Run the seed script against the live DB; reload the running frontend; confirm the marketplace lists the 5 `@vectant/*` starters with Verified badges; install one into a workspace through consent and confirm `installCount` bumps. (Rebuild the frontend image only if you want the restyle visible live — check Docker free space first per the disk gate.)

## Constraints
Branch `tool-compatibility` only (no merge/PR/finish). TDD only; no `next build`/`docker build` without checking disk. Stage specific files only; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No schema change (additive Phase-5 columns already applied). Don't touch the known noise files. Don't fork the catalog description — `defaultPrograms.js` is the single source of truth (the post-slices AI-awareness backlog item renders from it).

## Deferred (not in this task)
- Auto-seed defaults on app boot / deploy migration.
- Per-default icons/logos (use a generic runtime icon for now).
- The post-slices "AI recipe-awareness" backlog item (system-prompt/context for recipe authoring + external CLI agents) — captured in `tasks/todo.md`.
