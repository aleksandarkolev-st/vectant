# Plan 1a — Manual E2E checklist

Prereq: `AUTH_SECRET` set; Postgres reachable; schema applied (`cd synthi && npx prisma db push`) and roles backfilled (run `synthi/prisma/backfills/backfill-workspace-roles.sql` against the DB); a hosted MCP server URL + token available
(e.g. a public reference MCP, or GitHub's hosted MCP).

1. Start the app (`cd synthi && npm run dev`) and open a workspace.
2. Open the **Connected Tools** panel from the left activity bar.
3. Click **Add connection** → enter name, the MCP URL, choose **Bearer token**, paste the token,
   scope **Personal** → Save. Expect a success toast.
4. Click the connection's **test** (refresh) icon. Expect a green health dot and a tool list.
5. Tick one or two tools to add them to the allowlist.
6. Open **AI Chat**, ask the model to do something that needs that tool
   (e.g. "list my GitHub issues"). Expect a `toolCall` chip showing `<server>:<tool>` and a
   useful answer.
7. In the DB, confirm an `McpCallAudit` row exists with `outcome='ok'`.
8. Negative checks:
   - Add a connection with URL `https://localhost/mcp` → test → expect `ssrf_blocked`.
   - Untick all tools → ask the AI to use it → the tool is not offered (fail-closed).
   - Toggle the connection **off** → tools are not offered.
9. Secret hygiene: reload the panel; confirm the secret is never returned (only a masked hint),
   and that GET `/api/integrations/connections` contains no cipher/secret fields.
