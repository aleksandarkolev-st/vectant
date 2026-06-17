import { randomUUID } from "node:crypto";
import type { DojoProofCarryingSkillCapsule, DojoSkill } from "../../browser/dojo.js";
import type { DojoApiBackedMcpTool } from "../api/api_tool_compiler.js";
import type { DojoProofCapsuleService } from "../proof/capsule_service.js";
import type { DojoAuditStore, DojoProofConsumeResult } from "../store/interfaces.js";
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
  api_backed_mcp_tools: Array<{
    tool_name: string;
    tool_version: string;
    action: string;
    path: string;
    method: string;
    schema_digest: string;
  }>;
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
  resolved_tool?: DojoResolvedMcpTool;
  api_backed_mcp_tool?: DojoApiBackedMcpTool;
  skill?: DojoSkill;
  mcp_skill_manifest?: DojoMcpSkillManifestV1;
  manifest_validation?: DojoMcpSkillManifestValidation;
}

export type DojoResolvedMcpTool =
  | {
      kind: "api_backed";
      tool_name: string;
      tool_version: string;
      api_backed_mcp_tool: DojoApiBackedMcpTool;
    }
  | {
      kind: "private_workflow" | "skill";
      tool_name: string;
      tool_version: string;
    };

export interface DojoToolDispatchResult {
  ok: boolean;
  status: "allowed" | "blocked";
  dry_run: boolean;
  blocked_by: string[];
  skill_id?: string;
  tool_name?: string;
  resolution?: DojoToolResolution;
  validation?: DojoSkillBusProofValidation;
  rate_limit?: DojoMcpSkillBusRateLimitDecision;
  proof_consume?: DojoProofConsumeResult;
  audit_event_id?: string;
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

export type DojoMcpSkillBusRateLimitScope =
  | "tenant"
  | "workspace"
  | "skill"
  | "actor"
  | "action"
  | "tool";

export interface DojoMcpSkillBusRateLimitRule {
  rule_id: string;
  scope: DojoMcpSkillBusRateLimitScope[];
  max_calls: number;
  window_ms: number;
  include_dry_run?: boolean;
}

export interface DojoMcpSkillBusRateLimitInput {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  tool_name: string;
  requested_action: string;
  dry_run: boolean;
}

export interface DojoMcpSkillBusRateLimitDecision {
  ok: boolean;
  blocked_by: string[];
  rule_id?: string;
  scope_key?: string;
  limit?: number;
  remaining?: number;
  retry_after_ms?: number;
}

export interface DojoMcpSkillBusRateLimiter {
  evaluate(input: DojoMcpSkillBusRateLimitInput): DojoMcpSkillBusRateLimitDecision | Promise<DojoMcpSkillBusRateLimitDecision>;
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
  proofService?: DojoProofCapsuleService;
  proofConsumptionMode?: "proof_service" | "external_executor";
  executeTool?: (input: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
    resolved_tool: DojoResolvedMcpTool;
    api_backed_mcp_tool?: DojoApiBackedMcpTool;
    tool_name: string;
    args: Record<string, unknown>;
    proof_capsule: DojoProofCarryingSkillCapsule;
  }) => unknown | DojoMcpSkillBusExecutionBlock | Promise<unknown | DojoMcpSkillBusExecutionBlock>;
  rateLimiter?: DojoMcpSkillBusRateLimiter;
  auditStore?: DojoAuditStore;
  now?: () => Date;
}

export function createInProcessDojoMcpSkillBus(options: InProcessDojoMcpSkillBusOptions): DojoMcpSkillBus {
  return new InProcessDojoMcpSkillBus(options);
}

