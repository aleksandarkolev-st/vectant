// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateEvidenceManifest,
  buildDojoReleaseGateManifest,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  DOJO_RELEASE_GATE_IDS,
  DOJO_RELEASE_GATE_TIERS,
  validateDojoReleaseGateManifest,
  validateDojoVisualProofReport,
} from "../../scripts/dojo-release-gate-manifest.mjs";

const PACKAGE_SCRIPTS = {
  "mcp/synthi-mcp/package.json": {
    typecheck: "tsc --noEmit",
    build: "tsc",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "proof:dojo:self-check": "node scripts/dojo-proof-self-check.mjs",
    "proof:dojo:mcp-host-conformance:self-check": "node scripts/dojo-mcp-host-conformance.mjs --self-check",
    "proof:dojo:affordance-codemod:self-check": "node scripts/dojo-affordance-codemod-self-check.mjs",
    "proof:dojo:security-abuse:self-check": "node scripts/dojo-security-abuse-self-check.mjs",
    "proof:dojo:chaos-performance:self-check": "node scripts/dojo-chaos-performance-self-check.mjs",
    "live:browser:workflow-pipeline": "node scripts/workflow-pipeline-e2e.mjs",
    "live:browser:private-tool-stdio": "node scripts/private-tool-stdio-acceptance.mjs",
    "live:browser:private-tool-codex": "node scripts/private-tool-codex-acceptance.mjs",
    "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --require-non-loopback-mcp-host",
    "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command --require-non-loopback-runtime --require-external-private-tool-store",
    "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-non-loopback-runtime --require-external-private-tool-store",
    soak: "node tests/soak/soak_loop.mjs",
  },
  "synthi/package.json": {
    lint: "next lint",
    build: "next build",
    "proof:dojo:visual": "node scripts/dojo-visual-proof.mjs",
    "proof:dojo:ghost-mode-visual": "node scripts/dojo-ghost-mode-visual-proof.mjs",
    test: "vitest run",
  },
};

describe("Dojo release gate manifest", () => {
  it("defines the complete T0 through T8 tier matrix", () => {
    expect(DOJO_RELEASE_GATE_TIERS.map((tier) => tier.id)).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
    ]);
    expect(DOJO_RELEASE_GATE_TIERS.every((tier) => tier.name && tier.required_for && tier.purpose)).toBe(true);
  });

  it("builds a manifest with minimal, milestone, and release gate slices", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(manifest.schema_version).toBe("synthi.dojo.releaseGateManifest.v1");
    expect(manifest.minimal_pr_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(manifest.milestone_gate_ids).toEqual(DOJO_MILESTONE_GATE_IDS);
    expect(manifest.release_gate_ids).toEqual(DOJO_RELEASE_GATE_IDS);
    expect(manifest.policy.every_pr_requires).toEqual(["T0", "T1"]);
    expect(manifest.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_self_check", tier: "T2", script_exists: true }),
      expect.objectContaining({
        id: "dojo_affordance_codemod_self_check",
        tier: "T2",
        package_script: "proof:dojo:affordance-codemod:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
        evidence_schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
      }),
      expect.objectContaining({
        id: "dojo_full_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.visualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_ghost_mode_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:ghost-mode-visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.ghostModeVisualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
        }),
      }),
      expect.objectContaining({ id: "dojo_mcp_host_conformance", tier: "T6", script_exists: true }),
      expect.objectContaining({
        id: "security_abuse_suite",
        tier: "T7",
        package_script: "proof:dojo:security-abuse:self-check",
        script_exists: true,
      }),
      expect.objectContaining({
        id: "dojo_chaos_performance_self_check",
        tier: "T8",
        package_script: "proof:dojo:chaos-performance:self-check",
        script_exists: true,
      }),
      expect.objectContaining({ id: "soak_performance", tier: "T8", script_exists: true }),
    ]));
  });

  it("validates referenced package scripts and required release tiers", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(validateDojoReleaseGateManifest(manifest, { packageScripts: PACKAGE_SCRIPTS })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      tier_count: 9,
    }));

    const broken = buildDojoReleaseGateManifest({
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    });
    expect(validateDojoReleaseGateManifest(broken, {
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    }).errors).toEqual(expect.arrayContaining([
      "missing_package_script:mcp/synthi-mcp/package.json:typecheck",
      "missing_package_script:mcp/synthi-mcp/package.json:proof:dojo:self-check",
    ]));
  });

  it("keeps live, deployed, security, and soak gates out of the minimal PR gate", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));

    expect(new Set(manifest.minimal_pr_gate_ids.map((id) => gatesById.get(id)?.tier))).toEqual(new Set(["T0", "T1"]));
    expect(manifest.minimal_pr_gate_ids).not.toContain("dojo_mcp_host_conformance");
    expect(manifest.minimal_pr_gate_ids).not.toContain("soak_performance");
    expect(manifest.release_gate_ids).toEqual(expect.arrayContaining([
      "workflow_e2e_hosted",
      "dojo_mcp_host_conformance",
      "security_abuse_suite",
    ]));
  });

  it("builds digest evidence for the emitted manifest", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const serialized = JSON.stringify(manifest, null, 2);
    const evidence = buildDojoReleaseGateEvidenceManifest({
      manifest,
      manifestPath: "/tmp/dojo-release-gate-manifest.json",
      serialized,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.releaseGateEvidence.v1",
      manifest_path: "/tmp/dojo-release-gate-manifest.json",
      manifest_bytes: Buffer.byteLength(serialized),
      validation_ok: true,
      tier_count: 9,
      gate_count: manifest.gates.length,
      minimal_pr_gate_count: manifest.minimal_pr_gate_ids.length,
      milestone_gate_count: manifest.milestone_gate_ids.length,
      release_gate_count: manifest.release_gate_ids.length,
      visual_report_gate_count: 2,
      visual_report_gate_ids: ["dojo_full_visual_proof", "dojo_ghost_mode_visual_proof"],
    }));
    expect(evidence.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates visual proof reports against pixel and layout evidence requirements", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gate = manifest.gates.find((item) => item.id === "dojo_full_visual_proof");
    const validReport = {
      schema_version: "synthi.dojo.visualProof.v1",
      ok: true,
      results: [
        {
          route_id: "practice-world",
          viewport: "mobile",
          ok: true,
          failed_visual_gates: [],
          screenshot_path: "/tmp/practice-world-mobile.png",
          bytes: 120_000,
          image_metrics: {
            pixel_metrics_verified: true,
            unique_color_sample_count: 96,
            background_diff_pixel_ratio: 0.41,
            luma_stddev: 22,
          },
          layout_metrics: {
            horizontal_overflow_px: 0,
            selector_visible_area_px: 468_000,
          },
        },
      ],
    };

    expect(validateDojoVisualProofReport(validReport, { gate })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: 1,
    }));

    const rejectedReport = {
      ...validReport,
      ok: false,
      results: [
        {
          ...validReport.results[0],
          ok: false,
          failed_visual_gates: ["horizontal_overflow"],
          image_metrics: { pixel_metrics_verified: false },
          layout_metrics: { horizontal_overflow_px: 125 },
        },
      ],
    };

    expect(validateDojoVisualProofReport(rejectedReport, { gate }).errors).toEqual(expect.arrayContaining([
      "visual_report_not_ok",
      "visual_result_not_ok:practice-world",
      "visual_result_failed_gates:practice-world:horizontal_overflow",
      "visual_result_pixel_metrics_unverified:practice-world",
      "visual_result_horizontal_overflow:practice-world:125",
    ]));
  });
});
