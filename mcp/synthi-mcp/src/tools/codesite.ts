import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const CODESITE_TOOL_NAMES = [
  "synthi_codesite_file_flight_plan",
  "synthi_codesite_request_clearance",
  "synthi_codesite_open_transaction",
  "synthi_codesite_get_transaction_status",
  "synthi_codesite_preview_transaction",
  "synthi_codesite_dry_run_patch",
  "synthi_codesite_record_assumption",
  "synthi_codesite_record_read",
  "synthi_codesite_record_write",
  "synthi_codesite_validate_transaction",
  "synthi_codesite_request_commit",
  "synthi_codesite_get_source_state_since",
  "synthi_codesite_get_radar",
  "synthi_codesite_next_event",
  "synthi_codesite_ack_event",
  "synthi_codesite_predict_collision",
  "synthi_codesite_shadow_merge_simulate",
  "synthi_codesite_report_counterfactual_run",
  "synthi_codesite_file_rfi",
  "synthi_codesite_file_change_order",
  "synthi_codesite_declare_mayday",
  "synthi_codesite_request_landing",
  "synthi_codesite_generate_black_box",
  "synthi_codesite_get_line_provenance",
] as const;

type CodeSiteToolName = (typeof CODESITE_TOOL_NAMES)[number];

type JsonObject = Record<string, unknown>;

interface CodeSiteRequest {
  method: "GET" | "POST";
  path: string;
  body?: JsonObject;
  query?: Record<string, string>;
}

const CONTROL_ARG_KEYS = new Set([
  "agent_session_id",
  "auth_token",
  "base_url",
  "body",
  "bundle_id",
  "codesite_api_base_url",
  "cookie",
  "event_id",
  "execution_plan_id",
  "file_path",
  "incident_id",
  "line_anchor",
  "mutation_lease_id",
  "path",
  "project_id",
  "since",
  "transaction_id",
  "workspace_slug",
]);

const COMMON_PROPERTIES = {
  base_url: {
    type: "string",
    description: "Synthi app origin. Defaults to SYNTHI_CODESITE_BASE_URL, SYNTHI_APP_URL, or http://127.0.0.1:3000.",
  },
  codesite_api_base_url: {
    type: "string",
    description: "Optional full /api/workspace/:slug/codesite base URL. Supports {workspace_slug}.",
  },
  workspace_slug: {
    type: "string",
    description: "Workspace slug. Defaults to SYNTHI_CODESITE_WORKSPACE or SYNTHI_WORKSPACE_SLUG.",
  },
  project_id: {
    type: "string",
    description: "CodeSite project id. Defaults to SYNTHI_CODESITE_PROJECT_ID where relevant.",
  },
  auth_token: {
    type: "string",
    description: "Optional bearer token. Defaults to SYNTHI_CODESITE_TOKEN.",
  },
  cookie: {
    type: "string",
    description: "Optional Cookie header. Defaults to SYNTHI_CODESITE_COOKIE.",
  },
  body: {
    type: "object",
    description: "Raw control-plane payload. Convenience top-level fields are merged into this payload.",
  },
} as const;

