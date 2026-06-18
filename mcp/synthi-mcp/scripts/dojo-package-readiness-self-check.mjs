#!/usr/bin/env node
/*
 * Dojo package readiness self-check.
 *
 * This gate verifies the npm artifact boundary instead of trusting repo-local
 * paths. It derives public export files and release-harness script paths from
 * package.json, runs npm pack --dry-run --json, and emits digest-backed
 * evidence that the package contains what release gates need.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES = [
  "build",
  "typecheck",
  "proof:dojo:self-check",
  "proof:dojo:package-readiness:self-check",
  "proof:dojo:release-gates:self-check",
  "proof:dojo:release-gates:runner:self-check",
  "proof:dojo:release-gates:verify:self-check",
  "proof:dojo:mcp-host-conformance:self-check",
  "live:dojo:mcp-host-conformance",
  "chaos:dojo:preflight",
  "chaos:dojo:live",
  "soak",
];

export const DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES = [
  "dist",
  "scripts/dojo-package-readiness-self-check.mjs",
  "scripts/dojo-release-gate-manifest.mjs",
  "scripts/dojo-release-gate-runner.mjs",
  "scripts/dojo-release-gate-verify.mjs",
  "scripts/dojo-mcp-host-conformance.mjs",
  "tests/chaos",
  "tests/soak",
  "README.md",
];

export const DOJO_PACKAGE_READINESS_REQUIRED_METADATA_FIELDS = [
  "name",
  "version",
  "main",
  "types",
  "bin",
  "exports",
  "files",
  "scripts",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-package-readiness"));
  const artifacts = await runDojoPackageReadinessSelfCheck({ outDir });
  console.log(`[ok] Dojo package readiness self-check passed - evidence=${artifacts.evidence_path}`);
}

export async function runDojoPackageReadinessSelfCheck({ outDir, now = new Date().toISOString(), timeoutMs = 120000 } = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-package-readiness"));
  await mkdir(outputDir, { recursive: true });

  const packageJsonPath = path.join(MCP_ROOT, "package.json");
  const packageJsonText = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonText);

  const packStdoutPath = path.join(outputDir, "dojo-package-readiness.pack.stdout.log");
  const packStderrPath = path.join(outputDir, "dojo-package-readiness.pack.stderr.log");
  const packReportPath = path.join(outputDir, "dojo-package-readiness.pack.json");

  const packCommand = npmCommand(["pack", "--dry-run", "--json"]);
  const packResult = spawnSync(packCommand.command, packCommand.args, {
    cwd: MCP_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: packCommand.shell,
  });
  const stdout = String(packResult.stdout ?? "");
  const stderr = String(packResult.stderr ?? "");
  await writeFile(packStdoutPath, stdout, "utf8");
  await writeFile(packStderrPath, stderr, "utf8");

  let packReport = null;
  let packParseError = "";
  try {
    packReport = stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    packParseError = error instanceof Error ? error.message : String(error);
  }
  await writeFile(packReportPath, `${JSON.stringify(packReport, null, 2)}\n`, "utf8");

  const evidence = buildDojoPackageReadinessEvidenceManifest({
    now,
    packageJson,
    packageJsonText,
    packageJsonPath,
    packResult,
    packReport,
    packParseError,
    packReportPath,
    stdout,
    stderr,
    packStdoutPath,
    packStderrPath,
  });
  const evidencePath = path.join(outputDir, "dojo-package-readiness.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  if (packResult.error) throw new Error(`dojo_package_readiness_pack_failed:${packResult.error.message}`);
  if (!evidence.ok) throw new Error(`dojo_package_readiness_failed:${evidence.errors.join(";")}`);
  return {
    evidence_path: evidencePath,
    pack_report_path: packReportPath,
    pack_stdout_path: packStdoutPath,
    pack_stderr_path: packStderrPath,
    evidence,
  };
}

export function buildDojoPackageReadinessEvidenceManifest({
  now,
  packageJson,
  packageJsonText,
  packageJsonPath,
  packResult,
  packReport,
  packParseError,
  packReportPath,
  stdout,
  stderr,
  packStdoutPath,
  packStderrPath,
}) {
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const filesField = Array.isArray(packageJson?.files) ? packageJson.files.map(String) : [];
  const packedPackage = Array.isArray(packReport) ? packReport[0] : null;
  const packedFiles = Array.isArray(packedPackage?.files)
    ? packedPackage.files.map((file) => normalizePackagePath(file?.path)).filter(Boolean)
    : [];
  const packedFileSet = new Set(packedFiles);

  const entryPaths = collectPackageEntryPaths(packageJson);
  const scriptReferencedPaths = collectScriptReferencedPackagePaths(scripts, DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES);
  const requiredPackedPaths = stableUnique([
    "package.json",
    ...entryPaths,
    ...scriptReferencedPaths,
    ...DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES.filter((entry) => !entry.endsWith("/")),
  ]);

  const missingMetadataFields = DOJO_PACKAGE_READINESS_REQUIRED_METADATA_FIELDS
    .filter((field) => isMissingMetadataValue(packageJson?.[field]));
  const missingScripts = DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES
    .filter((scriptName) => typeof scripts[scriptName] !== "string" || !scripts[scriptName].trim());
  const missingFilesEntries = DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES
    .filter((entry) => !packageFilesEntryCovers(filesField, entry));
  const missingLocalEntryPaths = entryPaths.filter((entry) => !existsSync(path.join(MCP_ROOT, entry)));
  const missingLocalScriptPaths = scriptReferencedPaths.filter((entry) => !existsSync(path.join(MCP_ROOT, entry)));
  const missingPackedPaths = requiredPackedPaths
    .filter((entry) => !packedPathIsCovered(packedFileSet, entry));
  const packageFilesUncoveredScriptPaths = scriptReferencedPaths
    .filter((entry) => !packageFilesEntryCovers(filesField, entry));
  const errors = [
    ...missingMetadataFields.map((field) => `missing_package_metadata:${field}`),
    ...missingScripts.map((scriptName) => `missing_package_script:${scriptName}`),
    ...missingFilesEntries.map((entry) => `missing_package_files_entry:${entry}`),
    ...missingLocalEntryPaths.map((entry) => `missing_local_export_entry:${entry}`),
    ...missingLocalScriptPaths.map((entry) => `missing_local_script_path:${entry}`),
    ...packageFilesUncoveredScriptPaths.map((entry) => `script_path_not_covered_by_files:${entry}`),
    ...missingPackedPaths.map((entry) => `missing_packed_path:${entry}`),
  ];
  if (packageJson?.private === true) errors.push("package_private_true");
  if (Number(packResult?.status ?? 1) !== 0) errors.push(`npm_pack_exit_code:${packResult?.status ?? "missing"}`);
  if (packResult?.signal) errors.push(`npm_pack_signal:${packResult.signal}`);
  if (packResult?.error?.message) errors.push(`npm_pack_error:${packResult.error.message}`);
  if (packParseError) errors.push(`npm_pack_json_parse_error:${packParseError}`);
  if (!packedPackage) errors.push("npm_pack_report_missing_package_entry");
  if (packedFiles.length === 0) errors.push("npm_pack_file_list_empty");
  if (!String(packedPackage?.filename || "").endsWith(".tgz")) errors.push("npm_pack_tarball_filename_missing");
  if (!String(packedPackage?.integrity || "").trim()) errors.push("npm_pack_integrity_missing");
  if (!positiveFiniteNumber(packedPackage?.unpackedSize)) errors.push("npm_pack_unpacked_size_missing");

  const validation = {
    ok: errors.length === 0,
    errors,
    missing_metadata_fields: missingMetadataFields,
    missing_package_scripts: missingScripts,
    missing_package_files_entries: missingFilesEntries,
    missing_local_export_entry_paths: missingLocalEntryPaths,
    missing_local_script_paths: missingLocalScriptPaths,
    missing_packed_paths: missingPackedPaths,
    package_files_uncovered_script_paths: packageFilesUncoveredScriptPaths,
  };

  return {
    schema_version: "synthi.dojo.packageReadinessEvidence.v1",
    generated_at: now,
    ok: validation.ok,
    errors,
    package_json_path: packageJsonPath,
    package_json_sha256: sha256(packageJsonText || JSON.stringify(packageJson || {})),
    package_name: packageJson?.name || null,
    package_version: packageJson?.version || null,
    package_private: Boolean(packageJson?.private),
    required_metadata_fields: [...DOJO_PACKAGE_READINESS_REQUIRED_METADATA_FIELDS],
    required_package_scripts: [...DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES],
    required_package_files_entries: [...DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES],
    package_files_entries: filesField,
    export_entry_paths: entryPaths,
    script_referenced_paths: scriptReferencedPaths,
    required_packed_paths: requiredPackedPaths,
    validation,
    npm_pack: {
      exit_code: packResult?.status ?? null,
      signal: packResult?.signal ?? null,
      error: packResult?.error?.message || null,
      report_path: packReportPath,
      report_sha256: sha256(`${JSON.stringify(packReport ?? null, null, 2)}\n`),
      stdout_path: packStdoutPath,
      stdout_sha256: sha256(stdout),
      stdout_bytes: Buffer.byteLength(stdout || ""),
      stderr_path: packStderrPath,
      stderr_sha256: sha256(stderr),
      stderr_bytes: Buffer.byteLength(stderr || ""),
      parse_error: packParseError || null,
      package_filename: packedPackage?.filename || null,
      integrity_present: Boolean(String(packedPackage?.integrity || "").trim()),
      packed_file_count: packedFiles.length,
      unpacked_size: packedPackage?.unpackedSize ?? null,
      packed_files_sha256: sha256(JSON.stringify(packedFiles)),
    },
  };
}

export function validateDojoPackageReadinessEvidence(evidence) {
  const errors = [];
  if (evidence?.schema_version !== "synthi.dojo.packageReadinessEvidence.v1") {
    errors.push(`package_readiness_schema_mismatch:${evidence?.schema_version || "missing"}`);
  }
  if (evidence?.ok !== true) errors.push("package_readiness_not_ok");
  if (evidence?.package_private === true) errors.push("package_readiness_private_package");
  if (Number(evidence?.npm_pack?.exit_code) !== 0) {
    errors.push(`package_readiness_npm_pack_exit_code:${evidence?.npm_pack?.exit_code ?? "missing"}`);
  }
  if (!evidence?.npm_pack?.integrity_present) errors.push("package_readiness_pack_integrity_missing");
  if (!positiveFiniteNumber(evidence?.npm_pack?.packed_file_count)) errors.push("package_readiness_packed_file_count_missing");
  if (!positiveFiniteNumber(evidence?.npm_pack?.unpacked_size)) errors.push("package_readiness_unpacked_size_missing");
  for (const scriptName of DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES) {
    if (!arrayIncludesString(evidence?.required_package_scripts, scriptName)) {
      errors.push(`package_readiness_required_script_not_declared:${scriptName}`);
    }
  }
  for (const entry of DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES) {
    if (!arrayIncludesString(evidence?.required_package_files_entries, entry)) {
      errors.push(`package_readiness_required_files_entry_not_declared:${entry}`);
    }
  }
  const validationErrors = Array.isArray(evidence?.validation?.errors) ? evidence.validation.errors : [];
  if (validationErrors.length > 0) {
    errors.push(...validationErrors.map((error) => `package_readiness_validation:${error}`));
  }
  if (!String(evidence?.npm_pack?.stdout_sha256 || "").trim()) errors.push("package_readiness_stdout_digest_missing");
  if (!String(evidence?.npm_pack?.stderr_sha256 || "").trim()) errors.push("package_readiness_stderr_digest_missing");
  if (!String(evidence?.npm_pack?.report_sha256 || "").trim()) errors.push("package_readiness_report_digest_missing");
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function collectPackageEntryPaths(packageJson) {
  const entries = [];
  if (typeof packageJson?.main === "string") entries.push(packageJson.main);
  if (typeof packageJson?.types === "string") entries.push(packageJson.types);
  if (packageJson?.bin && typeof packageJson.bin === "object") {
    entries.push(...Object.values(packageJson.bin).filter((value) => typeof value === "string"));
  } else if (typeof packageJson?.bin === "string") {
    entries.push(packageJson.bin);
  }
  entries.push(...collectExportLeafPaths(packageJson?.exports));
  return stableUnique(entries.map(normalizePackagePath).filter(Boolean));
}

export function collectScriptReferencedPackagePaths(scripts, scriptNames) {
  const selectedScriptNames = stableUnique(scriptNames);
  const paths = [];
  for (const scriptName of selectedScriptNames) {
    const command = scripts?.[scriptName];
    if (typeof command !== "string") continue;
    paths.push(...extractPackagePathsFromScript(command));
  }
  return stableUnique(paths);
}

export function extractPackagePathsFromScript(command) {
  const paths = [];
  const regex = /(?:^|\s)(?:node|tsx|npx|vitest)?\s*((?:\.\/|\.\.\/)?(?:scripts|tests|dist)\/[^\s"'`]+?\.(?:mjs|js|cjs|ts|tsx))/g;
  let match = regex.exec(command);
  while (match) {
    const normalized = normalizePackagePath(match[1]);
    if (normalized && !normalized.startsWith("..")) paths.push(normalized);
    match = regex.exec(command);
  }
  return stableUnique(paths);
}

function collectExportLeafPaths(exportsField) {
  const entries = [];
  if (typeof exportsField === "string") return [exportsField];
  if (!exportsField || typeof exportsField !== "object") return entries;
  for (const value of Object.values(exportsField)) {
    if (typeof value === "string") {
      entries.push(value);
    } else if (value && typeof value === "object") {
      entries.push(...collectExportLeafPaths(value));
    }
  }
  return entries;
}

function packageFilesEntryCovers(filesField, entry) {
  const normalizedEntry = normalizePackagePath(entry);
  return filesField.some((fileEntry) => {
    const normalizedFileEntry = normalizePackagePath(fileEntry);
    return normalizedFileEntry === normalizedEntry
      || normalizedEntry.startsWith(`${normalizedFileEntry}/`)
      || normalizedFileEntry.startsWith(`${normalizedEntry}/`);
  });
}

function packedPathIsCovered(packedFileSet, entry) {
  const normalizedEntry = normalizePackagePath(entry);
  if (packedFileSet.has(normalizedEntry)) return true;
  return [...packedFileSet].some((packedPath) => packedPath.startsWith(`${normalizedEntry}/`));
}

function normalizePackagePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^file:/, "")
    .replace(/^[.][/\\]/, "")
    .replace(/\\/g, "/")
    .replace(/^[/]+/, "")
    .replace(/\/+$/, "");
}

function stableUnique(values) {
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

function isMissingMetadataValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return !String(value || "").trim();
}

function arrayIncludesString(values, expected) {
  return Array.isArray(values) && values.map(String).includes(expected);
}

function positiveFiniteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0;
}

function npmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
      shell: false,
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    shell: process.platform === "win32",
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

assert.equal(typeof runDojoPackageReadinessSelfCheck, "function");
