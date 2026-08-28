export const DOJO_IMPLEMENTATION_STATUS_VALUES = [
  "executable",
  "deterministic_projection",
  "report_only",
  "planned",
] as const;

export type DojoImplementationStatus = (typeof DOJO_IMPLEMENTATION_STATUS_VALUES)[number];

export const DOJO_RUNTIME_SCOPE_VALUES = [
  "none",
  "read_only_projection",
  "report_only",
  "registry_operation",
  "control_plane_write",
  "proof_validation",
  "proof_gated_dispatch",
  "hosted_runtime_gateway",
  "synthetic_fixture_runtime",
  "non_mutating_shadow",
] as const;

export type DojoRuntimeScope = (typeof DOJO_RUNTIME_SCOPE_VALUES)[number];

export type DojoEvidenceBacking =
  | "none"
  | "caller_context"
  | "generated_report"
  | "repo_local_artifact"
  | "runtime_validation"
  | "durable_evidence_ledger";

export type DojoSimulationBacking =
  | "none"
  | "scenario_catalog"
  | "heuristic_checkride"
  | "metadata_organoid"
  | "precomputed_vivarium_wrapper"
  | "materialized_synthetic_fixture";

export interface DojoImplementationMetadata {
  implementation_status: DojoImplementationStatus;
  runtime_enforced: boolean;
  runtime_scope: DojoRuntimeScope;
  production_runtime: boolean;
  evidence_backing: DojoEvidenceBacking;
  simulation_backing: DojoSimulationBacking;
  summary: string;
  maturity_blockers: string[];
}

