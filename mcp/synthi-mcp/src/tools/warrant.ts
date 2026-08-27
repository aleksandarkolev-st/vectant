/**
 * Agent-warrant MCP surface + enforcement gate (WI_WARRANTS_SPEC, Patches B/D/F/G/H).
 *
 * Nine tools expose the pure WarrantRegistry plus the separated TrustLedger
 * over MCP: issue a root lease, attenuate it into strictly narrower children,
 * check coverage, revoke a subtree, list the full audit view, inspect a
 * warrant's bound trust progression, bind/unbind that progression to a
 * registered policy, and register policies. One process-wide registry backs
 * them all; every mutating call stamps time at the boundary
 * (`now: Date.now()`),
 * keeping the core clock-free per the house rules.
 *
 * `enforceWarrantGate` is the CallTool hook wired next to the quota gate in
 * `server.ts`, driven by env:
 *
 *   SYNTHI_WARRANT_MODE=off      default — gate inert
 *   SYNTHI_WARRANT_MODE=warn     log a security event on violation, still dispatch
 *   SYNTHI_WARRANT_MODE=enforce  reject with warrant_required unless the call
 *                                carries a covering warrant in `_meta.warrant_id`
 *
 * When a warrant id is presented, the gate checks it and charges the
 * invocation before dispatch, so chain-wide budgets are consumed exactly once
 * per admitted call. Failures fail closed with plain-language reasons.
 *
 * Gate order (Patch G golden rule: trust can never outrank lifecycle):
 * registry.check runs FIRST on every bound call — revocation, expiry, bearer
 * possession, base coverage, arg scope, and chain budgets always win over any
 * trust-unlocked grants; only an all-clear from the registry lets the ledger's
 * unlocked grants extend coverage. Charge follows admission, evidence
 * recording follows last.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  WarrantRegistry,
  grantAcceptsArgs,
  firstViolatedArgKey,
  type ToolGrant,
  type WarrantDecision,
  type WarrantJournalEvent,
  type WarrantRecordSnapshot,
} from "../security/warrant.js";
import { TrustLedger, type TrustJournalEvent } from "../security/trust.js";
import { WarrantStore } from "../security/warrant_store.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";
import { buildError, type ErrorPayload } from "../correctness/errors.js";
import { eventLog } from "../events/index.js";

/** The warrant management tools this module owns (mirrored in tool_registry.ts). */
export const WARRANT_TOOL_NAMES = [
  "synthi_warrant_issue",
  "synthi_warrant_attenuate",
  "synthi_warrant_check",
  "synthi_warrant_revoke",
  "synthi_warrant_list",
  "synthi_warrant_trust",
  "synthi_warrant_bind_trust",
  "synthi_warrant_policy_register",
  "synthi_warrant_unbind",
  "synthi_warrant_renew",
] as const;

/** When set, warrant management tools additionally require this key in _meta.warrant_admin_key. */
export function resolveWarrantAdminKey(): string | null {
  const raw = process.env["SYNTHI_WARRANT_ADMIN_KEY"];
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : null;
}

/** Organization-level ceilings over how many warrants may exist and how long they may run. */
export function resolveOrgCeilings(): { max_active: number; max_ttl_ms: number; max_invocations_per_grant: number } {
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    max_active: parsePositive(process.env["SYNTHI_WARRANT_MAX_ACTIVE"], 100),
    max_ttl_ms: parsePositive(process.env["SYNTHI_WARRANT_MAX_TTL_MS"], 86_400_000),
    max_invocations_per_grant: parsePositive(process.env["SYNTHI_WARRANT_MAX_INVOCATIONS"], 10_000),
  };
}

function adminKeyPresented(params: unknown): unknown {
  return metaValue(params, "warrant_admin_key");
}

/** Process-wide registry behind the MCP surface. Singleton by design. */
const warrantRegistry = new WarrantRegistry();
/** Process-wide progression ledger behind the separated trust surface. */
const trustLedger = new TrustLedger();

