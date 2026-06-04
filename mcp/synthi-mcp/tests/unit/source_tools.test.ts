import { afterEach, describe, expect, it } from "vitest";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { SOURCE_TOOL_NAMES, SOURCE_TOOLS, dispatchSourceTool } from "../../src/tools/source.js";

afterEach(() => {
  sourceIdentityRegistry.resetForTests();
});

describe("source identity MCP tool surface", () => {
  it("advertises every source identity tool in the capability registry", () => {
    for (const name of SOURCE_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(SOURCE_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns null for non-source tool dispatch", async () => {
    expect(await dispatchSourceTool("synthi_health", {})).toBeNull();
  });

  it("reports source identity mapping status and resolves registered tokens", async () => {
    sourceIdentityRegistry.register({
      workspaceId: "workspace-a",
      root: "/repo",
      filePath: "/repo/src/App.jsx",
      tokens: [{ token: "s_known", file: "src/App.jsx", line: 7, column: 11, tag: "button" }],
    });

    const status = await dispatchSourceTool("synthi_source_get_mapping_status", { workspace_id: "workspace-a" });
    expect(status?.isError).toBeUndefined();
    expect((status?.structuredContent as { mapping_status: { status: string; token_count: number; file_count: number } }).mapping_status).toEqual(
      expect.objectContaining({
        status: "mapped",
        token_count: 1,
        file_count: 1,
      })
    );

    const lookup = await dispatchSourceTool("synthi_source_lookup_token", {
      workspace_id: "workspace-a",
      token: "s_known",
    });
    expect(lookup?.isError).toBeUndefined();
    expect((lookup?.structuredContent as { source: { file: string; line: number; column: number; workspace_id: string } }).source).toEqual(
      expect.objectContaining({
        workspace_id: "workspace-a",
        file: "src/App.jsx",
        line: 7,
        column: 11,
      })
    );
  });

  it("classifies missing source tokens without guessing a file path", async () => {
    const missing = await dispatchSourceTool("synthi_source_lookup_token", {
      workspace_id: "workspace-a",
      token: "s_missing",
    });

    expect(missing?.isError).toBe(true);
    expect(missing?.structuredContent).toEqual(expect.objectContaining({
      error: "source_token_not_found",
      token: "s_missing",
      next_action: "run_with_source_identity_transform_or_add_affordance",
    }));
    expect((missing?.structuredContent as { mapping_status: { token_count: number } }).mapping_status.token_count).toBe(0);
  });

  it("suggests stable source affordance attributes for unresolved steps", async () => {
    const affordance = await dispatchSourceTool("synthi_source_suggest_affordance_patch", {
      step_id: "browser_evt_7",
      label: "Save Settings",
    });
    expect(affordance?.isError).toBeUndefined();
    expect((affordance?.structuredContent as { patch: { suggested_attribute: string; source_identity_attribute: string } }).patch).toEqual(
      expect.objectContaining({
        suggested_attribute: "data-synthi-affordance=\"save.settings\"",
        source_identity_attribute: "data-synthi-source-id",
      })
    );

    const boundary = await dispatchSourceTool("synthi_source_suggest_affordance_patch", {
      label: "Delete account",
      kind: "mutationBoundary",
    });
    expect((boundary?.structuredContent as { patch: { suggested_attribute: string } }).patch.suggested_attribute).toBe(
      "data-synthi-mutation-boundary=\"delete.account\""
    );
  });
});
