import { browserBroker } from "../browser/broker.js";
import { browserBridgeServer } from "../browser/bridge_server.js";
import { attachHostedBrowserRuntime, resolveHostedBrowserRuntime } from "../browser/hosted_runtime.js";
import { browserPlaywrightAdapter } from "../browser/playwright_adapter.js";
import { classifyWorkflowReplayBlock, classifyWorkflowReplayFailure, normalizeReplayMode, type WorkflowReplayModeV7 } from "../browser/workflow.js";
import {
  detectBrowserProject,
  projectRunStatus,
  runBrowserProject,
  stopBrowserProject,
} from "../browser/project_runner.js";
import type { BrowserActionKind } from "../browser/types.js";
import { eventLog } from "../events/index.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const BROWSER_TOOL_NAMES = [
  "synthi_browser_attach_current_workspace",
  "synthi_browser_observe",
  "synthi_browser_begin_teach",
  "synthi_browser_end_teach",
  "synthi_browser_attach",
  "synthi_browser_list_tabs",
  "synthi_browser_select_tab",
  "synthi_browser_open",
  "synthi_browser_request_consent",
  "synthi_browser_get_consent",
  "synthi_browser_revoke_consent",
  "synthi_browser_snapshot",
  "synthi_browser_start_teach",
  "synthi_browser_stop_teach",
  "synthi_browser_get_trace",
  "synthi_browser_get_trace_status",
  "synthi_browser_get_lane0_status",
  "synthi_browser_answer_teach_question",
  "synthi_browser_get_workflow_card",
  "synthi_browser_get_unresolved_steps",
  "synthi_browser_compile_workflow",
  "synthi_browser_generate_script",
  "synthi_browser_run_workflow",
  "synthi_browser_explain_failure",
  "synthi_browser_acquire_lease",
  "synthi_browser_release_lease",
  "synthi_browser_action",
  "synthi_browser_wait",
  "synthi_browser_get_console",
  "synthi_browser_get_network",
  "synthi_browser_detect_project",
  "synthi_browser_run_project",
  "synthi_browser_project_status",
  "synthi_browser_stop_project",
] as const;

