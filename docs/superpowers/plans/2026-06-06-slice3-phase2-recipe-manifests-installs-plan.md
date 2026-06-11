# Slice 3 Phase 2 — Recipe Manifests & Persisted Installs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phase-1's ad-hoc command launch into a manifest-driven **install → launch** flow: read a workspace recipe (`synthi.program.json`, or an imported `devcontainer.json`), record a persisted `ProgramInstall`, gate it behind a `PermissionGrant` carrying the manifest's declared scopes, and launch from the install through the existing Phase-1 runtime.

**Architecture:** A pure manifest layer (parse/validate `synthi.program.json`; map a documented `devcontainer.json` subset to the same normalized shape) feeds new store helpers (local `MarketplaceProgram`/`ProgramVersion`/`ProgramInstall` rows, workspace-scoped, `publisher='local'`). Install/launch orchestration reuses the Phase-1 `ProgramRuntimeManager` (scrubbed env, output caps, idle cull, kill switch) — Phase 2 treats a manifest as a **recipe of managed commands**, not as a container runtime (rootless container isolation stays in later phases). Next.js routes expose marketplace(local)/installed/install/launch with owner-admin write + member read, consent recorded as `PermissionGrant`. The Programs sidebar gains an Installed section, an install-from-manifest action, and a consent prompt.

**Tech Stack:** Next.js 15 App Router (`synthi/`), Prisma/Postgres (models already present from C2), Vitest (frontend + lib), Node `--test` (collab-server), Redux docking-wm, React Testing Library.

**Branch:** `tool-compatibility` only (standing constraint — do NOT branch, merge, or finish the branch).

**Disk gate:** TDD-only. Do NOT run `next build` / `docker build` / `docker compose build` during Phase 2 (vitest / `node --test` / `prisma generate` / `prisma db push` only). No schema changes are expected (the six models already exist), so `prisma db push` should report "already in sync".

---

## Locked decisions (carried + Phase-2 specific)

- **R-1** (locked): `synthi.program.json` is the Synthi superset; Phase 2 also **detects/imports `devcontainer.json`**. Document the mapping; devcontainer projects are not second-class.
- **R-3** (done in Phase 1): docking dedupe respects per-panel `allowMultiple`. No change needed.
- **R-4** (locked): Programs stays a separate labeled surface; no "Extend Synthi" hub.
- **D1 — Manifest source = the workspace itself.** Phase 2 installs from a manifest **inside the workspace** (`synthi.program.json` at the workspace root, or `.devcontainer/devcontainer.json`). It does NOT fetch a remote catalog — `MarketplaceProgram`/`ProgramVersion` rows are created **locally** (`publisher='local'`, `verified=false`) to represent the workspace-local program. Remote publishing/browse is Phase 5.
- **D2 — devcontainer is imported as a recipe of commands, not a container.** Phase 2 maps a documented subset to the normalized config and runs install/launch commands through the existing managed-PTY runtime. `image`/`build` are recorded as informational hints only (not executed as a container). Host-escaping keys are **rejected** (see Task 2). Full rootless container isolation is a later phase.
- **D3 — Consent carries manifest scopes.** Install requires a `PermissionGrant` whose `scopesJson` is the manifest's declared `permissions` (not just `program.launch`). This activates the scope-match the C7 note flagged as a forward item.
- **D4 — Authz mirrors Phase 1.** install / launch / stop / restart require `WorkspaceMembership.role ∈ {owner, admin}`; marketplace(local) / installed / running / recent reads are member-level.

## Required security invariants (test every task that touches them)

- Child-process env stays scrubbed (denylist from `programRuntimeManager.js`); a manifest/devcontainer **cannot reintroduce** a blocked platform/DB/GCS/K8s var via declared `env`.
- No host Docker socket exposure; devcontainer `mounts`/`runArgs` that reference the host or `docker.sock`, `privileged`, or `features` requiring host access are **rejected** at import.
- `workingDir` and any manifest path stay **inside the workspace** (no `..`, no absolute paths) — path-traversal rejected.
- Consent recorded as `PermissionGrant` before first install; install/launch gated on owner/admin.
- Persisted rows + event payloads store only redacted public metadata (no raw env values, no secrets). Secrets (none expected in Phase-2 manifests) would go through `EncryptedSecret`, never plain columns.

