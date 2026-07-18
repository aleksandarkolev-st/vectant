/**
 * @fileoverview Thin MCP glue: binds the dependency-light PROGRAMS_TOOLS to the
 * low-level SDK Server via ListTools/CallTool handlers. All behavior lives in the
 * pure modules (tools.js → validate.js / manifestSpec.js / generateClient.js);
 * this file only translates between them and the wire protocol.
 */

// Low-level Server (raw JSON-Schema tools, no Zod dependency) — same API the
// sibling mcp/synthi-mcp package uses. The SDK marks it "deprecated" in favor of
// the higher-level McpServer, but that path requires Zod schemas; we deliberately
// keep this package dependency-light.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PROGRAMS_TOOLS } from './tools.js';

export function createProgramsMcpServer() {
  const server = new Server(
    { name: 'vectant-programs-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: PROGRAMS_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = PROGRAMS_TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }] };
    }
    let result;
    try {
      result = await tool.handler(request.params.arguments || {});
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `tool error: ${e?.message || e}` }] };
    }
    const text = typeof result.text === 'string' ? result.text : JSON.stringify(result.structuredContent ?? result, null, 2);
    const out = { content: [{ type: 'text', text }] };
    if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent;
    return out;
  });

  return server;
}
