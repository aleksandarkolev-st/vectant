import { randomUUID } from "node:crypto";
import { rankedLocatorCandidates } from "./locator.js";
import { redactStructuredValue, redactUrl, redactValue } from "./security.js";
import { compileWorkflowContract, normalizeReplayMode, orderBrowserReplayEvents, type WorkflowContractV7, type WorkflowReplayModeV7 } from "./workflow.js";
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
  observed_at?: number;
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
    return this.events.map((event) => this.sanitizeEvent(event));
  }

  annotateLatestAction(input: {
    tab_id: string;
    actions?: BrowserActionKind[];
    detail: Record<string, unknown>;
    security?: BrowserTraceEvent["security"];
    within_ms?: number;
    observed_at?: number;
  }): BrowserTraceEvent | null {
    const match = this.latestActionIndex(input);
    if (match === null) return null;
    const event = this.events[match];
    if (!event) return null;
    const detail = redactStructuredValue(mergeActionAnnotationDetail(event.detail, input.detail));
    event.detail = detail.value as Record<string, unknown>;
    if (input.security) event.security = { ...(event.security ?? {}), ...input.security };
    if (detail.redacted) event.redacted = true;
    return this.sanitizeEvent(event);
  }

  annotateAction(event_id: string, input: {
    detail: Record<string, unknown>;
    security?: BrowserTraceEvent["security"];
  }): BrowserTraceEvent | null {
    const event = this.events.find((candidate) => candidate.event_id === event_id);
    if (!event || (event.kind !== "human_action" && event.kind !== "agent_action")) return null;
    const detail = redactStructuredValue(mergeActionAnnotationDetail(event.detail, input.detail));
    event.detail = detail.value as Record<string, unknown>;
    if (input.security) event.security = { ...(event.security ?? {}), ...input.security };
    if (detail.redacted) event.redacted = true;
    return this.sanitizeEvent(event);
  }

  discardLatestAction(input: {
    tab_id: string;
    actions?: BrowserActionKind[];
    within_ms?: number;
    observed_at?: number;
  }): BrowserTraceEvent | null {
    const match = this.latestActionIndex(input);
    if (match === null) return null;
    const [event] = this.events.splice(match, 1);
    return event ? this.sanitizeEvent(event) : null;
  }

  private latestActionIndex(input: {
    tab_id: string;
    actions?: BrowserActionKind[];
    within_ms?: number;
    observed_at?: number;
  }): number | null {
    const observedAt = input.observed_at;
    const referenceTs = typeof observedAt === "number" && Number.isFinite(observedAt)
      ? Math.floor(observedAt)
      : Date.now();
    const hasObservedAt = typeof observedAt === "number" && Number.isFinite(observedAt);
    const actions = input.actions ? new Set<BrowserActionKind>(input.actions) : null;
    let closestTimedMatch: { index: number; delta: number } | null = null;
    let sameTimestampMatch: number | null = null;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (!event || (event.kind !== "human_action" && event.kind !== "agent_action")) continue;
      if (event.tab_id !== input.tab_id) continue;
      if (actions && (!event.action || !actions.has(event.action))) continue;
      if (hasObservedAt) {
        const delta = Math.abs(event.ts - referenceTs);
        if (input.within_ms !== undefined && delta > input.within_ms) continue;
        if (!closestTimedMatch || delta < closestTimedMatch.delta || (delta === closestTimedMatch.delta && index > closestTimedMatch.index)) {
          closestTimedMatch = { index, delta };
        }
        if (event.ts === referenceTs) sameTimestampMatch = index;
        continue;
      }
      if (event.ts > referenceTs) continue;
      if (input.within_ms !== undefined && referenceTs - event.ts > input.within_ms) return null;
      return index;
    }
    return sameTimestampMatch ?? closestTimedMatch?.index ?? null;
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
    const observedAt = input.observed_at;
    const event: BrowserTraceEvent = {
      event_id: `browser_evt_${this.counter}`,
      trace_id: this.traceId,
      trace_version: this.traceVersion,
      event_seq: this.eventSeq,
      ts: typeof observedAt === "number" && Number.isFinite(observedAt) ? Math.floor(observedAt) : Date.now(),
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
    return this.sanitizeEvent(event);
  }

  private sanitizeEvent(event: BrowserTraceEvent): BrowserTraceEvent {
    const structured = redactStructuredValue(event);
    const next = structured.value as BrowserTraceEvent;
    const url = redactUrl(next.url);
    next.url = url.url;
    if (structured.redacted || url.redacted) next.redacted = true;
    return next;
  }

  private newTraceId(): string {
    return `browser_trace_${randomUUID()}`;
  }
}

