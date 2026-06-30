import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const CODESITE_TOOL_NAMES = [
  "synthi_codesite_file_flight_plan",
  "synthi_codesite_request_clearance",
  "synthi_codesite_open_transaction",
  "synthi_codesite_get_transaction_status",
  "synthi_codesite_preview_transaction",
  "synthi_codesite_dry_run_patch",
  "synthi_codesite_preflight_write",
  "synthi_codesite_apply_patch",
  "synthi_codesite_record_assumption",
  "synthi_codesite_record_read",
  "synthi_codesite_record_write",
  "synthi_codesite_validate_transaction",
  "synthi_codesite_request_commit",
  "synthi_codesite_get_source_state_since",
  "synthi_codesite_get_radar",
  "synthi_codesite_next_event",
  "synthi_codesite_get_inbox",
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
  "collab_base_url",
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
  "user_id",
  "session_id",
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
  codeSiteTool("synthi_codesite_preflight_write", "Ask CodeSiteFS for a pre-mutation write decision before a terminal, runtime, Yjs, MCP, scaffold, or patch adapter mutates a file.", {
    path: { type: "string" },
    file_path: { type: "string" },
    tool: { type: "string" },
    source: { type: "string" },
    operation: { type: "string" },
    mutation_lease_id: { type: "string" },
    disposition: { type: "string" },
    quarantine: { type: "boolean" },
    processAncestry: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  }, []),
  codeSiteTool("synthi_codesite_apply_patch", "Apply file patches through collab-server write-files-batch after CodeSite transaction dry-run approval.", {
    transaction_id: { type: "string" },
    mutation_lease_id: { type: "string" },
    files: { type: "array", items: { type: "object" } },
    collab_base_url: { type: "string" },
    user_id: { type: "string" },
    session_id: { type: "string" },
    displayCallsign: { type: "string" },
    allowedPaths: { type: "array", items: { type: "string" } },
    blockedPaths: { type: "array", items: { type: "string" } },
    allowedTools: { type: "array", items: { type: "string" } },
  }, ["transaction_id", "files"]),
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
  codeSiteTool("synthi_codesite_get_inbox", "Poll durable tower-routed inbox items for an agent session.", {
    agent_session_id: { type: "string" },
  }, ["agent_session_id"]),
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
    if (toolName === "synthi_codesite_apply_patch") {
      return await dispatchCodeSiteApplyPatch(input);
    }
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
    if (toolName === "synthi_codesite_get_inbox") {
      const inbox = Array.isArray(response.data["inbox"]) ? response.data["inbox"] : [];
      const nextInboxItem = inbox.find((item) => (
        typeof item === "object"
        && item !== null
        && (item as JsonObject)["acknowledgedAt"] == null
      )) ?? inbox[0] ?? null;
      return jsonResponse({
        ok: true,
        tool: toolName,
        next_inbox_item: nextInboxItem,
        inbox_count: inbox.length,
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
    case "synthi_codesite_preflight_write":
      return {
        method: "POST",
        path: `/projects/${encodeURIComponent(requiredProjectId(args))}/codesitefs-events`,
        body: bodyFromArgs(args, {
          ...pathOverlay(args),
          ...(optionalString(args["mutation_lease_id"]) ? { mutationLeaseId: optionalString(args["mutation_lease_id"]) as string } : {}),
        }),
      };
    case "synthi_codesite_apply_patch":
      return null;
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
    case "synthi_codesite_get_inbox":
      return {
        method: "GET",
        path: `/agent-sessions/${encodeURIComponent(requiredString(args, "agent_session_id"))}/inbox`,
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

async function dispatchCodeSiteApplyPatch(args: JsonObject): Promise<ToolResponse> {
  const transactionId = requiredString(args, "transaction_id");
  const files = filePatchList(args["files"]);
  if (!files.length) return errorResponse("codesite_patch_files_required");

  const dryRunRequest: CodeSiteRequest = {
    method: "POST",
    path: `/transactions/${encodeURIComponent(transactionId)}/dry-run-patch`,
    body: { files },
  };
  const dryRun = await callCodeSite(args, dryRunRequest);
  if (!("data" in dryRun)) return dryRun;

  const dryRunResults = Array.isArray(dryRun.data["results"]) ? dryRun.data["results"] : [];
  const denied = dryRunResults.filter((result) => (
    typeof result === "object"
    && result !== null
    && (result as JsonObject)["ok"] === false
  ));
  if (denied.length > 0) {
    return errorResponse("codesite_patch_policy_denied", {
      transaction_id: transactionId,
      denied,
      dry_run: dryRun.data,
      request: dryRun.request,
    });
  }

  const apply = await callCollabWriteFilesBatch(args, files);
  if (!("data" in apply)) return apply;
  return jsonResponse({
    ok: true,
    tool: "synthi_codesite_apply_patch",
    dry_run: dryRun.data,
    apply: apply.data,
    requests: {
      dry_run: dryRun.request,
      apply: apply.request,
    },
  });
}

async function callCollabWriteFilesBatch(args: JsonObject, files: JsonObject[]): Promise<{
  isError: false;
  data: JsonObject;
  request: JsonObject;
} | ToolResponse> {
  const workspaceSlug = requiredWorkspaceSlug(args);
  const transactionId = requiredString(args, "transaction_id");
  const apiBase = resolveApiBase(args);
  const collabBase = trimTrailingSlash(
    optionalString(args["collab_base_url"]) ??
      envString("SYNTHI_COLLAB_BASE_URL") ??
      envString("COLLAB_SERVER_URL") ??
      "http://127.0.0.1:1234"
  );
  const url = new URL(`${collabBase}/git/${encodeURIComponent(workspaceSlug)}/write-files-batch`);
  const token = optionalString(args["auth_token"]) ?? envString("SYNTHI_CODESITE_TOKEN");
  const cookie = optionalString(args["cookie"]) ?? envString("SYNTHI_CODESITE_COOKIE");
  const userId = optionalString(args["user_id"]) ?? envString("SYNTHI_CODESITE_USER_ID");
  const sessionId = optionalString(args["session_id"]) ?? envString("SYNTHI_CODESITE_SESSION_ID");
  const codesite = {
    enforce: true,
    mode: "enforce",
    workspaceSlug,
    transactionId,
    mutationLeaseId: optionalString(args["mutation_lease_id"]) ?? optionalString(args["mutationLeaseId"]),
    displayCallsign: optionalString(args["displayCallsign"]) ?? optionalString(args["callsign"]),
    controlPlaneUrl: apiBase,
    authToken: token,
    cookie,
    allowedPaths: stringListArg(args["allowedPaths"] ?? args["allowed_paths"]),
    blockedPaths: stringListArg(args["blockedPaths"] ?? args["blocked_paths"]),
    allowedTools: stringListArg(args["allowedTools"] ?? args["allowed_tools"]),
    processAncestry: ["mcp:synthi_codesite_apply_patch"],
  };
  const body: JsonObject = {
    files,
    syncToGcs: args["syncToGcs"] !== false && args["sync_to_gcs"] !== false,
    codesite,
    ...(userId ? { userId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-codesite-mode": "enforce",
    "x-codesite-transaction-id": transactionId,
    "x-codesite-control-plane-url": apiBase,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (cookie) headers["cookie"] = cookie;
  if (userId) headers["x-user-id"] = userId;
  if (sessionId) headers["x-session-id"] = sessionId;
  if (codesite.mutationLeaseId) headers["x-codesite-lease-id"] = codesite.mutationLeaseId;
  if (codesite.displayCallsign) headers["x-codesite-callsign"] = codesite.displayCallsign;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = parseJsonObject(text);
  const requestSummary = {
    method: "POST",
    path: `/git/${workspaceSlug}/write-files-batch`,
    url: url.toString(),
  };
  if (!response.ok) {
    return errorResponse("codesite_collab_patch_apply_failed", {
      status: response.status,
      request: requestSummary,
      response: data,
    });
  }
  return { isError: false, data, request: requestSummary };
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

function filePatchList(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item }));
}

function stringListArg(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
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
