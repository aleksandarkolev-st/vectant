/**
 * Competency licensing: bounded trust for compiled workflows.
 *
 * A competency may only RUN where its license says it may: per substrate
 * kind, per exact realm scope, up to an entrustment level, with optional
 * expiry. The runner consults this module BEFORE any replay; unlicensed
 * runs are refused with a human-readable reason (no jargon escapes).
 *
 * Pure module: no IO, clocks injected as `now`.
 */

export type EntrustmentLevel = "E1_observe_only" | "E2_supervised" | "E3_sandboxed_action" | "E4_autonomous_action";

export const ENTRUSTMENT_ORDER: Readonly<Record<EntrustmentLevel, number>> = {
  E1_observe_only: 1,
  E2_supervised: 2,
  E3_sandboxed_action: 3,
  E4_autonomous_action: 4,
};

export interface CompetencyLicense {
  license_id: string;
  competency_id: string;
  /** Substrate kinds this competency may execute on. */
  substrate_scope: readonly string[];
  /** Exact realm scopes (both coordinates must match byte-for-byte). */
  realm_scopes: ReadonlyArray<{ realm_kind: string; realm_id: string }>;
  /** Highest granted level; lower levels are included. */
  entrustment: EntrustmentLevel;
  issued_at_ms: number;
  expires_at_ms: number;
}

export interface RunAuthorizationRequest {
  competency_id: string;
  substrate_kind: string;
  realm: { realm_kind: string; realm_id: string };
  required_level: EntrustmentLevel;
  now: number;
}

export type AuthorizationDecision =
  | { authorized: true; license_id: string }
  | { authorized: false; reason_code: string; human_reason: string };

function sameScope(
  a: { realm_kind: string; realm_id: string },
  b: { realm_kind: string; realm_id: string },
): boolean {
  return a.realm_kind === b.realm_kind && a.realm_id === b.realm_id;
}

const HUMAN_REASONS: Record<string, string> = {
  no_license:
    "This capability has not been taught and verified yet, so it cannot run.",
  wrong_substrate:
    "This capability was verified somewhere else; re-teach it in this kind of world.",
  realm_out_of_scope:
    "This capability is licensed for specific places only, and this is not one of them.",
  insufficient_trust:
    "This step needs more trust than the license grants yet.",
  expired:
    "This capability's verification has expired. Re-run its checks to renew.",
};

/**
 * The single authorization decision every runner calls. Fail-closed.
 */
export function authorizeRun(
  licenses: readonly CompetencyLicense[],
  request: RunAuthorizationRequest,
): AuthorizationDecision {
  const candidates = licenses.filter((l) => l.competency_id === request.competency_id);
  if (candidates.length === 0) {
    return {
      authorized: false,
      reason_code: "no_license",
      human_reason: HUMAN_REASONS.no_license as string,
    };
  }
  // Newest applicable license wins; others are ignored, not merged.
  const license = candidates
    .slice()
    .sort((a, b) => b.expires_at_ms - a.expires_at_ms)[0] as CompetencyLicense;

  if (!license.substrate_scope.includes(request.substrate_kind)) {
    return {
      authorized: false,
      reason_code: "wrong_substrate",
      human_reason: HUMAN_REASONS.wrong_substrate as string,
    };
  }
  if (!license.realm_scopes.some((scope) => sameScope(scope, request.realm))) {
    return {
      authorized: false,
      reason_code: "realm_out_of_scope",
      human_reason: HUMAN_REASONS.realm_out_of_scope as string,
    };
  }
  if (
    ENTRUSTMENT_ORDER[license.entrustment] < ENTRUSTMENT_ORDER[request.required_level]
  ) {
    return {
      authorized: false,
      reason_code: "insufficient_trust",
      human_reason: HUMAN_REASONS.insufficient_trust as string,
    };
  }
  if (request.now > license.expires_at_ms) {
    return { authorized: false, reason_code: "expired", human_reason: HUMAN_REASONS.expired as string };
  }
  return { authorized: true, license_id: license.license_id };
}
