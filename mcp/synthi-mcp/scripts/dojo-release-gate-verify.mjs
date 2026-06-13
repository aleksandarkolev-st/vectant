#!/usr/bin/env node
/*
 * Verify generated Dojo release-gate artifacts.
 *
 * The manifest generator defines which gates exist. This verifier proves that
 * emitted artifacts are present, digest-matched, schema-valid, and suitable for
 * the promotion mode being claimed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runSelfCheck as runReleaseGateManifestSelfCheck,
  validateDojoReleaseGateManifest,
  validateDojoVisualProofReport,
} from "./dojo-release-gate-manifest.mjs";
import {
  DOJO_API_TOOL_COMPILER_CAPABILITIES,
  DOJO_API_TOOL_COMPILER_TEST_FILES,
} from "./dojo-api-tool-compiler-self-check.mjs";
import {
  DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
  DOJO_CASE_LAW_RUNTIME_TEST_FILES,
} from "./dojo-case-law-runtime-self-check.mjs";
import {
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
  DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS,
  redactConformanceReport,
} from "./dojo-mcp-host-conformance.mjs";
import {
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
} from "./dojo-chaos-performance-self-check.mjs";
import {
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
  DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} from "./dojo-compliance-export-self-check.mjs";
import {
  DOJO_DOCKER_HEALTHY_SERVICES,
  DOJO_DOCKER_REQUIRED_ENDPOINTS,
  DOJO_DOCKER_REQUIRED_SERVICES,
} from "./dojo-docker-integration-self-check.mjs";
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
  DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
  DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
} from "./dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
  DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
} from "./dojo-managed-key-signing-self-check.mjs";
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
import {
  DOJO_SOURCE_DRIFT_CAPABILITIES,
  DOJO_SOURCE_DRIFT_TEST_FILES,
} from "./dojo-source-drift-self-check.mjs";
import {
  DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
  DOJO_VIVARIUM_RUNTIME_TEST_FILES,
} from "./dojo-vivarium-runtime-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

const DEFAULT_RELEASE_GATE_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gates");
const DEFAULT_VERIFY_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gate-verify");
const DEFAULT_WORKFLOW_PIPELINE_E2E_DIR = path.join(REPO_ROOT, "tmp", "workflow-pipeline-e2e");
const DEFAULT_PRIVATE_TOOL_STDIO_ACCEPTANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-stdio-acceptance");
const DEFAULT_PRIVATE_TOOL_CODEX_ACCEPTANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-codex-acceptance");
const DEFAULT_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "dojo-mcp-host-conformance");
const DEFAULT_PRIVATE_TOOL_STDIO_HOST_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-stdio-host-conformance");
const DEFAULT_PRIVATE_TOOL_CODEX_HOST_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-codex-host-conformance");
const DEFAULT_POSTGRES_CONTROL_PLANE_DIR = path.join(REPO_ROOT, "tmp", "dojo-postgres-control-plane");
const DEFAULT_AFFORDANCE_CODEMOD_DIR = path.join(REPO_ROOT, "tmp", "dojo-affordance-codemod-self-check");
const DEFAULT_SOURCE_DRIFT_DIR = path.join(REPO_ROOT, "tmp", "dojo-source-drift");
const DEFAULT_API_TOOL_COMPILER_DIR = path.join(REPO_ROOT, "tmp", "dojo-api-tool-compiler");
const DEFAULT_GENERATED_PR_DIR = path.join(REPO_ROOT, "tmp", "dojo-generated-pr");
const DEFAULT_DOCKER_INTEGRATION_DIR = path.join(REPO_ROOT, "tmp", "dojo-docker-integration");
const DEFAULT_GOVERNANCE_LIFECYCLE_DIR = path.join(REPO_ROOT, "tmp", "dojo-governance-lifecycle");
const DEFAULT_GRAPH_RUNTIME_DIR = path.join(REPO_ROOT, "tmp", "dojo-graph-runtime");
const DEFAULT_HOSTED_RUNTIME_GATEWAY_DIR = path.join(REPO_ROOT, "tmp", "dojo-hosted-runtime-gateway");
const DEFAULT_MANAGED_KEY_SIGNING_DIR = path.join(REPO_ROOT, "tmp", "dojo-managed-key-signing");
const DEFAULT_CASE_LAW_RUNTIME_DIR = path.join(REPO_ROOT, "tmp", "dojo-case-law-runtime");
const DEFAULT_VIVARIUM_RUNTIME_DIR = path.join(REPO_ROOT, "tmp", "dojo-vivarium-runtime");
const DEFAULT_SECURITY_ABUSE_DIR = path.join(REPO_ROOT, "tmp", "dojo-security-abuse");
const DEFAULT_COMPLIANCE_EXPORT_DIR = path.join(REPO_ROOT, "tmp", "dojo-compliance-export");
const DEFAULT_PRIVACY_REDACTION_DIR = path.join(REPO_ROOT, "tmp", "dojo-privacy-redaction");
const DEFAULT_CHAOS_PERFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "dojo-chaos-performance");
const DEFAULT_SOAK_DIR = path.join(MCP_ROOT, ".soak");

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || DEFAULT_VERIFY_DIR);
  if (truthy(args["self-check"])) {
    const selfCheck = await runSelfCheck({ outDir });
    console.log(`[ok] Dojo release gate verifier self-check passed - report=${selfCheck.report_path}`);
    return;
  }

  const result = await verifyDojoReleaseGateArtifactsFromArgs({ args });
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "dojo-release-gate-verification.json");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (!result.ok) {
    throw new Error(`dojo_release_gate_verify_failed:${result.errors.join(";")}`);
  }
  console.log(`[ok] Dojo release gate artifacts verified - report=${reportPath}`);
}

export async function verifyDojoReleaseGateArtifactsFromArgs({ args = {} } = {}) {
  const manifestPath = resolveRepoPath(args.manifest || args["manifest-path"] || path.join(DEFAULT_RELEASE_GATE_DIR, "dojo-release-gate-manifest.json"));
  const evidencePath = resolveRepoPath(args.evidence || args["manifest-evidence"] || path.join(DEFAULT_RELEASE_GATE_DIR, "dojo-release-gate-manifest.evidence.json"));
  const manifestResult = await verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath });
  const manifest = manifestResult.manifest;

  const proofSelfCheckResults = [];
  const shouldVerifyDojoSelfCheck = truthy(args["release-candidate"])
    || truthy(args["include-dojo-self-check-default"])
    || args["dojo-self-check-summary"]
    || args["dojo-self-check-production-evidence"];
  if (shouldVerifyDojoSelfCheck) {
    const selfCheckGate = findGate(manifest, "dojo_self_check") || {};
    const summaryPath = resolveRepoPath(args["dojo-self-check-summary"]
      || selfCheckGate.default_report_path
      || path.join(DEFAULT_VERIFY_DIR, "dojo-proof-self-check-summary.json"));
    const productionEvidencePath = args["dojo-self-check-production-evidence"]
      ? resolveRepoPath(args["dojo-self-check-production-evidence"])
      : selfCheckGate.default_evidence_path
        ? resolveRepoPath(selfCheckGate.default_evidence_path)
        : undefined;
    proofSelfCheckResults.push(await verifyDojoProofSelfCheckArtifacts({
      summaryPath,
      productionEvidencePath,
    }));
  }

  const visualResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-visual-defaults"])) {
    for (const gate of manifest?.gates || []) {
      if (gate.evidence_kind !== "visual_report" || !gate.default_report_path) continue;
      visualResults.push(await verifyVisualProofArtifact({
        manifest,
        gateId: gate.id,
        reportPath: resolveRepoPath(gate.default_report_path),
      }));
    }
  }
  for (const request of parseVisualReportArgs(args)) {
    visualResults.push(await verifyVisualProofArtifact({
      manifest,
      gateId: request.gateId,
      reportPath: resolveRepoPath(request.reportPath),
    }));
  }

  const postgresControlPlaneResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-postgres-control-plane"]) || args["postgres-control-plane-evidence"]) {
    const postgresGate = findGate(manifest, "dojo_postgres_control_plane_self_check") || {};
    postgresControlPlaneResults.push(await verifyDojoPostgresControlPlaneEvidenceArtifact({
      evidencePath: resolveRepoPath(args["postgres-control-plane-evidence"]
        || postgresGate.default_evidence_path
        || path.join(DEFAULT_POSTGRES_CONTROL_PLANE_DIR, "dojo-postgres-control-plane.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const dockerIntegrationResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-docker-integration"]) || args["docker-integration-evidence"]) {
    const dockerGate = findGate(manifest, "docker_integration") || {};
    dockerIntegrationResults.push(await verifyDojoDockerIntegrationEvidenceArtifact({
      evidencePath: resolveRepoPath(args["docker-integration-evidence"]
        || dockerGate.default_evidence_path
        || path.join(DEFAULT_DOCKER_INTEGRATION_DIR, "dojo-docker-integration.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const sourceApiResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-affordance-codemod"]) || args["affordance-codemod-report"] || args["affordance-codemod-evidence"]) {
    const affordanceGate = findGate(manifest, "dojo_affordance_codemod_self_check") || {};
    sourceApiResults.push(await verifyDojoAffordanceCodemodEvidenceArtifact({
      reportPath: resolveRepoPath(args["affordance-codemod-report"]
        || affordanceGate.default_report_path
        || path.join(DEFAULT_AFFORDANCE_CODEMOD_DIR, "dojo-affordance-codemod-self-check.json")),
      evidencePath: resolveRepoPath(args["affordance-codemod-evidence"]
        || affordanceGate.default_evidence_path
        || path.join(DEFAULT_AFFORDANCE_CODEMOD_DIR, "dojo-affordance-codemod-self-check.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }
  if (truthy(args["release-candidate"]) || truthy(args["include-source-drift"]) || args["source-drift-evidence"]) {
    const sourceDriftGate = findGate(manifest, "dojo_source_drift_self_check") || {};
    sourceApiResults.push(await verifyDojoSourceDriftEvidenceArtifact({
      evidencePath: resolveRepoPath(args["source-drift-evidence"]
        || sourceDriftGate.default_evidence_path
        || path.join(DEFAULT_SOURCE_DRIFT_DIR, "dojo-source-drift.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }
  if (truthy(args["release-candidate"]) || truthy(args["include-api-tool-compiler"]) || args["api-tool-compiler-evidence"]) {
    const apiToolCompilerGate = findGate(manifest, "dojo_api_tool_compiler_self_check") || {};
    sourceApiResults.push(await verifyDojoApiToolCompilerEvidenceArtifact({
      evidencePath: resolveRepoPath(args["api-tool-compiler-evidence"]
        || apiToolCompilerGate.default_evidence_path
        || path.join(DEFAULT_API_TOOL_COMPILER_DIR, "dojo-api-tool-compiler.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const generatedPrResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-generated-pr"]) || args["generated-pr-evidence"]) {
    const generatedPrGate = findGate(manifest, "dojo_generated_pr_self_check") || {};
    generatedPrResults.push(await verifyDojoGeneratedPrEvidenceArtifact({
      evidencePath: resolveRepoPath(args["generated-pr-evidence"]
        || generatedPrGate.default_evidence_path
        || path.join(DEFAULT_GENERATED_PR_DIR, "dojo-generated-pr.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const liveHostedRuntimeResults = [];
  const shouldVerifyLiveHostedRuntime = truthy(args["release-candidate"])
    || args["workflow-e2e-summary"]
    || args["private-tool-stdio-acceptance"]
    || args["private-tool-codex-acceptance"];
  if (shouldVerifyLiveHostedRuntime) {
    const workflowGate = findGate(manifest, "workflow_e2e_hosted") || {};
    const stdioGate = findGate(manifest, "private_tool_stdio_acceptance") || {};
    const codexGate = findGate(manifest, "private_tool_codex_acceptance") || {};
    liveHostedRuntimeResults.push(await verifyDojoWorkflowPipelineE2EArtifact({
      summaryPath: resolveRepoPath(args["workflow-e2e-summary"]
        || workflowGate.default_report_path
        || path.join(DEFAULT_WORKFLOW_PIPELINE_E2E_DIR, "summary.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
    liveHostedRuntimeResults.push(await verifyDojoPrivateToolStdioAcceptanceArtifact({
      transcriptPath: resolveRepoPath(args["private-tool-stdio-acceptance"]
        || stdioGate.default_report_path
        || path.join(DEFAULT_PRIVATE_TOOL_STDIO_ACCEPTANCE_DIR, "mcp-stdio-private-tool-acceptance.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
    liveHostedRuntimeResults.push(await verifyDojoPrivateToolCodexAcceptanceArtifact({
      transcriptPath: resolveRepoPath(args["private-tool-codex-acceptance"]
        || codexGate.default_report_path
        || path.join(DEFAULT_PRIVATE_TOOL_CODEX_ACCEPTANCE_DIR, "codex-private-tool-acceptance.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const conformanceResults = [];
  const shouldVerifyDeployedHostConformance = truthy(args["release-candidate"])
    || args["mcp-host-conformance-report"]
    || args["private-tool-stdio-host-conformance"]
    || args["private-tool-codex-host-conformance"];
  if (shouldVerifyDeployedHostConformance) {
    const stdioHostGate = findGate(manifest, "private_tool_stdio_host_conformance") || {};
    const codexHostGate = findGate(manifest, "private_tool_codex_host_conformance") || {};
    conformanceResults.push(await verifyDojoMcpHostConformanceArtifacts({
      reportPath: resolveRepoPath(args["mcp-host-conformance-report"] || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.json")),
      evidencePath: resolveRepoPath(args["mcp-host-conformance-evidence"] || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
    conformanceResults.push(await verifyDojoPrivateToolStdioHostConformanceArtifact({
      transcriptPath: resolveRepoPath(args["private-tool-stdio-host-conformance"]
        || stdioHostGate.default_report_path
        || path.join(DEFAULT_PRIVATE_TOOL_STDIO_HOST_CONFORMANCE_DIR, "mcp-stdio-private-tool-acceptance.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
    conformanceResults.push(await verifyDojoPrivateToolCodexHostConformanceArtifact({
      transcriptPath: resolveRepoPath(args["private-tool-codex-host-conformance"]
        || codexHostGate.default_report_path
        || path.join(DEFAULT_PRIVATE_TOOL_CODEX_HOST_CONFORMANCE_DIR, "codex-private-tool-acceptance.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const managedKeySigningResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-managed-key-signing"]) || args["managed-key-signing-evidence"]) {
    const managedKeyGate = findGate(manifest, "dojo_managed_key_signing_self_check") || {};
    managedKeySigningResults.push(await verifyDojoManagedKeySigningEvidenceArtifact({
      evidencePath: resolveRepoPath(args["managed-key-signing-evidence"]
        || managedKeyGate.default_evidence_path
        || path.join(DEFAULT_MANAGED_KEY_SIGNING_DIR, "dojo-managed-key-signing.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const governanceLifecycleResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-governance-lifecycle"]) || args["governance-lifecycle-evidence"]) {
    const governanceGate = findGate(manifest, "dojo_governance_lifecycle_self_check") || {};
    governanceLifecycleResults.push(await verifyDojoGovernanceLifecycleEvidenceArtifact({
      evidencePath: resolveRepoPath(args["governance-lifecycle-evidence"]
        || governanceGate.default_evidence_path
        || path.join(DEFAULT_GOVERNANCE_LIFECYCLE_DIR, "dojo-governance-lifecycle.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const graphRuntimeResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-graph-runtime"]) || args["graph-runtime-evidence"]) {
    const graphRuntimeGate = findGate(manifest, "dojo_graph_runtime_self_check") || {};
    graphRuntimeResults.push(await verifyDojoGraphRuntimeEvidenceArtifact({
      evidencePath: resolveRepoPath(args["graph-runtime-evidence"]
        || graphRuntimeGate.default_evidence_path
        || path.join(DEFAULT_GRAPH_RUNTIME_DIR, "dojo-graph-runtime.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const vivariumRuntimeResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-vivarium-runtime"]) || args["vivarium-runtime-evidence"]) {
    const vivariumRuntimeGate = findGate(manifest, "dojo_vivarium_runtime_self_check") || {};
    vivariumRuntimeResults.push(await verifyDojoVivariumRuntimeEvidenceArtifact({
      evidencePath: resolveRepoPath(args["vivarium-runtime-evidence"]
        || vivariumRuntimeGate.default_evidence_path
        || path.join(DEFAULT_VIVARIUM_RUNTIME_DIR, "dojo-vivarium-runtime.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const caseLawRuntimeResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-case-law-runtime"]) || args["case-law-runtime-evidence"]) {
    const caseLawRuntimeGate = findGate(manifest, "dojo_case_law_runtime_self_check") || {};
    caseLawRuntimeResults.push(await verifyDojoCaseLawRuntimeEvidenceArtifact({
      evidencePath: resolveRepoPath(args["case-law-runtime-evidence"]
        || caseLawRuntimeGate.default_evidence_path
        || path.join(DEFAULT_CASE_LAW_RUNTIME_DIR, "dojo-case-law-runtime.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const hostedRuntimeGatewayResults = [];
  if (truthy(args["release-candidate"]) || truthy(args["include-hosted-runtime-gateway"]) || args["hosted-runtime-gateway-evidence"]) {
    const hostedRuntimeGatewayGate = findGate(manifest, "dojo_hosted_runtime_gateway_self_check") || {};
    hostedRuntimeGatewayResults.push(await verifyDojoHostedRuntimeGatewayEvidenceArtifact({
      evidencePath: resolveRepoPath(args["hosted-runtime-gateway-evidence"]
        || hostedRuntimeGatewayGate.default_evidence_path
        || path.join(DEFAULT_HOSTED_RUNTIME_GATEWAY_DIR, "dojo-hosted-runtime-gateway.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const securityResults = [];
  if (truthy(args["release-candidate"]) || args["security-abuse-evidence"]) {
    securityResults.push(await verifyDojoSecurityAbuseEvidenceArtifact({
      evidencePath: resolveRepoPath(args["security-abuse-evidence"] || path.join(DEFAULT_SECURITY_ABUSE_DIR, "dojo-security-abuse.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const complianceExportResults = [];
  if (truthy(args["release-candidate"]) || args["compliance-export-evidence"]) {
    const complianceGate = findGate(manifest, "compliance_export_suite") || {};
    complianceExportResults.push(await verifyDojoComplianceExportEvidenceArtifact({
      evidencePath: resolveRepoPath(args["compliance-export-evidence"]
        || complianceGate.default_evidence_path
        || path.join(DEFAULT_COMPLIANCE_EXPORT_DIR, "dojo-compliance-export.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const privacyRedactionResults = [];
  if (truthy(args["release-candidate"]) || args["privacy-redaction-evidence"]) {
    const privacyGate = findGate(manifest, "privacy_redaction_suite") || {};
    privacyRedactionResults.push(await verifyDojoPrivacyRedactionEvidenceArtifact({
      evidencePath: resolveRepoPath(args["privacy-redaction-evidence"]
        || privacyGate.default_evidence_path
        || path.join(DEFAULT_PRIVACY_REDACTION_DIR, "dojo-privacy-redaction.evidence.json")),
      releaseCandidate: truthy(args["release-candidate"]),
    }));
  }

  const chaosPerformanceResults = [];
  if (truthy(args["enterprise-release"]) || truthy(args["include-chaos-performance"]) || args["chaos-performance-evidence"]) {
    chaosPerformanceResults.push(await verifyDojoChaosPerformanceEvidenceArtifact({
      evidencePath: resolveRepoPath(args["chaos-performance-evidence"] || path.join(DEFAULT_CHAOS_PERFORMANCE_DIR, "dojo-chaos-performance.evidence.json")),
      enterpriseRelease: truthy(args["enterprise-release"]),
    }));
  }

  const soakPerformanceResults = [];
  if (truthy(args["enterprise-release"]) || args["soak-summary"]) {
    soakPerformanceResults.push(await verifyDojoSoakPerformanceArtifacts({
      summaryPath: resolveRepoPath(args["soak-summary"] || path.join(DEFAULT_SOAK_DIR, "soak-summary.json")),
      eventsPath: resolveRepoPath(args["soak-events"] || path.join(DEFAULT_SOAK_DIR, "soak-events.ndjson")),
      enterpriseRelease: truthy(args["enterprise-release"]),
      minDurationSeconds: parseOptionalNumber(args["min-soak-duration-s"]),
    }));
  }

  const sections = [manifestResult, ...proofSelfCheckResults, ...visualResults, ...postgresControlPlaneResults, ...dockerIntegrationResults, ...sourceApiResults, ...generatedPrResults, ...liveHostedRuntimeResults, ...conformanceResults, ...managedKeySigningResults, ...governanceLifecycleResults, ...graphRuntimeResults, ...vivariumRuntimeResults, ...caseLawRuntimeResults, ...hostedRuntimeGatewayResults, ...securityResults, ...complianceExportResults, ...privacyRedactionResults, ...chaosPerformanceResults, ...soakPerformanceResults];
  const errors = sections.flatMap((section) => section.errors.map((error) => `${section.id}:${error}`));
  return {
    schema_version: "synthi.dojo.releaseGateVerification.v1",
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    manifest: summarizeSection(manifestResult),
    dojo_self_check: proofSelfCheckResults.map(summarizeSection),
    visual_reports: visualResults.map(summarizeSection),
    postgres_control_plane: postgresControlPlaneResults.map(summarizeSection),
    docker_integration: dockerIntegrationResults.map(summarizeSection),
    source_api: sourceApiResults.map(summarizeSection),
    generated_pr: generatedPrResults.map(summarizeSection),
    live_hosted_runtime: liveHostedRuntimeResults.map(summarizeSection),
    mcp_host_conformance: conformanceResults.map(summarizeSection),
    managed_key_signing: managedKeySigningResults.map(summarizeSection),
    governance_lifecycle: governanceLifecycleResults.map(summarizeSection),
    graph_runtime: graphRuntimeResults.map(summarizeSection),
    vivarium_runtime: vivariumRuntimeResults.map(summarizeSection),
    case_law_runtime: caseLawRuntimeResults.map(summarizeSection),
    hosted_runtime_gateway: hostedRuntimeGatewayResults.map(summarizeSection),
    security_abuse: securityResults.map(summarizeSection),
    compliance_export: complianceExportResults.map(summarizeSection),
    privacy_redaction: privacyRedactionResults.map(summarizeSection),
    chaos_performance: chaosPerformanceResults.map(summarizeSection),
    soak_performance: soakPerformanceResults.map(summarizeSection),
  };
}

export async function verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath }) {
  const { artifact: manifest, evidence, digest } = await readDigestCheckedJsonPair({
    id: "release_gate_manifest",
    artifactPath: manifestPath,
    evidencePath,
    evidenceSchema: "synthi.dojo.releaseGateEvidence.v1",
    digestField: "manifest_sha256",
    bytesField: "manifest_bytes",
    pathField: "manifest_path",
  });
  const validation = validateDojoReleaseGateManifest(manifest);
  const errors = [...digest.errors];
  if (!validation.ok) errors.push(...validation.errors.map((error) => `manifest_invalid:${error}`));
  if (evidence.validation_ok !== true) errors.push("evidence_validation_not_ok");
  if (Array.isArray(evidence.validation_errors) && evidence.validation_errors.length > 0) {
    errors.push(`evidence_validation_errors:${evidence.validation_errors.join(",")}`);
  }
  if (evidence.tier_count !== manifest.tiers?.length) errors.push("evidence_tier_count_mismatch");
  if (evidence.gate_count !== manifest.gates?.length) errors.push("evidence_gate_count_mismatch");
  return {
    id: "release_gate_manifest",
    ok: errors.length === 0,
    errors,
    manifest,
    evidence,
    artifact_path: manifestPath,
    evidence_path: evidencePath,
  };
}

export async function verifyVisualProofArtifact({ manifest, gateId, reportPath }) {
  const gate = findGate(manifest, gateId);
  const errors = [];
  if (!gate) {
    errors.push(`unknown_visual_gate:${gateId || "missing"}`);
    return { id: gateId || "visual_report", ok: false, errors, artifact_path: reportPath };
  }
  if (gate.evidence_kind !== "visual_report") errors.push(`gate_not_visual_report:${gate.id}`);
  const report = await readJsonFile(reportPath);
  const validation = validateDojoVisualProofReport(report, { gate });
  errors.push(...validation.errors);
  errors.push(...await validateVisualScreenshotArtifacts(report));
  return {
    id: gate.id,
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    report_schema_version: report?.schema_version ?? null,
    result_count: validation.result_count,
  };
}

export async function verifyDojoProofSelfCheckArtifacts({ summaryPath, productionEvidencePath }) {
  const summary = await readJsonFile(summaryPath);
  const resolvedEvidencePath = productionEvidencePath
    ?? resolveEvidenceArtifactPath(summary?.production_runtime_evidence, summaryPath);
  const evidence = await readJsonFile(resolvedEvidencePath);
  const errors = validateDojoProofSelfCheckForRelease(summary, evidence).errors;
  const visualArtifacts = await validateDojoProofSelfCheckVisualArtifacts({ summary, summaryPath });
  errors.push(...visualArtifacts.errors);
  return {
    id: "dojo_self_check",
    ok: errors.length === 0,
    errors,
    artifact_path: summaryPath,
    evidence_path: resolvedEvidencePath,
    visual_evidence_path: visualArtifacts.visual_evidence_path,
    visual_screenshot_path: visualArtifacts.visual_screenshot_path,
    report_schema_version: summary?.schema_version ?? null,
    evidence_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoProofSelfCheckForRelease(summary, productionEvidence) {
  const errors = [];
  if (summary?.schema_version !== "synthi.dojo.proofSelfCheckSummary.v1") {
    errors.push(`dojo_self_check_summary_schema_mismatch:${summary?.schema_version || "missing"}`);
  }
  if (summary?.ok !== true) errors.push("dojo_self_check_not_ok");
  if (summary?.production_proof_consumed !== true) errors.push("dojo_self_check_production_proof_not_consumed");
  if (summary?.production_proof_replay_blocked !== true) errors.push("dojo_self_check_replay_not_blocked");
  if (Number(summary?.production_runtime_evidence_record_count || 0) <= 0) {
    errors.push("dojo_self_check_runtime_evidence_missing");
  }
  if (summary?.visual_proof_ok !== true) errors.push("dojo_self_check_visual_not_ok");
  if (summary?.visual_proof_pixel_metrics_verified !== true) errors.push("dojo_self_check_visual_pixel_metrics_missing");
  if (Number(summary?.visual_proof_horizontal_overflow_px || 0) > 4) {
    errors.push(`dojo_self_check_visual_horizontal_overflow:${summary.visual_proof_horizontal_overflow_px}`);
  }

  if (productionEvidence?.schema_version !== "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1") {
    errors.push(`dojo_self_check_production_evidence_schema_mismatch:${productionEvidence?.schema_version || "missing"}`);
  }
  if (productionEvidence?.proof_consumed !== true) errors.push("dojo_self_check_evidence_proof_not_consumed");
  if (productionEvidence?.replay_blocked !== true) errors.push("dojo_self_check_evidence_replay_not_blocked");
  if (productionEvidence?.runtime_session?.redaction_policy?.screenshots !== true) {
    errors.push("dojo_self_check_runtime_screenshot_privacy_missing");
  }
  if (productionEvidence?.runtime_session?.egress_policy?.local_network_allowed !== false) {
    errors.push("dojo_self_check_runtime_local_network_not_blocked");
  }
  if (productionEvidence?.runtime_authorization?.ok !== true) {
    errors.push("dojo_self_check_runtime_authorization_not_ok");
  }
  if (!Array.isArray(productionEvidence?.runtime_authorization?.evidence_record_ids)
    || productionEvidence.runtime_authorization.evidence_record_ids.length === 0) {
    errors.push("dojo_self_check_runtime_authorization_evidence_missing");
  }
  if (productionEvidence?.proof_record?.status !== "used") {
    errors.push(`dojo_self_check_proof_record_not_used:${productionEvidence?.proof_record?.status || "missing"}`);
  }
  if (JSON.stringify(productionEvidence ?? {}).includes("credential_secret")) {
    errors.push("dojo_self_check_runtime_credential_secret_leaked");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

async function validateDojoProofSelfCheckVisualArtifacts({ summary, summaryPath }) {
  const errors = [];
  const visualEvidencePath = summary?.visual_proof_evidence
    ? resolveEvidenceArtifactPath(summary.visual_proof_evidence, summaryPath)
    : "";
  const summaryScreenshotPath = summary?.visual_proof_screenshot
    ? resolveEvidenceArtifactPath(summary.visual_proof_screenshot, summaryPath)
    : "";
  let visualEvidence = null;
  if (!visualEvidencePath) {
    errors.push("dojo_self_check_visual_evidence_path_missing");
  } else {
    try {
      visualEvidence = await readJsonFile(visualEvidencePath);
    } catch (err) {
      errors.push(`dojo_self_check_visual_evidence_missing:${visualEvidencePath}`);
    }
  }

  if (!visualEvidence) {
    return {
      errors,
      visual_evidence_path: visualEvidencePath || null,
      visual_screenshot_path: summaryScreenshotPath || null,
    };
  }

  if (visualEvidence?.schema_version !== "synthi.dojo.proofSelfCheckVisualEvidence.v1") {
    errors.push(`dojo_self_check_visual_evidence_schema_mismatch:${visualEvidence?.schema_version || "missing"}`);
  }
  if (visualEvidence?.ok !== true) errors.push("dojo_self_check_visual_evidence_not_ok");
  if (Array.isArray(visualEvidence?.failed_visual_gates) && visualEvidence.failed_visual_gates.length > 0) {
    errors.push(`dojo_self_check_visual_failed_gates:${visualEvidence.failed_visual_gates.join(",")}`);
  }

  for (const checkName of ["has_skill_id", "has_tool_name", "has_license_status", "has_proof_capsule"]) {
    if (visualEvidence?.checks?.[checkName] !== true) {
      errors.push(`dojo_self_check_visual_required_check_failed:${checkName}`);
    }
  }

  const thresholds = visualEvidence?.visual_thresholds || {};
  const imageMetrics = visualEvidence?.image_metrics || {};
  const layoutMetrics = visualEvidence?.layout_metrics || {};
  if (imageMetrics.pixel_metrics_verified !== true) errors.push("dojo_self_check_visual_pixel_metrics_missing");
  if (Number(imageMetrics.width || 0) <= 0 || Number(imageMetrics.height || 0) <= 0) {
    errors.push("dojo_self_check_visual_image_dimensions_missing");
  }
  if (Number(imageMetrics.unique_color_sample_count || 0) < Number(thresholds.min_unique_color_sample_count || 0)) {
    errors.push(`dojo_self_check_visual_unique_color_budget_failed:${imageMetrics.unique_color_sample_count ?? "missing"}`);
  }
  if (Number(imageMetrics.luma_stddev || 0) < Number(thresholds.min_luma_stddev || 0)) {
    errors.push(`dojo_self_check_visual_luma_budget_failed:${imageMetrics.luma_stddev ?? "missing"}`);
  }
  if (Number(imageMetrics.background_diff_pixel_ratio || 0) < Number(thresholds.min_background_diff_pixel_ratio || 0)) {
    errors.push(`dojo_self_check_visual_background_diff_budget_failed:${imageMetrics.background_diff_pixel_ratio ?? "missing"}`);
  }
  if (layoutMetrics.selector_found !== true || layoutMetrics.selector_visible !== true) {
    errors.push("dojo_self_check_visual_selector_not_visible");
  }
  if (Number(layoutMetrics.horizontal_overflow_px || 0) > Number(thresholds.max_horizontal_overflow_px ?? 4)) {
    errors.push(`dojo_self_check_visual_horizontal_overflow:${layoutMetrics.horizontal_overflow_px ?? "missing"}`);
  }
  if (Number(layoutMetrics.selector_visible_area_px || 0) < Number(thresholds.min_selector_visible_area_px || 0)) {
    errors.push(`dojo_self_check_visual_visible_area_budget_failed:${layoutMetrics.selector_visible_area_px ?? "missing"}`);
  }

  const evidenceScreenshotPath = visualEvidence?.screenshot_path
    ? resolveEvidenceArtifactPath(visualEvidence.screenshot_path, visualEvidencePath)
    : "";
  const screenshotPath = evidenceScreenshotPath || summaryScreenshotPath;
  if (!screenshotPath) {
    errors.push("dojo_self_check_visual_screenshot_path_missing");
  }
  if (summaryScreenshotPath && evidenceScreenshotPath && path.resolve(summaryScreenshotPath) !== path.resolve(evidenceScreenshotPath)) {
    errors.push("dojo_self_check_visual_screenshot_path_mismatch");
  }
  if (screenshotPath) {
    try {
      const info = await stat(screenshotPath);
      if (!info.isFile()) errors.push(`dojo_self_check_visual_screenshot_not_file:${screenshotPath}`);
      if (Number(visualEvidence?.screenshot_bytes || 0) !== info.size) {
        errors.push(`dojo_self_check_visual_screenshot_bytes_mismatch:${visualEvidence?.screenshot_bytes ?? "missing"}:${info.size}`);
      }
      const minScreenshotBytes = Number(thresholds.min_screenshot_bytes || 0);
      if (info.size < minScreenshotBytes) {
        errors.push(`dojo_self_check_visual_screenshot_too_small:${info.size}:${minScreenshotBytes}`);
      }
      const bytes = await readFile(screenshotPath);
      if (!isPngBytes(bytes)) errors.push("dojo_self_check_visual_screenshot_not_png");
    } catch {
      errors.push(`dojo_self_check_visual_screenshot_missing:${screenshotPath}`);
    }
  }

  return {
    errors,
    visual_evidence_path: visualEvidencePath || null,
    visual_screenshot_path: screenshotPath || null,
  };
}

export async function verifyDojoPostgresControlPlaneEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoPostgresControlPlaneEvidenceForMilestone(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_postgres_control_plane_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    result_count: Number(evidence?.test_summary?.total_tests || 0),
  };
}

export function validateDojoPostgresControlPlaneEvidenceForMilestone(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.postgresControlPlaneEvidence.v1") {
    errors.push(`postgres_control_plane_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("postgres_control_plane_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`postgres_control_plane_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.postgres_url_configured !== true) errors.push("postgres_control_plane_url_missing");
  if (evidence?.postgres_connection?.password_redacted !== true) errors.push("postgres_control_plane_password_not_redacted");
  if (JSON.stringify(evidence ?? {}).includes("SYNTHI_DOJO_POSTGRES_TEST_URL=")) {
    errors.push("postgres_control_plane_raw_env_leaked");
  }
  if (evidence?.capability_coverage_complete !== true) errors.push("postgres_control_plane_capability_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`postgres_control_plane_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`postgres_control_plane_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
    prefix: "postgres_control_plane",
  }));
  const untestedRequiredCapabilities = DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`postgres_control_plane_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`postgres_control_plane_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`postgres_control_plane_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("postgres_control_plane_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`postgres_control_plane_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`postgres_control_plane_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("postgres_control_plane_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`postgres_control_plane_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateRequiredEvidenceTestFiles({ evidence, requiredTestFiles, prefix }) {
  const errors = [];
  const testFiles = Array.isArray(evidence?.test_files) ? evidence.test_files.map(String) : [];
  const missingTestFiles = requiredTestFiles.filter((file) => !testFiles.includes(file));
  if (missingTestFiles.length > 0) {
    errors.push(`${prefix}_required_test_files_missing:${missingTestFiles.join(",")}`);
  }
  if (Number(evidence?.test_file_count || 0) !== testFiles.length) {
    errors.push(`${prefix}_declared_test_file_count_mismatch:${evidence?.test_file_count ?? "missing"}:${testFiles.length}`);
  }
  return errors;
}

export async function verifyDojoDockerIntegrationEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoDockerIntegrationEvidenceForMilestone(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "docker_integration",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    service_count: Number(evidence?.required_service_count || 0),
    endpoint_count: Number(evidence?.endpoint_count || 0),
  };
}

export function validateDojoDockerIntegrationEvidenceForMilestone(evidence) {
  const errors = [];
  const requiredServices = Array.isArray(evidence?.required_services)
    ? evidence.required_services.map(String)
    : [];
  const runningServices = Array.isArray(evidence?.running_services)
    ? evidence.running_services.map(String)
    : [];
  const healthyServicesRequired = Array.isArray(evidence?.healthy_services_required)
    ? evidence.healthy_services_required.map(String)
    : [];
  const endpointChecks = Array.isArray(evidence?.endpoint_checks) ? evidence.endpoint_checks : [];
  if (evidence?.schema_version !== "synthi.dojo.dockerIntegrationEvidence.v1") {
    errors.push(`docker_integration_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("docker_integration_not_ok");
  if (evidence?.docker_compose_up_ran !== true) errors.push("docker_integration_compose_up_not_run");
  if (evidence?.docker_compose_up_skipped === true) errors.push("docker_integration_compose_up_skipped");
  if (evidence?.command_evaluation?.compose_up_exit_code !== 0) {
    errors.push(`docker_integration_compose_up_exit_code:${evidence?.command_evaluation?.compose_up_exit_code ?? "missing"}`);
  }
  if (evidence?.command_evaluation?.compose_ps_exit_code !== 0) {
    errors.push(`docker_integration_compose_ps_exit_code:${evidence?.command_evaluation?.compose_ps_exit_code ?? "missing"}`);
  }
  if (evidence?.command_evaluation?.compose_config_exit_code !== 0) {
    errors.push(`docker_integration_compose_config_exit_code:${evidence?.command_evaluation?.compose_config_exit_code ?? "missing"}`);
  }
  if (Number(evidence?.required_service_count || 0) <= 0) errors.push("docker_integration_no_required_services");
  const missingRequiredServices = DOJO_DOCKER_REQUIRED_SERVICES
    .filter((service) => !requiredServices.includes(service));
  if (missingRequiredServices.length > 0) {
    errors.push(`docker_integration_required_services_missing:${missingRequiredServices.join(",")}`);
  }
  const requiredServicesNotRunning = DOJO_DOCKER_REQUIRED_SERVICES
    .filter((service) => !runningServices.includes(service));
  if (requiredServicesNotRunning.length > 0) {
    errors.push(`docker_integration_required_services_not_running:${requiredServicesNotRunning.join(",")}`);
  }
  if (Number(evidence?.required_service_count || 0) !== requiredServices.length) {
    errors.push(`docker_integration_required_service_count_mismatch:${evidence?.required_service_count ?? "missing"}:${requiredServices.length}`);
  }
  if (Array.isArray(evidence?.missing_services) && evidence.missing_services.length > 0) {
    errors.push(`docker_integration_missing_services:${evidence.missing_services.join(",")}`);
  }
  if (Array.isArray(evidence?.service_evaluation?.stopped_services) && evidence.service_evaluation.stopped_services.length > 0) {
    errors.push(`docker_integration_stopped_services:${evidence.service_evaluation.stopped_services.join(",")}`);
  }
  if (Array.isArray(evidence?.unhealthy_services) && evidence.unhealthy_services.length > 0) {
    errors.push(`docker_integration_unhealthy_services:${evidence.unhealthy_services.join(",")}`);
  }
  const missingHealthyServiceRequirements = DOJO_DOCKER_HEALTHY_SERVICES
    .filter((service) => !healthyServicesRequired.includes(service));
  if (missingHealthyServiceRequirements.length > 0) {
    errors.push(`docker_integration_required_healthy_services_missing:${missingHealthyServiceRequirements.join(",")}`);
  }
  if (Number(evidence?.running_services?.length || 0) !== Number(evidence?.required_service_count || 0)) {
    errors.push(`docker_integration_running_service_count_mismatch:${evidence?.running_services?.length ?? "missing"}:${evidence?.required_service_count ?? "missing"}`);
  }
  if (Number(evidence?.endpoint_count || 0) <= 0) errors.push("docker_integration_no_endpoint_checks");
  if (Number(evidence?.endpoint_count || 0) !== endpointChecks.length) {
    errors.push(`docker_integration_endpoint_reported_count_mismatch:${evidence?.endpoint_count ?? "missing"}:${endpointChecks.length}`);
  }
  if (Number(evidence?.endpoint_ok_count || 0) !== Number(evidence?.endpoint_count || 0)) {
    errors.push(`docker_integration_endpoint_count_mismatch:${evidence?.endpoint_ok_count ?? "missing"}:${evidence?.endpoint_count ?? "missing"}`);
  }
  const endpointIds = new Set(endpointChecks.map((check) => String(check?.id || "")));
  const missingEndpointChecks = DOJO_DOCKER_REQUIRED_ENDPOINTS
    .filter((endpoint) => !endpointIds.has(endpoint.id));
  if (missingEndpointChecks.length > 0) {
    errors.push(`docker_integration_required_endpoints_missing:${missingEndpointChecks.map((endpoint) => endpoint.id).join(",")}`);
  }
  for (const endpoint of DOJO_DOCKER_REQUIRED_ENDPOINTS) {
    const check = endpointChecks.find((item) => item?.id === endpoint.id);
    if (check && Number(check.expected_status) !== Number(endpoint.expected_status)) {
      errors.push(`docker_integration_endpoint_expected_status_mismatch:${endpoint.id}:${check.expected_status ?? "missing"}:${endpoint.expected_status}`);
    }
  }
  for (const check of endpointChecks) {
    if (check?.ok !== true) {
      errors.push(`docker_integration_endpoint_failed:${check?.id || "unknown"}:${check?.status ?? check?.error ?? "unknown"}`);
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("docker_integration_budget_not_ok");
  if (Array.isArray(evidence?.budget_evaluation?.failed_checks) && evidence.budget_evaluation.failed_checks.length > 0) {
    errors.push(`docker_integration_failed_checks:${evidence.budget_evaluation.failed_checks.join(",")}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoAffordanceCodemodEvidenceArtifact({ reportPath, evidencePath, releaseCandidate = false }) {
  const { artifact: report, evidence, digest } = await readDigestCheckedJsonPair({
    id: "dojo_affordance_codemod_self_check",
    artifactPath: reportPath,
    evidencePath,
    evidenceSchema: "synthi.dojo.affordanceCodemodEvidence.v1",
    digestField: "report_sha256",
    bytesField: "report_bytes",
    pathField: "report_path",
  });
  const errors = [
    ...digest.errors,
    ...validateDojoAffordanceCodemodEvidenceForRelease(report, evidence).errors,
  ];
  return {
    id: "dojo_affordance_codemod_self_check",
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: report?.schema_version ?? null,
    evidence_schema_version: evidence?.schema_version ?? null,
    operation_count: Array.isArray(evidence?.operation_ids) ? evidence.operation_ids.length : 0,
  };
}

export async function verifyDojoSourceDriftEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoSourceDriftEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_source_drift_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoSourceDriftEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.sourceDriftEvidence.v1") {
    errors.push(`source_drift_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("source_drift_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`source_drift_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("source_drift_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`source_drift_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_SOURCE_DRIFT_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`source_drift_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_SOURCE_DRIFT_TEST_FILES,
    prefix: "source_drift",
  }));
  const untestedRequiredCapabilities = DOJO_SOURCE_DRIFT_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`source_drift_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`source_drift_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`source_drift_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.source_drift_contract || {};
  for (const [field, errorCode] of [
    ["release_scoped_snapshot_required", "source_drift_release_scope_requirement_missing"],
    ["signed_snapshot_verification_required", "source_drift_signature_requirement_missing"],
    ["source_content_hash_required", "source_drift_content_hash_requirement_missing"],
    ["changed_token_expiry_required", "source_drift_changed_token_expiry_requirement_missing"],
    ["removed_token_expiry_required", "source_drift_removed_token_expiry_requirement_missing"],
    ["added_risky_affordance_review_required", "source_drift_risky_affordance_review_requirement_missing"],
    ["unrelated_token_no_expiry_required", "source_drift_unrelated_no_expiry_requirement_missing"],
    ["tamper_rejection_required", "source_drift_tamper_rejection_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("source_drift_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`source_drift_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`source_drift_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("source_drift_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`source_drift_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoApiToolCompilerEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoApiToolCompilerEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_api_tool_compiler_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoApiToolCompilerEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.apiToolCompilerEvidence.v1") {
    errors.push(`api_tool_compiler_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("api_tool_compiler_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`api_tool_compiler_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("api_tool_compiler_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`api_tool_compiler_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_API_TOOL_COMPILER_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`api_tool_compiler_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_API_TOOL_COMPILER_TEST_FILES,
    prefix: "api_tool_compiler",
  }));
  const untestedRequiredCapabilities = DOJO_API_TOOL_COMPILER_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`api_tool_compiler_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`api_tool_compiler_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`api_tool_compiler_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const promotionContract = evidence?.promotion_contract || {};
  for (const [field, errorCode] of [
    ["reviewed_candidate_required", "api_tool_compiler_reviewed_candidate_requirement_missing"],
    ["proof_capsule_required", "api_tool_compiler_proof_requirement_missing"],
    ["license_kernel_required", "api_tool_compiler_license_requirement_missing"],
    ["idempotency_required", "api_tool_compiler_idempotency_requirement_missing"],
    ["auth_scope_required", "api_tool_compiler_auth_scope_requirement_missing"],
    ["strict_input_schema_required", "api_tool_compiler_strict_schema_requirement_missing"],
    ["postcondition_required", "api_tool_compiler_postcondition_requirement_missing"],
    ["evidence_write_required", "api_tool_compiler_evidence_requirement_missing"],
    ["graph_proof_match_required", "api_tool_compiler_graph_proof_requirement_missing"],
  ]) {
    if (promotionContract[field] !== true) errors.push(errorCode);
  }
  if (promotionContract.production_candidate_only_execution_allowed !== false) {
    errors.push("api_tool_compiler_candidate_only_production_allowed");
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("api_tool_compiler_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`api_tool_compiler_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`api_tool_compiler_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("api_tool_compiler_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`api_tool_compiler_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoGeneratedPrEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoGeneratedPrEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_generated_pr_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoGeneratedPrEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.generatedPrEvidence.v1") {
    errors.push(`generated_pr_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("generated_pr_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`generated_pr_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("generated_pr_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`generated_pr_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_GENERATED_PR_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`generated_pr_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_GENERATED_PR_TEST_FILES,
    prefix: "generated_pr",
  }));
  const untestedRequiredCapabilities = DOJO_GENERATED_PR_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`generated_pr_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`generated_pr_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`generated_pr_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.generated_pr_contract || {};
  for (const [field, errorCode] of [
    ["reviewable_metadata_required", "generated_pr_reviewable_metadata_requirement_missing"],
    ["caller_supplied_code_owner_rules_required", "generated_pr_code_owner_requirement_missing"],
    ["proof_impact_required", "generated_pr_proof_impact_requirement_missing"],
    ["code_owner_glob_matching_required", "generated_pr_code_owner_glob_requirement_missing"],
    ["unsafe_branch_rejection_required", "generated_pr_unsafe_branch_requirement_missing"],
    ["branch_plan_required", "generated_pr_branch_plan_requirement_missing"],
    ["promotion_blocker_required", "generated_pr_promotion_blocker_requirement_missing"],
    ["source_patch_bundle_required", "generated_pr_source_patch_bundle_requirement_missing"],
    ["missing_source_rejection_required", "generated_pr_missing_source_requirement_missing"],
    ["generated_contract_tests_required", "generated_pr_contract_tests_requirement_missing"],
    ["patch_writer_required", "generated_pr_patch_writer_requirement_missing"],
    ["path_traversal_rejection_required", "generated_pr_path_traversal_requirement_missing"],
    ["duplicate_output_rejection_required", "generated_pr_duplicate_output_requirement_missing"],
    ["dry_run_required", "generated_pr_dry_run_requirement_missing"],
    ["stale_source_rejection_required", "generated_pr_stale_source_requirement_missing"],
    ["idempotent_write_required", "generated_pr_idempotent_write_requirement_missing"],
    ["branch_applier_required", "generated_pr_branch_applier_requirement_missing"],
    ["file_hash_verification_required", "generated_pr_file_hash_requirement_missing"],
    ["unresolved_blocker_rejection_required", "generated_pr_unresolved_blocker_requirement_missing"],
    ["git_branch_creation_required", "generated_pr_git_branch_requirement_missing"],
    ["dirty_worktree_rejection_required", "generated_pr_dirty_worktree_requirement_missing"],
    ["existing_branch_rejection_required", "generated_pr_existing_branch_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("generated_pr_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`generated_pr_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`generated_pr_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("generated_pr_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`generated_pr_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateDojoAffordanceCodemodEvidenceForRelease(report, evidence) {
  const errors = [];
  if (report?.schema_version !== "synthi.dojo.affordanceCodemodSelfCheck.v1") {
    errors.push(`affordance_codemod_report_schema_mismatch:${report?.schema_version || "missing"}`);
  }
  if (evidence?.schema_version !== "synthi.dojo.affordanceCodemodEvidence.v1") {
    errors.push(`affordance_codemod_evidence_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.before_failed !== true) errors.push("affordance_codemod_before_did_not_fail");
  if (evidence?.target_aware_contract !== true) errors.push("affordance_codemod_wrong_target_not_rejected");
  if (evidence?.after_passed !== true) errors.push("affordance_codemod_after_did_not_pass");
  if (evidence?.patch_bundle_ok !== true) errors.push("affordance_codemod_patch_bundle_not_ok");
  if (Number(evidence?.patch_bundle_modified_file_count || 0) <= 0) errors.push("affordance_codemod_no_modified_files");
  if (Number(evidence?.patch_bundle_generated_test_count || 0) <= 0) errors.push("affordance_codemod_no_generated_tests");
  if (evidence?.patch_write_ok !== true) errors.push("affordance_codemod_patch_write_not_ok");
  if (Number(evidence?.patch_write_file_count || 0) < 2) errors.push("affordance_codemod_patch_write_file_count_low");
  if (evidence?.generated_pr_branch_plan_ready !== true) errors.push("affordance_codemod_generated_pr_branch_plan_not_ready");
  if (Number(evidence?.generated_pr_branch_plan_file_count || 0) < 2) errors.push("affordance_codemod_generated_pr_branch_plan_file_count_low");
  if (evidence?.generated_pr_stale_apply_rejected !== true) errors.push("affordance_codemod_stale_source_not_rejected");
  if (evidence?.generated_pr_branch_apply_ok !== true) errors.push("affordance_codemod_branch_apply_not_ok");
  if (Number(evidence?.generated_pr_branch_apply_file_count || 0) < 2) errors.push("affordance_codemod_branch_apply_file_count_low");
  if (evidence?.generated_pr_git_branch_ok !== true) errors.push("affordance_codemod_git_branch_not_ok");
  if (Number(evidence?.generated_pr_git_branch_applied_file_count || 0) < 2) errors.push("affordance_codemod_git_branch_file_count_low");
  if (evidence?.git_branch_generated_test_passed !== true) errors.push("affordance_codemod_git_branch_test_not_passed");
  if (Number(evidence?.generated_pr_review_gate_count || 0) < 1) errors.push("affordance_codemod_review_gate_count_low");
  if (!Array.isArray(evidence?.operation_ids) || evidence.operation_ids.length < 2) errors.push("affordance_codemod_operation_ids_missing");
  if (typeof evidence?.generated_test_path !== "string" || evidence.generated_test_path.length === 0) errors.push("affordance_codemod_generated_test_path_missing");
  if (typeof evidence?.patched_source_path !== "string" || evidence.patched_source_path.length === 0) errors.push("affordance_codemod_patched_source_path_missing");
  const targetMatchers = Array.isArray(evidence?.target_matchers) ? evidence.target_matchers : [];
  if (!targetMatchers.some((matcher) => matcher?.target_match && typeof matcher.target_match === "object")) {
    errors.push("affordance_codemod_target_matchers_missing");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoWorkflowPipelineE2EArtifact({ summaryPath, releaseCandidate = false }) {
  const summary = await readJsonFile(summaryPath);
  const errors = validateDojoWorkflowPipelineE2EForRelease(summary).errors;
  errors.push(...await validateWorkflowE2EVisualArtifacts({ summary, summaryPath }));
  return {
    id: "workflow_e2e_hosted",
    ok: errors.length === 0,
    errors,
    artifact_path: summaryPath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: summary?.schema_version ?? null,
    result_count: Array.isArray(summary?.results) ? summary.results.length : 0,
  };
}

export function validateDojoWorkflowPipelineE2EForRelease(summary) {
  const errors = [];
  if (summary?.schema_version !== "synthi.dojo.workflowPipelineE2E.v1") {
    errors.push(`workflow_e2e_schema_mismatch:${summary?.schema_version || "missing"}`);
  }
  if (summary?.ok !== true) errors.push("workflow_e2e_not_ok");
  if (Number(summary?.case_count || 0) <= 0) errors.push("workflow_e2e_no_cases");
  const results = Array.isArray(summary?.results) ? summary.results : [];
  if (results.length === 0) errors.push("workflow_e2e_no_results");
  for (const result of results) {
    if (result?.ok !== true) {
      errors.push(`workflow_e2e_failed_result:${result?.caseId || "unknown"}:${result?.name || "unknown"}`);
    }
  }
  if (summary?.hosted_runtime?.cdp_url_configured !== true) errors.push("workflow_e2e_hosted_cdp_missing");
  if (summary?.hosted_runtime?.non_loopback_runtime !== true) {
    errors.push(`workflow_e2e_runtime_not_remote:${summary?.hosted_runtime?.runtime_host_class || "missing"}`);
  }
  if (summary?.fresh_mcp?.verify_fresh_mcp !== true) errors.push("workflow_e2e_fresh_mcp_not_enabled");
  if (summary?.fresh_mcp?.private_workflow_store_env_configured !== true) {
    errors.push("workflow_e2e_fresh_mcp_store_missing");
  }
  if (Number(summary?.visual_artifact_count || 0) <= 0) errors.push("workflow_e2e_no_visual_artifacts");
  if (!Array.isArray(summary?.visual_artifacts) || summary.visual_artifacts.length === 0) {
    errors.push("workflow_e2e_visual_artifacts_missing");
  }
  for (const required of [
    "export avoids forwarded port literals",
    "run exported Playwright",
    "fresh MCP attach hosted browser",
    "fresh MCP call discovered private tool",
  ]) {
    if (!hasPassingResult(results, required)) errors.push(`workflow_e2e_missing_result:${required}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

async function validateWorkflowE2EVisualArtifacts({ summary, summaryPath }) {
  const errors = [];
  const artifacts = Array.isArray(summary?.visual_artifacts) ? summary.visual_artifacts : [];
  if (artifacts.length === 0) return errors;
  if (Number(summary?.visual_artifact_count || 0) !== artifacts.length) {
    errors.push(`workflow_e2e_visual_artifact_count_mismatch:${summary?.visual_artifact_count ?? "missing"}:${artifacts.length}`);
  }
  for (const [index, artifact] of artifacts.entries()) {
    const label = artifact?.stage || artifact?.path || `visual_artifact_${index}`;
    const artifactPath = resolveEvidenceArtifactPath(artifact?.path, summaryPath);
    if (!artifactPath) {
      errors.push(`workflow_e2e_visual_artifact_path_missing:${label}`);
      continue;
    }
    try {
      const info = await stat(artifactPath);
      if (!info.isFile()) errors.push(`workflow_e2e_visual_artifact_not_file:${label}:${artifactPath}`);
      if (info.size <= 0) errors.push(`workflow_e2e_visual_artifact_empty:${label}:${artifactPath}`);
      const expectedBytes = Number(artifact?.bytes);
      if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
        errors.push(`workflow_e2e_visual_artifact_bytes_missing:${label}`);
      } else if (expectedBytes !== info.size) {
        errors.push(`workflow_e2e_visual_artifact_bytes_mismatch:${label}:${expectedBytes}:${info.size}`);
      }
      const bytes = await readFile(artifactPath);
      if (!isPngBytes(bytes)) errors.push(`workflow_e2e_visual_artifact_not_png:${label}:${artifactPath}`);
      if (artifact?.png_verified !== true) errors.push(`workflow_e2e_visual_artifact_png_not_verified:${label}`);
      const actualSha256 = sha256(bytes);
      if (!artifact?.screenshot_sha256) {
        errors.push(`workflow_e2e_visual_artifact_sha256_missing:${label}`);
      } else if (String(artifact.screenshot_sha256) !== actualSha256) {
        errors.push(`workflow_e2e_visual_artifact_sha256_mismatch:${label}:${artifact.screenshot_sha256}:${actualSha256}`);
      }
    } catch {
      errors.push(`workflow_e2e_visual_artifact_missing:${label}:${artifactPath}`);
    }
  }
  return errors;
}

export async function verifyDojoPrivateToolStdioAcceptanceArtifact({ transcriptPath, releaseCandidate = false }) {
  const transcript = await readJsonFile(transcriptPath);
  const errors = validateDojoPrivateToolStdioAcceptanceForRelease(transcript).errors;
  errors.push(...await validateTranscriptVisualStepArtifact({
    id: "private_tool_stdio_acceptance",
    transcript,
    transcriptPath,
  }));
  return {
    id: "private_tool_stdio_acceptance",
    ok: errors.length === 0,
    errors,
    artifact_path: transcriptPath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: transcript?.schema_version ?? null,
    result_count: Array.isArray(transcript?.steps) ? transcript.steps.length : 0,
  };
}

export async function verifyDojoPrivateToolStdioHostConformanceArtifact({ transcriptPath, releaseCandidate = false }) {
  const transcript = await readJsonFile(transcriptPath);
  const errors = validateDojoPrivateToolStdioHostConformanceForRelease(transcript).errors;
  errors.push(...await validateTranscriptVisualStepArtifact({
    id: "private_tool_stdio_host_conformance",
    transcript,
    transcriptPath,
  }));
  return {
    id: "private_tool_stdio_host_conformance",
    ok: errors.length === 0,
    errors,
    artifact_path: transcriptPath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: transcript?.schema_version ?? null,
    result_count: Array.isArray(transcript?.steps) ? transcript.steps.length : 0,
  };
}

export function validateDojoPrivateToolStdioAcceptanceForRelease(transcript) {
  const errors = validateCommonPrivateToolAcceptanceTranscript(transcript, {
    schemaVersion: "synthi.dojo.privateToolStdioAcceptance.v1",
    errorPrefix: "private_tool_stdio",
  });
  for (const required of [
    "production-style deployment readiness through MCP",
    "discover private MCP tool",
    "strict host schema validation before execution",
    "discover private workflow registry through MCP",
    "lookup manifest through MCP",
    "attach hosted workspace browser through MCP",
    "grant exact-origin consent",
    "open target page",
    "call discovered private MCP tool",
    "visual proof snapshot",
  ]) {
    if (!hasPassingStep(transcript, required)) errors.push(`private_tool_stdio_missing_step:${required}`);
  }
  const strictStep = findPassingStep(transcript, "strict host schema validation before execution");
  if (strictStep) {
    if (strictStep.accepted_configured_call !== true) errors.push("private_tool_stdio_strict_schema_configured_call_rejected");
    const rejected = Array.isArray(strictStep.rejected) ? strictStep.rejected : [];
    if (rejected.length < 2 || rejected.some((item) => !Array.isArray(item?.errors) || item.errors.length === 0)) {
      errors.push("private_tool_stdio_strict_schema_rejections_missing");
    }
  }
  const attachStep = findPassingStep(transcript, "attach hosted workspace browser through MCP");
  if (attachStep) {
    if (attachStep.evidence?.hosted_attach !== true) errors.push("private_tool_stdio_hosted_attach_missing");
    if (attachStep.evidence?.local_attach !== false) errors.push("private_tool_stdio_local_attach_used");
  }
  const callStep = findPassingStep(transcript, "call discovered private MCP tool");
  if (callStep) {
    const stepsRun = Number(callStep.result?.replay?.steps_run);
    const expectedSteps = Number(transcript?.acceptance?.expected_steps_min || 0);
    if (!Number.isFinite(stepsRun) || stepsRun < expectedSteps) {
      errors.push(`private_tool_stdio_steps_run_below_expected:${stepsRun}:${expectedSteps}`);
    }
    if (typeof callStep.result?.private_tool?.tool_name !== "string") {
      errors.push("private_tool_stdio_private_tool_name_missing");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateDojoPrivateToolStdioHostConformanceForRelease(transcript) {
  const errors = [
    ...validateDojoPrivateToolStdioAcceptanceForRelease(transcript).errors,
    ...validateDeployedPrivateToolHostConformance(transcript, {
      errorPrefix: "private_tool_stdio_host",
      requireCustomMcpCommand: true,
    }),
  ];
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoPrivateToolCodexAcceptanceArtifact({ transcriptPath, releaseCandidate = false }) {
  const transcript = await readJsonFile(transcriptPath);
  const errors = validateDojoPrivateToolCodexAcceptanceForRelease(transcript).errors;
  errors.push(...await validateTranscriptVisualStepArtifact({
    id: "private_tool_codex_acceptance",
    transcript,
    transcriptPath,
  }));
  return {
    id: "private_tool_codex_acceptance",
    ok: errors.length === 0,
    errors,
    artifact_path: transcriptPath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: transcript?.schema_version ?? null,
    result_count: Array.isArray(transcript?.steps) ? transcript.steps.length : 0,
  };
}

export async function verifyDojoPrivateToolCodexHostConformanceArtifact({ transcriptPath, releaseCandidate = false }) {
  const transcript = await readJsonFile(transcriptPath);
  const errors = validateDojoPrivateToolCodexHostConformanceForRelease(transcript).errors;
  errors.push(...await validateTranscriptVisualStepArtifact({
    id: "private_tool_codex_host_conformance",
    transcript,
    transcriptPath,
  }));
  return {
    id: "private_tool_codex_host_conformance",
    ok: errors.length === 0,
    errors,
    artifact_path: transcriptPath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: transcript?.schema_version ?? null,
    result_count: Array.isArray(transcript?.steps) ? transcript.steps.length : 0,
  };
}

export function validateDojoPrivateToolCodexAcceptanceForRelease(transcript) {
  const errors = validateCommonPrivateToolAcceptanceTranscript(transcript, {
    schemaVersion: "synthi.dojo.privateToolCodexAcceptance.v1",
    errorPrefix: "private_tool_codex",
  });
  for (const required of [
    "codex discovered and called private MCP tool",
    "visual proof snapshot",
  ]) {
    if (!hasPassingStep(transcript, required)) errors.push(`private_tool_codex_missing_step:${required}`);
  }
  const evidence = transcript?.codex?.mcp_evidence;
  if (transcript?.codex?.exit_code !== 0) errors.push(`private_tool_codex_exit_code:${transcript?.codex?.exit_code ?? "missing"}`);
  if (transcript?.codex?.saw_private_tool_name !== true) errors.push("private_tool_codex_did_not_see_private_tool");
  if (evidence?.hosted_attach_call !== true) errors.push("private_tool_codex_hosted_attach_missing");
  if (evidence?.local_attach_call !== false) errors.push("private_tool_codex_local_attach_used");
  if (evidence?.private_tool_call !== true) errors.push("private_tool_codex_private_tool_call_missing");
  if (evidence?.private_tool_result_ok !== true) errors.push("private_tool_codex_private_tool_result_not_ok");
  if (evidence?.consent_call !== true) errors.push("private_tool_codex_consent_missing");
  if (evidence?.open_call !== true) errors.push("private_tool_codex_open_missing");
  if (Number(evidence?.command_execution_count || 0) !== 0) {
    errors.push(`private_tool_codex_shell_commands_used:${evidence?.command_execution_count}`);
  }
  const stepsRun = Number(evidence?.private_tool_steps_run);
  const expectedSteps = Number(transcript?.acceptance?.expected_steps_min || 0);
  if (!Number.isFinite(stepsRun) || stepsRun < expectedSteps) {
    errors.push(`private_tool_codex_steps_run_below_expected:${stepsRun}:${expectedSteps}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateDojoPrivateToolCodexHostConformanceForRelease(transcript) {
  const errors = [
    ...validateDojoPrivateToolCodexAcceptanceForRelease(transcript).errors,
    ...validateDeployedPrivateToolHostConformance(transcript, {
      errorPrefix: "private_tool_codex_host",
      requireCustomMcpCommand: false,
    }),
  ];
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoMcpHostConformanceArtifacts({ reportPath, evidencePath, releaseCandidate = false }) {
  const { artifact: report, evidence, digest } = await readDigestCheckedJsonPair({
    id: "dojo_mcp_host_conformance",
    artifactPath: reportPath,
    evidencePath,
    evidenceSchema: "synthi.dojo.mcpHostConformanceEvidence.v1",
    digestField: "report_sha256",
    bytesField: "report_bytes",
    pathField: "report_path",
  });
  const errors = [...digest.errors];
  if (evidence.gate_ok !== true) errors.push("conformance_evidence_gate_not_ok");
  if (Number(evidence.gate_failed || 0) !== 0) errors.push(`conformance_evidence_gate_failed:${evidence.gate_failed}`);
  if (releaseCandidate) {
    errors.push(...validateDojoMcpHostConformanceReportForRelease(report).errors);
  }
  return {
    id: "dojo_mcp_host_conformance",
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: report?.schema_version ?? null,
  };
}

export function validateDojoMcpHostConformanceReportForRelease(report) {
  const errors = [];
  if (report?.schema_version !== "synthi.dojo.mcpHostConformance.v1") {
    errors.push(`conformance_schema_not_release:${report?.schema_version || "missing"}`);
  }
  if (String(report?.schema_version || "").includes("selfCheck")) {
    errors.push("conformance_self_check_schema_not_release_evidence");
  }
  if (report?.conformance?.ok !== true) errors.push("conformance_host_not_ok");
  if (report?.conformance?.mcp_host_class !== "remote") {
    errors.push(`conformance_host_not_remote:${report?.conformance?.mcp_host_class || "missing"}`);
  }
  if (report?.conformance?.non_loopback_mcp_host !== true) errors.push("conformance_non_loopback_host_missing");
  if (report?.config?.execute_production !== true) errors.push("conformance_execute_production_missing");
  if (report?.config?.raw_backing_tool_required === false) errors.push("conformance_raw_backing_tool_check_skipped");
  if (report?.release_gate?.ok !== true) errors.push("conformance_release_gate_not_ok");
  if (Number(report?.release_gate?.failed || 0) !== 0) {
    errors.push(`conformance_release_gate_failed:${report.release_gate.failed}`);
  }
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const productionRun = steps.find((step) => step?.name === "execute proof-gated Dojo skill" && step.ok === true);
  if (!productionRun || productionRun.dry_run === true) errors.push("conformance_production_execution_step_missing");
  const rawBlocked = steps.find((step) => step?.name === "raw backing tool blocked outside Dojo proof path" && step.ok === true);
  if (!rawBlocked) errors.push("conformance_raw_backing_tool_block_step_missing");
  const revokedValidationBlocked = steps.find((step) => step?.name === "revoked proof validation blocked" && step.ok === true);
  if (!revokedValidationBlocked) errors.push("conformance_revoked_validation_block_step_missing");
  const revokedRunBlocked = steps.find((step) => step?.name === "revoked proof run blocked" && step.ok === true);
  if (!revokedRunBlocked) errors.push("conformance_revoked_run_block_step_missing");
  const deploymentClaims = report?.deployment_claims && typeof report.deployment_claims === "object"
    ? report.deployment_claims
    : {};
  for (const requirement of DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS) {
    if (deploymentClaims[requirement.requiredField] !== true) {
      errors.push(`conformance_${requirement.id}_requirement_missing`);
    }
    if (deploymentClaims[requirement.observedField] !== true) {
      errors.push(`conformance_${requirement.id}_missing`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoManagedKeySigningEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoManagedKeySigningEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_managed_key_signing_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoManagedKeySigningEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.managedKeySigningEvidence.v1") {
    errors.push(`managed_key_signing_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("managed_key_signing_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`managed_key_signing_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("managed_key_signing_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`managed_key_signing_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`managed_key_signing_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
    prefix: "managed_key_signing",
  }));
  const untestedRequiredCapabilities = DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`managed_key_signing_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`managed_key_signing_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`managed_key_signing_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const signingContract = evidence?.signing_contract || {};
  if (signingContract.provider !== "managed-key-service") {
    errors.push(`managed_key_signing_provider_mismatch:${signingContract.provider || "missing"}`);
  }
  if (signingContract.algorithm !== "ed25519") {
    errors.push(`managed_key_signing_algorithm_mismatch:${signingContract.algorithm || "missing"}`);
  }
  if (signingContract.request_schema_version !== "synthi.dojo.managedKeySignerRequest.v1") {
    errors.push(`managed_key_signing_request_schema_mismatch:${signingContract.request_schema_version || "missing"}`);
  }
  if (signingContract.response_schema_version !== "synthi.dojo.managedKeySignerResponse.v1") {
    errors.push(`managed_key_signing_response_schema_mismatch:${signingContract.response_schema_version || "missing"}`);
  }
  if (signingContract.key_custody !== "managed") {
    errors.push(`managed_key_signing_custody_mismatch:${signingContract.key_custody || "missing"}`);
  }
  if (signingContract.production_private_key_material_allowed !== false) {
    errors.push("managed_key_signing_private_material_allowed");
  }
  if (signingContract.public_verifier_material_required !== true) {
    errors.push("managed_key_signing_public_verifier_requirement_missing");
  }
  const requiredResponseFields = new Set(Array.isArray(signingContract.required_response_fields)
    ? signingContract.required_response_fields.map(String)
    : []);
  for (const field of ["schema_version", "algorithm", "key_id", "key_uri", "key_custody", "signature"]) {
    if (!requiredResponseFields.has(field)) errors.push(`managed_key_signing_response_field_missing:${field}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("managed_key_signing_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`managed_key_signing_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`managed_key_signing_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("managed_key_signing_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`managed_key_signing_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoGovernanceLifecycleEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoGovernanceLifecycleEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_governance_lifecycle_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoGovernanceLifecycleEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.governanceLifecycleEvidence.v1") {
    errors.push(`governance_lifecycle_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("governance_lifecycle_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`governance_lifecycle_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("governance_lifecycle_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`governance_lifecycle_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`governance_lifecycle_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
    prefix: "governance_lifecycle",
  }));
  const untestedRequiredCapabilities = DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`governance_lifecycle_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`governance_lifecycle_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`governance_lifecycle_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.governance_contract || {};
  for (const [field, errorCode] of [
    ["license_health_required", "governance_lifecycle_license_health_requirement_missing"],
    ["approval_queue_required", "governance_lifecycle_approval_queue_requirement_missing"],
    ["approval_decision_audit_required", "governance_lifecycle_approval_audit_requirement_missing"],
    ["case_law_review_required", "governance_lifecycle_case_law_review_requirement_missing"],
    ["license_revocation_required", "governance_lifecycle_license_revocation_requirement_missing"],
    ["recertification_queue_required", "governance_lifecycle_recertification_requirement_missing"],
    ["policy_gates_required", "governance_lifecycle_policy_gates_requirement_missing"],
    ["audit_export_required", "governance_lifecycle_audit_export_requirement_missing"],
    ["compliance_pack_required", "governance_lifecycle_compliance_pack_requirement_missing"],
    ["proof_public_verification_custody_required", "governance_lifecycle_public_verification_requirement_missing"],
    ["malformed_expiry_fails_closed_required", "governance_lifecycle_malformed_expiry_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("governance_lifecycle_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`governance_lifecycle_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`governance_lifecycle_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("governance_lifecycle_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`governance_lifecycle_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoGraphRuntimeEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoGraphRuntimeEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_graph_runtime_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoGraphRuntimeEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.graphRuntimeEvidence.v1") {
    errors.push(`graph_runtime_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("graph_runtime_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`graph_runtime_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("graph_runtime_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`graph_runtime_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_GRAPH_RUNTIME_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`graph_runtime_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_GRAPH_RUNTIME_TEST_FILES,
    prefix: "graph_runtime",
  }));
  const untestedRequiredCapabilities = DOJO_GRAPH_RUNTIME_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`graph_runtime_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`graph_runtime_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`graph_runtime_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.graph_runtime_contract || {};
  for (const [field, errorCode] of [
    ["graph_ir_validation_required", "graph_runtime_ir_validation_requirement_missing"],
    ["graph_compiler_required", "graph_runtime_compiler_requirement_missing"],
    ["source_api_binding_required", "graph_runtime_source_api_requirement_missing"],
    ["production_execution_required", "graph_runtime_production_execution_requirement_missing"],
    ["edge_order_required", "graph_runtime_edge_order_requirement_missing"],
    ["evidence_events_required", "graph_runtime_evidence_events_requirement_missing"],
    ["ledger_backed_evidence_required", "graph_runtime_ledger_evidence_requirement_missing"],
    ["preconditions_required", "graph_runtime_precondition_requirement_missing"],
    ["proof_gate_required", "graph_runtime_proof_gate_requirement_missing"],
    ["substrate_executor_required", "graph_runtime_substrate_requirement_missing"],
    ["expiry_required", "graph_runtime_expiry_requirement_missing"],
    ["branch_runtime_required", "graph_runtime_branch_requirement_missing"],
    ["retry_runtime_required", "graph_runtime_retry_requirement_missing"],
    ["case_law_runtime_required", "graph_runtime_case_law_requirement_missing"],
    ["rollback_runtime_required", "graph_runtime_rollback_requirement_missing"],
    ["human_resume_required", "graph_runtime_human_resume_requirement_missing"],
    ["validation_fail_closed_required", "graph_runtime_validation_fail_closed_requirement_missing"],
    ["predicate_dsl_required", "graph_runtime_predicate_dsl_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("graph_runtime_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`graph_runtime_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`graph_runtime_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("graph_runtime_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`graph_runtime_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoVivariumRuntimeEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoVivariumRuntimeEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_vivarium_runtime_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoVivariumRuntimeEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.vivariumRuntimeEvidence.v1") {
    errors.push(`vivarium_runtime_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("vivarium_runtime_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`vivarium_runtime_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("vivarium_runtime_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`vivarium_runtime_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_VIVARIUM_RUNTIME_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`vivarium_runtime_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_VIVARIUM_RUNTIME_TEST_FILES,
    prefix: "vivarium_runtime",
  }));
  const untestedRequiredCapabilities = DOJO_VIVARIUM_RUNTIME_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`vivarium_runtime_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`vivarium_runtime_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`vivarium_runtime_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.vivarium_contract || {};
  for (const [field, errorCode] of [
    ["scenario_dsl_required", "vivarium_runtime_scenario_dsl_requirement_missing"],
    ["synthetic_fixture_materialization_required", "vivarium_runtime_fixture_requirement_missing"],
    ["synthetic_only_policy_required", "vivarium_runtime_synthetic_policy_requirement_missing"],
    ["oracle_required", "vivarium_runtime_oracle_requirement_missing"],
    ["ledger_ready_oracle_evidence_required", "vivarium_runtime_oracle_evidence_requirement_missing"],
    ["api_fault_server_required", "vivarium_runtime_api_fault_requirement_missing"],
    ["fake_success_state_detection_required", "vivarium_runtime_fake_success_requirement_missing"],
    ["partial_write_detection_required", "vivarium_runtime_partial_write_requirement_missing"],
    ["prompt_injection_quarantine_required", "vivarium_runtime_prompt_injection_requirement_missing"],
    ["deterministic_reset_required", "vivarium_runtime_reset_requirement_missing"],
    ["budget_enforcement_required", "vivarium_runtime_budget_requirement_missing"],
    ["targeted_graph_execution_required", "vivarium_runtime_targeted_graph_requirement_missing"],
    ["executable_checkride_required", "vivarium_runtime_checkride_requirement_missing"],
    ["license_constraints_from_blocked_risk_required", "vivarium_runtime_license_constraint_requirement_missing"],
    ["critical_guardrail_failure_required", "vivarium_runtime_critical_guardrail_requirement_missing"],
    ["substrate_hook_passthrough_required", "vivarium_runtime_substrate_hook_requirement_missing"],
    ["evil_twin_attack_measurement_required", "vivarium_runtime_evil_twin_measurement_requirement_missing"],
    ["evil_twin_hardening_loop_required", "vivarium_runtime_evil_twin_hardening_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("vivarium_runtime_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`vivarium_runtime_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`vivarium_runtime_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("vivarium_runtime_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`vivarium_runtime_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoCaseLawRuntimeEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoCaseLawRuntimeEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_case_law_runtime_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoCaseLawRuntimeEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.caseLawRuntimeEvidence.v1") {
    errors.push(`case_law_runtime_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("case_law_runtime_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`case_law_runtime_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("case_law_runtime_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`case_law_runtime_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_CASE_LAW_RUNTIME_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`case_law_runtime_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_CASE_LAW_RUNTIME_TEST_FILES,
    prefix: "case_law_runtime",
  }));
  const untestedRequiredCapabilities = DOJO_CASE_LAW_RUNTIME_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`case_law_runtime_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`case_law_runtime_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`case_law_runtime_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.case_law_contract || {};
  for (const [field, errorCode] of [
    ["case_law_registry_required", "case_law_runtime_registry_requirement_missing"],
    ["reviewed_evidence_required", "case_law_runtime_reviewed_evidence_requirement_missing"],
    ["proposed_cases_nonbinding_required", "case_law_runtime_proposed_nonbinding_requirement_missing"],
    ["approved_binding_scope_required", "case_law_runtime_binding_scope_requirement_missing"],
    ["deprecated_cases_excluded_required", "case_law_runtime_deprecated_exclusion_requirement_missing"],
    ["guardrail_synthesis_required", "case_law_runtime_guardrail_synthesis_requirement_missing"],
    ["explicit_predicate_preservation_required", "case_law_runtime_explicit_predicate_requirement_missing"],
    ["graph_binding_required", "case_law_runtime_graph_binding_requirement_missing"],
    ["runtime_guardrail_block_required", "case_law_runtime_runtime_block_requirement_missing"],
    ["refusal_case_citation_required", "case_law_runtime_refusal_citation_requirement_missing"],
    ["inactive_case_suppression_required", "case_law_runtime_inactive_suppression_requirement_missing"],
    ["antibody_matching_required", "case_law_runtime_antibody_matching_requirement_missing"],
    ["antibody_proposed_only_required", "case_law_runtime_antibody_proposed_only_requirement_missing"],
    ["antibody_private_data_redaction_required", "case_law_runtime_antibody_private_data_requirement_missing"],
    ["local_practice_required", "case_law_runtime_local_practice_requirement_missing"],
    ["local_checkride_required", "case_law_runtime_local_checkride_requirement_missing"],
    ["deterministic_antibody_ids_required", "case_law_runtime_deterministic_antibody_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("case_law_runtime_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`case_law_runtime_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`case_law_runtime_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("case_law_runtime_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`case_law_runtime_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoHostedRuntimeGatewayEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoHostedRuntimeGatewayEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_hosted_runtime_gateway_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoHostedRuntimeGatewayEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.hostedRuntimeGatewayEvidence.v1") {
    errors.push(`hosted_runtime_gateway_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("hosted_runtime_gateway_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`hosted_runtime_gateway_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("hosted_runtime_gateway_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`hosted_runtime_gateway_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`hosted_runtime_gateway_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
    prefix: "hosted_runtime_gateway",
  }));
  const untestedRequiredCapabilities = DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`hosted_runtime_gateway_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`hosted_runtime_gateway_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`hosted_runtime_gateway_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.hosted_runtime_contract || {};
  for (const [field, errorCode] of [
    ["tenant_scoped_sessions_required", "hosted_runtime_gateway_tenant_scope_requirement_missing"],
    ["short_lived_credentials_required", "hosted_runtime_gateway_short_lived_credentials_requirement_missing"],
    ["stored_secret_redaction_required", "hosted_runtime_gateway_secret_redaction_requirement_missing"],
    ["origin_allowlist_required", "hosted_runtime_gateway_origin_allowlist_requirement_missing"],
    ["local_network_policy_required", "hosted_runtime_gateway_local_network_policy_requirement_missing"],
    ["screenshot_redaction_required", "hosted_runtime_gateway_screenshot_redaction_requirement_missing"],
    ["skill_run_binding_required", "hosted_runtime_gateway_skill_run_binding_requirement_missing"],
    ["audit_events_required", "hosted_runtime_gateway_audit_requirement_missing"],
    ["evidence_write_required", "hosted_runtime_gateway_evidence_requirement_missing"],
    ["fail_closed_on_missing_evidence_writer_required", "hosted_runtime_gateway_fail_closed_evidence_requirement_missing"],
    ["revocation_and_expiry_required", "hosted_runtime_gateway_revocation_expiry_requirement_missing"],
    ["durable_store_production_requirement_required", "hosted_runtime_gateway_durable_store_requirement_missing"],
    ["postgres_session_store_required", "hosted_runtime_gateway_postgres_store_requirement_missing"],
    ["malformed_record_rejection_required", "hosted_runtime_gateway_malformed_record_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("hosted_runtime_gateway_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`hosted_runtime_gateway_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`hosted_runtime_gateway_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("hosted_runtime_gateway_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`hosted_runtime_gateway_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoSecurityAbuseEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoSecurityAbuseEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "security_abuse_suite",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoSecurityAbuseEvidenceForRelease(evidence) {
  const errors = [];
  const configuredClasses = Array.isArray(evidence?.configured_abuse_classes)
    ? evidence.configured_abuse_classes.map(String)
    : [];
  const testedClasses = Array.isArray(evidence?.tested_abuse_classes)
    ? evidence.tested_abuse_classes.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.securityAbuseEvidence.v1") {
    errors.push(`security_abuse_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("security_abuse_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`security_abuse_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.abuse_class_coverage_complete !== true) errors.push("security_abuse_coverage_incomplete");
  if (Array.isArray(evidence?.missing_abuse_classes) && evidence.missing_abuse_classes.length > 0) {
    errors.push(`security_abuse_missing_classes:${evidence.missing_abuse_classes.join(",")}`);
  }
  const missingConfiguredClasses = DOJO_SECURITY_ABUSE_CLASSES.filter((abuseClass) => !configuredClasses.includes(abuseClass));
  if (missingConfiguredClasses.length > 0) {
    errors.push(`security_abuse_required_classes_missing:${missingConfiguredClasses.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
    prefix: "security_abuse",
  }));
  const untestedRequiredClasses = DOJO_SECURITY_ABUSE_CLASSES.filter((abuseClass) => !testedClasses.includes(abuseClass));
  if (untestedRequiredClasses.length > 0) {
    errors.push(`security_abuse_required_classes_untested:${untestedRequiredClasses.join(",")}`);
  }
  if (Number(evidence?.configured_abuse_class_count || 0) !== configuredClasses.length) {
    errors.push(`security_abuse_configured_class_count_mismatch:${evidence?.configured_abuse_class_count ?? "missing"}:${configuredClasses.length}`);
  }
  if (Number(evidence?.abuse_class_count || 0) !== testedClasses.length) {
    errors.push(`security_abuse_tested_class_count_mismatch:${evidence?.abuse_class_count ?? "missing"}:${testedClasses.length}`);
  }
  if (Number(evidence?.test_file_count || 0) !== Number(evidence?.reported_test_file_count || 0)) {
    errors.push(`security_abuse_test_file_count_mismatch:${evidence?.test_file_count ?? "missing"}:${evidence?.reported_test_file_count ?? "missing"}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("security_abuse_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`security_abuse_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`security_abuse_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("security_abuse_no_reported_tests");
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoComplianceExportEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoComplianceExportEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "compliance_export_suite",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    result_count: Number(evidence?.test_summary?.total_tests || 0),
  };
}

export function validateDojoComplianceExportEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.complianceExportEvidence.v1") {
    errors.push(`compliance_export_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("compliance_export_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`compliance_export_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("compliance_export_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`compliance_export_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_COMPLIANCE_EXPORT_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`compliance_export_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
    prefix: "compliance_export",
  }));
  const untestedRequiredCapabilities = DOJO_COMPLIANCE_EXPORT_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`compliance_export_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`compliance_export_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`compliance_export_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("compliance_export_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`compliance_export_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`compliance_export_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("compliance_export_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`compliance_export_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoPrivacyRedactionEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoPrivacyRedactionEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "privacy_redaction_suite",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    result_count: Number(evidence?.test_summary?.total_tests || 0),
  };
}

export function validateDojoPrivacyRedactionEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.privacyRedactionEvidence.v1") {
    errors.push(`privacy_redaction_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("privacy_redaction_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`privacy_redaction_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("privacy_redaction_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`privacy_redaction_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_PRIVACY_REDACTION_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`privacy_redaction_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_PRIVACY_REDACTION_TEST_FILES,
    prefix: "privacy_redaction",
  }));
  const untestedRequiredCapabilities = DOJO_PRIVACY_REDACTION_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`privacy_redaction_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`privacy_redaction_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`privacy_redaction_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("privacy_redaction_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`privacy_redaction_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`privacy_redaction_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("privacy_redaction_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`privacy_redaction_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoChaosPerformanceEvidenceArtifact({ evidencePath, enterpriseRelease = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoChaosPerformanceEvidenceForEnterprise(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_chaos_performance_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    enterprise_release: Boolean(enterpriseRelease),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoChaosPerformanceEvidenceForEnterprise(evidence) {
  const errors = [];
  const configuredScenarios = Array.isArray(evidence?.configured_chaos_scenarios)
    ? evidence.configured_chaos_scenarios.map(String)
    : [];
  const testedScenarios = Array.isArray(evidence?.tested_chaos_scenarios)
    ? evidence.tested_chaos_scenarios.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.chaosPerformanceEvidence.v1") {
    errors.push(`chaos_performance_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("chaos_performance_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`chaos_performance_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.scenario_coverage_complete !== true) errors.push("chaos_performance_scenario_coverage_incomplete");
  if (Array.isArray(evidence?.missing_chaos_scenarios) && evidence.missing_chaos_scenarios.length > 0) {
    errors.push(`chaos_performance_missing_scenarios:${evidence.missing_chaos_scenarios.join(",")}`);
  }
  const missingConfiguredScenarios = DOJO_CHAOS_SCENARIOS
    .filter((scenario) => !configuredScenarios.includes(scenario));
  if (missingConfiguredScenarios.length > 0) {
    errors.push(`chaos_performance_required_scenarios_missing:${missingConfiguredScenarios.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
    prefix: "chaos_performance",
  }));
  const untestedRequiredScenarios = DOJO_CHAOS_SCENARIOS
    .filter((scenario) => !testedScenarios.includes(scenario));
  if (untestedRequiredScenarios.length > 0) {
    errors.push(`chaos_performance_required_scenarios_untested:${untestedRequiredScenarios.join(",")}`);
  }
  if (Number(evidence?.configured_scenario_count || 0) !== configuredScenarios.length) {
    errors.push(`chaos_performance_configured_scenario_count_mismatch:${evidence?.configured_scenario_count ?? "missing"}:${configuredScenarios.length}`);
  }
  if (Number(evidence?.scenario_count || 0) !== testedScenarios.length) {
    errors.push(`chaos_performance_tested_scenario_count_mismatch:${evidence?.scenario_count ?? "missing"}:${testedScenarios.length}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("chaos_performance_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`chaos_performance_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`chaos_performance_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("chaos_performance_no_reported_tests");
  if (!Number.isFinite(Number(evidence?.performance_metrics?.test_case_duration_p95_ms))) {
    errors.push("chaos_performance_missing_test_case_p95");
  }
  if (!Number.isFinite(Number(evidence?.performance_metrics?.test_file_duration_p95_ms))) {
    errors.push("chaos_performance_missing_test_file_p95");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoSoakPerformanceArtifacts({
  summaryPath,
  eventsPath,
  enterpriseRelease = false,
  minDurationSeconds,
}) {
  const summary = await readJsonFile(summaryPath);
  const eventsText = await readFile(eventsPath, "utf8");
  const events = parseNdjson(eventsText);
  const errors = validateDojoSoakPerformanceSummary(summary, {
    events,
    enterpriseRelease,
    minDurationSeconds,
  }).errors;
  return {
    id: "soak_performance",
    ok: errors.length === 0,
    errors,
    artifact_path: summaryPath,
    evidence_path: eventsPath,
    enterprise_release: Boolean(enterpriseRelease),
    result_count: events.length,
  };
}

export function validateDojoSoakPerformanceSummary(summary, {
  events = [],
  enterpriseRelease = false,
  minDurationSeconds,
} = {}) {
  const errors = [];
  const durationSeconds = Number(summary?.duration_s);
  const requiredDurationSeconds = Number.isFinite(Number(minDurationSeconds))
    ? Number(minDurationSeconds)
    : enterpriseRelease ? 3600 : 0;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    errors.push("soak_duration_missing");
  } else if (durationSeconds < requiredDurationSeconds) {
    errors.push(`soak_duration_below_required:${durationSeconds}:${requiredDurationSeconds}`);
  }
  const iterations = Number(summary?.iterations);
  if (!Number.isInteger(iterations) || iterations <= 0) errors.push("soak_iterations_missing");
  if (Number(summary?.errors || 0) !== 0) errors.push(`soak_errors_nonzero:${summary?.errors}`);
  if (!Array.isArray(events) || events.length === 0) {
    errors.push("soak_events_missing");
  } else if (Number.isInteger(iterations) && events.length < iterations) {
    errors.push(`soak_event_count_below_iterations:${events.length}:${iterations}`);
  }
  if (events.some((event) => event.parse_error)) errors.push("soak_events_parse_error");

  const perTool = summary?.per_tool && typeof summary.per_tool === "object" ? summary.per_tool : {};
  for (const toolName of ["screenshot", "locate", "wait"]) {
    const tool = perTool[toolName];
    if (!tool || typeof tool !== "object") {
      errors.push(`soak_tool_missing:${toolName}`);
      continue;
    }
    if (Number(tool.count || 0) <= 0) errors.push(`soak_tool_count_missing:${toolName}`);
    if (Number(tool.errors || 0) !== 0) errors.push(`soak_tool_errors_nonzero:${toolName}:${tool.errors}`);
    if (!Number.isFinite(Number(tool.p95))) errors.push(`soak_tool_p95_missing:${toolName}`);
  }
  errors.push(...validateSoakMemoryMetrics(summary?.memory));
  errors.push(...validateSoakUsageCounterMetrics(summary?.usage_counters));
  errors.push(...validateSoakRuntimeResourceMetrics(summary?.runtime_resources));
  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateCommonPrivateToolAcceptanceTranscript(transcript, {
  schemaVersion,
  errorPrefix,
}) {
  const errors = [];
  if (transcript?.schema_version !== schemaVersion) {
    errors.push(`${errorPrefix}_schema_mismatch:${transcript?.schema_version || "missing"}`);
  }
  if (transcript?.ok !== true) errors.push(`${errorPrefix}_not_ok`);
  if (transcript?.product_path !== "agent_client_to_synthi_mcp_to_broker_to_hosted_browser") {
    errors.push(`${errorPrefix}_product_path_mismatch:${transcript?.product_path || "missing"}`);
  }
  if (transcript?.conformance?.non_loopback_runtime !== true) {
    errors.push(`${errorPrefix}_runtime_not_remote:${transcript?.conformance?.runtime_host_class || "missing"}`);
  }
  const steps = Array.isArray(transcript?.steps) ? transcript.steps : [];
  if (steps.length === 0) errors.push(`${errorPrefix}_steps_missing`);
  for (const step of steps) {
    if (step?.ok !== true) errors.push(`${errorPrefix}_failed_step:${step?.name || "unknown"}`);
  }
  return errors;
}

function validateDeployedPrivateToolHostConformance(transcript, {
  errorPrefix,
  requireCustomMcpCommand = false,
}) {
  const errors = [];
  const conformance = transcript?.conformance || {};
  if (conformance.require_non_loopback_runtime !== true) {
    errors.push(`${errorPrefix}_non_loopback_requirement_missing`);
  }
  if (conformance.non_loopback_runtime !== true) {
    errors.push(`${errorPrefix}_runtime_not_remote:${conformance.runtime_host_class || "missing"}`);
  }
  if (conformance.require_external_private_tool_store !== true) {
    errors.push(`${errorPrefix}_external_store_requirement_missing`);
  }
  if (conformance.external_private_tool_store !== true || transcript?.private_tool_store?.external !== true) {
    errors.push(`${errorPrefix}_external_store_missing`);
  }
  if (classifyUrlHost(transcript?.target_url) !== "remote") {
    errors.push(`${errorPrefix}_target_not_remote:${classifyUrlHost(transcript?.target_url)}`);
  }
  if (requireCustomMcpCommand) {
    if (conformance.require_custom_mcp_command !== true) {
      errors.push(`${errorPrefix}_custom_mcp_requirement_missing`);
    }
    if (conformance.custom_mcp_command !== true || transcript?.mcp_server?.default_repo_dist === true) {
      errors.push(`${errorPrefix}_custom_mcp_command_missing`);
    }
  }
  return errors;
}

async function validateTranscriptVisualStepArtifact({ id, transcript, transcriptPath }) {
  const errors = [];
  const step = findPassingStep(transcript, "visual proof snapshot");
  if (!step) {
    errors.push(`${id}_visual_step_missing`);
    return errors;
  }
  const screenshotPath = resolveEvidenceArtifactPath(step.screenshot_path, transcriptPath);
  if (!screenshotPath) {
    errors.push(`${id}_visual_screenshot_path_missing`);
    return errors;
  }
  try {
    const info = await stat(screenshotPath);
    if (!info.isFile()) errors.push(`${id}_visual_screenshot_not_file:${screenshotPath}`);
    if (info.size <= 0) errors.push(`${id}_visual_screenshot_empty:${screenshotPath}`);
    const bytes = await readFile(screenshotPath);
    if (!isPngBytes(bytes)) errors.push(`${id}_visual_screenshot_not_png:${screenshotPath}`);
    const expectedBytes = Number(step.screenshot_bytes);
    if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
      errors.push(`${id}_visual_screenshot_bytes_missing`);
    } else if (expectedBytes !== info.size) {
      errors.push(`${id}_visual_screenshot_bytes_mismatch:${expectedBytes}:${info.size}`);
    }
    const actualSha256 = sha256(bytes);
    if (!step.screenshot_sha256) {
      errors.push(`${id}_visual_screenshot_sha256_missing`);
    } else if (String(step.screenshot_sha256) !== actualSha256) {
      errors.push(`${id}_visual_screenshot_sha256_mismatch:${step.screenshot_sha256}:${actualSha256}`);
    }
  } catch {
    errors.push(`${id}_visual_screenshot_missing:${screenshotPath}`);
  }
  return errors;
}

function classifyUrlHost(value) {
  let host = "";
  try {
    host = new URL(String(value || "")).hostname;
  } catch {
    return "invalid";
  }
  const normalized = host.toLowerCase();
  if (!normalized) return "invalid";
  if (normalized === "localhost" || normalized.startsWith("127.") || normalized === "::1" || normalized === "[::1]") {
    return "loopback";
  }
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "local-bind";
  }
  return "remote";
}

function hasPassingResult(results, name) {
  return (Array.isArray(results) ? results : []).some((result) => result?.name === name && result.ok === true);
}

function hasPassingStep(transcript, name) {
  return Boolean(findPassingStep(transcript, name));
}

function findPassingStep(transcript, name) {
  return (Array.isArray(transcript?.steps) ? transcript.steps : []).find((step) => step?.name === name && step.ok === true);
}

function validateSoakMemoryMetrics(memory) {
  const errors = [];
  if (!memory || typeof memory !== "object") return ["soak_memory_metrics_missing"];
  if (!Number.isInteger(Number(memory.sample_count)) || Number(memory.sample_count) <= 0) {
    errors.push("soak_memory_sample_count_missing");
  }
  for (const field of ["rss_start_bytes", "rss_end_bytes", "rss_max_bytes", "rss_growth_bytes"]) {
    if (!Number.isFinite(Number(memory[field]))) errors.push(`soak_memory_metric_missing:${field}`);
  }
  const start = Number(memory.rss_start_bytes);
  const end = Number(memory.rss_end_bytes);
  const max = Number(memory.rss_max_bytes);
  if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(max) && max < Math.max(start, end)) {
    errors.push("soak_memory_rss_max_below_endpoint");
  }
  return errors;
}

function validateSoakUsageCounterMetrics(usageCounters) {
  const errors = [];
  if (!usageCounters || typeof usageCounters !== "object") return ["soak_usage_counters_missing"];
  if (!Number.isInteger(Number(usageCounters.sample_count)) || Number(usageCounters.sample_count) <= 0) {
    errors.push("soak_usage_counter_samples_missing");
  }
  if (!usageCounters.delta || typeof usageCounters.delta !== "object") {
    errors.push("soak_usage_counter_delta_missing");
  }
  if (!Array.isArray(usageCounters.counter_names)) {
    errors.push("soak_usage_counter_names_missing");
  }
  return errors;
}

function validateSoakRuntimeResourceMetrics(runtimeResources) {
  const errors = [];
  if (!runtimeResources || typeof runtimeResources !== "object") return ["soak_runtime_resource_metrics_missing"];
  if (!Number.isInteger(Number(runtimeResources.sample_count)) || Number(runtimeResources.sample_count) <= 0) {
    errors.push("soak_runtime_resource_samples_missing");
  }
  if (runtimeResources.post_detach_observed !== true) {
    errors.push("soak_runtime_resource_post_detach_missing");
  }
  for (const field of [
    "active_session_count_end",
    "active_frame_sink_count_end",
    "browser_session_leak_count",
    "frame_sink_leak_count",
  ]) {
    if (!Number.isFinite(Number(runtimeResources[field]))) {
      errors.push(`soak_runtime_resource_metric_missing:${field}`);
    }
  }
  if (Number(runtimeResources.browser_session_leak_count) !== 0) {
    errors.push(`soak_browser_session_leak_count_nonzero:${runtimeResources.browser_session_leak_count}`);
  }
  if (Number(runtimeResources.frame_sink_leak_count) !== 0) {
    errors.push(`soak_frame_sink_leak_count_nonzero:${runtimeResources.frame_sink_leak_count}`);
  }
  return errors;
}

async function validateVisualScreenshotArtifacts(report) {
  const errors = [];
  const resultPaths = new Set();
  for (const [index, result] of (Array.isArray(report?.results) ? report.results : []).entries()) {
    const label = result.route_id || result.name || String(index);
    const screenshotPath = result.screenshot_path ? path.resolve(result.screenshot_path) : "";
    if (!screenshotPath) {
      errors.push(`visual_result_missing_screenshot_path:${label}`);
      continue;
    }
    resultPaths.add(screenshotPath);
    try {
      const info = await stat(screenshotPath);
      if (!info.isFile()) {
        errors.push(`visual_result_screenshot_not_file:${label}`);
      }
      if (Number(result.bytes) !== info.size) {
        errors.push(`visual_result_screenshot_bytes_mismatch:${label}:${result.bytes}:${info.size}`);
      }
      const screenshotBytes = await readFile(screenshotPath);
      const actualSha256 = sha256(screenshotBytes);
      if (!result.screenshot_sha256) {
        errors.push(`visual_result_screenshot_sha256_missing:${label}`);
      } else if (String(result.screenshot_sha256) !== actualSha256) {
        errors.push(`visual_result_screenshot_sha256_mismatch:${label}:${result.screenshot_sha256}:${actualSha256}`);
      }
    } catch {
      errors.push(`visual_result_screenshot_missing:${label}:${screenshotPath}`);
    }
  }
  for (const item of Array.isArray(report?.screenshots) ? report.screenshots : []) {
    const screenshotPath = path.resolve(String(item));
    if (!resultPaths.has(screenshotPath)) {
      errors.push(`visual_top_level_screenshot_without_result:${screenshotPath}`);
    }
  }
  return errors;
}

async function validateDigestReferencedLogArtifacts(evidence, evidencePath) {
  const errors = [];
  errors.push(...await validateDigestReferencedFile({
    label: "json_report",
    filePath: evidence?.json_report_path,
    expectedSha256: evidence?.json_report_sha256,
    expectedBytes: evidence?.json_report_bytes,
    evidencePath,
  }));
  errors.push(...await validateDigestReferencedFile({
    label: "stdout",
    filePath: evidence?.stdout_path,
    expectedSha256: evidence?.stdout_sha256,
    expectedBytes: evidence?.stdout_bytes,
    evidencePath,
  }));
  errors.push(...await validateDigestReferencedFile({
    label: "stderr",
    filePath: evidence?.stderr_path,
    expectedSha256: evidence?.stderr_sha256,
    expectedBytes: evidence?.stderr_bytes,
    evidencePath,
  }));
  return errors;
}

async function validateDigestReferencedFile({
  label,
  filePath,
  expectedSha256,
  expectedBytes,
  evidencePath,
}) {
  const errors = [];
  if (!filePath) return [`${label}_path_missing`];
  const resolved = resolveEvidenceArtifactPath(filePath, evidencePath);
  let bytes;
  try {
    bytes = await readFile(resolved);
  } catch {
    return [`${label}_missing:${resolved}`];
  }
  const actualSha256 = sha256(bytes);
  if (expectedSha256 !== actualSha256) {
    errors.push(`${label}_sha256_mismatch:${expectedSha256 || "missing"}:${actualSha256}`);
  }
  if (Number(expectedBytes) !== bytes.length) {
    errors.push(`${label}_bytes_mismatch:${expectedBytes}:${bytes.length}`);
  }
  return errors;
}

async function readDigestCheckedJsonPair({
  id,
  artifactPath,
  evidencePath,
  evidenceSchema,
  digestField,
  bytesField,
  pathField,
}) {
  const artifactText = await readFile(artifactPath, "utf8");
  const evidenceText = await readFile(evidencePath, "utf8");
  const artifact = JSON.parse(artifactText);
  const evidence = JSON.parse(evidenceText);
  const errors = [];
  if (evidence.schema_version !== evidenceSchema) {
    errors.push(`evidence_schema_mismatch:${evidence.schema_version || "missing"}:${evidenceSchema}`);
  }
  const expectedDigest = sha256(artifactText);
  if (evidence[digestField] !== expectedDigest) {
    errors.push(`${digestField}_mismatch:${evidence[digestField] || "missing"}:${expectedDigest}`);
  }
  const expectedBytes = Buffer.byteLength(artifactText);
  if (Number(evidence[bytesField]) !== expectedBytes) {
    errors.push(`${bytesField}_mismatch:${evidence[bytesField]}:${expectedBytes}`);
  }
  if (evidence[pathField] && path.resolve(evidence[pathField]) !== path.resolve(artifactPath)) {
    errors.push(`${pathField}_mismatch:${evidence[pathField]}:${artifactPath}`);
  }
  return {
    artifact,
    evidence,
    digest: {
      id,
      ok: errors.length === 0,
      errors,
    },
  };
}

async function runSelfCheck({ outDir }) {
  const manifestArtifacts = await runReleaseGateManifestSelfCheck({
    outDir: path.join(outDir, "release-gates"),
  });
  const manifestResult = await verifyDojoReleaseGateManifestArtifacts({
    manifestPath: manifestArtifacts.manifest_path,
    evidencePath: manifestArtifacts.evidence_path,
  });
  assert.equal(manifestResult.ok, true, manifestResult.errors.join(";"));

  const proofSelfCheckDir = path.join(outDir, "proof-self-check");
  await mkdir(proofSelfCheckDir, { recursive: true });
  const proofSelfCheckArtifacts = await writeProofSelfCheckArtifactsForSelfCheck({ outDir: proofSelfCheckDir });
  const proofSelfCheckResult = await verifyDojoProofSelfCheckArtifacts({
    summaryPath: proofSelfCheckArtifacts.summary_path,
  });
  assert.equal(proofSelfCheckResult.ok, true, proofSelfCheckResult.errors.join(";"));
  const rejectedProofSelfCheckArtifacts = await writeProofSelfCheckArtifactsForSelfCheck({
    outDir: proofSelfCheckDir,
    basename: "dojo-proof-self-check-rejected",
    summaryOverrides: {
      production_proof_consumed: false,
      production_proof_replay_blocked: false,
    },
    productionEvidenceOverrides: {
      proof_consumed: false,
      replay_blocked: false,
    },
  });
  const rejectedProofSelfCheck = await verifyDojoProofSelfCheckArtifacts({
    summaryPath: rejectedProofSelfCheckArtifacts.summary_path,
  });
  assert(rejectedProofSelfCheck.errors.includes("dojo_self_check_production_proof_not_consumed"));
  assert(rejectedProofSelfCheck.errors.includes("dojo_self_check_evidence_proof_not_consumed"));

  const postgresDir = path.join(outDir, "postgres-control-plane");
  await mkdir(postgresDir, { recursive: true });
  const postgresArtifacts = await writePostgresControlPlaneEvidenceForSelfCheck({ outDir: postgresDir });
  const postgresControlPlaneResult = await verifyDojoPostgresControlPlaneEvidenceArtifact({
    evidencePath: postgresArtifacts.evidence_path,
  });
  assert.equal(postgresControlPlaneResult.ok, true, postgresControlPlaneResult.errors.join(";"));
  const rejectedPostgresArtifacts = await writePostgresControlPlaneEvidenceForSelfCheck({
    outDir: postgresDir,
    basename: "dojo-postgres-control-plane-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["atomic_proof_consume"],
      budget_evaluation: { ok: false },
    },
  });
  const rejectedPostgres = await verifyDojoPostgresControlPlaneEvidenceArtifact({
    evidencePath: rejectedPostgresArtifacts.evidence_path,
  });
  assert(rejectedPostgres.errors.includes("postgres_control_plane_capability_coverage_incomplete"));
  assert(rejectedPostgres.errors.includes("postgres_control_plane_missing_capabilities:atomic_proof_consume"));

  const dockerDir = path.join(outDir, "docker-integration");
  await mkdir(dockerDir, { recursive: true });
  const dockerArtifacts = await writeDockerIntegrationEvidenceForSelfCheck({ outDir: dockerDir });
  const dockerIntegrationResult = await verifyDojoDockerIntegrationEvidenceArtifact({
    evidencePath: dockerArtifacts.evidence_path,
  });
  assert.equal(dockerIntegrationResult.ok, true, dockerIntegrationResult.errors.join(";"));
  const rejectedDockerArtifacts = await writeDockerIntegrationEvidenceForSelfCheck({
    outDir: dockerDir,
    basename: "dojo-docker-integration-rejected",
    overrides: {
      ok: false,
      docker_compose_up_ran: false,
      docker_compose_up_skipped: true,
      missing_services: ["mcp"],
      running_services: ["frontend"],
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
        failed_checks: ["compose_up_ran_or_explicitly_skipped", "all_required_services_present"],
      },
    },
  });
  const rejectedDocker = await verifyDojoDockerIntegrationEvidenceArtifact({
    evidencePath: rejectedDockerArtifacts.evidence_path,
  });
  assert(rejectedDocker.errors.includes("docker_integration_compose_up_not_run"));
  assert(rejectedDocker.errors.includes("docker_integration_missing_services:mcp"));
  assert(rejectedDocker.errors.includes("docker_integration_endpoint_count_mismatch:1:2"));

  const affordanceDir = path.join(outDir, "affordance-codemod");
  await mkdir(affordanceDir, { recursive: true });
  const affordanceArtifacts = await writeAffordanceCodemodArtifactsForSelfCheck({ outDir: affordanceDir });
  const affordanceCodemodResult = await verifyDojoAffordanceCodemodEvidenceArtifact({
    reportPath: affordanceArtifacts.report_path,
    evidencePath: affordanceArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(affordanceCodemodResult.ok, true, affordanceCodemodResult.errors.join(";"));
  const rejectedAffordanceArtifacts = await writeAffordanceCodemodArtifactsForSelfCheck({
    outDir: affordanceDir,
    basename: "dojo-affordance-codemod-self-check-rejected",
    reportOverrides: {
      before_contract: { ok: true },
      before_vitest: { ok: true },
    },
  });
  const rejectedAffordanceCodemod = await verifyDojoAffordanceCodemodEvidenceArtifact({
    reportPath: rejectedAffordanceArtifacts.report_path,
    evidencePath: rejectedAffordanceArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedAffordanceCodemod.errors.includes("affordance_codemod_before_did_not_fail"));

  const sourceDriftDir = path.join(outDir, "source-drift");
  await mkdir(sourceDriftDir, { recursive: true });
  const sourceDriftArtifacts = await writeSourceDriftEvidenceForSelfCheck({ outDir: sourceDriftDir });
  const sourceDriftResult = await verifyDojoSourceDriftEvidenceArtifact({
    evidencePath: sourceDriftArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(sourceDriftResult.ok, true, sourceDriftResult.errors.join(";"));
  const rejectedSourceDriftArtifacts = await writeSourceDriftEvidenceForSelfCheck({
    outDir: sourceDriftDir,
    basename: "dojo-source-drift-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["source_drift_rejects_unverified_snapshots"],
      source_drift_contract: {
        ...sourceDriftArtifacts.evidence.source_drift_contract,
        changed_token_expiry_required: false,
        tamper_rejection_required: false,
      },
    },
  });
  const rejectedSourceDrift = await verifyDojoSourceDriftEvidenceArtifact({
    evidencePath: rejectedSourceDriftArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedSourceDrift.errors.includes("source_drift_coverage_incomplete"));
  assert(rejectedSourceDrift.errors.includes("source_drift_missing_capabilities:source_drift_rejects_unverified_snapshots"));
  assert(rejectedSourceDrift.errors.includes("source_drift_changed_token_expiry_requirement_missing"));
  assert(rejectedSourceDrift.errors.includes("source_drift_tamper_rejection_requirement_missing"));

  const apiToolCompilerDir = path.join(outDir, "api-tool-compiler");
  await mkdir(apiToolCompilerDir, { recursive: true });
  const apiToolCompilerArtifacts = await writeApiToolCompilerEvidenceForSelfCheck({ outDir: apiToolCompilerDir });
  const apiToolCompilerResult = await verifyDojoApiToolCompilerEvidenceArtifact({
    evidencePath: apiToolCompilerArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(apiToolCompilerResult.ok, true, apiToolCompilerResult.errors.join(";"));
  const rejectedApiToolCompilerArtifacts = await writeApiToolCompilerEvidenceForSelfCheck({
    outDir: apiToolCompilerDir,
    basename: "dojo-api-tool-compiler-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["api_tool_executes_with_idempotency_postcondition_and_evidence"],
      promotion_contract: {
        ...apiToolCompilerArtifacts.evidence.promotion_contract,
        proof_capsule_required: false,
        production_candidate_only_execution_allowed: true,
      },
    },
  });
  const rejectedApiToolCompiler = await verifyDojoApiToolCompilerEvidenceArtifact({
    evidencePath: rejectedApiToolCompilerArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedApiToolCompiler.errors.includes("api_tool_compiler_coverage_incomplete"));
  assert(rejectedApiToolCompiler.errors.includes("api_tool_compiler_missing_capabilities:api_tool_executes_with_idempotency_postcondition_and_evidence"));
  assert(rejectedApiToolCompiler.errors.includes("api_tool_compiler_proof_requirement_missing"));
  assert(rejectedApiToolCompiler.errors.includes("api_tool_compiler_candidate_only_production_allowed"));

  const generatedPrDir = path.join(outDir, "generated-pr");
  await mkdir(generatedPrDir, { recursive: true });
  const generatedPrArtifacts = await writeGeneratedPrEvidenceForSelfCheck({ outDir: generatedPrDir });
  const generatedPrResult = await verifyDojoGeneratedPrEvidenceArtifact({
    evidencePath: generatedPrArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(generatedPrResult.ok, true, generatedPrResult.errors.join(";"));
  const rejectedGeneratedPrArtifacts = await writeGeneratedPrEvidenceForSelfCheck({
    outDir: generatedPrDir,
    basename: "dojo-generated-pr-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["generated_pr_git_branch_creates_branch_and_tests"],
      generated_pr_contract: {
        ...generatedPrArtifacts.evidence.generated_pr_contract,
        git_branch_creation_required: false,
        generated_contract_tests_required: false,
      },
    },
  });
  const rejectedGeneratedPr = await verifyDojoGeneratedPrEvidenceArtifact({
    evidencePath: rejectedGeneratedPrArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedGeneratedPr.errors.includes("generated_pr_coverage_incomplete"));
  assert(rejectedGeneratedPr.errors.includes("generated_pr_missing_capabilities:generated_pr_git_branch_creates_branch_and_tests"));
  assert(rejectedGeneratedPr.errors.includes("generated_pr_git_branch_requirement_missing"));
  assert(rejectedGeneratedPr.errors.includes("generated_pr_contract_tests_requirement_missing"));

  const liveHostedDir = path.join(outDir, "live-hosted-runtime");
  await mkdir(liveHostedDir, { recursive: true });
  const liveHostedArtifacts = await writeLiveHostedRuntimeArtifactsForSelfCheck({ outDir: liveHostedDir });
  const workflowE2EResult = await verifyDojoWorkflowPipelineE2EArtifact({
    summaryPath: liveHostedArtifacts.workflow_summary_path,
    releaseCandidate: true,
  });
  assert.equal(workflowE2EResult.ok, true, workflowE2EResult.errors.join(";"));
  const stdioAcceptanceResult = await verifyDojoPrivateToolStdioAcceptanceArtifact({
    transcriptPath: liveHostedArtifacts.stdio_transcript_path,
    releaseCandidate: true,
  });
  assert.equal(stdioAcceptanceResult.ok, true, stdioAcceptanceResult.errors.join(";"));
  const codexAcceptanceResult = await verifyDojoPrivateToolCodexAcceptanceArtifact({
    transcriptPath: liveHostedArtifacts.codex_transcript_path,
    releaseCandidate: true,
  });
  assert.equal(codexAcceptanceResult.ok, true, codexAcceptanceResult.errors.join(";"));
  const rejectedCodexTranscriptPath = await writeCodexAcceptanceTranscriptForSelfCheck({
    outDir: liveHostedDir,
    basename: "codex-private-tool-acceptance-rejected",
    overrides: {
      codex: {
        ...buildCodexAcceptanceTranscriptForSelfCheck().codex,
        mcp_evidence: {
          ...buildCodexAcceptanceTranscriptForSelfCheck().codex.mcp_evidence,
          local_attach_call: true,
          command_execution_count: 1,
        },
      },
    },
  });
  const rejectedCodexAcceptance = await verifyDojoPrivateToolCodexAcceptanceArtifact({
    transcriptPath: rejectedCodexTranscriptPath,
    releaseCandidate: true,
  });
  assert(rejectedCodexAcceptance.errors.includes("private_tool_codex_local_attach_used"));
  assert(rejectedCodexAcceptance.errors.includes("private_tool_codex_shell_commands_used:1"));

  const conformanceDir = path.join(outDir, "conformance");
  await mkdir(conformanceDir, { recursive: true });
  const releaseReport = buildReleaseCandidateConformanceReport();
  const conformanceArtifacts = await writeConformanceArtifactsForSelfCheck({
    outDir: conformanceDir,
    report: releaseReport,
    basename: "dojo-mcp-host-conformance",
  });
  const conformanceResult = await verifyDojoMcpHostConformanceArtifacts({
    reportPath: conformanceArtifacts.report_path,
    evidencePath: conformanceArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(conformanceResult.ok, true, conformanceResult.errors.join(";"));
  const stdioHostTranscriptPath = await writeStdioAcceptanceTranscriptForSelfCheck({
    outDir: conformanceDir,
    basename: "mcp-stdio-private-tool-host-conformance",
    overrides: deployedPrivateToolHostTranscriptOverrides({
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
    }),
  });
  const stdioHostConformanceResult = await verifyDojoPrivateToolStdioHostConformanceArtifact({
    transcriptPath: stdioHostTranscriptPath,
    releaseCandidate: true,
  });
  assert.equal(stdioHostConformanceResult.ok, true, stdioHostConformanceResult.errors.join(";"));
  const codexHostTranscriptPath = await writeCodexAcceptanceTranscriptForSelfCheck({
    outDir: conformanceDir,
    basename: "codex-private-tool-host-conformance",
    overrides: deployedPrivateToolHostTranscriptOverrides(),
  });
  const codexHostConformanceResult = await verifyDojoPrivateToolCodexHostConformanceArtifact({
    transcriptPath: codexHostTranscriptPath,
    releaseCandidate: true,
  });
  assert.equal(codexHostConformanceResult.ok, true, codexHostConformanceResult.errors.join(";"));

  const selfCheckReport = buildReleaseCandidateConformanceReport({
    schemaVersion: "synthi.dojo.mcpHostConformance.selfCheck.v1",
  });
  const selfCheckArtifacts = await writeConformanceArtifactsForSelfCheck({
    outDir: conformanceDir,
    report: selfCheckReport,
    basename: "dojo-mcp-host-conformance-self-check",
  });
  const rejectedSelfCheck = await verifyDojoMcpHostConformanceArtifacts({
    reportPath: selfCheckArtifacts.report_path,
    evidencePath: selfCheckArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedSelfCheck.errors.includes("conformance_schema_not_release:synthi.dojo.mcpHostConformance.selfCheck.v1"));

  const dryRunReport = buildReleaseCandidateConformanceReport({ executeProduction: false });
  const dryRunArtifacts = await writeConformanceArtifactsForSelfCheck({
    outDir: conformanceDir,
    report: dryRunReport,
    basename: "dojo-mcp-host-conformance-dry-run",
  });
  const rejectedDryRun = await verifyDojoMcpHostConformanceArtifacts({
    reportPath: dryRunArtifacts.report_path,
    evidencePath: dryRunArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedDryRun.errors.includes("conformance_execute_production_missing"));
  assert(rejectedDryRun.errors.includes("conformance_production_execution_step_missing"));
  const rejectedStdioHostTranscriptPath = await writeStdioAcceptanceTranscriptForSelfCheck({
    outDir: conformanceDir,
    basename: "mcp-stdio-private-tool-host-conformance-rejected",
    overrides: {
      target_url: "http://127.0.0.1/private-tool",
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
        scope: "self-check-rejected",
      },
      mcp_server: {
        command: "node",
        cwd: MCP_ROOT,
        args_count: 1,
        default_repo_dist: true,
      },
    },
  });
  const rejectedStdioHost = await verifyDojoPrivateToolStdioHostConformanceArtifact({
    transcriptPath: rejectedStdioHostTranscriptPath,
    releaseCandidate: true,
  });
  assert(rejectedStdioHost.errors.includes("private_tool_stdio_host_external_store_missing"));
  assert(rejectedStdioHost.errors.includes("private_tool_stdio_host_custom_mcp_command_missing"));
  assert(rejectedStdioHost.errors.includes("private_tool_stdio_host_target_not_remote:loopback"));

  const managedKeySigningDir = path.join(outDir, "managed-key-signing");
  await mkdir(managedKeySigningDir, { recursive: true });
  const managedKeySigningArtifacts = await writeManagedKeySigningEvidenceForSelfCheck({ outDir: managedKeySigningDir });
  const managedKeySigningResult = await verifyDojoManagedKeySigningEvidenceArtifact({
    evidencePath: managedKeySigningArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(managedKeySigningResult.ok, true, managedKeySigningResult.errors.join(";"));
  const rejectedManagedKeySigningArtifacts = await writeManagedKeySigningEvidenceForSelfCheck({
    outDir: managedKeySigningDir,
    basename: "dojo-managed-key-signing-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["managed_key_service_rejects_local_custody_metadata"],
      signing_contract: {
        ...managedKeySigningArtifacts.evidence.signing_contract,
        key_custody: "local",
        production_private_key_material_allowed: true,
      },
    },
  });
  const rejectedManagedKeySigning = await verifyDojoManagedKeySigningEvidenceArtifact({
    evidencePath: rejectedManagedKeySigningArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedManagedKeySigning.errors.includes("managed_key_signing_coverage_incomplete"));
  assert(rejectedManagedKeySigning.errors.includes("managed_key_signing_missing_capabilities:managed_key_service_rejects_local_custody_metadata"));
  assert(rejectedManagedKeySigning.errors.includes("managed_key_signing_custody_mismatch:local"));
  assert(rejectedManagedKeySigning.errors.includes("managed_key_signing_private_material_allowed"));

  const governanceLifecycleDir = path.join(outDir, "governance-lifecycle");
  await mkdir(governanceLifecycleDir, { recursive: true });
  const governanceLifecycleArtifacts = await writeGovernanceLifecycleEvidenceForSelfCheck({ outDir: governanceLifecycleDir });
  const governanceLifecycleResult = await verifyDojoGovernanceLifecycleEvidenceArtifact({
    evidencePath: governanceLifecycleArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(governanceLifecycleResult.ok, true, governanceLifecycleResult.errors.join(";"));
  const rejectedGovernanceLifecycleArtifacts = await writeGovernanceLifecycleEvidenceForSelfCheck({
    outDir: governanceLifecycleDir,
    basename: "dojo-governance-lifecycle-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["governance_revokes_license_to_blocked_scope_with_audit"],
      governance_contract: {
        ...governanceLifecycleArtifacts.evidence.governance_contract,
        license_revocation_required: false,
        compliance_pack_required: false,
      },
    },
  });
  const rejectedGovernanceLifecycle = await verifyDojoGovernanceLifecycleEvidenceArtifact({
    evidencePath: rejectedGovernanceLifecycleArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_coverage_incomplete"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_missing_capabilities:governance_revokes_license_to_blocked_scope_with_audit"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_license_revocation_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_compliance_pack_requirement_missing"));

  const graphRuntimeDir = path.join(outDir, "graph-runtime");
  await mkdir(graphRuntimeDir, { recursive: true });
  const graphRuntimeArtifacts = await writeGraphRuntimeEvidenceForSelfCheck({ outDir: graphRuntimeDir });
  const graphRuntimeResult = await verifyDojoGraphRuntimeEvidenceArtifact({
    evidencePath: graphRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(graphRuntimeResult.ok, true, graphRuntimeResult.errors.join(";"));
  const rejectedGraphRuntimeArtifacts = await writeGraphRuntimeEvidenceForSelfCheck({
    outDir: graphRuntimeDir,
    basename: "dojo-graph-runtime-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["graph_runtime_executes_available_rollback"],
      graph_runtime_contract: {
        ...graphRuntimeArtifacts.evidence.graph_runtime_contract,
        rollback_runtime_required: false,
        proof_gate_required: false,
      },
    },
  });
  const rejectedGraphRuntime = await verifyDojoGraphRuntimeEvidenceArtifact({
    evidencePath: rejectedGraphRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedGraphRuntime.errors.includes("graph_runtime_coverage_incomplete"));
  assert(rejectedGraphRuntime.errors.includes("graph_runtime_missing_capabilities:graph_runtime_executes_available_rollback"));
  assert(rejectedGraphRuntime.errors.includes("graph_runtime_rollback_requirement_missing"));
  assert(rejectedGraphRuntime.errors.includes("graph_runtime_proof_gate_requirement_missing"));

  const vivariumRuntimeDir = path.join(outDir, "vivarium-runtime");
  await mkdir(vivariumRuntimeDir, { recursive: true });
  const vivariumRuntimeArtifacts = await writeVivariumRuntimeEvidenceForSelfCheck({ outDir: vivariumRuntimeDir });
  const vivariumRuntimeResult = await verifyDojoVivariumRuntimeEvidenceArtifact({
    evidencePath: vivariumRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(vivariumRuntimeResult.ok, true, vivariumRuntimeResult.errors.join(";"));
  const rejectedVivariumRuntimeArtifacts = await writeVivariumRuntimeEvidenceForSelfCheck({
    outDir: vivariumRuntimeDir,
    basename: "dojo-vivarium-runtime-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["evil_twin_hardening_reduces_attack_success_rate"],
      vivarium_contract: {
        ...vivariumRuntimeArtifacts.evidence.vivarium_contract,
        evil_twin_hardening_loop_required: false,
        executable_checkride_required: false,
      },
    },
  });
  const rejectedVivariumRuntime = await verifyDojoVivariumRuntimeEvidenceArtifact({
    evidencePath: rejectedVivariumRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_coverage_incomplete"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_missing_capabilities:evil_twin_hardening_reduces_attack_success_rate"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_evil_twin_hardening_requirement_missing"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_checkride_requirement_missing"));

  const caseLawRuntimeDir = path.join(outDir, "case-law-runtime");
  await mkdir(caseLawRuntimeDir, { recursive: true });
  const caseLawRuntimeArtifacts = await writeCaseLawRuntimeEvidenceForSelfCheck({ outDir: caseLawRuntimeDir });
  const caseLawRuntimeResult = await verifyDojoCaseLawRuntimeEvidenceArtifact({
    evidencePath: caseLawRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(caseLawRuntimeResult.ok, true, caseLawRuntimeResult.errors.join(";"));
  const rejectedCaseLawRuntimeArtifacts = await writeCaseLawRuntimeEvidenceForSelfCheck({
    outDir: caseLawRuntimeDir,
    basename: "dojo-case-law-runtime-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["antibody_matcher_proposes_without_binding"],
      case_law_contract: {
        ...caseLawRuntimeArtifacts.evidence.case_law_contract,
        antibody_matching_required: false,
        antibody_private_data_redaction_required: false,
      },
    },
  });
  const rejectedCaseLawRuntime = await verifyDojoCaseLawRuntimeEvidenceArtifact({
    evidencePath: rejectedCaseLawRuntimeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedCaseLawRuntime.errors.includes("case_law_runtime_coverage_incomplete"));
  assert(rejectedCaseLawRuntime.errors.includes("case_law_runtime_missing_capabilities:antibody_matcher_proposes_without_binding"));
  assert(rejectedCaseLawRuntime.errors.includes("case_law_runtime_antibody_matching_requirement_missing"));
  assert(rejectedCaseLawRuntime.errors.includes("case_law_runtime_antibody_private_data_requirement_missing"));

  const hostedRuntimeGatewayDir = path.join(outDir, "hosted-runtime-gateway");
  await mkdir(hostedRuntimeGatewayDir, { recursive: true });
  const hostedRuntimeGatewayArtifacts = await writeHostedRuntimeGatewayEvidenceForSelfCheck({ outDir: hostedRuntimeGatewayDir });
  const hostedRuntimeGatewayResult = await verifyDojoHostedRuntimeGatewayEvidenceArtifact({
    evidencePath: hostedRuntimeGatewayArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(hostedRuntimeGatewayResult.ok, true, hostedRuntimeGatewayResult.errors.join(";"));
  const rejectedHostedRuntimeGatewayArtifacts = await writeHostedRuntimeGatewayEvidenceForSelfCheck({
    outDir: hostedRuntimeGatewayDir,
    basename: "dojo-hosted-runtime-gateway-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["hosted_runtime_blocks_expired_and_revoked_sessions"],
      hosted_runtime_contract: {
        ...hostedRuntimeGatewayArtifacts.evidence.hosted_runtime_contract,
        revocation_and_expiry_required: false,
        evidence_write_required: false,
      },
    },
  });
  const rejectedHostedRuntimeGateway = await verifyDojoHostedRuntimeGatewayEvidenceArtifact({
    evidencePath: rejectedHostedRuntimeGatewayArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedHostedRuntimeGateway.errors.includes("hosted_runtime_gateway_coverage_incomplete"));
  assert(rejectedHostedRuntimeGateway.errors.includes("hosted_runtime_gateway_missing_capabilities:hosted_runtime_blocks_expired_and_revoked_sessions"));
  assert(rejectedHostedRuntimeGateway.errors.includes("hosted_runtime_gateway_revocation_expiry_requirement_missing"));
  assert(rejectedHostedRuntimeGateway.errors.includes("hosted_runtime_gateway_evidence_requirement_missing"));

  const visualDir = path.join(outDir, "visual");
  await mkdir(visualDir, { recursive: true });
  const visualReportPath = await writeSelfCheckVisualReport({ outDir: visualDir });
  const visualResult = await verifyVisualProofArtifact({
    manifest: manifestArtifacts.manifest,
    gateId: "dojo_full_visual_proof",
    reportPath: visualReportPath,
  });
  assert.equal(visualResult.ok, true, visualResult.errors.join(";"));

  const securityDir = path.join(outDir, "security");
  await mkdir(securityDir, { recursive: true });
  const securityArtifacts = await writeSecurityEvidenceForSelfCheck({ outDir: securityDir });
  const securityResult = await verifyDojoSecurityAbuseEvidenceArtifact({
    evidencePath: securityArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(securityResult.ok, true, securityResult.errors.join(";"));
  const rejectedSecurityPath = await writeSecurityEvidenceForSelfCheck({
    outDir: securityDir,
    basename: "dojo-security-abuse-rejected",
    overrides: {
      ok: false,
      abuse_class_coverage_complete: false,
      missing_abuse_classes: ["raw_private_tool_bypass"],
    },
  });
  const rejectedSecurity = await verifyDojoSecurityAbuseEvidenceArtifact({
    evidencePath: rejectedSecurityPath.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedSecurity.errors.includes("security_abuse_coverage_incomplete"));
  assert(rejectedSecurity.errors.includes("security_abuse_missing_classes:raw_private_tool_bypass"));

  const complianceDir = path.join(outDir, "compliance-export");
  await mkdir(complianceDir, { recursive: true });
  const complianceArtifacts = await writeComplianceExportEvidenceForSelfCheck({ outDir: complianceDir });
  const complianceResult = await verifyDojoComplianceExportEvidenceArtifact({
    evidencePath: complianceArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(complianceResult.ok, true, complianceResult.errors.join(";"));
  const rejectedComplianceArtifacts = await writeComplianceExportEvidenceForSelfCheck({
    outDir: complianceDir,
    basename: "dojo-compliance-export-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["redacted_evidence_export"],
      budget_evaluation: { ok: false },
    },
  });
  const rejectedCompliance = await verifyDojoComplianceExportEvidenceArtifact({
    evidencePath: rejectedComplianceArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedCompliance.errors.includes("compliance_export_coverage_incomplete"));
  assert(rejectedCompliance.errors.includes("compliance_export_missing_capabilities:redacted_evidence_export"));

  const privacyDir = path.join(outDir, "privacy-redaction");
  await mkdir(privacyDir, { recursive: true });
  const privacyArtifacts = await writePrivacyRedactionEvidenceForSelfCheck({ outDir: privacyDir });
  const privacyResult = await verifyDojoPrivacyRedactionEvidenceArtifact({
    evidencePath: privacyArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(privacyResult.ok, true, privacyResult.errors.join(";"));
  const rejectedPrivacyArtifacts = await writePrivacyRedactionEvidenceForSelfCheck({
    outDir: privacyDir,
    basename: "dojo-privacy-redaction-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["screenshot_consent_boundary"],
      budget_evaluation: { ok: false },
    },
  });
  const rejectedPrivacy = await verifyDojoPrivacyRedactionEvidenceArtifact({
    evidencePath: rejectedPrivacyArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedPrivacy.errors.includes("privacy_redaction_coverage_incomplete"));
  assert(rejectedPrivacy.errors.includes("privacy_redaction_missing_capabilities:screenshot_consent_boundary"));

  const chaosDir = path.join(outDir, "chaos");
  await mkdir(chaosDir, { recursive: true });
  const chaosArtifacts = await writeChaosEvidenceForSelfCheck({ outDir: chaosDir });
  const chaosResult = await verifyDojoChaosPerformanceEvidenceArtifact({
    evidencePath: chaosArtifacts.evidence_path,
    enterpriseRelease: true,
  });
  assert.equal(chaosResult.ok, true, chaosResult.errors.join(";"));
  const rejectedChaosArtifacts = await writeChaosEvidenceForSelfCheck({
    outDir: chaosDir,
    basename: "dojo-chaos-performance-rejected",
    overrides: {
      ok: false,
      scenario_coverage_complete: false,
      missing_chaos_scenarios: ["api_timeout"],
    },
  });
  const rejectedChaos = await verifyDojoChaosPerformanceEvidenceArtifact({
    evidencePath: rejectedChaosArtifacts.evidence_path,
    enterpriseRelease: true,
  });
  assert(rejectedChaos.errors.includes("chaos_performance_scenario_coverage_incomplete"));
  assert(rejectedChaos.errors.includes("chaos_performance_missing_scenarios:api_timeout"));

  const soakDir = path.join(outDir, "soak");
  await mkdir(soakDir, { recursive: true });
  const soakArtifacts = await writeSoakArtifactsForSelfCheck({ outDir: soakDir });
  const soakResult = await verifyDojoSoakPerformanceArtifacts({
    summaryPath: soakArtifacts.summary_path,
    eventsPath: soakArtifacts.events_path,
    minDurationSeconds: 1,
  });
  assert.equal(soakResult.ok, true, soakResult.errors.join(";"));
  const rejectedSoakArtifacts = await writeSoakArtifactsForSelfCheck({
    outDir: soakDir,
    basename: "soak-rejected",
    summaryOverrides: {
      duration_s: 0.5,
      errors: 1,
    },
  });
  const rejectedSoak = await verifyDojoSoakPerformanceArtifacts({
    summaryPath: rejectedSoakArtifacts.summary_path,
    eventsPath: rejectedSoakArtifacts.events_path,
    minDurationSeconds: 1,
  });
  assert(rejectedSoak.errors.includes("soak_duration_below_required:0.5:1"));
  assert(rejectedSoak.errors.includes("soak_errors_nonzero:1"));

  const report = {
    schema_version: "synthi.dojo.releaseGateVerifierSelfCheck.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    verified_sections: [
      summarizeSection(manifestResult),
      summarizeSection(postgresControlPlaneResult),
      summarizeSection(dockerIntegrationResult),
      summarizeSection(workflowE2EResult),
      summarizeSection(stdioAcceptanceResult),
      summarizeSection(codexAcceptanceResult),
      summarizeSection(conformanceResult),
      summarizeSection(stdioHostConformanceResult),
      summarizeSection(codexHostConformanceResult),
      summarizeSection(managedKeySigningResult),
      summarizeSection(governanceLifecycleResult),
      summarizeSection(graphRuntimeResult),
      summarizeSection(vivariumRuntimeResult),
      summarizeSection(caseLawRuntimeResult),
      summarizeSection(hostedRuntimeGatewayResult),
      summarizeSection(sourceDriftResult),
      summarizeSection(apiToolCompilerResult),
      summarizeSection(generatedPrResult),
      summarizeSection(visualResult),
      summarizeSection(securityResult),
      summarizeSection(complianceResult),
      summarizeSection(privacyResult),
      summarizeSection(chaosResult),
      summarizeSection(soakResult),
    ],
    rejected_controls: [
      summarizeSection(rejectedSelfCheck),
      summarizeSection(rejectedPostgres),
      summarizeSection(rejectedDocker),
      summarizeSection(rejectedCodexAcceptance),
      summarizeSection(rejectedDryRun),
      summarizeSection(rejectedStdioHost),
      summarizeSection(rejectedManagedKeySigning),
      summarizeSection(rejectedGovernanceLifecycle),
      summarizeSection(rejectedGraphRuntime),
      summarizeSection(rejectedVivariumRuntime),
      summarizeSection(rejectedCaseLawRuntime),
      summarizeSection(rejectedHostedRuntimeGateway),
      summarizeSection(rejectedSourceDrift),
      summarizeSection(rejectedApiToolCompiler),
      summarizeSection(rejectedGeneratedPr),
      summarizeSection(rejectedSecurity),
      summarizeSection(rejectedCompliance),
      summarizeSection(rejectedPrivacy),
      summarizeSection(rejectedChaos),
      summarizeSection(rejectedSoak),
    ],
  };
  const reportPath = path.join(outDir, "dojo-release-gate-verifier-self-check.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report_path: reportPath, report };
}

function buildReleaseCandidateConformanceReport({
  schemaVersion = "synthi.dojo.mcpHostConformance.v1",
  executeProduction = true,
} = {}) {
  const report = {
    schema_version: schemaVersion,
    generated_at: new Date().toISOString(),
    conformance: {
      ok: true,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: true,
      mcp_host_class: "remote",
    },
    config: {
      requested_skill_id: "self-check-skill",
      requested_workflow_id: null,
      requested_published_tool_name: null,
      requested_action: "run_workflow",
      execute_production: executeProduction,
      raw_backing_tool_required: true,
    },
    deployment_claims: {
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
    },
    steps: [
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
    ],
  };
  report.release_gate = buildConformanceReleaseGateSummary(report);
  return redactConformanceReport(report);
}

async function writeLiveHostedRuntimeArtifactsForSelfCheck({ outDir }) {
  const workflowSummaryPath = await writeWorkflowE2ESummaryForSelfCheck({ outDir });
  const stdioTranscriptPath = await writeStdioAcceptanceTranscriptForSelfCheck({ outDir });
  const codexTranscriptPath = await writeCodexAcceptanceTranscriptForSelfCheck({ outDir });
  return {
    workflow_summary_path: workflowSummaryPath,
    stdio_transcript_path: stdioTranscriptPath,
    codex_transcript_path: codexTranscriptPath,
  };
}

function deployedPrivateToolHostTranscriptOverrides(overrides = {}) {
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
      scope: "external-self-check",
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

async function writeWorkflowE2ESummaryForSelfCheck({ outDir, basename = "workflow-e2e", overrides = {} }) {
  const screenshotPath = path.join(outDir, `${basename}.png`);
  const screenshotBytes = proofSelfCheckVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const summary = {
    schema_version: "synthi.dojo.workflowPipelineE2E.v1",
    generated_at: new Date().toISOString(),
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
    visual_artifact_count: 1,
    visual_artifacts: [
      {
        case_id: "self-check-case",
        stage: "self_check_visual",
        source: "release_gate_self_check",
        path: path.relative(outDir, screenshotPath).replace(/\\/g, "/"),
        bytes: screenshotBytes.length,
        screenshot_sha256: sha256(screenshotBytes),
        mime_type: "image/png",
        png_verified: true,
      },
    ],
    results: [
      { caseId: "self-check-case", name: "export avoids forwarded port literals", ok: true, detail: "none" },
      { caseId: "self-check-case", name: "run exported Playwright", ok: true, detail: "passed" },
      { caseId: "self-check-case", name: "fresh MCP attach hosted browser", ok: true, detail: "hosted" },
      { caseId: "self-check-case", name: "fresh MCP call discovered private tool", ok: true, detail: "steps=1" },
    ],
    ...overrides,
  };
  const summaryPath = path.join(outDir, `${basename}.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summaryPath;
}

async function writeAffordanceCodemodArtifactsForSelfCheck({ outDir, basename = "dojo-affordance-codemod-self-check", reportOverrides = {} }) {
  const reportPath = path.join(outDir, `${basename}.json`);
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  const report = buildAffordanceCodemodReportForSelfCheck(reportOverrides);
  const serialized = JSON.stringify(report, null, 2);
  const evidence = {
    schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
    generated_at: new Date().toISOString(),
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
  await writeFile(reportPath, serialized, "utf8");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    report_path: reportPath,
    evidence_path: evidencePath,
  };
}

async function writeSourceDriftEvidenceForSelfCheck({
  outDir,
  basename = "dojo-source-drift",
  overrides = {},
}) {
  const stdout = "source drift focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    numPassedTests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_SOURCE_DRIFT_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.sourceDriftEvidence.v1",
    generated_at: new Date().toISOString(),
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
    },
    test_files: [...DOJO_SOURCE_DRIFT_TEST_FILES],
    test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length,
    reported_test_file_count: DOJO_SOURCE_DRIFT_TEST_FILES.length,
    test_summary: {
      total_tests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
      passed_tests: DOJO_SOURCE_DRIFT_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    budget_evaluation: { ok: true },
    stdout_path: stdoutPath,
    stdout_sha256: sha256(stdout),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_path: stderrPath,
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    ...overrides,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeApiToolCompilerEvidenceForSelfCheck({
  outDir,
  basename = "dojo-api-tool-compiler",
  overrides = {},
}) {
  const stdout = "api tool compiler focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    numPassedTests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_API_TOOL_COMPILER_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES,
    tested_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES,
    capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    configured_capability_count: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
    capability_coverage_complete: true,
    missing_capabilities: [],
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
    },
    test_files: [...DOJO_API_TOOL_COMPILER_TEST_FILES],
    test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length,
    reported_test_file_count: DOJO_API_TOOL_COMPILER_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
      passed_tests: DOJO_API_TOOL_COMPILER_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

function buildAffordanceCodemodReportForSelfCheck(overrides = {}) {
  const sourceFile = "src/InvoiceForm.jsx";
  const testFile = "src/__tests__/InvoiceForm.dojo-affordance.test.ts";
  const operationIds = ["patch_stable_locator_invoice_save", "patch_proof_hook_invoice_save"];
  const fileRefs = [
    { kind: "source", path: sourceFile },
    { kind: "contract_test", path: testFile },
  ];
  const base = {
    schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
    generated_at: new Date().toISOString(),
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
  };
  return {
    ...base,
    ...overrides,
  };
}

async function writeStdioAcceptanceTranscriptForSelfCheck({ outDir, basename = "mcp-stdio-private-tool-acceptance", overrides = {} }) {
  const screenshotPath = path.join(outDir, `${basename}.png`);
  const screenshotBytes = proofSelfCheckVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const transcript = {
    schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    cdp_url: "wss://hosted-runtime.example.test/session",
    target_url: "https://workspace.example.test/private-tool",
    workspace_id: "workspace-self-check",
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
      scope: "self-check",
    },
    acceptance: {
      requested_tool_name: null,
      tool_args_keys: [],
      expected_steps_min: 1,
      expected_text_required: true,
    },
    steps: [
      { name: "initialize", ok: true },
      { name: "production-style deployment readiness through MCP", ok: true, workflow_bridge_required: false },
      { name: "discover private MCP tool", ok: true, tool_name: "synthi_app_self_check", tool_count: 1 },
      {
        name: "strict host schema validation before execution",
        ok: true,
        rejected: [
          { arguments: ["script_path"], errors: ["additional_property:script_path"] },
          { arguments: ["run_mode"], errors: ["enum:run_mode"] },
        ],
        accepted_configured_call: true,
      },
      { name: "discover private workflow registry through MCP", ok: true, count: 1, tool_name: "synthi_app_self_check" },
      { name: "lookup manifest through MCP", ok: true, result: { tool_name: "synthi_app_self_check" } },
      {
        name: "attach hosted workspace browser through MCP",
        ok: true,
        evidence: { hosted_attach: true, local_attach: false, runtime_kind: "hosted" },
      },
      { name: "grant exact-origin consent", ok: true },
      { name: "open target page", ok: true, tab: { tab_id: "tab-self-check" } },
      {
        name: "call discovered private MCP tool",
        ok: true,
        result: {
          ok: true,
          private_tool: { tool_name: "synthi_app_self_check", run_mode: "sameSession" },
          replay: { steps_run: 2 },
        },
      },
      {
        name: "visual proof snapshot",
        ok: true,
        screenshot_path: screenshotPath,
        screenshot_bytes: screenshotBytes.length,
        screenshot_sha256: sha256(screenshotBytes),
        url: "https://workspace.example.test/private-tool",
        expected_text: "Details opened",
      },
    ],
    ...overrides,
  };
  const transcriptPath = path.join(outDir, `${basename}.json`);
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  return transcriptPath;
}

async function writeCodexAcceptanceTranscriptForSelfCheck({ outDir, basename = "codex-private-tool-acceptance", overrides = {} }) {
  const screenshotPath = path.join(outDir, `${basename}.png`);
  const screenshotBytes = proofSelfCheckVisualPngBytes();
  await writeFile(screenshotPath, screenshotBytes);
  const transcript = buildCodexAcceptanceTranscriptForSelfCheck({
    screenshotPath,
    screenshotBytes: screenshotBytes.length,
    screenshotSha256: sha256(screenshotBytes),
    ...overrides,
  });
  const transcriptPath = path.join(outDir, `${basename}.json`);
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  return transcriptPath;
}

function buildCodexAcceptanceTranscriptForSelfCheck(overrides = {}) {
  const screenshotPath = overrides.screenshotPath || "codex-private-tool-acceptance.png";
  const screenshotBytes = Number(overrides.screenshotBytes);
  const screenshotSha256 = overrides.screenshotSha256;
  const transcript = {
    schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    cdp_url: "wss://hosted-runtime.example.test/session",
    target_url: "https://workspace.example.test/private-tool",
    workspace_id: "workspace-self-check",
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
      scope: "self-check",
    },
    acceptance: {
      requested_tool_name: null,
      tool_args_keys: [],
      expected_steps_min: 1,
      expected_text_required: true,
    },
    codex_model: "gpt-5-codex-self-check",
    codex: {
      exit_code: 0,
      event_count: 9,
      final_message: "WORKFLOW_DONE synthi_app_self_check",
      saw_private_tool_name: true,
      mcp_evidence: {
        hosted_attach_call: true,
        local_attach_call: false,
        private_tool_call: true,
        private_tool_result_ok: true,
        private_tool_steps_run: 2,
        private_tool_called_name: "synthi_app_self_check",
        consent_call: true,
        open_call: true,
        command_execution_count: 0,
        command_executions: [],
      },
    },
    steps: [
      { name: "codex discovered and called private MCP tool", ok: true, tool_name: "synthi_app_self_check" },
      {
        name: "visual proof snapshot",
        ok: true,
        screenshot_path: screenshotPath,
        screenshot_bytes: Number.isFinite(screenshotBytes) ? screenshotBytes : undefined,
        screenshot_sha256: screenshotSha256,
        url: "https://workspace.example.test/private-tool",
        match: true,
        expected_text: "Details opened",
      },
    ],
  };
  const cleanedOverrides = { ...overrides };
  delete cleanedOverrides.screenshotPath;
  delete cleanedOverrides.screenshotBytes;
  delete cleanedOverrides.screenshotSha256;
  return {
    ...transcript,
    ...cleanedOverrides,
  };
}

async function writeConformanceArtifactsForSelfCheck({ outDir, report, basename }) {
  const reportPath = path.join(outDir, `${basename}.json`);
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  const serialized = JSON.stringify(report, null, 2);
  const evidence = redactConformanceReport(buildConformanceEvidenceManifest({
    report,
    reportPath,
    serialized,
  }));
  await writeFile(reportPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  return { report_path: reportPath, evidence_path: evidencePath };
}

async function writeProofSelfCheckArtifactsForSelfCheck({
  outDir,
  basename = "dojo-proof-self-check",
  summaryOverrides = {},
  productionEvidenceOverrides = {},
}) {
  const productionEvidence = {
    schema_version: "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1",
    run_id: "dojo-release-gate-verifier-self-check-production",
    requested_action: "run_prefix_validation",
    proof_capsule_id: "capsule-release-gate-self-check",
    proof_consumed: true,
    replay_blocked: true,
    replay_error: "dojo_license_kernel_blocked",
    runtime_session: {
      schema_version: "synthi.dojo.hostedRuntimeSession.v1",
      session_id: "dojo_runtime_session_release_gate_self_check",
      runtime_id: "dojo_runtime_release_gate_self_check",
      tenant_id: "tenant-release-gate",
      organization_id: "org-release-gate",
      workspace_id: "workspace-release-gate",
      skill_id: "skill-release-gate",
      run_id: "dojo-release-gate-verifier-self-check-production",
      actor_id: "release-gate-agent",
      actor_type: "service",
      workspace_url: "https://app.example.test/settings",
      workspace_origin: "https://app.example.test",
      origin_allowlist: ["https://app.example.test"],
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:10:00.000Z",
      credential_id: "runtime_cred_release_gate_self_check",
      credential_expires_at: "2026-06-11T00:05:00.000Z",
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
      audit_event_refs: ["audit-runtime-session"],
      evidence_refs: [],
    },
    runtime_authorization: {
      ok: true,
      status: "authorized",
      session_id: "dojo_runtime_session_release_gate_self_check",
      action_kind: "proof_gated_tool",
      blocked_by: [],
      audit_event_id: "audit-runtime-action",
      evidence_record_ids: ["evidence:runtime-action"],
    },
    proof_record: {
      capsule_id: "capsule-release-gate-self-check",
      status: "used",
      first_used_at: "2026-06-11T00:01:00.000Z",
    },
    audit_event_types: ["runtime_session_created", "runtime_action_authorized", "proof_used"],
    ...productionEvidenceOverrides,
  };
  const productionEvidencePath = path.join(outDir, `${basename}.production-runtime-evidence.json`);
  await writeFile(productionEvidencePath, `${JSON.stringify(productionEvidence, null, 2)}\n`, "utf8");
  const visualDir = path.join(outDir, `${basename}.visual-proof`);
  await mkdir(visualDir, { recursive: true });
  const visualScreenshotPath = path.join(visualDir, "dojo-proof-visual.png");
  const visualScreenshotBytes = proofSelfCheckVisualPngBytes();
  await writeFile(visualScreenshotPath, visualScreenshotBytes);
  const visualEvidencePath = path.join(visualDir, "dojo-proof-visual.evidence.json");
  const visualEvidence = {
    schema_version: "synthi.dojo.proofSelfCheckVisualEvidence.v1",
    ok: true,
    page_path: path.join(visualDir, "dojo-proof-visual.html"),
    screenshot_path: visualScreenshotPath,
    screenshot_bytes: visualScreenshotBytes.length,
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
  };
  await writeFile(visualEvidencePath, `${JSON.stringify(visualEvidence, null, 2)}\n`, "utf8");
  const summary = {
    schema_version: "synthi.dojo.proofSelfCheckSummary.v1",
    ok: true,
    run_id: "dojo-release-gate-verifier-self-check",
    production_proof_consumed: true,
    production_proof_replay_blocked: true,
    production_runtime_evidence: path.basename(productionEvidencePath),
    production_runtime_evidence_record_count: 1,
    visual_proof_ok: true,
    visual_proof_pixel_metrics_verified: true,
    visual_proof_horizontal_overflow_px: 0,
    visual_proof_screenshot: path.relative(outDir, visualScreenshotPath).replace(/\\/g, "/"),
    visual_proof_evidence: path.relative(outDir, visualEvidencePath).replace(/\\/g, "/"),
    ...summaryOverrides,
  };
  const summaryPath = path.join(outDir, `${basename}.summary.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    summary_path: summaryPath,
    production_evidence_path: productionEvidencePath,
    visual_evidence_path: visualEvidencePath,
    visual_screenshot_path: visualScreenshotPath,
  };
}

function proofSelfCheckVisualPngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(12000, 1),
  ]);
}

async function writePostgresControlPlaneEvidenceForSelfCheck({
  outDir,
  basename = "dojo-postgres-control-plane",
  overrides = {},
}) {
  const stdout = "postgres control-plane suite passed\n";
  const stderr = "";
  const jsonReport = postgresControlPlaneJsonReportFixtureText();
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    signal: null,
    duration_ms: 1200,
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
    env_requirements: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
    configured_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
    tested_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
    missing_capabilities: [],
    capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length,
    configured_capability_count: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES.length,
    capability_coverage_complete: true,
    test_files: [...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES],
    test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    reported_test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    test_summary: {
      success: true,
      total_tests: 13,
      passed_tests: 13,
      failed_tests: 0,
      pending_tests: 0,
      total_suites: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
      passed_suites: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
      failed_suites: 0,
      reported_test_file_count: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES.length,
    },
    budget_evaluation: { ok: true },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

function postgresControlPlaneJsonReportFixtureText() {
  return JSON.stringify({
    success: true,
    numTotalTests: 13,
    numPassedTests: 13,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 4,
    numPassedTestSuites: 4,
    numFailedTestSuites: 0,
    testResults: [],
  }, null, 2);
}

async function writeDockerIntegrationEvidenceForSelfCheck({
  outDir,
  basename = "dojo-docker-integration",
  overrides = {},
}) {
  const stdout = "docker compose stack healthy\n";
  const stderr = "";
  const report = dockerIntegrationReportFixture();
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const reportPath = path.join(outDir, `${basename}.report.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(reportPath, reportText, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    duration_ms: 1500,
    docker_compose_up_ran: true,
    docker_compose_up_skipped: false,
    required_services: [...DOJO_DOCKER_REQUIRED_SERVICES],
    required_service_count: DOJO_DOCKER_REQUIRED_SERVICES.length,
    running_services: [...DOJO_DOCKER_REQUIRED_SERVICES],
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
    report_path: reportPath,
    report_sha256: sha256(reportText),
    report_bytes: Buffer.byteLength(reportText),
    json_report_path: reportPath,
    json_report_sha256: sha256(reportText),
    json_report_bytes: Buffer.byteLength(reportText),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    budget: {
      self_check_timeout_ms: 600000,
      endpoint_timeout_ms: 30000,
      intended_gate: "full_local_docker_integration",
    },
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

function dockerIntegrationReportFixture() {
  const services = dockerRequiredServicesFixture();
  return {
    schema_version: "synthi.dojo.dockerIntegrationReport.v1",
    generated_at: new Date().toISOString(),
    compose_file: "docker-compose.yml",
    command_evaluation: {
      compose_up_ran: true,
      compose_up_exit_code: 0,
      compose_ps_exit_code: 0,
      compose_config_exit_code: 0,
    },
    configured_services: services,
    service_rows: services.map((service) => ({
      Service: service,
      State: "running",
      Health: DOJO_DOCKER_HEALTHY_SERVICES.includes(service) ? "healthy" : "",
      Status: DOJO_DOCKER_HEALTHY_SERVICES.includes(service) ? "running (healthy)" : "running",
    })),
    service_evaluation: dockerServiceEvaluationFixture(),
    endpoint_checks: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => dockerEndpointFixture({
      id: endpoint.id,
      expectedStatus: endpoint.expected_status,
    })),
  };
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
      status: DOJO_DOCKER_HEALTHY_SERVICES.includes(service) ? "running (healthy)" : "running",
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

async function writeSelfCheckVisualReport({ outDir }) {
  const screenshotPath = path.join(outDir, "visual-self-check.png");
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luz3xgAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(screenshotPath, imageBytes);
  const report = {
    schema_version: "synthi.dojo.visualProof.v1",
    ok: true,
    generated_at: new Date().toISOString(),
    screenshots: [screenshotPath],
    results: [
      {
        route_id: "visual-self-check",
        viewport: "desktop",
        ok: true,
        failed_visual_gates: [],
        screenshot_path: screenshotPath,
        screenshot_sha256: sha256(imageBytes),
        bytes: imageBytes.length,
        image_metrics: {
          pixel_metrics_verified: true,
          unique_color_sample_count: 2,
          background_diff_pixel_ratio: 0.5,
          luma_stddev: 16,
        },
        layout_metrics: {
          horizontal_overflow_px: 0,
          selector_visible_area_px: 4096,
        },
      },
    ],
  };
  const reportPath = path.join(outDir, "visual-proof.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function writeSecurityEvidenceForSelfCheck({
  outDir,
  basename = "dojo-security-abuse",
  overrides = {},
}) {
  const stdout = "security abuse focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_SECURITY_ABUSE_CLASSES.length,
    numPassedTests: DOJO_SECURITY_ABUSE_CLASSES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.securityAbuseEvidence.v1",
    generated_at: new Date().toISOString(),
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
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        abuse_class_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_SECURITY_ABUSE_CLASSES.length,
      passed_tests: DOJO_SECURITY_ABUSE_CLASSES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeManagedKeySigningEvidenceForSelfCheck({
  outDir,
  basename = "dojo-managed-key-signing",
  overrides = {},
}) {
  const stdout = "managed key signing focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    numPassedTests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
    generated_at: new Date().toISOString(),
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
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
      passed_tests: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeGovernanceLifecycleEvidenceForSelfCheck({
  outDir,
  basename = "dojo-governance-lifecycle",
  overrides = {},
}) {
  const stdout = "governance lifecycle focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    numPassedTests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
    tested_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
    missing_capabilities: [],
    capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    configured_capability_count: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
    capability_coverage_complete: true,
    governance_contract: {
      license_health_required: true,
      approval_queue_required: true,
      approval_decision_audit_required: true,
      case_law_review_required: true,
      license_revocation_required: true,
      recertification_queue_required: true,
      policy_gates_required: true,
      audit_export_required: true,
      compliance_pack_required: true,
      proof_public_verification_custody_required: true,
      malformed_expiry_fails_closed_required: true,
    },
    test_files: [...DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES],
    test_file_count: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    reported_test_file_count: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
      passed_tests: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeGraphRuntimeEvidenceForSelfCheck({
  outDir,
  basename = "dojo-graph-runtime",
  overrides = {},
}) {
  const stdout = "graph runtime focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES,
    tested_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES,
    missing_capabilities: [],
    capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    configured_capability_count: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
    capability_coverage_complete: true,
    graph_runtime_contract: {
      graph_ir_validation_required: true,
      graph_compiler_required: true,
      source_api_binding_required: true,
      production_execution_required: true,
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
    },
    test_files: [...DOJO_GRAPH_RUNTIME_TEST_FILES],
    test_file_count: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_GRAPH_RUNTIME_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_GRAPH_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeVivariumRuntimeEvidenceForSelfCheck({
  outDir,
  basename = "dojo-vivarium-runtime",
  overrides = {},
}) {
  const stdout = "vivarium runtime focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
    tested_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
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
      deterministic_reset_required: true,
      budget_enforcement_required: true,
      targeted_graph_execution_required: true,
      executable_checkride_required: true,
      license_constraints_from_blocked_risk_required: true,
      critical_guardrail_failure_required: true,
      substrate_hook_passthrough_required: true,
      evil_twin_attack_measurement_required: true,
      evil_twin_hardening_loop_required: true,
    },
    test_files: [...DOJO_VIVARIUM_RUNTIME_TEST_FILES],
    test_file_count: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_VIVARIUM_RUNTIME_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_VIVARIUM_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeGeneratedPrEvidenceForSelfCheck({
  outDir,
  basename = "dojo-generated-pr",
  overrides = {},
}) {
  const stdout = "generated PR focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_GENERATED_PR_CAPABILITIES.length,
    numPassedTests: DOJO_GENERATED_PR_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_GENERATED_PR_TEST_FILES.length,
    numPassedTestSuites: DOJO_GENERATED_PR_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_GENERATED_PR_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.generatedPrEvidence.v1",
    generated_at: new Date().toISOString(),
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
    },
    test_files: [...DOJO_GENERATED_PR_TEST_FILES],
    test_file_count: DOJO_GENERATED_PR_TEST_FILES.length,
    reported_test_file_count: DOJO_GENERATED_PR_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        all_test_files_reported: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_GENERATED_PR_CAPABILITIES.length,
      passed_tests: DOJO_GENERATED_PR_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeCaseLawRuntimeEvidenceForSelfCheck({
  outDir,
  basename = "dojo-case-law-runtime",
  overrides = {},
}) {
  const stdout = "case-law runtime focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
    tested_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
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
    },
    test_files: [...DOJO_CASE_LAW_RUNTIME_TEST_FILES],
    test_file_count: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    reported_test_file_count: DOJO_CASE_LAW_RUNTIME_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
      passed_tests: DOJO_CASE_LAW_RUNTIME_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeHostedRuntimeGatewayEvidenceForSelfCheck({
  outDir,
  basename = "dojo-hosted-runtime-gateway",
  overrides = {},
}) {
  const stdout = "hosted runtime gateway focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
    tested_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
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
      malformed_record_rejection_required: true,
    },
    test_files: [...DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES],
    test_file_count: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    reported_test_file_count: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES.length,
    budget_evaluation: {
      ok: true,
      checks: {
        no_report_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
      passed_tests: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeComplianceExportEvidenceForSelfCheck({
  outDir,
  basename = "dojo-compliance-export",
  overrides = {},
}) {
  const stdout = "compliance export focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({ success: true, numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numPendingTests: 0, testResults: [] }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.complianceExportEvidence.v1",
    generated_at: new Date().toISOString(),
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
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: 12,
      passed_tests: 12,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writePrivacyRedactionEvidenceForSelfCheck({
  outDir,
  basename = "dojo-privacy-redaction",
  overrides = {},
}) {
  const stdout = "privacy redaction focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({ success: true, numTotalTests: 16, numPassedTests: 16, numFailedTests: 0, numPendingTests: 0, testResults: [] }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
    generated_at: new Date().toISOString(),
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
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        no_skipped_tests: true,
        all_reported_tests_passed: true,
        capability_coverage_complete: true,
        self_check_within_timeout: true,
      },
      failed_checks: [],
    },
    test_summary: {
      total_tests: 16,
      passed_tests: 16,
      failed_tests: 0,
      pending_tests: 0,
    },
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeChaosEvidenceForSelfCheck({
  outDir,
  basename = "dojo-chaos-performance",
  overrides = {},
}) {
  const stdout = "chaos performance preflight passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({ success: true, numTotalTests: 9, numPassedTests: 9, numFailedTests: 0, testResults: [] }, null, 2);
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    configured_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
    tested_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
    scenario_count: DOJO_CHAOS_SCENARIOS.length,
    configured_scenario_count: DOJO_CHAOS_SCENARIOS.length,
    scenario_coverage_complete: true,
    missing_chaos_scenarios: [],
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        all_reported_tests_passed: true,
        scenario_coverage_complete: true,
        self_check_within_timeout: true,
        test_case_p95_recorded: true,
        test_file_p95_recorded: true,
      },
    },
    test_summary: {
      total_tests: 9,
      passed_tests: 9,
      failed_tests: 0,
      pending_tests: 0,
    },
    performance_metrics: {
      self_check_duration_ms: 1250,
      test_case_duration_p95_ms: 42,
      test_file_duration_p95_ms: 140,
      failed_test_count: 0,
      passed_test_count: 9,
    },
    test_files: [...DOJO_CHAOS_PERFORMANCE_TEST_FILES],
    test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
    reported_test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReport),
    json_report_bytes: Buffer.byteLength(jsonReport),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeSoakArtifactsForSelfCheck({
  outDir,
  basename = "soak",
  summaryOverrides = {},
  events = defaultSoakEvents(),
}) {
  const summary = {
    duration_s: 2,
    iterations: events.length,
    errors: 0,
    snapshots_captured: 1,
    per_tool: {
      screenshot: { name: "screenshot", count: events.length, errors: 0, p50: 15, p95: 18, p99: 19, max: 19 },
      locate: { name: "locate", count: events.length, errors: 0, p50: 20, p95: 24, p99: 25, max: 25 },
      wait: { name: "wait", count: events.length, errors: 0, p50: 12, p95: 16, p99: 17, max: 17 },
      snapshot: { name: "snapshot", count: 1, errors: 0, p50: 21, p95: 21, p99: 21, max: 21 },
      usage: { name: "usage", count: 1, errors: 0, p50: 8, p95: 8, p99: 8, max: 8 },
    },
    memory: {
      source: "node_process_memory_usage",
      sample_count: events.length + 1,
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
    ...summaryOverrides,
  };
  const summaryPath = path.join(outDir, `${basename}-summary.json`);
  const eventsPath = path.join(outDir, `${basename}-events.ndjson`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return {
    summary_path: summaryPath,
    events_path: eventsPath,
    summary,
  };
}

function defaultSoakEvents() {
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

function parseVisualReportArgs(inputArgs) {
  const requests = [];
  if (inputArgs["visual-report"]) {
    for (const raw of String(inputArgs["visual-report"]).split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const [maybeGate, ...rest] = item.split("=");
      if (rest.length) {
        requests.push({ gateId: maybeGate, reportPath: rest.join("=") });
      } else {
        requests.push({ gateId: inputArgs["visual-gate-id"] || "", reportPath: item });
      }
    }
  }
  if (inputArgs["full-visual-report"]) {
    requests.push({ gateId: "dojo_full_visual_proof", reportPath: inputArgs["full-visual-report"] });
  }
  if (inputArgs["ghost-visual-report"]) {
    requests.push({ gateId: "dojo_ghost_mode_visual_proof", reportPath: inputArgs["ghost-visual-report"] });
  }
  return requests;
}

function findGate(manifest, gateId) {
  const gates = Array.isArray(manifest?.gates) ? manifest.gates : [];
  if (gateId) return gates.find((gate) => gate.id === gateId);
  return gates.find((gate) => gate.evidence_kind === "visual_report");
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function summarizeSection(section) {
  return {
    id: section.id,
    ok: section.ok,
    errors: section.errors,
    artifact_path: section.artifact_path,
    evidence_path: section.evidence_path,
    visual_evidence_path: section.visual_evidence_path,
    visual_screenshot_path: section.visual_screenshot_path,
    report_schema_version: section.report_schema_version,
    result_count: section.result_count,
    release_candidate: section.release_candidate,
    enterprise_release: section.enterprise_release,
  };
}

function resolveRepoPath(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  return path.isAbsolute(text) ? text : path.resolve(REPO_ROOT, text);
}

function resolveEvidenceArtifactPath(value, evidencePath) {
  const text = String(value || "").trim();
  if (!text) return text;
  if (path.isAbsolute(text)) return text;
  const evidenceRelative = path.resolve(path.dirname(evidencePath), text);
  return evidenceRelative;
}

function isPngBytes(bytes) {
  return Buffer.isBuffer(bytes)
    && bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function parseNdjson(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      rows.push({ parse_error: err instanceof Error ? err.message : String(err), raw: trimmed });
    }
  }
  return rows;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
