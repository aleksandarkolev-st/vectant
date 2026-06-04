import { randomUUID } from "node:crypto";
import { rankedLocatorCandidates } from "./locator.js";
import { redactUrl, redactValue } from "./security.js";
import type {
  BrowserActionKind,
  BrowserElementMetadata,
  BrowserSelection,
  BrowserTraceEvent,
  LocatorCandidate,
} from "./types.js";

export interface TraceRecorderInput {
  tab_id: string;
  url: string;
  origin: string;
  frame_id?: string;
  action?: BrowserActionKind;
  value?: string;
  field_name?: string;
  element?: BrowserElementMetadata;
  detail?: Record<string, unknown>;
  security?: BrowserTraceEvent["security"];
}

export class BrowserTraceRecorder {
  private events: BrowserTraceEvent[] = [];
  private counter = 0;
  private eventSeq = 0;
  private traceVersion = 1;
  private traceId = this.newTraceId();

  beginTrace(): { trace_id: string; trace_version: number } {
    this.events = [];
    this.counter = 0;
    this.eventSeq = 0;
    this.traceVersion += 1;
    this.traceId = this.newTraceId();
    return { trace_id: this.traceId, trace_version: this.traceVersion };
  }

  recordSelection(selection: BrowserSelection & { security?: BrowserTraceEvent["security"] }): BrowserTraceEvent {
    const locators = rankedLocatorCandidates(selection.element);
    const event = this.baseEvent("selection", {
      tab_id: selection.tab_id,
      frame_id: selection.frame_id,
      url: selection.url,
      origin: selection.origin,
      detail: {
        bbox: selection.bbox ?? null,
        element: selection.element ?? null,
      },
      locator_candidates: locators,
      selector: locators[0]?.locator,
      security: selection.security,
    });
    this.events.push(event);
    return event;
  }

  recordHumanAction(input: TraceRecorderInput): BrowserTraceEvent {
    return this.recordAction("human_action", input);
  }

  recordAgentAction(input: TraceRecorderInput): BrowserTraceEvent {
    return this.recordAction("agent_action", input);
  }

  recordNavigation(input: TraceRecorderInput): BrowserTraceEvent {
    const redactedUrl = redactUrl(input.url);
    const event = this.baseEvent("navigation", {
      ...input,
      url: redactedUrl.url,
      redacted: redactedUrl.redacted,
    });
    this.events.push(event);
    return event;
  }

  recordConsole(input: TraceRecorderInput & { message: string; level?: string }): BrowserTraceEvent {
    const redacted = redactValue("console", input.message);
    const event = this.baseEvent("console", {
      ...input,
      value: redacted.value,
      redacted: redacted.redacted,
      detail: { ...(input.detail ?? {}), level: input.level ?? "info" },
    });
    this.events.push(event);
    return event;
  }

  recordNetwork(input: TraceRecorderInput): BrowserTraceEvent {
    const redactedUrl = redactUrl(input.url);
    const event = this.baseEvent("network", {
      ...input,
      url: redactedUrl.url,
      redacted: redactedUrl.redacted,
    });
    this.events.push(event);
    return event;
  }

  snapshot(): BrowserTraceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  clear(): void {
    this.events = [];
    this.counter = 0;
    this.eventSeq = 0;
    this.traceVersion = 1;
    this.traceId = this.newTraceId();
  }

  private recordAction(kind: "human_action" | "agent_action", input: TraceRecorderInput): BrowserTraceEvent {
    const locators = rankedLocatorCandidates(input.element);
    const value = input.value === undefined ? undefined : redactValue(input.field_name, input.value);
    const detail = {
      ...(input.detail ?? {}),
      ...(input.field_name !== undefined ? { field_name: input.field_name } : {}),
      ...(input.element !== undefined ? { element: input.element } : {}),
    };
    const event = this.baseEvent(kind, {
      ...input,
      selector: locators[0]?.locator,
      locator_candidates: locators,
      value: value?.value,
      redacted: value?.redacted,
      detail,
    });
    this.events.push(event);
    return event;
  }

  private baseEvent(
    kind: BrowserTraceEvent["kind"],
    input: TraceRecorderInput & {
      selector?: string;
      locator_candidates?: LocatorCandidate[];
      redacted?: boolean;
    }
  ): BrowserTraceEvent {
    this.counter += 1;
    this.eventSeq += 1;
    const event: BrowserTraceEvent = {
      event_id: `browser_evt_${this.counter}`,
      trace_id: this.traceId,
      trace_version: this.traceVersion,
      event_seq: this.eventSeq,
      ts: Date.now(),
      tab_id: input.tab_id,
      origin: input.origin,
      url: input.url,
      kind,
    };
    if (input.frame_id !== undefined) event.frame_id = input.frame_id;
    if (input.action !== undefined) event.action = input.action;
    if (input.selector !== undefined) event.selector = input.selector;
    if (input.locator_candidates !== undefined) event.locator_candidates = input.locator_candidates;
    if (input.value !== undefined) event.value = input.value;
    if (input.redacted !== undefined) event.redacted = input.redacted;
    if (input.detail !== undefined) event.detail = input.detail;
    if (input.security !== undefined) event.security = input.security;
    return event;
  }

