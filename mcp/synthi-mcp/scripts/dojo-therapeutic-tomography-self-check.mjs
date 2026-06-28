#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeScreenshotVisualEvidence,
  collectRouteLayoutMetrics,
  evaluateVisualProofCapture,
  sha256File,
} from "./lib/dojo-visual-proof-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const requireFromMcp = createRequire(path.join(MCP_ROOT, "package.json"));
const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-therapeutic-tomography"));
  const artifacts = await runDojoTherapeuticTomographySelfCheck({ outDir });
  console.log(`[ok] Dojo therapeutic tomography self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoTherapeuticTomographySelfCheck({
  outDir,
  now = new Date().toISOString(),
} = {}) {
  const startedAt = performance.now();
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-therapeutic-tomography"));
  await mkdir(outputDir, { recursive: true });
  const tomography = await importTomographyModule();
  const trace = tomography.buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
  const validation = validateTrace(trace);
  const tracePath = path.join(outputDir, "therapeutic-trace.json");
  const htmlPath = path.join(outputDir, "therapeutic-trace.html");
  const svgPath = path.join(outputDir, "therapeutic-trace.svg");
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(htmlPath, buildTraceHtml(trace, validation), "utf8");
  await writeFile(svgPath, buildTraceSvg(trace, validation), "utf8");
  const traceText = await readFile(tracePath, "utf8");
  const htmlText = await readFile(htmlPath, "utf8");
  const svgText = await readFile(svgPath, "utf8");
  const renderedVisuals = await renderVisualArtifacts({
    outputDir,
    htmlPath,
    svgPath,
    svgText,
    trace,
  });
  const durationMs = performance.now() - startedAt;
  const evidence = {
    schema_version: "synthi.dojo.therapeuticTomographyEvidence.v1",
    generated_at: now,
    ok: validation.ok,
    duration_ms: Number(durationMs.toFixed(3)),
    capabilities: {
      broad_overreach_blocked: validation.checks.broad_overreach_blocked,
      lower_risk_probes_completed: validation.checks.lower_risk_probes_completed,
      strict_proof_capsule_approved: validation.checks.strict_proof_capsule_approved,
      machine_claims_separated: validation.checks.machine_claims_separated,
      human_claims_separated: validation.checks.human_claims_separated,
      narrative_claims_context_only: validation.checks.narrative_claims_context_only,
      scoped_read_only_lineage_approved: validation.checks.scoped_read_only_lineage_approved,
      broad_access_avoided: validation.checks.broad_access_avoided,
      diagnosis_verified: validation.checks.diagnosis_verified,
      visual_artifacts_written: true,
      visual_artifacts_rendered: renderedVisuals.ok,
    },
    failed_checks: validation.failed_checks,
    trace_path: tracePath,
    trace_sha256: sha256(traceText),
    trace_bytes: Buffer.byteLength(traceText),
    html_visual_proof_path: htmlPath,
    html_visual_proof_sha256: sha256(htmlText),
    html_visual_proof_bytes: Buffer.byteLength(htmlText),
    svg_visual_proof_path: svgPath,
    svg_visual_proof_sha256: sha256(svgText),
    svg_visual_proof_bytes: Buffer.byteLength(svgText),
    rendered_visuals: renderedVisuals,
    proof_capsule_id: trace.proof_capsules[0]?.id ?? null,
    avoided_access: trace.avoided_access,
  };
  const evidencePath = path.join(outputDir, "therapeutic-tomography.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  assert.equal(evidence.ok, true, `therapeutic tomography self-check failed: ${evidence.failed_checks.join(",")}`);
  assert.equal(renderedVisuals.ok, true, `therapeutic tomography visual proof failed: ${renderedVisuals.failed_visual_gates.join(",")}`);
  return {
    evidence_path: evidencePath,
    trace_path: tracePath,
    html_visual_proof_path: htmlPath,
    svg_visual_proof_path: svgPath,
    rendered_visuals: renderedVisuals,
    evidence,
  };
}

async function renderVisualArtifacts({
  outputDir,
  htmlPath,
  svgPath,
  svgText,
  trace,
}) {
  const sharp = requireFromMcp("sharp");
  const { chromium } = requireFromMcp("playwright-core");
  const requiredText = requiredTraceVisualText(trace);
  const requiredSvgText = requiredTraceSvgText(trace);
  const svgPngPath = path.join(outputDir, "therapeutic-trace-svg-render.png");
  await sharp(svgPath).png().toFile(svgPngPath);
  const svgPngStats = await stat(svgPngPath);
  const svgImageMetrics = await analyzeScreenshotVisualEvidence({ sharp, screenshotPath: svgPngPath });
  const svgChecks = Object.fromEntries(requiredSvgText
    .map((text) => [`svg_source_text:${text}`, svgText.includes(text)]));

  const htmlPngPath = path.join(outputDir, "therapeutic-trace-html-render.png");
  const browser = await chromium.launch({ headless: true });
  let htmlText = "";
  let layoutMetrics;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 920 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=\"therapeutic-tomography-static-proof\"]", { timeout: 10_000 });
    htmlText = await page.locator("[data-testid=\"therapeutic-tomography-static-proof\"]").innerText();
    layoutMetrics = await collectRouteLayoutMetrics(page, "[data-testid=\"therapeutic-tomography-static-proof\"]");
    await page.screenshot({ path: htmlPngPath, fullPage: true });
    await page.close();
  } finally {
    await browser.close();
  }
  const htmlPngStats = await stat(htmlPngPath);
  const htmlImageMetrics = await analyzeScreenshotVisualEvidence({ sharp, screenshotPath: htmlPngPath });
  const htmlChecks = Object.fromEntries(requiredText.map((text) => [`html_text:${text}`, htmlText.includes(text)]));
  const htmlDecision = evaluateVisualProofCapture({
    checks: htmlChecks,
    screenshotBytes: htmlPngStats.size,
    imageMetrics: htmlImageMetrics,
    layoutMetrics,
    viewport: { width: 1280, height: 920 },
  });
  const svgDecision = evaluateVisualProofCapture({
    checks: svgChecks,
    screenshotBytes: svgPngStats.size,
    imageMetrics: svgImageMetrics,
    layoutMetrics: {
      selector_found: true,
      selector_visible: true,
      horizontal_overflow_px: 0,
      selector_visible_area_px: svgImageMetrics.width * svgImageMetrics.height,
    },
    viewport: { width: svgImageMetrics.width, height: svgImageMetrics.height },
    thresholds: {
      min_screenshot_bytes: 5_000,
      min_unique_color_sample_count: 4,
      min_luma_stddev: 1,
      min_background_diff_pixel_ratio: 0.005,
      max_horizontal_overflow_px: 4,
      min_selector_visible_area_px: 900,
    },
  });
  return {
    ok: htmlDecision.ok && svgDecision.ok,
    failed_visual_gates: [
      ...htmlDecision.failed_visual_gates.map((gate) => `html:${gate}`),
      ...svgDecision.failed_visual_gates.map((gate) => `svg:${gate}`),
    ],
    html_render: {
      path: htmlPngPath,
      sha256: await sha256File(htmlPngPath),
      bytes: htmlPngStats.size,
      image_metrics: htmlImageMetrics,
      layout_metrics: layoutMetrics,
      checks: htmlChecks,
      failed_visual_gates: htmlDecision.failed_visual_gates,
    },
    svg_render: {
      path: svgPngPath,
      sha256: await sha256File(svgPngPath),
      bytes: svgPngStats.size,
      image_metrics: svgImageMetrics,
      checks: svgChecks,
      failed_visual_gates: svgDecision.failed_visual_gates,
    },
  };
}

function requiredTraceVisualText(trace) {
  const proof = trace.proof_capsules[0];
  return [
    "Agent Therapeutic Tomography",
    "Current authority dose",
    trace.blocked_overreach_attempts[0]?.requested_access.data_classes.join(", ") || "",
    trace.projection_probes[0]?.name || "",
    trace.projection_probes[1]?.name || "",
    proof?.id || "",
    trace.authority_doses[0]?.scope || "",
    trace.avoided_access[0] || "",
    trace.avoided_access[trace.avoided_access.length - 1] || "",
    trace.diagnosis,
  ].filter(Boolean);
}

function requiredTraceSvgText(trace) {
  return [
    "Agent Therapeutic Tomography",
    "raw_prod_logs",
    "eval_slice_compare",
    "feature_drift_summary",
    "machine claims pass",
    trace.authority_doses[0]?.scope || "",
    "train/serve skew",
    trace.avoided_access[0] || "",
    trace.avoided_access[trace.avoided_access.length - 1] || "",
  ].filter(Boolean);
}

async function importTomographyModule() {
  const distPath = path.join(MCP_ROOT, "dist", "dojo", "tomography", "index.js");
  if (!existsSync(distPath)) {
    throw new Error(`tomography_dist_missing:${distPath}:run_npm_prefix_mcp_synthi_mcp_run_build_first`);
  }
  return import(pathToFileURL(distPath).href);
}

function validateTrace(trace) {
  const firstBlock = trace.blocked_overreach_attempts?.[0];
  const proof = trace.proof_capsules?.[0];
  const dose = trace.authority_doses?.[0];
  const checks = {
    schema_version: trace.schema_version === "synthi.dojo.therapeuticTrace.v1",
    broad_overreach_blocked: firstBlock?.decision === "denied"
      && firstBlock.reason.includes("forbidden_data_requested")
      && firstBlock.reason.includes("lower_risk_probe_available"),
    lower_risk_probes_completed: ["eval_slice_compare", "feature_drift_summary"]
      .every((name) => trace.projection_probes.some((probe) => probe.name === name && probe.status === "completed" && probe.allowed_output_shape_valid)),
    strict_proof_capsule_approved: proof?.approved === true && proof.failed_claims.length === 0,
    machine_claims_separated: proof?.machine_verifiable_claims.length >= 8
      && proof.machine_verifiable_claims.every((claim) => claim.result === "pass"),
    human_claims_separated: proof?.human_reviewed_claims.some((claim) => claim.status === "approved") === true,
    narrative_claims_context_only: proof?.unverifiable_narrative_claims.every((claim) => claim.status === "context_only") === true,
    scoped_read_only_lineage_approved: dose?.scope === "feature:customer_plan"
      && dose.level === 5
      && dose.mutation_allowed === false
      && dose.decision === "approved",
    broad_access_avoided: ["raw_prod_logs", "full_database", "model_weights", "admin_privileges", "write_access"]
      .every((item) => trace.avoided_access.includes(item)),
    diagnosis_verified: trace.final_outcome === "diagnosed"
      && String(trace.diagnosis).includes("train_serve_skew")
      && String(trace.diagnosis).includes("customer_plan"),
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: failedChecks.length === 0,
    checks,
    failed_checks: failedChecks,
  };
}

function buildTraceHtml(trace, validation) {
  const proof = trace.proof_capsules[0];
  const rows = [
    ["Current authority dose", String(trace.current_authority_dose)],
    ["Current uncertainty", trace.uncertainties[0]?.description || ""],
    ["Blocked request", trace.blocked_overreach_attempts[0]?.requested_access.data_classes.join(", ") || ""],
    ["Selected probes", trace.projection_probes.map((probe) => probe.name).join(" -> ")],
    ["Proof capsule", proof?.id || ""],
    ["Machine claims", String(proof?.machine_verifiable_claims.length || 0)],
    ["Human claims", String(proof?.human_reviewed_claims.length || 0)],
    ["Narrative claims", String(proof?.unverifiable_narrative_claims.length || 0)],
    ["Avoided access", trace.avoided_access.join(", ")],
    ["Diagnosis", trace.diagnosis],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Therapeutic Tomography Trace</title>
  <style>
    body { margin: 0; font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #111413; color: #eef5ef; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    h1 { margin: 0 0 6px; font-size: 30px; letter-spacing: 0; }
    .status { display: inline-flex; margin: 10px 0 24px; border: 1px solid #3b6d55; border-radius: 6px; padding: 6px 10px; color: #9be7ba; background: #183026; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
    .card { border: 1px solid #33423b; border-radius: 8px; padding: 14px; background: #171d1a; min-height: 92px; }
    .card strong { display: block; font-size: 12px; color: #9eadad; margin-bottom: 8px; }
    .card span { display: block; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; background: #151a18; border: 1px solid #33423b; }
    th, td { text-align: left; border-bottom: 1px solid #29342f; padding: 10px 12px; vertical-align: top; }
    th { color: #9eadad; font-weight: 600; width: 230px; }
    .rail { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 8px; margin-top: 18px; }
    .rail div { border: 1px solid #3d5247; border-radius: 6px; padding: 10px; color: #f0c98b; background: #251f15; }
  </style>
</head>
<body>
  <main data-testid="therapeutic-tomography-static-proof">
    <h1>Agent Therapeutic Tomography</h1>
    <p>Proof-gated trace for ${escapeHtml(trace.user_goal)}</p>
    <div class="status">${validation.ok ? "All deterministic gates passed" : `Failed: ${escapeHtml(validation.failed_checks.join(", "))}`}</div>
    <section class="grid">
      <article class="card"><strong>Blocked overreach</strong><span>${escapeHtml(trace.blocked_overreach_attempts[0]?.requested_access.data_classes.join(", ") || "")}</span></article>
      <article class="card"><strong>Lower-risk path</strong><span>${escapeHtml(trace.projection_probes.map((probe) => probe.name).join(" -> "))}</span></article>
      <article class="card"><strong>Approved dose</strong><span>${escapeHtml(trace.authority_doses[0]?.scope || "")}</span></article>
      <article class="card"><strong>Strict proof</strong><span>${escapeHtml(proof?.approved ? "approved" : "blocked")}</span></article>
    </section>
    <table>
      <tbody>
        ${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
      </tbody>
    </table>
    <section class="rail" aria-label="Avoided access">
      ${trace.avoided_access.map((item) => `<div>${escapeHtml(item)}</div>`).join("\n")}
    </section>
  </main>
</body>
</html>
`;
}

