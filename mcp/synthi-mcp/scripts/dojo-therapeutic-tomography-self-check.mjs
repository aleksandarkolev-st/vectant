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
  const derivedProofControls = buildDerivedProofControls(tomography, trace);
  const validation = validateTrace(trace, derivedProofControls);
  const adversarialMatrix = validateAdversarialMatrix(tomography, trace);
  const tracePath = path.join(outputDir, "therapeutic-trace.json");
  const controlsPath = path.join(outputDir, "therapeutic-proof-controls.json");
  const htmlPath = path.join(outputDir, "therapeutic-trace.html");
  const svgPath = path.join(outputDir, "therapeutic-trace.svg");
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(controlsPath, `${JSON.stringify(derivedProofControls, null, 2)}\n`, "utf8");
  await writeFile(htmlPath, buildTraceHtml(trace, validation, derivedProofControls), "utf8");
  await writeFile(svgPath, buildTraceSvg(trace, validation, derivedProofControls), "utf8");
  const traceText = await readFile(tracePath, "utf8");
  const controlsText = await readFile(controlsPath, "utf8");
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
      adversarial_negative_controls_passed: adversarialMatrix.ok,
      probe_bundle_allowed: validation.checks.probe_bundle_allowed,
      cached_proof_reused: validation.checks.cached_proof_reused,
      proof_metrics_computed: validation.checks.proof_metrics_computed,
      under_escalation_detected: validation.checks.under_escalation_detected,
      remediation_gate_separated: validation.checks.remediation_gate_separated,
    },
    failed_checks: validation.failed_checks,
    adversarial_negative_controls: adversarialMatrix.cases,
    trace_path: tracePath,
    trace_sha256: sha256(traceText),
    trace_bytes: Buffer.byteLength(traceText),
    proof_controls_path: controlsPath,
    proof_controls_sha256: sha256(controlsText),
    proof_controls_bytes: Buffer.byteLength(controlsText),
    html_visual_proof_path: htmlPath,
    html_visual_proof_sha256: sha256(htmlText),
    html_visual_proof_bytes: Buffer.byteLength(htmlText),
    svg_visual_proof_path: svgPath,
    svg_visual_proof_sha256: sha256(svgText),
    svg_visual_proof_bytes: Buffer.byteLength(svgText),
    rendered_visuals: renderedVisuals,
    proof_capsule_id: trace.proof_capsules[0]?.id ?? null,
    avoided_access: trace.avoided_access,
    proof_controls_summary: {
      probe_bundle: derivedProofControls.probe_bundle.name,
      cache_template: derivedProofControls.proof_cache.template_id,
      metrics: derivedProofControls.proof_metrics,
      under_escalation_flags: derivedProofControls.under_escalation.flags,
      remediation_blocked_by: derivedProofControls.remediation_gate.blocked_by,
    },
  };
  const evidencePath = path.join(outputDir, "therapeutic-tomography.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  assert.equal(evidence.ok, true, `therapeutic tomography self-check failed: ${evidence.failed_checks.join(",")}`);
  assert.equal(renderedVisuals.ok, true, `therapeutic tomography visual proof failed: ${renderedVisuals.failed_visual_gates.join(",")}`);
  assert.equal(adversarialMatrix.ok, true, `therapeutic tomography negative controls failed: ${adversarialMatrix.failed_cases.join(",")}`);
  return {
    evidence_path: evidencePath,
    trace_path: tracePath,
    html_visual_proof_path: htmlPath,
    svg_visual_proof_path: svgPath,
    rendered_visuals: renderedVisuals,
    evidence,
  };
}

