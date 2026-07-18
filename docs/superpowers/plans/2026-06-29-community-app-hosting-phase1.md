# Community-App Hosting — Phase 1 (Submission + Hybrid Review Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a published community app actually run hosted in any installer's workspace by inserting a fail-closed review gate (automated hard gates + trivy scan + manual admin queue) between submit and marketplace listing, and re-hosting the approved image into our Artifact Registry pinned by digest.

**Architecture:** A publisher's workspace recipe (manifest, via the existing `discoverManifest`) plus a publisher-supplied `sourceImageRef` is submitted as a new `ProgramVersion` in `reviewState='submitted'`. A pure `reviewOrchestrator` drives the state machine: `hardGates` (schema/scope/host-escape/metadata, reusing `parseProgramManifest` + a shared host-escape ruleset) → `imageScanner` (trivy by digest) → `pending_review`. A platform admin approves via an admin-only API; on approval `reHoster` (`crane copy`) pins the image into AR by digest, the manifest's image token is rewritten to that digest, and the version flips to `published`. The marketplace only lists programs that have a live (`published`) version; the last-approved digest stays live until a new version is approved. Every transition writes a `ProgramReviewEvent` audit row.

**Tech Stack:** Next.js (App Router) API routes, Prisma/Postgres, vitest (frontend, run from `synthi/` with temp on D:), host-native `trivy.exe` + `crane` (both mocked in tests), React for the first-publish tutorial overlay.

---

## Design decisions / assumptions (confirm at check-in)

These are the choices the spec left to implementation. Each is the smallest defensible reading; flagged so the user can redirect before any code is written.

- **D1 — Manifest source = `discoverManifest` (workspace recipe); `sourceImageRef` comes from the request body.** This reuses the existing publish plumbing maximally (smallest diff). The DoD's "submit `{image ref + manifest}`" is satisfied: the manifest is the publisher's discovered workspace recipe, the image ref is the body field. *Alternative:* accept the manifest JSON inline in the body. Easy to switch — only the submit route's input handling changes.
- **D2 — Platform admin = env allow-list `PLATFORM_ADMIN_EMAILS`** (comma-separated, matched against `actor.email`). No new schema, fail-closed (unset ⇒ nobody is admin). Mirrors the single-function `canPublish` hook. *Alternative:* a `User.isAdmin` column (schema churn, deferred).
- **D3 — First-publish "seen" flag = `localStorage`** keyed per user. It's a one-time UX overlay; client-side state is the minimal MVP and needs no new endpoint/column. *Alternative:* derive "has published before" server-side from the user's submission history.
- **D4 — `submissionStore` = new functions added to the existing `store.js`** (not a separate module). They operate on the same `MarketplaceProgram`/`ProgramVersion` models and follow the existing `toPublic*` allow-list pattern; the orchestrator imports them. This matches the mission's "reuse `store.js` patterns".
- **D5 — Admin review routes live under `/api/admin/program-reviews/**`**, not `/api/workspace/[slug]/**`, because the queue is cross-workspace moderation (platform-scoped, not workspace-scoped).
- **D6 — The hard gate applies to community submissions only.** The built-in `@vectant/*` catalog (e.g. `portainer`, which legitimately mounts `docker.sock`) bypasses the gate — it is first-party/trusted and never flows through submit.

---

## File structure

**New library modules** (`synthi/src/lib/programs/`):
- `hostEscape.js` — shared, exported host-escape ruleset (regex token list + `findCommandHostEscape(text)`). Source of truth reused by `devcontainer.js` and `hardGates.js`.
- `hardGates.js` — pure, fail-closed `runHardGates({ config, sourceImageRef })` → `{ ok, reasons[] }`. Reuses `parseProgramManifest` + `hostEscape`.
- `imageScanner.js` — `scanImage(imageRef, opts)` → `{ ok, summary }`. trivy wrapper; the exec runner is injectable so tests never shell out.
- `reHoster.js` — `reHostImage(sourceImageRef, target)` → `{ digest, ref }` via `crane copy`/`crane digest`; `communityImageTarget({ publisher, packageId })`; `pinManifestImage(config, srcRef, arRef)` pure substitution. Exec runner injectable.
- `entitlements.js` — `canPublish(actor)` (returns `true`) + `isPlatformAdmin(actor)` (env allow-list).
- `reviewOrchestrator.js` — `submitForReview(...)`, `approveSubmission(...)`, `rejectSubmission(...)`. Drives the state machine; deps injected for testability.

**Modified library modules:**
- `synthi/src/lib/programs/devcontainer.js` — refactor `assertNoHostEscape` to consume `hostEscape.js` tokens (behavior-preserving; devcontainer tests are the safety net).
- `synthi/src/lib/programs/store.js` — add submission/review CRUD + audit (`createSubmission`, `getReviewVersionById`, `listPendingReview`, `transitionReview`, `publishApprovedVersion`, `toReviewQueueItem`); gate `listPublishedPrograms`/`getPublishedProgramVersion` on the live `published` version.
- `synthi/prisma/schema.prisma` — extend `ProgramVersion` + `MarketplaceProgram`; add `ProgramReviewEvent`.

**New API routes:**
- `synthi/src/app/api/workspace/[slug]/programs/publish/route.js` — repurpose POST to submit-through-orchestrator (canPublish-gated).
- `synthi/src/app/api/workspace/[slug]/programs/submissions/route.js` — GET the caller's submissions (status), redacted.
- `synthi/src/app/api/admin/program-reviews/route.js` — GET pending queue (platform-admin only).
- `synthi/src/app/api/admin/program-reviews/[versionId]/route.js` — POST approve/reject (platform-admin only; not the submitter).

**New frontend:**
- `synthi/src/components/programs/FirstPublishTutorial.jsx` — one-time overlay (localStorage-gated).

**Test files** (each beside its module under `__tests__/`):
- `lib/programs/__tests__/hostEscape.test.js`, `hardGates.test.js`, `imageScanner.test.js`, `reHoster.test.js`, `entitlements.test.js`, `reviewOrchestrator.test.js`
- extend `lib/programs/__tests__/store.test.js`
- `app/api/admin/program-reviews/__tests__/adminReviewRoutes.test.js`
- extend `app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`
- `components/programs/__tests__/firstPublishTutorial.test.jsx`

**Test command (this box — disk-pressured C:):**
```
cd synthi
$env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'
npx vitest run <substring-filter> --pool=forks --no-file-parallelism --maxWorkers=1
```
Filter by a bracket-free substring (e.g. `hardGates`, `reviewOrchestrator`, `programRoutes`, `adminReviewRoutes`), never a `[slug]` path.

---

## Task 1: Data model — review fields + audit table

**Files:**
- Modify: `synthi/prisma/schema.prisma` (`MarketplaceProgram` ~166-183, `ProgramVersion` ~185-198; add `ProgramReviewEvent`)

- [ ] **Step 1: Extend `ProgramVersion` with review fields**

In `model ProgramVersion`, add after `ports`:

```prisma
model ProgramVersion {
  id            String   @id @default(cuid())
  programId     String
  version       String
  manifestJson  String
  requiredTools String[] @default([])
  ports         String[] @default([])

  // ── Community-app review gate (Phase 1) ──
  // State machine: submitted|scanning|ai_review|pending_review|approved|rehosting|published|rejected.
  // Built-in/legacy direct-published versions default to 'published'.
  reviewState       String   @default("published")
  sourceImageRef    String?  // publisher's pullable ref (their registry), container/gui only
  sourceImageDigest String?  // resolved digest of the source ref at scan time
  hostedImageDigest String?  // our AR digest after re-host (what installers pull)
  scanReportJson    String?  // redacted trivy summary (severity counts + decisive CVEs)
  aiRiskJson        String?  // Phase 2 placeholder (nullable)
  submittedByUserId String?
  reviewedByUserId  String?
  reviewNotes       String?
  submittedAt       DateTime @default(now())
  reviewedAt        DateTime?

  createdAt     DateTime @default(now())

  program MarketplaceProgram @relation(fields: [programId], references: [id], onDelete: Cascade)
  events  ProgramReviewEvent[]

  @@unique([programId, version])
  @@index([programId])
  @@index([reviewState])
}
```

- [ ] **Step 2: Extend `MarketplaceProgram` with the live-version pointers**

In `model MarketplaceProgram`, add after `installCount`:

```prisma
  // The currently-live (last-approved) version + its AR digest. Null until a
  // version reaches `published`. The marketplace lists only programs where this
  // is set; an update in review does NOT change these until it is approved
  // (the previously-approved digest stays live).
  publishedVersion  String?
  publishedDigest   String?
```

- [ ] **Step 3: Add the `ProgramReviewEvent` audit model**

Append after `ProgramRuntimeEvent`:

```prisma
model ProgramReviewEvent {
  id          String   @id @default(cuid())
  versionId   String
  fromState   String?
  toState     String
  actorUserId String?
  reasonJson  String?
  createdAt   DateTime @default(now())

  version ProgramVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)

  @@index([versionId])
  @@index([createdAt])
}
```

- [ ] **Step 4: Validate the schema**

Run: `cd synthi; npx prisma validate`
Expected: `The schema at prisma\schema.prisma is valid 🚀`

- [ ] **Step 5: Generate the client + push to the local DB**

