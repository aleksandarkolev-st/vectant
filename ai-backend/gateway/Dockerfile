# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — AI Gateway (Node.js WebSocket proxy)
# ─────────────────────────────────────────────────────────────────────────────
#  Bridges browser WS connections to the Python AI engine's HTTP endpoints.
#  No native modules — single-stage build is sufficient.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js .

RUN addgroup --system --gid 1001 synthi && \
    adduser --system --uid 1001 synthi
USER synthi

EXPOSE 7070

CMD ["node", "server.js"]
