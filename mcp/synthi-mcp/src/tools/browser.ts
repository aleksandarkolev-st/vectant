import { authCheckpointManager, type AuthBrowserStorageState, type AuthReadiness, type AuthStorageArtifactMetadata } from "../browser/auth.js";
import { browserBroker } from "../browser/broker.js";
import { browserBridgeServer } from "../browser/bridge_server.js";
import { browserWorkflowDeploymentReadiness } from "../browser/deployment_readiness.js";
import { buildDojoSkill, dojoSkillRegistry } from "../browser/dojo.js";
import { attachHostedBrowserRuntime, resolveHostedBrowserRuntime } from "../browser/hosted_runtime.js";
import { generatePrivateWorkflowToolManifest, type PrivateWorkflowToolManifestV7 } from "../browser/private_tool_manifest.js";
import {
  privateWorkflowToolParameterArgNames,
  privateWorkflowToolDefinition,
  privateWorkflowToolRegistry,
  type PrivateWorkflowToolRegistration,
} from "../browser/private_tool_registry.js";
import { isBrowserPreviewUrlAllowed, resolveBrowserPreviewTarget } from "../browser/preview_target.js";
import { browserPlaywrightAdapter, type BrowserWorkflowOverlayResponse } from "../browser/playwright_adapter.js";
import {
  classifyWorkflowReplayBlock,
  classifyWorkflowReplayFailure,
  normalizeReplayMode,
  type AuthDurabilityV7,
  type FailureClassV7,
  type WorkflowContractV7,
  type WorkflowReplayModeV7,
  type WorkflowStepContractV7,
} from "../browser/workflow.js";
import {
  detectBrowserProject,
  projectRunStatus,
  runBrowserProject,
  stopBrowserProject,
} from "../browser/project_runner.js";
import { BROWSER_ACTION_KINDS } from "../browser/types.js";
import type { BrowserActionKind, BrowserTraceEvent } from "../browser/types.js";
import {
  createDojoExecutionPolicyGate,
  type DojoExecutionPolicyDecision,
  type DojoPublishedSkillBinding,
  type DojoTenantContext,
} from "../dojo/mcp/execution_policy_gate.js";
import { resolveDojoEnforcementConfig } from "../dojo/config/enforcement.js";
import { eventLog } from "../events/index.js";
import { ADVERTISED_TOOLS } from "../tool_registry.js";
import { dispatchSafetyTool } from "./safety.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

const DOJO_ARTIFACT_EXECUTION_MODE_ENV = "SYNTHI_DOJO_ARTIFACT_EXECUTION_MODE";
const DOJO_ARTIFACT_ALLOWED_EXECUTION_MODES = ["practice", "test", "ci"] as const;

browserPlaywrightAdapter.setTeachEventSink((event) => {
  if (event.action === "navigate") {
    browserBroker.handleOriginChange(event.tab_id, event.url, event.detail);
    return;
  }
  const result = browserBroker.recordHumanAction(event);
  if (!result.ok) browserBroker.recordTeachRecordingIssue(result.error, event, "hosted-playwright-adapter");
});

browserPlaywrightAdapter.setTeachEventAnnotationSink((event) => {
  const result = browserBroker.annotateLatestHumanAction(event);
  if (!result.ok) browserBroker.recordTeachRecordingIssue(result.error, event, "hosted-playwright-annotation");
});

browserPlaywrightAdapter.setWorkflowOverlayActionSink(async (request) => {
  return browserWorkflowOverlayAction(request);
});

export async function browserWorkflowOverlayAction(input: {
  action: "state" | "observe" | "teach" | "stop";
  url?: string;
  tab_id: string;
  page_url: string;
}): Promise<BrowserWorkflowOverlayResponse> {
  const runtime = browserBroker.runtimeAttachment();
  if (runtime?.kind !== "hosted") {
    return {
      ok: false,
      status: "error",
      label: "Hosted only",
      detail: "Workflow controls are available in the Synthi-hosted browser runtime.",
      recording: false,
      observed: false,
      stepCount: 0,
    };
  }

  if (input.action === "state") return workflowOverlayStatus({ ok: true }, input.tab_id);

  if (input.action === "observe") {
    const targetUrl = httpUrlOpt(input.url ?? input.page_url);
    if (!targetUrl) {
      return {
        ok: false,
        status: "error",
        label: "Observe failed",
        detail: "The current page is not an HTTP preview URL.",
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: "invalid_preview_url",
      };
    }
    if (!isBrowserPreviewUrlAllowed(targetUrl, { workspace_url: runtime.workspace_url ?? undefined })) {
      return {
        ok: false,
        status: "error",
        label: "Observe blocked",
        detail: "The current page does not match this workspace's preview policy.",
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: "preview_target_not_allowed",
      };
    }
    const response = await browserObservePreviewTool({
      workspace_url: runtime.workspace_url ?? input.page_url,
      preferred_url: targetUrl,
      preview_url: targetUrl,
    }, { userGesture: true });
    if (response.isError) return workflowOverlayError("Observe failed", response);
    return workflowOverlayStatus({ ok: true, label: "Observed" }, input.tab_id);
  }

  if (input.action === "teach") {
    const targetUrl = httpUrlOpt(input.page_url ?? input.url);
    if (!targetUrl) {
      return {
        ok: false,
        status: "error",
        label: "Teach failed",
        detail: "The current page is not an HTTP preview URL.",
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: "invalid_preview_url",
      };
    }
    if (!isBrowserPreviewUrlAllowed(targetUrl, { workspace_url: runtime.workspace_url ?? undefined })) {
      return {
        ok: false,
        status: "error",
        label: "Teach blocked",
        detail: "The current page does not match this workspace's preview policy.",
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: "preview_target_not_allowed",
      };
    }
    const targetInput = {
      workspace_url: runtime.workspace_url ?? input.page_url,
      preferred_url: targetUrl,
      preview_url: targetUrl,
    };
    const allTabs = await browserPlaywrightAdapter.listTabs();
    const target = resolveBrowserPreviewTarget(allTabs, targetInput, process.env);
    if (!target.ok) {
      return {
        ok: false,
        status: "error",
        label: "Teach failed",
        detail: target.reason,
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: target.error,
      };
    }
    browserBroker.requestConsent(target.tab.url, "granted", "workspace_preview_teach_user_gesture", {
      screenshot: true,
      diagnostics: false,
    });
    browserBroker.registerTabs(allTabs);
    const selected = browserBroker.selectTab(target.tab.tab_id);
    if (!selected) {
      return {
        ok: false,
        status: "error",
        label: "Teach failed",
        detail: "The current preview tab is not authorized for workflow teaching.",
        recording: browserBroker.teachState().active,
        observed: false,
        stepCount: browserBroker.compiledWorkflow().card.stepCount,
        error: "tab_not_authorized",
      };
    }
    await browserPlaywrightAdapter.selectTab(target.tab.tab_id);
    const response = await browserBeginTeachTool({
      tab_id: selected?.tab_id ?? input.tab_id,
      goal: `Teach workflow for ${runtime.workspace_id || "current workspace"}`,
    });
    if (response.isError) return workflowOverlayError("Teach failed", response);
    return workflowOverlayStatus({ ok: true, label: "Recording" }, input.tab_id);
  }

  const response = browserEndTeachTool({ reason: "overlay_stopped" });
  if (response.isError) return workflowOverlayError("Stop failed", response);
  return workflowOverlayStatus({ ok: true, label: "Stopped" }, input.tab_id);
}

function workflowOverlayStatus(base: Partial<BrowserWorkflowOverlayResponse> = {}, tabId?: string): BrowserWorkflowOverlayResponse {
  const teach = browserBroker.teachState();
  const selected = browserBroker.selectedTab();
  const workflow = browserBroker.compiledWorkflow();
  const lastAction = lastWorkflowAction(browserBroker.traceSnapshot(), tabId);
  const selectedMatchesOverlay = Boolean(selected && (!tabId || selected.tab_id === tabId));
  const consent = selectedMatchesOverlay && selected ? browserBroker.getConsent(selected.url)[0] : undefined;
  const observed = Boolean(selectedMatchesOverlay && selected && consent?.status === "granted" && consent.screenshot === "granted");
  const recording = teach.active && (!tabId || teach.tab_id === tabId);
  return {
    ok: base.ok ?? true,
    status: recording ? "recording" : observed ? "observed" : "idle",
    label: base.label ?? (recording ? "Recording" : observed ? "Observed" : "Ready"),
    detail: base.detail ?? (recording
      ? "Events are being captured for this workflow."
      : observed && selected
      ? `Selected ${selected.title || selected.url || "preview"}.`
      : "Use Observe before teaching a workflow."),
    recording,
    observed,
    stepCount: workflow.card.stepCount,
    ...(lastAction ? { lastAction: lastAction.action, lastTarget: lastAction.target } : {}),
    ...(observed && selected?.url ? { url: selected.url } : {}),
  };
}

function lastWorkflowAction(trace: BrowserTraceEvent[], tabId?: string): { action: string; target: string } | null {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (!event || (event.kind !== "human_action" && event.kind !== "agent_action" && event.kind !== "navigation")) continue;
    if (tabId && event.tab_id !== tabId) continue;
    const action = event.action ?? (event.kind === "navigation" ? "navigate" : event.kind);
    return {
      action: humanActionLabel(action),
      target: boundedTargetLabel(event),
    };
  }
  return null;
}

function humanActionLabel(action: string): string {
  switch (action) {
    case "fill":
      return "Filled";
    case "click":
      return "Clicked";
    case "dblclick":
      return "Double-clicked";
    case "contextmenu":
      return "Opened context menu";
    case "check":
      return "Checked";
    case "uncheck":
      return "Unchecked";
    case "select":
      return "Selected";
    case "press":
      return "Pressed";
    case "drag":
      return "Dragged";
    case "scroll":
      return "Scrolled";
    case "copy":
      return "Copied";
    case "cut":
      return "Cut";
    case "hover":
      return "Hovered";
    case "navigate":
      return "Opened";
    default:
      return action.slice(0, 1).toUpperCase() + action.slice(1);
  }
}

