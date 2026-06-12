#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeScreenshotVisualEvidence,
  collectRouteLayoutMetrics,
  evaluateVisualProofCapture,
} from "../../../synthi/scripts/dojo-visual-proof-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");
const OUT_ROOT = path.join(MCP_ROOT, "tmp", "dojo-proof-self-check");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_ROOT = path.join(OUT_ROOT, RUN_ID);
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

if (isDirectRun()) {
  main().catch((error) => {
    log("fail", error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

function log(kind, message) {
  const tag = kind === "ok" ? "[ok]" : kind === "fail" ? "[fail]" : "[info]";
  console.log(`${tag} ${message}`);
}

function event(overrides) {
  return {
    event_id: "evt",
    trace_id: "dojo-proof-self-check",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab-dojo",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    ...overrides,
  };
}

function safeArtifactPath(root, artifactPath) {
  const normalized = path.posix.normalize(`/${String(artifactPath || "")}`).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`unsafe artifact path: ${artifactPath}`);
  }
  if (!normalized.startsWith(".synthi/dojo/")) {
    throw new Error(`artifact outside Dojo namespace: ${artifactPath}`);
  }
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`artifact path escaped output root: ${artifactPath}`);
  }
  return resolved;
}

function structured(response) {
  assert(response, "tool returned no response");
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent ?? response, null, 2));
  return response.structuredContent ?? {};
}

async function writeArtifacts(root, artifacts) {
  const written = [];
  for (const artifact of artifacts) {
    assert.equal(typeof artifact.path, "string", "artifact path must be a string");
    assert.equal(typeof artifact.content, "string", `artifact content must be a string for ${artifact.path}`);
    const target = safeArtifactPath(root, artifact.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content, "utf8");
    written.push(target);
  }
  return written;
}

function validateJsonArtifacts(artifacts) {
  const parsed = [];
  for (const artifact of artifacts) {
    if (artifact.content_type !== "application/json") continue;
    assert.doesNotThrow(() => JSON.parse(artifact.content), `invalid JSON artifact: ${artifact.path}`);
    parsed.push(artifact.path);
  }
  return parsed;
}

