#!/usr/bin/env node
/*
 * Emit a machine-readable Dojo release gate manifest.
 *
 * The implementation plan defines test tiers T0-T8. This script turns those
 * tiers into a stable artifact that CI, milestone branches, and release
 * candidates can inspect without parsing prose.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
  DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} from "./dojo-compliance-export-self-check.mjs";
import {
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
} from "./dojo-chaos-performance-self-check.mjs";
import {
  DOJO_DOCKER_HEALTHY_SERVICES,
  DOJO_DOCKER_REQUIRED_ENDPOINTS,
  DOJO_DOCKER_REQUIRED_SERVICES,
} from "./dojo-docker-integration-self-check.mjs";
import {
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "./dojo-postgres-control-plane-self-check.mjs";
import {
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
  DOJO_PRIVACY_REDACTION_TEST_FILES,
} from "./dojo-privacy-redaction-self-check.mjs";
import {
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "./dojo-security-abuse-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_RELEASE_GATE_TIERS = [
  {
    id: "T0",
    name: "Static / Typecheck",
    runs_on: "every PR",
    required_for: "every merge",
    purpose: "TypeScript, lint, schema compile, and import boundary checks.",
  },
  {
    id: "T1",
    name: "Unit",
    runs_on: "every PR",
    required_for: "every merge",
    purpose: "Pure functions, policy decisions, stores with fakes, and schema validators.",
  },
  {
    id: "T2",
    name: "Focused Integration",
    runs_on: "every PR touching runtime or store code",
    required_for: "milestone merge",
    purpose: "Real module interaction with local test stores and deterministic fixtures.",
  },
  {
    id: "T3",
    name: "Docker Integration",
    runs_on: "milestone branch",
    required_for: "milestone exit",
    purpose: "Full local stack service wiring and bridge behavior.",
  },
  {
    id: "T4",
    name: "Playwright Visual / E2E",
    runs_on: "UI/runtime milestones",
    required_for: "milestone exit",
    purpose: "User-visible behavior, generated artifacts, and visual regressions.",
  },
  {
    id: "T5",
    name: "Live Hosted Runtime",
    runs_on: "release branch",
    required_for: "release candidate",
    purpose: "Hosted runtime, private tool acceptance, and non-local workflow path proof.",
  },
  {
    id: "T6",
    name: "Deployed MCP Host Conformance",
    runs_on: "release branch",
    required_for: "production release",
    purpose: "Non-loopback MCP host, external stores, strict clients, and revocation propagation.",
  },
  {
    id: "T7",
    name: "Security / Abuse",
    runs_on: "release branch and nightly",
    required_for: "production release",
    purpose: "Tamper, replay, bypass, cross-tenant, injection, stale evidence, and revocation checks.",
  },
  {
    id: "T8",
    name: "Chaos / Soak / Performance",
    runs_on: "nightly and pre-release",
    required_for: "mature enterprise release",
    purpose: "Failure injection, long-running stability, budgets, and leak detection.",
  },
];

export const DOJO_VISUAL_REPORT_REQUIREMENTS = Object.freeze({
  requires_report_ok: true,
  requires_result_ok: true,
  requires_empty_failed_visual_gates: true,
  requires_pixel_metrics: true,
  requires_layout_metrics: true,
  max_horizontal_overflow_px: 4,
  required_result_fields: [
    "screenshot_path",
    "bytes",
    "image_metrics.pixel_metrics_verified",
    "image_metrics.unique_color_sample_count",
    "image_metrics.background_diff_pixel_ratio",
    "image_metrics.luma_stddev",
    "layout_metrics.horizontal_overflow_px",
    "layout_metrics.selector_visible_area_px",
    "screenshot_sha256",
  ],
});

export const DOJO_LIVE_HOSTED_RUNTIME_REQUIREMENTS = Object.freeze({
  require_hosted_runtime: true,
  require_non_loopback_runtime: true,
  require_visual_proof: true,
  require_successful_steps: true,
});

export const DOJO_DEPLOYED_PRIVATE_TOOL_HOST_REQUIREMENTS = Object.freeze({
  ...DOJO_LIVE_HOSTED_RUNTIME_REQUIREMENTS,
  require_external_private_tool_store: true,
  require_no_local_attach: true,
  require_private_tool_call: true,
});

export const DOJO_RELEASE_GATE_COMMANDS = [
  {
    id: "mcp_typecheck",
    tier: "T0",
    working_directory: "mcp/synthi-mcp",
    package_script: "typecheck",
    command: "npm --prefix mcp/synthi-mcp run typecheck",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
  },
  {
    id: "mcp_build",
    tier: "T0",
    working_directory: "mcp/synthi-mcp",
    package_script: "build",
    command: "npm --prefix mcp/synthi-mcp run build",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
  },
  {
    id: "mcp_unit_tests",
    tier: "T1",
    working_directory: "mcp/synthi-mcp",
    package_script: "test:unit",
    command: "npm --prefix mcp/synthi-mcp run test:unit",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "test_report",
  },
  {
    id: "mcp_integration_tests",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "test:integration",
    command: "npm --prefix mcp/synthi-mcp run test:integration",
    required_for: ["milestone", "release"],
    evidence_kind: "test_report",
  },
  {
    id: "dojo_postgres_control_plane_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:postgres-control-plane:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:postgres-control-plane:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
    default_evidence_path: "tmp/dojo-postgres-control-plane/dojo-postgres-control-plane.evidence.json",
    artifact_requirements: {
      require_postgres_url: true,
      require_all_control_plane_capabilities_covered: true,
      required_control_plane_capabilities: [...DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES],
      required_test_files: [...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
    requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
  },
  {
    id: "dojo_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:self-check -- --run-id release-gate",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.proofSelfCheckSummary.v1",
    evidence_schema_version: "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1",
    default_report_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/summary.json",
    default_evidence_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/production-runtime-evidence.json",
    artifact_requirements: {
      require_production_proof_consumed: true,
      require_proof_replay_blocked: true,
      require_runtime_custody_evidence: true,
      require_visual_pixel_metrics: true,
      require_no_runtime_credential_secret: true,
    },
  },
  {
    id: "dojo_mcp_host_conformance_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:mcp-host-conformance:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:mcp-host-conformance:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
  },
  {
    id: "dojo_affordance_codemod_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:affordance-codemod:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
    evidence_schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
    default_report_path: "tmp/dojo-affordance-codemod-self-check/dojo-affordance-codemod-self-check.json",
    default_evidence_path: "tmp/dojo-affordance-codemod-self-check/dojo-affordance-codemod-self-check.evidence.json",
  },
  {
    id: "frontend_lint",
    tier: "T0",
    working_directory: "synthi",
    package_script: "lint",
    command: "cd synthi && npm run lint",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
    package_json: "synthi/package.json",
  },
  {
    id: "frontend_build",
    tier: "T0",
    working_directory: "synthi",
    package_script: "build",
    command: "cd synthi && npm run build",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
    package_json: "synthi/package.json",
  },
  {
    id: "frontend_dojo_unit_tests",
    tier: "T1",
    working_directory: "synthi",
    package_script: "test",
    command: "cd synthi && npm test -- src/components/agent-workflows src/components/dojo src/services",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "test_report",
    package_json: "synthi/package.json",
  },
  {
    id: "docker_integration",
    tier: "T3",
    working_directory: ".",
    package_script: "proof:dojo:docker-integration:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:docker-integration:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
    default_evidence_path: "tmp/dojo-docker-integration/dojo-docker-integration.evidence.json",
    artifact_requirements: {
      require_compose_up_ran: true,
      require_all_required_services_running: true,
      required_services: [...DOJO_DOCKER_REQUIRED_SERVICES],
      require_required_healthchecks_healthy: true,
      required_healthy_services: [...DOJO_DOCKER_HEALTHY_SERVICES],
      require_required_endpoints_ok: true,
      required_endpoint_contracts: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => ({
        id: endpoint.id,
        expected_status: endpoint.expected_status,
      })),
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
    requires_env: [
      "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS",
      "AI_ENGINE_HOST_PORT",
      "POSTGRES_HOST_PORT",
    ],
  },
  {
    id: "dojo_full_visual_proof",
    tier: "T4",
    working_directory: "synthi",
    package_json: "synthi/package.json",
    package_script: "proof:dojo:visual",
    command: "npm --prefix synthi run proof:dojo:visual",
    required_for: ["milestone", "release"],
    evidence_kind: "visual_report",
    report_schema_version: "synthi.dojo.visualProof.v1",
    default_report_path: "synthi/tmp/dojo-visual-proof/visual-proof.json",
    visual_report_requirements: DOJO_VISUAL_REPORT_REQUIREMENTS,
  },
  {
    id: "dojo_ghost_mode_visual_proof",
    tier: "T4",
    working_directory: "synthi",
    package_json: "synthi/package.json",
    package_script: "proof:dojo:ghost-mode-visual",
    command: "npm --prefix synthi run proof:dojo:ghost-mode-visual",
    required_for: ["milestone", "release"],
    evidence_kind: "visual_report",
    report_schema_version: "synthi.dojo.ghostModeVisualProof.v1",
    default_report_path: "synthi/tmp/dojo-ghost-mode-visual/ghost-mode-shadow-visual-report.json",
    visual_report_requirements: DOJO_VISUAL_REPORT_REQUIREMENTS,
  },
  {
    id: "workflow_e2e_hosted",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:workflow-pipeline",
    command: "npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.workflowPipelineE2E.v1",
    default_report_path: "tmp/workflow-pipeline-e2e/summary.json",
    release_artifact_requirements: {
      ...DOJO_LIVE_HOSTED_RUNTIME_REQUIREMENTS,
      require_fresh_mcp_bridge: true,
      require_exported_playwright: true,
      require_no_forwarded_port_literals: true,
    },
    requires_env: [
      "SYNTHI_HOSTED_BROWSER_CDP_URL",
      "SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP",
    ],
  },
  {
    id: "private_tool_stdio_acceptance",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-stdio",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-stdio",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
    default_report_path: "tmp/private-tool-stdio-acceptance/mcp-stdio-private-tool-acceptance.json",
    release_artifact_requirements: {
      ...DOJO_LIVE_HOSTED_RUNTIME_REQUIREMENTS,
      require_strict_schema_validation: true,
      require_private_tool_registry: true,
      require_no_local_attach: true,
    },
    requires_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
  },
  {
    id: "private_tool_codex_acceptance",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-codex",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
    default_report_path: "tmp/private-tool-codex-acceptance/codex-private-tool-acceptance.json",
    release_artifact_requirements: {
      ...DOJO_LIVE_HOSTED_RUNTIME_REQUIREMENTS,
      require_agent_mcp_only: true,
      require_private_tool_call: true,
      require_no_local_attach: true,
    },
    requires_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
  },
  {
    id: "dojo_mcp_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:dojo:mcp-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.mcpHostConformance.v1",
    evidence_schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
    default_report_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.json",
    default_evidence_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.evidence.json",
    release_artifact_requirements: {
      reject_self_check_schema: true,
      require_non_loopback_mcp_host: true,
      require_production_execution: true,
      require_raw_backing_tool_block: true,
    },
    requires_env: ["SYNTHI_DOJO_MCP_HOST_URL"],
  },
  {
    id: "private_tool_stdio_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance -- --out-dir tmp/private-tool-stdio-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
    default_report_path: "tmp/private-tool-stdio-host-conformance/mcp-stdio-private-tool-acceptance.json",
    release_artifact_requirements: {
      ...DOJO_DEPLOYED_PRIVATE_TOOL_HOST_REQUIREMENTS,
      require_custom_mcp_command: true,
      require_strict_schema: true,
    },
    requires_env: [
      "SYNTHI_HOSTED_BROWSER_CDP_URL",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE",
      "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL",
    ],
  },
  {
    id: "private_tool_codex_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-codex-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance -- --out-dir tmp/private-tool-codex-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    report_schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
    default_report_path: "tmp/private-tool-codex-host-conformance/codex-private-tool-acceptance.json",
    release_artifact_requirements: {
      ...DOJO_DEPLOYED_PRIVATE_TOOL_HOST_REQUIREMENTS,
      require_agent_mcp_only: true,
      require_no_shell_commands: true,
    },
    requires_env: [
      "SYNTHI_HOSTED_BROWSER_CDP_URL",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY",
      "SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE",
      "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL",
    ],
  },
  {
    id: "security_abuse_suite",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:security-abuse:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:security-abuse:self-check",
    required_for: ["release"],
    evidence_kind: "test_report",
    evidence_schema_version: "synthi.dojo.securityAbuseEvidence.v1",
    default_evidence_path: "tmp/dojo-security-abuse/dojo-security-abuse.evidence.json",
    release_artifact_requirements: {
      require_all_abuse_classes_covered: true,
      required_abuse_classes: [...DOJO_SECURITY_ABUSE_CLASSES],
      required_test_files: [...DOJO_SECURITY_ABUSE_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_budget_ok: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "compliance_export_suite",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:compliance-export:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:compliance-export:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.complianceExportEvidence.v1",
    default_evidence_path: "tmp/dojo-compliance-export/dojo-compliance-export.evidence.json",
    release_artifact_requirements: {
      require_all_compliance_capabilities_covered: true,
      required_compliance_capabilities: [...DOJO_COMPLIANCE_EXPORT_CAPABILITIES],
      required_test_files: [...DOJO_COMPLIANCE_EXPORT_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "privacy_redaction_suite",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:privacy-redaction:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:privacy-redaction:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
    default_evidence_path: "tmp/dojo-privacy-redaction/dojo-privacy-redaction.evidence.json",
    release_artifact_requirements: {
      require_all_privacy_capabilities_covered: true,
      required_privacy_capabilities: [...DOJO_PRIVACY_REDACTION_CAPABILITIES],
      required_test_files: [...DOJO_PRIVACY_REDACTION_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_chaos_performance_self_check",
    tier: "T8",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:chaos-performance:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:chaos-performance:self-check",
    required_for: ["nightly", "enterprise_release"],
    evidence_kind: "metrics",
    evidence_schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
    default_evidence_path: "tmp/dojo-chaos-performance/dojo-chaos-performance.evidence.json",
    enterprise_artifact_requirements: {
      require_all_scenarios_covered: true,
      required_chaos_scenarios: [...DOJO_CHAOS_SCENARIOS],
      required_test_files: [...DOJO_CHAOS_PERFORMANCE_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_budget_ok: true,
      require_performance_metrics: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "soak_performance",
    tier: "T8",
    working_directory: "mcp/synthi-mcp",
    package_script: "soak",
    command: "npm --prefix mcp/synthi-mcp run soak",
    required_for: ["nightly", "enterprise_release"],
    evidence_kind: "metrics",
    default_summary_path: "mcp/synthi-mcp/.soak/soak-summary.json",
    default_events_path: "mcp/synthi-mcp/.soak/soak-events.ndjson",
    enterprise_artifact_requirements: {
      require_min_duration_seconds: 3600,
      require_zero_errors: true,
      require_iteration_events: true,
      require_tool_latency_metrics: true,
      require_memory_growth_metrics: true,
      require_post_detach_leak_counters: true,
    },
  },
];

export const DOJO_MINIMAL_PR_GATE_IDS = [
  "mcp_typecheck",
  "mcp_build",
  "mcp_unit_tests",
  "frontend_lint",
  "frontend_build",
  "frontend_dojo_unit_tests",
];

export const DOJO_MILESTONE_GATE_IDS = [
  ...DOJO_MINIMAL_PR_GATE_IDS,
  "mcp_integration_tests",
  "dojo_postgres_control_plane_self_check",
  "dojo_self_check",
  "dojo_mcp_host_conformance_self_check",
  "dojo_affordance_codemod_self_check",
  "docker_integration",
  "dojo_full_visual_proof",
  "dojo_ghost_mode_visual_proof",
];

export const DOJO_RELEASE_GATE_IDS = [
  ...DOJO_MILESTONE_GATE_IDS,
  "workflow_e2e_hosted",
  "private_tool_stdio_acceptance",
  "private_tool_codex_acceptance",
  "dojo_mcp_host_conformance",
  "private_tool_stdio_host_conformance",
  "private_tool_codex_host_conformance",
  "security_abuse_suite",
  "compliance_export_suite",
  "privacy_redaction_suite",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-release-gates"));
  if (truthy(args["self-check"])) {
    const artifacts = await runSelfCheck({ outDir });
    console.log(`[ok] Dojo release gate manifest self-check passed - manifest=${artifacts.manifest_path} evidence=${artifacts.evidence_path}`);
    return;
  }

  const packageScripts = await readPackageScripts();
  const manifest = buildDojoReleaseGateManifest({ packageScripts });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  if (!validation.ok) {
    throw new Error(`dojo_release_gate_manifest_invalid:${validation.errors.join(";")}`);
  }
  const artifacts = await writeDojoReleaseGateArtifacts({ outDir, manifest });
  console.log(`[ok] Dojo release gate manifest written - manifest=${artifacts.manifest_path} evidence=${artifacts.evidence_path}`);
}

export function buildDojoReleaseGateManifest({
  generatedAt = new Date().toISOString(),
  packageScripts = {},
} = {}) {
  const commands = DOJO_RELEASE_GATE_COMMANDS.map((gate) => ({
    ...gate,
    runnable: Boolean(gate.package_script || gate.command),
    script_exists: gate.package_script ? packageScriptExists(packageScripts, gate) : null,
  }));
  const tiers = DOJO_RELEASE_GATE_TIERS.map((tier) => ({
    ...tier,
    gate_count: commands.filter((gate) => gate.tier === tier.id).length,
  }));
  return {
    schema_version: "synthi.dojo.releaseGateManifest.v1",
    generated_at: generatedAt,
    tiers,
    minimal_pr_gate_ids: [...DOJO_MINIMAL_PR_GATE_IDS],
    milestone_gate_ids: [...DOJO_MILESTONE_GATE_IDS],
    release_gate_ids: [...DOJO_RELEASE_GATE_IDS],
    gates: commands,
    policy: {
      every_pr_requires: ["T0", "T1"],
      milestone_exit_requires: ["T0", "T1", "T2", "T3", "T4"],
      release_candidate_requires: ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"],
      nightly_enterprise_requires: ["T8"],
      first_merge_standard:
        "First foundation PRs require T0, T1, and focused touched-surface tests; live, deployed, chaos, and soak gates wait for release scope.",
    },
  };
}

export function validateDojoReleaseGateManifest(manifest, { packageScripts = {} } = {}) {
  const errors = [];
  const tierIds = new Set((manifest?.tiers || []).map((tier) => tier.id));
  for (const required of ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]) {
    if (!tierIds.has(required)) errors.push(`missing_tier:${required}`);
  }
  const gates = Array.isArray(manifest?.gates) ? manifest.gates : [];
  const gateIds = new Set(gates.map((gate) => gate.id));
  for (const groupName of ["minimal_pr_gate_ids", "milestone_gate_ids", "release_gate_ids"]) {
    for (const id of manifest?.[groupName] || []) {
      if (!gateIds.has(id)) errors.push(`unknown_${groupName}:${id}`);
    }
  }
  for (const gate of gates) {
    if (!tierIds.has(gate.tier)) errors.push(`gate_unknown_tier:${gate.id}:${gate.tier}`);
    if (!Array.isArray(gate.required_for) || gate.required_for.length === 0) errors.push(`gate_missing_required_for:${gate.id}`);
    if (!gate.evidence_kind) errors.push(`gate_missing_evidence_kind:${gate.id}`);
    if (gate.package_script && !gatePackageScriptIsPresent(packageScripts, gate)) {
      errors.push(`missing_package_script:${gate.package_json || "mcp/synthi-mcp/package.json"}:${gate.package_script}`);
    }
  }
  const minimalTiers = new Set((manifest?.minimal_pr_gate_ids || []).map((id) => gates.find((gate) => gate.id === id)?.tier));
  if (!minimalTiers.has("T0")) errors.push("minimal_pr_missing_T0");
  if (!minimalTiers.has("T1")) errors.push("minimal_pr_missing_T1");
  const releaseTiers = new Set((manifest?.release_gate_ids || []).map((id) => gates.find((gate) => gate.id === id)?.tier));
  for (const required of ["T5", "T6", "T7"]) {
    if (!releaseTiers.has(required)) errors.push(`release_missing_${required}`);
  }
  for (const gate of gates.filter((item) => item.tier === "T4")) {
    if (gate.evidence_kind !== "visual_report") errors.push(`visual_gate_missing_report_contract:${gate.id}`);
    if (!gate.report_schema_version) errors.push(`visual_gate_missing_schema:${gate.id}`);
    if (!gate.default_report_path) errors.push(`visual_gate_missing_report_path:${gate.id}`);
    if (!gate.visual_report_requirements?.requires_pixel_metrics) errors.push(`visual_gate_missing_pixel_metrics:${gate.id}`);
    if (!gate.visual_report_requirements?.requires_layout_metrics) errors.push(`visual_gate_missing_layout_metrics:${gate.id}`);
  }
  for (const gate of gates.filter((item) => item.tier === "T5")) {
    if (gate.evidence_kind !== "proof_artifact") errors.push(`live_hosted_gate_missing_artifact_contract:${gate.id}`);
    if (!gate.report_schema_version) errors.push(`live_hosted_gate_missing_schema:${gate.id}`);
    if (!gate.default_report_path) errors.push(`live_hosted_gate_missing_report_path:${gate.id}`);
    if (!gate.release_artifact_requirements?.require_hosted_runtime) {
      errors.push(`live_hosted_gate_missing_runtime_requirement:${gate.id}`);
    }
    if (!gate.release_artifact_requirements?.require_visual_proof) {
      errors.push(`live_hosted_gate_missing_visual_requirement:${gate.id}`);
    }
  }
  const dojoSelfCheckGate = gates.find((gate) => gate.id === "dojo_self_check");
  if (dojoSelfCheckGate) {
    if (dojoSelfCheckGate.report_schema_version !== "synthi.dojo.proofSelfCheckSummary.v1") {
      errors.push("dojo_self_check_missing_summary_schema");
    }
    if (dojoSelfCheckGate.evidence_schema_version !== "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1") {
      errors.push("dojo_self_check_missing_production_evidence_schema");
    }
    if (!dojoSelfCheckGate.default_report_path) errors.push("dojo_self_check_missing_default_summary_path");
    if (!dojoSelfCheckGate.default_evidence_path) errors.push("dojo_self_check_missing_default_evidence_path");
    if (!dojoSelfCheckGate.artifact_requirements?.require_production_proof_consumed) {
      errors.push("dojo_self_check_missing_production_proof_requirement");
    }
    if (!dojoSelfCheckGate.artifact_requirements?.require_runtime_custody_evidence) {
      errors.push("dojo_self_check_missing_runtime_custody_requirement");
    }
    if (!dojoSelfCheckGate.artifact_requirements?.require_visual_pixel_metrics) {
      errors.push("dojo_self_check_missing_visual_pixel_requirement");
    }
  }
  const postgresControlPlaneGate = gates.find((gate) => gate.id === "dojo_postgres_control_plane_self_check");
  if (postgresControlPlaneGate) {
    if (postgresControlPlaneGate.evidence_schema_version !== "synthi.dojo.postgresControlPlaneEvidence.v1") {
      errors.push("postgres_control_plane_missing_evidence_schema");
    }
    if (!postgresControlPlaneGate.default_evidence_path) errors.push("postgres_control_plane_missing_default_evidence_path");
    if (!postgresControlPlaneGate.artifact_requirements?.require_postgres_url) {
      errors.push("postgres_control_plane_missing_postgres_requirement");
    }
    if (!postgresControlPlaneGate.artifact_requirements?.require_all_control_plane_capabilities_covered) {
      errors.push("postgres_control_plane_missing_capability_requirement");
    }
    const requiredPostgresCapabilities = Array.isArray(postgresControlPlaneGate.artifact_requirements?.required_control_plane_capabilities)
      ? postgresControlPlaneGate.artifact_requirements.required_control_plane_capabilities
      : [];
    const missingPostgresCapabilities = DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
      .filter((capability) => !requiredPostgresCapabilities.includes(capability));
    if (missingPostgresCapabilities.length > 0) {
      errors.push(`postgres_control_plane_missing_required_capabilities:${missingPostgresCapabilities.join(",")}`);
    }
    const missingPostgresTestFiles = missingRequiredEntries(
      DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
      postgresControlPlaneGate.artifact_requirements?.required_test_files,
    );
    if (missingPostgresTestFiles.length > 0) {
      errors.push(`postgres_control_plane_missing_required_test_files:${missingPostgresTestFiles.join(",")}`);
    }
    if (!postgresControlPlaneGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("postgres_control_plane_missing_json_report_digest_requirement");
    }
    if (!Array.isArray(postgresControlPlaneGate.requires_env)
      || !postgresControlPlaneGate.requires_env.includes("SYNTHI_DOJO_POSTGRES_TEST_URL")) {
      errors.push("postgres_control_plane_missing_postgres_env");
    }
  }
  const dockerIntegrationGate = gates.find((gate) => gate.id === "docker_integration");
  if (dockerIntegrationGate) {
    if (dockerIntegrationGate.evidence_kind !== "proof_artifact") {
      errors.push("docker_integration_missing_proof_artifact_contract");
    }
    if (dockerIntegrationGate.evidence_schema_version !== "synthi.dojo.dockerIntegrationEvidence.v1") {
      errors.push("docker_integration_missing_evidence_schema");
    }
    if (dockerIntegrationGate.package_script !== "proof:dojo:docker-integration:self-check") {
      errors.push("docker_integration_missing_package_script");
    }
    if (!dockerIntegrationGate.default_evidence_path) errors.push("docker_integration_missing_default_evidence_path");
    if (!dockerIntegrationGate.artifact_requirements?.require_compose_up_ran) {
      errors.push("docker_integration_missing_compose_up_requirement");
    }
    if (!dockerIntegrationGate.artifact_requirements?.require_all_required_services_running) {
      errors.push("docker_integration_missing_service_requirement");
    }
    const requiredDockerServices = Array.isArray(dockerIntegrationGate.artifact_requirements?.required_services)
      ? dockerIntegrationGate.artifact_requirements.required_services
      : [];
    const missingDockerServices = DOJO_DOCKER_REQUIRED_SERVICES
      .filter((service) => !requiredDockerServices.includes(service));
    if (missingDockerServices.length > 0) {
      errors.push(`docker_integration_missing_required_services:${missingDockerServices.join(",")}`);
    }
    if (!dockerIntegrationGate.artifact_requirements?.require_required_healthchecks_healthy) {
      errors.push("docker_integration_missing_healthcheck_requirement");
    }
    const requiredHealthyServices = Array.isArray(dockerIntegrationGate.artifact_requirements?.required_healthy_services)
      ? dockerIntegrationGate.artifact_requirements.required_healthy_services
      : [];
    const missingHealthyServices = DOJO_DOCKER_HEALTHY_SERVICES
      .filter((service) => !requiredHealthyServices.includes(service));
    if (missingHealthyServices.length > 0) {
      errors.push(`docker_integration_missing_required_healthy_services:${missingHealthyServices.join(",")}`);
    }
    if (!dockerIntegrationGate.artifact_requirements?.require_required_endpoints_ok) {
      errors.push("docker_integration_missing_endpoint_requirement");
    }
    const requiredEndpointContracts = Array.isArray(dockerIntegrationGate.artifact_requirements?.required_endpoint_contracts)
      ? dockerIntegrationGate.artifact_requirements.required_endpoint_contracts
      : [];
    const requiredEndpointIds = new Set(requiredEndpointContracts.map((endpoint) => String(endpoint?.id || "")));
    const missingEndpointContracts = DOJO_DOCKER_REQUIRED_ENDPOINTS
      .filter((endpoint) => !requiredEndpointIds.has(endpoint.id));
    if (missingEndpointContracts.length > 0) {
      errors.push(`docker_integration_missing_required_endpoints:${missingEndpointContracts.map((endpoint) => endpoint.id).join(",")}`);
    }
    const mismatchedEndpointContracts = DOJO_DOCKER_REQUIRED_ENDPOINTS
      .filter((endpoint) => {
        const declared = requiredEndpointContracts.find((item) => item?.id === endpoint.id);
        return declared && Number(declared.expected_status) !== Number(endpoint.expected_status);
      });
    if (mismatchedEndpointContracts.length > 0) {
      errors.push(`docker_integration_endpoint_status_contract_mismatch:${mismatchedEndpointContracts.map((endpoint) => endpoint.id).join(",")}`);
    }
    if (!dockerIntegrationGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("docker_integration_missing_json_report_digest_requirement");
    }
    for (const requiredEnv of ["NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS", "AI_ENGINE_HOST_PORT", "POSTGRES_HOST_PORT"]) {
      if (!Array.isArray(dockerIntegrationGate.requires_env) || !dockerIntegrationGate.requires_env.includes(requiredEnv)) {
        errors.push(`docker_integration_missing_env:${requiredEnv}`);
      }
    }
  }
  const mcpHostConformanceGate = gates.find((gate) => gate.id === "dojo_mcp_host_conformance");
  if (mcpHostConformanceGate) {
    if (mcpHostConformanceGate.report_schema_version !== "synthi.dojo.mcpHostConformance.v1") {
      errors.push("mcp_host_conformance_missing_release_report_schema");
    }
    if (mcpHostConformanceGate.evidence_schema_version !== "synthi.dojo.mcpHostConformanceEvidence.v1") {
      errors.push("mcp_host_conformance_missing_evidence_schema");
    }
    if (!mcpHostConformanceGate.default_report_path) errors.push("mcp_host_conformance_missing_default_report_path");
    if (!mcpHostConformanceGate.default_evidence_path) errors.push("mcp_host_conformance_missing_default_evidence_path");
    if (!mcpHostConformanceGate.release_artifact_requirements?.require_production_execution) {
      errors.push("mcp_host_conformance_missing_production_execution_requirement");
    }
    if (!mcpHostConformanceGate.release_artifact_requirements?.require_non_loopback_mcp_host) {
      errors.push("mcp_host_conformance_missing_non_loopback_requirement");
    }
  }
  const privateToolHostConformanceGates = gates.filter((gate) => {
    return gate.id === "private_tool_stdio_host_conformance" || gate.id === "private_tool_codex_host_conformance";
  });
  for (const gate of privateToolHostConformanceGates) {
    if (gate.evidence_kind !== "proof_artifact") errors.push(`private_tool_host_conformance_missing_artifact_contract:${gate.id}`);
    if (!gate.report_schema_version) errors.push(`private_tool_host_conformance_missing_schema:${gate.id}`);
    if (!gate.default_report_path) errors.push(`private_tool_host_conformance_missing_report_path:${gate.id}`);
    if (!gate.release_artifact_requirements?.require_non_loopback_runtime) {
      errors.push(`private_tool_host_conformance_missing_non_loopback_runtime:${gate.id}`);
    }
    if (!gate.release_artifact_requirements?.require_external_private_tool_store) {
      errors.push(`private_tool_host_conformance_missing_external_store:${gate.id}`);
    }
    if (!gate.release_artifact_requirements?.require_visual_proof) {
      errors.push(`private_tool_host_conformance_missing_visual_proof:${gate.id}`);
    }
    if (!Array.isArray(gate.requires_env) || !gate.requires_env.includes("SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE")) {
      errors.push(`private_tool_host_conformance_missing_store_env:${gate.id}`);
    }
    if (!Array.isArray(gate.requires_env) || !gate.requires_env.includes("SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL")) {
      errors.push(`private_tool_host_conformance_missing_target_env:${gate.id}`);
    }
  }
  const securityAbuseGate = gates.find((gate) => gate.id === "security_abuse_suite");
  if (securityAbuseGate) {
    if (securityAbuseGate.evidence_schema_version !== "synthi.dojo.securityAbuseEvidence.v1") {
      errors.push("security_abuse_missing_evidence_schema");
    }
    if (!securityAbuseGate.default_evidence_path) errors.push("security_abuse_missing_default_evidence_path");
    if (!securityAbuseGate.release_artifact_requirements?.require_all_abuse_classes_covered) {
      errors.push("security_abuse_missing_coverage_requirement");
    }
    const requiredAbuseClasses = Array.isArray(securityAbuseGate.release_artifact_requirements?.required_abuse_classes)
      ? securityAbuseGate.release_artifact_requirements.required_abuse_classes
      : [];
    const missingAbuseClasses = DOJO_SECURITY_ABUSE_CLASSES.filter((abuseClass) => !requiredAbuseClasses.includes(abuseClass));
    if (missingAbuseClasses.length > 0) {
      errors.push(`security_abuse_missing_required_classes:${missingAbuseClasses.join(",")}`);
    }
    const missingSecurityTestFiles = missingRequiredEntries(
      DOJO_SECURITY_ABUSE_TEST_FILES,
      securityAbuseGate.release_artifact_requirements?.required_test_files,
    );
    if (missingSecurityTestFiles.length > 0) {
      errors.push(`security_abuse_missing_required_test_files:${missingSecurityTestFiles.join(",")}`);
    }
    if (!securityAbuseGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("security_abuse_missing_no_skipped_requirement");
    }
    if (!securityAbuseGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("security_abuse_missing_digest_requirement");
    }
    if (!securityAbuseGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("security_abuse_missing_json_report_digest_requirement");
    }
  }
  const complianceExportGate = gates.find((gate) => gate.id === "compliance_export_suite");
  if (complianceExportGate) {
    if (complianceExportGate.evidence_schema_version !== "synthi.dojo.complianceExportEvidence.v1") {
      errors.push("compliance_export_missing_evidence_schema");
    }
    if (complianceExportGate.package_script !== "proof:dojo:compliance-export:self-check") {
      errors.push("compliance_export_missing_package_script");
    }
    if (!complianceExportGate.default_evidence_path) errors.push("compliance_export_missing_default_evidence_path");
    if (!complianceExportGate.release_artifact_requirements?.require_all_compliance_capabilities_covered) {
      errors.push("compliance_export_missing_capability_requirement");
    }
    const requiredComplianceCapabilities = Array.isArray(complianceExportGate.release_artifact_requirements?.required_compliance_capabilities)
      ? complianceExportGate.release_artifact_requirements.required_compliance_capabilities
      : [];
    const missingComplianceCapabilities = DOJO_COMPLIANCE_EXPORT_CAPABILITIES
      .filter((capability) => !requiredComplianceCapabilities.includes(capability));
    if (missingComplianceCapabilities.length > 0) {
      errors.push(`compliance_export_missing_required_capabilities:${missingComplianceCapabilities.join(",")}`);
    }
    const missingComplianceTestFiles = missingRequiredEntries(
      DOJO_COMPLIANCE_EXPORT_TEST_FILES,
      complianceExportGate.release_artifact_requirements?.required_test_files,
    );
    if (missingComplianceTestFiles.length > 0) {
      errors.push(`compliance_export_missing_required_test_files:${missingComplianceTestFiles.join(",")}`);
    }
    if (!complianceExportGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("compliance_export_missing_digest_requirement");
    }
    if (!complianceExportGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("compliance_export_missing_json_report_digest_requirement");
    }
  }
  const privacyRedactionGate = gates.find((gate) => gate.id === "privacy_redaction_suite");
  if (privacyRedactionGate) {
    if (privacyRedactionGate.evidence_schema_version !== "synthi.dojo.privacyRedactionEvidence.v1") {
      errors.push("privacy_redaction_missing_evidence_schema");
    }
    if (privacyRedactionGate.package_script !== "proof:dojo:privacy-redaction:self-check") {
      errors.push("privacy_redaction_missing_package_script");
    }
    if (!privacyRedactionGate.default_evidence_path) errors.push("privacy_redaction_missing_default_evidence_path");
    if (!privacyRedactionGate.release_artifact_requirements?.require_all_privacy_capabilities_covered) {
      errors.push("privacy_redaction_missing_capability_requirement");
    }
    const requiredPrivacyCapabilities = Array.isArray(privacyRedactionGate.release_artifact_requirements?.required_privacy_capabilities)
      ? privacyRedactionGate.release_artifact_requirements.required_privacy_capabilities
      : [];
    const missingPrivacyCapabilities = DOJO_PRIVACY_REDACTION_CAPABILITIES
      .filter((capability) => !requiredPrivacyCapabilities.includes(capability));
    if (missingPrivacyCapabilities.length > 0) {
      errors.push(`privacy_redaction_missing_required_capabilities:${missingPrivacyCapabilities.join(",")}`);
    }
    const missingPrivacyTestFiles = missingRequiredEntries(
      DOJO_PRIVACY_REDACTION_TEST_FILES,
      privacyRedactionGate.release_artifact_requirements?.required_test_files,
    );
    if (missingPrivacyTestFiles.length > 0) {
      errors.push(`privacy_redaction_missing_required_test_files:${missingPrivacyTestFiles.join(",")}`);
    }
    if (!privacyRedactionGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("privacy_redaction_missing_digest_requirement");
    }
    if (!privacyRedactionGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("privacy_redaction_missing_json_report_digest_requirement");
    }
  }
  const chaosPerformanceGate = gates.find((gate) => gate.id === "dojo_chaos_performance_self_check");
  if (chaosPerformanceGate) {
    if (chaosPerformanceGate.evidence_schema_version !== "synthi.dojo.chaosPerformanceEvidence.v1") {
      errors.push("chaos_performance_missing_evidence_schema");
    }
    if (!chaosPerformanceGate.default_evidence_path) errors.push("chaos_performance_missing_default_evidence_path");
    if (!chaosPerformanceGate.enterprise_artifact_requirements?.require_all_scenarios_covered) {
      errors.push("chaos_performance_missing_scenario_requirement");
    }
    const requiredChaosScenarios = Array.isArray(chaosPerformanceGate.enterprise_artifact_requirements?.required_chaos_scenarios)
      ? chaosPerformanceGate.enterprise_artifact_requirements.required_chaos_scenarios
      : [];
    const missingChaosScenarios = DOJO_CHAOS_SCENARIOS
      .filter((scenario) => !requiredChaosScenarios.includes(scenario));
    if (missingChaosScenarios.length > 0) {
      errors.push(`chaos_performance_missing_required_scenarios:${missingChaosScenarios.join(",")}`);
    }
    const missingChaosTestFiles = missingRequiredEntries(
      DOJO_CHAOS_PERFORMANCE_TEST_FILES,
      chaosPerformanceGate.enterprise_artifact_requirements?.required_test_files,
    );
    if (missingChaosTestFiles.length > 0) {
      errors.push(`chaos_performance_missing_required_test_files:${missingChaosTestFiles.join(",")}`);
    }
    if (!chaosPerformanceGate.enterprise_artifact_requirements?.require_no_skipped_tests) {
      errors.push("chaos_performance_missing_no_skipped_requirement");
    }
    if (!chaosPerformanceGate.enterprise_artifact_requirements?.require_performance_metrics) {
      errors.push("chaos_performance_missing_metrics_requirement");
    }
    if (!chaosPerformanceGate.enterprise_artifact_requirements?.require_json_report_digest_match) {
      errors.push("chaos_performance_missing_json_report_digest_requirement");
    }
  }
  const soakPerformanceGate = gates.find((gate) => gate.id === "soak_performance");
  if (soakPerformanceGate) {
    if (!soakPerformanceGate.default_summary_path) errors.push("soak_performance_missing_default_summary_path");
    if (!soakPerformanceGate.default_events_path) errors.push("soak_performance_missing_default_events_path");
    if (!Number.isFinite(Number(soakPerformanceGate.enterprise_artifact_requirements?.require_min_duration_seconds))) {
      errors.push("soak_performance_missing_duration_requirement");
    }
    if (!soakPerformanceGate.enterprise_artifact_requirements?.require_iteration_events) {
      errors.push("soak_performance_missing_event_requirement");
    }
    if (!soakPerformanceGate.enterprise_artifact_requirements?.require_memory_growth_metrics) {
      errors.push("soak_performance_missing_memory_requirement");
    }
    if (!soakPerformanceGate.enterprise_artifact_requirements?.require_post_detach_leak_counters) {
      errors.push("soak_performance_missing_leak_counter_requirement");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    tier_count: tierIds.size,
    gate_count: gates.length,
  };
}

function missingRequiredEntries(requiredEntries, declaredEntries) {
  const declared = new Set(Array.isArray(declaredEntries) ? declaredEntries.map(String) : []);
  return requiredEntries.filter((entry) => !declared.has(entry));
}

export function validateDojoVisualProofReport(report, {
  gate = {},
  requirements = gate.visual_report_requirements || DOJO_VISUAL_REPORT_REQUIREMENTS,
} = {}) {
  const errors = [];
  if (gate.report_schema_version && report?.schema_version !== gate.report_schema_version) {
    errors.push(`schema_mismatch:${report?.schema_version || "missing"}:${gate.report_schema_version}`);
  }
  if (requirements.requires_report_ok && report?.ok !== true) {
    errors.push("visual_report_not_ok");
  }
  const results = Array.isArray(report?.results) ? report.results : [];
  if (results.length === 0) {
    errors.push("visual_report_missing_results");
  }
  for (const [index, result] of results.entries()) {
    const label = result.route_id || result.name || String(index);
    if (requirements.requires_result_ok && result.ok !== true) {
      errors.push(`visual_result_not_ok:${label}`);
    }
    if (
      requirements.requires_empty_failed_visual_gates
      && Array.isArray(result.failed_visual_gates)
      && result.failed_visual_gates.length > 0
    ) {
      errors.push(`visual_result_failed_gates:${label}:${result.failed_visual_gates.join(",")}`);
    }
    for (const fieldPath of requirements.required_result_fields || []) {
      if (valueAtPath(result, fieldPath) === undefined) {
        errors.push(`visual_result_missing_field:${label}:${fieldPath}`);
      }
    }
    if (requirements.requires_pixel_metrics && result.image_metrics?.pixel_metrics_verified !== true) {
      errors.push(`visual_result_pixel_metrics_unverified:${label}`);
    }
    const overflow = Number(result.layout_metrics?.horizontal_overflow_px);
    if (!Number.isFinite(overflow)) {
      errors.push(`visual_result_layout_overflow_unmeasured:${label}`);
    } else if (overflow > requirements.max_horizontal_overflow_px) {
      errors.push(`visual_result_horizontal_overflow:${label}:${overflow}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    result_count: results.length,
  };
}

export function buildDojoReleaseGateEvidenceManifest({ manifest, manifestPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(manifest);
  const validation = validateDojoReleaseGateManifest(manifest);
  const visualGates = Array.isArray(manifest?.gates)
    ? manifest.gates.filter((gate) => gate.evidence_kind === "visual_report")
    : [];
  const proofArtifactGates = Array.isArray(manifest?.gates)
    ? manifest.gates.filter((gate) => gate.evidence_kind === "proof_artifact")
    : [];
  return {
    schema_version: "synthi.dojo.releaseGateEvidence.v1",
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    manifest_sha256: sha256(body),
    manifest_bytes: Buffer.byteLength(body),
    validation_ok: validation.ok,
    validation_errors: validation.errors,
    tier_count: Array.isArray(manifest?.tiers) ? manifest.tiers.length : 0,
    gate_count: Array.isArray(manifest?.gates) ? manifest.gates.length : 0,
    minimal_pr_gate_count: Array.isArray(manifest?.minimal_pr_gate_ids) ? manifest.minimal_pr_gate_ids.length : 0,
    milestone_gate_count: Array.isArray(manifest?.milestone_gate_ids) ? manifest.milestone_gate_ids.length : 0,
    release_gate_count: Array.isArray(manifest?.release_gate_ids) ? manifest.release_gate_ids.length : 0,
    visual_report_gate_count: visualGates.length,
    visual_report_gate_ids: visualGates.map((gate) => gate.id),
    proof_artifact_gate_count: proofArtifactGates.length,
    proof_artifact_gate_ids: proofArtifactGates.map((gate) => gate.id),
  };
}

export async function writeDojoReleaseGateArtifacts({ outDir, manifest }) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "dojo-release-gate-manifest.json");
  const evidencePath = path.join(outDir, "dojo-release-gate-manifest.evidence.json");
  const serialized = JSON.stringify(manifest, null, 2);
  const evidence = buildDojoReleaseGateEvidenceManifest({
    manifest,
    manifestPath,
    serialized,
  });
  await writeFile(manifestPath, serialized);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return {
    manifest_path: manifestPath,
    evidence_path: evidencePath,
    manifest,
    evidence,
  };
}

export async function runSelfCheck({ outDir }) {
  const packageScripts = await readPackageScripts();
  const manifest = buildDojoReleaseGateManifest({
    generatedAt: "2026-06-11T00:00:00.000Z",
    packageScripts,
  });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  assert.equal(validation.ok, true, validation.errors.join(";"));
  assert.equal(manifest.tiers.length, 9);
  assert(manifest.minimal_pr_gate_ids.length > 0);
  assert(manifest.milestone_gate_ids.includes("dojo_self_check"));
  assert(manifest.milestone_gate_ids.includes("dojo_postgres_control_plane_self_check"));
  assert(manifest.milestone_gate_ids.includes("dojo_affordance_codemod_self_check"));
  assert(manifest.milestone_gate_ids.includes("dojo_full_visual_proof"));
  assert(manifest.release_gate_ids.includes("dojo_mcp_host_conformance"));
  assert(manifest.release_gate_ids.includes("security_abuse_suite"));
  assert(manifest.release_gate_ids.includes("compliance_export_suite"));
  assert(manifest.release_gate_ids.includes("privacy_redaction_suite"));
  assert(manifest.gates.some((gate) => gate.id === "dojo_chaos_performance_self_check" && gate.tier === "T8"));
  assert(manifest.gates.some((gate) => gate.tier === "T8"));
  return writeDojoReleaseGateArtifacts({ outDir, manifest });
}

async function readPackageScripts() {
  const mcpPackage = JSON.parse(await readFile(path.join(MCP_ROOT, "package.json"), "utf8"));
  const frontendPackage = JSON.parse(await readFile(path.join(REPO_ROOT, "synthi", "package.json"), "utf8"));
  return {
    "mcp/synthi-mcp/package.json": mcpPackage.scripts || {},
    "synthi/package.json": frontendPackage.scripts || {},
  };
}

function packageScriptExists(packageScripts, gate) {
  const packageJson = gate.package_json || "mcp/synthi-mcp/package.json";
  return Boolean(packageScripts?.[packageJson]?.[gate.package_script]);
}

function gatePackageScriptIsPresent(packageScripts, gate) {
  const packageJson = gate.package_json || "mcp/synthi-mcp/package.json";
  if (packageScripts?.[packageJson]) return packageScriptExists(packageScripts, gate);
  return gate.script_exists !== false;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valueAtPath(source, fieldPath) {
  return String(fieldPath).split(".").reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, source);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