export const DOJO_TOOL_IMPLEMENTATION_STATUS: Record<string, DojoImplementationMetadata> = {
  synthi_dojo_list_competencies: executable("Queries the current Dojo skill registry and returns published competencies."),
  synthi_dojo_get_skill: deterministic("Returns a built Dojo skill artifact derived from the workflow contract."),
  synthi_dojo_get_skill_cortex: graphProjection("Returns the executable Skill Cortex graph IR; execution occurs through graph runtime, Vivarium, checkride, or proof-gated run paths."),
  synthi_dojo_get_workspace_organoid: syntheticProjection("Returns a Workspace Organoid manifest; materialized synthetic fixtures are produced by Vivarium run surfaces."),
  synthi_dojo_get_wind_tunnel_report: syntheticProjection("Returns Wind Tunnel report data derived from generated and runtime-capable scenario definitions."),
  synthi_dojo_get_counterfactual_twin: deterministic("Returns generated counterfactual variants from scenario metadata."),
  synthi_dojo_get_evil_twin_report: syntheticProjection("Returns adversarial report data; the runtime Evil Twin runner executes targeted Vivarium attacks in integration paths."),
  synthi_dojo_get_training_report: report("Returns a training report assembled from current Dojo artifacts."),
  synthi_dojo_get_skill_passport: reportWithRuntimeEvidence("Returns a compact skill passport with license scope and executable checkride provenance when the skill was published or recertified through the runtime path."),
  synthi_dojo_get_skill_genome: report("Returns a redacted, shareable skill pattern artifact."),
  synthi_dojo_get_antibodies: graphProjection("Returns antibodies generated from current checkride failures and guardrails; approved case law can bind guardrail predicates at runtime."),
  synthi_dojo_get_agent_ready_ui_contract: sourceProjection("Returns a generated Agent-Ready UI Contract report backed by schema/lint validation; project CI adoption remains deployment-specific."),
  synthi_dojo_get_cost_policy: report("Returns a generated cost policy report for scenario budgets and stop conditions."),
  synthi_dojo_get_universe_dossier: report("Returns a dossier assembled from lifecycle, governance, metrics, evidence, and source reports."),
  synthi_dojo_get_lifecycle: report("Returns lifecycle state projected from the current skill and proof records."),
  synthi_dojo_get_governance_report: governanceReport("Returns governance, approval, license-health, recertification, audit-export, and compliance view data."),
  synthi_dojo_get_metrics: report("Returns registry and skill metrics from the authorized visible skill set, using the configured durable control-plane store when production aggregate reads are enabled."),
  synthi_dojo_capture_source_snapshot: sourceGeneration("Creates and verifies a signed release-scoped source snapshot from caller-supplied source tokens; persistence and drift application remain explicit follow-up operations."),
  synthi_dojo_detect_source_drift: sourceGeneration("Verifies signed source snapshots and reports drifted tokens, affected graph nodes, and license expiry triggers without applying them."),
  synthi_dojo_apply_source_drift_expiry: controlPlaneWrite(
    "Dry-runs or applies source-drift license expiry triggers against the tenant-scoped Dojo license store and returns an explicit recertification handoff to synthi_dojo_recertify_skill before any relicense; production writes require the durable control plane."
  ),
  synthi_dojo_get_source_affordance_pr_plan: sourceProjection("Returns a typed generated source-affordance PR plan; the codemod harness can patch controlled React fixtures and prove generated tests."),
  synthi_dojo_prepare_source_affordance_pr: sourceGeneration("Builds a generated source patch bundle, PR metadata, branch plan, and dry-run apply proof from supplied source files."),
  synthi_dojo_create_source_affordance_pr_branch: sourceGeneration("Validates and optionally creates a local git branch for a generated source-affordance PR; dry-run is the default and remote PR creation remains external."),
  synthi_dojo_prepare_api_backed_tool: apiGeneration("Reviews an API endpoint candidate or network trace, compiles a proof-gated API-backed MCP tool contract, requires reviewer evidence before skill-bus publication, and leaves unpublished compiled tools unavailable for production execution."),
  synthi_dojo_run_api_backed_tool: proofGatedDispatch("Dry-runs or executes a compiled API-backed MCP tool or a published API-backed skill-bus tool name through skill-bus resolution and non-dry dispatch, proof validation, license pinning, idempotency, postcondition checks, and evidence output."),
  synthi_dojo_get_registry: governanceReport("Returns organization registry report data with governance-service view models."),
  synthi_dojo_get_skill_assurance_case: reportWithRuntimeEvidence("Returns an assurance case artifact with executable checkride provenance when the skill was published or recertified through the runtime path."),
  synthi_dojo_get_entrustment_level: reportWithRuntimeEvidence("Returns stored entrustment and readiness with executable checkride provenance when the skill was published or recertified through the runtime path."),
  synthi_dojo_get_license: executable("Returns the currently stored permission license for a skill."),
  synthi_dojo_get_guardrails: graphProjection("Returns guardrails generated from current case-law/checkride artifacts; approved runtime guardrail predicates are supported."),
  synthi_dojo_get_case_law: governanceReport("Returns generated or recorded case law with lifecycle state for review and binding guardrail use."),
  synthi_dojo_explain_block: reportWithRuntimeEvidence("Returns an explanatory refusal summary from current license, proof, guardrail, and case-law data."),
  synthi_dojo_explain_failure: syntheticRuntime("Runs the selected Vivarium scenario and explains the failure from observed graph/oracle evidence."),
  synthi_dojo_debug_counterfactual: syntheticRuntime("Runs selected counterfactual debug branches through materialized Vivarium fixtures and graph/oracle evidence."),
  synthi_dojo_run_time_machine_debugger: syntheticRuntime("Runs causal Time Machine debugging with a materialized Vivarium branch, graph runtime execution, and oracle-backed runtime evidence."),
  synthi_dojo_run_ghost_mode: ghostRuntime("Records non-mutating Ghost Mode shadow evidence with human-vs-agent action comparison and entrustment impact."),
  synthi_dojo_request_permission_upgrade: controlPlaneWrite(
    "Records a permission-upgrade request in the configured Dojo store, derives required promotion steps, and exposes it through the governance approval queue."
  ),
  synthi_dojo_review_permission_upgrade: controlPlaneWrite(
    "Records approval or denial review state for a stored permission-upgrade request and applies approved requests only when the derived promotion evidence policy is satisfied."
  ),
  synthi_dojo_review_case_law: controlPlaneWrite(
    "Records approval or deprecation review state for a stored case-law record, writes durable Postgres audit events when the control plane is configured, and exposes the result through governance views."
  ),
  synthi_dojo_run_scheduled_governance_jobs: controlPlaneWrite(
    "Runs ready governance scheduled jobs through typed handlers, applies only supported durable state transitions, and persists tenant-scoped audit events for non-dry runs."
  ),
  synthi_dojo_generate_vivarium_scenarios: deterministic("Generates scenario catalog data from a Skill Seed."),
  synthi_dojo_run_vivarium_scenario: syntheticRuntime("Materializes a synthetic fixture, runs the Skill Graph in checkride mode, and evaluates the oracle from observed evidence."),
  synthi_dojo_run_wind_tunnel: syntheticRuntime("Runs a budgeted set of materialized Vivarium scenarios through the graph runtime and oracle evaluator."),
  synthi_dojo_run_evil_twin: syntheticRuntime("Runs targeted Evil Twin attacks through materialized Vivarium fixtures, graph runtime execution, and oracle-derived attack classification."),
  synthi_dojo_run_checkride: syntheticRuntime("Runs compatibility checkride scoring and an executable graph/Vivarium/oracle checkride with scenario evidence records."),
  synthi_dojo_publish_skill: executable("Builds, stores, and publishes a Dojo skill and backing private tool manifest."),
  synthi_dojo_recertify_skill: syntheticRuntime("Re-runs executable graph/Vivarium/oracle checkride, derives renewed entrustment/SRL/license constraints, and records audited recertification evidence."),
  synthi_dojo_get_license_health: executable("Computes license health from current license and proof registry state."),
  synthi_dojo_revoke_license: executable("Mutates the stored license into a revoked/blocked state."),
  synthi_dojo_record_case_law: executable("Records a binding case-law entry and guardrail into the current skill store."),
  synthi_dojo_export_artifacts: executable("Exports repo artifacts from the current stored skill."),
  synthi_dojo_export_compliance_pack: executable("Exports a compliance evidence pack manifest and selected redacted Dojo artifacts from the current stored skills."),
  synthi_dojo_issue_proof_capsule: proofExecutable("Issues and stores a proof capsule using current context and evidence-claim checks; Ed25519 local, external command, and managed-key-service signing are supported when configured."),
  synthi_dojo_validate_proof_capsule: executable("Validates proof capsule signature, registry status, action scope, expiry, and replay state."),
  synthi_dojo_revoke_proof_capsule: executable("Revokes a stored proof capsule record."),
  synthi_dojo_create_hosted_runtime_session: hostedRuntimeGateway("Creates a tenant-scoped hosted runtime session with short-lived credentials and configurable Postgres-backed session custody for production proof-gated Dojo execution."),
  synthi_dojo_run_with_proof_capsule: proofGatedDispatch("Runs the proof-gated Dojo dispatch path, blocks replay through current proof records, and requires hosted runtime session authorization before production proof consumption."),
  synthi_dojo_therapeutic_init_trace: proofGatedDispatch("Initializes a stateful therapeutic tomography trace/runtime store for arbitrary task classes while preserving the ML quality-drop golden fixture."),
  synthi_dojo_therapeutic_run_probe: proofGatedDispatch("Executes contract-bound therapeutic probe adapters, enforces output schemas and forbidden-output gates, and records probe evidence/audit entries."),
  synthi_dojo_therapeutic_request_access: proofGatedDispatch("Routes non-demo access requests through the therapeutic Authority Broker, strict proof capsule builder, temporary grant minting, and evidence/audit recording."),
  synthi_dojo_therapeutic_dispatch_protected_tool: proofGatedDispatch("Blocks protected tool/data-class dispatch unless an active scoped therapeutic grant exists, recording bypass attempts as audit/evidence."),
  synthi_dojo_therapeutic_revoke_grants: proofGatedDispatch("Revokes therapeutic temporary grants on task end or explicit request and records revocation success/failure."),
  synthi_dojo_therapeutic_run_checkrides: proofGatedDispatch("Runs therapeutic Dojo/Vivarium checkrides and records policy-delta/case-law hypotheses without auto-granting broader future access."),
  synthi_dojo_therapeutic_learn_policy: proofGatedDispatch("Derives conservative therapeutic policy-learning records from traces/checkrides while preserving the no-auto-broader-access boundary."),
  synthi_dojo_therapeutic_review_access: proofGatedDispatch("Resolves pending Tier 2/Tier 3 therapeutic reviews, adding human judgment claims before broker enforcement can mint scoped grants."),
  synthi_dojo_therapeutic_record_diagnosis: proofGatedDispatch("Records a verified therapeutic diagnosis from probe/proof evidence while preserving the no-mutation diagnostic boundary."),
  synthi_dojo_therapeutic_propose_remediation: proofGatedDispatch("Runs the separate therapeutic remediation proposal gate for scoped write access with diagnosis proof, rollback, postconditions, human approval, and revocation-ready grants."),
  synthi_dojo_therapeutic_verify_remediation: proofGatedDispatch("Records remediation postcondition verification evidence before final revocation/learning and blocks failed remediation traces."),
  synthi_dojo_therapeutic_get_runtime: proofGatedDispatch("Returns reconstructable therapeutic trace, grant, proof-status, audit, and evidence state for operational review."),
};

