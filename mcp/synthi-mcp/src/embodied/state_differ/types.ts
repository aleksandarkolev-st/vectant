/**
 * Shared types for the State Differ pipeline (stages 2–5).
 *
 * Pipeline contract (see docs/UNIVERSAL_EMBODIED_TEACHING_PLAN.md):
 *   [1] adapter diff  -> ChangedValue[]          (adapter-supplied, complete)
 *   [2] relevance     -> scored, budgeted subset (core)
 *   [3] attribution   -> actor/ambient/induced   (core)
 *   [4] persistence   -> durable/transient/osc   (core)
 *   [5] predicates    -> contract effects        (core)
 *
 * Stage 1 is deliberately NOT here: adapters own mechanical diffing because
 * only they know their observation model. Everything else is shared so every
 * substrate gets identical semantics. Adapters never write predicates.
 */

import type { ChangedValue, NoiseFingerprint, WorldStateSchema } from "../world_state.js";
import type { AttributionEvidenceKind } from "../event.js";

/** Tunable salience weights (w1..w5 from the plan). Configuration, never
 *  hardcoded constants; profiles tune them per substrate class. */
export interface SalienceWeights {
  /** Proximity of the changed path to the action's target path. */
  proximity: number;
  /** Change coincided with the action window. */
  coincidence: number;
  /** Change persisted through the settle window. */
  persistence: number;
  /** Schema-declared semantic type weight. */
  semantic: number;
  /** First-time change beats recurring churn. */
  novelty: number;
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  proximity: 0.35,
  coincidence: 0.25,
  persistence: 0.15,
  semantic: 0.15,
  novelty: 0.1,
};

export interface DifferProfile {
  weights: SalienceWeights;
  /** Hard cap on deltas attached to one action event. Overflow is FLAGGED,
   *  never silently dropped. */
  max_deltas_per_event: number;
  /** Slack around the action window (ticks) for coincidence scoring. */
  window_epsilon_ticks: number;
  /** Default relative tolerance for numeric equality assertions. */
  numeric_tolerance: number;
}

export const DEFAULT_DIFFER_PROFILE: DifferProfile = {
  weights: DEFAULT_SALIENCE_WEIGHTS,
  max_deltas_per_event: 32,
  window_epsilon_ticks: 2,
  numeric_tolerance: 1e-6,
};

export interface ActionWindow {
  /** Tick the action started. */
  start_tick: number;
  /** Tick the action completed. */
  end_tick: number;
  /** Tick by which induced effects should have settled. */
  settle_tick: number;
  /** Observation-space path prefix owned by the action target, when known.
   *  Adapters map affordances into observation paths via the schema. */
  target_path_prefix?: string;
}

/** Post-action observation samples for one path, used for persistence. */
export interface PersistenceTrace {
  path: string;
  samples: Array<{ tick: number; value: unknown }>;
}

/** One demonstration's diff for the same logical flow (multi-demo voting). */
export interface ControlOrDemoDiff {
  /** Identifier for provenance in results. */
  source_id: string;
  changed: ChangedValue[];
}

export interface DifferInput {
  /** Stage-1 output for the window being explained. */
  changed_values: ChangedValue[];
  window: ActionWindow;
  schema: WorldStateSchema;
  profile?: DifferProfile;
  /** Fork-based no-action control diffs. Presence upgrades evidence to
   *  fork_control. */
  control_diffs?: ControlOrDemoDiff[];
  /** Other demonstrations of the same flow (>=2 enables multi-demo voting). */
  demonstration_diffs?: ControlOrDemoDiff[];
  /** Paths that already changed in earlier windows of this trace (novelty). */
  previously_changed_paths?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type CausalClass = "actor_caused" | "ambient" | "induced" | "unknown";
export type PersistenceClass = "durable" | "transient" | "oscillating";

export interface ScoredDelta {
  source: ChangedValue;
  salience: number;
  components: {
    proximity: number;
    coincidence: number;
    persistence: number;
    semantic: number;
    novelty: number;
  };
  causal_class: CausalClass;
  evidence: AttributionEvidenceKind;
  persistence_class?: PersistenceClass;
}

export interface DiscoveredNoise {
  path_pattern: string;
  basis: "oscillation_detected" | "control_recurring";
}

export interface AttributedDelta extends ScoredDelta {
  /** Predicate arguments compiled at stage 5 (only for durable actor-caused
   *  and durable induced deltas). */
  compiled_predicate?: {
    predicate_id: string;
    args: Record<string, string | number | boolean>;
  };
}

export interface DifferResult {
  /** Budget-surviving, attributed, classified deltas, best first. */
  deltas: AttributedDelta[];
  /** True when relevant candidates were cut by the budget. Never silent. */
  delta_truncated: boolean;
  dropped_count: number;
  /** Oscillating paths found at runtime; adapters should fold these into
   *  their schema's noise fingerprints. */
  discovered_noise: DiscoveredNoise[];
}