function mergeActionAnnotationDetail(
  existing: Record<string, unknown> | undefined,
  annotation: Record<string, unknown>
): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...(existing ?? {}), ...annotation };
  if (typeof detail["dialog_prompt_value"] === "string") {
    detail["dialog_prompt_value"] = "[REDACTED]";
    detail["dialog_prompt_value_redacted"] = true;
  }
  if (annotation["observed_effects_redacted"] === true && annotation["observed_effects"] === undefined) {
    delete detail["observed_effects"];
  }
  return detail;
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
  const orderedEvents = orderBrowserReplayEvents(events);
  const workflow = compileWorkflowContract(events);
  const contract = workflow.contract;
  const mode = options.mode === undefined
    ? defaultScriptReplayMode(contract)
    : normalizeReplayMode(options.mode);
  const valueParameterByEventId = new Map(contract.steps.flatMap((step) =>
    step.action.valueRef ? [[step.stepId, step.action.valueRef] as const] : []
  ));
  const baseOrigin = firstHttpOrigin(orderedEvents);
  const requiresRuntimeBaseUrl = orderedEvents.some((event) => isPreviewProxyUrl(event.url));
  const usesFileDrop = events.some((event) => dragClassFor(event) === "filedrop");
  const usesClipboardDrop = events.some(isClipboardDropEvent);
  const usesNetworkResponseWait = events.some(hasReplayNetworkEvent);
  const usesValueParameters = events.some((event) => scriptValueParameterName(event, valueParameterByEventId) !== undefined);
  const usesAriaOptionParameters = events.some((event) => scriptAriaOptionParameterName(event, valueParameterByEventId) !== undefined);
  const firstMutationStepId = contract.mutationBoundaryPlan.firstMutationStepId;
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    ...(mode === "ciIsolated" ? ["import { appendFile, mkdir } from 'node:fs/promises';", "import path from 'node:path';"] : []),
    ...(usesFileDrop ? ["import fs from 'node:fs/promises';"] : []),
    "",
    `// Workflow: ${contract.name}`,
    `// Status: ${workflow.card.status}`,
    `// Auth: ${contract.authPlan.durability}`,
    `// Replay mode: ${mode}`,
    `// Default mutation mode: ${contract.mutationBoundaryPlan.defaultReplayMode}`,
    `// Limitations: ${contract.limitations.length ? contract.limitations.join(", ") : "none"}`,
    "",
    "const workflowStorageState = process.env.SYNTHI_WORKFLOW_STORAGE_STATE || process.env.PLAYWRIGHT_STORAGE_STATE;",
    "if (workflowStorageState) test.use({ storageState: workflowStorageState });",
    "",
    "test('replayed browser workflow', async ({ page }) => {",
  ];
  const replayBlocked = contract.mutationBoundaryPlan.defaultReplayMode === "blocked";
  if (baseOrigin) {
    if (requiresRuntimeBaseUrl) {
      lines.push("  const baseUrl = process.env.PLAYWRIGHT_BASE_URL;");
      lines.push("  test.skip(!baseUrl, 'Set PLAYWRIGHT_BASE_URL to the app or forwarded preview URL for this workflow.');");
      lines.push("  if (!baseUrl) throw new Error('missing PLAYWRIGHT_BASE_URL for proxied workflow URL');");
    } else {
      lines.push(`  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? ${JSON.stringify(baseOrigin)};`);
    }
    lines.push("  function workflowUrl(path = '') {");
    lines.push("    const route = String(path || '').replace(/^\\/+/, '');");
    lines.push("    const base = String(baseUrl).replace(/\\/+$/, '');");
    lines.push("    return route ? `${base}/${route}` : `${base}/`;");
    lines.push("  }");
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
  if (usesValueParameters) {
    lines.push("  function readRequiredEnv(name, stepId) {");
    lines.push("    const value = process.env[name];");
    lines.push("    test.skip(value === undefined, `Set ${name} for workflow parameter ${stepId}.`);");
    lines.push("    if (value === undefined) throw new Error(`missing workflow parameter ${name} for ${stepId}`);");
    lines.push("    return value;");
    lines.push("  }");
    lines.push("  function readRequiredEnvList(name, stepId) {");
    lines.push("    const raw = readRequiredEnv(name, stepId);");
    lines.push("    try {");
    lines.push("      const parsed = JSON.parse(raw);");
    lines.push("      if (Array.isArray(parsed)) return parsed.map((value) => String(value));");
    lines.push("    } catch {}");
    lines.push("    return raw.split(',').map((value) => value.trim()).filter(Boolean);");
    lines.push("  }");
    lines.push("  function escapeRegExp(value) {");
    lines.push("    return String(value).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');");
    lines.push("  }");
    lines.push("  function parameterizedTextRegex(parts, ...values) {");
    lines.push("    return new RegExp(`^${parts.map((part, index) => `${escapeRegExp(part)}${index < values.length ? escapeRegExp(values[index]) : ''}`).join('')}$`);");
    lines.push("  }");
    if (usesAriaOptionParameters) {
      lines.push("  async function ariaOptionByValue(listbox, value) {");
      lines.push("    const needle = String(value).trim().toLowerCase();");
      lines.push("    const options = listbox.getByRole('option');");
      lines.push("    const count = await options.count();");
      lines.push("    let partial = null;");
      lines.push("    for (let index = 0; index < count; index += 1) {");
      lines.push("      const option = options.nth(index);");
      lines.push("      const match = await option.evaluate((element, rawValue) => {");
      lines.push("        const value = String(rawValue).trim().toLowerCase();");
      lines.push("        const normalize = (candidate) => String(candidate || '').trim().toLowerCase();");
      lines.push("        const attributes = element.getAttributeNames();");
      lines.push("        for (const attr of attributes) {");
      lines.push("          if (!attr.startsWith('data-') && !['value', 'aria-label', 'title', 'id', 'name'].includes(attr)) continue;");
      lines.push("          if (normalize(element.getAttribute(attr)) === value) return 'exact';");
      lines.push("        }");
      lines.push("        const text = normalize(element.textContent);");
      lines.push("        if (text === value) return 'exact';");
      lines.push("        if (text.includes(value)) return 'partial';");
      lines.push("        return '';");
      lines.push("      }, needle);");
      lines.push("      if (match === 'exact') return option;");
      lines.push("      if (match === 'partial' && !partial) partial = option;");
      lines.push("    }");
      lines.push("    if (partial) return partial;");
      lines.push("    throw new Error(`No ARIA option matched ${value}`);");
      lines.push("  }");
    }
  }
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
  if (usesNetworkResponseWait) {
    lines.push("  async function installWorkflowNetworkTracker(page) {");
    lines.push("    await page.evaluate(() => {");
    lines.push("      const state = window;");
    lines.push("      if (state.__synthiWorkflowNetworkTrackerInstalled) return;");
    lines.push("      state.__synthiWorkflowNetworkTrackerInstalled = true;");
    lines.push("      state.__synthiWorkflowPendingRequests = 0;");
    lines.push("      const increment = () => { state.__synthiWorkflowPendingRequests = (state.__synthiWorkflowPendingRequests || 0) + 1; };");
    lines.push("      const decrement = () => { state.__synthiWorkflowPendingRequests = Math.max(0, (state.__synthiWorkflowPendingRequests || 0) - 1); };");
    lines.push("      const originalFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;");
    lines.push("      if (originalFetch) {");
    lines.push("        window.fetch = async (...args) => {");
    lines.push("          increment();");
    lines.push("          try { return await originalFetch(...args); }");
    lines.push("          finally { decrement(); }");
    lines.push("        };");
    lines.push("      }");
    lines.push("      const OriginalXHR = window.XMLHttpRequest;");
    lines.push("      if (OriginalXHR) {");
    lines.push("        window.XMLHttpRequest = function SynthiTrackedXMLHttpRequest() {");
    lines.push("          const xhr = new OriginalXHR();");
    lines.push("          let pending = false;");
    lines.push("          const finish = () => { if (!pending) return; pending = false; decrement(); };");
    lines.push("          const send = xhr.send;");
    lines.push("          xhr.send = function (...args) {");
    lines.push("            pending = true;");
    lines.push("            increment();");
    lines.push("            xhr.addEventListener('loadend', finish, { once: true });");
    lines.push("            return send.apply(xhr, args);");
    lines.push("          };");
    lines.push("          return xhr;");
    lines.push("        };");
    lines.push("        window.XMLHttpRequest.prototype = OriginalXHR.prototype;");
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
    lines.push("  async function waitForWorkflowNetworkSettled(page) {");
    lines.push("    const timeout = Number(process.env.SYNTHI_WORKFLOW_NETWORK_IDLE_TIMEOUT_MS || 5000);");
    lines.push("    await page.waitForFunction(() => (window.__synthiWorkflowPendingRequests || 0) === 0, undefined, { timeout }).catch(() => undefined);");
    lines.push("  }");
  }
  if (events.some(isClipboardPasteEvent)) {
    lines.push("  async function pasteText(page, target, text) {");
    lines.push("    await target.click();");
    lines.push("    let wroteClipboard = false;");
    lines.push("    try {");
    lines.push("      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });");
    lines.push("      wroteClipboard = await page.evaluate(async (value) => {");
    lines.push("        try { await navigator.clipboard.writeText(value); return true; } catch { return false; }");
    lines.push("      }, text);");
    lines.push("    } catch {}");
    lines.push("    if (wroteClipboard) {");
    lines.push("      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');");
    lines.push("      return;");
    lines.push("    }");
    lines.push("    await target.evaluate((element, value) => {");
    lines.push("      const dataTransfer = new DataTransfer();");
    lines.push("      dataTransfer.setData('text/plain', value);");
    lines.push("      let event;");
    lines.push("      try { event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer }); }");
    lines.push("      catch { event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: dataTransfer }); }");
    lines.push("      const notCanceled = element.dispatchEvent(event);");
    lines.push("      if (!notCanceled) return;");
    lines.push("      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {");
    lines.push("        const start = element.selectionStart ?? element.value.length;");
    lines.push("        const end = element.selectionEnd ?? start;");
    lines.push("        element.setRangeText(value, start, end, 'end');");
    lines.push("      } else if (element.isContentEditable || element.getAttribute('contenteditable')) {");
    lines.push("        element.textContent = `${element.textContent ?? ''}${value}`;");
    lines.push("      }");
    lines.push("      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));");
    lines.push("    }, text);");
    lines.push("  }");
  }
  if (usesClipboardDrop) {
    lines.push("  async function dropText(target, text) {");
    lines.push("    await target.evaluate((element, value) => {");
    lines.push("      const dataTransfer = new DataTransfer();");
    lines.push("      dataTransfer.setData('text/plain', value);");
    lines.push("      let dragEnterEvent;");
    lines.push("      let dragOverEvent;");
    lines.push("      let dropEvent;");
    lines.push("      try {");
    lines.push("        dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer });");
    lines.push("        dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });");
    lines.push("        dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });");
    lines.push("      } catch {");
    lines.push("        dragEnterEvent = new Event('dragenter', { bubbles: true, cancelable: true });");
    lines.push("        dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });");
    lines.push("        dropEvent = new Event('drop', { bubbles: true, cancelable: true });");
    lines.push("        Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: dataTransfer });");
    lines.push("        Object.defineProperty(dragOverEvent, 'dataTransfer', { value: dataTransfer });");
    lines.push("        Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });");
    lines.push("      }");
    lines.push("      element.dispatchEvent(dragEnterEvent);");
    lines.push("      element.dispatchEvent(dragOverEvent);");
    lines.push("      const notCanceled = element.dispatchEvent(dropEvent);");
    lines.push("      if (!notCanceled) return;");
    lines.push("      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {");
    lines.push("        const start = element.selectionStart ?? element.value.length;");
    lines.push("        const end = element.selectionEnd ?? start;");
    lines.push("        element.setRangeText(value, start, end, 'end');");
    lines.push("      } else if (element.isContentEditable || element.getAttribute('contenteditable')) {");
    lines.push("        element.textContent = `${element.textContent ?? ''}${value}`;");
    lines.push("      }");
    lines.push("      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop', data: value }));");
    lines.push("    }, text);");
    lines.push("  }");
  }
  const used_locators: GeneratedScript["used_locators"] = [];
  const warnings: string[] = [];
  warnings.push(...contract.limitations.map((limitation) => `workflow limitation: ${limitation}`));
  if (replayBlocked) warnings.push("workflow replay blocked by unsupported browser surface");
  const currentUrlByPage = new Map<string, string>();
  let targetSeq = 0;
  const popupPageByTab = new Map<string, string>();
  const scalarValueReplacements: ScriptValueReplacement[] = [];

  if (replayBlocked) {
    const reason = contract.generatedOutputs.find((output) => output.kind === "playwright")?.notes.join(" ") ||
      "Workflow replay is blocked.";
    lines.push(`  test.skip(true, ${JSON.stringify(reason)});`);
    lines.push("});");
    return { code: lines.join("\n"), mode, workflow_id: contract.workflowId, used_locators, warnings };
  }

  if (mode === "ciIsolated" && firstMutationStepId) {
    lines.push("  test.skip(process.env.ALLOW_WORKFLOW_MUTATION !== '1', 'Set ALLOW_WORKFLOW_MUTATION=1 only inside an isolated resettable replay environment.');");
    lines.push("  if (process.env.ALLOW_WORKFLOW_MUTATION !== '1') throw new Error('missing ALLOW_WORKFLOW_MUTATION=1 for CI-isolated mutation replay');");
    lines.push("  async function recordWorkflowStep(stepId) {");
    lines.push("    const attestationPath = process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION;");
    lines.push("    if (!attestationPath) return;");
    lines.push("    const runId = process.env.SYNTHI_WORKFLOW_CI_RUN_ID;");
    lines.push("    const nonce = process.env.SYNTHI_WORKFLOW_CI_NONCE;");
    lines.push("    if (!runId || !nonce) throw new Error('missing Synthi CI replay attestation identity');");
    lines.push("    await appendFile(attestationPath, JSON.stringify({ step_id: stepId, run_id: runId, nonce, at: Date.now() }) + '\\n', 'utf8');");
    lines.push("  }");
    lines.push("  async function captureWorkflowVisualProof(page) {");
    lines.push("    const proofDir = process.env.SYNTHI_WORKFLOW_VISUAL_PROOF_DIR;");
    lines.push("    if (!proofDir) return;");
    lines.push("    await mkdir(proofDir, { recursive: true });");
    lines.push("    const pages = page.context().pages();");
    lines.push("    for (let index = 0; index < pages.length; index += 1) {");
    lines.push("      const candidate = pages[index];");
    lines.push("      if (candidate.isClosed()) continue;");
    lines.push("      await candidate.screenshot({ path: path.join(proofDir, `page-${index + 1}.png`), fullPage: true });");
    lines.push("    }");
    lines.push("  }");
    warnings.push(`ciIsolated requires ALLOW_WORKFLOW_MUTATION=1 before mutation boundary ${firstMutationStepId}`);
  }

  for (const event of coalesceReplayEvents(orderedEvents)) {
    if (event.kind !== "human_action" && event.kind !== "agent_action" && event.kind !== "navigation") continue;
    if (event.kind === "navigation" || event.action === "navigate") {
      const pageVar = replayPageVariableForEvent(event, popupPageByTab, warnings, lines);
      if (!pageVar) break;
      if (event.url !== currentUrlByPage.get(pageVar)) {
        lines.push(gotoLine(event.url, baseOrigin, pageVar));
        lines.push(`  await expect(${pageVar}).toHaveURL(/.*/);`);
        currentUrlByPage.set(pageVar, event.url);
      }
      continue;
    }

    const locator = event.locator_candidates?.[0];
    if (!locator) {
      warnings.push(`event ${event.event_id} has no locator candidates`);
      continue;
    }
    const pageVar = replayPageVariableForEvent(event, popupPageByTab, warnings, lines);
    if (!pageVar) break;
    if (!currentUrlByPage.has(pageVar)) {
      lines.push(gotoLine(event.url, baseOrigin, pageVar));
      currentUrlByPage.set(pageVar, event.url);
    }
    used_locators.push({
      event_id: event.event_id,
      locator: locator.locator,
      confidence: locator.confidence,
      fallbacks: event.locator_candidates?.slice(1) ?? [],
    });
    targetSeq += 1;
    const target = `target${targetSeq}`;
    const ariaOptionParameter = scriptAriaOptionParameterForEvent(event, valueParameterByEventId, targetSeq);
    let effectValueExpr: string | undefined;
    if (ariaOptionParameter) {
      pushRequiredValueParameter(lines, ariaOptionParameter);
      for (const taughtOptionValue of ariaOptionTaughtValues(event)) {
        rememberScalarValueReplacement(scalarValueReplacements, event, ariaOptionParameter.valueVar, taughtOptionValue);
      }
      const listbox = `listbox${targetSeq}`;
      const listboxExpressions = ariaListboxLocatorExpressionsForEvent(event, pageVar);
      lines.push(`  const ${listbox} = await firstVisible(${listboxExpressions.join(", ")});`);
      lines.push(`  await expect(${listbox}).toBeVisible();`);
      lines.push(`  const ${target} = await ariaOptionByValue(${listbox}, ${ariaOptionParameter.valueVar});`);
      lines.push(`  await expect(${target}).toBeVisible();`);
      effectValueExpr = ariaOptionParameter.valueVar;
      warnings.push(`event ${event.event_id} ARIA option replay is parameterized by ${ariaOptionParameter.envName}`);
    } else {
      const locatorExpressions = (event.locator_candidates ?? [locator]).map((candidate) => locatorExpressionForEvent(event, candidate.locator, pageVar));
      lines.push(`  const ${target} = await firstVisible(${locatorExpressions.join(", ")});`);
      if (allowsHiddenReplayTarget(event)) {
        lines.push(`  await expect(${target}).toBeAttached();`);
      } else {
        lines.push(`  await expect(${target}).toBeVisible();`);
      }
    }
    if ((mode === "prefixOnly" || mode === "coldSession") && firstMutationStepId === event.event_id) {
      lines.push(`  // Mutation boundary: ${event.event_id}. Prefix-only replay verifies reachability but does not commit this action.`);
      lines.push(`  await expect(${target}).toBeEnabled();`);
      warnings.push(`${mode} stopped before mutation boundary ${event.event_id}`);
      break;
    }
    let replayActionEmitted = true;
    let stopReplayGeneration = false;
    const waitsForNetwork = hasReplayNetworkEvent(event);
    if (waitsForNetwork) {
      lines.push(`  await installWorkflowNetworkTracker(${pageVar});`);
    }
    switch (event.action) {
      case "click":
        if (isDownloadTrigger(event)) {
          pushDownloadAction(lines, target, "click", event, targetSeq);
        } else if (isDialogTrigger(event)) {
          pushDialogAction(lines, warnings, pageVar, target, "click", event, targetSeq);
        } else if (isPopupTrigger(event)) {
          const popupVar = pushPopupAction(lines, target, "click", event, targetSeq, baseOrigin, pageVar);
          rememberPopupPage(popupPageByTab, event, popupVar);
          rememberPopupCurrentUrl(currentUrlByPage, event, popupVar);
        } else {
          lines.push(`  await ${clickActionCall(target, "click", event)};`);
        }
        pushOptionSelectionAssertion(lines, target, event);
        pushAriaStateAssertions(lines, target, event);
        break;
      case "dblclick":
        if (isDownloadTrigger(event)) {
          pushDownloadAction(lines, target, "dblclick", event, targetSeq);
        } else if (isDialogTrigger(event)) {
          pushDialogAction(lines, warnings, pageVar, target, "dblclick", event, targetSeq);
        } else if (isPopupTrigger(event)) {
          const popupVar = pushPopupAction(lines, target, "dblclick", event, targetSeq, baseOrigin, pageVar);
          rememberPopupPage(popupPageByTab, event, popupVar);
          rememberPopupCurrentUrl(currentUrlByPage, event, popupVar);
        } else {
          lines.push(`  await ${clickActionCall(target, "dblclick", event)};`);
        }
        pushAriaStateAssertions(lines, target, event);
        break;
      case "contextmenu":
        lines.push(`  await ${clickActionCall(target, "click", event, { button: "right" })};`);
        pushAriaStateAssertions(lines, target, event);
        break;
      case "hover":
        lines.push(`  await ${target}.hover();`);
        break;
      case "copy":
        pushClipboardTransferAction(lines, target, "copy", event);
        break;
      case "cut":
        pushClipboardTransferAction(lines, target, "cut", event);
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
          const envName = clipboardDropEnvNameFor(event, targetSeq);
          const valueVar = `dropText${targetSeq}`;
          lines.push(`  const ${valueVar} = process.env[${JSON.stringify(envName)}];`);
          lines.push(`  test.skip(!${valueVar}, ${JSON.stringify(`Set ${envName} for clipboard drop step ${event.event_id}.`)});`);
          lines.push(`  if (!${valueVar}) throw new Error(${JSON.stringify(`missing clipboard drop text for ${event.event_id}`)});`);
          lines.push(`  await dropText(${target}, ${valueVar});`);
          if (isContentEditableTarget(event)) {
            lines.push(`  await expect(${target}).toContainText(${valueVar});`);
          } else if (isEditableTextTarget(event)) {
            lines.push(`  await expect(${target}).toHaveValue(${valueVar});`);
          }
          warnings.push(`event ${event.event_id} clipboard drop replay is parameterized by ${envName}`);
          break;
        }
        if (isCalibratedPointerDrag(event)) {
          const dropLocator = typeof event.detail?.["drop_locator"] === "string"
            ? event.detail["drop_locator"]
            : event.value;
          if (!dropLocator) {
            pushBlockedReplayStep(lines, warnings, `event ${event.event_id} is a calibrated pointer drag without a durable drop target locator`);
            replayActionEmitted = false;
            stopReplayGeneration = true;
            break;
          }
          const startX = numericDetail(event, "pointer_start_x_ratio");
          const startY = numericDetail(event, "pointer_start_y_ratio");
          const endX = numericDetail(event, "pointer_end_x_ratio");
          const endY = numericDetail(event, "pointer_end_y_ratio");
          if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
            pushBlockedReplayStep(lines, warnings, `event ${event.event_id} is a calibrated pointer drag without complete coordinate ratios`);
            replayActionEmitted = false;
            stopReplayGeneration = true;
            break;
          }
          const dropTarget = `dropTarget${targetSeq}`;
          const sourceBox = `sourceBox${targetSeq}`;
          const dropBox = `dropBox${targetSeq}`;
          const start = {
            x: startX,
            y: startY,
          };
          const end = {
            x: endX,
            y: endY,
          };
          const steps = Math.max(1, Math.min(60, Math.round(numericDetail(event, "pointer_steps") ?? 12)));
          lines.push(`  const ${dropTarget} = await firstVisible(${locatorExpressionForEvent(event, dropLocator, pageVar)});`);
          lines.push(`  await expect(${dropTarget}).toBeVisible();`);
          lines.push(`  const ${sourceBox} = await ${target}.boundingBox();`);
          lines.push(`  const ${dropBox} = await ${dropTarget}.boundingBox();`);
          lines.push(`  if (!${sourceBox} || !${dropBox}) throw new Error(${JSON.stringify(`calibrated pointer drag target not visible for ${event.event_id}`)});`);
          lines.push(`  await page.mouse.move(${sourceBox}.x + ${sourceBox}.width * ${clampedRatioLiteral(start.x)}, ${sourceBox}.y + ${sourceBox}.height * ${clampedRatioLiteral(start.y)});`);
          lines.push("  await page.mouse.down();");
          lines.push(`  await page.mouse.move(${dropBox}.x + ${dropBox}.width * ${clampedRatioLiteral(end.x)}, ${dropBox}.y + ${dropBox}.height * ${clampedRatioLiteral(end.y)}, { steps: ${steps} });`);
          lines.push("  await page.mouse.up();");
          const draggedText = shouldAssertDraggedText(event) ? draggedElementText(event) : null;
          if (draggedText) {
            lines.push(`  await expect(${dropTarget}).toContainText(${JSON.stringify(draggedText)});`);
          }
          break;
        }
          const dropLocator = typeof event.detail?.["drop_locator"] === "string"
            ? event.detail["drop_locator"]
            : event.value;
        if (dropLocator) {
          const dropTarget = `dropTarget${targetSeq}`;
          lines.push(`  const ${dropTarget} = ${locatorExpressionForEvent(event, dropLocator, pageVar)};`);
          lines.push(`  await ${target}.dragTo(${dropTarget});`);
          const draggedText = draggedElementText(event);
          if (draggedText) {
            lines.push(`  await expect(${dropTarget}).toContainText(${JSON.stringify(draggedText)});`);
          }
        } else {
          pushBlockedReplayStep(lines, warnings, `event ${event.event_id} is a drag step without a durable drop target locator`);
          replayActionEmitted = false;
          stopReplayGeneration = true;
        }
        break;
      }
      case "scroll": {
        if (isWheelScrollEvent(event)) {
          pushWheelScrollAction(lines, pageVar, target, event, targetSeq);
        } else {
          const position = scrollPositionFor(event);
          lines.push(`  await ${target}.evaluate((element, position) => {`);
          lines.push("    if (element === document.body || element === document.documentElement) {");
          lines.push("      window.scrollTo(position.left, position.top);");
          lines.push("    } else {");
          lines.push("      element.scrollTo(position.left, position.top);");
          lines.push("    }");
          lines.push(`  }, ${JSON.stringify(position)});`);
        }
        break;
      }
      case "fill":
        if (isClipboardPasteEvent(event)) {
          const envName = clipboardPasteEnvNameFor(event, targetSeq);
          const valueVar = `pasteText${targetSeq}`;
          lines.push(`  const ${valueVar} = process.env[${JSON.stringify(envName)}];`);
          lines.push(`  test.skip(!${valueVar}, ${JSON.stringify(`Set ${envName} for clipboard paste step ${event.event_id}.`)});`);
          lines.push(`  if (!${valueVar}) throw new Error(${JSON.stringify(`missing clipboard paste text for ${event.event_id}`)});`);
          lines.push(`  await pasteText(${pageVar}, ${target}, ${valueVar});`);
          if (isContentEditableFill(event)) {
            lines.push(`  await expect(${target}).toContainText(${valueVar});`);
          } else {
            lines.push(`  await expect(${target}).toHaveValue(${valueVar});`);
          }
          warnings.push(`event ${event.event_id} clipboard paste replay is parameterized by ${envName}`);
        } else if (isRangeControlFill(event)) {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "inputValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.evaluate((element, value) => {`);
          lines.push("    if (!(element instanceof HTMLInputElement) || element.type !== 'range') throw new Error('target_not_range_input');");
          lines.push("    element.value = String(value);");
          lines.push("    element.dispatchEvent(new Event('input', { bubbles: true }));");
          lines.push("    element.dispatchEvent(new Event('change', { bubbles: true }));");
          lines.push(`  }, ${valueExpr});`);
          lines.push(`  await expect(${target}).toHaveValue(${valueExpr});`);
        } else if (isKeyboardTextEntryFill(event)) {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "inputValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.click();`);
          lines.push(`  await page.keyboard.type(${valueExpr});`);
          warnings.push(`event ${event.event_id} uses keyboard typing for a non-editable app surface`);
        } else if (isKeyboardEditorFill(event)) {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "inputValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.click();`);
          lines.push("  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');");
          lines.push("  await page.keyboard.press('Backspace');");
          lines.push(`  await page.keyboard.insertText(${valueExpr});`);
          warnings.push(`event ${event.event_id} uses keyboard insertion for a custom code-editor surface`);
        } else if (isContentEditableFill(event)) {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "inputValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.fill(${valueExpr});`);
          lines.push(`  await expect(${target}).toContainText(${valueExpr});`);
        } else {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "inputValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.fill(${valueExpr});`);
          lines.push(`  await expect(${target}).toHaveValue(${valueExpr});`);
        }
        break;
      case "press":
        if (isDialogTrigger(event)) {
          pushDialogAction(lines, warnings, pageVar, target, "press", event, targetSeq, event.value ?? "Enter");
        } else if (isPopupTrigger(event)) {
          const popupVar = pushPopupAction(lines, target, "press", event, targetSeq, baseOrigin, pageVar, event.value ?? "Enter");
          rememberPopupPage(popupPageByTab, event, popupVar);
          rememberPopupCurrentUrl(currentUrlByPage, event, popupVar);
        } else {
          lines.push(`  await ${target}.press(${JSON.stringify(event.value ?? "Enter")});`);
        }
        break;
      case "select":
        if (isMultipleSelectEvent(event)) {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "selectValues");
          const valuesExpr = valueParameter?.valueVar ?? JSON.stringify(selectValuesForEvent(event));
          if (valueParameter) {
            pushRequiredValueListParameter(lines, valueParameter);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.selectOption(${valuesExpr});`);
          lines.push(`  await expect(${target}).toHaveValues(${valuesExpr});`);
        } else {
          const valueParameter = scriptValueParameterForEvent(event, valueParameterByEventId, targetSeq, "selectValue");
          const valueExpr = valueParameter?.valueVar ?? JSON.stringify(event.value ?? "");
          if (valueParameter) {
            pushRequiredValueParameter(lines, valueParameter);
            effectValueExpr = valueParameter.valueVar;
            rememberScalarValueReplacement(scalarValueReplacements, event, valueParameter.valueVar);
            warnings.push(`event ${event.event_id} value replay is parameterized by ${valueParameter.envName}`);
          }
          lines.push(`  await ${target}.selectOption(${valueExpr});`);
          lines.push(`  await expect(${target}).toHaveValue(${valueExpr});`);
        }
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
        replayActionEmitted = false;
        break;
    }
    if (stopReplayGeneration) break;
    if (waitsForNetwork && replayActionEmitted) {
      lines.push(`  await waitForWorkflowNetworkSettled(${pageVar});`);
    }
    for (const effectText of observedEffectTexts(event)) {
      const effectLocatorSource = parameterizedEffectLocatorSource(effectText, [
        ...scalarValueReplacements,
        ...(effectValueExpr && typeof event.value === "string" ? [{ taughtValue: event.value, valueExpr: effectValueExpr }] : []),
      ]) ??
        `page.getByText(${JSON.stringify(effectText)}, { exact: true })`;
      const effectLocator = locatorExpressionForEvent(
        event,
        effectLocatorSource,
        pageVar
      );
      lines.push(`  await expect(${effectLocator}).toBeVisible();`);
    }
    if (mode === "ciIsolated" && firstMutationStepId && replayActionEmitted) {
      lines.push(`  await recordWorkflowStep(${JSON.stringify(event.event_id)});`);
    }
  }

  if (mode === "ciIsolated" && firstMutationStepId) {
    lines.push("  await captureWorkflowVisualProof(page);");
  }
  lines.push("});");
  return { code: lines.join("\n"), mode, workflow_id: contract.workflowId, used_locators, warnings };
}

function defaultScriptReplayMode(contract: WorkflowContractV7): WorkflowReplayModeV7 {
  if (contract.mutationBoundaryPlan.defaultReplayMode === "prefixOnly") return "prefixOnly";
  if (contract.mutationBoundaryPlan.defaultReplayMode === "ciIsolated") return "coldSession";
  return "sameSession";
}

type ScriptValueParameter = {
  envName: string;
  stepId: string;
  valueVar: string;
};

type ScriptValueReplacement = {
  taughtValue: string;
  valueExpr: string;
};

function scriptValueParameterName(event: BrowserTraceEvent, valueParameterByEventId: Map<string, string>): string | undefined {
  if (event.action !== "fill" && event.action !== "select" && !isAriaOptionSelectionEvent(event)) return undefined;
  if (event.action === "fill" && isClipboardPasteEvent(event)) return undefined;
  const valueRef = valueParameterByEventId.get(event.event_id);
  if (!valueRef) return undefined;
  return valueParameterEnvName(valueRef, event.event_seq || 0);
}

function scriptValueParameterForEvent(
  event: BrowserTraceEvent,
  valueParameterByEventId: Map<string, string>,
  ordinal: number,
  valueVarPrefix: string
): ScriptValueParameter | undefined {
  const envName = scriptValueParameterName(event, valueParameterByEventId);
  if (!envName) return undefined;
  return {
    envName,
    stepId: event.event_id,
    valueVar: `${valueVarPrefix}${ordinal}`,
  };
}

function scriptAriaOptionParameterName(event: BrowserTraceEvent, valueParameterByEventId: Map<string, string>): string | undefined {
  if (!isAriaOptionSelectionEvent(event)) return undefined;
  return scriptValueParameterName(event, valueParameterByEventId);
}

function scriptAriaOptionParameterForEvent(
  event: BrowserTraceEvent,
  valueParameterByEventId: Map<string, string>,
  ordinal: number
): ScriptValueParameter | undefined {
  const envName = scriptAriaOptionParameterName(event, valueParameterByEventId);
  if (!envName) return undefined;
  return {
    envName,
    stepId: event.event_id,
    valueVar: `optionValue${ordinal}`,
  };
}

export function workflowParameterEnvName(valueRef: string, fallbackOrdinal: number = 1): string {
  const normalized = valueRef.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `SYNTHI_WORKFLOW_VALUE_${fallbackOrdinal || 1}`;
}

function valueParameterEnvName(valueRef: string, fallbackOrdinal: number): string {
  return workflowParameterEnvName(valueRef, fallbackOrdinal);
}

function pushRequiredValueParameter(lines: string[], parameter: ScriptValueParameter): void {
  lines.push(`  const ${parameter.valueVar} = readRequiredEnv(${JSON.stringify(parameter.envName)}, ${JSON.stringify(parameter.stepId)});`);
}

function pushRequiredValueListParameter(lines: string[], parameter: ScriptValueParameter): void {
  lines.push(`  const ${parameter.valueVar} = readRequiredEnvList(${JSON.stringify(parameter.envName)}, ${JSON.stringify(parameter.stepId)});`);
}

function rememberScalarValueReplacement(
  replacements: ScriptValueReplacement[],
  event: BrowserTraceEvent,
  valueExpr: string,
  taughtValue: string | undefined = event.value
): void {
  if (typeof taughtValue !== "string" || taughtValue.length === 0) return;
  if (replacements.some((replacement) => replacement.taughtValue === taughtValue && replacement.valueExpr === valueExpr)) return;
  replacements.push({ taughtValue, valueExpr });
}

function parameterizedEffectLocatorSource(effectText: string, replacements: ScriptValueReplacement[]): string | undefined {
  const matches = replacements
    .filter((candidate) => candidate.taughtValue.length > 0)
    .map((candidate) => ({ ...candidate, index: effectText.indexOf(candidate.taughtValue) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (matches.length === 0) return undefined;
  const parts: string[] = [];
  const values: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    const index = effectText.indexOf(match.taughtValue, cursor);
    if (index < cursor) continue;
    parts.push(effectText.slice(cursor, index));
    values.push(match.valueExpr);
    cursor = index + match.taughtValue.length;
  }
  if (values.length === 0) return undefined;
  parts.push(effectText.slice(cursor));
  return `page.getByText(parameterizedTextRegex(${JSON.stringify(parts)}, ${values.join(", ")}))`;
}

function coalesceReplayEvents(events: BrowserTraceEvent[]): BrowserTraceEvent[] {
  const result: BrowserTraceEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous && shouldDropClickAfterDblClick(previous, event)) {
      continue;
    }
    if (previous && shouldDropPressBeforeClipboardPaste(previous, event)) {
      result.pop();
    }
    if (previous && shouldDropPressBeforeClipboardTransfer(previous, event)) {
      result.pop();
    }
    const currentPrevious = result[result.length - 1];
    if (currentPrevious && shouldDropFillAfterClipboardPaste(currentPrevious, event)) {
      result[result.length - 1] = mergeObservedEffectsFromSuppressedEvent(currentPrevious, event);
      continue;
    }
    if (currentPrevious && shouldDropFillAfterClipboardDrop(currentPrevious, event)) {
      result[result.length - 1] = mergeObservedEffectsFromSuppressedEvent(currentPrevious, event);
      continue;
    }
    if (currentPrevious && shouldDropFillAfterClipboardCut(currentPrevious, event)) {
      result[result.length - 1] = mergeObservedEffectsFromSuppressedEvent(currentPrevious, event);
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

function replayPageVariableForEvent(
  event: BrowserTraceEvent,
  popupPageByTab: Map<string, string>,
  warnings: string[],
  lines: string[]
): string | null {
  const pageVar = popupPageByTab.get(event.tab_id);
  if (pageVar) return pageVar;
  if (event.detail?.["popup_context"] === true) {
    const reason = `Popup context for event ${event.event_id} has no opener mapping; regenerate the workflow with popup capture enabled.`;
    warnings.push(reason);
    lines.push(`  test.skip(true, ${JSON.stringify(reason)});`);
    return null;
  }
  return "page";
}

function pushBlockedReplayStep(lines: string[], warnings: string[], reason: string): void {
  warnings.push(reason);
  lines.push(`  test.skip(true, ${JSON.stringify(reason)});`);
}

function mergeObservedEffectsFromSuppressedEvent(target: BrowserTraceEvent, suppressed: BrowserTraceEvent): BrowserTraceEvent {
  if (target.detail?.["observed_effects_redacted"] === true) return target;
  const suppressedEffects = observedEffectTexts(suppressed);
  if (suppressedEffects.length === 0) return target;
  const merged = [...observedEffectTexts(target)];
  for (const effect of suppressedEffects) {
    if (!merged.includes(effect)) merged.push(effect);
  }
  if (merged.length === observedEffectTexts(target).length) return target;
  const detail: Record<string, unknown> = { ...(target.detail ?? {}), observed_effects: merged };
  delete detail["observed_effects_redacted"];
  return { ...target, detail };
}

function shouldDropPressBeforeClipboardPaste(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "press" || !isClipboardPasteEvent(next)) return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  if (!isPasteKeyChord(previous.value)) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  if (elapsedMs > 2000) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return sameOrNestedTargetKey(previousTarget, nextTarget);
}

function shouldDropPressBeforeClipboardTransfer(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "press" || !isClipboardTransferEvent(next)) return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  if (next.action === "copy" && !isCopyKeyChord(previous.value)) return false;
  if (next.action === "cut" && !isCutKeyChord(previous.value)) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  if (elapsedMs > 2000) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return sameOrNestedTargetKey(previousTarget, nextTarget);
}

function shouldDropFillAfterClipboardPaste(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (!isClipboardPasteEvent(previous) || next.action !== "fill") return false;
  if (isClipboardPasteEvent(next)) return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  if (elapsedMs > 2000) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return sameOrNestedTargetKey(previousTarget, nextTarget);
}

function shouldDropFillAfterClipboardCut(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "cut" || next.action !== "fill") return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  if (elapsedMs > 2000) return false;
  return eventsShareDurableTarget(previous, next);
}

function shouldDropFillAfterClipboardDrop(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (!isClipboardDropEvent(previous) || next.action !== "fill") return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  const elapsedMs = Math.abs((next.ts || 0) - (previous.ts || 0));
  if (elapsedMs > 2000) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return sameOrNestedTargetKey(previousTarget, nextTarget);
}

function isPasteKeyChord(value: string | undefined): boolean {
  return value === "Control+V" || value === "Meta+V";
}

function isCopyKeyChord(value: string | undefined): boolean {
  return value === "Control+C" || value === "Meta+C";
}

function isCutKeyChord(value: string | undefined): boolean {
  return value === "Control+X" || value === "Meta+X";
}

function sameOrNestedTargetKey(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function eventsShareDurableTarget(left: BrowserTraceEvent, right: BrowserTraceEvent): boolean {
  const leftTokens = durableTargetTokens(left);
  const rightTokens = durableTargetTokens(right);
  return leftTokens.some((token) => rightTokens.includes(token));
}

function durableTargetTokens(event: BrowserTraceEvent): string[] {
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
    element?.css,
    element?.xpath,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
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

function gotoLine(url: string, baseOrigin: string | null, pageVar = "page"): string {
  return `  await ${pageVar}.goto(${urlExpression(url, baseOrigin)});`;
}

function urlExpression(url: string, baseOrigin: string | null): string {
  if (!baseOrigin) return JSON.stringify(url);
  try {
    const parsed = new URL(url);
    if (parsed.origin === baseOrigin || isPreviewProxyUrl(url)) {
      return `workflowUrl(${JSON.stringify(routePathForGeneratedUrl(parsed))})`;
    }
  } catch {
    // Fall through to literal URL.
  }
  return JSON.stringify(url);
}

function routePathForGeneratedUrl(parsed: URL): string {
  const proxyMatch = parsed.pathname.match(/^\/port\/\d+(\/.*)?$/);
  const path = proxyMatch ? (proxyMatch[1] || "/") : parsed.pathname;
  return `${path}${parsed.search}${parsed.hash}`;
}

function hasReplayNetworkEvent(event: BrowserTraceEvent): boolean {
  if (event.detail?.["network_event"] !== true) return false;
  return true;
}

function isPreviewProxyUrl(url: string): boolean {
  try {
    return /^\/port\/\d+(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function locatorExpressionForEvent(event: BrowserTraceEvent, locator: string, pageVar = "page"): string {
  const rooted = locator.replace(/^page\./, `${pageVar}.`);
  const frameLocatorChain = frameLocatorChainForEvent(event);
  if (frameLocatorChain.length === 0) return rooted;
  const framedRoot = frameLocatorChain.reduce(
    (expr, frameLocator) => `${expr}.frameLocator(${JSON.stringify(frameLocator)})`,
    pageVar
  );
  return rooted.replace(new RegExp(`^${escapeRegExp(pageVar)}\\.`), `${framedRoot}.`);
}

function frameLocatorChainForEvent(event: BrowserTraceEvent): string[] {
  const rawChain = event.detail?.["frame_locator_chain"];
  if (Array.isArray(rawChain)) {
    const chain = rawChain.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (chain.length > 0) return chain;
  }
  const frameLocator = typeof event.detail?.["frame_locator"] === "string" ? event.detail["frame_locator"] : "";
  return frameLocator.trim().length > 0 ? [frameLocator] : [];
}

function rememberPopupPage(popupPageByTab: Map<string, string>, event: BrowserTraceEvent, popupVar: string): void {
  const popupTab = typeof event.detail?.["popup_tab_id"] === "string" ? event.detail["popup_tab_id"] : "";
  if (popupTab) popupPageByTab.set(popupTab, popupVar);
}

function rememberPopupCurrentUrl(currentUrlByPage: Map<string, string>, event: BrowserTraceEvent, popupVar: string): void {
  const popupUrl = typeof event.detail?.["popup_url"] === "string" ? event.detail["popup_url"] : "";
  const popupUrlRedacted = event.detail?.["popup_url_redacted"] === true;
  if (popupUrl && !popupUrlRedacted) currentUrlByPage.set(popupVar, popupUrl);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function clipboardPasteEnvNameFor(event: BrowserTraceEvent, ordinal: number): string {
  const explicit = typeof event.detail?.["paste_parameter"] === "string"
    ? event.detail["paste_parameter"]
    : typeof event.detail?.["clipboard_parameter"] === "string"
      ? event.detail["clipboard_parameter"]
      : `SYNTHI_CLIPBOARD_PASTE_${ordinal}`;
  const normalized = explicit.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `SYNTHI_CLIPBOARD_PASTE_${ordinal}`;
}

function clipboardDropEnvNameFor(event: BrowserTraceEvent, ordinal: number): string {
  const explicit = typeof event.detail?.["drop_parameter"] === "string"
    ? event.detail["drop_parameter"]
    : typeof event.detail?.["clipboard_parameter"] === "string"
      ? event.detail["clipboard_parameter"]
      : `SYNTHI_CLIPBOARD_DROP_${ordinal}`;
  const normalized = explicit.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `SYNTHI_CLIPBOARD_DROP_${ordinal}`;
}

function dialogPromptEnvNameFor(event: BrowserTraceEvent, ordinal: number): string {
  const explicit = typeof event.detail?.["dialog_prompt_env"] === "string"
    ? event.detail["dialog_prompt_env"]
    : typeof event.detail?.["dialog_prompt_parameter"] === "string"
      ? event.detail["dialog_prompt_parameter"]
      : typeof event.detail?.["prompt_parameter"] === "string"
        ? event.detail["prompt_parameter"]
        : event.detail?.["dialog_message_redacted"] === true
          ? `SYNTHI_DIALOG_PROMPT_${ordinal}`
          : typeof event.detail?.["dialog_message"] === "string"
            ? event.detail["dialog_message"]
            : `SYNTHI_DIALOG_PROMPT_${ordinal}`;
  const normalized = explicit.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `SYNTHI_DIALOG_PROMPT_${ordinal}`;
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

function isContentEditableTarget(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return element?.content_editable === true || element?.tag?.toLowerCase() === "div" && element?.role === "textbox";
}

function isEditableTextTarget(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  const tag = element?.tag?.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = element?.type?.toLowerCase() ?? "";
  return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type);
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

function isKeyboardTextEntryFill(event: BrowserTraceEvent): boolean {
  return event.action === "fill" && (
    event.detail?.["keyboard_text_entry"] === true ||
    event.detail?.["text_entry_mode"] === "keyboardInsert"
  );
}

function isClipboardPasteEvent(event: BrowserTraceEvent): boolean {
  return event.action === "fill" && (
    event.detail?.["clipboard_event"] === true ||
    event.detail?.["clipboard_mode"] === "paste" ||
    event.detail?.["paste_event"] === true
  );
}

function isClipboardDropEvent(event: BrowserTraceEvent): boolean {
  return event.action === "drag" && dragClassFor(event) === "clipboarddrop";
}

function isClipboardTransferEvent(event: BrowserTraceEvent): boolean {
  return event.action === "copy" || event.action === "cut";
}

function isMultipleSelectEvent(event: BrowserTraceEvent): boolean {
  if (event.action !== "select") return false;
  if (event.detail?.["multiple_select"] === true) return true;
  return selectValuesForEvent(event).length > 1;
}

function selectValuesForEvent(event: BrowserTraceEvent): string[] {
  const rawValues = event.detail?.["select_values"];
  if (Array.isArray(rawValues)) {
    return rawValues.filter((value): value is string => typeof value === "string");
  }
  if (typeof event.value === "string") {
    try {
      const parsed = JSON.parse(event.value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return event.value ? [event.value] : [];
    }
  }
  return event.value ? [event.value] : [];
}

function isCalibratedPointerDrag(event: BrowserTraceEvent): boolean {
  if (event.action !== "drag") return false;
  const dragClass = dragClassFor(event);
  const isPointer = /pointersensor|pointerdrag|unknowndrag/.test(dragClass) || event.detail?.["pointer_drag"] === true;
  if (!isPointer) return false;
  if (event.detail?.["pointer_replay"] !== "calibrated" && event.detail?.["pointer_calibrated"] !== true) return false;
  return Boolean(event.detail?.["drop_locator"] || event.value);
}

function isResizeHandleDrag(event: BrowserTraceEvent): boolean {
  return event.action === "drag" && (event.detail?.["resize_handle"] === true || event.detail?.["resizeHandle"] === true);
}

function isAriaSliderDrag(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return event.action === "drag" && (
    event.detail?.["aria_slider"] === true ||
    event.detail?.["control_kind"] === "ariaSlider" ||
    element?.role === "slider"
  );
}

function shouldAssertDraggedText(event: BrowserTraceEvent): boolean {
  return !isResizeHandleDrag(event) && !isAriaSliderDrag(event);
}

function clampedRatioLiteral(value: number): string {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  return Number(clamped.toFixed(4)).toString();
}

function clickActionCall(
  target: string,
  method: "click" | "dblclick",
  event: BrowserTraceEvent,
  baseOptions: { button?: "right" } = {}
): string {
  const options = clickOptionsLiteral(event, baseOptions);
  return `${target}.${method}(${options})`;
}

function clickOptionsLiteral(event: BrowserTraceEvent, baseOptions: { button?: "right" } = {}): string {
  const modifiers = clickModifiersFor(event);
  const parts: string[] = [];
  if (baseOptions.button) parts.push(`button: ${JSON.stringify(baseOptions.button)}`);
  if (modifiers.length > 0) parts.push(`modifiers: ${JSON.stringify(modifiers)}`);
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "";
}

function clickModifiersFor(event: BrowserTraceEvent): string[] {
  const allowed = new Set(["Alt", "Control", "Meta", "Shift"]);
  const rawModifiers = event.detail?.["modifiers"];
  if (Array.isArray(rawModifiers)) {
    return rawModifiers.filter((value): value is string => typeof value === "string" && allowed.has(value));
  }
  const raw = event.detail?.["modifier_keys"];
  const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const modifiers: string[] = [];
  if (keys["control"] === true) modifiers.push("Control");
  if (keys["meta"] === true) modifiers.push("Meta");
  if (keys["alt"] === true) modifiers.push("Alt");
  if (keys["shift"] === true) modifiers.push("Shift");
  return modifiers;
}

function pushClipboardTransferAction(lines: string[], target: string, action: "copy" | "cut", event: BrowserTraceEvent): void {
  const range = textSelectionRangeFor(event);
  if (range) {
    lines.push(`  await ${target}.evaluate((element, selection) => {`);
    lines.push("    element.focus();");
    lines.push("    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {");
    lines.push("      const direction = selection.direction === 'backward' || selection.direction === 'forward' ? selection.direction : 'none';");
    lines.push("      element.setSelectionRange(selection.start, selection.end, direction);");
    lines.push("    }");
    lines.push(`  }, ${JSON.stringify(range)});`);
  } else {
    lines.push(`  await ${target}.click();`);
  }
  const macKey = action === "copy" ? "Meta+C" : "Meta+X";
  const otherKey = action === "copy" ? "Control+C" : "Control+X";
  lines.push(`  await page.keyboard.press(process.platform === 'darwin' ? ${JSON.stringify(macKey)} : ${JSON.stringify(otherKey)});`);
}

function textSelectionRangeFor(event: BrowserTraceEvent): { start: number; end: number; direction?: string } | null {
  const start = numericDetail(event, "selection_start");
  const end = numericDetail(event, "selection_end");
  if (start === undefined || end === undefined) return null;
  return {
    start: Math.max(0, Math.round(start)),
    end: Math.max(0, Math.round(end)),
    ...(typeof event.detail?.["selection_direction"] === "string" ? { direction: event.detail["selection_direction"] } : {}),
  };
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
  lines.push(`    ${clickActionCall(target, method, event)},`);
  lines.push("  ]);");
  const filename = typeof event.detail?.["suggested_filename"] === "string" ? event.detail["suggested_filename"] : "";
  const redacted = event.detail?.["suggested_filename_redacted"] === true;
  if (filename && !redacted) {
    lines.push(`  expect(${download}.suggestedFilename()).toBe(${JSON.stringify(filename)});`);
  }
}

function pushDialogAction(
  lines: string[],
  warnings: string[],
  pageVar: string,
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
  const promptParameterized = type === "prompt" && accepted;
  const dialogPromise = `dialog${ordinal}Promise`;
  const dialogMessage = `dialog${ordinal}Message`;
  const promptVar = `dialogPrompt${ordinal}`;
  if (promptParameterized) {
    const envName = dialogPromptEnvNameFor(event, ordinal);
    const fixtureValue = typeof event.detail?.["fixture_prompt_value"] === "string" ? event.detail["fixture_prompt_value"] : undefined;
    lines.push(`  const ${promptVar} = process.env[${JSON.stringify(envName)}]${fixtureValue !== undefined ? ` ?? ${JSON.stringify(fixtureValue)}` : ""};`);
    lines.push(`  test.skip(${promptVar} === undefined, ${JSON.stringify(`Set ${envName} for prompt dialog step ${event.event_id}.`)});`);
    lines.push(`  if (${promptVar} === undefined) throw new Error(${JSON.stringify(`missing prompt dialog value for ${event.event_id}`)});`);
    warnings.push(`event ${event.event_id} prompt dialog replay is parameterized by ${envName}`);
  }
  lines.push(`  let ${dialogMessage} = "";`);
  lines.push(`  const ${dialogPromise} = new Promise((resolve, reject) => {`);
  lines.push(`    ${pageVar}.once('dialog', async (dialog) => {`);
  lines.push("      try {");
  lines.push(`        expect(dialog.type()).toBe(${JSON.stringify(type)});`);
  if (message && !messageRedacted) {
    lines.push(`        expect(dialog.message()).toContain(${JSON.stringify(message)});`);
  }
  lines.push(`        ${dialogMessage} = dialog.message();`);
  if (accepted) {
    if (promptParameterized) {
      lines.push(`        await dialog.accept(${promptVar});`);
    } else if (type === "prompt" && promptValue && !promptRedacted) {
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
    lines.push(`  await ${clickActionCall(target, method, event)};`);
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
  pageVar = "page",
  pressKey?: string
): string {
  const popup = `popup${ordinal}`;
  lines.push(`  const [${popup}] = await Promise.all([`);
  lines.push(`    ${pageVar}.waitForEvent('popup'),`);
  if (method === "press") {
    lines.push(`    ${target}.press(${JSON.stringify(pressKey ?? "Enter")}),`);
  } else {
    lines.push(`    ${clickActionCall(target, method, event)},`);
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
  return popup;
}

function pushOptionSelectionAssertion(lines: string[], target: string, event: BrowserTraceEvent): void {
  if (!isAriaOptionSelectionEvent(event)) return;
  const selected = event.detail?.["selected"] !== false;
  lines.push(`  await expect(${target}).toHaveAttribute('aria-selected', ${JSON.stringify(String(selected))});`);
}

function pushWheelScrollAction(
  lines: string[],
  pageVar: string,
  target: string,
  event: BrowserTraceEvent,
  ordinal: number
): void {
  const box = `wheelBox${ordinal}`;
  const point = wheelPointForEvent(event);
  const delta = wheelDeltaForEvent(event);
  const modifiers = wheelModifiersForEvent(event);
  lines.push(`  const ${box} = await ${target}.boundingBox();`);
  lines.push(`  if (!${box}) throw new Error(${JSON.stringify(`wheel target not visible for ${event.event_id}`)});`);
  lines.push(`  await ${pageVar}.mouse.move(${box}.x + ${box}.width * ${clampedRatioLiteral(point.x)}, ${box}.y + ${box}.height * ${clampedRatioLiteral(point.y)});`);
  if (modifiers.length > 0) {
    lines.push(`  for (const modifier of ${JSON.stringify(modifiers)}) await ${pageVar}.keyboard.down(modifier);`);
    lines.push("  try {");
    lines.push(`    await ${pageVar}.mouse.wheel(${delta.x}, ${delta.y});`);
    lines.push("  } finally {");
    lines.push(`    for (const modifier of ${JSON.stringify([...modifiers].reverse())}) await ${pageVar}.keyboard.up(modifier).catch(() => undefined);`);
    lines.push("  }");
  } else {
    lines.push(`  await ${pageVar}.mouse.wheel(${delta.x}, ${delta.y});`);
  }
}

function isWheelScrollEvent(event: BrowserTraceEvent): boolean {
  return event.action === "scroll" && (
    event.detail?.["wheel_event"] === true ||
    event.detail?.["wheel_replay"] === "mouseWheel"
  );
}

function wheelDeltaForEvent(event: BrowserTraceEvent): { x: number; y: number } {
  return {
    x: Math.round(numericDetail(event, "wheel_delta_x") ?? 0),
    y: Math.round(numericDetail(event, "wheel_delta_y") ?? 0),
  };
}

function wheelPointForEvent(event: BrowserTraceEvent): { x: number; y: number } {
  return {
    x: numericDetail(event, "wheel_client_x_ratio") ?? 0.5,
    y: numericDetail(event, "wheel_client_y_ratio") ?? 0.5,
  };
}

function wheelModifiersForEvent(event: BrowserTraceEvent): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  const allowed = new Set(["Alt", "Control", "Meta", "Shift"]);
  const rawModifiers = event.detail?.["modifiers"];
  if (Array.isArray(rawModifiers)) {
    return rawModifiers.filter((value): value is "Alt" | "Control" | "Meta" | "Shift" =>
      typeof value === "string" && allowed.has(value)
    );
  }
  const raw = event.detail?.["modifier_keys"];
  const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return [
    keys["alt"] === true ? "Alt" : undefined,
    keys["control"] === true ? "Control" : undefined,
    keys["meta"] === true ? "Meta" : undefined,
    keys["shift"] === true ? "Shift" : undefined,
  ].filter((value): value is "Alt" | "Control" | "Meta" | "Shift" => value !== undefined);
}

function ariaListboxLocatorExpressionsForEvent(event: BrowserTraceEvent, pageVar: string): string[] {
  const locators: string[] = [];
  const listboxLocator = typeof event.detail?.["listbox_locator"] === "string" ? event.detail["listbox_locator"] : undefined;
  const listboxName = typeof event.detail?.["listbox_name"] === "string" && event.detail["listbox_name"].trim().length > 0
    ? event.detail["listbox_name"].trim()
    : undefined;
  if (listboxLocator) locators.push(locatorExpressionForEvent(event, listboxLocator, pageVar));
  if (listboxName) {
    locators.push(locatorExpressionForEvent(event, `page.getByRole("listbox", { name: ${JSON.stringify(listboxName)} })`, pageVar));
  }
  const element = elementForEvent(event);
  if (element?.name) {
    locators.push(locatorExpressionForEvent(event, `page.locator("[role=\\\"listbox\\\"]", { hasText: ${JSON.stringify(element.name)} }).first()`, pageVar));
  }
  locators.push(locatorExpressionForEvent(event, `page.locator("[role=\\\"listbox\\\"]").first()`, pageVar));
  return [...new Set(locators)];
}

function ariaOptionTaughtValues(event: BrowserTraceEvent): string[] {
  const element = elementForEvent(event);
  return [
    typeof event.detail?.["option_value"] === "string" ? event.detail["option_value"] : undefined,
    event.value,
    element?.name,
    element?.label,
    element?.text,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function pushAriaStateAssertions(lines: string[], target: string, event: BrowserTraceEvent): void {
  const stateAttrs = [
    ["aria_checked", "aria-checked"],
    ["aria_pressed", "aria-pressed"],
    ["aria_expanded", "aria-expanded"],
    ["aria_selected", "aria-selected"],
  ] as const;
  for (const [detailKey, attrName] of stateAttrs) {
    if (detailKey === "aria_selected" && isAriaOptionSelectionEvent(event)) continue;
    const value = event.detail?.[detailKey];
    if (typeof value !== "string" && typeof value !== "boolean") continue;
    lines.push(`  await expect(${target}).toHaveAttribute(${JSON.stringify(attrName)}, ${JSON.stringify(String(value))});`);
  }
}

function isAriaOptionSelectionEvent(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  return event.action === "click" && (
    event.detail?.["option_select_event"] === true ||
    element?.role === "option" ||
    typeof event.detail?.["listbox_name"] === "string"
  );
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

function allowsHiddenReplayTarget(event: BrowserTraceEvent): boolean {
  return event.action === "drag" && dragClassFor(event) === "filedrop" && isFileInputDrop(event);
}

function elementForEvent(event: BrowserTraceEvent): BrowserElementMetadata | undefined {
  const element = event.detail?.["element"];
  return element && typeof element === "object" && !Array.isArray(element)
    ? element as BrowserElementMetadata
    : undefined;
}

function observedEffectTexts(event: BrowserTraceEvent): string[] {
  if (event.detail?.["observed_effects_redacted"] === true) return [];
  const raw = event.detail?.["observed_effects"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const compact = value.trim().replace(/\s+/g, " ");
    if (compact.includes("[REDACTED]")) continue;
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
