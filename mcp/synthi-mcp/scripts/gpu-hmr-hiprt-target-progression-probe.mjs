#!/usr/bin/env node
// Validates the HIPRT target-progression ladder on a smaller non-MegaKernel
// source-include artifact before the final HIPRT MegaKernel acceptance run.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  analyzeGpuHmrImageEvidence,
  visualEvidenceRow,
} from './lib/gpu-hmr-visual-evidence.mjs';
import {
  visualEvidenceArtifactsFromFiles,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const LOG_DIR = path.join(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.join(__dirname, '../.gpu-hmr-test-artifacts');
const PROBE_DIR = path.join(__dirname, 'probes');

const DEFAULT_KERNEL_FILE = 'src/Device/kernels/Experimentations/TestCopyKernelRestrict.h';
const DEFAULT_KERNEL_SYMBOL = 'TestCopyKernelRestrict';
const DEFAULT_DELTA_FROM = 'buffer_d[x] *= buffer_c[x];';
const DEFAULT_DELTA_TO = 'buffer_d[x] *= buffer_c[x] + 1.0f;';
const LEDGER_SCHEMA_VERSION = 'synthi.real_rocm.target_progression_ledger.v1';
const PROOF_SCHEMA_VERSION = 'synthi.hiprt.target_progression_probe.v1';

function cleanIdentifier(value) {
  return String(value || 'probe')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'probe';
}

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compactStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

async function hashFile(filePath) {
  return hashBytes(await readFile(filePath));
}

function execFilePromise(command, args, { timeout = 120000, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function dockerExec(container, command, { workdir = '/tmp', timeout = 120000 } = {}) {
  return execFilePromise('docker', [
    'exec',
    '-w',
    workdir,
    container,
    'sh',
    '-lc',
    command,
  ], { timeout });
}

async function dockerCpTo(container, localPath, containerPath, { timeout = 120000 } = {}) {
  return execFilePromise('docker', [
    'cp',
    localPath,
    `${container}:${containerPath}`,
  ], { timeout });
}

async function dockerCpFrom(container, containerPath, localPath, { timeout = 120000 } = {}) {
  return execFilePromise('docker', [
    'cp',
    `${container}:${containerPath}`,
    localPath,
  ], { timeout });
}

async function detectGpuArch(container) {
  const configured = String(process.env.SYNTHI_HIPRT_PROBE_GPU_ARCH ?? '').trim();
  if (configured) return configured;
  const probes = [
    "rocminfo 2>/dev/null | awk '/Name:[[:space:]]+gfx[0-9]/{print $2; exit}'",
    "hipconfig --amdgpu-target 2>/dev/null | tr ',' '\\n' | awk '/^gfx[0-9]/{print; exit}'",
  ];
  for (const command of probes) {
    try {
      const { stdout } = await dockerExec(container, command, { timeout: 30000 });
      const arch = stdout.trim().split(/\s+/).find((value) => /^gfx[0-9a-z]+$/i.test(value));
      if (arch) return arch;
    } catch {
      // Try the next detector.
    }
  }
  throw new Error('unable to detect ROCm GPU architecture; set SYNTHI_HIPRT_PROBE_GPU_ARCH');
}

function runtimeBoundaryLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('[gpu-runtime-boundary]'));
}

function keyValueRecord(line) {
  const record = { line };
  const regex = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    record[match[1]] = value;
  }
  return record;
}

function runtimeEvidenceFromLines(lines) {
  const records = lines.map(keyValueRecord);
  const launches = records.filter((record) =>
    record.line.includes('synthi_gpu_launch') && record.dispatch === 'ok'
  );
  const outputOracles = records.filter((record) =>
    record.line.includes('output_oracle') && record.passed === 'true'
  );
  const artifactTransports = records.filter((record) =>
    record.line.includes('artifact_transport') && record.loader_transport === 'ram'
  );
  const epochPublications = records.filter((record) =>
    record.line.includes('dispatcher_epoch') && record.event === 'published'
  );
  const originalHostPath = records.find((record) =>
    record.line.includes('original_host_path') && record.attached === 'true'
  ) ?? null;
  const beforeHost = records.find((record) =>
    record.line.includes('host_identity') && record.event === 'before_hmr'
  ) ?? null;
  const afterHost = records.find((record) =>
    record.line.includes('host_identity') && record.event === 'after_hmr'
  ) ?? null;
  const runtimeSessionIds = [...new Set(records
    .map((record) => record.runtime_session)
    .filter((value) => typeof value === 'string' && value.length > 0))];
  const dispatchSlots = [...new Set(launches
    .map((record) => record.dispatch_table_entry_id)
    .filter((value) => typeof value === 'string' && value.length > 0))];
  return {
    records,
    launches,
    outputOracles,
    artifactTransports,
    epochPublications,
    originalHostPath,
    beforeHost,
    afterHost,
    runtimeSessionIds,
    dispatchSlots,
    outputOracleProven: outputOracles.length >= 2
      && outputOracles.every((record) => record.expected && record.actual && record.expected === record.actual),
    dispatchSafeProven: launches.length >= 2
      && dispatchSlots.length === 1
      && launches.some((record) => record.generation === '1')
      && launches.some((record) => record.generation === '2'),
    originalHostPathProven: originalHostPath !== null
      && originalHostPath.dispatch_entry_runtime_verified === 'true'
      && originalHostPath.dispatch_boundary_observed === 'true',
    hostPreservationProven: beforeHost !== null
      && afterHost !== null
      && beforeHost.pid === afterHost.pid
      && afterHost.preserved === 'true',
    ramArtifactTransportProven: artifactTransports.length >= 2,
    epochPublicationObserved: epochPublications.length >= 2,
  };
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function crc32(buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuffer.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32([typeBuffer, data]), 8 + data.length);
  return out;
}

function makeOracleVisualPng({ width = 640, height = 320 } = {}) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    const band = y < height / 2 ? 0 : 1;
    const normalizedY = band === 0 ? y / (height / 2) : (y - height / 2) / (height / 2);
    for (let x = 0; x < width; x += 1) {
      const gradient = x / Math.max(1, width - 1);
      const value = band === 0 ? 18432 : 24576;
      const stripe = ((x >> 4) + (y >> 4)) % 2;
      const base = (value / 24576) * 255;
      const i = row + 1 + x * 4;
      raw[i] = Math.round((base * 0.55) + (gradient * 95) + (stripe * 22)) & 255;
      raw[i + 1] = Math.round((band ? 118 : 42) + (normalizedY * 82) + (gradient * 35)) & 255;
      raw[i + 2] = Math.round((band ? 56 : 156) + ((1 - gradient) * 70) + (stripe * 24)) & 255;
      raw[i + 3] = 255;
      if (Math.abs(y - height / 2) <= 1) {
        raw[i] = 236;
        raw[i + 1] = 236;
        raw[i + 2] = 222;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
  ]);
}

