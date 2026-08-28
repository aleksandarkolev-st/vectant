# Slice 3 Phase 4 (Thin Slice) — GUI Runtime Type + Stubbed Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `gui` runtime type first-class in the manifest + Program-tab UX (un-defer it, derive its surfaces, render a stubbed GUI stream surface), so GUI programs install/launch/manage like any other — while the real WebRTC/broker visual capture is deferred to a documented TODO (its own broker-companion branch).

**Architecture:** This is the **TDD-able sliver** of Phase 4. `manifest.js` stops rejecting `runtimeType: 'gui'` and derives an `app` surface for it; `ProgramSessionPanel` routes a `gui` session's App tab to a stubbed GUI surface shell (placeholder for the future `<video>` element) instead of the web iframe. No live media, no WebRTC, no broker wiring — those are listed in the **Deferred** section below and intentionally left out.

**Tech Stack:** Next.js/React (`synthi/`, Vitest from the `synthi/` dir; jsdom via `react-dom/client` + `act`). Pure-JS manifest lib.

**Constraints (carried from Phases 1–3):**
- Branch `tool-compatibility` only — no branch/merge/PR/finish.
- Disk gate: **TDD only** (`vitest` / `node --test` / `prisma generate|db push`). NO `next build` / `docker build`.
- No Prisma schema change (`ProgramSession.runtimeType` already stores the type).
- Run `@/`-dependent suites from `synthi/` (vitest v4.1.8 has the alias). `cd` explicitly each Bash call.
- Stage specific files only (never `git add -A`). Every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Do not touch the known pre-existing dirty/untracked noise files.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/src/lib/programs/manifest.js` | Accept `gui` in `SUPPORTED_RUNTIME_TYPES`; derive its surfaces | Modify |
| `synthi/src/lib/programs/__tests__/manifest.test.js` | Flip the gui-rejection test → acceptance; assert surfaces | Modify |
| `synthi/src/components/programs/ProgramSessionPanel.jsx` | Route `runtimeType==='gui'` App tab to a stubbed GUI surface shell | Modify |
| `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx` | gui-surface render test | Modify |
| `tasks/todo.md` | Phase-4 (thin) checklist + review | Modify |

**Contract notes:**
- `normalizeRuntimeType('gui')` returns `'gui'` (no longer throws `unsupported_runtime`).
- `deriveSurfaces` for `gui` yields `['app','logs','terminal','health','settings']` (the `app` surface is the GUI stream view; `ports` only appears if the program also declares ports). `devcontainer.js` is unchanged — it has no `gui` signal and can only ever produce `web`/`background`, so GUI programs come exclusively from `synthi.program.json`.
- The panel keys off `session.runtimeType` (already persisted on the DB row and surfaced via the `...session` spread in `mergeProgramSession`); no backend/snapshot change is needed for the stub.

---

## Task 1: Un-defer the `gui` runtime type in the manifest

**Files:**
- Modify: `synthi/src/lib/programs/manifest.js`
- Test: `synthi/src/lib/programs/__tests__/manifest.test.js`

- [ ] **Step 1: Flip the existing rejection test to an acceptance test**

In `synthi/src/lib/programs/__tests__/manifest.test.js`, replace the existing block (currently lines ~142-148):

```js
  it('rejects the gui runtimeType (deferred to Phase 4)', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', runtimeType: 'gui' }),
      'unsupported_runtime',
      'runtimeType',
    );
  });
