/**
 * Trust progression ledger (WI_WARRANTS_SPEC, Patches F+G): earned-autonomy
 * ladders kept OUT of the credential. Authorization stays in the warrant
 * (what a holder may do, decided by WarrantRegistry.check); trust lives here
 * as a separately owned binding between a warrant and a registered
 * ProgressionPolicy (what a holder may GROW into). Admitted calls feed the
 * policy's evidence gates and unlock its steps as extra grants; probe-shaped
 * denials demote a rung and start an escalating cooldown whose length doubles
 * with each accumulated demotion (Patch H2). Demotions also TAINT the acting
 * subject, and applyInheritedTaint lifts a warrant's binding to its subject's
 * taint floor, so discipline earned under one lease follows the agent into
 * the next (Patch H1) — enforced at bind time too, not only at issuance
 * (Patch I1). Unbinding drops progression entirely and the warrant reverts
 * to exactly its issued grants; a binding carrying demotions or a running
 * cooldown leaves a capped tombstone behind so an unbind→rebind cycle cannot
 * launder the record (Patch I3).
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
/**
 * Base lockout for one probe-shaped demotion; the effective cooldown grows
 * exponentially with the warrant's total demotions (Patch H2, see record):
 * 1st demotion 60s, 2nd 120s, 3rd 240s, and so on.
 */
const COOLDOWN_MS = 60_000;
export { MIN_EVIDENCE_SAMPLE, PROBE_DEMOTION_THRESHOLD, COOLDOWN_MS };

/** A policy's ladder may never run deeper than this many steps. */
const MAX_POLICY_DEPTH = 4;
/**
 * Patch I3: at most this many tombstones of unbound-but-recently-demoted
 * bindings are remembered; inserting beyond the cap evicts the oldest.
 */
export const MAX_TOMBSTONES = 5000;
/**
 * Patch I5a: at most this many per-subject taint floors are remembered;
 * inserting a NEW subject beyond the cap evicts the oldest.
 */
export const MAX_TAINT_ENTRIES = 10000;

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

/** Durable runtime trust state for one bound warrant (never part of the credential). */
export interface TrustBindingSnapshot {
  policy_id: string;
  admitted_count: number;
  denied_count: number;
  demoted_rungs: number;
  cooldown_until_ms: number;
}

/**
 * Patch K1 trust journal vocabulary. Snapshot-shaped events carry the full
 * state of one logical entry after the mutation, so replay is a plain
 * overwrite with no ordering subtleties inside an entry kind.
 */
export type TrustJournalEvent =
  | { k: "policy"; policy: ProgressionPolicy }
  | { k: "bind"; warrant_id: string; binding: TrustBindingSnapshot }
  | { k: "unbind"; warrant_id: string }
  | { k: "record"; warrant_id: string; binding: TrustBindingSnapshot }
  | { k: "tombstone"; warrant_id: string; demoted_rungs: number; cooldown_until_ms: number }
  | { k: "taint"; subject: string; demoted_rungs: number };

/**
 * Denial reason codes counted as probing: repeated, they signal boundary
 * testing BY the holder against the ladder's own edges. bearer_mismatch is
 * deliberately EXCLUDED (Patch I2): failing a bearer proof is an attack
 * AGAINST the holder — it needs nothing but a leaked warrant id — not
 * evidence that the holder probed their own boundary, so it must neither
 * demote the holder's ladder nor taint their subject. Such failures remain
 * logged/denied upstream; they simply never feed this ledger.
 */
const PROBE_REASON_CODES: ReadonlySet<string> = new Set([
  "tool_not_covered",
  "arg_out_of_scope",
]);

/**
 * Pure progression math: how many rungs the evidence currently unlocks
 * (before demotion) plus the first locked rung, if any. Zero IO.
 */
