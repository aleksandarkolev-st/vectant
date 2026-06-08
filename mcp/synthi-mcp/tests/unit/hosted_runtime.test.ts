import { describe, expect, it } from "vitest";
import { BrowserBroker } from "../../src/browser/broker.js";
import {
  attachHostedBrowserRuntime,
  resolveHostedBrowserRuntime,
  type HostedBrowserAttachDeps,
} from "../../src/browser/hosted_runtime.js";

describe("hosted browser runtime resolver", () => {
  it("does not treat the local dev CDP harness as hosted runtime config", () => {
    const readiness = resolveHostedBrowserRuntime(
      { workspace_id: "workspace-a" },
      { SYNTHI_BROWSER_CDP_URL: "http://127.0.0.1:9222" }
    );

    expect(readiness).toEqual(expect.objectContaining({
      configured: false,
      workspace_id: "workspace-a",
      adapter: "not-configured",
      ignored_local_dev_env: ["SYNTHI_BROWSER_CDP_URL"],
      required_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
    }));
    expect(readiness).not.toHaveProperty("cdpUrl");
  });

  it("attaches a configured hosted runtime through the broker without exposing raw CDP", async () => {
    const broker = new BrowserBroker();
    broker.requestConsent("https://workspace.example.test", "granted", "unit", { screenshot: true });
    const deps: HostedBrowserAttachDeps = {
      async attach() {
        return [{ tab_id: "hosted_tab_1", url: "https://other.example.test", active: true }];
      },
      async open(url: string) {
        return { tab_id: "hosted_tab_2", url, active: true };
      },
      async listTabs() {
        return [
          { tab_id: "hosted_tab_1", url: "https://other.example.test", active: false },
          { tab_id: "hosted_tab_2", url: "https://workspace.example.test/workspace/browser", active: true },
        ];
      },
    };

    const result = await attachHostedBrowserRuntime(
      {
        workspace_id: "workspace-a",
        workspace_url: "https://workspace.example.test/workspace/browser",
        runtime_id: "runtime-a",
      },
      deps,
      broker,
      { SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime/devtools" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected_hosted_attach_success");
    expect(result).not.toHaveProperty("cdp_url");
    expect(result.runtime).toEqual(expect.objectContaining({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: "https://workspace.example.test/workspace/browser",
      adapter: "hosted-playwright-cdp",
    }));
    expect(result.tabs.map((tab) => tab.tab_id)).toEqual(["hosted_tab_2"]);
    expect(result.hidden_tabs).toBe(1);
    expect(broker.runtimeAttachment()).toEqual(expect.objectContaining({ kind: "hosted" }));
  });
});