export const BROWSER_TOOLS = [
  {
    name: "synthi_browser_attach_current_workspace",
    description:
      "Attach the agent to the Synthi-hosted browser for the current workspace. This is the primary cloud IDE path; it never requires the user to provide local Chrome, local CDP, or a desktop extension.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Optional workspace scope. Defaults to SYNTHI_WORKSPACE_ID or the active/default workspace." },
        workspace_url: { type: "string", description: "Optional workspace URL to open in the hosted runtime. Defaults to SYNTHI_WORKSPACE_URL or SYNTHI_HOSTED_BROWSER_WORKSPACE_URL." },
        runtime_id: { type: "string", description: "Optional hosted runtime id for diagnostics." },
        open_workspace: { type: "boolean", description: "Open the workspace URL in the hosted runtime after attach. Defaults true when a workspace URL is known." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_observe",
    description:
      "Primary observation tool for the selected hosted workspace tab. Returns the broker-gated screenshot and bounded DOM summary only after exact-origin screenshot consent.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_begin_teach",
    description:
      "Primary teach-mode start tool for the selected hosted workspace tab. Uses broker origin consent and records only explicit teaching actions.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        goal: { type: "string", description: "Optional human-readable workflow goal for client-side display." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_end_teach",
    description:
      "Primary teach-mode stop tool. Returns the assembled workflow card and replay/source readiness summary after stopping.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_attach",
    description:
      "Attach to an existing Chrome/Chromium instance over CDP. The broker remains the authority for tab visibility, origin consent, teach mode, leases, redaction, and action filtering.",
    inputSchema: {
      type: "object",
      properties: {
        cdp_url: { type: "string", description: "Chrome DevTools endpoint. Required unless SYNTHI_BROWSER_CDP_URL is set." },
        bridge_host: { type: "string", description: "Host/interface for the local extension bridge to bind. Defaults to SYNTHI_BROWSER_BRIDGE_HOST or loopback." },
        bridge_port: { type: "number", description: "Port for the local extension bridge. Defaults to SYNTHI_BROWSER_BRIDGE_PORT or an ephemeral port." },
        bridge_public_url: { type: "string", description: "URL returned to the extension when bind host/port are not directly reachable, for example across WSL/Windows boundaries." },
        bridge_token: { type: "string", description: "Shared token the extension bridge must present when sending page-origin events." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_list_tabs",
    description: "List authorized Chrome tabs only. Tabs on origins without granted consent are intentionally hidden.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_select_tab",
    description: "Select an authorized tab as the active browser target for snapshot/action/wait tools.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: ["tab_id"],
    },
  },
  {
    name: "synthi_browser_open",
    description: "Open a URL in the attached Chrome session. The URL origin must already have consent.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "synthi_browser_request_consent",
    description:
      "Grant or deny exact-origin consent. Consent does not cross scheme, host, subdomain, or port boundaries. Screenshot and diagnostics access are explicit sub-grants.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        status: { type: "string", enum: ["granted", "denied"], default: "granted" },
        screenshot: { type: "boolean", description: "Allow screenshots and DOM snapshots for this exact origin. Defaults to true when status is granted." },
        diagnostics: { type: "boolean", description: "Allow console and network summaries for this exact origin. Defaults to true when status is granted." },
        reason: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "synthi_browser_get_consent",
    description: "Return all consent records, or the exact-origin consent record for a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_revoke_consent",
    description: "Revoke exact-origin consent. Active teach mode for that origin is stopped and selected tabs on that origin are cleared.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, reason: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "synthi_browser_snapshot",
    description:
      "Capture screenshot + DOM summary for the selected/authorized tab. Denied origins produce no screenshot, DOM, console, or network data.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_start_teach",
    description: "Start explicit teach mode for an authorized tab. Human selections/actions are recorded only while teach mode is active.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_stop_teach",
    description: "Stop teach mode and record the stop reason.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_get_trace",
    description: "Return the broker-recorded teach/action trace.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_get_trace_status",
    description:
      "Return semantic trace status and counts without raw trace events. Intended for agent-panel diagnostics and teach-mode progress.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_get_lane0_status",
    description:
      "Return Lane 0 sliding-window reducer status: trace version, window counts, annotation counts, and stale response count.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_answer_teach_question",
    description:
      "Record a one-click teach-mode answer or accepted source affordance. This appends broker audit metadata only; it cannot reorder trace events or force raw semantic annotations.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "string" },
        answer: { type: "string" },
        step_id: { type: "string" },
        accepted_affordance: { type: "string" },
      },
      required: ["question_id", "answer"],
    },
  },
  {
    name: "synthi_browser_get_workflow_card",
    description:
      "Return the current workflow card and high-level replay readiness without raw trace events or generated code.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_get_unresolved_steps",
    description:
      "Return workflow steps that need review because they lack durable locators, source identity, or supported replay surfaces.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_compile_workflow",
    description:
      "Compile the broker-recorded teach trace into a workflow card and v7 workflow contract. This is the primary teach-to-tool artifact before Playwright export.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_generate_script",
    description: "Generate Playwright test code from the broker trace, including locator confidence and fallback candidates.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["sameSession", "prefixOnly", "coldSession"], description: "Use prefixOnly or coldSession to stop before the first mutation boundary." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_run_workflow",
    description:
      "Replay the compiled workflow in the current authorized browser session under a control lease. prefixOnly stops before the first mutation boundary.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        tab_id: { type: "string" },
        mode: { type: "string", enum: ["sameSession", "prefixOnly", "coldSession"], default: "prefixOnly" },
      },
      required: ["lease_id"],
    },
  },
  {
    name: "synthi_browser_explain_failure",
    description:
      "Explain a workflow replay failure class in product-facing terms and return the safest next action. Does not expose raw browser state.",
    inputSchema: {
      type: "object",
      properties: {
        failure_class: {
          type: "string",
          description: "Failure class from a workflow contract or replay result.",
        },
        failed_step_id: { type: "string" },
      },
      required: ["failure_class"],
    },
  },
  {
    name: "synthi_browser_acquire_lease",
    description: "Acquire a browser control lease before state-changing actions.",
    inputSchema: {
      type: "object",
      properties: {
        lease_ms: { type: "number" },
        owner: { type: "string" },
        reason: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_release_lease",
    description: "Release a browser control lease. Releasing also clears queued broker actions.",
    inputSchema: {
      type: "object",
      properties: { lease_id: { type: "string" }, reason: { type: "string" } },
      required: ["lease_id"],
    },
  },
  {
    name: "synthi_browser_action",
    description:
      "Execute a broker-filtered browser action through Playwright. Requires a live browser lease and exact-origin consent.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        tab_id: { type: "string" },
        action: { type: "string", enum: ["click", "fill", "press", "select", "check", "uncheck", "navigate", "wait"] },
        selector: { type: "string", description: "A generated Playwright locator string or raw CSS selector." },
        value: { type: "string", description: "Fill text, key name, select option, or navigation URL depending on action." },
      },
      required: ["lease_id", "action"],
    },
  },
  {
    name: "synthi_browser_wait",
    description: "Wait in an authorized tab for selector, URL, load, networkidle, or timeout.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        condition: { type: "string", enum: ["selector", "url", "load", "networkidle", "timeout"] },
        selector: { type: "string" },
        url_pattern: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["condition"],
    },
  },
  {
    name: "synthi_browser_get_console",
    description: "Return redacted console events for the selected/authorized tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_get_network",
    description: "Return redacted network request events for the selected/authorized tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_detect_project",
    description: "Detect likely local web dev commands for a workspace. Returns candidates; the agent chooses which command to run.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string", description: "Workspace/project root. Defaults to MCP process cwd." } },
      required: [],
    },
  },
  {
    name: "synthi_browser_run_project",
    description: "Run an agent-chosen local dev command in a project root. The process is logged and can be stopped by run_id.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        command: { type: "string", description: "Shell command chosen by the agent. If omitted, the highest-confidence detected candidate is used." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_project_status",
    description: "Return active browser project runs and recent logs.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_browser_stop_project",
    description: "Stop a browser project run by run_id.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
] as const;

