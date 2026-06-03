import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { browserBridgeServer } from "../../src/browser/bridge_server.js";
import { eventLog } from "../../src/events/index.js";

beforeEach(() => {
  browserBroker.resetForTests();
  eventLog._resetForTests();
});

afterEach(async () => {
  await browserBridgeServer.stop();
});

describe("browser extension bridge", () => {
  it("rejects page-origin requests before accepting event data", async () => {
    const bridge = await browserBridgeServer.start({ token: "secret", port: 0 });
    browserBroker.requestConsent("https://app.example.com");

    const response = await postBridge(bridge.url, {
      bridge_token: "secret",
      page_origin: "https://app.example.com",
      type: "selection",
      payload: {},
    }, { Origin: "https://app.example.com" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "page_origin_request_rejected" });
  });

  it("rejects bad tokens and unapproved origins", async () => {
    const bridge = await browserBridgeServer.start({ token: "secret", port: 0 });
    browserBroker.requestConsent("https://app.example.com");

    const badToken = await postBridge(bridge.url, {
      bridge_token: "wrong",
      page_origin: "https://app.example.com",
      type: "selection",
      payload: {},
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toEqual({ ok: false, error: "bad_bridge_token" });

    const badOrigin = await postBridge(bridge.url, {
      bridge_token: "secret",
      page_origin: "https://admin.example.com",
      type: "selection",
      payload: {},
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ ok: false, error: "origin_consent_required" });
  });

  it("accepts extension-origin selection events during teach mode", async () => {
    const bridge = await browserBridgeServer.start({ token: "secret", port: 0 });
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const response = await postBridge(bridge.url, {
      bridge_token: "secret",
      page_origin: "https://app.example.com",
      type: "selection",
      payload: {
        tab_id: "app",
        url: "https://app.example.com",
        origin: "https://app.example.com",
        element: { role: "button", name: "Save" },
      },
    }, { Origin: "chrome-extension://unit-test" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(browserBroker.traceSnapshot()).toHaveLength(1);
  });

  it("returns a caller-provided public bridge URL without assuming the bind address is extension-reachable", async () => {
    const bridge = await browserBridgeServer.start({
      token: "secret",
      port: 0,
      publicUrl: "http://browser-host.example:49152/",
    });

    expect(bridge).toEqual({
      url: "http://browser-host.example:49152",
      token: "secret",
    });
    expect(browserBridgeServer.current()).toEqual(bridge);
  });
});

function postBridge(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
