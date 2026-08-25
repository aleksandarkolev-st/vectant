# Deployment

How to run the embodied teaching bridge beyond a developer laptop, and how
skills travel between deployments.

## What the bridge is

The bridge is the service an agent (and the Workflows panel) talks to. It
exposes five verbs — **attach, observe, teach, run, explain** — plus the
skill import/export calls, over one HTTP endpoint:

```
POST /browser-workflows/tool   body: { tool: "synthi_<name>", arguments: {...} }
GET  /healthz                  -> "ok"
```

## Local run (default)

```
npx tsx mcp/synthi-mcp/scripts/bridge_agent.mts <port|0> [gameWsUrl] [licenseFile]
```

Defaults bind to `127.0.0.1` with no token. That is the right posture for a
single-user machine: nothing off-box can reach it.

## Deployed run

Two environment variables control deployment:

- `SYNTHI_BRIDGE_HOST` — bind address (default `127.0.0.1`).
- `SYNTHI_BRIDGE_TOKEN` — shared secret; clients send it as the
  `x-synthi-workflow-token` header.

Rule, enforced in code: **binding beyond loopback without a token refuses to
start** (`refusing to bind beyond this machine without SYNTHI_BRIDGE_TOKEN
set`, exit code 2). The same rule holds at request time even for hosts that
are configured programmatically: a non-loopback bridge answers tool requests
with `401 workflow_bridge_token_required` until a token is set.

```
SYNTHI_BRIDGE_HOST=0.0.0.0 SYNTHI_BRIDGE_TOKEN=<secret> \
  npx tsx mcp/synthi-mcp/scripts/bridge_agent.mts 8080
```

The startup banner prints the ACTUAL listening port (argv `0` = OS-assigned):

```
AGENT BRIDGE LIVE on port 8080
```

Never log or embed the token itself.

## Agent execution allowlists

What an agent may execute is deployment configuration, not skill content:

- `SYNTHI_TERMINAL_AGENT=node,python` — terminal adapter runs only these
  binaries (deny-everything when unset).
- `SYNTHI_BROWSER_AGENT=cdp` + `SYNTHI_BROWSER_CDP_URL=<http://host:port>` —
  attaches the browser substrate to an already-running browser over CDP.
- `SYNTHI_KERNEL_AGENT=b` — kernel adapter against the configured namespace.

Skills never widen these allowlists; the deployment does.

## Skill files are the portable artifact

`synthi.skill.v1` files carry a compiled contract plus recorded steps and a
sha256 integrity digest. An importing agent:

1. verifies the digest (`synthi_import_skill` refuses tampered artifacts),
2. holds a license scoped to ITS OWN realm ids (exact match, no prefixes),
3. executes with its own adapters under its own policy.

Licenses are seeded from a JSON file passed as argv[3]:

```
[{
  "license_id": "lic-1",
  "competency_id": "<skill_id>",
  "substrate_scope": ["terminal"],
  "realm_scopes": [{ "realm_kind": "workspace", "realm_id": "/srv/agent-b" }],
  "entrustment": "E2_supervised",
  "issued_at_ms": 0,
  "expires_at_ms": 9007199254740991
}]
```

Consent never crosses realms: a skill taught in workspace A runs only where a
license names that exact realm. Proofs live under `.visual-proof/` in the repo.

## Operational notes

- Health probe: `GET /healthz`.
- All waits should be bounded polls on the banner + `/healthz`; there is no
  discovery protocol.
- The bridge is stateful per process (sessions, imported skills); restarts
  re-import skills and re-seed licenses.
