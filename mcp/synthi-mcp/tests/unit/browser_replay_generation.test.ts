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

  it("generates hover and native drag steps only from explicit taught actions", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "hover-menu",
        event_seq: 1,
        action: "hover",
        detail: {
          alt_option_intent: true,
          element: { role: "button", name: "More actions", source_id: "src_more" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"More actions\" })", confidence: 0.98, reason: "role" },
        ],
      }),
      event({
        event_id: "drag-task",
        event_seq: 2,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_mode: true,
          drag_class: "nativeHtmlDnd",
          element: { role: "listitem", name: "Task", source_id: "src_task" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listitem\", { name: \"Task\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await target1.hover();");
    expect(generated.code).toContain("const dropTarget2 = page.getByRole(\"list\", { name: \"Done\" });");
    expect(generated.code).toContain("await target2.dragTo(dropTarget2);");
    expect(generated.code).toContain("await expect(dropTarget2).toContainText(\"Task\");");
    expect(generated.warnings).not.toContain("workflow limitation: pointerDragUnreliable");
  });

  it("generates durable double-click and context-menu replay without duplicate click steps", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "open-record",
        event_seq: 1,
        action: "dblclick",
        detail: {
          dblclick_event: true,
          observed_effects: ["Record details opened"],
          element: { role: "button", name: "Open record", source_id: "src_record" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open record\" })", confidence: 0.98, reason: "role" },
        ],
      }),
      event({
        event_id: "click-one",
        event_seq: 2,
        action: "click",
        detail: {
          click_event: true,
          element: { role: "button", name: "Open record", source_id: "src_record" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open record\" })", confidence: 0.98, reason: "role" },
        ],
      }),
      event({
        event_id: "click-two",
        event_seq: 3,
        action: "click",
        detail: {
          click_event: true,
          element: { role: "button", name: "Open record", source_id: "src_record" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open record\" })", confidence: 0.98, reason: "role" },
        ],
      }),
      event({
        event_id: "row-menu",
        event_seq: 4,
        action: "contextmenu",
        detail: {
          observed_effects: ["Context actions visible"],
          element: { role: "row", name: "Open record", source_id: "src_record" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"row\", { name: \"Open record\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).not.toContain("await target1.click();");
    expect(generated.code).toContain("await target1.dblclick();");
    expect(generated.code).toContain("await target2.click({ button: 'right' });");
    expect(generated.code).toContain("await expect(page.getByText(\"Record details opened\", { exact: true })).toBeVisible();");
    expect(generated.code).toContain("await expect(page.getByText(\"Context actions visible\", { exact: true })).toBeVisible();");
  });

  it("generates keyboard shortcut replay from taught press chords", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "command-palette",
        event_seq: 1,
        action: "press",
        value: "Control+K",
        detail: {
          key_event: true,
          key_value: "k",
          modifier_keys: { control: true, meta: false, alt: false, shift: false },
          observed_effects: ["Command palette opened"],
          element: { role: "application", name: "Workspace shell", test_id: "workspace-shell", source_id: "src_shell" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"workspace-shell\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("await target1.press(\"Control+K\");");
    expect(generated.code).toContain("await expect(page.getByText(\"Command palette opened\", { exact: true })).toBeVisible();");
  });

  it("generates deterministic scroll position replay", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "scroll-region",
        event_seq: 1,
        action: "scroll",
        detail: {
          scroll_event: true,
          scroll_top: 240,
          scroll_left: 0,
          observed_effects: ["Scrolled to approvals"],
          element: { role: "region", name: "Scrollable approvals", test_id: "approval-scroll", source_id: "src_scroll" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"approval-scroll\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("element.scrollTo(position.left, position.top);");
    expect(generated.code).toContain("}, {\"top\":240,\"left\":0});");
    expect(generated.code).toContain("await expect(page.getByText(\"Scrolled to approvals\", { exact: true })).toBeVisible();");
  });

  it("asserts select values, drag effects, and captured live-region outcomes", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "select-segment",
        event_seq: 1,
        action: "select",
        value: "enterprise",
        detail: {
          element: { role: "combobox", label: "Segment" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Segment\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      event({
        event_id: "press-search",
        event_seq: 2,
        action: "press",
        value: "Enter",
        detail: {
          observed_effects: ["Searched revenue"],
          element: { role: "textbox", label: "Search" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Search\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      event({
        event_id: "drag-card",
        event_seq: 3,
        action: "drag",
        value: "page.getByTestId(\"lane-done\")",
        detail: {
          drag_mode: true,
          drag_class: "nativeHtmlDnd",
          observed_effects: ["Moved Revenue audit to Done lane"],
          element: { role: "listitem", name: "Revenue audit" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"card-revenue\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
      event({
        event_id: "apply-dashboard",
        event_seq: 4,
        action: "click",
        detail: {
          observed_effects: ["Applied enterprise urgent; card done; search revenue"],
          element: { role: "button", name: "Apply dashboard" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Apply dashboard\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await target1.selectOption(\"enterprise\");");
    expect(generated.code).toContain("await expect(target1).toHaveValue(\"enterprise\");");
    expect(generated.code).toContain("await expect(page.getByText(\"Searched revenue\", { exact: true })).toBeVisible();");
    expect(generated.code).toContain("await expect(dropTarget3).toContainText(\"Revenue audit\");");
    expect(generated.code).toContain("await expect(page.getByText(\"Moved Revenue audit to Done lane\", { exact: true })).toBeVisible();");
    expect(generated.code).toContain("await expect(page.getByText(\"Applied enterprise urgent; card done; search revenue\", { exact: true })).toBeVisible();");
  });

  it("generates parameterized file drop replay without inventing file contents", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "file-drop",
        event_seq: 1,
        action: "drag",
        detail: {
          drag_mode: true,
          drag_class: "fileDrop",
          file_parameter: "UPLOAD_FILE",
          mime_type: "text/plain",
          element: { role: "button", name: "Upload area", source_id: "src_upload" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Upload area\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).toContain("import fs from 'node:fs/promises';");
    expect(generated.code).toContain("const filePath1 = process.env[\"UPLOAD_FILE\"];");
    expect(generated.code).toContain("test.skip(!filePath1");
    expect(generated.code).toContain("await dropFile(page, target1, filePath1, \"text/plain\");");
    expect(generated.code).not.toContain("hello world");
    expect(generated.warnings).toContain("event file-drop file drop replay is parameterized by UPLOAD_FILE");
    expect(generated.warnings).not.toContain("workflow limitation: pointerDragUnreliable");
  });

  it("uses setInputFiles for file input drop traces", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "file-input",
        event_seq: 1,
        action: "drag",
        detail: {
          drag_mode: true,
          drag_class: "fileDrop",
          fixture_file: "tests/fixtures/upload.txt",
          element: { tag: "input", type: "file", label: "Upload file", source_id: "src_file" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Upload file\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const filePath1 = process.env[\"SYNTHI_FILE_DROP_1\"] ?? \"tests/fixtures/upload.txt\";");
    expect(generated.code).toContain("await target1.setInputFiles(filePath1);");
    expect(generated.code).not.toContain("await dropFile(page, target1");
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

  it("does not emit dragTo for pointer or sensor-based drags without calibrated replay", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "pointer-drag",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          element: { role: "listitem", name: "Task" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listitem\", { name: \"Task\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).toContain("test.skip(true, \"Replay blocked: pointer or sensor-based drag requires calibrated replay support.\");");
    expect(generated.code).not.toContain(".dragTo(");
    expect(generated.warnings).toContain("workflow limitation: pointerDragUnreliable");
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