function runGeneratedPlaywrightSpec(specPath) {
  const cliPath = require.resolve("@playwright/test/cli");
  const configPath = path.join(RUN_ROOT, "playwright.generated.config.mjs");
  const config = [
    "export default {",
    `  testDir: ${JSON.stringify(path.dirname(specPath))},`,
    "  fullyParallel: false,",
    "  workers: 1,",
    "  reporter: 'line',",
    "};",
    "",
  ].join("\n");
  return writeFile(configPath, config, "utf8").then(() => {
    const result = spawnSync(
      process.execPath,
      [cliPath, "test", "--config", configPath, "--reporter=line", "--workers=1"],
      {
        cwd: MCP_ROOT,
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      }
    );
    if (result.status !== 0) {
      throw new Error([
        "generated Playwright proof harness failed",
        `exit=${result.status}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"));
    }
    return {
      command: `${process.execPath} ${cliPath} test --config ${configPath} --reporter=line --workers=1`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

export function buildDojoProofVisualHtml(input) {
  const skill = input?.skill ?? {};
  const publish = input?.publish ?? {};
  const proofCapsule = input?.proof_capsule ?? {};
  const checkride = input?.checkride ?? {};
  const vivariumRun = input?.vivarium_run ?? {};
  const windTunnel = input?.wind_tunnel ?? {};
  const sourcePlan = input?.source_plan ?? {};
  const licenseHealth = input?.license_health ?? {};
  const typedPatchPlan = sourcePlan?.source_affordance_pr_plan?.typed_patch_plan ?? {};
  const generatedPrMetadata = sourcePlan?.source_affordance_pr_plan?.generated_pr_metadata ?? {};
  const title = skill.title || skill.label || publish.skill?.title || publish.skill?.label || skill.skill_id || "Dojo Skill";
  const summaryCards = [
    ["Skill", skill.skill_id],
    ["Workflow", skill.workflow_id],
    ["Tool", publish.private_tool?.tool_name],
    ["Proof", proofCapsule.capsule_id],
    ["License", skill.license?.license_id || publish.skill?.license?.license_id],
    ["Health", licenseHealth.license_health?.status],
    ["Entrustment", skill.license?.entrustment_level || publish.skill?.license?.entrustment_level],
    ["Readiness", skill.license?.readiness_level ?? publish.skill?.license?.readiness_level],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
  const scenarioRows = Array.isArray(checkride?.checkride?.results) ? checkride.checkride.results.slice(0, 8) : [];
  const patchOperations = Array.isArray(typedPatchPlan.operations) ? typedPatchPlan.operations : [];
  const reviewRequirements = Array.isArray(generatedPrMetadata.review_requirements) ? generatedPrMetadata.review_requirements : [];
  const caseLaw = Array.isArray(skill.case_law) ? skill.case_law : [];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} Dojo Proof</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111827;
      --muted: #53606f;
      --line: #c9d3df;
      --paper: #f7f8fb;
      --panel: #ffffff;
      --blue: #1556d8;
      --green: #146c43;
      --amber: #9a5b00;
      --red: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(21,86,216,.07) 0 1px, transparent 1px 100%),
        linear-gradient(0deg, rgba(20,108,67,.07) 0 1px, transparent 1px 100%),
        var(--paper);
      background-size: 32px 32px;
    }
    main {
      width: min(1180px, calc(100vw - 48px));
      margin: 0 auto;
      padding: 32px 0 40px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      border-bottom: 3px solid var(--ink);
      padding-bottom: 20px;
    }
    h1 {
      margin: 0;
      font-size: clamp(32px, 5vw, 68px);
      line-height: .95;
      letter-spacing: 0;
    }
    .eyebrow {
      margin: 0 0 10px;
      color: var(--blue);
      font-weight: 800;
      text-transform: uppercase;
      font-size: 12px;
    }
    .status {
      border: 2px solid var(--ink);
      padding: 12px 14px;
      min-width: 180px;
      background: var(--panel);
    }
    .status strong { display: block; font-size: 26px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 14px;
      min-height: 86px;
    }
    .card span, th { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 800; }
    .card strong { display: block; margin-top: 8px; font-size: 15px; overflow-wrap: anywhere; }
    section {
      margin-top: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 18px;
    }
    h2 { margin: 0 0 12px; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; border-top: 1px solid var(--line); padding: 9px 8px; vertical-align: top; }
    .pill {
      display: inline-block;
      border: 1px solid currentColor;
      padding: 3px 7px;
      margin: 2px 4px 2px 0;
      font-size: 12px;
      font-weight: 800;
    }
    .green { color: var(--green); }
    .blue { color: var(--blue); }
    .amber { color: var(--amber); }
    .red { color: var(--red); }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
      gap: 18px;
      align-items: start;
    }
    @media (max-width: 760px) {
      main { width: min(100vw - 24px, 720px); padding-top: 20px; }
      header, .split { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <main data-testid="dojo-proof-visual">
    <header>
      <div>
        <p class="eyebrow">Agent Dojo Playwright Visual Evidence</p>
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="status">
        <span>License Health</span>
        <strong>${escapeHtml(licenseHealth.license_health?.status || "unknown")}</strong>
        <span class="pill blue">${escapeHtml(skill.license?.entrustment_level || publish.skill?.license?.entrustment_level || "entrustment")}</span>
      </div>
    </header>

    <div class="grid">
      ${summaryCards.map(([label, value]) => `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("\n      ")}
    </div>

    <div class="split">
      <section>
        <h2>Runtime Proof Path</h2>
        <table>
          <tbody>
            <tr><th>Vivarium Run</th><td>${escapeHtml(vivariumRun?.vivarium_run?.run?.run_id || "not recorded")}</td></tr>
            <tr><th>Wind Tunnel</th><td>${escapeHtml(windTunnel?.wind_tunnel_execution?.run_count ?? "not recorded")} scenarios executed</td></tr>
            <tr><th>Proof Capsule</th><td>${escapeHtml(proofCapsule.capsule_id || "not recorded")}</td></tr>
            <tr><th>Generated Tool</th><td>${escapeHtml(publish.private_tool?.tool_name || "not published")}</td></tr>
          </tbody>
        </table>
      </section>
      <section>
        <h2>Source Patch Review</h2>
        <p>${patchOperations.map((operation) => `<span class="pill amber">${escapeHtml(operation.operation_id)}</span>`).join("") || "<span class=\"pill red\">no operations</span>"}</p>
        <p>${reviewRequirements.map((requirement) => `<span class="pill blue">${escapeHtml(requirement.gate)}</span>`).join("") || "<span class=\"pill red\">no review gates</span>"}</p>
      </section>
    </div>

    <section>
      <h2>Checkride Scenario Evidence</h2>
      <table>
        <thead><tr><th>Scenario</th><th>Status</th><th>Risk</th><th>Evidence</th></tr></thead>
        <tbody>
          ${scenarioRows.map((row) => `<tr><td>${escapeHtml(row.scenario_id || row.id)}</td><td><span class="pill ${row.passed ? "green" : "red"}">${escapeHtml(row.passed ? "passed" : "blocked")}</span></td><td>${escapeHtml(row.risk || row.category || "runtime")}</td><td>${escapeHtml(row.evidence_ref || row.evidence || "checkride evidence")}</td></tr>`).join("\n          ")}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Case Law And Guardrails</h2>
      <p>${caseLaw.slice(0, 6).map((item) => `<span class="pill green">${escapeHtml(item.case_id || item.id || item.title || item.rule || "case")}</span>`).join("") || "<span class=\"pill amber\">case law generated from checkride</span>"}</p>
    </section>
  </main>
</body>
</html>`;
}

async function runDojoProofVisualEvidence(input) {
  const outputDir = path.join(RUN_ROOT, "visual-proof");
  await mkdir(outputDir, { recursive: true });
  const html = buildDojoProofVisualHtml(input);
  const pagePath = path.join(outputDir, "dojo-proof-visual.html");
  const screenshotPath = path.join(outputDir, "dojo-proof-visual.png");
  await writeFile(pagePath, html, "utf8");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
    try {
      await page.goto(`file://${pagePath.replace(/\\/g, "/")}`, { waitUntil: "load" });
      await page.waitForSelector("[data-testid=\"dojo-proof-visual\"]", { timeout: 10_000 });
      const text = await page.locator("[data-testid=\"dojo-proof-visual\"]").innerText();
      const layoutMetrics = await collectRouteLayoutMetrics(page, "[data-testid=\"dojo-proof-visual\"]");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const screenshotStats = await stat(screenshotPath);
      const imageMetrics = await analyzeScreenshotVisualEvidence({ sharp, screenshotPath });
      const checks = {
        has_skill_id: textIncludesRequired(text, input.skill?.skill_id),
        has_tool_name: textIncludesRequired(text, input.publish?.private_tool?.tool_name),
        has_license_status: textIncludesRequired(text, input.license_health?.license_health?.status),
        has_proof_capsule: textIncludesRequired(text, input.proof_capsule?.capsule_id),
      };
      const decision = evaluateVisualProofCapture({
        checks,
        screenshotBytes: screenshotStats.size,
        imageMetrics,
        layoutMetrics,
        viewport: { name: "desktop", width: 1360, height: 1000 },
      });
      const visualProof = {
        schema_version: "synthi.dojo.proofSelfCheckVisualEvidence.v1",
        ok: decision.ok,
        page_path: pagePath,
        screenshot_path: screenshotPath,
        screenshot_bytes: screenshotStats.size,
        checks,
        failed_visual_gates: decision.failed_visual_gates,
        visual_thresholds: decision.thresholds,
        image_metrics: imageMetrics,
        layout_metrics: layoutMetrics,
      };
      await writeFile(path.join(outputDir, "dojo-proof-visual.evidence.json"), `${JSON.stringify(visualProof, null, 2)}\n`, "utf8");
      assert.equal(visualProof.ok, true, `Dojo proof visual evidence should pass: ${visualProof.failed_visual_gates.join(",")}`);
      return visualProof;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

function textIncludesRequired(text, value) {
  return typeof value === "string" && value.trim().length > 0 && text.includes(value);
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    throw new Error("dist/index.js is missing; run `npm run build` in mcp/synthi-mcp before this proof self-check");
  }

  const [
    { browserBroker },
    { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry },
    { sourceIdentityRegistry },
    { dojoSkillRegistry, validateDojoProofCapsule },
    { InMemoryDojoSkillStore },
    { dispatchBrowserTool },
    { dispatchDojoTool },
  ] = await Promise.all([
    import("../dist/browser/broker.js"),
    import("../dist/browser/private_tool_registry.js"),
    import("../dist/browser/source_identity.js"),
    import("../dist/browser/dojo.js"),
    import("../dist/browser/dojo_store.js"),
    import("../dist/tools/browser.js"),
    import("../dist/tools/dojo.js"),
  ]);

  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();

  await rm(RUN_ROOT, { recursive: true, force: true });
  await mkdir(RUN_ROOT, { recursive: true });

  const workspaceId = "dojo-proof-self-check";
  const url = "https://app.example.test/settings";
  sourceIdentityRegistry.register({
    workspaceId,
    filePath: "src/settings/DetailsButton.tsx",
    adapter: "dojo-proof-self-check",
    transformVersion: "dojo_proof_self_check_v1",
    tokens: [{ token: "details.open", file: "src/settings/DetailsButton.tsx", tag: "button", line: 12, column: 5 }],
  });

  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-dojo", url, active: true }]);
  browserBroker.selectTab("tab-dojo");
  assert.equal(browserBroker.startTeachMode("tab-dojo").ok, true, "teach mode should start");
  browserBroker.recordHumanAction(event({
    event_id: "open-details",
    event_seq: 1,
    action: "click",
    element: { role: "button", name: "Open details", text: "Open details", source_id: "details.open" },
  }));

  const scenarios = structured(await dispatchDojoTool("synthi_dojo_generate_vivarium_scenarios", { workspace_id: workspaceId }));
  assert.equal(scenarios.organoid.scenarios.length, 20, "vivarium should generate the standard scenario set");
  log("ok", "generated vivarium scenarios");

  const checkride = structured(await dispatchDojoTool("synthi_dojo_run_checkride", { workspace_id: workspaceId }));
  assert.equal(checkride.checkride.results.length, 20, "checkride should evaluate all scenarios");
  assert(checkride.repo_artifacts.length > 20, "checkride preview should expose Dojo artifacts");
  log("ok", "ran Dojo checkride");

  const publish = structured(await dispatchDojoTool("synthi_dojo_publish_skill", { workspace_id: workspaceId }));
  assert.equal(publish.skill.skill_id, "dojo_open_details", "published skill id should derive from workflow intent");
  assert.equal(
    publish.private_tool.ok,
    true,
    `backing private workflow tool should publish: ${JSON.stringify(publish.private_tool, null, 2)}`
  );
  assert.equal(publish.private_tool.tool_name, "synthi_app_open_details", "published backing tool name should be stable");
  log("ok", "published licensed skill and backing tool");

  const direct = await dispatchBrowserTool(publish.private_tool.tool_name, {});
  assert.equal(direct?.isError, true, "raw private workflow tool call should be rejected");
  assert.equal(direct?.structuredContent?.error, "dojo_proof_capsule_required", "raw tool should require Dojo proof");
  log("ok", "verified direct backing tool execution is proof-gated");

  const capsuleResponse = structured(await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
    skill_id: publish.skill.skill_id,
    requested_action: "run_workflow",
    context_claims: { workspace_verified: true },
  }));
  assert.equal(capsuleResponse.validation.ok, true, "issued proof capsule should validate");
  const skill = dojoSkillRegistry.get(publish.skill.skill_id);
  assert(skill, "published skill should be registered");
  const validation = validateDojoProofCapsule(skill, capsuleResponse.proof_capsule, "run_workflow");
  assert.equal(validation.ok, true, "proof capsule should validate through core validator");
  const kernelValidation = structured(await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
    skill_id: publish.skill.skill_id,
    requested_action: "run_workflow",
    proof_capsule: capsuleResponse.proof_capsule,
  }));
  assert.equal(kernelValidation.license_kernel.ok, true, "proof capsule should validate through license kernel");
  await writeFile(path.join(RUN_ROOT, "proof-capsule.json"), `${JSON.stringify(capsuleResponse.proof_capsule, null, 2)}\n`, "utf8");
  log("ok", "issued and validated proof capsule");

  const dryRun = structured(await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
    skill_id: publish.skill.skill_id,
    requested_action: "run_workflow",
    proof_capsule: capsuleResponse.proof_capsule,
    dry_run: true,
  }));
  assert.equal(dryRun.dry_run, true, "proof-gated dry run should not mutate");
  assert.equal(dryRun.validation.ok, true, "dry run should pass proof validation");
  log("ok", "ran proof-gated dry run");

  const vivariumRun = structured(await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
    skill_id: publish.skill.skill_id,
  }));
  assert.equal(vivariumRun.vivarium_run.schema_version, "synthi.dojo.vivariumScenarioRun.v1", "vivarium run schema should match");
  assert.equal(vivariumRun.vivarium_run.materialized_fixture.synthetic_data_only, true, "vivarium fixture must stay synthetic");
  log("ok", "ran executable vivarium scenario");

  const windTunnel = structured(await dispatchDojoTool("synthi_dojo_run_wind_tunnel", {
    skill_id: publish.skill.skill_id,
    max_scenarios: 5,
  }));
  assert.equal(windTunnel.wind_tunnel_execution.run_count, 5, "wind tunnel should honor scenario budget");
  assert.equal(windTunnel.wind_tunnel_execution.schema_version, "synthi.dojo.windTunnelExecution.v1", "wind tunnel schema should match");
  log("ok", "ran Workflow Wind Tunnel");

  const universe = structured(await dispatchDojoTool("synthi_dojo_get_universe_dossier", { skill_id: publish.skill.skill_id }));
  assert.equal(universe.universe_dossier.schema_version, "synthi.dojo.universeDossier.v1", "universe dossier schema should match");
  const sourcePlan = structured(await dispatchDojoTool("synthi_dojo_get_source_affordance_pr_plan", { skill_id: publish.skill.skill_id }));
  assert(sourcePlan.source_affordance_pr_plan.patch_count >= 1, "source affordance plan should include reviewable patches");
  const typedPatchPlan = sourcePlan.source_affordance_pr_plan.typed_patch_plan;
  assert.equal(typedPatchPlan.schema_version, "synthi.dojo.affordancePrPlan.v1", "source affordance plan should include a typed patch plan");
  assert(typedPatchPlan.operations.length >= sourcePlan.source_affordance_pr_plan.patch_count, "typed patch plan should cover each legacy source-affordance patch");
  assert(typedPatchPlan.operations.every((operation) => operation.target_match?.role), "typed patch operations should include target match criteria");
  assert(
    typedPatchPlan.required_tests.includes("npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check"),
    "typed patch plan should require the affordance codemod proof self-check"
  );
  const generatedPrMetadata = sourcePlan.source_affordance_pr_plan.generated_pr_metadata;
  assert.equal(
    generatedPrMetadata.schema_version,
    "synthi.dojo.generatedSourcePrMetadata.v1",
    "source affordance plan should include generated PR metadata"
  );
  assert(
    /^dojo\/source-affordance\/[a-z0-9._/-]+-[a-f0-9]{12}$/.test(generatedPrMetadata.branch_name),
    "generated PR metadata should include a safe generated branch name"
  );
  assert(
    generatedPrMetadata.review_requirements.some((requirement) => requirement.gate === "code_owner"),
    "generated PR metadata should represent the code-owner review gate"
  );
  assert(
    generatedPrMetadata.review_requirements.some((requirement) => requirement.gate === "security_for_risky_action"),
    "generated PR metadata should represent the security review gate"
  );
  assert(
    generatedPrMetadata.artifact_refs.some((artifact) => artifact.kind === "patch_plan"),
    "generated PR metadata should reference the patch plan artifact"
  );
  assert(
    generatedPrMetadata.artifact_refs.some((artifact) => artifact.kind === "contract_test"),
    "generated PR metadata should reference the generated contract or proof test artifact"
  );
  assert(
    generatedPrMetadata.promotion_blockers.every((blocker) => typeof blocker === "string" && blocker.length > 0),
    "generated PR metadata promotion blockers should be explicit strings"
  );
  const licenseHealth = structured(await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: publish.skill.skill_id }));
  assert.equal(licenseHealth.license_health.schema_version, "synthi.dojo.licenseHealth.v1", "license health schema should match");
  log("ok", "queried universe, source affordance, and license health reports");

  const exported = structured(await dispatchDojoTool("synthi_dojo_export_artifacts", { skill_id: publish.skill.skill_id }));
  assert(exported.artifact_count > 35, "Dojo export should include the full Vivarium Cortex artifact set");
  const written = await writeArtifacts(RUN_ROOT, exported.artifacts);
  const parsedJson = validateJsonArtifacts(exported.artifacts);
  const generatedSpec = written.find((file) => file.endsWith(path.normalize(".synthi/dojo/skills/open_details/playwright.spec.ts")));
  assert(generatedSpec, "export should include generated Playwright proof harness");
  log("ok", `exported ${exported.artifact_count} Dojo artifacts and parsed ${parsedJson.length} JSON artifacts`);

  const executableSpec = path.join(RUN_ROOT, "generated-playwright", path.basename(generatedSpec));
  await mkdir(path.dirname(executableSpec), { recursive: true });
  await copyFile(generatedSpec, executableSpec);
  const playwright = await runGeneratedPlaywrightSpec(executableSpec);
  log("ok", "executed generated Playwright proof harness");

  const visualProof = await runDojoProofVisualEvidence({
    skill: publish.skill,
    publish,
    proof_capsule: capsuleResponse.proof_capsule,
    checkride,
    vivarium_run: vivariumRun,
    wind_tunnel: windTunnel,
    source_plan: sourcePlan,
    license_health: licenseHealth,
  });
  log("ok", `captured Playwright visual proof screenshot - ${visualProof.screenshot_path}`);

  const summary = {
    ok: true,
    run_id: RUN_ID,
    output_dir: RUN_ROOT,
    skill_id: publish.skill.skill_id,
    published_tool_name: publish.private_tool.tool_name,
    artifact_count: exported.artifact_count,
    written_artifacts: written.map((file) => path.relative(RUN_ROOT, file).replace(/\\/g, "/")),
    parsed_json_artifacts: parsedJson,
    proof_capsule_id: capsuleResponse.proof_capsule.capsule_id,
    vivarium_run_id: vivariumRun.vivarium_run.run.run_id,
    wind_tunnel_run_count: windTunnel.wind_tunnel_execution.run_count,
    source_affordance_patch_count: sourcePlan.source_affordance_pr_plan.patch_count,
    source_affordance_typed_operation_count: typedPatchPlan.operations.length,
    source_affordance_typed_target_match_count: typedPatchPlan.operations.filter((operation) => operation.target_match?.role).length,
    source_affordance_generated_pr_review_gate_count: generatedPrMetadata.review_requirements.length,
    source_affordance_generated_pr_artifact_ref_count: generatedPrMetadata.artifact_refs.length,
    source_affordance_generated_pr_promotion_blocker_count: generatedPrMetadata.promotion_blockers.length,
    license_health_status: licenseHealth.license_health.status,
    generated_playwright_spec: path.relative(RUN_ROOT, generatedSpec).replace(/\\/g, "/"),
    executed_playwright_spec: path.relative(RUN_ROOT, executableSpec).replace(/\\/g, "/"),
    generated_playwright_command: playwright.command,
    visual_proof_ok: visualProof.ok,
    visual_proof_screenshot: path.relative(RUN_ROOT, visualProof.screenshot_path).replace(/\\/g, "/"),
    visual_proof_evidence: "visual-proof/dojo-proof-visual.evidence.json",
    visual_proof_failed_gates: visualProof.failed_visual_gates,
    visual_proof_pixel_metrics_verified: visualProof.image_metrics.pixel_metrics_verified,
    visual_proof_horizontal_overflow_px: visualProof.layout_metrics.horizontal_overflow_px,
  };
  await writeFile(path.join(RUN_ROOT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
}
