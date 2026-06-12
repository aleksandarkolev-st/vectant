import { createHash } from "node:crypto";
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
import {
  buildDojoGovernanceReport,
  buildDojoLifecycleReport,
  buildDojoOrganizationRegistry,
  buildDojoSourceAffordancePrPlan,
  buildDojoUniverseDossier,
  buildDojoUniverseMetrics,
  runDojoTimeMachineDebugger,
} from "../browser/dojo_universe.js";
import { generatePrivateWorkflowToolManifest } from "../browser/private_tool_manifest.js";
import { privateWorkflowToolDefinition, privateWorkflowToolRegistry } from "../browser/private_tool_registry.js";
import { evaluateDojoLicenseKernel, markDojoProofExecution } from "../browser/dojo_license_kernel.js";
import { runDojoVivariumScenario, runDojoWindTunnel } from "../browser/dojo_vivarium.js";
import { explainDojoRuntimeRefusal } from "../dojo/case_law/refusal.js";
import type { DojoCaseLawRecord } from "../dojo/case_law/registry.js";
import { runDojoExecutableCheckride } from "../dojo/checkride/runner.js";
import {
  buildDojoGovernanceServiceView,
  decideDojoCaseLawReview,
  decideDojoPermissionUpgradeRequest,
  revokeDojoSkillLicense,
} from "../dojo/governance/service.js";
import { compileDojoSkillGraphForSkill } from "../dojo/graph/compiler.js";
import {
  contextKeyForDojoGuardrailPredicate,
  normalizeDojoGuardrailPredicate,
} from "../dojo/graph/guardrail_predicates.js";
import { buildDojoImplementationMetadata } from "../dojo/status/implementation_status.js";
import { toDojoScenarioDefinitions, validateDojoScenarioDefinition } from "../dojo/vivarium/scenario_dsl.js";
import type { DojoPermissionUpgradeRequestRecord } from "../dojo/store/interfaces.js";
import { buildDojoMcpSkillManifest } from "../dojo/mcp/manifest_signing.js";
import {
  createInProcessDojoMcpSkillBus,
  createLegacyDojoTenantContext,
} from "../dojo/mcp/skill_bus.js";
import type { DojoTenantContext } from "../dojo/mcp/execution_policy_gate.js";
import type { BrowserWorkflowArtifact } from "../browser/broker.js";
import { ADVERTISED_TOOLS } from "../tool_registry.js";
import { dispatchBrowserPrivateWorkflowToolAfterDojoProof } from "./browser.js";
import { dispatchSafetyTool } from "./safety.js";
import { errorFromException, errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

export const DOJO_TOOL_NAMES = [
  "synthi_dojo_list_competencies",
  "synthi_dojo_get_skill",
  "synthi_dojo_get_skill_cortex",
  "synthi_dojo_get_workspace_organoid",
  "synthi_dojo_get_wind_tunnel_report",
  "synthi_dojo_get_counterfactual_twin",
  "synthi_dojo_get_evil_twin_report",
  "synthi_dojo_get_training_report",
  "synthi_dojo_get_skill_passport",
  "synthi_dojo_get_skill_genome",
  "synthi_dojo_get_antibodies",
  "synthi_dojo_get_agent_ready_ui_contract",
  "synthi_dojo_get_cost_policy",
  "synthi_dojo_get_universe_dossier",
  "synthi_dojo_get_lifecycle",
  "synthi_dojo_get_governance_report",
  "synthi_dojo_get_metrics",
  "synthi_dojo_get_source_affordance_pr_plan",
  "synthi_dojo_get_registry",
  "synthi_dojo_get_skill_assurance_case",
  "synthi_dojo_get_entrustment_level",
  "synthi_dojo_get_license",
  "synthi_dojo_get_guardrails",
  "synthi_dojo_get_case_law",
  "synthi_dojo_explain_block",
  "synthi_dojo_explain_failure",
  "synthi_dojo_debug_counterfactual",
  "synthi_dojo_run_time_machine_debugger",
  "synthi_dojo_run_ghost_mode",
  "synthi_dojo_request_permission_upgrade",
  "synthi_dojo_review_permission_upgrade",
  "synthi_dojo_review_case_law",
  "synthi_dojo_generate_vivarium_scenarios",
  "synthi_dojo_run_vivarium_scenario",
  "synthi_dojo_run_wind_tunnel",
  "synthi_dojo_run_checkride",
  "synthi_dojo_publish_skill",
  "synthi_dojo_recertify_skill",
  "synthi_dojo_get_license_health",
  "synthi_dojo_revoke_license",
  "synthi_dojo_record_case_law",
  "synthi_dojo_export_artifacts",
  "synthi_dojo_export_compliance_pack",
  "synthi_dojo_issue_proof_capsule",
  "synthi_dojo_validate_proof_capsule",
  "synthi_dojo_revoke_proof_capsule",
  "synthi_dojo_run_with_proof_capsule",
] as const;

export const DOJO_TOOLS = [
  {
    name: "synthi_dojo_list_competencies",
    description:
      "List licensed Agent Dojo competencies published from taught workflows. Returns skill cards, entrustment levels, readiness, proof requirements, and backing MCP tool names without exposing raw scripts.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        organization_id: { type: "string" },
        workspace_id: { type: "string" },
        actor_id: { type: "string" },
        actor_type: { type: "string", enum: ["human", "agent", "service"] },
        roles: { type: "array", items: { type: "string" } },
        request_id: { type: "string" },
        correlation_id: { type: "string" },
      },
      required: ["actor_id", "actor_type"],
    },
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
    name: "synthi_dojo_get_skill_cortex",
    description: "Return the source-aware Skill Cortex graph: typed workflow nodes, learned transitions, guardrail refs, node memory, and expiry nodes.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_workspace_organoid",
    description: "Return the synthetic Workspace Organoid manifest used by Dojo to practice this skill without production data.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_wind_tunnel_report",
    description: "Return the Workflow Wind Tunnel runs and scenario summary for a Dojo skill.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_counterfactual_twin",
    description: "Return counterfactual twin variants, observed outcomes, and promoted scenarios for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string" }, workflow_id: { type: "string" }, scenario_id: { type: "string" }, mutation_kind: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_evil_twin_report",
    description: "Return adversarial Evil Twin attacks, caught/escaped status, hardened guardrails, and attack success rate.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_training_report",
    description: "Return the Dojo training report that ties wind-tunnel runs, checkride, evil twin, guardrails, antibodies, and readiness decision together.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_skill_passport",
    description: "Return the compact Skill Passport for UI badges and agent preflight checks.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_skill_genome",
    description: "Return the shareable Skill Genome pattern without raw screenshots, secrets, workspace data, or production payloads.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_antibodies",
    description: "Return negative-memory antibodies derived from failed or blocked scenarios and their guardrail responses.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_agent_ready_ui_contract",
    description: "Return the agent-ready UI contract: stable locators, source anchors, required inputs, proof claims, and refusal contracts.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_cost_policy",
    description: "Return the Dojo cost-control policy for scenario budgets, tier use, stop conditions, and recertification triggers.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_universe_dossier",
    description:
      "Return the full Vivarium Cortex dossier for a skill: lifecycle, governance, metrics, evidence ledger, source-affordance PR plan, package readiness, and time-machine debug summary.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        question: { type: "string" },
        mutation_kind: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_lifecycle",
    description: "Return revocable entrustment lifecycle state, expiry, recertification triggers, and release gates for a Dojo skill.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_governance_report",
    description: "Return approval queue, policy gates, audit report, compliance exports, and review workflows for a Dojo skill.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_metrics",
    description: "Return technical, business, and trust metrics across the Dojo skill registry or a single selected skill.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_source_affordance_pr_plan",
    description: "Return a reviewable generated PR plan for adding stable Agent-Ready UI affordances and proof hooks to source files.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_get_registry",
    description: "Return the organization-level Dojo skill registry, case-law registry, antibody registry, and aggregate metrics.",
    inputSchema: { type: "object", properties: {}, required: [] },
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
    name: "synthi_dojo_explain_failure",
    description: "Explain a checkride, wind-tunnel, counterfactual, or evil-twin failure with scenario result, case law, guardrails, and next licensing steps.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        scenario_id: { type: "string" },
        case_id: { type: "string" },
        guardrail_id: { type: "string" },
        mutation_kind: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_debug_counterfactual",
    description: "Debug a counterfactual twin variant and return the matching scenario, checkride result, relevant attacks, guardrails, and promoted remediation.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        scenario_id: { type: "string" },
        mutation_kind: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_time_machine_debugger",
    description:
      "Run causal time-machine debugging for a skill by selecting a failed or requested counterfactual branch and explaining the license impact and replay plan.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        scenario_id: { type: "string" },
        mutation_kind: { type: "string" },
        question: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_ghost_mode",
    description: "Run non-mutating ghost-mode analysis by comparing an observed human action with the agent's planned action under the skill license.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        observed_human_action: { type: "object" },
        agent_planned_action: { type: "object" },
        now: { type: "string" },
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
        actor_id: { type: "string" },
        actor_type: { type: "string", enum: ["human", "agent", "service"] },
        request_id: { type: "string" },
        correlation_id: { type: "string" },
        now: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_review_permission_upgrade",
    description:
      "Approve or deny a stored Dojo permission-upgrade request with reviewer metadata and evidence references. This records governance review state; it does not promote the production license by itself.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "denied"] },
        reviewer_actor_id: { type: "string" },
        reviewer_actor_type: { type: "string", enum: ["human", "agent", "service"] },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        decided_at: { type: "string" },
      },
      required: ["request_id", "decision", "reviewer_actor_id", "reviewer_actor_type"],
    },
  },
  {
    name: "synthi_dojo_review_case_law",
    description:
      "Approve or deprecate a stored Dojo case-law record with reviewer metadata and evidence references. Approved case law can bind runtime guardrail predicates; deprecated case law is removed from binding lookup.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "deprecated"] },
        reviewer_actor_id: { type: "string" },
        reviewer_actor_type: { type: "string", enum: ["human", "agent", "service"] },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        superseded_by: { type: "string" },
        decided_at: { type: "string" },
      },
      required: ["case_id", "decision", "reviewer_actor_id", "reviewer_actor_type"],
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
    name: "synthi_dojo_run_vivarium_scenario",
    description: "Materialize and run one synthetic Workspace Organoid scenario for a licensed Dojo skill, returning evidence refs, guardrails, and license checks.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        scenario_id: { type: "string" },
        mutation_kind: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_wind_tunnel",
    description: "Run the Workflow Wind Tunnel over the skill's synthetic scenario set with an optional scenario budget.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        max_scenarios: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_checkride",
    description:
      "Run the Dojo checkride for the current or saved workflow, including compatibility scoring plus executable graph/Vivarium/oracle evidence.",
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
        reason: { type: "string" },
        actor_id: { type: "string" },
        actor_type: { type: "string", enum: ["human", "agent", "service"] },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_license_health",
    description: "Return combined license lifecycle, governance, proof-record, expiry, and recertification health for a Dojo skill.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" }, workflow_id: { type: "string" } }, required: [] },
  },
  {
    name: "synthi_dojo_revoke_license",
    description: "Revoke a Dojo skill license and republish the skill as EX/blocked without deleting its evidence, case law, or repo artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        reason: { type: "string" },
        actor_id: { type: "string" },
        actor_type: { type: "string", enum: ["human", "agent", "service"] },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: ["reason", "actor_id", "actor_type"],
    },
  },
  {
    name: "synthi_dojo_record_case_law",
    description: "Record a new failure-derived case-law item and binding guardrail for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        title: { type: "string" },
        finding: { type: "string" },
        impact: { type: "string" },
        rule: { type: "string" },
        applies_to: { type: "array", items: { type: "string" } },
      },
      required: ["finding", "rule"],
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
    name: "synthi_dojo_export_compliance_pack",
    description:
      "Export a reviewable Dojo compliance evidence pack assembled from existing assurance, license, proof, case-law, governance, evidence, and MCP artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        now: { type: "string" },
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
    name: "synthi_dojo_validate_proof_capsule",
    description:
      "Validate a proof-carrying skill capsule through the license kernel without executing the backing skill. Checks signature, issuer, registry issuance, expiry, revocation, workspace, action, substrate, evidence, and guardrails.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        requested_action: { type: "string", default: "run_workflow" },
        proof_capsule: { type: "object" },
        tool_args: { type: "object" },
      },
      required: ["proof_capsule"],
    },
  },
  {
    name: "synthi_dojo_revoke_proof_capsule",
    description: "Revoke an issued proof capsule so it can no longer be used for production execution.",
    inputSchema: {
      type: "object",
      properties: {
        capsule_id: { type: "string" },
        reason: { type: "string" },
        actor_id: { type: "string" },
        actor_type: { type: "string", enum: ["human", "agent", "service"] },
        now: { type: "string" },
      },
      required: ["capsule_id", "reason", "actor_id", "actor_type"],
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
    let response: ToolResponse | null;
    switch (toolName) {
      case "synthi_dojo_list_competencies":
        response = await dojoListCompetenciesTool(args);
        break;
      case "synthi_dojo_get_skill":
        response = dojoGetSkillTool(args);
        break;
      case "synthi_dojo_get_skill_cortex":
        response = dojoGetSkillCortexTool(args);
        break;
      case "synthi_dojo_get_workspace_organoid":
        response = dojoGetWorkspaceOrganoidTool(args);
        break;
      case "synthi_dojo_get_wind_tunnel_report":
        response = dojoGetWindTunnelReportTool(args);
        break;
      case "synthi_dojo_get_counterfactual_twin":
        response = dojoGetCounterfactualTwinTool(args);
        break;
      case "synthi_dojo_get_evil_twin_report":
        response = dojoGetEvilTwinReportTool(args);
        break;
      case "synthi_dojo_get_training_report":
        response = dojoGetTrainingReportTool(args);
        break;
      case "synthi_dojo_get_skill_passport":
        response = dojoGetSkillPassportTool(args);
        break;
      case "synthi_dojo_get_skill_genome":
        response = dojoGetSkillGenomeTool(args);
        break;
      case "synthi_dojo_get_antibodies":
        response = dojoGetAntibodiesTool(args);
        break;
      case "synthi_dojo_get_agent_ready_ui_contract":
        response = dojoGetAgentReadyUiContractTool(args);
        break;
      case "synthi_dojo_get_cost_policy":
        response = dojoGetCostPolicyTool(args);
        break;
      case "synthi_dojo_get_universe_dossier":
        response = dojoGetUniverseDossierTool(args);
        break;
      case "synthi_dojo_get_lifecycle":
        response = dojoGetLifecycleTool(args);
        break;
      case "synthi_dojo_get_governance_report":
        response = dojoGetGovernanceReportTool(args);
        break;
      case "synthi_dojo_get_metrics":
        response = dojoGetMetricsTool(args);
        break;
      case "synthi_dojo_get_source_affordance_pr_plan":
        response = dojoGetSourceAffordancePrPlanTool(args);
        break;
      case "synthi_dojo_get_registry":
        response = dojoGetRegistryTool();
        break;
      case "synthi_dojo_get_skill_assurance_case":
        response = dojoGetAssuranceCaseTool(args);
        break;
      case "synthi_dojo_get_entrustment_level":
        response = dojoGetEntrustmentLevelTool(args);
        break;
      case "synthi_dojo_get_license":
        response = dojoGetLicenseTool(args);
        break;
      case "synthi_dojo_get_guardrails":
        response = dojoGetGuardrailsTool(args);
        break;
      case "synthi_dojo_get_case_law":
        response = dojoGetCaseLawTool(args);
        break;
      case "synthi_dojo_explain_block":
        response = dojoExplainBlockTool(args);
        break;
      case "synthi_dojo_explain_failure":
        response = dojoExplainFailureTool(args);
        break;
      case "synthi_dojo_debug_counterfactual":
        response = dojoDebugCounterfactualTool(args);
        break;
      case "synthi_dojo_run_time_machine_debugger":
        response = dojoRunTimeMachineDebuggerTool(args);
        break;
      case "synthi_dojo_run_ghost_mode":
        response = dojoRunGhostModeTool(args);
        break;
      case "synthi_dojo_request_permission_upgrade":
        response = dojoPermissionUpgradeTool(args);
        break;
      case "synthi_dojo_review_permission_upgrade":
        response = dojoReviewPermissionUpgradeTool(args);
        break;
      case "synthi_dojo_review_case_law":
        response = dojoReviewCaseLawTool(args);
        break;
      case "synthi_dojo_generate_vivarium_scenarios":
        response = dojoGenerateVivariumScenariosTool(args);
        break;
      case "synthi_dojo_run_vivarium_scenario":
        response = await dojoRunVivariumScenarioTool(args);
        break;
      case "synthi_dojo_run_wind_tunnel":
        response = await dojoRunWindTunnelTool(args);
        break;
      case "synthi_dojo_run_checkride":
        response = await dojoRunCheckrideTool(args);
        break;
      case "synthi_dojo_publish_skill":
        response = dojoPublishSkillTool(args);
        break;
      case "synthi_dojo_recertify_skill":
        response = dojoRecertifySkillTool(args);
        break;
      case "synthi_dojo_get_license_health":
        response = dojoGetLicenseHealthTool(args);
        break;
      case "synthi_dojo_revoke_license":
        response = dojoRevokeLicenseTool(args);
        break;
      case "synthi_dojo_record_case_law":
        response = dojoRecordCaseLawTool(args);
        break;
      case "synthi_dojo_export_artifacts":
        response = dojoExportArtifactsTool(args);
        break;
      case "synthi_dojo_export_compliance_pack":
        response = dojoExportCompliancePackTool(args);
        break;
      case "synthi_dojo_issue_proof_capsule":
        response = dojoIssueProofCapsuleTool(args);
        break;
      case "synthi_dojo_validate_proof_capsule":
        response = dojoValidateProofCapsuleTool(args);
        break;
      case "synthi_dojo_revoke_proof_capsule":
        response = dojoRevokeProofCapsuleTool(args);
        break;
      case "synthi_dojo_run_with_proof_capsule":
        response = await dojoRunWithProofCapsuleTool(args);
        break;
      default:
        return null;
    }
    return response ? withDojoImplementationMetadata(toolName, response) : null;
  } catch (err) {
    return withDojoImplementationMetadata(toolName, errorFromException("dojo_tool_failed", err));
  }
}

