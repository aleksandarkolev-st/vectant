// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildAbuseClassCoverage,
  buildDojoSecurityAbuseEvidenceManifest,
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "../../scripts/dojo-security-abuse-self-check.mjs";

describe("Dojo security abuse self-check script", () => {
  it("defines a focused executable abuse-suite file list", () => {
    expect(DOJO_SECURITY_ABUSE_TEST_FILES).toEqual(expect.arrayContaining([
      "tests/unit/dojo_proof_errors.test.ts",
      "tests/unit/dojo_proof_claims.test.ts",
      "tests/unit/dojo_private_tool_gate.test.ts",
      "tests/unit/dojo_browser_workflow_gate.test.ts",
      "tests/unit/dojo_scenario_oracle.test.ts",
      "tests/unit/security.test.ts",
    ]));
    expect(DOJO_SECURITY_ABUSE_TEST_FILES.length).toBeGreaterThanOrEqual(12);
  });

  it("builds digest evidence for a completed security abuse run", () => {
    const evidence = buildDojoSecurityAbuseEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      testFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
      stdout: "all tests passed",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: vitestJsonReportFixture(),
      jsonReportPath: "tmp/dojo-security-abuse.vitest.json",
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.securityAbuseEvidence.v1",
      ok: true,
      exit_code: 0,
      test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length,
      reported_test_file_count: 1,
      abuse_class_coverage_complete: true,
      tested_abuse_classes: expect.arrayContaining([
        "proof_signature_tampering",
        "raw_private_tool_bypass",
        "raw_browser_workflow_bypass",
        "prompt_injection_scanning",
      ]),
      missing_abuse_classes: [],
    }));
    expect(evidence.abuse_class_coverage).toHaveLength(DOJO_SECURITY_ABUSE_CLASSES.length);
    expect(evidence.test_summary.total_tests).toBeGreaterThanOrEqual(DOJO_SECURITY_ABUSE_CLASSES.length);
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when an abuse class has no executable test evidence", () => {
    const partialCoverage = buildAbuseClassCoverage({
      abuseClasses: DOJO_SECURITY_ABUSE_CLASSES,
      jsonReport: vitestJsonReportFixture({
        titles: ["Dojo proof signing signs Ed25519 payloads and verifies them with the public key"],
      }),
    });
    const evidence = buildDojoSecurityAbuseEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      testFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
      stdout: "all tests passed",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: vitestJsonReportFixture({
        titles: ["Dojo proof signing signs Ed25519 payloads and verifies them with the public key"],
      }),
      jsonReportPath: "tmp/dojo-security-abuse.vitest.json",
    });

    expect(partialCoverage.some((item) => !item.covered)).toBe(true);
    expect(evidence.ok).toBe(false);
    expect(evidence.budget_evaluation.checks.abuse_class_coverage_complete).toBe(false);
    expect(evidence.missing_abuse_classes.length).toBeGreaterThan(0);
  });
});

function vitestJsonReportFixture(input = {}) {
  const titles = input.titles ?? [
    "Dojo public proof verifier blocks tampered or context-mismatched capsules with explicit reasons",
    "Dojo proof error taxonomy normalizes proof and license failure reasons to stable codes",
    "Dojo execution policy gate requires proof for production skill bus calls to published skills",
    "browser private tool gate blocks a Dojo-published backing private tool direct call in production",
    "browser workflow gate blocks raw replay for Dojo-published workflows in production",
    "Dojo proof claims blocks strict proof issuance when required evidence claims are missing",
    "Dojo evidence claim verifier returns stale when evidence is older than the requested max age",
    "Dojo guardrail runtime blocks graph execution when a block-severity guardrail fails",
    "security patterns flags `ignore previous instructions`",
    "Dojo scenario oracle fails prompt injection document scenarios when instructions are not quarantined",
  ];
  return {
    success: true,
    numTotalTests: titles.length,
    numPassedTests: titles.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    testResults: [
      {
        startTime: 0,
        endTime: 100,
        assertionResults: titles.map((title, index) => ({
          fullName: title,
          title,
          status: "passed",
          duration: index + 1,
        })),
      },
    ],
  };
}