function computeProgress(
  binding: TrustBindingSnapshot,
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
  /**
   * Patch K1: optional persistence sink, same contract as the registry's.
   * Trust mutations that must survive a restart (policy registration,
   * binding changes, evidence counters, demotions, taint, tombstones) are
   * emitted as generic snapshot events; replay restores them verbatim.
   */
  onMutate?: (event: TrustJournalEvent) => void;

  private readonly policies = new Map<string, ProgressionPolicy>();
  private readonly bindings = new Map<string, TrustBindingSnapshot>();

  /**
   * Patch H1: demotion floors learned per acting subject, fed by
   * `record(..., subject)` and enforced onto bindings by
   * `applyInheritedTaint` — repeat offenders cannot launder their record
   * simply by obtaining a fresh warrant. Keys are LOWERCASED subjects
   * (Patch I1: 'Agent-7' and 'agent-7' are one offender) and the map is
   * capped at MAX_TAINT_ENTRIES with oldest-first eviction (Patch I5a).
   */
  private readonly subjectTaint = new Map<string, number>();

  /**
   * Patch I3: discipline remembered across an unbind. Detaching a binding
   * that carries demotions (or a cooldown deadline) writes a tombstone so an
   * immediate unbind→rebind cycle cannot launder the record; the next
   * successful bind restores both fields and consumes the tombstone. Capped
   * at MAX_TOMBSTONES, oldest inserted evicted first.
   */
  private readonly tombstones = new Map<
    string,
    { demoted_rungs: number; cooldown_until_ms: number }
  >();

  /**
   * `warrantExists` is an optional pure probe (typically wired to the
   * WarrantRegistry by the tools layer) that lets `bind` reject unknown
   * warrant identifiers; without it, bind verifies policies only.
   */
  constructor(private readonly warrantExists?: (warrantId: string) => boolean) {}

  /** Emit a trust journal event when persistence is wired. */
  private emit(event: TrustJournalEvent): void {
    this.onMutate?.(event);
  }

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
    this.emit({ k: "policy", policy });
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
   *
   * Patch I3: unbinding does not fully forget. A binding demoted below its
   * top rung — or detached mid-cooldown — leaves a tombstone keyed by
   * warrant id; the next successful bind for that warrant restores
   * demoted_rungs = max(inherited-from-subject, tombstone.demoted_rungs)
   * and keeps the tombstone's cooldown_until_ms (so a mid-cooldown
   * rebind stays locked), then consumes the tombstone.
   *
   * Patch I1 — bind-time subject taint: when the caller supplies
   * `subject`, a successful bind immediately lifts the fresh binding to
   * that subject's inherited demotion floor via applyInheritedTaint, so
   * discipline earned under earlier warrants is in force from the very
   * first call instead of only after issuance-time application.
   */
  bind(
    warrantId: string,
    policyId: string,
    now: number = Number.POSITIVE_INFINITY,
    warrant?: Warrant,
    subject?: string,
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
      // but demotions carry over — they are discipline, not evidence. A
      // tombstone from an intervening unbind (Patch I3) restores the
      // stronger of its remembered demotions and whatever taint the
      // subject brings, and keeps a running cooldown alive across the gap;
      // it is consumed once applied.
      const tombstone = this.tombstones.get(warrantId);
      this.tombstones.delete(warrantId);
      const inheritedTaint =
        subject === undefined ? 0 : this.subjectTaint.get(subject.toLowerCase()) ?? 0;
      this.bindings.set(warrantId, {
        policy_id: policyId,
        admitted_count: 0,
        denied_count: 0,
        demoted_rungs: Math.max(
          existing?.demoted_rungs ?? 0,
          tombstone?.demoted_rungs ?? 0,
          inheritedTaint,
        ),
        cooldown_until_ms:
          existing?.cooldown_until_ms ?? tombstone?.cooldown_until_ms ?? 0,
      });
    } else {
      this.tombstones.delete(warrantId);
    }
    // Patch I1: apply inherited taint at bind time so floors land
    // immediately, not just at issuance (applyInheritedTaint is max-only,
    // so legitimate progress is never rolled back).
    if (subject !== undefined) {
      this.applyInheritedTaint(warrantId, subject.toLowerCase());
    }
    this.emit({ k: "bind", warrant_id: warrantId, binding: { ...this.bindings.get(warrantId)! } });
  }

  /**
   * Detach a warrant from its policy: it reverts to exactly its issued
   * grants and stops accumulating evidence. Deliberately ALLOWED even while
   * the warrant is cooling down from a probe demotion — unbinding is the
   * Patch G3 escape valve (progression drops entirely, authority reverts to
   * base), whereas rebinding stays blocked. Unbound or unknown ids throw.
   *
   * Patch I3: a binding that carries demotions — or an unexpired cooldown —
   * first leaves a capped tombstone so an immediate unbind→rebind cycle
   * cannot launder the discipline; spotless bindings forget nothing worth
   * remembering and write no tombstone.
   */
  unbind(warrantId: string): void {
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) {
      throw new Error(
        `Cannot unbind trust: warrant '${warrantId}' is not bound to any progression policy.`,
      );
    }
    if (
      binding.demoted_rungs > 0 ||
      binding.cooldown_until_ms > Number.POSITIVE_INFINITY
    ) {
      this.tombstones.set(warrantId, {
        demoted_rungs: binding.demoted_rungs,
        cooldown_until_ms: binding.cooldown_until_ms,
      });
      // Patch I3: bounded memory — drop the oldest-inserted tombstone first.
      while (this.tombstones.size > MAX_TOMBSTONES) {
        const oldest = this.tombstones.keys().next();
        if (oldest.done === true) break;
        this.tombstones.delete(oldest.value);
      }
      this.emit({
        k: "tombstone",
        warrant_id: warrantId,
        demoted_rungs: binding.demoted_rungs,
        cooldown_until_ms: binding.cooldown_until_ms,
      });
    }
    this.bindings.delete(warrantId);
    this.emit({ k: "unbind", warrant_id: warrantId });
  }

  /**
   * Feed one call outcome into a bound warrant's evidence. Allowed calls
   * count toward unlocking the next rung; probe-shaped denials
   * (tool_not_covered, arg_out_of_scope, bearer_mismatch) count against it
   * and, at PROBE_DEMOTION_THRESHOLD, demote one rung (capped at the
   * policy's depth), reset the denial streak, and start a cooldown. Budget
   * and lifecycle denials never touch trust. Unknown or unbound warrant ids
   * are silently ignored — no binding, no progression.
   *
   * Patch H2 — escalating cooldown: the lockout is no longer a flat
   * COOLDOWN_MS but grows exponentially with the demotion total AFTER the
   * increment,
   *
   *     cooldownMs = COOLDOWN_MS * 2 ** (demoted_rungs_total_after_increment - 1)
   *
   * i.e. the first demotion costs 60s, the second 120s, the third 240s, and
   * so on: a single mistake stays cheap while sustained boundary probing
   * becomes progressively more expensive. (Keying on the post-increment
   * total minus one makes the FIRST demotion the base 60s.)
   *
   * Patch H1 — subject taint: when the caller supplies `subject` and a
   * demotion fires, the subject inherits the new demotion total as a floor
   * (`Math.max` over any taint already stored), queryable via viewTaint and
   * enforceable onto other warrants via applyInheritedTaint.
   */
  record(
    warrantId: string,
    outcome: { allowed: true } | { allowed: false; reason_code: string },
    now: number,
    subject?: string,
  ): void {
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) return;
    if (outcome.allowed) {
      binding.admitted_count += 1;
      this.emit({ k: "record", warrant_id: warrantId, binding: { ...binding } });
      return;
    }
    if (!PROBE_REASON_CODES.has(outcome.reason_code)) return;
    binding.denied_count += 1;
    if (binding.denied_count < PROBE_DEMOTION_THRESHOLD) {
      this.emit({ k: "record", warrant_id: warrantId, binding: { ...binding } });
      return;
    }
    const depth = this.policies.get(binding.policy_id)?.steps.length ?? 0;
    binding.demoted_rungs = Math.min(binding.demoted_rungs + 1, depth);
    binding.denied_count = 0;
    // Patch H2: escalate on the post-increment demotion total — every
    // further demotion doubles the previous lockout (60s -> 120s -> 240s…).
    binding.cooldown_until_ms =
      now + COOLDOWN_MS * 2 ** Math.max(0, binding.demoted_rungs - 1);
    // Patch H1: a demotion taints the acting subject, not just this binding.
    // Keys are lowercased so 'Agent-7' and 'agent-7' share one floor
    // (Patch I1), and the map stays capped with oldest-first eviction
    // (Patch I5a); refreshing an existing key keeps it youngest.
    if (subject !== undefined) {
      const key = String(subject).toLowerCase();
      if (!this.subjectTaint.has(key)) {
        this.subjectTaint.set(key, 0);
        while (this.subjectTaint.size > MAX_TAINT_ENTRIES) {
          const oldest = this.subjectTaint.keys().next();
          if (oldest.done === true) break;
          this.subjectTaint.delete(oldest.value);
        }
      }
      this.subjectTaint.set(
        key,
        Math.max(this.subjectTaint.get(key) ?? 0, binding.demoted_rungs),
      );
      this.emit({ k: "taint", subject: key, demoted_rungs: this.subjectTaint.get(key)! });
    }
    // The demotion itself changed counters + cooldown; journal the binding.
    this.emit({ k: "record", warrant_id: warrantId, binding: { ...binding } });
  }

  /**
   * Patch H1: the demotion floor a subject has earned across every warrant
   * they have held (0 when untainted). Read-only audit surface. Subject is
   * folded to lowercase before lookup (Patch I1).
   */
  viewTaint(subject: string): number {
    return this.subjectTaint.get(String(subject).toLowerCase()) ?? 0;
  }

  /**
   * Patch H1: lift an existing binding up to its subject's taint floor — a
   * demotion earned under one warrant follows the subject into the next.
   * Max-only (never a reduction), and a silent no-op for unknown subjects
   * or unbound warrants, so legitimate progress is never rolled back.
   * Subject is folded to lowercase before lookup (Patch I1).
   */
  applyInheritedTaint(warrantId: string, subject: string): void {
    const taint = this.subjectTaint.get(String(subject).toLowerCase());
    if (taint === undefined) return;
    const binding = this.bindings.get(warrantId);
    if (binding === undefined) return;
    const demotedRungs = Math.max(binding.demoted_rungs, taint);
    if (demotedRungs === binding.demoted_rungs) return;
    binding.demoted_rungs = demotedRungs;
    this.emit({ k: "record", warrant_id: warrantId, binding: { ...binding } });
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

  /** Test isolation hook: drops every policy, binding, subject taint, and tombstone. Never call outside unit tests. */
  resetForTests(): void {
    this.policies.clear();
    this.bindings.clear();
    this.subjectTaint.clear();
    this.tombstones.clear();
  }

  // ---------------------------------------------------------------------
  // Patch K1 restore paths: used ONLY by journal replay. They write state
  // directly without emitting, so replayed history is not re-journaled.
  // ---------------------------------------------------------------------

  /** Re-register a policy from a journaled snapshot (idempotent overwrite). */
  restorePolicy(policy: ProgressionPolicy): void {
    this.policies.set(policy.policy_id, {
      ...policy,
      steps: policy.steps.map((step) => ({
        unlock_after: { ...step.unlock_after },
        grants: step.grants.map((grant) => ({ ...grant })),
      })),
    });
  }

  /** Restore one binding from a journaled snapshot. */
  restoreBinding(warrantId: string, binding: TrustBindingSnapshot): void {
    this.bindings.set(warrantId, { ...binding });
  }

  /** Restore an unbind exactly; needed when replay follows a prior bind. */
  restoreUnbind(warrantId: string): void {
    this.bindings.delete(warrantId);
  }

  /** Restore one tombstone from a journaled snapshot. */
  restoreTombstone(warrantId: string, demotedRungs: number, cooldownUntilMs: number): void {
    this.tombstones.set(warrantId, { demoted_rungs: demotedRungs, cooldown_until_ms: cooldownUntilMs });
  }

  /** Restore one subject-taint floor from a journaled snapshot. */
  restoreTaint(subject: string, demotedRungs: number): void {
    this.subjectTaint.set(String(subject).toLowerCase(), demotedRungs);
  }

  /** Full state snapshot for a periodic journal checkpoint. */
  snapshotForJournal(): {
    policies: ProgressionPolicy[];
    bindings: Array<{ warrant_id: string; binding: TrustBindingSnapshot }>;
    tombstones: Array<{ warrant_id: string; demoted_rungs: number; cooldown_until_ms: number }>;
    taints: Array<{ subject: string; demoted_rungs: number }>;
  } {
    return {
      policies: Array.from(this.policies.values(), (policy) => ({
        ...policy,
        steps: policy.steps.map((step) => ({
          unlock_after: { ...step.unlock_after },
          grants: step.grants.map((grant) => ({ ...grant })),
        })),
      })),
      bindings: Array.from(this.bindings, ([warrant_id, binding]) => ({ warrant_id, binding: { ...binding } })),
      tombstones: Array.from(this.tombstones, ([warrant_id, tombstone]) => ({ warrant_id, ...tombstone })),
      taints: Array.from(this.subjectTaint, ([subject, demoted_rungs]) => ({ subject, demoted_rungs })),
    };
  }

  /** Replace state from a checkpoint without emitting replay events. */
  restoreSnapshot(snapshot: ReturnType<TrustLedger["snapshotForJournal"]>): void {
    this.resetForTests();
    for (const policy of snapshot.policies) this.restorePolicy(policy);
    for (const entry of snapshot.bindings) this.restoreBinding(entry.warrant_id, entry.binding);
    for (const entry of snapshot.tombstones) {
      this.restoreTombstone(entry.warrant_id, entry.demoted_rungs, entry.cooldown_until_ms);
    }
    for (const entry of snapshot.taints) this.restoreTaint(entry.subject, entry.demoted_rungs);
  }
}