function boundedTargetLabel(event: BrowserTraceEvent): string {
  const element = event.detail?.["element"];
  const elementRecord = element && typeof element === "object" && !Array.isArray(element) ? element as Record<string, unknown> : {};
  const candidate = [
    stringOpt(event.detail?.["field_name"]),
    stringOpt(elementRecord["label"]),
    stringOpt(elementRecord["name"]),
    stringOpt(elementRecord["placeholder"]),
    stringOpt(elementRecord["test_id"]),
    stringOpt(elementRecord["id"]),
    stringOpt(event.selector),
  ].find((value) => value && value.length > 0);
  return candidate ? candidate.replace(/\s+/g, " ").slice(0, 64) : "target";
}

function workflowOverlayError(label: string, response: ToolResponse): BrowserWorkflowOverlayResponse {
  const payload = response.structuredContent ?? {};
  const detail =
    typeof payload["error"] === "string" ? payload["error"] :
    typeof payload["message"] === "string" ? payload["message"] :
    label;
  return {
    ok: false,
    status: "error",
    label,
    detail,
    recording: browserBroker.teachState().active,
    observed: false,
    stepCount: browserBroker.compiledWorkflow().card.stepCount,
    error: detail,
  };
}

export const BROWSER_TOOL_NAMES = [
  "synthi_browser_attach_current_workspace",
  "synthi_browser_revoke_hosted_runtime_session",
  "synthi_browser_observe",
  "synthi_browser_observe_preview",
  "synthi_browser_begin_teach",
  "synthi_browser_end_teach",
  "synthi_browser_attach",
  "synthi_browser_list_tabs",
  "synthi_browser_select_tab",
  "synthi_browser_open",
  "synthi_browser_close_tab",
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
  "synthi_browser_generate_private_tool_manifest",
  "synthi_browser_publish_private_tool",
  "synthi_browser_get_private_tool_manifest",
  "synthi_browser_capture_auth_checkpoint_storage",
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
  "synthi_browser_get_deployment_readiness",
] as const;

export const BROWSER_TOOLS = [
  {
    name: "synthi_browser_attach_current_workspace",
    description:
      "Attach the agent to the Synthi-hosted browser for the current workspace. This is the primary cloud IDE path; it never requires the user to provide local Chrome, local CDP, or a desktop extension.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Optional tenant scope. Defaults to SYNTHI_TENANT_ID." },
        workspace_id: { type: "string", description: "Optional workspace scope. Defaults to SYNTHI_WORKSPACE_ID or the active/default workspace." },
        actor_id: { type: "string", description: "Optional actor scope for runtime audit. Defaults to SYNTHI_AGENT_ID or SYNTHI_ACTOR_ID." },
        workspace_url: { type: "string", description: "Optional workspace URL to open in the hosted runtime. Defaults to SYNTHI_WORKSPACE_URL or SYNTHI_HOSTED_BROWSER_WORKSPACE_URL." },
        runtime_id: { type: "string", description: "Optional hosted runtime id for diagnostics." },
        runtime_session_id: { type: "string", description: "Optional runtime session id. Defaults to a generated short-lived hosted session id." },
        open_workspace: { type: "boolean", description: "Open the workspace URL in the hosted runtime after attach. Defaults true when a workspace URL is known." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_revoke_hosted_runtime_session",
    description:
      "Revoke the current Synthi-hosted browser runtime session. Revocation clears active leases and blocks subsequent browser actions or snapshots until a new hosted session is attached.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Operator or policy reason for revocation. Defaults to operator_revoked." },
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
    name: "synthi_browser_observe_preview",
    description:
      "Find and observe the workspace app preview tab in the Synthi-hosted browser. The preview target is selected from configured preview URLs/origins or, in local development, same-loopback tabs when the workspace itself is loopback. When a preview URL is supplied, the hosted browser opens or reloads it. This does not hardcode preview ports.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_url: { type: "string", description: "Current workspace URL. Used to avoid observing the IDE tab and to derive local-dev loopback preview policy." },
        preferred_url: { type: "string", description: "Optional exact preview URL to prefer when the host already knows it." },
        preview_url: { type: "string", description: "Optional workspace preview URL from the cloud preview/tunnel service." },
        allowed_preview_origins: {
          type: "array",
          items: { type: "string" },
          description: "Optional exact origins that may be treated as workspace previews.",
        },
        allowed_preview_host_suffixes: {
          type: "array",
          items: { type: "string" },
          description: "Optional host suffixes that may be treated as workspace previews, for example a deployment-specific preview domain.",
        },
      },
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
    name: "synthi_browser_close_tab",
    description: "Close a browser tab previously opened or authorized by Synthi. Use this to clean up agent-owned preview tabs after workflow execution.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: ["tab_id"],
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
    description: "Generate Playwright test code from the broker trace or a saved workflow_id, including locator confidence and fallback candidates.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Optional saved workflow id returned by compile/end teach. When supplied, generation uses that immutable artifact." },
        mode: { type: "string", enum: ["sameSession", "prefixOnly", "coldSession", "ciIsolated"], description: "Use prefixOnly/coldSession to stop before mutation boundaries, or ciIsolated to emit a full mutation script guarded by ALLOW_WORKFLOW_MUTATION=1." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_generate_private_tool_manifest",
    description:
      "Generate a private app-specific MCP tool manifest from the taught workflow contract or saved workflow_id. Includes run modes, parameters, auth durability, mutation policy, blockers, and backing Synthi tools; never includes auth artifact values.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Optional saved workflow id returned by compile/end teach. When supplied, manifest generation uses that immutable artifact." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_publish_private_tool",
    description:
      "Register the generated private app-specific workflow tool with this MCP process so agents can discover and call it directly. Blocked manifests are not published; mutation workflows default to prefix-only replay until explicitly confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Optional saved workflow id returned by compile/end teach. Defaults to the current compiled workflow." },
      },
      required: [],
    },
  },
  {
    name: "synthi_browser_list_private_tools",
    description:
      "List published private app-specific workflow tools registered with this MCP process. Use this to discover exact synthi_app_* tool names, run modes, parameters, auth policy, and mutation policy before calling a saved workflow.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_browser_get_private_tool_manifest",
    description:
      "Return the redacted registered manifest and MCP schema for a published private app-specific workflow tool by tool_name. Lets agents inspect run modes, parameters, auth durability, mutation policy, and blockers without a script path.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Published private workflow tool name from tools/list, for example synthi_app_save_runbook." },
      },
      required: ["tool_name"],
    },
  },
  {
    name: "synthi_browser_capture_auth_checkpoint_storage",
    description:
      "Capture browser cookies, localStorage, and sessionStorage for an approved auth checkpoint from the Synthi-hosted browser. Stores raw values broker-side only and returns counts, never auth values.",
    inputSchema: {
      type: "object",
      properties: {
        checkpoint_id: { type: "string", description: "Auth checkpoint id returned by synthi_auth_finish_checkpoint_enrollment." },
        tab_id: { type: "string", description: "Optional authorized tab to capture from. Defaults to the selected tab." },
      },
      required: ["checkpoint_id"],
    },
  },
  {
    name: "synthi_browser_run_workflow",
    description:
      "Replay the compiled workflow under a control lease. coldSession is the default and stops before the first mutation boundary in a fresh context.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        workflow_id: { type: "string", description: "Optional saved workflow id returned by compile/end teach. When supplied, replay uses that immutable artifact and never the current trace." },
        tab_id: { type: "string" },
        mode: { type: "string", enum: ["sameSession", "prefixOnly", "coldSession"], default: "coldSession" },
        parameters: {
          type: "object",
          description: "Workflow parameters keyed by contract parameter name. File-drop steps expect file path strings; clipboard paste, clipboard drop, and native prompt steps expect caller-provided text values.",
          additionalProperties: { type: "string" },
        },
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
        workflow_id: { type: "string", description: "Optional saved workflow id used to resolve failed_step_id context." },
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
        action: { type: "string", enum: [...BROWSER_ACTION_KINDS] },
        selector: { type: "string", description: "A generated Playwright locator string or raw CSS selector." },
        value: { type: "string", description: "Fill text, key/chord name, select option, navigation URL, drag target locator, or JSON scroll position depending on action." },
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
  {
    name: "synthi_browser_get_deployment_readiness",
    description:
      "Return a redacted production readiness report for browser workflow deployment wiring: hosted runtime, workflow bridge, private workflow store, auth checkpoint store, workspace scope, and local-CDP leakage.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["production", "development"], default: "production" },
        workspace_id: { type: "string", description: "Optional workspace scope for replay-isolation profile diagnostics." },
        require_workflow_bridge: { type: "boolean", description: "Whether browser-injected Observe/Teach controls must be configured. Defaults true." },
      },
      required: [],
    },
  },
] as const;

export function browserPrivateWorkflowTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return privateWorkflowToolRegistry.list().map(privateWorkflowToolDefinition);
}

export async function dispatchBrowserTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  try {
    const privateTool = privateWorkflowToolRegistry.get(toolName);
    if (privateTool) return await browserDirectPrivateWorkflowTool(toolName, args, privateTool);
    switch (toolName) {
      case "synthi_browser_attach_current_workspace":
        return await browserAttachCurrentWorkspaceTool(args);
      case "synthi_browser_revoke_hosted_runtime_session":
        return browserRevokeHostedRuntimeSessionTool(args);
      case "synthi_browser_observe":
        return await browserSnapshotTool(args);
      case "synthi_browser_observe_preview":
        return await browserObservePreviewTool(args);
      case "synthi_browser_begin_teach":
        return await browserBeginTeachTool(args);
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
      case "synthi_browser_close_tab":
        return await browserCloseTabTool(args);
      case "synthi_browser_request_consent":
        return browserRequestConsentTool(args);
      case "synthi_browser_get_consent":
        return browserGetConsentTool(args);
      case "synthi_browser_revoke_consent":
        return browserRevokeConsentTool(args);
      case "synthi_browser_snapshot":
        return await browserSnapshotTool(args);
      case "synthi_browser_start_teach":
        return await browserStartTeachTool(args);
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
      case "synthi_browser_generate_private_tool_manifest":
        return browserGeneratePrivateToolManifestTool(args);
      case "synthi_browser_publish_private_tool":
        return browserPublishPrivateToolTool(args);
      case "synthi_browser_list_private_tools":
        return browserListPrivateToolsTool();
      case "synthi_browser_get_private_tool_manifest":
        return browserGetPrivateToolManifestTool(args);
      case "synthi_browser_capture_auth_checkpoint_storage":
        return await browserCaptureAuthCheckpointStorageTool(args);
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
      case "synthi_browser_get_deployment_readiness":
        return browserDeploymentReadinessTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("browser_tool_failed", err);
  }
}

