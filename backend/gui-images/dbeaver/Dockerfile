# @vectant/dbeaver — DBeaver Community streamed as a single-app KasmVNC kiosk.
#
# Built on @vectant/gui-base (KasmVNC + matchbox, no desktop/terminal/browser/
# file-manager). Adds DBeaver CE + a JRE + the GTK libs SWT needs. APP_CMD makes
# DBeaver the sole X client; closing it ends the session. There is no path from
# the stream to a shell or desktop.
ARG BASE_IMAGE=vectant-gui-base:dev
FROM ${BASE_IMAGE}

USER root
ARG DBEAVER_URL=https://dbeaver.io/files/dbeaver-ce_latest_amd64.deb

# DBeaver CE bundles its own JRE (Java 21 under /usr/share/dbeaver-ce/jre), so we
# install only the GTK/X libs SWT needs at runtime — no system JRE.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libgtk-3-0 libxtst6 libxi6 libxrender1 libxext6 libgl1; \
    curl -fsSL -o /tmp/dbeaver.deb "${DBEAVER_URL}"; \
    apt-get install -y --no-install-recommends /tmp/dbeaver.deb; \
    rm -f /tmp/dbeaver.deb; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# DBeaver is SWT/GTK3 — force the X11 backend under KasmVNC's Xvnc.
ENV GDK_BACKEND=x11 \
    APP_CMD="dbeaver-ce -nl en"

USER kasm-user
WORKDIR /home/kasm-user
