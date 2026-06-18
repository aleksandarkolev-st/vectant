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
  DOJO_FULL_VISUAL_ROUTE_IDS,
  DOJO_FULL_VISUAL_VIEWPORTS,
  DOJO_GHOST_MODE_VISUAL_ROUTE_IDS,
  DOJO_GHOST_MODE_VISUAL_VIEWPORTS,
  validateDojoReleaseGateManifest,
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
import {
  validateDojoProofSelfCheckForRelease,
  getVerifiableReleaseGateCoverage,
  validateDojoAgentReadyUiContractEvidenceForRelease,
  validateDojoApiToolCompilerEvidenceForRelease,
  validateDojoEvidenceAuthorityEvidenceForMilestone,
  validateDojoImplementationStatusEvidenceForRelease,
  validateDojoSourceDriftEvidenceForRelease,
  validateDojoMcpHostConformanceSelfCheckReport,
  validateDojoMcpHostConformanceReportForRelease,
  validateDojoPrivateToolCodexAcceptanceForRelease,
  validateDojoPrivateToolCodexHostConformanceForRelease,
  validateDojoPrivateToolStdioAcceptanceForRelease,
  validateDojoPrivateToolStdioHostConformanceForRelease,
  validateDojoDockerIntegrationEvidenceForMilestone,
  validateDojoGeneratedPrEvidenceForRelease,
  validateDojoMcpSkillBusEvidenceForRelease,
  validateDojoGovernanceLifecycleEvidenceForRelease,
  validateDojoGraphRuntimeEvidenceForRelease,
  validateDojoGhostModeEvidenceForRelease,
  validateDojoSkillPassportEvidenceForRelease,
  validateDojoTimeMachineDebuggerEvidenceForRelease,
  validateDojoHostedRuntimeGatewayEvidenceForRelease,
  validateDojoVivariumRuntimeEvidenceForRelease,
  validateDojoCheckrideLicenseEvidenceForRelease,
  validateDojoCaseLawRuntimeEvidenceForRelease,
  validateDojoManagedKeySigningEvidenceForRelease,
  validateDojoPublicProofVerificationEvidenceForRelease,
  validateDojoPostgresControlPlaneEvidenceForMilestone,
  validateDojoWorkflowPipelineE2EForRelease,
  validateDojoChaosPerformanceEvidenceForEnterprise,
  validateDojoComplianceExportEvidenceForRelease,
  validateDojoAffordanceCodemodEvidenceForRelease,
  validateDojoPrivacyRedactionEvidenceForRelease,
  validateDojoSecurityAbuseEvidenceForRelease,
  validateDojoSoakPerformanceSummary,
  verifyDojoChaosPerformanceEvidenceArtifact,
  verifyDojoComplianceExportEvidenceArtifact,
  verifyDojoAffordanceCodemodEvidenceArtifact,
  verifyDojoAgentReadyUiContractEvidenceArtifact,
  verifyDojoApiToolCompilerEvidenceArtifact,
  verifyDojoEvidenceAuthorityEvidenceArtifact,
  verifyDojoImplementationStatusEvidenceArtifact,
  verifyDojoSourceDriftEvidenceArtifact,
  verifyDojoDockerIntegrationEvidenceArtifact,
  verifyDojoGeneratedPrEvidenceArtifact,
  verifyDojoMcpSkillBusEvidenceArtifact,
  verifyDojoGovernanceLifecycleEvidenceArtifact,
  verifyDojoGraphRuntimeEvidenceArtifact,
  verifyDojoGhostModeEvidenceArtifact,
  verifyDojoSkillPassportEvidenceArtifact,
  verifyDojoTimeMachineDebuggerEvidenceArtifact,
  verifyDojoHostedRuntimeGatewayEvidenceArtifact,
  verifyDojoVivariumRuntimeEvidenceArtifact,
  verifyDojoCheckrideLicenseEvidenceArtifact,
  verifyDojoCaseLawRuntimeEvidenceArtifact,
  verifyDojoManagedKeySigningEvidenceArtifact,
  verifyDojoPublicProofVerificationEvidenceArtifact,
  verifyDojoMcpHostConformanceSelfCheckArtifacts,
  verifyDojoMcpHostConformanceArtifacts,
  verifyDojoPrivateToolCodexAcceptanceArtifact,
  verifyDojoPrivateToolCodexHostConformanceArtifact,
  verifyDojoPrivateToolStdioAcceptanceArtifact,
  verifyDojoPrivateToolStdioHostConformanceArtifact,
  verifyDojoPostgresControlPlaneEvidenceArtifact,
  verifyDojoProofSelfCheckArtifacts,
  verifyDojoReleaseGateArtifactsFromArgs,
  verifyDojoReleaseGateManifestArtifacts,
  verifyDojoReleaseGateRunReportArtifact,
  verifyDojoReleaseGateVerifierSelfCheckArtifact,
  verifyDojoPrivacyRedactionEvidenceArtifact,
  verifyDojoSecurityAbuseEvidenceArtifact,
  verifyDojoSoakPerformanceArtifacts,
  verifyDojoWorkflowPipelineE2EArtifact,
  verifyVisualProofArtifact,
  buildDojoReleaseGateVerifierSelfCheckEvidenceManifest,
  runDojoReleaseGateVerifierSelfCheck,
} from "../../scripts/dojo-release-gate-verify.mjs";
import {
  buildDojoReleaseGateExecutionPlan,
  buildDojoReleaseGateRunEvidenceManifest,
  buildDojoReleaseGateRunReport,
} from "../../scripts/dojo-release-gate-runner.mjs";

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

  it("writes digest evidence for verifier self-check reports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-verifier-self-check-"));
    const result = await runDojoReleaseGateVerifierSelfCheck({ outDir: dir });
    const reportText = await readFile(result.report_path, "utf8");
    const evidence = JSON.parse(await readFile(result.evidence_path, "utf8"));
    const rebuiltEvidence = buildDojoReleaseGateVerifierSelfCheckEvidenceManifest({
      report: result.report,
      reportPath: result.report_path,
      serialized: reportText,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.releaseGateVerifierSelfCheckEvidence.v1",
      report_path: result.report_path,
      report_sha256: createHash("sha256").update(reportText).digest("hex"),
      report_bytes: Buffer.byteLength(reportText),
      ok: true,
      manifest_verified: true,
      release_gate_runner_self_check_verified: true,
      negative_controls_present: true,
    }));
    expect(evidence.verified_section_ids).toEqual(expect.arrayContaining([
      "release_gate_manifest",
      "dojo_release_gate_runner_self_check",
    ]));
    expect(evidence.verified_section_count).toBe(result.report.verified_sections.length);
    expect(evidence.rejected_control_count).toBe(result.report.rejected_controls.length);
    expect(rebuiltEvidence.report_sha256).toBe(evidence.report_sha256);
    expect(rebuiltEvidence.verified_section_ids).toEqual(evidence.verified_section_ids);
  });

  it("verifies verifier self-check evidence and rejects missing negative controls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-verifier-artifact-"));
    const result = await runDojoReleaseGateVerifierSelfCheck({ outDir: dir });

    expect(await verifyDojoReleaseGateVerifierSelfCheckArtifact({
      reportPath: result.report_path,
      evidencePath: result.evidence_path,
    })).toEqual(expect.objectContaining({
      id: "dojo_release_gate_verifier_self_check",
      ok: true,
      errors: [],
      artifact_path: result.report_path,
      evidence_path: result.evidence_path,
    }));

    const tamperedReport = {
      ...result.report,
      rejected_controls: [],
    };
    const tamperedReportPath = path.join(dir, "dojo-release-gate-verifier-no-negative-controls.json");
    const tamperedReportText = `${JSON.stringify(tamperedReport, null, 2)}\n`;
    const tamperedEvidencePath = path.join(dir, "dojo-release-gate-verifier-no-negative-controls.evidence.json");
    const tamperedEvidence = buildDojoReleaseGateVerifierSelfCheckEvidenceManifest({
      report: tamperedReport,
      reportPath: tamperedReportPath,
      serialized: tamperedReportText,
    });
    await writeFile(tamperedReportPath, tamperedReportText, "utf8");
    await writeFile(tamperedEvidencePath, `${JSON.stringify(tamperedEvidence, null, 2)}\n`, "utf8");

    const rejected = await verifyDojoReleaseGateVerifierSelfCheckArtifact({
      reportPath: tamperedReportPath,
      evidencePath: tamperedEvidencePath,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "verifier_self_check_missing_negative_controls",
    ]));
  });

  it("verifies release-gate runner reports and rejects dry-run or tampered log proof for promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-runner-verify-"));
    const packageScripts = await readPackageScripts();
    const releaseManifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const artifacts = await writeReleaseGateRunnerFixture({
      dir,
      manifest: releaseManifest,
      packageScripts,
    });

    expect(await verifyDojoReleaseGateRunReportArtifact({
      reportPath: artifacts.reportPath,
      evidencePath: artifacts.evidencePath,
      manifest: releaseManifest,
      requirePromotionReady: true,
    })).toEqual(expect.objectContaining({
      id: "release_gate_runner",
      ok: true,
      errors: [],
      report_schema_version: "synthi.dojo.releaseGateRun.v1",
      result_count: 1,
      promotion_ready: true,
    }));

    const originalReportText = await readFile(artifacts.reportPath, "utf8");
    await writeFile(artifacts.reportPath, originalReportText.replace("\"promotion_ready\": true", "\"promotion_ready\": false"), "utf8");
    const reportDigestRejected = await verifyDojoReleaseGateRunReportArtifact({
      reportPath: artifacts.reportPath,
      evidencePath: artifacts.evidencePath,
      manifest: releaseManifest,
      requirePromotionReady: true,
    });
    expect(reportDigestRejected.ok).toBe(false);
    expect(reportDigestRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^report_sha256_mismatch:/),
    ]));
    await writeFile(artifacts.reportPath, originalReportText, "utf8");

    await writeFile(artifacts.stdoutPath, "tampered stdout\n", "utf8");
    const tampered = await verifyDojoReleaseGateRunReportArtifact({
      reportPath: artifacts.reportPath,
      evidencePath: artifacts.evidencePath,
      manifest: releaseManifest,
      requirePromotionReady: true,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^runner_stdout_bytes_mismatch:mcp_typecheck:/),
      expect.stringMatching(/^runner_stdout_sha256_mismatch:mcp_typecheck:/),
    ]));

    const dryRunArtifacts = await writeReleaseGateRunnerFixture({
      dir,
      basename: "dojo-release-gate-runner-dry-run",
      manifest: releaseManifest,
      packageScripts,
      dryRun: true,
    });
    const dryRunRejected = await verifyDojoReleaseGateRunReportArtifact({
      reportPath: dryRunArtifacts.reportPath,
      evidencePath: dryRunArtifacts.evidencePath,
      manifest: releaseManifest,
      requirePromotionReady: true,
    });
    expect(dryRunRejected.ok).toBe(false);
    expect(dryRunRejected.errors).toEqual(expect.arrayContaining([
      "runner_report_dry_run",
      "runner_report_not_complete",
      "runner_report_not_promotion_ready",
      "runner_planned_gates_present:1",
      "runner_result_planned:mcp_typecheck",
    ]));
  });

  it("can include a release-gate runner report in aggregate artifact verification", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-runner-aggregate-"));
    const packageScripts = await readPackageScripts();
    const releaseManifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest: releaseManifest, manifestPath, evidencePath });
    const runner = await writeReleaseGateRunnerFixture({
      dir,
      manifest: releaseManifest,
      packageScripts,
    });

    const aggregate = await verifyDojoReleaseGateArtifactsFromArgs({
      args: {
        manifest: manifestPath,
        evidence: evidencePath,
        "release-gate-run-report": runner.reportPath,
        "release-gate-run-evidence": runner.evidencePath,
        "require-release-gate-runner-promotion-ready": "1",
      },
    });

    expect(aggregate.ok).toBe(true);
    expect(aggregate.release_gate_runner).toEqual([
      expect.objectContaining({
        id: "release_gate_runner",
        ok: true,
        result_count: 1,
        promotion_ready: true,
      }),
    ]);
    expect(aggregate.attempted_release_gate_ids).not.toContain("release_gate_runner");
  });

  it("rejects runner reports when a produced expected artifact is tampered", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-runner-artifact-"));
    const packageScripts = await readPackageScripts();
    const releaseManifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const manifestWithTempEvidence = JSON.parse(JSON.stringify(releaseManifest));
    const gate = manifestWithTempEvidence.gates.find((item) => item.id === "dojo_implementation_status_self_check");
    const evidencePath = path.join(dir, "dojo-implementation-status.evidence.json");
    gate.default_evidence_path = evidencePath;
    const runner = await writeReleaseGateRunnerFixture({
      dir,
      basename: "dojo-release-gate-runner-produced-artifact",
      manifest: manifestWithTempEvidence,
      packageScripts,
      gateId: "dojo_implementation_status_self_check",
      writeExpectedArtifacts: true,
    });

    expect(await verifyDojoReleaseGateRunReportArtifact({
      reportPath: runner.reportPath,
      evidencePath: runner.evidencePath,
      manifest: manifestWithTempEvidence,
      requirePromotionReady: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: 1,
    }));

    await writeFile(evidencePath, JSON.stringify({ ok: false, tampered: true }), "utf8");
    const rejected = await verifyDojoReleaseGateRunReportArtifact({
      reportPath: runner.reportPath,
      evidencePath: runner.evidencePath,
      manifest: manifestWithTempEvidence,
      requirePromotionReady: true,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^runner_produced_artifact_bytes_mismatch:dojo_implementation_status_self_check:evidence:/),
      expect.stringMatching(/^runner_produced_artifact_sha256_mismatch:dojo_implementation_status_self_check:evidence:/),
    ]));
  });

  it("reports manifest-declared verifiable release gates that have no verifier section", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    const fullCoverage = getVerifiableReleaseGateCoverage({
      manifest,
      sections: manifest.release_gate_ids.map((id) => ({ id, ok: true })),
    });
    expect(fullCoverage.missing_verifiable_release_gate_ids).toEqual([]);
    expect(fullCoverage.failed_verifiable_release_gate_ids).toEqual([]);
    expect(fullCoverage.verified_release_gate_ids).toEqual(fullCoverage.verifiable_release_gate_ids);

    const partialCoverage = getVerifiableReleaseGateCoverage({
      manifest,
      sections: manifest.release_gate_ids
        .filter((id) => id !== "dojo_implementation_status_self_check")
        .map((id) => ({ id, ok: true })),
    });
    expect(partialCoverage.missing_verifiable_release_gate_ids).toEqual([
      "dojo_implementation_status_self_check",
    ]);

    const failedCoverage = getVerifiableReleaseGateCoverage({
      manifest,
      sections: [
        { id: "dojo_implementation_status_self_check", ok: false },
        { id: "dojo_postgres_control_plane_self_check", ok: true },
      ],
    });
    expect(failedCoverage.attempted_release_gate_ids).toEqual([
      "dojo_implementation_status_self_check",
      "dojo_postgres_control_plane_self_check",
    ]);
    expect(failedCoverage.verified_release_gate_ids).toEqual([
      "dojo_postgres_control_plane_self_check",
    ]);
    expect(failedCoverage.failed_verifiable_release_gate_ids).toEqual([
      "dojo_implementation_status_self_check",
    ]);
    expect(failedCoverage.missing_verifiable_release_gate_ids).not.toContain("dojo_implementation_status_self_check");
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

    const mismatchedArtifacts = await writeProofSelfCheckFixture({
      dir,
      basename: "dojo-proof-self-check-identity-rejected",
      summary: proofSelfCheckSummaryFixture({
        production_proof_capsule_id: "capsule-summary-other",
      }),
      productionEvidence: productionRuntimeEvidenceFixture({
        proof_capsule_id: "capsule-evidence-other",
        runtime_session: {
          ...productionRuntimeEvidenceFixture().runtime_session,
          run_id: "production-run-other",
        },
        runtime_authorization: {
          ...productionRuntimeEvidenceFixture().runtime_authorization,
          session_id: "runtime-session-other",
        },
        proof_record: {
          ...productionRuntimeEvidenceFixture().proof_record,
          capsule_id: "capsule-record-other",
        },
      }),
    });
    const mismatched = await verifyDojoProofSelfCheckArtifacts({
      summaryPath: mismatchedArtifacts.summaryPath,
      productionEvidencePath: mismatchedArtifacts.productionEvidencePath,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors).toEqual(expect.arrayContaining([
      "dojo_self_check_production_proof_capsule_mismatch:capsule-summary-other:capsule-evidence-other",
      "dojo_self_check_proof_record_capsule_mismatch:capsule-record-other:capsule-evidence-other",
      "dojo_self_check_runtime_session_run_mismatch:production-run-other:proof-self-check-production",
      "dojo_self_check_runtime_authorization_session_mismatch:runtime-session-other:dojo_runtime_session_fixture",
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

  it("verifies evidence authority evidence and rejects unverified proof-claim coverage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-evidence-authority-verify-"));
    const evidencePath = await writeEvidenceAuthorityEvidenceFixture({ dir });
    const evidence = await readJson(evidencePath);

    expect(validateDojoEvidenceAuthorityEvidenceForMilestone(evidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath })).toEqual(expect.objectContaining({
      id: "dojo_evidence_authority_self_check",
      ok: true,
      errors: [],
      evidence_path: evidencePath,
    }));

    const rejectedPath = await writeEvidenceAuthorityEvidenceFixture({
      dir,
      basename: "dojo-evidence-authority-rejected",
      evidence: evidenceAuthorityEvidenceFixture({
        ok: false,
        capability_coverage_complete: false,
        missing_capabilities: ["proof_issuance_requires_verified_evidence_records"],
        evidence_authority: {
          ...evidenceAuthorityEvidenceFixture().evidence_authority,
          evidence_retention_policy_required: false,
          legal_hold_blocks_disposal_required: false,
          external_storage_custody_receipts_required: false,
          proof_issue_claim_verification_required: false,
          proof_validation_rejects_self_attested_claims_required: false,
          durable_postgres_ledger_gate_id: "wrong_gate",
        },
      }),
    });
    const rejected = await verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath: rejectedPath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "evidence_authority_not_ok",
      "evidence_authority_coverage_incomplete",
      "evidence_authority_missing_capabilities:proof_issuance_requires_verified_evidence_records",
      "evidence_authority_retention_policy_requirement_missing",
      "evidence_authority_legal_hold_requirement_missing",
      "evidence_authority_external_storage_custody_requirement_missing",
      "evidence_authority_proof_issue_requirement_missing",
      "evidence_authority_self_attested_rejection_requirement_missing",
      "evidence_authority_durable_postgres_gate_id_missing",
    ]));

    const missingExecutionPath = await writeEvidenceAuthorityEvidenceFixture({
      dir,
      basename: "dojo-evidence-authority-missing-execution",
      evidence: evidenceAuthorityEvidenceFixture({
        evidence_authority: {
          ...evidenceAuthorityEvidenceFixture().evidence_authority,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "evidence_authority_self_check_execution_requirement_missing",
      "evidence_authority_test_execution_missing",
    ]));

    const driftedExecutionArgsPath = await writeEvidenceAuthorityEvidenceFixture({
      dir,
      basename: "dojo-evidence-authority-drifted-execution-args",
      evidence: evidenceAuthorityEvidenceFixture({
        test_execution: {
          ...evidenceAuthorityEvidenceFixture().test_execution,
          args: ["vitest", "run", ...DOJO_EVIDENCE_AUTHORITY_TEST_FILES.slice(1)],
        },
      }),
    });
    const driftedExecutionArgs = await verifyDojoEvidenceAuthorityEvidenceArtifact({
      evidencePath: driftedExecutionArgsPath,
    });
    expect(driftedExecutionArgs.ok).toBe(false);
    expect(driftedExecutionArgs.errors).toEqual(expect.arrayContaining([
      `evidence_authority_test_execution_required_args_missing:${DOJO_EVIDENCE_AUTHORITY_TEST_FILES[0]}`,
    ]));

    const driftedPath = await writeEvidenceAuthorityEvidenceFixture({
      dir,
      basename: "dojo-evidence-authority-drifted",
      evidence: evidenceAuthorityEvidenceFixture({
        test_files: DOJO_EVIDENCE_AUTHORITY_TEST_FILES
          .filter((file) => file !== DOJO_EVIDENCE_AUTHORITY_TEST_FILES[0]),
        test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length - 1,
        configured_capabilities: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
          .filter((capability) => capability !== "proof_issuance_requires_verified_evidence_records"),
        tested_capabilities: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
          .filter((capability) => capability !== "proof_issuance_requires_verified_evidence_records"),
        capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length - 1,
      }),
    });
    const drifted = await verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath: driftedPath });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      "evidence_authority_required_capabilities_missing:proof_issuance_requires_verified_evidence_records",
      "evidence_authority_required_capabilities_untested:proof_issuance_requires_verified_evidence_records",
      `evidence_authority_required_test_files_missing:${DOJO_EVIDENCE_AUTHORITY_TEST_FILES[0]}`,
    ]));

    const forgedJson = JSON.stringify({
      success: false,
      numTotalTests: 13,
      numPassedTests: 12,
      numFailedTests: 1,
      numPendingTests: 0,
      numTotalTestSuites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
      numPassedTestSuites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length - 1,
      numFailedTestSuites: 1,
      testResults: [],
    }, null, 2);
    const forgedJsonPath = path.join(dir, "dojo-evidence-authority-forged.vitest.json");
    await writeFile(forgedJsonPath, forgedJson, "utf8");
    const forgedSummaryPath = await writeEvidenceAuthorityEvidenceFixture({
      dir,
      basename: "dojo-evidence-authority-forged-summary",
      evidence: evidenceAuthorityEvidenceFixture({
        json_report_path: forgedJsonPath,
        json_report_sha256: sha256(forgedJson),
        json_report_bytes: Buffer.byteLength(forgedJson),
        test_summary: {
          total_tests: 13,
          passed_tests: 13,
          failed_tests: 0,
          pending_tests: 0,
        },
      }),
    });
    const forgedSummary = await verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath: forgedSummaryPath });
    expect(forgedSummary.ok).toBe(false);
    expect(forgedSummary.errors).toEqual(expect.arrayContaining([
      "json_report_success_false",
      "json_report_test_summary_mismatch:passed_tests:13:12",
      "json_report_test_summary_mismatch:failed_tests:0:1",
    ]));
  });

  it("verifies implementation-status evidence and rejects overclaim boundary drift", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-implementation-status-verify-"));
    const evidencePath = await writeImplementationStatusEvidenceFixture({ dir });
    const evidence = await readJson(evidencePath);

    expect(validateDojoImplementationStatusEvidenceForRelease(evidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoImplementationStatusEvidenceArtifact({ evidencePath })).toEqual(expect.objectContaining({
      id: "dojo_implementation_status_self_check",
      ok: true,
      errors: [],
      evidence_path: evidencePath,
    }));

    const rejectedPath = await writeImplementationStatusEvidenceFixture({
      dir,
      basename: "dojo-implementation-status-rejected",
      evidence: implementationStatusEvidenceFixture({
        ok: false,
        capability_coverage_complete: false,
        missing_capabilities: ["no_mature_production_runtime_claims"],
        implementation_status_contract: {
          ...implementationStatusEvidenceFixture().implementation_status_contract,
          production_runtime_claim_boundary_required: false,
          runtime_scope_required_for_executable_required: false,
          self_check_executes_tests_required: false,
        },
      }),
    });
    const rejected = await verifyDojoImplementationStatusEvidenceArtifact({ evidencePath: rejectedPath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "implementation_status_not_ok",
      "implementation_status_coverage_incomplete",
      "implementation_status_missing_capabilities:no_mature_production_runtime_claims",
      "implementation_status_production_boundary_requirement_missing",
      "implementation_status_runtime_scope_requirement_missing",
      "implementation_status_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeImplementationStatusEvidenceFixture({
      dir,
      basename: "dojo-implementation-status-missing-execution",
      evidence: implementationStatusEvidenceFixture({
        implementation_status_contract: {
          ...implementationStatusEvidenceFixture().implementation_status_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoImplementationStatusEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "implementation_status_self_check_execution_requirement_missing",
      "implementation_status_test_execution_missing",
    ]));

    const driftedPath = await writeImplementationStatusEvidenceFixture({
      dir,
      basename: "dojo-implementation-status-drifted",
      evidence: implementationStatusEvidenceFixture({
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
        configured_capabilities: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
          .filter((capability) => capability !== "maturity_manifest_synced"),
        tested_capabilities: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
          .filter((capability) => capability !== "maturity_manifest_synced"),
        capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length - 1,
      }),
    });
    const drifted = await verifyDojoImplementationStatusEvidenceArtifact({ evidencePath: driftedPath });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      "implementation_status_required_capabilities_missing:maturity_manifest_synced",
      "implementation_status_required_capabilities_untested:maturity_manifest_synced",
      `implementation_status_required_test_files_missing:${DOJO_IMPLEMENTATION_STATUS_TEST_FILES.join(",")}`,
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

  it("verifies affordance codemod report evidence before source/API promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-affordance-codemod-verify-"));
    const { report, reportPath, evidencePath } = await writeAffordanceCodemodFixture({ dir });

    expect(validateDojoAffordanceCodemodEvidenceForRelease(report, report.evidence)).toEqual({ ok: true, errors: [] });
    expect(await verifyDojoAffordanceCodemodEvidenceArtifact({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const rejected = await writeAffordanceCodemodFixture({
      dir,
      basename: "dojo-affordance-codemod-rejected",
      report: affordanceCodemodReportFixture({
        before_contract: { ok: true },
        before_vitest: { ok: true },
      }),
    });
    const rejectedResult = await verifyDojoAffordanceCodemodEvidenceArtifact({
      reportPath: rejected.reportPath,
      evidencePath: rejected.evidencePath,
      releaseCandidate: true,
    });
    expect(rejectedResult.ok).toBe(false);
    expect(rejectedResult.errors).toEqual(expect.arrayContaining([
      "affordance_codemod_before_did_not_fail",
    ]));

    const driftedEvidencePath = path.join(dir, "dojo-affordance-codemod-drifted.evidence.json");
    await writeFile(driftedEvidencePath, JSON.stringify({
      ...report.evidence,
      report_sha256: sha256("tampered-affordance-report"),
    }, null, 2), "utf8");
    const drifted = await verifyDojoAffordanceCodemodEvidenceArtifact({
      reportPath,
      evidencePath: driftedEvidencePath,
      releaseCandidate: true,
    });
    expect(drifted.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^report_sha256_mismatch:/),
    ]));
  });

  it("verifies API tool compiler evidence before source/API promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-api-tool-compiler-verify-"));
    const evidencePath = await writeApiToolCompilerEvidenceFixture({ dir });

    expect(validateDojoApiToolCompilerEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoApiToolCompilerEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_api_tool_compiler_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = apiToolCompilerEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["api_tool_executes_with_idempotency_postcondition_and_evidence"],
      promotion_contract: {
        ...apiToolCompilerEvidenceFixture().promotion_contract,
        proof_capsule_required: false,
        evidence_write_required: false,
        self_check_executes_tests_required: false,
        production_candidate_only_execution_allowed: true,
      },
    });
    const incompletePath = await writeApiToolCompilerEvidenceFixture({
      dir,
      basename: "incomplete-api-tool-compiler",
      evidence: incomplete,
    });
    const rejected = await verifyDojoApiToolCompilerEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "api_tool_compiler_not_ok",
      "api_tool_compiler_coverage_incomplete",
      "api_tool_compiler_missing_capabilities:api_tool_executes_with_idempotency_postcondition_and_evidence",
      "api_tool_compiler_proof_requirement_missing",
      "api_tool_compiler_evidence_requirement_missing",
      "api_tool_compiler_self_check_execution_requirement_missing",
      "api_tool_compiler_candidate_only_production_allowed",
    ]));

    const missingExecutionPath = await writeApiToolCompilerEvidenceFixture({
      dir,
      basename: "api-tool-compiler-missing-execution",
      evidence: apiToolCompilerEvidenceFixture({
        promotion_contract: {
          ...apiToolCompilerEvidenceFixture().promotion_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoApiToolCompilerEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "api_tool_compiler_self_check_execution_requirement_missing",
      "api_tool_compiler_test_execution_missing",
    ]));

    const driftedPath = await writeApiToolCompilerEvidenceFixture({
      dir,
      basename: "drifted-api-tool-compiler",
      evidence: apiToolCompilerEvidenceFixture({
        configured_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES
          .filter((capability) => capability !== "substrate_blocks_graph_api_proof_mismatch"),
        tested_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES
          .filter((capability) => capability !== "substrate_blocks_graph_api_proof_mismatch"),
        capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length - 1,
        test_files: DOJO_API_TOOL_COMPILER_TEST_FILES
          .filter((file) => file !== DOJO_API_TOOL_COMPILER_TEST_FILES[0]),
        test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length - 1,
      }),
    });
    expect((await verifyDojoApiToolCompilerEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "api_tool_compiler_required_capabilities_missing:substrate_blocks_graph_api_proof_mismatch",
      "api_tool_compiler_required_capabilities_untested:substrate_blocks_graph_api_proof_mismatch",
      `api_tool_compiler_required_test_files_missing:${DOJO_API_TOOL_COMPILER_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-api-tool-compiler.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedJson = apiToolCompilerJsonReportFixtureText();
    const tamperedJsonPath = await writeApiToolCompilerEvidenceFixture({
      dir,
      basename: "tampered-api-tool-compiler-json",
      evidence: apiToolCompilerEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedJson),
        json_report_bytes: Buffer.byteLength(expectedJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoApiToolCompilerEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies generated PR evidence before source patch promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-generated-pr-verify-"));
    const evidencePath = await writeGeneratedPrEvidenceFixture({ dir });

    expect(validateDojoGeneratedPrEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoGeneratedPrEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_generated_pr_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = generatedPrEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["generated_pr_git_branch_creates_branch_and_tests"],
      generated_pr_contract: {
        ...generatedPrEvidenceFixture().generated_pr_contract,
        git_branch_creation_required: false,
        generated_contract_tests_required: false,
      },
    });
    const incompletePath = await writeGeneratedPrEvidenceFixture({
      dir,
      basename: "incomplete-generated-pr",
      evidence: incomplete,
    });
    const rejected = await verifyDojoGeneratedPrEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "generated_pr_not_ok",
      "generated_pr_coverage_incomplete",
      "generated_pr_missing_capabilities:generated_pr_git_branch_creates_branch_and_tests",
      "generated_pr_git_branch_requirement_missing",
      "generated_pr_contract_tests_requirement_missing",
    ]));

    const missingExecutionPath = await writeGeneratedPrEvidenceFixture({
      dir,
      basename: "missing-execution-generated-pr",
      evidence: generatedPrEvidenceFixture({
        generated_pr_contract: {
          ...generatedPrEvidenceFixture().generated_pr_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoGeneratedPrEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "generated_pr_self_check_execution_requirement_missing",
      "generated_pr_test_execution_missing",
    ]));

    const driftedPath = await writeGeneratedPrEvidenceFixture({
      dir,
      basename: "drifted-generated-pr",
      evidence: generatedPrEvidenceFixture({
        configured_capabilities: DOJO_GENERATED_PR_CAPABILITIES
          .filter((capability) => capability !== "generated_pr_metadata_reviewable_with_code_owners_and_proof_impact"),
        tested_capabilities: DOJO_GENERATED_PR_CAPABILITIES
          .filter((capability) => capability !== "generated_pr_metadata_reviewable_with_code_owners_and_proof_impact"),
        capability_count: DOJO_GENERATED_PR_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_GENERATED_PR_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoGeneratedPrEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "generated_pr_required_capabilities_missing:generated_pr_metadata_reviewable_with_code_owners_and_proof_impact",
      "generated_pr_required_capabilities_untested:generated_pr_metadata_reviewable_with_code_owners_and_proof_impact",
      `generated_pr_required_test_files_missing:${DOJO_GENERATED_PR_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies MCP Skill Bus evidence before certified competency release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-mcp-skill-bus-verify-"));
    const evidencePath = await writeMcpSkillBusEvidenceFixture({ dir });

    expect(validateDojoMcpSkillBusEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoMcpSkillBusEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_mcp_skill_bus_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = mcpSkillBusEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["mcp_skill_bus_consumes_proof_before_non_dry_dispatch"],
      mcp_skill_bus_contract: {
        ...mcpSkillBusEvidenceFixture().mcp_skill_bus_contract,
        api_backed_tool_resolution_required: false,
        api_backed_canonical_dispatch_context_required: false,
        proof_consume_required: false,
        tenant_boundary_required: false,
      },
    });
    const incompletePath = await writeMcpSkillBusEvidenceFixture({
      dir,
      basename: "incomplete-mcp-skill-bus",
      evidence: incomplete,
    });
    const rejected = await verifyDojoMcpSkillBusEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "mcp_skill_bus_not_ok",
      "mcp_skill_bus_coverage_incomplete",
      "mcp_skill_bus_missing_capabilities:mcp_skill_bus_consumes_proof_before_non_dry_dispatch",
      "mcp_skill_bus_api_backed_tool_resolution_requirement_missing",
      "mcp_skill_bus_api_backed_dispatch_context_requirement_missing",
      "mcp_skill_bus_proof_consume_requirement_missing",
      "mcp_skill_bus_tenant_boundary_requirement_missing",
    ]));

    const missingExecutionPath = await writeMcpSkillBusEvidenceFixture({
      dir,
      basename: "missing-execution-mcp-skill-bus",
      evidence: mcpSkillBusEvidenceFixture({
        mcp_skill_bus_contract: {
          ...mcpSkillBusEvidenceFixture().mcp_skill_bus_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoMcpSkillBusEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "mcp_skill_bus_self_check_execution_requirement_missing",
      "mcp_skill_bus_test_execution_missing",
    ]));

    const driftedPath = await writeMcpSkillBusEvidenceFixture({
      dir,
      basename: "drifted-mcp-skill-bus",
      evidence: mcpSkillBusEvidenceFixture({
        configured_capabilities: DOJO_MCP_SKILL_BUS_CAPABILITIES
          .filter((capability) => capability !== "mcp_manifest_ed25519_public_verification"),
        tested_capabilities: DOJO_MCP_SKILL_BUS_CAPABILITIES
          .filter((capability) => capability !== "mcp_manifest_ed25519_public_verification"),
        capability_count: DOJO_MCP_SKILL_BUS_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_MCP_SKILL_BUS_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoMcpSkillBusEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "mcp_skill_bus_required_capabilities_missing:mcp_manifest_ed25519_public_verification",
      "mcp_skill_bus_required_capabilities_untested:mcp_manifest_ed25519_public_verification",
      `mcp_skill_bus_required_test_files_missing:${DOJO_MCP_SKILL_BUS_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies source drift evidence before source/API promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-source-drift-verify-"));
    const evidencePath = await writeSourceDriftEvidenceFixture({ dir });

    expect(validateDojoSourceDriftEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoSourceDriftEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_source_drift_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = sourceDriftEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["source_drift_rejects_unverified_snapshots"],
      source_drift_contract: {
        ...sourceDriftEvidenceFixture().source_drift_contract,
        changed_token_expiry_required: false,
        tamper_rejection_required: false,
        license_store_expiry_application_required: false,
        recertification_handoff_required: false,
      },
    });
    const incompletePath = await writeSourceDriftEvidenceFixture({
      dir,
      basename: "incomplete-source-drift",
      evidence: incomplete,
    });
    const rejected = await verifyDojoSourceDriftEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "source_drift_not_ok",
      "source_drift_coverage_incomplete",
      "source_drift_missing_capabilities:source_drift_rejects_unverified_snapshots",
      "source_drift_changed_token_expiry_requirement_missing",
      "source_drift_tamper_rejection_requirement_missing",
      "source_drift_license_store_expiry_requirement_missing",
      "source_drift_recertification_handoff_requirement_missing",
    ]));

    const missingExecutionPath = await writeSourceDriftEvidenceFixture({
      dir,
      basename: "source-drift-missing-execution",
      evidence: sourceDriftEvidenceFixture({
        source_drift_contract: {
          ...sourceDriftEvidenceFixture().source_drift_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoSourceDriftEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "source_drift_self_check_execution_requirement_missing",
      "source_drift_test_execution_missing",
    ]));

    const driftedPath = await writeSourceDriftEvidenceFixture({
      dir,
      basename: "drifted-source-drift",
      evidence: sourceDriftEvidenceFixture({
        configured_capabilities: DOJO_SOURCE_DRIFT_CAPABILITIES
          .filter((capability) => capability !== "source_drift_expires_changed_source_tokens"),
        tested_capabilities: DOJO_SOURCE_DRIFT_CAPABILITIES
          .filter((capability) => capability !== "source_drift_expires_changed_source_tokens"),
        capability_count: DOJO_SOURCE_DRIFT_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_SOURCE_DRIFT_CAPABILITIES.length - 1,
        test_files: DOJO_SOURCE_DRIFT_TEST_FILES
          .filter((file) => file !== DOJO_SOURCE_DRIFT_TEST_FILES[0]),
        test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length - 1,
      }),
    });
    expect((await verifyDojoSourceDriftEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "source_drift_required_capabilities_missing:source_drift_expires_changed_source_tokens",
      "source_drift_required_capabilities_untested:source_drift_expires_changed_source_tokens",
      `source_drift_required_test_files_missing:${DOJO_SOURCE_DRIFT_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-source-drift.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedJson = sourceDriftJsonReportFixtureText();
    const tamperedJsonPath = await writeSourceDriftEvidenceFixture({
      dir,
      basename: "tampered-source-drift-json",
      evidence: sourceDriftEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedJson),
        json_report_bytes: Buffer.byteLength(expectedJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoSourceDriftEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies Agent-Ready UI Contract evidence before source/API promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-agent-ready-ui-contract-verify-"));
    const evidencePath = await writeAgentReadyUiContractEvidenceFixture({ dir });

    expect(validateDojoAgentReadyUiContractEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoAgentReadyUiContractEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_agent_ready_ui_contract_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = agentReadyUiContractEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["agent_ready_ui_contract_requires_proof_hook"],
      agent_ready_ui_contract: {
        ...agentReadyUiContractEvidenceFixture().agent_ready_ui_contract,
        proof_hook_required: false,
        stable_locator_required: false,
      },
    });
    const incompletePath = await writeAgentReadyUiContractEvidenceFixture({
      dir,
      basename: "incomplete-agent-ready-ui-contract",
      evidence: incomplete,
    });
    const rejected = await verifyDojoAgentReadyUiContractEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "agent_ready_ui_contract_not_ok",
      "agent_ready_ui_contract_coverage_incomplete",
      "agent_ready_ui_contract_missing_capabilities:agent_ready_ui_contract_requires_proof_hook",
      "agent_ready_ui_contract_proof_hook_requirement_missing",
      "agent_ready_ui_contract_stable_locator_requirement_missing",
    ]));

    const missingExecutionPath = await writeAgentReadyUiContractEvidenceFixture({
      dir,
      basename: "agent-ready-ui-contract-missing-execution",
      evidence: agentReadyUiContractEvidenceFixture({
        agent_ready_ui_contract: {
          ...agentReadyUiContractEvidenceFixture().agent_ready_ui_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoAgentReadyUiContractEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "agent_ready_ui_contract_self_check_execution_requirement_missing",
      "agent_ready_ui_contract_test_execution_missing",
    ]));

    const driftedPath = await writeAgentReadyUiContractEvidenceFixture({
      dir,
      basename: "drifted-agent-ready-ui-contract",
      evidence: agentReadyUiContractEvidenceFixture({
        configured_capabilities: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
          .filter((capability) => capability !== "agent_ready_ui_contract_requires_proof_hook"),
        tested_capabilities: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
          .filter((capability) => capability !== "agent_ready_ui_contract_requires_proof_hook"),
        capability_count: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length - 1,
        test_files: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES
          .filter((file) => file !== DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES[0]),
        test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length - 1,
      }),
    });
    expect((await verifyDojoAgentReadyUiContractEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "agent_ready_ui_contract_required_capabilities_missing:agent_ready_ui_contract_requires_proof_hook",
      "agent_ready_ui_contract_required_capabilities_untested:agent_ready_ui_contract_requires_proof_hook",
      `agent_ready_ui_contract_required_test_files_missing:${DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-agent-ready-ui-contract.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedJson = agentReadyUiContractJsonReportFixtureText();
    const tamperedJsonPath = await writeAgentReadyUiContractEvidenceFixture({
      dir,
      basename: "tampered-agent-ready-ui-contract-json",
      evidence: agentReadyUiContractEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedJson),
        json_report_bytes: Buffer.byteLength(expectedJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoAgentReadyUiContractEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
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

  it("requires private-tool transcript visual snapshots to be PNG digest-matched artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-private-tool-visual-verify-"));
    const fakePngPath = path.join(dir, "fake-stdio.png");
    const fakeBytes = Buffer.from("not-a-png");
    await writeFile(fakePngPath, fakeBytes);
    const fakeTranscriptPath = path.join(dir, "fake-stdio.json");
    await writeFile(fakeTranscriptPath, JSON.stringify(privateToolStdioAcceptanceFixture({
      screenshotPath: fakePngPath,
      screenshotBytes: fakeBytes.length,
      screenshotSha256: sha256(fakeBytes),
    }), null, 2), "utf8");

    const fakeRejected = await verifyDojoPrivateToolStdioAcceptanceArtifact({
      transcriptPath: fakeTranscriptPath,
      releaseCandidate: true,
    });
    expect(fakeRejected.ok).toBe(false);
    expect(fakeRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^private_tool_stdio_acceptance_visual_screenshot_not_png:/),
    ]));

    const pngPath = path.join(dir, "digest-drift-codex.png");
    const pngBytes = fixtureVisualPngBytes();
    await writeFile(pngPath, pngBytes);
    const digestDriftPath = path.join(dir, "digest-drift-codex.json");
    await writeFile(digestDriftPath, JSON.stringify(privateToolCodexAcceptanceFixture({
      screenshotPath: pngPath,
      screenshotBytes: pngBytes.length,
      screenshotSha256: sha256("wrong-visual-bytes"),
    }), null, 2), "utf8");

    const digestRejected = await verifyDojoPrivateToolCodexAcceptanceArtifact({
      transcriptPath: digestDriftPath,
      releaseCandidate: true,
    });
    expect(digestRejected.ok).toBe(false);
    expect(digestRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^private_tool_codex_acceptance_visual_screenshot_sha256_mismatch:/),
    ]));
  });

  it("requires workflow E2E visual artifacts to be PNG digest-matched artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-workflow-visual-verify-"));
    const fakePath = path.join(dir, "workflow-fake.png");
    const fakeBytes = Buffer.from("not-a-png");
    await writeFile(fakePath, fakeBytes);
    const fakeSummaryPath = path.join(dir, "workflow-fake.json");
    await writeFile(fakeSummaryPath, JSON.stringify(workflowE2EFixture({
      visual_artifact_count: 1,
      visual_artifacts: [
        {
          case_id: "fixture-case",
          stage: "fake_visual",
          source: "unit_fixture",
          path: fakePath,
          bytes: fakeBytes.length,
          screenshot_sha256: sha256(fakeBytes),
          mime_type: "image/png",
          png_verified: true,
        },
      ],
    }), null, 2), "utf8");

    const fakeRejected = await verifyDojoWorkflowPipelineE2EArtifact({
      summaryPath: fakeSummaryPath,
      releaseCandidate: true,
    });
    expect(fakeRejected.ok).toBe(false);
    expect(fakeRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^workflow_e2e_visual_artifact_not_png:fake_visual:/),
    ]));

    const pngPath = path.join(dir, "workflow-digest-drift.png");
    const pngBytes = fixtureVisualPngBytes();
    await writeFile(pngPath, pngBytes);
    const digestDriftPath = path.join(dir, "workflow-digest-drift.json");
    await writeFile(digestDriftPath, JSON.stringify(workflowE2EFixture({
      visual_artifact_count: 1,
      visual_artifacts: [
        {
          case_id: "fixture-case",
          stage: "digest_drift",
          source: "unit_fixture",
          path: pngPath,
          bytes: pngBytes.length,
          screenshot_sha256: sha256("wrong-workflow-visual"),
          mime_type: "image/png",
          png_verified: true,
        },
      ],
    }), null, 2), "utf8");

    const digestRejected = await verifyDojoWorkflowPipelineE2EArtifact({
      summaryPath: digestDriftPath,
      releaseCandidate: true,
    });
    expect(digestRejected.ok).toBe(false);
    expect(digestRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^workflow_e2e_visual_artifact_sha256_mismatch:digest_drift:/),
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

  it("reports missing release-candidate artifacts as structured gate failures", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-candidate-missing-artifacts-"));
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    const workflowSummaryPath = path.join(dir, "missing-workflow-summary.json");
    const stdioTranscriptPath = path.join(dir, "missing-stdio-acceptance.json");
    const codexTranscriptPath = path.join(dir, "missing-codex-acceptance.json");
    manifest.gates.find((gate) => gate.id === "workflow_e2e_hosted").default_report_path = workflowSummaryPath;
    manifest.gates.find((gate) => gate.id === "private_tool_stdio_acceptance").default_report_path = stdioTranscriptPath;
    manifest.gates.find((gate) => gate.id === "private_tool_codex_acceptance").default_report_path = codexTranscriptPath;
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest, manifestPath, evidencePath });

    const verified = await verifyDojoReleaseGateArtifactsFromArgs({
      args: {
        "release-candidate": "1",
        manifest: manifestPath,
        evidence: evidencePath,
      },
    });

    expect(verified.ok).toBe(false);
    expect(verified.errors).toEqual(expect.arrayContaining([
      `workflow_e2e_hosted:artifact_missing:${workflowSummaryPath}`,
      `private_tool_stdio_acceptance:artifact_missing:${stdioTranscriptPath}`,
      `private_tool_codex_acceptance:artifact_missing:${codexTranscriptPath}`,
    ]));
    expect(verified.verified_release_gate_ids).not.toEqual(expect.arrayContaining([
      "workflow_e2e_hosted",
      "private_tool_stdio_acceptance",
      "private_tool_codex_acceptance",
    ]));
    expect(verified.attempted_release_gate_ids).toEqual(expect.arrayContaining([
      "workflow_e2e_hosted",
      "private_tool_stdio_acceptance",
      "private_tool_codex_acceptance",
    ]));
    expect(verified.failed_verifiable_release_gate_ids).toEqual(expect.arrayContaining([
      "workflow_e2e_hosted",
      "private_tool_stdio_acceptance",
      "private_tool_codex_acceptance",
    ]));
    expect(verified.live_hosted_runtime).toEqual([
      expect.objectContaining({
        id: "workflow_e2e_hosted",
        ok: false,
        artifact_path: workflowSummaryPath,
        errors: [`artifact_missing:${workflowSummaryPath}`],
      }),
      expect.objectContaining({
        id: "private_tool_stdio_acceptance",
        ok: false,
        artifact_path: stdioTranscriptPath,
        errors: [`artifact_missing:${stdioTranscriptPath}`],
      }),
      expect.objectContaining({
        id: "private_tool_codex_acceptance",
        ok: false,
        artifact_path: codexTranscriptPath,
        errors: [`artifact_missing:${codexTranscriptPath}`],
      }),
    ]);
  });

  it("can require complete release-gate artifact coverage outside release-candidate mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-strict-release-gate-coverage-"));
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest, manifestPath, evidencePath });

    const verified = await verifyDojoReleaseGateArtifactsFromArgs({
      args: {
        "require-complete-release-gate-coverage": "1",
        manifest: manifestPath,
        evidence: evidencePath,
      },
    });

    expect(verified.ok).toBe(false);
    expect(verified.complete_release_gate_coverage_required).toBe(true);
    expect(verified.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^release_gate_artifact_verification_missing:/),
    ]));
    expect(verified.missing_verifiable_release_gate_ids).toEqual(expect.arrayContaining([
      "dojo_self_check",
      "dojo_implementation_status_self_check",
    ]));
    expect(verified.attempted_release_gate_ids).toEqual([]);
  });

  it("includes manifest-declared Dojo proof self-check artifacts in release candidate verification", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-candidate-self-check-"));
    const selfCheck = await writeProofSelfCheckFixture({ dir });
    const postgresEvidencePath = await writePostgresControlPlaneEvidenceFixture({ dir });
    const evidenceAuthorityEvidencePath = await writeEvidenceAuthorityEvidenceFixture({ dir });
    const implementationStatusEvidencePath = await writeImplementationStatusEvidenceFixture({ dir });
    const dockerEvidencePath = await writeDockerIntegrationEvidenceFixture({ dir });
    const affordanceCodemod = await writeAffordanceCodemodFixture({ dir });
    const sourceDriftEvidencePath = await writeSourceDriftEvidenceFixture({ dir });
    const agentReadyUiContractEvidencePath = await writeAgentReadyUiContractEvidenceFixture({ dir });
    const apiToolCompilerEvidencePath = await writeApiToolCompilerEvidenceFixture({ dir });
    const generatedPrEvidencePath = await writeGeneratedPrEvidenceFixture({ dir });
    const mcpSkillBusEvidencePath = await writeMcpSkillBusEvidenceFixture({ dir });
    const conformanceSelfCheckReportPath = path.join(dir, "dojo-mcp-host-conformance-self-check.json");
    const conformanceSelfCheckEvidencePath = path.join(dir, "dojo-mcp-host-conformance-self-check.evidence.json");
    await writeConformancePair({
      report: buildConformanceSelfCheckReport(),
      reportPath: conformanceSelfCheckReportPath,
      evidencePath: conformanceSelfCheckEvidencePath,
    });
    const conformanceReportPath = path.join(dir, "dojo-mcp-host-conformance.json");
    const conformanceEvidencePath = path.join(dir, "dojo-mcp-host-conformance.evidence.json");
    await writeConformancePair({
      report: buildConformanceReport(),
      reportPath: conformanceReportPath,
      evidencePath: conformanceEvidencePath,
    });
    const securityEvidencePath = await writeSecurityEvidenceFixture({ dir });
    const managedKeySigningEvidencePath = await writeManagedKeySigningEvidenceFixture({ dir });
    const publicProofVerificationEvidencePath = await writePublicProofVerificationEvidenceFixture({ dir });
    const governanceLifecycleEvidencePath = await writeGovernanceLifecycleEvidenceFixture({ dir });
    const graphRuntimeEvidencePath = await writeGraphRuntimeEvidenceFixture({ dir });
    const ghostModeEvidencePath = await writeGhostModeEvidenceFixture({ dir });
    const skillPassportEvidencePath = await writeSkillPassportEvidenceFixture({ dir });
    const timeMachineDebuggerEvidencePath = await writeTimeMachineDebuggerEvidenceFixture({ dir });
    const vivariumRuntimeEvidencePath = await writeVivariumRuntimeEvidenceFixture({ dir });
    const checkrideLicenseEvidencePath = await writeCheckrideLicenseEvidenceFixture({ dir });
    const caseLawRuntimeEvidencePath = await writeCaseLawRuntimeEvidenceFixture({ dir });
    const hostedRuntimeGatewayEvidencePath = await writeHostedRuntimeGatewayEvidenceFixture({ dir });
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
    const releaseGateRunnerGate = manifest.gates.find((gate) => gate.id === "dojo_release_gate_runner_self_check");
    releaseGateRunnerGate.default_report_path = path.join(dir, "dojo-release-gate-runner-self-check.json");
    releaseGateRunnerGate.default_evidence_path = path.join(dir, "dojo-release-gate-runner-self-check.evidence.json");
    const releaseGateVerifierGate = manifest.gates.find((gate) => gate.id === "dojo_release_gate_verifier_self_check");
    releaseGateVerifierGate.default_report_path = path.join(dir, "dojo-release-gate-verifier-self-check.json");
    releaseGateVerifierGate.default_evidence_path = path.join(dir, "dojo-release-gate-verifier-self-check.evidence.json");
    const selfCheckGate = manifest.gates.find((gate) => gate.id === "dojo_self_check");
    selfCheckGate.default_report_path = selfCheck.summaryPath;
    selfCheckGate.default_evidence_path = selfCheck.productionEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_postgres_control_plane_self_check").default_evidence_path = postgresEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_evidence_authority_self_check").default_evidence_path = evidenceAuthorityEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_implementation_status_self_check").default_evidence_path = implementationStatusEvidencePath;
    manifest.gates.find((gate) => gate.id === "docker_integration").default_evidence_path = dockerEvidencePath;
    const affordanceGate = manifest.gates.find((gate) => gate.id === "dojo_affordance_codemod_self_check");
    affordanceGate.default_report_path = affordanceCodemod.reportPath;
    affordanceGate.default_evidence_path = affordanceCodemod.evidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_source_drift_self_check").default_evidence_path = sourceDriftEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_agent_ready_ui_contract_self_check").default_evidence_path = agentReadyUiContractEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_api_tool_compiler_self_check").default_evidence_path = apiToolCompilerEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_generated_pr_self_check").default_evidence_path = generatedPrEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_mcp_skill_bus_self_check").default_evidence_path = mcpSkillBusEvidencePath;
    const conformanceSelfCheckGate = manifest.gates.find((gate) => gate.id === "dojo_mcp_host_conformance_self_check");
    conformanceSelfCheckGate.default_report_path = conformanceSelfCheckReportPath;
    conformanceSelfCheckGate.default_evidence_path = conformanceSelfCheckEvidencePath;
    manifest.gates.find((gate) => gate.id === "compliance_export_suite").default_evidence_path = complianceEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check").default_evidence_path = managedKeySigningEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_public_proof_verification_self_check").default_evidence_path = publicProofVerificationEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_governance_lifecycle_self_check").default_evidence_path = governanceLifecycleEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_graph_runtime_self_check").default_evidence_path = graphRuntimeEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_ghost_mode_evidence_self_check").default_evidence_path = ghostModeEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_skill_passport_self_check").default_evidence_path = skillPassportEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_time_machine_debugger_self_check").default_evidence_path = timeMachineDebuggerEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_vivarium_runtime_self_check").default_evidence_path = vivariumRuntimeEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_checkride_license_self_check").default_evidence_path = checkrideLicenseEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_case_law_runtime_self_check").default_evidence_path = caseLawRuntimeEvidencePath;
    manifest.gates.find((gate) => gate.id === "dojo_hosted_runtime_gateway_self_check").default_evidence_path = hostedRuntimeGatewayEvidencePath;
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
    const releaseGateRunner = await writeReleaseGateRunnerFixture({
      dir,
      basename: "dojo-release-gate-runner-self-check",
      manifest,
      packageScripts,
    });
    expect(releaseGateRunnerGate.default_report_path).toBe(releaseGateRunner.reportPath);
    expect(releaseGateRunnerGate.default_evidence_path).toBe(releaseGateRunner.evidencePath);
    const releaseGateVerifier = await writeReleaseGateVerifierFixture({
      dir,
      basename: "dojo-release-gate-verifier-self-check",
    });
    expect(releaseGateVerifierGate.default_report_path).toBe(releaseGateVerifier.reportPath);
    expect(releaseGateVerifierGate.default_evidence_path).toBe(releaseGateVerifier.evidencePath);
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
        "evidence-authority-evidence": evidenceAuthorityEvidencePath,
        "implementation-status-evidence": implementationStatusEvidencePath,
        "security-abuse-evidence": securityEvidencePath,
        "managed-key-signing-evidence": managedKeySigningEvidencePath,
        "public-proof-verification-evidence": publicProofVerificationEvidencePath,
        "governance-lifecycle-evidence": governanceLifecycleEvidencePath,
        "graph-runtime-evidence": graphRuntimeEvidencePath,
        "ghost-mode-evidence": ghostModeEvidencePath,
        "skill-passport-evidence": skillPassportEvidencePath,
        "time-machine-debugger-evidence": timeMachineDebuggerEvidencePath,
        "vivarium-runtime-evidence": vivariumRuntimeEvidencePath,
        "checkride-license-evidence": checkrideLicenseEvidencePath,
        "case-law-runtime-evidence": caseLawRuntimeEvidencePath,
        "hosted-runtime-gateway-evidence": hostedRuntimeGatewayEvidencePath,
        "source-drift-evidence": sourceDriftEvidencePath,
        "agent-ready-ui-contract-evidence": agentReadyUiContractEvidencePath,
        "api-tool-compiler-evidence": apiToolCompilerEvidencePath,
        "generated-pr-evidence": generatedPrEvidencePath,
        "mcp-skill-bus-evidence": mcpSkillBusEvidencePath,
      },
    });

    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
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
    expect(verified.implementation_status).toEqual([
      expect.objectContaining({
        id: "dojo_implementation_status_self_check",
        ok: true,
        evidence_path: implementationStatusEvidencePath,
      }),
    ]);
    expect(verified.release_gate_runner).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dojo_release_gate_runner_self_check",
        ok: true,
        artifact_path: releaseGateRunner.reportPath,
        evidence_path: releaseGateRunner.evidencePath,
      }),
    ]));
    expect(verified.release_gate_verifier).toEqual([
      expect.objectContaining({
        id: "dojo_release_gate_verifier_self_check",
        ok: true,
        artifact_path: releaseGateVerifier.reportPath,
        evidence_path: releaseGateVerifier.evidencePath,
      }),
    ]);
    expect(verified.evidence_authority).toEqual([
      expect.objectContaining({
        id: "dojo_evidence_authority_self_check",
        ok: true,
        evidence_path: evidenceAuthorityEvidencePath,
      }),
    ]);
    expect(verified.docker_integration).toEqual([
      expect.objectContaining({
        id: "docker_integration",
        ok: true,
        evidence_path: dockerEvidencePath,
      }),
    ]);
    expect(verified.source_api).toEqual([
      expect.objectContaining({
        id: "dojo_affordance_codemod_self_check",
        ok: true,
        artifact_path: affordanceCodemod.reportPath,
        evidence_path: affordanceCodemod.evidencePath,
      }),
      expect.objectContaining({
        id: "dojo_source_drift_self_check",
        ok: true,
        evidence_path: sourceDriftEvidencePath,
      }),
      expect.objectContaining({
        id: "dojo_agent_ready_ui_contract_self_check",
        ok: true,
        evidence_path: agentReadyUiContractEvidencePath,
      }),
      expect.objectContaining({
        id: "dojo_api_tool_compiler_self_check",
        ok: true,
        evidence_path: apiToolCompilerEvidencePath,
      }),
    ]);
    expect(verified.generated_pr).toEqual([
      expect.objectContaining({
        id: "dojo_generated_pr_self_check",
        ok: true,
        evidence_path: generatedPrEvidencePath,
      }),
    ]);
    expect(verified.mcp_skill_bus).toEqual([
      expect.objectContaining({
        id: "dojo_mcp_skill_bus_self_check",
        ok: true,
        evidence_path: mcpSkillBusEvidencePath,
      }),
    ]);
    expect(verified.mcp_host_conformance_self_check).toEqual([
      expect.objectContaining({
        id: "dojo_mcp_host_conformance_self_check",
        ok: true,
        artifact_path: conformanceSelfCheckReportPath,
        evidence_path: conformanceSelfCheckEvidencePath,
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
    expect(verified.managed_key_signing).toEqual([
      expect.objectContaining({
        id: "dojo_managed_key_signing_self_check",
        ok: true,
        evidence_path: managedKeySigningEvidencePath,
      }),
    ]);
    expect(verified.public_proof_verification).toEqual([
      expect.objectContaining({
        id: "dojo_public_proof_verification_self_check",
        ok: true,
        evidence_path: publicProofVerificationEvidencePath,
      }),
    ]);
    expect(verified.governance_lifecycle).toEqual([
      expect.objectContaining({
        id: "dojo_governance_lifecycle_self_check",
        ok: true,
        evidence_path: governanceLifecycleEvidencePath,
      }),
    ]);
    expect(verified.graph_runtime).toEqual([
      expect.objectContaining({
        id: "dojo_graph_runtime_self_check",
        ok: true,
        evidence_path: graphRuntimeEvidencePath,
      }),
    ]);
    expect(verified.ghost_mode_evidence).toEqual([
      expect.objectContaining({
        id: "dojo_ghost_mode_evidence_self_check",
        ok: true,
        evidence_path: ghostModeEvidencePath,
      }),
    ]);
    expect(verified.skill_passport).toEqual([
      expect.objectContaining({
        id: "dojo_skill_passport_self_check",
        ok: true,
        evidence_path: skillPassportEvidencePath,
      }),
    ]);
    expect(verified.time_machine_debugger).toEqual([
      expect.objectContaining({
        id: "dojo_time_machine_debugger_self_check",
        ok: true,
        evidence_path: timeMachineDebuggerEvidencePath,
      }),
    ]);
    expect(verified.vivarium_runtime).toEqual([
      expect.objectContaining({
        id: "dojo_vivarium_runtime_self_check",
        ok: true,
        evidence_path: vivariumRuntimeEvidencePath,
      }),
    ]);
    expect(verified.checkride_license).toEqual([
      expect.objectContaining({
        id: "dojo_checkride_license_self_check",
        ok: true,
        evidence_path: checkrideLicenseEvidencePath,
      }),
    ]);
    expect(verified.case_law_runtime).toEqual([
      expect.objectContaining({
        id: "dojo_case_law_runtime_self_check",
        ok: true,
        evidence_path: caseLawRuntimeEvidencePath,
      }),
    ]);
    expect(verified.hosted_runtime_gateway).toEqual([
      expect.objectContaining({
        id: "dojo_hosted_runtime_gateway_self_check",
        ok: true,
        evidence_path: hostedRuntimeGatewayEvidencePath,
      }),
    ]);
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

  it("verifies MCP host conformance self-check classifier coverage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-mcp-conformance-self-check-"));
    const report = buildConformanceSelfCheckReport();
    const reportPath = path.join(dir, "dojo-mcp-host-conformance-self-check.json");
    const evidencePath = path.join(dir, "dojo-mcp-host-conformance-self-check.evidence.json");
    await writeConformancePair({ report, reportPath, evidencePath });

    expect(validateDojoMcpHostConformanceSelfCheckReport(report)).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoMcpHostConformanceSelfCheckArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = buildConformanceSelfCheckReport({
      checkResults: report.check_results.filter((check) => check.id !== "private_network_rejection"),
      checks: report.checks.filter((check) => check !== "private network rejection"),
    });
    const incompletePath = path.join(dir, "dojo-mcp-host-conformance-self-check-incomplete.json");
    const incompleteEvidencePath = path.join(dir, "dojo-mcp-host-conformance-self-check-incomplete.evidence.json");
    await writeConformancePair({
      report: incomplete,
      reportPath: incompletePath,
      evidencePath: incompleteEvidencePath,
    });
    const rejected = await verifyDojoMcpHostConformanceSelfCheckArtifacts({
      reportPath: incompletePath,
      evidencePath: incompleteEvidencePath,
      releaseCandidate: true,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "conformance_self_check_private_network_rejection_missing",
    ]));
  });

  it("verifies managed key signing evidence coverage and signing contract custody", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-managed-key-signing-verify-"));
    const evidencePath = await writeManagedKeySigningEvidenceFixture({ dir });

    expect(validateDojoManagedKeySigningEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoManagedKeySigningEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = managedKeySigningEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["managed_key_service_rejects_local_custody_metadata"],
      signing_contract: {
        ...managedKeySigningEvidenceFixture().signing_contract,
        key_custody: "local",
        production_private_key_material_allowed: true,
        public_verifier_material_required: false,
        required_response_fields: ["schema_version", "algorithm", "key_id", "key_uri", "signature"],
      },
    });
    const incompletePath = await writeManagedKeySigningEvidenceFixture({
      dir,
      basename: "incomplete-managed-key-signing",
      evidence: incomplete,
    });
    const rejected = await verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "managed_key_signing_not_ok",
      "managed_key_signing_coverage_incomplete",
      "managed_key_signing_missing_capabilities:managed_key_service_rejects_local_custody_metadata",
      "managed_key_signing_custody_mismatch:local",
      "managed_key_signing_private_material_allowed",
      "managed_key_signing_public_verifier_requirement_missing",
      "managed_key_signing_response_field_missing:key_custody",
    ]));

    const driftedPath = await writeManagedKeySigningEvidenceFixture({
      dir,
      basename: "drifted-managed-key-signing",
      evidence: managedKeySigningEvidenceFixture({
        configured_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
          .filter((capability) => capability !== "managed_key_service_rejects_uri_mismatch"),
        tested_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
          .filter((capability) => capability !== "managed_key_service_rejects_uri_mismatch"),
        capability_count: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length - 1,
        test_files: DOJO_MANAGED_KEY_SIGNING_TEST_FILES
          .filter((file) => file !== DOJO_MANAGED_KEY_SIGNING_TEST_FILES[0]),
        test_file_count: DOJO_MANAGED_KEY_SIGNING_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_MANAGED_KEY_SIGNING_TEST_FILES.length - 1,
      }),
    });
    expect((await verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "managed_key_signing_required_capabilities_missing:managed_key_service_rejects_uri_mismatch",
      "managed_key_signing_required_capabilities_untested:managed_key_service_rejects_uri_mismatch",
      `managed_key_signing_required_test_files_missing:${DOJO_MANAGED_KEY_SIGNING_TEST_FILES[0]}`,
    ]));

    const missingExecutionPath = await writeManagedKeySigningEvidenceFixture({
      dir,
      basename: "missing-execution-managed-key-signing",
      evidence: managedKeySigningEvidenceFixture({
        test_execution: null,
      }),
    });
    expect((await verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath: missingExecutionPath })).errors).toEqual(expect.arrayContaining([
      "managed_key_signing_test_execution_missing",
    ]));

    const driftedExecutionArgsPath = await writeManagedKeySigningEvidenceFixture({
      dir,
      basename: "drifted-execution-args-managed-key-signing",
      evidence: managedKeySigningEvidenceFixture({
        test_execution: {
          ...managedKeySigningEvidenceFixture().test_execution,
          args: ["vitest", "run", ...DOJO_MANAGED_KEY_SIGNING_TEST_FILES.slice(1)],
        },
      }),
    });
    expect((await verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath: driftedExecutionArgsPath })).errors).toEqual(expect.arrayContaining([
      `managed_key_signing_test_execution_required_args_missing:${DOJO_MANAGED_KEY_SIGNING_TEST_FILES[0]}`,
    ]));

    const tamperedJson = path.join(dir, "tampered-managed-key-signing.vitest.json");
    await writeFile(tamperedJson, JSON.stringify({ success: false, numFailedTests: 1 }), "utf8");
    const expectedManagedKeyJson = managedKeySigningJsonReportFixtureText();
    const tamperedJsonPath = await writeManagedKeySigningEvidenceFixture({
      dir,
      basename: "tampered-managed-key-signing-json",
      evidence: managedKeySigningEvidenceFixture({
        json_report_path: tamperedJson,
        json_report_sha256: sha256(expectedManagedKeyJson),
        json_report_bytes: Buffer.byteLength(expectedManagedKeyJson),
      }),
      writeLogs: false,
    });
    const tamperedJsonResult = await verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath: tamperedJsonPath });
    expect(tamperedJsonResult.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^json_report_sha256_mismatch:/),
      expect.stringMatching(/^json_report_bytes_mismatch:/),
    ]));
  });

  it("verifies public proof verification evidence coverage and public-only custody contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-public-proof-verify-"));
    const evidencePath = await writePublicProofVerificationEvidenceFixture({ dir });

    expect(validateDojoPublicProofVerificationEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoPublicProofVerificationEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_public_proof_verification_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = publicProofVerificationEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["public_proof_verifies_ed25519_public_key"],
      public_proof_verification_contract: {
        ...publicProofVerificationEvidenceFixture().public_proof_verification_contract,
        ed25519_public_key_required: false,
        key_custody_metadata_export_required: false,
        private_secret_exclusion_required: false,
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writePublicProofVerificationEvidenceFixture({
      dir,
      basename: "incomplete-public-proof-verification",
      evidence: incomplete,
    });
    const rejected = await verifyDojoPublicProofVerificationEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "public_proof_not_ok",
      "public_proof_coverage_incomplete",
      "public_proof_missing_capabilities:public_proof_verifies_ed25519_public_key",
      "public_proof_ed25519_requirement_missing",
      "public_proof_key_custody_metadata_export_requirement_missing",
      "public_proof_secret_exclusion_requirement_missing",
      "public_proof_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writePublicProofVerificationEvidenceFixture({
      dir,
      basename: "public-proof-missing-execution",
      evidence: publicProofVerificationEvidenceFixture({
        public_proof_verification_contract: {
          ...publicProofVerificationEvidenceFixture().public_proof_verification_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    expect((await verifyDojoPublicProofVerificationEvidenceArtifact({ evidencePath: missingExecutionPath })).errors).toEqual(expect.arrayContaining([
      "public_proof_self_check_execution_requirement_missing",
      "public_proof_test_execution_missing",
    ]));

    const driftedPath = await writePublicProofVerificationEvidenceFixture({
      dir,
      basename: "drifted-public-proof-verification",
      evidence: publicProofVerificationEvidenceFixture({
        configured_capabilities: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
          .filter((capability) => capability !== "public_proof_verifies_ed25519_public_key"),
        tested_capabilities: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
          .filter((capability) => capability !== "public_proof_verifies_ed25519_public_key"),
        capability_count: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length - 1,
        test_files: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES
          .filter((file) => file !== DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES[0]),
        test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length - 1,
        reported_test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length - 1,
      }),
    });
    expect((await verifyDojoPublicProofVerificationEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "public_proof_required_capabilities_missing:public_proof_verifies_ed25519_public_key",
      "public_proof_required_capabilities_untested:public_proof_verifies_ed25519_public_key",
      `public_proof_required_test_files_missing:${DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES[0]}`,
    ]));
  });

  it("verifies governance lifecycle evidence coverage and control-plane contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-governance-lifecycle-verify-"));
    const evidencePath = await writeGovernanceLifecycleEvidenceFixture({ dir });

    expect(validateDojoGovernanceLifecycleEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoGovernanceLifecycleEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_governance_lifecycle_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = governanceLifecycleEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["governance_revokes_license_to_blocked_scope_with_audit"],
      governance_contract: {
        ...governanceLifecycleEvidenceFixture().governance_contract,
        rbac_required: false,
        store_rbac_required: false,
        license_revocation_required: false,
        compliance_pack_required: false,
        scheduled_jobs_required: false,
        scheduled_job_runner_tool_required: false,
        compliance_archive_manifest_required: false,
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writeGovernanceLifecycleEvidenceFixture({
      dir,
      basename: "incomplete-governance-lifecycle",
      evidence: incomplete,
    });
    const rejected = await verifyDojoGovernanceLifecycleEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "governance_lifecycle_not_ok",
      "governance_lifecycle_coverage_incomplete",
      "governance_lifecycle_missing_capabilities:governance_revokes_license_to_blocked_scope_with_audit",
      "governance_lifecycle_rbac_requirement_missing",
      "governance_lifecycle_store_rbac_requirement_missing",
      "governance_lifecycle_license_revocation_requirement_missing",
      "governance_lifecycle_compliance_pack_requirement_missing",
      "governance_lifecycle_scheduled_jobs_requirement_missing",
      "governance_lifecycle_scheduled_job_runner_tool_requirement_missing",
      "governance_lifecycle_compliance_archive_manifest_requirement_missing",
      "governance_lifecycle_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeGovernanceLifecycleEvidenceFixture({
      dir,
      basename: "governance-lifecycle-missing-execution",
      evidence: governanceLifecycleEvidenceFixture({
        governance_contract: {
          ...governanceLifecycleEvidenceFixture().governance_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoGovernanceLifecycleEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "governance_lifecycle_self_check_execution_requirement_missing",
      "governance_lifecycle_test_execution_missing",
    ]));

    const driftedPath = await writeGovernanceLifecycleEvidenceFixture({
      dir,
      basename: "drifted-governance-lifecycle",
      evidence: governanceLifecycleEvidenceFixture({
        configured_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
          .filter((capability) => capability !== "governance_builds_approval_queue"),
        tested_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
          .filter((capability) => capability !== "governance_builds_approval_queue"),
        capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoGovernanceLifecycleEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "governance_lifecycle_required_capabilities_missing:governance_builds_approval_queue",
      "governance_lifecycle_required_capabilities_untested:governance_builds_approval_queue",
      `governance_lifecycle_required_test_files_missing:${DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies graph runtime evidence coverage and executable runtime contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-graph-runtime-verify-"));
    const evidencePath = await writeGraphRuntimeEvidenceFixture({ dir });

    expect(validateDojoGraphRuntimeEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoGraphRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_graph_runtime_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = graphRuntimeEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["graph_runtime_executes_available_rollback"],
      graph_runtime_contract: {
        ...graphRuntimeEvidenceFixture().graph_runtime_contract,
        rollback_runtime_required: false,
        proof_gate_required: false,
      },
    });
    const incompletePath = await writeGraphRuntimeEvidenceFixture({
      dir,
      basename: "incomplete-graph-runtime",
      evidence: incomplete,
    });
    const rejected = await verifyDojoGraphRuntimeEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "graph_runtime_not_ok",
      "graph_runtime_coverage_incomplete",
      "graph_runtime_missing_capabilities:graph_runtime_executes_available_rollback",
      "graph_runtime_rollback_requirement_missing",
      "graph_runtime_proof_gate_requirement_missing",
    ]));

    const missingExecutionPath = await writeGraphRuntimeEvidenceFixture({
      dir,
      basename: "missing-execution-graph-runtime",
      evidence: graphRuntimeEvidenceFixture({
        graph_runtime_contract: {
          ...graphRuntimeEvidenceFixture().graph_runtime_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoGraphRuntimeEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "graph_runtime_self_check_execution_requirement_missing",
      "graph_runtime_test_execution_missing",
    ]));

    const driftedPath = await writeGraphRuntimeEvidenceFixture({
      dir,
      basename: "drifted-graph-runtime",
      evidence: graphRuntimeEvidenceFixture({
        configured_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "graph_runtime_rejects_self_attested_proof"),
        tested_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "graph_runtime_rejects_self_attested_proof"),
        capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoGraphRuntimeEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "graph_runtime_required_capabilities_missing:graph_runtime_rejects_self_attested_proof",
      "graph_runtime_required_capabilities_untested:graph_runtime_rejects_self_attested_proof",
      `graph_runtime_required_test_files_missing:${DOJO_GRAPH_RUNTIME_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies Ghost Mode evidence coverage and non-mutating shadow contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-ghost-mode-verify-"));
    const evidencePath = await writeGhostModeEvidenceFixture({ dir });

    expect(validateDojoGhostModeEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoGhostModeEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_ghost_mode_evidence_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = ghostModeEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["ghost_mode_runs_without_production_mutation"],
      ghost_mode_contract: {
        ...ghostModeEvidenceFixture().ghost_mode_contract,
        non_mutating_shadow_run_required: false,
        tenant_boundary_required: false,
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writeGhostModeEvidenceFixture({
      dir,
      basename: "incomplete-ghost-mode",
      evidence: incomplete,
    });
    const rejected = await verifyDojoGhostModeEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "ghost_mode_not_ok",
      "ghost_mode_coverage_incomplete",
      "ghost_mode_missing_capabilities:ghost_mode_runs_without_production_mutation",
      "ghost_mode_non_mutating_requirement_missing",
      "ghost_mode_tenant_boundary_requirement_missing",
      "ghost_mode_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeGhostModeEvidenceFixture({
      dir,
      basename: "ghost-mode-missing-execution",
      evidence: ghostModeEvidenceFixture({
        ghost_mode_contract: {
          ...ghostModeEvidenceFixture().ghost_mode_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    expect((await verifyDojoGhostModeEvidenceArtifact({ evidencePath: missingExecutionPath })).errors).toEqual(expect.arrayContaining([
      "ghost_mode_self_check_execution_requirement_missing",
      "ghost_mode_test_execution_missing",
    ]));

    const driftedPath = await writeGhostModeEvidenceFixture({
      dir,
      basename: "drifted-ghost-mode",
      evidence: ghostModeEvidenceFixture({
        configured_capabilities: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
          .filter((capability) => capability !== "postgres_ghost_shadow_rejects_mutating_evidence"),
        tested_capabilities: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
          .filter((capability) => capability !== "postgres_ghost_shadow_rejects_mutating_evidence"),
        capability_count: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoGhostModeEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "ghost_mode_required_capabilities_missing:postgres_ghost_shadow_rejects_mutating_evidence",
      "ghost_mode_required_capabilities_untested:postgres_ghost_shadow_rejects_mutating_evidence",
      `ghost_mode_required_test_files_missing:${DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies Skill Passport evidence coverage and report-only consumer trust contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-skill-passport-verify-"));
    const evidencePath = await writeSkillPassportEvidenceFixture({ dir });

    expect(validateDojoSkillPassportEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoSkillPassportEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_skill_passport_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = skillPassportEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["skill_passport_report_only_status"],
      skill_passport_contract: {
        ...skillPassportEvidenceFixture().skill_passport_contract,
        report_only_status_required: false,
        executable_entrustment_provenance_required: false,
        raw_payload_redaction_required: false,
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writeSkillPassportEvidenceFixture({
      dir,
      basename: "incomplete-skill-passport",
      evidence: incomplete,
    });
    const rejected = await verifyDojoSkillPassportEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "skill_passport_not_ok",
      "skill_passport_coverage_incomplete",
      "skill_passport_missing_capabilities:skill_passport_report_only_status",
      "skill_passport_report_only_requirement_missing",
      "skill_passport_executable_entrustment_requirement_missing",
      "skill_passport_redaction_requirement_missing",
      "skill_passport_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeSkillPassportEvidenceFixture({
      dir,
      basename: "skill-passport-missing-execution",
      evidence: skillPassportEvidenceFixture({
        skill_passport_contract: {
          ...skillPassportEvidenceFixture().skill_passport_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoSkillPassportEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "skill_passport_self_check_execution_requirement_missing",
      "skill_passport_test_execution_missing",
    ]));

    const driftedPath = await writeSkillPassportEvidenceFixture({
      dir,
      basename: "drifted-skill-passport",
      evidence: skillPassportEvidenceFixture({
        configured_capabilities: DOJO_SKILL_PASSPORT_CAPABILITIES
          .filter((capability) => capability !== "skill_passport_report_only_status"),
        tested_capabilities: DOJO_SKILL_PASSPORT_CAPABILITIES
          .filter((capability) => capability !== "skill_passport_report_only_status"),
        capability_count: DOJO_SKILL_PASSPORT_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_SKILL_PASSPORT_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoSkillPassportEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "skill_passport_required_capabilities_missing:skill_passport_report_only_status",
      "skill_passport_required_capabilities_untested:skill_passport_report_only_status",
      `skill_passport_required_test_files_missing:${DOJO_SKILL_PASSPORT_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies Time Machine debugger evidence coverage and honest deterministic debug contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-time-machine-verify-"));
    const evidencePath = await writeTimeMachineDebuggerEvidenceFixture({ dir });

    expect(validateDojoTimeMachineDebuggerEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoTimeMachineDebuggerEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_time_machine_debugger_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = timeMachineDebuggerEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["time_machine_replay_plan"],
      time_machine_contract: {
        ...timeMachineDebuggerEvidenceFixture().time_machine_contract,
        materialized_runtime_branch_required: false,
        replay_plan_required: false,
        honest_projection_status_required: false,
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writeTimeMachineDebuggerEvidenceFixture({
      dir,
      basename: "incomplete-time-machine",
      evidence: incomplete,
    });
    const rejected = await verifyDojoTimeMachineDebuggerEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "time_machine_not_ok",
      "time_machine_coverage_incomplete",
      "time_machine_missing_capabilities:time_machine_replay_plan",
      "time_machine_runtime_branch_requirement_missing",
      "time_machine_replay_plan_requirement_missing",
      "time_machine_honest_status_requirement_missing",
      "time_machine_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeTimeMachineDebuggerEvidenceFixture({
      dir,
      basename: "time-machine-missing-execution",
      evidence: timeMachineDebuggerEvidenceFixture({
        time_machine_contract: {
          ...timeMachineDebuggerEvidenceFixture().time_machine_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    expect((await verifyDojoTimeMachineDebuggerEvidenceArtifact({ evidencePath: missingExecutionPath })).errors).toEqual(expect.arrayContaining([
      "time_machine_self_check_execution_requirement_missing",
      "time_machine_test_execution_missing",
    ]));

    const driftedPath = await writeTimeMachineDebuggerEvidenceFixture({
      dir,
      basename: "drifted-time-machine",
      evidence: timeMachineDebuggerEvidenceFixture({
        configured_capabilities: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
          .filter((capability) => capability !== "time_machine_replay_plan"),
        tested_capabilities: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
          .filter((capability) => capability !== "time_machine_replay_plan"),
        capability_count: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoTimeMachineDebuggerEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "time_machine_required_capabilities_missing:time_machine_replay_plan",
      "time_machine_required_capabilities_untested:time_machine_replay_plan",
      `time_machine_required_test_files_missing:${DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies Vivarium runtime evidence coverage and executable practice contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-vivarium-runtime-verify-"));
    const evidencePath = await writeVivariumRuntimeEvidenceFixture({ dir });

    expect(validateDojoVivariumRuntimeEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoVivariumRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_vivarium_runtime_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = vivariumRuntimeEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["evil_twin_hardening_reduces_attack_success_rate"],
      vivarium_contract: {
        ...vivariumRuntimeEvidenceFixture().vivarium_contract,
        evil_twin_hardening_loop_required: false,
        executable_checkride_required: false,
        ambiguous_document_names_required: false,
        document_tissue_specific_evidence_required: false,
        ui_tissue_mutations_required: false,
        ui_tissue_specific_evidence_required: false,
        misleading_toast_tissue_required: false,
        policy_tissue_required: false,
        expanded_identity_tissue_required: false,
        invalid_value_data_tissue_required: false,
        stale_missing_data_tissue_required: false,
        api_validation_latency_tissue_required: false,
      },
    });
    const incompletePath = await writeVivariumRuntimeEvidenceFixture({
      dir,
      basename: "incomplete-vivarium-runtime",
      evidence: incomplete,
    });
    const rejected = await verifyDojoVivariumRuntimeEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "vivarium_runtime_not_ok",
      "vivarium_runtime_coverage_incomplete",
      "vivarium_runtime_missing_capabilities:evil_twin_hardening_reduces_attack_success_rate",
      "vivarium_runtime_evil_twin_hardening_requirement_missing",
      "vivarium_runtime_checkride_requirement_missing",
      "vivarium_runtime_ambiguous_document_requirement_missing",
      "vivarium_runtime_document_tissue_specific_evidence_requirement_missing",
      "vivarium_runtime_ui_tissue_requirement_missing",
      "vivarium_runtime_ui_tissue_specific_evidence_requirement_missing",
      "vivarium_runtime_misleading_toast_tissue_requirement_missing",
      "vivarium_runtime_policy_tissue_requirement_missing",
      "vivarium_runtime_expanded_identity_tissue_requirement_missing",
      "vivarium_runtime_invalid_value_data_tissue_requirement_missing",
      "vivarium_runtime_stale_missing_data_tissue_requirement_missing",
      "vivarium_runtime_api_validation_latency_tissue_requirement_missing",
    ]));

    const missingExecutionPath = await writeVivariumRuntimeEvidenceFixture({
      dir,
      basename: "missing-execution-vivarium-runtime",
      evidence: vivariumRuntimeEvidenceFixture({
        vivarium_contract: {
          ...vivariumRuntimeEvidenceFixture().vivarium_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoVivariumRuntimeEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "vivarium_runtime_self_check_execution_requirement_missing",
      "vivarium_runtime_test_execution_missing",
    ]));

    const driftedPath = await writeVivariumRuntimeEvidenceFixture({
      dir,
      basename: "drifted-vivarium-runtime",
      evidence: vivariumRuntimeEvidenceFixture({
        configured_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "vivarium_runner_executes_baseline_through_fixtures_graph_oracle"),
        tested_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "vivarium_runner_executes_baseline_through_fixtures_graph_oracle"),
        capability_count: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoVivariumRuntimeEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "vivarium_runtime_required_capabilities_missing:vivarium_runner_executes_baseline_through_fixtures_graph_oracle",
      "vivarium_runtime_required_capabilities_untested:vivarium_runner_executes_baseline_through_fixtures_graph_oracle",
      `vivarium_runtime_required_test_files_missing:${DOJO_VIVARIUM_RUNTIME_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies checkride and license evidence coverage and entrustment contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-checkride-license-verify-"));
    const evidencePath = await writeCheckrideLicenseEvidenceFixture({ dir });

    expect(validateDojoCheckrideLicenseEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoCheckrideLicenseEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_checkride_license_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = checkrideLicenseEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["checkride_blocked_scenario_emits_license_constraint_and_evidence_record"],
      checkride_license: {
        ...checkrideLicenseEvidenceFixture().checkride_license,
        ledger_append_required: false,
        license_constraints_required: false,
        stale_evidence_downgrade_required: false,
      },
    });
    const incompletePath = await writeCheckrideLicenseEvidenceFixture({
      dir,
      basename: "incomplete-checkride-license",
      evidence: incomplete,
    });
    const rejected = await verifyDojoCheckrideLicenseEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "checkride_license_not_ok",
      "checkride_license_coverage_incomplete",
      "checkride_license_missing_capabilities:checkride_blocked_scenario_emits_license_constraint_and_evidence_record",
      "checkride_license_ledger_append_requirement_missing",
      "checkride_license_constraint_requirement_missing",
      "checkride_license_stale_evidence_requirement_missing",
    ]));

    const missingExecutionPath = await writeCheckrideLicenseEvidenceFixture({
      dir,
      basename: "missing-execution-checkride-license",
      evidence: checkrideLicenseEvidenceFixture({
        checkride_license: {
          ...checkrideLicenseEvidenceFixture().checkride_license,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoCheckrideLicenseEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "checkride_license_self_check_execution_requirement_missing",
      "checkride_license_test_execution_missing",
    ]));

    const driftedPath = await writeCheckrideLicenseEvidenceFixture({
      dir,
      basename: "drifted-checkride-license",
      evidence: checkrideLicenseEvidenceFixture({
        configured_capabilities: DOJO_CHECKRIDE_LICENSE_CAPABILITIES
          .filter((capability) => capability !== "checkride_runtime_oracle_blocks_happy_path_only"),
        tested_capabilities: DOJO_CHECKRIDE_LICENSE_CAPABILITIES
          .filter((capability) => capability !== "checkride_runtime_oracle_blocks_happy_path_only"),
        capability_count: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoCheckrideLicenseEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "checkride_license_required_capabilities_missing:checkride_runtime_oracle_blocks_happy_path_only",
      "checkride_license_required_capabilities_untested:checkride_runtime_oracle_blocks_happy_path_only",
      `checkride_license_required_test_files_missing:${DOJO_CHECKRIDE_LICENSE_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies case-law runtime evidence coverage and antibody transfer contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-case-law-runtime-verify-"));
    const evidencePath = await writeCaseLawRuntimeEvidenceFixture({ dir });

    expect(validateDojoCaseLawRuntimeEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoCaseLawRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_case_law_runtime_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = caseLawRuntimeEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["antibody_matcher_proposes_without_binding"],
      case_law_contract: {
        ...caseLawRuntimeEvidenceFixture().case_law_contract,
        antibody_matching_required: false,
        antibody_private_data_redaction_required: false,
      },
    });
    const incompletePath = await writeCaseLawRuntimeEvidenceFixture({
      dir,
      basename: "incomplete-case-law-runtime",
      evidence: incomplete,
    });
    const rejected = await verifyDojoCaseLawRuntimeEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "case_law_runtime_not_ok",
      "case_law_runtime_coverage_incomplete",
      "case_law_runtime_missing_capabilities:antibody_matcher_proposes_without_binding",
      "case_law_runtime_antibody_matching_requirement_missing",
      "case_law_runtime_antibody_private_data_requirement_missing",
    ]));

    const missingExecutionPath = await writeCaseLawRuntimeEvidenceFixture({
      dir,
      basename: "missing-execution-case-law-runtime",
      evidence: caseLawRuntimeEvidenceFixture({
        case_law_contract: {
          ...caseLawRuntimeEvidenceFixture().case_law_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    const missingExecution = await verifyDojoCaseLawRuntimeEvidenceArtifact({ evidencePath: missingExecutionPath });
    expect(missingExecution.ok).toBe(false);
    expect(missingExecution.errors).toEqual(expect.arrayContaining([
      "case_law_runtime_self_check_execution_requirement_missing",
      "case_law_runtime_test_execution_missing",
    ]));

    const driftedPath = await writeCaseLawRuntimeEvidenceFixture({
      dir,
      basename: "drifted-case-law-runtime",
      evidence: caseLawRuntimeEvidenceFixture({
        configured_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "refusal_explainer_cites_case_law_evidence_next_step"),
        tested_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES
          .filter((capability) => capability !== "refusal_explainer_cites_case_law_evidence_next_step"),
        capability_count: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoCaseLawRuntimeEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "case_law_runtime_required_capabilities_missing:refusal_explainer_cites_case_law_evidence_next_step",
      "case_law_runtime_required_capabilities_untested:refusal_explainer_cites_case_law_evidence_next_step",
      `case_law_runtime_required_test_files_missing:${DOJO_CASE_LAW_RUNTIME_TEST_FILES.join(",")}`,
    ]));
  });

  it("verifies hosted runtime gateway evidence coverage and custody contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-hosted-runtime-gateway-verify-"));
    const evidencePath = await writeHostedRuntimeGatewayEvidenceFixture({ dir });

    expect(validateDojoHostedRuntimeGatewayEvidenceForRelease(await readJson(evidencePath))).toEqual({
      ok: true,
      errors: [],
    });
    expect(await verifyDojoHostedRuntimeGatewayEvidenceArtifact({
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      id: "dojo_hosted_runtime_gateway_self_check",
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    const incomplete = hostedRuntimeGatewayEvidenceFixture({
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["hosted_runtime_blocks_expired_and_revoked_sessions"],
      hosted_runtime_contract: {
        ...hostedRuntimeGatewayEvidenceFixture().hosted_runtime_contract,
        revocation_and_expiry_required: false,
        evidence_write_required: false,
        durable_postgres_session_gate_required: false,
        durable_postgres_session_gate_id: "wrong_gate",
        self_check_executes_tests_required: false,
      },
    });
    const incompletePath = await writeHostedRuntimeGatewayEvidenceFixture({
      dir,
      basename: "incomplete-hosted-runtime-gateway",
      evidence: incomplete,
    });
    const rejected = await verifyDojoHostedRuntimeGatewayEvidenceArtifact({ evidencePath: incompletePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "hosted_runtime_gateway_not_ok",
      "hosted_runtime_gateway_coverage_incomplete",
      "hosted_runtime_gateway_missing_capabilities:hosted_runtime_blocks_expired_and_revoked_sessions",
      "hosted_runtime_gateway_revocation_expiry_requirement_missing",
      "hosted_runtime_gateway_evidence_requirement_missing",
      "hosted_runtime_gateway_durable_postgres_gate_requirement_missing",
      "hosted_runtime_gateway_durable_postgres_gate_id_missing",
      "hosted_runtime_gateway_self_check_execution_requirement_missing",
    ]));

    const missingExecutionPath = await writeHostedRuntimeGatewayEvidenceFixture({
      dir,
      basename: "hosted-runtime-gateway-missing-execution",
      evidence: hostedRuntimeGatewayEvidenceFixture({
        hosted_runtime_contract: {
          ...hostedRuntimeGatewayEvidenceFixture().hosted_runtime_contract,
          self_check_executes_tests_required: false,
        },
        test_execution: null,
      }),
    });
    expect((await verifyDojoHostedRuntimeGatewayEvidenceArtifact({ evidencePath: missingExecutionPath })).errors).toEqual(expect.arrayContaining([
      "hosted_runtime_gateway_self_check_execution_requirement_missing",
      "hosted_runtime_gateway_test_execution_missing",
    ]));

    const driftedPath = await writeHostedRuntimeGatewayEvidenceFixture({
      dir,
      basename: "drifted-hosted-runtime-gateway",
      evidence: hostedRuntimeGatewayEvidenceFixture({
        configured_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
          .filter((capability) => capability !== "hosted_runtime_requires_skill_and_run_binding"),
        tested_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
          .filter((capability) => capability !== "hosted_runtime_requires_skill_and_run_binding"),
        capability_count: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length - 1,
        configured_capability_count: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length - 1,
        test_files: [],
        test_file_count: 0,
        reported_test_file_count: 0,
      }),
    });
    expect((await verifyDojoHostedRuntimeGatewayEvidenceArtifact({ evidencePath: driftedPath })).errors).toEqual(expect.arrayContaining([
      "hosted_runtime_gateway_required_capabilities_missing:hosted_runtime_requires_skill_and_run_binding",
      "hosted_runtime_gateway_required_capabilities_untested:hosted_runtime_requires_skill_and_run_binding",
      `hosted_runtime_gateway_required_test_files_missing:${DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.join(",")}`,
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

    expect(validateDojoChaosPerformanceEvidenceForEnterprise(chaosEvidenceFixture({
      chaos_runner_required: false,
      chaos_runner: null,
    })).errors).toEqual(expect.arrayContaining([
      "chaos_runner_requirement_missing",
      "chaos_runner_missing",
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
    const { reportPath } = await writeVisualReportFixture({
      dir,
      basename: "full-visual-proof",
      schemaVersion: "synthi.dojo.visualProof.v1",
    });

    expect(await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: DOJO_FULL_VISUAL_ROUTE_IDS.length * DOJO_FULL_VISUAL_VIEWPORTS.length,
    }));

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const expectedScreenshotBytes = Number(report.results[0].bytes);
    await writeFile(reportPath, JSON.stringify({
      ...report,
      results: [
        {
          ...report.results[0],
          bytes: expectedScreenshotBytes + 1,
        },
        ...report.results.slice(1),
      ],
    }, null, 2), "utf8");
    const rejected = await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      `visual_result_screenshot_bytes_mismatch:dojo-shell:${expectedScreenshotBytes + 1}:${expectedScreenshotBytes}`,
    ]));

    await writeFile(reportPath, JSON.stringify({
      ...report,
      results: [
        {
          ...report.results[0],
          screenshot_sha256: sha256("different-screenshot"),
        },
        ...report.results.slice(1),
      ],
    }, null, 2), "utf8");
    const digestRejected = await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    });
    expect(digestRejected.ok).toBe(false);
    expect(digestRejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^visual_result_screenshot_sha256_mismatch:dojo-shell:/),
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

async function writeReleaseGateRunnerFixture({
  dir,
  basename = "dojo-release-gate-runner",
  manifest,
  packageScripts,
  gateId = "mcp_typecheck",
  dryRun = false,
  writeExpectedArtifacts = false,
}) {
  const plan = buildDojoReleaseGateExecutionPlan({
    manifest,
    scope: "minimal-pr",
    gateIds: [gateId],
    env: {},
  });
  const gatePlan = plan.gates[0];
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  const logsDir = path.join(dir, `${basename}-logs`);
  await mkdir(logsDir, { recursive: true });
  const stdout = "typecheck ok\n";
  const stderr = "";
  const stdoutPath = path.join(logsDir, `${gateId}.stdout.log`);
  const stderrPath = path.join(logsDir, `${gateId}.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const producedArtifacts = [];
  if (writeExpectedArtifacts) {
    for (const [kind, artifactPath] of [
      ["report", gatePlan.expected_artifacts.report_path],
      ["evidence", gatePlan.expected_artifacts.evidence_path],
      ["events", gatePlan.expected_artifacts.events_path],
    ]) {
      if (!artifactPath) continue;
      const artifactBody = JSON.stringify({
        ok: true,
        kind,
        gate_id: gateId,
        generated_at: "2026-06-11T00:00:00.000Z",
      });
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifactBody, "utf8");
      producedArtifacts.push({
        kind,
        path: artifactPath,
        exists: true,
        required: true,
        bytes: Buffer.byteLength(artifactBody),
        sha256: sha256(artifactBody),
      });
    }
  }
  const results = dryRun
    ? [{
      gate_id: gateId,
      tier: gatePlan.tier,
      status: "planned",
      executed: false,
      command: gatePlan.execution_spec.canonical_command,
      expected_artifacts: gatePlan.expected_artifacts,
      requires_env: gatePlan.requires_env,
      missing_env: gatePlan.missing_env,
    }]
    : [{
      schema_version: "synthi.dojo.releaseGateCommandLog.v1",
      gate_id: gateId,
      tier: gatePlan.tier,
      status: "passed",
      executed: true,
      started_at: "2026-06-11T00:00:00.000Z",
      duration_ms: 12,
      command: gatePlan.execution_spec.canonical_command,
      exit_code: 0,
      signal: null,
      timed_out: false,
      failure_reason: null,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      expected_artifacts: gatePlan.expected_artifacts,
      produced_artifacts: producedArtifacts,
      missing_expected_artifacts: [],
    }];
  const report = buildDojoReleaseGateRunReport({
    manifest,
    manifestValidation: validation,
    plan,
    results,
    scope: "minimal-pr",
    dryRun,
    generatedAt: "2026-06-11T00:00:00.000Z",
  });
  const reportPath = path.join(dir, `${basename}.json`);
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, serializedReport, "utf8");
  const evidence = buildDojoReleaseGateRunEvidenceManifest({
    report,
    reportPath,
    serialized: serializedReport,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  return {
    reportPath,
    evidencePath,
    stdoutPath,
    stderrPath,
    report,
    evidence,
  };
}

async function writeReleaseGateVerifierFixture({
  dir,
  basename = "dojo-release-gate-verifier-self-check",
  verifiedSections = [
    { id: "release_gate_manifest", ok: true, errors: [] },
    { id: "dojo_release_gate_runner_self_check", ok: true, errors: [] },
  ],
  rejectedControls = [
    { id: "rejected_dojo_self_check", ok: false, errors: ["dojo_self_check_production_proof_not_consumed"] },
  ],
} = {}) {
  const report = {
    schema_version: "synthi.dojo.releaseGateVerifierSelfCheck.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    verified_sections: verifiedSections,
    rejected_controls: rejectedControls,
  };
  const reportPath = path.join(dir, `${basename}.json`);
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, serializedReport, "utf8");
  const evidence = buildDojoReleaseGateVerifierSelfCheckEvidenceManifest({
    report,
    reportPath,
    serialized: serializedReport,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    reportPath,
    evidencePath,
    report,
    evidence,
  };
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
  const { routeIds, viewports } = visualFixtureMatrixForSchema(schemaVersion);
  const results = [];
  for (const routeId of routeIds) {
    for (const viewport of viewports) {
      const screenshotPath = path.join(dir, `${basename}-${routeId}-${viewport}.png`);
      const imageBytes = Buffer.from(`${basename}:${routeId}:${viewport}:visual-proof-fixture`);
      await writeFile(screenshotPath, imageBytes);
      results.push(buildVisualReportResult({
        routeId,
        viewport,
        screenshotPath,
        bytes: imageBytes.length,
        screenshotSha256: sha256(imageBytes),
      }));
    }
  }
  const reportPath = path.join(dir, `${basename}.json`);
  await writeFile(reportPath, JSON.stringify({
    schema_version: schemaVersion,
    ok: true,
    route_id: routeIds.length === 1 ? routeIds[0] : undefined,
    route_count: routeIds.length,
    screenshot_count: results.length,
    screenshots: results.map((result) => result.screenshot_path),
    results,
  }, null, 2), "utf8");
  return {
    screenshotPath: results[0]?.screenshot_path,
    reportPath,
  };
}

function visualFixtureMatrixForSchema(schemaVersion) {
  if (schemaVersion === "synthi.dojo.visualProof.v1") {
    return {
      routeIds: DOJO_FULL_VISUAL_ROUTE_IDS,
      viewports: DOJO_FULL_VISUAL_VIEWPORTS,
    };
  }
  if (schemaVersion === "synthi.dojo.ghostModeVisualProof.v1") {
    return {
      routeIds: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS,
      viewports: DOJO_GHOST_MODE_VISUAL_VIEWPORTS,
    };
  }
  return {
    routeIds: ["visual-proof"],
    viewports: ["desktop"],
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
    production_proof_capsule_id: "capsule-fixture",
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
  const screenshotPath = path.join(dir, `${basename}.png`);
  const screenshotBytes = fixtureVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const body = withWorkflowE2EVisualMetadata(report, { screenshotPath, screenshotBytes });
  const reportPath = path.join(dir, `${basename}.json`);
  await writeFile(reportPath, JSON.stringify(body, null, 2), "utf8");
  return { report: body, reportPath };
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

function withWorkflowE2EVisualMetadata(report, { screenshotPath, screenshotBytes }) {
  return {
    ...report,
    visual_artifact_count: 1,
    visual_artifacts: [
      {
        case_id: "fixture-case",
        stage: "fixture_visual",
        source: "unit_fixture",
        path: screenshotPath,
        bytes: screenshotBytes.length,
        screenshot_sha256: sha256(screenshotBytes),
        mime_type: "image/png",
        png_verified: true,
      },
    ],
  };
}

async function writePrivateToolStdioAcceptanceFixture({
  dir,
  basename = "private-tool-stdio",
  transcript,
}) {
  const screenshotPath = path.join(dir, `${basename}.png`);
  const screenshotBytes = fixtureVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const body = withPrivateToolVisualMetadata(
    transcript ?? privateToolStdioAcceptanceFixture({ screenshotPath }),
    { screenshotPath, screenshotBytes }
  );
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
  const screenshotBytes = Number(overrides.screenshotBytes);
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
        screenshot_bytes: Number.isFinite(screenshotBytes) ? screenshotBytes : undefined,
        screenshot_sha256: overrides.screenshotSha256,
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
  const screenshotBytes = fixtureVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const body = withPrivateToolVisualMetadata(
    transcript ?? privateToolCodexAcceptanceFixture({ screenshotPath }),
    { screenshotPath, screenshotBytes }
  );
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
  const screenshotBytes = Number(overrides.screenshotBytes);
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
        screenshot_bytes: Number.isFinite(screenshotBytes) ? screenshotBytes : undefined,
        screenshot_sha256: overrides.screenshotSha256,
        url: "https://workspace.example.test/private-tool",
        match: true,
        expected_text: "Details opened",
      },
    ],
  });
  return { ...base, ...withoutFixtureOnlyOverrides(overrides) };
}

function withPrivateToolVisualMetadata(transcript, { screenshotPath, screenshotBytes }) {
  const digest = sha256(screenshotBytes);
  return {
    ...transcript,
    steps: (Array.isArray(transcript.steps) ? transcript.steps : []).map((step) => {
      if (step?.name !== "visual proof snapshot") return step;
      return {
        ...step,
        screenshot_path: step.screenshot_path || screenshotPath,
        screenshot_bytes: screenshotBytes.length,
        screenshot_sha256: digest,
      };
    }),
  };
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
  delete cleaned.screenshotBytes;
  delete cleaned.screenshotSha256;
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

async function writeEvidenceAuthorityEvidenceFixture({
  dir,
  basename = "dojo-evidence-authority",
  evidence,
  writeLogs = true,
}) {
  const stdout = "evidence authority suite passed\n";
  const stderr = "";
  const jsonReport = evidenceAuthorityJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? evidenceAuthorityEvidenceFixture({
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

function evidenceAuthorityEvidenceFixture(overrides = {}) {
  const stdout = "evidence authority suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
    tested_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
    capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    configured_capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    capability_coverage_complete: true,
    missing_capabilities: [],
    evidence_authority: {
      canonical_record_hash_required: true,
      record_signature_verification_required: true,
      tamper_detection_required: true,
      claim_freshness_required: true,
      claim_scope_required: true,
      claim_kind_required: true,
      ledger_resolver_fail_closed_required: true,
      redaction_manifest_required: true,
      redacted_export_required: true,
      evidence_retention_policy_required: true,
      legal_hold_blocks_disposal_required: true,
      external_storage_custody_receipts_required: true,
      proof_issue_claim_verification_required: true,
      proof_validation_rejects_self_attested_claims_required: true,
      durable_postgres_ledger_gate_required: true,
      durable_postgres_ledger_gate_id: "dojo_postgres_control_plane_self_check",
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_EVIDENCE_AUTHORITY_TEST_FILES],
    budget_evaluation: { ok: true },
    test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    reported_test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    test_summary: {
      total_tests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
      passed_tests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_EVIDENCE_AUTHORITY_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function evidenceAuthorityJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    numPassedTests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    numPassedTestSuites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [],
  }, null, 2);
}

async function writeImplementationStatusEvidenceFixture({
  dir,
  basename = "dojo-implementation-status",
  evidence,
  writeLogs = true,
}) {
  const stdout = "implementation status suite passed\n";
  const stderr = "";
  const jsonReport = implementationStatusJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? implementationStatusEvidenceFixture({
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

function implementationStatusEvidenceFixture(overrides = {}) {
  const stdout = "implementation status suite passed\n";
  const stderr = "";
  return {
    schema_version: "synthi.dojo.implementationStatusEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
    tested_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
    capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    configured_capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    capability_coverage_complete: true,
    missing_capabilities: [],
    implementation_status_contract: {
      stable_vocabulary_required: true,
      every_tool_classified_required: true,
      machine_manifest_sync_required: true,
      unknown_tool_fails_planned_required: true,
      production_runtime_claim_boundary_required: true,
      runtime_scope_required_for_executable_required: true,
      report_surface_no_overclaim_required: true,
      proof_dispatch_hosted_runtime_boundary_required: true,
      ghost_mode_non_mutating_boundary_required: true,
      control_plane_write_boundary_required: true,
      immutable_metadata_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_IMPLEMENTATION_STATUS_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_IMPLEMENTATION_STATUS_TEST_FILES],
    budget_evaluation: { ok: true },
    test_file_count: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
    reported_test_file_count: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
    test_summary: {
      total_tests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
      passed_tests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
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

function implementationStatusJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    numPassedTests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
    numPassedTestSuites: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
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

async function writeAffordanceCodemodFixture({
  dir,
  basename = "dojo-affordance-codemod-self-check",
  report = affordanceCodemodReportFixture(),
}) {
  const reportPath = path.join(dir, `${basename}.json`);
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const serialized = JSON.stringify(report, null, 2);
  const evidence = affordanceCodemodEvidenceFixture({ report, reportPath, serialized });
  await writeFile(reportPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  return {
    report: { ...report, evidence },
    reportPath,
    evidencePath,
  };
}

async function writeApiToolCompilerEvidenceFixture({
  dir,
  basename = "dojo-api-tool-compiler",
  evidence,
  writeLogs = true,
}) {
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const stdoutPath = path.join(dir, `${basename}.stdout.txt`);
  const stderrPath = path.join(dir, `${basename}.stderr.txt`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const stdout = "api tool compiler suite passed\n";
  const stderr = "";
  const jsonReport = apiToolCompilerJsonReportFixtureText();
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? apiToolCompilerEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function apiToolCompilerEvidenceFixture(overrides = {}) {
  const stdout = "api tool compiler suite passed\n";
  const stderr = "";
  const jsonReport = apiToolCompilerJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    test_files: [...DOJO_API_TOOL_COMPILER_TEST_FILES],
    configured_capabilities: [...DOJO_API_TOOL_COMPILER_CAPABILITIES],
    tested_capabilities: [...DOJO_API_TOOL_COMPILER_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    configured_capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    capability_coverage_complete: true,
    promotion_contract: {
      reviewed_candidate_required: true,
      proof_capsule_required: true,
      license_kernel_required: true,
      idempotency_required: true,
      auth_scope_required: true,
      strict_input_schema_required: true,
      postcondition_required: true,
      evidence_write_required: true,
      graph_proof_match_required: true,
      production_candidate_only_execution_allowed: false,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_API_TOOL_COMPILER_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length,
    configured_test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length,
    reported_test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
      passed_tests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: path.join(tmpdir(), "dojo-api-tool-compiler.stdout.txt"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: path.join(tmpdir(), "dojo-api-tool-compiler.stderr.txt"),
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: path.join(tmpdir(), "dojo-api-tool-compiler.vitest.json"),
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function apiToolCompilerJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    numPassedTests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeGeneratedPrEvidenceFixture({
  dir,
  basename = "dojo-generated-pr",
  evidence,
  writeLogs = true,
}) {
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const stdoutPath = path.join(dir, `${basename}.stdout.txt`);
  const stderrPath = path.join(dir, `${basename}.stderr.txt`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const stdout = "generated PR suite passed\n";
  const stderr = "";
  const jsonReport = generatedPrJsonReportFixtureText();
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? generatedPrEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function generatedPrEvidenceFixture(overrides = {}) {
  const stdout = "generated PR suite passed\n";
  const stderr = "";
  const jsonReport = generatedPrJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.generatedPrEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_GENERATED_PR_CAPABILITIES],
    tested_capabilities: [...DOJO_GENERATED_PR_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_GENERATED_PR_CAPABILITIES.length,
    configured_capability_count: DOJO_GENERATED_PR_CAPABILITIES.length,
    capability_coverage_complete: true,
    generated_pr_contract: {
      reviewable_metadata_required: true,
      caller_supplied_code_owner_rules_required: true,
      proof_impact_required: true,
      code_owner_glob_matching_required: true,
      unsafe_branch_rejection_required: true,
      branch_plan_required: true,
      promotion_blocker_required: true,
      source_patch_bundle_required: true,
      missing_source_rejection_required: true,
      generated_contract_tests_required: true,
      patch_writer_required: true,
      path_traversal_rejection_required: true,
      duplicate_output_rejection_required: true,
      dry_run_required: true,
      stale_source_rejection_required: true,
      idempotent_write_required: true,
      branch_applier_required: true,
      file_hash_verification_required: true,
      unresolved_blocker_rejection_required: true,
      git_branch_creation_required: true,
      dirty_worktree_rejection_required: true,
      existing_branch_rejection_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_GENERATED_PR_TEST_FILES],
    test_file_count: DOJO_GENERATED_PR_TEST_FILES.length,
    reported_test_file_count: DOJO_GENERATED_PR_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_GENERATED_PR_CAPABILITIES.length,
      passed_tests: DOJO_GENERATED_PR_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: path.join(tmpdir(), "dojo-generated-pr.stdout.txt"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: path.join(tmpdir(), "dojo-generated-pr.stderr.txt"),
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: path.join(tmpdir(), "dojo-generated-pr.vitest.json"),
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GENERATED_PR_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function generatedPrJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_GENERATED_PR_CAPABILITIES.length,
    numPassedTests: DOJO_GENERATED_PR_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeMcpSkillBusEvidenceFixture({
  dir,
  basename = "dojo-mcp-skill-bus",
  evidence,
  writeLogs = true,
}) {
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const stdoutPath = path.join(dir, `${basename}.stdout.txt`);
  const stderrPath = path.join(dir, `${basename}.stderr.txt`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const stdout = "MCP Skill Bus suite passed\n";
  const stderr = "";
  const jsonReport = mcpSkillBusJsonReportFixtureText();
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? mcpSkillBusEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function mcpSkillBusEvidenceFixture(overrides = {}) {
  const stdout = "MCP Skill Bus suite passed\n";
  const stderr = "";
  const jsonReport = mcpSkillBusJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_MCP_SKILL_BUS_CAPABILITIES],
    tested_capabilities: [...DOJO_MCP_SKILL_BUS_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    configured_capability_count: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    capability_coverage_complete: true,
    mcp_skill_bus_contract: {
      certified_competency_listing_required: true,
      tenant_authorization_required: true,
      signed_manifest_required: true,
      manifest_signature_verification_required: true,
      manifest_tamper_rejection_required: true,
      manifest_production_readiness_required: true,
      version_pinning_required: true,
      api_backed_tool_resolution_required: true,
      api_backed_canonical_dispatch_context_required: true,
      ambiguous_tool_block_required: true,
      proof_validation_required: true,
      proof_consume_required: true,
      proof_binding_required: true,
      dry_run_side_effect_free_required: true,
      fail_closed_required: true,
      executor_block_propagation_required: true,
      rate_limit_required: true,
      audit_events_required: true,
      durable_registration_required: true,
      revocation_required: true,
      durable_invocation_custody_required: true,
      tenant_boundary_required: true,
      direct_call_policy_required: true,
      postgres_registry_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_MCP_SKILL_BUS_TEST_FILES],
    test_file_count: DOJO_MCP_SKILL_BUS_TEST_FILES.length,
    reported_test_file_count: DOJO_MCP_SKILL_BUS_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
      passed_tests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: path.join(tmpdir(), "dojo-mcp-skill-bus.stdout.txt"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: path.join(tmpdir(), "dojo-mcp-skill-bus.stderr.txt"),
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: path.join(tmpdir(), "dojo-mcp-skill-bus.vitest.json"),
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_MCP_SKILL_BUS_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function mcpSkillBusJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    numPassedTests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeSourceDriftEvidenceFixture({
  dir,
  basename = "dojo-source-drift",
  evidence,
  writeLogs = true,
}) {
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const stdoutPath = path.join(dir, `${basename}.stdout.txt`);
  const stderrPath = path.join(dir, `${basename}.stderr.txt`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const stdout = "source drift suite passed\n";
  const stderr = "";
  const jsonReport = sourceDriftJsonReportFixtureText();
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? sourceDriftEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function sourceDriftEvidenceFixture(overrides = {}) {
  const stdout = "source drift suite passed\n";
  const stderr = "";
  const jsonReport = sourceDriftJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.sourceDriftEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_SOURCE_DRIFT_CAPABILITIES],
    tested_capabilities: [...DOJO_SOURCE_DRIFT_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    configured_capability_count: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    capability_coverage_complete: true,
    source_drift_contract: {
      release_scoped_snapshot_required: true,
      signed_snapshot_verification_required: true,
      source_content_hash_required: true,
      changed_token_expiry_required: true,
      removed_token_expiry_required: true,
      added_risky_affordance_review_required: true,
      unrelated_token_no_expiry_required: true,
      tamper_rejection_required: true,
      license_store_expiry_application_required: true,
      recertification_handoff_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_SOURCE_DRIFT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_SOURCE_DRIFT_TEST_FILES],
    test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length,
    reported_test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
      passed_tests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: path.join(tmpdir(), "dojo-source-drift.stdout.txt"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: path.join(tmpdir(), "dojo-source-drift.stderr.txt"),
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: path.join(tmpdir(), "dojo-source-drift.vitest.json"),
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function sourceDriftJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    numPassedTests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeAgentReadyUiContractEvidenceFixture({
  dir,
  basename = "dojo-agent-ready-ui-contract",
  evidence,
  writeLogs = true,
}) {
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  const stdoutPath = path.join(dir, `${basename}.stdout.txt`);
  const stderrPath = path.join(dir, `${basename}.stderr.txt`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const stdout = "agent-ready ui contract suite passed\n";
  const stderr = "";
  const jsonReport = agentReadyUiContractJsonReportFixtureText();
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? agentReadyUiContractEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function agentReadyUiContractEvidenceFixture(overrides = {}) {
  const stdout = "agent-ready ui contract suite passed\n";
  const stderr = "";
  const jsonReport = agentReadyUiContractJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES],
    tested_capabilities: [...DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    configured_capability_count: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    capability_coverage_complete: true,
    agent_ready_ui_contract: {
      schema_linter_required: true,
      stable_locator_required: true,
      success_hook_required: true,
      proof_hook_required: true,
      proof_required_for_risky_action_required: true,
      accessibility_label_required: true,
      blocked_contexts_required: true,
      runtime_enum_validation_required: true,
      malformed_array_safety_required: true,
      proof_risk_mismatch_warning_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES],
    test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length,
    reported_test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
      passed_tests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: path.join(tmpdir(), "dojo-agent-ready-ui-contract.stdout.txt"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: path.join(tmpdir(), "dojo-agent-ready-ui-contract.stderr.txt"),
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: path.join(tmpdir(), "dojo-agent-ready-ui-contract.vitest.json"),
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function agentReadyUiContractJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    numPassedTests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

function affordanceCodemodReportFixture(overrides = {}) {
  const sourceFile = "src/InvoiceForm.jsx";
  const testFile = "src/__tests__/InvoiceForm.dojo-affordance.test.ts";
  const operationIds = ["patch_stable_locator_invoice_save", "patch_proof_hook_invoice_save"];
  const fileRefs = [
    { kind: "source", path: sourceFile },
    { kind: "contract_test", path: testFile },
  ];
  return {
    schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    operation_ids: operationIds,
    generated_test_path: testFile,
    patched_source_path: sourceFile,
    before_contract: { ok: false },
    wrong_target_contract: { ok: false },
    after_contract: { ok: true },
    source_patch_bundle: {
      ok: true,
      modified_files: [{ path: sourceFile, applied_operations: operationIds }],
      generated_tests: [{ path: testFile }],
    },
    generated_pr_metadata: {
      review_requirements: [
        { gate: "code_owner", required: true },
        { gate: "security_for_risky_action", required: true },
      ],
    },
    generated_pr_branch_plan: {
      ready_to_apply: true,
      file_writes: fileRefs,
    },
    generated_pr_stale_apply_result: {
      ok: false,
      issues: [{ issue_id: "source_patch_writer:source_patch_stale_source" }],
      applied_files: [],
    },
    generated_pr_branch_apply_result: {
      ok: true,
      applied_files: fileRefs,
    },
    generated_pr_git_branch_result: {
      ok: true,
      commands: [
        { command: "git", args: ["switch", "--create", "dojo/source-affordance/self-check"] },
        { command: "git", args: ["status", "--short"] },
      ],
      applied_files: fileRefs,
    },
    source_patch_write_result: {
      ok: true,
      written_files: fileRefs,
    },
    before_vitest: { ok: false },
    wrong_target_vitest: { ok: false },
    after_vitest: { ok: true },
    git_branch_vitest: { ok: true },
    target_matchers: [
      {
        operation_id: operationIds[0],
        target_component: "InvoiceForm",
        target_match: { role: "button", text: "Save invoice" },
      },
    ],
    ...overrides,
  };
}

function affordanceCodemodEvidenceFixture({ report, reportPath, serialized }) {
  return {
    schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    report_path: reportPath,
    report_sha256: sha256(serialized),
    report_bytes: Buffer.byteLength(serialized),
    before_failed: report.before_contract?.ok === false && report.before_vitest?.ok === false,
    target_aware_contract: report.wrong_target_contract?.ok === false && report.wrong_target_vitest?.ok === false,
    after_passed: report.after_contract?.ok === true && report.after_vitest?.ok === true,
    patch_bundle_ok: report.source_patch_bundle?.ok === true,
    patch_bundle_modified_file_count: report.source_patch_bundle?.modified_files?.length || 0,
    patch_bundle_generated_test_count: report.source_patch_bundle?.generated_tests?.length || 0,
    patch_write_ok: report.source_patch_write_result?.ok === true,
    patch_write_file_count: report.source_patch_write_result?.written_files?.length || 0,
    generated_pr_branch_plan_ready: report.generated_pr_branch_plan?.ready_to_apply === true,
    generated_pr_branch_plan_file_count: report.generated_pr_branch_plan?.file_writes?.length || 0,
    generated_pr_stale_apply_rejected: report.generated_pr_stale_apply_result?.ok === false
      && Array.isArray(report.generated_pr_stale_apply_result?.issues)
      && report.generated_pr_stale_apply_result.issues.some((issue) => issue.issue_id === "source_patch_writer:source_patch_stale_source"),
    generated_pr_branch_apply_ok: report.generated_pr_branch_apply_result?.ok === true,
    generated_pr_branch_apply_file_count: report.generated_pr_branch_apply_result?.applied_files?.length || 0,
    generated_pr_git_branch_ok: report.generated_pr_git_branch_result?.ok === true,
    generated_pr_git_branch_command_count: report.generated_pr_git_branch_result?.commands?.length || 0,
    generated_pr_git_branch_applied_file_count: report.generated_pr_git_branch_result?.applied_files?.length || 0,
    git_branch_generated_test_passed: report.git_branch_vitest?.ok === true,
    generated_pr_review_gate_count: report.generated_pr_metadata?.review_requirements?.length || 0,
    operation_ids: report.operation_ids,
    generated_test_path: report.generated_test_path,
    patched_source_path: report.patched_source_path,
    target_matchers: report.target_matchers,
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

async function writeManagedKeySigningEvidenceFixture({
  dir,
  basename = "dojo-managed-key-signing",
  evidence,
  writeLogs = true,
}) {
  const stdout = "managed key signing suite passed\n";
  const stderr = "";
  const jsonReport = managedKeySigningJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? managedKeySigningEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function managedKeySigningEvidenceFixture(overrides = {}) {
  const stdout = "managed key signing suite passed\n";
  const stderr = "";
  const jsonReport = managedKeySigningJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
    tested_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
    capability_count: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    configured_capability_count: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    capability_coverage_complete: true,
    missing_capabilities: [],
    signing_contract: {
      provider: "managed-key-service",
      algorithm: "ed25519",
      request_schema_version: "synthi.dojo.managedKeySignerRequest.v1",
      response_schema_version: "synthi.dojo.managedKeySignerResponse.v1",
      key_custody: "managed",
      required_request_fields: ["schema_version", "algorithm", "key_id", "key_uri", "payload"],
      required_response_fields: ["schema_version", "algorithm", "key_id", "key_uri", "key_custody", "signature"],
      production_private_key_material_allowed: false,
      public_verifier_material_required: true,
    },
    test_files: [...DOJO_MANAGED_KEY_SIGNING_TEST_FILES],
    test_file_count: DOJO_MANAGED_KEY_SIGNING_TEST_FILES.length,
    reported_test_file_count: DOJO_MANAGED_KEY_SIGNING_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
      passed_tests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_MANAGED_KEY_SIGNING_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 1000,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-managed-key-signing.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-managed-key-signing.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-managed-key-signing.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function managedKeySigningJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    numPassedTests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writePublicProofVerificationEvidenceFixture({
  dir,
  basename = "dojo-public-proof-verification",
  evidence,
  writeLogs = true,
}) {
  const stdout = "public proof verification suite passed\n";
  const stderr = "";
  const jsonReport = publicProofVerificationJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? publicProofVerificationEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function publicProofVerificationEvidenceFixture(overrides = {}) {
  const stdout = "public proof verification suite passed\n";
  const stderr = "";
  const jsonReport = publicProofVerificationJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES],
    tested_capabilities: [...DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    configured_capability_count: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    capability_coverage_complete: true,
    public_proof_verification_contract: {
      external_verifier_required: true,
      ed25519_public_key_required: true,
      evidence_claim_ledger_binding_required: true,
      tamper_and_context_blocks_required: true,
      timestamp_window_required: true,
      proof_key_custody_policy_required: true,
      public_export_required: true,
      key_custody_metadata_export_required: true,
      private_secret_exclusion_required: true,
      tenant_scoped_key_export_required: true,
      unavailable_key_marking_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 1000,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES],
    test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
    reported_test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
      passed_tests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-public-proof-verification.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-public-proof-verification.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-public-proof-verification.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function publicProofVerificationJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    numPassedTests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }, null, 2);
}

async function writeGovernanceLifecycleEvidenceFixture({
  dir,
  basename = "dojo-governance-lifecycle",
  evidence,
  writeLogs = true,
}) {
  const stdout = "governance lifecycle suite passed\n";
  const stderr = "";
  const jsonReport = governanceLifecycleJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? governanceLifecycleEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function governanceLifecycleEvidenceFixture(overrides = {}) {
  const stdout = "governance lifecycle suite passed\n";
  const stderr = "";
  const jsonReport = governanceLifecycleJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES],
    tested_capabilities: [...DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    configured_capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    capability_coverage_complete: true,
    governance_contract: {
      license_health_required: true,
      approval_queue_required: true,
      approval_decision_audit_required: true,
      rbac_required: true,
      store_rbac_required: true,
      case_law_review_required: true,
      license_revocation_required: true,
      recertification_queue_required: true,
      policy_gates_required: true,
      audit_export_required: true,
      compliance_pack_required: true,
      scheduled_jobs_required: true,
      scheduled_job_runner_tool_required: true,
      compliance_archive_manifest_required: true,
      proof_public_verification_custody_required: true,
      malformed_expiry_fails_closed_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES],
    test_file_count: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    reported_test_file_count: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
      passed_tests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-governance-lifecycle.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-governance-lifecycle.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-governance-lifecycle.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function governanceLifecycleJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    numPassedTests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    numPassedTestSuites: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeGraphRuntimeEvidenceFixture({
  dir,
  basename = "dojo-graph-runtime",
  evidence,
  writeLogs = true,
}) {
  const stdout = "graph runtime suite passed\n";
  const stderr = "";
  const jsonReport = graphRuntimeJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? graphRuntimeEvidenceFixture({
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

function graphRuntimeEvidenceFixture(overrides = {}) {
  const stdout = "graph runtime suite passed\n";
  const stderr = "";
  const jsonReport = graphRuntimeJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_GRAPH_RUNTIME_CAPABILITIES],
    tested_capabilities: [...DOJO_GRAPH_RUNTIME_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    configured_capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: true,
    graph_runtime_contract: {
      graph_ir_validation_required: true,
      graph_compiler_required: true,
      workflow_step_nodes_required: true,
      source_api_binding_required: true,
      production_execution_required: true,
      preflight_only_required: true,
      edge_order_required: true,
      evidence_events_required: true,
      ledger_backed_evidence_required: true,
      preconditions_required: true,
      proof_gate_required: true,
      substrate_executor_required: true,
      expiry_required: true,
      branch_runtime_required: true,
      retry_runtime_required: true,
      case_law_runtime_required: true,
      rollback_runtime_required: true,
      human_resume_required: true,
      validation_fail_closed_required: true,
      predicate_dsl_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_GRAPH_RUNTIME_TEST_FILES],
    test_file_count: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-graph-runtime.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-graph-runtime.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-graph-runtime.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GRAPH_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function graphRuntimeJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    numPassedTests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    numPassedTestSuites: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_GRAPH_RUNTIME_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeGhostModeEvidenceFixture({
  dir,
  basename = "dojo-ghost-mode-evidence",
  evidence,
  writeLogs = true,
}) {
  const stdout = "ghost mode evidence suite passed\n";
  const stderr = "";
  const jsonReport = ghostModeJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? ghostModeEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function ghostModeEvidenceFixture(overrides = {}) {
  const stdout = "ghost mode evidence suite passed\n";
  const stderr = "";
  const jsonReport = ghostModeJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.ghostModeEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES],
    tested_capabilities: [...DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
    configured_capability_count: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
    capability_coverage_complete: true,
    ghost_mode_contract: {
      non_mutating_shadow_run_required: true,
      shadow_evidence_record_required: true,
      audit_custody_required: true,
      mismatch_entrustment_block_required: true,
      compliance_pack_visibility_required: true,
      durable_shadow_evidence_store_required: true,
      tenant_boundary_required: true,
      production_mutation_rejection_required: true,
      operational_filtering_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_GHOST_MODE_EVIDENCE_TEST_FILES],
    test_file_count: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.length,
    reported_test_file_count: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
      passed_tests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-ghost-mode-evidence.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-ghost-mode-evidence.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-ghost-mode-evidence.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GHOST_MODE_EVIDENCE_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 1000,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function ghostModeJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
    numPassedTests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.length,
    numPassedTestSuites: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeSkillPassportEvidenceFixture({
  dir,
  basename = "dojo-skill-passport",
  evidence,
  writeLogs = true,
}) {
  const stdout = "skill passport suite passed\n";
  const stderr = "";
  const jsonReport = skillPassportJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? skillPassportEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function skillPassportEvidenceFixture(overrides = {}) {
  const stdout = "skill passport suite passed\n";
  const stderr = "";
  const jsonReport = skillPassportJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.skillPassportEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_SKILL_PASSPORT_CAPABILITIES],
    tested_capabilities: [...DOJO_SKILL_PASSPORT_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
    configured_capability_count: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
    capability_coverage_complete: true,
    skill_passport_contract: {
      report_only_status_required: true,
      license_scope_required: true,
      readiness_scope_required: true,
      proof_scope_required: true,
      coverage_and_attack_metrics_required: true,
      executable_entrustment_provenance_required: true,
      published_tool_scope_required: true,
      skill_card_action_grouping_required: true,
      proof_badge_required: true,
      practice_guardrail_counts_required: true,
      passport_export_required: true,
      raw_payload_redaction_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_SKILL_PASSPORT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_SKILL_PASSPORT_TEST_FILES],
    test_file_count: DOJO_SKILL_PASSPORT_TEST_FILES.length,
    reported_test_file_count: DOJO_SKILL_PASSPORT_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
      passed_tests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-skill-passport.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-skill-passport.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-skill-passport.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function skillPassportJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
    numPassedTests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_SKILL_PASSPORT_TEST_FILES.length,
    numPassedTestSuites: DOJO_SKILL_PASSPORT_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_SKILL_PASSPORT_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeTimeMachineDebuggerEvidenceFixture({
  dir,
  basename = "dojo-time-machine-debugger",
  evidence,
  writeLogs = true,
}) {
  const stdout = "time machine debugger suite passed\n";
  const stderr = "";
  const jsonReport = timeMachineDebuggerJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? timeMachineDebuggerEvidenceFixture({
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    json_report_path: jsonReportPath,
  });
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(body, null, 2), "utf8");
  return evidencePath;
}

function timeMachineDebuggerEvidenceFixture(overrides = {}) {
  const stdout = "time machine debugger suite passed\n";
  const stderr = "";
  const jsonReport = timeMachineDebuggerJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.timeMachineDebuggerEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES],
    tested_capabilities: [...DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
    configured_capability_count: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
    capability_coverage_complete: true,
    time_machine_contract: {
      deterministic_debug_report_required: true,
      counterfactual_twin_required: true,
      promoted_scenario_selection_required: true,
      scenario_correlation_required: true,
      attack_guardrail_correlation_required: true,
      remediation_cost_policy_required: true,
      baseline_explanation_required: true,
      materialized_runtime_branch_required: true,
      counterfactual_license_impact_required: true,
      replay_plan_required: true,
      honest_projection_status_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 1000,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES],
    test_file_count: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
    reported_test_file_count: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
      passed_tests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-time-machine-debugger.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-time-machine-debugger.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-time-machine-debugger.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function timeMachineDebuggerJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
    numPassedTests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
    numPassedTestSuites: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeVivariumRuntimeEvidenceFixture({
  dir,
  basename = "dojo-vivarium-runtime",
  evidence,
  writeLogs = true,
}) {
  const stdout = "vivarium runtime suite passed\n";
  const stderr = "";
  const jsonReport = vivariumRuntimeJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? vivariumRuntimeEvidenceFixture({
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

function vivariumRuntimeEvidenceFixture(overrides = {}) {
  const stdout = "vivarium runtime suite passed\n";
  const stderr = "";
  const jsonReport = vivariumRuntimeJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_VIVARIUM_RUNTIME_CAPABILITIES],
    tested_capabilities: [...DOJO_VIVARIUM_RUNTIME_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
    configured_capability_count: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: true,
    vivarium_contract: {
      scenario_dsl_required: true,
      synthetic_fixture_materialization_required: true,
      synthetic_only_policy_required: true,
      oracle_required: true,
      ledger_ready_oracle_evidence_required: true,
      api_fault_server_required: true,
      fake_success_state_detection_required: true,
      partial_write_detection_required: true,
      prompt_injection_quarantine_required: true,
      ambiguous_document_names_required: true,
      document_tissue_specific_evidence_required: true,
      ui_tissue_mutations_required: true,
      ui_tissue_specific_evidence_required: true,
      misleading_toast_tissue_required: true,
      policy_tissue_required: true,
      expanded_identity_tissue_required: true,
      invalid_value_data_tissue_required: true,
      stale_missing_data_tissue_required: true,
      api_validation_latency_tissue_required: true,
      deterministic_reset_required: true,
      budget_enforcement_required: true,
      targeted_graph_execution_required: true,
      targeted_postcondition_descendants_required: true,
      executable_checkride_required: true,
      license_constraints_from_blocked_risk_required: true,
      critical_guardrail_failure_required: true,
      substrate_hook_passthrough_required: true,
      evil_twin_attack_measurement_required: true,
      evil_twin_hardening_loop_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_VIVARIUM_RUNTIME_TEST_FILES],
    test_file_count: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-vivarium-runtime.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-vivarium-runtime.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-vivarium-runtime.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_VIVARIUM_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function vivariumRuntimeJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
    numPassedTests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    numPassedTestSuites: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeCheckrideLicenseEvidenceFixture({
  dir,
  basename = "dojo-checkride-license",
  evidence,
  writeLogs = true,
}) {
  const stdout = "checkride license suite passed\n";
  const stderr = "";
  const jsonReport = checkrideLicenseJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? checkrideLicenseEvidenceFixture({
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

function checkrideLicenseEvidenceFixture(overrides = {}) {
  const stdout = "checkride license suite passed\n";
  const stderr = "";
  const jsonReport = checkrideLicenseJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_CHECKRIDE_LICENSE_CAPABILITIES],
    tested_capabilities: [...DOJO_CHECKRIDE_LICENSE_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
    configured_capability_count: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
    capability_coverage_complete: true,
    checkride_license: {
      executable_checkride_required: true,
      graph_runtime_required: true,
      vivarium_oracle_required: true,
      observed_evidence_required: true,
      evidence_record_required: true,
      ledger_append_required: true,
      license_constraints_required: true,
      critical_failure_block_required: true,
      substrate_assertion_required: true,
      entrustment_policy_required: true,
      guardrail_evidence_e3_required: true,
      stale_evidence_downgrade_required: true,
      shadow_mismatch_limit_required: true,
      srl_policy_required: true,
      limited_license_srl7_required: true,
      operational_feedback_srl9_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_CHECKRIDE_LICENSE_TEST_FILES],
    test_file_count: DOJO_CHECKRIDE_LICENSE_TEST_FILES.length,
    reported_test_file_count: DOJO_CHECKRIDE_LICENSE_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
      passed_tests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-checkride-license.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-checkride-license.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-checkride-license.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_CHECKRIDE_LICENSE_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function checkrideLicenseJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
    numPassedTests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_CHECKRIDE_LICENSE_TEST_FILES.length,
    numPassedTestSuites: DOJO_CHECKRIDE_LICENSE_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeCaseLawRuntimeEvidenceFixture({
  dir,
  basename = "dojo-case-law-runtime",
  evidence,
  writeLogs = true,
}) {
  const stdout = "case-law runtime suite passed\n";
  const stderr = "";
  const jsonReport = caseLawRuntimeJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? caseLawRuntimeEvidenceFixture({
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

function caseLawRuntimeEvidenceFixture(overrides = {}) {
  const stdout = "case-law runtime suite passed\n";
  const stderr = "";
  const jsonReport = caseLawRuntimeJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_CASE_LAW_RUNTIME_CAPABILITIES],
    tested_capabilities: [...DOJO_CASE_LAW_RUNTIME_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
    configured_capability_count: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: true,
    case_law_contract: {
      case_law_registry_required: true,
      reviewed_evidence_required: true,
      proposed_cases_nonbinding_required: true,
      approved_binding_scope_required: true,
      deprecated_cases_excluded_required: true,
      guardrail_synthesis_required: true,
      explicit_predicate_preservation_required: true,
      graph_binding_required: true,
      runtime_guardrail_block_required: true,
      refusal_case_citation_required: true,
      inactive_case_suppression_required: true,
      antibody_matching_required: true,
      antibody_proposed_only_required: true,
      antibody_private_data_redaction_required: true,
      local_practice_required: true,
      local_checkride_required: true,
      deterministic_antibody_ids_required: true,
      self_check_executes_tests_required: true,
    },
    test_files: [...DOJO_CASE_LAW_RUNTIME_TEST_FILES],
    test_file_count: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-case-law-runtime.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-case-law-runtime.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-case-law-runtime.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_CASE_LAW_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 123,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
}

function caseLawRuntimeJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
    numPassedTests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    numPassedTestSuites: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeHostedRuntimeGatewayEvidenceFixture({
  dir,
  basename = "dojo-hosted-runtime-gateway",
  evidence,
  writeLogs = true,
}) {
  const stdout = "hosted runtime gateway suite passed\n";
  const stderr = "";
  const jsonReport = hostedRuntimeGatewayJsonReportFixtureText();
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(jsonReportPath, jsonReport, "utf8");
  }
  const body = evidence ?? hostedRuntimeGatewayEvidenceFixture({
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

function hostedRuntimeGatewayEvidenceFixture(overrides = {}) {
  const stdout = "hosted runtime gateway suite passed\n";
  const stderr = "";
  const jsonReport = hostedRuntimeGatewayJsonReportFixtureText();
  return {
    schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    exit_code: 0,
    configured_capabilities: [...DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES],
    tested_capabilities: [...DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
    configured_capability_count: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
    capability_coverage_complete: true,
    hosted_runtime_contract: {
      tenant_scoped_sessions_required: true,
      short_lived_credentials_required: true,
      stored_secret_redaction_required: true,
      origin_allowlist_required: true,
      local_network_policy_required: true,
      screenshot_redaction_required: true,
      skill_run_binding_required: true,
      audit_events_required: true,
      evidence_write_required: true,
      fail_closed_on_missing_evidence_writer_required: true,
      revocation_and_expiry_required: true,
      durable_store_production_requirement_required: true,
      postgres_session_store_required: true,
      durable_postgres_session_gate_required: true,
      durable_postgres_session_gate_id: "dojo_postgres_control_plane_self_check",
      malformed_record_rejection_required: true,
      self_check_executes_tests_required: true,
    },
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 1000,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    test_files: [...DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES],
    test_file_count: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    reported_test_file_count: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
      passed_tests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    stdout_path: overrides.stdout_path || path.join(tmpdir(), "dojo-hosted-runtime-gateway.stdout.log"),
    stderr_path: overrides.stderr_path || path.join(tmpdir(), "dojo-hosted-runtime-gateway.stderr.log"),
    json_report_path: overrides.json_report_path || path.join(tmpdir(), "dojo-hosted-runtime-gateway.vitest.json"),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    json_report_sha256: sha256(jsonReport),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
}

function hostedRuntimeGatewayJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
    numPassedTests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    numPassedTestSuites: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
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
  const chaosRunnerReport = chaosRunnerReportFixtureText();
  const chaosRunnerStdout = "PASS api_fault_server#1\nPASS runtime_preflight_fail_closed#1\nPASS vivarium_oracle#1\n";
  const chaosRunnerStderr = "";
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(dir, `${basename}.vitest.json`);
  const chaosRunnerReportPath = path.join(dir, `${basename}.chaos-runner.json`);
  const chaosRunnerStdoutPath = path.join(dir, `${basename}.chaos-runner.stdout.log`);
  const chaosRunnerStderrPath = path.join(dir, `${basename}.chaos-runner.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  await writeFile(chaosRunnerReportPath, chaosRunnerReport, "utf8");
  await writeFile(chaosRunnerStdoutPath, chaosRunnerStdout, "utf8");
  await writeFile(chaosRunnerStderrPath, chaosRunnerStderr, "utf8");
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
    chaos_runner: {
      ...(body.chaos_runner ?? {}),
      report_path: body.chaos_runner?.report_path && body.chaos_runner.report_path !== "chaos-runner.json"
        ? body.chaos_runner.report_path
        : chaosRunnerReportPath,
      report_sha256: body.chaos_runner?.report_sha256 ?? sha256(chaosRunnerReport),
      report_bytes: body.chaos_runner?.report_bytes ?? Buffer.byteLength(chaosRunnerReport),
      stdout_path: body.chaos_runner?.stdout_path && body.chaos_runner.stdout_path !== "chaos-runner.stdout.log"
        ? body.chaos_runner.stdout_path
        : chaosRunnerStdoutPath,
      stderr_path: body.chaos_runner?.stderr_path && body.chaos_runner.stderr_path !== "chaos-runner.stderr.log"
        ? body.chaos_runner.stderr_path
        : chaosRunnerStderrPath,
      stdout_sha256: body.chaos_runner?.stdout_sha256 ?? sha256(chaosRunnerStdout),
      stderr_sha256: body.chaos_runner?.stderr_sha256 ?? sha256(chaosRunnerStderr),
      stdout_bytes: body.chaos_runner?.stdout_bytes ?? Buffer.byteLength(chaosRunnerStdout),
      stderr_bytes: body.chaos_runner?.stderr_bytes ?? Buffer.byteLength(chaosRunnerStderr),
    },
  };
  const evidencePath = path.join(dir, `${basename}.evidence.json`);
  await writeFile(evidencePath, JSON.stringify(withLogDefaults, null, 2), "utf8");
  return evidencePath;
}

function chaosEvidenceFixture(overrides = {}) {
  const stdout = "chaos suite passed\n";
  const stderr = "";
  const chaosRunnerStdout = "PASS api_fault_server#1\nPASS runtime_preflight_fail_closed#1\nPASS vivarium_oracle#1\n";
  const chaosRunnerStderr = "";
  const chaosRunnerReport = chaosRunnerReportFixtureText();
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
    budget_evaluation: {
      ok: true,
      checks: {
        chaos_runner_report_ok: true,
        chaos_runner_has_scenarios: true,
        chaos_runner_all_runs_passed: true,
      },
    },
    chaos_runner_required: true,
    chaos_runner: {
      ok: true,
      exit_code: 0,
      signal: null,
      report_path: "chaos-runner.json",
      report_sha256: sha256(chaosRunnerReport),
      report_bytes: Buffer.byteLength(chaosRunnerReport),
      stdout_path: "chaos-runner.stdout.log",
      stderr_path: "chaos-runner.stderr.log",
      stdout_sha256: sha256(chaosRunnerStdout),
      stderr_sha256: sha256(chaosRunnerStderr),
      stdout_bytes: Buffer.byteLength(chaosRunnerStdout),
      stderr_bytes: Buffer.byteLength(chaosRunnerStderr),
      scenario_count: 3,
      expected_run_count: 3,
      passed_run_count: 3,
      failed_run_count: 0,
      scenarios: ["api_fault_server", "runtime_preflight_fail_closed", "vivarium_oracle"],
    },
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

function chaosRunnerReportFixtureText() {
  return JSON.stringify({
    schema_version: "synthi.chaosRunnerReport.v1",
    ok: true,
    scenario_count: 3,
    iteration_count: 1,
    expected_run_count: 3,
    passed_run_count: 3,
    failed_run_count: 0,
    scenarios: [
      { name: "api_fault_server", description: "API faults" },
      { name: "runtime_preflight_fail_closed", description: "Runtime preflight" },
      { name: "vivarium_oracle", description: "Vivarium oracle" },
    ],
    results: [
      { ok: true, name: "api_fault_server#1", scenario: "api_fault_server" },
      { ok: true, name: "runtime_preflight_fail_closed#1", scenario: "runtime_preflight_fail_closed" },
      { ok: true, name: "vivarium_oracle#1", scenario: "vivarium_oracle" },
    ],
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

function fixtureVisualPngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(12000, 1),
  ]);
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

function buildConformanceSelfCheckReport({
  checks,
  checkResults,
} = {}) {
  const report = buildConformanceReport({
    schemaVersion: "synthi.dojo.mcpHostConformance.selfCheck.v1",
    executeProduction: false,
  });
  report.checks = checks || [
    "remote host classification",
    "loopback rejection",
    "private network rejection",
    "link-local rejection",
    "unique local ipv6 rejection",
    "competency selection",
    "blocked call detection",
    "report redaction",
  ];
  report.check_results = checkResults || [
    { id: "remote_host_classification", ok: true },
    { id: "loopback_rejection", ok: true },
    { id: "private_network_rejection", ok: true },
    { id: "link_local_rejection", ok: true },
    { id: "unique_local_ipv6_rejection", ok: true },
    { id: "competency_selection", ok: true },
    { id: "blocked_call_detection", ok: true },
    { id: "report_redaction", ok: true },
  ];
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

function buildVisualReportResult({ routeId, viewport, screenshotPath, bytes, screenshotSha256 }) {
  return {
    route_id: routeId,
    viewport,
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
  };
}
