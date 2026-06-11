import { browserBroker } from "../browser/broker.js";
import {
  buildDojoSkill,
  dojoSkillRegistry,
  exportDojoRepoArtifacts,
  extractDojoSkillSeed,
  generateDojoVivariumScenarios,
  issueDojoProofCapsule,
  runDojoCheckride,
  validateDojoProofCapsule,
  type DojoProofCarryingSkillCapsule,
  type DojoEvidenceClaim,
  type DojoExecutionSubstrate,
  type DojoSkill,
} from "../browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../browser/private_tool_manifest.js";
import { privateWorkflowToolDefinition, privateWorkflowToolRegistry } from "../browser/private_tool_registry.js";
import type { BrowserWorkflowArtifact } from "../browser/broker.js";
import { ADVERTISED_TOOLS } from "../tool_registry.js";
import { dispatchBrowserTool } from "./browser.js";
import { dispatchSafetyTool } from "./safety.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const DOJO_TOOL_NAMES = [
  "synthi_dojo_list_competencies",
  "synthi_dojo_get_skill",
  "synthi_dojo_get_skill_assurance_case",
  "synthi_dojo_get_entrustment_level",
  "synthi_dojo_get_license",
  "synthi_dojo_get_guardrails",
  "synthi_dojo_get_case_law",
  "synthi_dojo_explain_block",
  "synthi_dojo_request_permission_upgrade",
  "synthi_dojo_generate_vivarium_scenarios",
  "synthi_dojo_run_checkride",
  "synthi_dojo_publish_skill",
  "synthi_dojo_recertify_skill",
  "synthi_dojo_export_artifacts",
  "synthi_dojo_issue_proof_capsule",
  "synthi_dojo_run_with_proof_capsule",
] as const;

export const DOJO_TOOLS = [
  {
    name: "synthi_dojo_list_competencies",
    description:
      "List licensed Agent Dojo competencies published from taught workflows. Returns skill cards, entrustment levels, readiness, proof requirements, and backing MCP tool names without exposing raw scripts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_dojo_get_skill",
    description: "Return a published Dojo skill, including seed, scenarios, checkride, license, guardrails, assurance case, and proof schema.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_skill_assurance_case",
    description: "Return the human-readable and machine-readable assurance case for a licensed Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_entrustment_level",
    description: "Return the scoped entrustment and readiness level for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_license",
    description: "Return the runtime permission license for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_guardrails",
    description: "Return active guardrails for a Dojo skill, including case-law provenance when available.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_case_law",
    description: "Return failure-derived case law for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_explain_block",
    description: "Explain why a requested Dojo skill action is blocked, using license checks, proof validation, guardrails, and case law.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        requested_action: { type: "string", default: "run_workflow" },
        proof_capsule: { type: "object" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_request_permission_upgrade",
    description:
      "Return the smallest recertification, evidence, approval, or substrate steps needed before a Dojo skill can expand its licensed scope.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        requested_action: { type: "string", default: "run_workflow" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_generate_vivarium_scenarios",
    description:
      "Extract a Skill Seed from the current or saved workflow contract and generate a task-specific synthetic Workspace Organoid scenario set.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_checkride",
    description:
      "Run the Dojo static checkride for the current or saved workflow: knowledge, risk, and skill scenario evaluation with entrustment recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_publish_skill",
    description:
      "Publish a licensed Dojo competency from a taught workflow. If the private browser workflow manifest is publishable, the backing synthi_app_* tool is registered only after the Dojo license exists.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_recertify_skill",
    description: "Re-run Dojo seed extraction, scenario generation, checkride, license, and assurance case for an existing skill or workflow.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        workspace_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_export_artifacts",
    description:
      "Return reviewable repo artifact files for a licensed Dojo skill, including seed, graph, vivarium, checkride report, assurance case, license, proof schema, guardrails, case law, and MCP manifest. Artifacts contain metadata and references, not secrets.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_issue_proof_capsule",
    description:
      "Issue a proof-carrying skill capsule for a licensed Dojo skill and requested action. The capsule must be supplied to synthi_dojo_run_with_proof_capsule before execution.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        requested_action: { type: "string", default: "run_workflow" },
        context_claims: { type: "object" },
        evidence_claims: { type: "array", items: { type: "object" } },
        substrate_claim: { type: "string", enum: ["vision", "dom", "source", "api", "mcp"] },
        expires_at: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_with_proof_capsule",
    description:
      "Validate a proof-carrying skill capsule against the skill license before dispatching the backing private workflow MCP tool. Use dry_run=true to validate without execution.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        requested_action: { type: "string", default: "run_workflow" },
        proof_capsule: { type: "object" },
        tool_args: { type: "object" },
        dry_run: { type: "boolean" },
      },
      required: ["proof_capsule"],
    },
  },
] as const;

