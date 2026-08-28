import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);

export function shouldRunVitestForSelfCheck(args, jsonReportPath, exists = () => false) {
  return args["run-tests"] === true
    || args["run-tests"] === "1"
    || args["run-tests"] === "true"
    || (!exists(jsonReportPath)
      && args["no-run-tests"] !== true
      && args["no-run-tests"] !== "1"
      && args["no-run-tests"] !== "true");
}

export async function runVitestJsonForSelfCheck({
  testFiles,
  jsonReportPath,
  timeoutMs,
  cwd,
  env = process.env,
}) {
  await mkdir(path.dirname(jsonReportPath), { recursive: true });
  const vitestBin = require.resolve("vitest/vitest.mjs");
  const args = [
    vitestBin,
    "run",
    ...testFiles,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ];
  const command = process.execPath;
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, CI: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode: 1,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        durationMs: performance.now() - startedAt,
        timedOut,
        error: `vitest_spawn_error:${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode: code ?? 1,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
        timedOut,
        error: timedOut ? "vitest_timeout" : undefined,
      });
    });
  });
}
