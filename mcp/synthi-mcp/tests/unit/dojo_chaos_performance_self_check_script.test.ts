// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildDojoChaosPerformanceEvidenceManifest,
  buildScenarioCoverage,
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
  summarizeVitestJsonReport,
} from "../../scripts/dojo-chaos-performance-self-check.mjs";

const VITEST_REPORT = {
  success: true,
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numFailedTestSuites: 0,
  numTotalTests: 4,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [
    {
      name: "tests/integration/dojo_api_fault_server.test.ts",
      startTime: 1000,
      endTime: 1130,
      assertionResults: [
        {
          fullName: "Dojo API fault server returns fake visual success while durable state remains uncommitted",
          title: "returns fake visual success while durable state remains uncommitted",
          status: "passed",
          duration: 30,
        },
        {
          fullName: "Dojo API fault server leaves an oracle-detectable partial write",
          title: "leaves an oracle-detectable partial write",
          status: "passed",
          duration: 20,
        },
      ],
    },
    {
      name: "tests/integration/dojo_evil_twin_runner.test.ts",
      startTime: 1200,
      endTime: 1260,
      assertionResults: [
        {
          fullName: "Dojo Evil Twin runtime reruns attacks after guardrail hardening and reduces attack success rate",
          title: "reruns attacks after guardrail hardening and reduces attack success rate",
          status: "passed",
          duration: 60,
        },
        {
          fullName: "Dojo executable checkride runner records blocked risk scenarios with oracle classification",
          title: "records blocked risk scenarios with oracle classification",
          status: "passed",
          duration: 10,
        },
      ],
    },
  ],
};

describe("Dojo chaos performance self-check script", () => {
  it("defines executable integration tests for T8 preflight coverage", () => {
    expect(DOJO_CHAOS_PERFORMANCE_TEST_FILES).toEqual([
      "tests/integration/dojo_api_fault_server.test.ts",
      "tests/integration/dojo_vivarium_runner.test.ts",
      "tests/integration/dojo_checkride_runner.test.ts",
      "tests/integration/dojo_evil_twin_runner.test.ts",
    ]);
    expect(DOJO_CHAOS_SCENARIOS).toEqual(expect.arrayContaining([
      "api_timeout",
      "partial_write",
      "fake_success_ui",
      "evil_twin_attack_hardening",
    ]));
  });

  it("builds metrics evidence for a completed T8 preflight run", () => {
    const evidence = buildDojoChaosPerformanceEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 2345.6789,
      testFiles: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
      scenarios: DOJO_CHAOS_SCENARIOS,
      stdout: "chaos integration tests passed",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: VITEST_REPORT,
      jsonReportPath: "tmp/vitest.json",
      timeoutMs: 120000,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
      ok: true,
      exit_code: 0,
      duration_ms: 2345.679,
      configured_scenario_count: DOJO_CHAOS_SCENARIOS.length,
      test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
      reported_test_file_count: 2,
      json_report_path: "tmp/vitest.json",
      scenario_coverage_complete: false,
      missing_chaos_scenarios: expect.arrayContaining(["prompt_injection_fixture"]),
      tested_chaos_scenarios: expect.arrayContaining([
        "partial_write",
        "fake_success_ui",
        "runtime_oracle_classification",
        "evil_twin_attack_hardening",
      ]),
      test_summary: expect.objectContaining({
        total_tests: 4,
        passed_tests: 4,
        failed_tests: 0,
        assertion_duration_p95_ms: 60,
        test_file_duration_p95_ms: 130,
      }),
      performance_metrics: expect.objectContaining({
        self_check_duration_ms: 2345.679,
        test_case_duration_p95_ms: 60,
        test_file_duration_p95_ms: 130,
      }),
      budget_evaluation: expect.objectContaining({
        ok: true,
        checks: expect.objectContaining({
          no_failed_tests: true,
          all_reported_tests_passed: true,
        }),
      }),
      budget: expect.objectContaining({
        intended_gate: "lightweight_preflight_not_long_soak",
      }),
    }));
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("summarizes Vitest JSON and reports scenario coverage gaps honestly", () => {
    const summary = summarizeVitestJsonReport(VITEST_REPORT);
    expect(summary).toEqual(expect.objectContaining({
      success: true,
      total_tests: 4,
      passed_tests: 4,
      failed_tests: 0,
      assertion_duration_p95_ms: 60,
      test_file_duration_p95_ms: 130,
    }));

    const coverage = buildScenarioCoverage({
      scenarios: ["fake_success_ui", "prompt_injection_fixture"],
      jsonReport: VITEST_REPORT,
    });
    expect(coverage).toEqual([
      expect.objectContaining({
        scenario: "fake_success_ui",
        covered: true,
        evidence_titles: expect.arrayContaining([
          "Dojo API fault server returns fake visual success while durable state remains uncommitted",
        ]),
      }),
      expect.objectContaining({
        scenario: "prompt_injection_fixture",
        covered: false,
        evidence_titles: [],
      }),
    ]);
  });
});