type TrustJournalSnapshot = ReturnType<TrustLedger["snapshotForJournal"]>;
type DurableWarrantJournalEvent =
  | WarrantJournalEvent
  | TrustJournalEvent
  | { k: "checkpoint"; registry: WarrantRecordSnapshot[]; trust: TrustJournalSnapshot };

/**
 * Patch K1 — durable state. When SYNTHI_WARRANT_STORE names a file, every
 * mutation of the registry or ledger is appended (AES-256-GCM encrypted,
 * fsync'd) to that journal, and on module init the journal is replayed into
 * the singletons before this module serves any call. No path, no persistence:
 * behavior is exactly as before. The key comes from SYNTHI_WARRANT_STORE_KEY
 * when set; otherwise a 0600 machine-local key file under os.tmpdir() does.
 */
const journalPath = process.env["SYNTHI_WARRANT_STORE"];
let warrantStore: WarrantStore | undefined;
if (journalPath !== undefined && journalPath.trim().length > 0) {
  warrantStore = new WarrantStore({ file: journalPath.trim(), key: process.env["SYNTHI_WARRANT_STORE_KEY"] });
  // Replay first: restore must not re-emit (restore paths never emit).
  const journal = warrantStore.replay<DurableWarrantJournalEvent>();
  for (const { event } of journal) {
    switch (event.k) {
      case "issue":
      case "attenuate":
        warrantRegistry.restoreRecord({
          ...event.record,
        });
        break;
      case "revoke":
        warrantRegistry.restoreRevoked(event.warrant_id);
        break;
      case "renew":
        warrantRegistry.restoreRenewal(event.warrant_id, event.expires_at_ms, event.remaining);
        break;
      case "record":
        if ("remaining" in event) warrantRegistry.restoreRemaining(event.warrant_id, event.remaining);
        else trustLedger.restoreBinding(event.warrant_id, event.binding);
        break;
      case "policy":
        trustLedger.restorePolicy(event.policy);
        break;
      case "bind":
        trustLedger.restoreBinding(event.warrant_id, event.binding);
        break;
      case "unbind":
        trustLedger.restoreUnbind(event.warrant_id);
        break;
      case "tombstone":
        trustLedger.restoreTombstone(event.warrant_id, event.demoted_rungs, event.cooldown_until_ms);
        break;
      case "taint":
        trustLedger.restoreTaint(event.subject, event.demoted_rungs);
        break;
      case "checkpoint":
        warrantRegistry.resetForTests();
        for (const record of event.registry) warrantRegistry.restoreRecord(record);
        trustLedger.restoreSnapshot(event.trust);
        break;
    }
  }
  // Then wire live emissions so new mutations persist.
  const appendJournalEvent = (event: WarrantJournalEvent | TrustJournalEvent): void => {
    warrantStore!.append<DurableWarrantJournalEvent>(event);
    if (warrantStore!.needsCheckpoint() || warrantStore!.needsRotation()) {
      const checkpoint: DurableWarrantJournalEvent = {
        k: "checkpoint",
        registry: warrantRegistry.snapshotForJournal(),
        trust: trustLedger.snapshotForJournal(),
      };
      if (warrantStore!.needsRotation()) warrantStore!.rotate(checkpoint);
      else warrantStore!.append(checkpoint);
    }
  };
  warrantRegistry.onMutate = appendJournalEvent;
  trustLedger.onMutate = appendJournalEvent;
}

/**
 * Patch I4: security events must not carry raw warrant identifiers — they are
 * capability handles. Only a short sha256 prefix is logged; correlation stays
 * possible, plaintext leakage does not.
 */
const rid = (id: string): string =>
  createHash("sha256").update(id).digest("hex").slice(0, 12);

