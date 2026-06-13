// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateEvidenceManifest,
  buildDojoReleaseGateManifest,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
} from "../../scripts/dojo-mcp-host-conformance.mjs";
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
import {
  validateDojoProofSelfCheckForRelease,
  validateDojoMcpHostConformanceReportForRelease,
  validateDojoPrivateToolCodexAcceptanceForRelease,
  validateDojoPrivateToolCodexHostConformanceForRelease,
  validateDojoPrivateToolStdioAcceptanceForRelease,
  validateDojoPrivateToolStdioHostConformanceForRelease,
  validateDojoDockerIntegrationEvidenceForMilestone,
  validateDojoPostgresControlPlaneEvidenceForMilestone,
  validateDojoWorkflowPipelineE2EForRelease,
  validateDojoChaosPerformanceEvidenceForEnterprise,
  validateDojoComplianceExportEvidenceForRelease,
  validateDojoPrivacyRedactionEvidenceForRelease,
  validateDojoSecurityAbuseEvidenceForRelease,
  validateDojoSoakPerformanceSummary,
  verifyDojoChaosPerformanceEvidenceArtifact,
  verifyDojoComplianceExportEvidenceArtifact,
  verifyDojoDockerIntegrationEvidenceArtifact,
  verifyDojoMcpHostConformanceArtifacts,
  verifyDojoPrivateToolCodexAcceptanceArtifact,
  verifyDojoPrivateToolCodexHostConformanceArtifact,
  verifyDojoPrivateToolStdioAcceptanceArtifact,
  verifyDojoPrivateToolStdioHostConformanceArtifact,
  verifyDojoPostgresControlPlaneEvidenceArtifact,
  verifyDojoProofSelfCheckArtifacts,
  verifyDojoReleaseGateArtifactsFromArgs,
  verifyDojoReleaseGateManifestArtifacts,
  verifyDojoPrivacyRedactionEvidenceArtifact,
  verifyDojoSecurityAbuseEvidenceArtifact,
  verifyDojoSoakPerformanceArtifacts,
  verifyDojoWorkflowPipelineE2EArtifact,
  verifyVisualProofArtifact,
} from "../../scripts/dojo-release-gate-verify.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

