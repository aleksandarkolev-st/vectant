/**
 * Substrate-neutral embodied event model.
 *
 * Core module of the universal embodied teaching plan
 * (docs/UNIVERSAL_EMBODIED_TEACHING_PLAN.md).
 *
 * Boundary rules for this directory (src/embodied/):
 * - No imports from ../browser/* or any other adapter. Adapter shapes may be
 *   described structurally here, but never imported.
 * - No scenario nouns: no domain-specific entities, services, or file names.
 *   Semantics enter through schemas and profiles supplied at runtime.
 *
 * Every event carries three orthogonal coordinates:
 * - substrate:  interaction semantics (how the action was expressed)
 * - realm:      authority boundary (under what consent scope)
 * - environment: underlying execution world (what system is actually changed)
 */

export const EMBODIED_EVENT_VERSION = 1 as const;

/** Interaction semantics captured by an adapter. Extensible registry keys. */
export type SubstrateKind =
  | "browser"
  | "terminal"
  | "runtime"
  | "notebook"
  | "game"
  | "kernel"
  | "api"
  | "desktop";

/**
 * Authority boundary. `realm_kind` names the matching discipline's coordinate
 * space (e.g. "origin", "workspace_root", "world", "namespace"); `realm_id`
 * is the exact identity within that space. Matching is equality only — never
 * prefix, suffix, subdomain, or parent traversal.
 */
export interface RealmRef {
  realm_kind: string;
  realm_id: string;
}

/**
 * Underlying execution world. Distinct from realm on purpose: two containers
 * on one host are two realms in one environment; one workspace realm may span
 * several environments.
 */
export interface EnvironmentRef {
  environment_kind: string;
  environment_id: string;
}

export type EmbodiedEventClass = "action" | "observation" | "system";

export type EmbodiedActor =
  | { kind: "human" }
  | { kind: "agent"; agent_id?: string };

export type PrimitiveClass = "discrete" | "continuous";

/**
 * Quantization recorded at capture time. Tolerances are a property of how the
 * human moved, not of replay, so continuous primitives carry them from the
 * start. Units are free strings supplied by adapters ("deg", "m", "tick", ...).
 */
export interface ActionQuantization {
  step?: number;
  tolerance?: number;
  unit?: string;
}

export interface EmbodiedAction {
  /** Substrate-namespaced action vocabulary key (adapter-declared). */
  kind: string;
  primitive_class: PrimitiveClass;
  params?: Record<string, unknown>;
  /** Required for continuous primitives; forbidden noise for discrete ones. */
  quantization?: ActionQuantization;
  /** True when the action is expressed relative to a reference frame rather
   *  than absolute world coordinates, so replay survives tick-rate changes. */
  frame_normalized?: boolean;
}

/** Stability ladder shared across substrates. */
export type AffordanceTier = "T0" | "T1" | "T2" | "T3" | "T4";

export const AFFORDANCE_TIERS: readonly AffordanceTier[] = ["T0", "T1", "T2", "T3", "T4"];

export interface AffordanceCandidate {
  tier: AffordanceTier;
  /** Stable reference resolvable by the adapter that produced it. */
  ref: string;
  confidence?: number;
  reason?: string;
}

/** Reference to State Differ output attached during reduction, not capture. */
export interface StateDeltaRef {
  delta_id: string;
  window_id?: string;
}

/** Evidence quality for causal attribution performed by the State Differ. */
export type AttributionEvidenceKind =
  | "fork_control"
  | "multi_demo_vote"
  | "temporal_only";

// ---------------------------------------------------------------------------
// Legacy browser trace shape (structural description; never imported).
// Mirrors the browser adapter's trace event so conversion can be total and
// lossless. Kept in one place; the compile-time compatibility contract is
// enforced by tests against the real browser types.
// ---------------------------------------------------------------------------

export type BrowserActionKindShape =
  | "click"
  | "dblclick"
  | "contextmenu"
  | "fill"
  | "hover"
  | "drag"
  | "scroll"
  | "copy"
  | "cut"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "navigate"
  | "wait";

export interface BrowserLocatorCandidateShape {
  kind: "role" | "label" | "placeholder" | "test_id" | "text" | "css" | "xpath";
  locator: string;
  confidence: number;
  reason: string;
}

export interface BrowserTraceEventShape {
  event_id: string;
  trace_id: string;
  trace_version: number;
  event_seq: number;
  ts: number;
  tab_id: string;
  frame_id?: string;
  origin: string;
  url: string;
  kind: "human_action" | "agent_action" | "selection" | "navigation" | "console" | "network";
  action?: BrowserActionKindShape;
  selector?: string;
  locator_candidates?: BrowserLocatorCandidateShape[];
  value?: string;
  redacted?: boolean;
  detail?: Record<string, unknown>;
  semantic?: {
    reducer_version: "lane0_deterministic_v1";
    window_id: string;
    trace_id: string;
    trace_version: number;
    group_id: string;
    group_label: string;
    intent: string;
    confidence: "high" | "medium" | "low";
    parameter_name?: string;
    reasons: string[];
  };
  security?: {
    exact_origin_approved: boolean;
    screenshot_approved: boolean;
    diagnostics_approved: boolean;
    auth_checkpoint_approved: boolean;
    frame_origin_approved?: boolean;
    frame_screenshot_approved?: boolean;
    popup_origin_approved?: boolean;
    popup_screenshot_approved?: boolean;
  };
}

