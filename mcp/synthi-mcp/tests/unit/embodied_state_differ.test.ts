import { describe, expect, it } from "vitest";
import {
  applyBudget,
  attributeCausality,
  classifyPersistence,
  compilePredicates,
  DEFAULT_DIFFER_PROFILE,
  runStateDiffer,
  scoreRelevance,
} from "../../src/embodied/state_differ/index.js";
import type {
  ActionWindow,
  ControlOrDemoDiff,
  DifferInput,
} from "../../src/embodied/state_differ/types.js";
import { resolveSemanticClass, validateWorldStateSchema, type WorldStateSchema } from "../../src/embodied/world_state.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A generic schema: entities with kinds, states, positions; an ambient clock;
// declared noise on particle emitters. No scenario semantics.
function makeSchema(): WorldStateSchema {
  const schema: WorldStateSchema = {
    schema_id: "test.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "entities.*.kind", type: { kind: "enum", values: ["a", "b"] }, semantic_class: "identity" },
      { path_pattern: "entities.*.state", type: { kind: "enum", values: ["s1", "s2"] }, semantic_class: "state_flag" },
      { path_pattern: "entities.*.position", type: { kind: "band", min: 0, max: 1000, unit: "m" }, semantic_class: "transform" },
      { path_pattern: "clock.value", type: { kind: "number" }, semantic_class: "ambient" },
    ],
    identity: { id_scheme: "session", survives: ["fork"], reidentification_rule: "by stable attributes" },
    observability: { fully_observable: true, hidden_state: [], policy: "full" },
    noise_fingerprints: [{ fingerprint_id: "n1", path_pattern: "fx.particles.*" }],
  };
  const problems = validateWorldStateSchema(schema);
  expect(problems).toEqual([]);
  return schema;
}

const WINDOW: ActionWindow = {
  start_tick: 100,
  end_tick: 104,
  settle_tick: 110,
  target_path_prefix: "entities.e7",
};

function change(path: string, tick: number, before: unknown, after: unknown) {
  return { path, changed_at_tick: tick, before, after, semantic_class: "" };
}

function baseInput(overrides: Partial<DifferInput> = {}): DifferInput {
  return {
    changed_values: [],
    window: WINDOW,
    schema: makeSchema(),
    ...overrides,
  };
}

describe("stage 2: relevance scoring and budget", () => {
  it("ranks target-owned, in-window, semantically-heavy changes first", () => {
    const input = baseInput({
      changed_values: [
        change("clock.value", 101, 5, 6),
        change("entities.e9.state", 103, "s1", "s2"),
        change("entities.e7.state", 103, "s1", "s2"),
        change("unrelated.thing", 105, 1, 2),
      ],
    });
    const scored = scoreRelevance(input);
    expect(scored[0]!.source.path).toBe("entities.e7.state");
    expect(scored[scored.length - 1]!.source.path).toBe("unrelated.thing");
  });

  it("flags truncation instead of dropping silently", () => {
    const input = baseInput({
      changed_values: Array.from({ length: 50 }, (_, i) =>
        change(`paths.p${i}`, 102, i, i + 1),
      ),
    });
    const scored = scoreRelevance(input);
    const { kept, dropped_count } = applyBudget(scored, DEFAULT_DIFFER_PROFILE);
    expect(kept).toHaveLength(DEFAULT_DIFFER_PROFILE.max_deltas_per_event);
    expect(dropped_count).toBe(50 - DEFAULT_DIFFER_PROFILE.max_deltas_per_event);
    // The result carries the flag (asserted again end-to-end below).
  });

  it("novel paths outrank previously-changed churn under equal conditions", () => {
    const input = baseInput({
      changed_values: [
        change("a.path.one", 103, 1, 2),
        change("a.path.two", 103, 1, 2),
      ],
      previously_changed_paths: new Set(["a.path.two"]),
    });
    const scored = scoreRelevance(input);
    const one = scored.find((s) => s.source.path === "a.path.one")!;
    const two = scored.find((s) => s.source.path === "a.path.two")!;
    expect(one.salience).toBeGreaterThan(two.salience);
  });
});

