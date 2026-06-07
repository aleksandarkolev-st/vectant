/**
 * Browser workflow HTTP bridge.
 *
 * The MCP stdio server is the agent-facing tool surface. The workspace IDE
 * panel needs a small browser-reachable HTTP hop to call the same workflow
 * tools from localhost/cloud runtime wiring during development. This bridge
 * intentionally dispatches through the existing MCP tool handlers instead of
 * duplicating browser workflow behavior.
 *
 * Opt-in via SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT in the stdio process, or run
 * the standalone entrypoint for local manual testing. Binds to 127.0.0.1 by
 * default; override with SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST. A shared-secret
 * header check (SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN) is optional.
 *
 * Endpoints:
 *   GET  /healthz                     -> "ok"
 *   GET  /browser-workflows/state     -> panel-safe state, no screenshots
 *   POST /browser-workflows/tool      -> { tool, arguments }
 */

import http from "node:http";
import { browserBroker } from "../browser/broker.js";
import { resolveHostedBrowserRuntime } from "../browser/hosted_runtime.js";
import type { WorkflowStepContractV7 } from "../browser/workflow.js";
import { dispatchAuthTool } from "../tools/auth.js";
import { dispatchBrowserTool } from "../tools/browser.js";
import { dispatchSafetyTool } from "../tools/safety.js";
import { dispatchSourceTool } from "../tools/source.js";
import type { ToolResponse } from "../tools/shared.js";

export interface BrowserWorkflowBridgeOptions {
  port: number;
  host?: string;
  /** When set, requests must carry `x-synthi-workflow-token: <token>`. */
  token?: string;
}

interface BridgeHistoryEntry {
  id: string;
  label: string;
  detail: string;
  status: string;
  statusLabel: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  startedAt: string;
}

interface BrowserWorkflowBridgeState {
  lastObserveAt?: string;
  compiledAt?: string;
  scriptGeneratedAt?: string;
  manifestGeneratedAt?: string;
  lastTool?: string;
  lastToolAt?: string;
  history: BridgeHistoryEntry[];
}

const MAX_HISTORY = 8;
const PREVIEW_DISCOVERY_TIMEOUT_MS = 5000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Synthi-Workflow-Token",
  "Access-Control-Max-Age": "600",
};

const TOOL_ALIASES: Record<string, string> = {
  synthi_browser_configure_auth: "synthi_auth_get_tool_auth_readiness",
  synthi_source_identity_open: "synthi_source_get_mapping_status",
  synthi_workflow_compile_contract: "synthi_browser_compile_workflow",
  synthi_workflow_prefix_validate: "synthi_safety_run_prefix_validation",
  synthi_workflow_generate_playwright: "synthi_browser_generate_script",
  synthi_workflow_generate_tool_manifest: "synthi_browser_generate_private_tool_manifest",
  synthi_workflow_publish_tool: "synthi_browser_generate_private_tool_manifest",
};

const WORKFLOW_BRIDGE_ALLOWED_TOOLS = new Set([
  "synthi_browser_attach_current_workspace",
  "synthi_browser_observe_preview",
  "synthi_browser_begin_teach",
  "synthi_browser_end_teach",
  "synthi_auth_get_tool_auth_readiness",
  "synthi_source_get_mapping_status",
  "synthi_browser_compile_workflow",
  "synthi_safety_run_prefix_validation",
  "synthi_browser_generate_script",
  "synthi_browser_generate_private_tool_manifest",
]);

const REVIEW_LIMITATIONS = new Set([
  "unresolvedStep",
  "lowConfidenceLocator",
  "sourceIdentityMissing",
  "iframeNeedsFrameLocator",
  "popupOrMultiTab",
  "canvasCoordinateOnly",
  "closedShadowDomBlocked",
  "pointerDragUnreliable",
]);

async function readJsonBody<T>(req: http.IncomingMessage, maxBytes: number = 1_000_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

function normalizeToolName(toolName: string): string {
  return TOOL_ALIASES[toolName] ?? toolName;
}

async function dispatchWorkflowTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  if (!WORKFLOW_BRIDGE_ALLOWED_TOOLS.has(toolName)) return null;
  return (
    (await dispatchBrowserTool(toolName, args)) ??
    (await dispatchSafetyTool(toolName, args)) ??
    (await dispatchSourceTool(toolName, args)) ??
    (await dispatchAuthTool(toolName, args))
  );
}

