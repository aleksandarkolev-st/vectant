# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Collab Server (Node.js)
# ─────────────────────────────────────────────────────────────────────────────
#  node-pty requires native compilation (python3, make, g++) — full node:20
#  (Debian bookworm) ships all of these in the base image, so no extra apt
#  installs are needed in the build stage. Both stages share the same base
#  so the .node ABI from the builder is binary-compatible with runtime.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build native addons ────────────────────────────────────────────
FROM node:20 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20
WORKDIR /app

ENV NODE_ENV=production

# Claude Code CLI — exposed inside the in-app terminal. Installed globally
# so it lands in /usr/local/bin (already on PATH, owned by root, readable
# by the unprivileged synthi user that runs the server).
RUN npm install -g @anthropic-ai/claude-code

# Non-root runtime user. --create-home gives terminalService's
# GIT_CONFIG_GLOBAL / NPM_CONFIG_USERCONFIG / CLAUDE_CONFIG_DIR overrides a
# real /home/synthi to land in once HOME gets re-pointed at the workspace.
RUN groupadd --system --gid 1001 synthi \
 && useradd --system --uid 1001 --gid 1001 --shell /bin/bash --create-home synthi

# Copy compiled node_modules (includes native .node binaries)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=synthi:synthi . .

# Create data directories for repo cache and workspace storage
RUN mkdir -p /data/repos && chown -R synthi:synthi /data

RUN git config --system user.email "synthi@overview-synti.com" && \
    git config --system user.name "Synthi Autocommit"

# Passwordless sudo for the synthi user so the in-app terminal can install
# packages ad hoc (e.g. `sudo apt-get install <pkg>`). The server itself still
# runs unprivileged — escalation only happens when the user explicitly invokes
# sudo inside their interactive shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'synthi ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/synthi \
 && chmod 0440 /etc/sudoers.d/synthi

USER synthi

EXPOSE 1234

CMD ["node", "--openssl-legacy-provider", "server.js"]
