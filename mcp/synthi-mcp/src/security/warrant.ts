/**
 * Agent capability warrants (WI_WARRANTS_SPEC, Patch A): attenuating
 * capability leases over MCP tools. A warrant is an explicit, expiring,
 * invocation-capped lease covering specific tools with argument-level glob
 * constraints. A holder may attenuate its warrant — issue a strictly
 * narrower sub-warrant to another agent (delegation chain); authority only
 * shrinks as it flows down. Revocation cascades through the whole subtree.
 *
 * Pure module: zero IO, no clock reads — time enters as `now`. Decisions
 * fail closed and carry `reason_code` + `human_reason` in plain language.
 * Sealed warrants additionally demand proof of possession: every call must
 * present the bearer secret; only its sha256 hash is ever stored here.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  cloneWarrantPrincipal,
  normalizeWarrantPrincipal,
  sameWarrantPrincipal,
  type WarrantPrincipal,
} from "./warrant_principal.js";

export type { WarrantPrincipal } from "./warrant_principal.js";

/** Delegation chains may never run deeper than this many warrants. */
const MAX_CHAIN_DEPTH = 8;

export interface ToolGrant {
  tool: string;
  /** glob patterns ( "*" and "**" only ) matched against top-level string values of the call args */
  arg_constraints?: Readonly<Record<string, string>>;
  /** hard ceiling on invocations charged to this grant */
  max_invocations?: number;
}

/**
 * An opt-in, generic policy that lets a sealed warrant holder attenuate its
 * own authority. It deliberately names no agent framework or principal type:
 * a deployment decides who receives the child warrant through `subject`.
 *
 * `max_depth` counts child hops below the warrant that carries this policy.
 * The policy is copied unchanged to every child, so no descendant can widen
 * its delegation envelope.
 */
export interface DelegationPolicy {
  max_depth: number;
  /** Optional upper bound for each child lease, measured from attenuation. */
  max_child_ttl_ms?: number;
  /** Optional requirement that every child grant declares a bounded budget. */
  max_child_invocations?: number;
  /** Require every delegated child to name a verified recipient audience. */
  require_recipient_identity?: boolean;
}

export interface Warrant {
  warrant_id: string;
  subject: string;
  /** Optional provider-neutral recipient claim, enforced against a trusted request principal. */
  audience?: WarrantPrincipal;
  grants: readonly ToolGrant[];
  issued_at_ms: number;
  expires_at_ms: number;
  /** undefined for roots; set for attenuated children */
  parent_warrant_id?: string;
  /** id of the tree root; equals warrant_id for roots */
  root_warrant_id: string;
  status: "active" | "revoked";
  /** True when calls must prove possession with the bearer secret; never the secret itself */
  sealed?: boolean;
  /** Explicit holder-delegation policy, set only at root issuance. */
  delegation?: DelegationPolicy;
  /** Child-hop count beneath the warrant that set `delegation`. */
  delegation_depth?: number;
}

export type WarrantDecision =
  | { allowed: true; warrant_id: string }
  | { allowed: false; reason_code: string; human_reason: string };

/**
 * What issue/attenuate return: the warrant plus, when sealed, the bearer
 * secret — disclosed once here; only its sha256 hash is kept by the registry.
 */
export type IssuedWarrant = Warrant & { bearer?: string };

interface WarrantRecord {
  readonly warrant: Warrant;
  /** tool -> invocations left; only present for tools whose grant sets max_invocations */
  readonly remaining: Map<string, number>;
  /** sha256 hex of the bearer secret for sealed warrants; the secret itself is never stored */
  readonly bearer_hash?: string;
}

/** Durable, secret-free snapshot of a registry record. */
export interface WarrantRecordSnapshot {
  warrant: Warrant;
  remaining: Record<string, number>;
  bearer_hash?: string;
}

/**
 * Patch K1 journal vocabulary. Events describe state CHANGES only (never
 * bearer secrets — sealed warrants persist their sha256 hash); a fresh
 * process replays them in order to reconstruct the exact registry and
 * ledger contents. Discriminated on `k`.
 */
