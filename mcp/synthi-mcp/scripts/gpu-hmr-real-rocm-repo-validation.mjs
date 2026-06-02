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
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  abiProofFromProofArtifacts,
  artifactTransportProofFromProofArtifacts,
  fissionProofFromProofArtifacts,
  summarizeGpuHmrArtifactTransportProof,
  sourceProofFromProofArtifacts,
  summarizeGpuHmrSourceProof,
} from './lib/gpu-hmr-proof-artifacts.mjs';
import {
  epochSwapProofFromRuntimeEvidence,
  hostPreservationProofFromRuntimeEvidence,
  originalHostPathProofFromRuntimeEvidence,
  runtimeArtifactTransportEvidence,
  runtimeEpochSwapEvidence,
  runtimeHostIdentityEvidence,
  runtimeOutputOracleEvidence,
} from './lib/gpu-hmr-runtime-evidence.mjs';
import { booleanFromEnv, positiveIntegerFromEnv } from './lib/validation-env.mjs';
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrEpochSwapProof,
  summarizeGpuHmrFissionProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOriginalHostPathProof,
  summarizeGpuHmrOutputProof,
} from './lib/gpu-hmr-runtime-proof.mjs';
import {
  writeValidationRuntimeProofArtifact,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';
import {
  buildGpuHmrValidationProofSummary,
} from './lib/gpu-hmr-validation-proof-summary.mjs';
import {
  analyzeGpuHmrImageEvidence,
  screenshotQualifiesAsVisualEvidence,
  visualEvidenceRow,
} from './lib/gpu-hmr-visual-evidence.mjs';
import {
  classifyFreshAiSplitProvenance,
  countAiSplitEvidenceLines,
} from './lib/ai-split-provenance.mjs';
import { validationCommandMetadata } from './lib/docker-validation-metadata.mjs';
import { REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS } from './lib/real-rocm-validation-command-env.mjs';
import {
  buildUpstreamLifecyclePlan,
  buildUpstreamRunLaunchPlan,
  canContinueWithCachedMetadataAfterLifecycleFailure,
} from './lib/real-rocm-upstream-lifecycle.mjs';

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

function parseOutputOracleContract(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid output oracle contract JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid output oracle contract: expected object');
  }
  const contract = {};
  const aliases = {
    oracleId: ['id', 'oracleId', 'oracle_id'],
    requiredOracleId: [
      'requiredOracleId',
      'required_oracle_id',
      'requiredOracle',
      'required_oracle',
      'requiredId',
      'required_id',
    ],
    kind: ['kind'],
    expected: ['expected', 'expectedValue', 'expected_value', 'expectedHash', 'expected_hash'],
    producer: ['producer', 'producerId', 'producer_id', 'producerSubsystem', 'producer_subsystem'],
    outputTargetId: ['outputTargetId', 'output_target_id', 'outputTarget', 'output_target', 'target'],
    artifactId: ['artifactId', 'artifact_id', 'artifact'],
    runtimeSessionId: [
      'runtimeSessionId',
      'runtime_session_id',
      'runtimeSession',
      'runtime_session',
      'sessionId',
      'session_id',
    ],
  };
  for (const [canonical, fields] of Object.entries(aliases)) {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) {
        if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
          throw new Error(`invalid output oracle contract field ${field}: expected non-empty string`);
        }
        contract[canonical] = parsed[field].trim();
        break;
      }
    }
  }
  if (!Object.keys(contract).length) {
    throw new Error(
      'invalid output oracle contract: at least one supported string field is required',
    );
  }
  return contract;
}

function parseStringArrayEnv(raw, name) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${name}: expected JSON string array: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`invalid ${name}: expected JSON string array`);
  }
  return parsed.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`invalid ${name}[${index}]: expected non-empty string`);
    }
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`invalid ${name}[${index}]: control characters are not supported`);
    }
    return value;
  });
}

const configuredRepoUrl = process.env.SYNTHI_REAL_ROCM_REPO_URL ?? DEFAULT_REAL_REPO_URL;
const configuredRepoName = cleanIdentifier(
  process.env.SYNTHI_REAL_ROCM_REPO_NAME ?? repoNameFromUrl(configuredRepoUrl),
);
const configuredWorkspaceRoot =
  process.env.SYNTHI_REAL_ROCM_WORKSPACE_ROOT ?? `/workspace/${configuredRepoName}`;
const configuredWorkerTempDir =
  process.env.SYNTHI_REAL_ROCM_WORKER_TMP ?? '/tmp/synthi-real-rocm';
const configuredExpectScreenshot = booleanFromEnv(
  process.env,
  'SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT',
  false,
);
const configuredRenderPreview = booleanFromEnv(
  process.env,
  'SYNTHI_REAL_ROCM_RENDER_PREVIEW',
  configuredExpectScreenshot,
);

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
  cmakeArgs: parseStringArrayEnv(
    process.env.SYNTHI_REAL_ROCM_CMAKE_ARGS_JSON,
    'SYNTHI_REAL_ROCM_CMAKE_ARGS_JSON',
  ),
  cmakeTargetType: process.env.SYNTHI_REAL_ROCM_TARGET_TYPE ?? 'EXECUTABLE',
  cmakeTargetIdNamespace: process.env.SYNTHI_REAL_ROCM_TARGET_ID_NAMESPACE ?? 'real-rocm',
  buildMetadataDir: process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR
    ? path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR)
    : '',
  gpuMode: process.env.SYNTHI_REAL_ROCM_GPU_MODE ?? 'rocm',
  buildUpstream: process.env.SYNTHI_REAL_ROCM_BUILD_UPSTREAM !== '0',
  runUpstream: process.env.SYNTHI_REAL_ROCM_RUN_UPSTREAM !== '0',
  upstreamRunCommand: process.env.SYNTHI_REAL_ROCM_UPSTREAM_RUN_COMMAND ?? '',
  upstreamDisplayMode: process.env.SYNTHI_REAL_ROCM_UPSTREAM_DISPLAY_MODE ?? 'auto',
  upstreamXdgRuntimeDir: process.env.SYNTHI_REAL_ROCM_UPSTREAM_XDG_RUNTIME_DIR ?? '',
  nativeLaunchObserver: process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER === '1',
  nativeLaunchObserverPath:
    process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER_PATH
    ?? '/usr/local/lib/synthi-gpu-native-launch-observer.so',
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
  compileTransport: (process.env.SYNTHI_REAL_ROCM_COMPILE_TRANSPORT ?? 'inline').toLowerCase(),
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
  upstreamBuildTimeoutMs: positiveIntegerFromEnv(process.env, 'SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS', 240000),
  screenshotAttempts: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_ATTEMPTS ?? 3),
  screenshotRetryDelayMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_RETRY_MS ?? 1000),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_FRESHNESS_MS ?? 5000),
  expectScreenshot: configuredExpectScreenshot,
  renderPreview: configuredRenderPreview,
  requireFreshAiSplit:
    process.env.SYNTHI_VALIDATION_REQUIRE_FRESH_AI_SPLIT === '1'
    || process.env.SYNTHI_REAL_ROCM_REQUIRE_FRESH_AI_SPLIT === '1',
  requireOriginalHostPath: process.env.SYNTHI_REAL_ROCM_REQUIRE_ORIGINAL_HOST_PATH !== '0',
  outputOracleContract: parseOutputOracleContract(
    process.env.SYNTHI_REAL_ROCM_OUTPUT_ORACLE_JSON
      ?? process.env.SYNTHI_GPU_HMR_OUTPUT_ORACLE_JSON
      ?? '',
  ),
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
  cmake_config: CFG.cmakeConfigName,
  cmake_args: CFG.cmakeArgs,
  model: CFG.geminiModel,
  gpu_vendor: CFG.gpuMode,
  gpu_arch: CFG.gpuArch,
  containers: {
    mcp: CFG.mcpContainer,
    worker: CFG.workerContainer,
    ai_engine: CFG.aiEngineContainer,
  },
  command: validationCommandMetadata({ envKeys: REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS }),
  file_count: 0,
  seeded_file_count: 0,
  skipped_file_count: 0,
  checks: [],
  phases: [],
  screenshots: [],
  logs: {},
  docker: {},
  evidence: {},
  runtime_identity: {
    phases: [],
  },
  proof_artifacts: [],
  abi_proof: null,
  fission_proof: null,
  artifact_transport_proof: null,
  epoch_swap_proof: null,
  dispatch_proof: null,
  output_proof: null,
  host_preservation_proof: null,
  original_host_path_proof: null,
  full_runtime_proof: null,
  runtime_proof_artifact: null,
  runtime_proof_artifact_path: null,
  compile_projection: {},
  compile_transport: CFG.compileTransport,
  output_oracle_contract: CFG.outputOracleContract,
  render_preview_enabled: CFG.renderPreview,
  upstream_run_environment: null,
  fresh_ai_split_required: CFG.requireFreshAiSplit,
  original_host_path_required: CFG.requireOriginalHostPath,
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

function execTextAllowPartialOutput(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
    });
  });
}

function shouldFetchRequestedCommit({ requestedCommit, localCommitAvailable }) {
  return Boolean(String(requestedCommit ?? '').trim()) && !localCommitAvailable;
}

async function gitCommitExists(repoPath, commit) {
  if (!String(commit ?? '').trim()) return false;
  const found = await execText(
    'git',
    ['-C', repoPath, 'cat-file', '-e', `${commit}^{commit}`],
    30000,
    false,
  );
  return found !== undefined;
}

function proofArtifactFileName(proofArtifactPath) {
  const normalized = String(proofArtifactPath ?? '').replaceAll('\\', '/');
  const fileName = path.posix.basename(normalized);
  return /^gpu-proof_[a-f0-9]{32,}\.json$/i.test(fileName) ? fileName : null;
}