Run:
```
cd synthi
$env:DATABASE_URL='postgresql://synthi:password@localhost:5432/synthi'
npx prisma generate
npx prisma db push
```
Expected: generate succeeds; `db push` reports the new columns/table added (additive; **never** `migrate deploy` — local has no migration history, lesson #40).

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/prisma/schema.prisma
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): review-gate data model (ProgramVersion review fields + ProgramReviewEvent)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Shared host-escape ruleset (`hostEscape.js`)

Extract the host-escape denylist into one exported module so `hardGates` and `devcontainer.js` use identical rules (no reinvention). The command-string scanner must **reject** `docker.sock`, `/var/run`, `--privileged`, `--cap-add`, `--security-opt`, `--device`, and absolute-path host bind mounts, while **allowing** the legitimate workspace mount `-v "$PWD":/workspace`.

**Files:**
- Create: `synthi/src/lib/programs/hostEscape.js`
- Test: `synthi/src/lib/programs/__tests__/hostEscape.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { findCommandHostEscape } from '../hostEscape';

describe('findCommandHostEscape', () => {
  it('allows the legitimate workspace mount + a benign docker run', () => {
    expect(findCommandHostEscape('docker run --rm -p 6901:6901 -v "$PWD":/workspace -w /workspace img')).toBeNull();
    expect(findCommandHostEscape('npm run dev')).toBeNull();
    expect(findCommandHostEscape('')).toBeNull();
  });

  it('rejects a docker.sock mount (portainer-style)', () => {
    expect(findCommandHostEscape('docker run -v /var/run/docker.sock:/var/run/docker.sock img'))
      .toMatch(/docker\.sock|var\/run/i);
  });

  it('rejects --privileged, --cap-add, --security-opt, --device', () => {
    expect(findCommandHostEscape('docker run --privileged img')).toMatch(/privileged/i);
    expect(findCommandHostEscape('docker run --cap-add=SYS_ADMIN img')).toMatch(/cap-add/i);
    expect(findCommandHostEscape('docker run --security-opt seccomp=unconfined img')).toMatch(/security-opt/i);
    expect(findCommandHostEscape('docker run --device /dev/sda img')).toMatch(/device/i);
  });

  it('rejects an absolute-path host bind mount but not $PWD', () => {
    expect(findCommandHostEscape('docker run -v /etc:/etc img')).toMatch(/-v|volume/i);
    expect(findCommandHostEscape('docker run --volume /home/u:/data img')).toMatch(/-v|volume/i);
    expect(findCommandHostEscape('docker run -v "$PWD/.cache":/c img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run hostEscape --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../hostEscape"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview Shared host-escape ruleset. Single source of truth for the
 * denylist that both the devcontainer importer and the community-submission
 * hard gates apply — reject docker.sock / host bind mounts / privileged /
 * --cap-add / --security-opt / --device. NOTE: this is defense-in-depth, not a
 * containment guarantee — the real isolation is the installer's Sysbox runtime.
 */

/** Privilege/host-access flags that are never allowed in a program command. */
export const HOST_ESCAPE_FLAG_RE = /(^|\s)(--privileged|--cap-add|--security-opt|--device)(=|\s|$)/i;

/** The docker daemon socket / host runtime dir, however referenced. */
export const DOCKER_SOCK_RE = /docker\.sock|\/var\/run\/docker/i;

/**
 * A `-v` / `--volume` whose SOURCE is an absolute host path (starts with `/`).
 * The legitimate workspace mount `-v "$PWD":/workspace` is NOT matched: after
 * the (optional) quote the source begins with `$`, not `/`.
 */
export const HOST_BIND_MOUNT_RE = /(^|\s)(-v|--volume)(\s+|=)["']?\/[^"'\s]/i;

/**
 * Scan a shell command string for any host-escape pattern.
 * @param {string} text
 * @returns {string|null} the matched offending substring, or null if clean.
 */
export function findCommandHostEscape(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const re of [DOCKER_SOCK_RE, HOST_ESCAPE_FLAG_RE, HOST_BIND_MOUNT_RE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run hostEscape --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `devcontainer.js` to reuse the shared flag token (behavior-preserving)**

In `synthi/src/lib/programs/devcontainer.js`, import the shared regexes and use them in the `runArgs` check. Replace the `runArgs` block inside `assertNoHostEscape` (currently lines ~81-86):

```js
  if (Array.isArray(dc.runArgs)) {
    const joined = dc.runArgs.join(' ');
    // (^|\s)-v(\s|$) keeps the devcontainer-specific "any -v in runArgs" rule;
    // the flag/sock rules come from the shared ruleset so both paths stay in sync.
    if (HOST_ESCAPE_FLAG_RE.test(joined) || DOCKER_SOCK_RE.test(joined) || /(^|\s)-v(\s|$)/i.test(joined)) {
      throw new ProgramManifestError('host_escape', 'runArgs request host access', 'runArgs');
    }
  }
```

And add to the import block at the top (line ~14):

```js
import { HOST_ESCAPE_FLAG_RE, DOCKER_SOCK_RE } from './hostEscape';
```

- [ ] **Step 6: Run the devcontainer tests to confirm no regression**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run devcontainer --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (all existing devcontainer tests green).

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/hostEscape.js synthi/src/lib/programs/__tests__/hostEscape.test.js synthi/src/lib/programs/devcontainer.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): shared host-escape ruleset reused by devcontainer + hard gates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `hardGates` — pure fail-closed validators

`runHardGates({ config, sourceImageRef })` re-validates the manifest (schema), asserts every scope is in the allow-list, scans `launch` + `install` for host escapes, and checks metadata sanity (container/gui ⇒ a `sourceImageRef` that the launch references; ports declared ⊆ manifest ports — trivially true here but pinned; a non-empty launch entrypoint). Returns `{ ok: boolean, reasons: Array<{ code, message, field? }> }`. **Never throws** for a bad submission — it converts failures to reasons (the orchestrator routes a non-ok result to `rejected`).

**Files:**
- Create: `synthi/src/lib/programs/hardGates.js`
- Test: `synthi/src/lib/programs/__tests__/hardGates.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { runHardGates } from '../hardGates';

const webConfig = {
  packageId: 'web', version: '1.0.0', displayName: 'Web', runtimeType: 'web',
  workingDir: '', install: ['npm ci'], launch: 'npm run dev', env: {}, ports: [3000],
  surfaces: [], health: null, permissions: ['program.launch', 'network.outbound'],
  source: 'vectant.programs.json', sourceHints: {},
};
const containerConfig = (over = {}) => ({
  packageId: 'tool', version: '1.0.0', displayName: 'Tool', runtimeType: 'container',
  workingDir: '', install: ['docker pull reg.io/me/tool:1'], env: {}, ports: [6901],
  launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
  surfaces: [], health: null, permissions: ['program.launch'],
  source: 'vectant.programs.json', sourceHints: {}, ...over,
});

describe('runHardGates', () => {
  it('passes a clean web manifest (no image required)', () => {
    expect(runHardGates({ config: webConfig })).toEqual({ ok: true, reasons: [] });
  });

  it('passes a clean container manifest whose launch references the source image', () => {
    expect(runHardGates({ config: containerConfig(), sourceImageRef: 'reg.io/me/tool:1' }))
      .toEqual({ ok: true, reasons: [] });
  });

  it('fails an invalid manifest schema (fail-closed)', () => {
    const r = runHardGates({ config: { ...webConfig, packageId: '../evil' } });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'invalid_manifest' || x.field === 'packageId')).toBe(true);
  });

  it('fails an unknown / over-broad scope', () => {
    const r = runHardGates({ config: { ...webConfig, permissions: ['program.launch', 'host.root'] } });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'unknown_scope')).toBe(true);
  });

  it('fails a host-escape in the launch command (docker.sock)', () => {
    const r = runHardGates({
      config: containerConfig({ launch: 'docker run -v /var/run/docker.sock:/var/run/docker.sock reg.io/me/tool:1' }),
      sourceImageRef: 'reg.io/me/tool:1',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'host_escape')).toBe(true);
  });

  it('fails a host-escape in an install command (--privileged)', () => {
    const r = runHardGates({
      config: containerConfig({ install: ['docker run --privileged reg.io/me/tool:1 setup'] }),
      sourceImageRef: 'reg.io/me/tool:1',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'host_escape')).toBe(true);
  });

  it('fails a container submission with no sourceImageRef (metadata)', () => {
    const r = runHardGates({ config: containerConfig() });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'image_required')).toBe(true);
  });

  it('fails when the declared sourceImageRef is not referenced by the launch (metadata mismatch)', () => {
    const r = runHardGates({ config: containerConfig(), sourceImageRef: 'reg.io/SOMEONE_ELSE/x:9' });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'image_mismatch')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run hardGates --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../hardGates"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview Pure, fail-closed hard gates for a community-app submission.
 * Reuses `parseProgramManifest` (schema + scope allow-list) and the shared
 * host-escape ruleset. Returns reasons rather than throwing so the orchestrator
 * can record them and route the version to `rejected`. This is defense-in-depth,
 * NOT a containment guarantee — see hostEscape.js / the design doc.
 */

import { parseProgramManifest, ProgramManifestError, SUPPORTED_RUNTIME_TYPES } from './manifest';
import { findCommandHostEscape } from './hostEscape';

/** Runtime types that ship a container image and therefore require re-hosting. */
const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);

