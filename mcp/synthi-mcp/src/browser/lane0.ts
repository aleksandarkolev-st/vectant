import type { BrowserTraceEvent, BrowserTraceSemanticAnnotation } from "./types.js";

export interface Lane0WindowV7 {
  window_id: string;
  trace_id: string;
  trace_version: number;
  event_seq_range: [number, number];
  event_ids: string[];
  focus_event_id: string;
  flush_reason: "slidingWindow" | "navigation" | "mutationSignal" | "explicitHover" | "dragIntent";
}

export interface Lane0StatusV7 {
  trace_id: string | null;
  trace_version: number | null;
  reducer_version: BrowserTraceSemanticAnnotation["reducer_version"];
  event_count: number;
  actionable_event_count: number;
  window_count: number;
  annotated_event_count: number;
  unresolved_event_count: number;
  stale_annotation_count: number;
  last_event_seq: number;
    flush_policy: {
      window_size: number;
      immediate_flush_on: Array<"navigation" | "mutationSignal" | "explicitHover" | "dragIntent">;
  };
}

export interface Lane0ReductionV7 {
  events: BrowserTraceEvent[];
  windows: Lane0WindowV7[];
  status: Lane0StatusV7;
}

const REDUCER_VERSION: BrowserTraceSemanticAnnotation["reducer_version"] = "lane0_deterministic_v1";
const WINDOW_RADIUS = 2;
const WINDOW_SIZE = WINDOW_RADIUS * 2 + 1;

const MUTATION_WORDS = /\b(create|add|new|invite|save|update|submit|apply|confirm|delete|remove|archive|send|charge|pay|refund|deploy|publish|merge)\b/i;

export function reduceLane0Windows(events: BrowserTraceEvent[]): Lane0ReductionV7 {
  const ordered = [...events].sort((a, b) => (a.event_seq || 0) - (b.event_seq || 0));
  const actionable = ordered.filter(isActionable);
  const annotated = new Map<string, BrowserTraceSemanticAnnotation>();
  const windows: Lane0WindowV7[] = [];
  const last = ordered[ordered.length - 1];
  const traceId = last?.trace_id ?? actionable[0]?.trace_id ?? null;
  const traceVersion = last?.trace_version ?? actionable[0]?.trace_version ?? null;

  actionable.forEach((event, index) => {
    const windowEvents = actionable.slice(Math.max(0, index - WINDOW_RADIUS), index + WINDOW_RADIUS + 1);
    const window = windowFor(event, windowEvents);
    windows.push(window);
    annotated.set(event.event_id, annotationFor(event, windowEvents, window));
  });

  const reducedEvents = ordered.map((event) => {
    const semantic = annotated.get(event.event_id);
    return semantic ? { ...event, semantic } : { ...event };
  });
  return {
    events: reducedEvents,
    windows,
    status: {
      trace_id: traceId,
      trace_version: traceVersion,
      reducer_version: REDUCER_VERSION,
      event_count: ordered.length,
      actionable_event_count: actionable.length,
      window_count: windows.length,
      annotated_event_count: annotated.size,
      unresolved_event_count: reducedEvents.filter((event) => isActionable(event) && !event.semantic).length,
      stale_annotation_count: 0,
      last_event_seq: last?.event_seq ?? 0,
      flush_policy: {
        window_size: WINDOW_SIZE,
        immediate_flush_on: ["navigation", "mutationSignal", "explicitHover", "dragIntent"],
      },
    },
  };
}

export function lane0Status(events: BrowserTraceEvent[]): Lane0StatusV7 {
  return reduceLane0Windows(events).status;
}

function windowFor(event: BrowserTraceEvent, events: BrowserTraceEvent[]): Lane0WindowV7 {
  const first = events[0] ?? event;
  const last = events[events.length - 1] ?? event;
  return {
    window_id: `lane0_w_${event.trace_version}_${first.event_seq}_${last.event_seq}_${event.event_seq}`,
    trace_id: event.trace_id,
    trace_version: event.trace_version,
    event_seq_range: [first.event_seq, last.event_seq],
    event_ids: events.map((candidate) => candidate.event_id),
    focus_event_id: event.event_id,
    flush_reason: event.kind === "navigation" || event.action === "navigate"
      ? "navigation"
      : event.action === "hover" ? "explicitHover"
      : event.action === "drag" ? "dragIntent"
      : isMutationSignal(event) ? "mutationSignal" : "slidingWindow",
  };
}

