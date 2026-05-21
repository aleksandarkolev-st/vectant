# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Frontend (Next.js 15, standalone output)
# ─────────────────────────────────────────────────────────────────────────────
#  Multi-stage build:
#    Stage 1 (deps):    Install ALL dependencies (dev + prod)
#    Stage 2 (builder): Run polyfills build, generate Prisma client, next build
#    Stage 3 (runner):  Copy only the standalone output (~150 MB)
#
#  NEXT_PUBLIC_* env vars are baked into the client JS bundle at build time.
#  Pass them as --build-arg when running `docker build`.
#
#  Runtime-only env vars (DATABASE_URL, AUTH_SECRET, etc.) are injected via
#  K8s env/secrets at pod start and read server-side by API routes.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat needed for some npm packages on Alpine
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

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
            "NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER=$NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER"; do \
            key="${entry%%=*}"; \
            value="${entry#*=}"; \
            if [ -n "$value" ]; then printf '%s=%s\n' "$key" "$value" >> .env.production.local; fi; \
        done

# Generate the Prisma client (reads schema.prisma → node_modules/.prisma)
RUN npx prisma generate

# Polyfills → then Next.js production build (uses `output: 'standalone'`)
# Bump the V8 heap so the workspace bundle (Monaco + Yjs + collab) doesn't
# OOM during the static optimisation pass — the default 2GB limit lands
# right on the edge for this build.
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# ── Stage 3: Production runner ──────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Static assets
COPY --from=builder /app/public ./public

# Standalone server + traced node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma client must be present at runtime for API routes
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