function buildDerivedProofControls(tomography, trace) {
  const proofCapsule = trace.proof_capsules[0];
  const lineageRequest = proofCapsule.requested_access;
  const probeBundle = tomography.buildSafeProbeBundle({
    name: "safe_quality_drop_probe_bundle",
    task_class: trace.task_class,
    current_authority_dose: 2,
    contracts: tomography.THERAPEUTIC_ML_QUALITY_DROP_PROBES,
  });
  const proofCache = tomography.evaluateProofCache({
    trace,
    request: lineageRequest,
    proof_capsule: proofCapsule,
  });
  const metrics = tomography.summarizeProofMetrics({
    decisions: [
      {
        decision: "denied",
        tier: 3,
        blocked_by: trace.blocked_overreach_attempts[0]?.reason || [],
        suggested_alternatives: trace.suggested_lower_risk_alternatives,
        verification_latency_ms: 7,
        human_reviewed: true,
        token_count: 0,
      },
      {
        decision: "approved",
        tier: 1,
        blocked_by: [],
        suggested_alternatives: [],
        verification_latency_ms: 18,
        cache_hit: proofCache.cache_hit,
        probe_bundle_success: probeBundle.decision === "allowed",
        token_count: 0,
      },
    ],
  });
  const underEscalationTrace = {
    ...trace,
    uncertainties: trace.uncertainties.map((uncertainty) => ({
      ...uncertainty,
      blocking_status: "blocked",
      severity: "high",
    })),
  };
  const underEscalation = tomography.evaluateUnderEscalation({
    trace: underEscalationTrace,
    available_requests: [lineageRequest],
  });
  const remediationGate = tomography.evaluateRemediationGate({
    trace,
    proposal: {
      id: "remediation_visual_negative_control",
      task_id: trace.task_id,
      diagnosis_verified: true,
      proposed_change: "Align the scoped serving transform after separate approval.",
      requested_access: {
        ...lineageRequest,
        id: "remediation_write_visual_negative_control",
        authority_dose: 7,
        mode: "write",
        data_classes: ["serving_config_patch"],
        tools: ["serving_config_patch"],
        purpose: "Apply the scoped serving transform remediation.",
      },
      blast_radius: "single feature transform",
      rollback_plan: "",
      postcondition_checks: [],
      human_approval: null,
    },
  });
  return {
    schema_version: "synthi.dojo.therapeuticProofControls.v1",
    probe_bundle: {
      name: probeBundle.name,
      decision: probeBundle.decision,
      probes: probeBundle.probes.map((probe) => probe.name),
      required_authority_dose: probeBundle.required_authority_dose,
      required_data_classes: probeBundle.required_data_classes,
      denied_by: probeBundle.denied_by,
    },
    proof_cache: proofCache,
    proof_metrics: metrics,
    under_escalation: {
      under_escalated: underEscalation.under_escalated,
      recommended_scope: underEscalation.recommended_request?.scope || null,
      flags: underEscalation.flags,
    },
    remediation_gate: remediationGate,
  };
}

