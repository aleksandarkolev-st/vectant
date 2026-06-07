import { beforeEach, describe, expect, it } from "vitest";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { rankedLocatorCandidates } from "../../src/browser/locator.js";
import { redactText, redactUrl, redactValue } from "../../src/browser/security.js";
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

  it("redacts password fields, API keys, bearer tokens, and token URLs", () => {
    expect(redactValue("password", "correct-horse").value).toBe("[REDACTED]");
    expect(redactText("Authorization: Bearer abcdefghijklmnop123456").text).toContain("[REDACTED]");
    expect(redactText("key=sk-12345678901234567890").text).toContain("[REDACTED]");
    expect(redactText("token=plain-secret-token").text).toBe("token=[REDACTED]");
    const redacted = redactUrl("https://app.example.com/callback?access_token=abc12345678901234567890&ok=1");
    expect(redacted.url).toContain("access_token=[REDACTED]");
    expect(redacted.redacted).toBe(true);
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

    expect(browserBroker.registerTabs([
      { tab_id: "popup", opener_tab_id: "app", url: "https://billing.example.com/popup", active: true },
    ])).toHaveLength(0);
    browserBroker.requestConsent("https://billing.example.com");
    expect(browserBroker.registerTabs([
      { tab_id: "popup", opener_tab_id: "app", url: "https://billing.example.com/popup", active: true },
    ])).toHaveLength(1);
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

  it("marks trace security when an explicit auth checkpoint is valid", () => {
    browserBroker.requestConsent("https://app.example.com");
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/form", "unit-test");
    const finished = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/form",
      redirect_chain: ["https://idp.example.test/oauth"],
      ttl_ms: 60_000,
    });
    expect(finished.ok).toBe(true);

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
    expect(generated.code).toContain("await target1.fill(\"Ada\");");
    expect(generated.code).toContain("await expect(target1).toHaveValue(\"Ada\");");
    expect(generated.used_locators[0]?.confidence).toBeGreaterThan(0.9);
    expect(generated.used_locators[0]?.fallbacks.map((candidate) => candidate.kind)).toContain("placeholder");
  });
});
