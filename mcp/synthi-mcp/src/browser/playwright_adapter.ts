import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { readFile } from "node:fs/promises";
import { normalizeOrigin, redactText, redactUrl } from "./security.js";
import { BROWSER_ACTION_KINDS } from "./types.js";
import type { BrowserActionKind, BrowserElementMetadata, BrowserSnapshot, BrowserTab, BrowserTraceEvent } from "./types.js";

interface PageRecord {
  page: Page;
  tab_id: string;
}

export interface BrowserActionResult {
  ok: true;
  action: BrowserActionKind;
  tab_id: string;
  url: string;
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
  private readonly instrumented = new WeakSet<Page>();
  private readonly workflowOverlayInstalled = new WeakSet<Page>();
  private readonly consoleEvents = new Map<string, BrowserTraceEvent[]>();
  private readonly networkEvents = new Map<string, BrowserTraceEvent[]>();
  private teachEventSink: BrowserTeachEventSink | null = null;
  private workflowOverlayActionSink: BrowserWorkflowOverlayActionSink | null = null;
  private workflowOverlayEnabled = false;

  setTeachEventSink(sink: BrowserTeachEventSink | null): void {
    this.teachEventSink = sink;
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
    switch (action) {
      case "navigate":
        if (!value) throw new Error("missing_url");
        await page.goto(value, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await this.resolveLocator(page, selector).click();
        break;
      case "dblclick":
        await this.resolveLocator(page, selector).dblclick();
        break;
      case "contextmenu":
        await this.resolveLocator(page, selector).click({ button: "right" });
        break;
      case "hover":
        await this.resolveLocator(page, selector).hover();
        break;
      case "drag":
        if (!value) throw new Error("missing_drag_target");
        await this.resolveLocator(page, selector).dragTo(this.resolveLocator(page, value));
        break;
      case "fill":
        await this.resolveLocator(page, selector).fill(value ?? "");
        break;
      case "press":
        await this.resolveLocator(page, selector).press(value ?? "Enter");
        break;
      case "select":
        await this.resolveLocator(page, selector).selectOption(value ?? "");
        break;
      case "check":
        await this.resolveLocator(page, selector).check();
        break;
      case "uncheck":
        await this.resolveLocator(page, selector).uncheck();
        break;
      case "wait":
        await this.resolveLocator(page, selector).waitFor();
        break;
      default: {
        const neverAction: never = action;
        throw new Error(`unsupported_browser_action:${String(neverAction)}`);
      }
    }
    return { ok: true, action, tab_id, url: page.url() };
  }

  async fileDrop(
    tab_id: string,
    selector: string | undefined,
    filePath: string,
    options: { file_input?: boolean; mime_type?: string } = {}
  ): Promise<BrowserActionResult> {
    const page = this.requirePage(tab_id);
    const target = this.resolveLocator(page, selector);
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
          detail: { event_source: "page_lifecycle", navigation_event: true },
        });
      });
      await this.installTeachCapture(page, tab_id);
    }
    if (this.workflowOverlayEnabled && !this.workflowOverlayInstalled.has(page)) {
      this.workflowOverlayInstalled.add(page);
      await this.installWorkflowOverlay(page, tab_id);
    }
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
    if (!selector || selector.trim().length === 0) throw new Error("missing_selector");
    const trimmed = selector.trim();
    const role = parseRoleLocator(trimmed);
    if (role) return page.getByRole(role.role as Parameters<Page["getByRole"]>[0], { name: role.name });
    const oneArg = parseOneArgLocator(trimmed);
    if (oneArg) {
      switch (oneArg.kind) {
        case "label":
          return page.getByLabel(oneArg.value);
        case "placeholder":
          return page.getByPlaceholder(oneArg.value);
        case "test_id":
          return page.getByTestId(oneArg.value);
        case "text":
          return page.getByText(oneArg.value);
        case "locator":
          return page.locator(oneArg.value);
      }
    }
    return page.locator(trimmed);
  }

  private async installTeachCapture(page: Page, tab_id: string): Promise<void> {
    const bindingName = "__synthiRecordHumanAction";
    await page.exposeBinding(bindingName, (_source, payload: unknown) => {
      const event = normalizeCapturedHumanAction(payload, tab_id);
      if (!event) return;
      this.teachEventSink?.(event);
    }).catch(() => undefined);
    const script = teachCaptureInitScript(bindingName);
    await page.addInitScript(script).catch(() => undefined);
    await page.evaluate(script).catch(() => undefined);
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
  for (const key of ["tag", "role", "name", "label", "placeholder", "test_id", "text", "id", "class_name", "css", "xpath", "type", "source_id"] as const) {
    const found = stringOpt(raw[key]);
    if (found !== undefined) element[key] = found;
  }
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

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function teachCaptureInitScript(bindingName: string): string {
  return `(() => {
    const bindingName = ${JSON.stringify(bindingName)};
    if (window.__SYNTHI_TEACH_CAPTURE_INSTALLED__) return;
    window.__SYNTHI_TEACH_CAPTURE_INSTALLED__ = true;
    const pending = new WeakMap();
    const lastSent = new WeakMap();
    const editableTags = new Set(['input', 'textarea', 'select']);
    let activeDrag = null;

    function isElement(value) {
      return value instanceof Element;
    }

    function text(value) {
      return typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ').slice(0, 160) : '';
    }

    function attr(el, name) {
      return text(el.getAttribute(name) || '');
    }

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
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
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

    function metadata(el) {
      const tag = el.tagName.toLowerCase();
      const label = associatedLabel(el);
      const placeholder = attr(el, 'placeholder');
      const aria = attr(el, 'aria-label');
      const textContent = text(el.textContent || '');
      const testId = attr(el, 'data-testid') || attr(el, 'data-test');
      const type = attr(el, 'type');
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
      };
    }

    function bbox(el) {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
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
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(type);
    }

    function shouldSkipClick(el) {
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      if (isEditableTextTarget(el)) return true;
      if (tag === 'input' && ['checkbox', 'radio'].includes(type)) return true;
      return tag === 'select';
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
      const element = metadata(el);
      const beforeEffects = visibleEffectTexts();
      const payload = {
        url: location.href,
        origin: location.origin,
        action,
        value: typeof value === 'string' ? value : undefined,
        field_name: fieldName(el, element),
        element,
        bbox: bbox(el),
        detail: Object.assign({ event_source: 'dom_listener' }, detail || {}),
      };
      const detailKey = payload.detail && typeof payload.detail.drop_locator === 'string' ? payload.detail.drop_locator : '';
      const signature = action + '|' + (payload.value || '') + '|' + detailKey + '|' + location.href;
      const last = lastSent.get(el);
      const now = Date.now();
      if (last && last.signature === signature && now - last.ts < 300) return;
      const send = () => {
        const effects = changedEffectTexts(beforeEffects);
        if (effects.length > 0) payload.detail.observed_effects = effects;
        lastSent.set(el, { signature, ts: Date.now() });
        window[bindingName](payload).catch(() => {});
      };
      if (['click', 'dblclick', 'contextmenu', 'press', 'drag', 'select', 'check', 'uncheck'].includes(action)) {
        setTimeout(send, 0);
      } else {
        send();
      }
    }

    function clearPending(el) {
      const timer = pending.get(el);
      if (timer) clearTimeout(timer);
      pending.delete(el);
    }

    document.addEventListener('input', (event) => {
      const el = event.target;
      if (!isElement(el) || !editableTags.has(el.tagName.toLowerCase())) return;
      if (!isEditableTextTarget(el)) return;
      clearPending(el);
      pending.set(el, setTimeout(() => {
        pending.delete(el);
        emit(el, 'fill', String(el.value || ''), { input_debounced: true });
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
      const value = action === 'check' || action === 'uncheck' ? String(Boolean(el.checked)) : String(el.value || '');
      emit(el, action, value, { change_event: true });
    }, true);

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const key = String(event.key || '');
      if (!['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
      const el = target.closest('input, textarea, select, button, a, [role="button"], [role="textbox"], [data-testid], [data-test]');
      if (!isElement(el)) return;
      emit(el, 'press', key, { key_event: true });
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (target.closest('[data-synthi-workflow-toolbox]')) return;
      const el = target.closest('button, a, input, [role="button"], [role="link"], [data-testid], [data-test]');
      if (!isElement(el) || shouldSkipClick(el)) return;
      emit(el, 'click', undefined, { click_event: true });
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
