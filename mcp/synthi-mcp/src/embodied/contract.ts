/**
 * Embodied workflow contract spine.
 *
 * The causal contract layer that made browser replays durable — preconditions,
 * intended action, expected effects, tolerated variants, hard failures,
 * recovery rules, data bindings — expressed over universal types so every
 * substrate compiles into the same shape.
 *
 * This module defines the DATA CONTRACT and its VALIDATION only. Emission of
 * substrate-specific scripts belongs to later phases. Severity rules are pure
 * functions: uncertain evidence may never silently back a high-severity
 * assertion.
 */

import type { AttributionEvidenceKind, EmbodiedAction, SubstrateKind, AffordanceTier } from "./event.js";
import { validateEmbodiedAction } from "./event.js";

export const EMBODIED_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * A reference to a typed predicate over a WorldStateSchema. Phase 0 treats
 * predicates as opaque structured references; generation from deltas happens
 * in the State Differ's compile stage, and evaluation against live worlds is
 * adapter work. The core only needs identity, arguments, and provenance.
 */
export interface PredicateRef {
  /** Schema-declared predicate kind id (adapter ontology, not core vocabulary). */
  predicate_id: string;
  /** Argument bindings; values are world-state paths or literals. */
  args?: Record<string, string | number | boolean>;
}

export type EffectSeverity = "hard" | "optional";

/** Where an effect's causal claim came from. Re-exported semantics from the
 *  differ: fork controls beat multi-demo votes beat raw timing correlation. */
export type EffectEvidence = AttributionEvidenceKind;

export interface UncertaintyAnnotation {
  evidence: EffectEvidence;
  /** Number of demonstrations/control runs backing the claim. */
  samples: number;
  /** True when relevance filtering had to drop candidates (budget). */
  truncated?: boolean;
  confidence: "high" | "medium" | "low";
}

export interface ContractPredicate {
  predicate: PredicateRef;
  /** Human-readable statement of intent; shown during confirmations. */
  statement?: string;
}

export interface ContractEffect extends ContractPredicate {
  severity: EffectSeverity;
  uncertainty: UncertaintyAnnotation;
}

export interface ContractHardFailure extends ContractPredicate {
  /** What classification to emit when this failure predicate fires. */
  classify_as?: string;
}

// ---------------------------------------------------------------------------
// Steps and contracts
// ---------------------------------------------------------------------------

export type DataBindingKind = "constant" | "parameter" | "environment" | "variant" | "generated";

export interface ContractStep {
  step_id: string;
  intent: string;
  substrate_kind: SubstrateKind;
  preconditions: ContractPredicate[];
  action: EmbodiedAction & {
    /** Preferred targeting tier; replay uses the highest surviving candidate. */
    preferred_affordance_tier?: AffordanceTier;
    /** Candidate targets recorded at teach time, best first. */
    target_affordance_refs?: Array<{ tier: AffordanceTier; ref: string }>;
  };
  expected_effects: ContractEffect[];
  tolerated_variants: string[];
  hard_failures: ContractHardFailure[];
  /** Free-form recovery policy id; known policies live in profiles. */
  recovery_rule?: string;
  data_bindings?: Record<string, DataBindingKind>;
  /** Set by humans during confirmation flows; unlocks severity promotions. */
  human_confirmed?: boolean;

  /** Forward compatibility: unknown fields ride along, never dropped. */
  [extension: string]: unknown;
}

export interface EmbodiedWorkflowContract {
  embodied_contract_version: typeof EMBODIED_CONTRACT_VERSION;
  contract_id: string;
  name?: string;
  steps: ContractStep[];
  /** Realms this competency is scoped to; licenses narrow further. */
  realm_scopes: Array<{ realm_kind: string; realm_id: string }>;
  [extension: string]: unknown;
}

// ---------------------------------------------------------------------------
// Severity policy (pure functions)
// ---------------------------------------------------------------------------

