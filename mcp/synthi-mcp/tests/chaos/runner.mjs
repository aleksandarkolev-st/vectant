#!/usr/bin/env node
//
// runner.mjs — phase-2e chaos scenario harness.
//
// Loads every scenario module under `scenarios/` that implements the
// shape documented in `_template.mjs`, spawns a docker-compose stack
// (or talks to a pre-brought-up one), and runs each scenario's
// `setup / inject / assert / cleanup` lifecycle. Non-zero exit on any
// assertion failure.
//
// Intentionally minimal: no vitest, no top-level test framework.
// Chaos tests are orchestration + assertion, not parameterized
// fixtures. Each scenario owns its own docker / network / process
// hooks.
//
// Usage:
//   node tests/chaos/runner.mjs
//   node tests/chaos/runner.mjs --only worker_kill
//   node tests/chaos/runner.mjs --iterations 5

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { only: null, iterations: 1, listOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") opts.only = argv[++i];
    else if (a === "--iterations") opts.iterations = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--list") opts.listOnly = true;
    else if (a === "--help" || a === "-h") {
      process.stderr.write(
        "chaos runner — execute fault-injection scenarios against a live Synthi stack.\n\n" +
        "  --only <name>         run a single scenario by file name (without .mjs)\n" +
        "  --iterations <n>      repeat each scenario n times (default 1)\n" +
        "  --list                enumerate scenarios without running\n\n" +
        "Env:\n" +
        "  SYNTHI_SIGNALING_URL   signaling websocket to exercise (default ws://localhost:9000)\n" +
        "  SYNTHI_CHAOS_DOCKER_PROJECT   docker-compose project the scenarios act on\n"
      );
      process.exit(0);
    }
  }
  return opts;
}

async function loadScenarios(only) {
  const dir = join(__dirname, "scenarios");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const modules = [];
  for (const name of files) {
    if (!name.endsWith(".mjs")) continue;
    if (name.startsWith("_")) continue;
    if (only && name !== `${only}.mjs`) continue;
    const mod = await import(join(dir, name));
    if (typeof mod.default !== "object" || !mod.default) continue;
    const scenario = mod.default;
    if (typeof scenario.name !== "string" || typeof scenario.run !== "function") {
      process.stderr.write(`chaos: skipping ${name} — does not match scenario shape\n`);
      continue;
    }
    modules.push(scenario);
  }
  return modules;
}

async function runOne(scenario, iteration) {
  const label = `${scenario.name}#${iteration}`;
  const start = Date.now();
  const ctx = {
    signalingUrl: process.env.SYNTHI_SIGNALING_URL ?? "ws://localhost:9000",
    dockerProject: process.env.SYNTHI_CHAOS_DOCKER_PROJECT ?? null,
    iteration,
  };
  try {
    await scenario.run(ctx);
    const elapsed = Date.now() - start;
    process.stdout.write(`PASS ${label} (${elapsed}ms)\n`);
    return { ok: true, name: label };
  } catch (err) {
    const elapsed = Date.now() - start;
    process.stdout.write(`FAIL ${label} (${elapsed}ms): ${err?.message ?? err}\n`);
    return { ok: false, name: label, error: err };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenarios = await loadScenarios(opts.only);

  if (opts.listOnly) {
    for (const s of scenarios) process.stdout.write(`${s.name}\n`);
    return;
  }

  if (scenarios.length === 0) {
    process.stderr.write(
      "chaos: no scenarios to run. See tests/chaos/README.md — phase-2e lands individual scenarios on top of this harness.\n"
    );
    process.exit(0);
  }

  const results = [];
  for (const scenario of scenarios) {
    for (let i = 1; i <= opts.iterations; i++) {
      const r = await runOne(scenario, i);
      results.push(r);
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\nsummary: ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) {
    for (const f of failed) {
      process.stdout.write(`  - ${f.name}\n`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`chaos runner unhandled: ${err?.stack ?? err}\n`);
  process.exit(1);
});