/**
 * @param {{ config: object, sourceImageRef?: string|null }} input
 * @returns {{ ok: boolean, reasons: Array<{code:string,message:string,field?:string}> }}
 */
export function runHardGates({ config, sourceImageRef = null }) {
  const reasons = [];

  // Gate 1: schema (re-parse so a tampered/raw config is fully re-validated +
  // scope allow-list enforced). parseProgramManifest throws ProgramManifestError.
  let normalized = null;
  try {
    normalized = parseProgramManifest(config);
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      reasons.push({ code: err.code, message: err.message, field: err.field });
      return { ok: false, reasons }; // can't reason about the rest without a valid manifest
    }
    reasons.push({ code: 'invalid_manifest', message: String(err?.message || err) });
    return { ok: false, reasons };
  }

  // Gate 2: host-escape across every command string (install[] + launch).
  for (const cmd of [...(normalized.install || []), normalized.launch]) {
    const hit = findCommandHostEscape(cmd);
    if (hit) reasons.push({ code: 'host_escape', message: `host escape in command: ${hit}`, field: 'launch' });
  }

  // Gate 3: metadata sanity.
  if (!normalized.launch || !normalized.launch.trim()) {
    reasons.push({ code: 'missing_entrypoint', message: 'launch command is required', field: 'launch' });
  }
  const ref = typeof sourceImageRef === 'string' ? sourceImageRef.trim() : '';
  if (IMAGE_RUNTIME_TYPES.has(normalized.runtimeType)) {
    if (!ref) {
      reasons.push({ code: 'image_required', message: `${normalized.runtimeType} programs must declare a sourceImageRef`, field: 'sourceImageRef' });
    } else if (!normalized.launch.includes(ref)) {
      // The image we re-host must be the one the program actually runs, or the
      // pinned manifest would point at an image we never reviewed.
      reasons.push({ code: 'image_mismatch', message: 'sourceImageRef is not referenced by the launch command', field: 'sourceImageRef' });
    }
  }

  // (SUPPORTED_RUNTIME_TYPES is imported to keep the allow-list intent explicit;
  // parseProgramManifest already rejects unknown runtimeType values.)
  void SUPPORTED_RUNTIME_TYPES;

  return { ok: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run hardGates --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/hardGates.js synthi/src/lib/programs/__tests__/hardGates.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): fail-closed hard gates (schema, scope, host-escape, metadata)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `imageScanner` — trivy CVE wrapper (injectable exec)

`scanImage(imageRef, { threshold, runner })` runs trivy in JSON mode and reduces the result to a redacted summary `{ severityCounts, decisiveCves[], digest }` plus an `ok` decision against a severity threshold. The `runner` (an async fn returning `{ stdout }`) is injected; the default runner shells out to host-native `trivy.exe` with the cache/temp on D: (lesson #28). **Tests never shell out** — they pass a fake runner.

**Files:**
- Create: `synthi/src/lib/programs/imageScanner.js`
- Test: `synthi/src/lib/programs/__tests__/imageScanner.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from 'vitest';
import { scanImage, summarizeTrivy } from '../imageScanner';

const trivyJson = (vulns) => JSON.stringify({
  Results: [{ Target: 'img', Vulnerabilities: vulns }],
});

describe('summarizeTrivy', () => {
  it('counts by severity and lists decisive (>= threshold) CVEs', () => {
    const out = summarizeTrivy(trivyJson([
      { VulnerabilityID: 'CVE-1', Severity: 'CRITICAL', PkgName: 'a' },
      { VulnerabilityID: 'CVE-2', Severity: 'HIGH', PkgName: 'b' },
      { VulnerabilityID: 'CVE-3', Severity: 'LOW', PkgName: 'c' },
    ]), 'HIGH');
    expect(out.severityCounts).toMatchObject({ CRITICAL: 1, HIGH: 1, LOW: 1 });
    expect(out.decisiveCves).toEqual(expect.arrayContaining(['CVE-1', 'CVE-2']));
    expect(out.decisiveCves).not.toContain('CVE-3');
  });

  it('is empty for a clean image', () => {
    const out = summarizeTrivy(trivyJson([]), 'HIGH');
    expect(out.decisiveCves).toEqual([]);
    expect(out.severityCounts).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
  });
});

describe('scanImage', () => {
  it('passes a clean image and returns the resolved digest', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: trivyJson([]) });
    const res = await scanImage('reg.io/me/tool@sha256:abc', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(true);
    expect(res.summary.decisiveCves).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fails (ok=false) when a CVE meets/exceeds the threshold', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: trivyJson([{ VulnerabilityID: 'CVE-9', Severity: 'CRITICAL', PkgName: 'x' }]),
    });
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(false);
    expect(res.summary.decisiveCves).toContain('CVE-9');
  });

  it('fails closed when trivy errors or emits unparseable output', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('trivy crashed'));
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(res.ok).toBe(false);
    expect(res.summary.error).toBeTruthy();
  });

  it('does not leak file paths/secrets — summary is counts + ids only', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Results: [{ Target: '/home/secret/path', Vulnerabilities: [
        { VulnerabilityID: 'CVE-7', Severity: 'CRITICAL', PkgPath: '/etc/shadow' },
      ] }] }),
    });
    const res = await scanImage('reg.io/me/tool:1', { threshold: 'HIGH', runner });
    expect(JSON.stringify(res.summary)).not.toContain('/home/secret');
    expect(JSON.stringify(res.summary)).not.toContain('/etc/shadow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run imageScanner --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../imageScanner"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview trivy CVE scan wrapper for community-app images. The exec
 * `runner` is injectable so unit tests never shell out; the default runner uses
 * host-native trivy.exe with cache + temp on the roomy drive (lesson #28).
 * Output is reduced to a redacted summary (severity counts + decisive CVE ids,
 * no file paths) so it is safe to persist + show in the admin queue.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SEVERITY_ORDER = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const DEFAULT_THRESHOLD = process.env.PROGRAM_SCAN_THRESHOLD || 'HIGH';

/** Default runner: host-native trivy.exe, DB + temp forced to D: (lesson #28). */
async function defaultRunner(imageRef) {
  const cacheDir = process.env.TRIVY_CACHE_DIR || 'D:\\trivy-cache';
  return execFileAsync(
    process.env.TRIVY_BIN || 'trivy',
    ['image', '--quiet', '--format', 'json', '--timeout', '9m', '--cache-dir', cacheDir, imageRef],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Reduce trivy JSON to a redacted summary against `threshold`. */
export function summarizeTrivy(stdout, threshold = DEFAULT_THRESHOLD) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const decisiveCves = [];
  const minIdx = SEVERITY_ORDER.indexOf(String(threshold).toUpperCase());
  const data = JSON.parse(stdout); // throws on bad JSON → caller fails closed
  for (const result of data.Results || []) {
    for (const v of result.Vulnerabilities || []) {
      const sev = String(v.Severity || 'UNKNOWN').toUpperCase();
      if (counts[sev] == null) counts[sev] = 0;
      counts[sev] += 1;
      if (SEVERITY_ORDER.indexOf(sev) >= minIdx && v.VulnerabilityID) {
        if (!decisiveCves.includes(v.VulnerabilityID)) decisiveCves.push(v.VulnerabilityID);
      }
    }
  }
  return { threshold: String(threshold).toUpperCase(), severityCounts: counts, decisiveCves };
}

/**
 * Scan an image by ref/digest. Fail-closed: any error → ok:false.
 * @returns {Promise<{ ok: boolean, summary: object }>}
 */
export async function scanImage(imageRef, { threshold = DEFAULT_THRESHOLD, runner = defaultRunner } = {}) {
  try {
    const { stdout } = await runner(imageRef);
    const summary = summarizeTrivy(stdout, threshold);
    return { ok: summary.decisiveCves.length === 0, summary };
  } catch (err) {
    return { ok: false, summary: { threshold: String(threshold).toUpperCase(), error: String(err?.message || err) } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run imageScanner --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/imageScanner.js synthi/src/lib/programs/__tests__/imageScanner.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): trivy image scanner (redacted summary, fail-closed, injectable exec)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `reHoster` — `crane copy` by digest + manifest pinning

`reHostImage(sourceImageRef, target, { runner })` runs `crane copy SRC DST` then `crane digest DST` and returns `{ ref, digest }` where `ref` is the AR ref pinned by digest (`<target>@<digest>`). `communityImageTarget({ publisher, packageId })` builds the AR repo path (env-driven). `pinManifestImage(config, srcRef, arRef)` returns a new config with the source ref replaced by the AR digest ref in `launch` + `install`. Exec `runner` injected — **tests never shell out**.

**Files:**
- Create: `synthi/src/lib/programs/reHoster.js`
- Test: `synthi/src/lib/programs/__tests__/reHoster.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from 'vitest';
import { reHostImage, communityImageTarget, pinManifestImage } from '../reHoster';

describe('communityImageTarget', () => {
  it('builds an env-driven AR repo path namespaced by publisher + package', () => {
    const t = communityImageTarget({ publisher: 'team', packageId: 'tool' }, {
      host: 'europe-west1-docker.pkg.dev', project: 'proj', repo: 'community',
    });
    expect(t).toBe('europe-west1-docker.pkg.dev/proj/community/team/tool');
  });
});

describe('reHostImage', () => {
  it('crane-copies then resolves + returns the pinned AR digest ref', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '' })                       // crane copy
      .mockResolvedValueOnce({ stdout: 'sha256:deadbeef\n' });     // crane digest
    const out = await reHostImage('reg.io/me/tool:1', 'ar.host/p/community/team/tool', { runner });
    expect(out.digest).toBe('sha256:deadbeef');
    expect(out.ref).toBe('ar.host/p/community/team/tool@sha256:deadbeef');
    expect(runner).toHaveBeenNthCalledWith(1, 'copy', expect.arrayContaining(['reg.io/me/tool:1', 'ar.host/p/community/team/tool']));
    expect(runner).toHaveBeenNthCalledWith(2, 'digest', ['ar.host/p/community/team/tool']);
  });

  it('throws when crane copy fails (caller fails closed)', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('crane copy: denied'));
    await expect(reHostImage('reg.io/me/tool:1', 'ar.host/p/x', { runner })).rejects.toThrow(/crane/i);
  });
});