export async function dispatchBrowserPrivateWorkflowToolAfterDojoProof(toolName: string, args: unknown): Promise<ToolResponse> {
  return await browserRunPublishedPrivateTool(toolName, args);
}

async function browserDirectPrivateWorkflowTool(
  toolName: string,
  args: unknown,
  registration: PrivateWorkflowToolRegistration
): Promise<ToolResponse> {
  const binding = dojoBindingForPrivateTool(toolName, registration.workflow_id);
  const gate = createDojoExecutionPolicyGate({
    resolvePublishedSkill: () => binding ?? ({ status: "unpublished" }),
  });
  const decision = await gate.evaluate({
    tenant: dojoTenantContext(args, registration.workflow_id),
    entrypoint: "private_tool",
    workflow_id: registration.workflow_id,
    tool_name: toolName,
    requested_action: "run_workflow",
  });

  if (binding) return browserDirectPrivateToolRequiresDojoProof(toolName, registration.workflow_id, decision);
  if (!decision.ok) {
    return errorResponse("dojo_execution_policy_blocked", {
      tool_name: toolName,
      workflow_id: registration.workflow_id,
      requested_action: "run_workflow",
      blocked_by: decision.blocked_by,
      dojo_execution_policy: decision,
    });
  }
  return await browserRunPublishedPrivateTool(toolName, args);
}

function browserDeploymentReadinessTool(args: unknown): ToolResponse {
  const a = obj(args);
  return jsonResponse({
    ok: true,
    readiness: browserWorkflowDeploymentReadiness({
      mode: a["mode"] === "development" ? "development" : "production",
      workspace_id: stringOpt(a["workspace_id"]),
      require_workflow_bridge: boolOpt(a["require_workflow_bridge"]),
    }),
  });
}

async function browserAttachCurrentWorkspaceTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const result = await attachHostedBrowserRuntime(
    {
      tenant_id: stringOpt(a["tenant_id"]),
      workspace_id: stringOpt(a["workspace_id"]),
      actor_id: stringOpt(a["actor_id"]),
      workspace_url: stringOpt(a["workspace_url"]),
      runtime_id: stringOpt(a["runtime_id"]),
      runtime_session_id: stringOpt(a["runtime_session_id"]),
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
        tenant_id: stringOpt(a["tenant_id"]),
        actor_id: stringOpt(a["actor_id"]),
        workspace_url: stringOpt(a["workspace_url"]),
        runtime_id: stringOpt(a["runtime_id"]),
        runtime_session_id: stringOpt(a["runtime_session_id"]),
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

function browserRevokeHostedRuntimeSessionTool(args: unknown): ToolResponse {
  const reason = stringOpt(obj(args)["reason"]) ?? "operator_revoked";
  const revoked = browserBroker.revokeRuntimeAttachment(reason);
  if (!revoked.revoked) {
    return errorResponse("hosted_runtime_not_attached", {
      runtime: revoked.runtime,
      required_tool: "synthi_browser_attach_current_workspace",
    });
  }
  return jsonResponse({
    ok: true,
    revoked: true,
    runtime: revoked.runtime,
  });
}

async function browserAttachTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const cdpUrl = stringOpt(a["cdp_url"]) ?? process.env["SYNTHI_BROWSER_CDP_URL"];
  if (!cdpUrl) return errorResponse("browser_cdp_url_required", { env: "SYNTHI_BROWSER_CDP_URL", arg: "cdp_url" });
  browserPlaywrightAdapter.setWorkflowOverlayEnabled(false);
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

async function browserObservePreviewTool(args: unknown, options: { userGesture?: boolean } = {}): Promise<ToolResponse> {
  const a = obj(args);
  const input = {
    workspace_url: stringOpt(a["workspace_url"]),
    preferred_url: stringOpt(a["preferred_url"]),
    preview_url: stringOpt(a["preview_url"]),
    allowed_preview_origins: stringArrayOpt(a["allowed_preview_origins"]),
    allowed_preview_host_suffixes: stringArrayOpt(a["allowed_preview_host_suffixes"]),
  };
  const previewUrl = httpUrlOpt(
    input.preferred_url ??
    input.preview_url ??
    process.env["SYNTHI_WORKSPACE_PREVIEW_URL"] ??
    process.env["SYNTHI_PREVIEW_URL"]
  );
  if (previewUrl) await browserPlaywrightAdapter.openOrNavigate(previewUrl);
  let allTabs = await browserPlaywrightAdapter.listTabs();
  let target = resolveBrowserPreviewTarget(
    allTabs,
    input,
    process.env
  );
  if (!target.ok && previewUrl) {
    await browserPlaywrightAdapter.open(previewUrl);
    allTabs = await browserPlaywrightAdapter.listTabs();
    target = resolveBrowserPreviewTarget(
      allTabs,
      {
        ...input,
        preferred_url: input.preferred_url ?? previewUrl,
        preview_url: input.preview_url ?? previewUrl,
      },
      process.env
    );
  }
  if (!target.ok) {
    return errorResponse(target.error, {
      reason: target.reason,
      eligible_tab_count: target.eligible_tab_count,
    });
  }

  if (options.userGesture) {
    browserBroker.requestConsent(target.tab.url, "granted", "workspace_preview_observe_user_gesture", {
      screenshot: true,
      diagnostics: false,
    });
  } else {
    const consent = browserBroker.getConsent(target.tab.url)[0];
    if (consent?.status !== "granted") {
      return previewConsentError("origin_consent_required", target.tab.url);
    }
    if (consent.screenshot !== "granted") {
      return previewConsentError("screenshot_consent_required", target.tab.url);
    }
  }
  const tabs = browserBroker.registerTabs(allTabs);
  const brokerTab = browserBroker.selectTab(target.tab.tab_id);
  if (!brokerTab) return errorResponse("tab_not_authorized", { tab_id: target.tab.tab_id });
  await browserPlaywrightAdapter.selectTab(target.tab.tab_id);
  const snapshot = await browserPlaywrightAdapter.snapshot(target.tab.tab_id);
  const gated = browserBroker.snapshot(snapshot);
  if (!gated.ok) return errorResponse(gated.error);
  return jsonResponse({
    ok: true,
    target: {
      tab_id: target.tab.tab_id,
      url: target.tab.url,
      title: target.tab.title ?? null,
      origin: target.origin,
      reason: target.reason,
    },
    snapshot: gated.snapshot,
    tabs,
    hidden_tabs: allTabs.length - tabs.length,
  });
}

function previewConsentError(error: "origin_consent_required" | "screenshot_consent_required", url: string): ToolResponse {
  return errorResponse(error, {
    url,
    required_tool_call: {
      name: "synthi_browser_request_consent",
      arguments: {
        url,
        status: "granted",
        screenshot: true,
        diagnostics: false,
      },
    },
  });
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

async function browserCloseTabTool(args: unknown): Promise<ToolResponse> {
  const tabId = requiredString(obj(args), "tab_id");
  const brokerTab = browserBroker.selectTab(tabId);
  if (!brokerTab) return errorResponse("tab_not_authorized", { tab_id: tabId });
  const closed = await browserPlaywrightAdapter.closeTab(tabId);
  const forgotten = browserBroker.forgetTab(tabId);
  return jsonResponse({ ok: true, closed, forgotten: forgotten.forgotten });
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

async function browserStartTeachTool(args: unknown): Promise<ToolResponse> {
  const tab = requireAuthorizedTab(stringOpt(obj(args)["tab_id"]));
  const result = browserBroker.startTeachMode(tab.tab_id);
  if (!result.ok) return errorResponse(result.error);
  const capture = await browserPlaywrightAdapter.refreshTeachCapture(result.tab.tab_id);
  if (!capture.ok) {
    browserBroker.stopTeachMode("teach_capture_install_failed");
    return errorResponse(capture.error);
  }
  return jsonResponse({ ok: true, teach: browserBroker.teachState(), tab: result.tab, origin: result.origin });
}

async function browserBeginTeachTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const result = await browserStartTeachTool(args);
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
  const a = obj(args);
  const mode = a["mode"] === undefined ? undefined : normalizeReplayMode(a["mode"]);
  const result = browserBroker.generatedScriptFor(stringOpt(a["workflow_id"]), mode);
  if (!result.ok) return errorResponse(result.error, result.workflow_id ? { workflow_id: result.workflow_id } : undefined);
  const artifactExecutionPolicy = dojoArtifactExecutionPolicyForWorkflow(result.artifact.workflow_id);
  const generated = artifactExecutionPolicy
    ? {
        ...result.generated,
        code: addDojoPracticeArtifactGuard(result.generated.code),
        warnings: [
          ...result.generated.warnings,
          "Dojo-published workflow artifacts are practice/test-only under production enforcement; use synthi_dojo_run_with_proof_capsule for production execution.",
        ],
      }
    : result.generated;
  return jsonResponse({
    ok: true,
    ...generated,
    workflow_id: result.artifact.workflow_id,
    ...(artifactExecutionPolicy ? { artifact_execution_policy: artifactExecutionPolicy } : {}),
  });
}

function browserGeneratePrivateToolManifestTool(args: unknown): ToolResponse {
  const workflowId = stringOpt(obj(args)["workflow_id"]);
  const artifact = browserBroker.workflowArtifact(workflowId);
  if (!artifact.ok) return errorResponse(artifact.error, artifact.workflow_id ? { workflow_id: artifact.workflow_id } : undefined);
  const manifest = manifestWithLiveAuthReadiness(generatePrivateWorkflowToolManifest(artifact.artifact.workflow.contract), artifact.artifact.workflow.contract);
  return jsonResponse({
    ok: manifest.status !== "blocked",
    workflow_id: artifact.artifact.workflow_id,
    manifest,
  });
}

function browserPublishPrivateToolTool(args: unknown): ToolResponse {
  const a = obj(args);
  const enforcement = resolveDojoEnforcementConfig();
  if (enforcement.production_enforcement) {
    return errorResponse("dojo_private_tool_publish_requires_dojo", {
      ok: false,
      enforcement_mode: enforcement.enforcement_mode,
      required_tool: "synthi_dojo_publish_skill",
      blocked_by: ["raw_private_tool_publish_blocked"],
    });
  }
  const workflowId = stringOpt(a["workflow_id"]);
  const artifact = browserBroker.workflowArtifact(workflowId);
  if (!artifact.ok) return errorResponse(artifact.error, artifact.workflow_id ? { workflow_id: artifact.workflow_id } : undefined);
  const manifest = manifestWithLiveAuthReadiness(generatePrivateWorkflowToolManifest(artifact.artifact.workflow.contract), artifact.artifact.workflow.contract);
  const published = privateWorkflowToolRegistry.publish(manifest, {
    reservedToolNames: ADVERTISED_TOOLS,
    workflowArtifact: artifact.artifact,
  });
  if (!published.ok) {
    return errorResponse(published.error, {
      workflow_id: artifact.artifact.workflow_id,
      tool_name: published.tool_name,
      manifest,
    });
  }
  const dojoSkill = dojoSkillRegistry.publish(buildDojoSkill(artifact.artifact.workflow.contract, {
    workspace_id: stringOpt(a["workspace_id"]),
    private_tool_manifest: published.registration.manifest,
    published_tool_name: published.registration.tool_name,
  }));
  return jsonResponse({
    ok: true,
    workflow_id: artifact.artifact.workflow_id,
    tool_name: published.registration.tool_name,
    registered_at: published.registration.registered_at,
    manifest,
    tool: privateWorkflowToolDefinition(published.registration),
    dojo_skill: {
      skill_id: dojoSkill.skill_id,
      workflow_id: dojoSkill.workflow_id,
      published_tool_name: dojoSkill.published_tool_name ?? null,
      license_id: dojoSkill.permission_license.license_id,
      proof_required: dojoSkill.skill_passport.proof_required,
    },
  });
}

function browserListPrivateToolsTool(): ToolResponse {
  const tools = privateWorkflowToolRegistry.list().map((registration) => {
    const artifact = browserBroker.workflowArtifact(registration.workflow_id);
    const contract = artifact.ok
      ? artifact.artifact.workflow.contract
      : registration.workflow_artifact?.workflow.contract;
    const manifest = contract
      ? manifestWithLiveAuthReadiness(registration.manifest, contract)
      : registration.manifest;
    const liveRegistration = { ...registration, manifest };
    const definition = privateWorkflowToolDefinition(liveRegistration);
    return {
      tool_name: registration.tool_name,
      workflow_id: registration.workflow_id,
      title: manifest.title,
      description: manifest.description,
      status: manifest.status,
      registered_at: registration.registered_at,
      target_origins: manifest.target_origins,
      run_modes: privateWorkflowAllowedRunModes(manifest),
      default_run_mode: privateWorkflowDefaultReplayMode(manifest),
      parameters: manifest.parameters.map((parameter) => ({
        name: parameter.name,
        required: parameter.required,
        value_shape: parameter.value_shape,
        redacted: parameter.redacted,
      })),
      auth: {
        durability: manifest.auth.durability,
        unattended_ready: manifest.auth.unattended_ready,
        required: manifest.auth.required,
      },
      mutation: {
        mode: manifest.mutation.mode,
        requires_confirmation: manifest.mutation.requires_confirmation,
        requires_ci_isolation: manifest.mutation.requires_ci_isolation,
      },
      safety: {
        blockers: manifest.safety.blockers,
        limitations: manifest.safety.limitations,
      },
      tool: {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
    };
  });
  return jsonResponse({
    ok: true,
    count: tools.length,
    tools,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
  });
}

function browserGetPrivateToolManifestTool(args: unknown): ToolResponse {
  const toolName = requiredString(obj(args), "tool_name");
  const registration = privateWorkflowToolRegistry.get(toolName);
  if (!registration) return errorResponse("private_workflow_tool_not_found", { tool_name: toolName });
  let manifest = registration.manifest;
  let artifact = browserBroker.workflowArtifact(registration.workflow_id);
  if (!artifact.ok && registration.workflow_artifact) {
    artifact = browserBroker.registerWorkflowArtifact(registration.workflow_artifact);
  }
  if (artifact.ok) {
    manifest = manifestWithLiveAuthReadiness(registration.manifest, artifact.artifact.workflow.contract);
  }
  const liveRegistration = { ...registration, manifest };
  return jsonResponse({
    ok: true,
    tool_name: registration.tool_name,
    workflow_id: registration.workflow_id,
    registered_at: registration.registered_at,
    manifest,
    tool: privateWorkflowToolDefinition(liveRegistration),
  });
}

async function browserCaptureAuthCheckpointStorageTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const checkpointId = requiredString(a, "checkpoint_id");
  const checkpoint = authCheckpointManager.list().find((candidate) => candidate.checkpoint_id === checkpointId);
  if (!checkpoint) return errorResponse("auth_checkpoint_not_found", { checkpoint_id: checkpointId });
  if (checkpoint.status !== "valid") {
    return errorResponse(`auth_checkpoint_${checkpoint.status}`, {
      checkpoint_id: checkpointId,
      status: checkpoint.status,
    });
  }
  const runtime = browserBroker.runtimeAttachment();
  if (runtime?.kind !== "hosted") {
    return errorResponse("hosted_runtime_required", {
      product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    });
  }
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const allowedOrigins = [checkpoint.app_origin, ...checkpoint.idp_origins];
  const tabOrigin = originForUrl(tab.url);
  if (!tabOrigin || !allowedOrigins.includes(tabOrigin)) {
    return errorResponse("auth_checkpoint_tab_origin_mismatch", {
      checkpoint_id: checkpointId,
      tab_origin: tabOrigin,
      allowed_origins: allowedOrigins,
    });
  }
  const storageState = await browserPlaywrightAdapter.captureAuthStorageState(tab.tab_id, allowedOrigins);
  const saved = authCheckpointManager.saveStorageArtifact({
    checkpoint_id: checkpointId,
    storage_state: storageState,
  });
  if (!saved.ok) return errorResponse(saved.error, { checkpoint_id: checkpointId });
  const teachAuthCheckpoint = browserBroker.activateAuthCheckpointForTeach({
    app_origin: saved.checkpoint.app_origin,
    idp_origins: saved.checkpoint.idp_origins,
    checkpoint_id: checkpointId,
  });
  return jsonResponse({
    ok: true,
    checkpoint_id: checkpointId,
    storage_artifact: publicStorageArtifactMetadata(saved.storage_artifact),
    auth_readiness: authCheckpointManager.readiness(saved.checkpoint.app_origin, false),
    teach_auth_checkpoint: teachAuthCheckpoint,
  });
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
      teach_auth_checkpoints: browserBroker.teachAuthCheckpointScopes(),
      workflow_id: workflow.contract.workflowId,
      workflow_state: workflow.card.state,
      unresolved_count: workflow.card.unresolvedCount,
      limitations: workflow.contract.limitations,
      lane0: workflow.contract.lane0,
      teach_question_answers_count: browserBroker.teachQuestionAnswers().length,
      recording_issues: browserBroker.recordingIssueSnapshot(),
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
      target_context: step.targetContext ?? null,
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
  const a = obj(args);
  const failureClass = requiredString(a, "failure_class");
  const failedStepId = stringOpt(a["failed_step_id"]);
  const workflowId = stringOpt(a["workflow_id"]);
  const artifact = failedStepId || workflowId ? browserBroker.workflowArtifact(workflowId) : null;
  const failedStep = artifact?.ok && failedStepId
    ? artifact.artifact.workflow.contract.steps.find((step) => step.stepId === failedStepId)
    : undefined;
  return jsonResponse({
    ok: true,
    failure_class: failureClass,
    failed_step_id: failedStepId ?? null,
    workflow_id: artifact?.ok ? artifact.artifact.workflow_id : workflowId ?? null,
    ...(artifact && !artifact.ok ? { workflow_lookup_error: artifact.error } : {}),
    ...(failedStep ? { failed_step: failureStepContext(failedStep) } : {}),
    ...failureExplanation(failureClass),
  });
}

function failureStepContext(step: WorkflowStepContractV7): Record<string, unknown> {
  return {
    step_id: step.stepId,
    label: step.label,
    action: step.action.kind,
    target_context: step.targetContext ?? null,
    locator_confidence: step.locatorPlan.confidence,
    source_status: step.sourcePlan.status,
    limitations: step.limitations,
    suggested_next_tool: suggestedFailureTool(step),
  };
}

function suggestedFailureTool(step: WorkflowStepContractV7): string {
  if (step.sourcePlan.status === "missing") return "synthi_browser_get_unresolved_steps";
  if (step.limitations.includes("mutationRequiresIsolation")) return "synthi_safety_get_mutation_plan";
  if (step.limitations.includes("iframeNeedsFrameLocator") || step.limitations.includes("closedShadowDomBlocked")) {
    return "synthi_browser_get_unresolved_steps";
  }
  return "synthi_browser_compile_workflow";
}

function classifyBrokerValidationFailure(error: string): FailureClassV7 {
  if (error === "browser_lease_required") return "unsafeEnvironment";
  return classifyWorkflowReplayFailure(new Error(error));
}

function validateWorkflowReplayAction(input: {
  lease_id: string;
  action: BrowserActionKind;
  tab_id: string;
  selector?: string;
  value?: string;
  url: string;
  event: BrowserTraceEvent;
}): { ok: true } | { ok: false; error: string } {
  const actionValidation = browserBroker.validateAction({
    lease_id: input.lease_id,
    action: input.action,
    tab_id: input.tab_id,
    selector: input.selector,
    value: input.value,
    url: input.url,
  });
  if (!actionValidation.ok) return actionValidation;
  return browserBroker.validateReplayTarget({
    url: input.url,
    detail: input.event.detail,
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
  const mode = normalizeReplayMode(a["mode"] ?? "coldSession");
  if (mode === "ciIsolated") {
    return errorResponse("ci_isolated_replay_requires_safety_tool", {
      required_tool: "synthi_safety_run_ci_isolated_replay",
    });
  }
  const parameters = stringParameters(a["parameters"]);
  const replay = browserBroker.workflowReplayPlanFor(stringOpt(a["workflow_id"]), mode);
  if (!replay.ok) return errorResponse(replay.error, replay.workflow_id ? { workflow_id: replay.workflow_id } : undefined);
  const dojoGate = await browserWorkflowReplayDojoGate(args, replay.artifact.workflow_id);
  if (dojoGate) return dojoGate;
  const coldAuthStorage = mode === "coldSession" && replay.artifact.workflow.contract.authPlan.required
    ? await authStorageStateForColdReplay(replay.artifact.workflow.contract)
    : { ok: true as const, storageState: undefined };
  if (!coldAuthStorage.ok) {
    return errorResponse("workflow_auth_not_ready", {
      workflow_id: replay.artifact.workflow_id,
      ...coldAuthStorage.detail,
    });
  }
  if (mode !== "coldSession") {
    const authGate = replayAuthGate(replay.artifact.workflow.contract, mode);
    if (!authGate.ok) {
      return errorResponse("workflow_auth_not_ready", {
        workflow_id: replay.artifact.workflow_id,
        ...authGate.detail,
      });
    }
  }
  const plan = replay.plan;
  if (plan.status === "blocked") {
    return jsonResponse({ ok: false, workflow_id: replay.artifact.workflow_id, replay: { ...plan, failure_class: classifyWorkflowReplayBlock(plan) } });
  }

  const valueRefByStepId = new Map(
    replay.artifact.workflow.contract.steps
      .filter((step) => step.action.valueRef)
      .map((step) => [step.stepId, step.action.valueRef as string])
  );
  const replayTab = mode === "coldSession" ? await openColdReplayTab(plan.events[0]?.url ?? tab.url, coldAuthStorage.storageState) : tab;
  const replayTabByTraceTab = new Map<string, string>();
  for (const event of plan.events) {
    if (event.tab_id) replayTabByTraceTab.set(event.tab_id, replayTab.tab_id);
    break;
  }
  let stepsRun = 0;
  for (const event of plan.events) {
    const action = actionForReplay(event);
    if (!action) continue;
    const selector = event.locator_candidates?.[0]?.locator ?? event.selector;
    const targetTabId = replayTabByTraceTab.get(event.tab_id) ?? replayTab.tab_id;
    if (isFileDropEvent(event)) {
      const filePath = fileDropPathFor(event, parameters);
      if (!filePath) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: "testDataMissing",
            error: `missing_file_parameter:${fileDropParameterName(event)}`,
          },
        });
      }
      const validation = validateWorkflowReplayAction({
        lease_id: leaseId,
        action,
        tab_id: targetTabId,
        selector,
        value: filePath,
        url: event.url,
        event,
      });
      if (!validation.ok) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: classifyBrokerValidationFailure(validation.error),
            error: validation.error,
          },
        });
      }
      try {
        await browserPlaywrightAdapter.fileDrop(targetTabId, selector, filePath, {
          file_input: isFileInputDrop(event),
          mime_type: stringOpt(event.detail?.["mime_type"]),
          event,
        });
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
      continue;
    }
    if (isClipboardPasteEvent(event)) {
      const pasteText = clipboardPasteTextFor(event, parameters);
      if (pasteText === undefined) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: "testDataMissing",
            error: `missing_clipboard_parameter:${clipboardPasteParameterName(event)}`,
          },
        });
      }
      const validation = validateWorkflowReplayAction({
        lease_id: leaseId,
        action,
        tab_id: targetTabId,
        selector,
        value: pasteText,
        url: event.url,
        event,
      });
      if (!validation.ok) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: classifyBrokerValidationFailure(validation.error),
            error: validation.error,
          },
        });
      }
      try {
        const result = await browserPlaywrightAdapter.replayActionEvent(targetTabId, event, action, selector, pasteText);
        rememberReplayPopupTab(replayTabByTraceTab, event, result.detail);
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
      continue;
    }
    if (isClipboardDropEvent(event)) {
      const dropText = clipboardDropTextFor(event, parameters);
      if (dropText === undefined) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: "testDataMissing",
            error: `missing_clipboard_drop_parameter:${clipboardDropParameterName(event)}`,
          },
        });
      }
      const validation = validateWorkflowReplayAction({
        lease_id: leaseId,
        action,
        tab_id: targetTabId,
        selector,
        value: dropText,
        url: event.url,
        event,
      });
      if (!validation.ok) {
        return jsonResponse({
          ok: false,
          replay: {
            ...plan,
            status: "failed",
            steps_run: stepsRun,
            failed_step_id: event.event_id,
            failure_class: classifyBrokerValidationFailure(validation.error),
            error: validation.error,
          },
        });
      }
      try {
        const result = await browserPlaywrightAdapter.replayActionEvent(targetTabId, event, action, selector, dropText);
        rememberReplayPopupTab(replayTabByTraceTab, event, result.detail);
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
      continue;
    }
    const value = replayValueForEvent(event, action, parameters, valueRefByStepId);
    const dialogPromptValue = dialogPromptValueFor(event, parameters);
    if (isAcceptedPromptDialogEvent(event) && dialogPromptValue === undefined) {
      return jsonResponse({
        ok: false,
        replay: {
          ...plan,
          status: "failed",
          steps_run: stepsRun,
          failed_step_id: event.event_id,
          failure_class: "testDataMissing",
          error: `missing_dialog_prompt_parameter:${dialogPromptParameterName(event)}`,
        },
      });
    }
    const validation = validateWorkflowReplayAction({
      lease_id: leaseId,
      action,
      tab_id: targetTabId,
      selector,
      value,
      url: action === "navigate" && value ? value : event.url,
      event,
    });
    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        replay: {
          ...plan,
          status: "failed",
          steps_run: stepsRun,
          failed_step_id: event.event_id,
          failure_class: classifyBrokerValidationFailure(validation.error),
          error: validation.error,
        },
      });
    }
    try {
      const result = dialogPromptValue !== undefined
        ? await browserPlaywrightAdapter.replayActionEvent(targetTabId, event, action, selector, value, { dialogPromptValue })
        : await browserPlaywrightAdapter.replayActionEvent(targetTabId, event, action, selector, value);
      rememberReplayPopupTab(replayTabByTraceTab, event, result.detail);
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
  const replayTabRefreshError = await refreshReplayTabsForSnapshotAccess();

  return jsonResponse({
    ok: true,
    workflow_id: replay.artifact.workflow_id,
    replay: {
      ...plan,
      status: plan.status,
      steps_run: stepsRun,
      tab_id: replayTab.tab_id,
      replay_tab_ids: replayTabIds(replayTabByTraceTab, replayTab.tab_id),
      trace_tab_map: Object.fromEntries(replayTabByTraceTab),
      replay_targets: replayTargetsForPlan(plan.events, replayTabByTraceTab, replayTab.tab_id),
      stopped_before_step_id: plan.stoppedBeforeStepId ?? null,
      ...(replayTabRefreshError ? { replay_tab_refresh_error: replayTabRefreshError } : {}),
    },
  });
}

