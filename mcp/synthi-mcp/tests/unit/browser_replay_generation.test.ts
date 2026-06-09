import { describe, expect, it } from "vitest";
import { BrowserTraceRecorder, generatePlaywrightScript } from "../../src/browser/trace.js";
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
    expect(generated.code).toContain("const workflowStorageState = process.env.SYNTHI_WORKFLOW_STORAGE_STATE || process.env.PLAYWRIGHT_STORAGE_STATE;");
    expect(generated.code).toContain("if (workflowStorageState) test.use({ storageState: workflowStorageState });");
    expect(generated.code).toContain("await page.goto(workflowUrl(\"/dashboard?framework=react\"));");
    expect(generated.code).toContain("await expect(target1).toBeVisible();");
  });

  it("strips dynamic workspace preview proxy ports from generated URLs", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "nav",
        kind: "navigation",
        url: "http://localhost:1234/port/37797/dashboard?framework=react",
      }),
      event({
        event_id: "click",
        kind: "human_action",
        action: "click",
        url: "http://localhost:1234/port/37797/dashboard?framework=react",
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Create\" })", confidence: 0.98, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const baseUrl = process.env.PLAYWRIGHT_BASE_URL;");
    expect(generated.code).toContain("Set PLAYWRIGHT_BASE_URL to the app or forwarded preview URL for this workflow.");
    expect(generated.code).toContain("await page.goto(workflowUrl(\"/dashboard?framework=react\"));");
    expect(generated.code).not.toContain("/port/37797");
  });

  it("emits full mutation replay for CI-isolated scripts behind an explicit mutation guard", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "email",
        event_seq: 1,
        action: "fill",
        value: "ada@example.test",
        detail: { field_name: "email", element: { tag: "input", label: "Email", source_id: "settings.email" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Email\")", confidence: 0.96, reason: "form_label" },
        ],
      }),
      event({
        event_id: "save",
        event_seq: 2,
        action: "click",
        detail: { element: { tag: "button", role: "button", name: "Save settings", source_id: "settings.save" } },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save settings\" })", confidence: 0.98, reason: "accessible_role_and_name" },
        ],
      }),
    ], { mode: "ciIsolated" });

    expect(generated.mode).toBe("ciIsolated");
    expect(generated.code).toContain("ALLOW_WORKFLOW_MUTATION");
    expect(generated.code).toContain("SYNTHI_WORKFLOW_REPLAY_ATTESTATION");
    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"EMAIL\", \"email\");");
    expect(generated.code).toContain("await target2.click();");
    expect(generated.code).toContain("await recordWorkflowStep(\"save\");");
    expect(generated.code).not.toContain("Mutation boundary:");
    expect(generated.warnings).toContain("ciIsolated requires ALLOW_WORKFLOW_MUTATION=1 before mutation boundary save");
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

  it("prefers source identity locators and asserts custom ARIA state", () => {
    const trace = new BrowserTraceRecorder();
    const recorded = trace.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/widgets",
      origin: "https://app.example.com",
      action: "click",
      element: {
        tag: "div",
        text: "Refresh",
        source_id: "widgets.refresh",
      },
      detail: {
        click_event: true,
        aria_pressed: "true",
        observed_effects: ["Panel refreshed"],
      },
    });

    const generated = generatePlaywrightScript(trace.snapshot());

    expect(recorded.locator_candidates?.[0]?.reason).toBe("source_identity");
    expect(generated.code).toContain("page.locator(\"[data-synthi-source-id=\\\"widgets.refresh\\\"]\")");
    expect(generated.code).toContain("await expect(target1).toHaveAttribute(\"aria-pressed\", \"true\");");
    expect(generated.code).toContain("page.getByText(\"Panel refreshed\", { exact: true })");
  });

  it("rewrites locator expressions through frameLocator for iframe traces", () => {
    const generated = generatePlaywrightScript([
      event({
        action: "fill",
        frame_id: "checkout-frame",
        detail: { frame_locator: "iframe[name=\"checkout\"]", observed_effects: ["Saved Ada"], element: { label: "Cardholder" } },
        value: "Ada",
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Cardholder\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.frameLocator(\"iframe[name=\\\"checkout\\\"]\").getByLabel(\"Cardholder\")");
    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"CARDHOLDER\", \"evt\");");
    expect(generated.code).toContain("await target1.fill(inputValue1);");
    expect(generated.code).toContain("page.frameLocator(\"iframe[name=\\\"checkout\\\"]\").getByText(parameterizedTextRegex([\"Saved \",\"\"], inputValue1))");
    expect(generated.code).not.toContain("Saved Ada");
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

  it("replays taught click modifiers for range-selection workflows", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "range-select",
        event_seq: 1,
        action: "click",
        detail: {
          click_event: true,
          modifier_keys: { shift: true, control: false, meta: false, alt: false },
          modifiers: ["Shift"],
          observed_effects: ["Selected 3 invoices"],
          element: { role: "option", name: "Invoice C", source_id: "invoice.c" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"Invoice C\" })", confidence: 0.96, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await target1.click({ modifiers: [\"Shift\"] });");
    expect(generated.code).toContain("await expect(page.getByText(\"Selected 3 invoices\", { exact: true })).toBeVisible();");
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
    expect(generated.code).toContain("await target2.click({ button: \"right\" });");
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

  it("generates wheel replay with pointer position and modifiers", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "zoom-surface",
        event_seq: 1,
        action: "scroll",
        detail: {
          wheel_event: true,
          wheel_replay: "mouseWheel",
          wheel_delta_x: 0,
          wheel_delta_y: -240,
          wheel_client_x_ratio: 0.5,
          wheel_client_y_ratio: 0.5,
          modifier_keys: { control: true },
          modifiers: ["Control"],
          observed_effects: ["Zoom 1.25 pan 0"],
          element: { role: "application", name: "Revenue zoom surface", test_id: "zoom-surface", source_id: "src_zoom" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"zoom-surface\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("const wheelBox1 = await target1.boundingBox();");
    expect(generated.code).toContain("await page.mouse.move(wheelBox1.x + wheelBox1.width * 0.5, wheelBox1.y + wheelBox1.height * 0.5);");
    expect(generated.code).toContain("for (const modifier of [\"Control\"]) await page.keyboard.down(modifier);");
    expect(generated.code).toContain("await page.mouse.wheel(0, -240);");
    expect(generated.code).toContain("await expect(page.getByText(\"Zoom 1.25 pan 0\", { exact: true })).toBeVisible();");
    expect(generated.code).not.toContain("element.scrollTo(position.left, position.top);");
  });

  it("wraps download-triggering clicks with a Playwright download wait", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "download-report",
        event_seq: 1,
        action: "click",
        detail: {
          download_event: true,
          suggested_filename: "report.csv",
          suggested_filename_redacted: false,
          element: { role: "link", name: "Download report", test_id: "download-report", source_id: "src_download" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"download-report\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("page.waitForEvent('download')");
    expect(generated.code).toContain("target1.click()");
    expect(generated.code).toContain("expect(download1.suggestedFilename()).toBe(\"report.csv\");");
  });

  it("wraps dialog-triggering clicks with a Playwright dialog handler", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "confirm-approve",
        event_seq: 1,
        action: "click",
        detail: {
          dialog_event: true,
          dialog_type: "confirm",
          dialog_message: "Approve policy?",
          dialog_accepted: true,
          observed_effects: ["Confirmed policy"],
          element: { role: "button", name: "Confirm policy", test_id: "confirm-policy", source_id: "src_confirm" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"confirm-policy\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("page.once('dialog'");
    expect(generated.code).toContain("expect(dialog.type()).toBe(\"confirm\")");
    expect(generated.code).toContain("expect(dialog.message()).toContain(\"Approve policy?\")");
    expect(generated.code).toContain("await dialog.accept();");
    expect(generated.code).toContain("await target1.click();");
    expect(generated.code).toContain("await dialog1Promise;");
    expect(generated.code).toContain("await expect(page.getByText(\"Confirmed policy\", { exact: true })).toBeVisible();");
  });

  it("parameterizes prompt dialog values without leaking taught responses", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "prompt-rename",
        event_seq: 1,
        action: "click",
        detail: {
          dialog_event: true,
          dialog_type: "prompt",
          dialog_message: "Enter workspace name",
          dialog_prompt_value: "[REDACTED]",
          dialog_prompt_value_redacted: true,
          dialog_accepted: true,
          observed_effects: ["Renamed workspace to [REDACTED]"],
          observed_effects_redacted: true,
          element: { role: "button", name: "Rename workspace", test_id: "rename-workspace", source_id: "src_rename" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"rename-workspace\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("const dialogPrompt1 = process.env[\"ENTER_WORKSPACE_NAME\"];");
    expect(generated.code).toContain("test.skip(dialogPrompt1 === undefined");
    expect(generated.code).toContain("await dialog.accept(dialogPrompt1);");
    expect(generated.code).not.toContain("Secret Launch Board");
    expect(generated.code).not.toContain("Renamed workspace to [REDACTED]");
    expect(generated.warnings).toContain("event prompt-rename prompt dialog replay is parameterized by ENTER_WORKSPACE_NAME");
  });

  it("wraps popup-triggering clicks with a Playwright popup handler", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "open-docs",
        event_seq: 1,
        action: "click",
        url: "https://app.example.com/settings",
        origin: "https://app.example.com",
        detail: {
          popup_event: true,
          popup_url: "https://app.example.com/help",
          popup_title: "Workflow Help",
          observed_effects: ["Help opened"],
          element: { role: "button", name: "Open help", test_id: "open-help", source_id: "src_help" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"open-help\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("page.waitForEvent('popup')");
    expect(generated.code).toContain("target1.click(),");
    expect(generated.code).toContain("await popup1.waitForLoadState('domcontentloaded').catch(() => undefined);");
    expect(generated.code).toContain("await expect(popup1).toHaveURL(workflowUrl(\"/help\"));");
    expect(generated.code).toContain("await expect(popup1).toHaveTitle(\"Workflow Help\");");
    expect(generated.code).toContain("await expect(page.getByText(\"Help opened\", { exact: true })).toBeVisible();");
  });

  it("replays same-origin popup continuation actions on the captured popup page", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "open-help",
        event_seq: 1,
        tab_id: "main",
        action: "click",
        url: "https://app.example.com/settings",
        origin: "https://app.example.com",
        detail: {
          popup_event: true,
          popup_url: "https://app.example.com/help",
          popup_title: "Workflow Help",
          popup_tab_id: "popup",
          opener_tab_id: "main",
          element: { role: "button", name: "Open help", test_id: "open-help", source_id: "src_help" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"open-help\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
      event({
        event_id: "search-help",
        event_seq: 2,
        tab_id: "popup",
        action: "fill",
        value: "contracts",
        url: "https://app.example.com/help",
        origin: "https://app.example.com",
        detail: {
          popup_context: true,
          popup_tab_id: "popup",
          opener_tab_id: "main",
          opener_origin: "https://app.example.com",
          observed_effects: ["Filtered help for contracts"],
          element: { role: "textbox", label: "Search help", source_id: "src_help_search" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Search help\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("const [popup1] = await Promise.all([");
    expect(generated.code).toContain("page.waitForEvent('popup')");
    expect(generated.code).toContain("const target2 = await firstVisible(popup1.getByLabel(\"Search help\"));");
    expect(generated.code).toContain("const inputValue2 = readRequiredEnv(\"SEARCH_HELP\", \"search-help\");");
    expect(generated.code).toContain("await target2.fill(inputValue2);");
    expect(generated.code).toContain("await expect(popup1.getByText(parameterizedTextRegex([\"Filtered help for \",\"\"], inputValue2))).toBeVisible();");
    expect(generated.code).not.toContain("Filtered help for contracts");
    expect(generated.warnings).not.toContain("workflow limitation: popupOrMultiTab");
  });

  it("replays consented cross-origin popup continuation actions on the captured popup page", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "open-help",
        event_seq: 1,
        tab_id: "main",
        url: "https://app.example.com",
        origin: "https://app.example.com",
        action: "click",
        detail: {
          popup_event: true,
          popup_url: "https://billing.example.com/help",
          popup_origin_approved: true,
          popup_title: "Billing Help",
          popup_tab_id: "popup",
          opener_tab_id: "main",
          element: { role: "button", name: "Open help", test_id: "open-help", source_id: "src_help" },
        },
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: true,
          auth_checkpoint_approved: false,
          popup_origin_approved: true,
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"open-help\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
      event({
        event_id: "search-help",
        event_seq: 2,
        tab_id: "popup",
        action: "fill",
        value: "contracts",
        url: "https://billing.example.com/help",
        origin: "https://billing.example.com",
        detail: {
          popup_context: true,
          popup_tab_id: "popup",
          opener_tab_id: "main",
          opener_origin: "https://app.example.com",
          element: { role: "textbox", label: "Search help", source_id: "src_help_search" },
        },
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: true,
          auth_checkpoint_approved: false,
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Search help\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("page.waitForEvent('popup')");
    expect(generated.code).toContain("await expect(popup1).toHaveURL(\"https://billing.example.com/help\");");
    expect(generated.code).toContain("const target2 = await firstVisible(popup1.getByLabel(\"Search help\"));");
    expect(generated.warnings).toContain("workflow limitation: crossOriginTrace");
    expect(generated.warnings).not.toContain("workflow limitation: popupOrMultiTab");
  });

  it("asserts contenteditable fill replay with text content", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "rich-notes",
        event_seq: 1,
        action: "fill",
        value: "Release notes ready",
        detail: {
          element: {
            role: "textbox",
            name: "Release notes",
            test_id: "release-notes",
            source_id: "src_notes",
            content_editable: true,
          },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"release-notes\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ], { mode: "sameSession" });

    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"RELEASE_NOTES\", \"rich-notes\");");
    expect(generated.code).toContain("await target1.fill(inputValue1);");
    expect(generated.code).toContain("await expect(target1).toContainText(inputValue1);");
    expect(generated.code).not.toContain("toHaveValue(\"Release notes ready\")");
    expect(generated.code).not.toContain("Release notes ready");
  });

  it("keeps textarea-backed code editor replay on durable fill", () => {
    const code = "const answer = 42;\nconsole.log(answer);";
    const generated = generatePlaywrightScript([
      event({
        event_id: "code-textarea",
        event_seq: 1,
        action: "fill",
        value: code,
        detail: {
          editor_surface: "textarea",
          editor_backing: "textarea",
          editor_language: "javascript",
          editor_replay_strategy: "fill",
          editor_line_count: 2,
          element: {
            tag: "textarea",
            role: "textbox",
            label: "Automation script",
            test_id: "automation-script",
            source_id: "editor.script",
            editor_surface: "textarea",
            editor_replay_strategy: "fill",
          },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"automation-script\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"AUTOMATION_SCRIPT\", \"code-textarea\");");
    expect(generated.code).toContain("await target1.fill(inputValue1);");
    expect(generated.code).toContain("await expect(target1).toHaveValue(inputValue1);");
    expect(generated.code).not.toContain(code);
    expect(generated.warnings).not.toContain("event code-textarea uses keyboard insertion for a custom code-editor surface");
  });

  it("uses keyboard insertion for custom code editor surfaces", () => {
    const code = "function run() { return 42; }";
    const generated = generatePlaywrightScript([
      event({
        event_id: "custom-editor",
        event_seq: 1,
        action: "fill",
        value: code,
        detail: {
          editor_surface: "codemirror",
          editor_backing: "hiddenTextarea",
          editor_replay_strategy: "keyboardInsert",
          element: {
            role: "textbox",
            name: "Query editor",
            test_id: "query-editor",
            editor_surface: "codemirror",
            editor_backing: "hiddenTextarea",
            editor_replay_strategy: "keyboardInsert",
          },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"query-editor\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await target1.click();");
    expect(generated.code).toContain("await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');");
    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"QUERY_EDITOR\", \"custom-editor\");");
    expect(generated.code).toContain("await page.keyboard.insertText(inputValue1);");
    expect(generated.code).not.toContain(`await target1.fill(${JSON.stringify(code)});`);
    expect(generated.code).not.toContain(code);
    expect(generated.warnings).toContain("event custom-editor uses keyboard insertion for a custom code-editor surface");
  });

  it("uses parameterized keyboard insertion for terminal-like text entry surfaces", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "terminal-text",
        event_seq: 1,
        action: "fill",
        value: "deploy preview",
        detail: {
          keyboard_text_entry: true,
          text_entry_mode: "keyboardInsert",
          typed_text_length: 14,
          observed_effects: ["Prompt deploy preview"],
          element: {
            role: "application",
            name: "Terminal surface",
            test_id: "terminal-shell",
            source_id: "terminal.shell",
          },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"terminal-shell\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"TERMINAL_SURFACE\", \"terminal-text\");");
    expect(generated.code).toContain("await target1.click();");
    expect(generated.code).toContain("await page.keyboard.type(inputValue1);");
    expect(generated.code).toContain("parameterizedTextRegex([\"Prompt \",\"\"], inputValue1)");
    expect(generated.code).not.toContain("deploy preview");
    expect(generated.warnings).toContain("event terminal-text uses keyboard typing for a non-editable app surface");
  });

  it("generates copy and cut replay without selected text locator leaks", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "copy-range",
        event_seq: 1,
        action: "copy",
        detail: {
          clipboard_event: true,
          clipboard_mode: "copy",
          copy_event: true,
          selection_start: 0,
          selection_end: 5,
          selected_text_length: 5,
          selected_text_redacted: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", text: "alpha beta gamma", source_id: "notes.editor" },
          observed_effects: ["Copied 5 characters"],
        },
        locator_candidates: [
          { kind: "css", locator: "page.locator(\"[data-synthi-source-id=\\\"notes.editor\\\"]\")", confidence: 0.975, reason: "source_identity" },
        ],
      }),
      event({
        event_id: "cut-range",
        event_seq: 2,
        action: "cut",
        detail: {
          clipboard_event: true,
          clipboard_mode: "cut",
          cut_event: true,
          selection_start: 6,
          selection_end: 10,
          selected_text_length: 4,
          selected_text_redacted: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", text: "alpha beta gamma", source_id: "notes.editor" },
          observed_effects: ["Cut 4 characters"],
        },
        locator_candidates: [
          { kind: "css", locator: "page.locator(\"[data-synthi-source-id=\\\"notes.editor\\\"]\")", confidence: 0.975, reason: "source_identity" },
        ],
      }),
    ]);

    expect(generated.code).toContain("element.setSelectionRange(selection.start, selection.end, direction);");
    expect(generated.code).toContain("process.platform === 'darwin' ? \"Meta+C\" : \"Control+C\"");
    expect(generated.code).toContain("process.platform === 'darwin' ? \"Meta+X\" : \"Control+X\"");
    expect(generated.code).toContain("Copied 5 characters");
    expect(generated.code).toContain("Cut 4 characters");
    expect(generated.code).not.toContain("alpha beta gamma");
    expect(generated.code).not.toContain("beta");
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
    ], { mode: "sameSession" });

    expect(generated.code).toContain("const selectValue1 = readRequiredEnv(\"SEGMENT\", \"select-segment\");");
    expect(generated.code).toContain("await target1.selectOption(selectValue1);");
    expect(generated.code).toContain("await expect(target1).toHaveValue(selectValue1);");
    expect(generated.code).toContain("await expect(page.getByText(\"Searched revenue\", { exact: true })).toBeVisible();");
    expect(generated.code).toContain("await expect(dropTarget3).toContainText(\"Revenue audit\");");
    expect(generated.code).toContain("await expect(page.getByText(\"Moved Revenue audit to Done lane\", { exact: true })).toBeVisible();");
    expect(generated.code).toContain("await expect(page.getByText(parameterizedTextRegex([\"Applied \",\" urgent; card done; search revenue\"], selectValue1))).toBeVisible();");
    expect(generated.code).not.toContain("Applied enterprise urgent");
  });

  it("generates range slider replay with input and change events", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "budget-range",
        event_seq: 1,
        action: "fill",
        value: "75",
        detail: {
          control_kind: "range",
          range_control: true,
          min: "0",
          max: "100",
          step: "5",
          element: { tag: "input", type: "range", label: "Budget" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"slider\", { name: \"Budget\" })", confidence: 0.96, reason: "accessible_role_and_name" },
          { kind: "label", locator: "page.getByLabel(\"Budget\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.getByRole(\"slider\", { name: \"Budget\" })");
    expect(generated.code).toContain("element.type !== 'range'");
    expect(generated.code).toContain("element.dispatchEvent(new Event('input', { bubbles: true }));");
    expect(generated.code).toContain("element.dispatchEvent(new Event('change', { bubbles: true }));");
    expect(generated.code).toContain("const inputValue1 = readRequiredEnv(\"BUDGET\", \"budget-range\");");
    expect(generated.code).toContain("await expect(target1).toHaveValue(inputValue1);");
    expect(generated.code).not.toContain("await target1.fill(\"75\");");
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

  it("generates parameterized clipboard paste replay without storing pasted text", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "paste-key",
        event_seq: 1,
        ts: 10,
        action: "press",
        value: "Control+V",
        detail: {
          element: { tag: "input", role: "textbox", label: "API token", source_id: "src_token" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.96, reason: "label" },
        ],
      }),
      event({
        event_id: "paste-token",
        event_seq: 2,
        ts: 20,
        action: "fill",
        detail: {
          clipboard_event: true,
          clipboard_mode: "paste",
          paste_event: true,
          paste_parameter: "API_TOKEN_PASTE",
          pasted_text_length: 14,
          pasted_text_redacted: true,
          element: { tag: "input", role: "textbox", label: "API token", source_id: "src_token" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.96, reason: "label" },
        ],
      }),
      event({
        event_id: "paste-fill-noise",
        event_seq: 3,
        ts: 60,
        action: "fill",
        value: "secret-token",
        detail: {
          input_debounced: true,
          element: { tag: "input", role: "textbox", label: "API token", source_id: "src_token" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.96, reason: "label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("async function pasteText(page, target, text)");
    expect(generated.code).toContain("const pasteText1 = process.env[\"API_TOKEN_PASTE\"];");
    expect(generated.code).toContain("await pasteText(page, target1, pasteText1);");
    expect(generated.code).toContain("await expect(target1).toHaveValue(pasteText1);");
    expect(generated.code).not.toContain("target1.press(\"Control+V\")");
    expect(generated.code).not.toContain("target1.fill(\"secret-token\")");
    expect(generated.code).not.toContain("secret-token");
    expect(generated.warnings).toContain("event paste-token clipboard paste replay is parameterized by API_TOKEN_PASTE");
  });

  it("generates parameterized clipboard drop replay without storing dropped text", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "drop-note",
        event_seq: 1,
        ts: 10,
        action: "drag",
        detail: {
          drag_mode: true,
          drag_class: "clipboardDrop",
          clipboard_event: true,
          clipboard_mode: "drop",
          clipboard_drop_event: true,
          clipboard_parameter: "RELEASE_NOTES_DROP",
          dropped_text_length: 18,
          dropped_text_redacted: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "src_notes" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Release notes\")", confidence: 0.96, reason: "label" },
        ],
      }),
      event({
        event_id: "drop-fill-noise",
        event_seq: 2,
        ts: 20,
        action: "fill",
        value: "secret dropped note",
        detail: {
          input_debounced: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "src_notes" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Release notes\")", confidence: 0.96, reason: "label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("async function dropText(target, text)");
    expect(generated.code).toContain("const dropText1 = process.env[\"RELEASE_NOTES_DROP\"];");
    expect(generated.code).toContain("await dropText(target1, dropText1);");
    expect(generated.code).toContain("await expect(target1).toHaveValue(dropText1);");
    expect(generated.code).not.toContain("target2.fill");
    expect(generated.code).not.toContain("secret dropped note");
    expect(generated.warnings).toContain("event drop-note clipboard drop replay is parameterized by RELEASE_NOTES_DROP");
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
    expect(generated.code).toContain("await expect(target1).toBeAttached();");
    expect(generated.code).not.toContain("await expect(target1).toBeVisible();");
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

  it("defaults exported mutation workflows to prefix-only replay", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "run",
        event_seq: 1,
        action: "click",
        detail: {
          network_method: "POST",
          network_url: "https://app.example.com/api/query",
          element: { role: "button", name: "Run query" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Run query\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.mode).toBe("prefixOnly");
    expect(generated.code).toContain("// Replay mode: prefixOnly");
    expect(generated.code).toContain("// Default mutation mode: prefixOnly");
    expect(generated.code).toContain("// Mutation boundary: run");
    expect(generated.code).toContain("await expect(target1).toBeEnabled();");
    expect(generated.code).not.toContain("await target1.click();");
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

  it("emits calibrated mouse replay for pointer drags with source and drop locators", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "pointer-drag",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          pointer_drag: true,
          pointer_replay: "calibrated",
          pointer_start_x_ratio: 0.5,
          pointer_start_y_ratio: 0.5,
          pointer_end_x_ratio: 0.5,
          pointer_end_y_ratio: 0.5,
          pointer_steps: 14,
          drop_locator: "page.getByRole(\"list\", { name: \"Done\" })",
          element: { role: "listitem", name: "Task", source_id: "src_task" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listitem\", { name: \"Task\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).not.toContain("test.skip(true");
    expect(generated.code).not.toContain(".dragTo(");
    expect(generated.code).toContain("await page.mouse.down();");
    expect(generated.code).toContain("await page.mouse.move(dropBox1.x + dropBox1.width * 0.5, dropBox1.y + dropBox1.height * 0.5, { steps: 14 });");
    expect(generated.code).toContain("await page.mouse.up();");
    expect(generated.warnings).not.toContain("workflow limitation: pointerDragUnreliable");
  });

  it("emits calibrated mouse replay for resize-handle pointer drags", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "resize-panels",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          pointer_drag: true,
          pointer_replay: "calibrated",
          pointer_start_x_ratio: 0.5,
          pointer_start_y_ratio: 0.5,
          pointer_end_x_ratio: 0.58,
          pointer_end_y_ratio: 0.5,
          pointer_steps: 10,
          drop_locator: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
          resize_handle: true,
          resize_axis: "x",
          aria_orientation: "vertical",
          element: { role: "separator", name: "Resize panels", source_id: "layout.resize.handle" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"separator\", { name: \"Resize panels\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).not.toContain("test.skip(true");
    expect(generated.code).not.toContain(".dragTo(");
    expect(generated.code).toContain("page.getByRole(\"separator\", { name: \"Resize panels\" })");
    expect(generated.code).toContain("page.getByRole(\"group\", { name: \"Resizable workspace\" })");
    expect(generated.code).toContain("await page.mouse.down();");
    expect(generated.code).toContain("await page.mouse.move(dropBox1.x + dropBox1.width * 0.58, dropBox1.y + dropBox1.height * 0.5, { steps: 10 });");
    expect(generated.code).toContain("await page.mouse.up();");
    expect(generated.code).not.toContain("toContainText(\"Resize panels\")");
    expect(generated.warnings).not.toContain("workflow limitation: pointerDragUnreliable");
  });

  it("emits calibrated mouse replay for custom ARIA slider drags", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "aria-slider",
        event_seq: 1,
        action: "drag",
        value: "page.getByTestId(\"risk-track\")",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          pointer_drag: true,
          pointer_replay: "calibrated",
          pointer_start_x_ratio: 0.5,
          pointer_start_y_ratio: 0.5,
          pointer_end_x_ratio: 0.75,
          pointer_end_y_ratio: 0.5,
          pointer_steps: 10,
          drop_locator: "page.getByTestId(\"risk-track\")",
          control_kind: "ariaSlider",
          aria_slider: true,
          aria_value_now: "75",
          aria_value_min: "0",
          aria_value_max: "100",
          observed_effects: ["Risk 75"],
          element: { role: "slider", name: "Risk threshold", source_id: "ariaSlider.thumb" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"slider\", { name: \"Risk threshold\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    expect(generated.code).not.toContain(".dragTo(");
    expect(generated.code).toContain("page.getByRole(\"slider\", { name: \"Risk threshold\" })");
    expect(generated.code).toContain("await page.mouse.move(dropBox1.x + dropBox1.width * 0.75, dropBox1.y + dropBox1.height * 0.5, { steps: 10 });");
    expect(generated.code).toContain("await expect(page.getByText(\"Risk 75\", { exact: true })).toBeVisible();");
    expect(generated.code).not.toContain("toContainText(\"Risk threshold\")");
    expect(generated.warnings).not.toContain("workflow limitation: pointerDragUnreliable");
  });

  it("emits multi-value select replay for native multiple selects", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "teams",
        event_seq: 1,
        action: "select",
        value: JSON.stringify(["qa", "design"]),
        detail: {
          multiple_select: true,
          select_values: ["qa", "design"],
          element: { tag: "select", role: "listbox", label: "Teams", text: "qa design", source_id: "settings.teams" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listbox\", { name: \"Teams\" })", confidence: 0.96, reason: "accessible_role_and_name" },
          { kind: "label", locator: "page.getByLabel(\"Teams\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.getByRole(\"listbox\", { name: \"Teams\" })");
    expect(generated.code).toContain("const selectValues1 = readRequiredEnvList(\"TEAMS\", \"teams\");");
    expect(generated.code).toContain("await target1.selectOption(selectValues1);");
    expect(generated.code).toContain("await expect(target1).toHaveValues(selectValues1);");
    expect(generated.code).not.toContain("page.getByText(\"qa design\")");
  });

  it("parameterizes selected custom ARIA option clicks", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "priority",
        event_seq: 1,
        action: "click",
        detail: {
          option_select_event: true,
          selected: true,
          option_value: "high",
          listbox_name: "Priority",
          listbox_selected_values: ["high"],
          observed_effects: ["Priority high"],
          element: { tag: "div", role: "option", name: "High priority", source_id: "settings.priority.high" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"High priority\" })", confidence: 0.96, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const optionValue1 = readRequiredEnv(\"PRIORITY\", \"priority\");");
    expect(generated.code).toContain("const listbox1 = await firstVisible(page.getByRole(\"listbox\", { name: \"Priority\" })");
    expect(generated.code).toContain("const target1 = await ariaOptionByValue(listbox1, optionValue1);");
    expect(generated.code).toContain("await target1.click();");
    expect(generated.code).toContain("await expect(target1).toHaveAttribute('aria-selected', \"true\");");
    expect(generated.code).toContain("parameterizedTextRegex([\"Priority \",\"\"], optionValue1)");
  });

  it("keeps repeated ARIA option parameters distinct when they target different options", () => {
    const generated = generatePlaywrightScript([
      event({
        event_id: "invoice-a",
        event_seq: 1,
        action: "click",
        detail: {
          option_select_event: true,
          selected: true,
          option_value: "Invoice A",
          listbox_name: "Invoice queue",
          observed_effects: ["Selected 1 invoices"],
          element: { tag: "button", role: "option", name: "Invoice A", source_id: "invoice.a" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"Invoice A\" })", confidence: 0.96, reason: "accessible_role_and_name" },
        ],
      }),
      event({
        event_id: "invoice-c",
        event_seq: 2,
        action: "click",
        value: "Shift",
        detail: {
          option_select_event: true,
          selected: true,
          option_value: "Invoice C",
          listbox_name: "Invoice queue",
          modifier_keys: { shift: true, control: false, meta: false, alt: false },
          modifiers: ["Shift"],
          observed_effects: ["Selected 3 invoices"],
          element: { tag: "button", role: "option", name: "Invoice C", source_id: "invoice.c" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"Invoice C\" })", confidence: 0.96, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("const optionValue1 = readRequiredEnv(\"INVOICE_QUEUE\", \"invoice-a\");");
    expect(generated.code).toContain("const optionValue2 = readRequiredEnv(\"INVOICE_QUEUE_2\", \"invoice-c\");");
    expect(generated.code).toContain("await target2.click({ modifiers: [\"Shift\"] });");
    expect(generated.warnings).toContain("event invoice-a ARIA option replay is parameterized by INVOICE_QUEUE");
    expect(generated.warnings).toContain("event invoice-c ARIA option replay is parameterized by INVOICE_QUEUE_2");
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
