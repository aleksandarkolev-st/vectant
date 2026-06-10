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
  reset_assertion_command?: string;
  postcondition_command?: string;
  working_directory?: string;
  auth_provider_id?: string;
  reset_profile_id?: string;
  state_seed_id?: string;
  allow_mutation_replay?: boolean;
}

export const REPLAY_ISOLATION_PROFILE_SCHEMA_VERSION = "synthi.replayIsolationProfile.v1" as const;

export interface ReplayIsolationProfileManifestV7 {
  schema_version: typeof REPLAY_ISOLATION_PROFILE_SCHEMA_VERSION;
  workspace_id?: string;
  kind?: ReplayIsolationKindV7;
  base_url?: string;
  commands?: {
    ci?: string;
    data_reset?: string;
    reset_assertion?: string;
    postcondition?: string;
  };
  working_directory?: string;
  auth_provider_id?: string;
  reset_profile_id?: string;
  state_seed_id?: string;
  allow_mutation_replay?: boolean;
}

export interface ReplayIsolationProfileDocumentV7 extends ReplayIsolationProfileManifestV7 {
  workspace_id: string;
  kind: ReplayIsolationKindV7;
  readiness: ReplayIsolationProfileV7["readiness"];
  can_run_full_mutation_replay: boolean;
  missing: string[];
  updated_at: number | null;
}

export interface ReplayIsolationProfileV7 {
  workspace_id: string;
  kind: ReplayIsolationKindV7;
  readiness: "notConfigured" | "prefixOnly" | "ciIsolatedReady" | "ciIsolatedIncomplete";
  can_run_full_mutation_replay: boolean;
  base_url: string | null;
  ci_command: string | null;
  data_reset_command: string | null;
  reset_assertion_command: string | null;
  postcondition_command: string | null;
  working_directory: string | null;
  auth_provider_id: string | null;
  reset_profile_id: string | null;
  state_seed_id: string | null;
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
      reset_assertion_command: stringOpt(input.reset_assertion_command) ?? null,
      postcondition_command: stringOpt(input.postcondition_command) ?? null,
      working_directory: stringOpt(input.working_directory) ?? null,
      auth_provider_id: stringOpt(input.auth_provider_id) ?? null,
      reset_profile_id: stringOpt(input.reset_profile_id) ?? null,
      state_seed_id: stringOpt(input.state_seed_id) ?? null,
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

export function replayIsolationProfileInputFromManifest(manifest: unknown): ReplayIsolationProfileInput {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return {};
  const value = manifest as Record<string, unknown>;
  const commands = value["commands"] && typeof value["commands"] === "object" && !Array.isArray(value["commands"])
    ? value["commands"] as Record<string, unknown>
    : {};
  return {
    workspace_id: stringOpt(value["workspace_id"]),
    kind: isolationKind(value["kind"]),
    base_url: stringOpt(value["base_url"]),
    ci_command: stringOpt(commands["ci"]) ?? stringOpt(value["ci_command"]),
    data_reset_command: stringOpt(commands["data_reset"]) ?? stringOpt(value["data_reset_command"]),
    reset_assertion_command: stringOpt(commands["reset_assertion"]) ?? stringOpt(value["reset_assertion_command"]),
    postcondition_command: stringOpt(commands["postcondition"]) ?? stringOpt(value["postcondition_command"]),
    working_directory: stringOpt(value["working_directory"]),
    auth_provider_id: stringOpt(value["auth_provider_id"]),
    reset_profile_id: stringOpt(value["reset_profile_id"]),
    state_seed_id: stringOpt(value["state_seed_id"]),
    allow_mutation_replay: typeof value["allow_mutation_replay"] === "boolean" ? value["allow_mutation_replay"] as boolean : undefined,
  };
}

export function mergeReplayIsolationProfileInputs(
  base: ReplayIsolationProfileInput,
  override: ReplayIsolationProfileInput
): ReplayIsolationProfileInput {
  return {
    workspace_id: override.workspace_id ?? base.workspace_id,
    kind: override.kind ?? base.kind,
    base_url: override.base_url ?? base.base_url,
    ci_command: override.ci_command ?? base.ci_command,
    data_reset_command: override.data_reset_command ?? base.data_reset_command,
    reset_assertion_command: override.reset_assertion_command ?? base.reset_assertion_command,
    postcondition_command: override.postcondition_command ?? base.postcondition_command,
    working_directory: override.working_directory ?? base.working_directory,
    auth_provider_id: override.auth_provider_id ?? base.auth_provider_id,
    reset_profile_id: override.reset_profile_id ?? base.reset_profile_id,
    state_seed_id: override.state_seed_id ?? base.state_seed_id,
    allow_mutation_replay: override.allow_mutation_replay ?? base.allow_mutation_replay,
  };
}

export function replayIsolationProfileManifestFor(profile: ReplayIsolationProfileV7): ReplayIsolationProfileDocumentV7 {
  const manifest: ReplayIsolationProfileDocumentV7 = {
    schema_version: REPLAY_ISOLATION_PROFILE_SCHEMA_VERSION,
    workspace_id: profile.workspace_id,
    kind: profile.kind,
    readiness: profile.readiness,
    can_run_full_mutation_replay: profile.can_run_full_mutation_replay,
    missing: [...profile.missing],
    updated_at: profile.updated_at,
  };
  if (profile.base_url) manifest.base_url = profile.base_url;
  const commands: NonNullable<ReplayIsolationProfileManifestV7["commands"]> = {};
  if (profile.ci_command) commands.ci = profile.ci_command;
  if (profile.data_reset_command) commands.data_reset = profile.data_reset_command;
  if (profile.reset_assertion_command) commands.reset_assertion = profile.reset_assertion_command;
  if (profile.postcondition_command) commands.postcondition = profile.postcondition_command;
  if (Object.keys(commands).length > 0) manifest.commands = commands;
  if (profile.working_directory) manifest.working_directory = profile.working_directory;
  if (profile.auth_provider_id) manifest.auth_provider_id = profile.auth_provider_id;
  if (profile.reset_profile_id) manifest.reset_profile_id = profile.reset_profile_id;
  if (profile.state_seed_id) manifest.state_seed_id = profile.state_seed_id;
  manifest.allow_mutation_replay = profile.allow_mutation_replay;
  return manifest;
}

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
    blockers.push(...profile.missing);
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
  validateReplayCommandField(missing, "ci_command", input.ci_command);
  validateReplayCommandField(missing, "data_reset_command", input.data_reset_command);
  validateReplayCommandField(missing, "reset_assertion_command", input.reset_assertion_command);
  validateReplayCommandField(missing, "postcondition_command", input.postcondition_command);
  if (!stringOpt(input.reset_profile_id)) missing.push("reset_profile_id");
  if (!stringOpt(input.state_seed_id)) missing.push("state_seed_id");
  if (input.allow_mutation_replay !== true) missing.push("allow_mutation_replay");
  return missing;
}