function withDojoImplementationMetadata(toolName: string, response: ToolResponse): ToolResponse {
  const dojoImplementation = buildDojoImplementationMetadata(toolName);
  const structuredContent = {
    ...(response.structuredContent ?? {}),
    implementation_status: dojoImplementation.implementation_status,
    runtime_enforced: dojoImplementation.runtime_enforced,
    evidence_backing: dojoImplementation.evidence_backing,
    simulation_backing: dojoImplementation.simulation_backing,
    dojo_implementation: dojoImplementation,
  };
  return {
    ...response,
    structuredContent,
    content: response.content.map((block) => block.type === "text" ? { ...block, text: JSON.stringify(structuredContent) } : block),
  };
}

async function dojoListCompetenciesTool(args: unknown): Promise<ToolResponse> {
  const skills = dojoSkillRegistry.list();
  const skillBus = createInProcessDojoMcpSkillBus({ listSkills: () => skills });
  const visible = await skillBus.listCompetencies({ tenant: dojoTenantContextFromArgs(args) });
  const visibleSkillIds = new Set(visible.map((item) => item.skill_id));
  return jsonResponse({
    ok: true,
    count: visible.length,
    competencies: skills.filter((skill) => visibleSkillIds.has(skill.skill_id)).map(skillListItem),
    product_path: "agent_to_mcp_skill_bus_to_proof_validator_to_license_kernel_to_dojo_runtime",
  });
}

function dojoGetSkillTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill: skill.skill, mcp_skill_manifest: buildDojoMcpSkillManifest(skill.skill) });
}

function dojoGetSkillCortexTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, skill_cortex: skill.skill.skill_cortex });
}

function dojoGetWorkspaceOrganoidTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, workspace_organoid: skill.skill.workspace_organoid });
}

function dojoGetWindTunnelReportTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, wind_tunnel: skill.skill.wind_tunnel });
}

function dojoGetCounterfactualTwinTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const filters = scenarioFilters(args);
  const variants = filterByScenario(skill.skill.counterfactual_twin.variants, filters);
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    counterfactual_twin: {
      ...skill.skill.counterfactual_twin,
      variants,
    },
  });
}

function dojoGetEvilTwinReportTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, evil_twin: skill.skill.evil_twin });
}

function dojoGetTrainingReportTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, training_report: skill.skill.training_report });
}

function dojoGetSkillPassportTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, skill_passport: skill.skill.skill_passport });
}

function dojoGetSkillGenomeTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, skill_genome: skill.skill.skill_genome });
}

function dojoGetAntibodiesTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, antibodies: skill.skill.antibodies });
}

function dojoGetAgentReadyUiContractTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, agent_ready_ui_contract: skill.skill.agent_ready_ui_contract });
}

function dojoGetCostPolicyTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, cost_control_policy: skill.skill.cost_control_policy });
}

function dojoGetUniverseDossierTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    universe_dossier: buildDojoUniverseDossier(skill.skill, dojoSkillRegistry.list(), {
      question: stringOpt(a["question"]),
      mutation_kind: stringOpt(a["mutation_kind"]),
    }),
  });
}

function dojoGetLifecycleTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({ ok: true, skill_id: skill.skill.skill_id, lifecycle: buildDojoLifecycleReport(skill.skill) });
}

function dojoGetGovernanceReportTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    governance_report: buildDojoGovernanceReport(skill.skill),
    governance_service: buildDojoGovernanceServiceView({
      skills: dojoSkillRegistry.list(),
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: dojoSkillRegistry.listPermissionUpgradeRequests(),
      now: new Date().toISOString(),
    }),
  });
}

function dojoGetMetricsTool(args: unknown): ToolResponse {
  const selected = skillByArgs(args);
  const skills = selected ? [selected] : dojoSkillRegistry.list();
  return jsonResponse({ ok: true, metrics: buildDojoUniverseMetrics(skills) });
}

function dojoGetSourceAffordancePrPlanTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    source_affordance_pr_plan: buildDojoSourceAffordancePrPlan(skill.skill),
  });
}

function dojoGetRegistryTool(): ToolResponse {
  const skills = dojoSkillRegistry.list();
  return jsonResponse({
    ok: true,
    registry: buildDojoOrganizationRegistry(skills),
    governance_service: buildDojoGovernanceServiceView({
      skills,
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: dojoSkillRegistry.listPermissionUpgradeRequests(),
      now: new Date().toISOString(),
    }),
  });
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
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    case_law: skill.skill.case_law,
    case_law_records: storedCaseLawRecordsForSkill(skill.skill),
  });
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
        error_codes: ["proof_capsule_missing" as const],
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
    refusal_explanation: validation.ok ? null : refusalExplanationFor(skill.skill, requestedAction, validation.blocked_by),
    relevant_case_law: skill.skill.case_law.slice(0, 3),
  });
}

function dojoExplainFailureTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const filters = scenarioFilters(args);
  const guardrailId = stringOpt(obj(args)["guardrail_id"]);
  const caseId = stringOpt(obj(args)["case_id"]);
  const scenario = firstScenario(skill.skill, filters);
  const result = scenario
    ? skill.skill.checkride.results.find((item) => item.scenario_id === scenario.scenario_id) ?? null
    : null;
  const matchedCase = caseId
    ? skill.skill.case_law.find((item) => item.case_id === caseId) ?? null
    : result
    ? skill.skill.case_law.find((item) => result.evidence_refs.some((ref) => item.evidence_refs.includes(ref))) ?? null
    : null;
  const matchedGuardrails = skill.skill.guardrails.filter((guardrail) => {
    if (guardrailId) return guardrail.guardrail_id === guardrailId;
    if (matchedCase?.case_id) return guardrail.source_case_id === matchedCase.case_id;
    return result?.status !== "passed" && guardrail.blocks_actions.includes("run_workflow");
  });
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    scenario,
    result,
    case_law: matchedCase,
    guardrails: matchedGuardrails,
    explanation: failureExplanation(skill.skill, scenario, result, matchedCase, matchedGuardrails),
    next_steps: permissionUpgradeSteps(skill.skill, "run_workflow"),
  });
}

function dojoDebugCounterfactualTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const filters = scenarioFilters(args);
  const variants = filterByScenario(skill.skill.counterfactual_twin.variants, filters);
  const scenarioIds = new Set(variants.map((variant) => variant.scenario_id));
  const scenarios = skill.skill.scenarios.filter((scenario) => scenarioIds.has(scenario.scenario_id));
  const results = skill.skill.checkride.results.filter((result) => scenarioIds.has(result.scenario_id));
  const attacks = skill.skill.evil_twin.attacks.filter((attack) => scenarioIds.has(attack.scenario_id));
  const guardrailRefs = new Set(attacks.flatMap((attack) => attack.guardrail_refs));
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    variants,
    scenarios,
    results,
    attacks,
    guardrails: skill.skill.guardrails.filter((guardrail) => guardrailRefs.has(guardrail.guardrail_id)),
    promoted_scenarios: skill.skill.counterfactual_twin.promoted_scenarios.filter((scenarioId) => scenarioIds.has(scenarioId)),
    cost_policy: skill.skill.cost_control_policy,
  });
}

function dojoRunTimeMachineDebuggerTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    time_machine_debugger: runDojoTimeMachineDebugger(skill.skill, {
      scenario_id: stringOpt(a["scenario_id"]),
      mutation_kind: stringOpt(a["mutation_kind"]),
      question: stringOpt(a["question"]),
    }),
  });
}

function dojoRunGhostModeTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const observed = objectOpt(a["observed_human_action"]) ?? {};
  const planned = objectOpt(a["agent_planned_action"]) ?? {};
  const observedLabel = ghostActionLabel(observed);
  const plannedLabel = ghostActionLabel(planned);
  const actionMatches = observedLabel.length > 0 && plannedLabel.length > 0 && observedLabel === plannedLabel;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const runId = `ghost_${hashId(`${skill.skill.skill_id}:${observedLabel}:${plannedLabel}:${now}`)}`;
  const guardrailsTriggered = actionMatches
    ? []
    : skill.skill.guardrails.filter((guardrail) => guardrail.blocks_actions.includes("run_workflow")).slice(0, 3);
  const licenseStatus = skill.skill.permission_license.allowed_actions.some((action) => action.action === "run_workflow") ? "licensed" : "blocked";
  const evidenceRefs = [
    `skill:${skill.skill.skill_id}`,
    `license:${skill.skill.permission_license.license_id}`,
    `ghost:${runId}`,
    ...guardrailsTriggered.map((guardrail) => `guardrail:${guardrail.guardrail_id}`),
  ];
  const entrustmentImpact = actionMatches
    ? {
      upgrade_allowed: true,
      recommended_entrustment: skill.skill.entrustment_level,
      reason: "Ghost Mode matched the human action label and wrote shadow evidence without production mutation.",
    }
    : {
      upgrade_allowed: false,
      recommended_entrustment: "EX",
      reason: "Ghost Mode mismatch prevents entrustment upgrade until the planned action is retrained or recertified.",
    };
  const shadowEvidence = {
    schema_version: "synthi.dojo.ghostShadowEvidence.v1",
    evidence_id: `ghost_evidence_${hashId(`${runId}:${evidenceRefs.join("|")}`)}`,
    run_id: runId,
    skill_id: skill.skill.skill_id,
    workflow_id: skill.skill.workflow_id,
    evidence_kind: "shadow",
    production_mutations_executed: false,
    action_matches: actionMatches,
    observed_label: observedLabel,
    planned_label: plannedLabel,
    license_status: licenseStatus,
    guardrail_refs: guardrailsTriggered.map((guardrail) => guardrail.guardrail_id),
    evidence_refs: evidenceRefs,
    entrustment_impact: entrustmentImpact,
    created_at: now,
  };
  const run = {
    run_id: runId,
    skill_id: skill.skill.skill_id,
    workflow_id: skill.skill.workflow_id,
    mode: "ghost",
    observed_human_action: observed,
    agent_planned_action: planned,
    status: actionMatches ? "matched" : "mismatch",
    would_execute: false,
    license_status: licenseStatus,
    guardrails_triggered: guardrailsTriggered.map((guardrail) => guardrail.guardrail_id),
    production_mutations_executed: false,
    shadow_evidence_id: shadowEvidence.evidence_id,
    evidence_refs: evidenceRefs,
    entrustment_impact: entrustmentImpact,
    explanation: actionMatches
      ? "Ghost mode matched the demonstrated action label and did not execute production mutations."
      : "Ghost mode found a mismatch or incomplete planned action, so production execution remains blocked.",
  };
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    ghost_run: run,
    shadow_evidence: shadowEvidence,
    guardrails: guardrailsTriggered,
  });
}

function dojoPermissionUpgradeTool(args: unknown): ToolResponse {
  const a = obj(args);
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_permission_upgrade_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_permission_upgrade_actor_type_required");
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const requiredSteps = permissionUpgradeSteps(skill.skill, requestedAction);
  const requestId = stringOpt(a["request_id"])
    ?? `upgrade_${hashId(`${skill.skill.skill_id}:${requestedAction}:${now}:${requiredSteps.join("|")}`)}`;
  const evidenceRefs = permissionUpgradeEvidenceRefs(skill.skill, requestedAction, requiredSteps);
  const requestRecord: DojoPermissionUpgradeRequestRecord = {
    schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
    request_id: requestId,
    skill_id: skill.skill.skill_id,
    workflow_id: skill.skill.workflow_id,
    workspace_id: skill.skill.workspace_id,
    license_id: skill.skill.permission_license.license_id,
    license_version: skill.skill.permission_license.license_version,
    requested_action: requestedAction,
    current_entrustment_level: skill.skill.entrustment_level,
    required_steps: requiredSteps,
    status: requiredSteps.includes("no_upgrade_required_for_current_license") ? "not_required" : "pending",
    evidence_refs: evidenceRefs,
    requested_at: now,
    requested_by: {
      actor_id: actorId,
      actor_type: actorType,
    },
    request_context: {
      request_id: requestId,
      correlation_id: stringOpt(a["correlation_id"]) ?? `upgrade-${hashId(`${requestId}:${skill.skill.workflow_id}`)}`,
    },
  };
  const storedRequest = dojoSkillRegistry.recordPermissionUpgradeRequest(requestRecord);
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    current_entrustment_level: skill.skill.entrustment_level,
    required_steps: requiredSteps,
    permission_upgrade_request: storedRequest,
    matching_approval_queue: buildDojoGovernanceServiceView({
      skills: [skill.skill],
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: [storedRequest],
      now,
    }).approval_queue.filter((item) => item.request_id === storedRequest.request_id),
  });
}

function dojoReviewPermissionUpgradeTool(args: unknown): ToolResponse {
  const a = obj(args);
  const requestId = stringOpt(a["request_id"]);
  if (!requestId) return errorResponse("dojo_permission_upgrade_request_id_required");
  const decision = permissionUpgradeDecisionOpt(a["decision"]);
  if (!decision) return errorResponse("dojo_permission_upgrade_decision_required", {
    allowed_decisions: ["approved", "denied"],
  });
  const storedRequest = dojoSkillRegistry.listPermissionUpgradeRequests({ request_id: requestId, limit: 1 })[0];
  if (!storedRequest) return errorResponse("dojo_permission_upgrade_request_not_found", { request_id: requestId });
  const reviewerActorId = stringOpt(a["reviewer_actor_id"]) ?? stringOpt(a["actor_id"]);
  if (!reviewerActorId) return errorResponse("dojo_permission_upgrade_reviewer_required");
  const reviewerActorType = actorTypeInputOpt(a["reviewer_actor_type"] ?? a["actor_type"]);
  if (!reviewerActorType) return errorResponse("dojo_permission_upgrade_reviewer_actor_type_required");

  const review = decideDojoPermissionUpgradeRequest({
    request: storedRequest,
    decision,
    decided_by: {
      actor_id: reviewerActorId,
      actor_type: reviewerActorType,
    },
    decided_at: stringOpt(a["decided_at"]) ?? stringOpt(a["now"]),
    reason: stringOpt(a["reason"]),
    evidence_refs: stringArrayOpt(a["evidence_refs"]),
  });
  if (!review.ok) {
    return errorResponse(review.error ?? "dojo_permission_upgrade_review_rejected", {
      request_id: requestId,
      review,
    });
  }

  const updatedRequest = dojoSkillRegistry.recordPermissionUpgradeRequest(review.request);
  const skill = dojoSkillRegistry.get(updatedRequest.skill_id);
  return jsonResponse({
    ok: true,
    request_id: requestId,
    decision,
    permission_upgrade_request: updatedRequest,
    review,
    governance_service: buildDojoGovernanceServiceView({
      skills: skill ? [skill] : [],
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: [updatedRequest],
      now: updatedRequest.reviewed_at,
    }),
  });
}