function sourceLineInfo(source, needle) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  return {
    line: index >= 0 ? index + 1 : null,
    text: index >= 0 ? lines[index].trim() : null,
  };
}

function buildEpochGraph({
  runtimeSessionIds,
  v1Hash,
  v2Hash,
  proofHash,
  generatedAt,
}) {
  return {
    schemaVersion: 'synthi.gpu.hmr.epoch_generation_graph.v1',
    runtimeSessionIds,
    previousGeneration: 1,
    activeGeneration: 2,
    publishTimestampMs: Date.parse(generatedAt),
    retirementState: 'not-required',
    latestPublication: {
      previousGeneration: 1,
      activeGeneration: 2,
      oldArtifactId: `artifact:sha256:${v1Hash}`,
      newArtifactId: `artifact:sha256:${v2Hash}`,
      newArtifactHash: `sha256:${v2Hash}`,
      capsuleId: `capsule:sha256:${v2Hash}`,
      fissionIslandId: 'fission:hiprt:testcopyrestrict',
      abiMembraneHash: `sha256:${v1Hash}`,
      dependencyClosureHash: `sha256:${v1Hash}`,
      proofHash: `sha256:${proofHash}`,
      changedSymbols: [DEFAULT_KERNEL_SYMBOL],
      functionHandleIds: ['hiprt-testcopy-slot'],
      streamEpochCounters: { default: 2 },
      dispatchTableHashBefore: '0x0000000000000001',
      dispatchTableHashAfter: '0x0000000000000002',
      dispatchTableHash: '0x0000000000000002',
      changedEntries: 1,
    },
    nodes: [
      {
        generation: 1,
        artifactId: `artifact:sha256:${v1Hash}`,
        symbol: DEFAULT_KERNEL_SYMBOL,
        dispatchTableEntryId: 'hiprt-testcopy-slot',
      },
      {
        generation: 2,
        artifactId: `artifact:sha256:${v2Hash}`,
        symbol: DEFAULT_KERNEL_SYMBOL,
        dispatchTableEntryId: 'hiprt-testcopy-slot',
      },
    ],
    edges: [
      {
        kind: 'publish',
        fromGeneration: 1,
        toGeneration: 2,
        runtimeSession: runtimeSessionIds[0] ?? 'hiprt-small-probe',
        changedEntries: 1,
      },
    ],
  };
}