async function browserRunPublishedPrivateTool(toolName: string, args: unknown): Promise<ToolResponse> {
  const registration = privateWorkflowToolRegistry.get(toolName);
  if (!registration) return errorResponse("private_workflow_tool_not_found", { tool_name: toolName });
  const manifest = registration.manifest;
  if (manifest.status === "blocked") {
    return errorResponse("private_workflow_tool_blocked", {
      tool_name: toolName,
      workflow_id: manifest.workflow_id,
      blockers: manifest.safety.blockers,
    });
  }
  let artifact = browserBroker.workflowArtifact(registration.workflow_id);
  if (!artifact.ok && registration.workflow_artifact) {
    artifact = browserBroker.registerWorkflowArtifact(registration.workflow_artifact);
  }
  if (!artifact.ok) {
    return errorResponse(artifact.error, {
      tool_name: toolName,
      workflow_id: registration.workflow_id,
    });
  }
  const liveManifest = manifestWithLiveAuthReadiness(manifest, artifact.artifact.workflow.contract);
  if (liveManifest.status === "blocked") {
    return errorResponse("private_workflow_tool_auth_not_ready", {
      tool_name: toolName,
      workflow_id: manifest.workflow_id,
      auth: liveManifest.auth,
      notes: liveManifest.safety.notes,
    });
  }

  const effectiveManifest = liveManifest;
  const a = obj(args);
  const parameters: Record<string, string> = {};
  const missingParameters: string[] = [];
  const parameterArgNames = privateWorkflowToolParameterArgNames(effectiveManifest);
  for (const parameter of effectiveManifest.parameters) {
    const argName = parameterArgNames.get(parameter.name) ?? parameter.name;
    const value = stringOpt(a[argName]);
    if (value === undefined) {
      if (parameter.required) missingParameters.push(argName);
      continue;
    }
    parameters[parameter.name] = value;
  }
  if (missingParameters.length > 0) {
    return errorResponse("private_workflow_missing_parameters", {
      tool_name: toolName,
      workflow_id: effectiveManifest.workflow_id,
      missing_parameters: missingParameters,
    });
  }

  const requestedModeResult = privateWorkflowRunMode(a["run_mode"]);
  if (!requestedModeResult.ok) {
    return errorResponse("private_workflow_invalid_run_mode", {
      tool_name: toolName,
      workflow_id: effectiveManifest.workflow_id,
      received_run_mode: typeof a["run_mode"] === "string" ? a["run_mode"] : typeof a["run_mode"],
      allowed_run_modes: privateWorkflowAllowedRunModes(effectiveManifest),
    });
  }
  const requestedMode = requestedModeResult.mode;
  const confirmMutation = boolOpt(a["confirm_mutation"]) === true;
  if (requestedMode === "ciOnly") {
    const authGate = replayAuthGate(artifact.artifact.workflow.contract, "ciIsolated");
    if (!authGate.ok) {
      return errorResponse("private_workflow_tool_auth_not_ready", {
        tool_name: toolName,
        workflow_id: manifest.workflow_id,
        ...authGate.detail,
      });
    }
    const response = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: stringOpt(a["workspace_id"]),
      workflow_id: registration.workflow_id,
      parameters,
      timeout_ms: numberOpt(a["timeout_ms"]),
      artifact_root: stringOpt(a["artifact_root"]),
    });
    if (!response) return errorResponse("ci_isolated_replay_tool_unavailable", { tool_name: toolName });
    const structuredContent = {
      ...(response.structuredContent ?? {}),
      private_tool: {
        tool_name: toolName,
        workflow_id: registration.workflow_id,
        run_mode: "ciOnly",
        mutation_confirmed: false,
      },
    };
    return {
      ...response,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }
  const mode: WorkflowReplayModeV7 = requestedMode === "confirmBeforeCommit"
    ? "sameSession"
    : requestedMode ??
    privateWorkflowDefaultReplayMode(effectiveManifest);

  const mutationConfirmationToken = privateWorkflowMutationConfirmationToken(toolName, effectiveManifest);
  const mutationConfirmation = stringOpt(a["mutation_confirmation"]);
  if (
    effectiveManifest.mutation.requires_confirmation &&
    mode === "sameSession" &&
    (!confirmMutation || mutationConfirmation !== mutationConfirmationToken)
  ) {
    return errorResponse("mutation_confirmation_required", {
      tool_name: toolName,
      workflow_id: effectiveManifest.workflow_id,
      first_mutation_step_id: effectiveManifest.mutation.first_mutation_step_id,
      safe_run_modes: ["prefixOnly", "coldSession", "ciOnly"],
      confirmation_field: "confirm_mutation",
      confirmation_token_field: "mutation_confirmation",
      confirmation_token: mutationConfirmationToken,
    });
  }

  const missingConsents = missingPrivateWorkflowTargetConsents(effectiveManifest, artifact.artifact.workflow.contract);
  if (missingConsents.length > 0) {
    return errorResponse("workflow_origin_consent_required", {
      tool_name: toolName,
      workflow_id: effectiveManifest.workflow_id,
      failure_class: "originConsentMissing",
      required_tool: "synthi_browser_request_consent",
      missing_origins: missingConsents,
      notes: [
        "Grant exact-origin consent for each missing origin before replaying this private workflow tool.",
        "Screenshot consent is required only when the taught target needed screenshot access.",
      ],
    });
  }

  const hostedRuntimeGate = privateWorkflowHostedRuntimeGate(toolName, effectiveManifest, a);
  if (hostedRuntimeGate) return hostedRuntimeGate;

  const lease = browserBroker.acquireLease(
    process.env["SYNTHI_AGENT_ID"] ?? "private_workflow_tool",
    numberOpt(a["lease_ms"]) ?? 15_000,
    `private_tool:${toolName}`
  );
  try {
    const response = await browserRunWorkflowTool({
      lease_id: lease.lease_id,
      workflow_id: registration.workflow_id,
      mode,
      parameters,
      ...(stringOpt(a["tab_id"]) ? { tab_id: stringOpt(a["tab_id"]) } : {}),
    });
    const structuredContent = {
      ...(response.structuredContent ?? {}),
      private_tool: {
        tool_name: toolName,
        workflow_id: registration.workflow_id,
        run_mode: mode,
        mutation_confirmed: confirmMutation,
      },
    };
    return {
      ...response,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } finally {
    browserBroker.releaseLease(lease.lease_id, `private_tool:${toolName}:complete`);
  }
}

