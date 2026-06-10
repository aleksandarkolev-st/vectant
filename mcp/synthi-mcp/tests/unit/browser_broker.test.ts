import { beforeEach, describe, expect, it } from "vitest";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { rankedLocatorCandidates } from "../../src/browser/locator.js";
import { redactStructuredValue, redactText, redactUrl, redactValue } from "../../src/browser/security.js";
import { eventLog } from "../../src/events/index.js";

beforeEach(() => {
  browserBroker.resetForTests();
  authCheckpointManager.resetForTests();
  eventLog._resetForTests();
});

describe("browser broker privacy boundary", () => {
  it("does not carry consent across subdomains, ports, schemes, or redirects", () => {
    browserBroker.requestConsent("https://app.example.com/dashboard");
    const authorized = browserBroker.registerTabs([
      { tab_id: "exact", url: "https://app.example.com/dashboard", active: true },
      { tab_id: "subdomain", url: "https://admin.app.example.com/dashboard", active: false },
      { tab_id: "port", url: "https://app.example.com:8443/dashboard", active: false },
      { tab_id: "scheme", url: "http://app.example.com/dashboard", active: false },
      { tab_id: "redirect", url: "https://evil.example.com/landing", active: false },
    ]);

    expect(authorized.map((tab) => tab.tab_id)).toEqual(["exact"]);
    expect(browserBroker.snapshot({
      tab_id: "subdomain",
      url: "https://admin.app.example.com/dashboard",
      screenshot_base64: "leak",
      dom: { text: "secret" },
    })).toEqual({ ok: false, error: "origin_consent_required" });
  });

  it("returns no screenshot, DOM, console, or network data for denied origins", () => {
    browserBroker.requestConsent("https://app.example.com", "denied");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);

    const response = browserBroker.snapshot({
      tab_id: "app",
      url: "https://app.example.com",
      screenshot_base64: "png",
      dom: { text: "dom" },
      console: [],
      network: [],
    });

    expect(response).toEqual({ ok: false, error: "origin_consent_required" });
  });

  it("requires explicit screenshot consent before accepting snapshot data", () => {
    browserBroker.requestConsent("https://app.example.com", "granted", "view-without-screenshot", {
      screenshot: false,
    });
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);

    expect(browserBroker.requireSnapshotAccess("https://app.example.com")).toEqual({
      ok: false,
      error: "screenshot_consent_required",
    });
    expect(browserBroker.snapshot({
      tab_id: "app",
      url: "https://app.example.com",
      screenshot_base64: "png",
      dom: { text: "dom" },
    })).toEqual({ ok: false, error: "screenshot_consent_required" });
  });

  it("requires explicit diagnostics consent before returning console or network data", () => {
    browserBroker.requestConsent("https://app.example.com", "granted", "view-without-diagnostics", {
      diagnostics: false,
    });

    expect(browserBroker.requireDiagnosticsAccess("https://app.example.com")).toEqual({
      ok: false,
      error: "diagnostics_consent_required",
    });
  });

  it("stops teach mode on unapproved origin change", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/a", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    browserBroker.handleOriginChange("app", "https://checkout.example.com/pay");

    expect(browserBroker.teachState().active).toBe(false);
    expect(eventLog.query({ kind: "browser" }).some((event) => event.action === "teach_stopped")).toBe(true);
  });

  it("rejects bad bridge tokens and unapproved page-origin requests", () => {
    browserBroker.setBridgeToken("bridge-secret");
    browserBroker.requestConsent("https://app.example.com");

    expect(browserBroker.validateBridgeMessage({
      bridge_token: "wrong",
      page_origin: "https://app.example.com",
    })).toEqual({ ok: false, error: "bad_bridge_token" });
    expect(browserBroker.validateBridgeMessage({
      bridge_token: "bridge-secret",
      page_origin: "https://admin.example.com",
    })).toEqual({ ok: false, error: "origin_consent_required" });
    expect(browserBroker.validateBridgeMessage({
      bridge_token: "bridge-secret",
      page_origin: "https://app.example.com",
    })).toEqual({ ok: true });
  });

  it("hides unauthorized CDP targets from tab enumeration", () => {
    browserBroker.requestConsent("https://app.example.com");
    const tabs = browserBroker.listAuthorizedTabs([
      { tab_id: "app", target_id: "target-1", url: "https://app.example.com", active: true },
      { tab_id: "mail", target_id: "target-2", url: "https://mail.example.com", active: false },
    ]);

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target_id).toBe("target-1");
  });

  it("keeps rejected teach-event diagnostics sanitized", () => {
    const issue = browserBroker.recordTeachRecordingIssue("frame_origin_consent_required", {
      tab_id: "app",
      url: "https://app.example.com/settings?token=secret",
      origin: "https://app.example.com",
      action: "click",
      detail: {
        frame_origin: "https://billing.example.com/form",
        selector: "#card-number",
        value: "4111111111111111",
      },
    }, "hosted-playwright-adapter");

    expect(issue).toEqual(expect.objectContaining({
      error: "frame_origin_consent_required",
      source: "hosted-playwright-adapter",
      origin: "https://app.example.com",
      frame_origin: "https://billing.example.com",
    }));
    const serialized = JSON.stringify(browserBroker.recordingIssueSnapshot());
    expect(serialized).not.toMatch(/4111111111111111|#card-number|selector|value|secret/);
  });

  it("redacts password fields, API keys, bearer tokens, and token URLs", () => {
    expect(redactValue("password", "correct-horse").value).toBe("[REDACTED]");
    expect(redactValue("accessToken", "short-lived-session-token").value).toBe("[REDACTED]");
    expect(redactText("Authorization: Bearer abcdefghijklmnop123456").text).toContain("[REDACTED]");
    expect(redactText("key=sk-12345678901234567890").text).toContain("[REDACTED]");
    expect(redactText("token=plain-secret-token").text).toBe("token=[REDACTED]");
    const redacted = redactUrl("https://app.example.com/callback?access_token=abc12345678901234567890&ok=1");
    expect(redacted.url).toContain("access_token=[REDACTED]");
    expect(redacted.redacted).toBe(true);
    expect(redactStructuredValue({
      headers: { Authorization: "Bearer abcdefghijklmnop123456" },
      localStorage: { sessionToken: "plain-session-token" },
      nested: [{ apiKey: "sk-12345678901234567890" }],
    })).toEqual({
      value: {
        headers: { Authorization: "[REDACTED]" },
        localStorage: "[REDACTED]",
        nested: [{ apiKey: "[REDACTED]" }],
      },
      redacted: true,
    });
    const cyclic: Record<string, unknown> = { label: "safe" };
    cyclic["self"] = cyclic;
    expect(redactStructuredValue(cyclic)).toEqual({
      value: { label: "safe", self: "[REDACTED]" },
      redacted: true,
    });
  });

  it("redacts nested secret details before returning recorded traces", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const recorded = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings?access_token=abc12345678901234567890",
      origin: "https://app.example.com",
      action: "fill",
      field_name: "API token",
      value: "plain-token-value",
      element: { role: "textbox", name: "API token" },
      detail: {
        headers: { Authorization: "Bearer abcdefghijklmnop123456" },
        storage: { refreshToken: "plain-refresh-token" },
      },
    });

    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error("unexpected record failure");
    const event = browserBroker.traceSnapshot()[0];
    expect(event?.url).toContain("access_token=[REDACTED]");
    expect(event?.value).toBe("[REDACTED]");
    expect(event?.redacted).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/plain-token-value|plain-refresh-token|abcdefghijklmnop123456/);
  });

  it("removes derived prompt effects when a queued dialog annotation redacts them", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const annotated = browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      actions: ["click"],
      detail: {
        dialog_event: true,
        dialog_type: "prompt",
        dialog_message: "Enter workspace name",
        dialog_prompt_value: "Taught Secret Workspace",
        dialog_accepted: true,
        observed_effects_redacted: true,
      },
      within_ms: 5000,
      observed_at: 1000,
    });

    expect(annotated).toEqual({ ok: true, event: null });

    const recorded = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Rename workspace" },
      detail: { observed_effects: ["Renamed workspace to Taught Secret Workspace"] },
      observed_at: 1100,
    });

    expect(recorded.ok).toBe(true);
    const event = browserBroker.traceSnapshot()[0];
    expect(event?.detail).toEqual(expect.objectContaining({
      dialog_event: true,
      dialog_prompt_value: "[REDACTED]",
      dialog_prompt_value_redacted: true,
      observed_effects_redacted: true,
    }));
    expect(event?.detail).not.toHaveProperty("observed_effects");
    expect(JSON.stringify(event)).not.toContain("Taught Secret Workspace");
  });

  it("requires separate consent for iframe and popup origins", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.recordSelection({
      tab_id: "app",
      frame_id: "iframe",
      url: "https://billing.example.com/frame",
      origin: "https://billing.example.com",
      element: { role: "button", name: "Pay" },
    })).toEqual({ ok: false, error: "teach_origin_mismatch" });

    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      frame_id: "iframe",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada",
      detail: {
        frame_locator: "iframe[data-testid=\"billing\"]",
        frame_origin: "https://billing.example.com",
      },
      element: { role: "textbox", label: "Cardholder" },
    })).toEqual({ ok: false, error: "frame_origin_consent_required" });

    expect(browserBroker.registerTabs([
      { tab_id: "popup", opener_tab_id: "app", url: "https://billing.example.com/popup", active: true },
    ])).toHaveLength(0);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_event: true,
        popup_url: "https://billing.example.com/popup",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
      element: { role: "button", name: "Open billing" },
    })).toEqual({ ok: false, error: "popup_origin_consent_required" });

    browserBroker.requestConsent("https://billing.example.com");
    expect(browserBroker.registerTabs([
      { tab_id: "popup", opener_tab_id: "app", url: "https://billing.example.com/popup", active: true },
    ])).toHaveLength(1);

    const frameAction = browserBroker.recordHumanAction({
      tab_id: "app",
      frame_id: "iframe",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada",
      detail: {
        frame_locator: "iframe[data-testid=\"billing\"]",
        frame_origin: "https://billing.example.com",
      },
      element: { role: "textbox", label: "Cardholder" },
    });
    expect(frameAction.ok).toBe(true);
    if (!frameAction.ok) throw new Error("unexpected frame action failure");
    expect(frameAction.event.detail).toEqual(expect.objectContaining({
      frame_origin: "https://billing.example.com",
      frame_origin_approved: true,
    }));
    expect(frameAction.event.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      frame_origin_approved: true,
    }));

    const popupAction = browserBroker.recordHumanAction({
      tab_id: "popup",
      url: "https://billing.example.com/popup",
      origin: "https://billing.example.com",
      action: "click",
      detail: {
        popup_context: true,
        popup_tab_id: "popup",
        opener_tab_id: "app",
        opener_origin: "https://app.example.com",
      },
      element: { role: "button", name: "Pay now" },
    });
    expect(popupAction.ok).toBe(true);
    if (!popupAction.ok) throw new Error("unexpected popup action failure");
    expect(popupAction.event.detail).toEqual(expect.objectContaining({
      popup_context: true,
      popup_tab_id: "popup",
      opener_tab_id: "app",
    }));
  });

  it("accepts descendant popup actions when the root opener is the taught tab", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/checkout", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const nestedPopupOpen = browserBroker.recordHumanAction({
      tab_id: "popup1",
      url: "https://app.example.com/checkout-popup",
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_context: true,
        popup_event: true,
        popup_url: "https://app.example.com/review",
        popup_tab_id: "popup2",
        opener_tab_id: "popup1",
        opener_origin: "https://app.example.com",
        root_opener_tab_id: "app",
        root_opener_origin: "https://app.example.com",
      },
      element: { role: "button", name: "Open review popup" },
    });
    expect(nestedPopupOpen.ok).toBe(true);

    const nestedPopupAction = browserBroker.recordHumanAction({
      tab_id: "popup2",
      url: "https://app.example.com/review",
      origin: "https://app.example.com",
      action: "fill",
      value: "APPROVED",
      detail: {
        popup_context: true,
        popup_tab_id: "popup2",
        opener_tab_id: "popup1",
        opener_origin: "https://app.example.com",
        root_opener_tab_id: "app",
        root_opener_origin: "https://app.example.com",
      },
      element: { role: "textbox", label: "Approval code" },
    });
    expect(nestedPopupAction.ok).toBe(true);

    expect(browserBroker.recordHumanAction({
      tab_id: "popup3",
      url: "https://app.example.com/review",
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_context: true,
        popup_tab_id: "popup3",
        opener_tab_id: "popup1",
        opener_origin: "https://app.example.com",
        root_opener_tab_id: "other-tab",
        root_opener_origin: "https://app.example.com",
      },
      element: { role: "button", name: "Preview checkout" },
    })).toEqual({ ok: false, error: "teach_tab_mismatch" });
  });

  it("records popup screenshot consent separately from popup origin consent", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.requestConsent("https://billing.example.com", "granted", "popup-origin-only", {
      screenshot: false,
    });
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/checkout", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const openerAction = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_event: true,
        popup_url: "https://billing.example.com/popup",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
      element: { role: "button", name: "Open billing" },
    });
    expect(openerAction.ok).toBe(true);
    if (!openerAction.ok) throw new Error("unexpected opener action failure");
    expect(openerAction.event.detail).toEqual(expect.objectContaining({
      popup_origin: "https://billing.example.com",
      popup_origin_approved: true,
      popup_screenshot_approved: false,
    }));
    expect(openerAction.event.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      screenshot_approved: true,
      popup_origin_approved: true,
      popup_screenshot_approved: false,
    }));

    expect(browserBroker.registerTabs([
      { tab_id: "popup", opener_tab_id: "app", url: "https://billing.example.com/popup", active: true },
    ])).toHaveLength(1);
    const popupAction = browserBroker.recordHumanAction({
      tab_id: "popup",
      url: "https://billing.example.com/popup",
      origin: "https://billing.example.com",
      action: "click",
      detail: {
        popup_context: true,
        popup_tab_id: "popup",
        opener_tab_id: "app",
        opener_origin: "https://app.example.com",
      },
      element: { role: "button", name: "Pay now" },
    });
    expect(popupAction.ok).toBe(true);
    if (!popupAction.ok) throw new Error("unexpected popup action failure");
    expect(popupAction.event.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      screenshot_approved: false,
    }));
  });

  it("discards provisional opener clicks when popup annotation reveals an unapproved origin", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const provisional = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {},
      element: { role: "button", name: "Open billing" },
    });
    expect(provisional.ok).toBe(true);
    expect(browserBroker.traceSnapshot()).toHaveLength(1);

    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      detail: {
        popup_event: true,
        popup_url: "https://billing.example.com/popup",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
    })).toEqual({ ok: false, error: "popup_origin_consent_required" });

    expect(browserBroker.traceSnapshot()).toHaveLength(0);
  });

  it("suppresses opener clicks when popup annotation arrives before the click event", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      detail: {
        popup_event: true,
        popup_url: "https://billing.example.com/popup",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
    })).toEqual({ ok: false, error: "popup_origin_consent_required" });

    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {},
      element: { role: "button", name: "Open billing" },
    })).toEqual({ ok: false, error: "popup_origin_consent_required" });
    expect(browserBroker.traceSnapshot()).toHaveLength(0);
  });

  it("applies delayed popup annotations to the opener action observed before later same-tab actions", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const opener = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {},
      element: { role: "button", name: "Open help" },
    });
    expect(opener.ok).toBe(true);
    if (!opener.ok) throw new Error("unexpected opener failure");

    const later = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {},
      element: { role: "button", name: "Show summary" },
    });
    expect(later.ok).toBe(true);

    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      observed_at: opener.event.ts,
      detail: {
        popup_event: true,
        popup_url: "https://app.example.com/help",
        popup_title: "Help",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
    })).toEqual({ ok: true, event: expect.objectContaining({ event_id: opener.event.event_id }) });

    const trace = browserBroker.traceSnapshot();
    expect(trace[0]?.detail).toEqual(expect.objectContaining({
      popup_event: true,
      popup_tab_id: "popup",
    }));
    expect(trace[1]?.detail).not.toEqual(expect.objectContaining({
      popup_event: true,
    }));
  });

  it("correlates popup annotations when browser popup time slightly precedes action capture time", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const popupObservedAt = 10_000;
    const opener = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      observed_at: popupObservedAt + 18,
      detail: {},
      element: { role: "button", name: "Open checkout" },
    });
    expect(opener.ok).toBe(true);
    if (!opener.ok) throw new Error("unexpected opener failure");

    const later = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      observed_at: popupObservedAt + 240,
      detail: {},
      element: { role: "button", name: "Show summary" },
    });
    expect(later.ok).toBe(true);

    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      observed_at: popupObservedAt,
      detail: {
        popup_event: true,
        popup_url: "https://app.example.com/checkout-popup",
        popup_tab_id: "popup",
        opener_tab_id: "app",
        root_opener_tab_id: "app",
      },
    })).toEqual({ ok: true, event: expect.objectContaining({ event_id: opener.event.event_id }) });

    const trace = browserBroker.traceSnapshot();
    expect(trace[0]?.detail).toEqual(expect.objectContaining({
      popup_event: true,
      popup_tab_id: "popup",
      root_opener_tab_id: "app",
    }));
    expect(trace[1]?.detail).not.toEqual(expect.objectContaining({
      popup_event: true,
    }));
  });

  it("keeps simultaneous queued popup annotations bound to their own opener clicks", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/reports",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      observed_at: 10_000,
      detail: {
        popup_event: true,
        popup_url: "https://app.example.com/audit-popup",
        popup_tab_id: "popup-a",
        opener_tab_id: "app",
      },
    })).toEqual({ ok: true, event: null });
    expect(browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/reports",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      observed_at: 10_240,
      detail: {
        popup_event: true,
        popup_url: "https://app.example.com/receipt-popup",
        popup_tab_id: "popup-b",
        opener_tab_id: "app",
      },
    })).toEqual({ ok: true, event: null });

    const firstOpener = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/reports",
      origin: "https://app.example.com",
      action: "click",
      observed_at: 10_018,
      detail: {},
      element: { role: "button", name: "Open audit" },
    });
    expect(firstOpener.ok).toBe(true);
    const secondOpener = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/reports",
      origin: "https://app.example.com",
      action: "click",
      observed_at: 10_258,
      detail: {},
      element: { role: "button", name: "Open receipt" },
    });
    expect(secondOpener.ok).toBe(true);

    const trace = browserBroker.traceSnapshot();
    expect(trace).toHaveLength(2);
    expect(trace[0]?.detail).toEqual(expect.objectContaining({
      popup_event: true,
      popup_tab_id: "popup-a",
      popup_url: "https://app.example.com/audit-popup",
    }));
    expect(trace[1]?.detail).toEqual(expect.objectContaining({
      popup_event: true,
      popup_tab_id: "popup-b",
      popup_url: "https://app.example.com/receipt-popup",
    }));
  });

  it("derives popup consent metadata from delayed popup URL annotations", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.requestConsent("https://billing.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const opener = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      action: "click",
      detail: {},
      element: { role: "button", name: "Open billing" },
    });
    expect(opener.ok).toBe(true);
    if (!opener.ok) throw new Error("unexpected opener failure");

    const annotated = browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      actions: ["click"],
      within_ms: 5000,
      observed_at: opener.event.ts,
      detail: {
        popup_event: true,
        popup_url: "https://billing.example.com/help?token=not-secret",
        popup_tab_id: "popup",
        opener_tab_id: "app",
      },
    });
    expect(annotated).toEqual({ ok: true, event: expect.objectContaining({ event_id: opener.event.event_id }) });

    const trace = browserBroker.traceSnapshot();
    expect(trace[0]?.detail).toEqual(expect.objectContaining({
      popup_origin: "https://billing.example.com",
      popup_origin_approved: true,
      popup_screenshot_approved: true,
    }));
    expect(trace[0]?.security).toEqual(expect.objectContaining({
      popup_origin_approved: true,
      popup_screenshot_approved: true,
    }));
  });

  it("surfaces denied popup origins as blocking recording issues", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    const issue = browserBroker.recordTeachRecordingIssue(
      "popup_origin_consent_required",
      {
        tab_id: "app",
        url: "https://app.example.com/checkout",
        origin: "https://app.example.com",
        detail: {
          popup_url: "https://billing.example.com/popup",
        },
      },
      "hosted-playwright-annotation"
    );

    expect(issue.blocking).toBe(true);
    expect(issue.popup_origin).toBe("https://billing.example.com");
  });

  it("lease revocation interrupts queued actions", () => {
    browserBroker.requestConsent("https://app.example.com");
    const lease = browserBroker.acquireLease("agent", 5000, "test");
    expect(browserBroker.queueAction({
      lease_id: lease.lease_id,
      action: "click",
      url: "https://app.example.com",
      selector: "page.getByRole('button', { name: 'Save' })",
    })).toEqual({ ok: true, queued: 1 });

    browserBroker.revokeLease("human_override");

    expect(browserBroker.validateAction({
      lease_id: lease.lease_id,
      action: "click",
      url: "https://app.example.com",
    })).toEqual({ ok: false, error: "browser_lease_required" });
  });

  it("logs and reports human actions during an agent lease", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.acquireLease("agent", 5000, "automation");

    const response = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Cancel" },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("unexpected record failure");
    expect(response.lease_conflict).toBe(true);
    expect(eventLog.query({ kind: "security" }).some((event) => event.code === "browser_human_action_during_agent_lease")).toBe(true);
  });

  it("rejects passive hover and records only explicit hover intent", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "hover",
      element: { role: "button", name: "Reveal menu" },
    })).toEqual({ ok: false, error: "explicit_hover_intent_required" });

    const response = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "hover",
      detail: { alt_option_intent: true },
      element: { role: "button", name: "Reveal menu" },
    });

    expect(response.ok).toBe(true);
    const [event] = browserBroker.traceSnapshot();
    expect(event).toEqual(expect.objectContaining({
      action: "hover",
      detail: expect.objectContaining({ alt_option_intent: true }),
    }));
  });

  it("requires explicit drag mode before recording drag steps", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "drag",
      value: "page.getByRole(\"listitem\", { name: \"Done\" })",
      element: { role: "listitem", name: "Task" },
    })).toEqual({ ok: false, error: "drag_mode_required" });

    const response = browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "drag",
      value: "page.getByRole(\"listitem\", { name: \"Done\" })",
      detail: { drag_mode: true, drag_class: "nativeHtmlDnd" },
      element: { role: "listitem", name: "Task" },
    });

    expect(response.ok).toBe(true);
    const [event] = browserBroker.traceSnapshot();
    expect(event).toEqual(expect.objectContaining({
      action: "drag",
      value: "page.getByRole(\"listitem\", { name: \"Done\" })",
      detail: expect.objectContaining({ drag_mode: true, drag_class: "nativeHtmlDnd" }),
    }));
  });

  it("records same-origin navigation and stops before denied-origin leaks", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/start", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    browserBroker.handleOriginChange("app", "https://app.example.com/reports?tab=open");
    browserBroker.handleOriginChange("app", "https://denied.example.com/private");

    const trace = browserBroker.traceSnapshot();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual(expect.objectContaining({
      kind: "navigation",
      action: "navigate",
      url: "https://app.example.com/reports?tab=open",
      origin: "https://app.example.com",
      detail: expect.objectContaining({ navigation_event: true }),
    }));
    expect(browserBroker.teachState()).toEqual({
      active: false,
      tab_id: null,
      origin: null,
      auth_checkpoint_active: false,
      auth_checkpoint_id: null,
    });
    expect(JSON.stringify(trace)).not.toContain("denied.example.com");
  });

  it("assigns broker-owned trace order, version, and security metadata", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/form", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    browserBroker.recordSelection({
      tab_id: "app",
      url: "https://app.example.com/form",
      origin: "https://app.example.com",
      element: { label: "Name" },
    });
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/form",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada",
      field_name: "name",
      element: { label: "Name" },
    });

    const trace = browserBroker.traceSnapshot();
    expect(trace).toHaveLength(2);
    expect(trace.map((event) => event.event_seq)).toEqual([1, 2]);
    expect(trace[0]?.trace_id).toEqual(trace[1]?.trace_id);
    expect(trace[0]?.trace_version).toEqual(trace[1]?.trace_version);
    expect(trace[0]?.security).toEqual({
      exact_origin_approved: true,
      screenshot_approved: true,
      diagnostics_approved: true,
      auth_checkpoint_approved: false,
    });
  });

  it("marks trace security when an auth checkpoint is selected for the teach session", () => {
    browserBroker.requestConsent("https://app.example.com");
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const finished = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      redirect_chain: ["https://idp.example.test/oauth"],
      ttl_ms: 60_000,
    });
    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error("unexpected auth checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: finished.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "secret-local" }] }],
      },
    }).ok).toBe(true);
    expect(browserBroker.activateAuthCheckpointForTeach({
      app_origin: finished.checkpoint.app_origin,
      idp_origins: finished.checkpoint.idp_origins,
      checkpoint_id: finished.checkpoint.checkpoint_id,
    }).ok).toBe(true);

    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/form", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/form",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Save" },
    });

    const [event] = browserBroker.traceSnapshot();
    expect(event?.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      auth_checkpoint_approved: true,
    }));
    expect(JSON.stringify(event)).not.toMatch(/cookie|localStorage|sessionStorage|secret|token/i);
  });

  it("keeps teach auth approval scoped to the selected checkpoint when same-origin checkpoints rotate", () => {
    browserBroker.requestConsent("https://app.example.com");
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const selected = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      ttl_ms: 60_000,
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("unexpected auth checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: selected.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "secret-local" }] }],
      },
    }).ok).toBe(true);
    expect(browserBroker.activateAuthCheckpointForTeach({
      app_origin: selected.checkpoint.app_origin,
      idp_origins: selected.checkpoint.idp_origins,
      checkpoint_id: selected.checkpoint.checkpoint_id,
    }).ok).toBe(true);

    const laterEnrollment = authCheckpointManager.beginEnrollment("https://app.example.com/other", "unit-test");
    const later = authCheckpointManager.finishEnrollment({
      enrollment_id: laterEnrollment.enrollment_id,
      app_url: "https://app.example.com/other",
      ttl_ms: 60_000,
    });
    expect(later.ok).toBe(true);

    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/form", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/form",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Save" },
    });

    const [event] = browserBroker.traceSnapshot();
    expect(event?.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      auth_checkpoint_approved: true,
    }));
  });

  it("keeps explicit auth checkpoint selection available for the next teach session", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "public", url: "https://app.example.com/public", active: true }]);
    expect(browserBroker.startTeachMode("public").ok).toBe(true);

    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const selected = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      ttl_ms: 60_000,
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("unexpected auth checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: selected.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "secret-local" }] }],
      },
    }).ok).toBe(true);
    expect(browserBroker.activateAuthCheckpointForTeach({
      app_origin: selected.checkpoint.app_origin,
      idp_origins: selected.checkpoint.idp_origins,
      checkpoint_id: selected.checkpoint.checkpoint_id,
    }).ok).toBe(true);
    expect(browserBroker.teachState()).toEqual(expect.objectContaining({
      active: true,
      auth_checkpoint_active: true,
      auth_checkpoint_id: selected.checkpoint.checkpoint_id,
    }));

    browserBroker.stopTeachMode("next-session-proof");
    browserBroker.registerTabs([{ tab_id: "secure", url: "https://app.example.com/form", active: true }]);
    expect(browserBroker.startTeachMode("secure").ok).toBe(true);
    expect(browserBroker.teachState()).toEqual(expect.objectContaining({
      active: true,
      auth_checkpoint_active: true,
      auth_checkpoint_id: selected.checkpoint.checkpoint_id,
    }));
    browserBroker.recordHumanAction({
      tab_id: "secure",
      url: "https://app.example.com/form",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Open secure panel" },
    });
    expect(browserBroker.traceSnapshot()[0]?.security).toEqual(expect.objectContaining({
      auth_checkpoint_approved: true,
    }));
  });

  it("keeps the active auth checkpoint when teach starts twice on the same tab", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "secure", url: "https://app.example.com/form", active: true }]);
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const selected = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      ttl_ms: 60_000,
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("unexpected auth checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: selected.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "secret-local" }] }],
      },
    }).ok).toBe(true);
    expect(browserBroker.activateAuthCheckpointForTeach({
      app_origin: selected.checkpoint.app_origin,
      idp_origins: selected.checkpoint.idp_origins,
      checkpoint_id: selected.checkpoint.checkpoint_id,
    }).ok).toBe(true);

    expect(browserBroker.startTeachMode("secure").ok).toBe(true);
    expect(browserBroker.startTeachMode("secure").ok).toBe(true);

    expect(browserBroker.teachState()).toEqual(expect.objectContaining({
      active: true,
      auth_checkpoint_active: true,
      auth_checkpoint_id: selected.checkpoint.checkpoint_id,
    }));
    expect(browserBroker.teachAuthCheckpointScopes().last_start).toEqual(expect.objectContaining({
      origin: "https://app.example.com",
      matched_checkpoint_id: selected.checkpoint.checkpoint_id,
    }));
  });

  it("does not infer auth approval from an unselected checkpoint on the same origin", () => {
    browserBroker.requestConsent("https://app.example.com");
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const finished = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      ttl_ms: 60_000,
    });
    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error("unexpected auth checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: finished.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "secret-local" }] }],
      },
    }).ok).toBe(true);

    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/public", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/public",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Open" },
    });

    const [event] = browserBroker.traceSnapshot();
    expect(event?.security).toEqual(expect.objectContaining({
      exact_origin_approved: true,
      auth_checkpoint_approved: false,
    }));
  });

  it("rejects bridge events that claim a different payload origin", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    expect(browserBroker.recordSelection({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://evil.example.com",
      element: { role: "button", name: "Save" },
    })).toEqual({ ok: false, error: "selection_origin_mismatch" });
  });
});

