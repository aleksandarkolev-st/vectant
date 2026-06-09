import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePlaywrightScript, workflowParameterEnvName } from "./trace.js";
import { classifyWorkflowReplayFailure, type FailureClassV7 } from "./workflow.js";
import { parseReplayCommand, type ReplayIsolationProfileV7 } from "./safety.js";
import type { AuthBrowserStorageState } from "./auth.js";
import type { BrowserTraceEvent } from "./types.js";
import type { CompiledWorkflowV7 } from "./workflow.js";

export interface CiIsolatedReplayInput {
  workspace_id?: string;
  workflow_id?: string;
  workflow: CompiledWorkflowV7;
  events: BrowserTraceEvent[];
  profile: ReplayIsolationProfileV7;
  parameters?: Record<string, string>;
  auth_storage_state?: AuthBrowserStorageState;
  blockers?: string[];
  timeout_ms?: number;
  artifact_root?: string;
}

export interface CiIsolatedReplayResult {
  workflow_id: string;
  workspace_id: string;
  replay_mode: "ciIsolated";
  status: "passed" | "failed" | "blocked";
  mutation_executed: boolean;
  failure_stage: "profile" | "reset" | "reset_assertion" | "ci" | "attestation" | "postcondition" | null;
  isolation_profile: {
    readiness: ReplayIsolationProfileV7["readiness"];
    base_url: string | null;
    working_directory: string | null;
    reset_profile_id: string | null;
    state_seed_id: string | null;
    allow_mutation_replay: boolean;
  };
  blockers: string[];
  failure_class: FailureClassV7 | null;
  artifacts: {
    run_id: string;
    directory: string;
    spec_path: string;
    reset_log_path: string;
    reset_assertion_log_path: string;
    ci_log_path: string;
    postcondition_log_path: string;
    attestation_path: string;
  };
  commands: {
    reset_exit_code: number | null;
    reset_assertion_exit_code: number | null;
    ci_exit_code: number | null;
    postcondition_exit_code: number | null;
  };
  report: {
    reset_output: string;
    reset_assertion_output: string;
    ci_output: string;
    postcondition_output: string;
    warnings: string[];
    parameter_env: string[];
    auth_storage_state: {
      cookie_count: number;
      origin_count: number;
      local_storage_entry_count: number;
      session_storage_entry_count: number;
    } | null;
    attested_step_ids: string[];
    required_mutation_step_ids: string[];
    missing_mutation_step_ids: string[];
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 12_000;

export async function runCiIsolatedReplay(input: CiIsolatedReplayInput): Promise<CiIsolatedReplayResult> {
  const workflowId = input.workflow_id || input.workflow.contract.workflowId;
  const workspaceId = input.workspace_id || input.profile.workspace_id;
  const runId = `ci_replay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const attestationNonce = randomUUID();
  const artifactRoot = stringOpt(input.artifact_root) ??
    stringOpt(process.env["SYNTHI_WORKFLOW_CI_ARTIFACT_DIR"]) ??
    path.join(os.tmpdir(), "synthi-workflow-ci-replay");
  const directory = path.join(artifactRoot, safePathSegment(workspaceId), safePathSegment(workflowId), runId);
  const specPath = path.join(directory, "workflow.spec.mjs");
  const resetLogPath = path.join(directory, "reset.log");
  const resetAssertionLogPath = path.join(directory, "reset-assertion.log");
  const ciLogPath = path.join(directory, "ci.log");
  const postconditionLogPath = path.join(directory, "postcondition.log");
  const attestationPath = path.join(directory, "replay-attestation.jsonl");
  const authStorageStatePath = input.auth_storage_state
    ? path.join(artifactRoot, ".internal-auth-state", safePathSegment(workspaceId), safePathSegment(workflowId), `${runId}-${randomUUID()}.json`)
    : undefined;
  await mkdir(directory, { recursive: true });
  if (authStorageStatePath) await mkdir(path.dirname(authStorageStatePath), { recursive: true });

  const generated = generatePlaywrightScript(input.events, { mode: "ciIsolated" });
  await writeFile(specPath, generated.code + "\n", "utf8");
  await writeFile(attestationPath, "", "utf8");
  if (authStorageStatePath) {
    await writeFile(authStorageStatePath, JSON.stringify(input.auth_storage_state), "utf8");
  }

  const blockers = [
    ...(input.blockers ?? []),
    ...(input.profile.readiness !== "ciIsolatedReady" ? ["ci_isolation_profile_not_ready"] : []),
    ...input.profile.missing,
    ...(!input.profile.base_url ? ["base_url"] : []),
    ...(!input.profile.ci_command ? ["ci_command"] : []),
    ...(!input.profile.data_reset_command ? ["data_reset_command"] : []),
    ...(!input.profile.reset_assertion_command ? ["reset_assertion_command"] : []),
    ...(!input.profile.postcondition_command ? ["postcondition_command"] : []),
    ...(!input.profile.reset_profile_id ? ["reset_profile_id"] : []),
    ...(!input.profile.state_seed_id ? ["state_seed_id"] : []),
  ];
  const uniqueBlockers = [...new Set(blockers)];
  const parameterEnv = parameterEnvForWorkflow(input.workflow, input.parameters ?? {});
  const commandCwd = input.profile.working_directory ?? process.cwd();

  if (uniqueBlockers.length > 0) {
    await writeFile(resetLogPath, "", "utf8");
    await writeFile(resetAssertionLogPath, "", "utf8");
    await writeFile(ciLogPath, "", "utf8");
    await writeFile(postconditionLogPath, "", "utf8");
    return resultFor(input, {
      workflowId,
      workspaceId,
      generatedWarnings: generated.warnings,
      directory,
      specPath,
      resetLogPath,
      resetAssertionLogPath,
      ciLogPath,
      postconditionLogPath,
      attestationPath,
      authStorageStatePath,
      blockers: uniqueBlockers,
      status: "blocked",
      failureClass: "mutationBlocked",
      failureStage: "profile",
      reset: null,
      resetAssertion: null,
      ci: null,
      postcondition: null,
      attestedStepIds: [],
      parameterEnvNames: Object.keys(parameterEnv),
    });
  }

  const env = {
    ...process.env,
    ...parameterEnv,
    PLAYWRIGHT_BASE_URL: input.profile.base_url!,
    SYNTHI_WORKFLOW_SPEC: specPath,
    SYNTHI_WORKFLOW_REPLAY_ATTESTATION: attestationPath,
    SYNTHI_WORKFLOW_CI_RUN_ID: runId,
    SYNTHI_WORKFLOW_CI_NONCE: attestationNonce,
    SYNTHI_WORKFLOW_CI_RESET_PROFILE_ID: input.profile.reset_profile_id!,
    SYNTHI_WORKFLOW_CI_STATE_SEED_ID: input.profile.state_seed_id!,
    SYNTHI_WORKFLOW_ID: workflowId,
    SYNTHI_WORKSPACE_ID: workspaceId,
    ...(authStorageStatePath ? { SYNTHI_WORKFLOW_STORAGE_STATE: authStorageStatePath } : {}),
    ALLOW_WORKFLOW_MUTATION: "1",
  };
  const timeoutMs = clampTimeout(input.timeout_ms);
  const reset = await runCommand(input.profile.data_reset_command!, { cwd: commandCwd, env, timeoutMs });
  await writeRedactedCommandLog(resetLogPath, reset.output);
  if (reset.exitCode !== 0) {
    await writeFile(resetAssertionLogPath, "", "utf8");
    await writeFile(ciLogPath, "", "utf8");
    await writeFile(postconditionLogPath, "", "utf8");
    return resultFor(input, {
      workflowId,
      workspaceId,
      generatedWarnings: generated.warnings,
      directory,
      specPath,
      resetLogPath,
      resetAssertionLogPath,
      ciLogPath,
      postconditionLogPath,
      attestationPath,
      authStorageStatePath,
      blockers: [],
      status: "failed",
      failureClass: classifyResetProfileFailure(reset.output),
      failureStage: "reset",
      reset,
      resetAssertion: null,
      ci: null,
      postcondition: null,
      attestedStepIds: [],
      parameterEnvNames: Object.keys(parameterEnv),
    });
  }

  const resetAssertion = await runCommand(input.profile.reset_assertion_command!, { cwd: commandCwd, env, timeoutMs });
  await writeRedactedCommandLog(resetAssertionLogPath, resetAssertion.output);
  if (resetAssertion.exitCode !== 0) {
    await writeFile(ciLogPath, "", "utf8");
    await writeFile(postconditionLogPath, "", "utf8");
    return resultFor(input, {
      workflowId,
      workspaceId,
      generatedWarnings: generated.warnings,
      directory,
      specPath,
      resetLogPath,
      resetAssertionLogPath,
      ciLogPath,
      postconditionLogPath,
      attestationPath,
      authStorageStatePath,
      blockers: [],
      status: "failed",
      failureClass: classifyResetProfileFailure(resetAssertion.output),
      failureStage: "reset_assertion",
      reset,
      resetAssertion,
      ci: null,
      postcondition: null,
      attestedStepIds: [],
      parameterEnvNames: Object.keys(parameterEnv),
    });
  }

  const ci = await runCommand(input.profile.ci_command!, { cwd: commandCwd, env, timeoutMs });
  await writeRedactedCommandLog(ciLogPath, ci.output);
  const attestedStepIds = await readAttestedStepIds(attestationPath, { runId, nonce: attestationNonce });
  const missingMutationStepIds = missingMutationSteps(input.workflow, attestedStepIds);
  const missingRequiredMutationAttestation = ci.exitCode === 0 && input.workflow.contract.mutationBoundaryPlan.mutationSteps.length > 0 && missingMutationStepIds.length > 0;
  if (ci.exitCode !== 0 || missingRequiredMutationAttestation) {
    await writeFile(postconditionLogPath, "", "utf8");
    return resultFor(input, {
      workflowId,
      workspaceId,
      generatedWarnings: generated.warnings,
      directory,
      specPath,
      resetLogPath,
      resetAssertionLogPath,
      ciLogPath,
      postconditionLogPath,
      attestationPath,
      authStorageStatePath,
      blockers: [],
      status: "failed",
      failureClass: ci.exitCode === 0
        ? "appValidationError"
        : classifyCiFailure(ci.output),
      failureStage: ci.exitCode === 0 ? "attestation" : "ci",
      reset,
      resetAssertion,
      ci,
      postcondition: null,
      attestedStepIds,
      parameterEnvNames: Object.keys(parameterEnv),
    });
  }

  const postcondition = await runCommand(input.profile.postcondition_command!, { cwd: commandCwd, env, timeoutMs });
  await writeRedactedCommandLog(postconditionLogPath, postcondition.output);
  return resultFor(input, {
    workflowId,
    workspaceId,
    generatedWarnings: generated.warnings,
    directory,
    specPath,
    resetLogPath,
    resetAssertionLogPath,
    ciLogPath,
    postconditionLogPath,
    attestationPath,
    authStorageStatePath,
    blockers: [],
    status: postcondition.exitCode === 0 ? "passed" : "failed",
    failureClass: postcondition.exitCode === 0 ? null : "appValidationError",
    failureStage: postcondition.exitCode === 0 ? null : "postcondition",
    reset,
    resetAssertion,
    ci,
    postcondition,
    attestedStepIds,
    parameterEnvNames: Object.keys(parameterEnv),
  });
}

function resultFor(
  input: CiIsolatedReplayInput,
  options: {
    workflowId: string;
    workspaceId: string;
    generatedWarnings: string[];
    directory: string;
    specPath: string;
    resetLogPath: string;
    resetAssertionLogPath: string;
    ciLogPath: string;
    postconditionLogPath: string;
    attestationPath: string;
    authStorageStatePath?: string;
    blockers: string[];
    status: CiIsolatedReplayResult["status"];
    failureClass: FailureClassV7 | null;
    failureStage: CiIsolatedReplayResult["failure_stage"];
    reset: CommandResult | null;
    resetAssertion: CommandResult | null;
    ci: CommandResult | null;
    postcondition: CommandResult | null;
    attestedStepIds: string[];
    parameterEnvNames: string[];
  }
): CiIsolatedReplayResult {
  const requiredMutationStepIds = input.workflow.contract.mutationBoundaryPlan.mutationSteps.map((step) => step.stepId);
  const missingMutationStepIds = requiredMutationStepIds.filter((stepId) => !options.attestedStepIds.includes(stepId));
  return {
    workflow_id: options.workflowId,
    workspace_id: options.workspaceId,
    replay_mode: "ciIsolated",
    status: options.status,
    mutation_executed: requiredMutationStepIds.length > 0 && missingMutationStepIds.length === 0 && options.blockers.length === 0,
    failure_stage: options.failureStage,
    isolation_profile: {
      readiness: input.profile.readiness,
      base_url: input.profile.base_url,
      working_directory: input.profile.working_directory,
      reset_profile_id: input.profile.reset_profile_id,
      state_seed_id: input.profile.state_seed_id,
      allow_mutation_replay: input.profile.allow_mutation_replay,
    },
    blockers: options.blockers,
    failure_class: options.failureClass,
    artifacts: {
      run_id: path.basename(options.directory),
      directory: options.directory,
      spec_path: options.specPath,
      reset_log_path: options.resetLogPath,
      reset_assertion_log_path: options.resetAssertionLogPath,
      ci_log_path: options.ciLogPath,
      postcondition_log_path: options.postconditionLogPath,
      attestation_path: options.attestationPath,
    },
    commands: {
      reset_exit_code: options.reset?.exitCode ?? null,
      reset_assertion_exit_code: options.resetAssertion?.exitCode ?? null,
      ci_exit_code: options.ci?.exitCode ?? null,
      postcondition_exit_code: options.postcondition?.exitCode ?? null,
    },
    report: {
      reset_output: bounded(redactOutput(options.reset?.output ?? "")),
      reset_assertion_output: bounded(redactOutput(options.resetAssertion?.output ?? "")),
      ci_output: bounded(redactOutput(options.ci?.output ?? "")),
      postcondition_output: bounded(redactOutput(options.postcondition?.output ?? "")),
      warnings: options.generatedWarnings,
      parameter_env: options.parameterEnvNames.sort(),
      auth_storage_state: input.auth_storage_state ? authStorageStateSummary(input.auth_storage_state) : null,
      attested_step_ids: [...options.attestedStepIds].sort(),
      required_mutation_step_ids: requiredMutationStepIds,
      missing_mutation_step_ids: missingMutationStepIds,
    },
  };
}

function authStorageStateSummary(storageState: AuthBrowserStorageState): NonNullable<CiIsolatedReplayResult["report"]["auth_storage_state"]> {
  const origins = storageState.origins ?? [];
  return {
    cookie_count: (storageState.cookies ?? []).length,
    origin_count: origins.length,
    local_storage_entry_count: origins.reduce((count, origin) => count + (origin.localStorage ?? []).length, 0),
    session_storage_entry_count: origins.reduce((count, origin) => count + (origin.sessionStorage ?? []).length, 0),
  };
}

async function writeRedactedCommandLog(filePath: string, output: string): Promise<void> {
  await writeFile(filePath, bounded(redactOutput(output)), "utf8");
}

async function readAttestedStepIds(attestationPath: string, expected: { runId: string; nonce: string }): Promise<string[]> {
  let content = "";
  try {
    content = await readFile(attestationPath, "utf8");
  } catch {
    return [];
  }
  const stepIds = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        step_id?: unknown;
        event_id?: unknown;
        step_ids?: unknown;
        run_id?: unknown;
        nonce?: unknown;
      };
      if (parsed.run_id !== expected.runId || parsed.nonce !== expected.nonce) continue;
      if (typeof parsed.step_id === "string" && parsed.step_id.length > 0) stepIds.add(parsed.step_id);
      if (typeof parsed.event_id === "string" && parsed.event_id.length > 0) stepIds.add(parsed.event_id);
      if (Array.isArray(parsed.step_ids)) {
        for (const stepId of parsed.step_ids) {
          if (typeof stepId === "string" && stepId.length > 0) stepIds.add(stepId);
        }
      }
    } catch {
      continue;
    }
  }
  return [...stepIds];
}

function missingMutationSteps(workflow: CompiledWorkflowV7, attestedStepIds: string[]): string[] {
  const attested = new Set(attestedStepIds);
  return workflow.contract.mutationBoundaryPlan.mutationSteps
    .map((step) => step.stepId)
    .filter((stepId) => !attested.has(stepId));
}

interface CommandResult {
  exitCode: number | null;
  output: string;
}

async function runCommand(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const argv = parseReplayCommand(command);
    if (!argv || argv.length === 0) {
      resolve({ exitCode: 1, output: "invalid command line" });
      return;
    }
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: 1, output: bounded(message) });
      return;
    }
    let output = "";
    const append = (chunk: Buffer) => {
      output = bounded(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      output = bounded(`${output}\n[timeout after ${options.timeoutMs}ms]`);
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: bounded(`${output}\n${err.message}`) });
    });
  });
}

function parameterEnvForWorkflow(workflow: CompiledWorkflowV7, parameters: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const source = new Map(Object.entries(parameters));
  for (const parameter of workflow.contract.parameters) {
    const normalized = workflowParameterEnvName(parameter.name);
    const value = source.get(parameter.name) ?? source.get(normalized);
    if (value !== undefined) env[normalized] = String(value);
  }
  for (const [key, value] of source) {
    const normalized = workflowParameterEnvName(key);
    if (normalized && env[normalized] === undefined) env[normalized] = String(value);
  }
  return env;
}

function classifyCiFailure(output: string): FailureClassV7 {
  return classifyWorkflowReplayFailure(new Error(output));
}

function classifyResetProfileFailure(output: string): FailureClassV7 {
  if (/(reset|profile|seed|fixture|test[-_ ]?data|baseline).*(missing|mismatch|not found|unavailable|wrong)|missing.*(reset|profile|seed|fixture|test[-_ ]?data)|mismatch.*(reset|profile|seed)/i.test(output)) {
    return "testDataMissing";
  }
  return "appValidationError";
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function bounded(value: string): string {
  if (value.length <= OUTPUT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_LIMIT)}\n[truncated ${value.length - OUTPUT_LIMIT} bytes]`;
}

function redactOutput(value: string): string {
  return value
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s"'`,;]+/gi, "authorization: bearer [redacted]")
    .replace(/\bbearer\s+[^\s"'`,;]+/gi, "bearer [redacted]")
    .replace(/(["']?(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|cookie|session)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, "$1[redacted]")
    .replace(/((?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|cookie|session)\s*[:=]\s*)([^\s]+)/gi, "$1[redacted]");
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