function structuredPayload(response: ToolResponse): Record<string, unknown> {
  if (response.structuredContent && typeof response.structuredContent === "object") {
    return response.structuredContent;
  }
  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { raw: text };
  }
}

function requestUrlFromArgs(args: unknown): string | undefined {
  const a = objectArgs(args);
  return stringOpt(a["url"]) ?? stringOpt(a["workspace_url"]);
}

function defaultWorkspaceUrl(args: unknown): string | undefined {
  const runtime = browserBroker.runtimeAttachment();
  const selected = browserBroker.selectedTab();
  return (
    requestUrlFromArgs(args) ??
    selected?.url ??
    runtime?.workspace_url ??
    stringOpt(process.env["SYNTHI_WORKSPACE_URL"]) ??
    stringOpt(process.env["SYNTHI_HOSTED_BROWSER_WORKSPACE_URL"])
  );
}

async function enrichToolArgs(toolName: string, args: unknown): Promise<Record<string, unknown>> {
  const base = objectArgs(args);
  if (toolName === "synthi_auth_get_tool_auth_readiness" && !stringOpt(base["url"])) {
    const url = defaultWorkspaceUrl(base);
    if (url) return { ...base, url };
  }
  if (
    toolName === "synthi_browser_observe_preview" &&
    !stringOpt(base["preferred_url"]) &&
    !stringOpt(base["preview_url"])
  ) {
    const previewUrl = await discoverWorkspacePreviewUrl(base);
    if (previewUrl) {
      return { ...base, preferred_url: previewUrl, preview_url: previewUrl };
    }
  }
  return base;
}