export interface SeverityPolicy {
  /** Effects backed by fewer demonstrations may not be hard assertions. */
  min_samples_for_hard: number;
  /** Whether budget-truncated evidence may back hard assertions at all. */
  allow_truncated_hard: boolean;
}

export const DEFAULT_SEVERITY_POLICY: SeverityPolicy = {
  min_samples_for_hard: 2,
  allow_truncated_hard: false,
};

export type SeverityDecision =
  | { allowed: true }
  | { allowed: false; refuse_because: string };

const TEMPORAL_ONLY_REFUSAL = "temporal_only evidence requires human confirmation before hard severity";
const LOW_CONFIDENCE_REFUSAL = "low-confidence predicates are refused for hard severity";
const INSUFFICIENT_SAMPLES_REFUSAL = "insufficient demonstration samples for hard severity";
const TRUNCATED_REFUSAL = "truncated delta extraction may not back hard severity";

/**
 * Decide whether an effect may hold hard severity under a policy. Pure;
 * no IO, no clocks. Human confirmation overrides the temporal-only rule but
 * nothing else: truncation and sample floors reflect real evidence limits.
 */
export function evaluateHardSeverity(
  effect: Pick<ContractEffect, "severity" | "uncertainty">,
  humanConfirmed: boolean,
  policy: SeverityPolicy = DEFAULT_SEVERITY_POLICY,
): SeverityDecision {
  if (effect.severity !== "hard") return { allowed: true };
  if (effect.uncertainty.evidence === "temporal_only" && !humanConfirmed) {
    return { allowed: false, refuse_because: TEMPORAL_ONLY_REFUSAL };
  }
  if (effect.uncertainty.confidence === "low") {
    return { allowed: false, refuse_because: LOW_CONFIDENCE_REFUSAL };
  }
  if (!policy.allow_truncated_hard && effect.uncertainty.truncated) {
    return { allowed: false, refuse_because: TRUNCATED_REFUSAL };
  }
  if (effect.uncertainty.samples < policy.min_samples_for_hard) {
    return { allowed: false, refuse_because: INSUFFICIENT_SAMPLES_REFUSAL };
  }
  return { allowed: true };
}

/**
 * Derive an uncertainty annotation from differ outputs. Deterministic mapping:
 * evidence quality dominates, then sample count, then truncation.
 */