## Explicit non-goals (Phase 2)

- No remote marketplace browse/publish/signing/reputation (Phase 5).
- No real container build/run or rootless sidecar (later phase) — manifests run as managed commands.
- No web-port auto-detection (Phase 3) — Phase 2 uses **declared** `ports` only.
- No GUI broker generalization (Phase 4).

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/src/lib/programs/manifest.js` | Pure parse/validate/normalize of `synthi.program.json` → `NormalizedProgramConfig` | Create |
| `synthi/src/lib/programs/devcontainer.js` | Pure map of a documented `devcontainer.json` subset → `NormalizedProgramConfig`; reject host-escaping keys | Create |
| `synthi/src/lib/programs/store.js` | Add local-program upsert + install CRUD helpers (alongside existing session/grant/event helpers) | Modify |
| `synthi/src/lib/programs/runtimeClient.js` | Add manifest-discovery + install/launch-from-install orchestration over the collab manager | Modify |
| `backend/collab-server/programRuntimeManager.js` | Accept an install/launch config (multi-command install, declared ports) reusing existing primitives | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js` | `GET` local programs (workspace-scoped) | Create |
| `synthi/src/app/api/workspace/[slug]/programs/installed/route.js` | `GET` installs (member read) | Create |
| `synthi/src/app/api/workspace/[slug]/programs/install/route.js` | `POST` install-from-manifest (owner/admin, consent) | Create |
| `synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js` | `POST` launch from install (owner/admin) | Create |
| `synthi/src/components/programs/ProgramsPanel.jsx` | Add Installed section + install-from-manifest action + consent prompt + launch-from-install | Modify |
| Test files (per task) | TDD coverage | Create |

### `NormalizedProgramConfig` contract (produced by Task 1 and Task 2; consumed by 3/4/5/6)

```js
/**
 * @typedef {Object} NormalizedProgramConfig
 * @property {string}   packageId    // slug, [a-z0-9][a-z0-9._-]{0,63}; unique within workspace
 * @property {string}   version      // non-empty string (semver-ish, not validated as strict semver)
 * @property {string}   displayName  // human label; defaults to packageId
 * @property {('web'|'cli'|'tui'|'background')} runtimeType  // Phase 2 set; 'gui' deferred to Phase 4
 * @property {string}   workingDir   // relative to workspace root; '' = root; no '..' / absolute
 * @property {string[]} install      // shell commands run in order before first launch (may be empty)
 * @property {string}   launch       // required non-empty launch command
 * @property {Object<string,string>} env  // declared env (merged then scrubbed at runtime)
 * @property {number[]} ports        // declared web ports, ints 1..65535
 * @property {string[]} surfaces     // subset of ['app','logs','terminal','ports','health','settings']
 * @property {({type:string,target:string,intervalMs:number}|null)} health
 * @property {string[]} permissions  // declared scopes, subset of KNOWN_SCOPES (see below)
 * @property {('synthi.program.json'|'devcontainer.json')} source
 * @property {Object}   sourceHints  // { containerImage?, containerBuild? } informational only (devcontainer)
 */
```

`KNOWN_SCOPES = ['program.launch','workspace.files.read','workspace.files.write','network.outbound','ports.expose']`. `program.launch` is always implied/added. Unknown scopes → validation error (fail-closed). Validation throws `ProgramManifestError` with `{ code, message, field }`.

---

## Task 1 — `synthi.program.json` manifest parser/validator

**Files:**
- Create: `synthi/src/lib/programs/manifest.js`
- Test: `synthi/src/lib/programs/__tests__/manifest.test.js`