function validateAdversarialMatrix(tomography, trace) {
  const baseRequest = trace.proof_capsules[0].requested_access;
  const cases = [];

  const narrativeOnlyCapsule = tomography.buildStrictProofCapsule({
    id: "proof_negative_narrative_only",
    task_id: trace.task_id,
    trace,
    request: baseRequest,
    current_authority_dose: 4,
    machine_verifiable_claims: [],
    unverifiable_narrative_claims: [{ claim: "Agent believes broader access will help.", status: "context_only" }],
  });
  cases.push({
    id: "narrative_only_proof_rejected",
    ok: narrativeOnlyCapsule.approved === false && narrativeOnlyCapsule.failed_claims.includes("narrative_only_proof"),
    expected_block: "narrative_only_proof",
    observed: narrativeOnlyCapsule.failed_claims,
  });

  const missingExpirationRequest = { ...baseRequest, id: "negative_missing_expiration", expiration: "" };
  const missingExpirationCapsule = tomography.buildStrictProofCapsule({
    id: "proof_negative_missing_expiration",
    task_id: trace.task_id,
    trace,
    request: missingExpirationRequest,
    current_authority_dose: 4,
  });
  cases.push({
    id: "missing_expiration_rejected",
    ok: missingExpirationCapsule.approved === false && missingExpirationCapsule.failed_claims.includes("expiration_defined"),
    expected_block: "expiration_defined",
    observed: missingExpirationCapsule.failed_claims,
  });

  const writeRequest = { ...baseRequest, id: "negative_write_diagnosis", mode: "write" };
  const writeCapsule = tomography.buildStrictProofCapsule({
    id: "proof_negative_write_diagnosis",
    task_id: trace.task_id,
    trace,
    request: writeRequest,
    current_authority_dose: 4,
    human_reviewed_claims: [{
      claim: "write_is_reasonable",
      reviewer_role: "incident_commander",
      status: "approved",
      rationale: "negative control still requires mutation separation.",
    }],
  });
  const writeDecision = tomography.evaluateAuthorityBroker({ trace, request: writeRequest, proof_capsule: writeCapsule });
  cases.push({
    id: "diagnosis_write_access_rejected",
    ok: writeCapsule.approved === false
      && writeCapsule.failed_claims.includes("request_is_read_only")
      && writeDecision.blocked_by.includes("mutation_not_allowed_by_policy"),
    expected_block: "mutation_not_allowed_by_policy",
    observed: [...writeCapsule.failed_claims, ...writeDecision.blocked_by],
  });

  const driftContract = tomography.THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary");
  const leakyProbe = tomography.buildProjectionProbe({
    id: "negative_leaky_probe",
    task_id: trace.task_id,
    contract: driftContract,
    target_uncertainty: "quality_drop_cause",
    result_summary: {
      top_feature: "customer_plan",
      drift_score: 0.91,
      affected_segment: "enterprise_users",
      confidence: 0.88,
      time_window: "last_24h",
      raw_training_rows: [{ customer_id: "blocked" }],
    },
    actual_information_gain: 8,
    confidence: 0.88,
  });
  cases.push({
    id: "leaky_probe_output_rejected",
    ok: leakyProbe.allowed_output_shape_valid === false,
    expected_block: "probe_output_shape_check",
    observed: { allowed_output_shape_valid: leakyProbe.allowed_output_shape_valid },
  });

  const tier2Request = {
    ...baseRequest,
    id: "negative_tier2_multi_feature",
    scope: "feature:customer_plan,feature:billing_country",
    data_classes: ["multi_feature_lineage"],
  };
  const tier2Route = tomography.classifyTherapeuticProofRoute({ request: tier2Request });
  cases.push({
    id: "multi_feature_lineage_routes_to_tier2",
    ok: tier2Route.tier === 2 && tier2Route.required_gates.includes("judgment_claim_review"),
    expected_block: "judgment_claim_review",
    observed: tier2Route,
  });

  return {
    ok: cases.every((item) => item.ok),
    failed_cases: cases.filter((item) => !item.ok).map((item) => item.id),
    cases,
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
    "safe_quality_drop_probe_bundle",
    "ml_quality_drop_feature_lineage_v1",
    "Under-escalation",
    "Remediation gate",
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
    "proof cache hit",
    "safe probe bundle",
    "remediation gated",
  ].filter(Boolean);
}

async function importTomographyModule() {
  const distPath = path.join(MCP_ROOT, "dist", "dojo", "tomography", "index.js");
  if (!existsSync(distPath)) {
    throw new Error(`tomography_dist_missing:${distPath}:run_npm_prefix_mcp_synthi_mcp_run_build_first`);
  }
  return import(pathToFileURL(distPath).href);
}