export async function dispatchBrowserTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  try {
    switch (toolName) {
      case "synthi_browser_attach_current_workspace":
        return await browserAttachCurrentWorkspaceTool(args);
      case "synthi_browser_observe":
        return await browserSnapshotTool(args);
      case "synthi_browser_begin_teach":
        return browserBeginTeachTool(args);
      case "synthi_browser_end_teach":
        return browserEndTeachTool(args);
      case "synthi_browser_attach":
        return await browserAttachTool(args);
      case "synthi_browser_list_tabs":
        return await browserListTabsTool();
      case "synthi_browser_select_tab":
        return await browserSelectTabTool(args);
      case "synthi_browser_open":
        return await browserOpenTool(args);
      case "synthi_browser_request_consent":
        return browserRequestConsentTool(args);
      case "synthi_browser_get_consent":
        return browserGetConsentTool(args);
      case "synthi_browser_revoke_consent":
        return browserRevokeConsentTool(args);
      case "synthi_browser_snapshot":
        return await browserSnapshotTool(args);
      case "synthi_browser_start_teach":
        return browserStartTeachTool(args);
      case "synthi_browser_stop_teach":
        return browserStopTeachTool(args);
      case "synthi_browser_get_trace":
        return jsonResponse({ ok: true, trace: browserBroker.traceSnapshot() });
      case "synthi_browser_get_trace_status":
        return browserTraceStatusTool();
      case "synthi_browser_get_lane0_status":
        return jsonResponse({ ok: true, lane0: browserBroker.lane0Status() });
      case "synthi_browser_answer_teach_question":
        return browserAnswerTeachQuestionTool(args);
      case "synthi_browser_get_workflow_card":
        return browserWorkflowCardTool();
      case "synthi_browser_get_unresolved_steps":
        return browserUnresolvedStepsTool();
      case "synthi_browser_compile_workflow":
        return jsonResponse({ ok: true, workflow: browserBroker.compiledWorkflow() });
      case "synthi_browser_generate_script":
        return browserGenerateScriptTool(args);
      case "synthi_browser_run_workflow":
        return await browserRunWorkflowTool(args);
      case "synthi_browser_explain_failure":
        return browserExplainFailureTool(args);
      case "synthi_browser_acquire_lease":
        return browserAcquireLeaseTool(args);
      case "synthi_browser_release_lease":
        return browserReleaseLeaseTool(args);
      case "synthi_browser_action":
        return await browserActionTool(args);
      case "synthi_browser_wait":
        return await browserWaitTool(args);
      case "synthi_browser_get_console":
        return browserConsoleTool(args);
      case "synthi_browser_get_network":
        return browserNetworkTool(args);
      case "synthi_browser_detect_project":
        return await browserDetectProjectTool(args);
      case "synthi_browser_run_project":
        return await browserRunProjectTool(args);
      case "synthi_browser_project_status":
        return browserProjectStatusTool(args);
      case "synthi_browser_stop_project":
        return await browserStopProjectTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("browser_tool_failed", err);
  }
}

async function browserAttachCurrentWorkspaceTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const result = await attachHostedBrowserRuntime(
    {
      workspace_id: stringOpt(a["workspace_id"]),
      workspace_url: stringOpt(a["workspace_url"]),
      runtime_id: stringOpt(a["runtime_id"]),
      open_workspace: boolOpt(a["open_workspace"]),
    },
    browserPlaywrightAdapter,
    browserBroker
  );
  if (!result.ok) {
    return errorResponse(result.error, {
      runtime: result.runtime,
      low_level_local_dev_tool: "synthi_browser_attach",
      readiness: resolveHostedBrowserRuntime({
        workspace_id: stringOpt(a["workspace_id"]),
        workspace_url: stringOpt(a["workspace_url"]),
        runtime_id: stringOpt(a["runtime_id"]),
      }),
    });
  }
  return jsonResponse({
    ok: true,
    runtime: result.runtime,
    tabs: result.tabs,
    hidden_tabs: result.hidden_tabs,
    opened_workspace_url: result.opened_workspace_url,
    consent_required_for: result.consent_required_for,
    permission_tiers: result.permission_tiers,
  });
}

async function browserAttachTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const cdpUrl = stringOpt(a["cdp_url"]) ?? process.env["SYNTHI_BROWSER_CDP_URL"];
  if (!cdpUrl) return errorResponse("browser_cdp_url_required", { env: "SYNTHI_BROWSER_CDP_URL", arg: "cdp_url" });
  const bridge = await browserBridgeServer.start({
    token: stringOpt(a["bridge_token"]),
    host: stringOpt(a["bridge_host"]),
    port: numberOpt(a["bridge_port"]),
    publicUrl: stringOpt(a["bridge_public_url"]),
  });
  browserBroker.setBridgeToken(bridge.token);
  const allTabs = await browserPlaywrightAdapter.attach(cdpUrl);
  const tabs = browserBroker.registerTabs(allTabs);
  const runtime = browserBroker.setRuntimeAttachment({
    kind: "local-dev-cdp",
    workspace_id: null,
    runtime_id: null,
    workspace_url: null,
    adapter: "local-playwright-cdp",
  });
  return jsonResponse({
    ok: true,
    cdp_url: cdpUrl,
    runtime,
    bridge,
    tabs,
    hidden_tabs: allTabs.length - tabs.length,
    permission_tiers: ["attached", "origin_consent", "snapshot", "teach", "control"],
  });
}

async function browserListTabsTool(): Promise<ToolResponse> {
  const allTabs = await browserPlaywrightAdapter.listTabs();
  const tabs = browserBroker.registerTabs(allTabs);
  return jsonResponse({ ok: true, tabs, hidden_tabs: allTabs.length - tabs.length });
}

async function browserSelectTabTool(args: unknown): Promise<ToolResponse> {
  const tabId = requiredString(obj(args), "tab_id");
  const brokerTab = browserBroker.selectTab(tabId);
  if (!brokerTab) return errorResponse("tab_not_authorized", { tab_id: tabId });
  const tab = await browserPlaywrightAdapter.selectTab(tabId);
  return jsonResponse({ ok: true, tab });
}

