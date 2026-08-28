# @vectant/postman — Postman API client streamed as a single-app KasmVNC kiosk.
#
# Built on @vectant/gui-base (KasmVNC + matchbox, no desktop/terminal/browser/
# file-manager). Adds the Postman Linux app (a self-contained Electron bundle)
# plus the shared libs its bundled Chromium dlopen()s at runtime. APP_CMD makes
# Postman the sole X client; closing it ends the session. There is no path from
# the stream to a shell or desktop.
ARG BASE_IMAGE=vectant-gui-base:dev
FROM ${BASE_IMAGE}

USER root
# Official "latest 64-bit Linux" redirect → a versioned Electron tar.gz that
# unpacks to /opt/Postman/Postman. Env/ARG-driven so prod can pin a mirrored,
# checksummed artifact instead of tracking upstream latest.
ARG POSTMAN_URL=https://dl.pstmn.io/download/latest/linux_64

# Postman ships its own Chromium + Node inside the tarball, so we install only the
# shared libraries Electron/Chromium load at runtime — no system Node/Electron.
# libsecret is Postman's OS credential store; libgbm/libdrm are Chromium's GL/
# SwiftShader path; the rest are the standard Electron X/Chromium deps. gtk3 pulls
# pango/cairo/gdk-pixbuf/atk transitively; libnss3 pulls libnspr4.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libgtk-3-0 libnss3 libxss1 libxtst6 libasound2 \
      libgbm1 libdrm2 libsecret-1-0 libnotify4 libatspi2.0-0 \
      libcups2 libxkbcommon0 xdg-utils; \
    curl -fsSL -o /tmp/postman.tar.gz "${POSTMAN_URL}"; \
    tar -xzf /tmp/postman.tar.gz -C /opt; \
    rm -f /tmp/postman.tar.gz; \
    ln -s /opt/Postman/Postman /usr/bin/postman; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Electron under KasmVNC's Xvnc:
#  - GDK_BACKEND=x11   force X11 (no Wayland) under Xvnc.
#  - --no-sandbox      the Chromium setuid sandbox can't initialise as the
#                      non-root kiosk user in the rootless/Sysbox runtime; the
#                      single-app, shell-less, Sysbox-isolated container is itself
#                      the boundary (same model as the rest of gui-base).
#  - --disable-dev-shm-usage  Docker's default 64 MB /dev/shm crashes Chromium's
#                      renderer; spill shared memory to /tmp instead.
#  - --disable-gpu     Xvnc exposes no GPU; force CPU rendering so there's no GPU
#                      process to churn or hang. (Drop this if a live test shows a
#                      blank surface and software GL is preferred.)
ENV GDK_BACKEND=x11 \
    APP_CMD="postman --no-sandbox --disable-dev-shm-usage --disable-gpu"

USER kasm-user
WORKDIR /home/kasm-user
