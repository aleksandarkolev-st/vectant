import { randomUUID } from "node:crypto";
import { rankedLocatorCandidates } from "./locator.js";
import { redactUrl, redactValue } from "./security.js";
import { compileWorkflowContract, normalizeReplayMode, type WorkflowReplayModeV7 } from "./workflow.js";
import type {
  BrowserActionKind,
  BrowserElementMetadata,
  BrowserSelection,
  BrowserTraceEvent,
  LocatorCandidate,
} from "./types.js";

const RELATED_DBLCLICK_CLICK_WINDOW_MS = 1000;

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

  annotateLatestAction(input: {
    tab_id: string;
    actions?: BrowserActionKind[];
    detail: Record<string, unknown>;
    within_ms?: number;
  }): BrowserTraceEvent | null {
    const now = Date.now();
    const actions = input.actions ? new Set<BrowserActionKind>(input.actions) : null;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (!event || (event.kind !== "human_action" && event.kind !== "agent_action")) continue;
      if (event.tab_id !== input.tab_id) continue;
      if (actions && (!event.action || !actions.has(event.action))) continue;
      if (input.within_ms !== undefined && now - event.ts > input.within_ms) return null;
      event.detail = { ...(event.detail ?? {}), ...input.detail };
      return { ...event };
    }
    return null;
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
  mode: WorkflowReplayModeV7;
  workflow_id: string;
  used_locators: Array<{
    event_id: string;
    locator: string;
    confidence: number;
    fallbacks: LocatorCandidate[];
  }>;
  warnings: string[];
}