describe('pinManifestImage', () => {
  it('rewrites the source ref to the AR digest ref in launch + install', () => {
    const config = {
      runtimeType: 'container',
      install: ['docker pull reg.io/me/tool:1'],
      launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
    };
    const pinned = pinManifestImage(config, 'reg.io/me/tool:1', 'ar.host/p/community/team/tool@sha256:deadbeef');
    expect(pinned.launch).toContain('ar.host/p/community/team/tool@sha256:deadbeef');
    expect(pinned.launch).not.toContain('reg.io/me/tool:1');
    expect(pinned.install[0]).toContain('@sha256:deadbeef');
    expect(config.launch).toContain('reg.io/me/tool:1'); // original not mutated
  });

  it('returns the config unchanged when there is no source ref (web/cli)', () => {
    const config = { runtimeType: 'web', install: ['npm ci'], launch: 'npm run dev' };
    expect(pinManifestImage(config, null, null)).toEqual(config);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run reHoster --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../reHoster"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview Re-host an approved community image into our Artifact Registry,
 * pinned by digest, using daemon-free `crane copy` (lesson #27). The exec
 * `runner(subcommand, args)` is injectable so tests never shell out. After
 * re-host the published manifest is rewritten to reference the AR digest — so
 * installers always run exactly what we reviewed, never the publisher's mutable
 * tag (anti review-then-swap).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default runner: host-native crane (lesson #27). */
async function defaultRunner(subcommand, args) {
  return execFileAsync(process.env.CRANE_BIN || 'crane', [subcommand, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

/** Build the AR repo path for a community image (env-driven, like defaultPrograms). */
export function communityImageTarget({ publisher, packageId }, cfg = {}) {
  const host = cfg.host || process.env.VECTANT_AR_HOST;
  const project = cfg.project || process.env.VECTANT_AR_PROJECT;
  const repo = cfg.repo || process.env.VECTANT_AR_REPO || 'community';
  if (!host || !project) throw new Error('Artifact Registry target not configured (VECTANT_AR_HOST/PROJECT)');
  return `${host}/${project}/${repo}/${publisher}/${packageId}`;
}

/**
 * Copy SRC → target and return the target pinned by its resolved digest.
 * @returns {Promise<{ ref: string, digest: string }>}
 */
export async function reHostImage(sourceImageRef, target, { runner = defaultRunner } = {}) {
  await runner('copy', [sourceImageRef, target]);
  const { stdout } = await runner('digest', [target]);
  const digest = String(stdout).trim();
  if (!/^sha256:[0-9a-f]{8,}$/i.test(digest)) {
    throw new Error(`crane digest returned an unexpected value: ${digest}`);
  }
  return { ref: `${target}@${digest}`, digest };
}

/** Return a copy of `config` with `srcRef` replaced by `arRef` in launch + install. */
export function pinManifestImage(config, srcRef, arRef) {
  if (!srcRef || !arRef) return config;
  const replace = (s) => (typeof s === 'string' ? s.split(srcRef).join(arRef) : s);
  return {
    ...config,
    launch: replace(config.launch),
    install: Array.isArray(config.install) ? config.install.map(replace) : config.install,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run reHoster --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/reHoster.js synthi/src/lib/programs/__tests__/reHoster.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): crane re-host by digest + manifest image pinning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `entitlements` — `canPublish` + `isPlatformAdmin`

**Files:**
- Create: `synthi/src/lib/programs/entitlements.js`
- Test: `synthi/src/lib/programs/__tests__/entitlements.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { afterEach, describe, expect, it } from 'vitest';
import { canPublish, isPlatformAdmin } from '../entitlements';

const ORIG = process.env.PLATFORM_ADMIN_EMAILS;
afterEach(() => { process.env.PLATFORM_ADMIN_EMAILS = ORIG; });

describe('canPublish', () => {
  it('returns true for any authenticated actor (paywall is a later concern)', () => {
    expect(canPublish({ userId: 'u1', email: 'a@b.c' })).toBe(true);
  });
  it('returns false without an actor', () => {
    expect(canPublish(null)).toBe(false);
  });
});

describe('isPlatformAdmin', () => {
  it('matches an email in the allow-list (case-insensitive)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'Boss@x.io, admin@y.io';
    expect(isPlatformAdmin({ email: 'admin@y.io' })).toBe(true);
    expect(isPlatformAdmin({ email: 'BOSS@x.io' })).toBe(true);
  });
  it('rejects a non-listed email', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'admin@y.io';
    expect(isPlatformAdmin({ email: 'someone@else.io' })).toBe(false);
  });
  it('fails closed when no admins are configured', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin({ email: 'admin@y.io' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run entitlements --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../entitlements"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview Publish entitlement + platform-admin hooks. `canPublish` is the
 * single gate every submit path (UI/API/MCP) must call — it returns true today;
 * a plan/paywall check slots in here later (out of scope). `isPlatformAdmin`
 * gates the cross-workspace review queue (env allow-list; fail-closed).
 */

/** Entitlement to publish. Returns true now; paywall slots in here later. */
export function canPublish(actor) {
  return !!(actor && actor.userId);
}

/** Platform (cross-workspace) admin, by env allow-list of emails. Fail-closed. */
export function isPlatformAdmin(actor) {
  const email = actor?.email && String(actor.email).trim().toLowerCase();
  if (!email) return false;
  const allow = String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run entitlements --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/entitlements.js synthi/src/lib/programs/__tests__/entitlements.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): canPublish + isPlatformAdmin entitlement hooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `submissionStore` — review CRUD + audit (extend `store.js`)

Add submission/review functions to `store.js` (D4), reusing its prisma + `toPublic*` patterns. Transitions are guarded on `fromState` (idempotent/resumable) and each writes a `ProgramReviewEvent`. The marketplace listing + published-version resolver are gated on the live `published` version so unreviewed/old digests are never served, and public/admin projections allow-list fields (no raw scan/AI report leakage).

**Files:**
- Modify: `synthi/src/lib/programs/store.js`
- Test: `synthi/src/lib/programs/__tests__/store.test.js` (add describe blocks)

- [ ] **Step 1: Write the failing tests** (append to `store.test.js`; also extend the `vi.hoisted` prisma mock)

First, extend the hoisted prisma mock at the top of the file to add the new delegates/methods:

```js
// add to the `marketplaceProgram` mock object: update already present; ensure findFirst:
//   marketplaceProgram: { upsert, findMany, update, findUnique, findFirst: vi.fn() },
// add to the `programVersion` mock object: create, update, updateMany, findFirst:
//   programVersion: { upsert, findUnique, create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
// add a new delegate:
//   programReviewEvent: { create: vi.fn() },
// add `$transaction: vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f)))) }`
```

Then append these tests:

```js
import {
  createSubmission,
  getReviewVersionById,
  listPendingReview,
  transitionReview,
  publishApprovedVersion,
  toReviewQueueItem,
} from '../store';

describe('createSubmission', () => {
  it('creates a submitted version with the source ref and submitter, bumping latestVersion', async () => {
    h.prisma.marketplaceProgram.upsert.mockResolvedValue({ id: 'prog1', packageId: '@team/tool', publisher: 'team' });
    h.prisma.programVersion.create.mockResolvedValue({ id: 'ver1', reviewState: 'submitted' });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev1' });
    const config = { packageId: 'tool', version: '1.0.0', displayName: 'Tool', description: 'd', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1', ports: [6901] };

    const { program, version } = await createSubmission({
      workspaceSlug: 'team', config, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1',
    });

    expect(program.id).toBe('prog1');
    expect(version.id).toBe('ver1');
    const verArg = h.prisma.programVersion.create.mock.calls[0][0];
    expect(verArg.data).toMatchObject({ programId: 'prog1', version: '1.0.0', reviewState: 'submitted', sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' });
    // audit: null -> submitted
    expect(h.prisma.programReviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'ver1', fromState: null, toState: 'submitted', actorUserId: 'u1' }),
    }));
  });
});

describe('transitionReview', () => {
  it('guards on fromState, patches the version, and writes an audit event', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev2' });

    const ok = await transitionReview('ver1', { fromState: 'submitted', toState: 'scanning', actorUserId: 'u1' });

    expect(ok).toBe(true);
    expect(h.prisma.programVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ver1', reviewState: 'submitted' },
      data: expect.objectContaining({ reviewState: 'scanning' }),
    }));
    expect(h.prisma.programReviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'ver1', fromState: 'submitted', toState: 'scanning' }),
    }));
  });

  it('is a no-op (returns false, no audit) when the guard does not match', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 0 });
    const ok = await transitionReview('ver1', { fromState: 'submitted', toState: 'scanning' });
    expect(ok).toBe(false);
    expect(h.prisma.programReviewEvent.create).not.toHaveBeenCalled();
  });

  it('stores a redacted scan summary + notes via the patch', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev3' });
    await transitionReview('ver1', {
      fromState: 'scanning', toState: 'rejected', actorUserId: null,
      reason: [{ code: 'cve', message: 'CVE-9' }],
      patch: { scanReportJson: JSON.stringify({ decisiveCves: ['CVE-9'] }) },
    });
    const arg = h.prisma.programVersion.updateMany.mock.calls[0][0];
    expect(arg.data.scanReportJson).toContain('CVE-9');
    expect(arg.data.reviewState).toBe('rejected');
  });
});