```

with:

```js
  it('accepts the gui runtimeType and derives an app (stream) surface', () => {
    const cfg = parseProgramManifest({ packageId: 'paint', version: '1.0.0', launch: 'xeyes', runtimeType: 'gui' });
    expect(cfg.runtimeType).toBe('gui');
    expect(cfg.surfaces).toContain('app');
    expect(cfg.surfaces).toContain('logs');
    expect(cfg.surfaces).toContain('settings');
  });

  it('still rejects an unknown runtimeType', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', runtimeType: 'wat' }),
      'invalid_field',
      'runtimeType',
    );
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/manifest.test.js`
Expected: FAIL — the gui case throws `unsupported_runtime` (so `cfg` is never assigned and `runtimeType`/`surfaces` assertions never run). The unknown-runtime case should already PASS.

- [ ] **Step 3: Implement — allow `gui` and derive its surface**

3a. In `synthi/src/lib/programs/manifest.js`, add `'gui'` to the supported list and update the comment:

```js
/** Runtime types the program runtime can manage. */
export const SUPPORTED_RUNTIME_TYPES = ['web', 'cli', 'tui', 'background', 'gui'];
```

3b. Remove the special-case rejection in `normalizeRuntimeType` so `gui` flows through the normal allow-list check:

```js
export function normalizeRuntimeType(rt, field = 'runtimeType') {
  if (rt == null) return 'cli';
  if (!SUPPORTED_RUNTIME_TYPES.includes(rt)) {
    throw new ProgramManifestError('invalid_field', `Invalid ${field} '${rt}'`, field);
  }
  return rt;
}
```

3c. In `deriveSurfaces`, give `gui` an `app` (stream) surface even without ports:

```js
function deriveSurfaces(runtimeType, ports) {
  const out = [];
  if (ports.length > 0 || runtimeType === 'gui') out.push('app');
  out.push('logs');
  if (runtimeType !== 'background') out.push('terminal');
  if (ports.length > 0) out.push('ports');
  out.push('health', 'settings');
  return out;
}
```

- [ ] **Step 4: Run to verify the manifest suite passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/manifest.test.js`
Expected: PASS — all manifest tests, including the new gui-acceptance + unknown-rejection cases.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/programs/manifest.js "synthi/src/lib/programs/__tests__/manifest.test.js"
git commit -m "feat(slice3-p4): un-defer the gui runtime type in the manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Stubbed GUI surface shell in the Program tab

**Files:**
- Modify: `synthi/src/components/programs/ProgramSessionPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx`

- [ ] **Step 1: Write the failing test**

Append to `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx` (inside the describe block, before its closing `});`):

```js
  it('renders a stubbed GUI surface for a gui runtime instead of the web iframe', async () => {
    h.fetchProgramSession.mockResolvedValue({ id: 'ps-1', state: 'running', runtimeType: 'gui', activePorts: [], webPort: null });
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, { workspaceSlug: 'team', sessionId: 'ps-1', title: 'Paint' }));
    });
    await flush();

    const gui = container.querySelector('[data-testid="gui-surface"]');
    expect(gui).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-testid="app-waiting"]')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/ProgramSessionPanel.test.jsx`
Expected: FAIL — `gui-surface` testid is null (a gui session with no webPort currently falls into the "No web port is active" branch).

- [ ] **Step 3: Implement the GUI surface routing**

3a. In `synthi/src/components/programs/ProgramSessionPanel.jsx`, add a `runtimeType` derived value next to the other derived state (where `healthState`/`isStarting` are defined):

```js
  const runtimeType = session?.runtimeType || 'cli';
```

3b. In the App-tab body, branch on `gui` BEFORE the `appUrl` check. Change the opening of the App-tab block from:

```jsx
        ) : activeTab === 'app' ? (
          appUrl ? (
```

to:

```jsx
        ) : activeTab === 'app' ? (
          runtimeType === 'gui' ? (
            <div data-testid="gui-surface" className="h-full flex flex-col items-center justify-center gap-2 text-sm px-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <Globe className="w-5 h-5 opacity-60" />
              <div>GUI stream surface</div>
              <div className="text-xs">Live visual capture (WebRTC via the broker) is not yet wired — coming in a later phase.</div>
            </div>
          ) : appUrl ? (
```

