# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Collab Server (Node.js)
# ─────────────────────────────────────────────────────────────────────────────
#  node-pty requires native compilation (python3, make, g++).
#  Multi-stage: builder compiles native addons → runtime copies the binaries.
#  Both stages use the same node:20-alpine base so the .node ABI matches.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build native addons ────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Build tools for node-pty and other native modules
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# node-pty spawns PTY processes — needs a shell and basic coreutils at runtime.
# git is needed for gitService.js operations.
RUN apk add --no-cache git

# Claude Code CLI — exposed inside the in-app terminal. Installed globally
# so it lands in /usr/local/bin (already on PATH, owned by root, readable
# by the unprivileged synthi user that runs the server).
RUN npm install -g @anthropic-ai/claude-code

RUN addgroup --system --gid 1001 synthi && \
    adduser --system --uid 1001 synthi

# Copy compiled node_modules (includes native .node binaries)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=synthi:synthi . .

# Create data directories for repo cache and workspace storage
RUN mkdir -p /data/repos && chown -R synthi:synthi /data

RUN git config --system user.email "synthi@overview-synti.com" && \
    git config --system user.name "Synthi Autocommit"

USER synthi

EXPOSE 1234

CMD ["node", "--openssl-legacy-provider", "server.js"]