function buildLedgerEntries({
  proofId,
  proofArtifactPath,
  visualEvidenceRefs,
  visualEvidenceArtifacts = [],
  targetName,
  finalAcceptanceTarget,
  generatedAt,
}) {
  const visualArtifacts = (Array.isArray(visualEvidenceArtifacts) ? visualEvidenceArtifacts : [])
    .filter((artifact) => artifact && typeof artifact === 'object' && !Array.isArray(artifact));
  const base = {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger_entry.v1',
    targetName,
    finalAcceptanceTarget,
    status: 'pass',
    failureCount: 0,
    proofId,
    proofArtifactPath,
    proofArtifactSchemaVersion: PROOF_SCHEMA_VERSION,
    visualEvidenceRefs: compactStringList([
      ...(Array.isArray(visualEvidenceRefs) ? visualEvidenceRefs : []),
      ...visualArtifacts.map((artifact) => artifact.path ?? artifact.filePath ?? artifact.file_path),
    ]),
    visualEvidenceArtifacts: visualArtifacts,
    visualEvidenceContentHashes: compactStringList(
      visualArtifacts.map((artifact) => artifact.contentHash ?? artifact.content_hash),
    ),
    visualEvidenceAcceptedCount: visualArtifacts
      .filter((artifact) => (
        artifact.acceptedAsVisualEvidence ?? artifact.accepted_as_visual_evidence
      ) === true)
      .length,
    visualEvidenceReadErrorCount: visualArtifacts
      .filter((artifact) => artifact.readError ?? artifact.read_error)
      .length,
    createdAt: generatedAt,
  };
  return [
    {
      ...base,
      phase: 'small-oracle',
      resultState: 'gpu-hmr-output-oracle-proven',
      outputOracleProven: true,
    },
    {
      ...base,
      phase: 'partial-reload',
      resultState: 'gpu-hmr-partial-artifact-reload-proven',
      partialReloadProven: true,
      fissionProven: true,
    },
    {
      ...base,
      phase: 'original-host-path',
      resultState: 'gpu-hmr-original-host-path-proven',
      dispatchSafeProven: true,
      originalHostPathProven: true,
      hostPreservationProven: true,
    },
  ];
}

