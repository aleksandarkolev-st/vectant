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
 * default; override with SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST. No-token mode is
 * limited to loopback development; non-loopback bridges must use
 * SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN.
 *
 * Endpoints:
 *   GET  /healthz                     -> "ok"
 *   GET  /browser-workflows/state     -> panel-safe state, no screenshots
 *   POST /browser-workflows/tool      -> { tool, arguments }
 */

import http from "node:http";
import { browserBroker, type BrowserRecordingIssue } from "../browser/broker.js";
import { buildDojoSkill, dojoSkillRegistry } from "../browser/dojo.js";
import {
  buildDojoGovernanceReport,
  buildDojoLifecycleReport,
  buildDojoSourceAffordancePrPlan,
  buildDojoUniverseDossier,
  buildDojoUniverseMetrics,
} from "../browser/dojo_universe.js";
import { buildDojoGovernanceServiceView } from "../dojo/governance/service.js";
import { resolveHostedBrowserRuntime } from "../browser/hosted_runtime.js";
import { generatePrivateWorkflowToolManifest } from "../browser/private_tool_manifest.js";
import {
  mutationSafetyPlanFor,
  replayIsolationProfileManifestFor,
  replayIsolationProfiles,
} from "../browser/safety.js";
import type { WorkflowContractV7, WorkflowStepContractV7 } from "../browser/workflow.js";
import { AUTH_TOOL_NAMES, dispatchAuthTool } from "../tools/auth.js";
import { BROWSER_TOOL_NAMES, browserWorkflowOverlayAction, dispatchBrowserTool } from "../tools/browser.js";
import { DOJO_TOOL_NAMES, dispatchDojoTool } from "../tools/dojo.js";
import { SAFETY_TOOL_NAMES, dispatchSafetyTool } from "../tools/safety.js";
import { SOURCE_TOOL_NAMES, dispatchSourceTool } from "../tools/source.js";
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
  publishedAt?: string;
  lastTool?: string;
  lastToolAt?: string;
  latestCheckride?: Record<string, unknown>;
  latestDojoArtifactExport?: Record<string, unknown>;
  latestProof?: Record<string, unknown>;
  latestProofDryRun?: Record<string, unknown>;
  latestBlockExplanation?: Record<string, unknown>;
  latestPermissionUpgrade?: Record<string, unknown>;
  latestDojoUniverse?: Record<string, unknown>;
  latestDojoLifecycle?: Record<string, unknown>;
  latestDojoGovernance?: Record<string, unknown>;
  latestDojoMetrics?: Record<string, unknown>;
  latestDojoSourcePlan?: Record<string, unknown>;
  latestDojoTimeMachine?: Record<string, unknown>;
  latestDojoVivariumRun?: Record<string, unknown>;
  latestDojoWindTunnel?: Record<string, unknown>;
  latestDojoLicenseHealth?: Record<string, unknown>;
  latestDojoCaseLawRecord?: Record<string, unknown>;
  latestDojoLicenseRevocation?: Record<string, unknown>;
  history: BridgeHistoryEntry[];
}

interface BrowserWorkflowOverlayBody {
  action?: unknown;
  url?: unknown;
}

interface PreviewDiscoveryResult {
  ok: boolean;
  url?: string;
  error?: string;
  detail?: Record<string, unknown>;
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
  synthi_workflow_ci_replay: "synthi_safety_run_ci_isolated_replay",
  synthi_workflow_generate_playwright: "synthi_browser_generate_script",
  synthi_workflow_generate_tool_manifest: "synthi_browser_generate_private_tool_manifest",
  synthi_workflow_publish_tool: "synthi_dojo_publish_skill",
};