function browserDirectPrivateToolRequiresDojoProof(
  toolName: string,
  workflowId: string,
  decision?: DojoExecutionPolicyDecision
): ToolResponse {
  return errorResponse("dojo_proof_capsule_required", {
    tool_name: toolName,
    workflow_id: workflowId,
    required_tool: "synthi_dojo_run_with_proof_capsule",
    issue_capsule_tool: "synthi_dojo_issue_proof_capsule",
    requested_action: "run_workflow",
    blocked_by: decision?.blocked_by?.length ? decision.blocked_by : ["direct_private_workflow_tool_call"],
    dojo_execution_policy: decision ?? null,
    product_path: "agent_to_dojo_license_kernel_to_proof_validator_to_private_workflow_tool",
    notes: [
      "Private workflow tools are backing capabilities for Dojo skills.",
      "Issue a proof-carrying skill capsule, then call synthi_dojo_run_with_proof_capsule with tool_args for this workflow.",
    ],
  });
}

function dojoBindingForPrivateTool(toolName: string, workflowId: string): DojoPublishedSkillBinding | null {
  const binding =
    dojoSkillRegistry.getPublishedWorkflowBindingByToolName(toolName) ??
    dojoSkillRegistry.getPublishedWorkflowBindingByWorkflowId(workflowId);
  if (!binding) return null;
  return {
    status: "published",
    skill_id: binding.skill_id,
    workflow_id: binding.workflow_id,
    tool_name: toolName,
  };
}

function dojoArtifactExecutionPolicyForWorkflow(workflowId: string): Record<string, unknown> | null {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement) return null;
  const binding = dojoSkillRegistry.getPublishedWorkflowBindingByWorkflowId(workflowId);
  if (!binding) return null;
  return {
    status: "practice_only",
    enforcement_mode: enforcement.enforcement_mode,
    workflow_id: binding.workflow_id,
    skill_id: binding.skill_id,
    tool_names: binding.tool_names,
    required_tool: "synthi_dojo_run_with_proof_capsule",
    execution_mode_env: DOJO_ARTIFACT_EXECUTION_MODE_ENV,
    allowed_execution_modes: [...DOJO_ARTIFACT_ALLOWED_EXECUTION_MODES],
    blocked_by: ["dojo_published_workflow_artifact_not_for_production"],
  };
}

function addDojoPracticeArtifactGuard(code: string): string {
  const testStart = "test('replayed browser workflow', async ({ page }) => {";
  const guard = [
    `  const synthiDojoArtifactMode = process.env[${JSON.stringify(DOJO_ARTIFACT_EXECUTION_MODE_ENV)}];`,
    `  const synthiDojoAllowedArtifactModes = new Set(${JSON.stringify(DOJO_ARTIFACT_ALLOWED_EXECUTION_MODES)});`,
    "  test.skip(",
    "    !synthiDojoArtifactMode || !synthiDojoAllowedArtifactModes.has(synthiDojoArtifactMode),",
    "    'Dojo-published workflow artifacts are practice/test-only. Use synthi_dojo_run_with_proof_capsule for production execution.'",
    "  );",
    "",
  ].join("\n");
  if (!code.includes(testStart)) return `${guard}\n${code}`;
  return code.replace(`${testStart}\n`, `${testStart}\n${guard}`);
}

function dojoTenantContext(args: unknown, workflowId: string): DojoTenantContext {
  const a = obj(args);
  const workspaceId =
    stringOpt(a["workspace_id"]) ??
    process.env["SYNTHI_WORKSPACE_ID"]?.trim() ??
    workflowId;
  const tenantId =
    process.env["SYNTHI_TENANT_ID"]?.trim() ??
    workspaceId.split(":")[0] ??
    "default";
  return {
    tenant_id: tenantId,
    organization_id: process.env["SYNTHI_ORGANIZATION_ID"]?.trim() ?? tenantId,
    workspace_id: workspaceId,
    actor_id: process.env["SYNTHI_AGENT_ID"]?.trim() ?? "private_workflow_tool_caller",
    actor_type: "agent",
    roles: ["agent"],
    request_id: stringOpt(a["request_id"]) ?? `req_${workflowId}`,
    correlation_id: stringOpt(a["correlation_id"]) ?? `corr_${workflowId}`,
  };
}

async function browserWorkflowReplayDojoGate(args: unknown, workflowId: string): Promise<ToolResponse | null> {
  const binding = dojoSkillRegistry.getPublishedWorkflowBindingByWorkflowId(workflowId);
  const gate = createDojoExecutionPolicyGate({
    resolvePublishedSkill: () => binding
      ? {
          status: "published",
          skill_id: binding.skill_id,
          workflow_id: binding.workflow_id,
          tool_name: binding.tool_names[0],
        }
      : { status: "unpublished", workflow_id: workflowId },
  });
  const decision = await gate.evaluate({
    tenant: dojoTenantContext(args, workflowId),
    entrypoint: "browser_workflow",
    workflow_id: workflowId,
    requested_action: "run_workflow",
  });
  if (decision.ok) return null;
  return errorResponse(binding ? "dojo_proof_capsule_required" : "dojo_execution_policy_blocked", {
    workflow_id: workflowId,
    requested_action: "run_workflow",
    required_tool: "synthi_dojo_run_with_proof_capsule",
    issue_capsule_tool: "synthi_dojo_issue_proof_capsule",
    blocked_by: decision.blocked_by,
    dojo_execution_policy: decision,
  });
}

function privateWorkflowHostedRuntimeGate(
  toolName: string,
  manifest: PrivateWorkflowToolManifestV7,
  args: Record<string, unknown>
): ToolResponse | null {
  const runtime = browserBroker.runtimeAttachment();
  if (runtime?.kind === "hosted") return null;
  const workspaceId = stringOpt(args["workspace_id"]);
  const readiness = resolveHostedBrowserRuntime({
    workspace_id: workspaceId,
  });
  return errorResponse("private_workflow_hosted_runtime_required", {
    tool_name: toolName,
    workflow_id: manifest.workflow_id,
    required_tool: "synthi_browser_attach_current_workspace",
    runtime: runtime ?? null,
    readiness,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    next_action: {
      tool: "synthi_browser_attach_current_workspace",
      arguments: {
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(readiness.workspace_url ? { workspace_url: readiness.workspace_url } : {}),
        open_workspace: true,
      },
    },
    notes: [
      "Attach the Synthi-hosted workspace browser before running browser-backed private workflow tools.",
      "Local Chrome, local CDP, desktop extensions, and script paths are not part of the normal user path.",
    ],
  });
}

function manifestWithLiveAuthReadiness(
  manifest: PrivateWorkflowToolManifestV7,
  contract: WorkflowContractV7
): PrivateWorkflowToolManifestV7 {
  if (!contract.authPlan.required) return manifest;
  const interactive = authCheckpointManager.readiness(contract.appOrigin, false);
  const unattended = authCheckpointManager.readiness(contract.appOrigin, true);
  let notes = [...manifest.safety.notes];
  const authDurability = authDurabilityForManifest(unattended.ready ? unattended : interactive, manifest.auth.durability);
  let status = manifest.status;
  if (unattended.ready) {
    notes = notes.filter((note) => !/not configured for unattended|Do not mark this tool unattended durable/i.test(note));
    if (
      status === "manualOnly" &&
      !manifest.mutation.requires_confirmation &&
      manifest.safety.blockers.length === 0 &&
      manifest.safety.limitations.length === 0
    ) {
      status = "available";
    }
    notes.push("Validated auth provider is ready for unattended replay.");
  } else if (!interactive.ready) {
    status = "blocked";
    notes.push(`Auth readiness blocked: ${interactive.status}.`);
  } else {
    if (status === "available") status = "manualOnly";
    notes.push(`Auth readiness is manual-only: ${unattended.status}.`);
  }
  return {
    ...manifest,
    status,
    run_modes: unattended.ready && !manifest.mutation.requires_confirmation
      ? orderedRunModes(manifest.run_modes, ["coldSession"])
      : manifest.run_modes,
    default_run_mode: unattended.ready && !manifest.mutation.requires_confirmation
      ? "coldSession"
      : manifest.default_run_mode,
    auth: {
      ...manifest.auth,
      durability: authDurability,
      unattended_ready: unattended.ready,
      required: true,
    },
    safety: {
      ...manifest.safety,
      notes,
    },
  };
}

