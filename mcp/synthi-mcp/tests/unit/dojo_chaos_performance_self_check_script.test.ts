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
  numTotalTestSuites: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
  numPassedTestSuites: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
  numFailedTestSuites: 0,
  numTotalTests: 18,
  numPassedTests: 18,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [
    {
      name: "tests/unit/dojo_fixture_materializer.test.ts",
      startTime: 800,
      endTime: 900,
      assertionResults: [
        {
          fullName: "Dojo synthetic fixture materializer creates duplicate entity fixtures with same display name and different stable IDs",
          title: "creates duplicate entity fixtures with same display name and different stable IDs",
          status: "passed",
          duration: 35,
        },
        {
          fullName: "Dojo synthetic fixture materializer materializes prompt injection document fixtures as quarantined synthetic tissue",
          title: "materializes prompt injection document fixtures as quarantined synthetic tissue",
          status: "passed",
          duration: 25,
        },
      ],
    },
    {
      name: "tests/unit/dojo_evidence_record.test.ts",
      startTime: 910,
      endTime: 960,
      assertionResults: [
        {
          fullName: "Dojo evidence ledger record fails closed when a required evidence signature is unavailable",
          title: "fails closed when a required evidence signature is unavailable",
          status: "passed",
          duration: 20,
        },
      ],
    },
    {
      name: "tests/unit/dojo_graph_runtime.test.ts",
      startTime: 970,
      endTime: 1120,
      assertionResults: [
        {
          fullName: "Dojo graph runtime returns a blocked run when graph evidence writing fails",
          title: "returns a blocked run when graph evidence writing fails",
          status: "passed",
          duration: 35,
        },
        {
          fullName: "Dojo graph runtime blocks production actions when evidence writer does not return a ledger-backed ref",
          title: "blocks production actions when evidence writer does not return a ledger-backed ref",
          status: "passed",
          duration: 42,
        },
        {
          fullName: "Dojo graph runtime blocks a node when one of its expiry triggers is active",
          title: "blocks a node when one of its expiry triggers is active",
          status: "passed",
          duration: 24,
        },
      ],
    },
    {
      name: "tests/unit/dojo_proof_signing.test.ts",
      startTime: 1130,
      endTime: 1210,
      assertionResults: [
        {
          fullName: "Dojo proof signing fails closed when an external command signer exits or returns the wrong key",
          title: "fails closed when an external command signer exits or returns the wrong key",
          status: "passed",
          duration: 30,
        },
        {
          fullName: "Dojo proof signing fails closed when a managed key service returns mismatched custody metadata",
          title: "fails closed when a managed key service returns mismatched custody metadata",
          status: "passed",
          duration: 28,
        },
      ],
    },
    {
      name: "tests/unit/dojo_source_drift.test.ts",
      startTime: 1220,
      endTime: 1310,
      assertionResults: [
        {
          fullName: "Dojo source drift expiry expires graph nodes mapped to changed source tokens",
          title: "expires graph nodes mapped to changed source tokens",
          status: "passed",
          duration: 36,
        },
        {
          fullName: "Dojo source drift expiry rejects drift reports from tampered or unverifiable source snapshots",
          title: "rejects drift reports from tampered or unverifiable source snapshots",
          status: "passed",
          duration: 18,
        },
      ],
    },
    {
      name: "tests/integration/dojo_api_fault_server.test.ts",
      startTime: 1320,
      endTime: 1450,
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
        {
          fullName: "Dojo API fault server supports success, validation error, timeout, and downstream failure behaviors",
          title: "supports success, validation error, timeout, and downstream failure behaviors",
          status: "passed",
          duration: 40,
        },
      ],
    },
    {
      name: "tests/integration/dojo_vivarium_runner.test.ts",
      startTime: 1460,
      endTime: 1550,
      assertionResults: [
        {
          fullName: "Dojo Vivarium runner executes scenario against materialized synthetic fixtures and records observed evidence",
          title: "executes scenario against materialized synthetic fixtures and records observed evidence",
          status: "passed",
          duration: 15,
        },
      ],
    },
    {
      name: "tests/integration/dojo_checkride_runner.test.ts",
      startTime: 1560,
      endTime: 1660,
      assertionResults: [
        {
          fullName: "Dojo executable checkride runner derives entrustment from evidence-backed results",
          title: "derives entrustment from evidence-backed results",
          status: "passed",
          duration: 14,
        },
        {
          fullName: "Dojo executable checkride runner fails closed when ledger-backed checkride evidence is required but unavailable",
          title: "fails closed when ledger-backed checkride evidence is required but unavailable",
          status: "passed",
          duration: 22,
        },
      ],
    },
    {
      name: "tests/integration/dojo_evil_twin_runner.test.ts",
      startTime: 1670,
      endTime: 1730,
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
    {
      name: "tests/unit/dojo_tools.test.ts",
      startTime: 1740,
      endTime: 1920,
      assertionResults: [
        {
          fullName: "Agent Dojo MCP tools authorizes hosted runtime sessions before consuming production proof capsules",
          title: "authorizes hosted runtime sessions before consuming production proof capsules",
          status: "passed",
          duration: 45,
        },
      ],
    },
  ],
};

