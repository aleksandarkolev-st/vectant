import {
  blockedHardeningExplanationFor,
  mergeReplayIsolationProfileInputs,
  mutationSafetyPlanFor,
  prefixValidationSummaryFor,
  replayIsolationProfileInputFromManifest,
  replayIsolationProfileManifestFor,
  replayIsolationProfiles,
  type ReplayIsolationKindV7,
} from "../browser/safety.js";
import { browserBroker } from "../browser/broker.js";
import { runCiIsolatedReplay } from "../browser/ci_replay.js";
import { authCheckpointManager, type AuthBrowserStorageState } from "../browser/auth.js";
import { classifyWorkflowReplayBlock, type WorkflowContractV7 } from "../browser/workflow.js";
import { errorFromException, jsonResponse, type ToolResponse } from "./shared.js";

export const SAFETY_TOOL_NAMES = [
  "synthi_safety_get_mutation_plan",
  "synthi_safety_set_replay_isolation_profile",
  "synthi_safety_run_prefix_validation",
  "synthi_safety_run_ci_isolated_replay",
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
      "Set metadata for an isolated replay profile. Full mutation hardening is marked ready only with a CI base URL, command, reset command, reset assertion, postcondition, state seed identity, and explicit mutation permission.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        profile_manifest: {
          type: "object",
          description: "Portable replay isolation profile manifest. Flat fields in this call override manifest values.",
          additionalProperties: true,
        },
        kind: { type: "string", enum: ["none", "readOnlyPrefix", "ciIsolated"], default: "none" },
        base_url: { type: "string" },
        ci_command: { type: "string" },
        data_reset_command: { type: "string" },
        reset_assertion_command: { type: "string" },
        postcondition_command: { type: "string" },
        working_directory: { type: "string", description: "Optional workspace/repo directory used as cwd for reset and CI replay commands." },
        auth_provider_id: { type: "string" },
        reset_profile_id: { type: "string", description: "Stable reset profile identity that CI reset and assertion commands must verify." },
        state_seed_id: { type: "string", description: "Workspace/app seed identifier expected after reset and before mutation replay." },
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
    name: "synthi_safety_run_ci_isolated_replay",
    description:
      "Run the full workflow, including mutation steps, only through a configured resettable CI isolation profile. Requires base URL, reset command, CI command, and explicit mutation replay permission.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        workflow_id: { type: "string" },
        parameters: {
          type: "object",
          description: "Workflow parameters keyed by contract parameter name or generated env variable name.",
          additionalProperties: { type: "string" },
        },
        timeout_ms: { type: "number" },
        artifact_root: { type: "string" },
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
      case "synthi_safety_run_ci_isolated_replay":
        return ciIsolatedReplayTool(args);
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
    profile_manifest: replayIsolationProfileManifestFor(profile),
    mutation_plan: mutationSafetyPlanFor(workflow.contract, profile),
  });
}

function setReplayIsolationProfileTool(args: unknown): ToolResponse {
  const a = obj(args);
  const manifestInput = replayIsolationProfileInputFromManifest(a["profile_manifest"]);
  const argumentInput = {
    workspace_id: stringOpt(a["workspace_id"]),
    kind: isolationKind(a["kind"]),
    base_url: stringOpt(a["base_url"]),
    ci_command: stringOpt(a["ci_command"]),
    data_reset_command: stringOpt(a["data_reset_command"]),
    reset_assertion_command: stringOpt(a["reset_assertion_command"]),
    postcondition_command: stringOpt(a["postcondition_command"]),
    working_directory: stringOpt(a["working_directory"]),
    auth_provider_id: stringOpt(a["auth_provider_id"]),
    reset_profile_id: stringOpt(a["reset_profile_id"]),
    state_seed_id: stringOpt(a["state_seed_id"]),
    allow_mutation_replay: boolOpt(a["allow_mutation_replay"]),
  };
  const profile = replayIsolationProfiles.set(mergeReplayIsolationProfileInputs(manifestInput, argumentInput));
  return jsonResponse({
    ok: true,
    isolation_profile: profile,
    profile_manifest: replayIsolationProfileManifestFor(profile),
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

async function ciIsolatedReplayTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const workspaceId = stringOpt(a["workspace_id"]);
  const workflowId = stringOpt(a["workflow_id"]);
  const artifact = browserBroker.workflowArtifact(workflowId);
  if (!artifact.ok) {
    return jsonResponse({
      ok: false,
      error: artifact.error,
      workflow_id: artifact.workflow_id ?? workflowId ?? null,
    });
  }
  const profile = replayIsolationProfiles.get(workspaceId);
  const plan = mutationSafetyPlanFor(artifact.artifact.workflow.contract, profile);
  const authStorage = await authStorageStateForCiReplay(artifact.artifact.workflow.contract, profile.auth_provider_id);
  const replay = await runCiIsolatedReplay({
    workspace_id: workspaceId,
    workflow_id: artifact.artifact.workflow_id,
    workflow: artifact.artifact.workflow,
    events: artifact.artifact.events,
    profile,
    blockers: [...plan.ci_full_replay.blockers, ...authStorage.blockers],
    parameters: stringMap(a["parameters"]),
    ...(authStorage.storageState ? { auth_storage_state: authStorage.storageState } : {}),
    timeout_ms: numberOpt(a["timeout_ms"]),
    artifact_root: stringOpt(a["artifact_root"]),
  });
  return jsonResponse({
    ok: replay.status === "passed",
    replay,
  });
}

function explainBlockedHardeningTool(args: unknown): ToolResponse {
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const workflow = browserBroker.compiledWorkflow();
  const profile = replayIsolationProfiles.get(workspaceId);
  return jsonResponse({
    ok: true,
    explanation: blockedHardeningExplanationFor(workflow.contract, profile),
    profile_manifest: replayIsolationProfileManifestFor(profile),
    mutation_plan: mutationSafetyPlanFor(workflow.contract, profile),
  });
}

async function authStorageStateForCiReplay(
  contract: WorkflowContractV7,
  authProviderId: string | null
): Promise<{ storageState?: AuthBrowserStorageState; blockers: string[] }> {
  if (!contract.authPlan.required) return { blockers: [] };
  if (!authProviderId) return { blockers: ["auth_provider_id"] };
  const artifact = await authCheckpointManager.mintRefreshProviderStorage(authProviderId);
  if (!artifact.ok) return { blockers: [artifact.error] };
  if (artifact.artifact.metadata.app_origin !== contract.appOrigin) {
    return { blockers: ["auth_provider_origin_mismatch"] };
  }
  return { storageState: artifact.artifact.state, blockers: [] };
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

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}