export function deriveUncertainty(
  evidence: EffectEvidence,
  samples: number,
  truncated: boolean,
): UncertaintyAnnotation {
  let confidence: UncertaintyAnnotation["confidence"];
  if (evidence === "fork_control") {
    confidence = truncated ? "medium" : "high";
  } else if (evidence === "multi_demo_vote") {
    confidence = samples >= 3 ? "high" : truncated ? "low" : "medium";
  } else {
    // temporal_only is structurally weak.
    confidence = "low";
  }
  return {
    evidence,
    samples,
    ...(truncated ? { truncated: true } : {}),
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationProblem {
  path: string;
  problem: string;
}

function isValidDataBindingKind(value: unknown): value is DataBindingKind {
  return (
    value === "constant" ||
    value === "parameter" ||
    value === "environment" ||
    value === "variant" ||
    value === "generated"
  );
}

function validatePredicateRef(ref: unknown, path: string, problems: ValidationProblem[]): void {
  if (typeof ref !== "object" || ref === null) {
    problems.push({ path, problem: "predicate must be an object" });
    return;
  }
  const predicate = ref as PredicateRef;
  if (typeof predicate.predicate_id !== "string" || predicate.predicate_id.length === 0) {
    problems.push({ path, problem: "predicate.predicate_id must be a non-empty string" });
  }
}

/** Structural validation of a compiled step, including severity rules. */
export function validateContractStep(
  step: ContractStep,
  policy: SeverityPolicy = DEFAULT_SEVERITY_POLICY,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const base = "steps[].";

  if (typeof step.step_id !== "string" || step.step_id.length === 0) {
    problems.push({ path: `${base}step_id`, problem: "must be a non-empty string" });
  }
  if (typeof step.intent !== "string" || step.intent.length === 0) {
    problems.push({ path: `${base}intent`, problem: "must be a non-empty string" });
  }
  if (!Array.isArray(step.preconditions)) {
    problems.push({ path: `${base}preconditions`, problem: "must be an array" });
  } else {
    step.preconditions.forEach((p, i) =>
      validatePredicateRef(p?.predicate, `${base}preconditions[${i}]`, problems),
    );
  }

  if (typeof step.action !== "object" || step.action === null) {
    problems.push({ path: `${base}action`, problem: "must be an object" });
  } else {
    for (const problem of validateEmbodiedAction(step.action)) {
      problems.push({ path: `${base}action`, problem });
    }
  }

  if (!Array.isArray(step.expected_effects)) {
    problems.push({ path: `${base}expected_effects`, problem: "must be an array" });
  } else {
    step.expected_effects.forEach((effect, i) => {
      validatePredicateRef(effect?.predicate, `${base}expected_effects[${i}]`, problems);
      if (effect && typeof effect.uncertainty !== "object") {
        problems.push({
          path: `${base}expected_effects[${i}].uncertainty`,
          problem: "effects must carry an uncertainty annotation",
        });
        return;
      }
      if (effect) {
        const decision = evaluateHardSeverity(effect, step.human_confirmed === true, policy);
        if (!decision.allowed) {
          problems.push({
            path: `${base}expected_effects[${i}]`,
            problem: decision.refuse_because,
          });
        }
      }
    });
  }

  if (!Array.isArray(step.hard_failures)) {
    problems.push({ path: `${base}hard_failures`, problem: "must be an array" });
  } else {
    step.hard_failures.forEach((f, i) =>
      validatePredicateRef(f?.predicate, `${base}hard_failures[${i}]`, problems),
    );
  }

  if (!Array.isArray(step.tolerated_variants)) {
    problems.push({ path: `${base}tolerated_variants`, problem: "must be an array" });
  }

  if (step.data_bindings) {
    for (const [key, value] of Object.entries(step.data_bindings)) {
      if (!isValidDataBindingKind(value)) {
        problems.push({
          path: `${base}data_bindings.${key}`,
          problem: `invalid binding kind "${String(value)}"`,
        });
      }
    }
  }

  return problems;
}

/**
 * Forward-compatible parse of a serialized contract. Unknown top-level fields
 * are preserved verbatim; known fields are structurally validated. Parse and
 * re-serialize round-trips without information loss.
 */
export function parseEmbodiedContract(
  serialized: unknown,
): { ok: true; contract: EmbodiedWorkflowContract } | { ok: false; problems: ValidationProblem[] } {
  if (typeof serialized !== "object" || serialized === null) {
    return { ok: false, problems: [{ path: "", problem: "contract must be an object" }] };
  }
  const candidate = serialized as Partial<EmbodiedWorkflowContract> &
    Record<string, unknown>;
  const problems: ValidationProblem[] = [];

  if (candidate.embodied_contract_version !== EMBODIED_CONTRACT_VERSION) {
    problems.push({
      path: "embodied_contract_version",
      problem: `expected ${EMBODIED_CONTRACT_VERSION}`,
    });
  }
  if (typeof candidate.contract_id !== "string" || candidate.contract_id.length === 0) {
    problems.push({ path: "contract_id", problem: "must be a non-empty string" });
  }
  if (!Array.isArray(candidate.realm_scopes)) {
    problems.push({ path: "realm_scopes", problem: "must be an array" });
  }
  if (!Array.isArray(candidate.steps)) {
    problems.push({ path: "steps", problem: "must be an array" });
  } else {
    for (const step of candidate.steps) {
      problems.push(...validateContractStep(step as ContractStep));
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, contract: candidate as EmbodiedWorkflowContract };
}