describe("Dojo release gate artifact verifier", () => {
  it("verifies manifest evidence digests and rejects tampered manifest bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-verify-"));
    const packageScripts = await readPackageScripts();
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest, manifestPath, evidencePath });

    expect(await verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
    }));

    const tampered = {
      ...manifest,
      gates: manifest.gates.filter((gate) => gate.id !== "dojo_mcp_host_conformance"),
    };
    await writeFile(manifestPath, JSON.stringify(tampered, null, 2), "utf8");
    const rejected = await verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^manifest_sha256_mismatch:/),
      expect.stringMatching(/^manifest_invalid:unknown_release_gate_ids:dojo_mcp_host_conformance/),
    ]));
  });

  it("requires release-candidate MCP host conformance to be real production execution", () => {
    const valid = buildConformanceReport();
    expect(validateDojoMcpHostConformanceReportForRelease(valid)).toEqual({
      ok: true,
      errors: [],
    });

    const selfCheck = buildConformanceReport({
      schemaVersion: "synthi.dojo.mcpHostConformance.selfCheck.v1",
    });
    expect(validateDojoMcpHostConformanceReportForRelease(selfCheck).errors).toEqual(expect.arrayContaining([
      "conformance_schema_not_release:synthi.dojo.mcpHostConformance.selfCheck.v1",
      "conformance_self_check_schema_not_release_evidence",
    ]));

    const dryRun = buildConformanceReport({ executeProduction: false });
    expect(validateDojoMcpHostConformanceReportForRelease(dryRun).errors).toEqual(expect.arrayContaining([
      "conformance_execute_production_missing",
      "conformance_production_execution_step_missing",
    ]));

    const missingDeploymentClaims = buildConformanceReport({
      deploymentClaims: {
        ...mcpHostDeploymentClaimsFixture(),
        require_external_proof_signing: false,
        external_proof_signing: false,
        no_local_cdp_leakage: false,
      },
    });
    expect(validateDojoMcpHostConformanceReportForRelease(missingDeploymentClaims).errors).toEqual(expect.arrayContaining([
      "conformance_external_proof_signing_requirement_missing",
      "conformance_external_proof_signing_missing",
      "conformance_no_local_cdp_leakage_missing",
    ]));

    const missingRevocationPropagation = buildConformanceReport({
      steps: buildConformanceSteps()
        .filter((step) => step.name !== "revoked proof validation blocked"),
    });
    expect(validateDojoMcpHostConformanceReportForRelease(missingRevocationPropagation).errors).toEqual(expect.arrayContaining([
      "conformance_release_gate_not_ok",
      "conformance_release_gate_failed:1",
      "conformance_revoked_validation_block_step_missing",
    ]));
  });

  it("verifies Dojo proof self-check production proof consumption and runtime custody", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-proof-self-check-verify-"));
    const artifacts = await writeProofSelfCheckFixture({ dir });

    expect(validateDojoProofSelfCheckForRelease(artifacts.summary, artifacts.productionEvidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoProofSelfCheckArtifacts({
      summaryPath: artifacts.summaryPath,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      evidence_path: artifacts.productionEvidencePath,
      visual_evidence_path: artifacts.visualEvidencePath,
      visual_screenshot_path: artifacts.visualScreenshotPath,
    }));

    const rejectedArtifacts = await writeProofSelfCheckFixture({
      dir,
      basename: "dojo-proof-self-check-rejected",
      summary: proofSelfCheckSummaryFixture({
        production_proof_consumed: false,
        production_proof_replay_blocked: false,
      }),
      productionEvidence: productionRuntimeEvidenceFixture({
        proof_consumed: false,
        replay_blocked: false,
        runtime_session: {
          ...productionRuntimeEvidenceFixture().runtime_session,
          redaction_policy: { screenshots: false },
        },
      }),
    });
    const rejected = await verifyDojoProofSelfCheckArtifacts({
      summaryPath: rejectedArtifacts.summaryPath,
      productionEvidencePath: rejectedArtifacts.productionEvidencePath,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "dojo_self_check_production_proof_not_consumed",
      "dojo_self_check_replay_not_blocked",
      "dojo_self_check_evidence_proof_not_consumed",
      "dojo_self_check_evidence_replay_not_blocked",
      "dojo_self_check_runtime_screenshot_privacy_missing",
    ]));

    const rejectedVisualArtifacts = await writeProofSelfCheckFixture({
      dir,
      basename: "dojo-proof-self-check-visual-rejected",
      visualEvidence: proofSelfCheckVisualEvidenceFixture({
        ok: false,
        screenshot_bytes: 1,
        checks: {
          ...proofSelfCheckVisualEvidenceFixture().checks,
          has_proof_capsule: false,
        },
        failed_visual_gates: ["proof_capsule_missing"],
        image_metrics: {
          ...proofSelfCheckVisualEvidenceFixture().image_metrics,
          pixel_metrics_verified: false,
          unique_color_sample_count: 1,
        },
        layout_metrics: {
          ...proofSelfCheckVisualEvidenceFixture().layout_metrics,
          horizontal_overflow_px: 12,
        },
      }),
    });
    const rejectedVisual = await verifyDojoProofSelfCheckArtifacts({
      summaryPath: rejectedVisualArtifacts.summaryPath,
      productionEvidencePath: rejectedVisualArtifacts.productionEvidencePath,
    });
    expect(rejectedVisual.ok).toBe(false);
    expect(rejectedVisual.errors).toEqual(expect.arrayContaining([
      "dojo_self_check_visual_evidence_not_ok",
      "dojo_self_check_visual_failed_gates:proof_capsule_missing",
      "dojo_self_check_visual_required_check_failed:has_proof_capsule",
      "dojo_self_check_visual_pixel_metrics_missing",
      "dojo_self_check_visual_unique_color_budget_failed:1",
      "dojo_self_check_visual_horizontal_overflow:12",
      expect.stringMatching(/^dojo_self_check_visual_screenshot_bytes_mismatch:/),
    ]));
  });

  it("verifies Postgres control-plane evidence and rejects skipped capability coverage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-postgres-control-plane-verify-"));
    const evidencePath = await writePostgresControlPlaneEvidenceFixture({ dir });
    const evidence = await readJson(evidencePath);

    expect(validateDojoPostgresControlPlaneEvidenceForMilestone(evidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoPostgresControlPlaneEvidenceArtifact({ evidencePath })).toEqual(expect.objectContaining({
      id: "dojo_postgres_control_plane_self_check",
      ok: true,
      errors: [],
      evidence_path: evidencePath,
    }));

    const rejectedPath = await writePostgresControlPlaneEvidenceFixture({
      dir,
      basename: "dojo-postgres-control-plane-rejected",
      evidence: postgresControlPlaneEvidenceFixture({
        ok: false,
        capability_coverage_complete: false,
        missing_capabilities: ["atomic_proof_consume"],
        budget_evaluation: { ok: false },
        test_summary: {
          ...postgresControlPlaneEvidenceFixture().test_summary,
          pending_tests: 1,
        },
      }),
    });
    const rejected = await verifyDojoPostgresControlPlaneEvidenceArtifact({ evidencePath: rejectedPath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "postgres_control_plane_not_ok",
      "postgres_control_plane_capability_coverage_incomplete",
      "postgres_control_plane_missing_capabilities:atomic_proof_consume",
      "postgres_control_plane_budget_not_ok",
      "postgres_control_plane_pending_tests:1",
    ]));

    const driftedPath = await writePostgresControlPlaneEvidenceFixture({
      dir,
      basename: "dojo-postgres-control-plane-drifted",
      evidence: postgresControlPlaneEvidenceFixture({
        test_files: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES
          .filter((file) => file !== DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES[0]),
        test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length - 1,
        configured_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
          .filter((capability) => capability !== "atomic_proof_consume"),
        tested_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
          .filter((capability) => capability !== "atomic_proof_consume"),
        capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length - 1,
      }),
    });
    const drifted = await verifyDojoPostgresControlPlaneEvidenceArtifact({ evidencePath: driftedPath });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      "postgres_control_plane_required_capabilities_missing:atomic_proof_consume",
      "postgres_control_plane_required_capabilities_untested:atomic_proof_consume",
      `postgres_control_plane_required_test_files_missing:${DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES[0]}`,
    ]));
  });

  it("verifies Docker integration evidence and rejects skipped compose or unhealthy stack state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-docker-integration-verify-"));
    const evidencePath = await writeDockerIntegrationEvidenceFixture({ dir });
    const evidence = await readJson(evidencePath);

    expect(validateDojoDockerIntegrationEvidenceForMilestone(evidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoDockerIntegrationEvidenceArtifact({ evidencePath })).toEqual(expect.objectContaining({
      id: "docker_integration",
      ok: true,
      errors: [],
      evidence_path: evidencePath,
      service_count: 11,
      endpoint_count: 2,
    }));

    const rejectedPath = await writeDockerIntegrationEvidenceFixture({
      dir,
      basename: "dojo-docker-integration-rejected",
      evidence: dockerIntegrationEvidenceFixture({
        ok: false,
        docker_compose_up_ran: false,
        docker_compose_up_skipped: true,
        running_services: ["frontend"],
        missing_services: ["mcp"],
        unhealthy_services: ["postgres"],
        endpoint_ok_count: 1,
        endpoint_checks: [
          dockerEndpointFixture({ id: "frontend_workspace" }),
          dockerEndpointFixture({ id: "collab_ports", ok: false, status: 503 }),
        ],
        service_evaluation: {
          ...dockerServiceEvaluationFixture(),
          missing_services: ["mcp"],
          stopped_services: ["worker"],
        },
        budget_evaluation: {
          ok: false,
          failed_checks: ["all_required_services_present", "required_endpoints_ok"],
        },
      }),
    });
    const rejected = await verifyDojoDockerIntegrationEvidenceArtifact({ evidencePath: rejectedPath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "docker_integration_not_ok",
      "docker_integration_compose_up_not_run",
      "docker_integration_compose_up_skipped",
      "docker_integration_missing_services:mcp",
      "docker_integration_stopped_services:worker",
      "docker_integration_unhealthy_services:postgres",
      "docker_integration_running_service_count_mismatch:1:11",
      "docker_integration_endpoint_count_mismatch:1:2",
      "docker_integration_endpoint_failed:collab_ports:503",
      "docker_integration_budget_not_ok",
      "docker_integration_failed_checks:all_required_services_present,required_endpoints_ok",
    ]));

    const driftedPath = await writeDockerIntegrationEvidenceFixture({
      dir,
      basename: "dojo-docker-integration-drifted",
      evidence: dockerIntegrationEvidenceFixture({
        required_services: DOJO_DOCKER_REQUIRED_SERVICES.filter((service) => service !== "mcp"),
        required_service_count: DOJO_DOCKER_REQUIRED_SERVICES.length - 1,
        running_services: DOJO_DOCKER_REQUIRED_SERVICES.filter((service) => service !== "mcp"),
        healthy_services_required: DOJO_DOCKER_HEALTHY_SERVICES.filter((service) => service !== "postgres"),
        endpoint_checks: DOJO_DOCKER_REQUIRED_ENDPOINTS
          .filter((endpoint) => endpoint.id !== "collab_ports")
          .map((endpoint) => dockerEndpointFixture({ id: endpoint.id, expectedStatus: endpoint.expected_status })),
        endpoint_count: DOJO_DOCKER_REQUIRED_ENDPOINTS.length - 1,
        endpoint_ok_count: DOJO_DOCKER_REQUIRED_ENDPOINTS.length - 1,
      }),
    });
    const drifted = await verifyDojoDockerIntegrationEvidenceArtifact({ evidencePath: driftedPath });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      "docker_integration_required_services_missing:mcp",
      "docker_integration_required_services_not_running:mcp",
      "docker_integration_required_healthy_services_missing:postgres",
      "docker_integration_required_endpoints_missing:collab_ports",
    ]));
  });

  it("verifies live hosted runtime acceptance artifacts for release candidates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-live-hosted-runtime-verify-"));
    const workflow = await writeWorkflowE2EFixture({ dir });
    const stdio = await writePrivateToolStdioAcceptanceFixture({ dir });
    const codex = await writePrivateToolCodexAcceptanceFixture({ dir });

    expect(validateDojoWorkflowPipelineE2EForRelease(workflow.report)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoWorkflowPipelineE2EArtifact({
      summaryPath: workflow.reportPath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    expect(validateDojoPrivateToolStdioAcceptanceForRelease(stdio.transcript)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoPrivateToolStdioAcceptanceArtifact({
      transcriptPath: stdio.transcriptPath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    expect(validateDojoPrivateToolCodexAcceptanceForRelease(codex.transcript)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoPrivateToolCodexAcceptanceArtifact({
      transcriptPath: codex.transcriptPath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const staleWorkflow = workflowE2EFixture({
      hosted_runtime: {
        ...workflow.report.hosted_runtime,
        non_loopback_runtime: false,
        runtime_host_class: "loopback",
      },
      fresh_mcp: {
        ...workflow.report.fresh_mcp,
        verify_fresh_mcp: false,
      },
    });
    expect(validateDojoWorkflowPipelineE2EForRelease(staleWorkflow).errors).toEqual(expect.arrayContaining([
      "workflow_e2e_runtime_not_remote:loopback",
      "workflow_e2e_fresh_mcp_not_enabled",
    ]));

    const unsafeCodex = privateToolCodexAcceptanceFixture({
      codex: {
        ...codex.transcript.codex,
        mcp_evidence: {
          ...codex.transcript.codex.mcp_evidence,
          local_attach_call: true,
          command_execution_count: 1,
        },
      },
    });
    expect(validateDojoPrivateToolCodexAcceptanceForRelease(unsafeCodex).errors).toEqual(expect.arrayContaining([
      "private_tool_codex_local_attach_used",
      "private_tool_codex_shell_commands_used:1",
    ]));
  });

  it("requires deployed private-tool host conformance to use external stores and non-loopback targets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-private-tool-host-conformance-verify-"));
    const stdioScreenshotPath = path.join(dir, "private-tool-stdio-host.png");
    const stdio = await writePrivateToolStdioAcceptanceFixture({
      dir,
      basename: "private-tool-stdio-host",
      transcript: privateToolStdioAcceptanceFixture(deployedPrivateToolHostFixtureOverrides({
        screenshotPath: stdioScreenshotPath,
        conformance: {
          require_custom_mcp_command: true,
          custom_mcp_command: true,
        },
        mcp_server: {
          command: "node",
          cwd: "/opt/synthi/mcp",
          args_count: 2,
          default_repo_dist: false,
        },
      })),
    });
    const codexScreenshotPath = path.join(dir, "private-tool-codex-host.png");
    const codex = await writePrivateToolCodexAcceptanceFixture({
      dir,
      basename: "private-tool-codex-host",
      transcript: privateToolCodexAcceptanceFixture(deployedPrivateToolHostFixtureOverrides({
        screenshotPath: codexScreenshotPath,
      })),
    });

    expect(validateDojoPrivateToolStdioHostConformanceForRelease(stdio.transcript)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoPrivateToolStdioHostConformanceArtifact({
      transcriptPath: stdio.transcriptPath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "private_tool_stdio_host_conformance",
      ok: true,
      errors: [],
    }));

    expect(validateDojoPrivateToolCodexHostConformanceForRelease(codex.transcript)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoPrivateToolCodexHostConformanceArtifact({
      transcriptPath: codex.transcriptPath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "private_tool_codex_host_conformance",
      ok: true,
      errors: [],
    }));

    const weakStdio = privateToolStdioAcceptanceFixture({
      target_url: "http://127.0.0.1:3000/private-tool",
      conformance: {
        require_non_loopback_runtime: true,
        non_loopback_runtime: true,
        runtime_host_class: "remote",
        require_external_private_tool_store: true,
        external_private_tool_store: false,
        require_custom_mcp_command: true,
        custom_mcp_command: false,
      },
      private_tool_store: {
        external: false,
        file: "redacted-private-tools.enc.json",
        scope: "acceptance-fixture",
      },
      mcp_server: {
        command: "node",
        cwd: MCP_ROOT,
        args_count: 1,
        default_repo_dist: true,
      },
    });
    expect(validateDojoPrivateToolStdioHostConformanceForRelease(weakStdio).errors).toEqual(expect.arrayContaining([
      "private_tool_stdio_host_external_store_missing",
      "private_tool_stdio_host_custom_mcp_command_missing",
      "private_tool_stdio_host_target_not_remote:loopback",
    ]));
  });

  it("includes manifest-declared Dojo proof self-check artifacts in release candidate verification", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-candidate-self-check-"));
    const selfCheck = await writeProofSelfCheckFixture({ dir });
    const postgresEvidencePath = await writePostgresControlPlaneEvidenceFixture({ dir });
    const dockerEvidencePath = await writeDockerIntegrationEvidenceFixture({ dir });
    const conformanceReportPath = path.join(dir, "dojo-mcp-host-conformance.json");
    const conformanceEvidencePath = path.join(dir, "dojo-mcp-host-conformance.evidence.json");
    await writeConformancePair({
      report: buildConformanceReport(),
      reportPath: conformanceReportPath,
      evidencePath: conformanceEvidencePath,
    });
    const securityEvidencePath = await writeSecurityEvidenceFixture({ dir });
    const complianceEvidencePath = await writeComplianceExportEvidenceFixture({ dir });
    const privacyEvidencePath = await writePrivacyRedactionEvidenceFixture({ dir });
    const workflowE2E = await writeWorkflowE2EFixture({ dir });
    const stdioAcceptance = await writePrivateToolStdioAcceptanceFixture({ dir });
    const codexAcceptance = await writePrivateToolCodexAcceptanceFixture({ dir });
    const stdioHostScreenshotPath = path.join(dir, "private-tool-stdio-host-conformance.png");
    const stdioHostConformance = await writePrivateToolStdioAcceptanceFixture({
      dir,
      basename: "private-tool-stdio-host-conformance",
      transcript: privateToolStdioAcceptanceFixture(deployedPrivateToolHostFixtureOverrides({
        screenshotPath: stdioHostScreenshotPath,
        conformance: {
          require_custom_mcp_command: true,
          custom_mcp_command: true,
        },
        mcp_server: {
          command: "node",
          cwd: "/opt/synthi/mcp",
          args_count: 2,
          default_repo_dist: false,
        },
      })),
    });
    const codexHostScreenshotPath = path.join(dir, "private-tool-codex-host-conformance.png");
    const codexHostConformance = await writePrivateToolCodexAcceptanceFixture({
      dir,
      basename: "private-tool-codex-host-conformance",
      transcript: privateToolCodexAcceptanceFixture(deployedPrivateToolHostFixtureOverrides({
        screenshotPath: codexHostScreenshotPath,
      })),
    });

    const packageScripts = await readPackageScripts();
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const selfCheckGate = manifest.gates.find((gate) => gate.id === "dojo_self_check");
    selfCheckGate.default_report_path = selfCheck.summaryPath;
    selfCheckGate.default_evidence_path = selfCheck.productionEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_postgres_control_plane_self_check").default_evidence_path = postgresEvidencePath;
    manifest.gates.find((gate) => gate.id === "docker_integration").default_evidence_path = dockerEvidencePath;
    manifest.gates.find((gate) => gate.id === "compliance_export_suite").default_evidence_path = complianceEvidencePath;
    manifest.gates.find((gate) => gate.id === "privacy_redaction_suite").default_evidence_path = privacyEvidencePath;
    manifest.gates.find((gate) => gate.id === "workflow_e2e_hosted").default_report_path = workflowE2E.reportPath;
    manifest.gates.find((gate) => gate.id === "private_tool_stdio_acceptance").default_report_path = stdioAcceptance.transcriptPath;
    manifest.gates.find((gate) => gate.id === "private_tool_codex_acceptance").default_report_path = codexAcceptance.transcriptPath;
    manifest.gates.find((gate) => gate.id === "private_tool_stdio_host_conformance").default_report_path = stdioHostConformance.transcriptPath;
    manifest.gates.find((gate) => gate.id === "private_tool_codex_host_conformance").default_report_path = codexHostConformance.transcriptPath;
    for (const gate of manifest.gates.filter((item) => item.evidence_kind === "visual_report")) {
      const visual = await writeVisualReportFixture({
        dir,
        basename: gate.id,
        schemaVersion: gate.report_schema_version,
      });
      gate.default_report_path = visual.reportPath;
    }
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest, manifestPath, evidencePath });

    const verified = await verifyDojoReleaseGateArtifactsFromArgs({
      args: {
        "release-candidate": "1",
        manifest: manifestPath,
        evidence: evidencePath,
        "mcp-host-conformance-report": conformanceReportPath,
        "mcp-host-conformance-evidence": conformanceEvidencePath,
        "security-abuse-evidence": securityEvidencePath,
      },
    });

    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(verified.dojo_self_check).toEqual([
      expect.objectContaining({
        id: "dojo_self_check",
        ok: true,
        artifact_path: selfCheck.summaryPath,
        evidence_path: selfCheck.productionEvidencePath,
      }),
    ]);
    expect(verified.postgres_control_plane).toEqual([
      expect.objectContaining({
        id: "dojo_postgres_control_plane_self_check",
        ok: true,
        evidence_path: postgresEvidencePath,
      }),
    ]);
    expect(verified.docker_integration).toEqual([
      expect.objectContaining({
        id: "docker_integration",
        ok: true,
        evidence_path: dockerEvidencePath,
      }),
    ]);
    expect(verified.visual_reports).toHaveLength(2);
    expect(verified.visual_reports.every((report) => report.ok)).toBe(true);
    expect(verified.live_hosted_runtime).toHaveLength(3);
    expect(verified.live_hosted_runtime.map((report) => report.id)).toEqual([
      "workflow_e2e_hosted",
      "private_tool_stdio_acceptance",
      "private_tool_codex_acceptance",
    ]);
    expect(verified.live_hosted_runtime.every((report) => report.ok)).toBe(true);
    expect(verified.mcp_host_conformance.map((report) => report.id)).toEqual([
      "dojo_mcp_host_conformance",
      "private_tool_stdio_host_conformance",
      "private_tool_codex_host_conformance",
    ]);
    expect(verified.mcp_host_conformance.every((report) => report.ok)).toBe(true);
    expect(verified.compliance_export).toEqual([
      expect.objectContaining({
        id: "compliance_export_suite",
        ok: true,
        evidence_path: complianceEvidencePath,
      }),
    ]);
    expect(verified.privacy_redaction).toEqual([
      expect.objectContaining({
        id: "privacy_redaction_suite",
        ok: true,
        evidence_path: privacyEvidencePath,
      }),
    ]);
  });

  it("verifies MCP host conformance evidence hashes before release promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-mcp-conformance-verify-"));
    const report = buildConformanceReport();
    const reportPath = path.join(dir, "dojo-mcp-host-conformance.json");
    const evidencePath = path.join(dir, "dojo-mcp-host-conformance.evidence.json");
    await writeConformancePair({ report, reportPath, evidencePath });

    expect(await verifyDojoMcpHostConformanceArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    await writeFile(reportPath, JSON.stringify({ ...report, config: { ...report.config, execute_production: false } }, null, 2), "utf8");
    const rejected = await verifyDojoMcpHostConformanceArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^report_sha256_mismatch:/),
      "conformance_execute_production_missing",
    ]));
  });

  it("verifies security abuse evidence coverage and referenced log digests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-security-abuse-verify-"));
    const evidencePath = await writeSecurityEvidenceFixture({ dir });

    expect(validateDojoSecurityAbuseEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoSecurityAbuseEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = securityEvidenceFixture({
      ok: false,
      abuse_class_coverage_complete: false,
      missing_abuse_classes: ["raw_private_tool_bypass"],
    });
    const incompletePath = await writeSecurityEvidenceFixture({ dir, basename: "incomplete-security", evidence: incomplete });
    const rejected = await verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "security_abuse_not_ok",
      "security_abuse_coverage_incomplete",
      "security_abuse_missing_classes:raw_private_tool_bypass",
    ]));

    const skipped = securityEvidenceFixture({
      ok: false,
      budget_evaluation: { ok: false },
      test_summary: {
        total_tests: DOJO_SECURITY_ABUSE_CLASSES.length + 1,
        passed_tests: DOJO_SECURITY_ABUSE_CLASSES.length,
        failed_tests: 0,
        pending_tests: 1,
      },
    });
    const skippedPath = await writeSecurityEvidenceFixture({ dir, basename: "skipped-security", evidence: skipped });
    const skippedResult = await verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath: skippedPath });
    expect(skippedResult.errors).toEqual(expect.arrayContaining([
      "security_abuse_not_ok",
      "security_abuse_budget_not_ok",
      "security_abuse_pending_tests:1",
    ]));

    const driftedSecurityTestFilePath = await writeSecurityEvidenceFixture({
      dir,
      basename: "drifted-security-test-file",
      evidence: securityEvidenceFixture({
        test_files: DOJO_SECURITY_ABUSE_TEST_FILES
          .filter((file) => file !== DOJO_SECURITY_ABUSE_TEST_FILES[0]),
        test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length - 1,
      }),
    });
    const driftedSecurityTestFile = await verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath: driftedSecurityTestFilePath });
    expect(driftedSecurityTestFile.errors).toEqual(expect.arrayContaining([
      `security_abuse_required_test_files_missing:${DOJO_SECURITY_ABUSE_TEST_FILES[0]}`,
    ]));

    const tamperedStdout = path.join(dir, "tampered-security.stdout.log");
    await writeFile(tamperedStdout, "tampered stdout", "utf8");
    const tamperedPath = await writeSecurityEvidenceFixture({
      dir,
      basename: "tampered-security",
      evidence: securityEvidenceFixture({ stdout_path: tamperedStdout }),
      writeLogs: false,
    });
    const tampered = await verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath: tamperedPath });
    expect(tampered.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^stdout_sha256_mismatch:/),
      expect.stringMatching(/^stdout_bytes_mismatch:/),
    ]));

    const tamperedJson = path.join(dir, "tampered-security.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedSecurityJson = securityJsonReportFixtureText();
    const tamperedJsonPath = await writeSecurityEvidenceFixture({
      dir,
      basename: "tampered-security-json",
      evidence: securityEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedSecurityJson),
        json_report_bytes: Buffer.byteLength(expectedSecurityJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies compliance export evidence coverage and referenced log digests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-compliance-export-verify-"));
    const evidencePath = await writeComplianceExportEvidenceFixture({ dir });

    expect(validateDojoComplianceExportEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoComplianceExportEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = complianceExportEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["redacted_evidence_export"],
      budget_evaluation: { ok: false },
      test_summary: {
        ...complianceExportEvidenceFixture().test_summary,
        pending_tests: 1,
      },
    });
    const incompletePath = await writeComplianceExportEvidenceFixture({ dir, basename: "incomplete-compliance", evidence: incomplete });
    const rejected = await verifyDojoComplianceExportEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "compliance_export_not_ok",
      "compliance_export_coverage_incomplete",
      "compliance_export_missing_capabilities:redacted_evidence_export",
      "compliance_export_budget_not_ok",
      "compliance_export_pending_tests:1",
    ]));

    const driftedPath = await writeComplianceExportEvidenceFixture({
      dir,
      basename: "drifted-compliance",
      evidence: complianceExportEvidenceFixture({
        test_files: DOJO_COMPLIANCE_EXPORT_TEST_FILES
          .filter((file) => file !== DOJO_COMPLIANCE_EXPORT_TEST_FILES[0]),
        test_file_count: DOJO_COMPLIANCE_EXPORT_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_COMPLIANCE_EXPORT_TEST_FILES.length - 1,
        configured_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.filter((capability) => capability !== "source_ref_redaction"),
        tested_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.filter((capability) => capability !== "source_ref_redaction"),
        capability_count: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.length - 1,
      }),
    });
    expect((await verifyDojoComplianceExportEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "compliance_export_required_capabilities_missing:source_ref_redaction",
      "compliance_export_required_capabilities_untested:source_ref_redaction",
      `compliance_export_required_test_files_missing:${DOJO_COMPLIANCE_EXPORT_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-compliance.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedComplianceJson = complianceExportJsonReportFixtureText();
    const tamperedJsonPath = await writeComplianceExportEvidenceFixture({
      dir,
      basename: "tampered-compliance-json",
      evidence: complianceExportEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedComplianceJson),
        json_report_bytes: Buffer.byteLength(expectedComplianceJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoComplianceExportEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies privacy redaction evidence coverage and referenced log digests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-privacy-redaction-verify-"));
    const evidencePath = await writePrivacyRedactionEvidenceFixture({ dir });

    expect(validateDojoPrivacyRedactionEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoPrivacyRedactionEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = privacyRedactionEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["screenshot_consent_boundary"],
      budget_evaluation: { ok: false },
      test_summary: {
        ...privacyRedactionEvidenceFixture().test_summary,
        pending_tests: 1,
      },
    });
    const incompletePath = await writePrivacyRedactionEvidenceFixture({ dir, basename: "incomplete-privacy", evidence: incomplete });
    const rejected = await verifyDojoPrivacyRedactionEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "privacy_redaction_not_ok",
      "privacy_redaction_coverage_incomplete",
      "privacy_redaction_missing_capabilities:screenshot_consent_boundary",
      "privacy_redaction_budget_not_ok",
      "privacy_redaction_pending_tests:1",
    ]));

    const driftedPath = await writePrivacyRedactionEvidenceFixture({
      dir,
      basename: "drifted-privacy",
      evidence: privacyRedactionEvidenceFixture({
        test_files: DOJO_PRIVACY_REDACTION_TEST_FILES
          .filter((file) => file !== DOJO_PRIVACY_REDACTION_TEST_FILES[0]),
        test_file_count: DOJO_PRIVACY_REDACTION_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_PRIVACY_REDACTION_TEST_FILES.length - 1,
        configured_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES.filter((capability) => capability !== "broker_audit_redaction"),
        tested_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES.filter((capability) => capability !== "broker_audit_redaction"),
        capability_count: DOJO_PRIVACY_REDACTION_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_PRIVACY_REDACTION_CAPABILITIES.length - 1,
      }),
    });
    expect((await verifyDojoPrivacyRedactionEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "privacy_redaction_required_capabilities_missing:broker_audit_redaction",
      "privacy_redaction_required_capabilities_untested:broker_audit_redaction",
      `privacy_redaction_required_test_files_missing:${DOJO_PRIVACY_REDACTION_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-privacy.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedPrivacyJson = privacyRedactionJsonReportFixtureText();
    const tamperedJsonPath = await writePrivacyRedactionEvidenceFixture({
      dir,
      basename: "tampered-privacy-json",
      evidence: privacyRedactionEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedPrivacyJson),
        json_report_bytes: Buffer.byteLength(expectedPrivacyJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoPrivacyRedactionEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies chaos performance evidence coverage, metrics, and referenced log digests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-chaos-performance-verify-"));
    const evidencePath = await writeChaosEvidenceFixture({ dir });

    expect(validateDojoChaosPerformanceEvidenceForEnterprise(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoChaosPerformanceEvidenceArtifact({
      evidencePath,
      enterpriseRelease: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      enterprise_release: true,
    }));

    const missingMetricsPath = await writeChaosEvidenceFixture({
      dir,
      basename: "missing-metrics-chaos",
      evidence: chaosEvidenceFixture({
        performance_metrics: {
          self_check_duration_ms: 1200,
          failed_test_count: 0,
          passed_test_count: 9,
        },
      }),
    });
    const missingMetrics = await verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath: missingMetricsPath });
    expect(missingMetrics.errors).toEqual(expect.arrayContaining([
      "chaos_performance_missing_test_case_p95",
      "chaos_performance_missing_test_file_p95",
    ]));

    const incompletePath = await writeChaosEvidenceFixture({
      dir,
      basename: "incomplete-chaos",
      evidence: chaosEvidenceFixture({
        ok: false,
        scenario_coverage_complete: false,
        missing_chaos_scenarios: ["api_timeout"],
      }),
    });
    const rejected = await verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "chaos_performance_not_ok",
      "chaos_performance_scenario_coverage_incomplete",
      "chaos_performance_missing_scenarios:api_timeout",
    ]));

    const driftedPath = await writeChaosEvidenceFixture({
      dir,
      basename: "drifted-chaos",
      evidence: chaosEvidenceFixture({
        test_files: DOJO_CHAOS_PERFORMANCE_TEST_FILES
          .filter((file) => file !== DOJO_CHAOS_PERFORMANCE_TEST_FILES[0]),
        test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length - 1,
        configured_chaos_scenarios: DOJO_CHAOS_SCENARIOS.filter((scenario) => scenario !== "api_timeout"),
        tested_chaos_scenarios: DOJO_CHAOS_SCENARIOS.filter((scenario) => scenario !== "api_timeout"),
        scenario_count: DOJO_CHAOS_SCENARIOS.length - 1,
        configured_scenario_count: DOJO_CHAOS_SCENARIOS.length - 1,
      }),
    });
    const drifted = await verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath: driftedPath });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      "chaos_performance_required_scenarios_missing:api_timeout",
      "chaos_performance_required_scenarios_untested:api_timeout",
      `chaos_performance_required_test_files_missing:${DOJO_CHAOS_PERFORMANCE_TEST_FILES[0]}`,
    ]));

    const skippedPath = await writeChaosEvidenceFixture({
      dir,
      basename: "skipped-chaos",
      evidence: chaosEvidenceFixture({
        test_summary: {
          total_tests: 9,
          passed_tests: 8,
          failed_tests: 0,
          pending_tests: 1,
        },
      }),
    });
    expect((await verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath: skippedPath })).errors).toEqual(expect.arrayContaining([
      "chaos_performance_pending_tests:1",
    ]));

    const tamperedJson = path.join(dir, "tampered-chaos.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedChaosJson = chaosJsonReportFixtureText();
    const tamperedJsonPath = await writeChaosEvidenceFixture({
      dir,
      basename: "tampered-chaos-json",
      evidence: chaosEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedChaosJson),
        json_report_bytes: Buffer.byteLength(expectedChaosJson),
      }),
    });
    const tamperedJsonResult = await verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies soak summary metrics and iteration event artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-soak-verify-"));
    const artifacts = await writeSoakFixture({ dir });

    expect(validateDojoSoakPerformanceSummary(artifacts.summary, {
      events: artifacts.events,
      minDurationSeconds: 1,
    })).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoSoakPerformanceArtifacts({
      summaryPath: artifacts.summaryPath,
      eventsPath: artifacts.eventsPath,
      minDurationSeconds: 1,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: artifacts.events.length,
    }));

    const tooShort = await writeSoakFixture({
      dir,
      basename: "too-short-soak",
      summary: soakSummaryFixture({
        duration_s: 0.5,
        errors: 1,
      }),
    });
    const rejected = await verifyDojoSoakPerformanceArtifacts({
      summaryPath: tooShort.summaryPath,
      eventsPath: tooShort.eventsPath,
      minDurationSeconds: 1,
    });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "soak_duration_below_required:0.5:1",
      "soak_errors_nonzero:1",
    ]));

    const malformedEvents = await writeSoakFixture({
      dir,
      basename: "malformed-events-soak",
      rawEvents: "{\"iter\":0}\nnot-json\n",
    });
    const malformed = await verifyDojoSoakPerformanceArtifacts({
      summaryPath: malformedEvents.summaryPath,
      eventsPath: malformedEvents.eventsPath,
      minDurationSeconds: 1,
    });
    expect(malformed.errors).toContain("soak_events_parse_error");

    const leakedResources = await writeSoakFixture({
      dir,
      basename: "leaked-resource-soak",
      summary: soakSummaryFixture({
        runtime_resources: {
          ...soakSummaryFixture().runtime_resources,
          active_session_count_end: 1,
          browser_session_leak_count: 1,
        },
      }),
    });
    const leakRejected = await verifyDojoSoakPerformanceArtifacts({
      summaryPath: leakedResources.summaryPath,
      eventsPath: leakedResources.eventsPath,
      minDurationSeconds: 1,
    });
    expect(leakRejected.errors).toEqual(expect.arrayContaining([
      "soak_browser_session_leak_count_nonzero:1",
    ]));
  });

  it("verifies visual reports against schema, pixel/layout metrics, and screenshot bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-visual-verify-"));
    const packageScripts = await readPackageScripts();
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const screenshotPath = path.join(dir, "visual-proof.png");
    const imageBytes = Buffer.from("not-a-real-production-screenshot");
    await writeFile(screenshotPath, imageBytes);
    const reportPath = path.join(dir, "visual-proof.json");
    const report = buildVisualReport({
      screenshotPath,
      bytes: imageBytes.length,
      screenshotSha256: sha256(imageBytes),
    });
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    expect(await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: 1,
    }));

    await writeFile(reportPath, JSON.stringify(buildVisualReport({
      screenshotPath,
      bytes: imageBytes.length + 1,
      screenshotSha256: sha256(imageBytes),
    }), null, 2), "utf8");
    const rejected = await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "visual_result_screenshot_bytes_mismatch:visual-proof:33:32",
    ]));

    await writeFile(reportPath, JSON.stringify(buildVisualReport({
      screenshotPath,
      bytes: imageBytes.length,
      screenshotSha256: sha256("different-screenshot"),
    }), null, 2), "utf8");
    const digestRejected = await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    });
    expect(digestRejected.ok).toBe(false);
    expect(digestRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^visual_result_screenshot_sha256_mismatch:visual-proof:/),
    ]));
  });
});

