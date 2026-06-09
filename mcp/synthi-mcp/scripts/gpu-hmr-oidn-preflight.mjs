#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));

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

function classifyPreflight({ oidnTool, tests, ldd }) {
  const hipTests = tests.filter((test) => test.device === 'hip');
  const cpuTests = tests.filter((test) => test.device === 'cpu');
  const hipPassed = hipTests.length > 0 && hipTests.every((test) => test.passed);
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
  return {
    oidnHipAccepted: hipPassed,
    oidnCpuDiagnosticsPassed: cpuPassed,
    resultState: hipPassed ? 'oidn-hip-device-available' : 'oidn-hip-rejected',
    unsupportedReasons: [...new Set(unsupportedReasons)].sort(),
    missingLibraries: missingLibs,
  };
}

async function buildProof() {
  if (!CFG.workerContainer) failConfig('OIDN preflight requires a worker container');
  if (!CFG.repoPath) failConfig('OIDN preflight requires the HIPRT/OIDN repo path inside the worker');

  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const toolProbe = await findTool();
  const libraryProbe = await findHipDeviceLibrary();
  const tests = [];
  if (toolProbe.tool) {
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'cpu'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'cpu'));
  }
  const ldd = await runLdd(libraryProbe.library);
  const classification = classifyPreflight({ oidnTool: toolProbe.tool, tests, ldd });
  const ended = process.hrtime.bigint();
  const proofBase = {
    schema: 'synthi.gpu_hmr.oidn_preflight.v1',
    slug: CFG.slug,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((Number(ended - started) / 1_000_000).toFixed(3)),
    workerContainer: CFG.workerContainer,
    repoPath: CFG.repoPath,
    seed: CFG.seed,
    oidnTool: toolProbe.tool || null,
    oidnToolProbe: toolProbe.probe,
    hipDeviceLibrary: libraryProbe.library || null,
    hipDeviceLibraryProbe: libraryProbe.probe,
    ldd,
    tests,
    classification,
    acceptance: {
      acceptedForHipOutputProof: classification.oidnHipAccepted,
      cpuDiagnosticOnly: classification.oidnCpuDiagnosticsPassed && !classification.oidnHipAccepted,
      noShimApplied: true,
      noSymlinkApplied: true,
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
    `oidn_hip_accepted=${proof.classification.oidnHipAccepted}`,
    `oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`,
    `missing_libraries=${proof.classification.missingLibraries.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_symlink_applied=${proof.acceptance.noSymlinkApplied}`,
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
  assert(accepted.resultState === 'oidn-hip-device-available', 'accepted state not classified');
  console.log('[ok] OIDN preflight self-check passed');
}

if (args.has('--self-check')) {
  runSelfCheck();
} else {
  const proof = await buildProof();
  const paths = await writeProof(proof);
  console.log(`proof_id=${proof.proofId}`);
  console.log(`result_state=${proof.classification.resultState}`);
  console.log(`oidn_hip_accepted=${proof.classification.oidnHipAccepted}`);
  console.log(`oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`);
  console.log(`proof_json=${paths.jsonPath}`);
  console.log(`summary_txt=${paths.txtPath}`);
  if (CFG.requireHip && !proof.classification.oidnHipAccepted) {
    process.exitCode = 1;
  }
}
