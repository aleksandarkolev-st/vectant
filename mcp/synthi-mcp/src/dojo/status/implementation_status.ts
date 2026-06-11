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
  synthi_dojo_get_skill_cortex: deterministic("Returns graph-shaped Skill Cortex data; graph nodes are not yet executed by an interpreter."),
  synthi_dojo_get_workspace_organoid: deterministic("Returns a Workspace Organoid manifest; no disposable synthetic workplace is materialized yet."),
  synthi_dojo_get_wind_tunnel_report: deterministic("Returns deterministic Wind Tunnel report data from generated scenario summaries."),
  synthi_dojo_get_counterfactual_twin: deterministic("Returns generated counterfactual variants from scenario metadata."),
  synthi_dojo_get_evil_twin_report: deterministic("Returns adversarial report data from generated attack scenarios, not active attacks."),
  synthi_dojo_get_training_report: report("Returns a training report assembled from current Dojo artifacts."),
  synthi_dojo_get_skill_passport: report("Returns a compact skill passport assembled from the current license and artifacts."),
  synthi_dojo_get_skill_genome: report("Returns a redacted, shareable skill pattern artifact."),
  synthi_dojo_get_antibodies: deterministic("Returns antibodies generated from current checkride failures and guardrails."),
  synthi_dojo_get_agent_ready_ui_contract: deterministic("Returns a generated Agent-Ready UI Contract report; CI enforcement is not implemented yet."),
  synthi_dojo_get_cost_policy: report("Returns a generated cost policy report for scenario budgets and stop conditions."),
  synthi_dojo_get_universe_dossier: report("Returns a dossier assembled from lifecycle, governance, metrics, evidence, and source reports."),
  synthi_dojo_get_lifecycle: report("Returns lifecycle state projected from the current skill and proof records."),
  synthi_dojo_get_governance_report: report("Returns generated governance and approval report data; no enterprise workflow exists yet."),
  synthi_dojo_get_metrics: report("Returns generated registry and skill metrics from current in-process state."),
  synthi_dojo_get_source_affordance_pr_plan: deterministic("Returns a generated source-affordance PR plan; it does not patch source files yet."),
  synthi_dojo_get_registry: report("Returns organization registry report data from current Dojo registry state."),
  synthi_dojo_get_skill_assurance_case: report("Returns an assurance case artifact assembled from current reports."),
  synthi_dojo_get_entrustment_level: deterministic("Returns entrustment and readiness calculated by current checkride heuristics."),
  synthi_dojo_get_license: executable("Returns the currently stored permission license for a skill."),
  synthi_dojo_get_guardrails: deterministic("Returns guardrails generated from current case-law/checkride artifacts."),
  synthi_dojo_get_case_law: deterministic("Returns generated or recorded case law; review workflow is not mature yet."),
  synthi_dojo_explain_block: report("Returns an explanatory refusal summary from current license and guardrail data."),
  synthi_dojo_explain_failure: report("Returns a failure explanation from generated scenario/checkride findings."),
  synthi_dojo_debug_counterfactual: deterministic("Returns a generated counterfactual debug report; it is not an executable replay."),
  synthi_dojo_run_time_machine_debugger: deterministic("Runs the current deterministic time-machine report builder."),
  synthi_dojo_run_ghost_mode: report("Returns Ghost Mode comparison data; production shadow execution is not implemented yet."),
  synthi_dojo_request_permission_upgrade: report("Returns a permission-upgrade request artifact; approval workflow is not durable yet."),
  synthi_dojo_generate_vivarium_scenarios: deterministic("Generates scenario catalog data from a Skill Seed."),
  synthi_dojo_run_vivarium_scenario: deterministic("Runs the current Vivarium wrapper over precomputed scenario/checkride data."),
  synthi_dojo_run_wind_tunnel: deterministic("Runs the current Wind Tunnel wrapper over deterministic scenario data."),
  synthi_dojo_run_checkride: deterministic("Runs the current heuristic checkride evaluator."),
  synthi_dojo_publish_skill: executable("Builds, stores, and publishes a Dojo skill and backing private tool manifest."),
  synthi_dojo_recertify_skill: deterministic("Rebuilds skill artifacts using the current deterministic checkride and report builders."),
  synthi_dojo_get_license_health: executable("Computes license health from current license and proof registry state."),
  synthi_dojo_revoke_license: executable("Mutates the stored license into a revoked/blocked state."),
  synthi_dojo_record_case_law: executable("Records a binding case-law entry and guardrail into the current skill store."),
  synthi_dojo_export_artifacts: executable("Exports repo artifacts from the current stored skill."),
  synthi_dojo_issue_proof_capsule: executable("Issues and stores an HMAC proof capsule using current context/evidence claim checks."),
  synthi_dojo_validate_proof_capsule: executable("Validates proof capsule signature, registry status, action scope, expiry, and replay state."),
  synthi_dojo_revoke_proof_capsule: executable("Revokes a stored proof capsule record."),
  synthi_dojo_run_with_proof_capsule: executable("Runs the proof-gated Dojo dispatch path and blocks replay through current proof records."),
};

export const DOJO_REPORT_IMPLEMENTATION_STATUS: Record<string, DojoImplementationMetadata> = {
  skill_seed: deterministic("Skill Seed extraction is deterministic from the workflow contract and trace metadata."),
  skill_cortex: deterministic("Skill Cortex is graph-shaped data; executable graph runtime remains planned."),
  workspace_organoid: deterministic("Workspace Organoid is a manifest; disposable synthetic infrastructure remains planned."),
  vivarium_scenarios: deterministic("Vivarium scenarios are generated catalog entries."),
  vivarium_run: deterministic("Vivarium run wrapper selects current generated results; materialized fixtures remain planned."),
  wind_tunnel: deterministic("Wind Tunnel currently summarizes deterministic scenario results."),
  checkride: deterministic("Checkride is currently heuristic and not evidence-backed by materialized fixtures."),
  case_law: deterministic("Case law can be generated or recorded but lacks mature review and propagation workflow."),
  guardrails: deterministic("Guardrails are generated data and are not yet graph-runtime predicates."),
  permission_license: executable("Permission license is stored and checked by the current proof-gated path."),
  proof_capsule: executable("Proof capsules are issued and validated, but production-grade signing and evidence backing remain planned."),
  evidence_ledger: report("Evidence ledger is a report-style hash chain, not an authoritative append-only ledger."),
  source_affordance_pr_plan: report("Source-affordance PR plan is report-only and does not patch source yet."),
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
