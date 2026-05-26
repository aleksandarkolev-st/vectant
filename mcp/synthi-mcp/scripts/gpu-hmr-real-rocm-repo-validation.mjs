#!/usr/bin/env node
// Real public ROCm repository validation for GPU HMR.
//
// Default target:
//   https://github.com/ROCm/rocm-examples
//   HIP-Basic/saxpy/main.hip
//
// This script intentionally separates two claims:
//   1. The upstream ROCm target builds and runs in the current worker.
//   2. Synthi can consume the real repo files and apply GPU split/HMR.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  classifyGpuHmrOutputProof,
  summarizeGpuHmrOutputProof,
} from './lib/gpu-hmr-runtime-proof.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_REAL_REPO_URL = 'https://github.com/ROCm/rocm-examples.git';

function cleanIdentifier(value) {
  return String(value || 'repo').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function repoNameFromUrl(repoUrl) {
  const raw = String(repoUrl || DEFAULT_REAL_REPO_URL).split('/').filter(Boolean).at(-1) ?? 'repo';
  return cleanIdentifier(raw.replace(/\.git$/i, ''));
}

const configuredRepoUrl = process.env.SYNTHI_REAL_ROCM_REPO_URL ?? DEFAULT_REAL_REPO_URL;
const configuredRepoName = cleanIdentifier(
  process.env.SYNTHI_REAL_ROCM_REPO_NAME ?? repoNameFromUrl(configuredRepoUrl),
);
const configuredWorkspaceRoot =
  process.env.SYNTHI_REAL_ROCM_WORKSPACE_ROOT ?? `/workspace/${configuredRepoName}`;
const configuredWorkerTempDir =
  process.env.SYNTHI_REAL_ROCM_WORKER_TMP ?? '/tmp/synthi-real-rocm';

const CFG = {
  repoUrl: configuredRepoUrl,
  repoName: configuredRepoName,
  repoPath: path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_REPO_PATH ?? `tmp/real-rocm/${configuredRepoName}`),
  repoCommit: process.env.SYNTHI_REAL_ROCM_COMMIT ?? '',
  initSubmodules: process.env.SYNTHI_REAL_ROCM_INIT_SUBMODULES !== '0',
  entryFile: process.env.SYNTHI_REAL_ROCM_ENTRY ?? 'HIP-Basic/saxpy/main.hip',
  deltaFile: process.env.SYNTHI_REAL_ROCM_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_ENTRY
    ?? 'HIP-Basic/saxpy/main.hip',
  targetName: process.env.SYNTHI_REAL_ROCM_TARGET ?? 'hip_saxpy',
  buildSubdir: process.env.SYNTHI_REAL_ROCM_BUILD_SUBDIR ?? 'HIP-Basic/saxpy',
  workerRepoPath: process.env.SYNTHI_REAL_ROCM_WORKER_PATH ?? `${configuredWorkerTempDir}/${configuredRepoName}`,
  workerTempDir: configuredWorkerTempDir,
  workspaceRoot: configuredWorkspaceRoot,
  workspaceName: process.env.SYNTHI_REAL_ROCM_WORKSPACE_NAME ?? `Synthi Real ROCm Repo Validation - ${configuredRepoName}`,
  seedCommitMessage:
    process.env.SYNTHI_REAL_ROCM_SEED_COMMIT_MESSAGE ??
    `real-rocm-validation: seed ${configuredRepoName} ${process.env.SYNTHI_REAL_ROCM_TARGET ?? 'target'}`,
  cmakeConfigName: process.env.SYNTHI_REAL_ROCM_CMAKE_CONFIG ?? 'Release',
  cmakeTargetType: process.env.SYNTHI_REAL_ROCM_TARGET_TYPE ?? 'EXECUTABLE',
  cmakeTargetIdNamespace: process.env.SYNTHI_REAL_ROCM_TARGET_ID_NAMESPACE ?? 'real-rocm',
  buildMetadataDir: process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR
    ? path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR)
    : '',
  gpuMode: process.env.SYNTHI_REAL_ROCM_GPU_MODE ?? 'rocm',
  buildUpstream: process.env.SYNTHI_REAL_ROCM_BUILD_UPSTREAM !== '0',
  runUpstream: process.env.SYNTHI_REAL_ROCM_RUN_UPSTREAM !== '0',
  upstreamRunCommand: process.env.SYNTHI_REAL_ROCM_UPSTREAM_RUN_COMMAND ?? '',
  width: Number(process.env.SYNTHI_REAL_ROCM_WIDTH ?? 800),
  height: Number(process.env.SYNTHI_REAL_ROCM_HEIGHT ?? 600),
  deltaBefore:
    process.env.SYNTHI_REAL_ROCM_DELTA_BEFORE ??
    'd_y[global_idx] = a * d_x[global_idx] + d_y[global_idx];',
  deltaAfter:
    process.env.SYNTHI_REAL_ROCM_DELTA_AFTER ??
    'd_y[global_idx] = (a + 0.25f) * d_x[global_idx] + d_y[global_idx];',
  secondDeltaFile: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_ENTRY
    ?? 'HIP-Basic/saxpy/main.hip',
  secondDeltaBefore: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE ?? '',
  secondDeltaAfter: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER ?? '',
  extraDeltasJson: process.env.SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON ?? '',
  maxFileBytes: Number(process.env.SYNTHI_REAL_ROCM_MAX_FILE_BYTES ?? 512 * 1024),
  compileContextMaxBytes: Number(process.env.SYNTHI_REAL_ROCM_COMPILE_CONTEXT_MAX_BYTES ?? 48 * 1024 * 1024),
  writeBatchSize: Number(process.env.SYNTHI_REAL_ROCM_WRITE_BATCH_SIZE ?? 200),
  slug: process.env.SLUG ?? `gpu-real-rocm-${configuredRepoName}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  hostId: process.env.HOST_ID ?? 'gpu-hmr-real-rocm-validation',
  mcpClientName: process.env.SYNTHI_REAL_ROCM_MCP_CLIENT_NAME ?? 'real-rocm-validation',
  mcpContainer: process.env.MCP_CONTAINER ?? 'vectant-ade-mcp-1',
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  aiEngineContainer: process.env.AI_ENGINE_CONTAINER ?? 'vectant-ade-ai-engine-1',
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 300000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  firstCompileTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_FIRST_TIMEOUT_MS ?? 300000),
  hmrTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_HMR_TIMEOUT_MS ?? 90000),
  screenshotAttempts: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_ATTEMPTS ?? 3),
  screenshotRetryDelayMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_RETRY_MS ?? 1000),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_FRESHNESS_MS ?? 5000),
  expectScreenshot: process.env.SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT === '1',
  hmrWaitModule: process.env.SYNTHI_REAL_ROCM_HMR_WAIT_MODULE ?? 'device',
  gpuArch: process.env.SYNTHI_REAL_ROCM_GPU_ARCH ?? process.env.SYNTHI_GPU_ARCH ?? 'gfx1201',
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview',
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS === '1',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const RESULTS_JSON = path.join(LOG_DIR, 'real-rocm-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'real-rocm-results.txt');

const report = {
  slug: CFG.slug,
  source_url: CFG.repoUrl,
  repo_path: CFG.repoPath,
  repo_commit: null,
  entry_file: CFG.entryFile,
  delta_file: CFG.deltaFile,
  second_delta_file: CFG.secondDeltaBefore || CFG.secondDeltaAfter ? CFG.secondDeltaFile : null,
  target_name: CFG.targetName,
  model: CFG.geminiModel,
  gpu_vendor: CFG.gpuMode,
  gpu_arch: CFG.gpuArch,
  containers: {
    mcp: CFG.mcpContainer,
    worker: CFG.workerContainer,
    ai_engine: CFG.aiEngineContainer,
  },
  command: {
    cwd: process.cwd(),
    argv: process.argv,
    env: {
      SYNTHI_REAL_ROCM_REPO_URL: process.env.SYNTHI_REAL_ROCM_REPO_URL ?? '',
      SYNTHI_REAL_ROCM_COMMIT: process.env.SYNTHI_REAL_ROCM_COMMIT ?? '',
      SYNTHI_REAL_ROCM_ENTRY: process.env.SYNTHI_REAL_ROCM_ENTRY ?? '',
      SYNTHI_REAL_ROCM_DELTA_FILE: process.env.SYNTHI_REAL_ROCM_DELTA_FILE ?? '',
      SYNTHI_REAL_ROCM_SECOND_DELTA_FILE: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_FILE ?? '',
      SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON: process.env.SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON ?? '',
      SYNTHI_REAL_ROCM_TARGET: process.env.SYNTHI_REAL_ROCM_TARGET ?? '',
      SYNTHI_REAL_ROCM_BUILD_SUBDIR: process.env.SYNTHI_REAL_ROCM_BUILD_SUBDIR ?? '',
      SYNTHI_REAL_ROCM_BUILD_UPSTREAM: process.env.SYNTHI_REAL_ROCM_BUILD_UPSTREAM ?? '',
      SYNTHI_REAL_ROCM_RUN_UPSTREAM: process.env.SYNTHI_REAL_ROCM_RUN_UPSTREAM ?? '',
      SYNTHI_REAL_ROCM_MAX_FILE_BYTES: process.env.SYNTHI_REAL_ROCM_MAX_FILE_BYTES ?? '',
      SYNTHI_REAL_ROCM_COMPILE_CONTEXT_MAX_BYTES: process.env.SYNTHI_REAL_ROCM_COMPILE_CONTEXT_MAX_BYTES ?? '',
      SYNTHI_REAL_ROCM_BUILD_METADATA_DIR: process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR ?? '',
      SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE ?? '',
      SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER ?? '',
      SYNTHI_GEMINI_MODEL: process.env.SYNTHI_GEMINI_MODEL ?? '',
      SYNTHI_GPU_ARCH: process.env.SYNTHI_GPU_ARCH ?? '',
      MCP_CONTAINER: process.env.MCP_CONTAINER ?? '',
      WORKER_CONTAINER: process.env.WORKER_CONTAINER ?? '',
      AI_ENGINE_CONTAINER: process.env.AI_ENGINE_CONTAINER ?? '',
    },
  },
  file_count: 0,
  seeded_file_count: 0,
  skipped_file_count: 0,
  checks: [],
  phases: [],
  screenshots: [],
  logs: {},
  docker: {},
  evidence: {},
  output_proof: null,
  compile_projection: {},
  started_at: new Date().toISOString(),
  finished_at: null,
};

function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  report.checks.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : status === 'warn' ? '[warn]' : '[info]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
}

function execText(cmd, args, timeoutMs = 30000, rejectOnError = false, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err && rejectOnError) {
        err.output = text;
        reject(err);
        return;
      }
      resolve(err ? undefined : text);
    });
  });
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return json ?? {};
}

async function ensureRepo() {
  if (!existsSync(CFG.repoPath)) {
    await mkdir(path.dirname(CFG.repoPath), { recursive: true });
    const cloneArgs = CFG.repoCommit
      ? ['clone', CFG.repoUrl, CFG.repoPath]
      : ['clone', '--depth', '1', CFG.repoUrl, CFG.repoPath];
    await execText('git', cloneArgs, 300000, true);
  }
  if (CFG.repoCommit) {
    const fetched = await execText(
      'git',
      ['-C', CFG.repoPath, 'fetch', '--depth', '1', 'origin', CFG.repoCommit],
      300000,
      false,
    );
    if (fetched === undefined) {
      await execText('git', ['-C', CFG.repoPath, 'fetch', 'origin'], 300000, true);
    }
    await execText('git', ['-C', CFG.repoPath, 'checkout', '--force', CFG.repoCommit], 120000, true);
  }
  if (CFG.initSubmodules) {
    const gitmodules = path.join(CFG.repoPath, '.gitmodules');
    if (existsSync(gitmodules)) {
      await execText(
        'git',
        ['-C', CFG.repoPath, 'submodule', 'update', '--init', '--recursive'],
        600000,
        true,
      );
    }
  }
  const commit = await execText('git', ['-C', CFG.repoPath, 'rev-parse', 'HEAD'], 30000, true);
  report.repo_commit = commit.trim();
  report.submodules = CFG.initSubmodules
    ? await execText('git', ['-C', CFG.repoPath, 'submodule', 'status', '--recursive'], 60000, false)
    : 'submodule initialization disabled';
  const files = await listTrackedFiles();
  report.file_count = files.length;
  record('real ROCm repo', 'pass', `${CFG.repoUrl} @ ${report.repo_commit.slice(0, 12)} files=${report.file_count}`);
}

async function listTrackedFiles() {
  const args = ['-C', CFG.repoPath, 'ls-files', '-z'];
  if (CFG.initSubmodules) args.push('--recurse-submodules');
  const raw = await execText('git', args, 120000, true);
  return raw.split('\0').filter(Boolean).sort();
}

async function prepareUpstreamBuild() {
  if (CFG.buildMetadataDir) {
    const metadata = await collectBuildMetadataFromHost(CFG.buildMetadataDir);
    report.phases.push({
      name: 'upstream_gpu_build_run',
      timings: 'configure_ms=cached\nbuild_ms=skipped\nrun_ms=skipped',
      output: `using cached CMake metadata from ${CFG.buildMetadataDir}`,
    });
    report.logs.upstream_run = 'upstream configure/build/run skipped; using cached CMake metadata\n';
    record(
      'upstream GPU target metadata configured',
      'pass',
      `cached_metadata=${CFG.buildMetadataDir} build=skipped run=skipped`,
    );
    return metadata;
  }

  const buildPath = `${CFG.workerRepoPath}/${CFG.buildSubdir}/build`;
  const shell = [
    'set -e',
    `rm -rf ${shQuote(CFG.workerTempDir)}`,
    `mkdir -p ${shQuote(CFG.workerTempDir)}`,
  ].join('; ');
  await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', shell], 30000, true);
  await execText('docker', ['cp', CFG.repoPath, `${CFG.workerContainer}:${CFG.workerRepoPath}`], 180000, true);

  const command = `