export function createInMemoryDojoMcpSkillBusRateLimiter(options: {
  rules: DojoMcpSkillBusRateLimitRule[];
  now?: () => Date;
}): DojoMcpSkillBusRateLimiter {
  return new InMemoryDojoMcpSkillBusRateLimiter(options);
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
  private readonly proofService?: DojoProofCapsuleService;
  private readonly proofConsumptionMode?: "proof_service" | "external_executor";
  private readonly executeTool?: InProcessDojoMcpSkillBusOptions["executeTool"];
  private readonly rateLimiter?: DojoMcpSkillBusRateLimiter;
  private readonly auditStore?: DojoAuditStore;
  private readonly nowFn: () => Date;

  constructor(options: InProcessDojoMcpSkillBusOptions) {
    this.env = options.env ?? process.env;
    this.listSkillsFn = options.listSkills;
    this.proofService = options.proofService;
    this.proofConsumptionMode = options.proofConsumptionMode ?? (options.proofService ? "proof_service" : undefined);
    this.validateProof = options.validateProof ?? proofServiceValidator(options.proofService, options.now);
    this.executeTool = options.executeTool;
    this.rateLimiter = options.rateLimiter;
    this.auditStore = options.auditStore;
    this.nowFn = options.now ?? (() => new Date());
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
    const matches = skills.filter((item) => skillPublishesToolName(item, toolName));
    if (matches.length > 1) {
      return blockedResolution("blocked", ["dojo_mcp_tool_ambiguous"], {
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }
    const skill = matches[0];
    if (!skill) return blockedResolution("not_found", ["dojo_mcp_tool_not_found"], { tool_name: toolName });
    const resolvedTool = resolvePublishedTool(skill, toolName);
    if (!resolvedTool) {
      return blockedResolution("not_found", ["dojo_mcp_tool_not_found"], {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }
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
    if (input.tool_version && input.tool_version !== resolvedTool.tool_version) {
      return blockedResolution("blocked", ["dojo_mcp_tool_version_mismatch"], {
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        tool_name: toolName,
        tool_version: input.tool_version,
      });
    }

    const manifest = buildDojoMcpSkillManifest(skill, { env: this.env, tool_name: toolName });
    const manifestValidation = validateDojoMcpSkillManifest(manifest, {
      env: this.env,
      expected_skill_id: skill.skill_id,
      expected_tool_name: toolName,
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
      tool_name: resolvedTool.tool_name,
      tool_version: resolvedTool.tool_version,
      resolved_tool: resolvedTool,
      ...(resolvedTool.kind === "api_backed" ? { api_backed_mcp_tool: resolvedTool.api_backed_mcp_tool } : {}),
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
      return this.auditDispatch(input, {
        ok: false,
        status: "blocked",
        dry_run: input.dry_run === true,
        blocked_by: resolution.blocked_by,
        tool_name: input.tool_name,
        resolution,
      });
    }

    const requestedAction = input.requested_action ?? "run_workflow";
    if (this.rateLimiter) {
      const rateLimit = await this.evaluateRateLimit({
        tenant: input.tenant,
        skill: resolution.skill,
        tool_name: resolution.tool_name ?? input.tool_name,
        requested_action: requestedAction,
        dry_run: input.dry_run === true,
      });
      if (!rateLimit.ok) {
        return this.auditDispatch(input, blockedDispatch(
          input,
          resolution,
          rateLimit.blocked_by.length > 0 ? rateLimit.blocked_by : ["dojo_mcp_rate_limit_exceeded"],
          undefined,
          rateLimit
        ));
      }
    }

    const proofRequired = dojoMcpManifestRequiresProof(resolution.mcp_skill_manifest);
    if (proofRequired && !input.proof_capsule) {
      return this.auditDispatch(input, blockedDispatch(input, resolution, ["dojo_proof_capsule_required"]));
    }
    if (proofRequired && !this.validateProof) {
      return this.auditDispatch(input, blockedDispatch(input, resolution, ["dojo_mcp_skill_bus_proof_validator_unconfigured"]));
    }

    let validation: DojoSkillBusProofValidation | undefined;
    if (input.proof_capsule) {
      const bindingBlockedBy = validateProofCapsuleBinding(
        input.proof_capsule,
        resolution.mcp_skill_manifest,
        requestedAction
      );
      if (bindingBlockedBy.length > 0) {
        return this.auditDispatch(input, blockedDispatch(input, resolution, bindingBlockedBy));
      }
    }

    if (input.proof_capsule && this.validateProof) {
      validation = await this.validateDispatchProof({
        tenant: input.tenant,
        skill: resolution.skill,
        proof_capsule: input.proof_capsule,
        requested_action: requestedAction,
        args: input.args,
      });
      if (!validation.ok) {
        return this.auditDispatch(input, blockedDispatch(input, resolution, validation.blocked_by, validation));
      }
    }

    if (input.dry_run) {
      return this.auditDispatch(input, {
        ok: true,
        status: "allowed",
        dry_run: true,
        blocked_by: [],
        skill_id: resolution.skill.skill_id,
        tool_name: resolution.tool_name,
        resolution: summarizeResolution(resolution),
        validation,
      });
    }

    if (!input.proof_capsule) {
      return this.auditDispatch(input, blockedDispatch(input, resolution, ["dojo_proof_capsule_required"]));
    }
    if (proofRequired && !this.hasProofConsumer()) {
      return this.auditDispatch(input, blockedDispatch(input, resolution, ["dojo_mcp_skill_bus_proof_consumer_unconfigured"], validation));
    }
    if (!this.executeTool) {
      return this.auditDispatch(input, blockedDispatch(input, resolution, ["dojo_mcp_skill_executor_unconfigured"], validation));
    }
    const proofConsume = await this.consumeDispatchProof({
      tenant: input.tenant,
      capsule_id: input.proof_capsule.capsule_id,
      skill_id: resolution.skill.skill_id,
    });
    if (proofConsume && !proofConsume.ok) {
      return this.auditDispatch(input, {
        ...blockedDispatch(input, resolution, proofConsume.blocked_by.length > 0 ? proofConsume.blocked_by : ["proof_capsule_replay_detected"], validation),
        proof_consume: proofConsume,
      });
    }

    const result = await this.executeSkillTool({
      tenant: input.tenant,
      skill: resolution.skill,
      resolved_tool: resolution.resolved_tool ?? fallbackResolvedTool(resolution.skill, resolution.tool_name ?? input.tool_name),
      api_backed_mcp_tool: resolution.api_backed_mcp_tool,
      tool_name: resolution.tool_name ?? input.tool_name,
      args: input.args,
      proof_capsule: input.proof_capsule,
    });
    if (isDojoMcpSkillBusExecutionBlock(result)) {
      return this.auditDispatch(input, {
        ...blockedDispatch(input, resolution, result.blocked_by, result.validation ?? validation),
        ...(proofConsume ? { proof_consume: proofConsume } : {}),
      });
    }
    if (result === null || typeof result === "undefined") {
      return this.auditDispatch(input, {
        ...blockedDispatch(input, resolution, ["dojo_mcp_skill_executor_unavailable"], validation),
        ...(proofConsume ? { proof_consume: proofConsume } : {}),
      });
    }
    return this.auditDispatch(input, {
      ok: true,
      status: "allowed",
      dry_run: false,
      blocked_by: [],
      skill_id: resolution.skill.skill_id,
      tool_name: resolution.tool_name,
      resolution: summarizeResolution(resolution),
      validation,
      ...(proofConsume ? { proof_consume: proofConsume } : {}),
      result,
    });
  }

  private async listSkills(): Promise<DojoSkill[]> {
    return [...(await this.listSkillsFn())];
  }

  private isVisibleSkill(skill: DojoSkill, tenant: DojoTenantContext): boolean {
    if (tenant.roles.includes("dojo:legacy")) return true;
    if (tenant.roles.some((role) => role === "admin" || role === "dojo:admin" || role === "dojo:operator")) return true;
    return skill.workspace_id === tenant.workspace_id;
  }

  private async auditDispatch(
    input: {
      tenant: DojoTenantContext;
      tool_name: string;
      tool_version?: string;
      requested_action?: string;
      proof_capsule?: DojoProofCarryingSkillCapsule;
      dry_run?: boolean;
    },
    result: DojoToolDispatchResult
  ): Promise<DojoToolDispatchResult> {
    if (!this.auditStore) return result;
    const audit = await this.auditStore.appendAuditEvent({
      tenant_id: input.tenant.tenant_id,
      workspace_id: input.tenant.workspace_id,
      actor: {
        actor_id: input.tenant.actor_id,
        actor_type: input.tenant.actor_type,
      },
      event_type: result.ok ? "mcp_tool_invocation_allowed" : "mcp_tool_invocation_blocked",
      request_id: input.tenant.request_id,
      correlation_id: input.tenant.correlation_id,
      entity_kind: "mcp_tool_invocation",
      entity_id: result.tool_name ?? input.tool_name,
      details: {
        organization_id: input.tenant.organization_id,
        skill_id: result.skill_id ?? result.resolution?.skill_id,
        workflow_id: result.resolution?.workflow_id,
        tool_name: result.tool_name ?? input.tool_name,
        tool_version: result.resolution?.tool_version ?? input.tool_version,
        requested_action: input.requested_action ?? "run_workflow",
        dry_run: input.dry_run === true,
        status: result.status,
        blocked_by: [...result.blocked_by],
        proof_capsule_id: input.proof_capsule?.capsule_id,
        proof_validation: result.validation ? summarizeProofValidation(result.validation) : undefined,
        proof_consume: result.proof_consume ? summarizeProofConsumeResult(result.proof_consume) : undefined,
        manifest_id: result.resolution?.mcp_skill_manifest?.manifest_id,
        rate_limit: result.rate_limit ? summarizeRateLimitDecision(result.rate_limit) : undefined,
      },
      created_at: this.nowFn().toISOString(),
    });
    return {
      ...result,
      audit_event_id: audit.audit_event_id,
    };
  }

  private async consumeDispatchProof(input: {
    tenant: DojoTenantContext;
    capsule_id: string;
    skill_id: string;
  }): Promise<DojoProofConsumeResult | undefined> {
    if (!this.proofService) return undefined;
    return this.proofService.consume({
      tenant: input.tenant,
      capsule_id: input.capsule_id,
      run_id: `dojo_mcp_dispatch_${input.skill_id}_${randomUUID()}`,
      now: this.nowFn().toISOString(),
    });
  }

  private hasProofConsumer(): boolean {
    return Boolean(this.proofService) || this.proofConsumptionMode === "external_executor";
  }

  private async evaluateRateLimit(input: DojoMcpSkillBusRateLimitInput): Promise<DojoMcpSkillBusRateLimitDecision> {
    if (!this.rateLimiter) {
      return {
        ok: true,
        blocked_by: [],
      };
    }
    try {
      return await this.rateLimiter.evaluate(input);
    } catch {
      return {
        ok: false,
        blocked_by: ["dojo_mcp_rate_limiter_failed"],
      };
    }
  }

  private async validateDispatchProof(input: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
    proof_capsule: DojoProofCarryingSkillCapsule;
    requested_action: string;
    args: Record<string, unknown>;
  }): Promise<DojoSkillBusProofValidation> {
    if (!this.validateProof) {
      return {
        ok: false,
        status: "blocked",
        blocked_by: ["dojo_mcp_skill_bus_proof_validator_unconfigured"],
        error_codes: ["dojo_mcp_skill_bus_proof_validator_unconfigured"],
      };
    }
    try {
      return await this.validateProof(input);
    } catch {
      return {
        ok: false,
        status: "blocked",
        blocked_by: ["dojo_mcp_skill_bus_proof_validator_failed"],
        error_codes: ["dojo_mcp_skill_bus_proof_validator_failed"],
      };
    }
  }

  private async executeSkillTool(input: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
    resolved_tool: DojoResolvedMcpTool;
    api_backed_mcp_tool?: DojoApiBackedMcpTool;
    tool_name: string;
    args: Record<string, unknown>;
    proof_capsule: DojoProofCarryingSkillCapsule;
  }): Promise<unknown | DojoMcpSkillBusExecutionBlock> {
    if (!this.executeTool) {
      return blockDojoMcpSkillBusExecution(["dojo_mcp_skill_executor_unconfigured"]);
    }
    try {
      return await this.executeTool(input);
    } catch {
      return blockDojoMcpSkillBusExecution(["dojo_mcp_skill_executor_failed"], {
        ok: false,
        status: "blocked",
        blocked_by: ["dojo_mcp_skill_executor_failed"],
        error_codes: ["dojo_mcp_skill_executor_failed"],
      });
    }
  }
}

function proofServiceValidator(
  proofService: DojoProofCapsuleService | undefined,
  nowFn: (() => Date) | undefined
): InProcessDojoMcpSkillBusOptions["validateProof"] | undefined {
  if (!proofService) return undefined;
  return async ({ tenant, skill, proof_capsule, requested_action }) => {
    const result = await proofService.validate({
      tenant,
      skill,
      proof_capsule,
      requested_action,
      dry_run: true,
      validation_options: {
        now: (nowFn ?? (() => new Date()))().toISOString(),
      },
    });
    return {
      ok: result.validation.ok,
      status: result.validation.status,
      blocked_by: [...result.validation.blocked_by],
      error_codes: [...result.validation.error_codes],
    };
  };
}

interface InMemoryRateLimitBucket {
  count: number;
  reset_at_ms: number;
}

class InMemoryDojoMcpSkillBusRateLimiter implements DojoMcpSkillBusRateLimiter {
  private readonly rules: DojoMcpSkillBusRateLimitRule[];
  private readonly nowFn: () => Date;
  private readonly buckets = new Map<string, InMemoryRateLimitBucket>();

  constructor(options: { rules: DojoMcpSkillBusRateLimitRule[]; now?: () => Date }) {
    this.rules = options.rules.map((rule) => ({
      ...rule,
      scope: [...rule.scope],
    }));
    this.nowFn = options.now ?? (() => new Date());
  }

  evaluate(input: DojoMcpSkillBusRateLimitInput): DojoMcpSkillBusRateLimitDecision {
    const nowMs = this.nowFn().getTime();
    this.pruneExpiredBuckets(nowMs);
    const increments: Array<{ key: string; bucket: InMemoryRateLimitBucket }> = [];
    let minRemaining: number | undefined;

    for (const rule of this.rules) {
      const ruleValidation = validateRateLimitRule(rule);
      if (ruleValidation.length > 0) {
        return {
          ok: false,
          blocked_by: ruleValidation,
          rule_id: rule.rule_id,
        };
      }
      if (input.dry_run && rule.include_dry_run !== true) {
        continue;
      }

      const scopeKey = rateLimitScopeKey(rule, input);
      const windowStartMs = Math.floor(nowMs / rule.window_ms) * rule.window_ms;
      const resetAtMs = windowStartMs + rule.window_ms;
      const bucketKey = `${rule.rule_id}\u0000${scopeKey}\u0000${windowStartMs}`;
      const bucket = this.buckets.get(bucketKey) ?? { count: 0, reset_at_ms: resetAtMs };
      if (bucket.count >= rule.max_calls) {
        return {
          ok: false,
          blocked_by: ["dojo_mcp_rate_limit_exceeded"],
          rule_id: rule.rule_id,
          scope_key: scopeKey,
          limit: rule.max_calls,
          remaining: 0,
          retry_after_ms: Math.max(0, resetAtMs - nowMs),
        };
      }
      minRemaining = Math.min(minRemaining ?? Number.POSITIVE_INFINITY, rule.max_calls - bucket.count - 1);
      increments.push({ key: bucketKey, bucket });
    }

    for (const item of increments) {
      this.buckets.set(item.key, {
        count: item.bucket.count + 1,
        reset_at_ms: item.bucket.reset_at_ms,
      });
    }

    return {
      ok: true,
      blocked_by: [],
      remaining: Number.isFinite(minRemaining) ? minRemaining : undefined,
    };
  }

  private pruneExpiredBuckets(nowMs: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.reset_at_ms <= nowMs) {
        this.buckets.delete(key);
      }
    }
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
    api_backed_mcp_tools: (skill.api_backed_mcp_tools ?? []).map((tool) => ({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      action: tool.action,
      path: tool.path,
      method: tool.method,
      schema_digest: tool.schema_digest,
    })),
    mcp_skill_manifest: manifest,
  };
}

function isLicensedPublishedSkill(skill: DojoSkill): boolean {
  return Boolean(skill.published_tool_name || skill.private_tool_manifest?.tool_name || (skill.published_tools ?? []).length > 0)
    && skill.entrustment_level !== "EX"
    && skill.permission_license.autonomy_level !== "blocked";
}

function skillPublishesToolName(skill: DojoSkill, toolName: string): boolean {
  return skill.published_tool_name === toolName
    || skill.private_tool_manifest?.tool_name === toolName
    || (skill.published_tools ?? []).includes(toolName)
    || (skill.api_backed_mcp_tools ?? []).some((tool) => tool.tool_name === toolName);
}

function resolvePublishedTool(skill: DojoSkill, toolName: string): DojoResolvedMcpTool | undefined {
  const apiTool = (skill.api_backed_mcp_tools ?? []).find((tool) => tool.tool_name === toolName);
  if (apiTool) {
    return {
      kind: "api_backed",
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
      api_backed_mcp_tool: apiTool,
    };
  }
  if (skill.private_tool_manifest?.tool_name === toolName) {
    return {
      kind: "private_workflow",
      tool_name: skill.private_tool_manifest.tool_name,
      tool_version: skill.skill_version,
    };
  }
  if (skill.published_tool_name === toolName || (skill.published_tools ?? []).includes(toolName)) {
    return {
      kind: "skill",
      tool_name: toolName,
      tool_version: skill.skill_version,
    };
  }
  return undefined;
}

function fallbackResolvedTool(skill: DojoSkill, toolName: string): DojoResolvedMcpTool {
  return resolvePublishedTool(skill, toolName) ?? {
    kind: "skill",
    tool_name: toolName,
    tool_version: skill.skill_version,
  };
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
  validation?: DojoSkillBusProofValidation,
  rateLimit?: DojoMcpSkillBusRateLimitDecision
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
    rate_limit: rateLimit,
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

function summarizeRateLimitDecision(decision: DojoMcpSkillBusRateLimitDecision): DojoMcpSkillBusRateLimitDecision {
  return {
    ok: decision.ok,
    blocked_by: [...decision.blocked_by],
    ...(decision.rule_id ? { rule_id: decision.rule_id } : {}),
    ...(decision.scope_key ? { scope_key: decision.scope_key } : {}),
    ...(typeof decision.limit === "number" ? { limit: decision.limit } : {}),
    ...(typeof decision.remaining === "number" ? { remaining: decision.remaining } : {}),
    ...(typeof decision.retry_after_ms === "number" ? { retry_after_ms: decision.retry_after_ms } : {}),
  };
}

function summarizeProofValidation(validation: DojoSkillBusProofValidation): Record<string, unknown> {
  return {
    ok: validation.ok,
    status: validation.status,
    blocked_by: [...validation.blocked_by],
    error_codes: validation.error_codes ? [...validation.error_codes] : undefined,
  };
}

function summarizeProofConsumeResult(result: DojoProofConsumeResult): Record<string, unknown> {
  return {
    ok: result.ok,
    status: result.status,
    blocked_by: [...result.blocked_by],
    capsule_id: result.record?.capsule_id,
    first_used_at: result.record?.first_used_at,
  };
}

function validateRateLimitRule(rule: DojoMcpSkillBusRateLimitRule): string[] {
  const blockedBy: string[] = [];
  if (!rule.rule_id.trim()) blockedBy.push("dojo_mcp_rate_limit_rule_id_required");
  if (!Array.isArray(rule.scope) || rule.scope.length === 0) blockedBy.push("dojo_mcp_rate_limit_scope_required");
  if (!Number.isInteger(rule.max_calls) || rule.max_calls < 1) blockedBy.push("dojo_mcp_rate_limit_max_calls_invalid");
  if (!Number.isInteger(rule.window_ms) || rule.window_ms < 1) blockedBy.push("dojo_mcp_rate_limit_window_invalid");
  const validScopes: DojoMcpSkillBusRateLimitScope[] = ["tenant", "workspace", "skill", "actor", "action", "tool"];
  for (const scope of rule.scope) {
    if (!validScopes.includes(scope)) blockedBy.push("dojo_mcp_rate_limit_scope_invalid");
  }
  return [...new Set(blockedBy)];
}

function rateLimitScopeKey(rule: DojoMcpSkillBusRateLimitRule, input: DojoMcpSkillBusRateLimitInput): string {
  return rule.scope.map((scope) => `${scope}:${rateLimitScopeValue(scope, input)}`).join("|");
}

function rateLimitScopeValue(scope: DojoMcpSkillBusRateLimitScope, input: DojoMcpSkillBusRateLimitInput): string {
  switch (scope) {
    case "tenant":
      return input.tenant.tenant_id;
    case "workspace":
      return input.tenant.workspace_id;
    case "skill":
      return input.skill.skill_id;
    case "actor":
      return input.tenant.actor_id;
    case "action":
      return input.requested_action;
    case "tool":
      return input.tool_name;
  }
}
