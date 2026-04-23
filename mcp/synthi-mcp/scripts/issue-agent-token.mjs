#!/usr/bin/env node
/**
 * issue-agent-token — mint a Phase-4 scoped agent token matching the
 * HS256 format `signaling-server/src/agent_auth.rs::verify_agent_token`
 * enforces.
 *
 * Usage:
 *   SYNTHI_AGENT_TOKEN_SECRET=... node scripts/issue-agent-token.mjs \
 *     --subject agent-foo --session sid-abc [--role mcp-agent] [--ttl 3600]
 *
 * The secret MUST be the exact same string the signaling-server has in its
 * `SYNTHI_AGENT_TOKEN_SECRET` env. Rotate it out-of-band whenever you'd
 * rotate a production JWT secret.
 *
 * Prints the token on stdout so callers can `export SYNTHI_AGENT_TOKEN=$(...)`
 * or pipe it into an MCP config.
 */

import { createHmac } from "node:crypto";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`issue-agent-token: ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const secret = process.env.SYNTHI_AGENT_TOKEN_SECRET;
if (!secret) die("SYNTHI_AGENT_TOKEN_SECRET env must be set");
if (!args.subject) die("missing --subject <agent-id>");
if (!args.session) die("missing --session <session-id>");
const role = args.role ?? "mcp-agent";
const ttl = Number.isFinite(+args.ttl) ? +args.ttl : 3600;

const iat = Math.floor(Date.now() / 1000);
const exp = iat + ttl;

const header = { alg: "HS256", typ: "JWT" };
const payload = {
  sub: args.subject,
  scope: "mcp-agent",
  session_id: args.session,
  role,
  iat,
  exp,
};
const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const sig = createHmac("sha256", secret).update(signingInput).digest();
const token = `${signingInput}.${b64url(sig)}`;
process.stdout.write(`${token}\n`);
