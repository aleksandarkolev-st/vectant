# GUI dev-tool images (KasmVNC kiosk) — real-programs Slice 3

Curated, single-app GUI tools streamed into the workspace over KasmVNC and
surfaced through the slice-1 runtime port proxy (`/runtime/<scope>/port/N`).
Spec: `docs/superpowers/specs/2026-06-20-gui-dev-tool-streaming-design.md`.

## Images

| Image | Base | What it streams |
|---|---|---|
| `gui-base/` | `debian:bookworm-slim` + KasmVNC + matchbox-window-manager | nothing on its own — sets up the kiosk; child images set `APP_CMD` |
| `dbeaver/` | `gui-base` + DBeaver CE (bundled JRE) | DBeaver Community database GUI |
| `postman/` | `gui-base` + Postman (bundled Electron) | Postman API client |

## Kiosk security model

- **Single app, no escape.** The X session runs `matchbox-window-manager`
  (borderless, **no titlebar / no root menu / no panel / no launcher**) plus the
  ONE app (`exec $APP_CMD` in `~/.vnc/xstartup`). There is **no desktop
  environment, no terminal emulator, no file manager, and no browser** in the
  image — nothing to escape to from the stream.
- **App-as-session.** When the app exits, the X session ends and the container
  exits (PID 1 tails the session pid).
- **Transport.** KasmVNC serves **plain HTTP + WebSocket** (an ephemeral
  self-signed cert is generated only because KasmVNC binds TLS at init;
  `require_ssl: false`). The real access boundary is the workspace-access-gated
  runtime proxy + Sysbox isolation. A **per-session KasmVNC credential** (env
  `KASM_PASSWORD`, else generated) is defense-in-depth.
- Runs as non-root `kasm-user` (uid 1000, `nologin` shell).

## Build (local)

```bash
docker build -t vectant-gui-base:dev backend/gui-images/gui-base
docker build -t vectant-dbeaver:dev  backend/gui-images/dbeaver        # FROM vectant-gui-base:dev
docker build -t vectant-postman:dev  backend/gui-images/postman        # FROM vectant-gui-base:dev
```

Postman streams on a distinct KasmVNC port (`6902`) from DBeaver (`6901`) so both
can run side by side in one workspace; its recipe passes `-e KASM_PORT=6902`.

Override the base for CI / registry builds:
`docker build --build-arg BASE_IMAGE=<registry>/vectant-gui-base@sha256:... -t <registry>/vectant-dbeaver:<tag> backend/gui-images/dbeaver`

## Smoke test

```bash
docker run --rm -p 6901:6901 -e KASM_PASSWORD=secret vectant-dbeaver:dev
curl -u vectant:secret http://localhost:6901/vnc.html      # 200 once KasmVNC is up
```

## Prod / follow-ups

- Push digest-pinned to Artifact Registry and add to the cloudbuild trivy list.
- The DBeaver recipe (`@vectant/dbeaver`, `webGui: true`) launches the image in
  the per-workspace Sysbox runtime; the launch command is the recipe `launch`.
- **Credential hand-off:** the App-tab iframe must present the per-session
  KasmVNC credential (or the proxy injects it) so the stream connects without a
  manual login. Finalized with live testing at the slice live gate.
