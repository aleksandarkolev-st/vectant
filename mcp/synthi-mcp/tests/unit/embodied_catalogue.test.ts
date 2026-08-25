import { describe, expect, it } from "vitest";
import { STATIC_TOOL_DEFINITIONS } from "../../src/server.js";
import { dispatchEmbodied, EMBODIED_TOOLS, EMBODIED_TOOL_NAMES } from "../../src/browser_workflow_bridge/embodied_dispatch.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";

describe("embodied teaching tools on the main MCP catalogue", () => {
  it("every embodied verb is advertised in the registry", () => {
    for (const name of EMBODIED_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
    }
  });

  it("every embodied verb has a static tool definition with a schema", () => {
    const staticNames = new Set(STATIC_TOOL_DEFINITIONS.map((tool) => tool.name));
    for (const name of EMBODIED_TOOL_NAMES) {
      expect(staticNames.has(name), `${name} missing from STATIC_TOOL_DEFINITIONS`).toBe(true);
    }
    expect(EMBODIED_TOOLS.map((tool) => tool.name)).toEqual([...EMBODIED_TOOL_NAMES]);
    for (const tool of EMBODIED_TOOLS) {
      expect(tool.description.length, `${tool.name} needs a description`).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("dispatch responds to each verb (unknown-session errors are fine, unknown_tool is not)", async () => {
    for (const name of EMBODIED_TOOL_NAMES) {
      const response = await dispatchEmbodied(name, {});
      expect(response, `${name} did not dispatch`).not.toBeNull();
      const text = response?.content?.[0]?.type === "text" ? response.content[0].text : "";
      expect(text.includes('"unknown_tool"'), `${name} fell through to unknown_tool: ${text}`).toBe(false);
    }
  });

  it("non-embodied names still return null from dispatchEmbodied", async () => {
    expect(await dispatchEmbodied("synthi_screenshot", {})).toBeNull();
  });
});