describe("stage 3: causal attribution", () => {
  it("uses fork controls: paths that move without the action are ambient", () => {
    const input = baseInput({
      changed_values: [
        change("entities.e7.state", 103, "s1", "s2"),
        change("clock.value", 102, 10, 11),
      ],
      control_diffs: [{ source_id: "fork-1", changed: [change("clock.value", 50, 9, 10)] }],
    });
    const attributed = attributeCausality(scoreRelevance(input), input);
    const byPath = new Map(attributed.map((d) => [d.source.path, d]));
    expect(byPath.get("clock.value")?.causal_class).toBe("ambient");
    expect(byPath.get("entities.e7.state")?.causal_class).toBe("actor_caused");
    expect(byPath.get("entities.e7.state")?.evidence).toBe("fork_control");
  });

  it("multi-demo voting: recurring-in-all is ambient, never-recurring actor-caused, partial induced", () => {
    const demos: ControlOrDemoDiff[] = [
      { source_id: "demo-1", changed: [change("other.x", 60, 1, 2), change("shared.y", 61, 1, 2)] },
      { source_id: "demo-2", changed: [change("shared.y", 62, 1, 2)] },
    ];
    const input = baseInput({
      changed_values: [
        change("entities.e7.state", 103, "s1", "s2"),
        change("shared.y", 104, 1, 2),
        change("other.x", 105, 1, 2),
      ],
      demonstration_diffs: demos,
    });
    const attributed = attributeCausality(scoreRelevance(input), input);
    const byPath = new Map(attributed.map((d) => [d.source.path, d]));
    expect(byPath.get("shared.y")?.causal_class).toBe("ambient");
    expect(byPath.get("entities.e7.state")?.evidence).toBe("multi_demo_vote");
    expect(byPath.get("other.x")?.causal_class).toBe("induced");
  });

  it("declared noise fingerprints are ambient even inside the action window", () => {
    const input = baseInput({
      changed_values: [change("fx.particles.burst", 103, 0, 500)],
    });
    const attributed = attributeCausality(scoreRelevance(input), input);
    expect(attributed[0]!.causal_class).toBe("ambient");
  });

  it("temporal-only fallback marks out-of-window changes unknown", () => {
    const input = baseInput({
      changed_values: [change("somewhere.late", 200, 1, 2)],
    });
    const attributed = attributeCausality(scoreRelevance(input), input);
    expect(attributed[0]!.causal_class).toBe("unknown");
    expect(attributed[0]!.evidence).toBe("temporal_only");
  });
});

describe("stage 4: persistence classification", () => {
  it("classifies durable, transient, and oscillating from samples", () => {
    const deltas = scoreRelevance(
      baseInput({
        changed_values: [
          change("p.durable", 102, 0, 42),
          change("p.transient", 103, 0, 7),
          change("p.oscillating", 103, 0, 1),
        ],
      }),
    );
    const traces = [
      { path: "p.durable", samples: [{ tick: 111, value: 42 }, { tick: 115, value: 42 }] },
      { path: "p.transient", samples: [{ tick: 111, value: 7 }, { tick: 115, value: 0 }] },
      {
        path: "p.oscillating",
        samples: [
          { tick: 111, value: 1 },
          { tick: 112, value: 0 },
          { tick: 113, value: 1 },
          { tick: 114, value: 0 },
          { tick: 115, value: 1 },
        ],
      },
    ];
    const baseline = new Map([["p.transient", 0], ["p.durable", 0], ["p.oscillating", 0]]);
    const { classified, oscillatingPaths } = classifyPersistence(deltas, traces, baseline);
    const byPath = new Map(classified.map((d) => [d.source.path, d]));
    expect(byPath.get("p.durable")?.persistence_class).toBe("durable");
    expect(byPath.get("p.transient")?.persistence_class).toBe("transient");
    expect(byPath.get("p.oscillating")?.persistence_class).toBe("oscillating");
    expect(oscillatingPaths).toEqual(["p.oscillating"]);
  });
});

