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
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
  redactConformanceReport,
} from "./dojo-mcp-host-conformance.mjs";

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
const DEFAULT_SECURITY_ABUSE_DIR = path.join(REPO_ROOT, "tmp", "dojo-security-abuse");
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

  const securityResults = [];
  if (truthy(args["release-candidate"]) || args["security-abuse-evidence"]) {
    securityResults.push(await verifyDojoSecurityAbuseEvidenceArtifact({
      evidencePath: resolveRepoPath(args["security-abuse-evidence"] || path.join(DEFAULT_SECURITY_ABUSE_DIR, "dojo-security-abuse.evidence.json")),
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

  const sections = [manifestResult, ...proofSelfCheckResults, ...visualResults, ...postgresControlPlaneResults, ...liveHostedRuntimeResults, ...conformanceResults, ...securityResults, ...chaosPerformanceResults, ...soakPerformanceResults];
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
    live_hosted_runtime: liveHostedRuntimeResults.map(summarizeSection),
    mcp_host_conformance: conformanceResults.map(summarizeSection),
    security_abuse: securityResults.map(summarizeSection),
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
  return {
    id: "dojo_self_check",
    ok: errors.length === 0,
    errors,
    artifact_path: summaryPath,
    evidence_path: resolvedEvidencePath,
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

export async function verifyDojoWorkflowPipelineE2EArtifact({ summaryPath, releaseCandidate = false }) {
  const summary = await readJsonFile(summaryPath);
  const errors = validateDojoWorkflowPipelineE2EForRelease(summary).errors;
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
  if (evidence?.schema_version !== "synthi.dojo.securityAbuseEvidence.v1") {
    errors.push(`security_abuse_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("security_abuse_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`security_abuse_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.abuse_class_coverage_complete !== true) errors.push("security_abuse_coverage_incomplete");
  if (Array.isArray(evidence?.missing_abuse_classes) && evidence.missing_abuse_classes.length > 0) {
    errors.push(`security_abuse_missing_classes:${evidence.missing_abuse_classes.join(",")}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("security_abuse_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`security_abuse_failed_tests:${evidence.test_summary.failed_tests}`);
  }
  if (Number(evidence?.test_summary?.total_tests || 0) <= 0) errors.push("security_abuse_no_reported_tests");
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
  if (evidence?.schema_version !== "synthi.dojo.chaosPerformanceEvidence.v1") {
    errors.push(`chaos_performance_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("chaos_performance_not_ok");
  if (Number(evidence?.exit_code) !== 0) errors.push(`chaos_performance_exit_code:${evidence?.exit_code ?? "missing"}`);
  if (evidence?.scenario_coverage_complete !== true) errors.push("chaos_performance_scenario_coverage_incomplete");
  if (Array.isArray(evidence?.missing_chaos_scenarios) && evidence.missing_chaos_scenarios.length > 0) {
    errors.push(`chaos_performance_missing_scenarios:${evidence.missing_chaos_scenarios.join(",")}`);
  }
  if (evidence?.budget_evaluation?.ok !== true) errors.push("chaos_performance_budget_not_ok");
  if (Number(evidence?.test_summary?.failed_tests || 0) !== 0) {
    errors.push(`chaos_performance_failed_tests:${evidence.test_summary.failed_tests}`);
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
      summarizeSection(workflowE2EResult),
      summarizeSection(stdioAcceptanceResult),
      summarizeSection(codexAcceptanceResult),
      summarizeSection(conformanceResult),
      summarizeSection(stdioHostConformanceResult),
      summarizeSection(codexHostConformanceResult),
      summarizeSection(visualResult),
      summarizeSection(securityResult),
      summarizeSection(chaosResult),
      summarizeSection(soakResult),
    ],
    rejected_controls: [
      summarizeSection(rejectedSelfCheck),
      summarizeSection(rejectedPostgres),
      summarizeSection(rejectedCodexAcceptance),
      summarizeSection(rejectedDryRun),
      summarizeSection(rejectedStdioHost),
      summarizeSection(rejectedSecurity),
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

async function writeStdioAcceptanceTranscriptForSelfCheck({ outDir, basename = "mcp-stdio-private-tool-acceptance", overrides = {} }) {
  const screenshotPath = path.join(outDir, `${basename}.png`);
  await writeFile(screenshotPath, Buffer.from(`${basename}:visual-proof`));
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
  await writeFile(screenshotPath, Buffer.from(`${basename}:visual-proof`));
  const transcript = buildCodexAcceptanceTranscriptForSelfCheck({
    screenshotPath,
    ...overrides,
  });
  const transcriptPath = path.join(outDir, `${basename}.json`);
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  return transcriptPath;
}

function buildCodexAcceptanceTranscriptForSelfCheck(overrides = {}) {
  const screenshotPath = overrides.screenshotPath || "codex-private-tool-acceptance.png";
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
        url: "https://workspace.example.test/private-tool",
        match: true,
        expected_text: "Details opened",
      },
    ],
  };
  const cleanedOverrides = { ...overrides };
  delete cleanedOverrides.screenshotPath;
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
    ...summaryOverrides,
  };
  const summaryPath = path.join(outDir, `${basename}.summary.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    summary_path: summaryPath,
    production_evidence_path: productionEvidencePath,
  };
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
    configured_capabilities: [
      "durable_proof_store",
      "atomic_proof_consume",
      "concurrent_replay_prevention",
      "tenant_isolation",
      "evidence_ledger_append_verify",
      "evidence_tamper_detection",
      "audit_event_repository",
      "postgres_evidence_proof_issuance",
    ],
    tested_capabilities: [
      "durable_proof_store",
      "atomic_proof_consume",
      "concurrent_replay_prevention",
      "tenant_isolation",
      "evidence_ledger_append_verify",
      "evidence_tamper_detection",
      "audit_event_repository",
      "postgres_evidence_proof_issuance",
    ],
    missing_capabilities: [],
    capability_coverage_complete: true,
    test_files: [
      "tests/integration/dojo_postgres_proof_store.test.ts",
      "tests/integration/dojo_evidence_ledger_store.test.ts",
      "tests/integration/dojo_audit_store.test.ts",
      "tests/integration/dojo_proof_ledger_tool.test.ts",
    ],
    test_file_count: 4,
    reported_test_file_count: 4,
    test_summary: {
      success: true,
      total_tests: 13,
      passed_tests: 13,
      failed_tests: 0,
      pending_tests: 0,
      total_suites: 4,
      passed_suites: 4,
      failed_suites: 0,
      reported_test_file_count: 4,
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
  const jsonReport = JSON.stringify({ success: true, numTotalTests: 8, numPassedTests: 8, numFailedTests: 0, testResults: [] }, null, 2);
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
    abuse_class_coverage_complete: true,
    missing_abuse_classes: [],
    budget_evaluation: {
      ok: true,
      checks: {
        no_spawn_error: true,
        no_failed_tests: true,
        all_reported_tests_passed: true,
        abuse_class_coverage_complete: true,
        self_check_within_timeout: true,
      },
    },
    test_summary: {
      total_tests: 8,
      passed_tests: 8,
      failed_tests: 0,
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
    },
    performance_metrics: {
      self_check_duration_ms: 1250,
      test_case_duration_p95_ms: 42,
      test_file_duration_p95_ms: 140,
      failed_test_count: 0,
      passed_test_count: 9,
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