set -e
cd ${shQuote(`${CFG.workerRepoPath}/${CFG.buildSubdir}`)}
rm -rf build
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=/opt/rocm -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)} > ${shQuote(`${CFG.workerTempDir}/configure.log`)} 2>&1
configured=$(date +%s%3N)
if [ ${CFG.buildUpstream ? '1' : '0'} -eq 1 ]; then
  cmake --build build -j2 --target ${shQuote(CFG.targetName)} > ${shQuote(`${CFG.workerTempDir}/build.log`)} 2>&1
else
  : > ${shQuote(`${CFG.workerTempDir}/build.log`)}
fi
built=$(date +%s%3N)
if [ ${CFG.runUpstream ? '1' : '0'} -eq 1 ]; then
  if [ -n ${shQuote(CFG.upstreamRunCommand)} ]; then
    ${CFG.upstreamRunCommand} > ${shQuote(`${CFG.workerTempDir}/run.log`)} 2>&1
  else
    ./build/${shQuote(CFG.targetName)} > ${shQuote(`${CFG.workerTempDir}/run.log`)} 2>&1
  fi
else
  printf 'upstream run skipped by SYNTHI_REAL_ROCM_RUN_UPSTREAM=0\\n' > ${shQuote(`${CFG.workerTempDir}/run.log`)}