export async function dispatchWarrantTool(
  toolName: string,
  args: unknown
): Promise<ToolResponse> {
  try {
    switch (toolName) {
      case "synthi_warrant_issue":
        return issueTool(args);
      case "synthi_warrant_attenuate":
        return attenuateTool(args);
      case "synthi_warrant_check":
        return checkTool(args);
      case "synthi_warrant_revoke":
        return revokeTool(args);
      case "synthi_warrant_list":
        return jsonResponse({ ok: true, warrants: warrantRegistry.listWarrants() });
      case "synthi_warrant_trust": {
        const view = trustLedger.view(requiredString(obj(args), "warrant_id"), Date.now());
        return jsonResponse({ ok: true, bound: view !== null, trust: view });
      }
      case "synthi_warrant_bind_trust": {
        const a = obj(args);
        const warrantId = requiredString(a, "warrant_id");
        // Patch G2: progression requires proof-of-possession. Binding is only
        // meaningful for sealed warrants — evidence must never accumulate for
        // a lease whose holder cannot even prove they hold it.
        const warrant = warrantRegistry.get(warrantId);
        if (warrant === undefined || warrant.sealed !== true) {
          return errorResponse("bind_requires_sealed", {
            human_reason:
              "Trust progression binds only sealed warrants; re-issue with seal:true so evidence is possession-proven.",
          });
        }
        // Patch I1: bind-time subject wiring — pass the warrant's subject so
        // inherited demotion taint lifts onto this binding immediately
        // (mirroring the gate's per-call subject resolution), not only after
        // its first recorded call. Positional note: `warrant` stays unset
        // (as before), so the subject occupies the ledger's fifth parameter.
        trustLedger.bind(warrantId, requiredString(a, "policy_id"), Date.now(), undefined, warrant.subject);
        return jsonResponse({ ok: true });
      }
      case "synthi_warrant_policy_register": {
        const a = obj(args);
        const rawSteps = a["steps"];
        if (!Array.isArray(rawSteps)) throw new Error("A policy needs an array of steps.");
        const steps = rawSteps.map((entry) => {
          const step = entry as Record<string, unknown>;
          const unlockAfter = step["unlock_after"] as Record<string, unknown> | undefined;
          if (!unlockAfter || typeof unlockAfter["min_sample"] !== "number" || typeof unlockAfter["success_ratio"] !== "number") {
            throw new Error("Every policy step needs numeric 'min_sample' and 'success_ratio' in 'unlock_after'.");
          }
          return { unlock_after: { min_sample: unlockAfter["min_sample"], success_ratio: unlockAfter["success_ratio"] }, grants: toolGrants(step["grants"]) };
        });
        const policyId = requiredString(a, "policy_id");
        trustLedger.registerPolicy({ policy_id: policyId, steps });
        return jsonResponse({ ok: true, policy_id: policyId });
      }
      case "synthi_warrant_unbind": {
        // Patch G3: escape valve — unbinding is allowed even mid-cooldown,
        // but stays holder-only by possession of the sealed bearer secret.
        const a = obj(args);
        const warrantId = requiredString(a, "warrant_id");
        const warrant = warrantRegistry.get(warrantId);
        if (warrant === undefined || warrant.sealed !== true) {
          return errorResponse("unbind_requires_sealed", {
            human_reason:
              "Trust detachment applies to sealed warrants; this identifier is unknown or was never sealed.",
          });
        }
        const probe = warrantRegistry.check({
          warrant_id: warrantId,
          tool: "__unbind_probe__",
          bearer: typeof a["bearer"] === "string" ? a["bearer"] : undefined,
          now: Date.now(),
        });
        if (!probe.allowed && probe.reason_code === "bearer_mismatch") {
          return errorResponse("bearer_mismatch", {
            human_reason: probe.human_reason,
          });
        }
        trustLedger.unbind(warrantId);
        return jsonResponse({ ok: true });
      }
      case "synthi_warrant_renew":
        return renewTool(args);
      default:
        throw new Error(`Unknown warrant tool '${toolName}'.`);
    }
  } catch (err) {
    return errorResponse("warrant_tool_failed", { human_reason: errorMessage(err) });
  }
}

