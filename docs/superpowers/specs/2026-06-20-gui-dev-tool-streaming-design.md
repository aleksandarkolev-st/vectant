# Spec — GUI dev-tool streaming + AI command control (real-programs Slice 3)

> Status: approved design (brainstormed 2026-06-20). Next phase after this spec: `writing-plans` → TDD.
> Branch: `feat/docker-sysbox-engine`. Flag-gated; zero behavior change when off.

## 1. Goal & scope

Let a user run **real third-party GUI dev tools** (starting with **DBeaver**) inside the workspace,
streamed live and operated like on a local machine — *and* let the AI / in-runtime CLI agents drive
the program domain via **commands** ("open docker and run all containers", "manage my database").

**In scope (this slice):**
- A curated, per-app, **KasmVNC-in-container** GUI tool, surfaced through the existing slice-1
  `/runtime/<scope>/port/N` proxy. First tool: **DBeaver**.
- **Kiosk lockdown:** each GUI tool is a single-app container — no desktop, no launcher, no terminal,
  no file manager, no browser; the user can never escape the tool to any desktop/shell *from the stream*.
- **MCP command-level program control:** MCP tools so the external AI can list/launch programs and
  `exec` commands in the user's runtime (the in-runtime CLI agents already have this reach).

**Out of scope (deferred — see §10 + `tasks/todo.md`):**
- **Visual GUI driving by the AI** (the AI clicking/typing inside the streamed GUI) — full plan in §10,
  mirrored into `tasks/todo.md` as the explicit next step.
- Browsers, full desktops, arbitrary user-supplied GUI apps; WebRTC quality; audio; GPU.

## 2. Locked decisions (from the brainstorm)

1. **Per-app windowed** streaming, not a full desktop.
2. **Curated catalog** of containerized tools (app + bundled web streamer), not arbitrary apps (arbitrary = later slice).
3. **KasmVNC in-container**, surfaced via the slice-1 HTTP port proxy — *not* the worker WebRTC pipeline
   (reusing the worker pipeline would endanger the compile/preview flow; see the design discussion).
4. **DBeaver** is the first packaged tool. **No browser, no full desktop, ever.**
5. **AI control = commands/CLI first**; visual GUI driving is the documented next step.

## 3. Architecture

A "GUI tool" is a curated container (KasmVNC + the app, single-app kiosk) launched in the user's
per-workspace **Sysbox dind** — exactly like a slice-1 container program. KasmVNC serves a single web
port; the slice-1 runtime port monitor detects it; the App tab renders the KasmVNC client full-panel.
**The worker / compile pipeline is untouched.** In parallel, the **MCP** exposes launch + exec tools so
the AI can operate the program domain by running commands in that same runtime.

```
Programs catalog ─launch─▶ collab-server (slice-1 flow) ─docker run─▶  Sysbox dind
                                                                         └─ @vectant/dbeaver
                                                                              KasmVNC (1 web port, kiosk)
runtime port monitor ─detect─▶ session.activePorts ─▶ App tab ◀─proxy── /runtime/<scope>/port/N (WS)
chat AI ─MCP tools─▶ collab-server: list/launch/exec_in_runtime ─k8s-exec─▶ Sysbox dind (docker/SQL/scripts)
```

## 4. Components

### 4.1 `@vectant/gui-base` image (new; digest-pinned in AR)
glibc base (Debian-slim) + **KasmVNC** + a minimal **single-window launcher**. Contains *only* the
streamer + launch shim — **no** desktop environment, **no** window-manager menu, **no** terminal, **no**
file manager, **no** browser. An entrypoint takes the target app command, starts Xvfb + KasmVNC, and runs
the app as the **sole** X client, fullscreen; app exit ⇒ container exit. KasmVNC configured with a
**per-session generated credential** and (where supported) clipboard + dynamic-resize on.

### 4.2 `@vectant/dbeaver` recipe (new)
`gui-base` + DBeaver CE + a JRE. The recipe manifest declares: image (digest-pinned), the single web
port, `webGui: true`, and the kiosk app command. Launches via the slice-1 container flow.

### 4.3 `webGui` program marker
Extend the program manifest/schema with `webGui: true` (runtimeType `container`). Threaded through the
program session so `ProgramSessionPanel` renders the **interactive GUI surface** rather than a plain web
iframe. Default false ⇒ existing behavior unchanged.

### 4.4 Runtime proxy WebSocket upgrade
KasmVNC streams over websockets, so `/runtime/<scope>/port/N` (and the program App-URL proxy path) must
forward HTTP **Upgrade** for websockets. Verify the current runtime proxy path in
`backend/collab-server/proxyService.js`; add WS-upgrade handling if missing. (Unit/integration test the
upgrade path.)

### 4.5 App-tab GUI surface (frontend)
A full-panel KasmVNC client in `ProgramSessionPanel`'s App tab when `webGui`: an iframe of the KasmVNC
web client (via `getProgramSessionAppUrl(runtimeScope)`), with **keyboard-focus capture** and a
**fullscreen** toggle. KasmVNC handles input, clipboard, and resize internally, so the new UI is thin.

