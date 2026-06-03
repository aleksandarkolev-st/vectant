#!/usr/bin/env node
/*
 * Live smoke for Synthi's general browser MCP tools.
 *
 * This is the reproducible "normal developer" check for the browser flow:
 *   local fixture app -> real Chromium CDP -> MCP stdio server ->
 *   synthi_browser_* tools -> broker consent/lease/trace/replay surfaces.
 *
 * Usage:
 *   npm run build
 *   npm run live:browser
 *
 * Browser selection:
 *   SYNTHI_BROWSER_CDP_URL=http://127.0.0.1:9222 npm run live:browser
 *     Reuse an already-running browser reachable from this process.
 *
 *   SYNTHI_BROWSER_EXECUTABLE=/path/to/chrome npm run live:browser
 *     Launch that browser with a temporary profile and CDP port.
 *
 * If neither env var is set, the script tries Playwright's Chromium cache
 * and then common Chromium-family executables on PATH. To provision the
 * Playwright browser cache:
 *
 *   npm run live:browser:install
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const SESSION_DIR = path.resolve(MCP_ROOT, ".browser-workspace-sessions");

const CFG = {
  mcpEntry: path.resolve(MCP_ROOT, process.env.MCP_ENTRY ?? "dist/index.js"),
  cdpUrl: process.env.SYNTHI_BROWSER_CDP_URL,
  browserExecutable: process.env.SYNTHI_BROWSER_EXECUTABLE,
  target: process.env.SYNTHI_BROWSER_SMOKE_TARGET ?? "fixture",
  frontendUrl: process.env.FRONTEND_URL ?? process.env.SYNTHI_FRONTEND_URL ?? "http://localhost:3000",
  collabUrl: process.env.COLLAB_URL ?? process.env.SYNTHI_COLLAB_URL ?? "http://localhost:1234",
  workspaceSlug: process.env.SLUG ?? process.env.WORKSPACE_SLUG ?? `browser-mcp-${Date.now()}`,
  workspaceName: process.env.WORKSPACE_NAME ?? "Synthi Browser MCP Workspace",
  workspaceUserId: process.env.SYNTHI_BROWSER_WORKSPACE_USER_ID ?? "browser-mcp-live",
  headless: process.env.SYNTHI_BROWSER_SMOKE_HEADLESS !== "0",
  keepBrowser: process.env.SYNTHI_BROWSER_SMOKE_KEEP_BROWSER === "1",
  timeoutMs: Number(process.env.SYNTHI_BROWSER_SMOKE_TIMEOUT_MS ?? 120_000),
};

const results = [];

function log(kind, message) {
  const tag = kind === "ok" ? "[ok]" : kind === "warn" ? "[warn]" : kind === "fail" ? "[fail]" : "[info]";
  console.log(`${tag} ${message}`);
}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(ok ? "ok" : "fail", `${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

function parseArgs(argv) {
  const args = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--fixture") args.target = "fixture";
    else if (arg === "--workspace") args.target = "workspace";
    else if (arg === "--cdp-url") args.cdpUrl = argv[++i];
    else if (arg === "--browser-executable") args.browserExecutable = argv[++i];
    else if (arg === "--frontend-url") args.frontendUrl = argv[++i];
    else if (arg === "--collab-url") args.collabUrl = argv[++i];
    else if (arg === "--slug") args.workspaceSlug = argv[++i];
    else if (arg === "--workspace-name") args.workspaceName = argv[++i];
    else if (arg === "--user-id") args.workspaceUserId = argv[++i];
    else if (arg === "--headed") args.headless = false;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--keep-browser") args.keepBrowser = true;
    else if (arg === "--no-keep-browser") args.keepBrowser = false;
  }
  return args;
}

function usage() {
  console.log([
    "live-browser-smoke - run the browser MCP live flow against a real browser.",
    "",
    "Usage:",
    "  npm run build",
    "  npm run live:browser",
    "  npm run live:browser:workspace",
    "  npm run live:browser -- --headed",
    "  npm run live:browser:workspace -- --headed --slug browser-mcp-manual",
    "  npm run live:browser -- --cdp-url http://127.0.0.1:9222",
    "  npm run live:browser -- --browser-executable /path/to/chrome",
    "",
    "Environment:",
    "  SYNTHI_BROWSER_CDP_URL              Existing reachable CDP endpoint.",
    "  SYNTHI_BROWSER_EXECUTABLE           Browser executable to launch.",
    "  FRONTEND_URL                         Synthi frontend URL for --workspace.",
    "  COLLAB_URL                           Synthi collab-server URL for --workspace.",
    "  SLUG                                 Workspace slug for --workspace.",
    "  SYNTHI_BROWSER_SMOKE_HEADLESS=0     Launch visibly.",
    "  SYNTHI_BROWSER_SMOKE_KEEP_BROWSER=1 Keep launched browser open.",
    "  MCP_ENTRY=dist/index.js             MCP server entrypoint.",
  ].join("\n"));
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    proc.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    proc.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP exited before response: code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  onData(text) {
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
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.timeoutMs) {
    if (this.closed) return Promise.reject(new Error("MCP process is closed"));
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthi-live-browser-smoke", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async tool(name, args = {}, timeoutMs = CFG.timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const parsed = parseToolPayload(result);
    return { raw: result, parsed, isError: result?.isError === true };
  }
}

function parseToolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((block) => block?.type === "text")?.text;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    if (url.pathname === "/api/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml());
  });
  await listen(server, "127.0.0.1", 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function prepareTarget() {
  if (CFG.target === "workspace") {
    return seedWorkspaceTarget();
  }
  const fixture = await startFixtureServer();
  return { kind: "fixture", url: fixture.url, server: fixture.server };
}

async function seedWorkspaceTarget() {
  await assertHttpReachable(CFG.frontendUrl, "frontend");
  await assertHttpReachable(CFG.collabUrl, "collab-server");

  const files = workspaceSeedFiles();
  const write = await httpJson("POST", `${CFG.collabUrl.replace(/\/$/, "")}/git/${CFG.workspaceSlug}/write-files-batch`, {
    files,
    syncToGcs: false,
  }, {
    "x-user-id": CFG.workspaceUserId,
  });
  const hardErrors = (write.errors ?? []).filter((entry) => entry?.stage !== "gcs_upload");
  if (hardErrors.length) {
    throw new Error(`workspace seed failed: ${JSON.stringify(hardErrors).slice(0, 800)}`);
  }

  try {
    await httpJson("POST", `${CFG.collabUrl.replace(/\/$/, "")}/git/${CFG.workspaceSlug}/stage-all`, {}, {
      "x-user-id": CFG.workspaceUserId,
    });
    await httpJson("POST", `${CFG.collabUrl.replace(/\/$/, "")}/git/${CFG.workspaceSlug}/commit`, {
      message: "browser-mcp-live: seed workspace",
    }, {
      "x-user-id": CFG.workspaceUserId,
    });
  } catch (err) {
    log("warn", `workspace commit skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const workspaceUrl = `${CFG.frontendUrl.replace(/\/$/, "")}/workspace/${encodeURIComponent(CFG.workspaceSlug)}`;
  return {
    kind: "workspace",
    url: workspaceUrl,
    slug: CFG.workspaceSlug,
    name: CFG.workspaceName,
    filesWritten: write.written?.length ?? files.length,
  };
}

function workspaceSeedFiles() {
  return [
    {
      path: "README.md",
      encoding: "utf8",
      content: [
        "# Synthi Browser MCP Workspace",
        "",
        "This persistent workspace is generated by `npm run live:browser:workspace`.",
        "Use it to test browser consent, snapshots, teach mode, leases, console/network access, and replay generation against the real Synthi UI.",
        "",
      ].join("\n"),
    },
    {
      path: "package.json",
      encoding: "utf8",
      content: JSON.stringify({
        scripts: { dev: "vite --host 0.0.0.0" },
        dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "latest", "react-dom": "latest" },
        devDependencies: {},
      }, null, 2) + "\n",
    },
    {
      path: "src/App.jsx",
      encoding: "utf8",
      content: [
        "import React, { useState } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import './styles.css';",
        "",
        "function App() {",
        "  const [status, setStatus] = useState('idle');",
        "  return (",
        "    <main className=\"shell\">",
        "      <h1>Synthi Browser MCP Fixture</h1>",
        "      <p>Persistent workspace for testing browser-agent consent, snapshots, teach mode, leases, and replay.</p>",
        "      <label>",
        "        Test token",
        "        <input aria-label=\"Test token\" placeholder=\"paste a harmless token\" />",
        "      </label>",
        "      <button type=\"button\" data-testid=\"workspace-save\" onClick={() => {",
        "        console.log('workspace action token=workspace-secret password=workspace-password');",
        "        setStatus('saved');",
        "      }}>Save workspace state</button>",
        "      <output data-state={status}>{status === 'saved' ? 'Saved' : 'Waiting'}</output>",
        "    </main>",
        "  );",
        "}",
        "",
        "createRoot(document.getElementById('root')).render(<App />);",
        "",
      ].join("\n"),
    },
    {
      path: "src/styles.css",
      encoding: "utf8",
      content: [
        ":root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #171717; background: #f7f7f4; }",
        "body { margin: 0; min-height: 100vh; display: grid; place-items: center; }",
        ".shell { width: min(720px, calc(100vw - 48px)); display: grid; gap: 18px; }",
        "h1 { margin: 0; font-size: 42px; line-height: 1.05; }",
        "p { margin: 0; max-width: 58ch; color: #4c4c45; }",
        "label { display: grid; gap: 8px; font-weight: 650; }",
        "input { height: 42px; border: 1px solid #c9c9c2; padding: 0 12px; font: inherit; }",
        "button { width: max-content; height: 42px; border: 0; background: #202020; color: white; padding: 0 16px; font: inherit; cursor: pointer; }",
        "output { min-height: 24px; color: #17663a; font-weight: 700; }",
        "",
      ].join("\n"),
    },
    {
      path: "index.html",
      encoding: "utf8",
      content: [
        "<!doctype html>",
        "<html>",
        "  <head><meta charset=\"UTF-8\"><title>Synthi Browser MCP Fixture</title></head>",
        "  <body><div id=\"root\"></div><script type=\"module\" src=\"/src/App.jsx\"></script></body>",
        "</html>",
        "",
      ].join("\n"),
    },
  ];
}

async function assertHttpReachable(baseUrl, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(baseUrl, { signal: controller.signal });
  } catch (err) {
    throw new Error(`${label} is not reachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function fixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Synthi Browser Smoke</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 40px; color: #172033; }
      main { display: grid; gap: 16px; max-width: 560px; }
      label { display: grid; gap: 6px; font-weight: 650; }
      input { height: 36px; padding: 0 10px; font: inherit; }
      button { width: max-content; height: 36px; padding: 0 14px; font: inherit; }
      #status { min-height: 24px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser MCP live fixture</h1>
      <label>Email
        <input id="email" name="email" aria-label="Email" placeholder="dev@example.com">
      </label>
      <button id="save" data-testid="save-button" type="button">Save changes</button>
      <p id="status" data-state="idle">Waiting</p>
    </main>
    <script>
      document.getElementById("save").addEventListener("click", async () => {
        console.log("saving password=hunter2 token=secret-token");
        await fetch("/api/ping?token=secret-token&password=hunter2");
        const status = document.getElementById("status");
        status.dataset.state = "saved";
        status.textContent = "Saved";
      });
    </script>
  </body>
</html>`;
}

async function startMcp() {
  if (!existsSync(CFG.mcpEntry)) {
    throw new Error(`MCP entry missing: ${CFG.mcpEntry}. Run npm run build first.`);
  }
  const proc = spawn("node", [CFG.mcpEntry], {
    cwd: MCP_ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));
  const client = new McpClient(proc);
  log("info", `mcp=${CFG.mcpEntry}`);
  await client.initialize();
  return { proc, client };
}

async function startBrowser() {
  if (CFG.cdpUrl) {
    await waitForCdp(CFG.cdpUrl, CFG.timeoutMs);
    return { cdpUrl: CFG.cdpUrl, proc: null, profileDir: null };
  }

  const executable = await resolveBrowserExecutable();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "synthi-browser-smoke-"));
  const cdpPort = await reservePort();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const args = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-extensions",
  ];
  if (CFG.headless) args.push("--headless=new");
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  args.push("about:blank");

  const stderr = [];
  const proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString("utf8"));
    while (stderr.length > 20) stderr.shift();
  });
  await waitForCdp(cdpUrl, CFG.timeoutMs, () => proc.exitCode !== null, () => stderr.join(""));
  return { cdpUrl, proc, profileDir };
}

async function resolveBrowserExecutable() {
  const candidates = [];
  if (CFG.browserExecutable) candidates.push(CFG.browserExecutable);
  const playwrightPath = playwrightChromiumPath();
  if (playwrightPath) candidates.push(playwrightPath);
  for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "msedge"]) {
    const resolved = commandPath(command);
    if (resolved) candidates.push(resolved);
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  throw new Error([
    "No local Chromium-family browser executable is available to the MCP process.",
    "",
    "Use one of:",
    "  npm run live:browser:install",
    "  SYNTHI_BROWSER_EXECUTABLE=/path/to/chrome npm run live:browser",
    "  SYNTHI_BROWSER_CDP_URL=http://reachable-host:9222 npm run live:browser",
    "",
    "The CDP URL must be reachable from the same environment that runs the MCP.",
  ].join("\n"));
}

function playwrightChromiumPath() {
  try {
    const code = "const { chromium } = require('playwright-core'); process.stdout.write(chromium.executablePath())";
    const result = spawnSync(process.execPath, ["-e", code], { cwd: MCP_ROOT, encoding: "utf8" });
    const executable = result.status === 0 ? result.stdout.trim() : "";
    return executable && existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

function commandPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
  const resolved = result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
  return resolved || null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function reservePort() {
  const server = http.createServer();
  await listen(server, "127.0.0.1", 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await closeServer(server);
  if (!port) throw new Error("failed to reserve a local TCP port");
  return port;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForCdp(cdpUrl, timeoutMs, exited = () => false, stderr = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`browser exited before CDP was reachable\n${stderr()}`);
    try {
      const version = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json/version`, 1_500);
      if (version?.webSocketDebuggerUrl || version?.Browser) return version;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(`CDP endpoint not reachable at ${cdpUrl}: ${lastError}`);
}

async function fetchJson(url, timeoutMs = 5_000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    return JSON.parse(text || "{}");
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
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

async function postBridge(url, body) {
  const response = await fetch(`${url.replace(/\/$/, "")}/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "chrome-extension://synthi-live-browser-smoke",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`bridge POST failed: status=${response.status} body=${JSON.stringify(payload)}`);
  }
  return payload;
}

function expectToolOk(result, name) {
  if (result.isError || result.parsed?.error) {
    throw new Error(`${name} failed: ${JSON.stringify(result.parsed)}`);
  }
  return result.parsed;
}

function pageLocator(css) {
  return `page.locator(${JSON.stringify(css)})`;
}

function pageGetByLabel(label) {
  return `page.getByLabel(${JSON.stringify(label)})`;
}

function pageGetByRole(role, name) {
  return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`;
}

async function runLiveFlow(client, cdpUrl, target) {
  const attach = expectToolOk(await client.tool("synthi_browser_attach", {
    cdp_url: cdpUrl,
    bridge_host: "127.0.0.1",
    bridge_port: 0,
  }, 45_000), "synthi_browser_attach");
  record("attach to CDP", Boolean(attach.bridge?.url && attach.bridge?.token), `bridge=${attach.bridge?.url}`);

  const consent = expectToolOk(await client.tool("synthi_browser_request_consent", {
    url: target.url,
    status: "granted",
    reason: "live-browser-smoke",
  }), "synthi_browser_request_consent");
  record("grant exact-origin consent", consent.consent?.status === "granted", consent.consent?.origin ?? "");

  const opened = expectToolOk(await client.tool("synthi_browser_open", { url: target.url }, 45_000), "synthi_browser_open");
  const tabId = opened.tab?.tab_id;
  record(`open consented ${target.kind} tab`, Boolean(tabId), `tab=${tabId}`);

  const listed = expectToolOk(await client.tool("synthi_browser_list_tabs"), "synthi_browser_list_tabs");
  record("enumerate authorized tabs only", listed.tabs?.some((tab) => tab.tab_id === tabId), `tabs=${listed.tabs?.length ?? 0}`);

  if (target.kind === "workspace") {
    return runWorkspaceFlow(client, attach, tabId, target);
  }

  return runFixtureFlow(client, attach, tabId, target);
}

async function runFixtureFlow(client, attach, tabId, target) {
  const fixtureUrl = target.url;
  const snapshot = expectToolOk(await client.tool("synthi_browser_snapshot", { tab_id: tabId }, 45_000), "synthi_browser_snapshot");
  const snap = snapshot.snapshot;
  record("capture screenshot and DOM", Boolean(snap?.screenshot_base64?.length > 1_000 && snap?.dom?.text_sample?.includes("Save changes")));

  const lease = expectToolOk(await client.tool("synthi_browser_acquire_lease", {
    owner: "live-browser-smoke",
    lease_ms: 15_000,
    reason: "exercise real browser actions",
  }), "synthi_browser_acquire_lease").lease;
  record("acquire control lease", Boolean(lease?.lease_id), lease?.lease_id ?? "");

  expectToolOk(await client.tool("synthi_browser_action", {
    lease_id: lease.lease_id,
    tab_id: tabId,
    action: "fill",
    selector: pageGetByLabel("Email"),
    value: "dev@example.com",
  }, 45_000), "synthi_browser_action fill");

  expectToolOk(await client.tool("synthi_browser_action", {
    lease_id: lease.lease_id,
    tab_id: tabId,
    action: "click",
    selector: pageGetByRole("button", "Save changes"),
  }, 45_000), "synthi_browser_action click");

  expectToolOk(await client.tool("synthi_browser_wait", {
    tab_id: tabId,
    condition: "selector",
    selector: pageLocator("#status[data-state=\"saved\"]"),
    timeout_ms: 5_000,
  }, 10_000), "synthi_browser_wait");
  record("drive page through broker action", true, "status=saved");

  const consoleResult = expectToolOk(await client.tool("synthi_browser_get_console", { tab_id: tabId }), "synthi_browser_get_console");
  const networkResult = expectToolOk(await client.tool("synthi_browser_get_network", { tab_id: tabId }), "synthi_browser_get_network");
  const runtimePayload = JSON.stringify({ console: consoleResult.entries, network: networkResult.entries });
  record(
    "redact console and network secrets",
    runtimePayload.includes("[REDACTED]") && !runtimePayload.includes("hunter2") && !runtimePayload.includes("secret-token"),
    `console=${consoleResult.entries?.length ?? 0} network=${networkResult.entries?.length ?? 0}`,
  );

  expectToolOk(await client.tool("synthi_browser_start_teach", { tab_id: tabId }), "synthi_browser_start_teach");
  await postBridge(attach.bridge.url, {
    bridge_token: attach.bridge.token,
    page_origin: new URL(fixtureUrl).origin,
    type: "selection",
    payload: {
      url: fixtureUrl,
      origin: new URL(fixtureUrl).origin,
      element: { tag: "button", role: "button", name: "Save changes", test_id: "save-button", text: "Save changes" },
    },
  });
  await postBridge(attach.bridge.url, {
    bridge_token: attach.bridge.token,
    page_origin: new URL(fixtureUrl).origin,
    type: "human_action",
    payload: {
      url: fixtureUrl,
      origin: new URL(fixtureUrl).origin,
      action: "fill",
      field_name: "token",
      value: "sk-live-browser-smoke-secret-token",
      element: { tag: "input", role: "textbox", label: "Email", name: "Email", css: "#email" },
    },
  });
  expectToolOk(await client.tool("synthi_browser_stop_teach", { reason: "live-browser-smoke-complete" }), "synthi_browser_stop_teach");

  const trace = expectToolOk(await client.tool("synthi_browser_get_trace"), "synthi_browser_get_trace").trace;
  const tracePayload = JSON.stringify(trace);
  record(
    "record teach-mode bridge events",
    Array.isArray(trace) && trace.length >= 2 && tracePayload.includes("[REDACTED]") && !tracePayload.includes("sk-live-browser-smoke-secret-token"),
    `events=${trace?.length ?? 0}`,
  );

  const generated = expectToolOk(await client.tool("synthi_browser_generate_script"), "synthi_browser_generate_script");
  record(
    "generate replay script with locator fallbacks",
    generated.code?.includes("firstVisible") && generated.code?.includes("PLAYWRIGHT_BASE_URL") && generated.used_locators?.length >= 1,
    `locators=${generated.used_locators?.length ?? 0}`,
  );

  const released = expectToolOk(await client.tool("synthi_browser_release_lease", {
    lease_id: lease.lease_id,
    reason: "live-browser-smoke-complete",
  }), "synthi_browser_release_lease");
  record("release control lease", released.released === true);

  return { tabId, bridgeUrl: attach.bridge.url };
}

async function runWorkspaceFlow(client, attach, tabId, target) {
  await client.tool("synthi_browser_wait", {
    tab_id: tabId,
    condition: "selector",
    selector: pageLocator("body"),
    timeout_ms: 30_000,
  }, 45_000);

  const snapshot = expectToolOk(await client.tool("synthi_browser_snapshot", { tab_id: tabId }, 60_000), "synthi_browser_snapshot");
  const snap = snapshot.snapshot;
  const textSample = snap?.dom?.text_sample ?? "";
  const authScreenVisible = /sign in to access|welcome to vectant ade/i.test(textSample);
  record(
    "capture workspace screenshot and DOM",
    Boolean(snap?.screenshot_base64?.length > 1_000 && textSample.length > 20 && !authScreenVisible),
    `text=${JSON.stringify(textSample.slice(0, 80))}`,
  );

  const lease = expectToolOk(await client.tool("synthi_browser_acquire_lease", {
    owner: "live-browser-workspace",
    lease_ms: 15_000,
    reason: "exercise real Synthi workspace browser lease",
  }), "synthi_browser_acquire_lease").lease;
  record("acquire control lease", Boolean(lease?.lease_id), lease?.lease_id ?? "");

  expectToolOk(await client.tool("synthi_browser_action", {
    lease_id: lease.lease_id,
    tab_id: tabId,
    action: "click",
    selector: pageLocator("body"),
  }, 45_000), "synthi_browser_action workspace click");
  record("drive workspace through broker action", true, "body click");

  const consoleResult = expectToolOk(await client.tool("synthi_browser_get_console", { tab_id: tabId }), "synthi_browser_get_console");
  const networkResult = expectToolOk(await client.tool("synthi_browser_get_network", { tab_id: tabId }), "synthi_browser_get_network");
  record(
    "read workspace console and network through broker",
    Array.isArray(consoleResult.entries) && Array.isArray(networkResult.entries),
    `console=${consoleResult.entries?.length ?? 0} network=${networkResult.entries?.length ?? 0}`,
  );

  expectToolOk(await client.tool("synthi_browser_start_teach", { tab_id: tabId }), "synthi_browser_start_teach");
  const origin = new URL(target.url).origin;
  await postBridge(attach.bridge.url, {
    bridge_token: attach.bridge.token,
    page_origin: origin,
    type: "selection",
    payload: {
      url: target.url,
      origin,
      element: { tag: "button", role: "button", name: "Save workspace state", test_id: "workspace-save", text: "Save workspace state" },
    },
  });
  await postBridge(attach.bridge.url, {
    bridge_token: attach.bridge.token,
    page_origin: origin,
    type: "human_action",
    payload: {
      url: target.url,
      origin,
      action: "click",
      element: { tag: "button", role: "button", name: "Save workspace state", test_id: "workspace-save", css: "[data-testid=\"workspace-save\"]" },
    },
  });
  expectToolOk(await client.tool("synthi_browser_stop_teach", { reason: "workspace-live-ready" }), "synthi_browser_stop_teach");

  const trace = expectToolOk(await client.tool("synthi_browser_get_trace"), "synthi_browser_get_trace").trace;
  record("record teach-mode bridge events", Array.isArray(trace) && trace.length >= 2, `events=${trace?.length ?? 0}`);

  const generated = expectToolOk(await client.tool("synthi_browser_generate_script"), "synthi_browser_generate_script");
  record(
    "generate replay script with locator fallbacks",
    generated.code?.includes("firstVisible") && generated.code?.includes("PLAYWRIGHT_BASE_URL") && generated.used_locators?.length >= 1,
    `locators=${generated.used_locators?.length ?? 0}`,
  );

  const released = expectToolOk(await client.tool("synthi_browser_release_lease", {
    lease_id: lease.lease_id,
    reason: "workspace-live-ready",
  }), "synthi_browser_release_lease");
  record("release control lease", released.released === true);

  return { tabId, bridgeUrl: attach.bridge.url };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.target) CFG.target = args.target;
  if (args.cdpUrl) CFG.cdpUrl = args.cdpUrl;
  if (args.browserExecutable) CFG.browserExecutable = args.browserExecutable;
  if (args.frontendUrl) CFG.frontendUrl = args.frontendUrl;
  if (args.collabUrl) CFG.collabUrl = args.collabUrl;
  if (args.workspaceSlug) CFG.workspaceSlug = args.workspaceSlug;
  if (args.workspaceName) CFG.workspaceName = args.workspaceName;
  if (args.workspaceUserId) CFG.workspaceUserId = args.workspaceUserId;
  if (args.headless === false) CFG.headless = false;
  if (args.headless === true) CFG.headless = true;
  if (typeof args.keepBrowser === "boolean") CFG.keepBrowser = args.keepBrowser;
  if (CFG.target === "workspace" && typeof args.keepBrowser !== "boolean" && process.env.SYNTHI_BROWSER_SMOKE_KEEP_BROWSER === undefined) {
    CFG.keepBrowser = true;
  }
  if (!["fixture", "workspace"].includes(CFG.target)) {
    throw new Error(`unsupported browser smoke target: ${CFG.target}`);
  }

  let target;
  let browser;
  let mcp;
  try {
    target = await prepareTarget();
    log("info", `${target.kind}=${target.url}`);
    if (target.kind === "workspace") {
      log("ok", `persistent workspace ready - slug=${target.slug} files=${target.filesWritten}`);
    }

    browser = await startBrowser();
    log("info", `cdp=${browser.cdpUrl}${browser.proc ? " launched" : " existing"}`);

    mcp = await startMcp();
    const session = await runLiveFlow(mcp.client, browser.cdpUrl, target);

    if (target.kind === "workspace") {
      const artifactPath = await writeWorkspaceSessionArtifact({ target, browser, session });
      log("ok", `workspace browser MCP passed (${results.length} checks)`);
      console.log("");
      console.log("Workspace URL:");
      console.log(`  ${target.url}`);
      console.log("CDP URL:");
      console.log(`  ${browser.cdpUrl}`);
      console.log("Session artifact:");
      console.log(`  ${artifactPath}`);
      if (CFG.keepBrowser) {
        console.log("");
        console.log("Browser was left running for manual MCP testing.");
      }
      return;
    }

    log("ok", `live browser smoke passed (${results.length} checks)`);
  } finally {
    if (mcp?.proc && mcp.proc.exitCode === null) {
      mcp.proc.kill("SIGTERM");
      await sleep(250);
      if (mcp.proc.exitCode === null) mcp.proc.kill("SIGKILL");
    }
    if (target?.server) await closeServer(target.server).catch(() => undefined);
    if (browser?.proc && !CFG.keepBrowser && browser.proc.exitCode === null) {
      browser.proc.kill("SIGTERM");
      await sleep(500);
      if (browser.proc.exitCode === null) browser.proc.kill("SIGKILL");
    }
    if (browser?.profileDir && !CFG.keepBrowser) {
      await rm(browser.profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function writeWorkspaceSessionArtifact({ target, browser, session }) {
  await mkdir(SESSION_DIR, { recursive: true });
  const artifactPath = path.join(SESSION_DIR, `${target.slug}.json`);
  const payload = {
    created_at: new Date().toISOString(),
    workspace_url: target.url,
    workspace_slug: target.slug,
    frontend_url: CFG.frontendUrl,
    collab_url: CFG.collabUrl,
    cdp_url: browser.cdpUrl,
    tab_id: session?.tabId ?? null,
    bridge_url: session?.bridgeUrl ?? null,
    browser_profile_dir: browser.profileDir ?? null,
    browser_kept_alive: CFG.keepBrowser,
  };
  await writeFile(artifactPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return artifactPath;
}

main().catch((err) => {
  log("fail", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