- [ ] **Step 1: Write failing tests.** Cover: (a) a full valid manifest normalizes to `NormalizedProgramConfig` with all fields; (b) minimal manifest (`packageId`,`version`,`launch` only) fills defaults (`runtimeType:'cli'`, `workingDir:''`, `install:[]`, `env:{}`, `ports:[]`, `surfaces` default, `permissions:['program.launch']`, `health:null`); (c) missing `launch` → throws `ProgramManifestError` code `missing_field` field `launch`; (d) bad `packageId` (uppercase / `../x` / spaces) → `invalid_field`; (e) `workingDir:'../escape'` or absolute → `path_escape`; (f) unknown permission scope → `unknown_scope`; (g) port out of range / non-int → `invalid_port`; (h) `runtimeType:'gui'` → `unsupported_runtime` (Phase 4); (i) `program.launch` auto-added if omitted.
- [ ] **Step 2: Run red.** `cd synthi && npx vitest run src/lib/programs/__tests__/manifest.test.js` → FAIL (module/export missing).
- [ ] **Step 3: Implement `manifest.js`.** Export `KNOWN_SCOPES`, `ProgramManifestError`, `parseProgramManifest(objOrJsonText) → NormalizedProgramConfig`. Pure, no IO. Strict allow-list validation; trim/normalize; dedupe ports/permissions; clamp `surfaces` to the allowed set; `source:'synthi.program.json'`.
- [ ] **Step 4: Run green.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add synthi/src/lib/programs/manifest.js synthi/src/lib/programs/__tests__/manifest.test.js` → `feat(slice3-p2): synthi.program.json manifest parser/validator` (+ Co-Authored-By trailer).

**Security fold:** assert path-escape and unknown-scope rejection are covered by tests (above).
**Validation gate:** `cd synthi && npx vitest run src/lib/programs`.

---

## Task 2 — devcontainer import mapper

**Files:**
- Create: `synthi/src/lib/programs/devcontainer.js`
- Test: `synthi/src/lib/programs/__tests__/devcontainer.test.js`

Mapping (documented subset → `NormalizedProgramConfig`, then run through the same normalizer as Task 1 so all invariants hold):

| devcontainer key | Normalized field |
|---|---|
| `name` | `displayName` + slugified `packageId` (fallback `'devcontainer'`) |
| `image` | `sourceHints.containerImage` (informational only) |
| `build.dockerfile` | `sourceHints.containerBuild` (informational only) |
| `onCreateCommand`,`updateContentCommand`,`postCreateCommand` | `install[]` (in that order; string or array forms) |
| `postStartCommand` | `launch` (string/array joined); if absent → `launch='sleep infinity'` background keep-alive |
| `forwardPorts` | `ports[]` (ints) → `runtimeType:'web'` if non-empty else `'cli'` |
| `containerEnv`,`remoteEnv` | `env` (string values only) |
| `workspaceFolder` | `workingDir` (must resolve inside workspace) |

**Rejected (throws `ProgramManifestError` code `host_escape`):** any of `mounts`, `runArgs` containing `--privileged`/`--security-opt`/`-v` host paths/`/var/run/docker.sock`, `privileged:true`, `features` requiring host (`docker-in-docker`, `docker-outside-of-docker`, `sshd` with host mount). `env` values matching the runtime denylist prefixes → stripped + flagged (not silently kept).

- [ ] **Step 1: Write failing tests.** (a) `image` + `forwardPorts:[3000]` + `postCreateCommand`/`postStartCommand` → `runtimeType:'web'`, `ports:[3000]`, `install` from postCreate, `launch` from postStart, `sourceHints.containerImage` set, `source:'devcontainer.json'`; (b) array-form commands flatten; (c) no `postStartCommand` → `launch:'sleep infinity'`, `runtimeType:'background'` when no ports; (d) `mounts:['type=bind,source=/var/run/docker.sock,...']` → throws `host_escape`; (e) `runArgs:['--privileged']` → `host_escape`; (f) `containerEnv:{DATABASE_URL:'...'}` → stripped + flagged in result `.strippedEnvKeys`; (g) `workspaceFolder:'/etc'` (outside) → `path_escape`.
- [ ] **Step 2: Run red.** `cd synthi && npx vitest run src/lib/programs/__tests__/devcontainer.test.js` → FAIL.
- [ ] **Step 3: Implement `devcontainer.js`.** Export `importDevcontainer(objOrJsonText, { workspaceRoot? }) → { config: NormalizedProgramConfig, strippedEnvKeys: string[], warnings: string[] }`. Reuse `parseProgramManifest`'s normalizer/validators (import the shared validators from `manifest.js`; refactor those into exported helpers if needed) so traversal/scope/port rules are identical.
- [ ] **Step 4: Run green.** PASS.
- [ ] **Step 5: Commit.** `git add synthi/src/lib/programs/devcontainer.js synthi/src/lib/programs/__tests__/devcontainer.test.js` (+ any shared-helper export in `manifest.js`) → `feat(slice3-p2): devcontainer.json import mapper (documented subset)`.

**Security fold:** host-escape rejection + env-stripping covered by tests (d/e/f).
**Validation gate:** `cd synthi && npx vitest run src/lib/programs`.

---

## Task 3 — Local program + install store helpers

**Files:**
- Modify: `synthi/src/lib/programs/store.js`
- Test: `synthi/src/lib/programs/__tests__/store.test.js` (extend existing)

Add helpers (no schema change — models exist from C2):
- `upsertLocalProgram({ workspaceSlug, config }) → { program, version }` — find-or-create `MarketplaceProgram` by `packageId` (namespaced `local:${workspaceSlug}:${config.packageId}` to keep the unique index workspace-scoped), `publisher:'local'`, `verified:false`, `latestVersion=config.version`; upsert `ProgramVersion` (`@@unique([programId,version])`) with `manifestJson=JSON.stringify(config)`, `requiredTools`, `ports`(as strings).
- `createInstall({ programId, workspaceSlug, version, installedByUserId, grantId }) → install` (status `'installing'`).
- `updateInstallStatus(installId, status) → install`.
- `getInstall(installId)` / `listInstalls(workspaceSlug)` (newest first, includes program).
- `toPublicInstall(row)` — public metadata only (id, packageId/displayName via joined program, version, status, timestamps, grantId); never returns manifest secrets/raw env.

- [ ] **Step 1: Write failing tests.** upsertLocalProgram creates then updates the same program/version idempotently; createInstall + status transitions (`installing→installed→failed`); listInstalls returns workspace-scoped newest-first with program join; toPublicInstall omits raw manifest env.
- [ ] **Step 2: Run red.** `cd synthi && npx vitest run src/lib/programs/__tests__/store.test.js` → FAIL.
- [ ] **Step 3: Implement helpers** in `store.js`.
- [ ] **Step 4: Run green.** `cd synthi && npx prisma generate` (no schema change), then the vitest command → PASS.
- [ ] **Step 5: Commit.** `git add synthi/src/lib/programs/store.js synthi/src/lib/programs/__tests__/store.test.js` → `feat(slice3-p2): local program + install store helpers`.

**Security fold:** `toPublicInstall` redaction test (env never surfaced).
**Validation gate:** `cd synthi && npx prisma generate && npx vitest run src/lib/programs`.

---

## Task 4 — Manifest discovery + install/launch orchestration

**Files:**
- Modify: `synthi/src/lib/programs/runtimeClient.js`
- Modify: `backend/collab-server/programRuntimeManager.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js` (extend)
- Test: `synthi/src/lib/programs/__tests__/runtimeClient.test.js` (create, mocked fetch)

Behavior:
- `runtimeClient`: `discoverManifest(slug) → { config, source } | null` — asks collab-server (or reads via the existing workspace FS path used by Phase-1) for `synthi.program.json` then `.devcontainer/devcontainer.json`; runs the bytes through Task 1/2 parsers. `launchFromInstall({ slug, installId, config, sessionId })` — posts install+launch config to the manager.
- `programRuntimeManager`: extend the existing launch entry to accept `{ install: string[], launch, env, ports, workingDir, runtimeType }`; run install commands sequentially as managed steps (scrubbed env, output caps, append `ProgramRuntimeEvent` per step), then launch via the existing `createHeadlessSession` path; surface declared `ports` in the session port snapshot.

- [ ] **Step 1: Write failing tests.** Manager: given an install config, runs install steps in order then launches; install-step failure marks session `crashed` and does not launch; declared env still passes through the **scrub** (a blocked key in config env is absent from the spawned env); declared ports appear in the snapshot. runtimeClient: discoverManifest prefers `synthi.program.json`, falls back to devcontainer, returns null when neither; parser errors propagate as structured errors.
- [ ] **Step 2: Run red.** `node --test backend/collab-server/__tests__/programRuntimeManager.test.js` and `cd synthi && npx vitest run src/lib/programs/__tests__/runtimeClient.test.js` → FAIL.
- [ ] **Step 3: Implement** the manager extension + runtimeClient functions (smallest change reusing Phase-1 primitives).
- [ ] **Step 4: Run green.** Both commands → PASS; re-run full `node --test ...programRuntimeManager.test.js` (Phase-1 6 + new) green.
- [ ] **Step 5: Commit.** `git add backend/collab-server/programRuntimeManager.js synthi/src/lib/programs/runtimeClient.js synthi/src/lib/programs/__tests__/runtimeClient.test.js backend/collab-server/__tests__/programRuntimeManager.test.js` → `feat(slice3-p2): manifest discovery + install/launch orchestration`.

**Security fold:** the "blocked key in config env is scrubbed from spawned env" test is the core invariant — must be present and green.
**Validation gate:** `node --test backend/collab-server/__tests__/programRuntimeManager.test.js` + `cd synthi && npx vitest run src/lib/programs`.

---

## Task 5 — Next.js program install/launch API routes

**Files:**
- Create: `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js` (GET — local programs)
- Create: `synthi/src/app/api/workspace/[slug]/programs/installed/route.js` (GET — installs)
- Create: `synthi/src/app/api/workspace/[slug]/programs/install/route.js` (POST — install-from-manifest)
- Create: `synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js` (POST — launch from install)
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

Reuse the Phase-1 program-sessions route helpers (`resolveActor()`, scope/role helpers, redaction). Contracts:
- `GET .../programs/marketplace` → member; `{ programs: [...local programs] }`.
- `GET .../programs/installed` → member; `{ installs: [toPublicInstall...] }`.
- `POST .../programs/install` → owner/admin; body `{ source?: 'auto'|'synthi'|'devcontainer', grantScopes?: string[] }`. Discovers manifest, requires consent: if no matching `PermissionGrant` for the manifest's `permissions` → `409 { code:'consent_required', requested: config.permissions }`; if `grantScopes` provided and ⊇ `config.permissions` → create grant + upsert program/version + createInstall (`installed`). Returns `{ install, program, grant }`.
- `POST .../programs/[installId]/launch` → owner/admin; creates a `ProgramSession` from the install's manifest and launches via Task 4. Returns `{ session }`.

- [ ] **Step 1: Write failing tests.** owner installs with consent → 200 + install row; member install → 403; install without consent → 409 `consent_required` listing requested scopes; consent grant scope-match (grant lacking a requested scope → still 409); owner launch from install → 200 `{session}` with manifest launch config; member launch → 403; member reads installed/marketplace → 200.
- [ ] **Step 2: Run red.** `cd synthi && npx vitest run src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` → FAIL.
- [ ] **Step 3: Implement** the four routes against the store + runtimeClient.
- [ ] **Step 4: Run green.** `cd synthi && npx vitest run src/app/api/workspace` → PASS (Phase-1 program-sessions tests stay green).
- [ ] **Step 5: Commit.** `git add synthi/src/app/api/workspace/[slug]/programs` → `feat(slice3-p2): program install/launch API routes (consent + role gated)`.

**Security fold:** consent-required + scope-match + member-write-denied tests are mandatory.
**Validation gate:** `cd synthi && npx vitest run src/app/api/workspace`.

---

## Task 6 — Programs sidebar: Installed + install-from-manifest + consent

**Files:**
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` (create)