async function readWorkerProofArtifact(proofArtifactPath) {
  if (CFG.mcpTransport !== 'docker') {
    return { proofArtifactPath, found: false, reason: 'docker_transport_required' };
  }
  const fileName = proofArtifactFileName(proofArtifactPath);
  if (!fileName) {
    return { proofArtifactPath, found: false, reason: 'invalid_proof_artifact_path' };
  }
  const found = await execTextAllowPartialOutput(
    'docker',
    [
      'exec',
      '-w',
      '/',
      CFG.workerContainer,
      'sh',
      '-c',
      'find / -path "*/.synthi/gpu-hmr/proofs/$1" -type f -print -quit 2>/dev/null',
      'sh',
      fileName,
    ],
    120000,
  );
  const containerPath = String(found ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  if (!containerPath) {
    return { proofArtifactPath, fileName, found: false, reason: 'proof_artifact_not_found' };
  }
  const text = await execText(
    'docker',
    ['exec', '-w', '/', CFG.workerContainer, 'cat', containerPath],
    120000,
    false,
  );
  if (!text) {
    return { proofArtifactPath, fileName, containerPath, found: false, reason: 'proof_artifact_unreadable' };
  }
  try {
    return {
      proofArtifactPath,
      fileName,
      containerPath,
      found: true,
      artifact: JSON.parse(text),
    };
  } catch (err) {
    return {
      proofArtifactPath,
      fileName,
      containerPath,
      found: false,
      reason: 'proof_artifact_invalid_json',
      error: err?.message ?? String(err),
    };
  }
}

async function collectGpuProofArtifacts() {
  const records = [];
  const seen = new Set();
  for (const phase of report.phases) {
    const proofPath = phase?.gpu_proof?.proofArtifactPath;
    if (typeof proofPath !== 'string' || !proofPath.trim() || seen.has(proofPath)) continue;
    seen.add(proofPath);
    const record = await readWorkerProofArtifact(proofPath);
    records.push(record);
    phase.gpu_proof_artifact = record.found
      ? {
          found: true,
          proofId: record.artifact?.proofId ?? null,
          containerPath: record.containerPath,
          evidenceKinds: Array.isArray(record.artifact?.evidenceRefs)
            ? record.artifact.evidenceRefs.map((evidence) => evidence?.kind).filter(Boolean)
            : [],
        }
      : {
          found: false,
          reason: record.reason,
        };
  }
  report.proof_artifacts = records;
  return records;
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
    const localCommitAvailable = await gitCommitExists(CFG.repoPath, CFG.repoCommit);
    if (shouldFetchRequestedCommit({ requestedCommit: CFG.repoCommit, localCommitAvailable })) {
      const fetched = await execText(
        'git',
        ['-C', CFG.repoPath, 'fetch', '--depth', '1', 'origin', CFG.repoCommit],
        300000,
        false,
      );
      if (fetched === undefined) {
        await execText('git', ['-C', CFG.repoPath, 'fetch', 'origin'], 300000, true);
      }
    }
    await execText('git', ['-C', CFG.repoPath, 'checkout', '--detach', CFG.repoCommit], 120000, true);
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

function parseUpstreamRunExitCode(timings) {
  const match = /\brun_exit_code=(\d+)\b/.exec(String(timings ?? ''));
  return match ? Number(match[1]) : null;
}

async function prepareUpstreamBuild() {
  const lifecyclePlan = buildUpstreamLifecyclePlan({
    buildMetadataDir: CFG.buildMetadataDir,
    buildUpstream: CFG.buildUpstream,
    runUpstream: CFG.runUpstream,
  });
  const cachedMetadata = lifecyclePlan.usesCachedMetadata
    ? await collectBuildMetadataFromHost(CFG.buildMetadataDir)
    : null;
  if (!lifecyclePlan.executeLifecycle) {
    report.phases.push({
      name: 'upstream_gpu_build_run',
      timings: 'configure_ms=cached\nbuild_ms=skipped\nrun_ms=skipped',
      output: `using cached CMake metadata from ${CFG.buildMetadataDir}`,
      metadata_source: lifecyclePlan.metadataSource,
      cached_metadata_dir: lifecyclePlan.cachedMetadataDir,
      skip_reason: lifecyclePlan.skipReason,
    });
    report.logs.upstream_run = 'upstream configure/build/run skipped; using cached CMake metadata\n';
    record(
      'upstream GPU target metadata configured',
      'pass',
      `cached_metadata=${CFG.buildMetadataDir} build=skipped run=skipped`,
    );
    return cachedMetadata;
  }

  const buildPath = `${CFG.workerRepoPath}/${CFG.buildSubdir}/build`;
  const shell = [
    'set -e',
    `rm -rf ${shQuote(CFG.workerTempDir)}`,
    `mkdir -p ${shQuote(CFG.workerTempDir)}`,
  ].join('; ');
  await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', shell], 30000, true);
  await execText('docker', ['cp', CFG.repoPath, `${CFG.workerContainer}:${CFG.workerRepoPath}`], 180000, true);
  const xvfbRunAvailable = (await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      'command -v xvfb-run >/dev/null 2>&1 && xvfb-run -a /bin/true >/dev/null 2>&1 && printf 1 || printf 0',
    ],
    30000,
    true,
  )).trim() === '1';
  const upstreamRunLaunch = buildUpstreamRunLaunchPlan({
    runUpstream: CFG.runUpstream,
    displayMode: CFG.upstreamDisplayMode,
    xvfbRunAvailable,
    xdgRuntimeDir: CFG.upstreamXdgRuntimeDir,
    workerTempDir: CFG.workerTempDir,
    width: CFG.width,
    height: CFG.height,
  });
  report.upstream_run_environment = upstreamRunLaunch;
  if (!upstreamRunLaunch.runnable) {
    throw new Error(`upstream run display environment unavailable: ${upstreamRunLaunch.reason}`);
  }

  const cmakeExtraArgs = CFG.cmakeArgs.length
    ? ` ${CFG.cmakeArgs.map((arg) => shQuote(arg)).join(' ')}`
    : '';
  const nativeLaunchObserverSetup = CFG.nativeLaunchObserver
    ? [
        `if [ ! -f ${shQuote(CFG.nativeLaunchObserverPath)} ]; then printf 'native launch observer missing: %s\\n' ${shQuote(CFG.nativeLaunchObserverPath)} >&2; exit 86; fi`,
        `export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}`,
        "export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only",
      ].join('\n')
    : ':';
  const upstreamRunEnvironmentSetup = CFG.runUpstream
    ? [
        `mkdir -p ${shQuote(upstreamRunLaunch.xdgRuntimeDir)}`,
        `chmod 700 ${shQuote(upstreamRunLaunch.xdgRuntimeDir)} || true`,
        `export XDG_RUNTIME_DIR=${shQuote(upstreamRunLaunch.xdgRuntimeDir)}`,
        `export SYNTHI_REAL_ROCM_UPSTREAM_DISPLAY_MODE=${shQuote(upstreamRunLaunch.effectiveDisplayMode)}`,
      ].join('\n')
    : ':';
  const upstreamRunCommand = CFG.upstreamRunCommand
    ? CFG.upstreamRunCommand
    : `./build/${shQuote(CFG.targetName)}`;
  const upstreamRunInvocation = upstreamRunLaunch.useXvfbRun
    ? `xvfb-run -a sh -lc ${shQuote(upstreamRunCommand)}`
    : `sh -lc ${shQuote(upstreamRunCommand)}`;
  const command = `
set -e
cd ${shQuote(`${CFG.workerRepoPath}/${CFG.buildSubdir}`)}
rm -rf build
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=/opt/rocm -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)}${cmakeExtraArgs} > ${shQuote(`${CFG.workerTempDir}/configure.log`)} 2>&1
configured=$(date +%s%3N)
if [ ${CFG.buildUpstream ? '1' : '0'} -eq 1 ]; then
  cmake --build build -j2 --target ${shQuote(CFG.targetName)} > ${shQuote(`${CFG.workerTempDir}/build.log`)} 2>&1
else
  : > ${shQuote(`${CFG.workerTempDir}/build.log`)}
fi
built=$(date +%s%3N)
run_status=0
if [ ${CFG.runUpstream ? '1' : '0'} -eq 1 ]; then
  ${nativeLaunchObserverSetup}
  ${upstreamRunEnvironmentSetup}
  set +e
  ${upstreamRunInvocation} > ${shQuote(`${CFG.workerTempDir}/run.log`)} 2>&1
  run_status=$?
  set -e
else
  printf 'upstream run skipped by SYNTHI_REAL_ROCM_RUN_UPSTREAM=0\\n' > ${shQuote(`${CFG.workerTempDir}/run.log`)}
fi
ran=$(date +%s%3N)
printf 'configure_ms=%s\\nbuild_ms=%s\\nrun_ms=%s\\nrun_exit_code=%s\\n' "$((configured-start))" "$((built-configured))" "$((ran-built))" "$run_status"
`;
  let timings;
  let lifecycleError = null;
  try {
    timings = await execText(
      'docker',
      ['exec', CFG.workerContainer, 'sh', '-lc', command],
      CFG.upstreamBuildTimeoutMs,
      true,
    );
  } catch (err) {
    lifecycleError = err;
    if (!canContinueWithCachedMetadataAfterLifecycleFailure({
      usesCachedMetadata: lifecyclePlan.usesCachedMetadata,
      cachedMetadataAvailable: Boolean(cachedMetadata),
    })) {
      throw err;
    }
    timings = 'configure_ms=failed\nbuild_ms=failed\nrun_ms=skipped\nrun_exit_code=not-run';
  }
  const runLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/run.log`)}`], 30000, false) ?? '';
  const configureLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/configure.log`)}`], 30000, false);
  const buildLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/build.log`)}`], 30000, false);
  const upstreamRunExitCode = parseUpstreamRunExitCode(timings);
  report.logs.upstream_run = runLog;
  report.logs.upstream_configure = configureLog ?? '';
  report.logs.upstream_build = buildLog ?? '';
  const phase = {
    name: 'upstream_gpu_build_run',
    timings,
    upstream_run_exit_code: upstreamRunExitCode,
    cmake_config: CFG.cmakeConfigName,
    cmake_args: CFG.cmakeArgs,
    output: runLog.slice(0, 1000),
    configure_output: String(configureLog ?? '').slice(-2000),
    build_output: String(buildLog ?? '').slice(-2000),
    metadata_source: lifecyclePlan.metadataSource,
    cached_metadata_dir: lifecyclePlan.cachedMetadataDir,
    lifecycle_error: lifecycleError
      ? {
          recovered_with_cached_metadata: true,
          message: lifecycleError.message,
          output: String(lifecycleError.output ?? '').slice(-2000),
        }
      : null,
    upstream_run_environment: upstreamRunLaunch,
    native_launch_observer: CFG.nativeLaunchObserver
      ? { enabled: true, path: CFG.nativeLaunchObserverPath }
      : { enabled: false },
  };
  report.phases.push(phase);
  record(
    'upstream GPU target metadata configured',
    lifecycleError ? 'warn' : 'pass',
    `${timings.replace(/\s+/g, ' ')} metadata=${lifecyclePlan.metadataSource} build=${CFG.buildUpstream ? 'on' : 'skipped'} run=${CFG.runUpstream ? 'on' : 'skipped'} cmake_args=${CFG.cmakeArgs.length}`,
  );
  if (lifecycleError) {
    record(
      'upstream GPU target lifecycle',
      'warn',
      `failed; continuing with cached_metadata=${CFG.buildMetadataDir}`,
    );
  }
  if (CFG.runUpstream) {
    record(
      'upstream runtime environment',
      upstreamRunLaunch.useXvfbRun || upstreamRunLaunch.requestedDisplayMode === 'none' ? 'pass' : 'warn',
      `display=${upstreamRunLaunch.effectiveDisplayMode} reason=${upstreamRunLaunch.reason} xdg=${upstreamRunLaunch.xdgRuntimeDir}`,
    );
  }
  if (CFG.runUpstream) {
    const status = upstreamRunExitCode === 0 ? 'pass' : 'warn';
    const detail = upstreamRunExitCode === null
      ? `exit_code=unknown log_bytes=${Buffer.byteLength(runLog)}`
      : `exit_code=${upstreamRunExitCode} log_bytes=${Buffer.byteLength(runLog)}`;
    record('upstream GPU target run', status, detail);
  }

  return cachedMetadata ?? collectBuildMetadataFromWorker(buildPath);
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

  const compileCommandsRaw = await readFile(compileHostPath, 'utf8');
  const compileCommandsJson = normalizeCompileCommands(compileCommandsRaw);
  const compileCommandSourcePaths = compileCommandSourcePathsFromRaw(compileCommandsRaw);
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
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
  });
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

  const compileCommandsRaw = await readFile(compileHostPath, 'utf8');
  const compileCommandsJson = normalizeCompileCommands(compileCommandsRaw);
  const compileCommandSourcePaths = compileCommandSourcePathsFromRaw(compileCommandsRaw);
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
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
  });
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

