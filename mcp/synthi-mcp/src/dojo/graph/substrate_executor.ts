import type { DojoGraphMode, DojoGraphNode } from "./types.js";
import {
  executeDojoApiBackedToolInvocation,
  validateDojoApiBackedToolInvocation,
  type DojoApiBackedMcpTool,
  type DojoApiToolExecutionEvidence,
  type DojoApiToolExecutionResult,
  type DojoApiToolHttpRequest,
  type DojoApiToolHttpResponse,
  type DojoApiToolLicenseContext,
} from "../api/api_tool_compiler.js";

export type DojoExecutionSubstrate = "vision" | "dom" | "source" | "api" | "mcp";
const DOJO_SUBSTRATE_SAFETY_PRIORITY: DojoExecutionSubstrate[] = ["api", "mcp", "source", "dom", "vision"];

export interface DojoSubstrateExecutionRequest {
  node: DojoGraphNode;
  mode?: DojoGraphMode;
  inputs: Record<string, unknown>;
}

export interface DojoSubstrateExecutionResult {
  ok: boolean;
  status: "executed" | "blocked";
  substrate?: DojoExecutionSubstrate;
  blocked_by: string[];
  evidence_refs: string[];
  api_tool_execution?: DojoApiToolExecutionResult;
}

export interface DojoSubstrateExecutor {
  execute(request: DojoSubstrateExecutionRequest): Promise<DojoSubstrateExecutionResult>;
}

export interface DojoSubstrateExecutorOptions {
  api_transport?: (request: DojoApiToolHttpRequest) => DojoApiToolHttpResponse | Promise<DojoApiToolHttpResponse>;
  write_api_evidence?: (evidence: DojoApiToolExecutionEvidence) => string | Promise<string>;
}

export class FakeDojoSubstrateExecutor implements DojoSubstrateExecutor {
  constructor(private readonly options: DojoSubstrateExecutorOptions = {}) {}

  async execute(request: DojoSubstrateExecutionRequest): Promise<DojoSubstrateExecutionResult> {
    const selection = selectSubstrate(request.node, request.inputs, request.mode ?? "practice");
    if (!selection.ok) {
      return blocked(selection.blocked_by);
    }
    const substrate = selection.substrate;
    if (substrate === "api") {
      const apiValidation = await apiSubstrateApproved(request.node, request.inputs, this.options);
      if (!apiValidation.ok) {
        return {
          ok: false,
          status: "blocked",
          substrate,
          blocked_by: apiValidation.blocked_by,
          evidence_refs: apiValidation.execution?.evidence_record_id ? [apiValidation.execution.evidence_record_id] : [],
          ...(apiValidation.execution ? { api_tool_execution: apiValidation.execution } : {}),
        };
      }
      if (apiValidation.execution) {
        return {
          ok: true,
          status: "executed",
          substrate,
          blocked_by: [],
          evidence_refs: apiValidation.execution.evidence_record_id ? [apiValidation.execution.evidence_record_id] : [],
          api_tool_execution: apiValidation.execution,
        };
      }
    }
    return {
      ok: true,
      status: "executed",
      substrate,
      blocked_by: [],
      evidence_refs: [`substrate:${substrate}:${request.node.node_id}`],
    };
  }
}

export function createFakeDojoSubstrateExecutor(options: DojoSubstrateExecutorOptions = {}): DojoSubstrateExecutor {
  return new FakeDojoSubstrateExecutor(options);
}

type DojoSubstrateSelection =
  | { ok: true; substrate: DojoExecutionSubstrate }
  | { ok: false; blocked_by: string[] };

function selectSubstrate(
  node: DojoGraphNode,
  inputs: Record<string, unknown>,
  mode: DojoGraphMode
): DojoSubstrateSelection {
  const nodeSubstrates = node.substrate_options.filter(isExecutionSubstrate);
  if (nodeSubstrates.length === 0) return { ok: false, blocked_by: ["substrate_not_allowed"] };
  const allowed = allowedSubstrates(inputs, mode);
  if (!allowed) return { ok: false, blocked_by: ["license_substrate_policy_missing"] };
  const requested = requestedSubstrate(inputs);
  if (requested) {
    return nodeSubstrates.includes(requested) && allowed.includes(requested)
      ? { ok: true, substrate: requested }
      : { ok: false, blocked_by: ["substrate_not_allowed"] };
  }
  const selected = DOJO_SUBSTRATE_SAFETY_PRIORITY.find((substrate) =>
    nodeSubstrates.includes(substrate) && allowed.includes(substrate)
  );
  return selected ? { ok: true, substrate: selected } : { ok: false, blocked_by: ["substrate_not_allowed"] };
}

