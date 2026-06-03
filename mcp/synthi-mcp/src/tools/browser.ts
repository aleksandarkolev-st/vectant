import { browserBroker } from "../browser/broker.js";
import { browserBridgeServer } from "../browser/bridge_server.js";
import { browserPlaywrightAdapter } from "../browser/playwright_adapter.js";
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
  "synthi_browser_generate_script",
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
    description: "Grant or deny exact-origin consent. Consent does not cross scheme, host, subdomain, or port boundaries.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        status: { type: "string", enum: ["granted", "denied"], default: "granted" },
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
    name: "synthi_browser_generate_script",
    description: "Generate Playwright test code from the broker trace, including locator confidence and fallback candidates.",
    inputSchema: { type: "object", properties: {}, required: [] },
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
      case "synthi_browser_generate_script":
        return jsonResponse({ ok: true, ...browserBroker.generatedScript() });
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
  return jsonResponse({
    ok: true,
    cdp_url: cdpUrl,
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
  const record = browserBroker.requestConsent(url, status, stringOpt(a["reason"]));
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

function browserStopTeachTool(args: unknown): ToolResponse {
  const reason = stringOpt(obj(args)["reason"]) ?? "stopped";
  return jsonResponse({ ok: true, teach: browserBroker.stopTeachMode(reason) });
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
  return jsonResponse({ ok: true, entries: browserPlaywrightAdapter.consoleFor(tab.tab_id) });
}

function browserNetworkTool(args: unknown): ToolResponse {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
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
