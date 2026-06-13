// @ts-nocheck
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
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "../../scripts/dojo-postgres-control-plane-self-check.mjs";
import {
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
  DOJO_PRIVACY_REDACTION_TEST_FILES,
} from "../../scripts/dojo-privacy-redaction-self-check.mjs";
import {
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "../../scripts/dojo-security-abuse-self-check.mjs";

const PACKAGE_SCRIPTS = {
  "mcp/synthi-mcp/package.json": {
    typecheck: "tsc --noEmit",
    build: "tsc",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:dojo:postgres-control-plane": "vitest run tests/integration/dojo_postgres_schema.test.ts tests/integration/dojo_postgres_proof_store.test.ts tests/integration/dojo_evidence_ledger_store.test.ts tests/integration/dojo_audit_store.test.ts tests/integration/dojo_postgres_governance_store.test.ts tests/integration/dojo_postgres_source_registry_store.test.ts tests/integration/dojo_postgres_mcp_skill_bus_store.test.ts tests/integration/dojo_proof_ledger_tool.test.ts",
    "proof:dojo:self-check": "node scripts/dojo-proof-self-check.mjs",
    "proof:dojo:mcp-host-conformance:self-check": "node scripts/dojo-mcp-host-conformance.mjs --self-check",
    "proof:dojo:docker-integration:self-check": "node scripts/dojo-docker-integration-self-check.mjs",
    "proof:dojo:postgres-control-plane:self-check": "node scripts/dojo-postgres-control-plane-self-check.mjs",
    "proof:dojo:affordance-codemod:self-check": "node scripts/dojo-affordance-codemod-self-check.mjs",
    "proof:dojo:security-abuse:self-check": "node scripts/dojo-security-abuse-self-check.mjs",
    "proof:dojo:compliance-export:self-check": "node scripts/dojo-compliance-export-self-check.mjs",
    "proof:dojo:privacy-redaction:self-check": "node scripts/dojo-privacy-redaction-self-check.mjs",
    "proof:dojo:chaos-performance:self-check": "node scripts/dojo-chaos-performance-self-check.mjs",
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
        id: "dojo_affordance_codemod_self_check",
        tier: "T2",
        package_script: "proof:dojo:affordance-codemod:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
        evidence_schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
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
      "workflow_e2e_hosted",
      "dojo_mcp_host_conformance",
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
      proof_artifact_gate_count: 13,
      proof_artifact_gate_ids: expect.arrayContaining([
        "dojo_self_check",
        "dojo_postgres_control_plane_self_check",
        "dojo_mcp_host_conformance_self_check",
        "docker_integration",
        "workflow_e2e_hosted",
        "dojo_mcp_host_conformance",
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