async function discoverWorkspacePreviewUrl(args: Record<string, unknown>): Promise<string | undefined> {
  const slug = workspaceSlugFromArgs(args);
  if (!slug) return undefined;
  const collabUrl = resolveCollabServerUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`${collabUrl}/ports?workspace=${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as Record<string, unknown>;
    const preview = previewUrlFromPortsPayload(payload, collabUrl);
    return preview ?? undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function workspaceSlugFromArgs(args: Record<string, unknown>): string | undefined {
  const direct = stringOpt(args["workspace_id"]) ?? stringOpt(args["workspace"]);
  if (direct) return direct;
  const workspaceUrl = stringOpt(args["workspace_url"]) ?? defaultWorkspaceUrl(args);
  if (!workspaceUrl) return undefined;
  try {
    const parsed = new URL(workspaceUrl);
    const match = parsed.pathname.match(/\/workspace\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function resolveCollabServerUrl(): string {
  const configured =
    stringOpt(process.env["SYNTHI_COLLAB_SERVER_URL"]) ??
    stringOpt(process.env["COLLAB_SERVER_URL"]) ??
    stringOpt(process.env["NEXT_PUBLIC_COLLAB_SERVER_URL"]);
  return (configured ?? "http://localhost:1234").replace(/\/$/, "");
}

function previewUrlFromPortsPayload(payload: Record<string, unknown>, collabUrl: string): string | null {
  const previews = Array.isArray(payload["previews"]) ? payload["previews"] : [];
  for (const item of previews) {
    if (!item || typeof item !== "object") continue;
    const url = stringOpt((item as Record<string, unknown>)["url"]);
    const resolved = resolvePreviewUrl(url, collabUrl);
    if (resolved) return resolved;
  }
  const activePorts = Array.isArray(payload["activePorts"]) ? payload["activePorts"] : [];
  const ports = activePorts
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
    .sort((a, b) => a - b);
  return ports[0] ? resolvePreviewUrl(`/port/${ports[0]}/`, collabUrl) : null;
}

function resolvePreviewUrl(url: string | undefined, collabUrl: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, `${collabUrl}/`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function updateBridgeState(
  state: BrowserWorkflowBridgeState,
  toolName: string,
  ok: boolean,
  payload: Record<string, unknown>
): void {
  const now = new Date().toISOString();
  state.lastTool = toolName;
  state.lastToolAt = now;
  if (ok && toolName === "synthi_browser_attach_current_workspace") {
    state.lastObserveAt = undefined;
    state.compiledAt = undefined;
    state.scriptGeneratedAt = undefined;
    state.manifestGeneratedAt = undefined;
    state.history = [];
  }
  if (ok && toolName === "synthi_browser_begin_teach") {
    state.compiledAt = undefined;
    state.scriptGeneratedAt = undefined;
    state.manifestGeneratedAt = undefined;
    state.history = [];
  }
  if (ok && toolName === "synthi_browser_observe") state.lastObserveAt = now;
  if (ok && toolName === "synthi_browser_observe_preview") state.lastObserveAt = now;
  if (ok && (toolName === "synthi_browser_end_teach" || toolName === "synthi_browser_compile_workflow")) {
    state.compiledAt = now;
  }
  if (ok && toolName === "synthi_browser_generate_script") state.scriptGeneratedAt = now;
  if (ok && toolName === "synthi_browser_generate_private_tool_manifest") state.manifestGeneratedAt = now;
  if (toolName === "synthi_safety_run_prefix_validation" || toolName === "synthi_browser_run_workflow") {
    const validation = payload["validation"] as Record<string, unknown> | undefined;
    const replay = payload["replay"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `workflow_run_${Date.now()}`,
      label: toolName === "synthi_safety_run_prefix_validation" ? "Prefix validation" : "Workflow replay",
      detail: stringOpt(validation?.["status"]) ?? stringOpt(replay?.["status"]) ?? (ok ? "Completed" : "Blocked"),
      status: ok ? "passed" : "blocked",
      statusLabel: ok ? "Passed" : "Blocked",
      tone: ok ? "ok" : "warn",
      startedAt: now,
    };
    state.history = [
      entry,
      ...state.history,
    ].slice(0, MAX_HISTORY);
  }
}

export function buildBrowserWorkflowPanelState(
  bridgeState: Partial<BrowserWorkflowBridgeState> = {}
): Record<string, unknown> {
  const runtime = browserBroker.runtimeAttachment();
  const selected = browserBroker.selectedTab();
  const tabs = browserBroker.listTabs();
  const teach = browserBroker.teachState();
  const trace = browserBroker.traceSnapshot();
  const lane0 = browserBroker.lane0Status();
  const workflow = browserBroker.compiledWorkflow();
  const prefixPlan = browserBroker.workflowReplayPlan("prefixOnly");
  const workspaceUrl = selected?.url ?? runtime?.workspace_url ?? null;
  const consent = workspaceUrl ? browserBroker.getConsent(workspaceUrl)[0] : undefined;
  const screenshotAllowed = consent?.status === "granted" && consent.screenshot === "granted";
  const observed = Boolean(bridgeState.lastObserveAt) || Boolean(selected && screenshotAllowed);
  const traceReady = workflow.contract.steps.length > 0;
  const compiled = Boolean(bridgeState.compiledAt);
  const scriptGenerated = Boolean(bridgeState.scriptGeneratedAt) && traceReady;
  const sourceCoverage = workflow.contract.sourceIdentityCoverage;
  const publish = workflow.contract.publishPlan;

  return {
    workspaceLabel: runtime?.workspace_id ?? stringOpt(process.env["SYNTHI_WORKSPACE_ID"]) ?? "Current workspace",
    bridge: {
      status: "ready",
      lastTool: bridgeState.lastTool ?? null,
      lastToolAt: bridgeState.lastToolAt ?? null,
    },
    runtime: runtime
      ? {
          status: "attached",
          label: runtime.kind === "hosted" ? "Hosted runtime attached" : "Local dev runtime attached",
          detail: runtime.kind === "hosted"
            ? "Attached through the Synthi-hosted browser runtime."
            : "Attached through the local development CDP harness.",
          workspaceUrl: runtime.workspace_url,
          runtimeId: runtime.runtime_id,
          adapter: runtime.adapter,
          tabs: tabs.length,
        }
      : {
          status: "notConfigured",
          label: "Hosted runtime needed",
          detail: "No hosted browser session is attached.",
          readiness: resolveHostedBrowserRuntime(),
        },
    observe: {
      status: observed ? "ready" : runtime ? "needsConsent" : "needsRuntime",
      label: observed ? "Screenshot allowed" : runtime ? "Consent pending" : "Runtime needed",
      detail: observed
        ? selected
          ? `Selected ${selected.title || selected.url}.`
          : "The current workspace view can be inspected."
        : runtime
        ? "Click Observe to grant exact-origin screenshot consent and inspect the workspace view."
        : "Attach first, then inspect the workspace view.",
      lastScreenshotAt: bridgeState.lastObserveAt ?? null,
      selectedTabId: selected?.tab_id ?? null,
      consent: consent ?? null,
    },
    teach: {
      state: teach.active ? "recording" : "idle",
      label: teach.active ? "Recording" : traceReady ? "Trace ready" : "Ready after observe",
      detail: teach.active
        ? "Events are being captured for the current workflow."
        : traceReady
        ? "A trace is ready for contract compilation."
        : "Capture one same-origin workflow in the workspace.",
      tabId: teach.tab_id,
      origin: teach.origin,
      traceVersion: trace[trace.length - 1]?.trace_version ?? null,
      lane0,
    },
    auth: {
      status: !workflow.contract.authPlan.required || workflow.contract.authPlan.durability !== "noneRequired"
        ? "ready"
        : "notConfigured",
      label: workflow.contract.authPlan.durability,
      detail: workflow.contract.authPlan.notes.join(" "),
    },
    source: {
      status: sourceCoverage.status === "missing" ? "pending" : "ready",
      label: `${sourceCoverage.linkedSteps}/${sourceCoverage.totalSteps} linked`,
      detail: sourceCoverage.status === "missing"
        ? "Source identity tokens are not available for this workflow yet."
        : `Source identity coverage is ${sourceCoverage.status}.`,
    },
    replay: {
      status: scriptGenerated ? "ready" : compiled ? prefixPlan.status : "notStarted",
      label: scriptGenerated ? "Playwright ready" : compiled ? prefixPlan.status : "No replay",
      detail: scriptGenerated
        ? "The Playwright workflow has been generated."
        : compiled
        ? prefixPlan.status === "blocked"
          ? prefixPlan.warnings.join(" ") || "Replay is blocked by workflow limitations."
          : "The compiled workflow can be validated with a read-only prefix plan."
        : "Compile a contract before replay validation.",
    },
    workflow: {
      title: workflow.card.title,
      status: workflow.card.status,
      label: compiled ? "Contract compiled" : traceReady ? "Trace ready" : "No trace yet",
      detail: compiled ? workflow.contract.description : traceReady ? "Compile this trace into a workflow contract." : "Teach a browser workflow in this workspace.",
      stepCount: workflow.card.stepCount,
      unresolvedCount: workflow.card.unresolvedCount,
      contractStatus: compiled ? "compiled" : traceReady ? "draft" : "missing",
      scriptStatus: scriptGenerated ? "generated" : "missing",
      manifestStatus: bridgeState.manifestGeneratedAt ? "generated" : "missing",
      workflowId: workflow.contract.workflowId,
      publishReadiness: publish.readiness,
    },
    steps: workflow.contract.steps.map(panelStepForContract),
    unresolvedSteps: workflow.contract.steps
      .filter((step) => step.limitations.some((limitation) => REVIEW_LIMITATIONS.has(limitation)))
      .map((step) => ({
        id: step.stepId,
        label: step.label,
        detail: step.limitations.length
          ? `Needs publish hardening: ${step.limitations.join(", ")}.`
          : "Needs hardening before unattended replay.",
      })),
    blockers: workflow.contract.limitations.map((limitation) => ({
      id: `limitation_${limitation}`,
      label: limitation,
      detail: limitationDetail(limitation),
    })),
    history: bridgeState.history ?? [],
    diagnostics: {
      eventCount: trace.length,
      authorizedTabCount: tabs.length,
      lane0,
      replayWarnings: prefixPlan.warnings,
      generatedAt: {
        compiledAt: bridgeState.compiledAt ?? null,
        scriptGeneratedAt: bridgeState.scriptGeneratedAt ?? null,
        manifestGeneratedAt: bridgeState.manifestGeneratedAt ?? null,
      },
    },
  };
}

export function startBrowserWorkflowBridge(opts: BrowserWorkflowBridgeOptions): {
  server: http.Server;
  ready: Promise<void>;
  close: () => Promise<void>;
} {
  const host = opts.host ?? "127.0.0.1";
  const bridgeState: BrowserWorkflowBridgeState = { history: [] };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (opts.token !== undefined) {
      const supplied = req.headers["x-synthi-workflow-token"];
      if (supplied !== opts.token) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    if (url === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("ok\n");
      return;
    }

    if (url === "/browser-workflows/state" && method === "GET") {
      writeJson(res, 200, { ok: true, state: buildBrowserWorkflowPanelState(bridgeState) });
      return;
    }

    if (url === "/browser-workflows/tool" && method === "POST") {
      let body: { tool?: unknown; arguments?: unknown };
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, { error: "invalid_body", detail: msg, state: buildBrowserWorkflowPanelState(bridgeState) });
        return;
      }

      if (typeof body.tool !== "string" || body.tool.length === 0) {
        writeJson(res, 400, { error: "invalid_args", field: "tool", state: buildBrowserWorkflowPanelState(bridgeState) });
        return;
      }

      const requestedTool = body.tool;
      const tool = normalizeToolName(requestedTool);
      const args = await enrichToolArgs(tool, body.arguments);
      const result = await dispatchWorkflowTool(tool, args);
      if (!result) {
        writeJson(res, 404, {
          error: "unknown_workflow_tool",
          tool,
          requested_tool: requestedTool,
          state: buildBrowserWorkflowPanelState(bridgeState),
        });
        return;
      }

      const payload = structuredPayload(result);
      const ok = result.isError !== true && payload["ok"] !== false;
      updateBridgeState(bridgeState, tool, ok, payload);
      writeJson(res, 200, {
        ok,
        requested_tool: requestedTool,
        tool,
        is_error: result.isError === true,
        result: payload,
        state: buildBrowserWorkflowPanelState(bridgeState),
      });
      return;
    }

    writeJson(res, 404, { error: "not_found", url, method });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });
  server.listen(opts.port, host);

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, ready, close };
}

/** Parse SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT. Returns undefined when unset / invalid. */
export function resolveBrowserWorkflowBridgePort(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return Math.floor(n);
}

function panelStepForContract(step: WorkflowStepContractV7): Record<string, unknown> {
  const limited = step.limitations.length > 0;
  const verified = step.sourcePlan.status === "linked" && step.locatorPlan.confidence !== "none" && !limited;
  return {
    id: step.stepId,
    label: step.label,
    title: step.label,
    state: limited ? "limited" : verified ? "verified" : "recorded",
    meta: stepMeta(step),
    detail: step.intent,
    action: step.action.kind,
    sourceStatus: step.sourcePlan.status,
    locatorConfidence: step.locatorPlan.confidence,
    surface: step.surfacePlan.kind,
    replay: step.surfacePlan.replay,
    limitations: step.limitations,
  };
}

function stepMeta(step: WorkflowStepContractV7): string {
  const target = step.action.target?.label;
  const confidence = step.locatorPlan.confidence;
  return target ? `${step.action.kind} ${target} · ${confidence} locator` : `${step.action.kind} · ${confidence} locator`;
}

function limitationDetail(limitation: string): string {
  switch (limitation) {
    case "sourceIdentityMissing":
      return "Add source identity or a stable affordance before publishing unattended tools.";
    case "mutationRequiresIsolation":
      return "Full replay needs an isolated CI profile or confirm-before-commit mode.";
    case "unresolvedStep":
      return "One or more taught steps need a stable replay target.";
    case "iframeNeedsFrameLocator":
      return "Iframe steps need durable frame locator support before replay.";
    case "popupOrMultiTab":
      return "Popup or multi-tab workflows need explicit tab ownership before replay.";
    case "canvasCoordinateOnly":
      return "Canvas-only coordinates are same-session only unless the app exposes a semantic bridge.";
    case "closedShadowDomBlocked":
      return "Closed Shadow DOM targets need app-level affordances.";
    case "pointerDragUnreliable":
      return "Pointer-drag replay needs explicit drag-mode support or a parameterized surface.";
    default:
      return "Review this workflow limitation before publishing.";
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