async function readPackageScripts() {
  const mcpPackage = JSON.parse(await readFile(path.join(MCP_ROOT, "package.json"), "utf8"));
  const frontendPackage = JSON.parse(await readFile(path.join(REPO_ROOT, "synthi", "package.json"), "utf8"));
  return {
    "mcp/synthi-mcp/package.json": mcpPackage.scripts || {},
    "synthi/package.json": frontendPackage.scripts || {},
  };
}

async function writeManifestPair({ manifest, manifestPath, evidencePath }) {
  const serialized = JSON.stringify(manifest, null, 2);
  const evidence = buildDojoReleaseGateEvidenceManifest({
    manifest,
    manifestPath,
    serialized,
  });
  await writeFile(manifestPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
}

async function writeConformancePair({ report, reportPath, evidencePath }) {
  const serialized = JSON.stringify(report, null, 2);
  const evidence = buildConformanceEvidenceManifest({
    report,
    reportPath,
    serialized,
  });
  await writeFile(reportPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
}

async function writeVisualReportFixture({ dir, basename, schemaVersion }) {
  const screenshotPath = path.join(dir, `${basename}.png`);
  const imageBytes = Buffer.from(`${basename}:visual-proof-fixture`);
  await writeFile(screenshotPath, imageBytes);
  const reportPath = path.join(dir, `${basename}.json`);
  await writeFile(reportPath, JSON.stringify(buildVisualReport({
    screenshotPath,
    bytes: imageBytes.length,
    screenshotSha256: sha256(imageBytes),
    schemaVersion,
  }), null, 2), "utf8");
  return {
    screenshotPath,
    reportPath,
  };
}

async function writeProofSelfCheckFixture({
  dir,
  basename = "dojo-proof-self-check",
  summary,
  productionEvidence,
  visualEvidence,
  screenshotBytes,
}) {
  const productionEvidenceBody = productionEvidence ?? productionRuntimeEvidenceFixture();
  const productionEvidencePath = path.join(dir, `${basename}.production-runtime-evidence.json`);
  const visualDir = path.join(dir, `${basename}.visual-proof`);
  await mkdir(visualDir, { recursive: true });
  const visualScreenshotPath = path.join(visualDir, "dojo-proof-visual.png");
  const visualScreenshotBytes = screenshotBytes ?? proofSelfCheckPngFixtureBytes();
  await writeFile(visualScreenshotPath, visualScreenshotBytes);
  const visualEvidenceBody = visualEvidence
    ? {
        ...visualEvidence,
        screenshot_path: visualEvidence.screenshot_path || visualScreenshotPath,
      }
    : proofSelfCheckVisualEvidenceFixture({
        screenshot_path: visualScreenshotPath,
        screenshot_bytes: visualScreenshotBytes.length,
      });
  const visualEvidencePath = path.join(visualDir, "dojo-proof-visual.evidence.json");
  const summaryBody = summary ?? proofSelfCheckSummaryFixture({
    production_runtime_evidence: path.basename(productionEvidencePath),
    visual_proof_screenshot: path.relative(dir, visualScreenshotPath).replace(/\\/g, "/"),
    visual_proof_evidence: path.relative(dir, visualEvidencePath).replace(/\\/g, "/"),
  });
  const summaryPath = path.join(dir, `${basename}.summary.json`);
  await writeFile(productionEvidencePath, JSON.stringify(productionEvidenceBody, null, 2), "utf8");
  await writeFile(visualEvidencePath, JSON.stringify(visualEvidenceBody, null, 2), "utf8");
  await writeFile(summaryPath, JSON.stringify({
    ...summaryBody,
    production_runtime_evidence: path.basename(productionEvidencePath),
    visual_proof_screenshot: summaryBody.visual_proof_screenshot ?? path.relative(dir, visualScreenshotPath).replace(/\\/g, "/"),
    visual_proof_evidence: summaryBody.visual_proof_evidence ?? path.relative(dir, visualEvidencePath).replace(/\\/g, "/"),
  }, null, 2), "utf8");
  return {
    summary: {
      ...summaryBody,
      production_runtime_evidence: path.basename(productionEvidencePath),
      visual_proof_screenshot: summaryBody.visual_proof_screenshot ?? path.relative(dir, visualScreenshotPath).replace(/\\/g, "/"),
      visual_proof_evidence: summaryBody.visual_proof_evidence ?? path.relative(dir, visualEvidencePath).replace(/\\/g, "/"),
    },
    productionEvidence: productionEvidenceBody,
    visualEvidence: visualEvidenceBody,
    summaryPath,
    productionEvidencePath,
    visualEvidencePath,
    visualScreenshotPath,
  };
}

function proofSelfCheckSummaryFixture(overrides = {}) {
  return {
    schema_version: "synthi.dojo.proofSelfCheckSummary.v1",
    ok: true,
    run_id: "proof-self-check-fixture",
    production_proof_consumed: true,
    production_proof_replay_blocked: true,
    production_runtime_evidence: "dojo-proof-self-check.production-runtime-evidence.json",
    production_runtime_evidence_record_count: 1,
    visual_proof_ok: true,
    visual_proof_pixel_metrics_verified: true,
    visual_proof_horizontal_overflow_px: 0,
    visual_proof_screenshot: "visual-proof/dojo-proof-visual.png",
    visual_proof_evidence: "visual-proof/dojo-proof-visual.evidence.json",
    ...overrides,
  };
}

function proofSelfCheckVisualEvidenceFixture(overrides = {}) {
  return {
    schema_version: "synthi.dojo.proofSelfCheckVisualEvidence.v1",
    ok: true,
    page_path: "dojo-proof-visual.html",
    screenshot_path: "dojo-proof-visual.png",
    screenshot_bytes: proofSelfCheckPngFixtureBytes().length,
    checks: {
      has_skill_id: true,
      has_tool_name: true,
      has_license_status: true,
      has_proof_capsule: true,
    },
    failed_visual_gates: [],
    visual_thresholds: {
      min_screenshot_bytes: 10000,
      min_unique_color_sample_count: 24,
      min_luma_stddev: 2,
      min_background_diff_pixel_ratio: 0.01,
      max_horizontal_overflow_px: 4,
      min_selector_visible_area_px: 900,
    },
    image_metrics: {
      pixel_metrics_verified: true,
      width: 1360,
      height: 1000,
      unique_color_sample_count: 64,
      luma_stddev: 20,
      background_diff_pixel_ratio: 0.9,
    },
    layout_metrics: {
      selector_found: true,
      selector_visible: true,
      horizontal_overflow_px: 0,
      selector_visible_area_px: 100000,
    },
    ...overrides,
  };
}

function proofSelfCheckPngFixtureBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(12000, 1),
  ]);
}