export const DOJO_REPORT_IMPLEMENTATION_STATUS: Record<string, DojoImplementationMetadata> = {
  skill_seed: deterministic("Skill Seed extraction is deterministic from the workflow contract and trace metadata."),
  skill_cortex: graphProjection("Skill Cortex has a stable executable graph IR and runtime; this report surface returns the graph artifact."),
  workspace_organoid: syntheticProjection("Workspace Organoid report is a manifest; Vivarium run surfaces materialize deterministic synthetic fixtures."),
  vivarium_scenarios: deterministic("Vivarium scenarios are generated catalog entries."),
  vivarium_run: syntheticRuntime("Vivarium scenario runs materialize synthetic fixtures and evaluate graph outcomes with an oracle."),
  wind_tunnel: syntheticRuntime("Wind Tunnel executes materialized scenario runs through the current graph runtime and oracle evaluator."),
  checkride: syntheticRuntime("Checkride run surfaces can execute graph runs against materialized Vivarium fixtures and score oracle-backed scenario evidence."),
  case_law: governanceReport("Case law can be generated, recorded, approved/deprecated, and bound into runtime guardrail predicates."),
  guardrails: graphProjection("Guardrails include generated and case-law-bound predicates executable by the graph guardrail runtime."),
  permission_license: executable("Permission license is stored and checked by the current proof-gated path."),
  proof_capsule: proofExecutable("Proof capsules support evidence claim verification, replay checks, Ed25519 local, external command, or managed-key-service signing when configured, and public verification."),
  evidence_ledger: ledgerReport("Evidence ledger report surfaces are projections; the Postgres ledger store has append-only hash-chain semantics for runtime evidence records."),
  source_affordance_pr_plan: sourceProjection("Source-affordance plans are typed and can drive the controlled React codemod plus generated contract tests."),
  mcp_manifest: executable("Published private tool manifest exists and direct private tool calls are proof-gated."),
  universe_dossier: report("Universe dossier aggregates current reports and deterministic projections."),
};

