# @synthi/programs-mcp

An MCP server that teaches an AI coding agent (Claude Code, Codex, Cursor — anything
that speaks MCP stdio) the **`vectant.programs.json`** manifest format, so it can
author one directly from a Vectant workspace terminal.

A `vectant.programs.json` is the recipe that makes a program installable and runnable
inside a Vectant workspace (runtime type, launch command, ports, permission scopes).
This server lets the agent look up the schema, check a draft, and — when configured —
generate one from the workspace's files.

## Tools

| Tool | Input | What it does |
|------|-------|--------------|
| `describe_manifest_schema` | — | Returns the full schema: fields, runtime types, permission scopes, host-escape rules, and worked web/container examples. Call this first. |
| `validate_manifest` | `{ manifest }` (object or JSON string) | Advisory validation — returns `{ valid, errors[] }` collecting every problem in one pass. |
| `generate_manifest` | `{ files, workspaceName? }` | Delegates to the configured Vectant backend to draft a manifest from `{ path: contents }` files. Returns `not_configured` when the backend URL is unset. |

> **Advisory, not authoritative.** `validate_manifest` mirrors the backend rules but
> the fail-closed check that actually gates publishing runs server-side
> (`parseProgramManifest` + the review pipeline). A manifest that passes here is not
> thereby approved. Always `validate_manifest` a generated draft before saving.

## Run

```bash
# From this repo (workspaces install hoists the MCP SDK):
node packages/programs-mcp/src/index.js
```

### Registration

The monorepo ships a project-scoped [`.mcp.json`](../../.mcp.json) at the repo root, so
any MCP host opened in this repo/workspace (Claude Code, Cursor, …) auto-registers this
server as `vectant-programs` — no manual step. To register it elsewhere, e.g. Claude Code
in another directory:

```bash
claude mcp add vectant-programs -- node /abs/path/to/packages/programs-mcp/src/index.js
```

> Per-user workspace terminals do not yet auto-provision MCP config — seeding this server
> into the workspace runtime image/dotfiles is a separate infra step.

## Configuration (generation only)

`describe_manifest_schema` and `validate_manifest` work fully offline. `generate_manifest`
delegates to a Vectant backend endpoint and is off until you point it at one:

| Var | Default | Purpose |
|-----|---------|---------|
| `VECTANT_MANIFEST_GENERATE_URL` | *(unset)* | POST target. Body: `{ files, workspace_name }`. Response: `{ manifest }`. Matches the ai-engine `POST /programs/generate-manifest` contract. |
| `VECTANT_MANIFEST_GENERATE_TOKEN` | *(unset)* | Sent as the token header when set. |
| `VECTANT_MANIFEST_GENERATE_TOKEN_HEADER` | `x-synthi-internal-token` | Header name for the token. |

When `VECTANT_MANIFEST_GENERATE_URL` is unset, `generate_manifest` returns
`not_configured` and the agent should author the manifest from `describe_manifest_schema`.

## Test

```bash
cd packages/programs-mcp
npm test    # vitest — pure modules + a server build smoke test
```

## Layout

```
src/
  manifestSpec.js    # schema reference (constants + fields + examples + markdown) — pure
  validate.js        # advisory multi-error validator — pure
  hostEscape.js      # host-escape ruleset (copy of the backend denylist) — pure
  generateClient.js  # backend delegate for generation (injectable fetch) — pure
  tools.js           # the 3 tool descriptors + handlers — pure, SDK-free
  server.js          # binds tools to the low-level MCP SDK Server
  index.js           # stdio entry point
```

The pure modules carry all behavior and are unit-tested without the SDK or network;
`server.js` / `index.js` are thin protocol glue.