function productionRuntimeEvidenceFixture(overrides = {}) {
  return {
    schema_version: "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1",
    run_id: "proof-self-check-production",
    requested_action: "run_prefix_validation",
    proof_capsule_id: "capsule-fixture",
    proof_consumed: true,
    replay_blocked: true,
    replay_error: "dojo_license_kernel_blocked",
    runtime_session: {
      schema_version: "synthi.dojo.hostedRuntimeSession.v1",
      session_id: "dojo_runtime_session_fixture",
      runtime_id: "dojo_runtime_fixture",
      tenant_id: "tenant-fixture",
      organization_id: "org-fixture",
      workspace_id: "workspace-fixture",
      skill_id: "skill-fixture",
      run_id: "proof-self-check-production",
      actor_id: "agent-fixture",
      actor_type: "service",
      workspace_url: "https://app.example.test/settings",
      workspace_origin: "https://app.example.test",
      origin_allowlist: ["https://app.example.test"],
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:10:00.000Z",
      credential_id: "runtime_cred_fixture",
      credential_expires_at: "2026-06-11T00:05:00.000Z",
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
      audit_event_refs: ["audit-runtime-session"],
      evidence_refs: [],
    },
    runtime_authorization: {
      ok: true,
      status: "authorized",
      session_id: "dojo_runtime_session_fixture",
      action_kind: "proof_gated_tool",
      blocked_by: [],
      audit_event_id: "audit-runtime-action",
      evidence_record_ids: ["evidence:runtime-action"],
    },
    proof_record: {
      capsule_id: "capsule-fixture",
      status: "used",
      first_used_at: "2026-06-11T00:01:00.000Z",
    },
    audit_event_types: ["runtime_session_created", "runtime_action_authorized", "proof_used"],
    ...overrides,
  };
}

