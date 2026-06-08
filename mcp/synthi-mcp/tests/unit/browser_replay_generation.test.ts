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
        detail: { frame_locator: "iframe[name=\"checkout\"]", observed_effects: ["Saved Ada"] },
        value: "Ada",
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Cardholder\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.frameLocator(\"iframe[name=\\\"checkout\\\"]\").getByLabel(\"Cardholder\")");
    expect(generated.code).toContain("await target1.fill(\"Ada\");");
    expect(generated.code).toContain("page.frameLocator(\"iframe[name=\\\"checkout\\\"]\").getByText(\"Saved Ada\", { exact: true })");
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
    expect(generated.code).toContain("await expect(popup1).toHaveURL(`${baseUrl}/help`);");
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
    expect(generated.code).toContain("await target2.fill(\"contracts\");");
    expect(generated.code).toContain("await expect(popup1.getByText(\"Filtered help for contracts\", { exact: true })).toBeVisible();");
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

    expect(generated.code).toContain("await target1.fill(\"Release notes ready\");");
    expect(generated.code).toContain("await expect(target1).toContainText(\"Release notes ready\");");
    expect(generated.code).not.toContain("toHaveValue(\"Release notes ready\")");
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

    expect(generated.code).toContain(`await target1.fill(${JSON.stringify(code)});`);
    expect(generated.code).toContain(`await expect(target1).toHaveValue(${JSON.stringify(code)});`);
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
    expect(generated.code).toContain(`await page.keyboard.insertText(${JSON.stringify(code)});`);
    expect(generated.code).not.toContain(`await target1.fill(${JSON.stringify(code)});`);
    expect(generated.warnings).toContain("event custom-editor uses keyboard insertion for a custom code-editor surface");
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
    expect(generated.code).toContain("await expect(target1).toHaveValue(\"75\");");
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
          element: { tag: "select", role: "listbox", label: "Teams", source_id: "settings.teams" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listbox\", { name: \"Teams\" })", confidence: 0.96, reason: "accessible_role_and_name" },
          { kind: "label", locator: "page.getByLabel(\"Teams\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    expect(generated.code).toContain("page.getByRole(\"listbox\", { name: \"Teams\" })");
    expect(generated.code).toContain("await target1.selectOption([\"qa\",\"design\"]);");
    expect(generated.code).toContain("await expect(target1).toHaveValues([\"qa\",\"design\"]);");
  });

  it("asserts selected state for custom ARIA option clicks", () => {
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
          element: { tag: "div", role: "option", name: "High priority", source_id: "settings.priority.high" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"High priority\" })", confidence: 0.96, reason: "accessible_role_and_name" },
        ],
      }),
    ]);

    expect(generated.code).toContain("await target1.click();");
    expect(generated.code).toContain("await expect(target1).toHaveAttribute('aria-selected', \"true\");");
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
