import { describe, expect, it } from "vitest";
import {
  normalizeCapturedHumanAction,
  normalizeCapturedHumanActionAnnotation,
  resolveCdpConnectTimeoutMs,
} from "../../src/browser/playwright_adapter.js";

describe("browser Playwright adapter config", () => {
  it("uses an environment-configurable CDP connection timeout", () => {
    expect(resolveCdpConnectTimeoutMs({})).toBe(60_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "999999" })).toBe(300_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "bad" })).toBe(60_000);
  });
});

describe("browser Playwright teach capture", () => {
  it("normalizes hosted-browser DOM actions into broker teach events", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "fill",
      value: "hello",
      field_name: "Test token",
      element: {
        tag: "input",
        role: "textbox",
        placeholder: "paste a harmless token",
        css: "input",
      },
      bbox: { x: 1, y: 2, w: 120, h: 32 },
      detail: { input_debounced: true },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      tab_id: "tab-a",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "fill",
      value: "hello",
      field_name: "Test token",
      element: expect.objectContaining({ role: "textbox", css: "input" }),
      bbox: { x: 1, y: 2, w: 120, h: 32 },
      detail: expect.objectContaining({
        capture_source: "hosted_browser_dom",
        input_debounced: true,
      }),
    }));
  });

  it("rejects malformed hosted-browser DOM action payloads", () => {
    expect(normalizeCapturedHumanAction({ action: "click" }, "tab-a")).toBeNull();
    expect(normalizeCapturedHumanAction({
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "not-real",
    }, "tab-a")).toBeNull();
  });

  it("normalizes and redacts hosted-browser action annotations", () => {
    const event = normalizeCapturedHumanActionAnnotation({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      actions: ["click", "not-real"],
      within_ms: 5000,
      detail: {
        dialog_event: true,
        dialog_type: "confirm",
        dialog_message: "Approve policy?",
        dialog_prompt_value: "secret typed prompt",
        dialog_accepted: true,
        observed_effects: ["Confirmed policy"],
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      tab_id: "tab-a",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      detail: expect.objectContaining({
        dialog_event: true,
        dialog_type: "confirm",
        dialog_message: "Approve policy?",
        dialog_prompt_value: "[REDACTED]",
        dialog_prompt_value_redacted: true,
        dialog_accepted: true,
        observed_effects: ["Confirmed policy"],
      }),
    }));
  });
});
