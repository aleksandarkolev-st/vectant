import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSynthiServer, STATIC_TOOL_DEFINITIONS } from "../../src/server.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
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
  it("keeps the advertised registry and static MCP definitions exactly aligned with descriptions", () => {
    const registered = STATIC_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered).toEqual(ADVERTISED_TOOLS);
    expect(STATIC_TOOL_DEFINITIONS.every((tool) => tool.description.trim().length > 0)).toBe(true);
  });

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

  it("routes an atomic task before exposing a bounded execution subset", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x" });
    const response = await client.callTool({
      name: "synthi_route_atomic_task",
      arguments: { description: "Attach the runtime." },
    });
    const text = response.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    if (!text || text.type !== "text") throw new Error("atomic route response must contain text");

    const route = JSON.parse(text.text);
    expect(route).toEqual(expect.objectContaining({
      role: "infrastructure",
      skills: ["vectant-runtime"],
      validation: "independent",
      suggested_tools: ["synthi_attach"],
    }));
    expect(route.skill_metadata).toEqual([
      expect.objectContaining({ id: "vectant-runtime", groups: expect.arrayContaining(["runtime", "attachment"]) }),
    ]);
    expect(route.tool_metadata).toEqual([
      expect.objectContaining({
        name: "synthi_attach",
        description: expect.stringContaining("WebRTC peer"),
      }),
    ]);
    expect(text.text).not.toContain("inputSchema");
    expect(text.text).not.toContain("synthi_codesite_open_transaction");
  });

  it("routes dynamically connected tools from metadata without returning their schemas", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x", externalTools });
    const response = await client.callTool({
      name: "synthi_route_atomic_task",
      arguments: { description: "Use gh to open a PR." },
    });
    const text = response.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    if (!text || text.type !== "text") throw new Error("atomic route response must contain text");

    const route = JSON.parse(text.text);
    expect(route.suggested_tools).toContain("ext_0");
    expect(route.tool_metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ext_0", description: "[gh] Open a PR" }),
    ]));
    expect(text.text).not.toContain("inputSchema");
    expect(text.text).not.toContain('"properties"');
  });

  it("teaches connected MCP hosts the mandatory atomic routing protocol", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x" });

    const instructions = client.getInstructions();
    expect(instructions).toContain("passive instruction documents");
    expect(instructions).not.toContain(".synthi/AGENTS.md");
    expect(instructions).toContain("synthi_route_atomic_task");
    expect(instructions).toContain("Never provide the full tool catalog");
  });
});