function missingPrivateWorkflowTargetConsents(
  manifest: PrivateWorkflowToolManifestV7,
  contract: WorkflowContractV7
): Array<Record<string, unknown>> {
  const missing: Array<Record<string, unknown>> = [];
  for (const target of targetOriginsForPrivateTool(manifest, contract)) {
    const consent = browserBroker.getConsent(target.origin)[0];
    const originMissing = consent?.status !== "granted";
    const screenshotMissing = !originMissing && target.screenshot_consent_required && consent?.screenshot !== "granted";
    const diagnosticsMissing = !originMissing && target.diagnostics_consent_required && consent?.diagnostics !== "granted";
    if (!originMissing && !screenshotMissing && !diagnosticsMissing) continue;
    missing.push({
      origin: target.origin,
      primary: target.primary,
      kinds: target.kinds,
      step_ids: target.step_ids,
      reason: originMissing
        ? "origin_consent_required"
        : screenshotMissing
        ? "screenshot_consent_required"
        : "diagnostics_consent_required",
      request: {
        tool: "synthi_browser_request_consent",
        arguments: {
          url: target.origin,
          status: "granted",
          screenshot: target.screenshot_consent_required,
          diagnostics: target.diagnostics_consent_required,
        },
      },
    });
  }
  return missing;
}

function targetOriginsForPrivateTool(
  manifest: PrivateWorkflowToolManifestV7,
  contract: WorkflowContractV7
): PrivateWorkflowToolManifestV7["target_origins"] {
  const raw = (manifest as { target_origins?: unknown }).target_origins;
  if (Array.isArray(raw) && raw.length > 0 && raw.every(isPrivateWorkflowTargetOrigin)) {
    return raw;
  }
  return generatePrivateWorkflowToolManifest(contract).target_origins;
}

function isPrivateWorkflowTargetOrigin(value: unknown): value is PrivateWorkflowToolManifestV7["target_origins"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PrivateWorkflowToolManifestV7["target_origins"][number]>;
  return typeof candidate.origin === "string" &&
    typeof candidate.primary === "boolean" &&
    Array.isArray(candidate.kinds) &&
    Array.isArray(candidate.step_ids) &&
    typeof candidate.screenshot_consent_required === "boolean" &&
    typeof candidate.diagnostics_consent_required === "boolean";
}

function orderedRunModes<T extends string>(existing: T[], additions: T[]): T[] {
  const modes = [...existing];
  for (const mode of additions) {
    if (!modes.includes(mode)) modes.push(mode);
  }
  return modes;
}

function replayAuthGate(
  contract: WorkflowContractV7,
  mode: WorkflowReplayModeV7
): { ok: true } | { ok: false; detail: Record<string, unknown> } {
  if (!contract.authPlan.required) return { ok: true };
  const authState = replayAuthReadiness(contract, mode);
  if (authState.ready) return { ok: true };
  return { ok: false, detail: authReadinessDetail(contract.appOrigin, authState.readiness, authState.unattended) };
}

async function authStorageStateForColdReplay(
  contract: WorkflowContractV7
): Promise<{ ok: true; storageState: AuthBrowserStorageState } | { ok: false; detail: Record<string, unknown> }> {
  const authState = replayAuthReadiness(contract, "coldSession");
  if (!authState.ready) {
    const minted = await authCheckpointManager.mintRefreshProviderStorageForOrigin(contract.appOrigin);
    if (minted.ok) return { ok: true, storageState: minted.artifact.state };
    return {
      ok: false,
      detail: minted.error === "auth_refresh_provider_not_found"
        ? authReadinessDetail(contract.appOrigin, authState.readiness, authState.unattended)
        : authRefreshProviderFailureDetail(contract.appOrigin, minted.error),
    };
  }

  const providerId = authState.readiness.refresh_provider?.provider_id;
  if (providerId && authState.unattended) {
    const providerArtifact = await authCheckpointManager.mintRefreshProviderStorage(providerId);
    if (!providerArtifact.ok || providerArtifact.artifact.metadata.app_origin !== contract.appOrigin) {
      return {
        ok: false,
        detail: {
          app_origin: contract.appOrigin,
          auth_status: providerArtifact.ok ? "checkpointStorageMissing" : providerArtifact.error,
          auth_durability: authState.readiness.durability,
          unattended: true,
          failure_class: "authRefreshFailed",
          notes: ["Refresh provider did not produce broker-owned auth storage for this workflow origin."],
        },
      };
    }
    return { ok: true, storageState: providerArtifact.artifact.state };
  }

  const checkpoint = authState.readiness.checkpoint;
  if (!checkpoint) {
    return {
      ok: false,
      detail: authReadinessDetail(contract.appOrigin, authState.readiness, authState.unattended),
    };
  }
  const artifact = authCheckpointManager.storageArtifactForCheckpoint(checkpoint.checkpoint_id);
  if (!artifact) {
    return {
      ok: false,
      detail: authReadinessDetail(contract.appOrigin, {
        ...authState.readiness,
        status: "checkpointStorageMissing",
        ready: false,
        notes: ["Auth checkpoint is missing a captured browser storage artifact."],
      }, authState.unattended),
    };
  }
  return { ok: true, storageState: artifact.state };
}

function replayAuthReadiness(
  contract: WorkflowContractV7,
  mode: WorkflowReplayModeV7
): { ready: true; readiness: AuthReadiness; unattended: boolean } | { ready: false; readiness: AuthReadiness; unattended: boolean } {
  if (mode === "ciIsolated") {
    const readiness = authCheckpointManager.readiness(contract.appOrigin, true);
    return { ready: readiness.ready, readiness, unattended: true };
  }
  const interactive = authCheckpointManager.readiness(contract.appOrigin, false);
  if (mode === "coldSession") {
    const providerBacked = authCheckpointManager.readiness(contract.appOrigin, true);
    if (providerBacked.ready) return { ready: true, readiness: providerBacked, unattended: true };
    return { ready: interactive.ready, readiness: interactive, unattended: false };
  }
  if (interactive.ready) return { ready: interactive.ready, readiness: interactive, unattended: false };
  return { ready: false, readiness: interactive, unattended: false };
}

function authReadinessDetail(appOrigin: string, readiness: AuthReadiness, unattended: boolean): Record<string, unknown> {
  return {
    app_origin: appOrigin,
    auth_status: readiness.status,
    auth_durability: readiness.durability,
    unattended,
    failure_class: authFailureClassForReadiness(readiness),
    notes: readiness.notes,
  };
}

function authRefreshProviderFailureDetail(appOrigin: string, error: string): Record<string, unknown> {
  return {
    app_origin: appOrigin,
    auth_status: error,
    auth_durability: "refreshProvider",
    unattended: true,
    failure_class: "authRefreshFailed",
    notes: ["Refresh provider could not mint broker-owned replay auth state."],
  };
}

function authFailureClassForReadiness(readiness: AuthReadiness): "authExpired" | "authMissing" | "authRefreshFailed" {
  if (readiness.status === "unattendedBlocked" && readiness.refresh_provider?.failure_class) return "authRefreshFailed";
  return readiness.status === "checkpointExpired" ? "authExpired" : "authMissing";
}

function authDurabilityForManifest(readiness: AuthReadiness, fallback: AuthDurabilityV7): AuthDurabilityV7 {
  return readiness.durability === "missing" ? fallback : readiness.durability;
}

type PrivateWorkflowRunMode = WorkflowReplayModeV7 | "confirmBeforeCommit" | "ciOnly";

function privateWorkflowDefaultReplayMode(manifest: PrivateWorkflowToolManifestV7): WorkflowReplayModeV7 {
  if (manifest.mutation.requires_confirmation) return "prefixOnly";
  if (manifest.default_run_mode === "coldSession") return "coldSession";
  if (manifest.default_run_mode === "prefixOnly") return "prefixOnly";
  return "sameSession";
}

function privateWorkflowAllowedRunModes(manifest: PrivateWorkflowToolManifestV7): PrivateWorkflowRunMode[] {
  return manifest.mutation.requires_confirmation
    ? ["prefixOnly", "confirmBeforeCommit", "ciOnly", "sameSession", "coldSession"]
    : ["sameSession", "prefixOnly", "coldSession"];
}

function privateWorkflowRunMode(value: unknown): { ok: true; mode?: PrivateWorkflowRunMode } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (
    value === "sameSession" ||
    value === "prefixOnly" ||
    value === "coldSession" ||
    value === "confirmBeforeCommit" ||
    value === "ciOnly"
  ) {
    return { ok: true, mode: value };
  }
  return { ok: false };
}

function privateWorkflowMutationConfirmationToken(toolName: string, manifest: PrivateWorkflowToolManifestV7): string {
  return [
    "confirm",
    toolName,
    manifest.workflow_id,
    manifest.mutation.first_mutation_step_id ?? "mutation",
  ].join(":");
}

async function openColdReplayTab(url: string, storageState?: AuthBrowserStorageState): Promise<{ tab_id: string; url: string }> {
  const access = browserBroker.requireSnapshotAccess(url);
  if (!access.ok) throw new Error(access.error);
  const tab = await browserPlaywrightAdapter.openCold(url, storageState);
  browserBroker.registerTabs(await browserPlaywrightAdapter.listTabs());
  browserBroker.selectTab(tab.tab_id);
  return { tab_id: tab.tab_id, url: tab.url };
}

async function browserActionTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const action = requiredString(a, "action");
  if (!isBrowserActionKind(action)) return errorResponse("unsupported_browser_action", { action });
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

function replayValueForEvent(
  event: BrowserTraceEvent,
  action: BrowserActionKind,
  parameters: Record<string, string> = {},
  valueRefByStepId: Map<string, string> = new Map()
): string | undefined {
  if (action === "navigate") return event.url;
  const parameterName = valueRefByStepId.get(event.event_id);
  if ((action === "fill" || action === "select") && parameterName && parameters[parameterName] !== undefined) {
    return parameters[parameterName];
  }
  if (action === "drag") return event.value ?? stringOpt(event.detail?.["drop_locator"]);
  if (action === "select") {
    const selectValues = stringArrayOpt(event.detail?.["select_values"]);
    if (selectValues && (event.detail?.["multiple_select"] === true || selectValues.length > 1)) {
      return JSON.stringify(selectValues);
    }
  }
  if (action === "scroll") return JSON.stringify({
    top: numberOpt(event.detail?.["scroll_top"]) ?? 0,
    left: numberOpt(event.detail?.["scroll_left"]) ?? 0,
  });
  return event.value;
}