function dojoReviewCaseLawTool(args: unknown): ToolResponse {
  const a = obj(args);
  const caseId = stringOpt(a["case_id"]);
  if (!caseId) return errorResponse("dojo_case_law_case_id_required");
  const decision = caseLawReviewDecisionOpt(a["decision"]);
  if (!decision) return errorResponse("dojo_case_law_decision_required", {
    allowed_decisions: ["approved", "deprecated"],
  });
  const reviewerActorId = stringOpt(a["reviewer_actor_id"]) ?? stringOpt(a["actor_id"]);
  if (!reviewerActorId) return errorResponse("dojo_case_law_reviewer_required");
  const reviewerActorType = actorTypeInputOpt(a["reviewer_actor_type"] ?? a["actor_type"]);
  if (!reviewerActorType) return errorResponse("dojo_case_law_reviewer_actor_type_required");

  const selectedSkill = skillByArgs(args);
  const storedRecord = dojoSkillRegistry.getCaseLawRecord(caseId);
  const skillLocalRecord = !storedRecord && selectedSkill
    ? caseLawRecordsForSkill(selectedSkill).find((record) => record.case_id === caseId)
    : undefined;
  const record = storedRecord ?? (skillLocalRecord ? dojoSkillRegistry.recordCaseLawRecord(skillLocalRecord) : null);
  if (!record) return errorResponse("dojo_case_law_not_found", { case_id: caseId });

  const review = decideDojoCaseLawReview({
    case_law: record,
    decision,
    decided_by: {
      actor_id: reviewerActorId,
      actor_type: reviewerActorType,
    },
    decided_at: stringOpt(a["decided_at"]) ?? stringOpt(a["now"]),
    reason: stringOpt(a["reason"]),
    evidence_refs: stringArrayOpt(a["evidence_refs"]),
    superseded_by: stringOpt(a["superseded_by"]),
  });
  if (!review.ok) {
    return errorResponse(review.error ?? "dojo_case_law_review_rejected", {
      case_id: caseId,
      review,
    });
  }

  const updatedRecord = dojoSkillRegistry.recordCaseLawRecord(review.case_law);
  const scopedSkill = selectedSkill
    ?? (updatedRecord.binding_scope.kind === "skill" ? dojoSkillRegistry.get(updatedRecord.binding_scope.id) : null);
  const updatedSkill = scopedSkill?.case_law.some((item) => item.case_id === updatedRecord.case_id)
    ? dojoSkillRegistry.publish(applyCaseLawReviewToSkill(scopedSkill, updatedRecord))
    : scopedSkill;
  const governanceSkills = updatedSkill ? [updatedSkill] : dojoSkillRegistry.list();
  return jsonResponse({
    ok: true,
    case_id: caseId,
    decision,
    case_law_record: updatedRecord,
    review,
    ...(updatedSkill ? { skill_id: updatedSkill.skill_id, skill: skillListItem(updatedSkill) } : {}),
    governance_service: buildDojoGovernanceServiceView({
      skills: governanceSkills,
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: dojoSkillRegistry.listPermissionUpgradeRequests(),
      now: updatedRecord.updated_at,
    }),
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

async function dojoRunVivariumScenarioTool(args: unknown): Promise<ToolResponse> {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const scenarioRun = await runDojoVivariumScenario(skill.skill, {
    scenario_id: stringOpt(a["scenario_id"]),
    mutation_kind: stringOpt(a["mutation_kind"]),
  });
  const updated = persistDojoRuns(skill.skill, [scenarioRun.run]);
  return jsonResponse({
    ok: true,
    skill_id: updated.skill_id,
    vivarium_run: scenarioRun,
    persisted_skill: skillListItem(updated),
    license_health: licenseHealthFor(updated),
  });
}

async function dojoRunWindTunnelTool(args: unknown): Promise<ToolResponse> {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const tunnel = await runDojoWindTunnel(skill.skill, {
    max_scenarios: numberOpt(obj(args)["max_scenarios"]),
  });
  const updated = persistDojoRuns(skill.skill, tunnel.runs.map((run) => run.run), tunnel);
  return jsonResponse({
    ok: true,
    skill_id: updated.skill_id,
    wind_tunnel_execution: tunnel,
    persisted_skill: skillListItem(updated),
    license_health: licenseHealthFor(updated),
  });
}

async function dojoRunCheckrideTool(args: unknown): Promise<ToolResponse> {
  const artifact = requiredWorkflowArtifact(args);
  if (!artifact.ok) return artifact.error;
  const a = obj(args);
  const contract = artifact.artifact.workflow.contract;
  const workspaceId = stringOpt(a["workspace_id"]);
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const seed = extractDojoSkillSeed(contract, { workspace_id: workspaceId, now });
  const scenarios = generateDojoVivariumScenarios(seed);
  const checkride = runDojoCheckride(seed, scenarios, contract, { now });
  const previewSkill = buildDojoSkill(contract, {
    workspace_id: workspaceId,
    now,
    private_tool_manifest: generatePrivateWorkflowToolManifest(contract),
  });
  const runtimeSkill = withExecutableCheckrideGuardrails(previewSkill);
  const compiledGraph = compileDojoSkillGraphForSkill(runtimeSkill, {
    mode: "checkride",
    created_at: now,
  });
  const scenarioDefinitions = toDojoScenarioDefinitions(scenarios, {
    target_graph_node_ids: ["action"],
  });
  const scenarioDefinitionValidation = scenarioDefinitions.map((scenario) => ({
    scenario_id: scenario.scenario_id,
    validation: validateDojoScenarioDefinition(scenario),
  }));
  const executableCheckride = await runDojoExecutableCheckride({
    graph: compiledGraph.graph,
    scenarios: scenarioDefinitions,
    base_inputs: checkrideRuntimeInputsFor(runtimeSkill),
    evidence_context: {
      tenant_id: stringOpt(a["tenant_id"]) ?? "local-tenant",
      workspace_id: workspaceId ?? runtimeSkill.workspace_id,
      skill_id: runtimeSkill.skill_id,
      created_at: now,
      created_by: stringOpt(a["actor_id"]) ?? "synthi_dojo_run_checkride",
      run_id_prefix: `checkride_${hashId(`${runtimeSkill.skill_id}:${now}`)}`,
    },
    now,
  });
  return jsonResponse({
    ok: true,
    workflow_id: artifact.artifact.workflow_id,
    skill_seed: seed,
    scenarios,
    checkride,
    executable_checkride: executableCheckride,
    graph_runtime: {
      graph_id: compiledGraph.graph.graph_id,
      graph_mode: compiledGraph.graph.mode,
      validation: compiledGraph.validation,
      node_count: compiledGraph.graph.nodes.length,
      executable_node_kinds: [...new Set(compiledGraph.graph.nodes.map((node) => node.kind))],
    },
    scenario_definitions: scenarioDefinitions,
    scenario_definition_validation: scenarioDefinitionValidation,
    runtime_guardrails: runtimeSkill.guardrails,
    case_law: previewSkill.case_law,
    guardrails: previewSkill.guardrails,
    license_preview: previewSkill.permission_license,
    skill_card: previewSkill.skill_card,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(previewSkill)),
  });
}

function withExecutableCheckrideGuardrails(skill: DojoSkill): DojoSkill {
  const updated = cloneJson(skill);
  updated.guardrails = updated.guardrails.map((guardrail) => ({
    ...guardrail,
    rule: normalizeDojoGuardrailPredicate({
      rule: guardrail.rule,
      title: guardrail.title,
      guardrail_id: guardrail.guardrail_id,
    }).predicate,
  }));
  return updated;
}

function checkrideRuntimeInputsFor(skill: DojoSkill): Record<string, unknown> {
  const assertionResults = Object.fromEntries(
    skill.skill_seed.candidate_success_assertions.map((assertion) => [assertion.assertion_id, true])
  );
  const inputs: Record<string, unknown> = {
    assertion_results: assertionResults,
    workspace_verified: true,
    proof_capsule_valid: true,
    entrustment_level: skill.permission_license.entrustment_level,
    client_id_verified: true,
    source_anchor_current: true,
    durable_state_evidence: true,
    human_review_ready: true,
  };
  for (const claim of [
    ...skill.permission_license.proof_requirements.required_context_claims,
    ...skill.permission_license.proof_requirements.required_evidence_claims,
  ]) {
    inputs[claim] = true;
  }
  for (const guardrail of skill.guardrails) {
    const contextKey = contextKeyForDojoGuardrailPredicate(guardrail.rule);
    if (contextKey) inputs[contextKey] = true;
  }
  return inputs;
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
    mcp_skill_manifest: buildDojoMcpSkillManifest(skill),
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
  const a = obj(args);
  const workflowId = existing?.workflow_id ?? stringOpt(a["workflow_id"]);
  const artifact = requiredWorkflowArtifact({ workflow_id: workflowId });
  if (!artifact.ok) return artifact.error;
  const workspaceId = stringOpt(a["workspace_id"]) ?? existing?.workspace_id;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const reason = stringOpt(a["reason"]);
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  const actorId = stringOpt(a["actor_id"]);
  const previousLicenseVersion = existing?.permission_license.license_version ?? null;
  const manifest = generatePrivateWorkflowToolManifest(artifact.artifact.workflow.contract);
  const publishedToolName = existing?.published_tool_name;
  const recertified = dojoSkillRegistry.publish(buildDojoSkill(artifact.artifact.workflow.contract, {
    workspace_id: workspaceId,
    now,
    private_tool_manifest: manifest,
    ...(publishedToolName ? { published_tool_name: publishedToolName } : {}),
  }));
  const auditEvent = actorId ? {
    event_type: "checkride_run_completed" as const,
    actor: {
      actor_id: actorId,
      actor_type: actorTypeOpt(a["actor_type"]),
    },
    occurred_at: now,
    workspace_id: recertified.workspace_id,
    skill_id: recertified.skill_id,
    license_id: recertified.permission_license.license_id,
    reason,
    evidence_refs: evidenceRefs,
  } : undefined;
  return jsonResponse({
    ok: true,
    skill: skillListItem(recertified),
    mcp_skill_manifest: buildDojoMcpSkillManifest(recertified),
    recertification: {
      ok: true,
      status: "applied",
      skill_id: recertified.skill_id,
      workflow_id: recertified.workflow_id,
      reason: reason ?? null,
      evidence_refs: evidenceRefs,
      previous_license_version: previousLicenseVersion,
      license_version: recertified.permission_license.license_version,
      audit_event: auditEvent,
    },
    checkride: recertified.checkride,
    license: recertified.permission_license,
    license_health: licenseHealthFor(recertified),
    governance_service: buildDojoGovernanceServiceView({
      skills: dojoSkillRegistry.list(),
      case_law_records: dojoSkillRegistry.listCaseLawRecords(),
      permission_upgrade_requests: dojoSkillRegistry.listPermissionUpgradeRequests(),
      now,
    }),
    assurance_case: recertified.assurance_case,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(recertified)),
  });
}

function dojoGetLicenseHealthTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    license_health: licenseHealthFor(skill.skill),
  });
}

function dojoRevokeLicenseTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_license_revocation_reason_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_license_revocation_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_license_revocation_actor_type_required");
  const revocation = revokeDojoSkillLicense({
    skill: skill.skill,
    reason,
    revoked_at: now,
    revoked_by: {
      actor_id: actorId,
      actor_type: actorType,
    },
    evidence_refs: stringArrayOpt(a["evidence_refs"]),
  });
  const saved = dojoSkillRegistry.publish(revocation.skill);
  return jsonResponse({
    ok: true,
    skill_id: saved.skill_id,
    reason,
    revocation,
    license: saved.permission_license,
    lifecycle: buildDojoLifecycleReport(saved),
    governance_report: buildDojoGovernanceReport(saved),
  });
}

