export const DOJO_IMPLEMENTATION_STATUS_VALUES = [
  "executable",
  "deterministic_projection",
  "report_only",
  "planned",
] as const;

export type DojoImplementationStatus = (typeof DOJO_IMPLEMENTATION_STATUS_VALUES)[number];

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
  synthi_dojo_get_skill_passport: report("Returns a compact skill passport assembled from the current license and artifacts."),
  synthi_dojo_get_skill_genome: report("Returns a redacted, shareable skill pattern artifact."),
  synthi_dojo_get_antibodies: graphProjection("Returns antibodies generated from current checkride failures and guardrails; approved case law can bind guardrail predicates at runtime."),
  synthi_dojo_get_agent_ready_ui_contract: sourceProjection("Returns a generated Agent-Ready UI Contract report backed by schema/lint validation; project CI adoption remains deployment-specific."),
  synthi_dojo_get_cost_policy: report("Returns a generated cost policy report for scenario budgets and stop conditions."),
  synthi_dojo_get_universe_dossier: report("Returns a dossier assembled from lifecycle, governance, metrics, evidence, and source reports."),
  synthi_dojo_get_lifecycle: report("Returns lifecycle state projected from the current skill and proof records."),
  synthi_dojo_get_governance_report: governanceReport("Returns governance, approval, license-health, recertification, audit-export, and compliance view data."),
  synthi_dojo_get_metrics: report("Returns generated registry and skill metrics from current in-process state."),
  synthi_dojo_get_source_affordance_pr_plan: sourceProjection("Returns a typed generated source-affordance PR plan; the codemod harness can patch controlled React fixtures and prove generated tests."),
  synthi_dojo_get_registry: governanceReport("Returns organization registry report data with governance-service view models."),
  synthi_dojo_get_skill_assurance_case: report("Returns an assurance case artifact assembled from current reports."),
  synthi_dojo_get_entrustment_level: syntheticProjection("Returns entrustment and readiness calculated from current checkride and runtime evidence artifacts."),
  synthi_dojo_get_license: executable("Returns the currently stored permission license for a skill."),
  synthi_dojo_get_guardrails: graphProjection("Returns guardrails generated from current case-law/checkride artifacts; approved runtime guardrail predicates are supported."),
  synthi_dojo_get_case_law: governanceReport("Returns generated or recorded case law with lifecycle state for review and binding guardrail use."),
  synthi_dojo_explain_block: reportWithRuntimeEvidence("Returns an explanatory refusal summary from current license, proof, guardrail, and case-law data."),
  synthi_dojo_explain_failure: report("Returns a failure explanation from generated scenario/checkride findings."),
  synthi_dojo_debug_counterfactual: deterministic("Returns a generated counterfactual debug report; it is not an executable replay."),
  synthi_dojo_run_time_machine_debugger: deterministic("Runs the current deterministic time-machine report builder."),
  synthi_dojo_run_ghost_mode: reportWithRuntimeEvidence("Returns non-mutating Ghost Mode comparison data with structured shadow evidence and entrustment impact."),
  synthi_dojo_request_permission_upgrade: controlPlaneWrite(
    "Records a permission-upgrade request in the configured Dojo store and exposes it through the governance approval queue.",
    ["license_promotion_still_requires_checkride_and_evidence_policy"]
  ),
  synthi_dojo_review_permission_upgrade: controlPlaneWrite(
    "Records approval or denial review state for a stored permission-upgrade request without promoting the production license by itself.",
    ["license_promotion_still_requires_checkride_and_evidence_policy"]
  ),
  synthi_dojo_generate_vivarium_scenarios: deterministic("Generates scenario catalog data from a Skill Seed."),
  synthi_dojo_run_vivarium_scenario: syntheticRuntime("Materializes a synthetic fixture, runs the Skill Graph in checkride mode, and evaluates the oracle from observed evidence."),
  synthi_dojo_run_wind_tunnel: syntheticRuntime("Runs a budgeted set of materialized Vivarium scenarios through the graph runtime and oracle evaluator."),
  synthi_dojo_run_checkride: syntheticRuntime("Runs compatibility checkride scoring and an executable graph/Vivarium/oracle checkride with scenario evidence records."),
  synthi_dojo_publish_skill: executable("Builds, stores, and publishes a Dojo skill and backing private tool manifest."),
  synthi_dojo_recertify_skill: deterministic("Rebuilds skill artifacts using the current deterministic checkride and report builders."),
  synthi_dojo_get_license_health: executable("Computes license health from current license and proof registry state."),
  synthi_dojo_revoke_license: executable("Mutates the stored license into a revoked/blocked state."),
  synthi_dojo_record_case_law: executable("Records a binding case-law entry and guardrail into the current skill store."),
  synthi_dojo_export_artifacts: executable("Exports repo artifacts from the current stored skill."),
  synthi_dojo_issue_proof_capsule: proofExecutable("Issues and stores a proof capsule using current context and evidence-claim checks; Ed25519 local and external command signing are supported when configured."),
  synthi_dojo_validate_proof_capsule: executable("Validates proof capsule signature, registry status, action scope, expiry, and replay state."),
  synthi_dojo_revoke_proof_capsule: executable("Revokes a stored proof capsule record."),
  synthi_dojo_run_with_proof_capsule: executable("Runs the proof-gated Dojo dispatch path and blocks replay through current proof records."),
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
  proof_capsule: proofExecutable("Proof capsules support evidence claim verification, replay checks, Ed25519 local or external command signing when configured, and public verification."),
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
    evidence_backing: "generated_report",
    simulation_backing: "scenario_catalog",
    summary,
    maturity_blockers: [
      "no_executable_graph_runtime",
      "no_materialized_synthetic_fixture",
      "no_authoritative_evidence_ledger",
    ],
  };
}

function syntheticRuntime(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: true,
    evidence_backing: "runtime_validation",
    simulation_backing: "materialized_synthetic_fixture",
    summary,
    maturity_blockers: [
      "not_yet_proven_in_deployed_non_loopback_host",
      "chaos_soak_performance_gates_not_complete",
    ],
  };
}

function graphProjection(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "deterministic_projection",
    runtime_enforced: false,
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
    evidence_backing: "repo_local_artifact",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "reviewed_source_pr_workflow_not_connected_to_hosted_repo",
      "broad_arbitrary_app_codemods_not_complete",
    ],
  };
}

function governanceReport(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
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
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "read_only_report_surface",
      "release_gate_visual_and_hosted_proof_required",
    ],
  };
}

function controlPlaneWrite(summary: string, maturityBlockers: string[] = []): DojoImplementationMetadata {
  return {
    implementation_status: "executable",
    runtime_enforced: false,
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
    evidence_backing: "runtime_validation",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "managed_kms_hsm_provider_not_configured_by_default",
      "not_yet_proven_in_deployed_non_loopback_host",
    ],
  };
}

function ledgerReport(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    evidence_backing: "durable_evidence_ledger",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "retention_and_legal_hold_operations_are_limited",
      "external_storage_custody_not_proven_in_release_gate",
    ],
  };
}

function report(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "report_only",
    runtime_enforced: false,
    evidence_backing: "generated_report",
    simulation_backing: "none",
    summary,
    maturity_blockers: [
      "no_durable_control_plane",
      "no_authoritative_evidence_ledger",
    ],
  };
}

function planned(summary: string): DojoImplementationMetadata {
  return {
    implementation_status: "planned",
    runtime_enforced: false,
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
