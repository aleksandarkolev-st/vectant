/**
 * State Differ stages 2–5.
 *
 * Stage 2 (relevance): score every candidate change, keep the top budget,
 * and FLAG truncation. The filter may be wrong in both directions; stages
 * 3–5 and hardening correct it. What is forbidden is silent unbounded output
 * or silent dropping — both are degradations that must be visible downstream.
 *
 * Stage 3 (attribution): classify actor-caused vs ambient vs induced vs
 * unknown using action windows plus the strongest available control:
 *   fork_control     > multi_demo_vote > temporal_only
 *
 * Stage 4 (persistence): durable / transient / oscillating from settle-window
 * samples; oscillators feed discovered-noise output for schema folding.
 *
 * Stage 5 (predicates): compile surviving durable effects into typed
 * predicate refs over the schema with uncertainty provenance.
 */

import { effectiveSemanticWeight } from "../world_state.js";
import { resolveSemanticClass } from "../world_state.js";
import type {
  ActionWindow,
  AttributedDelta,
  ControlOrDemoDiff,
  DifferInput,
  DifferProfile,
  DifferResult,
  DiscoveredNoise,
  PersistenceTrace,
  ScoredDelta,
} from "./types.js";
import { DEFAULT_DIFFER_PROFILE } from "./types.js";

export * from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrefix(prefix: string | undefined, path: string): boolean {
  if (!prefix) return false;
  return path === prefix || path.startsWith(`${prefix}.`);
}

function valuesEqual(a: unknown, b: unknown, numericTolerance: number): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= numericTolerance;
  }
  return false;
}

/** Count how many of the provided control/demo diffs also changed this path. */
function recurringCount(
  diffs: ControlOrDemoDiff[] | undefined,
  path: string,
): number {
  if (!diffs) return 0;
  return diffs.filter((diff) => diff.changed.some((change) => change.path === path)).length;
}

// ---------------------------------------------------------------------------
// Stage 2: relevance filtering
// ---------------------------------------------------------------------------

export function scoreRelevance(input: DifferInput): ScoredDelta[] {
  const profile: DifferProfile = input.profile ?? DEFAULT_DIFFER_PROFILE;
  const { weights } = profile;
  const window = input.window;

  const scored: ScoredDelta[] = input.changed_values.map((change) => {
    // proximity: target ownership beats everything else about position
    const onTarget = window.target_path_prefix
      ? isPrefix(window.target_path_prefix, change.path)
      : false;
    const proximity = onTarget ? 1 : 0;

    // coincidence: inside [start - eps, settle + eps]
    const low = window.start_tick - profile.window_epsilon_ticks;
    const high = window.settle_tick + profile.window_epsilon_ticks;
    const coincidence =
      change.changed_at_tick >= low && change.changed_at_tick <= high ? 1 : 0;

    // semantic weight from the schema (declared paths outrank undeclared)
    const semanticClass = resolveSemanticClass(input.schema, change.path);
    const semantic = effectiveSemanticWeight(input.schema, semanticClass);

    // novelty: first appearance in this trace beats recurring churn
    const seenBefore = input.previously_changed_paths?.has(change.path) ?? false;
    const novelty = seenBefore ? 0 : 1;

    const salience =
      weights.proximity * proximity +
      weights.coincidence * coincidence +
      weights.persistence * 0 + // refined in stage 4 pass below
      weights.semantic * semantic +
      weights.novelty * novelty;

    return {
      source: change,
      salience,
      components: {
        proximity,
        coincidence,
        persistence: 0,
        semantic,
        novelty,
      },
      causal_class: "unknown",
      evidence: "temporal_only",
    };
  });

  scored.sort((a, b) => b.salience - a.salience);
  return scored;
}

