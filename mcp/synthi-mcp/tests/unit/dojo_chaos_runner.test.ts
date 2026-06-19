import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadScenarios,
  parseArgs,
  runChaosSuite,
} from "../chaos/runner.mjs";

const LIVE_ENV_KEYS = [
  "SYNTHI_CHAOS_ENABLE_LIVE",
  "SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON",
];
const ORIGINAL_ENV = Object.fromEntries(LIVE_ENV_KEYS.map((key) => [key, process.env[key]]));

describe("Dojo chaos runner", () => {
  afterEach(() => {
    for (const key of LIVE_ENV_KEYS) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it("defaults to deterministic preflight scenarios and excludes live hooks", async () => {
    const opts = parseArgs([]);
    expect(opts).toEqual(expect.objectContaining({
      scenarioKind: "preflight",
      includeLive: false,
    }));

    const scenarios = await loadScenarios(null, opts);
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((scenario) => scenario.kind === "preflight")).toBe(true);
    expect(scenarios.map((scenario) => scenario.name)).not.toContain("live_worker_kill");
  });

  it("lists live scenarios only when the caller explicitly selects live or all", async () => {
    const preflightOnlyOpts = parseArgs(["--only", "live_worker_kill"]);
    const preflightOnly = await loadScenarios(preflightOnlyOpts.only, preflightOnlyOpts);
    expect(preflightOnly).toEqual([]);

    const liveOnly = await loadScenarios(null, parseArgs(["--kind", "live"]));
    expect(liveOnly.map((scenario) => scenario.name)).toContain("live_worker_kill");
    expect(liveOnly.every((scenario) => scenario.kind === "live")).toBe(true);

    const allKinds = await loadScenarios(null, parseArgs(["--kind", "all"]));
    expect(new Set(allKinds.map((scenario) => scenario.kind))).toEqual(new Set(["preflight", "live"]));
  });

  it("runs an opt-in live command scenario from env JSON without shell interpolation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-chaos-live-"));
    const jsonPath = path.join(dir, "live-chaos-report.json");
    process.env.SYNTHI_CHAOS_ENABLE_LIVE = "1";
    process.env.SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON = JSON.stringify([
      process.execPath,
      "-e",
      "console.log('live chaos command ok')",
    ]);

    const report = await runChaosSuite({
      ...parseArgs(["--kind", "live", "--only", "live_worker_kill", "--require-scenarios"]),
      jsonPath,
      artifactDir: path.join(dir, "artifacts"),
    });
    expect(report.ok).toBe(true);
    expect(report.live_scenarios_included).toBe(true);
    expect(report.scenarios).toEqual([
      expect.objectContaining({
        name: "live_worker_kill",
        kind: "live",
        required_env: expect.arrayContaining([
          "SYNTHI_CHAOS_ENABLE_LIVE",
          "SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON",
        ]),
      }),
    ]);
    expect(report.results[0].evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.chaosLiveCommandScenarioEvidence.v1",
      scenario: "live_worker_kill",
      kind: "live",
      command_env: "SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON",
      exit_code: 0,
      command_arg_count: 2,
    }));

    const writtenReport = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(writtenReport.live_scenarios_included).toBe(true);
    expect(writtenReport.results[0].evidence.stdout_bytes).toBeGreaterThan(0);
  });
});