function issueTool(args: unknown): ToolResponse {
  const a = obj(args);
  const now = Date.now();
  const ceilings = resolveOrgCeilings();
  const activeCount = warrantRegistry
    .listWarrants()
    .filter((w) => w.status === "active" && w.expires_at_ms > now).length;
  if (activeCount >= ceilings.max_active) {
    return errorResponse("warrant_ceiling_reached", {
      human_reason: `This organization already holds ${activeCount} active warrants (ceiling ${ceilings.max_active}). Revoke warrants before issuing more.`,
    });
  }
  const warrant = warrantRegistry.issue({
    subject: requiredString(a, "subject"),
    grants: toolGrants(a["grants"]),
    seal: a["seal"] === true,
    now,
    ttl_ms: Math.min(requiredNumber(a, "ttl_ms"), ceilings.max_ttl_ms),
  });
  // Patch H1: a subject carrying taint from demotions earned under earlier
  // warrants starts this warrant's progression at that floor, not from zero.
  trustLedger.applyInheritedTaint(warrant.warrant_id, String(a["subject"]));
  return jsonResponse({ ok: true, warrant });
}

function attenuateTool(args: unknown): ToolResponse {
  const a = obj(args);
  const ceilings = resolveOrgCeilings();
  const warrant = warrantRegistry.attenuate({
    parent_warrant_id: requiredString(a, "parent_warrant_id"),
    subject: requiredString(a, "subject"),
    grants: toolGrants(a["grants"]),
    seal: a["seal"] === true,
    now: Date.now(),
    ttl_ms: Math.min(numberOpt(a["ttl_ms"]) ?? Number.MAX_SAFE_INTEGER, ceilings.max_ttl_ms),
  });
  return jsonResponse({ ok: true, warrant });
}

function checkTool(args: unknown): ToolResponse {
  const a = obj(args);
  // Patch G6: the caller never supplies time — expiry is judged by the
  // server clock alone, so stale timestamps cannot revive a dead lease.
  const decision = warrantRegistry.check({
    warrant_id: requiredString(a, "warrant_id"),
    tool: requiredString(a, "tool"),
    args: recordOpt(a["args"]),
    bearer: typeof a["bearer"] === "string" ? a["bearer"] : undefined,
    now: Date.now(),
  });
  return jsonResponse({ ok: decision.allowed, ...decision });
}

function revokeTool(args: unknown): ToolResponse {
  const revokedCount = warrantRegistry.revoke(requiredString(obj(args), "warrant_id"));
  return jsonResponse({ ok: true, revoked_count: revokedCount });
}

function renewTool(args: unknown): ToolResponse {
  const a = obj(args);
  const ceilings = resolveOrgCeilings();
  const warrant = warrantRegistry.renewTo({
    warrant_id: requiredString(a, "warrant_id"),
    bearer: typeof a["bearer"] === "string" ? a["bearer"] : undefined,
    ttl_ms: requiredNumber(a, "ttl_ms"),
    now: Date.now(),
    max_ttl_ms: ceilings.max_ttl_ms,
    add_invocations: invocationTopUps(a["add_invocations"]),
    max_invocations_per_grant: ceilings.max_invocations_per_grant,
  });
  return jsonResponse({ ok: true, warrant });
}

export type WarrantMode = "off" | "warn" | "enforce";

export function resolveWarrantMode(): WarrantMode {
  const raw = process.env["SYNTHI_WARRANT_MODE"];
  if (raw === "warn") return "warn";
  if (raw === "enforce") return "enforce";
  return "off";
}

function adminKeyMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Server-dispatch adapter, called before every tool call right after the
 * quota gate. Returns:
 *   - `null` to proceed with dispatch
 *   - ErrorPayload to short-circuit with `warrant_required`
 *
 * With no warrant id in `_meta`, only warn/enforce modes react (warn logs and
 * continues, enforce rejects). With one present, the warrant is checked and,
 * on success, charged for the invocation in both active modes.
 */
export function enforceWarrantGate(toolName: string, params: unknown): ErrorPayload | null {
  const mode = resolveWarrantMode();
  // Management-plane exemption: the warrant tools themselves must stay
  // callable in enforce mode or no first warrant could ever be issued
  // (bootstrap deadlock proven by live wire testing 2026-08-26).
  if ((WARRANT_TOOL_NAMES as readonly string[]).includes(toolName)) {
    if (mode === "off") return null;
    const adminKey = resolveWarrantAdminKey();
    // Unconfigured (local/dev) posture keeps the historical open management plane.
    if (adminKey === null) return null;
    if (adminKeyMatches(adminKeyPresented(params), adminKey)) return null;
    // Patch K2: a holder of a sealed warrant can renew only that credential
    // by presenting its bearer. Other lifecycle and policy operations remain
    // strictly on the admin-gated management plane.
    if (toolName === "synthi_warrant_renew" && hasSealedRenewalBearer(params)) return null;
    eventLog.push({
      kind: "security",
      code: "rate_limit_warning",
      detail: { code: "warrant_admin_required", mode, tool: toolName },
    });
    if (mode === "warn") return null;
    return buildError("warrant_admin_required", {
      human_reason:
        "Warrant administration requires the organization's admin key in the call's _meta.warrant_admin_key field.",
    });
  }
  if (mode === "off") return null;

  const warrantId = metaWarrantId(params);
  if (warrantId !== undefined) {
    const args = (params as { arguments?: unknown } | undefined)?.arguments;
    const nowMs = Date.now();
    const argsRecord = recordOpt(args);
    const bearer = typeof metaValue(params, "warrant_bearer") === "string" ? metaValue(params, "warrant_bearer") as string : undefined;
    // Patch H1: resolve the acting subject ONCE so every evidence write below
    // tags the demotion-taint map with whoever holds this warrant.
    const wSnap = warrantRegistry.get(warrantId);
    const subject = wSnap?.subject;
    // Patch G1 golden rule: registry.check runs UNCONDITIONALLY first —
    // lifecycle (revoked/expired/unknown), bearer possession, base coverage,
    // argument scope, and chain budgets all outrank trust. Any denial is used
    // verbatim; only an all-clear lets the ledger's unlocked grants extend
    // coverage to tools the base lease never named.
    let decision: WarrantDecision = warrantRegistry.check({
      warrant_id: warrantId,
      tool: toolName,
      args: argsRecord,
      bearer,
      now: nowMs,
    });
    if (!decision.allowed) {
      if (decision.reason_code === "tool_not_covered" && trustLedger.view(warrantId, nowMs) !== null) {
        // Bound and base-blind: re-evaluate coverage over the ladder's
        // currently unlocked grants, mirroring registry rules exactly.
        const view = trustLedger.view(warrantId, nowMs)!;
        const covering: ToolGrant[] = view.unlocked_grants.filter((grant) => grant.tool === toolName);
        if (covering.length > 0 && covering.some((grant) => grantAcceptsArgs(grant, argsRecord))) {
          decision = { allowed: true, warrant_id: warrantId };
        } else {
          const reasonCode = covering.length === 0 ? "tool_not_covered" : "arg_out_of_scope";
          decision = {
            allowed: false,
            reason_code: reasonCode,
            human_reason:
              reasonCode === "tool_not_covered"
                ? `This warrant does not cover the '${toolName}' capability.`
                : `This warrant restricts '${firstViolatedArgKey(covering, argsRecord)}'; the requested value is outside it.`,
          };
          trustLedger.record(
            warrantId,
            { allowed: false, reason_code: reasonCode },
            nowMs,
            subject,
          );
        }
      } else {
        // Lifecycle/bearer/base-scope/budget denial stands verbatim (and still
        // feeds the ledger so probe-shaped denials demote as designed).
        trustLedger.record(
          warrantId,
          { allowed: false, reason_code: decision.reason_code },
          nowMs,
          subject,
        );
      }
    }
    if (decision.allowed) {
      // Patch J1: reserve atomically across the chain (closes the concurrent
      // double-spend window); the reservation IS the charge on success.
      const reservation = warrantRegistry.tryReserve(warrantId, toolName);
      if (!reservation.reserved) {
        decision = {
          allowed: false,
          reason_code: "invocations_exhausted",
          human_reason: `This warrant's invocation budget for '${toolName}' is exhausted (a parallel call may hold the last slot).`,
        };
        trustLedger.record(warrantId, { allowed: false, reason_code: "invocations_exhausted" }, nowMs, subject);
      } else {
        // Evidence is recorded only after the atomic reservation succeeds;
        // a parallel budget race must not produce a phantom admitted call.
        trustLedger.record(warrantId, { allowed: true }, nowMs, subject);
        return null;
      }
    }
    eventLog.push({
      kind: "security",
      code: "rate_limit_warning",
      detail: {
        code: "warrant_denied",
        mode,
        tool: toolName,
        warrant_id: rid(warrantId),
        reason_code: decision.reason_code,
        human_reason: String(decision.human_reason).slice(0, 120),
      },
    });
    if (mode === "warn") return null;
    return buildError("warrant_required", {
      reason_code: decision.reason_code,
      human_reason: decision.human_reason,
    });
  }

  eventLog.push({
    kind: "security",
    code: "rate_limit_warning",
    detail: { code: "warrant_required", mode, tool: toolName },
  });
  if (mode === "warn") return null;
  return buildError("warrant_required", {
    human_reason:
      "This server requires a capability warrant for tool calls right now. Present a warrant identifier in the call's _meta.warrant_id field.",
  });
}