fi
ran=$(date +%s%3N)
printf 'configure_ms=%s\\nbuild_ms=%s\\nrun_ms=%s\\n' "$((configured-start))" "$((built-configured))" "$((ran-built))"
`;
  const timings = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', command], 240000, true);
  const runLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/run.log`)}`], 30000, true);
  report.logs.upstream_run = runLog;
  const phase = { name: 'upstream_gpu_build_run', timings, output: runLog.slice(0, 1000) };
  report.phases.push(phase);
  record(
    'upstream GPU target metadata configured',
    'pass',
    `${timings.replace(/\s+/g, ' ')} build=${CFG.buildUpstream ? 'on' : 'skipped'} run=${CFG.runUpstream ? 'on' : 'skipped'}`,
  );

  return collectBuildMetadataFromWorker(buildPath);
}

async function collectBuildMetadataFromHost(metadataDir) {
  const compileHostPath = path.join(metadataDir, 'compile_commands.json');
  const replyHostPath = path.join(metadataDir, 'reply');
  if (!existsSync(compileHostPath)) {
    throw new Error(`cached CMake metadata missing compile_commands.json: ${compileHostPath}`);
  }
  if (!existsSync(replyHostPath)) {
    throw new Error(`cached CMake metadata missing reply directory: ${replyHostPath}`);
  }

  const compileCommandsJson = normalizeCompileCommands(await readFile(compileHostPath, 'utf8'));
  const replyFiles = [];
  const projectionHints = {
    target_source_paths: new Set(),
    target_include_dirs: new Set(),
    matched_target_files: [],
  };
  for (const name of (await readdir(replyHostPath)).sort()) {
    if (!name.endsWith('.json')) continue;
    const content = normalizeBuildMetadataText(await readFile(path.join(replyHostPath, name), 'utf8'));
    replyFiles.push({ path: `.cmake/api/v1/reply/${name}`, content });
    collectProjectionHintsFromCmakeReply(name, content, projectionHints);
  }
  if (!replyFiles.length) {
    throw new Error(`cached CMake metadata reply directory did not contain JSON metadata: ${replyHostPath}`);
  }
  return {
    compileCommandsJson,
    cmakeReplyFiles: replyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
    matchedTargetFiles: projectionHints.matched_target_files.sort(),
  };
}

async function collectBuildMetadataFromWorker(buildPath) {
  const metadataDir = await mkdtemp(path.join(path.resolve(REPO_ROOT, 'tmp'), 'real-rocm-build-metadata-'));
  const compileHostPath = path.join(metadataDir, 'compile_commands.json');
  const replyHostPath = path.join(metadataDir, 'reply');
  await execText(
    'docker',
    ['cp', `${CFG.workerContainer}:${buildPath}/compile_commands.json`, compileHostPath],
    30000,
    true,
  );
  await execText(
    'docker',
    ['cp', `${CFG.workerContainer}:${buildPath}/.cmake/api/v1/reply`, replyHostPath],
    30000,
    true,
  );

  const compileCommandsJson = normalizeCompileCommands(await readFile(compileHostPath, 'utf8'));
  const replyFiles = [];
  const projectionHints = {
    target_source_paths: new Set(),
    target_include_dirs: new Set(),
    matched_target_files: [],
  };
  for (const name of (await readdir(replyHostPath)).sort()) {
    if (!name.endsWith('.json')) continue;
    const content = normalizeBuildMetadataText(await readFile(path.join(replyHostPath, name), 'utf8'));
    replyFiles.push({ path: `.cmake/api/v1/reply/${name}`, content });
    collectProjectionHintsFromCmakeReply(name, content, projectionHints);
  }
  if (!replyFiles.length) {
    throw new Error('CMake File API reply directory did not contain JSON metadata');
  }
  return {
    compileCommandsJson,
    cmakeReplyFiles: replyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
    matchedTargetFiles: projectionHints.matched_target_files.sort(),
  };
}

function collectProjectionHintsFromCmakeReply(name, content, projectionHints) {
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    return;
  }
  if (json?.kind !== 'target' && !name.startsWith(`target-${CFG.targetName}-`)) return;
  if (json?.name !== CFG.targetName) return;
  if (CFG.cmakeTargetType && json?.type && json.type !== CFG.cmakeTargetType) return;

  projectionHints.matched_target_files.push(name);
  for (const source of json.sources ?? []) {
    const rel = repoRelativePath(source?.path);
    if (rel) projectionHints.target_source_paths.add(rel);
  }
  for (const group of json.compileGroups ?? []) {
    for (const include of group.includes ?? []) {
      const rel = repoRelativePath(include?.path);
      if (rel) projectionHints.target_include_dirs.add(rel);
    }
  }
}

function repoRelativePath(rawPath) {
  if (!rawPath) return null;
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  let value = String(rawPath)
    .replace(/\\/g, '/')
    .replaceAll(workerRoot, workspaceRoot);
  if (value === workspaceRoot || value === `${workspaceRoot}/.`) return null;
  if (value.startsWith(`${workspaceRoot}/`)) value = value.slice(workspaceRoot.length + 1);
  if (path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized;
}

function normalizeBuildMetadataText(raw) {
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/');
  return String(raw).replaceAll(workerRoot, workspaceRoot);
}

function normalizeCompileCommands(raw) {
  const entries = JSON.parse(raw);
  const sourceSuffix = `/${CFG.entryFile.replace(/\\/g, '/')}`;
  const selected = entries.find((entry) => String(entry.file || '').replace(/\\/g, '/').endsWith(sourceSuffix));
  if (!selected) throw new Error(`compile_commands.json did not include ${CFG.entryFile}`);
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/');
  const normalized = entries.map((entry) => {
    const updated = {
      ...entry,
      directory: String(entry.directory || '').replace(workerRoot, workspaceRoot),
      file: String(entry.file || '').replace(workerRoot, workspaceRoot),
    };
    if (updated.command) updated.command = String(updated.command).replaceAll(workerRoot, workspaceRoot);
    if (Array.isArray(updated.arguments)) {
      updated.arguments = updated.arguments.map((arg) => String(arg).replaceAll(workerRoot, workspaceRoot));
    }
    return updated;
  });
  return JSON.stringify(normalized, null, 2) + '\n';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function collectRepoFiles(buildMetadata) {
  const rels = await listTrackedFiles();
  const files = [];
  const skipped = [];
  for (const rel of rels) {
    const full = path.join(CFG.repoPath, rel);
    const st = await stat(full);
    if (!st.isFile()) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'not_regular_file' });
      continue;
    }
    if (st.size > CFG.maxFileBytes) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'too_large', bytes: st.size });
      continue;
    }
    const buf = await readFile(full);
    if (buf.includes(0)) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'binary' });
      continue;
    }
    files.push({ path: rel.replace(/\\/g, '/'), content: buf.toString('utf8') });
  }

  files.push({ path: 'compile_commands.json', content: buildMetadata.compileCommandsJson });
  for (const reply of buildMetadata.cmakeReplyFiles) {
    files.push(reply);
  }

  report.seeded_file_count = files.length;
  report.skipped_file_count = skipped.length;
  report.skipped_files = skipped.slice(0, 50);
  record('collected real repo text files', 'pass', `seeded=${files.length} skipped=${skipped.length}`);
  return files;
}

function pathIsWithinDir(filePath, dirPath) {
  const cleanDir = String(dirPath ?? '').replace(/\/+$/, '');
  return cleanDir && (filePath === cleanDir || filePath.startsWith(`${cleanDir}/`));
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function buildCompileProjection(files, focusPath, buildMetadata, phaseName) {
  const normalizedFocus = String(focusPath ?? '').replace(/\\/g, '/');
  const targetSources = new Set(buildMetadata.targetSourcePaths ?? []);
  const includeDirs = (buildMetadata.targetIncludeDirs ?? [])
    .filter((dir) => dir && dir !== '.')
    .sort((a, b) => b.length - a.length);
  const candidates = [];

  for (const file of files) {
    if (file.path === normalizedFocus) continue;
    const isMetadata = file.path === 'compile_commands.json' || file.path.startsWith('.cmake/api/v1/reply/');
    const isTargetSource = targetSources.has(file.path);
    const includeDir = includeDirs.find((dir) => pathIsWithinDir(file.path, dir));
    if (!isMetadata && !isTargetSource && !includeDir) continue;
    const priority = isMetadata ? 0 : isTargetSource ? 1 : 2;
    candidates.push({
      file,
      priority,
      reason: isMetadata ? 'build_metadata' : isTargetSource ? 'target_source' : `include_dir:${includeDir}`,
      bytes: byteLength(file.content),
    });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.file.path.localeCompare(b.file.path));

  const selected = [];
  const omitted = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (totalBytes + candidate.bytes > CFG.compileContextMaxBytes && candidate.priority > 1) {
      omitted.push(candidate);
      continue;
    }
    selected.push({ name: candidate.file.path, content: candidate.file.content });
    totalBytes += candidate.bytes;
  }

  const summary = {
    phase: phaseName,
    selected_files: selected.length,
    selected_bytes: totalBytes,
    omitted_files: omitted.length,
    omitted_bytes: omitted.reduce((sum, item) => sum + item.bytes, 0),
    target_source_paths: targetSources.size,
    target_include_dirs: includeDirs.length,
    matched_target_files: buildMetadata.matchedTargetFiles ?? [],
    max_bytes: CFG.compileContextMaxBytes,
  };
  report.compile_projection[phaseName] = summary;
  record(
    'compile projection',
    'pass',
    `${phaseName} selected=${summary.selected_files} bytes=${summary.selected_bytes} omitted=${summary.omitted_files}`,
  );
  return selected;
}

async function createWorkspace() {
  const workspace = await createValidationWorkspace({
    frontendUrl: CFG.frontendUrl,
    name: CFG.workspaceName,
    slug: CFG.slug,
    httpJson,
    record,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);
}

async function writeFilesBatch(files) {
  for (let i = 0; i < files.length; i += CFG.writeBatchSize) {
    const chunk = files.slice(i, i + CFG.writeBatchSize);
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      {
        files: chunk.map((file) => ({ path: file.path, encoding: 'utf8', content: file.content })),
        syncToGcs: CFG.syncToGcs,
      },
      { 'x-user-id': CFG.hostId },
    );
    record('seed workspace batch', 'pass', `${Math.min(i + chunk.length, files.length)}/${files.length}`);
  }
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/stage-all`, {}, { 'x-user-id': CFG.hostId });
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/commit`, { message: CFG.seedCommitMessage }, { 'x-user-id': CFG.hostId });
  record('workspace commit seed', 'pass', `${files.length} files`);
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[mcp] ${text}`);
    });
    proc.on('exit', (code, sig) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP exited ${code ?? sig}`));
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr=${this.stderrTail.slice(-8).join('').slice(-2000)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content.find((block) => block?.type === 'text')?.text;
    if (res.isError) throw new Error(`tool ${name} isError: ${text ?? JSON.stringify(res)}`);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async toolCallRaw(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }
}

let mcpState = null;
async function ensureMcpAttached() {
  if (!mcpState) {
    let proc;
    if (CFG.mcpTransport === 'docker') {
      proc = spawn('docker', [
        'exec',
        '-i',
        '-e', `SYNTHI_SESSION_ID=${CFG.slug}`,
        '-e', `SYNTHI_SIGNALING_URL=${CFG.mcpSignalingUrl}`,
        '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
        '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
        '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
        CFG.mcpContainer,
        'node',
        '/app/dist/index.js',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      proc = spawn('node', [CFG.mcpEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SYNTHI_SESSION_ID: CFG.slug, SYNTHI_SIGNALING_URL: CFG.signalingUrl },
      });
    }
    const client = new McpClient(proc);
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: CFG.mcpClientName, version: '0.0.1' } }, 20000);
    await client.request('notifications/initialized', {}, 5000).catch(() => {});
    const tools = await client.request('tools/list', {}, 20000);
    const names = tools.tools?.map((tool) => tool.name) ?? [];
    record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') ? 'pass' : 'fail', `count=${names.length}`);
    mcpState = { proc, client, attached: false };
  }
  if (!mcpState.attached) {
    const attach = await mcpState.client.toolCall('synthi_attach', { sessionId: CFG.slug, 'i-understand-no-auth': true }, CFG.mcpAttachTimeoutMs);
    if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
    mcpState.attached = true;
    record('mcp attach', 'pass', attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached');
  }
  return mcpState;
}

async function compileViaMcp(args, timeoutMs, phaseName) {
  const state = await ensureMcpAttached();
  const start = Date.now();
  const compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  if (!compile?.ok) throw new Error(`${phaseName} synthi_compile failed: ${JSON.stringify(compile).slice(0, 1000)}`);
  const waitStart = Date.now();
  const wait = await waitHmrForCurrentWorkspace(state, timeoutMs, phaseName);
  const phase = {
    name: phaseName,
    compile_wall_ms: Date.now() - start,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? null,
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    gpu_proof: wait?.gpu_proof ?? null,
    gpu_proof_validation: wait?.gpu_proof_validation ?? null,
    wait_call_wall_ms: Date.now() - waitStart,
  };
  report.phases.push(phase);
  record(
    phaseName,
    wait?.status === 'applied' ? 'pass' : 'fail',
    `${summarizeGpuProof(phase.gpu_proof)} ${JSON.stringify(phase).slice(0, 1000)}`,
  );
  if (wait?.status !== 'applied') throw new Error(`${phaseName} wait_hmr status=${wait?.status}`);
  return { compile, wait, phase };
}

async function waitHmrForCurrentWorkspace(state, timeoutMs, phaseName) {
  const startedAt = Date.now();
  const eventLogSinceTs = startedAt - 2000;
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const sliceTimeoutMs = Math.min(remaining, 30000);
    let wait;
    try {
      const waitArgs = { timeoutMs: sliceTimeoutMs };
      if (CFG.hmrWaitModule) waitArgs.module = CFG.hmrWaitModule;
      wait = await state.client.toolCall(
        'synthi_wait_hmr',
        waitArgs,
        sliceTimeoutMs + 7000,
      );
    } catch (err) {
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt);
      if (recovered) return recovered;
      throw err;
    }
    last = wait;
    const previewId = hmrPreviewId(wait?.detail);
    if (previewId && previewId !== CFG.slug) {
      record(`${phaseName} ignored stale wait_hmr`, 'warn', `preview_id=${previewId} status=${wait?.status ?? 'unknown'}`);
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt);
      if (recovered) return recovered;
      continue;
    }
    if (wait?.status === 'timeout') {
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt);
      if (recovered) return recovered;
      continue;
    }
    return wait;
  }
  const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt);
  if (recovered) return recovered;
  return last ?? { status: 'timeout', elapsedMs: timeoutMs, source: 'real_rocm_validation_harness' };
}

function hmrPreviewId(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (typeof detail.preview_id === 'string') return detail.preview_id;
  if (detail.data && typeof detail.data === 'object' && typeof detail.data.preview_id === 'string') {
    return detail.data.preview_id;
  }
  if (detail.detail && typeof detail.detail === 'object' && typeof detail.detail.preview_id === 'string') {
    return detail.detail.preview_id;
  }
  return null;
}

function hmrStatusFromEvent(entry) {
  const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
  if (entry?.status && entry.status !== 'intermediate') return entry.status;
  if (typeof raw.status === 'string') {
    if (raw.status === 'state-migrated') return 'applied';
    return raw.status;
  }
  if (raw.event === 'Promoted') return 'applied';
  if (raw.event === 'RolledBack') return 'rejected';
  if (raw.event === 'Discarded') return 'discarded';
  return null;
}

async function currentHmrFromEventLog(state, sinceTs, startedAt) {
  const log = await state.client.toolCall(
    'synthi_get_event_log',
    { kind: 'hmr', since_ts: sinceTs, limit: 200 },
    10000,
  ).catch(() => null);
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  for (const entry of entries.slice().reverse()) {
    const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
    const previewId = hmrPreviewId(raw);
    if (previewId !== CFG.slug) continue;
    const status = hmrStatusFromEvent(entry);
    if (!['applied', 'rejected', 'compile-error', 'full-reload-required', 'discarded'].includes(status)) {
      continue;
    }
    return {
      status,
      elapsedMs: Date.now() - startedAt,
      hmrElapsedMs: typeof entry.ts === 'number' ? entry.ts - startedAt : null,
      source: 'event_log',
      detail: raw.data && typeof raw.data === 'object' ? raw.data : raw,
      frame_gate: {
        status: 'event_log_recovered',
        note: 'terminal HMR event was recovered after ignoring a stale wait_hmr event',
      },
    };
  }
  return null;
}

async function captureScreenshot(label) {
  if (!mcpState?.client) return null;
  const attempts = Math.max(1, CFG.screenshotAttempts);
  let lastRow = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const shot = await mcpState.client.toolCallRaw('synthi_screenshot', { freshness_max_ms: CFG.screenshotFreshnessMaxMs }, 30000).catch((e) => ({ error: e.message }));
    const content = Array.isArray(shot?.content) ? shot.content : [];
    const imageBlock = content.find((block) => block?.type === 'image' && typeof block.data === 'string');
    if (imageBlock?.data) {
      const suffix = attempt === 1 ? '' : `-attempt-${attempt}`;
      const outPath = path.join(ARTIFACT_DIR, `${CFG.slug}-${label}${suffix}.png`);
      const bytes = Buffer.from(imageBlock.data, 'base64');
      await writeFile(outPath, bytes);
      const stats = await analyzeImage(bytes);
      const row = { label, path: outPath, width: stats.width, height: stats.height, visible_pixels: stats.visible_pixels, mean_luma: stats.mean_luma, bytes: bytes.length, attempt };
      report.screenshots.push(row);
      const ok = row.width >= 320 && row.height >= 240 && row.visible_pixels > 500;
      if (ok) {
        record(`screenshot ${label}`, 'pass', JSON.stringify(row));
        return row;
      }
      lastRow = row;
      const status = CFG.expectScreenshot ? 'warn' : 'info';
      record(`screenshot ${label} retry`, status, `attempt=${attempt}/${attempts} ${JSON.stringify(row)}`);
      if (attempt < attempts) {
        await sleep(CFG.screenshotRetryDelayMs);
      }
      continue;
    }
    const text = content.find((block) => block?.type === 'text')?.text;
    const detail = shot?.error ?? text ?? (shot?.isError ? JSON.stringify(shot?.structuredContent ?? shot) : 'no data');
    record(`screenshot ${label}`, 'warn', `attempt=${attempt} ${detail}`);
    await sleep(CFG.screenshotRetryDelayMs);
  }
  if (!CFG.expectScreenshot) {
    const detail = lastRow
      ? `visual_proof_unavailable not_visibly_non_black ${JSON.stringify(lastRow)}`
      : 'visual_proof_unavailable no_frame_captured screenshot_optional';
    record(`screenshot ${label}`, 'warn', detail);
    return lastRow;
  }
  const detail = lastRow ? JSON.stringify(lastRow) : 'no frame was captured';
  record(`screenshot ${label}`, 'fail', detail);
  throw new Error(`screenshot ${label} was expected but was not visibly non-black`);
}

async function analyzeImage(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  let lumaTotal = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaTotal += luma;
    if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) visible += 1;
  }
  const pixels = Math.max(1, info.width * info.height);
  return { width: info.width, height: info.height, visible_pixels: visible, mean_luma: lumaTotal / pixels };
}

function editSource(source, before, after, label) {
  if (!before || before === after) throw new Error(`${label} source delta must be non-empty and change the source`);
  if (!source.includes(before)) throw new Error(`${label} source delta did not match the selected file`);
  return source.replace(before, after);
}

function editConfiguredSource(source) {
  return editSource(source, CFG.deltaBefore, CFG.deltaAfter, 'configured');
}

function safePhaseLabel(label, index) {
  return cleanIdentifier(label || `extra-${index + 1}`).replace(/\./g, '-');
}

function parseExtraDeltas() {
  const deltas = [];
  if (CFG.secondDeltaBefore || CFG.secondDeltaAfter) {
    if (!CFG.secondDeltaBefore || !CFG.secondDeltaAfter) {
      throw new Error('second source delta requires both SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE and SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER');
    }
    deltas.push({
      label: 'second',
      file: CFG.secondDeltaFile,
      before: CFG.secondDeltaBefore,
      after: CFG.secondDeltaAfter,
    });
  }
  if (!CFG.extraDeltasJson.trim()) return deltas;

  let parsed;
  try {
    parsed = JSON.parse(CFG.extraDeltasJson);
  } catch (err) {
    throw new Error(`SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON must be a JSON array');
  }
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`extra delta ${index + 1} must be an object`);
    }
    const file = String(entry.file ?? entry.path ?? CFG.deltaFile).replace(/\\/g, '/');
    const before = typeof entry.before === 'string' ? entry.before : '';
    const after = typeof entry.after === 'string' ? entry.after : '';
    if (!file || !before || !after || before === after) {
      throw new Error(`extra delta ${index + 1} requires file/path, before, and after strings that change the source`);
    }
    deltas.push({
      label: safePhaseLabel(entry.label, index),
      file,
      before,
      after,
    });
  });
  return deltas;
}

