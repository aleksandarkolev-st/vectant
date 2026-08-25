/**
 * Failure classifier: universal trunk classes plus per-substrate namespaces.
 *
 * Rules:
 * - Every failure resolves to exactly one trunk class; substrates may attach
 *   one namespaced subclass for detail.
 * - The trunk is shared code and never branches on substrate-specific text;
 *   input is structured evidence, never raw error strings.
 * - Subclass registries are explicit: registering a duplicate id fails, and
 *   lookups against unregistered substrates degrade to trunk-only answers.
 */

import type { AffordanceTier } from "./event.js";

// ---------------------------------------------------------------------------
// Trunk classes
// ---------------------------------------------------------------------------

export type FailureTrunkClass =
  /** The affordance/perception target drifted or was misidentified. */
  | "perception_drift"
  /** A previously resolvable target can no longer be reidentified at all. */
  | "identity_lost"
  /** Authentication state missing, expired, or refresh failed. */
  | "auth"
  /** Realm consent missing, expired, or revoked for this capability. */
  | "consent_missing"
  /** A write/mutating action was blocked by policy or isolation rules. */
  | "mutation_blocked"
  /** The environment is not in a safe state to act (sandbox down, hostile). */
  | "unsafe_environment"
  /** Required parameterized data or fixtures are absent. */
  | "test_data_missing"
  /** The world moved: route, schema, layout, or scene structure changed. */
  | "world_changed"
  /** The world had not finished loading/hydrating when observed. */
  | "load_delay"
  /** Transport-level failure between actor and environment. */
  | "network_failure"
  /** The application rejected the action semantically (validation, state). */
  | "app_validation_error"
  /** The substrate cannot express the required action reliably. */
  | "substrate_limitation"
  | "unknown";

export const FAILURE_TRUNK_CLASSES: readonly FailureTrunkClass[] = [
  "perception_drift",
  "identity_lost",
  "auth",
  "consent_missing",
  "mutation_blocked",
  "unsafe_environment",
  "test_data_missing",
  "world_changed",
  "load_delay",
  "network_failure",
  "app_validation_error",
  "substrate_limitation",
  "unknown",
];

// ---------------------------------------------------------------------------
// Substrate subclass registry
// ---------------------------------------------------------------------------

export interface SubstrateFailureClass {
  /** Namespaced id, e.g. "game.entity_not_found". */
  id: string;
  trunk: Exclude<FailureTrunkClass, "unknown">;
  description?: string;
}

interface RegistryEntry {
  classes: Map<string, SubstrateFailureClass>;
}

const registries = new Map<string, RegistryEntry>();

export class SubstrateClassCollisionError extends Error {}

/**
 * Register substrate-namespaced failure classes. Idempotent for identical
 * re-registration of the same id with identical definition; rejects any
 * conflicting reuse of an id within a substrate namespace.
 */
export function registerSubstrateClasses(
  substrate: string,
  classes: SubstrateFailureClass[],
): void {
  let entry = registries.get(substrate);
  if (!entry) {
    entry = { classes: new Map() };
    registries.set(substrate, entry);
  }
  for (const failureClass of classes) {
    if (!failureClass.id.startsWith(`${substrate}.`)) {
      throw new SubstrateClassCollisionError(
        `subclass id "${failureClass.id}" must be namespaced under "${substrate}."`,
      );
    }
    if (!FAILURE_TRUNK_CLASSES.includes(failureClass.trunk)) {
      throw new SubstrateClassCollisionError(
        `subclass "${failureClass.id}" maps to unknown trunk "${failureClass.trunk}"`,
      );
    }
    const existing = entry.classes.get(failureClass.id);
    if (existing) {
      if (
        existing.trunk === failureClass.trunk &&
        existing.description === failureClass.description
      ) {
        continue; // identical re-registration is a no-op
      }
      throw new SubstrateClassCollisionError(
        `subclass id "${failureClass.id}" already registered in "${substrate}"`,
      );
    }
    entry.classes.set(failureClass.id, { ...failureClass });
  }
}

export function lookupSubstrateClass(
  substrate: string,
  id: string,
): SubstrateFailureClass | undefined {
  return registries.get(substrate)?.classes.get(id);
}

/** Test isolation helper: forget all registrations (never used in prod paths). */
export function resetSubstrateClassRegistries(): void {
  registries.clear();
}

// ---------------------------------------------------------------------------
// Total mapping from the legacy browser failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Legacy browser failure classes (structural mirror of the adapter's
 * FailureClassV7 union — never imported).
 */
export type BrowserFailureClassV7Shape =
  | "locatorDrift"
  | "authMissing"
  | "authExpired"
  | "authRefreshFailed"
  | "mutationBlocked"
  | "originConsentMissing"
  | "unsafeEnvironment"
  | "testDataMissing"
  | "routeChanged"
  | "hydrationDelay"
  | "networkFailure"
  | "appValidationError"
  | "closedShadowDomBlocked"
  | "canvasUnreliable"
  | "pointerDragUnreliable"
  | "sourceIdentityMissing"
  | "unknown";

const BROWSER_V7_MAPPING: Record<
  BrowserFailureClassV7Shape,
  { trunk: FailureTrunkClass; sub?: string }