/**
 * Patch J1: settle a reservation after dispatch. A failed (isError) dispatch
 * refunds the invocation across the chain; success keeps it as the charge.
 * Safe no-op when the call carried no warrant id or an unknown one.
 */
export function metaWarrantIdFromParams(params: unknown): string | undefined {
  return metaWarrantId(params);
}

export function settleWarrant(_toolName: string, warrantId: string | undefined, keepCharge: boolean): void {
  if (!warrantId) return;
  warrantRegistry.settleReserved(warrantId, _toolName, keepCharge);
}

function hasSealedRenewalBearer(params: unknown): boolean {
  const args = recordOpt((params as { arguments?: unknown } | undefined)?.arguments);
  const warrantId = args?.["warrant_id"];
  const bearer = args?.["bearer"];
  if (typeof warrantId !== "string" || typeof bearer !== "string") return false;
  const snapshot = warrantRegistry.get(warrantId);
  if (snapshot?.sealed !== true) return false;
  const probe = warrantRegistry.check({ warrant_id: warrantId, tool: "__renew_probe__", bearer, now: Date.now() });
  return probe.allowed || probe.reason_code === "tool_not_covered";
}

/**
 * Patch J3: gate resource reads. Security-event resources carry sensitive
 * telemetry (warrant ids, reason codes), so in warn/enforce modes they
 * require either an active warrant or the organization admin key. Returns
 * an error payload to reject, or null to allow.
 */
