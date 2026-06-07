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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
  const browser = await chromium.connectOverCDP(CFG.cdpUrl);
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
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
    await browser.close().catch(() => undefined);
  }
}

async function runCase({ testCase, container, context, runner }) {
  const slug = `${CFG.slugPrefix}-${slugPart(testCase.id)}-${nowSlug()}`;
  const repoPath = `/data/repos/${slug}/${CFG.userId}`;
  const workspaceUrl = `${CFG.frontendUrl}/workspace/${encodeURIComponent(slug)}`;
  const caseDir = path.join(artifactRoot, slugPart(testCase.id));
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(caseDir, { recursive: true });

  log("info", `${testCase.id}: seed ${slug}`);
  const files = testCase.files();
  await seedWorkspace(slug, files);
  record(testCase.id, "seed workspace files", true, slug);
  const registeredSourceTokens = await registerSeedSourceIdentity(slug, files);
  record(testCase.id, "register source identity", true, `tokens=${registeredSourceTokens}`);

  const run = await startWorkspaceDevServer(container, slug, repoPath);
  let idePage;
  let previewPage;
  try {
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
    await testCase.teach(previewPage, { caseDir });
    await previewPage.waitForTimeout(800);
    await previewPage.screenshot({ path: path.join(caseDir, "after-teach-actions.png"), fullPage: true });

    const endState = await clickWorkflowOverlay(previewPage, "stop");
    const taughtSteps = Number(endState.stepCount || 0);
    record(testCase.id, "click overlay stop", endState.ok === true && taughtSteps >= testCase.minSteps, `steps=${taughtSteps}`);

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
    const generated = exportBody.result;
    record(
      testCase.id,
      "click export",
      exportBody.ok === true && typeof generated?.code === "string" && generated.code.includes("@playwright/test"),
      `locators=${generated?.used_locators?.length ?? 0}`
    );
    const specPath = path.join(caseDir, "exported-workflow.spec.mjs");
    await writeFile(specPath, generated.code);
    await writeJson(caseDir, "export.json", generated);
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

    const manifestBody = await clickWorkflowButton(idePage, /^Manifest$/);
    const manifest = manifestBody.result?.manifest;
    record(
      testCase.id,
      "click manifest",
      manifestBody.ok === true && manifest?.kind === "privateMcpToolManifest",
      `status=${manifest?.status || "missing"} source=${manifest?.source_identity?.status || "missing"}`
    );
    await writeJson(caseDir, "manifest.json", manifest);

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

    const replayEnv = typeof testCase.replayEnv === "function" ? await testCase.replayEnv({ caseDir }) : {};
    const runResult = await runExportedPlaywright({ runner, specPath, previewUrl, caseDir, caseId: testCase.id, env: replayEnv });
    record(testCase.id, "run exported Playwright", runResult.ok, runResult.detail);
  } finally {
    if (previewPage && !previewPage.isClosed()) {
      await previewPage.close().catch(() => undefined);
    }
    if (idePage && !idePage.isClosed()) {
      await idePage.close().catch(() => undefined);
    }
    await stopWorkspaceDevServer(container, run).catch((err) => {
      log("warn", `${testCase.id}: failed to stop dev server: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!CFG.keepWorkspaces) {
      await dockerExec(container, ["sh", "-lc", `rm -rf ${shellQuote(`/data/repos/${slug}`)}`]).catch(() => undefined);
    }
  }
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

async function runLiveWorkflowReplay({ caseId, workflowId, mode }) {
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
      await candidate.close().catch(() => undefined);
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
  await Promise.all(context.pages().map((page) => page.close().catch(() => undefined)));
}

async function openPreviewPage(context, previewUrl) {
  for (const candidate of context.pages()) {
    if (trimSlash(candidate.url()) === trimSlash(previewUrl)) {
      await candidate.close().catch(() => undefined);
    }
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
  return page;
}

async function waitForWorkflowOverlay(page) {
  await page.getByTestId("synthi-workflow-toolbox").waitFor({ state: "visible", timeout: CFG.timeoutMs });
}

async function clickWorkflowOverlay(page, action, expectedUrl = "") {
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
    if (action === "stop" && !state.recording && state.stepCount > 0) return state;
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
  const specTarget = path.join(runner.root, `${caseId}.spec.mjs`);
  await writeFile(specTarget, await readFile(specPath, "utf8"));
  const executablePath = chromium.executablePath();
  const proc = spawn(path.join(runner.root, "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright"), [
    "test",
    path.basename(specTarget),
    "--config",
    runner.configPath,
    "--reporter=line",
  ], {
    cwd: runner.root,
    env: {
      ...process.env,
      ...env,
      PLAYWRIGHT_BASE_URL: new URL(previewUrl).origin,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: executablePath,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectProcess(proc, CFG.timeoutMs);
  await writeFile(path.join(caseDir, "playwright-run.log"), output.stdout + output.stderr);
  return {
    ok: output.code === 0,
    detail: output.code === 0 ? "passed" : `exit=${output.code} ${stripAnsi(output.stderr || output.stdout).slice(0, 240)}`,
  };
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
    id: "iframe-form",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: ["Saved Ada Lovelace"],
    expectedReplayCode: ["page.frameLocator(\"iframe[data-testid=\\\"checkout-frame\\\"]\")"],
    liveReplayMode: "sameSession",
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
    id: "settings-controls",
    minSteps: 4,
    expectedActions: ["check", "uncheck", "select", "click"],
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
    id: "range-slider",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: ["Applied budget 75"],
    expectedReplayCode: [
      "element.dispatchEvent(new Event('input', { bubbles: true }));",
      "element.dispatchEvent(new Event('change', { bubbles: true }));",
    ],
    liveReplayMode: "sameSession",
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
    id: "file-input-upload",
    minSteps: 2,
    expectedActions: ["drag", "click"],
    expectedReplayText: [
      "Uploaded 1 file",
      "Submitted 1 file",
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
    id: "hover-menu",
    minSteps: 2,
    expectedActions: ["hover", "click"],
    expectedReplayText: [
      "Archived report",
    ],
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
      "await target2.click({ button: 'right' });",
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
    id: "native-confirm-dialog",
    minSteps: 1,
    expectedActions: ["click"],
    expectedReplayText: [
      "Confirmed policy",
    ],
    expectedReplayCode: [
      "page.once('dialog'",
      "await dialog.accept();",
      "expect(dialog.message()).toContain(\"Approve policy?\")",
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
    id: "rich-text-editor",
    minSteps: 2,
    expectedActions: ["fill", "click"],
    expectedReplayText: [
      "Saved Release notes ready",
    ],
    expectedReplayCode: [
      "toContainText(\"Release notes ready\")",
    ],
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
    id: "dashboard-interactions",
    minSteps: 6,
    expectedActions: ["check", "select", "fill", "press", "drag", "click"],
    expectedReplayText: [
      "Searched revenue",
      "Applied enterprise urgent; card done; search revenue",
    ],
    expectedReplayCode: [
      "toContainText(\"Revenue audit\")",
    ],
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

main().catch((err) => {
  log("fail", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
