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
  DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
  DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
} from "./dojo-agent-ready-ui-contract-self-check.mjs";
import {
  DOJO_API_TOOL_COMPILER_CAPABILITIES,
  DOJO_API_TOOL_COMPILER_TEST_FILES,
} from "./dojo-api-tool-compiler-self-check.mjs";
import {
  DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
  DOJO_CASE_LAW_RUNTIME_TEST_FILES,
} from "./dojo-case-law-runtime-self-check.mjs";
import {
  DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
  DOJO_CHECKRIDE_LICENSE_TEST_FILES,
} from "./dojo-checkride-license-self-check.mjs";
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
  DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
  DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
} from "./dojo-evidence-authority-self-check.mjs";
import {
  DOJO_GENERATED_PR_CAPABILITIES,
  DOJO_GENERATED_PR_TEST_FILES,
} from "./dojo-generated-pr-self-check.mjs";
import {
  DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
  DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
} from "./dojo-governance-lifecycle-self-check.mjs";
import {
  DOJO_GRAPH_RUNTIME_CAPABILITIES,
  DOJO_GRAPH_RUNTIME_TEST_FILES,
} from "./dojo-graph-runtime-self-check.mjs";
import {
  DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
  DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
} from "./dojo-ghost-mode-evidence-self-check.mjs";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
  DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
} from "./dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
  DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
} from "./dojo-implementation-status-self-check.mjs";
import {
  DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
  DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
} from "./dojo-managed-key-signing-self-check.mjs";
import {
  DOJO_MCP_SKILL_BUS_CAPABILITIES,
  DOJO_MCP_SKILL_BUS_TEST_FILES,
} from "./dojo-mcp-skill-bus-self-check.mjs";
import {
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "./dojo-postgres-control-plane-self-check.mjs";
import {
  DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
  DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
} from "./dojo-public-proof-verification-self-check.mjs";
import {
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
  DOJO_PRIVACY_REDACTION_TEST_FILES,
} from "./dojo-privacy-redaction-self-check.mjs";
import {
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "./dojo-security-abuse-self-check.mjs";
import {
  DOJO_SKILL_PASSPORT_CAPABILITIES,
  DOJO_SKILL_PASSPORT_TEST_FILES,
} from "./dojo-skill-passport-self-check.mjs";
import {
  DOJO_SOURCE_DRIFT_CAPABILITIES,
  DOJO_SOURCE_DRIFT_TEST_FILES,
} from "./dojo-source-drift-self-check.mjs";
import {
  DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES,
  DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
} from "./dojo-time-machine-debugger-self-check.mjs";
import {
  DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
  DOJO_VIVARIUM_RUNTIME_TEST_FILES,
} from "./dojo-vivarium-runtime-self-check.mjs";

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

export const DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS = Object.freeze({
  reject_self_check_schema: true,
  require_non_loopback_mcp_host: true,
  require_public_non_local_mcp_host: true,
  require_production_execution: true,
  require_raw_backing_tool_block: true,
  require_revocation_propagation: true,
  require_external_control_plane_store: true,
  require_external_proof_signing: true,
  require_bridge_token: true,
  require_no_local_cdp: true,
  require_licensed_skill_filtering: true,
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
    id: "dojo_implementation_status_self_check",
    tier: "T1",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:implementation-status:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:implementation-status:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.implementationStatusEvidence.v1",
    default_evidence_path: "tmp/dojo-implementation-status/dojo-implementation-status.evidence.json",
    artifact_requirements: {
      require_all_implementation_status_capabilities_covered: true,
      required_implementation_status_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
      required_test_files: [...DOJO_IMPLEMENTATION_STATUS_TEST_FILES],
      require_stable_vocabulary: true,
      require_every_tool_classified: true,
      require_machine_manifest_sync: true,
      require_unknown_tool_fails_planned: true,
      require_production_runtime_claim_boundary: true,
      require_runtime_scope_for_executable: true,
      require_report_surface_no_overclaim: true,
      require_proof_dispatch_hosted_runtime_boundary: true,
      require_ghost_mode_non_mutating_boundary: true,
      require_control_plane_write_boundary: true,
      require_immutable_metadata: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
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
    id: "dojo_evidence_authority_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:evidence-authority:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:evidence-authority:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
    default_evidence_path: "tmp/dojo-evidence-authority/dojo-evidence-authority.evidence.json",
    artifact_requirements: {
      require_all_evidence_authority_capabilities_covered: true,
      required_evidence_authority_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
      required_test_files: [...DOJO_EVIDENCE_AUTHORITY_TEST_FILES],
      require_canonical_record_hash: true,
      require_record_signature_verification: true,
      require_tamper_detection: true,
      require_claim_freshness: true,
      require_claim_scope: true,
      require_claim_kind: true,
      require_ledger_resolver_fail_closed: true,
      require_redaction_manifest: true,
      require_redacted_export: true,
      require_evidence_retention_policy: true,
      require_legal_hold_blocks_disposal: true,
      require_external_storage_custody_receipts: true,
      require_proof_issue_claim_verification: true,
      require_self_attested_claim_rejection: true,
      require_durable_postgres_ledger_gate: true,
      durable_postgres_ledger_gate_id: "dojo_postgres_control_plane_self_check",
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
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
    report_schema_version: "synthi.dojo.mcpHostConformance.selfCheck.v1",
    evidence_schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
    default_report_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.json",
    default_evidence_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.evidence.json",
    artifact_requirements: {
      require_loopback_rejection: true,
      require_private_network_rejection: true,
      require_link_local_rejection: true,
      require_unique_local_ipv6_rejection: true,
      require_report_redaction: true,
    },
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
    id: "dojo_source_drift_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:source-drift:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:source-drift:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.sourceDriftEvidence.v1",
    default_evidence_path: "tmp/dojo-source-drift/dojo-source-drift.evidence.json",
    artifact_requirements: {
      require_all_source_drift_capabilities_covered: true,
      required_source_drift_capabilities: [...DOJO_SOURCE_DRIFT_CAPABILITIES],
      required_test_files: [...DOJO_SOURCE_DRIFT_TEST_FILES],
      require_release_scoped_snapshot: true,
      require_signed_snapshot_verification: true,
      require_source_content_hash: true,
      require_changed_token_expiry: true,
      require_removed_token_expiry: true,
      require_added_risky_affordance_review: true,
      require_unrelated_token_no_expiry: true,
      require_tamper_rejection: true,
      require_license_store_expiry_application: true,
      require_recertification_handoff: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_agent_ready_ui_contract_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:agent-ready-ui-contract:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:agent-ready-ui-contract:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
    default_evidence_path: "tmp/dojo-agent-ready-ui-contract/dojo-agent-ready-ui-contract.evidence.json",
    artifact_requirements: {
      require_all_agent_ready_ui_contract_capabilities_covered: true,
      required_agent_ready_ui_contract_capabilities: [...DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES],
      required_test_files: [...DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES],
      require_schema_linter: true,
      require_stable_locator: true,
      require_success_hook: true,
      require_proof_hook: true,
      require_proof_required_for_risky_action: true,
      require_accessibility_label: true,
      require_blocked_contexts: true,
      require_runtime_enum_validation: true,
      require_malformed_array_safety: true,
      require_proof_risk_mismatch_warning: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_api_tool_compiler_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:api-tool-compiler:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:api-tool-compiler:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
    default_evidence_path: "tmp/dojo-api-tool-compiler/dojo-api-tool-compiler.evidence.json",
    artifact_requirements: {
      require_all_api_tool_compiler_capabilities_covered: true,
      required_api_tool_compiler_capabilities: [...DOJO_API_TOOL_COMPILER_CAPABILITIES],
      required_test_files: [...DOJO_API_TOOL_COMPILER_TEST_FILES],
      require_reviewed_candidate: true,
      require_proof_capsule: true,
      require_license_kernel: true,
      require_idempotency: true,
      require_auth_scope: true,
      require_strict_input_schema: true,
      require_postcondition: true,
      require_evidence_write: true,
      require_graph_proof_match: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
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
      required_visual_artifact_fields: [
        "path",
        "bytes",
        "screenshot_sha256",
        "png_verified",
        "stage",
        "source",
      ],
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
    default_report_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.json",
    default_evidence_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.evidence.json",
    release_artifact_requirements: {
      ...DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS,
    },
    requires_env: [
      "SYNTHI_DOJO_MCP_HOST_URL",
      "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE",
      "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
      "SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED",
      "SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE",
      "SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING",
    ],
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
    id: "dojo_generated_pr_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:generated-pr:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:generated-pr:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.generatedPrEvidence.v1",
    default_evidence_path: "tmp/dojo-generated-pr/dojo-generated-pr.evidence.json",
    release_artifact_requirements: {
      require_all_generated_pr_capabilities_covered: true,
      required_generated_pr_capabilities: [...DOJO_GENERATED_PR_CAPABILITIES],
      required_test_files: [...DOJO_GENERATED_PR_TEST_FILES],
      require_reviewable_metadata: true,
      require_caller_supplied_code_owner_rules: true,
      require_proof_impact: true,
      require_code_owner_glob_matching: true,
      require_unsafe_branch_rejection: true,
      require_branch_plan: true,
      require_promotion_blocker: true,
      require_source_patch_bundle: true,
      require_missing_source_rejection: true,
      require_generated_contract_tests: true,
      require_patch_writer: true,
      require_path_traversal_rejection: true,
      require_duplicate_output_rejection: true,
      require_dry_run: true,
      require_stale_source_rejection: true,
      require_idempotent_write: true,
      require_branch_applier: true,
      require_file_hash_verification: true,
      require_unresolved_blocker_rejection: true,
      require_git_branch_creation: true,
      require_dirty_worktree_rejection: true,
      require_existing_branch_rejection: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_mcp_skill_bus_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:mcp-skill-bus:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:mcp-skill-bus:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
    default_evidence_path: "tmp/dojo-mcp-skill-bus/dojo-mcp-skill-bus.evidence.json",
    release_artifact_requirements: {
      require_all_mcp_skill_bus_capabilities_covered: true,
      required_mcp_skill_bus_capabilities: [...DOJO_MCP_SKILL_BUS_CAPABILITIES],
      required_test_files: [...DOJO_MCP_SKILL_BUS_TEST_FILES],
      require_certified_competency_listing: true,
      require_tenant_authorization: true,
      require_signed_manifest: true,
      require_manifest_signature_verification: true,
      require_manifest_tamper_rejection: true,
      require_manifest_production_readiness: true,
      require_version_pinning: true,
      require_ambiguous_tool_block: true,
      require_proof_validation: true,
      require_proof_consume: true,
      require_proof_binding: true,
      require_dry_run_side_effect_free: true,
      require_fail_closed: true,
      require_executor_block_propagation: true,
      require_rate_limit: true,
      require_audit_events: true,
      require_durable_registration: true,
      require_revocation: true,
      require_durable_invocation_custody: true,
      require_tenant_boundary: true,
      require_direct_call_policy: true,
      require_postgres_registry: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
    requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
  },
  {
    id: "dojo_managed_key_signing_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:managed-key-signing:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
    default_evidence_path: "tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json",
    release_artifact_requirements: {
      require_all_managed_key_signing_capabilities_covered: true,
      required_managed_key_signing_capabilities: [...DOJO_MANAGED_KEY_SIGNING_CAPABILITIES],
      required_test_files: [...DOJO_MANAGED_KEY_SIGNING_TEST_FILES],
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_managed_key_service_provider: true,
      require_managed_key_custody: true,
      require_public_verifier_material: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_public_proof_verification_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:public-proof-verification:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:public-proof-verification:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
    default_evidence_path: "tmp/dojo-public-proof-verification/dojo-public-proof-verification.evidence.json",
    release_artifact_requirements: {
      require_all_public_proof_verification_capabilities_covered: true,
      required_public_proof_verification_capabilities: [...DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES],
      required_test_files: [...DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES],
      require_external_verifier: true,
      require_ed25519_public_key: true,
      require_evidence_claim_ledger_binding: true,
      require_tamper_and_context_blocks: true,
      require_timestamp_window: true,
      require_proof_key_custody_policy: true,
      require_public_export: true,
      require_key_custody_metadata_export: true,
      require_private_secret_exclusion: true,
      require_tenant_scoped_key_export: true,
      require_unavailable_key_marking: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_self_check_executes_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_governance_lifecycle_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:governance-lifecycle:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:governance-lifecycle:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
    default_evidence_path: "tmp/dojo-governance-lifecycle/dojo-governance-lifecycle.evidence.json",
    release_artifact_requirements: {
      require_all_governance_lifecycle_capabilities_covered: true,
      required_governance_lifecycle_capabilities: [...DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES],
      required_test_files: [...DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES],
      require_license_health: true,
      require_approval_queue: true,
        require_approval_decision_audit: true,
        require_rbac: true,
        require_store_rbac: true,
        require_case_law_review: true,
      require_license_revocation: true,
      require_recertification_queue: true,
      require_policy_gates: true,
      require_audit_export: true,
      require_compliance_pack: true,
      require_proof_public_verification_custody: true,
      require_malformed_expiry_fails_closed: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_graph_runtime_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:graph-runtime:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:graph-runtime:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
    default_evidence_path: "tmp/dojo-graph-runtime/dojo-graph-runtime.evidence.json",
    release_artifact_requirements: {
      require_all_graph_runtime_capabilities_covered: true,
      required_graph_runtime_capabilities: [...DOJO_GRAPH_RUNTIME_CAPABILITIES],
      required_test_files: [...DOJO_GRAPH_RUNTIME_TEST_FILES],
      require_graph_ir_validation: true,
      require_graph_compiler: true,
      require_workflow_step_nodes: true,
      require_source_api_binding: true,
      require_production_execution: true,
      require_preflight_only: true,
      require_edge_order: true,
      require_evidence_events: true,
      require_ledger_backed_evidence: true,
      require_preconditions: true,
      require_proof_gate: true,
      require_substrate_executor: true,
      require_expiry: true,
      require_branch_runtime: true,
      require_retry_runtime: true,
      require_case_law_runtime: true,
      require_rollback_runtime: true,
      require_human_resume: true,
      require_validation_fail_closed: true,
      require_predicate_dsl: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_ghost_mode_evidence_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:ghost-mode-evidence:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:ghost-mode-evidence:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.ghostModeEvidence.v1",
    default_evidence_path: "tmp/dojo-ghost-mode-evidence/dojo-ghost-mode-evidence.evidence.json",
    release_artifact_requirements: {
      require_all_ghost_mode_capabilities_covered: true,
      required_ghost_mode_capabilities: [...DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES],
      required_test_files: [...DOJO_GHOST_MODE_EVIDENCE_TEST_FILES],
      require_non_mutating_shadow_run: true,
      require_shadow_evidence_record: true,
      require_audit_custody: true,
      require_mismatch_entrustment_block: true,
      require_compliance_pack_visibility: true,
      require_durable_shadow_evidence_store: true,
      require_tenant_boundary: true,
      require_production_mutation_rejection: true,
      require_operational_filtering: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_self_check_executes_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
    requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
  },
  {
    id: "dojo_skill_passport_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:skill-passport:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:skill-passport:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.skillPassportEvidence.v1",
    default_evidence_path: "tmp/dojo-skill-passport/dojo-skill-passport.evidence.json",
    release_artifact_requirements: {
      require_all_skill_passport_capabilities_covered: true,
      required_skill_passport_capabilities: [...DOJO_SKILL_PASSPORT_CAPABILITIES],
      required_test_files: [...DOJO_SKILL_PASSPORT_TEST_FILES],
      require_report_only_status: true,
      require_license_scope: true,
      require_readiness_scope: true,
      require_proof_scope: true,
      require_coverage_and_attack_metrics: true,
      require_executable_entrustment_provenance: true,
      require_published_tool_scope: true,
      require_skill_card_action_grouping: true,
      require_proof_badge: true,
      require_practice_guardrail_counts: true,
      require_passport_export: true,
      require_raw_payload_redaction: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_time_machine_debugger_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:time-machine-debugger:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:time-machine-debugger:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.timeMachineDebuggerEvidence.v1",
    default_evidence_path: "tmp/dojo-time-machine-debugger/dojo-time-machine-debugger.evidence.json",
    release_artifact_requirements: {
      require_all_time_machine_capabilities_covered: true,
      required_time_machine_capabilities: [...DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES],
      required_test_files: [...DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES],
      require_deterministic_debug_report: true,
      require_counterfactual_twin: true,
      require_promoted_scenario_selection: true,
      require_scenario_correlation: true,
      require_attack_guardrail_correlation: true,
      require_remediation_cost_policy: true,
      require_baseline_explanation: true,
      require_materialized_runtime_branch: true,
      require_counterfactual_license_impact: true,
      require_replay_plan: true,
      require_honest_projection_status: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_self_check_executes_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_vivarium_runtime_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:vivarium-runtime:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:vivarium-runtime:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
    default_evidence_path: "tmp/dojo-vivarium-runtime/dojo-vivarium-runtime.evidence.json",
    release_artifact_requirements: {
      require_all_vivarium_runtime_capabilities_covered: true,
      required_vivarium_runtime_capabilities: [...DOJO_VIVARIUM_RUNTIME_CAPABILITIES],
      required_test_files: [...DOJO_VIVARIUM_RUNTIME_TEST_FILES],
      require_scenario_dsl: true,
      require_synthetic_fixture_materialization: true,
      require_synthetic_only_policy: true,
      require_oracle: true,
      require_ledger_ready_oracle_evidence: true,
      require_api_fault_server: true,
      require_fake_success_state_detection: true,
      require_partial_write_detection: true,
      require_prompt_injection_quarantine: true,
      require_deterministic_reset: true,
      require_budget_enforcement: true,
      require_targeted_graph_execution: true,
      require_executable_checkride: true,
      require_license_constraints_from_blocked_risk: true,
      require_critical_guardrail_failure: true,
      require_substrate_hook_passthrough: true,
      require_evil_twin_attack_measurement: true,
      require_evil_twin_hardening_loop: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_checkride_license_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:checkride-license:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:checkride-license:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
    default_evidence_path: "tmp/dojo-checkride-license/dojo-checkride-license.evidence.json",
    release_artifact_requirements: {
      require_all_checkride_license_capabilities_covered: true,
      required_checkride_license_capabilities: [...DOJO_CHECKRIDE_LICENSE_CAPABILITIES],
      required_test_files: [...DOJO_CHECKRIDE_LICENSE_TEST_FILES],
      require_executable_checkride: true,
      require_graph_runtime: true,
      require_vivarium_oracle: true,
      require_observed_evidence: true,
      require_evidence_record: true,
      require_ledger_append: true,
      require_license_constraints: true,
      require_critical_failure_block: true,
      require_substrate_assertion: true,
      require_entrustment_policy: true,
      require_guardrail_evidence_e3: true,
      require_stale_evidence_downgrade: true,
      require_shadow_mismatch_limit: true,
      require_srl_policy: true,
      require_limited_license_srl7: true,
      require_operational_feedback_srl9: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_case_law_runtime_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:case-law-runtime:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:case-law-runtime:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
    default_evidence_path: "tmp/dojo-case-law-runtime/dojo-case-law-runtime.evidence.json",
    release_artifact_requirements: {
      require_all_case_law_runtime_capabilities_covered: true,
      required_case_law_runtime_capabilities: [...DOJO_CASE_LAW_RUNTIME_CAPABILITIES],
      required_test_files: [...DOJO_CASE_LAW_RUNTIME_TEST_FILES],
      require_case_law_registry: true,
      require_reviewed_evidence: true,
      require_proposed_cases_nonbinding: true,
      require_approved_binding_scope: true,
      require_deprecated_cases_excluded: true,
      require_guardrail_synthesis: true,
      require_explicit_predicate_preservation: true,
      require_graph_binding: true,
      require_runtime_guardrail_block: true,
      require_refusal_case_citation: true,
      require_inactive_case_suppression: true,
      require_antibody_matching: true,
      require_antibody_proposed_only: true,
      require_antibody_private_data_redaction: true,
      require_local_practice: true,
      require_local_checkride: true,
      require_deterministic_antibody_ids: true,
      require_self_check_executes_tests: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
  },
  {
    id: "dojo_hosted_runtime_gateway_self_check",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:hosted-runtime-gateway:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:hosted-runtime-gateway:self-check",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    evidence_schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
    default_evidence_path: "tmp/dojo-hosted-runtime-gateway/dojo-hosted-runtime-gateway.evidence.json",
    release_artifact_requirements: {
      require_all_hosted_runtime_gateway_capabilities_covered: true,
      required_hosted_runtime_gateway_capabilities: [...DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES],
      required_test_files: [...DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES],
      require_tenant_scoped_sessions: true,
      require_short_lived_credentials: true,
      require_stored_secret_redaction: true,
      require_origin_allowlist: true,
      require_local_network_policy: true,
      require_screenshot_redaction: true,
      require_skill_run_binding: true,
      require_audit_events: true,
      require_evidence_write: true,
      require_fail_closed_on_missing_evidence_writer: true,
      require_revocation_and_expiry: true,
      require_durable_store_production_requirement: true,
      require_postgres_session_store: true,
      require_durable_postgres_session_gate: true,
      durable_postgres_session_gate_id: "dojo_postgres_control_plane_self_check",
      require_malformed_record_rejection: true,
      require_no_failed_tests: true,
      require_no_skipped_tests: true,
      require_self_check_executes_tests: true,
      require_stdout_stderr_digest_match: true,
      require_json_report_digest_match: true,
    },
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
  "dojo_implementation_status_self_check",
  "mcp_integration_tests",
  "dojo_postgres_control_plane_self_check",
  "dojo_evidence_authority_self_check",
  "dojo_self_check",
  "dojo_mcp_host_conformance_self_check",
  "dojo_affordance_codemod_self_check",
  "dojo_source_drift_self_check",
  "dojo_agent_ready_ui_contract_self_check",
  "dojo_api_tool_compiler_self_check",
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
  "dojo_generated_pr_self_check",
  "dojo_mcp_skill_bus_self_check",
  "dojo_managed_key_signing_self_check",
  "dojo_public_proof_verification_self_check",
  "dojo_governance_lifecycle_self_check",
  "dojo_graph_runtime_self_check",
  "dojo_ghost_mode_evidence_self_check",
  "dojo_skill_passport_self_check",
  "dojo_time_machine_debugger_self_check",
  "dojo_vivarium_runtime_self_check",
  "dojo_checkride_license_self_check",
  "dojo_case_law_runtime_self_check",
  "dojo_hosted_runtime_gateway_self_check",
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
  const implementationStatusGate = gates.find((gate) => gate.id === "dojo_implementation_status_self_check");
  if (implementationStatusGate) {
    if (implementationStatusGate.evidence_schema_version !== "synthi.dojo.implementationStatusEvidence.v1") {
      errors.push("implementation_status_missing_evidence_schema");
    }
    if (implementationStatusGate.package_script !== "proof:dojo:implementation-status:self-check") {
      errors.push("implementation_status_missing_package_script");
    }
    if (!implementationStatusGate.default_evidence_path) errors.push("implementation_status_missing_default_evidence_path");
    if (!implementationStatusGate.artifact_requirements?.require_all_implementation_status_capabilities_covered) {
      errors.push("implementation_status_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_stable_vocabulary", "implementation_status_missing_vocabulary_requirement"],
      ["require_every_tool_classified", "implementation_status_missing_tool_classification_requirement"],
      ["require_machine_manifest_sync", "implementation_status_missing_manifest_sync_requirement"],
      ["require_unknown_tool_fails_planned", "implementation_status_missing_unknown_tool_requirement"],
      ["require_production_runtime_claim_boundary", "implementation_status_missing_production_boundary_requirement"],
      ["require_runtime_scope_for_executable", "implementation_status_missing_runtime_scope_requirement"],
      ["require_report_surface_no_overclaim", "implementation_status_missing_report_boundary_requirement"],
      ["require_proof_dispatch_hosted_runtime_boundary", "implementation_status_missing_proof_dispatch_boundary_requirement"],
      ["require_ghost_mode_non_mutating_boundary", "implementation_status_missing_ghost_mode_boundary_requirement"],
      ["require_control_plane_write_boundary", "implementation_status_missing_control_plane_boundary_requirement"],
      ["require_immutable_metadata", "implementation_status_missing_immutable_metadata_requirement"],
      ["require_self_check_executes_tests", "implementation_status_missing_self_check_execution_requirement"],
    ]) {
      if (!implementationStatusGate.artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredImplementationStatusCapabilities = Array.isArray(implementationStatusGate.artifact_requirements?.required_implementation_status_capabilities)
      ? implementationStatusGate.artifact_requirements.required_implementation_status_capabilities
      : [];
    const missingImplementationStatusCapabilities = DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
      .filter((capability) => !requiredImplementationStatusCapabilities.includes(capability));
    if (missingImplementationStatusCapabilities.length > 0) {
      errors.push(`implementation_status_missing_required_capabilities:${missingImplementationStatusCapabilities.join(",")}`);
    }
    const missingImplementationStatusTestFiles = missingRequiredEntries(
      DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
      implementationStatusGate.artifact_requirements?.required_test_files,
    );
    if (missingImplementationStatusTestFiles.length > 0) {
      errors.push(`implementation_status_missing_required_test_files:${missingImplementationStatusTestFiles.join(",")}`);
    }
    if (!implementationStatusGate.artifact_requirements?.require_no_skipped_tests) {
      errors.push("implementation_status_missing_no_skipped_requirement");
    }
    if (!implementationStatusGate.artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("implementation_status_missing_digest_requirement");
    }
    if (!implementationStatusGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("implementation_status_missing_json_report_digest_requirement");
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
  const evidenceAuthorityGate = gates.find((gate) => gate.id === "dojo_evidence_authority_self_check");
  if (evidenceAuthorityGate) {
    if (evidenceAuthorityGate.evidence_schema_version !== "synthi.dojo.evidenceAuthorityEvidence.v1") {
      errors.push("evidence_authority_missing_evidence_schema");
    }
    if (evidenceAuthorityGate.package_script !== "proof:dojo:evidence-authority:self-check") {
      errors.push("evidence_authority_missing_package_script");
    }
    if (!evidenceAuthorityGate.default_evidence_path) errors.push("evidence_authority_missing_default_evidence_path");
    if (!evidenceAuthorityGate.artifact_requirements?.require_all_evidence_authority_capabilities_covered) {
      errors.push("evidence_authority_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_canonical_record_hash", "evidence_authority_missing_canonical_hash_requirement"],
      ["require_record_signature_verification", "evidence_authority_missing_signature_requirement"],
      ["require_tamper_detection", "evidence_authority_missing_tamper_requirement"],
      ["require_claim_freshness", "evidence_authority_missing_claim_freshness_requirement"],
      ["require_claim_scope", "evidence_authority_missing_claim_scope_requirement"],
      ["require_claim_kind", "evidence_authority_missing_claim_kind_requirement"],
      ["require_ledger_resolver_fail_closed", "evidence_authority_missing_resolver_requirement"],
      ["require_redaction_manifest", "evidence_authority_missing_redaction_manifest_requirement"],
      ["require_redacted_export", "evidence_authority_missing_redacted_export_requirement"],
      ["require_evidence_retention_policy", "evidence_authority_missing_retention_policy_requirement"],
      ["require_legal_hold_blocks_disposal", "evidence_authority_missing_legal_hold_requirement"],
      ["require_external_storage_custody_receipts", "evidence_authority_missing_external_storage_custody_requirement"],
      ["require_proof_issue_claim_verification", "evidence_authority_missing_proof_issue_requirement"],
      ["require_self_attested_claim_rejection", "evidence_authority_missing_self_attested_rejection_requirement"],
      ["require_durable_postgres_ledger_gate", "evidence_authority_missing_durable_postgres_gate_requirement"],
      ["require_self_check_executes_tests", "evidence_authority_missing_self_check_execution_requirement"],
    ]) {
      if (!evidenceAuthorityGate.artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    if (evidenceAuthorityGate.artifact_requirements?.durable_postgres_ledger_gate_id !== "dojo_postgres_control_plane_self_check") {
      errors.push("evidence_authority_missing_durable_postgres_gate_id");
    }
    const requiredEvidenceAuthorityCapabilities = Array.isArray(evidenceAuthorityGate.artifact_requirements?.required_evidence_authority_capabilities)
      ? evidenceAuthorityGate.artifact_requirements.required_evidence_authority_capabilities
      : [];
    const missingEvidenceAuthorityCapabilities = DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
      .filter((capability) => !requiredEvidenceAuthorityCapabilities.includes(capability));
    if (missingEvidenceAuthorityCapabilities.length > 0) {
      errors.push(`evidence_authority_missing_required_capabilities:${missingEvidenceAuthorityCapabilities.join(",")}`);
    }
    const missingEvidenceAuthorityTestFiles = missingRequiredEntries(
      DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
      evidenceAuthorityGate.artifact_requirements?.required_test_files,
    );
    if (missingEvidenceAuthorityTestFiles.length > 0) {
      errors.push(`evidence_authority_missing_required_test_files:${missingEvidenceAuthorityTestFiles.join(",")}`);
    }
    if (!evidenceAuthorityGate.artifact_requirements?.require_no_skipped_tests) {
      errors.push("evidence_authority_missing_no_skipped_requirement");
    }
    if (!evidenceAuthorityGate.artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("evidence_authority_missing_digest_requirement");
    }
    if (!evidenceAuthorityGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("evidence_authority_missing_json_report_digest_requirement");
    }
  }
  const sourceDriftGate = gates.find((gate) => gate.id === "dojo_source_drift_self_check");
  if (sourceDriftGate) {
    if (sourceDriftGate.evidence_schema_version !== "synthi.dojo.sourceDriftEvidence.v1") {
      errors.push("source_drift_missing_evidence_schema");
    }
    if (sourceDriftGate.package_script !== "proof:dojo:source-drift:self-check") {
      errors.push("source_drift_missing_package_script");
    }
    if (!sourceDriftGate.default_evidence_path) errors.push("source_drift_missing_default_evidence_path");
    if (!sourceDriftGate.artifact_requirements?.require_all_source_drift_capabilities_covered) {
      errors.push("source_drift_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_release_scoped_snapshot", "source_drift_missing_release_scope_requirement"],
      ["require_signed_snapshot_verification", "source_drift_missing_signature_requirement"],
      ["require_source_content_hash", "source_drift_missing_content_hash_requirement"],
      ["require_changed_token_expiry", "source_drift_missing_changed_token_expiry_requirement"],
      ["require_removed_token_expiry", "source_drift_missing_removed_token_expiry_requirement"],
      ["require_added_risky_affordance_review", "source_drift_missing_risky_affordance_review_requirement"],
      ["require_unrelated_token_no_expiry", "source_drift_missing_unrelated_no_expiry_requirement"],
      ["require_tamper_rejection", "source_drift_missing_tamper_rejection_requirement"],
      ["require_license_store_expiry_application", "source_drift_missing_license_store_expiry_requirement"],
      ["require_recertification_handoff", "source_drift_missing_recertification_handoff_requirement"],
      ["require_self_check_executes_tests", "source_drift_missing_self_check_execution_requirement"],
    ]) {
      if (!sourceDriftGate.artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredSourceDriftCapabilities = Array.isArray(sourceDriftGate.artifact_requirements?.required_source_drift_capabilities)
      ? sourceDriftGate.artifact_requirements.required_source_drift_capabilities
      : [];
    const missingSourceDriftCapabilities = DOJO_SOURCE_DRIFT_CAPABILITIES
      .filter((capability) => !requiredSourceDriftCapabilities.includes(capability));
    if (missingSourceDriftCapabilities.length > 0) {
      errors.push(`source_drift_missing_required_capabilities:${missingSourceDriftCapabilities.join(",")}`);
    }
    const missingSourceDriftTestFiles = missingRequiredEntries(
      DOJO_SOURCE_DRIFT_TEST_FILES,
      sourceDriftGate.artifact_requirements?.required_test_files,
    );
    if (missingSourceDriftTestFiles.length > 0) {
      errors.push(`source_drift_missing_required_test_files:${missingSourceDriftTestFiles.join(",")}`);
    }
    if (!sourceDriftGate.artifact_requirements?.require_no_skipped_tests) {
      errors.push("source_drift_missing_no_skipped_requirement");
    }
    if (!sourceDriftGate.artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("source_drift_missing_digest_requirement");
    }
    if (!sourceDriftGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("source_drift_missing_json_report_digest_requirement");
    }
  }
  const agentReadyUiContractGate = gates.find((gate) => gate.id === "dojo_agent_ready_ui_contract_self_check");
  if (agentReadyUiContractGate) {
    if (agentReadyUiContractGate.evidence_schema_version !== "synthi.dojo.agentReadyUiContractEvidence.v1") {
      errors.push("agent_ready_ui_contract_missing_evidence_schema");
    }
    if (agentReadyUiContractGate.package_script !== "proof:dojo:agent-ready-ui-contract:self-check") {
      errors.push("agent_ready_ui_contract_missing_package_script");
    }
    if (!agentReadyUiContractGate.default_evidence_path) errors.push("agent_ready_ui_contract_missing_default_evidence_path");
    if (!agentReadyUiContractGate.artifact_requirements?.require_all_agent_ready_ui_contract_capabilities_covered) {
      errors.push("agent_ready_ui_contract_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_schema_linter", "agent_ready_ui_contract_missing_schema_linter_requirement"],
      ["require_stable_locator", "agent_ready_ui_contract_missing_stable_locator_requirement"],
      ["require_success_hook", "agent_ready_ui_contract_missing_success_hook_requirement"],
      ["require_proof_hook", "agent_ready_ui_contract_missing_proof_hook_requirement"],
      ["require_proof_required_for_risky_action", "agent_ready_ui_contract_missing_proof_required_requirement"],
      ["require_accessibility_label", "agent_ready_ui_contract_missing_accessibility_requirement"],
      ["require_blocked_contexts", "agent_ready_ui_contract_missing_blocked_contexts_requirement"],
      ["require_runtime_enum_validation", "agent_ready_ui_contract_missing_enum_validation_requirement"],
      ["require_malformed_array_safety", "agent_ready_ui_contract_missing_malformed_array_requirement"],
      ["require_proof_risk_mismatch_warning", "agent_ready_ui_contract_missing_mismatch_warning_requirement"],
      ["require_self_check_executes_tests", "agent_ready_ui_contract_missing_self_check_execution_requirement"],
    ]) {
      if (!agentReadyUiContractGate.artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredAgentReadyUiContractCapabilities = Array.isArray(agentReadyUiContractGate.artifact_requirements?.required_agent_ready_ui_contract_capabilities)
      ? agentReadyUiContractGate.artifact_requirements.required_agent_ready_ui_contract_capabilities
      : [];
    const missingAgentReadyUiContractCapabilities = DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
      .filter((capability) => !requiredAgentReadyUiContractCapabilities.includes(capability));
    if (missingAgentReadyUiContractCapabilities.length > 0) {
      errors.push(`agent_ready_ui_contract_missing_required_capabilities:${missingAgentReadyUiContractCapabilities.join(",")}`);
    }
    const missingAgentReadyUiContractTestFiles = missingRequiredEntries(
      DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
      agentReadyUiContractGate.artifact_requirements?.required_test_files,
    );
    if (missingAgentReadyUiContractTestFiles.length > 0) {
      errors.push(`agent_ready_ui_contract_missing_required_test_files:${missingAgentReadyUiContractTestFiles.join(",")}`);
    }
    if (!agentReadyUiContractGate.artifact_requirements?.require_no_skipped_tests) {
      errors.push("agent_ready_ui_contract_missing_no_skipped_requirement");
    }
    if (!agentReadyUiContractGate.artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("agent_ready_ui_contract_missing_digest_requirement");
    }
    if (!agentReadyUiContractGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("agent_ready_ui_contract_missing_json_report_digest_requirement");
    }
  }
  const apiToolCompilerGate = gates.find((gate) => gate.id === "dojo_api_tool_compiler_self_check");
  if (apiToolCompilerGate) {
    if (apiToolCompilerGate.evidence_schema_version !== "synthi.dojo.apiToolCompilerEvidence.v1") {
      errors.push("api_tool_compiler_missing_evidence_schema");
    }
    if (apiToolCompilerGate.package_script !== "proof:dojo:api-tool-compiler:self-check") {
      errors.push("api_tool_compiler_missing_package_script");
    }
    if (!apiToolCompilerGate.default_evidence_path) errors.push("api_tool_compiler_missing_default_evidence_path");
    if (!apiToolCompilerGate.artifact_requirements?.require_all_api_tool_compiler_capabilities_covered) {
      errors.push("api_tool_compiler_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_reviewed_candidate", "api_tool_compiler_missing_reviewed_candidate_requirement"],
      ["require_proof_capsule", "api_tool_compiler_missing_proof_requirement"],
      ["require_license_kernel", "api_tool_compiler_missing_license_requirement"],
      ["require_idempotency", "api_tool_compiler_missing_idempotency_requirement"],
      ["require_auth_scope", "api_tool_compiler_missing_auth_scope_requirement"],
      ["require_strict_input_schema", "api_tool_compiler_missing_strict_schema_requirement"],
      ["require_postcondition", "api_tool_compiler_missing_postcondition_requirement"],
      ["require_evidence_write", "api_tool_compiler_missing_evidence_requirement"],
      ["require_graph_proof_match", "api_tool_compiler_missing_graph_proof_requirement"],
      ["require_self_check_executes_tests", "api_tool_compiler_missing_self_check_execution_requirement"],
    ]) {
      if (!apiToolCompilerGate.artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredApiToolCompilerCapabilities = Array.isArray(apiToolCompilerGate.artifact_requirements?.required_api_tool_compiler_capabilities)
      ? apiToolCompilerGate.artifact_requirements.required_api_tool_compiler_capabilities
      : [];
    const missingApiToolCompilerCapabilities = DOJO_API_TOOL_COMPILER_CAPABILITIES
      .filter((capability) => !requiredApiToolCompilerCapabilities.includes(capability));
    if (missingApiToolCompilerCapabilities.length > 0) {
      errors.push(`api_tool_compiler_missing_required_capabilities:${missingApiToolCompilerCapabilities.join(",")}`);
    }
    const missingApiToolCompilerTestFiles = missingRequiredEntries(
      DOJO_API_TOOL_COMPILER_TEST_FILES,
      apiToolCompilerGate.artifact_requirements?.required_test_files,
    );
    if (missingApiToolCompilerTestFiles.length > 0) {
      errors.push(`api_tool_compiler_missing_required_test_files:${missingApiToolCompilerTestFiles.join(",")}`);
    }
    if (!apiToolCompilerGate.artifact_requirements?.require_no_skipped_tests) {
      errors.push("api_tool_compiler_missing_no_skipped_requirement");
    }
    if (!apiToolCompilerGate.artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("api_tool_compiler_missing_digest_requirement");
    }
    if (!apiToolCompilerGate.artifact_requirements?.require_json_report_digest_match) {
      errors.push("api_tool_compiler_missing_json_report_digest_requirement");
    }
  }
  const generatedPrGate = gates.find((gate) => gate.id === "dojo_generated_pr_self_check");
  if (generatedPrGate) {
    if (generatedPrGate.evidence_schema_version !== "synthi.dojo.generatedPrEvidence.v1") {
      errors.push("generated_pr_missing_evidence_schema");
    }
    if (generatedPrGate.package_script !== "proof:dojo:generated-pr:self-check") {
      errors.push("generated_pr_missing_package_script");
    }
    if (!generatedPrGate.default_evidence_path) errors.push("generated_pr_missing_default_evidence_path");
    if (!generatedPrGate.release_artifact_requirements?.require_all_generated_pr_capabilities_covered) {
      errors.push("generated_pr_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_reviewable_metadata", "generated_pr_missing_reviewable_metadata_requirement"],
      ["require_caller_supplied_code_owner_rules", "generated_pr_missing_code_owner_requirement"],
      ["require_proof_impact", "generated_pr_missing_proof_impact_requirement"],
      ["require_code_owner_glob_matching", "generated_pr_missing_code_owner_glob_requirement"],
      ["require_unsafe_branch_rejection", "generated_pr_missing_unsafe_branch_requirement"],
      ["require_branch_plan", "generated_pr_missing_branch_plan_requirement"],
      ["require_promotion_blocker", "generated_pr_missing_promotion_blocker_requirement"],
      ["require_source_patch_bundle", "generated_pr_missing_source_patch_bundle_requirement"],
      ["require_missing_source_rejection", "generated_pr_missing_missing_source_requirement"],
      ["require_generated_contract_tests", "generated_pr_missing_contract_tests_requirement"],
      ["require_patch_writer", "generated_pr_missing_patch_writer_requirement"],
      ["require_path_traversal_rejection", "generated_pr_missing_path_traversal_requirement"],
      ["require_duplicate_output_rejection", "generated_pr_missing_duplicate_output_requirement"],
      ["require_dry_run", "generated_pr_missing_dry_run_requirement"],
      ["require_stale_source_rejection", "generated_pr_missing_stale_source_requirement"],
      ["require_idempotent_write", "generated_pr_missing_idempotent_write_requirement"],
      ["require_branch_applier", "generated_pr_missing_branch_applier_requirement"],
      ["require_file_hash_verification", "generated_pr_missing_file_hash_requirement"],
      ["require_unresolved_blocker_rejection", "generated_pr_missing_unresolved_blocker_requirement"],
      ["require_git_branch_creation", "generated_pr_missing_git_branch_requirement"],
      ["require_dirty_worktree_rejection", "generated_pr_missing_dirty_worktree_requirement"],
      ["require_existing_branch_rejection", "generated_pr_missing_existing_branch_requirement"],
      ["require_self_check_executes_tests", "generated_pr_missing_self_check_execution_requirement"],
    ]) {
      if (!generatedPrGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredGeneratedPrCapabilities = Array.isArray(generatedPrGate.release_artifact_requirements?.required_generated_pr_capabilities)
      ? generatedPrGate.release_artifact_requirements.required_generated_pr_capabilities
      : [];
    const missingGeneratedPrCapabilities = DOJO_GENERATED_PR_CAPABILITIES
      .filter((capability) => !requiredGeneratedPrCapabilities.includes(capability));
    if (missingGeneratedPrCapabilities.length > 0) {
      errors.push(`generated_pr_missing_required_capabilities:${missingGeneratedPrCapabilities.join(",")}`);
    }
    const missingGeneratedPrTestFiles = missingRequiredEntries(
      DOJO_GENERATED_PR_TEST_FILES,
      generatedPrGate.release_artifact_requirements?.required_test_files,
    );
    if (missingGeneratedPrTestFiles.length > 0) {
      errors.push(`generated_pr_missing_required_test_files:${missingGeneratedPrTestFiles.join(",")}`);
    }
    if (!generatedPrGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("generated_pr_missing_no_skipped_requirement");
    }
    if (!generatedPrGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("generated_pr_missing_digest_requirement");
    }
    if (!generatedPrGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("generated_pr_missing_json_report_digest_requirement");
    }
  }
  const mcpSkillBusGate = gates.find((gate) => gate.id === "dojo_mcp_skill_bus_self_check");
  if (mcpSkillBusGate) {
    if (mcpSkillBusGate.evidence_schema_version !== "synthi.dojo.mcpSkillBusEvidence.v1") {
      errors.push("mcp_skill_bus_missing_evidence_schema");
    }
    if (mcpSkillBusGate.package_script !== "proof:dojo:mcp-skill-bus:self-check") {
      errors.push("mcp_skill_bus_missing_package_script");
    }
    if (!mcpSkillBusGate.default_evidence_path) errors.push("mcp_skill_bus_missing_default_evidence_path");
    if (!mcpSkillBusGate.release_artifact_requirements?.require_all_mcp_skill_bus_capabilities_covered) {
      errors.push("mcp_skill_bus_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_certified_competency_listing", "mcp_skill_bus_missing_competency_listing_requirement"],
      ["require_tenant_authorization", "mcp_skill_bus_missing_tenant_authorization_requirement"],
      ["require_signed_manifest", "mcp_skill_bus_missing_signed_manifest_requirement"],
      ["require_manifest_signature_verification", "mcp_skill_bus_missing_manifest_signature_requirement"],
      ["require_manifest_tamper_rejection", "mcp_skill_bus_missing_manifest_tamper_requirement"],
      ["require_manifest_production_readiness", "mcp_skill_bus_missing_manifest_readiness_requirement"],
      ["require_version_pinning", "mcp_skill_bus_missing_version_pinning_requirement"],
      ["require_ambiguous_tool_block", "mcp_skill_bus_missing_ambiguous_tool_requirement"],
      ["require_proof_validation", "mcp_skill_bus_missing_proof_validation_requirement"],
      ["require_proof_consume", "mcp_skill_bus_missing_proof_consume_requirement"],
      ["require_proof_binding", "mcp_skill_bus_missing_proof_binding_requirement"],
      ["require_dry_run_side_effect_free", "mcp_skill_bus_missing_dry_run_requirement"],
      ["require_fail_closed", "mcp_skill_bus_missing_fail_closed_requirement"],
      ["require_executor_block_propagation", "mcp_skill_bus_missing_executor_block_requirement"],
      ["require_rate_limit", "mcp_skill_bus_missing_rate_limit_requirement"],
      ["require_audit_events", "mcp_skill_bus_missing_audit_requirement"],
      ["require_durable_registration", "mcp_skill_bus_missing_durable_registration_requirement"],
      ["require_revocation", "mcp_skill_bus_missing_revocation_requirement"],
      ["require_durable_invocation_custody", "mcp_skill_bus_missing_invocation_custody_requirement"],
      ["require_tenant_boundary", "mcp_skill_bus_missing_tenant_boundary_requirement"],
      ["require_direct_call_policy", "mcp_skill_bus_missing_direct_call_policy_requirement"],
      ["require_postgres_registry", "mcp_skill_bus_missing_postgres_registry_requirement"],
      ["require_self_check_executes_tests", "mcp_skill_bus_missing_self_check_execution_requirement"],
    ]) {
      if (!mcpSkillBusGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredMcpSkillBusCapabilities = Array.isArray(mcpSkillBusGate.release_artifact_requirements?.required_mcp_skill_bus_capabilities)
      ? mcpSkillBusGate.release_artifact_requirements.required_mcp_skill_bus_capabilities
      : [];
    const missingMcpSkillBusCapabilities = DOJO_MCP_SKILL_BUS_CAPABILITIES
      .filter((capability) => !requiredMcpSkillBusCapabilities.includes(capability));
    if (missingMcpSkillBusCapabilities.length > 0) {
      errors.push(`mcp_skill_bus_missing_required_capabilities:${missingMcpSkillBusCapabilities.join(",")}`);
    }
    const missingMcpSkillBusTestFiles = missingRequiredEntries(
      DOJO_MCP_SKILL_BUS_TEST_FILES,
      mcpSkillBusGate.release_artifact_requirements?.required_test_files,
    );
    if (missingMcpSkillBusTestFiles.length > 0) {
      errors.push(`mcp_skill_bus_missing_required_test_files:${missingMcpSkillBusTestFiles.join(",")}`);
    }
    if (!mcpSkillBusGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("mcp_skill_bus_missing_no_skipped_requirement");
    }
    if (!mcpSkillBusGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("mcp_skill_bus_missing_digest_requirement");
    }
    if (!mcpSkillBusGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("mcp_skill_bus_missing_json_report_digest_requirement");
    }
    if (!Array.isArray(mcpSkillBusGate.requires_env)
      || !mcpSkillBusGate.requires_env.includes("SYNTHI_DOJO_POSTGRES_TEST_URL")) {
      errors.push("mcp_skill_bus_missing_postgres_env");
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
  const mcpHostConformanceSelfCheckGate = gates.find((gate) => gate.id === "dojo_mcp_host_conformance_self_check");
  if (mcpHostConformanceSelfCheckGate) {
    if (mcpHostConformanceSelfCheckGate.report_schema_version !== "synthi.dojo.mcpHostConformance.selfCheck.v1") {
      errors.push("mcp_host_conformance_self_check_missing_report_schema");
    }
    if (mcpHostConformanceSelfCheckGate.evidence_schema_version !== "synthi.dojo.mcpHostConformanceEvidence.v1") {
      errors.push("mcp_host_conformance_self_check_missing_evidence_schema");
    }
    if (!mcpHostConformanceSelfCheckGate.default_report_path) errors.push("mcp_host_conformance_self_check_missing_report_path");
    if (!mcpHostConformanceSelfCheckGate.default_evidence_path) errors.push("mcp_host_conformance_self_check_missing_evidence_path");
    for (const [requirement, errorCode] of [
      ["require_loopback_rejection", "mcp_host_conformance_self_check_missing_loopback_rejection"],
      ["require_private_network_rejection", "mcp_host_conformance_self_check_missing_private_network_rejection"],
      ["require_link_local_rejection", "mcp_host_conformance_self_check_missing_link_local_rejection"],
      ["require_unique_local_ipv6_rejection", "mcp_host_conformance_self_check_missing_unique_local_ipv6_rejection"],
      ["require_report_redaction", "mcp_host_conformance_self_check_missing_report_redaction"],
    ]) {
      if (!mcpHostConformanceSelfCheckGate.artifact_requirements?.[requirement]) {
        errors.push(errorCode);
      }
    }
  }
  if (mcpHostConformanceGate) {
    if (mcpHostConformanceGate.report_schema_version !== "synthi.dojo.mcpHostConformance.v1") {
      errors.push("mcp_host_conformance_missing_release_report_schema");
    }
    if (mcpHostConformanceGate.evidence_schema_version !== "synthi.dojo.mcpHostConformanceEvidence.v1") {
      errors.push("mcp_host_conformance_missing_evidence_schema");
    }
    if (!mcpHostConformanceGate.default_report_path) errors.push("mcp_host_conformance_missing_default_report_path");
    if (!mcpHostConformanceGate.default_evidence_path) errors.push("mcp_host_conformance_missing_default_evidence_path");
    if (mcpHostConformanceSelfCheckGate?.default_report_path === mcpHostConformanceGate.default_report_path) {
      errors.push("mcp_host_conformance_default_report_path_conflicts_self_check");
    }
    if (mcpHostConformanceSelfCheckGate?.default_evidence_path === mcpHostConformanceGate.default_evidence_path) {
      errors.push("mcp_host_conformance_default_evidence_path_conflicts_self_check");
    }
    if (!mcpHostConformanceGate.release_artifact_requirements?.require_production_execution) {
      errors.push("mcp_host_conformance_missing_production_execution_requirement");
    }
    if (!mcpHostConformanceGate.release_artifact_requirements?.require_non_loopback_mcp_host) {
      errors.push("mcp_host_conformance_missing_non_loopback_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_public_non_local_mcp_host", "mcp_host_conformance_missing_public_non_local_requirement"],
      ["require_raw_backing_tool_block", "mcp_host_conformance_missing_raw_backing_tool_requirement"],
      ["require_revocation_propagation", "mcp_host_conformance_missing_revocation_requirement"],
      ["require_external_control_plane_store", "mcp_host_conformance_missing_external_store_requirement"],
      ["require_external_proof_signing", "mcp_host_conformance_missing_external_signing_requirement"],
      ["require_bridge_token", "mcp_host_conformance_missing_bridge_token_requirement"],
      ["require_no_local_cdp", "mcp_host_conformance_missing_no_local_cdp_requirement"],
      ["require_licensed_skill_filtering", "mcp_host_conformance_missing_licensed_skill_filtering_requirement"],
    ]) {
      if (!mcpHostConformanceGate.release_artifact_requirements?.[requirement]) {
        errors.push(errorCode);
      }
    }
    for (const requiredEnv of [
      "SYNTHI_DOJO_MCP_HOST_URL",
      "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE",
      "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
      "SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED",
      "SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE",
      "SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING",
    ]) {
      if (!Array.isArray(mcpHostConformanceGate.requires_env) || !mcpHostConformanceGate.requires_env.includes(requiredEnv)) {
        errors.push(`mcp_host_conformance_missing_env:${requiredEnv}`);
      }
    }
    const missingScriptFlags = missingRequiredPackageScriptTokens(packageScripts, mcpHostConformanceGate, [
      "--out-dir",
      "tmp/dojo-mcp-host-conformance-live",
      "--require-non-loopback-mcp-host",
      "--execute-production",
      "--require-external-control-plane-store",
      "--require-external-proof-signing",
      "--require-bridge-token",
      "--require-no-local-cdp",
      "--require-licensed-skill-filtering",
    ]);
    if (missingScriptFlags.length > 0) {
      errors.push(`mcp_host_conformance_package_script_missing_flags:${missingScriptFlags.join(",")}`);
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
    if (!gate.release_artifact_requirements?.require_no_local_attach) {
      errors.push(`private_tool_host_conformance_missing_no_local_attach:${gate.id}`);
    }
    if (!gate.release_artifact_requirements?.require_private_tool_call) {
      errors.push(`private_tool_host_conformance_missing_private_tool_call:${gate.id}`);
    }
    if (!Array.isArray(gate.requires_env) || !gate.requires_env.includes("SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE")) {
      errors.push(`private_tool_host_conformance_missing_store_env:${gate.id}`);
    }
    if (!Array.isArray(gate.requires_env) || !gate.requires_env.includes("SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL")) {
      errors.push(`private_tool_host_conformance_missing_target_env:${gate.id}`);
    }
    const requiredScriptFlags = gate.id === "private_tool_stdio_host_conformance"
      ? ["--require-custom-mcp-command", "--require-non-loopback-runtime", "--require-external-private-tool-store"]
      : ["--require-non-loopback-runtime", "--require-external-private-tool-store"];
    const missingScriptFlags = missingRequiredPackageScriptTokens(packageScripts, gate, requiredScriptFlags);
    if (missingScriptFlags.length > 0) {
      errors.push(`private_tool_host_conformance_package_script_missing_flags:${gate.id}:${missingScriptFlags.join(",")}`);
    }
  }
  const managedKeySigningGate = gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check");
  if (managedKeySigningGate) {
    if (managedKeySigningGate.evidence_schema_version !== "synthi.dojo.managedKeySigningEvidence.v1") {
      errors.push("managed_key_signing_missing_evidence_schema");
    }
    if (managedKeySigningGate.package_script !== "proof:dojo:managed-key-signing:self-check") {
      errors.push("managed_key_signing_missing_package_script");
    }
    if (!managedKeySigningGate.default_evidence_path) errors.push("managed_key_signing_missing_default_evidence_path");
    if (!managedKeySigningGate.release_artifact_requirements?.require_all_managed_key_signing_capabilities_covered) {
      errors.push("managed_key_signing_missing_capability_requirement");
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_managed_key_service_provider) {
      errors.push("managed_key_signing_missing_provider_requirement");
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_managed_key_custody) {
      errors.push("managed_key_signing_missing_custody_requirement");
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_public_verifier_material) {
      errors.push("managed_key_signing_missing_public_verifier_requirement");
    }
    const requiredManagedKeySigningCapabilities = Array.isArray(managedKeySigningGate.release_artifact_requirements?.required_managed_key_signing_capabilities)
      ? managedKeySigningGate.release_artifact_requirements.required_managed_key_signing_capabilities
      : [];
    const missingManagedKeySigningCapabilities = DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
      .filter((capability) => !requiredManagedKeySigningCapabilities.includes(capability));
    if (missingManagedKeySigningCapabilities.length > 0) {
      errors.push(`managed_key_signing_missing_required_capabilities:${missingManagedKeySigningCapabilities.join(",")}`);
    }
    const missingManagedKeySigningTestFiles = missingRequiredEntries(
      DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
      managedKeySigningGate.release_artifact_requirements?.required_test_files,
    );
    if (missingManagedKeySigningTestFiles.length > 0) {
      errors.push(`managed_key_signing_missing_required_test_files:${missingManagedKeySigningTestFiles.join(",")}`);
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("managed_key_signing_missing_no_skipped_requirement");
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("managed_key_signing_missing_digest_requirement");
    }
    if (!managedKeySigningGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("managed_key_signing_missing_json_report_digest_requirement");
    }
  }
  const publicProofVerificationGate = gates.find((gate) => gate.id === "dojo_public_proof_verification_self_check");
  if (publicProofVerificationGate) {
    if (publicProofVerificationGate.evidence_schema_version !== "synthi.dojo.publicProofVerificationEvidence.v1") {
      errors.push("public_proof_missing_evidence_schema");
    }
    if (publicProofVerificationGate.package_script !== "proof:dojo:public-proof-verification:self-check") {
      errors.push("public_proof_missing_package_script");
    }
    if (!publicProofVerificationGate.default_evidence_path) errors.push("public_proof_missing_default_evidence_path");
    if (!publicProofVerificationGate.release_artifact_requirements?.require_all_public_proof_verification_capabilities_covered) {
      errors.push("public_proof_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_external_verifier", "public_proof_missing_external_verifier_requirement"],
      ["require_ed25519_public_key", "public_proof_missing_ed25519_requirement"],
      ["require_evidence_claim_ledger_binding", "public_proof_missing_evidence_claim_requirement"],
      ["require_tamper_and_context_blocks", "public_proof_missing_tamper_requirement"],
      ["require_timestamp_window", "public_proof_missing_timestamp_requirement"],
      ["require_proof_key_custody_policy", "public_proof_missing_custody_requirement"],
      ["require_public_export", "public_proof_missing_export_requirement"],
      ["require_key_custody_metadata_export", "public_proof_missing_key_custody_metadata_export_requirement"],
      ["require_private_secret_exclusion", "public_proof_missing_secret_exclusion_requirement"],
      ["require_tenant_scoped_key_export", "public_proof_missing_tenant_export_requirement"],
      ["require_unavailable_key_marking", "public_proof_missing_unavailable_key_requirement"],
      ["require_self_check_executes_tests", "public_proof_missing_self_check_execution_requirement"],
    ]) {
      if (!publicProofVerificationGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredPublicProofCapabilities = Array.isArray(publicProofVerificationGate.release_artifact_requirements?.required_public_proof_verification_capabilities)
      ? publicProofVerificationGate.release_artifact_requirements.required_public_proof_verification_capabilities
      : [];
    const missingPublicProofCapabilities = DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
      .filter((capability) => !requiredPublicProofCapabilities.includes(capability));
    if (missingPublicProofCapabilities.length > 0) {
      errors.push(`public_proof_missing_required_capabilities:${missingPublicProofCapabilities.join(",")}`);
    }
    const missingPublicProofTestFiles = missingRequiredEntries(
      DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
      publicProofVerificationGate.release_artifact_requirements?.required_test_files,
    );
    if (missingPublicProofTestFiles.length > 0) {
      errors.push(`public_proof_missing_required_test_files:${missingPublicProofTestFiles.join(",")}`);
    }
    if (!publicProofVerificationGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("public_proof_missing_no_skipped_requirement");
    }
    if (!publicProofVerificationGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("public_proof_missing_digest_requirement");
    }
    if (!publicProofVerificationGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("public_proof_missing_json_report_digest_requirement");
    }
  }
  const governanceLifecycleGate = gates.find((gate) => gate.id === "dojo_governance_lifecycle_self_check");
  if (governanceLifecycleGate) {
    if (governanceLifecycleGate.evidence_schema_version !== "synthi.dojo.governanceLifecycleEvidence.v1") {
      errors.push("governance_lifecycle_missing_evidence_schema");
    }
    if (governanceLifecycleGate.package_script !== "proof:dojo:governance-lifecycle:self-check") {
      errors.push("governance_lifecycle_missing_package_script");
    }
    if (!governanceLifecycleGate.default_evidence_path) errors.push("governance_lifecycle_missing_default_evidence_path");
    if (!governanceLifecycleGate.release_artifact_requirements?.require_all_governance_lifecycle_capabilities_covered) {
      errors.push("governance_lifecycle_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_license_health", "governance_lifecycle_missing_license_health_requirement"],
      ["require_approval_queue", "governance_lifecycle_missing_approval_queue_requirement"],
        ["require_approval_decision_audit", "governance_lifecycle_missing_approval_audit_requirement"],
        ["require_rbac", "governance_lifecycle_missing_rbac_requirement"],
        ["require_store_rbac", "governance_lifecycle_missing_store_rbac_requirement"],
        ["require_case_law_review", "governance_lifecycle_missing_case_law_review_requirement"],
      ["require_license_revocation", "governance_lifecycle_missing_license_revocation_requirement"],
      ["require_recertification_queue", "governance_lifecycle_missing_recertification_requirement"],
      ["require_policy_gates", "governance_lifecycle_missing_policy_gates_requirement"],
      ["require_audit_export", "governance_lifecycle_missing_audit_export_requirement"],
      ["require_compliance_pack", "governance_lifecycle_missing_compliance_pack_requirement"],
      ["require_proof_public_verification_custody", "governance_lifecycle_missing_public_verification_requirement"],
      ["require_malformed_expiry_fails_closed", "governance_lifecycle_missing_malformed_expiry_requirement"],
      ["require_self_check_executes_tests", "governance_lifecycle_missing_self_check_execution_requirement"],
    ]) {
      if (!governanceLifecycleGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredGovernanceCapabilities = Array.isArray(governanceLifecycleGate.release_artifact_requirements?.required_governance_lifecycle_capabilities)
      ? governanceLifecycleGate.release_artifact_requirements.required_governance_lifecycle_capabilities
      : [];
    const missingGovernanceCapabilities = DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
      .filter((capability) => !requiredGovernanceCapabilities.includes(capability));
    if (missingGovernanceCapabilities.length > 0) {
      errors.push(`governance_lifecycle_missing_required_capabilities:${missingGovernanceCapabilities.join(",")}`);
    }
    const missingGovernanceTestFiles = missingRequiredEntries(
      DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
      governanceLifecycleGate.release_artifact_requirements?.required_test_files,
    );
    if (missingGovernanceTestFiles.length > 0) {
      errors.push(`governance_lifecycle_missing_required_test_files:${missingGovernanceTestFiles.join(",")}`);
    }
    if (!governanceLifecycleGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("governance_lifecycle_missing_no_skipped_requirement");
    }
    if (!governanceLifecycleGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("governance_lifecycle_missing_digest_requirement");
    }
    if (!governanceLifecycleGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("governance_lifecycle_missing_json_report_digest_requirement");
    }
  }
  const graphRuntimeGate = gates.find((gate) => gate.id === "dojo_graph_runtime_self_check");
  if (graphRuntimeGate) {
    if (graphRuntimeGate.evidence_schema_version !== "synthi.dojo.graphRuntimeEvidence.v1") {
      errors.push("graph_runtime_missing_evidence_schema");
    }
    if (graphRuntimeGate.package_script !== "proof:dojo:graph-runtime:self-check") {
      errors.push("graph_runtime_missing_package_script");
    }
    if (!graphRuntimeGate.default_evidence_path) errors.push("graph_runtime_missing_default_evidence_path");
    if (!graphRuntimeGate.release_artifact_requirements?.require_all_graph_runtime_capabilities_covered) {
      errors.push("graph_runtime_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_graph_ir_validation", "graph_runtime_missing_ir_validation_requirement"],
      ["require_graph_compiler", "graph_runtime_missing_compiler_requirement"],
      ["require_workflow_step_nodes", "graph_runtime_missing_workflow_step_nodes_requirement"],
      ["require_source_api_binding", "graph_runtime_missing_source_api_requirement"],
      ["require_production_execution", "graph_runtime_missing_production_execution_requirement"],
      ["require_preflight_only", "graph_runtime_missing_preflight_requirement"],
      ["require_edge_order", "graph_runtime_missing_edge_order_requirement"],
      ["require_evidence_events", "graph_runtime_missing_evidence_events_requirement"],
      ["require_ledger_backed_evidence", "graph_runtime_missing_ledger_evidence_requirement"],
      ["require_preconditions", "graph_runtime_missing_precondition_requirement"],
      ["require_proof_gate", "graph_runtime_missing_proof_gate_requirement"],
      ["require_substrate_executor", "graph_runtime_missing_substrate_requirement"],
      ["require_expiry", "graph_runtime_missing_expiry_requirement"],
      ["require_branch_runtime", "graph_runtime_missing_branch_requirement"],
      ["require_retry_runtime", "graph_runtime_missing_retry_requirement"],
      ["require_case_law_runtime", "graph_runtime_missing_case_law_requirement"],
      ["require_rollback_runtime", "graph_runtime_missing_rollback_requirement"],
      ["require_human_resume", "graph_runtime_missing_human_resume_requirement"],
      ["require_validation_fail_closed", "graph_runtime_missing_validation_fail_closed_requirement"],
      ["require_predicate_dsl", "graph_runtime_missing_predicate_dsl_requirement"],
      ["require_self_check_executes_tests", "graph_runtime_missing_self_check_execution_requirement"],
    ]) {
      if (!graphRuntimeGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredGraphRuntimeCapabilities = Array.isArray(graphRuntimeGate.release_artifact_requirements?.required_graph_runtime_capabilities)
      ? graphRuntimeGate.release_artifact_requirements.required_graph_runtime_capabilities
      : [];
    const missingGraphRuntimeCapabilities = DOJO_GRAPH_RUNTIME_CAPABILITIES
      .filter((capability) => !requiredGraphRuntimeCapabilities.includes(capability));
    if (missingGraphRuntimeCapabilities.length > 0) {
      errors.push(`graph_runtime_missing_required_capabilities:${missingGraphRuntimeCapabilities.join(",")}`);
    }
    const missingGraphRuntimeTestFiles = missingRequiredEntries(
      DOJO_GRAPH_RUNTIME_TEST_FILES,
      graphRuntimeGate.release_artifact_requirements?.required_test_files,
    );
    if (missingGraphRuntimeTestFiles.length > 0) {
      errors.push(`graph_runtime_missing_required_test_files:${missingGraphRuntimeTestFiles.join(",")}`);
    }
    if (!graphRuntimeGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("graph_runtime_missing_no_skipped_requirement");
    }
    if (!graphRuntimeGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("graph_runtime_missing_digest_requirement");
    }
    if (!graphRuntimeGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("graph_runtime_missing_json_report_digest_requirement");
    }
  }
  const ghostModeGate = gates.find((gate) => gate.id === "dojo_ghost_mode_evidence_self_check");
  if (ghostModeGate) {
    if (ghostModeGate.evidence_schema_version !== "synthi.dojo.ghostModeEvidence.v1") {
      errors.push("ghost_mode_missing_evidence_schema");
    }
    if (ghostModeGate.package_script !== "proof:dojo:ghost-mode-evidence:self-check") {
      errors.push("ghost_mode_missing_package_script");
    }
    if (!ghostModeGate.default_evidence_path) errors.push("ghost_mode_missing_default_evidence_path");
    if (!ghostModeGate.release_artifact_requirements?.require_all_ghost_mode_capabilities_covered) {
      errors.push("ghost_mode_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_non_mutating_shadow_run", "ghost_mode_missing_non_mutating_requirement"],
      ["require_shadow_evidence_record", "ghost_mode_missing_shadow_evidence_requirement"],
      ["require_audit_custody", "ghost_mode_missing_audit_requirement"],
      ["require_mismatch_entrustment_block", "ghost_mode_missing_entrustment_block_requirement"],
      ["require_compliance_pack_visibility", "ghost_mode_missing_compliance_requirement"],
      ["require_durable_shadow_evidence_store", "ghost_mode_missing_durable_store_requirement"],
      ["require_tenant_boundary", "ghost_mode_missing_tenant_boundary_requirement"],
      ["require_production_mutation_rejection", "ghost_mode_missing_mutation_rejection_requirement"],
      ["require_operational_filtering", "ghost_mode_missing_filtering_requirement"],
      ["require_self_check_executes_tests", "ghost_mode_missing_self_check_execution_requirement"],
    ]) {
      if (!ghostModeGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredGhostModeCapabilities = Array.isArray(ghostModeGate.release_artifact_requirements?.required_ghost_mode_capabilities)
      ? ghostModeGate.release_artifact_requirements.required_ghost_mode_capabilities
      : [];
    const missingGhostModeCapabilities = DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
      .filter((capability) => !requiredGhostModeCapabilities.includes(capability));
    if (missingGhostModeCapabilities.length > 0) {
      errors.push(`ghost_mode_missing_required_capabilities:${missingGhostModeCapabilities.join(",")}`);
    }
    const missingGhostModeTestFiles = missingRequiredEntries(
      DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
      ghostModeGate.release_artifact_requirements?.required_test_files,
    );
    if (missingGhostModeTestFiles.length > 0) {
      errors.push(`ghost_mode_missing_required_test_files:${missingGhostModeTestFiles.join(",")}`);
    }
    if (!ghostModeGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("ghost_mode_missing_no_skipped_requirement");
    }
    if (!ghostModeGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("ghost_mode_missing_digest_requirement");
    }
    if (!ghostModeGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("ghost_mode_missing_json_report_digest_requirement");
    }
    if (!Array.isArray(ghostModeGate.requires_env)
      || !ghostModeGate.requires_env.includes("SYNTHI_DOJO_POSTGRES_TEST_URL")) {
      errors.push("ghost_mode_missing_postgres_env");
    }
  }
  const skillPassportGate = gates.find((gate) => gate.id === "dojo_skill_passport_self_check");
  if (skillPassportGate) {
    if (skillPassportGate.evidence_schema_version !== "synthi.dojo.skillPassportEvidence.v1") {
      errors.push("skill_passport_missing_evidence_schema");
    }
    if (skillPassportGate.package_script !== "proof:dojo:skill-passport:self-check") {
      errors.push("skill_passport_missing_package_script");
    }
    if (!skillPassportGate.default_evidence_path) errors.push("skill_passport_missing_default_evidence_path");
    if (!skillPassportGate.release_artifact_requirements?.require_all_skill_passport_capabilities_covered) {
      errors.push("skill_passport_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_report_only_status", "skill_passport_missing_report_only_requirement"],
      ["require_license_scope", "skill_passport_missing_license_scope_requirement"],
      ["require_readiness_scope", "skill_passport_missing_readiness_scope_requirement"],
      ["require_proof_scope", "skill_passport_missing_proof_scope_requirement"],
      ["require_coverage_and_attack_metrics", "skill_passport_missing_coverage_attack_requirement"],
      ["require_executable_entrustment_provenance", "skill_passport_missing_executable_entrustment_requirement"],
      ["require_published_tool_scope", "skill_passport_missing_published_tool_requirement"],
      ["require_skill_card_action_grouping", "skill_passport_missing_action_grouping_requirement"],
      ["require_proof_badge", "skill_passport_missing_proof_badge_requirement"],
      ["require_practice_guardrail_counts", "skill_passport_missing_practice_guardrail_requirement"],
      ["require_passport_export", "skill_passport_missing_export_requirement"],
      ["require_raw_payload_redaction", "skill_passport_missing_redaction_requirement"],
      ["require_self_check_executes_tests", "skill_passport_missing_self_check_execution_requirement"],
    ]) {
      if (!skillPassportGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredSkillPassportCapabilities = Array.isArray(skillPassportGate.release_artifact_requirements?.required_skill_passport_capabilities)
      ? skillPassportGate.release_artifact_requirements.required_skill_passport_capabilities
      : [];
    const missingSkillPassportCapabilities = DOJO_SKILL_PASSPORT_CAPABILITIES
      .filter((capability) => !requiredSkillPassportCapabilities.includes(capability));
    if (missingSkillPassportCapabilities.length > 0) {
      errors.push(`skill_passport_missing_required_capabilities:${missingSkillPassportCapabilities.join(",")}`);
    }
    const missingSkillPassportTestFiles = missingRequiredEntries(
      DOJO_SKILL_PASSPORT_TEST_FILES,
      skillPassportGate.release_artifact_requirements?.required_test_files,
    );
    if (missingSkillPassportTestFiles.length > 0) {
      errors.push(`skill_passport_missing_required_test_files:${missingSkillPassportTestFiles.join(",")}`);
    }
    if (!skillPassportGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("skill_passport_missing_no_skipped_requirement");
    }
    if (!skillPassportGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("skill_passport_missing_digest_requirement");
    }
    if (!skillPassportGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("skill_passport_missing_json_report_digest_requirement");
    }
  }
  const timeMachineGate = gates.find((gate) => gate.id === "dojo_time_machine_debugger_self_check");
  if (timeMachineGate) {
    if (timeMachineGate.evidence_schema_version !== "synthi.dojo.timeMachineDebuggerEvidence.v1") {
      errors.push("time_machine_missing_evidence_schema");
    }
    if (timeMachineGate.package_script !== "proof:dojo:time-machine-debugger:self-check") {
      errors.push("time_machine_missing_package_script");
    }
    if (!timeMachineGate.default_evidence_path) errors.push("time_machine_missing_default_evidence_path");
    if (!timeMachineGate.release_artifact_requirements?.require_all_time_machine_capabilities_covered) {
      errors.push("time_machine_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_deterministic_debug_report", "time_machine_missing_deterministic_debug_requirement"],
      ["require_counterfactual_twin", "time_machine_missing_counterfactual_twin_requirement"],
      ["require_promoted_scenario_selection", "time_machine_missing_promoted_scenario_requirement"],
      ["require_scenario_correlation", "time_machine_missing_scenario_correlation_requirement"],
      ["require_attack_guardrail_correlation", "time_machine_missing_attack_guardrail_requirement"],
      ["require_remediation_cost_policy", "time_machine_missing_remediation_cost_requirement"],
      ["require_baseline_explanation", "time_machine_missing_baseline_requirement"],
      ["require_materialized_runtime_branch", "time_machine_missing_runtime_branch_requirement"],
      ["require_counterfactual_license_impact", "time_machine_missing_license_impact_requirement"],
      ["require_replay_plan", "time_machine_missing_replay_plan_requirement"],
      ["require_honest_projection_status", "time_machine_missing_honest_status_requirement"],
      ["require_self_check_executes_tests", "time_machine_missing_self_check_execution_requirement"],
    ]) {
      if (!timeMachineGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredTimeMachineCapabilities = Array.isArray(timeMachineGate.release_artifact_requirements?.required_time_machine_capabilities)
      ? timeMachineGate.release_artifact_requirements.required_time_machine_capabilities
      : [];
    const missingTimeMachineCapabilities = DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
      .filter((capability) => !requiredTimeMachineCapabilities.includes(capability));
    if (missingTimeMachineCapabilities.length > 0) {
      errors.push(`time_machine_missing_required_capabilities:${missingTimeMachineCapabilities.join(",")}`);
    }
    const missingTimeMachineTestFiles = missingRequiredEntries(
      DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
      timeMachineGate.release_artifact_requirements?.required_test_files,
    );
    if (missingTimeMachineTestFiles.length > 0) {
      errors.push(`time_machine_missing_required_test_files:${missingTimeMachineTestFiles.join(",")}`);
    }
    if (!timeMachineGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("time_machine_missing_no_skipped_requirement");
    }
    if (!timeMachineGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("time_machine_missing_digest_requirement");
    }
    if (!timeMachineGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("time_machine_missing_json_report_digest_requirement");
    }
  }
  const vivariumRuntimeGate = gates.find((gate) => gate.id === "dojo_vivarium_runtime_self_check");
  if (vivariumRuntimeGate) {
    if (vivariumRuntimeGate.evidence_schema_version !== "synthi.dojo.vivariumRuntimeEvidence.v1") {
      errors.push("vivarium_runtime_missing_evidence_schema");
    }
    if (vivariumRuntimeGate.package_script !== "proof:dojo:vivarium-runtime:self-check") {
      errors.push("vivarium_runtime_missing_package_script");
    }
    if (!vivariumRuntimeGate.default_evidence_path) errors.push("vivarium_runtime_missing_default_evidence_path");
    if (!vivariumRuntimeGate.release_artifact_requirements?.require_all_vivarium_runtime_capabilities_covered) {
      errors.push("vivarium_runtime_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_scenario_dsl", "vivarium_runtime_missing_scenario_dsl_requirement"],
      ["require_synthetic_fixture_materialization", "vivarium_runtime_missing_fixture_requirement"],
      ["require_synthetic_only_policy", "vivarium_runtime_missing_synthetic_policy_requirement"],
      ["require_oracle", "vivarium_runtime_missing_oracle_requirement"],
      ["require_ledger_ready_oracle_evidence", "vivarium_runtime_missing_oracle_evidence_requirement"],
      ["require_api_fault_server", "vivarium_runtime_missing_api_fault_requirement"],
      ["require_fake_success_state_detection", "vivarium_runtime_missing_fake_success_requirement"],
      ["require_partial_write_detection", "vivarium_runtime_missing_partial_write_requirement"],
      ["require_prompt_injection_quarantine", "vivarium_runtime_missing_prompt_injection_requirement"],
      ["require_deterministic_reset", "vivarium_runtime_missing_reset_requirement"],
      ["require_budget_enforcement", "vivarium_runtime_missing_budget_requirement"],
      ["require_targeted_graph_execution", "vivarium_runtime_missing_targeted_graph_requirement"],
      ["require_executable_checkride", "vivarium_runtime_missing_checkride_requirement"],
      ["require_license_constraints_from_blocked_risk", "vivarium_runtime_missing_license_constraint_requirement"],
      ["require_critical_guardrail_failure", "vivarium_runtime_missing_critical_guardrail_requirement"],
      ["require_substrate_hook_passthrough", "vivarium_runtime_missing_substrate_hook_requirement"],
      ["require_evil_twin_attack_measurement", "vivarium_runtime_missing_evil_twin_measurement_requirement"],
      ["require_evil_twin_hardening_loop", "vivarium_runtime_missing_evil_twin_hardening_requirement"],
      ["require_self_check_executes_tests", "vivarium_runtime_missing_self_check_execution_requirement"],
    ]) {
      if (!vivariumRuntimeGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredVivariumCapabilities = Array.isArray(vivariumRuntimeGate.release_artifact_requirements?.required_vivarium_runtime_capabilities)
      ? vivariumRuntimeGate.release_artifact_requirements.required_vivarium_runtime_capabilities
      : [];
    const missingVivariumCapabilities = DOJO_VIVARIUM_RUNTIME_CAPABILITIES
      .filter((capability) => !requiredVivariumCapabilities.includes(capability));
    if (missingVivariumCapabilities.length > 0) {
      errors.push(`vivarium_runtime_missing_required_capabilities:${missingVivariumCapabilities.join(",")}`);
    }
    const missingVivariumTestFiles = missingRequiredEntries(
      DOJO_VIVARIUM_RUNTIME_TEST_FILES,
      vivariumRuntimeGate.release_artifact_requirements?.required_test_files,
    );
    if (missingVivariumTestFiles.length > 0) {
      errors.push(`vivarium_runtime_missing_required_test_files:${missingVivariumTestFiles.join(",")}`);
    }
    if (!vivariumRuntimeGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("vivarium_runtime_missing_no_skipped_requirement");
    }
    if (!vivariumRuntimeGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("vivarium_runtime_missing_digest_requirement");
    }
    if (!vivariumRuntimeGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("vivarium_runtime_missing_json_report_digest_requirement");
    }
  }
  const checkrideLicenseGate = gates.find((gate) => gate.id === "dojo_checkride_license_self_check");
  if (checkrideLicenseGate) {
    if (checkrideLicenseGate.evidence_schema_version !== "synthi.dojo.checkrideLicenseEvidence.v1") {
      errors.push("checkride_license_missing_evidence_schema");
    }
    if (checkrideLicenseGate.package_script !== "proof:dojo:checkride-license:self-check") {
      errors.push("checkride_license_missing_package_script");
    }
    if (!checkrideLicenseGate.default_evidence_path) errors.push("checkride_license_missing_default_evidence_path");
    if (!checkrideLicenseGate.release_artifact_requirements?.require_all_checkride_license_capabilities_covered) {
      errors.push("checkride_license_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_executable_checkride", "checkride_license_missing_executable_requirement"],
      ["require_graph_runtime", "checkride_license_missing_graph_runtime_requirement"],
      ["require_vivarium_oracle", "checkride_license_missing_oracle_requirement"],
      ["require_observed_evidence", "checkride_license_missing_observed_evidence_requirement"],
      ["require_evidence_record", "checkride_license_missing_evidence_record_requirement"],
      ["require_ledger_append", "checkride_license_missing_ledger_append_requirement"],
      ["require_license_constraints", "checkride_license_missing_license_constraint_requirement"],
      ["require_critical_failure_block", "checkride_license_missing_critical_failure_requirement"],
      ["require_substrate_assertion", "checkride_license_missing_substrate_assertion_requirement"],
      ["require_entrustment_policy", "checkride_license_missing_entrustment_requirement"],
      ["require_guardrail_evidence_e3", "checkride_license_missing_e3_requirement"],
      ["require_stale_evidence_downgrade", "checkride_license_missing_stale_evidence_requirement"],
      ["require_shadow_mismatch_limit", "checkride_license_missing_shadow_mismatch_requirement"],
      ["require_srl_policy", "checkride_license_missing_srl_requirement"],
      ["require_limited_license_srl7", "checkride_license_missing_srl7_requirement"],
      ["require_operational_feedback_srl9", "checkride_license_missing_srl9_requirement"],
      ["require_self_check_executes_tests", "checkride_license_missing_self_check_execution_requirement"],
    ]) {
      if (!checkrideLicenseGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredCheckrideLicenseCapabilities = Array.isArray(checkrideLicenseGate.release_artifact_requirements?.required_checkride_license_capabilities)
      ? checkrideLicenseGate.release_artifact_requirements.required_checkride_license_capabilities
      : [];
    const missingCheckrideLicenseCapabilities = DOJO_CHECKRIDE_LICENSE_CAPABILITIES
      .filter((capability) => !requiredCheckrideLicenseCapabilities.includes(capability));
    if (missingCheckrideLicenseCapabilities.length > 0) {
      errors.push(`checkride_license_missing_required_capabilities:${missingCheckrideLicenseCapabilities.join(",")}`);
    }
    const missingCheckrideLicenseTestFiles = missingRequiredEntries(
      DOJO_CHECKRIDE_LICENSE_TEST_FILES,
      checkrideLicenseGate.release_artifact_requirements?.required_test_files,
    );
    if (missingCheckrideLicenseTestFiles.length > 0) {
      errors.push(`checkride_license_missing_required_test_files:${missingCheckrideLicenseTestFiles.join(",")}`);
    }
    if (!checkrideLicenseGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("checkride_license_missing_no_skipped_requirement");
    }
    if (!checkrideLicenseGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("checkride_license_missing_digest_requirement");
    }
    if (!checkrideLicenseGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("checkride_license_missing_json_report_digest_requirement");
    }
  }
  const caseLawRuntimeGate = gates.find((gate) => gate.id === "dojo_case_law_runtime_self_check");
  if (caseLawRuntimeGate) {
    if (caseLawRuntimeGate.evidence_schema_version !== "synthi.dojo.caseLawRuntimeEvidence.v1") {
      errors.push("case_law_runtime_missing_evidence_schema");
    }
    if (caseLawRuntimeGate.package_script !== "proof:dojo:case-law-runtime:self-check") {
      errors.push("case_law_runtime_missing_package_script");
    }
    if (!caseLawRuntimeGate.default_evidence_path) errors.push("case_law_runtime_missing_default_evidence_path");
    if (!caseLawRuntimeGate.release_artifact_requirements?.require_all_case_law_runtime_capabilities_covered) {
      errors.push("case_law_runtime_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_case_law_registry", "case_law_runtime_missing_registry_requirement"],
      ["require_reviewed_evidence", "case_law_runtime_missing_reviewed_evidence_requirement"],
      ["require_proposed_cases_nonbinding", "case_law_runtime_missing_proposed_nonbinding_requirement"],
      ["require_approved_binding_scope", "case_law_runtime_missing_binding_scope_requirement"],
      ["require_deprecated_cases_excluded", "case_law_runtime_missing_deprecated_exclusion_requirement"],
      ["require_guardrail_synthesis", "case_law_runtime_missing_guardrail_synthesis_requirement"],
      ["require_explicit_predicate_preservation", "case_law_runtime_missing_explicit_predicate_requirement"],
      ["require_graph_binding", "case_law_runtime_missing_graph_binding_requirement"],
      ["require_runtime_guardrail_block", "case_law_runtime_missing_runtime_block_requirement"],
      ["require_refusal_case_citation", "case_law_runtime_missing_refusal_citation_requirement"],
      ["require_inactive_case_suppression", "case_law_runtime_missing_inactive_suppression_requirement"],
      ["require_antibody_matching", "case_law_runtime_missing_antibody_matching_requirement"],
      ["require_antibody_proposed_only", "case_law_runtime_missing_antibody_proposed_only_requirement"],
      ["require_antibody_private_data_redaction", "case_law_runtime_missing_antibody_private_data_requirement"],
      ["require_local_practice", "case_law_runtime_missing_local_practice_requirement"],
      ["require_local_checkride", "case_law_runtime_missing_local_checkride_requirement"],
      ["require_deterministic_antibody_ids", "case_law_runtime_missing_deterministic_antibody_requirement"],
      ["require_self_check_executes_tests", "case_law_runtime_missing_self_check_execution_requirement"],
    ]) {
      if (!caseLawRuntimeGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    const requiredCaseLawRuntimeCapabilities = Array.isArray(caseLawRuntimeGate.release_artifact_requirements?.required_case_law_runtime_capabilities)
      ? caseLawRuntimeGate.release_artifact_requirements.required_case_law_runtime_capabilities
      : [];
    const missingCaseLawRuntimeCapabilities = DOJO_CASE_LAW_RUNTIME_CAPABILITIES
      .filter((capability) => !requiredCaseLawRuntimeCapabilities.includes(capability));
    if (missingCaseLawRuntimeCapabilities.length > 0) {
      errors.push(`case_law_runtime_missing_required_capabilities:${missingCaseLawRuntimeCapabilities.join(",")}`);
    }
    const missingCaseLawRuntimeTestFiles = missingRequiredEntries(
      DOJO_CASE_LAW_RUNTIME_TEST_FILES,
      caseLawRuntimeGate.release_artifact_requirements?.required_test_files,
    );
    if (missingCaseLawRuntimeTestFiles.length > 0) {
      errors.push(`case_law_runtime_missing_required_test_files:${missingCaseLawRuntimeTestFiles.join(",")}`);
    }
    if (!caseLawRuntimeGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("case_law_runtime_missing_no_skipped_requirement");
    }
    if (!caseLawRuntimeGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("case_law_runtime_missing_digest_requirement");
    }
    if (!caseLawRuntimeGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("case_law_runtime_missing_json_report_digest_requirement");
    }
  }
  const hostedRuntimeGatewayGate = gates.find((gate) => gate.id === "dojo_hosted_runtime_gateway_self_check");
  if (hostedRuntimeGatewayGate) {
    if (hostedRuntimeGatewayGate.evidence_schema_version !== "synthi.dojo.hostedRuntimeGatewayEvidence.v1") {
      errors.push("hosted_runtime_gateway_missing_evidence_schema");
    }
    if (hostedRuntimeGatewayGate.package_script !== "proof:dojo:hosted-runtime-gateway:self-check") {
      errors.push("hosted_runtime_gateway_missing_package_script");
    }
    if (!hostedRuntimeGatewayGate.default_evidence_path) errors.push("hosted_runtime_gateway_missing_default_evidence_path");
    if (!hostedRuntimeGatewayGate.release_artifact_requirements?.require_all_hosted_runtime_gateway_capabilities_covered) {
      errors.push("hosted_runtime_gateway_missing_capability_requirement");
    }
    for (const [requirement, errorCode] of [
      ["require_tenant_scoped_sessions", "hosted_runtime_gateway_missing_tenant_scope_requirement"],
      ["require_short_lived_credentials", "hosted_runtime_gateway_missing_short_lived_credentials_requirement"],
      ["require_stored_secret_redaction", "hosted_runtime_gateway_missing_secret_redaction_requirement"],
      ["require_origin_allowlist", "hosted_runtime_gateway_missing_origin_allowlist_requirement"],
      ["require_local_network_policy", "hosted_runtime_gateway_missing_local_network_policy_requirement"],
      ["require_screenshot_redaction", "hosted_runtime_gateway_missing_screenshot_redaction_requirement"],
      ["require_skill_run_binding", "hosted_runtime_gateway_missing_skill_run_binding_requirement"],
      ["require_audit_events", "hosted_runtime_gateway_missing_audit_requirement"],
      ["require_evidence_write", "hosted_runtime_gateway_missing_evidence_requirement"],
      ["require_fail_closed_on_missing_evidence_writer", "hosted_runtime_gateway_missing_fail_closed_evidence_requirement"],
      ["require_revocation_and_expiry", "hosted_runtime_gateway_missing_revocation_expiry_requirement"],
      ["require_durable_store_production_requirement", "hosted_runtime_gateway_missing_durable_store_requirement"],
      ["require_postgres_session_store", "hosted_runtime_gateway_missing_postgres_store_requirement"],
      ["require_durable_postgres_session_gate", "hosted_runtime_gateway_missing_durable_postgres_gate_requirement"],
      ["require_malformed_record_rejection", "hosted_runtime_gateway_missing_malformed_record_requirement"],
      ["require_self_check_executes_tests", "hosted_runtime_gateway_missing_self_check_execution_requirement"],
    ]) {
      if (!hostedRuntimeGatewayGate.release_artifact_requirements?.[requirement]) errors.push(errorCode);
    }
    if (hostedRuntimeGatewayGate.release_artifact_requirements?.durable_postgres_session_gate_id !== "dojo_postgres_control_plane_self_check") {
      errors.push("hosted_runtime_gateway_missing_durable_postgres_gate_id");
    }
    const requiredHostedRuntimeCapabilities = Array.isArray(hostedRuntimeGatewayGate.release_artifact_requirements?.required_hosted_runtime_gateway_capabilities)
      ? hostedRuntimeGatewayGate.release_artifact_requirements.required_hosted_runtime_gateway_capabilities
      : [];
    const missingHostedRuntimeCapabilities = DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
      .filter((capability) => !requiredHostedRuntimeCapabilities.includes(capability));
    if (missingHostedRuntimeCapabilities.length > 0) {
      errors.push(`hosted_runtime_gateway_missing_required_capabilities:${missingHostedRuntimeCapabilities.join(",")}`);
    }
    const missingHostedRuntimeTestFiles = missingRequiredEntries(
      DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
      hostedRuntimeGatewayGate.release_artifact_requirements?.required_test_files,
    );
    if (missingHostedRuntimeTestFiles.length > 0) {
      errors.push(`hosted_runtime_gateway_missing_required_test_files:${missingHostedRuntimeTestFiles.join(",")}`);
    }
    if (!hostedRuntimeGatewayGate.release_artifact_requirements?.require_no_skipped_tests) {
      errors.push("hosted_runtime_gateway_missing_no_skipped_requirement");
    }
    if (!hostedRuntimeGatewayGate.release_artifact_requirements?.require_stdout_stderr_digest_match) {
      errors.push("hosted_runtime_gateway_missing_digest_requirement");
    }
    if (!hostedRuntimeGatewayGate.release_artifact_requirements?.require_json_report_digest_match) {
      errors.push("hosted_runtime_gateway_missing_json_report_digest_requirement");
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
    if (!soakPerformanceGate.enterprise_artifact_requirements?.require_zero_errors) {
      errors.push("soak_performance_missing_zero_error_requirement");
    }
    if (!soakPerformanceGate.enterprise_artifact_requirements?.require_tool_latency_metrics) {
      errors.push("soak_performance_missing_tool_latency_requirement");
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

function missingRequiredPackageScriptTokens(packageScripts, gate, requiredTokens) {
  const packageJson = gate.package_json || "mcp/synthi-mcp/package.json";
  const scripts = packageScripts?.[packageJson];
  if (!scripts) return [];
  const command = scripts[gate.package_script];
  if (typeof command !== "string") return [];
  return requiredTokens.filter((token) => !command.includes(token));
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
