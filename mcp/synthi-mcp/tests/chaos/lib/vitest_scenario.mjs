import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export async function runVitestEvidenceScenario(ctx, {
  scenarioName,
  testFiles,
  evidenceMatchers,
}) {
  if (!scenarioName || typeof scenarioName !== "string") {
    throw new Error("chaos_scenario_name_required");
  }
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    throw new Error(`chaos_scenario_test_files_required:${scenarioName}`);
  }
  if (!Array.isArray(evidenceMatchers) || evidenceMatchers.length === 0) {
    throw new Error(`chaos_scenario_evidence_matchers_required:${scenarioName}`);
  }

  const mcpRoot = resolve(ctx.mcpRoot);
  const artifactDir = resolve(ctx.artifactDir, scenarioName);
  await mkdir(artifactDir, { recursive: true });
  const missing = testFiles.filter((file) => !existsSync(join(mcpRoot, file)));
  if (missing.length > 0) throw new Error(`chaos_scenario_missing_test_files:${scenarioName}:${missing.join(",")}`);

  const vitestPath = join(mcpRoot, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitestPath)) throw new Error(`chaos_scenario_missing_vitest:${vitestPath}`);

  const jsonReportPath = join(artifactDir, `${scenarioName}.vitest.json`);
  const stdoutPath = join(artifactDir, `${scenarioName}.stdout.log`);
  const stderrPath = join(artifactDir, `${scenarioName}.stderr.log`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    ...testFiles,
    "--reporter=json",
    "--outputFile",
    jsonReportPath,
  ], {
    cwd: mcpRoot,
    encoding: "utf8",
    timeout: ctx.timeoutMs,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);

  if (result.error) throw new Error(`chaos_scenario_vitest_spawn_failed:${scenarioName}:${result.error.message}`);
  if (result.status !== 0) throw new Error(`chaos_scenario_vitest_failed:${scenarioName}:exit_${result.status}`);
  if (!existsSync(jsonReportPath)) throw new Error(`chaos_scenario_vitest_json_missing:${scenarioName}`);

  const jsonReportText = await readFile(jsonReportPath, "utf8");
  const jsonReport = JSON.parse(jsonReportText);
  const assertionTitles = assertionTitlesFor(jsonReport);
  const coverage = evidenceMatchers.map((matcher) => {
    const aliases = normalizeMatcherAliases(matcher);
    const evidenceTitles = assertionTitles.filter((title) => {
      const normalized = normalize(title);
      return aliases.some((alias) => normalized.includes(alias));
    });
    return {
      id: matcher.id,
      aliases,
      covered: evidenceTitles.length > 0,
      evidence_titles: evidenceTitles,
    };
  });
  const missingCoverage = coverage.filter((item) => !item.covered);
  if (missingCoverage.length > 0) {
    throw new Error(`chaos_scenario_evidence_missing:${scenarioName}:${missingCoverage.map((item) => item.id).join(",")}`);
  }

  return {
    schema_version: "synthi.chaosVitestScenarioEvidence.v1",
    scenario: scenarioName,
    ok: true,
    duration_ms: durationMs,
    test_files: [...testFiles],
    reported_test_file_count: Array.isArray(jsonReport.testResults) ? jsonReport.testResults.length : 0,
    test_summary: {
      success: jsonReport.success === true,
      total_tests: numberOrZero(jsonReport.numTotalTests),
      passed_tests: numberOrZero(jsonReport.numPassedTests),
      failed_tests: numberOrZero(jsonReport.numFailedTests),
      pending_tests: numberOrZero(jsonReport.numPendingTests),
    },
    evidence_coverage: coverage,
    json_report_path: jsonReportPath,
    json_report_sha256: sha256(jsonReportText),
    json_report_bytes: Buffer.byteLength(jsonReportText),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
  };
}

function assertionTitlesFor(report) {
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  return testResults
    .flatMap((result) => Array.isArray(result.assertionResults) ? result.assertionResults : [])
    .map((assertion) => String(assertion.fullName || assertion.title || ""))
    .filter(Boolean);
}

function normalizeMatcherAliases(matcher) {
  const aliases = Array.isArray(matcher.aliases) ? matcher.aliases : [];
  return [...new Set([matcher.id, ...aliases].map(normalize).filter(Boolean))];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
