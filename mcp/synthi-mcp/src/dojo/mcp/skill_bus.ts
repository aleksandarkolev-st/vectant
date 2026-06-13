import type { DojoProofCarryingSkillCapsule, DojoSkill } from "../../browser/dojo.js";
import type { DojoTenantContext } from "./execution_policy_gate.js";
import {
  buildDojoMcpSkillManifest,
  dojoMcpManifestRequiresProof,
  validateDojoMcpSkillManifest,
  type DojoMcpSkillManifestV1,
  type DojoMcpSkillManifestValidation,
} from "./manifest_signing.js";

export interface DojoCompetencySummary {
  skill_id: string;
  workflow_id: string;
  name: string;
  app_origin: string;
  workspace_id: string;
  published_tool_name: string | null;
  tool_version: string;
  entrustment_level: DojoSkill["entrustment_level"];
  skill_readiness_level: DojoSkill["skill_readiness_level"];
  proof_required: boolean;
  preferred_substrate: DojoSkill["preferred_substrate"];
  execution_substrates: DojoSkill["execution_substrates"];
  mcp_skill_manifest: DojoMcpSkillManifestV1;
}

export interface DojoToolResolution {
  ok: boolean;
  status: "resolved" | "blocked" | "not_found";
  blocked_by: string[];
  skill_id?: string;
  workflow_id?: string;
  tool_name?: string;
  tool_version?: string;
  skill?: DojoSkill;
  mcp_skill_manifest?: DojoMcpSkillManifestV1;
  manifest_validation?: DojoMcpSkillManifestValidation;
}

export interface DojoToolDispatchResult {
  ok: boolean;
  status: "allowed" | "blocked";
  dry_run: boolean;
  blocked_by: string[];
  skill_id?: string;
  tool_name?: string;
  resolution?: DojoToolResolution;
  validation?: DojoSkillBusProofValidation;
  result?: unknown;
}

export interface DojoSkillBusProofValidation {
  ok: boolean;
  status: "allowed" | "blocked" | "approval_required";
  blocked_by: string[];
  error_codes?: string[];
}

export interface DojoMcpSkillBusExecutionBlock {
  kind: "dojoMcpSkillBusExecutionBlock";
  blocked_by: string[];
  validation?: DojoSkillBusProofValidation;
}

export interface DojoMcpSkillBus {
  listCompetencies(input: { tenant: DojoTenantContext }): Promise<DojoCompetencySummary[]>;
  resolveTool(input: { tenant: DojoTenantContext; tool_name: string; tool_version?: string }): Promise<DojoToolResolution>;
  dispatch(input: {
    tenant: DojoTenantContext;
    tool_name: string;
    tool_version?: string;
    requested_action?: string;
    args: Record<string, unknown>;
    proof_capsule?: DojoProofCarryingSkillCapsule;
    dry_run?: boolean;
  }): Promise<DojoToolDispatchResult>;
}

export interface InProcessDojoMcpSkillBusOptions {
  env?: NodeJS.ProcessEnv;
  listSkills: () => DojoSkill[] | Promise<DojoSkill[]>;
  validateProof?: (input: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
    proof_capsule: DojoProofCarryingSkillCapsule;
    requested_action: string;
    args: Record<string, unknown>;
  }) => DojoSkillBusProofValidation | Promise<DojoSkillBusProofValidation>;
  executeTool?: (input: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
    tool_name: string;
    args: Record<string, unknown>;
    proof_capsule: DojoProofCarryingSkillCapsule;
  }) => unknown | DojoMcpSkillBusExecutionBlock | Promise<unknown | DojoMcpSkillBusExecutionBlock>;
}

export function createInProcessDojoMcpSkillBus(options: InProcessDojoMcpSkillBusOptions): DojoMcpSkillBus {
  return new InProcessDojoMcpSkillBus(options);
}

export function blockDojoMcpSkillBusExecution(
  blockedBy: string[],
  validation?: DojoSkillBusProofValidation
): DojoMcpSkillBusExecutionBlock {
  return {
    kind: "dojoMcpSkillBusExecutionBlock",
    blocked_by: [...blockedBy],
    ...(validation ? { validation } : {}),
  };
}

export function createLegacyDojoTenantContext(workspaceId = "legacy-workspace"): DojoTenantContext {
  return {
    tenant_id: "legacy-local-tenant",
    organization_id: "legacy-local-org",
    workspace_id: workspaceId,
    actor_id: "legacy-mcp-caller",
    actor_type: "agent",
    roles: ["dojo:legacy"],
    request_id: "legacy-request",
    correlation_id: "legacy-correlation",
  };
}

class InProcessDojoMcpSkillBus implements DojoMcpSkillBus {
  private readonly env: NodeJS.ProcessEnv;
  private readonly listSkillsFn: InProcessDojoMcpSkillBusOptions["listSkills"];
  private readonly validateProof?: InProcessDojoMcpSkillBusOptions["validateProof"];
  private readonly executeTool?: InProcessDojoMcpSkillBusOptions["executeTool"];

