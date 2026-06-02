# Slice 1b — Manual E2E (CLI consumer, closes criterion #4)

Prereqs: running Postgres + Synthi (`npx prisma db push` applied) + a Gemini key not required
(the CLI agent uses its own LLM). At least one connected external MCP with ≥1 tool allowlisted.

1. **Generate a PAT.** In Synthi → Connected Tools → "CLI Access", create a token; copy the
   plaintext (shown once).
2. **Register synthi-mcp.** Set `SYNTHI_API_URL`, `SYNTHI_PAT` (and optional `SYNTHI_WORKSPACE_SLUG`)
   in the MCP host registration (or `mcp/synthi-mcp/.env`). Build: `cd mcp/synthi-mcp && npm run build`.
3. **Attach a CLI agent** (e.g. Claude Code) and list tools. ✅ Expect built-in `synthi_*` tools
   PLUS `ext_<i>` entries described `[<connection>] <tool>`.
4. **Call a proxied tool** (e.g. the agent invokes `ext_0` for a connected GitHub/Sentry/Linear
   action). ✅ Expect the remote MCP result returned.
5. **Verify the audit trail.** In Postgres: `SELECT callerType, alias, serverName, toolName, outcome,
   argsHash, argsBytes, resultBytes FROM "McpCallAudit" WHERE "callerType" = 'cli' ORDER BY "createdAt"
   DESC LIMIT 5;` ✅ Expect a `cli` row with a 64-hex `argsHash` and byte sizes — never raw args.
6. **Revoke + re-attach.** Revoke the PAT in the UI; restart the MCP. ✅ Expect external tools absent
   (401 at resolve) while `synthi_*` tools still work.