export async function dispatchDojoTool(toolName: string, args: unknown): Promise<ToolResponse | null> {
  if (!DOJO_TOOL_NAMES.includes(toolName as (typeof DOJO_TOOL_NAMES)[number])) return null;
  try {
    switch (toolName) {
      case "synthi_dojo_list_competencies":
        return dojoListCompetenciesTool();
      case "synthi_dojo_get_skill":
        return dojoGetSkillTool(args);
      case "synthi_dojo_get_skill_assurance_case":
        return dojoGetAssuranceCaseTool(args);
      case "synthi_dojo_get_entrustment_level":
        return dojoGetEntrustmentLevelTool(args);
      case "synthi_dojo_get_license":
        return dojoGetLicenseTool(args);
      case "synthi_dojo_get_guardrails":
        return dojoGetGuardrailsTool(args);
      case "synthi_dojo_get_case_law":
        return dojoGetCaseLawTool(args);
      case "synthi_dojo_explain_block":
        return dojoExplainBlockTool(args);
      case "synthi_dojo_request_permission_upgrade":
        return dojoPermissionUpgradeTool(args);
      case "synthi_dojo_generate_vivarium_scenarios":
        return dojoGenerateVivariumScenariosTool(args);
      case "synthi_dojo_run_checkride":
        return dojoRunCheckrideTool(args);
      case "synthi_dojo_publish_skill":
        return dojoPublishSkillTool(args);
      case "synthi_dojo_recertify_skill":
        return dojoRecertifySkillTool(args);
      case "synthi_dojo_export_artifacts":
        return dojoExportArtifactsTool(args);
      case "synthi_dojo_issue_proof_capsule":
        return dojoIssueProofCapsuleTool(args);
      case "synthi_dojo_run_with_proof_capsule":
        return await dojoRunWithProofCapsuleTool(args);
      default:
        return null;
    }
  } catch (err) {
    return errorFromException("dojo_tool_failed", err);
  }
}

function dojoListCompetenciesTool(): ToolResponse {
  const skills = dojoSkillRegistry.list();
  return jsonResponse({
    ok: true,
    count: skills.length,
    competencies: skills.map(skillListItem),
    product_path: "agent_to_mcp_skill_bus_to_proof_validator_to_license_kernel_to_dojo_runtime",
  });
}

function dojoGetSkillTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill: skill.skill });
}

function dojoGetAssuranceCaseTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, assurance_case: skill.skill.assurance_case });
}

function dojoGetEntrustmentLevelTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    entrustment_level: skill.skill.entrustment_level,
    skill_readiness_level: skill.skill.skill_readiness_level,
    proof_required: skill.skill.skill_passport.proof_required,
    license_id: skill.skill.permission_license.license_id,
  });
}

function dojoGetLicenseTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, license: skill.skill.permission_license });
}

function dojoGetGuardrailsTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, guardrails: skill.skill.guardrails });
}

function dojoGetCaseLawTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, case_law: skill.skill.case_law });
}

function dojoExplainBlockTool(args: unknown): ToolResponse {
  const a = obj(args);
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const capsule = proofCapsuleOpt(a["proof_capsule"]);
  const validation = capsule
    ? validateDojoProofCapsule(skill.skill, capsule, requestedAction)
    : {
        ok: false,
        status: "blocked" as const,
        error: "dojo_proof_capsule_required",
        blocked_by: ["proof_capsule_missing"],
        license: {
          skill_id: skill.skill.skill_id,
          license_version: skill.skill.permission_license.license_version,
          entrustment_level: skill.skill.entrustment_level,
        },
      };
  return jsonResponse({
    ok: validation.ok,
    requested_action: requestedAction,
    validation,
    refusal: validation.ok ? null : refusalFor(skill.skill, validation.blocked_by),
    relevant_case_law: skill.skill.case_law.slice(0, 3),
  });
}

