#!/usr/bin/env node
/*
 * End-to-end browser workflow pipeline proof.
 *
 * This exercises the normal cloud-IDE product path:
 *   seeded workspace -> npm run dev in Docker -> /ports discovery ->
 *   Workflows panel buttons -> hosted browser teach capture ->
 *   compile/export/manifest/validate -> run exported Playwright.
 *
 * It intentionally does not assume a fixed application port. Each seeded app
 * listens on PORT=0 and the harness verifies that collab-server's /ports
 * endpoint discovers the actual bound port before Observe is clicked.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const DEFAULT_USER_ID = "workflow-pipeline-e2e";

const CFG = {
  frontendUrl: trimSlash(process.env.FRONTEND_URL || process.env.SYNTHI_FRONTEND_URL || "http://localhost:3000"),
  collabUrl: trimSlash(process.env.COLLAB_URL || process.env.SYNTHI_COLLAB_URL || "http://localhost:1234"),
  bridgeUrl: trimSlash(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL || "http://localhost:9466"),
  cdpUrl: trimSlash(process.env.SYNTHI_HOSTED_BROWSER_CDP_URL || process.env.SYNTHI_BROWSER_CDP_URL || "http://127.0.0.1:40101"),
  dockerComposeService: process.env.SYNTHI_COLLAB_COMPOSE_SERVICE || "collab-server",
  userId: process.env.SYNTHI_WORKFLOW_PIPELINE_USER_ID || DEFAULT_USER_ID,
  slugPrefix: process.env.SYNTHI_WORKFLOW_PIPELINE_SLUG_PREFIX || "workflow-pipeline",
  timeoutMs: Number(process.env.SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS || 90_000),
  keepWorkspaces: process.env.SYNTHI_WORKFLOW_PIPELINE_KEEP_WORKSPACES === "1",
  cases: (process.env.SYNTHI_WORKFLOW_PIPELINE_CASES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};

const artifactRoot = path.resolve(REPO_ROOT, "tmp", "workflow-pipeline-e2e");
const results = [];

function log(kind, message) {
  const tag = kind === "ok" ? "[ok]" : kind === "fail" ? "[fail]" : kind === "warn" ? "[warn]" : "[info]";
  console.log(`${tag} ${message}`);
}

function record(caseId, name, ok, detail = "") {
  results.push({ caseId, name, ok, detail });
  log(ok ? "ok" : "fail", `${caseId}: ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) throw new Error(`${caseId}: ${name}${detail ? `: ${detail}` : ""}`);
}

function trimSlash(value) {
  return String(value).replace(/\/$/, "");
}

function isScreenshotPage(value) {
  return Boolean(value && typeof value.screenshot === "function");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function privateWorkflowCallArgs(manifest, replayParameters, replayEnv, runMode) {
  const args = { run_mode: runMode };
  const parameters = Array.isArray(manifest?.parameters) ? manifest.parameters : [];
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== "string") continue;
    const fromParameter = ownString(replayParameters, parameter.name);
    const fromEnv = ownString(replayEnv, workflowParameterEnvName(parameter.name));
    const value = fromParameter ?? fromEnv;
    if (value !== undefined) args[parameter.name] = value;
  }
  return args;
}

function missingPrivateWorkflowArgs(manifest, args) {
  const parameters = Array.isArray(manifest?.parameters) ? manifest.parameters : [];
  return parameters
    .filter((parameter) => parameter?.required === true && typeof parameter.name === "string")
    .map((parameter) => parameter.name)
    .filter((name) => typeof args[name] !== "string");
}

function workflowParameterEnvName(value) {
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function ownString(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) && typeof record[key] === "string" ? record[key] : undefined;
}

function slugPart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}

function nowSlug() {
  return Date.now().toString(36);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await assertReachable(`${CFG.frontendUrl}/workspace`, "frontend");
  await assertReachable(`${CFG.collabUrl}/ports`, "collab-server ports");
  await assertReachable(`${CFG.bridgeUrl}/healthz`, "workflow bridge");
  await assertReachable(`${CFG.cdpUrl}/json/version`, "hosted browser CDP");

  const container = resolveCollabContainer();
  log("info", `collab container=${container}`);

  const runner = await ensurePlaywrightTestRunner();
  await pruneExistingCdpPageTargets(CFG.cdpUrl);
  const browser = await chromium.connectOverCDP(CFG.cdpUrl, { timeout: CFG.timeoutMs });
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
    await configureWorkflowBridgeForContext(context);
    await closeExistingPages(context);

    const selectedCases = CASES.filter((testCase) => CFG.cases.length === 0 || CFG.cases.includes(testCase.id));
    if (selectedCases.length === 0) {
      throw new Error(`no workflow pipeline cases selected: ${CFG.cases.join(",")}`);
    }

    for (const testCase of selectedCases) {
      await runCase({ testCase, container, context, runner });
    }

    await writeFile(
      path.join(artifactRoot, "summary.json"),
      JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2)
    );
    log("ok", `workflow pipeline passed ${selectedCases.length} seeded project(s)`);
    console.log(`artifacts=${artifactRoot}`);
  } finally {
    // This harness attaches to an already-owned hosted/runtime browser over CDP.
    // Closing the Playwright Browser can terminate that runtime; let process
    // teardown release the client connection instead.
  }
}

async function configureWorkflowBridgeForContext(context) {
  const bridgeUrl = CFG.bridgeUrl;
  await context.addInitScript((url) => {
    window.localStorage.setItem("synthi.agentWorkflowBridgeUrl", url);
  }, bridgeUrl);
}

async function runCase({ testCase, container, context, runner }) {
  const slug = `${CFG.slugPrefix}-${slugPart(testCase.id)}-${nowSlug()}`;
  const repoPath = `/data/repos/${slug}/${CFG.userId}`;
  const workspaceUrl = `${CFG.frontendUrl}/workspace/${encodeURIComponent(slug)}`;
  const caseDir = path.join(artifactRoot, slugPart(testCase.id));
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(caseDir, { recursive: true });

  const caseCleanups = [];
  let run;
  let idePage;
  let previewPage;
  try {
    const setupContext = typeof testCase.setup === "function"
      ? await testCase.setup({
        caseDir,
        addCleanup: (cleanup) => {
          if (typeof cleanup === "function") caseCleanups.push(cleanup);
        },
      }) ?? {}
      : {};

    log("info", `${testCase.id}: seed ${slug}`);
    const files = testCase.files(setupContext);
    await seedWorkspace(slug, files);
    record(testCase.id, "seed workspace files", true, slug);
    const registeredSourceTokens = await registerSeedSourceIdentity(slug, files);
    record(testCase.id, "register source identity", true, `tokens=${registeredSourceTokens}`);

    run = await startWorkspaceDevServer(container, slug, repoPath);
    const previewUrl = await waitForPreviewPort(run.slug, run.port);
    record(testCase.id, "detect actual running port", true, `port=${run.port} preview=${previewUrl}`);

    previewPage = await openPreviewPage(context, previewUrl);
    idePage = await openWorkflowsPanel(context, workspaceUrl, slug);
    const attachBody = await clickWorkflowButton(idePage, /^(Attach|Reattach)$/);
    record(testCase.id, "click attach", attachBody.ok === true, attachBody.result?.runtime?.adapter || "");

    await waitForWorkflowOverlay(previewPage);
    const observeState = await clickWorkflowOverlay(previewPage, "observe", previewUrl);
    const observedUrl = observeState.url;
    record(
      testCase.id,
      "click overlay observe",
      observeState.ok === true && observeState.observed === true && observedUrl === previewUrl,
      `observed=${observedUrl || "missing"} status=${observeState.status || "missing"}`
    );

    await previewPage.bringToFront().catch(() => undefined);
    await previewPage.screenshot({ path: path.join(caseDir, "observed-preview.png"), fullPage: true });

    const beginState = await clickWorkflowOverlay(previewPage, "teach");
    record(testCase.id, "click overlay teach", beginState.ok === true && beginState.recording === true, beginState.status || "");

    await previewPage.bringToFront().catch(() => undefined);
    const taughtVisualPage = await testCase.teach(previewPage, { caseDir });
    await previewPage.waitForTimeout(800);
    const afterTeachScreenshotPage = isScreenshotPage(taughtVisualPage) ? taughtVisualPage : previewPage;
    await afterTeachScreenshotPage.screenshot({ path: path.join(caseDir, "after-teach-actions.png"), fullPage: true });

    const endState = await clickWorkflowOverlay(previewPage, "stop", "", {
      allowZeroSteps: Boolean(testCase.expectedRecordingIssue),
    });
    const taughtSteps = Number(endState.stepCount || 0);
    record(testCase.id, "click overlay stop", endState.ok === true && taughtSteps >= testCase.minSteps, `steps=${taughtSteps}`);

    if (testCase.expectedRecordingIssue) {
      const stateBody = await workflowBridgeState();
      const state = stateBody.state ?? {};
      const recordingIssues = Array.isArray(state?.diagnostics?.recordingIssues) ? state.diagnostics.recordingIssues : [];
      const issueErrors = recordingIssues.map((issue) => issue?.error).filter(Boolean);
      const panelStepCount = Number(state?.workflow?.stepCount || 0);
      record(
        testCase.id,
        "record denied-origin issue",
        issueErrors.includes(testCase.expectedRecordingIssue),
        issueErrors.length ? `issues=${issueErrors.join(",")}` : "issues=none"
      );
      record(
        testCase.id,
        "deny keeps workflow empty",
        taughtSteps === 0 && panelStepCount === 0,
        `overlaySteps=${taughtSteps} panelSteps=${panelStepCount}`
      );
      await writeJson(caseDir, "denied-origin-state.json", state);
      await idePage.bringToFront().catch(() => undefined);
      await focusRecordingIssuePanel(idePage, testCase.expectedRecordingIssue);
      await idePage.screenshot({ path: path.join(caseDir, "after-denied-origin-panel.png"), fullPage: true });
      return;
    }

    const compileBody = await clickWorkflowButton(idePage, /^Compile$/);
    const contract = compileBody.result?.workflow?.contract;
    record(
      testCase.id,
      "click compile",
      compileBody.ok === true && contract?.steps?.length >= testCase.minSteps,
      `workflow=${contract?.workflowId || "missing"}`
    );
    if (Array.isArray(testCase.expectedActions) && testCase.expectedActions.length > 0) {
      const actionKinds = new Set((contract?.steps ?? []).map((step) => step?.action?.kind).filter(Boolean));
      const missingActions = testCase.expectedActions.filter((action) => !actionKinds.has(action));
      record(
        testCase.id,
        "compile expected actions",
        missingActions.length === 0,
        missingActions.length ? `missing=${missingActions.join(",")} actual=${[...actionKinds].join(",")}` : `actions=${[...actionKinds].join(",")}`
      );
    }
    await writeJson(caseDir, "contract.json", contract);

    const exportBody = await clickWorkflowButton(idePage, /^Export$/);
    let generated = exportBody.result;
    record(
      testCase.id,
      "click export",
      exportBody.ok === true && typeof generated?.code === "string" && generated.code.includes("@playwright/test"),
      `locators=${generated?.used_locators?.length ?? 0}`
    );
    if (testCase.exportMode) {
      const modeExportBody = await workflowBridgeTool("synthi_browser_generate_script", {
        workflow_id: contract?.workflowId,
        mode: testCase.exportMode,
      });
      generated = modeExportBody.result;
      record(
        testCase.id,
        `generate ${testCase.exportMode} script`,
        modeExportBody.ok === true && generated?.mode === testCase.exportMode && typeof generated?.code === "string",
        `mode=${generated?.mode || "missing"} locators=${generated?.used_locators?.length ?? 0}`
      );
    }
    const specPath = path.join(caseDir, "exported-workflow.spec.mjs");
    await writeFile(specPath, generated.code);
    await writeJson(caseDir, "export.json", generated);
    const replayParameters = typeof testCase.replayParameters === "function" ? await testCase.replayParameters({ caseDir }) : testCase.replayParameters || {};
    const replayEnv = typeof testCase.replayEnv === "function" ? await testCase.replayEnv({ caseDir }) : {};
    const forwardedPortLiterals = String(generated.code).match(/\/port\/\d+/g) ?? [];
    record(
      testCase.id,
      "export avoids forwarded port literals",
      forwardedPortLiterals.length === 0,
      forwardedPortLiterals.length ? `literals=${Array.from(new Set(forwardedPortLiterals)).join(",")}` : "no forwarded port literals"
    );
    if (Array.isArray(testCase.expectedReplayText) && testCase.expectedReplayText.length > 0) {
      const missingText = testCase.expectedReplayText.filter((text) => !String(generated?.code || "").includes(text));
      record(
        testCase.id,
        "export expected assertions",
        missingText.length === 0,
        missingText.length ? `missing=${missingText.join(" | ")}` : `assertions=${testCase.expectedReplayText.length}`
      );
    }
    if (Array.isArray(testCase.expectedReplayCode) && testCase.expectedReplayCode.length > 0) {
      const missingCode = testCase.expectedReplayCode.filter((snippet) => !String(generated?.code || "").includes(snippet));
      record(
        testCase.id,
        "export expected replay code",
        missingCode.length === 0,
        missingCode.length ? `missing=${missingCode.join(" | ")}` : `snippets=${testCase.expectedReplayCode.length}`
      );
    }
    if (Array.isArray(testCase.forbiddenReplayCode) && testCase.forbiddenReplayCode.length > 0) {
      const leakedCode = testCase.forbiddenReplayCode.filter((snippet) => String(generated?.code || "").includes(snippet));
      record(
        testCase.id,
        "export forbidden replay code",
        leakedCode.length === 0,
        leakedCode.length ? `leaked=${leakedCode.join(" | ")}` : `forbidden=${testCase.forbiddenReplayCode.length}`
      );
    }

    const manifestBody = await clickWorkflowButton(idePage, /^Manifest$/);
    const manifest = manifestBody.result?.manifest;
    record(
      testCase.id,
      "click manifest",
      manifestBody.ok === true && manifest?.kind === "privateMcpToolManifest",
      `status=${manifest?.status || "missing"} source=${manifest?.source_identity?.status || "missing"}`
    );
    await writeJson(caseDir, "manifest.json", manifest);

    const publishBody = await clickWorkflowButton(idePage, /^Publish$/);
    const publishedToolName = publishBody.result?.tool_name;
    record(
      testCase.id,
      "click publish private MCP tool",
      publishBody.ok === true && typeof publishedToolName === "string" && publishedToolName.startsWith("synthi_app_"),
      `tool=${publishedToolName || "missing"}`
    );
    await writeJson(caseDir, "publish.json", publishBody.result);
    await idePage.bringToFront().catch(() => undefined);
    await idePage.screenshot({ path: path.join(caseDir, "after-publish-panel.png"), fullPage: true });

    const privateManifestLookup = typeof publishedToolName === "string"
      ? await workflowBridgeTool("synthi_browser_get_private_tool_manifest", { tool_name: publishedToolName })
      : { ok: false, error: "missing_published_tool_name" };
    const privateManifest = privateManifestLookup.result?.manifest;
    record(
      testCase.id,
      "lookup published private MCP manifest",
      privateManifestLookup.ok === true && privateManifest?.tool_name === publishedToolName && privateManifest?.kind === "privateMcpToolManifest",
      `tool=${privateManifest?.tool_name || "missing"} status=${privateManifest?.status || "missing"}`
    );
    await writeJson(caseDir, "published-manifest-lookup.json", privateManifestLookup.result ?? privateManifestLookup);

    const privateToolRunMode = privateManifest?.mutation?.requires_confirmation ? "prefixOnly" : "sameSession";
    const privateToolArgs = privateWorkflowCallArgs(privateManifest, replayParameters, replayEnv, privateToolRunMode);
    const missingPrivateToolArgs = missingPrivateWorkflowArgs(privateManifest, privateToolArgs);
    if (missingPrivateToolArgs.length === 0) {
      const privateToolCall = typeof publishedToolName === "string"
        ? await workflowBridgeTool(publishedToolName, privateToolArgs)
        : { ok: false, error: "missing_published_tool_name" };
      record(
        testCase.id,
        "call discovered private MCP tool",
        privateToolCall.ok === true &&
          privateToolCall.result?.private_tool?.tool_name === publishedToolName &&
          privateToolCall.result?.private_tool?.run_mode === privateToolRunMode,
        privateToolCall.ok === true
          ? `tool=${publishedToolName} mode=${privateToolRunMode} steps=${privateToolCall.result?.replay?.steps_run ?? 0}`
          : `error=${privateToolCall.result?.error || privateToolCall.error || "unknown"}`
      );
      await writeJson(caseDir, "private-tool-call.json", privateToolCall.result ?? privateToolCall);
    } else {
      const allowParameterGate = testCase.allowPrivateToolParameterGate === true;
      record(
        testCase.id,
        "private MCP tool parameter gate",
        allowParameterGate,
        `missing=${missingPrivateToolArgs.join(",")}`
      );
      await writeJson(caseDir, "private-tool-call.json", {
        skipped: "missing_required_parameters",
        tool_name: publishedToolName,
        missing_parameters: missingPrivateToolArgs,
      });
    }

    const validateBody = await clickWorkflowButton(idePage, /^Validate$/);
    const validation = validateBody.result?.validation;
    record(
      testCase.id,
      "click validate",
      validateBody.ok === true && ["ready", "stoppedAtMutationBoundary"].includes(validation?.status),
      `status=${validation?.status || "missing"}`
    );
    await writeJson(caseDir, "validation.json", validation);
    await idePage.bringToFront().catch(() => undefined);
    await idePage.screenshot({ path: path.join(caseDir, "after-validate-panel.png"), fullPage: true });
    if (testCase.liveReplayMode) {
      const liveReplay = await runLiveWorkflowReplay({
        caseId: testCase.id,
        workflowId: contract?.workflowId,
        mode: testCase.liveReplayMode,
        parameters: replayParameters,
      });
      await writeJson(caseDir, "live-replay.json", liveReplay);
      record(
        testCase.id,
        "run MCP workflow replay",
        liveReplay.ok === true && liveReplay.replay?.steps_run >= testCase.minSteps,
        liveReplay.ok === true
          ? `steps=${liveReplay.replay?.steps_run ?? 0}`
          : `error=${liveReplay.replay?.error || liveReplay.error || "unknown"}`
      );
    }
    const runResult = await runExportedPlaywright({ runner, specPath, previewUrl, caseDir, caseId: testCase.id, env: replayEnv });
    record(testCase.id, "run exported Playwright", runResult.ok, runResult.detail);

    if (testCase.ciIsolatedReplay === true) {
      const ciReplay = await runCiIsolatedWorkflowReplay({
        caseId: testCase.id,
        workflowId: contract?.workflowId,
        workspaceId: slug,
        runner,
        previewUrl,
        caseDir,
        parameters: replayParameters,
      });
      await writeJson(caseDir, "ci-isolated-replay.json", ciReplay);
      record(
        testCase.id,
        "run CI isolated replay",
        ciReplay.ok === true && ciReplay.replay?.status === "passed" && ciReplay.replay?.mutation_executed === true,
        ciReplay.ok === true
          ? `status=${ciReplay.replay?.status} mutation=${ciReplay.replay?.mutation_executed}`
          : `status=${ciReplay.replay?.status || "missing"} error=${ciReplay.replay?.failure_class || ciReplay.error || "unknown"}`
      );
    }
  } finally {
    if (previewPage && !previewPage.isClosed()) {
      await resetHostedRuntimePage(previewPage);
    }
    if (idePage && !idePage.isClosed()) {
      await resetHostedRuntimePage(idePage);
    }
    if (run) {
      await stopWorkspaceDevServer(container, run).catch((err) => {
        log("warn", `${testCase.id}: failed to stop dev server: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    for (const cleanup of [...caseCleanups].reverse()) {
      await cleanup().catch((err) => {
        log("warn", `${testCase.id}: cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    if (!CFG.keepWorkspaces) {
      await dockerExec(container, ["sh", "-lc", `rm -rf ${shellQuote(`/data/repos/${slug}`)}`]).catch(() => undefined);
    }
  }
}

async function runCiIsolatedWorkflowReplay({ caseId, workflowId, workspaceId, runner, previewUrl, caseDir, parameters }) {
  if (!workflowId) return { ok: false, error: "missing_workflow_id" };
  const resetScript = path.join(caseDir, "ci-reset.mjs");
  const resetAssertionScript = path.join(caseDir, "ci-reset-assertion.mjs");
  const ciScript = path.join(caseDir, "ci-run.mjs");
  const postconditionScript = path.join(caseDir, "ci-postcondition.mjs");
  const ciSpecTarget = path.join(runner.root, `${slugPart(caseId)}-ci-isolated.spec.mjs`);
  const markerPath = path.join(caseDir, "ci-reset-marker.json");
  const stateSeedId = `${slugPart(caseId)}-${workspaceId}`;
  await writeFile(resetScript, [
    "import { writeFile } from 'node:fs/promises';",
    `if (process.cwd() !== ${JSON.stringify(runner.root)}) throw new Error('reset_wrong_cwd');`,
    `await writeFile(${JSON.stringify(markerPath)}, JSON.stringify({ reset: true, baseUrl: process.env.PLAYWRIGHT_BASE_URL, seedId: process.env.SYNTHI_WORKFLOW_CI_STATE_SEED_ID }));`,
    "",
  ].join("\n"));
  await writeFile(resetAssertionScript, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    `if (process.cwd() !== ${JSON.stringify(runner.root)}) throw new Error('reset_assertion_wrong_cwd');`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    "const marker = JSON.parse(await readFile(markerPath, 'utf8'));",
    "if (!marker.reset) throw new Error('reset_not_run');",
    "if (marker.seedId !== process.env.SYNTHI_WORKFLOW_CI_STATE_SEED_ID) throw new Error('state_seed_id_mismatch');",
    "await writeFile(markerPath, JSON.stringify({ ...marker, resetAssertion: true }));",
    "",
  ].join("\n"));
  await writeFile(ciScript, [
    "import { spawn } from 'node:child_process';",
    "import { copyFile, readFile, writeFile } from 'node:fs/promises';",
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const specTarget = ${JSON.stringify(ciSpecTarget)};`,
    `const runnerRoot = ${JSON.stringify(runner.root)};`,
    `const runnerConfig = ${JSON.stringify(runner.configPath)};`,
    `const chromiumExecutable = ${JSON.stringify(chromium.executablePath())};`,
    "const playwrightBin = `${runnerRoot}/node_modules/.bin/${process.platform === 'win32' ? 'playwright.cmd' : 'playwright'}`;",
    "if (process.cwd() !== runnerRoot) throw new Error('ci_wrong_cwd');",
    "const marker = JSON.parse(await readFile(markerPath, 'utf8'));",
    "if (!marker.reset) throw new Error('reset_not_run');",
    "if (!marker.resetAssertion) throw new Error('reset_assertion_not_run');",
    "const spec = await readFile(process.env.SYNTHI_WORKFLOW_SPEC, 'utf8');",
    "if (spec.includes('Mutation boundary:')) throw new Error('ci_script_stopped_at_mutation_boundary');",
    "if (!spec.includes('ALLOW_WORKFLOW_MUTATION')) throw new Error('ci_script_missing_mutation_guard');",
    "if (!spec.includes('SYNTHI_WORKFLOW_CI_RUN_ID')) throw new Error('ci_script_missing_run_attestation');",
    "await copyFile(process.env.SYNTHI_WORKFLOW_SPEC, specTarget);",
    "const proc = spawn(playwrightBin, ['test', specTarget, '--config', runnerConfig, '--reporter=line'], {",
    "  cwd: runnerRoot,",
    "  env: {",
    "    ...process.env,",
    "    PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL,",
    "    PLAYWRIGHT_CHROMIUM_EXECUTABLE: chromiumExecutable,",
    "    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',",
    "    ALLOW_WORKFLOW_MUTATION: '1',",
    "  },",
    "  stdio: 'inherit',",
    "});",
    "const code = await new Promise((resolve, reject) => {",
    "  proc.on('error', reject);",
    "  proc.on('exit', (exitCode) => resolve(exitCode ?? 1));",
    "});",
    "if (code === 0) await writeFile(markerPath, JSON.stringify({ ...marker, ci: true }));",
    "process.exit(code);",
    "",
  ].join("\n"));
  await writeFile(postconditionScript, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    `if (process.cwd() !== ${JSON.stringify(runner.root)}) throw new Error('postcondition_wrong_cwd');`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    "const marker = JSON.parse(await readFile(markerPath, 'utf8'));",
    "if (!marker.ci) throw new Error('ci_not_run');",
    "const attestation = await readFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, 'utf8');",
    "if (!attestation.includes(process.env.SYNTHI_WORKFLOW_CI_RUN_ID)) throw new Error('attestation_run_id_missing');",
    "await writeFile(markerPath, JSON.stringify({ ...marker, postcondition: true }));",
    "",
  ].join("\n"));

  await workflowBridgeTool("synthi_safety_set_replay_isolation_profile", {
    workspace_id: workspaceId,
    kind: "ciIsolated",
    base_url: trimSlash(previewUrl),
    working_directory: runner.root,
    data_reset_command: `${shellQuote(process.execPath)} ${shellQuote(resetScript)}`,
    reset_assertion_command: `${shellQuote(process.execPath)} ${shellQuote(resetAssertionScript)}`,
    ci_command: `${shellQuote(process.execPath)} ${shellQuote(ciScript)}`,
    postcondition_command: `${shellQuote(process.execPath)} ${shellQuote(postconditionScript)}`,
    state_seed_id: stateSeedId,
    allow_mutation_replay: true,
  });
  const body = await workflowBridgeTool("synthi_safety_run_ci_isolated_replay", {
    workspace_id: workspaceId,
    workflow_id: workflowId,
    parameters,
    artifact_root: path.join(caseDir, "ci-artifacts"),
    timeout_ms: CFG.timeoutMs,
  });
  return body.result ?? body;
}

async function seedWorkspace(slug, files) {
  const payload = await httpJson("POST", `${CFG.collabUrl}/git/${encodeURIComponent(slug)}/write-files-batch`, {
    files,
    syncToGcs: false,
  }, {
    "x-user-id": CFG.userId,
  });
  const hardErrors = (payload.errors || []).filter((entry) => entry?.stage !== "gcs_upload");
  if (hardErrors.length) throw new Error(`seed failed: ${JSON.stringify(hardErrors).slice(0, 1000)}`);
  try {
    await httpJson("POST", `${CFG.collabUrl}/git/${encodeURIComponent(slug)}/stage-all`, {}, { "x-user-id": CFG.userId });
    await httpJson("POST", `${CFG.collabUrl}/git/${encodeURIComponent(slug)}/commit`, {
      message: `workflow-pipeline-e2e: seed ${slug}`,
    }, { "x-user-id": CFG.userId });
  } catch (err) {
    log("warn", `${slug}: seed commit skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function registerSeedSourceIdentity(slug, files) {
  const registrations = extractSourceIdentityRegistrations(files);
  let total = 0;
  for (const registration of registrations) {
    const body = await workflowBridgeTool("synthi_source_register_tokens", {
      workspace_id: slug,
      file_path: registration.file_path,
      adapter: "workflow-pipeline-seed",
      transform_version: "workflow_pipeline_seed_v1",
      tokens: registration.tokens,
    });
    if (body.ok !== true) {
      throw new Error(`source identity registration failed for ${registration.file_path}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    total += Number(body.result?.registered_count || registration.tokens.length || 0);
  }
  return total;
}

async function runLiveWorkflowReplay({ caseId, workflowId, mode, parameters = {} }) {
  if (!workflowId) return { ok: false, error: "missing_workflow_id" };
  const leaseBody = await workflowBridgeTool("synthi_browser_acquire_lease", {
    owner: "workflow-pipeline-e2e",
    lease_ms: 30_000,
    reason: `${caseId}:live-replay`,
  });
  const leaseId = leaseBody.result?.lease?.lease_id;
  if (!leaseId) return { ok: false, error: "lease_not_acquired", leaseBody };
  try {
    const runBody = await workflowBridgeTool("synthi_browser_run_workflow", {
      lease_id: leaseId,
      workflow_id: workflowId,
      mode,
      parameters,
    });
    return runBody.result ?? runBody;
  } finally {
    await workflowBridgeTool("synthi_browser_release_lease", {
      lease_id: leaseId,
      reason: `${caseId}:live-replay-complete`,
    }).catch(() => undefined);
  }
}

async function workflowBridgeTool(tool, args) {
  return await httpJson("POST", `${CFG.bridgeUrl}/browser-workflows/tool`, {
    tool,
    arguments: args,
  });
}

async function workflowBridgeState() {
  return await httpJson("GET", `${CFG.bridgeUrl}/browser-workflows/state`);
}

async function startAuxiliaryOriginServer(routes) {
  const routeMap = new Map(Object.entries(routes));
  const server = http.createServer((request, response) => {
    const pathName = new URL(request.url || "/", "http://localhost").pathname;
    const route = routeMap.get(pathName);
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const body = typeof route === "function" ? route(request) : route;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("auxiliary origin did not bind to a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function extractSourceIdentityRegistrations(files) {
  const registrations = [];
  for (const file of files) {
    if (file.encoding !== "utf8" || typeof file.content !== "string") continue;
    const tokens = extractSourceIdentityTokens(file.path, file.content);
    if (tokens.length > 0) registrations.push({ file_path: file.path, tokens });
  }
  return registrations;
}

function extractSourceIdentityTokens(filePath, content) {
  const tokens = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] || "";
    const regex = /data-synthi-source-id\s*=\s*["']([^"']+)["']/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const token = match[1];
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push({
        token,
        file: filePath,
        line: lineIndex + 1,
        column: match.index + 1,
        tag: sourceTagForLine(line, match.index),
      });
    }
  }
  return tokens;
}

function sourceTagForLine(line, attrIndex) {
  const before = line.slice(0, attrIndex);
  const match = before.match(/<([a-zA-Z][\w:-]*)[^<]*$/);
  return match?.[1] || "element";
}

async function startWorkspaceDevServer(container, slug, repoPath) {
  const safeSlug = slugPart(slug);
  const portFile = `/tmp/${safeSlug}.port`;
  const pidFile = `/tmp/${safeSlug}.pid`;
  const logFile = `/tmp/${safeSlug}.log`;
  const command = [
    `rm -f ${shellQuote(portFile)} ${shellQuote(pidFile)} ${shellQuote(logFile)}`,
    `export REPO=${shellQuote(repoPath)}`,
    `export SYNTHI_PORT_FILE=${shellQuote(portFile)}`,
    `setsid sh -lc 'cd "$REPO" && HOST=0.0.0.0 PORT=0 SYNTHI_PORT_FILE="$SYNTHI_PORT_FILE" npm run dev' > ${shellQuote(logFile)} 2>&1 & echo $! > ${shellQuote(pidFile)}`,
  ].join("; ");
  await dockerExec(container, ["sh", "-lc", command]);
  const port = await waitForContainerFile(container, portFile, CFG.timeoutMs);
  return {
    slug,
    repoPath,
    port: Number(port),
    portFile,
    pidFile,
    logFile,
  };
}

async function stopWorkspaceDevServer(container, run) {
  await dockerExec(container, ["sh", "-lc", `if [ -s ${shellQuote(run.pidFile)} ]; then pid=$(cat ${shellQuote(run.pidFile)}); kill -TERM -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true; fi`]);
  await sleep(500);
  await dockerExec(container, ["sh", "-lc", `if [ -s ${shellQuote(run.pidFile)} ]; then pid=$(cat ${shellQuote(run.pidFile)}); kill -KILL -$pid 2>/dev/null || true; fi`]).catch(() => undefined);
}

async function waitForPreviewPort(slug, expectedPort) {
  const deadline = Date.now() + CFG.timeoutMs;
  while (Date.now() < deadline) {
    const status = await httpJson("GET", `${CFG.collabUrl}/ports?workspace=${encodeURIComponent(slug)}`);
    const preview = (status.previews || []).find((item) => Number(item.port) === expectedPort);
    if (preview?.url) return new URL(preview.url, CFG.collabUrl).href;
    await sleep(500);
  }
  throw new Error(`port ${expectedPort} was not reported by /ports`);
}

async function openWorkflowsPanel(context, workspaceUrl, slug) {
  for (const candidate of context.pages()) {
    if (candidate.url().includes(`/workspace/${encodeURIComponent(slug)}`)) {
      await resetHostedRuntimePage(candidate);
    }
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
  const workflowsButton = page.locator('button[aria-label="Workflows"]').first();
  await workflowsButton.waitFor({ state: "visible", timeout: CFG.timeoutMs });
  const deadline = Date.now() + CFG.timeoutMs;
  while (Date.now() < deadline) {
    await workflowsButton.click({ force: true });
    await page.waitForTimeout(1000);
    if (await page.locator('[data-testid="agent-workflow-panel"]').count().catch(() => 0) > 0) return page;
  }
  await page.screenshot({ path: path.join(artifactRoot, "workflows-panel-timeout.png"), fullPage: true }).catch(() => undefined);
  throw new Error("workflows_panel_not_visible");
}

async function closeExistingPages(context) {
  await Promise.all(context.pages().map((page) => resetHostedRuntimePage(page)));
}

async function pruneExistingCdpPageTargets(cdpUrl) {
  const baseUrl = cdpHttpBaseUrl(cdpUrl);
  if (!baseUrl) return;
  let targets = [];
  try {
    const response = await fetchWithTimeout(`${baseUrl}/json/list`, { timeoutMs: Math.min(CFG.timeoutMs, 10_000) });
    if (!response.ok) return;
    const body = await response.json();
    if (Array.isArray(body)) targets = body;
  } catch {
    return;
  }
  const pageTargets = targets.filter((target) =>
    target &&
    typeof target.id === "string" &&
    (target.type === "page" || target.type === "webview")
  );
  await Promise.all(pageTargets.map((target) =>
    fetchWithTimeout(`${baseUrl}/json/close/${encodeURIComponent(target.id)}`, {
      timeoutMs: Math.min(CFG.timeoutMs, 10_000),
    }).catch(() => undefined)
  ));
}

function cdpHttpBaseUrl(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return trimSlash(parsed.origin);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      return trimSlash(parsed.origin);
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchWithTimeout(url, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openPreviewPage(context, previewUrl) {
  for (const candidate of context.pages()) {
    if (trimSlash(candidate.url()) === trimSlash(previewUrl)) {
      await resetHostedRuntimePage(candidate);
    }
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
  return page;
}

async function resetHostedRuntimePage(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(async () => {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => undefined);
  });
}

async function waitForWorkflowOverlay(page) {
  await page.getByTestId("synthi-workflow-toolbox").waitFor({ state: "visible", timeout: CFG.timeoutMs });
}

async function clickWorkflowOverlay(page, action, expectedUrl = "", options = {}) {
  const testId = action === "observe" ? "synthi-workflow-observe" : "synthi-workflow-teach";
  await waitForWorkflowOverlay(page);
  const button = page.getByTestId(testId).first();
  await expectButtonEnabled(page, button, `overlay:${action}`);
  await button.click();
  const deadline = Date.now() + CFG.timeoutMs;
  while (Date.now() < deadline) {
    const state = await workflowOverlayState(page);
    if (action === "observe" && state.observed && (!expectedUrl || trimSlash(state.url) === trimSlash(expectedUrl))) return state;
    if (action === "teach" && state.status === "recording") return state;
    if (action === "stop" && !state.recording && (state.stepCount > 0 || options.allowZeroSteps === true)) return state;
    await sleep(250);
  }
  throw new Error(`overlay ${action} did not settle; state=${JSON.stringify(await workflowOverlayState(page))}`);
}

async function workflowOverlayState(page) {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-synthi-workflow-toolbox]');
    if (!host) return { ok: false, status: "missing", label: "Missing", observed: false, recording: false, stepCount: 0 };
    return {
      ok: host.getAttribute("data-synthi-workflow-status") !== "error",
      status: host.getAttribute("data-synthi-workflow-status") || "idle",
      label: host.shadowRoot?.querySelector(".label")?.textContent?.trim() || "",
      detail: host.getAttribute("title") || "",
      observed: host.getAttribute("data-synthi-workflow-status") === "observed",
      recording: host.getAttribute("data-synthi-workflow-recording") === "true",
      stepCount: Number(host.getAttribute("data-synthi-workflow-steps") || 0),
      url: host.getAttribute("data-synthi-workflow-url") || "",
    };
  });
}

async function clickWorkflowButton(page, labelPattern) {
  const panel = page.locator('[data-testid="agent-workflow-panel"]').first();
  const button = panel.getByRole("button", { name: labelPattern }).first();
  await expectButtonEnabled(page, button, labelPattern);
  const events = [];
  const onRequest = (request) => {
    const url = request.url();
    if (url.includes("/browser-workflows") || url.includes("/ports")) {
      const event = { type: "request", url, method: request.method() };
      if (url.includes("/browser-workflows/tool")) {
        event.postData = request.postData()?.slice(0, 1000) || "";
      }
      events.push(event);
    }
  };
  const onResponse = (response) => {
    const url = response.url();
    if (url.includes("/browser-workflows") || url.includes("/ports")) {
      events.push({ type: "response", url, status: response.status() });
    }
  };
  const onRequestFailed = (request) => {
    const url = request.url();
    if (url.includes("/browser-workflows") || url.includes("/ports")) {
      events.push({ type: "failed", url, error: request.failure()?.errorText || "unknown" });
    }
  };
  await page.evaluate(() => {
    if (window.__synthiWorkflowActionEventsInstalled) return;
    window.__synthiWorkflowActionEventsInstalled = true;
    window.__synthiWorkflowActionEvents = [];
    window.addEventListener("synthi:agent-workflow-action", (event) => {
      window.__synthiWorkflowActionEvents.push(event.detail || {});
    });
  });
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/browser-workflows/tool") &&
    response.request().method() === "POST",
    { timeout: CFG.timeoutMs }
  ).catch((err) => ({ __workflowHarnessError: err }));
  await button.click();
  try {
    const response = await responsePromise;
    if (response?.__workflowHarnessError) {
      const err = response.__workflowHarnessError;
      const actionEvents = await page.evaluate(() => window.__synthiWorkflowActionEvents || []).catch(() => []);
      throw new Error(`${err instanceof Error ? err.message : String(err)}; workflow network events=${JSON.stringify(events)} action events=${JSON.stringify(actionEvents)} button states=${JSON.stringify(await workflowButtonStates(page))}`);
    }
    const body = await response.json();
    if (body.ok !== true) {
      throw new Error(`workflow button ${labelPattern} failed: ${JSON.stringify(body.result || body).slice(0, 1000)}`);
    }
    body.__workflowHarnessEvents = events;
    await page.waitForTimeout(300);
    return body;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
}

async function focusRecordingIssuePanel(page, error) {
  const label = {
    frame_origin_consent_required: "Frame consent required",
    popup_origin_consent_required: "Popup consent required",
    teach_tab_mismatch: "Different tab was used",
    teach_origin_mismatch: "Different origin was used",
    origin_consent_required: "Origin consent required",
  }[error] || "Recording issue";
  await page.getByText(label).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(async () => {
    await page.mouse.wheel(0, 900).catch(() => undefined);
  });
  await page.waitForTimeout(250);
}

async function expectButtonEnabled(page, button, labelPattern) {
  await button.waitFor({ state: "visible", timeout: CFG.timeoutMs });
  const deadline = Date.now() + CFG.timeoutMs;
  while (Date.now() < deadline) {
    if (await button.isEnabled().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`button not enabled: ${labelPattern}; button states=${JSON.stringify(await workflowButtonStates(page))}`);
}

async function workflowButtonStates(page) {
  return await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="agent-workflow-panel"]');
    if (!panel) return [];
    return Array.from(panel.querySelectorAll("button")).map((button) => ({
      text: button.textContent?.replace(/\s+/g, " ").trim() || "",
      disabled: Boolean(button.disabled),
      title: button.getAttribute("title") || "",
      visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
    }));
  }).catch(() => []);
}

async function findPageByUrl(context, url) {
  const normalized = trimSlash(url);
  const deadline = Date.now() + CFG.timeoutMs;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => trimSlash(candidate.url()) === normalized);
    if (page) return page;
    await sleep(250);
  }
  throw new Error(`preview page not found: ${url}`);
}

async function runExportedPlaywright({ runner, specPath, previewUrl, caseDir, caseId, env = {} }) {
  const specDir = path.join(runner.root, "cases", safePathSegment(caseId));
  await rm(specDir, { recursive: true, force: true });
  await mkdir(specDir, { recursive: true });
  const specTarget = path.join(specDir, "workflow.spec.mjs");
  await writeFile(specTarget, await readFile(specPath, "utf8"));
  const executablePath = chromium.executablePath();
  const specArg = path.relative(runner.root, specTarget).split(path.sep).join("/");
  const proc = spawn(path.join(runner.root, "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright"), [
    "test",
    specArg,
    "--config",
    runner.configPath,
    "--reporter=line",
  ], {
    cwd: runner.root,
    env: {
      ...process.env,
      ...env,
      PLAYWRIGHT_BASE_URL: trimSlash(previewUrl),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: executablePath,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectProcess(proc, CFG.timeoutMs);
  const combinedOutput = output.stdout + output.stderr;
  const normalizedOutput = stripAnsi(combinedOutput);
  const skipped = /\b\d+\s+skipped\b/i.test(normalizedOutput);
  await writeFile(path.join(caseDir, "playwright-run.log"), combinedOutput);
  return {
    ok: output.code === 0 && !skipped,
    detail: output.code === 0
      ? skipped ? "skipped - generated script did not execute all required steps" : "passed"
      : `exit=${output.code} ${stripAnsi(output.stderr || output.stdout).slice(0, 240)}`,
  };
}

function safePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_") || "workflow";
}

async function ensurePlaywrightTestRunner() {
  const root = path.join(artifactRoot, "runner");
  const pkgPath = path.join(root, "package.json");
  const configPath = path.join(root, "playwright.config.mjs");
  await mkdir(root, { recursive: true });
  if (!existsSync(pkgPath)) {
    const version = JSON.parse(await readFile(path.join(MCP_ROOT, "node_modules/playwright-core/package.json"), "utf8")).version;
    await writeFile(pkgPath, JSON.stringify({
      type: "module",
      private: true,
      devDependencies: {
        "@playwright/test": version,
      },
    }, null, 2) + "\n");
  }
  await writeFile(configPath, [
    "export default {",
    "  testDir: '.',",
    "  timeout: 30000,",
    "  retries: 0,",
    "  use: {",
    "    browserName: 'chromium',",
    "    headless: true,",
    "    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },",
    "  },",
    "};",
    "",
  ].join("\n"));
  if (!existsSync(path.join(root, "node_modules", "@playwright", "test"))) {
    log("info", "installing temporary @playwright/test runner");
    const install = spawn("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await collectProcess(install, CFG.timeoutMs);
    if (output.code !== 0) {
      throw new Error(`temporary @playwright/test install failed: ${stripAnsi(output.stderr || output.stdout).slice(0, 800)}`);
    }
  }
  return { root, configPath };
}

function resolveCollabContainer() {
  const result = spawnSync("docker", ["compose", "ps", "-q", CFG.dockerComposeService], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ps failed: ${result.stderr || result.stdout}`);
  }
  const id = result.stdout.trim().split(/\s+/).find(Boolean);
  if (!id) throw new Error(`no container found for docker compose service ${CFG.dockerComposeService}`);
  return id;
}

async function dockerExec(container, args) {
  const proc = spawn("docker", ["exec", container, ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectProcess(proc, CFG.timeoutMs);
  if (output.code !== 0) {
    throw new Error(`docker exec failed: ${stripAnsi(output.stderr || output.stdout).slice(0, 1000)}`);
  }
  return output.stdout;
}

async function waitForContainerFile(container, filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const out = await dockerExec(container, ["sh", "-lc", `if [ -s ${shellQuote(filePath)} ]; then cat ${shellQuote(filePath)}; fi`]);
    last = out.trim();
    if (/^\d+$/.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`container file not ready: ${filePath} last=${last}`);
}

async function assertReachable(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status}`);
  } finally {
    clearTimeout(timer);
  }
  log("ok", `${label} reachable`);
}

async function httpJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return payload;
}

async function writeJson(dir, name, value) {
  await writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + "\n");
}

async function collectProcess(proc, timeoutMs) {
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  proc.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms: ${stderr || stdout}`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function commonFiles({ title, body, script, styles = [], extraFiles = [] }) {
  return [
    {
      path: "package.json",
      encoding: "utf8",
      content: JSON.stringify({
        scripts: { dev: "node server.mjs" },
        dependencies: {},
        devDependencies: {},
      }, null, 2) + "\n",
    },
    {
      path: "server.mjs",
      encoding: "utf8",
      content: staticServerSource(),
    },
    {
      path: "index.html",
      encoding: "utf8",
      content: [
        "<!doctype html>",
        "<html>",
        "  <head>",
        "    <meta charset=\"UTF-8\">",
        `    <title>${title}</title>`,
        "    <link rel=\"stylesheet\" href=\"/styles.css\">",
        "  </head>",
        "  <body>",
        body,
        "    <script type=\"module\" src=\"/app.js\"></script>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    },
    {
      path: "styles.css",
      encoding: "utf8",
      content: [
        ":root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #191919; background: #f8f8f5; }",
        "body { margin: 0; min-height: 100vh; display: grid; place-items: center; }",
        "main { width: min(760px, calc(100vw - 48px)); display: grid; gap: 18px; }",
        "h1 { margin: 0; font-size: 38px; line-height: 1.1; }",
        "label { display: grid; gap: 7px; font-weight: 700; }",
        "input, select { height: 42px; border: 1px solid #b9b9b2; padding: 0 12px; font: inherit; background: white; }",
        "button, a[role='button'] { width: max-content; min-height: 42px; border: 0; background: #222; color: white; padding: 10px 16px; font: inherit; cursor: pointer; text-decoration: none; }",
        "output, .status { min-height: 24px; color: #17663a; font-weight: 800; }",
        ".row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }",
        ...styles,
        "",
      ].join("\n"),
    },
    {
      path: "app.js",
      encoding: "utf8",
      content: script,
    },
    ...extraFiles,
  ];
}

function staticServerSource() {
  return [
    "import http from 'node:http';",
    "import { readFile, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const root = path.dirname(fileURLToPath(import.meta.url));",
    "const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'application/javascript'], ['.css', 'text/css']]);",
    "const server = http.createServer(async (req, res) => {",
    "  const url = new URL(req.url || '/', 'http://workspace.local');",
    "  let pathname = decodeURIComponent(url.pathname);",
    "  if (pathname === '/' || !path.extname(pathname)) pathname = '/index.html';",
    "  const filePath = path.resolve(root, '.' + pathname);",
    "  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }",
    "  try {",
    "    const body = await readFile(filePath);",
    "    res.writeHead(200, { 'content-type': mime.get(path.extname(filePath)) || 'application/octet-stream' });",
    "    res.end(body);",
    "  } catch {",
    "    res.writeHead(404);",
    "    res.end('Not found');",
    "  }",
    "});",
    "const host = process.env.HOST || '0.0.0.0';",
    "const requestedPort = Number(process.env.PORT || 0);",
    "server.listen(requestedPort, host, async () => {",
    "  const address = server.address();",
    "  const port = typeof address === 'object' && address ? address.port : requestedPort;",
    "  if (process.env.SYNTHI_PORT_FILE) await writeFile(process.env.SYNTHI_PORT_FILE, String(port));",
    "  console.log(`SYNTHI_WORKFLOW_PORT ${port}`);",
    "});",
    "",
  ].join("\n");
}

const CASES = [
  {
    id: "profile-form",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    replayEnv: () => ({ EMAIL: "investor@example.test" }),
    files: () => commonFiles({
      title: "Profile Form Workflow",
      body: [
        "    <main>",
        "      <h1>Profile Form Workflow</h1>",
        "      <label for=\"email\">Email</label>",
        "      <input id=\"email\" name=\"email\" aria-label=\"Email\" data-synthi-source-id=\"profile.email\" placeholder=\"ada@example.test\">",
        "      <button type=\"button\" data-testid=\"save-profile\" data-synthi-source-id=\"profile.save\">Save profile</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "document.querySelector('[data-testid=\"save-profile\"]').addEventListener('click', () => {",
        "  const value = document.querySelector('#email').value;",
        "  document.querySelector('#status').textContent = `Saved ${value}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Email").fill("ada@example.test");
      await page.getByRole("button", { name: "Save profile" }).click();
      await page.getByText("Saved ada@example.test").waitFor();
    },
  },
  {
    id: "parameterized-form-data",
    minSteps: 2,
    expectedActions: ["fill", "select"],
    expectedReplayCode: [
      "const inputValue1 = readRequiredEnv(\"EMAIL\", \"browser_evt_1\");",
      "const selectValue2 = readRequiredEnv(\"SEGMENT\", \"browser_evt_2\");",
      "await target1.fill(inputValue1);",
      "await target2.selectOption(selectValue2);",
      "parameterizedTextRegex([\"Preview ready for \",\" in \",\"\"], inputValue1, selectValue2)",
    ],
    forbiddenReplayCode: [
      "taught@example.test",
      "enterprise",
    ],
    replayEnv: () => ({ EMAIL: "agent@example.test", SEGMENT: "startup" }),
    files: () => commonFiles({
      title: "Parameterized Form Data Workflow",
      body: [
        "    <main>",
        "      <h1>Parameterized Form Data Workflow</h1>",
        "      <label for=\"email\">Email</label>",
        "      <input id=\"email\" name=\"email\" aria-label=\"Email\" data-synthi-source-id=\"parameter.email\" placeholder=\"ada@example.test\">",
        "      <label for=\"segment\">Segment</label>",
        "      <select id=\"segment\" aria-label=\"Segment\" data-synthi-source-id=\"parameter.segment\">",
        "        <option value=\"standard\">standard</option>",
        "        <option value=\"startup\">startup</option>",
        "        <option value=\"enterprise\">enterprise</option>",
        "      </select>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "const email = document.querySelector('#email');",
        "const segment = document.querySelector('#segment');",
        "const status = document.querySelector('#status');",
        "function renderPreview() {",
        "  status.textContent = email.value ? `Preview ready for ${email.value} in ${segment.value}` : 'Waiting';",
        "}",
        "email.addEventListener('input', renderPreview);",
        "segment.addEventListener('change', renderPreview);",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Email").fill("taught@example.test");
      await page.getByText("Preview ready for taught@example.test in standard").waitFor();
      await page.getByLabel("Segment").selectOption("enterprise");
      await page.getByText("Preview ready for taught@example.test in enterprise").waitFor();
    },
  },
  {
    id: "clipboard-paste-textbox",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [
      "Paste event captured",
    ],
    expectedReplayCode: [
      "async function pasteText(page, target, text)",
      "process.env[\"API_TOKEN_PASTE\"]",
      "await pasteText(page, target1, pasteText1);",
      "await expect(target1).toHaveValue(pasteText1);",
    ],
    liveReplayMode: "sameSession",
    replayParameters: { api_token_paste: "agent-provided-token-42" },
    replayEnv: () => ({ API_TOKEN_PASTE: "agent-provided-token-42" }),
    files: () => commonFiles({
      title: "Clipboard Paste Textbox Workflow",
      body: [
        "    <main>",
        "      <h1>Clipboard Paste Textbox Workflow</h1>",
        "      <label for=\"api-token\">API token</label>",
        "      <input id=\"api-token\" aria-label=\"API token\" data-synthi-source-id=\"clipboard.token\" autocomplete=\"off\">",
        "      <button type=\"button\" data-testid=\"save-token\" data-synthi-source-id=\"clipboard.save\">Save pasted token</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "const input = document.querySelector('#api-token');",
        "const status = document.querySelector('#status');",
        "let lastPasteLength = 0;",
        "input.addEventListener('paste', (event) => {",
        "  lastPasteLength = (event.clipboardData && event.clipboardData.getData('text/plain') || '').length;",
        "  status.textContent = lastPasteLength > 0 ? 'Paste event captured' : 'Paste event missing data';",
        "});",
        "document.querySelector('[data-testid=\"save-token\"]').addEventListener('click', () => {",
        "  status.textContent = input.value.length === lastPasteLength && lastPasteLength > 0 ? 'Saved pasted token from clipboard event' : 'Clipboard paste mismatch';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const pasteText = "taught-token-42";
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
      await page.evaluate((value) => navigator.clipboard.writeText(value), pasteText);
      await page.getByLabel("API token").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.getByText("Paste event captured").waitFor();
      await page.getByRole("button", { name: "Save pasted token" }).click();
      await page.getByText("Saved pasted token from clipboard event").waitFor();
    },
  },
  {
    id: "clipboard-paste-contenteditable",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [
      "Rich paste event captured",
    ],
    expectedReplayCode: [
      "async function pasteText(page, target, text)",
      "process.env[\"RELEASE_NOTES_PASTE\"]",
      "await pasteText(page, target1, pasteText1);",
      "await expect(target1).toContainText(pasteText1);",
    ],
    liveReplayMode: "sameSession",
    replayParameters: { release_notes_paste: "agent rich clipboard note" },
    replayEnv: () => ({ RELEASE_NOTES_PASTE: "agent rich clipboard note" }),
    files: () => commonFiles({
      title: "Clipboard Paste Contenteditable Workflow",
      body: [
        "    <main>",
        "      <h1>Clipboard Paste Contenteditable Workflow</h1>",
        "      <div contenteditable=\"true\" role=\"textbox\" aria-label=\"Release notes\" data-testid=\"release-notes\" data-synthi-source-id=\"clipboard.notes\"></div>",
        "      <button type=\"button\" data-testid=\"save-notes\" data-synthi-source-id=\"clipboard.notes.save\">Save notes</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[contenteditable='true'] { min-height: 96px; border: 1px solid #222; background: #fff; padding: 12px; }",
      ],
      script: [
        "const notes = document.querySelector('[data-testid=\"release-notes\"]');",
        "const status = document.querySelector('#status');",
        "let lastPasteLength = 0;",
        "notes.addEventListener('paste', (event) => {",
        "  lastPasteLength = (event.clipboardData && event.clipboardData.getData('text/plain') || '').length;",
        "  status.textContent = lastPasteLength > 0 ? 'Rich paste event captured' : 'Rich paste event missing data';",
        "});",
        "document.querySelector('[data-testid=\"save-notes\"]').addEventListener('click', () => {",
        "  status.textContent = notes.textContent.trim().length === lastPasteLength && lastPasteLength > 0 ? 'Saved rich clipboard note' : 'Rich clipboard paste mismatch';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const pasteText = "taught release note";
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
      await page.evaluate((value) => navigator.clipboard.writeText(value), pasteText);
      await page.getByRole("textbox", { name: "Release notes" }).click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.getByText("Rich paste event captured").waitFor();
      await page.getByRole("button", { name: "Save notes" }).click();
      await page.getByText("Saved rich clipboard note").waitFor();
    },
  },
  {
    id: "clipboard-drop-textarea",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Dropped release note from text drop",
    ],
    expectedReplayCode: [
      "async function dropText(target, text)",
      "process.env[\"RELEASE_NOTES_DROP\"]",
      "await dropText(target1, dropText1);",
      "await expect(target1).toHaveValue(dropText1);",
    ],
    forbiddenReplayCode: [
      "taught dropped note",
      "target2.fill",
    ],
    liveReplayMode: "sameSession",
    replayParameters: { release_notes_drop: "agent dropped note" },
    replayEnv: () => ({ RELEASE_NOTES_DROP: "agent dropped note" }),
    files: () => commonFiles({
      title: "Clipboard Drop Textarea Workflow",
      body: [
        "    <main>",
        "      <h1>Clipboard Drop Textarea Workflow</h1>",
        "      <label for=\"release-notes\">Release notes</label>",
        "      <textarea id=\"release-notes\" aria-label=\"Release notes\" data-testid=\"release-notes\" data-synthi-source-id=\"drop.notes\"></textarea>",
        "      <button type=\"button\" data-testid=\"save-notes\" data-synthi-source-id=\"drop.notes.save\">Save dropped note</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "textarea { min-height: 112px; width: min(560px, calc(100vw - 48px)); border: 1px solid #222; background: #fff; padding: 12px; }",
        "textarea:focus { outline: 2px solid #202020; outline-offset: 3px; }",
      ],
      script: [
        "const notes = document.querySelector('[data-testid=\"release-notes\"]');",
        "const status = document.querySelector('#status');",
        "notes.addEventListener('dragover', (event) => event.preventDefault());",
        "notes.addEventListener('drop', (event) => {",
        "  event.preventDefault();",
        "  const text = event.dataTransfer.getData('text/plain');",
        "  notes.value = text;",
        "  notes.dispatchEvent(new Event('input', { bubbles: true }));",
        "  status.textContent = text ? 'Dropped release note from text drop' : 'Missing dropped text';",
        "});",
        "document.querySelector('[data-testid=\"save-notes\"]').addEventListener('click', () => {",
        "  status.textContent = notes.value.trim() ? 'Saved dropped note' : 'No dropped note to save';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const droppedText = "taught dropped note";
      const dataTransfer = await page.evaluateHandle((value) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", value);
        return transfer;
      }, droppedText);
      try {
        const notes = page.getByTestId("release-notes");
        await notes.dispatchEvent("dragenter", { dataTransfer });
        await notes.dispatchEvent("dragover", { dataTransfer });
        await notes.dispatchEvent("drop", { dataTransfer });
        await page.getByText("Dropped release note from text drop").waitFor();
        await page.getByRole("button", { name: "Save dropped note" }).click();
        await page.getByText("Saved dropped note").waitFor();
      } finally {
        await dataTransfer.dispose().catch(() => undefined);
      }
    },
  },
  {
    id: "clipboard-copy-cut-textarea",
    minSteps: 2,
    expectedActions: ["copy", "cut"],
    expectedReplayText: [
      "Copied 5 characters",
      "Cut 4 characters",
      "Value alpha gamma",
    ],
    expectedReplayCode: [
      "element.setSelectionRange(selection.start, selection.end, direction);",
      "process.platform === 'darwin' ? \"Meta+C\" : \"Control+C\"",
      "process.platform === 'darwin' ? \"Meta+X\" : \"Control+X\"",
    ],
    forbiddenReplayCode: [
      "beta",
      "alpha beta gamma",
    ],
    files: () => commonFiles({
      title: "Clipboard Copy Cut Textarea Workflow",
      body: [
        "    <main>",
        "      <h1>Clipboard Copy Cut Textarea Workflow</h1>",
        "      <label for=\"release-notes\">Release notes</label>",
        "      <textarea id=\"release-notes\" aria-label=\"Release notes\" data-testid=\"release-notes\" data-synthi-source-id=\"clipboard.copycut\">alpha beta gamma</textarea>",
        "      <output id=\"value\" aria-live=\"polite\">Value alpha beta gamma</output>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "textarea { min-height: 112px; width: min(560px, calc(100vw - 48px)); border: 1px solid #222; background: #fff; padding: 12px; }",
        "textarea:focus { outline: 2px solid #202020; outline-offset: 3px; }",
      ],
      script: [
        "const notes = document.querySelector('[data-testid=\"release-notes\"]');",
        "const status = document.querySelector('#status');",
        "const value = document.querySelector('#value');",
        "function selectedLength() { return Math.max(0, Number(notes.selectionEnd || 0) - Number(notes.selectionStart || 0)); }",
        "function renderValue() { value.textContent = `Value ${notes.value}`; }",
        "notes.addEventListener('copy', () => {",
        "  status.textContent = `Copied ${selectedLength()} characters`;",
        "});",
        "notes.addEventListener('cut', () => {",
        "  status.textContent = `Cut ${selectedLength()} characters`;",
        "  setTimeout(renderValue, 0);",
        "});",
        "notes.addEventListener('input', renderValue);",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const notes = page.getByTestId("release-notes");
      await notes.focus();
      await notes.evaluate((element) => element.setSelectionRange(0, 5));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
      await page.getByText("Copied 5 characters").waitFor();
      await notes.evaluate((element) => element.setSelectionRange(6, 10));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+X" : "Control+X");
      await page.getByText("Cut 4 characters").waitFor();
      await page.getByText("Value alpha  gamma").waitFor();
    },
  },
  {
    id: "iframe-form",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "page.frameLocator(\"iframe[data-testid=\\\"checkout-frame\\\"]\")",
      "Mutation boundary:",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ CARDHOLDER: "Ada Lovelace" }),
    files: () => commonFiles({
      title: "Iframe Form Workflow",
      body: [
        "    <main>",
        "      <h1>Iframe Form Workflow</h1>",
        "      <iframe data-testid=\"checkout-frame\" title=\"Checkout form\" name=\"checkout\" src=\"/frame.html\"></iframe>",
        "    </main>",
      ].join("\n"),
      styles: [
        "iframe { width: min(620px, calc(100vw - 48px)); height: 280px; border: 1px solid #b9b9b2; background: white; }",
      ],
      script: "",
      extraFiles: [
        {
          path: "frame.html",
          encoding: "utf8",
          content: [
            "<!doctype html>",
            "<html>",
            "  <head>",
            "    <meta charset=\"UTF-8\">",
            "    <title>Checkout Frame</title>",
            "    <link rel=\"stylesheet\" href=\"/styles.css\">",
            "  </head>",
            "  <body>",
            "    <main>",
            "      <h1>Checkout Frame</h1>",
            "      <label for=\"cardholder\">Cardholder</label>",
            "      <input id=\"cardholder\" aria-label=\"Cardholder\" data-synthi-source-id=\"iframe.cardholder\" placeholder=\"Name on card\">",
            "      <button type=\"button\" data-testid=\"save-cardholder\" data-synthi-source-id=\"iframe.save\">Save cardholder</button>",
            "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
            "    </main>",
            "    <script type=\"module\" src=\"/frame.js\"></script>",
            "  </body>",
            "</html>",
            "",
          ].join("\n"),
        },
        {
          path: "frame.js",
          encoding: "utf8",
          content: [
            "document.querySelector('[data-testid=\"save-cardholder\"]').addEventListener('click', () => {",
            "  const value = document.querySelector('#cardholder').value;",
            "  document.querySelector('#status').textContent = `Saved ${value}`;",
            "});",
            "",
          ].join("\n"),
        },
      ],
    }),
    teach: async (page) => {
      const frame = page.frameLocator('iframe[data-testid="checkout-frame"]');
      await frame.getByLabel("Cardholder").fill("Ada Lovelace");
      await frame.getByRole("button", { name: "Save cardholder" }).click();
      await frame.getByText("Saved Ada Lovelace").waitFor();
    },
  },
  {
    id: "nested-iframe-form",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [
      "Nested preview",
    ],
    expectedReplayCode: [
      "page.frameLocator(\"iframe[data-testid=\\\"outer-frame\\\"]\").frameLocator(\"iframe[data-testid=\\\"inner-frame\\\"]\")",
      "getByLabel(\"Cardholder\")",
      "getByRole(\"button\", { name: \"Preview nested cardholder\" })",
    ],
    forbiddenReplayCode: [
      "page.frameLocator(\"iframe[data-testid=\\\"inner-frame\\\"]\").getByLabel",
      "Mutation boundary:",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ CARDHOLDER: "Ada Nested" }),
    files: () => [
      ...commonFiles({
        title: "Nested Iframe Workflow",
        body: [
          "    <main>",
          "      <h1>Nested Iframe Workflow</h1>",
          "      <iframe data-testid=\"outer-frame\" title=\"Outer workflow frame\" src=\"/outer.html\"></iframe>",
          "    </main>",
        ].join("\n"),
        script: "",
        styles: [
          "iframe { width: min(640px, calc(100vw - 48px)); height: 320px; border: 1px solid #b9b9b2; background: white; }",
        ],
      }),
      {
        path: "outer.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Outer Workflow Frame</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Outer Workflow Frame</h1>",
          "      <iframe data-testid=\"inner-frame\" title=\"Inner workflow frame\" src=\"/inner.html\"></iframe>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "inner.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Inner Workflow Frame</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Inner Workflow Frame</h1>",
          "      <label for=\"cardholder\">Cardholder</label>",
          "      <input id=\"cardholder\" aria-label=\"Cardholder\" data-synthi-source-id=\"nested.cardholder\" placeholder=\"Name on card\">",
          "      <button type=\"button\" data-testid=\"preview-nested-cardholder\" data-synthi-source-id=\"nested.preview\">Preview nested cardholder</button>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
          "    <script type=\"module\" src=\"/inner.js\"></script>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "inner.js",
        encoding: "utf8",
        content: [
          "const cardholder = document.querySelector('#cardholder');",
          "document.querySelector('[data-testid=\"preview-nested-cardholder\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = `Nested preview for ${cardholder.value}`;",
          "});",
          "",
        ].join("\n"),
      },
    ],
    teach: async (page) => {
      const frame = page
        .frameLocator('iframe[data-testid="outer-frame"]')
        .frameLocator('iframe[data-testid="inner-frame"]');
      await frame.getByLabel("Cardholder").fill("Ada Nested");
      await frame.getByRole("button", { name: "Preview nested cardholder" }).click();
      await frame.getByText("Nested preview for Ada Nested").waitFor();
    },
  },
  {
    id: "cross-origin-iframe-denied",
    minSteps: 0,
    expectedRecordingIssue: "frame_origin_consent_required",
    setup: async ({ addCleanup }) => {
      const auxiliary = await startAuxiliaryOriginServer({
        "/external-frame.html": [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>External Frame</title>",
          "    <style>",
          "      body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; color: #171717; background: #f7f7f4; }",
          "      main { display: grid; gap: 12px; }",
          "      input { height: 40px; border: 1px solid #9c9c92; padding: 0 12px; font: inherit; }",
          "      output { min-height: 24px; color: #17663a; font-weight: 700; }",
          "    </style>",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>External Checkout Frame</h1>",
          "      <label for=\"cardholder\">Cardholder</label>",
          "      <input id=\"cardholder\" aria-label=\"Cardholder\" placeholder=\"Name on card\">",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
          "    <script>",
          "      const input = document.querySelector('#cardholder');",
          "      const status = document.querySelector('#status');",
          "      input.addEventListener('input', () => { status.textContent = `Captured ${input.value}`; });",
          "    </script>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      });
      addCleanup(auxiliary.close);
      return { externalOrigin: auxiliary.origin };
    },
    files: ({ externalOrigin }) => commonFiles({
      title: "Cross-Origin Iframe Denied Workflow",
      body: [
        "    <main>",
        "      <h1>Cross-Origin Iframe Denied Workflow</h1>",
        `      <iframe data-testid="external-frame" title="External checkout" src="${externalOrigin}/external-frame.html"></iframe>`,
        "    </main>",
      ].join("\n"),
      styles: [
        "iframe { width: min(620px, calc(100vw - 48px)); height: 300px; border: 1px solid #b9b9b2; background: white; }",
      ],
      script: "",
    }),
    teach: async (page) => {
      const frame = page.frameLocator('iframe[data-testid="external-frame"]');
      await frame.getByLabel("Cardholder").fill("Ada Lovelace");
      await frame.getByText("Captured Ada Lovelace").waitFor();
    },
  },
  {
    id: "open-shadow-form",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayCode: [
      "[data-testid=\\\"billing-profile\\\"] [data-testid=\\\"display-name\\\"]",
      "[data-testid=\\\"billing-profile\\\"] [data-testid=\\\"save-profile\\\"]",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ DISPLAY_NAME: "Shadow Grace" }),
    files: () => commonFiles({
      title: "Open Shadow Form Workflow",
      body: [
        "    <main>",
        "      <h1>Open Shadow Form Workflow</h1>",
        "      <profile-card data-testid=\"shipping-profile\" data-label=\"Shipping\"></profile-card>",
        "      <profile-card data-testid=\"billing-profile\" data-label=\"Billing\"></profile-card>",
        "    </main>",
      ].join("\n"),
      script: [
        "class ProfileCard extends HTMLElement {",
        "  connectedCallback() {",
        "    if (this.shadowRoot) return;",
        "    const root = this.attachShadow({ mode: 'open' });",
        "    root.innerHTML = `",
        "      <style>",
        "        :host { display: grid; gap: 12px; width: min(620px, calc(100vw - 48px)); }",
        "        label { display: grid; gap: 8px; font-weight: 700; }",
        "        input { height: 42px; border: 1px solid #9c9c92; padding: 0 12px; font: inherit; }",
        "        button { width: max-content; height: 42px; border: 0; background: #202020; color: white; padding: 0 16px; font: inherit; cursor: pointer; }",
        "        output { min-height: 24px; color: #17663a; font-weight: 700; }",
        "      </style>",
        "      <label>Display name",
        "        <input aria-label=\"Display name\" data-testid=\"display-name\" data-synthi-source-id=\"shadow.displayName\">",
        "      </label>",
        "      <button type=\"button\" data-testid=\"save-profile\" data-synthi-source-id=\"shadow.saveProfile\">Save profile</button>",
        "      <output aria-live=\"polite\">Waiting</output>",
        "    `;",
        "    const label = this.getAttribute('data-label') || 'Profile';",
        "    const input = root.querySelector('input');",
        "    const output = root.querySelector('output');",
        "    root.querySelector('button').addEventListener('click', () => {",
        "      output.textContent = `${label} saved ${input.value}`;",
        "    });",
        "  }",
        "}",
        "customElements.define('profile-card', ProfileCard);",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const card = page.getByTestId("billing-profile");
      await card.getByTestId("display-name").fill("Shadow Ada");
      await card.getByTestId("save-profile").click();
      await card.getByText("Billing saved Shadow Ada").waitFor();
    },
  },
  {
    id: "settings-controls",
    minSteps: 4,
    expectedActions: ["check", "uncheck", "select", "click"],
    replayEnv: () => ({ THEME: "dark" }),
    files: () => commonFiles({
      title: "Settings Controls Workflow",
      body: [
        "    <main>",
        "      <h1>Settings Controls Workflow</h1>",
        "      <label class=\"row\"><input id=\"notify\" type=\"checkbox\" data-synthi-source-id=\"settings.notify\"> Enable notifications</label>",
        "      <label class=\"row\"><input id=\"beta\" type=\"checkbox\" checked data-synthi-source-id=\"settings.beta\"> Beta access</label>",
        "      <label for=\"theme\">Theme</label>",
        "      <select id=\"theme\" aria-label=\"Theme\" data-synthi-source-id=\"settings.theme\">",
        "        <option value=\"light\">Light</option>",
        "        <option value=\"dark\">Dark</option>",
        "      </select>",
        "      <button type=\"button\" data-testid=\"apply-settings\" data-synthi-source-id=\"settings.apply\">Apply settings</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "document.querySelector('[data-testid=\"apply-settings\"]').addEventListener('click', () => {",
        "  const notify = document.querySelector('#notify').checked ? 'enabled' : 'disabled';",
        "  const beta = document.querySelector('#beta').checked ? 'beta on' : 'beta off';",
        "  const theme = document.querySelector('#theme').value;",
        "  document.querySelector('#status').textContent = `Applied ${theme} with notifications ${notify} and ${beta}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Enable notifications").check();
      await page.getByLabel("Beta access").uncheck();
      await page.getByLabel("Theme").selectOption("dark");
      await page.getByRole("button", { name: "Apply settings" }).click();
      await page.getByText("Applied dark with notifications enabled and beta off").waitFor();
    },
  },
  {
    id: "multi-select-controls",
    minSteps: 4,
    expectedActions: ["select", "check", "click"],
    expectedReplayText: [
      "parameterizedTextRegex([\"Priority \",\"\"], optionValue3)",
    ],
    expectedReplayCode: [
      "const selectValues1 = readRequiredEnvList(\"TEAMS\"",
      "await target1.selectOption(selectValues1);",
      "await expect(target1).toHaveValues(selectValues1);",
      "const optionValue3 = readRequiredEnv(\"PRIORITY\"",
      "page.getByRole(\"listbox\", { name: \"Priority\" })",
      "ariaOptionByValue(listbox3, optionValue3)",
      "toHaveAttribute('aria-selected', \"true\")",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({
      TEAMS: JSON.stringify(["qa", "design"]),
      PRIORITY: "low",
    }),
    files: () => commonFiles({
      title: "Multi Select Controls Workflow",
      body: [
        "    <main>",
        "      <h1>Multi Select Controls Workflow</h1>",
        "      <label for=\"teams\">Teams</label>",
        "      <select id=\"teams\" aria-label=\"Teams\" multiple size=\"4\" data-synthi-source-id=\"multi.teams\">",
        "        <option value=\"qa\">QA</option>",
        "        <option value=\"design\">Design</option>",
        "        <option value=\"support\">Support</option>",
        "        <option value=\"ops\">Ops</option>",
        "      </select>",
        "      <fieldset>",
        "        <legend>Channel</legend>",
        "        <label><input type=\"radio\" name=\"channel\" value=\"email\" data-synthi-source-id=\"multi.channel.email\"> Email</label>",
        "        <label><input type=\"radio\" name=\"channel\" value=\"slack\" data-synthi-source-id=\"multi.channel.slack\"> Slack</label>",
        "      </fieldset>",
        "      <div role=\"listbox\" aria-label=\"Priority\" class=\"listbox\">",
        "        <div role=\"option\" tabindex=\"0\" aria-selected=\"false\" data-priority=\"low\" data-synthi-source-id=\"multi.priority.low\">Low priority</div>",
        "        <div role=\"option\" tabindex=\"0\" aria-selected=\"false\" data-priority=\"high\" data-synthi-source-id=\"multi.priority.high\">High priority</div>",
        "      </div>",
        "      <button type=\"button\" data-testid=\"apply-routing\" data-synthi-source-id=\"multi.apply\">Apply routing</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "select { width: min(420px, calc(100vw - 48px)); min-height: 118px; }",
        "fieldset { border: 1px solid #b9b9b2; width: min(420px, calc(100vw - 48px)); }",
        ".listbox { width: min(420px, calc(100vw - 48px)); border: 1px solid #b9b9b2; background: #fff; display: grid; gap: 4px; padding: 6px; }",
        "[role='option'] { padding: 8px 10px; cursor: pointer; }",
        "[role='option'][aria-selected='true'] { background: #202020; color: #fff; }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const teams = document.querySelector('#teams');",
        "const options = Array.from(document.querySelectorAll('[role=\"option\"]'));",
        "function selectedTeams() { return Array.from(teams.selectedOptions).map((option) => option.value).join(','); }",
        "teams.addEventListener('change', () => {",
        "  status.textContent = `Teams ${selectedTeams()}`;",
        "});",
        "for (const input of document.querySelectorAll('input[name=\"channel\"]')) {",
        "  input.addEventListener('change', () => { status.textContent = `Channel ${input.value}`; });",
        "}",
        "for (const option of options) {",
        "  option.addEventListener('click', () => {",
        "    for (const other of options) other.setAttribute('aria-selected', 'false');",
        "    option.setAttribute('aria-selected', 'true');",
        "    status.textContent = `Priority ${option.dataset.priority}`;",
        "  });",
        "}",
        "document.querySelector('[data-testid=\"apply-routing\"]').addEventListener('click', () => {",
        "  const channel = document.querySelector('input[name=\"channel\"]:checked')?.value || 'none';",
        "  const priority = document.querySelector('[role=\"option\"][aria-selected=\"true\"]')?.dataset.priority || 'none';",
        "  status.textContent = `Applied ${selectedTeams()} via ${channel} at ${priority}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Teams").selectOption(["qa", "design"]);
      await page.getByText("Teams qa,design").waitFor();
      await page.getByLabel("Email").check();
      await page.locator("#status").getByText("Channel email", { exact: true }).waitFor();
      await page.getByRole("option", { name: "High priority" }).click();
      await page.locator("#status").getByText("Priority high", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Apply routing" }).click();
      await page.locator("#status").getByText("Applied qa,design via email at high", { exact: true }).waitFor();
    },
  },
  {
    id: "custom-aria-widgets",
    minSteps: 3,
    expectedActions: ["click"],
    expectedReplayText: [
      "Alerts enabled",
      "Panel refreshed",
      "Pipeline node selected",
    ],
    expectedReplayCode: [
      "page.locator(\"[data-synthi-source-id=\\\"custom.alertSwitch\\\"]\")",
      "page.locator(\"[data-synthi-source-id=\\\"custom.refreshPanel\\\"]\")",
      "page.locator(\"[data-synthi-source-id=\\\"custom.pipelineNode\\\"]\")",
      "await expect(target1).toHaveAttribute(\"aria-checked\", \"true\");",
      "await expect(target3).toHaveAttribute(\"aria-selected\", \"true\");",
    ],
    liveReplayMode: "sameSession",
    files: () => commonFiles({
      title: "Custom ARIA Widgets Workflow",
      body: [
        "    <main class=\"widget-shell\">",
        "      <h1>Custom ARIA Widgets Workflow</h1>",
        "      <div role=\"switch\" tabindex=\"0\" aria-label=\"Alert routing\" aria-checked=\"false\" data-synthi-source-id=\"custom.alertSwitch\">Alert routing</div>",
        "      <div tabindex=\"0\" aria-label=\"Refresh panel\" data-synthi-source-id=\"custom.refreshPanel\">Refresh</div>",
        "      <div role=\"tree\" aria-label=\"Pipeline tree\">",
        "        <div role=\"treeitem\" tabindex=\"0\" aria-selected=\"false\" data-synthi-source-id=\"custom.pipelineNode\">Pipeline node</div>",
        "      </div>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".widget-shell { width: min(620px, calc(100vw - 48px)); }",
        "[role='switch'], [role='treeitem'], [data-synthi-source-id='custom.refreshPanel'] { width: max-content; border: 1px solid #202020; background: #fff; padding: 10px 12px; cursor: pointer; user-select: none; }",
        "[aria-checked='true'], [aria-selected='true'] { background: #202020; color: #fff; }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const alertSwitch = document.querySelector('[data-synthi-source-id=\"custom.alertSwitch\"]');",
        "const refresh = document.querySelector('[data-synthi-source-id=\"custom.refreshPanel\"]');",
        "const node = document.querySelector('[data-synthi-source-id=\"custom.pipelineNode\"]');",
        "alertSwitch.addEventListener('click', () => {",
        "  const next = alertSwitch.getAttribute('aria-checked') !== 'true';",
        "  alertSwitch.setAttribute('aria-checked', String(next));",
        "  status.textContent = next ? 'Alerts enabled' : 'Alerts disabled';",
        "});",
        "refresh.addEventListener('click', () => {",
        "  refresh.setAttribute('aria-pressed', 'true');",
        "  status.textContent = 'Panel refreshed';",
        "});",
        "node.addEventListener('click', () => {",
        "  node.setAttribute('aria-selected', 'true');",
        "  status.textContent = 'Pipeline node selected';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.locator('[data-synthi-source-id="custom.alertSwitch"]').click();
      await page.getByText("Alerts enabled").waitFor();
      await page.locator('[data-synthi-source-id="custom.refreshPanel"]').click();
      await page.getByText("Panel refreshed").waitFor();
      await page.locator('[data-synthi-source-id="custom.pipelineNode"]').click();
      await page.getByText("Pipeline node selected").waitFor();
    },
  },
  {
    id: "modifier-range-selection",
    minSteps: 2,
    expectedActions: ["click"],
    expectedReplayText: [
      "Selected 3 invoices",
    ],
    expectedReplayCode: [
      "await target2.click({ modifiers: [\"Shift\"] });",
    ],
    replayEnv: () => ({ INVOICE_QUEUE: "Invoice A", INVOICE_QUEUE_2: "Invoice C" }),
    files: () => commonFiles({
      title: "Modifier Range Selection Workflow",
      body: [
        "    <main>",
        "      <h1>Modifier Range Selection Workflow</h1>",
        "      <section role=\"listbox\" aria-label=\"Invoice queue\" aria-multiselectable=\"true\">",
        "        <button type=\"button\" role=\"option\" aria-selected=\"false\" data-testid=\"invoice-a\" data-synthi-source-id=\"invoice.a\">Invoice A</button>",
        "        <button type=\"button\" role=\"option\" aria-selected=\"false\" data-testid=\"invoice-b\" data-synthi-source-id=\"invoice.b\">Invoice B</button>",
        "        <button type=\"button\" role=\"option\" aria-selected=\"false\" data-testid=\"invoice-c\" data-synthi-source-id=\"invoice.c\">Invoice C</button>",
        "      </section>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[role='listbox'] { display: grid; gap: 8px; align-items: start; }",
        "[role='option'] { border: 1px solid #222; background: #fff; color: #171717; }",
        "[role='option'][aria-selected='true'] { background: #17663a; color: #fff; }",
      ],
      script: [
        "const options = Array.from(document.querySelectorAll('[role=\"option\"]'));",
        "const status = document.querySelector('#status');",
        "let anchor = -1;",
        "function render() {",
        "  const selected = options.filter((option) => option.getAttribute('aria-selected') === 'true').length;",
        "  status.textContent = selected ? `Selected ${selected} invoices` : 'Waiting';",
        "}",
        "options.forEach((option, index) => {",
        "  option.addEventListener('click', (event) => {",
        "    if (event.shiftKey && anchor >= 0) {",
        "      const start = Math.min(anchor, index);",
        "      const end = Math.max(anchor, index);",
        "      options.forEach((candidate, candidateIndex) => candidate.setAttribute('aria-selected', String(candidateIndex >= start && candidateIndex <= end)));",
        "    } else {",
        "      anchor = index;",
        "      options.forEach((candidate, candidateIndex) => candidate.setAttribute('aria-selected', String(candidateIndex === index)));",
        "    }",
        "    render();",
        "  });",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("option", { name: "Invoice A" }).click();
      await page.getByText("Selected 1 invoices").waitFor();
      await page.getByRole("option", { name: "Invoice C" }).click({ modifiers: ["Shift"] });
      await page.getByText("Selected 3 invoices").waitFor();
    },
  },
  {
    id: "range-slider",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "const inputValue1 = readRequiredEnv(\"BUDGET\"",
      "element.dispatchEvent(new Event('input', { bubbles: true }));",
      "element.dispatchEvent(new Event('change', { bubbles: true }));",
      "await expect(target1).toHaveValue(inputValue1);",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ BUDGET: "75" }),
    files: () => commonFiles({
      title: "Range Slider Workflow",
      body: [
        "    <main>",
        "      <h1>Range Slider Workflow</h1>",
        "      <label for=\"budget\">Budget</label>",
        "      <input id=\"budget\" aria-label=\"Budget\" type=\"range\" min=\"0\" max=\"100\" step=\"5\" value=\"25\" data-synthi-source-id=\"range.budget\">",
        "      <output id=\"budget-value\" aria-live=\"polite\">Budget 25</output>",
        "      <button type=\"button\" data-testid=\"apply-budget\" data-synthi-source-id=\"range.apply\">Apply budget</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "input[type='range'] { width: min(520px, calc(100vw - 48px)); padding: 0; }",
      ],
      script: [
        "const budget = document.querySelector('#budget');",
        "const budgetValue = document.querySelector('#budget-value');",
        "function syncBudget() { budgetValue.textContent = `Budget ${budget.value}`; }",
        "budget.addEventListener('input', syncBudget);",
        "budget.addEventListener('change', syncBudget);",
        "document.querySelector('[data-testid=\"apply-budget\"]').addEventListener('click', () => {",
        "  document.querySelector('#status').textContent = `Applied budget ${budget.value}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Budget").evaluate((element) => {
        const input = element;
        input.value = "75";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.getByText("Budget 75").waitFor();
      await page.getByRole("button", { name: "Apply budget" }).click();
      await page.getByText("Applied budget 75").waitFor();
    },
  },
  {
    id: "custom-aria-slider",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Risk 75",
      "Viewport risk 75",
    ],
    expectedReplayCode: [
      "page.mouse.down()",
      "page.mouse.up()",
      "pointer drag target not visible",
    ],
    liveReplayMode: "sameSession",
    files: () => commonFiles({
      title: "Custom ARIA Slider Workflow",
      body: [
        "    <main>",
        "      <h1>Custom ARIA Slider Workflow</h1>",
        "      <section class=\"slider-shell\" aria-label=\"Risk controls\">",
        "        <div class=\"slider-track\" data-testid=\"risk-track\" data-synthi-source-id=\"ariaSlider.track\">",
        "          <div role=\"slider\" tabindex=\"0\" aria-label=\"Risk threshold\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"25\" aria-valuetext=\"Risk 25\" class=\"slider-thumb\" data-synthi-source-id=\"ariaSlider.thumb\"></div>",
        "        </div>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"inspect-risk\" data-synthi-source-id=\"ariaSlider.inspect\">Inspect risk</button>",
        "      <output id=\"status\" aria-live=\"polite\">Risk 25</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".slider-shell { width: min(560px, calc(100vw - 48px)); display: grid; gap: 12px; }",
        ".slider-track { position: relative; height: 44px; border: 1px solid #222; background: linear-gradient(90deg, #d9e8df 0 25%, #f7f7f4 25%); }",
        ".slider-thumb { position: absolute; left: calc(25% - 14px); top: 7px; width: 28px; height: 28px; border-radius: 50%; background: #202020; cursor: grab; }",
        ".slider-thumb:focus { outline: 2px solid #17663a; outline-offset: 3px; }",
      ],
      script: [
        "const track = document.querySelector('[data-testid=\"risk-track\"]');",
        "const thumb = document.querySelector('[role=\"slider\"]');",
        "const status = document.querySelector('#status');",
        "let dragging = false;",
        "let value = 25;",
        "function update(next) {",
        "  value = Math.max(0, Math.min(100, Math.round(next / 5) * 5));",
        "  thumb.setAttribute('aria-valuenow', String(value));",
        "  thumb.setAttribute('aria-valuetext', `Risk ${value}`);",
        "  thumb.style.left = `calc(${value}% - 14px)`;",
        "  track.style.background = `linear-gradient(90deg, #d9e8df 0 ${value}%, #f7f7f4 ${value}%)`;",
        "  status.textContent = `Risk ${value}`;",
        "}",
        "function valueFromClientX(clientX) {",
        "  const rect = track.getBoundingClientRect();",
        "  return ((clientX - rect.left) / Math.max(1, rect.width)) * 100;",
        "}",
        "thumb.addEventListener('pointerdown', (event) => {",
        "  dragging = true;",
        "  thumb.setPointerCapture(event.pointerId);",
        "});",
        "thumb.addEventListener('pointermove', (event) => {",
        "  if (!dragging) return;",
        "  update(valueFromClientX(event.clientX));",
        "});",
        "thumb.addEventListener('pointerup', () => { dragging = false; });",
        "document.querySelector('[data-testid=\"inspect-risk\"]').addEventListener('click', () => {",
        "  status.textContent = `Viewport risk ${value}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const track = page.getByTestId("risk-track");
      const thumb = page.getByRole("slider", { name: "Risk threshold" });
      const trackBox = await track.boundingBox();
      const thumbBox = await thumb.boundingBox();
      if (!trackBox || !thumbBox) throw new Error("custom slider target not visible");
      await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(trackBox.x + trackBox.width * 0.75, trackBox.y + trackBox.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.getByText("Risk 75").waitFor();
      await page.getByRole("button", { name: "Inspect risk" }).click();
      await page.getByText("Viewport risk 75").waitFor();
    },
  },
  {
    id: "pointer-sortable",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Moved Priority audit to Done lane",
    ],
    expectedReplayCode: [
      "await page.mouse.down();",
      "await page.mouse.up();",
    ],
    liveReplayMode: "sameSession",
    files: () => commonFiles({
      title: "Pointer Sortable Workflow",
      body: [
        "    <main>",
        "      <h1>Pointer Sortable Workflow</h1>",
        "      <section class=\"board\" aria-label=\"Workflow board\">",
        "        <div class=\"lane\" data-drop-target=\"todo\" data-testid=\"lane-todo\" role=\"list\" aria-label=\"Todo lane\">",
        "          <h2>Todo</h2>",
        "          <div class=\"card\" role=\"option\" tabindex=\"0\" data-draggable=\"true\" data-testid=\"card-priority\" data-synthi-source-id=\"pointer.card.priority\">Priority audit</div>",
        "        </div>",
        "        <div class=\"lane\" data-drop-target=\"done\" data-testid=\"lane-done\" role=\"list\" aria-label=\"Done lane\">",
        "          <h2>Done</h2>",
        "        </div>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"apply-board\" data-synthi-source-id=\"pointer.apply\">Apply board</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".board { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 14px; width: min(720px, calc(100vw - 48px)); }",
        ".lane { min-height: 168px; border: 1px solid #b9b9b2; background: #fff; padding: 12px; display: grid; align-content: start; gap: 10px; }",
        ".lane h2 { margin: 0; font-size: 18px; }",
        ".card { width: max-content; border: 1px solid #202020; background: #f1f1ed; padding: 10px 12px; cursor: grab; user-select: none; touch-action: none; }",
        ".card.is-dragging { opacity: 0.72; cursor: grabbing; }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const card = document.querySelector('[data-testid=\"card-priority\"]');",
        "const doneLane = document.querySelector('[data-testid=\"lane-done\"]');",
        "let dragging = null;",
        "card.addEventListener('pointerdown', (event) => {",
        "  if (event.button !== 0) return;",
        "  dragging = card;",
        "  card.classList.add('is-dragging');",
        "});",
        "document.addEventListener('pointerup', (event) => {",
        "  if (!dragging) return;",
        "  const target = document.elementFromPoint(event.clientX, event.clientY);",
        "  const lane = target && target.closest ? target.closest('[data-drop-target]') : null;",
        "  dragging.classList.remove('is-dragging');",
        "  if (lane) {",
        "    lane.appendChild(dragging);",
        "    status.textContent = `Moved ${dragging.textContent.trim()} to ${lane.getAttribute('aria-label')}`;",
        "  }",
        "  dragging = null;",
        "});",
        "document.querySelector('[data-testid=\"apply-board\"]').addEventListener('click', () => {",
        "  const moved = doneLane.contains(card) ? 'done' : 'todo';",
        "  status.textContent = `Applied ${moved}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const card = page.getByTestId("card-priority");
      const done = page.getByTestId("lane-done");
      const cardBox = await card.boundingBox();
      const doneBox = await done.boundingBox();
      if (!cardBox || !doneBox) throw new Error("pointer-sortable target not visible");
      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(doneBox.x + doneBox.width / 2, doneBox.y + Math.min(doneBox.height - 16, 72), { steps: 12 });
      await page.mouse.up();
      await page.getByText("Moved Priority audit to Done lane").waitFor();
      await page.getByRole("button", { name: "Apply board" }).click();
      await page.getByText("Applied done").waitFor();
    },
  },
  {
    id: "splitter-resizer",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Resized left pane to 330px",
    ],
    expectedReplayCode: [
      "page.getByRole(\"separator\", { name: \"Resize panels\" })",
      "await page.mouse.down();",
      "await page.mouse.up();",
    ],
    liveReplayMode: "sameSession",
    files: () => commonFiles({
      title: "Splitter Resize Workflow",
      body: [
        "    <main>",
        "      <h1>Splitter Resize Workflow</h1>",
        "      <section class=\"split-shell\" role=\"group\" aria-label=\"Resizable workspace\" data-synthi-resize-container data-testid=\"resize-shell\" data-synthi-source-id=\"resize.shell\">",
        "        <aside class=\"pane left\" aria-label=\"Navigator pane\"><strong>Navigator</strong><span>Files, search, and review state</span></aside>",
        "        <div class=\"splitter\" role=\"separator\" aria-label=\"Resize panels\" aria-orientation=\"vertical\" tabindex=\"0\" data-synthi-resize-handle data-testid=\"resize-handle\" data-synthi-source-id=\"resize.handle\"></div>",
        "        <section class=\"pane right\" aria-label=\"Editor pane\"><strong>Editor</strong><span>Workspace preview and automation output</span></section>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"apply-split\" data-synthi-source-id=\"resize.apply\">Save workspace layout</button>",
        "      <output id=\"status\" aria-live=\"polite\">Width 240px</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".split-shell { --left-width: 240px; width: min(860px, calc(100vw - 48px)); min-height: 260px; display: grid; grid-template-columns: var(--left-width) 12px minmax(240px, 1fr); border: 1px solid #202020; background: #fff; overflow: hidden; }",
        ".pane { min-width: 0; padding: 18px; display: grid; align-content: start; gap: 8px; }",
        ".left { background: #eef3f1; }",
        ".right { background: #f8f8f5; }",
        ".pane strong { font-size: 20px; }",
        ".pane span { color: #56564f; }",
        ".splitter { cursor: col-resize; touch-action: none; background: #202020; position: relative; }",
        ".splitter::before { content: ''; position: absolute; inset: 0 4px; background: #e7d07f; opacity: .9; }",
        ".splitter.is-dragging { background: #17663a; }",
      ],
      script: [
        "const shell = document.querySelector('[data-testid=\"resize-shell\"]');",
        "const handle = document.querySelector('[data-testid=\"resize-handle\"]');",
        "const status = document.querySelector('#status');",
        "let dragging = false;",
        "let leftWidth = 240;",
        "function clampWidth(value) {",
        "  const max = Math.max(260, shell.clientWidth - 260);",
        "  return Math.max(180, Math.min(max, Math.round(value)));",
        "}",
        "function render(prefix) {",
        "  shell.style.setProperty('--left-width', `${leftWidth}px`);",
        "  status.textContent = `${prefix} ${leftWidth}px`;",
        "}",
        "handle.addEventListener('pointerdown', (event) => {",
        "  if (event.button !== 0) return;",
        "  dragging = true;",
        "  handle.classList.add('is-dragging');",
        "});",
        "document.addEventListener('pointermove', (event) => {",
        "  if (!dragging) return;",
        "  const rect = shell.getBoundingClientRect();",
        "  leftWidth = clampWidth(event.clientX - rect.left);",
        "  render('Resized left pane to');",
        "});",
        "document.addEventListener('pointerup', () => {",
        "  if (!dragging) return;",
        "  dragging = false;",
        "  handle.classList.remove('is-dragging');",
        "  render('Resized left pane to');",
        "});",
        "document.querySelector('[data-testid=\"apply-split\"]').addEventListener('click', () => {",
        "  status.textContent = `Applied split ${leftWidth}px`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const shell = page.getByTestId("resize-shell");
      const handle = page.getByRole("separator", { name: "Resize panels" });
      const shellBox = await shell.boundingBox();
      const handleBox = await handle.boundingBox();
      if (!shellBox || !handleBox) throw new Error("splitter-resizer handle not visible");
      const startX = handleBox.x + handleBox.width / 2;
      const startY = handleBox.y + handleBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(shellBox.x + 330, startY, { steps: 12 });
      await page.getByText("Resized left pane to 330px").waitFor();
      await page.mouse.up();
      await page.getByText("Resized left pane to 330px").waitFor();
      await page.getByRole("button", { name: "Save workspace layout" }).click();
      await page.getByText("Applied split 330px").waitFor();
    },
  },
  {
    id: "animated-saas-dashboard",
    minSteps: 6,
    expectedActions: ["fill", "select", "click", "drag"],
    expectedReplayText: [
      "Moved Revenue audit to Approved lane",
      "Runbook opened",
    ],
    expectedReplayCode: [
      "page.getByTestId(\"global-search\")",
      "page.getByTestId(\"segment-select\")",
      "parameterizedTextRegex([\"Segment \",\"\"], selectValue2)",
      "await page.mouse.down();",
      "page.getByTestId(\"save-runbook\")",
      "element.dispatchEvent(new Event('change', { bubbles: true }));",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({
      SEARCH_ACCOUNTS: "expansion",
      SEGMENT_ALLENTERPRISEGROWTH: "growth",
      RISK_THRESHOLD: "60",
      RUNBOOK_NOTE: "growth renewal",
    }),
    files: () => commonFiles({
      title: "Animated SaaS Dashboard Workflow",
      body: [
        "    <main class=\"dashboard-shell\">",
        "      <section class=\"hero-band\" aria-label=\"Revenue command center\">",
        "        <div>",
        "          <h1>Revenue Command Center</h1>",
        "          <p>Live pipeline with animated signals, queue state, and deployment controls.</p>",
        "        </div>",
        "        <div class=\"ticker\" aria-label=\"Live signal ticker\"><span>ARR +12%</span><span>Churn -3%</span><span>NPS 64</span></div>",
        "      </section>",
        "      <section class=\"toolbar\" aria-label=\"Dashboard filters\">",
        "        <label>Search accounts <input data-testid=\"global-search\" aria-label=\"Search accounts\" data-synthi-source-id=\"saas.search\" autocomplete=\"off\"></label>",
        "        <label>Segment <select aria-label=\"Segment\" data-testid=\"segment-select\" data-synthi-source-id=\"saas.segment\"><option value=\"all\">All</option><option value=\"enterprise\">Enterprise</option><option value=\"growth\">Growth</option></select></label>",
        "        <label for=\"risk\">Risk threshold</label>",
        "        <input id=\"risk\" aria-label=\"Risk threshold\" type=\"range\" min=\"0\" max=\"100\" step=\"10\" value=\"40\" data-synthi-source-id=\"saas.risk\">",
        "      </section>",
        "      <section class=\"metrics\" aria-label=\"Executive metrics\">",
        "        <article class=\"metric pulse\"><strong>$4.8M</strong><span>Expansion pipeline</span></article>",
        "        <article class=\"metric drift\"><strong>37</strong><span>At-risk accounts</span></article>",
        "        <article class=\"metric shimmer\"><strong>14</strong><span>Deploy gates</span></article>",
        "      </section>",
        "      <section class=\"work-area\" aria-label=\"Operations board\">",
        "        <aside class=\"account-list\" aria-label=\"Account list\">",
        "          <button type=\"button\" class=\"account\" data-testid=\"account-northstar\" data-synthi-source-id=\"saas.account.northstar\">Northstar Renewal</button>",
        "          <button type=\"button\" class=\"account\" data-testid=\"account-zenith\" data-synthi-source-id=\"saas.account.zenith\">Zenith Expansion</button>",
        "        </aside>",
        "        <section class=\"lane\" data-drop-target=\"review\" data-testid=\"lane-review\" role=\"list\" aria-label=\"Review lane\"><h2>Review</h2><div class=\"card\" role=\"option\" tabindex=\"0\" data-draggable=\"true\" data-testid=\"card-revenue\" data-synthi-source-id=\"saas.card.revenue\">Revenue audit</div></section>",
        "        <section class=\"lane\" data-drop-target=\"approved\" data-testid=\"lane-approved\" role=\"list\" aria-label=\"Approved lane\"><h2>Approved</h2></section>",
        "      </section>",
        "      <section class=\"runbook\" aria-label=\"Runbook editor\">",
        "        <button type=\"button\" data-testid=\"open-runbook\" data-synthi-source-id=\"saas.runbook.open\">Open runbook</button>",
        "        <div class=\"modal\" role=\"dialog\" aria-label=\"Runbook modal\" hidden>",
        "          <label>Runbook note <textarea aria-label=\"Runbook note\" data-testid=\"runbook-note\" data-synthi-source-id=\"saas.runbook.note\"></textarea></label>",
        "          <button type=\"button\" data-testid=\"save-runbook\" data-synthi-source-id=\"saas.runbook.save\">Save runbook</button>",
        "        </div>",
        "      </section>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "body { place-items: start center; overflow-x: hidden; }",
        ".dashboard-shell { width: min(1080px, calc(100vw - 48px)); display: grid; gap: 18px; padding: 28px 0 48px; }",
        ".hero-band { position: relative; overflow: hidden; min-height: 132px; display: flex; justify-content: space-between; gap: 24px; align-items: center; border: 1px solid #202020; padding: 20px; background: #101820; color: #f7f7f4; }",
        ".hero-band::before { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, rgba(65, 181, 154, .16) 0 2px, transparent 2px 82px); animation: rail 6s linear infinite; pointer-events: none; }",
        ".hero-band > * { position: relative; z-index: 1; }",
        ".ticker { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }",
        ".ticker span { border: 1px solid rgba(255,255,255,.34); padding: 8px 10px; background: rgba(255,255,255,.08); }",
        ".toolbar { display: grid; grid-template-columns: 1.3fr .8fr .45fr 1fr; gap: 12px; align-items: end; }",
        ".toolbar label { display: grid; gap: 6px; font-weight: 700; }",
        ".toolbar input:not([type='range']), .toolbar select, textarea { min-height: 42px; border: 1px solid #9c9c92; padding: 0 12px; font: inherit; background: white; }",
        ".toolbar input[type='range'] { width: 100%; padding: 0; }",
        ".metrics { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 12px; }",
        ".metric { border: 1px solid #b9b9b2; padding: 14px; background: #fff; display: grid; gap: 6px; }",
        ".metric strong { font-size: 28px; line-height: 1; }",
        ".pulse { animation: pulse 1800ms ease-in-out infinite; }",
        ".drift { animation: drift 2400ms ease-in-out infinite; }",
        ".shimmer { background-image: linear-gradient(110deg, #fff 0%, #f1f5f3 45%, #fff 70%); background-size: 220% 100%; animation: shimmer 2300ms linear infinite; }",
        ".work-area { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; align-items: stretch; }",
        ".account-list, .lane, .runbook { border: 1px solid #b9b9b2; background: #fff; padding: 14px; display: grid; align-content: start; gap: 10px; min-height: 182px; }",
        ".account, button { width: max-content; min-height: 42px; border: 0; background: #202020; color: white; padding: 0 14px; font: inherit; cursor: pointer; }",
        ".modal[hidden] { display: none; }",
        ".lane h2 { margin: 0; font-size: 18px; }",
        ".card { width: max-content; border: 1px solid #202020; background: #eef4f0; padding: 10px 12px; cursor: grab; user-select: none; touch-action: none; }",
        ".card.is-dragging { opacity: .7; cursor: grabbing; }",
        ".modal { position: fixed; right: 28px; top: 138px; z-index: 20; border: 1px solid #202020; padding: 12px; display: grid; gap: 10px; background: #f7f7f4; box-shadow: 0 12px 36px rgba(16, 24, 32, .18); }",
        "textarea { min-height: 76px; min-width: min(520px, calc(100vw - 96px)); padding: 10px 12px; }",
        "#status { color: #17663a; font-weight: 800; min-height: 28px; }",
        "@keyframes rail { from { transform: translateX(0); } to { transform: translateX(82px); } }",
        "@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.025); } }",
        "@keyframes drift { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }",
        "@keyframes shimmer { from { background-position: 220% 0; } to { background-position: -220% 0; } }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const search = document.querySelector('[data-testid=\"global-search\"]');",
        "const segment = document.querySelector('[data-testid=\"segment-select\"]');",
        "const risk = document.querySelector('#risk');",
        "const card = document.querySelector('[data-testid=\"card-revenue\"]');",
        "const approved = document.querySelector('[data-testid=\"lane-approved\"]');",
        "let dragging = null;",
        "search.addEventListener('input', () => { status.textContent = `Search ${search.value}`; });",
        "segment.addEventListener('change', () => { status.textContent = `Segment ${segment.value}`; });",
        "risk.addEventListener('input', () => { status.textContent = `Risk threshold ${risk.value}`; });",
        "risk.addEventListener('change', () => { status.textContent = `Risk threshold ${risk.value}`; });",
        "card.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; dragging = card; card.classList.add('is-dragging'); });",
        "document.addEventListener('pointerup', (event) => {",
        "  if (!dragging) return;",
        "  const target = document.elementFromPoint(event.clientX, event.clientY);",
        "  const lane = target && target.closest ? target.closest('[data-drop-target]') : null;",
        "  dragging.classList.remove('is-dragging');",
        "  if (lane) { lane.appendChild(dragging); status.textContent = `Moved ${dragging.textContent.trim()} to ${lane.getAttribute('aria-label')}`; }",
        "  dragging = null;",
        "});",
        "document.querySelector('[data-testid=\"open-runbook\"]').addEventListener('click', () => { document.querySelector('.modal').hidden = false; status.textContent = 'Runbook opened'; });",
        "document.querySelector('[data-testid=\"save-runbook\"]').addEventListener('click', () => {",
        "  const note = document.querySelector('[data-testid=\"runbook-note\"]').value.trim();",
        "  document.querySelector('.modal').hidden = true;",
        "  status.textContent = note ? `Runbook saved for ${note}` : 'Runbook saved';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByTestId("global-search").fill("revenue");
      await page.getByText("Search revenue").waitFor();
      await page.getByLabel("Segment").selectOption("enterprise");
      await page.getByText("Segment enterprise").waitFor();
      await page.getByLabel("Risk threshold").evaluate((element) => {
        const input = element;
        input.value = "80";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.getByText("Risk threshold 80").waitFor();
      const card = page.getByTestId("card-revenue");
      const approvedLane = page.getByTestId("lane-approved");
      const cardBox = await card.boundingBox();
      const laneBox = await approvedLane.boundingBox();
      if (!cardBox || !laneBox) throw new Error("animated saas drag target not visible");
      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(laneBox.x + laneBox.width / 2, laneBox.y + Math.min(laneBox.height - 16, 84), { steps: 16 });
      await page.mouse.up();
      await page.getByText("Moved Revenue audit to Approved lane").waitFor();
      await page.getByTestId("open-runbook").click();
      await page.getByText("Runbook opened").waitFor();
      await page.getByTestId("runbook-note").fill("enterprise revenue");
      await page.getByTestId("save-runbook").click();
      await page.getByText("Runbook saved for enterprise revenue").waitFor();
    },
  },
  {
    id: "file-input-upload",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Uploaded 1 file",
    ],
    expectedReplayCode: [
      "process.env[\"UPLOAD_EVIDENCE_FILE\"]",
      "setInputFiles(filePath",
    ],
    files: () => commonFiles({
      title: "File Input Upload Workflow",
      body: [
        "    <main>",
        "      <h1>File Input Upload Workflow</h1>",
        "      <label for=\"evidence\">Upload evidence</label>",
        "      <input id=\"evidence\" type=\"file\" aria-label=\"Upload evidence\" data-synthi-source-id=\"upload.evidence\">",
        "      <button type=\"button\" data-testid=\"submit-upload\" data-synthi-source-id=\"upload.submit\">Submit upload</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "const input = document.querySelector('#evidence');",
        "const status = document.querySelector('#status');",
        "input.addEventListener('change', () => {",
        "  status.textContent = `Uploaded ${input.files.length} file`;",
        "});",
        "document.querySelector('[data-testid=\"submit-upload\"]').addEventListener('click', () => {",
        "  status.textContent = `Submitted ${input.files.length} file`;",
        "});",
        "",
      ].join("\n"),
    }),
    replayEnv: async ({ caseDir }) => {
      const fixturePath = path.join(caseDir, "upload-evidence.txt");
      await writeFile(fixturePath, "workflow upload fixture\n");
      return { UPLOAD_EVIDENCE_FILE: fixturePath };
    },
    teach: async (page, { caseDir }) => {
      const fixturePath = path.join(caseDir, "upload-evidence.txt");
      await writeFile(fixturePath, "workflow upload fixture\n");
      await page.getByLabel("Upload evidence").setInputFiles(fixturePath);
      await page.getByText("Uploaded 1 file").waitFor();
      await page.getByRole("button", { name: "Submit upload" }).click();
      await page.getByText("Submitted 1 file").waitFor();
    },
  },
  {
    id: "hidden-file-input-upload",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Queued 1 evidence file",
    ],
    expectedReplayCode: [
      "process.env[\"CHOOSE_EVIDENCE_FILE\"]",
      "await expect(target1).toBeAttached();",
      "setInputFiles(filePath",
    ],
    forbiddenReplayCode: [
      "await expect(target1).toBeVisible();",
    ],
    files: () => commonFiles({
      title: "Hidden File Input Upload Workflow",
      body: [
        "    <main>",
        "      <h1>Hidden File Input Upload Workflow</h1>",
        "      <label class=\"upload-proxy\" for=\"hidden-evidence\" data-testid=\"upload-proxy\" data-synthi-source-id=\"hiddenUpload.proxy\">Choose evidence</label>",
        "      <input id=\"hidden-evidence\" class=\"sr-upload\" type=\"file\" aria-label=\"Upload evidence\" data-synthi-source-id=\"hiddenUpload.input\">",
        "      <button type=\"button\" data-testid=\"submit-hidden-upload\" data-synthi-source-id=\"hiddenUpload.submit\">Submit hidden upload</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".upload-proxy { display: inline-grid; place-items: center; width: max-content; min-height: 42px; border: 0; background: #202020; color: white; padding: 0 14px; cursor: pointer; }",
        ".sr-upload { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; clip-path: inset(50%); overflow: hidden; }",
      ],
      script: [
        "const input = document.querySelector('#hidden-evidence');",
        "const status = document.querySelector('#status');",
        "input.addEventListener('change', () => {",
        "  status.textContent = `Queued ${input.files.length} evidence file`;",
        "});",
        "document.querySelector('[data-testid=\"submit-hidden-upload\"]').addEventListener('click', () => {",
        "  status.textContent = `Submitted hidden ${input.files.length} file`;",
        "});",
        "",
      ].join("\n"),
    }),
    replayEnv: async ({ caseDir }) => {
      const fixturePath = path.join(caseDir, "upload-evidence.txt");
      await writeFile(fixturePath, "workflow hidden upload fixture\n");
      return { CHOOSE_EVIDENCE_FILE: fixturePath };
    },
    teach: async (page, { caseDir }) => {
      const fixturePath = path.join(caseDir, "upload-evidence.txt");
      await writeFile(fixturePath, "workflow hidden upload fixture\n");
      await page.getByLabel("Upload evidence").setInputFiles(fixturePath);
      await page.getByText("Queued 1 evidence file").waitFor();
      await page.getByRole("button", { name: "Submit hidden upload" }).click();
      await page.getByText("Submitted hidden 1 file").waitFor();
    },
  },
  {
    id: "hover-menu",
    minSteps: 2,
    expectedActions: ["hover", "click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "await target1.hover();",
    ],
    files: () => commonFiles({
      title: "Hover Menu Workflow",
      body: [
        "    <main>",
        "      <h1>Hover Menu Workflow</h1>",
        "      <button type=\"button\" id=\"more\" data-testid=\"more-actions\" data-synthi-source-id=\"hover.more\">More actions</button>",
        "      <div id=\"menu\" role=\"menu\" hidden>",
        "        <button type=\"button\" role=\"menuitem\" data-testid=\"archive-report\" data-synthi-source-id=\"hover.archive\">Archive report</button>",
        "      </div>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "#menu { margin-top: 12px; }",
      ],
      script: [
        "const menu = document.querySelector('#menu');",
        "document.querySelector('[data-testid=\"more-actions\"]').addEventListener('pointerover', () => {",
        "  menu.hidden = false;",
        "});",
        "document.querySelector('[data-testid=\"archive-report\"]').addEventListener('click', () => {",
        "  document.querySelector('#status').textContent = 'Archived report';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.keyboard.down("Alt");
      await page.getByRole("button", { name: "More actions" }).hover();
      await page.keyboard.up("Alt");
      await page.getByRole("menuitem", { name: "Archive report" }).click();
      await page.getByText("Archived report").waitFor();
    },
  },
  {
    id: "double-click-context-menu",
    minSteps: 2,
    expectedActions: ["dblclick", "contextmenu"],
    expectedReplayText: [
      "Record details opened",
      "Context actions visible",
    ],
    expectedReplayCode: [
      "await target1.dblclick();",
      "await target2.click({ button: \"right\" });",
    ],
    files: () => commonFiles({
      title: "Double Click Context Menu Workflow",
      body: [
        "    <main>",
        "      <h1>Double Click Context Menu Workflow</h1>",
        "      <div role=\"row\" tabindex=\"0\" data-testid=\"record-row\" data-synthi-source-id=\"records.row\" aria-label=\"Quarterly record\">",
        "        <button type=\"button\" data-testid=\"open-record\" data-synthi-source-id=\"records.open\">Open record</button>",
        "      </div>",
        "      <div id=\"context-menu\" role=\"menu\" hidden>",
        "        <button type=\"button\" role=\"menuitem\" data-testid=\"inspect-record\" data-synthi-source-id=\"records.inspect\">Inspect record</button>",
        "      </div>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[role='row'] { width: max-content; border: 1px solid #9a9a91; padding: 14px; background: #fff; }",
        "#context-menu { width: max-content; margin-top: 12px; border: 1px solid #222; background: #fff; padding: 8px; }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const row = document.querySelector('[data-testid=\"record-row\"]');",
        "const menu = document.querySelector('#context-menu');",
        "document.querySelector('[data-testid=\"open-record\"]').addEventListener('dblclick', () => {",
        "  status.textContent = 'Record details opened';",
        "});",
        "row.addEventListener('contextmenu', (event) => {",
        "  event.preventDefault();",
        "  menu.hidden = false;",
        "  status.textContent = 'Context actions visible';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("button", { name: "Open record" }).dblclick();
      await page.getByText("Record details opened").waitFor();
      await page.getByRole("row", { name: "Quarterly record" }).click({ button: "right" });
      await page.getByText("Context actions visible").waitFor();
    },
  },
  {
    id: "keyboard-shortcut",
    minSteps: 2,
    expectedActions: ["press", "click"],
    expectedReplayText: [
      "Command palette opened",
      "Command executed",
    ],
    expectedReplayCode: [
      "await target1.press(\"Control+K\");",
    ],
    files: () => commonFiles({
      title: "Keyboard Shortcut Workflow",
      body: [
        "    <main tabindex=\"0\" role=\"application\" aria-label=\"Workspace shell\" data-testid=\"workspace-shell\" data-synthi-source-id=\"shortcut.shell\">",
        "      <h1>Keyboard Shortcut Workflow</h1>",
        "      <div id=\"palette\" role=\"dialog\" aria-label=\"Command palette\" hidden>",
        "        <button type=\"button\" data-testid=\"run-command\" data-synthi-source-id=\"shortcut.run\">Run command</button>",
        "      </div>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "main:focus { outline: 2px solid #303030; outline-offset: 6px; }",
        "#palette { border: 1px solid #222; background: #fff; padding: 14px; width: max-content; }",
      ],
      script: [
        "const shell = document.querySelector('[data-testid=\"workspace-shell\"]');",
        "const palette = document.querySelector('#palette');",
        "const status = document.querySelector('#status');",
        "shell.addEventListener('keydown', (event) => {",
        "  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {",
        "    event.preventDefault();",
        "    palette.hidden = false;",
        "    status.textContent = 'Command palette opened';",
        "  }",
        "});",
        "document.querySelector('[data-testid=\"run-command\"]').addEventListener('click', () => {",
        "  status.textContent = 'Command executed';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByTestId("workspace-shell").focus();
      await page.keyboard.press("Control+K");
      await page.getByText("Command palette opened").waitFor();
      await page.getByRole("button", { name: "Run command" }).click();
      await page.getByText("Command executed").waitFor();
    },
  },
  {
    id: "keyboard-control-keys",
    minSteps: 6,
    expectedActions: ["press"],
    expectedReplayText: [
      "Cursor at start",
      "Deleted A; buffer BC",
      "Cursor at end",
      "Backspaced C; buffer B",
      "Help opened",
      "Executed B",
    ],
    expectedReplayCode: [
      "await target1.press(\"Home\");",
      "await target2.press(\"Delete\");",
      "await target3.press(\"End\");",
      "await target4.press(\"Backspace\");",
      "await target5.press(\"F2\");",
      "await target6.press(\"Enter\");",
    ],
    files: () => commonFiles({
      title: "Keyboard Control Keys Workflow",
      body: [
        "    <main>",
        "      <h1>Keyboard Control Keys Workflow</h1>",
        "      <section role=\"application\" tabindex=\"0\" aria-label=\"Terminal control surface\" data-testid=\"control-shell\" data-synthi-source-id=\"keys.shell\">",
        "        <div id=\"buffer\" aria-live=\"polite\">ABC</div>",
        "        <pre id=\"log\" role=\"status\">Waiting</pre>",
        "      </section>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[role='application'] { width: min(640px, calc(100vw - 48px)); min-height: 168px; border: 1px solid #222; background: #101214; color: #f3f6f4; padding: 16px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
        "[role='application']:focus { outline: 2px solid #17663a; outline-offset: 4px; }",
        "pre { margin: 12px 0 0; white-space: pre-wrap; }",
      ],
      script: [
        "const shell = document.querySelector('[data-testid=\"control-shell\"]');",
        "const bufferNode = document.querySelector('#buffer');",
        "const log = document.querySelector('#log');",
        "const status = document.querySelector('#status');",
        "let buffer = 'ABC';",
        "let cursor = buffer.length;",
        "function render(message) {",
        "  bufferNode.textContent = buffer || '(empty)';",
        "  log.textContent = `cursor ${cursor}`;",
        "  status.textContent = message;",
        "}",
        "shell.addEventListener('keydown', (event) => {",
        "  if (event.key === 'Home') {",
        "    event.preventDefault();",
        "    cursor = 0;",
        "    render('Cursor at start');",
        "    return;",
        "  }",
        "  if (event.key === 'Delete') {",
        "    event.preventDefault();",
        "    const removed = buffer[cursor] || '';",
        "    if (removed) buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);",
        "    render(removed ? `Deleted ${removed}; buffer ${buffer}` : `Delete at end; buffer ${buffer}`);",
        "    return;",
        "  }",
        "  if (event.key === 'End') {",
        "    event.preventDefault();",
        "    cursor = buffer.length;",
        "    render('Cursor at end');",
        "    return;",
        "  }",
        "  if (event.key === 'Backspace') {",
        "    event.preventDefault();",
        "    const removed = cursor > 0 ? buffer[cursor - 1] : '';",
        "    if (removed) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor -= 1; }",
        "    render(removed ? `Backspaced ${removed}; buffer ${buffer}` : `Backspace at start; buffer ${buffer}`);",
        "    return;",
        "  }",
        "  if (event.key === 'F2') {",
        "    event.preventDefault();",
        "    render('Help opened');",
        "    return;",
        "  }",
        "  if (event.key === 'Enter') {",
        "    event.preventDefault();",
        "    render(`Executed ${buffer}`);",
        "  }",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByTestId("control-shell").focus();
      await page.keyboard.press("Home");
      await page.getByText("Cursor at start").waitFor();
      await page.keyboard.press("Delete");
      await page.getByText("Deleted A; buffer BC").waitFor();
      await page.keyboard.press("End");
      await page.getByText("Cursor at end").waitFor();
      await page.keyboard.press("Backspace");
      await page.getByText("Backspaced C; buffer B").waitFor();
      await page.keyboard.press("F2");
      await page.getByText("Help opened").waitFor();
      await page.keyboard.press("Enter");
      await page.getByText("Executed B").waitFor();
    },
  },
  {
    id: "terminal-text-entry",
    minSteps: 2,
    expectedActions: ["fill", "press"],
    expectedReplayText: [
      "parameterizedTextRegex([\"Prompt \",\"\"], inputValue1)",
      "parameterizedTextRegex([\"Ran \",\"\"], inputValue1)",
    ],
    expectedReplayCode: [
      "const inputValue1 = readRequiredEnv(\"TERMINAL_SURFACE\", \"browser_evt_1\");",
      "await page.keyboard.type(inputValue1);",
      "await target2.press(\"Enter\");",
    ],
    forbiddenReplayCode: [
      "deploy preview",
    ],
    replayEnv: () => ({ TERMINAL_SURFACE: "ship investor demo" }),
    files: () => commonFiles({
      title: "Terminal Text Entry Workflow",
      body: [
        "    <main>",
        "      <h1>Terminal Text Entry Workflow</h1>",
        "      <section role=\"application\" tabindex=\"0\" aria-label=\"Terminal surface\" data-testid=\"terminal-shell\" data-synthi-source-id=\"terminal.shell\">",
        "        <div id=\"prompt\" aria-live=\"polite\">Prompt</div>",
        "        <pre id=\"log\" role=\"status\">Idle</pre>",
        "      </section>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[role='application'] { width: min(680px, calc(100vw - 48px)); min-height: 180px; border: 1px solid #222; background: #101214; color: #f3f6f4; padding: 16px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
        "[role='application']:focus { outline: 2px solid #17663a; outline-offset: 4px; }",
        "pre { margin: 12px 0 0; white-space: pre-wrap; }",
      ],
      script: [
        "const shell = document.querySelector('[data-testid=\"terminal-shell\"]');",
        "const prompt = document.querySelector('#prompt');",
        "const log = document.querySelector('#log');",
        "const status = document.querySelector('#status');",
        "let buffer = '';",
        "shell.addEventListener('keydown', (event) => {",
        "  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {",
        "    event.preventDefault();",
        "    buffer += event.key;",
        "    prompt.textContent = `Prompt ${buffer}`;",
        "    return;",
        "  }",
        "  if (event.key === 'Enter') {",
        "    event.preventDefault();",
        "    status.textContent = `Ran ${buffer}`;",
        "    log.textContent = `Queued ${buffer}`;",
        "  }",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByTestId("terminal-shell").focus();
      await page.keyboard.type("deploy preview");
      await page.getByText("Prompt deploy preview").waitFor();
      await page.keyboard.press("Enter");
      await page.getByText("Ran deploy preview").waitFor();
    },
  },
  {
    id: "scroll-region",
    minSteps: 2,
    expectedActions: ["scroll", "click"],
    expectedReplayText: [
      "Scrolled to approvals",
      "Approved policy",
    ],
    expectedReplayCode: [
      "element.scrollTo(position.left, position.top);",
    ],
    files: () => commonFiles({
      title: "Scroll Region Workflow",
      body: [
        "    <main>",
        "      <h1>Scroll Region Workflow</h1>",
        "      <section tabindex=\"0\" role=\"region\" aria-label=\"Scrollable approvals\" data-testid=\"approval-scroll\" data-synthi-source-id=\"scroll.region\">",
        "        <div class=\"spacer\">Review queue starts here</div>",
        "        <button type=\"button\" data-testid=\"approve-policy\" data-synthi-source-id=\"scroll.approve\">Approve policy</button>",
        "      </section>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[data-testid='approval-scroll'] { width: 420px; height: 150px; overflow: auto; border: 1px solid #222; background: #fff; padding: 12px; }",
        ".spacer { height: 260px; color: #555; }",
      ],
      script: [
        "const scrollRegion = document.querySelector('[data-testid=\"approval-scroll\"]');",
        "const status = document.querySelector('#status');",
        "scrollRegion.addEventListener('scroll', () => {",
        "  if (scrollRegion.scrollTop > 100) status.textContent = 'Scrolled to approvals';",
        "});",
        "document.querySelector('[data-testid=\"approve-policy\"]').addEventListener('click', () => {",
        "  status.textContent = 'Approved policy';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByTestId("approval-scroll").evaluate((element) => element.scrollTo(0, 160));
      await page.getByText("Scrolled to approvals").waitFor();
      await page.getByRole("button", { name: "Approve policy" }).click();
      await page.getByText("Approved policy").waitFor();
    },
  },
  {
    id: "wheel-zoom-surface",
    minSteps: 2,
    expectedActions: ["scroll", "click"],
    expectedReplayText: [
      "Zoom 1.25 pan 0",
      "Viewport zoom 1.25 pan 0",
    ],
    expectedReplayCode: [
      "wheelBox1",
      "page.mouse.move",
      "page.keyboard.down(modifier)",
      "page.mouse.wheel(0, -240)",
    ],
    liveReplayMode: "sameSession",
    files: () => commonFiles({
      title: "Wheel Zoom Surface Workflow",
      body: [
        "    <main>",
        "      <h1>Wheel Zoom Surface Workflow</h1>",
        "      <section role=\"application\" aria-label=\"Revenue zoom surface\" data-testid=\"zoom-surface\" data-synthi-source-id=\"wheel.zoomSurface\">",
        "        <div class=\"grid\">Revenue map</div>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"inspect-viewport\" data-synthi-source-id=\"wheel.inspect\">Inspect viewport</button>",
        "      <output id=\"status\" aria-live=\"polite\">Zoom 1.00 pan 0</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[data-testid='zoom-surface'] { width: 520px; height: 220px; overflow: hidden; border: 1px solid #222; background: #f7f7f4; display: grid; place-items: center; touch-action: none; }",
        ".grid { width: 360px; height: 140px; display: grid; place-items: center; background: repeating-linear-gradient(90deg, #e3e3dc 0 1px, transparent 1px 36px), repeating-linear-gradient(0deg, #e3e3dc 0 1px, transparent 1px 28px); color: #171717; font-weight: 700; }",
      ],
      script: [
        "const surface = document.querySelector('[data-testid=\"zoom-surface\"]');",
        "const status = document.querySelector('#status');",
        "let zoom = 1;",
        "let pan = 0;",
        "function render() {",
        "  surface.style.setProperty('--zoom', zoom.toFixed(2));",
        "  surface.querySelector('.grid').style.transform = `scale(${zoom.toFixed(2)}) translateY(${pan}px)`;",
        "  status.textContent = `Zoom ${zoom.toFixed(2)} pan ${pan}`;",
        "}",
        "surface.addEventListener('wheel', (event) => {",
        "  event.preventDefault();",
        "  if (event.ctrlKey || event.metaKey) {",
        "    zoom = Math.max(0.5, Math.min(2, zoom + (event.deltaY < 0 ? 0.25 : -0.25)));",
        "  } else {",
        "    pan += Math.round(event.deltaY / 20);",
        "  }",
        "  render();",
        "}, { passive: false });",
        "document.querySelector('[data-testid=\"inspect-viewport\"]').addEventListener('click', () => {",
        "  status.textContent = `Viewport zoom ${zoom.toFixed(2)} pan ${pan}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const surface = page.getByTestId("zoom-surface");
      const box = await surface.boundingBox();
      if (!box) throw new Error("zoom surface was not visible");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -240);
      await page.keyboard.up("Control");
      await page.getByText("Zoom 1.25 pan 0").waitFor();
      await page.getByRole("button", { name: "Inspect viewport" }).click();
      await page.getByText("Viewport zoom 1.25 pan 0").waitFor();
    },
  },
  {
    id: "download-link",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayText: [
      "Download requested",
    ],
    expectedReplayCode: [
      "page.waitForEvent('download')",
      "suggestedFilename()).toBe(\"report.csv\")",
    ],
    files: () => [
      ...commonFiles({
        title: "Download Link Workflow",
        body: [
          "    <main>",
          "      <h1>Download Link Workflow</h1>",
          "      <a href=\"/report.csv\" download=\"report.csv\" role=\"button\" data-testid=\"download-report\" data-synthi-source-id=\"download.report\">Download report</a>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
        ].join("\n"),
        script: [
          "document.querySelector('[data-testid=\"download-report\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Download requested';",
          "});",
          "",
        ].join("\n"),
      }),
      {
        path: "report.csv",
        encoding: "utf8",
        content: "name,total\\nAda,42\\n",
      },
    ],
    teach: async (page) => {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download report" }).click();
      await downloadPromise;
      await page.getByText("Download requested").waitFor();
    },
  },
  {
    id: "network-mutation-unlabeled-action",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayCode: [
      "Mutation boundary: browser_evt_1. Prefix-only replay verifies reachability but does not commit this action.",
      "await expect(target1).toBeEnabled();",
    ],
    files: () => commonFiles({
      title: "Network Mutation Boundary Workflow",
      body: [
        "    <main>",
        "      <h1>Network Mutation Boundary Workflow</h1>",
        "      <button type=\"button\" data-testid=\"run-query\" data-synthi-source-id=\"query.run\">Run query</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "const status = document.querySelector('#status');",
        "document.querySelector('[data-testid=\"run-query\"]').addEventListener('click', async () => {",
        "  status.textContent = 'Running query';",
        "  await fetch('/api/query', {",
        "    method: 'POST',",
        "    headers: { 'content-type': 'application/json' },",
        "    body: JSON.stringify({ intent: 'teach-network-mutation-boundary' }),",
        "  }).catch(() => undefined);",
        "  status.textContent = 'Query run requested';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("button", { name: "Run query" }).click();
      await page.getByText("Query run requested").waitFor();
    },
  },
  {
    id: "ci-isolated-visual-mutation",
    minSteps: 1,
    expectedActions: ["click"],
    exportMode: "ciIsolated",
    ciIsolatedReplay: true,
    expectedReplayText: [
      "Published release card",
    ],
    expectedReplayCode: [
      "ALLOW_WORKFLOW_MUTATION",
      "await target1.click();",
    ],
    forbiddenReplayCode: [
      "Mutation boundary:",
      "/port/",
    ],
    replayEnv: () => ({ ALLOW_WORKFLOW_MUTATION: "1" }),
    files: () => commonFiles({
      title: "CI Isolated Visual Mutation Workflow",
      body: [
        "    <main>",
        "      <h1>CI Isolated Visual Mutation Workflow</h1>",
        "      <section class=\"release-card\" data-testid=\"release-card\" data-state=\"draft\" aria-label=\"Release card\" data-synthi-source-id=\"visual.release.card\">",
        "        <strong data-testid=\"release-label\">Draft release</strong>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"publish-release\" data-synthi-source-id=\"visual.release.publish\" data-synthi-mutation-boundary=\"release.publish\">Publish release</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".release-card { border: 2px solid #777; padding: 18px; background: #fff; }",
        ".release-card[data-state='published'] { border-color: #17663a; background: #e7f6ed; }",
      ],
      script: [
        "const card = document.querySelector('[data-testid=\"release-card\"]');",
        "const label = document.querySelector('[data-testid=\"release-label\"]');",
        "const status = document.querySelector('#status');",
        "document.querySelector('[data-testid=\"publish-release\"]').addEventListener('click', () => {",
        "  card.dataset.state = 'published';",
        "  label.textContent = 'Published release';",
        "  status.textContent = 'Published release card';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("button", { name: "Publish release" }).click();
      await page.getByText("Published release card").waitFor();
    },
  },
  {
    id: "native-confirm-dialog",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "Mutation boundary:",
      "await expect(target1).toBeEnabled();",
    ],
    files: () => commonFiles({
      title: "Native Confirm Dialog Workflow",
      body: [
        "    <main>",
        "      <h1>Native Confirm Dialog Workflow</h1>",
        "      <button type=\"button\" data-testid=\"confirm-policy\" data-synthi-source-id=\"dialog.confirm\">Confirm policy</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "document.querySelector('[data-testid=\"confirm-policy\"]').addEventListener('click', () => {",
        "  if (window.confirm('Approve policy?')) {",
        "    document.querySelector('#status').textContent = 'Confirmed policy';",
        "  } else {",
        "    document.querySelector('#status').textContent = 'Canceled policy';",
        "  }",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Confirm policy" }).click();
      await page.getByText("Confirmed policy").waitFor();
    },
  },
  {
    id: "native-prompt-dialog",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayCode: [
      "process.env[\"ENTER_WORKSPACE_NAME\"]",
      "await dialog.accept(dialogPrompt1);",
      "expect(dialog.message()).toContain(\"Enter workspace name\")",
    ],
    forbiddenReplayCode: [
      "Taught Secret Workspace",
      "Renamed workspace to [REDACTED]",
    ],
    liveReplayMode: "sameSession",
    replayParameters: { enter_workspace_name: "Agent Workspace" },
    replayEnv: () => ({ ENTER_WORKSPACE_NAME: "Agent Workspace" }),
    files: () => commonFiles({
      title: "Native Prompt Dialog Workflow",
      body: [
        "    <main>",
        "      <h1>Native Prompt Dialog Workflow</h1>",
        "      <button type=\"button\" data-testid=\"rename-workspace\" data-synthi-source-id=\"dialog.prompt.rename\">Rename workspace</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "document.querySelector('[data-testid=\"rename-workspace\"]').addEventListener('click', () => {",
        "  const name = window.prompt('Enter workspace name', 'Draft workspace');",
        "  document.querySelector('#status').textContent = name ? `Renamed workspace to ${name}` : 'Rename canceled';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      page.once("dialog", (dialog) => dialog.accept("Taught Secret Workspace"));
      await page.getByRole("button", { name: "Rename workspace" }).click();
      await page.getByText("Renamed workspace to Taught Secret Workspace").waitFor();
    },
  },
  {
    id: "popup-help-window",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayText: [
      "Help opened",
    ],
    expectedReplayCode: [
      "page.waitForEvent('popup')",
      "await popup1.waitForLoadState('domcontentloaded').catch(() => undefined);",
      "await expect(popup1).toHaveTitle(\"Workflow Help\");",
    ],
    liveReplayMode: "sameSession",
    files: () => [
      ...commonFiles({
        title: "Popup Help Workflow",
        body: [
          "    <main>",
          "      <h1>Popup Help Workflow</h1>",
          "      <a href=\"/help.html\" target=\"_blank\" rel=\"noreferrer\" role=\"button\" data-testid=\"open-help\" data-synthi-source-id=\"popup.help\">Open help</a>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
        ].join("\n"),
        script: [
          "document.querySelector('[data-testid=\"open-help\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Help opened';",
          "});",
          "",
        ].join("\n"),
      }),
      {
        path: "help.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Workflow Help</title>",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Workflow Help</h1>",
          "      <p>Help page opened in a new tab.</p>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
    ],
    teach: async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open help" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      await popup.waitForURL(/help\.html/);
      await page.getByText("Help opened").waitFor();
    },
  },
  {
    id: "cross-origin-popup-denied",
    minSteps: 0,
    expectedRecordingIssue: "popup_origin_consent_required",
    setup: async ({ addCleanup }) => {
      const auxiliary = await startAuxiliaryOriginServer({
        "/external-billing.html": [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>External Billing</title>",
          "    <style>",
          "      body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 32px; color: #171717; background: #f7f7f4; }",
          "      main { display: grid; gap: 12px; }",
          "    </style>",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>External Billing</h1>",
          "      <p>This popup is served from a separate origin and should require explicit workflow consent.</p>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      });
      addCleanup(auxiliary.close);
      return { externalOrigin: auxiliary.origin };
    },
    files: ({ externalOrigin }) => commonFiles({
      title: "Cross-Origin Popup Denied Workflow",
      body: [
        "    <main>",
        "      <h1>Cross-Origin Popup Denied Workflow</h1>",
        `      <a href="${externalOrigin}/external-billing.html" target="_blank" rel="noreferrer" role="button" data-testid="open-external-billing">Open external billing</a>`,
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      script: [
        "document.querySelector('[data-testid=\"open-external-billing\"]').addEventListener('click', () => {",
        "  document.querySelector('#status').textContent = 'External billing opened';",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open external billing" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      await popup.getByText("External Billing").waitFor();
      await page.getByText("External billing opened").waitFor();
      return popup;
    },
  },
  {
    id: "popup-form-window",
    minSteps: 3,
    expectedActions: ["click", "fill"],
    expectedReplayText: [
      "Popup editor opened",
    ],
    expectedReplayCode: [
      "page.waitForEvent('popup')",
      "popup1.getByLabel(\"Search help\")",
      "popup1.getByRole(\"button\", { name: \"Save query\" })",
      "Mutation boundary:",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ SEARCH_HELP: "contracts" }),
    files: () => [
      ...commonFiles({
        title: "Popup Form Workflow",
        body: [
          "    <main>",
          "      <h1>Popup Form Workflow</h1>",
          "      <a href=\"/help-form.html\" target=\"_blank\" rel=\"noreferrer\" role=\"button\" data-testid=\"open-help-form\" data-synthi-source-id=\"popup.form.open\">Open help form</a>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
        ].join("\n"),
        script: [
          "document.querySelector('[data-testid=\"open-help-form\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Popup editor opened';",
          "});",
          "",
        ].join("\n"),
      }),
      {
        path: "help-form.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Workflow Help Form</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Workflow Help Form</h1>",
          "      <label for=\"help-query\">Search help</label>",
          "      <input id=\"help-query\" aria-label=\"Search help\" data-synthi-source-id=\"popup.form.query\" placeholder=\"Search docs\">",
          "      <button type=\"button\" data-testid=\"save-query\" data-synthi-source-id=\"popup.form.save\">Save query</button>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
          "    <script type=\"module\" src=\"/help-form.js\"></script>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "help-form.js",
        encoding: "utf8",
        content: [
          "const query = document.querySelector('#help-query');",
          "document.querySelector('[data-testid=\"save-query\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = `Saved popup query ${query.value}`;",
          "});",
          "",
        ].join("\n"),
      },
    ],
    teach: async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open help form" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      await popup.getByLabel("Search help").fill("contracts");
      await popup.getByRole("button", { name: "Save query" }).click();
      await popup.getByText("Saved popup query contracts").waitFor();
      await page.getByText("Popup editor opened").waitFor();
      return popup;
    },
  },
  {
    id: "popup-return-to-opener",
    minSteps: 4,
    expectedActions: ["click", "fill"],
    expectedReplayText: [
      "Popup preview ready",
      "Summary ready",
    ],
    expectedReplayCode: [
      "page.waitForEvent('popup')",
      "popup1.getByLabel(\"Search help\")",
      "popup1.getByRole(\"button\", { name: \"Preview query\" })",
      "page.getByRole(\"button\", { name: \"Show handoff summary\" })",
    ],
    forbiddenReplayCode: [
      "popup1.getByRole(\"button\", { name: \"Show handoff summary\" })",
      "Mutation boundary:",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ SEARCH_HELP: "contracts" }),
    files: () => [
      ...commonFiles({
        title: "Popup Return Workflow",
        body: [
          "    <main>",
          "      <h1>Popup Return Workflow</h1>",
          "      <a href=\"/handoff.html\" target=\"_blank\" rel=\"noreferrer\" role=\"button\" data-testid=\"open-handoff\" data-synthi-source-id=\"popup.return.open\">Open handoff popup</a>",
          "      <button type=\"button\" data-testid=\"show-summary\" data-synthi-source-id=\"popup.return.summary\">Show handoff summary</button>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
        ].join("\n"),
        script: [
          "document.querySelector('[data-testid=\"open-handoff\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Popup handoff opened';",
          "});",
          "document.querySelector('[data-testid=\"show-summary\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Summary ready';",
          "});",
          "",
        ].join("\n"),
      }),
      {
        path: "handoff.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Workflow Handoff</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Workflow Handoff</h1>",
          "      <label for=\"help-query\">Search help</label>",
          "      <input id=\"help-query\" aria-label=\"Search help\" data-synthi-source-id=\"popup.return.query\" placeholder=\"Search docs\">",
          "      <button type=\"button\" data-testid=\"preview-query\" data-synthi-source-id=\"popup.return.preview\">Preview query</button>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
          "    <script type=\"module\" src=\"/handoff.js\"></script>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "handoff.js",
        encoding: "utf8",
        content: [
          "const query = document.querySelector('#help-query');",
          "document.querySelector('[data-testid=\"preview-query\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = `Popup preview ready for ${query.value}`;",
          "});",
          "",
        ].join("\n"),
      },
    ],
    teach: async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open handoff popup" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      await popup.getByLabel("Search help").fill("contracts");
      await popup.getByRole("button", { name: "Preview query" }).click();
      await popup.getByText("Popup preview ready for contracts").waitFor();
      await page.bringToFront();
      await page.getByRole("button", { name: "Show handoff summary" }).click();
      await page.getByText("Summary ready").waitFor();
      return page;
    },
  },
  {
    id: "popup-iframe-form",
    minSteps: 3,
    expectedActions: ["click", "fill"],
    expectedReplayText: [
      "Popup iframe preview",
    ],
    expectedReplayCode: [
      "page.waitForEvent('popup')",
      "popup1.frameLocator(\"iframe[data-testid=\\\"popup-frame\\\"]\").getByLabel(\"Popup frame note\")",
      "popup1.frameLocator(\"iframe[data-testid=\\\"popup-frame\\\"]\").getByRole(\"button\", { name: \"Preview popup frame\" })",
    ],
    forbiddenReplayCode: [
      "page.frameLocator(\"iframe[data-testid=\\\"popup-frame\\\"]\")",
      "Mutation boundary:",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ POPUP_FRAME_NOTE: "contracts" }),
    files: () => [
      ...commonFiles({
        title: "Popup Iframe Workflow",
        body: [
          "    <main>",
          "      <h1>Popup Iframe Workflow</h1>",
          "      <a href=\"/popup-shell.html\" target=\"_blank\" rel=\"noreferrer\" role=\"button\" data-testid=\"open-popup-frame\" data-synthi-source-id=\"popup.iframe.open\">Open popup frame</a>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
        ].join("\n"),
        script: [
          "document.querySelector('[data-testid=\"open-popup-frame\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = 'Popup frame opened';",
          "});",
          "",
        ].join("\n"),
        styles: [
          "iframe { width: min(620px, calc(100vw - 48px)); height: 260px; border: 1px solid #b9b9b2; background: white; }",
        ],
      }),
      {
        path: "popup-shell.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Popup Frame Shell</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Popup Frame Shell</h1>",
          "      <iframe data-testid=\"popup-frame\" title=\"Popup embedded workflow\" src=\"/popup-frame.html\"></iframe>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "popup-frame.html",
        encoding: "utf8",
        content: [
          "<!doctype html>",
          "<html>",
          "  <head>",
          "    <meta charset=\"UTF-8\">",
          "    <title>Popup Frame Form</title>",
          "    <link rel=\"stylesheet\" href=\"/styles.css\">",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Popup Frame Form</h1>",
          "      <label for=\"popup-frame-note\">Popup frame note</label>",
          "      <input id=\"popup-frame-note\" aria-label=\"Popup frame note\" data-synthi-source-id=\"popup.iframe.note\" placeholder=\"Note\">",
          "      <button type=\"button\" data-testid=\"preview-popup-frame\" data-synthi-source-id=\"popup.iframe.preview\">Preview popup frame</button>",
          "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
          "    </main>",
          "    <script type=\"module\" src=\"/popup-frame.js\"></script>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "popup-frame.js",
        encoding: "utf8",
        content: [
          "const note = document.querySelector('#popup-frame-note');",
          "document.querySelector('[data-testid=\"preview-popup-frame\"]').addEventListener('click', () => {",
          "  document.querySelector('#status').textContent = `Popup iframe preview for ${note.value}`;",
          "});",
          "",
        ].join("\n"),
      },
    ],
    teach: async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Open popup frame" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      const frame = popup.frameLocator('iframe[data-testid="popup-frame"]');
      await frame.getByLabel("Popup frame note").fill("contracts");
      await frame.getByRole("button", { name: "Preview popup frame" }).click();
      await frame.getByText("Popup iframe preview for contracts").waitFor();
      return popup;
    },
  },
  {
    id: "rich-text-editor",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "const inputValue1 = readRequiredEnv(\"RELEASE_NOTES\"",
      "toContainText(inputValue1)",
    ],
    replayEnv: () => ({ RELEASE_NOTES: "Release notes ready" }),
    files: () => commonFiles({
      title: "Rich Text Editor Workflow",
      body: [
        "    <main>",
        "      <h1>Rich Text Editor Workflow</h1>",
        "      <div contenteditable=\"true\" role=\"textbox\" aria-label=\"Release notes\" data-testid=\"release-notes\" data-synthi-source-id=\"rich.notes\"></div>",
        "      <button type=\"button\" data-testid=\"save-notes\" data-synthi-source-id=\"rich.save\">Save notes</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "[contenteditable='true'] { min-height: 96px; border: 1px solid #222; background: #fff; padding: 12px; }",
      ],
      script: [
        "const notes = document.querySelector('[data-testid=\"release-notes\"]');",
        "document.querySelector('[data-testid=\"save-notes\"]').addEventListener('click', () => {",
        "  document.querySelector('#status').textContent = `Saved ${notes.textContent.trim()}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("textbox", { name: "Release notes" }).fill("Release notes ready");
      await page.getByRole("button", { name: "Save notes" }).click();
      await page.getByText("Saved Release notes ready").waitFor();
    },
  },
  {
    id: "textarea-code-editor",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [],
    expectedReplayCode: [
      "const inputValue1 = readRequiredEnv(\"AUTOMATION_SCRIPT\"",
      "await expect(target1).toHaveValue(inputValue1);",
    ],
    liveReplayMode: "sameSession",
    replayEnv: () => ({ AUTOMATION_SCRIPT: "const answer = 42;\nconsole.log(answer);" }),
    files: () => commonFiles({
      title: "Textarea Code Editor Workflow",
      body: [
        "    <main>",
        "      <h1>Textarea Code Editor Workflow</h1>",
        "      <section data-synthi-editor=\"code\" data-language=\"javascript\" data-testid=\"script-editor\" role=\"group\" aria-label=\"Script editor\">",
        "        <label for=\"automation-script\">Automation script</label>",
        "        <textarea id=\"automation-script\" aria-label=\"Automation script\" data-language=\"javascript\" data-testid=\"automation-script\" data-synthi-source-id=\"editor.script\"></textarea>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"save-script\" data-synthi-source-id=\"editor.save\">Save script</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        "textarea { min-height: 136px; width: min(620px, calc(100vw - 48px)); border: 1px solid #222; background: #fff; padding: 12px; font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
      ],
      script: [
        "const script = document.querySelector('[data-testid=\"automation-script\"]');",
        "document.querySelector('[data-testid=\"save-script\"]').addEventListener('click', () => {",
        "  const lines = script.value.trim() ? script.value.trim().split(/\\r\\n|\\r|\\n/).length : 0;",
        "  document.querySelector('#status').textContent = `Saved script with ${lines} lines`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      const code = "const answer = 42;\nconsole.log(answer);";
      await page.getByLabel("Automation script").fill(code);
      await page.getByRole("button", { name: "Save script" }).click();
      await page.getByText("Saved script with 2 lines").waitFor();
    },
  },
  {
    id: "dashboard-interactions",
    minSteps: 6,
    expectedActions: ["check", "select", "fill", "press", "drag", "click"],
    expectedReplayText: [
      "Moved Revenue audit to Done lane",
    ],
    expectedReplayCode: [
      "const selectValue2 = readRequiredEnv(\"SEGMENT\"",
      "const inputValue3 = readRequiredEnv(\"SEARCH\"",
      "parameterizedTextRegex([\"Searched \",\"\"]",
      "toContainText(\"Revenue audit\")",
    ],
    replayEnv: () => ({ SEGMENT: "enterprise", SEARCH: "revenue" }),
    files: () => commonFiles({
      title: "Dashboard Interactions Workflow",
      body: [
        "    <main class=\"dashboard-shell\">",
        "      <h1>Dashboard Interactions Workflow</h1>",
        "      <label class=\"row\"><input id=\"urgent\" type=\"checkbox\" data-synthi-source-id=\"dashboard.urgent\"> Urgent only</label>",
        "      <label for=\"segment\">Segment</label>",
        "      <select id=\"segment\" aria-label=\"Segment\" data-synthi-source-id=\"dashboard.segment\">",
        "        <option value=\"all\">All</option>",
        "        <option value=\"enterprise\">Enterprise</option>",
        "        <option value=\"self-serve\">Self serve</option>",
        "      </select>",
        "      <label for=\"query\">Search</label>",
        "      <input id=\"query\" aria-label=\"Search\" data-synthi-source-id=\"dashboard.search\" placeholder=\"Search dashboards\">",
        "      <section class=\"board\" aria-label=\"Dashboard board\">",
        "        <div class=\"lane\" data-drop-target=\"todo\" data-testid=\"lane-todo\" aria-label=\"Todo lane\">",
        "          <h2>Todo</h2>",
        "          <div draggable=\"true\" class=\"card\" data-testid=\"card-revenue\" data-synthi-source-id=\"dashboard.card.revenue\">Revenue audit</div>",
        "        </div>",
        "        <div class=\"lane\" data-drop-target=\"done\" data-testid=\"lane-done\" aria-label=\"Done lane\">",
        "          <h2>Done</h2>",
        "        </div>",
        "      </section>",
        "      <button type=\"button\" data-testid=\"apply-dashboard\" data-synthi-source-id=\"dashboard.apply\">Apply dashboard</button>",
        "      <output id=\"status\" aria-live=\"polite\">Waiting</output>",
        "    </main>",
      ].join("\n"),
      styles: [
        ".dashboard-shell { width: min(920px, calc(100vw - 48px)); }",
        ".board { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 14px; }",
        ".lane { min-height: 148px; border: 1px solid #bbb; background: #fff; padding: 12px; display: grid; align-content: start; gap: 10px; }",
        ".lane h2 { margin: 0; font-size: 18px; }",
        ".card { width: max-content; border: 1px solid #222; background: #f1f1ed; padding: 10px 12px; cursor: grab; user-select: none; }",
        ".card:active { cursor: grabbing; }",
      ],
      script: [
        "const status = document.querySelector('#status');",
        "const query = document.querySelector('#query');",
        "const card = document.querySelector('[data-testid=\"card-revenue\"]');",
        "const doneLane = document.querySelector('[data-testid=\"lane-done\"]');",
        "query.addEventListener('keydown', (event) => {",
        "  if (event.key === 'Enter') status.textContent = `Searched ${query.value}`;",
        "});",
        "card.addEventListener('dragstart', (event) => {",
        "  event.dataTransfer.setData('text/plain', card.dataset.testid);",
        "});",
        "for (const lane of document.querySelectorAll('[data-drop-target]')) {",
        "  lane.addEventListener('dragover', (event) => event.preventDefault());",
        "  lane.addEventListener('drop', (event) => {",
        "    event.preventDefault();",
        "    const id = event.dataTransfer.getData('text/plain');",
        "    const dragged = document.querySelector(`[data-testid=\"${id}\"]`);",
        "    if (dragged) {",
        "      lane.appendChild(dragged);",
        "      status.textContent = `Moved ${dragged.textContent.trim()} to ${lane.getAttribute('aria-label')}`;",
        "    }",
        "  });",
        "}",
        "document.querySelector('[data-testid=\"apply-dashboard\"]').addEventListener('click', () => {",
        "  const urgent = document.querySelector('#urgent').checked ? 'urgent' : 'all priorities';",
        "  const segment = document.querySelector('#segment').value;",
        "  const moved = doneLane.contains(card) ? 'done' : 'todo';",
        "  status.textContent = `Applied ${segment} ${urgent}; card ${moved}; search ${query.value}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Urgent only").check();
      await page.getByLabel("Segment").selectOption("enterprise");
      await page.getByLabel("Search").fill("revenue");
      await page.waitForTimeout(450);
      await page.getByLabel("Search").press("Enter");
      await page.getByText("Searched revenue").waitFor();
      await page.getByTestId("card-revenue").dragTo(page.getByTestId("lane-done"));
      await page.getByText("Moved Revenue audit to Done lane").waitFor();
      await page.getByRole("button", { name: "Apply dashboard" }).click();
      await page.getByText("Applied enterprise urgent; card done; search revenue").waitFor();
    },
  },
  {
    id: "review-queue",
    minSteps: 3,
    expectedActions: ["click", "fill"],
    replayEnv: () => ({ FILTER: "billing" }),
    files: () => commonFiles({
      title: "Review Queue Workflow",
      body: [
        "    <main>",
        "      <h1>Review Queue Workflow</h1>",
        "      <a href=\"#queue\" role=\"button\" data-testid=\"open-queue\" data-synthi-source-id=\"queue.open\">Open review queue</a>",
        "      <section id=\"queue\" hidden>",
        "        <label for=\"filter\">Filter</label>",
        "        <input id=\"filter\" aria-label=\"Filter\" data-synthi-source-id=\"queue.filter\" placeholder=\"Filter queue\">",
        "        <button type=\"button\" data-testid=\"review-first\" data-synthi-source-id=\"queue.reviewFirst\">Mark first item reviewed</button>",
        "        <p class=\"status\" id=\"status\">Queue idle</p>",
        "      </section>",
        "    </main>",
      ].join("\n"),
      script: [
        "function showQueue() { document.querySelector('#queue').hidden = false; }",
        "document.querySelector('[data-testid=\"open-queue\"]').addEventListener('click', showQueue);",
        "window.addEventListener('hashchange', () => { if (location.hash === '#queue') showQueue(); });",
        "document.querySelector('[data-testid=\"review-first\"]').addEventListener('click', () => {",
        "  const filter = document.querySelector('#filter').value || 'all';",
        "  document.querySelector('#status').textContent = `Reviewed ${filter}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByRole("button", { name: "Open review queue" }).click();
      await page.getByLabel("Filter").fill("billing");
      await page.getByRole("button", { name: "Mark first item reviewed" }).click();
      await page.getByText("Reviewed billing").waitFor();
    },
  },
];

main().then(() => {
  // A CDP-attached Playwright client can keep sockets referenced after the
  // harness has finished. Exiting here releases this process without issuing
  // Browser.close() against the hosted runtime.
  process.exit(0);
}).catch((err) => {
  log("fail", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