function validateTrace(trace, derivedProofControls) {
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
    probe_bundle_allowed: derivedProofControls.probe_bundle.decision === "allowed"
      && ["eval_slice_compare", "feature_drift_summary", "model_route_compare"]
        .every((name) => derivedProofControls.probe_bundle.probes.includes(name)),
    cached_proof_reused: derivedProofControls.proof_cache.cache_hit === true
      && derivedProofControls.proof_cache.template_id === "ml_quality_drop_feature_lineage_v1",
    proof_metrics_computed: derivedProofControls.proof_metrics.percent_decisions_deterministic > 0
      && derivedProofControls.proof_metrics.average_tokens_per_access_decision === 0,
    under_escalation_detected: derivedProofControls.under_escalation.under_escalated === true
      && derivedProofControls.under_escalation.recommended_scope === "feature:customer_plan",
    remediation_gate_separated: derivedProofControls.remediation_gate.decision === "denied"
      && derivedProofControls.remediation_gate.blocked_by.includes("rollback_plan_missing")
      && derivedProofControls.remediation_gate.blocked_by.includes("postcondition_checks_missing")
      && derivedProofControls.remediation_gate.blocked_by.includes("human_approval_required"),
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: failedChecks.length === 0,
    checks,
    failed_checks: failedChecks,
  };
}

function buildTraceHtml(trace, validation, derivedProofControls) {
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
    ["Safe probe bundle", `${derivedProofControls.probe_bundle.name}: ${derivedProofControls.probe_bundle.probes.join(" -> ")}`],
    ["Proof cache", `${derivedProofControls.proof_cache.cache_hit ? "hit" : "miss"}: ${derivedProofControls.proof_cache.template_id || "none"}`],
    ["Proof metrics", `deterministic ${derivedProofControls.proof_metrics.percent_decisions_deterministic}% | p95 ${derivedProofControls.proof_metrics.proof_verification_latency_p95}ms | tokens ${derivedProofControls.proof_metrics.average_tokens_per_access_decision}`],
    ["Under-escalation", `${derivedProofControls.under_escalation.under_escalated ? "detected" : "clear"}: ${derivedProofControls.under_escalation.flags.join(", ")}`],
    ["Remediation gate", `${derivedProofControls.remediation_gate.decision}: ${derivedProofControls.remediation_gate.blocked_by.join(", ")}`],
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
    .control { margin-top: 18px; border: 1px solid #3c5264; border-radius: 8px; padding: 14px; background: #141d24; }
    .control strong { display: block; color: #9cc9f0; margin-bottom: 6px; }
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
    <section class="control" aria-label="Proof latency controls">
      <strong>safe_quality_drop_probe_bundle</strong>
      <span>${escapeHtml(derivedProofControls.probe_bundle.probes.join(" -> "))}</span>
    </section>
    <section class="control" aria-label="Proof cache and remediation controls">
      <strong>ml_quality_drop_feature_lineage_v1</strong>
      <span>Under-escalation ${escapeHtml(derivedProofControls.under_escalation.under_escalated ? "detected" : "clear")} | Remediation gate ${escapeHtml(derivedProofControls.remediation_gate.decision)}</span>
    </section>
  </main>
</body>
</html>
`;
}

function buildTraceSvg(trace, validation, derivedProofControls) {
  const stages = [
    ["Blocked", "raw_prod_logs"],
    ["Probe", "eval_slice_compare"],
    ["Probe", "feature_drift_summary"],
    ["Proof", "machine claims pass"],
    ["Dose 5", "feature:customer_plan"],
    ["Diagnosis", "train/serve skew"],
  ];
  const width = 1120;
  const height = 420;
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
  <text x="42" y="322" fill="#9cc9f0" font-family="Inter, Segoe UI, sans-serif" font-size="15">safe probe bundle: ${escapeXml(derivedProofControls.probe_bundle.probes.join(" -> "))}</text>
  <text x="42" y="350" fill="#9be7ba" font-family="Inter, Segoe UI, sans-serif" font-size="15">proof cache hit: ${escapeXml(derivedProofControls.proof_cache.template_id || "none")}</text>
  <text x="42" y="378" fill="#ffc2c2" font-family="Inter, Segoe UI, sans-serif" font-size="15">remediation gated: ${escapeXml(derivedProofControls.remediation_gate.blocked_by.join(" | "))}</text>
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