  constructor(options: InProcessDojoMcpSkillBusOptions) {
    this.env = options.env ?? process.env;
    this.listSkillsFn = options.listSkills;
    this.validateProof = options.validateProof;
    this.executeTool = options.executeTool;
  }

  async listCompetencies(input: { tenant: DojoTenantContext }): Promise<DojoCompetencySummary[]> {
    const skills = await this.listSkills();
    return skills
      .filter((skill) => this.isVisibleSkill(skill, input.tenant))
      .filter(isLicensedPublishedSkill)
      .sort((a, b) => a.name.localeCompare(b.name) || a.skill_id.localeCompare(b.skill_id))
      .map((skill) => competencySummary(skill, this.env));
  }

  async resolveTool(input: { tenant: DojoTenantContext; tool_name: string; tool_version?: string }): Promise<DojoToolResolution> {
    const toolName = input.tool_name.trim();
    if (!toolName) return blockedResolution("not_found", ["dojo_mcp_tool_name_required"]);
    const skills = await this.listSkills();
    const matches = skills.filter((item) => item.published_tool_name === toolName || item.private_tool_manifest?.tool_name === toolName);
    if (matches.length > 1) {
      return blockedResolution("blocked", ["dojo_mcp_tool_ambiguous"], {
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }
    const skill = matches[0];
    if (!skill) return blockedResolution("not_found", ["dojo_mcp_tool_not_found"], { tool_name: toolName });
    if (!this.isVisibleSkill(skill, input.tenant)) {
      return blockedResolution("blocked", ["dojo_mcp_tool_not_authorized"], {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }
    if (!isLicensedPublishedSkill(skill)) {
      return blockedResolution("blocked", ["dojo_mcp_skill_not_published_or_licensed"], {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }
    if (input.tool_version && input.tool_version !== skill.skill_version) {
      return blockedResolution("blocked", ["dojo_mcp_tool_version_mismatch"], {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }

    const manifest = buildDojoMcpSkillManifest(skill, { env: this.env });
    const manifestValidation = validateDojoMcpSkillManifest(manifest, {
      env: this.env,
      expected_skill_id: skill.skill_id,
      expected_tool_name: skill.published_tool_name ?? skill.private_tool_manifest?.tool_name ?? null,
    });
    if (!manifestValidation.ok) {
      return blockedResolution("blocked", manifestValidation.blocked_by, {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: skill.skill_version,
        skill,
        mcp_skill_manifest: manifest,
        manifest_validation: manifestValidation,
      });
    }

    return {
      ok: true,
      status: "resolved",
      blocked_by: [],
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_name: toolName,
      tool_version: skill.skill_version,
      skill,
      mcp_skill_manifest: manifest,
      manifest_validation: manifestValidation,
    };
  }

  async dispatch(input: {
    tenant: DojoTenantContext;
    tool_name: string;
    tool_version?: string;
    requested_action?: string;
    args: Record<string, unknown>;
    proof_capsule?: DojoProofCarryingSkillCapsule;
    dry_run?: boolean;
  }): Promise<DojoToolDispatchResult> {
    const resolution = await this.resolveTool(input);
    if (!resolution.ok || !resolution.skill || !resolution.mcp_skill_manifest) {
      return {
        ok: false,
        status: "blocked",
        dry_run: input.dry_run === true,
        blocked_by: resolution.blocked_by,
        tool_name: input.tool_name,
        resolution,
      };
    }

    const proofRequired = dojoMcpManifestRequiresProof(resolution.mcp_skill_manifest);
    if (proofRequired && !input.proof_capsule) {
      return blockedDispatch(input, resolution, ["dojo_proof_capsule_required"]);
    }
    if (proofRequired && !this.validateProof) {
      return blockedDispatch(input, resolution, ["dojo_mcp_skill_bus_proof_validator_unconfigured"]);
    }

    let validation: DojoSkillBusProofValidation | undefined;
    if (input.proof_capsule) {
      const bindingBlockedBy = validateProofCapsuleBinding(
        input.proof_capsule,
        resolution.mcp_skill_manifest,
        input.requested_action ?? "run_workflow"
      );
      if (bindingBlockedBy.length > 0) {
        return blockedDispatch(input, resolution, bindingBlockedBy);
      }
    }

    if (input.proof_capsule && this.validateProof) {
      validation = await this.validateProof({
        tenant: input.tenant,
        skill: resolution.skill,
        proof_capsule: input.proof_capsule,
        requested_action: input.requested_action ?? "run_workflow",
        args: input.args,
      });
      if (!validation.ok) {
        return blockedDispatch(input, resolution, validation.blocked_by, validation);
      }
    }

    if (input.dry_run) {
      return {
        ok: true,
        status: "allowed",
        dry_run: true,
        blocked_by: [],
        skill_id: resolution.skill.skill_id,
        tool_name: resolution.tool_name,
        resolution: summarizeResolution(resolution),
        validation,
      };
    }

    if (!input.proof_capsule) {
      return blockedDispatch(input, resolution, ["dojo_proof_capsule_required"]);
    }
    if (!this.executeTool) {
      return blockedDispatch(input, resolution, ["dojo_mcp_skill_executor_unconfigured"], validation);
    }

    const result = await this.executeTool({
      tenant: input.tenant,
      skill: resolution.skill,
      tool_name: resolution.tool_name ?? input.tool_name,
      args: input.args,
      proof_capsule: input.proof_capsule,
    });
    if (isDojoMcpSkillBusExecutionBlock(result)) {
      return blockedDispatch(input, resolution, result.blocked_by, result.validation ?? validation);
    }
    if (result === null || typeof result === "undefined") {
      return blockedDispatch(input, resolution, ["dojo_mcp_skill_executor_unavailable"], validation);
    }
    return {
      ok: true,
      status: "allowed",
      dry_run: false,
      blocked_by: [],
      skill_id: resolution.skill.skill_id,
      tool_name: resolution.tool_name,
      resolution: summarizeResolution(resolution),
      validation,
      result,
    };
  }

  private async listSkills(): Promise<DojoSkill[]> {
    return [...(await this.listSkillsFn())];
  }

  private isVisibleSkill(skill: DojoSkill, tenant: DojoTenantContext): boolean {
    if (tenant.roles.includes("dojo:legacy")) return true;
    if (tenant.roles.some((role) => role === "admin" || role === "dojo:admin" || role === "dojo:operator")) return true;
    return skill.workspace_id === tenant.workspace_id;
  }
}

function competencySummary(skill: DojoSkill, env: NodeJS.ProcessEnv): DojoCompetencySummary {
  const manifest = buildDojoMcpSkillManifest(skill, { env });
  return {
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    name: skill.name,
    app_origin: skill.app_origin,
    workspace_id: skill.workspace_id,
    published_tool_name: skill.published_tool_name ?? null,
    tool_version: skill.skill_version,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    proof_required: dojoMcpManifestRequiresProof(manifest),
    preferred_substrate: skill.preferred_substrate,
    execution_substrates: [...skill.execution_substrates],
    mcp_skill_manifest: manifest,
  };
}

function isLicensedPublishedSkill(skill: DojoSkill): boolean {
  return Boolean(skill.published_tool_name || skill.private_tool_manifest?.tool_name)
    && skill.entrustment_level !== "EX"
    && skill.permission_license.autonomy_level !== "blocked";
}

function blockedResolution(
  status: "blocked" | "not_found",
  blockedBy: string[],
  details: Partial<DojoToolResolution> = {}
): DojoToolResolution {
  return {
    ok: false,
    status,
    blocked_by: blockedBy,
    ...details,
  };
}

function blockedDispatch(
  input: { tool_name: string; dry_run?: boolean },
  resolution: DojoToolResolution,
  blockedBy: string[],
  validation?: DojoSkillBusProofValidation
): DojoToolDispatchResult {
  return {
    ok: false,
    status: "blocked",
    dry_run: input.dry_run === true,
    blocked_by: blockedBy,
    skill_id: resolution.skill_id,
    tool_name: resolution.tool_name ?? input.tool_name,
    resolution: summarizeResolution(resolution),
    validation,
  };
}

function isDojoMcpSkillBusExecutionBlock(value: unknown): value is DojoMcpSkillBusExecutionBlock {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "dojoMcpSkillBusExecutionBlock"
    && Array.isArray((value as { blocked_by?: unknown }).blocked_by);
}

function validateProofCapsuleBinding(
  proofCapsule: DojoProofCarryingSkillCapsule,
  manifest: DojoMcpSkillManifestV1,
  requestedAction: string
): string[] {
  const blockedBy: string[] = [];
  if (proofCapsule.skill_id !== manifest.skill.skill_id) {
    blockedBy.push("dojo_mcp_proof_skill_mismatch");
  }
  if (proofCapsule.skill_version !== manifest.skill.skill_version) {
    blockedBy.push("dojo_mcp_proof_skill_version_mismatch");
  }
  if (proofCapsule.license_version !== manifest.license.license_version) {
    blockedBy.push("dojo_mcp_proof_license_version_mismatch");
  }
  if (proofCapsule.requested_action !== requestedAction) {
    blockedBy.push("dojo_mcp_proof_action_mismatch");
  }
  if (!manifest.substrate_policy.allowed_substrates.includes(proofCapsule.substrate_claim)) {
    blockedBy.push("dojo_mcp_proof_substrate_not_allowed");
  }
  return blockedBy;
}

function summarizeResolution(resolution: DojoToolResolution): DojoToolResolution {
  const { skill: _skill, ...summary } = resolution;
  return summary;
}
