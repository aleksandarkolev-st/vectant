import { chromium, type Browser, type Frame, type FrameLocator, type Locator, type Page } from "playwright-core";
import { readFile } from "node:fs/promises";
import { normalizeOrigin, redactText, redactUrl } from "./security.js";
import { BROWSER_ACTION_KINDS } from "./types.js";
import type { BrowserActionKind, BrowserElementMetadata, BrowserSnapshot, BrowserTab, BrowserTraceEvent } from "./types.js";

interface PageRecord {
  page: Page;
  tab_id: string;
}

export interface FrameLocatorMetadata {
  frame_id: string;
  frame_locator: string;
  frame_locator_candidates: string[];
  frame_url?: string;
}

export interface FrameElementDescriptor {
  tag?: string;
  id?: string;
  name?: string;
  title?: string;
  aria_label?: string;
  test_id?: string;
  data_test?: string;
  src?: string;
  css?: string;
  frame_url?: string;
}

export interface BrowserActionResult {
  ok: true;
  action: BrowserActionKind;
  tab_id: string;
  url: string;
  detail?: Record<string, unknown>;
}

export interface BrowserWaitInput {
  tab_id: string;
  condition: "selector" | "url" | "load" | "networkidle" | "timeout";
  selector?: string;
  url_pattern?: string;
  timeout_ms?: number;
}

export interface CapturedBrowserHumanAction {
  tab_id: string;
  frame_id?: string;
  url: string;
  origin: string;
  action: BrowserActionKind;
  value?: string;
  field_name?: string;
  element?: BrowserElementMetadata;
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  detail?: Record<string, unknown>;
}

export type BrowserTeachEventSink = (event: CapturedBrowserHumanAction) => void;

export type BrowserTeachEventAnnotationSink = (event: {
  tab_id: string;
  url: string;
  origin: string;
  actions?: BrowserActionKind[];
  detail: Record<string, unknown>;
  within_ms?: number;
}) => void;

export interface BrowserWorkflowOverlayRequest {
  action: "state" | "observe" | "teach" | "stop";
  url?: string;
}

export type BrowserWorkflowOverlayResponse = {
  ok: boolean;
  status?: string;
  label?: string;
  detail?: string;
  recording?: boolean;
  observed?: boolean;
  stepCount?: number;
  lastAction?: string;
  lastTarget?: string;
  url?: string;
  error?: string;
};

export type BrowserWorkflowOverlayActionSink = (
  request: BrowserWorkflowOverlayRequest & { tab_id: string; page_url: string }
) => Promise<BrowserWorkflowOverlayResponse> | BrowserWorkflowOverlayResponse;

export class BrowserPlaywrightAdapter {
  private browser: Browser | null = null;
  private cdpUrl: string | null = null;
  private nextTabSeq = 0;
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly pages = new Map<string, PageRecord>();
  private readonly popupOpeners = new Map<string, { opener_tab_id: string; opener_origin: string }>();
  private readonly instrumented = new WeakSet<Page>();
  private readonly workflowOverlayInstalled = new WeakSet<Page>();
  private readonly consoleEvents = new Map<string, BrowserTraceEvent[]>();
  private readonly networkEvents = new Map<string, BrowserTraceEvent[]>();
  private teachEventSink: BrowserTeachEventSink | null = null;
  private teachEventAnnotationSink: BrowserTeachEventAnnotationSink | null = null;
  private workflowOverlayActionSink: BrowserWorkflowOverlayActionSink | null = null;
  private workflowOverlayEnabled = false;

  setTeachEventSink(sink: BrowserTeachEventSink | null): void {
    this.teachEventSink = sink;
  }

  setTeachEventAnnotationSink(sink: BrowserTeachEventAnnotationSink | null): void {
    this.teachEventAnnotationSink = sink;
  }

  setWorkflowOverlayActionSink(sink: BrowserWorkflowOverlayActionSink | null): void {
    this.workflowOverlayActionSink = sink;
  }

  setWorkflowOverlayEnabled(enabled: boolean): void {
    this.workflowOverlayEnabled = enabled;
  }

  async attach(cdpUrl: string): Promise<BrowserTab[]> {
    if (!this.browser || this.cdpUrl !== cdpUrl) {
      if (this.browser) await this.browser.close().catch(() => undefined);
      this.browser = await chromium.connectOverCDP(cdpUrl, {
        timeout: resolveCdpConnectTimeoutMs(),
      });
      this.cdpUrl = cdpUrl;
    }
    return this.listTabs();
  }

  isAttached(): boolean {
    return this.browser !== null;
  }