export function getDojoToolImplementationMetadata(toolName: string): DojoImplementationMetadata {
  return DOJO_TOOL_IMPLEMENTATION_STATUS[toolName] ?? planned(`No implementation-status entry is registered for ${toolName}.`);
}

export function getDojoReportImplementationMetadata(reportName: string): DojoImplementationMetadata {
  return DOJO_REPORT_IMPLEMENTATION_STATUS[reportName] ?? planned(`No implementation-status entry is registered for ${reportName}.`);
}

export function buildDojoImplementationMetadata(toolName: string): DojoImplementationMetadata {
  return cloneMetadata(getDojoToolImplementationMetadata(toolName));
}

function executable(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "registry_operation",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [],
  };
}

function deterministic(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "deterministic_projection",
    runtime_enforced: false,
    runtime_scope: "read_only_projection",
    production_runtime: false,
    evidence_backing: "generated_report",
    simulation_backing: "scenario_catalog",
    summary,
    maturity_blockers: [
      "read_only_projection_surface",
      "runtime_execution_available_through_specific_run_surfaces",
      "deployed_release_evidence_required",
    ],
  };
}

function syntheticRuntime(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "synthetic_fixture_runtime",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "materialized_synthetic_fixture",
    summary,
    maturity_blockers: [
      "fixture_runtime_not_production_execution",
      "not_yet_proven_in_deployed_non_loopback_host",
      "chaos_soak_performance_gates_not_complete",
    ],
  };
}

