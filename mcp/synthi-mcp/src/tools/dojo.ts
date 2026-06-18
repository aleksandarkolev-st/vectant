import { createHash } from "node:crypto";
import { browserBroker } from "../browser/broker.js";
import {
  buildDojoSkill,
  buildDojoSkillAssuranceArtifact,
  assertDojoProofSignerExternalReady,
  dojoSkillRegistry,
  exportDojoRepoArtifacts,
  extractDojoSkillSeed,
  generateDojoVivariumScenarios,
  isDojoProofEvidenceClaimError,
  issueDojoProofCapsule,
  runDojoCheckride,
  validateDojoProofCapsule,
  type DojoProofCarryingSkillCapsule,
  type DojoEvidenceClaim,
  type DojoExecutionSubstrate,
  type DojoExecutableEntrustmentSnapshot,
  type DojoRepoArtifact,
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
  type DojoPackageReadinessEvidenceSummary,
  type DojoTimeMachineDebugReport,
} from "../browser/dojo_universe.js";
import { generatePrivateWorkflowToolManifest } from "../browser/private_tool_manifest.js";
import {
  privateWorkflowToolDefinition,
  privateWorkflowToolRegistry,
  validatePrivateWorkflowToolPublication,
} from "../browser/private_tool_registry.js";
import { evaluateDojoLicenseKernel, markDojoProofExecution } from "../dojo/license/kernel.js";
import {
  buildDojoVivariumGraphInputsForFixture,
  runDojoVivariumScenario,
  runDojoWindTunnel,
} from "../browser/dojo_vivarium.js";
import type { DojoMaterializedScenario } from "../dojo/vivarium/runner.js";
import { explainDojoRuntimeRefusal } from "../dojo/case_law/refusal.js";
import { bindCaseLawGuardrailsToGraph } from "../dojo/case_law/guardrail_synthesizer.js";
import type { DojoCaseLawRecord } from "../dojo/case_law/registry.js";
import { decideDojoEntrustment } from "../dojo/checkride/entrustment.js";
import { decideDojoSkillReadiness } from "../dojo/checkride/readiness.js";
import { runDojoExecutableCheckride, type DojoExecutableCheckrideReport } from "../dojo/checkride/runner.js";
import {
  authorizeDojoGovernanceAction,
  buildDojoComplianceEvidenceArchiveManifest,
  buildDojoGovernanceServiceView,
  decideDojoCaseLawReview,
  decideDojoPermissionUpgradeRequest,
  persistDojoScheduledJobRunAuditEvents,
  revokeDojoSkillLicense,
  runDojoScheduledGovernanceJobs,
  type DojoGovernanceRbacAction,
  type DojoGovernanceServiceView,
  type DojoGovernanceScheduledJobHandlers,
  type DojoGovernanceScheduledJobKind,
} from "../dojo/governance/service.js";
import { compileDojoSkillGraphForSkill, compileDojoSkillGraphFromContract } from "../dojo/graph/compiler.js";
import { validateDojoSkillGraph, type DojoSkillGraph } from "../dojo/graph/types.js";
import {
  contextKeyForDojoGuardrailPredicate,
  normalizeDojoGuardrailPredicate,
} from "../dojo/graph/guardrail_predicates.js";
import { DojoSkillGraphRuntime, type DojoGraphRunResult } from "../dojo/graph/runtime.js";
import {
  DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV,
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
  resolveDojoControlPlaneStoreConfig,
  resolveDojoEnforcementConfig,
  resolveDojoEvidenceLedgerStoreConfig,
} from "../dojo/config/enforcement.js";
import { createDojoControlPlaneStoresFromEnv } from "../dojo/store/control_plane_resolver.js";
import {
  resolveDojoEvidenceLedgerAppendStore,
  resolveDojoEvidenceLedgerRecords,
  type DojoEvidenceLedgerAppendStore,
} from "../dojo/evidence/ledger_resolver.js";
import {
  DOJO_SUPPORTED_EVIDENCE_CLAIMS,
  type DojoEvidenceClaimId,
  type DojoEvidenceClaimResult,
} from "../dojo/evidence/claims.js";
import { resolveDojoEvidenceClaims } from "../dojo/evidence/verifier.js";
import type { DojoEvidenceLedgerRecord } from "../dojo/evidence/types.js";
import { buildDojoProofKeyRecord, type DojoProofKeyRecord } from "../dojo/proof/key_registry.js";
import { buildDojoProofPublicVerificationBundle } from "../dojo/proof/public_verification_export.js";
import type { DojoProofVerifier } from "../dojo/proof/signing.js";
import { normalizeDojoProofErrorCodes } from "../dojo/proof/errors.js";
import {
  type DojoHostedRuntimeActionDecision,
  type DojoHostedRuntimeEvidenceWriter,
  type DojoHostedRuntimeSessionRecord,
} from "../dojo/runtime/hosted_runtime_gateway.js";
import {
  createDojoHostedRuntimeGatewayFromEnv,
  type DojoHostedRuntimeGatewayResolution,
} from "../dojo/runtime/hosted_runtime_gateway_resolver.js";
import { buildDojoImplementationMetadata } from "../dojo/status/implementation_status.js";
import { hardenDojoEvilTwinAttacks, runDojoEvilTwin } from "../dojo/vivarium/evil_twin.js";
import {
  toDojoScenarioDefinitions,
  validateDojoScenarioDefinition,
  type DojoScenarioExpectedOutcome,
} from "../dojo/vivarium/scenario_dsl.js";
import { buildDojoGeneratedSourcePatchBundle, type DojoSourcePatchInputFile } from "../dojo/source/patch_bundle.js";
import {
  buildDojoGeneratedPrBranchPlan,
  buildDojoGeneratedPrMetadata,
  type DojoGeneratedPrArtifactRef,
  type DojoGeneratedPrCodeOwnerRule,
} from "../dojo/source/pr_generator.js";
import { applyDojoGeneratedPrBranchPlan } from "../dojo/source/pr_branch_applier.js";
import { createDojoGeneratedPrGitBranch } from "../dojo/source/pr_branch_git.js";
import {
  buildDojoSourceSnapshot,
  verifyDojoSourceSnapshot,
  type DojoSourceSnapshot,
  type DojoSourceTokenSnapshot,
} from "../dojo/source/source_snapshot.js";
import {
  applyDojoSourceDriftExpiry,
  buildDojoSourceDriftRecertificationHandoff,
  detectDojoSourceDrift,
  sourceDriftExpiredLicenseReason,
  sourceDriftRecertificationTriggerId,
  type DojoGraphNodeSourceBinding,
  type DojoSourceDriftExpiredSkillUpdate,
  type DojoSourceDriftExpiryApplication,
  type DojoSourceDriftRecertificationSkillInfo,
  type DojoSourceDriftReport,
} from "../dojo/source/source_drift.js";
import {
  inferDojoApiEndpointCandidateFromTrace,
  reviewDojoApiEndpointCandidate,
  type DojoNetworkTraceEndpointInput,
} from "../dojo/api/endpoint_inference.js";
import {
  compileDojoApiBackedMcpTool,
  executeDojoApiBackedToolInvocation,
  validateDojoApiBackedToolInvocation,
  type DojoApiBackedMcpTool,
  type DojoApiToolExecutionEvidence,
  type DojoApiToolHttpRequest,
  type DojoApiToolHttpResponse,
} from "../dojo/api/api_tool_compiler.js";
import type {
  DojoApiEndpointCandidate,
  DojoApiMethod,
  DojoApiMutationClass,
  DojoApiReviewStatus,
} from "../dojo/api/types.js";
import type {
  DojoAuditActor,
  DojoAuditEventRecord,
  DojoAuditStore,
  DojoGhostShadowEvidenceRecord,
  DojoLicenseStore,
  DojoPermissionLicenseRecord,
  DojoPermissionUpgradeRequestRecord,
  DojoProofCapsuleRecord,
  DojoProofConsumeResult,
  DojoStoredLicenseStatus,
} from "../dojo/store/interfaces.js";
import { PostgresDojoSkillStore } from "../dojo/store/postgres_skill_store.js";
import { buildDojoMcpSkillManifest } from "../dojo/mcp/manifest_signing.js";
import {
  blockDojoMcpSkillBusExecution,
  createInProcessDojoMcpSkillBus,
  createLegacyDojoTenantContext,
  type DojoToolDispatchResult,
  type DojoToolResolution,
} from "../dojo/mcp/skill_bus.js";
import type { DojoTenantContext } from "../dojo/mcp/execution_policy_gate.js";
import type { BrowserWorkflowArtifact } from "../browser/broker.js";
import type { WorkflowContractV7 } from "../browser/workflow.js";
import { ADVERTISED_TOOLS } from "../tool_registry.js";
import {
  dispatchBrowserPrivateWorkflowToolAfterDojoProof,
  validateBrowserRuntimeAttachmentForDojoProof,
  type DojoValidatedBrowserWorkflowContext,
} from "./browser.js";
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
  "synthi_dojo_capture_source_snapshot",
  "synthi_dojo_detect_source_drift",
  "synthi_dojo_apply_source_drift_expiry",
  "synthi_dojo_get_source_affordance_pr_plan",
  "synthi_dojo_prepare_source_affordance_pr",
  "synthi_dojo_create_source_affordance_pr_branch",
  "synthi_dojo_prepare_api_backed_tool",
  "synthi_dojo_run_api_backed_tool",
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
  "synthi_dojo_run_scheduled_governance_jobs",
  "synthi_dojo_generate_vivarium_scenarios",
  "synthi_dojo_run_vivarium_scenario",
  "synthi_dojo_run_wind_tunnel",
  "synthi_dojo_run_evil_twin",
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
  "synthi_dojo_create_hosted_runtime_session",
  "synthi_dojo_run_with_proof_capsule",
] as const;

const dojoHostedRuntimeAuditStore: DojoAuditStore = {
  appendAuditEvent: (event) => dojoSkillRegistry.recordAuditEvent(event),
  listAuditEvents: (filter) => dojoSkillRegistry.listAuditEvents(filter),
};
const dojoHostedRuntimeEvidenceWriter: DojoHostedRuntimeEvidenceWriter = {
  async appendRuntimeActionEvidence(input) {
    const enforcement = resolveDojoEnforcementConfig();
    const evidenceLedgerRequired = enforcement.production_enforcement && enforcement.require_evidence_ledger;
    const artifactPayload = JSON.stringify({
      tenant_id: input.tenant.tenant_id,
      workspace_id: input.tenant.workspace_id,
      session_id: input.session.session_id,
      runtime_id: input.session.runtime_id,
      skill_id: input.session.skill_id,
      run_id: input.session.run_id,
      action_kind: input.action_kind,
      url: input.url,
      url_origin: input.url_origin,
      created_at: input.created_at,
      details: input.details ?? {},
      evidence_index: input.session.evidence_refs.length,
    });
    const artifactSha = sha256String(artifactPayload);
    const recordId = `dojo_runtime_action_evidence_${hashId([
      input.tenant.tenant_id,
      input.tenant.workspace_id,
      input.session.session_id,
      input.session.run_id,
      input.action_kind,
      input.created_at,
      String(input.session.evidence_refs.length),
      artifactSha,
    ].join(":"))}`;
    if (evidenceLedgerRequired) {
      const resolution = await resolveDojoEvidenceLedgerAppendStore({
        tenant_id: input.tenant.tenant_id,
        workspace_id: input.tenant.workspace_id,
        tenant_context: input.tenant,
        app_origin: input.session.workspace_origin,
      });
      if (!resolution.ok || !resolution.evidence_ledger) {
        await resolution.close?.().catch(() => undefined);
        throw new Error(`dojo_hosted_runtime_evidence_ledger_required:${resolution.blocked_by.join(",")}`);
      }
      try {
        const redactionManifestSha = sha256String(JSON.stringify({
          artifact_sha256: artifactSha,
          redaction_policy: "digest_only",
          raw_payload_stored: false,
        }));
        const record = await resolution.evidence_ledger.append({
          record_id: recordId,
          skill_id: input.session.skill_id,
          run_id: input.session.run_id,
          kind: "artifact",
          artifact_uri: `dojo://hosted-runtime-action/${encodeURIComponent(input.session.session_id)}/${encodeURIComponent(input.action_kind)}`,
          artifact_sha256: artifactSha,
          redaction_manifest_sha256: redactionManifestSha,
          claim_ids: [
            "runtime_action_authorized",
            "runtime_session_bound",
            "workspace_verified",
          ],
          created_at: input.created_at,
          created_by: input.tenant.actor_id,
          retention_class: "standard",
          source_refs: dedupeStrings([
            `runtime_session:${input.session.session_id}`,
            `runtime:${input.session.runtime_id}`,
            `run:${input.session.run_id}`,
            `skill:${input.session.skill_id}`,
            `runtime_action:${input.action_kind}`,
            `workspace_origin:${input.session.workspace_origin}`,
            `url_origin:${input.url_origin}`,
          ]),
        });
        return {
          record_id: record.record_id,
          evidence_ref: `evidence:${record.record_id}`,
        };
      } finally {
        await resolution.close?.().catch(() => undefined);
      }
    }
    return {
      record_id: recordId,
      evidence_ref: `evidence:${recordId}`,
    };
  },
};
let dojoHostedRuntimeGatewayCache: {
  key: string;
  resolution: DojoHostedRuntimeGatewayResolution;
} | null = null;

async function dojoHostedRuntimeGatewayResolutionForTools(): Promise<DojoHostedRuntimeGatewayResolution> {
  const key = dojoHostedRuntimeGatewayCacheKey(process.env);
  if (dojoHostedRuntimeGatewayCache?.key === key) return dojoHostedRuntimeGatewayCache.resolution;
  const previous = dojoHostedRuntimeGatewayCache?.resolution;
  if (previous?.ok && previous.close) {
    await previous.close().catch(() => undefined);
  }
  const resolution = await createDojoHostedRuntimeGatewayFromEnv({
    audit_store: dojoHostedRuntimeAuditStore,
    evidence_writer: dojoHostedRuntimeEvidenceWriter,
  });
  dojoHostedRuntimeGatewayCache = { key, resolution };
  return resolution;
}

function dojoHostedRuntimeGatewayCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    production_enforcement: env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT ?? "",
    require_durable_store: env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE ?? "",
    require_evidence_ledger: env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER ?? "",
    control_plane_store: env.SYNTHI_DOJO_CONTROL_PLANE_STORE ?? "",
    control_plane_postgres_url: env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL ?? "",
    evidence_ledger_store: env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE ?? "",
    evidence_ledger_postgres_url: env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL ?? "",
  });
}

function requireDojoDurableControlPlaneWrite(
  operation: string,
  options: { postgres_wired?: boolean } = {}
): { ok: true } | { ok: false; error: ToolResponse } {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) return { ok: true };

  const storeConfig = resolveDojoControlPlaneStoreConfig();
  if (options.postgres_wired && storeConfig.store_kind === "postgres" && storeConfig.production_capable) {
    return { ok: true };
  }
  const runtimeWiringBlock = storeConfig.production_capable
    ? ["dojo_control_plane_registry_postgres_adapter_not_wired"]
    : ["dojo_control_plane_store_not_production_capable"];
  const blockedBy = [...new Set([...runtimeWiringBlock, ...storeConfig.blocked_by])];

  return {
    ok: false,
    error: errorResponse("dojo_control_plane_store_not_runtime_wired", {
      ok: false,
      operation,
      enforcement_mode: enforcement.enforcement_mode,
      store_kind: storeConfig.store_kind,
      configured: storeConfig.configured,
      durable: storeConfig.durable,
      production_capable: storeConfig.production_capable,
      configured_env: [...new Set([...enforcement.configured_env, ...storeConfig.configured_env])],
      required_env: [
        "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1",
        "SYNTHI_DOJO_REQUIRE_DURABLE_STORE=1",
        "SYNTHI_DOJO_CONTROL_PLANE_STORE=postgres",
        "SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL",
      ],
      blocked_by: blockedBy,
      error_codes: ["dojo_control_plane_store_not_runtime_wired"],
      message: "Production Dojo control-plane writes require a wired durable registry store. The compatibility registry is not accepted for production writes.",
    }),
  };
}

async function listDurableDojoSkillsForTenantIfRequired(
  tenant: DojoTenantContext,
  operation = "synthi_dojo_list_competencies"
): Promise<{ ok: true; skills?: DojoSkill[]; source: "compatibility_registry" | "postgres" } | { ok: false; error: ToolResponse }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true, source: "compatibility_registry" };
  }

  const resolution = await createDojoControlPlaneStoresFromEnv({ tenant });
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError(operation, resolution),
    };
  }
  try {
    const skills = await resolution.skill_store.listSkills({ status: "published" });
    return { ok: true, skills, source: "postgres" };
  } finally {
    await resolution.close?.();
  }
}

async function persistPublishedSkillToDurableControlPlaneIfRequired(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  actor: DojoAuditActor;
  now: string;
}): Promise<{ ok: true; persistence?: Record<string, unknown> } | { ok: false; error: ToolResponse }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true };
  }

  let resolution: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>>;
  try {
    resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: input.tenant,
      app_origin: input.skill.app_origin,
    });
  } catch (err) {
    return {
      ok: false,
      error: errorResponse("dojo_control_plane_persistence_failed", {
        ok: false,
        operation: "synthi_dojo_publish_skill",
        store_kind: "postgres",
        skill_id: input.skill.skill_id,
        workflow_id: input.skill.workflow_id,
        license_id: input.skill.permission_license.license_id,
        message: err instanceof Error ? err.message : String(err),
        blocked_by: ["dojo_control_plane_postgres_persistence_failed"],
        error_codes: ["dojo_control_plane_persistence_failed"],
      }),
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError("synthi_dojo_publish_skill", resolution),
    };
  }

  try {
    const skillRecord = await resolution.skill_store.saveSkill(input.skill, {
      status: "published",
      created_by: input.actor,
      now: input.now,
    });
    const licenseRecord = await resolution.license_store.saveLicense(input.skill.permission_license, {
      readiness_level: input.skill.skill_readiness_level,
      status: "active",
      expires_at: input.skill.license_expires_at,
      created_by: input.actor,
      now: input.now,
    });
    return {
      ok: true,
      persistence: {
        ok: true,
        store_kind: "postgres",
        skill_id: skillRecord.skill_id,
        skill_version: skillRecord.current_skill_version,
        workflow_id: skillRecord.workflow_id,
        workspace_id: skillRecord.workspace_id,
        license_id: licenseRecord.license_id,
        license_version: licenseRecord.license_version,
        status: skillRecord.status,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: errorResponse("dojo_control_plane_persistence_failed", {
        ok: false,
        operation: "synthi_dojo_publish_skill",
        store_kind: "postgres",
        skill_id: input.skill.skill_id,
        workflow_id: input.skill.workflow_id,
        license_id: input.skill.permission_license.license_id,
        message: err instanceof Error ? err.message : String(err),
        blocked_by: ["dojo_control_plane_postgres_persistence_failed"],
        error_codes: ["dojo_control_plane_persistence_failed"],
      }),
    };
  } finally {
    await resolution.close?.();
  }
}

async function persistVivariumRunsToDurableControlPlaneIfRequired(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  updated_skill: DojoSkill;
  runs: Awaited<ReturnType<typeof runDojoVivariumScenario>>[];
  operation: string;
  now: string;
}): Promise<{ ok: true; persistence?: Record<string, unknown> } | { ok: false; error: ToolResponse }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true };
  }

  const resolution = await createDojoControlPlaneStoresFromEnv({
    tenant: input.tenant,
    app_origin: input.skill.app_origin,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError(input.operation, resolution),
    };
  }

  try {
    const scenarioRecords = [];
    for (const run of input.runs) {
      scenarioRecords.push(await resolution.graph_run_store.saveVivariumScenarioRun(run, {
        skill_id: input.skill.skill_id,
        started_at: run.run.started_at,
        completed_at: run.run.finished_at,
        created_by: input.tenant.actor_id,
      }));
    }
    const skillRecord = await resolution.skill_store.saveSkill(input.updated_skill, {
      status: "published",
      created_by: {
        actor_id: input.tenant.actor_id,
        actor_type: input.tenant.actor_type,
      },
      now: input.now,
    });
    return {
      ok: true,
      persistence: {
        ok: true,
        store_kind: "postgres",
        operation: input.operation,
        skill_id: skillRecord.skill_id,
        skill_version: skillRecord.current_skill_version,
        workflow_id: skillRecord.workflow_id,
        workspace_id: skillRecord.workspace_id,
        scenario_run_ids: scenarioRecords.map((record) => record.scenario_run_id),
        persisted_run_count: scenarioRecords.length,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: errorResponse("dojo_control_plane_persistence_failed", {
        ok: false,
        operation: input.operation,
        store_kind: "postgres",
        skill_id: input.skill.skill_id,
        workflow_id: input.skill.workflow_id,
        message: err instanceof Error ? err.message : String(err),
        blocked_by: ["dojo_control_plane_postgres_persistence_failed"],
        error_codes: ["dojo_control_plane_persistence_failed"],
      }),
    };
  } finally {
    await resolution.close?.();
  }
}

type DojoDurableProofRegistryContext =
  | { required: false }
  | {
    required: true;
    source: "postgres";
    proof_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
      ? T extends { ok: true; proof_store: infer Store } ? Store : never
      : never;
    proof_key_registry: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
      ? T extends { ok: true; proof_key_registry: infer Store } ? Store : never
      : never;
    skill_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
      ? T extends { ok: true; skill_store: infer Store } ? Store : never
      : never;
    license_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
      ? T extends { ok: true; license_store: infer Store } ? Store : never
      : never;
    graph_run_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
      ? T extends { ok: true; graph_run_store: infer Store } ? Store : never
      : never;
    close?: () => Promise<void>;
  };

type DojoDurablePermissionUpgradeReviewContext = {
  source: "postgres";
  tenant: DojoTenantContext;
  request: DojoPermissionUpgradeRequestRecord;
  skill: DojoSkill;
  governance_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
    ? T extends { ok: true; governance_store: infer Store } ? Store : never
    : never;
  skill_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
    ? T extends { ok: true; skill_store: infer Store } ? Store : never
    : never;
  license_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
    ? T extends { ok: true; license_store: infer Store } ? Store : never
    : never;
  close?: () => Promise<void>;
};

type DojoDurableCaseLawReviewContext = {
  source: "postgres";
  tenant: DojoTenantContext;
  record: DojoCaseLawRecord;
  skill: DojoSkill;
  governance_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
    ? T extends { ok: true; governance_store: infer Store } ? Store : never
    : never;
  skill_store: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> extends infer T
    ? T extends { ok: true; skill_store: infer Store } ? Store : never
    : never;
  close?: () => Promise<void>;
};

async function durableProofRegistryForTenantIfRequired(input: {
  tenant: DojoTenantContext;
  operation: string;
  app_origin?: string;
}): Promise<{ ok: true; context: DojoDurableProofRegistryContext } | { ok: false; error: ToolResponse }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true, context: { required: false } };
  }

  let resolution: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>>;
  try {
    resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: input.tenant,
      app_origin: input.app_origin,
    });
  } catch (err) {
    return {
      ok: false,
      error: errorResponse("dojo_control_plane_store_not_runtime_wired", {
        ok: false,
        operation: input.operation,
        store_kind: "postgres",
        production_capable: true,
        blocked_by: ["dojo_control_plane_store_resolution_failed"],
        error_codes: ["dojo_control_plane_store_not_runtime_wired"],
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError(input.operation, resolution),
    };
  }

  return {
    ok: true,
    context: {
      required: true,
      source: "postgres",
      proof_store: resolution.proof_store,
      proof_key_registry: resolution.proof_key_registry,
      skill_store: resolution.skill_store,
      license_store: resolution.license_store,
      graph_run_store: resolution.graph_run_store,
      close: resolution.close,
    },
  };
}

type DojoProofValidationOptions = {
  now?: string;
  issuer?: string;
  expected_key_id?: string;
  verifier?: DojoProofVerifier | null;
};

async function persistDurableProofKeyForCapsule(input: {
  context: DojoDurableProofRegistryContext;
  tenant: DojoTenantContext;
  capsule: DojoProofCarryingSkillCapsule;
  operation: string;
}): Promise<{ ok: true; proof_key?: ReturnType<typeof proofKeyPublicView> } | { ok: false; error: ToolResponse }> {
  if (!input.context.required) return { ok: true };
  if (input.capsule.signature_algorithm !== "ed25519") return { ok: true };

  const publicKeyPem = process.env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV]?.trim();
  if (!publicKeyPem) {
    const blockedBy = ["proof_key_public_key_missing"];
    return {
      ok: false,
      error: errorResponse("dojo_proof_key_public_key_required", {
        ok: false,
        operation: input.operation,
        capsule_id: input.capsule.capsule_id,
        key_id: input.capsule.key_id,
        signature_algorithm: input.capsule.signature_algorithm,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
      }),
    };
  }

  try {
    const custody = proofKeyCustodyMetadataForCurrentSigner();
    const proofKey = await input.context.proof_key_registry.upsert(buildDojoProofKeyRecord({
      tenant_id: input.tenant.tenant_id,
      key_id: input.capsule.key_id,
      issuer: input.capsule.issuer,
      algorithm: input.capsule.signature_algorithm,
      signing_provider: custody.signing_provider,
      key_custody: custody.key_custody,
      ...(custody.key_uri ? { key_uri: custody.key_uri } : {}),
      public_key_pem: publicKeyPem,
      status: "active",
      created_at: input.capsule.issued_at,
    }));
    return {
      ok: true,
      proof_key: proofKeyPublicView(proofKey),
    };
  } catch (err) {
    const blockedBy = ["proof_key_registry_write_failed"];
    return {
      ok: false,
      error: errorResponse("dojo_proof_key_registry_write_failed", {
        ok: false,
        operation: input.operation,
        capsule_id: input.capsule.capsule_id,
        key_id: input.capsule.key_id,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

async function durableProofValidationOptionsForCapsule(input: {
  context: DojoDurableProofRegistryContext;
  tenant: DojoTenantContext;
  capsule: DojoProofCarryingSkillCapsule;
  operation: string;
  now?: string;
  allow_forensic_verification?: boolean;
}): Promise<
  | { ok: true; options: DojoProofValidationOptions; proof_key?: ReturnType<typeof proofKeyPublicView> }
  | { ok: false; error: ToolResponse }
> {
  if (!input.context.required || input.capsule.signature_algorithm !== "ed25519") {
    return { ok: true, options: { now: input.now } };
  }

  const resolution = await input.context.proof_key_registry.resolveVerifier({
    tenant_id: input.tenant.tenant_id,
    key_id: input.capsule.key_id,
    allow_forensic_verification: input.allow_forensic_verification,
  });
  if (!resolution.ok || !resolution.key || !resolution.verifier) {
    const blockedBy = resolution.blocked_by.length > 0
      ? resolution.blocked_by
      : ["proof_key_public_verifier_unavailable"];
    return {
      ok: false,
      error: errorResponse("dojo_proof_key_verifier_unavailable", {
        ok: false,
        operation: input.operation,
        capsule_id: input.capsule.capsule_id,
        key_id: input.capsule.key_id,
        signature_algorithm: input.capsule.signature_algorithm,
        proof_key: resolution.key ? proofKeyPublicView(resolution.key) : null,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
      }),
    };
  }

  return {
    ok: true,
    options: {
      now: input.now,
      issuer: resolution.key.issuer,
      expected_key_id: resolution.key.key_id,
      verifier: resolution.verifier,
    },
    proof_key: proofKeyPublicView(resolution.key),
  };
}

function proofKeyPublicView(record: {
  key_id: string;
  issuer: string;
  algorithm: string;
  signing_provider?: string;
  key_custody?: string;
  key_uri?: string;
  status: string;
  created_at: string;
  rotated_at?: string;
  revoked_at?: string;
  retain_for_forensic_verification?: boolean;
}): {
  key_id: string;
  issuer: string;
  algorithm: string;
  signing_provider: string;
  key_custody: string;
  key_uri?: string;
  status: string;
  created_at: string;
  rotated_at?: string;
  revoked_at?: string;
  retain_for_forensic_verification: boolean;
} {
  return {
    key_id: record.key_id,
    issuer: record.issuer,
    algorithm: record.algorithm,
    signing_provider: record.signing_provider ?? "unknown",
    key_custody: record.key_custody ?? "unspecified",
    ...(record.key_uri ? { key_uri: record.key_uri } : {}),
    status: record.status,
    created_at: record.created_at,
    ...(record.rotated_at ? { rotated_at: record.rotated_at } : {}),
    ...(record.revoked_at ? { revoked_at: record.revoked_at } : {}),
    retain_for_forensic_verification: record.retain_for_forensic_verification === true,
  };
}

function proofKeyCustodyMetadataForCurrentSigner(): Pick<DojoProofKeyRecord, "signing_provider" | "key_custody" | "key_uri"> {
  const provider = process.env[DOJO_PROOF_SIGNING_PROVIDER_ENV]?.trim() || "hmac-local";
  if (provider === "managed-key-service") {
    const keyUri = process.env[DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV]?.trim();
    return {
      signing_provider: "managed-key-service",
      key_custody: "managed",
      ...(keyUri ? { key_uri: keyUri } : {}),
    };
  }
  if (provider === "external-command") {
    return {
      signing_provider: "external-command",
      key_custody: "external",
    };
  }
  if (provider === "ed25519-local") {
    return {
      signing_provider: "ed25519-local",
      key_custody: "local",
    };
  }
  if (provider === "hmac-local") {
    return {
      signing_provider: "hmac-local",
      key_custody: "local",
    };
  }
  return {
    signing_provider: "unknown",
    key_custody: "unspecified",
  };
}

async function permissionUpgradeReviewContextFromDurableControlPlaneIfRequired(
  args: unknown,
  requestId: string
): Promise<
  | { ok: true; context?: DojoDurablePermissionUpgradeReviewContext }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true };
  }

  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext;
  const resolution = await createDojoControlPlaneStoresFromEnv({
    tenant: tenantContext.tenant,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError("synthi_dojo_review_permission_upgrade", resolution),
    };
  }

  try {
    const request = (await resolution.governance_store.listPermissionUpgradeRequests({
      request_id: requestId,
      limit: 1,
    }))[0];
    if (!request) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_permission_upgrade_request_not_found", {
          request_id: requestId,
          control_plane_source: "postgres",
        }),
      };
    }
    const skill = await resolution.skill_store.getSkill(request.skill_id);
    if (!skill) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_permission_upgrade_skill_not_found", {
          request_id: requestId,
          skill_id: request.skill_id,
          control_plane_source: "postgres",
        }),
      };
    }
    if (!isTenantAuthorizedForDojoSkill(tenantContext.tenant, skill)) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_skill_not_authorized", {
          ok: false,
          skill_id: skill.skill_id,
          workspace_id: skill.workspace_id,
          tenant_workspace_id: tenantContext.tenant.workspace_id,
          actor_id: tenantContext.tenant.actor_id,
          control_plane_source: "postgres",
          blocked_by: ["dojo_skill_workspace_mismatch"],
          required_roles: ["dojo:admin", "dojo:operator"],
        }),
      };
    }

    return {
      ok: true,
      context: {
        source: "postgres",
        tenant: tenantContext.tenant,
        request,
        skill,
        governance_store: resolution.governance_store,
        skill_store: resolution.skill_store,
        license_store: resolution.license_store,
        close: resolution.close,
      },
    };
  } catch (err) {
    await resolution.close?.();
    throw err;
  }
}

async function caseLawReviewContextFromDurableControlPlaneIfRequired(
  args: unknown,
  caseId: string
): Promise<
  | { ok: true; context?: DojoDurableCaseLawReviewContext }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true };
  }

  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext;
  const resolution = await createDojoControlPlaneStoresFromEnv({
    tenant: tenantContext.tenant,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError("synthi_dojo_review_case_law", resolution),
    };
  }

  try {
    const record = await resolution.governance_store.getCaseLawRecord(caseId);
    if (!record) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_case_law_not_found", {
          case_id: caseId,
          control_plane_source: "postgres",
        }),
      };
    }

    const requested = obj(args);
    const explicitSkillId = stringOpt(requested["skill_id"]);
    const explicitWorkflowId = stringOpt(requested["workflow_id"]);
    let skill: DojoSkill | null = null;
    if (explicitSkillId) {
      skill = await resolution.skill_store.getSkill(explicitSkillId);
    } else if (explicitWorkflowId) {
      skill = await resolution.skill_store.getSkillByWorkflowId(explicitWorkflowId);
    } else if (record.binding_scope.kind === "skill") {
      skill = await resolution.skill_store.getSkill(record.binding_scope.id);
    } else {
      const visibleSkills = await resolution.skill_store.listSkills();
      skill = visibleSkills
        .sort((left, right) => left.skill_id.localeCompare(right.skill_id))
        .find((candidate) => caseLawRecordAppliesToSkill(record, candidate))
        ?? null;
    }
    if (!skill) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_case_law_skill_not_found", {
          case_id: caseId,
          skill_id: explicitSkillId ?? null,
          workflow_id: explicitWorkflowId ?? null,
          binding_scope: record.binding_scope,
          control_plane_source: "postgres",
        }),
      };
    }
    if (!isTenantAuthorizedForDojoSkill(tenantContext.tenant, skill)) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_skill_not_authorized", {
          ok: false,
          skill_id: skill.skill_id,
          workspace_id: skill.workspace_id,
          tenant_workspace_id: tenantContext.tenant.workspace_id,
          actor_id: tenantContext.tenant.actor_id,
          control_plane_source: "postgres",
          blocked_by: ["dojo_skill_workspace_mismatch"],
          required_roles: ["dojo:admin", "dojo:operator"],
        }),
      };
    }
    if (!caseLawRecordAppliesToSkill(record, skill)) {
      await resolution.close?.();
      return {
        ok: false,
        error: errorResponse("dojo_case_law_not_authorized", {
          ok: false,
          case_id: record.case_id,
          skill_id: skill.skill_id,
          binding_scope: record.binding_scope,
          tenant_workspace_id: tenantContext.tenant.workspace_id,
          actor_id: tenantContext.tenant.actor_id,
          control_plane_source: "postgres",
          blocked_by: ["dojo_case_law_scope_mismatch"],
        }),
      };
    }

    return {
      ok: true,
      context: {
        source: "postgres",
        tenant: tenantContext.tenant,
        record,
        skill,
        governance_store: resolution.governance_store,
        skill_store: resolution.skill_store,
        close: resolution.close,
      },
    };
  } catch (err) {
    await resolution.close?.();
    throw err;
  }
}

function proofRecordForCapsule(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  capsule: DojoProofCarryingSkillCapsule;
  issued_by?: DojoAuditActor;
}): DojoProofCapsuleRecord {
  return {
    tenant_id: input.tenant.tenant_id,
    workspace_id: input.skill.workspace_id,
    capsule_id: input.capsule.capsule_id,
    skill_id: input.capsule.skill_id,
    license_id: input.skill.permission_license.license_id,
    license_version: input.capsule.license_version,
    requested_action: input.capsule.requested_action,
    nonce: input.capsule.nonce,
    key_id: input.capsule.key_id,
    signature_algorithm: input.capsule.signature_algorithm,
    substrate_claim: input.capsule.substrate_claim,
    evidence_record_ids: [...input.capsule.evidence_record_ids],
    ...(input.capsule.ledger_checkpoint_hash ? { ledger_checkpoint_hash: input.capsule.ledger_checkpoint_hash } : {}),
    issued_at: input.capsule.issued_at,
    expires_at: input.capsule.expires_at,
    status: "issued",
    ...(input.issued_by ? { issued_by: input.issued_by } : {}),
  };
}

function controlPlaneResolutionError(
  operation: string,
  resolution: Extract<Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>>, { ok: false }>
): ToolResponse {
  return errorResponse("dojo_control_plane_store_not_runtime_wired", {
    ok: false,
    operation,
    store_kind: resolution.store_kind,
    production_capable: resolution.production_capable,
    configured_env: resolution.configured_env,
    blocked_by: resolution.blocked_by,
    error_codes: ["dojo_control_plane_store_not_runtime_wired"],
  });
}

const DOJO_TENANT_CONTEXT_INPUT_PROPERTIES = {
  tenant_id: { type: "string" },
  organization_id: { type: "string" },
  workspace_id: { type: "string" },
  actor_id: { type: "string" },
  actor_type: { type: "string", enum: ["human", "agent", "service"] },
  roles: { type: "array", items: { type: "string" } },
  request_id: { type: "string" },
  correlation_id: { type: "string" },
} as const;

const DOJO_SKILL_SELECTION_INPUT_PROPERTIES = {
  skill_id: { type: "string" },
  workflow_id: { type: "string" },
} as const;

const DOJO_SKILL_SCOPED_INPUT_PROPERTIES = {
  ...DOJO_SKILL_SELECTION_INPUT_PROPERTIES,
  ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
} as const;

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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_skill_cortex",
    description: "Return the source-aware Skill Cortex graph: typed workflow nodes, learned transitions, guardrail refs, node memory, and expiry nodes.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_workspace_organoid",
    description: "Return the synthetic Workspace Organoid manifest used by Dojo to practice this skill without production data.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_wind_tunnel_report",
    description: "Return the Workflow Wind Tunnel runs and scenario summary for a Dojo skill.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_counterfactual_twin",
    description: "Return counterfactual twin variants, observed outcomes, and promoted scenarios for a Dojo skill.",
    inputSchema: {
      type: "object",
      properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES, scenario_id: { type: "string" }, mutation_kind: { type: "string" } },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_evil_twin_report",
    description: "Return adversarial Evil Twin attacks, caught/escaped status, hardened guardrails, and attack success rate.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_training_report",
    description: "Return the Dojo training report that ties wind-tunnel runs, checkride, evil twin, guardrails, antibodies, and readiness decision together.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_skill_passport",
    description: "Return the compact Skill Passport for UI badges and agent preflight checks.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_skill_genome",
    description: "Return the shareable Skill Genome pattern without raw screenshots, secrets, workspace data, or production payloads.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_antibodies",
    description: "Return negative-memory antibodies derived from failed or blocked scenarios and their guardrail responses.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_agent_ready_ui_contract",
    description: "Return the agent-ready UI contract: stable locators, source anchors, required inputs, proof claims, and refusal contracts.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_cost_policy",
    description: "Return the Dojo cost-control policy for scenario budgets, tier use, stop conditions, and recertification triggers.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_universe_dossier",
    description:
      "Return the full Vivarium Cortex dossier for a skill: lifecycle, governance, metrics, evidence ledger, source-affordance PR plan, package readiness, and time-machine debug summary.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        question: { type: "string" },
        mutation_kind: { type: "string" },
        package_readiness_evidence: {
          type: "object",
          description:
            "Optional parsed synthi.dojo.packageReadinessEvidence.v1 artifact produced by proof:dojo:package-readiness:self-check. The tool summarizes this object but does not read local artifact paths.",
        },
        package_readiness_evidence_path: {
          type: "string",
          description:
            "Optional evidence artifact label/path to display with package_readiness_evidence. This is not read from disk.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_lifecycle",
    description: "Return revocable entrustment lifecycle state, expiry, recertification triggers, and release gates for a Dojo skill.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_governance_report",
    description: "Return approval queue, policy gates, audit report, compliance exports, and review workflows for a Dojo skill.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_get_metrics",
    description: "Return technical, business, and trust metrics across the Dojo skill registry or a single selected skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        workflow_id: { type: "string" },
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_capture_source_snapshot",
    description: "Create and verify a signed, release-scoped Dojo source snapshot from caller-supplied source tokens.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        app_origin: { type: "string" },
        app_version: { type: "string" },
        commit_sha: { type: "string" },
        source_root: { type: "string" },
        signer_key_id: { type: "string" },
        signing_key: { type: "string" },
        created_at: { type: "string" },
        source_tokens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              token_id: { type: "string" },
              route: { type: "string" },
              component: { type: "string" },
              action: { type: "string" },
              source_locator: { type: "string" },
              source_sha256: { type: "string" },
              risk: { type: "string", enum: ["safe", "mutation", "dangerous"] },
            },
            required: ["token_id", "route", "component", "source_locator"],
          },
        },
      },
      required: ["app_origin", "app_version", "commit_sha", "source_root", "signer_key_id", "signing_key", "source_tokens"],
    },
  },
  {
    name: "synthi_dojo_detect_source_drift",
    description: "Verify two signed Dojo source snapshots, detect source-token drift, and report affected graph nodes and license expiry triggers without applying them.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        previous_snapshot: { type: "object" },
        next_snapshot: { type: "object" },
        source_snapshot_signing_keys_by_id: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        node_bindings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              node_id: { type: "string" },
              source_token_ids: { type: "array", items: { type: "string" } },
              license_id: { type: "string" },
            },
            required: ["node_id", "source_token_ids"],
          },
        },
      },
      required: ["previous_snapshot", "next_snapshot", "source_snapshot_signing_keys_by_id", "node_bindings"],
    },
  },
  {
    name: "synthi_dojo_apply_source_drift_expiry",
    description: "Dry-run or apply license expiry triggers from a verified Dojo source-drift report. Defaults to dry-run; production writes require the durable control plane.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        source_drift_report: { type: "object" },
        dry_run: { type: "boolean" },
        now: { type: "string" },
      },
      required: ["source_drift_report"],
    },
  },
  {
    name: "synthi_dojo_get_source_affordance_pr_plan",
    description: "Return a reviewable generated PR plan for adding stable Agent-Ready UI affordances and proof hooks to source files.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_prepare_source_affordance_pr",
    description: "Build a generated source patch bundle, PR metadata, branch plan, and optional dry-run apply result for Agent-Ready UI affordance patches.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        source_files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              source: { type: "string" },
            },
            required: ["path", "source"],
          },
        },
        branch_name: { type: "string" },
        branch_prefix: { type: "string" },
        base_ref: { type: "string" },
        source_snapshot_id: { type: "string" },
        workspace_root: { type: "string" },
        code_owner_rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path_prefix: { type: "string" },
              glob: { type: "string" },
              owners: { type: "array", items: { type: "string" } },
              review_gate: { type: "string" },
            },
            required: ["owners"],
          },
        },
      },
      required: ["source_files"],
    },
  },
  {
    name: "synthi_dojo_create_source_affordance_pr_branch",
    description: "Validate and optionally create a git branch for a generated Agent-Ready UI affordance PR; defaults to dry-run and never opens a remote PR.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        source_files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              source: { type: "string" },
            },
            required: ["path", "source"],
          },
        },
        repository_root: { type: "string" },
        branch_name: { type: "string" },
        branch_prefix: { type: "string" },
        base_ref: { type: "string" },
        source_snapshot_id: { type: "string" },
        dry_run: { type: "boolean" },
        allow_dirty_worktree: { type: "boolean" },
        code_owner_rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path_prefix: { type: "string" },
              glob: { type: "string" },
              owners: { type: "array", items: { type: "string" } },
              review_gate: { type: "string" },
            },
            required: ["owners"],
          },
        },
      },
      required: ["source_files", "repository_root"],
    },
  },
  {
    name: "synthi_dojo_prepare_api_backed_tool",
    description: "Review an API endpoint candidate or network trace and, when all safety gates pass, compile a proof-gated API-backed MCP tool contract without executing the API.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        api_candidate: { type: "object" },
        network_trace: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            request_body: {},
            response_body: {},
            status: { type: "number" },
            source_ref: { type: "string" },
          },
          required: ["method", "url"],
        },
        candidate_overrides: {
          type: "object",
          properties: {
            auth_scope: { type: "string" },
            mutation_class: { type: "string", enum: ["read", "create", "update", "delete", "side_effect"] },
            idempotency_key_location: { type: "string", enum: ["header", "body", "query"] },
            rollback_strategy: { type: "string", enum: ["none", "compensating_call", "delete_draft", "human_review"] },
            postcondition: { type: "string" },
            proof_claim_mapping: { type: "object" },
            review_status: { type: "string", enum: ["candidate", "approved", "rejected"] },
            request_schema: { type: "object" },
            response_schema: { type: "object" },
            query_schema: { type: "object" },
            inferred_from: { type: "array", items: { type: "string" } },
          },
        },
        requested_action: { type: "string" },
        tool_name: { type: "string" },
        tool_version: { type: "string" },
        sample_invocation_args: { type: "object" },
        auth_scopes: { type: "array", items: { type: "string" } },
        publish_to_skill: { type: "boolean" },
        reviewer_actor_id: { type: "string" },
        reviewer_actor_type: { type: "string", enum: ["human", "agent", "service"] },
        review_reason: { type: "string" },
        review_evidence_refs: { type: "array", items: { type: "string" } },
        reviewed_at: { type: "string" },
        now: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_api_backed_tool",
    description: "Dry-run or execute a compiled proof-gated API-backed MCP tool with license/proof validation, idempotency, postcondition checks, and evidence output.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        api_backed_mcp_tool: { type: "object" },
        tool_name: { type: "string" },
        tool_version: { type: "string" },
        tool_args: { type: "object" },
        auth_scopes: { type: "array", items: { type: "string" } },
        dry_run: { type: "boolean" },
        now: { type: "string" },
        mock_response: {
          type: "object",
          properties: {
            status: { type: "number" },
            headers: { type: "object" },
            body: {},
          },
          required: ["status"],
        },
        allow_network_transport: { type: "boolean" },
        api_base_url: { type: "string" },
        request_headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["tool_args"],
    },
  },
  {
    name: "synthi_dojo_get_registry",
    description: "Return the organization-level Dojo skill registry, case-law registry, antibody registry, and aggregate metrics.",
    inputSchema: {
      type: "object",
      properties: { ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES },
      required: [],
    },
  },
  {
    name: "synthi_dojo_get_skill_assurance_case",
    description: "Return the human-readable and machine-readable assurance case for a licensed Dojo skill.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        scenario_id: { type: "string" },
        mutation_kind: { type: "string" },
        now: { type: "string" },
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        requested_action: { type: "string", default: "run_workflow" },
        now: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_review_permission_upgrade",
    description:
      "Approve or deny a stored Dojo permission-upgrade request with reviewer metadata and evidence references. Approved requests create a constrained license-scope update for the requested action.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        request_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "denied"] },
        reviewer_actor_id: { type: "string" },
        reviewer_actor_type: { type: "string", enum: ["human", "agent", "service"] },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        promotion_evidence_claims: {
          type: "array",
          items: { type: "string" },
          description:
            "Non-production compatibility assertion of the evidence claims that support license promotion. In production ledger mode these claims are resolved from evidence_refs instead.",
        },
        decided_at: { type: "string" },
      },
      required: ["request_id", "decision", "reviewer_actor_id", "reviewer_actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_review_case_law",
    description:
      "Approve or deprecate a stored Dojo case-law record with reviewer metadata and evidence references. Approved case law can bind runtime guardrail predicates; deprecated case law is removed from binding lookup.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        case_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "deprecated"] },
        reviewer_actor_id: { type: "string" },
        reviewer_actor_type: { type: "string", enum: ["human", "agent", "service"] },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        superseded_by: { type: "string" },
        decided_at: { type: "string" },
      },
      required: ["case_id", "decision", "reviewer_actor_id", "reviewer_actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_run_scheduled_governance_jobs",
    description:
      "Run ready governance scheduled jobs for the tenant/workspace, using typed handlers and persisting audit events for non-dry runs. Defaults to dry-run and blocks jobs that require external notification or human review.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        job_ids: { type: "array", items: { type: "string" } },
        job_kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "archive_compliance_evidence",
              "expire_stale_license",
              "notify_approver",
              "recompute_registry_metrics",
              "review_case_law",
              "run_recertification",
            ],
          },
        },
        limit: { type: "number" },
        dry_run: { type: "boolean" },
        now: { type: "string" },
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
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        workflow_id: { type: "string" },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: ["reason", "actor_id", "actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_run_vivarium_scenario",
    description: "Materialize and run one synthetic Workspace Organoid scenario for a licensed Dojo skill, returning evidence refs, guardrails, and license checks.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        max_scenarios: { type: "number" },
        now: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "synthi_dojo_run_evil_twin",
    description: "Run targeted Evil Twin attacks against a skill's executable graph inside materialized Vivarium fixtures.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        max_attacks: { type: "number" },
        harden: { type: "boolean" },
        now: { type: "string" },
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
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        workflow_id: { type: "string" },
        now: { type: "string" },
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
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        workflow_id: { type: "string" },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: ["reason", "actor_id", "actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_get_license_health",
    description: "Return combined license lifecycle, governance, proof-record, expiry, and recertification health for a Dojo skill.",
    inputSchema: { type: "object", properties: { ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES }, required: [] },
  },
  {
    name: "synthi_dojo_revoke_license",
    description: "Revoke a Dojo skill license and republish the skill as EX/blocked without deleting its evidence, case law, or repo artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: ["reason", "actor_id", "actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_record_case_law",
    description: "Record a new evidence-backed, failure-derived case-law proposal for a Dojo skill. Runtime guardrails bind only after review approval.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        title: { type: "string" },
        finding: { type: "string" },
        impact: { type: "string" },
        rule: { type: "string" },
        applies_to: { type: "array", items: { type: "string" } },
        binding_scope: { type: "string", enum: ["skill", "workspace", "organization"] },
        evidence_refs: { type: "array", items: { type: "string" } },
        source_run_id: { type: "string" },
        status: { type: "string", enum: ["proposed"] },
      },
      required: ["finding", "rule", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_export_artifacts",
    description:
      "Return reviewable repo artifact files for a licensed Dojo skill, including seed, graph, vivarium, checkride report, assurance case, license, proof schema, guardrails, case law, and MCP manifest. Artifacts contain metadata and references, not secrets.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        requested_action: { type: "string", default: "run_workflow" },
        context_claims: { type: "object" },
        evidence_claims: { type: "array", items: { type: "object" } },
        evidence_ledger_records: { type: "array", items: { type: "object" } },
        evidence_record_ids: { type: "array", items: { type: "string" } },
        evidence_max_age_ms: { type: "number" },
        ledger_checkpoint_hash: { type: "string" },
        require_verified_evidence: { type: "boolean" },
        substrate_claim: { type: "string", enum: ["vision", "dom", "source", "api", "mcp"] },
        now: { type: "string" },
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
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        requested_action: { type: "string", default: "run_workflow" },
        proof_capsule: { type: "object" },
        tool_args: { type: "object" },
        approval_id: { type: "string" },
        approval_status: { type: "string", enum: ["approved", "denied", "pending"] },
        approval_evidence_ref: { type: "string" },
        now: { type: "string" },
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
        ...DOJO_TENANT_CONTEXT_INPUT_PROPERTIES,
        capsule_id: { type: "string" },
        reason: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        now: { type: "string" },
      },
      required: ["capsule_id", "reason", "actor_id", "actor_type", "evidence_refs"],
    },
  },
  {
    name: "synthi_dojo_create_hosted_runtime_session",
    description:
      "Create a tenant-scoped hosted runtime session and short-lived credentials that production proof-gated Dojo execution must authorize before consuming a proof capsule.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        run_id: { type: "string" },
        workspace_url: { type: "string" },
        runtime_id: { type: "string" },
        session_id: { type: "string" },
        origin_allowlist: { type: "array", items: { type: "string" } },
        ttl_ms: { type: "number" },
        credential_ttl_ms: { type: "number" },
        local_network_allowed: { type: "boolean" },
        redact_screenshots: { type: "boolean" },
        sensitive_workspace: { type: "boolean" },
        now: { type: "string" },
      },
      required: ["run_id", "workspace_url", "origin_allowlist"],
    },
  },
  {
    name: "synthi_dojo_run_with_proof_capsule",
    description:
      "Validate a proof-carrying skill capsule against the skill license before dispatching the backing private workflow MCP tool. Production execution also requires hosted runtime session authorization before proof consumption. Use dry_run=true to validate without execution.",
    inputSchema: {
      type: "object",
      properties: {
        ...DOJO_SKILL_SCOPED_INPUT_PROPERTIES,
        requested_action: { type: "string", default: "run_workflow" },
        proof_capsule: { type: "object" },
        tool_args: { type: "object" },
        approval_id: { type: "string" },
        approval_status: { type: "string", enum: ["approved", "denied", "pending"] },
        approval_evidence_ref: { type: "string" },
        dry_run: { type: "boolean" },
        run_id: { type: "string" },
        runtime_session_id: { type: "string" },
        runtime_credential_id: { type: "string" },
        runtime_credential_secret: { type: "string" },
        runtime_action_url: { type: "string" },
        now: { type: "string" },
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
        response = await dojoGetSkillTool(args);
        break;
      case "synthi_dojo_get_skill_cortex":
        response = await dojoGetSkillCortexTool(args);
        break;
      case "synthi_dojo_get_workspace_organoid":
        response = await dojoGetWorkspaceOrganoidTool(args);
        break;
      case "synthi_dojo_get_wind_tunnel_report":
        response = await dojoGetWindTunnelReportTool(args);
        break;
      case "synthi_dojo_get_counterfactual_twin":
        response = await dojoGetCounterfactualTwinTool(args);
        break;
      case "synthi_dojo_get_evil_twin_report":
        response = await dojoGetEvilTwinReportTool(args);
        break;
      case "synthi_dojo_get_training_report":
        response = await dojoGetTrainingReportTool(args);
        break;
      case "synthi_dojo_get_skill_passport":
        response = await dojoGetSkillPassportTool(args);
        break;
      case "synthi_dojo_get_skill_genome":
        response = await dojoGetSkillGenomeTool(args);
        break;
      case "synthi_dojo_get_antibodies":
        response = await dojoGetAntibodiesTool(args);
        break;
      case "synthi_dojo_get_agent_ready_ui_contract":
        response = await dojoGetAgentReadyUiContractTool(args);
        break;
      case "synthi_dojo_get_cost_policy":
        response = await dojoGetCostPolicyTool(args);
        break;
      case "synthi_dojo_get_universe_dossier":
        response = await dojoGetUniverseDossierTool(args);
        break;
      case "synthi_dojo_get_lifecycle":
        response = await dojoGetLifecycleTool(args);
        break;
      case "synthi_dojo_get_governance_report":
        response = await dojoGetGovernanceReportTool(args);
        break;
      case "synthi_dojo_get_metrics":
        response = await dojoGetMetricsTool(args);
        break;
      case "synthi_dojo_capture_source_snapshot":
        response = dojoCaptureSourceSnapshotTool(args);
        break;
      case "synthi_dojo_detect_source_drift":
        response = dojoDetectSourceDriftTool(args);
        break;
      case "synthi_dojo_apply_source_drift_expiry":
        response = await dojoApplySourceDriftExpiryTool(args);
        break;
      case "synthi_dojo_get_source_affordance_pr_plan":
        response = await dojoGetSourceAffordancePrPlanTool(args);
        break;
      case "synthi_dojo_prepare_source_affordance_pr":
        response = await dojoPrepareSourceAffordancePrTool(args);
        break;
      case "synthi_dojo_create_source_affordance_pr_branch":
        response = await dojoCreateSourceAffordancePrBranchTool(args);
        break;
      case "synthi_dojo_prepare_api_backed_tool":
        response = await dojoPrepareApiBackedToolTool(args);
        break;
      case "synthi_dojo_run_api_backed_tool":
        response = await dojoRunApiBackedToolTool(args);
        break;
      case "synthi_dojo_get_registry":
        response = await dojoGetRegistryTool(args);
        break;
      case "synthi_dojo_get_skill_assurance_case":
        response = await dojoGetAssuranceCaseTool(args);
        break;
      case "synthi_dojo_get_entrustment_level":
        response = await dojoGetEntrustmentLevelTool(args);
        break;
      case "synthi_dojo_get_license":
        response = await dojoGetLicenseTool(args);
        break;
      case "synthi_dojo_get_guardrails":
        response = await dojoGetGuardrailsTool(args);
        break;
      case "synthi_dojo_get_case_law":
        response = await dojoGetCaseLawTool(args);
        break;
      case "synthi_dojo_explain_block":
        response = await dojoExplainBlockTool(args);
        break;
      case "synthi_dojo_explain_failure":
        response = await dojoExplainFailureTool(args);
        break;
      case "synthi_dojo_debug_counterfactual":
        response = await dojoDebugCounterfactualTool(args);
        break;
      case "synthi_dojo_run_time_machine_debugger":
        response = await dojoRunTimeMachineDebuggerTool(args);
        break;
      case "synthi_dojo_run_ghost_mode":
        response = await dojoRunGhostModeTool(args);
        break;
      case "synthi_dojo_request_permission_upgrade":
        response = await dojoPermissionUpgradeTool(args);
        break;
      case "synthi_dojo_review_permission_upgrade":
        response = await dojoReviewPermissionUpgradeTool(args);
        break;
      case "synthi_dojo_review_case_law":
        response = await dojoReviewCaseLawTool(args);
        break;
      case "synthi_dojo_run_scheduled_governance_jobs":
        response = await dojoRunScheduledGovernanceJobsTool(args);
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
      case "synthi_dojo_run_evil_twin":
        response = await dojoRunEvilTwinTool(args);
        break;
      case "synthi_dojo_run_checkride":
        response = await dojoRunCheckrideTool(args);
        break;
      case "synthi_dojo_publish_skill":
        response = await dojoPublishSkillTool(args);
        break;
      case "synthi_dojo_recertify_skill":
        response = await dojoRecertifySkillTool(args);
        break;
      case "synthi_dojo_get_license_health":
        response = await dojoGetLicenseHealthTool(args);
        break;
      case "synthi_dojo_revoke_license":
        response = await dojoRevokeLicenseTool(args);
        break;
      case "synthi_dojo_record_case_law":
        response = await dojoRecordCaseLawTool(args);
        break;
      case "synthi_dojo_export_artifacts":
        response = await dojoExportArtifactsTool(args);
        break;
      case "synthi_dojo_export_compliance_pack":
        response = await dojoExportCompliancePackTool(args);
        break;
      case "synthi_dojo_issue_proof_capsule":
        response = await dojoIssueProofCapsuleTool(args);
        break;
      case "synthi_dojo_validate_proof_capsule":
        response = await dojoValidateProofCapsuleTool(args);
        break;
      case "synthi_dojo_revoke_proof_capsule":
        response = await dojoRevokeProofCapsuleTool(args);
        break;
      case "synthi_dojo_create_hosted_runtime_session":
        response = await dojoCreateHostedRuntimeSessionTool(args);
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
    runtime_scope: dojoImplementation.runtime_scope,
    production_runtime: dojoImplementation.production_runtime,
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
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const durableSkills = await listDurableDojoSkillsForTenantIfRequired(tenantContext.tenant);
  if (!durableSkills.ok) return durableSkills.error;
  const skills = durableSkills.skills ?? dojoSkillRegistry.list();
  const skillBus = createInProcessDojoMcpSkillBus({ listSkills: () => skills });
  const visible = await skillBus.listCompetencies({ tenant: tenantContext.tenant });
  const visibleSkillIds = new Set(visible.map((item) => item.skill_id));
  return jsonResponse({
    ok: true,
    count: visible.length,
    control_plane_source: durableSkills.source,
    competencies: skills.filter((skill) => visibleSkillIds.has(skill.skill_id)).map(skillListItem),
    product_path: "agent_to_mcp_skill_bus_to_proof_validator_to_license_kernel_to_dojo_runtime",
  });
}

async function dojoGetSkillTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_skill");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill: skill.skill,
    mcp_skill_manifest: buildDojoMcpSkillManifest(skill.skill),
  });
}

async function dojoGetSkillCortexTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_skill_cortex");
  if (!skill.ok) return skill.error;
  const caseLawRecords = storedCaseLawRecordsForSkill(skill.skill);
  const compiledGraph = compileDojoSkillGraphForSkill(skill.skill);
  const executableGraph = bindCaseLawGuardrailsToGraph(compiledGraph.graph, caseLawRecords);
  const executableGraphValidation = validateDojoSkillGraph(executableGraph);
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    skill_cortex: skill.skill.skill_cortex,
    executable_graph: executableGraph,
    executable_graph_validation: executableGraphValidation,
    case_law_runtime_bindings: caseLawRuntimeBindingSummary(executableGraph, caseLawRecords),
  });
}

async function dojoGetWorkspaceOrganoidTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_workspace_organoid");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    workspace_organoid: skill.skill.workspace_organoid,
  });
}

async function dojoGetWindTunnelReportTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_wind_tunnel_report");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    wind_tunnel: skill.skill.wind_tunnel,
  });
}

async function dojoGetCounterfactualTwinTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_counterfactual_twin");
  if (!skill.ok) return skill.error;
  const filters = scenarioFilters(args);
  const variants = filterByScenario(skill.skill.counterfactual_twin.variants, filters);
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    counterfactual_twin: {
      ...skill.skill.counterfactual_twin,
      variants,
    },
  });
}

async function dojoGetEvilTwinReportTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_evil_twin_report");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    evil_twin: skill.skill.evil_twin,
  });
}

async function dojoGetTrainingReportTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_training_report");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    training_report: skill.skill.training_report,
  });
}

async function dojoGetSkillPassportTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_skill_passport");
  if (!skill.ok) return skill.error;
  const executableEntrustment = skill.skill.executable_entrustment;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    skill_passport: skill.skill.skill_passport,
    entrustment_source: executableEntrustment ? "executable_checkride" : "legacy_license_artifact",
    executable_entrustment: executableEntrustment ?? null,
    license_scope: {
      allowed_actions: skill.skill.permission_license.allowed_actions,
      gated_actions: skill.skill.permission_license.gated_actions,
      blocked_actions: skill.skill.permission_license.blocked_actions,
      approval_requirements: skill.skill.permission_license.approval_requirements,
    },
    evidence_refs: executableEntrustment?.evidence_refs ?? skill.skill.assurance_case.evidence_refs,
  });
}

async function dojoGetSkillGenomeTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_skill_genome");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    skill_genome: skill.skill.skill_genome,
  });
}

async function dojoGetAntibodiesTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_antibodies");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    antibodies: skill.skill.antibodies,
  });
}

async function dojoGetAgentReadyUiContractTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_agent_ready_ui_contract");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    agent_ready_ui_contract: skill.skill.agent_ready_ui_contract,
  });
}

async function dojoGetCostPolicyTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_cost_policy");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    cost_control_policy: skill.skill.cost_control_policy,
  });
}

async function dojoGetUniverseDossierTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_universe_dossier");
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
    skill.tenant,
    "synthi_dojo_get_universe_dossier"
  );
  if (!visibleSkills.ok) return visibleSkills.error;
  return jsonResponse({
    ok: true,
    control_plane_source: visibleSkills.control_plane_source,
    skill_id: skill.skill.skill_id,
    universe_dossier: buildDojoUniverseDossier(skill.skill, visibleSkills.skills, {
      question: stringOpt(a["question"]),
      mutation_kind: stringOpt(a["mutation_kind"]),
      package_readiness_evidence: objectOpt(a["package_readiness_evidence"]) as DojoPackageReadinessEvidenceSummary | undefined,
      package_readiness_evidence_path: stringOpt(a["package_readiness_evidence_path"]),
    }),
  });
}

async function dojoGetLifecycleTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_lifecycle");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    lifecycle: buildDojoLifecycleReport(skill.skill),
  });
}

async function dojoGetGovernanceReportTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_governance_report");
  if (!skill.ok) return skill.error;
  const now = new Date().toISOString();
  const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
    skill.tenant,
    "synthi_dojo_get_governance_report"
  );
  if (!visibleSkills.ok) return visibleSkills.error;
  const enforcement = resolveDojoEnforcementConfig();
  const governanceViewRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: skill.tenant,
      action: "governance_view",
    })
    : undefined;
  if (governanceViewRbacAuthorization && !governanceViewRbacAuthorization.ok) {
    return errorResponse("dojo_governance_report_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
      blocked_by: governanceViewRbacAuthorization.blocked_by,
      rbac_authorization: governanceViewRbacAuthorization,
    });
  }
  return jsonResponse({
    ok: true,
    control_plane_source: visibleSkills.control_plane_source,
    skill_id: skill.skill.skill_id,
    governance_report: buildDojoGovernanceReport(skill.skill),
    ...(governanceViewRbacAuthorization ? { rbac_authorization: governanceViewRbacAuthorization } : {}),
    governance_service: await governanceServiceViewForTenant(skill.tenant, now, visibleSkills.skills),
  });
}

async function dojoGetMetricsTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const hasExplicitSkillSelection = Boolean(stringOpt(a["skill_id"]) || stringOpt(a["workflow_id"]));
  if (hasExplicitSkillSelection) {
    const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_metrics");
    if (!skill.ok) return skill.error;
    const metricsViewRbac = requireDojoProductionGovernanceRbac({
      tenant: skill.tenant,
      action: "metrics_view",
      error: "dojo_metrics_view_role_required",
      details: {
        operation: "synthi_dojo_get_metrics",
        skill_id: skill.skill.skill_id,
        workspace_id: skill.skill.workspace_id,
      },
    });
    if (!metricsViewRbac.ok) return metricsViewRbac.error;
    return jsonResponse({
      ok: true,
      control_plane_source: skill.control_plane_source,
      metrics: buildDojoUniverseMetrics([skill.skill]),
      ...(metricsViewRbac.rbac_authorization ? { rbac_authorization: metricsViewRbac.rbac_authorization } : {}),
    });
  }
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const metricsViewRbac = requireDojoProductionGovernanceRbac({
    tenant: tenantContext.tenant,
    action: "metrics_view",
    error: "dojo_metrics_view_role_required",
    details: {
      operation: "synthi_dojo_get_metrics",
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
    },
  });
  if (!metricsViewRbac.ok) return metricsViewRbac.error;
  const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
    tenantContext.tenant,
    "synthi_dojo_get_metrics"
  );
  if (!visibleSkills.ok) return visibleSkills.error;
  return jsonResponse({
    ok: true,
    control_plane_source: visibleSkills.control_plane_source,
    metrics: buildDojoUniverseMetrics(visibleSkills.skills),
    ...(metricsViewRbac.rbac_authorization ? { rbac_authorization: metricsViewRbac.rbac_authorization } : {}),
  });
}

function dojoCaptureSourceSnapshotTool(args: unknown): ToolResponse {
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const enforcement = resolveDojoEnforcementConfig();
  const sourceSnapshotCaptureRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: tenantContext.tenant,
      action: "source_snapshot_capture",
    })
    : undefined;
  if (sourceSnapshotCaptureRbacAuthorization && !sourceSnapshotCaptureRbacAuthorization.ok) {
    return errorResponse("dojo_source_snapshot_capture_role_required", {
      ok: false,
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      actor_id: tenantContext.tenant.actor_id,
      actor_type: tenantContext.tenant.actor_type,
      blocked_by: sourceSnapshotCaptureRbacAuthorization.blocked_by,
      rbac_authorization: sourceSnapshotCaptureRbacAuthorization,
    });
  }
  const a = obj(args);
  const appOrigin = stringOpt(a["app_origin"]);
  const appVersion = stringOpt(a["app_version"]);
  const commitSha = stringOpt(a["commit_sha"]);
  const sourceRoot = stringOpt(a["source_root"]);
  const signerKeyId = stringOpt(a["signer_key_id"]);
  const signingKey = stringOpt(a["signing_key"]);
  const missing = [
    ["app_origin", appOrigin],
    ["app_version", appVersion],
    ["commit_sha", commitSha],
    ["source_root", sourceRoot],
    ["signer_key_id", signerKeyId],
    ["signing_key", signingKey],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field);
  if (missing.length > 0) {
    return errorResponse("dojo_source_snapshot_required_fields_missing", {
      ok: false,
      error: "dojo_source_snapshot_required_fields_missing",
      missing_fields: missing,
      blocked_by: missing.map((field) => `source_snapshot_${field}_missing`),
    });
  }
  const sourceTokens = sourceTokenSnapshotsResult(a["source_tokens"]);
  if (!sourceTokens.ok) {
    return errorResponse("dojo_source_snapshot_tokens_invalid", {
      ok: false,
      error: "dojo_source_snapshot_tokens_invalid",
      blocked_by: sourceTokens.blocked_by,
      token_errors: sourceTokens.errors,
      expected_shape: "source_tokens: Array<{ token_id, route, component, source_locator, action?, source_sha256?, risk? }>",
    });
  }
  const createdAt = stringOpt(a["created_at"]) ?? new Date().toISOString();
  try {
    const snapshot = buildDojoSourceSnapshot({
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      app_origin: appOrigin as string,
      app_version: appVersion as string,
      commit_sha: commitSha as string,
      source_root: sourceRoot as string,
      source_tokens: sourceTokens.tokens,
      signer_key_id: signerKeyId as string,
      signing_key: signingKey as string,
      created_at: createdAt,
    });
    const verification = verifyDojoSourceSnapshot(snapshot, {
      signing_keys_by_id: { [signerKeyId as string]: signingKey as string },
    });
    return jsonResponse({
      ok: verification.ok,
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      app_origin: snapshot.app_origin,
      app_version: snapshot.app_version,
      commit_sha: snapshot.commit_sha,
      source_snapshot: snapshot,
      verification,
      source_token_count: snapshot.source_tokens.length,
      blocked_by: verification.blocked_by,
      ...(sourceSnapshotCaptureRbacAuthorization ? { rbac_authorization: sourceSnapshotCaptureRbacAuthorization } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse("dojo_source_snapshot_capture_failed", {
      ok: false,
      error: "dojo_source_snapshot_capture_failed",
      message,
      blocked_by: [message],
    });
  }
}

function dojoDetectSourceDriftTool(args: unknown): ToolResponse {
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const enforcement = resolveDojoEnforcementConfig();
  const sourceDriftDetectionRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: tenantContext.tenant,
      action: "source_drift_detection",
    })
    : undefined;
  if (sourceDriftDetectionRbacAuthorization && !sourceDriftDetectionRbacAuthorization.ok) {
    return errorResponse("dojo_source_drift_detection_role_required", {
      ok: false,
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      actor_id: tenantContext.tenant.actor_id,
      actor_type: tenantContext.tenant.actor_type,
      blocked_by: sourceDriftDetectionRbacAuthorization.blocked_by,
      rbac_authorization: sourceDriftDetectionRbacAuthorization,
    });
  }
  const a = obj(args);
  const previousSnapshot = objectOpt(a["previous_snapshot"]) as DojoSourceSnapshot | undefined;
  const nextSnapshot = objectOpt(a["next_snapshot"]) as DojoSourceSnapshot | undefined;
  const signingKeysById = stringRecordOpt(a["source_snapshot_signing_keys_by_id"]);
  const nodeBindings = sourceDriftNodeBindingsResult(a["node_bindings"]);
  const blockedBy: string[] = [
    ...(!previousSnapshot ? ["source_drift_previous_snapshot_missing"] : []),
    ...(!nextSnapshot ? ["source_drift_next_snapshot_missing"] : []),
    ...(Object.keys(signingKeysById).length === 0 ? ["source_drift_signing_keys_missing"] : []),
    ...(!nodeBindings.ok ? nodeBindings.blocked_by : []),
  ];
  if (blockedBy.length > 0 || !previousSnapshot || !nextSnapshot || !nodeBindings.ok) {
    return errorResponse("dojo_source_drift_inputs_invalid", {
      ok: false,
      error: "dojo_source_drift_inputs_invalid",
      blocked_by: blockedBy,
      node_binding_errors: nodeBindings.ok ? [] : nodeBindings.errors,
    });
  }
  const scopeBlockedBy = sourceSnapshotTenantScopeBlockedBy(tenantContext.tenant, previousSnapshot, nextSnapshot);
  if (scopeBlockedBy.length > 0) {
    return errorResponse("dojo_source_drift_snapshot_scope_mismatch", {
      ok: false,
      error: "dojo_source_drift_snapshot_scope_mismatch",
      blocked_by: scopeBlockedBy,
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      previous_snapshot_id: previousSnapshot.snapshot_id,
      next_snapshot_id: nextSnapshot.snapshot_id,
    });
  }
  try {
    const driftReport = detectDojoSourceDrift({
      previous_snapshot: previousSnapshot,
      next_snapshot: nextSnapshot,
      node_bindings: nodeBindings.bindings,
      source_snapshot_signing_keys_by_id: signingKeysById,
    });
    return jsonResponse({
      ok: true,
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
      source_drift_report: driftReport,
      drifted_token_count: driftReport.drifted_token_ids.length,
      affected_node_count: driftReport.affected_nodes.length,
      license_expiry_trigger_count: driftReport.license_expiry_triggers.length,
      review_required_token_count: driftReport.review_required_token_ids.length,
      blocked_by: [],
      ...(sourceDriftDetectionRbacAuthorization ? { rbac_authorization: sourceDriftDetectionRbacAuthorization } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse("dojo_source_drift_detection_failed", {
      ok: false,
      error: "dojo_source_drift_detection_failed",
      message,
      blocked_by: [message],
    });
  }
}

async function dojoApplySourceDriftExpiryTool(args: unknown): Promise<ToolResponse> {
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const tenant = tenantContext.tenant;
  const a = obj(args);
  const report = sourceDriftReportOpt(a["source_drift_report"]);
  if (!report) {
    return errorResponse("dojo_source_drift_report_invalid", {
      ok: false,
      error: "dojo_source_drift_report_invalid",
      blocked_by: ["source_drift_report_missing_or_invalid"],
      expected_schema_version: "synthi.dojo.sourceDriftReport.v1",
    });
  }
  const dryRun = a["dry_run"] !== false;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const actor: DojoAuditActor = {
    actor_id: tenant.actor_id,
    actor_type: tenant.actor_type,
  };
  const enforcement = resolveDojoEnforcementConfig();
  const sourceDriftExpiryRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: tenant,
      action: "source_drift_expiry",
    })
    : undefined;
  if (sourceDriftExpiryRbacAuthorization && !sourceDriftExpiryRbacAuthorization.ok) {
    return errorResponse("dojo_source_drift_expiry_role_required", {
      ok: false,
      tenant_id: tenant.tenant_id,
      workspace_id: tenant.workspace_id,
      actor_id: tenant.actor_id,
      actor_type: tenant.actor_type,
      dry_run: dryRun,
      app_origin: report.app_origin,
      previous_snapshot_id: report.previous_snapshot_id,
      next_snapshot_id: report.next_snapshot_id,
      affected_node_count: report.affected_nodes.length,
      license_expiry_trigger_count: report.license_expiry_triggers.length,
      blocked_by: sourceDriftExpiryRbacAuthorization.blocked_by,
      rbac_authorization: sourceDriftExpiryRbacAuthorization,
    });
  }

  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant,
      app_origin: report.app_origin,
    });
    if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_apply_source_drift_expiry", resolution);
    try {
      const store = sourceDriftScopedLicenseStore({
        tenant,
        report,
        dry_run: dryRun,
        license_store: resolution.license_store,
        resolve_skill: (skillId) => resolution.skill_store.getSkill(skillId),
      });
      const application = await applyDojoSourceDriftExpiry({
        report,
        license_store: store,
        expired_by: actor,
        now,
      });
      const skillUpdates = dryRun
        ? []
        : await persistSourceDriftExpiredSkills({
          tenant,
          report,
          application,
          resolve_skill: (skillId) => resolution.skill_store.getSkill(skillId),
          save_skill: (skill) => resolution.skill_store.saveSkill(skill, {
            status: "expired",
            created_by: actor,
            now,
          }),
          now,
        });
      const recertificationSkills = await sourceDriftRecertificationSkillsById({
        application,
        resolve_skill: (skillId) => resolution.skill_store.getSkill(skillId),
      });
      const recertificationHandoff = buildDojoSourceDriftRecertificationHandoff({
        report,
        application,
        dry_run: dryRun,
        skill_updates: skillUpdates,
        skills_by_id: recertificationSkills,
      });
      return jsonResponse({
        ok: application.ok,
        tenant_id: tenant.tenant_id,
        workspace_id: tenant.workspace_id,
        control_plane_source: "postgres",
        dry_run: dryRun,
        source_drift_expiry_application: application,
        expired_license_count: dryRun ? 0 : application.expired_license_count,
        would_expire_license_count: dryRun ? application.expired_license_count : 0,
        skill_updates: skillUpdates,
        source_drift_recertification_handoff: recertificationHandoff,
        blocked_by: application.blocked_by,
        ...(sourceDriftExpiryRbacAuthorization ? { rbac_authorization: sourceDriftExpiryRbacAuthorization } : {}),
      });
    } finally {
      await resolution.close?.();
    }
  }

  const store = sourceDriftScopedLicenseStore({
    tenant,
    report,
    dry_run: dryRun,
    license_store: compatibilitySourceDriftLicenseStore(tenant, report, now),
    resolve_skill: (skillId) => Promise.resolve(dojoSkillRegistry.get(skillId)),
  });
  const application = await applyDojoSourceDriftExpiry({
    report,
    license_store: store,
    expired_by: actor,
    now,
  });
  const expiredSkillIds = dryRun
    ? []
    : application.expired_licenses.map((license) => license.record.skill_id).sort();
  const skillUpdates: DojoSourceDriftExpiredSkillUpdate[] = expiredSkillIds.map((skillId) => {
    const skill = dojoSkillRegistry.get(skillId);
    const expired = application.expired_licenses.find((license) => license.record.skill_id === skillId);
    const reason = expired ? sourceDriftExpiredLicenseReason(report, expired) : null;
    return {
      skill_id: skillId,
      license_id: expired?.license_id ?? skill?.permission_license.license_id ?? "",
      status: "expired",
      ...(skill?.workflow_id ? { workflow_id: skill.workflow_id } : {}),
      ...(reason ? { recertification_trigger_id: sourceDriftRecertificationTriggerId(skillId, expired?.license_id ?? "", reason) } : {}),
    };
  }).filter((update) => update.license_id);
  const recertificationSkills = await sourceDriftRecertificationSkillsById({
    application,
    resolve_skill: (skillId) => Promise.resolve(dojoSkillRegistry.get(skillId)),
  });
  const recertificationHandoff = buildDojoSourceDriftRecertificationHandoff({
    report,
    application,
    dry_run: dryRun,
    skill_updates: skillUpdates,
    skills_by_id: recertificationSkills,
  });
  return jsonResponse({
    ok: application.ok,
    tenant_id: tenant.tenant_id,
    workspace_id: tenant.workspace_id,
    control_plane_source: "compatibility_registry",
    dry_run: dryRun,
    source_drift_expiry_application: application,
    expired_license_count: dryRun ? 0 : application.expired_license_count,
    would_expire_license_count: dryRun ? application.expired_license_count : 0,
    skill_updates: dryRun
      ? []
      : skillUpdates.map((update) => ({
        skill_id: update.skill_id,
        license_id: update.license_id,
        status: update.status,
        ...(update.workflow_id ? { workflow_id: update.workflow_id } : {}),
        ...(update.recertification_trigger_id ? { recertification_trigger_id: update.recertification_trigger_id } : {}),
      })),
    source_drift_recertification_handoff: recertificationHandoff,
    blocked_by: application.blocked_by,
    ...(sourceDriftExpiryRbacAuthorization ? { rbac_authorization: sourceDriftExpiryRbacAuthorization } : {}),
  });
}

async function dojoGetSourceAffordancePrPlanTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_source_affordance_pr_plan");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    source_affordance_pr_plan: buildDojoSourceAffordancePrPlan(skill.skill),
  });
}

async function dojoPrepareSourceAffordancePrTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_prepare_source_affordance_pr");
  if (!skill.ok) return skill.error;
  const sourceAffordancePrepareRbacAuthorization = resolveDojoEnforcementConfig().production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: skill.tenant,
      action: "source_affordance_pr_prepare",
    })
    : undefined;
  if (sourceAffordancePrepareRbacAuthorization && !sourceAffordancePrepareRbacAuthorization.ok) {
    return errorResponse("dojo_source_affordance_pr_prepare_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
      blocked_by: sourceAffordancePrepareRbacAuthorization.blocked_by,
      rbac_authorization: sourceAffordancePrepareRbacAuthorization,
    });
  }
  const a = obj(args);
  const sourceFiles = sourcePatchInputFilesOpt(a["source_files"]);
  if (sourceFiles.length === 0) {
    return errorResponse("dojo_source_affordance_source_files_required", {
      ok: false,
      error: "dojo_source_affordance_source_files_required",
      blocked_by: ["source_files_missing"],
      expected_shape: "source_files: Array<{ path: string; source: string }>",
    });
  }
  const preparation = buildSourceAffordancePrPreparation(skill.skill, a, sourceFiles);
  const workspaceRoot = stringOpt(a["workspace_root"]);
  const dryRunApply = workspaceRoot
    ? await applyDojoGeneratedPrBranchPlan({
      branch_plan: preparation.branchPlan,
      patch_bundle: preparation.patchBundle,
      workspace_root: workspaceRoot,
      dry_run: true,
    })
    : null;
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    source_file_count: sourceFiles.length,
    source_affordance_pr_plan: preparation.sourceAffordancePrReport,
    typed_patch_plan: preparation.plan,
    source_patch_bundle: preparation.patchBundle,
    generated_pr_metadata: preparation.metadata,
    generated_pr_branch_plan: preparation.branchPlan,
    dry_run_apply: dryRunApply,
    ready_for_review: preparation.patchBundle.ok && preparation.branchPlan.ready_to_apply && (dryRunApply?.ok ?? true),
    promotion_blockers: sourceAffordancePromotionBlockers(preparation, {
      applyPrefix: "dry_run_apply",
      applyIssues: dryRunApply?.issues,
    }),
    ...(sourceAffordancePrepareRbacAuthorization ? { rbac_authorization: sourceAffordancePrepareRbacAuthorization } : {}),
  });
}

async function dojoCreateSourceAffordancePrBranchTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_create_source_affordance_pr_branch");
  if (!skill.ok) return skill.error;
  const sourceAffordanceBranchRbacAuthorization = resolveDojoEnforcementConfig().production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: skill.tenant,
      action: "source_affordance_pr_branch",
    })
    : undefined;
  if (sourceAffordanceBranchRbacAuthorization && !sourceAffordanceBranchRbacAuthorization.ok) {
    return errorResponse("dojo_source_affordance_pr_branch_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
      blocked_by: sourceAffordanceBranchRbacAuthorization.blocked_by,
      rbac_authorization: sourceAffordanceBranchRbacAuthorization,
    });
  }
  const a = obj(args);
  const sourceFiles = sourcePatchInputFilesOpt(a["source_files"]);
  if (sourceFiles.length === 0) {
    return errorResponse("dojo_source_affordance_source_files_required", {
      ok: false,
      error: "dojo_source_affordance_source_files_required",
      blocked_by: ["source_files_missing"],
      expected_shape: "source_files: Array<{ path: string; source: string }>",
    });
  }
  const repositoryRoot = stringOpt(a["repository_root"]);
  if (!repositoryRoot) {
    return errorResponse("dojo_source_affordance_repository_root_required", {
      ok: false,
      error: "dojo_source_affordance_repository_root_required",
      blocked_by: ["repository_root_missing"],
      expected_shape: "repository_root: string",
    });
  }
  const preparation = buildSourceAffordancePrPreparation(skill.skill, a, sourceFiles);
  const gitBranchResult = await createDojoGeneratedPrGitBranch({
    branch_plan: preparation.branchPlan,
    patch_bundle: preparation.patchBundle,
    repository_root: repositoryRoot,
    dry_run: optionalBoolOpt(a["dry_run"]) ?? true,
    allow_dirty_worktree: optionalBoolOpt(a["allow_dirty_worktree"]) ?? false,
  });

  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    source_file_count: sourceFiles.length,
    repository_root: gitBranchResult.repository_root,
    source_affordance_pr_plan: preparation.sourceAffordancePrReport,
    typed_patch_plan: preparation.plan,
    source_patch_bundle: preparation.patchBundle,
    generated_pr_metadata: preparation.metadata,
    generated_pr_branch_plan: preparation.branchPlan,
    generated_pr_git_branch: gitBranchResult,
    ready_for_review: preparation.patchBundle.ok && preparation.branchPlan.ready_to_apply && gitBranchResult.ok,
    branch_created: gitBranchResult.ok && !gitBranchResult.dry_run,
    promotion_blockers: sourceAffordancePromotionBlockers(preparation, {
      gitIssues: gitBranchResult.issues,
      applyPrefix: "generated_pr_git_branch_apply",
      applyIssues: gitBranchResult.apply_result?.issues,
    }),
    ...(sourceAffordanceBranchRbacAuthorization ? { rbac_authorization: sourceAffordanceBranchRbacAuthorization } : {}),
  });
}

type SourceAffordancePrPreparation = {
  sourceAffordancePrReport: ReturnType<typeof buildDojoSourceAffordancePrPlan>;
  plan: ReturnType<typeof buildDojoSourceAffordancePrPlan>["typed_patch_plan"];
  patchBundle: ReturnType<typeof buildDojoGeneratedSourcePatchBundle>;
  artifactRefs: DojoGeneratedPrArtifactRef[];
  metadata: ReturnType<typeof buildDojoGeneratedPrMetadata>;
  branchPlan: ReturnType<typeof buildDojoGeneratedPrBranchPlan>;
};

function buildSourceAffordancePrPreparation(
  skill: DojoSkill,
  args: Record<string, unknown>,
  sourceFiles: DojoSourcePatchInputFile[]
): SourceAffordancePrPreparation {
  const sourceAffordancePrReport = buildDojoSourceAffordancePrPlan(skill);
  const plan = sourceAffordancePrReport.typed_patch_plan;
  const patchBundle = buildDojoGeneratedSourcePatchBundle({
    plan,
    files: sourceFiles,
  });
  const artifactRefs = sourceAffordanceArtifactRefs(plan.plan_id, patchBundle);
  const metadata = buildDojoGeneratedPrMetadata({
    plan,
    skill_id: skill.skill_id,
    license_id: skill.permission_license.license_id,
    source_snapshot_id: stringOpt(args["source_snapshot_id"]),
    branch_name: stringOpt(args["branch_name"]),
    branch_prefix: stringOpt(args["branch_prefix"]),
    artifact_refs: artifactRefs,
    code_owner_rules: codeOwnerRulesOpt(args["code_owner_rules"]),
  });
  const branchPlan = buildDojoGeneratedPrBranchPlan({
    metadata,
    patch_bundle: patchBundle,
    base_ref: stringOpt(args["base_ref"]),
  });
  return {
    sourceAffordancePrReport,
    plan,
    patchBundle,
    artifactRefs,
    metadata,
    branchPlan,
  };
}

function sourceAffordancePromotionBlockers(
  preparation: SourceAffordancePrPreparation,
  options: {
    applyPrefix?: string;
    applyIssues?: Array<{ issue_id: string; severity: "error" | "warning"; path?: string }>;
    gitIssues?: Array<{ issue_id: string; severity: "error" | "warning" }>;
  } = {}
): string[] {
  return dedupeStrings([
    ...preparation.metadata.promotion_blockers,
    ...preparation.branchPlan.promotion_blockers,
    ...preparation.patchBundle.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `source_patch_bundle:${issue.issue_id}${issue.file_path ? `:${issue.file_path}` : ""}`),
    ...(options.gitIssues ?? [])
      .filter((issue) => issue.severity === "error")
      .map((issue) => `generated_pr_git_branch:${issue.issue_id}`),
    ...(options.applyIssues ?? [])
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${options.applyPrefix ?? "apply"}:${issue.issue_id}${issue.path ? `:${issue.path}` : ""}`),
  ]);
}

type DojoApiBackedToolPublicationReviewSummary = {
  requested: boolean;
  ok: boolean;
  status: "not_requested" | "approved" | "blocked";
  reviewer?: DojoAuditActor;
  reviewed_at?: string;
  reason?: string;
  evidence_refs: string[];
  blocked_by: string[];
  rbac_authorization?: ReturnType<typeof authorizeDojoGovernanceAction>;
};

function validateApiBackedToolPublicationReview(input: {
  publish_to_skill: boolean;
  args: Record<string, unknown>;
  tenant: DojoTenantContext;
  now: string;
}): { ok: boolean; blocked_by: string[]; summary: DojoApiBackedToolPublicationReviewSummary } {
  if (!input.publish_to_skill) {
    return {
      ok: true,
      blocked_by: [],
      summary: {
        requested: false,
        ok: true,
        status: "not_requested",
        evidence_refs: [],
        blocked_by: [],
      },
    };
  }

  const reviewerActorId = stringOpt(input.args["reviewer_actor_id"]);
  const reviewerActorType = actorTypeInputOpt(input.args["reviewer_actor_type"]);
  const evidenceRefs = stringArrayOpt(input.args["review_evidence_refs"]) ?? [];
  const reviewedAt = stringOpt(input.args["reviewed_at"]) ?? input.now;
  const reason = stringOpt(input.args["review_reason"]);
  const blockedBy: string[] = [];
  if (!reviewerActorId) blockedBy.push("api_tool_publication_reviewer_required");
  if (!reviewerActorType) blockedBy.push("api_tool_publication_reviewer_actor_type_required");
  if (evidenceRefs.length === 0) blockedBy.push("api_tool_publication_review_evidence_required");
  if (!isValidIsoTimestamp(reviewedAt)) blockedBy.push("api_tool_publication_review_timestamp_invalid");

  let rbacAuthorization: ReturnType<typeof authorizeDojoGovernanceAction> | undefined;
  if (resolveDojoEnforcementConfig().production_enforcement) {
    rbacAuthorization = authorizeDojoGovernanceAction({
      action: "api_tool_publish",
      tenant_context: input.tenant,
    });
    if (!rbacAuthorization.ok) {
      blockedBy.push(...rbacAuthorization.blocked_by.map((reason) => `api_tool_publication_review_${reason}`));
    }
  }

  const reviewer = reviewerActorId && reviewerActorType
    ? { actor_id: reviewerActorId, actor_type: reviewerActorType }
    : undefined;
  return {
    ok: blockedBy.length === 0,
    blocked_by: blockedBy,
    summary: {
      requested: true,
      ok: blockedBy.length === 0,
      status: blockedBy.length === 0 ? "approved" : "blocked",
      ...(reviewer ? { reviewer } : {}),
      reviewed_at: reviewedAt,
      ...(reason ? { reason } : {}),
      evidence_refs: evidenceRefs,
      blocked_by: blockedBy,
      ...(rbacAuthorization ? { rbac_authorization: rbacAuthorization } : {}),
    },
  };
}

function isValidIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

async function dojoPrepareApiBackedToolTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_prepare_api_backed_tool");
  if (!skill.ok) return skill.error;
  const apiToolPrepareRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "api_tool_prepare",
    error: "dojo_api_tool_prepare_role_required",
    details: {
      operation: "synthi_dojo_prepare_api_backed_tool",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!apiToolPrepareRbac.ok) return apiToolPrepareRbac.error;
  const a = obj(args);
  const candidate = apiEndpointCandidateFromArgs(a);
  if (!candidate.ok) {
    return errorResponse(candidate.error, {
      ok: false,
      error: candidate.error,
      blocked_by: candidate.blocked_by,
      expected_shape: "api_candidate or network_trace plus optional candidate_overrides",
    });
  }
  const requestedAction = stringOpt(a["requested_action"]);
  const toolName = stringOpt(a["tool_name"]);
  const toolVersion = stringOpt(a["tool_version"]);
  const publishToSkill = boolOpt(a["publish_to_skill"]);
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const candidateReview = reviewDojoApiEndpointCandidate(candidate.candidate);
  const compileResult = compileDojoApiBackedMcpTool({
    candidate: candidate.candidate,
    skill_id: skill.skill.skill_id,
    license_id: skill.skill.permission_license.license_id,
    license_version: skill.skill.permission_license.license_version,
    ...(requestedAction ? { action: requestedAction } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(toolVersion ? { tool_version: toolVersion } : {}),
  });
  const sampleInvocationArgs = objectOpt(a["sample_invocation_args"]);
  const invocationValidation = compileResult.tool && sampleInvocationArgs
    ? validateDojoApiBackedToolInvocation({
      tool: compileResult.tool,
      args: sampleInvocationArgs,
      license_context: {
        skill_id: skill.skill.skill_id,
        license_id: skill.skill.permission_license.license_id,
        license_version: skill.skill.permission_license.license_version,
        action: compileResult.tool.action,
        auth_scopes: stringArrayOpt(a["auth_scopes"]),
      },
    })
    : null;
  const reviewBlockers = candidateReview.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `api_candidate_review:${issue.issue_id}`);
  const compileBlockers = compileResult.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `api_tool_compile:${issue.issue_id}`);
  const invocationBlockers = invocationValidation?.blocked_by.map((reason) => `api_tool_invocation:${reason}`) ?? [];
  const licenseBlockers = compileResult.tool
    ? apiBackedToolCurrentLicenseBlockedBy(compileResult.tool, skill.skill).map((reason) => `api_tool_license:${reason}`)
    : [];
  const publicationReview = validateApiBackedToolPublicationReview({
    publish_to_skill: publishToSkill,
    args: a,
    tenant: skill.tenant,
    now,
  });
  const publicationReviewBlockers = publicationReview.blocked_by.map((reason) => `api_tool_publication_review:${reason}`);
  const promotionBlockers = [
    ...new Set([
      ...reviewBlockers,
      ...compileBlockers,
      ...invocationBlockers,
      ...licenseBlockers,
      ...publicationReviewBlockers,
    ]),
  ];
  let apiToolPublication:
    | {
      requested: boolean;
      ok: boolean;
      status: "not_requested" | "published" | "blocked";
      blocked_by: string[];
      published_tool_name?: string;
      published_tool_version?: string;
      skill?: DojoSkill;
      persistence?: Record<string, unknown>;
      mcp_skill_manifest?: ReturnType<typeof buildDojoMcpSkillManifest>;
      review?: DojoApiBackedToolPublicationReviewSummary;
    }
    | undefined;
  if (!publishToSkill) {
    apiToolPublication = {
      requested: false,
      ok: true,
      status: "not_requested",
      blocked_by: [],
      review: publicationReview.summary,
    };
  } else if (!compileResult.tool || promotionBlockers.length > 0) {
    apiToolPublication = {
      requested: true,
      ok: false,
      status: "blocked",
      blocked_by: promotionBlockers.length > 0 ? promotionBlockers : ["api_backed_mcp_tool_not_compiled"],
      review: publicationReview.summary,
    };
  } else {
    const updated = skillWithPublishedApiBackedTool(skill.skill, compileResult.tool, now, publicationReview.summary);
    const persistence = await persistPublishedSkillToDurableControlPlaneIfRequired({
      tenant: skill.tenant,
      skill: updated,
      actor: {
        actor_id: skill.tenant.actor_id,
        actor_type: skill.tenant.actor_type,
      },
      now,
    });
    if (!persistence.ok) return persistence.error;
    const saved = skill.control_plane_source === "compatibility_registry"
      ? dojoSkillRegistry.publish(updated)
      : updated;
    apiToolPublication = {
      requested: true,
      ok: true,
      status: "published",
      blocked_by: [],
      published_tool_name: compileResult.tool.tool_name,
      published_tool_version: compileResult.tool.tool_version,
      skill: saved,
      persistence: persistence.persistence,
      mcp_skill_manifest: buildDojoMcpSkillManifest(saved, { tool_name: compileResult.tool.tool_name }),
      review: publicationReview.summary,
    };
  }
  return jsonResponse({
    ok: true,
    skill_id: apiToolPublication?.skill?.skill_id ?? skill.skill.skill_id,
    license_id: (apiToolPublication?.skill ?? skill.skill).permission_license.license_id,
    license_version: (apiToolPublication?.skill ?? skill.skill).permission_license.license_version,
    candidate_source: candidate.source,
    api_endpoint_candidate: candidate.candidate,
    candidate_review: candidateReview,
    api_tool_compile: compileResult,
    api_backed_mcp_tool: compileResult.tool ?? null,
    sample_invocation_validation: invocationValidation,
    api_tool_publication_review: publicationReview.summary,
    ready_for_promotion: compileResult.ok && (invocationValidation?.ok ?? true) && licenseBlockers.length === 0 && publicationReview.ok,
    promotion_blockers: promotionBlockers,
    api_tool_publication: apiToolPublication,
    mcp_skill_manifest: apiToolPublication?.mcp_skill_manifest ?? null,
    ...(apiToolPrepareRbac.rbac_authorization ? { rbac_authorization: apiToolPrepareRbac.rbac_authorization } : {}),
  });
}

type ResolvedApiBackedToolForRun =
  | {
      ok: true;
      skill: {
        ok: true;
        skill: DojoSkill;
        tenant: DojoTenantContext;
        control_plane_source: "compatibility_registry" | "postgres";
      };
      apiTool: DojoApiBackedMcpTool;
      skillBusResolution: DojoToolResolution | null;
    }
  | { ok: false; error: ToolResponse };

async function resolveApiBackedToolForRun(args: unknown, operation: string): Promise<ResolvedApiBackedToolForRun> {
  const a = obj(args);
  const suppliedApiTool = apiBackedMcpToolOpt(a["api_backed_mcp_tool"]);
  const requestedToolName = stringOpt(a["tool_name"]);
  const requestedToolVersion = stringOpt(a["tool_version"]);
  if (suppliedApiTool) {
    const blockedBy = dedupeStrings([
      ...(requestedToolName && requestedToolName !== suppliedApiTool.tool_name ? ["api_backed_tool_name_mismatch"] : []),
      ...(requestedToolVersion && requestedToolVersion !== suppliedApiTool.tool_version ? ["api_backed_tool_version_mismatch"] : []),
    ]);
    if (blockedBy.length > 0) {
      return {
        ok: false,
        error: errorResponse("dojo_api_backed_tool_identity_mismatch", {
          ok: false,
          error: "dojo_api_backed_tool_identity_mismatch",
          requested_tool_name: requestedToolName ?? null,
          requested_tool_version: requestedToolVersion ?? null,
          api_backed_mcp_tool_name: suppliedApiTool.tool_name,
          api_backed_mcp_tool_version: suppliedApiTool.tool_version,
          blocked_by: blockedBy,
        }),
      };
    }
    const skill = await requiredAuthorizedSkillForProductionRead(
      { ...a, skill_id: suppliedApiTool.skill_id },
      operation
    );
    if (!skill.ok) return skill;
    return {
      ok: true,
      skill,
      apiTool: suppliedApiTool,
      skillBusResolution: null,
    };
  }

  if (!requestedToolName) {
    return {
      ok: false,
      error: errorResponse("dojo_api_backed_tool_inputs_invalid", {
        ok: false,
        error: "dojo_api_backed_tool_inputs_invalid",
        blocked_by: ["api_backed_tool_name_required"],
        expected_shape: "api_backed_mcp_tool or published tool_name plus tool_args",
      }),
    };
  }

  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext;
  const durableSkills = await listDurableDojoSkillsForTenantIfRequired(tenantContext.tenant, operation);
  if (!durableSkills.ok) return durableSkills;
  const skills = durableSkills.skills ?? dojoSkillRegistry.list();
  const skillBus = createInProcessDojoMcpSkillBus({ listSkills: () => skills });
  const resolution = await skillBus.resolveTool({
    tenant: tenantContext.tenant,
    tool_name: requestedToolName,
    tool_version: requestedToolVersion,
  });
  if (!resolution.ok || !resolution.skill) {
    return {
      ok: false,
      error: errorResponse(resolution.blocked_by[0] ?? "dojo_api_backed_tool_resolution_failed", {
        ok: false,
        error: resolution.blocked_by[0] ?? "dojo_api_backed_tool_resolution_failed",
        tool_name: requestedToolName,
        tool_version: requestedToolVersion ?? null,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(resolution),
        blocked_by: resolution.blocked_by.length > 0 ? resolution.blocked_by : ["dojo_mcp_tool_not_resolved"],
      }),
    };
  }
  if (resolution.resolved_tool?.kind !== "api_backed" || !resolution.api_backed_mcp_tool) {
    return {
      ok: false,
      error: errorResponse("dojo_api_backed_tool_not_api_backed", {
        ok: false,
        error: "dojo_api_backed_tool_not_api_backed",
        skill_id: resolution.skill.skill_id,
        tool_name: requestedToolName,
        tool_version: requestedToolVersion ?? null,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(resolution),
        blocked_by: ["dojo_mcp_tool_not_api_backed"],
      }),
    };
  }
  return {
    ok: true,
    skill: {
      ok: true,
      skill: resolution.skill,
      tenant: tenantContext.tenant,
      control_plane_source: durableSkills.source,
    },
    apiTool: resolution.api_backed_mcp_tool,
    skillBusResolution: resolution,
  };
}

function apiBackedToolSkillBusResolutionSummary(resolution: DojoToolResolution | null): Record<string, unknown> | null {
  if (!resolution) return null;
  return {
    ok: resolution.ok,
    status: resolution.status,
    blocked_by: [...resolution.blocked_by],
    skill_id: resolution.skill_id,
    workflow_id: resolution.workflow_id,
    tool_name: resolution.tool_name,
    tool_version: resolution.tool_version,
    resolved_tool: resolution.resolved_tool ?? null,
    mcp_skill_manifest: resolution.mcp_skill_manifest ?? null,
    manifest_validation: resolution.manifest_validation ?? null,
  };
}

async function runApiBackedToolSkillBusPreflight(input: {
  skill: DojoSkill;
  tenant: DojoTenantContext;
  apiTool: DojoApiBackedMcpTool;
  toolArgs: Record<string, unknown>;
  proofCapsule: DojoProofCarryingSkillCapsule;
  proofValidation: { ok: boolean; blocked_by: string[] };
  licenseDecision: { ok: boolean; status: string; blocked_by: string[]; error_codes?: string[] };
  dryRun?: boolean;
  executeTool?: () => unknown | Promise<unknown>;
}): Promise<DojoToolDispatchResult> {
  const skillBus = createInProcessDojoMcpSkillBus({
    listSkills: () => [input.skill],
    proofConsumptionMode: "external_executor",
    validateProof: () => {
      const blockedBy = dedupeStrings([
        ...input.proofValidation.blocked_by,
        ...input.licenseDecision.blocked_by,
      ]);
      return {
        ok: input.proofValidation.ok && input.licenseDecision.ok && blockedBy.length === 0,
        status: blockedBy.length === 0 ? "allowed" : "blocked",
        blocked_by: blockedBy,
        error_codes: input.licenseDecision.error_codes ?? normalizeDojoProofErrorCodes(blockedBy),
      };
    },
    executeTool: ({ resolved_tool }) => {
      if (resolved_tool.kind !== "api_backed") {
        return blockDojoMcpSkillBusExecution(["dojo_mcp_tool_not_api_backed"]);
      }
      if (input.dryRun === false && input.executeTool) {
        return input.executeTool();
      }
      return {
        ok: true,
        preflight_only: input.dryRun !== false,
        tool_name: resolved_tool.tool_name,
        tool_version: resolved_tool.tool_version,
        resolved_tool_kind: resolved_tool.kind,
      };
    },
  });
  return skillBus.dispatch({
    tenant: input.tenant,
    tool_name: input.apiTool.tool_name,
    tool_version: input.apiTool.tool_version,
    requested_action: input.apiTool.action,
    args: input.toolArgs,
    proof_capsule: input.proofCapsule,
    dry_run: input.dryRun !== false,
  });
}

function apiBackedToolSkillBusPreflightSummary(result: DojoToolDispatchResult | null): Record<string, unknown> | null {
  if (!result) return null;
  return {
    ok: result.ok,
    status: result.status,
    dry_run: result.dry_run,
    blocked_by: [...result.blocked_by],
    skill_id: result.skill_id,
    tool_name: result.tool_name,
    resolution: result.resolution ? apiBackedToolSkillBusResolutionSummary(result.resolution) : null,
    validation: result.validation ?? null,
    result: result.result ?? null,
  };
}

type ApiBackedToolExecutionPayload = {
  proof_consume: DojoProofConsumeResult | null;
  api_tool_execution: Awaited<ReturnType<typeof executeDojoApiBackedToolInvocation>> | null;
  api_tool_execution_evidence: DojoApiToolExecutionEvidence[];
  api_tool_execution_evidence_ledger: ApiBackedToolExecutionEvidenceLedgerSummary | null;
};

type ApiBackedToolExecutionEvidenceLedgerSummary = {
  ok: boolean;
  required: boolean;
  store_kind: string;
  configured_env: string[];
  blocked_by: string[];
  ledger_records: Array<{
    record_id: string;
    run_id: string;
    skill_id: string;
    artifact_sha256: string;
    ledger_head_hash: string;
    claim_ids: string[];
    source_refs: string[];
  }>;
};

type ApiBackedToolExecutionEvidenceLedgerResolution =
  | {
      ok: true;
      summary: ApiBackedToolExecutionEvidenceLedgerSummary;
      evidence_ledger?: DojoEvidenceLedgerAppendStore;
      close?: () => Promise<void>;
    }
  | {
      ok: false;
      summary: ApiBackedToolExecutionEvidenceLedgerSummary;
    };

function apiBackedToolExecutionPayloadOpt(value: unknown): ApiBackedToolExecutionPayload | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  if (!Object.prototype.hasOwnProperty.call(record, "proof_consume")) return undefined;
  const proofConsume = objectOpt(record["proof_consume"]) ?? null;
  return {
    proof_consume: proofConsume as unknown as DojoProofConsumeResult | null,
    api_tool_execution: (objectOpt(record["api_tool_execution"]) ?? null) as ApiBackedToolExecutionPayload["api_tool_execution"],
    api_tool_execution_evidence: Array.isArray(record["api_tool_execution_evidence"])
      ? record["api_tool_execution_evidence"] as DojoApiToolExecutionEvidence[]
      : [],
    api_tool_execution_evidence_ledger: (objectOpt(record["api_tool_execution_evidence_ledger"]) ?? null) as ApiBackedToolExecutionPayload["api_tool_execution_evidence_ledger"],
  };
}

function apiBackedToolExecutionPayloadFromDispatchValue(value: unknown): ApiBackedToolExecutionPayload | undefined {
  return apiBackedToolExecutionPayloadOpt(value)
    ?? apiBackedToolExecutionPayloadOpt(objectOpt(value)?.["result"]);
}

async function resolveApiBackedToolExecutionEvidenceLedgerForRun(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  run_id: string;
  checked_at: string;
}): Promise<ApiBackedToolExecutionEvidenceLedgerResolution> {
  const enforcement = resolveDojoEnforcementConfig();
  const storeConfig = resolveDojoEvidenceLedgerStoreConfig();
  const required = enforcement.production_enforcement && enforcement.require_evidence_ledger;
  const baseSummary = {
    required,
    store_kind: storeConfig.store_kind,
    configured_env: storeConfig.configured_env,
    ledger_records: [],
  };
  if (!required) {
    return {
      ok: true,
      summary: {
        ...baseSummary,
        ok: true,
        blocked_by: [],
      },
    };
  }

  const resolution = await resolveDojoEvidenceLedgerAppendStore({
    tenant_id: input.tenant.tenant_id,
    workspace_id: input.tenant.workspace_id,
    tenant_context: input.tenant,
    app_origin: input.skill.app_origin,
  });
  if (!resolution.ok || !resolution.evidence_ledger) {
    return {
      ok: false,
      summary: {
        ...baseSummary,
        ok: false,
        store_kind: resolution.store_kind,
        configured_env: [...new Set([...storeConfig.configured_env, ...resolution.configured_env])],
        blocked_by: dedupeStrings([
          "dojo_api_tool_execution_evidence_ledger_required",
          ...resolution.blocked_by,
        ]),
      },
    };
  }
  return {
    ok: true,
    evidence_ledger: resolution.evidence_ledger,
    close: resolution.close,
    summary: {
      ...baseSummary,
      ok: true,
      store_kind: resolution.store_kind,
      configured_env: [...new Set([...storeConfig.configured_env, ...resolution.configured_env])],
      blocked_by: [],
    },
  };
}

function apiBackedToolExecutionEvidenceRecordId(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  run_id: string;
  api_tool: DojoApiBackedMcpTool;
  evidence_index: number;
  artifact_sha256: string;
}): string {
  return `api_tool_${hashId([
    input.tenant.tenant_id,
    input.tenant.workspace_id,
    input.skill.skill_id,
    input.run_id,
    input.api_tool.tool_name,
    input.api_tool.tool_version,
    String(input.evidence_index),
    input.artifact_sha256,
  ].join(":"))}`;
}

function apiBackedToolExecutionEvidenceLedgerRecordSummary(record: DojoEvidenceLedgerRecord): ApiBackedToolExecutionEvidenceLedgerSummary["ledger_records"][number] {
  return {
    record_id: record.record_id,
    run_id: record.run_id,
    skill_id: record.skill_id,
    artifact_sha256: record.artifact_sha256,
    ledger_head_hash: record.ledger_head_hash,
    claim_ids: [...record.claim_ids],
    source_refs: [...record.source_refs],
  };
}

async function dojoRunApiBackedToolTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const toolArgs = objectOpt(a["tool_args"]);
  if (!toolArgs) {
    return errorResponse("dojo_api_backed_tool_inputs_invalid", {
      ok: false,
      error: "dojo_api_backed_tool_inputs_invalid",
      blocked_by: ["api_backed_tool_args_invalid"],
      expected_shape: "api_backed_mcp_tool or tool_name plus tool_args containing proof_capsule, request, query?, idempotency_key?",
    });
  }

  const resolvedApiTool = await resolveApiBackedToolForRun(args, "synthi_dojo_run_api_backed_tool");
  if (!resolvedApiTool.ok) return resolvedApiTool.error;
  const { skill, apiTool, skillBusResolution } = resolvedApiTool;
  const currentLicense = skill.skill.permission_license;
  const toolMismatch = apiBackedToolCurrentLicenseBlockedBy(apiTool, skill.skill);
  if (toolMismatch.length > 0) {
    return errorResponse("dojo_api_backed_tool_license_mismatch", {
      ok: false,
      error: "dojo_api_backed_tool_license_mismatch",
      skill_id: skill.skill.skill_id,
      tool_name: apiTool.tool_name,
      blocked_by: toolMismatch,
    });
  }

  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const dryRun = a["dry_run"] !== false;
  const runId = stringOpt(a["run_id"])
    ?? stringOpt(a["request_id"])
    ?? `dojo_api_run_${hashId(`${apiTool.tool_name}:${apiTool.tool_version}:${currentLicense.license_id}:${now}`)}`;
  const tenant = skill.tenant;
  const enforcementConfig = resolveDojoEnforcementConfig();
  if (enforcementConfig.production_enforcement && !dryRun && !skillBusResolution) {
    return errorResponse("dojo_api_backed_tool_skill_bus_publication_required", {
      ok: false,
      error: "dojo_api_backed_tool_skill_bus_publication_required",
      skill_id: skill.skill.skill_id,
      control_plane_source: skill.control_plane_source,
      run_id: runId,
      dry_run: false,
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
      required_path: "publish reviewed API-backed tool to the skill manifest and execute by tool_name through the MCP Skill Bus",
      blocked_by: ["api_backed_compiled_tool_requires_skill_bus_publication"],
      error_codes: ["api_backed_compiled_tool_requires_skill_bus_publication"],
    });
  }
  const proofCapsule = proofCapsuleOpt(toolArgs["proof_capsule"]);
  if (!proofCapsule) {
    return errorResponse("dojo_api_backed_tool_proof_capsule_required", {
      ok: false,
      error: "dojo_api_backed_tool_proof_capsule_required",
      skill_id: skill.skill.skill_id,
      tool_name: apiTool.tool_name,
      run_id: runId,
      blocked_by: ["api_tool_proof_capsule_required"],
      error_codes: ["proof_capsule_missing"],
    });
  }
  const durableProofRegistry = await durableProofRegistryForTenantIfRequired({
    tenant,
    operation: "synthi_dojo_run_api_backed_tool",
    app_origin: skill.skill.app_origin,
  });
  if (!durableProofRegistry.ok) return durableProofRegistry.error;
  const licenseContext = {
    skill_id: skill.skill.skill_id,
    license_id: currentLicense.license_id,
    license_version: currentLicense.license_version,
    action: apiTool.action,
    auth_scopes: stringArrayOpt(a["auth_scopes"]),
  };
  try {
    const durableProofRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.proof_store.getProofRecord(proofCapsule.capsule_id)
      : undefined;
    const durableLicenseRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.license_store.getLicense(currentLicense.license_id)
      : undefined;
    const validationOptions = await durableProofValidationOptionsForCapsule({
      context: durableProofRegistry.context,
      tenant,
      capsule: proofCapsule,
      operation: "synthi_dojo_run_api_backed_tool",
      now,
    });
    if (!validationOptions.ok) return validationOptions.error;
    const licenseToolArgs = dojoLicenseKernelToolArgsFromArgs(a, tenant, toolArgs);
    const proofEvidenceValidation = await validateProofCapsuleEvidenceAgainstLedgerIfRequired({
      operation: "synthi_dojo_run_api_backed_tool",
      tenant,
      skill: skill.skill,
      capsule: proofCapsule,
      requested_action: apiTool.action,
      checked_at: now,
      evidence_max_age_ms: numberOpt(a["evidence_max_age_ms"]),
    });
    if (!proofEvidenceValidation.ok) return proofEvidenceValidation.error;
    const evidenceLedgerValidation = proofEvidenceValidation.evidence_ledger_resolution ?? null;
    const evidenceClaimResults = proofEvidenceValidation.evidence_claim_results;
    const invocationValidation = validateDojoApiBackedToolInvocation({
      tool: apiTool,
      args: toolArgs,
      license_context: licenseContext,
    });
    const licenseDecision = evaluateDojoLicenseKernel({
      skill: skill.skill,
      registry: dojoSkillRegistry,
      proof_record: durableProofRecord,
      license_record: durableLicenseRecord,
      require_durable_license: durableProofRegistry.context.required,
      proof_capsule: proofCapsule,
      requested_action: apiTool.action,
      tool_args: licenseToolArgs,
      dry_run: dryRun,
      now,
      evidence_claim_results: evidenceClaimResults,
      require_verified_approval_evidence: resolveDojoEnforcementConfig().production_enforcement,
      proof_validation_options: validationOptions.options,
    });
    const proofValidation = apiToolProofValidationForSkill(
      skill.skill,
      apiTool,
      proofCapsule,
      now,
      licenseDecision.validation
    );
    const skillBusPreflight = skillBusResolution
      ? await runApiBackedToolSkillBusPreflight({
        skill: skill.skill,
        tenant,
        apiTool,
        toolArgs,
        proofCapsule,
        proofValidation,
        licenseDecision,
      })
      : null;
    if (dryRun) {
      const blockedBy = dedupeStrings([
        ...invocationValidation.blocked_by,
        ...proofValidation.blocked_by,
        ...licenseDecision.blocked_by,
        ...(skillBusPreflight?.blocked_by ?? []),
      ]);
      return jsonResponse({
        ok: invocationValidation.ok && proofValidation.ok && licenseDecision.ok && (skillBusPreflight?.ok ?? true),
        skill_id: skill.skill.skill_id,
        control_plane_source: skill.control_plane_source,
        run_id: runId,
        dry_run: true,
        proof_key: validationOptions.proof_key ?? null,
        tool_name: apiTool.tool_name,
        tool_version: apiTool.tool_version,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
        mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
        api_backed_mcp_tool: apiTool,
        api_tool_invocation_validation: invocationValidation,
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_validation: proofValidation,
        license_kernel: licenseDecision,
        proof_consume: null,
        api_tool_execution: null,
        api_tool_execution_evidence: [],
        api_tool_execution_evidence_ledger: null,
        blocked_by: blockedBy,
      });
    }

    const preflightBlockedBy = dedupeStrings([
      ...invocationValidation.blocked_by,
      ...proofValidation.blocked_by,
      ...licenseDecision.blocked_by,
      ...(skillBusPreflight?.blocked_by ?? []),
    ]);
    if (!invocationValidation.ok || !proofValidation.ok || !licenseDecision.ok || (skillBusPreflight && !skillBusPreflight.ok)) {
      return errorResponse(preflightBlockedBy[0] ?? "dojo_api_backed_tool_preflight_blocked", {
        ok: false,
        error: preflightBlockedBy[0] ?? "dojo_api_backed_tool_preflight_blocked",
        skill_id: skill.skill.skill_id,
        control_plane_source: skill.control_plane_source,
        run_id: runId,
        dry_run: false,
        proof_key: validationOptions.proof_key ?? null,
        tool_name: apiTool.tool_name,
        tool_version: apiTool.tool_version,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
        mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
        api_backed_mcp_tool: apiTool,
        api_tool_invocation_validation: invocationValidation,
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_validation: proofValidation,
        license_kernel: licenseDecision,
        proof_consume: null,
        api_tool_execution: null,
        api_tool_execution_evidence: [],
        api_tool_execution_evidence_ledger: null,
        blocked_by: preflightBlockedBy,
        error_codes: normalizeDojoProofErrorCodes(preflightBlockedBy),
      });
    }

    const transport = apiToolTransportForArgs(a, skill.skill, {
      dry_run: false,
      production_enforcement: resolveDojoEnforcementConfig().production_enforcement,
    });
    if (!transport.ok) {
      const error = transport.blocked_by[0] ?? "dojo_api_backed_tool_transport_required";
      return errorResponse(error, {
        ok: false,
        error,
        skill_id: skill.skill.skill_id,
        tool_name: apiTool.tool_name,
        run_id: runId,
        dry_run: false,
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_consume: null,
        api_tool_execution: null,
        api_tool_execution_evidence: [],
        api_tool_execution_evidence_ledger: null,
        blocked_by: transport.blocked_by,
        error_codes: normalizeDojoProofErrorCodes(transport.blocked_by),
      });
    }
    const executeApiBackedTool = async (): Promise<ApiBackedToolExecutionPayload | ReturnType<typeof blockDojoMcpSkillBusExecution>> => {
      const executionEvidenceLedger = await resolveApiBackedToolExecutionEvidenceLedgerForRun({
        tenant,
        skill: skill.skill,
        run_id: runId,
        checked_at: now,
      });
      if (!executionEvidenceLedger.ok) {
        const blockedBy = executionEvidenceLedger.summary.blocked_by;
        return blockDojoMcpSkillBusExecution(
          blockedBy,
          {
            ok: false,
            status: "blocked",
            blocked_by: blockedBy,
            error_codes: normalizeDojoProofErrorCodes(blockedBy),
          },
          {
            proof_consume: null,
            api_tool_execution: null,
            api_tool_execution_evidence: [],
            api_tool_execution_evidence_ledger: executionEvidenceLedger.summary,
          } satisfies ApiBackedToolExecutionPayload
        );
      }

      try {
        const proofConsume = durableProofRegistry.context.required
          ? await durableProofRegistry.context.proof_store.markProofCapsuleUsed(proofCapsule.capsule_id, runId, now)
          : markDojoProofExecution({
            registry: dojoSkillRegistry,
            proof_capsule: proofCapsule,
            run_id: runId,
            now,
          });
        if (!proofConsume.ok) {
          const blockedBy = dedupeStrings([...proofConsume.blocked_by, ...licenseDecision.blocked_by]);
          return blockDojoMcpSkillBusExecution(
            blockedBy,
            {
              ok: false,
              status: "blocked",
              blocked_by: blockedBy,
              error_codes: normalizeDojoProofErrorCodes(blockedBy),
            },
            {
              proof_consume: proofConsume,
              api_tool_execution: null,
              api_tool_execution_evidence: [],
              api_tool_execution_evidence_ledger: executionEvidenceLedger.summary,
            } satisfies ApiBackedToolExecutionPayload
          );
        }

        const evidenceRecords: DojoApiToolExecutionEvidence[] = [];
        const execution = await executeDojoApiBackedToolInvocation({
          tool: apiTool,
          args: toolArgs,
          license_context: licenseContext,
          validate_proof: ({ proof_capsule }) => apiToolProofValidationForSkill(
            skill.skill,
            apiTool,
            proof_capsule,
            now,
            licenseDecision.validation
          ),
          transport: transport.transport,
          write_evidence: async (evidence) => {
            const record = cloneJson(evidence);
            evidenceRecords.push(record);
            if (!executionEvidenceLedger.evidence_ledger) {
              return `evidence:api_tool_${hashId(JSON.stringify(record))}`;
            }
            const artifactPayload = JSON.stringify(record);
            const artifactSha = sha256String(artifactPayload);
            const redactionManifestSha = sha256String(JSON.stringify({
              artifact_sha256: artifactSha,
              redaction_policy: "digest_only",
              raw_payload_stored: false,
            }));
            const ledgerRecord = await executionEvidenceLedger.evidence_ledger.append({
              record_id: apiBackedToolExecutionEvidenceRecordId({
                tenant,
                skill: skill.skill,
                run_id: runId,
                api_tool: apiTool,
                evidence_index: evidenceRecords.length - 1,
                artifact_sha256: artifactSha,
              }),
              skill_id: skill.skill.skill_id,
              run_id: runId,
              kind: "artifact",
              artifact_uri: `dojo://api-tool-execution/${encodeURIComponent(runId)}/${encodeURIComponent(apiTool.tool_name)}`,
              artifact_sha256: artifactSha,
              redaction_manifest_sha256: redactionManifestSha,
              claim_ids: ["api_tool_execution_recorded"],
              created_at: now,
              created_by: tenant.actor_id,
              retention_class: "standard",
              source_refs: dedupeStrings([
                `proof_capsule:${proofCapsule.capsule_id}`,
                `api_tool:${apiTool.tool_name}@${apiTool.tool_version}`,
                `request:${record.request_digest}`,
                `response:${record.response_digest}`,
                `transport:${transport.mode}`,
                ...(record.idempotency_key ? [`idempotency_key_sha256:${sha256String(record.idempotency_key)}`] : []),
              ]),
            });
            executionEvidenceLedger.summary.ledger_records.push(
              apiBackedToolExecutionEvidenceLedgerRecordSummary(ledgerRecord)
            );
            return `evidence:${ledgerRecord.record_id}`;
          },
        });
        const payload: ApiBackedToolExecutionPayload = {
          proof_consume: proofConsume,
          api_tool_execution: execution,
          api_tool_execution_evidence: evidenceRecords,
          api_tool_execution_evidence_ledger: executionEvidenceLedger.summary,
        };
        if (!execution.ok) {
          return blockDojoMcpSkillBusExecution(
            execution.blocked_by,
            {
              ok: false,
              status: "blocked",
              blocked_by: [...execution.blocked_by],
              error_codes: normalizeDojoProofErrorCodes(execution.blocked_by),
            },
            payload
          );
        }
        return payload;
      } finally {
        await executionEvidenceLedger.close?.();
      }
    };

    const skillBusDispatch = skillBusResolution
      ? await runApiBackedToolSkillBusPreflight({
        skill: skill.skill,
        tenant,
        apiTool,
        toolArgs,
        proofCapsule,
        proofValidation,
        licenseDecision,
        dryRun: false,
        executeTool: executeApiBackedTool,
      })
      : null;
    const directExecution = skillBusDispatch ? undefined : await executeApiBackedTool();
    const executionPayload = skillBusDispatch
      ? apiBackedToolExecutionPayloadFromDispatchValue(skillBusDispatch.result)
      : apiBackedToolExecutionPayloadFromDispatchValue(directExecution);
    if (skillBusDispatch && !skillBusDispatch.ok) {
      const blockedBy = dedupeStrings([
        ...skillBusDispatch.blocked_by,
        ...(executionPayload?.api_tool_execution?.blocked_by ?? []),
      ]);
      return errorResponse(blockedBy[0] ?? "dojo_api_backed_tool_skill_bus_dispatch_blocked", {
        ok: false,
        error: blockedBy[0] ?? "dojo_api_backed_tool_skill_bus_dispatch_blocked",
        skill_id: skill.skill.skill_id,
        control_plane_source: skill.control_plane_source,
        run_id: runId,
        dry_run: false,
        proof_key: validationOptions.proof_key ?? null,
        tool_name: apiTool.tool_name,
        tool_version: apiTool.tool_version,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
        mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
        mcp_skill_bus_dispatch: apiBackedToolSkillBusPreflightSummary(skillBusDispatch),
        api_backed_mcp_tool: apiTool,
        api_tool_invocation_validation: invocationValidation,
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_validation: {
          ok: false,
          blocked_by: blockedBy,
        },
        license_kernel: {
          ...licenseDecision,
          ok: false,
          status: "blocked",
          proof_record: executionPayload?.proof_consume?.record ?? licenseDecision.proof_record,
          blocked_by: blockedBy,
          error_codes: normalizeDojoProofErrorCodes(blockedBy),
          validation: {
            ...licenseDecision.validation,
            ok: false,
            status: "blocked",
            error: blockedBy[0] ?? "dojo_api_backed_tool_skill_bus_dispatch_blocked",
            blocked_by: blockedBy,
            error_codes: normalizeDojoProofErrorCodes(blockedBy),
          },
        },
        proof_consume: executionPayload?.proof_consume ?? null,
        api_tool_execution: executionPayload?.api_tool_execution ?? null,
        api_tool_execution_evidence: executionPayload?.api_tool_execution_evidence ?? [],
        api_tool_execution_evidence_ledger: executionPayload?.api_tool_execution_evidence_ledger ?? null,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
      });
    }
    if (!executionPayload) {
      return errorResponse("dojo_api_backed_tool_execution_result_missing", {
        ok: false,
        error: "dojo_api_backed_tool_execution_result_missing",
        skill_id: skill.skill.skill_id,
        control_plane_source: skill.control_plane_source,
        run_id: runId,
        dry_run: false,
        tool_name: apiTool.tool_name,
        tool_version: apiTool.tool_version,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
        mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
        mcp_skill_bus_dispatch: apiBackedToolSkillBusPreflightSummary(skillBusDispatch),
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_consume: null,
        api_tool_execution: null,
        api_tool_execution_evidence: [],
        api_tool_execution_evidence_ledger: null,
        blocked_by: ["api_tool_execution_result_missing"],
        error_codes: ["api_tool_execution_result_missing"],
      });
    }
    const { proof_consume: proofConsume, api_tool_execution: execution, api_tool_execution_evidence: evidenceRecords } = executionPayload;
    if (!execution) {
      const blockedBy = dedupeStrings([
        ...(proofConsume?.blocked_by ?? []),
        ...(executionPayload.api_tool_execution_evidence_ledger?.blocked_by ?? []),
        ...licenseDecision.blocked_by,
      ]);
      return errorResponse(blockedBy[0] ?? "dojo_api_backed_tool_proof_consume_blocked", {
        ok: false,
        error: blockedBy[0] ?? "dojo_api_backed_tool_proof_consume_blocked",
        skill_id: skill.skill.skill_id,
        control_plane_source: skill.control_plane_source,
        run_id: runId,
        dry_run: false,
        api_backed_mcp_tool: apiTool,
        mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
        mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
        mcp_skill_bus_dispatch: apiBackedToolSkillBusPreflightSummary(skillBusDispatch),
        api_tool_invocation_validation: invocationValidation,
        evidence_ledger_validation: evidenceLedgerValidation,
        evidence_claim_results: evidenceClaimResults,
        proof_validation: {
          ok: false,
          blocked_by: blockedBy,
        },
        license_kernel: {
          ...licenseDecision,
          ok: false,
          status: "blocked",
          proof_record: proofConsume?.record ?? licenseDecision.proof_record,
          blocked_by: blockedBy,
          error_codes: normalizeDojoProofErrorCodes(blockedBy),
          validation: {
            ...licenseDecision.validation,
            ok: false,
            status: "blocked",
            error: blockedBy[0] ?? "dojo_api_backed_tool_proof_consume_blocked",
            blocked_by: blockedBy,
            error_codes: normalizeDojoProofErrorCodes(blockedBy),
          },
        },
        proof_consume: proofConsume,
        api_tool_execution: null,
        api_tool_execution_evidence: [],
        api_tool_execution_evidence_ledger: executionPayload.api_tool_execution_evidence_ledger ?? null,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
      });
    }
    return jsonResponse({
      skill_id: skill.skill.skill_id,
      control_plane_source: skill.control_plane_source,
      run_id: runId,
      dry_run: false,
      transport_mode: transport.mode,
      proof_key: validationOptions.proof_key ?? null,
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
      mcp_skill_bus_resolution: apiBackedToolSkillBusResolutionSummary(skillBusResolution),
      mcp_skill_bus_preflight: apiBackedToolSkillBusPreflightSummary(skillBusPreflight),
      mcp_skill_bus_dispatch: apiBackedToolSkillBusPreflightSummary(skillBusDispatch),
      api_backed_mcp_tool: apiTool,
      api_tool_invocation_validation: invocationValidation,
      evidence_ledger_validation: evidenceLedgerValidation,
      evidence_claim_results: evidenceClaimResults,
      proof_validation: execution.proof_validation ?? proofValidation,
      license_kernel: {
        ...licenseDecision,
        proof_record: proofConsume?.record ?? licenseDecision.proof_record,
      },
      proof_consume: proofConsume,
      api_tool_execution: execution,
      api_tool_execution_evidence: evidenceRecords,
      api_tool_execution_evidence_ledger: executionPayload.api_tool_execution_evidence_ledger ?? null,
      blocked_by: execution.blocked_by,
      ok: execution.ok,
    });
  } finally {
    if (durableProofRegistry.context.required) {
      await durableProofRegistry.context.close?.();
    }
  }
}

async function dojoGetRegistryTool(args: unknown): Promise<ToolResponse> {
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const now = new Date().toISOString();
  const registryViewRbac = requireDojoProductionGovernanceRbac({
    tenant: tenantContext.tenant,
    action: "registry_view",
    error: "dojo_registry_view_role_required",
    details: {
      operation: "synthi_dojo_get_registry",
      tenant_id: tenantContext.tenant.tenant_id,
      workspace_id: tenantContext.tenant.workspace_id,
    },
  });
  if (!registryViewRbac.ok) return registryViewRbac.error;
  const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
    tenantContext.tenant,
    "synthi_dojo_get_registry"
  );
  if (!visibleSkills.ok) return visibleSkills.error;
  return jsonResponse({
    ok: true,
    control_plane_source: visibleSkills.control_plane_source,
    registry: buildDojoOrganizationRegistry(visibleSkills.skills, { now }),
    governance_service: await governanceServiceViewForTenant(tenantContext.tenant, now, visibleSkills.skills),
    ...(registryViewRbac.rbac_authorization ? { rbac_authorization: registryViewRbac.rbac_authorization } : {}),
  });
}

async function dojoGetAssuranceCaseTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_skill_assurance_case");
  if (!skill.ok) return skill.error;
  const assuranceArtifact = buildDojoSkillAssuranceArtifact(skill.skill);
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    assurance_case: skill.skill.assurance_case,
    assurance_artifact: assuranceArtifact,
    entrustment_source: assuranceArtifact.entrustment_source,
    executable_entrustment: assuranceArtifact.executable_entrustment,
    license_scope: assuranceArtifact.license_scope,
    evidence_refs: assuranceArtifact.evidence_refs,
    ledger_checkpoint_hashes: assuranceArtifact.ledger_checkpoint_hashes,
  });
}

async function dojoGetEntrustmentLevelTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_entrustment_level");
  if (!skill.ok) return skill.error;
  const executableEntrustment = skill.skill.executable_entrustment;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    entrustment_level: skill.skill.entrustment_level,
    skill_readiness_level: skill.skill.skill_readiness_level,
    proof_required: skill.skill.skill_passport.proof_required,
    license_id: skill.skill.permission_license.license_id,
    entrustment_source: executableEntrustment ? "executable_checkride" : "legacy_license_artifact",
    executable_entrustment: executableEntrustment ?? null,
    license_scope: {
      allowed_actions: skill.skill.permission_license.allowed_actions,
      gated_actions: skill.skill.permission_license.gated_actions,
      blocked_actions: skill.skill.permission_license.blocked_actions,
      approval_requirements: skill.skill.permission_license.approval_requirements,
    },
    evidence_refs: executableEntrustment?.evidence_refs ?? skill.skill.assurance_case.evidence_refs,
  });
}

async function dojoGetLicenseTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_license");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    license: skill.skill.permission_license,
  });
}

async function dojoGetGuardrailsTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_guardrails");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    guardrails: skill.skill.guardrails,
  });
}

async function dojoGetCaseLawTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_case_law");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    case_law: skill.skill.case_law,
    case_law_records: storedCaseLawRecordsForSkill(skill.skill),
  });
}

async function dojoExplainBlockTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_explain_block");
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
    control_plane_source: skill.control_plane_source,
    requested_action: requestedAction,
    validation,
    refusal: validation.ok ? null : refusalFor(skill.skill, validation.blocked_by),
    refusal_explanation: validation.ok ? null : refusalExplanationFor(skill.skill, requestedAction, validation.blocked_by),
    relevant_case_law: skill.skill.case_law.slice(0, 3),
  });
}

async function dojoExplainFailureTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_explain_failure");
  if (!skill.ok) return skill.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_explain_failure", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const filters = scenarioFilters(args);
  const a = obj(args);
  const guardrailId = stringOpt(obj(args)["guardrail_id"]);
  const caseId = stringOpt(a["case_id"]);
  const scenario = firstScenario(skill.skill, filters);
  let runtimeFailureExecution: Awaited<ReturnType<typeof runDojoVivariumScenario>> | null = null;
  let runtimeFailureEvidence: Record<string, unknown> | null = null;
  let persistedSkill = skill.skill;
  let controlPlanePersistence: Record<string, unknown> | null = null;
  let result = scenario
    ? skill.skill.checkride.results.find((item) => item.scenario_id === scenario.scenario_id) ?? null
    : null;
  if (scenario) {
    runtimeFailureExecution = await runDojoVivariumScenario(skill.skill, {
      scenario_id: scenario.scenario_id,
      now: stringOpt(a["now"]),
      tenant_context: skill.tenant,
    });
    result = runtimeFailureExecution.result;
    const updated = skillWithDojoRuns(skill.skill, [runtimeFailureExecution.run], undefined, {
      now: runtimeFailureExecution.run.finished_at,
    });
    const durablePersistence = await persistVivariumRunsToDurableControlPlaneIfRequired({
      tenant: skill.tenant,
      skill: skill.skill,
      updated_skill: updated,
      runs: [runtimeFailureExecution],
      operation: "synthi_dojo_explain_failure",
      now: runtimeFailureExecution.run.finished_at,
    });
    if (!durablePersistence.ok) return durablePersistence.error;
    controlPlanePersistence = durablePersistence.persistence ?? null;
    persistedSkill = skill.control_plane_source === "compatibility_registry"
      ? dojoSkillRegistry.publish(updated)
      : updated;
    runtimeFailureEvidence = {
      schema_version: "synthi.dojo.failureExplanationRuntimeEvidence.v1",
      runtime_basis: "materialized_vivarium_graph_oracle",
      scenario_id: runtimeFailureExecution.scenario.scenario_id,
      mutation_kind: runtimeFailureExecution.scenario.mutation_kind,
      run_id: runtimeFailureExecution.run.run_id,
      status: runtimeFailureExecution.result.status,
      finding: runtimeFailureExecution.result.finding,
      guardrails_triggered: runtimeFailureExecution.guardrails,
      evidence_refs: runtimeFailureExecution.evidence_refs,
      materialized_fixture: {
        simulator_tier: runtimeFailureExecution.materialized_fixture.simulator_tier,
        synthetic_data_only: runtimeFailureExecution.materialized_fixture.synthetic_data_only,
      },
    };
  }
  const matchedCase = caseId
    ? persistedSkill.case_law.find((item) => item.case_id === caseId) ?? null
    : result
    ? persistedSkill.case_law.find((item) => result.evidence_refs.some((ref) => item.evidence_refs.includes(ref))) ?? null
    : null;
  const matchedGuardrails = persistedSkill.guardrails.filter((guardrail) => {
    if (guardrailId) return guardrail.guardrail_id === guardrailId;
    if (matchedCase?.case_id) return guardrail.source_case_id === matchedCase.case_id;
    return result?.status !== "passed" && guardrail.blocks_actions.includes("run_workflow");
  });
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlanePersistence ? "postgres" : skill.control_plane_source,
    skill_id: persistedSkill.skill_id,
    scenario,
    result,
    runtime_failure_evidence: runtimeFailureEvidence,
    runtime_failure_execution: runtimeFailureExecution,
    case_law: matchedCase,
    guardrails: matchedGuardrails,
    explanation: failureExplanation(persistedSkill, scenario, result, matchedCase, matchedGuardrails),
    next_steps: permissionUpgradeSteps(persistedSkill, "run_workflow"),
    persisted_skill: skillListItem(persistedSkill),
    control_plane_persistence: controlPlanePersistence,
    license_health: await licenseHealthFor(persistedSkill, skill.tenant),
  });
}

async function dojoDebugCounterfactualTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_debug_counterfactual");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_debug_counterfactual",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_debug_counterfactual", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const filters = scenarioFilters(args);
  const a = obj(args);
  const variants = filterByScenario(skill.skill.counterfactual_twin.variants, filters);
  const scenarioIds = new Set(variants.map((variant) => variant.scenario_id));
  const scenarios = skill.skill.scenarios.filter((scenario) => scenarioIds.has(scenario.scenario_id));
  const runtimeBranches = [];
  for (const scenario of scenarios) {
    runtimeBranches.push(await runDojoVivariumScenario(skill.skill, {
      scenario_id: scenario.scenario_id,
      now: stringOpt(a["now"]),
      tenant_context: skill.tenant,
    }));
  }
  const completedAt = runtimeBranches
    .map((run) => run.run.finished_at)
    .sort()
    .at(-1) ?? stringOpt(a["now"]) ?? new Date().toISOString();
  const updated = runtimeBranches.length > 0
    ? skillWithDojoRuns(skill.skill, runtimeBranches.map((branch) => branch.run), undefined, { now: completedAt })
    : skill.skill;
  const durablePersistence = runtimeBranches.length > 0
    ? await persistVivariumRunsToDurableControlPlaneIfRequired({
      tenant: skill.tenant,
      skill: skill.skill,
      updated_skill: updated,
      runs: runtimeBranches,
      operation: "synthi_dojo_debug_counterfactual",
      now: completedAt,
    })
    : { ok: true as const };
  if (!durablePersistence.ok) return durablePersistence.error;
  const persisted = runtimeBranches.length > 0 && skill.control_plane_source === "compatibility_registry"
    ? dojoSkillRegistry.publish(updated)
    : updated;
  const results = runtimeBranches.length > 0
    ? runtimeBranches.map((branch) => branch.result)
    : skill.skill.checkride.results.filter((result) => scenarioIds.has(result.scenario_id));
  const attacks = skill.skill.evil_twin.attacks.filter((attack) => scenarioIds.has(attack.scenario_id));
  const guardrailRefs = new Set(attacks.flatMap((attack) => attack.guardrail_refs));
  return jsonResponse({
    ok: true,
    control_plane_source: durablePersistence.persistence ? "postgres" : skill.control_plane_source,
    skill_id: persisted.skill_id,
    variants,
    scenarios,
    results,
    runtime_debug_branches: runtimeBranches.map((branch) => ({
      schema_version: "synthi.dojo.counterfactualRuntimeDebugBranch.v1",
      runtime_basis: "materialized_vivarium_graph_oracle",
      scenario_id: branch.scenario.scenario_id,
      mutation_kind: branch.scenario.mutation_kind,
      run_id: branch.run.run_id,
      status: branch.result.status,
      finding: branch.result.finding,
      guardrails_triggered: branch.guardrails,
      evidence_refs: branch.evidence_refs,
      materialized_fixture: {
        simulator_tier: branch.materialized_fixture.simulator_tier,
        synthetic_data_only: branch.materialized_fixture.synthetic_data_only,
      },
    })),
    attacks,
    guardrails: persisted.guardrails.filter((guardrail) => guardrailRefs.has(guardrail.guardrail_id)),
    promoted_scenarios: persisted.counterfactual_twin.promoted_scenarios.filter((scenarioId) => scenarioIds.has(scenarioId)),
    cost_policy: persisted.cost_control_policy,
    persisted_skill: skillListItem(persisted),
    control_plane_persistence: durablePersistence.persistence ?? null,
    license_health: await licenseHealthFor(persisted, skill.tenant),
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function dojoRunTimeMachineDebuggerTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_time_machine_debugger");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_run_time_machine_debugger",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_time_machine_debugger", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const a = obj(args);
  const timeMachine = runDojoTimeMachineDebugger(skill.skill, {
    scenario_id: stringOpt(a["scenario_id"]),
    mutation_kind: stringOpt(a["mutation_kind"]),
    question: stringOpt(a["question"]),
  });
  const runtimeBranch = await runDojoTimeMachineRuntimeBranch({
    skill: skill.skill,
    tenant: skill.tenant,
    time_machine_debugger: timeMachine,
    now: stringOpt(a["now"]),
  });
  if (!runtimeBranch.ok) {
    return jsonResponse({
      ok: true,
      control_plane_source: skill.control_plane_source,
      skill_id: skill.skill.skill_id,
      time_machine_debugger: {
        ...timeMachine,
        runtime_branch: runtimeBranch.runtime_branch,
      },
      runtime_branch_execution: null,
      persisted_skill: skillListItem(skill.skill),
      control_plane_persistence: null,
      license_health: await licenseHealthFor(skill.skill, skill.tenant),
      ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
    });
  }
  const updated = skillWithDojoRuns(skill.skill, [runtimeBranch.scenario_run.run], undefined, {
    now: runtimeBranch.scenario_run.run.finished_at,
  });
  const durablePersistence = await persistVivariumRunsToDurableControlPlaneIfRequired({
    tenant: skill.tenant,
    skill: skill.skill,
    updated_skill: updated,
    runs: [runtimeBranch.scenario_run],
    operation: "synthi_dojo_run_time_machine_debugger",
    now: runtimeBranch.scenario_run.run.finished_at,
  });
  if (!durablePersistence.ok) return durablePersistence.error;
  const persisted = skill.control_plane_source === "compatibility_registry"
    ? dojoSkillRegistry.publish(updated)
    : updated;
  return jsonResponse({
    ok: true,
    control_plane_source: durablePersistence.persistence ? "postgres" : skill.control_plane_source,
    skill_id: persisted.skill_id,
    time_machine_debugger: {
      ...timeMachine,
      runtime_branch: runtimeBranch.runtime_branch,
    },
    runtime_branch_execution: runtimeBranch.scenario_run,
    persisted_skill: skillListItem(persisted),
    control_plane_persistence: durablePersistence.persistence ?? null,
    license_health: await licenseHealthFor(persisted, skill.tenant),
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function runDojoTimeMachineRuntimeBranch(input: {
  skill: DojoSkill;
  tenant: DojoTenantContext;
  time_machine_debugger: DojoTimeMachineDebugReport;
  now?: string;
}): Promise<
  | {
      ok: true;
      scenario_run: Awaited<ReturnType<typeof runDojoVivariumScenario>>;
      runtime_branch: Record<string, unknown>;
    }
  | {
      ok: false;
      runtime_branch: Record<string, unknown>;
    }
> {
  const scenarioId = input.time_machine_debugger.baseline.scenario_id;
  const mutationKind = input.time_machine_debugger.baseline.mutation_kind;
  const matchingScenario = scenarioId
    ? input.skill.scenarios.find((scenario) => scenario.scenario_id === scenarioId)
    : mutationKind
      ? input.skill.scenarios.find((scenario) => scenario.mutation_kind === mutationKind)
      : null;
  if (!matchingScenario) {
    return {
      ok: false,
      runtime_branch: {
        schema_version: "synthi.dojo.timeMachineRuntimeBranch.v1",
        ok: false,
        status: "blocked",
        scenario_id: scenarioId ?? null,
        mutation_kind: mutationKind ?? null,
        blocked_by: ["time_machine_runtime_scenario_not_found"],
        evidence_refs: [],
      },
    };
  }
  const scenarioRun = await runDojoVivariumScenario(input.skill, {
    scenario_id: matchingScenario.scenario_id,
    now: input.now,
    tenant_context: input.tenant,
  });
  return {
    ok: true,
    scenario_run: scenarioRun,
    runtime_branch: {
      schema_version: "synthi.dojo.timeMachineRuntimeBranch.v1",
      ok: scenarioRun.ok,
      status: scenarioRun.result.status,
      scenario_id: scenarioRun.scenario.scenario_id,
      mutation_kind: scenarioRun.scenario.mutation_kind,
      materialized_id: objectOpt(scenarioRun.materialized_fixture.tissues["fixture"])?.["materialized_id"] ?? null,
      run_id: scenarioRun.run.run_id,
      oracle_finding: scenarioRun.result.finding,
      guardrails_triggered: scenarioRun.guardrails,
      evidence_refs: scenarioRun.evidence_refs,
      runtime_basis: "materialized_vivarium_graph_oracle",
    },
  };
}

async function dojoRunGhostModeTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_ghost_mode");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_run_ghost_mode",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_ghost_mode", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
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
  const shadowEvidence: DojoGhostShadowEvidenceRecord = {
    schema_version: "synthi.dojo.ghostShadowEvidence.v1",
    tenant_id: skill.tenant.tenant_id,
    workspace_id: skill.tenant.workspace_id,
    evidence_id: `ghost_evidence_${hashId(`${runId}:${evidenceRefs.join("|")}`)}`,
    run_id: runId,
    skill_id: skill.skill.skill_id,
    workflow_id: skill.skill.workflow_id,
    license_id: skill.skill.permission_license.license_id,
    evidence_kind: "shadow",
    production_mutations_executed: false,
    action_matches: actionMatches,
    observed_human_action: observed,
    agent_planned_action: planned,
    observed_label: observedLabel,
    planned_label: plannedLabel,
    license_status: licenseStatus,
    guardrail_refs: guardrailsTriggered.map((guardrail) => guardrail.guardrail_id),
    evidence_refs: evidenceRefs,
    entrustment_impact: entrustmentImpact,
    created_at: now,
    created_by: {
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
    },
    request_context: {
      request_id: skill.tenant.request_id,
      correlation_id: skill.tenant.correlation_id,
    },
  };
  const shadowEvidenceAuditInput = {
    tenant_id: skill.tenant.tenant_id,
    workspace_id: skill.tenant.workspace_id,
    actor: {
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
    },
    event_type: "ghost_shadow_evidence_recorded",
    request_id: skill.tenant.request_id,
    correlation_id: skill.tenant.correlation_id,
    entity_kind: "ghost_shadow_evidence",
    entity_id: shadowEvidence.evidence_id,
    details: {
      skill_id: skill.skill.skill_id,
      workflow_id: skill.skill.workflow_id,
      run_id: runId,
      license_id: skill.skill.permission_license.license_id,
      license_status: licenseStatus,
      action_matches: actionMatches,
      observed_label: observedLabel,
      planned_label: plannedLabel,
      production_mutations_executed: false,
      guardrail_refs: guardrailsTriggered.map((guardrail) => guardrail.guardrail_id),
      evidence_refs: evidenceRefs,
      entrustment_upgrade_allowed: entrustmentImpact.upgrade_allowed,
      recommended_entrustment: entrustmentImpact.recommended_entrustment,
    },
    created_at: now,
  } as const;
  const enforcement = resolveDojoEnforcementConfig();
  let recordedShadowEvidence = shadowEvidence;
  let shadowEvidenceAuditEvent: DojoAuditEventRecord | null = null;
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: skill.tenant,
      app_origin: skill.skill.app_origin,
    });
    if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_run_ghost_mode", resolution);
    try {
      recordedShadowEvidence = await resolution.ghost_shadow_evidence_store.saveGhostShadowEvidence(shadowEvidence);
      shadowEvidenceAuditEvent = await resolution.audit_store.appendAuditEvent(shadowEvidenceAuditInput);
      controlPlaneSource = "postgres";
    } finally {
      await resolution.close?.();
    }
  }
  if (skill.control_plane_source === "compatibility_registry") {
    const localShadowEvidence = dojoSkillRegistry.recordGhostShadowEvidence(shadowEvidence);
    if (controlPlaneSource === "compatibility_registry") recordedShadowEvidence = localShadowEvidence;
    const localAuditEvent = await dojoSkillRegistry.recordAuditEvent(shadowEvidenceAuditInput);
    if (!shadowEvidenceAuditEvent) shadowEvidenceAuditEvent = localAuditEvent;
  }
  if (!shadowEvidenceAuditEvent) {
    return errorResponse("dojo_ghost_mode_shadow_evidence_audit_failed", {
      ok: false,
      skill_id: skill.skill.skill_id,
      run_id: runId,
      control_plane_source: controlPlaneSource,
      blocked_by: ["dojo_shadow_evidence_audit_missing"],
    });
  }
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
    shadow_evidence_id: recordedShadowEvidence.evidence_id,
    shadow_evidence_audit_event_id: shadowEvidenceAuditEvent.audit_event_id,
    evidence_refs: evidenceRefs,
    entrustment_impact: entrustmentImpact,
    explanation: actionMatches
      ? "Ghost mode matched the demonstrated action label and did not execute production mutations."
      : "Ghost mode found a mismatch or incomplete planned action, so production execution remains blocked.",
  };
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
    skill_id: skill.skill.skill_id,
    ghost_run: run,
    shadow_evidence: recordedShadowEvidence,
    shadow_evidence_recorded: true,
    shadow_evidence_audit_event: shadowEvidenceAuditEvent,
    guardrails: guardrailsTriggered,
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function dojoPermissionUpgradeTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_request_permission_upgrade");
  if (!skill.ok) return skill.error;
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_permission_upgrade_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_permission_upgrade_actor_type_required");
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_request_permission_upgrade", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
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
  const enforcement = resolveDojoEnforcementConfig();
  let storedRequest = requestRecord;
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: skill.tenant,
      app_origin: skill.skill.app_origin,
    });
    if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_request_permission_upgrade", resolution);
    try {
      await resolution.governance_store.savePermissionUpgradeRequest(requestRecord);
      controlPlaneSource = "postgres";
    } finally {
      await resolution.close?.();
    }
  }
  if (skill.control_plane_source === "compatibility_registry") {
    storedRequest = dojoSkillRegistry.recordPermissionUpgradeRequest(requestRecord);
  }
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
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

async function dojoReviewPermissionUpgradeTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const requestId = stringOpt(a["request_id"]);
  if (!requestId) return errorResponse("dojo_permission_upgrade_request_id_required");
  const decision = permissionUpgradeDecisionOpt(a["decision"]);
  if (!decision) return errorResponse("dojo_permission_upgrade_decision_required", {
    allowed_decisions: ["approved", "denied"],
  });
  const reviewerActorId = stringOpt(a["reviewer_actor_id"]) ?? stringOpt(a["actor_id"]);
  if (!reviewerActorId) return errorResponse("dojo_permission_upgrade_reviewer_required");
  const reviewerActorType = actorTypeInputOpt(a["reviewer_actor_type"] ?? a["actor_type"]);
  if (!reviewerActorType) return errorResponse("dojo_permission_upgrade_reviewer_actor_type_required");
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_review_permission_upgrade", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;

  const durableResolution = await permissionUpgradeReviewContextFromDurableControlPlaneIfRequired(args, requestId);
  if (!durableResolution.ok) return durableResolution.error;

  const storedRequest = durableResolution.context?.request
    ?? dojoSkillRegistry.listPermissionUpgradeRequests({ request_id: requestId, limit: 1 })[0];
  if (!storedRequest) return errorResponse("dojo_permission_upgrade_request_not_found", { request_id: requestId });
  let skill = durableResolution.context?.skill ?? dojoSkillRegistry.get(storedRequest.skill_id);
  if (!skill) return errorResponse("dojo_permission_upgrade_skill_not_found", {
    request_id: requestId,
    skill_id: storedRequest.skill_id,
  });
  const authorization = durableResolution.context
    ? { ok: true as const, tenant: durableResolution.context.tenant }
    : authorizeTenantForDojoSkill(args, skill);
  if (!authorization.ok) return authorization.error;
  const productionGovernanceRbacRequired = resolveDojoEnforcementConfig().production_enforcement;

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
    tenant_context: productionGovernanceRbacRequired ? authorization.tenant : undefined,
    require_rbac: productionGovernanceRbacRequired,
  });
  if (!review.ok) {
    await durableResolution.context?.close?.();
    return errorResponse(review.error ?? "dojo_permission_upgrade_review_rejected", {
      request_id: requestId,
      review,
    });
  }

  let updatedRequest = review.request;
  const promotionLedgerEnforced = (() => {
    const enforcement = resolveDojoEnforcementConfig();
    return enforcement.production_enforcement && enforcement.require_evidence_ledger;
  })();
  const promotionEvidencePolicy = validatePermissionUpgradePromotionEvidencePolicy({
    request: updatedRequest,
    asserted_claims: stringArrayOpt(a["promotion_evidence_claims"]),
    production_ledger_enforced: promotionLedgerEnforced,
  });
  if (!promotionEvidencePolicy.ok) {
    await durableResolution.context?.close?.();
    return errorResponse("dojo_permission_upgrade_promotion_evidence_policy_failed", {
      ok: false,
      request_id: requestId,
      requested_action: updatedRequest.requested_action,
      required_steps: updatedRequest.required_steps,
      promotion_evidence_policy: promotionEvidencePolicy.summary,
      blocked_by: promotionEvidencePolicy.blocked_by,
    });
  }
  const evidenceLedgerValidation = await validatePermissionUpgradeEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_review_permission_upgrade",
    tenant: authorization.tenant,
    skill,
    evidence_refs: updatedRequest.decision_evidence_refs ?? [],
    checked_at: updatedRequest.reviewed_at ?? new Date().toISOString(),
    required_claims: promotionEvidencePolicy.summary.required_claims,
  });
  if (!evidenceLedgerValidation.ok) {
    await durableResolution.context?.close?.();
    return evidenceLedgerValidation.error;
  }
  const authoritativePromotionEvidencePolicy = validatePermissionUpgradePromotionEvidencePolicy({
    request: updatedRequest,
    asserted_claims: stringArrayOpt(a["promotion_evidence_claims"]),
    evidence_claim_results: evidenceLedgerValidation.evidence_claim_results,
    production_ledger_enforced: Boolean(evidenceLedgerValidation.evidence_claim_results),
  });
  if (!authoritativePromotionEvidencePolicy.ok) {
    await durableResolution.context?.close?.();
    return errorResponse("dojo_permission_upgrade_promotion_evidence_policy_failed", {
      ok: false,
      request_id: requestId,
      requested_action: updatedRequest.requested_action,
      required_steps: updatedRequest.required_steps,
      promotion_evidence_policy: authoritativePromotionEvidencePolicy.summary,
      blocked_by: authoritativePromotionEvidencePolicy.blocked_by,
    });
  }
  let licensePromotion = permissionUpgradeLicensePromotionFor(skill, updatedRequest);
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  let controlPlanePersistence: Record<string, unknown> = {
    ok: true,
    store_kind: "compatibility_registry",
    license_promotion_status: licensePromotion.status,
  };
  try {
    if (durableResolution.context) {
      await durableResolution.context.governance_store.savePermissionUpgradeRequest(review.request);
      if (licensePromotion.applied) {
        const reviewer = updatedRequest.reviewed_by ?? {
          actor_id: reviewerActorId,
          actor_type: reviewerActorType,
        };
        const reviewedAt = updatedRequest.reviewed_at ?? new Date().toISOString();
        const skillRecord = await durableResolution.context.skill_store.saveSkill(licensePromotion.skill, {
          status: "published",
          created_by: reviewer,
          now: reviewedAt,
        });
        const licenseRecord = await durableResolution.context.license_store.saveLicense(licensePromotion.skill.permission_license, {
          readiness_level: licensePromotion.skill.skill_readiness_level,
          status: "active",
          expires_at: licensePromotion.skill.license_expires_at,
          created_by: reviewer,
          now: reviewedAt,
        });
        skill = licensePromotion.skill;
        controlPlanePersistence = {
          ok: true,
          store_kind: durableResolution.context.source,
          license_promotion_status: licensePromotion.status,
          skill_id: skillRecord.skill_id,
          skill_version: skillRecord.current_skill_version,
          license_id: licenseRecord.license_id,
          previous_license_version: licensePromotion.previous_license_version,
          license_version: licenseRecord.license_version,
          requested_action: updatedRequest.requested_action,
          license_action_status: licensePromotion.license_action_status,
        };
      } else {
        controlPlanePersistence = {
          ok: true,
          store_kind: durableResolution.context.source,
          license_promotion_status: licensePromotion.status,
          requested_action: updatedRequest.requested_action,
        };
      }
      controlPlaneSource = durableResolution.context.source;
    }
  } finally {
    await durableResolution.context?.close?.();
  }
  if (!durableResolution.context) {
    updatedRequest = dojoSkillRegistry.recordPermissionUpgradeRequest(review.request);
    licensePromotion = permissionUpgradeLicensePromotionFor(skill, updatedRequest);
    if (licensePromotion.applied) {
      skill = dojoSkillRegistry.publish(licensePromotion.skill);
      licensePromotion = {
        ...licensePromotion,
        skill,
      };
      controlPlanePersistence = {
        ok: true,
        store_kind: "compatibility_registry",
        license_promotion_status: licensePromotion.status,
        skill_id: skill.skill_id,
        skill_version: skill.skill_version,
        license_id: skill.permission_license.license_id,
        previous_license_version: licensePromotion.previous_license_version,
        license_version: skill.permission_license.license_version,
        requested_action: updatedRequest.requested_action,
        license_action_status: licensePromotion.license_action_status,
      };
    }
  }
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
    request_id: requestId,
    decision,
    permission_upgrade_request: updatedRequest,
    permission_upgrade_license_promotion: licensePromotion.summary,
    control_plane_persistence: controlPlanePersistence,
    evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
    promotion_evidence_policy: authoritativePromotionEvidencePolicy.summary,
    license: skill.permission_license,
    review,
    governance_service: buildDojoGovernanceServiceView({
      skills: [skill],
      case_law_records: visibleDojoCaseLawRecordsForTenant(authorization.tenant, [skill]),
      permission_upgrade_requests: [updatedRequest],
      now: updatedRequest.reviewed_at,
    }),
  });
}

async function dojoReviewCaseLawTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const caseId = stringOpt(a["case_id"]);
  if (!caseId) return errorResponse("dojo_case_law_case_id_required");
  const decision = caseLawReviewDecisionOpt(a["decision"]);
  if (!decision) return errorResponse("dojo_case_law_decision_required", {
    allowed_decisions: ["approved", "deprecated"],
  });
  const reviewerActorId = stringOpt(a["reviewer_actor_id"]);
  if (!reviewerActorId) return errorResponse("dojo_case_law_reviewer_required");
  const reviewerActorType = actorTypeInputOpt(a["reviewer_actor_type"]);
  if (!reviewerActorType) return errorResponse("dojo_case_law_reviewer_actor_type_required");
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_review_case_law", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;

  const durableResolution = await caseLawReviewContextFromDurableControlPlaneIfRequired(args, caseId);
  if (!durableResolution.ok) return durableResolution.error;

  const selectedSkill = durableResolution.context?.skill ?? skillByArgs(args);
  const storedRecord = durableResolution.context?.record ?? dojoSkillRegistry.getCaseLawRecord(caseId);
  const skillLocalRecord = !storedRecord && selectedSkill
    ? caseLawRecordsForSkill(selectedSkill).find((record) => record.case_id === caseId)
    : undefined;
  const record = storedRecord ?? (skillLocalRecord ? dojoSkillRegistry.recordCaseLawRecord(skillLocalRecord) : null);
  if (!record) {
    await durableResolution.context?.close?.();
    return errorResponse("dojo_case_law_not_found", { case_id: caseId });
  }
  const authorization = durableResolution.context
    ? {
        ok: true as const,
        tenant: durableResolution.context.tenant,
        scopedSkill: durableResolution.context.skill,
        visibleSkills: [durableResolution.context.skill],
      }
    : authorizeTenantForCaseLawRecord(args, record, selectedSkill);
  if (!authorization.ok) return authorization.error;
  const productionGovernanceRbacRequired = resolveDojoEnforcementConfig().production_enforcement;

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
    tenant_context: productionGovernanceRbacRequired ? authorization.tenant : undefined,
    require_rbac: productionGovernanceRbacRequired,
  });
  if (!review.ok) {
    await durableResolution.context?.close?.();
    return errorResponse(review.error ?? "dojo_case_law_review_rejected", {
      case_id: caseId,
      review,
    });
  }

  const scopedSkill = selectedSkill ?? authorization.scopedSkill;
  if (!scopedSkill) {
    await durableResolution.context?.close?.();
    return errorResponse("dojo_case_law_skill_required", {
      ok: false,
      case_id: caseId,
      operation: "synthi_dojo_review_case_law",
      blocked_by: ["case_law_skill_scope_required"],
    });
  }
  const evidenceLedgerValidation = await validateCaseLawEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_review_case_law",
    tenant: authorization.tenant,
    skill: scopedSkill,
    evidence_refs: review.case_law.evidence_refs,
    checked_at: review.case_law.updated_at,
  });
  if (!evidenceLedgerValidation.ok) {
    await durableResolution.context?.close?.();
    return evidenceLedgerValidation.error;
  }
  let updatedRecord = review.case_law;
  let updatedSkill = scopedSkill?.case_law.some((item) => item.case_id === updatedRecord.case_id)
    ? applyCaseLawReviewToSkill(scopedSkill, updatedRecord)
    : scopedSkill;
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  try {
    if (durableResolution.context) {
      await durableResolution.context.governance_store.saveCaseLawRecord(updatedRecord);
      if (updatedSkill && updatedSkill !== scopedSkill) {
        await durableResolution.context.skill_store.saveSkill(updatedSkill, {
          status: "published",
          created_by: {
            actor_id: reviewerActorId,
            actor_type: reviewerActorType,
          },
          now: updatedRecord.updated_at,
        });
      }
      controlPlaneSource = durableResolution.context.source;
    }
  } finally {
    await durableResolution.context?.close?.();
  }
  if (!durableResolution.context) {
    updatedRecord = dojoSkillRegistry.recordCaseLawRecord(review.case_law);
    updatedSkill = scopedSkill?.case_law.some((item) => item.case_id === updatedRecord.case_id)
      ? dojoSkillRegistry.publish(applyCaseLawReviewToSkill(scopedSkill, updatedRecord))
      : scopedSkill;
  }
  const governanceSkills = updatedSkill ? [updatedSkill] : authorization.visibleSkills;
  const governanceCaseLawRecords = durableResolution.context
    ? [updatedRecord]
    : visibleDojoCaseLawRecordsForTenant(authorization.tenant, governanceSkills);
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
    case_id: caseId,
    decision,
    case_law_record: updatedRecord,
    review,
    evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
    ...(updatedSkill ? { skill_id: updatedSkill.skill_id, skill: skillListItem(updatedSkill) } : {}),
    governance_service: buildDojoGovernanceServiceView({
      skills: governanceSkills,
      case_law_records: governanceCaseLawRecords,
      permission_upgrade_requests: visibleDojoPermissionUpgradeRequestsForSkills(governanceSkills),
      now: updatedRecord.updated_at,
    }),
  });
}

async function dojoRunScheduledGovernanceJobsTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext.error;
  const tenant = tenantContext.tenant;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const dryRun = optionalBoolOpt(a["dry_run"]) ?? true;
  const limit = numberOpt(a["limit"]);
  if (limit !== undefined && limit < 0) {
    return errorResponse("dojo_scheduled_governance_job_limit_invalid", {
      ok: false,
      operation: "synthi_dojo_run_scheduled_governance_jobs",
      limit,
      blocked_by: ["scheduled_job_limit_negative"],
    });
  }
  const requestedKinds = scheduledJobKindSetFromInput(a["job_kinds"]);
  if (!requestedKinds.ok) {
    return errorResponse("dojo_scheduled_governance_job_kind_invalid", {
      ok: false,
      operation: "synthi_dojo_run_scheduled_governance_jobs",
      invalid_job_kinds: requestedKinds.invalid,
      allowed_job_kinds: SCHEDULED_GOVERNANCE_JOB_KINDS,
      blocked_by: ["scheduled_job_kind_invalid"],
    });
  }

  const rbac = requireDojoProductionGovernanceRbac({
    tenant,
    action: "scheduled_job_run",
    error: "dojo_scheduled_governance_job_role_required",
    details: {
      operation: "synthi_dojo_run_scheduled_governance_jobs",
      workspace_id: tenant.workspace_id,
      dry_run: dryRun,
    },
  });
  if (!rbac.ok) return rbac.error;

  const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
    tenant,
    "synthi_dojo_run_scheduled_governance_jobs"
  );
  if (!visibleSkills.ok) return visibleSkills.error;
  const governanceService = await governanceServiceViewForTenant(tenant, now, visibleSkills.skills);
  const requestedJobIds = new Set(stringArrayOpt(a["job_ids"]));
  const jobs = governanceService.scheduled_jobs.filter((job) => {
    if (requestedJobIds.size > 0 && !requestedJobIds.has(job.job_id)) return false;
    if (requestedKinds.kinds.size > 0 && !requestedKinds.kinds.has(job.kind)) return false;
    return true;
  });

  let resolution: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>> | undefined;
  if (!dryRun) {
    const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_scheduled_governance_jobs", {
      postgres_wired: true,
    });
    if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
    const enforcement = resolveDojoEnforcementConfig();
    if (enforcement.production_enforcement && enforcement.require_durable_store) {
      resolution = await createDojoControlPlaneStoresFromEnv({ tenant });
      if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_run_scheduled_governance_jobs", resolution);
    }
  }

  try {
    const handlers = buildScheduledGovernanceJobHandlersForTool({
      dry_run: dryRun,
      tenant,
      now,
      skills: visibleSkills.skills,
      governance_service: governanceService,
      license_store: resolution?.ok ? resolution.license_store : undefined,
    });
    const run = await runDojoScheduledGovernanceJobs({
      jobs,
      handlers,
      actor: {
        actor_id: tenant.actor_id,
        actor_type: tenant.actor_type,
      },
      tenant_context: tenant,
      now,
      limit,
    });
    const auditPersistence = dryRun
      ? undefined
      : await persistDojoScheduledJobRunAuditEvents({
        run,
        audit_store: resolution?.ok ? resolution.audit_store : dojoHostedRuntimeAuditStore,
        tenant_context: tenant,
        request_id: tenant.request_id,
        correlation_id: tenant.correlation_id,
      });

    return jsonResponse({
      ok: true,
      control_plane_source: resolution?.ok ? "postgres" : visibleSkills.control_plane_source,
      dry_run: dryRun,
      selected_job_count: jobs.length,
      selected_job_ids: jobs.map((job) => job.job_id),
      selected_job_kinds: [...new Set(jobs.map((job) => job.kind))].sort(),
      scheduled_job_run: run,
      ...(auditPersistence ? { scheduled_job_audit_persistence: auditPersistence } : {}),
      governance_service: governanceService,
      ...(rbac.rbac_authorization ? { rbac_authorization: rbac.rbac_authorization } : {}),
    });
  } finally {
    if (resolution?.ok) await resolution.close?.();
  }
}

function dojoGenerateVivariumScenariosTool(args: unknown): ToolResponse {
  const workflow = requiredAuthorizedWorkflowArtifact(args);
  if (!workflow.ok) return workflow.error;
  const seed = extractDojoSkillSeed(workflow.artifact.workflow.contract, { workspace_id: workflow.workspace_id });
  const scenarios = generateDojoVivariumScenarios(seed);
  return jsonResponse({
    ok: true,
    workflow_id: workflow.artifact.workflow_id,
    tenant_context: workflow.tenant,
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
        identity: { auth_required: workflow.artifact.workflow.contract.authPlan.required },
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
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_vivarium_scenario");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_run_vivarium_scenario",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_vivarium_scenario", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const a = obj(args);
  const scenarioRun = await runDojoVivariumScenario(skill.skill, {
    scenario_id: stringOpt(a["scenario_id"]),
    mutation_kind: stringOpt(a["mutation_kind"]),
    now: stringOpt(a["now"]),
    tenant_context: skill.tenant,
  });
  const updated = skillWithDojoRuns(skill.skill, [scenarioRun.run], undefined, {
    now: scenarioRun.run.finished_at,
  });
  const durablePersistence = await persistVivariumRunsToDurableControlPlaneIfRequired({
    tenant: skill.tenant,
    skill: skill.skill,
    updated_skill: updated,
    runs: [scenarioRun],
    operation: "synthi_dojo_run_vivarium_scenario",
    now: scenarioRun.run.finished_at,
  });
  if (!durablePersistence.ok) return durablePersistence.error;
  const persisted = skill.control_plane_source === "compatibility_registry"
    ? dojoSkillRegistry.publish(updated)
    : updated;
  return jsonResponse({
    ok: true,
    control_plane_source: durablePersistence.persistence ? "postgres" : skill.control_plane_source,
    skill_id: persisted.skill_id,
    vivarium_run: scenarioRun,
    persisted_skill: skillListItem(persisted),
    control_plane_persistence: durablePersistence.persistence ?? null,
    license_health: await licenseHealthFor(persisted, skill.tenant),
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function dojoRunWindTunnelTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_wind_tunnel");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_run_wind_tunnel",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_wind_tunnel", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const a = obj(args);
  const tunnel = await runDojoWindTunnel(skill.skill, {
    max_scenarios: numberOpt(a["max_scenarios"]),
    now: stringOpt(a["now"]),
    tenant_context: skill.tenant,
  });
  const completedAt = tunnel.runs
    .map((run) => run.run.finished_at)
    .sort()
    .at(-1) ?? new Date().toISOString();
  const updated = skillWithDojoRuns(skill.skill, tunnel.runs.map((run) => run.run), tunnel, {
    now: completedAt,
  });
  const durablePersistence = await persistVivariumRunsToDurableControlPlaneIfRequired({
    tenant: skill.tenant,
    skill: skill.skill,
    updated_skill: updated,
    runs: tunnel.runs,
    operation: "synthi_dojo_run_wind_tunnel",
    now: completedAt,
  });
  if (!durablePersistence.ok) return durablePersistence.error;
  const persisted = skill.control_plane_source === "compatibility_registry"
    ? dojoSkillRegistry.publish(updated)
    : updated;
  return jsonResponse({
    ok: true,
    control_plane_source: durablePersistence.persistence ? "postgres" : skill.control_plane_source,
    skill_id: persisted.skill_id,
    wind_tunnel_execution: tunnel,
    persisted_skill: skillListItem(persisted),
    control_plane_persistence: durablePersistence.persistence ?? null,
    license_health: await licenseHealthFor(persisted, skill.tenant),
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function dojoRunEvilTwinTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_evil_twin");
  if (!skill.ok) return skill.error;
  const practiceRunRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "practice_run",
    error: "dojo_practice_run_role_required",
    details: {
      operation: "synthi_dojo_run_evil_twin",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!practiceRunRbac.ok) return practiceRunRbac.error;
  const a = obj(args);
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const runtimeSkill = withExecutableCheckrideGuardrails(skill.skill);
  const compiledGraph = compileDojoSkillGraphForSkill(runtimeSkill, {
    mode: "checkride",
    created_at: now,
  });
  const scenarioDefinitions = toDojoScenarioDefinitions(runtimeSkill.scenarios, {
    target_graph_node_ids: ["action"],
  });
  const buildInputs = ({ materialized }: { materialized: DojoMaterializedScenario }) =>
    buildDojoVivariumGraphInputsForFixture(runtimeSkill, materialized.fixture);
  const runtimeInput = {
    graph: compiledGraph.graph,
    scenarios: scenarioDefinitions,
    max_attacks: numberOpt(a["max_attacks"]),
    build_inputs: buildInputs,
    now,
  };
  const evilTwinRuntime = await runDojoEvilTwin(runtimeInput);
  const hardening = boolOpt(a["harden"])
    ? await hardenDojoEvilTwinAttacks(runtimeInput)
    : null;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    graph_validation: compiledGraph.validation,
    evil_twin_runtime: evilTwinRuntime,
    hardening,
    license_health: await licenseHealthFor(skill.skill, skill.tenant),
    ...(practiceRunRbac.rbac_authorization ? { rbac_authorization: practiceRunRbac.rbac_authorization } : {}),
  });
}

async function dojoRunCheckrideTool(args: unknown): Promise<ToolResponse> {
  const workflow = requiredAuthorizedWorkflowArtifact(args);
  if (!workflow.ok) return workflow.error;
  const checkrideRunRbac = requireDojoProductionGovernanceRbac({
    tenant: workflow.tenant,
    action: "checkride_run",
    error: "dojo_checkride_run_role_required",
    details: {
      operation: "synthi_dojo_run_checkride",
      workflow_id: workflow.artifact.workflow_id,
      workspace_id: workflow.workspace_id,
    },
  });
  if (!checkrideRunRbac.ok) return checkrideRunRbac.error;
  const a = obj(args);
  const contract = workflow.artifact.workflow.contract;
  const workspaceId = workflow.workspace_id;
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
  const compiledGraph = compileDojoSkillGraphFromContract(contract, runtimeSkill, {
    mode: "checkride",
    created_at: now,
  });
  const scenarioDefinitions = toDojoScenarioDefinitions(scenarios, {
    target_graph_node_ids: [],
    expected_outcome_overrides: expectedOutcomeOverridesForExecutableCheckride(contract),
  });
  const scenarioDefinitionValidation = scenarioDefinitions.map((scenario) => ({
    scenario_id: scenario.scenario_id,
    validation: validateDojoScenarioDefinition(scenario),
  }));
  const executableCheckride = await runDojoExecutableCheckride({
    graph: compiledGraph.graph,
    scenarios: scenarioDefinitions,
    base_inputs: checkrideRuntimeInputsFor(runtimeSkill),
    build_inputs: ({ materialized }) => buildDojoVivariumGraphInputsForFixture(runtimeSkill, materialized.fixture),
    evidence_context: {
      tenant_id: workflow.tenant.tenant_id,
      workspace_id: workflow.tenant.workspace_id,
      skill_id: runtimeSkill.skill_id,
      created_at: now,
      created_by: workflow.tenant.actor_id,
      run_id_prefix: `checkride_${hashId(`${runtimeSkill.skill_id}:${now}`)}`,
    },
    now,
  });
  return jsonResponse({
    ok: true,
    workflow_id: workflow.artifact.workflow_id,
    tenant_context: workflow.tenant,
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
    ...(checkrideRunRbac.rbac_authorization ? { rbac_authorization: checkrideRunRbac.rbac_authorization } : {}),
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
    durable_state_verification_available: true,
    durable_state_evidence: true,
    mutation_isolation_available: true,
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

function expectedOutcomeOverridesForExecutableCheckride(
  contract: WorkflowContractV7
): Record<string, DojoScenarioExpectedOutcome> {
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) return {};
  return {
    fake_success: "pass",
    partial_write: "pass",
  };
}

interface DojoPublicationExecutableCheckride {
  executable_checkride: DojoExecutableCheckrideReport;
  entrustment_decision: ReturnType<typeof decideDojoEntrustment>;
  readiness_decision: ReturnType<typeof decideDojoSkillReadiness>;
  evidence_policy: {
    require_evidence_ledger: boolean;
    evidence_backed: boolean;
    evidence_backing: "ledger" | "inline_or_ledger";
    evidence_ledger_store_kind: string;
    configured_env: string[];
    ledger_record_count: number;
    scenario_count: number;
  };
}

async function executableCheckrideForSkillPublication(input: {
  skill: DojoSkill;
  contract: WorkflowContractV7;
  tenant: DojoTenantContext;
  now: string;
}): Promise<{ ok: true; publication_checkride: DojoPublicationExecutableCheckride } | { ok: false; error: ToolResponse }> {
  const ledgerResolution = await resolvePublicationCheckrideEvidenceLedger(input.tenant, input.skill);
  if (!ledgerResolution.ok) return { ok: false, error: ledgerResolution.error };
  const runtimeSkill = withExecutableCheckrideGuardrails(input.skill);
  const compiledGraph = compileDojoSkillGraphFromContract(input.contract, runtimeSkill, {
    mode: "checkride",
    created_at: input.now,
  });
  const scenarioDefinitions = toDojoScenarioDefinitions(runtimeSkill.scenarios, {
    target_graph_node_ids: [],
    expected_outcome_overrides: expectedOutcomeOverridesForExecutableCheckride(input.contract),
  });
  let executableCheckride: DojoExecutableCheckrideReport;
  try {
    executableCheckride = await runDojoExecutableCheckride({
      graph: compiledGraph.graph,
      scenarios: scenarioDefinitions,
      base_inputs: checkrideRuntimeInputsFor(runtimeSkill),
      build_inputs: ({ materialized }) => buildDojoVivariumGraphInputsForFixture(runtimeSkill, materialized.fixture),
      evidence_context: {
        tenant_id: input.tenant.tenant_id,
        workspace_id: input.tenant.workspace_id,
        skill_id: runtimeSkill.skill_id,
        created_at: input.now,
        created_by: input.tenant.actor_id,
        run_id_prefix: `publish_checkride_${hashId(`${runtimeSkill.skill_id}:${input.now}`)}`,
      },
      ...(ledgerResolution.evidence_ledger ? { evidence_ledger: ledgerResolution.evidence_ledger } : {}),
      require_evidence_ledger: ledgerResolution.require_evidence_ledger,
      now: input.now,
    });
  } catch (err) {
    if (!ledgerResolution.require_evidence_ledger) throw err;
    return {
      ok: false,
      error: errorResponse("dojo_publication_evidence_ledger_append_failed", {
        ok: false,
        operation: "synthi_dojo_publish_or_recertify_skill",
        skill_id: runtimeSkill.skill_id,
        workspace_id: input.tenant.workspace_id,
        enforcement_mode: "production",
        require_evidence_ledger: true,
        evidence_ledger_store_kind: ledgerResolution.evidence_ledger_store_kind,
        configured_env: ledgerResolution.configured_env,
        blocked_by: ["publication_checkride_evidence_ledger_append_failed"],
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  } finally {
    await ledgerResolution.close?.();
  }
  const graphHasBlockingGuardrails = hasExecutableBlockingGuardrails(compiledGraph.graph);
  const inlineOrLedgerEvidenceBacked = executableCheckride.evidence_refs.length >= executableCheckride.scenario_count
    && executableCheckride.results.every((result) => Boolean(result.evidence_record ?? result.ledger_record));
  const ledgerEvidenceBacked = executableCheckride.scenario_count > 0
    && executableCheckride.ledger_record_count >= executableCheckride.scenario_count
    && executableCheckride.results.every((result) => Boolean(result.ledger_record));
  const evidenceBacked = ledgerResolution.require_evidence_ledger
    ? ledgerEvidenceBacked
    : inlineOrLedgerEvidenceBacked;
  const entrustmentDecision = decideDojoEntrustment({
    checkride: executableCheckride,
    guardrails_active: graphHasBlockingGuardrails,
    evidence_backed: evidenceBacked,
    evidence_fresh: true,
    stable_substrate_available: hasStableExecutionSubstrate(runtimeSkill),
    shadow_runs_match: false,
  });
  const readinessDecision = decideDojoSkillReadiness({
    raw_trace_exists: runtimeSkill.skill_seed.observed_trace.step_count > 0,
    seed_exists: true,
    graph_compiled: compiledGraph.validation.ok,
    assertions_defined: runtimeSkill.skill_seed.candidate_success_assertions.length > 0,
    organoid_generated: runtimeSkill.workspace_organoid.data_policy.synthetic_data_only,
    checkride: executableCheckride,
    shadow_runs_match: false,
    limited_production_license_issued: entrustmentDecision.production_recommendation !== "blocked",
    stable_substrate_available: hasStableExecutionSubstrate(runtimeSkill),
    monitoring_active: false,
    case_law_feedback_active: runtimeSkill.case_law.length > 0,
  });
  return {
    ok: true,
    publication_checkride: {
      executable_checkride: executableCheckride,
      entrustment_decision: entrustmentDecision,
      readiness_decision: readinessDecision,
      evidence_policy: {
        require_evidence_ledger: ledgerResolution.require_evidence_ledger,
        evidence_backed: evidenceBacked,
        evidence_backing: ledgerResolution.require_evidence_ledger ? "ledger" : "inline_or_ledger",
        evidence_ledger_store_kind: ledgerResolution.evidence_ledger_store_kind,
        configured_env: ledgerResolution.configured_env,
        ledger_record_count: executableCheckride.ledger_record_count,
        scenario_count: executableCheckride.scenario_count,
      },
    },
  };
}

function hasExecutableBlockingGuardrails(graph: DojoSkillGraph): boolean {
  return graph.nodes.some((node) => (
    (node.kind === "Action" || node.kind === "Guardrail")
    && node.guardrails.some((guardrail) => guardrail.severity === "block")
  ));
}

async function resolvePublicationCheckrideEvidenceLedger(
  tenant: DojoTenantContext,
  skill: DojoSkill
): Promise<
  | {
      ok: true;
      require_evidence_ledger: boolean;
      evidence_ledger_store_kind: string;
      configured_env: string[];
      evidence_ledger?: DojoEvidenceLedgerAppendStore;
      close?: () => Promise<void>;
    }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  const ledgerStore = resolveDojoEvidenceLedgerStoreConfig();
  const requireEvidenceLedger = enforcement.production_enforcement && enforcement.require_evidence_ledger;
  if (!requireEvidenceLedger) {
    return {
      ok: true,
      require_evidence_ledger: false,
      evidence_ledger_store_kind: ledgerStore.store_kind,
      configured_env: ledgerStore.configured_env,
    };
  }

  const resolution = await resolveDojoEvidenceLedgerAppendStore({
    tenant_id: tenant.tenant_id,
    workspace_id: tenant.workspace_id,
    tenant_context: tenant,
    app_origin: skill.app_origin,
  });
  if (!resolution.ok || !resolution.evidence_ledger) {
    return {
      ok: false,
      error: errorResponse("dojo_publication_evidence_ledger_required", {
        ok: false,
        operation: "synthi_dojo_publish_or_recertify_skill",
        enforcement_mode: enforcement.enforcement_mode,
        require_evidence_ledger: true,
        evidence_ledger_store_kind: resolution.store_kind,
        evidence_ledger_configured: ledgerStore.configured,
        configured_env: [...new Set([...enforcement.configured_env, ...resolution.configured_env])],
        required_env: [
          "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1",
          "SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER=1",
          "SYNTHI_DOJO_EVIDENCE_LEDGER_STORE=postgres",
          "SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL",
        ],
        blocked_by: resolution.blocked_by,
        error_codes: ["proof_evidence_claim_unverified"],
        message: "Production skill publication and recertification require executable checkride evidence to be appended to the configured evidence ledger.",
      }),
    };
  }
  if (!resolution.queryable) {
    await resolution.close?.();
    return {
      ok: false,
      error: errorResponse("dojo_publication_evidence_ledger_required", {
        ok: false,
        operation: "synthi_dojo_publish_or_recertify_skill",
        enforcement_mode: enforcement.enforcement_mode,
        require_evidence_ledger: true,
        evidence_ledger_store_kind: resolution.store_kind,
        evidence_ledger_configured: ledgerStore.configured,
        configured_env: [...new Set([...enforcement.configured_env, ...resolution.configured_env])],
        blocked_by: ["evidence_ledger_postgres_queryable_missing"],
        error_codes: ["proof_evidence_claim_unverified"],
      }),
    };
  }
  try {
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenant.tenant_id,
      workspace_id: tenant.workspace_id,
      queryable: resolution.queryable,
    });
    await skillStore.saveSkill(skill, {
      status: "draft",
      created_by: {
        actor_id: tenant.actor_id,
        actor_type: tenant.actor_type,
      },
      now: skill.generated_at,
    });
  } catch (err) {
    await resolution.close?.();
    return {
      ok: false,
      error: errorResponse("dojo_publication_evidence_ledger_scope_required", {
        ok: false,
        operation: "synthi_dojo_publish_or_recertify_skill",
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        enforcement_mode: enforcement.enforcement_mode,
        require_evidence_ledger: true,
        evidence_ledger_store_kind: resolution.store_kind,
        evidence_ledger_configured: ledgerStore.configured,
        configured_env: [...new Set([...enforcement.configured_env, ...resolution.configured_env])],
        blocked_by: ["evidence_ledger_skill_scope_initialization_failed"],
        error_codes: ["proof_evidence_claim_unverified"],
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  return {
    ok: true,
    require_evidence_ledger: true,
    evidence_ledger_store_kind: resolution.store_kind,
    configured_env: [...new Set([...enforcement.configured_env, ...resolution.configured_env])],
    evidence_ledger: resolution.evidence_ledger,
    close: resolution.close,
  };
}

function applyExecutableCheckrideToPublishedSkill(
  skill: DojoSkill,
  publicationCheckride: DojoPublicationExecutableCheckride,
  source: DojoExecutableEntrustmentSnapshot["source"]
): DojoSkill {
  const updated = cloneJson(skill);
  const decision = publicationCheckride.entrustment_decision;
  const readiness = publicationCheckride.readiness_decision;
  const license = {
    ...updated.permission_license,
    license_id: `license_${hashId(`${updated.workflow_id}:${publicationCheckride.executable_checkride.checkride_id}:${decision.level}:${decision.production_recommendation}`)}`,
    entrustment_level: decision.level,
    autonomy_level: autonomyLevelForEntrustment(decision.level),
  };
  const constrainedRunWorkflow = constrainRunWorkflowAction(
    license.allowed_actions,
    publicationCheckride.executable_checkride
  );
  if (decision.production_recommendation === "blocked" || decision.level === "EX") {
    license.allowed_actions = license.allowed_actions.filter((action) => action.action !== "run_workflow");
    license.blocked_actions = upsertLicenseAction(license.blocked_actions, {
      action: "run_workflow",
      constraints: [
        "executable_checkride_not_passed",
        ...decision.blocked_by,
      ],
    });
  } else {
    license.allowed_actions = constrainedRunWorkflow;
  }
  updated.permission_license = license;
  updated.entrustment_level = decision.level;
  updated.skill_readiness_level = readiness.level;
  updated.coverage_score = publicationCheckride.executable_checkride.coverage_score;
  updated.executable_entrustment = executableEntrustmentSnapshotFor(publicationCheckride, source);
  updated.license_expires_at = licenseExpiresAtFromIssuedAt(license.issued_at);
  updated.skill_card = {
    ...updated.skill_card,
    status: `Licensed ${license.entrustment_level}`,
    can_do_alone: license.allowed_actions.map((action) => action.action),
    will_ask_before: license.gated_actions.map((action) => action.action),
    will_not_do: license.blocked_actions.map((action) => action.action),
    proof_badge: license.proof_requirements.required_evidence_claims.length > 0 ? "Proof required" : "Proof optional",
  };
  updated.skill_passport = {
    ...updated.skill_passport,
    passport_id: `passport_${hashId(`${updated.skill_id}:${updated.skill_version}:${license.license_id}`)}`,
    entrustment_level: license.entrustment_level,
    readiness_level: readiness.level,
    license_id: license.license_id,
    proof_required: license.proof_requirements.required_evidence_claims.length > 0,
    coverage_score: updated.coverage_score,
    attack_success_rate: updated.attack_success_rate,
    license_expires_at: updated.license_expires_at,
    published_tools: [
      ...new Set([
        ...updated.skill_passport.published_tools,
        ...(updated.published_tool_name ? [updated.published_tool_name] : []),
      ]),
    ],
    issued_at: license.issued_at,
  };
  updated.assurance_case = {
    ...updated.assurance_case,
    claim: `This skill is licensed at ${license.entrustment_level} for ${updated.skill_seed.inferred_intent} under executable checkride constraints.`,
    argument: `${updated.assurance_case.argument} Executable checkride result: ${publicationCheckride.executable_checkride.passed_scenarios}/${publicationCheckride.executable_checkride.scenario_count} passed, ${publicationCheckride.executable_checkride.blocked_scenarios} blocked, ${publicationCheckride.executable_checkride.failed_scenarios} failed, critical failures ${publicationCheckride.executable_checkride.critical_failures}.`,
    evidence_refs: [...new Set([
      ...updated.assurance_case.evidence_refs,
      ...publicationCheckride.executable_checkride.evidence_refs,
    ])],
    limits: [...new Set([
      ...updated.assurance_case.limits,
      ...decision.limitations,
      ...publicationCheckride.executable_checkride.license_constraints.map((constraint) => constraint.reason),
    ])],
  };
  return updated;
}

function executableEntrustmentSnapshotFor(
  publicationCheckride: DojoPublicationExecutableCheckride,
  source: DojoExecutableEntrustmentSnapshot["source"]
): DojoExecutableEntrustmentSnapshot {
  const checkride = publicationCheckride.executable_checkride;
  const entrustment = publicationCheckride.entrustment_decision;
  const readiness = publicationCheckride.readiness_decision;
  return {
    schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
    source,
    checkride_id: checkride.checkride_id,
    generated_at: checkride.finished_at,
    started_at: checkride.started_at,
    finished_at: checkride.finished_at,
    scenario_count: checkride.scenario_count,
    passed_scenarios: checkride.passed_scenarios,
    failed_scenarios: checkride.failed_scenarios,
    blocked_scenarios: checkride.blocked_scenarios,
    critical_failures: checkride.critical_failures,
    coverage_score: checkride.coverage_score,
    production_recommendation: checkride.production_recommendation,
    license_constraints: checkride.license_constraints.map((constraint) => ({ ...constraint })),
    entrustment_decision: {
      level: entrustment.level,
      production_recommendation: entrustment.production_recommendation,
      blocked_by: [...entrustment.blocked_by],
      limitations: [...entrustment.limitations],
      evidence_refs: [...entrustment.evidence_refs],
    },
    readiness_decision: {
      level: readiness.level,
      blocked_by: [...readiness.blocked_by],
      next_required: [...readiness.next_required],
    },
    evidence_refs: [...checkride.evidence_refs],
    ledger_checkpoint_hashes: [...checkride.ledger_checkpoint_hashes],
  };
}

function constrainRunWorkflowAction(
  actions: DojoSkill["permission_license"]["allowed_actions"],
  checkride: DojoExecutableCheckrideReport
): DojoSkill["permission_license"]["allowed_actions"] {
  if (checkride.license_constraints.length === 0) return actions;
  return actions.map((action) => action.action === "run_workflow"
    ? {
        ...action,
        constraints: [...new Set([
          ...action.constraints,
          "executable_checkride_constrained",
          ...checkride.license_constraints.map((constraint) => `${constraint.constraint_kind}:${constraint.mutation_kind}`),
        ])],
      }
    : action);
}

function upsertLicenseAction<T extends { action: string; constraints: string[] }>(actions: T[], next: T): T[] {
  const existing = actions.find((action) => action.action === next.action);
  if (!existing) return [...actions, next];
  return actions.map((action) => action.action === next.action
    ? { ...action, constraints: [...new Set([...action.constraints, ...next.constraints])] }
    : action);
}

function hasStableExecutionSubstrate(skill: DojoSkill): boolean {
  return skill.execution_substrates.some((substrate) => substrate === "mcp" || substrate === "api" || substrate === "source");
}

function autonomyLevelForEntrustment(level: DojoSkill["entrustment_level"]): DojoSkill["permission_license"]["autonomy_level"] {
  switch (level) {
    case "E0":
      return "observe";
    case "E1":
      return "practice";
    case "E2":
      return "draft";
    case "E3":
      return "submit_limited";
    case "E4":
      return "submit_gated";
    case "E5":
      return "submit_gated";
    case "EX":
      return "blocked";
  }
}

function licenseExpiresAtFromIssuedAt(issuedAt: string): string {
  const issued = Date.parse(issuedAt);
  const base = Number.isFinite(issued) ? issued : Date.now();
  return new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();
}

async function dojoPublishSkillTool(args: unknown): Promise<ToolResponse> {
  const workflow = requiredAuthorizedWorkflowArtifact(args);
  if (!workflow.ok) return workflow.error;
  const a = obj(args);
  const workspaceId = workflow.workspace_id;
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_skill_publication_reason_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_skill_publication_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_skill_publication_actor_type_required");
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  if (evidenceRefs.length === 0) return errorResponse("dojo_skill_publication_evidence_required");
  const enforcement = resolveDojoEnforcementConfig();
  const skillPublicationRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: workflow.tenant,
      action: "skill_publication",
    })
    : undefined;
  if (skillPublicationRbacAuthorization && !skillPublicationRbacAuthorization.ok) {
    return errorResponse("dojo_skill_publication_role_required", {
      ok: false,
      workflow_id: workflow.artifact.workflow_id,
      workspace_id: workspaceId,
      actor_id: workflow.tenant.actor_id,
      actor_type: workflow.tenant.actor_type,
      blocked_by: skillPublicationRbacAuthorization.blocked_by,
      rbac_authorization: skillPublicationRbacAuthorization,
    });
  }
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_publish_skill", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const contract = workflow.artifact.workflow.contract;
  const manifest = generatePrivateWorkflowToolManifest(contract);
  const backingToolPublication = backingPrivateToolPublicationPreflight(manifest, workflow.artifact);
  const candidateSkill = buildDojoSkill(contract, {
    workspace_id: workspaceId,
    now,
    private_tool_manifest: manifest,
    ...(backingToolPublication.ok ? { published_tool_name: backingToolPublication.tool_name } : {}),
  });
  const publicationCheckride = await executableCheckrideForSkillPublication({
    skill: candidateSkill,
    contract,
    tenant: workflow.tenant,
    now,
  });
  if (!publicationCheckride.ok) return publicationCheckride.error;
  const executableSkill = applyExecutableCheckrideToPublishedSkill(
    candidateSkill,
    publicationCheckride.publication_checkride,
    "publish"
  );
  const publicationEvidenceLedger = await validatePublicationEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_publish_skill",
    tenant: workflow.tenant,
    skill: executableSkill,
    evidence_refs: evidenceRefs,
    checked_at: now,
  });
  if (!publicationEvidenceLedger.ok) return publicationEvidenceLedger.error;
  const controlPlanePersistence = await persistPublishedSkillToDurableControlPlaneIfRequired({
    tenant: workflow.tenant,
    skill: executableSkill,
    actor: {
      actor_id: actorId,
      actor_type: actorType,
    },
    now,
  });
  if (!controlPlanePersistence.ok) return controlPlanePersistence.error;
  const skill = dojoSkillRegistry.publish(executableSkill);
  const publishedTool = publishBackingPrivateToolAfterSkillPublication({
    preflight: backingToolPublication,
    manifest,
    artifact: workflow.artifact,
  });
  const auditEvent = {
    event_type: "skill_version_created" as const,
    actor: {
      actor_id: actorId,
      actor_type: actorType,
    },
    occurred_at: now,
    workspace_id: skill.workspace_id,
    skill_id: skill.skill_id,
    license_id: skill.permission_license.license_id,
    tenant_context: workflow.tenant,
    reason,
    evidence_refs: evidenceRefs,
  };
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
    publication: {
      ok: true,
      status: "applied",
      reason,
      evidence_refs: evidenceRefs,
      executable_checkride: publicationCheckride.publication_checkride.executable_checkride,
      entrustment_decision: publicationCheckride.publication_checkride.entrustment_decision,
      readiness_decision: publicationCheckride.publication_checkride.readiness_decision,
      evidence_policy: publicationCheckride.publication_checkride.evidence_policy,
      evidence_ledger_validation: publicationEvidenceLedger.evidence_ledger_resolution ?? null,
      ...(skillPublicationRbacAuthorization ? { rbac_authorization: skillPublicationRbacAuthorization } : {}),
      audit_event: auditEvent,
      control_plane_persistence: controlPlanePersistence.persistence ?? {
        ok: true,
        store_kind: "compatibility_registry",
      },
    },
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(skill)),
  });
}

async function dojoRecertifySkillTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  let existing = skillByArgs(args);
  let existingControlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  let tenant: DojoTenantContext | null = null;
  const enforcement = resolveDojoEnforcementConfig();
  const hasExplicitSkillSelection = Boolean(stringOpt(a["skill_id"]) || stringOpt(a["workflow_id"]));
  if (!existing && hasExplicitSkillSelection && enforcement.production_enforcement && enforcement.require_durable_store) {
    const durableSkill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_recertify_skill");
    if (!durableSkill.ok) return durableSkill.error;
    existing = durableSkill.skill;
    existingControlPlaneSource = durableSkill.control_plane_source;
    tenant = durableSkill.tenant;
  }
  if (existing) {
    const authorization = authorizeTenantForDojoSkill(args, existing);
    if (!authorization.ok) return authorization.error;
    tenant = authorization.tenant;
  }
  const workflowId = existing?.workflow_id ?? stringOpt(a["workflow_id"]);
  const workflow = requiredAuthorizedWorkflowArtifact({
    ...a,
    workflow_id: workflowId,
    ...(existing ? { workspace_id: existing.workspace_id } : {}),
  });
  if (!workflow.ok) return workflow.error;
  if (!tenant) tenant = workflow.tenant;
  const workspaceId = existing?.workspace_id ?? workflow.workspace_id;
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_recertification_reason_required");
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  if (evidenceRefs.length === 0) return errorResponse("dojo_recertification_evidence_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_recertification_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_recertification_actor_type_required");
  const productionGovernanceRbacRequired = enforcement.production_enforcement;
  const recertificationRbacAuthorization = productionGovernanceRbacRequired
    ? authorizeDojoGovernanceAction({
      tenant_context: tenant,
      action: "license_recertification",
    })
    : undefined;
  if (recertificationRbacAuthorization && !recertificationRbacAuthorization.ok) {
    return errorResponse("dojo_license_recertification_role_required", {
      ok: false,
      skill_id: existing?.skill_id ?? "",
      license_id: existing?.permission_license.license_id ?? "",
      actor_id: actorId,
      actor_type: actorType,
      blocked_by: recertificationRbacAuthorization.blocked_by,
      rbac_authorization: recertificationRbacAuthorization,
    });
  }
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_recertify_skill", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const previousLicenseVersion = existing?.permission_license.license_version ?? null;
  const manifest = generatePrivateWorkflowToolManifest(workflow.artifact.workflow.contract);
  const publishedToolName = existing?.published_tool_name;
  let recertified = buildDojoSkill(workflow.artifact.workflow.contract, {
    workspace_id: workspaceId,
    now,
    private_tool_manifest: manifest,
    ...(publishedToolName ? { published_tool_name: publishedToolName } : {}),
  });
  const recertificationCheckride = await executableCheckrideForSkillPublication({
    skill: recertified,
    contract: workflow.artifact.workflow.contract,
    tenant,
    now,
  });
  if (!recertificationCheckride.ok) return recertificationCheckride.error;
  recertified = applyExecutableCheckrideToPublishedSkill(
    recertified,
    recertificationCheckride.publication_checkride,
    "recertification"
  );
  if (previousLicenseVersion) {
    recertified = skillWithLicenseVersion(recertified, bumpVersion(previousLicenseVersion));
  }
  const evidenceLedgerValidation = await validateRecertificationEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_recertify_skill",
    tenant,
    skill: recertified,
    evidence_refs: evidenceRefs,
    checked_at: now,
  });
  if (!evidenceLedgerValidation.ok) return evidenceLedgerValidation.error;
  const auditEvent = {
    event_type: "checkride_run_completed" as const,
    actor: {
      actor_id: actorId,
      actor_type: actorType,
    },
    occurred_at: now,
    workspace_id: recertified.workspace_id,
    skill_id: recertified.skill_id,
    license_id: recertified.permission_license.license_id,
    tenant_context: tenant,
    reason,
    evidence_refs: evidenceRefs,
    ...(recertificationRbacAuthorization ? { rbac_authorization: recertificationRbacAuthorization } : {}),
  };
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  let controlPlanePersistence: Record<string, unknown> = {
    ok: true,
    store_kind: "compatibility_registry",
  };
  let durableAuditEvent: DojoAuditEventRecord | null = null;
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant,
      app_origin: recertified.app_origin,
    });
    if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_recertify_skill", resolution);
    try {
      const actor = {
        actor_id: actorId,
        actor_type: actorType,
      };
      const skillRecord = await resolution.skill_store.saveSkill(recertified, {
        status: "published",
        created_by: actor,
        now,
      });
      const licenseRecord = await resolution.license_store.saveLicense(recertified.permission_license, {
        readiness_level: recertified.skill_readiness_level,
        status: "active",
        expires_at: recertified.license_expires_at,
        created_by: actor,
        now,
      });
      durableAuditEvent = await resolution.audit_store.appendAuditEvent({
        tenant_id: tenant.tenant_id,
        workspace_id: recertified.workspace_id,
        actor,
        event_type: "checkride_run_completed",
        request_id: tenant.request_id,
        correlation_id: tenant.correlation_id,
        entity_kind: "skill",
        entity_id: recertified.skill_id,
        details: {
          skill_id: recertified.skill_id,
          workflow_id: recertified.workflow_id,
          license_id: recertified.permission_license.license_id,
          license_version: recertified.permission_license.license_version,
          reason,
          evidence_refs: evidenceRefs,
        },
        created_at: now,
      });
      controlPlaneSource = "postgres";
      controlPlanePersistence = {
        ok: true,
        store_kind: "postgres",
        skill_id: skillRecord.skill_id,
        workflow_id: skillRecord.workflow_id,
        skill_version: skillRecord.current_skill_version,
        license_id: licenseRecord.license_id,
        license_version: licenseRecord.license_version,
        audit_event_id: durableAuditEvent.audit_event_id,
      };
    } finally {
      await resolution.close?.();
    }
  }
  if (existingControlPlaneSource === "compatibility_registry") {
    recertified = dojoSkillRegistry.publish(recertified);
  }
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
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
      executable_checkride: recertificationCheckride.publication_checkride.executable_checkride,
      entrustment_decision: recertificationCheckride.publication_checkride.entrustment_decision,
      readiness_decision: recertificationCheckride.publication_checkride.readiness_decision,
      evidence_policy: recertificationCheckride.publication_checkride.evidence_policy,
      evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
      ...(recertificationRbacAuthorization ? { rbac_authorization: recertificationRbacAuthorization } : {}),
      audit_event: auditEvent,
      control_plane_persistence: controlPlanePersistence,
      ...(durableAuditEvent ? { durable_audit_event: durableAuditEvent } : {}),
    },
    checkride: recertified.checkride,
    license: recertified.permission_license,
    license_health: await licenseHealthFor(recertified, tenant),
    governance_service: await governanceServiceViewForTenant(tenant, now, [recertified]),
    assurance_case: recertified.assurance_case,
    repo_artifacts: artifactSummary(exportDojoRepoArtifacts(recertified)),
  });
}

async function dojoGetLicenseHealthTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_get_license_health");
  if (!skill.ok) return skill.error;
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    license_health: await licenseHealthFor(skill.skill, skill.tenant),
  });
}

async function dojoRevokeLicenseTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_revoke_license");
  if (!skill.ok) return skill.error;
  const a = obj(args);
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_license_revocation_reason_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_license_revocation_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_license_revocation_actor_type_required");
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  if (evidenceRefs.length === 0) return errorResponse("dojo_license_revocation_evidence_required");
  const revokedBy = {
    actor_id: actorId,
    actor_type: actorType,
  };
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_revoke_license", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const evidenceLedgerValidation = await validateLicenseRevocationEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_revoke_license",
    tenant: skill.tenant,
    skill: skill.skill,
    evidence_refs: evidenceRefs,
    checked_at: now,
  });
  if (!evidenceLedgerValidation.ok) return evidenceLedgerValidation.error;
  const enforcement = resolveDojoEnforcementConfig();
  const productionGovernanceRbacRequired = enforcement.production_enforcement;
  let revocation: ReturnType<typeof revokeDojoSkillLicense>;
  try {
    revocation = revokeDojoSkillLicense({
      skill: skill.skill,
      reason,
      revoked_at: now,
      revoked_by: revokedBy,
      evidence_refs: evidenceRefs,
      tenant_context: productionGovernanceRbacRequired ? skill.tenant : undefined,
      require_rbac: productionGovernanceRbacRequired,
    });
  } catch (error) {
    const roleErrorPrefix = "dojo_license_revocation_role_required:";
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(roleErrorPrefix)) {
      const blockedBy = message.slice(roleErrorPrefix.length).split(",").filter(Boolean);
      return errorResponse("dojo_license_revocation_role_required", {
        ok: false,
        skill_id: skill.skill.skill_id,
        license_id: skill.skill.permission_license.license_id,
        actor_id: revokedBy.actor_id,
        actor_type: revokedBy.actor_type,
        blocked_by: blockedBy,
      });
    }
    throw error;
  }
  let saved = revocation.skill;
  let controlPlanePersistence: Record<string, unknown> = {
    ok: true,
    store_kind: "compatibility_registry",
  };
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: skill.tenant,
      app_origin: skill.skill.app_origin,
    });
    if (!resolution.ok) {
      return controlPlaneResolutionError("synthi_dojo_revoke_license", resolution);
    }
    try {
      const licenseRecord = await resolution.license_store.revokeLicense(
        skill.skill.permission_license.license_id,
        reason,
        now,
        revokedBy,
        {
          revoked_license: revocation.skill.permission_license,
          readiness_level: revocation.skill.skill_readiness_level,
          expires_at: revocation.skill.license_expires_at,
        }
      );
      if (!licenseRecord) {
        return errorResponse("dojo_license_not_found", {
          ok: false,
          skill_id: skill.skill.skill_id,
          license_id: skill.skill.permission_license.license_id,
          control_plane_source: "postgres",
          blocked_by: ["license_record_not_found"],
          required_tool: "synthi_dojo_publish_skill",
        });
      }
      const skillRecord = await resolution.skill_store.saveSkill(revocation.skill, {
        status: "revoked",
        created_by: revokedBy,
        now,
      });
      controlPlanePersistence = {
        ok: true,
        store_kind: "postgres",
        skill_id: skillRecord.skill_id,
        skill_status: skillRecord.status,
        license_id: licenseRecord.license_id,
        license_version: licenseRecord.license_version,
        license_status: licenseRecord.status,
        revoked_at: licenseRecord.revoked_at,
      };
    } finally {
      await resolution.close?.();
    }
  }
  if (skill.control_plane_source === "compatibility_registry") {
    saved = dojoSkillRegistry.publish(revocation.skill);
  }
  return jsonResponse({
    ok: true,
    skill_id: saved.skill_id,
    control_plane_source: controlPlanePersistence.store_kind,
    control_plane_persistence: controlPlanePersistence,
    evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
    reason,
    revocation,
    license: saved.permission_license,
    lifecycle: buildDojoLifecycleReport(saved),
    governance_report: buildDojoGovernanceReport(saved),
  });
}

async function dojoRecordCaseLawTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_record_case_law");
  if (!skill.ok) return skill.error;
  const caseLawRecordRbacAuthorization = resolveDojoEnforcementConfig().production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: skill.tenant,
      action: "case_law_record",
    })
    : undefined;
  if (caseLawRecordRbacAuthorization && !caseLawRecordRbacAuthorization.ok) {
    return errorResponse("dojo_case_law_record_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
      blocked_by: caseLawRecordRbacAuthorization.blocked_by,
      rbac_authorization: caseLawRecordRbacAuthorization,
    });
  }
  const a = obj(args);
  const finding = stringOpt(a["finding"]);
  const rule = stringOpt(a["rule"]);
  if (!finding || !rule) return errorResponse("dojo_case_law_finding_and_rule_required");
  const requestedStatus = stringOpt(a["status"]);
  if (requestedStatus && requestedStatus !== "proposed") {
    return errorResponse("dojo_case_law_review_required", {
      requested_status: requestedStatus,
      allowed_record_status: "proposed",
      review_tool: "synthi_dojo_review_case_law",
    });
  }
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const title = stringOpt(a["title"]) ?? titleFromFinding(finding);
  const impact = stringOpt(a["impact"]) ?? "The skill could act outside its licensed tested conditions.";
  const appliesTo = stringArrayOpt(a["applies_to"]);
  const scope = bindingScopeOpt(a["binding_scope"]);
  const sourceRunId = stringOpt(a["source_run_id"])
    ?? skill.skill.training_runs[skill.skill.training_runs.length - 1]?.run_id
    ?? skill.skill.checkride.checkride_id;
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  if (evidenceRefs.length === 0) {
    return errorResponse("dojo_case_law_evidence_required", {
      required: ["evidence_refs"],
      review_tool: "synthi_dojo_review_case_law",
    });
  }
  const evidenceLedgerValidation = await validateCaseLawEvidenceRefsAgainstLedgerIfRequired({
    operation: "synthi_dojo_record_case_law",
    tenant: skill.tenant,
    skill: skill.skill,
    evidence_refs: evidenceRefs,
    checked_at: now,
  });
  if (!evidenceLedgerValidation.ok) return evidenceLedgerValidation.error;
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_record_case_law", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const caseId = `case_${hashId(`${skill.skill.skill_id}:${sourceRunId}:${finding}:${rule}`)}`;
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
    status: "proposed",
    evidence_refs: evidenceRefs,
  };
  const updated = cloneJson(skill.skill);
  updated.case_law = upsertBy(updated.case_law, caseLaw, "case_id");
  updated.training_report = {
    ...updated.training_report,
    summary: {
      ...updated.training_report.summary,
      guardrail_count: updated.guardrails.length,
      antibody_count: updated.antibodies.length,
    },
    evidence_refs: [...new Set([...updated.training_report.evidence_refs, ...caseLaw.evidence_refs])],
    readiness_decision: `Case law ${caseId} proposed; governance review required before runtime guardrail binding.`,
  };
  updated.last_trained_at = now;
  let saved = updated;
  let caseLawRecord = caseLawRecordForSkillCase(saved, caseLaw);
  let controlPlaneSource: "compatibility_registry" | "postgres" = "compatibility_registry";
  const enforcement = resolveDojoEnforcementConfig();
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: skill.tenant,
      app_origin: skill.skill.app_origin,
    });
    if (!resolution.ok) return controlPlaneResolutionError("synthi_dojo_record_case_law", resolution);
    try {
      await resolution.skill_store.saveSkill(updated, {
        status: "published",
        created_by: {
          actor_id: skill.tenant.actor_id,
          actor_type: skill.tenant.actor_type,
        },
        now,
      });
      await resolution.governance_store.saveCaseLawRecord(caseLawRecord);
      controlPlaneSource = "postgres";
    } finally {
      await resolution.close?.();
    }
  }
  if (skill.control_plane_source === "compatibility_registry") {
    saved = dojoSkillRegistry.publish(updated);
    caseLawRecord = dojoSkillRegistry.recordCaseLawRecord(caseLawRecordForSkillCase(saved, caseLaw));
  }
  const guardrailProposal = guardrailForCaseLawRecord(caseLawRecord);
  const antibodyProposal = antibodyForCaseLawRecord(caseLawRecord, guardrailProposal, now);
  return jsonResponse({
    ok: true,
    control_plane_source: controlPlaneSource,
    skill_id: saved.skill_id,
    case_law: caseLaw,
    case_law_record: caseLawRecord,
    evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
    guardrail_proposal: guardrailProposal,
    antibody_proposal: antibodyProposal,
    guardrail_binding_status: "review_required",
    ...(caseLawRecordRbacAuthorization ? { rbac_authorization: caseLawRecordRbacAuthorization } : {}),
    governance_report: buildDojoGovernanceReport(saved),
  });
}

async function dojoExportArtifactsTool(args: unknown): Promise<ToolResponse> {
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_export_artifacts");
  if (!skill.ok) return skill.error;
  const artifactExportRbac = requireDojoProductionGovernanceRbac({
    tenant: skill.tenant,
    action: "artifact_export",
    error: "dojo_artifact_export_role_required",
    details: {
      operation: "synthi_dojo_export_artifacts",
      skill_id: skill.skill.skill_id,
      workspace_id: skill.skill.workspace_id,
    },
  });
  if (!artifactExportRbac.ok) return artifactExportRbac.error;
  const artifacts = exportDojoRepoArtifacts(skill.skill);
  return jsonResponse({
    ok: true,
    control_plane_source: skill.control_plane_source,
    skill_id: skill.skill.skill_id,
    artifact_count: artifacts.length,
    artifacts,
    ...(artifactExportRbac.rbac_authorization ? { rbac_authorization: artifactExportRbac.rbac_authorization } : {}),
  });
}

async function dojoExportCompliancePackTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const hasExplicitSkillSelection = Boolean(stringOpt(a["skill_id"]) || stringOpt(a["workflow_id"]));
  let tenant: DojoTenantContext;
  let skills: DojoSkill[];
  if (hasExplicitSkillSelection) {
    const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_export_compliance_pack");
    if (!skill.ok) return skill.error;
    tenant = skill.tenant;
    skills = [skill.skill];
  } else {
    const tenantContext = dojoTenantContextResultFromArgs(args);
    if (!tenantContext.ok) return tenantContext.error;
    tenant = tenantContext.tenant;
    const visibleSkills = await visibleDojoSkillsForTenantFromControlPlaneIfRequired(
      tenant,
      "synthi_dojo_export_compliance_pack"
    );
    if (!visibleSkills.ok) return visibleSkills.error;
    skills = visibleSkills.skills;
  }
  if (skills.length === 0) return errorResponse("dojo_skill_required");
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const enforcement = resolveDojoEnforcementConfig();
  const complianceExportRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: tenant,
      action: "compliance_export",
    })
    : undefined;
  if (complianceExportRbacAuthorization && !complianceExportRbacAuthorization.ok) {
    return errorResponse("dojo_compliance_export_role_required", {
      ok: false,
      skill_ids: skills.map((skill) => skill.skill_id),
      workspace_ids: [...new Set(skills.map((skill) => skill.workspace_id))],
      actor_id: tenant.actor_id,
      actor_type: tenant.actor_type,
      blocked_by: complianceExportRbacAuthorization.blocked_by,
      rbac_authorization: complianceExportRbacAuthorization,
    });
  }
  const proofVerificationExport = await proofPublicVerificationExportForTenant({
    tenant,
    skill_ids: skills.map((skill) => skill.skill_id),
    now,
    operation: "synthi_dojo_export_compliance_pack",
  });
  if (!proofVerificationExport.ok) return proofVerificationExport.error;
  const governanceService = await governanceServiceViewForTenant(tenant, now, skills, {
    proof_key_records: proofVerificationExport.proof_key_records,
  });
  const exportedArtifacts = skills.flatMap((skill) => exportDojoRepoArtifacts(skill));
  const complianceArtifactIds = governanceService.compliance_evidence_pack.artifacts
    .filter((artifact) => artifact.status === "available")
    .map((artifact) => artifact.artifact_id);
  const selectedArtifacts = [
    ...selectComplianceArtifacts(exportedArtifacts, complianceArtifactIds),
    ...proofVerificationExport.artifacts,
  ].sort((left, right) => left.path.localeCompare(right.path));
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
    ...(complianceExportRbacAuthorization ? { rbac_authorization: complianceExportRbacAuthorization } : {}),
    artifact_count: selectedArtifacts.length + 1,
    artifacts: [manifestArtifact, ...selectedArtifacts],
  });
}

async function dojoIssueProofCapsuleTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_issue_proof_capsule");
  if (!skill.ok) return skill.error;
  const requestedAction = stringOpt(a["requested_action"]) ?? "run_workflow";
  const enforcement = resolveDojoEnforcementConfig();
  const tenant = skill.tenant;
  const issuerActorId = stringOpt(a["actor_id"]);
  const issuerActorType = actorTypeInputOpt(a["actor_type"]);
  const issuerActorProvided = Boolean(issuerActorId) || a["actor_type"] !== undefined;
  if (issuerActorProvided && !issuerActorType) {
    return errorResponse("dojo_proof_capsule_issuer_actor_type_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      enforcement_mode: enforcement.enforcement_mode,
      blocked_by: ["proof_issuer_actor_type_invalid"],
    });
  }
  const proofIssueRbacAuthorization = enforcement.production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: tenant,
      action: "proof_capsule_issue",
    })
    : undefined;
  if (proofIssueRbacAuthorization && !proofIssueRbacAuthorization.ok) {
    return errorResponse("dojo_proof_capsule_issue_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      workspace_id: skill.skill.workspace_id,
      actor_id: tenant.actor_id,
      actor_type: tenant.actor_type,
      blocked_by: proofIssueRbacAuthorization.blocked_by,
      rbac_authorization: proofIssueRbacAuthorization,
    });
  }
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_issue_proof_capsule", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const issuedBy = enforcement.production_enforcement
    ? { actor_id: tenant.actor_id, actor_type: tenant.actor_type }
    : (issuerActorId && issuerActorType ? { actor_id: issuerActorId, actor_type: issuerActorType } : undefined);
  const scopedTenantId = tenant.tenant_id;
  let evidenceLedgerRecords = evidenceLedgerRecordsOpt(a["evidence_ledger_records"]);
  const requestedEvidenceRecordIds = stringArrayOpt(a["evidence_record_ids"] ?? a["evidenceRecordIds"]);
  const requireVerifiedEvidence = boolOpt(a["require_verified_evidence"])
    || enforcement.production_enforcement
    || enforcement.require_evidence_ledger;
  if (enforcement.require_external_signing) {
    try {
      assertDojoProofSignerExternalReady();
    } catch (err) {
      const error = err instanceof Error ? err.message : "dojo_proof_signer_external_required";
      const blockedBy = [error];
      return errorResponse(error, {
        ok: false,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        enforcement_mode: enforcement.enforcement_mode,
        require_external_signing: enforcement.require_external_signing,
        require_verified_evidence: requireVerifiedEvidence,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
        message: "Production proof issuance requires an external or managed-key proof signer.",
      });
    }
  }
  const evidenceLedgerStore = resolveDojoEvidenceLedgerStoreConfig();
  if (enforcement.production_enforcement && enforcement.require_evidence_ledger && evidenceLedgerRecords.length > 0) {
    return errorResponse("dojo_proof_evidence_ledger_inline_records_forbidden", {
      ok: false,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      enforcement_mode: enforcement.enforcement_mode,
      require_verified_evidence: requireVerifiedEvidence,
      evidence_record_count: evidenceLedgerRecords.length,
      evidence_ledger_store_kind: evidenceLedgerStore.store_kind,
      evidence_ledger_configured: evidenceLedgerStore.configured,
      configured_env: evidenceLedgerStore.configured_env,
      blocked_by: ["evidence_ledger_inline_records_forbidden_in_production"],
      error_codes: ["proof_evidence_claim_unverified"],
      message: "Production proof issuance must resolve evidence from the configured evidence ledger instead of caller-supplied inline records.",
    });
  }
  if (enforcement.production_enforcement && enforcement.require_evidence_ledger && requestedEvidenceRecordIds.length > 0) {
    const resolved = await resolveDojoEvidenceLedgerRecords({
      tenant_id: scopedTenantId,
      workspace_id: tenant.workspace_id,
      record_ids: requestedEvidenceRecordIds,
      ledger_checkpoint_hash: stringOpt(a["ledger_checkpoint_hash"]),
      checked_at: stringOpt(a["now"]),
    });
    if (!resolved.ok) {
      return errorResponse("dojo_proof_evidence_ledger_resolution_failed", {
        ok: false,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        enforcement_mode: enforcement.enforcement_mode,
        require_verified_evidence: requireVerifiedEvidence,
        evidence_record_ids: requestedEvidenceRecordIds,
        evidence_record_count: resolved.records.length,
        missing_evidence_record_ids: resolved.missing_record_ids,
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        evidence_ledger_store_kind: resolved.store_kind,
        configured_env: resolved.configured_env,
        verification: resolved.verification,
        blocked_by: resolved.blocked_by,
        error_codes: ["proof_evidence_claim_unverified"],
      });
    }
    evidenceLedgerRecords = resolved.records;
  }
  let capsule: DojoProofCarryingSkillCapsule;
  try {
    capsule = issueDojoProofCapsule(skill.skill, requestedAction, {
      context_claims: objectOpt(a["context_claims"]) ?? (enforcement.production_enforcement ? {} : { workspace_verified: true }),
      evidence_claims: evidenceClaimsOpt(a["evidence_claims"]),
      evidence_ledger_records: evidenceLedgerRecords,
      evidence_max_age_ms: numberOpt(a["evidence_max_age_ms"]),
      ledger_checkpoint_hash: stringOpt(a["ledger_checkpoint_hash"]),
      require_verified_evidence: requireVerifiedEvidence,
      tenant_id: scopedTenantId,
      substrate_claim: substrateOpt(a["substrate_claim"]),
      now: stringOpt(a["now"]),
      expires_at: stringOpt(a["expires_at"]),
    });
  } catch (err) {
    if (isDojoProofEvidenceClaimError(err)) {
      const failedResults = err.failed_results;
      const failedClaims = failedResults.map((result) => result.claim_id);
      const blockedBy = [...new Set(failedResults.flatMap((result) => result.blocked_by))].sort();
      return errorResponse(err.code, {
        ok: false,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        enforcement_mode: enforcement.enforcement_mode,
        require_verified_evidence: requireVerifiedEvidence,
        evidence_record_count: evidenceLedgerRecords.length,
        failed_evidence_claims: failedClaims,
        failed_evidence_claim_results: failedResults,
        blocked_by: blockedBy,
        error_codes: ["proof_evidence_claim_unverified"],
        message: err.message,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("dojo_proof_evidence_claim_unverified:")) {
      const failedClaims = message.slice("dojo_proof_evidence_claim_unverified:".length).split(",").filter(Boolean);
      return errorResponse("dojo_proof_evidence_claim_unverified", {
        ok: false,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        enforcement_mode: enforcement.enforcement_mode,
        require_verified_evidence: requireVerifiedEvidence,
        evidence_record_count: evidenceLedgerRecords.length,
        failed_evidence_claims: failedClaims,
        failed_evidence_claim_results: failedClaims.map((claim) => ({
          claim_id: claim,
          ok: false,
          status: "failed",
          evidence_record_ids: [],
          checked_at: stringOpt(a["now"]) ?? new Date().toISOString(),
          blocked_by: [`evidence_claim_unverified:${claim}`],
        })),
        blocked_by: failedClaims.map((claim) => `evidence_claim_unverified:${claim}`),
        error_codes: ["proof_evidence_claim_unverified"],
        message,
      });
    }
    if (message.startsWith("proof_capsule_") || message === "proof_validation_time_invalid") {
      const blockedBy = [message];
      return errorResponse("dojo_proof_capsule_invalid", {
        ok: false,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        enforcement_mode: enforcement.enforcement_mode,
        require_verified_evidence: requireVerifiedEvidence,
        evidence_record_count: evidenceLedgerRecords.length,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
        message,
      });
    }
    throw err;
  }
  const durableProofRegistry = await durableProofRegistryForTenantIfRequired({
    tenant,
    operation: "synthi_dojo_issue_proof_capsule",
    app_origin: skill.skill.app_origin,
  });
  if (!durableProofRegistry.ok) return durableProofRegistry.error;
  try {
    const proofKeyPersistence = await persistDurableProofKeyForCapsule({
      context: durableProofRegistry.context,
      tenant,
      capsule,
      operation: "synthi_dojo_issue_proof_capsule",
    });
    if (!proofKeyPersistence.ok) return proofKeyPersistence.error;
    const validationOptions = await durableProofValidationOptionsForCapsule({
      context: durableProofRegistry.context,
      tenant,
      capsule,
      operation: "synthi_dojo_issue_proof_capsule",
      now: stringOpt(a["now"]),
    });
    if (!validationOptions.ok) return validationOptions.error;
    const validation = validateDojoProofCapsule(skill.skill, capsule, requestedAction, validationOptions.options);
    let proofRecord: DojoProofCapsuleRecord;
    if (durableProofRegistry.context.required) {
      proofRecord = await durableProofRegistry.context.proof_store.saveProofRecord(proofRecordForCapsule({
        tenant,
        skill: skill.skill,
        capsule,
        issued_by: issuedBy,
      }));
      dojoSkillRegistry.recordProofCapsule(capsule, {
        tenant_id: scopedTenantId,
        issued_by: issuedBy,
      });
    } else {
      proofRecord = dojoSkillRegistry.recordProofCapsule(capsule, {
        tenant_id: scopedTenantId,
        issued_by: issuedBy,
      });
    }
    return jsonResponse({
      ok: validation.ok,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      enforcement_mode: enforcement.enforcement_mode,
      require_verified_evidence: requireVerifiedEvidence,
      control_plane_source: durableProofRegistry.context.required ? durableProofRegistry.context.source : "compatibility_registry",
      proof_key: proofKeyPersistence.proof_key ?? validationOptions.proof_key ?? null,
      proof_capsule: capsule,
      proof_record: proofRecord,
      validation,
      ...(proofIssueRbacAuthorization ? { rbac_authorization: proofIssueRbacAuthorization } : {}),
    });
  } finally {
    if (durableProofRegistry.context.required) {
      await durableProofRegistry.context.close?.();
    }
  }
}

async function validateProofCapsuleEvidenceAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  capsule: DojoProofCarryingSkillCapsule;
  requested_action: string;
  checked_at?: string;
  evidence_max_age_ms?: number;
}): Promise<
  | {
    ok: true;
    evidence_ledger_resolution?: Record<string, unknown>;
    evidence_claim_results: DojoEvidenceClaimResult[];
  }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_evidence_ledger) {
    return { ok: true, evidence_claim_results: [] };
  }

  const checkedAt = input.checked_at ?? new Date().toISOString();
  const evidenceRecordIds = [...new Set(
    (Array.isArray(input.capsule.evidence_record_ids) ? input.capsule.evidence_record_ids : [])
      .map((recordId) => recordId.trim())
      .filter(Boolean)
  )];
  const resolved = await resolveDojoEvidenceLedgerRecords({
    tenant_id: input.tenant.tenant_id,
    workspace_id: input.tenant.workspace_id,
    record_ids: evidenceRecordIds,
    ledger_checkpoint_hash: input.capsule.ledger_checkpoint_hash,
    checked_at: checkedAt,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorResponse("dojo_proof_evidence_ledger_resolution_failed", {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        proof_capsule_id: input.capsule.capsule_id,
        evidence_record_ids: evidenceRecordIds,
        missing_evidence_record_ids: resolved.missing_record_ids,
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        expected_ledger_checkpoint_hash: input.capsule.ledger_checkpoint_hash ?? null,
        evidence_ledger_store_kind: resolved.store_kind,
        evidence_ledger_configured_env: resolved.configured_env,
        blocked_by: resolved.blocked_by,
        error_codes: ["proof_evidence_claim_unverified"],
        verification: resolved.verification,
        proof_not_consumed: true,
      }),
    };
  }

  const mismatchedRecords = resolved.records.filter((record) => record.skill_id !== input.skill.skill_id);
  if (mismatchedRecords.length > 0) {
    const blockedBy = mismatchedRecords.map((record) => `proof_evidence_skill_mismatch:${record.record_id}`);
    return {
      ok: false,
      error: errorResponse("dojo_proof_evidence_ledger_scope_mismatch", {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        proof_capsule_id: input.capsule.capsule_id,
        workspace_id: input.skill.workspace_id,
        evidence_record_ids: evidenceRecordIds,
        mismatched_evidence_record_ids: mismatchedRecords.map((record) => record.record_id),
        mismatched_skill_ids: [...new Set(mismatchedRecords.map((record) => record.skill_id))],
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        evidence_ledger_store_kind: resolved.store_kind,
        blocked_by: blockedBy,
        error_codes: ["proof_evidence_claim_unverified"],
        proof_not_consumed: true,
      }),
    };
  }

  const capsuleEvidenceClaims = (Array.isArray(input.capsule.evidence_claims) ? input.capsule.evidence_claims : [])
    .map((claim) => claim.claim.trim())
    .filter(Boolean);
  const requiredClaims = [...new Set([
    ...input.skill.permission_license.proof_requirements.required_evidence_claims,
    ...input.skill.permission_license.proof_requirements.required_context_claims,
    ...capsuleEvidenceClaims,
  ])] as DojoEvidenceClaimId[];
  const evidenceClaimResults = requiredClaims.length > 0
    ? resolveDojoEvidenceClaims({
      claim_ids: requiredClaims,
      records: resolved.records,
      tenant_id: input.tenant.tenant_id,
      workspace_id: input.tenant.workspace_id,
      skill_id: input.skill.skill_id,
      checked_at: checkedAt,
      max_age_ms: input.evidence_max_age_ms,
    })
    : [];
  const failedEvidenceClaims = evidenceClaimResults.filter((result) => !result.ok);
  if (failedEvidenceClaims.length > 0) {
    const blockedBy = [...new Set(failedEvidenceClaims.flatMap((result) => result.blocked_by))].sort();
    return {
      ok: false,
      error: errorResponse("dojo_proof_evidence_claim_revalidation_failed", {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        proof_capsule_id: input.capsule.capsule_id,
        evidence_record_ids: resolved.records.map((record) => record.record_id),
        required_evidence_claims: requiredClaims,
        failed_evidence_claims: failedEvidenceClaims.map((result) => result.claim_id),
        failed_evidence_claim_results: failedEvidenceClaims,
        evidence_claim_results: evidenceClaimResults,
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        expected_ledger_checkpoint_hash: input.capsule.ledger_checkpoint_hash ?? null,
        evidence_ledger_store_kind: resolved.store_kind,
        blocked_by: blockedBy,
        error_codes: ["proof_evidence_claim_unverified"],
        verification: resolved.verification,
        proof_not_consumed: true,
      }),
    };
  }

  return {
    ok: true,
    evidence_claim_results: evidenceClaimResults,
    evidence_ledger_resolution: {
      store_kind: resolved.store_kind,
      evidence_record_ids: resolved.records.map((record) => record.record_id),
      record_count: resolved.records.length,
      ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
      required_evidence_claims: requiredClaims,
      evidence_claim_results: evidenceClaimResults,
      verification: resolved.verification,
    },
  };
}

async function dojoValidateProofCapsuleTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_validate_proof_capsule");
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
  const now = stringOpt(a["now"]);
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_validate_proof_capsule", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const tenant = skill.tenant;
  const durableProofRegistry = await durableProofRegistryForTenantIfRequired({
    tenant,
    operation: "synthi_dojo_validate_proof_capsule",
    app_origin: skill.skill.app_origin,
  });
  if (!durableProofRegistry.ok) return durableProofRegistry.error;
  try {
    const durableProofRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.proof_store.getProofRecord(capsule.capsule_id)
      : undefined;
    const durableLicenseRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.license_store.getLicense(skill.skill.permission_license.license_id)
      : undefined;
    const validationOptions = await durableProofValidationOptionsForCapsule({
      context: durableProofRegistry.context,
      tenant,
      capsule,
      operation: "synthi_dojo_validate_proof_capsule",
      now,
    });
    if (!validationOptions.ok) return validationOptions.error;
    const licenseToolArgs = dojoLicenseKernelToolArgsFromArgs(a, tenant, objectOpt(a["tool_args"]) ?? {});
    const enforcement = resolveDojoEnforcementConfig();
    const proofEvidenceValidation = await validateProofCapsuleEvidenceAgainstLedgerIfRequired({
      operation: "synthi_dojo_validate_proof_capsule",
      tenant,
      skill: skill.skill,
      capsule,
      requested_action: requestedAction,
      checked_at: now,
      evidence_max_age_ms: numberOpt(a["evidence_max_age_ms"]),
    });
    if (!proofEvidenceValidation.ok) return proofEvidenceValidation.error;
    const decision = evaluateDojoLicenseKernel({
      skill: skill.skill,
      registry: dojoSkillRegistry,
      proof_record: durableProofRecord,
      license_record: durableLicenseRecord,
      require_durable_license: durableProofRegistry.context.required,
      proof_capsule: capsule,
      requested_action: requestedAction,
      tool_args: licenseToolArgs,
      dry_run: true,
      now,
      evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
      require_verified_approval_evidence: enforcement.production_enforcement,
      proof_validation_options: validationOptions.options,
    });
    const proofRecord = decision.ok
      ? durableProofRegistry.context.required
        ? await durableProofRegistry.context.proof_store.markProofCapsuleValidated(capsule.capsule_id, now)
        : dojoSkillRegistry.markProofCapsuleValidated(capsule.capsule_id, now) ?? decision.proof_record ?? null
      : decision.proof_record ?? null;
    const licenseKernel = proofRecord
      ? { ...decision, proof_record: proofRecord }
      : decision;
    return jsonResponse({
      ok: decision.ok,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      control_plane_source: durableProofRegistry.context.required ? durableProofRegistry.context.source : "compatibility_registry",
      proof_key: validationOptions.proof_key ?? null,
      proof_record: proofRecord,
      evidence_ledger_validation: proofEvidenceValidation.evidence_ledger_resolution ?? null,
      evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
      license_kernel: licenseKernel,
    });
  } finally {
    if (durableProofRegistry.context.required) {
      await durableProofRegistry.context.close?.();
    }
  }
}

async function dojoRevokeProofCapsuleTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const capsuleId = stringOpt(a["capsule_id"]);
  if (!capsuleId) return errorResponse("dojo_proof_capsule_id_required");
  const now = stringOpt(a["now"]) ?? new Date().toISOString();
  const reason = stringOpt(a["reason"]);
  if (!reason) return errorResponse("dojo_proof_capsule_revocation_reason_required");
  const actorId = stringOpt(a["actor_id"]);
  if (!actorId) return errorResponse("dojo_proof_capsule_revocation_actor_required");
  const actorType = actorTypeInputOpt(a["actor_type"]);
  if (!actorType) return errorResponse("dojo_proof_capsule_revocation_actor_type_required");
  const evidenceRefs = stringArrayOpt(a["evidence_refs"]);
  if (evidenceRefs.length === 0) return errorResponse("dojo_proof_capsule_revocation_evidence_required");
  const enforcement = resolveDojoEnforcementConfig();
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_revoke_proof_capsule", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;

  let existingRecord = dojoSkillRegistry.getProofRecord(capsuleId);
  let durableProofRegistry: { ok: true; context: DojoDurableProofRegistryContext } | { ok: false; error: ToolResponse } | null = null;
  let skill = existingRecord ? dojoSkillRegistry.get(existingRecord.skill_id) : null;
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const tenantContext = dojoTenantContextResultFromArgs(args, skill ? {
      development_defaults: { workspace_id: skill.workspace_id },
    } : undefined);
    if (!tenantContext.ok) return tenantContext.error;
    durableProofRegistry = await durableProofRegistryForTenantIfRequired({
      tenant: tenantContext.tenant,
      operation: "synthi_dojo_revoke_proof_capsule",
      app_origin: skill?.app_origin,
    });
    if (!durableProofRegistry.ok) return durableProofRegistry.error;
    if (durableProofRegistry.context.required) {
      existingRecord = await durableProofRegistry.context.proof_store.getProofRecord(capsuleId);
      skill = existingRecord
        ? dojoSkillRegistry.get(existingRecord.skill_id) ?? await durableProofRegistry.context.skill_store.getSkill(existingRecord.skill_id)
        : null;
    }
  }
  try {
    if (!existingRecord) return errorResponse("dojo_proof_capsule_not_found", { capsule_id: capsuleId });
    if (!skill) return errorResponse("dojo_proof_capsule_skill_not_found", {
      capsule_id: capsuleId,
      skill_id: existingRecord.skill_id,
    });
    const authorization = authorizeTenantForDojoSkill(args, skill);
    if (!authorization.ok) return authorization.error;
    const proofRevokeRbacAuthorization = enforcement.production_enforcement
      ? authorizeDojoGovernanceAction({
        tenant_context: authorization.tenant,
        action: "proof_capsule_revoke",
      })
      : undefined;
    if (proofRevokeRbacAuthorization && !proofRevokeRbacAuthorization.ok) {
      return errorResponse("dojo_proof_capsule_revocation_role_required", {
        ok: false,
        capsule_id: capsuleId,
        skill_id: skill.skill_id,
        workspace_id: skill.workspace_id,
        actor_id: authorization.tenant.actor_id,
        actor_type: authorization.tenant.actor_type,
        blocked_by: proofRevokeRbacAuthorization.blocked_by,
        rbac_authorization: proofRevokeRbacAuthorization,
      });
    }
    const evidenceLedgerValidation = await validateProofCapsuleRevocationEvidenceRefsAgainstLedgerIfRequired({
      operation: "synthi_dojo_revoke_proof_capsule",
      tenant: authorization.tenant,
      skill,
      evidence_refs: evidenceRefs,
      checked_at: now,
    });
    if (!evidenceLedgerValidation.ok) return evidenceLedgerValidation.error;
    const revokedBy = {
      actor_id: actorId,
      actor_type: actorType,
    };
    const record = durableProofRegistry?.ok && durableProofRegistry.context.required
      ? await durableProofRegistry.context.proof_store.revokeProofCapsule(capsuleId, reason, now, revokedBy, evidenceRefs)
      : dojoSkillRegistry.revokeProofCapsule(capsuleId, reason, now, revokedBy, evidenceRefs);
    if (!record) return errorResponse("dojo_proof_capsule_not_found", { capsule_id: capsuleId });
    if (durableProofRegistry?.ok && durableProofRegistry.context.required) {
      dojoSkillRegistry.revokeProofCapsule(capsuleId, reason, now, revokedBy, evidenceRefs);
    }
    return jsonResponse({
      ok: true,
      control_plane_source: durableProofRegistry?.ok && durableProofRegistry.context.required
        ? durableProofRegistry.context.source
        : "compatibility_registry",
      evidence_ledger_validation: evidenceLedgerValidation.evidence_ledger_resolution ?? null,
      proof_record: record,
      ...(proofRevokeRbacAuthorization ? { rbac_authorization: proofRevokeRbacAuthorization } : {}),
    });
  } finally {
    if (durableProofRegistry?.ok && durableProofRegistry.context.required) {
      await durableProofRegistry.context.close?.();
    }
  }
}

async function dojoCreateHostedRuntimeSessionTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const runId = stringOpt(a["run_id"]);
  if (!runId) {
    return errorResponse("dojo_hosted_runtime_run_id_required", {
      ok: false,
      skill_id: stringOpt(a["skill_id"]) ?? null,
      blocked_by: ["runtime_run_binding_required"],
    });
  }
  const workspaceUrl = stringOpt(a["workspace_url"]);
  if (!workspaceUrl) {
    return errorResponse("dojo_hosted_runtime_workspace_url_required", {
      ok: false,
      skill_id: stringOpt(a["skill_id"]) ?? null,
      run_id: runId,
      blocked_by: ["runtime_workspace_url_invalid"],
    });
  }
  const originAllowlist = stringArrayOpt(a["origin_allowlist"]);
  const gatewayResolution = await dojoHostedRuntimeGatewayResolutionForTools();
  if (!gatewayResolution.ok) {
    return errorResponse("dojo_hosted_runtime_control_plane_store_required", {
      ok: false,
      skill_id: stringOpt(a["skill_id"]) ?? null,
      run_id: runId,
      store_kind: gatewayResolution.store_kind,
      production_capable: gatewayResolution.production_capable,
      configured_env: gatewayResolution.configured_env,
      blocked_by: gatewayResolution.blocked_by,
    });
  }
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_create_hosted_runtime_session");
  if (!skill.ok) return skill.error;
  const hostedRuntimeSessionRbacAuthorization = resolveDojoEnforcementConfig().production_enforcement
    ? authorizeDojoGovernanceAction({
      tenant_context: skill.tenant,
      action: "hosted_runtime_session_create",
    })
    : undefined;
  if (hostedRuntimeSessionRbacAuthorization && !hostedRuntimeSessionRbacAuthorization.ok) {
    return errorResponse("dojo_hosted_runtime_session_role_required", {
      ok: false,
      skill_id: skill.skill.skill_id,
      run_id: runId,
      workspace_id: skill.skill.workspace_id,
      actor_id: skill.tenant.actor_id,
      actor_type: skill.tenant.actor_type,
      blocked_by: hostedRuntimeSessionRbacAuthorization.blocked_by,
      rbac_authorization: hostedRuntimeSessionRbacAuthorization,
    });
  }
  const session = await gatewayResolution.gateway.createSession({
    tenant: skill.tenant,
    skill_id: skill.skill.skill_id,
    run_id: runId,
    workspace_url: workspaceUrl,
    runtime_id: stringOpt(a["runtime_id"]),
    session_id: stringOpt(a["session_id"]),
    origin_allowlist: originAllowlist,
    ttl_ms: numberOpt(a["ttl_ms"]),
    credential_ttl_ms: numberOpt(a["credential_ttl_ms"]),
    local_network_allowed: boolOpt(a["local_network_allowed"]),
    redact_screenshots: optionalBoolOpt(a["redact_screenshots"]),
    sensitive_workspace: boolOpt(a["sensitive_workspace"]),
    now: stringOpt(a["now"]),
  });
  if (!session.ok) {
    return errorResponse("dojo_hosted_runtime_session_rejected", {
      ok: false,
      skill_id: skill.skill.skill_id,
      run_id: runId,
      blocked_by: session.blocked_by,
      audit_event_id: session.audit_event_id,
    });
  }
  return jsonResponse({
    ok: true,
    skill_id: skill.skill.skill_id,
    control_plane_source: skill.control_plane_source,
    run_id: runId,
    runtime_session: hostedRuntimeSessionPublicView(session.session),
    credentials: session.credentials,
    audit_event_id: session.audit_event_id,
    ...(hostedRuntimeSessionRbacAuthorization ? { rbac_authorization: hostedRuntimeSessionRbacAuthorization } : {}),
  });
}

async function dojoRunWithProofCapsuleTool(args: unknown): Promise<ToolResponse> {
  const a = obj(args);
  const controlPlaneWrite = requireDojoDurableControlPlaneWrite("synthi_dojo_run_with_proof_capsule", { postgres_wired: true });
  if (!controlPlaneWrite.ok) return controlPlaneWrite.error;
  const skill = await requiredAuthorizedSkillForProductionRead(args, "synthi_dojo_run_with_proof_capsule");
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
  const runId = stringOpt(a["run_id"])
    ?? stringOpt(a["request_id"])
    ?? `dojo_run_${hashId(`${(capsule as { capsule_id: string }).capsule_id}:${skill.skill.skill_id}:${requestedAction}:${skill.skill.skill_version}`)}`;
  const now = stringOpt(a["now"]);
  const tenant = skill.tenant;
  const durableProofRegistry = await durableProofRegistryForTenantIfRequired({
    tenant,
    operation: "synthi_dojo_run_with_proof_capsule",
    app_origin: skill.skill.app_origin,
  });
  if (!durableProofRegistry.ok) return durableProofRegistry.error;
  try {
    const durableProofRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.proof_store.getProofRecord(capsule.capsule_id)
      : undefined;
    const durableLicenseRecord = durableProofRegistry.context.required
      ? await durableProofRegistry.context.license_store.getLicense(skill.skill.permission_license.license_id)
      : undefined;
    const validationOptions = await durableProofValidationOptionsForCapsule({
      context: durableProofRegistry.context,
      tenant,
      capsule,
      operation: "synthi_dojo_run_with_proof_capsule",
      now,
    });
    if (!validationOptions.ok) return validationOptions.error;
    const licenseToolArgs = dojoLicenseKernelToolArgsFromArgs(a, tenant, toolArgs);
    const proofEvidenceValidation = await validateProofCapsuleEvidenceAgainstLedgerIfRequired({
      operation: "synthi_dojo_run_with_proof_capsule",
      tenant,
      skill: skill.skill,
      capsule,
      requested_action: requestedAction,
      checked_at: now,
      evidence_max_age_ms: numberOpt(a["evidence_max_age_ms"]),
    });
    if (!proofEvidenceValidation.ok) return proofEvidenceValidation.error;
    let decision: ReturnType<typeof evaluateDojoLicenseKernel> | undefined;
    let proofConsume: DojoProofConsumeResult | undefined;
    const localSkillBusSkills = dojoSkillRegistry.list();
    const skillBusSkills = localSkillBusSkills.some((registered) => registered.skill_id === skill.skill.skill_id)
      ? localSkillBusSkills
      : [skill.skill, ...localSkillBusSkills];
    let browserRuntimeExecutionContext: Partial<DojoValidatedBrowserWorkflowContext> = {};
    const skillBus = createInProcessDojoMcpSkillBus({
      listSkills: () => skillBusSkills,
      proofConsumptionMode: "external_executor",
      validateProof: ({ skill: resolvedSkill, proof_capsule: proofCapsule, requested_action: action }) => {
        decision = evaluateDojoLicenseKernel({
          skill: resolvedSkill,
          registry: dojoSkillRegistry,
          proof_record: durableProofRecord,
          license_record: durableLicenseRecord,
          require_durable_license: durableProofRegistry.context.required,
          proof_capsule: proofCapsule,
          requested_action: action,
          tool_args: licenseToolArgs,
          dry_run: dryRun,
          now,
          evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
          require_verified_approval_evidence: resolveDojoEnforcementConfig().production_enforcement,
          proof_validation_options: validationOptions.options,
        });
        return {
          ok: decision.ok,
          status: decision.status,
          blocked_by: decision.blocked_by,
          error_codes: decision.error_codes,
        };
      },
      executeTool: async ({ skill: resolvedSkill, args: executionArgs, proof_capsule: proofCapsule }) => {
        const browserWorkflowContext: DojoValidatedBrowserWorkflowContext = {
          proof_capsule_id: proofCapsule.capsule_id,
          skill_id: resolvedSkill.skill_id,
          requested_action: requestedAction,
          run_id: runId,
          ...browserRuntimeExecutionContext,
        };
        if (requestedAction !== "run_prefix_validation") {
          const runtimeBinding = validateBrowserRuntimeAttachmentForDojoProof(executionArgs, browserWorkflowContext);
          if (!runtimeBinding.ok) {
            const blockedBy = [...(decision?.blocked_by ?? []), ...runtimeBinding.blocked_by];
            return blockDojoMcpSkillBusExecution(blockedBy, {
              ok: false,
              status: "blocked",
              blocked_by: blockedBy,
              error_codes: normalizeDojoProofErrorCodes(blockedBy),
            });
          }
        }
        proofConsume = durableProofRegistry.context.required
          ? await durableProofRegistry.context.proof_store.markProofCapsuleUsed(proofCapsule.capsule_id, runId, now)
          : markDojoProofExecution({
            registry: dojoSkillRegistry,
            proof_capsule: proofCapsule,
            run_id: runId,
            now,
          });
        if (!proofConsume.ok) {
          const blockedBy = [...(decision?.blocked_by ?? []), ...proofConsume.blocked_by];
          return blockDojoMcpSkillBusExecution(blockedBy, {
            ok: false,
            status: "blocked",
            blocked_by: blockedBy,
            error_codes: normalizeDojoProofErrorCodes(blockedBy),
          });
        }
        return requestedAction === "run_prefix_validation"
          ? await dispatchSafetyTool("synthi_safety_run_prefix_validation", executionArgs)
          : await dispatchBackingSkillTool(resolvedSkill, executionArgs, browserWorkflowContext);
      },
    });
    const skillBusPreflight = await skillBus.dispatch({
      tenant,
      tool_name: skill.skill.published_tool_name ?? skill.skill.private_tool_manifest?.tool_name ?? "",
      requested_action: requestedAction,
      args: toolArgs,
      proof_capsule: capsule,
      dry_run: true,
    });
    const licenseDecision = decision;
    if (!licenseDecision) {
      return errorResponse("dojo_license_kernel_not_evaluated", {
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        skill_bus: skillBusPreflight,
        refusal: refusalFor(skill.skill, ["dojo_license_kernel_not_evaluated"]),
      });
    }
    if (!skillBusPreflight.ok || !licenseDecision.ok) {
      return errorResponse(licenseDecision?.validation.error ?? skillBusPreflight.blocked_by[0] ?? "dojo_skill_bus_blocked", {
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        validation: licenseDecision.validation,
        license_kernel: licenseDecision,
        evidence_ledger_validation: proofEvidenceValidation.evidence_ledger_resolution ?? null,
        evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
        skill_bus: skillBusPreflight,
        refusal: refusalFor(skill.skill, licenseDecision.blocked_by.length > 0 ? licenseDecision.blocked_by : skillBusPreflight.blocked_by),
      });
    }
    if (dryRun) {
      const dryRunGraphRuntimePreflight = await runDojoGraphRuntimePreflightForProofRun({
        skill: skill.skill,
        tenant,
        requested_action: requestedAction,
        run_id: runId,
        proof_capsule: capsule,
        license_decision: licenseDecision,
        tool_args: toolArgs,
        license_tool_args: licenseToolArgs,
        now,
      });
      if (!dryRunGraphRuntimePreflight.ok) return dryRunGraphRuntimePreflight.error;
      return jsonResponse({
        ok: true,
        dry_run: true,
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        control_plane_source: durableProofRegistry.context.required ? durableProofRegistry.context.source : "compatibility_registry",
        proof_key: validationOptions.proof_key ?? null,
        validation: licenseDecision.validation,
        license_kernel: licenseDecision,
        evidence_ledger_validation: proofEvidenceValidation.evidence_ledger_resolution ?? null,
        evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
        skill_bus: skillBusPreflight,
        graph_validation: dryRunGraphRuntimePreflight.graph_validation,
        graph_runtime_preflight: dryRunGraphRuntimePreflight.graph_runtime_preflight,
      });
    }

    const runtimeAuthorization = await authorizeHostedRuntimeForProductionRun({
      args: a,
      tenant,
      skill: skill.skill,
      run_id: runId,
      requested_action: requestedAction,
      proof_capsule: capsule,
      license_decision: licenseDecision,
      skill_bus_preflight: skillBusPreflight,
      now,
    });
    if (!runtimeAuthorization.ok) return runtimeAuthorization.error;
    browserRuntimeExecutionContext = {
      tenant_id: tenant.tenant_id,
      workspace_id: tenant.workspace_id,
      runtime_session_id: runtimeAuthorization.decision?.session_id,
      runtime_action_url: stringOpt(a["runtime_action_url"]),
      runtime_authorization_evidence_record_ids: runtimeAuthorization.decision?.evidence_record_ids ?? [],
      now,
    };
    const graphRuntimePreflight = await runDojoGraphRuntimePreflightForProofRun({
      skill: skill.skill,
      tenant,
      requested_action: requestedAction,
      run_id: runId,
      proof_capsule: capsule,
      license_decision: licenseDecision,
      tool_args: toolArgs,
      license_tool_args: licenseToolArgs,
      runtime_authorization: runtimeAuthorization.decision,
      now,
    });
    if (!graphRuntimePreflight.ok) return graphRuntimePreflight.error;
    const graphRuntimePersistence = await persistDurableGraphRuntimePreflightForProofRun({
      context: durableProofRegistry.context,
      tenant,
      skill: skill.skill,
      graph: graphRuntimePreflight.graph,
      graph_run: graphRuntimePreflight.graph_runtime_preflight,
      now,
      operation: "synthi_dojo_run_with_proof_capsule",
    });
    if (!graphRuntimePersistence.ok) return graphRuntimePersistence.error;

    const skillBusExecution = await skillBus.dispatch({
      tenant,
      tool_name: skill.skill.published_tool_name ?? skill.skill.private_tool_manifest?.tool_name ?? "",
      requested_action: requestedAction,
      args: toolArgs,
      proof_capsule: capsule,
      dry_run: false,
    });
    if (!skillBusExecution.ok) {
      const blockedBy = [...(skillBusExecution.blocked_by.length > 0 ? skillBusExecution.blocked_by : licenseDecision.blocked_by)];
      const errorCodes = normalizeDojoProofErrorCodes(blockedBy);
      const validation = {
        ...licenseDecision.validation,
        ok: false,
        status: "blocked" as const,
        error: blockedBy[0] ?? "dojo_skill_bus_blocked",
        blocked_by: blockedBy,
        error_codes: errorCodes,
      };
      return errorResponse(validation.error ?? "dojo_proof_consume_blocked", {
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        run_id: runId,
        validation,
        license_kernel: {
          ...licenseDecision,
          ok: false,
          status: "blocked",
          validation,
          blocked_by: blockedBy,
          error_codes: validation.error_codes,
          proof_record: proofConsume?.record ?? licenseDecision.proof_record ?? null,
        },
        evidence_ledger_validation: proofEvidenceValidation.evidence_ledger_resolution ?? null,
        evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
        proof_consume: proofConsume ?? null,
        skill_bus: skillBusExecution,
        runtime_authorization: runtimeAuthorization.decision ?? null,
        graph_validation: graphRuntimePreflight.graph_validation,
        graph_runtime_preflight: graphRuntimePreflight.graph_runtime_preflight,
        graph_runtime_persistence: graphRuntimePersistence.persistence,
        refusal: refusalFor(skill.skill, blockedBy),
      });
    }

    const run = skillBusExecution.result as ToolResponse | null | undefined;
    if (!run) {
      return errorResponse("dojo_backing_tool_unavailable", {
        skill_id: skill.skill.skill_id,
        requested_action: requestedAction,
        published_tool_name: skill.skill.published_tool_name ?? null,
        skill_bus: skillBusExecution,
        proof_consume: proofConsume,
        runtime_authorization: runtimeAuthorization.decision ?? null,
      });
    }
    const executionLicenseDecision = {
      ...licenseDecision,
      proof_record: proofConsume?.record ?? licenseDecision.proof_record,
    };
    return jsonResponse({
      ok: run.isError !== true,
      skill_id: skill.skill.skill_id,
      requested_action: requestedAction,
      run_id: runId,
      control_plane_source: durableProofRegistry.context.required ? durableProofRegistry.context.source : "compatibility_registry",
      proof_key: validationOptions.proof_key ?? null,
      validation: licenseDecision.validation,
      license_kernel: executionLicenseDecision,
      evidence_ledger_validation: proofEvidenceValidation.evidence_ledger_resolution ?? null,
      evidence_claim_results: proofEvidenceValidation.evidence_claim_results,
      skill_bus: skillBusExecution,
      runtime_authorization: runtimeAuthorization.decision ?? null,
      graph_validation: graphRuntimePreflight.graph_validation,
      graph_runtime_preflight: graphRuntimePreflight.graph_runtime_preflight,
      graph_runtime_persistence: graphRuntimePersistence.persistence,
      proof_capsule_id: capsule.capsule_id,
      proof_consume: proofConsume,
      proof_record: proofConsume?.record,
      backing_tool: requestedAction === "run_prefix_validation" ? "synthi_safety_run_prefix_validation" : skill.skill.published_tool_name,
      result: run.structuredContent ?? {},
    });
  } finally {
    if (durableProofRegistry.context.required) {
      await durableProofRegistry.context.close?.();
    }
  }
}

async function persistDurableGraphRuntimePreflightForProofRun(input: {
  context: DojoDurableProofRegistryContext;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  graph: DojoSkillGraph;
  graph_run: DojoGraphRunResult;
  now?: string;
  operation: string;
}): Promise<{ ok: true; persistence: Record<string, unknown> } | { ok: false; error: ToolResponse }> {
  const common = {
    ok: true,
    operation: input.operation,
    graph_id: input.graph.graph_id,
    graph_run_id: input.graph_run.run_id,
    graph_run_status: input.graph_run.status,
    evidence_refs: input.graph_run.evidence_refs,
  };
  if (!input.context.required) {
    return {
      ok: true,
      persistence: {
        ...common,
        persisted: false,
        store_kind: "compatibility_registry",
      },
    };
  }

  try {
    const graphRecord = await input.context.graph_run_store.saveSkillGraph(input.graph, {
      status: "licensed",
      created_by: input.tenant.actor_id,
    });
    const timestamp = input.now ?? new Date().toISOString();
    const runRecord = await input.context.graph_run_store.saveGraphRun(input.graph_run, {
      graph_id: input.graph.graph_id,
      skill_id: input.skill.skill_id,
      started_at: timestamp,
      completed_at: timestamp,
      created_by: input.tenant.actor_id,
    });
    return {
      ok: true,
      persistence: {
        ...common,
        persisted: true,
        store_kind: input.context.source,
        graph_status: graphRecord.status,
        graph_sha256: graphRecord.graph_sha256,
        graph_run_status: runRecord.status,
        blocked_by: runRecord.blocked_by,
        evidence_refs: runRecord.evidence_refs,
        started_at: runRecord.started_at,
        completed_at: runRecord.completed_at ?? null,
        created_by: runRecord.created_by,
      },
    };
  } catch (err) {
    const blockedBy = ["dojo_graph_runtime_persistence_failed"];
    return {
      ok: false,
      error: errorResponse("dojo_graph_runtime_persistence_failed", {
        ok: false,
        operation: input.operation,
        store_kind: input.context.source,
        skill_id: input.skill.skill_id,
        graph_id: input.graph.graph_id,
        graph_run_id: input.graph_run.run_id,
        message: err instanceof Error ? err.message : String(err),
        proof_not_consumed: true,
        blocked_by: blockedBy,
        error_codes: normalizeDojoProofErrorCodes(blockedBy),
      }),
    };
  }
}

async function runDojoGraphRuntimePreflightForProofRun(input: {
  skill: DojoSkill;
  tenant: DojoTenantContext;
  requested_action: string;
  run_id: string;
  proof_capsule: DojoProofCarryingSkillCapsule;
  license_decision: ReturnType<typeof evaluateDojoLicenseKernel>;
  tool_args: Record<string, unknown>;
  license_tool_args: Record<string, unknown>;
  runtime_authorization?: DojoHostedRuntimeActionDecision;
  now?: string;
}): Promise<{
  ok: true;
  graph: DojoSkillGraph;
  graph_validation: ReturnType<typeof validateDojoSkillGraph>;
  graph_runtime_preflight: DojoGraphRunResult;
} | { ok: false; error: ToolResponse }> {
  const compiled = compileDojoSkillGraphForSkill(input.skill, { mode: "production", created_at: input.now });
  if (!compiled.validation.ok) {
    const blockedBy = compiled.validation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `graph_validation:${issue.issue_id}`);
    return {
      ok: false,
      error: errorResponse("dojo_graph_runtime_validation_failed", {
        ok: false,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        run_id: input.run_id,
        graph_validation: compiled.validation,
        validation: {
          ...input.license_decision.validation,
          ok: false,
          status: "blocked",
          error: "dojo_graph_runtime_validation_failed",
          blocked_by: blockedBy,
          error_codes: normalizeDojoProofErrorCodes(blockedBy),
        },
        license_kernel: {
          ...input.license_decision,
          ok: false,
          status: "blocked",
          blocked_by: blockedBy,
          error_codes: normalizeDojoProofErrorCodes(blockedBy),
        },
        proof_not_consumed: true,
        refusal: refusalFor(input.skill, blockedBy),
      }),
    };
  }
  if (!dojoGraphRepresentsRequestedAction(compiled.graph, input.requested_action)) {
    return {
      ok: true,
      graph: compiled.graph,
      graph_validation: compiled.validation,
      graph_runtime_preflight: {
        ok: true,
        status: "completed",
        mode: "production",
        run_id: `${input.run_id}_graph_preflight`,
        node_results: [],
        blocked_by: [],
        evidence_refs: [
          `evidence:dojo_graph_preflight_support_action_${hashId(JSON.stringify({
            graph_id: compiled.graph.graph_id,
            skill_id: input.skill.skill_id,
            requested_action: input.requested_action,
            run_id: input.run_id,
          }))}`,
        ],
      },
    };
  }

  const runtime = new DojoSkillGraphRuntime();
  const graphRuntimePreflight = await runtime.execute({
    graph: compiled.graph,
    run_id: `${input.run_id}_graph_preflight`,
    mode: "production",
    preflight_only: true,
    inputs: dojoGraphRuntimeInputsForProofRun(input),
    proof_capsule: input.proof_capsule,
    proof_validator: ({ proof_capsule }) => {
      const proof = objectOpt(proof_capsule);
      const capsuleId = stringOpt(proof?.["capsule_id"]);
      if (capsuleId !== input.proof_capsule.capsule_id) {
        return { ok: false, blocked_by: ["proof_capsule_mismatch"] };
      }
      if (!input.license_decision.ok) {
        return {
          ok: false,
          blocked_by: input.license_decision.blocked_by.length > 0
            ? input.license_decision.blocked_by
            : ["dojo_license_kernel_blocked"],
        };
      }
      return { ok: true, blocked_by: [] };
    },
    evidence_writer: (event) => `evidence:dojo_graph_preflight_${hashId(JSON.stringify({
      run_id: event.run_id,
      graph_id: event.graph_id,
      skill_id: event.skill_id,
      graph_version: event.graph_version,
      node_id: event.node_id,
      node_kind: event.node_kind,
      status: event.status,
      blocked_by: event.blocked_by,
      created_at: event.created_at,
    }))}`,
    now: input.now,
  });
  if (!graphRuntimePreflight.ok) {
    const blockedBy = graphRuntimePreflight.blocked_by.length > 0
      ? graphRuntimePreflight.blocked_by
      : ["dojo_graph_runtime_preflight_blocked"];
    const validation = {
      ...input.license_decision.validation,
      ok: false,
      status: "blocked" as const,
      error: blockedBy[0] ?? "dojo_graph_runtime_preflight_blocked",
      blocked_by: blockedBy,
      error_codes: normalizeDojoProofErrorCodes(blockedBy),
    };
    return {
      ok: false,
      error: errorResponse(validation.error, {
        ok: false,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        run_id: input.run_id,
        validation,
        license_kernel: {
          ...input.license_decision,
          ok: false,
          status: "blocked",
          validation,
          blocked_by: blockedBy,
          error_codes: validation.error_codes,
        },
        graph_validation: compiled.validation,
        graph_runtime_preflight: graphRuntimePreflight,
        runtime_authorization: input.runtime_authorization ?? null,
        proof_not_consumed: true,
        refusal: refusalFor(input.skill, blockedBy),
      }),
    };
  }

  return {
    ok: true,
    graph: compiled.graph,
    graph_validation: compiled.validation,
    graph_runtime_preflight: graphRuntimePreflight,
  };
}

function dojoGraphRepresentsRequestedAction(graph: DojoSkillGraph, requestedAction: string): boolean {
  return graph.nodes.some((node) =>
    node.kind === "Action" && (node.action ?? "run_workflow") === requestedAction
  );
}

function dojoGraphRuntimeInputsForProofRun(input: {
  skill: DojoSkill;
  tenant: DojoTenantContext;
  requested_action: string;
  proof_capsule: DojoProofCarryingSkillCapsule;
  tool_args: Record<string, unknown>;
  license_tool_args: Record<string, unknown>;
  runtime_authorization?: DojoHostedRuntimeActionDecision;
}): Record<string, unknown> {
  const authoritativeInputKeys = authoritativeGraphRuntimeInputKeys(input.skill);
  const satisfiedEvidenceClaims = new Set(
    input.proof_capsule.evidence_claims
      .filter((claim) => claim.satisfied)
      .map((claim) => claim.claim)
  );
  const inputs: Record<string, unknown> = {
    ...stripAuthoritativeGraphRuntimeInputs(input.tool_args, authoritativeInputKeys),
    ...stripAuthoritativeGraphRuntimeInputs(input.license_tool_args, authoritativeInputKeys),
    ...input.proof_capsule.context_claims,
    proof_capsule_valid: true,
    proof_capsule_id: input.proof_capsule.capsule_id,
    proof_evidence_record_ids: [...input.proof_capsule.evidence_record_ids],
    proof_guardrails_active: [...input.proof_capsule.guardrails_active],
    durable_state_verification_available: satisfiedEvidenceClaims.has("durable_state_evidence"),
    mutation_isolation_available: input.proof_capsule.context_claims["mutation_isolation_available"] === true
      || input.proof_capsule.context_claims["approval_granted"] === true,
    entrustment_level: input.skill.permission_license.entrustment_level,
    readiness_level: input.skill.skill_readiness_level,
    license_id: input.skill.permission_license.license_id,
    license_version: input.skill.permission_license.license_version,
    requested_action: input.requested_action,
    requested_substrate: input.proof_capsule.substrate_claim,
    tenant_id: input.tenant.tenant_id,
    organization_id: input.tenant.organization_id,
    workspace_id: input.tenant.workspace_id,
    actor_id: input.tenant.actor_id,
    actor_type: input.tenant.actor_type,
    request_id: input.tenant.request_id,
    correlation_id: input.tenant.correlation_id,
    roles: [...input.tenant.roles],
    license_allowed_substrates: allowedSubstratesForProofRun(input.skill, input.requested_action),
  };
  for (const claim of input.proof_capsule.evidence_claims) {
    inputs[claim.claim] = claim.satisfied;
  }
  for (const guardrailId of input.proof_capsule.guardrails_active) {
    inputs[`guardrail:${guardrailId}`] = true;
  }
  for (const guardrail of input.skill.guardrails) {
    if (!input.proof_capsule.guardrails_active.includes(guardrail.guardrail_id)) continue;
    const normalized = normalizeDojoGuardrailPredicate({
      rule: guardrail.rule,
      title: guardrail.title,
      guardrail_id: guardrail.guardrail_id,
    });
    if (normalized.source === "generated_key" && normalized.generated_context_key) {
      inputs[normalized.generated_context_key] = true;
    }
  }
  if (input.runtime_authorization) {
    inputs["runtime_authorized"] = input.runtime_authorization.ok;
    inputs["runtime_session_id"] = input.runtime_authorization.session_id;
    inputs["runtime_authorization_status"] = input.runtime_authorization.status;
    inputs["runtime_authorization_evidence_record_ids"] = [...input.runtime_authorization.evidence_record_ids];
  }
  return inputs;
}

function authoritativeGraphRuntimeInputKeys(skill: DojoSkill): Set<string> {
  const proofContextClaims = skill.permission_license.proof_requirements.required_context_claims;
  const proofEvidenceClaims = skill.permission_license.proof_requirements.required_evidence_claims;
  return new Set([
    ...DOJO_SUPPORTED_EVIDENCE_CLAIMS,
    ...proofContextClaims,
    ...proofEvidenceClaims,
    "proof_capsule_valid",
    "proof_capsule_id",
    "proof_evidence_record_ids",
    "proof_guardrails_active",
    "durable_state_verification_available",
    "mutation_isolation_available",
    "entrustment_level",
    "readiness_level",
    "license_id",
    "license_version",
    "requested_action",
    "requested_substrate",
    "tenant_id",
    "organization_id",
    "workspace_id",
    "actor_id",
    "actor_type",
    "request_id",
    "correlation_id",
    "roles",
    "license_allowed_substrates",
    "runtime_authorized",
    "runtime_session_id",
    "runtime_authorization_status",
    "runtime_authorization_evidence_record_ids",
  ]);
}

function stripAuthoritativeGraphRuntimeInputs(
  args: Record<string, unknown>,
  authoritativeKeys: Set<string>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (authoritativeKeys.has(key)) continue;
    if (key.startsWith("proof_")) continue;
    if (key.startsWith("license_")) continue;
    if (key.startsWith("runtime_authorization_")) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function allowedSubstratesForProofRun(skill: DojoSkill, requestedAction: string): DojoExecutionSubstrate[] {
  const actionRequirements = skill.permission_license.substrate_requirements
    .find((requirement) => requirement.action === requestedAction);
  const allowed = actionRequirements?.allowed_substrates.length
    ? actionRequirements.allowed_substrates
    : skill.execution_substrates;
  return [...new Set(allowed)];
}

async function authorizeHostedRuntimeForProductionRun(input: {
  args: Record<string, unknown>;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  run_id: string;
  requested_action: string;
  proof_capsule: DojoProofCarryingSkillCapsule;
  license_decision: ReturnType<typeof evaluateDojoLicenseKernel>;
  skill_bus_preflight: unknown;
  now?: string;
}): Promise<{ ok: true; decision?: DojoHostedRuntimeActionDecision } | { ok: false; error: ToolResponse }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement) return { ok: true };

  const gatewayResolution = await dojoHostedRuntimeGatewayResolutionForTools();
  if (!gatewayResolution.ok) {
    const blockedBy = [...input.license_decision.blocked_by, ...gatewayResolution.blocked_by];
    const validation = {
      ...input.license_decision.validation,
      ok: false,
      status: "blocked" as const,
      error: "dojo_hosted_runtime_control_plane_store_required",
      blocked_by: blockedBy,
      error_codes: normalizeDojoProofErrorCodes(blockedBy),
    };
    return {
      ok: false,
      error: errorResponse("dojo_hosted_runtime_control_plane_store_required", {
        ok: false,
        skill_id: input.skill.skill_id,
        requested_action: input.requested_action,
        run_id: input.run_id,
        enforcement_mode: enforcement.enforcement_mode,
        validation,
        license_kernel: {
          ...input.license_decision,
          ok: false,
          status: "blocked",
          validation,
          blocked_by: blockedBy,
          error_codes: validation.error_codes,
          proof_record: dojoSkillRegistry.getProofRecord(input.proof_capsule.capsule_id) ?? input.license_decision.proof_record ?? null,
        },
        runtime_authorization: {
          ok: false,
          status: "blocked",
          session_id: stringOpt(input.args["runtime_session_id"]) ?? "",
          action_kind: "proof_gated_tool",
          blocked_by: gatewayResolution.blocked_by,
          audit_event_id: "",
          evidence_record_ids: [],
        },
        proof_not_consumed: true,
        skill_bus: input.skill_bus_preflight,
        refusal: refusalFor(input.skill, blockedBy),
      }),
    };
  }

  const decision = await gatewayResolution.gateway.authorizeAction({
    tenant: input.tenant,
    session_id: stringOpt(input.args["runtime_session_id"]) ?? "",
    skill_id: input.skill.skill_id,
    run_id: input.run_id,
    action_kind: "proof_gated_tool",
    url: stringOpt(input.args["runtime_action_url"]) ?? "",
    credential_id: stringOpt(input.args["runtime_credential_id"]),
    credential_secret: stringOpt(input.args["runtime_credential_secret"]),
    now: input.now,
    details: {
      requested_action: input.requested_action,
      proof_capsule_id: input.proof_capsule.capsule_id,
      backing_tool: input.requested_action === "run_prefix_validation"
        ? "synthi_safety_run_prefix_validation"
        : input.skill.published_tool_name ?? null,
    },
  });
  if (decision.ok) return { ok: true, decision };

  const blockedBy = [...input.license_decision.blocked_by, ...decision.blocked_by];
  const validation = {
    ...input.license_decision.validation,
    ok: false,
    status: "blocked" as const,
    error: "dojo_hosted_runtime_authorization_failed",
    blocked_by: blockedBy,
    error_codes: normalizeDojoProofErrorCodes(blockedBy),
  };
  return {
    ok: false,
    error: errorResponse("dojo_hosted_runtime_authorization_failed", {
      ok: false,
      skill_id: input.skill.skill_id,
      requested_action: input.requested_action,
      run_id: input.run_id,
      enforcement_mode: enforcement.enforcement_mode,
      validation,
      license_kernel: {
        ...input.license_decision,
        ok: false,
        status: "blocked",
        validation,
        blocked_by: blockedBy,
        error_codes: validation.error_codes,
        proof_record: dojoSkillRegistry.getProofRecord(input.proof_capsule.capsule_id) ?? input.license_decision.proof_record ?? null,
      },
      runtime_authorization: decision,
      proof_not_consumed: true,
      skill_bus: input.skill_bus_preflight,
      refusal: refusalFor(input.skill, blockedBy),
    }),
  };
}

async function dispatchBackingSkillTool(
  skill: DojoSkill,
  args: Record<string, unknown>,
  dojoContext: DojoValidatedBrowserWorkflowContext
): Promise<ToolResponse | null> {
  if (!skill.published_tool_name) return null;
  return await dispatchBrowserPrivateWorkflowToolAfterDojoProof(skill.published_tool_name, args, dojoContext);
}

function publishBackingPrivateTool(
  manifest: ReturnType<typeof generatePrivateWorkflowToolManifest>,
  artifact: BrowserWorkflowArtifact
): { ok: true; tool_name: string; tool: ReturnType<typeof privateWorkflowToolDefinition>; registered_at: number } | { ok: false; error: string; tool_name: string; manifest_status: string } {
  const validation = backingPrivateToolPublicationPreflight(manifest, artifact);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      tool_name: validation.tool_name,
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

function backingPrivateToolPublicationPreflight(
  manifest: ReturnType<typeof generatePrivateWorkflowToolManifest>,
  artifact: BrowserWorkflowArtifact
): { ok: true; tool_name: string } | { ok: false; error: string; tool_name: string; manifest_status: string } {
  const validation = validatePrivateWorkflowToolPublication(manifest, {
    reservedToolNames: ADVERTISED_TOOLS,
    workflowArtifact: artifact,
  });
  if (!validation.ok) {
    return {
      ...validation,
      manifest_status: manifest.status,
    };
  }
  return validation;
}

function publishBackingPrivateToolAfterSkillPublication(input: {
  preflight: ReturnType<typeof backingPrivateToolPublicationPreflight>;
  manifest: ReturnType<typeof generatePrivateWorkflowToolManifest>;
  artifact: BrowserWorkflowArtifact;
}): ReturnType<typeof publishBackingPrivateTool> {
  if (!input.preflight.ok) return input.preflight;
  return publishBackingPrivateTool(input.manifest, input.artifact);
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

function requiredAuthorizedSkill(
  args: unknown
): { ok: true; skill: DojoSkill; tenant: DojoTenantContext } | { ok: false; error: ToolResponse } {
  const skill = requiredSkill(args);
  if (!skill.ok) return skill;
  const authorization = authorizeTenantForDojoSkill(args, skill.skill);
  if (!authorization.ok) return authorization;
  return { ok: true, skill: skill.skill, tenant: authorization.tenant };
}

function requireDojoProductionGovernanceRbac(input: {
  tenant: DojoTenantContext;
  action: DojoGovernanceRbacAction;
  error: string;
  details?: Record<string, unknown>;
}): { ok: true; rbac_authorization?: ReturnType<typeof authorizeDojoGovernanceAction> } | { ok: false; error: ToolResponse } {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement) return { ok: true };
  const rbacAuthorization = authorizeDojoGovernanceAction({
    tenant_context: input.tenant,
    action: input.action,
  });
  if (rbacAuthorization.ok) {
    return {
      ok: true,
      rbac_authorization: rbacAuthorization,
    };
  }
  return {
    ok: false,
    error: errorResponse(input.error, {
      ok: false,
      ...(input.details ?? {}),
      actor_id: input.tenant.actor_id,
      actor_type: input.tenant.actor_type,
      blocked_by: rbacAuthorization.blocked_by,
      rbac_authorization: rbacAuthorization,
    }),
  };
}

async function requiredAuthorizedSkillForProductionRead(
  args: unknown,
  operation: string
): Promise<
  | { ok: true; skill: DojoSkill; tenant: DojoTenantContext; control_plane_source: "compatibility_registry" | "postgres" }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  const requested = obj(args);
  const skillId = stringOpt(requested["skill_id"]);
  const workflowId = stringOpt(requested["workflow_id"]);
  if (!enforcement.production_enforcement || !enforcement.require_durable_store || (!skillId && !workflowId)) {
    const local = requiredAuthorizedSkill(args);
    if (!local.ok) return local;
    return {
      ...local,
      control_plane_source: "compatibility_registry",
    };
  }

  const tenantContext = dojoTenantContextResultFromArgs(args);
  if (!tenantContext.ok) return tenantContext;

  let resolution: Awaited<ReturnType<typeof createDojoControlPlaneStoresFromEnv>>;
  try {
    resolution = await createDojoControlPlaneStoresFromEnv({
      tenant: tenantContext.tenant,
    });
  } catch (err) {
    return {
      ok: false,
      error: errorResponse("dojo_control_plane_skill_resolution_failed", {
        ok: false,
        operation,
        skill_id: skillId ?? null,
        workflow_id: workflowId ?? null,
        enforcement_mode: enforcement.enforcement_mode,
        control_plane_source: "postgres",
        blocked_by: ["dojo_control_plane_store_resolution_failed"],
        error_codes: ["dojo_control_plane_store_not_runtime_wired"],
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError(operation, resolution),
    };
  }

  try {
    const skill = skillId
      ? await resolution.skill_store.getSkill(skillId)
      : await resolution.skill_store.getSkillByWorkflowId(workflowId!);
    if (!skill) {
      return {
        ok: false,
        error: errorResponse("dojo_skill_not_found", {
          ok: false,
          operation,
          skill_id: skillId ?? null,
          workflow_id: workflowId ?? null,
          control_plane_source: "postgres",
          required_tool: "synthi_dojo_publish_skill",
        }),
      };
    }
    if (!isTenantAuthorizedForDojoSkill(tenantContext.tenant, skill)) {
      return {
        ok: false,
        error: errorResponse("dojo_skill_not_authorized", {
          ok: false,
          operation,
          skill_id: skill.skill_id,
          workspace_id: skill.workspace_id,
          tenant_workspace_id: tenantContext.tenant.workspace_id,
          actor_id: tenantContext.tenant.actor_id,
          control_plane_source: "postgres",
          blocked_by: ["dojo_skill_workspace_mismatch"],
          required_roles: ["dojo:admin", "dojo:operator"],
        }),
      };
    }
    return {
      ok: true,
      skill,
      tenant: tenantContext.tenant,
      control_plane_source: "postgres",
    };
  } finally {
    await resolution.close?.();
  }
}

function requiredAuthorizedWorkflowArtifact(
  args: unknown
): { ok: true; artifact: BrowserWorkflowArtifact; tenant: DojoTenantContext; workspace_id: string } | { ok: false; error: ToolResponse } {
  const artifact = requiredWorkflowArtifact(args);
  if (!artifact.ok) return artifact;
  const workspaceId = workflowWorkspaceIdForDojoTool(args, artifact.artifact);
  const tenantContext = dojoTenantContextResultFromArgs(args, {
    development_defaults: { workspace_id: workspaceId },
  });
  if (!tenantContext.ok) return tenantContext;
  const tenant = tenantContext.tenant;
  const sourceWorkspaceId = sourceWorkspaceIdForWorkflowArtifact(artifact.artifact);
  const requestedWorkspaceId = stringOpt(obj(args)["workspace_id"]);
  if (
    sourceWorkspaceId
    && requestedWorkspaceId
    && sourceWorkspaceId !== requestedWorkspaceId
    && !isTenantElevatedDojoOperator(tenant)
  ) {
    return {
      ok: false,
      error: errorResponse("dojo_workflow_workspace_mismatch", {
        ok: false,
        workflow_id: artifact.artifact.workflow_id,
        source_workspace_id: sourceWorkspaceId,
        requested_workspace_id: requestedWorkspaceId,
        tenant_workspace_id: tenant.workspace_id,
        actor_id: tenant.actor_id,
        blocked_by: ["dojo_workflow_source_workspace_mismatch"],
        required_roles: ["dojo:admin", "dojo:operator"],
      }),
    };
  }
  if (!isTenantAuthorizedForWorkspace(tenant, workspaceId)) {
    return {
      ok: false,
      error: errorResponse("dojo_workflow_not_authorized", {
        ok: false,
        workflow_id: artifact.artifact.workflow_id,
        workspace_id: workspaceId,
        tenant_workspace_id: tenant.workspace_id,
        actor_id: tenant.actor_id,
        blocked_by: ["dojo_workflow_workspace_mismatch"],
        required_roles: ["dojo:admin", "dojo:operator"],
      }),
    };
  }
  return { ok: true, artifact: artifact.artifact, tenant, workspace_id: workspaceId };
}

function authorizeTenantForDojoSkill(
  args: unknown,
  skill: DojoSkill
): { ok: true; tenant: DojoTenantContext } | { ok: false; error: ToolResponse } {
  const tenantContext = dojoTenantContextResultFromArgs(args, {
    development_defaults: { workspace_id: skill.workspace_id },
  });
  if (!tenantContext.ok) return tenantContext;
  const tenant = tenantContext.tenant;
  if (!isTenantAuthorizedForDojoSkill(tenant, skill)) {
    return {
      ok: false,
      error: errorResponse("dojo_skill_not_authorized", {
        ok: false,
        skill_id: skill.skill_id,
        workspace_id: skill.workspace_id,
        tenant_workspace_id: tenant.workspace_id,
        actor_id: tenant.actor_id,
        blocked_by: ["dojo_skill_workspace_mismatch"],
        required_roles: ["dojo:admin", "dojo:operator"],
      }),
    };
  }
  return { ok: true, tenant };
}

function authorizeTenantForCaseLawRecord(
  args: unknown,
  record: DojoCaseLawRecord,
  selectedSkill: DojoSkill | null
): { ok: true; tenant: DojoTenantContext; scopedSkill: DojoSkill | null; visibleSkills: DojoSkill[] } | { ok: false; error: ToolResponse } {
  const inferredSkill = selectedSkill ?? skillForCaseLawRecord(record);
  const tenantContext = dojoTenantContextResultFromArgs(args, {
    development_defaults: inferredSkill ? { workspace_id: inferredSkill.workspace_id } : undefined,
  });
  if (!tenantContext.ok) return tenantContext;

  const tenant = tenantContext.tenant;
  if (selectedSkill && !isTenantAuthorizedForDojoSkill(tenant, selectedSkill)) {
    return {
      ok: false,
      error: errorResponse("dojo_skill_not_authorized", {
        ok: false,
        skill_id: selectedSkill.skill_id,
        workspace_id: selectedSkill.workspace_id,
        tenant_workspace_id: tenant.workspace_id,
        actor_id: tenant.actor_id,
        blocked_by: ["dojo_skill_workspace_mismatch"],
      }),
    };
  }

  const visibleSkills = visibleDojoSkillsForTenant(tenant);
  const visibleRecords = visibleDojoCaseLawRecordsForTenant(tenant, visibleSkills);
  if (!visibleRecords.some((visible) => visible.case_id === record.case_id)) {
    return {
      ok: false,
      error: errorResponse("dojo_case_law_not_authorized", {
        ok: false,
        case_id: record.case_id,
        binding_scope: record.binding_scope,
        tenant_workspace_id: tenant.workspace_id,
        actor_id: tenant.actor_id,
        blocked_by: ["dojo_case_law_scope_mismatch"],
      }),
    };
  }

  const scopedSkill = selectedSkill
    ?? visibleSkills.find((skill) => caseLawRecordAppliesToSkill(record, skill))
    ?? null;
  return { ok: true, tenant, scopedSkill, visibleSkills };
}

function isTenantAuthorizedForDojoSkill(tenant: DojoTenantContext, skill: DojoSkill): boolean {
  return isTenantAuthorizedForWorkspace(tenant, skill.workspace_id);
}

function isTenantAuthorizedForWorkspace(tenant: DojoTenantContext, workspaceId: string): boolean {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement && tenant.roles.includes("dojo:legacy")) return true;
  if (isTenantElevatedDojoOperator(tenant)) return true;
  return tenant.workspace_id === workspaceId;
}

function isTenantElevatedDojoOperator(tenant: DojoTenantContext): boolean {
  return tenant.roles.some((role) => role === "admin" || role === "dojo:admin" || role === "dojo:operator");
}

function workflowWorkspaceIdForDojoTool(args: unknown, artifact: BrowserWorkflowArtifact): string {
  return stringOpt(obj(args)["workspace_id"]) ?? sourceWorkspaceIdForWorkflowArtifact(artifact) ?? "unknown-workspace";
}

function sourceWorkspaceIdForWorkflowArtifact(artifact: BrowserWorkflowArtifact): string | null {
  for (const step of artifact.workflow.contract.steps) {
    const workspaceId = step.sourcePlan.workspaceId;
    if (workspaceId) return workspaceId;
  }
  return null;
}

function visibleDojoSkillsForTenant(tenant: DojoTenantContext, skills: DojoSkill[] = dojoSkillRegistry.list()): DojoSkill[] {
  return skills.filter((skill) => isTenantAuthorizedForDojoSkill(tenant, skill));
}

async function validateCaseLawEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
}): Promise<
  | { ok: true; evidence_ledger_resolution?: Record<string, unknown> }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_case_law_evidence_required",
    resolution_error: "dojo_case_law_evidence_ledger_resolution_failed",
    scope_error: "dojo_case_law_evidence_ledger_scope_mismatch",
    missing_blocked_by: "case_law_evidence_refs_missing",
    scope_mismatch_block_prefix: "case_law_evidence_skill_mismatch",
  });
}

async function validatePermissionUpgradeEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
  required_claims?: DojoEvidenceClaimId[];
}): Promise<
  | {
    ok: true;
    evidence_ledger_resolution?: Record<string, unknown>;
    evidence_claim_results?: DojoEvidenceClaimResult[];
  }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_permission_upgrade_evidence_required",
    resolution_error: "dojo_permission_upgrade_evidence_ledger_resolution_failed",
    claim_error: "dojo_permission_upgrade_promotion_evidence_policy_failed",
    scope_error: "dojo_permission_upgrade_evidence_ledger_scope_mismatch",
    missing_blocked_by: "permission_upgrade_evidence_refs_missing",
    scope_mismatch_block_prefix: "permission_upgrade_evidence_skill_mismatch",
  });
}

async function validateLicenseRevocationEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
}): Promise<
  | { ok: true; evidence_ledger_resolution?: Record<string, unknown> }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_license_revocation_evidence_required",
    resolution_error: "dojo_license_revocation_evidence_ledger_resolution_failed",
    scope_error: "dojo_license_revocation_evidence_ledger_scope_mismatch",
    missing_blocked_by: "license_revocation_evidence_refs_missing",
    scope_mismatch_block_prefix: "license_revocation_evidence_skill_mismatch",
  });
}

async function validateRecertificationEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
}): Promise<
  | { ok: true; evidence_ledger_resolution?: Record<string, unknown> }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_recertification_evidence_required",
    resolution_error: "dojo_recertification_evidence_ledger_resolution_failed",
    scope_error: "dojo_recertification_evidence_ledger_scope_mismatch",
    missing_blocked_by: "recertification_evidence_refs_missing",
    scope_mismatch_block_prefix: "recertification_evidence_skill_mismatch",
  });
}

async function validateProofCapsuleRevocationEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
}): Promise<
  | { ok: true; evidence_ledger_resolution?: Record<string, unknown> }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_proof_capsule_revocation_evidence_required",
    resolution_error: "dojo_proof_capsule_revocation_evidence_ledger_resolution_failed",
    scope_error: "dojo_proof_capsule_revocation_evidence_ledger_scope_mismatch",
    missing_blocked_by: "proof_capsule_revocation_evidence_refs_missing",
    scope_mismatch_block_prefix: "proof_capsule_revocation_evidence_skill_mismatch",
  });
}

async function validatePublicationEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
}): Promise<
  | { ok: true; evidence_ledger_resolution?: Record<string, unknown> }
  | { ok: false; error: ToolResponse }
> {
  return validateGovernanceEvidenceRefsAgainstLedgerIfRequired({
    ...input,
    missing_error: "dojo_skill_publication_evidence_required",
    resolution_error: "dojo_skill_publication_evidence_ledger_resolution_failed",
    scope_error: "dojo_skill_publication_evidence_ledger_scope_mismatch",
    missing_blocked_by: "skill_publication_evidence_refs_missing",
    scope_mismatch_block_prefix: "skill_publication_evidence_skill_mismatch",
  });
}

async function validateGovernanceEvidenceRefsAgainstLedgerIfRequired(input: {
  operation: string;
  tenant: DojoTenantContext;
  skill: DojoSkill;
  evidence_refs: string[];
  checked_at: string;
  required_claims?: DojoEvidenceClaimId[];
  missing_error: string;
  resolution_error: string;
  claim_error?: string;
  scope_error: string;
  missing_blocked_by: string;
  scope_mismatch_block_prefix: string;
}): Promise<
  | {
    ok: true;
    evidence_ledger_resolution?: Record<string, unknown>;
    evidence_claim_results?: DojoEvidenceClaimResult[];
  }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_evidence_ledger) {
    return { ok: true };
  }

  const evidenceRefs = [...new Set(input.evidence_refs.map((ref) => ref.trim()).filter(Boolean))];
  if (evidenceRefs.length === 0) {
    return {
      ok: false,
      error: errorResponse(input.missing_error, {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        blocked_by: [input.missing_blocked_by],
      }),
    };
  }

  const resolved = await resolveDojoEvidenceLedgerRecords({
    tenant_id: input.tenant.tenant_id,
    workspace_id: input.tenant.workspace_id,
    record_ids: evidenceRefs,
    checked_at: input.checked_at,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorResponse(input.resolution_error, {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        evidence_refs: evidenceRefs,
        evidence_record_ids: evidenceRefs,
        missing_evidence_record_ids: resolved.missing_record_ids,
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        evidence_ledger_store_kind: resolved.store_kind,
        evidence_ledger_configured_env: resolved.configured_env,
        blocked_by: resolved.blocked_by,
        verification: resolved.verification,
      }),
    };
  }

  const mismatchedRecords = resolved.records.filter((record) => record.skill_id !== input.skill.skill_id);
  if (mismatchedRecords.length > 0) {
    return {
      ok: false,
      error: errorResponse(input.scope_error, {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        workspace_id: input.skill.workspace_id,
        evidence_record_ids: evidenceRefs,
        mismatched_evidence_record_ids: mismatchedRecords.map((record) => record.record_id),
        mismatched_skill_ids: [...new Set(mismatchedRecords.map((record) => record.skill_id))],
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        evidence_ledger_store_kind: resolved.store_kind,
        blocked_by: mismatchedRecords.map((record) => `${input.scope_mismatch_block_prefix}:${record.record_id}`),
      }),
    };
  }

  const requiredClaims = [...new Set(input.required_claims ?? [])];
  const evidenceClaimResults = requiredClaims.length > 0
    ? resolveDojoEvidenceClaims({
      claim_ids: requiredClaims,
      records: resolved.records,
      tenant_id: input.tenant.tenant_id,
      workspace_id: input.tenant.workspace_id,
      skill_id: input.skill.skill_id,
      checked_at: input.checked_at,
    })
    : undefined;
  const failedEvidenceClaims = evidenceClaimResults?.filter((result) => !result.ok) ?? [];
  if (failedEvidenceClaims.length > 0) {
    return {
      ok: false,
      error: errorResponse(input.claim_error ?? input.resolution_error, {
        ok: false,
        operation: input.operation,
        skill_id: input.skill.skill_id,
        evidence_refs: evidenceRefs,
        evidence_record_ids: resolved.records.map((record) => record.record_id),
        required_evidence_claims: requiredClaims,
        failed_evidence_claims: failedEvidenceClaims.map((result) => result.claim_id),
        evidence_claim_results: evidenceClaimResults,
        ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
        evidence_ledger_store_kind: resolved.store_kind,
        blocked_by: failedEvidenceClaims.flatMap((result) => result.blocked_by),
        verification: resolved.verification,
      }),
    };
  }

  return {
    ok: true,
    evidence_claim_results: evidenceClaimResults,
    evidence_ledger_resolution: {
      store_kind: resolved.store_kind,
      evidence_record_ids: resolved.records.map((record) => record.record_id),
      record_count: resolved.records.length,
      ledger_checkpoint_hash: resolved.ledger_checkpoint_hash,
      verification: resolved.verification,
      ...(evidenceClaimResults
        ? {
          required_evidence_claims: requiredClaims,
          evidence_claim_results: evidenceClaimResults,
        }
        : {}),
    },
  };
}

async function visibleDojoSkillsForTenantFromControlPlaneIfRequired(
  tenant: DojoTenantContext,
  operation: string
): Promise<
  | { ok: true; skills: DojoSkill[]; control_plane_source: "compatibility_registry" | "postgres" }
  | { ok: false; error: ToolResponse }
> {
  const durableSkills = await listDurableDojoSkillsForTenantIfRequired(tenant, operation);
  if (!durableSkills.ok) return durableSkills;
  return {
    ok: true,
    skills: visibleDojoSkillsForTenant(tenant, durableSkills.skills ?? dojoSkillRegistry.list()),
    control_plane_source: durableSkills.source,
  };
}

function visibleDojoCaseLawRecordsForTenant(tenant: DojoTenantContext, skills: DojoSkill[]): DojoCaseLawRecord[] {
  const skillIds = new Set(skills.map((skill) => skill.skill_id));
  const workspaceIds = new Set(skills.map((skill) => skill.workspace_id));
  const organizationIds = new Set<string>([tenant.organization_id]);
  for (const skill of skills) {
    organizationIds.add(bindingScopeIdForSkillCase(skill, "organization"));
  }
  return dojoSkillRegistry.listCaseLawRecords()
    .filter((record) => {
      if (record.binding_scope.kind === "tenant") {
        return record.binding_scope.id === tenant.tenant_id || record.binding_scope.id === `tenant:${tenant.tenant_id}`;
      }
      if (record.binding_scope.kind === "skill") return skillIds.has(record.binding_scope.id);
      if (record.binding_scope.kind === "workspace") return workspaceIds.has(record.binding_scope.id);
      if (record.binding_scope.kind === "organization") return organizationIds.has(record.binding_scope.id);
      return false;
    })
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function visibleDojoPermissionUpgradeRequestsForSkills(skills: DojoSkill[]): DojoPermissionUpgradeRequestRecord[] {
  const skillIds = new Set(skills.map((skill) => skill.skill_id));
  const workspaceIds = new Set(skills.map((skill) => skill.workspace_id));
  return dojoSkillRegistry.listPermissionUpgradeRequests()
    .filter((request) => skillIds.has(request.skill_id) && workspaceIds.has(request.workspace_id))
    .sort((left, right) => left.request_id.localeCompare(right.request_id));
}

async function governanceServiceViewForTenant(
  tenant: DojoTenantContext,
  now: string,
  visibleSkills?: DojoSkill[],
  options: {
    proof_key_records?: DojoProofKeyRecord[];
  } = {}
) {
  const skills = visibleSkills ?? visibleDojoSkillsForTenant(tenant);
  return buildDojoGovernanceServiceView({
    skills,
    case_law_records: visibleDojoCaseLawRecordsForTenant(tenant, skills),
    permission_upgrade_requests: visibleDojoPermissionUpgradeRequestsForSkills(skills),
    audit_events: await visibleDojoAuditEventsForTenant(tenant, skills),
    proof_key_records: options.proof_key_records,
    now,
  });
}

const SCHEDULED_GOVERNANCE_JOB_KINDS: DojoGovernanceScheduledJobKind[] = [
  "archive_compliance_evidence",
  "expire_stale_license",
  "notify_approver",
  "recompute_registry_metrics",
  "review_case_law",
  "run_recertification",
];

function scheduledJobKindSetFromInput(value: unknown): (
  | { ok: true; kinds: Set<DojoGovernanceScheduledJobKind> }
  | { ok: false; invalid: string[] }
) {
  if (!Array.isArray(value)) return { ok: true, kinds: new Set() };
  const allowed = new Set<string>(SCHEDULED_GOVERNANCE_JOB_KINDS);
  const values = stringArrayOpt(value);
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, kinds: new Set(values as DojoGovernanceScheduledJobKind[]) };
}

function buildScheduledGovernanceJobHandlersForTool(input: {
  dry_run: boolean;
  tenant: DojoTenantContext;
  now: string;
  skills: DojoSkill[];
  governance_service: DojoGovernanceServiceView;
  license_store?: DojoLicenseStore;
}): DojoGovernanceScheduledJobHandlers {
  const dryRun = (jobKind: DojoGovernanceScheduledJobKind, nextStep: string) => ({
    ok: true,
    status: "skipped" as const,
    details: {
      dry_run: true,
      job_kind: jobKind,
      next_step: nextStep,
    },
  });

  return {
    recompute_registry_metrics: ({ job }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      return {
        ok: true,
        evidence_refs: job.evidence_refs,
        details: {
          recomputed_at: input.now,
          metrics: input.governance_service.metrics,
        },
      };
    },
    archive_compliance_evidence: ({ job }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      const archiveManifest = buildDojoComplianceEvidenceArchiveManifest({
        tenant_context: input.tenant,
        compliance_evidence_pack: input.governance_service.compliance_evidence_pack,
        archived_at: input.now,
      });
      if (!archiveManifest.ok) {
        return {
          ok: false,
          blocked_by: archiveManifest.blocked_by,
          details: {
            pack_id: input.governance_service.compliance_evidence_pack.pack_id,
            retention_class: input.governance_service.compliance_evidence_pack.retention_class,
            artifact_count: input.governance_service.compliance_evidence_pack.artifacts.length,
            missing_artifacts: archiveManifest.missing_artifacts,
          },
        };
      }
      return {
        ok: true,
        evidence_refs: [
          `compliance_archive:${archiveManifest.manifest.archive_id}`,
          ...archiveManifest.manifest.evidence_refs,
        ],
        details: {
          archive_manifest: archiveManifest.manifest,
          archive_manifest_sha256: archiveManifest.manifest.manifest_sha256,
        },
      };
    },
    expire_stale_license: async ({ job, actor, now }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      if (!job.license_id) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_license_id_missing"],
          details: { job_id: job.job_id, skill_id: job.skill_id ?? null },
        };
      }
      if (!input.license_store) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_durable_license_store_required"],
          details: {
            license_id: job.license_id,
            required_store: "DojoLicenseStore",
          },
        };
      }
      const expired = await input.license_store.expireLicense(job.license_id, job.reason, now, actor, {
        expires_at: now,
      });
      if (!expired) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_license_not_found"],
          details: { license_id: job.license_id },
        };
      }
      return {
        ok: true,
        evidence_refs: [`license:${expired.license_id}:expired`],
        details: {
          license_id: expired.license_id,
          skill_id: expired.skill_id,
          status: expired.status,
          expires_at: expired.expires_at ?? now,
        },
      };
    },
    notify_approver: ({ job }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      return {
        ok: false,
        blocked_by: ["scheduled_job_external_notification_dispatcher_required"],
        details: {
          queue_id: job.queue_id ?? null,
          skill_id: job.skill_id ?? null,
          required_follow_up: "synthi_dojo_review_permission_upgrade",
        },
      };
    },
    review_case_law: ({ job }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      return {
        ok: false,
        blocked_by: ["scheduled_job_human_case_law_review_required"],
        details: {
          queue_id: job.queue_id ?? null,
          skill_id: job.skill_id ?? null,
          required_follow_up: "synthi_dojo_review_case_law",
        },
      };
    },
    run_recertification: async ({ job }) => {
      if (input.dry_run) return dryRun(job.kind, job.next_step);
      if (!job.skill_id) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_skill_id_missing"],
          details: { job_id: job.job_id },
        };
      }
      const skill = input.skills.find((candidate) => candidate.skill_id === job.skill_id);
      if (!skill) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_skill_not_visible"],
          details: { skill_id: job.skill_id },
        };
      }
      const recertification = await dojoRecertifySkillTool({
        ...tenantContextArgs(input.tenant),
        skill_id: skill.skill_id,
        workflow_id: skill.workflow_id,
        reason: job.reason,
        evidence_refs: job.evidence_refs,
        actor_id: input.tenant.actor_id,
        actor_type: input.tenant.actor_type,
        now: input.now,
      });
      if (recertification.isError) {
        return {
          ok: false,
          blocked_by: ["scheduled_job_recertification_failed"],
          details: {
            skill_id: skill.skill_id,
            recertification_response: recertification.structuredContent ?? {},
          },
        };
      }
      return {
        ok: true,
        evidence_refs: [`recertification:${job.queue_id ?? skill.skill_id}`],
        details: {
          skill_id: skill.skill_id,
          recertification: obj(recertification.structuredContent)["recertification"] ?? recertification.structuredContent ?? {},
        },
      };
    },
  };
}

function tenantContextArgs(tenant: DojoTenantContext): Record<string, unknown> {
  return {
    tenant_id: tenant.tenant_id,
    organization_id: tenant.organization_id,
    workspace_id: tenant.workspace_id,
    actor_id: tenant.actor_id,
    actor_type: tenant.actor_type,
    roles: [...tenant.roles],
    request_id: tenant.request_id,
    correlation_id: tenant.correlation_id,
    ...(tenant.data_region ? { data_region: tenant.data_region } : {}),
  };
}

async function proofPublicVerificationExportForTenant(input: {
  tenant: DojoTenantContext;
  skill_ids: string[];
  now: string;
  operation: string;
}): Promise<
  | { ok: true; proof_key_records?: DojoProofKeyRecord[]; artifacts: DojoRepoArtifact[] }
  | { ok: false; error: ToolResponse }
> {
  const enforcement = resolveDojoEnforcementConfig();
  if (!enforcement.production_enforcement || !enforcement.require_durable_store) {
    return { ok: true, artifacts: [] };
  }
  const resolution = await createDojoControlPlaneStoresFromEnv({ tenant: input.tenant });
  if (!resolution.ok) {
    return {
      ok: false,
      error: controlPlaneResolutionError(input.operation, resolution),
    };
  }
  try {
    const skillIds = new Set(input.skill_ids);
    const proofRecords = (await resolution.proof_store.listProofRecords())
      .filter((record) => skillIds.has(record.skill_id));
    const proofKeyIds = new Set(proofRecords.map((record) => record.key_id).filter((keyId): keyId is string => Boolean(keyId)));
    const proofKeyRecords = (await resolution.proof_key_registry.list(input.tenant.tenant_id))
      .filter((record) => proofKeyIds.has(record.key_id));
    const bundle = buildDojoProofPublicVerificationBundle({
      tenant: input.tenant,
      proof_keys: proofKeyRecords,
      generated_at: input.now,
    });
    const artifacts: DojoRepoArtifact[] = proofKeyRecords.length > 0
      ? [{
        path: `.synthi/dojo/compliance/proof-public-verification.${hashId(`${input.tenant.tenant_id}:${input.tenant.workspace_id}:${input.now}:${proofKeyRecords.length}`)}.json`,
        content_type: "application/json",
        content: `${JSON.stringify(bundle, null, 2)}\n`,
        sensitive: false,
      }]
      : [];
    return {
      ok: true,
      proof_key_records: proofKeyRecords,
      artifacts,
    };
  } finally {
    await resolution.close?.();
  }
}

async function visibleDojoAuditEventsForTenant(
  tenant: DojoTenantContext,
  skills: DojoSkill[]
): Promise<DojoAuditEventRecord[]> {
  if (skills.length === 0) return [];
  const skillIds = new Set(skills.map((skill) => skill.skill_id));
  const workspaceIds = new Set(skills.map((skill) => skill.workspace_id));
  const enforcement = resolveDojoEnforcementConfig();
  let records: DojoAuditEventRecord[];
  if (enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({ tenant });
    if (!resolution.ok) {
      records = [];
    } else {
      try {
        records = await resolution.audit_store.listAuditEvents({ limit: 500 });
      } finally {
        await resolution.close?.();
      }
    }
  } else {
    records = await dojoSkillRegistry.listAuditEvents();
  }
  return records
    .filter((record) => record.tenant_id === tenant.tenant_id)
    .filter((record) => workspaceIds.has(record.workspace_id))
    .filter((record) => {
      const detailSkillId = typeof record.details["skill_id"] === "string" ? record.details["skill_id"] : undefined;
      return !detailSkillId || skillIds.has(detailSkillId);
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.audit_event_id.localeCompare(right.audit_event_id));
}

function skillForCaseLawRecord(record: DojoCaseLawRecord): DojoSkill | null {
  return dojoSkillRegistry.list()
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id))
    .find((skill) => caseLawRecordAppliesToSkill(record, skill))
    ?? null;
}

function caseLawRecordAppliesToSkill(record: DojoCaseLawRecord, skill: DojoSkill): boolean {
  if (record.binding_scope.kind === "skill") return record.binding_scope.id === skill.skill_id;
  if (record.binding_scope.kind === "workspace") return record.binding_scope.id === skill.workspace_id;
  if (record.binding_scope.kind === "organization") {
    return record.binding_scope.id === bindingScopeIdForSkillCase(skill, "organization");
  }
  return false;
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
    published_tools: skill.published_tools,
    api_backed_mcp_tools: (skill.api_backed_mcp_tools ?? []).map((tool) => ({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      action: tool.action,
      method: tool.method,
      path: tool.path,
      schema_digest: tool.schema_digest,
    })),
    mcp_skill_manifest: buildDojoMcpSkillManifest(skill),
    checkride: {
      checkride_id: skill.checkride.checkride_id,
      coverage_score: skill.checkride.coverage_score,
      critical_failures: skill.checkride.critical_failures,
      blocked_scenarios: skill.checkride.blocked_scenarios,
    },
    executable_entrustment: skill.executable_entrustment ?? null,
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
    case "executable_entrustment_provenance":
      return normalized.includes("skill.json")
        || normalized.includes("checkride.report.md")
        || normalized.includes("evidence-manifest.json")
        || normalized.includes("evidence-ledger.json")
        || normalized.includes(".ledger.json");
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

function caseLawRuntimeBindingSummary(graph: DojoSkillGraph, caseLawRecords: DojoCaseLawRecord[]) {
  const boundCaseLawRefs = [...new Set(graph.nodes.flatMap((node) => node.case_law_refs))].sort();
  const boundCaseLawGuardrailIds = [...new Set(graph.nodes
    .flatMap((node) => node.guardrails)
    .filter((guardrail) => guardrail.guardrail_id.startsWith("case_guard_"))
    .map((guardrail) => guardrail.guardrail_id))]
    .sort();
  return {
    case_law_record_count: caseLawRecords.length,
    approved_case_law_record_count: caseLawRecords.filter((record) => record.status === "approved").length,
    bound_case_law_refs: boundCaseLawRefs,
    bound_case_law_guardrail_ids: boundCaseLawGuardrailIds,
    graph_node_count: graph.nodes.length,
  };
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
    const guardrail = guardrailForCaseLawRecord(record);
    const antibody = antibodyForCaseLawRecord(record, guardrail, record.updated_at);
    updated.guardrails = upsertBy(updated.guardrails, guardrail, "guardrail_id");
    updated.antibodies = upsertBy(updated.antibodies, antibody, "antibody_id");
    updated.case_law_refs = [...new Set([...updated.case_law_refs, record.case_id])];
    updated.permission_license = {
      ...updated.permission_license,
      license_version: bumpVersion(updated.permission_license.license_version),
      proof_requirements: {
        ...updated.permission_license.proof_requirements,
        required_guardrails: [...new Set([
          ...updated.permission_license.proof_requirements.required_guardrails,
          guardrail.guardrail_id,
        ])],
      },
    };
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
      antibody_count: updated.antibodies.length,
    },
    evidence_refs: [...new Set([...updated.training_report.evidence_refs, ...record.evidence_refs])],
    readiness_decision: `Case law ${record.case_id} ${record.status}; governance review recorded.`,
  };
  updated.last_trained_at = record.updated_at;
  return updated;
}

function guardrailForCaseLawRecord(record: DojoCaseLawRecord): DojoSkill["guardrails"][number] {
  return {
    guardrail_id: `guard_${hashId(`${record.case_id}:${record.rule_created}`)}`,
    title: `${record.title} guardrail`,
    rule: record.rule_created,
    blocks_actions: record.applies_to.length > 0 ? [...record.applies_to] : ["run_workflow"],
    source_case_id: record.case_id,
    severity: "high",
  };
}

function antibodyForCaseLawRecord(
  record: DojoCaseLawRecord,
  guardrail: DojoSkill["guardrails"][number],
  createdAt: string
): DojoSkill["antibodies"][number] {
  return {
    antibody_id: `antibody_${hashId(`${record.case_id}:${guardrail.guardrail_id}`)}`,
    case_id: record.case_id,
    guardrail_id: guardrail.guardrail_id,
    trigger: record.finding,
    response: record.rule_created,
    applies_to: [...record.applies_to],
    binding_scope: skillCaseBindingScopeFromRecord(record),
    evidence_refs: [...record.evidence_refs],
    created_at: createdAt,
  };
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

type DojoPermissionUpgradeLicensePromotion =
  | {
    applied: true;
    status: "applied";
    skill: DojoSkill;
    previous_license_version: string;
    license_action_status: "gated";
    summary: Record<string, unknown>;
  }
  | {
    applied: false;
    status: "not_approved" | "already_allowed";
    skill: DojoSkill;
    previous_license_version: string;
    license_action_status: "unchanged" | "already_allowed";
    summary: Record<string, unknown>;
  };

type DojoPermissionUpgradePromotionEvidencePolicySummary = {
  ok: boolean;
  promotion_required: boolean;
  requested_action: string;
  required_steps: string[];
  required_claims: DojoEvidenceClaimId[];
  provided_claims: string[];
  verification_source: "not_required" | "caller_asserted" | "ledger" | "ledger_deferred";
  authoritative: boolean;
  evidence_claim_results?: DojoEvidenceClaimResult[];
  failed_evidence_claims?: string[];
  missing_claims?: string[];
  unmapped_required_steps?: string[];
};

type DojoPermissionUpgradePromotionEvidencePolicyResult =
  | {
    ok: true;
    summary: DojoPermissionUpgradePromotionEvidencePolicySummary;
    blocked_by: [];
  }
  | {
    ok: false;
    summary: DojoPermissionUpgradePromotionEvidencePolicySummary;
    blocked_by: string[];
  };

function validatePermissionUpgradePromotionEvidencePolicy(input: {
  request: DojoPermissionUpgradeRequestRecord;
  asserted_claims?: string[];
  evidence_claim_results?: DojoEvidenceClaimResult[];
  production_ledger_enforced: boolean;
}): DojoPermissionUpgradePromotionEvidencePolicyResult {
  const requirement = permissionUpgradePromotionEvidenceRequirementFor(input.request);
  const providedClaims = uniqueNonEmptyStrings(input.asserted_claims ?? []);
  const baseSummary = {
    promotion_required: requirement.required_claims.length > 0 || requirement.unmapped_required_steps.length > 0,
    requested_action: input.request.requested_action,
    required_steps: [...input.request.required_steps],
    required_claims: requirement.required_claims,
    provided_claims: providedClaims,
  };
  if (input.request.status !== "approved" || !baseSummary.promotion_required) {
    return {
      ok: true,
      blocked_by: [],
      summary: {
        ok: true,
        ...baseSummary,
        verification_source: "not_required",
        authoritative: true,
      },
    };
  }
  if (requirement.unmapped_required_steps.length > 0) {
    const blockedBy = requirement.unmapped_required_steps.map((step) => `promotion_required_step_unmapped:${step}`);
    return {
      ok: false,
      blocked_by: blockedBy,
      summary: {
        ok: false,
        ...baseSummary,
        verification_source: input.production_ledger_enforced ? "ledger" : "caller_asserted",
        authoritative: input.production_ledger_enforced,
        unmapped_required_steps: requirement.unmapped_required_steps,
      },
    };
  }
  if (input.production_ledger_enforced) {
    if (!input.evidence_claim_results) {
      return {
        ok: true,
        blocked_by: [],
        summary: {
          ok: true,
          ...baseSummary,
          verification_source: "ledger_deferred",
          authoritative: false,
        },
      };
    }
    const failed = input.evidence_claim_results.filter((result) => !result.ok);
    if (failed.length > 0) {
      return {
        ok: false,
        blocked_by: failed.flatMap((result) => result.blocked_by),
        summary: {
          ok: false,
          ...baseSummary,
          verification_source: "ledger",
          authoritative: true,
          evidence_claim_results: input.evidence_claim_results,
          failed_evidence_claims: failed.map((result) => result.claim_id),
        },
      };
    }
    return {
      ok: true,
      blocked_by: [],
      summary: {
        ok: true,
        ...baseSummary,
        verification_source: "ledger",
        authoritative: true,
        evidence_claim_results: input.evidence_claim_results,
      },
    };
  }

  const providedClaimSet = new Set(providedClaims);
  const missingClaims = requirement.required_claims.filter((claim) => !providedClaimSet.has(claim));
  if (missingClaims.length > 0) {
    return {
      ok: false,
      blocked_by: missingClaims.map((claim) => `promotion_evidence_claim_missing:${claim}`),
      summary: {
        ok: false,
        ...baseSummary,
        verification_source: "caller_asserted",
        authoritative: false,
        missing_claims: missingClaims,
      },
    };
  }
  return {
    ok: true,
    blocked_by: [],
    summary: {
      ok: true,
      ...baseSummary,
      verification_source: "caller_asserted",
      authoritative: false,
    },
  };
}

function permissionUpgradePromotionEvidenceRequirementFor(request: DojoPermissionUpgradeRequestRecord): {
  required_claims: DojoEvidenceClaimId[];
  unmapped_required_steps: string[];
} {
  const requiredClaims = new Set<DojoEvidenceClaimId>();
  const unmappedRequiredSteps: string[] = [];
  const actionableSteps = request.required_steps.filter((step) => step !== "no_upgrade_required_for_current_license");
  for (const step of actionableSteps) {
    const claims = permissionUpgradeEvidenceClaimsForRequiredStep(step);
    if (!claims) {
      unmappedRequiredSteps.push(step);
      continue;
    }
    for (const claim of claims) requiredClaims.add(claim);
  }
  if (requiredClaims.size > 0) requiredClaims.add("evidence_fresh");
  return {
    required_claims: [...requiredClaims],
    unmapped_required_steps: unmappedRequiredSteps,
  };
}

function permissionUpgradeEvidenceClaimsForRequiredStep(step: string): DojoEvidenceClaimId[] | null {
  switch (step) {
    case "rerun_checkride_for_requested_action":
    case "resolve_critical_checkride_failures":
      return ["checkride_passed"];
    case "activate_guardrails":
    case "harden_evil_twin_escaped_attacks":
      return ["guardrails_active", "checkride_passed"];
    case "publish_backing_private_workflow_tool":
    case "add_dom_source_or_mcp_substrate":
      return ["substrate_allowed"];
    case "no_upgrade_required_for_current_license":
      return [];
    default:
      return null;
  }
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function permissionUpgradeLicensePromotionFor(
  skill: DojoSkill,
  request: DojoPermissionUpgradeRequestRecord
): DojoPermissionUpgradeLicensePromotion {
  const previousLicenseVersion = skill.permission_license.license_version;
  if (request.status !== "approved") {
    return {
      applied: false,
      status: "not_approved",
      skill,
      previous_license_version: previousLicenseVersion,
      license_action_status: "unchanged",
      summary: {
        ok: true,
        applied: false,
        status: "not_approved",
        requested_action: request.requested_action,
        previous_license_version: previousLicenseVersion,
        license_version: previousLicenseVersion,
      },
    };
  }

  const existingAllowed = skill.permission_license.allowed_actions.find((action) => action.action === request.requested_action);
  if (existingAllowed) {
    return {
      applied: false,
      status: "already_allowed",
      skill,
      previous_license_version: previousLicenseVersion,
      license_action_status: "already_allowed",
      summary: {
        ok: true,
        applied: false,
        status: "already_allowed",
        requested_action: request.requested_action,
        previous_license_version: previousLicenseVersion,
        license_version: previousLicenseVersion,
        constraints: existingAllowed.constraints,
      },
    };
  }

  const updated = cloneJson(skill);
  const reviewedAt = request.reviewed_at ?? new Date().toISOString();
  const promotionEvidenceRequirement = permissionUpgradePromotionEvidenceRequirementFor(request);
  const gatedConstraints = [...new Set([
    "permission_upgrade_approved",
    `permission_upgrade_request:${request.request_id}`,
    ...request.required_steps
      .filter((step) => step !== "no_upgrade_required_for_current_license")
      .map((step) => `required_step:${step}`),
    ...promotionEvidenceRequirement.required_claims.map((claim) => `promotion_claim:${claim}`),
    ...(request.decision_evidence_refs ?? []).map((ref) => `review_evidence:${ref}`),
  ])];
  const nextLicense = {
    ...updated.permission_license,
    license_version: bumpVersion(previousLicenseVersion),
    issued_at: reviewedAt,
    gated_actions: upsertLicenseAction(updated.permission_license.gated_actions, {
      action: request.requested_action,
      constraints: gatedConstraints,
    }),
    blocked_actions: updated.permission_license.blocked_actions
      .filter((action) => action.action !== request.requested_action),
    approval_requirements: [...new Set([
      ...updated.permission_license.approval_requirements,
      request.requested_action,
    ])],
    substrate_requirements: upsertPermissionUpgradeSubstrateRequirement(updated, request.requested_action),
  };
  updated.permission_license = nextLicense;
  updated.license_expires_at = licenseExpiresAtFromIssuedAt(nextLicense.issued_at);
  updated.skill_card = {
    ...updated.skill_card,
    status: `Licensed ${nextLicense.entrustment_level}`,
    can_do_alone: nextLicense.allowed_actions.map((action) => action.action),
    will_ask_before: nextLicense.gated_actions.map((action) => action.action),
    will_not_do: nextLicense.blocked_actions.map((action) => action.action),
    proof_badge: nextLicense.proof_requirements.required_evidence_claims.length > 0 ? "Proof required" : "Proof optional",
  };
  updated.skill_passport = {
    ...updated.skill_passport,
    passport_id: `passport_${hashId(`${updated.skill_id}:${updated.skill_version}:${nextLicense.license_id}:${nextLicense.license_version}`)}`,
    license_id: nextLicense.license_id,
    license_expires_at: updated.license_expires_at,
    issued_at: nextLicense.issued_at,
  };
  updated.training_report = {
    ...updated.training_report,
    evidence_refs: [...new Set([
      ...updated.training_report.evidence_refs,
      ...request.evidence_refs,
      ...(request.decision_evidence_refs ?? []),
    ])],
    readiness_decision: `Permission upgrade ${request.request_id} approved; ${request.requested_action} is gated by approval evidence under license ${nextLicense.license_version}.`,
  };
  updated.assurance_case = {
    ...updated.assurance_case,
    evidence_refs: [...new Set([
      ...updated.assurance_case.evidence_refs,
      ...request.evidence_refs,
      ...(request.decision_evidence_refs ?? []),
    ])],
    limits: [...new Set([
      ...updated.assurance_case.limits,
      `permission_upgrade:${request.requested_action}:approval_required`,
      ...request.required_steps.map((step) => `permission_upgrade_required_step:${step}`),
    ])],
  };
  updated.last_trained_at = reviewedAt;

  return {
    applied: true,
    status: "applied",
    skill: updated,
    previous_license_version: previousLicenseVersion,
    license_action_status: "gated",
    summary: {
      ok: true,
      applied: true,
      status: "applied",
      requested_action: request.requested_action,
      license_action_status: "gated",
      previous_license_version: previousLicenseVersion,
      license_version: nextLicense.license_version,
      license_id: nextLicense.license_id,
      approval_required: true,
      constraints: gatedConstraints,
      promotion_evidence_policy: {
        required_claims: promotionEvidenceRequirement.required_claims,
        unmapped_required_steps: promotionEvidenceRequirement.unmapped_required_steps,
      },
      evidence_refs: [...request.evidence_refs],
      decision_evidence_refs: [...(request.decision_evidence_refs ?? [])],
      expires_at: updated.license_expires_at,
    },
  };
}

function upsertPermissionUpgradeSubstrateRequirement(
  skill: DojoSkill,
  requestedAction: string
): DojoSkill["permission_license"]["substrate_requirements"] {
  const existing = skill.permission_license.substrate_requirements.find((requirement) => requirement.action === requestedAction);
  const fallback = skill.permission_license.substrate_requirements.find((requirement) =>
    skill.permission_license.allowed_actions.some((action) => action.action === requirement.action)
  );
  const allowedSubstrates = existing?.allowed_substrates
    ?? fallback?.allowed_substrates
    ?? skill.execution_substrates;
  if (allowedSubstrates.length === 0) return skill.permission_license.substrate_requirements;
  const next = {
    action: requestedAction,
    allowed_substrates: [...new Set(allowedSubstrates)],
  };
  return [
    ...skill.permission_license.substrate_requirements.filter((requirement) => requirement.action !== requestedAction),
    next,
  ];
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

function evidenceLedgerRecordsOpt(value: unknown): DojoEvidenceLedgerRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectOpt(item))
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .map((record) => ({
      schema_version: "synthi.dojo.evidenceRecord.v1" as const,
      record_id: stringOpt(record["record_id"]) ?? stringOpt(record["recordId"]) ?? "",
      tenant_id: stringOpt(record["tenant_id"]) ?? stringOpt(record["tenantId"]) ?? "",
      workspace_id: stringOpt(record["workspace_id"]) ?? stringOpt(record["workspaceId"]) ?? "",
      skill_id: stringOpt(record["skill_id"]) ?? stringOpt(record["skillId"]) ?? "",
      run_id: stringOpt(record["run_id"]) ?? stringOpt(record["runId"]) ?? "",
      kind: evidenceArtifactKindOpt(record["kind"]),
      artifact_uri: stringOpt(record["artifact_uri"]) ?? stringOpt(record["artifactUri"]) ?? "",
      artifact_sha256: stringOpt(record["artifact_sha256"]) ?? stringOpt(record["artifactSha256"]) ?? "",
      redaction_manifest_sha256: stringOpt(record["redaction_manifest_sha256"]) ?? stringOpt(record["redactionManifestSha256"]) ?? null,
      claim_ids: stringArrayOpt(record["claim_ids"] ?? record["claimIds"]),
      previous_hash: stringOpt(record["previous_hash"]) ?? stringOpt(record["previousHash"]) ?? "",
      signer_key_id: stringOpt(record["signer_key_id"]) ?? stringOpt(record["signerKeyId"]) ?? null,
      created_at: stringOpt(record["created_at"]) ?? stringOpt(record["createdAt"]) ?? "",
      created_by: stringOpt(record["created_by"]) ?? stringOpt(record["createdBy"]) ?? "",
      retention_class: evidenceRetentionClassOpt(record["retention_class"] ?? record["retentionClass"]),
      source_refs: stringArrayOpt(record["source_refs"] ?? record["sourceRefs"]),
      legal_hold: boolOpt(record["legal_hold"] ?? record["legalHold"]),
      record_hash: stringOpt(record["record_hash"]) ?? stringOpt(record["recordHash"]) ?? "",
      ledger_head_hash: stringOpt(record["ledger_head_hash"]) ?? stringOpt(record["ledgerHeadHash"]) ?? "",
      signature: stringOpt(record["signature"]) ?? null,
    }))
    .filter((record) => record.record_id && record.created_at && record.claim_ids.length > 0);
}

function evidenceArtifactKindOpt(value: unknown): DojoEvidenceLedgerRecord["kind"] {
  return value === "trace"
    || value === "scenario"
    || value === "checkride"
    || value === "case_law"
    || value === "guardrail"
    || value === "license"
    || value === "proof"
    || value === "artifact"
    || value === "audit"
    ? value
    : "artifact";
}

function evidenceRetentionClassOpt(value: unknown): DojoEvidenceLedgerRecord["retention_class"] {
  return value === "ephemeral" || value === "regulated" || value === "legal_hold" ? value : "standard";
}

function hostedRuntimeSessionPublicView(session: DojoHostedRuntimeSessionRecord): Record<string, unknown> {
  return {
    schema_version: session.schema_version,
    session_id: session.session_id,
    runtime_id: session.runtime_id,
    tenant_id: session.tenant_id,
    organization_id: session.organization_id,
    workspace_id: session.workspace_id,
    skill_id: session.skill_id,
    run_id: session.run_id,
    actor_id: session.actor_id,
    actor_type: session.actor_type,
    workspace_url: session.workspace_url,
    workspace_origin: session.workspace_origin,
    origin_allowlist: [...session.origin_allowlist],
    status: session.status,
    created_at: session.created_at,
    expires_at: session.expires_at,
    credential_id: session.credential_id,
    credential_expires_at: session.credential_expires_at,
    egress_policy: { ...session.egress_policy },
    redaction_policy: { ...session.redaction_policy },
    audit_event_refs: [...session.audit_event_refs],
    evidence_refs: [...session.evidence_refs],
  };
}

function substrateOpt(value: unknown): DojoExecutionSubstrate | undefined {
  return value === "vision" || value === "dom" || value === "source" || value === "api" || value === "mcp" ? value : undefined;
}

function dojoTenantContextResultFromArgs(
  args: unknown,
  options: { development_defaults?: Record<string, unknown> } = {}
): { ok: true; tenant: DojoTenantContext } | { ok: false; error: ToolResponse } {
  const a = obj(args);
  const enforcement = resolveDojoEnforcementConfig();
  const missing = productionTenantContextMissingFields(a);
  const actorType = actorTypeInputOpt(a["actor_type"]);
  const actorTypeProvided = stringOpt(a["actor_type"]) !== undefined;
  if (enforcement.production_enforcement && actorTypeProvided && !actorType) {
    return {
      ok: false,
      error: errorResponse("dojo_tenant_context_actor_type_invalid", {
        ok: false,
        enforcement_mode: enforcement.enforcement_mode,
        accepted_actor_types: ["human", "agent", "service"],
        blocked_by: ["tenant_context_actor_type_invalid"],
      }),
    };
  }
  if (enforcement.production_enforcement && missing.length > 0) {
    return {
      ok: false,
      error: errorResponse("dojo_tenant_context_required", {
        ok: false,
        enforcement_mode: enforcement.enforcement_mode,
        required_fields: PRODUCTION_TENANT_CONTEXT_FIELDS,
        missing_fields: missing,
        blocked_by: missing.map((field) => `tenant_context_${field}_missing`),
      }),
    };
  }
  return {
    ok: true,
    tenant: dojoTenantContextFromArgs({
      ...(options.development_defaults ?? {}),
      ...a,
    }),
  };
}

const PRODUCTION_TENANT_CONTEXT_FIELDS = [
  "tenant_id",
  "organization_id",
  "workspace_id",
  "actor_id",
  "actor_type",
  "roles",
  "request_id",
  "correlation_id",
] as const;

type ProductionTenantContextField = (typeof PRODUCTION_TENANT_CONTEXT_FIELDS)[number];

function productionTenantContextMissingFields(a: Record<string, unknown>): ProductionTenantContextField[] {
  const missing: ProductionTenantContextField[] = [];
  for (const field of PRODUCTION_TENANT_CONTEXT_FIELDS) {
    if (field === "roles") {
      if (stringArrayOpt(a[field]).length === 0) missing.push(field);
      continue;
    }
    if (field === "actor_type") {
      if (!stringOpt(a[field])) missing.push(field);
      continue;
    }
    if (!stringOpt(a[field])) missing.push(field);
  }
  return missing;
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

function dojoLicenseKernelToolArgsFromArgs(
  args: unknown,
  tenant: DojoTenantContext,
  toolArgs: Record<string, unknown>
): Record<string, unknown> {
  const a = obj(args);
  const merged = { ...toolArgs };
  setMissingString(merged, "tenant_id", stringOpt(a["tenant_id"]) ?? tenant.tenant_id);
  setMissingString(merged, "organization_id", stringOpt(a["organization_id"]) ?? tenant.organization_id);
  setMissingString(merged, "workspace_id", stringOpt(a["workspace_id"]) ?? tenant.workspace_id);
  setMissingString(merged, "actor_id", stringOpt(a["actor_id"]) ?? tenant.actor_id);
  setMissingString(merged, "actor_type", actorTypeInputOpt(a["actor_type"]) ?? tenant.actor_type);
  setMissingString(merged, "request_id", stringOpt(a["request_id"]) ?? tenant.request_id);
  setMissingString(merged, "correlation_id", stringOpt(a["correlation_id"]) ?? tenant.correlation_id);
  setMissingString(merged, "approval_id", stringOpt(a["approval_id"]));
  setMissingString(merged, "approval_status", approvalStatusInputOpt(a["approval_status"]));
  setMissingString(merged, "approval_evidence_ref", stringOpt(a["approval_evidence_ref"]));
  if (!Object.prototype.hasOwnProperty.call(merged, "roles") && tenant.roles.length > 0) {
    merged["roles"] = [...tenant.roles];
  }
  return merged;
}

function setMissingString(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (!Object.prototype.hasOwnProperty.call(target, key) && value) target[key] = value;
}

function actorTypeOpt(value: unknown): DojoTenantContext["actor_type"] {
  return value === "human" || value === "service" ? value : "agent";
}

function actorTypeInputOpt(value: unknown): DojoTenantContext["actor_type"] | undefined {
  return value === "human" || value === "agent" || value === "service" ? value : undefined;
}

function approvalStatusInputOpt(value: unknown): "approved" | "denied" | "pending" | undefined {
  return value === "approved" || value === "denied" || value === "pending" ? value : undefined;
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
  const updated = skillWithDojoRuns(skill, runs, windTunnelExecution);
  return updated === skill ? skill : dojoSkillRegistry.publish(updated);
}

function skillWithDojoRuns(
  skill: DojoSkill,
  runs: DojoSkill["training_runs"],
  windTunnelExecution?: Awaited<ReturnType<typeof runDojoWindTunnel>>,
  options: { now?: string } = {}
): DojoSkill {
  if (runs.length === 0) return skill;
  const updated = cloneJson(skill);
  const now = options.now ?? new Date().toISOString();
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
      generated_at: now,
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
  updated.last_trained_at = now;
  return updated;
}

async function licenseHealthFor(skill: DojoSkill, tenant?: DojoTenantContext): Promise<Record<string, unknown>> {
  const proofRecordsResult = await proofRecordsForLicenseHealth(skill, tenant);
  const proofRecords = proofRecordsResult.records;
  const proofRecordCounts = proofRecords.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
  const lifecycle = buildDojoLifecycleReport(skill);
  const governance = buildDojoGovernanceReport(skill);
  const blockedByLifecycle = lifecycle.status === "blocked" || lifecycle.status === "expired";
  return {
    schema_version: "synthi.dojo.licenseHealth.v1",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    status: skill.entrustment_level === "EX" || blockedByLifecycle
      ? "blocked"
      : lifecycle.status,
    entrustment_level: skill.entrustment_level,
    skill_readiness_level: skill.skill_readiness_level,
    license_version: skill.permission_license.license_version,
    license_expires_at: skill.license_expires_at,
    days_until_expiry: lifecycle.days_until_expiry,
    proof_records: proofRecordCounts,
    proof_record_source: proofRecordsResult.source,
    proof_record_count: proofRecords.length,
    active_guardrails: skill.guardrails.length,
    binding_case_law: skill.case_law.filter((item) => item.status === "binding").length,
    lifecycle,
    governance,
    metrics: buildDojoUniverseMetrics([skill]),
  };
}

async function proofRecordsForLicenseHealth(
  skill: DojoSkill,
  tenant?: DojoTenantContext
): Promise<{ records: DojoProofCapsuleRecord[]; source: "compatibility_registry" | "postgres" }> {
  const enforcement = resolveDojoEnforcementConfig();
  if (tenant && enforcement.production_enforcement && enforcement.require_durable_store) {
    const resolution = await createDojoControlPlaneStoresFromEnv({
      tenant,
      app_origin: skill.app_origin,
    });
    if (resolution.ok) {
      try {
        const records = await resolution.proof_store.listProofRecords();
        return {
          source: "postgres",
          records: records.filter((record) => record.skill_id === skill.skill_id),
        };
      } finally {
        await resolution.close?.();
      }
    }
  }
  return {
    source: "compatibility_registry",
    records: dojoSkillRegistry.listProofRecords().filter((record) => record.skill_id === skill.skill_id),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourcePatchInputFilesOpt(value: unknown): DojoSourcePatchInputFile[] {
  if (!Array.isArray(value)) return [];
  const files: DojoSourcePatchInputFile[] = [];
  for (const item of value) {
    const record = objectOpt(item);
    const filePath = stringOpt(record?.["path"]);
    const source = typeof record?.["source"] === "string" ? record["source"] as string : undefined;
    if (!filePath || source === undefined) continue;
    files.push({ path: filePath, source });
  }
  return files;
}

type SourceTokenSnapshotsResult =
  | { ok: true; tokens: DojoSourceTokenSnapshot[] }
  | { ok: false; blocked_by: string[]; errors: Array<{ index?: number; field?: string; message: string }> };

function sourceTokenSnapshotsResult(value: unknown): SourceTokenSnapshotsResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      blocked_by: ["source_tokens_missing"],
      errors: [{ field: "source_tokens", message: "source_tokens must be an array." }],
    };
  }
  const tokens: DojoSourceTokenSnapshot[] = [];
  const errors: Array<{ index?: number; field?: string; message: string }> = [];
  value.forEach((item, index) => {
    const record = objectOpt(item);
    if (!record) {
      errors.push({ index, message: "source token must be an object." });
      return;
    }
    const tokenId = stringOpt(record["token_id"]);
    const route = stringOpt(record["route"]);
    const component = stringOpt(record["component"]);
    const sourceLocator = stringOpt(record["source_locator"]);
    const action = stringOpt(record["action"]);
    const sourceSha256 = stringOpt(record["source_sha256"]);
    const risk = sourceTokenRiskOpt(record["risk"]);
    if (!tokenId) errors.push({ index, field: "token_id", message: "token_id is required." });
    if (!route) errors.push({ index, field: "route", message: "route is required." });
    if (!component) errors.push({ index, field: "component", message: "component is required." });
    if (!sourceLocator) errors.push({ index, field: "source_locator", message: "source_locator is required." });
    if (record["risk"] !== undefined && !risk) {
      errors.push({ index, field: "risk", message: "risk must be safe, mutation, or dangerous." });
    }
    if (!tokenId || !route || !component || !sourceLocator || (record["risk"] !== undefined && !risk)) return;
    tokens.push({
      token_id: tokenId,
      route,
      component,
      ...(action ? { action } : {}),
      source_locator: sourceLocator,
      ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
      ...(risk ? { risk } : {}),
    });
  });
  if (errors.length > 0) {
    return {
      ok: false,
      blocked_by: [...new Set(errors.map((error) => error.field ? `source_token_${error.field}_invalid` : "source_token_invalid"))],
      errors,
    };
  }
  return { ok: true, tokens };
}

function sourceTokenRiskOpt(value: unknown): DojoSourceTokenSnapshot["risk"] | undefined {
  return value === "safe" || value === "mutation" || value === "dangerous" ? value : undefined;
}

type SourceDriftNodeBindingsResult =
  | { ok: true; bindings: DojoGraphNodeSourceBinding[] }
  | { ok: false; blocked_by: string[]; errors: Array<{ index?: number; field?: string; message: string }> };

function sourceDriftNodeBindingsResult(value: unknown): SourceDriftNodeBindingsResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      blocked_by: ["source_drift_node_bindings_missing"],
      errors: [{ field: "node_bindings", message: "node_bindings must be an array." }],
    };
  }
  const bindings: DojoGraphNodeSourceBinding[] = [];
  const errors: Array<{ index?: number; field?: string; message: string }> = [];
  value.forEach((item, index) => {
    const record = objectOpt(item);
    if (!record) {
      errors.push({ index, message: "node binding must be an object." });
      return;
    }
    const nodeId = stringOpt(record["node_id"]);
    const sourceTokenIds = stringArrayOpt(record["source_token_ids"]);
    const licenseId = stringOpt(record["license_id"]);
    if (!nodeId) errors.push({ index, field: "node_id", message: "node_id is required." });
    if (sourceTokenIds.length === 0) {
      errors.push({ index, field: "source_token_ids", message: "source_token_ids must include at least one token ID." });
    }
    if (!nodeId || sourceTokenIds.length === 0) return;
    bindings.push({
      node_id: nodeId,
      source_token_ids: sourceTokenIds,
      ...(licenseId ? { license_id: licenseId } : {}),
    });
  });
  if (errors.length > 0) {
    return {
      ok: false,
      blocked_by: [...new Set(errors.map((error) => error.field ? `source_drift_node_binding_${error.field}_invalid` : "source_drift_node_binding_invalid"))],
      errors,
    };
  }
  return { ok: true, bindings };
}

function sourceSnapshotTenantScopeBlockedBy(
  tenant: DojoTenantContext,
  previousSnapshot: DojoSourceSnapshot,
  nextSnapshot: DojoSourceSnapshot
): string[] {
  const blockedBy: string[] = [];
  if (previousSnapshot.tenant_id !== tenant.tenant_id) blockedBy.push("source_drift_previous_snapshot_tenant_mismatch");
  if (nextSnapshot.tenant_id !== tenant.tenant_id) blockedBy.push("source_drift_next_snapshot_tenant_mismatch");
  if (previousSnapshot.workspace_id !== tenant.workspace_id) blockedBy.push("source_drift_previous_snapshot_workspace_mismatch");
  if (nextSnapshot.workspace_id !== tenant.workspace_id) blockedBy.push("source_drift_next_snapshot_workspace_mismatch");
  if (previousSnapshot.tenant_id !== nextSnapshot.tenant_id) blockedBy.push("source_drift_snapshot_pair_tenant_mismatch");
  if (previousSnapshot.workspace_id !== nextSnapshot.workspace_id) blockedBy.push("source_drift_snapshot_pair_workspace_mismatch");
  return blockedBy;
}

type SourceDriftLicenseStore = Pick<DojoLicenseStore, "getLicense" | "expireLicense">;

function sourceDriftReportOpt(value: unknown): DojoSourceDriftReport | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  if (record["schema_version"] !== "synthi.dojo.sourceDriftReport.v1") return undefined;
  const requiredStrings = [
    "previous_snapshot_id",
    "next_snapshot_id",
    "app_origin",
    "previous_app_version",
    "next_app_version",
  ];
  if (requiredStrings.some((field) => !stringOpt(record[field]))) return undefined;
  const requiredArrays = [
    "drifted_token_ids",
    "added_token_ids",
    "review_required_token_ids",
    "affected_nodes",
    "license_expiry_triggers",
  ];
  if (requiredArrays.some((field) => !Array.isArray(record[field]))) return undefined;
  return record as unknown as DojoSourceDriftReport;
}

function sourceDriftScopedLicenseStore(input: {
  tenant: DojoTenantContext;
  report: DojoSourceDriftReport;
  dry_run: boolean;
  license_store: SourceDriftLicenseStore;
  resolve_skill: (skillId: string) => Promise<DojoSkill | null> | DojoSkill | null;
}): SourceDriftLicenseStore {
  const getScopedLicense = async (licenseId: string): Promise<DojoPermissionLicenseRecord | null> => {
    const record = await input.license_store.getLicense(licenseId);
    if (!record) return null;
    if (record.workspace_id !== input.tenant.workspace_id && !isTenantElevatedDojoOperator(input.tenant)) return null;
    const skill = await input.resolve_skill(record.skill_id);
    if (!skill) return null;
    if (!isTenantAuthorizedForDojoSkill(input.tenant, skill)) return null;
    if (skill.app_origin !== input.report.app_origin) return null;
    if (skill.permission_license.license_id !== record.license_id) return null;
    return record;
  };

  return {
    getLicense: getScopedLicense,
    async expireLicense(licenseId, reason, now = new Date().toISOString(), expiredBy, options) {
      const existing = await getScopedLicense(licenseId);
      if (!existing) return null;
      if (input.dry_run) {
        return expiredLicenseRecordForSourceDrift(existing, reason, now, options?.expires_at);
      }
      return input.license_store.expireLicense(licenseId, reason, now, expiredBy, options);
    },
  };
}

function compatibilitySourceDriftLicenseStore(
  tenant: DojoTenantContext,
  report: DojoSourceDriftReport,
  now: string
): SourceDriftLicenseStore {
  const skillForLicense = (licenseId: string): DojoSkill | null => {
    return dojoSkillRegistry.list().find((skill) =>
      skill.permission_license.license_id === licenseId
      && skill.app_origin === report.app_origin
      && isTenantAuthorizedForDojoSkill(tenant, skill)
    ) ?? null;
  };

  return {
    getLicense(licenseId) {
      const skill = skillForLicense(licenseId);
      if (!skill) return null;
      return compatibilityLicenseRecordForSkill(
        tenant,
        skill,
        compatibilityLicenseStatusForSkill(skill, now),
        now
      );
    },
    expireLicense(licenseId, reason, expiredAt = new Date().toISOString(), expiredBy, options) {
      const skill = skillForLicense(licenseId);
      if (!skill) return null;
      const status = compatibilityLicenseStatusForSkill(skill, expiredAt);
      if (status !== "active") return null;
      const effectiveExpiresAt = options?.expires_at ?? expiredAt;
      const updated = expireCompatibilitySkillForSourceDrift(skill, {
        reason,
        expired_at: effectiveExpiresAt,
        expired_by: expiredBy,
      });
      const saved = dojoSkillRegistry.publish(updated);
      return compatibilityLicenseRecordForSkill(tenant, saved, "expired", expiredAt, effectiveExpiresAt, reason);
    },
  };
}

function compatibilityLicenseStatusForSkill(skill: DojoSkill, now: string): DojoStoredLicenseStatus {
  const expiry = Date.parse(skill.license_expires_at);
  const reference = Date.parse(now);
  if (Number.isFinite(expiry) && Number.isFinite(reference) && expiry <= reference) return "expired";
  if (skill.entrustment_level === "EX" && skill.permission_license.autonomy_level === "blocked") return "revoked";
  return "active";
}

function compatibilityLicenseRecordForSkill(
  tenant: DojoTenantContext,
  skill: DojoSkill,
  status: DojoStoredLicenseStatus,
  updatedAt: string,
  expiresAt: string = skill.license_expires_at,
  reason?: string
): DojoPermissionLicenseRecord {
  return {
    tenant_id: tenant.tenant_id,
    workspace_id: skill.workspace_id,
    license_id: skill.permission_license.license_id,
    skill_id: skill.skill_id,
    license_version: skill.permission_license.license_version,
    status,
    entrustment_level: skill.permission_license.entrustment_level,
    readiness_level: skill.skill_readiness_level,
    license_json: cloneJson(skill.permission_license),
    expires_at: expiresAt,
    ...(reason ? { revoked_reason: reason } : {}),
    created_at: skill.permission_license.issued_at || skill.generated_at,
    updated_at: updatedAt,
  };
}

function expiredLicenseRecordForSourceDrift(
  record: DojoPermissionLicenseRecord,
  reason: string,
  updatedAt: string,
  expiresAt: string = updatedAt
): DojoPermissionLicenseRecord {
  return {
    ...cloneJson(record),
    status: "expired",
    expires_at: expiresAt,
    revoked_reason: reason,
    updated_at: updatedAt,
  };
}

function expireCompatibilitySkillForSourceDrift(
  skill: DojoSkill,
  input: {
    reason: string;
    expired_at: string;
    expired_by?: DojoAuditActor;
  }
): DojoSkill {
  const updated = cloneJson(skill);
  const condition = `source_drift:${input.reason}`;
  const evidenceRef = `source_drift:${hashId(input.reason)}`;
  updated.license_expires_at = input.expired_at;
  updated.skill_card = {
    ...updated.skill_card,
    status: "Expired pending source-drift recertification",
    proof_badge: "Source drift detected; recertification required",
  };
  updated.skill_passport = {
    ...updated.skill_passport,
    proof_required: true,
    license_expires_at: input.expired_at,
  };
  updated.training_report = {
    ...updated.training_report,
    readiness_decision: `License expired due to source drift. Recertification required before production execution. ${input.reason}`,
    limitations: dedupeStrings([...updated.training_report.limitations, condition]),
    evidence_refs: dedupeStrings([...updated.training_report.evidence_refs, evidenceRef]),
  };
  updated.retrain_triggers = [
    ...updated.retrain_triggers.filter((trigger) => trigger.condition !== condition),
    {
      trigger_id: sourceDriftRecertificationTriggerId(updated.skill_id, updated.permission_license.license_id, input.reason),
      source: "app",
      condition,
    },
  ];
  updated.last_trained_at = input.expired_at;
  if (input.expired_by) {
    updated.assurance_case = {
      ...updated.assurance_case,
      limits: dedupeStrings([
        ...updated.assurance_case.limits,
        `source drift expiry applied by ${input.expired_by.actor_type}:${input.expired_by.actor_id}`,
      ]),
    };
  }
  return updated;
}

async function persistSourceDriftExpiredSkills(input: {
  tenant: DojoTenantContext;
  report: DojoSourceDriftReport;
  application: DojoSourceDriftExpiryApplication;
  resolve_skill: (skillId: string) => Promise<DojoSkill | null> | DojoSkill | null;
  save_skill: (skill: DojoSkill) => Promise<{ skill_id: string; status: string; updated_at: string }>;
  now: string;
}): Promise<DojoSourceDriftExpiredSkillUpdate[]> {
  const updates: DojoSourceDriftExpiredSkillUpdate[] = [];
  for (const expired of input.application.expired_licenses) {
    const skill = await input.resolve_skill(expired.record.skill_id);
    if (!skill) {
      updates.push({
        skill_id: expired.record.skill_id,
        license_id: expired.license_id,
        status: "skipped",
        skipped_by: ["source_drift_skill_record_missing"],
      });
      continue;
    }
    if (!isTenantAuthorizedForDojoSkill(input.tenant, skill) || skill.app_origin !== input.report.app_origin) {
      updates.push({
        skill_id: skill.skill_id,
        license_id: expired.license_id,
        status: "skipped",
        skipped_by: ["source_drift_skill_scope_mismatch"],
      });
      continue;
    }
    const updatedSkill = expireCompatibilitySkillForSourceDrift(skill, {
      reason: sourceDriftExpiredLicenseReason(input.report, expired),
      expired_at: input.now,
      expired_by: input.application.applied_by,
    });
    const recertificationTrigger = updatedSkill.retrain_triggers.find((trigger) =>
      trigger.condition === `source_drift:${sourceDriftExpiredLicenseReason(input.report, expired)}`
    );
    const saved = await input.save_skill(updatedSkill);
    updates.push({
      skill_id: saved.skill_id,
      license_id: expired.license_id,
      status: saved.status,
      updated_at: saved.updated_at,
      workflow_id: updatedSkill.workflow_id,
      ...(recertificationTrigger ? { recertification_trigger_id: recertificationTrigger.trigger_id } : {}),
    });
  }
  return updates;
}

async function sourceDriftRecertificationSkillsById(input: {
  application: DojoSourceDriftExpiryApplication;
  resolve_skill: (skillId: string) => Promise<DojoSkill | null | undefined> | DojoSkill | null | undefined;
}): Promise<Record<string, DojoSourceDriftRecertificationSkillInfo | undefined>> {
  const skillsById: Record<string, DojoSourceDriftRecertificationSkillInfo | undefined> = {};
  const skillIds = [...new Set(input.application.expired_licenses.map((expired) => expired.record.skill_id))].sort();
  for (const skillId of skillIds) {
    const skill = await input.resolve_skill(skillId);
    if (!skill) {
      skillsById[skillId] = undefined;
      continue;
    }
    skillsById[skillId] = {
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
    };
  }
  return skillsById;
}

function codeOwnerRulesOpt(value: unknown): DojoGeneratedPrCodeOwnerRule[] {
  if (!Array.isArray(value)) return [];
  const rules: DojoGeneratedPrCodeOwnerRule[] = [];
  for (const item of value) {
    const record = objectOpt(item);
    if (!record) continue;
    const owners = Array.isArray(record["owners"])
      ? record["owners"].map((owner) => stringOpt(owner)).filter((owner): owner is string => Boolean(owner))
      : [];
    if (owners.length === 0) continue;
    rules.push({
      ...(stringOpt(record["path_prefix"]) ? { path_prefix: stringOpt(record["path_prefix"]) } : {}),
      ...(stringOpt(record["glob"]) ? { glob: stringOpt(record["glob"]) } : {}),
      owners,
      ...(stringOpt(record["review_gate"]) ? { review_gate: stringOpt(record["review_gate"]) } : {}),
    });
  }
  return rules;
}

function sourceAffordanceArtifactRefs(
  planId: string,
  patchBundle: ReturnType<typeof buildDojoGeneratedSourcePatchBundle>
): DojoGeneratedPrArtifactRef[] {
  const normalizedPlanId = planId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "source-affordance";
  return [
    {
      kind: "patch_plan",
      path: `.synthi/dojo/source/${normalizedPlanId}.affordance-pr-plan.json`,
      sha256: sha256String(JSON.stringify({
        plan_id: planId,
        app_origin: patchBundle.app_origin,
        app_version: patchBundle.app_version,
        modified_files: patchBundle.modified_files.map((file) => ({
          path: file.path,
          after_sha256: file.after_sha256,
          applied_operations: file.applied_operations,
        })),
        generated_tests: patchBundle.generated_tests.map((file) => ({
          path: file.path,
          sha256: sha256String(file.source),
        })),
      })),
    },
    ...patchBundle.generated_tests.map((file) => ({
      kind: "contract_test" as const,
      path: file.path,
      sha256: sha256String(file.source),
    })),
  ];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function dedupeSubstrates(values: DojoExecutionSubstrate[]): DojoExecutionSubstrate[] {
  return [...new Set(values)];
}

function apiBackedMcpToolOpt(value: unknown): DojoApiBackedMcpTool | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  if (record["schema_version"] !== "synthi.dojo.apiBackedMcpTool.v1") return undefined;
  const toolName = stringOpt(record["tool_name"]);
  const toolVersion = stringOpt(record["tool_version"]);
  const candidateId = stringOpt(record["candidate_id"]);
  const method = apiMethodOpt(record["method"]);
  const apiPath = stringOpt(record["path"]);
  const skillId = stringOpt(record["skill_id"]);
  const licenseId = stringOpt(record["license_id"]);
  const licenseVersion = stringOpt(record["license_version"]);
  const action = stringOpt(record["action"]);
  const proofClaimMapping = stringRecordOpt(record["proof_claim_mapping"]);
  const inputSchema = objectOpt(record["input_schema"]);
  const schemaDigest = stringOpt(record["schema_digest"]);
  const enforcement = objectOpt(record["enforcement"]);
  if (
    !toolName
    || !toolVersion
    || !candidateId
    || !method
    || !apiPath
    || !skillId
    || !licenseId
    || !licenseVersion
    || !action
    || !inputSchema
    || !schemaDigest
    || record["proof_required"] !== true
    || !enforcement
    || enforcement["proof_capsule_required"] !== true
    || enforcement["license_kernel_required"] !== true
    || enforcement["evidence_write_required"] !== true
  ) {
    return undefined;
  }
  const authScope = record["auth_scope"] === null ? null : stringOpt(record["auth_scope"]) ?? null;
  const querySchema = record["query_schema"] === null ? null : objectOpt(record["query_schema"]) ?? null;
  const idempotency = record["idempotency_key_location"] === null
    ? null
    : idempotencyKeyLocationOpt(record["idempotency_key_location"]) ?? null;
  const rollback = record["rollback_strategy"] === null
    ? null
    : rollbackStrategyOpt(record["rollback_strategy"]) ?? null;
  const postcondition = record["postcondition"] === null ? null : stringOpt(record["postcondition"]) ?? null;
  return {
    schema_version: "synthi.dojo.apiBackedMcpTool.v1",
    tool_name: toolName,
    tool_version: toolVersion,
    candidate_id: candidateId,
    method,
    path: apiPath,
    skill_id: skillId,
    license_id: licenseId,
    license_version: licenseVersion,
    action,
    auth_scope: authScope,
    proof_required: true,
    proof_claim_mapping: proofClaimMapping,
    query_schema: querySchema,
    idempotency_key_location: idempotency,
    rollback_strategy: rollback,
    postcondition,
    input_schema: cloneJson(inputSchema),
    schema_digest: schemaDigest,
    enforcement: {
      proof_capsule_required: true,
      license_kernel_required: true,
      evidence_write_required: true,
      postcondition_assertion_required: enforcement["postcondition_assertion_required"] === true,
      idempotency_required: enforcement["idempotency_required"] === true,
    },
  };
}

function apiBackedToolCurrentLicenseBlockedBy(tool: DojoApiBackedMcpTool, skill: DojoSkill): string[] {
  const blockedBy: string[] = [];
  if (tool.skill_id !== skill.skill_id) blockedBy.push("api_tool_skill_mismatch");
  if (tool.license_id !== skill.permission_license.license_id) blockedBy.push("api_tool_license_mismatch");
  if (tool.license_version !== skill.permission_license.license_version) blockedBy.push("api_tool_license_version_mismatch");
  const licensedAction = [
    ...skill.permission_license.allowed_actions,
    ...skill.permission_license.gated_actions,
  ].some((action) => action.action === tool.action);
  if (!licensedAction) blockedBy.push("api_tool_action_not_licensed");
  const substrateRequirement = skill.permission_license.substrate_requirements.find((requirement) =>
    requirement.action === tool.action
  );
  if (substrateRequirement && !substrateRequirement.allowed_substrates.includes("api")) {
    blockedBy.push("api_tool_substrate_not_allowed");
  }
  return blockedBy;
}

function skillWithPublishedApiBackedTool(
  skill: DojoSkill,
  tool: DojoApiBackedMcpTool,
  now: string,
  review?: DojoApiBackedToolPublicationReviewSummary
): DojoSkill {
  const updated = cloneJson(skill);
  const existingTools = updated.api_backed_mcp_tools ?? [];
  const nextTools = [
    ...existingTools.filter((candidate) =>
      candidate.tool_name !== tool.tool_name || candidate.tool_version !== tool.tool_version
    ),
    cloneJson(tool),
  ].sort((a, b) => a.tool_name.localeCompare(b.tool_name) || a.tool_version.localeCompare(b.tool_version));
  updated.api_backed_mcp_tools = nextTools;
  updated.published_tools = dedupeStrings([
    ...updated.published_tools,
    tool.tool_name,
  ]);
  updated.execution_substrates = dedupeSubstrates([
    ...updated.execution_substrates,
    "api",
  ]);
  if (tool.enforcement.postcondition_assertion_required && tool.enforcement.evidence_write_required) {
    updated.preferred_substrate = "api";
  }
  updated.skill_passport = {
    ...updated.skill_passport,
    published_tools: dedupeStrings([
      ...updated.skill_passport.published_tools,
      tool.tool_name,
    ]),
  };
  updated.assurance_case = {
    ...updated.assurance_case,
    evidence_refs: dedupeStrings([
      ...updated.assurance_case.evidence_refs,
      `api_tool:${tool.tool_name}:${tool.tool_version}`,
      `api_candidate:${tool.candidate_id}`,
      ...(review?.evidence_refs ?? []),
    ]),
  };
  updated.training_report = {
    ...updated.training_report,
    evidence_refs: dedupeStrings([
      ...updated.training_report.evidence_refs,
      ...(review?.evidence_refs ?? []),
    ]),
  };
  updated.generated_at = now;
  return updated;
}

function apiToolProofValidationForSkill(
  skill: DojoSkill,
  tool: DojoApiBackedMcpTool,
  proofCapsuleValue: unknown,
  now: string,
  proofValidation?: { ok: boolean; blocked_by: string[] }
): { ok: boolean; blocked_by: string[] } {
  const capsule = proofCapsuleOpt(proofCapsuleValue);
  if (!capsule) return { ok: false, blocked_by: ["api_tool_proof_capsule_required"] };
  const validation = proofValidation ?? validateDojoProofCapsule(skill, capsule, tool.action, { now });
  const licenseId = (capsule as DojoProofCarryingSkillCapsule & { license_id?: string }).license_id;
  const blockedBy = dedupeStrings([
    ...validation.blocked_by,
    ...(licenseId === tool.license_id ? [] : ["api_tool_proof_license_mismatch"]),
    ...(capsule.substrate_claim === "api" ? [] : ["api_tool_proof_substrate_mismatch"]),
  ]);
  return {
    ok: validation.ok && blockedBy.length === 0,
    blocked_by: blockedBy,
  };
}

type ApiToolTransportResolution =
  | {
    ok: true;
    mode: "mock" | "network";
    transport: (request: DojoApiToolHttpRequest) => Promise<DojoApiToolHttpResponse> | DojoApiToolHttpResponse;
  }
  | { ok: false; blocked_by: string[] };

function apiToolTransportForArgs(
  args: Record<string, unknown>,
  skill: DojoSkill,
  options: { dry_run: boolean; production_enforcement: boolean }
): ApiToolTransportResolution {
  const mockResponse = apiToolMockResponseOpt(args["mock_response"]);
  if (mockResponse) {
    if (options.production_enforcement && !options.dry_run) {
      return { ok: false, blocked_by: ["api_tool_mock_response_forbidden_in_production"] };
    }
    return {
      ok: true,
      mode: "mock",
      transport: () => cloneJson(mockResponse),
    };
  }
  if (!boolOpt(args["allow_network_transport"])) {
    return {
      ok: false,
      blocked_by: [
        options.production_enforcement && !options.dry_run
          ? "api_tool_network_transport_required_in_production"
          : "api_tool_mock_response_or_network_transport_required",
      ],
    };
  }
  const baseUrlRaw = stringOpt(args["api_base_url"]);
  if (!baseUrlRaw) return { ok: false, blocked_by: ["api_tool_base_url_required"] };
  let baseUrl: URL;
  let skillOrigin: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
    skillOrigin = new URL(skill.app_origin);
  } catch {
    return { ok: false, blocked_by: ["api_tool_base_url_invalid"] };
  }
  if (baseUrl.origin !== skillOrigin.origin) {
    return { ok: false, blocked_by: ["api_tool_base_url_origin_mismatch"] };
  }
  const requestHeaders = stringRecordOpt(args["request_headers"]);
  return {
    ok: true,
    mode: "network",
    transport: (request) => executeNetworkApiToolTransport(request, baseUrl, requestHeaders),
  };
}

function apiToolMockResponseOpt(value: unknown): DojoApiToolHttpResponse | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  const status = numberOpt(record["status"]);
  if (status === undefined) return undefined;
  const headers = stringRecordOpt(record["headers"]);
  return {
    status,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(record["body"] !== undefined ? { body: cloneJson(record["body"]) } : {}),
  };
}

async function executeNetworkApiToolTransport(
  request: DojoApiToolHttpRequest,
  baseUrl: URL,
  requestHeaders: Record<string, string>
): Promise<DojoApiToolHttpResponse> {
  const url = new URL(request.path, baseUrl);
  for (const [key, value] of Object.entries(request.query)) {
    url.searchParams.set(key, value);
  }
  const headers = {
    ...requestHeaders,
    ...request.headers,
  };
  const hasBody = request.body !== undefined && request.body !== null && request.method !== "GET";
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: responseHeaders,
    body: parseApiToolResponseBody(text, responseHeaders["content-type"]),
  };
}

function parseApiToolResponseBody(text: string, contentType?: string): unknown {
  if (!text) return undefined;
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

type DojoApiCandidateInputResult =
  | { ok: true; candidate: DojoApiEndpointCandidate; source: "provided_candidate" | "network_trace" }
  | { ok: false; error: string; blocked_by: string[] };

function apiEndpointCandidateFromArgs(args: Record<string, unknown>): DojoApiCandidateInputResult {
  const providedCandidateRaw = args["api_candidate"];
  if (providedCandidateRaw !== undefined) {
    const providedCandidate = apiEndpointCandidateOpt(providedCandidateRaw);
    if (!providedCandidate) {
      return { ok: false, error: "dojo_api_candidate_invalid", blocked_by: ["api_candidate_invalid"] };
    }
    return {
      ok: true,
      candidate: applyApiCandidateOverrides(providedCandidate, objectOpt(args["candidate_overrides"])),
      source: "provided_candidate",
    };
  }

  const trace = networkTraceEndpointInputOpt(args["network_trace"]);
  if (!trace) {
    return {
      ok: false,
      error: "dojo_api_candidate_or_network_trace_required",
      blocked_by: ["api_candidate_missing", "network_trace_missing"],
    };
  }
  try {
    return {
      ok: true,
      candidate: applyApiCandidateOverrides(inferDojoApiEndpointCandidateFromTrace(trace), objectOpt(args["candidate_overrides"])),
      source: "network_trace",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : "dojo_api_candidate_inference_failed",
      blocked_by: ["network_trace_invalid"],
    };
  }
}

function apiEndpointCandidateOpt(value: unknown): DojoApiEndpointCandidate | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  if (record["schema_version"] !== "synthi.dojo.apiEndpointCandidate.v1") return undefined;
  const candidateId = stringOpt(record["candidate_id"]);
  const method = apiMethodOpt(record["method"]);
  const path = stringOpt(record["path"]);
  const requestSchema = objectOpt(record["request_schema"]);
  const responseSchema = objectOpt(record["response_schema"]);
  const mutationClass = apiMutationClassOpt(record["mutation_class"]);
  const reviewStatus = apiReviewStatusOpt(record["review_status"]);
  if (!candidateId || !method || !path || !requestSchema || !responseSchema || !mutationClass || !reviewStatus) return undefined;
  const candidate: DojoApiEndpointCandidate = {
    schema_version: "synthi.dojo.apiEndpointCandidate.v1",
    candidate_id: candidateId,
    method,
    path,
    request_schema: cloneJson(requestSchema),
    response_schema: cloneJson(responseSchema),
    mutation_class: mutationClass,
    proof_claim_mapping: stringRecordOpt(record["proof_claim_mapping"]),
    review_status: reviewStatus,
    inferred_from: stringArrayOpt(record["inferred_from"]),
  };
  const querySchema = objectOpt(record["query_schema"]);
  const authScope = stringOpt(record["auth_scope"]);
  const idempotencyKeyLocation = idempotencyKeyLocationOpt(record["idempotency_key_location"]);
  const rollbackStrategy = rollbackStrategyOpt(record["rollback_strategy"]);
  const postcondition = stringOpt(record["postcondition"]);
  if (querySchema) candidate.query_schema = cloneJson(querySchema);
  if (authScope) candidate.auth_scope = authScope;
  if (idempotencyKeyLocation) candidate.idempotency_key_location = idempotencyKeyLocation;
  if (rollbackStrategy) candidate.rollback_strategy = rollbackStrategy;
  if (postcondition) candidate.postcondition = postcondition;
  return candidate;
}

function applyApiCandidateOverrides(
  candidate: DojoApiEndpointCandidate,
  overrides: Record<string, unknown> | undefined
): DojoApiEndpointCandidate {
  if (!overrides) return candidate;
  const updated = cloneJson(candidate);
  const authScope = stringOpt(overrides["auth_scope"]);
  const mutationClass = apiMutationClassOpt(overrides["mutation_class"]);
  const idempotencyKeyLocation = idempotencyKeyLocationOpt(overrides["idempotency_key_location"]);
  const rollbackStrategy = rollbackStrategyOpt(overrides["rollback_strategy"]);
  const postcondition = stringOpt(overrides["postcondition"]);
  const reviewStatus = apiReviewStatusOpt(overrides["review_status"]);
  const requestSchema = objectOpt(overrides["request_schema"]);
  const responseSchema = objectOpt(overrides["response_schema"]);
  const querySchema = objectOpt(overrides["query_schema"]);
  const proofClaimMapping = stringRecordOpt(overrides["proof_claim_mapping"]);
  const inferredFrom = stringArrayOpt(overrides["inferred_from"]);
  if (authScope) updated.auth_scope = authScope;
  if (mutationClass) updated.mutation_class = mutationClass;
  if (idempotencyKeyLocation) updated.idempotency_key_location = idempotencyKeyLocation;
  if (rollbackStrategy) updated.rollback_strategy = rollbackStrategy;
  if (postcondition) updated.postcondition = postcondition;
  if (reviewStatus) updated.review_status = reviewStatus;
  if (requestSchema) updated.request_schema = cloneJson(requestSchema);
  if (responseSchema) updated.response_schema = cloneJson(responseSchema);
  if (querySchema) updated.query_schema = cloneJson(querySchema);
  if (Object.keys(proofClaimMapping).length > 0) updated.proof_claim_mapping = proofClaimMapping;
  if (inferredFrom.length > 0) updated.inferred_from = inferredFrom;
  return updated;
}

function networkTraceEndpointInputOpt(value: unknown): DojoNetworkTraceEndpointInput | undefined {
  const record = objectOpt(value);
  if (!record) return undefined;
  const method = stringOpt(record["method"]);
  const url = stringOpt(record["url"]);
  if (!method || !url) return undefined;
  return {
    method,
    url,
    ...(Object.prototype.hasOwnProperty.call(record, "request_body") ? { request_body: record["request_body"] } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "response_body") ? { response_body: record["response_body"] } : {}),
    ...(numberOpt(record["status"]) !== undefined ? { status: numberOpt(record["status"]) } : {}),
    ...(stringOpt(record["source_ref"]) ? { source_ref: stringOpt(record["source_ref"]) } : {}),
  };
}

function apiMethodOpt(value: unknown): DojoApiMethod | undefined {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE"
    ? value
    : undefined;
}

function apiMutationClassOpt(value: unknown): DojoApiMutationClass | undefined {
  return value === "read" || value === "create" || value === "update" || value === "delete" || value === "side_effect"
    ? value
    : undefined;
}

function apiReviewStatusOpt(value: unknown): DojoApiReviewStatus | undefined {
  return value === "candidate" || value === "approved" || value === "rejected" ? value : undefined;
}

function idempotencyKeyLocationOpt(value: unknown): DojoApiEndpointCandidate["idempotency_key_location"] | undefined {
  return value === "header" || value === "body" || value === "query" ? value : undefined;
}

function rollbackStrategyOpt(value: unknown): DojoApiEndpointCandidate["rollback_strategy"] | undefined {
  return value === "none" || value === "compensating_call" || value === "delete_draft" || value === "human_review"
    ? value
    : undefined;
}

function stringRecordOpt(value: unknown): Record<string, string> {
  const record = objectOpt(value);
  if (!record) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested === "string" && nested.trim().length > 0) {
      entries.push([key, nested.trim()]);
    }
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries);
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 1;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] ?? 0 : 0;
  return `${major}.${minor}.${patch + 1}`;
}

function skillWithLicenseVersion(skill: DojoSkill, licenseVersion: string): DojoSkill {
  const updated = cloneJson(skill);
  updated.permission_license = {
    ...updated.permission_license,
    license_version: licenseVersion,
  };
  return updated;
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

function optionalBoolOpt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
