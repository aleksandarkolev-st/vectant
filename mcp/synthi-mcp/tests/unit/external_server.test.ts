import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSynthiServer } from "../../src/server.js";
import type { ExternalTools } from "../../src/external/index.js";

const externalTools: ExternalTools = {
  descriptors: [{ name: "ext_0", description: "[gh] Open a PR", inputSchema: { type: "object", properties: {} } }],
  aliasMap: { ext_0: { connId: "c1", connName: "gh", toolName: "create_pr", config: { id: "c1", name: "gh", url: "https://gh/mcp" } } },
};

async function connectedClient(opts: Parameters<typeof createSynthiServer>[0]) {
  const server = createSynthiServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("external tools wired into the MCP server", () => {
  it("advertises ext_<i> alongside the built-in synthi_* tools", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x", externalTools });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("synthi_attach");
    expect(names).toContain("ext_0");
  });

  it("does not advertise ext_ tools when none are configured", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x" });
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith("ext_"))).toBe(false);
  });
});