async function writeWorkflowE2EFixture({
  dir,
  basename = "workflow-e2e",
  report = workflowE2EFixture(),
}) {
  const reportPath = path.join(dir, `${basename}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { report, reportPath };
}

function workflowE2EFixture(overrides = {}) {
  return {
    schema_version: "synthi.dojo.workflowPipelineE2E.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    case_count: 1,
    hosted_runtime: {
      cdp_url: "wss://hosted-runtime.example.test/session",
      cdp_url_configured: true,
      ok: true,
      require_non_loopback_runtime: true,
      non_loopback_runtime: true,
      runtime_host_class: "remote",
    },
    fresh_mcp: {
      verify_fresh_mcp: true,
      bridge_url: "http://127.0.0.1:49999",
      private_workflow_store_env_configured: true,
    },
    results: [
      { caseId: "fixture-case", name: "export avoids forwarded port literals", ok: true, detail: "none" },
      { caseId: "fixture-case", name: "run exported Playwright", ok: true, detail: "passed" },
      { caseId: "fixture-case", name: "fresh MCP attach hosted browser", ok: true, detail: "hosted" },
      { caseId: "fixture-case", name: "fresh MCP call discovered private tool", ok: true, detail: "steps=1" },
    ],
    ...overrides,
  };
}

async function writePrivateToolStdioAcceptanceFixture({
  dir,
  basename = "private-tool-stdio",
  transcript,
}) {
  const screenshotPath = path.join(dir, `${basename}.png`);
  await writeFile(screenshotPath, Buffer.from(`${basename}:visual-proof`));
  const body = transcript ?? privateToolStdioAcceptanceFixture({ screenshotPath });
  const transcriptPath = path.join(dir, `${basename}.json`);
  await writeFile(transcriptPath, JSON.stringify(body, null, 2), "utf8");
  return {
    transcript: body,
    transcriptPath,
    screenshotPath,
  };
}

function privateToolStdioAcceptanceFixture(overrides = {}) {
  const screenshotPath = overrides.screenshotPath || "private-tool-stdio.png";
  const base = privateToolAcceptanceBaseFixture({
    schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
    steps: [
      { name: "initialize", ok: true },
      { name: "production-style deployment readiness through MCP", ok: true, workflow_bridge_required: false },
      { name: "discover private MCP tool", ok: true, tool_name: "synthi_app_fixture", tool_count: 1 },
      {
        name: "strict host schema validation before execution",
        ok: true,
        rejected: [
          { arguments: ["script_path"], errors: ["additional_property:script_path"] },
          { arguments: ["run_mode"], errors: ["enum:run_mode"] },
        ],
        accepted_configured_call: true,
      },
      { name: "discover private workflow registry through MCP", ok: true, count: 1, tool_name: "synthi_app_fixture" },
      { name: "lookup manifest through MCP", ok: true, result: { tool_name: "synthi_app_fixture" } },
      {
        name: "attach hosted workspace browser through MCP",
        ok: true,
        evidence: { hosted_attach: true, local_attach: false, runtime_kind: "hosted" },
      },
      { name: "grant exact-origin consent", ok: true },
      { name: "open target page", ok: true, tab: { tab_id: "tab-fixture" } },
      {
        name: "call discovered private MCP tool",
        ok: true,
        result: {
          ok: true,
          private_tool: { tool_name: "synthi_app_fixture", run_mode: "sameSession" },
          replay: { steps_run: 2 },
        },
      },
      {
        name: "visual proof snapshot",
        ok: true,
        screenshot_path: screenshotPath,
        url: "https://workspace.example.test/private-tool",
        expected_text: "Details opened",
      },
    ],
  });
  return { ...base, ...withoutFixtureOnlyOverrides(overrides) };
}

async function writePrivateToolCodexAcceptanceFixture({
  dir,
  basename = "private-tool-codex",
  transcript,
}) {
  const screenshotPath = path.join(dir, `${basename}.png`);
  await writeFile(screenshotPath, Buffer.from(`${basename}:visual-proof`));
  const body = transcript ?? privateToolCodexAcceptanceFixture({ screenshotPath });
  const transcriptPath = path.join(dir, `${basename}.json`);
  await writeFile(transcriptPath, JSON.stringify(body, null, 2), "utf8");
  return {
    transcript: body,
    transcriptPath,
    screenshotPath,
  };
}

function privateToolCodexAcceptanceFixture(overrides = {}) {
  const screenshotPath = overrides.screenshotPath || "private-tool-codex.png";
  const base = privateToolAcceptanceBaseFixture({
    schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
    codex_model: "gpt-5-codex-fixture",
    codex: {
      exit_code: 0,
      event_count: 9,
      final_message: "WORKFLOW_DONE synthi_app_fixture",
      saw_private_tool_name: true,
      mcp_evidence: {
        hosted_attach_call: true,
        local_attach_call: false,
        private_tool_call: true,
        private_tool_result_ok: true,
        private_tool_steps_run: 2,
        private_tool_called_name: "synthi_app_fixture",
        consent_call: true,
        open_call: true,
        command_execution_count: 0,
        command_executions: [],
      },
    },
    steps: [
      { name: "codex discovered and called private MCP tool", ok: true, tool_name: "synthi_app_fixture" },
      {
        name: "visual proof snapshot",
        ok: true,
        screenshot_path: screenshotPath,
        url: "https://workspace.example.test/private-tool",
        match: true,
        expected_text: "Details opened",
      },
    ],
  });
  return { ...base, ...withoutFixtureOnlyOverrides(overrides) };
}

function privateToolAcceptanceBaseFixture(overrides = {}) {
  return {
    schema_version: overrides.schema_version,
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    cdp_url: "wss://hosted-runtime.example.test/session",
    target_url: "https://workspace.example.test/private-tool",
    workspace_id: "workspace-fixture",
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    conformance: {
      require_non_loopback_runtime: true,
      non_loopback_runtime: true,
      runtime_host_class: "remote",
      require_external_private_tool_store: false,
      external_private_tool_store: false,
    },
    private_tool_store: {
      external: false,
      file: "redacted-private-tools.enc.json",
      scope: "acceptance-fixture",
    },
    acceptance: {
      requested_tool_name: null,
      tool_args_keys: [],
      expected_steps_min: 1,
      expected_text_required: true,
    },
    steps: [],
    ...overrides,
  };
}

function deployedPrivateToolHostFixtureOverrides(overrides = {}) {
  const base = {
    target_url: "https://workspace.example.test/private-tool",
    conformance: {
      require_non_loopback_runtime: true,
      non_loopback_runtime: true,
      runtime_host_class: "remote",
      require_external_private_tool_store: true,
      external_private_tool_store: true,
    },
    private_tool_store: {
      external: true,
      file: "redacted-external-private-tools.enc.json",
      scope: "external-acceptance-fixture",
    },
  };
  return {
    ...base,
    ...overrides,
    conformance: {
      ...base.conformance,
      ...(overrides.conformance || {}),
    },
    private_tool_store: {
      ...base.private_tool_store,
      ...(overrides.private_tool_store || {}),
    },
  };
}

function withoutFixtureOnlyOverrides(overrides) {
  const cleaned = { ...overrides };
  delete cleaned.screenshotPath;
  return cleaned;
}

async function writePostgresControlPlaneEvidenceFixture({
  dir,
  basename = "dojo-postgres-control-plane",
  evidence,
  writeLogs = true,
}) {
  const stdout = "postgres control-plane suite passed\n";
  const stderr = "";
  const jsonReport = postgresControlPlaneJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? postgresControlPlaneEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "vitest.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function postgresControlPlaneEvidenceFixture(overrides = {}) {
  const stdout = "postgres control-plane suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    postgres_url_configured: true,
    postgres_connection: {
      configured: true,
      parseable: true,
      protocol: "postgres",
      host_class: "loopback",
      port_configured: true,
      database_configured: true,
      username_configured: true,
      password_configured: true,
      password_redacted: true,
    },
    configured_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
    tested_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
    capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length,
    configured_capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length,
    capability_coverage_complete: true,
    missing_capabilities: [],
    test_files: [...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES],
    budget_evaluation: { ok: true },
    test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    reported_test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    test_summary: {
      total_tests: 13,
      passed_tests: 13,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "vitest.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function postgresControlPlaneJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: 13,
    numPassedTests: 13,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    numPassedTestSuites: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [],
  }, null, 2);
}

async function writeDockerIntegrationEvidenceFixture({
  dir,
  basename = "dojo-docker-integration",
  evidence,
  writeLogs = true,
}) {
  const stdout = "docker compose stack healthy\n";
  const stderr = "";
  const jsonReport = dockerIntegrationJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.report.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? dockerIntegrationEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "docker-report.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function dockerIntegrationEvidenceFixture(overrides = {}) {
  const stdout = "docker compose stack healthy\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    duration_ms: 1500,
    docker_compose_up_ran: true,
    docker_compose_up_skipped: false,
    required_services: dockerRequiredServicesFixture(),
    required_service_count: dockerRequiredServicesFixture().length,
    running_services: dockerRequiredServicesFixture(),
    missing_services: [],
    unhealthy_services: [],
    healthy_services_required: [...DOJO_DOCKER_HEALTHY_SERVICES],
    endpoint_checks: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => dockerEndpointFixture({
      id: endpoint.id,
      expectedStatus: endpoint.expected_status,
    })),
    endpoint_count: DOJO_DOCKER_REQUIRED_ENDPOINTS.length,
    endpoint_ok_count: DOJO_DOCKER_REQUIRED_ENDPOINTS.length,
    command_evaluation: {
      compose_up_ran: true,
      compose_up_exit_code: 0,
      compose_ps_exit_code: 0,
      compose_config_exit_code: 0,
      compose_up_error: null,
      compose_ps_error: null,
      compose_config_error: null,
    },
    service_evaluation: dockerServiceEvaluationFixture(),
    budget_evaluation: {
      ok: true,
      checks: {
        compose_up_ran_or_explicitly_skipped: true,
        compose_up_succeeded: true,
        compose_ps_succeeded: true,
        compose_config_succeeded: true,
        all_required_services_present: true,
        all_required_services_running: true,
        required_healthchecks_healthy: true,
        required_endpoints_ok: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "docker-report.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function dockerIntegrationJsonReportFixtureText() {
  return JSON.stringify({
    schema_version: "synthi.dojo.dockerIntegrationReport.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    compose_file: "docker-compose.yml",
    command_evaluation: {
      compose_up_ran: true,
      compose_up_exit_code: 0,
      compose_ps_exit_code: 0,
      compose_config_exit_code: 0,
    },
    configured_services: dockerRequiredServicesFixture(),
    service_evaluation: dockerServiceEvaluationFixture(),
    endpoint_checks: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => dockerEndpointFixture({
      id: endpoint.id,
      expectedStatus: endpoint.expected_status,
    })),
  }, null, 2);
}

function dockerRequiredServicesFixture() {
  return [...DOJO_DOCKER_REQUIRED_SERVICES];
}

function dockerServiceEvaluationFixture() {
  const services = dockerRequiredServicesFixture();
  return {
    ok: true,
    configured_services: services,
    required_services: services,
    running_services: services,
    missing_services: [],
    stopped_services: [],
    unhealthy_services: [],
    unknown_configured_services: [],
    service_states: services.map((service) => ({
      service,
      state: "running",
      health: DOJO_DOCKER_HEALTHY_SERVICES.includes(service) ? "healthy" : "",
      status: "running",
    })),
  };
}

function dockerEndpointFixture({
  id,
  ok = true,
  status = 200,
  expectedStatus,
} = {}) {
  const contract = DOJO_DOCKER_REQUIRED_ENDPOINTS.find((endpoint) => endpoint.id === id);
  const expected_status = Number.isFinite(Number(expectedStatus))
    ? Number(expectedStatus)
    : Number(contract?.expected_status ?? 200);
  return {
    id,
    url: contract?.default_url ?? "http://127.0.0.1/",
    expected_status,
    status,
    ok,
    duration_ms: 25,
    error: ok ? null : "unexpected_status",
  };
}

async function writeSecurityEvidenceFixture({
  dir,
  basename = "dojo-security-abuse",
  evidence,
  writeLogs = true,
}) {
  const stdout = "security suite passed\n";
  const stderr = "";
  const jsonReport = securityJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  } else {
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? securityEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath, json_report_path: jsonReportPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "vitest.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function securityEvidenceFixture(overrides = {}) {
  const stdout = "security suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.securityAbuseEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_abuse_classes: DOJO_SECURITY_ABUSE_CLASSES,
    tested_abuse_classes: DOJO_SECURITY_ABUSE_CLASSES,
    abuse_class_count: DOJO_SECURITY_ABUSE_CLASSES.length,
    configured_abuse_class_count: DOJO_SECURITY_ABUSE_CLASSES.length,
    abuse_class_coverage_complete: true,
    missing_abuse_classes: [],
    test_files: [...DOJO_SECURITY_ABUSE_TEST_FILES],
    test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length,
    reported_test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_SECURITY_ABUSE_CLASSES.length,
      passed_tests: DOJO_SECURITY_ABUSE_CLASSES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "vitest.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function securityJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_SECURITY_ABUSE_CLASSES.length,
    numPassedTests: DOJO_SECURITY_ABUSE_CLASSES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_SECURITY_ABUSE_TEST_FILES.length,
    numPassedTestSuites: DOJO_SECURITY_ABUSE_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_SECURITY_ABUSE_CLASSES.map((abuseClass, index) => ({
          fullName: `release verifier fixture covers ${abuseClass}`,
          title: `release verifier fixture covers ${abuseClass}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeComplianceExportEvidenceFixture({
  dir,
  basename = "dojo-compliance-export",
  evidence,
  writeLogs = true,
}) {
  const stdout = "compliance suite passed\n";
  const stderr = "";
  const jsonReport = complianceExportJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  } else {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
  }
  const body = evidence ?? complianceExportEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath, json_report_path: jsonReportPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "vitest.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function complianceExportEvidenceFixture(overrides = {}) {
  const stdout = "compliance suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.complianceExportEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
    tested_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
    missing_capabilities: [],
    capability_count: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.length,
    configured_capability_count: DOJO_COMPLIANCE_EXPORT_CAPABILITIES.length,
    capability_coverage_complete: true,
    test_files: [...DOJO_COMPLIANCE_EXPORT_TEST_FILES],
    test_file_count: DOJO_COMPLIANCE_EXPORT_TEST_FILES.length,
    reported_test_file_count: DOJO_COMPLIANCE_EXPORT_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: 12,
      passed_tests: 12,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "vitest.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function complianceExportJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: 12,
    numPassedTests: 12,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writePrivacyRedactionEvidenceFixture({
  dir,
  basename = "dojo-privacy-redaction",
  evidence,
  writeLogs = true,
}) {
  const stdout = "privacy suite passed\n";
  const stderr = "";
  const jsonReport = privacyRedactionJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  } else {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
  }
  const body = evidence ?? privacyRedactionEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath, json_report_path: jsonReportPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "vitest.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function privacyRedactionEvidenceFixture(overrides = {}) {
  const stdout = "privacy suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
    tested_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
    missing_capabilities: [],
    capability_count: DOJO_PRIVACY_REDACTION_CAPABILITIES.length,
    configured_capability_count: DOJO_PRIVACY_REDACTION_CAPABILITIES.length,
    capability_coverage_complete: true,
    test_files: [...DOJO_PRIVACY_REDACTION_TEST_FILES],
    test_file_count: DOJO_PRIVACY_REDACTION_TEST_FILES.length,
    reported_test_file_count: DOJO_PRIVACY_REDACTION_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: 16,
      passed_tests: 16,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "vitest.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function privacyRedactionJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: 16,
    numPassedTests: 16,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeChaosEvidenceFixture({
  dir,
  basename = "dojo-chaos-performance",
  evidence,
}) {
  const stdout = "chaos suite passed\n";
  const stderr = "";
  const jsonReport = chaosJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const body = evidence ?? chaosEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath, json_report_path: jsonReportPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
    json_report_path: body.json_report_path && body.json_report_path !== "vitest.json" ? body.json_report_path : jsonReportPath,
    json_report_sha256: body.json_report_sha256 && body.json_report_sha256 !== "json-report-sha256" ? body.json_report_sha256 : sha256(jsonReport),
    json_report_bytes: Number.isFinite(Number(body.json_report_bytes)) && Number(body.json_report_bytes) >= 0
      ? body.json_report_bytes
      : Buffer.byteLength(jsonReport),
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function chaosEvidenceFixture(overrides = {}) {
  const stdout = "chaos suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
    tested_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
    scenario_count: DOJO_CHAOS_SCENARIOS.length,
    configured_scenario_count: DOJO_CHAOS_SCENARIOS.length,
    scenario_coverage_complete: true,
    missing_chaos_scenarios: [],
    test_files: [...DOJO_CHAOS_PERFORMANCE_TEST_FILES],
    test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
    reported_test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: 9,
      passed_tests: 9,
      failed_tests: 0,
      pending_tests: 0,
    },
    performance_metrics: {
      self_check_duration_ms: 1200,
      test_case_duration_p95_ms: 42,
      test_file_duration_p95_ms: 140,
      failed_test_count: 0,
      passed_test_count: 9,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    json_report_path: "vitest.json",
    json_report_sha256: "json-report-sha256",
    json_report_bytes: undefined,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

function chaosJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: 9,
    numPassedTests: 9,
    numFailedTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeSoakFixture({
  dir,
  basename = "soak",
  summary = soakSummaryFixture(),
  events = soakEventsFixture(),
  rawEvents,
}) {
  const summaryPath = path.join(dir, `${basename}-summary.json`);
  const eventsPath = path.join(dir, `${basename}-events.ndjson`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await writeFile(
    eventsPath,
    rawEvents ?? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
  return {
    summaryPath,
    eventsPath,
    summary,
    events,
  };
}

function soakSummaryFixture(overrides = {}) {
  return {
    duration_s: 2,
    iterations: 2,
    errors: 0,
    snapshots_captured: 1,
    per_tool: {
      screenshot: { name: "screenshot", count: 2, errors: 0, p50: 15, p95: 18, p99: 18, max: 18 },
      locate: { name: "locate", count: 2, errors: 0, p50: 20, p95: 24, p99: 24, max: 24 },
      wait: { name: "wait", count: 2, errors: 0, p50: 12, p95: 16, p99: 16, max: 16 },
      snapshot: { name: "snapshot", count: 1, errors: 0, p50: 21, p95: 21, p99: 21, max: 21 },
      usage: { name: "usage", count: 1, errors: 0, p50: 8, p95: 8, p99: 8, max: 8 },
    },
    memory: {
      source: "node_process_memory_usage",
      sample_count: 3,
      rss_start_bytes: 100_000_000,
      rss_end_bytes: 101_000_000,
      rss_max_bytes: 101_000_000,
      rss_growth_bytes: 1_000_000,
      heap_used_start_bytes: 40_000_000,
      heap_used_end_bytes: 40_500_000,
      heap_used_max_bytes: 40_500_000,
      heap_used_growth_bytes: 500_000,
      external_max_bytes: 2_000_000,
      array_buffer_max_bytes: 1_000_000,
    },
    usage_counters: {
      sample_count: 3,
      first_phase: "pre_attach",
      last_phase: "post_detach",
      first_counters: { tool_call: 0, screenshot: 0, vision_inference: 0, egress_bytes: 0 },
      last_counters: { tool_call: 20, screenshot: 2, vision_inference: 0, egress_bytes: 1024 },
      delta: { tool_call: 20, screenshot: 2, vision_inference: 0, egress_bytes: 1024 },
      counter_names: ["egress_bytes", "screenshot", "tool_call", "vision_inference"],
    },
    runtime_resources: {
      source: "synthi_get_usage.runtime_session_diagnostics",
      sample_count: 3,
      post_detach_observed: true,
      first_phase: "pre_attach",
      last_phase: "post_detach",
      active_session_count_start: 0,
      active_session_count_end: 0,
      active_session_count_max: 1,
      active_frame_sink_count_start: 0,
      active_frame_sink_count_end: 0,
      active_frame_sink_count_max: 1,
      browser_session_leak_count: 0,
      frame_sink_leak_count: 0,
      leak_count_source: "post_detach_runtime_session_diagnostics",
    },
    ...overrides,
  };
}

function soakEventsFixture() {
  return [
    {
      iter: 0,
      at: 1781300000000,
      steps: [
        { tool: "screenshot", latency_ms: 15, ok: true },
        { tool: "locate", latency_ms: 20, ok: true },
        { tool: "wait", latency_ms: 12, ok: true },
        { tool: "snapshot", latency_ms: 21, ok: true },
      ],
    },
    {
      iter: 1,
      at: 1781300002000,
      steps: [
        { tool: "screenshot", latency_ms: 18, ok: true },
        { tool: "locate", latency_ms: 24, ok: true },
        { tool: "wait", latency_ms: 16, ok: true },
        { tool: "usage", latency_ms: 8, ok: true },
      ],
    },
  ];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildConformanceReport({
  schemaVersion = "synthi.dojo.mcpHostConformance.v1",
  executeProduction = true,
  deploymentClaims = mcpHostDeploymentClaimsFixture(),
  steps,
} = {}) {
  const report = {
    schema_version: schemaVersion,
    generated_at: "2026-06-11T00:00:00.000Z",
    conformance: {
      ok: true,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: true,
      mcp_host_class: "remote",
    },
    config: {
      execute_production: executeProduction,
      raw_backing_tool_required: true,
    },
    deployment_claims: deploymentClaims,
    steps: steps || buildConformanceSteps({ executeProduction }),
  };
  report.release_gate = buildConformanceReleaseGateSummary(report);
  return report;
}

function buildConformanceSteps({ executeProduction = true } = {}) {
  return [
    { name: "initialize", ok: true },
    { name: "required Dojo tool surface advertised", ok: true },
    { name: "select published Dojo competency", ok: true },
    { name: "issue proof capsule", ok: true },
    { name: "validate proof capsule", ok: true },
    {
      name: executeProduction ? "execute proof-gated Dojo skill" : "dry-run proof-gated Dojo skill",
      ok: true,
      dry_run: !executeProduction,
    },
    { name: "raw backing tool blocked outside Dojo proof path", ok: true },
    { name: "revoke proof capsule", ok: true },
    { name: "revoked proof validation blocked", ok: true },
    { name: "revoked proof run blocked", ok: true },
  ];
}

function mcpHostDeploymentClaimsFixture() {
  return {
    require_external_control_plane_store: true,
    external_control_plane_store: true,
    require_external_proof_signing: true,
    external_proof_signing: true,
    require_bridge_token: true,
    bridge_token_required: true,
    require_no_local_cdp: true,
    no_local_cdp_leakage: true,
    require_licensed_skill_filtering: true,
    licensed_skill_filtering: true,
  };
}

function buildVisualReport({ screenshotPath, bytes, screenshotSha256, schemaVersion = "synthi.dojo.visualProof.v1" }) {
  return {
    schema_version: schemaVersion,
    ok: true,
    screenshots: [screenshotPath],
    results: [
      {
        route_id: "visual-proof",
        viewport: "desktop",
        ok: true,
        failed_visual_gates: [],
        screenshot_path: screenshotPath,
        screenshot_sha256: screenshotSha256,
        bytes,
        image_metrics: {
          pixel_metrics_verified: true,
          unique_color_sample_count: 64,
          background_diff_pixel_ratio: 0.32,
          luma_stddev: 24,
        },
        layout_metrics: {
          horizontal_overflow_px: 0,
          selector_visible_area_px: 120000,
        },
      },
    ],
  };
}