export function generatePlaywrightScript(events: BrowserTraceEvent[], options: { mode?: WorkflowReplayModeV7 } = {}): GeneratedScript {
  const mode = normalizeReplayMode(options.mode);
  const workflow = compileWorkflowContract(events);
  const contract = workflow.contract;
  const baseOrigin = firstHttpOrigin(events);
  const usesFileDrop = events.some((event) => dragClassFor(event) === "filedrop");
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    ...(usesFileDrop ? ["import fs from 'node:fs/promises';"] : []),
    "",
    `// Workflow: ${contract.name}`,
    `// Status: ${workflow.card.status}`,
    `// Auth: ${contract.authPlan.durability}`,
    `// Mutation mode: ${contract.mutationBoundaryPlan.defaultReplayMode}`,
    `// Limitations: ${contract.limitations.length ? contract.limitations.join(", ") : "none"}`,
    "",
    "test('replayed browser workflow', async ({ page }) => {",
  ];
  const replayBlocked = contract.mutationBoundaryPlan.defaultReplayMode === "blocked";
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
  if (usesFileDrop) {
    lines.push("  async function dropFile(page, target, filePath, mimeType = 'application/octet-stream') {");
    lines.push("    const buffer = await fs.readFile(filePath);");
    lines.push("    const fileName = filePath.split(/[\\\\/]/).pop() || 'upload.bin';");
    lines.push("    const dataTransfer = await page.evaluateHandle(({ bytes, fileName, mimeType }) => {");
    lines.push("      const dataTransfer = new DataTransfer();");
    lines.push("      const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType });");
    lines.push("      dataTransfer.items.add(file);");
    lines.push("      return dataTransfer;");
    lines.push("    }, { bytes: Array.from(buffer), fileName, mimeType });");
    lines.push("    await target.dispatchEvent('dragenter', { dataTransfer });");
    lines.push("    await target.dispatchEvent('dragover', { dataTransfer });");
    lines.push("    await target.dispatchEvent('drop', { dataTransfer });");
    lines.push("  }");
  }
  const used_locators: GeneratedScript["used_locators"] = [];
  const warnings: string[] = [];
  warnings.push(...contract.limitations.map((limitation) => `workflow limitation: ${limitation}`));
  if (replayBlocked) warnings.push("workflow replay blocked by unsupported browser surface");
  let currentUrl: string | null = null;
  let targetSeq = 0;
  const firstMutationStepId = contract.mutationBoundaryPlan.firstMutationStepId;

  if (replayBlocked) {
    const reason = contract.generatedOutputs.find((output) => output.kind === "playwright")?.notes.join(" ") ||
      "Workflow replay is blocked.";
    lines.push(`  test.skip(true, ${JSON.stringify(reason)});`);
    lines.push("});");
    return { code: lines.join("\n"), mode, workflow_id: contract.workflowId, used_locators, warnings };
  }

  for (const event of coalesceReplayEvents(events)) {
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
    if ((mode === "prefixOnly" || mode === "coldSession") && firstMutationStepId === event.event_id) {
      lines.push(`  // Mutation boundary: ${event.event_id}. Prefix-only replay verifies reachability but does not commit this action.`);
      lines.push(`  await expect(${target}).toBeEnabled();`);
      warnings.push(`${mode} stopped before mutation boundary ${event.event_id}`);
      continue;
    }
    switch (event.action) {
      case "click":
        if (isDownloadTrigger(event)) {
          pushDownloadAction(lines, target, "click", event, targetSeq);
        } else if (isDialogTrigger(event)) {
          pushDialogAction(lines, target, "click", event, targetSeq);
        } else if (isPopupTrigger(event)) {
          pushPopupAction(lines, target, "click", event, targetSeq, baseOrigin);
        } else {
          lines.push(`  await ${target}.click();`);
        }
        break;
      case "dblclick":
        if (isDownloadTrigger(event)) {
          pushDownloadAction(lines, target, "dblclick", event, targetSeq);
        } else if (isDialogTrigger(event)) {
          pushDialogAction(lines, target, "dblclick", event, targetSeq);
        } else if (isPopupTrigger(event)) {
          pushPopupAction(lines, target, "dblclick", event, targetSeq, baseOrigin);
        } else {
          lines.push(`  await ${target}.dblclick();`);
        }
        break;
      case "contextmenu":
        lines.push(`  await ${target}.click({ button: 'right' });`);
        break;
      case "hover":
        lines.push(`  await ${target}.hover();`);
        break;
      case "drag": {
        const dragClass = dragClassFor(event);
        if (dragClass === "filedrop") {
          const envName = fileDropEnvNameFor(event, targetSeq);
          const fixtureFile = typeof event.detail?.["fixture_file"] === "string" ? event.detail["fixture_file"] : undefined;
          const filePath = `filePath${targetSeq}`;
          lines.push(`  const ${filePath} = process.env[${JSON.stringify(envName)}]${fixtureFile ? ` ?? ${JSON.stringify(fixtureFile)}` : ""};`);
          lines.push(`  test.skip(!${filePath}, ${JSON.stringify(`Set ${envName} or detail.fixture_file for file drop step ${event.event_id}.`)});`);
          lines.push(`  if (!${filePath}) throw new Error(${JSON.stringify(`missing file drop path for ${event.event_id}`)});`);
          if (isFileInputDrop(event)) {
            lines.push(`  await ${target}.setInputFiles(${filePath});`);
          } else {
            const mimeType = typeof event.detail?.["mime_type"] === "string" ? event.detail["mime_type"] : "application/octet-stream";
            lines.push(`  await dropFile(page, ${target}, ${filePath}, ${JSON.stringify(mimeType)});`);
          }
          warnings.push(`event ${event.event_id} file drop replay is parameterized by ${envName}`);
          break;
        }
        if (dragClass === "clipboarddrop") {
          warnings.push(`event ${event.event_id} is a clipboard drop step and requires caller-provided clipboard data`);
          break;
        }
        const dropLocator = typeof event.detail?.["drop_locator"] === "string"
          ? event.detail["drop_locator"]
          : event.value;
        if (dropLocator) {
          const dropTarget = `dropTarget${targetSeq}`;
          lines.push(`  const ${dropTarget} = ${locatorExpressionForEvent(event, dropLocator)};`);
          lines.push(`  await ${target}.dragTo(${dropTarget});`);
          const draggedText = draggedElementText(event);
          if (draggedText) {
            lines.push(`  await expect(${dropTarget}).toContainText(${JSON.stringify(draggedText)});`);
          }
        } else {
          warnings.push(`event ${event.event_id} is a drag step without a durable drop target locator`);
        }
        break;
      }
      case "scroll": {
        const position = scrollPositionFor(event);
        lines.push(`  await ${target}.evaluate((element, position) => {`);
        lines.push("    if (element === document.body || element === document.documentElement) {");
        lines.push("      window.scrollTo(position.left, position.top);");
        lines.push("    } else {");
        lines.push("      element.scrollTo(position.left, position.top);");
        lines.push("    }");
        lines.push(`  }, ${JSON.stringify(position)});`);
        break;
      }
      case "fill":
        if (isRangeControlFill(event)) {
          lines.push(`  await ${target}.evaluate((element, value) => {`);
          lines.push("    if (!(element instanceof HTMLInputElement) || element.type !== 'range') throw new Error('target_not_range_input');");
          lines.push("    element.value = String(value);");
          lines.push("    element.dispatchEvent(new Event('input', { bubbles: true }));");
          lines.push("    element.dispatchEvent(new Event('change', { bubbles: true }));");
          lines.push(`  }, ${JSON.stringify(event.value ?? "")});`);
          lines.push(`  await expect(${target}).toHaveValue(${JSON.stringify(event.value ?? "")});`);
        } else if (isKeyboardEditorFill(event)) {
          lines.push(`  await ${target}.click();`);
          lines.push("  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');");
          lines.push("  await page.keyboard.press('Backspace');");
          lines.push(`  await page.keyboard.insertText(${JSON.stringify(event.value ?? "")});`);
          warnings.push(`event ${event.event_id} uses keyboard insertion for a custom code-editor surface`);
        } else if (isContentEditableFill(event)) {
          lines.push(`  await ${target}.fill(${JSON.stringify(event.value ?? "")});`);
          lines.push(`  await expect(${target}).toContainText(${JSON.stringify(event.value ?? "")});`);
        } else {
          lines.push(`  await ${target}.fill(${JSON.stringify(event.value ?? "")});`);
          lines.push(`  await expect(${target}).toHaveValue(${JSON.stringify(event.value ?? "")});`);
        }
        break;
      case "press":
        if (isDialogTrigger(event)) {
          pushDialogAction(lines, target, "press", event, targetSeq, event.value ?? "Enter");
        } else if (isPopupTrigger(event)) {
          pushPopupAction(lines, target, "press", event, targetSeq, baseOrigin, event.value ?? "Enter");
        } else {
          lines.push(`  await ${target}.press(${JSON.stringify(event.value ?? "Enter")});`);
        }
        break;
      case "select":
        lines.push(`  await ${target}.selectOption(${JSON.stringify(event.value ?? "")});`);
        lines.push(`  await expect(${target}).toHaveValue(${JSON.stringify(event.value ?? "")});`);
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
    for (const effectText of observedEffectTexts(event)) {
      const effectLocator = locatorExpressionForEvent(
        event,
        `page.getByText(${JSON.stringify(effectText)}, { exact: true })`
      );
      lines.push(`  await expect(${effectLocator}).toBeVisible();`);
    }
  }

  lines.push("});");
  return { code: lines.join("\n"), mode, workflow_id: contract.workflowId, used_locators, warnings };
}