async function browserOpenTool(args: unknown): Promise<ToolResponse> {
  const url = requiredString(obj(args), "url");
  if (!consentGranted(url)) return errorResponse("origin_consent_required", { url });
  const tab = await browserPlaywrightAdapter.open(url);
  const tabs = browserBroker.registerTabs(await browserPlaywrightAdapter.listTabs());
  browserBroker.selectTab(tab.tab_id);
  return jsonResponse({ ok: true, tab, tabs });
}

function browserRequestConsentTool(args: unknown): ToolResponse {
  const a = obj(args);
  const url = requiredString(a, "url");
  const status = stringOpt(a["status"]) === "denied" ? "denied" : "granted";
  const record = browserBroker.requestConsent(url, status, stringOpt(a["reason"]), {
    screenshot: boolOpt(a["screenshot"]),
    diagnostics: boolOpt(a["diagnostics"]),
  });
  return jsonResponse({ ok: true, consent: record });
}

function browserGetConsentTool(args: unknown): ToolResponse {
  const a = obj(args);
  return jsonResponse({ ok: true, consent: browserBroker.getConsent(stringOpt(a["url"])) });
}

function browserRevokeConsentTool(args: unknown): ToolResponse {
  const a = obj(args);
  const record = browserBroker.revokeConsent(requiredString(a, "url"), stringOpt(a["reason"]));
  return jsonResponse({ ok: true, consent: record, teach: browserBroker.teachState() });
}

async function browserSnapshotTool(args: unknown): Promise<ToolResponse> {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
  const access = browserBroker.requireSnapshotAccess(tab.url);
  if (!access.ok) return errorResponse(access.error);
  const snapshot = await browserPlaywrightAdapter.snapshot(tab.tab_id);
  const gated = browserBroker.snapshot(snapshot);
  if (!gated.ok) return errorResponse(gated.error);
  return jsonResponse({ ok: true, snapshot: gated.snapshot });
}

function browserStartTeachTool(args: unknown): ToolResponse {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
  const result = browserBroker.startTeachMode(tab.tab_id);
  if (!result.ok) return errorResponse(result.error);
  return jsonResponse({ ok: true, teach: browserBroker.teachState(), tab: result.tab, origin: result.origin });
}

function browserBeginTeachTool(args: unknown): ToolResponse {
  const a = obj(args);
  const result = browserStartTeachTool(args);
  if (result.isError) return result;
  return jsonResponse({
    ...(result.structuredContent ?? {}),
    goal: stringOpt(a["goal"]) ?? null,
    primary_tool: "synthi_browser_begin_teach",
  });
}

function browserStopTeachTool(args: unknown): ToolResponse {
  const reason = stringOpt(obj(args)["reason"]) ?? "stopped";
  return jsonResponse({ ok: true, teach: browserBroker.stopTeachMode(reason) });
}

function browserEndTeachTool(args: unknown): ToolResponse {
  const reason = stringOpt(obj(args)["reason"]) ?? "stopped";
  const teach = browserBroker.stopTeachMode(reason);
  const workflow = browserBroker.compiledWorkflow();
  return jsonResponse({
    ok: true,
    teach,
    workflow_id: workflow.contract.workflowId,
    card: workflow.card,
    replay: {
      modes: workflow.contract.replayModes,
      default_mode: workflow.contract.mutationBoundaryPlan.defaultReplayMode,
      first_mutation_step_id: workflow.contract.mutationBoundaryPlan.firstMutationStepId ?? null,
    },
    auth: workflow.contract.authPlan,
    source_identity_coverage: workflow.contract.sourceIdentityCoverage,
    limitations: workflow.contract.limitations,
    generated_outputs: workflow.contract.generatedOutputs,
    primary_tool: "synthi_browser_end_teach",
  });
}

function browserGenerateScriptTool(args: unknown): ToolResponse {
  const mode = normalizeReplayMode(obj(args)["mode"]);
  return jsonResponse({ ok: true, ...browserBroker.generatedScript(mode) });
}

