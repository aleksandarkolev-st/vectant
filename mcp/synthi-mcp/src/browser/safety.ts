import type {
  FailureClassV7,
  WorkflowContractV7,
  WorkflowReplayPlanV7,
} from "./workflow.js";

export type ReplayIsolationKindV7 = "none" | "readOnlyPrefix" | "ciIsolated";

export interface ReplayIsolationProfileInput {
  workspace_id?: string;
  kind?: ReplayIsolationKindV7;
  base_url?: string;
  ci_command?: string;
  data_reset_command?: string;
  working_directory?: string;
  auth_provider_id?: string;
  allow_mutation_replay?: boolean;
}

export interface ReplayIsolationProfileV7 {
  workspace_id: string;
  kind: ReplayIsolationKindV7;
  readiness: "notConfigured" | "prefixOnly" | "ciIsolatedReady" | "ciIsolatedIncomplete";
  can_run_full_mutation_replay: boolean;
  base_url: string | null;
  ci_command: string | null;
  data_reset_command: string | null;
  working_directory: string | null;
  auth_provider_id: string | null;
  allow_mutation_replay: boolean;
  missing: string[];
  updated_at: number | null;
}

export interface MutationSafetyPlanV7 {
  workflow_id: string;
  has_mutation: boolean;
  first_mutation_step_id: string | null;
  mutation_steps: WorkflowContractV7["mutationBoundaryPlan"]["mutationSteps"];
  default_replay_mode: WorkflowContractV7["mutationBoundaryPlan"]["defaultReplayMode"];
  background_hardening: {
    allowed: boolean;
    mode: "readOnlyPrefix" | "ciOnly" | "blocked";
    reason: string;
  };
  prefix_validation: {
    read_only: true;
    available: boolean;
    stops_before_step_id: string | null;
  };
  ci_full_replay: {
    configured: boolean;
    allowed: boolean;
    blockers: string[];
  };
}

export interface PrefixValidationSummaryV7 {
  workflow_id: string;
  validation_type: "dryRunPlan";
  read_only: true;
  mutation_executed: false;
  status: WorkflowReplayPlanV7["status"];
  planned_step_count: number;
  stopped_before_step_id: string | null;
  warnings: string[];
  failure_class: FailureClassV7 | null;
  live_execution_tool: "synthi_browser_run_workflow";
  live_execution_mode: "prefixOnly";
}

export class ReplayIsolationProfileManager {
  private readonly profiles = new Map<string, ReplayIsolationProfileV7>();

  set(input: ReplayIsolationProfileInput): ReplayIsolationProfileV7 {
    const workspaceId = normalizeWorkspaceId(input.workspace_id);
    const kind = isolationKind(input.kind);
    const missing = missingIsolationFields(kind, input);
    const canRunFullMutationReplay = kind === "ciIsolated" && missing.length === 0 && input.allow_mutation_replay === true;
    const profile: ReplayIsolationProfileV7 = {
      workspace_id: workspaceId,
      kind,
      readiness: readinessFor(kind, missing, canRunFullMutationReplay),
      can_run_full_mutation_replay: canRunFullMutationReplay,
      base_url: stringOpt(input.base_url) ?? null,
      ci_command: stringOpt(input.ci_command) ?? null,
      data_reset_command: stringOpt(input.data_reset_command) ?? null,
      working_directory: stringOpt(input.working_directory) ?? null,
      auth_provider_id: stringOpt(input.auth_provider_id) ?? null,
      allow_mutation_replay: input.allow_mutation_replay === true,
      missing,
      updated_at: Date.now(),
    };
    this.profiles.set(workspaceId, profile);
    return cloneProfile(profile);
  }

  get(workspaceId?: string): ReplayIsolationProfileV7 {
    const id = normalizeWorkspaceId(workspaceId);
    const profile = this.profiles.get(id);
    return profile ? cloneProfile(profile) : emptyProfile(id);
  }

  resetForTests(): void {
    this.profiles.clear();
  }
}

export const replayIsolationProfiles = new ReplayIsolationProfileManager();

export function mutationSafetyPlanFor(contract: WorkflowContractV7, profile: ReplayIsolationProfileV7): MutationSafetyPlanV7 {
  const hasMutation = contract.mutationBoundaryPlan.mutationSteps.length > 0;
  const ciBlockers = ciReplayBlockers(contract, profile);
  const ciAllowed = hasMutation && ciBlockers.length === 0;
  return {
    workflow_id: contract.workflowId,
    has_mutation: hasMutation,
    first_mutation_step_id: contract.mutationBoundaryPlan.firstMutationStepId ?? null,
    mutation_steps: contract.mutationBoundaryPlan.mutationSteps,
    default_replay_mode: contract.mutationBoundaryPlan.defaultReplayMode,
    background_hardening: hasMutation
      ? ciAllowed
        ? {
          allowed: true,
          mode: "ciOnly",
          reason: "Full mutation hardening is allowed only in the configured isolated CI profile.",
        }
        : {
          allowed: false,
          mode: "blocked",
          reason: "Mutation hardening is blocked until an isolated CI replay profile is configured.",
        }
      : {
        allowed: true,
        mode: "readOnlyPrefix",
        reason: "No mutation boundary was detected; read-only prefix validation can cover the full trace.",
      },
    prefix_validation: {
      read_only: true,
      available: contract.steps.length > 0 && contract.mutationBoundaryPlan.defaultReplayMode !== "blocked",
      stops_before_step_id: contract.mutationBoundaryPlan.firstMutationStepId ?? null,
    },
    ci_full_replay: {
      configured: profile.readiness === "ciIsolatedReady",
      allowed: ciAllowed,
      blockers: ciBlockers,
    },
  };
}

