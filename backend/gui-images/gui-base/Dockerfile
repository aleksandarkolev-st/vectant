# @vectant/gui-base — single-app KasmVNC kiosk base (GUI dev-tool streaming, Slice 3).
#
# Debian-slim + KasmVNC + matchbox-window-manager (no titlebar / no root menu /
# no panel). There is intentionally NO desktop environment, NO terminal emulator,
# NO file manager, and NO browser in the image — so there is nothing to escape to
# from the stream. A child image sets APP_CMD; the entrypoint runs it as the SOLE
# X client, fullscreen. When the app exits, the X session (and the container) exit.
#
# KasmVNC serves plain HTTP + WebSocket (no self-signed TLS) so the slice-1 runtime
# port proxy (/runtime/<scope>/port/N) can forward it; the workspace-access proxy
# gate is the access boundary, with a per-session KasmVNC credential as defense in
# depth.
FROM debian:bookworm-slim

ARG KASMVNC_VERSION=1.4.0
ARG KASMVNC_DEB=kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb

ENV DEBIAN_FRONTEND=noninteractive \
    KASM_PORT=6901 \
    DISPLAY=:1 \
    HOME=/home/kasm-user

# KasmVNC + a deliberately tiny X stack. matchbox-window-manager gives borderless
# fullscreen with NO root menu / taskbar / launcher (kiosk). Fonts + dbus + the
# libs KasmVNC needs. We do NOT install any terminal emulator, file manager,
# browser, or desktop environment.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl openssl \
      matchbox-window-manager \
      dbus-x11 \
      xfonts-base fonts-dejavu-core \
      procps tini; \
    curl -fsSL -o "/tmp/${KASMVNC_DEB}" \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/${KASMVNC_DEB}"; \
    apt-get install -y --no-install-recommends "/tmp/${KASMVNC_DEB}"; \
    rm -f "/tmp/${KASMVNC_DEB}"; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    # Defense-in-depth: drop any terminal emulator that slipped in via deps.
    rm -f /usr/bin/xterm /usr/bin/x-terminal-emulator 2>/dev/null || true; \
    useradd -m -u 1000 -s /usr/sbin/nologin kasm-user

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER kasm-user
WORKDIR /home/kasm-user
EXPOSE 6901
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
