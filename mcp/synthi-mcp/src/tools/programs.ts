import { readExternalConfig, type ExternalConfig } from "../external/config.js";
import { jsonResponse, errorResponse, errorFromException, type ToolResponse } from "./shared.js";

/**
 * Program command-control tools (GUI dev-tool streaming, Slice 3 / Group E).
 *
 * These expose the workspace program domain to the external AI over the
 * PAT-gated `/api/integrations/mcp/*` boundary — the same auth surface the
 * external-MCP hub uses (SYNTHI_API_URL + SYNTHI_PAT [+ SYNTHI_WORKSPACE_SLUG]).
 * Commands run in the per-workspace runtime sandbox (where docker and the
 * workspace's programs live); the backend enforces owner/admin scope and an
 * existing `program.launch` consent grant. Default off when unconfigured.
 */

export type FetchLike = typeof fetch;

export interface ProgramToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const EXEC_TOOL = "synthi_exec_in_runtime";

export const PROGRAM_TOOLS: ProgramToolDescriptor[] = [
  {
    name: EXEC_TOOL,
    description:
      "Run a shell command in the workspace's runtime sandbox — where docker and the workspace's programs run. " +
      "Use for tasks like 'open docker and run all containers' or running database/CLI tools. " +
      "Returns combined output (stdout+stderr merged by the runtime), exitCode, and timedOut. " +
      "Requires the workspace to have granted program.launch consent; returns error 'consent_required' otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run in the workspace runtime." },
        workspaceSlug: {
          type: "string",
          description: "Workspace slug. Defaults to the attached workspace (SYNTHI_WORKSPACE_SLUG).",
        },
        timeout: { type: "number", description: "Optional timeout in ms (capped server-side, max 60000)." },
      },
      required: ["command"],
    },
  },
];

const PROGRAM_TOOL_NAMES = new Set(PROGRAM_TOOLS.map((t) => t.name));

export function isProgramToolName(name: string): boolean {
  return PROGRAM_TOOL_NAMES.has(name);
}

type Args = Record<string, unknown>;

function resolveSlug(args: Args, cfgSlug?: string): string | null {
  const fromArg = typeof args["workspaceSlug"] === "string" ? (args["workspaceSlug"] as string).trim() : "";
  return fromArg || cfgSlug || null;
}

async function readJson(res: Response): Promise<Args> {
  try {
    return (await res.json()) as Args;
  } catch {
    return {};
  }
}

/** Translate a non-2xx backend response into a structured tool error. */
function errorFromResponse(res: Response, data: Args, fallback: string): ToolResponse {
  const code = typeof data["error"] === "string" ? (data["error"] as string) : `${fallback}_${res.status}`;
  return errorResponse(code, {
    status: res.status,
    ...(data["message"] ? { message: data["message"] } : {}),
  });
}

async function execInRuntime(
  args: Args,
  slug: string,
  cfg: ExternalConfig,
  fetchImpl: FetchLike,
): Promise<ToolResponse> {
  const command = typeof args["command"] === "string" ? (args["command"] as string).trim() : "";
  if (!command) return errorResponse("command_required", { hint: "Pass a non-empty command." });

  const body: Args = { workspaceSlug: slug, command };
  if (typeof args["timeout"] === "number") body["timeout"] = args["timeout"];

  const res = await fetchImpl(`${cfg.apiUrl}/api/integrations/mcp/runtime-exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.pat}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) return errorFromResponse(res, data, "exec_failed");

  return jsonResponse({
    sessionId: data["sessionId"] ?? null,
    output: data["output"] ?? "",
    exitCode: data["exitCode"] ?? null,
    timedOut: Boolean(data["timedOut"]),
  });
}

/**
 * Dispatch a program command-control tool. Returns null when `toolName` is not a
 * program tool (so the server's switch can fall through), else a ToolResponse.
 */
export async function dispatchProgramTool(
  toolName: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch: FetchLike } = { fetch: globalThis.fetch },
): Promise<ToolResponse | null> {
  if (!isProgramToolName(toolName)) return null;

  const a = (args ?? {}) as Args;
  const cfg = readExternalConfig(env);
  if (!cfg) {
    return errorResponse("not_configured", {
      hint: "Set SYNTHI_API_URL and SYNTHI_PAT to enable program tools.",
    });
  }
  const slug = resolveSlug(a, cfg.workspaceSlug);
  if (!slug) {
    return errorResponse("workspace_required", { hint: "Pass workspaceSlug or set SYNTHI_WORKSPACE_SLUG." });
  }

  try {
    switch (toolName) {
      case EXEC_TOOL:
        return await execInRuntime(a, slug, cfg, deps.fetch);
      default:
        return null;
    }
  } catch (e) {
    return errorFromException("program_tool_failed", e);
  }
}
