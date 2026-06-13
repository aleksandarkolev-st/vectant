// @ts-nocheck
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateEvidenceManifest,
  buildDojoReleaseGateManifest,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
} from "../../scripts/dojo-mcp-host-conformance.mjs";
import {
  validateDojoMcpHostConformanceReportForRelease,
  verifyDojoMcpHostConformanceArtifacts,
  verifyDojoReleaseGateManifestArtifacts,
  verifyVisualProofArtifact,
} from "../../scripts/dojo-release-gate-verify.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

describe("Dojo release gate artifact verifier", () => {
  it("verifies manifest evidence digests and rejects tampered manifest bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-release-gate-verify-"));
    const packageScripts = await readPackageScripts();
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const manifestPath = path.join(dir, "dojo-release-gate-manifest.json");
    const evidencePath = path.join(dir, "dojo-release-gate-manifest.evidence.json");
    await writeManifestPair({ manifest, manifestPath, evidencePath });

    expect(await verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
    }));

    const tampered = {
      ...manifest,
      gates: manifest.gates.filter((gate) => gate.id !== "dojo_mcp_host_conformance"),
    };
    await writeFile(manifestPath, JSON.stringify(tampered, null, 2), "utf8");
    const rejected = await verifyDojoReleaseGateManifestArtifacts({ manifestPath, evidencePath });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^manifest_sha256_mismatch:/),
      expect.stringMatching(/^manifest_invalid:unknown_release_gate_ids:dojo_mcp_host_conformance/),
    ]));
  });

  it("requires release-candidate MCP host conformance to be real production execution", () => {
    const valid = buildConformanceReport();
    expect(validateDojoMcpHostConformanceReportForRelease(valid)).toEqual({
      ok: true,
      errors: [],
    });

    const selfCheck = buildConformanceReport({
      schemaVersion: "synthi.dojo.mcpHostConformance.selfCheck.v1",
    });
    expect(validateDojoMcpHostConformanceReportForRelease(selfCheck).errors).toEqual(expect.arrayContaining([
      "conformance_schema_not_release:synthi.dojo.mcpHostConformance.selfCheck.v1",
      "conformance_self_check_schema_not_release_evidence",
    ]));

    const dryRun = buildConformanceReport({ executeProduction: false });
    expect(validateDojoMcpHostConformanceReportForRelease(dryRun).errors).toEqual(expect.arrayContaining([
      "conformance_execute_production_missing",
      "conformance_production_execution_step_missing",
    ]));
  });

  it("verifies MCP host conformance evidence hashes before release promotion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-mcp-conformance-verify-"));
    const report = buildConformanceReport();
    const reportPath = path.join(dir, "dojo-mcp-host-conformance.json");
    const evidencePath = path.join(dir, "dojo-mcp-host-conformance.evidence.json");
    await writeConformancePair({ report, reportPath, evidencePath });

    expect(await verifyDojoMcpHostConformanceArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      release_candidate: true,
    }));

    await writeFile(reportPath, JSON.stringify({ ...report, config: { ...report.config, execute_production: false } }, null, 2), "utf8");
    const rejected = await verifyDojoMcpHostConformanceArtifacts({
      reportPath,
      evidencePath,
      releaseCandidate: true,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^report_sha256_mismatch:/),
      "conformance_execute_production_missing",
    ]));
  });

  it("verifies visual reports against schema, pixel/layout metrics, and screenshot bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-visual-verify-"));
    const packageScripts = await readPackageScripts();
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts,
    });
    const screenshotPath = path.join(dir, "visual-proof.png");
    const imageBytes = Buffer.from("not-a-real-production-screenshot");
    await writeFile(screenshotPath, imageBytes);
    const reportPath = path.join(dir, "visual-proof.json");
    const report = buildVisualReport({ screenshotPath, bytes: imageBytes.length });
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    expect(await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: 1,
    }));

    await writeFile(reportPath, JSON.stringify(buildVisualReport({
      screenshotPath,
      bytes: imageBytes.length + 1,
    }), null, 2), "utf8");
    const rejected = await verifyVisualProofArtifact({
      manifest,
      gateId: "dojo_full_visual_proof",
      reportPath,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      "visual_result_screenshot_bytes_mismatch:visual-proof:33:32",
    ]));
  });
});

async function readPackageScripts() {
  const mcpPackage = JSON.parse(await readFile(path.join(MCP_ROOT, "package.json"), "utf8"));
  const frontendPackage = JSON.parse(await readFile(path.join(REPO_ROOT, "synthi", "package.json"), "utf8"));
  return {
    "mcp/synthi-mcp/package.json": mcpPackage.scripts || {},
    "synthi/package.json": frontendPackage.scripts || {},
  };
}

async function writeManifestPair({ manifest, manifestPath, evidencePath }) {
  const serialized = JSON.stringify(manifest, null, 2);
  const evidence = buildDojoReleaseGateEvidenceManifest({
    manifest,
    manifestPath,
    serialized,
  });
  await writeFile(manifestPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
}

async function writeConformancePair({ report, reportPath, evidencePath }) {
  const serialized = JSON.stringify(report, null, 2);
  const evidence = buildConformanceEvidenceManifest({
    report,
    reportPath,
    serialized,
  });
  await writeFile(reportPath, serialized, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
}

function buildConformanceReport({
  schemaVersion = "synthi.dojo.mcpHostConformance.v1",
  executeProduction = true,
} = {}) {
  const report = {
    schema_version: schemaVersion,
    generated_at: "2026-06-11T00:00:00.000Z",
    conformance: {
      ok: true,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: true,
      mcp_host_class: "remote",
    },
    config: {
      execute_production: executeProduction,
      raw_backing_tool_required: true,
    },
    steps: [
      { name: "initialize", ok: true },
      { name: "required Dojo tool surface advertised", ok: true },
      { name: "select published Dojo competency", ok: true },
      { name: "issue proof capsule", ok: true },
      { name: "validate proof capsule", ok: true },
      {
        name: executeProduction ? "execute proof-gated Dojo skill" : "dry-run proof-gated Dojo skill",
        ok: true,
        dry_run: !executeProduction,
      },
      { name: "raw backing tool blocked outside Dojo proof path", ok: true },
      { name: "revoke proof capsule", ok: true },
      { name: "revoked proof validation blocked", ok: true },
      { name: "revoked proof run blocked", ok: true },
    ],
  };
  report.release_gate = buildConformanceReleaseGateSummary(report);
  return report;
}

function buildVisualReport({ screenshotPath, bytes }) {
  return {
    schema_version: "synthi.dojo.visualProof.v1",
    ok: true,
    screenshots: [screenshotPath],
    results: [
      {
        route_id: "visual-proof",
        viewport: "desktop",
        ok: true,
        failed_visual_gates: [],
        screenshot_path: screenshotPath,
        bytes,
        image_metrics: {
          pixel_metrics_verified: true,
          unique_color_sample_count: 64,
          background_diff_pixel_ratio: 0.32,
          luma_stddev: 24,
        },
        layout_metrics: {
          horizontal_overflow_px: 0,
          selector_visible_area_px: 120000,
        },
      },
    ],
  };
}
