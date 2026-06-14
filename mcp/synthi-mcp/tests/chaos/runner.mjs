#!/usr/bin/env node
//
// Deterministic chaos scenario harness.
//
// The long-running Docker/network chaos suite can still use this dispatcher,
// but the repo also needs a lightweight preflight that executes concrete
// fail-closed/fault scenarios without depending on external services.

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(MCP_ROOT, "../..");

export function parseArgs(argv) {
  const opts = {
    only: null,
    iterations: 1,
    listOnly: false,
    jsonPath: null,
    requireScenarios: false,
    timeoutMs: 120000,
    artifactDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") opts.only = argv[++i] ?? null;
    else if (arg === "--iterations") opts.iterations = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === "--list") opts.listOnly = true;
    else if (arg === "--json") opts.jsonPath = argv[++i] ?? null;
    else if (arg === "--require-scenarios") opts.requireScenarios = true;
    else if (arg === "--timeout-ms") opts.timeoutMs = Math.max(1, Number(argv[++i]) || 120000);
    else if (arg === "--artifact-dir") opts.artifactDir = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        [
          "chaos runner - execute deterministic fault-injection scenarios.",
          "",
          "  --only <name>         run a single scenario by file name without .mjs",
          "  --iterations <n>      repeat each scenario n times; default 1",
          "  --list                enumerate scenarios without running",
          "  --json <path>         write a machine-readable report",
          "  --require-scenarios   fail if no concrete scenarios are present",
          "  --timeout-ms <n>      per-scenario command timeout; default 120000",
          "  --artifact-dir <dir>  directory for scenario artifacts",
          "",
          "Env:",
          "  SYNTHI_SIGNALING_URL   signaling websocket to exercise; default ws://localhost:9000",
          "  SYNTHI_CHAOS_DOCKER_PROJECT   docker-compose project for live chaos scenarios",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return opts;
}

export async function loadScenarios(only) {
  const dir = join(__dirname, "scenarios");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const modules = [];
  for (const fileName of files.sort()) {
    if (!fileName.endsWith(".mjs")) continue;
    if (fileName.startsWith("_")) continue;
    if (only && fileName !== `${only}.mjs`) continue;
    const mod = await import(pathToFileURL(join(dir, fileName)).href);
    if (typeof mod.default !== "object" || !mod.default) continue;
    const scenario = mod.default;
    if (typeof scenario.name !== "string" || typeof scenario.run !== "function") {
      process.stderr.write(`chaos: skipping ${fileName} - does not match scenario shape\n`);
      continue;
    }
    modules.push(scenario);
  }
  return modules;
}

export async function runOne(scenario, iteration, opts = {}) {
  const label = `${scenario.name}#${iteration}`;
  const start = Date.now();
  const artifactDir = resolve(opts.artifactDir ?? join(REPO_ROOT, "tmp", "dojo-chaos-runner"));
  const ctx = {
    repoRoot: REPO_ROOT,
    mcpRoot: MCP_ROOT,
    signalingUrl: process.env.SYNTHI_SIGNALING_URL ?? "ws://localhost:9000",
    dockerProject: process.env.SYNTHI_CHAOS_DOCKER_PROJECT ?? null,
    iteration,
    timeoutMs: opts.timeoutMs ?? 120000,
    artifactDir,
  };
  try {
    await mkdir(artifactDir, { recursive: true });
    const evidence = await scenario.run(ctx);
    const elapsed = Date.now() - start;
    process.stdout.write(`PASS ${label} (${elapsed}ms)\n`);
    return {
      ok: true,
      name: label,
      scenario: scenario.name,
      description: scenario.description ?? "",
      iteration,
      duration_ms: elapsed,
      evidence: evidence ?? null,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    process.stdout.write(`FAIL ${label} (${elapsed}ms): ${err?.message ?? err}\n`);
    return {
      ok: false,
      name: label,
      scenario: scenario.name,
      description: scenario.description ?? "",
      iteration,
      duration_ms: elapsed,
      error: err?.stack ?? err?.message ?? String(err),
    };
  }
}

export async function runChaosSuite(opts = parseArgs([])) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const scenarios = await loadScenarios(opts.only);

  if (opts.listOnly) {
    for (const scenario of scenarios) {
      process.stdout.write(`${scenario.name}\t${scenario.description ?? ""}\n`);
    }
    const report = buildReport({ startedAt, durationMs: Date.now() - start, opts, scenarios, results: [], listOnly: true });
    await maybeWriteJson(opts.jsonPath, report);
    return report;
  }

  if (scenarios.length === 0) {
    const message = "chaos: no concrete scenarios to run. See tests/chaos/README.md.";
    process.stderr.write(`${message}\n`);
    const report = buildReport({ startedAt, durationMs: Date.now() - start, opts, scenarios, results: [], error: message });
    await maybeWriteJson(opts.jsonPath, report);
    if (opts.requireScenarios) throw new Error("chaos_runner_no_scenarios");
    return report;
  }

  const results = [];
  for (const scenario of scenarios) {
    for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
      results.push(await runOne(scenario, iteration, opts));
    }
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nsummary: ${results.length - failed.length}/${results.length} passed\n`);
  const report = buildReport({ startedAt, durationMs: Date.now() - start, opts, scenarios, results });
  await maybeWriteJson(opts.jsonPath, report);
  if (failed.length > 0) {
    for (const failure of failed) process.stdout.write(`  - ${failure.name}\n`);
    throw new Error(`chaos_runner_failed:${failed.map((failure) => failure.name).join(",")}`);
  }
  return report;
}

function buildReport({ startedAt, durationMs, opts, scenarios, results, listOnly = false, error }) {
  const failed = results.filter((result) => !result.ok);
  const scenarioNames = [...new Set(scenarios.map((scenario) => scenario.name))];
  return {
    schema_version: "synthi.chaosRunnerReport.v1",
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    ok: !error && failed.length === 0 && (listOnly || results.length > 0 || !opts.requireScenarios),
    list_only: listOnly,
    duration_ms: durationMs,
    scenario_count: scenarioNames.length,
    iteration_count: opts.iterations,
    expected_run_count: listOnly ? 0 : scenarioNames.length * opts.iterations,
    passed_run_count: results.filter((result) => result.ok).length,
    failed_run_count: failed.length,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      description: scenario.description ?? "",
    })),
    results,
    artifact_dir: resolve(opts.artifactDir ?? join(REPO_ROOT, "tmp", "dojo-chaos-runner")),
    timeout_ms: opts.timeoutMs,
    ...(error ? { error } : {}),
  };
}

async function maybeWriteJson(jsonPath, report) {
  if (!jsonPath) return;
  const resolved = resolve(jsonPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.jsonPath && existsSync(resolve(opts.jsonPath))) await writeFile(resolve(opts.jsonPath), "");
  await runChaosSuite(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`chaos runner unhandled: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
