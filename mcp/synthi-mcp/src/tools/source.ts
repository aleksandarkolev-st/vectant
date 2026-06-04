import {
  SOURCE_IDENTITY_ATTR,
  sourceIdentityRegistry,
} from "../browser/source_identity.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const SOURCE_TOOL_NAMES = [
  "synthi_source_lookup_token",
  "synthi_source_get_mapping_status",
  "synthi_source_suggest_affordance_patch",
] as const;

export const SOURCE_TOOLS = [
  {
    name: "synthi_source_lookup_token",
    description:
      "Resolve a data-synthi-source-id token to workspace source metadata. Returns only workspace file, line, column, tag, adapter, and transform metadata.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The data-synthi-source-id token observed in a taught workflow step." },
        workspace_id: { type: "string", description: "Optional workspace scope. Defaults to the active/default workspace." },
      },
      required: ["token"],
    },
  },
  {
    name: "synthi_source_get_mapping_status",
    description:
      "Return workspace source identity mapping coverage: file count, token count, transform versions, and mapped files.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Optional workspace scope. Defaults to the active/default workspace." },
      },
      required: [],
    },
  },
  {
    name: "synthi_source_suggest_affordance_patch",
    description:
      "Suggest a stable JSX attribute for an unresolved workflow target or mutation boundary. The response intentionally does not ask users for local file paths.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Human-readable target label from the taught step." },
        kind: { type: "string", enum: ["affordance", "testId", "mutationBoundary"], default: "affordance" },
        step_id: { type: "string", description: "Optional workflow step id that needs the affordance." },
      },
      required: ["label"],
    },
  },
] as const;

export async function dispatchSourceTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  try {
    switch (toolName) {
      case "synthi_source_lookup_token":
        return lookupTokenTool(args);
      case "synthi_source_get_mapping_status":
        return mappingStatusTool(args);
      case "synthi_source_suggest_affordance_patch":
        return suggestAffordancePatchTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("source_tool_failed", err);
  }
}

function lookupTokenTool(args: unknown): ToolResponse {
  const a = obj(args);
  const token = requiredString(a, "token");
  const workspaceId = stringOpt(a["workspace_id"]);
  const mapping = sourceIdentityRegistry.lookup(token, workspaceId);
  if (!mapping) {
    return errorResponse("source_token_not_found", {
      token,
      mapping_status: sourceIdentityRegistry.status(workspaceId),
      next_action: "run_with_source_identity_transform_or_add_affordance",
    });
  }
  return jsonResponse({
    ok: true,
    source: mapping,
  });
}

function mappingStatusTool(args: unknown): ToolResponse {
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  return jsonResponse({
    ok: true,
    mapping_status: sourceIdentityRegistry.status(workspaceId),
  });
}

function suggestAffordancePatchTool(args: unknown): ToolResponse {
  const a = obj(args);
  const label = requiredString(a, "label");
  const kind = affordanceKind(a["kind"]);
  const suggestion = sourceAffordanceSuggestion(label, kind);
  return jsonResponse({
    ok: true,
    patch: {
      step_id: stringOpt(a["step_id"]) ?? null,
      label,
      kind,
      attr_name: suggestion.attrName,
      attr_value: suggestion.attrValue,
      suggested_attribute: `${suggestion.attrName}="${suggestion.attrValue}"`,
      source_identity_attribute: SOURCE_IDENTITY_ATTR,
      note: "Apply this to the relevant intrinsic JSX element in the workspace; the source identity transform will map it without local browser or PC access.",
    },
  });
}

function sourceAffordanceSuggestion(label: string, kind: "affordance" | "testId" | "mutationBoundary"): { attrName: string; attrValue: string } {
  const slug = slugify(label);
  if (kind === "testId") {
    return { attrName: "data-testid", attrValue: `synthi-${slug.replace(/\./g, "-")}` };
  }
  if (kind === "mutationBoundary") {
    return { attrName: "data-synthi-mutation-boundary", attrValue: slug };
  }
  return { attrName: "data-synthi-affordance", attrValue: slug };
}

function obj(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`missing_${field}`);
  return value.trim();
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function affordanceKind(value: unknown): "affordance" | "testId" | "mutationBoundary" {
  if (value === "testId" || value === "mutationBoundary") return value;
  return "affordance";
}

function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return slug || "target";
}