> = {
  locatorDrift: { trunk: "perception_drift", sub: "browser.locatorDrift" },
  authMissing: { trunk: "auth", sub: "browser.authMissing" },
  authExpired: { trunk: "auth", sub: "browser.authExpired" },
  authRefreshFailed: { trunk: "auth", sub: "browser.authRefreshFailed" },
  mutationBlocked: { trunk: "mutation_blocked" },
  originConsentMissing: { trunk: "consent_missing", sub: "browser.originConsentMissing" },
  unsafeEnvironment: { trunk: "unsafe_environment" },
  testDataMissing: { trunk: "test_data_missing" },
  routeChanged: { trunk: "world_changed", sub: "browser.routeChanged" },
  hydrationDelay: { trunk: "load_delay", sub: "browser.hydrationDelay" },
  networkFailure: { trunk: "network_failure" },
  appValidationError: { trunk: "app_validation_error" },
  closedShadowDomBlocked: { trunk: "substrate_limitation", sub: "browser.closedShadowDomBlocked" },
  canvasUnreliable: { trunk: "substrate_limitation", sub: "browser.canvasUnreliable" },
  pointerDragUnreliable: { trunk: "substrate_limitation", sub: "browser.pointerDragUnreliable" },
  sourceIdentityMissing: { trunk: "identity_lost", sub: "browser.sourceIdentityMissing" },
  unknown: { trunk: "unknown" },
};

const BROWSER_V7_MEMBERS: readonly BrowserFailureClassV7Shape[] = [
  "locatorDrift",
  "authMissing",
  "authExpired",
  "authRefreshFailed",
  "mutationBlocked",
  "originConsentMissing",
  "unsafeEnvironment",
  "testDataMissing",
  "routeChanged",
  "hydrationDelay",
  "networkFailure",
  "appValidationError",
  "closedShadowDomBlocked",
  "canvasUnreliable",
  "pointerDragUnreliable",
  "sourceIdentityMissing",
  "unknown",
];

/** Total mapping from every legacy browser failure class. */
export function fromBrowserFailureClass(
  legacy: BrowserFailureClassV7Shape,
): { trunk: FailureTrunkClass; sub?: string } {
  return BROWSER_V7_MAPPING[legacy];
}

// ---------------------------------------------------------------------------
// Evidence-shaped classification
// ---------------------------------------------------------------------------

export type ClassificationEvidence =
  | { kind: "realm_gate"; realm_approved: false; capability: string }
  | { kind: "lease"; lease_active: false; mutating: boolean }
  | {
      kind: "affordance_resolution";
      resolved: false;
      best_tier?: AffordanceTier;
      previously_stable_tier?: AffordanceTier;
    }
  | { kind: "identity_reidentification"; matched: false; candidates_tried: number }
  | { kind: "timing"; waited_ms: number; budget_ms: number; settled: false }
  | { kind: "transport"; attempts: number; reachable: boolean }
  | { kind: "app_rejection"; validation_errors: number; state_conflict: boolean }
  | { kind: "policy_block"; reason: "isolation_required" | "blast_radius" | "irreversible" }
  | { kind: "environment_state"; safe_to_act: false }
  | { kind: "data_binding"; missing_bindings: string[] }
  | { kind: "unclassified" };

/**
 * Deterministic classification from structured evidence. Precedence follows
 * the order below on purpose: authority problems (consent, lease/policy)
 * must be reported before perceptual ones, because acting without authority
 * is worse than failing to find a target.
 */
export function classifyFromEvidence(
  evidence: ClassificationEvidence,
  substrate?: string,
): { trunk: FailureTrunkClass; sub?: string } {
  switch (evidence.kind) {
    case "realm_gate":
      return { trunk: "consent_missing", ...(substrate ? {} : {}) };
    case "lease":
      return evidence.mutating ? { trunk: "mutation_blocked" } : { trunk: "unsafe_environment" };
    case "policy_block":
      return { trunk: "mutation_blocked" };
    case "environment_state":
      return { trunk: "unsafe_environment" };
    case "identity_reidentification":
      return { trunk: "identity_lost" };
    case "affordance_resolution": {
      const drifted =
        evidence.previously_stable_tier !== undefined &&
        evidence.best_tier !== undefined &&
        tierRank(evidence.best_tier) > tierRank(evidence.previously_stable_tier);
      return { trunk: "perception_drift", ...(drifted && substrate && lookupSubstrateClass(substrate, `${substrate}.perceptionDowngrade`) ? { sub: `${substrate}.perceptionDowngrade` } : {}) };
    }
    case "timing":
      return { trunk: "load_delay" };
    case "transport":
      return evidence.reachable || evidence.attempts === 0
        ? { trunk: "network_failure" }
        : { trunk: "unsafe_environment" };
    case "app_rejection":
      return { trunk: "app_validation_error" };
    case "data_binding":
      return evidence.missing_bindings.length > 0
        ? { trunk: "test_data_missing" }
        : { trunk: "unknown" };
    case "unclassified":
      return { trunk: "unknown" };
  }
  throw new TypeError(
    "classifyFromEvidence requires ClassificationEvidence; raw error text is not accepted",
  );
}

function tierRank(tier: AffordanceTier): number {
  return AFFORDANCE_RANK[tier];
}

const AFFORDANCE_RANK: Record<AffordanceTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
};

/** Exhaustiveness guard used by tests: every V7 member must map somewhere. */
export function allBrowserV7Members(): readonly BrowserFailureClassV7Shape[] {
  return BROWSER_V7_MEMBERS;
}
