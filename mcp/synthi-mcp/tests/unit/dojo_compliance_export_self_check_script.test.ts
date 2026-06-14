// @ts-nocheck
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildComplianceCapabilityCoverage,
  buildDojoComplianceExportEvidenceManifest,
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
  DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} from "../../scripts/dojo-compliance-export-self-check.mjs";

describe("Dojo compliance export self-check script", () => {
  it("maps Vitest assertion titles to required compliance export capabilities", () => {
    const coverage = buildComplianceCapabilityCoverage({
      capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
      jsonReport: complianceVitestReportFixture(),
    });
    expect(coverage).toEqual(DOJO_COMPLIANCE_EXPORT_CAPABILITIES.map((capability) => expect.objectContaining({
      capability,
      covered: true,
      evidence_titles: expect.arrayContaining([expect.any(String)]),
    })));
  });

  it("builds digest-backed evidence for a passing compliance export focused suite", () => {
    const stdout = "compliance export focused suite passed\n";
    const stderr = "";
    const jsonReportText = JSON.stringify(complianceVitestReportFixture(), null, 2);
    const evidence = buildDojoComplianceExportEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 500,
      basicRunDurationMs: 250,
      testFiles: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
      stdout,
      stderr,
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: complianceVitestReportFixture(),
      jsonReportPath: "tmp/report.json",
      jsonReportText,
      timeoutMs: 1000,
    });
    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.complianceExportEvidence.v1",
      ok: true,
      capability_coverage_complete: true,
      missing_capabilities: [],
      json_report_sha256: sha256(jsonReportText),
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
    }));
    expect(evidence.reported_test_file_count).toBe(DOJO_COMPLIANCE_EXPORT_TEST_FILES.length);
  });

  it("fails budget when a required compliance capability lacks evidence", () => {
    const partialReport = complianceVitestReportFixture({
      assertionTitles: [
        "Agent Dojo MCP tools requires tenant authorization for production skill operations and exports",
      ],
      totalTests: 1,
    });
    const evidence = buildDojoComplianceExportEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 500,
      basicRunDurationMs: 250,
      testFiles: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
      stdout: "",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: partialReport,
      jsonReportPath: "tmp/report.json",
      jsonReportText: JSON.stringify(partialReport),
      timeoutMs: 1000,
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.missing_capabilities).toEqual(expect.arrayContaining([
      "compliance_pack_view_model",
      "control_plane_audit_export",
      "executable_entrustment_compliance_artifact",
      "redacted_evidence_export",
      "redaction_fail_closed",
      "source_ref_redaction",
      "proof_public_verification_export",
    ]));
    expect(evidence.budget_evaluation.failed_checks).toEqual(["capability_coverage_complete"]);
  });

  it("fails budget when the Vitest report omits a configured compliance test file", () => {
    const reportedTestFiles = DOJO_COMPLIANCE_EXPORT_TEST_FILES.slice(0, -1);
    const report = complianceVitestReportFixture({ testFiles: reportedTestFiles });
    const evidence = buildDojoComplianceExportEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 500,
      basicRunDurationMs: 250,
      testFiles: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
      stdout: "",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: report,
      jsonReportPath: "tmp/report.json",
      jsonReportText: JSON.stringify(report),
      timeoutMs: 1000,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.reported_test_file_count).toBe(reportedTestFiles.length);
    expect(evidence.budget_evaluation.checks.all_test_files_reported).toBe(false);
    expect(evidence.budget_evaluation.failed_checks).toContain("all_test_files_reported");
  });
});

function complianceVitestReportFixture({
  assertionTitles = [
    "Agent Dojo MCP tools requires tenant authorization for production skill operations and exports",
    "Dojo governance service includes stored control-plane audit events in audit exports and compliance pack",
    "Dojo governance service builds recertification, audit export, and compliance pack views",
    "Dojo governance service adds executable entrustment provenance to compliance packs when runtime checkride snapshots exist",
    "Dojo redacted evidence export exports redacted evidence metadata without raw artifact content",
    "Dojo redacted evidence export fails closed when a bound evidence record lacks redaction metadata",
    "Dojo redacted evidence export allows local generated artifacts while redacting source refs",
    "Dojo proof public verification export builds a public verification bundle from proof-key custody records without private material",
  ],
  totalTests = assertionTitles.length,
  testFiles = DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} = {}) {
  const titleBuckets = testFiles.map(() => []);
  assertionTitles.forEach((title, index) => {
    titleBuckets[index % titleBuckets.length].push(title);
  });
  return {
    success: true,
    numTotalTests: totalTests,
    numPassedTests: totalTests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: testFiles.length,
    numPassedTestSuites: testFiles.length,
    numFailedTestSuites: 0,
    testResults: testFiles.map((file, fileIndex) => ({
      name: file,
      startTime: fileIndex * 10,
      endTime: fileIndex * 10 + 10,
      assertionResults: titleBuckets[fileIndex].map((fullName, index) => ({
          fullName,
          title: fullName,
          status: "passed",
          duration: index + 1,
        })),
    })),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
