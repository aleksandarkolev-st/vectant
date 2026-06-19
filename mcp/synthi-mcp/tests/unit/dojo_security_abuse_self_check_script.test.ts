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
      "tests/unit/browser_tools.test.ts",
      "tests/unit/dojo_proof_errors.test.ts",
      "tests/unit/dojo_proof_claims.test.ts",
      "tests/unit/dojo_proof_capsule_service.test.ts",
      "tests/unit/dojo_private_tool_gate.test.ts",
      "tests/unit/dojo_browser_workflow_gate.test.ts",
      "tests/unit/dojo_mcp_skill_bus.test.ts",
      "tests/unit/dojo_graph_runtime.test.ts",
      "tests/unit/dojo_api_tool_compiler.test.ts",
      "tests/unit/dojo_substrate_executor.test.ts",
      "tests/unit/dojo_scenario_oracle.test.ts",
      "tests/unit/dojo_source_drift.test.ts",
      "tests/unit/dojo_governance_service.test.ts",
      "tests/unit/dojo_hosted_runtime_postgres_store.test.ts",
      "tests/unit/security.test.ts",
      "tests/integration/dojo_vivarium_runner.test.ts",
      "tests/integration/dojo_checkride_runner.test.ts",
    ]));
    expect(DOJO_SECURITY_ABUSE_TEST_FILES.length).toBeGreaterThanOrEqual(18);
  });

  it("requires deterministic coverage for the release security abuse classes", () => {
    expect(DOJO_SECURITY_ABUSE_CLASSES).toEqual(expect.arrayContaining([
      "proof_signature_tampering",
      "proof_context_tampering",
      "proof_replay_or_missing_capsule",
      "raw_private_tool_bypass",
      "raw_browser_workflow_bypass",
      "raw_hosted_runtime_action_bypass",
      "raw_hosted_runtime_tab_mutation_bypass",
      "evidence_record_tampering",
      "evidence_claim_missing_or_stale",
      "evidence_scope_mismatch",
      "license_revocation_or_expiry",
      "source_drift_expiry",
      "tenant_workspace_isolation",
      "auth_expiry",
      "role_downgrade",
      "approval_denial",
      "fake_success_oracle",
      "guardrail_failure",
      "case_law_binding_enforcement",
      "api_tool_proof_enforcement",
      "rollback_unavailable_human_review",
      "prompt_injection_scanning",
      "untrusted_document_instruction_quarantine",
    ]));
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
      reported_test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length,
      abuse_class_coverage_complete: true,
      tested_abuse_classes: expect.arrayContaining([
        "proof_signature_tampering",
        "raw_private_tool_bypass",
        "raw_browser_workflow_bypass",
        "evidence_record_tampering",
        "license_revocation_or_expiry",
        "source_drift_expiry",
        "tenant_workspace_isolation",
        "auth_expiry",
        "role_downgrade",
        "approval_denial",
        "fake_success_oracle",
        "case_law_binding_enforcement",
        "rollback_unavailable_human_review",
        "prompt_injection_scanning",
        "untrusted_document_instruction_quarantine",
      ]),
      missing_abuse_classes: [],
    }));
    expect(evidence.abuse_class_coverage).toHaveLength(DOJO_SECURITY_ABUSE_CLASSES.length);
    expect(evidence.test_summary.total_tests).toBeGreaterThanOrEqual(DOJO_SECURITY_ABUSE_CLASSES.length);
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.json_report_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.json_report_bytes).toBeGreaterThan(0);
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

  it("fails closed when the focused abuse suite reports skipped tests", () => {
    const evidence = buildDojoSecurityAbuseEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      testFiles: DOJO_SECURITY_ABUSE_TEST_FILES,
      stdout: "some tests skipped",
      stderr: "",
      stdoutPath: "tmp/stdout.log",
      stderrPath: "tmp/stderr.log",
      jsonReport: vitestJsonReportFixture({ pending: 1 }),
      jsonReportPath: "tmp/dojo-security-abuse.vitest.json",
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.budget_evaluation.checks.no_skipped_tests).toBe(false);
    expect(evidence.budget_evaluation.failed_checks).toContain("no_skipped_tests");
  });

  it("fails closed when the Vitest report omits a configured security test file", () => {
    const reportedTestFiles = DOJO_SECURITY_ABUSE_TEST_FILES.slice(0, -1);
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
      jsonReport: vitestJsonReportFixture({ testFiles: reportedTestFiles }),
      jsonReportPath: "tmp/dojo-security-abuse.vitest.json",
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.reported_test_file_count).toBe(reportedTestFiles.length);
    expect(evidence.budget_evaluation.checks.all_test_files_reported).toBe(false);
    expect(evidence.budget_evaluation.failed_checks).toContain("all_test_files_reported");
  });
});

