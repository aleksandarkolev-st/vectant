// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildDojoChaosPerformanceEvidenceManifest,
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
} from "../../scripts/dojo-chaos-performance-self-check.mjs";

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
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.chaosPerformanceEvidence.v1",
      ok: true,
      exit_code: 0,
      duration_ms: 2345.679,
      scenario_count: DOJO_CHAOS_SCENARIOS.length,
      test_file_count: DOJO_CHAOS_PERFORMANCE_TEST_FILES.length,
      budget: expect.objectContaining({
        intended_gate: "lightweight_preflight_not_long_soak",
      }),
    }));
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