describe("stage 5 + orchestration: predicates and truncation flags", () => {
  it("compiles only durable actor-caused effects into predicates; ambient never compiles", () => {
    const input = baseInput({
      changed_values: [
        change("entities.e7.state", 103, "s1", "s2"),
        change("clock.value", 102, 10, 11),
      ],
      // A real forked world still advances its ambient state without the
      // action — that is precisely what makes it ambient.
      control_diffs: [
        { source_id: "fork-1", changed: [change("clock.value", 50, 10, 11)] },
      ],
    });
    const traces = [
      { path: "entities.e7.state", samples: [{ tick: 112, value: "s2" }, { tick: 118, value: "s2" }] },
      { path: "clock.value", samples: [{ tick: 112, value: 12 }, { tick: 118, value: 13 }] },
    ];
    const baseline = new Map([["clock.value", 10], ["entities.e7.state", "s1"]]);
    const result = runStateDiffer(input, traces, baseline);
    const byPath = new Map(result.deltas.map((d) => [d.source.path, d]));

    const effectDelta = byPath.get("entities.e7.state")!;
    expect(effectDelta.compiled_predicate?.predicate_id).toBe("state.equals");
    expect(effectDelta.compiled_predicate?.args.path).toBe("entities.e7.state");

    const clockDelta = byPath.get("clock.value")!;
    expect(clockDelta.causal_class).toBe("ambient");
    expect(clockDelta.compiled_predicate).toBeUndefined();
    expect(result.delta_truncated).toBe(false);
  });

  it("never truncates silently at the orchestration level", () => {
    const manyChanges = Array.from({ length: 80 }, (_, i) => change(`flood.p${i}`, 102, i, i + 1));
    const input = baseInput({ changed_values: manyChanges });
    const result = runStateDiffer(input, [], new Map());
    expect(result.delta_truncated).toBe(true);
    expect(result.dropped_count).toBe(80 - DEFAULT_DIFFER_PROFILE.max_deltas_per_event);
    expect(result.deltas.length).toBeLessThanOrEqual(DEFAULT_DIFFER_PROFILE.max_deltas_per_event);
  });

  it("feeds discovered oscillation back as noise for schema folding", () => {
    const input = baseInput({
      changed_values: [change("wobble.value", 103, 0, 1)],
    });
    const traces = [
      {
        path: "wobble.value",
        samples: [
          { tick: 111, value: 1 },
          { tick: 112, value: 0 },
          { tick: 113, value: 1 },
          { tick: 114, value: 0 },
          { tick: 115, value: 1 },
        ],
      },
    ];
    const baseline = new Map([["wobble.value", 0]]);
    const result = runStateDiffer(input, traces, baseline);
    expect(result.discovered_noise.some((noise) => noise.path_pattern === "wobble.value")).toBe(true);
  });
});

describe("state differ boundary", () => {
  it("core modules import no adapter code and contain no scenario nouns", () => {
    for (const file of ["index.ts", "types.ts"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../src/embodied/state_differ/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+"\.\.\/\.\.\/browser\//);
      expect(source).not.toMatch(/from\s+"\.\.\/\.\.\/dojo\//);
      for (const noun of ["door", "purple", "nginx", "toast"]) {
        expect(source.toLowerCase()).not.toContain(noun);
      }
    }
  });

  it("schema resolution agrees with differ expectations", () => {
    const schema = makeSchema();
    expect(resolveSemanticClass(schema, "entities.z9.state")).toBe("state_flag");
    expect(resolveSemanticClass(schema, "unknown.path")).toBe("undeclared");
  });
});
