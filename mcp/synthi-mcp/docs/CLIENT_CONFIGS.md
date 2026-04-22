# Synthi MCP — per-client configuration

**Scope:** concrete config snippets for each top-tier MCP host, keyed off the
two proprietary distribution channels Phase 2a ships (GHCR image preferred,
GitHub Packages npm fallback). For the "why" of those channels, see
`PHASE_2A_DISTRIBUTION.md` at the repo root.

**Conventions:**

- Every snippet pins an image tag or package version (`:v0.1.0`, `@0.1.0`).
  Do not use `:latest` in an agent config — pinning is the only thing that
  stops an agent from picking up a breaking change silently.
- `<SESSION_ID>` is a placeholder for the Synthi session you intend the agent
  to attach to. Pull the current id from the session toolbar in the frontend.
- `<SIGNALING_URL>` defaults to `ws://localhost:9000` for local development.
  Point it at whatever your running Synthi stack exposes.
- The API-key envs (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) are only needed if
  you select `SYNTHI_VISION_BACKEND=claude_api` or `gemini_api`. The default
  `agent_side` backend needs no keys on the MCP side — your agent uses its
  own model and subscription to ground.

---

## Claude Code

### Preferred — GHCR image via `docker run`

```bash
claude mcp add synthi -- \
  docker run -i --rm --network host \
  -e SYNTHI_SESSION_ID=<SESSION_ID> \
  -e SYNTHI_SIGNALING_URL=<SIGNALING_URL> \
  ghcr.io/synthi-inc/synthi-mcp:v0.1.0
```

`--network host` is the path that makes the image reach `localhost:9000` — on
Linux hosts that's a direct loopback share. On Docker Desktop (macOS /
Windows) substitute `host.docker.internal` for `localhost` in the signaling
URL and drop `--network host`.

### Fallback — GitHub Packages npm

```bash
# One-time: populate .npmrc with a PAT scoped to read:packages.
cp mcp/synthi-mcp/.npmrc.example ./.npmrc
export GITHUB_TOKEN=ghp_...

claude mcp add synthi -- npx -y -p @synthi-inc/mcp-server@0.1.0 synthi-mcp --session <SESSION_ID>
```

### Source-build (collaborators)

```bash
claude mcp add synthi -- node /abs/path/to/mcp/synthi-mcp/dist/index.js --session <SESSION_ID>
```

---

## Codex CLI

`~/.codex/mcp.json`:

```json
{
  "mcpServers": {
    "synthi": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--network", "host",
        "-e", "SYNTHI_SIGNALING_URL",
        "-e", "SYNTHI_SESSION_ID",
        "ghcr.io/synthi-inc/synthi-mcp:v0.1.0"
      ],
      "env": {
        "SYNTHI_SIGNALING_URL": "ws://localhost:9000",
        "SYNTHI_SESSION_ID": "<SESSION_ID>"
      }
    }
  }
}
```

Swap `command`/`args` for `"command": "npx", "args": ["-y", "-p", "@synthi-inc/mcp-server@0.1.0", "synthi-mcp"]` to take the npm path instead.

---

## Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "synthi": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--network", "host",
        "-e", "SYNTHI_SIGNALING_URL",
        "-e", "SYNTHI_SESSION_ID",
        "ghcr.io/synthi-inc/synthi-mcp:v0.1.0"
      ],
      "env": {
        "SYNTHI_SIGNALING_URL": "ws://localhost:9000",
        "SYNTHI_SESSION_ID": "<SESSION_ID>"
      }
    }
  }
}
```

Cursor caches tool-list responses aggressively across turns; if you bump the
MCP image version, restart Cursor so the cache invalidates.

---

## Gemini CLI

`~/.gemini/mcp.json`:

```json
{
  "mcpServers": {
    "synthi": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--network", "host",
        "-e", "SYNTHI_SIGNALING_URL",
        "-e", "SYNTHI_SESSION_ID",
        "ghcr.io/synthi-inc/synthi-mcp:v0.1.0"
      ],
      "env": {
        "SYNTHI_SIGNALING_URL": "ws://localhost:9000",
        "SYNTHI_SESSION_ID": "<SESSION_ID>"
      }
    }
  }
}
```

If you plan to use the server-side vision backend with a Gemini account,
add `"GEMINI_API_KEY": "..."` (and/or `"SYNTHI_VISION_BACKEND": "gemini_api"`)
to the `env` block.

---

## Windsurf

Windsurf config lives in `~/.codeium/windsurf/mcp_config.json` — same shape as
Cursor / Codex:

```json
{
  "mcpServers": {
    "synthi": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--network", "host",
        "-e", "SYNTHI_SIGNALING_URL",
        "-e", "SYNTHI_SESSION_ID",
        "ghcr.io/synthi-inc/synthi-mcp:v0.1.0"
      ],
      "env": {
        "SYNTHI_SIGNALING_URL": "ws://localhost:9000",
        "SYNTHI_SESSION_ID": "<SESSION_ID>"
      }
    }
  }
}
```

Windsurf has a smaller context budget for tool descriptions than the others;
if tool list gets truncated, lower the tool noise by setting
`SYNTHI_TOOL_COMPRESS=1` (reserved env — not yet implemented; tracked as a
phase-2b follow-up if it turns out to be a real constraint).

---

## Troubleshooting

- **`signaling_closed_before_connect` on Docker Desktop (mac/Windows):** you
  almost certainly need `host.docker.internal` instead of `localhost` in the
  signaling URL, and you don't need `--network host`.
- **`GITHUB_TOKEN undefined` during `npx`:** the token isn't visible to the
  shell running `claude mcp`. Either export it in your profile (`~/.zshrc` /
  `~/.bashrc`) or embed it directly in `.npmrc`. Never commit the populated
  `.npmrc`.
- **`unauthorized: authentication required` pulling the image:** `docker
  login ghcr.io` with a PAT that has `read:packages`. Re-pull.
- **`Error: Package "@synthi-inc/mcp-server" not found`:** your `.npmrc` is
  missing the scope binding, or your PAT doesn't have `read:packages`, or
  your account isn't in the `synthi-inc` org. Check in that order.
- **Tools appear but every call times out:** check the session id — the MCP
  attaches successfully to a non-existent session and the failure surface is
  per-tool, not at attach time. `synthi_health` returns the current peer
  state; if `connectionState` stays `connecting`, your stack isn't listening
  at the signaling URL you configured.