export const CODESITE_TOOLS = [
  codeSiteTool("synthi_codesite_file_flight_plan", "File an ATC flight plan by creating a CodeSite execution plan.", {
    agent_session_id: { type: "string" },
    route: { type: "array", items: { type: "string" } },
    mission: { type: "string" },
    status: { type: "string" },
  }, ["agent_session_id"]),
  codeSiteTool("synthi_codesite_request_clearance", "Request a path/tool scoped MutationLease from an execution plan.", {
    execution_plan_id: { type: "string" },
    allowedPaths: { type: "array", items: { type: "string" } },
    allowedTools: { type: "array", items: { type: "string" } },
    expiresAt: { type: "string" },
  }, ["execution_plan_id"]),
  codeSiteTool("synthi_codesite_open_transaction", "Open a serializable MutationTransaction under an active clearance.", {
    mutation_lease_id: { type: "string" },
    readSet: { type: "array", items: { type: "string" } },
    writeSet: { type: "array", items: { type: "string" } },
    isolation: { type: "string" },
  }, ["mutation_lease_id"]),
  codeSiteTool("synthi_codesite_get_transaction_status", "Read the current transaction status and validation decision.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_preview_transaction", "Preview transaction validation without committing.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_dry_run_patch", "Dry-run a patch file list against CodeSite mutation policy.", {
    transaction_id: { type: "string" },
    files: { type: "array", items: { type: "object" } },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_record_assumption", "Record an assumption lease used by a transaction.", {
    transaction_id: { type: "string" },
    assumptionKey: { type: "string" },
    dependsOn: { type: "array", items: {} },
    usedBy: { type: "array", items: {} },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_record_read", "Record a transaction read-set path.", {
    transaction_id: { type: "string" },
    path: { type: "string" },
    file_path: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_record_write", "Record and policy-check a transaction write-set path.", {
    transaction_id: { type: "string" },
    path: { type: "string" },
    file_path: { type: "string" },
    tool: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_validate_transaction", "Run serializable validation for an open transaction.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_request_commit", "Request a proof-carrying commit for a validated transaction.", {
    transaction_id: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    commitSha: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_get_source_state_since", "Read source-state validation for the transaction's base snapshot.", {
    transaction_id: { type: "string" },
  }, ["transaction_id"]),
  codeSiteTool("synthi_codesite_get_radar", "Read machine-readable CodeSite radar/control state.", {}, []),
  codeSiteTool("synthi_codesite_next_event", "Poll the next CodeSite event after an optional event id.", {
    since: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_ack_event", "Acknowledge an inbox event for an agent session.", {
    agent_session_id: { type: "string" },
    event_id: { type: "string" },
  }, ["agent_session_id", "event_id"]),
  codeSiteTool("synthi_codesite_predict_collision", "Predict route/lease collisions for the project.", {}, []),
  codeSiteTool("synthi_codesite_shadow_merge_simulate", "Run the shadow merge strategy simulator.", {
    strategies: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_report_counterfactual_run", "Record a counterfactual ATC memory run.", {
    universes: { type: "array", items: { type: "object" } },
    outcome: { type: "object" },
  }, []),
  codeSiteTool("synthi_codesite_file_rfi", "File a tower-mediated request for information document.", {
    title: { type: "string" },
    toSessionId: { type: "string" },
    requiresResponse: { type: "boolean" },
  }, []),
  codeSiteTool("synthi_codesite_file_change_order", "File a tower-mediated change-order document.", {
    title: { type: "string" },
    toSessionId: { type: "string" },
    blocking: { type: "boolean" },
  }, []),
  codeSiteTool("synthi_codesite_declare_mayday", "Declare a mayday incident and record replay evidence.", {
    severity: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    affectedZones: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_request_landing", "Request a landing inspection run for changed paths.", {
    executionPlanId: { type: "string" },
    changedPaths: { type: "array", items: { type: "string" } },
    callsign: { type: "string" },
  }, []),
  codeSiteTool("synthi_codesite_generate_black_box", "Generate/export the repo-local CodeSite black-box artifact projection.", {}, []),
  codeSiteTool("synthi_codesite_get_line_provenance", "Read causal line provenance for a workspace file and optional anchor.", {
    file_path: { type: "string" },
    line_anchor: { type: "string" },
  }, ["file_path"]),
] as const;

export async function dispatchCodeSiteTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  if (!isCodeSiteToolName(toolName)) return null;
  try {
    const input = objectArg(args);
    const request = buildCodeSiteRequest(toolName, input);
    if (!request) return errorResponse("codesite_tool_not_implemented", { tool: toolName });
    const response = await callCodeSite(input, request);
    if (!("data" in response)) return response;
    if (toolName === "synthi_codesite_next_event") {
      const events = Array.isArray(response.data["events"]) ? response.data["events"] : [];
      return jsonResponse({
        ok: true,
        tool: toolName,
        next_event: events[0] ?? null,
        event_count: events.length,
        request: response.request,
      });
    }
    return jsonResponse({
      ok: true,
      tool: toolName,
      request: response.request,
      response: response.data,
    });
  } catch (err) {
    return errorFromException("codesite_tool_failed", err);
  }
}

function codeSiteTool(
  name: CodeSiteToolName,
  description: string,
  properties: JsonObject,
  required: string[]
): { name: CodeSiteToolName; description: string; inputSchema: JsonObject } {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPERTIES,
        ...properties,
      },
      required,
    },
  };
}

