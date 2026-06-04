import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { browserBridgeServer } from "../../src/browser/bridge_server.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, dispatchBrowserTool } from "../../src/tools/browser.js";

const originalBrowserCdpUrl = process.env["SYNTHI_BROWSER_CDP_URL"];

beforeEach(() => {
  browserBroker.resetForTests();
  eventLog._resetForTests();
  delete process.env["SYNTHI_BROWSER_CDP_URL"];
});

afterEach(async () => {
  await browserBridgeServer.stop();
  if (originalBrowserCdpUrl === undefined) {
    delete process.env["SYNTHI_BROWSER_CDP_URL"];
  } else {
    process.env["SYNTHI_BROWSER_CDP_URL"] = originalBrowserCdpUrl;
  }
});

describe("browser MCP tool surface", () => {
  it("advertises every browser tool in the capability registry", () => {
    for (const name of BROWSER_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(BROWSER_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns null for non-browser tool dispatch", async () => {
    expect(await dispatchBrowserTool("synthi_health", {})).toBeNull();
  });

  it("round-trips exact-origin consent through browser tools", async () => {
    const grant = await dispatchBrowserTool("synthi_browser_request_consent", {
      url: "https://app.example.com",
      screenshot: false,
      reason: "unit-test",
    });
    expect(grant?.isError).toBeUndefined();
    expect((grant?.structuredContent as { consent: { status: string } }).consent.status).toBe("granted");
    expect((grant?.structuredContent as { consent: { screenshot: string; diagnostics: string } }).consent).toEqual(
      expect.objectContaining({ screenshot: "denied", diagnostics: "granted" })
    );

    const records = await dispatchBrowserTool("synthi_browser_get_consent", {
      url: "https://app.example.com/path",
    });
    expect((records?.structuredContent as { consent: Array<{ origin: string; status: string }> }).consent).toEqual([
      expect.objectContaining({ origin: "https://app.example.com", status: "granted" }),
    ]);

    const revoke = await dispatchBrowserTool("synthi_browser_revoke_consent", {
      url: "https://app.example.com",
      reason: "done",
    });
    expect((revoke?.structuredContent as { consent: { status: string } }).consent.status).toBe("denied");
  });

  it("acquires and releases browser control leases through tools", async () => {
    const acquired = await dispatchBrowserTool("synthi_browser_acquire_lease", {
      owner: "agent",
      lease_ms: 5000,
      reason: "unit-test",
    });
    expect(acquired?.isError).toBeUndefined();
    const leaseId = (acquired?.structuredContent as { lease: { lease_id: string } }).lease.lease_id;
    expect(leaseId).toMatch(/^browser_lease_/);

    const released = await dispatchBrowserTool("synthi_browser_release_lease", {
      lease_id: leaseId,
      reason: "complete",
    });
    expect(released?.structuredContent).toEqual({ ok: true, released: true });
  });

  it("denies snapshot before any authorized tab is selected", async () => {
    const response = await dispatchBrowserTool("synthi_browser_snapshot", {});
    expect(response?.isError).toBe(true);
    expect((response?.structuredContent as { error: string }).error).toBe("browser_tool_failed");
    expect((response?.structuredContent as { message: string }).message).toBe("tab_not_authorized");
  });

  it("requires a caller-provided or environment-provided CDP endpoint for browser attach", async () => {
    const response = await dispatchBrowserTool("synthi_browser_attach", {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual({
      error: "browser_cdp_url_required",
      env: "SYNTHI_BROWSER_CDP_URL",
      arg: "cdp_url",
    });
    expect(browserBridgeServer.isRunning()).toBe(false);
  });
});