describe('publishApprovedVersion', () => {
  it('flips the version to published with the AR digest and points the program at it', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev4' });
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'prog1', publishedVersion: '1.0.0' });

    await publishApprovedVersion('ver1', {
      programId: 'prog1', version: '1.0.0', actorUserId: 'admin1',
      hostedImageDigest: 'sha256:dead', publishedManifestJson: '{"launch":"docker run ar.host/x@sha256:dead"}',
    });

    const verArg = h.prisma.programVersion.updateMany.mock.calls[0][0];
    expect(verArg.where).toEqual({ id: 'ver1', reviewState: 'rehosting' });
    expect(verArg.data).toMatchObject({ reviewState: 'published', hostedImageDigest: 'sha256:dead' });
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'prog1' },
      data: expect.objectContaining({ publishedVersion: '1.0.0', publishedDigest: 'sha256:dead' }),
    }));
  });
});

describe('listPendingReview / toReviewQueueItem', () => {
  it('lists pending_review versions joined with their program', async () => {
    h.prisma.programVersion.findMany = h.prisma.programVersion.findMany || vi.fn();
    h.prisma.programVersion.findMany.mockResolvedValue([
      { id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1', scanReportJson: '{"decisiveCves":[]}', program: { packageId: '@team/tool', publisher: 'team' } },
    ]);
    const rows = await listPendingReview();
    expect(rows[0]).toMatchObject({ id: 'ver1', reviewState: 'pending_review' });
  });

  it('toReviewQueueItem allow-lists fields and never leaks raw manifest/secrets', () => {
    const item = toReviewQueueItem({
      id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1',
      sourceImageRef: 'reg.io/me/tool:1', manifestJson: '{"env":{"SECRET":"x"}}',
      scanReportJson: '{"decisiveCves":[],"severityCounts":{"HIGH":0}}',
      program: { packageId: '@team/tool', publisher: 'team', displayName: 'Tool' },
    });
    expect(item).toMatchObject({ versionId: 'ver1', packageId: '@team/tool', reviewState: 'pending_review' });
    expect(item.scanSummary).toMatchObject({ decisiveCves: [] });
    expect(JSON.stringify(item)).not.toContain('SECRET');
    expect(item).not.toHaveProperty('manifestJson');
  });
});

describe('listPublishedPrograms (gated on live version)', () => {
  it('only lists programs that have a publishedVersion', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([]);
    await listPublishedPrograms({});
    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ publisher: { not: 'local' }, publishedVersion: { not: null } });
  });
});

describe('getPublishedProgramVersion (only serves published)', () => {
  it('returns null when the requested version is not in published state', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/tool', publisher: 'team' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', reviewState: 'pending_review', manifestJson: '{"launch":"x"}' });
    const found = await getPublishedProgramVersion('@team/tool', '1.0.0');
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run programs/__tests__/store --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — the new exports are undefined; `getPublishedProgramVersion`/`listPublishedPrograms` assertions fail.

- [ ] **Step 3: Implement the store functions**

Add to `synthi/src/lib/programs/store.js`. First, a redaction helper + the new CRUD:

```js
// ── Community-app submission + review gate (Phase 1) ──

/**
 * Create (or re-submit) a community-app version in `submitted` state. Upserts the
 * MarketplaceProgram (publisher = slug, packageId = @slug/<name>) and creates a
 * new version row carrying the publisher's sourceImageRef + the submitted manifest.
 * Writes the initial null→submitted audit event. Does NOT change the program's
 * live publishedVersion (an update stays invisible until it is approved).
 */
export async function createSubmission({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }) {
  const packageId = publishedPackageId(workspaceSlug, config.packageId);
  const program = await prisma.marketplaceProgram.upsert({
    where: { packageId },
    update: { latestVersion: config.version, displayName: config.displayName || config.packageId, description: config.description || null, publishedByUserId: submittedByUserId },
    create: { packageId, publisher: workspaceSlug, verified: false, latestVersion: config.version, displayName: config.displayName || config.packageId, description: config.description || null, publishedByUserId: submittedByUserId },
  });
  const version = await prisma.programVersion.create({
    data: {
      programId: program.id,
      version: config.version,
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
      reviewState: 'submitted',
      sourceImageRef,
      submittedByUserId,
    },
  });
  await prisma.programReviewEvent.create({
    data: { versionId: version.id, fromState: null, toState: 'submitted', actorUserId: submittedByUserId, reasonJson: null },
  });
  return { program, version };
}

/** Fetch a version (with its program) for review/orchestration. */
export async function getReviewVersionById(versionId) {
  return prisma.programVersion.findUnique({ where: { id: versionId }, include: { program: true } });
}

/** List versions awaiting manual review, newest first, with their program. */
export async function listPendingReview() {
  return prisma.programVersion.findMany({
    where: { reviewState: 'pending_review' },
    orderBy: { submittedAt: 'desc' },
    include: { program: true },
  });
}

/**
 * Guarded state transition + audit. Updates only if the row is still in
 * `fromState` (idempotent/resumable). Returns true if it transitioned.
 * `patch` carries extra column writes (scanReportJson, reviewNotes, reviewedByUserId…).
 */
export async function transitionReview(versionId, { fromState, toState, actorUserId = null, reason = null, patch = {} }) {
  const data = { reviewState: toState, ...patch };
  if (actorUserId && (toState === 'approved' || toState === 'rejected' || toState === 'published')) {
    data.reviewedByUserId = actorUserId;
    data.reviewedAt = new Date();
  }
  const res = await prisma.programVersion.updateMany({ where: { id: versionId, reviewState: fromState }, data });
  if (!res.count) return false;
  await prisma.programReviewEvent.create({
    data: { versionId, fromState, toState, actorUserId, reasonJson: reason == null ? null : JSON.stringify(reason) },
  });
  return true;
}

/**
 * Flip an approved+rehosted version to `published` and point the program's live
 * version/digest at it (the previously-live version stays untouched until now).
 */
export async function publishApprovedVersion(versionId, { programId, version, actorUserId, hostedImageDigest, publishedManifestJson }) {
  const ok = await transitionReview(versionId, {
    fromState: 'rehosting', toState: 'published', actorUserId,
    patch: { hostedImageDigest, manifestJson: publishedManifestJson },
  });
  if (!ok) return false;
  await prisma.marketplaceProgram.update({
    where: { id: programId },
    data: { publishedVersion: version, publishedDigest: hostedImageDigest, latestVersion: version },
  });
  return true;
}

/** Admin-queue projection: allow-listed fields + parsed scan summary, never the raw manifest. */
export function toReviewQueueItem(row) {
  if (!row) return row;
  return {
    versionId: row.id,
    version: row.version,
    reviewState: row.reviewState,
    submittedByUserId: row.submittedByUserId ?? null,
    sourceImageRef: row.sourceImageRef ?? null,
    submittedAt: row.submittedAt ?? null,
    scanSummary: parseJsonText(row.scanReportJson, null),
    packageId: row.program ? row.program.packageId : null,
    publisher: row.program ? row.program.publisher : null,
    displayName: row.program ? (row.program.displayName ?? null) : null,
  };
}
```

Then gate the two existing resolvers. In `listPublishedPrograms`, change the `where` to include `publishedVersion: { not: null }`:

```js
    where: {
      publisher: { not: 'local' },
      publishedVersion: { not: null },
      ...(trimmed ? { OR: [ /* unchanged */ ] } : {}),
    },
```

In `getPublishedProgramVersion`, after fetching `versionRow`, add the published guard:

```js
  if (!versionRow || !versionRow.manifestJson) return null;
  if (versionRow.reviewState !== 'published') return null; // never serve unreviewed/old digests
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run programs/__tests__/store --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (existing + new tests). If the existing `listPublishedPrograms` "omits the OR clause" test now fails on the added `publishedVersion` key, update its expectation to `{ publisher: { not: 'local' }, publishedVersion: { not: null } }`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/store.js synthi/src/lib/programs/__tests__/store.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): submission/review store CRUD + audit; gate marketplace on live version

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `reviewOrchestrator` — drive the state machine

Pure orchestration over injected deps (`store`, `hardGates`, `scanner`, `reHoster`). Phase 1 has no AI: a clean scan routes to `pending_review`. Approval re-hosts (if image) + publishes; rejection records reasons. Approve enforces **admin ≠ submitter**.

**Files:**
- Create: `synthi/src/lib/programs/reviewOrchestrator.js`
- Test: `synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitForReview, approveSubmission, rejectSubmission } from '../reviewOrchestrator';

