// @ts-nocheck
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateEvidenceManifest,
  buildDojoReleaseGateManifest,
  DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  DOJO_RELEASE_GATE_IDS,
  DOJO_RELEASE_GATE_TIERS,
  validateDojoReleaseGateManifest,
  validateDojoVisualProofReport,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
  DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
} from "../../scripts/dojo-agent-ready-ui-contract-self-check.mjs";
import {
  DOJO_API_TOOL_COMPILER_CAPABILITIES,
  DOJO_API_TOOL_COMPILER_TEST_FILES,
} from "../../scripts/dojo-api-tool-compiler-self-check.mjs";
import {
  DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
  DOJO_CASE_LAW_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-case-law-runtime-self-check.mjs";
import {
  DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
  DOJO_CHECKRIDE_LICENSE_TEST_FILES,
} from "../../scripts/dojo-checkride-license-self-check.mjs";
import {
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
} from "../../scripts/dojo-chaos-performance-self-check.mjs";
import {
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
  DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} from "../../scripts/dojo-compliance-export-self-check.mjs";
import {
  DOJO_DOCKER_HEALTHY_SERVICES,
  DOJO_DOCKER_REQUIRED_ENDPOINTS,
  DOJO_DOCKER_REQUIRED_SERVICES,
} from "../../scripts/dojo-docker-integration-self-check.mjs";
import {
  DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
  DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
} from "../../scripts/dojo-evidence-authority-self-check.mjs";
import {
  DOJO_GENERATED_PR_CAPABILITIES,
  DOJO_GENERATED_PR_TEST_FILES,
} from "../../scripts/dojo-generated-pr-self-check.mjs";
import {
  DOJO_MCP_SKILL_BUS_CAPABILITIES,
  DOJO_MCP_SKILL_BUS_TEST_FILES,
} from "../../scripts/dojo-mcp-skill-bus-self-check.mjs";
import {
  DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
  DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
} from "../../scripts/dojo-governance-lifecycle-self-check.mjs";
import {
  DOJO_GRAPH_RUNTIME_CAPABILITIES,
  DOJO_GRAPH_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-graph-runtime-self-check.mjs";
import {
  DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
  DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
} from "../../scripts/dojo-ghost-mode-evidence-self-check.mjs";
import {
  DOJO_SKILL_PASSPORT_CAPABILITIES,
  DOJO_SKILL_PASSPORT_TEST_FILES,
} from "../../scripts/dojo-skill-passport-self-check.mjs";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
  DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
} from "../../scripts/dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
  DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
} from "../../scripts/dojo-implementation-status-self-check.mjs";
import {
  DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
  DOJO_VIVARIUM_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-vivarium-runtime-self-check.mjs";
import {
  DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
  DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
} from "../../scripts/dojo-managed-key-signing-self-check.mjs";
import {
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "../../scripts/dojo-postgres-control-plane-self-check.mjs";
import {
  DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
  DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
} from "../../scripts/dojo-public-proof-verification-self-check.mjs";
import {
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
  DOJO_PRIVACY_REDACTION_TEST_FILES,
} from "../../scripts/dojo-privacy-redaction-self-check.mjs";
import {
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "../../scripts/dojo-security-abuse-self-check.mjs";
import {
  DOJO_SOURCE_DRIFT_CAPABILITIES,
  DOJO_SOURCE_DRIFT_TEST_FILES,
} from "../../scripts/dojo-source-drift-self-check.mjs";
import {
  DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES,
  DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
} from "../../scripts/dojo-time-machine-debugger-self-check.mjs";

const PACKAGE_SCRIPTS = {
  "mcp/synthi-mcp/package.json": {
    typecheck: "tsc --noEmit",
    build: "tsc",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:dojo:postgres-control-plane": "vitest run tests/integration/dojo_postgres_schema.test.ts tests/integration/dojo_postgres_proof_store.test.ts tests/integration/dojo_postgres_proof_key_registry.test.ts tests/integration/dojo_evidence_ledger_store.test.ts tests/integration/dojo_audit_store.test.ts tests/integration/dojo_postgres_skill_store.test.ts tests/integration/dojo_postgres_license_store.test.ts tests/integration/dojo_postgres_tool_control_plane.test.ts tests/integration/dojo_postgres_ghost_shadow_evidence_store.test.ts tests/integration/dojo_postgres_governance_store.test.ts tests/integration/dojo_postgres_source_registry_store.test.ts tests/integration/dojo_postgres_mcp_skill_bus_store.test.ts tests/integration/dojo_postgres_graph_run_store.test.ts tests/integration/dojo_postgres_hosted_runtime_store.test.ts tests/integration/dojo_hosted_runtime_gateway_resolver.test.ts tests/integration/dojo_postgres_mcp_host_conformance_store.test.ts tests/integration/dojo_proof_ledger_tool.test.ts",
    "proof:dojo:self-check": "node scripts/dojo-proof-self-check.mjs",
    "proof:dojo:mcp-host-conformance:self-check": "node scripts/dojo-mcp-host-conformance.mjs --self-check",
    "proof:dojo:docker-integration:self-check": "node scripts/dojo-docker-integration-self-check.mjs",
    "proof:dojo:postgres-control-plane:self-check": "node scripts/dojo-postgres-control-plane-self-check.mjs",
    "proof:dojo:affordance-codemod:self-check": "node scripts/dojo-affordance-codemod-self-check.mjs",
    "proof:dojo:agent-ready-ui-contract:self-check": "node scripts/dojo-agent-ready-ui-contract-self-check.mjs",
    "proof:dojo:api-tool-compiler:self-check": "node scripts/dojo-api-tool-compiler-self-check.mjs",
    "proof:dojo:evidence-authority:self-check": "node scripts/dojo-evidence-authority-self-check.mjs",
    "proof:dojo:generated-pr:self-check": "node scripts/dojo-generated-pr-self-check.mjs",
    "proof:dojo:mcp-skill-bus:self-check": "node scripts/dojo-mcp-skill-bus-self-check.mjs",
    "proof:dojo:source-drift:self-check": "node scripts/dojo-source-drift-self-check.mjs",
    "proof:dojo:managed-key-signing:self-check": "node scripts/dojo-managed-key-signing-self-check.mjs",
    "proof:dojo:governance-lifecycle:self-check": "node scripts/dojo-governance-lifecycle-self-check.mjs",
    "proof:dojo:graph-runtime:self-check": "node scripts/dojo-graph-runtime-self-check.mjs",
    "proof:dojo:ghost-mode-evidence:self-check": "node scripts/dojo-ghost-mode-evidence-self-check.mjs",
    "proof:dojo:skill-passport:self-check": "node scripts/dojo-skill-passport-self-check.mjs",
    "proof:dojo:time-machine-debugger:self-check": "node scripts/dojo-time-machine-debugger-self-check.mjs",
    "proof:dojo:vivarium-runtime:self-check": "node scripts/dojo-vivarium-runtime-self-check.mjs",
    "proof:dojo:checkride-license:self-check": "node scripts/dojo-checkride-license-self-check.mjs",
    "proof:dojo:implementation-status:self-check": "node scripts/dojo-implementation-status-self-check.mjs",
    "proof:dojo:case-law-runtime:self-check": "node scripts/dojo-case-law-runtime-self-check.mjs",
    "proof:dojo:hosted-runtime-gateway:self-check": "node scripts/dojo-hosted-runtime-gateway-self-check.mjs",
    "proof:dojo:security-abuse:self-check": "node scripts/dojo-security-abuse-self-check.mjs",
    "proof:dojo:compliance-export:self-check": "node scripts/dojo-compliance-export-self-check.mjs",
    "proof:dojo:privacy-redaction:self-check": "node scripts/dojo-privacy-redaction-self-check.mjs",
    "proof:dojo:chaos-performance:self-check": "node scripts/dojo-chaos-performance-self-check.mjs",
    "proof:dojo:public-proof-verification:self-check": "node scripts/dojo-public-proof-verification-self-check.mjs",
    "live:browser:workflow-pipeline": "node scripts/workflow-pipeline-e2e.mjs",
    "live:browser:private-tool-stdio": "node scripts/private-tool-stdio-acceptance.mjs",
    "live:browser:private-tool-codex": "node scripts/private-tool-codex-acceptance.mjs",
    "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --require-non-loopback-mcp-host --execute-production --require-external-control-plane-store --require-external-proof-signing --require-bridge-token --require-no-local-cdp --require-licensed-skill-filtering",
    "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command --require-non-loopback-runtime --require-external-private-tool-store",
    "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-non-loopback-runtime --require-external-private-tool-store",
    soak: "node tests/soak/soak_loop.mjs",
  },
  "synthi/package.json": {
    lint: "next lint",
    build: "next build",
    "proof:dojo:visual": "node scripts/dojo-visual-proof.mjs",
    "proof:dojo:ghost-mode-visual": "node scripts/dojo-ghost-mode-visual-proof.mjs",
    test: "vitest run",
  },
};

describe("Dojo release gate manifest", () => {
  it("keeps the package Postgres control-plane script aligned with the authoritative self-check suite", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const script = packageJson.scripts["test:dojo:postgres-control-plane"];
    const scriptFiles = script.split(/\s+/).filter((part) => part.endsWith(".test.ts"));

    expect(scriptFiles).toEqual(DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES);
  });

  it("defines the complete T0 through T8 tier matrix", () => {
    expect(DOJO_RELEASE_GATE_TIERS.map((tier) => tier.id)).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
    ]);
    expect(DOJO_RELEASE_GATE_TIERS.every((tier) => tier.name && tier.required_for && tier.purpose)).toBe(true);
  });

  it("builds a manifest with minimal, milestone, and release gate slices", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(manifest.schema_version).toBe("synthi.dojo.releaseGateManifest.v1");
    expect(manifest.minimal_pr_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(manifest.milestone_gate_ids).toEqual(DOJO_MILESTONE_GATE_IDS);
    expect(manifest.release_gate_ids).toEqual(DOJO_RELEASE_GATE_IDS);
    expect(manifest.policy.every_pr_requires).toEqual(["T0", "T1"]);
    expect(manifest.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dojo_implementation_status_self_check",
        tier: "T1",
        package_script: "proof:dojo:implementation-status:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.implementationStatusEvidence.v1",
        default_evidence_path: "tmp/dojo-implementation-status/dojo-implementation-status.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_implementation_status_capabilities_covered: true,
          required_implementation_status_capabilities: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
          required_test_files: DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
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
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_self_check",
        tier: "T2",
        script_exists: true,
        command: "npm --prefix mcp/synthi-mcp run proof:dojo:self-check -- --run-id release-gate",
        report_schema_version: "synthi.dojo.proofSelfCheckSummary.v1",
        evidence_schema_version: "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1",
        default_report_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/summary.json",
        default_evidence_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/production-runtime-evidence.json",
        artifact_requirements: expect.objectContaining({
          require_production_proof_consumed: true,
          require_proof_replay_blocked: true,
          require_runtime_custody_evidence: true,
          require_visual_pixel_metrics: true,
          require_no_runtime_credential_secret: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_postgres_control_plane_self_check",
        tier: "T2",
        package_script: "proof:dojo:postgres-control-plane:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
        default_evidence_path: "tmp/dojo-postgres-control-plane/dojo-postgres-control-plane.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_postgres_url: true,
          require_all_control_plane_capabilities_covered: true,
          required_control_plane_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
          required_test_files: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_evidence_authority_self_check",
        tier: "T2",
        package_script: "proof:dojo:evidence-authority:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
        default_evidence_path: "tmp/dojo-evidence-authority/dojo-evidence-authority.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_evidence_authority_capabilities_covered: true,
          required_evidence_authority_capabilities: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
          required_test_files: DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
          require_canonical_record_hash: true,
          require_record_signature_verification: true,
          require_tamper_detection: true,
          require_claim_freshness: true,
          require_claim_scope: true,
          require_claim_kind: true,
          require_ledger_resolver_fail_closed: true,
          require_redaction_manifest: true,
          require_redacted_export: true,
          require_proof_issue_claim_verification: true,
          require_self_attested_claim_rejection: true,
          require_durable_postgres_ledger_gate: true,
          durable_postgres_ledger_gate_id: "dojo_postgres_control_plane_self_check",
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_affordance_codemod_self_check",
        tier: "T2",
        package_script: "proof:dojo:affordance-codemod:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
        evidence_schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
      }),
      expect.objectContaining({
        id: "dojo_source_drift_self_check",
        tier: "T2",
        package_script: "proof:dojo:source-drift:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.sourceDriftEvidence.v1",
        default_evidence_path: "tmp/dojo-source-drift/dojo-source-drift.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_source_drift_capabilities_covered: true,
          required_source_drift_capabilities: DOJO_SOURCE_DRIFT_CAPABILITIES,
          required_test_files: DOJO_SOURCE_DRIFT_TEST_FILES,
          require_release_scoped_snapshot: true,
          require_signed_snapshot_verification: true,
          require_source_content_hash: true,
          require_changed_token_expiry: true,
          require_removed_token_expiry: true,
          require_added_risky_affordance_review: true,
          require_unrelated_token_no_expiry: true,
          require_tamper_rejection: true,
          require_license_store_expiry_application: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_agent_ready_ui_contract_self_check",
        tier: "T2",
        package_script: "proof:dojo:agent-ready-ui-contract:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
        default_evidence_path: "tmp/dojo-agent-ready-ui-contract/dojo-agent-ready-ui-contract.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_agent_ready_ui_contract_capabilities_covered: true,
          required_agent_ready_ui_contract_capabilities: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
          required_test_files: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
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
        }),
      }),
      expect.objectContaining({
        id: "dojo_api_tool_compiler_self_check",
        tier: "T2",
        package_script: "proof:dojo:api-tool-compiler:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
        default_evidence_path: "tmp/dojo-api-tool-compiler/dojo-api-tool-compiler.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_api_tool_compiler_capabilities_covered: true,
          required_api_tool_compiler_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES,
          required_test_files: DOJO_API_TOOL_COMPILER_TEST_FILES,
          require_reviewed_candidate: true,
          require_proof_capsule: true,
          require_license_kernel: true,
          require_idempotency: true,
          require_auth_scope: true,
          require_strict_input_schema: true,
          require_postcondition: true,
          require_evidence_write: true,
          require_graph_proof_match: true,
        }),
      }),
      expect.objectContaining({
        id: "docker_integration",
        tier: "T3",
        package_script: "proof:dojo:docker-integration:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
        default_evidence_path: "tmp/dojo-docker-integration/dojo-docker-integration.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_compose_up_ran: true,
          require_all_required_services_running: true,
          required_services: DOJO_DOCKER_REQUIRED_SERVICES,
          require_required_healthchecks_healthy: true,
          required_healthy_services: DOJO_DOCKER_HEALTHY_SERVICES,
          require_required_endpoints_ok: true,
          required_endpoint_contracts: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => ({
            id: endpoint.id,
            expected_status: endpoint.expected_status,
          })),
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: expect.arrayContaining([
          "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS",
          "AI_ENGINE_HOST_PORT",
          "POSTGRES_HOST_PORT",
        ]),
      }),
      expect.objectContaining({
        id: "dojo_full_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.visualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
          required_result_fields: expect.arrayContaining(["screenshot_sha256"]),
        }),
      }),
      expect.objectContaining({
        id: "dojo_ghost_mode_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:ghost-mode-visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.ghostModeVisualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
          required_result_fields: expect.arrayContaining(["screenshot_sha256"]),
        }),
      }),
      expect.objectContaining({ id: "dojo_mcp_host_conformance", tier: "T6", script_exists: true }),
      expect.objectContaining({
        id: "dojo_mcp_host_conformance",
        tier: "T6",
        package_script: "live:dojo:mcp-host-conformance",
        command: "npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance",
        report_schema_version: "synthi.dojo.mcpHostConformance.v1",
        evidence_schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
        default_report_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.json",
        default_evidence_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.evidence.json",
        release_artifact_requirements: DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS,
        requires_env: expect.arrayContaining([
          "SYNTHI_DOJO_MCP_HOST_URL",
          "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE",
          "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
          "SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED",
          "SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE",
          "SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING",
        ]),
      }),
      expect.objectContaining({
        id: "private_tool_stdio_host_conformance",
        tier: "T6",
        report_schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
        default_report_path: "tmp/private-tool-stdio-host-conformance/mcp-stdio-private-tool-acceptance.json",
        command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance -- --out-dir tmp/private-tool-stdio-host-conformance",
        release_artifact_requirements: expect.objectContaining({
          require_non_loopback_runtime: true,
          require_external_private_tool_store: true,
          require_no_local_attach: true,
          require_private_tool_call: true,
          require_custom_mcp_command: true,
          require_strict_schema: true,
          require_visual_proof: true,
        }),
        requires_env: expect.arrayContaining([
          "SYNTHI_HOSTED_BROWSER_CDP_URL",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE",
          "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL",
        ]),
      }),
      expect.objectContaining({
        id: "private_tool_codex_host_conformance",
        tier: "T6",
        report_schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
        default_report_path: "tmp/private-tool-codex-host-conformance/codex-private-tool-acceptance.json",
        command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance -- --out-dir tmp/private-tool-codex-host-conformance",
        release_artifact_requirements: expect.objectContaining({
          require_non_loopback_runtime: true,
          require_external_private_tool_store: true,
          require_no_local_attach: true,
          require_private_tool_call: true,
          require_agent_mcp_only: true,
          require_no_shell_commands: true,
          require_visual_proof: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_generated_pr_self_check",
        tier: "T7",
        package_script: "proof:dojo:generated-pr:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.generatedPrEvidence.v1",
        default_evidence_path: "tmp/dojo-generated-pr/dojo-generated-pr.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_generated_pr_capabilities_covered: true,
          required_generated_pr_capabilities: DOJO_GENERATED_PR_CAPABILITIES,
          required_test_files: DOJO_GENERATED_PR_TEST_FILES,
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
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_mcp_skill_bus_self_check",
        tier: "T7",
        package_script: "proof:dojo:mcp-skill-bus:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
        default_evidence_path: "tmp/dojo-mcp-skill-bus/dojo-mcp-skill-bus.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_mcp_skill_bus_capabilities_covered: true,
          required_mcp_skill_bus_capabilities: DOJO_MCP_SKILL_BUS_CAPABILITIES,
          required_test_files: DOJO_MCP_SKILL_BUS_TEST_FILES,
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
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_managed_key_signing_self_check",
        tier: "T7",
        package_script: "proof:dojo:managed-key-signing:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
        default_evidence_path: "tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_managed_key_signing_capabilities_covered: true,
          required_managed_key_signing_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
          required_test_files: DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_managed_key_service_provider: true,
          require_managed_key_custody: true,
          require_public_verifier_material: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_public_proof_verification_self_check",
        tier: "T7",
        package_script: "proof:dojo:public-proof-verification:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
        default_evidence_path: "tmp/dojo-public-proof-verification/dojo-public-proof-verification.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_public_proof_verification_capabilities_covered: true,
          required_public_proof_verification_capabilities: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
          required_test_files: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
          require_external_verifier: true,
          require_ed25519_public_key: true,
          require_evidence_claim_ledger_binding: true,
          require_tamper_and_context_blocks: true,
          require_timestamp_window: true,
          require_proof_key_custody_policy: true,
          require_public_export: true,
          require_private_secret_exclusion: true,
          require_tenant_scoped_key_export: true,
          require_unavailable_key_marking: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_governance_lifecycle_self_check",
        tier: "T7",
        package_script: "proof:dojo:governance-lifecycle:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
        default_evidence_path: "tmp/dojo-governance-lifecycle/dojo-governance-lifecycle.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_governance_lifecycle_capabilities_covered: true,
          required_governance_lifecycle_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
          required_test_files: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
          require_license_health: true,
          require_approval_queue: true,
          require_approval_decision_audit: true,
          require_case_law_review: true,
          require_license_revocation: true,
          require_recertification_queue: true,
          require_policy_gates: true,
          require_audit_export: true,
          require_compliance_pack: true,
          require_proof_public_verification_custody: true,
          require_malformed_expiry_fails_closed: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_graph_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:graph-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-graph-runtime/dojo-graph-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_graph_runtime_capabilities_covered: true,
          required_graph_runtime_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_GRAPH_RUNTIME_TEST_FILES,
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
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_ghost_mode_evidence_self_check",
        tier: "T7",
        package_script: "proof:dojo:ghost-mode-evidence:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.ghostModeEvidence.v1",
        default_evidence_path: "tmp/dojo-ghost-mode-evidence/dojo-ghost-mode-evidence.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_ghost_mode_capabilities_covered: true,
          required_ghost_mode_capabilities: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
          required_test_files: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
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
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_skill_passport_self_check",
        tier: "T7",
        package_script: "proof:dojo:skill-passport:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.skillPassportEvidence.v1",
        default_evidence_path: "tmp/dojo-skill-passport/dojo-skill-passport.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_skill_passport_capabilities_covered: true,
          required_skill_passport_capabilities: DOJO_SKILL_PASSPORT_CAPABILITIES,
          required_test_files: DOJO_SKILL_PASSPORT_TEST_FILES,
          require_report_only_status: true,
          require_license_scope: true,
          require_readiness_scope: true,
          require_proof_scope: true,
          require_coverage_and_attack_metrics: true,
          require_published_tool_scope: true,
          require_skill_card_action_grouping: true,
          require_proof_badge: true,
          require_practice_guardrail_counts: true,
          require_passport_export: true,
          require_raw_payload_redaction: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_time_machine_debugger_self_check",
        tier: "T7",
        package_script: "proof:dojo:time-machine-debugger:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.timeMachineDebuggerEvidence.v1",
        default_evidence_path: "tmp/dojo-time-machine-debugger/dojo-time-machine-debugger.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_time_machine_capabilities_covered: true,
          required_time_machine_capabilities: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES,
          required_test_files: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
          require_deterministic_debug_report: true,
          require_counterfactual_twin: true,
          require_promoted_scenario_selection: true,
          require_scenario_correlation: true,
          require_attack_guardrail_correlation: true,
          require_remediation_cost_policy: true,
          require_baseline_explanation: true,
          require_counterfactual_license_impact: true,
          require_replay_plan: true,
          require_honest_projection_status: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_vivarium_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:vivarium-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-vivarium-runtime/dojo-vivarium-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_vivarium_runtime_capabilities_covered: true,
          required_vivarium_runtime_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_VIVARIUM_RUNTIME_TEST_FILES,
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
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_checkride_license_self_check",
        tier: "T7",
        package_script: "proof:dojo:checkride-license:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
        default_evidence_path: "tmp/dojo-checkride-license/dojo-checkride-license.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_checkride_license_capabilities_covered: true,
          required_checkride_license_capabilities: DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
          required_test_files: DOJO_CHECKRIDE_LICENSE_TEST_FILES,
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
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_case_law_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:case-law-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-case-law-runtime/dojo-case-law-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_case_law_runtime_capabilities_covered: true,
          required_case_law_runtime_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_CASE_LAW_RUNTIME_TEST_FILES,
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
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_hosted_runtime_gateway_self_check",
        tier: "T7",
        package_script: "proof:dojo:hosted-runtime-gateway:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
        default_evidence_path: "tmp/dojo-hosted-runtime-gateway/dojo-hosted-runtime-gateway.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_hosted_runtime_gateway_capabilities_covered: true,
          required_hosted_runtime_gateway_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
          required_test_files: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
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
          require_malformed_record_rejection: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "security_abuse_suite",
        tier: "T7",
        package_script: "proof:dojo:security-abuse:self-check",
        script_exists: true,
        release_artifact_requirements: expect.objectContaining({
          require_all_abuse_classes_covered: true,
          required_abuse_classes: DOJO_SECURITY_ABUSE_CLASSES,
          required_test_files: DOJO_SECURITY_ABUSE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "compliance_export_suite",
        tier: "T7",
        package_script: "proof:dojo:compliance-export:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.complianceExportEvidence.v1",
        default_evidence_path: "tmp/dojo-compliance-export/dojo-compliance-export.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_compliance_capabilities_covered: true,
          required_compliance_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
          required_test_files: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "privacy_redaction_suite",
        tier: "T7",
        package_script: "proof:dojo:privacy-redaction:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
        default_evidence_path: "tmp/dojo-privacy-redaction/dojo-privacy-redaction.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_privacy_capabilities_covered: true,
          required_privacy_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
          required_test_files: DOJO_PRIVACY_REDACTION_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_chaos_performance_self_check",
        tier: "T8",
        package_script: "proof:dojo:chaos-performance:self-check",
        script_exists: true,
        enterprise_artifact_requirements: expect.objectContaining({
          require_all_scenarios_covered: true,
          required_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
          required_test_files: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_budget_ok: true,
          require_performance_metrics: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "soak_performance",
        tier: "T8",
        package_script: "soak",
        script_exists: true,
        default_summary_path: "mcp/synthi-mcp/.soak/soak-summary.json",
        default_events_path: "mcp/synthi-mcp/.soak/soak-events.ndjson",
        enterprise_artifact_requirements: expect.objectContaining({
          require_min_duration_seconds: 3600,
          require_zero_errors: true,
          require_iteration_events: true,
          require_tool_latency_metrics: true,
          require_memory_growth_metrics: true,
          require_post_detach_leak_counters: true,
        }),
      }),
    ]));
  });

  it("validates referenced package scripts and required release tiers", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(validateDojoReleaseGateManifest(manifest, { packageScripts: PACKAGE_SCRIPTS })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      tier_count: 9,
    }));

    const broken = buildDojoReleaseGateManifest({
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    });
    expect(validateDojoReleaseGateManifest(broken, {
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    }).errors).toEqual(expect.arrayContaining([
      "missing_package_script:mcp/synthi-mcp/package.json:typecheck",
      "missing_package_script:mcp/synthi-mcp/package.json:proof:dojo:self-check",
    ]));

    const brokenLiveScripts = {
      ...PACKAGE_SCRIPTS,
      "mcp/synthi-mcp/package.json": {
        ...PACKAGE_SCRIPTS["mcp/synthi-mcp/package.json"],
        "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --require-non-loopback-mcp-host",
        "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command",
        "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-non-loopback-runtime",
      },
    };
    const brokenLiveManifest = buildDojoReleaseGateManifest({ packageScripts: brokenLiveScripts });
    expect(validateDojoReleaseGateManifest(brokenLiveManifest, { packageScripts: brokenLiveScripts }).errors).toEqual(expect.arrayContaining([
      "mcp_host_conformance_package_script_missing_flags:--execute-production,--require-external-control-plane-store,--require-external-proof-signing,--require-bridge-token,--require-no-local-cdp,--require-licensed-skill-filtering",
      "private_tool_host_conformance_package_script_missing_flags:private_tool_stdio_host_conformance:--require-non-loopback-runtime,--require-external-private-tool-store",
      "private_tool_host_conformance_package_script_missing_flags:private_tool_codex_host_conformance:--require-external-private-tool-store",
    ]));

    const brokenPostgres = JSON.parse(JSON.stringify(manifest));
    const postgresGate = brokenPostgres.gates.find((gate) => gate.id === "dojo_postgres_control_plane_self_check");
    const missingPostgresTestFile = DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES[0];
    postgresGate.artifact_requirements.required_control_plane_capabilities = DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
      .filter((capability) => capability !== "atomic_proof_consume");
    postgresGate.artifact_requirements.required_test_files = DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES
      .filter((file) => file !== missingPostgresTestFile);
    expect(validateDojoReleaseGateManifest(brokenPostgres, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "postgres_control_plane_missing_required_capabilities:atomic_proof_consume",
      `postgres_control_plane_missing_required_test_files:${missingPostgresTestFile}`,
    ]));

    const brokenImplementationStatus = JSON.parse(JSON.stringify(manifest));
    const implementationStatusGate = brokenImplementationStatus.gates.find((gate) => gate.id === "dojo_implementation_status_self_check");
    const missingImplementationStatusTestFile = DOJO_IMPLEMENTATION_STATUS_TEST_FILES[0];
    implementationStatusGate.artifact_requirements.required_implementation_status_capabilities = DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
      .filter((capability) => capability !== "no_mature_production_runtime_claims");
    implementationStatusGate.artifact_requirements.required_test_files = DOJO_IMPLEMENTATION_STATUS_TEST_FILES
      .filter((file) => file !== missingImplementationStatusTestFile);
    implementationStatusGate.artifact_requirements.require_production_runtime_claim_boundary = false;
    implementationStatusGate.artifact_requirements.require_runtime_scope_for_executable = false;
    expect(validateDojoReleaseGateManifest(brokenImplementationStatus, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "implementation_status_missing_production_boundary_requirement",
      "implementation_status_missing_runtime_scope_requirement",
      "implementation_status_missing_required_capabilities:no_mature_production_runtime_claims",
      `implementation_status_missing_required_test_files:${missingImplementationStatusTestFile}`,
    ]));

    const brokenEvidenceAuthority = JSON.parse(JSON.stringify(manifest));
    const evidenceAuthorityGate = brokenEvidenceAuthority.gates.find((gate) => gate.id === "dojo_evidence_authority_self_check");
    const missingEvidenceAuthorityTestFile = DOJO_EVIDENCE_AUTHORITY_TEST_FILES[0];
    evidenceAuthorityGate.artifact_requirements.required_evidence_authority_capabilities = DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
      .filter((capability) => capability !== "proof_issuance_requires_verified_evidence_records");
    evidenceAuthorityGate.artifact_requirements.required_test_files = DOJO_EVIDENCE_AUTHORITY_TEST_FILES
      .filter((file) => file !== missingEvidenceAuthorityTestFile);
    evidenceAuthorityGate.artifact_requirements.require_proof_issue_claim_verification = false;
    evidenceAuthorityGate.artifact_requirements.require_self_attested_claim_rejection = false;
    evidenceAuthorityGate.artifact_requirements.durable_postgres_ledger_gate_id = "wrong_gate";
    expect(validateDojoReleaseGateManifest(brokenEvidenceAuthority, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "evidence_authority_missing_proof_issue_requirement",
      "evidence_authority_missing_self_attested_rejection_requirement",
      "evidence_authority_missing_durable_postgres_gate_id",
      "evidence_authority_missing_required_capabilities:proof_issuance_requires_verified_evidence_records",
      `evidence_authority_missing_required_test_files:${missingEvidenceAuthorityTestFile}`,
    ]));

    const brokenSourceDrift = JSON.parse(JSON.stringify(manifest));
    const sourceDriftGate = brokenSourceDrift.gates.find((gate) => gate.id === "dojo_source_drift_self_check");
    const missingSourceDriftTestFile = DOJO_SOURCE_DRIFT_TEST_FILES[0];
    sourceDriftGate.artifact_requirements.required_source_drift_capabilities = DOJO_SOURCE_DRIFT_CAPABILITIES
      .filter((capability) => capability !== "source_drift_rejects_unverified_snapshots");
    sourceDriftGate.artifact_requirements.required_test_files = DOJO_SOURCE_DRIFT_TEST_FILES
      .filter((file) => file !== missingSourceDriftTestFile);
    sourceDriftGate.artifact_requirements.require_changed_token_expiry = false;
    sourceDriftGate.artifact_requirements.require_tamper_rejection = false;
    sourceDriftGate.artifact_requirements.require_license_store_expiry_application = false;
    expect(validateDojoReleaseGateManifest(brokenSourceDrift, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "source_drift_missing_changed_token_expiry_requirement",
      "source_drift_missing_tamper_rejection_requirement",
      "source_drift_missing_license_store_expiry_requirement",
      "source_drift_missing_required_capabilities:source_drift_rejects_unverified_snapshots",
      `source_drift_missing_required_test_files:${missingSourceDriftTestFile}`,
    ]));

    const brokenAgentReadyUiContract = JSON.parse(JSON.stringify(manifest));
    const agentReadyUiContractGate = brokenAgentReadyUiContract.gates.find((gate) => gate.id === "dojo_agent_ready_ui_contract_self_check");
    const missingAgentReadyUiContractTestFile = DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES[0];
    agentReadyUiContractGate.artifact_requirements.required_agent_ready_ui_contract_capabilities = DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
      .filter((capability) => capability !== "agent_ready_ui_contract_requires_proof_hook");
    agentReadyUiContractGate.artifact_requirements.required_test_files = DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES
      .filter((file) => file !== missingAgentReadyUiContractTestFile);
    agentReadyUiContractGate.artifact_requirements.require_proof_hook = false;
    agentReadyUiContractGate.artifact_requirements.require_stable_locator = false;
    expect(validateDojoReleaseGateManifest(brokenAgentReadyUiContract, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "agent_ready_ui_contract_missing_proof_hook_requirement",
      "agent_ready_ui_contract_missing_stable_locator_requirement",
      "agent_ready_ui_contract_missing_required_capabilities:agent_ready_ui_contract_requires_proof_hook",
      `agent_ready_ui_contract_missing_required_test_files:${missingAgentReadyUiContractTestFile}`,
    ]));

    const brokenApiToolCompiler = JSON.parse(JSON.stringify(manifest));
    const apiToolCompilerGate = brokenApiToolCompiler.gates.find((gate) => gate.id === "dojo_api_tool_compiler_self_check");
    const missingApiToolCompilerTestFile = DOJO_API_TOOL_COMPILER_TEST_FILES[0];
    apiToolCompilerGate.artifact_requirements.required_api_tool_compiler_capabilities = DOJO_API_TOOL_COMPILER_CAPABILITIES
      .filter((capability) => capability !== "api_tool_executes_with_idempotency_postcondition_and_evidence");
    apiToolCompilerGate.artifact_requirements.required_test_files = DOJO_API_TOOL_COMPILER_TEST_FILES
      .filter((file) => file !== missingApiToolCompilerTestFile);
    apiToolCompilerGate.artifact_requirements.require_proof_capsule = false;
    apiToolCompilerGate.artifact_requirements.require_evidence_write = false;
    expect(validateDojoReleaseGateManifest(brokenApiToolCompiler, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "api_tool_compiler_missing_proof_requirement",
      "api_tool_compiler_missing_evidence_requirement",
      "api_tool_compiler_missing_required_capabilities:api_tool_executes_with_idempotency_postcondition_and_evidence",
      `api_tool_compiler_missing_required_test_files:${missingApiToolCompilerTestFile}`,
    ]));

    const brokenDocker = JSON.parse(JSON.stringify(manifest));
    const dockerGate = brokenDocker.gates.find((gate) => gate.id === "docker_integration");
    dockerGate.artifact_requirements.required_services = DOJO_DOCKER_REQUIRED_SERVICES
      .filter((service) => service !== "mcp");
    dockerGate.artifact_requirements.required_healthy_services = DOJO_DOCKER_HEALTHY_SERVICES
      .filter((service) => service !== "postgres");
    dockerGate.artifact_requirements.required_endpoint_contracts = DOJO_DOCKER_REQUIRED_ENDPOINTS
      .filter((endpoint) => endpoint.id !== "collab_ports")
      .map((endpoint) => ({ id: endpoint.id, expected_status: endpoint.expected_status }));
    expect(validateDojoReleaseGateManifest(brokenDocker, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "docker_integration_missing_required_services:mcp",
      "docker_integration_missing_required_healthy_services:postgres",
      "docker_integration_missing_required_endpoints:collab_ports",
    ]));

    const brokenMcpHostConformance = JSON.parse(JSON.stringify(manifest));
    const mcpHostGate = brokenMcpHostConformance.gates.find((gate) => gate.id === "dojo_mcp_host_conformance");
    mcpHostGate.release_artifact_requirements.require_revocation_propagation = false;
    mcpHostGate.release_artifact_requirements.require_external_proof_signing = false;
    mcpHostGate.release_artifact_requirements.require_no_local_cdp = false;
    mcpHostGate.requires_env = mcpHostGate.requires_env
      .filter((envName) => envName !== "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING");
    expect(validateDojoReleaseGateManifest(brokenMcpHostConformance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "mcp_host_conformance_missing_revocation_requirement",
      "mcp_host_conformance_missing_external_signing_requirement",
      "mcp_host_conformance_missing_no_local_cdp_requirement",
      "mcp_host_conformance_missing_env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
    ]));

    const brokenPrivateToolHostConformance = JSON.parse(JSON.stringify(manifest));
    const privateHostGate = brokenPrivateToolHostConformance.gates
      .find((gate) => gate.id === "private_tool_stdio_host_conformance");
    privateHostGate.release_artifact_requirements.require_no_local_attach = false;
    privateHostGate.release_artifact_requirements.require_private_tool_call = false;
    expect(validateDojoReleaseGateManifest(brokenPrivateToolHostConformance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "private_tool_host_conformance_missing_no_local_attach:private_tool_stdio_host_conformance",
      "private_tool_host_conformance_missing_private_tool_call:private_tool_stdio_host_conformance",
    ]));

    const brokenGeneratedPr = JSON.parse(JSON.stringify(manifest));
    const generatedPrGate = brokenGeneratedPr.gates.find((gate) => gate.id === "dojo_generated_pr_self_check");
    const missingGeneratedPrTestFile = DOJO_GENERATED_PR_TEST_FILES[0];
    generatedPrGate.release_artifact_requirements.required_generated_pr_capabilities = DOJO_GENERATED_PR_CAPABILITIES
      .filter((capability) => capability !== "generated_pr_git_branch_creates_branch_and_tests");
    generatedPrGate.release_artifact_requirements.required_test_files = DOJO_GENERATED_PR_TEST_FILES
      .filter((file) => file !== missingGeneratedPrTestFile);
    generatedPrGate.release_artifact_requirements.require_git_branch_creation = false;
    generatedPrGate.release_artifact_requirements.require_generated_contract_tests = false;
    expect(validateDojoReleaseGateManifest(brokenGeneratedPr, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "generated_pr_missing_git_branch_requirement",
      "generated_pr_missing_contract_tests_requirement",
      "generated_pr_missing_required_capabilities:generated_pr_git_branch_creates_branch_and_tests",
      `generated_pr_missing_required_test_files:${missingGeneratedPrTestFile}`,
    ]));

    const brokenMcpSkillBus = JSON.parse(JSON.stringify(manifest));
    const mcpSkillBusGate = brokenMcpSkillBus.gates.find((gate) => gate.id === "dojo_mcp_skill_bus_self_check");
    const missingMcpSkillBusTestFile = DOJO_MCP_SKILL_BUS_TEST_FILES[0];
    mcpSkillBusGate.release_artifact_requirements.required_mcp_skill_bus_capabilities = DOJO_MCP_SKILL_BUS_CAPABILITIES
      .filter((capability) => capability !== "mcp_skill_bus_consumes_proof_before_non_dry_dispatch");
    mcpSkillBusGate.release_artifact_requirements.required_test_files = DOJO_MCP_SKILL_BUS_TEST_FILES
      .filter((file) => file !== missingMcpSkillBusTestFile);
    mcpSkillBusGate.release_artifact_requirements.require_proof_consume = false;
    mcpSkillBusGate.release_artifact_requirements.require_tenant_boundary = false;
    mcpSkillBusGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenMcpSkillBus, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "mcp_skill_bus_missing_proof_consume_requirement",
      "mcp_skill_bus_missing_tenant_boundary_requirement",
      "mcp_skill_bus_missing_postgres_env",
      "mcp_skill_bus_missing_required_capabilities:mcp_skill_bus_consumes_proof_before_non_dry_dispatch",
      `mcp_skill_bus_missing_required_test_files:${missingMcpSkillBusTestFile}`,
    ]));

    const brokenManagedKeySigning = JSON.parse(JSON.stringify(manifest));
    const managedKeySigningGate = brokenManagedKeySigning.gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check");
    const missingManagedKeySigningTestFile = DOJO_MANAGED_KEY_SIGNING_TEST_FILES[0];
    managedKeySigningGate.release_artifact_requirements.required_managed_key_signing_capabilities = DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
      .filter((capability) => capability !== "managed_key_service_rejects_local_custody_metadata");
    managedKeySigningGate.release_artifact_requirements.required_test_files = DOJO_MANAGED_KEY_SIGNING_TEST_FILES
      .filter((file) => file !== missingManagedKeySigningTestFile);
    managedKeySigningGate.release_artifact_requirements.require_managed_key_custody = false;
    expect(validateDojoReleaseGateManifest(brokenManagedKeySigning, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "managed_key_signing_missing_custody_requirement",
      "managed_key_signing_missing_required_capabilities:managed_key_service_rejects_local_custody_metadata",
      `managed_key_signing_missing_required_test_files:${missingManagedKeySigningTestFile}`,
    ]));

    const brokenPublicProof = JSON.parse(JSON.stringify(manifest));
    const publicProofGate = brokenPublicProof.gates.find((gate) => gate.id === "dojo_public_proof_verification_self_check");
    const missingPublicProofTestFile = DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES[0];
    publicProofGate.release_artifact_requirements.required_public_proof_verification_capabilities = DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
      .filter((capability) => capability !== "public_proof_verifies_ed25519_public_key");
    publicProofGate.release_artifact_requirements.required_test_files = DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES
      .filter((file) => file !== missingPublicProofTestFile);
    publicProofGate.release_artifact_requirements.require_ed25519_public_key = false;
    publicProofGate.release_artifact_requirements.require_private_secret_exclusion = false;
    expect(validateDojoReleaseGateManifest(brokenPublicProof, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "public_proof_missing_ed25519_requirement",
      "public_proof_missing_secret_exclusion_requirement",
      "public_proof_missing_required_capabilities:public_proof_verifies_ed25519_public_key",
      `public_proof_missing_required_test_files:${missingPublicProofTestFile}`,
    ]));

    const brokenGovernanceLifecycle = JSON.parse(JSON.stringify(manifest));
    const governanceLifecycleGate = brokenGovernanceLifecycle.gates.find((gate) => gate.id === "dojo_governance_lifecycle_self_check");
    const missingGovernanceTestFile = DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES[0];
    governanceLifecycleGate.release_artifact_requirements.required_governance_lifecycle_capabilities = DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
      .filter((capability) => capability !== "governance_revokes_license_to_blocked_scope_with_audit");
    governanceLifecycleGate.release_artifact_requirements.required_test_files = DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES
      .filter((file) => file !== missingGovernanceTestFile);
    governanceLifecycleGate.release_artifact_requirements.require_license_revocation = false;
    governanceLifecycleGate.release_artifact_requirements.require_compliance_pack = false;
    expect(validateDojoReleaseGateManifest(brokenGovernanceLifecycle, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "governance_lifecycle_missing_license_revocation_requirement",
      "governance_lifecycle_missing_compliance_pack_requirement",
      "governance_lifecycle_missing_required_capabilities:governance_revokes_license_to_blocked_scope_with_audit",
      `governance_lifecycle_missing_required_test_files:${missingGovernanceTestFile}`,
    ]));

    const brokenGraphRuntime = JSON.parse(JSON.stringify(manifest));
    const graphRuntimeGate = brokenGraphRuntime.gates.find((gate) => gate.id === "dojo_graph_runtime_self_check");
    const missingGraphRuntimeTestFile = DOJO_GRAPH_RUNTIME_TEST_FILES[0];
    graphRuntimeGate.release_artifact_requirements.required_graph_runtime_capabilities = DOJO_GRAPH_RUNTIME_CAPABILITIES
      .filter((capability) => capability !== "graph_runtime_executes_available_rollback");
    graphRuntimeGate.release_artifact_requirements.required_test_files = DOJO_GRAPH_RUNTIME_TEST_FILES
      .filter((file) => file !== missingGraphRuntimeTestFile);
    graphRuntimeGate.release_artifact_requirements.require_rollback_runtime = false;
    graphRuntimeGate.release_artifact_requirements.require_proof_gate = false;
    expect(validateDojoReleaseGateManifest(brokenGraphRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "graph_runtime_missing_rollback_requirement",
      "graph_runtime_missing_proof_gate_requirement",
      "graph_runtime_missing_required_capabilities:graph_runtime_executes_available_rollback",
      `graph_runtime_missing_required_test_files:${missingGraphRuntimeTestFile}`,
    ]));

    const brokenGhostMode = JSON.parse(JSON.stringify(manifest));
    const ghostModeGate = brokenGhostMode.gates.find((gate) => gate.id === "dojo_ghost_mode_evidence_self_check");
    const missingGhostModeTestFile = DOJO_GHOST_MODE_EVIDENCE_TEST_FILES[0];
    ghostModeGate.release_artifact_requirements.required_ghost_mode_capabilities = DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
      .filter((capability) => capability !== "ghost_mode_runs_without_production_mutation");
    ghostModeGate.release_artifact_requirements.required_test_files = DOJO_GHOST_MODE_EVIDENCE_TEST_FILES
      .filter((file) => file !== missingGhostModeTestFile);
    ghostModeGate.release_artifact_requirements.require_non_mutating_shadow_run = false;
    ghostModeGate.release_artifact_requirements.require_tenant_boundary = false;
    ghostModeGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenGhostMode, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "ghost_mode_missing_non_mutating_requirement",
      "ghost_mode_missing_tenant_boundary_requirement",
      "ghost_mode_missing_postgres_env",
      "ghost_mode_missing_required_capabilities:ghost_mode_runs_without_production_mutation",
      `ghost_mode_missing_required_test_files:${missingGhostModeTestFile}`,
    ]));

    const brokenSkillPassport = JSON.parse(JSON.stringify(manifest));
    const skillPassportGate = brokenSkillPassport.gates.find((gate) => gate.id === "dojo_skill_passport_self_check");
    const missingSkillPassportTestFile = DOJO_SKILL_PASSPORT_TEST_FILES[0];
    skillPassportGate.release_artifact_requirements.required_skill_passport_capabilities = DOJO_SKILL_PASSPORT_CAPABILITIES
      .filter((capability) => capability !== "skill_passport_report_only_status");
    skillPassportGate.release_artifact_requirements.required_test_files = DOJO_SKILL_PASSPORT_TEST_FILES
      .filter((file) => file !== missingSkillPassportTestFile);
    skillPassportGate.release_artifact_requirements.require_report_only_status = false;
    skillPassportGate.release_artifact_requirements.require_raw_payload_redaction = false;
    expect(validateDojoReleaseGateManifest(brokenSkillPassport, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "skill_passport_missing_report_only_requirement",
      "skill_passport_missing_redaction_requirement",
      "skill_passport_missing_required_capabilities:skill_passport_report_only_status",
      `skill_passport_missing_required_test_files:${missingSkillPassportTestFile}`,
    ]));

    const brokenTimeMachine = JSON.parse(JSON.stringify(manifest));
    const timeMachineGate = brokenTimeMachine.gates.find((gate) => gate.id === "dojo_time_machine_debugger_self_check");
    const missingTimeMachineTestFile = DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES[0];
    timeMachineGate.release_artifact_requirements.required_time_machine_capabilities = DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
      .filter((capability) => capability !== "time_machine_replay_plan");
    timeMachineGate.release_artifact_requirements.required_test_files = DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES
      .filter((file) => file !== missingTimeMachineTestFile);
    timeMachineGate.release_artifact_requirements.require_replay_plan = false;
    timeMachineGate.release_artifact_requirements.require_honest_projection_status = false;
    expect(validateDojoReleaseGateManifest(brokenTimeMachine, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "time_machine_missing_replay_plan_requirement",
      "time_machine_missing_honest_status_requirement",
      "time_machine_missing_required_capabilities:time_machine_replay_plan",
      `time_machine_missing_required_test_files:${missingTimeMachineTestFile}`,
    ]));

    const brokenVivariumRuntime = JSON.parse(JSON.stringify(manifest));
    const vivariumRuntimeGate = brokenVivariumRuntime.gates.find((gate) => gate.id === "dojo_vivarium_runtime_self_check");
    const missingVivariumRuntimeTestFile = DOJO_VIVARIUM_RUNTIME_TEST_FILES[0];
    vivariumRuntimeGate.release_artifact_requirements.required_vivarium_runtime_capabilities = DOJO_VIVARIUM_RUNTIME_CAPABILITIES
      .filter((capability) => capability !== "evil_twin_hardening_reduces_attack_success_rate");
    vivariumRuntimeGate.release_artifact_requirements.required_test_files = DOJO_VIVARIUM_RUNTIME_TEST_FILES
      .filter((file) => file !== missingVivariumRuntimeTestFile);
    vivariumRuntimeGate.release_artifact_requirements.require_evil_twin_hardening_loop = false;
    vivariumRuntimeGate.release_artifact_requirements.require_executable_checkride = false;
    expect(validateDojoReleaseGateManifest(brokenVivariumRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "vivarium_runtime_missing_evil_twin_hardening_requirement",
      "vivarium_runtime_missing_checkride_requirement",
      "vivarium_runtime_missing_required_capabilities:evil_twin_hardening_reduces_attack_success_rate",
      `vivarium_runtime_missing_required_test_files:${missingVivariumRuntimeTestFile}`,
    ]));

    const brokenCheckrideLicense = JSON.parse(JSON.stringify(manifest));
    const checkrideLicenseGate = brokenCheckrideLicense.gates.find((gate) => gate.id === "dojo_checkride_license_self_check");
    const missingCheckrideLicenseTestFile = DOJO_CHECKRIDE_LICENSE_TEST_FILES[0];
    checkrideLicenseGate.release_artifact_requirements.required_checkride_license_capabilities = DOJO_CHECKRIDE_LICENSE_CAPABILITIES
      .filter((capability) => capability !== "checkride_runtime_oracle_blocks_happy_path_only");
    checkrideLicenseGate.release_artifact_requirements.required_test_files = DOJO_CHECKRIDE_LICENSE_TEST_FILES
      .filter((file) => file !== missingCheckrideLicenseTestFile);
    checkrideLicenseGate.release_artifact_requirements.require_executable_checkride = false;
    checkrideLicenseGate.release_artifact_requirements.require_ledger_append = false;
    checkrideLicenseGate.release_artifact_requirements.require_license_constraints = false;
    checkrideLicenseGate.release_artifact_requirements.require_stale_evidence_downgrade = false;
    expect(validateDojoReleaseGateManifest(brokenCheckrideLicense, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "checkride_license_missing_executable_requirement",
      "checkride_license_missing_ledger_append_requirement",
      "checkride_license_missing_license_constraint_requirement",
      "checkride_license_missing_stale_evidence_requirement",
      "checkride_license_missing_required_capabilities:checkride_runtime_oracle_blocks_happy_path_only",
      `checkride_license_missing_required_test_files:${missingCheckrideLicenseTestFile}`,
    ]));

    const brokenCaseLawRuntime = JSON.parse(JSON.stringify(manifest));
    const caseLawRuntimeGate = brokenCaseLawRuntime.gates.find((gate) => gate.id === "dojo_case_law_runtime_self_check");
    const missingCaseLawRuntimeTestFile = DOJO_CASE_LAW_RUNTIME_TEST_FILES[0];
    caseLawRuntimeGate.release_artifact_requirements.required_case_law_runtime_capabilities = DOJO_CASE_LAW_RUNTIME_CAPABILITIES
      .filter((capability) => capability !== "antibody_matcher_proposes_without_binding");
    caseLawRuntimeGate.release_artifact_requirements.required_test_files = DOJO_CASE_LAW_RUNTIME_TEST_FILES
      .filter((file) => file !== missingCaseLawRuntimeTestFile);
    caseLawRuntimeGate.release_artifact_requirements.require_antibody_matching = false;
    caseLawRuntimeGate.release_artifact_requirements.require_antibody_private_data_redaction = false;
    expect(validateDojoReleaseGateManifest(brokenCaseLawRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "case_law_runtime_missing_antibody_matching_requirement",
      "case_law_runtime_missing_antibody_private_data_requirement",
      "case_law_runtime_missing_required_capabilities:antibody_matcher_proposes_without_binding",
      `case_law_runtime_missing_required_test_files:${missingCaseLawRuntimeTestFile}`,
    ]));

    const brokenHostedRuntimeGateway = JSON.parse(JSON.stringify(manifest));
    const hostedRuntimeGatewayGate = brokenHostedRuntimeGateway.gates.find((gate) => gate.id === "dojo_hosted_runtime_gateway_self_check");
    const missingHostedRuntimeTestFile = DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES[0];
    hostedRuntimeGatewayGate.release_artifact_requirements.required_hosted_runtime_gateway_capabilities = DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
      .filter((capability) => capability !== "hosted_runtime_blocks_expired_and_revoked_sessions");
    hostedRuntimeGatewayGate.release_artifact_requirements.required_test_files = DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES
      .filter((file) => file !== missingHostedRuntimeTestFile);
    hostedRuntimeGatewayGate.release_artifact_requirements.require_revocation_and_expiry = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.require_evidence_write = false;
    expect(validateDojoReleaseGateManifest(brokenHostedRuntimeGateway, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "hosted_runtime_gateway_missing_revocation_expiry_requirement",
      "hosted_runtime_gateway_missing_evidence_requirement",
      "hosted_runtime_gateway_missing_required_capabilities:hosted_runtime_blocks_expired_and_revoked_sessions",
      `hosted_runtime_gateway_missing_required_test_files:${missingHostedRuntimeTestFile}`,
    ]));

    const brokenSecurity = JSON.parse(JSON.stringify(manifest));
    const securityGate = brokenSecurity.gates.find((gate) => gate.id === "security_abuse_suite");
    const missingSecurityTestFile = DOJO_SECURITY_ABUSE_TEST_FILES[0];
    securityGate.release_artifact_requirements.required_abuse_classes = DOJO_SECURITY_ABUSE_CLASSES.filter((abuseClass) => abuseClass !== "fake_success_oracle");
    securityGate.release_artifact_requirements.required_test_files = DOJO_SECURITY_ABUSE_TEST_FILES
      .filter((file) => file !== missingSecurityTestFile);
    securityGate.release_artifact_requirements.require_no_skipped_tests = false;
    expect(validateDojoReleaseGateManifest(brokenSecurity, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "security_abuse_missing_required_classes:fake_success_oracle",
      `security_abuse_missing_required_test_files:${missingSecurityTestFile}`,
      "security_abuse_missing_no_skipped_requirement",
    ]));

    const brokenCompliance = JSON.parse(JSON.stringify(manifest));
    const complianceGate = brokenCompliance.gates.find((gate) => gate.id === "compliance_export_suite");
    const missingComplianceTestFile = DOJO_COMPLIANCE_EXPORT_TEST_FILES[0];
    complianceGate.release_artifact_requirements.required_compliance_capabilities = DOJO_COMPLIANCE_EXPORT_CAPABILITIES
      .filter((capability) => capability !== "redacted_evidence_export");
    complianceGate.release_artifact_requirements.required_test_files = DOJO_COMPLIANCE_EXPORT_TEST_FILES
      .filter((file) => file !== missingComplianceTestFile);
    expect(validateDojoReleaseGateManifest(brokenCompliance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "compliance_export_missing_required_capabilities:redacted_evidence_export",
      `compliance_export_missing_required_test_files:${missingComplianceTestFile}`,
    ]));

    const brokenPrivacy = JSON.parse(JSON.stringify(manifest));
    const privacyGate = brokenPrivacy.gates.find((gate) => gate.id === "privacy_redaction_suite");
    const missingPrivacyTestFile = DOJO_PRIVACY_REDACTION_TEST_FILES[0];
    privacyGate.release_artifact_requirements.required_privacy_capabilities = DOJO_PRIVACY_REDACTION_CAPABILITIES
      .filter((capability) => capability !== "browser_origin_privacy_boundary");
    privacyGate.release_artifact_requirements.required_test_files = DOJO_PRIVACY_REDACTION_TEST_FILES
      .filter((file) => file !== missingPrivacyTestFile);
    expect(validateDojoReleaseGateManifest(brokenPrivacy, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "privacy_redaction_missing_required_capabilities:browser_origin_privacy_boundary",
      `privacy_redaction_missing_required_test_files:${missingPrivacyTestFile}`,
    ]));

    const brokenChaos = JSON.parse(JSON.stringify(manifest));
    const chaosGate = brokenChaos.gates.find((gate) => gate.id === "dojo_chaos_performance_self_check");
    const missingChaosTestFile = DOJO_CHAOS_PERFORMANCE_TEST_FILES[0];
    chaosGate.enterprise_artifact_requirements.required_chaos_scenarios = DOJO_CHAOS_SCENARIOS
      .filter((scenario) => scenario !== "api_timeout");
    chaosGate.enterprise_artifact_requirements.required_test_files = DOJO_CHAOS_PERFORMANCE_TEST_FILES
      .filter((file) => file !== missingChaosTestFile);
    chaosGate.enterprise_artifact_requirements.require_no_skipped_tests = false;
    expect(validateDojoReleaseGateManifest(brokenChaos, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "chaos_performance_missing_required_scenarios:api_timeout",
      `chaos_performance_missing_required_test_files:${missingChaosTestFile}`,
      "chaos_performance_missing_no_skipped_requirement",
    ]));

    const brokenSoak = JSON.parse(JSON.stringify(manifest));
    const soakGate = brokenSoak.gates.find((gate) => gate.id === "soak_performance");
    soakGate.enterprise_artifact_requirements.require_zero_errors = false;
    soakGate.enterprise_artifact_requirements.require_tool_latency_metrics = false;
    expect(validateDojoReleaseGateManifest(brokenSoak, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "soak_performance_missing_zero_error_requirement",
      "soak_performance_missing_tool_latency_requirement",
    ]));
  });

  it("keeps live, deployed, security, and soak gates out of the minimal PR gate", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));

    expect(new Set(manifest.minimal_pr_gate_ids.map((id) => gatesById.get(id)?.tier))).toEqual(new Set(["T0", "T1"]));
    expect(manifest.minimal_pr_gate_ids).not.toContain("dojo_mcp_host_conformance");
    expect(manifest.minimal_pr_gate_ids).not.toContain("soak_performance");
    expect(manifest.release_gate_ids).toEqual(expect.arrayContaining([
      "dojo_implementation_status_self_check",
      "workflow_e2e_hosted",
      "dojo_mcp_host_conformance",
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
    ]));
  });

  it("builds digest evidence for the emitted manifest", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const serialized = JSON.stringify(manifest, null, 2);
    const evidence = buildDojoReleaseGateEvidenceManifest({
      manifest,
      manifestPath: "/tmp/dojo-release-gate-manifest.json",
      serialized,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.releaseGateEvidence.v1",
      manifest_path: "/tmp/dojo-release-gate-manifest.json",
      manifest_bytes: Buffer.byteLength(serialized),
      validation_ok: true,
      tier_count: 9,
      gate_count: manifest.gates.length,
      minimal_pr_gate_count: manifest.minimal_pr_gate_ids.length,
      milestone_gate_count: manifest.milestone_gate_ids.length,
      release_gate_count: manifest.release_gate_ids.length,
      visual_report_gate_count: 2,
      visual_report_gate_ids: ["dojo_full_visual_proof", "dojo_ghost_mode_visual_proof"],
      proof_artifact_gate_count: 31,
      proof_artifact_gate_ids: expect.arrayContaining([
        "dojo_implementation_status_self_check",
        "dojo_self_check",
        "dojo_postgres_control_plane_self_check",
        "dojo_evidence_authority_self_check",
        "dojo_mcp_host_conformance_self_check",
        "dojo_source_drift_self_check",
        "dojo_agent_ready_ui_contract_self_check",
        "dojo_api_tool_compiler_self_check",
        "docker_integration",
        "workflow_e2e_hosted",
        "dojo_mcp_host_conformance",
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
        "compliance_export_suite",
        "privacy_redaction_suite",
      ]),
    }));
    expect(evidence.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates visual proof reports against pixel and layout evidence requirements", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gate = manifest.gates.find((item) => item.id === "dojo_full_visual_proof");
    const validReport = {
      schema_version: "synthi.dojo.visualProof.v1",
      ok: true,
      results: [
        {
          route_id: "practice-world",
          viewport: "mobile",
          ok: true,
          failed_visual_gates: [],
          screenshot_path: "/tmp/practice-world-mobile.png",
          bytes: 120_000,
          image_metrics: {
            pixel_metrics_verified: true,
            unique_color_sample_count: 96,
            background_diff_pixel_ratio: 0.41,
            luma_stddev: 22,
          },
          layout_metrics: {
            horizontal_overflow_px: 0,
            selector_visible_area_px: 468_000,
          },
          screenshot_sha256: "0".repeat(64),
        },
      ],
    };

    expect(validateDojoVisualProofReport(validReport, { gate })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: 1,
    }));

    const rejectedReport = {
      ...validReport,
      ok: false,
      results: [
        {
          ...validReport.results[0],
          ok: false,
          failed_visual_gates: ["horizontal_overflow"],
          image_metrics: { pixel_metrics_verified: false },
          layout_metrics: { horizontal_overflow_px: 125 },
        },
      ],
    };

    expect(validateDojoVisualProofReport(rejectedReport, { gate }).errors).toEqual(expect.arrayContaining([
      "visual_report_not_ok",
      "visual_result_not_ok:practice-world",
      "visual_result_failed_gates:practice-world:horizontal_overflow",
      "visual_result_pixel_metrics_unverified:practice-world",
      "visual_result_horizontal_overflow:practice-world:125",
    ]));
  });
});
