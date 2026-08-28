/**
 * Affordance tier utilities: ordering, downgrade propagation, and the
 * identity-survival rules that decide when a target reference must degrade.
 *
 * Tier ladder (shared across substrates):
 *   T0 semantic/tool  — named verb or tool invocation
 *   T1 source-linked  — anchored to source of the world itself
 *   T2 structural     — stable ids / roles within the running world
 *   T3 perceptual     — visible text, rendered regions
 *   T4 positional     — raw coordinates
 */

import type { AffordanceTier } from "./event.js";
import type { IdentitySpec, SurvivalClass } from "./world_state.js";

export const AFFORDANCE_RANK: Readonly<Record<AffordanceTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
};

export function tierAtLeast(tier: AffordanceTier, floor: AffordanceTier): boolean {
  return AFFORDANCE_RANK[tier] <= AFFORDANCE_RANK[floor];
}

export function bestTier(tiers: readonly AffordanceTier[]): AffordanceTier | undefined {
  if (tiers.length === 0) return undefined;
  return tiers.reduce((best, current) =>
    AFFORDANCE_RANK[current] < AFFORDANCE_RANK[best] ? current : best,
  );
}

/**
 * Which reality classes a given tier plausibly survives. Structural and
 * better references depend on identity persistence; perceptual and positional
 * references are recomputed from observations each run and survive whatever
 * observation survives — they just cannot be trusted for identity.
 */
function tierIdentityRequirement(tier: AffordanceTier): "identity" | "observation_only" {
  return AFFORDANCE_RANK[tier] <= AFFORDANCE_RANK.T2 ? "identity" : "observation_only";
}

export interface DowngradeDecision {
  /** The tier to use going forward. */
  effective_tier: AffordanceTier;
  /** True when the reference had to fall below the structural floor (T3+). */
  degraded_below_structural: boolean;
  reason?: string;
}

/**
 * Decide whether an affordance recorded at `recorded_tier` can still be used
 * at that tier after a reality change covered by `survived` classes.
 *
 * Rule: T0–T2 references lean on the world's identity scheme. If the identity
 * spec does not claim survival across the reality class in question, the
 * reference must degrade to perceptual/positional re-derivation (T3), which
 * is always flagged as below-structural so callers never silently coordinate-
 * click their way forward.
 */
export function affordanceAfterRealityChange(
  recordedTier: AffordanceTier,
  realityChange: SurvivalClass,
  identity: Pick<IdentitySpec, "survives">,
  options: { perceptual_fallback_tier?: AffordanceTier; reason?: string } = {},
): DowngradeDecision {
  if (tierIdentityRequirement(recordedTier) === "observation_only") {
    return { effective_tier: recordedTier, degraded_below_structural: false };
  }
  if (identity.survives.includes(realityChange)) {
    return { effective_tier: recordedTier, degraded_below_structural: false };
  }
  const fallback = options.perceptual_fallback_tier ?? "T3";
  return {
    effective_tier: fallback,
    degraded_below_structural: true,
    reason:
      options.reason ??
      `identity scheme does not survive "${realityChange}"; degrading ${recordedTier} reference to ${fallback}`,
  };
}
