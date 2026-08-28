/**
 * Semantic-quality metrics (plan Metrics section): replay pass rate alone
 * proves too little, so these functions MEASURE the four plan-defined
 * quantities. All pure; inputs come from harness runs and fault-injection.
 *
 * 1. contractPrecision   - fraction of generated effects that are necessary
 *                          (pruning them changes replay outcome)
 * 2. contractRecall      - fraction of injected faults that the contract's
 *                          hard-failure checks actually catch
 * 3. counterfactualDiscrimination - equivalent worlds pass AND non-equivalent
 *                          twins fail (a contract passing both is vacuous)
 * 4. causalFalsePositiveRate - ambient/induced deltas that leaked into
 *                          expected effects despite stage-3 attribution
 */

import type { AttributedDelta } from "./state_differ/types.js";

// ---------------------------------------------------------------------------
// Precision: prune each effect; if replay still passes without it, it was
// unnecessary. Necessary effects are those whose removal breaks replay.
// ---------------------------------------------------------------------------

export interface EffectProbe {
  effect_id: string;
  /** Did replay still succeed with this effect removed? */
  replay_passed_without: boolean;
}

export function contractPrecision(probes: readonly EffectProbe[]): number {
  if (probes.length === 0) return 1;
  const necessary = probes.filter((probe) => !probe.replay_passed_without).length;
  return necessary / probes.length;
}

// ---------------------------------------------------------------------------
// Recall: inject faults; how many does the contract catch?
// ---------------------------------------------------------------------------

export interface FaultProbe {
  fault_id: string;
  /** Did the contract detect this fault (replay failed as expected)? */
  detected: boolean;
}

export function contractRecall(probes: readonly FaultProbe[]): number {
  if (probes.length === 0) return 0;
  return probes.filter((probe) => probe.detected).length / probes.length;
}

// ---------------------------------------------------------------------------
// Counterfactual discrimination: vacuous contracts fail this metric.
// ---------------------------------------------------------------------------

export interface DiscriminationTrial {
  trial_id: string;
  /** Equivalent-world variant replay passed? */
  equivalent_passed: boolean;
  /** Non-equivalent twin replay failed? */
  twin_failed: boolean;
}

export function counterfactualDiscrimination(trials: readonly DiscriminationTrial[]): number {
  if (trials.length === 0) return 0;
  const discriminating = trials.filter(
    (trial) => trial.equivalent_passed && trial.twin_failed,
  ).length;
  return discriminating / trials.length;
}

// ---------------------------------------------------------------------------
// Causal false positives: attribution leaks measured by control-run audits.
// ---------------------------------------------------------------------------

/**
 * Fraction of compiled effects whose source delta was actually ambient or
 * induced (leaked past stage 3). Target <5%; every occurrence downgrades
 * evidence kind by contract rules.
 */
export function causalFalsePositiveRate(deltas: readonly AttributedDelta[]): {
  rate: number;
  leaked_paths: string[];
} {
  const compiled = deltas.filter((delta) => delta.compiled_predicate !== null && delta.compiled_predicate !== undefined);
  if (compiled.length === 0) return { rate: 0, leaked_paths: [] };
  const leaked = compiled.filter((delta) => delta.causal_class !== "actor_caused");
  return {
    rate: leaked.length / compiled.length,
    leaked_paths: leaked.map((delta) => delta.source.path),
  };
}

// ---------------------------------------------------------------------------
// Affordance degradation: tier drops between compile time and later replays.
// ---------------------------------------------------------------------------

export type Tier = "T1" | "T2" | "T3" | "T4";
const TIER_RANK: Record<Tier, number> = { T1: 4, T2: 3, T3: 2, T4: 1 };

export interface DegradationRecord {
  competency_id: string;
  compiled_tier: Tier;
  current_tier: Tier;
}

export interface DegradationReport {
  /** Share of contracts that dropped below structural tiers. */
  degradation_rate: number;
  /** Competencies needing re-hardening (spike = world drift). */
  needs_rehardening: string[];
}

export function affordanceDegradation(records: readonly DegradationRecord[]): DegradationReport {
  if (records.length === 0) return { degradation_rate: 0, needs_rehardening: [] };
  const degraded = records.filter(
    (record) => TIER_RANK[record.current_tier] < TIER_RANK[record.compiled_tier],
  );
  // Dropped to pixel-only (T4) always demands re-hardening; earlier-stage
  // drops count toward the rate but only T4 forces action.
  const forced = records.filter((record) => record.current_tier === "T4" && record.compiled_tier !== "T4");
  return {
    degradation_rate: degraded.length / records.length,
    needs_rehardening: forced.map((record) => record.competency_id),
  };
}