const containerConfig = {
  packageId: 'tool', version: '1.0.0', displayName: 'Tool', runtimeType: 'container',
  workingDir: '', install: ['docker pull reg.io/me/tool:1'], env: {}, ports: [6901],
  launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
  surfaces: [], health: null, permissions: ['program.launch'], source: 'vectant.programs.json', sourceHints: {},
};

let deps;
beforeEach(() => {
  deps = {
    store: {
      createSubmission: vi.fn().mockResolvedValue({ program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' }, version: { id: 'ver1' } }),
      transitionReview: vi.fn().mockResolvedValue(true),
      getReviewVersionById: vi.fn(),
      publishApprovedVersion: vi.fn().mockResolvedValue(true),
    },
    hardGates: vi.fn().mockReturnValue({ ok: true, reasons: [] }),
    scanner: vi.fn().mockResolvedValue({ ok: true, summary: { decisiveCves: [] } }),
    reHost: vi.fn().mockResolvedValue({ ref: 'ar.host/p/community/team/tool@sha256:dead', digest: 'sha256:dead' }),
    target: vi.fn().mockReturnValue('ar.host/p/community/team/tool'),
    pin: vi.fn().mockImplementation((cfg) => ({ ...cfg, launch: 'docker run ar.host/p/community/team/tool@sha256:dead' })),
  };
});

describe('submitForReview', () => {
  it('clean container submission lands in pending_review (Phase 1, no AI)', async () => {
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.scanner).toHaveBeenCalledWith('reg.io/me/tool:1', expect.anything());
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'submitted', toState: 'scanning' }));
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'pending_review' }));
  });

  it('hard-gate failure routes straight to rejected (never scanned)', async () => {
    deps.hardGates.mockReturnValue({ ok: false, reasons: [{ code: 'host_escape', message: 'x' }] });
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.scanner).not.toHaveBeenCalled();
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'submitted', toState: 'rejected', reason: [{ code: 'host_escape', message: 'x' }] }));
  });

  it('over-threshold CVE routes to rejected', async () => {
    deps.scanner.mockResolvedValue({ ok: false, summary: { decisiveCves: ['CVE-9'] } });
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'rejected' }));
  });

  it('web submission skips scanning and lands in pending_review', async () => {
    const web = { ...containerConfig, runtimeType: 'web', launch: 'npm run dev', install: ['npm ci'] };
    const res = await submitForReview({ workspaceSlug: 'team', config: web, sourceImageRef: null, submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.scanner).not.toHaveBeenCalled();
  });
});

describe('approveSubmission', () => {
  beforeEach(() => {
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1',
      manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' },
    });
  });

  it('approves: rehosts by digest, pins the manifest, publishes', async () => {
    const res = await approveSubmission({ versionId: 'ver1', adminUserId: 'admin1' }, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.reHost).toHaveBeenCalledWith('reg.io/me/tool:1', 'ar.host/p/community/team/tool', expect.anything());
    const pubArg = deps.store.publishApprovedVersion.mock.calls[0][1];
    expect(pubArg.hostedImageDigest).toBe('sha256:dead');
    expect(JSON.parse(pubArg.publishedManifestJson).launch).toContain('@sha256:dead');
  });

  it('refuses self-approval (submitter cannot approve their own)', async () => {
    const res = await approveSubmission({ versionId: 'ver1', adminUserId: 'u1' }, deps);
    expect(res.error).toBe('self_review_forbidden');
    expect(deps.reHost).not.toHaveBeenCalled();
    expect(deps.store.publishApprovedVersion).not.toHaveBeenCalled();
  });

  it('a web program approves with no re-host', async () => {
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver2', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: null,
      manifestJson: JSON.stringify({ ...containerConfig, runtimeType: 'web', launch: 'npm run dev' }), program: { id: 'prog2', publisher: 'team', packageId: '@team/web' },
    });
    const res = await approveSubmission({ versionId: 'ver2', adminUserId: 'admin1' }, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.reHost).not.toHaveBeenCalled();
    const pubArg = deps.store.publishApprovedVersion.mock.calls[0][1];
    expect(pubArg.hostedImageDigest).toBeNull();
  });
});

