/**
 * Hardening: the counterfactual wind tunnel (plan Architecture Changes
 * "hardening.ts"; Worked Example 1 "Counterfactual wind tunnel").
 *
 * A recorded flow is hardened by replaying it through VARIANT WORLDS:
 *
 * - equivalent variants  (same semantics, different surface details)
 *     -> the flow MUST still succeed;
 * - non-equivalent twins (the targeted effect deliberately made impossible)
 *     -> the flow MUST fail. A contract passing a twin is VACUOUS.
 *
 * Outcomes feed the counterfactualDiscrimination metric. The runner is
 * substrate-blind: it only needs a ReplayProviderCap and pre-built handles.
 */

import type {
  ReplayProviderCap,
  SessionHandle,
  TraceFragmentLike,
} from "./substrate.js";

export interface WindTunnelVariant {
  variant_id: string;
  /**
   * true  = equivalent world: replay is expected to pass
   * false = non-equivalent twin: replay is expected to FAIL
   */
  equivalent: boolean;
  handle: SessionHandle;
}

export interface VariantOutcome {
  variant_id: string;
  equivalent: boolean;
  passed: boolean;
  /** Classifier trunks of failed steps (twins usually carry these). */
  failed_trunks: string[];
}

export interface HardeningReport {
  /** Every expectation met: equivalents passed, twins failed. */
  hardened: boolean;
  /** Twins where the replay wrongly succeeded - vacuous contract evidence. */
  vacuous_variants: string[];
  /** Equivalent worlds where the replay wrongly failed - brittle contract. */
  brittle_variants: string[];
  outcomes: VariantOutcome[];
}

export async function runWindTunnel(
  replayProvider: ReplayProviderCap,
  fragment: TraceFragmentLike,
  variants: readonly WindTunnelVariant[],
): Promise<HardeningReport> {
  const outcomes: VariantOutcome[] = [];

  for (const variant of variants) {
    const result = await replayProvider.replay(fragment, {
      handle: variant.handle,
      mode: "same_state",
    });
    const failedTrunks = result.step_results
      .filter((step) => !step.ok)
      .map((step) => step.classifier_trunk ?? "unknown")
      .filter((trunk, index, all) => all.indexOf(trunk) === index);
    outcomes.push({
      variant_id: variant.variant_id,
      equivalent: variant.equivalent,
      passed: result.ok,
      failed_trunks: failedTrunks,
    });
  }

  const vacuous_variants = outcomes
    .filter((outcome) => !outcome.equivalent && outcome.passed)
    .map((outcome) => outcome.variant_id);
  const brittle_variants = outcomes
    .filter((outcome) => outcome.equivalent && !outcome.passed)
    .map((outcome) => outcome.variant_id);

  return {
    hardened: vacuous_variants.length === 0 && brittle_variants.length === 0,
    vacuous_variants,
    brittle_variants,
    outcomes,
  };
}