function coalesceReplayEvents(events: BrowserTraceEvent[]): BrowserTraceEvent[] {
  const result: BrowserTraceEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous && shouldDropClickAfterDblClick(previous, event)) {
      continue;
    }
    while (event.action === "dblclick" && result.length > 0) {
      const prior = result[result.length - 1];
      if (!prior || !sameActionTarget(prior, event) || prior.action !== "click") break;
      result.pop();
    }
    result.push(event);
  }
  return result;
}

function shouldDropClickAfterDblClick(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.action !== "dblclick" || next.action !== "click") return false;
  if (!sameActionTarget(previous, next)) return false;
  if (previous.detail?.["dblclick_event"] !== true || next.detail?.["click_event"] !== true) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  return elapsedMs <= RELATED_DBLCLICK_CLICK_WINDOW_MS;
}

function sameActionTarget(left: BrowserTraceEvent, right: BrowserTraceEvent): boolean {
  if (left.kind !== right.kind) return false;
  if (left.tab_id !== right.tab_id || left.origin !== right.origin) return false;
  const leftKey = actionTargetKey(left);
  const rightKey = actionTargetKey(right);
  return leftKey.length > 0 && leftKey === rightKey;
}

function actionTargetKey(event: BrowserTraceEvent): string {
  const element = elementForEvent(event);
  return [
    event.selector,
    event.locator_candidates?.[0]?.locator,
    element?.source_id,
    element?.test_id,
    element?.id,
    element?.label,
    element?.placeholder,
    element?.name,
    element?.text,
    element?.css,
    element?.xpath,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join("|");
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
  return `  await page.goto(${urlExpression(url, baseOrigin)});`;
}

function urlExpression(url: string, baseOrigin: string | null): string {
  if (!baseOrigin) return JSON.stringify(url);
  try {
    const parsed = new URL(url);
    if (parsed.origin === baseOrigin) {
      return `\`\${baseUrl}${parsed.pathname}${parsed.search}${parsed.hash}\``;
    }
  } catch {
    // Fall through to literal URL.
  }
  return JSON.stringify(url);
}

function locatorExpressionForEvent(event: BrowserTraceEvent, locator: string): string {
  const frameLocator = typeof event.detail?.["frame_locator"] === "string" ? event.detail["frame_locator"] : null;
  if (!frameLocator) return locator;
  return locator.replace(/^page\./, `page.frameLocator(${JSON.stringify(frameLocator)}).`);
}

function dragClassFor(event: BrowserTraceEvent): string {
  return String(event.detail?.["drag_class"] ?? event.detail?.["dragClass"] ?? "").toLowerCase();
}

function fileDropEnvNameFor(event: BrowserTraceEvent, ordinal: number): string {
  const explicit = typeof event.detail?.["file_env"] === "string"
    ? event.detail["file_env"]
    : typeof event.detail?.["file_parameter"] === "string"
      ? event.detail["file_parameter"]
      : `SYNTHI_FILE_DROP_${ordinal}`;
  const normalized = explicit.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `SYNTHI_FILE_DROP_${ordinal}`;
}

function scrollPositionFor(event: BrowserTraceEvent): { top: number; left: number } {
  const top = numericDetail(event, "scroll_top") ?? 0;
  const left = numericDetail(event, "scroll_left") ?? 0;
  return {
    top: Math.max(0, Math.round(top)),
    left: Math.max(0, Math.round(left)),
  };
}

function isDownloadTrigger(event: BrowserTraceEvent): boolean {
  return event.detail?.["download_event"] === true;
}

function isDialogTrigger(event: BrowserTraceEvent): boolean {
  return event.detail?.["dialog_event"] === true;
}

function isPopupTrigger(event: BrowserTraceEvent): boolean {
  return event.detail?.["popup_event"] === true;
}

function isContentEditableFill(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return event.action === "fill" && element?.content_editable === true;
}

function isRangeControlFill(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return event.action === "fill" && (
    event.detail?.["control_kind"] === "range" ||
    event.detail?.["range_control"] === true ||
    (element?.tag?.toLowerCase() === "input" && element?.type?.toLowerCase() === "range")
  );
}

function isKeyboardEditorFill(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return event.action === "fill" && (
    event.detail?.["editor_replay_strategy"] === "keyboardInsert" ||
    element?.editor_replay_strategy === "keyboardInsert"
  );
}

function pushDownloadAction(
  lines: string[],
  target: string,
  method: "click" | "dblclick",
  event: BrowserTraceEvent,
  ordinal: number
): void {
  const download = `download${ordinal}`;
  lines.push(`  const [${download}] = await Promise.all([`);
  lines.push("    page.waitForEvent('download'),");
  lines.push(`    ${target}.${method}(),`);
  lines.push("  ]);");
  const filename = typeof event.detail?.["suggested_filename"] === "string" ? event.detail["suggested_filename"] : "";
  const redacted = event.detail?.["suggested_filename_redacted"] === true;
  if (filename && !redacted) {
    lines.push(`  expect(${download}.suggestedFilename()).toBe(${JSON.stringify(filename)});`);
  }
}

function pushDialogAction(
  lines: string[],
  target: string,
  method: "click" | "dblclick" | "press",
  event: BrowserTraceEvent,
  ordinal: number,
  pressKey?: string
): void {
  const message = typeof event.detail?.["dialog_message"] === "string" ? event.detail["dialog_message"] : "";
  const messageRedacted = event.detail?.["dialog_message_redacted"] === true;
  const type = typeof event.detail?.["dialog_type"] === "string" ? event.detail["dialog_type"] : "alert";
  const accepted = event.detail?.["dialog_accepted"] !== false;
  const promptValue = typeof event.detail?.["dialog_prompt_value"] === "string" ? event.detail["dialog_prompt_value"] : "";
  const promptRedacted = event.detail?.["dialog_prompt_value_redacted"] === true;
  const dialogPromise = `dialog${ordinal}Promise`;
  const dialogMessage = `dialog${ordinal}Message`;
  lines.push(`  let ${dialogMessage} = "";`);
  lines.push(`  const ${dialogPromise} = new Promise((resolve, reject) => {`);
  lines.push("    page.once('dialog', async (dialog) => {");
  lines.push("      try {");
  lines.push(`        expect(dialog.type()).toBe(${JSON.stringify(type)});`);
  if (message && !messageRedacted) {
    lines.push(`        expect(dialog.message()).toContain(${JSON.stringify(message)});`);
  }
  lines.push(`        ${dialogMessage} = dialog.message();`);
  if (accepted) {
    if (type === "prompt" && promptValue && !promptRedacted) {
      lines.push(`        await dialog.accept(${JSON.stringify(promptValue)});`);
    } else {
      lines.push("        await dialog.accept();");
    }
  } else {
    lines.push("        await dialog.dismiss();");
  }
  lines.push("        resolve(undefined);");
  lines.push("      } catch (err) {");
  lines.push("        reject(err);");
  lines.push("      }");
  lines.push("    });");
  lines.push("  });");
  if (method === "press") {
    lines.push(`  await ${target}.press(${JSON.stringify(pressKey ?? "Enter")});`);
  } else {
    lines.push(`  await ${target}.${method}();`);
  }
  lines.push(`  await ${dialogPromise};`);
  if (message && !messageRedacted) {
    lines.push(`  expect(${dialogMessage}).toContain(${JSON.stringify(message)});`);
  }
}

function pushPopupAction(
  lines: string[],
  target: string,
  method: "click" | "dblclick" | "press",
  event: BrowserTraceEvent,
  ordinal: number,
  baseOrigin: string | null,
  pressKey?: string
): void {
  const popup = `popup${ordinal}`;
  lines.push(`  const [${popup}] = await Promise.all([`);
  lines.push("    page.waitForEvent('popup'),");
  if (method === "press") {
    lines.push(`    ${target}.press(${JSON.stringify(pressKey ?? "Enter")}),`);
  } else {
    lines.push(`    ${target}.${method}(),`);
  }
  lines.push("  ]);");
  lines.push(`  await ${popup}.waitForLoadState('domcontentloaded').catch(() => undefined);`);
  const popupUrl = typeof event.detail?.["popup_url"] === "string" ? event.detail["popup_url"] : "";
  const popupUrlRedacted = event.detail?.["popup_url_redacted"] === true;
  if (popupUrl && !popupUrlRedacted) {
    lines.push(`  await expect(${popup}).toHaveURL(${urlExpression(popupUrl, baseOrigin)});`);
  }
  const popupTitle = typeof event.detail?.["popup_title"] === "string" ? event.detail["popup_title"] : "";
  const popupTitleRedacted = event.detail?.["popup_title_redacted"] === true;
  if (popupTitle && !popupTitleRedacted) {
    lines.push(`  await expect(${popup}).toHaveTitle(${JSON.stringify(popupTitle)});`);
  }
}

function numericDetail(event: BrowserTraceEvent, key: string): number | undefined {
  const value = event.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFileInputDrop(event: BrowserTraceEvent): boolean {
  const input = elementForEvent(event);
  if (!input) return event.detail?.["file_input"] === true;
  return event.detail?.["file_input"] === true ||
    (input.tag?.toLowerCase() === "input" && input.type?.toLowerCase() === "file");
}

function elementForEvent(event: BrowserTraceEvent): BrowserElementMetadata | undefined {
  const element = event.detail?.["element"];
  return element && typeof element === "object" && !Array.isArray(element)
    ? element as BrowserElementMetadata
    : undefined;
}

function observedEffectTexts(event: BrowserTraceEvent): string[] {
  const raw = event.detail?.["observed_effects"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const compact = value.trim().replace(/\s+/g, " ");
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    result.push(compact.slice(0, 240));
  }
  return result;
}

function draggedElementText(event: BrowserTraceEvent): string | null {
  const metadata = elementForEvent(event);
  if (!metadata) return null;
  const value = metadata.text ?? metadata.name ?? metadata.label ?? metadata.test_id;
  return value && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 160) : null;
}
