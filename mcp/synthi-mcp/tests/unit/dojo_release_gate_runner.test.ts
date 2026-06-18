// @ts-nocheck
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateManifest,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  validateDojoReleaseGateManifest,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  buildDojoReleaseGateCommandSpec,
  buildDojoReleaseGateExecutionPlan,
  buildDojoReleaseGateRunReport,
  executeDojoReleaseGatePlan,
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
  it("selects gate IDs from the authoritative manifest scopes", () => {
    const releaseManifest = manifest();

    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "minimal-pr" })).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "milestone" })).toEqual(DOJO_MILESTONE_GATE_IDS);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "release" })).toEqual(releaseManifest.release_gate_ids);
    expect(selectDojoReleaseGateIds(releaseManifest, { scope: "nightly" })).toEqual(expect.arrayContaining([
      "dojo_chaos_performance_self_check",
      "soak_performance",
    ]));
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
    expect(plan.selected_gate_ids).not.toContain("soak_performance");
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

    expect(report.schema_version).toBe("synthi.dojo.releaseGateRun.v1");
    expect(report.dry_run).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.promotion_ready).toBe(false);
    expect(report.plan.selected_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(report.results.every((gate) => gate.status === "planned")).toBe(true);
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

    expect(result.report.manifest.sha256).toBe(expectedSha256);
    expect(result.report.manifest.gate_count).toBe(releaseManifest.gates.length);
    expect(result.report.plan.selected_gate_ids).toEqual(["mcp_typecheck"]);
  });
});
