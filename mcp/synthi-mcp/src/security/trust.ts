/**
 * Trust progression ledger (WI_WARRANTS_SPEC, Patches F+G): earned-autonomy
 * ladders kept OUT of the credential. Authorization stays in the warrant
 * (what a holder may do, decided by WarrantRegistry.check); trust lives here
 * as a separately owned binding between a warrant and a registered
 * ProgressionPolicy (what a holder may GROW into). Admitted calls feed the
 * policy's evidence gates and unlock its steps as extra grants; probe-shaped
 * denials demote a rung and start a cooldown; unbinding drops progression
 * entirely and the warrant reverts to exactly its issued grants.
 *
 * Pure module: zero IO, no clock reads — time enters as `now`. Nothing here
 * mutates warrants; composing trust with authorization happens in the tools
 * layer. Construction takes an optional pure existence probe so `bind` can
 * verify the target warrant without importing the registry.
 */

import { patternIsStricterOrEqual, type ToolGrant, type Warrant } from "./warrant.js";

/** Floor for any step's min_sample: smaller evidence samples prove nothing. */
const MIN_EVIDENCE_SAMPLE = 5;
/** Probe-shaped denials within a rung that trigger a one-rung demotion. */
const PROBE_DEMOTION_THRESHOLD = 3;
/** How long a demotion locks a warrant out of progression gains (and rebinding). */
const COOLDOWN_MS = 60_000;
export { MIN_EVIDENCE_SAMPLE, PROBE_DEMOTION_THRESHOLD, COOLDOWN_MS };

/** A policy's ladder may never run deeper than this many steps. */
const MAX_POLICY_DEPTH = 4;

/** One rung of a trust ladder: extra grants unlocked once the evidence gate is met. */
export interface ProgressionStep {
  unlock_after: { min_sample: number; success_ratio: number };
  grants: readonly ToolGrant[];
}

/**
 * An organization-owned trust ladder, frozen at registration: its steps can
 * never change underneath the warrants bound to it.
 */
export interface ProgressionPolicy {
  policy_id: string;
  steps: readonly ProgressionStep[];
}

/** Runtime trust state for one bound warrant (never part of the warrant itself). */
interface Binding {
  policy_id: string;
  admitted_count: number;
  denied_count: number;
  demoted_rungs: number;
  cooldown_until_ms: number;
}

/** Denial reason codes counted as probing: repeated, they signal boundary testing, not bad luck. */
const PROBE_REASON_CODES: ReadonlySet<string> = new Set([
  "tool_not_covered",
  "arg_out_of_scope",
  "bearer_mismatch",
]);

/**
 * Pure progression math: how many rungs the evidence currently unlocks
 * (before demotion) plus the first locked rung, if any. Zero IO.
 */
function computeProgress(
  binding: Binding,
  policy: ProgressionPolicy,
): { currentRung: number; nextStep: ProgressionStep | undefined } {
  const ratio =
    binding.denied_count === 0
      ? 1
      : binding.admitted_count / (binding.admitted_count + binding.denied_count);
  let unlocked = 0;
  let nextStep: ProgressionStep | undefined;
  for (const step of policy.steps) {
    if (
      binding.admitted_count >= step.unlock_after.min_sample &&
      ratio >= step.unlock_after.success_ratio
    ) {
      unlocked += 1;
    } else if (nextStep === undefined) {
      nextStep = step;
    }
  }
  return { currentRung: Math.max(0, unlocked - binding.demoted_rungs), nextStep };
}

/**
 * Patch G8: keep progression grants authority-shaped. At bind time every
 * step grant for a tool the warrant itself covers must carry arg constraints
 * equal to or stricter than the warrant's own grant for that key (per-key
 * literal comparison, mirroring attenuation rules) — trust may narrow a
 * warrant, never widen it. Tools outside the warrant's own grants need no
 * check here: they cannot widen the tool set because authorization always
 * evaluates over the base grants UNION ledger-unlocked ones. Any step grant
 * carrying max_invocations throws: budgets belong to issuance, not to trust
 * ladders. Throws human Errors; call only after both sides are resolved.
 */
export function validateStepGrantsForBind(
  steps: readonly ProgressionStep[],
  warrant: Warrant | undefined,
): void {
  for (const step of steps) {
    for (const grant of step.grants) {
      if (grant.max_invocations !== undefined) {
        throw new Error(
          `A progression step grant for tool '${grant.tool}' carries max_invocations; invocation budgets belong to issuance, not to trust ladders.`,
        );
      }
      if (warrant === undefined) continue;
      const baseGrant = warrant.grants.find((candidate) => candidate.tool === grant.tool);
      if (baseGrant === undefined) continue;
      const constraints = grant.arg_constraints;
      if (constraints === undefined) continue;
      for (const key of Object.keys(constraints)) {
        const stepPattern = constraints[key]!;
        const warrantPattern =
          baseGrant.arg_constraints === undefined ? undefined : baseGrant.arg_constraints[key];
        if (!patternIsStricterOrEqual(stepPattern, warrantPattern)) {
          throw new Error(
            `Cannot bind trust: arg constraint '${key}' on tool '${grant.tool}' (${JSON.stringify(stepPattern)}) is not equal to or stricter than the warrant's own (${
              warrantPattern === undefined ? "unrestricted" : JSON.stringify(warrantPattern)
            }); trust may narrow a warrant, never widen it.`,
          );
        }
      }
    }
  }
}