function dojoPermissionUpgradeTool(args: unknown): ToolResponse {
  const a = obj(args);
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const license = skill.skill.permission_license;
  const required: string[] = [];
  if (!license.allowed_actions.some((action) => action.action === requestedAction)) {
    required.push("rerun_checkride_for_requested_action");
  }
  if (skill.skill.checkride.critical_failures > 0) {
    required.push("resolve_critical_checkride_failures");
  }
  if (skill.skill.guardrails.length === 0) {
    required.push("activate_guardrails");
  }
  if (!skill.skill.published_tool_name) {
    required.push("publish_backing_private_workflow_tool");
  }
  if (skill.skill.execution_substrates.length === 1 && skill.skill.execution_substrates[0] === "vision") {
    required.push("add_dom_source_or_mcp_substrate");
  }
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    current_entrustment_level: skill.skill.entrustment_level,
    required_steps: required.length > 0 ? required : ["no_upgrade_required_for_current_license"],
  });
}

function dojoGenerateVivariumScenariosTool(args: unknown): ToolResponse {
  const artifact = requiredWorkflowArtifact(args);
  if (!artifact.ok) return artifact.error;
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const seed = extractDojoSkillSeed(artifact.artifact.workflow.contract, { workspace_id: workspaceId });
  const scenarios = generateDojoVivariumScenarios(seed);
  return jsonResponse({
    ok: true,
    workflow_id: artifact.artifact.workflow_id,
    skill_seed: seed,
    organoid: {
      schema_version: "synthi.dojo.workspaceOrganoid.v1",
      organoid_id: `organoid_${seed.seed_id}`,
      skill_seed_id: seed.seed_id,
      workspace_id: seed.workspace_id,
      generated_at: seed.generated_at,
      version: "0.1.0",
      tissues: {
        ui: { surfaces: seed.touched_surfaces },
        data: { models: seed.touched_data_models, inputs: seed.input_schema },
        policy: { clues: seed.policy_clues },
        identity: { auth_required: artifact.artifact.workflow.contract.authPlan.required },
        document: { synthetic_only: true },
        api: { anchors: seed.source_or_api_anchors.filter((anchor) => anchor.kind === "api") },
        failure: { modes: seed.candidate_failure_modes },
        adversary: { scenarios: scenarios.filter((scenario) => scenario.layer === "risk").map((scenario) => scenario.scenario_id) },
        evidence: { expected: seed.output_schema.evidence },
        source: { anchors: seed.source_or_api_anchors },
        license: { proof_required: true },
      },
      scenarios,
      safety_constraints: ["synthetic_data_only", "no_secrets_in_repo_artifacts", "no_production_mutation"],
      data_policy: { production_data_allowed: false, redact_screenshots_by_default: true },
    },
  });
}

function dojoRunCheckrideTool(args: unknown): ToolResponse {
  const artifact = requiredWorkflowArtifact(args);
  if (!artifact.ok) return artifact.error;
  const contract = artifact.artifact.workflow.contract;
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const seed = extractDojoSkillSeed(contract, { workspace_id: workspaceId });
  const scenarios = generateDojoVivariumScenarios(seed);
  const checkride = runDojoCheckride(seed, scenarios, contract);
  const previewSkill = buildDojoSkill(contract, {
    workspace_id: workspaceId,
    private_tool_manifest: generatePrivateWorkflowToolManifest(contract),
  });
  return jsonResponse({
    ok: true,
    workflow_id: artifact.artifact.workflow_id,
    skill_seed: seed,
    scenarios,
    checkride,
    case_law: previewSkill.case_law,
    guardrails: previewSkill.guardrails,
    license_preview: previewSkill.permission_license,
    skill_card: previewSkill.skill_card,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(previewSkill)),
  });
}

function dojoPublishSkillTool(args: unknown): ToolResponse {
  const artifact = requiredWorkflowArtifact(args);
  if (!artifact.ok) return artifact.error;
  const workspaceId = stringOpt(obj(args)["workspace_id"]);
  const contract = artifact.artifact.workflow.contract;
  const manifest = generatePrivateWorkflowToolManifest(contract);
  const publishedTool = publishBackingPrivateTool(manifest, artifact.artifact);
  const skill = dojoSkillRegistry.publish(buildDojoSkill(contract, {
    workspace_id: workspaceId,
    private_tool_manifest: manifest,
    ...(publishedTool.ok ? { published_tool_name: publishedTool.tool_name } : {}),
  }));
  return jsonResponse({
    ok: true,
    tool_name: publishedTool.tool_name,
    published_tool_name: publishedTool.ok ? publishedTool.tool_name : null,
    skill: skillListItem(skill),
    skill_card: skill.skill_card,
    skill_passport: skill.skill_passport,
    license: skill.permission_license,
    assurance_case: skill.assurance_case,
    private_tool: publishedTool,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(skill)),
  });
}