const CHAOS_RUNNER_REPORT = {
  schema_version: "synthi.chaosRunnerReport.v1",
  ok: true,
  scenario_count: 6,
  iteration_count: 1,
  expected_run_count: 6,
  passed_run_count: 6,
  failed_run_count: 0,
  scenarios: [
    { name: "api_fault_server", description: "API faults" },
    { name: "evidence_custody_fail_closed", description: "Evidence custody failure" },
    { name: "proof_signing_outage", description: "Proof signing outage" },
    { name: "runtime_preflight_fail_closed", description: "Preflight failure" },
    { name: "source_drift_mid_run", description: "Source drift during run" },
    { name: "vivarium_oracle", description: "Vivarium oracle" },
  ],
  results: [
    { ok: true, scenario: "api_fault_server", name: "api_fault_server#1" },
    { ok: true, scenario: "evidence_custody_fail_closed", name: "evidence_custody_fail_closed#1" },
    { ok: true, scenario: "proof_signing_outage", name: "proof_signing_outage#1" },
    { ok: true, scenario: "runtime_preflight_fail_closed", name: "runtime_preflight_fail_closed#1" },
    { ok: true, scenario: "source_drift_mid_run", name: "source_drift_mid_run#1" },
    { ok: true, scenario: "vivarium_oracle", name: "vivarium_oracle#1" },
  ],
};

function chaosRunnerEvidenceFixture() {
  return {
    chaosRunnerReport: CHAOS_RUNNER_REPORT,
    chaosRunnerReportPath: "tmp/chaos-runner.json",
    chaosRunnerReportText: JSON.stringify(CHAOS_RUNNER_REPORT),
    chaosRunnerStdout: "PASS api_fault_server#1\nPASS evidence_custody_fail_closed#1\nPASS proof_signing_outage#1\nPASS runtime_preflight_fail_closed#1\nPASS source_drift_mid_run#1\nPASS vivarium_oracle#1\n",
    chaosRunnerStderr: "",
    chaosRunnerStdoutPath: "tmp/chaos-runner.stdout.log",
    chaosRunnerStderrPath: "tmp/chaos-runner.stderr.log",
    chaosRunnerExitCode: 0,
    chaosRunnerSignal: null,
  };
}

