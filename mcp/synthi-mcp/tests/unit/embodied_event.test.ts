import { describe, expect, it } from "vitest";
import {
  AFFORDANCE_TIERS,
  type AffordanceCandidate,
  type BrowserLocatorCandidateShape,
  type BrowserTraceEventShape,
  browserEventToEmbodied,
  embodiedToBrowserEvent,
  type EmbodiedAction,
  type EmbodiedEvent,
  EMBODIED_EVENT_VERSION,
  validateEmbodiedAction,
} from "../../src/embodied/event.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Deterministic generator. Values are generic identifiers only: the core must
// not care what the world contains, so the tests must not teach it anything.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_KINDS: BrowserTraceEventShape["kind"][] = [
  "human_action",
  "agent_action",
  "selection",
  "navigation",
  "console",
  "network",
];

const ALL_ACTIONS: NonNullable<BrowserTraceEventShape["action"]>[] = [
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

const ALL_LOCATOR_KINDS: BrowserLocatorCandidateShape["kind"][] = [
  "role",
  "label",
  "placeholder",
  "test_id",
  "text",
  "css",
  "xpath",
];

const LOCATOR_TIER: Record<BrowserLocatorCandidateShape["kind"], string> = {
  role: "T2",
  label: "T2",
  placeholder: "T3",
  test_id: "T2",
  text: "T3",
  css: "T4",
  xpath: "T4",
};

function makeLocatorCandidates(
  rand: () => number,
): BrowserLocatorCandidateShape[] | undefined {
  const roll = rand();
  if (roll < 0.3) return undefined;
  const count = 1 + Math.floor(rand() * 3);
  const candidates: BrowserLocatorCandidateShape[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = ALL_LOCATOR_KINDS[Math.floor(rand() * ALL_LOCATOR_KINDS.length)];
    candidates.push({
      kind,
      locator: `ref-${Math.floor(rand() * 1e6)}`,
      confidence: rand(),
      reason: `reason-${i}`,
    });
  }
  return candidates;
}

function makeSecurity(rand: () => number): BrowserTraceEventShape["security"] {
  const roll = rand();
  if (roll < 0.25) return undefined;
  const flag = () => rand() < 0.5;
  return {
    exact_origin_approved: flag(),
    screenshot_approved: flag(),
    diagnostics_approved: flag(),
    auth_checkpoint_approved: flag(),
    frame_origin_approved: flag(),
    frame_screenshot_approved: flag(),
    popup_origin_approved: flag(),
    popup_screenshot_approved: flag(),
  };
}

function makeSemantic(rand: () => number): BrowserTraceEventShape["semantic"] {
  if (rand() < 0.5) return undefined;
  const confidence = ["high", "medium", "low"] as const;
  return {
    reducer_version: "lane0_deterministic_v1",
    window_id: `win-${Math.floor(rand() * 1e6)}`,
    trace_id: `trace-${Math.floor(rand() * 1e6)}`,
    trace_version: 1 + Math.floor(rand() * 5),
    group_id: `grp-${Math.floor(rand() * 1e6)}`,
    group_label: `label-${Math.floor(rand() * 1e6)}`,
    intent: `intent-${Math.floor(rand() * 1e6)}`,
    confidence: confidence[Math.floor(rand() * 3)],
    parameter_name: rand() < 0.5 ? `param-${Math.floor(rand() * 1e6)}` : undefined,
    reasons: [`r-${Math.floor(rand() * 1e6)}`, `r-${Math.floor(rand() * 1e6)}`],
  };
}

function makeRandomBrowserEvent(rand: () => number, seq: number): BrowserTraceEventShape {
  const kind = ALL_KINDS[Math.floor(rand() * ALL_KINDS.length)];
  const withAction = rand() < 0.6;
  return {
    event_id: `evt-${seq}-${Math.floor(rand() * 1e9)}`,
    trace_id: `trace-${Math.floor(rand() * 1e6)}`,
    trace_version: 1 + Math.floor(rand() * 9),
    event_seq: seq,
    ts: Math.floor(rand() * 2e12),
    tab_id: `tab-${Math.floor(rand() * 1e6)}`,
    frame_id: rand() < 0.4 ? `frame-${Math.floor(rand() * 1e6)}` : undefined,
    origin: `https://host-${Math.floor(rand() * 1e6)}.example:${8000 + Math.floor(rand() * 100)}`,
    url: `https://host-${Math.floor(rand() * 1e6)}.example/path/${Math.floor(rand() * 1e6)}`,
    kind,
    action: withAction ? ALL_ACTIONS[Math.floor(rand() * ALL_ACTIONS.length)] : undefined,
    selector: rand() < 0.5 ? `sel-${Math.floor(rand() * 1e6)}` : undefined,
    locator_candidates: makeLocatorCandidates(rand),
    value: rand() < 0.4 ? `value-${Math.floor(rand() * 1e6)}` : undefined,
    redacted: rand() < 0.5 ? true : undefined,
    detail: rand() < 0.4 ? { n: Math.floor(rand() * 1e6), nested: { k: `v-${seq}` } } : undefined,
    semantic: makeSemantic(rand),
    security: makeSecurity(rand),
  };
}

// ---------------------------------------------------------------------------
// Lossless round-trip
// ---------------------------------------------------------------------------

describe("embodied event: browser round-trip matrix", () => {
  it("round-trips every kind x action combination exactly", () => {
    for (const kind of ALL_KINDS) {
      for (const action of ALL_ACTIONS) {
        const event: BrowserTraceEventShape = {
          event_id: `evt-${kind}-${action}`,
          trace_id: "trace-matrix",
          trace_version: 3,
          event_seq: 7,
          ts: 1760000000000,
          tab_id: "tab-1",
          origin: "https://app.example:8443",
          url: "https://app.example:8443/page",
          kind,
          action,
          security: {
            exact_origin_approved: true,
            screenshot_approved: true,
            diagnostics_approved: false,
            auth_checkpoint_approved: false,
          },
        };
        const embodied = browserEventToEmbodied(event);
        const back = embodiedToBrowserEvent(embodied);
        expect(back).toEqual(event);
      }
    }
  });

  it("round-trips 200 randomized events exactly", () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 200; i += 1) {
      const event = makeRandomBrowserEvent(rand, i);
      const embodied = browserEventToEmbodied(event);
      const back = embodiedToBrowserEvent(embodied);
      expect(back).toEqual(event);
    }
  });

  it("preserves optional-field absence vs undefined semantics", () => {
    const minimal: BrowserTraceEventShape = {
      event_id: "evt-min",
      trace_id: "trace-min",
      trace_version: 1,
      event_seq: 0,
      ts: 1,
      tab_id: "tab-min",
      origin: "https://min.example",
      url: "https://min.example/",
      kind: "human_action",
    };
    const back = embodiedToBrowserEvent(browserEventToEmbodied(minimal));
    expect(back).toEqual(minimal);
    expect("frame_id" in back).toBe(false);
    expect("action" in back).toBe(false);
    expect("redacted" in back).toBe(false);
    expect("security" in back).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Universal field semantics
// ---------------------------------------------------------------------------

describe("embodied event: universal fields", () => {
  it("maps coordinates: substrate browser, realm origin, environment session", () => {
    const event = browserEventToEmbodied({
      event_id: "e1",
      trace_id: "t1",
      trace_version: 1,
      event_seq: 1,
      ts: 1,
      tab_id: "tab-9",
      origin: "https://x.example:1234",
      url: "https://x.example:1234/a",
      kind: "human_action",
      action: "click",
    });
    expect(event.embodied_version).toBe(EMBODIED_EVENT_VERSION);
    expect(event.substrate.kind).toBe("browser");
    expect(event.realm).toEqual({ realm_kind: "origin", realm_id: "https://x.example:1234" });
    expect(event.environment.environment_kind).toBe("browser_session");
    expect(event.event_class).toBe("action");
    expect(event.actor).toEqual({ kind: "human" });
    expect(event.action).toEqual({ kind: "click", primitive_class: "discrete" });
  });

  it("maps event kinds to classes and actors", () => {
    const expectClassActor = (
      kind: BrowserTraceEventShape["kind"],
      eventClass: string,
      actor: Record<string, unknown> | undefined,
    ) => {
      const embodied = browserEventToEmbodied({
        event_id: "e",
        trace_id: "t",
        trace_version: 1,
        event_seq: 1,
        ts: 1,
        tab_id: "tab",
        origin: "https://x.example",
        url: "https://x.example/",
        kind,
      });
      expect(embodied.event_class).toBe(eventClass);
      expect(embodied.actor).toEqual(actor);
    };
    expectClassActor("human_action", "action", { kind: "human" });
    expectClassActor("agent_action", "action", { kind: "agent" });
    expectClassActor("navigation", "action", undefined);
    expectClassActor("selection", "observation", undefined);
    expectClassActor("console", "system", undefined);
    expectClassActor("network", "system", undefined);
  });

  it("maps every locator kind to its stability tier", () => {
    const candidates: BrowserLocatorCandidateShape[] = ALL_LOCATOR_KINDS.map((kind) => ({
      kind,
      locator: `loc-${kind}`,
      confidence: 0.5,
      reason: "r",
    }));
    const embodied = browserEventToEmbodied({
      event_id: "e",
      trace_id: "t",
      trace_version: 1,
      event_seq: 1,
      ts: 1,
      tab_id: "tab",
      origin: "https://x.example",
      url: "https://x.example/",
      kind: "human_action",
      action: "click",
      locator_candidates: candidates,
    });
    expect(embodied.target_affordances).toHaveLength(ALL_LOCATOR_KINDS.length);
    for (const affordance of embodied.target_affordances ?? []) {
      expect(affordance.tier).toBe(LOCATOR_TIER[candidates.find((c) => c.locator === affordance.ref)!.kind]);
      expect(AFFORDANCE_TIERS).toContain(affordance.tier);
    }
  });

  it("carries browser security flags without losing any", () => {
    const embodied = browserEventToEmbodied({
      event_id: "e",
      trace_id: "t",
      trace_version: 1,
      event_seq: 1,
      ts: 1,
      tab_id: "tab",
      origin: "https://x.example",
      url: "https://x.example/",
      kind: "human_action",
      action: "fill",
      security: {
        exact_origin_approved: true,
        screenshot_approved: false,
        diagnostics_approved: true,
        auth_checkpoint_approved: false,
        popup_origin_approved: true,
      },
    });
    expect(embodied.security).toMatchObject({
      realm_approved: true,
      exact_origin_approved: true,
      screenshot_approved: false,
      diagnostics_approved: true,
      auth_checkpoint_approved: false,
      popup_origin_approved: true,
    });
    const back = embodiedToBrowserEvent(embodied)!;
    expect(back.security).toEqual({
      exact_origin_approved: true,
      screenshot_approved: false,
      diagnostics_approved: true,
      auth_checkpoint_approved: false,
      popup_origin_approved: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Rejection behavior
// ---------------------------------------------------------------------------

describe("embodied event: reconstruction guards", () => {
  it("returns null for non-browser substrates", () => {
    const event: EmbodiedEvent = {
      embodied_version: EMBODIED_EVENT_VERSION,
      event_id: "e",
      trace_id: "t",
      trace_version: 1,
      event_seq: 1,
      ts: 1,
      substrate: { kind: "terminal" },
      realm: { realm_kind: "workspace_root", realm_id: "/w" },
      environment: { environment_kind: "pod", environment_id: "p1" },
      event_class: "action",
      action: { kind: "exec", primitive_class: "discrete" },
      legacy: { format: "synthi.terminal.v1" },
    };
    expect(embodiedToBrowserEvent(event)).toBeNull();
  });

  it("returns null when the legacy envelope is missing or mismatched", () => {
    const base = browserEventToEmbodied({
      event_id: "e",
      trace_id: "t",
      trace_version: 1,
      event_seq: 1,
      ts: 1,
      tab_id: "tab",
      origin: "https://x.example",
      url: "https://x.example/",
      kind: "human_action",
    });
    expect(embodiedToBrowserEvent({ ...base, legacy: undefined })).toBeNull();
    expect(
      embodiedToBrowserEvent({
        ...base,
        legacy: { format: "synthi.unknown.v1" },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Continuous-action invariants
// ---------------------------------------------------------------------------

describe("embodied action validation", () => {
  it("requires quantization on continuous primitives", () => {
    const action: EmbodiedAction = { kind: "turn", primitive_class: "continuous" };
    expect(validateEmbodiedAction(action)).toContain("continuous action missing quantization");
    expect(
      validateEmbodiedAction({
        ...action,
        quantization: { step: 5, tolerance: 2, unit: "deg" },
      }),
    ).toEqual([]);
  });

  it("rejects negative tolerance and non-positive steps", () => {
    expect(
      validateEmbodiedAction({
        kind: "a",
        primitive_class: "continuous",
        quantization: { tolerance: -1 },
      }),
    ).toContain("negative tolerance");
    expect(
      validateEmbodiedAction({
        kind: "a",
        primitive_class: "continuous",
        quantization: { step: 0 },
      }),
    ).toContain("non-positive quantization step");
  });

  it("accepts discrete primitives without quantization", () => {
    expect(validateEmbodiedAction({ kind: "press", primitive_class: "discrete" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Import boundary: the core must not import adapter modules.
// ---------------------------------------------------------------------------

describe("embodied core import boundary", () => {
  it("event.ts imports no adapter modules", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/event.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    expect(source).not.toMatch(/require\(/);
  });

  it("core source contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/event.ts", import.meta.url)),
      "utf8",
    ).toLowerCase();
    for (const noun of ["door", "purple", "nginx", "toast", "invoice", "dashboard"]) {
      expect(source).not.toContain(noun);
    }
  });
});

// Unused import guard for AffordanceCandidate type used above in docs of tiers.
export type { AffordanceCandidate };
