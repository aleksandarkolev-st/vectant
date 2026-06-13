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
const DEFAULT_CONFORMANCE_DIR = path.join(REPO_ROOT, "tmp", "dojo-mcp-host-conformance");
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

  const visualResults = [];
  if (truthy(args["include-visual-defaults"])) {
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

  const conformanceResults = [];
  if (truthy(args["release-candidate"]) || args["mcp-host-conformance-report"]) {
    conformanceResults.push(await verifyDojoMcpHostConformanceArtifacts({
      reportPath: resolveRepoPath(args["mcp-host-conformance-report"] || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.json")),
      evidencePath: resolveRepoPath(args["mcp-host-conformance-evidence"] || path.join(DEFAULT_CONFORMANCE_DIR, "dojo-mcp-host-conformance.evidence.json")),
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

  const sections = [manifestResult, ...visualResults, ...conformanceResults, ...securityResults, ...chaosPerformanceResults, ...soakPerformanceResults];
  const errors = sections.flatMap((section) => section.errors.map((error) => `${section.id}:${error}`));
  return {
    schema_version: "synthi.dojo.releaseGateVerification.v1",
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    manifest: summarizeSection(manifestResult),
    visual_reports: visualResults.map(summarizeSection),
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
      summarizeSection(conformanceResult),
      summarizeSection(visualResult),
      summarizeSection(securityResult),
      summarizeSection(chaosResult),
      summarizeSection(soakResult),
    ],
    rejected_controls: [
      summarizeSection(rejectedSelfCheck),
      summarizeSection(rejectedDryRun),
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
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
  const stdoutPath = path.join(outDir, `${basename}.stdout.log`);
  const stderrPath = path.join(outDir, `${basename}.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
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
