#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

const OIDN_OUTPUT_ORACLE_SCHEMA = 'synthi.gpu_hmr.oidn_output_oracle.v1';
const OIDN_OUTPUT_ORACLE_AUTHORITY = 'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success';

function argValue(name) {
  const eq = `${name}=`;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === name) return rawArgs[index + 1] ?? '';
    if (arg.startsWith(eq)) return arg.slice(eq.length);
  }
  return '';
}

const CFG = {
  workerContainer: process.env.SYNTHI_OIDN_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? process.env.SYNTHI_WORKER_CONTAINER
    ?? '',
  repoPath: process.env.SYNTHI_OIDN_REPO_PATH ?? '',
  slug: process.env.SLUG
    ?? process.env.SYNTHI_OIDN_PREFLIGHT_SLUG
    ?? `oidn-preflight-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  outputDir: process.env.SYNTHI_OIDN_PREFLIGHT_OUTPUT_DIR
    ?? path.resolve(__dirname, '../.gpu-hmr-test-artifacts/oidn-preflight'),
  timeoutMs: Number(process.env.SYNTHI_OIDN_PREFLIGHT_TIMEOUT_MS ?? 120000),
  seed: process.env.SYNTHI_OIDN_RNG_SEED ?? '12345',
  requireHip: process.env.SYNTHI_OIDN_REQUIRE_HIP === '1',
  allowRejected: process.env.SYNTHI_OIDN_ALLOW_REJECTED === '1',
  outputOracleManifestPath: process.env.SYNTHI_OIDN_OUTPUT_ORACLE_MANIFEST_PATH
    ?? argValue('--output-oracle-manifest')
    ?? '',
  outputOracleAllowedRoots: process.env.SYNTHI_OIDN_OUTPUT_ORACLE_ALLOWED_ROOTS ?? '',
};

function failConfig(message) {
  throw new Error(`${message}. Set SYNTHI_OIDN_WORKER_CONTAINER and SYNTHI_OIDN_REPO_PATH explicitly for live preflight.`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cleanToken(value) {
  return String(value || 'oidn-preflight').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'oidn-preflight';
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
    return out;
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
}

function sha256Stable(value) {
  return `sha256:${sha256Json(value)}`;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(text);
  return match ? `sha256:${match[1]}` : null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function authorityClaimsSuccess(object) {
  if (!object || typeof object !== 'object') return false;
  return object.acceptedForGpuHmr === true
    || object.accepted_for_gpu_hmr === true
    || object.gpuHmrSuccess === true
    || object.gpu_hmr_success === true
    || object.canSatisfyRuntimeProof === true
    || object.can_satisfy_runtime_proof === true;
}

function isPathInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function safeRealpath(value) {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

async function outputOracleAllowedRoots(manifestPath) {
  const configured = CFG.outputOracleAllowedRoots
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = [
    path.dirname(path.resolve(manifestPath)),
    path.resolve(CFG.outputDir),
    ...configured.map((entry) => path.resolve(entry)),
  ];
  const resolved = [];
  for (const root of roots) {
    const real = await safeRealpath(root);
    if (real && !resolved.includes(real)) resolved.push(real);
  }
  return resolved;
}

async function resolveOutputOraclePath(manifestPath, value, allowedRoots) {
  const text = firstText(value);
  if (!text) {
    return { path: null, resolvedPath: null, accepted: false, failedGates: ['oidn_output_oracle_path_missing'] };
  }
  const candidate = path.isAbsolute(text)
    ? text
    : path.resolve(path.dirname(path.resolve(manifestPath)), text);
  const resolved = await safeRealpath(candidate);
  if (!resolved) {
    return { path: candidate, resolvedPath: null, accepted: false, failedGates: ['oidn_output_oracle_file_unreadable'] };
  }
  const inside = allowedRoots.some((root) => isPathInside(resolved, root));
  if (!inside) {
    return { path: candidate, resolvedPath: resolved, accepted: false, failedGates: ['oidn_output_oracle_path_outside_allowed_roots'] };
  }
  return { path: candidate, resolvedPath: resolved, accepted: true, failedGates: [] };
}

async function verifyOutputOracleFile({ role, manifestPath, value, declaredSha256, allowedRoots }) {
  const resolved = await resolveOutputOraclePath(manifestPath, value, allowedRoots);
  if (!resolved.accepted) {
    return {
      role,
      ...resolved,
      byteLength: 0,
      sha256: null,
      declaredSha256: normalizeSha256(declaredSha256),
      accepted: false,
      failedGates: resolved.failedGates.map((code) => `${role}:${code}`),
    };
  }
  try {
    const bytes = await readFile(resolved.resolvedPath);
    const sha256 = `sha256:${sha256Buffer(bytes)}`;
    const declared = normalizeSha256(declaredSha256);
    const failedGates = [];
    if (bytes.length <= 0) failedGates.push(`${role}:oidn_output_oracle_file_empty`);
    if (declared && declared !== sha256) failedGates.push(`${role}:oidn_output_oracle_hash_mismatch`);
    return {
      role,
      path: resolved.path,
      resolvedPath: resolved.resolvedPath,
      resolved_path: resolved.resolvedPath,
      byteLength: bytes.length,
      byte_length: bytes.length,
      sha256,
      declaredSha256: declared,
      declared_sha256: declared,
      accepted: failedGates.length === 0,
      failedGates,
      failed_gates: failedGates,
    };
  } catch {
    return {
      role,
      path: resolved.path,
      resolvedPath: resolved.resolvedPath,
      resolved_path: resolved.resolvedPath,
      byteLength: 0,
      byte_length: 0,
      sha256: null,
      declaredSha256: normalizeSha256(declaredSha256),
      declared_sha256: normalizeSha256(declaredSha256),
      accepted: false,
      failedGates: [`${role}:oidn_output_oracle_file_unreadable`],
      failed_gates: [`${role}:oidn_output_oracle_file_unreadable`],
    };
  }
}

async function buildOidnOutputOracleEvidence(manifestPath) {
  if (!manifestPath) return null;
  const resolvedManifestPath = path.resolve(manifestPath);
  const failedGates = [];
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await readFile(resolvedManifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return {
      schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
      proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
      accepted: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      manifestPath: resolvedManifestPath,
      manifest_path: resolvedManifestPath,
      failedGates: ['oidn_output_oracle_manifest_unreadable'],
      failed_gates: ['oidn_output_oracle_manifest_unreadable'],
    };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failedGates.push('oidn_output_oracle_manifest_not_object');
    manifest = {};
  }
  const schema = firstText(manifest.schemaVersion, manifest.schema_version, manifest.schema);
  if (schema !== OIDN_OUTPUT_ORACLE_SCHEMA) failedGates.push('oidn_output_oracle_schema_mismatch');
  const authority = firstText(manifest.proofAuthority, manifest.proof_authority);
  if (authority && authority !== OIDN_OUTPUT_ORACLE_AUTHORITY) {
    failedGates.push('oidn_output_oracle_authority_mismatch');
  }
  if (authorityClaimsSuccess(manifest)) failedGates.push('oidn_output_oracle_claims_gpu_hmr_success');
  const backend = firstText(manifest.backend, manifest.backendFamily, manifest.backend_family);
  if (backend && backend !== 'oidn_hip') failedGates.push('oidn_output_oracle_backend_mismatch');
  const device = firstText(manifest.device, manifest.runtimeDevice, manifest.runtime_device);
  if (device && device !== 'hip') failedGates.push('oidn_output_oracle_device_mismatch');
  const allowedRoots = await outputOracleAllowedRoots(resolvedManifestPath);
  const noisy = await verifyOutputOracleFile({
    role: 'noisy_input',
    manifestPath: resolvedManifestPath,
    value: firstText(
      manifest.noisyInputPath,
      manifest.noisy_input_path,
      manifest.inputNoisyPath,
      manifest.input_noisy_path,
      manifest.inputPath,
      manifest.input_path,
    ),
    declaredSha256: firstText(
      manifest.noisyInputSha256,
      manifest.noisy_input_sha256,
      manifest.inputNoisySha256,
      manifest.input_noisy_sha256,
      manifest.inputSha256,
      manifest.input_sha256,
    ),
    allowedRoots,
  });
  const denoised = await verifyOutputOracleFile({
    role: 'denoised_output',
    manifestPath: resolvedManifestPath,
    value: firstText(
      manifest.denoisedOutputPath,
      manifest.denoised_output_path,
      manifest.outputPath,
      manifest.output_path,
      manifest.afterPath,
      manifest.after_path,
    ),
    declaredSha256: firstText(
      manifest.denoisedOutputSha256,
      manifest.denoised_output_sha256,
      manifest.outputSha256,
      manifest.output_sha256,
      manifest.afterSha256,
      manifest.after_sha256,
    ),
    allowedRoots,
  });
  const expectedPath = firstText(manifest.expectedOutputPath, manifest.expected_output_path);
  const expectedSha256 = normalizeSha256(firstText(
    manifest.expectedOutputSha256,
    manifest.expected_output_sha256,
  ));
  const expected = expectedPath
    ? await verifyOutputOracleFile({
      role: 'expected_output',
      manifestPath: resolvedManifestPath,
      value: expectedPath,
      declaredSha256: expectedSha256,
      allowedRoots,
    })
    : null;
  failedGates.push(...noisy.failedGates, ...denoised.failedGates, ...(expected?.failedGates ?? []));
  const outputDistinctFromInput = Boolean(noisy.sha256 && denoised.sha256 && noisy.sha256 !== denoised.sha256);
  if (!outputDistinctFromInput) failedGates.push('oidn_output_oracle_output_equals_input');
  const expectedHash = expected?.sha256 ?? expectedSha256;
  if (!expectedHash) {
    failedGates.push('oidn_expected_output_hash_missing');
  } else if (denoised.sha256 && denoised.sha256 !== expectedHash) {
    failedGates.push('oidn_expected_output_hash_mismatch');
  }
  const accepted = failedGates.length === 0;
  const evidenceRefs = accepted
    ? [
      `oidn-output-oracle-manifest:sha256:${sha256Buffer(manifestBytes)}`,
      `oidn-output-oracle-noisy:${noisy.sha256}`,
      `oidn-output-oracle-denoised:${denoised.sha256}`,
      `oidn-output-oracle-expected:${expectedHash}`,
    ]
    : [];
  const facetBase = {
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    schema_version: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    proof_authority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    backend: 'oidn_hip',
    device: 'hip',
    manifestPath: resolvedManifestPath,
    manifest_path: resolvedManifestPath,
    manifestSha256: `sha256:${sha256Buffer(manifestBytes)}`,
    manifest_sha256: `sha256:${sha256Buffer(manifestBytes)}`,
    allowedRoots,
    allowed_roots: allowedRoots,
    files: [noisy, denoised, ...(expected ? [expected] : [])],
    outputDistinctFromInput,
    output_distinct_from_input: outputDistinctFromInput,
    expectedOutputSha256: expectedHash,
    expected_output_sha256: expectedHash,
    expectedOutputMatched: accepted,
    expected_output_matched: accepted,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates: [...new Set(failedGates)].map((code) => ({ code })),
    failed_gates: [...new Set(failedGates)].map((code) => ({ code })),
  };
  return {
    ...facetBase,
    outputOracleHash: `sha256:${sha256Json(facetBase)}`,
    output_oracle_hash: `sha256:${sha256Json(facetBase)}`,
  };
}

function execDockerShell(command, timeoutMs = CFG.timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile(
      'docker',
      ['exec', CFG.workerContainer, 'sh', '-lc', command],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ended = process.hrtime.bigint();
        resolve({
          exitCode: typeof err?.code === 'number' ? err.code : 0,
          signal: err?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          durationMs: Number(ended - started) / 1_000_000,
          timedOut: err?.killed === true && err?.signal === 'SIGTERM',
        });
      },
    );
  });
}

async function findTool() {
  const repo = shellQuote(CFG.repoPath);
  const probe = [
    `cd ${repo}`,
    'if [ -x build/_deps/oidnbinaries-src/bin/oidnTest ]; then printf "%s\\n" build/_deps/oidnbinaries-src/bin/oidnTest; exit 0; fi',
    'find . -path "*/bin/oidnTest" -type f -perm -111 2>/dev/null | sort | head -n 1',
  ].join(' && ');
  const result = await execDockerShell(probe, 30000);
  const tool = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return { tool, probe: summarizeCommand(result) };
}

async function findHipDeviceLibrary() {
  const repo = shellQuote(CFG.repoPath);
  const probe = [
    `cd ${repo}`,
    'find . -name "libOpenImageDenoise_device_hip.so*" -type f 2>/dev/null | sort | head -n 1',
  ].join(' && ');
  const result = await execDockerShell(probe, 30000);
  const library = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return { library, probe: summarizeCommand(result) };
}

function decodeBase64Field(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return Buffer.from(text, 'base64').toString('utf8');
}

async function inspectWorkerPath(workerPath, kind) {
  if (!workerPath) {
    return {
      kind,
      path: null,
      found: false,
      resolvedPath: null,
      isSymlink: false,
      fileType: null,
      sha256: null,
      wrapperOrShimDetected: false,
      probe: null,
    };
  }
  const repo = shellQuote(CFG.repoPath);
  const cmd = [
    `cd ${repo}`,
    `p=${shellQuote(workerPath)}`,
    'if [ ! -e "$p" ]; then printf "SYNTHI_OIDN_PATH_INSPECTION found=0 kind=%s path_b64=%s\\n" '
      + `${shellQuote(kind)} "$(printf '%s' "$p" | base64 | tr -d '\\n')"; exit 0; fi`,
    'resolved="$(readlink -f "$p" 2>/dev/null || printf "%s" "$p")"',
    'file_type="$(file -b "$p" 2>/dev/null || printf unknown)"',
    'sha="$(sha256sum "$p" 2>/dev/null | awk \'{print $1}\')"',
    'is_symlink=0; if [ -L "$p" ]; then is_symlink=1; fi',
    'printf "SYNTHI_OIDN_PATH_INSPECTION found=1 kind=%s path_b64=%s resolved_b64=%s is_symlink=%s file_b64=%s sha256=%s\\n" '
      + `${shellQuote(kind)} "$(printf '%s' "$p" | base64 | tr -d '\\n')" "$(printf '%s' "$resolved" | base64 | tr -d '\\n')" "$is_symlink" "$(printf '%s' "$file_type" | base64 | tr -d '\\n')" "$sha"`,
  ].join(' && ');
  const result = await execDockerShell(cmd, 30000);
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
    .find((entry) => entry.includes('SYNTHI_OIDN_PATH_INSPECTION')) ?? '';
  const found = /\bfound=1\b/.test(line);
  const isSymlink = /\bis_symlink=1\b/.test(line);
  const fileType = decodeBase64Field(/\bfile_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]);
  const pathValue = decodeBase64Field(/\bpath_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]) || workerPath;
  const resolvedPath = decodeBase64Field(/\bresolved_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]) || null;
  const sha = /\bsha256=([0-9a-fA-F]{64})\b/.exec(line)?.[1] ?? null;
  const expectedElf = kind === 'oidn_tool' || kind === 'oidn_hip_device_library';
  const wrapperOrShimDetected = found && expectedElf && !/\bELF\b/i.test(fileType);
  return {
    kind,
    path: pathValue,
    found,
    resolvedPath,
    resolved_path: resolvedPath,
    isSymlink,
    is_symlink: isSymlink,
    fileType,
    file_type: fileType,
    sha256: sha ? `sha256:${sha}` : null,
    wrapperOrShimDetected,
    wrapper_or_shim_detected: wrapperOrShimDetected,
    probe: summarizeCommand(result),
  };
}

async function buildPathIntegrity({ tool, library }) {
  const inspections = [
    await inspectWorkerPath(tool, 'oidn_tool'),
    await inspectWorkerPath(library, 'oidn_hip_device_library'),
  ];
  const inspectedExisting = inspections.filter((entry) => entry.found);
  const symlinkedPaths = inspectedExisting.filter((entry) => entry.isSymlink).map((entry) => entry.path);
  const wrapperPaths = inspectedExisting
    .filter((entry) => entry.wrapperOrShimDetected)
    .map((entry) => ({ path: entry.path, fileType: entry.fileType }));
  const noShimApplied = wrapperPaths.length === 0;
  const noSymlinkApplied = symlinkedPaths.length === 0;
  return {
    schemaVersion: 'synthi.gpu_hmr.oidn_path_integrity.v1',
    inspections,
    noShimApplied,
    no_shim_applied: noShimApplied,
    noSymlinkApplied,
    no_symlink_applied: noSymlinkApplied,
    noSynthesizedRuntime: noShimApplied && noSymlinkApplied,
    no_synthesized_runtime: noShimApplied && noSymlinkApplied,
    symlinkedPaths,
    symlinked_paths: symlinkedPaths,
    wrapperOrShimPaths: wrapperPaths,
    wrapper_or_shim_paths: wrapperPaths,
    failedGates: [
      ...(noShimApplied ? [] : ['oidn_wrapper_or_shim_detected']),
      ...(noSymlinkApplied ? [] : ['oidn_symlinked_runtime_artifact_detected']),
    ],
    failed_gates: [
      ...(noShimApplied ? [] : ['oidn_wrapper_or_shim_detected']),
      ...(noSymlinkApplied ? [] : ['oidn_symlinked_runtime_artifact_detected']),
    ],
  };
}

function summarizeCommand(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Number(result.durationMs.toFixed(3)),
    timedOut: result.timedOut,
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-4000),
  };
}

async function runOidnTest(tool, name, device) {
  const repo = shellQuote(CFG.repoPath);
  const cmd = [
    `cd ${repo}`,
    `${shellQuote(tool)} ${shellQuote(name)} --device ${shellQuote(device)} --success --durations yes --rng-seed ${shellQuote(CFG.seed)}`,
  ].join(' && ');
  const result = await execDockerShell(cmd, CFG.timeoutMs);
  return {
    name,
    device,
    command: `oidnTest ${JSON.stringify(name)} --device ${device} --success --durations yes --rng-seed ${CFG.seed}`,
    passed: result.exitCode === 0,
    ...summarizeCommand(result),
  };
}

async function runLdd(library) {
  if (!library) {
    return {
      library: null,
      found: false,
      missingLibraries: [],
      command: null,
      result: null,
    };
  }
  const repo = shellQuote(CFG.repoPath);
  const cmd = `cd ${repo} && ldd ${shellQuote(library)}`;
  const result = await execDockerShell(cmd, 30000);
  const text = `${result.stdout}\n${result.stderr}`;
  return {
    library,
    found: true,
    missingLibraries: missingLibrariesFromLdd(text),
    command: `ldd ${library}`,
    result: summarizeCommand(result),
  };
}

function missingLibrariesFromLdd(text) {
  const missing = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s=>]+)\s*=>\s*not found\b/);
    if (match) missing.add(match[1]);
  }
  return [...missing].sort();
}

function classifyPreflight({ oidnTool, tests, ldd, pathIntegrity = null, outputOracle = null }) {
  const hipTests = tests.filter((test) => test.device === 'hip');
  const cpuTests = tests.filter((test) => test.device === 'cpu');
  const hipTestsPassed = hipTests.length > 0 && hipTests.every((test) => test.passed);
  const pathIntegrityAccepted =
    pathIntegrity === null
    || (
      pathIntegrity.noShimApplied === true
      && pathIntegrity.noSymlinkApplied === true
      && pathIntegrity.noSynthesizedRuntime === true
    );
  const oidnHipRuntimePreflightAccepted = hipTestsPassed && pathIntegrityAccepted;
  const cpuPassed = cpuTests.length > 0 && cpuTests.every((test) => test.passed);
  const missingLibs = ldd?.missingLibraries ?? [];
  const unsupportedReasons = [];
  if (!oidnTool) unsupportedReasons.push('oidnTest_not_found');
  for (const test of hipTests.filter((entry) => !entry.passed)) {
    unsupportedReasons.push(`oidn_hip_${test.name.replace(/[^a-zA-Z0-9]+/g, '_')}_failed`);
  }
  for (const lib of missingLibs) {
    unsupportedReasons.push(`missing_dependency:${lib}`);
  }
  for (const gate of pathIntegrity?.failedGates ?? pathIntegrity?.failed_gates ?? []) {
    unsupportedReasons.push(gate);
  }
  const outputOracleAccepted = outputOracle?.accepted === true;
  const outputProofGaps = outputOracleAccepted
    ? []
    : ['oidn_output_oracle_not_proven'];
  const openGaps = oidnHipRuntimePreflightAccepted
    ? (outputOracleAccepted ? ['oidn_full_runtime_hmr_ledger_not_proven'] : outputProofGaps)
    : [...new Set(unsupportedReasons)].sort();
  return {
    oidnHipRuntimePreflightAccepted,
    oidnHipOutputProofAccepted: oidnHipRuntimePreflightAccepted && outputOracleAccepted,
    oidnHipOutputOracleProven: oidnHipRuntimePreflightAccepted && outputOracleAccepted,
    oidnHipTestsPassed: hipTestsPassed,
    oidnCpuDiagnosticsPassed: cpuPassed,
    resultState: oidnHipRuntimePreflightAccepted
      ? (
        outputOracleAccepted
          ? 'oidn-hip-output-oracle-accepted-preflight-only'
          : 'oidn-hip-runtime-preflight-accepted'
      )
      : 'oidn-hip-rejected',
    unsupportedReasons: [...new Set(unsupportedReasons)].sort(),
    outputProofGaps,
    output_proof_gaps: outputProofGaps,
    openGaps,
    open_gaps: openGaps,
    missingLibraries: missingLibs,
    outputOracleAccepted,
    output_oracle_accepted: outputOracleAccepted,
  };
}

function preflightBackendEvidence({ toolProbe, libraryProbe, tests, ldd, pathIntegrity }) {
  const evidenceRefs = [
    'probe:oidn_tool',
    'probe:oidn_hip_device_library',
    'probe:oidn_hip_tests',
    'probe:oidn_cpu_diagnostics',
    'probe:oidn_hip_ldd',
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs,
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs,
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      workerContainer: CFG.workerContainer,
      repoPath: CFG.repoPath,
      toolFound: Boolean(toolProbe.tool),
      hipDeviceLibraryFound: Boolean(libraryProbe.library),
      hipTestCount: tests.filter((test) => test.device === 'hip').length,
      cpuDiagnosticCount: tests.filter((test) => test.device === 'cpu').length,
      missingLibraries: ldd?.missingLibraries ?? [],
      noShimApplied: pathIntegrity.noShimApplied,
      noSymlinkApplied: pathIntegrity.noSymlinkApplied,
      noSynthesizedRuntime: pathIntegrity.noSynthesizedRuntime,
      pathIntegrity,
      evidenceRefs,
    },
    evidenceRefs,
  };
}

function oidnPreflightTimingMetrics({ durationNs, classification }) {
  const editHash = sha256Stable({
    workerContainer: CFG.workerContainer,
    repoPath: CFG.repoPath,
    seed: CFG.seed,
    outputOracleManifestPath: CFG.outputOracleManifestPath || null,
  });
  return {
    schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
    schema_version: 'synthi.gpu.hmr.runner_timing_metrics.v1',
    proofAuthority: 'oidn_preflight_timing_telemetry_only_not_gpu_hmr_success',
    proof_authority: 'oidn_preflight_timing_telemetry_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    metricClock: 'monotonic_ns',
    metric_clock: 'monotonic_ns',
    metricScope: 'cold',
    metric_scope: 'cold',
    cacheState: 'clean',
    cache_state: 'clean',
    editId: `${cleanToken(CFG.slug)}:oidn-runtime-preflight`,
    edit_id: `${cleanToken(CFG.slug)}:oidn-runtime-preflight`,
    editHash,
    edit_hash: editHash,
    editKind: 'runtime_preflight',
    edit_kind: 'runtime_preflight',
    differentEdit: false,
    different_edit: false,
    resultState: classification?.resultState ?? null,
    result_state: classification?.resultState ?? null,
    timings: {
      runtime_probe_time: durationNs,
      total_validator_wall_time: durationNs,
    },
  };
}

async function buildProof() {
  if (!CFG.workerContainer) failConfig('OIDN preflight requires a worker container');
  if (!CFG.repoPath) failConfig('OIDN preflight requires the HIPRT/OIDN repo path inside the worker');

  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const toolProbe = await findTool();
  const libraryProbe = await findHipDeviceLibrary();
  const pathIntegrity = await buildPathIntegrity({
    tool: toolProbe.tool,
    library: libraryProbe.library,
  });
  const tests = [];
  if (toolProbe.tool) {
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'cpu'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'cpu'));
  }
  const ldd = await runLdd(libraryProbe.library);
  const outputOracle = await buildOidnOutputOracleEvidence(CFG.outputOracleManifestPath);
  const classification = classifyPreflight({
    oidnTool: toolProbe.tool,
    tests,
    ldd,
    pathIntegrity,
    outputOracle,
  });
  const ended = process.hrtime.bigint();
  const durationNs = Number(ended - started);
  const timingMetrics = oidnPreflightTimingMetrics({ durationNs, classification });
  const proofBase = {
    schema: 'synthi.gpu_hmr.oidn_preflight.v1',
    slug: CFG.slug,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((durationNs / 1_000_000).toFixed(3)),
    timingMetrics,
    timing_metrics: timingMetrics,
    workerContainer: CFG.workerContainer,
    repoPath: CFG.repoPath,
    seed: CFG.seed,
    oidnTool: toolProbe.tool || null,
    oidnToolProbe: toolProbe.probe,
    hipDeviceLibrary: libraryProbe.library || null,
    hipDeviceLibraryProbe: libraryProbe.probe,
    pathIntegrity,
    path_integrity: pathIntegrity,
    ldd,
    tests,
    backendEvidence: preflightBackendEvidence({
      toolProbe,
      libraryProbe,
      tests,
      ldd,
      pathIntegrity,
    }),
    outputOracle,
    output_oracle: outputOracle,
    classification,
    acceptance: {
      acceptedForOidnHipRuntimePreflight: classification.oidnHipRuntimePreflightAccepted,
      acceptedForHipOutputProof: classification.oidnHipOutputProofAccepted,
      acceptedForOidnHipOutputProof: classification.oidnHipOutputProofAccepted,
      outputOracleProven: classification.oidnHipOutputOracleProven,
      output_oracle_proven: classification.oidnHipOutputOracleProven,
      gpuHmrSuccess: false,
      reason: classification.oidnHipOutputProofAccepted
        ? 'preflight_output_oracle_only_full_runtime_hmr_ledger_still_required'
        : (
          classification.oidnHipRuntimePreflightAccepted
            ? 'preflight_only_oidn_output_oracle_still_required'
            : 'oidn_hip_runtime_preflight_rejected'
        ),
      openGaps: classification.openGaps,
      open_gaps: classification.openGaps,
      cpuDiagnosticOnly:
        classification.oidnCpuDiagnosticsPassed
        && !classification.oidnHipRuntimePreflightAccepted,
      noShimApplied: pathIntegrity.noShimApplied,
      noSymlinkApplied: pathIntegrity.noSymlinkApplied,
      noSynthesizedRuntime: pathIntegrity.noSynthesizedRuntime,
    },
  };
  const proofId = `oidn-preflight-proof:sha256:${sha256Json(proofBase)}`;
  return { ...proofBase, proofId };
}

async function writeProof(proof) {
  await mkdir(CFG.outputDir, { recursive: true });
  const base = cleanToken(CFG.slug);
  const jsonPath = path.join(CFG.outputDir, `${base}-proof.json`);
  const txtPath = path.join(CFG.outputDir, `${base}-summary.txt`);
  const summary = [
    `proof_id=${proof.proofId}`,
    `result_state=${proof.classification.resultState}`,
    `oidn_tool=${proof.oidnTool ?? 'missing'}`,
    `hip_device_library=${proof.hipDeviceLibrary ?? 'missing'}`,
    `oidn_hip_runtime_preflight_accepted=${proof.classification.oidnHipRuntimePreflightAccepted}`,
    `oidn_hip_output_proof_accepted=${proof.classification.oidnHipOutputProofAccepted}`,
    `oidn_output_oracle_manifest=${proof.outputOracle?.manifestPath ?? 'none'}`,
    `oidn_output_oracle_accepted=${proof.outputOracle?.accepted ?? false}`,
    `oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`,
    `open_gaps=${proof.classification.openGaps.join(',') || 'none'}`,
    `missing_libraries=${proof.classification.missingLibraries.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_symlink_applied=${proof.acceptance.noSymlinkApplied}`,
    `no_synthesized_runtime=${proof.acceptance.noSynthesizedRuntime}`,
  ].join('\n') + '\n';
  await writeFile(jsonPath, JSON.stringify(proof, null, 2));
  await writeFile(txtPath, summary);
  return { jsonPath, txtPath };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfCheck() {
  const missing = missingLibrariesFromLdd(`
    linux-vdso.so.1 (0x00007fff)
    libamdhip64.so.5 => not found
    libOpenImageDenoise.so.2 => /x/libOpenImageDenoise.so.2
    libfoo.so => not found
  `);
  assert(JSON.stringify(missing) === JSON.stringify(['libamdhip64.so.5', 'libfoo.so']), 'ldd missing library parser failed');
  const rejected = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: false },
      { name: 'buffer read/write', device: 'hip', passed: false },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: ['libamdhip64.so.5'] },
  });
  assert(rejected.resultState === 'oidn-hip-rejected', 'rejected state not classified');
  assert(rejected.oidnCpuDiagnosticsPassed === true, 'cpu diagnostic classification failed');
  assert(rejected.unsupportedReasons.includes('missing_dependency:libamdhip64.so.5'), 'missing dependency reason absent');
  const accepted = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
  });
  assert(accepted.resultState === 'oidn-hip-runtime-preflight-accepted', 'runtime preflight state not classified');
  assert(accepted.oidnHipRuntimePreflightAccepted === true, 'HIP runtime preflight should be accepted');
  assert(accepted.oidnHipOutputProofAccepted === false, 'OIDN HIP runtime preflight must not imply output proof');
  const outputAccepted = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
    outputOracle: { accepted: true },
  });
  assert(
    outputAccepted.resultState === 'oidn-hip-output-oracle-accepted-preflight-only',
    'accepted output oracle state not classified',
  );
  assert(outputAccepted.oidnHipOutputProofAccepted === true, 'accepted output oracle should satisfy OIDN output proof');
  assert(
    outputAccepted.openGaps.includes('oidn_full_runtime_hmr_ledger_not_proven'),
    'accepted OIDN output proof must still require full runtime ledger',
  );
  const timingMetrics = oidnPreflightTimingMetrics({
    durationNs: 123456789,
    classification: outputAccepted,
  });
  assert(timingMetrics.metricClock === 'monotonic_ns', 'OIDN timing metric clock must be monotonic_ns');
  assert(timingMetrics.metricScope === 'cold', 'OIDN preflight timing must use the accepted cold scope');
  assert(timingMetrics.editKind === 'runtime_preflight', 'OIDN timing edit kind must identify runtime preflight');
  assert(timingMetrics.timings.runtime_probe_time === 123456789, 'OIDN runtime probe timing missing');
  assert(timingMetrics.acceptedForGpuHmr === false, 'OIDN timing cannot claim GPU HMR acceptance');
  assert(timingMetrics.gpuHmrSuccess === false, 'OIDN timing cannot claim GPU HMR success');
  assert(timingMetrics.canSatisfyRuntimeProof === false, 'OIDN timing cannot satisfy runtime proof');
  const shimRejected = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
    pathIntegrity: {
      noShimApplied: false,
      noSymlinkApplied: true,
      noSynthesizedRuntime: false,
      failedGates: ['oidn_wrapper_or_shim_detected'],
    },
  });
  assert(shimRejected.resultState === 'oidn-hip-rejected', 'shimmed OIDN path must reject HIP acceptance');
  assert(
    shimRejected.unsupportedReasons.includes('oidn_wrapper_or_shim_detected'),
    'shim rejection reason absent',
  );
  return runOutputOracleSelfCheck().then(() => {
    console.log('[ok] OIDN preflight self-check passed');
  });
}

async function runOutputOracleSelfCheck() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synthi-oidn-oracle-'));
  const noisyPath = path.join(dir, 'noisy.bin');
  const denoisedPath = path.join(dir, 'denoised.bin');
  const expectedPath = path.join(dir, 'expected.bin');
  await writeFile(noisyPath, Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(denoisedPath, Buffer.from([0, 2, 4, 6, 8, 10]));
  await writeFile(expectedPath, Buffer.from([0, 2, 4, 6, 8, 10]));
  const denoisedHash = normalizeSha256(sha256Buffer(await readFile(denoisedPath)));
  const manifestPath = path.join(dir, 'oracle.json');
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
    noisyInputPath: noisyPath,
    denoisedOutputPath: denoisedPath,
    expectedOutputPath: expectedPath,
    expectedOutputSha256: denoisedHash,
  }, null, 2));
  const accepted = await buildOidnOutputOracleEvidence(manifestPath);
  assert(accepted.accepted === true, `OIDN output oracle should accept: ${JSON.stringify(accepted.failedGates)}`);
  assert(accepted.acceptedForGpuHmr === false, 'OIDN output oracle cannot claim GPU HMR acceptance');
  assert(accepted.gpuHmrSuccess === false, 'OIDN output oracle cannot claim GPU HMR success');

  const forgedPath = path.join(dir, 'forged.json');
  await writeFile(forgedPath, JSON.stringify({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
    noisyInputPath: noisyPath,
    denoisedOutputPath: denoisedPath,
    expectedOutputSha256: `sha256:${'0'.repeat(64)}`,
    gpuHmrSuccess: true,
  }, null, 2));
  const forged = await buildOidnOutputOracleEvidence(forgedPath);
  const forgedGates = forged.failedGates.map((gate) => gate.code);
  assert(forged.accepted === false, 'forged OIDN output oracle should reject');
  assert(
    forgedGates.includes('oidn_output_oracle_claims_gpu_hmr_success'),
    `forged success gate missing: ${forgedGates.join(',')}`,
  );
  assert(
    forgedGates.includes('oidn_expected_output_hash_mismatch'),
    `forged expected hash gate missing: ${forgedGates.join(',')}`,
  );
}

if (args.has('--self-check')) {
  await runSelfCheck();
} else {
  const proof = await buildProof();
  const paths = await writeProof(proof);
  console.log(`proof_id=${proof.proofId}`);
  console.log(`result_state=${proof.classification.resultState}`);
  console.log(`oidn_hip_runtime_preflight_accepted=${proof.classification.oidnHipRuntimePreflightAccepted}`);
  console.log(`oidn_hip_output_proof_accepted=${proof.classification.oidnHipOutputProofAccepted}`);
  console.log(`oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`);
  console.log(`proof_json=${paths.jsonPath}`);
  console.log(`summary_txt=${paths.txtPath}`);
  if (!proof.classification.oidnHipRuntimePreflightAccepted && (CFG.requireHip || !CFG.allowRejected)) {
    process.exitCode = 1;
  }
}
