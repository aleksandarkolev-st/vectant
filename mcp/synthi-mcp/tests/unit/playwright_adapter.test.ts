import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enrichCapturedFramePayload,
  frameLocatorMetadataFromElementDescriptor,
  normalizeCapturedHumanAction,
  normalizeCapturedHumanActionAnnotation,
  playwrightCookiesForAuth,
  playwrightStorageStateForAuth,
  resolveCdpConnectTimeoutMs,
  sessionStorageInitPayload,
} from "../../src/browser/playwright_adapter.js";

describe("browser Playwright adapter config", () => {
  it("uses an environment-configurable CDP connection timeout", () => {
    expect(resolveCdpConnectTimeoutMs({})).toBe(60_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "999999" })).toBe(300_000);
    expect(resolveCdpConnectTimeoutMs({ SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS: "bad" })).toBe(60_000);
  });

  it("splits auth storage into Playwright context state, cookies, and sessionStorage init payload", () => {
    const storageState = {
      cookies: [
        { name: "sid", value: "", domain: "app.example.com", path: "/", sameSite: "None", secure: true, partitionKey: "https://app.example.com" },
        { name: "", value: "ignored", domain: "app.example.com", path: "/" },
      ],
      origins: [
        {
          origin: "https://app.example.com",
          localStorage: [{ name: "session", value: "local-secret" }],
          sessionStorage: [{ name: "csrf", value: "session-secret" }],
        },
      ],
    };

    expect(playwrightStorageStateForAuth(storageState)).toEqual({
      cookies: [],
      origins: [{
        origin: "https://app.example.com",
        localStorage: [{ name: "session", value: "local-secret" }],
      }],
    });
    expect(playwrightCookiesForAuth(storageState)).toEqual([
      expect.objectContaining({
        name: "sid",
        value: "",
        domain: "app.example.com",
        sameSite: "None",
        partitionKey: "https://app.example.com",
      }),
    ]);
    expect(sessionStorageInitPayload(storageState)).toEqual({
      "https://app.example.com": [{ name: "csrf", value: "session-secret" }],
    });
  });
});