function allowedSubstrates(inputs: Record<string, unknown>, mode: DojoGraphMode): DojoExecutionSubstrate[] | null {
  const value = inputs["license_allowed_substrates"];
  if (Array.isArray(value)) {
    return value.filter(isExecutionSubstrate);
  }
  if (mode === "production") return null;
  return ["vision", "dom", "source", "api", "mcp"];
}

function requestedSubstrate(inputs: Record<string, unknown>): DojoExecutionSubstrate | null {
  const value = inputs["requested_substrate"];
  return typeof value === "string" && isExecutionSubstrate(value) ? value : null;
}

async function apiSubstrateApproved(
  node: DojoGraphNode,
  inputs: Record<string, unknown>,
  options: DojoSubstrateExecutorOptions
): Promise<{ ok: boolean; blocked_by: string[]; execution?: DojoApiToolExecutionResult }> {
  const compiledTool = objectOpt(inputs["compiled_api_tool"]);
  if (compiledTool) return compiledApiToolApproved(node, inputs, compiledTool as unknown as DojoApiBackedMcpTool, options);
  return apiCandidateApproved(node, inputs)
    ? { ok: true, blocked_by: [] }
    : { ok: false, blocked_by: ["api_candidate_not_approved"] };
}

function compiledApiToolApproved(
  node: DojoGraphNode,
  inputs: Record<string, unknown>,
  tool: DojoApiBackedMcpTool,
  options: DojoSubstrateExecutorOptions
): { ok: boolean; blocked_by: string[] } | Promise<{ ok: boolean; blocked_by: string[]; execution?: DojoApiToolExecutionResult }> {
  const candidateId = typeof node.metadata?.["api_candidate_id"] === "string" ? node.metadata["api_candidate_id"] : undefined;
  if (candidateId && tool.candidate_id !== candidateId) return { ok: false, blocked_by: ["api_tool_candidate_mismatch"] };
  const licenseContext = licenseContextOpt(inputs["license_context"]);
  if (!licenseContext) return { ok: false, blocked_by: ["api_tool_license_context_required"] };
  if (options.api_transport && options.write_api_evidence) {
    return executeDojoApiBackedToolInvocation({
      tool,
      args: objectOpt(inputs["api_tool_args"]) ?? {},
      license_context: licenseContext,
      transport: options.api_transport,
      write_evidence: options.write_api_evidence,
    }).then((execution) => ({
      ok: execution.ok,
      blocked_by: execution.blocked_by,
      execution,
    }));
  }
  return validateDojoApiBackedToolInvocation({
    tool,
    args: objectOpt(inputs["api_tool_args"]) ?? {},
    license_context: licenseContext,
  });
}

function apiCandidateApproved(node: DojoGraphNode, inputs: Record<string, unknown>): boolean {
  const candidateId = node.metadata?.["api_candidate_id"];
  const approvedCandidates = inputs["approved_api_candidates"];
  return typeof candidateId === "string"
    && Array.isArray(approvedCandidates)
    && approvedCandidates.includes(candidateId);
}

function licenseContextOpt(value: unknown): DojoApiToolLicenseContext | null {
  const record = objectOpt(value);
  if (!record) return null;
  const skillId = stringOpt(record["skill_id"]);
  const licenseId = stringOpt(record["license_id"]);
  const licenseVersion = stringOpt(record["license_version"]);
  const action = stringOpt(record["action"]);
  const authScopes = stringArrayOpt(record["auth_scopes"]);
  return skillId && licenseId && licenseVersion && action
    ? {
        skill_id: skillId,
        license_id: licenseId,
        license_version: licenseVersion,
        action,
        ...(authScopes ? { auth_scopes: authScopes } : {}),
      }
    : null;
}

function objectOpt(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayOpt(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return strings.length > 0 ? strings : undefined;
}

function isExecutionSubstrate(value: unknown): value is DojoExecutionSubstrate {
  return value === "vision" || value === "dom" || value === "source" || value === "api" || value === "mcp";
}

function blocked(blockedBy: string[], substrate?: DojoExecutionSubstrate): DojoSubstrateExecutionResult {
  return {
    ok: false,
    status: "blocked",
    ...(substrate ? { substrate } : {}),
    blocked_by: blockedBy,
    evidence_refs: [],
  };
}
