// @ts-nocheck
import { describe, expect, it } from "vitest";
import { freshMcpProcessEnv } from "../../scripts/workflow-pipeline-e2e.mjs";

describe("workflow pipeline harness", () => {
  it("passes hosted runtime env to fresh MCP verification without local CDP leakage", () => {
    const env = freshMcpProcessEnv({
      baseEnv: {
        SYNTHI_BROWSER_CDP_URL: "ws://local-dev-cdp.example.test/devtools/browser/session",
        KEEP_ME: "yes",
      },
      privateWorkflowStoreEnv: {
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "/tmp/private-tools.enc.json",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "private-tool-key",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "scope",
      },
      cdpUrl: "ws://hosted-runtime.example.test/devtools/browser/session",
      previewUrl: "https://preview.example.test/workspace",
      workspaceId: "workspace-123",
    });

    expect(env.KEEP_ME).toBe("yes");
    expect(env.SYNTHI_HOSTED_BROWSER_CDP_URL).toBe("ws://hosted-runtime.example.test/devtools/browser/session");
    expect(env.SYNTHI_HOSTED_BROWSER_WORKSPACE_URL).toBe("https://preview.example.test/workspace");
    expect(env.SYNTHI_WORKSPACE_ID).toBe("workspace-123");
    expect(env.SYNTHI_AGENT_ID).toBe("workflow_pipeline_fresh_mcp_acceptance");
    expect(env.SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE).toBe("/tmp/private-tools.enc.json");
    expect(env).not.toHaveProperty("SYNTHI_BROWSER_CDP_URL");
  });
});