function dojoRecordCaseLawTool(args: unknown): ToolResponse {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const finding = stringOpt(a["finding"]);
  const rule = stringOpt(a["rule"]);
  if (!finding || !rule) return errorResponse("dojo_case_law_finding_and_rule_required");
  const now = new Date().toISOString();
  const title = stringOpt(a["title"]) ?? titleFromFinding(finding);
  const impact = stringOpt(a["impact"]) ?? "The skill could act outside its licensed tested conditions.";
  const appliesTo = stringArrayOpt(a["applies_to"]);
  const scope = bindingScopeOpt(a["binding_scope"]);
  const sourceRunId = stringOpt(a["source_run_id"])
    ?? skill.skill.training_runs[skill.skill.training_runs.length - 1]?.run_id
    ?? skill.skill.checkride.checkride_id;
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  const caseId = `case_${hashId(`${skill.skill.skill_id}:${sourceRunId}:${finding}:${rule}`)}`;
  const guardrailId = `guard_${hashId(`${caseId}:${rule}`)}`;
  const antibodyId = `antibody_${hashId(`${caseId}:${guardrailId}`)}`;
  const caseLaw: DojoSkill["case_law"][number] = {
    case_id: caseId,
    title,
    date: now.slice(0, 10),
    source_skill_id: skill.skill.skill_id,
    source_run_id: sourceRunId,
    finding,
    impact,
    rule_created: rule,
    applies_to: appliesTo.length > 0 ? appliesTo : [...new Set(skill.skill.skill_seed.risk_clues.map((risk) => risk.label))],
    binding_scope: scope,
    status: stringOpt(a["status"]) === "proposed" ? "proposed" : "binding",
    evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : [`skill:${skill.skill.skill_id}`, `run:${sourceRunId}`],
  };
  const guardrail: DojoSkill["guardrails"][number] = {
    guardrail_id: guardrailId,
    title: `${title} guardrail`,
    rule,
    blocks_actions: stringArrayOpt(a["blocks_actions"]).length > 0 ? stringArrayOpt(a["blocks_actions"]) : ["run_workflow"],
    source_case_id: caseId,
    severity: severityOpt(a["severity"]),
  };
  const antibody: DojoSkill["antibodies"][number] = {
    antibody_id: antibodyId,
    case_id: caseId,
    guardrail_id: guardrailId,
    trigger: finding,
    response: rule,
    applies_to: caseLaw.applies_to,
    binding_scope: caseLaw.binding_scope,
    evidence_refs: caseLaw.evidence_refs,
    created_at: now,
  };
  const updated = cloneJson(skill.skill);
  updated.case_law = upsertBy(updated.case_law, caseLaw, "case_id");
  updated.guardrails = upsertBy(updated.guardrails, guardrail, "guardrail_id");
  updated.antibodies = upsertBy(updated.antibodies, antibody, "antibody_id");
  updated.case_law_refs = [...new Set([...updated.case_law_refs, caseId])];
  updated.permission_license = {
    ...updated.permission_license,
    license_version: bumpVersion(updated.permission_license.license_version),
    proof_requirements: {
      ...updated.permission_license.proof_requirements,
      required_guardrails: [...new Set([...updated.permission_license.proof_requirements.required_guardrails, guardrailId])],
    },
  };
  updated.training_report = {
    ...updated.training_report,
    summary: {
      ...updated.training_report.summary,
      guardrail_count: updated.guardrails.length,
      antibody_count: updated.antibodies.length,
    },
    evidence_refs: [...new Set([...updated.training_report.evidence_refs, ...caseLaw.evidence_refs])],
    readiness_decision: `Case law ${caseId} recorded; guardrail ${guardrailId} is ${caseLaw.status}.`,
  };
  updated.last_trained_at = now;
  const saved = dojoSkillRegistry.publish(updated);
  const caseLawRecord = dojoSkillRegistry.recordCaseLawRecord(caseLawRecordForSkillCase(saved, caseLaw));
  return jsonResponse({
    ok: true,
    skill_id: saved.skill_id,
    case_law: caseLaw,
    case_law_record: caseLawRecord,
    guardrail,
    antibody,
    license: saved.permission_license,
    governance_report: buildDojoGovernanceReport(saved),
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

function dojoExportCompliancePackTool(args: unknown): ToolResponse {
  const explicitSkill = skillByArgs(args);
  const skills = explicitSkill ? [explicitSkill] : dojoSkillRegistry.list();
  if (skills.length === 0) return errorResponse("dojo_skill_required");
  const now = stringOpt(obj(args)["now"]) ?? new Date().toISOString();
  const governanceService = buildDojoGovernanceServiceView({
    skills,
    case_law_records: dojoSkillRegistry.listCaseLawRecords(),
    permission_upgrade_requests: dojoSkillRegistry.listPermissionUpgradeRequests(),
    now,
  });
  const exportedArtifacts = skills.flatMap((skill) => exportDojoRepoArtifacts(skill));
  const complianceArtifactIds = governanceService.compliance_evidence_pack.artifacts
    .filter((artifact) => artifact.status === "available")
    .map((artifact) => artifact.artifact_id);
  const selectedArtifacts = selectComplianceArtifacts(exportedArtifacts, complianceArtifactIds);
  const manifest = {
    schema_version: "synthi.dojo.complianceEvidencePackExport.v1",
    export_id: `compliance_export_${hashId(`${now}:${skills.map((skill) => skill.skill_id).join(":")}:${selectedArtifacts.length}`)}`,
    generated_at: now,
    skill_ids: skills.map((skill) => skill.skill_id),
    workspace_ids: [...new Set(skills.map((skill) => skill.workspace_id))],
    compliance_evidence_pack: governanceService.compliance_evidence_pack,
    audit_exports: governanceService.audit_exports,
    artifact_count: selectedArtifacts.length,
    artifacts: artifactSummary(selectedArtifacts),
    missing_artifacts: governanceService.compliance_evidence_pack.missing_artifacts,
    secret_policy: "redacted_metadata_and_review_artifacts_only",
  };
  const manifestArtifact = {
    path: `.synthi/dojo/compliance/${manifest.export_id}.manifest.json`,
    content_type: "application/json",
    content: JSON.stringify(manifest, null, 2),
    sensitive: false as const,
  };
  return jsonResponse({
    ok: true,
    export_id: manifest.export_id,
    generated_at: now,
    pack: manifest,
    governance_service: governanceService,
    artifact_count: selectedArtifacts.length + 1,
    artifacts: [manifestArtifact, ...selectedArtifacts],
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
  const proofRecord = dojoSkillRegistry.recordProofCapsule(capsule);
  const validation = validateDojoProofCapsule(skill.skill, capsule, requestedAction);
  return jsonResponse({
    ok: validation.ok,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    proof_capsule: capsule,
    proof_record: proofRecord,
    validation,
  });
}

function dojoValidateProofCapsuleTool(args: unknown): ToolResponse {
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
      error_codes: ["proof_capsule_missing"],
    });
  }
  const decision = evaluateDojoLicenseKernel({
    skill: skill.skill,
    registry: dojoSkillRegistry,
    proof_capsule: capsule,
    requested_action: requestedAction,
    tool_args: objectOpt(a["tool_args"]) ?? {},
    dry_run: true,
  });
  return jsonResponse({
    ok: decision.ok,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    license_kernel: decision,
  });
}

function dojoRevokeProofCapsuleTool(args: unknown): ToolResponse {
  const a = obj(args);
  const capsuleId = stringOpt(a["capsule_id"]);
  if (!capsuleId) return errorResponse("dojo_proof_capsule_id_required");
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_proof_capsule_revocation_reason_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_proof_capsule_revocation_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_proof_capsule_revocation_actor_type_required");
  const record = dojoSkillRegistry.revokeProofCapsule(capsuleId, reason, stringOpt(a["now"]), {
    actor_id: actorId,
    actor_type: actorType,
  });
  if (!record) return errorResponse("dojo_proof_capsule_not_found", { capsule_id: capsuleId });
  return jsonResponse({ ok: true, proof_record: record });
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
      error_codes: ["proof_capsule_missing"],
    });
  }
  const toolArgs = objectOpt(a["tool_args"]) ?? {};
  const dryRun = boolOpt(a["dry_run"]);
  let decision: ReturnType<typeof evaluateDojoLicenseKernel> | undefined;
  const skillBus = createInProcessDojoMcpSkillBus({
    listSkills: () => dojoSkillRegistry.list(),
    validateProof: ({ skill: resolvedSkill, proof_capsule: proofCapsule, requested_action: action, args: proofArgs }) => {
      decision = evaluateDojoLicenseKernel({
        skill: resolvedSkill,
        registry: dojoSkillRegistry,
        proof_capsule: proofCapsule,
        requested_action: action,
        tool_args: proofArgs,
        dry_run: dryRun,
      });
      return {
        ok: decision.ok,
        status: decision.status,
        blocked_by: decision.blocked_by,
        error_codes: decision.error_codes,
      };
    },
    executeTool: async ({ skill: resolvedSkill, args: executionArgs }) => requestedAction === "run_prefix_validation"
      ? await dispatchSafetyTool("synthi_safety_run_prefix_validation", executionArgs)
      : await dispatchBackingSkillTool(resolvedSkill, executionArgs),
  });
  const skillBusResult = await skillBus.dispatch({
    tenant: dojoTenantContextFromArgs({
      ...a,
      workspace_id: stringOpt(a["workspace_id"]) ?? skill.skill.workspace_id,
    }),
    tool_name: skill.skill.published_tool_name ?? skill.skill.private_tool_manifest?.tool_name ?? "",
    requested_action: requestedAction,
    args: toolArgs,
    proof_capsule: capsule,
    dry_run: dryRun,
  });
  const licenseDecision = decision;
  if (!licenseDecision) {
    return errorResponse("dojo_license_kernel_not_evaluated", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      skill_bus: skillBusResult,
      refusal: refusalFor(skill.skill, ["dojo_license_kernel_not_evaluated"]),
    });
  }
  if (!skillBusResult.ok || !licenseDecision.ok) {
    return errorResponse(licenseDecision?.validation.error ?? skillBusResult.blocked_by[0] ?? "dojo_skill_bus_blocked", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      validation: licenseDecision.validation,
      license_kernel: licenseDecision,
      skill_bus: skillBusResult,
      refusal: refusalFor(skill.skill, licenseDecision.blocked_by.length > 0 ? licenseDecision.blocked_by : skillBusResult.blocked_by),
    });
  }
  if (dryRun) {
    return jsonResponse({
      ok: true,
      dry_run: true,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      validation: licenseDecision.validation,
      license_kernel: licenseDecision,
      skill_bus: skillBusResult,
    });
  }

  const run = skillBusResult.result && typeof skillBusResult.result === "object"
    ? skillBusResult.result as ToolResponse
    : null;
  if (!run) {
    return errorResponse("dojo_backing_tool_unavailable", {
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      published_tool_name: skill.skill.published_tool_name ?? null,
      skill_bus: skillBusResult,
    });
  }
  const proofRecord = run.isError === true ? licenseDecision.proof_record ?? null : markDojoProofExecution({
    registry: dojoSkillRegistry,
    proof_capsule: capsule,
  });
  return jsonResponse({
    ok: run.isError !== true,
    skill_id: skill.skill.skill_id,
    requested_action: requestedAction,
    validation: licenseDecision.validation,
    license_kernel: licenseDecision,
    skill_bus: skillBusResult,
    proof_capsule_id: capsule.capsule_id,
    proof_record: proofRecord,
    backing_tool: requestedAction === "run_prefix_validation" ? "synthi_safety_run_prefix_validation" : skill.skill.published_tool_name,
    result: run.structuredContent ?? {},
  });
}