function vitestJsonReportFixture(input = {}) {
  const titles = input.titles ?? [
    "Dojo public proof verifier blocks tampered or context-mismatched capsules with explicit reasons",
    "Dojo proof error taxonomy normalizes proof and license failure reasons to stable codes",
    "Dojo proof capsule service issues verified capsules, validates without consuming on dry run, and consumes exactly once",
    "Dojo execution policy gate requires proof for production skill bus calls to published skills",
    "Dojo MCP skill bus can validate dispatch proofs through the reusable proof capsule service",
    "Dojo MCP skill bus consumes proof before non-dry dispatch through the reusable proof capsule service",
    "browser private tool gate blocks a Dojo-published backing private tool direct call in production",
    "browser workflow gate blocks raw replay for Dojo-published workflows in production",
    "browser workflow gate blocks raw hosted-runtime browser actions in production before adapter dispatch",
    "browser workflow gate blocks raw hosted-runtime tab mutations in production before adapter dispatch",
    "Dojo proof claims blocks strict proof issuance when supplied evidence record material is tampered",
    "Dojo proof claims blocks strict proof issuance when required evidence claims are missing",
    "Dojo evidence claim verifier returns stale when evidence is older than the requested max age",
    "Dojo proof claims blocks strict proof issuance when backing evidence belongs to another skill scope",
    "Dojo proof claims blocks strict proof issuance when backing evidence belongs to another workspace scope",
    "Dojo proof capsule service fails closed when a persisted proof record is not scoped to the validation tenant",
    "Dojo governance service reports expired and active license health",
    "Dojo governance service reports revoked licenses before expiry checks",
    "Dojo source drift expiry expires graph nodes mapped to changed source tokens",
    "PostgresDojoHostedRuntimeSessionStore rejects writes outside the configured tenant and workspace scope",
    "browser tools classifies expired auth checkpoints before workflow replay",
    "Dojo synthetic fixture materializer materializes role downgrade permission change identity tissue as a blocked synthetic state",
    "Dojo governance service records permission upgrade approval and denial decisions with review evidence",
    "Dojo Vivarium runner classifies fake success as failed from observed fixture state instead of visual success",
    "Dojo guardrail runtime blocks graph execution when a block-severity guardrail fails",
    "Dojo graph runtime executes case-law nodes only when referenced cases are binding",
    "Dojo API-backed MCP tool compiler does not call the API transport when reusable proof validation blocks execution",
    "Dojo substrate executor rejects compiled API production execution without transport, evidence writer, and proof validator callbacks",
    "Dojo substrate executor does not execute compiled API transport when graph proof and API proof do not match",
    "Dojo graph runtime blocks rollback nodes when rollback is unavailable without human review",
    "security patterns flags `ignore previous instructions`",
    "Dojo Vivarium runner passes prompt injection scenarios only when document instructions are quarantined",
    "Dojo scenario oracle fails prompt injection document scenarios when instructions are not quarantined",
  ];
  const pending = input.pending ?? 0;
  const testFiles = input.testFiles ?? DOJO_SECURITY_ABUSE_TEST_FILES;
  const titleBuckets = testFiles.map(() => []);
  titles.forEach((title, index) => {
    titleBuckets[index % titleBuckets.length].push(title);
  });
  return {
    success: true,
    numTotalTests: titles.length + pending,
    numPassedTests: titles.length,
    numFailedTests: 0,
    numPendingTests: pending,
    numTotalTestSuites: testFiles.length,
    numPassedTestSuites: testFiles.length,
    numFailedTestSuites: 0,
    testResults: testFiles.map((file, fileIndex) => (
      {
        name: file,
        startTime: 0,
        endTime: 100 + fileIndex,
        assertionResults: titleBuckets[fileIndex].map((title, index) => ({
          fullName: title,
          title,
          status: "passed",
          duration: index + 1,
        })),
      }
    )),
  };
}
