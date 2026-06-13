// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  validateDojoMcpHostConformanceReportForRelease,
  validateDojoChaosPerformanceEvidenceForEnterprise,
  validateDojoSecurityAbuseEvidenceForRelease,
  validateDojoSoakPerformanceSummary,
  verifyDojoChaosPerformanceEvidenceArtifact,
  verifyDojoMcpHostConformanceArtifacts,
  verifyDojoReleaseGateManifestArtifacts,
  verifyDojoSecurityAbuseEvidenceArtifact,
  verifyDojoSoakPerformanceArtifacts,
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
    const report = buildVisualReport({ screenshotPath, bytes: imageBytes.length });
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

async function writeSecurityEvidenceFixture({
  dir,
  basename = "dojo-security-abuse",
  evidence,
  writeLogs = true,
}) {
  const stdout = "security suite passed\n";
  const stderr = "";
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  if (writeLogs) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
  } else {
    await writeFile(stderrPath, stderr, "utf8");
  }
  const body = evidence ?? securityEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
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
    abuse_class_coverage_complete: true,
    missing_abuse_classes: [],
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: 8,
      passed_tests: 8,
      failed_tests: 0,
    },
    stdout_path: "stdout.log",
    stderr_path: "stderr.log",
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
}

async function writeChaosEvidenceFixture({
  dir,
  basename = "dojo-chaos-performance",
  evidence,
}) {
  const stdout = "chaos suite passed\n";
  const stderr = "";
  const stdoutPath = path.join(dir, `${basename}.stdout.log`);
  const stderrPath = path.join(dir, `${basename}.stderr.log`);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const body = evidence ?? chaosEvidenceFixture({ stdout_path: stdoutPath, stderr_path: stderrPath });
  const withLogDefaults = {
    ...body,
    stdout_path: body.stdout_path && body.stdout_path !== "stdout.log" ? body.stdout_path : stdoutPath,
    stderr_path: body.stderr_path && body.stderr_path !== "stderr.log" ? body.stderr_path : stderrPath,
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
    scenario_coverage_complete: true,
    missing_chaos_scenarios: [],
    budget_evaluation: { ok: true },
    test_summary: {
      total_tests: 9,
      passed_tests: 9,
      failed_tests: 0,
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
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    ...overrides,
  };
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
  return report;
}

function buildVisualReport({ screenshotPath, bytes }) {
  return {
    schema_version: "synthi.dojo.visualProof.v1",
    ok: true,
    screenshots: [screenshotPath],
    results: [
      {
        route_id: "visual-proof",
        viewport: "desktop",
        ok: true,
        failed_visual_gates: [],
        screenshot_path: screenshotPath,
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
