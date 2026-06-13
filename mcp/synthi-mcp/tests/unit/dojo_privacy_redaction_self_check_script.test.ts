// @ts-nocheck
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDojoPrivacyRedactionEvidenceManifest,
  buildPrivacyCapabilityCoverage,
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
} from "../../scripts/dojo-privacy-redaction-self-check.mjs";

describe("Dojo privacy/redaction self-check script", () => {
  it("maps Vitest assertion titles to required privacy capabilities", () => {
    const coverage = buildPrivacyCapabilityCoverage({
      capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
      jsonReport: privacyVitestReportFixture(),
    });
    expect(coverage).toEqual(DOJO_PRIVACY_REDACTION_CAPABILITIES.map((capability) => expect.objectContaining({
      capability,
      covered: true,
      evidence_titles: expect.arrayContaining([expect.any(String)]),
    })));
  });

  it("builds digest-backed evidence for a passing privacy focused suite", () => {
    const stdout = "privacy redaction focused suite passed\n";
    const stderr = "";
    const jsonReportText = JSON.stringify(privacyVitestReportFixture(), null, 2);
    const evidence = buildDojoPrivacyRedactionEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 500,
      basicRunDurationMs: 250,
      testFiles: ["tests/unit/dojo_evidence_redaction.test.ts"],
      stdout,
      stderr,
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: privacyVitestReportFixture(),
      jsonReportPath: "tmp/report.json",
      jsonReportText,
      timeoutMs: 1000,
    });
    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
      ok: true,
      capability_coverage_complete: true,
      missing_capabilities: [],
      json_report_sha256: sha256(jsonReportText),
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
    }));
  });

  it("fails budget when a required privacy capability lacks evidence", () => {
    const partialReport = privacyVitestReportFixture({
      assertionTitles: [
        "Dojo evidence redaction redacts sensitive trace and storage fields while producing a verifiable manifest",
      ],
      totalTests: 1,
    });
    const evidence = buildDojoPrivacyRedactionEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 500,
      basicRunDurationMs: 250,
      testFiles: ["tests/unit/dojo_evidence_redaction.test.ts"],
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
      "redacted_evidence_export",
      "auth_checkpoint_secret_custody",
      "browser_origin_privacy_boundary",
      "screenshot_consent_boundary",
      "private_tool_secret_minimization",
      "broker_audit_redaction",
      "operator_queue_screenshot_minimization",
    ]));
    expect(evidence.budget_evaluation.failed_checks).toEqual(["capability_coverage_complete"]);
  });
});

function privacyVitestReportFixture({
  assertionTitles = [
    "Dojo evidence redaction redacts sensitive trace and storage fields while producing a verifiable manifest",
    "Dojo redacted evidence export exports redacted evidence metadata without raw artifact content",
    "Auth checkpoint encrypted file store encrypts persisted auth checkpoints and keeps secret material out of the index",
    "browser broker privacy boundary returns no screenshot, DOM, console, or network data for denied origins",
    "browser broker privacy boundary requires explicit screenshot consent before accepting snapshot data",
    "private workflow tool manifest does not persist captured secret values in generated stores",
    "broker hardening redacts secret keys and bearer-like values recursively",
    "operator bridge lists pending entries without screenshots",
  ],
  totalTests = assertionTitles.length,
} = {}) {
  return {
    success: true,
    numTotalTests: totalTests,
    numPassedTests: totalTests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 7,
    numPassedTestSuites: 7,
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
