// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildStdioMcpEnv,
  selectCdpTargetsToClose,
  stdioAcceptanceAttachEvidence,
} from "../../scripts/private-tool-stdio-acceptance.mjs";

describe("private-tool stdio acceptance harness", () => {
  it("configures the spawned MCP process through hosted runtime env only", () => {
    const env = buildStdioMcpEnv({
      baseEnv: {
        PATH: "/usr/bin",
        SYNTHI_BROWSER_CDP_URL: "ws://local-dev-cdp.example.test/devtools/browser/session",
      },
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "/tmp/private-tools.enc.json",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "private-tool-key",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "acceptance-scope",
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://preview.example.test/workspace",
      SYNTHI_WORKSPACE_ID: "acceptance-workspace",
      SYNTHI_AGENT_ID: "stdio_private_tool_acceptance",
    });

    expect(env).toEqual(expect.objectContaining({
      PATH: "/usr/bin",
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://preview.example.test/workspace",
      SYNTHI_WORKSPACE_ID: "acceptance-workspace",
      SYNTHI_AGENT_ID: "stdio_private_tool_acceptance",
    }));
    expect(env).not.toHaveProperty("SYNTHI_BROWSER_CDP_URL");
    expect(JSON.stringify(env)).not.toMatch(/browser-mcp-live|\/port\/\d+|C:\\\\/i);
  });

  it("requires hosted attach evidence instead of local CDP attach evidence", () => {
    const hostedEvidence = stdioAcceptanceAttachEvidence({
      attachResult: {
        parsed: {
          ok: true,
          runtime: {
            kind: "hosted",
            adapter: "hosted-playwright-cdp",
            workspace_id: "acceptance-workspace",
          },
        },
      },
    });
    const localEvidence = stdioAcceptanceAttachEvidence({
      attachResult: {
        parsed: {
          ok: true,
          runtime: {
            kind: "local-dev-cdp",
            adapter: "playwright-cdp",
          },
        },
      },
    });

    expect(hostedEvidence).toEqual({
      hosted_attach: true,
      local_attach: false,
      runtime_kind: "hosted",
      product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    });
    expect(localEvidence).toEqual(expect.objectContaining({
      hosted_attach: false,
      local_attach: true,
      runtime_kind: "local-dev-cdp",
    }));
  });

  it("does not prune the final CDP page target out from under the hosted runtime", () => {
    expect(selectCdpTargetsToClose([{ id: "keep", type: "webview" }])).toEqual([]);
    expect(selectCdpTargetsToClose([
      { id: "keep", type: "webview" },
      { id: "close", type: "page" },
    ]).map((target) => target.id)).toEqual(["close"]);
  });
});