function buildMetadataCoversSource(sourcePath, { compileCommandSourcePaths = [], targetSourcePaths = [] } = {}) {
  const normalizedSource = String(sourcePath ?? '').replace(/\\/g, '/');
  if (!normalizedSource) return false;
  const compileSources = new Set([...compileCommandSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  const targetSources = new Set([...targetSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  return compileSources.has(normalizedSource) || targetSources.has(normalizedSource);
}

function ensureEntryCoveredByBuildMetadata({ compileCommandSourcePaths, targetSourcePaths }) {
  const entryFile = CFG.entryFile.replace(/\\/g, '/');
  if (buildMetadataCoversSource(entryFile, { compileCommandSourcePaths, targetSourcePaths })) return;
  throw new Error(`CMake metadata did not include ${CFG.entryFile}`);
}

function compileCommandSourcePathsFromRaw(raw) {
  return JSON.parse(raw)
    .map((entry) => repoRelativePath(entry?.file))
    .filter(Boolean)
    .sort();
}

function normalizeCompileCommands(raw) {
  const entries = JSON.parse(raw);
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

function canUseWorkspaceFileRef(fileName) {
  const normalized = String(fileName ?? '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//')) return false;
  return normalized
    .split('/')
    .filter(Boolean)
    .every((part) => part !== '..' && !part.startsWith('.'));
}

function compileProjectionRequestArgs(selectedFiles, phaseName) {
  if (CFG.compileTransport === 'inline') {
    return { files: selectedFiles };
  }
  if (CFG.compileTransport !== 'workspace-ref') {
    throw new Error(`unsupported compile transport: ${CFG.compileTransport}`);
  }
  const inlineFiles = selectedFiles.filter((file) => !canUseWorkspaceFileRef(file.name));
  const refFiles = selectedFiles.filter((file) => canUseWorkspaceFileRef(file.name));
  const fileRefs = refFiles.map((file) => ({
    name: file.name,
    sha256: createHash('sha256').update(file.content).digest('hex'),
    bytes: byteLength(file.content),
  }));
  if (report.compile_projection[phaseName]) {
    report.compile_projection[phaseName].request_file_refs = fileRefs.length;
    report.compile_projection[phaseName].request_inline_files = inlineFiles.length;
    report.compile_projection[phaseName].request_inline_bytes = inlineFiles.reduce(
      (sum, file) => sum + byteLength(file.content),
      0,
    );
    report.compile_projection[phaseName].request_file_ref_bytes = refFiles.reduce(
      (sum, file) => sum + byteLength(file.content),
      0,
    );
  }
  return { files: inlineFiles, file_refs: fileRefs };
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
    compile_transport: CFG.compileTransport,
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

async function beginPhaseRuntimeIdentityMonitor(phaseName) {
  const monitor = {
    phase: phaseName,
    container: CFG.workerContainer,
    enabled: CFG.mcpTransport === 'docker',
    changed: false,
    reason: null,
    changes: [],
    snapshots: [],
  };
  report.runtime_identity.phases.push(monitor);
  await capturePhaseRuntimeIdentity(monitor, 'before_compile');
  return monitor;
}

function runtimeIdentityFieldValue(snapshot, field) {
  if (!snapshot || snapshot.available === false) return null;
  return snapshot[field] ?? null;
}

function runtimeIdentityDiff(before, after) {
  if (!before || !after) return { changed: false, changes: [] };
  const changes = [];
  if (before.available !== after.available) {
    changes.push({ field: 'available', before: Boolean(before.available), after: Boolean(after.available) });
  }
  for (const field of ['id', 'image_id', 'status', 'pid', 'started_at', 'restart_count']) {
    const beforeValue = runtimeIdentityFieldValue(before, field);
    const afterValue = runtimeIdentityFieldValue(after, field);
    if (beforeValue !== afterValue) {
      changes.push({ field, before: beforeValue, after: afterValue });
    }
  }
  return {
    changed: changes.length > 0,
    changes,
    reason: changes.map((change) => `${change.field}:${change.before ?? 'null'}->${change.after ?? 'null'}`).join(','),
  };
}

async function capturePhaseRuntimeIdentity(monitor, label) {
  if (!monitor?.enabled) return null;
  const snapshot = await dockerContainerSnapshot(monitor.container);
  const base = monitor.snapshots[0]?.snapshot ?? snapshot;
  const diff = runtimeIdentityDiff(base, snapshot);
  const entry = {
    label,
    at: new Date().toISOString(),
    snapshot,
    diff,
  };
  monitor.snapshots.push(entry);
  if (diff.changed && !monitor.changed) {
    monitor.changed = true;
    monitor.reason = diff.reason;
    monitor.changes = diff.changes;
    record(`${monitor.phase} runtime identity`, 'fail', diff.reason);
    process.exitCode = 1;
  }
  return diff;
}

function phaseRuntimeIdentitySummary(monitor) {
  if (!monitor) return null;
  return {
    container: monitor.container,
    enabled: monitor.enabled,
    changed: monitor.changed,
    reason: monitor.reason,
    changes: monitor.changes,
    snapshot_count: monitor.snapshots.length,
    first: monitor.snapshots[0]?.snapshot ?? null,
    latest: monitor.snapshots.at(-1)?.snapshot ?? null,
  };
}

function runtimeIdentityLostWaitResult(monitor, startedAt) {
  if (!monitor?.changed) return null;
  return {
    status: 'runtime-session-lost',
    elapsedMs: Date.now() - startedAt,
    hmrElapsedMs: null,
    source: 'docker_runtime_identity',
    detail: {
      reason: monitor.reason,
      changes: monitor.changes,
      container: monitor.container,
    },
    frame_gate: {
      status: 'runtime_session_lost',
      note: 'worker runtime identity changed while waiting for the current HMR phase',
    },
  };
}

function runtimeIdentityChangeEvidence(runtimeIdentity = report.runtime_identity) {
  const phases = Array.isArray(runtimeIdentity?.phases) ? runtimeIdentity.phases : [];
  const changedPhases = phases.filter((phase) => phase?.changed === true);
  return {
    total_phases: phases.length,
    changed_count: changedPhases.length,
    changed_phases: changedPhases.map((phase) => ({
      phase: phase.phase ?? null,
      container: phase.container ?? null,
      reason: phase.reason ?? null,
      changes: Array.isArray(phase.changes) ? phase.changes : [],
    })),
    evidence_refs: changedPhases.map((phase) => `validation:runtime_identity:${phase.phase ?? 'unknown'}`),
  };
}

async function compileViaMcp(args, timeoutMs, phaseName) {
  const state = await ensureMcpAttached();
  const identityMonitor = await beginPhaseRuntimeIdentityMonitor(phaseName);
  const start = Date.now();
  let compile;
  try {
    compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  } catch (err) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'compile_error');
    const sessionLost = runtimeIdentityLostWaitResult(identityMonitor, start);
    if (sessionLost) {
      throw new Error(`${phaseName} runtime identity changed during synthi_compile: ${sessionLost.detail.reason}`);
    }
    throw err;
  }
  if (!compile?.ok) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'compile_rejected');
    const sessionLost = runtimeIdentityLostWaitResult(identityMonitor, start);
    if (sessionLost) {
      throw new Error(`${phaseName} runtime identity changed during synthi_compile: ${sessionLost.detail.reason}`);
    }
    throw new Error(`${phaseName} synthi_compile failed: ${JSON.stringify(compile).slice(0, 1000)}`);
  }
  const compileIdentityChange = await capturePhaseRuntimeIdentity(identityMonitor, 'after_compile');
  if (compileIdentityChange?.changed) {
    const waitStart = Date.now();
    const wait = runtimeIdentityLostWaitResult(identityMonitor, start);
    const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor);
    report.phases.push(phase);
    record(
      phaseName,
      'fail',
      `${summarizeGpuProof(phase.gpu_proof)} ${JSON.stringify(phase).slice(0, 1000)}`,
    );
    throw new Error(`${phaseName} runtime identity changed after synthi_compile: ${wait.detail.reason}`);
  }
  const waitStart = Date.now();
  const wait = await waitHmrForCurrentWorkspace(state, timeoutMs, phaseName, identityMonitor);
  await capturePhaseRuntimeIdentity(identityMonitor, 'after_wait');
  const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor);
  report.phases.push(phase);
  record(
    phaseName,
    wait?.status === 'applied' ? 'pass' : 'fail',
    `${summarizeGpuProof(phase.gpu_proof)} ${JSON.stringify(phase).slice(0, 1000)}`,
  );
  if (wait?.status !== 'applied') throw new Error(`${phaseName} wait_hmr status=${wait?.status}`);
  return { compile, wait, phase };
}

function phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor) {
  return {
    name: phaseName,
    compile_wall_ms: Date.now() - start,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? null,
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    gpu_proof: wait?.gpu_proof ?? null,
    gpu_proof_validation: wait?.gpu_proof_validation ?? null,
    runtime_identity: phaseRuntimeIdentitySummary(identityMonitor),
    wait_call_wall_ms: Date.now() - waitStart,
  };
}

async function waitHmrForCurrentWorkspace(state, timeoutMs, phaseName, identityMonitor = null) {
  const startedAt = Date.now();
  const eventLogSinceTs = startedAt - 2000;
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'before_wait_poll');
    const earlyIdentityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
    if (earlyIdentityLoss) return earlyIdentityLoss;
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
      await capturePhaseRuntimeIdentity(identityMonitor, 'wait_poll_error');
      const identityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
      if (identityLoss) return identityLoss;
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt);
      if (recovered) return recovered;
      throw err;
    }
    await capturePhaseRuntimeIdentity(identityMonitor, 'after_wait_poll');
    const identityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
    if (identityLoss) return identityLoss;
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
      const stats = await analyzeGpuHmrImageEvidence(bytes);
      const row = visualEvidenceRow({ label, path: outPath, ...stats, bytes: bytes.length, attempt });
      report.screenshots.push(row);
      const ok = screenshotQualifiesAsVisualEvidence(row);
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