UI (additive to Phase-1 panel; keep Launch Command / Running / Recent):
- New **Installed** section listing installs (packageId, version, status) with a per-install **Launch** button (owner/admin only).
- **Install from manifest** action: triggers discovery; if `409 consent_required`, show a **consent prompt** listing the requested permission scopes with Approve/Cancel; Approve re-posts with `grantScopes`.
- Member view: Installed/Running/Recent read-only; no Launch/Install controls; no raw env echoed.

- [ ] **Step 1: Write failing tests.** Install action → consent prompt renders requested scopes; Approve re-posts with grantScopes and shows the new install; Launch on an install calls the launch endpoint and opens/focuses the session tab; member role hides Install/Launch controls.
- [ ] **Step 2: Run red.** `cd synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx` → FAIL.
- [ ] **Step 3: Implement** the Installed section + consent prompt + install/launch wiring.
- [ ] **Step 4: Run green.** `cd synthi && npx vitest run src/components/programs` → PASS.
- [ ] **Step 5: Commit.** `git add synthi/src/components/programs/ProgramsPanel.jsx synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` → `feat(slice3-p2): Programs sidebar install-from-manifest + consent`.

**Security fold:** member-cannot-install/launch + no-env-echo tests.
**Validation gate:** `cd synthi && npx vitest run src/components/programs`.