function annotationFor(event: BrowserTraceEvent, windowEvents: BrowserTraceEvent[], window: Lane0WindowV7): BrowserTraceSemanticAnnotation {
  const target = targetLabel(event);
  const groupLabel = groupLabelFor(event, windowEvents);
  const parameterName = event.action === "fill" || event.action === "select" ? parameterNameFor(event, target) : undefined;
  const reasons = reasonsFor(event, windowEvents, parameterName);
  return {
    reducer_version: REDUCER_VERSION,
    window_id: window.window_id,
    trace_id: event.trace_id,
    trace_version: event.trace_version,
    group_id: `grp_${event.trace_version}_${slug(groupLabel)}`,
    group_label: groupLabel,
    intent: intentFor(event, target, groupLabel),
    confidence: confidenceFor(event, reasons),
    ...(parameterName ? { parameter_name: parameterName } : {}),
    reasons,
  };
}

function groupLabelFor(event: BrowserTraceEvent, windowEvents: BrowserTraceEvent[]): string {
  const mutation = windowEvents.find(isMutationSignal);
  if (mutation) return `${targetLabel(mutation)} workflow`;
  const fills = windowEvents.filter((candidate) => candidate.action === "fill" || candidate.action === "select");
  if (fills.length >= 2) return "form input workflow";
  if (event.action === "fill" || event.action === "select") return `${targetLabel(event)} input workflow`;
  return `${targetLabel(event)} step`;
}

function intentFor(event: BrowserTraceEvent, target: string, groupLabel: string): string {
  if (event.kind === "navigation" || event.action === "navigate") return `Reach ${routeName(event.url)}`;
  switch (event.action) {
    case "fill":
    case "select":
      return `Provide ${target} for ${groupLabel}`;
    case "click":
      return isMutationSignal(event) ? `Commit ${groupLabel}` : `Activate ${target}`;
    case "hover":
      return `Reveal or inspect ${target}`;
    case "drag":
      return `Drag ${target}`;
    case "press":
      return `Press key for ${target}`;
    case "check":
    case "uncheck":
      return `Set ${target}`;
    case "wait":
      return `Wait for ${target}`;
    default:
      return `Perform ${event.action ?? "action"} on ${target}`;
  }
}

function reasonsFor(event: BrowserTraceEvent, windowEvents: BrowserTraceEvent[], parameterName: string | undefined): string[] {
  const reasons: string[] = [];
  if (parameterName) reasons.push("adjacent_field_context_parameter");
  if (windowEvents.some(isMutationSignal)) reasons.push("window_contains_mutation_signal");
  if (windowEvents.some((candidate) => candidate.action === "fill" || candidate.action === "select")) reasons.push("window_contains_form_input");
  if (event.kind === "navigation" || event.action === "navigate") reasons.push("navigation_immediate_flush");
  if (event.action === "hover") reasons.push("explicit_hover_intent");
  if (event.action === "drag") reasons.push("drag_mode_intent");
  if (event.locator_candidates?.[0]) reasons.push("locator_candidate_available");
  if (elementFor(event)?.source_id) reasons.push("source_identity_available");
  if (reasons.length === 0) reasons.push("deterministic_fallback");
  return reasons;
}

function confidenceFor(event: BrowserTraceEvent, reasons: string[]): BrowserTraceSemanticAnnotation["confidence"] {
  if (reasons.includes("source_identity_available")) return "high";
  if (event.locator_candidates?.[0]?.confidence !== undefined && event.locator_candidates[0].confidence >= 0.85) return "high";
  if (event.locator_candidates?.[0]) return "medium";
  return "low";
}

function parameterNameFor(event: BrowserTraceEvent, target: string): string {
  const fieldName = typeof event.detail?.["field_name"] === "string" ? event.detail["field_name"] : undefined;
  const element = elementFor(event);
  return slug(fieldName || element?.label || element?.name || element?.placeholder || element?.test_id || target);
}

function isActionable(event: BrowserTraceEvent): boolean {
  return event.kind === "human_action" || event.kind === "agent_action" || event.kind === "navigation";
}

function isMutationSignal(event: BrowserTraceEvent): boolean {
  if (event.kind === "navigation" || event.action === "navigate") return false;
  if (String(event.detail?.["network_method"] ?? "").match(/^(POST|PUT|PATCH|DELETE)$/i)) return true;
  return event.action === "click" && MUTATION_WORDS.test(targetLabel(event));
}

function targetLabel(event: BrowserTraceEvent): string {
  const element = elementFor(event);
  if (element?.label) return element.label;
  if (element?.name) return element.name;
  if (element?.text) return compactText(element.text);
  if (element?.placeholder) return element.placeholder;
  if (element?.test_id) return element.test_id;
  if (event.selector) return event.selector;
  if (event.kind === "navigation") return routeName(event.url);
  return "recorded target";
}

function elementFor(event: BrowserTraceEvent) {
  const element = event.detail?.["element"];
  return element && typeof element === "object" ? element as {
    label?: string;
    name?: string;
    text?: string;
    placeholder?: string;
    test_id?: string;
    source_id?: string;
  } : undefined;
}

function routeName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || parsed.origin;
  } catch {
    return url;
  }
}

function slug(value: string): string {
  const words = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return words || "value";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
