# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Frontend (Next.js 15, standalone output)
# ─────────────────────────────────────────────────────────────────────────────
#  npm-WORKSPACE build: this image builds from the MONOREPO ROOT context (not
#  ./synthi) because synthi depends on the workspace package @synthi/mcp-hub
#  (packages/mcp-hub) and transpiles it. docker-compose uses `context: .` and
#  cloudbuild uses `--context=dir:///workspace`; both set dockerfile to
#  synthi/Dockerfile. The repo-root .dockerignore keeps the context lean.
#
#  Multi-stage:
#    Stage 1 (deps):    workspace-aware `npm ci` from the repo root
#    Stage 2 (builder): prisma generate + next build (output: 'standalone')
#    Stage 3 (runner):  copy the monorepo-rooted standalone output (~150 MB)
#
#  NEXT_PUBLIC_* are baked into the client bundle at build time (--build-arg).
#  Runtime-only env (DATABASE_URL, AUTH_SECRET, …) are injected at pod start.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies (workspace-aware) ──────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps
WORKDIR /app

# libc6-compat needed for some npm packages on Alpine
RUN apk add --no-cache libc6-compat

# Root lockfile + EVERY workspace manifest (npm needs them all to resolve the
# workspace graph against package-lock.json before installing).
COPY package.json package-lock.json ./
COPY synthi/package.json ./synthi/package.json
COPY packages/mcp-hub/package.json ./packages/mcp-hub/package.json
COPY mcp/synthi-mcp/package.json ./mcp/synthi-mcp/package.json
RUN npm ci

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# Root manifests (workspace resolution) + only the sources synthi's build needs.
COPY package.json package-lock.json ./
COPY packages/mcp-hub ./packages/mcp-hub
COPY synthi ./synthi

WORKDIR /app/synthi

# Cloud builds rely on synthi/.env.production. Local docker-compose builds pass
# explicit build args, so write only non-empty args into .env.production.local
# to override the beta defaults during `next build`.
ARG NEXT_PUBLIC_COLLAB_SERVER_URL=
ARG NEXT_PUBLIC_YSWEET_URL=
ARG NEXT_PUBLIC_COLLAB_PORT=
ARG NEXT_PUBLIC_COMPILE_SIGNAL_URL=
ARG NEXT_PUBLIC_GATEWAY_WS_URL=
ARG NEXT_PUBLIC_CODE_INTEL_URL=
ARG NEXT_PUBLIC_AI_ENGINE_URL=
ARG NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=
ARG NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=

RUN if [ -z "$NEXT_PUBLIC_COLLAB_SERVER_URL" ] || \
        [ -z "$NEXT_PUBLIC_COMPILE_SIGNAL_URL" ] || \
        [ -z "$NEXT_PUBLIC_GATEWAY_WS_URL" ]; then \
        echo "Missing required NEXT_PUBLIC_* build args for production frontend build." >&2; \
        echo "Set NEXT_PUBLIC_COLLAB_SERVER_URL, NEXT_PUBLIC_COMPILE_SIGNAL_URL, and NEXT_PUBLIC_GATEWAY_WS_URL." >&2; \
        exit 1; \
    fi

RUN rm -f .env.production.local && \
        : > .env.production.local && \
        for entry in \
            "NEXT_PUBLIC_COLLAB_SERVER_URL=$NEXT_PUBLIC_COLLAB_SERVER_URL" \
            "NEXT_PUBLIC_YSWEET_URL=$NEXT_PUBLIC_YSWEET_URL" \
            "NEXT_PUBLIC_COLLAB_PORT=$NEXT_PUBLIC_COLLAB_PORT" \
            "NEXT_PUBLIC_COMPILE_SIGNAL_URL=$NEXT_PUBLIC_COMPILE_SIGNAL_URL" \
            "NEXT_PUBLIC_GATEWAY_WS_URL=$NEXT_PUBLIC_GATEWAY_WS_URL" \
            "NEXT_PUBLIC_CODE_INTEL_URL=$NEXT_PUBLIC_CODE_INTEL_URL" \
            "NEXT_PUBLIC_AI_ENGINE_URL=$NEXT_PUBLIC_AI_ENGINE_URL" \
            "NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=$NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER" \
            "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=$NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS"; do \
            key="${entry%%=*}"; \
            value="${entry#*=}"; \
            if [ -n "$value" ]; then printf '%s=%s\n' "$key" "$value" >> .env.production.local; fi; \
        done

# Generate the Prisma client (reads synthi/prisma/schema.prisma → hoisted node_modules/.prisma)
RUN npx prisma generate

# Polyfills → Next.js production build (output: 'standalone'). Bump the V8 heap so
# the Monaco + Yjs + collab bundle doesn't OOM on the static-optimisation pass.
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# ── Stage 3: Production runner ──────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# With outputFileTracingRoot = repo root, the standalone output is rooted at the
# monorepo: it contains synthi/server.js, a hoisted node_modules, and the traced
# packages/mcp-hub. Preserve that layout (server entry = synthi/server.js).
COPY --from=builder --chown=nextjs:nodejs /app/synthi/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/synthi/.next/static ./synthi/.next/static
COPY --from=builder /app/synthi/public ./synthi/public

# Prisma client must be present at runtime for API routes (hoisted to root node_modules).
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/synthi/prisma ./synthi/prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "synthi/server.js"]
