#!/usr/bin/env node
/*
 * Prove private workflow acceptance across the real MCP stdio boundary.
 *
 * The harness seeds the encrypted saved-workflow store with one generic
 * workflow artifact, spawns a configurable stdio MCP server command, discovers
 * the private tool from tools/list, and calls it through tools/call against a
 * real browser target.
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
  requireCustomMcpCommand: parseBooleanFlag(args["require-custom-mcp-command"] ?? process.env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_REQUIRE_CUSTOM_MCP_COMMAND),
  mcpCommand: resolveMcpServerCommandSpec({
    args,
    env: process.env,
    defaultCommand: process.execPath,
    defaultArgs: [DIST_INDEX],
    defaultCwd: MCP_ROOT,
  }),
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
  const mcpCommandConformance = assertMcpCommandConformance({
    commandSpec: CFG.mcpCommand,
    requireCustomCommand: CFG.requireCustomMcpCommand,
  });

  await mkdir(CFG.outDir, { recursive: true });
  const fixture = CFG.targetUrl ? null : await startFixtureServer();
  const targetUrl = CFG.targetUrl || fixture.url;
  const workspaceId = CFG.workspaceId || `stdio-private-tool-acceptance-${process.pid}`;
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "synthi-private-tool-stdio-"));
  const storeFile = path.join(artifactDir, "private-tools.enc.json");
  const storeKey = `stdio-acceptance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storeScope = `stdio-acceptance-${process.pid}`;
  const authStoreFile = path.join(artifactDir, "auth-checkpoints.enc.json");
  const authStoreKey = `stdio-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const secretValues = [storeKey, authStoreKey, CFG.cdpUrl];
  const transcript = {
    generated_at: new Date().toISOString(),
    cdp_url: redactCdpUrl(CFG.cdpUrl),
    target_url: targetUrl,
    workspace_id: workspaceId,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    mcp_server: {
      command: CFG.mcpCommand.command,
      cwd: CFG.mcpCommand.cwd,
      args_count: CFG.mcpCommand.args.length,
      default_repo_dist: CFG.mcpCommand.default_repo_dist,
    },
    conformance: {
      require_custom_mcp_command: mcpCommandConformance.require_custom_mcp_command,
      custom_mcp_command: mcpCommandConformance.custom_mcp_command,
    },
    steps: [],
  };

  let client;
  let proc;
  try {
    const seeded = await seedPrivateWorkflowStore({ storeFile, storeKey, storeScope, targetUrl });
    transcript.seeded = seeded;
    log("ok", `seed private workflow store - tool=${seeded.tool_name}`);

    await pruneExistingCdpPageTargets(CFG.cdpUrl);
    proc = spawn(CFG.mcpCommand.command, CFG.mcpCommand.args, {
      cwd: CFG.mcpCommand.cwd,
      env: buildStdioMcpEnv({
        baseEnv: process.env,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: storeFile,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: storeKey,
        SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: storeScope,
        SYNTHI_AUTH_CHECKPOINT_STORE_FILE: authStoreFile,
        SYNTHI_AUTH_CHECKPOINT_STORE_KEY: authStoreKey,
        SYNTHI_AUTH_CHECKPOINT_SCOPE: storeScope,
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

    const readiness = await client.toolCall("synthi_browser_get_deployment_readiness", {
      mode: "production",
      workspace_id: workspaceId,
      require_workflow_bridge: false,
    });
    assertToolOk(readiness, "deployment readiness");
    assert.equal(readiness.parsed?.readiness?.ok, true, "production readiness should pass for hosted runtime, scoped encrypted stores, and no local CDP env");
    assertReadinessCheck(readiness.parsed?.readiness, "hosted_browser_runtime", "pass");
    assertReadinessCheck(readiness.parsed?.readiness, "private_workflow_tool_store", "pass");
    assertReadinessCheck(readiness.parsed?.readiness, "auth_checkpoint_store", "pass");
    assertReadinessCheck(readiness.parsed?.readiness, "local_cdp_env_absent", "pass");
    assertNoSecretLeak(readiness.parsed, secretValues, "deployment readiness");
    transcript.steps.push({
      name: "production-style deployment readiness through MCP",
      ok: true,
      readiness: readiness.parsed?.readiness ?? null,
      workflow_bridge_required: false,
    });
    log("ok", "production-style deployment readiness through MCP");

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

    const strictRejectedScriptPath = strictHostValidateToolArgs(privateTool.inputSchema, {
      script_path: "generated-workflow-script-is-not-a-tool-argument",
    });
    assert.deepEqual(strictRejectedScriptPath, ["additional_property:script_path"]);
    const strictRejectedRunMode = strictHostValidateToolArgs(privateTool.inputSchema, {
      run_mode: "desktopChrome",
    });
    assert.deepEqual(strictRejectedRunMode, ["enum:run_mode"]);
    const strictAcceptedCall = strictHostValidateToolArgs(privateTool.inputSchema, {});
    assert.deepEqual(strictAcceptedCall, []);
    transcript.steps.push({
      name: "strict host schema validation before execution",
      ok: true,
      rejected: [
        { arguments: ["script_path"], errors: strictRejectedScriptPath },
        { arguments: ["run_mode"], errors: strictRejectedRunMode },
      ],
      accepted_empty_call: true,
    });
    log("ok", "strict host schema validation before execution");

    const registryList = await client.toolCall("synthi_browser_list_private_tools", {});
    assertToolOk(registryList, "list private tools registry");
    const registryTools = Array.isArray(registryList.parsed?.tools) ? registryList.parsed.tools : [];
    const registryTool = registryTools.find((tool) => tool?.tool_name === privateTool.name);
    assert(registryTool, `private registry did not include ${privateTool.name}`);
    assert.deepEqual(registryTool?.tool?.inputSchema, privateTool.inputSchema);
    assertNoSecretLeak(registryList.parsed, secretValues, "private tool registry");
    transcript.steps.push({
      name: "discover private workflow registry through MCP",
      ok: true,
      count: registryTools.length,
      tool_name: registryTool.tool_name,
      run_modes: registryTool.run_modes,
      product_path: registryList.parsed?.product_path ?? null,
    });
    log("ok", "discover private workflow registry through MCP");

    const manifestLookup = await client.toolCall("synthi_browser_get_private_tool_manifest", { tool_name: privateTool.name });
    assertToolOk(manifestLookup, "manifest lookup");
    assert.equal(manifestLookup.parsed?.tool_name, privateTool.name);
    assertNoSecretLeak(manifestLookup.parsed, secretValues, "private tool manifest");
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

function assertReadinessCheck(readiness, id, expectedStatus) {
  const check = readiness?.checks?.find((item) => item?.id === id);
  assert(check, `deployment readiness check missing: ${id}`);
  assert.equal(check.status, expectedStatus, `deployment readiness check ${id} expected ${expectedStatus}: ${JSON.stringify(check)}`);
}

function assertNoSecretLeak(value, secrets, label) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    assert(!text.includes(secret), `${label} leaked secret value`);
  }
}

export function strictHostValidateToolArgs(schema, args) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["schema_not_object"];
  const errors = [];
  if (schema.type !== "object") errors.push("schema_type_not_object");
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item) => typeof item === "string")
    : [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) errors.push(`missing_required:${name}`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) errors.push(`additional_property:${name}`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property || typeof property !== "object" || Array.isArray(property)) continue;
    if (property.type === "string" && typeof value !== "string") errors.push(`type:${name}`);
    if (property.type === "boolean" && typeof value !== "boolean") errors.push(`type:${name}`);
    if (property.type === "number" && typeof value !== "number") errors.push(`type:${name}`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) errors.push(`enum:${name}`);
    if (typeof property.pattern === "string" && typeof value === "string") {
      const pattern = new RegExp(property.pattern);
      if (!pattern.test(value)) errors.push(`pattern:${name}`);
    }
  }
  return errors;
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

export function resolveMcpServerCommandSpec({
  args = {},
  env = process.env,
  defaultCommand = process.execPath,
  defaultArgs = [DIST_INDEX],
  defaultCwd = MCP_ROOT,
} = {}) {
  const hasCustomCommand = Boolean(args["mcp-command"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND);
  const command = String(args["mcp-command"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND || defaultCommand).trim();
  if (!command) throw new Error("mcp_command_required");
  const argsJson = args["mcp-args-json"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON;
  const commandArgs = argsJson
    ? parseMcpCommandArgsJson(argsJson)
    : hasCustomCommand
    ? []
    : [...defaultArgs];
  const cwdRaw = args["mcp-cwd"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD || defaultCwd;
  const cwd = path.resolve(String(cwdRaw));
  return {
    command,
    args: commandArgs,
    cwd,
    default_repo_dist: command === defaultCommand
      && commandArgs.length === defaultArgs.length
      && commandArgs.every((item, index) => item === defaultArgs[index])
      && cwd === path.resolve(defaultCwd),
  };
}

export function mcpCommandConformance({ commandSpec, requireCustomCommand = false }) {
  const customMcpCommand = commandSpec?.default_repo_dist === false;
  const requireCustom = Boolean(requireCustomCommand);
  return {
    ok: !requireCustom || customMcpCommand,
    require_custom_mcp_command: requireCustom,
    custom_mcp_command: customMcpCommand,
  };
}

function assertMcpCommandConformance({ commandSpec, requireCustomCommand }) {
  const conformance = mcpCommandConformance({ commandSpec, requireCustomCommand });
  if (!conformance.ok) {
    throw new Error("custom_mcp_command_required: pass --mcp-command with --mcp-args-json, or set SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND, before using this harness as a deployed-host conformance gate");
  }
  return conformance;
}

export function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

function parseMcpCommandArgsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("mcp_args_json_invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("mcp_args_json_must_be_string_array");
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
