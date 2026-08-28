import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const LIVE_ENABLE_ENV = "SYNTHI_CHAOS_ENABLE_LIVE";

export function createLiveCommandScenario({
  name,
  description,
  commandEnv,
  requiredEnv = [],
  expectedExitCode = 0,
  validateEvidence,
}) {
  if (!name || typeof name !== "string") throw new Error("chaos_live_scenario_name_required");
  if (!commandEnv || typeof commandEnv !== "string") throw new Error(`chaos_live_scenario_command_env_required:${name}`);
  const scenarioRequiredEnv = [...new Set([LIVE_ENABLE_ENV, commandEnv, ...requiredEnv])];
  return {
    name,
    kind: "live",
    description,
    required_env: scenarioRequiredEnv,
    command_env: commandEnv,

    async run(ctx) {
      if (process.env[LIVE_ENABLE_ENV] !== "1") {
        throw new Error(`chaos_live_scenario_not_enabled:${name}:${LIVE_ENABLE_ENV}`);
      }
      const missing = scenarioRequiredEnv.filter((envName) => !process.env[envName]);
      if (missing.length > 0) throw new Error(`chaos_live_scenario_missing_env:${name}:${missing.join(",")}`);

      const argv = parseCommandArgv({ scenarioName: name, commandEnv });
      const artifactDir = resolve(ctx.artifactDir, name);
      await mkdir(artifactDir, { recursive: true });
      const stdoutPath = join(artifactDir, `${name}.stdout.log`);
      const stderrPath = join(artifactDir, `${name}.stderr.log`);
      const started = Date.now();
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: ctx.repoRoot,
        encoding: "utf8",
        env: process.env,
        shell: false,
        timeout: ctx.timeoutMs,
        windowsHide: true,
      });
      const durationMs = Date.now() - started;
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      await writeFile(stdoutPath, stdout);
      await writeFile(stderrPath, stderr);

      if (result.error) throw new Error(`chaos_live_scenario_command_failed:${name}:${result.error.message}`);
      if (result.status !== expectedExitCode) {
        throw new Error(`chaos_live_scenario_exit_${result.status}:${name}:expected_${expectedExitCode}`);
      }
      const deploymentEvidence = validateEvidence
        ? await validateEvidence({
          stdout,
          stderr,
          scenario: name,
          command_env: commandEnv,
        })
        : undefined;

      return {
        schema_version: "synthi.chaosLiveCommandScenarioEvidence.v1",
        scenario: name,
        kind: "live",
        ok: true,
        duration_ms: durationMs,
        command_env: commandEnv,
        command_argv0: argv[0],
        command_arg_count: argv.length - 1,
        expected_exit_code: expectedExitCode,
        exit_code: result.status,
        signal: result.signal ?? null,
        timed_out: Boolean(result.error?.code === "ETIMEDOUT"),
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        ...(deploymentEvidence === undefined ? {} : { deployment_evidence: deploymentEvidence }),
      };
    },
  };
}

function parseCommandArgv({ scenarioName, commandEnv }) {
  let parsed;
  try {
    parsed = JSON.parse(String(process.env[commandEnv] || ""));
  } catch (err) {
    throw new Error(`chaos_live_scenario_command_json_invalid:${scenarioName}:${commandEnv}:${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`chaos_live_scenario_command_json_invalid:${scenarioName}:${commandEnv}`);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