/**
 * Fields of the legacy browser event that are NOT promoted to universal
 * fields. Preserved verbatim so reconstruction is exact.
 */
export interface BrowserLegacyFields {
  tab_id: string;
  frame_id?: string;
  url: string;
  /** Original browser event kind; redundant with derived class/actor, kept
   *  for exact reconstruction and cross-checked by tests. */
  kind: BrowserTraceEventShape["kind"];
  selector?: string;
  locator_candidates?: BrowserLocatorCandidateShape[];
  value?: string;
  detail?: Record<string, unknown>;
  semantic?: BrowserTraceEventShape["semantic"];
}

/** Mapping from browser locator kinds to universal stability tiers. */
const BROWSER_LOCATOR_TIER: Record<
  BrowserLocatorCandidateShape["kind"],
  AffordanceTier
> = {
  role: "T2",
  label: "T2",
  test_id: "T2",
  text: "T3",
  placeholder: "T3",
  css: "T4",
  xpath: "T4",
};

// ---------------------------------------------------------------------------
// Universal event
// ---------------------------------------------------------------------------

export interface EmbodiedSecurityFlags {
  /** Interaction happened entirely inside the approved realm. */
  realm_approved?: boolean;
  /** Observation channels were approved for this realm. */
  recording_approved?: boolean;
  /** Escape hatch for substrate-specific flags; core never interpretes these. */
  [flag: string]: boolean | undefined;
}

