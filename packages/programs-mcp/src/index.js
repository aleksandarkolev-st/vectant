#!/usr/bin/env node
/**
 * @fileoverview stdio entry point for the vectant-programs-mcp server. Register
 * it with any MCP host (Claude Code, Codex, Cursor) that runs in a Vectant
 * workspace terminal so the agent can describe / validate / generate a
 * vectant.programs.json.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProgramsMcpServer } from './server.js';

async function main() {
  const server = createProgramsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('vectant-programs-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`vectant-programs-mcp fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
