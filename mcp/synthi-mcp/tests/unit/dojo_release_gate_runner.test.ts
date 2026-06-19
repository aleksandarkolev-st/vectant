// @ts-nocheck
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateManifest,
  DOJO_ENTERPRISE_RELEASE_GATE_IDS,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  validateDojoReleaseGateManifest,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  buildDojoReleaseGateCommandSpec,
  buildDojoReleaseGateExecutionPlan,
  buildDojoReleaseGateRunReport,
  collectDojoReleaseGateProducedArtifacts,
  executeDojoReleaseGatePlan,
  parseDojoReleaseGateRunnerArgs,
  runDojoReleaseGateRunner,
  selectDojoReleaseGateIds,
} from "../../scripts/dojo-release-gate-runner.mjs";

function realPackageScripts() {
  const mcpPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const frontendPackage = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "synthi", "package.json"), "utf8"));
  return {
    "mcp/synthi-mcp/package.json": mcpPackage.scripts,
    "synthi/package.json": frontendPackage.scripts,
  };
}

function manifest() {
  return buildDojoReleaseGateManifest({
    generatedAt: "2026-06-11T00:00:00.000Z",
    packageScripts: realPackageScripts(),
  });
}

describe("Dojo release gate runner", () => {
  it("parses inline CLI arguments without dropping runner execution flags", () => {
    expect(parseDojoReleaseGateRunnerArgs([
      "--scope=minimal-pr",
      "--execute",
      "--continue-on-failure=true",
      "--out-dir=tmp/dojo-release-gate-runner-inline",
      "--gate=mcp_typecheck",
      "--gate=frontend_build",
    ])).toEqual({
      scope: "minimal-pr",
      execute: "1",
      "continue-on-failure": "true",
      "out-dir": "tmp/dojo-release-gate-runner-inline",
      gate: ["mcp_typecheck", "frontend_build"],
    });
  });

  it("selects gate IDs from the authoritative manifest scopes", () => {
    const releaseManifest = manifest();

    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "minimal-pr" })).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "milestone" })).toEqual(DOJO_MILESTONE_GATE_IDS);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "release" })).toEqual(releaseManifest.release_gate_ids);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "enterprise-release" })).toEqual(releaseManifest.enterprise_release_gate_ids);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "enterprise" })).toEqual(DOJO_ENTERPRISE_RELEASE_GATE_IDS);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "nightly" })).toEqual(expect.arrayContaining([
      "dojo_chaos_performance_self_check",
      "dojo_soak_performance_self_check",
      "soak_performance",
    ]));
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "nightly" })).not.toContain("workflow_e2e_hosted");
  });

  it("keeps live, deployed, security, and soak gates out of the minimal execution plan", () => {
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: manifest(),
      scope: "minimal-pr",
      env: {},
    });

    expect(plan.selected_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(new Set(plan.gates.map((gate) => gate.tier))).toEqual(new Set(["T0", "T1"]));
    expect(plan.selected_gate_ids).not.toContain("workflow_e2e_hosted");
    expect(plan.selected_gate_ids).not.toContain("dojo_mcp_host_conformance");
    expect(plan.selected_gate_ids).not.toContain("security_abuse_suite");
    expect(plan.selected_gate_ids).not.toContain("dojo_soak_performance_self_check");
    expect(plan.selected_gate_ids).not.toContain("soak_performance");
  });

  it("keeps enterprise release as release plus enterprise T8 gates", () => {
    const releaseManifest = manifest();
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "enterprise-release",
      env: {},
    });

    expect(plan.scope).toBe("enterprise-release");
    expect(plan.selected_gate_ids).toEqual(releaseManifest.enterprise_release_gate_ids);
    expect(plan.selected_gate_ids).toEqual(expect.arrayContaining([
      ...releaseManifest.release_gate_ids,
      "dojo_chaos_performance_self_check",
      "dojo_soak_performance_self_check",
      "soak_performance",
    ]));
    const tiers = new Set(plan.gates.map((gate) => gate.tier));
    for (const tier of ["T5", "T6", "T7", "T8"]) {
      expect(tiers.has(tier)).toBe(true);
    }
  });

  it("requires live soak session and duration env before planning the legacy soak gate", () => {
    const releaseManifest = manifest();
    const missingEnvPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "nightly",
      env: {},
    });
    const missingSoakGate = missingEnvPlan.gates.find((gate) => gate.gate_id === "soak_performance");

    expect(missingSoakGate).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "missing_required_env",
      missing_env: ["SYNTHI_SESSION_ID", "SOAK_DURATION_MIN"],
    }));

    const partialEnvPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "nightly",
      env: { SYNTHI_SESSION_ID: "session-123" },
    });
    expect(partialEnvPlan.gates.find((gate) => gate.gate_id === "soak_performance")).toEqual(expect.objectContaining({
      status: "skipped",
      missing_env: ["SOAK_DURATION_MIN"],
    }));

    const tooShortPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "nightly",
      env: { SYNTHI_SESSION_ID: "session-123", SOAK_DURATION_MIN: "10" },
    });
    expect(tooShortPlan.gates.find((gate) => gate.gate_id === "soak_performance")).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "invalid_required_env",
      missing_env: [],
      invalid_env: [expect.objectContaining({
        env: "SOAK_DURATION_MIN",
        value: "10",
        reason: "below_min:60",
      })],
    }));

    const readyPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "nightly",
      env: { SYNTHI_SESSION_ID: "session-123", SOAK_DURATION_MIN: "60" },
    });
    expect(readyPlan.gates.find((gate) => gate.gate_id === "soak_performance")).toEqual(expect.objectContaining({
      status: "planned",
      missing_env: [],
      invalid_env: [],
    }));
  });

  it("validates typed live-gate environment values before planning execution", () => {
    const releaseManifest = manifest();
    const invalidHostPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "release",
      gateIds: ["private_tool_stdio_host_conformance"],
      env: {
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/local",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "relative/private-tools.json",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "secret-key",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "tenant/workspace",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL: "https://app.example.com/workspace",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND: "node",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON: "{\"bad\":true}",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD: "relative/cwd",
      },
    });

    expect(invalidHostPlan.gates[0]).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "invalid_required_env",
      missing_env: [],
      invalid_env: expect.arrayContaining([
        expect.objectContaining({
          env: "SYNTHI_HOSTED_BROWSER_CDP_URL",
          reason: "loopback_or_local_bind_url",
        }),
        expect.objectContaining({
          env: "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
          reason: "not_absolute_path",
        }),
        expect.objectContaining({
          env: "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON",
          reason: "not_json_array",
        }),
        expect.objectContaining({
          env: "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD",
          reason: "not_absolute_path",
        }),
      ]),
    }));

    const readyHostPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "release",
      gateIds: ["private_tool_stdio_host_conformance"],
      env: {
        SYNTHI_HOSTED_BROWSER_CDP_URL: "wss://runtime.example.com/devtools/browser/remote",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: join(tmpdir(), "private-tools.json"),
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "secret-key",
        SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "tenant/workspace",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL: "https://app.example.com/workspace",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND: "node",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON: "[\"/opt/synthi/mcp/dist/index.js\"]",
        SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD: join(tmpdir(), "mcp"),
      },
    });

    expect(readyHostPlan.gates[0]).toEqual(expect.objectContaining({
      status: "planned",
      missing_env: [],
      invalid_env: [],
    }));
  });

  it("validates explicit boolean release claims for deployed MCP conformance gates", () => {
    const releaseManifest = manifest();
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "release",
      gateIds: ["dojo_mcp_host_conformance"],
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "https://mcp.example.com",
        SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING: "false",
        SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING: "1",
      },
    });

    expect(plan.gates[0]).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "missing_required_env",
      missing_env: ["SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING"],
    }));

    const invalidUrlPlan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "release",
      gateIds: ["dojo_mcp_host_conformance"],
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "http://localhost:3333",
        SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING: "1",
      },
    });

    expect(invalidUrlPlan.gates[0]).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "invalid_required_env",
      missing_env: [],
      invalid_env: [
        expect.objectContaining({
          env: "SYNTHI_DOJO_MCP_HOST_URL",
          reason: "loopback_or_local_bind_url",
        }),
      ],
    }));
  });

  it("represents missing environment requirements as explicit skipped gates by default", () => {
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: manifest(),
      scope: "milestone",
      env: {},
    });
    const postgresGate = plan.gates.find((gate) => gate.gate_id === "dojo_postgres_control_plane_self_check");
    const dockerGate = plan.gates.find((gate) => gate.gate_id === "docker_integration");

    expect(postgresGate).toEqual(expect.objectContaining({
      status: "skipped",
      skip_reason: "missing_required_env",
      missing_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
    }));
    expect(dockerGate.missing_env).toEqual([
      "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS",
      "AI_ENGINE_HOST_PORT",
      "POSTGRES_HOST_PORT",
    ]);
  });

  it("can escalate missing environment requirements into failed execution results", async () => {
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: manifest(),
      scope: "milestone",
      gateIds: ["dojo_postgres_control_plane_self_check"],
      env: {},
      failOnMissingEnv: true,
    });
    const results = await executeDojoReleaseGatePlan({
      plan,
      outDir: await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-")),
      executor: async () => {
        throw new Error("executor_should_not_run_for_missing_env");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({
        gate_id: "dojo_postgres_control_plane_self_check",
        status: "failed",
        failure_reason: "missing_required_env",
        missing_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
    ]);
  });

  it("fails dry-run reports when fail-on-missing-env is requested", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-"));
    const result = await runDojoReleaseGateRunner({
      scope: "milestone",
      gateIds: ["dojo_postgres_control_plane_self_check"],
      dryRun: true,
      execute: false,
      outDir,
      generatedAt: "2026-06-11T00:00:00.000Z",
      env: {},
      failOnMissingEnv: true,
    });
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    const evidence = JSON.parse(await readFile(result.evidence_path, "utf8"));

    expect(report).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      promotion_ready: false,
      counts: expect.objectContaining({
        failed: 1,
        skipped: 0,
      }),
    }));
    expect(report.errors).toEqual(expect.arrayContaining([
      "gate_failed:dojo_postgres_control_plane_self_check:missing_required_env",
    ]));
    expect(report.results).toEqual([
      expect.objectContaining({
        gate_id: "dojo_postgres_control_plane_self_check",
        status: "failed",
        executed: false,
        failure_reason: "missing_required_env",
        missing_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
    ]);
    expect(evidence).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      promotion_ready: false,
      failed_gate_count: 1,
      skipped_gate_count: 0,
    }));
  });

  it("can escalate invalid environment requirements into failed execution results", async () => {
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: manifest(),
      scope: "nightly",
      gateIds: ["soak_performance"],
      env: { SYNTHI_SESSION_ID: "session-123", SOAK_DURATION_MIN: "10" },
      failOnMissingEnv: true,
    });
    const results = await executeDojoReleaseGatePlan({
      plan,
      outDir: await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-")),
      executor: async () => {
        throw new Error("executor_should_not_run_for_invalid_env");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({
        gate_id: "soak_performance",
        status: "failed",
        failure_reason: "invalid_required_env",
        missing_env: [],
        invalid_env: [expect.objectContaining({
          env: "SOAK_DURATION_MIN",
          value: "10",
          reason: "below_min:60",
        })],
      }),
    ]);
  });

  it("derives npm execution commands without shell cd or command separators", () => {
    const releaseManifest = manifest();
    const frontendUnitGate = releaseManifest.gates.find((gate) => gate.id === "frontend_dojo_unit_tests");
    const spec = buildDojoReleaseGateCommandSpec(frontendUnitGate);

    expect(spec.package_prefix).toBe("synthi");
    expect(spec.args).toEqual([
      "--prefix",
      "synthi",
      "run",
      "test",
      "--",
      "src/components/agent-workflows",
      "src/components/dojo",
      "src/services",
    ]);
    expect(spec.canonical_command).not.toContain("cd ");
    expect(spec.canonical_command).not.toContain("&&");
  });

  it("builds a promotion-ready report only when every selected gate passed", async () => {
    const releaseManifest = manifest();
    const validation = validateDojoReleaseGateManifest(releaseManifest, { packageScripts: realPackageScripts() });
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "minimal-pr",
      gateIds: ["mcp_typecheck", "frontend_build"],
      env: {},
    });
    const results = await executeDojoReleaseGatePlan({
      plan,
      outDir: await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-")),
      executor: async ({ gatePlan }) => ({
        gate_id: gatePlan.gate_id,
        tier: gatePlan.tier,
        status: "passed",
        executed: true,
        command: gatePlan.execution_spec.canonical_command,
        exit_code: 0,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
        expected_artifacts: gatePlan.expected_artifacts,
      }),
    });
    const report = buildDojoReleaseGateRunReport({
      manifest: releaseManifest,
      manifestValidation: validation,
      plan,
      results,
      scope: "minimal-pr",
      dryRun: false,
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      ok: true,
      complete: true,
      promotion_ready: true,
      counts: expect.objectContaining({
        selected: 2,
        executed: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      }),
    }));
  });

  it("does not mark duplicated runner results as selected-gate coverage", async () => {
    const releaseManifest = manifest();
    const validation = validateDojoReleaseGateManifest(releaseManifest, { packageScripts: realPackageScripts() });
    const plan = buildDojoReleaseGateExecutionPlan({
      manifest: releaseManifest,
      scope: "minimal-pr",
      gateIds: ["mcp_typecheck", "frontend_build"],
      env: {},
    });
    const results = await executeDojoReleaseGatePlan({
      plan,
      outDir: await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-")),
      executor: async ({ gatePlan }) => ({
        gate_id: gatePlan.gate_id,
        tier: gatePlan.tier,
        status: "passed",
        executed: true,
        command: gatePlan.execution_spec.canonical_command,
        exit_code: 0,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
        expected_artifacts: gatePlan.expected_artifacts,
      }),
    });
    const duplicatedResults = [
      results[0],
      { ...results[0] },
    ];
    const report = buildDojoReleaseGateRunReport({
      manifest: releaseManifest,
      manifestValidation: validation,
      plan,
      results: duplicatedResults,
      scope: "minimal-pr",
      dryRun: false,
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(report).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      promotion_ready: false,
    }));
    expect(report.errors).toEqual(expect.arrayContaining([
      "runner_selected_gate_result_missing:frontend_build",
      "runner_duplicate_result_gate:mcp_typecheck",
    ]));
  });

  it("writes dry-run artifacts without claiming promotion readiness", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-"));
    const result = await runDojoReleaseGateRunner({
      scope: "minimal-pr",
      dryRun: true,
      execute: false,
      outDir,
      generatedAt: "2026-06-11T00:00:00.000Z",
      env: {},
    });
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    const evidence = JSON.parse(await readFile(result.evidence_path, "utf8"));
    const manifestText = await readFile(result.manifest_path, "utf8");

    expect(report.schema_version).toBe("synthi.dojo.releaseGateRun.v1");
    expect(report.dry_run).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.promotion_ready).toBe(false);
    expect(report.plan.selected_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(report.results.every((gate) => gate.status === "planned")).toBe(true);
    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.releaseGateRunEvidence.v1",
      report_path: result.report_path,
      report_sha256: createHash("sha256").update(await readFile(result.report_path, "utf8")).digest("hex"),
      dry_run: true,
      complete: false,
      promotion_ready: false,
      selected_gate_count: DOJO_MINIMAL_PR_GATE_IDS.length,
      manifest_path: result.manifest_path,
      manifest_sha256: report.manifest.sha256,
      manifest_artifact_sha256: createHash("sha256").update(manifestText).digest("hex"),
      manifest_bytes: Buffer.byteLength(manifestText),
    }));
  });

  it("can bind a runner report to a supplied manifest artifact", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-"));
    const releaseManifest = manifest();
    const result = await runDojoReleaseGateRunner({
      scope: "minimal-pr",
      gateIds: ["mcp_typecheck"],
      dryRun: true,
      execute: false,
      outDir,
      generatedAt: "2026-06-18T00:00:00.000Z",
      env: {},
      manifest: releaseManifest,
    });
    const expectedSha256 = createHash("sha256").update(JSON.stringify(releaseManifest)).digest("hex");
    const manifestArtifact = JSON.parse(await readFile(result.manifest_path, "utf8"));
    const evidence = JSON.parse(await readFile(result.evidence_path, "utf8"));

    expect(result.report.manifest.sha256).toBe(expectedSha256);
    expect(result.report.manifest.gate_count).toBe(releaseManifest.gates.length);
    expect(result.report.plan.selected_gate_ids).toEqual(["mcp_typecheck"]);
    expect(manifestArtifact).toEqual(releaseManifest);
    expect(evidence.manifest_path).toBe(result.manifest_path);
    expect(evidence.manifest_sha256).toBe(expectedSha256);
  });

  it("hashes expected gate artifacts and records missing artifacts explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-"));
    const evidencePath = join(dir, "evidence.json");
    const missingReportPath = join(dir, "missing-report.json");
    const evidenceBody = JSON.stringify({ ok: true, generated_at: "2026-06-11T00:00:00.000Z" });
    await writeFile(evidencePath, evidenceBody, "utf8");

    const artifacts = await collectDojoReleaseGateProducedArtifacts({
      expectedArtifacts: {
        report_path: missingReportPath,
        evidence_path: evidencePath,
        events_path: null,
      },
    });

    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "evidence",
        exists: true,
        required: true,
        bytes: Buffer.byteLength(evidenceBody),
        sha256: createHash("sha256").update(evidenceBody).digest("hex"),
      }),
      expect.objectContaining({
        kind: "report",
        exists: false,
        required: true,
        error_code: "ENOENT",
      }),
    ]));
  });

  it("marks expected artifacts stale when they predate the gate command start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dojo-release-gate-runner-"));
    const evidencePath = join(dir, "evidence.json");
    const evidenceBody = JSON.stringify({ ok: true, generated_at: "2026-06-11T00:00:00.000Z" });
    await writeFile(evidencePath, evidenceBody, "utf8");

    const artifacts = await collectDojoReleaseGateProducedArtifacts({
      expectedArtifacts: {
        report_path: null,
        evidence_path: evidencePath,
        events_path: null,
      },
      freshAfterIso: "2999-01-01T00:00:00.000Z",
      freshnessToleranceMs: 0,
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        kind: "evidence",
        exists: true,
        required: true,
        fresh_after: "2999-01-01T00:00:00.000Z",
        fresh_after_tolerance_ms: 0,
        fresh: false,
      }),
    ]);
  });
});
