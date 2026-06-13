// @ts-nocheck
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildComplianceCapabilityCoverage,
  buildDojoComplianceExportEvidenceManifest,
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
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
      testFiles: ["tests/unit/dojo_tools.test.ts"],
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
      testFiles: ["tests/unit/dojo_tools.test.ts"],
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
      "redacted_evidence_export",
      "redaction_fail_closed",
      "source_ref_redaction",
    ]));
    expect(evidence.budget_evaluation.failed_checks).toEqual(["capability_coverage_complete"]);
  });
});

function complianceVitestReportFixture({
  assertionTitles = [
    "Agent Dojo MCP tools requires tenant authorization for production skill operations and exports",
    "Dojo governance service includes stored control-plane audit events in audit exports and compliance pack",
    "Dojo governance service builds recertification, audit export, and compliance pack views",
    "Dojo redacted evidence export exports redacted evidence metadata without raw artifact content",
    "Dojo redacted evidence export fails closed when a bound evidence record lacks redaction metadata",
    "Dojo redacted evidence export allows local generated artifacts while redacting source refs",
  ],
  totalTests = assertionTitles.length,
} = {}) {
  return {
    success: true,
    numTotalTests: totalTests,
    numPassedTests: totalTests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 3,
    numPassedTestSuites: 3,
    numFailedTestSuites: 0,
    testResults: [{
      startTime: 0,
      endTime: 10,
      assertionResults: assertionTitles.map((fullName, index) => ({
        fullName,
        title: fullName,
        status: "passed",
        duration: index + 1,
      })),
    }],
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
