import { describe, expect, it } from "vitest";
import { generatePlaywrightScript } from "../../src/browser/trace.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

describe("browser replay generation scenarios", () => {
  it("generates environment URL placeholders for dynamic React/Vue/Svelte-style routes", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "nav",
        kind: "navigation",
        url: "http://localhost:5173/dashboard?framework=react",
      }),
      event({
        event_id: "click",
        kind: "human_action",
        action: "click",
        url: "http://localhost:5173/dashboard?framework=vue",
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Create\" })", confidence: 0.98, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? \"http://localhost:5173\";");
    expect(generated.code).toContain("await page.goto(`${baseUrl}/dashboard?framework=react`);");
    expect(generated.code).toContain("await expect(target1).toBeVisible();");
  });

  it("keeps stable CSS fallbacks for shadow DOM-capable Playwright locators", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "click",
        locator_candidates: [
          { kind: "css", locator: "page.locator(\"profile-card button[data-testid=\\\"save\\\"]\")", confidence: 0.58, reason: "stable_css_selector" },
          { kind: "xpath", locator: "page.locator(\"xpath=/profile-card/button\")", confidence: 0.35, reason: "xpath_last_resort" },
        ],
      }),
    ]);

    expect(generated.code).toContain("profile-card button[data-testid=\\\"save\\\"]");
    expect(generated.used_locators[0]?.fallbacks[0]?.kind).toBe("xpath");
  });

  it("rewrites locator expressions through frameLocator for iframe traces", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "fill",
        frame_id: "checkout-frame",
        detail: { frame_locator: "iframe[name=\"checkout\"]" },
        value: "Ada",
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Cardholder\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.frameLocator(\"iframe[name=\\\"checkout\\\"]\").getByLabel(\"Cardholder\")");
    expect(generated.code).toContain("await target1.fill(\"Ada\");");
  });

  it("uses assertions as delayed-hydration waits before actions", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "click",
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Hydrated action\" })", confidence: 0.98, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await expect(target1).toBeVisible();");
    expect(generated.code.indexOf("await expect(target1).toBeVisible();")).toBeLessThan(generated.code.indexOf("await target1.click();"));
  });

  it("prefers unique fallback candidates when duplicate button labels exist", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "click",
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save\" })", confidence: 0.98, reason: "accessible_role_and_name" },
          { kind: "test_id", locator: "page.getByTestId(\"settings-save\")", confidence: 0.86, reason: "test_id" },
        ],
      }),
    ]);

    expect(generated.code).toContain("if (count === 1) return locator;");
    expect(generated.code).toContain("if (count > 1 && !fallback) fallback = locator.first();");
    expect(generated.code).toContain("page.getByTestId(\"settings-save\")");
  });

  it("emits fallback candidates for flaky locator recovery", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "click",
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Continue\" })", confidence: 0.98, reason: "accessible_role_and_name" },
          { kind: "text", locator: "page.getByText(\"Continue\")", confidence: 0.72, reason: "stable_visible_text" },
          { kind: "css", locator: "page.locator(\"[data-testid=continue]\")", confidence: 0.58, reason: "stable_css_selector" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await firstVisible(page.getByRole(\"button\", { name: \"Continue\" }), page.getByText(\"Continue\"), page.locator(\"[data-testid=continue]\")");
    expect(generated.used_locators[0]?.fallbacks.map((candidate) => candidate.kind)).toEqual(["text", "css"]);
  });

  it("emits workflow metadata and stops before mutation in prefix-only mode", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "fill",
        event_seq: 1,
        action: "fill",
        value: "Ada",
        detail: {
          field_name: "Name",
          element: { label: "Name" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Name\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      event({
        event_id: "save",
        event_seq: 2,
        action: "click",
        detail: {
          element: { role: "button", name: "Save changes" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save changes\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ], { mode: "prefixOnly" });

    expect(generated.mode).toBe("prefixOnly");
    expect(generated.code).toContain("// Workflow: Save changes");
    expect(generated.code).toContain("// Mutation boundary: save");
    expect(generated.code).toContain("await expect(target2).toBeEnabled();");
    expect(generated.code).not.toContain("await target2.click();");
    expect(generated.warnings).toContain("prefixOnly stopped before mutation boundary save");
  });

  it("treats cold-session script generation as prefix-safe around mutation", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "save",
        event_seq: 1,
        action: "click",
        detail: {
          element: { role: "button", name: "Save changes" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save changes\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ], { mode: "coldSession" });

    expect(generated.mode).toBe("coldSession");
    expect(generated.code).toContain("Mutation boundary: save");
    expect(generated.code).not.toContain("await target1.click();");
    expect(generated.warnings).toContain("coldSession stopped before mutation boundary save");
  });

  it("marks generated Playwright as skipped when replay is blocked by surface support", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "iframe",
        frame_id: "payment-frame",
        action: "fill",
        detail: {
          element: { role: "textbox", label: "Cardholder" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Cardholder\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("test.skip(true, \"Replay blocked: iframe step has no durable frame locator.\");");
    expect(generated.code).not.toContain("await target1.fill");
    expect(generated.warnings).toContain("workflow limitation: iframeNeedsFrameLocator");
    expect(generated.warnings).toContain("workflow replay blocked by unsupported browser surface");
  });
});

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "http://localhost:5173",
    url: "http://localhost:5173/path",
    kind: "human_action",
    ...overrides,
  };
}