export type WarrantJournalEvent =
  | { k: "issue"; record: WarrantRecordSnapshot }
  | { k: "attenuate"; record: WarrantRecordSnapshot }
  | { k: "revoke"; warrant_id: string }
  | { k: "record"; warrant_id: string; remaining: Record<string, number> }
  | { k: "renew"; warrant_id: string; expires_at_ms: number; remaining: Record<string, number> };

/**
 * Tiny glob matcher supporting `*` (any characters except ".") and `**`
 * (any characters). Everything else is matched literally.
 */
export function globMatch(pattern: string, value: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      if (pattern.charAt(i + 1) === "*") {
        source += "[\\s\\S]*";
        i += 1;
      } else {
        source += "[^.]*";
      }
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`).test(value);
}

/**
 * Whether the child constraint pattern is equal to or provably stricter than
 * the parent's for the same arg key. Deliberately literal: equal strings are
 * accepted; any other pair is rejected UNLESS the parent constrains nothing
 * for that key (undefined), in which case any child pattern is narrower.
 * General glob-implication proving is out of scope on purpose.
 */
export function patternIsStricterOrEqual(
  child: string | undefined,
  parent: string | undefined,
): boolean {
  if (parent === undefined) return true; // parent unrestricted here: child can only narrow
  if (child === undefined) return false; // dropping a constraint would widen
  return child === parent;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesMatch(presented: string | undefined, expectedHash: string): boolean {
  if (presented === undefined || presented.length === 0) return false;
  const left = Buffer.from(sha256Hex(presented));
  const right = Buffer.from(expectedHash);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function deny(reasonCode: string, humanReason: string): WarrantDecision {
  return { allowed: false, reason_code: reasonCode, human_reason: humanReason };
}

function validateSubjectAndGrants(subject: string, grants: readonly ToolGrant[]): void {
  if (typeof subject !== "string" || subject.trim().length === 0) {
    throw new Error("A warrant needs a non-empty subject.");
  }
  if (!Array.isArray(grants)) {
    throw new Error("A warrant needs an array of grants.");
  }
  for (const grant of grants) {
    if (typeof grant?.tool !== "string" || grant.tool.trim().length === 0) {
      throw new Error("Every warrant grant needs a non-empty 'tool' name.");
    }
  }
}

function validateTtl(ttlMs: number): void {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("A warrant needs a positive ttl_ms.");
  }
}

function cloneGrants(grants: readonly ToolGrant[]): ToolGrant[] {
  return grants.map((grant) => ({
    ...grant,
    ...(grant.arg_constraints === undefined ? {} : { arg_constraints: { ...grant.arg_constraints } }),
  }));
}

function cloneDelegation(policy: DelegationPolicy | undefined): DelegationPolicy | undefined {
  return policy === undefined ? undefined : { ...policy };
}

function cloneWarrant(warrant: Warrant): Warrant {
  return {
    ...warrant,
    grants: cloneGrants(warrant.grants),
    ...(warrant.audience === undefined ? {} : { audience: cloneWarrantPrincipal(warrant.audience) }),
    ...(warrant.delegation === undefined ? {} : { delegation: cloneDelegation(warrant.delegation) }),
  };
}

function validateDelegationPolicy(
  policy: DelegationPolicy | undefined,
  sealed: boolean | undefined,
): DelegationPolicy | undefined {
  if (policy === undefined) return undefined;
  if (sealed !== true) {
    throw new Error("A delegation policy requires seal:true so its holder can prove possession.");
  }
  if (!Number.isSafeInteger(policy.max_depth) || policy.max_depth < 1 || policy.max_depth >= MAX_CHAIN_DEPTH) {
    throw new Error(`Delegation max_depth must be an integer from 1 through ${MAX_CHAIN_DEPTH - 1}.`);
  }
  if (policy.max_child_ttl_ms !== undefined) validateTtl(policy.max_child_ttl_ms);
  if (
    policy.max_child_invocations !== undefined
    && (!Number.isSafeInteger(policy.max_child_invocations) || policy.max_child_invocations < 1)
  ) {
    throw new Error("Delegation max_child_invocations must be a positive integer.");
  }
  if (
    policy.require_recipient_identity !== undefined
    && typeof policy.require_recipient_identity !== "boolean"
  ) {
    throw new Error("Delegation require_recipient_identity must be true or false.");
  }
  return cloneDelegation(policy);
}

function initialRemaining(grants: readonly ToolGrant[]): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const grant of grants) {
    if (grant.max_invocations === undefined) continue;
    const previous = remaining.get(grant.tool);
    remaining.set(
      grant.tool,
      previous === undefined ? grant.max_invocations : Math.min(previous, grant.max_invocations),
    );
  }
  return remaining;
}

/** True when the grant's arg constraints admit the given call args. Missing optional args pass. */
export function grantAcceptsArgs(
  grant: ToolGrant,
  args: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const constraints = grant.arg_constraints;
  if (constraints === undefined) return true;
  for (const key of Object.keys(constraints)) {
    if (args === undefined) continue; // missing optional args pass
    const value = args[key];
    if (value === undefined) continue; // missing optional args pass
    if (typeof value !== "string") return false; // fail closed on non-string values
    if (!globMatch(constraints[key]!, value)) return false;
  }
  return true;
}

/** First arg key that violates its constraint across the covering grants (for the denial message). */
export function firstViolatedArgKey(
  grants: readonly ToolGrant[],
  args: Readonly<Record<string, unknown>> | undefined,
): string {
  for (const grant of grants) {
    const constraints = grant.arg_constraints;
    if (constraints === undefined) continue;
    for (const key of Object.keys(constraints)) {
      if (args === undefined) continue;
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !globMatch(constraints[key]!, value)) return key;
    }
  }
  return "";
}

export class WarrantRegistry {
  /**
   * Patch K1: optional persistence sink. When set (by the tools layer's
   * journal wiring), every successful mutation appends one event describing
   * the change so a fresh process can replay the exact state. Restore paths
   * never emit — replayed history must not be re-journaled.
   */
  onMutate?: (event: WarrantJournalEvent) => void;

  private readonly records = new Map<string, WarrantRecord>();
  /** Outstanding reservations are process-local; a restart safely keeps their debit. */
  private readonly reservations = new Map<string, number>();

  /** Emit a journal event when persistence is wired. */
  private emit(event: WarrantJournalEvent): void {
    this.onMutate?.(event);
  }

  /**
   * Issue a fresh root warrant (no parent). Throws on bad input. With `seal`,
   * mints a bearer secret (disclosed once on the result) that every call must
   * present; only its sha256 hash is stored.
   */
  issue(input: {
    subject: string;
    audience?: WarrantPrincipal;
    grants: readonly ToolGrant[];
    now: number;
    ttl_ms: number;
    seal?: boolean;
    delegation?: DelegationPolicy;
  }): IssuedWarrant {
    validateSubjectAndGrants(input.subject, input.grants);
    validateTtl(input.ttl_ms);
    const delegation = validateDelegationPolicy(input.delegation, input.seal);
    const audience = input.audience === undefined ? undefined : normalizeWarrantPrincipal(input.audience);

    const warrantId = `wr_${randomUUID()}`;
    const bearer = input.seal === true ? `wb_${randomUUID().replaceAll("-", "")}` : undefined;
    const warrant: Warrant = {
      warrant_id: warrantId,
      subject: input.subject,
      ...(audience === undefined ? {} : { audience }),
      grants: cloneGrants(input.grants),
      issued_at_ms: input.now,
      expires_at_ms: input.now + input.ttl_ms,
      root_warrant_id: warrantId,
      status: "active",
      ...(bearer === undefined ? {} : { sealed: true }),
      ...(delegation === undefined ? {} : { delegation, delegation_depth: 0 }),
    };
    this.records.set(warrantId, {
      warrant,
      remaining: initialRemaining(warrant.grants),
      ...(bearer === undefined ? {} : { bearer_hash: sha256Hex(bearer) }),
    });
    this.emit({ k: "issue", record: this.snapshotRecord(warrantId)! });
    return { ...cloneWarrant(warrant), ...(bearer === undefined ? {} : { bearer }) };
  }

  /**
   * Authorize a sealed holder to create one narrower child. This checks the
   * lifecycle and bearer before policy limits, and never consumes a tool
   * budget. It is intentionally generic: no runtime or agent type appears in
   * the capability itself.
   */
  canDelegate(input: { warrant_id: string; bearer?: string; principal?: WarrantPrincipal; now: number }): WarrantDecision {
    const record = this.records.get(input.warrant_id);
    if (record === undefined) return deny("no_such_warrant", "No warrant exists with this identifier.");
    if (record.warrant.delegation === undefined) {
      return deny("delegation_not_permitted", "This warrant was not issued with holder-delegation permission.");
    }
    if (record.bearer_hash === undefined) {
      return deny("delegation_not_permitted", "Only sealed warrants may delegate by holder possession.");
    }
    const lifecycle = this.check({
      warrant_id: input.warrant_id,
      tool: "__warrant_delegation_probe__",
      bearer: input.bearer,
      principal: input.principal,
      now: input.now,
    });
    if (!lifecycle.allowed && lifecycle.reason_code !== "tool_not_covered") return lifecycle;
    const usedDepth = record.warrant.delegation_depth ?? 0;
    if (usedDepth >= record.warrant.delegation.max_depth) {
      return deny("delegation_depth_exhausted", "This warrant reached its holder-delegation depth limit.");
    }
    return { allowed: true, warrant_id: input.warrant_id };
  }

  /**
   * Attenuate a warrant: issue a strictly narrower child under an active,
   * unexpired parent. Child tools must exist in the parent (exact name),
   * arg constraints must be subset-per-key (equal or stricter), invocation
   * ceilings must fit the parent's remaining budget, expiry is clamped to
   * the parent's, and chain depth may not exceed MAX_CHAIN_DEPTH.
   * A child under a sealed parent is ALWAYS sealed with a fresh bearer
   * (possession narrows with authority, never inherited); `seal` seals it
   * otherwise.
   */
  attenuate(input: {
    parent_warrant_id: string;
    subject: string;
    audience?: WarrantPrincipal;
    grants: readonly ToolGrant[];
    now: number;
    ttl_ms?: number;
    seal?: boolean;
    /** Present only for holder-driven delegation; administrators use the existing management path. */
    bearer?: string;
    /** Authenticated request principal for holder-driven delegation. */
    principal?: WarrantPrincipal;
  }): IssuedWarrant {
    const parent = this.records.get(input.parent_warrant_id);
    if (parent === undefined) {
      throw new Error(`Cannot attenuate: no warrant exists with identifier '${input.parent_warrant_id}'.`);
    }
    if (parent.warrant.status !== "active") {
      throw new Error(`Cannot attenuate: warrant '${input.parent_warrant_id}' has been revoked.`);
    }
    if (input.now >= parent.warrant.expires_at_ms) {
      throw new Error(`Cannot attenuate: warrant '${input.parent_warrant_id}' has expired.`);
    }
    if (input.bearer !== undefined) {
      const holder = this.canDelegate({
        warrant_id: input.parent_warrant_id,
        bearer: input.bearer,
        principal: input.principal,
        now: input.now,
      });
      if (!holder.allowed) throw new Error(`Cannot attenuate: ${holder.human_reason}`);
    }

    validateSubjectAndGrants(input.subject, input.grants);
    if (input.ttl_ms !== undefined) validateTtl(input.ttl_ms);

    if (this.depthOf(input.parent_warrant_id) + 1 > MAX_CHAIN_DEPTH) {
      throw new Error(
        `Cannot attenuate: delegation chain would exceed the maximum depth of ${MAX_CHAIN_DEPTH}.`,
      );
    }

    const delegation = parent.warrant.delegation;
    if (delegation?.require_recipient_identity === true && input.audience === undefined) {
      throw new Error(
        "Cannot attenuate: this delegation policy requires a verified recipient audience for every child.",
      );
    }
    const audience = input.audience === undefined
      ? (parent.warrant.audience === undefined ? undefined : cloneWarrantPrincipal(parent.warrant.audience))
      : normalizeWarrantPrincipal(input.audience);
    const nextDelegationDepth = (parent.warrant.delegation_depth ?? 0) + 1;
    if (delegation !== undefined && nextDelegationDepth > delegation.max_depth) {
      throw new Error("Cannot attenuate: this warrant reached its delegation policy depth limit.");
    }

    for (const grant of input.grants) {
      const parentGrant = parent.warrant.grants.find((candidate) => candidate.tool === grant.tool);
      if (parentGrant === undefined) {
        throw new Error(
          `Cannot attenuate: tool '${grant.tool}' is not covered by parent warrant '${input.parent_warrant_id}'.`,
        );
      }

      const childConstraints = grant.arg_constraints;
      if (childConstraints !== undefined) {
        for (const key of Object.keys(childConstraints)) {
          const childPattern = childConstraints[key]!;
          const parentPattern =
            parentGrant.arg_constraints === undefined
              ? undefined
              : parentGrant.arg_constraints[key];
          if (!patternIsStricterOrEqual(childPattern, parentPattern)) {
            throw new Error(
              `Cannot attenuate: constraint '${key}' on tool '${grant.tool}' (${JSON.stringify(childPattern)}) is not equal to or stricter than the parent's (${
                parentPattern === undefined ? "unrestricted" : JSON.stringify(parentPattern)
              }).`,
            );
          }
        }
      }

      if (grant.max_invocations !== undefined) {
        const parentRemaining = parent.remaining.get(grant.tool);
        if (parentRemaining !== undefined && grant.max_invocations > parentRemaining) {
          throw new Error(
            `Cannot attenuate: ${grant.max_invocations} invocations requested for tool '${grant.tool}' exceeds the parent warrant's remaining ${parentRemaining}.`,
          );
        }
      }
      if (delegation?.max_child_invocations !== undefined) {
        if (grant.max_invocations === undefined || grant.max_invocations > delegation.max_child_invocations) {
          throw new Error(
            `Cannot attenuate: delegation policy requires '${grant.tool}' to declare at most ${delegation.max_child_invocations} invocations.`,
          );
        }
      }
    }

    const requestedTtl = input.ttl_ms === undefined ? parent.warrant.expires_at_ms - input.now : input.ttl_ms;
    const ttl = delegation?.max_child_ttl_ms === undefined
      ? requestedTtl
      : Math.min(requestedTtl, delegation.max_child_ttl_ms);
    const sealed = parent.bearer_hash !== undefined || input.seal === true;
    const bearer = sealed ? `wb_${randomUUID().replaceAll("-", "")}` : undefined;
    const warrant: Warrant = {
      warrant_id: `wr_${randomUUID()}`,
      subject: input.subject,
      ...(audience === undefined ? {} : { audience }),
      grants: cloneGrants(input.grants),
      issued_at_ms: input.now,
      expires_at_ms: Math.min(parent.warrant.expires_at_ms, input.now + ttl),
      parent_warrant_id: input.parent_warrant_id,
      root_warrant_id: parent.warrant.root_warrant_id,
      status: "active",
      ...(bearer === undefined ? {} : { sealed: true }),
      ...(delegation === undefined ? {} : { delegation: cloneDelegation(delegation), delegation_depth: nextDelegationDepth }),
    };
    this.records.set(warrant.warrant_id, {
      warrant,
      remaining: initialRemaining(warrant.grants),
      ...(bearer === undefined ? {} : { bearer_hash: sha256Hex(bearer) }),
    });
    this.emit({ k: "attenuate", record: this.snapshotRecord(warrant.warrant_id)! });
    return { ...cloneWarrant(warrant), ...(bearer === undefined ? {} : { bearer }) };
  }

  /**
   * THE decision function. Fails closed with reason_code + human_reason.
   * Sealed warrants demand their bearer secret BEFORE any capability checks.
   */
  check(input: {
    warrant_id: string;
    tool: string;
    args?: Readonly<Record<string, unknown>>;
    bearer?: string;
    principal?: WarrantPrincipal;
    now: number;
  }): WarrantDecision {
    const record = this.records.get(input.warrant_id);
    if (record === undefined) {
      return deny("no_such_warrant", "No warrant exists with this identifier.");
    }
    if (record.warrant.status !== "active") {
      return deny("revoked", "This warrant has been revoked.");
    }
    if (input.now >= record.warrant.expires_at_ms) {
      return deny("expired", "This warrant has expired.");
    }
    if (
      record.warrant.audience !== undefined
      && (input.principal === undefined || !sameWarrantPrincipal(record.warrant.audience, input.principal))
    ) {
      return deny(
        input.principal === undefined ? "principal_required" : "principal_mismatch",
        input.principal === undefined
          ? "This warrant is bound to an authenticated principal, but this request has no trusted principal."
          : "This warrant is bound to a different authenticated principal.",
      );
    }
    if (record.bearer_hash !== undefined && !hashesMatch(input.bearer, record.bearer_hash)) {
      return deny(
        "bearer_mismatch",
        "This warrant is sealed; the call must prove possession with its bearer secret in _meta.warrant_bearer.",
      );
    }

    const covering = record.warrant.grants.filter((grant) => grant.tool === input.tool);
    if (covering.length === 0) {
      return deny("tool_not_covered", `This warrant does not cover the '${input.tool}' capability.`);
    }

    const argsAccepted = covering.some((grant) => grantAcceptsArgs(grant, input.args));
    if (!argsAccepted) {
      const key = firstViolatedArgKey(covering, input.args);
      return deny(
        "arg_out_of_scope",
        `This warrant restricts '${key}'; the requested value is outside it.`,
      );
    }

    // Budgets are chain-wide: ancestors' allowances are consumed by descendants' use.
    for (const node of this.chainUp(record.warrant.warrant_id)) {
      const remaining = node.remaining.get(input.tool);
      if (remaining !== undefined && remaining <= 0) {
        return deny(
          "invocations_exhausted",
          `This warrant used up its allowance for '${input.tool}'.`,
        );
      }
    }

    return { allowed: true, warrant_id: record.warrant.warrant_id };
  }

  /**
   * Charge one invocation of `tool` against the covering grant of this
   * warrant AND every ancestor grant covering the tool. Idempotent per call.
   */
  chargeInvocation(warrantId: string, tool: string): void {
    const record = this.records.get(warrantId);
    if (record === undefined) {
      throw new Error(`Cannot charge invocations: no warrant exists with identifier '${warrantId}'.`);
    }
    for (const node of this.chainUp(warrantId)) {
      const remaining = node.remaining.get(tool);
      if (remaining !== undefined) {
        node.remaining.set(tool, Math.max(0, remaining - 1));
      }
    }
    this.emit({ k: "record", warrant_id: warrantId, remaining: this.remainingSnapshot(warrantId) });
  }

  /**
   * Atomically reserve one invocation of `tool` across the whole ancestor
   * chain: either every budgeted node has headroom (all decrement) or none
   * mutates. Closes the check-then-charge double-spend window under
   * concurrent calls. Returns whether the reservation was granted.
   */
  tryReserve(warrantId: string, tool: string): { reserved: boolean } {
    const record = this.records.get(warrantId);
    if (record === undefined) {
      return { reserved: false };
    }
    const chain = this.chainUp(warrantId);
    for (const node of chain) {
      const remaining = node.remaining.get(tool);
      if (remaining !== undefined && remaining <= 0) {
        return { reserved: false };
      }
    }
    let charged = false;
    for (const node of chain) {
      const remaining = node.remaining.get(tool);
      if (remaining !== undefined) {
        node.remaining.set(tool, Math.max(0, remaining - 1));
        charged = true;
      }
    }
    if (charged) {
      const reservationKey = this.reservationKey(warrantId, tool);
      this.reservations.set(reservationKey, (this.reservations.get(reservationKey) ?? 0) + 1);
      this.emit({ k: "record", warrant_id: warrantId, remaining: this.remainingSnapshot(warrantId) });
    }
    return { reserved: true };
  }

  /**
   * Settle one reservation. Every completed dispatch clears its bookkeeping
   * token; a failed dispatch (`commit=false`) also restores each budgeted
   * node. Only meaningful after a successful budgeted tryReserve.
   */
  settleReserved(warrantId: string, tool: string, keepCharge = false): boolean {
    const record = this.records.get(warrantId);
    const reservationKey = this.reservationKey(warrantId, tool);
    const outstanding = this.reservations.get(reservationKey) ?? 0;
    if (record === undefined || outstanding <= 0) return false;
    if (outstanding === 1) this.reservations.delete(reservationKey);
    else this.reservations.set(reservationKey, outstanding - 1);
    if (keepCharge) return true;
    for (const node of this.chainUp(warrantId)) {
      const remaining = node.remaining.get(tool);
      if (remaining !== undefined) {
        node.remaining.set(tool, remaining + 1);
      }
    }
    this.emit({ k: "record", warrant_id: warrantId, remaining: this.remainingSnapshot(warrantId) });
    return true;
  }

  /** Direct O(1) snapshot lookup by id (cloned; safe to hand to callers). */
  get(warrantId: string): Warrant | undefined {
    const record = this.records.get(warrantId);
    return record === undefined ? undefined : cloneWarrant(record.warrant);
  }

  /** Revoke the warrant and every descendant. Returns how many were revoked. */
  revoke(warrantId: string): number {
    const root = this.records.get(warrantId);
    if (root === undefined) {
      throw new Error(`Cannot revoke: no warrant exists with identifier '${warrantId}'.`);
    }
    const queue: string[] = [warrantId];
    let revokedCount = 0;
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = this.records.get(currentId);
      if (current === undefined) continue;
      if (current.warrant.status !== "revoked") {
        current.warrant.status = "revoked";
        revokedCount += 1;
        this.emit({ k: "revoke", warrant_id: currentId });
      }
      for (const record of this.records.values()) {
        if (record.warrant.parent_warrant_id === currentId) {
          queue.push(record.warrant.warrant_id);
        }
      }
    }
    return revokedCount;
  }

  /** Full audit view (cloned snapshots, safe to hand around). */
  listWarrants(): readonly Warrant[] {
    return Array.from(this.records.values(), (record) => cloneWarrant(record.warrant));
  }

  /**
   * Marks nothing (expiry is evaluated at check time); returns the count of
   * currently expired warrants. Exists for metrics only.
   */
  sweepExpired(now: number): number {
    let expiredCount = 0;
    for (const record of this.records.values()) {
      if (now >= record.warrant.expires_at_ms) expiredCount += 1;
    }
    return expiredCount;
  }

  /** Test isolation hook: drops every record. Never call outside unit tests. */
  resetForTests(): void {
    this.records.clear();
    this.reservations.clear();
  }

  /**
   * Patch K2: renew an existing warrant. Sealed warrants require their bearer
   * (possession = authority to extend); revoked warrants can never be
   * renewed. The new expiry is clamped so the extension request cannot exceed
   * `max_ttl_ms` of total lifetime from issuance — the caller passes its org's
   * configured ceiling, keeping this core free of environment lookups.
   * Optional top-ups replenish a bounded tool budget, never beyond the lesser
   * of its issued ceiling and the organization-wide ceiling.
   * Progression state lives in the ledger and is untouched by design.
   */
  renewTo(input: {
    warrant_id: string;
    bearer?: string;
    principal?: WarrantPrincipal;
    ttl_ms: number;
    now: number;
    max_ttl_ms: number;
    add_invocations?: Record<string, number>;
    max_invocations_per_grant?: number;
  }): Warrant {
    const record = this.records.get(input.warrant_id);
    if (record === undefined) {
      throw new Error(`Cannot renew: no warrant exists with identifier '${input.warrant_id}'.`);
    }
    if (record.warrant.status !== "active") {
      throw new Error(`Cannot renew: warrant '${input.warrant_id}' has been revoked.`);
    }
    if (input.now >= record.warrant.expires_at_ms) {
      throw new Error(`Cannot renew: warrant '${input.warrant_id}' has expired. Issue a fresh warrant instead.`);
    }
    if (
      record.warrant.audience !== undefined
      && (input.principal === undefined || !sameWarrantPrincipal(record.warrant.audience, input.principal))
    ) {
      throw new Error("Cannot renew: this warrant is bound to a different authenticated principal.");
    }
    if (record.bearer_hash !== undefined && !hashesMatch(input.bearer, record.bearer_hash)) {
      throw new Error(
        "Cannot renew: this warrant is sealed; present its bearer secret in 'bearer' to prove possession.",
      );
    }
    validateTtl(input.ttl_ms);
    const ancestorExpiry = this.chainUp(input.warrant_id)
      .slice(1)
      .reduce((ceiling, node) => Math.min(ceiling, node.warrant.expires_at_ms), Number.POSITIVE_INFINITY);
    const ceilingExpiry = Math.min(record.warrant.issued_at_ms + input.max_ttl_ms, ancestorExpiry);
    const remainingHeadroom = Math.max(0, ceilingExpiry - record.warrant.expires_at_ms);
    const newExpiry = record.warrant.expires_at_ms + Math.min(input.ttl_ms, remainingHeadroom);
    if (newExpiry <= record.warrant.expires_at_ms) {
      throw new Error("Cannot renew: this warrant is already at its organization or parent expiry ceiling.");
    }
    record.warrant.expires_at_ms = newExpiry;
    for (const [tool, count] of Object.entries(input.add_invocations ?? {})) {
      const grant = record.warrant.grants.find((candidate) => candidate.tool === tool);
      if (grant === undefined || grant.max_invocations === undefined) {
        throw new Error(`Cannot renew: '${tool}' is not an invocation-capped grant on this warrant.`);
      }
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`Cannot renew: top-up for '${tool}' must be a positive integer.`);
      }
      const cap = Math.min(grant.max_invocations, input.max_invocations_per_grant ?? Number.MAX_SAFE_INTEGER);
      const current = record.remaining.get(tool) ?? 0;
      record.remaining.set(tool, Math.min(current + count, cap));
    }
    this.emit({
      k: "renew",
      warrant_id: input.warrant_id,
      expires_at_ms: record.warrant.expires_at_ms,
      remaining: this.remainingSnapshot(input.warrant_id),
    });
    return cloneWarrant(record.warrant);
  }

  /**
   * Patch K1 restore path: reconstruct one record exactly as journaled.
   * Used only by journal replay; never emits.
   */
  restoreRecord(input: WarrantRecordSnapshot): void {
    this.records.set(input.warrant.warrant_id, {
      warrant: cloneWarrant(input.warrant),
      remaining: new Map(Object.entries(input.remaining)),
      ...(input.bearer_hash === undefined ? {} : { bearer_hash: input.bearer_hash }),
    });
  }

  /** Patch K1 replay helper: mark one restored warrant revoked. */
  restoreRevoked(warrantId: string): void {
    const record = this.records.get(warrantId);
    if (record !== undefined && record.warrant.status !== "revoked") {
      record.warrant.status = "revoked";
    }
  }

  /** Patch K1 replay helper: replace a record's remaining budgets exactly. */
  restoreRemaining(warrantId: string, remaining: Record<string, number>): void {
    const record = this.records.get(warrantId);
    if (record === undefined) return;
    record.remaining.clear();
    for (const [tool, count] of Object.entries(remaining)) record.remaining.set(tool, count);
  }

  /** Patch K1 replay helper: restore a renewed deadline and its budget snapshot. */
  restoreRenewal(warrantId: string, expiresAtMs: number, remaining: Record<string, number>): void {
    const record = this.records.get(warrantId);
    if (record !== undefined) {
      (record.warrant as { expires_at_ms: number }).expires_at_ms = expiresAtMs;
      this.restoreRemaining(warrantId, remaining);
    }
  }

  /** Full state snapshot for a periodic journal checkpoint. */
  snapshotForJournal(): WarrantRecordSnapshot[] {
    return Array.from(this.records.keys(), (warrantId) => this.snapshotRecord(warrantId)!);
  }

  /** Records along the delegation chain from the given warrant up to its root. Cycle-safe. */
  private chainUp(warrantId: string): WarrantRecord[] {
    const chain: WarrantRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = warrantId;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const node = this.records.get(cursor);
      if (node === undefined) break;
      chain.push(node);
      cursor = node.warrant.parent_warrant_id;
    }
    return chain;
  }

  private depthOf(warrantId: string): number {
    return this.chainUp(warrantId).length;
  }

  private snapshotRecord(warrantId: string): WarrantRecordSnapshot | undefined {
    const record = this.records.get(warrantId);
    if (record === undefined) return undefined;
    return {
      warrant: cloneWarrant(record.warrant),
      remaining: this.remainingSnapshot(warrantId),
      ...(record.bearer_hash === undefined ? {} : { bearer_hash: record.bearer_hash }),
    };
  }

  private remainingSnapshot(warrantId: string): Record<string, number> {
    return Object.fromEntries(this.records.get(warrantId)?.remaining ?? []);
  }

  private reservationKey(warrantId: string, tool: string): string {
    return `${warrantId}\u0000${tool}`;
  }
}