function evidenceLines(text, pattern) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => pattern.test(line))
    .slice(-300);
}

function countMatches(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length;
}

function scopeLogTextToSession(text, slug) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (!slug) {
    return {
      text: lines.join('\n'),
      marker_found: false,
      dropped_before: 0,
      total_lines: lines.length,
    };
  }
  const markerIndex = lines.findIndex((line) => line.includes(slug));
  if (markerIndex < 0) {
    return {
      text: '',
      marker_found: false,
      dropped_before: lines.length,
      total_lines: lines.length,
    };
  }
  return {
    text: lines.slice(markerIndex).join('\n'),
    marker_found: true,
    dropped_before: markerIndex,
    total_lines: lines.length,
  };
}

function runtimeDispatchEvidence(workerEvidence) {
  const dispatchFailureLines = workerEvidence.filter((line) =>
    /\bsynthi_gpu_launch\b.*\bdispatch=(failed|stale-pointer|missing-dispatcher)\b/i.test(line)
  );
  const dispatchSuccessLines = workerEvidence.filter((line) =>
    /\bsynthi_gpu_launch\b.*\bdispatch=ok\b/i.test(line)
  );
  const dispatchSuccessCount = countMatches(
    workerEvidence,
    /\bsynthi_gpu_launch\b.*\bdispatch=ok\b/i,
  );
  return {
    success_count: dispatchSuccessCount,
    success_lines: dispatchSuccessLines.slice(-20),
    failure_count: dispatchFailureLines.length,
    failure_lines: dispatchFailureLines.slice(0, 20),
  };
}

function runtimeArgProvenanceEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) =>
    /\blaunch_arg_provenance\b/i.test(line)
  );
  const completeLines = lines.filter((line) => /\bcomplete=true\b/i.test(line));
  const incompleteLines = lines.filter((line) => /\bcomplete=false\b/i.test(line));
  const unknownCount = lines.reduce((total, line) => {
    const match = line.match(/\bunknown_args=(\d+)/i);
    return total + (match ? Number.parseInt(match[1], 10) || 0 : 0);
  }, 0);
  return {
    total_count: lines.length,
    complete_count: completeLines.length,
    incomplete_count: incompleteLines.length,
    unknown_arg_count: unknownCount,
    complete_lines: completeLines.slice(-20),
    incomplete_lines: incompleteLines.slice(-20),
  };
}

function summarizeGpuProof(proof) {
  if (!proof?.resultState) return 'gpu_proof=missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const label = proof.label ? ` label=${proof.label}` : '';
  const proofId = proof.proofId ? ` proof_id=${proof.proofId}` : '';
  const proofPath = proof.proofArtifactPath ? ` proof_path=${proof.proofArtifactPath}` : '';
  return `gpu_proof=${proof.resultState}${degraded}${label}${reason}${proofId}${proofPath}`;
}

function selfCheckRuntimeDispatchEvidence() {
  const evidence = runtimeDispatchEvidence([
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=first grid=(1, 1, 1) dispatch=ok',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=second grid=(1, 1, 1) dispatch=failed',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=third grid=(1, 1, 1) dispatch=stale-pointer',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=fourth grid=(1, 1, 1) dispatch=missing-dispatcher',
    '[gpu-runtime-boundary] unrelated launch line dispatch=failed',
  ]);
  if (evidence.success_count !== 1) {
    throw new Error(`expected one dispatch success, got ${evidence.success_count}`);
  }
  if (evidence.failure_count !== 3) {
    throw new Error(`expected three dispatch failures, got ${evidence.failure_count}`);
  }
  if (evidence.failure_lines.some((line) => !/\bsynthi_gpu_launch\b/.test(line))) {
    throw new Error('dispatch failure evidence included a non-launch line');
  }
  const scoped = scopeLogTextToSession(
    [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale grid=(1, 1, 1) dispatch=ok',
      '[Runner] Session ID from env: target-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok',
    ].join('\n'),
    'target-session',
  );
  const scopedEvidence = runtimeDispatchEvidence(evidenceLines(scoped.text, /gpu-runtime-boundary/i));
  if (scopedEvidence.success_count !== 1 || !scopedEvidence.success_lines[0]?.includes('kernel=current')) {
    throw new Error('session-scoped dispatch evidence included stale dispatch lines');
  }
  const provenance = runtimeArgProvenanceEvidence([
    '[gpu-runtime-boundary] launch_arg_provenance kernel=current generation=2 complete=false known_args=1 unknown_args=2 degradedState=gpu-hmr-unknown-arg-provenance details=0:device-allocation:x:size=8',
    '[gpu-runtime-boundary] launch_arg_provenance kernel=known generation=2 complete=true known_args=2 unknown_args=0 degradedState=none details=0:device-allocation:x:size=8',
  ]);
  if (provenance.total_count !== 2 || provenance.incomplete_count !== 1 || provenance.unknown_arg_count !== 2) {
    throw new Error('runtime arg provenance evidence parser failed');
  }
  const visualOnlyProof = classifyGpuHmrOutputProof({
    dispatchObserved: true,
    visualFrameObserved: true,
  });
  const outputMissingProof = classifyGpuHmrOutputProof({
    dispatchObserved: true,
    visualFrameObserved: false,
  });
  if (
    visualOnlyProof.degradedState !== 'gpu-hmr-visual-only'
    || outputMissingProof.degradedState !== 'gpu-hmr-output-unobserved'
  ) {
    throw new Error('runtime output proof classifier failed');
  }
  console.log('runtime dispatch evidence self-check passed');
}

