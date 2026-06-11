#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");
const OUT_ROOT = path.join(MCP_ROOT, "tmp", "dojo-proof-self-check");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_ROOT = path.join(OUT_ROOT, RUN_ID);
const require = createRequire(import.meta.url);

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
    license_health_status: licenseHealth.license_health.status,
    generated_playwright_spec: path.relative(RUN_ROOT, generatedSpec).replace(/\\/g, "/"),
    executed_playwright_spec: path.relative(RUN_ROOT, executableSpec).replace(/\\/g, "/"),
    generated_playwright_command: playwright.command,
  };
  await writeFile(path.join(RUN_ROOT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  log("fail", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
