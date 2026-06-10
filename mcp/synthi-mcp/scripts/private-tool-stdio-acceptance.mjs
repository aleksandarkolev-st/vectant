#!/usr/bin/env node
/*
 * Prove private workflow acceptance across the real MCP stdio boundary.
 *
 * The harness seeds the encrypted saved-workflow store with one generic
 * workflow artifact, spawns dist/index.js, discovers the private tool from
 * tools/list, and calls it through tools/call against a real browser target.
 * No fixed preview port, workspace slug, Chrome path, or script path is handed
 * to the client.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");

const args = parseArgs(process.argv.slice(2));
const CFG = {
  cdpUrl: args["cdp-url"] || process.env.SYNTHI_HOSTED_BROWSER_CDP_URL || "",
  targetUrl: args["target-url"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL || "",
  workspaceId: args["workspace-id"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_WORKSPACE_ID || "",
  outDir: path.resolve(args["out-dir"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_OUT_DIR || path.join(REPO_ROOT, "tmp", "private-tool-stdio-acceptance")),
  timeoutMs: Number(args["timeout-ms"] || process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TIMEOUT_MS || 60_000),
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

  await mkdir(CFG.outDir, { recursive: true });
  const fixture = CFG.targetUrl ? null : await startFixtureServer();
  const targetUrl = CFG.targetUrl || fixture.url;
  const workspaceId = CFG.workspaceId || `stdio-private-tool-acceptance-${process.pid}`;
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "synthi-private-tool-stdio-"));
  const storeFile = path.join(artifactDir, "private-tools.enc.json");
  const storeKey = `stdio-acceptance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storeScope = `stdio-acceptance-${process.pid}`;
  const transcript = {
    generated_at: new Date().toISOString(),
    cdp_url: redactCdpUrl(CFG.cdpUrl),
    target_url: targetUrl,
    workspace_id: workspaceId,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    steps: [],
  };

  let client;
  let proc;
  try {
    const seeded = await seedPrivateWorkflowStore({ storeFile, storeKey, storeScope, targetUrl });
    transcript.seeded = seeded;
    log("ok", `seed private workflow store - tool=${seeded.tool_name}`);

    await pruneExistingCdpPageTargets(CFG.cdpUrl);
    proc = spawn(process.execPath, [DIST_INDEX], {
      cwd: MCP_ROOT,
      env: buildStdioMcpEnv({
        baseEnv: process.env,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: storeFile,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: storeKey,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: storeScope,
        SYNTHI_HOSTED_BROWSER_CDP_URL: CFG.cdpUrl,
        SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: targetUrl,
        SYNTHI_WORKSPACE_ID: workspaceId,
        SYNTHI_AGENT_ID: "stdio_private_tool_acceptance",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    client = new JsonRpcClient(proc, { timeoutMs: CFG.timeoutMs, label: "synthi-mcp-stdio" });

    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthi-private-tool-stdio-acceptance", version: "0.0.0" },
    });
    assert.equal(typeof init?.protocolVersion, "string", "initialize returned protocolVersion");
    client.notify("notifications/initialized", {});
    transcript.steps.push({ name: "initialize", ok: true, serverInfo: init.serverInfo ?? null });
    log("ok", "initialize stdio MCP server");

    const listed = await client.request("tools/list", {});
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    const privateTool = tools.find((tool) => typeof tool?.name === "string" && tool.name.startsWith("synthi_app_"));
    assert(privateTool, `private workflow tool missing from tools/list (${tools.length} tools)`);
    transcript.steps.push({
      name: "discover private MCP tool",
      ok: true,
      tool_name: privateTool.name,
      tool_count: tools.length,
      input_schema: privateTool.inputSchema ?? null,
    });
    log("ok", `discover private MCP tool - ${privateTool.name}`);

    const manifestLookup = await client.toolCall("synthi_browser_get_private_tool_manifest", { tool_name: privateTool.name });
    assertToolOk(manifestLookup, "manifest lookup");
    assert.equal(manifestLookup.parsed?.tool_name, privateTool.name);
    transcript.steps.push({ name: "lookup manifest through MCP", ok: true, result: manifestLookup.parsed });
    log("ok", "lookup private tool manifest through MCP");

    const attach = await client.toolCall("synthi_browser_attach_current_workspace", {
      workspace_id: workspaceId,
      workspace_url: targetUrl,
      open_workspace: true,
    });
    assertToolOk(attach, "hosted browser attach");
    const attachEvidence = stdioAcceptanceAttachEvidence({ attachResult: attach });
    assert.equal(attachEvidence.hosted_attach, true, "stdio acceptance must attach through hosted runtime");
    assert.equal(attachEvidence.local_attach, false, "stdio acceptance must not use local CDP attach");
    transcript.steps.push({
      name: "attach hosted workspace browser through MCP",
      ok: true,
      runtime: attach.parsed?.runtime ?? null,
      hidden_tabs: attach.parsed?.hidden_tabs ?? null,
      evidence: attachEvidence,
    });
    log("ok", "attach hosted workspace browser through MCP stdio");

    const consent = await client.toolCall("synthi_browser_request_consent", {
      url: targetUrl,
      status: "granted",
      screenshot: true,
      diagnostics: false,
      reason: "stdio_private_tool_acceptance",
    });
    assertToolOk(consent, "request consent");
    transcript.steps.push({ name: "grant exact-origin consent", ok: true, result: consent.parsed });
    log("ok", "grant exact-origin consent");

    const opened = await client.toolCall("synthi_browser_open", { url: targetUrl });
    assertToolOk(opened, "open target page");
    const tabId = opened.parsed?.tab?.tab_id;
    assert.equal(typeof tabId, "string", "open target page returned tab_id");
    transcript.steps.push({ name: "open target page", ok: true, tab: opened.parsed?.tab ?? null });
    log("ok", `open target page - tab=${tabId}`);

    const run = await client.toolCall(privateTool.name, {});
    assertToolOk(run, "call discovered private workflow tool");
    assert.equal(run.parsed?.private_tool?.tool_name, privateTool.name);
    assert.equal(run.parsed?.private_tool?.run_mode, "sameSession");
    assert.equal(run.parsed?.replay?.steps_run, 1);
    transcript.steps.push({ name: "call discovered private MCP tool", ok: true, result: run.parsed });
    log("ok", `call discovered private MCP tool - steps=${run.parsed?.replay?.steps_run}`);

    const snapshot = await client.toolCall("synthi_browser_snapshot", { tab_id: tabId });
    assertToolOk(snapshot, "snapshot after private tool run");
    const dom = JSON.stringify(snapshot.parsed?.snapshot?.dom ?? {});
    assert(dom.includes("Details opened"), "snapshot DOM did not show workflow effect");
    const screenshotPath = await writeSnapshotScreenshot(snapshot.parsed?.snapshot, CFG.outDir);
    transcript.steps.push({
      name: "visual proof snapshot",
      ok: true,
      screenshot_path: screenshotPath,
      url: snapshot.parsed?.snapshot?.url ?? null,
    });
    log("ok", `visual proof snapshot - ${screenshotPath}`);

    const transcriptPath = path.join(CFG.outDir, "mcp-stdio-private-tool-acceptance.json");
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
    log("ok", `private MCP stdio acceptance passed - transcript=${transcriptPath}`);
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (proc && !proc.killed) proc.kill("SIGTERM");
    if (fixture) await fixture.close().catch(() => undefined);
  }
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

  const sourceToken = "stdio_open_details";
  sourceIdentityRegistry.register({
    workspaceId: "stdio-private-tool-acceptance",
    filePath: "src/WorkflowFixture.tsx",
    adapter: "stdio-acceptance",
    transformVersion: "stdio_acceptance_v1",
    tokens: [{ token: sourceToken, file: "src/WorkflowFixture.tsx", tag: "button", line: 1, column: 1 }],
  });

  const origin = new URL(targetUrl).origin;
  const events = [{
    event_id: "open_details",
    trace_id: "stdio_private_tool_acceptance_trace",
    trace_version: 1,
    event_seq: 1,
    ts: Date.now(),
    tab_id: "stdio_acceptance_tab",
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
    store_file: storeFile,
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
    <title>Synthi private tool acceptance</title>
    <style>
      body { font-family: Inter, system-ui, sans-serif; margin: 48px; background: #f7f7f4; color: #171717; }
      main { display: grid; gap: 18px; max-width: 560px; }
      button { width: max-content; height: 42px; border: 0; background: #202020; color: white; padding: 0 16px; font: inherit; cursor: pointer; }
      output { min-height: 24px; color: #17663a; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Private workflow acceptance</h1>
      <p>The spawned MCP client discovers and calls a saved Synthi workflow tool.</p>
      <button type="button" data-synthi-source-id="stdio_open_details">Open details</button>
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

class JsonRpcClient {
  constructor(proc, { timeoutMs, label }) {
    this.proc = proc;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderr += text;
      process.stderr.write(`[${this.label} stderr] ${text}`);
    });
    proc.once("exit", (code, signal) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`${this.label} exited before response: code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  onStdout(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async toolCall(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result?.content?.find((item) => item?.type === "text")?.text;
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { isError: result?.isError === true, parsed, result };
  }

  async close() {
    await this.request("shutdown", {}).catch(() => undefined);
    this.notify("exit", {});
  }
}

function assertToolOk(call, label) {
  assert.equal(call.isError, false, `${label} returned MCP isError: ${JSON.stringify(call.parsed)}`);
  assert.equal(call.parsed?.ok, true, `${label} did not return ok=true: ${JSON.stringify(call.parsed)}`);
}

async function writeSnapshotScreenshot(snapshot, outDir) {
  const screenshot = snapshot?.screenshot_base64;
  if (typeof screenshot !== "string" || screenshot.length === 0) {
    throw new Error("snapshot_missing_screenshot_base64");
  }
  const screenshotPath = path.join(outDir, "after-private-tool-call.png");
  await writeFile(screenshotPath, Buffer.from(screenshot, "base64"));
  return screenshotPath;
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
    // Target pruning is a harness optimization; attach still reports the real failure if CDP is unavailable.
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

export function buildStdioMcpEnv({ baseEnv = process.env, ...overrides }) {
  const env = { ...baseEnv, ...overrides };
  delete env.SYNTHI_BROWSER_CDP_URL;
  return env;
}

export function stdioAcceptanceAttachEvidence({ attachResult }) {
  const runtimeKind = attachResult?.parsed?.runtime?.kind ?? null;
  return {
    hosted_attach: attachResult?.parsed?.ok === true && runtimeKind === "hosted",
    local_attach: runtimeKind === "local-dev-cdp",
    runtime_kind: runtimeKind,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
  };
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

if (isDirectRun()) {
  main().catch((err) => {
    log("fail", err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