describe("Dojo chaos performance self-check script", () => {
  it("defines executable integration tests for T8 preflight coverage", () => {
    expect(DOJO_CHAOS_PERFORMANCE_TEST_FILES).toEqual([
      "tests/unit/dojo_fixture_materializer.test.ts",
      "tests/unit/dojo_evidence_record.test.ts",
      "tests/unit/dojo_graph_runtime.test.ts",
      "tests/unit/dojo_proof_signing.test.ts",
      "tests/unit/dojo_source_drift.test.ts",
      "tests/integration/dojo_api_fault_server.test.ts",
      "tests/integration/dojo_vivarium_runner.test.ts",
      "tests/integration/dojo_checkride_runner.test.ts",
      "tests/integration/dojo_evil_twin_runner.test.ts",
      "tests/unit/dojo_tools.test.ts",
    ]);
    expect(DOJO_CHAOS_SCENARIOS).toEqual(expect.arrayContaining([
      "api_timeout",
      "partial_write",
      "fake_success_ui",
      "evil_twin_attack_hardening",
      "hosted_runtime_preflight_fail_closed",
      "proof_not_consumed_on_failed_preflight",
      "evidence_store_unavailable",
      "proof_signing_service_unavailable",
      "source_contract_drift_mid_run",
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
      ...chaosRunnerEvidenceFixture(),
      timeoutMs: 120000,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
      ok: true,
      exit_code: 0,
      duration_ms: 2345.679,
      configured_scenario_count: DOJO_CHAOS_SCENARIOS.length,
      test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
      reported_test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
      json_report_path: "tmp/vitest.json",
      scenario_coverage_complete: true,
      missing_chaos_scenarios: [],
      tested_chaos_scenarios: expect.arrayContaining([
        "duplicate_entity_fixture",
        "prompt_injection_fixture",
        "partial_write",
        "fake_success_ui",
        "runtime_oracle_classification",
        "evil_twin_attack_hardening",
        "evidence_store_unavailable",
        "proof_signing_service_unavailable",
        "source_contract_drift_mid_run",
      ]),
      test_summary: expect.objectContaining({
        total_tests: 18,
        passed_tests: 18,
        failed_tests: 0,
        assertion_duration_p95_ms: 60,
        test_file_duration_p95_ms: 180,
      }),
      performance_metrics: expect.objectContaining({
        self_check_duration_ms: 2345.679,
        test_case_duration_p95_ms: 60,
        test_file_duration_p95_ms: 180,
      }),
      budget_evaluation: expect.objectContaining({
        ok: true,
        checks: expect.objectContaining({
          no_failed_tests: true,
          all_reported_tests_passed: true,
          scenario_coverage_complete: true,
          chaos_runner_report_ok: true,
          chaos_runner_has_scenarios: true,
          chaos_runner_all_runs_passed: true,
        }),
      }),
      chaos_runner_required: true,
      chaos_runner: expect.objectContaining({
        ok: true,
        scenario_count: 6,
        expected_run_count: 6,
        passed_run_count: 6,
        failed_run_count: 0,
        scenarios: expect.arrayContaining([
          "api_fault_server",
          "evidence_custody_fail_closed",
          "proof_signing_outage",
          "runtime_preflight_fail_closed",
          "source_drift_mid_run",
          "vivarium_oracle",
        ]),
      }),
      budget: expect.objectContaining({
        intended_gate: "lightweight_preflight_not_long_soak",
      }),
    }));
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.json_report_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.json_report_bytes).toBeGreaterThan(0);
  });

  it("fails metrics evidence when the Vitest report omits a configured chaos test file", () => {
    const partialReport = {
      ...VITEST_REPORT,
      numTotalTestSuites: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length - 1,
      numPassedTestSuites: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length - 1,
      testResults: VITEST_REPORT.testResults.filter((result) => result.name !== "tests/integration/dojo_checkride_runner.test.ts"),
    };
    const reportedAssertions = partialReport.testResults.flatMap((result) => result.assertionResults);
    partialReport.numTotalTests = reportedAssertions.length;
    partialReport.numPassedTests = reportedAssertions.length;
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
      jsonReport: partialReport,
      jsonReportPath: "tmp/vitest.json",
      ...chaosRunnerEvidenceFixture(),
      timeoutMs: 120000,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.reported_test_file_count).toBe(DOJO_CHAOS_PERFORMANCE_TEST_FILES.length - 1);
    expect(evidence.budget_evaluation.checks.all_test_files_reported).toBe(false);
  });

  it("fails metrics evidence when the chaos runner report is missing or failed", () => {
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
      chaosRunnerReport: {
        ...CHAOS_RUNNER_REPORT,
        ok: false,
        failed_run_count: 1,
        passed_run_count: 2,
      },
      chaosRunnerReportPath: "tmp/chaos-runner.json",
      chaosRunnerReportText: JSON.stringify({ ...CHAOS_RUNNER_REPORT, ok: false }),
      chaosRunnerStdout: "FAIL api_fault_server#1\n",
      chaosRunnerStderr: "scenario failed",
      chaosRunnerStdoutPath: "tmp/chaos-runner.stdout.log",
      chaosRunnerStderrPath: "tmp/chaos-runner.stderr.log",
      chaosRunnerExitCode: 1,
      chaosRunnerSignal: null,
      chaosRunnerError: "chaos_runner_exit_1",
      timeoutMs: 120000,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.chaos_runner.ok).toBe(false);
    expect(evidence.budget_evaluation.checks.chaos_runner_report_ok).toBe(false);
    expect(evidence.budget_evaluation.checks.chaos_runner_all_runs_passed).toBe(false);
  });

  it("summarizes Vitest JSON and reports scenario coverage gaps honestly", () => {
    const summary = summarizeVitestJsonReport(VITEST_REPORT);
    expect(summary).toEqual(expect.objectContaining({
      success: true,
      total_tests: 18,
      passed_tests: 18,
      failed_tests: 0,
      assertion_duration_p95_ms: 60,
      test_file_duration_p95_ms: 180,
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
        covered: true,
        evidence_titles: expect.arrayContaining([
          "Dojo synthetic fixture materializer materializes prompt injection document fixtures as quarantined synthetic tissue",
        ]),
      }),
    ]);
    expect(buildScenarioCoverage({
      scenarios: ["hosted_runtime_preflight_fail_closed", "proof_not_consumed_on_failed_preflight"],
      jsonReport: VITEST_REPORT,
    })).toEqual([
      expect.objectContaining({
        scenario: "hosted_runtime_preflight_fail_closed",
        covered: true,
      }),
      expect.objectContaining({
        scenario: "proof_not_consumed_on_failed_preflight",
        covered: true,
      }),
    ]);
  });
});
