import {
  blockedHardeningExplanationFor,
  mutationSafetyPlanFor,
  prefixValidationSummaryFor,
  replayIsolationProfiles,
  type ReplayIsolationKindV7,
} from "../browser/safety.js";
import { browserBroker } from "../browser/broker.js";
import { classifyWorkflowReplayBlock } from "../browser/workflow.js";
import { errorFromException, jsonResponse, type ToolResponse } from "./shared.js";

export const SAFETY_TOOL_NAMES = [
  "synthi_safety_get_mutation_plan",
  "synthi_safety_set_replay_isolation_profile",
  "synthi_safety_run_prefix_validation",
  "synthi_safety_explain_blocked_hardening",
] as const;

export const SAFETY_TOOLS = [
  {
    name: "synthi_safety_get_mutation_plan",
    description:
      "Return the workflow mutation boundary, read-only prefix validation plan, and CI isolation readiness. Does not execute mutation steps.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Optional workspace scope. Defaults to the active/default workspace." },
      },
      required: [],
    },
  },
  {
    name: "synthi_safety_set_replay_isolation_profile",
    description:
      "Set metadata for an isolated replay profile. Full mutation hardening is marked ready only with a CI base URL, command, reset command, and explicit mutation permission.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        kind: { type: "string", enum: ["none", "readOnlyPrefix", "ciIsolated"], default: "none" },
        base_url: { type: "string" },
        ci_command: { type: "string" },
        data_reset_command: { type: "string" },
        auth_provider_id: { type: "string" },
        allow_mutation_replay: { type: "boolean", default: false },
      },
      required: [],
    },
  },
  {
    name: "synthi_safety_run_prefix_validation",
    description:
      "Build a broker-derived read-only prefix validation plan for the current taught workflow. Live execution uses synthi_browser_run_workflow with mode prefixOnly.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_safety_explain_blocked_hardening",
    description:
      "Explain why background hardening or CI full replay is blocked, with the safest next action.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
] as const;

export async function dispatchSafetyTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  try {
    switch (toolName) {
      case "synthi_safety_get_mutation_plan":
        return mutationPlanTool(args);
      case "synthi_safety_set_replay_isolation_profile":
        return setReplayIsolationProfileTool(args);
      case "synthi_safety_run_prefix_validation":
        return prefixValidationTool(args);
      case "synthi_safety_explain_blocked_hardening":
        return explainBlockedHardeningTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("safety_tool_failed", err);
  }
}

function mutationPlanTool(args: unknown): ToolResponse {
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const workflow = browserBroker.compiledWorkflow();
  const profile = replayIsolationProfiles.get(workspaceId);
  return jsonResponse({
    ok: true,
    workflow_id: workflow.contract.workflowId,
    isolation_profile: profile,
    mutation_plan: mutationSafetyPlanFor(workflow.contract, profile),
  });
}

function setReplayIsolationProfileTool(args: unknown): ToolResponse {
  const a = obj(args);
  const profile = replayIsolationProfiles.set({
    workspace_id: stringOpt(a["workspace_id"]),
    kind: isolationKind(a["kind"]),
    base_url: stringOpt(a["base_url"]),
    ci_command: stringOpt(a["ci_command"]),
    data_reset_command: stringOpt(a["data_reset_command"]),
    auth_provider_id: stringOpt(a["auth_provider_id"]),
    allow_mutation_replay: boolOpt(a["allow_mutation_replay"]),
  });
  return jsonResponse({
    ok: true,
    isolation_profile: profile,
  });
}

function prefixValidationTool(_args: unknown): ToolResponse {
  const plan = browserBroker.workflowReplayPlan("prefixOnly");
  const failureClass = plan.status === "blocked" ? classifyWorkflowReplayBlock(plan) : null;
  const validation = prefixValidationSummaryFor(plan, failureClass);
  return jsonResponse({
    ok: plan.status !== "blocked",
    validation,
  });
}

function explainBlockedHardeningTool(args: unknown): ToolResponse {
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const workflow = browserBroker.compiledWorkflow();
  const profile = replayIsolationProfiles.get(workspaceId);
  return jsonResponse({
    ok: true,
    explanation: blockedHardeningExplanationFor(workflow.contract, profile),
    mutation_plan: mutationSafetyPlanFor(workflow.contract, profile),
  });
}

function obj(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boolOpt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isolationKind(value: unknown): ReplayIsolationKindV7 | undefined {
  if (value === "readOnlyPrefix" || value === "ciIsolated" || value === "none") return value;
  return undefined;
}
