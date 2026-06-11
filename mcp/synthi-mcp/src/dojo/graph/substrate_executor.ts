import type { DojoGraphNode } from "./types.js";

export type DojoExecutionSubstrate = "vision" | "dom" | "source" | "api" | "mcp";

export interface DojoSubstrateExecutionRequest {
  node: DojoGraphNode;
  inputs: Record<string, unknown>;
}

export interface DojoSubstrateExecutionResult {
  ok: boolean;
  status: "executed" | "blocked";
  substrate?: DojoExecutionSubstrate;
  blocked_by: string[];
  evidence_refs: string[];
}

export interface DojoSubstrateExecutor {
  execute(request: DojoSubstrateExecutionRequest): Promise<DojoSubstrateExecutionResult>;
}

export class FakeDojoSubstrateExecutor implements DojoSubstrateExecutor {
  async execute(request: DojoSubstrateExecutionRequest): Promise<DojoSubstrateExecutionResult> {
    const substrate = selectSubstrate(request.node, request.inputs);
    if (!substrate) {
      return blocked(["substrate_not_allowed"]);
    }
    if (substrate === "api" && !apiCandidateApproved(request.node, request.inputs)) {
      return blocked(["api_candidate_not_approved"], substrate);
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

export function createFakeDojoSubstrateExecutor(): DojoSubstrateExecutor {
  return new FakeDojoSubstrateExecutor();
}

function selectSubstrate(node: DojoGraphNode, inputs: Record<string, unknown>): DojoExecutionSubstrate | null {
  const nodeSubstrates = node.substrate_options.filter(isExecutionSubstrate);
  if (nodeSubstrates.length === 0) return null;
  const allowed = allowedSubstrates(inputs);
  const requested = requestedSubstrate(inputs);
  if (requested) {
    return nodeSubstrates.includes(requested) && allowed.includes(requested) ? requested : null;
  }
  return nodeSubstrates.find((substrate) => allowed.includes(substrate)) ?? null;
}

function allowedSubstrates(inputs: Record<string, unknown>): DojoExecutionSubstrate[] {
  const value = inputs["license_allowed_substrates"];
  if (Array.isArray(value)) {
    return value.filter(isExecutionSubstrate);
  }
  return ["vision", "dom", "source", "api", "mcp"];
}

function requestedSubstrate(inputs: Record<string, unknown>): DojoExecutionSubstrate | null {
  const value = inputs["requested_substrate"];
  return typeof value === "string" && isExecutionSubstrate(value) ? value : null;
}

function apiCandidateApproved(node: DojoGraphNode, inputs: Record<string, unknown>): boolean {
  if (inputs["approved_api_candidate"] === true) return true;
  const candidateId = node.metadata?.["api_candidate_id"];
  const approvedCandidates = inputs["approved_api_candidates"];
  return typeof candidateId === "string"
    && Array.isArray(approvedCandidates)
    && approvedCandidates.includes(candidateId);
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
