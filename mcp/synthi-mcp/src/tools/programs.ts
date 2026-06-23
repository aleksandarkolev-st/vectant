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
const LIST_TOOL = "synthi_list_programs";
const READ_TOOL = "synthi_read_session";
const LAUNCH_TOOL = "synthi_launch_program";

const SLUG_PROP = {
  type: "string",
  description: "Workspace slug. Defaults to the attached workspace (SYNTHI_WORKSPACE_SLUG).",
} as const;

export const PROGRAM_TOOLS: ProgramToolDescriptor[] = [
  {
    name: EXEC_TOOL,
    description:
      "Run a shell command inside the workspace's Sysbox runtime — where the workspace's own docker and its " +
      "programs run. Use for tasks like 'open docker and run all containers' or running database/CLI tools. " +
      "Returns stdout, stderr, exitCode, and timedOut. Requires the workspace to have granted program.launch " +
      "consent (returns error 'consent_required' otherwise) and a ready runtime (else 'runtime_pod_not_ready').",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run in the workspace runtime." },
        workspaceSlug: SLUG_PROP,
        timeout: { type: "number", description: "Optional timeout in ms (capped server-side, max 60000)." },
      },
      required: ["command"],
    },
  },
  {
    name: LIST_TOOL,
    description:
      "List the workspace's programs: running/recent program sessions (with state and active ports) and " +
      "installed programs (the catalog the workspace can launch). Use to discover what is running or available " +
      "before running commands against it.",
    inputSchema: {
      type: "object",
      properties: { workspaceSlug: SLUG_PROP },
    },
  },
  {
    name: READ_TOOL,
    description:
      "Read a single program session's current state plus its recent (redacted) runtime events/logs. " +
      "Use to check whether a program started, crashed, or what it reported.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The program session id to read." },
        workspaceSlug: SLUG_PROP,
      },
      required: ["sessionId"],
    },
  },
  {
    name: LAUNCH_TOOL,
    description:
      "Launch an installed program by its install id (from synthi_list_programs → installed[].id). " +
      "Use to open a containerized dev tool — e.g. 'manage my database' → launch the DBeaver program. " +
      "Only container programs are launchable this way (others must be launched from the workspace UI); " +
      "returns the new program session. Requires owner/admin + program.launch consent.",
    inputSchema: {
      type: "object",
      properties: {
        installId: { type: "string", description: "The installed-program id to launch (see synthi_list_programs)." },
        workspaceSlug: SLUG_PROP,
      },
      required: ["installId"],
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
    stdout: data["stdout"] ?? "",
    stderr: data["stderr"] ?? "",
    exitCode: data["exitCode"] ?? null,
    timedOut: Boolean(data["timedOut"]),
    runtimeScope: data["runtimeScope"] ?? null,
  });
}

async function getJson(
  url: string,
  cfg: ExternalConfig,
  fetchImpl: FetchLike,
  fallback: string,
): Promise<ToolResponse> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${cfg.pat}` },
  });
  const data = await readJson(res);
  if (!res.ok) return errorFromResponse(res, data, fallback);
  return jsonResponse(data);
}

function listPrograms(slug: string, cfg: ExternalConfig, fetchImpl: FetchLike): Promise<ToolResponse> {
  const url = `${cfg.apiUrl}/api/integrations/mcp/programs?workspaceSlug=${encodeURIComponent(slug)}`;
  return getJson(url, cfg, fetchImpl, "list_failed");
}

function readSession(
  args: Args,
  slug: string,
  cfg: ExternalConfig,
  fetchImpl: FetchLike,
): Promise<ToolResponse> {
  const sessionId = typeof args["sessionId"] === "string" ? (args["sessionId"] as string).trim() : "";
  if (!sessionId) return Promise.resolve(errorResponse("session_required", { hint: "Pass a sessionId." }));
  const url = `${cfg.apiUrl}/api/integrations/mcp/programs/${encodeURIComponent(sessionId)}?workspaceSlug=${encodeURIComponent(slug)}`;
  return getJson(url, cfg, fetchImpl, "read_failed");
}

async function launchProgram(
  args: Args,
  slug: string,
  cfg: ExternalConfig,
  fetchImpl: FetchLike,
): Promise<ToolResponse> {
  const installId = typeof args["installId"] === "string" ? (args["installId"] as string).trim() : "";
  if (!installId) return errorResponse("install_required", { hint: "Pass an installId (see synthi_list_programs)." });

  const res = await fetchImpl(`${cfg.apiUrl}/api/integrations/mcp/programs/launch`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.pat}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceSlug: slug, installId }),
  });
  const data = await readJson(res);
  if (!res.ok) return errorFromResponse(res, data, "launch_failed");
  return jsonResponse({ session: data["session"] ?? null });
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
      case LIST_TOOL:
        return await listPrograms(slug, cfg, deps.fetch);
      case READ_TOOL:
        return await readSession(a, slug, cfg, deps.fetch);
      case LAUNCH_TOOL:
        return await launchProgram(a, slug, cfg, deps.fetch);
      default:
        return null;
    }
  } catch (e) {
    return errorFromException("program_tool_failed", e);
  }
}