export class TrustLedger {
  private readonly policies = new Map<string, ProgressionPolicy>();
  private readonly bindings = new Map<string, Binding>();

  /**
   * `warrantExists` is an optional pure probe (typically wired to the
   * WarrantRegistry by the tools layer) that lets `bind` reject unknown
   * warrant identifiers; without it, bind verifies policies only.
   */
  constructor(private readonly warrantExists?: (warrantId: string) => boolean) {}

  /**
   * Register an organization's trust ladder. Validates the ladder's shape
   * (non-empty, depth cap, finite evidence floor, ratio range, no duplicate
   * tools across rungs — Patch G4) and deep-freezes the policy on copies
   * (Patch G5), so bound warrants always progress under the exact rules they
   * were bound to and nobody can mutate a rule underneath them. Duplicate
   * policy identifiers throw. All failures are human Errors.
   */
  registerPolicy(input: { policy_id: string; steps: readonly ProgressionStep[] }): ProgressionPolicy {
    const policyId = input.policy_id;
    if (typeof policyId !== "string" || policyId.trim().length === 0) {
      throw new Error("A progression policy needs a non-empty 'policy_id'.");
    }
    if (!Array.isArray(input.steps)) {
      throw new Error("A progression policy needs an array of steps.");
    }
    if (input.steps.length === 0) {
      throw new Error("A progression policy needs at least one step; an empty ladder unlocks nothing.");
    }
    if (input.steps.length > MAX_POLICY_DEPTH) {
      throw new Error(`A progression policy may not exceed a depth of ${MAX_POLICY_DEPTH} steps.`);
    }
    const seenTools = new Set<string>();
    for (const step of input.steps) {
      if (!Number.isFinite(step.unlock_after.min_sample)) {
        throw new Error("A progression step needs a finite 'min_sample'.");
      }
      if (step.unlock_after.min_sample < MIN_EVIDENCE_SAMPLE) {
        throw new Error(
          `A progression step needs at least ${MIN_EVIDENCE_SAMPLE} admitted calls before it can unlock.`,
        );
      }
      if (!(step.unlock_after.success_ratio > 0 && step.unlock_after.success_ratio <= 1)) {
        throw new Error("A progression step needs a success ratio greater than 0 and at most 1.");
      }
      for (const grant of step.grants) {
        if (seenTools.has(grant.tool)) {
          throw new Error(
            `A progression policy has a duplicate grant for tool '${grant.tool}' across its rungs.`,
          );
        }
        seenTools.add(grant.tool);
      }
    }
    if (this.policies.has(policyId)) {
      throw new Error(`A progression policy with identifier '${policyId}' is already registered.`);
    }
    // Deep-frozen copies: neither the registering org nor anyone holding the
    // returned reference can change a rule under already-bound warrants.
    const policy: ProgressionPolicy = Object.freeze({
      policy_id: policyId,
      steps: Object.freeze(
        input.steps.map((step) =>
          Object.freeze({
            unlock_after: Object.freeze({ ...step.unlock_after }),
            grants: Object.freeze([...step.grants]),
          }),
        ),
      ),
    });
    this.policies.set(policyId, policy);
    return policy;
  }

  /**
   * Bind an EXISTING warrant to a registered policy: from here on its call
   * outcomes feed that policy's evidence gates. Unknown warrant or policy
   * identifiers throw. When the caller supplies the resolved `warrant`,
   * every step grant must stay authority-shaped relative to it (Patch G8:
   * equal-or-stricter arg constraints per key, never max_invocations) so a
   * ladder can only ever narrow what the warrant itself allows. Rebinding
   * is blocked while the warrant is cooling down from a probe demotion (a
   * policy switch must not become a cooldown escape); the guard defaults to
   * fail-closed when no `now` is supplied.
   *
   * Counter semantics on rebind (Patch G3): switching to a DIFFERENT policy
   * resets admitted/denied to zero — fresh evidence must be earned under
   * the new policy's own rules — while PRESERVING demoted_rungs, so a
   * probe-shaped demotion cannot be laundered away by switching ladders.
   * Rebinding to the SAME policy preserves everything (an idempotent
   * re-affirmation); unbind() remains the deliberate escape valve that
   * drops progression state entirely.
   */
  bind(
    warrantId: string,
    policyId: string,
    now: number = Number.POSITIVE_INFINITY,
    warrant?: Warrant,
  ): void {
    const policy = this.policies.get(policyId);
    if (policy === undefined) {
      throw new Error(`Cannot bind trust: no progression policy registered under '${policyId}'.`);
    }
    if (this.warrantExists !== undefined && !this.warrantExists(warrantId)) {
      throw new Error(`Cannot bind trust: no warrant exists with identifier '${warrantId}'.`);
    }
    validateStepGrantsForBind(policy.steps, warrant);
    const existing = this.bindings.get(warrantId);
    if (existing !== undefined && existing.cooldown_until_ms > now) {
      throw new Error(
        `Cannot bind trust: warrant '${warrantId}' is cooling down from a probe demotion; rebinding stays blocked until the cooldown expires.`,
      );
    }
    if (existing === undefined || existing.policy_id !== policyId) {
      // Policy change (or first bind): evidence starts from zero, by design,
      // but demotions carry over — they are discipline, not evidence.
      this.bindings.set(warrantId, {
        policy_id: policyId,
        admitted_count: 0,
        denied_count: 0,
        demoted_rungs: existing?.demoted_rungs ?? 0,
        cooldown_until_ms: 0,
      });
    }
  }

