# Synthi MCP — runs inside docker-compose's default network so MCP shares a
# subnet with the worker (172.18.0.0/16). MCP then pairs directly against the
# worker's host ICE candidate and TURN is unnecessary — which sidesteps the
# coturn self-peer-permission block that breaks relay-to-relay when both sides
# allocate on the same coturn.
#
# The container is a long-running sleeper; live-test.mjs does `docker exec -i`
# per run so stdio (MCP JSON-RPC) stays wired to the host harness.

FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb

WORKDIR /workspace/mcp/synthi-mcp

# sharp and @ffmpeg-installer/ffmpeg ship prebuilt linux binaries via npm, but
# ffmpeg-installer's binary still needs a libc that matches — `slim` (glibc)
# works, alpine does not without extra work.

COPY packages/mcp-hub /workspace/packages/mcp-hub
COPY mcp/synthi-mcp/.npmrc mcp/synthi-mcp/package.json mcp/synthi-mcp/package-lock.json ./
RUN npm ci --workspaces=false

COPY mcp/synthi-mcp/tsconfig.json ./
COPY mcp/synthi-mcp/src ./src
COPY mcp/synthi-mcp/scripts ./scripts
RUN npm run build

# Keep the container up so live-test.mjs can `docker exec` into it repeatedly
# without paying container-startup cost per run.
CMD ["sleep", "infinity"]
