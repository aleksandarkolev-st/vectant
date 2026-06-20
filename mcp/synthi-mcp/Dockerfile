# Synthi MCP — runs inside docker-compose's default network so MCP shares a
# subnet with the worker (172.18.0.0/16). MCP then pairs directly against the
# worker's host ICE candidate and TURN is unnecessary — which sidesteps the
# coturn self-peer-permission block that breaks relay-to-relay when both sides
# allocate on the same coturn.
#
# The container is a long-running sleeper; live-test.mjs does `docker exec -i`
# per run so stdio (MCP JSON-RPC) stays wired to the host harness.
#
# npm-WORKSPACE build: this image builds from the MONOREPO ROOT context (not
# ./mcp/synthi-mcp) because @synthi-inc/mcp-server depends on the workspace
# package @synthi/mcp-hub (packages/mcp-hub) — a narrow context can't resolve
# the workspace sibling and `npm ci` falls back to the registry (404). The
# repo-root .dockerignore keeps the context lean; docker-compose sets
# `context: .` + `dockerfile: mcp/synthi-mcp/Dockerfile`.

FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb

WORKDIR /app

# sharp and @ffmpeg-installer/ffmpeg ship prebuilt linux binaries via npm, but
# ffmpeg-installer's binary still needs a libc that matches — `slim` (glibc)
# works, alpine does not without extra work.

# Root lockfile + EVERY workspace manifest (npm needs them all to resolve the
# workspace graph against package-lock.json). `npm ci -w` scopes the install to
# the mcp workspace closure (mcp-server + the linked @synthi/mcp-hub), so the
# image does NOT pull synthi's frontend dependency tree.
COPY package.json package-lock.json ./
COPY synthi/package.json ./synthi/package.json
COPY packages/mcp-hub/package.json ./packages/mcp-hub/package.json
COPY mcp/synthi-mcp/package.json ./mcp/synthi-mcp/package.json
RUN npm ci -w @synthi-inc/mcp-server

# @synthi/mcp-hub is a source-only workspace package (main: src/index.js)
# consumed by mcp's tsc build via the node_modules symlink npm just created.
COPY packages/mcp-hub ./packages/mcp-hub
COPY mcp/synthi-mcp/tsconfig.json ./mcp/synthi-mcp/tsconfig.json
COPY mcp/synthi-mcp/src ./mcp/synthi-mcp/src
COPY mcp/synthi-mcp/scripts ./mcp/synthi-mcp/scripts
RUN npm run build -w @synthi-inc/mcp-server

# Preserve the legacy in-container entry contract: harnesses run
# `docker exec … node /app/dist/index.js`. The root-context build emits to
# mcp/synthi-mcp/dist, so expose dist (and scripts) at /app via symlinks. Node
# resolves the realpath, so imports still hoist to /app/node_modules and
# `../package.json` still resolves to the mcp package, not the repo root.
RUN ln -sf mcp/synthi-mcp/dist /app/dist && ln -sf mcp/synthi-mcp/scripts /app/scripts

# Keep the container up so live-test.mjs can `docker exec` into it repeatedly
# without paying container-startup cost per run.
CMD ["sleep", "infinity"]