function visualEvidenceFrames() {
  return report.screenshots.filter(screenshotQualifiesAsVisualEvidence);
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

const RUNTIME_EVIDENCE_PATTERN =
  /GPU AI Delta|device_only fast path|natural fallback|HMR Planner|reload_policy|HMR MODE|Restarting runner|gpu-reload|compile-device|Device sidecar|gpu-runtime-boundary|synthi_gpu_launch|gpu_runtime_error|gpu-hmr-rejected|Runner process exited|fatal|Rust cannot catch/i;

function runtimeEvidenceFromValidationLogs({ workerLogs, upstreamRunLog, slug }) {
  const scopedWorkerLogs = scopeLogTextToSession(workerLogs, slug);
  const scopedWorkerEvidence = evidenceLines(scopedWorkerLogs.text, RUNTIME_EVIDENCE_PATTERN);
  const upstreamRunEvidence = evidenceLines(upstreamRunLog, RUNTIME_EVIDENCE_PATTERN);
  return {
    scopedWorkerLogs,
    scopedWorkerEvidence,
    upstreamRunEvidence,
    runtimeEvidence: [...scopedWorkerEvidence, ...upstreamRunEvidence],
  };
}

function runtimeEvidenceScope(scopedWorkerLogs, upstreamRunEvidence) {
  const workerSessionMarkerObserved = scopedWorkerLogs?.marker_found === true;
  const upstreamRunEvidenceObserved =
    Array.isArray(upstreamRunEvidence) && upstreamRunEvidence.length > 0;
  return {
    observed: workerSessionMarkerObserved || upstreamRunEvidenceObserved,
    workerSessionMarkerObserved,
    upstreamRunEvidenceObserved,
    scopeKinds: [
      ...(workerSessionMarkerObserved ? ['worker-session-marker'] : []),
      ...(upstreamRunEvidenceObserved ? ['current-upstream-run-log'] : []),
    ],
  };
}

function countMatches(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length;
}

function normalizeSessionMarker(value) {
  return String(value ?? '').trim().replace(/^["']+|["',;:)]+$/g, '');
}

function runtimeSessionIdFromLine(line) {
  const match = String(line ?? '').match(/\bruntime_session=([^\s]+)/i);
  return match ? normalizeSessionMarker(match[1]) : null;
}

function logField(line, key) {
  return String(line ?? '').match(new RegExp(String.raw`\b${key}=([^\s]+)`, 'i'))?.[1] ?? '';
}

function logDim3Field(line, key) {
  const match = String(line ?? '').match(
    new RegExp(String.raw`\b${key}=\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)`, 'i'),
  );
  return match ? `${Number(match[1])}x${Number(match[2])}x${Number(match[3])}` : null;
}

function evidenceRefPart(value, fallback) {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96);
  return cleaned || fallback;
}

function sessionMarkerFromLine(line) {
  const text = String(line ?? '');
  const patterns = [
    { kind: 'guest-registry', pattern: /\[GuestRegistry\]\s+session=([^\s]+)/i },
    { kind: 'runner-env', pattern: /\[Runner\]\s+Session ID from env:\s*([^\s]+)/i },
    { kind: 'runner-stdin-session', pattern: /\bStdin received:\s*set_session\s+([^\s]+)/i },
    { kind: 'runner-command-session', pattern: /\[Runner\]\s+Processing command:\s*set_session\s+([^\s]+)/i },
    { kind: 'runner-host-kv-session', pattern: /\[HOST-KV\]\s+Session already set:\s*([^\s]+)/i },
    { kind: 'worker-send-session', pattern: /\bSending session to runner:\s*set_session\s+([^\s]+)/i },
  ];
  for (const { kind, pattern } of patterns) {
    const match = text.match(pattern);
    if (match) {
      const sessionId = normalizeSessionMarker(match[1]);
      if (sessionId) return { kind, sessionId };
    }
  }
  return null;
}

function scopeLogTextToSession(text, slug) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (!slug) {
    return {
      text: lines.join('\n'),
      marker_found: false,
      dropped_before: 0,
      total_lines: lines.length,
      marker_kind: null,
      stopped_before: lines.length,
      stop_marker_found: false,
      stale_runtime_lines_dropped: 0,
    };
  }
  const markerIndex = lines.findIndex((line) => sessionMarkerFromLine(line)?.sessionId === slug);
  if (markerIndex < 0) {
    return {
      text: '',
      marker_found: false,
      dropped_before: lines.length,
      total_lines: lines.length,
      marker_kind: null,
      stopped_before: lines.length,
      stop_marker_found: false,
      stale_runtime_lines_dropped: 0,
    };
  }
  const marker = sessionMarkerFromLine(lines[markerIndex]);
  let stopIndex = lines.length;
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const nextMarker = sessionMarkerFromLine(lines[index]);
    if (nextMarker && nextMarker.sessionId !== slug) {
      stopIndex = index;
      break;
    }
  }
  const staleRuntimeSessionIds = new Set();
  for (let index = 0; index < markerIndex; index += 1) {
    const runtimeSessionId = runtimeSessionIdFromLine(lines[index]);
    if (runtimeSessionId) staleRuntimeSessionIds.add(runtimeSessionId);
  }
  let staleRuntimeLinesDropped = 0;
  const scopedLines = [];
  for (const line of lines.slice(markerIndex, stopIndex)) {
    const runtimeSessionId = runtimeSessionIdFromLine(line);
    if (runtimeSessionId && staleRuntimeSessionIds.has(runtimeSessionId)) {
      staleRuntimeLinesDropped += 1;
      continue;
    }
    scopedLines.push(line);
  }
  return {
    text: scopedLines.join('\n'),
    marker_found: true,
    dropped_before: markerIndex,
    total_lines: lines.length,
    marker_kind: marker?.kind ?? null,
    stopped_before: stopIndex,
    stop_marker_found: stopIndex < lines.length,
    stale_runtime_lines_dropped: staleRuntimeLinesDropped,
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
  const successRecords = dispatchSuccessLines.map((line) => {
    const kernelName = logField(line, 'kernel');
    const runtimeSession = logField(line, 'runtime_session');
    const artifactId = logField(line, 'artifact_id');
    const dispatcherRegistrationId = logField(line, 'dispatcher_registration_id');
    const dispatchTableHash = logField(line, 'dispatch_table_hash');
    const dispatchTableEntryId = logField(line, 'dispatch_table_entry_id');
    const streamId = logField(line, 'stream');
    const gridDimensions = logDim3Field(line, 'grid');
    const blockDimensions = logDim3Field(line, 'block');
    const sharedMemoryBytes = Number(logField(line, 'shared_bytes'));
    const dispatchTimestamp = Number(logField(line, 'dispatch_timestamp'));
    return {
      line,
      kernelName: kernelName && kernelName !== 'none' ? kernelName : null,
      runtimeSession: runtimeSession && runtimeSession !== 'none' ? runtimeSession : null,
      artifactId: artifactId && artifactId !== 'none' ? artifactId : null,
      dispatcherRegistrationId: dispatcherRegistrationId && dispatcherRegistrationId !== 'none'
        ? dispatcherRegistrationId
        : null,
      dispatchTableHash: dispatchTableHash && dispatchTableHash !== 'none' ? dispatchTableHash : null,
      dispatchTableEntryId: dispatchTableEntryId && dispatchTableEntryId !== 'none'
        ? dispatchTableEntryId
        : null,
      streamId: streamId && streamId !== 'none' ? streamId : null,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes: Number.isFinite(sharedMemoryBytes) && sharedMemoryBytes >= 0
        ? sharedMemoryBytes
        : null,
      dispatchTimestamp: Number.isFinite(dispatchTimestamp) && dispatchTimestamp >= 0
        ? dispatchTimestamp
        : null,
    };
  });
  const dispatchEvidenceRefs = [...new Set(successRecords.map((record) => {
    if (!record.runtimeSession || !record.kernelName) return null;
    return `worker-log:synthi_gpu_launch:${evidenceRefPart(record.runtimeSession, 'session')}:${evidenceRefPart(record.kernelName, 'kernel')}`;
  }).filter(Boolean))];
  return {
    success_count: dispatchSuccessCount,
    success_lines: dispatchSuccessLines.slice(-20),
    success_records: successRecords.slice(-20),
    evidence_refs: dispatchEvidenceRefs,
    runtime_artifact_ids: [...new Set(successRecords.map((record) => record.artifactId).filter(Boolean))],
    dispatcher_registration_ids: [
      ...new Set(successRecords.map((record) => record.dispatcherRegistrationId).filter(Boolean)),
    ],
    dispatch_table_hashes: [...new Set(successRecords.map((record) => record.dispatchTableHash).filter(Boolean))],
    dispatch_table_entry_ids: [
      ...new Set(successRecords.map((record) => record.dispatchTableEntryId).filter(Boolean)),
    ],
    dispatch_stream_ids: [...new Set(successRecords.map((record) => record.streamId).filter(Boolean))],
    grid_dimensions: [...new Set(successRecords.map((record) => record.gridDimensions).filter(Boolean))],
    block_dimensions: [...new Set(successRecords.map((record) => record.blockDimensions).filter(Boolean))],
    shared_memory_bytes: [
      ...new Set(successRecords.map((record) => record.sharedMemoryBytes).filter((value) => value !== null)),
    ],
    dispatch_timestamps: successRecords
      .map((record) => record.dispatchTimestamp)
      .filter((value) => value !== null),
    failure_count: dispatchFailureLines.length,
    failure_lines: dispatchFailureLines.slice(0, 20),
  };
}

function runtimeNativeLaunchObservationEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_launch_observed\b/i.test(line)
  );
  const records = lines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    sequence: logField(line, 'sequence'),
    result: logField(line, 'result'),
    dispatch: logField(line, 'dispatch'),
  }));
  return {
    total_count: records.length,
    apis: [...new Set(records.map((record) => record.api).filter(Boolean))],
    runtime_session_ids: [
      ...new Set(records.map((record) => record.runtimeSession).filter(Boolean)),
    ],
    observe_only_count: records.filter((record) =>
      String(record.dispatch ?? '').toLowerCase() === 'observed-native'
    ).length,
    records: records.slice(-20),
  };
}

function selectedArtifactIdsFromProofArtifacts(records) {
  const ids = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;
    if (typeof artifact.selectedArtifactId === 'string' && artifact.selectedArtifactId.trim()) {
      ids.add(artifact.selectedArtifactId.trim());
    }
    const stages = Array.isArray(artifact.stageResults) ? artifact.stageResults : [];
    for (const stage of stages) {
      for (const value of Array.isArray(stage?.outputArtifactIds) ? stage.outputArtifactIds : []) {
        if (typeof value === 'string' && value.trim()) ids.add(value.trim());
      }
    }
  }
  return [...ids].filter((id) => /^artifact:/i.test(id));
}

function runtimeArtifactMatchesSelected({ runtimeDispatch, selectedArtifactIds }) {
  const selected = new Set(selectedArtifactIds);
  return selected.size > 0
    && runtimeDispatch.runtime_artifact_ids.some((artifactId) => selected.has(artifactId));
}

function runtimeArgProvenanceEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) =>
    /\blaunch_arg_provenance\b/i.test(line)
  );
  const completeLines = lines.filter((line) => /\bcomplete=true\b/i.test(line));
  const incompleteLines = lines.filter((line) => /\bcomplete=false\b/i.test(line));
  let knownArgCount = 0;
  let detailRecordCount = 0;
  let rejectedDetailCount = 0;
  const records = [];
  const unknownCount = lines.reduce((total, line) => {
    const knownMatch = line.match(/\bknown_args=(\d+)/i);
    const known = knownMatch ? Number.parseInt(knownMatch[1], 10) || 0 : 0;
    const runtimeSession = runtimeSessionIdFromLine(line);
    const kernel = logField(line, 'kernel');
    const generation = logField(line, 'generation');
    const detailRecords = parseLaunchArgProvenanceDetails(logField(line, 'details'), {
      kernel,
      runtimeSession,
      generation,
      expectedArgCount: known,
    });
    const detailRejected = detailRecords.filter((record) => !record.runtimeProven).length;
    knownArgCount += known;
    detailRecordCount += detailRecords.length;
    rejectedDetailCount += detailRejected;
    records.push(...detailRecords);
    const match = line.match(/\bunknown_args=(\d+)/i);
    return total + (match ? Number.parseInt(match[1], 10) || 0 : 0);
  }, 0);
  const incompleteRecordCount = lines.reduce((total, line) => {
    const known = Number(line.match(/\bknown_args=(\d+)/i)?.[1] ?? 0);
    const unknown = Number(line.match(/\bunknown_args=(\d+)/i)?.[1] ?? 0);
    const detailRecords = parseLaunchArgProvenanceDetails(logField(line, 'details'));
    const detailRejected = detailRecords.filter((record) => !record.runtimeProven).length;
    return total + (
      !/\bcomplete=true\b/i.test(line)
      || unknown > 0
      || detailRecords.length < known
      || detailRejected > 0
        ? 1
        : 0
    );
  }, 0);
  const evidenceRefs = lines
    .map((line) => {
      const runtimeSession = runtimeSessionIdFromLine(line);
      if (!runtimeSession) return null;
      return [
        'worker-log',
        'launch_arg_provenance',
        evidenceRefPart(logField(line, 'kernel'), 'kernel'),
        evidenceRefPart(runtimeSession, 'runtime-session'),
        evidenceRefPart(logField(line, 'generation'), 'generation'),
      ].join(':');
    })
    .filter(Boolean);
  return {
    total_count: lines.length,
    complete_count: completeLines.length,
    incomplete_count: Math.max(incompleteLines.length, incompleteRecordCount),
    known_arg_count: knownArgCount,
    unknown_arg_count: unknownCount,
    detail_record_count: detailRecordCount,
    rejected_detail_count: rejectedDetailCount,
    record_complete: lines.length > 0
      && incompleteRecordCount === 0
      && unknownCount === 0
      && detailRecordCount >= knownArgCount
      && rejectedDetailCount === 0,
    records,
    evidence_refs: [...new Set(evidenceRefs)],
    complete_lines: completeLines.slice(-20),
    incomplete_lines: incompleteLines.slice(-20),
  };
}

function parseLaunchArgProvenanceDetails(details, context = {}) {
  const raw = String(details ?? '').trim();
  if (!raw || raw === '-') return [];
  const kernelName = String(context.kernel ?? '').trim() || null;
  const runtimeSessionId = String(context.runtimeSession ?? '').trim() || null;
  const generation = String(context.generation ?? '').trim() || null;
  const expectedArgCount = Number.isInteger(context.expectedArgCount) && context.expectedArgCount >= 0
    ? context.expectedArgCount
    : null;
  const launchKey = [
    kernelName ?? 'kernel',
    runtimeSessionId ?? 'runtime-session',
    generation ?? 'generation',
  ].join(':');
  return raw.split(',').map((part) => {
    const sizeMatch = part.match(/:size=(\d+)$/i);
    if (!sizeMatch) return null;
    const prefix = part.slice(0, sizeMatch.index);
    const pieces = prefix.split(':');
    const index = Number(pieces.shift());
    const kind = pieces.shift() ?? '';
    const observedValue = pieces.find((piece) => /^0x[0-9a-f]+$/i.test(piece)) ?? null;
    const allocationIdToken = pieces.find((piece) => /^alloc_id=[A-Za-z0-9._-]+$/i.test(piece)) ?? null;
    const allocationId = allocationIdToken
      ? allocationIdToken.slice('alloc_id='.length)
      : null;
    const allocationBytes = numberFromToken(pieces.find((piece) => /^alloc_bytes=\d+$/i.test(piece)));
    const allocationOffset = numberFromToken(pieces.find((piece) => /^alloc_offset=\d+$/i.test(piece)));
    const allocationName = pieces
      .filter((piece) =>
        !/^0x[0-9a-f]+$/i.test(piece)
        && !/^alloc_id=[A-Za-z0-9._-]+$/i.test(piece)
        && !/^alloc_bytes=\d+$/i.test(piece)
        && !/^alloc_offset=\d+$/i.test(piece)
      )
      .join(':') || null;
    const category = launchArgCategory(kind);
    return Number.isInteger(index) && index >= 0 && category
      ? {
        argIndex: index,
        kind,
        category,
        provenance: 'runtime_observed',
        confidence: category === 'unknown' ? 'unknown' : 'verified',
        kernelName,
        runtimeSessionId,
        generation,
        launchKey,
        expectedArgCount,
        allocationName,
        allocationId: allocationId ?? (allocationName ? `allocation:${allocationName}` : null),
        allocationBytes,
        allocationSize: allocationBytes,
        allocationOffset,
        observedValue,
        valueSize: Number(sizeMatch[1]),
        runtimeProven: category === 'literal'
          || (category === 'device_allocation' && allocationBytes !== null && Boolean(allocationId ?? allocationName)),
      }
      : null;
  }).filter(Boolean);
}