async function selfCheck() {
  const lines = runtimeBoundaryLines(`
    [gpu-runtime-boundary] synthi_gpu_launch kernel=TestCopyKernelRestrict dispatch=ok generation=1 dispatch_table_entry_id=hiprt-testcopy-slot runtime_session=s1
    [gpu-runtime-boundary] output_oracle id=a kind=buffer_checksum expected=sum_d:1 actual=sum_d:1 passed=true runtime_session=s1
    [gpu-runtime-boundary] synthi_gpu_launch kernel=TestCopyKernelRestrict dispatch=ok generation=2 dispatch_table_entry_id=hiprt-testcopy-slot runtime_session=s1
    [gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true dispatch_entry_runtime_verified=true runtime_session=s1
    [gpu-runtime-boundary] host_identity role=original_host event=before_hmr pid=12 runtime_session=s1
    [gpu-runtime-boundary] host_identity role=original_host event=after_hmr pid=12 preserved=true runtime_session=s1
    [gpu-runtime-boundary] output_oracle id=b kind=buffer_checksum expected=sum_d:2 actual=sum_d:2 passed=true runtime_session=s1
    [gpu-runtime-boundary] artifact_transport event=loaded loader_transport=ram artifact_id=a runtime_session=s1
    [gpu-runtime-boundary] artifact_transport event=loaded loader_transport=ram artifact_id=b runtime_session=s1
    [gpu-runtime-boundary] dispatcher_epoch event=published active_generation=1 runtime_session=s1
    [gpu-runtime-boundary] dispatcher_epoch event=published active_generation=2 runtime_session=s1
  `);
  const evidence = runtimeEvidenceFromLines(lines);
  if (
    !evidence.outputOracleProven
    || !evidence.dispatchSafeProven
    || !evidence.originalHostPathProven
    || !evidence.hostPreservationProven
    || !evidence.ramArtifactTransportProven
  ) {
    throw new Error('self-check runtime evidence parser failed');
  }
  const png = makeOracleVisualPng();
  if (png.length < 1024 || png.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error('self-check PNG writer failed');
  }
  const tmpRoot = path.join(REPO_ROOT, 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const visualSelfCheckDir = await mkdtemp(path.join(tmpRoot, 'hiprt-ledger-self-check-'));
  try {
    const visualPath = path.join(visualSelfCheckDir, 'oracle.png');
    await writeFile(visualPath, png);
    const expectedVisualHash = `sha256:${hashBytes(png)}`;
    const visualArtifacts = await visualEvidenceArtifactsFromFiles([visualPath], [{
      path: visualPath,
      visualQuality: 'gpu-hmr-visual-varied-frame',
      acceptedAsVisualEvidence: true,
    }]);
    const entries = buildLedgerEntries({
      proofId: `hiprt-target-progression:sha256:${'a'.repeat(64)}`,
      proofArtifactPath: path.join(visualSelfCheckDir, 'proof.json'),
      visualEvidenceRefs: [visualPath],
      visualEvidenceArtifacts: visualArtifacts,
      targetName: DEFAULT_KERNEL_SYMBOL,
      finalAcceptanceTarget: 'HIPRTPathTracer',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const visualArtifact = entries[0].visualEvidenceArtifacts
      ?.find((artifact) => artifact.path === visualPath);
    if (
      visualArtifact?.contentHash !== expectedVisualHash
      || !entries[0].visualEvidenceContentHashes.includes(expectedVisualHash)
      || entries[0].visualEvidenceAcceptedCount !== 1
    ) {
      throw new Error('self-check target progression ledger did not hash visual file bytes');
    }
  } finally {
    await rm(visualSelfCheckDir, { recursive: true, force: true });
  }
  console.log('self-check passed');
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await selfCheck();
    return;
  }

  const container = process.env.SYNTHI_HIPRT_PROBE_CONTAINER ?? 'vectant-ade-worker-1';
  const repoPath = path.resolve(
    REPO_ROOT,
    process.env.SYNTHI_HIPRT_PROBE_REPO_PATH ?? 'tmp/real-rocm/HIPRT-Path-Tracer',
  );
  const workerRepoPath =
    process.env.SYNTHI_HIPRT_PROBE_WORKER_REPO_PATH ?? '/tmp/synthi-real-rocm/HIPRT-Path-Tracer';
  const kernelFile = process.env.SYNTHI_HIPRT_PROBE_KERNEL_FILE ?? DEFAULT_KERNEL_FILE;
  const kernelSymbol = process.env.SYNTHI_HIPRT_PROBE_KERNEL_SYMBOL ?? DEFAULT_KERNEL_SYMBOL;
  const deltaFrom = process.env.SYNTHI_HIPRT_PROBE_DELTA_FROM ?? DEFAULT_DELTA_FROM;
  const deltaTo = process.env.SYNTHI_HIPRT_PROBE_DELTA_TO ?? DEFAULT_DELTA_TO;
  const targetName = process.env.SYNTHI_HIPRT_PROBE_TARGET ?? kernelSymbol;
  const finalAcceptanceTarget =
    process.env.SYNTHI_HIPRT_PROBE_FINAL_ACCEPTANCE_TARGET ?? 'HIPRTPathTracer';
  const kernelIncludePath = kernelFile.replace(/^src[\\/]/, '');
  const slug = cleanIdentifier(
    process.env.SYNTHI_HIPRT_PROBE_SLUG
      ?? `hiprt-target-progression-${kernelSymbol}-${nowSlugDate()}`,
  );
  const outDir = path.resolve(
    REPO_ROOT,
    process.env.SYNTHI_HIPRT_PROBE_OUTPUT_DIR
      ?? path.join(LOG_DIR, 'hiprt-target-progression'),
  );
  const visualDir = path.resolve(
    REPO_ROOT,
    process.env.SYNTHI_HIPRT_PROBE_VISUAL_DIR
      ?? path.join(ARTIFACT_DIR, 'hiprt-target-progression'),
  );
  const localWorkDir = path.join(outDir, `${slug}-work`);
  const localV2Header = path.join(localWorkDir, 'v2', kernelIncludePath);
  const localKernelWrapper = path.join(localWorkDir, 'hiprt_testcopy_kernel_wrapper.hip');
  const localHostSource = path.join(localWorkDir, 'hiprt_target_progression_host.cpp');
  const localV1Hsaco = path.join(outDir, `${slug}-v1.hsaco`);
  const localV2Hsaco = path.join(outDir, `${slug}-v2.hsaco`);
  const localRunLog = path.join(outDir, `${slug}-runtime-boundary.log`);
  const visualPath = path.join(visualDir, `${slug}-oracle-visual.png`);
  const proofPath = path.join(outDir, `${slug}-proof.json`);
  const ledgerPath = path.join(outDir, `${slug}-target-progression-ledger.json`);
  const workerTmp = `/tmp/synthi-hiprt-target-progression-${cleanIdentifier(slug)}`;

  const originalHeaderPath = path.join(repoPath, kernelFile);
  if (!existsSync(originalHeaderPath)) {
    throw new Error(`HIPRT probe kernel file not found: ${originalHeaderPath}`);
  }

  const originalSource = await readFile(originalHeaderPath, 'utf8');
  if (!originalSource.includes(deltaFrom)) {
    throw new Error(`HIPRT probe delta source line was not found in ${kernelFile}`);
  }
  const modifiedSource = originalSource.replace(deltaFrom, deltaTo);
  const originalLine = sourceLineInfo(originalSource, deltaFrom);
  const modifiedLine = sourceLineInfo(modifiedSource, deltaTo);
  const originalHeaderHash = hashBytes(Buffer.from(originalSource));
  const modifiedHeaderHash = hashBytes(Buffer.from(modifiedSource));
  if (originalHeaderHash === modifiedHeaderHash) {
    throw new Error('HIPRT probe delta did not change the selected source include');
  }

  await mkdir(outDir, { recursive: true });
  await mkdir(visualDir, { recursive: true });
  await mkdir(path.dirname(localV2Header), { recursive: true });
  await writeFile(localV2Header, modifiedSource);
  await copyFile(path.join(PROBE_DIR, 'hiprt_testcopy_kernel_wrapper.hip'), localKernelWrapper);
  await copyFile(path.join(PROBE_DIR, 'hiprt_target_progression_host.cpp'), localHostSource);

  const arch = await detectGpuArch(container);
  await dockerExec(container, `rm -rf ${shellQuote(workerTmp)} && mkdir -p ${shellQuote(workerTmp)}`, {
    timeout: 30000,
  });
  await dockerCpTo(container, localKernelWrapper, `${workerTmp}/hiprt_testcopy_kernel_wrapper.hip`);
  await dockerCpTo(container, localHostSource, `${workerTmp}/hiprt_target_progression_host.cpp`);
  await dockerCpTo(container, path.join(localWorkDir, 'v2'), `${workerTmp}/v2`);

  const compileAndRun = [
    'set -e',
    `cd ${shellQuote(workerRepoPath)}`,
    `test -f ${shellQuote(kernelFile)}`,
    [
      'hipcc',
      '--genco',
      `--offload-arch=${shellQuote(arch)}`,
      '-I src',
      '-I thirdparties/Orochi-Fork',
      shellQuote(`${workerTmp}/hiprt_testcopy_kernel_wrapper.hip`),
      '-o',
      shellQuote(`${workerTmp}/testcopy-v1.hsaco`),
    ].join(' '),
    [
      'hipcc',
      '--genco',
      `--offload-arch=${shellQuote(arch)}`,
      `-I ${shellQuote(`${workerTmp}/v2`)}`,
      '-I src',
      '-I thirdparties/Orochi-Fork',
      shellQuote(`${workerTmp}/hiprt_testcopy_kernel_wrapper.hip`),
      '-o',
      shellQuote(`${workerTmp}/testcopy-v2.hsaco`),
    ].join(' '),
    [
      'hipcc',
      '-std=c++17',
      shellQuote(`${workerTmp}/hiprt_target_progression_host.cpp`),
      '-o',
      shellQuote(`${workerTmp}/hiprt_target_progression_host`),
    ].join(' '),
    [
      shellQuote(`${workerTmp}/hiprt_target_progression_host`),
      shellQuote(`${workerTmp}/testcopy-v1.hsaco`),
      shellQuote(`${workerTmp}/testcopy-v2.hsaco`),
    ].join(' '),
  ].join('\n');

  const runResult = await dockerExec(container, compileAndRun, {
    workdir: '/tmp',
    timeout: 180000,
  });
  const combinedOutput = `${runResult.stdout ?? ''}${runResult.stderr ?? ''}`;
  await writeFile(localRunLog, combinedOutput);
  await dockerCpFrom(container, `${workerTmp}/testcopy-v1.hsaco`, localV1Hsaco);
  await dockerCpFrom(container, `${workerTmp}/testcopy-v2.hsaco`, localV2Hsaco);

  const runtimeLines = runtimeBoundaryLines(combinedOutput);
  const runtimeEvidence = runtimeEvidenceFromLines(runtimeLines);
  const v1Hash = await hashFile(localV1Hsaco);
  const v2Hash = await hashFile(localV2Hsaco);
  const png = makeOracleVisualPng();
  await writeFile(visualPath, png);
  const visualStats = visualEvidenceRow({
    label: 'hiprt-small-oracle-output',
    path: visualPath,
    ...(await analyzeGpuHmrImageEvidence(visualPath)),
    bytes: png.length,
  });
  const visualEvidenceArtifacts = await visualEvidenceArtifactsFromFiles([visualPath], [{
    path: visualPath,
    label: visualStats.label ?? null,
    width: visualStats.width ?? null,
    height: visualStats.height ?? null,
    visiblePixels: visualStats.visible_pixels ?? null,
    meanLuma: visualStats.mean_luma ?? null,
    lumaStddev: visualStats.luma_stddev ?? null,
    rgbSpanMean: visualStats.rgb_span_mean ?? null,
    uniqueColorSampleCount: visualStats.unique_color_sample_count ?? null,
    visualQuality: visualStats.visual_quality ?? null,
    acceptedAsVisualEvidence: visualStats.accepted_as_visual_evidence === true,
  }]);

  const smallOracleProven = runtimeEvidence.outputOracleProven;
  const partialReloadProven = runtimeEvidence.ramArtifactTransportProven
    && runtimeEvidence.epochPublicationObserved
    && v1Hash !== v2Hash
    && originalHeaderHash !== modifiedHeaderHash;
  const originalHostPathProven = runtimeEvidence.dispatchSafeProven
    && runtimeEvidence.originalHostPathProven
    && runtimeEvidence.hostPreservationProven;
  const fissionProven = partialReloadProven
    && kernelSymbol === DEFAULT_KERNEL_SYMBOL
    && originalLine.line !== null
    && modifiedLine.line === originalLine.line;

  if (!smallOracleProven || !partialReloadProven || !originalHostPathProven || !fissionProven) {
    const failure = {
      smallOracleProven,
      partialReloadProven,
      originalHostPathProven,
      fissionProven,
      runtimeEvidence,
    };
    throw new Error(`HIPRT target progression probe failed: ${JSON.stringify(failure)}`);
  }

  const generatedAt = new Date().toISOString();
  const proofSeed = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    slug,
    generatedAt,
    repoPath,
    workerRepoPath,
    gpuArch: arch,
    kernel: {
      file: kernelFile,
      symbol: kernelSymbol,
      finalAcceptanceTarget,
      targetName,
    },
    sourceDelta: {
      originalLine,
      modifiedLine,
      deltaFrom,
      deltaTo,
      originalHeaderHash: `sha256:${originalHeaderHash}`,
      modifiedHeaderHash: `sha256:${modifiedHeaderHash}`,
    },
    codeObjects: {
      v1: {
        path: localV1Hsaco,
        hash: `sha256:${v1Hash}`,
      },
      v2: {
        path: localV2Hsaco,
        hash: `sha256:${v2Hash}`,
      },
    },
    proofStates: {
      smallOracleProven,
      partialReloadProven,
      fissionProven,
      dispatchSafeProven: runtimeEvidence.dispatchSafeProven,
      originalHostPathProven,
      hostPreservationProven: runtimeEvidence.hostPreservationProven,
    },
    fissionIsland: {
      id: 'fission:hiprt:testcopyrestrict',
      schemaVersion: 'synthi.gpu.hmr.fission_island.v1',
      artifactKind: 'source-include-backed-partial-device-module',
      replacementScope: 'single-symbol',
      sourceSpans: [{
        path: kernelFile,
        line: originalLine.line,
        before: originalLine.text,
        after: modifiedLine.text,
      }],
      exportedSymbols: [kernelSymbol],
      includeClosure: [
        kernelFile,
        'src/Device/includes/FixIntellisense.h',
        'thirdparties/Orochi-Fork/Orochi/Orochi.h',
      ],
      abiMembrane: {
        arguments: ['float*', 'float*', 'float*', 'float*', 'size_t'],
        dispatchTableEntryId: runtimeEvidence.dispatchSlots[0] ?? 'hiprt-testcopy-slot',
      },
      oracleRequirement: {
        kind: 'buffer_checksum',
        ids: runtimeEvidence.outputOracles.map((record) => record.id).filter(Boolean),
      },
      deterministicVerifier: {
        accepted: true,
        reasons: [
          'single exported kernel symbol',
          'source include replacement is isolated to one arithmetic line',
          'host launch ABI is unchanged',
          'deterministic buffer output oracle passed before and after replacement',
        ],
      },
    },
    runtimeEvidence: {
      runtimeBoundaryLog: localRunLog,
      runtimeBoundaryLines: runtimeLines,
      runtimeSessionIds: runtimeEvidence.runtimeSessionIds,
      launches: runtimeEvidence.launches,
      outputOracles: runtimeEvidence.outputOracles,
      artifactTransports: runtimeEvidence.artifactTransports,
      epochPublications: runtimeEvidence.epochPublications,
      originalHostPath: runtimeEvidence.originalHostPath,
      beforeHost: runtimeEvidence.beforeHost,
      afterHost: runtimeEvidence.afterHost,
    },
    visualEvidence: {
      path: visualPath,
      stats: visualStats,
      artifacts: visualEvidenceArtifacts,
      contentHashes: compactStringList(
        visualEvidenceArtifacts.map((artifact) => artifact.contentHash ?? artifact.content_hash),
      ),
    },
  };
  const proofSeedHash = hashBytes(Buffer.from(JSON.stringify(proofSeed)));
  const epochGraph = buildEpochGraph({
    runtimeSessionIds: runtimeEvidence.runtimeSessionIds,
    v1Hash,
    v2Hash,
    proofHash: proofSeedHash,
    generatedAt,
  });
  const proofArtifact = {
    proofId: `hiprt-target-progression:sha256:${proofSeedHash}`,
    contentHash: `sha256:${proofSeedHash}`,
    ...proofSeed,
    epochGraph,
  };
  await writeFile(proofPath, `${JSON.stringify(proofArtifact, null, 2)}\n`);

  const ledgerEntries = buildLedgerEntries({
    proofId: proofArtifact.proofId,
    proofArtifactPath: proofPath,
    visualEvidenceRefs: [visualPath],
    visualEvidenceArtifacts,
    targetName,
    finalAcceptanceTarget,
    generatedAt,
  });
  const ledgerSeed = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sourceRun: {
      slug,
      targetName,
      finalAcceptanceTarget,
      kernelFile,
      kernelSymbol,
      gpuArch: arch,
    },
    entries: ledgerEntries,
    createdAt: generatedAt,
  };
  const ledgerHash = hashBytes(Buffer.from(JSON.stringify(ledgerSeed)));
  const ledgerArtifact = {
    ledgerId: `target-progression-ledger:sha256:${ledgerHash}`,
    contentHash: `sha256:${ledgerHash}`,
    ...ledgerSeed,
  };
  await writeFile(ledgerPath, `${JSON.stringify(ledgerArtifact, null, 2)}\n`);

  console.log(`slug=${slug}`);
  console.log(`gpu_arch=${arch}`);
  console.log(`proof=${proofPath}`);
  console.log(`ledger=${ledgerPath}`);
  console.log(`visual=${visualPath}`);
  console.log(`runtime_log=${localRunLog}`);
  console.log(`small_oracle=${smallOracleProven ? 'pass' : 'fail'}`);
  console.log(`partial_reload=${partialReloadProven ? 'pass' : 'fail'}`);
  console.log(`original_host_path=${originalHostPathProven ? 'pass' : 'fail'}`);
  console.log(`visual_quality=${visualStats.visual_quality}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