---

## Task 7 — Phase-2 regression + security sweep

**Files:** none (verification + `tasks/todo.md` review section).

- [ ] **Step 1: Schema sanity.** `cd synthi && npx prisma generate` then `npx prisma db push` → expect "already in sync" (no Phase-2 schema change).
- [ ] **Step 2: Targeted suites.** `cd synthi && npx vitest run src/lib/programs src/app/api/workspace src/components/programs src/components/docking-wm`.
- [ ] **Step 3: Backend.** `node --test backend/collab-server/__tests__/programRuntimeManager.test.js`.
- [ ] **Step 4: Full regression.** `cd synthi && npx vitest run` — accept only the known pre-existing empty `src/lib/__tests__/preview-store.test.js` stub failure.
- [ ] **Step 5: Security checklist (each verified by a test that already exists from Tasks 1–6):**
  - manifest path-traversal rejected (T1)
  - unknown permission scope rejected (T1)
  - devcontainer host mount / docker.sock / privileged rejected (T2)
  - declared env cannot reintroduce a blocked platform var into the spawned process (T4)
  - install/launch require owner/admin; consent recorded as `PermissionGrant` with manifest scopes (T5)
  - no raw env echoed in API responses or UI (T3/T5/T6)
- [ ] **Step 6: Document.** Update `tasks/todo.md` with the Phase-2 review section; capture any corrections in `tasks/lessons.md`.