### 4.6 MCP command-level tools (`mcp/synthi-mcp`)
New tools exposing existing collab-server capabilities to the external AI:
- `list_programs` — catalog recipes + running program sessions for the attached workspace.
- `launch_program({ recipe })` — open a program via the slice-1 launch flow.
- `exec_in_runtime({ command })` — run a command in the user's Sysbox runtime (docker / SQL CLIs /
  scripts) via the existing k8s-exec path (`runtimePodTerminal`); returns stdout/stderr/exit.
- `read_session({ sessionId })` — session state + recent logs.

The in-runtime CLI agents (Claude Code, already in the runtime image) already run commands in-runtime;
these tools give the external AI the same reach. **No visual GUI input** in this slice.

## 5. Data flow
Catalog → "Open DBeaver" → slice-1 launch → `docker run @vectant/dbeaver` in the dind → KasmVNC serves
its port → port monitor → `session.activePorts` → App tab loads the client via the gated proxy → user
works in DBeaver (clipboard/resize/input via KasmVNC) → app-exit or idle-cull ends it. For AI tasks: chat
AI → MCP `exec_in_runtime`/`launch_program` → collab-server → k8s-exec into the dind → result back.

## 6. Security / kiosk lockdown
- **Single-app kiosk:** the X session launches *only* the target app, fullscreen; no desktop, no WM
  root-menu, no terminal, no file manager. The image contains *only* the app + runtime deps, so there is
  nothing to escape to and no path to a desktop/shell **from the stream**.
- **App-as-session:** closing the app ends the session — no lingering blank desktop.
- **No browser / no full desktop** anywhere in the catalog.
- **Isolation (inherited):** runs in the user's Sysbox dind — non-privileged, `hostUsers:false`, host
  docker.sock unreachable, egress-hardened. KasmVNC gets a per-session credential; the web endpoint is
  gated by the existing workspace-access proxy. Images digest-pinned + CI trivy gate.
- **MCP exec:** runs in the same Sysbox sandbox with the existing per-program env scrub (blocked env
  keys, DOCKER_HOST handling) — same isolation/capability the terminal already provides; does **not**
  bypass the GUI kiosk.
- **Honest boundary note:** the kiosk locks the *streamed GUI* to one app and removes the browser/desktop
  abuse surface; the hard boundary remains the Sysbox isolation that already contains the runtime.

## 7. Testing (TDD)
- **Unit:** `webGui` launch routing + surface-flag threading; recipe manifest validation; MCP tool
  contracts (`list_programs`/`launch_program`/`exec_in_runtime`/`read_session`); proxy WS-upgrade.
- **Image:** `gui-base`/`dbeaver` build; KasmVNC serves; **kiosk assertions** — no terminal/desktop/
  file-manager reachable; app-exit ends the session.
- **Live (scratch cluster):** open DBeaver → renders in App tab → interact (clipboard/resize) → confirm
  **no desktop/shell escape** → MCP `exec_in_runtime` runs `docker`/SQL → idle-cull.

## 8. Hardcoded-values audit
New values must be env-driven or universal: the KasmVNC web port (recipe-declared/derived), the
per-session KasmVNC credential (generated, never hardcoded), image refs (digest-pinned via config/AR).
Full audit at slice end (per the hardcoded-values-audit memory).

## 9. Non-goals (this slice)
Visual GUI driving (§10); browsers; full desktops; arbitrary user GUI apps; WebRTC streaming; audio; GPU;
multi-window/multi-app per container.

## 10. Forward plan — visual GUI driving (NEXT SLICE, not now)
> Mirrored into `tasks/todo.md` with a recurring callout so it surfaces whenever programs work is touched.

Goal: the AI observes the streamed GUI and clicks/types to perform GUI-only tasks ("manage my database
*using DBeaver*").
- **Observe:** capture frames from the KasmVNC stream (or the container's X display) and feed a vision
  model (the MCP already uses Gemini vision for the worker preview — adapt the source to KasmVNC).
- **Drive:** inject pointer/keyboard either through the **KasmVNC input protocol** or **XTest** in the
  container's X display; reuse the MCP input-lease/broker concepts.
- **Loop:** vision → plan action → inject → re-observe (computer-use style), bounded + cancellable.
- **MCP tools:** `gui_screenshot`, `gui_click`, `gui_type`, `gui_key` scoped to a program session.
- **Security:** same Sysbox isolation; the AI's input is a controlled channel distinct from the user's
  kiosk stream; rate/scope limits; never re-enables a desktop/launcher.
- **Risks/sequencing:** vision reliability, latency, action verification; ship after the command-level
  loop + the streaming surface are solid.

## 11. Verification / live gate
Both suites green (backend `node --test`, frontend vitest over programs/panel); `node --check` on touched
collab-server modules; one live e2e on a scratch Sysbox cluster (DBeaver streamed + kiosk-escape check +
MCP `exec_in_runtime`), then tear the cluster down (prod untouched).