  async listTabs(): Promise<BrowserTab[]> {
    const browser = this.requireBrowser();
    this.pages.clear();
    const tabs: BrowserTab[] = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const tab = await this.describePage(page);
        tabs.push(tab);
      }
    }
    return tabs;
  }

  async open(url: string): Promise<BrowserTab> {
    const browser = this.requireBrowser();
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return this.describePage(page);
  }

  async openOrNavigate(url: string): Promise<BrowserTab> {
    const browser = this.requireBrowser();
    const context = browser.contexts()[0] ?? await browser.newContext();
    const existingPage = context.pages().find((page) => page.url() === url);
    const page = existingPage ?? await context.newPage();
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront();
    return this.describePage(page);
  }

  async openCold(url: string): Promise<BrowserTab> {
    const browser = this.requireBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return this.describePage(page);
  }

  async selectTab(tab_id: string): Promise<BrowserTab> {
    const page = this.requirePage(tab_id);
    await page.bringToFront();
    return this.describePage(page);
  }

  async snapshot(tab_id: string): Promise<BrowserSnapshot> {
    const page = this.requirePage(tab_id);
    const [screenshot, dom] = await Promise.all([
      page.screenshot({ type: "png" }),
      page.evaluate(() => {
        const visibleText = document.body?.innerText ?? "";
        const fields = Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 100).map((node) => {
          const el = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const id = el.id || "";
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : "";
          return {
            tag: el.tagName.toLowerCase(),
            id,
            name: el.getAttribute("name") || "",
            type: el.getAttribute("type") || "",
            placeholder: el.getAttribute("placeholder") || "",
            label: label || "",
            test_id: el.getAttribute("data-testid") || el.getAttribute("data-test") || "",
          };
        });
        return {
          title: document.title,
          url: location.href,
          text_sample: visibleText.slice(0, 5000),
          fields,
        };
      }),
    ]);
    const origin = normalizeOrigin(page.url()).origin;
    return {
      tab_id,
      url: page.url(),
      origin,
      title: await page.title().catch(() => undefined),
      screenshot_base64: screenshot.toString("base64"),
      dom,
    };
  }

  async action(tab_id: string, action: BrowserActionKind, selector?: string, value?: string): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    await this.performAction(page, action, selector, value, (targetSelector) => this.resolveLocator(page, targetSelector));
    return { ok: true, action, tab_id, url: page.url() };
  }

  private async performAction(
    page: Page,
    action: BrowserActionKind,
    selector: string | undefined,
    value: string | undefined,
    resolveLocator: (selector: string | undefined) => Locator
  ): Promise<void> {
    switch (action) {
      case "navigate":
        if (!value) throw new Error("missing_url");
        await page.goto(value, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await resolveLocator(selector).click();
        break;
      case "dblclick":
        await resolveLocator(selector).dblclick();
        break;
      case "contextmenu":
        await resolveLocator(selector).click({ button: "right" });
        break;
      case "hover":
        await resolveLocator(selector).hover();
        break;
      case "drag":
        if (!value) throw new Error("missing_drag_target");
        await resolveLocator(selector).dragTo(resolveLocator(value));
        break;
      case "scroll":
        await this.scrollLocator(resolveLocator(selector), value);
        break;
      case "fill":
        await resolveLocator(selector).fill(value ?? "");
        break;
      case "press":
        await resolveLocator(selector).press(value ?? "Enter");
        break;
      case "select":
        await resolveLocator(selector).selectOption(selectOptionsFromValue(value));
        break;
      case "check":
        await resolveLocator(selector).check();
        break;
      case "uncheck":
        await resolveLocator(selector).uncheck();
        break;
      case "wait":
        await resolveLocator(selector).waitFor();
        break;
      default: {
        const neverAction: never = action;
        throw new Error(`unsupported_browser_action:${String(neverAction)}`);
      }
    }
  }

  async replayActionEvent(
    tab_id: string,
    event: BrowserTraceEvent,
    action: BrowserActionKind,
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    if (action === "fill" && isRangeControlEvent(event)) {
      return await this.replayRangeFillAction(tab_id, event, selector, value);
    }
    if (action === "fill" && isKeyboardEditorFillEvent(event)) {
      return await this.replayKeyboardEditorFillAction(tab_id, event, selector, value);
    }
    if (action === "drag" && isCalibratedPointerDragEvent(event)) {
      return await this.replayCalibratedPointerDragAction(tab_id, event, selector, value);
    }
    if (isDownloadReplayEvent(event) && (action === "click" || action === "dblclick")) {
      return await this.replayDownloadAction(tab_id, event, action, selector);
    }
    if (isDialogReplayEvent(event) && (action === "click" || action === "dblclick" || action === "press")) {
      return await this.replayDialogAction(tab_id, event, action, selector, value);
    }
    if (isPopupReplayEvent(event) && (action === "click" || action === "dblclick" || action === "press")) {
      return await this.replayPopupAction(tab_id, event, action, selector, value);
    }
    if (!stringOpt(event.detail?.["frame_locator"])) {
      return await this.action(tab_id, action, selector, value);
    }
    const page = this.requirePage(tab_id);
    await this.performAction(page, action, selector, value, (targetSelector) => this.resolveLocatorForEvent(page, event, targetSelector));
    return { ok: true, action, tab_id, url: page.url() };
  }

  private async replayRangeFillAction(
    tab_id: string,
    event: BrowserTraceEvent,
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocatorForEvent(page, event, selector);
    await setRangeLocatorValue(target, value ?? event.value ?? "");
    return {
      ok: true,
      action: "fill",
      tab_id,
      url: page.url(),
      detail: { control_kind: "range", value: value ?? event.value ?? "" },
    };
  }

  private async replayKeyboardEditorFillAction(
    tab_id: string,
    event: BrowserTraceEvent,
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocatorForEvent(page, event, selector);
    const nextValue = value ?? event.value ?? "";
    await target.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(nextValue);
    return {
      ok: true,
      action: "fill",
      tab_id,
      url: page.url(),
      detail: { editor_replay_strategy: "keyboardInsert", value_length: nextValue.length },
    };
  }

  private async replayCalibratedPointerDragAction(
    tab_id: string,
    event: BrowserTraceEvent,
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const source = this.resolveLocatorForEvent(page, event, selector);
    const dropSelector = stringDetail(event, "drop_locator") ?? value ?? event.value;
    if (!dropSelector) throw new Error("missing_calibrated_pointer_drop_locator");
    const dropTarget = this.resolveLocatorForEvent(page, event, dropSelector);
    const sourceBox = await source.boundingBox();
    const dropBox = await dropTarget.boundingBox();
    if (!sourceBox) throw new Error("calibrated_pointer_source_not_visible");
    if (!dropBox) throw new Error("calibrated_pointer_drop_not_visible");
    const start = pointFromBox(sourceBox, {
      xRatio: numberDetail(event, "pointer_start_x_ratio") ?? 0.5,
      yRatio: numberDetail(event, "pointer_start_y_ratio") ?? 0.5,
    });
    const end = pointFromBox(dropBox, {
      xRatio: numberDetail(event, "pointer_end_x_ratio") ?? 0.5,
      yRatio: numberDetail(event, "pointer_end_y_ratio") ?? 0.5,
    });
    const steps = clampInteger(numberDetail(event, "pointer_steps") ?? 12, 1, 60);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps });
    await page.mouse.up();
    return {
      ok: true,
      action: "drag",
      tab_id,
      url: page.url(),
      detail: {
        pointer_replay: "calibrated",
        drop_locator: dropSelector,
        pointer_steps: steps,
      },
    };
  }

  private async replayDownloadAction(
    tab_id: string,
    event: BrowserTraceEvent,
    action: "click" | "dblclick",
    selector?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocatorForEvent(page, event, selector);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      action === "dblclick" ? target.dblclick() : target.click(),
    ]);
    const expectedFilename = stringDetail(event, "suggested_filename");
    const filenameRedacted = boolDetail(event, "suggested_filename_redacted");
    if (expectedFilename && !filenameRedacted && download.suggestedFilename() !== expectedFilename) {
      throw new Error(`download_filename_mismatch:${download.suggestedFilename()}`);
    }
    return {
      ok: true,
      action,
      tab_id,
      url: page.url(),
      detail: { download_filename: download.suggestedFilename() },
    };
  }

  private async replayDialogAction(
    tab_id: string,
    event: BrowserTraceEvent,
    action: "click" | "dblclick" | "press",
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocatorForEvent(page, event, selector);
    const expectedType = stringDetail(event, "dialog_type") ?? "alert";
    const expectedMessage = stringDetail(event, "dialog_message");
    const messageRedacted = boolDetail(event, "dialog_message_redacted");
    const accepted = event.detail?.["dialog_accepted"] !== false;
    const promptValue = stringDetail(event, "dialog_prompt_value");
    const promptRedacted = boolDetail(event, "dialog_prompt_value_redacted");
    let dialogMessage = "";
    const dialogPromise = new Promise<void>((resolve, reject) => {
      page.once("dialog", async (dialog) => {
        try {
          if (dialog.type() !== expectedType) throw new Error(`dialog_type_mismatch:${dialog.type()}`);
          dialogMessage = dialog.message();
          if (expectedMessage && !messageRedacted && !dialogMessage.includes(expectedMessage)) {
            throw new Error("dialog_message_mismatch");
          }
          if (accepted) {
            await dialog.accept(expectedType === "prompt" && promptValue && !promptRedacted ? promptValue : undefined);
          } else {
            await dialog.dismiss();
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    await Promise.all([dialogPromise, runTargetAction(target, action, value)]);
    return {
      ok: true,
      action,
      tab_id,
      url: page.url(),
      detail: { dialog_type: expectedType, dialog_message: dialogMessage },
    };
  }

  private async replayPopupAction(
    tab_id: string,
    event: BrowserTraceEvent,
    action: "click" | "dblclick" | "press",
    selector?: string,
    value?: string
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocatorForEvent(page, event, selector);
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      runTargetAction(target, action, value),
    ]);
    const popup_tab_id = this.idForPage(popup);
    this.pages.set(popup_tab_id, { page: popup, tab_id: popup_tab_id });
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    const expectedUrl = stringDetail(event, "popup_url");
    const urlRedacted = boolDetail(event, "popup_url_redacted");
    if (expectedUrl && !urlRedacted && popup.url() !== expectedUrl) {
      throw new Error(`popup_url_mismatch:${popup.url()}`);
    }
    const expectedTitle = stringDetail(event, "popup_title");
    const titleRedacted = boolDetail(event, "popup_title_redacted");
    const popupTitle = await popup.title().catch(() => "");
    if (expectedTitle && !titleRedacted && popupTitle !== expectedTitle) {
      throw new Error(`popup_title_mismatch:${popupTitle}`);
    }
    return {
      ok: true,
      action,
      tab_id,
      url: page.url(),
      detail: { popup_url: popup.url(), popup_title: popupTitle, popup_tab_id },
    };
  }

  async fileDrop(
    tab_id: string,
    selector: string | undefined,
    filePath: string,
    options: { file_input?: boolean; mime_type?: string; event?: BrowserTraceEvent } = {}
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = options.event
      ? this.resolveLocatorForEvent(page, options.event, selector)
      : this.resolveLocator(page, selector);
    if (options.file_input) {
      await target.setInputFiles(filePath);
    } else {
      const buffer = await readFile(filePath);
      const fileName = filePath.split(/[\\/]/).pop() || "upload.bin";
      const mimeType = options.mime_type ?? "application/octet-stream";
      const dataTransfer = await page.evaluateHandle(({ bytes, fileName, mimeType }) => {
        const dataTransfer = new DataTransfer();
        const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType });
        dataTransfer.items.add(file);
        return dataTransfer;
      }, { bytes: Array.from(buffer), fileName, mimeType });
      await target.dispatchEvent("dragenter", { dataTransfer });
      await target.dispatchEvent("dragover", { dataTransfer });
      await target.dispatchEvent("drop", { dataTransfer });
    }
    return { ok: true, action: "drag", tab_id, url: page.url() };
  }

  async wait(input: BrowserWaitInput): Promise<{ ok: true; tab_id: string; condition: string }> {
    const page = this.requirePage(input.tab_id);
    const timeout = input.timeout_ms ?? 30_000;
    switch (input.condition) {
      case "selector":
        await this.resolveLocator(page, input.selector).waitFor({ timeout });
        break;
      case "url":
        await page.waitForURL(input.url_pattern ? new RegExp(input.url_pattern) : /.*/, { timeout });
        break;
      case "load":
        await page.waitForLoadState("load", { timeout });
        break;
      case "networkidle":
        await page.waitForLoadState("networkidle", { timeout });
        break;
      case "timeout":
        await page.waitForTimeout(timeout);
        break;
      default: {
        const neverCondition: never = input.condition;
        throw new Error(`unsupported_wait_condition:${String(neverCondition)}`);
      }
    }
    return { ok: true, tab_id: input.tab_id, condition: input.condition };
  }

  consoleFor(tab_id: string): BrowserTraceEvent[] {
    return [...(this.consoleEvents.get(tab_id) ?? [])];
  }

  networkFor(tab_id: string): BrowserTraceEvent[] {
    return [...(this.networkEvents.get(tab_id) ?? [])];
  }

  resetForTests(): void {
    this.browser = null;
    this.cdpUrl = null;
    this.nextTabSeq = 0;
    this.pages.clear();
    this.consoleEvents.clear();
    this.networkEvents.clear();
    this.popupOpeners.clear();
    this.teachEventSink = null;
    this.workflowOverlayActionSink = null;
    this.workflowOverlayEnabled = false;
  }

  private async describePage(page: Page): Promise<BrowserTab> {
    const tab_id = this.idForPage(page);
    this.pages.set(tab_id, { page, tab_id });
    await this.instrumentPage(page, tab_id);
    return {
      tab_id,
      url: page.url(),
      title: await page.title().catch(() => undefined),
      active: false,
    };
  }

  private idForPage(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    this.nextTabSeq += 1;
    const id = `chrome_tab_${this.nextTabSeq}`;
    this.pageIds.set(page, id);
    return id;
  }

  private async instrumentPage(page: Page, tab_id: string): Promise<void> {
    if (!this.instrumented.has(page)) {
      this.instrumented.add(page);
      page.on("console", (msg) => {
        const redacted = redactText(msg.text());
        this.pushEvent(this.consoleEvents, tab_id, {
          kind: "console",
          url: page.url(),
          value: redacted.text,
          redacted: redacted.redacted,
          detail: { level: msg.type() },
        });
      });
      page.on("request", (request) => {
        const redacted = redactUrl(request.url());
        this.pushEvent(this.networkEvents, tab_id, {
          kind: "network",
          url: redacted.url,
          redacted: redacted.redacted,
          detail: { method: request.method(), resource_type: request.resourceType() },
        });
      });
      page.on("dialog", () => {
        // Keep this adapter from auto-dismissing user/runtime-owned dialogs.
      });
      page.on("popup", (popup) => {
        void this.handlePopup(page, popup, tab_id);
      });
      page.on("download", (download) => {
        let origin: string;
        try {
          origin = normalizeOrigin(page.url()).origin;
        } catch {
          return;
        }
        const redactedUrl = redactUrl(download.url());
        const suggested = redactText(download.suggestedFilename());
        const detail: Record<string, unknown> = {
          download_event: true,
          download_url: redactedUrl.url,
          suggested_filename: suggested.text,
          download_url_redacted: redactedUrl.redacted,
          suggested_filename_redacted: suggested.redacted,
        };
        setTimeout(() => {
          this.teachEventAnnotationSink?.({
            tab_id,
            url: page.url(),
            origin,
            actions: ["click", "dblclick"],
            detail,
            within_ms: 5000,
          });
        }, 250);
      });
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (!/^https?:\/\//i.test(url)) return;
        let origin: string;
        try {
          origin = normalizeOrigin(url).origin;
        } catch {
          return;
        }
        this.teachEventSink?.({
          tab_id,
          url,
          origin,
          action: "navigate",
          detail: {
            event_source: "page_lifecycle",
            navigation_event: true,
            ...popupNavigationDetail(this.popupOpeners.get(tab_id), tab_id),
          },
        });
      });
      await this.installTeachCapture(page, tab_id);
    }
    if (this.workflowOverlayEnabled && !this.workflowOverlayInstalled.has(page)) {
      this.workflowOverlayInstalled.add(page);
      await this.installWorkflowOverlay(page, tab_id);
    }
  }

  private async handlePopup(opener: Page, popup: Page, opener_tab_id: string): Promise<void> {
    const popup_tab_id = this.idForPage(popup);
    this.pages.set(popup_tab_id, { page: popup, tab_id: popup_tab_id });
    let origin: string;
    try {
      origin = normalizeOrigin(opener.url()).origin;
    } catch {
      return;
    }
    this.popupOpeners.set(popup_tab_id, { opener_tab_id, opener_origin: origin });
    await this.instrumentPage(popup, popup_tab_id).catch(() => undefined);
    await popup.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    const popupUrl = redactUrl(popup.url());
    const popupTitle = redactText(await popup.title().catch(() => ""));
    const detail: Record<string, unknown> = {
      popup_event: true,
      popup_url: popupUrl.url,
      popup_url_redacted: popupUrl.redacted,
      popup_title: popupTitle.text,
      popup_title_redacted: popupTitle.redacted,
      popup_tab_id,
      opener_tab_id,
    };
    setTimeout(() => {
      this.teachEventAnnotationSink?.({
        tab_id: opener_tab_id,
        url: opener.url(),
        origin,
        actions: ["click", "dblclick", "press"],
        detail,
        within_ms: 5000,
      });
    }, 250);
  }

  private pushEvent(
    map: Map<string, BrowserTraceEvent[]>,
    tab_id: string,
    input: Pick<BrowserTraceEvent, "kind" | "url"> & Partial<BrowserTraceEvent>
  ): void {
    let origin = "";
    try {
      origin = normalizeOrigin(input.url).origin;
    } catch {
      origin = "unknown";
    }
    const events = map.get(tab_id) ?? [];
    events.push({
      event_id: `browser_runtime_${Date.now()}_${events.length + 1}`,
      trace_id: "browser_runtime",
      trace_version: 0,
      event_seq: events.length + 1,
      ts: Date.now(),
      tab_id,
      origin,
      url: input.url,
      kind: input.kind,
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.redacted !== undefined ? { redacted: input.redacted } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    });
    while (events.length > 500) events.shift();
    map.set(tab_id, events);
  }

  private resolveLocator(page: Page, selector: string | undefined): Locator {
    return this.resolveLocatorFromRoot(page, selector);
  }

  private resolveLocatorForEvent(page: Page, event: BrowserTraceEvent, selector: string | undefined): Locator {
    const frameLocator = stringOpt(event.detail?.["frame_locator"]);
    if (!frameLocator) return this.resolveLocator(page, selector);
    return this.resolveLocatorFromRoot(page.frameLocator(frameLocator), selector);
  }

  private resolveLocatorFromRoot(root: Page | FrameLocator, selector: string | undefined): Locator {
    if (!selector || selector.trim().length === 0) throw new Error("missing_selector");
    const trimmed = selector.trim();
    const role = parseRoleLocator(trimmed);
    if (role) return root.getByRole(role.role as Parameters<Page["getByRole"]>[0], { name: role.name });
    const oneArg = parseOneArgLocator(trimmed);
    if (oneArg) {
      switch (oneArg.kind) {
        case "label":
          return root.getByLabel(oneArg.value);
        case "placeholder":
          return root.getByPlaceholder(oneArg.value);
        case "test_id":
          return root.getByTestId(oneArg.value);
        case "text":
          return root.getByText(oneArg.value);
        case "locator":
          return root.locator(oneArg.value);
      }
    }
    return root.locator(trimmed);
  }

  private async scrollLocator(target: Locator, value: string | undefined): Promise<void> {
    const position = parseScrollPosition(value);
    await target.evaluate((element, targetPosition) => {
      if (element === document.body || element === document.documentElement) {
        window.scrollTo(targetPosition.left, targetPosition.top);
        return;
      }
      element.scrollTo(targetPosition.left, targetPosition.top);
    }, position);
  }

  private async installTeachCapture(page: Page, tab_id: string): Promise<void> {
    const bindingName = "__synthiRecordHumanAction";
    const annotationBindingName = "__synthiAnnotateHumanAction";
    await page.exposeBinding(bindingName, async (source, payload: unknown) => {
      const event = normalizeCapturedHumanAction(
        this.enrichCapturedPayloadWithTabContext(tab_id, await this.enrichCapturedPayloadWithFrame(page, source.frame, payload)),
        tab_id
      );
      if (!event) return;
      this.teachEventSink?.(event);
    }).catch(() => undefined);
    await page.exposeBinding(annotationBindingName, (_source, payload: unknown) => {
      const event = normalizeCapturedHumanActionAnnotation(
        this.enrichCapturedPayloadWithTabContext(tab_id, payload),
        tab_id
      );
      if (!event) return;
      this.teachEventAnnotationSink?.(event);
    }).catch(() => undefined);
    const script = teachCaptureInitScript(bindingName, annotationBindingName);
    await page.addInitScript(script).catch(() => undefined);
    await Promise.all(page.frames().map((frame) => frame.evaluate(script).catch(() => undefined)));
  }

  private enrichCapturedPayloadWithTabContext(tab_id: string, payload: unknown): unknown {
    const popup = this.popupOpeners.get(tab_id);
    if (!popup || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const raw = payload as Record<string, unknown>;
    const detail = recordOpt(raw["detail"]) ?? {};
    return {
      ...raw,
      detail: {
        ...detail,
        popup_context: true,
        popup_tab_id: tab_id,
        opener_tab_id: popup.opener_tab_id,
        opener_origin: popup.opener_origin,
      },
    };
  }

  private async enrichCapturedPayloadWithFrame(page: Page, frame: Frame | undefined, payload: unknown): Promise<unknown> {
    if (!frame || frame === page.mainFrame()) return payload;
    const metadata = await frameLocatorMetadataForFrame(page, frame);
    return metadata ? enrichCapturedFramePayload(payload, metadata, page.url()) : payload;
  }

  private async installWorkflowOverlay(page: Page, tab_id: string): Promise<void> {
    const bindingName = `__synthiWorkflowOverlayAction_${tab_id.replace(/[^a-zA-Z0-9_]/g, "_")}_${Date.now().toString(36)}`;
    await page.exposeBinding(bindingName, async (_source, payload: unknown) => {
      const request = workflowOverlayRequestOpt(payload);
      if (!request) return { ok: false, status: "error", error: "invalid_overlay_action" };
      if (!this.workflowOverlayActionSink) return { ok: false, status: "error", error: "workflow_overlay_unavailable" };
      try {
        return await this.workflowOverlayActionSink({
          ...request,
          tab_id,
          page_url: page.url(),
        });
      } catch (err) {
        return {
          ok: false,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }).catch(() => undefined);
    const script = workflowOverlayInitScript(bindingName, workflowOverlayBridgeUrl(), workflowOverlayBridgeToken());
    await page.addInitScript(script).catch(() => undefined);
    await page.evaluate(script).catch(() => undefined);
  }

  private requireBrowser(): Browser {
    if (!this.browser) throw new Error("browser_not_attached");
    return this.browser;
  }

  private requirePage(tab_id: string): Page {
    const page = this.pages.get(tab_id)?.page;
    if (!page || page.isClosed()) throw new Error("tab_not_found");
    return page;
  }
}

export function normalizeCapturedHumanAction(payload: unknown, tab_id: string): CapturedBrowserHumanAction | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const url = stringOpt(raw["url"]);
  const origin = stringOpt(raw["origin"]);
  const action = browserActionOpt(raw["action"]);
  if (!url || !origin || !action) return null;
  const event: CapturedBrowserHumanAction = {
    tab_id,
    url,
    origin,
    action,
    detail: {
      capture_source: "hosted_browser_dom",
      ...(recordOpt(raw["detail"]) ?? {}),
    },
  };
  const value = stringOpt(raw["value"]);
  if (value !== undefined) event.value = value;
  const fieldName = stringOpt(raw["field_name"]);
  if (fieldName !== undefined) event.field_name = fieldName;
  const frameId = stringOpt(raw["frame_id"]);
  if (frameId !== undefined) event.frame_id = frameId;
  const element = elementOpt(raw["element"]);
  if (element !== undefined) event.element = element;
  const bbox = bboxOpt(raw["bbox"]);
  if (bbox !== undefined) event.bbox = bbox;
  return event;
}

async function frameLocatorMetadataForFrame(page: Page, frame: Frame): Promise<FrameLocatorMetadata | null> {
  if (frame === page.mainFrame()) return null;
  const handle = await frame.frameElement().catch(() => null);
  if (!handle) return null;
  try {
    const descriptor = await handle.evaluate((node, frameUrl) => {
      function compact(value: unknown): string {
        return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 240) : "";
      }

      function attr(el: Element, name: string): string {
        return compact(el.getAttribute(name) || "");
      }

      function cssPath(el: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
          const currentNode: Element = node;
          const currentTag = currentNode.tagName;
          const tag = currentTag.toLowerCase();
          let part = tag;
          if (currentNode.id) {
            parts.unshift(`${tag}#${CSS.escape(currentNode.id)}`);
            break;
          }
          const parentElement: Element | null = currentNode.parentElement;
          if (parentElement) {
            const siblings = Array.prototype.slice.call(parentElement.children).filter((child: Element) => child.tagName === currentTag);
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(currentNode) + 1})`;
          }
          parts.unshift(part);
          node = parentElement;
        }
        return parts.join(" > ");
      }

      const el = node as Element;
      return {
        tag: el.tagName.toLowerCase(),
        id: attr(el, "id"),
        name: attr(el, "name"),
        title: attr(el, "title"),
        aria_label: attr(el, "aria-label"),
        test_id: attr(el, "data-testid"),
        data_test: attr(el, "data-test"),
        src: attr(el, "src"),
        css: cssPath(el),
        frame_url: compact(frameUrl),
      };
    }, frame.url());
    return frameLocatorMetadataFromElementDescriptor(descriptor);
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

export function frameLocatorMetadataFromElementDescriptor(descriptor: FrameElementDescriptor): FrameLocatorMetadata | null {
  const tag = descriptor.tag === "frame" ? "frame" : "iframe";
  const candidates = [
    attrSelector(tag, "data-testid", descriptor.test_id),
    attrSelector(tag, "data-test", descriptor.data_test),
    attrSelector(tag, "name", descriptor.name),
    attrSelector(tag, "title", descriptor.title),
    attrSelector(tag, "aria-label", descriptor.aria_label),
    descriptor.id ? `${tag}#${cssIdentifier(descriptor.id)}` : "",
    srcSelector(tag, descriptor.src),
    descriptor.css,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  const uniqueCandidates = [...new Set(candidates)];
  const frameLocator = uniqueCandidates[0];
  if (!frameLocator) return null;
  const frameId = [
    descriptor.name,
    descriptor.title,
    descriptor.test_id,
    descriptor.data_test,
    descriptor.id,
    descriptor.src,
    descriptor.frame_url,
    frameLocator,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  return {
    frame_id: String(frameId ?? frameLocator),
    frame_locator: frameLocator,
    frame_locator_candidates: uniqueCandidates,
    ...(descriptor.frame_url ? { frame_url: descriptor.frame_url } : {}),
  };
}

export function enrichCapturedFramePayload(payload: unknown, metadata: FrameLocatorMetadata, pageUrl: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const raw = payload as Record<string, unknown>;
  const detail = recordOpt(raw["detail"]) ?? {};
  const frameUrl = stringOpt(detail["frame_url"]) ?? metadata.frame_url ?? stringOpt(raw["url"]);
  let pageOrigin = stringOpt(raw["origin"]);
  let frameOrigin: string | undefined;
  try {
    pageOrigin = normalizeOrigin(pageUrl).origin;
  } catch {
    // Keep the frame-provided origin if the top-level page URL is not a normal web URL.
  }
  try {
    if (frameUrl) frameOrigin = normalizeOrigin(frameUrl).origin;
  } catch {
    frameOrigin = undefined;
  }
  return {
    ...raw,
    url: pageUrl,
    ...(pageOrigin ? { origin: pageOrigin } : {}),
    frame_id: stringOpt(raw["frame_id"]) ?? metadata.frame_id,
    detail: {
      ...detail,
      frame_locator: stringOpt(detail["frame_locator"]) ?? metadata.frame_locator,
      frame_locator_candidates: Array.isArray(detail["frame_locator_candidates"])
        ? detail["frame_locator_candidates"]
        : metadata.frame_locator_candidates,
      ...(frameUrl ? { frame_url: frameUrl } : {}),
      ...(frameOrigin ? { frame_origin: frameOrigin } : {}),
    },
  };
}

function attrSelector(tag: string, attrName: string, value: unknown): string {
  const text = stringOpt(value);
  return text ? `${tag}[${attrName}="${cssAttributeValue(text)}"]` : "";
}

function srcSelector(tag: string, value: unknown): string {
  const text = stringOpt(value);
  if (!text || /^about:/i.test(text)) return "";
  return `${tag}[src="${cssAttributeValue(text)}"]`;
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function cssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0)?.toString(16)} `);
}

function isDownloadReplayEvent(event: BrowserTraceEvent): boolean {
  return event.detail?.["download_event"] === true;
}

function isDialogReplayEvent(event: BrowserTraceEvent): boolean {
  return event.detail?.["dialog_event"] === true;
}

function isPopupReplayEvent(event: BrowserTraceEvent): boolean {
  return event.detail?.["popup_event"] === true;
}

function popupNavigationDetail(
  popup: { opener_tab_id: string; opener_origin: string } | undefined,
  tab_id: string
): Record<string, unknown> {
  if (!popup) return {};
  return {
    popup_context: true,
    popup_tab_id: tab_id,
    opener_tab_id: popup.opener_tab_id,
    opener_origin: popup.opener_origin,
  };
}

async function runTargetAction(
  target: Locator,
  action: "click" | "dblclick" | "press",
  value?: string
): Promise<void> {
  if (action === "dblclick") {
    await target.dblclick();
  } else if (action === "press") {
    await target.press(value ?? "Enter");
  } else {
    await target.click();
  }
}

async function setRangeLocatorValue(target: Locator, value: string): Promise<void> {
  await target.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "range") {
      throw new Error("target_not_range_input");
    }
    element.value = String(nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function selectOptionsFromValue(value: string | undefined): string | string[] {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Plain single-select values are not JSON.
  }
  return value;
}

function stringDetail(event: BrowserTraceEvent, key: string): string | undefined {
  const value = event.detail?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function boolDetail(event: BrowserTraceEvent, key: string): boolean {
  return event.detail?.[key] === true;
}

function isRangeControlEvent(event: BrowserTraceEvent): boolean {
  if (event.detail?.["control_kind"] === "range" || event.detail?.["range_control"] === true) return true;
  const element = event.detail?.["element"];
  return Boolean(
    element &&
    typeof element === "object" &&
    !Array.isArray(element) &&
    String((element as { tag?: unknown }).tag ?? "").toLowerCase() === "input" &&
    String((element as { type?: unknown }).type ?? "").toLowerCase() === "range"
  );
}

function isKeyboardEditorFillEvent(event: BrowserTraceEvent): boolean {
  if (event.detail?.["editor_replay_strategy"] === "keyboardInsert") return true;
  const element = event.detail?.["element"];
  return Boolean(
    element &&
    typeof element === "object" &&
    !Array.isArray(element) &&
    (element as { editor_replay_strategy?: unknown }).editor_replay_strategy === "keyboardInsert"
  );
}

function isCalibratedPointerDragEvent(event: BrowserTraceEvent): boolean {
  if (event.action !== "drag") return false;
  const dragClass = String(event.detail?.["drag_class"] ?? event.detail?.["dragClass"] ?? "").toLowerCase();
  if (!/pointersensor|pointerdrag|unknowndrag/.test(dragClass) && event.detail?.["pointer_drag"] !== true) return false;
  if (event.detail?.["pointer_replay"] !== "calibrated" && event.detail?.["pointer_calibrated"] !== true) return false;
  return Boolean(stringDetail(event, "drop_locator") ?? event.value);
}

function numberDetail(event: BrowserTraceEvent, key: string): number | undefined {
  return numberOpt(event.detail?.[key]);
}

function pointFromBox(box: { x: number; y: number; width: number; height: number }, ratios: { xRatio: number; yRatio: number }): { x: number; y: number } {
  return {
    x: box.x + box.width * clampNumber(ratios.xRatio, 0, 1),
    y: box.y + box.height * clampNumber(ratios.yRatio, 0, 1),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

export function normalizeCapturedHumanActionAnnotation(
  payload: unknown,
  tab_id: string
): Parameters<NonNullable<BrowserTeachEventAnnotationSink>>[0] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const url = stringOpt(raw["url"]);
  const origin = stringOpt(raw["origin"]);
  if (!url || !origin) return null;
  const actions = stringArrayOpt(raw["actions"])?.filter((action): action is BrowserActionKind =>
    (BROWSER_ACTION_KINDS as readonly string[]).includes(action)
  );
  const detail = sanitizeAnnotationDetail(recordOpt(raw["detail"]) ?? {});
  return {
    tab_id,
    url,
    origin,
    ...(actions && actions.length > 0 ? { actions } : {}),
    detail,
    within_ms: numberOpt(raw["within_ms"]),
  };
}

function browserActionOpt(value: unknown): BrowserActionKind | undefined {
  return typeof value === "string" && (BROWSER_ACTION_KINDS as readonly string[]).includes(value) ? value as BrowserActionKind : undefined;
}

function workflowOverlayRequestOpt(value: unknown): BrowserWorkflowOverlayRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const action = raw["action"];
  if (action !== "state" && action !== "observe" && action !== "teach" && action !== "stop") return null;
  return {
    action,
    ...(typeof raw["url"] === "string" && raw["url"].trim() ? { url: raw["url"].trim() } : {}),
  };
}

function elementOpt(value: unknown): BrowserElementMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const element: BrowserElementMetadata = {};
  for (const key of [
    "tag",
    "role",
    "name",
    "label",
    "placeholder",
    "test_id",
    "text",
    "id",
    "class_name",
    "css",
    "xpath",
    "type",
    "source_id",
    "listbox_name",
    "editor_language",
    "editor_container_test_id",
    "editor_container_role",
    "editor_container_css",
  ] as const) {
    const found = stringOpt(raw[key]);
    if (found !== undefined) element[key] = found;
  }
  const editorSurface = editorSurfaceOpt(raw["editor_surface"]);
  if (editorSurface) element.editor_surface = editorSurface;
  const editorBacking = editorBackingOpt(raw["editor_backing"]);
  if (editorBacking) element.editor_backing = editorBacking;
  const editorReplayStrategy = editorReplayStrategyOpt(raw["editor_replay_strategy"]);
  if (editorReplayStrategy) element.editor_replay_strategy = editorReplayStrategy;
  if (typeof raw["content_editable"] === "boolean") element.content_editable = raw["content_editable"];
  if (typeof raw["selected"] === "boolean") element.selected = raw["selected"];
  if (typeof raw["listbox_multiselect"] === "boolean") element.listbox_multiselect = raw["listbox_multiselect"];
  const listboxSelectedValues = stringArrayOpt(raw["listbox_selected_values"]);
  if (listboxSelectedValues) element.listbox_selected_values = listboxSelectedValues;
  return Object.keys(element).length ? element : undefined;
}

function bboxOpt(value: unknown): CapturedBrowserHumanAction["bbox"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const x = numberOpt(raw["x"]);
  const y = numberOpt(raw["y"]);
  const w = numberOpt(raw["w"]);
  const h = numberOpt(raw["h"]);
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, w, h } : undefined;
}

function recordOpt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArrayOpt(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sanitizeAnnotationDetail(raw: Record<string, unknown>): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      if (key === "dialog_message" || key === "dialog_default_value") {
        const redacted = redactText(value);
        detail[key] = redacted.text;
        if (redacted.redacted) detail[`${key}_redacted`] = true;
      } else if (key === "dialog_prompt_value") {
        detail[key] = "[REDACTED]";
        detail[`${key}_redacted`] = true;
      } else {
        detail[key] = value;
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      detail[key] = value;
    } else if (key === "observed_effects" && Array.isArray(value)) {
      const effects: string[] = [];
      let redacted = false;
      for (const item of value) {
        if (typeof item !== "string") continue;
        const effect = redactText(item);
        const text = effect.text.trim();
        if (text.length === 0) continue;
        effects.push(text);
        redacted = redacted || effect.redacted;
        if (effects.length >= 6) break;
      }
      if (effects.length > 0) detail[key] = effects;
      if (redacted) detail[`${key}_redacted`] = true;
    }
  }
  return detail;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function editorSurfaceOpt(value: unknown): BrowserElementMetadata["editor_surface"] | undefined {
  return value === "textarea" ||
    value === "contenteditable" ||
    value === "monaco" ||
    value === "codemirror" ||
    value === "unknownCodeEditor"
    ? value
    : undefined;
}

function editorBackingOpt(value: unknown): BrowserElementMetadata["editor_backing"] | undefined {
  return value === "textarea" ||
    value === "contenteditable" ||
    value === "hiddenTextarea" ||
    value === "viewModel" ||
    value === "unknown"
    ? value
    : undefined;
}

function editorReplayStrategyOpt(value: unknown): BrowserElementMetadata["editor_replay_strategy"] | undefined {
  return value === "fill" ||
    value === "focusAndFill" ||
    value === "keyboardInsert" ||
    value === "appBridge"
    ? value
    : undefined;
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseScrollPosition(value: string | undefined): { top: number; left: number } {
  if (!value || value.trim().length === 0) return { top: 0, left: 0 };
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return { top: Math.max(0, Math.round(numeric)), left: 0 };
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const top = numberOpt(raw["top"]) ?? numberOpt(raw["scroll_top"]) ?? 0;
    const left = numberOpt(raw["left"]) ?? numberOpt(raw["scroll_left"]) ?? 0;
    return {
      top: Math.max(0, Math.round(top)),
      left: Math.max(0, Math.round(left)),
    };
  } catch {
    return { top: 0, left: 0 };
  }
}

function teachCaptureInitScript(bindingName: string, annotationBindingName: string): string {
  return `(() => {
    const bindingName = ${JSON.stringify(bindingName)};
    const annotationBindingName = ${JSON.stringify(annotationBindingName)};
    if (window.__SYNTHI_TEACH_CAPTURE_INSTALLED__) return;
    window.__SYNTHI_TEACH_CAPTURE_INSTALLED__ = true;
    const pending = new WeakMap();
    const pendingElements = new Set();
    const scrollPending = new WeakMap();
    const scrollPendingElements = new Set();
    const scrollBeforeEffects = new WeakMap();
    const lastSent = new WeakMap();
    const editableTags = new Set(['input', 'textarea', 'select']);
    const pendingActionSends = new Set();
    let latestDeferredActionBeforeEffects = [];
    let activeDrag = null;
    let activePointerDrag = null;
    let lastPointerDrag = null;

    function isElement(value) {
      return value instanceof Element;
    }

    function text(value) {
      return typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ').slice(0, 160) : '';
    }

    function attr(el, name) {
      return text(el.getAttribute(name) || '');
    }

    function annotateLatest(actions, detail, withinMs) {
      if (!window[annotationBindingName]) return;
      window[annotationBindingName]({
        url: location.href,
        origin: location.origin,
        actions,
        detail,
        within_ms: withinMs || 5000,
      }).catch(() => {});
    }

    function enqueueActionSend(send, beforeEffects) {
      const entry = {
        send,
        beforeEffects: Array.isArray(beforeEffects) ? beforeEffects : [],
        timer: null,
        sent: false,
      };
      entry.timer = setTimeout(() => {
        pendingActionSends.delete(entry);
        entry.timer = null;
        if (entry.sent) return;
        entry.sent = true;
        latestDeferredActionBeforeEffects = entry.beforeEffects;
        entry.send();
      }, 0);
      pendingActionSends.add(entry);
    }

    function flushPendingActionSends() {
      let latestBeforeEffects = null;
      for (const entry of Array.from(pendingActionSends)) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingActionSends.delete(entry);
        if (entry.sent) continue;
        entry.sent = true;
        if (Array.isArray(entry.beforeEffects)) latestBeforeEffects = entry.beforeEffects;
        entry.send();
      }
      if (latestBeforeEffects) latestDeferredActionBeforeEffects = latestBeforeEffects;
      return latestBeforeEffects || latestDeferredActionBeforeEffects;
    }

    function dialogObservedEffects(beforeEffects) {
      const effects = changedEffectTexts(Array.isArray(beforeEffects) ? beforeEffects : []);
      return effects.length > 0 ? { observed_effects: effects } : {};
    }

    function annotateDialogTrigger(detail, beforeEffects) {
      setTimeout(() => {
        annotateLatest(['click', 'dblclick', 'press'], Object.assign({}, detail, dialogObservedEffects(beforeEffects)), 5000);
      }, 0);
    }

    function installDialogCapture() {
      if (window.__SYNTHI_DIALOG_CAPTURE_INSTALLED__) return;
      window.__SYNTHI_DIALOG_CAPTURE_INSTALLED__ = true;
      const nativeAlert = window.alert.bind(window);
      const nativeConfirm = window.confirm.bind(window);
      const nativePrompt = window.prompt.bind(window);
      window.alert = (message) => {
        const beforeEffects = flushPendingActionSends();
        nativeAlert(message);
        annotateDialogTrigger({
          dialog_event: true,
          dialog_type: 'alert',
          dialog_message: text(String(message || '')),
          dialog_accepted: true,
        }, beforeEffects);
      };
      window.confirm = (message) => {
        const beforeEffects = flushPendingActionSends();
        const accepted = nativeConfirm(message);
        annotateDialogTrigger({
          dialog_event: true,
          dialog_type: 'confirm',
          dialog_message: text(String(message || '')),
          dialog_accepted: Boolean(accepted),
        }, beforeEffects);
        return accepted;
      };
      window.prompt = (message, defaultValue) => {
        const beforeEffects = flushPendingActionSends();
        const value = nativePrompt(message, defaultValue);
        annotateDialogTrigger({
          dialog_event: true,
          dialog_type: 'prompt',
          dialog_message: text(String(message || '')),
          dialog_default_value: text(String(defaultValue || '')),
          dialog_accepted: value !== null,
          dialog_prompt_value: value === null ? '' : String(value),
        }, beforeEffects);
        return value;
      };
    }

    installDialogCapture();

    function associatedLabel(el) {
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return text(label.textContent || '');
      }
      const parent = el.closest('label');
      return parent ? text(parent.textContent || '') : '';
    }

    function roleFor(el) {
      const explicit = attr(el, 'role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && attr(el, 'href')) return 'link';
      if (tag === 'select') return el.multiple || Number(attr(el, 'size') || '0') > 1 ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        return 'textbox';
      }
      return '';
    }

    function cssFor(el) {
      if (!isElement(el)) return '';
      const testId = attr(el, 'data-testid') || attr(el, 'data-test');
      if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        const tag = node.tagName.toLowerCase();
        let part = tag;
        if (node.id) {
          parts.unshift('#' + CSS.escape(node.id));
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function xpathFor(el) {
      if (!isElement(el)) return '';
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        const tag = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        parts.unshift(tag + '[' + (siblings.indexOf(node) + 1) + ']');
        node = parent;
      }
      return '/' + parts.join('/');
    }

    function listboxForOption(el) {
      if (!isElement(el) || attr(el, 'role') !== 'option') return null;
      const ownerId = attr(el, 'aria-owns') || attr(el, 'aria-controls');
      if (ownerId) {
        const owned = document.getElementById(ownerId);
        if (owned && attr(owned, 'role') === 'listbox') return owned;
      }
      const listbox = el.closest('[role="listbox"]');
      return isElement(listbox) ? listbox : null;
    }

    function optionValue(el) {
      return attr(el, 'data-value') || attr(el, 'value') || attr(el, 'data-priority') || text(el.textContent || '');
    }

    function selectedOptionValues(listbox) {
      if (!isElement(listbox)) return [];
      return Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]'))
        .map((option) => optionValue(option))
        .filter(Boolean);
    }

    function metadata(el) {
      const tag = el.tagName.toLowerCase();
      const label = associatedLabel(el);
      const placeholder = attr(el, 'placeholder');
      const aria = attr(el, 'aria-label');
      const textContent = text(el.textContent || '');
      const testId = attr(el, 'data-testid') || attr(el, 'data-test');
      const type = attr(el, 'type');
      const editorContainer = editorContainerFor(el);
      const editorSurface = editorSurfaceFor(el, editorContainer);
      const listbox = listboxForOption(el);
      return {
        tag,
        role: roleFor(el),
        name: aria || label || placeholder || textContent,
        label,
        placeholder,
        test_id: testId,
        text: textContent,
        id: attr(el, 'id'),
        class_name: text(el.className || ''),
        css: cssFor(el),
        xpath: xpathFor(el),
        type,
        source_id: attr(el, 'data-synthi-source-id'),
        content_editable: Boolean(el.isContentEditable || attr(el, 'contenteditable')),
        selected: attr(el, 'aria-selected') === 'true' || Boolean(el.selected),
        listbox_name: listbox ? attr(listbox, 'aria-label') || associatedLabel(listbox) || text(listbox.textContent || '') : '',
        listbox_multiselect: listbox ? attr(listbox, 'aria-multiselectable') === 'true' : false,
        listbox_selected_values: listbox ? selectedOptionValues(listbox) : [],
        editor_surface: editorSurface,
        editor_backing: editorBackingFor(el, editorSurface),
        editor_language: editorLanguageFor(el, editorContainer),
        editor_replay_strategy: editorReplayStrategyFor(editorSurface),
        editor_container_test_id: editorContainer ? attr(editorContainer, 'data-testid') || attr(editorContainer, 'data-test') : '',
        editor_container_role: editorContainer ? roleFor(editorContainer) : '',
        editor_container_css: editorContainer ? cssFor(editorContainer) : '',
      };
    }

    function editorContainerFor(el) {
      if (!isElement(el)) return null;
      return el.closest('[data-synthi-editor], [data-editor-root], [data-language], .cm-editor, .CodeMirror, .monaco-editor, .code-editor');
    }

    function editorSurfaceFor(el, container) {
      const tag = el.tagName.toLowerCase();
      const classes = ((container && container.className) || el.className || '').toString().toLowerCase();
      if (classes.includes('monaco-editor')) return 'monaco';
      if (classes.includes('cm-editor') || classes.includes('codemirror')) return 'codemirror';
      if (tag === 'textarea' && isCodeEditorLike(el, container)) return 'textarea';
      if ((el.isContentEditable || attr(el, 'contenteditable')) && isCodeEditorLike(el, container)) return 'contenteditable';
      if (container && attr(container, 'data-synthi-editor')) return 'unknownCodeEditor';
      return '';
    }

    function isCodeEditorLike(el, container) {
      return Boolean(
        attr(el, 'data-language') ||
        attr(el, 'data-editor-language') ||
        attr(el, 'data-synthi-editor') ||
        (container && (
          attr(container, 'data-language') ||
          attr(container, 'data-editor-language') ||
          attr(container, 'data-synthi-editor')
        ))
      );
    }

    function editorBackingFor(el, surface) {
      const tag = el.tagName.toLowerCase();
      if (surface === 'textarea') return 'textarea';
      if (surface === 'contenteditable') return 'contenteditable';
      if ((surface === 'monaco' || surface === 'codemirror') && tag === 'textarea') {
        const style = window.getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true'
          ? 'hiddenTextarea'
          : 'textarea';
      }
      if (surface === 'monaco' || surface === 'codemirror') return 'viewModel';
      return '';
    }

    function editorLanguageFor(el, container) {
      return attr(el, 'data-language') ||
        attr(el, 'data-editor-language') ||
        (container ? attr(container, 'data-language') || attr(container, 'data-editor-language') : '');
    }

    function editorReplayStrategyFor(surface) {
      if (surface === 'textarea' || surface === 'contenteditable') return 'fill';
      if (surface === 'monaco' || surface === 'codemirror') return 'keyboardInsert';
      if (surface === 'unknownCodeEditor') return 'keyboardInsert';
      return '';
    }

    function editorReplayElementFor(el, action) {
      if (action !== 'fill') return el;
      const container = editorContainerFor(el);
      if (!container) return el;
      const surface = editorSurfaceFor(el, container);
      const strategy = editorReplayStrategyFor(surface);
      return strategy === 'keyboardInsert' ? container : el;
    }

    function editorDetailFor(sourceEl, targetEl) {
      const container = editorContainerFor(sourceEl) || editorContainerFor(targetEl);
      const surface = editorSurfaceFor(targetEl, container) || editorSurfaceFor(sourceEl, container);
      if (!surface) return {};
      const value = editableValue(sourceEl);
      return {
        editor_surface: surface,
        editor_backing: editorBackingFor(sourceEl, surface),
        editor_language: editorLanguageFor(sourceEl, container),
        editor_replay_strategy: editorReplayStrategyFor(surface),
        editor_value_length: value.length,
        editor_line_count: value.length ? value.split(/\\r\\n|\\r|\\n/).length : 0,
        editor_container_test_id: container ? attr(container, 'data-testid') || attr(container, 'data-test') : '',
        editor_container_role: container ? roleFor(container) : '',
        editor_container_css: container ? cssFor(container) : '',
      };
    }

    function bbox(el) {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    }

    function pointerReplayRect(el) {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    function pointRatio(rect, clientX, clientY) {
      return {
        x: rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.x) / rect.width)) : 0.5,
        y: rect.height > 0 ? Math.max(0, Math.min(1, (clientY - rect.y) / rect.height)) : 0.5,
      };
    }

    function distanceBetween(leftX, leftY, rightX, rightY) {
      const dx = rightX - leftX;
      const dy = rightY - leftY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function pointerDraggableFor(target) {
      if (!isElement(target)) return null;
      if (target.closest('[data-synthi-workflow-toolbox]')) return null;
      if (isEditableTextTarget(target)) return null;
      const el = target.closest('[data-synthi-pointer-drag], [data-pointer-drag], [data-draggable]:not([draggable="true"]), [aria-grabbed], [role="option"], [role="listitem"]');
      if (!isElement(el)) return null;
      if (attr(el, 'role') === 'option' && el.closest('[role="listbox"]') && !attr(el, 'data-synthi-pointer-drag') && !attr(el, 'data-pointer-drag') && !attr(el, 'data-draggable') && !attr(el, 'aria-grabbed')) return null;
      if (isEditableTextTarget(el) || isRangeInput(el)) return null;
      return el;
    }

    function pointerDropTargetAt(clientX, clientY) {
      const target = document.elementFromPoint(clientX, clientY);
      if (!isElement(target) || target.closest('[data-synthi-workflow-toolbox]')) return null;
      const dropTarget = target.closest('[data-drop-target], [data-testid], [data-test], [role="list"], [role="group"], [aria-label]') || target;
      return isElement(dropTarget) ? dropTarget : null;
    }

    function shouldSuppressPointerDragClick(target) {
      if (!lastPointerDrag || Date.now() - lastPointerDrag.ts > 700) return false;
      return isElement(target) && (
        target === lastPointerDrag.el ||
        lastPointerDrag.el.contains(target) ||
        target === lastPointerDrag.drop_target ||
        (lastPointerDrag.drop_target && lastPointerDrag.drop_target.contains(target))
      );
    }

    function scrollTargetFor(event) {
      const target = event.target;
      if (target === document || target === window || target === document.body || target === document.documentElement) {
        return document.scrollingElement || document.documentElement;
      }
      if (isElement(target)) return target;
      return document.scrollingElement || document.documentElement;
    }

    function scrollDetail(el) {
      const viewport = el === document.scrollingElement || el === document.documentElement || el === document.body;
      const top = viewport ? window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0 : el.scrollTop || 0;
      const left = viewport ? window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0 : el.scrollLeft || 0;
      return {
        scroll_event: true,
        scroll_top: Math.max(0, Math.round(top)),
        scroll_left: Math.max(0, Math.round(left)),
        viewport_scroll: viewport,
        scroll_height: Math.max(0, Math.round(el.scrollHeight || 0)),
        scroll_width: Math.max(0, Math.round(el.scrollWidth || 0)),
        client_height: Math.max(0, Math.round(el.clientHeight || window.innerHeight || 0)),
        client_width: Math.max(0, Math.round(el.clientWidth || window.innerWidth || 0)),
      };
    }

    function fieldName(el, element) {
      return attr(el, 'name') || element.label || element.placeholder || element.name || element.id || element.test_id || element.tag;
    }

    function visibleEffectTexts() {
      const selectors = ['[aria-live]', 'output', '[role="status"]', '#status', '.status'];
      const seen = new Set();
      const result = [];
      for (const el of document.querySelectorAll(selectors.join(','))) {
        if (!isElement(el) || el.closest('[data-synthi-workflow-toolbox]')) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const value = text(el.textContent || '');
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
        if (result.length >= 5) break;
      }
      return result;
    }

    function changedEffectTexts(before) {
      const previous = new Set(Array.isArray(before) ? before : []);
      return visibleEffectTexts().filter((value) => !previous.has(value));
    }

    function playwrightLocatorFor(el) {
      if (!isElement(el)) return '';
      const element = metadata(el);
      if (element.test_id) return 'page.getByTestId(' + JSON.stringify(element.test_id) + ')';
      if (element.role && element.name) return 'page.getByRole(' + JSON.stringify(element.role) + ', { name: ' + JSON.stringify(element.name) + ' })';
      if (element.label) return 'page.getByLabel(' + JSON.stringify(element.label) + ')';
      if (element.placeholder) return 'page.getByPlaceholder(' + JSON.stringify(element.placeholder) + ')';
      if (element.text) return 'page.getByText(' + JSON.stringify(element.text) + ')';
      if (element.css) return 'page.locator(' + JSON.stringify(element.css) + ')';
      return '';
    }

    function actionForChange(el) {
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      if (tag === 'select') return 'select';
      if (tag === 'input' && type === 'file') return 'drag';
      if (tag === 'input' && type === 'checkbox') return el.checked ? 'check' : 'uncheck';
      if (tag === 'input' && type === 'radio') return 'check';
      return 'fill';
    }

    function isEditableTextTarget(el) {
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      if (el.isContentEditable || attr(el, 'contenteditable')) return true;
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(type);
    }

    function editableValue(el) {
      if (el.isContentEditable || attr(el, 'contenteditable')) return text(el.textContent || '');
      return String(el.value || '');
    }

    function shouldSkipClick(el) {
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      if (isEditableTextTarget(el)) return true;
      if (tag === 'input' && ['checkbox', 'radio'].includes(type)) return true;
      return tag === 'select';
    }

    function keyPressValue(event) {
      if (event.repeat) return '';
      const key = String(event.key || '');
      if (!key) return '';
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return '';
      const modifiers = [];
      if (event.ctrlKey) modifiers.push('Control');
      if (event.metaKey) modifiers.push('Meta');
      if (event.altKey) modifiers.push('Alt');
      if (event.shiftKey) modifiers.push('Shift');
      const normalizedKey = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
      if (modifiers.length === 0 && !['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(normalizedKey)) {
        return '';
      }
      return [...modifiers, normalizedKey].join('+');
    }

    function slug(value) {
      return text(value)
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'file';
    }

    function fileParameterFor(el) {
      const element = metadata(el);
      return slug(fieldName(el, element) || 'file') + '_file';
    }

    function isRangeInput(el) {
      return el && el.tagName && el.tagName.toLowerCase() === 'input' && attr(el, 'type').toLowerCase() === 'range';
    }

    function rangeControlDetail(el) {
      if (!isRangeInput(el)) return {};
      return {
        control_kind: 'range',
        range_control: true,
        min: attr(el, 'min'),
        max: attr(el, 'max'),
        step: attr(el, 'step'),
      };
    }

    function selectedSelectValues(el) {
      if (!el || el.tagName.toLowerCase() !== 'select') return [];
      return Array.from(el.selectedOptions || []).map((option) => String(option.value || ''));
    }

    function selectedSelectLabels(el) {
      if (!el || el.tagName.toLowerCase() !== 'select') return [];
      return Array.from(el.selectedOptions || []).map((option) => text(option.textContent || option.label || option.value || '')).filter(Boolean);
    }

    function selectDetail(el) {
      if (!el || el.tagName.toLowerCase() !== 'select') return {};
      const values = selectedSelectValues(el);
      return {
        select_event: true,
        multiple_select: Boolean(el.multiple),
        select_values: values,
        selected_option_labels: selectedSelectLabels(el),
      };
    }

    function ariaOptionDetail(el) {
      if (!isElement(el) || attr(el, 'role') !== 'option') return {};
      const listbox = listboxForOption(el);
      return {
        option_select_event: true,
        selected: attr(el, 'aria-selected') === 'true',
        option_value: optionValue(el),
        listbox_name: listbox ? attr(listbox, 'aria-label') || associatedLabel(listbox) || text(listbox.textContent || '') : '',
        listbox_multiselect: listbox ? attr(listbox, 'aria-multiselectable') === 'true' : false,
        listbox_selected_values: listbox ? selectedOptionValues(listbox) : [],
      };
    }

    function fileDropDetail(el, extra) {
      const inputFiles = el && el.files && typeof el.files.length === 'number' ? Array.from(el.files) : [];
      const dataTransferFiles = extra && extra.dataTransfer && extra.dataTransfer.files
        ? Array.from(extra.dataTransfer.files)
        : [];
      const files = inputFiles.length > 0 ? inputFiles : dataTransferFiles;
      const mimeTypes = Array.from(new Set(files.map((file) => text(file && file.type ? file.type : '')).filter(Boolean)));
      const safeExtra = Object.assign({}, extra || {});
      delete safeExtra.dataTransfer;
      return Object.assign({
        explicit_intent: true,
        drag_mode: true,
        drag_class: 'fileDrop',
        file_parameter: fileParameterFor(el),
        file_count: files.length,
        file_input: el.tagName.toLowerCase() === 'input' && attr(el, 'type').toLowerCase() === 'file',
      }, mimeTypes.length === 1 ? { mime_type: mimeTypes[0] } : {}, safeExtra);
    }

    function emit(el, action, value, detail) {
      if (!window[bindingName] || !isElement(el)) return;
      if (action !== 'fill') flushPendingEdits();
      if (action !== 'scroll') flushPendingScrolls();
      const replayEl = editorReplayElementFor(el, action);
      const element = metadata(replayEl);
      const rawDetail = Object.assign({}, detail || {});
      const beforeEffects = Array.isArray(rawDetail.__before_effects) ? rawDetail.__before_effects : visibleEffectTexts();
      delete rawDetail.__before_effects;
      const controlDetail = action === 'fill'
        ? Object.assign({}, rangeControlDetail(el), editorDetailFor(el, replayEl))
        : {};
      const payload = {
        url: location.href,
        origin: location.origin,
        action,
        value: typeof value === 'string' ? value : undefined,
        field_name: fieldName(replayEl, element),
        element,
        bbox: bbox(replayEl),
        detail: Object.assign({ event_source: 'dom_listener' }, controlDetail, rawDetail),
      };
      const detailKey = payload.detail && typeof payload.detail.drop_locator === 'string'
        ? payload.detail.drop_locator
        : action === 'scroll'
          ? String(payload.detail.scroll_top || 0) + '|' + String(payload.detail.scroll_left || 0)
          : '';
      const signature = action + '|' + (payload.value || '') + '|' + detailKey + '|' + location.href;
      const last = lastSent.get(el);
      const now = Date.now();
      if (last && last.signature === signature && now - last.ts < 300) return;
      const send = () => {
        if (action === 'click') Object.assign(payload.detail, ariaOptionDetail(replayEl));
        const effects = changedEffectTexts(beforeEffects);
        if (effects.length > 0) payload.detail.observed_effects = effects;
        lastSent.set(el, { signature, ts: Date.now() });
        window[bindingName](payload).catch(() => {});
      };
      if (['click', 'dblclick', 'contextmenu', 'press', 'drag', 'select', 'check', 'uncheck'].includes(action)) {
        enqueueActionSend(send, beforeEffects);
      } else {
        send();
      }
    }

    function emitScroll(el) {
      const beforeEffects = scrollBeforeEffects.get(el) || visibleEffectTexts();
      scrollBeforeEffects.delete(el);
      emit(el, 'scroll', undefined, Object.assign(scrollDetail(el), { __before_effects: beforeEffects }));
    }

    function flushPendingScrolls() {
      for (const el of Array.from(scrollPendingElements)) {
        const timer = scrollPending.get(el);
        if (timer) clearTimeout(timer);
        scrollPending.delete(el);
        scrollPendingElements.delete(el);
        if (isElement(el)) emitScroll(el);
      }
    }

    function clearPending(el) {
      const timer = pending.get(el);
      if (timer) clearTimeout(timer);
      pending.delete(el);
      pendingElements.delete(el);
    }

    function flushPendingEdits() {
      for (const el of Array.from(pendingElements)) {
        const timer = pending.get(el);
        if (timer) clearTimeout(timer);
        pending.delete(el);
        pendingElements.delete(el);
        if (isElement(el)) emit(el, 'fill', editableValue(el), { input_debounced: true });
      }
    }

    document.addEventListener('input', (event) => {
      const el = event.target;
      if (!isElement(el) || (!editableTags.has(el.tagName.toLowerCase()) && !el.isContentEditable && !attr(el, 'contenteditable'))) return;
      if (!isEditableTextTarget(el)) return;
      clearPending(el);
      pendingElements.add(el);
      pending.set(el, setTimeout(() => {
        pending.delete(el);
        pendingElements.delete(el);
        emit(el, 'fill', editableValue(el), { input_debounced: true });
      }, 300));
    }, true);

    document.addEventListener('change', (event) => {
      const el = event.target;
      if (!isElement(el) || !editableTags.has(el.tagName.toLowerCase())) return;
      clearPending(el);
      const action = actionForChange(el);
      if (action === 'drag') {
        emit(el, 'drag', undefined, fileDropDetail(el, { change_event: true }));
        return;
      }
      const value = action === 'check' || action === 'uncheck'
        ? String(Boolean(el.checked))
        : action === 'select' && el.multiple
          ? JSON.stringify(selectedSelectValues(el))
          : String(el.value || '');
      emit(el, action, value, Object.assign({ change_event: true }, action === 'select' ? selectDetail(el) : {}));
    }, true);

    document.addEventListener('scroll', (event) => {
      const el = scrollTargetFor(event);
      if (!isElement(el)) return;
      if (el.closest('[data-synthi-workflow-toolbox]')) return;
      const previous = scrollPending.get(el);
      if (previous) clearTimeout(previous);
      if (!scrollPendingElements.has(el)) scrollBeforeEffects.set(el, visibleEffectTexts());
      scrollPendingElements.add(el);
      scrollPending.set(el, setTimeout(() => {
        scrollPending.delete(el);
        scrollPendingElements.delete(el);
        emitScroll(el);
      }, 200));
    }, true);

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const key = keyPressValue(event);
      if (!key) return;
      const el = target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="textbox"], [role="option"], [role="listbox"], [role="application"], [data-testid], [data-test], main, body');
      if (!isElement(el)) return;
      emit(el, 'press', key, {
        key_event: true,
        key_value: String(event.key || ''),
        modifier_keys: {
          alt: Boolean(event.altKey),
          control: Boolean(event.ctrlKey),
          meta: Boolean(event.metaKey),
          shift: Boolean(event.shiftKey),
        },
      });
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      if (shouldSuppressPointerDragClick(target)) return;
      const el = target.closest('button, a, input, [role="button"], [role="link"], [role="option"], [aria-selected], [data-testid], [data-test]');
      if (!isElement(el) || shouldSkipClick(el)) return;
      emit(el, 'click', undefined, Object.assign({ click_event: true }, ariaOptionDetail(el)));
    }, true);

    document.addEventListener('dblclick', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const el = target.closest('button, a, input, [role="button"], [role="link"], [data-testid], [data-test]');
      if (!isElement(el) || shouldSkipClick(el)) return;
      emit(el, 'dblclick', undefined, { dblclick_event: true, suppresses_previous_click: true });
    }, true);

    document.addEventListener('contextmenu', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const el = target.closest('button, a, input, [role="button"], [role="link"], [role="menuitem"], [data-testid], [data-test]');
      if (!isElement(el) || shouldSkipClick(el)) return;
      emit(el, 'contextmenu', undefined, { contextmenu_event: true });
    }, true);

    document.addEventListener('pointerover', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      if (!event.altKey) return;
      const el = target.closest('button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [data-testid], [data-test]');
      if (!isElement(el)) return;
      emit(el, 'hover', undefined, {
        hover_event: true,
        explicit_intent: true,
        alt_option_intent: true,
        modifier_key: 'Alt',
      });
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const el = pointerDraggableFor(event.target);
      if (!el) return;
      activePointerDrag = {
        el,
        pointer_id: event.pointerId,
        started_at: Date.now(),
        start_x: event.clientX,
        start_y: event.clientY,
        last_x: event.clientX,
        last_y: event.clientY,
        source_rect: pointerReplayRect(el),
        source_locator: playwrightLocatorFor(el),
        before_effects: visibleEffectTexts(),
      };
    }, true);

    document.addEventListener('pointermove', (event) => {
      if (!activePointerDrag || activePointerDrag.pointer_id !== event.pointerId) return;
      activePointerDrag.last_x = event.clientX;
      activePointerDrag.last_y = event.clientY;
    }, true);

    document.addEventListener('pointerup', (event) => {
      if (!activePointerDrag || activePointerDrag.pointer_id !== event.pointerId) return;
      const drag = activePointerDrag;
      activePointerDrag = null;
      if (!isElement(drag.el)) return;
      const distance = distanceBetween(drag.start_x, drag.start_y, event.clientX, event.clientY);
      if (distance < 8) return;
      const dropTarget = pointerDropTargetAt(event.clientX, event.clientY);
      if (!dropTarget || dropTarget === drag.el || drag.el.contains(dropTarget)) return;
      const dropLocator = playwrightLocatorFor(dropTarget);
      if (!dropLocator) return;
      const startRatio = pointRatio(drag.source_rect, drag.start_x, drag.start_y);
      const dropRect = pointerReplayRect(dropTarget);
      const endRatio = pointRatio(dropRect, event.clientX, event.clientY);
      lastPointerDrag = { el: drag.el, drop_target: dropTarget, ts: Date.now() };
      emit(drag.el, 'drag', dropLocator, {
        explicit_intent: true,
        drag_mode: true,
        drag_class: 'pointerSensor',
        pointer_drag: true,
        pointer_replay: 'calibrated',
        pointer_calibrated: true,
        pointer_start_x_ratio: startRatio.x,
        pointer_start_y_ratio: startRatio.y,
        pointer_end_x_ratio: endRatio.x,
        pointer_end_y_ratio: endRatio.y,
        pointer_steps: 12,
        pointer_distance_px: Math.round(distance),
        drag_event: true,
        source_locator: drag.source_locator,
        drop_locator: dropLocator,
        drop_element: metadata(dropTarget),
        drag_duration_ms: Math.max(0, Date.now() - drag.started_at),
        __before_effects: drag.before_effects,
      });
    }, true);

    document.addEventListener('pointercancel', (event) => {
      if (activePointerDrag && activePointerDrag.pointer_id === event.pointerId) activePointerDrag = null;
    }, true);

    document.addEventListener('dragstart', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const el = target.closest('[draggable="true"], [data-draggable], [data-testid], [data-test], [role="option"], [role="listitem"]');
      if (!isElement(el)) return;
      activeDrag = {
        el,
        started_at: Date.now(),
        source_locator: playwrightLocatorFor(el),
      };
    }, true);

    document.addEventListener('drop', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const dropTarget = target.closest('[data-drop-target], [data-testid], [data-test], [role="list"], [role="group"], [aria-label]') || target;
      if (!isElement(dropTarget)) return;
      const droppedFiles = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0;
      if (droppedFiles && (!activeDrag || !isElement(activeDrag.el))) {
        emit(dropTarget, 'drag', undefined, fileDropDetail(dropTarget, {
          drop_event: true,
          file_input: false,
          dataTransfer: event.dataTransfer,
        }));
        activeDrag = null;
        return;
      }
      if (!activeDrag || !isElement(activeDrag.el)) return;
      const dropLocator = playwrightLocatorFor(dropTarget);
      emit(activeDrag.el, 'drag', dropLocator || undefined, {
        explicit_intent: true,
        drag_mode: true,
        drag_class: 'nativehtmldnd',
        drag_event: true,
        source_locator: activeDrag.source_locator,
        drop_locator: dropLocator,
        drop_element: metadata(dropTarget),
        drag_duration_ms: Math.max(0, Date.now() - activeDrag.started_at),
      });
      activeDrag = null;
    }, true);

    document.addEventListener('dragend', () => {
      activeDrag = null;
    }, true);
  })();`;
}

function workflowOverlayBridgeUrl(): string {
  const configured = process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL"];
  if (configured && configured.trim()) return configured.replace(/\/$/, "");
  const port = process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT"];
  if (!port || !port.trim()) return "";
  const host = process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST"] || "127.0.0.1";
  return `http://${host}:${port.trim()}`;
}

