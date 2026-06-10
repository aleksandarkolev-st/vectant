import { describe, expect, it } from "vitest";
import { browserWorkflowDeploymentReadiness } from "../../src/browser/deployment_readiness.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

describe("browser workflow deployment readiness", () => {
  it("passes production readiness with hosted runtime, scoped stores, bridge token, and no local CDP env", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      SYNTHI_HOSTED_BROWSER_CDP_URL: "wss://runtime.example.test/devtools/browser/session-secret",
      SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://app.example.test/workspace/acme",
      SYNTHI_WORKSPACE_ID: "tenant-a:workspace-a",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "/var/lib/synthi/private-tools.enc.json",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "private-tool-secret",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "tenant-a:workspace-a",
      SYNTHI_AUTH_CHECKPOINT_STORE_FILE: "/var/lib/synthi/auth-checkpoints.enc.json",
      SYNTHI_AUTH_CHECKPOINT_STORE_KEY: "auth-store-secret",
      SYNTHI_AUTH_CHECKPOINT_SCOPE: "tenant-a:workspace-a",
      SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL: "https://workflow-bridge.example.test",
      SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN: "bridge-secret",
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.summary.failed).toBe(0);
    expect(readiness.checks.every((check) => check.status !== "fail")).toBe(true);
    expect(readiness.hosted_runtime).toEqual(expect.objectContaining({
      configured: true,
      workspace_id: "tenant-a:workspace-a",
      workspace_url: "https://app.example.test/workspace/acme",
    }));
    expect(JSON.stringify(readiness)).not.toMatch(/private-tool-secret|auth-store-secret|bridge-secret|session-secret/);
    expect(JSON.stringify(readiness)).not.toMatch(/SYNTHI_BROWSER_CDP_URL/);
  });

  it("fails production readiness for process-local stores and local CDP leakage", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://runtime.example.test/devtools/browser/session",
      SYNTHI_WORKSPACE_URL: "https://app.example.test/workspace/acme",
      SYNTHI_WORKSPACE_ID: "tenant-a:workspace-a",
      SYNTHI_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/local",
      SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT: "9466",
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "private_workflow_tool_store", status: "fail" }),
      expect.objectContaining({ id: "auth_checkpoint_store", status: "fail" }),
      expect.objectContaining({ id: "local_cdp_env_absent", status: "fail" }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/127\.0\.0\.1:9222|\/port\/\d+|browser-mcp-live/i);
  });

  it("exposes a redacted MCP tool report without secret values", async () => {
    const originalEnv = { ...process.env };
    try {
      process.env.SYNTHI_HOSTED_BROWSER_CDP_URL = "wss://runtime.example.test/devtools/browser/session-secret";
      process.env.SYNTHI_HOSTED_BROWSER_WORKSPACE_URL = "https://app.example.test/workspace/acme";
      process.env.SYNTHI_WORKSPACE_ID = "tenant-a:workspace-a";
      process.env.SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE = "/var/lib/synthi/private-tools.enc.json";
      process.env.SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY = "private-tool-secret";
      process.env.SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE = "tenant-a:workspace-a";
      process.env.SYNTHI_AUTH_CHECKPOINT_STORE_FILE = "/var/lib/synthi/auth-checkpoints.enc.json";
      process.env.SYNTHI_AUTH_CHECKPOINT_STORE_KEY = "auth-store-secret";
      process.env.SYNTHI_AUTH_CHECKPOINT_SCOPE = "tenant-a:workspace-a";
      process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL = "https://workflow-bridge.example.test";
      process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN = "bridge-secret";
      delete process.env.SYNTHI_BROWSER_CDP_URL;

      const response = await dispatchBrowserTool("synthi_browser_get_deployment_readiness", { mode: "production" });
      expect(response?.isError).not.toBe(true);
      const text = response?.content?.[0]?.type === "text" ? response.content[0].text : "";
      expect(text).toContain("synthi.browserWorkflowDeploymentReadiness.v1");
      expect(text).not.toMatch(/private-tool-secret|auth-store-secret|bridge-secret|session-secret/);
    } finally {
      process.env = originalEnv;
    }
  });
});
