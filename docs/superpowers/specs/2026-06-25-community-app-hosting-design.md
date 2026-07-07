# Community-App Hosting — Submission & Hybrid Review Gate (Design)

- **Date:** 2026-06-25
- **Status:** Draft for review
- **Branch:** `feat/docker-sysbox-engine`
- **Scope:** Sub-system 1 of the community-app hosting platform — **submission + the review gate**. (Build-from-source, the paywall, and runtime hardening are explicitly out of scope here — see "Out of scope".)

## Problem

Publishing today (`store.publishProgram`) just lists a **manifest** in the marketplace; installing copies the recipe — nothing runs hosted. The product goal is for a **published community app to actually run, hosted, inside any installer's workspace** — exactly like the built-in DBeaver/Postman. That requires:

1. getting the app's artifact into a registry installers can pull,
2. guaranteeing **what installers run is exactly what we reviewed**, and
3. a review gate that keeps malicious/broken apps out of the marketplace — on first publish **and on every update**.

The runtime/sandbox is largely reuse: installers run the pinned image via the existing install/launch path inside their per-workspace **Sysbox runtime** (the same place DBeaver/Postman run as inner containers). So this spec focuses on submission + the gate.

## Decisions (locked)

- **Submission = re-host by digest.** Publishers bring a **pre-built, pullable image in their own registry**. After approval we `crane copy` it into our Artifact Registry, pinned by **digest**; the published manifest references that digest. (Command-based web/CLI/TUI apps are also supported — gated by reviewing their manifest/commands — with no image and no re-host.)
- **Integrity: reviewed == installed.** Installers always pull our AR digest, never the publisher's mutable tag (prevents review-then-swap).
- **Hybrid review gate, built secure-base-first.** Automated **hard gates (fail-closed)** + a **manual accept/reject queue** ship first (Phase 1). The **AI auto-approve/triage** layer is added on top once there are real submissions to calibrate against (Phase 2). The AI is never a load-bearing security control on day one.
- **Strict on publish AND update.** Every new version/digest re-runs the full gate. The live listing keeps serving the **last-approved digest** until the new one reaches `published` (no live downgrade, no auto-trust of updates).
- **Sandbox is the real containment.** Static review of a re-hosted image is limited (it can't fully vet runtime behaviour). Actual safety comes from the installer's **Sysbox isolation + egress cap + the digest-pin + publisher accountability**. The gate is defense-in-depth: CVE/scope control + an obvious-malice filter. This must be stated honestly in code comments and product copy — it is not a guarantee.
- **Entitlement hook.** Every publish entry point goes through a single `canPublish(user)` check (returns `true` now; a plan/paywall check slots in later — implementation out of scope).
- **First-publish tutorial.** A guided overlay shown the first time a user opens the publish flow.

## State machine (per `ProgramVersion`)

```
submitted
  → scanning            (hard gates: schema, scope/host-escape, CVE, metadata)
      ├─ hard-gate fail → rejected (with reasons)
      └─ pass → ai_review*                       (* Phase 2 only)
              ├─ low risk + no sensitive scopes → approved → rehosting → published
              └─ else                            → pending_review (manual)
pending_review (manual queue)
  ├─ admin approve → approved → rehosting → published
  └─ admin reject  → rejected (with notes)
```

- **Phase 1** (no AI): `scanning` pass → `pending_review` (everything human-approved).
- **Update:** a new version enters at `submitted`; the previously `published` version stays live until the new one reaches `published`.

## Components (isolated, independently testable units)

1. **`submissionStore`** — Prisma CRUD + state transitions for versions; writes an audit event per transition.
2. **`hardGates`** — pure, fail-closed validators: manifest schema (reuse `parseProgramManifest`), scope allow-list + host-escape rejection (reuse `devcontainer.js` rules — no `docker.sock`, host mounts, `privileged`, `--cap-add`, `--security-opt`, `--device`), metadata sanity (image size cap, exposed ports ⊆ manifest ports, entrypoint present).
3. **`imageScanner`** — trivy wrapper: scan the publisher's image **by digest** → CVE report; fail above a configurable severity/count threshold. (Host-native `trivy.exe` per lesson #28 locally; a trivy step in prod CI/CD.)
4. **`aiReviewer`** *(Phase 2)* — LLM risk review over `{manifest, image metadata, publisher description}` → `{riskScore, flags[], rationale}`. Calls the ai-backend.
5. **`reHoster`** — `crane copy <src@digest> <AR-target>` (daemon-free, lesson #27) → returns the pinned AR digest. Re-host happens **only** on `approved → rehosting`.
6. **`reviewOrchestrator`** — drives the state machine: hard gates → (AI) → decide → re-host on approval → publish. Idempotent/resumable; each transition writes an audit event.
7. **`manualReviewQueue`** — admin API + a minimal UI: list `pending_review` with scan + (AI) context → approve/reject with notes.
8. **Publish API routes** — `submit` (canPublish + owner/admin), `status`, admin review actions (admin-only).
9. **`canPublish(user)`** — entitlement hook (returns `true`; paywall later).
10. **First-publish tutorial** — a frontend overlay keyed on a per-user "has published before" flag: what to bring (a pullable image + manifest), the review steps, what we check, and expected timelines, ending in the publish CTA.

## Data model (Prisma)

Extend **`ProgramVersion`** (it is already the per-version unit) with review fields rather than adding a parallel submission entity:

- `reviewState` (enum: `submitted|scanning|ai_review|pending_review|approved|rehosting|published|rejected`)
- `sourceImageRef`, `sourceImageDigest`, `hostedImageDigest` (our AR)
- `scanReportJson`, `aiRiskJson` (nullable)
- `submittedByUserId`, `reviewedByUserId?`, `reviewNotes?`, timestamps

Add **`ProgramReviewEvent`** (audit): `versionId`, `fromState`, `toState`, `actorUserId?`, `reasonJson`, `createdAt`. The marketplace listing (`fetchMarketplace`) shows **only** versions in `published` state.

## Security invariants (each pinned by a test)

- Hard gates **fail-closed**: invalid schema / over-broad scope / host-escape / over-threshold CVE / metadata mismatch → `rejected`, never `published`.
- Host-escape denied: `docker.sock`, host bind mounts, `privileged`, `--cap-add`, `--security-opt`, `--device` (reuse `devcontainer.js`).
- Re-host pins by **digest**; the published manifest references the AR digest; installers never receive the publisher's tag.
- Update re-runs the full gate; the previously-approved digest stays live until the new one is approved.
- Manual review is **admin-only**; a publisher cannot approve their own submission.
- `canPublish` gates **every** submit path (UI + API + MCP).
- Stored scan/AI reports are redacted of secrets in public/member responses (allow-list serialization, like `toPublicInstall`).

## Reuse / touchpoints

- `synthi/src/lib/programs/manifest.js` (schema + host-escape), `devcontainer.js` (host-escape rules), `store.js` (publish/marketplace/version CRUD), `prisma/schema.prisma` (`MarketplaceProgram`, `ProgramVersion`).
- trivy (lesson #28), `crane copy` (lesson #27).
- ai-backend for `aiReviewer` (Phase 2).
- Existing install/launch (`programs/[installId]/launch`) — **unchanged**; it runs whatever digest the published manifest references.

## Out of scope (separate specs / later)

- The paywall/plan entitlement implementation (only the `canPublish` hook lives here).
- **Build-from-source** (Phase 1 re-hosts pre-built images only).
- Runtime/sandbox hardening beyond what exists (the installer's Sysbox runtime already isolates + egress-caps).

## Phasing

- **Phase 1 (secure MVP):** `submissionStore` + `hardGates` + `imageScanner` + `reHoster` + `reviewOrchestrator` (no AI) + `manualReviewQueue` + publish API + `canPublish` hook + first-publish tutorial. `scanning` pass → `pending_review` (all human-approved).
- **Phase 2:** add `aiReviewer` + the auto-approve/auto-reject/triage decision; calibrate thresholds on real submissions.