function workflowOverlayBridgeToken(): string {
  const token = process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"];
  return token && token.trim() ? token.trim() : "";
}

function workflowOverlayInitScript(bindingName: string, bridgeUrl: string, bridgeToken: string): string {
  return `(() => {
    const bindingName = ${JSON.stringify(bindingName)};
    const bridgeUrl = ${JSON.stringify(bridgeUrl)};
    const bridgeToken = ${JSON.stringify(bridgeToken)};
    if (window.__SYNTHI_WORKFLOW_TOOLBOX_INSTALLED__ && window.__SYNTHI_WORKFLOW_TOOLBOX_BINDING__ === bindingName) return;
    const existingHost = document.getElementById('synthi-workflow-toolbox-host');
    if (existingHost) existingHost.remove();
    window.__SYNTHI_WORKFLOW_TOOLBOX_INSTALLED__ = true;
    window.__SYNTHI_WORKFLOW_TOOLBOX_BINDING__ = bindingName;

    function shouldRender() {
      if (!window[bindingName] && !bridgeUrl) return false;
      if (!/^https?:$/.test(location.protocol)) return false;
      if (/^\\/workspace(\\/|$)/.test(location.pathname)) return false;
      return true;
    }

    if (!shouldRender()) return;

    const host = document.createElement('div');
    host.id = 'synthi-workflow-toolbox-host';
    host.setAttribute('data-synthi-workflow-toolbox', 'true');
    host.setAttribute('data-synthi-workflow-status', 'idle');
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'auto';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.box{box-sizing:border-box;display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:8px;min-height:44px;width:min(330px,calc(100vw - 32px));padding:8px;border:1px solid rgba(232,232,226,.16);border-radius:8px;background:rgba(22,22,24,.94);color:rgb(246,246,240);font:12px/1.25 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.34)}',
      '.status{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:6px;min-width:0;padding:0 4px;color:rgba(246,246,240,.78)}',
      '.dot{width:7px;height:7px;border-radius:50%;background:#8a8a82}',
      '.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgb(246,246,240);font-weight:700}',
      '.meta{grid-column:1/-1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(246,246,240,.62);font:11px/1.25 Inter,ui-sans-serif,system-ui,sans-serif}',
      '.box[data-state=observed] .dot{background:#4fbe73}',
      '.box[data-state=recording] .dot{background:#d7a43b;box-shadow:0 0 0 4px rgba(215,164,59,.15)}',
      '.box[data-state=error] .dot{background:#d85f5f}',
      'button{appearance:none;height:28px;border:1px solid rgba(232,232,226,.16);border-radius:6px;background:rgba(255,255,250,.06);color:rgb(246,246,240);padding:0 9px;font:600 12px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}',
      'button:hover:not(:disabled){background:rgba(255,255,250,.11)}',
      'button:focus-visible{outline:2px solid rgba(127,112,176,.9);outline-offset:2px}',
      'button:disabled{opacity:.52;cursor:not-allowed}',
      '.teach[data-recording=true]{background:rgba(215,164,59,.18);border-color:rgba(215,164,59,.38)}',
      '</style>',
      '<div class="box" data-state="idle" data-testid="synthi-workflow-toolbox">',
      '  <div class="status" aria-live="polite"><span class="dot"></span><span class="label">Ready</span></div>',
      '  <button type="button" class="observe" data-testid="synthi-workflow-observe">Observe</button>',
      '  <button type="button" class="teach" data-recording="false" data-testid="synthi-workflow-teach">Teach</button>',
      '  <div class="meta" data-testid="synthi-workflow-meta">0 steps</div>',
      '</div>',
    ].join('');

    const box = root.querySelector('.box');
    const label = root.querySelector('.label');
    const meta = root.querySelector('.meta');
    const observeButton = root.querySelector('.observe');
    const teachButton = root.querySelector('.teach');
    let recording = false;
    let busy = false;

    function setState(next) {
      const status = next && next.status ? String(next.status) : next && next.recording ? 'recording' : next && next.observed ? 'observed' : 'idle';
      recording = Boolean(next && next.recording);
      box.dataset.state = status;
      host.dataset.synthiWorkflowStatus = status;
      host.dataset.synthiWorkflowRecording = recording ? 'true' : 'false';
      const steps = next && Number.isFinite(Number(next.stepCount)) ? Number(next.stepCount) : 0;
      host.dataset.synthiWorkflowSteps = String(steps);
      host.dataset.synthiWorkflowUrl = next && next.url ? String(next.url) : '';
      host.dataset.synthiWorkflowLastAction = next && next.lastAction ? String(next.lastAction) : '';
      host.dataset.synthiWorkflowLastTarget = next && next.lastTarget ? String(next.lastTarget) : '';
      label.textContent = next && next.label ? String(next.label) : recording ? 'Recording' : status === 'observed' ? 'Observed' : status === 'error' ? 'Error' : 'Ready';
      teachButton.textContent = recording ? 'Stop' : 'Teach';
      teachButton.dataset.recording = recording ? 'true' : 'false';
      const urlDetail = shortUrl(next && next.url ? String(next.url) : location.href);
      const last = next && next.lastAction ? String(next.lastAction) + (next.lastTarget ? ' ' + String(next.lastTarget) : '') : '';
      meta.textContent = (steps === 1 ? '1 step' : String(steps) + ' steps') + ' - ' + (last || urlDetail || 'No actions yet');
      host.title = [next && next.detail ? String(next.detail) : '', urlDetail, last].filter(Boolean).join('\\n');
    }

    function shortUrl(value) {
      try {
        const parsed = new URL(value);
        const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
        return parsed.host + path;
      } catch {
        return '';
      }
    }

    async function call(action) {
      if (busy) return;
      busy = true;
      observeButton.disabled = true;
      teachButton.disabled = true;
      try {
        let result;
        if (window[bindingName]) {
          try {
            result = await window[bindingName]({ action, url: location.href });
          } catch (err) {
            if (!bridgeUrl) throw err;
          }
        }
        if (!result && bridgeUrl) {
          const headers = { 'Content-Type': 'application/json' };
          if (bridgeToken) headers['X-Synthi-Workflow-Token'] = bridgeToken;
          const response = await fetch(bridgeUrl + '/browser-workflows/overlay', {
            method: 'POST',
            headers,
            body: JSON.stringify({ action, url: location.href }),
          });
          result = await response.json();
        }
        if (!result) throw new Error('workflow overlay transport unavailable');
        setState(result || {});
      } catch (err) {
        setState({ ok: false, status: 'error', label: 'Error', detail: err && err.message ? err.message : String(err) });
      } finally {
        busy = false;
        observeButton.disabled = false;
        teachButton.disabled = false;
      }
    }

    observeButton.addEventListener('click', () => call('observe'));
    teachButton.addEventListener('click', () => call(recording ? 'stop' : 'teach'));
    call('state');
  })();`;
}

