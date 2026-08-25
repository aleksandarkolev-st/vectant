/**
 * Depth pass: randomized invariant tests over the core's pure modules.
 * These complement the per-world conformance suites by attacking the CORE
 * directly with adversarial/random inputs and cross-checking it against
 * independent naive implementations (oracles).
 */
import { describe, expect, it } from "vitest";
import {
  denyRealmCapability,
  emptyRealmConsentRecord,
  evaluateRealmConsent,
  grantRealmCapability,
  revokeAllRealmCapabilities,
  revokeRealmCapability,
  sameRealm,
  type RealmConsentRecord,
} from "../../src/embodied/consent.js";
import {
  browserEventToEmbodied,
  embodiedToBrowserEvent,
} from "../../src/embodied/event.js";
import { runStateDiffer } from "../../src/embodied/state_differ/index.js";
import type { ChangedValue } from "../../src/embodied/world_state.js";
import type { WorldStateSchema } from "../../src/embodied/world_state.js";
import { authorizeRun, type CompetencyLicense } from "../../src/embodied/governance.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------
// Consent oracle: naive reference model vs the real implementation
// ---------------------------------------------------------------------------

type Op =
  | { kind: "grant"; capability: "observe" | "record" | "act" }
  | { kind: "deny"; capability: "observe" | "record" | "act" }
  | { kind: "revoke"; capability: "observe" | "record" | "act" }
  | { kind: "revoke_all" };

/** Naive model: last-op-wins per capability. */
function oracleApply(record: RealmConsentRecord, ops: Op[]): Map<string, string> {
  const state = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === "grant") state.set(op.capability, "granted");
    else if (op.kind === "deny") state.set(op.capability, "denied");
    else if (op.kind === "revoke") state.set(op.capability, "unset");
    else {
      state.set("observe", "unset");
      state.set("record", "unset");
      state.set("act", "unset");
    }
  }
  return state;
}

const REALM = { realm_kind: "test.kind", realm_id: "r-1" };

describe("consent oracle agreement under random op sequences", () => {
  it("matches the naive model on 300 randomized sequences", () => {
    const rand = mulberry32(1234);
    const capabilities = ["observe", "record", "act"] as const;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      let record = emptyRealmConsentRecord(REALM, "agent");
      const ops: Op[] = [];
      const length = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < length; i += 1) {
        const roll = rand();
        const capability = capabilities[Math.floor(rand() * 3)] as
          | "observe"
          | "record"
          | "act";
        if (roll < 0.45) {
          ops.push({ kind: "grant", capability });
          record = grantRealmCapability(record, capability, i);
        } else if (roll < 0.7) {
          ops.push({ kind: "deny", capability });
          record = denyRealmCapability(record, capability, i);
        } else if (roll < 0.9) {
          ops.push({ kind: "revoke", capability });
          record = revokeRealmCapability(record, capability, i);
        } else {
          ops.push({ kind: "revoke_all" });
          record = revokeAllRealmCapabilities(record, i);
        }
      }

      const expected = oracleApply(record, ops);
      for (const capability of capabilities) {
        const decision = evaluateRealmConsent(record, REALM, capability);
        const modelState = expected.get(capability) ?? "unset";
        const modelAllowed = modelState === "granted";
        expect(decision.allowed).toBe(modelAllowed);
        if (!modelAllowed && modelState === "denied") {
          expect(decision).toEqual({ allowed: false, because: "denied" });
        }
      }
    }
  });

  it("sameRealm never crosses on 500 random near-miss pairs", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 500; i += 1) {
      const kind = `kind-${Math.floor(rand() * 3)}`;
      const id = `id-${Math.floor(rand() * 1e6)}`;
      const a = { realm_kind: kind, realm_id: id };
      // Mutate exactly one character of one coordinate.
      const mutatedKind = rand() < 0.5;
      const pos = Math.floor(rand() * (mutatedKind ? kind.length : id.length));
      const swapChar = mutatedKind ? kind : id;
      const swapped = swapChar.slice(0, pos) + (swapChar[pos] === "x" ? "y" : "x") + swapChar.slice(pos + 1);
      const b = mutatedKind
        ? { realm_kind: swapped, realm_id: id }
        : { realm_kind: kind, realm_id: swapped };
      if (swapped !== swapChar) {
        expect(sameRealm(a, b)).toBe(false);
      } else {
        expect(sameRealm(a, b)).toBe(true); // mutation was identity (impossible here)
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Event conversion: adversarial fuzz must never crash and must round-trip
// ---------------------------------------------------------------------------

function randomBrowserEvent(rand: () => number, seq: number): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_id: `e-${seq}`,
    trace_id: "t",
    trace_version: Math.floor(rand() * 5) + 1,
    event_seq: seq,
    ts: Math.floor(rand() * Number.MAX_SAFE_INTEGER),
    tab_id: `tab-${Math.floor(rand() * 100)}`,
    origin: rand() < 0.1 ? "" : `https://h${Math.floor(rand() * 50)}.test:${Math.floor(rand() * 65536)}`,
    url: `https://h${Math.floor(rand() * 50)}.test/p?x=${Math.floor(rand() * 1000)}`,
    kind: (["human_action", "agent_action", "selection", "navigation", "console", "network"] as const)[
      Math.floor(rand() * 6)
    ],
  };
  if (rand() < 0.3) event.frame_id = `f-${Math.floor(rand() * 100)}`;
  if (rand() < 0.5) {
    event.action = (
      [
        "click", "dblclick", "contextmenu", "fill", "hover", "drag", "scroll",
        "copy", "cut", "press", "select", "check", "uncheck", "navigate", "wait",
      ] as const
    )[Math.floor(rand() * 15)];
  }
  if (rand() < 0.4) event.value = `v-${Math.floor(rand() * 1000)}`;
  if (rand() < 0.3) event.redacted = true;
  if (rand() < 0.4) event.detail = { nested: { arr: [rand(), rand()], s: "x" } };
  if (rand() < 0.4) {
    event.security = {
      exact_origin_approved: rand() < 0.5,
      screenshot_approved: rand() < 0.5,
      diagnostics_approved: rand() < 0.5,
      auth_checkpoint_approved: rand() < 0.5,
      frame_origin_approved: rand() < 0.5,
      frame_screenshot_approved: rand() < 0.5,
      popup_origin_approved: rand() < 0.5,
      popup_screenshot_approved: rand() < 0.5,
    };
  }
  return event as unknown as Record<string, unknown>;
}

