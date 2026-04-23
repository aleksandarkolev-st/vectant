# Phase 4 — Scoped agent auth + TURN + cross-region

Phase 4 of the agent MCP covers the bits needed to run the MCP against a
*shared* signaling-server instead of the local-dev `ws://127.0.0.1:9000`:

1. **`mcp-agent` role** on the signaling-server, multi-peer per session.
   Agent-counted in presence; kick-eligible from the operator UI.
2. **Scoped agent tokens** — HS256 JWTs binding `{subject, session_id,
   role, expiry}`. Required on `register` whenever the signaling-server
   is started with `SYNTHI_AGENT_TOKEN_SECRET` set.
3. **TURN credentials** — short-lived coturn `use-auth-secret` credentials
   minted on the `registered` ack so the MCP can relay through TURN
   without a separate issuer hop.
4. **Cross-region latency bench** — a harness that measures signaling
   RTT from different regional vantage points so we can characterise
   the network budget before committing to an agent-sensitive default
   (e.g. `SYNTHI_PIPELINE_BUDGET_MS`).

None of these change *local-dev behavior*. Every knob below defaults off
so running `docker-compose up` keeps working byte-identical.

---

## 1. `mcp-agent` role

Set on the MCP via env:

```bash
export SYNTHI_MCP_ROLE=mcp-agent
```

The MCP falls back to `observer` when unset — Path A, pre-Phase-4.

Signaling-server treats `mcp-agent` like `observer` for fanout (worker
media + HMR status reach every attached agent) but:

- **Presence.** Counted in `attached_agents`, same as `observer`.
- **TURN issuance.** Only `mcp-agent` peers receive TURN credentials on
  the register ack. Browsers and observers never do — those deployments
  already have their own ICE config.
- **Auth.** When `SYNTHI_AGENT_TOKEN_SECRET` is set on the
  signaling-server, every `role:"mcp-agent"` register is required to
  carry a valid token. Other roles are untouched.

---

## 2. Scoped agent tokens

### Server env

```bash
# 32+ bytes of entropy. Rotate alongside any issuer using it.
export SYNTHI_AGENT_TOKEN_SECRET='replace-with-real-secret'
```

When unset (default), token verification is disabled entirely —
backwards-compatible with every existing deployment.

### Issue a token

The simplest issuer is the helper bundled with the MCP package:

```bash
SYNTHI_AGENT_TOKEN_SECRET='…' \
  node mcp/synthi-mcp/scripts/issue-agent-token.mjs \
    --subject agent-alice \
    --session sess-xyz \
    --role mcp-agent \
    --ttl 3600
```

The token is an HS256 JWT with the claims:

```json
{
  "sub": "agent-alice",
  "scope": "mcp-agent",
  "session_id": "sess-xyz",
  "role": "mcp-agent",
  "iat": 1714000000,
  "exp": 1714003600
}
```

Any issuer that produces equivalent claims + signs with the same secret
works. A production issuer would live in the collab-server / auth
service so the MCP host never sees the HMAC secret; that integration
is deployment-specific.

### Use the token

```bash
export SYNTHI_MCP_ROLE=mcp-agent
export SYNTHI_AGENT_TOKEN="$(node scripts/issue-agent-token.mjs --subject agent-alice --session sess-xyz)"
synthi-mcp --session sess-xyz --signaling-url wss://signaling.example/:9000
```

On register the signaling-server verifies scope + session + expiry, and
echoes the verified subject back as `agent_subject` on the `registered`
ack + in the operator event log.

### Failure modes

| Error code                        | Meaning                                                     |
|-----------------------------------|-------------------------------------------------------------|
| `agent_token_required`            | Secret is configured but MCP sent no `agent_token`.         |
| `agent_token_malformed`           | Token is not a valid HS256 JWT.                             |
| `agent_token_unsupported_alg`     | Header `alg` is not `HS256`.                                |
| `agent_token_bad_signature`       | HMAC doesn't match — wrong secret or tampered payload.      |
| `agent_token_wrong_scope`         | `scope` claim is not `"mcp-agent"`.                         |
| `agent_token_session_mismatch`    | `session_id` claim doesn't match the register envelope.     |
| `agent_token_role_mismatch`       | `role` claim doesn't match the register envelope role.      |
| `agent_token_expired`             | `exp` is more than 60 s in the past (60 s skew tolerance).  |

