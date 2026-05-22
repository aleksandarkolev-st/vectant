# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — AI Gateway (Node.js WebSocket proxy)
# ─────────────────────────────────────────────────────────────────────────────
#  Bridges browser WS connections to the Python AI engine's HTTP endpoints.
#  No native modules — single-stage build is sufficient.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
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
