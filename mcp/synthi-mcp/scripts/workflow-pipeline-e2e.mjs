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
  await seedWorkspace(slug, testCase.files());
  record(testCase.id, "seed workspace files", true, slug);

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
    await testCase.teach(previewPage);
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

    const runResult = await runExportedPlaywright({ runner, specPath, previewUrl, caseDir, caseId: testCase.id });
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
  await page.waitForSelector('button[aria-label="Workflows"]', { timeout: CFG.timeoutMs });
  await page.locator('button[aria-label="Workflows"]').first().click();
  await page.waitForSelector('[data-testid="agent-workflow-panel"]', { timeout: CFG.timeoutMs });
  return page;
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

async function runExportedPlaywright({ runner, specPath, previewUrl, caseDir, caseId }) {
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

function commonFiles({ title, body, script }) {
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
        "",
      ].join("\n"),
    },
    {
      path: "app.js",
      encoding: "utf8",
      content: script,
    },
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
    id: "settings-controls",
    minSteps: 3,
    files: () => commonFiles({
      title: "Settings Controls Workflow",
      body: [
        "    <main>",
        "      <h1>Settings Controls Workflow</h1>",
        "      <label class=\"row\"><input id=\"notify\" type=\"checkbox\" data-synthi-source-id=\"settings.notify\"> Enable notifications</label>",
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
        "  const theme = document.querySelector('#theme').value;",
        "  document.querySelector('#status').textContent = `Applied ${theme} with notifications ${notify}`;",
        "});",
        "",
      ].join("\n"),
    }),
    teach: async (page) => {
      await page.getByLabel("Enable notifications").check();
      await page.getByLabel("Theme").selectOption("dark");
      await page.getByRole("button", { name: "Apply settings" }).click();
      await page.getByText("Applied dark with notifications enabled").waitFor();
    },
  },
  {
    id: "review-queue",
    minSteps: 3,
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
