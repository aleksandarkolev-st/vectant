/**
 * Governance unification (plan P5): case law, entrustment dial, and the
 * unified mixed-substrate proof capsule.
 *
 * - CaseLaw: every license whose later behavior contradicted its tested
 *   scope produces a case entry; future authorization consults case law
 *   (a competency with an unresolved violation on a substrate is held at
 *   E1 there until re-verified).
 * - Entrustment dial: promotion requires evidence; demotion is immediate.
 * - ProofCapsule: one competency's evidence may span multiple substrates;
 *   validation checks the capsule against the single license.
 */
import {
  authorizeRun,
  ENTRUSTMENT_ORDER,
  type CompetencyLicense,
  type EntrustmentLevel,
} from "./governance.js";

export interface CaseLawEntry {
  entry_id: string;
  competency_id: string;
  substrate_kind: string;
  /** What the license claimed vs what happened. */
  contradiction: string;
  detected_at_ms: number;
}

export class CaseLaw {
  private readonly entries: CaseLawEntry[] = [];

  record(entry: Omit<CaseLawEntry, "entry_id">): CaseLawEntry {
    const full: CaseLawEntry = { ...entry, entry_id: `case-${this.entries.length + 1}` };
    this.entries.push(full);
    return full;
  }

  /** Substrates where this competency has an unresolved violation. */
  violatedSubstrates(competencyId: string): Set<string> {
    const out = new Set<string>();
    for (const entry of this.entries) {
      if (entry.competency_id === competencyId) out.add(entry.substrate_kind);
    }
    return out;
  }

  all(): readonly CaseLawEntry[] {
    return this.entries;
  }
}

/**
 * Authorization with case law: identical to governance.authorizeRun except
 * that a substrate with an unresolved violation caps the effective level at
 * E1 (observe-only) regardless of what the license says.
 */
export function authorizeRunWithCaseLaw(
  licenses: readonly CompetencyLicense[],
  caseLaw: CaseLaw,
  request: Parameters<typeof authorizeRun>[1],
): ReturnType<typeof authorizeRun> {
  if (caseLaw.violatedSubstrates(request.competency_id).has(request.substrate_kind)) {
    // Violated substrate: refuse anything above observe-only outright.
    if (ENTRUSTMENT_ORDER[request.required_level] > ENTRUSTMENT_ORDER.E1_observe_only) {
      return {
        authorized: false,
        reason_code: "insufficient_trust",
        human_reason:
          "This capability contradicted its verified scope here; it is held back until re-verified.",
      };
    }
    // Observe-only requests still pass through the normal license check.
    return authorizeRun(licenses, request);
  }
  return authorizeRun(licenses, request);
}

// ---------------------------------------------------------------------------
// Entrustment dial + mixed-substrate proof capsule
// ---------------------------------------------------------------------------

export interface SubstrateEvidence {
  substrate_kind: string;
  realm_id: string;
  /** Replay passes on this substrate. */
  same_state_passes: number;
  fresh_state_passes: number;
  /** Twin discrimination proven (non-equivalent variant failed)? */
  discrimination_proven: boolean;
}

/**
 * Unified proof capsule: one competency's evidence may span multiple
 * substrates. Validation checks the capsule against a single license:
 * every licensed substrate must carry evidence, and promotion to
 * autonomous action requires discrimination proof on each.
 */
export interface ProofCapsule {
  competency_id: string;
  evidence: SubstrateEvidence[];
}

export type CapsuleValidation =
  | { valid: true; covers_all_licensed_substrates: boolean; promotion_eligible: boolean }
  | { valid: false; reason_code: string; human_reason: string };

export function validateProofCapsule(
  capsule: ProofCapsule,
  license: CompetencyLicense,
  now = Date.now(),
): CapsuleValidation {
  if (capsule.competency_id !== license.competency_id) {
    return {
      valid: false,
      reason_code: "competency_mismatch",
      human_reason: "The evidence belongs to a different capability than the license.",
    };
  }
  const bySubstrate = new Map(capsule.evidence.map((evidence) => [evidence.substrate_kind, evidence]));
  const missing = license.substrate_scope.filter((kind) => !bySubstrate.has(kind));
  const coversAll = missing.length === 0;
  const expired = now > license.expires_at_ms;
  const promotionEligible =
    !expired &&
    license.substrate_scope.every((kind) => {
      const evidence = bySubstrate.get(kind);
      return (
        evidence !== undefined &&
        evidence.discrimination_proven &&
        evidence.same_state_passes > 0 &&
        evidence.fresh_state_passes > 0
      );
    });
  return {
    valid: true,
    covers_all_licensed_substrates: coversAll,
    promotion_eligible: promotionEligible,
  };
}

/** The entrustment dial: promote only with a promotion-eligible capsule. */
export function dialEntrustment(
  license: CompetencyLicense,
  capsule: ProofCapsule,
  direction: "promote" | "demote",
  now = Date.now(),
): CompetencyLicense {
  if (direction === "demote") {
    // Demotion is immediate, one level, never below E1.
    const current = ENTRUSTMENT_ORDER[license.entrustment];
    const levels = Object.keys(ENTRUSTMENT_ORDER) as EntrustmentLevel[];
    const next = levels.find((level) => ENTRUSTMENT_ORDER[level] === Math.max(1, current - 1)) ?? "E1_observe_only";
    return { ...license, entrustment: next };
  }
  const validation = validateProofCapsule(capsule, license, now);
  if (validation.valid && validation.promotion_eligible) {
    const current = ENTRUSTMENT_ORDER[license.entrustment];
    const max = ENTRUSTMENT_ORDER.E4_autonomous_action;
    if (current >= max) return license;
    const levels = Object.keys(ENTRUSTMENT_ORDER) as EntrustmentLevel[];
    const next = levels.find((level) => ENTRUSTMENT_ORDER[level] === current + 1)!;
    return { ...license, entrustment: next };
  }
  return license;
}

