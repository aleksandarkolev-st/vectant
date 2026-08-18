import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

type Args = Record<string, unknown>;
type FetchLike = typeof fetch;

const DEFINITIONS = {
  synthi_failure_observations_list: ["GET", "/heal/agentic/distill/observations", ["workspaceRef"]],
  synthi_failure_observation_capture: ["POST", "/heal/agentic/distill/observations", ["workspaceRef", "observation"]],
  synthi_failure_distill: ["POST", "/heal/agentic/distill", ["workspaceRef", "command", "isolation"]],
  synthi_failure_capsule_replay: ["POST", "/heal/agentic/distill/run", ["workspaceRef", "capsuleId"]],
  synthi_failure_capsule_explain: ["POST", "/heal/agentic/distill/explain", ["workspaceRef", "capsuleId", "unit"]],
  synthi_failure_capsule_materialize: ["POST", "/heal/agentic/distill/materialize", ["workspaceRef", "capsuleId"]],
  synthi_failure_capsule_validate_patch: ["POST", "/heal/agentic/distill/validate-patch", ["workspaceRef", "capsuleId", "edits"]],
  synthi_failure_capsule_request_apply: ["POST", "/heal/agentic/distill/request-apply", ["workspaceRef", "capsuleId"]],
  synthi_failure_capsule_apply_approved: ["POST", "/heal/agentic/distill/apply-approved", ["workspaceRef", "capsuleId", "approvalId"]],
  synthi_failure_capsule_export_vivarium: ["POST", "/heal/agentic/distill/vivarium-export", ["workspaceRef", "capsuleId"]],
  synthi_failure_capsule_promote_vivarium: ["POST", "/heal/agentic/distill/vivarium-promote", ["workspaceRef", "capsuleId"]],
} as const;

type ToolName = keyof typeof DEFINITIONS;

export const FAILURE_DISTILLER_TOOLS = (Object.keys(DEFINITIONS) as ToolName[]).map((name) => ({
  name,
  description: `${name.replace("synthi_failure_", "").replaceAll("_", " ")}. This tool is workspace-scoped and preserves Failure Distiller evidence, isolation, and approval gates.`,
  inputSchema: { type: "object", properties: schemaProperties(), required: DEFINITIONS[name][2] },
}));

export async function dispatchFailureDistillerTool(toolName: string, args: unknown, env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = globalThis.fetch): Promise<ToolResponse | null> {
  if (!(toolName in DEFINITIONS)) return null;
  const [method, path, required] = DEFINITIONS[toolName as ToolName];
  const body = asObject(args);
  if (required.some((key) => !present(body[key]))) return errorResponse("invalid_arguments", { required });
  const baseUrl = env["AI_BACKEND_URL"]?.replace(/\/$/, "");
  if (!baseUrl) return errorResponse("failure_distiller_not_configured", { hint: "Set AI_BACKEND_URL for this MCP process." });
  try {
    const url = new URL(path, baseUrl);
    if (method === "GET") url.searchParams.set("workspace_ref", String(body["workspaceRef"]));
    const response = await fetchImpl(url, method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})) as Args;
    return response.ok ? jsonResponse(data) : errorResponse(typeof data["detail"] === "string" ? data["detail"] : "failure_distiller_request_failed", { status: response.status });
  } catch (error) {
    return errorFromException("failure_distiller_request_failed", error);
  }
}

function present(value: unknown): boolean { return value !== undefined && value !== null && value !== ""; }
function asObject(value: unknown): Args { return value && typeof value === "object" && !Array.isArray(value) ? value as Args : {}; }
function schemaProperties(): Record<string, unknown> {
  return {
    workspaceRef: { type: "string", description: "Opaque active workspace reference." }, capsuleId: { type: "string", description: "Opaque capsule ID returned by synthi_failure_distill." },
    observationRef: { type: "string" }, observation: { type: "object", additionalProperties: true }, command: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    isolation: { type: "object", additionalProperties: true }, signature: { type: "object", additionalProperties: true }, budget: { type: "object", additionalProperties: true },
    edits: { type: "array", items: { type: "object", additionalProperties: true } }, unit: { type: "string" }, approvalId: { type: "string" }, mode: { type: "string", enum: ["regression", "practice"] },
  };
}
