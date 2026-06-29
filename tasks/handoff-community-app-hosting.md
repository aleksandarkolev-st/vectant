# Handoff prompt — Community-App Hosting (submission + hybrid review gate)

> Paste everything below the line into a fresh Opus 4.8 chat opened in the
> `synthi-ide` repo. It is self-contained: the new agent has none of the
> originating conversation's context.

---

You are picking up a well-scoped feature in the **Synthi/Vectant** monorepo (a Next.js web IDE + Node collab-server + Rust worker + Python ai-backend, with per-workspace **Sysbox** runtime pods on GKE). Work on branch **`feat/docker-sysbox-engine`**.

## Mission

Implement **Sub-system 1 of the community-app hosting platform: submission + the hybrid review gate**, exactly as specified in:

**`docs/superpowers/specs/2026-06-25-community-app-hosting-design.md`** — read it in full first; it is the source of truth.

One-paragraph why: publishing today just lists a manifest and installing copies the recipe — nothing runs hosted. The goal is that a **published community app actually runs, hosted, inside any installer's workspace** (like the built-in DBeaver/Postman), with a review gate that keeps malicious/broken apps out — **on first publish and on every update**. Publishers bring a pre-built image in their own registry; after approval we `crane copy` it into our Artifact Registry **pinned by digest** so *what we reviewed is exactly what installers run*.

## Read first (in this order)

1. `docs/superpowers/specs/2026-06-25-community-app-hosting-design.md` (the spec).
2. `CLAUDE.md` (repo working agreement — plan-first, TDD, surgical changes).
3. `tasks/lessons.md` (hard-won gotchas — **especially the environment ones below**).
4. The touchpoints you'll extend: `synthi/src/lib/programs/{manifest.js,devcontainer.js,store.js}`, `synthi/prisma/schema.prisma` (`MarketplaceProgram`, `ProgramVersion`), `synthi/src/app/api/workspace/[slug]/programs/**`, and the existing publish/marketplace flow in `synthi/src/components/programs/`.

## Process guardrails (non-negotiable)

- **Plan first.** Do NOT start coding. The design is already brainstormed and approved — go straight to the **`superpowers:writing-plans`** skill to turn the spec into a TDD implementation plan (Phase 1 only — see "Phasing" in the spec). Present the plan and check in before implementing.
- **TDD, strictly** (`superpowers:test-driven-development`): write a failing test, watch it fail for the right reason, write minimal code to pass, refactor green. No production code without a failing test first. The security invariants in the spec each need a pinned test.
- **One commit per task**, conventional-commit messages, ending with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Surgical/minimal changes.** Match existing style. Reuse `parseProgramManifest` (schema + host-escape), the `devcontainer.js` host-escape rules, and `store.js` patterns — don't reinvent them.
- **Verify before claiming done** (`superpowers:verification-before-completion`): run the tests, show the output.
- **Do NOT push** unless explicitly asked. **Do NOT** open PRs unless asked.
- Use `superpowers:systematic-debugging` for any failure — root cause before fixes.

## Security invariants (must each be test-pinned)

- Hard gates **fail-closed**: invalid schema / over-broad scope / host-escape / over-threshold CVE / metadata mismatch → `rejected`, never `published`.
- Host-escape denied: `docker.sock`, host bind mounts, `privileged`, `--cap-add`, `--security-opt`, `--device` (reuse `devcontainer.js`).
- Re-host pins by **digest**; the published manifest references the AR digest; installers never receive the publisher's mutable tag (anti review-then-swap).
- Update re-runs the full gate; the previously-approved digest stays live until the new one is approved.
- Manual review is **admin-only**; a publisher can't approve their own submission.
- `canPublish(user)` gates **every** submit path (UI + API + MCP). It returns `true` for now (paywall is a later, separate concern — leave the hook).
- Stored scan/AI reports are secret-redacted in public/member responses (allow-list serialization, like `toPublicInstall`).

## Environment gotchas (this box, right now)

- **C: drive is at ~0.1 GB free.** vitest's default worker pool **OOMs/crashes** here. Run frontend tests from `synthi/` with temp redirected to D:, single-fork:
  ```
  cd synthi
  $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'
  npx vitest run <substring-filter> --pool=forks --no-file-parallelism --maxWorkers=1
  ```
  (Filter by a **bracket-free substring**, e.g. `programRoutes`, not a `[slug]` path — brackets are glob char-classes.)
- **Backend (collab-server) tests** are `node --test` (CJS), scoped by absolute path:
  `node --test --test-timeout=20000 "C:/Users/HP/source/repos/synthi-ide/backend/collab-server/__tests__/<file>.test.js"`
- **PowerShell `Set-Location` and the Bash tool share one CWD.** For git, always use `git -C "C:/Users/HP/source/repos/synthi-ide" …` so paths don't double up (`synthi/synthi/…`).
- **Prisma:** after schema changes, run `npx prisma generate` then **`prisma db push`** against the local DB (local was created with `db push`, has no migration history — `migrate deploy` would try to re-create existing tables; lesson #40). Use `DATABASE_URL=postgresql://synthi:password@localhost:5432/synthi`.
- **Do NOT run `next build` or `docker build`** (disk gate). Verify via tests + `node --check`.
- `git fetch`/network can hang here; don't block on it. `gh` is **not installed**.

## Context you need

- **A "program" is a manifest** (`vectant.programs.json`) with `runtimeType` (web/container/gui/cli/tui/background), `install[]`, `launch`, `ports[]`, `permissions[]`. Container/GUI programs `docker run <image>`; the image runs as an inner container inside the installer's **Sysbox runtime pod** (its own dockerd). Web/CLI/TUI run their commands in the runtime — no image. The built-in catalog (`defaultPrograms.js`) ships `@vectant/*` programs (dbeaver, postman, portainer, nextjs-dev, …) as **digest-pinned AR images** — community apps follow the same pattern.
- **Existing publish flow:** `store.publishProgram` lists the workspace recipe in `MarketplaceProgram`/`ProgramVersion`; `fetchMarketplace` lists it; install copies the recipe. You are inserting the **review gate** between submit and listing, and a **re-host** step so the listing serves our pinned digest.
- **Tooling already proven in this repo:** `trivy` (host-native `trivy.exe`, cache on D:) for CVE scans; `crane copy` (daemon-free) for digest-preserving re-host into Artifact Registry.
- **Phasing:** build **Phase 1 (secure MVP, no AI)** first — hard gates + manual queue; `scanning` pass routes to `pending_review` for human approve/reject. Phase 2 (the AI auto-approve/triage) is a follow-up; leave clean seams for it but don't build it now.

## First actions

1. Read the spec + `CLAUDE.md` + `tasks/lessons.md`.
2. Skim the touchpoint files to ground the plan in real APIs.
3. Invoke `superpowers:writing-plans` → produce a Phase-1 TDD plan (data model → store → hardGates → imageScanner → reHoster → reviewOrchestrator → manualReviewQueue → publish API + canPublish → first-publish tutorial), each step with its failing test.
4. Check the plan in with the user before implementing.

## Definition of done (Phase 1)

A publisher (passing `canPublish`) can submit `{image ref + manifest}`; it runs the hard gates + trivy scan; a clean submission lands in a `pending_review` admin queue; an admin approves → we `crane copy` the image into AR by digest → the version flips to `published` with the AR digest and appears in the marketplace; rejection records reasons; an update re-runs the full gate while the old digest stays live; the first-publish tutorial shows once. Every security invariant above has a passing test, and the full programs test suite is green.
