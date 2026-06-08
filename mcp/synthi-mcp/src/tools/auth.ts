import { authCheckpointManager } from "../browser/auth.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";
import type { AuthDurabilityV7 } from "../browser/workflow.js";

export const AUTH_TOOL_NAMES = [
  "synthi_auth_begin_checkpoint_enrollment",
  "synthi_auth_finish_checkpoint_enrollment",
  "synthi_auth_list_checkpoints",
  "synthi_auth_revoke_checkpoint",
  "synthi_auth_configure_refresh_provider",
  "synthi_auth_test_refresh_provider",
  "synthi_auth_get_tool_auth_readiness",
] as const;

export const AUTH_TOOLS = [
  {
    name: "synthi_auth_begin_checkpoint_enrollment",
    description:
      "Begin metadata-only auth checkpoint enrollment for an app origin. Does not expose cookies, tokens, localStorage, or sessionStorage values.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        reason: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "synthi_auth_finish_checkpoint_enrollment",
    description:
      "Finish auth checkpoint enrollment with redirect-chain IdP grants and TTL metadata. Raw auth artifact values are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: { type: "string" },
        app_url: { type: "string" },
        redirect_chain: { type: "array", items: { type: "string" } },
        ttl_ms: { type: "number" },
        durability: {
          type: "string",
          enum: ["interactiveCheckpoint", "idpCheckpoint", "refreshProvider", "ciTestAuth"],
        },
      },
      required: ["enrollment_id"],
    },
  },
  {
    name: "synthi_auth_list_checkpoints",
    description: "List auth checkpoint metadata for all origins or one app origin. Secret values are never returned.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_auth_revoke_checkpoint",
    description: "Revoke an auth checkpoint by id.",
    inputSchema: {
      type: "object",
      properties: { checkpoint_id: { type: "string" } },
      required: ["checkpoint_id"],
    },
  },
  {
    name: "synthi_auth_configure_refresh_provider",
    description:
      "Configure a refresh-provider metadata record using a Synthi secret reference. Secret values are rejected and never returned.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        secret_ref: { type: "string", description: "Synthi secret URI, for example synthi://secrets/workspace/auth-refresh." },
        provider_type: { type: "string", enum: ["projectRefreshProvider", "ciTestAuth"] },
      },
      required: ["url", "secret_ref"],
    },
  },
  {
    name: "synthi_auth_test_refresh_provider",
    description:
      "Validate refresh-provider metadata and report whether it can mint replay auth state. Does not reveal secret values.",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "synthi_auth_get_tool_auth_readiness",
    description:
      "Return whether an origin has auth durable enough for an interactive or unattended generated workflow tool.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        unattended: { type: "boolean", default: false },
      },
      required: ["url"],
    },
  },
] as const;

export async function dispatchAuthTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  try {
    switch (toolName) {
      case "synthi_auth_begin_checkpoint_enrollment":
        return beginEnrollmentTool(args);
      case "synthi_auth_finish_checkpoint_enrollment":
        return finishEnrollmentTool(args);
      case "synthi_auth_list_checkpoints":
        return jsonResponse({ ok: true, checkpoints: authCheckpointManager.list(stringOpt(obj(args)["url"])) });
      case "synthi_auth_revoke_checkpoint":
        return revokeCheckpointTool(args);
      case "synthi_auth_configure_refresh_provider":
        return configureRefreshProviderTool(args);
      case "synthi_auth_test_refresh_provider":
        return testRefreshProviderTool(args);
      case "synthi_auth_get_tool_auth_readiness":
        return authReadinessTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("auth_tool_failed", err);
  }
}

function beginEnrollmentTool(args: unknown): ToolResponse {
  const a = obj(args);
  return jsonResponse({
    ok: true,
    enrollment: authCheckpointManager.beginEnrollment(requiredString(a, "url"), stringOpt(a["reason"])),
  });
}

function finishEnrollmentTool(args: unknown): ToolResponse {
  const a = obj(args);
  const result = authCheckpointManager.finishEnrollment({
    enrollment_id: requiredString(a, "enrollment_id"),
    app_url: stringOpt(a["app_url"]),
    redirect_chain: stringArrayOpt(a["redirect_chain"]),
    ttl_ms: numberOpt(a["ttl_ms"]),
    durability: authDurabilityOpt(a["durability"]),
  });
  if (!result.ok) return errorResponse(result.error);
  return jsonResponse({ ok: true, checkpoint: result.checkpoint });
}

function revokeCheckpointTool(args: unknown): ToolResponse {
  const result = authCheckpointManager.revoke(requiredString(obj(args), "checkpoint_id"));
  if (!result.ok) return errorResponse(result.error);
  return jsonResponse({ ok: true, checkpoint: result.checkpoint });
}

function configureRefreshProviderTool(args: unknown): ToolResponse {
  const a = obj(args);
  const result = authCheckpointManager.configureRefreshProvider({
    url: requiredString(a, "url"),
    secret_ref: requiredString(a, "secret_ref"),
    provider_type: refreshProviderTypeOpt(a["provider_type"]),
  });
  if (!result.ok) return errorResponse(result.error);
  return jsonResponse({ ok: true, provider: result.provider });
}

function testRefreshProviderTool(args: unknown): ToolResponse {
  const result = authCheckpointManager.testRefreshProvider(requiredString(obj(args), "provider_id"));
  if (!result.ok) return errorResponse(result.error);
  return jsonResponse({ ok: true, provider: result.provider, can_mint_replay_state: result.can_mint_replay_state });
}

function authReadinessTool(args: unknown): ToolResponse {
  const a = obj(args);
  return jsonResponse({
    ok: true,
    readiness: authCheckpointManager.readiness(requiredString(a, "url"), boolOpt(a["unattended"]) ?? false),
  });
}

function obj(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${field}`);
  return value;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolOpt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayOpt(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function authDurabilityOpt(value: unknown): AuthDurabilityV7 | undefined {
  if (
    value === "interactiveCheckpoint" ||
    value === "idpCheckpoint" ||
    value === "refreshProvider" ||
    value === "ciTestAuth"
  ) {
    return value;
  }
  return undefined;
}

function refreshProviderTypeOpt(value: unknown): "projectRefreshProvider" | "ciTestAuth" | undefined {
  if (value === "projectRefreshProvider" || value === "ciTestAuth") return value;
  return undefined;
}
