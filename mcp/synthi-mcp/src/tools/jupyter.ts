import { readExternalConfig, type ExternalConfig } from "../external/config.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export type FetchLike = typeof fetch;

export interface JupyterToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const LIST_TOOL = "synthi_jupyter_list_servers";
const TEST_TOOL = "synthi_jupyter_test_server";
const SNAPSHOT_TOOL = "synthi_jupyter_snapshot_notebook";
const EXECUTE_TOOL = "synthi_jupyter_execute_cells";
const SAVE_TOOL = "synthi_jupyter_save_notebook";
const INTERRUPT_TOOL = "synthi_jupyter_interrupt_kernel";
const RESTART_TOOL = "synthi_jupyter_restart_kernel";

const SLUG_PROP = { type: "string", description: "Workspace slug. Defaults to SYNTHI_WORKSPACE_SLUG." } as const;
const SERVER_PROP = { type: "string", description: "Registered Jupyter server id from synthi_jupyter_list_servers." } as const;
const NOTEBOOK_PATH_PROP = { type: "string", description: "Notebook path ending in .ipynb." } as const;

export const JUPYTER_TOOLS: JupyterToolDescriptor[] = [
  { name: LIST_TOOL, description: "List registered Jupyter servers for the workspace. Connection tokens are never returned; register or update a server in the workspace UI.", inputSchema: { type: "object", properties: { workspaceSlug: SLUG_PROP } } },
  { name: TEST_TOOL, description: "Test a registered Jupyter server's availability without exposing its token.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, workspaceSlug: SLUG_PROP }, required: ["serverId"] } },
  { name: SNAPSHOT_TOOL, description: "Read a notebook snapshot and its server revision from a registered Jupyter server.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, path: NOTEBOOK_PATH_PROP, workspaceSlug: SLUG_PROP }, required: ["serverId", "path"] } },
  { name: EXECUTE_TOOL, description: "Execute bounded code in a notebook kernel on a registered Jupyter server. Requires workspace write access.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, path: NOTEBOOK_PATH_PROP, code: { type: "string", description: "Cell code to execute (at most 100,000 characters)." }, kernelName: { type: "string", description: "Optional Jupyter kernel name." }, workspaceSlug: SLUG_PROP }, required: ["serverId", "path", "code"] } },
  { name: SAVE_TOOL, description: "Save a complete notebook to a registered Jupyter server. Supply expectedServerRevision to avoid overwriting a newer remote revision.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, path: NOTEBOOK_PATH_PROP, notebook: { type: "object", description: "Notebook JSON content." }, expectedServerRevision: { type: "string", description: "Optional server revision returned by synthi_jupyter_snapshot_notebook." }, workspaceSlug: SLUG_PROP }, required: ["serverId", "path", "notebook"] } },
  { name: INTERRUPT_TOOL, description: "Interrupt a known Jupyter kernel belonging to a registered workspace server. Requires workspace write access.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, kernelId: { type: "string", description: "Kernel id returned by synthi_jupyter_execute_cells." }, path: NOTEBOOK_PATH_PROP, workspaceSlug: SLUG_PROP }, required: ["serverId", "kernelId"] } },
  { name: RESTART_TOOL, description: "Restart a known Jupyter kernel belonging to a registered workspace server. Requires workspace write access.", inputSchema: { type: "object", properties: { serverId: SERVER_PROP, kernelId: { type: "string", description: "Kernel id returned by synthi_jupyter_execute_cells." }, path: NOTEBOOK_PATH_PROP, workspaceSlug: SLUG_PROP }, required: ["serverId", "kernelId"] } },
];

const NAMES = new Set(JUPYTER_TOOLS.map((tool) => tool.name));
type Args = Record<string, unknown>;

export function isJupyterToolName(name: string): boolean { return NAMES.has(name); }

function slug(args: Args, configured?: string): string | null {
  const value = typeof args.workspaceSlug === "string" ? args.workspaceSlug.trim() : "";
  return value || configured || null;
}

async function responseJson(response: Response): Promise<Args> {
  try { return await response.json() as Args; } catch { return {}; }
}

function errorFromBackend(response: Response, data: Args, fallback: string): ToolResponse {
  return errorResponse(typeof data.error === "string" ? data.error : `${fallback}_${response.status}`, {
    status: response.status,
    ...(typeof data.message === "string" ? { message: data.message } : {}),
  });
}

function requireText(args: Args, key: string, code: string): string | ToolResponse {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  return value || errorResponse(code, { hint: `Pass a non-empty ${key}.` });
}

async function get(cfg: ExternalConfig, fetchImpl: FetchLike, query: URLSearchParams, fallback: string): Promise<ToolResponse> {
  const response = await fetchImpl(`${cfg.apiUrl}/api/integrations/mcp/jupyter?${query.toString()}`, { headers: { authorization: `Bearer ${cfg.pat}` } });
  const data = await responseJson(response);
  return response.ok ? jsonResponse(data) : errorFromBackend(response, data, fallback);
}

async function post(cfg: ExternalConfig, fetchImpl: FetchLike, body: Args, fallback: string): Promise<ToolResponse> {
  const response = await fetchImpl(`${cfg.apiUrl}/api/integrations/mcp/jupyter`, { method: "POST", headers: { authorization: `Bearer ${cfg.pat}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await responseJson(response);
  return response.ok ? jsonResponse(data) : errorFromBackend(response, data, fallback);
}

export async function dispatchJupyterTool(
  toolName: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch: FetchLike } = { fetch: globalThis.fetch },
): Promise<ToolResponse | null> {
  if (!isJupyterToolName(toolName)) return null;
  const config = readExternalConfig(env);
  if (!config) return errorResponse("not_configured", { hint: "Set SYNTHI_API_URL and SYNTHI_PAT to enable Jupyter tools." });
  const input = (args ?? {}) as Args;
  const workspaceSlug = slug(input, config.workspaceSlug);
  if (!workspaceSlug) return errorResponse("workspace_required", { hint: "Pass workspaceSlug or set SYNTHI_WORKSPACE_SLUG." });

  const serverId = () => requireText(input, "serverId", "server_required");
  const path = () => requireText(input, "path", "notebook_path_required");
  try {
    if (toolName === LIST_TOOL) return get(config, deps.fetch, new URLSearchParams({ workspaceSlug }), "list_failed");
    if (toolName === SNAPSHOT_TOOL) {
      const id = serverId(); const notebook = path();
      if (typeof id !== "string") return id; if (typeof notebook !== "string") return notebook;
      return get(config, deps.fetch, new URLSearchParams({ operation: "snapshot", workspaceSlug, serverId: id, path: notebook }), "snapshot_failed");
    }
    const id = serverId();
    if (typeof id !== "string") return id;
    if (toolName === TEST_TOOL) return post(config, deps.fetch, { operation: "test", workspaceSlug, serverId: id }, "test_failed");
    if (toolName === EXECUTE_TOOL) {
      const notebook = path(); const code = requireText(input, "code", "code_required");
      if (typeof notebook !== "string") return notebook; if (typeof code !== "string") return code;
      return post(config, deps.fetch, { operation: "execute", workspaceSlug, serverId: id, path: notebook, code, ...(typeof input.kernelName === "string" ? { kernelName: input.kernelName } : {}) }, "execute_failed");
    }
    if (toolName === SAVE_TOOL) {
      const notebook = path();
      if (typeof notebook !== "string") return notebook;
      if (!input.notebook || typeof input.notebook !== "object") return errorResponse("notebook_required", { hint: "Pass notebook JSON." });
      return post(config, deps.fetch, { operation: "save", workspaceSlug, serverId: id, path: notebook, notebook: input.notebook, ...(typeof input.expectedServerRevision === "string" ? { expectedServerRevision: input.expectedServerRevision } : {}) }, "save_failed");
    }
    const kernelId = requireText(input, "kernelId", "kernel_required");
    if (typeof kernelId !== "string") return kernelId;
    return post(config, deps.fetch, { operation: toolName === INTERRUPT_TOOL ? "interrupt" : "restart", workspaceSlug, serverId: id, kernelId, ...(typeof input.path === "string" ? { path: input.path } : {}) }, "kernel_failed");
  } catch (exception) {
    return errorFromException("jupyter_tool_failed", exception);
  }
}
