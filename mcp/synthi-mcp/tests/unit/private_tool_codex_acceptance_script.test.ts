// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildCodexProcessEnv,
  buildCodexConfigToml,
  extractCodexMcpEvidence,
} from "../../scripts/private-tool-codex-acceptance.mjs";

describe("private-tool Codex acceptance harness", () => {
  it("configures Codex through the hosted browser runtime path", () => {
    const config = buildCodexConfigToml({
      codexReasoning: "low",
      codexModel: "gpt-5.3-spark",
      distIndex: "/repo/mcp/synthi-mcp/dist/index.js",
      storeFile: "/tmp/private-tools.enc.json",
      storeKey: "private-tool-key",
      storeScope: "acceptance-scope",
      cdpUrl: "ws://runtime.example.test/devtools/browser/session",
      targetUrl: "https://preview.example.test/workspace",
      workspaceId: "acceptance-workspace",
    });

    expect(config).toContain('model = "gpt-5.3-spark"');
    expect(config).toContain("SYNTHI_HOSTED_BROWSER_CDP_URL");
    expect(config).toContain("SYNTHI_HOSTED_BROWSER_WORKSPACE_URL");
    expect(config).toContain("SYNTHI_WORKSPACE_ID");
    expect(config).not.toContain("SYNTHI_BROWSER_CDP_URL");
    expect(config).not.toMatch(/browser-mcp-live|\/port\/\d+|C:\\\\/i);
  });

  it("requires hosted workspace attach evidence instead of local CDP attach", () => {
    const toolName = "synthi_app_open_details";
    const targetUrl = "https://preview.example.test/workspace";
    const evidence = extractCodexMcpEvidence({
      toolName,
      targetUrl,
      events: [
        completedCall("synthi_browser_attach_current_workspace", {}),
        completedCall("synthi_browser_request_consent", { url: targetUrl }),
        completedCall("synthi_browser_open", { url: targetUrl }),
        completedCall(toolName, {}, {
          ok: true,
          private_tool: { tool_name: toolName },
          replay: { status: "passed", steps_run: 1 },
        }),
      ],
    });

    expect(evidence).toEqual(expect.objectContaining({
      attach_call: true,
      hosted_attach_call: true,
      local_attach_call: false,
      consent_call: true,
      open_call: true,
      private_tool_call: true,
      private_tool_result_ok: true,
      private_tool_steps_run: 1,
    }));

    const localAttachEvidence = extractCodexMcpEvidence({
      toolName,
      targetUrl,
      events: [completedCall("synthi_browser_attach", {})],
    });
    expect(localAttachEvidence.hosted_attach_call).toBe(false);
    expect(localAttachEvidence.local_attach_call).toBe(true);
  });

  it("strips local CDP env from the Codex child process", () => {
    const env = buildCodexProcessEnv({
      codexHome: "/tmp/synthi-codex-home",
      baseEnv: {
        CODEX_HOME: "/tmp/original-codex-home",
        SYNTHI_BROWSER_CDP_URL: "ws://local-dev-cdp.example.test/devtools/browser/session",
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      },
    });

    expect(env.CODEX_HOME).toBe("/tmp/synthi-codex-home");
    expect(env.SYNTHI_HOSTED_BROWSER_CDP_URL).toBe("ws://hosted-runtime.example.test/devtools/browser/session");
    expect(env).not.toHaveProperty("SYNTHI_BROWSER_CDP_URL");
  });
});

function completedCall(tool, args, structuredContent = {}) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      status: "completed",
      tool,
      arguments: args,
      result: { structured_content: structuredContent },
    },
  };
}