export function prefixValidationSummaryFor(
  plan: WorkflowReplayPlanV7,
  failureClass: FailureClassV7 | null
): PrefixValidationSummaryV7 {
  return {
    workflow_id: plan.workflowId,
    validation_type: "dryRunPlan",
    read_only: true,
    mutation_executed: false,
    status: plan.status,
    planned_step_count: plan.events.length,
    stopped_before_step_id: plan.stoppedBeforeStepId ?? null,
    warnings: plan.warnings,
    failure_class: failureClass,
    live_execution_tool: "synthi_browser_run_workflow",
    live_execution_mode: "prefixOnly",
  };
}

export function blockedHardeningExplanationFor(contract: WorkflowContractV7, profile: ReplayIsolationProfileV7): {
  workflow_id: string;
  blocked: boolean;
  failure_class: FailureClassV7 | null;
  explanation: string;
  next_action: string;
  blockers: string[];
} {
  const plan = mutationSafetyPlanFor(contract, profile);
  const blockers = plan.ci_full_replay.blockers;
  if (blockers.length === 0) {
    return {
      workflow_id: contract.workflowId,
      blocked: false,
      failure_class: null,
      explanation: "Hardening is not blocked by mutation isolation.",
      next_action: plan.has_mutation ? "Run CI-only full replay in the configured isolation profile." : "Run prefix validation.",
      blockers,
    };
  }
  return {
    workflow_id: contract.workflowId,
    blocked: true,
    failure_class: plan.has_mutation ? "mutationBlocked" : "unknown",
    explanation: "Background hardening cannot execute unsafe workflow steps without a configured isolated replay environment.",
    next_action: "Run prefix validation now, or configure a ciIsolated replay profile with a resettable base URL and explicit mutation replay permission.",
    blockers,
  };
}

function ciReplayBlockers(contract: WorkflowContractV7, profile: ReplayIsolationProfileV7): string[] {
  const blockers: string[] = [];
  if (contract.steps.length === 0) blockers.push("no_actionable_steps");
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0 && profile.readiness !== "ciIsolatedReady") {
    blockers.push("ci_isolation_profile_not_ready");
  }
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0 && !profile.allow_mutation_replay) {
    blockers.push("mutation_replay_not_explicitly_allowed");
  }
  if (contract.limitations.includes("closedShadowDomBlocked")) blockers.push("closed_shadow_dom_blocked");
  if (contract.limitations.includes("popupOrMultiTab")) blockers.push("popup_or_multi_tab_blocked");
  if (contract.limitations.includes("iframeNeedsFrameLocator")) blockers.push("iframe_frame_locator_missing");
  return [...new Set(blockers)];
}

function missingIsolationFields(kind: ReplayIsolationKindV7, input: ReplayIsolationProfileInput): string[] {
  if (kind !== "ciIsolated") return [];
  const missing: string[] = [];
  if (!stringOpt(input.base_url)) missing.push("base_url");
  if (!stringOpt(input.ci_command)) missing.push("ci_command");
  if (!stringOpt(input.data_reset_command)) missing.push("data_reset_command");
  if (input.allow_mutation_replay !== true) missing.push("allow_mutation_replay");
  return missing;
}

function readinessFor(kind: ReplayIsolationKindV7, missing: string[], canRunFullMutationReplay: boolean): ReplayIsolationProfileV7["readiness"] {
  if (kind === "none") return "notConfigured";
  if (kind === "readOnlyPrefix") return "prefixOnly";
  return canRunFullMutationReplay && missing.length === 0 ? "ciIsolatedReady" : "ciIsolatedIncomplete";
}

function emptyProfile(workspaceId: string): ReplayIsolationProfileV7 {
  return {
    workspace_id: workspaceId,
    kind: "none",
    readiness: "notConfigured",
    can_run_full_mutation_replay: false,
    base_url: null,
    ci_command: null,
    data_reset_command: null,
    working_directory: null,
    auth_provider_id: null,
    allow_mutation_replay: false,
    missing: [],
    updated_at: null,
  };
}

function cloneProfile(profile: ReplayIsolationProfileV7): ReplayIsolationProfileV7 {
  return { ...profile, missing: [...profile.missing] };
}

function isolationKind(value: unknown): ReplayIsolationKindV7 {
  if (value === "readOnlyPrefix" || value === "ciIsolated") return value;
  return "none";
}

function normalizeWorkspaceId(workspaceId: string | undefined): string {
  return typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : "default";
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
