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
      required_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL or SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE"],
      cdp_endpoint_source: "not-configured",
      cdp_topology: "unspecified",
      runtime_host_class: "invalid",
      non_loopback_runtime: false,
      cdp_header_names: [],
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
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "agent-a",
        workspace_url: "https://workspace.example.test/workspace/browser",
        runtime_id: "runtime-a",
        runtime_session_id: "session-a",
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
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      actor_id: "agent-a",
      runtime_id: "runtime-a",
      session_id: "session-a",
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

  it("keeps the opened workspace tab when runtime tab enumeration is stale", async () => {
    const broker = new BrowserBroker();
    broker.requestConsent("https://workspace.example.test", "granted", "unit", { screenshot: true });
    const deps: HostedBrowserAttachDeps = {
      async attach() {
        return [{ tab_id: "bootstrap", url: "about:blank", active: true }];
      },
      async open(url: string) {
        return { tab_id: "target", url, active: true };
      },
      async listTabs() {
        return [{ tab_id: "bootstrap", url: "about:blank", active: false }];
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
        SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://workspace.example.test",
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected_hosted_attach_success");
    expect(result.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tab_id: "target",
        url: "https://workspace.example.test/workspace/browser",
      }),
    ]));
    expect(broker.selectTab("target")).toEqual(expect.objectContaining({
      tab_id: "target",
      url: "https://workspace.example.test/workspace/browser",
    }));
  });

  it("renders runtime-scoped CDP templates and forwards sanitized attach headers", async () => {
    const broker = new BrowserBroker();
    broker.requestConsent("https://workspace.example.test", "granted", "unit", { screenshot: true });
    let attachCall: { cdpUrl: string; headers: Record<string, string> } | null = null;
    const deps: HostedBrowserAttachDeps = {
      async attach(cdpUrl, options) {
        attachCall = { cdpUrl, headers: options?.headers ?? {} };
        return [{ tab_id: "hosted_tab_1", url: "https://workspace.example.test/runtime", active: true }];
      },
      async open(url: string) {
        return { tab_id: "hosted_tab_1", url, active: true };
      },
      async listTabs() {
        return [{ tab_id: "hosted_tab_1", url: "https://workspace.example.test/runtime", active: true }];
      },
    };

    const env = {
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://fallback.example.test/devtools",
      SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE: "http://{runtimeId}.synthi.svc.cluster.local:{cdpPort}",
      SYNTHI_HOSTED_BROWSER_CDP_PORT: "9333",
      SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY: "runtime-service",
      SYNTHI_HOSTED_BROWSER_CDP_HEADERS_JSON: JSON.stringify({
        Authorization: "Bearer runtime-token",
        "X-Synthi-Runtime": "rt-unit-a",
        "Invalid Header": "ignored",
      }),
      SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://workspace.example.test",
      SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS: "900000",
    };

    const readiness = resolveHostedBrowserRuntime({
      workspace_id: "workspace-a",
      runtime_id: "rt-unit-a",
      workspace_url: "https://workspace.example.test/runtime",
    }, env);

    expect(readiness).toEqual(expect.objectContaining({
      configured: true,
      runtime_id: "rt-unit-a",
      cdp_endpoint_source: "runtime-template",
      cdp_topology: "runtime-service",
      runtime_host_class: "remote",
      cdp_header_names: ["Authorization", "X-Synthi-Runtime"],
    }));
    expect(readiness).not.toHaveProperty("cdpUrl");
    expect(readiness).not.toHaveProperty("cdpHeaders");

    const result = await attachHostedBrowserRuntime(
      {
        workspace_id: "workspace-a",
        runtime_id: "rt-unit-a",
        workspace_url: "https://workspace.example.test/runtime",
      },
      deps,
      broker,
      env
    );

    expect(result.ok).toBe(true);
    expect(attachCall).toEqual({
      cdpUrl: "http://rt-unit-a.synthi.svc.cluster.local:9333",
      headers: {
        Authorization: "Bearer runtime-token",
        "X-Synthi-Runtime": "rt-unit-a",
      },
    });
  });

  it("generates a hosted runtime session id when callers do not provide one", async () => {
    const broker = new BrowserBroker();
    broker.requestConsent("https://workspace.example.test", "granted", "unit", { screenshot: true });
    const deps: HostedBrowserAttachDeps = {
      async attach() {
        return [{ tab_id: "hosted_tab_1", url: "https://workspace.example.test/workspace/browser", active: true }];
      },
      async open(url: string) {
        return { tab_id: "hosted_tab_1", url, active: true };
      },
      async listTabs() {
        return [{ tab_id: "hosted_tab_1", url: "https://workspace.example.test/workspace/browser", active: true }];
      },
    };

    const result = await attachHostedBrowserRuntime(
      {
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "agent-a",
        workspace_url: "https://workspace.example.test/workspace/browser",
      },
      deps,
      broker,
      {
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime/devtools",
        SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://workspace.example.test",
        SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS: "900000",
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected_hosted_attach_success");
    expect(result.runtime.session_id).toMatch(/^hosted_session_/);
    expect(result.runtime).toEqual(expect.objectContaining({
      tenant_id: "tenant-a",
      actor_id: "agent-a",
      workspace_id: "workspace-a",
    }));
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

  it("blocks browser actions after a hosted runtime session expires", () => {
    const broker = new BrowserBroker();
    const url = "https://workspace.example.test/workspace/browser";
    broker.requestConsent(url);
    broker.registerTabs([{ tab_id: "hosted_tab", url, active: true }]);
    const lease = broker.acquireLease("agent", 5000, "unit");
    broker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: url,
      adapter: "hosted-playwright-cdp",
      expires_at: Date.now() - 1,
      origin_allowlist: ["https://workspace.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    });

    const queued = broker.queueAction({
      lease_id: lease.lease_id,
      tab_id: "hosted_tab",
      action: "click",
      url,
    });

    expect(queued).toEqual({ ok: false, error: "hosted_runtime_session_expired" });
    expect(broker.runtimeAttachment()).toEqual(expect.objectContaining({
      revoked_reason: "expired",
    }));
  });

  it("blocks snapshots after a hosted runtime session is revoked", () => {
    const broker = new BrowserBroker();
    const url = "https://workspace.example.test/workspace/browser";
    broker.requestConsent(url, "granted", "unit", { screenshot: true });
    broker.registerTabs([{ tab_id: "hosted_tab", url, active: true }]);
    broker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: url,
      adapter: "hosted-playwright-cdp",
      expires_at: Date.now() + 60_000,
      origin_allowlist: ["https://workspace.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    });

    const revoked = broker.revokeRuntimeAttachment("operator_revoked");
    const snapshot = broker.snapshot({ tab_id: "hosted_tab", url });

    expect(revoked).toEqual(expect.objectContaining({ revoked: true }));
    expect(snapshot).toEqual({ ok: false, error: "hosted_runtime_session_revoked" });
  });
});