function browserTraceStatusTool(): ToolResponse {
  const trace = browserBroker.traceSnapshot();
  const workflow = browserBroker.compiledWorkflow();
  const last = trace[trace.length - 1];
  const counts = trace.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  const origins = [...new Set(trace.map((event) => event.origin).filter((origin) => origin && origin !== "unknown"))];
  const tabs = [...new Set(trace.map((event) => event.tab_id).filter(Boolean))];
  return jsonResponse({
    ok: true,
    trace_status: {
      trace_id: last?.trace_id ?? null,
      trace_version: last?.trace_version ?? null,
      last_event_seq: last?.event_seq ?? 0,
      event_count: trace.length,
      action_count: (counts["human_action"] ?? 0) + (counts["agent_action"] ?? 0),
      selection_count: counts["selection"] ?? 0,
      navigation_count: counts["navigation"] ?? 0,
      origins,
      tabs,
      teach: browserBroker.teachState(),
      workflow_id: workflow.contract.workflowId,
      workflow_state: workflow.card.state,
      unresolved_count: workflow.card.unresolvedCount,
      limitations: workflow.contract.limitations,
      lane0: workflow.contract.lane0,
      teach_question_answers_count: browserBroker.teachQuestionAnswers().length,
    },
  });
}

function browserAnswerTeachQuestionTool(args: unknown): ToolResponse {
  const a = obj(args);
  const answer = browserBroker.recordTeachQuestionAnswer({
    question_id: requiredString(a, "question_id"),
    answer: requiredString(a, "answer"),
    step_id: stringOpt(a["step_id"]),
    accepted_affordance: stringOpt(a["accepted_affordance"]),
  });
  return jsonResponse({
    ok: true,
    answer,
    teach_question_answers_count: browserBroker.teachQuestionAnswers().length,
  });
}

function browserWorkflowCardTool(): ToolResponse {
  const workflow = browserBroker.compiledWorkflow();
  return jsonResponse({
    ok: true,
    workflow_id: workflow.contract.workflowId,
    card: workflow.card,
    replay: {
      modes: workflow.contract.replayModes,
      default_mode: workflow.contract.mutationBoundaryPlan.defaultReplayMode,
      first_mutation_step_id: workflow.contract.mutationBoundaryPlan.firstMutationStepId ?? null,
    },
    auth: workflow.contract.authPlan,
    source_identity_coverage: workflow.contract.sourceIdentityCoverage,
    limitations: workflow.contract.limitations,
    generated_outputs: workflow.contract.generatedOutputs,
  });
}

function browserUnresolvedStepsTool(): ToolResponse {
  const workflow = browserBroker.compiledWorkflow();
  const reviewLimitations = new Set([
    "unresolvedStep",
    "lowConfidenceLocator",
    "sourceIdentityMissing",
    "iframeNeedsFrameLocator",
    "popupOrMultiTab",
    "canvasCoordinateOnly",
    "closedShadowDomBlocked",
    "pointerDragUnreliable",
  ]);
  const steps = workflow.contract.steps
    .filter((step) => step.limitations.some((limitation) => reviewLimitations.has(limitation)))
    .map((step) => ({
      step_id: step.stepId,
      event_seq: step.eventSeq,
      label: step.label,
      action: step.action.kind,
      target: step.action.target ?? null,
      locator_confidence: step.locatorPlan.confidence,
      source_status: step.sourcePlan.status,
      limitations: step.limitations,
      suggested_affordances: workflow.contract.sourceAffordancePatches
        .filter((patch) => patch.stepId === step.stepId)
        .map((patch) => ({
          reason: patch.reason,
          suggested_attribute: patch.suggestedAttribute,
        })),
    }));
  return jsonResponse({ ok: true, workflow_id: workflow.contract.workflowId, steps, unresolved_count: steps.length });
}

function browserExplainFailureTool(args: unknown): ToolResponse {
  const failureClass = requiredString(obj(args), "failure_class");
  const failedStepId = stringOpt(obj(args)["failed_step_id"]);
  return jsonResponse({
    ok: true,
    failure_class: failureClass,
    failed_step_id: failedStepId ?? null,
    ...failureExplanation(failureClass),
  });
}