(The existing `appUrl ? <iframe> : isStarting ? <app-waiting> : <no-port>` chain stays intact as the `else` of the new `gui` branch — i.e. only the leading `appUrl ? (` becomes `) : appUrl ? (`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/ProgramSessionPanel.test.jsx`
Expected: PASS — all panel tests (the 5 existing + the new gui-surface test = 6).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/ProgramSessionPanel.jsx "synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx"
git commit -m "feat(slice3-p4): stubbed GUI surface shell for gui-runtime program tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Regression + review

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Targeted suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs src/components/programs`
Expected: PASS — manifest + panel suites green (manifest +1 net test; panel 6).

- [ ] **Step 2: Backend unchanged — sanity check**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — 21 (unchanged; no backend edits this phase).

- [ ] **Step 3: Full regression**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run`
Expected: PASS — accept ONLY the known empty `src/lib/__tests__/preview-store.test.js` stub failure.

- [ ] **Step 4: Write the Phase-4 (thin) review + mark tasks in `tasks/todo.md`**

Record: what landed (gui runtime type + stub surface), verification numbers, and an explicit pointer to the **Deferred** section below. Check off P4-T1..P4-T3. Commit:

```bash
git add tasks/todo.md
git commit -m "docs(slice3-p4): thin GUI slice complete — gui runtime type + stub surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## DEFERRED — Broker / WebRTC GUI capture (revisit later, broker-companion branch)

> This is the **heavy, non-TDD-able** remainder of Phase 4. It needs live infra (Xvfb/GStreamer, the
> Rust WebRTC worker, the signaling-server, a real browser peer) and depends on the broker rollout
> (`docs/AGENT_MCP_BROKER_ROLLOUT_PLAN.md`). It should run with the disk gate lifted and likely on its
> own branch (per the Slice-3 spec, §"Implementation Notes"). Captured here so we can resume cleanly.

**Backend / capture pipeline (`backend/collab-server` + `backend/synthi-webrtc-compiler/worker`):**
- [ ] Launch a `gui` program under a virtual display (Xvfb) inside the workspace runtime; pipe its X output into the existing GStreamer → WebRTC capture path (`worker/src/runtime/window_backend.rs`, `backends/*`).
- [ ] Allocate a WebRTC peer/track for the session via `worker/src/webrtc/peer_registry.rs` + `track_fanout.rs`; expose a session→peer mapping the collab-server can hand to the frontend.
- [ ] Wire signaling through `backend/synthi-webrtc-compiler/signaling-server` so the browser can negotiate the stream for a `programSessionId`.

**Broker integration (`AGENT_MCP_BROKER_ROLLOUT_PLAN.md`):**
- [ ] Route the `gui` session's visual stream through the broker (single upstream producer per session; fanout to subscribers).
- [ ] Consume the broker lease/freshness model for **input** (`worker/src/webrtc/input_lease.rs`): no state-changing input without a valid lease; reject input on stale frames (frame_seq/lease_id/ack chain per the broker contracts).
- [ ] Surface broker `recovering` state; the frontend GUI surface must fail closed while recovering.

**Frontend (`ProgramSessionPanel.jsx` + a new GUI surface component):**
- [ ] Replace the stub `gui-surface` shell with a live `<video>` element bound to the negotiated WebRTC stream; show frame/health/lease status.
- [ ] Implement input forwarding (pointer/keyboard) gated on a held lease, with stale-frame guards.

**Runtime snapshot / contracts:**
- [ ] Add a `guiStream` descriptor (peer id, signaling endpoint, lease state) to the runtime snapshot + `mergeProgramSession`, redaction-checked like the rest.

**Tests (need live infra — not the current disk gate):**
- [ ] Integration: gui launch → stream negotiated → frame received; lease acquire/deny; stale-frame input rejection; recovering-state fail-closed.
- [ ] Security: input requires a valid lease; no cross-session stream/lease leakage; snapshot never leaks signaling secrets.

---

## Self-Review

**1. Spec coverage** — This plan covers only the TDD-able sliver of Phase 4 (gui runtime type + stub surface), as agreed; the real "generalize GUI capture through the broker" work is fully enumerated in the Deferred section so nothing is lost.

**2. Placeholder scan** — every implementation step shows complete code; the only "stub" is intentional (the GUI surface shell) and explicitly labeled, not a plan gap.

**3. Type consistency** — `normalizeRuntimeType` returns `'gui'`; `deriveSurfaces('gui', ports)` includes `'app'`; the panel reads `session.runtimeType` and renders `data-testid="gui-surface"`; the test asserts the same testid. `SUPPORTED_RUNTIME_TYPES` is the single source consumed by both the manifest and (transitively) devcontainer reuse.

**4. Test independence** — manifest tests are pure; the panel test reuses the existing jsdom harness. No live media/WebRTC/Docker dependency in any test in this plan.
