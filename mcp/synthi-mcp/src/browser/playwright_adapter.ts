import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { normalizeOrigin, redactText, redactUrl } from "./security.js";
import type { BrowserActionKind, BrowserSnapshot, BrowserTab, BrowserTraceEvent } from "./types.js";

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

export class BrowserPlaywrightAdapter {
  private browser: Browser | null = null;
  private cdpUrl: string | null = null;
  private nextTabSeq = 0;
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly pages = new Map<string, PageRecord>();
  private readonly instrumented = new WeakSet<Page>();
  private readonly consoleEvents = new Map<string, BrowserTraceEvent[]>();
  private readonly networkEvents = new Map<string, BrowserTraceEvent[]>();

  async attach(cdpUrl: string): Promise<BrowserTab[]> {
    if (!this.browser || this.cdpUrl !== cdpUrl) {
      if (this.browser) await this.browser.close().catch(() => undefined);
      this.browser = await chromium.connectOverCDP(cdpUrl);
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
    }
    return { ok: true, action, tab_id, url: page.url() };
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
  }

  private async describePage(page: Page): Promise<BrowserTab> {
    const tab_id = this.idForPage(page);
    this.pages.set(tab_id, { page, tab_id });
    this.instrumentPage(page, tab_id);
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

  private instrumentPage(page: Page, tab_id: string): void {
    if (this.instrumented.has(page)) return;
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