function parseRoleLocator(input: string): { role: string; name: string } | null {
  const m = input.match(/^page\.getByRole\(("(?:\\.|[^"])*"),\s*\{\s*name:\s*("(?:\\.|[^"])*")\s*\}\)$/);
  if (!m?.[1] || !m[2]) return null;
  return { role: JSON.parse(m[1]) as string, name: JSON.parse(m[2]) as string };
}

function parseOneArgLocator(input: string): { kind: "label" | "placeholder" | "test_id" | "text" | "locator"; value: string } | null {
  const specs: Array<[RegExp, "label" | "placeholder" | "test_id" | "text" | "locator"]> = [
    [/^page\.getByLabel\(("(?:\\.|[^"])*")\)$/, "label"],
    [/^page\.getByPlaceholder\(("(?:\\.|[^"])*")\)$/, "placeholder"],
    [/^page\.getByTestId\(("(?:\\.|[^"])*")\)$/, "test_id"],
    [/^page\.getByText\(("(?:\\.|[^"])*")\)$/, "text"],
    [/^page\.locator\(("(?:\\.|[^"])*")\)$/, "locator"],
  ];
  for (const [pattern, kind] of specs) {
    const m = input.match(pattern);
    if (m?.[1]) return { kind, value: JSON.parse(m[1]) as string };
  }
  return null;
}

export const browserPlaywrightAdapter = new BrowserPlaywrightAdapter();

export function resolveCdpConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["SYNTHI_BROWSER_CDP_CONNECT_TIMEOUT_MS"];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), 300_000);
  }
  return 60_000;
}