const WORKFLOW_BRIDGE_ALLOWED_TOOLS = new Set<string>([
  ...BROWSER_TOOL_NAMES,
  ...DOJO_TOOL_NAMES,
  ...AUTH_TOOL_NAMES,
  ...SOURCE_TOOL_NAMES,
  ...SAFETY_TOOL_NAMES,
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

class BridgeToolInputError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, detail: Record<string, unknown> = {}, status = 400) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

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
  if (!WORKFLOW_BRIDGE_ALLOWED_TOOLS.has(toolName) && !toolName.startsWith("synthi_app_")) return null;
  return (
    (await dispatchBrowserTool(toolName, args)) ??
    (await dispatchDojoTool(toolName, args)) ??
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

function authorizeBridgeRequest(
  req: http.IncomingMessage,
  opts: BrowserWorkflowBridgeOptions,
  host: string
): { ok: true } | { ok: false; status: number; error: string } {
  if (opts.token) {
    const supplied = stringHeader(req.headers["x-synthi-workflow-token"]);
    return supplied === opts.token ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
  }

  if (!isLoopbackHost(host)) {
    return { ok: false, status: 401, error: "workflow_bridge_token_required" };
  }

  const origin = stringHeader(req.headers.origin);
  if (!origin) return { ok: true };
  return isLoopbackOrigin(origin) ? { ok: true } : { ok: false, status: 403, error: "origin_not_allowed" };
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
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
    const preview = await discoverWorkspacePreviewUrl(base);
    if (preview.ok && preview.url) {
      return { ...base, preferred_url: preview.url, preview_url: preview.url };
    }
    if (!preview.ok) {
      throw new BridgeToolInputError(preview.error ?? "preview_discovery_failed", {
        tool: toolName,
        ...preview.detail,
      });
    }
  }
  return base;
}

async function discoverWorkspacePreviewUrl(args: Record<string, unknown>): Promise<PreviewDiscoveryResult> {
  const slug = workspaceSlugFromArgs(args);
  if (!slug) return { ok: true };
  const collab = resolveCollabServerUrl();
  if (!collab) {
    return {
      ok: false,
      error: "collab_server_url_required",
      detail: {
        workspace: slug,
        env: ["SYNTHI_COLLAB_SERVER_URL", "COLLAB_SERVER_URL", "NEXT_PUBLIC_COLLAB_SERVER_URL", "COLLAB_URL"],
      },
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`${collab.url}/ports?workspace=${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: "preview_discovery_failed",
        detail: { workspace: slug, collab_url: collab.url, collab_url_source: collab.source, status: response.status },
      };
    }
    const payload = await response.json() as Record<string, unknown>;
    const preview = previewUrlFromPortsPayload(payload, collab.url);
    if (preview) return { ok: true, url: preview };
    return {
      ok: false,
      error: "preview_not_found",
      detail: { workspace: slug, collab_url: collab.url, collab_url_source: collab.source },
    };
  } catch (err) {
    return {
      ok: false,
      error: "preview_discovery_failed",
      detail: {
        workspace: slug,
        collab_url: collab.url,
        collab_url_source: collab.source,
        message: err instanceof Error ? err.message : String(err),
      },
    };
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

function resolveCollabServerUrl(): { url: string; source: string } | null {
  const configured =
    envUrl("SYNTHI_COLLAB_SERVER_URL") ??
    envUrl("COLLAB_SERVER_URL") ??
    envUrl("NEXT_PUBLIC_COLLAB_SERVER_URL") ??
    envUrl("COLLAB_URL");
  return configured;
}

function envUrl(name: string): { url: string; source: string } | null {
  const value = stringOpt(process.env[name]);
  return value ? { url: value.replace(/\/$/, ""), source: name } : null;
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

function clearDojoUniverseState(state: BrowserWorkflowBridgeState): void {
  state.latestDojoUniverse = undefined;
  state.latestDojoLifecycle = undefined;
  state.latestDojoGovernance = undefined;
  state.latestDojoMetrics = undefined;
  state.latestDojoSourcePlan = undefined;
  state.latestDojoTimeMachine = undefined;
  state.latestDojoVivariumRun = undefined;
  state.latestDojoWindTunnel = undefined;
  state.latestDojoLicenseHealth = undefined;
  state.latestDojoCaseLawRecord = undefined;
  state.latestDojoLicenseRevocation = undefined;
}

function pushBridgeHistory(
  state: BrowserWorkflowBridgeState,
  startedAt: string,
  label: string,
  detail: string,
  status: string,
  statusLabel: string,
  tone: BridgeHistoryEntry["tone"]
): void {
  state.history = [{
    id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${Date.now()}`,
    label,
    detail,
    status,
    statusLabel,
    tone,
    startedAt,
  }, ...state.history].slice(0, MAX_HISTORY);
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
    state.publishedAt = undefined;
    state.latestCheckride = undefined;
    state.latestDojoArtifactExport = undefined;
    state.latestProof = undefined;
    state.latestProofDryRun = undefined;
    state.latestBlockExplanation = undefined;
    state.latestPermissionUpgrade = undefined;
    clearDojoUniverseState(state);
    state.history = [];
  }
  if (ok && toolName === "synthi_browser_begin_teach") {
    state.compiledAt = undefined;
    state.scriptGeneratedAt = undefined;
    state.manifestGeneratedAt = undefined;
    state.publishedAt = undefined;
    state.latestCheckride = undefined;
    state.latestDojoArtifactExport = undefined;
    state.latestProof = undefined;
    state.latestProofDryRun = undefined;
    state.latestBlockExplanation = undefined;
    state.latestPermissionUpgrade = undefined;
    clearDojoUniverseState(state);
    state.history = [];
  }
  if (ok && toolName === "synthi_browser_observe") state.lastObserveAt = now;
  if (ok && toolName === "synthi_browser_observe_preview") state.lastObserveAt = now;
  if (ok && (toolName === "synthi_browser_end_teach" || toolName === "synthi_browser_compile_workflow")) {
    state.compiledAt = now;
  }
  if (ok && toolName === "synthi_browser_generate_script") state.scriptGeneratedAt = now;
  if (ok && toolName === "synthi_browser_generate_private_tool_manifest") state.manifestGeneratedAt = now;
  if (ok && toolName === "synthi_dojo_run_checkride") {
    state.latestCheckride = payload;
    const checkride = payload["checkride"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `dojo_checkride_${Date.now()}`,
      label: "Dojo checkride",
      detail: stringOpt(checkride?.["entrustment_recommendation"]) ?? "Checkride completed",
      status: "passed",
      statusLabel: "Checked",
      tone: Number(checkride?.["critical_failures"] ?? 0) > 0 ? "warn" : "ok",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_browser_publish_private_tool") {
    state.manifestGeneratedAt = state.manifestGeneratedAt ?? now;
    state.publishedAt = now;
    const toolNameValue = stringOpt(payload["tool_name"]) ?? "private workflow tool";
    const entry: BridgeHistoryEntry = {
      id: `workflow_publish_${Date.now()}`,
      label: "Private MCP tool published",
      detail: toolNameValue,
      status: "passed",
      statusLabel: "Published",
      tone: "ok",
      startedAt: now,
    };
    state.history = [
      entry,
      ...state.history,
    ].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_dojo_publish_skill") {
    state.manifestGeneratedAt = state.manifestGeneratedAt ?? now;
    state.publishedAt = now;
    const skill = payload["skill"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `dojo_publish_${Date.now()}`,
      label: "Dojo skill licensed",
      detail: stringOpt(skill?.["skill_id"]) ?? stringOpt(skill?.["name"]) ?? "Licensed competency",
      status: "passed",
      statusLabel: "Licensed",
      tone: "ok",
      startedAt: now,
    };
    state.history = [
      entry,
      ...state.history,
    ].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_dojo_export_artifacts") {
    state.latestDojoArtifactExport = payload;
    const entry: BridgeHistoryEntry = {
      id: `dojo_export_${Date.now()}`,
      label: "Dojo artifacts exported",
      detail: `${Number(payload["artifact_count"] ?? 0)} files`,
      status: "passed",
      statusLabel: "Exported",
      tone: "ok",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_dojo_issue_proof_capsule") {
    state.latestProof = payload;
    const capsule = payload["proof_capsule"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `dojo_proof_${Date.now()}`,
      label: "Proof capsule issued",
      detail: stringOpt(capsule?.["capsule_id"]) ?? "Proof capsule",
      status: "passed",
      statusLabel: "Issued",
      tone: "ok",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (toolName === "synthi_dojo_run_with_proof_capsule") {
    state.latestProofDryRun = payload;
    const validation = payload["validation"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `dojo_proof_run_${Date.now()}`,
      label: boolPayload(payload["dry_run"]) ? "Proof dry-run" : "Proof-gated run",
      detail: stringOpt(validation?.["status"]) ?? (ok ? "Validated" : "Blocked"),
      status: ok ? "passed" : "blocked",
      statusLabel: ok ? "Proof" : "Blocked",
      tone: ok ? "ok" : "warn",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (toolName === "synthi_dojo_explain_block") {
    state.latestBlockExplanation = payload;
    const validation = payload["validation"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `dojo_block_${Date.now()}`,
      label: "Dojo block explained",
      detail: stringOpt(payload["refusal"]) ?? stringOpt(validation?.["error"]) ?? "License explanation",
      status: "blocked",
      statusLabel: "Explained",
      tone: "warn",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_dojo_request_permission_upgrade") {
    state.latestPermissionUpgrade = payload;
    const steps = Array.isArray(payload["required_steps"]) ? payload["required_steps"] : [];
    const entry: BridgeHistoryEntry = {
      id: `dojo_upgrade_${Date.now()}`,
      label: "Dojo upgrade path",
      detail: steps.slice(0, 2).join(", ") || "No upgrade required",
      status: "passed",
      statusLabel: "Scoped",
      tone: steps.includes("no_upgrade_required_for_current_license") ? "ok" : "warn",
      startedAt: now,
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
  }
  if (ok && toolName === "synthi_dojo_get_universe_dossier") {
    state.latestDojoUniverse = payload;
    pushBridgeHistory(state, now, "Dojo universe", "Vivarium Cortex dossier", "passed", "Dossier", "ok");
  }
  if (ok && toolName === "synthi_dojo_get_lifecycle") {
    state.latestDojoLifecycle = payload;
    const lifecycle = payload["lifecycle"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "Dojo lifecycle", stringOpt(lifecycle?.["status"]) ?? "Lifecycle report", "passed", "Lifecycle", "ok");
  }
  if (ok && toolName === "synthi_dojo_get_governance_report") {
    state.latestDojoGovernance = payload;
    pushBridgeHistory(state, now, "Dojo governance", "Policy gates and audit report", "passed", "Governed", "ok");
  }
  if (ok && toolName === "synthi_dojo_get_metrics") {
    state.latestDojoMetrics = payload;
    pushBridgeHistory(state, now, "Dojo metrics", "Universe metrics refreshed", "passed", "Metrics", "ok");
  }
  if (ok && toolName === "synthi_dojo_get_source_affordance_pr_plan") {
    state.latestDojoSourcePlan = payload;
    const plan = payload["source_affordance_pr_plan"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "Agent-ready UI plan", `${Number(plan?.["patch_count"] ?? 0)} patches`, "passed", "Source", "ok");
  }
  if (ok && toolName === "synthi_dojo_run_time_machine_debugger") {
    state.latestDojoTimeMachine = payload;
    pushBridgeHistory(state, now, "Dojo time machine", "Counterfactual branch replayed", "passed", "Debugged", "ok");
  }
  if (ok && toolName === "synthi_dojo_run_vivarium_scenario") {
    state.latestDojoVivariumRun = payload;
    const run = payload["vivarium_run"] as Record<string, unknown> | undefined;
    const scenario = run?.["scenario"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "Vivarium scenario", stringOpt(scenario?.["mutation_kind"]) ?? "Synthetic run", "passed", "Practiced", "ok");
  }
  if (ok && toolName === "synthi_dojo_run_wind_tunnel") {
    state.latestDojoWindTunnel = payload;
    const tunnel = payload["wind_tunnel_execution"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "Workflow wind tunnel", `${Number(tunnel?.["run_count"] ?? 0)} runs`, "passed", "Practiced", "ok");
  }
  if (ok && toolName === "synthi_dojo_get_license_health") {
    state.latestDojoLicenseHealth = payload;
    const health = payload["license_health"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "License health", stringOpt(health?.["status"]) ?? "Health report", "passed", "Health", "ok");
  }
  if (ok && toolName === "synthi_dojo_record_case_law") {
    state.latestDojoCaseLawRecord = payload;
    const caseLaw = payload["case_law"] as Record<string, unknown> | undefined;
    pushBridgeHistory(state, now, "Case law recorded", stringOpt(caseLaw?.["title"]) ?? "Binding guardrail", "passed", "Case law", "warn");
  }
  if (ok && toolName === "synthi_dojo_review_case_law") {
    state.latestDojoCaseLawRecord = payload;
    state.latestDojoGovernance = payload;
    const record = recordAt(payload, "case_law_record");
    const review = recordAt(payload, "review");
    const status = stringOpt(record?.["status"]) ?? stringOpt(review?.["decision"]) ?? "reviewed";
    const title = stringOpt(record?.["title"]) ?? stringOpt(record?.["case_id"]) ?? "Case law";
    pushBridgeHistory(
      state,
      now,
      status === "deprecated" ? "Case law deprecated" : "Case law reviewed",
      title,
      status === "deprecated" ? "blocked" : "passed",
      status === "deprecated" ? "Deprecated" : "Reviewed",
      status === "deprecated" ? "warn" : "ok"
    );
  }
  if (ok && toolName === "synthi_dojo_revoke_license") {
    state.latestDojoLicenseRevocation = payload;
    state.latestDojoLicenseHealth = payload;
    pushBridgeHistory(state, now, "Dojo license revoked", stringOpt(payload["reason"]) ?? "Recertification required", "blocked", "Revoked", "warn");
  }
  if (toolName === "synthi_safety_run_prefix_validation" || toolName === "synthi_browser_run_workflow" || toolName === "synthi_safety_run_ci_isolated_replay") {
    const validation = payload["validation"] as Record<string, unknown> | undefined;
    const replay = payload["replay"] as Record<string, unknown> | undefined;
    const entry: BridgeHistoryEntry = {
      id: `workflow_run_${Date.now()}`,
      label: toolName === "synthi_safety_run_prefix_validation"
        ? "Prefix validation"
        : toolName === "synthi_safety_run_ci_isolated_replay"
        ? "CI isolated replay"
        : "Workflow replay",
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

function consentForPanelState(url: string | null | undefined) {
  if (!url) return undefined;
  try {
    return browserBroker.getConsent(url)[0];
  } catch {
    return undefined;
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
  const workspaceId = runtime?.workspace_id ?? stringOpt(process.env["SYNTHI_WORKSPACE_ID"]);
  const isolationProfile = replayIsolationProfiles.get(workspaceId);
  const workspaceUrl = selected?.url ?? runtime?.workspace_url ?? null;
  const consent = consentForPanelState(workspaceUrl);
  const screenshotAllowed = consent?.status === "granted" && consent.screenshot === "granted";
  const observed = Boolean(bridgeState.lastObserveAt) || Boolean(selected && screenshotAllowed);
  const traceReady = workflow.contract.steps.length > 0;
  const compiled = Boolean(bridgeState.compiledAt);
  const scriptGenerated = Boolean(bridgeState.scriptGeneratedAt) && traceReady;
  const sourceCoverage = workflow.contract.sourceIdentityCoverage;
  const publish = workflow.contract.publishPlan;
  const recordingIssues = browserBroker.recordingIssueSnapshot();
  const dojoState = dojoPanelStateFor(workflow.contract, workspaceId, bridgeState);

  return {
    workspaceLabel: workspaceId ?? "Current workspace",
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
    dojo: dojoState,
    governanceService: dojoState.governanceService ?? null,
    steps: workflow.contract.steps.map(panelStepForContract),
    unresolvedSteps: workflow.contract.steps
      .filter((step) => step.limitations.some((limitation) => REVIEW_LIMITATIONS.has(limitation)))
      .map((step) => ({
        id: step.stepId,
        label: step.label,
        detail: step.limitations.length
          ? `Needs publish hardening: ${step.limitations.join(", ")}.`
          : "Needs hardening before unattended replay.",
      }))
      .concat(recordingIssues.filter((issue) => issue.blocking).map(panelRecordingIssue)),
    blockers: workflow.contract.limitations.map((limitation) => ({
      id: `limitation_${limitation}`,
      label: limitation,
      detail: limitationDetail(limitation),
    })),
    history: bridgeState.history ?? [],
    isolation_profile: isolationProfile,
    profile_manifest: replayIsolationProfileManifestFor(isolationProfile),
    mutation_plan: mutationSafetyPlanFor(workflow.contract, isolationProfile),
    diagnostics: {
      eventCount: trace.length,
      authorizedTabCount: tabs.length,
      lane0,
      replayWarnings: prefixPlan.warnings,
      recordingIssues,
      generatedAt: {
        compiledAt: bridgeState.compiledAt ?? null,
      scriptGeneratedAt: bridgeState.scriptGeneratedAt ?? null,
      manifestGeneratedAt: bridgeState.manifestGeneratedAt ?? null,
      publishedAt: bridgeState.publishedAt ?? null,
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

    if (url === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("ok\n");
      return;
    }

    if (url.startsWith("/browser-workflows/")) {
      const auth = authorizeBridgeRequest(req, opts, host);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }
    }

    if (url === "/browser-workflows/state" && method === "GET") {
      writeJson(res, 200, { ok: true, state: buildBrowserWorkflowPanelState(bridgeState) });
      return;
    }

    if (url === "/browser-workflows/overlay" && method === "POST") {
      let body: BrowserWorkflowOverlayBody;
      try {
        body = await readJsonBody(req, 20_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, { ok: false, status: "error", label: "Overlay failed", error: "invalid_body", detail: msg });
        return;
      }
      const action = body.action;
      if (action !== "state" && action !== "observe" && action !== "teach" && action !== "stop") {
        writeJson(res, 400, { ok: false, status: "error", label: "Overlay failed", error: "invalid_overlay_action" });
        return;
      }
      const pageUrl = typeof body.url === "string" ? body.url : "";
      const selected = browserBroker.selectedTab();
      const tabId = action === "observe" ? "" : selected?.tab_id ?? "";
      const result = await browserWorkflowOverlayAction({
        action,
        ...(pageUrl ? { url: pageUrl } : {}),
        tab_id: tabId,
        page_url: pageUrl,
      });
      writeJson(res, result.ok ? 200 : 400, result);
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
      let args: Record<string, unknown>;
      try {
        args = await enrichToolArgs(tool, body.arguments);
      } catch (err) {
        if (err instanceof BridgeToolInputError) {
          writeJson(res, err.status, {
            ok: false,
            error: err.code,
            requested_tool: requestedTool,
            tool,
            ...err.detail,
            state: buildBrowserWorkflowPanelState(bridgeState),
          });
          return;
        }
        throw err;
      }
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

function panelRecordingIssue(issue: BrowserRecordingIssue): { id: string; label: string; detail: string; [key: string]: unknown } {
  const targetOrigin = issue.frame_origin ?? issue.popup_origin ?? issue.origin;
  return {
    id: issue.issue_id,
    label: recordingIssueLabel(issue.error),
    title: recordingIssueLabel(issue.error),
    detail: targetOrigin
      ? `${issue.error}: grant consent or keep teaching inside ${targetOrigin}.`
      : `${issue.error}: the runtime could not record this taught action.`,
    source: issue.source,
    action: issue.action,
    origin: issue.origin,
    frameOrigin: issue.frame_origin,
    popupOrigin: issue.popup_origin,
  };
}

function recordingIssueLabel(error: string): string {
  switch (error) {
    case "frame_origin_consent_required":
      return "Frame consent required";
    case "popup_origin_consent_required":
      return "Popup consent required";
    case "teach_tab_mismatch":
      return "Different tab was used";
    case "teach_origin_mismatch":
      return "Different origin was used";
    case "origin_consent_required":
      return "Origin consent required";
    default:
      return "Recording issue";
  }
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

function dojoPanelStateFor(
  contract: WorkflowContractV7,
  workspaceId: string | undefined,
  bridgeState: Partial<BrowserWorkflowBridgeState> = {}
): Record<string, unknown> {
  const published = dojoSkillRegistry.getByWorkflowId(contract.workflowId);
  const skill = published ?? (contract.steps.length > 0
    ? buildDojoSkill(contract, {
        workspace_id: workspaceId,
        private_tool_manifest: generatePrivateWorkflowToolManifest(contract),
        now: "1970-01-01T00:00:00.000Z",
      })
    : null);

  if (!skill) {
    return {
      status: "notStarted",
      label: "No Dojo skill",
      detail: "Teach a workflow before Dojo can create a skill seed.",
      published: false,
    };
  }

  const lifecycle = recordAt(bridgeState.latestDojoLifecycle, "lifecycle") ?? buildDojoLifecycleReport(skill) as unknown as Record<string, unknown>;
  const governance = recordAt(bridgeState.latestDojoGovernance, "governance_report") ?? buildDojoGovernanceReport(skill) as unknown as Record<string, unknown>;
  const governanceService = recordAt(bridgeState.latestDojoGovernance, "governance_service")
    ?? buildDojoGovernanceServiceView({
      skills: dojoSkillRegistry.list(),
    }) as unknown as Record<string, unknown>;
  const metrics = recordAt(bridgeState.latestDojoMetrics, "metrics") ?? buildDojoUniverseMetrics([skill]) as unknown as Record<string, unknown>;
  const sourcePlan = recordAt(bridgeState.latestDojoSourcePlan, "source_affordance_pr_plan")
    ?? buildDojoSourceAffordancePrPlan(skill) as unknown as Record<string, unknown>;
  const universe = recordAt(bridgeState.latestDojoUniverse, "universe_dossier")
    ?? buildDojoUniverseDossier(skill, dojoSkillRegistry.list()) as unknown as Record<string, unknown>;

  return {
    status: published ? "licensed" : "draft",
    label: published ? skill.skill_card.status : "Checkride preview",
    detail: published
      ? "This workflow has a licensed Dojo competency."
      : "Dojo can run a checkride and issue a scoped license from this taught workflow.",
    published: Boolean(published),
    skillId: skill.skill_id,
    workflowId: skill.workflow_id,
    skillCard: skill.skill_card,
    skillPassport: skill.skill_passport,
    entrustmentLevel: skill.entrustment_level,
    readinessLevel: skill.skill_readiness_level,
    proofRequired: skill.skill_passport.proof_required,
    artifactCount: Number(bridgeState.latestDojoArtifactExport?.["artifact_count"] ?? 0),
    licenseExpiresAt: skill.license_expires_at,
    attackSuccessRate: skill.attack_success_rate,
    proof: proofPanelState(bridgeState.latestProof),
    proofDryRun: proofRunPanelState(bridgeState.latestProofDryRun),
    blockExplanation: blockExplanationPanelState(bridgeState.latestBlockExplanation),
    permissionUpgrade: permissionUpgradePanelState(bridgeState.latestPermissionUpgrade),
    universe: universePanelState(universe),
    lifecycle: lifecyclePanelState(lifecycle),
    governance: governancePanelState(governance),
    governanceService,
    metrics: metricsPanelState(metrics),
    sourceAffordancePrPlan: sourceAffordancePanelState(sourcePlan),
    timeMachine: timeMachinePanelState(bridgeState.latestDojoTimeMachine),
    vivariumRun: vivariumRunPanelState(bridgeState.latestDojoVivariumRun),
    windTunnel: windTunnelPanelState(bridgeState.latestDojoWindTunnel),
    licenseHealth: licenseHealthPanelState(bridgeState.latestDojoLicenseHealth, lifecycle),
    caseLawRecord: caseLawRecordPanelState(bridgeState.latestDojoCaseLawRecord),
    publishedToolName: skill.published_tool_name ?? null,
    checkride: {
      checkrideId: skill.checkride.checkride_id,
      coverageScore: skill.checkride.coverage_score,
      criticalFailures: skill.checkride.critical_failures,
      blockedScenarios: skill.checkride.blocked_scenarios,
      knowledge: skill.checkride.knowledge,
      risk: skill.checkride.risk,
      skill: skill.checkride.skill,
    },
    license: {
      licenseId: skill.permission_license.license_id,
      allowedActions: skill.permission_license.allowed_actions.map((action) => action.action),
      gatedActions: skill.permission_license.gated_actions.map((action) => action.action),
      blockedActions: skill.permission_license.blocked_actions.map((action) => action.action),
    },
    guardrails: skill.guardrails.slice(0, 4).map((guardrail) => ({
      id: guardrail.guardrail_id,
      title: guardrail.title,
      rule: guardrail.rule,
      severity: guardrail.severity,
    })),
    caseLawCount: skill.case_law.length,
    scenarioCount: skill.scenarios.length,
  };
}

function proofPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const capsule = payload["proof_capsule"] as Record<string, unknown> | undefined;
  const validation = payload["validation"] as Record<string, unknown> | undefined;
  return {
    capsuleId: stringOpt(capsule?.["capsule_id"]) ?? null,
    requestedAction: stringOpt(payload["requested_action"]) ?? stringOpt(capsule?.["requested_action"]) ?? null,
    status: stringOpt(validation?.["status"]) ?? null,
  };
}

function proofRunPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const validation = payload["validation"] as Record<string, unknown> | undefined;
  return {
    dryRun: boolPayload(payload["dry_run"]),
    status: stringOpt(validation?.["status"]) ?? (payload["ok"] === true ? "allowed" : null),
  };
}

function blockExplanationPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const validation = payload["validation"] as Record<string, unknown> | undefined;
  return {
    status: stringOpt(validation?.["status"]) ?? null,
    refusal: stringOpt(payload["refusal"]) ?? null,
  };
}

function permissionUpgradePanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  return {
    requiredSteps: Array.isArray(payload["required_steps"]) ? payload["required_steps"].filter((item): item is string => typeof item === "string") : [],
  };
}

function universePanelState(dossier: Record<string, unknown>): Record<string, unknown> {
  const packages = dossier["package_readiness"] as Record<string, unknown> | undefined;
  const enterprise = Array.isArray(packages?.["enterprise"]) ? packages?.["enterprise"] as Array<Record<string, unknown>> : [];
  const personal = Array.isArray(packages?.["personal"]) ? packages?.["personal"] as Array<Record<string, unknown>> : [];
  return {
    status: stringOpt(recordAt(dossier, "lifecycle")?.["status"]) ?? "draft",
    enterpriseReady: enterprise.filter((item) => item["status"] === "ready").length,
    enterpriseTotal: enterprise.length,
    personalReady: personal.filter((item) => item["status"] === "ready").length,
    personalTotal: personal.length,
  };
}

function lifecyclePanelState(lifecycle: Record<string, unknown>): Record<string, unknown> {
  const recertification = recordAt(lifecycle, "recertification");
  return {
    status: stringOpt(lifecycle["status"]) ?? "draft",
    daysUntilExpiry: numberOpt(lifecycle["days_until_expiry"]),
    recertificationRequired: recertification?.["required"] === true,
    gates: Array.isArray(lifecycle["release_gates"]) ? lifecycle["release_gates"] : [],
  };
}

function governancePanelState(governance: Record<string, unknown>): Record<string, unknown> {
  const audit = recordAt(governance, "audit_report");
  return {
    approvalCount: Array.isArray(governance["approval_queue"]) ? governance["approval_queue"].length : 0,
    policyGateCount: Array.isArray(governance["policy_gates"]) ? governance["policy_gates"].length : 0,
    evidenceClaims: Array.isArray(audit?.["evidence_claims"]) ? audit?.["evidence_claims"] : [],
    blockedActions: Array.isArray(audit?.["blocked_actions"]) ? audit?.["blocked_actions"] : [],
  };
}

function metricsPanelState(metrics: Record<string, unknown>): Record<string, unknown> {
  const technical = recordAt(metrics, "technical");
  const business = recordAt(metrics, "business");
  const trust = recordAt(metrics, "trust");
  return {
    skillCount: numberOpt(metrics["skill_count"]) ?? 0,
    coverage: numberOpt(technical?.["average_coverage_score"]) ?? 0,
    attackSuccessRate: numberOpt(technical?.["average_attack_success_rate"]) ?? 0,
    mcpBackedSkillCount: numberOpt(business?.["mcp_backed_skill_count"]) ?? 0,
    proofRequiredPercent: numberOpt(trust?.["proof_required_percent"]) ?? 0,
    staleLicenseCount: numberOpt(trust?.["stale_or_expired_license_count"]) ?? 0,
  };
}

function sourceAffordancePanelState(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    readiness: stringOpt(plan["readiness"]) ?? "not_ready",
    patchCount: numberOpt(plan["patch_count"]) ?? 0,
    generatedTests: Array.isArray(plan["generated_tests"]) ? plan["generated_tests"] : [],
  };
}

function timeMachinePanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const report = recordAt(payload, "time_machine_debugger");
  if (!report) return null;
  const baseline = recordAt(report, "baseline");
  const counterfactual = recordAt(report, "counterfactual");
  return {
    baselineStatus: stringOpt(baseline?.["status"]) ?? null,
    mutationKind: stringOpt(baseline?.["mutation_kind"]) ?? null,
    changedVariable: stringOpt(counterfactual?.["changed_variable"]) ?? null,
    expectedStatusAfterChange: stringOpt(counterfactual?.["expected_status_after_change"]) ?? null,
  };
}

function vivariumRunPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const run = recordAt(payload, "vivarium_run");
  if (!run) return null;
  const scenario = recordAt(run, "scenario");
  const result = recordAt(run, "result");
  return {
    scenarioTitle: stringOpt(scenario?.["title"]) ?? null,
    mutationKind: stringOpt(scenario?.["mutation_kind"]) ?? null,
    status: stringOpt(result?.["status"]) ?? null,
    syntheticDataOnly: recordAt(run, "materialized_fixture")?.["synthetic_data_only"] === true,
  };
}

function windTunnelPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const tunnel = recordAt(payload, "wind_tunnel_execution");
  if (!tunnel) return null;
  return {
    runCount: numberOpt(tunnel["run_count"]) ?? 0,
    passCount: numberOpt(tunnel["pass_count"]) ?? 0,
    failCount: numberOpt(tunnel["fail_count"]) ?? 0,
    blockedCount: numberOpt(tunnel["blocked_count"]) ?? 0,
    stopReason: stringOpt(tunnel["stop_reason"]) ?? null,
  };
}

function licenseHealthPanelState(payload: Record<string, unknown> | undefined, lifecycle: Record<string, unknown>): Record<string, unknown> {
  const health = recordAt(payload, "license_health") ?? payload;
  const proofRecords = recordAt(health, "proof_records");
  return {
    status: stringOpt(health?.["status"]) ?? stringOpt(lifecycle["status"]) ?? "draft",
    daysUntilExpiry: numberOpt(health?.["days_until_expiry"]) ?? numberOpt(lifecycle["days_until_expiry"]),
    proofRecords: proofRecords ?? {},
  };
}

function caseLawRecordPanelState(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const caseLaw = recordAt(payload, "case_law") ?? recordAt(payload, "case_law_record");
  const guardrail = recordAt(payload, "guardrail");
  if (!caseLaw && !guardrail) return null;
  return {
    title: stringOpt(caseLaw?.["title"]) ?? null,
    status: stringOpt(caseLaw?.["status"]) ?? null,
    guardrailTitle: stringOpt(guardrail?.["title"]) ?? null,
  };
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boolPayload(value: unknown): boolean {
  return value === true;
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