function buildTraceSvg(trace, validation) {
  const stages = [
    ["Blocked", "raw_prod_logs"],
    ["Probe", "eval_slice_compare"],
    ["Probe", "feature_drift_summary"],
    ["Proof", "machine claims pass"],
    ["Dose 5", "feature:customer_plan"],
    ["Diagnosis", "train/serve skew"],
  ];
  const width = 1120;
  const height = 360;
  const stepWidth = 170;
  const startX = 42;
  const y = 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Therapeutic tomography proof timeline">
  <rect width="${width}" height="${height}" fill="#111413"/>
  <text x="42" y="48" fill="#eef5ef" font-family="Inter, Segoe UI, sans-serif" font-size="28" font-weight="700">Agent Therapeutic Tomography</text>
  <text x="42" y="78" fill="${validation.ok ? "#9be7ba" : "#ff9b9b"}" font-family="Inter, Segoe UI, sans-serif" font-size="15">${validation.ok ? "All deterministic gates passed" : `Failed: ${escapeXml(validation.failed_checks.join(", "))}`}</text>
  ${stages.map(([label, value], index) => {
    const x = startX + index * stepWidth;
    const line = index < stages.length - 1 ? `<line x1="${x + 136}" y1="${y + 44}" x2="${x + stepWidth - 14}" y2="${y + 44}" stroke="#52645c" stroke-width="2"/>` : "";
    return `${line}
  <rect x="${x}" y="${y}" width="136" height="88" rx="7" fill="${index === 0 ? "#2b1e1e" : "#17211c"}" stroke="${index === 0 ? "#b96b6b" : "#3d6d55"}"/>
  <text x="${x + 12}" y="${y + 32}" fill="${index === 0 ? "#ffc2c2" : "#9be7ba"}" font-family="Inter, Segoe UI, sans-serif" font-size="14" font-weight="700">${escapeXml(label)}</text>
  <text x="${x + 12}" y="${y + 58}" fill="#eef5ef" font-family="Inter, Segoe UI, sans-serif" font-size="12">${escapeXml(value)}</text>`;
  }).join("\n")}
  <text x="42" y="286" fill="#f0c98b" font-family="Inter, Segoe UI, sans-serif" font-size="15">Avoided access: ${escapeXml(trace.avoided_access.join(" | "))}</text>
</svg>
`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value) {
  return escapeHtml(value).replace(/'/g, "&apos;");
}