function dojoRecertifySkillTool(args: unknown): ToolResponse {
  const existing = skillByArgs(args);
  const workflowId = existing?.workflow_id ?? stringOpt(obj(args)["workflow_id"]);
  const artifact = requiredWorkflowArtifact({ workflow_id: workflowId });
  if (!artifact.ok) return artifact.error;
  const workspaceId = stringOpt(obj(args)["workspace_id"]) ?? existing?.workspace_id;
  const manifest = generatePrivateWorkflowToolManifest(artifact.artifact.workflow.contract);
  const publishedToolName = existing?.published_tool_name;
  const recertified = dojoSkillRegistry.publish(buildDojoSkill(artifact.artifact.workflow.contract, {
    workspace_id: workspaceId,
    private_tool_manifest: manifest,
    ...(publishedToolName ? { published_tool_name: publishedToolName } : {}),
  }));
  return jsonResponse({
    ok: true,
    skill: skillListItem(recertified),
    checkride: recertified.checkride,
    license: recertified.permission_license,
    assurance_case: recertified.assurance_case,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(recertified)),
  });
}

function dojoExportArtifactsTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const artifacts = exportDojoRepoArtifacts(skill.skill);
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    artifact_count: artifacts.length,
    artifacts,
  });
}

function dojoIssueProofCapsuleTool(args: unknown): ToolResponse {
  const a = obj(args);
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const capsule = issueDojoProofCapsule(skill.skill, requestedAction, {
    context_claims: objectOpt(a["context_claims"]) ?? { workspace_verified: true },
    evidence_claims: evidenceClaimsOpt(a["evidence_claims"]),
    substrate_claim: substrateOpt(a["substrate_claim"]),
    expires_at: stringOpt(a["expires_at"]),
  });
  const validation = validateDojoProofCapsule(skill.skill, capsule, requestedAction);
  return jsonResponse({
    ok: validation.ok,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    proof_capsule: capsule,
    validation,
  });
}

async function dojoRunWithProofCapsuleTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const capsule = proofCapsuleOpt(a["proof_capsule"]);
  if (!capsule) {
    return errorResponse("dojo_proof_capsule_required", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      proof_capsule_schema: skill.skill.proof_capsule_schema,
    });
  }
  const validation = validateDojoProofCapsule(skill.skill, capsule, requestedAction);
  if (!validation.ok) {
    return errorResponse(validation.error ?? "dojo_proof_capsule_invalid", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      validation,
      refusal: refusalFor(skill.skill, validation.blocked_by),
    });
  }
  if (boolOpt(a["dry_run"])) {
    return jsonResponse({
      ok: true,
      dry_run: true,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      validation,
    });
  }

  const toolArgs = objectOpt(a["tool_args"]) ?? {};
  const run = requestedAction === "run_prefix_validation"
    ? await dispatchSafetyTool("synthi_safety_run_prefix_validation", toolArgs)
    : await dispatchBackingSkillTool(skill.skill, toolArgs);
  if (!run) {
    return errorResponse("dojo_backing_tool_unavailable", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      published_tool_name: skill.skill.published_tool_name ?? null,
    });
  }
  return jsonResponse({
    ok: run.isError !== true,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    validation,
    proof_capsule_id: capsule.capsule_id,
    backing_tool: requestedAction === "run_prefix_validation" ? "synthi_safety_run_prefix_validation" : skill.skill.published_tool_name,
    result: run.structuredContent ?? {},
  });
}

async function dispatchBackingSkillTool(skill: DojoSkill, args: Record<string, unknown>): Promise<ToolResponse | null> {
  if (!skill.published_tool_name) return null;
  return await dispatchBrowserTool(skill.published_tool_name, args);
}

function publishBackingPrivateTool(
  manifest: ReturnType<typeof generatePrivateWorkflowToolManifest>,
  artifact: BrowserWorkflowArtifact
): { ok: true; tool_name: string; tool: ReturnType<typeof privateWorkflowToolDefinition>; registered_at: number } | { ok: false; error: string; tool_name: string; manifest_status: string } {
  if (manifest.status === "blocked") {
    return {
      ok: false,
      error: "private_tool_manifest_blocked",
      tool_name: manifest.tool_name,
      manifest_status: manifest.status,
    };
  }
  const published = privateWorkflowToolRegistry.publish(manifest, {
    reservedToolNames: ADVERTISED_TOOLS,
    workflowArtifact: artifact,
  });
  if (!published.ok) {
    return {
      ok: false,
      error: published.error,
      tool_name: published.tool_name,
      manifest_status: manifest.status,
    };
  }
  return {
    ok: true,
    tool_name: published.registration.tool_name,
    tool: privateWorkflowToolDefinition(published.registration),
    registered_at: published.registration.registered_at,
  };
}

