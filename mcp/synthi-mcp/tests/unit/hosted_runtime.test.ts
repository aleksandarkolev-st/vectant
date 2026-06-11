import { describe, expect, it } from "vitest";
import { BrowserBroker } from "../../src/browser/broker.js";
import {
  attachHostedBrowserRuntime,
  parseOriginAllowlist,
  resolveHostedBrowserRuntime,
  type HostedBrowserAttachDeps,
} from "../../src/browser/hosted_runtime.js";

describe("hosted browser runtime resolver", () => {
  it("normalizes origin allowlists to unique origins", () => {
    expect(parseOriginAllowlist("https://app.example.test/a, https://app.example.test/b, not-a-url, https://docs.example.test")).toEqual([
      "https://app.example.test",
      "https://docs.example.test",
    ]);
  });

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
      origin_allowlist: [],
      session_ttl_ms: null,
      local_network_allowed: false,
      redact_screenshots: true,
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
      {
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime/devtools",
        SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://workspace.example.test",
        SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS: "900000",
        SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS: "1",
      }
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
      origin_allowlist: ["https://workspace.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    }));
    expect(typeof result.runtime.expires_at).toBe("number");
    expect(result.runtime.expires_at).toBeGreaterThan(Date.now());
    expect(result.tabs.map((tab) => tab.tab_id)).toEqual(["hosted_tab_2"]);
    expect(result.hidden_tabs).toBe(1);
    expect(broker.runtimeAttachment()).toEqual(expect.objectContaining({ kind: "hosted" }));
  });

  it("fails closed when a configured origin allowlist excludes the workspace origin", async () => {
    const broker = new BrowserBroker();
    const deps: HostedBrowserAttachDeps = {
      async attach() {
        throw new Error("attach_should_not_be_called");
      },
      async open() {
        throw new Error("open_should_not_be_called");
      },
      async listTabs() {
        return [];
      },
    };

    const result = await attachHostedBrowserRuntime(
      {
        workspace_id: "workspace-a",
        workspace_url: "https://workspace.example.test/workspace/browser",
      },
      deps,
      broker,
      {
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime/devtools",
        SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://other.example.test",
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: "hosted_runtime_origin_not_allowed",
      workspace_origin: "https://workspace.example.test",
      allowed_origins: ["https://other.example.test"],
    }));
    expect(broker.runtimeAttachment()).toBeNull();
  });
});