function graphProjection(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "deterministic_projection",
    runtime_enforced: false,
    runtime_scope: "read_only_projection",
    production_runtime: false,
    evidence_backing: "generated_report",
    simulation_backing: "scenario_catalog",
    summary,
    maturity_blockers: [
      "read_only_report_surface",
      "release_gate_visual_and_hosted_proof_required",
    ],
  };
}

function syntheticProjection(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "deterministic_projection",
    runtime_enforced: false,
    runtime_scope: "read_only_projection",
    production_runtime: false,
    evidence_backing: "generated_report",
    simulation_backing: "materialized_synthetic_fixture",
    summary,
    maturity_blockers: [
      "read_only_report_surface",
      "not_yet_proven_in_deployed_non_loopback_host",
    ],
  };
}

function sourceProjection(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "deterministic_projection",
    runtime_enforced: false,
    runtime_scope: "read_only_projection",
    production_runtime: false,
    evidence_backing: "repo_local_artifact",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "reviewed_source_pr_workflow_not_connected_to_hosted_repo",
      "broad_arbitrary_app_codemods_not_complete",
    ],
  };
}

function sourceGeneration(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: false,
    runtime_scope: "registry_operation",
    production_runtime: false,
    evidence_backing: "repo_local_artifact",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "reviewed_source_pr_workflow_not_connected_to_hosted_repo",
      "broad_arbitrary_app_codemods_not_complete",
      "code_owner_approval_required_before_source_api_promotion",
    ],
  };
}

function apiGeneration(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: false,
    runtime_scope: "registry_operation",
    production_runtime: false,
    evidence_backing: "repo_local_artifact",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "deployed_mcp_host_conformance_required",
    ],
  };
}

function governanceReport(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    runtime_scope: "report_only",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "operator_workflows_are_read_only_or_partial",
      "external_enterprise_control_plane_not_deployed",
    ],
  };
}

function reportWithRuntimeEvidence(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    runtime_scope: "report_only",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "read_only_report_surface",
      "release_gate_visual_and_hosted_proof_required",
    ],
  };
}

function ghostRuntime(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "non_mutating_shadow",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "non_mutating_shadow_does_not_execute_production_actions",
      "shadow_evidence_store_requires_postgres_control_plane_for_production_custody",
      "release_gate_visual_and_hosted_proof_required",
    ],
  };
}

function controlPlaneWrite(summary: string, maturityBlockers: string[] = []): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: false,
    runtime_scope: "control_plane_write",
    production_runtime: false,
    evidence_backing: "caller_context",
    simulation_backing: "none",
    summary,
    maturity_blockers: maturityBlockers,
  };
}

function proofExecutable(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "proof_validation",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "managed_kms_hsm_provider_not_configured_by_default",
      "not_yet_proven_in_deployed_non_loopback_host",
    ],
  };
}

function proofGatedDispatch(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "proof_gated_dispatch",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "deployed_hosted_runtime_gateway_required_for_production_release",
      "deployed_mcp_host_conformance_required",
      "not_yet_proven_in_deployed_non_loopback_host",
    ],
  };
}

function hostedRuntimeGateway(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    runtime_scope: "hosted_runtime_gateway",
    production_runtime: false,
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "deployed_mcp_host_conformance_required",
      "not_yet_proven_in_deployed_non_loopback_host",
    ],
  };
}

function ledgerReport(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    runtime_scope: "report_only",
    production_runtime: false,
    evidence_backing: "durable_evidence_ledger",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "external_storage_provider_not_configured_for_deployed_release",
    ],
  };
}

function report(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    runtime_scope: "report_only",
    production_runtime: false,
    evidence_backing: "generated_report",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "read_only_report_surface",
      "external_enterprise_control_plane_not_deployed",
      "release_gate_visual_and_hosted_proof_required",
    ],
  };
}

function planned(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "planned",
    runtime_enforced: false,
    runtime_scope: "none",
    production_runtime: false,
    evidence_backing: "none",
    simulation_backing: "none",
    summary,
    maturity_blockers: ["not_implemented"],
  };
}

function cloneMetadata(metadata: DojoImplementationMetadata): DojoImplementationMetadata {
  return {
    ...metadata,
    maturity_blockers: [...metadata.maturity_blockers],
  };
}