describe("event conversion adversarial fuzz", () => {
  it("never crashes and always round-trips on 500 wild events", () => {
    const rand = mulberry32(777);
    for (let seq = 0; seq < 500; seq += 1) {
      const raw = randomBrowserEvent(rand, seq);
      const embodied = browserEventToEmbodied(raw as never);
      expect(embodied.event_id).toBe(raw.event_id);
      const back = embodiedToBrowserEvent(embodied);
      expect(back).not.toBeNull();
      // Exact structural round-trip.
      expect(back).toEqual(raw);
    }
  });

  it("survives garbage input without throwing", () => {
    const garbage = [null, undefined, {}, { kind: "human_action" }, [], 42, "x"];
    for (const item of garbage) {
      expect(() => browserEventToEmbodied(item as never)).not.toThrow();
    }
    // Garbage degrades to a safe envelope; reconstruction is refused for
    // events lacking the legacy browser fields.
    expect(embodiedToBrowserEvent(browserEventToEmbodied(null as never))).toBeNull();
    expect(embodiedToBrowserEvent(browserEventToEmbodied(42 as never))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State Differ determinism + budget invariants under randomized streams
// ---------------------------------------------------------------------------

function makeSchema(): WorldStateSchema {
  return {
    schema_id: "fuzz.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "sig.*", type: { kind: "number" }, semantic_class: "state_flag" },
      { path_pattern: "noise.*", type: { kind: "number" }, semantic_class: "ambient" },
    ],
    identity: { id_scheme: "stable", survives: ["fork"], reidentification_rule: "paths" },
    observability: { fully_observable: true, hidden_state: [], policy: "full" },
    noise_fingerprints: [{ fingerprint_id: "n", path_pattern: "noise." }],
  };
}

describe("state differ invariants under randomized streams", () => {
  it("is deterministic: identical inputs produce identical outputs", () => {
    const rand = mulberry32(555);
    const changed: ChangedValue[] = Array.from({ length: 40 }, (_, i) => ({
      path: `sig.p${i}`,
      semantic_class: "",
      before: i,
      after: i + 1,
      changed_at_tick: 10 + Math.floor(rand() * 5),
    }));
    const schema = makeSchema();
    const runOnce = () =>
      JSON.stringify(
        runStateDiffer(
          {
            changed_values: changed.map((change) => ({ ...change })),
            window: { start_tick: 8, end_tick: 12, settle_tick: 14 },
            schema,
            control_diffs: [{ source_id: "c", changed: [change("noise.a")] }],
          },
          [],
          new Map(),
        ),
      );
    function change(path: string): ChangedValue {
      return { path, semantic_class: "", before: 0, after: 1, changed_at_tick: 11 };
    }
    expect(runOnce()).toBe(runOnce());
  });

  it("budget is enforced exactly and always flagged when hit", () => {
    for (const size of [30, 31, 32, 33, 64]) {
      const changed: ChangedValue[] = Array.from({ length: size }, (_, i) => ({
        path: `p.${i}`,
        semantic_class: "content",
        before: i,
        after: i + 1,
        changed_at_tick: 10,
      }));
      const result = runStateDiffer(
        {
          changed_values: changed,
          window: { start_tick: 9, end_tick: 11, settle_tick: 12 },
          schema: makeSchema(),
        },
        [],
        new Map(),
      );
      expect(result.deltas.length).toBe(Math.min(size, 32));
      expect(result.delta_truncated).toBe(size > 32);
      expect(result.dropped_count).toBe(Math.max(0, size - 32));
    }
  });

  it("declared noise paths are ambient regardless of timing; control diffs make actor-caused fork_control", () => {
    const changed: ChangedValue[] = [
      changeValue("noise.clock", 11),
      changeValue("sig.target", 11),
    ];
    const result = runStateDiffer(
      {
        changed_values: changed,
        window: { start_tick: 10, end_tick: 12, settle_tick: 13 },
        schema: makeSchema(),
        control_diffs: [{ source_id: "fork", changed: [changeValue("noise.clock", 5)] }],
      },
      [],
      new Map(),
    );
    const byPath = new Map(result.deltas.map((delta) => [delta.source.path, delta]));
    expect(byPath.get("noise.clock")?.causal_class).toBe("ambient");
    expect(byPath.get("sig.target")?.causal_class).toBe("actor_caused");
    expect(byPath.get("sig.target")?.evidence).toBe("fork_control");
  });

  function changeValue(path: string, tick: number): ChangedValue {
    return { path, semantic_class: "", before: 0, after: 1, changed_at_tick: tick };
  }
});

// ---------------------------------------------------------------------------
// Governance property tests: authorization is exact and fail-closed
// ---------------------------------------------------------------------------

describe("governance authorization properties under random licenses", () => {
  function randomLicense(rand: () => number, index: number): CompetencyLicense {
    const substrateCount = 1 + Math.floor(rand() * 3);
    const substrates = Array.from({ length: substrateCount }, (_, i) => `world.${index}_${i}`);
    return {
      license_id: `lic-${index}`,
      competency_id: "comp.x",
      substrate_scope: substrates,
      realm_scopes: [{ realm_kind: "test.kind", realm_id: `realm-${index}` }],
      entrustment: "E3_sandboxed_action",
      issued_at_ms: 0,
      expires_at_ms: Math.floor(rand() * 2000),
    };
  }

  it("authorizes exactly the licensed scope on 400 randomized setups", () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < 400; i += 1) {
      const license = randomLicense(rand, i % 4);
      const now = Math.floor(rand() * 3000);
      // In-scope request: authorized iff not expired.
      const inScope = authorizeRun([license], {
        competency_id: "comp.x",
        substrate_kind: license.substrate_scope[0] as string,
        realm: license.realm_scopes[0] as { realm_kind: string; realm_id: string },
        required_level: "E2_supervised", // below E3 always
        now,
      });
      expect(inScope.authorized).toBe(now <= license.expires_at_ms);

      // Wrong substrate: never authorized.
      const wrongSubstrate = authorizeRun([license], {
        competency_id: "comp.x",
        substrate_kind: "unlicensed.world",
        realm: license.realm_scopes[0] as { realm_kind: string; realm_id: string },
        required_level: "E1_observe_only",
        now: 0,
      });
      expect(wrongSubstrate.authorized).toBe(false);

      // Level above grant: never authorized.
      const tooTrusted = authorizeRun([license], {
        competency_id: "comp.x",
        substrate_kind: license.substrate_scope[0] as string,
        realm: license.realm_scopes[0] as { realm_kind: string; realm_id: string },
        required_level: "E4_autonomous_action",
        now: 0,
      });
      expect(tooTrusted.authorized).toBe(false);
    }
  });

  it("unknown competency and empty license list fail closed with human reasons", () => {
    const decision = authorizeRun([], {
      competency_id: "nope",
      substrate_kind: "anything",
      realm: REALM,
      required_level: "E1_observe_only",
      now: 0,
    });
    expect(decision.authorized).toBe(false);
    if (!decision.authorized) {
      expect(decision.human_reason.length).toBeGreaterThan(10);
      expect(decision.reason_code).toBe("no_license");
    }
  });
});


