/**
 * Enriched-tier tool surface — ultraplan §Enriched tools.
 *
 * All seven tools route through `currentEnrichedProvider()`. Until phase 2b
 * plugs in a real provider (a11y bridge or synthi-probe), every call
 * returns `enriched_tier_not_available` with a pointer at the capability
 * manifest. The error is advisory, not a correctness bug: `synthi_locate`
 * + `synthi_mouse` still cover every interaction the universal tier
 * supports.
 */

import { session } from "../session.js";
import {
  currentEnrichedProvider,
  enrichedAvailable,
  type EnrichedBbox,
} from "../enriched/provider.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface QueryArgs {
  role?: unknown;
  name_contains?: unknown;
  limit?: unknown;
}
interface ActArgs {
  entity_id?: unknown;
  action?: unknown;
}
interface FillFormArgs {
  fields?: unknown;
}
interface GetLabelsArgs {
  region?: unknown;
  limit?: unknown;
}
interface GetMetricsArgs {
  metric?: unknown;
}
interface ClickTextArgs {
  text?: unknown;
  confirm?: unknown;
}

const VALID_ACT_ACTIONS = ["press", "select", "focus", "toggle"] as const;

function notAvailable(tool: string, hint?: string): ToolResponse {
  return errorResponse("enriched_tier_not_available", {
    tool,
    hint:
      hint ??
      "No a11y bridge or synthi-probe provider is registered for this session. Check `capabilities.enriched_tier.available` on `synthi_attach`.",
  });
}

function requireAttachedAndProvider(tool: string): { ok: false; error: ToolResponse } | { ok: true; provider: ReturnType<typeof currentEnrichedProvider> } {
  const attached = session.get();
  if (!attached) return { ok: false, error: errorResponse("not_attached") };
  if (!enrichedAvailable()) return { ok: false, error: notAvailable(tool) };
  return { ok: true, provider: currentEnrichedProvider() };
}

export async function queryTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as QueryArgs;
  const gate = requireAttachedAndProvider("synthi_query");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const opts: Parameters<typeof p.listEntities>[0] = {};
  if (typeof a.role === "string") opts.role = a.role;
  if (typeof a.name_contains === "string") opts.name_contains = a.name_contains;
  if (typeof a.limit === "number" && Number.isFinite(a.limit) && a.limit > 0) opts.limit = Math.floor(a.limit);
  const entities = await p.listEntities(opts);
  return jsonResponse({ ok: true, entities, provider: p.info() });
}

export async function actTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as ActArgs;
  if (typeof a.entity_id !== "string" || a.entity_id.length === 0) {
    return errorResponse("invalid_args", { field: "entity_id", expected: "non-empty string" });
  }
  const action = a.action;
  if (typeof action !== "string" || !(VALID_ACT_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse("invalid_args", { field: "action", allowed: VALID_ACT_ACTIONS });
  }
  const gate = requireAttachedAndProvider("synthi_act");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const result = await p.dispatchAction(a.entity_id, action as (typeof VALID_ACT_ACTIONS)[number]);
  return jsonResponse({ ok: result.ok, entity_id: a.entity_id, action, ...(result.reason ? { reason: result.reason } : {}) });
}

export async function fillFormTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as FillFormArgs;
  if (!Array.isArray(a.fields) || a.fields.length === 0) {
    return errorResponse("invalid_args", { field: "fields", expected: "non-empty array of {entity_id, value}" });
  }
  const fields: { entity_id: string; value: string }[] = [];
  for (const f of a.fields as unknown[]) {
    const fo = f as { entity_id?: unknown; value?: unknown };
    if (typeof fo.entity_id !== "string" || typeof fo.value !== "string") {
      return errorResponse("invalid_args", { field: "fields[].entity_id/value", expected: "strings" });
    }
    fields.push({ entity_id: fo.entity_id, value: fo.value });
  }
  const gate = requireAttachedAndProvider("synthi_fill_form");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const result = await p.fillForm(fields);
  return jsonResponse({ ok: true, filled: result.filled });
}

export async function clickTextTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as ClickTextArgs;
  if (typeof a.text !== "string" || a.text.length === 0) {
    return errorResponse("invalid_args", { field: "text", expected: "non-empty string" });
  }
  const gate = requireAttachedAndProvider("synthi_click_text");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const entities = await p.listEntities({ name_contains: a.text, limit: 4 });
  if (entities.length === 0) {
    return errorResponse("locator_unresolved", {
      tool: "synthi_click_text",
      text: a.text,
      hint: "No entity in the enriched tree matched this text. Fall back to synthi_locate + synthi_mouse.",
    });
  }
  if (entities.length > 1) {
    return errorResponse("locator_ambiguous", {
      tool: "synthi_click_text",
      text: a.text,
      matches: entities.map((e) => ({ id: e.id, role: e.role, name: e.name, bbox: e.bbox })),
    });
  }
  const entity = entities[0]!;
  const cx = Math.round(entity.bbox.x + entity.bbox.w / 2);
  const cy = Math.round(entity.bbox.y + entity.bbox.h / 2);
  const result = await p.dispatchAction(entity.id, "press");
  return jsonResponse({
    ok: result.ok,
    entity_id: entity.id,
    bbox: entity.bbox,
    click_coords: { x: cx, y: cy },
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

export async function getLabelsTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as GetLabelsArgs;
  let region: EnrichedBbox | undefined;
  if (a.region !== undefined) {
    const r = a.region as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    if (typeof r.x !== "number" || typeof r.y !== "number" || typeof r.w !== "number" || typeof r.h !== "number") {
      return errorResponse("invalid_args", { field: "region", expected: "{x,y,w,h}" });
    }
    region = { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  const limit =
    typeof a.limit === "number" && Number.isFinite(a.limit) && a.limit > 0 ? Math.floor(a.limit) : undefined;
  const gate = requireAttachedAndProvider("synthi_get_labels");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const labels = await p.getLabels(region, limit);
  return jsonResponse({ ok: true, labels, provider: p.info() });
}

export async function getProcessStateTool(_args: unknown): Promise<ToolResponse> {
  const gate = requireAttachedAndProvider("synthi_get_process_state");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const state = await p.getProcessState();
  if (!state) {
    return errorResponse("capability_not_available", {
      tool: "synthi_get_process_state",
      reason: "provider_does_not_expose_process_state",
    });
  }
  return jsonResponse({ ok: true, ...state, provider: p.info() });
}

export async function getMetricsTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as GetMetricsArgs;
  const metric = typeof a.metric === "string" ? a.metric : undefined;
  const gate = requireAttachedAndProvider("synthi_get_metrics");
  if (!gate.ok) return gate.error;
  const p = gate.provider!;
  const metrics = await p.getMetrics(metric);
  return jsonResponse({ ok: true, metrics, provider: p.info() });
}
