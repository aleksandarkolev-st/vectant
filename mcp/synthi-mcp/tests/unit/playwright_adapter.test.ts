import { describe, expect, it } from "vitest";
import { resolveCdpConnectTimeoutMs } from "../../src/browser/playwright_adapter.js";

describe("browser Playwright adapter config", () => {
  it("uses an environment-configurable CDP connection timeout", () => {
    expect(resolveCdpConnectTimeoutMs({})).toBe(60_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "999999" })).toBe(300_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "bad" })).toBe(60_000);
  });
});