describe("browser locator and script policy", () => {
  it("ranks locators by semantic stability and leaves XPath as last resort", () => {
    const candidates = rankedLocatorCandidates({
      role: "button",
      name: "Save",
      label: "Save item",
      placeholder: "Name",
      test_id: "save-button",
      text: "Save",
      css: "[data-testid='save-button']",
      xpath: "/html/body/button[1]",
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "test_id",
      "role",
      "label",
      "placeholder",
      "text",
      "css",
      "xpath",
    ]);
    expect(candidates[0]?.confidence).toBeGreaterThan(candidates[candidates.length - 1]!.confidence);
  });

  it("prefers host-scoped open shadow selectors over duplicated internals", () => {
    const candidates = rankedLocatorCandidates({
      role: "textbox",
      name: "Display name",
      label: "Display name",
      test_id: "display-name",
      css: "[data-testid=\"billing-profile\"] [data-testid=\"display-name\"]",
      shadow_dom: "open",
      shadow_css: "[data-testid=\"billing-profile\"] [data-testid=\"display-name\"]",
      shadow_host_test_id: "billing-profile",
      shadow_inner_css: "[data-testid=\"display-name\"]",
    });

    expect(candidates[0]).toEqual(expect.objectContaining({
      kind: "css",
      locator: "page.locator(\"[data-testid=\\\"billing-profile\\\"] [data-testid=\\\"display-name\\\"]\")",
      reason: "open_shadow_scoped_css",
    }));
  });

  it("generates replay code with waits, assertions, confidence, and fallback locators", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada",
      field_name: "name",
      element: {
        label: "Name",
        placeholder: "Full name",
        css: "#name",
        xpath: "//*[@id='name']",
      },
    });

    const generated = browserBroker.generatedScript();
    expect(generated.code).toContain("const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? \"https://app.example.com\";");
    expect(generated.code).toContain("const target1 = await firstVisible(page.getByLabel(\"Name\")");
    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"NAME\", \"browser_evt_1\");");
    expect(generated.code).toContain("await target1.fill(inputValue1);");
    expect(generated.code).toContain("await expect(target1).toHaveValue(inputValue1);");
    expect(generated.used_locators[0]?.confidence).toBeGreaterThan(0.9);
    expect(generated.used_locators[0]?.fallbacks.map((candidate) => candidate.kind)).toContain("placeholder");
  });
});