function buildCodeSiteRequest(toolName: CodeSiteToolName, args: JsonObject): CodeSiteRequest | null {
  switch (toolName) {
    case "synthi_codesite_file_flight_plan":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/execution-plans`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_request_clearance":
      return {
        method: "POST",
        path: `/execution-plans/${encodeURIComponent(requiredString(args, "execution_plan_id"))}/mutation-leases`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_open_transaction":
      return {
        method: "POST",
        path: `/mutation-leases/${encodeURIComponent(requiredString(args, "mutation_lease_id"))}/transactions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_transaction_status":
      return {
        method: "GET",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/status`,
      };
    case "synthi_codesite_preview_transaction":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/preview`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_dry_run_patch":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/dry-run-patch`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_record_assumption":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/assumptions`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_record_read":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/record-read`,
        body: bodyFromArgs(args, pathOverlay(args)),
      };
    case "synthi_codesite_record_write":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/record-write`,
        body: bodyFromArgs(args, pathOverlay(args)),
      };
    case "synthi_codesite_validate_transaction":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/validate`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_request_commit":
      return {
        method: "POST",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/commit`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_source_state_since":
      return {
        method: "GET",
        path: `/transactions/${encodeURIComponent(requiredString(args, "transaction_id"))}/source-state-since`,
      };
    case "synthi_codesite_get_radar":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/control-state`,
      };
    case "synthi_codesite_next_event":
      return {
        method: "GET",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/events`,
        query: optionalString(args["since"]) ? { since: optionalString(args["since"]) as string } : undefined,
      };
    case "synthi_codesite_ack_event":
      return {
        method: "POST",
        path: `/agent-sessions/${encodeURIComponent(requiredString(args, "agent_session_id"))}/inbox/${encodeURIComponent(requiredString(args, "event_id"))}/ack`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_predict_collision":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/collision-predict`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_shadow_merge_simulate":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/shadow-merge-simulate`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_report_counterfactual_run":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/counterfactual-runs`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_file_rfi":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/documents`,
        body: bodyFromArgs(args, { kind: "rfi" }),
      };
    case "synthi_codesite_file_change_order":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/documents`,
        body: bodyFromArgs(args, { kind: "change_order" }),
      };
    case "synthi_codesite_declare_mayday":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/incidents`,
        body: bodyFromArgs(args, { category: "mayday" }),
      };
    case "synthi_codesite_request_landing":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/inspection-runs`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_generate_black_box":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/artifacts/export`,
        body: bodyFromArgs(args),
      };
    case "synthi_codesite_get_line_provenance":
      return {
        method: "GET",
        path: "/provenance/line",
        query: {
          filePath: requiredString(args, "file_path"),
          ...(optionalString(args["line_anchor"]) ? { lineAnchor: optionalString(args["line_anchor"]) as string } : {}),
        },
      };
  }
}

async function callCodeSite(args: JsonObject, request: CodeSiteRequest): Promise<{
  isError: false;
  data: JsonObject;
  request: JsonObject;
} | ToolResponse> {
  const apiBase = resolveApiBase(args);
  const url = new URL(`${apiBase}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const token = optionalString(args["auth_token"]) ?? envString("SYNTHI_CODESITE_TOKEN");
  const cookie = optionalString(args["cookie"]) ?? envString("SYNTHI_CODESITE_COOKIE");
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (cookie) headers["cookie"] = cookie;
  if (request.body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  const data = parseJsonObject(text);
  const requestSummary = {
    method: request.method,
    path: request.path,
    url: url.toString(),
  };
  if (!response.ok) {
    return errorResponse("codesite_control_plane_request_failed", {
      status: response.status,
      request: requestSummary,
      response: data,
    });
  }
  return { isError: false, data, request: requestSummary };
}

function resolveApiBase(args: JsonObject): string {
  const workspaceSlug = encodeURIComponent(requiredWorkspaceSlug(args));
  const explicit = optionalString(args["codesite_api_base_url"]) ?? envString("SYNTHI_CODESITE_API_BASE_URL");
  if (explicit) {
    return trimTrailingSlash(explicit.replace("{workspace_slug}", workspaceSlug));
  }
  const origin = trimTrailingSlash(
    optionalString(args["base_url"]) ??
      envString("SYNTHI_CODESITE_BASE_URL") ??
      envString("SYNTHI_APP_URL") ??
      "http://127.0.0.1:3000"
  );
  return `${origin}/api/workspace/${workspaceSlug}/codesite`;
}

function requiredWorkspaceSlug(args: JsonObject): string {
  const value = optionalString(args["workspace_slug"]) ?? envString("SYNTHI_CODESITE_WORKSPACE") ?? envString("SYNTHI_WORKSPACE_SLUG");
  if (!value) throw new Error("missing_workspace_slug");
  return value;
}

function requiredProjectId(args: JsonObject): string {
  const value = optionalString(args["project_id"]) ?? envString("SYNTHI_CODESITE_PROJECT_ID");
  if (!value) throw new Error("missing_project_id");
  return value;
}

function bodyFromArgs(args: JsonObject, overlay: JsonObject = {}): JsonObject {
  const rawBody = objectOpt(args["body"]);
  const forwarded: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (CONTROL_ARG_KEYS.has(key) || value === undefined) continue;
    forwarded[key] = value;
  }
  return { ...forwarded, ...rawBody, ...overlay };
}

function pathOverlay(args: JsonObject): JsonObject {
  const path = optionalString(args["path"]) ?? optionalString(args["file_path"]);
  return path ? { path } : {};
}

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    return { value: parsed };
  } catch {
    return { text };
  }
}

function isCodeSiteToolName(toolName: string): toolName is CodeSiteToolName {
  return (CODESITE_TOOL_NAMES as readonly string[]).includes(toolName);
}

function objectArg(args: unknown): JsonObject {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return args as JsonObject;
}

function objectOpt(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function requiredString(args: JsonObject, field: string): string {
  const value = optionalString(args[field]);
  if (!value) throw new Error(`missing_${field}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function envString(name: string): string | undefined {
  return optionalString(process.env[name]);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
