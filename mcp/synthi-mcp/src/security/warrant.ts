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
 */

import { randomUUID } from "node:crypto";

/** Delegation chains may never run deeper than this many warrants. */
const MAX_CHAIN_DEPTH = 8;

export interface ToolGrant {
  tool: string;
  /** glob patterns ( "*" and "**" only ) matched against top-level string values of the call args */
  arg_constraints?: Readonly<Record<string, string>>;
  /** hard ceiling on invocations charged to this grant */
  max_invocations?: number;
}

export interface Warrant {
  warrant_id: string;
  subject: string;
  grants: readonly ToolGrant[];
  issued_at_ms: number;
  expires_at_ms: number;
  /** undefined for roots; set for attenuated children */
  parent_warrant_id?: string;
  /** id of the tree root; equals warrant_id for roots */
  root_warrant_id: string;
  status: "active" | "revoked";
}

export type WarrantDecision =
  | { allowed: true; warrant_id: string }
  | { allowed: false; reason_code: string; human_reason: string };

interface WarrantRecord {
  readonly warrant: Warrant;
  /** tool -> invocations left; only present for tools whose grant sets max_invocations */
  readonly remaining: Map<string, number>;
}

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
function grantAcceptsArgs(
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
function firstViolatedArgKey(
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
  private readonly records = new Map<string, WarrantRecord>();

  /** Issue a fresh root warrant (no parent). Throws on bad input. */
  issue(input: {
    subject: string;
    grants: readonly ToolGrant[];
    now: number;
    ttl_ms: number;
  }): Warrant {
    validateSubjectAndGrants(input.subject, input.grants);
    validateTtl(input.ttl_ms);

    const warrantId = `wr_${randomUUID()}`;
    const warrant: Warrant = {
      warrant_id: warrantId,
      subject: input.subject,
      grants: cloneGrants(input.grants),
      issued_at_ms: input.now,
      expires_at_ms: input.now + input.ttl_ms,
      root_warrant_id: warrantId,
      status: "active",
    };
    this.records.set(warrantId, { warrant, remaining: initialRemaining(warrant.grants) });
    return { ...warrant };
  }

  /**
   * Attenuate a warrant: issue a strictly narrower child under an active,
   * unexpired parent. Child tools must exist in the parent (exact name),
   * arg constraints must be subset-per-key (equal or stricter), invocation
   * ceilings must fit the parent's remaining budget, expiry is clamped to
   * the parent's, and chain depth may not exceed MAX_CHAIN_DEPTH.
   */
  attenuate(input: {
    parent_warrant_id: string;
    subject: string;
    grants: readonly ToolGrant[];
    now: number;
    ttl_ms?: number;
  }): Warrant {
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

    validateSubjectAndGrants(input.subject, input.grants);
    if (input.ttl_ms !== undefined) validateTtl(input.ttl_ms);

    if (this.depthOf(input.parent_warrant_id) + 1 > MAX_CHAIN_DEPTH) {
      throw new Error(
        `Cannot attenuate: delegation chain would exceed the maximum depth of ${MAX_CHAIN_DEPTH}.`,
      );
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
    }

    const ttl = input.ttl_ms === undefined ? parent.warrant.expires_at_ms - input.now : input.ttl_ms;
    const warrant: Warrant = {
      warrant_id: `wr_${randomUUID()}`,
      subject: input.subject,
      grants: cloneGrants(input.grants),
      issued_at_ms: input.now,
      expires_at_ms: Math.min(parent.warrant.expires_at_ms, input.now + ttl),
      parent_warrant_id: input.parent_warrant_id,
      root_warrant_id: parent.warrant.root_warrant_id,
      status: "active",
    };
    this.records.set(warrant.warrant_id, { warrant, remaining: initialRemaining(warrant.grants) });
    return { ...warrant };
  }

  /** THE decision function. Fails closed with reason_code + human_reason. */
  check(input: {
    warrant_id: string;
    tool: string;
    args?: Readonly<Record<string, unknown>>;
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

    const covering = record.warrant.grants.filter((grant) => grant.tool === input.tool);
    if (covering.length === 0) {
      return deny("tool_not_covered", `This warrant does not cover the '${input.tool}' capability.`);
    }

    const argsAccepted = covering.some((grant) => grantAcceptsArgs(grant, input.args));
    if (!argsAccepted) {
      const key = firstViolatedArgKey(covering, input.args);
      return deny("arg_out_of_scope", `This warrant restricts '${key}'; the requested value is outside it.`);
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
    return Array.from(this.records.values(), (record) => ({ ...record.warrant }));
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
}
