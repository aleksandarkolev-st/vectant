#!/usr/bin/env node
/*
 * Prove a real Codex agent can discover and call a saved Synthi workflow as an
 * MCP private tool. The harness uses a temporary Codex home copied from an
 * existing auth home, writes only temporary MCP config, and removes it at exit.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");
export const DEFAULT_CODEX_ACCEPTANCE_MODEL = "gpt-5.3-codex-spark";
export const CODEX_ACCEPTANCE_DISABLED_FEATURES = ["image_generation", "apps", "plugins"];

const args = parseArgs(process.argv.slice(2));
const CFG = {
  cdpUrl: args["cdp-url"] || process.env.SYNTHI_HOSTED_BROWSER_CDP_URL || "",
  targetUrl: args["target-url"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL || "",
  codexBin: args["codex-bin"] || process.env.CODEX_BIN || "codex",
  codexAuthHome: args["codex-auth-home"] || process.env.SYNTHI_CODEX_AUTH_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  codexModel: args["codex-model"] || process.env.SYNTHI_CODEX_ACCEPTANCE_MODEL || process.env.CODEX_MODEL || DEFAULT_CODEX_ACCEPTANCE_MODEL,
  codexReasoning: args["codex-reasoning"] || process.env.SYNTHI_CODEX_ACCEPTANCE_REASONING || "low",
  workspaceId: args["workspace-id"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_WORKSPACE_ID || "",
  outDir: path.resolve(args["out-dir"] || process.env.SYNTHI_PRIVATE_TOOL_CODEX_ACCEPTANCE_OUT_DIR || path.join(REPO_ROOT, "tmp", "private-tool-codex-acceptance")),
  timeoutMs: Number(args["timeout-ms"] || process.env.SYNTHI_PRIVATE_TOOL_CODEX_ACCEPTANCE_TIMEOUT_MS || 120_000),
};

function log(kind, message) {
  const tag = kind === "ok" ? "[ok]" : kind === "fail" ? "[fail]" : "[info]";
  console.log(`${tag} ${message}`);
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`dist entrypoint missing: ${DIST_INDEX}. Run npm run build first.`);
  }
  if (!CFG.cdpUrl.trim()) {
    throw new Error("hosted_cdp_url_required: pass --cdp-url or set SYNTHI_HOSTED_BROWSER_CDP_URL");
  }
  const authPath = path.join(CFG.codexAuthHome, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`codex_auth_missing: ${authPath}`);
  }

  await mkdir(CFG.outDir, { recursive: true });
  const fixture = CFG.targetUrl ? null : await startFixtureServer();
  const targetUrl = CFG.targetUrl || fixture.url;
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "synthi-private-tool-codex-"));
  const codexHome = path.join(artifactDir, "codex-home");
  const codexWorkdir = path.join(artifactDir, "codex-workspace");
  const storeFile = path.join(artifactDir, "private-tools.enc.json");
  const storeKey = `codex-acceptance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storeScope = `codex-acceptance-${process.pid}`;
  const workspaceId = CFG.workspaceId || `codex-private-tool-acceptance-${process.pid}`;
  const transcript = {
    generated_at: new Date().toISOString(),
    cdp_url: redactCdpUrl(CFG.cdpUrl),
    target_url: targetUrl,
    workspace_id: workspaceId,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    codex_model: CFG.codexModel,
    steps: [],
  };

  try {
    await mkdir(codexWorkdir, { recursive: true });
    await prepareCodexHome({ codexHome, authPath, storeFile, storeKey, storeScope, targetUrl, workspaceId });
    const seeded = await seedPrivateWorkflowStore({ storeFile, storeKey, storeScope, targetUrl });
    transcript.seeded = seeded;
    log("ok", `seed private workflow store - tool=${seeded.tool_name}`);

    await pruneExistingCdpPageTargets(CFG.cdpUrl);
    const codexRun = await runCodexAgent({ codexHome, codexWorkdir, targetUrl, toolName: seeded.tool_name });
    transcript.codex = codexRun.summary;
    await writeFile(path.join(CFG.outDir, "codex-jsonl.log"), codexRun.stdout);
    await writeFile(path.join(CFG.outDir, "codex-stderr.log"), codexRun.stderr);
    await writeFile(path.join(CFG.outDir, "codex-final-message.txt"), codexRun.finalMessage);
    assert.equal(codexRun.exitCode, 0, `codex exited with ${codexRun.exitCode}: ${codexRun.stderr.slice(0, 1000)}`);
    assert(codexRun.finalMessage.includes("WORKFLOW_DONE"), `Codex did not report workflow completion: ${codexRun.finalMessage}`);
    assert(codexRun.finalMessage.includes(seeded.tool_name), `Codex final message did not name discovered private tool ${seeded.tool_name}`);
    assert(codexRun.evidence.hosted_attach_call, "Codex JSONL did not include a completed hosted browser attach MCP call");
    assert.equal(codexRun.evidence.local_attach_call, false, "Codex used local CDP attach instead of hosted workspace attach");
    assert(codexRun.evidence.private_tool_call, `Codex JSONL did not include a completed MCP call to ${seeded.tool_name}`);
    assert(codexRun.evidence.private_tool_result_ok, `Codex private workflow tool did not return ok=true for ${seeded.tool_name}`);
    assert(codexRun.evidence.private_tool_steps_run > 0, `Codex private workflow tool ran no steps for ${seeded.tool_name}`);
    assert(codexRun.evidence.consent_call, "Codex JSONL did not include a completed screenshot consent MCP call");
    assert(codexRun.evidence.open_call, "Codex JSONL did not include a completed browser open MCP call");
    transcript.steps.push({ name: "codex discovered and called private MCP tool", ok: true, tool_name: seeded.tool_name });
    log("ok", `codex reported private workflow tool - ${seeded.tool_name}`);

    const visual = await captureVisualProof({ targetUrl });
    transcript.steps.push({
      name: "visual proof snapshot",
      ok: true,
      screenshot_path: visual.screenshotPath,
      text: visual.text,
      url: visual.url,
      match: visual.match,
    });
    assert(visual.text.includes("Details opened"), `browser did not show workflow effect: ${visual.text}`);
    log("ok", `visual proof snapshot - ${visual.screenshotPath}`);

    const transcriptPath = path.join(CFG.outDir, "codex-private-tool-acceptance.json");
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
    log("ok", `Codex private-tool acceptance passed - transcript=${transcriptPath}`);
  } finally {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    if (fixture) await fixture.close().catch(() => undefined);
  }
}

async function prepareCodexHome({ codexHome, authPath, storeFile, storeKey, storeScope, targetUrl, workspaceId }) {
  await mkdir(codexHome, { recursive: true });
  await copyFile(authPath, path.join(codexHome, "auth.json"));
  const configText = buildCodexConfigToml({
    codexReasoning: CFG.codexReasoning,
    codexModel: CFG.codexModel,
    distIndex: DIST_INDEX,
    storeFile,
    storeKey,
    storeScope,
    cdpUrl: CFG.cdpUrl,
    targetUrl,
    workspaceId,
  });
  await writeFile(path.join(codexHome, "config.toml"), configText);
}

export function buildCodexConfigToml({
  codexReasoning,
  codexModel,
  distIndex,
  storeFile,
  storeKey,
  storeScope,
  cdpUrl,
  targetUrl,
  workspaceId,
}) {
  const config = [
    `model_reasoning_effort = ${JSON.stringify(codexReasoning || "low")}`,
    "",
    "[mcp_servers.synthi]",
    'command = "node"',
    `args = [${JSON.stringify(distIndex)}]`,
    "",
    "[mcp_servers.synthi.env]",
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE = ${JSON.stringify(storeFile)}`,
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY = ${JSON.stringify(storeKey)}`,
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE = ${JSON.stringify(storeScope)}`,
    `SYNTHI_HOSTED_BROWSER_CDP_URL = ${JSON.stringify(cdpUrl)}`,
    `SYNTHI_HOSTED_BROWSER_WORKSPACE_URL = ${JSON.stringify(targetUrl)}`,
    `SYNTHI_WORKSPACE_ID = ${JSON.stringify(workspaceId)}`,
    'SYNTHI_AGENT_ID = "codex_private_tool_acceptance"',
    "",
  ];
  if (codexModel) {
    config.unshift(`model = ${JSON.stringify(codexModel)}`);
  }
  return config.join("\n");
}

async function runCodexAgent({ codexHome, codexWorkdir, targetUrl, toolName }) {
  const prompt = buildCodexAcceptancePrompt({ targetUrl });
  const proc = spawn(CFG.codexBin, codexExecArgs({
    codexWorkdir,
    prompt,
  }), {
    cwd: codexWorkdir,
    env: buildCodexProcessEnv({ baseEnv: process.env, codexHome }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectProcess(proc, CFG.timeoutMs);
  const events = parseCodexJsonl(output.stdout);
  const finalMessage = events
    .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => String(event.item?.text ?? ""))
    .at(-1) ?? "";
  const sawPrivateToolName = output.stdout.includes(toolName);
  const evidence = extractCodexMcpEvidence({ events, toolName, targetUrl });
  return {
    exitCode: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    events,
    finalMessage,
    sawPrivateToolName,
    evidence,
    summary: {
      exit_code: output.code,
      event_count: events.length,
      final_message: finalMessage,
      saw_private_tool_name: sawPrivateToolName,
      mcp_evidence: evidence,
    },
  };
}

export function buildCodexAcceptancePrompt({ targetUrl }) {
  return [
    "Use Synthi MCP tools only. Do not use shell commands. Do not read generated scripts or local files.",
    "A saved Synthi app workflow private tool is available as an MCP tool with a synthi_app_ prefix.",
    "Call synthi_browser_list_private_tools first. Read the returned tools[0].tool_name value. That exact value is the private workflow MCP tool you must call directly.",
    "Attach to the hosted browser with synthi_browser_attach_current_workspace, request screenshot consent for the exact target URL, and open the exact target URL.",
    "Do not call synthi_browser_begin_teach. Do not record a new workflow. Do not use synthi_browser_action to manually click the page. Do not report success after only listing, opening, observing, or taking a snapshot.",
    "After the target URL is open and consent is granted, directly call the discovered synthi_app_* private workflow tool with valid schema arguments. Use {} unless the private tool schema requires parameters.",
    "Only after that private workflow tool returns ok=true with replay.steps_run > 0, reply exactly as: WORKFLOW_DONE <tool_name_you_called>.",
    `Target URL: ${targetUrl}`,
  ].join("\n");
}

export function codexExecArgs({ codexWorkdir, prompt }) {
  const disabledFeatureArgs = CODEX_ACCEPTANCE_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    ...disabledFeatureArgs,
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    codexWorkdir,
    prompt,
  ];
}

export function extractCodexMcpEvidence({ events, toolName, targetUrl }) {
  const completedCalls = events
    .map((event) => event?.item)
    .filter((item) => item?.type === "mcp_tool_call" && item.status === "completed");
  const privateToolCall = completedCalls.find((item) => item.tool === toolName);
  const privateToolResult = privateToolCall?.result?.structured_content;
  const consentCall = completedCalls.find((item) => item.tool === "synthi_browser_request_consent"
    && sameUrl(String(item.arguments?.url ?? ""), targetUrl));
  const openCall = completedCalls.find((item) => item.tool === "synthi_browser_open"
    && sameUrl(String(item.arguments?.url ?? ""), targetUrl));
  const hostedAttachCall = completedCalls.find((item) => item.tool === "synthi_browser_attach_current_workspace");
  const hostedAttachOpenedTarget = hostedAttachCall
    && sameUrl(String(hostedAttachCall.result?.structured_content?.opened_workspace_url ?? ""), targetUrl);
  const localAttachCall = completedCalls.find((item) => item.tool === "synthi_browser_attach");
  return {
    attach_call: Boolean(hostedAttachCall),
    hosted_attach_call: Boolean(hostedAttachCall),
    local_attach_call: Boolean(localAttachCall),
    consent_call: Boolean(consentCall),
    open_call: Boolean(openCall) || Boolean(hostedAttachOpenedTarget),
    opened_by_hosted_attach: Boolean(hostedAttachOpenedTarget),
    private_tool_call: Boolean(privateToolCall),
    private_tool_result_ok: privateToolResult?.ok === true
      && privateToolResult?.private_tool?.tool_name === toolName,
    private_tool_steps_run: Number(privateToolResult?.replay?.steps_run ?? 0),
    private_tool_status: privateToolResult?.replay?.status ?? null,
  };
}

async function captureVisualProof({ targetUrl }) {
  const browser = await chromium.connectOverCDP(CFG.cdpUrl);
  try {
    const deadline = Date.now() + CFG.timeoutMs;
    while (Date.now() < deadline) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const match = await findPageWithText({ pages, targetUrl, expectedText: "Details opened" });
      if (match) {
        const screenshotPath = path.join(CFG.outDir, "after-codex-private-tool-call.png");
        await match.page.screenshot({ path: screenshotPath, fullPage: true });
        return { screenshotPath, text: match.text, url: match.url, match: match.match };
      }
      await sleep(500);
    }
    throw new Error("visual_proof_timeout");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function findPageWithText({ pages, targetUrl, expectedText }) {
  const sameOriginCandidates = [];
  for (const page of pages) {
    const pageUrl = page.url();
    const exact = sameUrl(pageUrl, targetUrl);
    if (!exact && !sameOrigin(pageUrl, targetUrl)) continue;
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (!text.includes(expectedText)) continue;
    const match = { page, text, url: pageUrl, match: exact ? "exact-url" : "same-origin" };
    if (exact) return match;
    sameOriginCandidates.push(match);
  }
  return sameOriginCandidates[0] ?? null;
}

async function seedPrivateWorkflowStore({ storeFile, storeKey, storeScope, targetUrl }) {
  const [
    { compileWorkflowContract },
    { generatePrivateWorkflowToolManifest },
    { EncryptedFilePrivateWorkflowToolStore, PrivateWorkflowToolRegistry },
    { sourceIdentityRegistry },
  ] = await Promise.all([
    importDist("browser/workflow.js"),
    importDist("browser/private_tool_manifest.js"),
    importDist("browser/private_tool_registry.js"),
    importDist("browser/source_identity.js"),
  ]);

  const sourceToken = "codex_open_details";
  sourceIdentityRegistry.register({
    workspaceId: "codex-private-tool-acceptance",
    filePath: "src/WorkflowFixture.tsx",
    adapter: "codex-acceptance",
    transformVersion: "codex_acceptance_v1",
    tokens: [{ token: sourceToken, file: "src/WorkflowFixture.tsx", tag: "button", line: 1, column: 1 }],
  });

  const origin = new URL(targetUrl).origin;
  const events = [{
    event_id: "open_details",
    trace_id: "codex_private_tool_acceptance_trace",
    trace_version: 1,
    event_seq: 1,
    ts: Date.now(),
    tab_id: "codex_acceptance_tab",
    origin,
    url: targetUrl,
    kind: "human_action",
    action: "click",
    detail: {
      element: { role: "button", name: "Open details", source_id: sourceToken },
    },
    locator_candidates: [
      { kind: "role", locator: 'page.getByRole("button", { name: "Open details" })', confidence: 0.99, reason: "role" },
    ],
  }];
  const workflow = compileWorkflowContract(events);
  const manifest = generatePrivateWorkflowToolManifest(workflow.contract);
  assert.equal(manifest.status, "available", "seeded workflow manifest should be available");
  const artifact = {
    workflow_id: workflow.contract.workflowId,
    workflow,
    events,
    saved_at: Date.now(),
  };
  const store = new EncryptedFilePrivateWorkflowToolStore({
    file_path: storeFile,
    key: storeKey,
    scope_id: storeScope,
  });
  store.clear();
  const registry = new PrivateWorkflowToolRegistry(store);
  const published = registry.publish(manifest, { workflowArtifact: artifact });
  assert.equal(published.ok, true, published.error || "private workflow publish failed");
  return {
    workflow_id: artifact.workflow_id,
    tool_name: published.registration.tool_name,
    store_scope: storeScope,
  };
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Synthi Codex private tool acceptance</title>
    <style>
      body { font-family: Inter, system-ui, sans-serif; margin: 48px; background: #f7f7f4; color: #171717; }
      main { display: grid; gap: 18px; max-width: 560px; }
      button { width: max-content; height: 42px; border: 0; background: #202020; color: white; padding: 0 16px; font: inherit; cursor: pointer; }
      output { min-height: 24px; color: #17663a; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Codex private workflow acceptance</h1>
      <p>The Codex agent must discover and call the saved Synthi workflow tool.</p>
      <button type="button" data-synthi-source-id="codex_open_details">Open details</button>
      <output aria-live="polite">Waiting for workflow</output>
    </main>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        document.querySelector("output").textContent = "Details opened";
      });
    </script>
  </body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function pruneExistingCdpPageTargets(cdpUrl) {
  const baseUrl = cdpHttpBaseUrl(cdpUrl);
  if (!baseUrl) return;
  try {
    const response = await fetchWithTimeout(`${baseUrl}/json/list`, { timeoutMs: Math.min(CFG.timeoutMs, 10_000) });
    if (!response.ok) return;
    const targets = await response.json();
    if (!Array.isArray(targets)) return;
    await Promise.all(selectCdpTargetsToClose(targets)
      .map((target) => fetchWithTimeout(`${baseUrl}/json/close/${encodeURIComponent(target.id)}`, {
        timeoutMs: Math.min(CFG.timeoutMs, 10_000),
      }).catch(() => undefined)));
  } catch {
    // Target pruning is a harness optimization; attach reports the real failure if CDP is unavailable.
  }
}

export function selectCdpTargetsToClose(targets) {
  if (!Array.isArray(targets)) return [];
  const pageTargets = targets.filter((target) => (
    target
    && typeof target.id === "string"
    && (target.type === "page" || target.type === "webview")
  ));
  if (pageTargets.length <= 1) return [];
  return pageTargets.slice(1);
}

function cdpHttpBaseUrl(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.origin;
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

export function buildCodexProcessEnv({ baseEnv = process.env, codexHome }) {
  const env = { ...baseEnv, CODEX_HOME: codexHome };
  delete env.SYNTHI_BROWSER_CDP_URL;
  return env;
}

function parseCodexJsonl(stdout) {
  return stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sameUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return a === b;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function collectProcess(proc, timeoutMs) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
  proc.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`process_timeout:${timeoutMs}`));
    }, timeoutMs);
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function importDist(relativePath) {
  return import(pathToFileURL(path.join(MCP_ROOT, "dist", relativePath)).href);
}

function redactCdpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "redacted";
    if (parsed.password) parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return "invalid";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isDirectRun()) {
  main().catch((err) => {
    log("fail", err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}