function browserAcquireLeaseTool(args: unknown): ToolResponse {
  const a = obj(args);
  const lease = browserBroker.acquireLease(
    stringOpt(a["owner"]) ?? process.env["SYNTHI_AGENT_ID"] ?? "mcp_agent",
    numberOpt(a["lease_ms"]) ?? 15_000,
    stringOpt(a["reason"])
  );
  return jsonResponse({ ok: true, lease });
}

function browserReleaseLeaseTool(args: unknown): ToolResponse {
  const a = obj(args);
  const result = browserBroker.releaseLease(requiredString(a, "lease_id"), stringOpt(a["reason"]) ?? "released");
  return jsonResponse({ ok: true, ...result });
}

async function browserRunWorkflowTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const leaseId = requiredString(a, "lease_id");
  const mode = normalizeReplayMode(a["mode"]);
  const plan = browserBroker.workflowReplayPlan(mode);
  if (plan.status === "blocked") {
    return jsonResponse({ ok: false, replay: { ...plan, failure_class: classifyWorkflowReplayBlock(plan) } });
  }

  const replayTab = mode === "coldSession" ? await openColdReplayTab(plan.events[0]?.url ?? tab.url) : tab;
  let stepsRun = 0;
  for (const event of plan.events) {
    const action = actionForReplay(event);
    if (!action) continue;
    const selector = event.locator_candidates?.[0]?.locator ?? event.selector;
    const value = action === "navigate" ? event.url : event.value;
    const validation = browserBroker.validateAction({
      lease_id: leaseId,
      action,
      tab_id: replayTab.tab_id,
      selector,
      value,
      url: action === "navigate" ? value : event.url,
    });
    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        replay: {
          ...plan,
          status: "failed",
          steps_run: stepsRun,
          failed_step_id: event.event_id,
          failure_class: validation.error === "browser_lease_required" ? "unsafeEnvironment" : "unknown",
          error: validation.error,
        },
      });
    }
    try {
      await browserPlaywrightAdapter.action(replayTab.tab_id, action, selector, value);
      stepsRun += 1;
    } catch (err) {
      return jsonResponse({
        ok: false,
        replay: {
          ...plan,
          status: "failed",
          steps_run: stepsRun,
          failed_step_id: event.event_id,
          failure_class: classifyWorkflowReplayFailure(err, event),
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return jsonResponse({
    ok: true,
    replay: {
      ...plan,
      status: plan.status,
      steps_run: stepsRun,
      tab_id: replayTab.tab_id,
      stopped_before_step_id: plan.stoppedBeforeStepId ?? null,
    },
  });
}

async function openColdReplayTab(url: string): Promise<{ tab_id: string; url: string }> {
  const access = browserBroker.requireSnapshotAccess(url);
  if (!access.ok) throw new Error(access.error);
  const tab = await browserPlaywrightAdapter.openCold(url);
  browserBroker.registerTabs(await browserPlaywrightAdapter.listTabs());
  browserBroker.selectTab(tab.tab_id);
  return { tab_id: tab.tab_id, url: tab.url };
}

async function browserActionTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const action = requiredString(a, "action");
  const value = stringOpt(a["value"]);
  const targetUrl = action === "navigate" && value ? value : tab.url;
  const validation = browserBroker.validateAction({
    lease_id: requiredString(a, "lease_id"),
    action: action as BrowserActionKind,
    tab_id: tab.tab_id,
    selector: stringOpt(a["selector"]),
    value,
    url: targetUrl,
  });
  if (!validation.ok) return errorResponse(validation.error);
  const result = await browserPlaywrightAdapter.action(tab.tab_id, action as BrowserActionKind, stringOpt(a["selector"]), value);
  browserBroker.handleOriginChange(tab.tab_id, result.url);
  eventLog.push({ kind: "browser", action: "agent_action", payload: { tab_id: tab.tab_id, action, selector: stringOpt(a["selector"]) ?? null, url: result.url } });
  return jsonResponse({ ok: true, result, teach: browserBroker.teachState() });
}

function actionForReplay(event: { kind: string; action?: BrowserActionKind }): BrowserActionKind | null {
  if (event.kind === "navigation") return "navigate";
  return event.action ?? null;
}

async function browserWaitTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const result = await browserPlaywrightAdapter.wait({
    tab_id: tab.tab_id,
    condition: requiredString(a, "condition") as "selector" | "url" | "load" | "networkidle" | "timeout",
    selector: stringOpt(a["selector"]),
    url_pattern: stringOpt(a["url_pattern"]),
    timeout_ms: numberOpt(a["timeout_ms"]),
  });
  return jsonResponse({ ok: true, result });
}

function browserConsoleTool(args: unknown): ToolResponse {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
  const access = browserBroker.requireDiagnosticsAccess(tab.url);
  if (!access.ok) return errorResponse(access.error);
  return jsonResponse({ ok: true, entries: browserPlaywrightAdapter.consoleFor(tab.tab_id) });
}

function browserNetworkTool(args: unknown): ToolResponse {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
  const access = browserBroker.requireDiagnosticsAccess(tab.url);
  if (!access.ok) return errorResponse(access.error);
  return jsonResponse({ ok: true, entries: browserPlaywrightAdapter.networkFor(tab.tab_id) });
}

async function browserDetectProjectTool(args: unknown): Promise<ToolResponse> {
  const detection = await detectBrowserProject(stringOpt(obj(args)["root"]));
  return jsonResponse({ ok: true, detection });
}

async function browserRunProjectTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const run = await runBrowserProject(stringOpt(a["root"]), stringOpt(a["command"]));
  return jsonResponse({ ok: true, run });
}