  private newTraceId(): string {
    return `browser_trace_${randomUUID()}`;
  }
}

export interface GeneratedScript {
  code: string;
  used_locators: Array<{
    event_id: string;
    locator: string;
    confidence: number;
    fallbacks: LocatorCandidate[];
  }>;
  warnings: string[];
}

export function generatePlaywrightScript(events: BrowserTraceEvent[]): GeneratedScript {
  const baseOrigin = firstHttpOrigin(events);
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('replayed browser workflow', async ({ page }) => {",
  ];
  if (baseOrigin) {
    lines.push(`  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? ${JSON.stringify(baseOrigin)};`);
  }
  lines.push("  async function firstVisible(...locators) {");
  lines.push("    let fallback = null;");
  lines.push("    for (const locator of locators) {");
  lines.push("      try {");
  lines.push("        const count = await locator.count();");
  lines.push("        if (count === 1) return locator;");
  lines.push("        if (count > 1 && !fallback) fallback = locator.first();");
  lines.push("      } catch {}");
  lines.push("    }");
  lines.push("    if (fallback) return fallback;");
  lines.push("    throw new Error('No locator candidate matched');");
  lines.push("  }");
  const used_locators: GeneratedScript["used_locators"] = [];
  const warnings: string[] = [];
  let currentUrl: string | null = null;
  let targetSeq = 0;

  for (const event of events) {
    if (event.kind !== "human_action" && event.kind !== "agent_action" && event.kind !== "navigation") continue;
    if (event.kind === "navigation" || event.action === "navigate") {
      if (event.url !== currentUrl) {
        lines.push(gotoLine(event.url, baseOrigin));
        lines.push("  await expect(page).toHaveURL(/.*/);");
        currentUrl = event.url;
      }
      continue;
    }

    const locator = event.locator_candidates?.[0];
    if (!locator) {
      warnings.push(`event ${event.event_id} has no locator candidates`);
      continue;
    }
    if (!currentUrl) {
      lines.push(gotoLine(event.url, baseOrigin));
      currentUrl = event.url;
    }
    used_locators.push({
      event_id: event.event_id,
      locator: locator.locator,
      confidence: locator.confidence,
      fallbacks: event.locator_candidates?.slice(1) ?? [],
    });
    const locatorExpressions = (event.locator_candidates ?? [locator]).map((candidate) => locatorExpressionForEvent(event, candidate.locator));
    targetSeq += 1;
    const target = `target${targetSeq}`;
    lines.push(`  const ${target} = await firstVisible(${locatorExpressions.join(", ")});`);
    lines.push(`  await expect(${target}).toBeVisible();`);
    switch (event.action) {
      case "click":
        lines.push(`  await ${target}.click();`);
        break;
      case "fill":
        lines.push(`  await ${target}.fill(${JSON.stringify(event.value ?? "")});`);
        lines.push(`  await expect(${target}).toHaveValue(${JSON.stringify(event.value ?? "")});`);
        break;
      case "press":
        lines.push(`  await ${target}.press(${JSON.stringify(event.value ?? "Enter")});`);
        break;
      case "select":
        lines.push(`  await ${target}.selectOption(${JSON.stringify(event.value ?? "")});`);
        break;
      case "check":
        lines.push(`  await ${target}.check();`);
        lines.push(`  await expect(${target}).toBeChecked();`);
        break;
      case "uncheck":
        lines.push(`  await ${target}.uncheck();`);
        lines.push(`  await expect(${target}).not.toBeChecked();`);
        break;
      case "wait":
        lines.push(`  await ${target}.waitFor();`);
        break;
      default:
        warnings.push(`event ${event.event_id} has unsupported action ${event.action ?? "unknown"}`);
        break;
    }
  }

  lines.push("});");
  return { code: lines.join("\n"), used_locators, warnings };
}

function firstHttpOrigin(events: BrowserTraceEvent[]): string | null {
  for (const event of events) {
    try {
      const url = new URL(event.url);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      continue;
    }
  }
  return null;
}

function gotoLine(url: string, baseOrigin: string | null): string {
  if (!baseOrigin) return `  await page.goto(${JSON.stringify(url)});`;
  try {
    const parsed = new URL(url);
    if (parsed.origin === baseOrigin) {
      return `  await page.goto(\`\${baseUrl}${parsed.pathname}${parsed.search}${parsed.hash}\`);`;
    }
  } catch {
    // Fall through to literal URL.
  }
  return `  await page.goto(${JSON.stringify(url)});`;
}

function locatorExpressionForEvent(event: BrowserTraceEvent, locator: string): string {
  const frameLocator = typeof event.detail?.["frame_locator"] === "string" ? event.detail["frame_locator"] : null;
  if (!frameLocator) return locator;
  return locator.replace(/^page\./, `page.frameLocator(${JSON.stringify(frameLocator)}).`);
}