function requiredWorkflowArtifact(args: unknown): { ok: true; artifact: BrowserWorkflowArtifact } | { ok: false; error: ToolResponse } {
  const workflowId = stringOpt(obj(args)["workflow_id"]);
  const artifact = browserBroker.workflowArtifact(workflowId);
  if (!artifact.ok) {
    return {
      ok: false,
      error: errorResponse(artifact.error, artifact.workflow_id ? { workflow_id: artifact.workflow_id } : undefined),
    };
  }
  if (artifact.artifact.workflow.contract.steps.length === 0) {
    return {
      ok: false,
      error: errorResponse("dojo_workflow_trace_required", { workflow_id: artifact.artifact.workflow_id }),
    };
  }
  return { ok: true, artifact: artifact.artifact };
}

function requiredSkill(args: unknown): { ok: true; skill: DojoSkill } | { ok: false; error: ToolResponse } {
  const skill = skillByArgs(args);
  if (!skill) {
    return {
      ok: false,
      error: errorResponse("dojo_skill_not_found", {
        skill_id: stringOpt(obj(args)["skill_id"]) ?? null,
        workflow_id: stringOpt(obj(args)["workflow_id"]) ?? null,
        required_tool: "synthi_dojo_publish_skill",
      }),
    };
  }
  return { ok: true, skill };
}

function skillByArgs(args: unknown): DojoSkill | null {
  const a = obj(args);
  const skillId = stringOpt(a["skill_id"]);
  if (skillId) return dojoSkillRegistry.get(skillId);
  const workflowId = stringOpt(a["workflow_id"]);
  if (workflowId) return dojoSkillRegistry.getByWorkflowId(workflowId);
  const current = browserBroker.compiledWorkflow();
  return dojoSkillRegistry.getByWorkflowId(current.contract.workflowId);
}

function skillListItem(skill: DojoSkill): Record<string, unknown> {
  return {
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    name: skill.name,
    intent: skill.intent,
    app_origin: skill.app_origin,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    proof_required: skill.skill_passport.proof_required,
    preferred_substrate: skill.preferred_substrate,
    execution_substrates: skill.execution_substrates,
    published_tool_name: skill.published_tool_name ?? null,
    checkride: {
      checkride_id: skill.checkride.checkride_id,
      coverage_score: skill.checkride.coverage_score,
      critical_failures: skill.checkride.critical_failures,
      blocked_scenarios: skill.checkride.blocked_scenarios,
    },
    license: {
      license_id: skill.permission_license.license_id,
      license_version: skill.permission_license.license_version,
      allowed_actions: skill.permission_license.allowed_actions.map((action) => action.action),
      gated_actions: skill.permission_license.gated_actions.map((action) => action.action),
      blocked_actions: skill.permission_license.blocked_actions.map((action) => action.action),
    },
    skill_card: skill.skill_card,
  };
}

function artifactSummary(artifacts: ReturnType<typeof exportDojoRepoArtifacts>): Array<{ path: string; content_type: string; sensitive: false }> {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    content_type: artifact.content_type,
    sensitive: artifact.sensitive,
  }));
}

function refusalFor(skill: DojoSkill, blockedBy: string[]): string {
  const cited = skill.case_law.find((item) => item.status === "binding");
  if (cited) {
    return `I will not run ${skill.name} yet. ${cited.finding} Rule: ${cited.rule_created}`;
  }
  return `I will not run ${skill.name} yet. Blocked by ${blockedBy.join(", ") || "license policy"}.`;
}

function proofCapsuleOpt(value: unknown): DojoProofCarryingSkillCapsule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<DojoProofCarryingSkillCapsule>;
  if (record.schema_version !== "synthi.dojo.proofCapsule.v1") return null;
  if (typeof record.skill_id !== "string" || typeof record.requested_action !== "string") return null;
  if (typeof record.signature !== "string") return null;
  return value as DojoProofCarryingSkillCapsule;
}

function evidenceClaimsOpt(value: unknown): DojoEvidenceClaim[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims = value.filter((item): item is { claim: string; satisfied: boolean; evidence_refs?: string[] } => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record["claim"] === "string" && typeof record["satisfied"] === "boolean";
  });
  return claims.length > 0 ? claims : undefined;
}

function substrateOpt(value: unknown): DojoExecutionSubstrate | undefined {
  return value === "vision" || value === "dom" || value === "source" || value === "api" || value === "mcp" ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectOpt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boolOpt(value: unknown): boolean {
  return value === true;
}