describe("browser Playwright teach capture", () => {
  it("flushes pending discrete action effects before capturing the next action", () => {
    const source = readFileSync(resolve(process.cwd(), "src/browser/playwright_adapter.ts"), "utf8");
    const emitStart = source.indexOf("function emit(el, action, value, detail)");
    const flushEdits = source.indexOf("if (action !== 'fill') flushPendingEdits();", emitStart);
    const flushScrolls = source.indexOf("if (action !== 'scroll') flushPendingScrolls();", emitStart);
    const flushActions = source.indexOf("if (action !== 'scroll') flushPendingActionSends();", emitStart);
    const replayElement = source.indexOf("const replayEl = editorReplayElementFor(el, action);", emitStart);

    expect(emitStart).toBeGreaterThanOrEqual(0);
    expect(flushActions).toBeGreaterThan(flushEdits);
    expect(flushActions).toBeGreaterThan(flushScrolls);
    expect(flushActions).toBeLessThan(replayElement);
  });

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

  it("derives durable frame locators from hosted iframe element metadata", () => {
    const metadata = frameLocatorMetadataFromElementDescriptor({
      tag: "iframe",
      id: "runtime-frame",
      name: "preview",
      title: "Preview surface",
      test_id: "app-preview",
      src: "https://app.example.com/embedded",
      css: "main > iframe",
      frame_url: "https://app.example.com/embedded",
    });

    expect(metadata).toEqual({
      frame_id: "preview",
      frame_locator: "iframe[data-testid=\"app-preview\"]",
      frame_locator_candidates: [
        "iframe[data-testid=\"app-preview\"]",
        "iframe[name=\"preview\"]",
        "iframe[title=\"Preview surface\"]",
        "iframe#runtime-frame",
        "iframe[src=\"https://app.example.com/embedded\"]",
        "main > iframe",
      ],
      frame_url: "https://app.example.com/embedded",
    });
  });

  it("keeps framed action replay anchored to the top-level page URL", () => {
    const metadata = frameLocatorMetadataFromElementDescriptor({
      tag: "iframe",
      test_id: "checkout-frame",
      frame_url: "https://app.example.com/frame.html",
    });
    expect(metadata).not.toBeNull();

    const enriched = enrichCapturedFramePayload({
      url: "https://app.example.com/frame.html",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada Lovelace",
      field_name: "Cardholder",
      element: { tag: "input", role: "textbox", label: "Cardholder" },
      detail: { input_debounced: true },
    }, metadata!, "https://app.example.com/checkout");
    const event = normalizeCapturedHumanAction(enriched, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      tab_id: "tab-a",
      url: "https://app.example.com/checkout",
      origin: "https://app.example.com",
      frame_id: "checkout-frame",
      detail: expect.objectContaining({
        frame_locator: "iframe[data-testid=\"checkout-frame\"]",
        frame_url: "https://app.example.com/frame.html",
        frame_origin: "https://app.example.com",
      }),
    }));
  });

  it("preserves nested frame locator chains on taught framed actions", () => {
    const enriched = enrichCapturedFramePayload({
      url: "https://app.example.com/inner.html",
      origin: "https://app.example.com",
      action: "fill",
      value: "Ada Nested",
      element: { tag: "input", role: "textbox", label: "Cardholder" },
      detail: { input_debounced: true },
    }, {
      frame_id: "inner-frame",
      frame_locator: "iframe[data-testid=\"inner-frame\"]",
      frame_locator_chain: [
        "iframe[data-testid=\"outer-frame\"]",
        "iframe[data-testid=\"inner-frame\"]",
      ],
      frame_locator_candidates: ["iframe[data-testid=\"inner-frame\"]"],
      frame_locator_candidate_chain: [
        ["iframe[data-testid=\"outer-frame\"]"],
        ["iframe[data-testid=\"inner-frame\"]"],
      ],
      frame_url: "https://app.example.com/inner.html",
    }, "https://app.example.com/checkout");
    const event = normalizeCapturedHumanAction(enriched, "tab-a");

    expect(event.detail).toEqual(expect.objectContaining({
      frame_locator: "iframe[data-testid=\"inner-frame\"]",
      frame_locator_chain: [
        "iframe[data-testid=\"outer-frame\"]",
        "iframe[data-testid=\"inner-frame\"]",
      ],
      frame_locator_candidate_chain: [
        ["iframe[data-testid=\"outer-frame\"]"],
        ["iframe[data-testid=\"inner-frame\"]"],
      ],
    }));
  });

  it("normalizes code editor metadata on taught fill events", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/editor",
      origin: "https://app.example.com",
      action: "fill",
      value: "const answer = 42;",
      field_name: "Automation script",
      element: {
        tag: "textarea",
        role: "textbox",
        label: "Automation script",
        test_id: "automation-script",
        source_id: "editor.script",
        editor_surface: "textarea",
        editor_backing: "textarea",
        editor_language: "typescript",
        editor_replay_strategy: "fill",
        editor_container_test_id: "script-editor",
        editor_container_role: "textbox",
        editor_container_css: "[data-testid=\"script-editor\"]",
      },
      detail: {
        editor_surface: "textarea",
        editor_backing: "textarea",
        editor_language: "typescript",
        editor_replay_strategy: "fill",
        editor_value_length: 18,
        editor_line_count: 1,
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      action: "fill",
      value: "const answer = 42;",
      element: expect.objectContaining({
        editor_surface: "textarea",
        editor_language: "typescript",
        editor_replay_strategy: "fill",
      }),
      detail: expect.objectContaining({
        editor_surface: "textarea",
        editor_backing: "textarea",
        editor_line_count: 1,
      }),
    }));
  });

  it("normalizes native multi-select values on taught select events", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "select",
      value: JSON.stringify(["qa", "design"]),
      field_name: "Teams",
      element: {
        tag: "select",
        role: "listbox",
        label: "Teams",
        source_id: "settings.teams",
      },
      detail: {
        change_event: true,
        select_event: true,
        multiple_select: true,
        select_values: ["qa", "design"],
        selected_option_labels: ["QA", "Design"],
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      action: "select",
      value: "[\"qa\",\"design\"]",
      field_name: "Teams",
      detail: expect.objectContaining({
        multiple_select: true,
        select_values: ["qa", "design"],
        selected_option_labels: ["QA", "Design"],
      }),
    }));
  });

  it("normalizes click modifier metadata for taught range selection", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/invoices",
      origin: "https://app.example.com",
      action: "click",
      element: {
        tag: "button",
        role: "option",
        name: "Invoice C",
        source_id: "invoice.c",
      },
      detail: {
        click_event: true,
        modified_click: true,
        modifiers: ["Shift"],
        modifier_keys: { alt: false, control: false, meta: false, shift: true },
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      action: "click",
      detail: expect.objectContaining({
        click_event: true,
        modified_click: true,
        modifiers: ["Shift"],
        modifier_keys: expect.objectContaining({ shift: true }),
      }),
    }));
  });

  it("drops aggregate visible text from non-editable application surfaces", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/workspace",
      origin: "https://app.example.com",
      action: "fill",
      value: "deploy preview",
      element: {
        tag: "section",
        role: "application",
        name: "Prompt deploy preview Idle",
        text: "Prompt deploy preview Idle",
        test_id: "terminal-shell",
        source_id: "terminal.shell",
      },
      detail: {
        keyboard_text_entry: true,
        text_entry_mode: "keyboardInsert",
      },
    }, "tab-a");

    expect(event?.element).toEqual(expect.objectContaining({
      role: "application",
      test_id: "terminal-shell",
      source_id: "terminal.shell",
    }));
    expect(event?.element).not.toEqual(expect.objectContaining({
      name: "Prompt deploy preview Idle",
      text: "Prompt deploy preview Idle",
    }));
  });

  it("drops editable text values from element metadata before locator ranking", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/notes",
      origin: "https://app.example.com",
      action: "copy",
      element: {
        tag: "textarea",
        role: "textbox",
        label: "Release notes",
        text: "alpha beta gamma",
        source_id: "notes.editor",
      },
      detail: {
        clipboard_event: true,
        clipboard_mode: "copy",
        selection_start: 0,
        selection_end: 5,
        selected_text_length: 5,
        selected_text_redacted: true,
      },
    }, "tab-a");

    expect(event?.element).toEqual(expect.objectContaining({
      tag: "textarea",
      label: "Release notes",
      source_id: "notes.editor",
    }));
    expect(event?.element).not.toEqual(expect.objectContaining({ text: "alpha beta gamma" }));
  });

  it("normalizes ARIA option selection metadata", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      field_name: "High priority",
      element: {
        tag: "div",
        role: "option",
        name: "High priority",
        text: "High priority",
        source_id: "settings.priority.high",
        selected: true,
        listbox_name: "Priority",
        listbox_multiselect: false,
        listbox_selected_values: ["high"],
      },
      detail: {
        click_event: true,
        option_select_event: true,
        selected: true,
        option_value: "high",
        listbox_name: "Priority",
        listbox_multiselect: false,
        listbox_selected_values: ["high"],
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      action: "click",
      element: expect.objectContaining({
        role: "option",
        selected: true,
        listbox_name: "Priority",
        listbox_selected_values: ["high"],
      }),
      detail: expect.objectContaining({
        option_select_event: true,
        option_value: "high",
        listbox_selected_values: ["high"],
      }),
    }));
  });

  it("redacts editable element text for clipboard paste capture", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "fill",
      field_name: "Release notes",
      element: {
        tag: "div",
        role: "textbox",
        label: "Release notes",
        text: "secret pasted note",
        content_editable: true,
        source_id: "notes.release",
      },
      detail: {
        clipboard_event: true,
        clipboard_mode: "paste",
        paste_parameter: "RELEASE_NOTES_PASTE",
        pasted_text_redacted: true,
      },
    }, "tab-a");

    expect(event?.element).toEqual(expect.objectContaining({
      tag: "div",
      role: "textbox",
      label: "Release notes",
      content_editable: true,
    }));
    expect(event?.element?.text).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("secret pasted note");
  });

  it("redacts editable element text for clipboard drop capture", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "drag",
      field_name: "Release notes",
      element: {
        tag: "textarea",
        role: "textbox",
        label: "Release notes",
        text: "secret dropped note",
        source_id: "notes.drop",
      },
      detail: {
        clipboard_event: true,
        clipboard_mode: "drop",
        clipboard_drop_event: true,
        clipboard_parameter: "RELEASE_NOTES_DROP",
        dropped_text_redacted: true,
      },
    }, "tab-a");

    expect(event?.element).toEqual(expect.objectContaining({
      tag: "textarea",
      role: "textbox",
      label: "Release notes",
    }));
    expect(event?.element?.text).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("secret dropped note");
  });

  it("preserves calibrated resize-handle pointer drag metadata", () => {
    const event = normalizeCapturedHumanAction({
      url: "https://app.example.com/workspace",
      origin: "https://app.example.com",
      action: "drag",
      value: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
      field_name: "Resize panels",
      element: {
        tag: "div",
        role: "separator",
        name: "Resize panels",
        source_id: "layout.resize.handle",
      },
      detail: {
        event_source: "dom_listener",
        drag_mode: true,
        drag_class: "pointerSensor",
        pointer_drag: true,
        pointer_replay: "calibrated",
        pointer_calibrated: true,
        pointer_start_x_ratio: 0.5,
        pointer_start_y_ratio: 0.5,
        pointer_end_x_ratio: 0.58,
        pointer_end_y_ratio: 0.5,
        pointer_steps: 12,
        drop_locator: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
        resize_handle: true,
        resize_axis: "x",
        aria_orientation: "vertical",
      },
    }, "tab-a");

    expect(event).toEqual(expect.objectContaining({
      action: "drag",
      value: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
      element: expect.objectContaining({
        role: "separator",
        name: "Resize panels",
        source_id: "layout.resize.handle",
      }),
      detail: expect.objectContaining({
        drag_class: "pointerSensor",
        pointer_replay: "calibrated",
        pointer_calibrated: true,
        drop_locator: "page.getByRole(\"group\", { name: \"Resizable workspace\" })",
        resize_handle: true,
        resize_axis: "x",
        aria_orientation: "vertical",
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

  it("redacts prompt responses from derived observed effects", () => {
    const event = normalizeCapturedHumanActionAnnotation({
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      actions: ["click"],
      detail: {
        dialog_event: true,
        dialog_type: "prompt",
        dialog_message: "Enter workspace name",
        dialog_prompt_value: "Secret Launch Board",
        dialog_accepted: true,
        observed_effects: ["Renamed workspace to Secret Launch Board"],
      },
    }, "tab-a");

    expect(event?.detail).toEqual(expect.objectContaining({
      dialog_prompt_value: "[REDACTED]",
      dialog_prompt_value_redacted: true,
      observed_effects: ["Renamed workspace to [REDACTED]"],
      observed_effects_redacted: true,
    }));
  });
});