describe('rejectSubmission', () => {
  it('records reject notes + transitions pending_review -> rejected', async () => {
    deps.store.getReviewVersionById.mockResolvedValue({ id: 'ver1', reviewState: 'pending_review', submittedByUserId: 'u1' });
    const res = await rejectSubmission({ versionId: 'ver1', adminUserId: 'admin1', notes: 'spammy' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'pending_review', toState: 'rejected', actorUserId: 'admin1', patch: { reviewNotes: 'spammy' } }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run reviewOrchestrator --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../reviewOrchestrator"`.

- [ ] **Step 3: Write the module**

```js
/**
 * @fileoverview Drives the community-app review state machine (Phase 1, no AI):
 *   submitted → scanning → pending_review        (clean)
 *   submitted → rejected                         (hard-gate fail)
 *   scanning  → rejected                         (over-threshold CVE)
 *   pending_review → approved → rehosting → published   (admin approve)
 *   pending_review → rejected                    (admin reject)
 * Deps are injected so the unit tests never touch prisma/trivy/crane. Approval
 * enforces admin ≠ submitter. The published manifest is pinned to the AR digest
 * so installers run exactly what we reviewed.
 */

import * as storeModule from './store';
import { runHardGates } from './hardGates';
import { scanImage } from './imageScanner';
import { reHostImage, communityImageTarget, pinManifestImage } from './reHoster';

const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);

function defaultDeps() {
  return {
    store: storeModule,
    hardGates: runHardGates,
    scanner: scanImage,
    reHost: reHostImage,
    target: communityImageTarget,
    pin: pinManifestImage,
  };
}

/** Submit a community app: hard gates → (scan) → pending_review | rejected. */
export async function submitForReview({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }, deps = defaultDeps()) {
  const { store, hardGates, scanner } = deps;
  const { version } = await store.createSubmission({ workspaceSlug, config, sourceImageRef, submittedByUserId });

  const gate = hardGates({ config, sourceImageRef });
  if (!gate.ok) {
    await store.transitionReview(version.id, { fromState: 'submitted', toState: 'rejected', actorUserId: null, reason: gate.reasons });
    return { versionId: version.id, reviewState: 'rejected', reasons: gate.reasons };
  }

  await store.transitionReview(version.id, { fromState: 'submitted', toState: 'scanning', actorUserId: null });

  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    const scan = await scanner(sourceImageRef, {});
    const patch = { scanReportJson: JSON.stringify(scan.summary || {}) };
    if (!scan.ok) {
      await store.transitionReview(version.id, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason: [{ code: 'cve_over_threshold', message: 'image failed CVE scan' }], patch });
      return { versionId: version.id, reviewState: 'rejected', reasons: [{ code: 'cve_over_threshold' }] };
    }
    await store.transitionReview(version.id, { fromState: 'scanning', toState: 'pending_review', actorUserId: null, patch });
    return { versionId: version.id, reviewState: 'pending_review' };
  }

  await store.transitionReview(version.id, { fromState: 'scanning', toState: 'pending_review', actorUserId: null });
  return { versionId: version.id, reviewState: 'pending_review' };
}

/** Admin approve: rehost (if image) + pin manifest + publish. Admin ≠ submitter. */
export async function approveSubmission({ versionId, adminUserId }, deps = defaultDeps()) {
  const { store, reHost, target, pin } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (row.submittedByUserId && row.submittedByUserId === adminUserId) return { error: 'self_review_forbidden' };
  if (row.reviewState !== 'pending_review') return { error: 'invalid_state', reviewState: row.reviewState };

  await store.transitionReview(versionId, { fromState: 'pending_review', toState: 'approved', actorUserId: adminUserId });
  await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: adminUserId });

  const config = JSON.parse(row.manifestJson);
  let hostedImageDigest = null;
  let publishedConfig = config;
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && row.sourceImageRef) {
    const dst = target({ publisher: row.program.publisher, packageId: config.packageId });
    const { ref, digest } = await reHost(row.sourceImageRef, dst, {});
    hostedImageDigest = digest;
    publishedConfig = pin(config, row.sourceImageRef, ref);
  }

  await store.publishApprovedVersion(versionId, {
    programId: row.program.id, version: row.version, actorUserId: adminUserId,
    hostedImageDigest, publishedManifestJson: JSON.stringify(publishedConfig),
  });
  return { versionId, reviewState: 'published', hostedImageDigest };
}

/** Admin reject: record notes + transition to rejected. */
export async function rejectSubmission({ versionId, adminUserId, notes = '' }, deps = defaultDeps()) {
  const { store } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (row.reviewState !== 'pending_review') return { error: 'invalid_state', reviewState: row.reviewState };
  await store.transitionReview(versionId, { fromState: 'pending_review', toState: 'rejected', actorUserId: adminUserId, reason: [{ code: 'manual_reject', message: notes }], patch: { reviewNotes: notes } });
  return { versionId, reviewState: 'rejected' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run reviewOrchestrator --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/reviewOrchestrator.js synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): review orchestrator state machine (submit/approve/reject, digest re-host)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Submit + status API routes (canPublish-gated)

Repurpose the publish route to submit through the orchestrator; add a status route. Both reuse `resolveActor` + `canWriteScope` (owner/admin of the workspace) **and** `canPublish` (entitlement).

**Files:**
- Modify: `synthi/src/app/api/workspace/[slug]/programs/publish/route.js`
- Create: `synthi/src/app/api/workspace/[slug]/programs/submissions/route.js`
- Test: extend `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Write the failing tests** (replace the existing `describe('POST /programs/publish', …)` block and add submit-specific cases)

Add to the `vi.mock('@/lib/programs/store', …)` block: `createSubmission: h.createSubmission`, `listSubmissionsForWorkspace: h.listSubmissionsForWorkspace`, `toReviewQueueItem: (r) => ({ versionId: r.id, reviewState: r.reviewState })`. Add to `h` hoisted: `createSubmission: vi.fn()`, `listSubmissionsForWorkspace: vi.fn()`, `submitForReview: vi.fn()`, `canPublish: vi.fn()`. Add mocks:

```js
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ submitForReview: h.submitForReview }));
vi.mock('@/lib/programs/entitlements', () => ({ canPublish: h.canPublish, isPlatformAdmin: vi.fn() }));
```

In `beforeEach`, add `h.canPublish.mockReturnValue(true);`.

Replace the publish describe block with:

```js
describe('POST /programs/publish (submit to review)', () => {
  it('submits the workspace manifest + image ref through the review gate', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'pending_review' });

    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'reg.io/me/tool:1' }, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.submitForReview).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }));
    const body = await res.json();
    expect(body.submission).toMatchObject({ versionId: 'ver1', reviewState: 'pending_review' });
  });

  it('rejects publish when canPublish is false (entitlement, 403)', async () => {
    h.canPublish.mockReturnValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.submitForReview).not.toHaveBeenCalled();
  });

  it('rejects publish for a plain member (workspace write, 403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.submitForReview).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no workspace manifest to submit', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });

  it('surfaces a rejected result (still 200, body carries the reasons)', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run x' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'rejected', reasons: [{ code: 'host_escape' }] });
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'x' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submission.reviewState).toBe('rejected');
    expect(body.submission.reasons[0].code).toBe('host_escape');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run programRoutes --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — the publish route still calls `publishProgram` (not `submitForReview`); `canPublish` not wired.

- [ ] **Step 3: Rewrite the publish route**

`synthi/src/app/api/workspace/[slug]/programs/publish/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { canPublish } from '@/lib/programs/entitlements';
import { submitForReview } from '@/lib/programs/reviewOrchestrator';
import { discoverManifest } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/publish
// Owner/admin (+ canPublish): submit this workspace's recipe + image ref to the
// review gate. The version is NOT listed until it reaches `published`.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!canPublish(actor)) {
    return NextResponse.json({ error: 'publish_not_entitled' }, { status: 403 });
  }

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const sourceImageRef = typeof body.sourceImageRef === 'string' && body.sourceImageRef.trim() ? body.sourceImageRef.trim() : null;

  let discovered;
  try {
    discovered = await discoverManifest(slug, actor.workspaceUserId);
  } catch (error) {
    if (error?.name === 'ProgramManifestError') {
      return NextResponse.json({ error: 'manifest_invalid', code: error.code, field: error.field, message: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' }, { status: 502 });
  }
  if (!discovered) {
    return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
  }

  const submission = await submitForReview({
    workspaceSlug: slug,
    config: discovered.config,
    sourceImageRef,
    submittedByUserId: actor.userId,
  });

  return NextResponse.json({ submission });
}
```

- [ ] **Step 4: Add the status route + store helper, then test**

Create `synthi/src/app/api/workspace/[slug]/programs/submissions/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listSubmissionsForWorkspace, toReviewQueueItem } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/submissions
// Member-readable: this workspace's submissions + their review state (redacted).
export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const rows = await listSubmissionsForWorkspace(slug);
  return NextResponse.json({ submissions: rows.map(toReviewQueueItem) });
}
```

Add to `store.js`:

```js
/** List a workspace's submitted versions (any review state) for the status view. */
export async function listSubmissionsForWorkspace(workspaceSlug) {
  return prisma.programVersion.findMany({
    where: { program: { publisher: workspaceSlug } },
    orderBy: { submittedAt: 'desc' },
    include: { program: true },
  });
}
```

Add a submissions test to `programRoutes.test.js` (import `GET as GET_SUBMISSIONS from '../submissions/route.js'`; add `listSubmissionsForWorkspace: h.listSubmissionsForWorkspace` to the store mock):

```js
describe('GET /programs/submissions', () => {
  it('lists the workspace submissions (redacted) for a member', async () => {
    h.listSubmissionsForWorkspace.mockResolvedValue([{ id: 'ver1', reviewState: 'pending_review', manifestJson: '{"env":{"SECRET":"x"}}', program: { packageId: '@team/tool' } }]);
    const res = await GET_SUBMISSIONS(req('http://x/api/workspace/team/programs/submissions'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submissions[0]).toMatchObject({ versionId: 'ver1', reviewState: 'pending_review' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });
});
```

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run programRoutes --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (updated publish + new submissions tests; other route tests unaffected).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/app/api/workspace/[slug]/programs/publish/route.js synthi/src/app/api/workspace/[slug]/programs/submissions/route.js synthi/src/lib/programs/store.js synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): submit-to-review + status API routes (canPublish-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Admin review queue API (platform-admin only)

`GET /api/admin/program-reviews` lists the pending queue; `POST /api/admin/program-reviews/[versionId]` approves/rejects. Both gated by `isPlatformAdmin`. Approve/reject delegate to the orchestrator; self-approval is blocked there and surfaced as 403.

**Files:**
- Create: `synthi/src/app/api/admin/program-reviews/route.js`
- Create: `synthi/src/app/api/admin/program-reviews/[versionId]/route.js`
- Test: `synthi/src/app/api/admin/program-reviews/__tests__/adminReviewRoutes.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  isPlatformAdmin: vi.fn(),
  listPendingReview: vi.fn(),
  toReviewQueueItem: vi.fn((r) => ({ versionId: r.id, reviewState: r.reviewState })),
  approveSubmission: vi.fn(),
  rejectSubmission: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/programs/entitlements', () => ({ isPlatformAdmin: h.isPlatformAdmin, canPublish: vi.fn() }));
vi.mock('@/lib/programs/store', () => ({ listPendingReview: h.listPendingReview, toReviewQueueItem: h.toReviewQueueItem }));
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ approveSubmission: h.approveSubmission, rejectSubmission: h.rejectSubmission }));

import { GET as GET_QUEUE } from '../route.js';
import { POST as POST_REVIEW } from '../[versionId]/route.js';

const req = (url, body, method = 'GET') => ({ url, method, json: async () => body });
const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'admin1', email: 'admin@y.io' });
  h.isPlatformAdmin.mockReturnValue(true);
});

describe('GET /admin/program-reviews', () => {
  it('lists the pending queue (redacted) for a platform admin', async () => {
    h.listPendingReview.mockResolvedValue([{ id: 'ver1', reviewState: 'pending_review' }]);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue[0]).toMatchObject({ versionId: 'ver1' });
  });

  it('rejects a non-admin (403)', async () => {
    h.isPlatformAdmin.mockReturnValue(false);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(403);
    expect(h.listPendingReview).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated (401)', async () => {
    h.actor.mockResolvedValue(null);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(401);
  });
});