export function authorizeResourceRead(uri: string, params: unknown): ErrorPayload | null {
  const mode = resolveWarrantMode();
  if (mode === "off") return null;
  let path = "";
  try {
    path = new URL(uri).pathname.toLowerCase();
  } catch {
    path = uri.toLowerCase();
  }
  if (!path.includes("events")) return null;
  const adminKey = resolveWarrantAdminKey();
  if (adminKey !== null && adminKeyMatches(adminKeyPresented(params), adminKey)) return null;
  const warrantId = metaValue(params, "warrant_id");
  if (typeof warrantId === "string" && warrantId.length > 0) {
    const snapshot = warrantRegistry.get(warrantId);
    if (snapshot !== undefined && snapshot.status === "active" && snapshot.expires_at_ms > Date.now()) {
      return null;
    }
  }
  eventLog.push({
    kind: "security",
    code: "rate_limit_warning",
    detail: {
      code: "resource_access_denied",
      mode,
      uri: String(uri).slice(0, 120),
      warrant_id: typeof warrantId === "string" ? rid(warrantId) : undefined,
    },
  });
  return buildError("resource_access_denied", {
    human_reason: "Reading security-event resources requires an active warrant or the organization admin key.",
  });
}

function metaValue(params: unknown, key: string): unknown {
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metaWarrantId(params: unknown): string | undefined {
  const v = metaValue(params, "warrant_id");
  return typeof v === "string" ? v : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coerce the JSON `grants` array into ToolGrants, rejecting malformed entries
 * up front so the pure registry only ever sees well-typed input.
 */
function toolGrants(value: unknown): ToolGrant[] {
  if (!Array.isArray(value)) throw new Error("A warrant needs an array of grants.");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Every warrant grant must be an object.");
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw["tool"] !== "string" || raw["tool"].length === 0) {
      throw new Error("Every warrant grant needs a non-empty 'tool' name.");
    }
    const grant: ToolGrant = { tool: raw["tool"] };

    const constraints = raw["arg_constraints"];
    if (constraints !== undefined) {
      if (typeof constraints !== "object" || constraints === null || Array.isArray(constraints)) {
        throw new Error(`Grant '${raw["tool"]}' needs 'arg_constraints' to be an object of glob patterns.`);
      }
      const parsed: Record<string, string> = {};
      for (const [key, pattern] of Object.entries(constraints as Record<string, unknown>)) {
        if (typeof pattern !== "string") {
          throw new Error(`Grant '${raw["tool"]}' needs a string glob pattern for constraint '${key}'.`);
        }
        parsed[key] = pattern;
      }
      grant.arg_constraints = parsed;
    }

    const maxInvocations = raw["max_invocations"];
    if (maxInvocations !== undefined) {
      if (typeof maxInvocations !== "number" || !Number.isFinite(maxInvocations) || maxInvocations <= 0) {
        throw new Error(`Grant '${raw["tool"]}' needs a positive numeric 'max_invocations'.`);
      }
      grant.max_invocations = maxInvocations;
    }
    return grant;
  });
}

function invocationTopUps(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("'add_invocations' must be an object mapping tool names to positive integers.");
  }
  const result: Record<string, number> = {};
  for (const [tool, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`Top-up for '${tool}' must be a positive integer.`);
    }
    result[tool] = count;
  }
  return result;
}

function obj(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>;
}

