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
}

export class BrowserTraceRecorder {
  private events: BrowserTraceEvent[] = [];
  private counter = 0;

  recordSelection(selection: BrowserSelection): BrowserTraceEvent {
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
  }

  private recordAction(kind: "human_action" | "agent_action", input: TraceRecorderInput): BrowserTraceEvent {
    const locators = rankedLocatorCandidates(input.element);
    const value = input.value === undefined ? undefined : redactValue(input.field_name, input.value);
    const event = this.baseEvent(kind, {
      ...input,
      selector: locators[0]?.locator,
      locator_candidates: locators,
      value: value?.value,
      redacted: value?.redacted,
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
    const event: BrowserTraceEvent = {
      event_id: `browser_evt_${this.counter}`,
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
    return event;
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
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('replayed browser workflow', async ({ page }) => {",
  ];
  const used_locators: GeneratedScript["used_locators"] = [];
  const warnings: string[] = [];
  let currentUrl: string | null = null;

  for (const event of events) {
    if (event.kind !== "human_action" && event.kind !== "agent_action" && event.kind !== "navigation") continue;
    if (event.kind === "navigation" || event.action === "navigate") {
      if (event.url !== currentUrl) {
        lines.push(`  await page.goto(${JSON.stringify(event.url)});`);
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
    used_locators.push({
      event_id: event.event_id,
      locator: locator.locator,
      confidence: locator.confidence,
      fallbacks: event.locator_candidates?.slice(1) ?? [],
    });
    lines.push(`  await expect(${locator.locator}).toBeVisible();`);
    switch (event.action) {
      case "click":
        lines.push(`  await ${locator.locator}.click();`);
        break;
      case "fill":
        lines.push(`  await ${locator.locator}.fill(${JSON.stringify(event.value ?? "")});`);
        lines.push(`  await expect(${locator.locator}).toHaveValue(${JSON.stringify(event.value ?? "")});`);
        break;
      case "press":
        lines.push(`  await ${locator.locator}.press(${JSON.stringify(event.value ?? "Enter")});`);
        break;
      case "select":
        lines.push(`  await ${locator.locator}.selectOption(${JSON.stringify(event.value ?? "")});`);
        break;
      case "check":
        lines.push(`  await ${locator.locator}.check();`);
        lines.push(`  await expect(${locator.locator}).toBeChecked();`);
        break;
      case "uncheck":
        lines.push(`  await ${locator.locator}.uncheck();`);
        lines.push(`  await expect(${locator.locator}).not.toBeChecked();`);
        break;
      case "wait":
        lines.push(`  await ${locator.locator}.waitFor();`);
        break;
      default:
        warnings.push(`event ${event.event_id} has unsupported action ${event.action ?? "unknown"}`);
        break;
    }
  }

  lines.push("});");
  return { code: lines.join("\n"), used_locators, warnings };
}