All are returned as `{type:"register-error", code:"…"}` and close the
socket.

---

## 3. TURN credentials

Configure on the signaling-server:

```bash
# Shared secret (coturn's `use-auth-secret` flow).
export SYNTHI_TURN_SECRET='shared-with-coturn'
# Comma-separated URLs; coturn's REST format accepts both schemes.
export SYNTHI_TURN_URLS='turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349'
# TTL for issued credentials in seconds. Default 3600.
export SYNTHI_TURN_TTL_SECONDS=3600
```

coturn config (for reference):

```
use-auth-secret
static-auth-secret=shared-with-coturn
realm=turn.example.com
```

With those set, any `role:"mcp-agent"` register returns `turn_credentials`
on the ack:

```json
{
  "type": "registered",
  "turn_credentials": {
    "urls": ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
    "username": "1714003600:agent-alice",
    "credential": "<base64 HMAC-SHA1>",
    "expires_at": 1714003600
  }
}
```

The MCP splices these in front of any caller-supplied `iceServers` so
TURN candidates are tried first. The `SYNTHI_MCP_ICE_POLICY=relay` flag
still wins when present — relay-only forces candidate pruning after
gathering.

Username format matches coturn's `use-auth-secret` spec
(draft-uberti-behave-turn-rest-00): `<unix-expiry>:<subject>`. Audit
logs on the TURN server cross-reference by subject.

---

## 4. Cross-region latency bench

`scripts/cross-region-bench.mjs` measures signaling-layer RTT from
different regional vantage points against the same signaling-server.
Useful before committing to `SYNTHI_PIPELINE_BUDGET_MS` / frame-age
thresholds for a new region.

### Run from one region

```bash
node mcp/synthi-mcp/scripts/cross-region-bench.mjs \
  --url wss://signaling.example.com/ \
  --region eu-west \
  --iterations 30 \
  --role observer \
  > bench/eu-west.ndjson
```

### Compare two regions

Run it from `us-east` and `eu-west` against the same signaling host,
then diff the p95 of `register_ack_ms`. Worked example with the local
stub (from the repo root):

```bash
node mcp/synthi-mcp/scripts/cross-region-bench.mjs --url ws://127.0.0.1:9000 --region local --iterations 10
```

### What it measures

- `ws_connect_ms` — time to WebSocket open.
- `register_ack_ms` — time from `register` send to `registered` ack.
- `presence_rtt_ms` — time to the first `presence` broadcast (fires on
  register).
- `echo_rtt_ms` — round-trip for a post-register envelope. Imperfect —
  routes through the worker-fanout path — but good enough for relative
  comparisons.

### What it does NOT measure

- Dataplane RTT. WebRTC DTLS handshake, H.264 decode, frame-age
  distribution — all of those need a live worker. Use the long-cycle
  soak harness (`tests/soak/soak_loop.mjs`) against a real cluster for
  that, per-region.
- TURN relay latency. If you run TURN in a different region than the
  signaling-server, you'll want a separate `turn-latency` bench
  (ICE connectivity-check timing) — not in scope for this script.

### Output shape

NDJSON per iteration followed by a `---\n` separator and a single
aggregate-summary JSON object with `p50`/`p95`/`p99` per metric. Archive
both so you can replay/compare across commits.

---

## Deployment checklist

Before flipping any of this on in production:

- [ ] Rotate `SYNTHI_AGENT_TOKEN_SECRET` from any value used in staging;
      a leaked secret lets an attacker mint register tokens until expiry.
- [ ] coturn `realm` matches `SYNTHI_TURN_URLS` host. Mismatch → creds
      verify on the TURN server but reject at stun.
- [ ] TURN port reachable from the worker pod AND from wherever the MCP
      runs. Easiest failure mode: firewall blocks UDP 3478 outbound from
      MCP host → only relay paths via `turns:` (TCP 5349) succeed.
- [ ] Issuer (or local token helper) uses the same `SYNTHI_AGENT_TOKEN_SECRET`
      as the signaling-server. A typo here produces
      `agent_token_bad_signature` on every register.
- [ ] Operator event log surfaces `agent_subject` — confirm your
      operator UI shows it alongside `peer_id` (the `EscapeHatchPanel`
      and `OperatorPanel` in `synthi/src/app/workspace/[slug]/operator/`
      consume the same envelope).
