// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildDojoSecurityAbuseEvidenceManifest,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "../../scripts/dojo-security-abuse-self-check.mjs";

describe("Dojo security abuse self-check script", () => {
  it("defines a focused executable abuse-suite file list", () => {
    expect(DOJO_SECURITY_ABUSE_TEST_FILES).toEqual(expect.arrayContaining([
      "tests/unit/dojo_proof_errors.test.ts",
      "tests/unit/dojo_proof_claims.test.ts",
      "tests/unit/dojo_private_tool_gate.test.ts",
      "tests/unit/dojo_browser_workflow_gate.test.ts",
      "tests/unit/security.test.ts",
    ]));
    expect(DOJO_SECURITY_ABUSE_TEST_FILES.length).toBeGreaterThanOrEqual(10);
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
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.securityAbuseEvidence.v1",
      ok: true,
      exit_code: 0,
      test_file_count: DOJO_SECURITY_ABUSE_TEST_FILES.length,
      tested_abuse_classes: expect.arrayContaining([
        "proof_signature_tampering",
        "raw_private_tool_bypass",
        "raw_browser_workflow_bypass",
        "prompt_injection_scanning",
      ]),
    }));
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