function browserProjectStatusTool(args: unknown): ToolResponse {
  return jsonResponse({ ok: true, runs: projectRunStatus(stringOpt(obj(args)["run_id"])) });
}

async function browserStopProjectTool(args: unknown): Promise<ToolResponse> {
  const result = await stopBrowserProject(requiredString(obj(args), "run_id"));
  return jsonResponse({ ok: true, ...result });
}

function requireAuthorizedTab(tabId?: string): { tab_id: string; url: string } {
  const tab = tabId ? browserBroker.selectTab(tabId) : browserBroker.selectedTab();
  if (!tab) throw new Error("tab_not_authorized");
  if (!consentGranted(tab.url)) throw new Error("origin_consent_required");
  return { tab_id: tab.tab_id, url: tab.url };
}

function consentGranted(url: string): boolean {
  return browserBroker.getConsent(url)[0]?.status === "granted";
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

function failureExplanation(failureClass: string): { explanation: string; suggested_next_action: string } {
  switch (failureClass) {
    case "authMissing":
    case "authExpired":
      return {
        explanation: "The workflow could not reach the application state because authentication was missing or expired.",
        suggested_next_action: "Renew or configure an auth checkpoint before replaying or publishing the workflow.",
      };
    case "mutationBlocked":
    case "unsafeEnvironment":
      return {
        explanation: "The workflow reached a step that may mutate application state or requires an isolated replay environment.",
        suggested_next_action: "Run prefix validation, require confirmation before commit, or configure a CI isolation profile.",
      };
    case "locatorDrift":
    case "sourceIdentityMissing":
      return {
        explanation: "A taught step no longer has a durable locator or source identity.",
        suggested_next_action: "Review unresolved steps and add a stable source affordance such as data-testid or data-synthi-affordance.",
      };
    case "closedShadowDomBlocked":
      return {
        explanation: "The step targets a closed Shadow DOM that normal browser automation cannot inspect.",
        suggested_next_action: "Enable a dev-only shadow bridge or add an external component-level affordance.",
      };
    case "canvasUnreliable":
    case "pointerDragUnreliable":
      return {
        explanation: "The step depends on coordinate or complex pointer behavior that is not durable across layouts and data states.",
        suggested_next_action: "Add a semantic app bridge, source affordance, or calibrated test helper before hardening.",
      };
    case "networkFailure":
    case "routeChanged":
    case "hydrationDelay":
      return {
        explanation: "The replay environment did not reach the expected route or ready UI state in time.",
        suggested_next_action: "Check the dev server, route, network state, and hydration waits before rerunning validation.",
      };
    default:
      return {
        explanation: "The workflow failed for an unknown reason.",
        suggested_next_action: "Inspect the workflow card, unresolved steps, and replay result before retrying.",
      };
  }
}
