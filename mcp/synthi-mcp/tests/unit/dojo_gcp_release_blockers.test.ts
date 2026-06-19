// @ts-nocheck
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildBlockerReport,
  categoryForCheck,
  parseArgs,
} from "../../scripts/dojo-gcp-release-blockers.mjs";

function inventoryReportWithChecks(checks) {
  return {
    schema_version: "synthi.dojo.gcpReleaseInventory.v1",
    created_at: "2026-06-19T00:00:00.000Z",
    mode: "execute",
    config: {
      project: "test-project",
      region: "test-region",
      cluster: "test-cluster",
      namespace: "test-namespace",
    },
    inventory: {
      commandResults: [
        {
          id: "k8s_secret_names",
          ok: false,
          exitCode: 1,
          stderrPreview: "forbidden",
          stdoutSha256: null,
          stderrSha256: "stderr-digest",
        },
      ],
    },
    evaluation: { checks },
  };
}

function warningCheck(id, detail = {}) {
  return {
    id,
    status: "warning",
    ok: false,
    optional: true,
    detail,
  };
}

function hardFailedCheck(id, detail = {}) {
  return {
    id,
    status: "failed",
    ok: false,
    detail,
  };
}

describe("Dojo GCP release blocker summarizer", () => {
  it("defaults to strict mode and parses advisory mode explicitly", () => {
    expect(parseArgs([]).advisory).toBe(false);
    expect(parseArgs(["--advisory"]).advisory).toBe(true);
    expect(parseArgs(["--mode=advisory"]).advisory).toBe(true);
    expect(parseArgs(["--mode", "strict"]).advisory).toBe(false);
    expect(() => parseArgs(["--mode=loose"])).toThrow(/strict or advisory/);
  });

  it("promotes release evidence warnings to blockers in strict mode", () => {
    const report = buildBlockerReport(inventoryReportWithChecks([
      warningCheck("k8s_secret:synthi-secrets", {
        expectedName: "synthi-secrets",
        reason: "k8s_secret_names_command_failed",
      }),
      warningCheck("k8s_deployment:dojo-mcp-host", {
        expectedName: "dojo-mcp-host",
        reason: "k8s_deployments_not_collected",
      }),
      warningCheck("kubectl_available", {
        reason: "kubectl_not_found",
      }),
    ]));

    expect(report.mode).toBe("strict");
    expect(report.release_ready).toBe(false);
    expect(report.blocker_count).toBe(3);
    expect(report.promoted_warning_blocker_count).toBe(3);
    expect(report.warnings).toHaveLength(0);
    expect(report.blockers.map((item) => item.category).sort()).toEqual([
      "deployment_inventory",
      "kubernetes_context",
      "secret_inventory",
    ]);
    expect(report.blockers.every((item) => item.promoted_from_warning === true)).toBe(true);
  });

  it("keeps promoted categories advisory when advisory mode is requested", () => {
    const report = buildBlockerReport(inventoryReportWithChecks([
      warningCheck("externalsecret:synthi-dojo-release-secrets", {
        expectedName: "synthi-dojo-release-secrets",
        reason: "k8s_external_secrets_not_collected",
      }),
      hardFailedCheck("api:container.googleapis.com", {
        api: "container.googleapis.com",
      }),
    ]), "", { advisory: true });

    expect(report.mode).toBe("advisory");
    expect(report.release_ready).toBe(false);
    expect(report.blocker_count).toBe(1);
    expect(report.promoted_warning_blocker_count).toBe(0);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        id: "externalsecret:synthi-dojo-release-secrets",
        category: "secret_inventory",
      }),
    ]);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        id: "api:container.googleapis.com",
        category: "cloud_api",
      }),
    ]);
  });

  it("categorizes kubectl and gcloud availability checks as release evidence categories", () => {
    expect(categoryForCheck({ id: "kubectl_available", detail: {} })).toBe("kubernetes_context");
    expect(categoryForCheck({ id: "gcloud_available", detail: {} })).toBe("inventory_access");
    expect(categoryForCheck({ id: "externalsecret_binding:synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url", detail: {} })).toBe("secret_inventory");
  });

  it("exits nonzero for strict warning blockers and zero for advisory warning-only reports", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dojo-gcp-blockers-test-"));
    const inventoryPath = path.join(tmpRoot, "inventory.json");
    writeFileSync(inventoryPath, `${JSON.stringify(inventoryReportWithChecks([
      warningCheck("k8s_secret:synthi-secrets", {
        expectedName: "synthi-secrets",
        reason: "k8s_secret_names_command_failed",
      }),
    ]), null, 2)}\n`, "utf8");

    const script = path.resolve("scripts", "dojo-gcp-release-blockers.mjs");
    const strictOut = path.join(tmpRoot, "strict");
    const strict = spawnSync(process.execPath, [
      script,
      "--inventory-report", inventoryPath,
      "--out-dir", strictOut,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(strict.status).toBe(1);
    expect(readFileSync(path.join(strictOut, "dojo-gcp-release-blockers.json"), "utf8")).toContain("\"promoted_warning_blocker_count\": 1");

    const advisoryOut = path.join(tmpRoot, "advisory");
    const advisory = spawnSync(process.execPath, [
      script,
      "--advisory",
      "--inventory-report", inventoryPath,
      "--out-dir", advisoryOut,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(advisory.status).toBe(0);
    expect(readFileSync(path.join(advisoryOut, "dojo-gcp-release-blockers.json"), "utf8")).toContain("\"mode\": \"advisory\"");
  });

  it("keeps the advisory package script available for discovery-only reports", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts["proof:dojo:gcp-release-blockers"]).toBe("node scripts/dojo-gcp-release-blockers.mjs");
    expect(packageJson.scripts["proof:dojo:gcp-release-blockers:advisory"]).toBe("node scripts/dojo-gcp-release-blockers.mjs --advisory");
  });
});
