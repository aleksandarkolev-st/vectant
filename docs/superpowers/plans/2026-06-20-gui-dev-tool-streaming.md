# GUI Dev-Tool Streaming + AI Command Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (inline) or
> superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.
> Spec: `docs/superpowers/specs/2026-06-20-gui-dev-tool-streaming-design.md`.

**Goal:** Run curated, kiosk-locked third-party GUI dev tools (DBeaver first) streamed into the workspace
via KasmVNC over the slice-1 port proxy, and let the AI operate the program domain via MCP command tools.

**Architecture:** A GUI tool = a single-app KasmVNC container run in the user's Sysbox dind (slice-1
launch flow); its web port is surfaced in the App tab via `/runtime/<scope>/port/N`. The MCP gains
command-level tools (`exec_in_runtime`, `launch_program`, `list_programs`, `read_session`). Worker/compile
pipeline untouched. Flag-/marker-gated; default off ⇒ no behavior change.

**Tech Stack:** Docker (Debian-slim + KasmVNC), Node (collab-server, `node:test`), Next.js/React +
vitest (frontend), TypeScript MCP server (`@modelcontextprotocol/sdk`, vitest), GKE Sysbox (live gate).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/gui-images/gui-base/Dockerfile` | Debian-slim + KasmVNC + single-app kiosk launcher | create |
| `backend/gui-images/dbeaver/Dockerfile` | `gui-base` + DBeaver CE + JRE | create |
| `backend/gui-images/gui-base/entrypoint.sh` | start Xvfb+KasmVNC, run the one app fullscreen, exit-on-app-exit | create |
| `synthi/src/lib/programs/manifest.js` | normalize new `webGui` boolean | modify |
| `synthi/src/lib/programs/manifest.test.js` (or existing test) | `webGui` normalization tests | modify/create |
| `backend/collab-server/programRuntimeManager.js` | carry `webGui` onto the session record | modify |
| `backend/collab-server/__tests__/programRuntimeManager.test.js` | `webGui` threading test | modify |
| `backend/collab-server/proxyService.js` | verify `/runtime/<scope>/port/N` WS upgrade covers KasmVNC | verify/modify |
| `synthi/src/components/programs/ProgramSessionPanel.jsx` | full-panel interactive surface when `webGui` | modify |
| `mcp/synthi-mcp/src/tools/programs.ts` | `exec_in_runtime`/`list_programs`/`launch_program`/`read_session` | create |
| `mcp/synthi-mcp/src/server.ts` | register the program tools | modify |
| (recipe seed — locate at F1) | register `@vectant/dbeaver` recipe with `webGui:true` | modify |
| `tasks/todo.md` | visual-driving forward-plan + recurring callout | modify |

---

## Group B — backend: `webGui` marker + session threading (do FIRST; pure TDD)

### Task B1: `webGui` manifest field
**Files:** Modify `synthi/src/lib/programs/manifest.js`; Test `synthi/src/lib/programs/manifest.test.js`.
- [ ] **Step 1 — failing test:** assert a manifest with `"webGui": true` on a `container` program
  normalizes to `webGui: true`, and that it defaults to `false` when absent / coerces non-bool to false.
- [ ] **Step 2 — run, expect fail** (`cd synthi && npx vitest run src/lib/programs/manifest`).
- [ ] **Step 3 — implement:** in the program normalizer, read `webGui` as a strict boolean (default
  false); only meaningful for `runtimeType: 'container'` (ignore/false otherwise). Keep fail-closed style.
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** (`feat(programs): webGui manifest marker`).

### Task B2: thread `webGui` onto the session
**Files:** Modify `backend/collab-server/programRuntimeManager.js`; Test `__tests__/programRuntimeManager.test.js`.
- [ ] **Step 1 — failing test:** launching a managed session for a `container` program with `webGui:true`
  yields a public session with `webGui: true`; absent ⇒ falsy.
- [ ] **Step 2 — run, expect fail** (`node --test --test-timeout=20000 backend/collab-server/__tests__/programRuntimeManager.test.js`).
- [ ] **Step 3 — implement:** carry `webGui` from the launch request/manifest onto the managed record and
  `toPublicManagedSession`.
- [ ] **Step 4 — run, expect pass.** Then full backend suite green.
- [ ] **Step 5 — commit** (`feat(collab): carry webGui onto program session`).

## Group C — proxy WS-upgrade (verify; mostly exists)

### Task C1: confirm runtime-scoped WS upgrade
**Files:** `backend/collab-server/proxyService.js` (+ its test file).
- [ ] **Step 1 — read** `proxyWsUpgrade` (≈ line 691) + the `/runtime/<scope>/port/N` parse; confirm WS
  upgrade resolves the runtime scope (not just legacy `/port/N`).
- [ ] **Step 2 — failing/ë­characterization test:** a WS upgrade to `/runtime/<scope>/port/<N>` routes to the
  scoped runtime target. If coverage exists, extend it for the runtime path.
- [ ] **Step 3 — implement** only if a gap exists (else no-op + note "already supported").
- [ ] **Step 4 — run tests.**
- [ ] **Step 5 — commit** if changed (`fix(proxy): runtime-scoped WS upgrade for GUI streams`).

## Group A — GUI container images (build + kiosk-validate)

### Task A1: `@vectant/gui-base`
**Files:** Create `backend/gui-images/gui-base/{Dockerfile,entrypoint.sh}`.
- [ ] **Step 1 — write Dockerfile:** Debian-slim + KasmVNC + the absolute minimum (no DE, no WM menu, no
  xterm, no file manager, no browser). `entrypoint.sh` takes `$APP_CMD`, starts Xvfb + a bare single-window
  setup + KasmVNC (per-session credential from env), launches `$APP_CMD` fullscreen as the sole client,
  and exits when it exits.
- [ ] **Step 2 — build:** `docker build -t vectant-gui-base:dev backend/gui-images/gui-base`.
- [ ] **Step 3 — kiosk assertions (the "test"):** run with `APP_CMD=xclock` (temp), confirm KasmVNC serves
  its port; assert there is **no** terminal/file-manager/desktop binary and no WM root menu (no way to spawn
  another app); confirm app-exit ends the container.
- [ ] **Step 4 — commit** (`feat(gui): @vectant/gui-base kiosk KasmVNC image`).

### Task A2: `@vectant/dbeaver`
**Files:** Create `backend/gui-images/dbeaver/Dockerfile`.
- [ ] **Step 1 — write Dockerfile:** `FROM vectant-gui-base` + DBeaver CE + JRE; `APP_CMD` = DBeaver.
- [ ] **Step 2 — build + run:** confirm DBeaver renders via KasmVNC; closing DBeaver ends the container;
  re-confirm no escape to a shell/desktop.
- [ ] **Step 3 — commit** (`feat(gui): @vectant/dbeaver image`).
- [ ] **Step 4 — (prod) push digest-pinned to AR + add to cloudbuild trivy list** — note as a follow-up if
  not building prod images now.

## Group D — frontend: App-tab interactive surface

### Task D1: full-panel KasmVNC surface when `webGui`
**Files:** Modify `synthi/src/components/programs/ProgramSessionPanel.jsx`; Test alongside.
- [ ] **Step 1 — failing test:** when `session.webGui` is true and a web port is attributed, the App tab
  renders the interactive GUI surface (full-panel iframe to `getProgramSessionAppUrl(...)`) with a
  fullscreen control + focus capture — not the plain web-iframe path and not the "GUI stream surface" stub.
- [ ] **Step 2 — run, expect fail** (`cd synthi && npx vitest run src/components/programs`).
- [ ] **Step 3 — implement:** branch on `session.webGui` to the interactive surface; keyboard-focus capture
  + fullscreen toggle. (KasmVNC handles input/clipboard/resize internally.)
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** (`feat(programs): interactive GUI surface for webGui sessions`).

## Group E — MCP command-level tools

### Task E1: `exec_in_runtime`
**Files:** Create `mcp/synthi-mcp/src/tools/programs.ts`; Modify `mcp/synthi-mcp/src/server.ts`; Test under `mcp/synthi-mcp/tests/`.
- [ ] **Step 1 — read** `server.ts` ListTools (≈1162) + CallTool (≈1355) + an existing tool (`tools/attach.ts`) for the pattern.
- [ ] **Step 2 — failing test:** `exec_in_runtime({command})` returns `{stdout,stderr,exitCode}` by calling the collab-server runtime-exec endpoint (mock the HTTP/exec boundary).
- [ ] **Step 3 — run, expect fail** (`cd mcp/synthi-mcp && npx vitest run tests/unit`).
- [ ] **Step 4 — implement** the tool + register in ListTools/CallTool; exec via the existing collab-server runtime-exec path for the attached workspace.
- [ ] **Step 5 — run, expect pass; commit** (`feat(mcp): exec_in_runtime tool`).

### Task E2: `list_programs` / `launch_program` / `read_session`
**Files:** same.
- [ ] **Step 1 — failing tests** for each tool's contract (mock the collab-server program endpoints).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement** the three tools (call the existing program-session/launch endpoints) + register.
- [ ] **Step 4 — run, expect pass; commit** (`feat(mcp): list/launch/read program tools`).

## Group F — recipe registration

### Task F1: `@vectant/dbeaver` recipe
- [ ] **Step 1 — locate** the recipe/marketplace seed (grep `@vectant/lazygit` — the existing example).
- [ ] **Step 2 — add** the `@vectant/dbeaver` recipe: `runtimeType: container`, `webGui: true`, the
  digest-pinned image + the single web port; mirror the lazygit recipe's shape.
- [ ] **Step 3 — test** (catalog lists it; normalizes with `webGui:true`); **commit**.

## Group G — verification + wrap

### Task G1: live e2e (scratch Sysbox cluster)
- [ ] Re-spin scratch cluster (`k8s/sysbox/create-scratch-cluster.ps1`, pd-standard); push the dbeaver image
  to AR digest-pinned; launch DBeaver → renders in App tab → interact → **confirm no desktop/shell escape**;
  MCP `exec_in_runtime` runs `docker`/SQL; idle-cull; **tear down**, confirm prod-only.

### Task G2: wrap
- [ ] Both suites green; `node --check` touched modules; hardcoded-values audit; update `tasks/lessons.md`;
  plain-words recap; push.

---

## Self-review
- **Spec coverage:** §4.1→A1, §4.2→A2, §4.3→B1/B2, §4.4→C1, §4.5→D1, §4.6→E1/E2, recipe→F1, §6 kiosk→A1/A2 assertions, §7 testing→per-task + G1, §11 gate→G1/G2. Visual-driving §10 → `tasks/todo.md` (separate, not a task here). No gaps.
- **Placeholders:** infra code (Dockerfiles, recipe JSON, MCP tool bodies) is finalized during TDD against
  the real files (this plan's author is the executor); test intent + file anchors are concrete.
- **Naming consistency:** `webGui` used uniformly (manifest → session → panel → recipe).