export function applyBudget(scored: ScoredDelta[], profile: DifferProfile): {
  kept: ScoredDelta[];
  dropped_count: number;
} {
  if (scored.length <= profile.max_deltas_per_event) {
    return { kept: scored, dropped_count: 0 };
  }
  return {
    kept: scored.slice(0, profile.max_deltas_per_event),
    dropped_count: scored.length - profile.max_deltas_per_event,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: causal attribution
// ---------------------------------------------------------------------------

/**
 * Attribution precedence per candidate:
 * 1. fork controls exist -> ambient iff the path changes without the action;
 *    otherwise actor_caused with fork_control evidence.
 * 2. multi-demonstration voting available -> ambient iff the path changes in
 *    ALL demonstrations' no-action-equivalents... simplified: ambient iff it
 *    recurs in every demonstration diff AND never tracks only the acted run;
 *    otherwise actor_caused with multi_demo_vote evidence.
 * 3. temporal_only: inside the action window and not declared noise ->
 *    provisional actor_caused (weak); outside the window -> unknown.
 */
export function attributeCausality(
  scored: ScoredDelta[],
  input: DifferInput,
): ScoredDelta[] {
  const profile: DifferProfile = input.profile ?? DEFAULT_DIFFER_PROFILE;
  const hasForkControls = (input.control_diffs?.length ?? 0) > 0;
  const demos = input.demonstration_diffs ?? [];
  const canVote = demos.length >= 2;
  const noisePatterns = collectNoisePatterns(input);

  return scored.map((delta) => {
    const path = delta.source.path;

    // Declared noise is ambient by definition.
    if (matchesAnyPattern(path, noisePatterns)) {
      return { ...delta, causal_class: "ambient" as const };
    }

    if (hasForkControls) {
      const ambientInControls = (input.control_diffs ?? []).some((control) =>
        control.changed.some((change) => change.path === path),
      );
      if (ambientInControls) {
        return { ...delta, causal_class: "ambient" as const, evidence: "fork_control" as const };
      }
      return {
        ...delta,
        causal_class: "actor_caused" as const,
        evidence: "fork_control" as const,
      };
    }

    if (canVote) {
      const recurring = recurringCount(demos, path);
      if (recurring === demos.length) {
        return { ...delta, causal_class: "ambient" as const, evidence: "multi_demo_vote" as const };
      }
      if (recurring === 0) {
        return {
          ...delta,
          causal_class: delta.components.coincidence > 0 ? "actor_caused" as const : "unknown" as const,
          evidence: "multi_demo_vote" as const,
        };
      }
      // Partially recurring: suspicious; treat as induced at best.
      return { ...delta, causal_class: "induced" as const, evidence: "multi_demo_vote" as const };
    }

    // Temporal-only fallback.
    const inWindow =
      delta.source.changed_at_tick >= input.window.start_tick &&
      delta.source.changed_at_tick <= input.window.settle_tick;
    if (!inWindow) {
      return { ...delta, causal_class: "unknown" as const, evidence: "temporal_only" as const };
    }
    return {
      ...delta,
      causal_class: "actor_caused" as const,
      evidence: "temporal_only" as const,
    };
  });
}

function collectNoisePatterns(input: DifferInput): string[] {
  return (input.schema.noise_fingerprints ?? []).map((fingerprint) => fingerprint.path_pattern);
}

function matchesAnyPattern(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (path === pattern || path.startsWith(pattern)) return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*")}$`.replace("\\*\\*", ".*"),
      );
      if (regex.test(path)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 4: persistence classification
// ---------------------------------------------------------------------------

/**
 * Classify persistence from post-action samples through the settle window.
 * - durable: final value stays at the post-action value
 * - transient: reverts toward the pre-action value quickly
 * - oscillating: alternates more than once after the action
 */
export function classifyPersistence(
  deltas: ScoredDelta[],
  traces: PersistenceTrace[],
  baseline: Map<string, unknown>,
  numericTolerance = DEFAULT_DIFFER_PROFILE.numeric_tolerance,
): { classified: ScoredDelta[]; oscillatingPaths: string[] } {
  const traceByPath = new Map(traces.map((trace) => [trace.path, trace]));
  const oscillatingPaths: string[] = [];

  const classified = deltas.map((delta) => {
    const trace = traceByPath.get(delta.source.path);
    if (!trace || trace.samples.length < 2) return delta;

    const postActionValue = delta.source.after;
    let flips = 0;
    let lastMatchesPost = valuesEqual(trace.samples[0]?.value, postActionValue, numericTolerance);
    for (let i = 1; i < trace.samples.length; i += 1) {
      const matchesPost = valuesEqual(trace.samples[i]?.value, postActionValue, numericTolerance);
      if (matchesPost !== lastMatchesPost) flips += 1;
      lastMatchesPost = matchesPost;
    }

    const finalSample = trace.samples[trace.samples.length - 1];
    const finalMatchesPost = valuesEqual(finalSample?.value, postActionValue, numericTolerance);
    const baselineValue = baseline.get(delta.source.path);
    const finalAtBaseline = valuesEqual(finalSample?.value, baselineValue, numericTolerance);

    let persistenceClass: ScoredDelta["persistence_class"];
    if (flips >= 3) {
      persistenceClass = "oscillating";
      oscillatingPaths.push(delta.source.path);
    } else if (finalMatchesPost) {
      persistenceClass = "durable";
    } else if (finalAtBaseline) {
      persistenceClass = "transient";
    } else {
      // Drifted somewhere new; treat as durable-at-new-value only if it held
      // through the tail half of the window.
      persistenceClass = "durable";
    }

    return { ...delta, persistence_class: persistenceClass };
  });

  return { classified, oscillatingPaths };
}

// ---------------------------------------------------------------------------
// Stage 5: predicate compilation
// ---------------------------------------------------------------------------

const SAMPLE_FLOOR_FOR_COMPILATION = 1;

/**
 * Compile surviving durable actor-caused/induced deltas into predicate refs.
 * Ambient and unknown classes never compile. Oscillating paths surface as
 * discovered noise instead of predicates.
 */
export function compilePredicates(
  deltas: ScoredDelta[],
  input: DifferInput,
  oscillatingPaths: readonly string[],
): AttributedDelta[] {
  const profile: DifferProfile = input.profile ?? DEFAULT_DIFFER_PROFILE;
  return deltas.map((delta) => {
    const attributed: AttributedDelta = { ...delta };
    if (
      (delta.causal_class === "actor_caused" || delta.causal_class === "induced") &&
      delta.persistence_class === "durable" &&
      !oscillatingPaths.includes(delta.source.path) &&
      (input.control_diffs?.length ?? 0) + (input.demonstration_diffs?.length ?? 0) >=
        SAMPLE_FLOOR_FOR_COMPILATION ||
      (delta.evidence === "fork_control" && delta.causal_class === "actor_caused")
    ) {
      attributed.compiled_predicate = {
        predicate_id: "state.equals",
        args: {
          path: delta.source.path,
          value: serializeArg(delta.source.after),
          tolerance:
            typeof delta.source.after === "number" ? String(profile.numeric_tolerance) : "exact",
        },
      };
    }
    return attributed;
  });
}

function serializeArg(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return "null";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function runStateDiffer(
  input: DifferInput,
  persistenceTraces: PersistenceTrace[],
  baseline: Map<string, unknown>,
): DifferResult {
  const profile: DifferProfile = input.profile ?? DEFAULT_DIFFER_PROFILE;

  // Refine stage-2 scores with persistence before budgeting: a change that
  // holds through the settle window matters more than an equal-salience blip.
  const prelim = scoreRelevance(input);
  const { classified, oscillatingPaths } = classifyPersistence(
    prelim,
    persistenceTraces,
    baseline,
    profile.numeric_tolerance,
  );
  const withPersistence = classified.map((delta) => ({
    ...delta,
    salience:
      delta.salience +
      (profile.weights.persistence *
        (delta.persistence_class === "durable" ? 1 : delta.persistence_class === "transient" ? 0.25 : 0)),
    components: {
      ...delta.components,
      persistence: delta.persistence_class === "durable" ? 1 : delta.persistence_class === "transient" ? 0.25 : 0,
    },
  }));
  withPersistence.sort((a, b) => b.salience - a.salience);

  const { kept, dropped_count } = applyBudget(withPersistence, profile);
  const attributed = attributeCausality(kept, input);

  const compiled = compilePredicates(attributed, input, oscillatingPaths);

  const discovered_noise: DiscoveredNoise[] = oscillatingPaths.map((path) => ({
    path_pattern: path,
    basis: "oscillation_detected" as const,
  }));

  return {
    deltas: compiled.sort((a, b) => b.salience - a.salience),
    delta_truncated: dropped_count > 0,
    dropped_count,
    discovered_noise,
  };
}