**Validation gate:** the full bundle above green (only the known stub tolerated).

---

## Execution loop (per task)

1. Write/expand the failing targeted tests first; run them red.
2. Implement the smallest slice that turns them green.
3. Run the focused validation gate immediately.
4. Spec-review / quality-review pass.
5. Commit on `tool-compatibility`, specific staged files only, with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Self-review (against the spec)

- **Spec coverage:** §Rollout Phase 2 ("recipe install/launch manifests `synthi.program.json` + devcontainer import + persisted installs") → Tasks 1–6. §Public interfaces `marketplace/installed/install/:installId/launch` → Task 5. §Security (scrubbed env, no host docker sock, consent→PermissionGrant, redaction) → folds in T1/T2/T4/T5 + T7 checklist. R-1 → T1+T2. Persisted installs → T3. ✅ no gaps for Phase-2 scope (Phase 3–5 explicitly out).
- **Type consistency:** `NormalizedProgramConfig` shape is defined once and consumed identically by T1/T2 (producers) and T3/T4/T5/T6 (consumers); `toPublicInstall` is defined in T3 and used in T5/T6; manager launch config keys (`install`,`launch`,`env`,`ports`,`workingDir`,`runtimeType`) match T4 and T5.
- **Placeholder scan:** no TBD/"handle edge cases"; every task has concrete files, contracts, and validation gates.
