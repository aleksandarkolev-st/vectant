#!/usr/bin/env node
/*
 * Run the Agent Dojo Docker integration gate and emit digest-backed service
 * health evidence. The gate validates the full local compose stack expected by
 * the Vivarium Cortex plan instead of accepting a raw `docker compose ps` log.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_DOCKER_REQUIRED_SERVICES = [
  "frontend",
  "collab-server",
  "mcp",
  "worker",
  "signaling-server",
  "ai-gateway",
  "ai-engine",
  "y-sweet",
  "postgres",
  "redis",
  "coturn",
];

export const DOJO_DOCKER_HEALTHY_SERVICES = [
  "postgres",
  "redis",
  "y-sweet",
];

export const DOJO_DOCKER_REQUIRED_ENDPOINTS = [
  {
    id: "frontend_workspace",
    env: "SYNTHI_DOJO_DOCKER_WORKSPACE_URL",
    default_url: "http://127.0.0.1:3000/workspace",
    expected_status: 200,
  },
  {
    id: "collab_ports",
    env: "SYNTHI_DOJO_DOCKER_PORTS_URL",
    default_url: "http://127.0.0.1:1234/ports",
    expected_status: 200,
  },
];

export const DOJO_DOCKER_DEFAULT_COMPOSE_ENV = {
  NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS: "1",
  AI_ENGINE_HOST_PORT: "8081",
  POSTGRES_HOST_PORT: "15432",
};

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-docker-integration"));
  const artifacts = await runDojoDockerIntegrationSelfCheck({ outDir });
  console.log(`[ok] Dojo Docker integration self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoDockerIntegrationSelfCheck({
  outDir,
  now = new Date().toISOString(),
  timeoutMs = 600000,
  endpointTimeoutMs = 30000,
  env = process.env,
  checkOnly = false,
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-docker-integration"));
  await mkdir(outputDir, { recursive: true });
  const composePath = path.join(REPO_ROOT, "docker-compose.yml");
  assert.equal(existsSync(composePath), true, `missing docker compose file: ${composePath}`);

  const skipUp = truthy(checkOnly) || truthy(args["check-only"]) || truthy(env.SYNTHI_DOJO_DOCKER_SKIP_UP);
  const composeEnv = dojoDockerComposeEnv(env);
  const startedAt = performance.now();
  const stdoutChunks = [];
  const stderrChunks = [];

  let upResult = null;
  if (!skipUp) {
    upResult = spawnDocker(["compose", "up", "-d", "--build", "--force-recreate"], {
      timeoutMs,
      env: composeEnv,
    });
    stdoutChunks.push(sectionLog("docker compose up", upResult.stdout));
    stderrChunks.push(sectionLog("docker compose up", upResult.stderr));
  }

  const psResult = spawnDocker(["compose", "ps", "--format", "json"], {
    timeoutMs: 60000,
    env: composeEnv,
  });
  stdoutChunks.push(sectionLog("docker compose ps", psResult.stdout));
  stderrChunks.push(sectionLog("docker compose ps", psResult.stderr));

  const configServicesResult = spawnDocker(["compose", "config", "--services"], {
    timeoutMs: 60000,
    env: composeEnv,
  });
  stdoutChunks.push(sectionLog("docker compose config --services", configServicesResult.stdout));
  stderrChunks.push(sectionLog("docker compose config --services", configServicesResult.stderr));

  const serviceRows = parseDockerComposePsJson(psResult.stdout);
  const configuredServices = parseComposeServices(configServicesResult.stdout);
  const endpointChecks = [];
  for (const endpoint of DOJO_DOCKER_REQUIRED_ENDPOINTS) {
    endpointChecks.push(await checkEndpoint({
      endpoint,
      env: composeEnv,
      timeoutMs: endpointTimeoutMs,
    }));
  }

  const durationMs = performance.now() - startedAt;
  const stdout = stdoutChunks.filter(Boolean).join("\n");
  const stderr = stderrChunks.filter(Boolean).join("\n");
  const serviceEvaluation = evaluateDockerServices({
    serviceRows,
    configuredServices,
    requiredServices: DOJO_DOCKER_REQUIRED_SERVICES,
    healthyServices: DOJO_DOCKER_HEALTHY_SERVICES,
  });
  const commandEvaluation = {
    compose_up_ran: !skipUp,
    compose_up_exit_code: upResult ? upResult.status : null,
    compose_ps_exit_code: psResult.status,
    compose_config_exit_code: configServicesResult.status,
    compose_up_error: upResult?.error?.message ?? null,
    compose_ps_error: psResult.error?.message ?? null,
    compose_config_error: configServicesResult.error?.message ?? null,
  };
  const budgetEvaluation = buildDockerIntegrationBudgetEvaluation({
    commandEvaluation,
    serviceEvaluation,
    endpointChecks,
    durationMs,
    timeoutMs,
    skipUp,
  });
  const report = {
    schema_version: "synthi.dojo.dockerIntegrationReport.v1",
    generated_at: now,
    compose_file: "docker-compose.yml",
    command_evaluation: commandEvaluation,
    compose_env: summarizeDockerComposeEnv(composeEnv, env),
    configured_services: configuredServices,
    service_rows: serviceRows,
    service_evaluation: serviceEvaluation,
    endpoint_checks: endpointChecks,
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const stdoutPath = path.join(outputDir, "dojo-docker-integration.stdout.log");
  const stderrPath = path.join(outputDir, "dojo-docker-integration.stderr.log");
  const reportPath = path.join(outputDir, "dojo-docker-integration.report.json");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  await writeFile(reportPath, reportText);
  const evidence = buildDojoDockerIntegrationEvidenceManifest({
    now,
    durationMs,
    timeoutMs,
    endpointTimeoutMs,
    commandEvaluation,
    serviceEvaluation,
    endpointChecks,
    composeEnvSummary: summarizeDockerComposeEnv(composeEnv, env),
    reportPath,
    reportText,
    stdoutPath,
    stderrPath,
    stdout,
    stderr,
    skipUp,
  });
  const evidencePath = path.join(outputDir, "dojo-docker-integration.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (upResult?.error) throw new Error(`dojo_docker_compose_up_failed:${upResult.error.message}`);
  if (upResult && upResult.status !== 0) throw new Error(`dojo_docker_compose_up_failed:exit_${upResult.status}`);
  if (psResult.error) throw new Error(`dojo_docker_compose_ps_failed:${psResult.error.message}`);
  if (psResult.status !== 0) throw new Error(`dojo_docker_compose_ps_failed:exit_${psResult.status}`);
  if (configServicesResult.error) throw new Error(`dojo_docker_compose_config_failed:${configServicesResult.error.message}`);
  if (configServicesResult.status !== 0) throw new Error(`dojo_docker_compose_config_failed:exit_${configServicesResult.status}`);
  assert.equal(evidence.ok, true, evidence.budget_evaluation.failed_checks.join(","));
  return {
    evidence_path: evidencePath,
    report_path: reportPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    evidence,
  };
}

export function buildDojoDockerIntegrationEvidenceManifest({
  now,
  durationMs,
  timeoutMs,
  endpointTimeoutMs,
  commandEvaluation,
  serviceEvaluation,
  endpointChecks,
  composeEnvSummary,
  reportPath,
  reportText,
  stdoutPath,
  stderrPath,
  stdout,
  stderr,
  skipUp,
}) {
  const budgetEvaluation = buildDockerIntegrationBudgetEvaluation({
    commandEvaluation,
    serviceEvaluation,
    endpointChecks,
    durationMs,
    timeoutMs,
    skipUp,
  });
  return {
    schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
    generated_at: now,
    ok: budgetEvaluation.ok,
    duration_ms: Number(durationMs.toFixed(3)),
    docker_compose_up_ran: commandEvaluation.compose_up_ran,
    docker_compose_up_skipped: Boolean(skipUp),
    required_services: [...DOJO_DOCKER_REQUIRED_SERVICES],
    required_service_count: DOJO_DOCKER_REQUIRED_SERVICES.length,
    running_services: serviceEvaluation.running_services,
    missing_services: serviceEvaluation.missing_services,
    unhealthy_services: serviceEvaluation.unhealthy_services,
    healthy_services_required: [...DOJO_DOCKER_HEALTHY_SERVICES],
    endpoint_checks: endpointChecks.map((check) => ({
      id: check.id,
      url: check.url,
      expected_status: check.expected_status,
      status: check.status,
      ok: check.ok,
      duration_ms: check.duration_ms,
      error: check.error,
    })),
    endpoint_count: endpointChecks.length,
    endpoint_ok_count: endpointChecks.filter((check) => check.ok).length,
    command_evaluation: commandEvaluation,
    compose_env: composeEnvSummary,
    service_evaluation: serviceEvaluation,
    budget_evaluation: budgetEvaluation,
    report_path: reportPath,
    report_sha256: sha256(reportText),
    report_bytes: Buffer.byteLength(reportText),
    json_report_path: reportPath,
    json_report_sha256: sha256(reportText),
    json_report_bytes: Buffer.byteLength(reportText),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    budget: {
      self_check_timeout_ms: timeoutMs,
      endpoint_timeout_ms: endpointTimeoutMs,
      intended_gate: "full_local_docker_integration",
    },
  };
}

export function evaluateDockerServices({
  serviceRows,
  configuredServices,
  requiredServices = DOJO_DOCKER_REQUIRED_SERVICES,
  healthyServices = DOJO_DOCKER_HEALTHY_SERVICES,
}) {
  const rowsByService = new Map();
  for (const row of serviceRows) {
    const service = String(row.Service || row.service || "").trim();
    if (service) rowsByService.set(service, row);
  }
  const runningServices = [];
  const missingServices = [];
  const stoppedServices = [];
  const unhealthyServices = [];
  const serviceStates = [];
  for (const service of requiredServices) {
    const row = rowsByService.get(service);
    if (!row) {
      missingServices.push(service);
      serviceStates.push({ service, state: "missing", health: "missing", status: "missing" });
      continue;
    }
    const state = String(row.State || row.state || "").toLowerCase();
    const health = String(row.Health || row.health || "").toLowerCase();
    const status = String(row.Status || row.status || "");
    if (state === "running") runningServices.push(service);
    else stoppedServices.push(service);
    if (healthyServices.includes(service) && health !== "healthy") unhealthyServices.push(service);
    serviceStates.push({ service, state, health, status });
  }
  const unknownConfiguredServices = configuredServices.filter((service) => !requiredServices.includes(service));
  return {
    ok: missingServices.length === 0 && stoppedServices.length === 0 && unhealthyServices.length === 0,
    configured_services: configuredServices,
    required_services: [...requiredServices],
    running_services: runningServices,
    missing_services: missingServices,
    stopped_services: stoppedServices,
    unhealthy_services: unhealthyServices,
    unknown_configured_services: unknownConfiguredServices,
    service_states: serviceStates,
  };
}

export function parseDockerComposePsJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function buildDockerIntegrationBudgetEvaluation({
  commandEvaluation,
  serviceEvaluation,
  endpointChecks,
  durationMs,
  timeoutMs,
  skipUp,
}) {
  const checks = {
    compose_up_ran_or_explicitly_skipped: commandEvaluation.compose_up_ran === true || skipUp === true,
    compose_up_succeeded: skipUp === true || commandEvaluation.compose_up_exit_code === 0,
    compose_ps_succeeded: commandEvaluation.compose_ps_exit_code === 0,
    compose_config_succeeded: commandEvaluation.compose_config_exit_code === 0,
    all_required_services_present: serviceEvaluation.missing_services.length === 0,
    all_required_services_running: serviceEvaluation.stopped_services.length === 0,
    required_healthchecks_healthy: serviceEvaluation.unhealthy_services.length === 0,
    required_endpoints_ok: endpointChecks.length > 0 && endpointChecks.every((check) => check.ok),
    self_check_within_timeout: durationMs <= timeoutMs,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    failed_checks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  };
}

async function checkEndpoint({ endpoint, env, timeoutMs }) {
  const url = String(env[endpoint.env] || endpoint.default_url);
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const durationMs = performance.now() - started;
    return {
      id: endpoint.id,
      url,
      expected_status: endpoint.expected_status,
      status: response.status,
      ok: response.status === endpoint.expected_status,
      duration_ms: Number(durationMs.toFixed(3)),
      error: null,
    };
  } catch (err) {
    const durationMs = performance.now() - started;
    return {
      id: endpoint.id,
      url,
      expected_status: endpoint.expected_status,
      status: null,
      ok: false,
      duration_ms: Number(durationMs.toFixed(3)),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function spawnDocker(args, { timeoutMs, env }) {
  return spawnSync("docker", args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
}

export function dojoDockerComposeEnv(env = process.env) {
  const resolved = { ...env };
  for (const [key, value] of Object.entries(DOJO_DOCKER_DEFAULT_COMPOSE_ENV)) {
    if (!String(resolved[key] ?? "").trim()) resolved[key] = value;
  }
  return resolved;
}

function summarizeDockerComposeEnv(composeEnv, originalEnv) {
  return Object.fromEntries(
    Object.keys(DOJO_DOCKER_DEFAULT_COMPOSE_ENV).map((key) => [
      key,
      {
        value: String(composeEnv[key] ?? ""),
        default_applied: !String(originalEnv[key] ?? "").trim(),
      },
    ])
  );
}

function parseComposeServices(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sectionLog(label, text) {
  const body = String(text || "");
  if (!body) return "";
  return `## ${label}\n${body}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
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

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