function rememberReplayPopupTab(
  replayTabByTraceTab: Map<string, string>,
  event: BrowserTraceEvent,
  detail: Record<string, unknown> | undefined
): void {
  const tracePopupTab = stringOpt(event.detail?.["popup_tab_id"]);
  const replayPopupTab = stringOpt(detail?.["popup_tab_id"]);
  if (tracePopupTab && replayPopupTab) replayTabByTraceTab.set(tracePopupTab, replayPopupTab);
}

function replayTabIds(replayTabByTraceTab: Map<string, string>, rootTabId: string): string[] {
  return [...new Set([rootTabId, ...replayTabByTraceTab.values()].filter((value) => value.length > 0))];
}

function replayTargetsForPlan(
  events: BrowserTraceEvent[],
  replayTabByTraceTab: Map<string, string>,
  rootTabId: string
): Array<Record<string, unknown>> {
  const byTraceTab = new Map<string, {
    trace_tab_id: string;
    replay_tab_id: string;
    kind: "page" | "popup";
    recorded_opener_tab_id?: string;
    recorded_root_opener_tab_id?: string;
    popup_context: boolean;
  }>();

  for (const event of events) {
    if (!event.tab_id) continue;
    const existing = byTraceTab.get(event.tab_id) ?? {
      trace_tab_id: event.tab_id,
      replay_tab_id: replayTabByTraceTab.get(event.tab_id) ?? rootTabId,
      kind: "page",
      popup_context: false,
    };
    const replayTabId = replayTabByTraceTab.get(event.tab_id);
    if (replayTabId) existing.replay_tab_id = replayTabId;
    if (event.detail?.["popup_context"] === true || event.detail?.["popup_event"] === true) {
      existing.kind = "popup";
      existing.popup_context = true;
    }
    const openerTabId = stringOpt(event.detail?.["opener_tab_id"]);
    const rootOpenerTabId = stringOpt(event.detail?.["root_opener_tab_id"]);
    if (openerTabId) existing.recorded_opener_tab_id = openerTabId;
    if (rootOpenerTabId) existing.recorded_root_opener_tab_id = rootOpenerTabId;
    byTraceTab.set(event.tab_id, existing);
  }

  return [...byTraceTab.values()].map((target) => ({
    trace_tab_id: target.trace_tab_id,
    replay_tab_id: target.replay_tab_id,
    kind: target.kind,
    ...(target.recorded_opener_tab_id ? { recorded_opener_tab_id: target.recorded_opener_tab_id } : {}),
    ...(target.recorded_root_opener_tab_id ? { recorded_root_opener_tab_id: target.recorded_root_opener_tab_id } : {}),
    popup_context: target.popup_context,
  }));
}

async function refreshReplayTabsForSnapshotAccess(): Promise<string | null> {
  if (!browserPlaywrightAdapter.isAttached()) return null;
  try {
    browserBroker.registerTabs(await browserPlaywrightAdapter.listTabs());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function isFileDropEvent(event: BrowserTraceEvent): boolean {
  return event.action === "drag" && dragClassFor(event) === "filedrop";
}

function isClipboardPasteEvent(event: BrowserTraceEvent): boolean {
  return event.action === "fill" && (
    event.detail?.["clipboard_event"] === true ||
    event.detail?.["clipboard_mode"] === "paste" ||
    event.detail?.["paste_event"] === true
  );
}

function isClipboardDropEvent(event: BrowserTraceEvent): boolean {
  return event.action === "drag" && dragClassFor(event) === "clipboarddrop";
}

function isAcceptedPromptDialogEvent(event: BrowserTraceEvent): boolean {
  return event.detail?.["dialog_event"] === true &&
    event.detail?.["dialog_type"] === "prompt" &&
    event.detail?.["dialog_accepted"] !== false;
}

function dialogPromptValueFor(event: BrowserTraceEvent, parameters: Record<string, string>): string | undefined {
  if (!isAcceptedPromptDialogEvent(event)) return undefined;
  const parameterName = dialogPromptParameterName(event);
  return parameters[parameterName] ?? (typeof event.detail?.["fixture_prompt_value"] === "string" ? event.detail["fixture_prompt_value"] : undefined);
}

function dialogPromptParameterName(event: BrowserTraceEvent): string {
  const explicit = stringOpt(event.detail?.["dialog_prompt_env"]) ?? stringOpt(event.detail?.["dialog_prompt_parameter"]) ?? stringOpt(event.detail?.["prompt_parameter"]);
  const message = event.detail?.["dialog_message_redacted"] === true ? undefined : stringOpt(event.detail?.["dialog_message"]);
  const element = event.detail?.["element"];
  const label = element && typeof element === "object"
    ? stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).label) ??
      stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).name) ??
      stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).test_id)
    : undefined;
  return slugIdentifier(explicit ?? message ?? label ?? `${event.event_id}_prompt`);
}

function clipboardPasteTextFor(event: BrowserTraceEvent, parameters: Record<string, string>): string | undefined {
  const parameterName = clipboardPasteParameterName(event);
  return parameters[parameterName] ?? stringOpt(event.detail?.["fixture_text"]);
}

function clipboardPasteParameterName(event: BrowserTraceEvent): string {
  const explicit = stringOpt(event.detail?.["paste_parameter"]) ?? stringOpt(event.detail?.["clipboard_parameter"]);
  const element = event.detail?.["element"];
  const label = element && typeof element === "object"
    ? stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).label) ??
      stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).name) ??
      stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).placeholder) ??
      stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).test_id)
    : undefined;
  return slugIdentifier(explicit ?? label ?? `${event.event_id}_paste`);
}

function clipboardDropTextFor(event: BrowserTraceEvent, parameters: Record<string, string>): string | undefined {
  const parameterName = clipboardDropParameterName(event);
  return parameters[parameterName] ?? stringOpt(event.detail?.["fixture_text"]);
}

function clipboardDropParameterName(event: BrowserTraceEvent): string {
  const explicit = stringOpt(event.detail?.["drop_parameter"]) ?? stringOpt(event.detail?.["clipboard_parameter"]);
  const element = event.detail?.["element"];
  const label = element && typeof element === "object"
    ? stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).label) ??
      stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown; test_id?: unknown }).name) ??
      stringOpt((element as { label?: unknown; name?: unknown; placeholder?: unknown }).placeholder) ??
      stringOpt((element as { test_id?: unknown }).test_id)
    : undefined;
  return slugIdentifier(explicit ?? label ?? `${event.event_id}_drop`);
}

function fileDropPathFor(event: BrowserTraceEvent, parameters: Record<string, string>): string | undefined {
  const parameterName = fileDropParameterName(event);
  return stringOpt(parameters[parameterName]) ??
    stringOpt(event.detail?.["fixture_file"]) ??
    stringOpt(event.detail?.["file_path"]);
}

function fileDropParameterName(event: BrowserTraceEvent): string {
  const explicit = stringOpt(event.detail?.["file_parameter"]) ?? stringOpt(event.detail?.["file_env"]);
  const element = event.detail?.["element"];
  const label = element && typeof element === "object"
    ? stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).label) ??
      stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).name) ??
      stringOpt((element as { label?: unknown; name?: unknown; test_id?: unknown }).test_id)
    : undefined;
  return slugIdentifier(explicit ?? label ?? `${event.event_id}_file`);
}

function isFileInputDrop(event: BrowserTraceEvent): boolean {
  const element = event.detail?.["element"];
  if (!element || typeof element !== "object") return event.detail?.["file_input"] === true;
  const input = element as { tag?: unknown; type?: unknown };
  return event.detail?.["file_input"] === true ||
    (String(input.tag ?? "").toLowerCase() === "input" && String(input.type ?? "").toLowerCase() === "file");
}

function dragClassFor(event: BrowserTraceEvent): string {
  return String(event.detail?.["drag_class"] ?? event.detail?.["dragClass"] ?? "").toLowerCase();
}

function stringParameters(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, parameterValue] of Object.entries(value)) {
    if (typeof parameterValue === "string") out[slugIdentifier(key)] = parameterValue;
  }
  return out;
}

function slugIdentifier(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "file";
}

async function browserWaitTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tab = requireAuthorizedTab(stringOpt(a["tab_id"]));
  const condition = requiredString(a, "condition");
  if (!isBrowserWaitCondition(condition)) return errorResponse("unsupported_wait_condition", { condition });
  const result = await browserPlaywrightAdapter.wait({
    tab_id: tab.tab_id,
    condition,
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

function httpUrlOpt(value: unknown): string | undefined {
  const raw = stringOpt(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function originForUrl(value: unknown): string | null {
  const raw = stringOpt(value);
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayOpt(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function boolOpt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function publicStorageArtifactMetadata(metadata: AuthStorageArtifactMetadata): Omit<AuthStorageArtifactMetadata, "artifact_id"> {
  const { artifact_id: _artifactId, ...publicMetadata } = metadata;
  return publicMetadata;
}

function isBrowserActionKind(value: string): value is BrowserActionKind {
  return (BROWSER_ACTION_KINDS as readonly string[]).includes(value);
}

type BrowserWaitCondition = "selector" | "url" | "load" | "networkidle" | "timeout";

function isBrowserWaitCondition(value: string): value is BrowserWaitCondition {
  return ["selector", "url", "load", "networkidle", "timeout"].includes(value);
}

function failureExplanation(failureClass: string): { explanation: string; suggested_next_action: string } {
  switch (failureClass) {
    case "authMissing":
    case "authExpired":
      return {
        explanation: "The workflow could not reach the application state because authentication was missing or expired.",
        suggested_next_action: "Renew or configure an auth checkpoint before replaying or publishing the workflow.",
      };
    case "authRefreshFailed":
      return {
        explanation: "The workflow has a refresh provider, but it could not mint broker-owned replay auth state.",
        suggested_next_action: "Check the replay auth provider configuration, secret reference, and mint command before running unattended replay.",
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
