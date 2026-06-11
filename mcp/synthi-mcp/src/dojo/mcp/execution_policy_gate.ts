import { resolveDojoEnforcementConfig } from "../config/enforcement.js";

export type DojoActorType = "human" | "agent" | "service";
export type DojoExecutionEntrypoint = "dojo_skill_bus" | "private_tool" | "browser_workflow" | "graph_runtime";
export type DojoExecutionPolicyStatus = "allowed" | "blocked" | "approval_required" | "practice_only";
export type DojoExecutionRequiredPath = "synthi_dojo_run_with_proof_capsule";
export type DojoPublishedSkillBindingStatus = "published" | "unpublished" | "unknown";

export interface DojoTenantContext {
  tenant_id: string;
  organization_id: string;
  workspace_id: string;
  actor_id: string;
  actor_type: DojoActorType;
  roles: string[];
  request_id: string;
  correlation_id: string;
  data_region?: string;
}

export interface DojoPublishedSkillBinding {
  status: DojoPublishedSkillBindingStatus;
  skill_id?: string;
  workflow_id?: string;
  tool_name?: string;
}

export interface DojoExecutionPolicyDecision {
  ok: boolean;
  status: DojoExecutionPolicyStatus;
  enforcement_mode: "development" | "production";
  entrypoint: DojoExecutionEntrypoint;
  skill_id?: string;
  workflow_id?: string;
  tool_name?: string;
  blocked_by: string[];
  required_path?: DojoExecutionRequiredPath;
  audit_event_id?: string;
}

export interface DojoExecutionPolicyGate {
  evaluate(input: DojoExecutionPolicyInput): Promise<DojoExecutionPolicyDecision>;
}

export interface DojoExecutionPolicyInput {
  tenant: DojoTenantContext;
  entrypoint: DojoExecutionEntrypoint;
  workflow_id?: string;
  tool_name?: string;
  requested_action: string;
  proof_capsule_id?: string;
  dry_run?: boolean;
  validated_dojo_execution_context?: boolean;
}

export interface DojoExecutionPolicyGateOptions {
  env?: NodeJS.ProcessEnv;
  resolvePublishedSkill?: (input: DojoExecutionPolicyInput) => DojoPublishedSkillBinding | Promise<DojoPublishedSkillBinding>;
}

export function createDojoExecutionPolicyGate(options: DojoExecutionPolicyGateOptions = {}): DojoExecutionPolicyGate {
  return new InProcessDojoExecutionPolicyGate(options);
}

class InProcessDojoExecutionPolicyGate implements DojoExecutionPolicyGate {
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolvePublishedSkill: (input: DojoExecutionPolicyInput) => DojoPublishedSkillBinding | Promise<DojoPublishedSkillBinding>;

  constructor(options: DojoExecutionPolicyGateOptions) {
    this.env = options.env ?? process.env;
    this.resolvePublishedSkill = options.resolvePublishedSkill ?? (() => ({ status: "unknown" }));
  }

  async evaluate(input: DojoExecutionPolicyInput): Promise<DojoExecutionPolicyDecision> {
    const enforcement = resolveDojoEnforcementConfig(this.env);
    const binding = await this.resolvePublishedSkill(input);
    const mode = enforcement.production_enforcement ? "production" : "development";
    const base = baseDecision(input, binding, mode);

    if (enforcement.invalid_env.length > 0) {
      return block(base, ["dojo_enforcement_config_invalid"]);
    }

    if (mode === "development") {
      return {
        ...base,
        ok: true,
        status: input.dry_run ? "practice_only" : "allowed",
        blocked_by: [],
      };
    }

    if (binding.status === "unknown") {
      return block(base, ["published_skill_mapping_unknown"]);
    }

    if (binding.status === "unpublished") {
      return {
        ...base,
        ok: true,
        status: input.dry_run ? "practice_only" : "allowed",
        blocked_by: [],
      };
    }

    if (input.validated_dojo_execution_context && input.proof_capsule_id) {
      return {
        ...base,
        ok: true,
        status: input.dry_run ? "practice_only" : "allowed",
        blocked_by: [],
      };
    }

    if (input.entrypoint === "dojo_skill_bus" && input.proof_capsule_id) {
      return {
        ...base,
        ok: true,
        status: input.dry_run ? "practice_only" : "allowed",
        blocked_by: [],
      };
    }

    if (input.entrypoint === "private_tool" || input.entrypoint === "browser_workflow") {
      return block(base, ["direct_entrypoint_for_published_skill", "dojo_proof_capsule_required"]);
    }

    return block(base, ["dojo_proof_capsule_required"]);
  }
}

function baseDecision(
  input: DojoExecutionPolicyInput,
  binding: DojoPublishedSkillBinding,
  enforcementMode: "development" | "production"
): DojoExecutionPolicyDecision {
  return {
    ok: false,
    status: "blocked",
    enforcement_mode: enforcementMode,
    entrypoint: input.entrypoint,
    skill_id: binding.skill_id,
    workflow_id: binding.workflow_id ?? input.workflow_id,
    tool_name: binding.tool_name ?? input.tool_name,
    blocked_by: [],
  };
}

function block(
  decision: DojoExecutionPolicyDecision,
  blockedBy: string[]
): DojoExecutionPolicyDecision {
  return {
    ...decision,
    ok: false,
    status: "blocked",
    blocked_by: blockedBy,
    required_path: "synthi_dojo_run_with_proof_capsule",
  };
}
