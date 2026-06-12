#!/usr/bin/env node
/*
 * Prove deployed Dojo MCP host conformance.
 *
 * The harness talks to a configured MCP host, selects an already-published Dojo
 * competency, proves the proof-capsule path, proves the raw backing tool is
 * blocked, revokes the issued proof capsule, and proves revocation propagation.
 *
 * Live mode intentionally requires a pre-seeded published skill. This keeps the
 * harness generic for deployed hosts and avoids smuggling repo-local workflow
 * fixtures into a production conformance gate.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  normalizeOptionalText,
  parseBooleanFlag,
  parseJsonObjectArgument,
  parseNonNegativeInteger,
} from "./private-tool-acceptance-conformance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");

export const REQUIRED_DOJO_HOST_TOOLS = [
  "synthi_dojo_list_competencies",
  "synthi_dojo_issue_proof_capsule",
  "synthi_dojo_validate_proof_capsule",
  "synthi_dojo_run_with_proof_capsule",
  "synthi_dojo_revoke_proof_capsule",
];

const RAW_BACKING_BLOCK_MARKERS = [
  "dojo_proof_capsule_required",
  "proof_capsule_missing",
  "proof_required",
  "license_kernel_blocked",
];

const REVOKED_PROOF_BLOCK_MARKERS = [
  "proof_capsule_revoked",
  "dojo_license_kernel_blocked",
  "revoked",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    log("fail", err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

async function main() {
  const config = buildDojoMcpHostConformanceConfig({ args, env: process.env });
  if (config.selfCheck) {
    const report = await runSelfCheck({ outDir: config.outDir });
    log("ok", `dojo MCP host conformance self-check passed - report=${report.report_path}`);
    return;
  }

  const hostConformance = assertMcpHostConformance(config.host);
  await mkdir(config.outDir, { recursive: true });

  const report = {
    schema_version: "synthi.dojo.mcpHostConformance.v1",
    generated_at: new Date().toISOString(),
    conformance: hostConformance,
    config: {
      requested_skill_id: config.skillId || null,
      requested_workflow_id: config.workflowId || null,
      requested_published_tool_name: config.publishedToolName || null,
      requested_action: config.requestedAction,
      execute_production: config.executeProduction,
      raw_backing_tool_required: !config.skipRawBackingToolCheck,
    },
    steps: [],
  };

  const client = await createMcpClient(config);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthi-dojo-mcp-host-conformance", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    report.steps.push({ name: "initialize", ok: true, server_info: init?.serverInfo ?? null });
    log("ok", "initialize MCP host");

    const toolsList = await client.request("tools/list", {});
    const tools = Array.isArray(toolsList?.tools) ? toolsList.tools : [];
    const advertisedNames = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    const missingTools = REQUIRED_DOJO_HOST_TOOLS.filter((name) => !advertisedNames.includes(name));
    assert.deepEqual(missingTools, [], `MCP host is missing required Dojo tools: ${missingTools.join(", ")}`);
    report.steps.push({
      name: "required Dojo tool surface advertised",
      ok: true,
      advertised_dojo_tools: REQUIRED_DOJO_HOST_TOOLS,
      total_tool_count: tools.length,
    });
    log("ok", "required Dojo tool surface advertised");

    const competenciesCall = await client.toolCall("synthi_dojo_list_competencies", {});
    assertToolOk(competenciesCall, "list Dojo competencies");
    const competencies = Array.isArray(competenciesCall.parsed?.competencies)
      ? competenciesCall.parsed.competencies
      : [];
    const competency = selectDojoCompetencyForConformance(competencies, {
      skillId: config.skillId,
      workflowId: config.workflowId,
      publishedToolName: config.publishedToolName,
      requirePublishedTool: !config.skipRawBackingToolCheck,
    });
    report.steps.push({
      name: "select published Dojo competency",
      ok: true,
      selected: competencySummary(competency),
      competency_count: competencies.length,
    });
    log("ok", `select published Dojo competency - skill=${competency.skill_id}`);

    const issueCall = await client.toolCall("synthi_dojo_issue_proof_capsule", {
      skill_id: competency.skill_id,
      requested_action: config.requestedAction,
      context_claims: config.contextClaims,
      ...(config.evidenceClaims ? { evidence_claims: config.evidenceClaims } : {}),
      substrate_claim: config.substrateClaim,
    });
    assertToolOk(issueCall, "issue proof capsule");
    const proofCapsule = issueCall.parsed?.proof_capsule;
    assert(proofCapsule && typeof proofCapsule === "object", "proof issue did not return proof_capsule");
    report.steps.push({
      name: "issue proof capsule",
      ok: true,
      proof_capsule_id: proofCapsule.capsule_id,
      validation: summarizeValidation(issueCall.parsed?.validation),
    });
    log("ok", `issue proof capsule - capsule=${proofCapsule.capsule_id}`);

    const validateCall = await client.toolCall("synthi_dojo_validate_proof_capsule", {
      skill_id: competency.skill_id,
      requested_action: config.requestedAction,
      proof_capsule: proofCapsule,
      tool_args: config.toolArgs,
    });
    assertToolOk(validateCall, "validate proof capsule");
    report.steps.push({
      name: "validate proof capsule",
      ok: true,
      license_kernel: summarizeLicenseKernel(validateCall.parsed?.license_kernel),
    });
    log("ok", "validate proof capsule");

    const runCall = await client.toolCall("synthi_dojo_run_with_proof_capsule", {
      skill_id: competency.skill_id,
      requested_action: config.requestedAction,
      proof_capsule: proofCapsule,
      tool_args: config.toolArgs,
      dry_run: !config.executeProduction,
    });
    assertToolOk(runCall, config.executeProduction ? "execute proof-gated Dojo skill" : "dry-run proof-gated Dojo skill");
    report.steps.push({
      name: config.executeProduction ? "execute proof-gated Dojo skill" : "dry-run proof-gated Dojo skill",
      ok: true,
      dry_run: !config.executeProduction,
      result: summarizeCall(runCall),
    });
    log("ok", `${config.executeProduction ? "execute" : "dry-run"} proof-gated Dojo skill`);

    if (!config.skipRawBackingToolCheck) {
      const toolName = String(competency.published_tool_name || "");
      assert(toolName, "selected competency has no published_tool_name for raw backing-tool block check");
      const rawCall = await client.toolCall(toolName, config.rawToolArgs);
      assert(
        isExpectedBlockedToolCall(rawCall, RAW_BACKING_BLOCK_MARKERS),
        `raw backing tool was not blocked as expected: ${JSON.stringify(summarizeCall(rawCall))}`,
      );
      report.steps.push({
        name: "raw backing tool blocked outside Dojo proof path",
        ok: true,
        tool_name: toolName,
        result: summarizeCall(rawCall),
      });
      log("ok", `raw backing tool blocked outside Dojo proof path - ${toolName}`);
    }

    const revokeCall = await client.toolCall("synthi_dojo_revoke_proof_capsule", {
      capsule_id: proofCapsule.capsule_id,
      reason: config.revocationReason,
    });
    assertToolOk(revokeCall, "revoke proof capsule");
    report.steps.push({
      name: "revoke proof capsule",
      ok: true,
      proof_capsule_id: proofCapsule.capsule_id,
      proof_record_status: revokeCall.parsed?.proof_record?.status ?? null,
    });
    log("ok", "revoke proof capsule");

    const validateRevokedCall = await client.toolCall("synthi_dojo_validate_proof_capsule", {
      skill_id: competency.skill_id,
      requested_action: config.requestedAction,
      proof_capsule: proofCapsule,
      tool_args: config.toolArgs,
    });
    assert(
      isExpectedBlockedToolCall(validateRevokedCall, REVOKED_PROOF_BLOCK_MARKERS),
      `revoked proof validation was not blocked: ${JSON.stringify(summarizeCall(validateRevokedCall))}`,
    );
    report.steps.push({
      name: "revoked proof validation blocked",
      ok: true,
      result: summarizeCall(validateRevokedCall),
    });
    log("ok", "revoked proof validation blocked");

    const runRevokedCall = await client.toolCall("synthi_dojo_run_with_proof_capsule", {
      skill_id: competency.skill_id,
      requested_action: config.requestedAction,
      proof_capsule: proofCapsule,
      tool_args: config.toolArgs,
      dry_run: true,
    });
    assert(
      isExpectedBlockedToolCall(runRevokedCall, REVOKED_PROOF_BLOCK_MARKERS),
      `revoked proof run was not blocked: ${JSON.stringify(summarizeCall(runRevokedCall))}`,
    );
    report.steps.push({
      name: "revoked proof run blocked",
      ok: true,
      result: summarizeCall(runRevokedCall),
    });
    log("ok", "revoked proof run blocked");

    report.release_gate = buildConformanceReleaseGateSummary(report);
    const artifacts = await writeConformanceArtifacts(config.outDir, report);
    log("ok", `Dojo MCP host conformance passed - report=${artifacts.report_path} manifest=${artifacts.manifest_path}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function buildDojoMcpHostConformanceConfig({ args = {}, env = process.env } = {}) {
  const mcpHostUrl = args["mcp-host-url"] || env.SYNTHI_DOJO_MCP_HOST_URL || env.SYNTHI_MCP_HOST_URL || "";
  const transport = args["transport"]
    || env.SYNTHI_DOJO_MCP_CONFORMANCE_TRANSPORT
    || (mcpHostUrl ? "http-json-rpc" : "stdio");
  const outDir = path.resolve(args["out-dir"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_OUT_DIR || path.join(REPO_ROOT, "tmp", "dojo-mcp-host-conformance"));
  const timeoutMs = parseNonNegativeInteger(args["timeout-ms"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_TIMEOUT_MS || "60000", "timeout_ms");
  return {
    selfCheck: parseBooleanFlag(args["self-check"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_SELF_CHECK),
    outDir,
    timeoutMs,
    host: {
      transport,
      mcpHostUrl,
      bearerToken: args["mcp-bearer-token"] || env.SYNTHI_DOJO_MCP_BEARER_TOKEN || "",
      commandSpec: resolveMcpCommandSpec({ args, env }),
      requireNonLoopbackMcpHost: parseBooleanFlag(args["require-non-loopback-mcp-host"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_NON_LOOPBACK_HOST),
      allowCustomStdioHost: parseBooleanFlag(args["allow-custom-stdio-host"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ALLOW_CUSTOM_STDIO_HOST),
    },
    skillId: args["skill-id"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_SKILL_ID || "",
    workflowId: args["workflow-id"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_WORKFLOW_ID || "",
    publishedToolName: args["published-tool-name"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_PUBLISHED_TOOL_NAME || "",
    requestedAction: args["requested-action"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_REQUESTED_ACTION || "run_workflow",
    substrateClaim: args["substrate-claim"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_SUBSTRATE_CLAIM || "mcp",
    contextClaims: parseJsonObjectArgument(args["context-claims-json"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_CONTEXT_CLAIMS_JSON || "{\"workspace_verified\":true}", "context_claims"),
    evidenceClaims: parseOptionalJsonArray(args["evidence-claims-json"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_EVIDENCE_CLAIMS_JSON, "evidence_claims"),
    toolArgs: parseJsonObjectArgument(args["tool-args-json"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_TOOL_ARGS_JSON || "{}", "tool_args"),
    rawToolArgs: parseJsonObjectArgument(args["raw-tool-args-json"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_RAW_TOOL_ARGS_JSON || "{}", "raw_tool_args"),
    executeProduction: parseBooleanFlag(args["execute-production"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_EXECUTE_PRODUCTION),
    skipRawBackingToolCheck: parseBooleanFlag(args["skip-raw-backing-tool-check"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_SKIP_RAW_BACKING_TOOL_CHECK),
    revocationReason: normalizeOptionalText(args["revocation-reason"] ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_REASON) || "dojo_mcp_host_conformance",
  };
}

export function resolveMcpCommandSpec({
  args = {},
  env = process.env,
  defaultCommand = process.execPath,
  defaultArgs = [DIST_INDEX],
  defaultCwd = MCP_ROOT,
} = {}) {
  const hasCustomCommand = Boolean(args["mcp-command"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_MCP_COMMAND);
  const command = String(args["mcp-command"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_MCP_COMMAND || defaultCommand).trim();
  if (!command) throw new Error("mcp_command_required");
  const argsJson = args["mcp-args-json"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_MCP_ARGS_JSON;
  const commandArgs = argsJson
    ? parseJsonStringArray(argsJson, "mcp_args_json")
    : hasCustomCommand
    ? []
    : [...defaultArgs];
  const cwd = path.resolve(String(args["mcp-cwd"] || env.SYNTHI_DOJO_MCP_CONFORMANCE_MCP_CWD || defaultCwd));
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

export function mcpHostConformance({ transport, mcpHostUrl = "", commandSpec, requireNonLoopbackMcpHost = false, allowCustomStdioHost = false }) {
  const normalizedTransport = String(transport || "").trim();
  const requireNonLoopback = Boolean(requireNonLoopbackMcpHost);
  if (normalizedTransport === "http-json-rpc") {
    const hostClass = classifyMcpHost(mcpHostUrl);
    return {
      ok: !requireNonLoopback || hostClass === "remote",
      transport: normalizedTransport,
      require_non_loopback_mcp_host: requireNonLoopback,
      non_loopback_mcp_host: hostClass === "remote",
      mcp_host_class: hostClass,
    };
  }
  if (normalizedTransport === "stdio") {
    const customStdio = commandSpec?.default_repo_dist === false;
    return {
      ok: !requireNonLoopback || (allowCustomStdioHost && customStdio),
      transport: normalizedTransport,
      require_non_loopback_mcp_host: requireNonLoopback,
      non_loopback_mcp_host: false,
      mcp_host_class: customStdio ? "custom-stdio" : "repo-stdio",
      allow_custom_stdio_host: Boolean(allowCustomStdioHost),
      custom_stdio_host: customStdio,
    };
  }
  return {
    ok: false,
    transport: normalizedTransport || "missing",
    require_non_loopback_mcp_host: requireNonLoopback,
    non_loopback_mcp_host: false,
    mcp_host_class: "unsupported-transport",
  };
}

export function assertMcpHostConformance(host) {
  const conformance = mcpHostConformance(host);
  if (!conformance.ok) {
    throw new Error(
      "non_loopback_mcp_host_required: pass --mcp-host-url with a non-loopback HTTP JSON-RPC endpoint, "
      + "or use --transport stdio --mcp-command ... --allow-custom-stdio-host for an explicitly deployed stdio wrapper",
    );
  }
  return conformance;
}

export function classifyMcpHost(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unsupported-url";
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.")) return "loopback";
    if (host === "0.0.0.0" || host === "::" || host === "[::]") return "local-bind";
    return "remote";
  } catch {
    return "invalid";
  }
}

export function selectDojoCompetencyForConformance(
  competencies,
  { skillId = "", workflowId = "", publishedToolName = "", requirePublishedTool = true } = {},
) {
  const items = Array.isArray(competencies) ? competencies.filter((item) => item && typeof item === "object") : [];
  const filtered = items.filter((item) => {
    if (skillId && item.skill_id !== skillId) return false;
    if (workflowId && item.workflow_id !== workflowId) return false;
    if (publishedToolName && item.published_tool_name !== publishedToolName) return false;
    if (requirePublishedTool && !item.published_tool_name) return false;
    return true;
  });
  if (filtered.length === 0) {
    throw new Error("dojo_competency_missing: publish a Dojo skill first or pass --skill-id/--workflow-id/--published-tool-name");
  }
  if (skillId || workflowId || publishedToolName || filtered.length === 1) return filtered[0];
  throw new Error(`dojo_competency_ambiguous: pass --skill-id (${filtered.map((item) => item.skill_id).join(", ")})`);
}

export function isExpectedBlockedToolCall(call, markers = []) {
  const parsed = call?.parsed ?? call ?? {};
  const text = JSON.stringify({ isError: call?.isError === true, parsed, result: call?.result ?? null });
  const blocked = call?.isError === true
    || parsed?.ok === false
    || parsed?.validation?.ok === false
    || parsed?.license_kernel?.ok === false
    || typeof parsed?.error === "string";
  if (!blocked) return false;
  if (!markers.length) return true;
  return markers.some((marker) => text.includes(marker));
}

async function createMcpClient(config) {
  if (config.host.transport === "http-json-rpc") {
    return new HttpJsonRpcClient({
      endpoint: config.host.mcpHostUrl,
      bearerToken: config.host.bearerToken,
      timeoutMs: config.timeoutMs,
    });
  }
  if (config.host.transport === "stdio") {
    const proc = spawn(config.host.commandSpec.command, config.host.commandSpec.args, {
      cwd: config.host.commandSpec.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new StdioJsonRpcClient(proc, { timeoutMs: config.timeoutMs, label: "dojo-mcp-host-conformance" });
  }
  throw new Error(`unsupported_mcp_transport:${config.host.transport}`);
}

class HttpJsonRpcClient {
  constructor({ endpoint, bearerToken, timeoutMs }) {
    this.endpoint = endpoint;
    this.bearerToken = bearerToken;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const response = await fetchWithTimeout(this.endpoint, {
      timeoutMs: this.timeoutMs,
      bearerToken: this.bearerToken,
      body: { jsonrpc: "2.0", id, method, params },
    });
    if (response.error) throw new Error(`${response.error.code ?? "json_rpc_error"}: ${response.error.message ?? "unknown"}`);
    return response.result;
  }

  notify(method, params = {}) {
    return fetchWithTimeout(this.endpoint, {
      timeoutMs: Math.min(this.timeoutMs, 10_000),
      bearerToken: this.bearerToken,
      body: { jsonrpc: "2.0", method, params },
    }).catch(() => undefined);
  }

  async toolCall(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    return normalizeToolCallResult(result);
  }

  async close() {
    await this.request("shutdown", {}).catch(() => undefined);
    await this.notify("exit", {});
  }
}

class StdioJsonRpcClient {
  constructor(proc, { timeoutMs, label }) {
    this.proc = proc;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    proc.stderr.on("data", (chunk) => process.stderr.write(`[${this.label} stderr] ${String(chunk)}`));
    proc.once("exit", (code, signal) => {
      for (const [, pending] of this.pending) pending.reject(new Error(`${this.label} exited before response: code=${code} signal=${signal}`));
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
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
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
    return normalizeToolCallResult(result);
  }

  async close() {
    await this.request("shutdown", {}).catch(() => undefined);
    this.notify("exit", {});
    if (!this.proc.killed) this.proc.kill("SIGTERM");
  }
}

function normalizeToolCallResult(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { isError: result?.isError === true, parsed, result };
}

function assertToolOk(call, label) {
  assert.equal(call.isError, false, `${label} returned MCP isError: ${JSON.stringify(call.parsed)}`);
  assert.equal(call.parsed?.ok, true, `${label} did not return ok=true: ${JSON.stringify(call.parsed)}`);
}

function summarizeValidation(validation) {
  if (!validation || typeof validation !== "object") return null;
  return {
    ok: validation.ok === true,
    status: validation.status ?? null,
    error: validation.error ?? null,
    blocked_by: Array.isArray(validation.blocked_by) ? validation.blocked_by : [],
    error_codes: Array.isArray(validation.error_codes) ? validation.error_codes : [],
  };
}

function summarizeLicenseKernel(kernel) {
  if (!kernel || typeof kernel !== "object") return null;
  return {
    ok: kernel.ok === true,
    status: kernel.status ?? null,
    blocked_by: Array.isArray(kernel.blocked_by) ? kernel.blocked_by : [],
    error_codes: Array.isArray(kernel.error_codes) ? kernel.error_codes : [],
    validation: summarizeValidation(kernel.validation),
  };
}

function summarizeCall(call) {
  return {
    is_error: call?.isError === true,
    ok: call?.parsed?.ok === true,
    error: call?.parsed?.error ?? null,
    validation: summarizeValidation(call?.parsed?.validation),
    license_kernel: summarizeLicenseKernel(call?.parsed?.license_kernel),
    proof_record_status: call?.parsed?.proof_record?.status ?? null,
    result_keys: call?.parsed?.result && typeof call.parsed.result === "object" ? Object.keys(call.parsed.result).sort() : [],
  };
}

function competencySummary(competency) {
  return {
    skill_id: competency.skill_id,
    workflow_id: competency.workflow_id ?? null,
    name: competency.name ?? null,
    published_tool_name: competency.published_tool_name ?? null,
    entrustment_level: competency.entrustment_level ?? null,
    skill_readiness_level: competency.skill_readiness_level ?? null,
  };
}

export function redactConformanceReport(report) {
  const clone = JSON.parse(JSON.stringify(report));
  const text = JSON.stringify(clone);
  if (/hmac-sha256:|-----BEGIN|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(text)) {
    throw new Error("dojo_mcp_host_conformance_report_contains_secret_material");
  }
  return clone;
}

export function buildConformanceReleaseGateSummary(report) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const hasStep = (name) => steps.some((step) => step?.name === name && step?.ok === true);
  const rawBackingRequired = report?.config?.raw_backing_tool_required !== false;
  const checks = [
    { id: "mcp_initialize", ok: hasStep("initialize") },
    { id: "required_dojo_tool_surface", ok: hasStep("required Dojo tool surface advertised") },
    { id: "published_competency_selected", ok: hasStep("select published Dojo competency") },
    { id: "proof_capsule_issued", ok: hasStep("issue proof capsule") },
    { id: "proof_capsule_validated", ok: hasStep("validate proof capsule") },
    {
      id: "proof_gated_run",
      ok: hasStep("dry-run proof-gated Dojo skill") || hasStep("execute proof-gated Dojo skill"),
    },
    rawBackingRequired
      ? { id: "raw_backing_tool_blocked", ok: hasStep("raw backing tool blocked outside Dojo proof path") }
      : { id: "raw_backing_tool_blocked", ok: true, skipped: true },
    { id: "proof_capsule_revoked", ok: hasStep("revoke proof capsule") },
    { id: "revoked_proof_validation_blocked", ok: hasStep("revoked proof validation blocked") },
    { id: "revoked_proof_run_blocked", ok: hasStep("revoked proof run blocked") },
  ];
  return {
    ok: checks.every((check) => check.ok === true),
    passed: checks.filter((check) => check.ok === true && !check.skipped).length,
    skipped: checks.filter((check) => check.skipped === true).length,
    failed: checks.filter((check) => check.ok !== true).length,
    checks,
  };
}

export function buildConformanceEvidenceManifest({ report, reportPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(report);
  return {
    schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
    generated_at: new Date().toISOString(),
    report_path: reportPath,
    report_sha256: sha256(body),
    report_bytes: Buffer.byteLength(body),
    gate_ok: report?.release_gate?.ok === true,
    gate_failed: Number(report?.release_gate?.failed ?? 0),
    step_count: Array.isArray(report?.steps) ? report.steps.length : 0,
    mcp_host_class: report?.conformance?.mcp_host_class ?? null,
    non_loopback_mcp_host: report?.conformance?.non_loopback_mcp_host === true,
    raw_backing_tool_required: report?.config?.raw_backing_tool_required !== false,
  };
}

async function writeConformanceArtifacts(outDir, report) {
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "dojo-mcp-host-conformance.json");
  const manifestPath = path.join(outDir, "dojo-mcp-host-conformance.evidence.json");
  const redacted = redactConformanceReport(report);
  const serialized = JSON.stringify(redacted, null, 2);
  const manifest = redactConformanceReport(buildConformanceEvidenceManifest({
    report: redacted,
    reportPath,
    serialized,
  }));
  await writeFile(reportPath, serialized);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { report_path: reportPath, manifest_path: manifestPath, report: redacted, manifest };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runSelfCheck({ outDir }) {
  assert.equal(classifyMcpHost("http://127.0.0.1:3000/mcp"), "loopback");
  assert.equal(classifyMcpHost("https://mcp.example.test/mcp"), "remote");
  assert.equal(mcpHostConformance({
    transport: "http-json-rpc",
    mcpHostUrl: "https://mcp.example.test/mcp",
    requireNonLoopbackMcpHost: true,
  }).ok, true);
  assert.equal(mcpHostConformance({
    transport: "http-json-rpc",
    mcpHostUrl: "http://localhost:3000/mcp",
    requireNonLoopbackMcpHost: true,
  }).ok, false);
  const selected = selectDojoCompetencyForConformance([
    { skill_id: "skill_a", workflow_id: "workflow_a", published_tool_name: "synthi_app_a" },
    { skill_id: "skill_b", workflow_id: "workflow_b", published_tool_name: "synthi_app_b" },
  ], { skillId: "skill_b" });
  assert.equal(selected.published_tool_name, "synthi_app_b");
  assert.equal(isExpectedBlockedToolCall({
    isError: false,
    parsed: { ok: false, error: "dojo_proof_capsule_required", error_codes: ["proof_capsule_missing"] },
  }, RAW_BACKING_BLOCK_MARKERS), true);
  assert.equal(isExpectedBlockedToolCall({
    isError: false,
    parsed: { ok: true },
  }, RAW_BACKING_BLOCK_MARKERS), false);

  const report = redactConformanceReport({
    schema_version: "synthi.dojo.mcpHostConformance.selfCheck.v1",
    generated_at: new Date().toISOString(),
    conformance: {
      ok: true,
      mcp_host_class: "remote",
      non_loopback_mcp_host: true,
    },
    config: {
      raw_backing_tool_required: true,
    },
    steps: [
      { name: "initialize", ok: true },
      { name: "required Dojo tool surface advertised", ok: true },
      { name: "select published Dojo competency", ok: true },
      { name: "issue proof capsule", ok: true },
      { name: "validate proof capsule", ok: true },
      { name: "dry-run proof-gated Dojo skill", ok: true },
      { name: "raw backing tool blocked outside Dojo proof path", ok: true },
      { name: "revoke proof capsule", ok: true },
      { name: "revoked proof validation blocked", ok: true },
      { name: "revoked proof run blocked", ok: true },
    ],
    checks: [
      "remote host classification",
      "loopback rejection",
      "competency selection",
      "blocked call detection",
      "report redaction",
    ],
  });
  report.release_gate = buildConformanceReleaseGateSummary(report);
  const artifacts = await writeConformanceArtifacts(outDir, report);
  return { report_path: artifacts.report_path, manifest_path: artifacts.manifest_path, report: artifacts.report, manifest: artifacts.manifest };
}

async function fetchWithTimeout(endpoint, { timeoutMs, bearerToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`mcp_http_error:${response.status}:${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`mcp_http_invalid_json:${text.slice(0, 500)}`);
    }
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

function parseOptionalJsonArray(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}_must_be_array`);
  return parsed;
}

function parseJsonStringArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label}_invalid`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label}_must_be_string_array`);
  }
  return parsed;
}

function log(kind, message) {
  const tag = kind === "ok" ? "[ok]" : kind === "fail" ? "[fail]" : "[info]";
  console.log(`${tag} ${message}`);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