export interface EmbodiedEvent {
  embodied_version: typeof EMBODIED_EVENT_VERSION;
  event_id: string;
  trace_id: string;
  trace_version: number;
  event_seq: number;
  ts: number;
  substrate: {
    kind: SubstrateKind;
    adapter_version?: string;
  };
  realm: RealmRef;
  environment: EnvironmentRef;
  event_class: EmbodiedEventClass;
  /** Required for actions; absent for pure observations/system events. */
  actor?: EmbodiedActor;
  action?: EmbodiedAction;
  target_affordances?: AffordanceCandidate[];
  state_delta_refs?: StateDeltaRef[];
  observation_refs?: string[];
  redacted?: boolean;
  security?: EmbodiedSecurityFlags;
  /**
   * Source-format preservation block. The universal fields above are
   * canonical; `legacy` keeps every non-promoted original field verbatim so
   * conversion back is exact. Adapters add their own format ids here.
   */
  legacy?: {
    format: "synthi.browser.trace.v1";
    browser?: BrowserLegacyFields;
    [format: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Conversions (pure functions; no IO, no clocks)
// ---------------------------------------------------------------------------

function browserKindToClass(kind: BrowserTraceEventShape["kind"]): EmbodiedEventClass {
  switch (kind) {
    case "human_action":
    case "agent_action":
    case "navigation":
      return "action";
    case "selection":
      return "observation";
    case "console":
    case "network":
      return "system";
  }
}

function browserKindToActor(
  kind: BrowserTraceEventShape["kind"],
): EmbodiedActor | undefined {
  switch (kind) {
    case "human_action":
      return { kind: "human" };
    case "agent_action":
      return { kind: "agent" };
    default:
      return undefined;
  }
}

/** Convert a legacy browser trace event into the universal model. Total: no
 *  field is dropped. Promoted fields are canonical; everything else rides in
 *  `legacy.browser` verbatim. */
export function browserEventToEmbodied(event: BrowserTraceEventShape): EmbodiedEvent {
  const legacy: BrowserLegacyFields = {
    tab_id: event.tab_id,
    ...(event.frame_id !== undefined ? { frame_id: event.frame_id } : {}),
    url: event.url,
    kind: event.kind,
    ...(event.selector !== undefined ? { selector: event.selector } : {}),
    ...(event.locator_candidates !== undefined
      ? { locator_candidates: event.locator_candidates }
      : {}),
    ...(event.value !== undefined ? { value: event.value } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
    ...(event.semantic !== undefined ? { semantic: event.semantic } : {}),
  };

  const target_affordances = event.locator_candidates?.map((candidate) => ({
    tier: BROWSER_LOCATOR_TIER[candidate.kind],
    ref: candidate.locator,
    confidence: candidate.confidence,
    reason: candidate.reason,
  }));

  const action: EmbodiedAction | undefined =
    event.action !== undefined ? { kind: event.action, primitive_class: "discrete" } : undefined;

  const security: EmbodiedSecurityFlags | undefined = event.security
    ? {
        realm_approved: event.security.exact_origin_approved,
        recording_approved:
          event.security.screenshot_approved ||
          event.security.diagnostics_approved ||
          undefined,
        exact_origin_approved: event.security.exact_origin_approved,
        screenshot_approved: event.security.screenshot_approved,
        diagnostics_approved: event.security.diagnostics_approved,
        auth_checkpoint_approved: event.security.auth_checkpoint_approved,
        frame_origin_approved: event.security.frame_origin_approved,
        frame_screenshot_approved: event.security.frame_screenshot_approved,
        popup_origin_approved: event.security.popup_origin_approved,
        popup_screenshot_approved: event.security.popup_screenshot_approved,
      }
    : undefined;

  return {
    embodied_version: EMBODIED_EVENT_VERSION,
    event_id: event.event_id,
    trace_id: event.trace_id,
    trace_version: event.trace_version,
    event_seq: event.event_seq,
    ts: event.ts,
    substrate: { kind: "browser" },
    realm: { realm_kind: "origin", realm_id: event.origin },
    // The hosted-browser session owning the tab is the execution world; the
    // concrete session id is not present on individual trace events, so the
    // environment is identified by the tab's owning surface descriptor.
    environment: { environment_kind: "browser_session", environment_id: event.tab_id },
    event_class: browserKindToClass(event.kind),
    actor: browserKindToActor(event.kind),
    ...(action !== undefined ? { action } : {}),
    ...(target_affordances !== undefined && target_affordances.length > 0
      ? { target_affordances }
      : {}),
    ...(event.redacted !== undefined ? { redacted: event.redacted } : {}),
    ...(security !== undefined ? { security } : {}),
    legacy: {
      format: "synthi.browser.trace.v1",
      browser: legacy,
    },
  };
}

/** Reconstruct the legacy browser event. Returns null for non-browser
 *  events or malformed envelopes. Exact inverse of browserEventToEmbodied. */
export function embodiedToBrowserEvent(
  event: EmbodiedEvent,
): BrowserTraceEventShape | null {
  if (event.substrate.kind !== "browser") return null;
  const legacy = event.legacy?.browser;
  if (!legacy || event.legacy?.format !== "synthi.browser.trace.v1") return null;

  const security: BrowserTraceEventShape["security"] | undefined = event.security
    ? {
        exact_origin_approved: event.security.exact_origin_approved === true,
        screenshot_approved: event.security.screenshot_approved === true,
        diagnostics_approved: event.security.diagnostics_approved === true,
        auth_checkpoint_approved: event.security.auth_checkpoint_approved === true,
        ...(event.security.frame_origin_approved !== undefined
          ? { frame_origin_approved: event.security.frame_origin_approved }
          : {}),
        ...(event.security.frame_screenshot_approved !== undefined
          ? { frame_screenshot_approved: event.security.frame_screenshot_approved }
          : {}),
        ...(event.security.popup_origin_approved !== undefined
          ? { popup_origin_approved: event.security.popup_origin_approved }
          : {}),
        ...(event.security.popup_screenshot_approved !== undefined
          ? { popup_screenshot_approved: event.security.popup_screenshot_approved }
          : {}),
      }
    : undefined;

  return {
    event_id: event.event_id,
    trace_id: event.trace_id,
    trace_version: event.trace_version,
    event_seq: event.event_seq,
    ts: event.ts,
    tab_id: legacy.tab_id,
    ...(legacy.frame_id !== undefined ? { frame_id: legacy.frame_id } : {}),
    origin: event.realm.realm_kind === "origin" ? event.realm.realm_id : "",
    url: legacy.url,
    kind: legacy.kind,
    ...(event.action !== undefined && isBrowserActionKind(event.action.kind)
      ? { action: event.action.kind }
      : {}),
    ...(legacy.selector !== undefined ? { selector: legacy.selector } : {}),
    ...(legacy.locator_candidates !== undefined
      ? { locator_candidates: legacy.locator_candidates }
      : {}),
    ...(legacy.value !== undefined ? { value: legacy.value } : {}),
    ...(event.redacted !== undefined ? { redacted: event.redacted } : {}),
    ...(legacy.detail !== undefined ? { detail: legacy.detail } : {}),
    ...(legacy.semantic !== undefined ? { semantic: legacy.semantic } : {}),
    ...(security !== undefined ? { security } : {}),
  };
}

function isBrowserActionKind(kind: string): kind is BrowserActionKindShape {
  const known: readonly string[] = [
    "click",
    "dblclick",
    "contextmenu",
    "fill",
    "hover",
    "drag",
    "scroll",
    "copy",
    "cut",
    "press",
    "select",
    "check",
    "uncheck",
    "navigate",
    "wait",
  ];
  return known.includes(kind);
}

/** Validate the continuous-action quantization invariant: continuous
 *  primitives carry quantization; discrete ones do not need it. */
export function validateEmbodiedAction(action: EmbodiedAction): string[] {
  const problems: string[] = [];
  if (action.primitive_class === "continuous" && !action.quantization) {
    problems.push("continuous action missing quantization");
  }
  if (
    action.quantization?.tolerance !== undefined &&
    action.quantization.tolerance < 0
  ) {
    problems.push("negative tolerance");
  }
  if (
    action.quantization?.step !== undefined &&
    action.quantization.step <= 0
  ) {
    problems.push("non-positive quantization step");
  }
  return problems;
}
