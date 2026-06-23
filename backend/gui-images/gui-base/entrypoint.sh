#!/bin/sh
# Single-app KasmVNC kiosk entrypoint (GUI dev-tool streaming, Slice 3).
#
# Runs $APP_CMD as the SOLE X client, fullscreen, streamed over KasmVNC (plain
# HTTP+WS). matchbox-window-manager provides borderless fullscreen with no menu /
# panel / launcher, so there is no way to reach a desktop or shell from the
# stream. When the app exits, the X session ends and this entrypoint (PID 1) exits
# — the program session is the app's lifetime.
set -eu

: "${APP_CMD:?APP_CMD must be set (the single app to stream)}"
KASM_PORT="${KASM_PORT:-6901}"
GEOMETRY="${KASM_GEOMETRY:-1280x800}"
KASM_VNC_USER="${KASM_VNC_USER:-vectant}"
VNC_DIR="$HOME/.vnc"
mkdir -p "$VNC_DIR"

# Per-session credential: use the injected password, else generate a random one.
# Never hardcoded. Echoed once to the container log; the endpoint is reachable
# only through the workspace-access-gated runtime proxy. The KasmVNC basic-auth
# store is ~/.kasmpasswd (default); -rwo grants read+write(control)+owner so the
# session has a user with write access (else vncserver prompts interactively).
KASM_PASSWORD="${KASM_PASSWORD:-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)}"
printf '%s\n%s\n\n' "$KASM_PASSWORD" "$KASM_PASSWORD" | kasmvncpasswd -u "$KASM_VNC_USER" -rwo
echo "[gui-base] KasmVNC user=${KASM_VNC_USER} password=${KASM_PASSWORD} port=${KASM_PORT}"

# KasmVNC binds TLS at init, so it always needs a cert/key it can read. Generate
# an ephemeral self-signed pair owned by this user (the snakeoil key is group-only
# readable). require_ssl:false still allows non-TLS clients; the real access
# boundary is the workspace-access-gated runtime proxy + Sysbox isolation.
if [ ! -f "$VNC_DIR/self.pem" ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=localhost" \
    -keyout "$VNC_DIR/self.key" -out "$VNC_DIR/self.pem" >/dev/null 2>&1
fi
cat > "$VNC_DIR/kasmvnc.yaml" <<EOF
network:
  ssl:
    pem_certificate: $VNC_DIR/self.pem
    pem_key: $VNC_DIR/self.key
    require_ssl: false
  udp:
    public_ip: 127.0.0.1
EOF

# Kiosk X session: matchbox (no titlebar / no menu) + the ONE app. exec makes the
# app the xstartup process, so when it exits the VNC session ends.
cat > "$VNC_DIR/xstartup" <<EOF
#!/bin/sh
matchbox-window-manager -use_titlebar no &
exec ${APP_CMD}
EOF
chmod +x "$VNC_DIR/xstartup"

# Start the session (foreground-coupled below). KasmVNC's vncserver daemonizes,
# so we tail the session pid to keep PID 1 alive and exit when the app exits.
# -select-de manual ⇒ use OUR xstartup (the single app), not an interactive DE picker.
vncserver "$DISPLAY" -geometry "$GEOMETRY" -depth 24 -websocketPort "$KASM_PORT" -select-de manual \
  || { echo "[gui-base] vncserver failed to start"; exit 1; }

PIDFILE="$(ls "$VNC_DIR"/*.pid 2>/dev/null | head -n1 || true)"
if [ -n "$PIDFILE" ] && [ -f "$PIDFILE" ]; then
  exec tail --pid="$(cat "$PIDFILE")" -f /dev/null
fi

# Fallback: no pidfile found — keep the container alive on the session log.
exec tail -f "$VNC_DIR"/*.log 2>/dev/null || sleep infinity
