import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProgramsMcpServer } from '../server.js';

// End-to-end: a real MCP client talks to the server over the SDK's in-memory
// transport, exercising initialize + tools/list + tools/call through the glue.
describe('programs-mcp round-trip', () => {
  let client;
  let server;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createProgramsMcpServer();
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('lists the three tools with input schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'describe_manifest_schema',
      'generate_manifest',
      'validate_manifest',
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('calls describe_manifest_schema and gets the reference back', async () => {
    const res = await client.callTool({ name: 'describe_manifest_schema', arguments: {} });
    expect(res.structuredContent.fields.length).toBeGreaterThan(0);
    expect(res.content[0].text).toContain('vectant.programs.json');
  });

  it('calls validate_manifest and gets a structured verdict', async () => {
    const good = await client.callTool({ name: 'validate_manifest', arguments: { manifest: { packageId: 'x', version: '1.0.0', launch: 'run' } } });
    expect(good.structuredContent.valid).toBe(true);

    const bad = await client.callTool({ name: 'validate_manifest', arguments: { manifest: { packageId: '../evil' } } });
    expect(bad.structuredContent.valid).toBe(false);
    expect(bad.structuredContent.errors.length).toBeGreaterThan(0);
  });

  it('generate_manifest reports not_configured when no backend URL is set', async () => {
    const res = await client.callTool({ name: 'generate_manifest', arguments: { files: { 'package.json': '{}' } } });
    expect(res.structuredContent.configured).toBe(false);
    expect(res.content[0].text).toContain('not_configured');
  });
});