async function collectRuntimeEvidence() {
  if (CFG.mcpTransport !== 'docker') return;
  report.docker = {
    mcp: await dockerContainerSnapshot(CFG.mcpContainer),
    worker: await dockerContainerSnapshot(CFG.workerContainer),
    ai_engine: await dockerContainerSnapshot(CFG.aiEngineContainer),
  };
  const workerLogs = await execText(
    'docker',
    ['logs', '--timestamps', '--since', report.started_at, CFG.workerContainer],
    120000,
    false,
  );
  const aiLogs = await execText(
    'docker',
    ['logs', '--timestamps', '--since', report.started_at, CFG.aiEngineContainer],
    120000,
    false,
  );
  const scopedWorkerLogs = scopeLogTextToSession(workerLogs, CFG.slug);
  const workerEvidence = evidenceLines(
    scopedWorkerLogs.text,
    /GPU AI Delta|device_only fast path|natural fallback|HMR Planner|reload_policy|HMR MODE|Restarting runner|gpu-reload|compile-device|Device sidecar|gpu-runtime-boundary|synthi_gpu_launch|gpu_runtime_error|gpu-hmr-rejected|Runner process exited|fatal|Rust cannot catch/i,
  );
  const unscopedWorkerEvidence = evidenceLines(
    workerLogs,
    /GPU AI Delta|device_only fast path|natural fallback|HMR Planner|reload_policy|HMR MODE|Restarting runner|gpu-reload|compile-device|Device sidecar|gpu-runtime-boundary|synthi_gpu_launch|gpu_runtime_error|gpu-hmr-rejected|Runner process exited|fatal|Rust cannot catch/i,
  );
  const aiEvidence = evidenceLines(
    aiLogs,
    /Calling API|mode=delta|mode=split|verifier rejected|POST \/refactor\/(?:split\/gpu|diff_patch(?:\/gpu)?|heal)/i,
  );
  const genericDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch(?!\/gpu)/i);
  const gpuDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch\/gpu/i);
  const compileHealCalls = countMatches(aiEvidence, /POST \/refactor\/heal/i);
  const runtimeDispatch = runtimeDispatchEvidence(workerEvidence);
  const runtimeArgProvenance = runtimeArgProvenanceEvidence(workerEvidence);
  report.evidence = {
    worker_log_lines: workerEvidence,
    worker_log_lines_unscoped_tail: unscopedWorkerEvidence.slice(-50),
    worker_session_scope: {
      slug: CFG.slug,
      marker_found: scopedWorkerLogs.marker_found,
      dropped_before: scopedWorkerLogs.dropped_before,
      total_lines: scopedWorkerLogs.total_lines,
    },
    ai_engine_log_lines: aiEvidence,
    ai_call_counts: {
      split: countMatches(aiEvidence, /mode=split/i),
      generic_delta: genericDeltaCalls,
      gpu_delta: gpuDeltaCalls,
      total_delta: genericDeltaCalls + gpuDeltaCalls,
      compile_heal: compileHealCalls,
      model_delta_mode: countMatches(aiEvidence, /mode=delta/i),
    },
    runner_policy_counts: {
      existing_reload_blocked: countMatches(workerEvidence, /reload_policy_allow_existing=false/i),
      runner_restarts: countMatches(workerEvidence, /Restarting runner/i),
      runner_exit_errors: countMatches(workerEvidence, /Runner process exited|Rust cannot catch|fatal runtime/i),
    },
    runtime_dispatch: runtimeDispatch,
    runtime_arg_provenance: runtimeArgProvenance,
  };
  if (runtimeDispatch.failure_count > 0) {
    record(
      'runtime dispatch failures',
      'fail',
      runtimeDispatch.failure_lines.slice(0, 3).join(' | ').slice(0, 1200),
    );
    process.exitCode = 1;
  } else if (runtimeDispatch.success_count > 0 && scopedWorkerLogs.marker_found) {
    record('runtime dispatch successes', 'pass', `dispatch_ok=${runtimeDispatch.success_count}`);
  } else if (!scopedWorkerLogs.marker_found) {
    record('runtime dispatch evidence', 'warn', `no worker log session marker captured for slug=${CFG.slug}`);
  } else {
    record('runtime dispatch evidence', 'warn', 'no synthi_gpu_launch dispatch lines captured');
  }
  if (runtimeArgProvenance.total_count > 0) {
    const status = runtimeArgProvenance.incomplete_count > 0 ? 'warn' : 'pass';
    record(
      'runtime argument provenance',
      status,
      `records=${runtimeArgProvenance.total_count} complete=${runtimeArgProvenance.complete_count} incomplete=${runtimeArgProvenance.incomplete_count} unknown_args=${runtimeArgProvenance.unknown_arg_count}`,
    );
  } else {
    record('runtime argument provenance', 'warn', 'no launch_arg_provenance lines captured');
  }
  const freshVisualFrames = report.screenshots.filter(
    (shot) => shot && shot.width >= 320 && shot.height >= 240 && shot.visible_pixels > 500,
  );
  report.output_proof = classifyGpuHmrOutputProof({
    dispatchObserved: runtimeDispatch.success_count > 0 && scopedWorkerLogs.marker_found,
    visualFrameObserved: freshVisualFrames.length > 0,
    visualEvidenceRefs: freshVisualFrames.map((shot) => shot.path),
  });
  record(
    'runtime output proof',
    report.output_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrOutputProof(report.output_proof),
  );
  record(
    'runtime evidence collected',
    'pass',
    `ai_split=${report.evidence.ai_call_counts.split} ai_delta=${report.evidence.ai_call_counts.total_delta} ai_gpu_delta=${report.evidence.ai_call_counts.gpu_delta} ai_compile_heal=${report.evidence.ai_call_counts.compile_heal} restart_policy_blocks=${report.evidence.runner_policy_counts.existing_reload_blocked}`,
  );
}