function validateReplayCommandField(missing: string[], field: string, value: unknown): void {
  const command = stringOpt(value);
  if (!command) {
    missing.push(field);
    return;
  }
  if (replayCommandSyntaxError(command)) {
    missing.push(`invalid_${field}`);
  }
}

export function parseReplayCommand(command: string): string[] | null {
  if (replayCommandSyntaxError(command)) return null;
  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "\"") {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === "\"" && quote !== "'") {
      quote = quote === "\"" ? null : "\"";
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote !== null) return null;
  if (current.length > 0) argv.push(current);
  return argv.length > 0 ? argv : null;
}

export function replayCommandSyntaxError(command: string): string | null {
  if (command.trim().length === 0) return "empty";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "\"") {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === "\"" && quote !== "'") {
      quote = quote === "\"" ? null : "\"";
      continue;
    }
    if (quote !== null) continue;
    if (char === "\n" || char === "\r") return "newline";
    if (char === ";" || char === "|" || char === "&" || char === "<" || char === ">" || char === "`") {
      return "shell_control";
    }
    if (char === "$" && command[index + 1] === "(") return "shell_substitution";
  }
  if (quote !== null) return "unclosed_quote";
  return null;
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
    reset_assertion_command: null,
    postcondition_command: null,
    working_directory: null,
    auth_provider_id: null,
    reset_profile_id: null,
    state_seed_id: null,
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
