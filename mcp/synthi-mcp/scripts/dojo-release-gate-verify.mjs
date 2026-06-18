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
  DOJO_FULL_VISUAL_ROUTE_IDS,
  DOJO_FULL_VISUAL_VIEWPORTS,
  runSelfCheck as runReleaseGateManifestSelfCheck,
  validateDojoReleaseGateManifest,
  validateDojoVisualProofReport,
} from "./dojo-release-gate-manifest.mjs";
import {
  runDojoReleaseGateRunner,
} from "./dojo-release-gate-runner.mjs";
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
  DOJO_SKILL_PASSPORT_CAPABILITIES,
  DOJO_SKILL_PASSPORT_TEST_FILES,
} from "./dojo-skill-passport-self-check.mjs";
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

const DEFAULT_RELEASE_GATE_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gates");
const DEFAULT_VERIFY_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gate-verify");
const DEFAULT_RELEASE_GATE_RUNNER_DIR = path.join(REPO_ROOT, "tmp", "dojo-release-gate-runner");
const DEFAULT_WORKFLOW_PIPELINE_E2E_DIR = path.join(REPO_ROOT, "tmp", "workflow-pipeline-e2e");
const DEFAULT_PRIVATE_TOOL_STDIO_ACCEPTANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-stdio-acceptance");
const DEFAULT_PRIVATE_TOOL_CODEX_ACCEPTANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-codex-acceptance");
const DEFAULT_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "dojo-mcp-host-conformance");
const DEFAULT_CONFORMANCE_LIVE_DIR = path.join(REPO_ROOT, "tmp", "dojo-mcp-host-conformance-live");
const DEFAULT_PRIVATE_TOOL_STDIO_HOST_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-stdio-host-conformance");
const DEFAULT_PRIVATE_TOOL_CODEX_HOST_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "private-tool-codex-host-conformance");
const DEFAULT_POSTGRES_CONTROL_PLANE_DIR = path.join(REPO_ROOT, "tmp", "dojo-postgres-control-plane");
const DEFAULT_EVIDENCE_AUTHORITY_DIR = path.join(REPO_ROOT, "tmp", "dojo-evidence-authority");
const DEFAULT_IMPLEMENTATION_STATUS_DIR = path.join(REPO_ROOT, "tmp", "dojo-implementation-status");
const DEFAULT_AFFORDANCE_CODEMOD_DIR = path.join(REPO_ROOT, "tmp", "dojo-affordance-codemod-self-check");
const DEFAULT_SOURCE_DRIFT_DIR = path.join(REPO_ROOT, "tmp", "dojo-source-drift");
const DEFAULT_AGENT_READY_UI_CONTRACT_DIR = path.join(REPO_ROOT, "tmp", "dojo-agent-ready-ui-contract");
const DEFAULT_API_TOOL_COMPILER_DIR = path.join(REPO_ROOT, "tmp", "dojo-api-tool-compiler");
const DEFAULT_GENERATED_PR_DIR = path.join(REPO_ROOT, "tmp", "dojo-generated-pr");
const DEFAULT_MCP_SKILL_BUS_DIR = path.join(REPO_ROOT, "tmp", "dojo-mcp-skill-bus");
const DEFAULT_DOCKER_INTEGRATION_DIR = path.join(REPO_ROOT, "tmp", "dojo-docker-integration");
const DEFAULT_GOVERNANCE_LIFECYCLE_DIR = path.join(REPO_ROOT, "tmp", "dojo-governance-lifecycle");
const DEFAULT_GRAPH_RUNTIME_DIR = path.join(REPO_ROOT, "tmp", "dojo-graph-runtime");
const DEFAULT_GHOST_MODE_EVIDENCE_DIR = path.join(REPO_ROOT, "tmp", "dojo-ghost-mode-evidence");
const DEFAULT_SKILL_PASSPORT_DIR = path.join(REPO_ROOT, "tmp", "dojo-skill-passport");
const DEFAULT_TIME_MACHINE_DEBUGGER_DIR = path.join(REPO_ROOT, "tmp", "dojo-time-machine-debugger");
const DEFAULT_HOSTED_RUNTIME_GATEWAY_DIR = path.join(REPO_ROOT, "tmp", "dojo-hosted-runtime-gateway");
const DEFAULT_MANAGED_KEY_SIGNING_DIR = path.join(REPO_ROOT, "tmp", "dojo-managed-key-signing");
const DEFAULT_PUBLIC_PROOF_VERIFICATION_DIR = path.join(REPO_ROOT, "tmp", "dojo-public-proof-verification");
const DEFAULT_CASE_LAW_RUNTIME_DIR = path.join(REPO_ROOT, "tmp", "dojo-case-law-runtime");
const DEFAULT_CHECKRIDE_LICENSE_DIR = path.join(REPO_ROOT, "tmp", "dojo-checkride-license");
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
    const selfCheck = await runDojoReleaseGateVerifierSelfCheck({ outDir });
    console.log(`[ok] Dojo release gate verifier self-check passed - report=${selfCheck.report_path} evidence=${selfCheck.evidence_path}`);
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
  const releaseCandidate = truthy(args["release-candidate"]);
  const requireCompleteReleaseGateCoverage = releaseCandidate
    || truthy(args["require-complete-release-gate-coverage"])
    || truthy(args["strict-release-gate-coverage"]);
  const manifestPath = resolveRepoPath(args.manifest || args["manifest-path"] || path.join(DEFAULT_RELEASE_GATE_DIR, "dojo-release-gate-manifest.json"));
  const evidencePath = resolveRepoPath(args.evidence || args["manifest-evidence"] || path.join(DEFAULT_RELEASE_GATE_DIR, "dojo-release-gate-manifest.evidence.json"));
  const manifestResult = await verifyArtifactSection({
    id: "release_gate_manifest",
    artifactPath: manifestPath,
    evidencePath,
  }, () => verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath }));
  const manifest = manifestResult.manifest || { gates: [], release_gate_ids: [] };

  const releaseGateRunnerResults = [];
  if (truthy(args["include-release-gate-runner-default"]) || args["release-gate-run-report"]) {
    const reportPath = resolveRepoPath(args["release-gate-run-report"]
      || path.join(DEFAULT_RELEASE_GATE_RUNNER_DIR, "dojo-release-gate-runner-report.json"));
    const runnerEvidencePath = args["release-gate-run-evidence"]
      ? resolveRepoPath(args["release-gate-run-evidence"])
      : truthy(args["include-release-gate-runner-default"])
        ? resolveRepoPath(path.join(DEFAULT_RELEASE_GATE_RUNNER_DIR, "dojo-release-gate-runner.evidence.json"))
        : undefined;
    releaseGateRunnerResults.push(await verifyArtifactSection({
      id: "release_gate_runner",
      artifactPath: reportPath,
      evidencePath: runnerEvidencePath,
      releaseCandidate,
    }, () => verifyDojoReleaseGateRunReportArtifact({
      id: "release_gate_runner",
      reportPath,
      evidencePath: runnerEvidencePath,
      manifest,
      requirePromotionReady: releaseCandidate || truthy(args["require-release-gate-runner-promotion-ready"]),
    })));
  }
  const shouldVerifyReleaseGateRunnerSelfCheck = releaseCandidate
    || truthy(args["include-release-gate-runner-self-check-default"])
    || args["release-gate-runner-self-check-report"]
    || args["release-gate-runner-self-check-evidence"];
  if (shouldVerifyReleaseGateRunnerSelfCheck) {
    const runnerGate = findGate(manifest, "dojo_release_gate_runner_self_check") || {};
    const reportPath = resolveRepoPath(args["release-gate-runner-self-check-report"]
      || runnerGate.default_report_path
      || path.join(DEFAULT_RELEASE_GATE_RUNNER_DIR, "dojo-release-gate-runner-report.json"));
    const runnerEvidencePath = args["release-gate-runner-self-check-evidence"]
      ? resolveRepoPath(args["release-gate-runner-self-check-evidence"])
      : runnerGate.default_evidence_path
        ? resolveRepoPath(runnerGate.default_evidence_path)
        : resolveRepoPath(path.join(DEFAULT_RELEASE_GATE_RUNNER_DIR, "dojo-release-gate-runner.evidence.json"));
    releaseGateRunnerResults.push(await verifyArtifactSection({
      id: "dojo_release_gate_runner_self_check",
      artifactPath: reportPath,
      evidencePath: runnerEvidencePath,
      releaseCandidate,
    }, () => verifyDojoReleaseGateRunReportArtifact({
      id: "dojo_release_gate_runner_self_check",
      reportPath,
      evidencePath: runnerEvidencePath,
      manifest,
      requirePromotionReady: false,
    })));
  }
  const releaseGateVerifierResults = [];
  const shouldVerifyReleaseGateVerifierSelfCheck = releaseCandidate
    || truthy(args["include-release-gate-verifier-self-check-default"])
    || args["release-gate-verifier-self-check-report"]
    || args["release-gate-verifier-self-check-evidence"];
  if (shouldVerifyReleaseGateVerifierSelfCheck) {
    const verifierGate = findGate(manifest, "dojo_release_gate_verifier_self_check") || {};
    const reportPath = resolveRepoPath(args["release-gate-verifier-self-check-report"]
      || verifierGate.default_report_path
      || path.join(DEFAULT_VERIFY_DIR, "dojo-release-gate-verifier-self-check.json"));
    const verifierEvidencePath = args["release-gate-verifier-self-check-evidence"]
      ? resolveRepoPath(args["release-gate-verifier-self-check-evidence"])
      : verifierGate.default_evidence_path
        ? resolveRepoPath(verifierGate.default_evidence_path)
        : resolveRepoPath(path.join(DEFAULT_VERIFY_DIR, "dojo-release-gate-verifier-self-check.evidence.json"));
    releaseGateVerifierResults.push(await verifyArtifactSection({
      id: "dojo_release_gate_verifier_self_check",
      artifactPath: reportPath,
      evidencePath: verifierEvidencePath,
      releaseCandidate,
    }, () => verifyDojoReleaseGateVerifierSelfCheckArtifact({
      reportPath,
      evidencePath: verifierEvidencePath,
    })));
  }

  const proofSelfCheckResults = [];
  const shouldVerifyDojoSelfCheck = releaseCandidate
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
    proofSelfCheckResults.push(await verifyArtifactSection({
      id: "dojo_self_check",
      artifactPath: summaryPath,
      evidencePath: productionEvidencePath,
      releaseCandidate,
    }, () => verifyDojoProofSelfCheckArtifacts({
      summaryPath,
      productionEvidencePath,
    })));
  }

  const visualResults = [];
  if (releaseCandidate || truthy(args["include-visual-defaults"])) {
    for (const gate of manifest?.gates || []) {
      if (gate.evidence_kind !== "visual_report" || !gate.default_report_path) continue;
      const reportPath = resolveRepoPath(gate.default_report_path);
      visualResults.push(await verifyArtifactSection({
        id: gate.id,
        artifactPath: reportPath,
        releaseCandidate,
      }, () => verifyVisualProofArtifact({
        manifest,
        gateId: gate.id,
        reportPath,
      })));
    }
  }
  for (const request of parseVisualReportArgs(args)) {
    const reportPath = resolveRepoPath(request.reportPath);
    visualResults.push(await verifyArtifactSection({
      id: request.gateId,
      artifactPath: reportPath,
      releaseCandidate,
    }, () => verifyVisualProofArtifact({
      manifest,
      gateId: request.gateId,
      reportPath,
    })));
  }

  const postgresControlPlaneResults = [];
  if (releaseCandidate || truthy(args["include-postgres-control-plane"]) || args["postgres-control-plane-evidence"]) {
    const postgresGate = findGate(manifest, "dojo_postgres_control_plane_self_check") || {};
    const evidencePath = resolveRepoPath(args["postgres-control-plane-evidence"]
      || postgresGate.default_evidence_path
      || path.join(DEFAULT_POSTGRES_CONTROL_PLANE_DIR, "dojo-postgres-control-plane.evidence.json"));
    postgresControlPlaneResults.push(await verifyArtifactSection({
      id: "dojo_postgres_control_plane_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoPostgresControlPlaneEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const evidenceAuthorityResults = [];
  if (releaseCandidate || truthy(args["include-evidence-authority"]) || args["evidence-authority-evidence"]) {
    const evidenceAuthorityGate = findGate(manifest, "dojo_evidence_authority_self_check") || {};
    const evidencePath = resolveRepoPath(args["evidence-authority-evidence"]
      || evidenceAuthorityGate.default_evidence_path
      || path.join(DEFAULT_EVIDENCE_AUTHORITY_DIR, "dojo-evidence-authority.evidence.json"));
    evidenceAuthorityResults.push(await verifyArtifactSection({
      id: "dojo_evidence_authority_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoEvidenceAuthorityEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const implementationStatusResults = [];
  if (releaseCandidate || truthy(args["include-implementation-status"]) || args["implementation-status-evidence"]) {
    const implementationStatusGate = findGate(manifest, "dojo_implementation_status_self_check") || {};
    const evidencePath = resolveRepoPath(args["implementation-status-evidence"]
      || implementationStatusGate.default_evidence_path
      || path.join(DEFAULT_IMPLEMENTATION_STATUS_DIR, "dojo-implementation-status.evidence.json"));
    implementationStatusResults.push(await verifyArtifactSection({
      id: "dojo_implementation_status_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoImplementationStatusEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const dockerIntegrationResults = [];
  if (releaseCandidate || truthy(args["include-docker-integration"]) || args["docker-integration-evidence"]) {
    const dockerGate = findGate(manifest, "docker_integration") || {};
    const evidencePath = resolveRepoPath(args["docker-integration-evidence"]
      || dockerGate.default_evidence_path
      || path.join(DEFAULT_DOCKER_INTEGRATION_DIR, "dojo-docker-integration.evidence.json"));
    dockerIntegrationResults.push(await verifyArtifactSection({
      id: "docker_integration",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoDockerIntegrationEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const sourceApiResults = [];
  if (releaseCandidate || truthy(args["include-affordance-codemod"]) || args["affordance-codemod-report"] || args["affordance-codemod-evidence"]) {
    const affordanceGate = findGate(manifest, "dojo_affordance_codemod_self_check") || {};
    const reportPath = resolveRepoPath(args["affordance-codemod-report"]
      || affordanceGate.default_report_path
      || path.join(DEFAULT_AFFORDANCE_CODEMOD_DIR, "dojo-affordance-codemod-self-check.json"));
    const evidencePath = resolveRepoPath(args["affordance-codemod-evidence"]
      || affordanceGate.default_evidence_path
      || path.join(DEFAULT_AFFORDANCE_CODEMOD_DIR, "dojo-affordance-codemod-self-check.evidence.json"));
    sourceApiResults.push(await verifyArtifactSection({
      id: "dojo_affordance_codemod_self_check",
      artifactPath: reportPath,
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoAffordanceCodemodEvidenceArtifact({
      reportPath,
      evidencePath,
      releaseCandidate,
    })));
  }
  if (releaseCandidate || truthy(args["include-source-drift"]) || args["source-drift-evidence"]) {
    const sourceDriftGate = findGate(manifest, "dojo_source_drift_self_check") || {};
    const evidencePath = resolveRepoPath(args["source-drift-evidence"]
      || sourceDriftGate.default_evidence_path
      || path.join(DEFAULT_SOURCE_DRIFT_DIR, "dojo-source-drift.evidence.json"));
    sourceApiResults.push(await verifyArtifactSection({
      id: "dojo_source_drift_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoSourceDriftEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }
  if (releaseCandidate || truthy(args["include-agent-ready-ui-contract"]) || args["agent-ready-ui-contract-evidence"]) {
    const agentReadyGate = findGate(manifest, "dojo_agent_ready_ui_contract_self_check") || {};
    const evidencePath = resolveRepoPath(args["agent-ready-ui-contract-evidence"]
      || agentReadyGate.default_evidence_path
      || path.join(DEFAULT_AGENT_READY_UI_CONTRACT_DIR, "dojo-agent-ready-ui-contract.evidence.json"));
    sourceApiResults.push(await verifyArtifactSection({
      id: "dojo_agent_ready_ui_contract_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoAgentReadyUiContractEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }
  if (releaseCandidate || truthy(args["include-api-tool-compiler"]) || args["api-tool-compiler-evidence"]) {
    const apiToolCompilerGate = findGate(manifest, "dojo_api_tool_compiler_self_check") || {};
    const evidencePath = resolveRepoPath(args["api-tool-compiler-evidence"]
      || apiToolCompilerGate.default_evidence_path
      || path.join(DEFAULT_API_TOOL_COMPILER_DIR, "dojo-api-tool-compiler.evidence.json"));
    sourceApiResults.push(await verifyArtifactSection({
      id: "dojo_api_tool_compiler_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoApiToolCompilerEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const generatedPrResults = [];
  if (releaseCandidate || truthy(args["include-generated-pr"]) || args["generated-pr-evidence"]) {
    const generatedPrGate = findGate(manifest, "dojo_generated_pr_self_check") || {};
    const evidencePath = resolveRepoPath(args["generated-pr-evidence"]
      || generatedPrGate.default_evidence_path
      || path.join(DEFAULT_GENERATED_PR_DIR, "dojo-generated-pr.evidence.json"));
    generatedPrResults.push(await verifyArtifactSection({
      id: "dojo_generated_pr_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoGeneratedPrEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const mcpSkillBusResults = [];
  if (releaseCandidate || truthy(args["include-mcp-skill-bus"]) || args["mcp-skill-bus-evidence"]) {
    const mcpSkillBusGate = findGate(manifest, "dojo_mcp_skill_bus_self_check") || {};
    const evidencePath = resolveRepoPath(args["mcp-skill-bus-evidence"]
      || mcpSkillBusGate.default_evidence_path
      || path.join(DEFAULT_MCP_SKILL_BUS_DIR, "dojo-mcp-skill-bus.evidence.json"));
    mcpSkillBusResults.push(await verifyArtifactSection({
      id: "dojo_mcp_skill_bus_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoMcpSkillBusEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const liveHostedRuntimeResults = [];
  const shouldVerifyLiveHostedRuntime = releaseCandidate
    || args["workflow-e2e-summary"]
    || args["private-tool-stdio-acceptance"]
    || args["private-tool-codex-acceptance"];
  if (shouldVerifyLiveHostedRuntime) {
    const workflowGate = findGate(manifest, "workflow_e2e_hosted") || {};
    const stdioGate = findGate(manifest, "private_tool_stdio_acceptance") || {};
    const codexGate = findGate(manifest, "private_tool_codex_acceptance") || {};
    const workflowSummaryPath = resolveRepoPath(args["workflow-e2e-summary"]
      || workflowGate.default_report_path
      || path.join(DEFAULT_WORKFLOW_PIPELINE_E2E_DIR, "summary.json"));
    const stdioTranscriptPath = resolveRepoPath(args["private-tool-stdio-acceptance"]
      || stdioGate.default_report_path
      || path.join(DEFAULT_PRIVATE_TOOL_STDIO_ACCEPTANCE_DIR, "mcp-stdio-private-tool-acceptance.json"));
    const codexTranscriptPath = resolveRepoPath(args["private-tool-codex-acceptance"]
      || codexGate.default_report_path
      || path.join(DEFAULT_PRIVATE_TOOL_CODEX_ACCEPTANCE_DIR, "codex-private-tool-acceptance.json"));
    liveHostedRuntimeResults.push(await verifyArtifactSection({
      id: "workflow_e2e_hosted",
      artifactPath: workflowSummaryPath,
      releaseCandidate,
    }, () => verifyDojoWorkflowPipelineE2EArtifact({
      summaryPath: workflowSummaryPath,
      releaseCandidate,
    })));
    liveHostedRuntimeResults.push(await verifyArtifactSection({
      id: "private_tool_stdio_acceptance",
      artifactPath: stdioTranscriptPath,
      releaseCandidate,
    }, () => verifyDojoPrivateToolStdioAcceptanceArtifact({
      transcriptPath: stdioTranscriptPath,
      releaseCandidate,
    })));
    liveHostedRuntimeResults.push(await verifyArtifactSection({
      id: "private_tool_codex_acceptance",
      artifactPath: codexTranscriptPath,
      releaseCandidate,
    }, () => verifyDojoPrivateToolCodexAcceptanceArtifact({
      transcriptPath: codexTranscriptPath,
      releaseCandidate,
    })));
  }

  const conformanceResults = [];
  const conformanceSelfCheckResults = [];
  const shouldVerifyDeployedHostConformance = releaseCandidate
    || args["mcp-host-conformance-report"]
    || args["private-tool-stdio-host-conformance"]
    || args["private-tool-codex-host-conformance"];
  const shouldVerifyMcpHostConformanceSelfCheck = releaseCandidate
    || args["mcp-host-conformance-self-check-report"]
    || args["mcp-host-conformance-self-check-evidence"];
  if (shouldVerifyMcpHostConformanceSelfCheck) {
    const selfCheckGate = findGate(manifest, "dojo_mcp_host_conformance_self_check") || {};
    const reportPath = resolveRepoPath(args["mcp-host-conformance-self-check-report"]
      || selfCheckGate.default_report_path
      || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.json"));
    const evidencePath = resolveRepoPath(args["mcp-host-conformance-self-check-evidence"]
      || selfCheckGate.default_evidence_path
      || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.evidence.json"));
    conformanceSelfCheckResults.push(await verifyArtifactSection({
      id: "dojo_mcp_host_conformance_self_check",
      artifactPath: reportPath,
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoMcpHostConformanceSelfCheckArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate,
    })));
  }
  if (shouldVerifyDeployedHostConformance) {
    const stdioHostGate = findGate(manifest, "private_tool_stdio_host_conformance") || {};
    const codexHostGate = findGate(manifest, "private_tool_codex_host_conformance") || {};
    const reportPath = resolveRepoPath(args["mcp-host-conformance-report"]
      || findGate(manifest, "dojo_mcp_host_conformance")?.default_report_path
      || path.join(DEFAULT_CONFORMANCE_LIVE_DIR, "dojo-mcp-host-conformance.json"));
    const evidencePath = resolveRepoPath(args["mcp-host-conformance-evidence"]
      || findGate(manifest, "dojo_mcp_host_conformance")?.default_evidence_path
      || path.join(DEFAULT_CONFORMANCE_LIVE_DIR, "dojo-mcp-host-conformance.evidence.json"));
    const stdioTranscriptPath = resolveRepoPath(args["private-tool-stdio-host-conformance"]
      || stdioHostGate.default_report_path
      || path.join(DEFAULT_PRIVATE_TOOL_STDIO_HOST_CONFORMANCE_DIR, "mcp-stdio-private-tool-acceptance.json"));
    const codexTranscriptPath = resolveRepoPath(args["private-tool-codex-host-conformance"]
      || codexHostGate.default_report_path
      || path.join(DEFAULT_PRIVATE_TOOL_CODEX_HOST_CONFORMANCE_DIR, "codex-private-tool-acceptance.json"));
    conformanceResults.push(await verifyArtifactSection({
      id: "dojo_mcp_host_conformance",
      artifactPath: reportPath,
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoMcpHostConformanceArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate,
    })));
    conformanceResults.push(await verifyArtifactSection({
      id: "private_tool_stdio_host_conformance",
      artifactPath: stdioTranscriptPath,
      releaseCandidate,
    }, () => verifyDojoPrivateToolStdioHostConformanceArtifact({
      transcriptPath: stdioTranscriptPath,
      releaseCandidate,
    })));
    conformanceResults.push(await verifyArtifactSection({
      id: "private_tool_codex_host_conformance",
      artifactPath: codexTranscriptPath,
      releaseCandidate,
    }, () => verifyDojoPrivateToolCodexHostConformanceArtifact({
      transcriptPath: codexTranscriptPath,
      releaseCandidate,
    })));
  }

  const managedKeySigningResults = [];
  if (releaseCandidate || truthy(args["include-managed-key-signing"]) || args["managed-key-signing-evidence"]) {
    const managedKeyGate = findGate(manifest, "dojo_managed_key_signing_self_check") || {};
    const evidencePath = resolveRepoPath(args["managed-key-signing-evidence"]
      || managedKeyGate.default_evidence_path
      || path.join(DEFAULT_MANAGED_KEY_SIGNING_DIR, "dojo-managed-key-signing.evidence.json"));
    managedKeySigningResults.push(await verifyArtifactSection({
      id: "dojo_managed_key_signing_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoManagedKeySigningEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const publicProofVerificationResults = [];
  if (releaseCandidate || truthy(args["include-public-proof-verification"]) || args["public-proof-verification-evidence"]) {
    const publicProofGate = findGate(manifest, "dojo_public_proof_verification_self_check") || {};
    const evidencePath = resolveRepoPath(args["public-proof-verification-evidence"]
      || publicProofGate.default_evidence_path
      || path.join(DEFAULT_PUBLIC_PROOF_VERIFICATION_DIR, "dojo-public-proof-verification.evidence.json"));
    publicProofVerificationResults.push(await verifyArtifactSection({
      id: "dojo_public_proof_verification_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoPublicProofVerificationEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const governanceLifecycleResults = [];
  if (releaseCandidate || truthy(args["include-governance-lifecycle"]) || args["governance-lifecycle-evidence"]) {
    const governanceGate = findGate(manifest, "dojo_governance_lifecycle_self_check") || {};
    const evidencePath = resolveRepoPath(args["governance-lifecycle-evidence"]
      || governanceGate.default_evidence_path
      || path.join(DEFAULT_GOVERNANCE_LIFECYCLE_DIR, "dojo-governance-lifecycle.evidence.json"));
    governanceLifecycleResults.push(await verifyArtifactSection({
      id: "dojo_governance_lifecycle_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoGovernanceLifecycleEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const graphRuntimeResults = [];
  if (releaseCandidate || truthy(args["include-graph-runtime"]) || args["graph-runtime-evidence"]) {
    const graphRuntimeGate = findGate(manifest, "dojo_graph_runtime_self_check") || {};
    const evidencePath = resolveRepoPath(args["graph-runtime-evidence"]
      || graphRuntimeGate.default_evidence_path
      || path.join(DEFAULT_GRAPH_RUNTIME_DIR, "dojo-graph-runtime.evidence.json"));
    graphRuntimeResults.push(await verifyArtifactSection({
      id: "dojo_graph_runtime_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoGraphRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const ghostModeEvidenceResults = [];
  if (releaseCandidate || truthy(args["include-ghost-mode-evidence"]) || args["ghost-mode-evidence"]) {
    const ghostModeGate = findGate(manifest, "dojo_ghost_mode_evidence_self_check") || {};
    const evidencePath = resolveRepoPath(args["ghost-mode-evidence"]
      || ghostModeGate.default_evidence_path
      || path.join(DEFAULT_GHOST_MODE_EVIDENCE_DIR, "dojo-ghost-mode-evidence.evidence.json"));
    ghostModeEvidenceResults.push(await verifyArtifactSection({
      id: "dojo_ghost_mode_evidence_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoGhostModeEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const skillPassportResults = [];
  if (releaseCandidate || truthy(args["include-skill-passport"]) || args["skill-passport-evidence"]) {
    const skillPassportGate = findGate(manifest, "dojo_skill_passport_self_check") || {};
    const evidencePath = resolveRepoPath(args["skill-passport-evidence"]
      || skillPassportGate.default_evidence_path
      || path.join(DEFAULT_SKILL_PASSPORT_DIR, "dojo-skill-passport.evidence.json"));
    skillPassportResults.push(await verifyArtifactSection({
      id: "dojo_skill_passport_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoSkillPassportEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const timeMachineDebuggerResults = [];
  if (releaseCandidate || truthy(args["include-time-machine-debugger"]) || args["time-machine-debugger-evidence"]) {
    const timeMachineGate = findGate(manifest, "dojo_time_machine_debugger_self_check") || {};
    const evidencePath = resolveRepoPath(args["time-machine-debugger-evidence"]
      || timeMachineGate.default_evidence_path
      || path.join(DEFAULT_TIME_MACHINE_DEBUGGER_DIR, "dojo-time-machine-debugger.evidence.json"));
    timeMachineDebuggerResults.push(await verifyArtifactSection({
      id: "dojo_time_machine_debugger_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoTimeMachineDebuggerEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const vivariumRuntimeResults = [];
  if (releaseCandidate || truthy(args["include-vivarium-runtime"]) || args["vivarium-runtime-evidence"]) {
    const vivariumRuntimeGate = findGate(manifest, "dojo_vivarium_runtime_self_check") || {};
    const evidencePath = resolveRepoPath(args["vivarium-runtime-evidence"]
      || vivariumRuntimeGate.default_evidence_path
      || path.join(DEFAULT_VIVARIUM_RUNTIME_DIR, "dojo-vivarium-runtime.evidence.json"));
    vivariumRuntimeResults.push(await verifyArtifactSection({
      id: "dojo_vivarium_runtime_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoVivariumRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const checkrideLicenseResults = [];
  if (releaseCandidate || truthy(args["include-checkride-license"]) || args["checkride-license-evidence"]) {
    const checkrideLicenseGate = findGate(manifest, "dojo_checkride_license_self_check") || {};
    const evidencePath = resolveRepoPath(args["checkride-license-evidence"]
      || checkrideLicenseGate.default_evidence_path
      || path.join(DEFAULT_CHECKRIDE_LICENSE_DIR, "dojo-checkride-license.evidence.json"));
    checkrideLicenseResults.push(await verifyArtifactSection({
      id: "dojo_checkride_license_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoCheckrideLicenseEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const caseLawRuntimeResults = [];
  if (releaseCandidate || truthy(args["include-case-law-runtime"]) || args["case-law-runtime-evidence"]) {
    const caseLawRuntimeGate = findGate(manifest, "dojo_case_law_runtime_self_check") || {};
    const evidencePath = resolveRepoPath(args["case-law-runtime-evidence"]
      || caseLawRuntimeGate.default_evidence_path
      || path.join(DEFAULT_CASE_LAW_RUNTIME_DIR, "dojo-case-law-runtime.evidence.json"));
    caseLawRuntimeResults.push(await verifyArtifactSection({
      id: "dojo_case_law_runtime_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoCaseLawRuntimeEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const hostedRuntimeGatewayResults = [];
  if (releaseCandidate || truthy(args["include-hosted-runtime-gateway"]) || args["hosted-runtime-gateway-evidence"]) {
    const hostedRuntimeGatewayGate = findGate(manifest, "dojo_hosted_runtime_gateway_self_check") || {};
    const evidencePath = resolveRepoPath(args["hosted-runtime-gateway-evidence"]
      || hostedRuntimeGatewayGate.default_evidence_path
      || path.join(DEFAULT_HOSTED_RUNTIME_GATEWAY_DIR, "dojo-hosted-runtime-gateway.evidence.json"));
    hostedRuntimeGatewayResults.push(await verifyArtifactSection({
      id: "dojo_hosted_runtime_gateway_self_check",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoHostedRuntimeGatewayEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const securityResults = [];
  if (releaseCandidate || args["security-abuse-evidence"]) {
    const evidencePath = resolveRepoPath(args["security-abuse-evidence"] || path.join(DEFAULT_SECURITY_ABUSE_DIR, "dojo-security-abuse.evidence.json"));
    securityResults.push(await verifyArtifactSection({
      id: "security_abuse_suite",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoSecurityAbuseEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const complianceExportResults = [];
  if (releaseCandidate || args["compliance-export-evidence"]) {
    const complianceGate = findGate(manifest, "compliance_export_suite") || {};
    const evidencePath = resolveRepoPath(args["compliance-export-evidence"]
      || complianceGate.default_evidence_path
      || path.join(DEFAULT_COMPLIANCE_EXPORT_DIR, "dojo-compliance-export.evidence.json"));
    complianceExportResults.push(await verifyArtifactSection({
      id: "compliance_export_suite",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoComplianceExportEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const privacyRedactionResults = [];
  if (releaseCandidate || args["privacy-redaction-evidence"]) {
    const privacyGate = findGate(manifest, "privacy_redaction_suite") || {};
    const evidencePath = resolveRepoPath(args["privacy-redaction-evidence"]
      || privacyGate.default_evidence_path
      || path.join(DEFAULT_PRIVACY_REDACTION_DIR, "dojo-privacy-redaction.evidence.json"));
    privacyRedactionResults.push(await verifyArtifactSection({
      id: "privacy_redaction_suite",
      evidencePath,
      releaseCandidate,
    }, () => verifyDojoPrivacyRedactionEvidenceArtifact({
      evidencePath,
      releaseCandidate,
    })));
  }

  const chaosPerformanceResults = [];
  if (truthy(args["enterprise-release"]) || truthy(args["include-chaos-performance"]) || args["chaos-performance-evidence"]) {
    const evidencePath = resolveRepoPath(args["chaos-performance-evidence"] || path.join(DEFAULT_CHAOS_PERFORMANCE_DIR, "dojo-chaos-performance.evidence.json"));
    chaosPerformanceResults.push(await verifyArtifactSection({
      id: "chaos_performance_suite",
      evidencePath,
      enterpriseRelease: truthy(args["enterprise-release"]),
    }, () => verifyDojoChaosPerformanceEvidenceArtifact({
      evidencePath,
      enterpriseRelease: truthy(args["enterprise-release"]),
    })));
  }

  const soakPerformanceResults = [];
  if (truthy(args["enterprise-release"]) || args["soak-summary"]) {
    const summaryPath = resolveRepoPath(args["soak-summary"] || path.join(DEFAULT_SOAK_DIR, "soak-summary.json"));
    const eventsPath = resolveRepoPath(args["soak-events"] || path.join(DEFAULT_SOAK_DIR, "soak-events.ndjson"));
    soakPerformanceResults.push(await verifyArtifactSection({
      id: "soak_performance",
      artifactPath: summaryPath,
      evidencePath: eventsPath,
      enterpriseRelease: truthy(args["enterprise-release"]),
    }, () => verifyDojoSoakPerformanceArtifacts({
      summaryPath,
      eventsPath,
      enterpriseRelease: truthy(args["enterprise-release"]),
      minDurationSeconds: parseOptionalNumber(args["min-soak-duration-s"]),
    })));
  }

  const sections = [manifestResult, ...releaseGateRunnerResults, ...releaseGateVerifierResults, ...proofSelfCheckResults, ...visualResults, ...postgresControlPlaneResults, ...evidenceAuthorityResults, ...implementationStatusResults, ...sourceApiResults, ...generatedPrResults, ...mcpSkillBusResults, ...dockerIntegrationResults, ...liveHostedRuntimeResults, ...conformanceSelfCheckResults, ...conformanceResults, ...managedKeySigningResults, ...publicProofVerificationResults, ...governanceLifecycleResults, ...graphRuntimeResults, ...ghostModeEvidenceResults, ...skillPassportResults, ...timeMachineDebuggerResults, ...vivariumRuntimeResults, ...checkrideLicenseResults, ...caseLawRuntimeResults, ...hostedRuntimeGatewayResults, ...securityResults, ...complianceExportResults, ...privacyRedactionResults, ...chaosPerformanceResults, ...soakPerformanceResults];
  const releaseGateCoverage = getVerifiableReleaseGateCoverage({
    manifest,
    sections,
  });
  const errors = sections.flatMap((section) => section.errors.map((error) => `${section.id}:${error}`));
  if (requireCompleteReleaseGateCoverage && releaseGateCoverage.missing_verifiable_release_gate_ids.length > 0) {
    errors.push(`release_gate_artifact_verification_missing:${releaseGateCoverage.missing_verifiable_release_gate_ids.join(",")}`);
  }
  return {
    schema_version: "synthi.dojo.releaseGateVerification.v1",
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    complete_release_gate_coverage_required: requireCompleteReleaseGateCoverage,
    verifiable_release_gate_ids: releaseGateCoverage.verifiable_release_gate_ids,
    attempted_release_gate_ids: releaseGateCoverage.attempted_release_gate_ids,
    verified_release_gate_ids: releaseGateCoverage.verified_release_gate_ids,
    failed_verifiable_release_gate_ids: releaseGateCoverage.failed_verifiable_release_gate_ids,
    missing_verifiable_release_gate_ids: releaseGateCoverage.missing_verifiable_release_gate_ids,
    manifest: summarizeSection(manifestResult),
    release_gate_runner: releaseGateRunnerResults.map(summarizeSection),
    release_gate_verifier: releaseGateVerifierResults.map(summarizeSection),
    dojo_self_check: proofSelfCheckResults.map(summarizeSection),
    visual_reports: visualResults.map(summarizeSection),
    postgres_control_plane: postgresControlPlaneResults.map(summarizeSection),
    evidence_authority: evidenceAuthorityResults.map(summarizeSection),
    implementation_status: implementationStatusResults.map(summarizeSection),
    docker_integration: dockerIntegrationResults.map(summarizeSection),
    source_api: sourceApiResults.map(summarizeSection),
    generated_pr: generatedPrResults.map(summarizeSection),
    mcp_skill_bus: mcpSkillBusResults.map(summarizeSection),
    live_hosted_runtime: liveHostedRuntimeResults.map(summarizeSection),
    mcp_host_conformance_self_check: conformanceSelfCheckResults.map(summarizeSection),
    mcp_host_conformance: conformanceResults.map(summarizeSection),
    managed_key_signing: managedKeySigningResults.map(summarizeSection),
    public_proof_verification: publicProofVerificationResults.map(summarizeSection),
    governance_lifecycle: governanceLifecycleResults.map(summarizeSection),
    graph_runtime: graphRuntimeResults.map(summarizeSection),
    ghost_mode_evidence: ghostModeEvidenceResults.map(summarizeSection),
    skill_passport: skillPassportResults.map(summarizeSection),
    time_machine_debugger: timeMachineDebuggerResults.map(summarizeSection),
    vivarium_runtime: vivariumRuntimeResults.map(summarizeSection),
    checkride_license: checkrideLicenseResults.map(summarizeSection),
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

export async function verifyDojoReleaseGateRunReportArtifact({
  id = "release_gate_runner",
  reportPath,
  evidencePath,
  manifest,
  requirePromotionReady = false,
} = {}) {
  const runnerPair = evidencePath
    ? await readDigestCheckedJsonPair({
      id: "release_gate_runner",
      artifactPath: reportPath,
      evidencePath,
      evidenceSchema: "synthi.dojo.releaseGateRunEvidence.v1",
      digestField: "report_sha256",
      bytesField: "report_bytes",
      pathField: "report_path",
    })
    : { artifact: await readJsonFile(reportPath), evidence: null, digest: { errors: [] } };
  const report = runnerPair.artifact;
  const errors = [];
  errors.push(...(runnerPair.digest?.errors || []));
  const gatesById = new Map((Array.isArray(manifest?.gates) ? manifest.gates : []).map((gate) => [gate.id, gate]));
  if (report?.schema_version !== "synthi.dojo.releaseGateRun.v1") {
    errors.push(`runner_schema_mismatch:${report?.schema_version || "missing"}`);
  }
  if (report?.ok !== true) errors.push("runner_report_not_ok");
  if (report?.manifest?.validation_ok !== true) errors.push("runner_manifest_validation_not_ok");
  const expectedManifestSha256 = sha256(JSON.stringify(manifest || {}));
  if (report?.manifest?.sha256 !== expectedManifestSha256) {
    errors.push(`runner_manifest_sha256_mismatch:${report?.manifest?.sha256 || "missing"}:${expectedManifestSha256}`);
  }
  const selectedGateIds = Array.isArray(report?.plan?.selected_gate_ids) ? report.plan.selected_gate_ids : [];
  const unknownGateIds = Array.isArray(report?.plan?.unknown_gate_ids) ? report.plan.unknown_gate_ids : [];
  for (const gateId of selectedGateIds) {
    if (!gatesById.has(gateId)) errors.push(`runner_unknown_selected_gate:${gateId}`);
  }
  for (const gateId of unknownGateIds) errors.push(`runner_unknown_gate:${gateId}`);
  const results = Array.isArray(report?.results) ? report.results : [];
  const counts = {
    selected: selectedGateIds.length,
    planned: results.filter((result) => result.status === "planned").length,
    executed: results.filter((result) => result.executed === true).length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
  for (const key of Object.keys(counts)) {
    if (report?.counts?.[key] !== counts[key]) errors.push(`runner_count_mismatch:${key}:${report?.counts?.[key]}:${counts[key]}`);
  }
  if (report?.plan?.gate_count !== results.length) {
    errors.push(`runner_plan_result_count_mismatch:${report?.plan?.gate_count}:${results.length}`);
  }
  if (report?.counts?.selected !== selectedGateIds.length) {
    errors.push(`runner_selected_count_mismatch:${report?.counts?.selected}:${selectedGateIds.length}`);
  }
  if (runnerPair.evidence) {
    validateRunnerEvidenceSummary({ evidence: runnerPair.evidence, report, results, errors });
  }
  if (requirePromotionReady) {
    if (report?.dry_run === true) errors.push("runner_report_dry_run");
    if (report?.complete !== true) errors.push("runner_report_not_complete");
    if (report?.promotion_ready !== true) errors.push("runner_report_not_promotion_ready");
    if (counts.planned > 0) errors.push(`runner_planned_gates_present:${counts.planned}`);
    if (counts.skipped > 0) errors.push(`runner_skipped_gates_present:${counts.skipped}`);
    if (counts.failed > 0) errors.push(`runner_failed_gates_present:${counts.failed}`);
  }
  for (const result of results) {
    await validateRunnerGateResult({
      result,
      gatesById,
      requirePromotionReady,
      errors,
    });
  }
  return {
    id,
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    evidence_path: evidencePath,
    report_schema_version: report?.schema_version,
    result_count: results.length,
    release_candidate: Boolean(requirePromotionReady),
    runner_scope: report?.scope,
    dry_run: Boolean(report?.dry_run),
    complete: Boolean(report?.complete),
    promotion_ready: Boolean(report?.promotion_ready),
  };
}

export async function verifyDojoReleaseGateVerifierSelfCheckArtifact({ reportPath, evidencePath }) {
  const verifierPair = await readDigestCheckedJsonPair({
    id: "dojo_release_gate_verifier_self_check",
    artifactPath: reportPath,
    evidencePath,
    evidenceSchema: "synthi.dojo.releaseGateVerifierSelfCheckEvidence.v1",
    digestField: "report_sha256",
    bytesField: "report_bytes",
    pathField: "report_path",
  });
  const report = verifierPair.artifact;
  const evidence = verifierPair.evidence;
  const errors = [...(verifierPair.digest?.errors || [])];
  if (report?.schema_version !== "synthi.dojo.releaseGateVerifierSelfCheck.v1") {
    errors.push(`verifier_self_check_schema_mismatch:${report?.schema_version || "missing"}`);
  }
  if (report?.ok !== true) errors.push("verifier_self_check_not_ok");
  const verifiedSections = Array.isArray(report?.verified_sections) ? report.verified_sections : [];
  const rejectedControls = Array.isArray(report?.rejected_controls) ? report.rejected_controls : [];
  if (evidence?.ok !== report?.ok) {
    errors.push(`verifier_self_check_evidence_ok_mismatch:${evidence?.ok}:${report?.ok}`);
  }
  if (Number(evidence?.verified_section_count) !== verifiedSections.length) {
    errors.push(`verifier_self_check_section_count_mismatch:${evidence?.verified_section_count}:${verifiedSections.length}`);
  }
  if (Number(evidence?.rejected_control_count) !== rejectedControls.length) {
    errors.push(`verifier_self_check_rejected_count_mismatch:${evidence?.rejected_control_count}:${rejectedControls.length}`);
  }
  const evidenceVerifiedIds = new Set(Array.isArray(evidence?.verified_section_ids) ? evidence.verified_section_ids : []);
  const sectionOk = (id) => verifiedSections.some((section) => section?.id === id && section.ok === true);
  for (const id of ["release_gate_manifest", "dojo_release_gate_runner_self_check"]) {
    const section = verifiedSections.find((item) => item?.id === id);
    if (!section) errors.push(`verifier_self_check_missing_verified_section:${id}`);
    else if (section.ok !== true) errors.push(`verifier_self_check_section_not_ok:${id}`);
    if (!evidenceVerifiedIds.has(id)) errors.push(`verifier_self_check_evidence_missing_verified_section:${id}`);
  }
  if (verifiedSections.some((section) => section?.ok !== true)) {
    errors.push("verifier_self_check_verified_section_failed");
  }
  if (rejectedControls.length === 0) errors.push("verifier_self_check_missing_negative_controls");
  if (rejectedControls.some((section) => section?.ok === true)) {
    errors.push("verifier_self_check_negative_control_passed");
  }
  if (evidence?.manifest_verified !== sectionOk("release_gate_manifest")) {
    errors.push("verifier_self_check_manifest_flag_mismatch");
  }
  if (evidence?.release_gate_runner_self_check_verified !== sectionOk("dojo_release_gate_runner_self_check")) {
    errors.push("verifier_self_check_runner_flag_mismatch");
  }
  if (evidence?.negative_controls_present !== (rejectedControls.length > 0)) {
    errors.push("verifier_self_check_negative_control_flag_mismatch");
  }
  return {
    id: "dojo_release_gate_verifier_self_check",
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    evidence_path: evidencePath,
    report_schema_version: report?.schema_version,
    verified_section_count: verifiedSections.length,
    rejected_control_count: rejectedControls.length,
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
  if (summary?.production_proof_capsule_id !== productionEvidence?.proof_capsule_id) {
    errors.push(`dojo_self_check_production_proof_capsule_mismatch:${summary?.production_proof_capsule_id || "missing"}:${productionEvidence?.proof_capsule_id || "missing"}`);
  }
  if (productionEvidence?.proof_record?.capsule_id !== productionEvidence?.proof_capsule_id) {
    errors.push(`dojo_self_check_proof_record_capsule_mismatch:${productionEvidence?.proof_record?.capsule_id || "missing"}:${productionEvidence?.proof_capsule_id || "missing"}`);
  }
  if (productionEvidence?.runtime_session?.run_id !== productionEvidence?.run_id) {
    errors.push(`dojo_self_check_runtime_session_run_mismatch:${productionEvidence?.runtime_session?.run_id || "missing"}:${productionEvidence?.run_id || "missing"}`);
  }
  if (productionEvidence?.runtime_authorization?.session_id !== productionEvidence?.runtime_session?.session_id) {
    errors.push(`dojo_self_check_runtime_authorization_session_mismatch:${productionEvidence?.runtime_authorization?.session_id || "missing"}:${productionEvidence?.runtime_session?.session_id || "missing"}`);
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

function validateRequiredEvidenceTestFiles({
  evidence,
  requiredTestFiles,
  prefix,
  requireTestExecution = false,
}) {
  const errors = [];
  const testFiles = Array.isArray(evidence?.test_files) ? evidence.test_files.map(String) : [];
  const missingTestFiles = requiredTestFiles.filter((file) => !testFiles.includes(file));
  if (missingTestFiles.length > 0) {
    errors.push(`${prefix}_required_test_files_missing:${missingTestFiles.join(",")}`);
  }
  if (Number(evidence?.test_file_count || 0) !== testFiles.length) {
    errors.push(`${prefix}_declared_test_file_count_mismatch:${evidence?.test_file_count ?? "missing"}:${testFiles.length}`);
  }
  errors.push(...validateEvidenceTestExecutionBindings({
    evidence,
    requiredTestFiles,
    prefix,
    requireTestExecution,
  }));
  return errors;
}

function validateEvidenceTestExecutionBindings({
  evidence,
  requiredTestFiles,
  prefix,
  requireTestExecution = false,
}) {
  const errors = [];
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    if (requireTestExecution) errors.push(`${prefix}_test_execution_missing`);
    return errors;
  }
  if (requireTestExecution) {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`${prefix}_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push(`${prefix}_test_execution_timed_out`);
    }
  }
  const args = Array.isArray(testExecution.args) ? testExecution.args.map(String) : [];
  if (args.length === 0) {
    if (requireTestExecution) errors.push(`${prefix}_test_execution_args_missing`);
    return errors;
  }
  const missingExecutedTestFiles = requiredTestFiles.filter((file) => !args.includes(file));
  if (missingExecutedTestFiles.length > 0) {
    errors.push(`${prefix}_test_execution_required_args_missing:${missingExecutedTestFiles.join(",")}`);
  }
  return errors;
}

export async function verifyDojoEvidenceAuthorityEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoEvidenceAuthorityEvidenceForMilestone(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_evidence_authority_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    result_count: Number(evidence?.test_summary?.total_tests || 0),
  };
}

export function validateDojoEvidenceAuthorityEvidenceForMilestone(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.evidenceAuthorityEvidence.v1") {
    errors.push(`evidence_authority_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("evidence_authority_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`evidence_authority_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("evidence_authority_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`evidence_authority_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`evidence_authority_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
    prefix: "evidence_authority",
  }));
  const untestedRequiredCapabilities = DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`evidence_authority_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`evidence_authority_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`evidence_authority_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.evidence_authority || {};
  for (const [field, errorCode] of [
    ["canonical_record_hash_required", "evidence_authority_canonical_hash_requirement_missing"],
    ["record_signature_verification_required", "evidence_authority_signature_requirement_missing"],
    ["tamper_detection_required", "evidence_authority_tamper_requirement_missing"],
    ["claim_freshness_required", "evidence_authority_claim_freshness_requirement_missing"],
    ["claim_scope_required", "evidence_authority_claim_scope_requirement_missing"],
    ["claim_kind_required", "evidence_authority_claim_kind_requirement_missing"],
    ["ledger_resolver_fail_closed_required", "evidence_authority_resolver_requirement_missing"],
    ["redaction_manifest_required", "evidence_authority_redaction_manifest_requirement_missing"],
    ["redacted_export_required", "evidence_authority_redacted_export_requirement_missing"],
    ["evidence_retention_policy_required", "evidence_authority_retention_policy_requirement_missing"],
    ["legal_hold_blocks_disposal_required", "evidence_authority_legal_hold_requirement_missing"],
    ["external_storage_custody_receipts_required", "evidence_authority_external_storage_custody_requirement_missing"],
    ["proof_issue_claim_verification_required", "evidence_authority_proof_issue_requirement_missing"],
    ["proof_validation_rejects_self_attested_claims_required", "evidence_authority_self_attested_rejection_requirement_missing"],
    ["durable_postgres_ledger_gate_required", "evidence_authority_durable_postgres_gate_requirement_missing"],
    ["self_check_executes_tests_required", "evidence_authority_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (contract.durable_postgres_ledger_gate_id !== "dojo_postgres_control_plane_self_check") {
    errors.push("evidence_authority_durable_postgres_gate_id_missing");
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("evidence_authority_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`evidence_authority_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("evidence_authority_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("evidence_authority_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("evidence_authority_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`evidence_authority_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`evidence_authority_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("evidence_authority_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`evidence_authority_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoImplementationStatusEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoImplementationStatusEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_implementation_status_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
    result_count: Number(evidence?.test_summary?.total_tests || 0),
  };
}

export function validateDojoImplementationStatusEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.implementationStatusEvidence.v1") {
    errors.push(`implementation_status_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("implementation_status_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`implementation_status_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("implementation_status_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`implementation_status_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`implementation_status_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
    prefix: "implementation_status",
  }));
  const untestedRequiredCapabilities = DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`implementation_status_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`implementation_status_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`implementation_status_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.implementation_status_contract || {};
  for (const [field, errorCode] of [
    ["stable_vocabulary_required", "implementation_status_vocabulary_requirement_missing"],
    ["every_tool_classified_required", "implementation_status_tool_classification_requirement_missing"],
    ["machine_manifest_sync_required", "implementation_status_manifest_sync_requirement_missing"],
    ["unknown_tool_fails_planned_required", "implementation_status_unknown_tool_requirement_missing"],
    ["production_runtime_claim_boundary_required", "implementation_status_production_boundary_requirement_missing"],
    ["runtime_scope_required_for_executable_required", "implementation_status_runtime_scope_requirement_missing"],
    ["report_surface_no_overclaim_required", "implementation_status_report_boundary_requirement_missing"],
    ["proof_dispatch_hosted_runtime_boundary_required", "implementation_status_proof_dispatch_boundary_requirement_missing"],
    ["ghost_mode_non_mutating_boundary_required", "implementation_status_ghost_mode_boundary_requirement_missing"],
    ["control_plane_write_boundary_required", "implementation_status_control_plane_boundary_requirement_missing"],
    ["immutable_metadata_required", "implementation_status_immutable_metadata_requirement_missing"],
    ["self_check_executes_tests_required", "implementation_status_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("implementation_status_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`implementation_status_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("implementation_status_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("implementation_status_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("implementation_status_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`implementation_status_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`implementation_status_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("implementation_status_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`implementation_status_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
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
    ["license_store_expiry_application_required", "source_drift_license_store_expiry_requirement_missing"],
    ["recertification_handoff_required", "source_drift_recertification_handoff_requirement_missing"],
    ["self_check_executes_tests_required", "source_drift_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("source_drift_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`source_drift_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("source_drift_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("source_drift_test_execution_args_missing");
    }
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

export async function verifyDojoAgentReadyUiContractEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoAgentReadyUiContractEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_agent_ready_ui_contract_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoAgentReadyUiContractEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.agentReadyUiContractEvidence.v1") {
    errors.push(`agent_ready_ui_contract_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("agent_ready_ui_contract_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`agent_ready_ui_contract_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("agent_ready_ui_contract_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`agent_ready_ui_contract_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`agent_ready_ui_contract_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
    prefix: "agent_ready_ui_contract",
  }));
  const untestedRequiredCapabilities = DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`agent_ready_ui_contract_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`agent_ready_ui_contract_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`agent_ready_ui_contract_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.agent_ready_ui_contract || {};
  for (const [field, errorCode] of [
    ["schema_linter_required", "agent_ready_ui_contract_schema_linter_requirement_missing"],
    ["stable_locator_required", "agent_ready_ui_contract_stable_locator_requirement_missing"],
    ["success_hook_required", "agent_ready_ui_contract_success_hook_requirement_missing"],
    ["proof_hook_required", "agent_ready_ui_contract_proof_hook_requirement_missing"],
    ["proof_required_for_risky_action_required", "agent_ready_ui_contract_proof_required_requirement_missing"],
    ["accessibility_label_required", "agent_ready_ui_contract_accessibility_requirement_missing"],
    ["blocked_contexts_required", "agent_ready_ui_contract_blocked_contexts_requirement_missing"],
    ["runtime_enum_validation_required", "agent_ready_ui_contract_enum_validation_requirement_missing"],
    ["malformed_array_safety_required", "agent_ready_ui_contract_malformed_array_requirement_missing"],
    ["proof_risk_mismatch_warning_required", "agent_ready_ui_contract_mismatch_warning_requirement_missing"],
    ["self_check_executes_tests_required", "agent_ready_ui_contract_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("agent_ready_ui_contract_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`agent_ready_ui_contract_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("agent_ready_ui_contract_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("agent_ready_ui_contract_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("agent_ready_ui_contract_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`agent_ready_ui_contract_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`agent_ready_ui_contract_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("agent_ready_ui_contract_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`agent_ready_ui_contract_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
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
    ["self_check_executes_tests_required", "api_tool_compiler_self_check_execution_requirement_missing"],
  ]) {
    if (promotionContract[field] !== true) errors.push(errorCode);
  }
  if (promotionContract.production_candidate_only_execution_allowed !== false) {
    errors.push("api_tool_compiler_candidate_only_production_allowed");
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("api_tool_compiler_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`api_tool_compiler_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("api_tool_compiler_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("api_tool_compiler_test_execution_args_missing");
    }
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
    ["self_check_executes_tests_required", "generated_pr_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("generated_pr_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`generated_pr_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("generated_pr_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("generated_pr_test_execution_args_missing");
    }
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

export async function verifyDojoMcpSkillBusEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoMcpSkillBusEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_mcp_skill_bus_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoMcpSkillBusEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.mcpSkillBusEvidence.v1") {
    errors.push(`mcp_skill_bus_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("mcp_skill_bus_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`mcp_skill_bus_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("mcp_skill_bus_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`mcp_skill_bus_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_MCP_SKILL_BUS_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`mcp_skill_bus_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_MCP_SKILL_BUS_TEST_FILES,
    prefix: "mcp_skill_bus",
  }));
  const untestedRequiredCapabilities = DOJO_MCP_SKILL_BUS_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`mcp_skill_bus_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`mcp_skill_bus_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`mcp_skill_bus_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.mcp_skill_bus_contract || {};
  for (const [field, errorCode] of [
    ["certified_competency_listing_required", "mcp_skill_bus_competency_listing_requirement_missing"],
    ["tenant_authorization_required", "mcp_skill_bus_tenant_authorization_requirement_missing"],
    ["signed_manifest_required", "mcp_skill_bus_signed_manifest_requirement_missing"],
    ["manifest_signature_verification_required", "mcp_skill_bus_manifest_signature_requirement_missing"],
    ["manifest_tamper_rejection_required", "mcp_skill_bus_manifest_tamper_requirement_missing"],
    ["manifest_production_readiness_required", "mcp_skill_bus_manifest_readiness_requirement_missing"],
    ["version_pinning_required", "mcp_skill_bus_version_pinning_requirement_missing"],
    ["api_backed_tool_resolution_required", "mcp_skill_bus_api_backed_tool_resolution_requirement_missing"],
    ["api_backed_canonical_dispatch_context_required", "mcp_skill_bus_api_backed_dispatch_context_requirement_missing"],
    ["ambiguous_tool_block_required", "mcp_skill_bus_ambiguous_tool_requirement_missing"],
    ["proof_validation_required", "mcp_skill_bus_proof_validation_requirement_missing"],
    ["proof_consume_required", "mcp_skill_bus_proof_consume_requirement_missing"],
    ["proof_binding_required", "mcp_skill_bus_proof_binding_requirement_missing"],
    ["dry_run_side_effect_free_required", "mcp_skill_bus_dry_run_requirement_missing"],
    ["fail_closed_required", "mcp_skill_bus_fail_closed_requirement_missing"],
    ["executor_block_propagation_required", "mcp_skill_bus_executor_block_requirement_missing"],
    ["rate_limit_required", "mcp_skill_bus_rate_limit_requirement_missing"],
    ["audit_events_required", "mcp_skill_bus_audit_requirement_missing"],
    ["durable_registration_required", "mcp_skill_bus_durable_registration_requirement_missing"],
    ["revocation_required", "mcp_skill_bus_revocation_requirement_missing"],
    ["durable_invocation_custody_required", "mcp_skill_bus_invocation_custody_requirement_missing"],
    ["tenant_boundary_required", "mcp_skill_bus_tenant_boundary_requirement_missing"],
    ["direct_call_policy_required", "mcp_skill_bus_direct_call_policy_requirement_missing"],
    ["postgres_registry_required", "mcp_skill_bus_postgres_registry_requirement_missing"],
    ["self_check_executes_tests_required", "mcp_skill_bus_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("mcp_skill_bus_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`mcp_skill_bus_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("mcp_skill_bus_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("mcp_skill_bus_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("mcp_skill_bus_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`mcp_skill_bus_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`mcp_skill_bus_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("mcp_skill_bus_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`mcp_skill_bus_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
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

const DOJO_MCP_HOST_CONFORMANCE_SELF_CHECK_REQUIREMENTS = [
  {
    id: "loopback_rejection",
    label: "loopback rejection",
    error: "conformance_self_check_loopback_rejection_missing",
  },
  {
    id: "private_network_rejection",
    label: "private network rejection",
    error: "conformance_self_check_private_network_rejection_missing",
  },
  {
    id: "link_local_rejection",
    label: "link-local rejection",
    error: "conformance_self_check_link_local_rejection_missing",
  },
  {
    id: "unique_local_ipv6_rejection",
    label: "unique local ipv6 rejection",
    error: "conformance_self_check_unique_local_ipv6_rejection_missing",
  },
  {
    id: "report_redaction",
    label: "report redaction",
    error: "conformance_self_check_report_redaction_missing",
  },
];

export async function verifyDojoMcpHostConformanceSelfCheckArtifacts({ reportPath, evidencePath, releaseCandidate = false }) {
  const { artifact: report, evidence, digest } = await readDigestCheckedJsonPair({
    id: "dojo_mcp_host_conformance_self_check",
    artifactPath: reportPath,
    evidencePath,
    evidenceSchema: "synthi.dojo.mcpHostConformanceEvidence.v1",
    digestField: "report_sha256",
    bytesField: "report_bytes",
    pathField: "report_path",
  });
  const errors = [...digest.errors, ...validateDojoMcpHostConformanceSelfCheckReport(report).errors];
  if (evidence.gate_ok !== true) errors.push("conformance_self_check_evidence_gate_not_ok");
  if (Number(evidence.gate_failed || 0) !== 0) {
    errors.push(`conformance_self_check_evidence_gate_failed:${evidence.gate_failed}`);
  }
  return {
    id: "dojo_mcp_host_conformance_self_check",
    ok: errors.length === 0,
    errors,
    artifact_path: reportPath,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: report?.schema_version ?? null,
  };
}

export function validateDojoMcpHostConformanceSelfCheckReport(report) {
  const errors = [];
  if (report?.schema_version !== "synthi.dojo.mcpHostConformance.selfCheck.v1") {
    errors.push(`conformance_self_check_schema_mismatch:${report?.schema_version || "missing"}`);
  }
  if (report?.conformance?.ok !== true) errors.push("conformance_self_check_host_not_ok");
  if (report?.conformance?.mcp_host_class !== "remote") {
    errors.push(`conformance_self_check_host_not_remote:${report?.conformance?.mcp_host_class || "missing"}`);
  }
  if (report?.conformance?.non_loopback_mcp_host !== true) {
    errors.push("conformance_self_check_non_loopback_host_missing");
  }
  if (report?.config?.raw_backing_tool_required !== true) {
    errors.push("conformance_self_check_raw_backing_tool_requirement_missing");
  }
  if (report?.release_gate?.ok !== true) errors.push("conformance_self_check_release_gate_not_ok");
  if (Number(report?.release_gate?.failed || 0) !== 0) {
    errors.push(`conformance_self_check_release_gate_failed:${report.release_gate.failed}`);
  }
  for (const requirement of DOJO_MCP_HOST_CONFORMANCE_SELF_CHECK_REQUIREMENTS) {
    if (!hasPassingMcpHostConformanceSelfCheck(report, requirement)) {
      errors.push(requirement.error);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

function hasPassingMcpHostConformanceSelfCheck(report, requirement) {
  const structuredChecks = Array.isArray(report?.check_results) ? report.check_results : [];
  if (structuredChecks.some((check) => check?.id === requirement.id && check.ok === true)) return true;
  const labels = new Set((Array.isArray(report?.checks) ? report.checks : []).map((check) => String(check)));
  return labels.has(requirement.label);
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
    requireTestExecution: true,
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

export async function verifyDojoPublicProofVerificationEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoPublicProofVerificationEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_public_proof_verification_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoPublicProofVerificationEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.publicProofVerificationEvidence.v1") {
    errors.push(`public_proof_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("public_proof_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`public_proof_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("public_proof_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`public_proof_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`public_proof_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
    prefix: "public_proof",
  }));
  const untestedRequiredCapabilities = DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`public_proof_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`public_proof_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`public_proof_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.public_proof_verification_contract || {};
  for (const [field, errorCode] of [
    ["external_verifier_required", "public_proof_external_verifier_requirement_missing"],
    ["ed25519_public_key_required", "public_proof_ed25519_requirement_missing"],
    ["evidence_claim_ledger_binding_required", "public_proof_evidence_claim_requirement_missing"],
    ["tamper_and_context_blocks_required", "public_proof_tamper_requirement_missing"],
    ["timestamp_window_required", "public_proof_timestamp_requirement_missing"],
    ["proof_key_custody_policy_required", "public_proof_custody_requirement_missing"],
    ["public_export_required", "public_proof_export_requirement_missing"],
    ["key_custody_metadata_export_required", "public_proof_key_custody_metadata_export_requirement_missing"],
    ["private_secret_exclusion_required", "public_proof_secret_exclusion_requirement_missing"],
    ["tenant_scoped_key_export_required", "public_proof_tenant_export_requirement_missing"],
    ["unavailable_key_marking_required", "public_proof_unavailable_key_requirement_missing"],
    ["self_check_executes_tests_required", "public_proof_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("public_proof_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`public_proof_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`public_proof_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("public_proof_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`public_proof_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution) {
    errors.push("public_proof_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`public_proof_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("public_proof_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("public_proof_test_execution_args_missing");
    }
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
    ["rbac_required", "governance_lifecycle_rbac_requirement_missing"],
    ["store_rbac_required", "governance_lifecycle_store_rbac_requirement_missing"],
    ["case_law_review_required", "governance_lifecycle_case_law_review_requirement_missing"],
    ["license_revocation_required", "governance_lifecycle_license_revocation_requirement_missing"],
    ["recertification_queue_required", "governance_lifecycle_recertification_requirement_missing"],
    ["policy_gates_required", "governance_lifecycle_policy_gates_requirement_missing"],
    ["audit_export_required", "governance_lifecycle_audit_export_requirement_missing"],
    ["compliance_pack_required", "governance_lifecycle_compliance_pack_requirement_missing"],
    ["scheduled_jobs_required", "governance_lifecycle_scheduled_jobs_requirement_missing"],
    ["scheduled_job_runner_tool_required", "governance_lifecycle_scheduled_job_runner_tool_requirement_missing"],
    ["compliance_archive_manifest_required", "governance_lifecycle_compliance_archive_manifest_requirement_missing"],
    ["proof_public_verification_custody_required", "governance_lifecycle_public_verification_requirement_missing"],
    ["malformed_expiry_fails_closed_required", "governance_lifecycle_malformed_expiry_requirement_missing"],
    ["self_check_executes_tests_required", "governance_lifecycle_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("governance_lifecycle_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`governance_lifecycle_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("governance_lifecycle_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("governance_lifecycle_test_execution_args_missing");
    }
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
    ["workflow_step_nodes_required", "graph_runtime_workflow_step_nodes_requirement_missing"],
    ["source_api_binding_required", "graph_runtime_source_api_requirement_missing"],
    ["production_execution_required", "graph_runtime_production_execution_requirement_missing"],
    ["preflight_only_required", "graph_runtime_preflight_requirement_missing"],
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
    ["self_check_executes_tests_required", "graph_runtime_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("graph_runtime_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`graph_runtime_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("graph_runtime_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("graph_runtime_test_execution_args_missing");
    }
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

export async function verifyDojoGhostModeEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoGhostModeEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_ghost_mode_evidence_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoGhostModeEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.ghostModeEvidence.v1") {
    errors.push(`ghost_mode_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("ghost_mode_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`ghost_mode_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("ghost_mode_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`ghost_mode_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`ghost_mode_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
    prefix: "ghost_mode",
  }));
  const untestedRequiredCapabilities = DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`ghost_mode_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`ghost_mode_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`ghost_mode_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.ghost_mode_contract || {};
  for (const [field, errorCode] of [
    ["non_mutating_shadow_run_required", "ghost_mode_non_mutating_requirement_missing"],
    ["shadow_evidence_record_required", "ghost_mode_shadow_evidence_requirement_missing"],
    ["audit_custody_required", "ghost_mode_audit_requirement_missing"],
    ["mismatch_entrustment_block_required", "ghost_mode_entrustment_block_requirement_missing"],
    ["compliance_pack_visibility_required", "ghost_mode_compliance_requirement_missing"],
    ["durable_shadow_evidence_store_required", "ghost_mode_durable_store_requirement_missing"],
    ["tenant_boundary_required", "ghost_mode_tenant_boundary_requirement_missing"],
    ["production_mutation_rejection_required", "ghost_mode_mutation_rejection_requirement_missing"],
    ["operational_filtering_required", "ghost_mode_filtering_requirement_missing"],
    ["self_check_executes_tests_required", "ghost_mode_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("ghost_mode_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`ghost_mode_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`ghost_mode_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("ghost_mode_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`ghost_mode_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution) {
    errors.push("ghost_mode_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`ghost_mode_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("ghost_mode_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("ghost_mode_test_execution_args_missing");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoSkillPassportEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoSkillPassportEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_skill_passport_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoSkillPassportEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.skillPassportEvidence.v1") {
    errors.push(`skill_passport_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("skill_passport_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`skill_passport_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("skill_passport_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`skill_passport_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_SKILL_PASSPORT_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`skill_passport_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_SKILL_PASSPORT_TEST_FILES,
    prefix: "skill_passport",
  }));
  const untestedRequiredCapabilities = DOJO_SKILL_PASSPORT_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`skill_passport_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`skill_passport_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`skill_passport_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.skill_passport_contract || {};
  for (const [field, errorCode] of [
    ["report_only_status_required", "skill_passport_report_only_requirement_missing"],
    ["license_scope_required", "skill_passport_license_scope_requirement_missing"],
    ["readiness_scope_required", "skill_passport_readiness_scope_requirement_missing"],
    ["proof_scope_required", "skill_passport_proof_scope_requirement_missing"],
    ["coverage_and_attack_metrics_required", "skill_passport_coverage_attack_requirement_missing"],
    ["executable_entrustment_provenance_required", "skill_passport_executable_entrustment_requirement_missing"],
    ["published_tool_scope_required", "skill_passport_published_tool_requirement_missing"],
    ["skill_card_action_grouping_required", "skill_passport_action_grouping_requirement_missing"],
    ["proof_badge_required", "skill_passport_proof_badge_requirement_missing"],
    ["practice_guardrail_counts_required", "skill_passport_practice_guardrail_requirement_missing"],
    ["passport_export_required", "skill_passport_export_requirement_missing"],
    ["raw_payload_redaction_required", "skill_passport_redaction_requirement_missing"],
    ["self_check_executes_tests_required", "skill_passport_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("skill_passport_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`skill_passport_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("skill_passport_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("skill_passport_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("skill_passport_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`skill_passport_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`skill_passport_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("skill_passport_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`skill_passport_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function verifyDojoTimeMachineDebuggerEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoTimeMachineDebuggerEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_time_machine_debugger_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoTimeMachineDebuggerEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.timeMachineDebuggerEvidence.v1") {
    errors.push(`time_machine_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("time_machine_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`time_machine_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("time_machine_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`time_machine_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`time_machine_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
    prefix: "time_machine",
  }));
  const untestedRequiredCapabilities = DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`time_machine_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`time_machine_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`time_machine_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.time_machine_contract || {};
  for (const [field, errorCode] of [
    ["deterministic_debug_report_required", "time_machine_deterministic_debug_requirement_missing"],
    ["counterfactual_twin_required", "time_machine_counterfactual_twin_requirement_missing"],
    ["promoted_scenario_selection_required", "time_machine_promoted_scenario_requirement_missing"],
    ["scenario_correlation_required", "time_machine_scenario_correlation_requirement_missing"],
    ["attack_guardrail_correlation_required", "time_machine_attack_guardrail_requirement_missing"],
    ["remediation_cost_policy_required", "time_machine_remediation_cost_requirement_missing"],
    ["baseline_explanation_required", "time_machine_baseline_requirement_missing"],
    ["materialized_runtime_branch_required", "time_machine_runtime_branch_requirement_missing"],
    ["counterfactual_license_impact_required", "time_machine_license_impact_requirement_missing"],
    ["replay_plan_required", "time_machine_replay_plan_requirement_missing"],
    ["honest_projection_status_required", "time_machine_honest_status_requirement_missing"],
    ["self_check_executes_tests_required", "time_machine_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("time_machine_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`time_machine_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`time_machine_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("time_machine_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`time_machine_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution) {
    errors.push("time_machine_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`time_machine_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("time_machine_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("time_machine_test_execution_args_missing");
    }
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
    ["ambiguous_document_names_required", "vivarium_runtime_ambiguous_document_requirement_missing"],
    ["ui_tissue_mutations_required", "vivarium_runtime_ui_tissue_requirement_missing"],
    ["policy_tissue_required", "vivarium_runtime_policy_tissue_requirement_missing"],
    ["expanded_identity_tissue_required", "vivarium_runtime_expanded_identity_tissue_requirement_missing"],
    ["invalid_value_data_tissue_required", "vivarium_runtime_invalid_value_data_tissue_requirement_missing"],
    ["stale_missing_data_tissue_required", "vivarium_runtime_stale_missing_data_tissue_requirement_missing"],
    ["deterministic_reset_required", "vivarium_runtime_reset_requirement_missing"],
    ["budget_enforcement_required", "vivarium_runtime_budget_requirement_missing"],
    ["targeted_graph_execution_required", "vivarium_runtime_targeted_graph_requirement_missing"],
    ["targeted_postcondition_descendants_required", "vivarium_runtime_targeted_postcondition_requirement_missing"],
    ["executable_checkride_required", "vivarium_runtime_checkride_requirement_missing"],
    ["license_constraints_from_blocked_risk_required", "vivarium_runtime_license_constraint_requirement_missing"],
    ["critical_guardrail_failure_required", "vivarium_runtime_critical_guardrail_requirement_missing"],
    ["substrate_hook_passthrough_required", "vivarium_runtime_substrate_hook_requirement_missing"],
    ["evil_twin_attack_measurement_required", "vivarium_runtime_evil_twin_measurement_requirement_missing"],
    ["evil_twin_hardening_loop_required", "vivarium_runtime_evil_twin_hardening_requirement_missing"],
    ["self_check_executes_tests_required", "vivarium_runtime_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("vivarium_runtime_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`vivarium_runtime_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("vivarium_runtime_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("vivarium_runtime_test_execution_args_missing");
    }
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

export async function verifyDojoCheckrideLicenseEvidenceArtifact({ evidencePath, releaseCandidate = false }) {
  const evidence = await readJsonFile(evidencePath);
  const errors = validateDojoCheckrideLicenseEvidenceForRelease(evidence).errors;
  errors.push(...await validateDigestReferencedLogArtifacts(evidence, evidencePath));
  return {
    id: "dojo_checkride_license_self_check",
    ok: errors.length === 0,
    errors,
    evidence_path: evidencePath,
    release_candidate: Boolean(releaseCandidate),
    report_schema_version: evidence?.schema_version ?? null,
  };
}

export function validateDojoCheckrideLicenseEvidenceForRelease(evidence) {
  const errors = [];
  const configuredCapabilities = Array.isArray(evidence?.configured_capabilities)
    ? evidence.configured_capabilities.map(String)
    : [];
  const testedCapabilities = Array.isArray(evidence?.tested_capabilities)
    ? evidence.tested_capabilities.map(String)
    : [];
  if (evidence?.schema_version !== "synthi.dojo.checkrideLicenseEvidence.v1") {
    errors.push(`checkride_license_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("checkride_license_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`checkride_license_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.capability_coverage_complete !== true) errors.push("checkride_license_coverage_incomplete");
  if (Array.isArray(evidence?.missing_capabilities) && evidence.missing_capabilities.length > 0) {
    errors.push(`checkride_license_missing_capabilities:${evidence.missing_capabilities.join(",")}`);
  }
  const missingConfiguredCapabilities = DOJO_CHECKRIDE_LICENSE_CAPABILITIES
    .filter((capability) => !configuredCapabilities.includes(capability));
  if (missingConfiguredCapabilities.length > 0) {
    errors.push(`checkride_license_required_capabilities_missing:${missingConfiguredCapabilities.join(",")}`);
  }
  errors.push(...validateRequiredEvidenceTestFiles({
    evidence,
    requiredTestFiles: DOJO_CHECKRIDE_LICENSE_TEST_FILES,
    prefix: "checkride_license",
  }));
  const untestedRequiredCapabilities = DOJO_CHECKRIDE_LICENSE_CAPABILITIES
    .filter((capability) => !testedCapabilities.includes(capability));
  if (untestedRequiredCapabilities.length > 0) {
    errors.push(`checkride_license_required_capabilities_untested:${untestedRequiredCapabilities.join(",")}`);
  }
  if (Number(evidence?.configured_capability_count || 0) !== configuredCapabilities.length) {
    errors.push(`checkride_license_configured_capability_count_mismatch:${evidence?.configured_capability_count ?? "missing"}:${configuredCapabilities.length}`);
  }
  if (Number(evidence?.capability_count || 0) !== testedCapabilities.length) {
    errors.push(`checkride_license_tested_capability_count_mismatch:${evidence?.capability_count ?? "missing"}:${testedCapabilities.length}`);
  }
  const contract = evidence?.checkride_license || {};
  for (const [field, errorCode] of [
    ["executable_checkride_required", "checkride_license_executable_requirement_missing"],
    ["graph_runtime_required", "checkride_license_graph_runtime_requirement_missing"],
    ["vivarium_oracle_required", "checkride_license_oracle_requirement_missing"],
    ["observed_evidence_required", "checkride_license_observed_evidence_requirement_missing"],
    ["evidence_record_required", "checkride_license_evidence_record_requirement_missing"],
    ["ledger_append_required", "checkride_license_ledger_append_requirement_missing"],
    ["license_constraints_required", "checkride_license_constraint_requirement_missing"],
    ["critical_failure_block_required", "checkride_license_critical_failure_requirement_missing"],
    ["substrate_assertion_required", "checkride_license_substrate_assertion_requirement_missing"],
    ["entrustment_policy_required", "checkride_license_entrustment_requirement_missing"],
    ["guardrail_evidence_e3_required", "checkride_license_e3_requirement_missing"],
    ["stale_evidence_downgrade_required", "checkride_license_stale_evidence_requirement_missing"],
    ["shadow_mismatch_limit_required", "checkride_license_shadow_mismatch_requirement_missing"],
    ["srl_policy_required", "checkride_license_srl_requirement_missing"],
    ["limited_license_srl7_required", "checkride_license_srl7_requirement_missing"],
    ["operational_feedback_srl9_required", "checkride_license_srl9_requirement_missing"],
    ["self_check_executes_tests_required", "checkride_license_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("checkride_license_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`checkride_license_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("checkride_license_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("checkride_license_test_execution_args_missing");
    }
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("checkride_license_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`checkride_license_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.pending_tests || 0) !== 0) {
    errors.push(`checkride_license_pending_tests:${evidence.test_summary.pending_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("checkride_license_no_reported_tests");
  if (Number(evidence?.reported_test_file_count || 0) !== Number(evidence?.test_file_count || 0)) {
    errors.push(`checkride_license_reported_file_count_mismatch:${evidence?.reported_test_file_count}:${evidence?.test_file_count}`);
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
    ["self_check_executes_tests_required", "case_law_runtime_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  const testExecution = evidence?.test_execution;
  if (!testExecution || typeof testExecution !== "object") {
    errors.push("case_law_runtime_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`case_law_runtime_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("case_law_runtime_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("case_law_runtime_test_execution_args_missing");
    }
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
    ["durable_postgres_session_gate_required", "hosted_runtime_gateway_durable_postgres_gate_requirement_missing"],
    ["malformed_record_rejection_required", "hosted_runtime_gateway_malformed_record_requirement_missing"],
    ["self_check_executes_tests_required", "hosted_runtime_gateway_self_check_execution_requirement_missing"],
  ]) {
    if (contract[field] !== true) errors.push(errorCode);
  }
  if (contract.durable_postgres_session_gate_id !== "dojo_postgres_control_plane_self_check") {
    errors.push("hosted_runtime_gateway_durable_postgres_gate_id_missing");
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
  const testExecution = evidence?.test_execution;
  if (!testExecution) {
    errors.push("hosted_runtime_gateway_test_execution_missing");
  } else {
    if (Number(testExecution.exit_code) !== 0) {
      errors.push(`hosted_runtime_gateway_test_execution_exit_code:${testExecution.exit_code ?? "missing"}`);
    }
    if (testExecution.timed_out === true) {
      errors.push("hosted_runtime_gateway_test_execution_timed_out");
    }
    if (!Array.isArray(testExecution.args) || testExecution.args.length === 0) {
      errors.push("hosted_runtime_gateway_test_execution_args_missing");
    }
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
  errors.push(...await validateDojoChaosRunnerReferencedArtifacts(evidence, evidencePath));
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
  if (evidence?.chaos_runner_required !== true) errors.push("chaos_runner_requirement_missing");
  const chaosRunner = evidence?.chaos_runner;
  if (!chaosRunner || typeof chaosRunner !== "object") {
    errors.push("chaos_runner_missing");
  } else {
    if (chaosRunner.ok !== true) errors.push("chaos_runner_not_ok");
    if (Number(chaosRunner.exit_code) !== 0) errors.push(`chaos_runner_exit_code:${chaosRunner.exit_code ?? "missing"}`);
    if (Number(chaosRunner.scenario_count || 0) <= 0) errors.push("chaos_runner_no_scenarios");
    if (Number(chaosRunner.expected_run_count || 0) <= 0) errors.push("chaos_runner_no_expected_runs");
    if (Number(chaosRunner.failed_run_count || 0) !== 0) errors.push(`chaos_runner_failed_runs:${chaosRunner.failed_run_count}`);
    if (Number(chaosRunner.passed_run_count || 0) !== Number(chaosRunner.expected_run_count || 0)) {
      errors.push(`chaos_runner_passed_run_count_mismatch:${chaosRunner.passed_run_count ?? "missing"}:${chaosRunner.expected_run_count ?? "missing"}`);
    }
    const scenarioNames = Array.isArray(chaosRunner.scenarios) ? chaosRunner.scenarios.map(String) : [];
    for (const requiredScenario of ["api_fault_server", "runtime_preflight_fail_closed", "vivarium_oracle"]) {
      if (!scenarioNames.includes(requiredScenario)) errors.push(`chaos_runner_required_scenario_missing:${requiredScenario}`);
    }
  }
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
  errors.push(...await validateReferencedVitestReportSummary({
    evidence,
    evidencePath,
  }));
  return errors;
}

async function validateDojoChaosRunnerReferencedArtifacts(evidence, evidencePath) {
  const runner = evidence?.chaos_runner;
  if (!runner || typeof runner !== "object") return [];
  const errors = [];
  errors.push(...await validateDigestReferencedFile({
    label: "chaos_runner_report",
    filePath: runner.report_path,
    expectedSha256: runner.report_sha256,
    expectedBytes: runner.report_bytes,
    evidencePath,
  }));
  errors.push(...await validateDigestReferencedFile({
    label: "chaos_runner_stdout",
    filePath: runner.stdout_path,
    expectedSha256: runner.stdout_sha256,
    expectedBytes: runner.stdout_bytes,
    evidencePath,
  }));
  errors.push(...await validateDigestReferencedFile({
    label: "chaos_runner_stderr",
    filePath: runner.stderr_path,
    expectedSha256: runner.stderr_sha256,
    expectedBytes: runner.stderr_bytes,
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

async function validateReferencedVitestReportSummary({ evidence, evidencePath }) {
  const errors = [];
  if (!evidence?.test_summary || !evidence?.json_report_path) return errors;
  const resolved = resolveEvidenceArtifactPath(evidence.json_report_path, evidencePath);
  let report;
  try {
    report = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    return errors;
  }
  const reportSummary = vitestReportSummary(report);
  if (!reportSummary) return errors;
  if (report.success !== true) {
    errors.push("json_report_success_false");
  }
  for (const [summaryField, reportValue] of Object.entries(reportSummary)) {
    const declared = Number(evidence.test_summary?.[summaryField]);
    if (Number.isFinite(declared) && declared !== reportValue) {
      errors.push(`json_report_test_summary_mismatch:${summaryField}:${declared}:${reportValue}`);
    }
  }
  return errors;
}

function vitestReportSummary(report) {
  if (!report || typeof report !== "object") return null;
  const fields = {
    total_tests: report.numTotalTests,
    passed_tests: report.numPassedTests,
    failed_tests: report.numFailedTests,
    pending_tests: report.numPendingTests,
  };
  const entries = Object.entries(fields);
  if (!entries.some(([, value]) => Number.isFinite(Number(value)))) return null;
  return Object.fromEntries(entries.map(([key, value]) => [key, Number(value || 0)]));
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

export async function runDojoReleaseGateVerifierSelfCheck({ outDir }) {
  const manifestArtifacts = await runReleaseGateManifestSelfCheck({
    outDir: path.join(outDir, "release-gates"),
  });
  const manifestResult = await verifyDojoReleaseGateManifestArtifacts({
    manifestPath: manifestArtifacts.manifest_path,
    evidencePath: manifestArtifacts.evidence_path,
  });
  assert.equal(manifestResult.ok, true, manifestResult.errors.join(";"));

  const runnerArtifacts = await runDojoReleaseGateRunner({
    scope: "milestone",
    dryRun: true,
    execute: false,
    outDir: path.join(outDir, "release-gate-runner"),
    manifest: manifestArtifacts.manifest,
    generatedAt: "2026-06-11T00:00:00.000Z",
    env: {},
  });
  const releaseGateRunnerResult = await verifyDojoReleaseGateRunReportArtifact({
    id: "dojo_release_gate_runner_self_check",
    reportPath: runnerArtifacts.report_path,
    evidencePath: runnerArtifacts.evidence_path,
    manifest: manifestArtifacts.manifest,
    requirePromotionReady: false,
  });
  assert.equal(releaseGateRunnerResult.ok, true, releaseGateRunnerResult.errors.join(";"));

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

  const evidenceAuthorityDir = path.join(outDir, "evidence-authority");
  await mkdir(evidenceAuthorityDir, { recursive: true });
  const evidenceAuthorityArtifacts = await writeEvidenceAuthorityEvidenceForSelfCheck({ outDir: evidenceAuthorityDir });
  const evidenceAuthorityResult = await verifyDojoEvidenceAuthorityEvidenceArtifact({
    evidencePath: evidenceAuthorityArtifacts.evidence_path,
  });
  assert.equal(evidenceAuthorityResult.ok, true, evidenceAuthorityResult.errors.join(";"));
  const rejectedEvidenceAuthorityArtifacts = await writeEvidenceAuthorityEvidenceForSelfCheck({
    outDir: evidenceAuthorityDir,
    basename: "dojo-evidence-authority-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["proof_issuance_requires_verified_evidence_records"],
      evidence_authority: {
        ...evidenceAuthorityArtifacts.evidence.evidence_authority,
        evidence_retention_policy_required: false,
        legal_hold_blocks_disposal_required: false,
        external_storage_custody_receipts_required: false,
        proof_issue_claim_verification_required: false,
        proof_validation_rejects_self_attested_claims_required: false,
      },
    },
  });
  const rejectedEvidenceAuthority = await verifyDojoEvidenceAuthorityEvidenceArtifact({
    evidencePath: rejectedEvidenceAuthorityArtifacts.evidence_path,
  });
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_coverage_incomplete"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_missing_capabilities:proof_issuance_requires_verified_evidence_records"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_retention_policy_requirement_missing"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_legal_hold_requirement_missing"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_external_storage_custody_requirement_missing"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_proof_issue_requirement_missing"));
  assert(rejectedEvidenceAuthority.errors.includes("evidence_authority_self_attested_rejection_requirement_missing"));

  const implementationStatusDir = path.join(outDir, "implementation-status");
  await mkdir(implementationStatusDir, { recursive: true });
  const implementationStatusArtifacts = await writeImplementationStatusEvidenceForSelfCheck({ outDir: implementationStatusDir });
  const implementationStatusResult = await verifyDojoImplementationStatusEvidenceArtifact({
    evidencePath: implementationStatusArtifacts.evidence_path,
  });
  assert.equal(implementationStatusResult.ok, true, implementationStatusResult.errors.join(";"));
  const rejectedImplementationStatusArtifacts = await writeImplementationStatusEvidenceForSelfCheck({
    outDir: implementationStatusDir,
    basename: "dojo-implementation-status-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["no_mature_production_runtime_claims"],
      implementation_status_contract: {
        ...implementationStatusArtifacts.evidence.implementation_status_contract,
        production_runtime_claim_boundary_required: false,
        runtime_scope_required_for_executable_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedImplementationStatus = await verifyDojoImplementationStatusEvidenceArtifact({
    evidencePath: rejectedImplementationStatusArtifacts.evidence_path,
  });
  assert(rejectedImplementationStatus.errors.includes("implementation_status_coverage_incomplete"));
  assert(rejectedImplementationStatus.errors.includes("implementation_status_missing_capabilities:no_mature_production_runtime_claims"));
  assert(rejectedImplementationStatus.errors.includes("implementation_status_production_boundary_requirement_missing"));
  assert(rejectedImplementationStatus.errors.includes("implementation_status_runtime_scope_requirement_missing"));
  assert(rejectedImplementationStatus.errors.includes("implementation_status_self_check_execution_requirement_missing"));

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
        license_store_expiry_application_required: false,
        recertification_handoff_required: false,
        self_check_executes_tests_required: false,
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
  assert(rejectedSourceDrift.errors.includes("source_drift_license_store_expiry_requirement_missing"));
  assert(rejectedSourceDrift.errors.includes("source_drift_recertification_handoff_requirement_missing"));
  assert(rejectedSourceDrift.errors.includes("source_drift_self_check_execution_requirement_missing"));

  const agentReadyUiContractDir = path.join(outDir, "agent-ready-ui-contract");
  await mkdir(agentReadyUiContractDir, { recursive: true });
  const agentReadyUiContractArtifacts = await writeAgentReadyUiContractEvidenceForSelfCheck({ outDir: agentReadyUiContractDir });
  const agentReadyUiContractResult = await verifyDojoAgentReadyUiContractEvidenceArtifact({
    evidencePath: agentReadyUiContractArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(agentReadyUiContractResult.ok, true, agentReadyUiContractResult.errors.join(";"));
  const rejectedAgentReadyUiContractArtifacts = await writeAgentReadyUiContractEvidenceForSelfCheck({
    outDir: agentReadyUiContractDir,
    basename: "dojo-agent-ready-ui-contract-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["agent_ready_ui_contract_requires_proof_hook"],
      agent_ready_ui_contract: {
        ...agentReadyUiContractArtifacts.evidence.agent_ready_ui_contract,
        proof_hook_required: false,
        stable_locator_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedAgentReadyUiContract = await verifyDojoAgentReadyUiContractEvidenceArtifact({
    evidencePath: rejectedAgentReadyUiContractArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedAgentReadyUiContract.errors.includes("agent_ready_ui_contract_coverage_incomplete"));
  assert(rejectedAgentReadyUiContract.errors.includes("agent_ready_ui_contract_missing_capabilities:agent_ready_ui_contract_requires_proof_hook"));
  assert(rejectedAgentReadyUiContract.errors.includes("agent_ready_ui_contract_proof_hook_requirement_missing"));
  assert(rejectedAgentReadyUiContract.errors.includes("agent_ready_ui_contract_stable_locator_requirement_missing"));
  assert(rejectedAgentReadyUiContract.errors.includes("agent_ready_ui_contract_self_check_execution_requirement_missing"));

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
        self_check_executes_tests_required: false,
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
  assert(rejectedApiToolCompiler.errors.includes("api_tool_compiler_self_check_execution_requirement_missing"));
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

  const mcpSkillBusDir = path.join(outDir, "mcp-skill-bus");
  await mkdir(mcpSkillBusDir, { recursive: true });
  const mcpSkillBusArtifacts = await writeMcpSkillBusEvidenceForSelfCheck({ outDir: mcpSkillBusDir });
  const mcpSkillBusResult = await verifyDojoMcpSkillBusEvidenceArtifact({
    evidencePath: mcpSkillBusArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(mcpSkillBusResult.ok, true, mcpSkillBusResult.errors.join(";"));
  const rejectedMcpSkillBusArtifacts = await writeMcpSkillBusEvidenceForSelfCheck({
    outDir: mcpSkillBusDir,
    basename: "dojo-mcp-skill-bus-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["mcp_skill_bus_consumes_proof_before_non_dry_dispatch"],
      mcp_skill_bus_contract: {
        ...mcpSkillBusArtifacts.evidence.mcp_skill_bus_contract,
        proof_consume_required: false,
        tenant_boundary_required: false,
      },
    },
  });
  const rejectedMcpSkillBus = await verifyDojoMcpSkillBusEvidenceArtifact({
    evidencePath: rejectedMcpSkillBusArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedMcpSkillBus.errors.includes("mcp_skill_bus_coverage_incomplete"));
  assert(rejectedMcpSkillBus.errors.includes("mcp_skill_bus_missing_capabilities:mcp_skill_bus_consumes_proof_before_non_dry_dispatch"));
  assert(rejectedMcpSkillBus.errors.includes("mcp_skill_bus_proof_consume_requirement_missing"));
  assert(rejectedMcpSkillBus.errors.includes("mcp_skill_bus_tenant_boundary_requirement_missing"));

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
  const acceptedSelfCheck = await verifyDojoMcpHostConformanceSelfCheckArtifacts({
    reportPath: selfCheckArtifacts.report_path,
    evidencePath: selfCheckArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(acceptedSelfCheck.ok, true, acceptedSelfCheck.errors.join(";"));
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

  const publicProofDir = path.join(outDir, "public-proof-verification");
  await mkdir(publicProofDir, { recursive: true });
  const publicProofArtifacts = await writePublicProofVerificationEvidenceForSelfCheck({ outDir: publicProofDir });
  const publicProofResult = await verifyDojoPublicProofVerificationEvidenceArtifact({
    evidencePath: publicProofArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(publicProofResult.ok, true, publicProofResult.errors.join(";"));
  const rejectedPublicProofArtifacts = await writePublicProofVerificationEvidenceForSelfCheck({
    outDir: publicProofDir,
    basename: "dojo-public-proof-verification-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["public_proof_verifies_ed25519_public_key"],
      public_proof_verification_contract: {
        ...publicProofArtifacts.evidence.public_proof_verification_contract,
        ed25519_public_key_required: false,
        key_custody_metadata_export_required: false,
        private_secret_exclusion_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedPublicProof = await verifyDojoPublicProofVerificationEvidenceArtifact({
    evidencePath: rejectedPublicProofArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedPublicProof.errors.includes("public_proof_coverage_incomplete"));
  assert(rejectedPublicProof.errors.includes("public_proof_missing_capabilities:public_proof_verifies_ed25519_public_key"));
  assert(rejectedPublicProof.errors.includes("public_proof_ed25519_requirement_missing"));
  assert(rejectedPublicProof.errors.includes("public_proof_key_custody_metadata_export_requirement_missing"));
  assert(rejectedPublicProof.errors.includes("public_proof_secret_exclusion_requirement_missing"));
  assert(rejectedPublicProof.errors.includes("public_proof_self_check_execution_requirement_missing"));

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
        rbac_required: false,
        store_rbac_required: false,
        license_revocation_required: false,
        compliance_pack_required: false,
        scheduled_jobs_required: false,
        scheduled_job_runner_tool_required: false,
        compliance_archive_manifest_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedGovernanceLifecycle = await verifyDojoGovernanceLifecycleEvidenceArtifact({
    evidencePath: rejectedGovernanceLifecycleArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_coverage_incomplete"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_missing_capabilities:governance_revokes_license_to_blocked_scope_with_audit"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_rbac_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_license_revocation_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_compliance_pack_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_scheduled_jobs_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_scheduled_job_runner_tool_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_compliance_archive_manifest_requirement_missing"));
  assert(rejectedGovernanceLifecycle.errors.includes("governance_lifecycle_self_check_execution_requirement_missing"));

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

  const ghostModeDir = path.join(outDir, "ghost-mode-evidence");
  await mkdir(ghostModeDir, { recursive: true });
  const ghostModeArtifacts = await writeGhostModeEvidenceForSelfCheck({ outDir: ghostModeDir });
  const ghostModeResult = await verifyDojoGhostModeEvidenceArtifact({
    evidencePath: ghostModeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(ghostModeResult.ok, true, ghostModeResult.errors.join(";"));
  const rejectedGhostModeArtifacts = await writeGhostModeEvidenceForSelfCheck({
    outDir: ghostModeDir,
    basename: "dojo-ghost-mode-evidence-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["ghost_mode_runs_without_production_mutation"],
      ghost_mode_contract: {
        ...ghostModeArtifacts.evidence.ghost_mode_contract,
        non_mutating_shadow_run_required: false,
        tenant_boundary_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedGhostMode = await verifyDojoGhostModeEvidenceArtifact({
    evidencePath: rejectedGhostModeArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedGhostMode.errors.includes("ghost_mode_coverage_incomplete"));
  assert(rejectedGhostMode.errors.includes("ghost_mode_missing_capabilities:ghost_mode_runs_without_production_mutation"));
  assert(rejectedGhostMode.errors.includes("ghost_mode_non_mutating_requirement_missing"));
  assert(rejectedGhostMode.errors.includes("ghost_mode_tenant_boundary_requirement_missing"));
  assert(rejectedGhostMode.errors.includes("ghost_mode_self_check_execution_requirement_missing"));

  const skillPassportDir = path.join(outDir, "skill-passport");
  await mkdir(skillPassportDir, { recursive: true });
  const skillPassportArtifacts = await writeSkillPassportEvidenceForSelfCheck({ outDir: skillPassportDir });
  const skillPassportResult = await verifyDojoSkillPassportEvidenceArtifact({
    evidencePath: skillPassportArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(skillPassportResult.ok, true, skillPassportResult.errors.join(";"));
  const rejectedSkillPassportArtifacts = await writeSkillPassportEvidenceForSelfCheck({
    outDir: skillPassportDir,
    basename: "dojo-skill-passport-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["skill_passport_report_only_status"],
      skill_passport_contract: {
        ...skillPassportArtifacts.evidence.skill_passport_contract,
        report_only_status_required: false,
        raw_payload_redaction_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedSkillPassport = await verifyDojoSkillPassportEvidenceArtifact({
    evidencePath: rejectedSkillPassportArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedSkillPassport.errors.includes("skill_passport_coverage_incomplete"));
  assert(rejectedSkillPassport.errors.includes("skill_passport_missing_capabilities:skill_passport_report_only_status"));
  assert(rejectedSkillPassport.errors.includes("skill_passport_report_only_requirement_missing"));
  assert(rejectedSkillPassport.errors.includes("skill_passport_redaction_requirement_missing"));
  assert(rejectedSkillPassport.errors.includes("skill_passport_self_check_execution_requirement_missing"));

  const timeMachineDir = path.join(outDir, "time-machine-debugger");
  await mkdir(timeMachineDir, { recursive: true });
  const timeMachineArtifacts = await writeTimeMachineDebuggerEvidenceForSelfCheck({ outDir: timeMachineDir });
  const timeMachineResult = await verifyDojoTimeMachineDebuggerEvidenceArtifact({
    evidencePath: timeMachineArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(timeMachineResult.ok, true, timeMachineResult.errors.join(";"));
  const rejectedTimeMachineArtifacts = await writeTimeMachineDebuggerEvidenceForSelfCheck({
    outDir: timeMachineDir,
    basename: "dojo-time-machine-debugger-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["time_machine_replay_plan"],
      time_machine_contract: {
        ...timeMachineArtifacts.evidence.time_machine_contract,
        materialized_runtime_branch_required: false,
        replay_plan_required: false,
        honest_projection_status_required: false,
        self_check_executes_tests_required: false,
      },
    },
  });
  const rejectedTimeMachine = await verifyDojoTimeMachineDebuggerEvidenceArtifact({
    evidencePath: rejectedTimeMachineArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedTimeMachine.errors.includes("time_machine_coverage_incomplete"));
  assert(rejectedTimeMachine.errors.includes("time_machine_missing_capabilities:time_machine_replay_plan"));
  assert(rejectedTimeMachine.errors.includes("time_machine_runtime_branch_requirement_missing"));
  assert(rejectedTimeMachine.errors.includes("time_machine_replay_plan_requirement_missing"));
  assert(rejectedTimeMachine.errors.includes("time_machine_honest_status_requirement_missing"));
  assert(rejectedTimeMachine.errors.includes("time_machine_self_check_execution_requirement_missing"));

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
        policy_tissue_required: false,
        expanded_identity_tissue_required: false,
        invalid_value_data_tissue_required: false,
        stale_missing_data_tissue_required: false,
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
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_policy_tissue_requirement_missing"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_expanded_identity_tissue_requirement_missing"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_invalid_value_data_tissue_requirement_missing"));
  assert(rejectedVivariumRuntime.errors.includes("vivarium_runtime_stale_missing_data_tissue_requirement_missing"));

  const checkrideLicenseDir = path.join(outDir, "checkride-license");
  await mkdir(checkrideLicenseDir, { recursive: true });
  const checkrideLicenseArtifacts = await writeCheckrideLicenseEvidenceForSelfCheck({ outDir: checkrideLicenseDir });
  const checkrideLicenseResult = await verifyDojoCheckrideLicenseEvidenceArtifact({
    evidencePath: checkrideLicenseArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert.equal(checkrideLicenseResult.ok, true, checkrideLicenseResult.errors.join(";"));
  const rejectedCheckrideLicenseArtifacts = await writeCheckrideLicenseEvidenceForSelfCheck({
    outDir: checkrideLicenseDir,
    basename: "dojo-checkride-license-rejected",
    overrides: {
      ok: false,
      capability_coverage_complete: false,
      missing_capabilities: ["checkride_blocked_scenario_emits_license_constraint_and_evidence_record"],
      checkride_license: {
        ...checkrideLicenseArtifacts.evidence.checkride_license,
        ledger_append_required: false,
        license_constraints_required: false,
        stale_evidence_downgrade_required: false,
      },
    },
  });
  const rejectedCheckrideLicense = await verifyDojoCheckrideLicenseEvidenceArtifact({
    evidencePath: rejectedCheckrideLicenseArtifacts.evidence_path,
    releaseCandidate: true,
  });
  assert(rejectedCheckrideLicense.errors.includes("checkride_license_coverage_incomplete"));
  assert(rejectedCheckrideLicense.errors.includes("checkride_license_missing_capabilities:checkride_blocked_scenario_emits_license_constraint_and_evidence_record"));
  assert(rejectedCheckrideLicense.errors.includes("checkride_license_ledger_append_requirement_missing"));
  assert(rejectedCheckrideLicense.errors.includes("checkride_license_constraint_requirement_missing"));
  assert(rejectedCheckrideLicense.errors.includes("checkride_license_stale_evidence_requirement_missing"));

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
        self_check_executes_tests_required: false,
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
  assert(rejectedHostedRuntimeGateway.errors.includes("hosted_runtime_gateway_self_check_execution_requirement_missing"));

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
      summarizeSection(releaseGateRunnerResult),
      summarizeSection(postgresControlPlaneResult),
      summarizeSection(evidenceAuthorityResult),
      summarizeSection(implementationStatusResult),
      summarizeSection(dockerIntegrationResult),
      summarizeSection(workflowE2EResult),
      summarizeSection(stdioAcceptanceResult),
      summarizeSection(codexAcceptanceResult),
      summarizeSection(conformanceResult),
      summarizeSection(stdioHostConformanceResult),
      summarizeSection(codexHostConformanceResult),
      summarizeSection(managedKeySigningResult),
      summarizeSection(publicProofResult),
      summarizeSection(governanceLifecycleResult),
      summarizeSection(graphRuntimeResult),
      summarizeSection(ghostModeResult),
      summarizeSection(skillPassportResult),
      summarizeSection(timeMachineResult),
      summarizeSection(vivariumRuntimeResult),
      summarizeSection(checkrideLicenseResult),
      summarizeSection(caseLawRuntimeResult),
      summarizeSection(hostedRuntimeGatewayResult),
      summarizeSection(sourceDriftResult),
      summarizeSection(agentReadyUiContractResult),
      summarizeSection(apiToolCompilerResult),
      summarizeSection(generatedPrResult),
      summarizeSection(mcpSkillBusResult),
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
      summarizeSection(rejectedEvidenceAuthority),
      summarizeSection(rejectedImplementationStatus),
      summarizeSection(rejectedDocker),
      summarizeSection(rejectedCodexAcceptance),
      summarizeSection(rejectedDryRun),
      summarizeSection(rejectedStdioHost),
      summarizeSection(rejectedManagedKeySigning),
      summarizeSection(rejectedPublicProof),
      summarizeSection(rejectedGovernanceLifecycle),
      summarizeSection(rejectedGraphRuntime),
      summarizeSection(rejectedGhostMode),
      summarizeSection(rejectedSkillPassport),
      summarizeSection(rejectedTimeMachine),
      summarizeSection(rejectedVivariumRuntime),
      summarizeSection(rejectedCheckrideLicense),
      summarizeSection(rejectedCaseLawRuntime),
      summarizeSection(rejectedHostedRuntimeGateway),
      summarizeSection(rejectedSourceDrift),
      summarizeSection(rejectedAgentReadyUiContract),
      summarizeSection(rejectedApiToolCompiler),
      summarizeSection(rejectedGeneratedPr),
      summarizeSection(rejectedMcpSkillBus),
      summarizeSection(rejectedSecurity),
      summarizeSection(rejectedCompliance),
      summarizeSection(rejectedPrivacy),
      summarizeSection(rejectedChaos),
      summarizeSection(rejectedSoak),
    ],
  };
  const reportPath = path.join(outDir, "dojo-release-gate-verifier-self-check.json");
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, serializedReport, "utf8");
  const evidence = buildDojoReleaseGateVerifierSelfCheckEvidenceManifest({
    report,
    reportPath,
    serialized: serializedReport,
  });
  const evidencePath = path.join(outDir, "dojo-release-gate-verifier-self-check.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    report_path: reportPath,
    evidence_path: evidencePath,
    report,
    evidence,
  };
}

export function buildDojoReleaseGateVerifierSelfCheckEvidenceManifest({ report, reportPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(report);
  const verifiedSections = Array.isArray(report?.verified_sections) ? report.verified_sections : [];
  const rejectedControls = Array.isArray(report?.rejected_controls) ? report.rejected_controls : [];
  return {
    schema_version: "synthi.dojo.releaseGateVerifierSelfCheckEvidence.v1",
    generated_at: new Date().toISOString(),
    report_path: reportPath,
    report_sha256: sha256(body),
    report_bytes: Buffer.byteLength(body),
    ok: Boolean(report?.ok),
    verified_section_count: verifiedSections.length,
    rejected_control_count: rejectedControls.length,
    verified_section_ids: verifiedSections.map((section) => section.id).filter(Boolean),
    rejected_control_ids: rejectedControls.map((section) => section.id).filter(Boolean),
    manifest_verified: verifiedSections.some((section) => section.id === "release_gate_manifest" && section.ok === true),
    release_gate_runner_self_check_verified: verifiedSections.some((section) => section.id === "dojo_release_gate_runner_self_check" && section.ok === true),
    negative_controls_present: rejectedControls.length > 0,
  };
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
  if (schemaVersion === "synthi.dojo.mcpHostConformance.selfCheck.v1") {
    report.checks = [
      "remote host classification",
      "loopback rejection",
      "private network rejection",
      "link-local rejection",
      "unique local ipv6 rejection",
      "competency selection",
      "blocked call detection",
      "report redaction",
    ];
    report.check_results = [
      { id: "remote_host_classification", ok: true },
      { id: "loopback_rejection", ok: true },
      { id: "private_network_rejection", ok: true },
      { id: "link_local_rejection", ok: true },
      { id: "unique_local_ipv6_rejection", ok: true },
      { id: "competency_selection", ok: true },
      { id: "blocked_call_detection", ok: true },
      { id: "report_redaction", ok: true },
    ];
  }
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
      license_store_expiry_application_required: true,
      recertification_handoff_required: true,
      self_check_executes_tests_required: true,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_SOURCE_DRIFT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
    ...overrides,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeAgentReadyUiContractEvidenceForSelfCheck({
  outDir,
  basename = "dojo-agent-ready-ui-contract",
  overrides = {},
}) {
  const stdout = "agent-ready ui contract focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    numPassedTests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.map((capability, index) => ({
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
    schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
    generated_at: new Date().toISOString(),
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
    test_files: [...DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES],
    test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length,
    reported_test_file_count: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES.length,
    test_summary: {
      total_tests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
      passed_tests: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
    },
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
      self_check_executes_tests_required: true,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_API_TOOL_COMPILER_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
    production_proof_capsule_id: productionEvidence.proof_capsule_id,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES],
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

async function writeEvidenceAuthorityEvidenceForSelfCheck({
  outDir,
  basename = "dojo-evidence-authority",
  overrides = {},
}) {
  const stdout = "evidence authority suite passed\n";
  const stderr = "";
  const jsonReport = evidenceAuthorityJsonReportFixtureText();
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    signal: null,
    duration_ms: 400,
    configured_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
    tested_capabilities: [...DOJO_EVIDENCE_AUTHORITY_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    configured_capability_count: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
    capability_coverage_complete: true,
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
    test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    reported_test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
    test_summary: {
      success: true,
      total_tests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
      passed_tests: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
      total_suites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
      passed_suites: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
      failed_suites: 0,
      reported_test_file_count: DOJO_EVIDENCE_AUTHORITY_TEST_FILES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_EVIDENCE_AUTHORITY_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  }, null, 2);
}

async function writeImplementationStatusEvidenceForSelfCheck({
  outDir,
  basename = "dojo-implementation-status",
  overrides = {},
}) {
  const stdout = "implementation status suite passed\n";
  const stderr = "";
  const jsonReport = implementationStatusJsonReportFixtureText();
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.implementationStatusEvidence.v1",
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    signal: null,
    duration_ms: 100,
    configured_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
    tested_capabilities: [...DOJO_IMPLEMENTATION_STATUS_CAPABILITIES],
    missing_capabilities: [],
    capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    configured_capability_count: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
    capability_coverage_complete: true,
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
    test_files: [...DOJO_IMPLEMENTATION_STATUS_TEST_FILES],
    test_file_count: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
    reported_test_file_count: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
    test_summary: {
      success: true,
      total_tests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
      passed_tests: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.length,
      failed_tests: 0,
      pending_tests: 0,
      total_suites: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
      passed_suites: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
      failed_suites: 0,
      reported_test_file_count: DOJO_IMPLEMENTATION_STATUS_TEST_FILES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_IMPLEMENTATION_STATUS_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES.map((capability, index) => ({
          fullName: `release verifier fixture covers ${capability}`,
          title: `release verifier fixture covers ${capability}`,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
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
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luz3xgAAAABJRU5ErkJggg==",
    "base64",
  );
  const results = [];
  for (const routeId of DOJO_FULL_VISUAL_ROUTE_IDS) {
    for (const viewport of DOJO_FULL_VISUAL_VIEWPORTS) {
      const screenshotPath = path.join(outDir, `${routeId}-${viewport}.png`);
      await writeFile(screenshotPath, imageBytes);
      results.push({
        route_id: routeId,
        viewport,
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
      });
    }
  }
  const report = {
    schema_version: "synthi.dojo.visualProof.v1",
    ok: true,
    generated_at: new Date().toISOString(),
    route_count: DOJO_FULL_VISUAL_ROUTE_IDS.length,
    screenshot_count: results.length,
    screenshots: results.map((result) => result.screenshot_path),
    results,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_SECURITY_ABUSE_TEST_FILES],
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
    ...overrides,
  };
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writePublicProofVerificationEvidenceForSelfCheck({
  outDir,
  basename = "dojo-public-proof-verification",
  overrides = {},
}) {
  const stdout = "public proof verification focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    numPassedTests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
    numPassedTestSuites: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.map((capability, index) => ({
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
    schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
    generated_at: new Date().toISOString(),
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
    test_files: [...DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES],
    test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
    reported_test_file_count: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES.length,
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
      total_tests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
      passed_tests: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GRAPH_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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

async function writeGhostModeEvidenceForSelfCheck({
  outDir,
  basename = "dojo-ghost-mode-evidence",
  overrides = {},
}) {
  const stdout = "ghost mode evidence focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.ghostModeEvidence.v1",
    generated_at: new Date().toISOString(),
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
      total_tests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
      passed_tests: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES.length,
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
  const evidencePath = path.join(outDir, `${basename}.evidence.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence_path: evidencePath,
    evidence,
  };
}

async function writeSkillPassportEvidenceForSelfCheck({
  outDir,
  basename = "dojo-skill-passport",
  overrides = {},
}) {
  const stdout = "skill passport focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.skillPassportEvidence.v1",
    generated_at: new Date().toISOString(),
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
    test_files: [...DOJO_SKILL_PASSPORT_TEST_FILES],
    test_file_count: DOJO_SKILL_PASSPORT_TEST_FILES.length,
    reported_test_file_count: DOJO_SKILL_PASSPORT_TEST_FILES.length,
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
      total_tests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
      passed_tests: DOJO_SKILL_PASSPORT_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_SKILL_PASSPORT_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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

async function writeTimeMachineDebuggerEvidenceForSelfCheck({
  outDir,
  basename = "dojo-time-machine-debugger",
  overrides = {},
}) {
  const stdout = "time machine debugger focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.timeMachineDebuggerEvidence.v1",
    generated_at: new Date().toISOString(),
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
    test_files: [...DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES],
    test_file_count: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
    reported_test_file_count: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES.length,
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
      total_tests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
      passed_tests: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES.length,
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
      ambiguous_document_names_required: true,
      ui_tissue_mutations_required: true,
      policy_tissue_required: true,
      expanded_identity_tissue_required: true,
      invalid_value_data_tissue_required: true,
      stale_missing_data_tissue_required: true,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_VIVARIUM_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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

async function writeCheckrideLicenseEvidenceForSelfCheck({
  outDir,
  basename = "dojo-checkride-license",
  overrides = {},
}) {
  const stdout = "checkride license focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
    generated_at: new Date().toISOString(),
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
      total_tests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
      passed_tests: DOJO_CHECKRIDE_LICENSE_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_CHECKRIDE_LICENSE_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
      self_check_executes_tests_required: true,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_GENERATED_PR_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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

async function writeMcpSkillBusEvidenceForSelfCheck({
  outDir,
  basename = "dojo-mcp-skill-bus",
  overrides = {},
}) {
  const stdout = "MCP Skill Bus focused suite passed\n";
  const stderr = "";
  const jsonReport = JSON.stringify({
    success: true,
    numTotalTests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    numPassedTests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: DOJO_MCP_SKILL_BUS_TEST_FILES.length,
    numPassedTestSuites: DOJO_MCP_SKILL_BUS_TEST_FILES.length,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: DOJO_MCP_SKILL_BUS_CAPABILITIES.map((capability, index) => ({
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
    schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
    generated_at: new Date().toISOString(),
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
      total_tests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
      passed_tests: DOJO_MCP_SKILL_BUS_CAPABILITIES.length,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_MCP_SKILL_BUS_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
      self_check_executes_tests_required: true,
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
    test_execution: {
      command: process.execPath,
      args: ["vitest", "run", ...DOJO_CASE_LAW_RUNTIME_TEST_FILES],
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
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
      durable_postgres_session_gate_required: true,
      durable_postgres_session_gate_id: "dojo_postgres_control_plane_self_check",
      malformed_record_rejection_required: true,
      self_check_executes_tests_required: true,
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
  const chaosRunnerReport = JSON.stringify({
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
  const chaosRunnerStdout = "PASS api_fault_server#1\nPASS runtime_preflight_fail_closed#1\nPASS vivarium_oracle#1\n";
  const chaosRunnerStderr = "";
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  const jsonReportPath = path.join(outDir, `${basename}.vitest.json`);
  const chaosRunnerReportPath = path.join(outDir, `${basename}.chaos-runner.json`);
  const chaosRunnerStdoutPath = path.join(outDir, `${basename}.chaos-runner.stdout.log`);
  const chaosRunnerStderrPath = path.join(outDir, `${basename}.chaos-runner.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(jsonReportPath, jsonReport, "utf8");
  await writeFile(chaosRunnerReportPath, chaosRunnerReport, "utf8");
  await writeFile(chaosRunnerStdoutPath, chaosRunnerStdout, "utf8");
  await writeFile(chaosRunnerStderrPath, chaosRunnerStderr, "utf8");
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
        chaos_runner_report_ok: true,
        chaos_runner_has_scenarios: true,
        chaos_runner_all_runs_passed: true,
        scenario_coverage_complete: true,
        self_check_within_timeout: true,
        test_case_p95_recorded: true,
        test_file_p95_recorded: true,
      },
    },
    chaos_runner_required: true,
    chaos_runner: {
      ok: true,
      exit_code: 0,
      signal: null,
      report_path: chaosRunnerReportPath,
      report_sha256: sha256(chaosRunnerReport),
      report_bytes: Buffer.byteLength(chaosRunnerReport),
      stdout_path: chaosRunnerStdoutPath,
      stderr_path: chaosRunnerStderrPath,
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

async function validateRunnerGateResult({
  result,
  gatesById,
  requirePromotionReady,
  errors,
}) {
  const gateId = String(result?.gate_id || "");
  const gate = gatesById.get(gateId);
  if (!gate) {
    errors.push(`runner_unknown_result_gate:${gateId || "missing"}`);
    return;
  }
  if (result.tier !== gate.tier) errors.push(`runner_result_tier_mismatch:${gateId}:${result.tier}:${gate.tier}`);
  if (result.expected_artifacts?.evidence_kind !== gate.evidence_kind) {
    errors.push(`runner_result_evidence_kind_mismatch:${gateId}:${result.expected_artifacts?.evidence_kind}:${gate.evidence_kind}`);
  }
  const expectedArtifacts = {
    report_path: gate.default_report_path || gate.default_summary_path || null,
    evidence_path: gate.default_evidence_path || null,
    events_path: gate.default_events_path || null,
  };
  for (const [field, expectedPath] of Object.entries(expectedArtifacts)) {
    if ((result.expected_artifacts?.[field] || null) !== expectedPath) {
      errors.push(`runner_result_expected_artifact_mismatch:${gateId}:${field}:${result.expected_artifacts?.[field] || "missing"}:${expectedPath || "missing"}`);
    }
  }
  const validStatuses = new Set(["planned", "skipped", "passed", "failed"]);
  if (!validStatuses.has(result.status)) errors.push(`runner_result_unknown_status:${gateId}:${result.status}`);
  if (result.status === "passed") {
    if (result.executed !== true) errors.push(`runner_passed_gate_not_executed:${gateId}`);
    if (result.exit_code !== 0) errors.push(`runner_passed_gate_exit_nonzero:${gateId}:${result.exit_code}`);
    await validateRunnerLogDigest({ result, gateId, kind: "stdout", errors });
    await validateRunnerLogDigest({ result, gateId, kind: "stderr", errors });
    await validateRunnerProducedArtifacts({ result, gateId, errors });
  }
  if (result.status === "failed" && requirePromotionReady) errors.push(`runner_result_failed:${gateId}`);
  if (result.status === "skipped" && requirePromotionReady) errors.push(`runner_result_skipped:${gateId}:${result.skip_reason || "unknown"}`);
  if (result.status === "planned" && !result.executed && requirePromotionReady) errors.push(`runner_result_planned:${gateId}`);
  if (result.status !== "planned" && result.command !== result.command?.trim()) {
    errors.push(`runner_result_command_untrimmed:${gateId}`);
  }
}

function validateRunnerEvidenceSummary({ evidence, report, results, errors }) {
  const producedArtifactCount = results.reduce((count, result) => (
    count + (Array.isArray(result.produced_artifacts) ? result.produced_artifacts.length : 0)
  ), 0);
  const commandLogDigestCount = results.filter((result) => result.stdout_sha256 && result.stderr_sha256).length;
  const expected = {
    run_id: report?.run_id,
    scope: report?.scope,
    dry_run: Boolean(report?.dry_run),
    ok: Boolean(report?.ok),
    complete: Boolean(report?.complete),
    promotion_ready: Boolean(report?.promotion_ready),
    selected_gate_count: report?.counts?.selected || 0,
    executed_gate_count: report?.counts?.executed || 0,
    passed_gate_count: report?.counts?.passed || 0,
    failed_gate_count: report?.counts?.failed || 0,
    skipped_gate_count: report?.counts?.skipped || 0,
    produced_artifact_count: producedArtifactCount,
    command_log_digest_count: commandLogDigestCount,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (evidence?.[field] !== expectedValue) {
      errors.push(`runner_evidence_summary_mismatch:${field}:${evidence?.[field]}:${expectedValue}`);
    }
  }
}

async function validateRunnerProducedArtifacts({ result, gateId, errors }) {
  const expectedKinds = [
    ["report", result.expected_artifacts?.report_path],
    ["evidence", result.expected_artifacts?.evidence_path],
    ["events", result.expected_artifacts?.events_path],
  ].filter(([, artifactPath]) => Boolean(artifactPath)).map(([kind]) => kind);
  const producedArtifacts = Array.isArray(result.produced_artifacts) ? result.produced_artifacts : [];
  const producedByKind = new Map(producedArtifacts.map((artifact) => [artifact.kind, artifact]));
  for (const kind of expectedKinds) {
    if (!producedByKind.has(kind)) errors.push(`runner_produced_artifact_entry_missing:${gateId}:${kind}`);
  }
  for (const artifact of producedArtifacts) {
    if (!expectedKinds.includes(artifact.kind)) errors.push(`runner_unexpected_produced_artifact:${gateId}:${artifact.kind}`);
    if (artifact.required === true && artifact.exists !== true) {
      errors.push(`runner_produced_artifact_missing:${gateId}:${artifact.kind}:${artifact.error_code || "missing"}`);
      continue;
    }
    if (artifact.exists !== true) continue;
    if (!artifact.path) {
      errors.push(`runner_produced_artifact_path_missing:${gateId}:${artifact.kind}`);
      continue;
    }
    const bytes = await readFile(resolveRepoPath(artifact.path));
    const actualBytes = bytes.length;
    const actualSha256 = sha256(bytes);
    if (artifact.bytes !== actualBytes) {
      errors.push(`runner_produced_artifact_bytes_mismatch:${gateId}:${artifact.kind}:${artifact.bytes}:${actualBytes}`);
    }
    if (artifact.sha256 !== actualSha256) {
      errors.push(`runner_produced_artifact_sha256_mismatch:${gateId}:${artifact.kind}:${artifact.sha256}:${actualSha256}`);
    }
  }
}

async function validateRunnerLogDigest({ result, gateId, kind, errors }) {
  const pathField = `${kind}_path`;
  const bytesField = `${kind}_bytes`;
  const digestField = `${kind}_sha256`;
  const logPath = result?.[pathField];
  if (!logPath) {
    errors.push(`runner_${kind}_path_missing:${gateId}`);
    return;
  }
  const bytes = await readFile(resolveRepoPath(logPath));
  const actualBytes = bytes.length;
  const actualSha256 = sha256(bytes);
  if (result?.[bytesField] !== actualBytes) {
    errors.push(`runner_${kind}_bytes_mismatch:${gateId}:${result?.[bytesField]}:${actualBytes}`);
  }
  if (result?.[digestField] !== actualSha256) {
    errors.push(`runner_${kind}_sha256_mismatch:${gateId}:${result?.[digestField]}:${actualSha256}`);
  }
}

async function verifyArtifactSection({
  id,
  artifactPath,
  evidencePath,
  releaseCandidate = false,
  enterpriseRelease = false,
}, verify) {
  try {
    return await verify();
  } catch (error) {
    if (!isArtifactReadError(error)) throw error;
    return buildArtifactReadFailureSection({
      id,
      artifactPath,
      evidencePath,
      releaseCandidate,
      enterpriseRelease,
      error,
    });
  }
}

function buildArtifactReadFailureSection({
  id,
  artifactPath,
  evidencePath,
  releaseCandidate = false,
  enterpriseRelease = false,
  error,
}) {
  const failedPath = String(error?.path || artifactPath || evidencePath || "unknown");
  const failureKind = classifyArtifactReadFailure({
    failedPath,
    artifactPath,
    evidencePath,
    code: error?.code,
  });
  return {
    id,
    ok: false,
    errors: [`${failureKind}:${failedPath}`],
    artifact_path: artifactPath,
    evidence_path: evidencePath,
    report_schema_version: null,
    result_count: 0,
    release_candidate: Boolean(releaseCandidate),
    enterprise_release: Boolean(enterpriseRelease),
  };
}

function classifyArtifactReadFailure({ failedPath, artifactPath, evidencePath, code }) {
  const prefix = pathsReferToSameFile(failedPath, evidencePath) && !pathsReferToSameFile(failedPath, artifactPath)
    ? "evidence"
    : "artifact";
  return code === "ENOENT"
    ? `${prefix}_missing`
    : `${prefix}_read_failed`;
}

function isArtifactReadError(error) {
  return Boolean(error && ["EACCES", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code));
}

function pathsReferToSameFile(left, right) {
  if (!left || !right) return false;
  return path.resolve(String(left)) === path.resolve(String(right));
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
    runner_scope: section.runner_scope,
    dry_run: section.dry_run,
    complete: section.complete,
    promotion_ready: section.promotion_ready,
  };
}

export function getVerifiableReleaseGateCoverage({ manifest, sections }) {
  const gatesById = new Map((Array.isArray(manifest?.gates) ? manifest.gates : []).map((gate) => [gate.id, gate]));
  const verifiableReleaseGateIds = (Array.isArray(manifest?.release_gate_ids) ? manifest.release_gate_ids : [])
    .filter((gateId) => {
      const gate = gatesById.get(gateId);
      if (!gate) return false;
      if (!["proof_artifact", "visual_report", "metrics"].includes(gate.evidence_kind)) return false;
      return Boolean(
        gate.default_evidence_path
        || gate.default_report_path
        || gate.default_summary_path
        || gate.default_events_path
      );
    });
  const sectionList = Array.isArray(sections) ? sections : [];
  const attemptedGateIds = [...new Set(sectionList.map((section) => section?.id).filter(Boolean))];
  const verifiedGateIds = [...new Set(sectionList
    .filter((section) => section?.ok === true)
    .map((section) => section?.id)
    .filter(Boolean))];
  const failedGateIds = [...new Set(sectionList
    .filter((section) => section?.ok === false)
    .map((section) => section?.id)
    .filter(Boolean))];
  const missingVerifiableReleaseGateIds = verifiableReleaseGateIds
    .filter((gateId) => !attemptedGateIds.includes(gateId));
  return {
    verifiable_release_gate_ids: verifiableReleaseGateIds,
    attempted_release_gate_ids: attemptedGateIds.filter((gateId) => verifiableReleaseGateIds.includes(gateId)),
    verified_release_gate_ids: verifiedGateIds.filter((gateId) => verifiableReleaseGateIds.includes(gateId)),
    failed_verifiable_release_gate_ids: failedGateIds.filter((gateId) => verifiableReleaseGateIds.includes(gateId)),
    missing_verifiable_release_gate_ids: missingVerifiableReleaseGateIds,
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