async function dispatchBackingSkillTool(skill: DojoSkill, args: Record<string, unknown>): Promise<ToolResponse | null> {
  if (!skill.published_tool_name) return null;
  return await dispatchBrowserPrivateWorkflowToolAfterDojoProof(skill.published_tool_name, args);
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
    mcp_skill_manifest: buildDojoMcpSkillManifest(skill),
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

function selectComplianceArtifacts(
  artifacts: ReturnType<typeof exportDojoRepoArtifacts>,
  complianceArtifactIds: string[]
): ReturnType<typeof exportDojoRepoArtifacts> {
  const selected = new Map<string, ReturnType<typeof exportDojoRepoArtifacts>[number]>();
  for (const artifact of artifacts) {
    if (complianceArtifactIds.some((artifactId) => complianceArtifactCoversPath(artifactId, artifact.path))) {
      selected.set(artifact.path, artifact);
    }
  }
  return [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function complianceArtifactCoversPath(artifactId: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  switch (artifactId) {
    case "skill_assurance_case":
      return normalized.includes("assurance.case.md")
        || normalized.includes("checkride.report.md")
        || normalized.includes("training-report")
        || normalized.includes("skill-passport.json");
    case "license_and_proof_audit":
      return normalized.includes("license.json")
        || normalized.includes("proof-capsule.schema.json")
        || normalized.includes("lifecycle.report.json")
        || normalized.includes("governance.report.json")
        || normalized.includes("mcp.manifest.json");
    case "case_law_registry":
      return normalized.includes("case-law.md")
        || normalized.includes("/cases/")
        || normalized.includes("guardrails.json")
        || normalized.includes("antibodies.json");
    case "evidence_ledger_manifest":
      return normalized.includes("evidence-ledger.json")
        || normalized.includes("evidence-manifest.json")
        || normalized.includes("redacted-evidence-manifest.json")
        || normalized.includes("/evidence/")
        || normalized.includes(".ledger.json");
    default:
      return false;
  }
}

function refusalFor(skill: DojoSkill, blockedBy: string[]): string {
  const cited = skill.case_law.find((item) => item.status === "binding");
  if (cited) {
    return `I will not run ${skill.name} yet. ${cited.finding} Rule: ${cited.rule_created}`;
  }
  return `I will not run ${skill.name} yet. Blocked by ${blockedBy.join(", ") || "license policy"}.`;
}

function refusalExplanationFor(skill: DojoSkill, requestedAction: string, blockedBy: string[]) {
  return explainDojoRuntimeRefusal({
    graph: compileDojoSkillGraphForSkill(skill).graph,
    blocked_action: requestedAction,
    blocked_by: blockedBy,
    case_law: caseLawRecordsForSkill(skill),
  });
}

function caseLawRecordsForSkill(skill: DojoSkill): DojoCaseLawRecord[] {
  return skill.case_law.map((item) => caseLawRecordForSkillCase(skill, item));
}

function caseLawRecordForSkillCase(skill: DojoSkill, item: DojoSkill["case_law"][number]): DojoCaseLawRecord {
  return {
    schema_version: "synthi.dojo.caseLaw.v1",
    case_id: item.case_id,
    title: item.title,
    finding: item.finding,
    impact: item.impact,
    rule_created: item.rule_created,
    applies_to: [...item.applies_to],
    binding_scope: {
      kind: item.binding_scope,
      id: bindingScopeIdForSkillCase(skill, item.binding_scope),
    },
    status: item.status === "binding" ? "approved" : item.status,
    evidence_refs: [...item.evidence_refs],
    appeal_status: "none",
    created_at: item.date,
    updated_at: item.date,
  };
}

function storedCaseLawRecordsForSkill(skill: DojoSkill): DojoCaseLawRecord[] {
  return dojoSkillRegistry.listCaseLawRecords()
    .filter((record) => {
      if (record.binding_scope.kind === "skill") return record.binding_scope.id === skill.skill_id;
      if (record.binding_scope.kind === "workspace") return record.binding_scope.id === skill.workspace_id;
      if (record.binding_scope.kind === "organization") return record.binding_scope.id === `organization:${skill.workspace_id}`;
      return false;
    })
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function applyCaseLawReviewToSkill(skill: DojoSkill, record: DojoCaseLawRecord): DojoSkill {
  const updated = cloneJson(skill);
  const status: DojoSkill["case_law"][number]["status"] = record.status === "approved" ? "binding" : record.status;
  updated.case_law = updated.case_law.map((item) => item.case_id === record.case_id
    ? {
        ...item,
        title: record.title,
        finding: record.finding,
        impact: record.impact,
        rule_created: record.rule_created,
        applies_to: [...record.applies_to],
        binding_scope: skillCaseBindingScopeFromRecord(record),
        status,
        evidence_refs: [...record.evidence_refs],
      }
    : item
  );
  if (record.status === "approved") {
    updated.case_law_refs = [...new Set([...updated.case_law_refs, record.case_id])];
  }
  if (record.status === "deprecated") {
    updated.case_law_refs = updated.case_law_refs.filter((caseId) => caseId !== record.case_id);
    const deprecatedGuardrailIds = new Set(updated.guardrails
      .filter((guardrail) => guardrail.source_case_id === record.case_id)
      .map((guardrail) => guardrail.guardrail_id));
    updated.guardrails = updated.guardrails.filter((guardrail) => guardrail.source_case_id !== record.case_id);
    updated.permission_license = {
      ...updated.permission_license,
      proof_requirements: {
        ...updated.permission_license.proof_requirements,
        required_guardrails: updated.permission_license.proof_requirements.required_guardrails
          .filter((guardrailId) => !deprecatedGuardrailIds.has(guardrailId)),
      },
    };
  }
  updated.training_report = {
    ...updated.training_report,
    summary: {
      ...updated.training_report.summary,
      guardrail_count: updated.guardrails.length,
    },
    evidence_refs: [...new Set([...updated.training_report.evidence_refs, ...record.evidence_refs])],
    readiness_decision: `Case law ${record.case_id} ${record.status}; governance review recorded.`,
  };
  updated.last_trained_at = record.updated_at;
  return updated;
}

function skillCaseBindingScopeFromRecord(record: DojoCaseLawRecord): DojoSkill["case_law"][number]["binding_scope"] {
  if (record.binding_scope.kind === "skill" || record.binding_scope.kind === "workspace") return record.binding_scope.kind;
  return "organization";
}

function bindingScopeIdForSkillCase(skill: DojoSkill, bindingScope: DojoSkill["case_law"][number]["binding_scope"]): string {
  if (bindingScope === "skill") return skill.skill_id;
  if (bindingScope === "workspace") return skill.workspace_id;
  return `organization:${skill.workspace_id}`;
}

function permissionUpgradeSteps(skill: DojoSkill, requestedAction: string): string[] {
  const license = skill.permission_license;
  const required: string[] = [];
  if (!license.allowed_actions.some((action) => action.action === requestedAction)) {
    required.push("rerun_checkride_for_requested_action");
  }
  if (skill.checkride.critical_failures > 0) {
    required.push("resolve_critical_checkride_failures");
  }
  if (skill.guardrails.length === 0) {
    required.push("activate_guardrails");
  }
  if (!skill.published_tool_name) {
    required.push("publish_backing_private_workflow_tool");
  }
  if (skill.execution_substrates.length === 1 && skill.execution_substrates[0] === "vision") {
    required.push("add_dom_source_or_mcp_substrate");
  }
  if (skill.attack_success_rate > 0) {
    required.push("harden_evil_twin_escaped_attacks");
  }
  return required.length > 0 ? required : ["no_upgrade_required_for_current_license"];
}

function permissionUpgradeEvidenceRefs(skill: DojoSkill, requestedAction: string, requiredSteps: string[]): string[] {
  return [...new Set([
    `skill:${skill.skill_id}`,
    `workflow:${skill.workflow_id}`,
    `license:${skill.permission_license.license_id}`,
    `checkride:${skill.checkride.checkride_id}`,
    ...skill.guardrails.map((guardrail) => `guardrail:${guardrail.guardrail_id}`),
    ...skill.case_law.flatMap((item) => item.evidence_refs),
    ...requiredSteps.map((step) => `required_step:${requestedAction}:${step}`),
  ])];
}

function scenarioFilters(args: unknown): { scenario_id?: string; mutation_kind?: string } {
  const a = obj(args);
  const scenarioId = stringOpt(a["scenario_id"]);
  const mutationKind = stringOpt(a["mutation_kind"]);
  return {
    ...(scenarioId ? { scenario_id: scenarioId } : {}),
    ...(mutationKind ? { mutation_kind: mutationKind } : {}),
  };
}

function filterByScenario<T extends { scenario_id: string; mutation_kind?: string }>(
  items: T[],
  filters: { scenario_id?: string; mutation_kind?: string }
): T[] {
  return items.filter((item) => {
    if (filters.scenario_id && item.scenario_id !== filters.scenario_id) return false;
    if (filters.mutation_kind && item.mutation_kind !== filters.mutation_kind) return false;
    return true;
  });
}

function firstScenario(skill: DojoSkill, filters: { scenario_id?: string; mutation_kind?: string }): DojoSkill["scenarios"][number] | null {
  return skill.scenarios.find((scenario) => {
    if (filters.scenario_id && scenario.scenario_id !== filters.scenario_id) return false;
    if (filters.mutation_kind && scenario.mutation_kind !== filters.mutation_kind) return false;
    return true;
  }) ?? null;
}

function failureExplanation(
  skill: DojoSkill,
  scenario: DojoSkill["scenarios"][number] | null,
  result: DojoSkill["checkride"]["results"][number] | null,
  caseLaw: DojoSkill["case_law"][number] | null,
  guardrails: DojoSkill["guardrails"]
): string {
  if (!scenario) return `No matching scenario was found for ${skill.name}.`;
  if (!result) return `${scenario.title} exists, but no checkride result was recorded. Re-run the checkride before licensing changes.`;
  if (result.status === "passed") return `${scenario.title} passed. ${result.finding}`;
  const rule = caseLaw?.rule_created ?? guardrails[0]?.rule ?? result.guardrail_suggestion ?? "Re-run the workflow in vivarium before production execution.";
  return `${scenario.title} ${result.status}. ${result.finding} Dojo keeps the skill within ${skill.entrustment_level} until this rule is satisfied: ${rule}`;
}

function ghostActionLabel(action: Record<string, unknown>): string {
  const direct = stringOpt(action["label"]) ?? stringOpt(action["name"]) ?? stringOpt(action["action"]);
  if (direct) return direct.toLowerCase();
  const target = objectOpt(action["target"]);
  return (stringOpt(target?.["label"]) ?? stringOpt(target?.["name"]) ?? "").toLowerCase();
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

function dojoTenantContextFromArgs(args: unknown): DojoTenantContext {
  const a = obj(args);
  const roles = stringArrayOpt(a["roles"]);
  const hasTenantInput = Boolean(
    stringOpt(a["tenant_id"])
      || stringOpt(a["organization_id"])
      || stringOpt(a["workspace_id"])
      || stringOpt(a["actor_id"])
      || roles.length > 0
  );
  if (!hasTenantInput) return createLegacyDojoTenantContext();
  return {
    tenant_id: stringOpt(a["tenant_id"]) ?? "local-tenant",
    organization_id: stringOpt(a["organization_id"]) ?? "local-org",
    workspace_id: stringOpt(a["workspace_id"]) ?? "local-workspace",
    actor_id: stringOpt(a["actor_id"]) ?? "anonymous-agent",
    actor_type: actorTypeOpt(a["actor_type"]),
    roles: roles.length > 0 ? roles : ["agent"],
    request_id: stringOpt(a["request_id"]) ?? `dojo-list-${hashId(JSON.stringify(a))}`,
    correlation_id: stringOpt(a["correlation_id"]) ?? `dojo-list-${hashId(`${Date.now()}:${JSON.stringify(a)}`)}`,
  };
}

function actorTypeOpt(value: unknown): DojoTenantContext["actor_type"] {
  return value === "human" || value === "service" ? value : "agent";
}

function actorTypeInputOpt(value: unknown): DojoTenantContext["actor_type"] | undefined {
  return value === "human" || value === "agent" || value === "service" ? value : undefined;
}

function permissionUpgradeDecisionOpt(value: unknown): "approved" | "denied" | undefined {
  return value === "approved" || value === "denied" ? value : undefined;
}

function caseLawReviewDecisionOpt(value: unknown): "approved" | "deprecated" | undefined {
  return value === "approved" || value === "deprecated" ? value : undefined;
}

function persistDojoRuns(
  skill: DojoSkill,
  runs: DojoSkill["training_runs"],
  windTunnelExecution?: Awaited<ReturnType<typeof runDojoWindTunnel>>
): DojoSkill {
  if (runs.length === 0) return skill;
  const updated = cloneJson(skill);
  const runById = new Map(updated.training_runs.map((run) => [run.run_id, run]));
  for (const run of runs) runById.set(run.run_id, cloneJson(run));
  updated.training_runs = [...runById.values()];
  const runRefs = updated.training_runs.map((run) => run.run_id);
  updated.training_report = {
    ...updated.training_report,
    run_refs: [...new Set([...updated.training_report.run_refs, ...runRefs])],
    summary: {
      ...updated.training_report.summary,
      run_count: updated.training_runs.length,
    },
    evidence_refs: [...new Set([
      ...updated.training_report.evidence_refs,
      ...runs.flatMap((run) => run.evidence_refs),
    ])],
  };
  if (windTunnelExecution) {
    updated.wind_tunnel = {
      ...updated.wind_tunnel,
      generated_at: new Date().toISOString(),
      run_count: windTunnelExecution.run_count,
      runs: windTunnelExecution.runs.map((run) => run.run),
      summary: {
        ...updated.wind_tunnel.summary,
        passed: windTunnelExecution.pass_count,
        failed: windTunnelExecution.fail_count,
        blocked: windTunnelExecution.blocked_count,
        stop_reason: windTunnelExecution.stop_reason,
      },
    };
  }
  updated.last_trained_at = new Date().toISOString();
  return dojoSkillRegistry.publish(updated);
}

function licenseHealthFor(skill: DojoSkill): Record<string, unknown> {
  const proofRecords = dojoSkillRegistry.listProofRecords().filter((record) => record.skill_id === skill.skill_id);
  const proofRecordCounts = proofRecords.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
  const now = Date.now();
  const expiresAt = Date.parse(skill.license_expires_at);
  const daysUntilExpiry = Number.isFinite(expiresAt) ? Math.ceil((expiresAt - now) / 86_400_000) : null;
  const lifecycle = buildDojoLifecycleReport(skill);
  const governance = buildDojoGovernanceReport(skill);
  return {
    schema_version: "synthi.dojo.licenseHealth.v1",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    status: skill.entrustment_level === "EX" || (typeof daysUntilExpiry === "number" && daysUntilExpiry <= 0)
      ? "blocked"
      : lifecycle.status,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    license_version: skill.permission_license.license_version,
    license_expires_at: skill.license_expires_at,
    days_until_expiry: daysUntilExpiry,
    proof_records: proofRecordCounts,
    active_guardrails: skill.guardrails.length,
    binding_case_law: skill.case_law.filter((item) => item.status === "binding").length,
    lifecycle,
    governance,
    metrics: buildDojoUniverseMetrics([skill]),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 1;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] ?? 0 : 0;
  return `${major}.${minor}.${patch + 1}`;
}

function titleFromFinding(finding: string): string {
  const words = finding
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length === 0
    ? "Recorded Dojo Case"
    : words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function upsertBy<T extends Record<K, string>, K extends keyof T>(items: T[], item: T, key: K): T[] {
  const without = items.filter((existing) => existing[key] !== item[key]);
  return [...without, item];
}

function stringArrayOpt(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function severityOpt(value: unknown): DojoSkill["guardrails"][number]["severity"] {
  return value === "low" || value === "medium" || value === "critical" ? value : "high";
}

function bindingScopeOpt(value: unknown): DojoSkill["case_law"][number]["binding_scope"] {
  return value === "workspace" || value === "organization" ? value : "skill";
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

function numberOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolOpt(value: unknown): boolean {
  return value === true;
}