async function dockerContainerSnapshot(containerName) {
  const raw = await execText(
    'docker',
    [
      'inspect',
      containerName,
      '--format',
      '{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}',
    ],
    30000,
    false,
  );
  if (!raw) return { container: containerName, available: false };
  const [name, config_image, image_id, status] = raw.split('|');
  return {
    container: containerName,
    name: name?.replace(/^\//, '') ?? containerName,
    config_image,
    image_id,
    status,
  };
}

async function writeResults() {
  report.finished_at = new Date().toISOString();
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(RESULTS_JSON, JSON.stringify(report, null, 2) + '\n');
  const lines = [
    `slug: ${report.slug}`,
    `source_url: ${report.source_url}`,
    `repo_commit: ${report.repo_commit}`,
    `entry_file: ${report.entry_file}`,
    `delta_file: ${report.delta_file}`,
    `second_delta_file: ${report.second_delta_file ?? ''}`,
    `extra_deltas: ${JSON.stringify(report.extra_deltas ?? [])}`,
    `model: ${report.model}`,
    `gpu_vendor: ${report.gpu_vendor}`,
    `gpu_arch: ${report.gpu_arch}`,
    `containers: ${JSON.stringify(report.containers)}`,
    `docker: ${JSON.stringify(report.docker)}`,
    `command: ${JSON.stringify(report.command)}`,
    `file_count: ${report.file_count}`,
    `seeded_file_count: ${report.seeded_file_count}`,
    `skipped_file_count: ${report.skipped_file_count}`,
    `compile_projection: ${JSON.stringify(report.compile_projection)}`,
    '',
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`),
    '',
    ...report.phases.map((phase) => `PHASE ${phase.name} ${JSON.stringify(phase)}`),
    '',
    ...report.phases.map((phase) => `GPU_PROOF ${phase.name} ${summarizeGpuProof(phase.gpu_proof)}`),
    '',
    ...report.screenshots.map((shot) => `SCREENSHOT ${shot.label} visible=${shot.visible_pixels} luma=${shot.mean_luma.toFixed(1)} path=${shot.path}`),
    '',
    `OUTPUT_PROOF ${summarizeGpuHmrOutputProof(report.output_proof)}`,
    '',
    `EVIDENCE ${JSON.stringify(report.evidence)}`,
  ];
  await writeFile(RESULTS_TXT, lines.join('\n') + '\n');
  console.log(`results: ${RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await ensureRepo();
  const buildMetadata = await prepareUpstreamBuild();
  const files = await collectRepoFiles(buildMetadata);
  const fileContentByPath = new Map(files.map((file) => [file.path, file.content]));
  const updateFileContent = (filePath, content) => {
    const normalized = String(filePath ?? '').replace(/\\/g, '/');
    fileContentByPath.set(normalized, content);
    const file = files.find((candidate) => candidate.path === normalized);
    if (file) file.content = content;
  };
  const contentForPath = (filePath) => {
    const normalized = String(filePath ?? '').replace(/\\/g, '/');
    if (!fileContentByPath.has(normalized)) {
      throw new Error(`delta file missing from seeded files: ${normalized}`);
    }
    return fileContentByPath.get(normalized);
  };
  const extraDeltas = parseExtraDeltas();
  report.extra_deltas = extraDeltas.map((delta) => ({
    label: delta.label,
    file: delta.file,
    before_sha256: createHash('sha256').update(delta.before).digest('hex'),
    after_sha256: createHash('sha256').update(delta.after).digest('hex'),
  }));
  const primary = files.find((file) => file.path === CFG.entryFile);
  if (!primary) throw new Error(`entry file missing from seeded files: ${CFG.entryFile}`);
  const deltaPrimary = files.find((file) => file.path === CFG.deltaFile);
  if (!deltaPrimary) throw new Error(`delta file missing from seeded files: ${CFG.deltaFile}`);
  const firstAdditionalFiles = buildCompileProjection(
    files,
    CFG.entryFile,
    buildMetadata,
    'first_real_repo_ai_split_compile',
  );

  await createWorkspace();
  await writeFilesBatch(files);

  await compileViaMcp({
    language: 'cpp',
    filename: CFG.entryFile,
    source: primary.content,
    files: firstAdditionalFiles,
    is_gui: CFG.expectScreenshot,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: CFG.gpuMode,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: CFG.width,
    height: CFG.height,
  }, CFG.firstCompileTimeoutMs, 'first_real_repo_ai_split_compile');
  await captureScreenshot('first-compile');

  const edited = editConfiguredSource(contentForPath(CFG.deltaFile));
  const hmrAdditionalFiles = buildCompileProjection(
    files,
    CFG.deltaFile,
    buildMetadata,
    'real_repo_user_source_delta_hmr',
  );
  await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
    { files: [{ path: CFG.deltaFile, encoding: 'utf8', content: edited }], syncToGcs: CFG.syncToGcs },
    { 'x-user-id': CFG.hostId },
  );
  updateFileContent(CFG.deltaFile, edited);
  await compileViaMcp({
    language: 'cpp',
    filename: CFG.deltaFile,
    source: edited,
    files: hmrAdditionalFiles,
    is_gui: CFG.expectScreenshot,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: CFG.gpuMode,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: CFG.width,
    height: CFG.height,
  }, CFG.hmrTimeoutMs, 'real_repo_user_source_delta_hmr');
  await captureScreenshot('post-hmr');

  for (let index = 0; index < extraDeltas.length; index += 1) {
    const delta = extraDeltas[index];
    const label = safePhaseLabel(delta.label, index);
    const phaseName = `real_repo_${label}_user_source_delta_hmr`;
    const screenshotLabel = `post-${label}-hmr`;
    const editedSource = editSource(
      contentForPath(delta.file),
      delta.before,
      delta.after,
      `${label} configured`,
    );
    const additionalFiles = buildCompileProjection(
      files,
      delta.file,
      buildMetadata,
      phaseName,
    );
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      { files: [{ path: delta.file, encoding: 'utf8', content: editedSource }], syncToGcs: CFG.syncToGcs },
      { 'x-user-id': CFG.hostId },
    );
    updateFileContent(delta.file, editedSource);
    await compileViaMcp({
      language: 'cpp',
      filename: delta.file,
      source: editedSource,
      files: additionalFiles,
      is_gui: CFG.expectScreenshot,
      use_ai_split: true,
      user_requested_ai: true,
      prefer_gpu_pipeline: true,
      gpu_mode: CFG.gpuMode,
      gpu_arch: CFG.gpuArch,
      slug: CFG.slug,
      width: CFG.width,
      height: CFG.height,
    }, CFG.hmrTimeoutMs, phaseName);
    await captureScreenshot(screenshotLabel);
  }
}

if (process.argv.includes('--self-check')) {
  try {
    selfCheckRuntimeDispatchEvidence();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
} else {
  run()
    .catch((err) => {
      record('fatal', 'fail', err.stack || err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mcpState?.proc) {
        try { mcpState.proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
      await collectRuntimeEvidence().catch((err) => {
        record('runtime evidence collected', 'warn', err.stack || err.message);
      });
      await writeResults().catch((err) => console.error(err));
    });
}
