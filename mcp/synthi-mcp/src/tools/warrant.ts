/**
 * Agent-warrant MCP surface + enforcement gate (WI_WARRANTS_SPEC, Patch B).
 *
 * Five tools expose the pure WarrantRegistry (Patch A) over MCP: issue a root
 * lease, attenuate it into strictly narrower children, check coverage, revoke
 * a subtree, and list the full audit view. One process-wide registry backs
 * them all; every mutating call stamps time at the boundary (`now: Date.now()`),
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
 */

import { WarrantRegistry, type ToolGrant } from "../security/warrant.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";
import { buildError, type ErrorPayload } from "../correctness/errors.js";
import { eventLog } from "../events/index.js";

/** The five warrant tools this module owns (mirrored in tool_registry.ts). */
export const WARRANT_TOOL_NAMES = [
  "synthi_warrant_issue",
  "synthi_warrant_attenuate",
  "synthi_warrant_check",
  "synthi_warrant_revoke",
  "synthi_warrant_list",
] as const;

/** Process-wide registry behind the MCP surface. Singleton by design. */
const warrantRegistry = new WarrantRegistry();

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
      default:
        throw new Error(`Unknown warrant tool '${toolName}'.`);
    }
  } catch (err) {
    return errorResponse("warrant_tool_failed", { human_reason: errorMessage(err) });
  }
}

function issueTool(args: unknown): ToolResponse {
  const a = obj(args);
  const warrant = warrantRegistry.issue({
    subject: requiredString(a, "subject"),
    grants: toolGrants(a["grants"]),
    now: Date.now(),
    ttl_ms: requiredNumber(a, "ttl_ms"),
  });
  return jsonResponse({ ok: true, warrant });
}

function attenuateTool(args: unknown): ToolResponse {
  const a = obj(args);
  const warrant = warrantRegistry.attenuate({
    parent_warrant_id: requiredString(a, "parent_warrant_id"),
    subject: requiredString(a, "subject"),
    grants: toolGrants(a["grants"]),
    now: Date.now(),
    ttl_ms: numberOpt(a["ttl_ms"]),
  });
  return jsonResponse({ ok: true, warrant });
}

function checkTool(args: unknown): ToolResponse {
  const a = obj(args);
  const decision = warrantRegistry.check({
    warrant_id: requiredString(a, "warrant_id"),
    tool: requiredString(a, "tool"),
    args: recordOpt(a["args"]),
    now: numberOpt(a["now"]) ?? Date.now(),
  });
  return jsonResponse({ ok: decision.allowed, ...decision });
}

function revokeTool(args: unknown): ToolResponse {
  const revokedCount = warrantRegistry.revoke(requiredString(obj(args), "warrant_id"));
  return jsonResponse({ ok: true, revoked_count: revokedCount });
}

export type WarrantMode = "off" | "warn" | "enforce";

export function resolveWarrantMode(): WarrantMode {
  const raw = process.env["SYNTHI_WARRANT_MODE"];
  if (raw === "warn") return "warn";
  if (raw === "enforce") return "enforce";
  return "off";
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
  if (mode === "off") return null;

  const warrantId = metaWarrantId(params);
  if (warrantId !== undefined) {
    const args = (params as { arguments?: unknown } | undefined)?.arguments;
    const decision = warrantRegistry.check({
      warrant_id: warrantId,
      tool: toolName,
      args: recordOpt(args),
      now: Date.now(),
    });
    if (decision.allowed) {
      warrantRegistry.chargeInvocation(warrantId, toolName);
      return null;
    }
    eventLog.push({
      kind: "security",
      code: "rate_limit_warning",
      detail: {
        code: "warrant_denied",
        mode,
        tool: toolName,
        warrant_id: warrantId,
        reason_code: decision.reason_code,
        human_reason: decision.human_reason,
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

function metaWarrantId(params: unknown): string | undefined {
  const meta = (params as { _meta?: { warrant_id?: unknown } } | undefined)?._meta;
  const value = meta?.warrant_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    inputSchema: { type: "object", properties: { subject: { type: "string", description: "Agent or user the warrant is for." }, grants: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, arg_constraints: { type: "object", additionalProperties: { type: "string" } }, max_invocations: { type: "number" } }, required: ["tool"] } }, ttl_ms: { type: "number" } }, required: ["subject", "grants", "ttl_ms"] },
  },
  {
    name: "synthi_warrant_attenuate",
    description: "Create a strictly narrower child warrant from an existing one so work can be delegated with less authority than the holder has.",
    inputSchema: { type: "object", properties: { parent_warrant_id: { type: "string" }, subject: { type: "string" }, grants: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, arg_constraints: { type: "object", additionalProperties: { type: "string" } }, max_invocations: { type: "number" } }, required: ["tool"] } }, ttl_ms: { type: "number" } }, required: ["parent_warrant_id", "subject", "grants"] },
  },
  {
    name: "synthi_warrant_check",
    description: "Ask whether a warrant allows one tool call right now, with plain-language denial reasons.",
    inputSchema: { type: "object", properties: { warrant_id: { type: "string" }, tool: { type: "string" }, args: { type: "object" }, now: { type: "number" } }, required: ["warrant_id", "tool"] },
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
] as const;