describe('POST /admin/program-reviews/[versionId]', () => {
  it('approves via the orchestrator', async () => {
    h.approveSubmission.mockResolvedValue({ versionId: 'ver1', reviewState: 'published' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(200);
    expect(h.approveSubmission).toHaveBeenCalledWith({ versionId: 'ver1', adminUserId: 'admin1' });
    expect((await res.json()).result.reviewState).toBe('published');
  });

  it('rejects via the orchestrator with notes', async () => {
    h.rejectSubmission.mockResolvedValue({ versionId: 'ver1', reviewState: 'rejected' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'reject', notes: 'nope' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(200);
    expect(h.rejectSubmission).toHaveBeenCalledWith({ versionId: 'ver1', adminUserId: 'admin1', notes: 'nope' });
  });

  it('maps self_review_forbidden to 403', async () => {
    h.approveSubmission.mockResolvedValue({ error: 'self_review_forbidden' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(403);
  });

  it('rejects a non-admin (403) before doing anything', async () => {
    h.isPlatformAdmin.mockReturnValue(false);
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(403);
    expect(h.approveSubmission).not.toHaveBeenCalled();
  });

  it('400 on an unknown action', async () => {
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'frobnicate' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run adminReviewRoutes --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — route modules don't exist.

- [ ] **Step 3: Write the routes**

`synthi/src/app/api/admin/program-reviews/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { isPlatformAdmin } from '@/lib/programs/entitlements';
import { listPendingReview, toReviewQueueItem } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/admin/program-reviews — platform-admin only: the pending_review queue.
export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(actor)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const rows = await listPendingReview();
  return NextResponse.json({ queue: rows.map(toReviewQueueItem) });
}
```

`synthi/src/app/api/admin/program-reviews/[versionId]/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { isPlatformAdmin } from '@/lib/programs/entitlements';
import { approveSubmission, rejectSubmission } from '@/lib/programs/reviewOrchestrator';

export const runtime = 'nodejs';

// POST /api/admin/program-reviews/:versionId  body {action:'approve'|'reject', notes?}
export async function POST(req, { params }) {
  const { versionId } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(actor)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const action = body.action;

  let result;
  if (action === 'approve') {
    result = await approveSubmission({ versionId, adminUserId: actor.userId });
  } else if (action === 'reject') {
    result = await rejectSubmission({ versionId, adminUserId: actor.userId, notes: typeof body.notes === 'string' ? body.notes : '' });
  } else {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }

  if (result?.error === 'self_review_forbidden') return NextResponse.json({ error: 'self_review_forbidden' }, { status: 403 });
  if (result?.error === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (result?.error) return NextResponse.json({ error: result.error, reviewState: result.reviewState }, { status: 409 });
  return NextResponse.json({ result });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run adminReviewRoutes --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/app/api/admin/program-reviews
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): admin review queue API (platform-admin approve/reject)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: First-publish tutorial overlay

A one-time guided overlay shown the first time a user opens the publish flow, gated on a per-user `localStorage` flag (D3). Pure presentational + a tiny hook; tested with the existing jsdom/RTL setup.

**Files:**
- Create: `synthi/src/components/programs/FirstPublishTutorial.jsx`
- Test: `synthi/src/components/programs/__tests__/firstPublishTutorial.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstPublishTutorial, firstPublishSeenKey } from '../FirstPublishTutorial';

beforeEach(() => { window.localStorage.clear(); });

describe('FirstPublishTutorial', () => {
  it('renders the guided steps the first time for a user', () => {
    render(<FirstPublishTutorial userId="u1" open onClose={() => {}} />);
    expect(screen.getByText(/bring a pullable image/i)).toBeTruthy();
    expect(screen.getByText(/what we check/i)).toBeTruthy();
  });

  it('does not render once the per-user seen flag is set', () => {
    window.localStorage.setItem(firstPublishSeenKey('u1'), '1');
    const { container } = render(<FirstPublishTutorial userId="u1" open onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('sets the seen flag and calls onClose when dismissed via the CTA', () => {
    const onClose = vi.fn();
    render(<FirstPublishTutorial userId="u1" open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /start publishing/i }));
    expect(window.localStorage.getItem(firstPublishSeenKey('u1'))).toBe('1');
    expect(onClose).toHaveBeenCalled();
  });

  it('keys the flag per user (a different user still sees it)', () => {
    window.localStorage.setItem(firstPublishSeenKey('u1'), '1');
    render(<FirstPublishTutorial userId="u2" open onClose={() => {}} />);
    expect(screen.getByText(/bring a pullable image/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run firstPublishTutorial --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: FAIL — `Failed to resolve import "../FirstPublishTutorial"`.

- [ ] **Step 3: Write the component**

```jsx
'use client';

import { useState } from 'react';

/** Per-user localStorage key for "has seen the first-publish tutorial". */
export function firstPublishSeenKey(userId) {
  return `vectant.programs.firstPublishSeen.${userId || 'anon'}`;
}

const STEPS = [
  { title: 'Bring a pullable image', body: 'Push your app image to a registry we can pull (e.g. ghcr.io / Docker Hub). Web/CLI apps need only a manifest — no image.' },
  { title: 'We review every submission', body: 'Automated hard gates + a CVE scan run first, then a human reviews it. Updates re-run the full review.' },
  { title: 'What we check', body: 'Manifest validity, requested scopes, host-escape attempts, and known CVEs. We re-host approved images into our registry pinned by digest, so installers run exactly what we reviewed.' },
  { title: 'Timelines', body: 'Most reviews complete within a few business days. You can track status from the Programs panel.' },
];

/**
 * One-time guided overlay for the publish flow. Renders nothing once the
 * per-user seen flag is set. Calling the CTA sets the flag + invokes onClose.
 */
export function FirstPublishTutorial({ userId, open, onClose }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem(firstPublishSeenKey(userId)) === '1'; } catch { return false; }
  });
  if (!open || dismissed) return null;

  const finish = () => {
    try { window.localStorage.setItem(firstPublishSeenKey(userId), '1'); } catch { /* ignore */ }
    setDismissed(true);
    if (onClose) onClose();
  };

  return (
    <div role="dialog" aria-label="Publishing a community app" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary, #e8e8ea)', maxWidth: 520, padding: 24, borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Publishing a community app</h2>
        <ol style={{ paddingLeft: 18, display: 'grid', gap: 12 }}>
          {STEPS.map((s) => (
            <li key={s.title}>
              <strong>{s.title}</strong>
              <div style={{ opacity: 0.8 }}>{s.body}</div>
            </li>
          ))}
        </ol>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={finish}>Start publishing</button>
        </div>
      </div>
    </div>
  );
}

export default FirstPublishTutorial;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd synthi; $env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'; npx vitest run firstPublishTutorial --pool=forks --no-file-parallelism --maxWorkers=1`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/components/programs/FirstPublishTutorial.jsx synthi/src/components/programs/__tests__/firstPublishTutorial.test.jsx
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): first-publish tutorial overlay (one-time, per-user)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Full-suite verification + node --check

- [ ] **Step 1: Run the whole programs test surface**

Run (one filter at a time to stay within the single-fork constraint):
```
cd synthi
$env:TEMP='D:\synthi-tmp'; $env:TMP='D:\synthi-tmp'; $env:TMPDIR='D:\synthi-tmp'
npx vitest run programs --pool=forks --no-file-parallelism --maxWorkers=1
npx vitest run adminReviewRoutes --pool=forks --no-file-parallelism --maxWorkers=1
npx vitest run programRoutes --pool=forks --no-file-parallelism --maxWorkers=1
```
Expected: all green.

- [ ] **Step 2: Syntax-check the new route files (no `next build` — disk gate)**

Run:
```
node --check synthi/src/app/api/workspace/[slug]/programs/publish/route.js
node --check synthi/src/app/api/admin/program-reviews/route.js
node --check "synthi/src/app/api/admin/program-reviews/[versionId]/route.js"
```
Expected: no output (exit 0) for each.

- [ ] **Step 3: Security-invariant checklist (map each to its passing test)**

Confirm each invariant has a green test (no new code — this is verification):
- Hard gates fail-closed → `hardGates.test.js` (schema/scope/host-escape/metadata) + `reviewOrchestrator.test.js` (CVE→rejected).
- Host-escape denied (docker.sock/mounts/privileged/cap-add/security-opt/device) → `hostEscape.test.js` + `hardGates.test.js`.
- Re-host pins by digest; published manifest references AR digest → `reHoster.test.js` + `reviewOrchestrator.test.js` (approve pins) + `store.test.js` (`getPublishedProgramVersion` only serves published).
- Update re-runs gate; old digest stays live → `store.test.js` (`createSubmission` doesn't touch `publishedVersion`; `publishApprovedVersion` flips it only on publish).
- Admin-only + no self-approval → `adminReviewRoutes.test.js` (403 non-admin) + `reviewOrchestrator.test.js` (self_review_forbidden).
- `canPublish` gates submit → `programRoutes.test.js` (canPublish=false → 403).
- Scan/AI reports redacted → `imageScanner.test.js` (no paths) + `store.test.js` (`toReviewQueueItem` no SECRET) + `programRoutes.test.js` (submissions no SECRET).

- [ ] **Step 4: Final commit (if any test-file tweaks were needed in Step 1)**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add -A
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "test(programs): green full review-gate suite + invariant coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes (author pass)

- **Spec coverage:** state machine → Tasks 7/8; data model → Task 1; the 7 components map to Tasks 2-11 (submissionStore=7, hardGates=3, imageScanner=4, reHoster=5, reviewOrchestrator=8, manualReviewQueue=10, publish API + canPublish=9, first-publish tutorial=11). Phase-2 `aiReviewer` intentionally omitted; `aiRiskJson` + the `ai_review` state value exist as clean seams.
- **All 7 security invariants** are individually test-pinned (Task 12 Step 3 maps each).
- **Type consistency:** `reviewState` string values are identical across schema, store, orchestrator, tests. `transitionReview({fromState,toState,actorUserId,reason,patch})`, `publishApprovedVersion(versionId,{programId,version,actorUserId,hostedImageDigest,publishedManifestJson})`, `reHostImage(src,target,{runner})→{ref,digest}`, `pinManifestImage(config,srcRef,arRef)`, `runHardGates({config,sourceImageRef})→{ok,reasons}`, `scanImage(ref,{threshold,runner})→{ok,summary}` are used consistently in every consumer.
- **Out of scope (not built):** AI auto-approve, build-from-source, paywall impl, runtime hardening — matches the spec.
- **Known follow-ups (not Phase 1):** wiring the `FirstPublishTutorial` + a submission-status panel into `ProgramsPanel`/`StoreView` UI (the component + status API exist; surfacing them is a small UI task); a minimal admin queue UI page consuming `/api/admin/program-reviews` (API is complete and testable now).