  /**
   * Detach a warrant from its policy: it reverts to exactly its issued
   * grants and stops accumulating evidence. Deliberately ALLOWED even while
   * the warrant is cooling down from a probe demotion — unbinding is the
   * Patch G3 escape valve (progression drops entirely, authority reverts to
   * base), whereas rebinding stays blocked. Unbound or unknown ids throw.
   */
  unbind(warrantId: string): void {
    if (!this.bindings.delete(warrantId)) {
      throw new Error(
        `Cannot unbind trust: warrant '${warrantId}' is not bound to any progression policy.`,
      );
    }
  }

  /**
   * Feed one call outcome into a bound warrant's evidence. Allowed calls
   * count toward unlocking the next rung; probe-shaped denials
   * (tool_not_covered, arg_out_of_scope, bearer_mismatch) count against it
   * and, at PROBE_DEMOTION_THRESHOLD, demote one rung (capped at the
   * policy's depth), reset the denial streak, and start a COOLDOWN_MS
   * cooldown. Budget and lifecycle denials never touch trust. Unknown or
   * unbound warrant ids are silently ignored — no binding, no progression.
   */
  record(
    warrantId: string,
    outcome: { allowed: true } | { allowed: false; reason_code: string },
    now: number,
  ): void {
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) return;
    if (outcome.allowed) {
      binding.admitted_count += 1;
      return;
    }
    if (!PROBE_REASON_CODES.has(outcome.reason_code)) return;
    binding.denied_count += 1;
    if (binding.denied_count < PROBE_DEMOTION_THRESHOLD) return;
    const depth = this.policies.get(binding.policy_id)?.steps.length ?? 0;
    binding.demoted_rungs = Math.min(binding.demoted_rungs + 1, depth);
    binding.denied_count = 0;
    binding.cooldown_until_ms = now + COOLDOWN_MS;
  }

  /**
   * Live trust view for a bound warrant: which policy it follows, its
   * current rung (unlocked minus demoted), how many more admitted calls the
   * next locked rung needs, its demotion count, whether the probe cooldown
   * is active, and the grants the ladder currently contributes. Returns
   * null when the warrant is unbound (no progression in force).
   */
  view(
    warrantId: string,
    now: number,
  ): {
    policy_id: string;
    current_rung: number;
    next_step: { checks_remaining: number } | null;
    demoted_rungs: number;
    cooldown_active: boolean;
    unlocked_grants: readonly ToolGrant[];
  } | null {
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) return null;
    const policy = this.policies.get(binding.policy_id);
    if (policy === undefined) return null;
    const { currentRung, nextStep } = computeProgress(binding, policy);
    return {
      policy_id: binding.policy_id,
      current_rung: currentRung,
      next_step:
        nextStep === undefined
          ? null
          : {
              checks_remaining: Math.max(
                0,
                nextStep.unlock_after.min_sample - binding.admitted_count,
              ),
            },
      demoted_rungs: binding.demoted_rungs,
      cooldown_active: binding.cooldown_until_ms > now,
      unlocked_grants: policy.steps.slice(0, currentRung).flatMap((step) => [...step.grants]),
    };
  }

  /**
   * The grant list authorization should evaluate against: the warrant's own
   * grants plus whatever its bound policy's ladder currently contributes.
   * An active cooldown suppresses the ladder entirely (base grants only);
   * an unbound warrant yields exactly its own grants.
   */
  effectiveGrantsFor(warrant: Warrant, warrantId: string, now: number): readonly ToolGrant[] {
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) return [...warrant.grants];
    if (binding.cooldown_until_ms > now) return [...warrant.grants];
    const policy = this.policies.get(binding.policy_id);
    if (policy === undefined) return [...warrant.grants];
    const { currentRung } = computeProgress(binding, policy);
    return [
      ...warrant.grants,
      ...policy.steps.slice(0, currentRung).flatMap((step) => [...step.grants]),
    ];
  }

  /** Test isolation hook: drops every policy and binding. Never call outside unit tests. */
  resetForTests(): void {
    this.policies.clear();
    this.bindings.clear();
  }
}