function recordOpt(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`This tool needs a non-empty '${field}' string.`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, field: string): number {
  const value = numberOpt(args[field]);
  if (value === undefined) {
    throw new Error(`This tool needs a numeric '${field}' value.`);
  }
  return value;
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const WARRANT_TOOLS = [
  {
    name: "synthi_warrant_issue",
    description: "Issue a capability warrant: an expiring, invocation-capped lease letting one agent use specific tools under argument constraints.",
    inputSchema: {"type":"object","properties":{"subject":{"type":"string","description":"Agent or user the warrant is for."},"grants":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"arg_constraints":{"type":"object","additionalProperties":{"type":"string"}},"max_invocations":{"type":"number"}},"required":["tool"]}},"ttl_ms":{"type":"number"},"seal":{"type":"boolean","description":"Seal the warrant: every use must present the one-time bearer secret in _meta.warrant_bearer."}},"required":["subject","grants","ttl_ms"]},
  },
  {
    name: "synthi_warrant_attenuate",
    description: "Create a strictly narrower child warrant from an existing one so work can be delegated with less authority than the holder has.",
    inputSchema: {"type":"object","properties":{"parent_warrant_id":{"type":"string"},"subject":{"type":"string"},"grants":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"arg_constraints":{"type":"object","additionalProperties":{"type":"string"}},"max_invocations":{"type":"number"}},"required":["tool"]}},"ttl_ms":{"type":"number"},"seal":{"type":"boolean","description":"Seal the warrant: every use must present the one-time bearer secret in _meta.warrant_bearer."}},"required":["parent_warrant_id","subject","grants"]},
  },
  {
    name: "synthi_warrant_check",
    description: "Ask whether a warrant allows one tool call right now, with plain-language denial reasons.",
    inputSchema: { type: "object", properties: { warrant_id: { type: "string" }, tool: { type: "string" }, args: { type: "object" }, bearer: { type: "string", description: "Bearer secret proving possession of a sealed warrant." } }, required: ["warrant_id", "tool"] },
  },
  {
    name: "synthi_warrant_revoke",
    description: "Revoke a warrant and every warrant delegated from it, immediately.",
    inputSchema: { type: "object", properties: { warrant_id: { type: "string" } }, required: ["warrant_id"] },
  },
  {
    name: "synthi_warrant_list",
    description: "List every known warrant for audit.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_warrant_trust",
    description: "Show an agent's trust progression: current rung, evidence progress, and unlocked grants.",
    inputSchema: {"type":"object","properties":{"warrant_id":{"type":"string"}},"required":["warrant_id"]},
  },
  {
    name: "synthi_warrant_bind_trust",
    description: "Bind a sealed warrant to a registered trust-progression policy so its authority grows with clean call evidence.",
    inputSchema: {"type":"object","properties":{"warrant_id":{"type":"string"},"policy_id":{"type":"string"}},"required":["warrant_id","policy_id"]},
  },
  {
    name: "synthi_warrant_policy_register",
    description: "Register a named trust-progression policy: ordered rungs with evidence gates unlocking extra grants.",
    inputSchema: {"type":"object","properties":{"policy_id":{"type":"string"},"steps":{"type":"array","description":"Ordered autonomy rungs.","items":{"type":"object","properties":{"unlock_after":{"type":"object","properties":{"min_sample":{"type":"number"},"success_ratio":{"type":"number"}},"required":["min_sample","success_ratio"]},"grants":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"arg_constraints":{"type":"object","additionalProperties":{"type":"string"}},"max_invocations":{"type":"number"}},"required":["tool"]}}},"required":["unlock_after","grants"]}}},"required":["policy_id","steps"]},
  },
  {
    name: "synthi_warrant_unbind",
    description: "Detach a sealed warrant from its trust policy (holder-only; requires the warrant's bearer secret).",
    inputSchema: { type: "object", properties: { warrant_id: { type: "string" }, bearer: { type: "string" } }, required: ["warrant_id", "bearer"] },
  },
  {
    name: "synthi_warrant_renew",
    description: "Extend an active warrant without resetting its earned trust, demotions, or remaining budget. Sealed warrants may self-renew by presenting their bearer secret; administrators may renew any active warrant within organization ceilings.",
    inputSchema: { type: "object", properties: { warrant_id: { type: "string" }, bearer: { type: "string", description: "Required to self-renew a sealed warrant without the admin key." }, ttl_ms: { type: "number", description: "Requested extension, clamped to remaining organization and parent-warrant lifetime." }, add_invocations: { type: "object", additionalProperties: { type: "integer", minimum: 1 }, description: "Optional replenishment for invocation-capped grants, bounded by their original organization-approved ceiling." } }, required: ["warrant_id", "ttl_ms"] },
  },
] as const;

/** Test isolation hook for the process-wide registry. */
export function __resetWarrantRegistryForTests(): void {
  warrantRegistry.resetForTests();
  trustLedger.resetForTests();
}