function numberFromToken(token) {
  const value = String(token ?? '').split('=')[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function launchArgCategory(kind) {
  const normalized = String(kind ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (normalized === 'device-allocation') return 'device_allocation';
  if (normalized === 'scalar-value') return 'literal';
  if (normalized === 'null-value') return 'unknown';
  if (normalized === 'aggregate-value') return 'generated_temporary';
  if (normalized === 'unknown-pointer') return 'unknown';
  if (normalized === 'unknown-pointer-or-scalar') return 'unknown';
  if (normalized === 'missing-arg-storage') return 'unknown';
  if (normalized === 'legacy-unknown-size') return 'unknown';
  return null;
}

function runtimeSessionEvidence(workerEvidence) {
  const ids = [];
  const lines = [];
  for (const line of workerEvidence) {
    if (!/\bgpu-runtime-boundary\b/i.test(line)) continue;
    const match = line.match(/\bruntime_session=([^\s]+)/i);
    if (!match) continue;
    ids.push(match[1]);
    lines.push(line);
  }
  const unique_ids = [...new Set(ids)].sort();
  return {
    record_count: ids.length,
    unique_ids,
    consistent: unique_ids.length === 1,
    lines: lines.slice(-20),
  };
}

function runtimeOwnershipEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) => /\bruntime_ownership\b/i.test(line));
  const scopeProvenLines = lines.filter((line) => {
    const expected = line.match(/\bexpected_symbols=([^\s]+)/i)?.[1] ?? '';
    const touched = line.match(/\btouched_symbols=([^\s]+)/i)?.[1] ?? '';
    return expected && touched && expected !== '-' && expected === touched;
  });
  return {
    total_count: lines.length,
    primary_replacement_count: lines.filter((line) => /\breplaced_primary=true\b/i.test(line)).length,
    primary_retained_count: lines.filter((line) => /\breplaced_primary=false\b/i.test(line)).length,
    scope_proven_count: scopeProvenLines.length,
    scope_lines: scopeProvenLines.slice(-20),
    lines: lines.slice(-20),
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
  const visualRows = [
    { path: 'blank.png', width: 800, height: 600, visible_pixels: 0 },
    { path: 'tiny.png', width: 120, height: 90, visible_pixels: 10800 },
    {
      path: 'fresh.png',
      width: 800,
      height: 600,
      visible_pixels: 480000,
      luma_stddev: 24,
      rgb_span_mean: 128,
      unique_color_sample_count: 128,
    },
  ].filter(screenshotQualifiesAsVisualEvidence);
  if (visualRows.length !== 1 || visualRows[0]?.path !== 'fresh.png') {
    throw new Error('visual evidence frame predicate accepted a diagnostic-only screenshot');
  }
  const parsedCmakeArgs = parseStringArrayEnv(
    '["-DNAME=value with spaces","-DENABLE_FEATURE=ON"]',
    'SELF_CHECK_CMAKE_ARGS',
  );
  if (
    parsedCmakeArgs.length !== 2
    || parsedCmakeArgs[0] !== '-DNAME=value with spaces'
    || parsedCmakeArgs[1] !== '-DENABLE_FEATURE=ON'
  ) {
    throw new Error('CMake args JSON parser failed');
  }
  try {
    parseStringArrayEnv('{"not":"array"}', 'SELF_CHECK_CMAKE_ARGS');
    throw new Error('CMake args parser accepted non-array JSON');
  } catch (err) {
    if (!/expected JSON string array/.test(err.message)) {
      throw err;
    }
  }
  const parsedExitCode = parseUpstreamRunExitCode('configure_ms=1\nbuild_ms=2\nrun_ms=3\nrun_exit_code=133\n');
  if (parsedExitCode !== 133) {
    throw new Error('upstream run exit code parser did not preserve the recorded status');
  }
  const evidence = runtimeDispatchEvidence([
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=first grid=(1, 1, 1) dispatch=ok dispatch_timestamp=1779979999000',
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
  if (evidence.dispatch_timestamps[0] !== 1779979999000) {
    throw new Error('dispatch timestamp evidence parser failed');
  }
  const scoped = scopeLogTextToSession(
    [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale grid=(1, 1, 1) dispatch=ok',
      '[Main] Existing runner: requested_session=Some("target-session")',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale-after-weak-marker grid=(1, 1, 1) dispatch=ok runtime_session=old-session',
      '[Runner] Session ID from env: target-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=still-stale grid=(1, 1, 1) dispatch=ok runtime_session=old-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok runtime_session=new-session',
      '[Runner] Session ID from env: other-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=next-session grid=(1, 1, 1) dispatch=ok runtime_session=other-session',
    ].join('\n'),
    'target-session',
  );
  const scopedEvidence = runtimeDispatchEvidence(evidenceLines(scoped.text, /gpu-runtime-boundary/i));
  if (
    scoped.marker_kind !== 'runner-env'
    || !scoped.stop_marker_found
    || scoped.stale_runtime_lines_dropped !== 1
    || scopedEvidence.success_count !== 1
    || !scopedEvidence.success_lines[0]?.includes('kernel=current')
  ) {
    throw new Error('session-scoped dispatch evidence included stale or later-session dispatch lines');
  }
  const legacyScoped = scopeLogTextToSession(
    [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale grid=(1, 1, 1) dispatch=ok',
      '[Runner] Session ID from env: target-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok',
    ].join('\n'),
    'target-session',
  );
  const legacyScopedEvidence = runtimeDispatchEvidence(evidenceLines(legacyScoped.text, /gpu-runtime-boundary/i));
  if (legacyScopedEvidence.success_count !== 1 || !legacyScopedEvidence.success_lines[0]?.includes('kernel=current')) {
    throw new Error('session-scoped dispatch evidence included stale dispatch lines');
  }
  const provenance = runtimeArgProvenanceEvidence([
    '[gpu-runtime-boundary] launch_arg_provenance kernel=current generation=2 complete=false known_args=1 unknown_args=2 degradedState=gpu-hmr-unknown-arg-provenance details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
    '[gpu-runtime-boundary] launch_arg_provenance kernel=known generation=2 runtime_session=pid1 complete=true known_args=2 unknown_args=0 degradedState=none details=0:device-allocation:alloc_id=runtime-allocation-self:0x10:alloc_bytes=8:alloc_offset=0:size=8,1:scalar-value:size=4',
  ]);
  if (
    provenance.total_count !== 2
    || provenance.incomplete_count !== 1
    || provenance.unknown_arg_count !== 2
    || provenance.known_arg_count !== 3
    || provenance.detail_record_count !== 3
    || provenance.records[1]?.category !== 'device_allocation'
    || provenance.records[1]?.allocationId !== 'runtime-allocation-self'
    || provenance.records[1]?.allocationName !== null
    || provenance.records[1]?.allocationSize !== 8
    || provenance.records[2]?.category !== 'literal'
    || provenance.evidence_refs[0] !== 'worker-log:launch_arg_provenance:known:pid1:2'
  ) {
    throw new Error('runtime arg provenance evidence parser failed');
  }
  const runtimeSession = runtimeSessionEvidence([
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok runtime_session=pid1-100',
    '[gpu-runtime-boundary] launch_arg_provenance kernel=current generation=2 runtime_session=pid1-100 complete=true known_args=1 unknown_args=0 degradedState=none details=-',
  ]);
  if (!runtimeSession.consistent || runtimeSession.unique_ids[0] !== 'pid1-100') {
    throw new Error('runtime session evidence parser failed');
  }
  const stableIdentityBefore = {
    available: true,
    id: 'container-a',
    image_id: 'image-a',
    status: 'running',
    pid: 101,
    started_at: '2026-05-27T00:00:00Z',
    restart_count: 0,
  };
  const stableIdentityAfter = { ...stableIdentityBefore };
  if (runtimeIdentityDiff(stableIdentityBefore, stableIdentityAfter).changed) {
    throw new Error('runtime identity diff marked stable container identity as changed');
  }
  const restartedIdentity = {
    ...stableIdentityBefore,
    pid: 202,
    started_at: '2026-05-27T00:00:30Z',
    restart_count: 1,
  };
  const identityDiff = runtimeIdentityDiff(stableIdentityBefore, restartedIdentity);
  if (
    !identityDiff.changed
    || !identityDiff.changes.some((change) => change.field === 'restart_count')
    || !identityDiff.changes.some((change) => change.field === 'started_at')
  ) {
    throw new Error('runtime identity diff failed to detect container restart evidence');
  }
  const lostResult = runtimeIdentityLostWaitResult({
    container: 'runtime-under-test',
    changed: true,
    reason: identityDiff.reason,
    changes: identityDiff.changes,
  }, Date.now() - 10);
  if (lostResult?.status !== 'runtime-session-lost' || lostResult.source !== 'docker_runtime_identity') {
    throw new Error('runtime identity loss did not produce a degraded wait result');
  }
  const identityChangeEvidence = runtimeIdentityChangeEvidence({
    phases: [
      { phase: 'stable_phase', changed: false, container: 'runtime-under-test' },
      { phase: 'changed_phase', changed: true, container: 'runtime-under-test', reason: identityDiff.reason },
    ],
  });
  if (
    identityChangeEvidence.changed_count !== 1
    || identityChangeEvidence.evidence_refs[0] !== 'validation:runtime_identity:changed_phase'
  ) {
    throw new Error('runtime identity change evidence summarizer failed');
  }
  const ownership = runtimeOwnershipEvidence([
    '[gpu-reload] runtime_ownership label=gpu-hmr-partial partial=true artifact=/x expected_symbols=a touched_symbols=a retired_modules=0 replaced_primary=false',
    '[gpu-reload] runtime_ownership label=gpu-hmr-full-device partial=false artifact=/x expected_symbols=a touched_symbols=a retired_modules=0 replaced_primary=true',
  ]);
  if (
    ownership.primary_retained_count !== 1
    || ownership.primary_replacement_count !== 1
    || ownership.scope_proven_count !== 2
  ) {
    throw new Error('runtime ownership evidence parser failed');
  }
  const epochEvidence = runtimeEpochSwapEvidence([
    '[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000',
    '[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true',
  ]);
  if (
    !epochEvidence.published
    || !epochEvidence.old_generation_retired
    || !epochEvidence.stream_ordering_proven
  ) {
    throw new Error('runtime epoch evidence parser failed');
  }
  const originalHostRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: [
      '[Runner] Session ID from env: target-session',
      '[gpu-reload] runtime_ownership label=gpu-hmr-partial partial=true artifact=/x expected_symbols=kernel touched_symbols=kernel retired_modules=0 replaced_primary=false',
    ].join('\n'),
    upstreamRunLog: [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid-original dispatch_table_entry_id=entry-kernel',
      '[gpu-runtime-boundary] launch_arg_provenance kernel=kernel generation=3 runtime_session=pid-original dispatch_table_entry_id=entry-kernel complete=true known_args=1 unknown_args=0 degradedState=none details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
      '[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=host_runtime_explicit host_path_id=host-loop dispatch_table_entry_id=entry-kernel runtime_dispatch_table_entry_id=entry-kernel dispatch_entry_runtime_verified=true generation=3 runtime_session=pid-original',
    ].join('\n'),
  });
  const originalHostPath = originalHostPathProofFromRuntimeEvidence(
    originalHostRuntimeEvidence.runtimeEvidence,
    { required: true, runtimeSessionIds: ['pid-original'] },
  );
  if (
    originalHostRuntimeEvidence.upstreamRunEvidence.length !== 3
    || !originalHostPath.proof.attachmentProven
  ) {
    throw new Error('original host run runtime evidence was not accepted');
  }
  const syntheticArtifactId = `artifact:sha256:${'1'.repeat(64)}`;
  const syntheticDispatcherId = `dispatcher:sha256:${'2'.repeat(64)}`;
  const upstreamOnlyRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: '',
    upstreamRunLog: [
      `[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid-original artifact_id=${syntheticArtifactId} dispatcher_registration_id=${syntheticDispatcherId} dispatch_table_hash=0x123 dispatch_table_entry_id=kernel:0x1 dispatch_timestamp=1779979999000`,
      '[gpu-runtime-boundary] launch_arg_provenance kernel=kernel generation=3 runtime_session=pid-original complete=true known_args=1 unknown_args=0 degradedState=none details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
    ].join('\n'),
  });
  const upstreamOnlyScope = runtimeEvidenceScope(
    upstreamOnlyRuntimeEvidence.scopedWorkerLogs,
    upstreamOnlyRuntimeEvidence.upstreamRunEvidence,
  );
  const upstreamOnlyDispatch = runtimeDispatchEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlySession = runtimeSessionEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlyArgProvenance =
    runtimeArgProvenanceEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlyDispatchProof = classifyGpuHmrDispatchProof({
    dispatchObserved: upstreamOnlyDispatch.success_count > 0 && upstreamOnlyScope.observed,
    dispatchEvidenceRefs: upstreamOnlyDispatch.evidence_refs,
    sessionScoped: upstreamOnlyScope.observed && upstreamOnlySession.record_count > 0,
    runtimeSessionIds: upstreamOnlySession.unique_ids,
    runtimeSessionConsistent: upstreamOnlySession.consistent,
    argProvenanceObserved: upstreamOnlyArgProvenance.total_count > 0,
    argProvenanceComplete: upstreamOnlyArgProvenance.complete_count > 0
      && upstreamOnlyArgProvenance.incomplete_count === 0
      && upstreamOnlyArgProvenance.unknown_arg_count === 0,
    argProvenanceEvidenceRefs: upstreamOnlyArgProvenance.evidence_refs,
    argProvenanceRecords: upstreamOnlyArgProvenance.records,
    argProvenanceRecordComplete: upstreamOnlyArgProvenance.record_complete,
    argProvenanceKnownArgCount: upstreamOnlyArgProvenance.known_arg_count,
    unknownArgCount: upstreamOnlyArgProvenance.unknown_arg_count,
    abiProof: {
      resultState: 'gpu-hmr-abi-proven',
      evidenceRefs: ['evidence:dispatch-self-check:abi'],
    },
    epochProof: {
      resultState: 'gpu-hmr-epoch-swap-proven',
      evidenceRefs: ['evidence:dispatch-self-check:epoch'],
    },
    streamOrderingProven: true,
    replacementScopeProven: true,
    selectedArtifactIds: [syntheticArtifactId],
    runtimeArtifactIds: upstreamOnlyDispatch.runtime_artifact_ids,
    dispatcherRegistrationIds: upstreamOnlyDispatch.dispatcher_registration_ids,
    dispatchTableEntryIds: upstreamOnlyDispatch.dispatch_table_entry_ids,
    dispatchTableHashes: upstreamOnlyDispatch.dispatch_table_hashes,
    dispatchStreamIds: upstreamOnlyDispatch.dispatch_stream_ids,
    gridDimensions: upstreamOnlyDispatch.grid_dimensions,
    blockDimensions: upstreamOnlyDispatch.block_dimensions,
    sharedMemoryBytes: upstreamOnlyDispatch.shared_memory_bytes,
    dispatchTimestamps: upstreamOnlyDispatch.dispatch_timestamps,
    runtimeArtifactMatchesSelected: runtimeArtifactMatchesSelected({
      runtimeDispatch: upstreamOnlyDispatch,
      selectedArtifactIds: [syntheticArtifactId],
    }),
  });
  if (
    !upstreamOnlyScope.observed
    || !upstreamOnlyScope.upstreamRunEvidenceObserved
    || upstreamOnlyScope.workerSessionMarkerObserved
    || upstreamOnlyDispatch.runtime_artifact_ids[0] !== syntheticArtifactId
    || upstreamOnlyDispatch.evidence_refs[0] !== 'worker-log:synthi_gpu_launch:pid-original:kernel'
    || upstreamOnlyDispatchProof.resultState !== 'gpu-hmr-dispatch-safe-proven'
  ) {
    throw new Error('current upstream run runtime evidence did not establish dispatch scope');
  }
  const nativeOnlyRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: '',
    upstreamRunLog: [
      '[gpu-runtime-boundary] native_launch_observed api=genericLaunch runtime_session=native-session sequence=1 function_ptr=0x1 grid=(1,1,1) block=(1,1,1) args_ptr=0x2 stream=0x3 shared_bytes=0 result=0 dispatch=observed-native attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] original_host_path event=observed attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-launch-observer:1 dispatch_table_entry_id=none runtime_dispatch_table_entry_id=none dispatch_entry_runtime_verified=false generation=0 runtime_session=native-session',
    ].join('\n'),
  });
  const nativeOnlyObservation = runtimeNativeLaunchObservationEvidence(
    nativeOnlyRuntimeEvidence.runtimeEvidence,
  );
  const nativeOnlyDispatch = runtimeDispatchEvidence(nativeOnlyRuntimeEvidence.runtimeEvidence);
  const nativeOnlyOriginalHost = originalHostPathProofFromRuntimeEvidence(
    nativeOnlyRuntimeEvidence.runtimeEvidence,
    { required: true, runtimeSessionIds: ['native-session'] },
  );
  if (
    nativeOnlyObservation.total_count !== 1
    || nativeOnlyObservation.observe_only_count !== 1
    || nativeOnlyDispatch.success_count !== 0
    || nativeOnlyOriginalHost.evidence.raw_count !== 1
    || nativeOnlyOriginalHost.proof.attachmentProven
  ) {
    throw new Error('native launch observation self-check must remain observe-only');
  }
  const hostIdentityEvidence = runtimeHostIdentityEvidence([
    '[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=stream ptr=0x2000 aux=0 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=stream ptr=0x2000 aux=0 generation=3 runtime_session=pid1',
  ], {
    expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
  });
  if (
    !hostIdentityEvidence.identity_checks_passed
    || hostIdentityEvidence.preserved_roles[0] !== 'core_state'
    || !hostIdentityEvidence.required_roles_observed
  ) {
    throw new Error('runtime host identity evidence parser failed');
  }
  const outputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.checksum required_oracle_id=probe.checksum kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1',
  ]);
  if (
    outputOracleEvidence.total_count !== 1
    || !outputOracleEvidence.deterministic_output_observed
    || !outputOracleEvidence.deterministic_oracle_provided
    || !outputOracleEvidence.deterministic_oracle_passed
    || outputOracleEvidence.output_oracle?.actual !== 'sha256:abc'
  ) {
    throw new Error('runtime output oracle evidence parser failed');
  }
  const runtimeTransportEvidence = runtimeArtifactTransportEvidence([
    '[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=8 reload_request_transport=filesystem_path,ram_blob selected_loader_transport=filesystem_path loader_api=module_load_path ram_reference=true ram_blob_id=artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ram_transport_proven=false degraded_state=gpu-hmr-ram-io-unavailable degraded_reason=selected_loader_uses_filesystem_path load_result=ok',
  ], { runtimeSessionIds: ['pid1'] });
  if (
    runtimeTransportEvidence.matched_count !== 1
    || runtimeTransportEvidence.loader_transports[0] !== 'filesystem_path'
    || runtimeTransportEvidence.reload_request_transports.length !== 2
    || runtimeTransportEvidence.ram_transport_proven
    || runtimeTransportEvidence.degraded_state !== 'gpu-hmr-ram-io-unavailable'
  ) {
    throw new Error('runtime artifact transport evidence parser failed');
  }
  const outputOracleContract = parseOutputOracleContract(
    '{"id":"probe.expected","requiredOracleId":"probe.expected","kind":"buffer_checksum","expected":"sha256:def","producer":"runtime_probe","outputTargetId":"target:main","artifactId":"artifact:def"}',
  );
  const constrainedOutputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:other artifact_id=artifact:def',
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main artifact_id=artifact:def',
  ], { outputOracleContract });
  const mismatchedOutputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main artifact_id=artifact:other',
  ], { outputOracleContract });
  if (
    constrainedOutputOracleEvidence.matched_count !== 1
    || constrainedOutputOracleEvidence.output_oracle?.actual !== 'sha256:def'
    || mismatchedOutputOracleEvidence.deterministic_oracle_passed
  ) {
    throw new Error('runtime output oracle contract filter failed');
  }
  const visualOnlyProof = classifyGpuHmrOutputProof({
    dispatchSafeProven: true,
    visualFrameObserved: true,
  });
  const outputMissingProof = classifyGpuHmrOutputProof({
    dispatchSafeProven: true,
    visualFrameObserved: false,
  });
  const dispatchUnknownProof = classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    dispatchEvidenceRefs: ['worker-log:synthi_gpu_launch:runtime-session:self-check:kernel'],
    sessionScoped: true,
    runtimeSessionIds: ['runtime-session:self-check'],
    argProvenanceObserved: true,
    argProvenanceComplete: false,
    unknownArgCount: 2,
  });
  if (
    visualOnlyProof.degradedState !== 'gpu-hmr-visual-only'
    || outputMissingProof.degradedState !== 'gpu-hmr-output-unobserved'
    || dispatchUnknownProof.degradedState !== 'gpu-hmr-unknown-arg-provenance'
  ) {
    throw new Error('runtime dispatch/output proof classifier failed');
  }
  const hostReplacedProof = classifyGpuHmrHostPreservationProof({
    hostRestartObserved: true,
  });
  const hostUnprovenProof = classifyGpuHmrHostPreservationProof({});
  const abiMetadataOnlyProof = classifyGpuHmrAbiProof({
    metadataObserved: true,
    evidenceRefs: ['evidence:device-abi-metadata:test'],
  });
  const selfCheckSourceProof = {
    schemaVersion: 'synthi.gpu.hmr.source_proof.v1',
    resultState: 'gpu-hmr-symbol-bound',
    compileEvidenceObserved: true,
    compileProven: true,
    symbolBindingEvidenceObserved: true,
    symbolBindingProven: true,
    sourceProofProven: true,
    proofArtifactPaths: ['.synthi/gpu-hmr/proofs/self-check.json'],
    evidenceRefs: [
      'evidence:source:device-artifact',
      'evidence:source:device-compiler',
      'evidence:source:device-symbols',
    ],
    compileEvidenceRefs: [
      'evidence:source:device-artifact',
      'evidence:source:device-compiler',
    ],
    symbolEvidenceRefs: ['evidence:source:device-symbols'],
  };
  const fullRuntimeBlockedProof = classifyGpuHmrFullRuntimeProof({
    sourceProofs: [selfCheckSourceProof],
    abiProof: abiMetadataOnlyProof,
    dispatchProof: classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: ['worker-log:synthi_gpu_launch:runtime-session:self-check:kernel'],
      sessionScoped: true,
      runtimeSessionIds: ['runtime-session:self-check'],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
    }),
    outputProof: visualOnlyProof,
    hostPreservationProof: classifyGpuHmrHostPreservationProof({ identityChecksPassed: true }),
  });
  if (
    hostReplacedProof.degradedState !== 'gpu-hmr-host-replaced'
    || hostUnprovenProof.degradedReason !== 'host_identity_checks_not_collected'
    || fullRuntimeBlockedProof.degradedState !== 'gpu-hmr-abi-unverified'
    || fullRuntimeBlockedProof.degradedReason !== 'abi_layout_size_alignment_unverified'
  ) {
    throw new Error('host preservation proof classifier failed');
  }
  if (shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: true })) {
    throw new Error('fetch decision self-check should reuse a locally available requested commit');
  }
  if (!shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should fetch an unavailable requested commit');
  }
  if (shouldFetchRequestedCommit({ requestedCommit: '', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should not fetch without a requested commit');
  }
  if (!buildMetadataCoversSource('src/kernel.h', {
    compileCommandSourcePaths: ['src/main.cpp'],
    targetSourcePaths: ['src/kernel.h'],
  })) {
    throw new Error('CMake metadata coverage self-check should accept target header sources');
  }
  if (buildMetadataCoversSource('src/missing.h', {
    compileCommandSourcePaths: ['src/main.cpp'],
    targetSourcePaths: ['src/kernel.h'],
  })) {
    throw new Error('CMake metadata coverage self-check should reject unrelated sources');
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
  const {
    scopedWorkerLogs,
    scopedWorkerEvidence,
    upstreamRunEvidence,
    runtimeEvidence: workerEvidence,
  } = runtimeEvidenceFromValidationLogs({
    workerLogs,
    upstreamRunLog: report.logs.upstream_run,
    slug: CFG.slug,
  });
  const runtimeScope = runtimeEvidenceScope(scopedWorkerLogs, upstreamRunEvidence);
  const unscopedWorkerEvidence = evidenceLines(
    workerLogs,
    RUNTIME_EVIDENCE_PATTERN,
  );
  const aiEvidence = evidenceLines(
    aiLogs,
    /Calling API|mode=delta|mode=split|verifier rejected|POST \/refactor\/(?:split(?:\/verified|\/gpu)?|diff_patch(?:\/gpu)?|heal)/i,
  );
  const genericDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch(?!\/gpu)/i);
  const gpuDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch\/gpu/i);
  const compileHealCalls = countMatches(aiEvidence, /POST \/refactor\/heal/i);
  const splitCalls = countAiSplitEvidenceLines(aiEvidence);
  const runtimeDispatch = runtimeDispatchEvidence(workerEvidence);
  const runtimeNativeLaunchObservation = runtimeNativeLaunchObservationEvidence(workerEvidence);
  const runtimeArgProvenance = runtimeArgProvenanceEvidence(workerEvidence);
  const runtimeSession = runtimeSessionEvidence(workerEvidence);
  const runtimeArtifactTransport = runtimeArtifactTransportEvidence(workerEvidence, {
    runtimeSessionIds: runtimeSession.unique_ids,
  });
  const runtimeOwnership = runtimeOwnershipEvidence(workerEvidence);
  const runtimeEpochSwap = epochSwapProofFromRuntimeEvidence(workerEvidence);
  const runtimeOutputOracle = runtimeOutputOracleEvidence(workerEvidence, {
    outputOracleContract: CFG.outputOracleContract,
    runtimeSessionIds: runtimeSession.unique_ids,
  });
  const hostRestartCount = countMatches(workerEvidence, /Restarting runner/i);
  const runtimeIdentityChanges = runtimeIdentityChangeEvidence();
  const runtimeHostPreservation = hostPreservationProofFromRuntimeEvidence(workerEvidence, {
    hostRestartObserved: hostRestartCount > 0 || runtimeIdentityChanges.changed_count > 0,
    hostReplacementObserved: runtimeOwnership.primary_replacement_count > 0,
    runtimeSessionIds: runtimeSession.unique_ids,
    identityEvidenceRefs: runtimeIdentityChanges.evidence_refs,
    epochProof: runtimeEpochSwap.proof,
  });
  const upstreamGpuRunPhase = report.phases
    .filter((phase) => phase?.name === 'upstream_gpu_build_run')
    .at(-1) ?? null;
  const upstreamRunExitCode = Number.isInteger(upstreamGpuRunPhase?.upstream_run_exit_code)
    ? upstreamGpuRunPhase.upstream_run_exit_code
    : null;
  const runtimeOriginalHostPath = originalHostPathProofFromRuntimeEvidence(workerEvidence, {
    required: CFG.requireOriginalHostPath,
    runtimeSessionIds: runtimeSession.unique_ids,
    nativeLaunchObserverEnabled: CFG.nativeLaunchObserver,
    upstreamRunAttempted: CFG.runUpstream,
    upstreamRunExitCode,
  });
  report.evidence = {
    worker_log_lines: workerEvidence,
    worker_service_log_lines: scopedWorkerEvidence,
    upstream_run_log_lines: upstreamRunEvidence,
    worker_log_lines_unscoped_tail: unscopedWorkerEvidence.slice(-50),
    worker_session_scope: {
      slug: CFG.slug,
      marker_found: scopedWorkerLogs.marker_found,
      marker_kind: scopedWorkerLogs.marker_kind,
      dropped_before: scopedWorkerLogs.dropped_before,
      stopped_before: scopedWorkerLogs.stopped_before,
      stop_marker_found: scopedWorkerLogs.stop_marker_found,
      stale_runtime_lines_dropped: scopedWorkerLogs.stale_runtime_lines_dropped,
      total_lines: scopedWorkerLogs.total_lines,
      runtime_evidence_scope_observed: runtimeScope.observed,
      runtime_evidence_scope_kinds: runtimeScope.scopeKinds,
      upstream_run_evidence_observed: runtimeScope.upstreamRunEvidenceObserved,
    },
    ai_engine_log_lines: aiEvidence,
    ai_call_counts: {
      split: splitCalls,
      generic_delta: genericDeltaCalls,
      gpu_delta: gpuDeltaCalls,
      total_delta: genericDeltaCalls + gpuDeltaCalls,
      compile_heal: compileHealCalls,
      model_delta_mode: countMatches(aiEvidence, /mode=delta/i),
    },
    runner_policy_counts: {
      existing_reload_blocked: countMatches(workerEvidence, /reload_policy_allow_existing=false/i),
      runner_restarts: hostRestartCount,
      runner_exit_errors: countMatches(workerEvidence, /Runner process exited|Rust cannot catch|fatal runtime/i),
      primary_replacements: runtimeOwnership.primary_replacement_count,
    },
    runtime_dispatch: runtimeDispatch,
    runtime_native_launch_observation: runtimeNativeLaunchObservation,
    runtime_arg_provenance: runtimeArgProvenance,
    runtime_session: runtimeSession,
    runtime_artifact_transport: runtimeArtifactTransport,
    runtime_ownership: runtimeOwnership,
    runtime_epoch_swap: runtimeEpochSwap.evidence,
    runtime_output_oracle: runtimeOutputOracle,
    runtime_host_identity: runtimeHostPreservation.evidence,
    runtime_original_host_path: runtimeOriginalHostPath.evidence,
    runtime_identity_changes: runtimeIdentityChanges,
  };
  report.evidence.ai_split_provenance = classifyFreshAiSplitProvenance({
    required: CFG.requireFreshAiSplit,
    model: CFG.geminiModel,
    aiCallCounts: report.evidence.ai_call_counts,
    evidenceLines: aiEvidence,
  });
  if (CFG.requireFreshAiSplit) {
    const provenance = report.evidence.ai_split_provenance;
    record(
      'fresh AI split provenance',
      provenance.observed ? 'pass' : 'fail',
      `model=${provenance.model ?? 'unspecified'} split_calls=${provenance.splitCallCount}`,
    );
    if (!provenance.observed) process.exitCode = 1;
  }
  if (upstreamRunEvidence.length > 0) {
    record('runtime original host run evidence', 'pass', `lines=${upstreamRunEvidence.length}`);
  }
  if (runtimeDispatch.failure_count > 0) {
    record(
      'runtime dispatch failures',
      'fail',
      runtimeDispatch.failure_lines.slice(0, 3).join(' | ').slice(0, 1200),
    );
    process.exitCode = 1;
  } else if (runtimeDispatch.success_count > 0 && runtimeScope.observed) {
    record(
      'runtime dispatch successes',
      'pass',
      `dispatch_ok=${runtimeDispatch.success_count} scope=${runtimeScope.scopeKinds.join(',')}`,
    );
  } else if (!runtimeScope.observed) {
    record('runtime dispatch evidence', 'warn', `no runtime evidence scope captured for slug=${CFG.slug}`);
  } else {
    record('runtime dispatch evidence', 'warn', 'no synthi_gpu_launch dispatch lines captured');
  }
  if (runtimeNativeLaunchObservation.total_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `observe_only=${runtimeNativeLaunchObservation.observe_only_count} apis=${runtimeNativeLaunchObservation.apis.join(',') || 'unknown'}`,
    );
  } else if (CFG.nativeLaunchObserver && CFG.runUpstream) {
    record(
      'runtime native launch observation',
      'warn',
      'native launch observer enabled but no native_launch_observed lines captured',
    );
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
  if (runtimeSession.record_count > 0) {
    record(
      'runtime session provenance',
      runtimeSession.consistent ? 'pass' : 'warn',
      `records=${runtimeSession.record_count} ids=${runtimeSession.unique_ids.join(',')}`,
    );
  } else {
    record('runtime session provenance', 'warn', 'no runtime_session launch evidence captured');
  }
  if (runtimeArtifactTransport.total_count > 0) {
    record(
      'runtime artifact transport evidence',
      runtimeArtifactTransport.ram_transport_proven ? 'pass' : 'warn',
      `records=${runtimeArtifactTransport.total_count} matched=${runtimeArtifactTransport.matched_count} loader=${runtimeArtifactTransport.loader_transports.join(',') || 'unknown'} ram_reference=${runtimeArtifactTransport.ram_artifact_reference_provided}`,
    );
  } else {
    record('runtime artifact transport evidence', 'warn', 'no artifact_transport lines captured');
  }
  if (runtimeEpochSwap.evidence.total_count > 0) {
    record(
      'runtime epoch swap evidence',
      runtimeEpochSwap.proof.degradedState ? 'warn' : 'pass',
      `published=${runtimeEpochSwap.evidence.published_count} retired=${runtimeEpochSwap.evidence.retired_count} stream_ordering=${runtimeEpochSwap.evidence.stream_ordering_proven}`,
    );
  } else {
    record('runtime epoch swap evidence', 'warn', 'no dispatcher_epoch lines captured');
  }
  if (runtimeOutputOracle.total_count > 0) {
    record(
      'runtime output oracle evidence',
      runtimeOutputOracle.deterministic_oracle_passed ? 'pass' : 'warn',
      `records=${runtimeOutputOracle.total_count} matched=${runtimeOutputOracle.matched_count} passed=${runtimeOutputOracle.passed_count} failed=${runtimeOutputOracle.failed_count} latest=${runtimeOutputOracle.latest?.oracleId ?? 'none'}`,
    );
  } else {
    record('runtime output oracle evidence', 'warn', 'no output_oracle lines captured');
  }
  if (runtimeHostPreservation.evidence.total_count > 0) {
    record(
      'runtime host identity evidence',
      runtimeHostPreservation.proof.degradedState || !runtimeHostPreservation.proof.resultState ? 'warn' : 'pass',
      `records=${runtimeHostPreservation.evidence.total_count} preserved_roles=${runtimeHostPreservation.evidence.preserved_roles.join(',') || 'none'} changed_roles=${runtimeHostPreservation.evidence.changed_roles.join(',') || 'none'}`,
    );
  } else {
    record('runtime host identity evidence', 'warn', 'no host_identity lines captured');
  }
  if (
    runtimeOriginalHostPath.evidence.raw_count > 0
    || runtimeOriginalHostPath.evidence.candidate_count > 0
  ) {
    record(
      'runtime original host path evidence',
      runtimeOriginalHostPath.proof.degradedState ? 'warn' : 'pass',
      `records=${runtimeOriginalHostPath.evidence.total_count} raw=${runtimeOriginalHostPath.evidence.raw_count} candidates=${runtimeOriginalHostPath.evidence.candidate_count} required=${CFG.requireOriginalHostPath}`,
    );
  } else {
    record(
      'runtime original host path evidence',
      CFG.requireOriginalHostPath ? 'warn' : 'skip',
      CFG.requireOriginalHostPath
        ? 'no original_host_path attachment lines captured'
        : 'original host path attachment not required by this validation',
    );
  }
  const proofArtifactRecords = await collectGpuProofArtifacts();
  const selectedArtifactIds = selectedArtifactIdsFromProofArtifacts(proofArtifactRecords);
  report.evidence.selected_artifact_ids = selectedArtifactIds;
  report.evidence.runtime_dispatch.runtime_artifact_matches_selected =
    runtimeArtifactMatchesSelected({ runtimeDispatch, selectedArtifactIds });
  const foundProofArtifactCount = proofArtifactRecords.filter((entry) => entry?.found).length;
  const abiMetadataEvidenceCount = proofArtifactRecords.reduce((count, entry) => {
    const refs = Array.isArray(entry?.artifact?.evidenceRefs) ? entry.artifact.evidenceRefs : [];
    return count + refs.filter((evidence) => evidence?.kind === 'device-abi-metadata').length;
  }, 0);
  record(
    'proof artifact collection',
    foundProofArtifactCount > 0 ? 'pass' : 'warn',
    `found=${foundProofArtifactCount}/${proofArtifactRecords.length} abi_metadata=${abiMetadataEvidenceCount}`,
  );
  const freshVisualFrames = visualEvidenceFrames();
  report.source_proof = sourceProofFromProofArtifacts(
    proofArtifactRecords,
    report.phases.map((phase) => phase.gpu_proof).filter(Boolean).at(-1) ?? null,
  );
  report.source_proofs = [report.source_proof].filter(Boolean);
  report.abi_proof = abiProofFromProofArtifacts(proofArtifactRecords);
  report.fission_proof = fissionProofFromProofArtifacts(proofArtifactRecords);
  report.artifact_transport_proof = artifactTransportProofFromProofArtifacts(
    proofArtifactRecords,
    runtimeArtifactTransport,
  );
  report.epoch_swap_proof = runtimeEpochSwap.proof;
  report.dispatch_proof = classifyGpuHmrDispatchProof({
    dispatchObserved: runtimeDispatch.success_count > 0 && runtimeScope.observed,
    sessionScoped: runtimeScope.observed && runtimeSession.record_count > 0,
    runtimeSessionIds: runtimeSession.unique_ids,
    runtimeSessionConsistent: runtimeSession.record_count === 0 ? true : runtimeSession.consistent,
    argProvenanceObserved: runtimeArgProvenance.total_count > 0,
    argProvenanceComplete: runtimeArgProvenance.total_count > 0
      && runtimeArgProvenance.incomplete_count === 0
      && runtimeArgProvenance.unknown_arg_count === 0,
    argProvenanceEvidenceRefs: runtimeArgProvenance.evidence_refs,
    dispatchEvidenceRefs: runtimeDispatch.evidence_refs,
    argProvenanceRecords: runtimeArgProvenance.records,
    argProvenanceRecordComplete: runtimeArgProvenance.record_complete,
    argProvenanceKnownArgCount: runtimeArgProvenance.known_arg_count,
    unknownArgCount: runtimeArgProvenance.unknown_arg_count,
    abiProof: report.abi_proof,
    epochProof: report.epoch_swap_proof,
    streamOrderingProven: runtimeEpochSwap.evidence.stream_ordering_proven,
    replacementScopeProven: runtimeOwnership.scope_proven_count > 0,
    selectedArtifactIds,
    runtimeArtifactIds: runtimeDispatch.runtime_artifact_ids,
    dispatcherRegistrationIds: runtimeDispatch.dispatcher_registration_ids,
    dispatchTableEntryIds: runtimeDispatch.dispatch_table_entry_ids,
    dispatchTableHashes: runtimeDispatch.dispatch_table_hashes,
    dispatchStreamIds: runtimeDispatch.dispatch_stream_ids,
    gridDimensions: runtimeDispatch.grid_dimensions,
    blockDimensions: runtimeDispatch.block_dimensions,
    sharedMemoryBytes: runtimeDispatch.shared_memory_bytes,
    dispatchTimestamps: runtimeDispatch.dispatch_timestamps,
    runtimeArtifactMatchesSelected: report.evidence.runtime_dispatch.runtime_artifact_matches_selected,
  });
  report.output_proof = classifyGpuHmrOutputProof({
    dispatchProof: report.dispatch_proof,
    deterministicOutputObserved: runtimeOutputOracle.deterministic_output_observed,
    deterministicOracleProvided: runtimeOutputOracle.deterministic_oracle_provided,
    deterministicOraclePassed: runtimeOutputOracle.deterministic_oracle_passed,
    outputOracle: runtimeOutputOracle.output_oracle ?? undefined,
    evidenceRefs: runtimeOutputOracle.evidence_refs,
    visualFrameObserved: freshVisualFrames.length > 0,
    visualEvidenceRefs: freshVisualFrames.map((shot) => shot.path),
  });
  report.host_preservation_proof = runtimeHostPreservation.proof;
  report.original_host_path_proof = runtimeOriginalHostPath.proof;
  report.full_runtime_proof = classifyGpuHmrFullRuntimeProof({
    sourceProofs: report.source_proofs,
    fissionProof: report.fission_proof,
    abiProof: report.abi_proof,
    artifactTransportProof: report.artifact_transport_proof,
    epochProof: report.epoch_swap_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
  });
  record(
    'runtime source proof',
    report.source_proof.resultState ? 'pass' : 'warn',
    summarizeGpuHmrSourceProof(report.source_proof),
  );
  record(
    'runtime ABI proof',
    report.abi_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrAbiProof(report.abi_proof),
  );
  record(
    'runtime fission proof',
    report.fission_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrFissionProof(report.fission_proof),
  );
  record(
    'runtime artifact transport proof',
    report.artifact_transport_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrArtifactTransportProof(report.artifact_transport_proof),
  );
  record(
    'runtime epoch swap proof',
    report.epoch_swap_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrEpochSwapProof(report.epoch_swap_proof),
  );
  record(
    'runtime dispatch proof',
    report.dispatch_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrDispatchProof(report.dispatch_proof),
  );
  record(
    'runtime output proof',
    report.output_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrOutputProof(report.output_proof),
  );
  record(
    'host preservation proof',
    report.host_preservation_proof.degradedState || !report.host_preservation_proof.resultState
      ? 'warn'
      : 'pass',
    summarizeGpuHmrHostPreservationProof(report.host_preservation_proof),
  );
  record(
    'original host path proof',
    report.original_host_path_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrOriginalHostPathProof(report.original_host_path_proof),
  );
  record(
    'full runtime proof ladder',
    report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
    summarizeGpuHmrFullRuntimeProof(report.full_runtime_proof),
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
    ['inspect', containerName],
    30000,
    false,
  );
  if (!raw) return { container: containerName, available: false };
  let info;
  try {
    const parsed = JSON.parse(raw);
    info = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    return {
      container: containerName,
      available: false,
      reason: 'docker_inspect_parse_failed',
      error: err.message,
    };
  }
  const state = info?.State ?? {};
  const name = info?.Name;
  return {
    container: containerName,
    name: name?.replace(/^\//, '') ?? containerName,
    id: info?.Id ?? null,
    config_image: info?.Config?.Image ?? null,
    image_id: info?.Image ?? null,
    status: state.Status ?? null,
    pid: state.Pid ?? null,
    started_at: state.StartedAt ?? null,
    finished_at: state.FinishedAt ?? null,
    restart_count: info?.RestartCount ?? null,
    oom_killed: state.OOMKilled ?? null,
    exit_code: state.ExitCode ?? null,
    available: true,
  };
}

async function writeResults() {
  report.finished_at = new Date().toISOString();
  const startedMs = Date.parse(report.started_at);
  const finishedMs = Date.parse(report.finished_at);
  report.duration_ms = Number.isFinite(startedMs) && Number.isFinite(finishedMs)
    ? Math.max(0, finishedMs - startedMs)
    : null;
  const validationContext = {
    command: report.command,
    docker: report.docker,
    containers: report.containers,
    urls: {
      frontend: CFG.frontendUrl,
      collab: CFG.collabUrl,
      signaling: CFG.signalingUrl,
    },
    model: report.model,
    gpu_vendor: report.gpu_vendor,
    gpu_arch: report.gpu_arch,
    compile_transport: report.compile_transport,
    output_oracle_contract: report.output_oracle_contract,
    render_preview_enabled: report.render_preview_enabled,
    fresh_ai_split_required: report.fresh_ai_split_required,
    timings: {
      started_at: report.started_at,
      finished_at: report.finished_at,
      duration_ms: report.duration_ms,
      phases: report.phases.map((phase) => ({
        name: phase.name,
        timings: phase.timings ?? null,
      })),
    },
    result_counts: {
      total: report.checks.length,
      passed: report.checks.filter((check) => check.status === 'pass').length,
      warned: report.checks.filter((check) => check.status === 'warn').length,
      failed: report.checks.filter((check) => check.status === 'fail').length,
      skipped: report.checks.filter((check) => check.status === 'skip').length,
    },
  };
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const runtimeProofArtifactDir = path.join(LOG_DIR, 'runtime-proof-artifacts');
  const visualArtifactPaths = visualEvidenceFrames().map((shot) => shot.path);
  if (report.full_runtime_proof) {
    const written = await writeValidationRuntimeProofArtifact(runtimeProofArtifactDir, {
      workspaceSlug: report.slug,
      runtimeSessionIds: report.dispatch_proof?.runtimeSessionIds ?? report.evidence?.runtime_session?.unique_ids ?? [],
      sourceProofs: report.source_proofs,
      fissionProof: report.fission_proof,
      abiProof: report.abi_proof,
      artifactTransportProof: report.artifact_transport_proof,
      epochProof: report.epoch_swap_proof,
      dispatchProof: report.dispatch_proof,
      outputProof: report.output_proof,
      hostPreservationProof: report.host_preservation_proof,
      originalHostPathProof: report.original_host_path_proof,
      fullRuntimeProof: report.full_runtime_proof,
      runtimeEvidence: report.evidence,
      validationContext,
      label: 'real-rocm-runtime-proof',
      visualEvidenceRefs: visualArtifactPaths,
    });
    report.runtime_proof_artifact_path = written.path;
    report.runtime_proof_artifact = {
      proofId: written.artifact.proofId,
      path: written.path,
      resultState: written.artifact.resultState,
      degradedState: written.artifact.degradedState,
      degradedReason: written.artifact.degradedReason,
      fullRuntimeProven: written.artifact.fullRuntimeProven,
      limitations: written.artifact.limitations,
    };
  }
  report.runtime_proof_artifact_paths = report.runtime_proof_artifact_path
    ? [report.runtime_proof_artifact_path]
    : [];
  report.validation_proof_summary = buildGpuHmrValidationProofSummary({
    workspaceSlug: report.slug,
    model: report.model,
    gpuVendor: report.gpu_vendor,
    gpuArch: report.gpu_arch,
    validationContext,
    docker: report.docker,
    timings: validationContext.timings,
    screenshots: report.screenshots,
    visualEvidenceExpected: CFG.expectScreenshot
      || (Number.isFinite(CFG.screenshotAttempts) && CFG.screenshotAttempts > 0),
    visualArtifactPaths,
    proof_artifacts: report.proof_artifacts,
    runtimeProofArtifactRecords: report.runtime_proof_artifact ? [report.runtime_proof_artifact] : [],
    runtimeProofArtifactPaths: report.runtime_proof_artifact_paths,
    sourceProofs: report.source_proofs,
    sourceProof: report.source_proof,
    fissionProof: report.fission_proof,
    abiProof: report.abi_proof,
    artifactTransportProof: report.artifact_transport_proof,
    epochProof: report.epoch_swap_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
    fullRuntimeProof: report.full_runtime_proof,
  });
  report.visual_artifact_paths = report.validation_proof_summary.visual_artifact_paths;
  report.visual_evidence_quality = report.validation_proof_summary.visual_evidence_quality;
  report.docker_image_ids = report.validation_proof_summary.docker_image_ids;
  report.proof_states = report.validation_proof_summary.proof_states;
  report.limitations = report.validation_proof_summary.limitations;
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
    `duration_ms: ${report.duration_ms}`,
    `containers: ${JSON.stringify(report.containers)}`,
    `docker: ${JSON.stringify(report.docker)}`,
    `runtime_identity: ${JSON.stringify(report.runtime_identity)}`,
    `command: ${JSON.stringify(report.command)}`,
    `file_count: ${report.file_count}`,
    `seeded_file_count: ${report.seeded_file_count}`,
    `skipped_file_count: ${report.skipped_file_count}`,
    `compile_transport: ${CFG.compileTransport}`,
    `compile_projection: ${JSON.stringify(report.compile_projection)}`,
    `output_oracle_contract: ${JSON.stringify(report.output_oracle_contract)}`,
    `runtime_proof_artifact: ${JSON.stringify(report.runtime_proof_artifact)}`,
    `validation_proof_summary: ${JSON.stringify(report.validation_proof_summary)}`,
    '',
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`),
    '',
    ...report.phases.map((phase) => `PHASE ${phase.name} ${JSON.stringify(phase)}`),
    '',
    ...report.phases.map((phase) => `GPU_PROOF ${phase.name} ${summarizeGpuProof(phase.gpu_proof)}`),
    '',
    ...report.screenshots.map((shot) => `SCREENSHOT ${shot.label} visible=${shot.visible_pixels} luma=${shot.mean_luma.toFixed(1)} luma_stddev=${Number(shot.luma_stddev ?? 0).toFixed(2)} rgb_span_mean=${Number(shot.rgb_span_mean ?? 0).toFixed(2)} unique_colors=${shot.unique_color_sample_count ?? 0} quality=${shot.visual_quality ?? 'gpu-hmr-visual-unmeasured'} path=${shot.path}`),
    '',
    `ABI_PROOF ${summarizeGpuHmrAbiProof(report.abi_proof)}`,
    '',
    `ARTIFACT_TRANSPORT_PROOF ${summarizeGpuHmrArtifactTransportProof(report.artifact_transport_proof)}`,
    '',
    `EPOCH_SWAP_PROOF ${summarizeGpuHmrEpochSwapProof(report.epoch_swap_proof)}`,
    '',
    `DISPATCH_PROOF ${summarizeGpuHmrDispatchProof(report.dispatch_proof)}`,
    '',
    `OUTPUT_PROOF ${summarizeGpuHmrOutputProof(report.output_proof)}`,
    '',
    `HOST_PRESERVATION_PROOF ${summarizeGpuHmrHostPreservationProof(report.host_preservation_proof)}`,
    '',
    `ORIGINAL_HOST_PATH_PROOF ${summarizeGpuHmrOriginalHostPathProof(report.original_host_path_proof)}`,
    '',
    `FULL_RUNTIME_PROOF ${summarizeGpuHmrFullRuntimeProof(report.full_runtime_proof)}`,
    '',
    `PROOF_ARTIFACTS ${JSON.stringify(report.proof_artifacts)}`,
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
    ...compileProjectionRequestArgs(firstAdditionalFiles, 'first_real_repo_ai_split_compile'),
    is_gui: CFG.renderPreview,
    use_ai_split: true,
    bypass_ai_split_cache: CFG.requireFreshAiSplit,
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
    ...compileProjectionRequestArgs(hmrAdditionalFiles, 'real_repo_user_source_delta_hmr'),
    is_gui: CFG.renderPreview,
    use_ai_split: true,
    bypass_ai_split_cache: CFG.requireFreshAiSplit,
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
      ...compileProjectionRequestArgs(additionalFiles, phaseName),
      is_gui: CFG.renderPreview,
      use_ai_split: true,
      bypass_ai_split_cache: CFG.requireFreshAiSplit,
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
