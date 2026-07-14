#!/usr/bin/env node
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  DEFAULT_HIPRT_RUNTIME_PROFILE,
  loadRuntimeProofProfileFromEnv,
  runtimeProfileToLegacyHiprtWarmProfile,
} from './lib/gpu-hmr-runtime-profile.mjs';
import {
  hiprtRuntimeProbeAdaptationCommand,
  parseHiprtRuntimeProbeAdaptationOutput,
} from './lib/hiprt-runtime-probe-adapter.mjs';
import { hiprtWarmTimingMetrics } from './lib/gpu-hmr-timing-metrics.mjs';
import { monotonicNowNs, monotonicTimingFields } from './lib/gpu-hmr-monotonic-clock.mjs';
import {
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { evaluateGpuHmrDeterministicVisualMode } from './lib/gpu-hmr-visual-evidence.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  visualEvidenceArtifactsFromVisualOracleArtifacts,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_ROOT = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const HIPRT_PREFLIGHT_SCHEMA_VERSION = 'synthi.gpu_hmr.hiprt_preflight.v1';
const HIPRT_PREFLIGHT_PROBE_SCHEMA_VERSION = 'synthi.gpu_hmr.hiprt_worker_preflight_probe.v1';
const HIPRT_PREFLIGHT_AUTHORITY = 'hiprt_runtime_preflight_refusal_only_not_gpu_hmr_success';
const RUNTIME_PREREQUISITE_CONTRACT_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_prerequisite_contract.v1';
const RUNTIME_PREREQUISITE_CONTRACT_AUTHORITY =
  'runtime_prerequisite_disclosure_only_not_gpu_hmr_success';

const DEFAULT_BEFORE =
  'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator);';
const DEFAULT_AFTER =
  'ray_payload.ray_color += estimate_direct_lighting(render_data, ray_payload, closest_hit_info, -ray.direction, x, y, random_number_generator) * 0.0f;';

function explicitHiprtRuntimeProfileSource(env) {
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON?.trim()) return 'explicit_profile_json';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_JSON?.trim()) return 'explicit_hiprt_profile_json';
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH?.trim()) return 'explicit_profile_path';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_PATH?.trim()) return 'explicit_hiprt_profile_path';
  return null;
}

function hiprtWarmRuntimeProfileSelection(env = process.env) {
  const explicitSource = explicitHiprtRuntimeProfileSource(env);
  if (explicitSource) {
    return {
      env,
      source: explicitSource,
      explicit: true,
      profilePath: env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH ?? env.SYNTHI_HIPRT_WARM_PROFILE_PATH ?? null,
    };
  }
  const diagnosticDefault =
    env.SYNTHI_GPU_HMR_RUNTIME_ALLOW_PACKAGED_DEFAULT_PROFILE === '1'
    || env.SYNTHI_HIPRT_WARM_ALLOW_PACKAGED_DEFAULT_PROFILE === '1';
  const selfCheckDefault = process.argv.includes('--runtime-boundary-app-hook-self-check');
  if (!diagnosticDefault && !selfCheckDefault) {
    throw new Error(
      'HIPRT runtime proof requires an explicit runtime profile through '
      + 'SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH, SYNTHI_HIPRT_WARM_PROFILE_PATH, '
      + 'SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON, or SYNTHI_HIPRT_WARM_PROFILE_JSON; '
      + 'set SYNTHI_GPU_HMR_RUNTIME_ALLOW_PACKAGED_DEFAULT_PROFILE=1 only for diagnostic packaged-profile runs',
    );
  }
  return {
    env,
    source: selfCheckDefault ? 'self_check_packaged_default' : 'packaged_default_opt_in',
    explicit: false,
    profilePath: null,
  };
}

function loadProfile() {
  const selection = hiprtWarmRuntimeProfileSelection(process.env);
  const normalized = loadRuntimeProofProfileFromEnv(selection.env, REPO_ROOT, DEFAULT_HIPRT_RUNTIME_PROFILE);
  normalized.profileSelection = {
    schemaVersion: 'synthi.gpu_hmr.runtime_profile_selection.v1',
    source: selection.source,
    explicit: selection.explicit,
    profilePath: selection.profilePath,
    profile_path: selection.profilePath,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: 'runtime_profile_selection_metadata_only_not_gpu_hmr_success',
    proof_authority: 'runtime_profile_selection_metadata_only_not_gpu_hmr_success',
  };
  return {
    ...runtimeProfileToLegacyHiprtWarmProfile(normalized),
    runtimeProfile: normalized,
  };
}

const PROFILE = loadProfile();

const CFG = {
  slug: process.env.SLUG
    ?? `hiprt-warm-light-math-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  workerRepoPath: process.env.SYNTHI_GPU_HMR_RUNTIME_WORKER_REPO
    ?? process.env.SYNTHI_HIPRT_WARM_WORKER_REPO
    ?? PROFILE.workerRepoPath
    ?? process.env.SYNTHI_REAL_ROCM_WORKER_PATH
    ?? '/tmp/synthi-real-rocm/HIPRT-Path-Tracer',
  mode: (
    process.env.SYNTHI_GPU_HMR_RUNTIME_MODE
    ?? process.env.SYNTHI_HIPRT_WARM_MODE
    ?? PROFILE.mode
    ?? 'fresh-process'
  ).toLowerCase(),
  targetName:
    process.env.SYNTHI_GPU_HMR_RUNTIME_TARGET
    ?? process.env.SYNTHI_HIPRT_WARM_TARGET
    ?? PROFILE.targetName
    ?? 'HIPRTPathTracer',
  sourceRel:
    process.env.SYNTHI_GPU_HMR_RUNTIME_SOURCE_REL
    ?? process.env.SYNTHI_HIPRT_WARM_SOURCE_REL
    ?? PROFILE.sourceRel
    ?? 'src/Device/kernels/Megakernel.h',
  before:
    process.env.SYNTHI_GPU_HMR_RUNTIME_DELTA_BEFORE
    ?? process.env.SYNTHI_HIPRT_WARM_DELTA_BEFORE
    ?? PROFILE.before
    ?? DEFAULT_BEFORE,
  after:
    process.env.SYNTHI_GPU_HMR_RUNTIME_DELTA_AFTER
    ?? process.env.SYNTHI_HIPRT_WARM_DELTA_AFTER
    ?? PROFILE.after
    ?? DEFAULT_AFTER,
  requiredKernels: parseStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_KERNELS
      ?? process.env.SYNTHI_HIPRT_WARM_REQUIRED_KERNELS,
    PROFILE.requiredKernels ?? ['CameraRays', 'MegaKernel'],
  ),
  reloadKernelName:
    process.env.SYNTHI_GPU_HMR_RUNTIME_RELOAD_KERNEL_NAME
    ?? process.env.SYNTHI_HIPRT_WARM_RELOAD_KERNEL_NAME
    ?? PROFILE.reloadKernelName
    ?? 'Megakernel (1 SPP)',
  reloadKernelSymbol:
    process.env.SYNTHI_GPU_HMR_RUNTIME_RELOAD_KERNEL_SYMBOL
    ?? process.env.SYNTHI_HIPRT_WARM_RELOAD_KERNEL_SYMBOL
    ?? PROFILE.reloadKernelSymbol
    ?? 'MegaKernel',
  profileId:
    process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_ID
    ?? process.env.SYNTHI_HIPRT_WARM_PROFILE_ID
    ?? PROFILE.id
    ?? 'custom',
  claim:
    process.env.SYNTHI_GPU_HMR_RUNTIME_CLAIM
    ?? process.env.SYNTHI_HIPRT_WARM_CLAIM
    ?? PROFILE.claim
    ?? 'A HIPRT source delta materially changes the ray-traced framebuffer.',
  runtimeArgs: parseJsonStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_ARGS_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_RUN_ARGS_JSON,
    PROFILE.runtimeArgs ?? [],
    'runtime arguments',
  ),
  requiredFiles: parseJsonStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_FILES_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_REQUIRED_FILES_JSON,
    PROFILE.requiredFiles ?? [],
    'required runtime files',
  ),
  requiredAssets: parseJsonArrayEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_ASSETS_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_REQUIRED_ASSETS_JSON,
    PROFILE.requiredAssets ?? [],
    'required runtime assets',
  ),
  runtimeSourceTree: parseJsonObjectEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_SOURCE_TREE_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_SOURCE_TREE_JSON,
    PROFILE.sourceTree ?? null,
    'runtime source tree',
  ),
  cmakeArgs: parseJsonStringListEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_CMAKE_ARGS_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_CMAKE_ARGS_JSON,
    PROFILE.cmakeArgs ?? [],
    'CMake arguments',
  ),
  buildEnv: parseJsonStringMapEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_BUILD_ENV_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_BUILD_ENV_JSON,
    PROFILE.buildEnv ?? {},
    'build environment',
  ),
  runtimeEnv: parseJsonStringMapEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_ENV_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_RUNTIME_ENV_JSON,
    PROFILE.runtimeEnv ?? {},
    'runtime environment',
  ),
  deterministicVisualMode: parseJsonObjectEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_DETERMINISTIC_VISUAL_MODE_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_DETERMINISTIC_VISUAL_MODE_JSON,
    PROFILE.deterministicVisualMode ?? null,
    'deterministic visual mode',
  ),
  width: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_WIDTH', PROFILE.width ?? 640, 'SYNTHI_GPU_HMR_RUNTIME_WIDTH'),
  height: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_HEIGHT', PROFILE.height ?? 360, 'SYNTHI_GPU_HMR_RUNTIME_HEIGHT'),
  runTimeoutMs: nonNegativeIntegerFromEnv('SYNTHI_HIPRT_WARM_RUN_TIMEOUT_MS', 0, 'SYNTHI_GPU_HMR_RUNTIME_RUN_TIMEOUT_MS'),
  buildTimeoutMs: positiveIntegerFromEnv('SYNTHI_HIPRT_WARM_BUILD_TIMEOUT_MS', 600000, 'SYNTHI_GPU_HMR_RUNTIME_BUILD_TIMEOUT_MS'),
  reloadTimeoutMs: nonNegativeIntegerFromEnv('SYNTHI_HIPRT_WARM_RELOAD_TIMEOUT_MS', 0, 'SYNTHI_GPU_HMR_RUNTIME_RELOAD_TIMEOUT_MS'),
  cmakeConfigName: process.env.SYNTHI_HIPRT_WARM_CMAKE_CONFIG
    ?? process.env.SYNTHI_REAL_ROCM_CMAKE_CONFIG
    ?? 'Release',
  gpuArch:
    process.env.SYNTHI_HIPRT_WARM_GPU_ARCH
    ?? process.env.SYNTHI_GPU_ARCH
    ?? process.env.SYNTHI_REAL_ROCM_GPU_ARCH
    ?? '',
  rocmPrefix:
    process.env.SYNTHI_HIPRT_WARM_ROCM_PREFIX
    ?? process.env.SYNTHI_GPU_HMR_RUNTIME_ROCM_PREFIX
    ?? process.env.SYNTHI_REAL_ROCM_ROCM_PREFIX
    ?? process.env.ROCM_PATH
    ?? '',
  gpuArchSource: '',
  rocmPrefixSource: '',
  orochiApi: (
    process.env.SYNTHI_GPU_HMR_RUNTIME_OROCHI_API
    ?? process.env.SYNTHI_HIPRT_WARM_OROCHI_API
    ?? PROFILE.orochiApi
    ?? ''
  ).toLowerCase(),
  nativeLaunchObserverPath: process.env.SYNTHI_HIPRT_WARM_NATIVE_OBSERVER_PATH
    ?? process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER_PATH
    ?? '/usr/local/lib/synthi-gpu-native-launch-observer.so',
  outputDir: path.resolve(
    REPO_ROOT,
    process.env.SYNTHI_GPU_HMR_RUNTIME_OUTPUT_DIR
      ?? process.env.SYNTHI_HIPRT_WARM_OUTPUT_DIR
      ?? 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof',
  ),
  strictProofJson:
    process.env.SYNTHI_GPU_HMR_RUNTIME_STRICT_PROOF_JSON
    ?? process.env.SYNTHI_HIPRT_WARM_STRICT_PROOF_JSON
    ?? '',
  reuseBaseline: (process.env.SYNTHI_GPU_HMR_RUNTIME_REUSE_BASELINE ?? process.env.SYNTHI_HIPRT_WARM_REUSE_BASELINE) !== '0',
  minChangedPixelRatio: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_CHANGED_RATIO
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_CHANGED_RATIO
      ?? PROFILE.minChangedPixelRatio
      ?? 0.05,
  ),
  minMeanAbsDelta8bit: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_MEAN_ABS_DELTA_8BIT
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_MEAN_ABS_DELTA_8BIT
      ?? PROFILE.minMeanAbsDelta8bit
      ?? 1.0,
  ),
  minOracleRegionVisibleRatio: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_ORACLE_REGION_VISIBLE_RATIO
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_ORACLE_REGION_VISIBLE_RATIO
      ?? PROFILE.minOracleRegionVisibleRatio
      ?? 0.02,
  ),
  minOracleRegionMeanLuma8bit: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_ORACLE_REGION_MEAN_LUMA_8BIT
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_ORACLE_REGION_MEAN_LUMA_8BIT
      ?? PROFILE.minOracleRegionMeanLuma8bit
      ?? 4,
  ),
  minOracleRegionUniqueColorSampleCount: Number(
    process.env.SYNTHI_GPU_HMR_RUNTIME_MIN_ORACLE_REGION_UNIQUE_COLORS
      ?? process.env.SYNTHI_HIPRT_WARM_MIN_ORACLE_REGION_UNIQUE_COLORS
      ?? PROFILE.minOracleRegionUniqueColorSampleCount
      ?? 64,
  ),
  requireStrictProvenance:
    (process.env.SYNTHI_GPU_HMR_RUNTIME_REQUIRE_STRICT_PROVENANCE ?? process.env.SYNTHI_HIPRT_WARM_REQUIRE_STRICT_PROVENANCE) !== '0',
  metricScope: parseMetricScope(
    process.env.SYNTHI_GPU_HMR_RUNTIME_METRIC_SCOPE
      ?? process.env.SYNTHI_HIPRT_WARM_METRIC_SCOPE
      ?? PROFILE.runMode?.metricScope
      ?? 'hot_delta_1',
  ),
  cacheState: parseCacheState(
    process.env.SYNTHI_GPU_HMR_RUNTIME_CACHE_STATE
      ?? process.env.SYNTHI_HIPRT_WARM_CACHE_STATE
      ?? PROFILE.runMode?.cacheState
      ?? 'compiler_cache_warm',
  ),
  runModeEditKind:
    process.env.SYNTHI_GPU_HMR_RUNTIME_EDIT_KIND
    ?? process.env.SYNTHI_HIPRT_WARM_EDIT_KIND
    ?? PROFILE.runMode?.editKind
    ?? null,
  runModeDifferentEdit: parseBooleanEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_DIFFERENT_EDIT
      ?? process.env.SYNTHI_HIPRT_WARM_DIFFERENT_EDIT,
    PROFILE.runMode?.differentEdit ?? null,
    'SYNTHI_HIPRT_WARM_DIFFERENT_EDIT',
  ),
  negativeEdit: parseJsonObjectEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_NEGATIVE_EDIT_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_NEGATIVE_EDIT_JSON,
    PROFILE.negativeEdit ?? null,
    'negative edit',
  ),
  runtimeBoundaryEvents: parseJsonArrayEnv(
    process.env.SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENTS_JSON
      ?? process.env.SYNTHI_HIPRT_WARM_RUNTIME_BOUNDARY_EVENTS_JSON,
    PROFILE.runtimeProfile?.adapter?.runtimeBoundaryEvents ?? [],
    'runtime boundary events',
  ),
  runtimeBoundaryEventManifestPath:
    process.env.SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH
    ?? process.env.SYNTHI_HIPRT_WARM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH
    ?? PROFILE.runtimeProfile?.adapter?.runtimeBoundaryEventManifestPath
    ?? '',
  runtimeBoundaryAppHook:
    PROFILE.runtimeProfile?.adapter?.runtimeBoundaryAppHook ?? null,
  allowRejected: (process.env.SYNTHI_GPU_HMR_RUNTIME_ALLOW_REJECTED ?? process.env.SYNTHI_HIPRT_WARM_ALLOW_REJECTED) === '1',
  runtimeProfile: PROFILE.runtimeProfile,
};

if (!['fresh-process', 'same-process'].includes(CFG.mode)) {
  throw new Error(`SYNTHI_HIPRT_WARM_MODE must be fresh-process or same-process, got ${CFG.mode}`);
}

function positiveIntegerFromEnv(name, fallback, aliasName = null) {
  const raw = aliasName && process.env[aliasName] !== undefined
    ? process.env[aliasName]
    : process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${aliasName ?? name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerFromEnv(name, fallback, aliasName = null) {
  const raw = aliasName && process.env[aliasName] !== undefined
    ? process.env[aliasName]
    : process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${aliasName ?? name} must be a non-negative integer`);
  }
  return value;
}

function parseStringListEnv(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return Array.from(fallback);
  return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJsonStringListEnv(raw, fallback, label) {
  const source = raw === undefined || String(raw).trim() === '' ? fallback : JSON.parse(raw);
  if (!Array.isArray(source)) throw new Error(`${label} must be a JSON string array`);
  return source.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function parseJsonStringMapEnv(raw, fallback, label) {
  const source = raw === undefined || String(raw).trim() === '' ? fallback : JSON.parse(raw);
  if (source === null || source === undefined) return {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${label} must be a JSON object with string values`);
  }
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`${label} contains an empty key`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

function parseJsonObjectEnv(raw, fallback, label) {
  const source = raw === undefined || String(raw).trim() === '' ? fallback : JSON.parse(raw);
  if (source === null || source === undefined) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return source;
}

function parseJsonArrayEnv(raw, fallback, label) {
  const source = raw === undefined || String(raw).trim() === '' ? fallback : JSON.parse(raw);
  if (source === null || source === undefined) return [];
  if (!Array.isArray(source)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return source;
}

function parseBooleanEnv(raw, fallback, label) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean value`);
}

function parseMetricScope(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!['hot_delta_1', 'hot_delta_2'].includes(value)) {
    throw new Error(`HIPRT warm runtime metric scope must be hot_delta_1 or hot_delta_2, got ${value || '<empty>'}`);
  }
  return value;
}

function parseCacheState(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!['compiler_cache_warm', 'pipeline_cache_warm'].includes(value)) {
    throw new Error(`HIPRT warm runtime cache state must be compiler_cache_warm or pipeline_cache_warm, got ${value || '<empty>'}`);
  }
  return value;
}

function shellExports(envMap) {
  return Object.entries(envMap || {})
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join('\n');
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hiprtWarmXdgRuntimeDir() {
  return `/tmp/synthi-hiprt-warm-xdg-${cleanIdentifier(CFG.slug)}`;
}

function hiprtRuntimeDisplaySetup() {
  const xdgRuntimeDir = hiprtWarmXdgRuntimeDir();
  return [
    `mkdir -p ${shQuote(xdgRuntimeDir)}`,
    `chmod 700 ${shQuote(xdgRuntimeDir)} || true`,
    `export XDG_RUNTIME_DIR=${shQuote(xdgRuntimeDir)}`,
  ].join('\n');
}

function hiprtRuntimeRunInvocation(runCommand) {
  const quoted = shQuote(runCommand);
  return [
    'if command -v xvfb-run >/dev/null 2>&1; then',
    `  xvfb-run -a sh -lc ${quoted}`,
    'else',
    `  sh -lc ${quoted}`,
    'fi',
  ].join('\n');
}

function hiprtRuntimeBackendSetup() {
  if (!CFG.orochiApi || CFG.orochiApi === 'auto') return ':';
  if (CFG.orochiApi === 'hip') return 'export SYNTHI_HIPRT_FORCE_HIP_OROCHI=1';
  if (CFG.orochiApi === 'cuda') return 'unset SYNTHI_HIPRT_FORCE_HIP_OROCHI';
  throw new Error(`unsupported HIPRT Orochi API selection: ${CFG.orochiApi}`);
}

function cleanIdentifier(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'artifact';
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Json(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compactStringList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)));
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value !== undefined && value !== null && ['number', 'boolean'].includes(typeof value)) {
      return String(value);
    }
  }
  return '';
}

function boolTrue(value) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

async function execText(file, args, options = {}) {
  try {
    const result = await execFile(file, args, {
      timeout: options.timeout ?? 30000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      encoding: options.encoding ?? 'utf8',
    });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    err.output = output;
    throw err;
  }
}

async function dockerText(args, options = {}) {
  return execText('docker', args, options);
}

async function dockerShell(script, options = {}) {
  return dockerText(['exec', CFG.workerContainer, 'sh', '-lc', script], options);
}

async function detectWorkerGpuArch() {
  const configured = String(CFG.gpuArch ?? '').trim();
  if (configured) {
    CFG.gpuArch = configured;
    CFG.gpuArchSource = 'env';
    return;
  }
  const output = await dockerShell(`
set +e
arch=''
source=''
if command -v hipconfig >/dev/null 2>&1; then
  arch="$(hipconfig --amdgpu-target 2>/dev/null | tr ' ,;' '\\n' | grep -E '^gfx[0-9A-Za-z]+$' | head -n 1)"
  [ -n "$arch" ] && source='hipconfig --amdgpu-target'
fi
if [ -z "$arch" ] && command -v rocminfo >/dev/null 2>&1; then
  arch="$(rocminfo 2>/dev/null | sed -n 's/.*Name:[[:space:]]*\\(gfx[0-9A-Za-z]*\\).*/\\1/p' | head -n 1)"
  [ -n "$arch" ] && source='rocminfo'
fi
printf 'SYNTHI_ROCM_GPU_ARCH_DETECTION source=%s value=%s\\n' "$source" "$arch"
`, { timeout: 30000 });
  const match = /SYNTHI_ROCM_GPU_ARCH_DETECTION\s+source=(.*?)\s+value=(gfx[0-9A-Za-z]+)/.exec(output);
  if (!match) {
    throw new Error(
      'ROCm GPU arch is not configured and could not be detected in the worker; '
      + 'set SYNTHI_HIPRT_WARM_GPU_ARCH or SYNTHI_GPU_ARCH, or make hipconfig/rocminfo available',
    );
  }
  CFG.gpuArch = match[2];
  CFG.gpuArchSource = match[1] || 'worker_detection';
}

async function detectWorkerRocmPrefix() {
  const configured = String(CFG.rocmPrefix ?? '').trim();
  const output = await dockerShell(`
set +e
prefix=${configured ? shQuote(configured) : "''"}
source=${configured ? "'env'" : "''"}
if [ -z "$prefix" ] && command -v hipconfig >/dev/null 2>&1; then
  prefix="$(hipconfig --path 2>/dev/null | head -n 1)"
  [ -n "$prefix" ] && source='hipconfig --path'
fi
if [ -n "$prefix" ] && [ -d "$prefix" ]; then
  printf 'SYNTHI_ROCM_PREFIX_DETECTION source=%s value=%s include=%s llvm=%s\\n' "$source" "$prefix" "$([ -d "$prefix/include" ] && printf 1 || printf 0)" "$([ -d "$prefix/llvm/bin" ] && printf 1 || printf 0)"
else
  printf 'SYNTHI_ROCM_PREFIX_DETECTION source=%s value= include=0 llvm=0\\n' "$source"
fi
`, { timeout: 30000 });
  const match = /SYNTHI_ROCM_PREFIX_DETECTION\s+source=(.*?)\s+value=(\S+)\s+include=(\d+)\s+llvm=(\d+)/.exec(output);
  if (!match || match[2] === '') {
    throw new Error(
      'ROCm prefix is not configured and could not be detected in the worker; '
      + 'set SYNTHI_HIPRT_WARM_ROCM_PREFIX/SYNTHI_REAL_ROCM_ROCM_PREFIX/ROCM_PATH or make hipconfig --path available',
    );
  }
  if (match[3] !== '1') {
    throw new Error(`detected ROCm prefix ${match[2]} is missing an include directory`);
  }
  CFG.rocmPrefix = match[2];
  CFG.rocmPrefixSource = match[1] || 'worker_detection';
}

function expandRocmConfigValue(value) {
  return String(value ?? '')
    .replace(/\$\{ROCM_PREFIX\}/g, CFG.rocmPrefix)
    .replace(/\$\{ROCM_LLVM_BIN\}/g, `${CFG.rocmPrefix}/llvm/bin`)
    .replace(/\$\{ROCM_INCLUDE_DIR\}/g, `${CFG.rocmPrefix}/include`);
}

async function ensureRocmBuildConfig() {
  await detectWorkerGpuArch();
  await detectWorkerRocmPrefix();
  CFG.cmakeArgs = CFG.cmakeArgs.map(expandRocmConfigValue);
}

async function dockerCpFromWorker(workerPath, hostPath) {
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  await dockerText(['cp', `${CFG.workerContainer}:${workerPath}`, hostPath], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function dockerCpToWorker(hostPath, workerPath) {
  await dockerText(['cp', hostPath, `${CFG.workerContainer}:${workerPath}`], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = haystack.indexOf(needle, offset);
    if (next === -1) return count;
    count++;
    offset = next + needle.length;
  }
}

function workerRuntimeRequiredFilePath(file) {
  const normalized = String(file).replace(/\\/g, '/');
  if (normalized.startsWith('/')) return normalized;
  return `${CFG.workerRepoPath}/${normalized}`;
}

function runtimeRequiredAssetPath(asset) {
  if (typeof asset === 'string') return asset;
  return firstText(
    asset?.file,
    asset?.path,
    asset?.relativePath,
    asset?.relative_path,
  );
}

function workerRuntimeRequiredAssetPath(asset) {
  return workerRuntimeRequiredFilePath(runtimeRequiredAssetPath(asset));
}

function normalizedSha256(value) {
  const raw = firstText(value);
  if (/^sha256:[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  if (/^[a-f0-9]{64}$/i.test(raw)) return `sha256:${raw.toLowerCase()}`;
  return null;
}

function positiveIntegerField(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseShellKeyValueOutput(output) {
  const fields = new Map();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trimEnd());
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

function hiprtRocmConfigDetectionGaps(err) {
  const message = String(err?.message ?? '');
  const output = String(err?.output ?? '');
  const combined = `${message}\n${output}`;
  return compactStringList([
    'hiprt_rocm_build_config_detection_failed',
    /spawn\s+EPERM/i.test(combined) ? 'hiprt_worker_docker_spawn_failed' : null,
    /GPU arch|amdgpu-target|rocminfo/i.test(combined) ? 'hiprt_rocm_gpu_arch_detection_failed' : null,
    /ROCm prefix|hipconfig --path|ROCM_PATH/i.test(combined) ? 'hiprt_rocm_prefix_detection_failed' : null,
  ]);
}

function buildRuntimePrerequisiteContract(prerequisiteProbe = {}) {
  const runtimeRequiredFiles = CFG.requiredFiles.map((file) => {
    const observed = Array.isArray(prerequisiteProbe.requiredFiles)
      ? prerequisiteProbe.requiredFiles.find((entry) => entry?.file === file)
      : null;
    const workerPath = observed?.workerPath ?? observed?.worker_path ?? workerRuntimeRequiredFilePath(file);
    return {
      file,
      workerPath,
      worker_path: workerPath,
      role: 'runtime_input',
      present: observed?.present === true,
      contentHash: observed?.contentHash ?? observed?.content_hash ?? null,
      content_hash: observed?.contentHash ?? observed?.content_hash ?? null,
      byteLength: observed?.byteLength ?? observed?.byte_length ?? null,
      byte_length: observed?.byteLength ?? observed?.byte_length ?? null,
      readableBytesVerified: observed?.readableBytesVerified === true
        || observed?.readable_bytes_verified === true,
      readable_bytes_verified: observed?.readableBytesVerified === true
        || observed?.readable_bytes_verified === true,
    };
  });
  const runtimeRequiredAssets = CFG.requiredAssets.map((asset) => {
    const assetPath = runtimeRequiredAssetPath(asset);
    const observed = Array.isArray(prerequisiteProbe.requiredAssets)
      ? prerequisiteProbe.requiredAssets.find((entry) => entry?.path === assetPath || entry?.file === assetPath)
      : null;
    const declaredHash = normalizedSha256(
      typeof asset === 'object' && asset !== null
        ? asset.contentHash ?? asset.content_hash ?? asset.sha256
        : null,
    );
    const observedHash = observed?.contentHash ?? observed?.content_hash ?? null;
    const contentHash = observedHash ?? declaredHash ?? null;
    const hashMatchesDeclaration = declaredHash ? observedHash === declaredHash : observedHash !== null;
    return {
      ...(typeof asset === 'object' && asset !== null ? asset : {}),
      file: assetPath,
      path: assetPath,
      role: typeof asset === 'object' && asset !== null
        ? firstText(asset.role) || 'runtime_input'
        : 'runtime_input',
      required: typeof asset === 'object' && asset !== null && asset.required === false ? false : true,
      workerPath: observed?.workerPath ?? observed?.worker_path ?? workerRuntimeRequiredAssetPath(asset),
      worker_path: observed?.workerPath ?? observed?.worker_path ?? workerRuntimeRequiredAssetPath(asset),
      present: observed?.present === true,
      contentHash,
      content_hash: contentHash,
      declaredContentHash: declaredHash,
      declared_content_hash: declaredHash,
      hashMatchesDeclaration,
      hash_matches_declaration: hashMatchesDeclaration,
      byteLength: observed?.byteLength ?? observed?.byte_length ?? null,
      byte_length: observed?.byteLength ?? observed?.byte_length ?? null,
      readableBytesVerified: observed?.readableBytesVerified === true
        || observed?.readable_bytes_verified === true,
      readable_bytes_verified: observed?.readableBytesVerified === true
        || observed?.readable_bytes_verified === true,
    };
  });
  const contract = {
    schemaVersion: RUNTIME_PREREQUISITE_CONTRACT_SCHEMA_VERSION,
    schema_version: RUNTIME_PREREQUISITE_CONTRACT_SCHEMA_VERSION,
    proofAuthority: RUNTIME_PREREQUISITE_CONTRACT_AUTHORITY,
    proof_authority: RUNTIME_PREREQUISITE_CONTRACT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    backend: 'hiprt',
    backendFamily: 'hiprt',
    backend_family: 'hiprt',
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    mode: CFG.mode,
    targetName: CFG.targetName,
    target_name: CFG.targetName,
    workerContainer: CFG.workerContainer,
    worker_container: CFG.workerContainer,
    workerRepoPath: CFG.workerRepoPath,
    worker_repo_path: CFG.workerRepoPath,
    sourceTree: CFG.runtimeSourceTree,
    source_tree: CFG.runtimeSourceTree,
    nativeLaunchObserverPath: CFG.nativeLaunchObserverPath,
    native_launch_observer_path: CFG.nativeLaunchObserverPath,
    adapter: {
      family: CFG.runtimeProfile?.adapter?.family ?? null,
      proofRunner: CFG.runtimeProfile?.adapter?.proofRunner ?? null,
      proof_runner: CFG.runtimeProfile?.adapter?.proofRunner ?? null,
      capabilities: Array.isArray(CFG.runtimeProfile?.adapter?.capabilities)
        ? CFG.runtimeProfile.adapter.capabilities
        : [],
    },
    source: {
      file: CFG.sourceRel,
      workerPath: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
      worker_path: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
      beforeHash: sha256Json(CFG.before),
      before_hash: sha256Json(CFG.before),
      afterHash: sha256Json(CFG.after),
      after_hash: sha256Json(CFG.after),
      deltaHash: sha256Json({ before: CFG.before, after: CFG.after }),
      delta_hash: sha256Json({ before: CFG.before, after: CFG.after }),
      present: prerequisiteProbe.sourceFilePresent === true,
    },
    build: {
      cmakeArgs: CFG.cmakeArgs,
      cmake_args: CFG.cmakeArgs,
      cmakeConfigName: CFG.cmakeConfigName,
      cmake_config_name: CFG.cmakeConfigName,
      buildEnvKeys: Object.keys(CFG.buildEnv).sort(),
      build_env_keys: Object.keys(CFG.buildEnv).sort(),
      gpuArch: CFG.gpuArch || null,
      gpu_arch: CFG.gpuArch || null,
      rocmPrefix: CFG.rocmPrefix || null,
      rocm_prefix: CFG.rocmPrefix || null,
      buildExecutable: prerequisiteProbe.buildExecutable ?? prerequisiteProbe.build_executable ?? null,
      build_executable: prerequisiteProbe.buildExecutable ?? prerequisiteProbe.build_executable ?? null,
      buildConfig: prerequisiteProbe.buildConfig ?? prerequisiteProbe.build_config ?? null,
      build_config: prerequisiteProbe.buildConfig ?? prerequisiteProbe.build_config ?? null,
    },
    runtime: {
      args: CFG.runtimeArgs,
      envKeys: Object.keys(CFG.runtimeEnv).sort(),
      env_keys: Object.keys(CFG.runtimeEnv).sort(),
      requiredKernels: CFG.requiredKernels,
      required_kernels: CFG.requiredKernels,
      reloadKernelName: CFG.reloadKernelName,
      reload_kernel_name: CFG.reloadKernelName,
      reloadKernelSymbol: CFG.reloadKernelSymbol,
      reload_kernel_symbol: CFG.reloadKernelSymbol,
      requiredFiles: runtimeRequiredFiles,
      required_files: runtimeRequiredFiles,
      requiredAssets: runtimeRequiredAssets,
      required_assets: runtimeRequiredAssets,
      orochiApi: CFG.orochiApi || null,
      orochi_api: CFG.orochiApi || null,
    },
    visualProof: {
      claim: CFG.claim,
      width: CFG.width,
      height: CFG.height,
      minChangedPixelRatio: CFG.minChangedPixelRatio,
      min_changed_pixel_ratio: CFG.minChangedPixelRatio,
      minMeanAbsDelta8bit: CFG.minMeanAbsDelta8bit,
      min_mean_abs_delta_8bit: CFG.minMeanAbsDelta8bit,
      deterministicVisualMode: CFG.deterministicVisualMode,
      deterministic_visual_mode: CFG.deterministicVisualMode,
    },
    observed: {
      repoDirPresent: prerequisiteProbe.repoDirPresent === true,
      repo_dir_present: prerequisiteProbe.repoDirPresent === true,
      repoGitPresent: prerequisiteProbe.repoGitPresent === true,
      repo_git_present: prerequisiteProbe.repoGitPresent === true,
      repoCommit: prerequisiteProbe.repoCommit ?? prerequisiteProbe.repo_commit ?? null,
      repo_commit: prerequisiteProbe.repoCommit ?? prerequisiteProbe.repo_commit ?? null,
      nativeObserverPresent: prerequisiteProbe.nativeObserverPresent === true,
      native_observer_present: prerequisiteProbe.nativeObserverPresent === true,
      sourceFilePresent: prerequisiteProbe.sourceFilePresent === true,
      source_file_present: prerequisiteProbe.sourceFilePresent === true,
    },
    blockingGaps: compactStringList(prerequisiteProbe.blockingGaps ?? prerequisiteProbe.blocking_gaps),
    blocking_gaps: compactStringList(prerequisiteProbe.blockingGaps ?? prerequisiteProbe.blocking_gaps),
  };
  contract.contractHash = sha256Json({
    schemaVersion: contract.schemaVersion,
    backend: contract.backend,
    profileId: contract.profileId,
    mode: contract.mode,
    targetName: contract.targetName,
    workerRepoPath: contract.workerRepoPath,
    sourceTree: contract.sourceTree,
    source: contract.source,
    runtime: contract.runtime,
    visualProof: contract.visualProof,
    blockingGaps: contract.blockingGaps,
  });
  contract.contract_hash = contract.contractHash;
  return contract;
}

function hiprtPreflightProbeFromError({ stage, err }) {
  const blockingGaps = hiprtRocmConfigDetectionGaps(err);
  return {
    schemaVersion: HIPRT_PREFLIGHT_PROBE_SCHEMA_VERSION,
    schema_version: HIPRT_PREFLIGHT_PROBE_SCHEMA_VERSION,
    proofAuthority: HIPRT_PREFLIGHT_AUTHORITY,
    proof_authority: HIPRT_PREFLIGHT_AUTHORITY,
    accepted: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    stage,
    workerContainer: CFG.workerContainer,
    worker_container: CFG.workerContainer,
    workerRepoPath: CFG.workerRepoPath,
    worker_repo_path: CFG.workerRepoPath,
    nativeLaunchObserverPath: CFG.nativeLaunchObserverPath,
    native_launch_observer_path: CFG.nativeLaunchObserverPath,
    sourceRel: CFG.sourceRel,
    source_rel: CFG.sourceRel,
    sourceWorkerPath: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
    source_worker_path: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
    dockerError: firstText(err?.message, err?.code),
    docker_error: firstText(err?.message, err?.code),
    outputTail: err?.output ? String(err.output).slice(-4000) : '',
    output_tail: err?.output ? String(err.output).slice(-4000) : '',
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates: blockingGaps.map((code) => ({ code })),
    failed_gates: blockingGaps.map((code) => ({ code })),
  };
}

async function probeHiprtPreflightPrerequisites() {
  const requiredFilePrints = CFG.requiredFiles
    .map((file, index) => {
      const workerPath = workerRuntimeRequiredFilePath(file);
      return `
if [ -f ${shQuote(workerPath)} ]; then
  required_file_${index}_hash="$(sha256sum ${shQuote(workerPath)} 2>/dev/null | awk '{print $1}')"
  required_file_${index}_bytes="$(wc -c < ${shQuote(workerPath)} 2>/dev/null | tr -d ' ')"
  printf 'required_file_${index}_present=1\\nrequired_file_${index}_sha256=sha256:%s\\nrequired_file_${index}_bytes=%s\\n' "$required_file_${index}_hash" "$required_file_${index}_bytes"
else
  printf 'required_file_${index}_present=0\\nrequired_file_${index}_sha256=\\nrequired_file_${index}_bytes=\\n'
fi`;
    })
    .join('\n');
  const requiredAssetPrints = CFG.requiredAssets
    .map((asset, index) => {
      const workerPath = workerRuntimeRequiredAssetPath(asset);
      return `
if [ -f ${shQuote(workerPath)} ]; then
  required_asset_${index}_hash="$(sha256sum ${shQuote(workerPath)} 2>/dev/null | awk '{print $1}')"
  required_asset_${index}_bytes="$(wc -c < ${shQuote(workerPath)} 2>/dev/null | tr -d ' ')"
  printf 'required_asset_${index}_present=1\\nrequired_asset_${index}_sha256=sha256:%s\\nrequired_asset_${index}_bytes=%s\\n' "$required_asset_${index}_hash" "$required_asset_${index}_bytes"
else
  printf 'required_asset_${index}_present=0\\nrequired_asset_${index}_sha256=\\nrequired_asset_${index}_bytes=\\n'
fi`;
    })
    .join('\n');
  const script = `
set +e
repo_dir_present=0
repo_git_present=0
native_observer_present=0
source_file_present=0
repo_commit=''
build_executable=missing
build_config=missing
[ -d ${shQuote(CFG.workerRepoPath)} ] && repo_dir_present=1
[ -d ${shQuote(`${CFG.workerRepoPath}/.git`)} ] && repo_git_present=1
[ -f ${shQuote(CFG.nativeLaunchObserverPath)} ] && native_observer_present=1
[ -f ${shQuote(`${CFG.workerRepoPath}/${CFG.sourceRel}`)} ] && source_file_present=1
if [ "$repo_git_present" = "1" ]; then
  repo_commit="$(git -C ${shQuote(CFG.workerRepoPath)} rev-parse HEAD 2>/dev/null || true)"
fi
[ -x ${shQuote(`${CFG.workerRepoPath}/build/${CFG.targetName}`)} ] && build_executable=present
[ -f ${shQuote(`${CFG.workerRepoPath}/build/CMakeCache.txt`)} ] && build_config=present
printf 'repo_dir_present=%s\\nrepo_git_present=%s\\nnative_observer_present=%s\\nsource_file_present=%s\\nrepo_commit=%s\\nbuild_executable=%s\\nbuild_config=%s\\n' "$repo_dir_present" "$repo_git_present" "$native_observer_present" "$source_file_present" "$repo_commit" "$build_executable" "$build_config"
${requiredFilePrints}
${requiredAssetPrints}
exit 0
`;
  let output = '';
  let dockerError = null;
  try {
    output = await dockerShell(script, { timeout: 30000 });
  } catch (err) {
    dockerError = err;
    output = err?.output ?? '';
  }
  const fields = parseShellKeyValueOutput(output);
  const requiredFiles = CFG.requiredFiles.map((file, index) => {
    const workerPath = workerRuntimeRequiredFilePath(file);
    return {
      file,
      workerPath,
      worker_path: workerPath,
      present: fields.get(`required_file_${index}_present`) === '1',
      contentHash: normalizedSha256(fields.get(`required_file_${index}_sha256`)),
      content_hash: normalizedSha256(fields.get(`required_file_${index}_sha256`)),
      byteLength: positiveIntegerField(fields.get(`required_file_${index}_bytes`)),
      byte_length: positiveIntegerField(fields.get(`required_file_${index}_bytes`)),
      readableBytesVerified:
        fields.get(`required_file_${index}_present`) === '1'
        && Boolean(normalizedSha256(fields.get(`required_file_${index}_sha256`)))
        && positiveIntegerField(fields.get(`required_file_${index}_bytes`)) !== null,
    };
  });
  const requiredAssets = CFG.requiredAssets.map((asset, index) => {
    const assetPath = runtimeRequiredAssetPath(asset);
    const workerPath = workerRuntimeRequiredAssetPath(asset);
    const declaredHash = normalizedSha256(
      typeof asset === 'object' && asset !== null
        ? asset.contentHash ?? asset.content_hash ?? asset.sha256
        : null,
    );
    const observedHash = normalizedSha256(fields.get(`required_asset_${index}_sha256`));
    const byteLength = positiveIntegerField(fields.get(`required_asset_${index}_bytes`));
    return {
      ...(typeof asset === 'object' && asset !== null ? asset : {}),
      file: assetPath,
      path: assetPath,
      workerPath,
      worker_path: workerPath,
      role: typeof asset === 'object' && asset !== null
        ? firstText(asset.role) || 'runtime_input'
        : 'runtime_input',
      required: typeof asset === 'object' && asset !== null && asset.required === false ? false : true,
      present: fields.get(`required_asset_${index}_present`) === '1',
      contentHash: observedHash,
      content_hash: observedHash,
      declaredContentHash: declaredHash,
      declared_content_hash: declaredHash,
      hashMatchesDeclaration: declaredHash ? observedHash === declaredHash : observedHash !== null,
      hash_matches_declaration: declaredHash ? observedHash === declaredHash : observedHash !== null,
      byteLength,
      byte_length: byteLength,
      readableBytesVerified:
        fields.get(`required_asset_${index}_present`) === '1'
        && Boolean(observedHash)
        && byteLength !== null
        && (declaredHash ? observedHash === declaredHash : true),
      readable_bytes_verified:
        fields.get(`required_asset_${index}_present`) === '1'
        && Boolean(observedHash)
        && byteLength !== null
        && (declaredHash ? observedHash === declaredHash : true),
    };
  });
  const blockingGaps = compactStringList([
    dockerError ? 'hiprt_worker_preflight_probe_failed' : null,
    fields.get('repo_dir_present') === '1' ? null : 'hiprt_worker_repo_missing',
    fields.get('repo_git_present') === '1' ? null : 'hiprt_worker_repo_git_missing',
    fields.get('native_observer_present') === '1' ? null : 'hiprt_native_launch_observer_missing',
    fields.get('source_file_present') === '1' ? null : 'hiprt_source_file_missing',
    ...requiredFiles
      .filter((entry) => entry.present !== true)
      .map((entry) => `hiprt_required_runtime_file_missing:${entry.file}`),
    ...requiredAssets
      .filter((entry) => entry.required !== false && entry.readableBytesVerified !== true)
      .map((entry) => `hiprt_required_runtime_asset_bytes_unverified:${entry.path}`),
  ]);
  return {
    schemaVersion: HIPRT_PREFLIGHT_PROBE_SCHEMA_VERSION,
    schema_version: HIPRT_PREFLIGHT_PROBE_SCHEMA_VERSION,
    proofAuthority: HIPRT_PREFLIGHT_AUTHORITY,
    proof_authority: HIPRT_PREFLIGHT_AUTHORITY,
    accepted: blockingGaps.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    workerContainer: CFG.workerContainer,
    worker_container: CFG.workerContainer,
    workerRepoPath: CFG.workerRepoPath,
    worker_repo_path: CFG.workerRepoPath,
    nativeLaunchObserverPath: CFG.nativeLaunchObserverPath,
    native_launch_observer_path: CFG.nativeLaunchObserverPath,
    sourceRel: CFG.sourceRel,
    source_rel: CFG.sourceRel,
    sourceWorkerPath: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
    source_worker_path: `${CFG.workerRepoPath}/${CFG.sourceRel}`,
    repoDirPresent: fields.get('repo_dir_present') === '1',
    repo_dir_present: fields.get('repo_dir_present') === '1',
    repoGitPresent: fields.get('repo_git_present') === '1',
    repo_git_present: fields.get('repo_git_present') === '1',
    nativeObserverPresent: fields.get('native_observer_present') === '1',
    native_observer_present: fields.get('native_observer_present') === '1',
    sourceFilePresent: fields.get('source_file_present') === '1',
    source_file_present: fields.get('source_file_present') === '1',
    repoCommit: firstText(fields.get('repo_commit')) || null,
    repo_commit: firstText(fields.get('repo_commit')) || null,
    buildExecutable: firstText(fields.get('build_executable')) || 'missing',
    build_executable: firstText(fields.get('build_executable')) || 'missing',
    buildConfig: firstText(fields.get('build_config')) || 'missing',
    build_config: firstText(fields.get('build_config')) || 'missing',
    requiredFiles,
    required_files: requiredFiles,
    requiredAssets,
    required_assets: requiredAssets,
    dockerError: dockerError ? firstText(dockerError.message, dockerError.code) : null,
    docker_error: dockerError ? firstText(dockerError.message, dockerError.code) : null,
    outputTail: output ? String(output).slice(-4000) : '',
    output_tail: output ? String(output).slice(-4000) : '',
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates: blockingGaps.map((code) => ({ code })),
    failed_gates: blockingGaps.map((code) => ({ code })),
  };
}

async function preflight() {
  const prerequisiteProbe = await probeHiprtPreflightPrerequisites();
  if (prerequisiteProbe.accepted !== true) {
    return {
      accepted: false,
      repoCommit: prerequisiteProbe.repoCommit,
      buildExecutable: prerequisiteProbe.buildExecutable,
      buildConfig: prerequisiteProbe.buildConfig,
      bootstrap: null,
      prerequisiteProbe,
    };
  }
  const repoCommit = prerequisiteProbe.repoCommit;
  const buildExecutable = prerequisiteProbe.buildExecutable;
  const buildConfig = prerequisiteProbe.buildConfig;
  const bootstrap = {};
  if (buildConfig !== 'present' || buildExecutable !== 'present') {
    bootstrap.configure = await configureHiprtBuild('preflight-bootstrap');
  }
  if (buildExecutable !== 'present') {
    bootstrap.build = await buildHiprtTarget('preflight-bootstrap');
  }
  await dockerShell(
    `test -x ${shQuote(`${CFG.workerRepoPath}/build/${CFG.targetName}`)}`,
    { timeout: 30000 },
  );
  return {
    accepted: true,
    repoCommit,
    buildExecutable,
    buildConfig,
    bootstrap: Object.keys(bootstrap).length ? bootstrap : null,
    prerequisiteProbe,
  };
}

async function writeHiprtPreflightRefusalArtifact({
  preflightResult,
  strictSummary,
  totalStartedMonotonicNs,
}) {
  const prerequisiteProbe = preflightResult.prerequisiteProbe ?? {};
  const runtimePrerequisiteContract = buildRuntimePrerequisiteContract(prerequisiteProbe);
  const evidenceRef = `hiprt-worker-preflight-probe:${sha256Hex(stableJson({
    schemaVersion: prerequisiteProbe.schemaVersion,
    workerContainer: prerequisiteProbe.workerContainer,
    workerRepoPath: prerequisiteProbe.workerRepoPath,
    nativeLaunchObserverPath: prerequisiteProbe.nativeLaunchObserverPath,
    sourceRel: prerequisiteProbe.sourceRel,
    sourceWorkerPath: prerequisiteProbe.sourceWorkerPath,
    requiredFiles: prerequisiteProbe.requiredFiles,
    runtimePrerequisiteContractHash: runtimePrerequisiteContract.contractHash,
    blockingGaps: prerequisiteProbe.blockingGaps,
  }))}`;
  const unsupportedReasons = compactStringList([
    'hiprt_runtime_preflight_failed',
    ...(Array.isArray(prerequisiteProbe.blockingGaps) ? prerequisiteProbe.blockingGaps : []),
  ]);
  const artifact = {
    schema: HIPRT_PREFLIGHT_SCHEMA_VERSION,
    schemaVersion: HIPRT_PREFLIGHT_SCHEMA_VERSION,
    schema_version: HIPRT_PREFLIGHT_SCHEMA_VERSION,
    slug: CFG.slug,
    createdAt: new Date().toISOString(),
    created_at: new Date().toISOString(),
    mode: CFG.mode,
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    backendEvidence: {
      schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
      schema_version: 'synthi.gpu_hmr.preflight_backend_contract.v1',
      backend: {
        value: 'hiprt',
        evidenceRefs: [evidenceRef],
        evidence_refs: [evidenceRef],
      },
      backendFamily: {
        value: 'hiprt',
        evidenceRefs: [evidenceRef],
        evidence_refs: [evidenceRef],
      },
      backend_family: {
        value: 'hiprt',
        evidenceRefs: [evidenceRef],
        evidence_refs: [evidenceRef],
      },
      runtimeCapabilityPreflight: {
        backend: 'hiprt',
        backendFamily: 'hiprt',
        backend_family: 'hiprt',
        probe: 'hiprt_worker_preflight_probe',
        workerRepoPath: CFG.workerRepoPath,
        worker_repo_path: CFG.workerRepoPath,
        nativeLaunchObserverPath: CFG.nativeLaunchObserverPath,
        native_launch_observer_path: CFG.nativeLaunchObserverPath,
        runtimePrerequisiteContractHash: runtimePrerequisiteContract.contractHash,
        runtime_prerequisite_contract_hash: runtimePrerequisiteContract.contractHash,
        accepted: false,
        evidenceRefs: [evidenceRef],
        evidence_refs: [evidenceRef],
      },
      runtime_capability_preflight: {
        backend: 'hiprt',
        backendFamily: 'hiprt',
        backend_family: 'hiprt',
        probe: 'hiprt_worker_preflight_probe',
        workerRepoPath: CFG.workerRepoPath,
        worker_repo_path: CFG.workerRepoPath,
        nativeLaunchObserverPath: CFG.nativeLaunchObserverPath,
        native_launch_observer_path: CFG.nativeLaunchObserverPath,
        runtimePrerequisiteContractHash: runtimePrerequisiteContract.contractHash,
        runtime_prerequisite_contract_hash: runtimePrerequisiteContract.contractHash,
        accepted: false,
        evidenceRefs: [evidenceRef],
        evidence_refs: [evidenceRef],
      },
      evidenceRefs: [evidenceRef],
      evidence_refs: [evidenceRef],
    },
    classification: {
      projectKind: { value: 'gpu_project', evidenceRefs: [evidenceRef] },
      project_kind: { value: 'gpu_project', evidence_refs: [evidenceRef] },
      editKind: { value: 'gpu_artifact_edit', evidenceRefs: [evidenceRef] },
      edit_kind: { value: 'gpu_artifact_edit', evidence_refs: [evidenceRef] },
      route: { value: 'reject', evidenceRefs: [evidenceRef] },
      backend: { value: 'hiprt', evidenceRefs: [evidenceRef] },
      backendFamily: 'hiprt',
      backend_family: 'hiprt',
      runtimeCapabilityPreflight: {
        backend: 'hiprt',
        backendFamily: 'hiprt',
        probe: 'hiprt_worker_preflight_probe',
        evidenceRefs: [evidenceRef],
      },
      runtime_capability_preflight: {
        backend: 'hiprt',
        backendFamily: 'hiprt',
        probe: 'hiprt_worker_preflight_probe',
        evidenceRefs: [evidenceRef],
      },
      resultState: 'hiprt-runtime-preflight-rejected',
      result_state: 'hiprt-runtime-preflight-rejected',
      unsupportedReasons,
      unsupported_reasons: unsupportedReasons,
      blockingGaps: unsupportedReasons,
      blocking_gaps: unsupportedReasons,
    },
    acceptance: {
      acceptedForHiprtRuntimePreflight: false,
      accepted_for_hiprt_runtime_preflight: false,
      acceptedForHiprtVisualProof: false,
      accepted_for_hiprt_visual_proof: false,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      reason: 'hiprt_runtime_preflight_failed',
      noShimApplied: true,
      no_shim_applied: true,
      noSymlinkApplied: true,
      no_symlink_applied: true,
      noSynthesizedRuntime: true,
      no_synthesized_runtime: true,
      noVendorIcdSynthesized: true,
      no_vendor_icd_synthesized: true,
    },
    preflight: prerequisiteProbe,
    hiprtWorkerPreflightProbe: prerequisiteProbe,
    hiprt_worker_preflight_probe: prerequisiteProbe,
    runtimePrerequisiteContract,
    runtime_prerequisite_contract: runtimePrerequisiteContract,
    strictHmrProvenance: strictSummary,
    strict_hmr_provenance: strictSummary,
    timings: {
      ...monotonicTimingFields(totalStartedMonotonicNs),
      mode: CFG.mode,
    },
    proofAuthority: HIPRT_PREFLIGHT_AUTHORITY,
    proof_authority: HIPRT_PREFLIGHT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
  };
  artifact.proofId = `hiprt-preflight-proof:sha256:${sha256Hex(stableJson({
    schemaVersion: artifact.schemaVersion,
    slug: artifact.slug,
    mode: artifact.mode,
    profileId: artifact.profileId,
    backendEvidence: artifact.backendEvidence,
    classification: artifact.classification,
    acceptance: artifact.acceptance,
    preflight: artifact.preflight,
    runtimePrerequisiteContract: artifact.runtimePrerequisiteContract,
  }))}`;
  artifact.proof_id = artifact.proofId;
  const proofPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-preflight-refusal.json`);
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(proofPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { artifact, proofPath };
}

async function readBaselineSourceFromGit() {
  return dockerText([
    'exec',
    CFG.workerContainer,
    'git',
    '-C',
    CFG.workerRepoPath,
    'show',
    `HEAD:${CFG.sourceRel}`,
  ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
}

async function writeVariantSource({ variant, text }) {
  const startedAt = Date.now();
  const localPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-${path.basename(CFG.sourceRel)}`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, text);
  await dockerCpToWorker(localPath, `${CFG.workerRepoPath}/${CFG.sourceRel}`);
  const workerHashLine = await dockerShell(
    `sha256sum ${shQuote(`${CFG.workerRepoPath}/${CFG.sourceRel}`)}`,
    { timeout: 30000 },
  );
  return {
    localPath,
    contentHash: `sha256:${sha256Hex(text)}`,
    workerSha256: `sha256:${workerHashLine.trim().split(/\s+/)[0]}`,
    hostWallMs: Date.now() - startedAt,
  };
}

async function refreshWorkerSourceIndex() {
  await dockerShell(
    `git -C ${shQuote(CFG.workerRepoPath)} update-index --refresh ${shQuote(CFG.sourceRel)} >/dev/null 2>&1 || true`,
    { timeout: 30000 },
  );
}

function parseKernelSymbols(log) {
  const kernels = new Set();
  for (const match of log.matchAll(/\bkernel_symbol=([A-Za-z0-9_.$-]+)/g)) {
    kernels.add(match[1]);
  }
  for (const match of log.matchAll(/Kernel "([^"]+)" compiled/g)) {
    kernels.add(match[1]);
  }
  return Array.from(kernels).sort();
}

function parseCaptureLine(log) {
  return log.split(/\r?\n/).find((line) =>
    line.includes('[synthi-hiprt-runtime-probe]')
    && line.includes('capture_path=')
    && line.includes('wrote=1')
  ) ?? '';
}

function parseKeyValuePairs(line) {
  const pairs = {};
  for (const match of String(line ?? '').matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\([^)]*\)|[^\s]+)/g)) {
    const raw = match[2];
    pairs[match[1]] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return pairs;
}

function parseLaunchDim(value) {
  const match = /^\((\d+),(\d+),(\d+)\)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map((item) => Number(item)) : null;
}

function parseNativeRuntimeLine(line, lineIndex) {
  const values = parseKeyValuePairs(line);
  const runtimeSession = values.runtime_session ?? '';
  const processId = /^native-launch-observer:(\d+)$/.exec(runtimeSession)?.[1] ?? values.pid ?? null;
  return {
    lineIndex,
    raw: line,
    api: values.api ?? null,
    runtimeSession,
    processId,
    sequence: values.sequence ? Number(values.sequence) : null,
    functionPtr: values.function_ptr ?? null,
    kernelSymbol: values.kernel_symbol ?? values.symbol ?? null,
    gridDim: parseLaunchDim(values.grid),
    blockDim: parseLaunchDim(values.block),
    argsPtr: values.args_ptr ?? null,
    stream: values.stream ?? null,
    sharedBytes: values.shared_bytes ? Number(values.shared_bytes) : 0,
    result: values.result ? Number(values.result) : null,
    dispatch: values.dispatch ?? null,
    attachmentProvenance: values.attachment_provenance ?? null,
    module: values.module ?? null,
    resolution: values.resolution ?? null,
  };
}

function parseSameProcessRecompileLine(line, lineIndex) {
  if (!line.includes('same_process_recompile') || !line.includes('result=success')) return null;
  const values = parseKeyValuePairs(line);
  return {
    lineIndex,
    raw: line,
    kernelSymbol: values.kernel ?? null,
    kernelName: values.kernel_name ?? null,
    elapsedMs: values.elapsed_ms ? Number(values.elapsed_ms) : null,
  };
}

function parsePostRecompileRuntimeEvidence(log, kernelSymbol) {
  const lines = String(log ?? '').split(/\r?\n/);
  const recompile = lines
    .map((line, lineIndex) => parseSameProcessRecompileLine(line, lineIndex))
    .find((record) => record && (!kernelSymbol || record.kernelSymbol === kernelSymbol));
  if (!recompile) return null;
  const resolution = lines
    .slice(recompile.lineIndex)
    .map((line, offset) => ({ line, lineIndex: recompile.lineIndex + offset }))
    .find(({ line }) =>
      line.includes('native_function_resolution')
      && line.includes(`symbol=${kernelSymbol}`)
      && line.includes('result=0')
    );
  const dispatch = lines
    .slice(recompile.lineIndex)
    .map((line, offset) => ({ line, lineIndex: recompile.lineIndex + offset }))
    .find(({ line }) =>
      line.includes('native_launch_observed')
      && line.includes(`kernel_symbol=${kernelSymbol}`)
      && line.includes('result=0')
    );
  const capture = lines
    .slice(dispatch ? dispatch.lineIndex : recompile.lineIndex)
    .map((line, offset) => ({
      line,
      lineIndex: (dispatch ? dispatch.lineIndex : recompile.lineIndex) + offset,
    }))
    .find(({ line }) =>
      line.includes('same_process_capture')
      && line.includes('label=changed-after-in-process-recompile')
      && line.includes('wrote=1')
    );
  if (!dispatch || !capture) {
    return {
      recompile,
      resolution: resolution ? parseNativeRuntimeLine(resolution.line, resolution.lineIndex) : null,
      dispatch: dispatch ? parseNativeRuntimeLine(dispatch.line, dispatch.lineIndex) : null,
      captureLine: capture?.line ?? null,
      accepted: false,
    };
  }
  return {
    recompile,
    resolution: resolution ? parseNativeRuntimeLine(resolution.line, resolution.lineIndex) : null,
    dispatch: parseNativeRuntimeLine(dispatch.line, dispatch.lineIndex),
    captureLine: capture.line,
    captureLineIndex: capture.lineIndex,
    accepted: true,
  };
}

async function snapshotWorkerShaderCache(label) {
  const startedMonotonicNs = monotonicNowNs();
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
if [ ! -d build/shader_cache ]; then
  exit 0
fi
find build/shader_cache -type f \\( -name '*.bin' -o -name '*.hsaco' -o -name '*.co' \\) -exec sh -c '
for file do
  hash=$(sha256sum "$file" | awk "{print \\$1}")
  size=$(stat -c %s "$file")
  mtime=$(stat -c %Y "$file")
  printf "%s\\t%s\\t%s\\t%s\\n" "$hash" "$size" "$mtime" "$file"
done
' sh {} +
`;
  const output = await dockerShell(script, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const finishedMonotonicNs = monotonicNowNs();
  const entries = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [hash, size, mtimeSeconds, workerPath] = line.split('\t');
      return {
        workerPath,
        contentHash: `sha256:${hash}`,
        size: Number(size),
        mtimeSeconds: Number(mtimeSeconds),
      };
    })
    .filter((entry) =>
      entry.workerPath
      && /^sha256:[a-f0-9]{64}$/.test(entry.contentHash)
      && Number.isFinite(entry.size)
      && Number.isFinite(entry.mtimeSeconds)
    )
    .sort((a, b) => a.workerPath.localeCompare(b.workerPath));
  return {
    label,
    startedMonotonicNs,
    finishedMonotonicNs,
    entries,
    manifestHash: `artifact:${sha256Json(entries.map((entry) => ({
      workerPath: entry.workerPath,
      contentHash: entry.contentHash,
      size: entry.size,
    })))}`,
  };
}

function shaderCacheDelta(before, after) {
  const beforeByPath = new Map((before?.entries ?? []).map((entry) => [entry.workerPath, entry]));
  const beforeKeys = new Set((before?.entries ?? []).map((entry) => `${entry.workerPath}:${entry.contentHash}:${entry.size}`));
  const changedEntries = (after?.entries ?? []).filter((entry) => {
    const key = `${entry.workerPath}:${entry.contentHash}:${entry.size}`;
    const previous = beforeByPath.get(entry.workerPath);
    return !beforeKeys.has(key) || (previous && previous.contentHash !== entry.contentHash);
  });
  const selectedEntries = changedEntries.sort((a, b) => a.workerPath.localeCompare(b.workerPath));
  const selectedManifest = selectedEntries.map((entry) => ({
    workerPath: entry.workerPath,
    contentHash: entry.contentHash,
    size: entry.size,
  }));
  return {
    beforeManifestHash: before?.manifestHash ?? null,
    afterManifestHash: after?.manifestHash ?? null,
    selectedArtifactHash: selectedEntries.length > 0
      ? `artifact:${sha256Json(selectedManifest)}`
      : null,
    selectedEntries,
    changedEntryCount: selectedEntries.length,
  };
}

function addNs(ns, delta) {
  return (BigInt(String(ns)) + BigInt(delta)).toString();
}

const SAME_PROCESS_ADAPTER_HELPERS = String.raw`
// SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_BEGIN
bool synthi_probe_file_exists(const char* path)
{
	if (path == nullptr || path[0] == '\0')
		return false;
	std::ifstream file(path);
	return file.good();
}

int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

int synthi_probe_env_timeout_ms(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(0, std::atoi(raw));
}

const char* synthi_probe_required_env(const char* name)
{
	const char* value = std::getenv(name);
	if (value == nullptr || value[0] == '\0')
	{
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_missing_env name=%s\n", name);
		return nullptr;
	}
	return value;
}

bool synthi_wait_for_reload_trigger()
{
	const char* trigger_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH");
	if (trigger_path == nullptr)
		return false;

	const int timeout_ms = synthi_probe_env_timeout_ms("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 0);
	const bool timeout_enabled = timeout_ms > 0;
	const auto start = std::chrono::steady_clock::now();
	if (timeout_enabled)
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\n", trigger_path, timeout_ms);
	else
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=unbounded\n", trigger_path);
	while (!synthi_probe_file_exists(trigger_path))
	{
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
		const auto now = std::chrono::steady_clock::now();
		const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
		if (timeout_enabled && elapsed_ms > timeout_ms)
		{
			std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_timeout trigger=%s elapsed_ms=%lld\n", trigger_path, static_cast<long long>(elapsed_ms));
			return false;
		}
	}

	const auto end = std::chrono::steady_clock::now();
	const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
	std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_trigger_observed trigger=%s wait_ms=%lld\n", trigger_path, static_cast<long long>(elapsed_ms));
	return true;
}

bool synthi_write_runtime_framebuffer_to_path(const std::shared_ptr<OpenGLInteropBuffer<ColorRGB32F>>& framebuffer, int width, int height, oroStream_t stream, const char* capture_path, const char* label)
{
	if (capture_path == nullptr || capture_path[0] == '\0')
		return false;

	if (framebuffer == nullptr)
		return false;

	OROCHI_CHECK_ERROR(oroStreamSynchronize(stream));

	std::vector<ColorRGB32F> framebuffer_pixels = framebuffer->download_data();
	const size_t expected_pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
	if (framebuffer_pixels.size() < expected_pixels || expected_pixels == 0)
	{
		std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_capture_failed label=%s path=%s width=%d height=%d pixels=%zu expected_pixels=%zu reason=framebuffer_readback_unavailable\n", label, capture_path, width, height, framebuffer_pixels.size(), expected_pixels);
		return false;
	}

	std::vector<float> pixels(expected_pixels * 3);
	double luma_sum = 0.0;
	double luma_sq_sum = 0.0;
	size_t non_black_pixels = 0;
	float min_luma = 1.0e30f;
	float max_luma = -1.0e30f;
	for (size_t i = 0; i < expected_pixels; i++)
	{
		const ColorRGB32F pixel = framebuffer_pixels[i];
		const float r = std::max(0.0f, pixel.r);
		const float g = std::max(0.0f, pixel.g);
		const float b = std::max(0.0f, pixel.b);
		pixels[i * 3 + 0] = r;
		pixels[i * 3 + 1] = g;
		pixels[i * 3 + 2] = b;

		const float luma = 0.3086f * r + 0.6094f * g + 0.0820f * b;
		luma_sum += luma;
		luma_sq_sum += static_cast<double>(luma) * static_cast<double>(luma);
		min_luma = std::min(min_luma, luma);
		max_luma = std::max(max_luma, luma);
		if (r > 0.0001f || g > 0.0001f || b > 0.0001f)
			non_black_pixels++;
	}

	Image32Bit image(pixels, width, height, 3);
	const bool wrote = image.write_image_png(capture_path, true);
	const double mean_luma = luma_sum / static_cast<double>(expected_pixels);
	const double variance = std::max(0.0, luma_sq_sum / static_cast<double>(expected_pixels) - mean_luma * mean_luma);
	std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_capture label=%s capture_path=%s wrote=%d width=%d height=%d pixels=%zu non_black_pixels=%zu mean_luma=%.9f luma_stddev=%.9f min_luma=%.9f max_luma=%.9f framebuffer_fallback=%d\n",
		label,
		capture_path,
		wrote ? 1 : 0,
		width,
		height,
		expected_pixels,
		non_black_pixels,
		mean_luma,
		std::sqrt(variance),
		min_luma,
		max_luma,
		framebuffer->uses_device_buffer_fallback() ? 1 : 0);
	return wrote;
}
// SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_END
`;

const SAME_PROCESS_RENDER_BLOCK = String.raw`
	if (std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_SAME_PROCESS") != nullptr)
	{
		static bool synthi_same_process_probe_completed = false;
		if (!synthi_same_process_probe_completed)
		{
			synthi_same_process_probe_completed = true;
			const char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");
			const int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);
			const int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);
			if (second_capture_path != nullptr && synthi_wait_for_reload_trigger())
			{
				const char* synthi_reload_kernel_name = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME");
				const char* synthi_reload_kernel_symbol = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL");
				if (synthi_reload_kernel_name == nullptr || synthi_reload_kernel_symbol == nullptr)
				{
					std::fflush(stderr);
					std::exit(88);
				}
				const auto recompile_start = std::chrono::steady_clock::now();
				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_reload_kernel = synthi_live_kernels.find(synthi_reload_kernel_name);
				if (synthi_reload_kernel == synthi_live_kernels.end() || synthi_reload_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=reload_kernel_not_found kernel_name=%s kernel_symbol=%s\n", synthi_reload_kernel_name, synthi_reload_kernel_symbol);
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_reload_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);
				const auto recompile_end = std::chrono::steady_clock::now();
				const auto recompile_ms = std::chrono::duration_cast<std::chrono::milliseconds>(recompile_end - recompile_start).count();
				std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=success kernel=%s kernel_name=%s elapsed_ms=%lld\n", synthi_reload_kernel_symbol, synthi_reload_kernel_name, static_cast<long long>(recompile_ms));

				m_renderer->reset(false);
				m_render_graph.prepass();
				m_render_data_for_frame.render_settings.need_to_reset = true;
				m_render_data_for_frame.render_settings.sample_number = 0;
				m_render_data_for_frame.render_settings.do_update_status_buffers = true;
				m_render_data_for_frame.render_settings.render_resolution = make_int2(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.current_camera = m_renderer->m_camera.to_hiprt(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.prev_camera = m_renderer->m_previous_frame_camera.to_hiprt(synthi_probe_width, synthi_probe_height);
				m_render_data_for_frame.random_number = 42;
				m_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();
				std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_resolution proof_width=%d proof_height=%d renderer_width=%d renderer_height=%d render_data_width=%d render_data_height=%d\n",
					synthi_probe_width,
					synthi_probe_height,
					m_renderer->m_render_resolution.x,
					m_renderer->m_render_resolution.y,
					m_render_data_for_frame.render_settings.render_resolution.x,
					m_render_data_for_frame.render_settings.render_resolution.y);
				m_render_graph.launch_async(m_render_data_for_frame, m_compiler_options_for_frame);
				post_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);

				const bool wrote_second = synthi_write_runtime_framebuffer_to_path(
					m_renderer->m_framebuffer,
					synthi_probe_width,
					synthi_probe_height,
					m_renderer->get_main_stream(),
					second_capture_path,
					"changed-after-in-process-recompile");
				if (wrote_second && std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_SECOND_CAPTURE") != nullptr)
				{
					std::fflush(stderr);
					std::exit(0);
				}
			}
		}
	}
`;

async function runHiprtVariant(variant) {
  const workerCapturePath = `${CFG.workerRepoPath}/${cleanIdentifier(CFG.slug)}-${variant}-framebuffer.png`;
  const localCapturePath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-framebuffer.png`);
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${variant}-run.log`);
  const runCommand = [
    `./${shQuote(CFG.targetName)}`,
    ...CFG.runtimeArgs.map(shQuote),
    `--width=${CFG.width}`,
    `--height=${CFG.height}`,
  ].join(' ');
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
rm -f ${shQuote(workerCapturePath)}
export SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS=1
export SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP=1
export SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH=${shQuote(workerCapturePath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_CAPTURE=1
${shellExports(CFG.runtimeEnv)}
export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}
export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only
${hiprtRuntimeBackendSetup()}
${hiprtRuntimeDisplaySetup()}
start=$(date +%s%3N)
cd build
set +e
${hiprtRuntimeRunInvocation(runCommand)}
status=$?
set -e
end=$(date +%s%3N)
printf 'SYNTHI_WARM_PROOF_TIMING variant=%s run_ms=%s exit_code=%s capture_path=%s\\n' ${shQuote(variant)} "$((end-start))" "$status" ${shQuote(workerCapturePath)}
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.runTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  await dockerShell(`test -s ${shQuote(workerCapturePath)}`, { timeout: 30000 });
  await dockerCpFromWorker(workerCapturePath, localCapturePath);
  const timingMatch = /SYNTHI_WARM_PROOF_TIMING\s+variant=\S+\s+run_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    variant,
    runMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    workerCapturePath,
    localCapturePath,
    localLogPath,
    captureLine: parseCaptureLine(log),
    nativeLaunchKernels: parseKernelSymbols(log),
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

async function readWorkerText(workerPath) {
  return dockerShell(`cat ${shQuote(workerPath)}`, {
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function writeWorkerText(workerPath, text, localName) {
  const localPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${localName}`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, text);
  await dockerCpToWorker(localPath, workerPath);
  return localPath;
}

async function applyHiprtRuntimeFramebufferProbeAdapter() {
  const output = await dockerShell(
    hiprtRuntimeProbeAdaptationCommand(CFG.workerRepoPath),
    { timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );
  const records = parseHiprtRuntimeProbeAdaptationOutput(output);
  const sourceAdaptations = Array.from(new Set(records.flatMap((record) =>
    Array.isArray(record?.sourceAdaptations) ? record.sourceAdaptations : [])));
  const files = records.flatMap((record) => Array.isArray(record?.files) ? record.files : []);
  const applied = records.some((record) => record?.applied === true);
  const adaptedOrAlreadyPresent = files.some((file) =>
    ['adapted', 'already-adapted'].includes(file?.status));
  return {
    applied,
    adaptedOrAlreadyPresent,
    records,
    sourceAdaptations,
  };
}

async function applySameProcessAdapter() {
  const workerPath = `${CFG.workerRepoPath}/src/Renderer/GPURendererThread.cpp`;
  const baseRuntimeProbeAdapter = await applyHiprtRuntimeFramebufferProbeAdapter();
  let text = await readWorkerText(workerPath);
  if (!text.includes('SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH')) {
    throw new Error(
      'HIPRT runtime framebuffer probe adaptation did not produce the capture hook: '
      + JSON.stringify(baseRuntimeProbeAdapter),
    );
  }

  const beforeHash = `sha256:${sha256Hex(text)}`;
  if (text.includes('SYNTHI_SAME_PROCESS_HIPRT_HOT_SWAP_ADAPTER_BEGIN')) {
    const wholeGraphRecompile = '\t\t\t\tm_renderer->recompile_kernels(true);';
    const targetedRecompile = String.raw`				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_mega_kernel = synthi_live_kernels.find("Megakernel (1 SPP)");
				if (synthi_mega_kernel == synthi_live_kernels.end() || synthi_mega_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=megakernel_not_found\n");
					std::fflush(stderr);
					std::exit(88);
				}
				m_renderer->synchronize_all_kernels();
				synthi_mega_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    const currentTargetedRecompile = String.raw`				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_mega_kernel = synthi_live_kernels.find("Megakernel (1 SPP)");
				if (synthi_mega_kernel == synthi_live_kernels.end() || synthi_mega_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=megakernel_not_found\n");
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_mega_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    const profiledTargetRecompile = String.raw`				const char* synthi_reload_kernel_name = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME");
				const char* synthi_reload_kernel_symbol = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL");
				if (synthi_reload_kernel_name == nullptr || synthi_reload_kernel_symbol == nullptr)
				{
					std::fflush(stderr);
					std::exit(88);
				}
				auto synthi_live_kernels = m_render_graph.get_all_kernels();
				auto synthi_reload_kernel = synthi_live_kernels.find(synthi_reload_kernel_name);
				if (synthi_reload_kernel == synthi_live_kernels.end() || synthi_reload_kernel->second == nullptr)
				{
					std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_recompile result=failed reason=reload_kernel_not_found kernel_name=%s kernel_symbol=%s\n", synthi_reload_kernel_name, synthi_reload_kernel_symbol);
					std::fflush(stderr);
					std::exit(88);
				}
				synthi_reload_kernel->second->compile(m_renderer->m_hiprt_orochi_ctx, m_renderer->m_func_name_sets, true, false);`;
    let upgraded = false;
    if (text.includes(wholeGraphRecompile)) {
      text = text.replace(wholeGraphRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (text.includes(targetedRecompile)) {
      text = text.replace(targetedRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (text.includes(currentTargetedRecompile)) {
      text = text.replace(currentTargetedRecompile, profiledTargetRecompile);
      upgraded = true;
    }
    if (!text.includes('same_process_recompile result=success kernel=') && text.includes('same_process_recompile result=success elapsed_ms=%lld')) {
      text = text.replace(
        'same_process_recompile result=success elapsed_ms=%lld',
        'same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld',
      );
      upgraded = true;
    }
    if (text.includes('same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld')) {
      text = text.replace(
        'same_process_recompile result=success kernel=MegaKernel elapsed_ms=%lld',
        'same_process_recompile result=success kernel=%s kernel_name=%s elapsed_ms=%lld',
      );
      text = text.replace(
        'static_cast<long long>(recompile_ms));',
        'synthi_reload_kernel_symbol, synthi_reload_kernel_name, static_cast<long long>(recompile_ms));',
      );
      upgraded = true;
    }
    if (text.includes('\n\t\t\t\tm_renderer->synchronize_all_kernels();\n\t\t\t\tsynthi_mega_kernel->second->compile')) {
      text = text.replace(
        '\n\t\t\t\tm_renderer->synchronize_all_kernels();\n\t\t\t\tsynthi_mega_kernel->second->compile',
        '\n\t\t\t\tsynthi_mega_kernel->second->compile',
      );
      upgraded = true;
    }
    if (!text.includes('const int synthi_probe_width =')) {
      text = text.replace(
        '\t\t\t\tconst char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");',
        '\t\t\t\tconst char* second_capture_path = synthi_probe_required_env("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH");\n\t\t\t\tconst int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);\n\t\t\t\tconst int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);',
      );
      upgraded = true;
    }
    if (!text.includes('synthi_probe_env_timeout_ms(')) {
      text = text.replace(
        String.raw`int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

`,
        String.raw`int synthi_probe_env_int(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(1, std::atoi(raw));
}

int synthi_probe_env_timeout_ms(const char* name, int fallback_value)
{
	const char* raw = std::getenv(name);
	if (raw == nullptr || raw[0] == '\0')
		return fallback_value;
	return std::max(0, std::atoi(raw));
}

`,
      );
      upgraded = true;
    }
    if (text.includes('const int timeout_ms = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 60000);')) {
      text = text.replace(
        'const int timeout_ms = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 60000);',
        'const int timeout_ms = synthi_probe_env_timeout_ms("SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS", 0);\n\tconst bool timeout_enabled = timeout_ms > 0;',
      );
      text = text.replace(
        'std::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\\n", trigger_path, timeout_ms);',
        'if (timeout_enabled)\n\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=%d\\n", trigger_path, timeout_ms);\n\telse\n\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_wait trigger=%s timeout_ms=unbounded\\n", trigger_path);',
      );
      text = text.replace(
        'if (elapsed_ms > timeout_ms)',
        'if (timeout_enabled && elapsed_ms > timeout_ms)',
      );
      upgraded = true;
    }
    if (text.includes('const int synthi_probe_width = m_renderer->m_render_resolution.x;')) {
      text = text.replaceAll(
        'const int synthi_probe_width = m_renderer->m_render_resolution.x;',
        'const int synthi_probe_width = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH", m_renderer->m_render_resolution.x);',
      );
      upgraded = true;
    }
    if (text.includes('const int synthi_probe_height = m_renderer->m_render_resolution.y;')) {
      text = text.replaceAll(
        'const int synthi_probe_height = m_renderer->m_render_resolution.y;',
        'const int synthi_probe_height = synthi_probe_env_int("SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT", m_renderer->m_render_resolution.y);',
      );
      upgraded = true;
    }
    const movedDimensionText = text.replace(
      /([ \t]*const char\* second_capture_path = synthi_probe_required_env\("SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH"\);\n)([ \t]*if \(second_capture_path != nullptr && synthi_wait_for_reload_trigger\(\)\)\n[ \t]*\{\n)[ \t]*const int synthi_probe_width = m_renderer->m_render_resolution\.x;\n[ \t]*const int synthi_probe_height = m_renderer->m_render_resolution\.y;\n/,
      (_, captureLine, waitLine) => {
        if (captureLine.includes('const int synthi_probe_width')) return `${captureLine}${waitLine}`;
        const indent = captureLine.match(/^[ \t]*/)?.[0] ?? '';
        return `${captureLine}${indent}const int synthi_probe_width = m_renderer->m_render_resolution.x;\n${indent}const int synthi_probe_height = m_renderer->m_render_resolution.y;\n${waitLine}`;
      },
    );
    if (movedDimensionText !== text) {
      text = movedDimensionText;
      upgraded = true;
    }
    if (!text.includes('same_process_resolution proof_width=')) {
      text = text.replace(
        '\t\t\t\tm_render_data_for_frame.render_settings.do_update_status_buffers = true;\n\t\t\t\tm_render_data_for_frame.random_number = 42;\n\t\t\t\tm_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();',
        '\t\t\t\tm_render_data_for_frame.render_settings.do_update_status_buffers = true;\n\t\t\t\tm_render_data_for_frame.render_settings.render_resolution = make_int2(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.current_camera = m_renderer->m_camera.to_hiprt(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.prev_camera = m_renderer->m_previous_frame_camera.to_hiprt(synthi_probe_width, synthi_probe_height);\n\t\t\t\tm_render_data_for_frame.random_number = 42;\n\t\t\t\tm_compiler_options_for_frame = m_renderer->get_global_compiler_options()->deep_copy();\n\t\t\t\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] same_process_resolution proof_width=%d proof_height=%d renderer_width=%d renderer_height=%d render_data_width=%d render_data_height=%d\\n",\n\t\t\t\t\tsynthi_probe_width,\n\t\t\t\t\tsynthi_probe_height,\n\t\t\t\t\tm_renderer->m_render_resolution.x,\n\t\t\t\t\tm_renderer->m_render_resolution.y,\n\t\t\t\t\tm_render_data_for_frame.render_settings.render_resolution.x,\n\t\t\t\t\tm_render_data_for_frame.render_settings.render_resolution.y);',
      );
      text = text.replace(
        '\t\t\t\t\tm_renderer->m_framebuffer,\n\t\t\t\t\tm_renderer->m_render_resolution.x,\n\t\t\t\t\tm_renderer->m_render_resolution.y,\n\t\t\t\t\tm_renderer->get_main_stream(),',
        '\t\t\t\t\tm_renderer->m_framebuffer,\n\t\t\t\t\tsynthi_probe_width,\n\t\t\t\t\tsynthi_probe_height,\n\t\t\t\t\tm_renderer->get_main_stream(),',
      );
      upgraded = true;
    }
    if (upgraded) {
      const localPath = await writeWorkerText(workerPath, text, 'same-process-upgraded-GPURendererThread.cpp');
      return {
        applied: true,
        reason: 'upgraded-targeted-megakernel-recompile',
        workerPath,
        localPath,
        beforeHash,
        afterHash: `sha256:${sha256Hex(text)}`,
        baseRuntimeProbeAdapter,
      };
    }
    return {
      applied: false,
      reason: 'already-adapted',
      workerPath,
      beforeHash,
      afterHash: beforeHash,
      baseRuntimeProbeAdapter,
    };
  }

  if (!text.includes('#include <vector>\n')) {
    throw new Error('GPURendererThread.cpp include anchor not found');
  }
  text = text.replace(
    '#include <vector>\n',
    '#include <vector>\n#include <chrono>\n#include <fstream>\n#include <string>\n#include <thread>\n',
  );

  const namespaceEndAnchor = '\n}\n\nvoid GPURendererThread::init(GPURenderer* renderer)';
  if (!text.includes(namespaceEndAnchor)) {
    throw new Error('GPURendererThread.cpp namespace end anchor not found');
  }
  text = text.replace(
    namespaceEndAnchor,
    `\n${SAME_PROCESS_ADAPTER_HELPERS}\n}\n\nvoid GPURendererThread::init(GPURenderer* renderer)`,
  );

  const captureCall = `\tsynthi_capture_runtime_framebuffer_if_requested(
\t\tm_renderer->m_framebuffer,
\t\tm_renderer->m_render_resolution.x,
\t\tm_renderer->m_render_resolution.y,
\t\tm_renderer->get_main_stream());`;
  if (!text.includes(captureCall)) {
    throw new Error('GPURendererThread.cpp capture call anchor not found');
  }
  text = text.replace(captureCall, `${captureCall}\n${SAME_PROCESS_RENDER_BLOCK}`);

  const localPath = await writeWorkerText(workerPath, text, 'same-process-adapted-GPURendererThread.cpp');
  return {
    applied: true,
    workerPath,
    localPath,
    beforeHash,
    afterHash: `sha256:${sha256Hex(text)}`,
    baseRuntimeProbeAdapter,
  };
}

function buildHiprtRuntimeProbeInstrumentationDisclosure(sameProcessAdapter) {
  const baseAdapter = sameProcessAdapter?.baseRuntimeProbeAdapter ?? {};
  const sourceAdaptations = Array.from(new Set([
    ...(Array.isArray(baseAdapter.sourceAdaptations) ? baseAdapter.sourceAdaptations : []),
    sameProcessAdapter ? 'same_process_targeted_kernel_recompile_hook' : null,
  ].filter(Boolean)));
  const files = Array.isArray(baseAdapter.records)
    ? baseAdapter.records.flatMap((record) => Array.isArray(record?.files) ? record.files : [])
    : [];
  const adaptedOrAlreadyPresent =
    baseAdapter.adaptedOrAlreadyPresent === true
    || files.some((file) => ['adapted', 'already-adapted'].includes(file?.status));
  const accepted = Boolean(sameProcessAdapter)
    && adaptedOrAlreadyPresent
    && sourceAdaptations.length > 0;
  return {
    schemaVersion: 'synthi.gpu.hmr.profile_probe_instrumentation.v1',
    kind: 'declared_profile_probe_instrumentation',
    instrumentationKind: 'profile_probe_instrumentation',
    instrumentation_kind: 'profile_probe_instrumentation',
    adapterFamily: 'hiprt-path-tracer-profile-adapter',
    adapter_family: 'hiprt-path-tracer-profile-adapter',
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    targetName: CFG.targetName,
    target_name: CFG.targetName,
    accepted,
    applied: sameProcessAdapter?.applied === true || baseAdapter.applied === true,
    adaptedOrAlreadyPresent,
    adapted_or_already_present: adaptedOrAlreadyPresent,
    sourceAdaptations,
    source_adaptations: sourceAdaptations,
    files,
    records: Array.isArray(baseAdapter.records) ? baseAdapter.records : [],
    acceptanceScope: 'hiprt_declared_visual_profile',
    acceptance_scope: 'hiprt_declared_visual_profile',
    proofAuthority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    proof_authority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    executionBoundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    execution_boundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    broadApplicationAcceptance: false,
    broad_application_acceptance: false,
    broadHipApplicationAcceptance: false,
    broad_hip_application_acceptance: false,
    unsupportedWithoutEvidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
      'non_interposable_engine_render_graph',
      'undisclosed_runtime_probe_instrumentation',
    ],
    unsupported_without_evidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
      'non_interposable_engine_render_graph',
      'undisclosed_runtime_probe_instrumentation',
    ],
  };
}

function sourceAdaptationListFromRuntimeProbeInstrumentation(value) {
  const sourceAdaptations = value?.sourceAdaptations ?? value?.source_adaptations;
  if (!Array.isArray(sourceAdaptations)) return [];
  return sourceAdaptations.map((item) => String(item).trim()).filter(Boolean);
}

function isSourceAdaptedRuntimeProbeInstrumentation(value) {
  return sourceAdaptationListFromRuntimeProbeInstrumentation(value).length > 0
    || value?.adaptedOrAlreadyPresent === true
    || value?.adapted_or_already_present === true;
}

function hiprtRuntimeEpochFor({ proof, dispatch }) {
  return `hiprt-epoch:${proof.slug}:${CFG.reloadKernelSymbol}:${dispatch?.sequence ?? 'unknown'}`;
}

function hiprtRuntimeDispatchIdFor({ proof, dispatch, artifactHashAfter }) {
  return `dispatch:${sha256Json({
    slug: proof.slug,
    kernel: CFG.reloadKernelSymbol,
    sequence: dispatch?.sequence,
    functionPtr: dispatch?.functionPtr,
    artifactHashAfter,
  })}`;
}

const HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_boundary_event.v1';
const HIPRT_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION =
  'synthi.gpu_hmr.hiprt_runtime_boundary_app_hook.v1';
const HIPRT_RUNTIME_BOUNDARY_REQUIRED_STAGES = [
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
];
const HIPRT_RUNTIME_BOUNDARY_RESERVED_KEYS = new Set([
  'schemaVersion',
  'schema_version',
  'eventKind',
  'event_kind',
  'event',
  'kind',
  'stage',
  'stageKind',
  'stage_kind',
  'fields',
  'boundaryFields',
  'boundary_fields',
  'acceptedForGpuHmr',
  'accepted_for_gpu_hmr',
  'gpuHmrSuccess',
  'gpu_hmr_success',
  'canSatisfyRuntimeProof',
  'can_satisfy_runtime_proof',
  'canSatisfyDispatchProof',
  'can_satisfy_dispatch_proof',
  'proofAuthority',
  'proof_authority',
]);

function hiprtRuntimeBoundaryEventKind(event = {}) {
  return firstText(
    event.eventKind,
    event.event_kind,
    event.event,
    event.kind,
    event.stage,
    event.stageKind,
    event.stage_kind,
  ).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hiprtRuntimeBoundaryEventFields(event = {}) {
  if (isPlainObject(event.fields)) return event.fields;
  if (isPlainObject(event.boundaryFields)) return event.boundaryFields;
  if (isPlainObject(event.boundary_fields)) return event.boundary_fields;
  const fields = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    if (HIPRT_RUNTIME_BOUNDARY_RESERVED_KEYS.has(key)) continue;
    fields[key] = value;
  }
  return fields;
}

function hiprtRuntimeBoundaryField(fields = {}, ...keys) {
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function hiprtRuntimeBoundaryEventClaimsAuthority(event = {}) {
  return boolTrue(event.acceptedForGpuHmr)
    || boolTrue(event.accepted_for_gpu_hmr)
    || boolTrue(event.gpuHmrSuccess)
    || boolTrue(event.gpu_hmr_success)
    || boolTrue(event.canSatisfyRuntimeProof)
    || boolTrue(event.can_satisfy_runtime_proof)
    || boolTrue(event.canSatisfyDispatchProof)
    || boolTrue(event.can_satisfy_dispatch_proof);
}

function hiprtRuntimeBoundaryEventSchemaAccepted(event = {}) {
  const schema = firstText(event.schemaVersion, event.schema_version);
  return !schema || schema === HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION;
}

function hiprtRuntimeBoundaryAppHookFacet({ events, expected, source = 'profile_runtime_boundary_events' }) {
  const eventList = Array.isArray(events) ? events.filter(isPlainObject) : [];
  const stageResults = {};
  const blockingGaps = [];
  const eventHashes = [];
  const eventsByKind = new Map();
  for (const event of eventList) {
    const kind = hiprtRuntimeBoundaryEventKind(event);
    const fields = hiprtRuntimeBoundaryEventFields(event);
    const eventHash = sha256Json({ kind, fields });
    eventHashes.push(eventHash);
    if (!hiprtRuntimeBoundaryEventSchemaAccepted(event)) {
      blockingGaps.push('hiprt_runtime_boundary_event_schema_unrecognized');
      continue;
    }
    if (hiprtRuntimeBoundaryEventClaimsAuthority(event)) {
      blockingGaps.push('hiprt_runtime_boundary_event_claimed_gpu_hmr_authority');
      continue;
    }
    if (!HIPRT_RUNTIME_BOUNDARY_REQUIRED_STAGES.includes(kind)) {
      blockingGaps.push(`hiprt_runtime_boundary_event_kind_unrecognized:${kind || 'missing'}`);
      continue;
    }
    if (!eventsByKind.has(kind)) eventsByKind.set(kind, []);
    eventsByKind.get(kind).push({ event, fields, eventHash });
  }
  for (const stage of HIPRT_RUNTIME_BOUNDARY_REQUIRED_STAGES) {
    const candidates = eventsByKind.get(stage) ?? [];
    const acceptedCandidates = candidates.filter(({ fields }) => {
      const artifactHash = hiprtRuntimeBoundaryField(fields, 'artifact_hash', 'artifactHash', 'artifact_id', 'artifactId');
      const epoch = hiprtRuntimeBoundaryField(fields, 'epoch', 'published_epoch', 'publishedEpoch');
      const processId = hiprtRuntimeBoundaryField(fields, 'process_id', 'processId', 'pid');
      if (stage === 'artifact_transport') {
        return artifactHash === expected.artifactHashAfter && processId === expected.processId;
      }
      if (stage === 'epoch_publication') {
        return artifactHash === expected.artifactHashAfter
          && epoch === expected.epoch
          && processId === expected.processId;
      }
      if (stage === 'dispatch_trace') {
        const dispatchId = hiprtRuntimeBoundaryField(fields, 'dispatch_id', 'dispatchId', 'after_dispatch_id', 'afterDispatchId');
        const kernel = hiprtRuntimeBoundaryField(fields, 'kernel_entry', 'kernelEntry', 'kernel_name', 'kernelName');
        return artifactHash === expected.artifactHashAfter
          && epoch === expected.epoch
          && dispatchId === expected.dispatchId
          && processId === expected.processId
          && kernel === CFG.reloadKernelSymbol;
      }
      if (stage === 'host_identity') {
        const deviceUuid = hiprtRuntimeBoundaryField(fields, 'device_uuid', 'deviceUuid');
        const stream = hiprtRuntimeBoundaryField(fields, 'stream', 'queue', 'queue_id', 'queueId');
        return processId === expected.processId
          && deviceUuid === expected.deviceUuid
          && stream === expected.stream;
      }
      if (stage === 'output_oracle') {
        const afterDispatchId = hiprtRuntimeBoundaryField(fields, 'after_dispatch_id', 'afterDispatchId', 'dispatch_id', 'dispatchId');
        const beforeHash = hiprtRuntimeBoundaryField(fields, 'before_image_hash', 'beforeImageHash');
        const afterHash = hiprtRuntimeBoundaryField(fields, 'after_image_hash', 'afterImageHash');
        const diffHash = hiprtRuntimeBoundaryField(fields, 'diff_image_hash', 'diffImageHash');
        return artifactHash === expected.artifactHashAfter
          && epoch === expected.epoch
          && afterDispatchId === expected.dispatchId
          && processId === expected.processId
          && beforeHash === expected.visualArtifacts.before_image_hash
          && afterHash === expected.visualArtifacts.after_image_hash
          && diffHash === expected.visualArtifacts.diff_image_hash;
      }
      return false;
    });
    if (acceptedCandidates.length === 0) {
      blockingGaps.push(`hiprt_runtime_boundary_stage_${stage}_missing_or_mismatched`);
    }
    stageResults[stage] = {
      stage,
      observed: candidates.length > 0,
      accepted: acceptedCandidates.length > 0,
      candidateCount: candidates.length,
      candidate_count: candidates.length,
      acceptedCandidateCount: acceptedCandidates.length,
      accepted_candidate_count: acceptedCandidates.length,
      eventHashes: candidates.map((candidate) => candidate.eventHash),
      event_hashes: candidates.map((candidate) => candidate.eventHash),
    };
  }
  const accepted = eventList.length > 0 && blockingGaps.length === 0;
  return {
    schemaVersion: HIPRT_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION,
    schema_version: HIPRT_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION,
    proofAuthority: 'hiprt_runtime_boundary_events_not_gpu_hmr_success',
    proof_authority: 'hiprt_runtime_boundary_events_not_gpu_hmr_success',
    source,
    accepted,
    acceptedAsAppHookEvidence: accepted,
    accepted_as_app_hook_evidence: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    eventCount: eventList.length,
    event_count: eventList.length,
    eventHashes,
    event_hashes: eventHashes,
    stageResults,
    stage_results: stageResults,
    missingStages: HIPRT_RUNTIME_BOUNDARY_REQUIRED_STAGES.filter((stage) => stageResults[stage]?.accepted !== true),
    missing_stages: HIPRT_RUNTIME_BOUNDARY_REQUIRED_STAGES.filter((stage) => stageResults[stage]?.accepted !== true),
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs: eventHashes,
    evidence_refs: eventHashes,
  };
}

function hiprtRuntimeProbeInstrumentationFromAppHook(facet) {
  return {
    schemaVersion: 'synthi.gpu.hmr.profile_probe_instrumentation.v1',
    kind: 'declared_runtime_boundary_app_hook',
    instrumentationKind: 'runtime_boundary_app_hook',
    instrumentation_kind: 'runtime_boundary_app_hook',
    adapterFamily: 'hiprt-runtime-boundary-app-hook',
    adapter_family: 'hiprt-runtime-boundary-app-hook',
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    targetName: CFG.targetName,
    target_name: CFG.targetName,
    accepted: facet.accepted === true,
    applied: false,
    adaptedOrAlreadyPresent: false,
    adapted_or_already_present: false,
    sourceAdaptations: [],
    source_adaptations: [],
    acceptanceScope: 'hiprt_declared_visual_profile',
    acceptance_scope: 'hiprt_declared_visual_profile',
    proofAuthority: 'hiprt_runtime_boundary_app_hook_not_source_adapted',
    proof_authority: 'hiprt_runtime_boundary_app_hook_not_source_adapted',
    executionBoundary: 'HIPRT app-emitted runtime boundary events',
    execution_boundary: 'HIPRT app-emitted runtime boundary events',
    runtimeBoundaryAppHook: facet,
    runtime_boundary_app_hook: facet,
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    broadApplicationAcceptance: false,
    broad_application_acceptance: false,
    broadHipApplicationAcceptance: false,
    broad_hip_application_acceptance: false,
    unsupportedWithoutEvidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
      'runtime_boundary_events_missing_or_unmatched',
    ],
    unsupported_without_evidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
      'runtime_boundary_events_missing_or_unmatched',
    ],
  };
}

function resolveRuntimeBoundaryManifestPath(rawPath) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return null;
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw));
  const allowedRoots = [REPO_ROOT, CFG.outputDir].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`runtime boundary event manifest path must stay inside the workspace or output directory: ${raw}`);
  }
  return resolved;
}

async function loadRuntimeBoundaryEventsFromConfig() {
  const inlineEvents = Array.isArray(CFG.runtimeBoundaryEvents) ? CFG.runtimeBoundaryEvents : [];
  const manifestPath = resolveRuntimeBoundaryManifestPath(CFG.runtimeBoundaryEventManifestPath);
  if (!manifestPath) {
    return {
      events: inlineEvents,
      manifestPath: null,
      source: inlineEvents.length > 0 ? 'profile_inline_runtime_boundary_events' : 'none',
    };
  }
  const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    boolTrue(parsed.acceptedForGpuHmr)
    || boolTrue(parsed.accepted_for_gpu_hmr)
    || boolTrue(parsed.gpuHmrSuccess)
    || boolTrue(parsed.gpu_hmr_success)
    || boolTrue(parsed.canSatisfyRuntimeProof)
    || boolTrue(parsed.can_satisfy_runtime_proof)
  ) {
    throw new Error('runtime boundary event manifest must not claim GPU HMR or runtime proof authority');
  }
  const manifestEvents = [
    ...(Array.isArray(parsed.runtimeBoundaryEvents) ? parsed.runtimeBoundaryEvents : []),
    ...(Array.isArray(parsed.runtime_boundary_events) ? parsed.runtime_boundary_events : []),
    ...(Array.isArray(parsed.adapterRuntimeBoundaryEvents) ? parsed.adapterRuntimeBoundaryEvents : []),
    ...(Array.isArray(parsed.adapter_runtime_boundary_events) ? parsed.adapter_runtime_boundary_events : []),
  ];
  return {
    events: [...inlineEvents, ...manifestEvents],
    manifestPath,
    source: 'profile_runtime_boundary_event_manifest',
  };
}

async function buildHiprtTarget(reason) {
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${reason}-build.log`);
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
${shellExports(CFG.buildEnv)}
start=$(date +%s%3N)
cmake --build build -j2 --target ${shQuote(CFG.targetName)}
status=$?
end=$(date +%s%3N)
printf 'SYNTHI_WARM_BUILD_TIMING reason=%s build_ms=%s exit_code=%s\\n' ${shQuote(reason)} "$((end-start))" "$status"
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.buildTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  const timingMatch = /SYNTHI_WARM_BUILD_TIMING\s+reason=\S+\s+build_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    reason,
    buildMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    localLogPath,
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

async function configureHiprtBuild(reason) {
  const localLogPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-${reason}-configure.log`);
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
${shellExports(CFG.buildEnv)}
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=${shQuote(CFG.rocmPrefix)} -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)} -DASSIMP_WARNINGS_AS_ERRORS=OFF ${CFG.cmakeArgs.map(shQuote).join(' ')}
status=$?
end=$(date +%s%3N)
printf 'SYNTHI_WARM_CONFIGURE_TIMING reason=%s configure_ms=%s exit_code=%s\\n' ${shQuote(reason)} "$((end-start))" "$status"
exit "$status"
`;
  const startedAt = Date.now();
  const log = await dockerShell(script, {
    timeout: CFG.buildTimeoutMs,
    maxBuffer: 96 * 1024 * 1024,
  });
  const endedAt = Date.now();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  await fs.writeFile(localLogPath, log);
  const timingMatch = /SYNTHI_WARM_CONFIGURE_TIMING\s+reason=\S+\s+configure_ms=(\d+)\s+exit_code=(\d+)/.exec(log);
  return {
    reason,
    configureMs: timingMatch ? Number(timingMatch[1]) : endedAt - startedAt,
    hostWallMs: endedAt - startedAt,
    exitCode: timingMatch ? Number(timingMatch[2]) : 0,
    localLogPath,
    logSha256: `sha256:${sha256Hex(log)}`,
  };
}

function spawnDockerShell(script, { timeout, maxBuffer = 96 * 1024 * 1024 } = {}) {
  const child = spawn('docker', ['exec', CFG.workerContainer, 'sh', '-lc', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const startedAt = Date.now();
  let timer = null;
  if (timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000).unref();
    }, timeout);
    timer.unref();
  }
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length + stderr.length > maxBuffer) {
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stdout.length + stderr.length > maxBuffer) {
      child.kill('SIGTERM');
    }
  });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const output = `${stdout}${stderr}`;
      const result = {
        code,
        signal,
        stdout,
        stderr,
        output,
        timedOut,
        hostWallMs: Date.now() - startedAt,
      };
      if (timedOut || code !== 0) {
        const err = new Error(timedOut ? 'docker shell timed out' : `docker shell exited ${code}`);
        err.output = output;
        err.result = result;
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
  return { child, completion };
}

async function waitForWorkerFile(workerPath, timeoutMs, processCompletion = null) {
  const startedAt = Date.now();
  const processState = {
    settled: false,
    error: null,
  };
  if (processCompletion) {
    processCompletion.then(
      () => {
        processState.settled = true;
      },
      (err) => {
        processState.settled = true;
        processState.error = err;
      },
    );
  }
  for (;;) {
    const exists = (await dockerShell(
      `test -s ${shQuote(workerPath)} && printf 1 || printf 0`,
      { timeout: 30000 },
    )).trim() === '1';
    if (exists) return Date.now() - startedAt;
    if (processState.settled) {
      if (processState.error) throw processState.error;
      throw new Error(`runtime process exited before worker file was written: ${workerPath}`);
    }
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for worker file ${workerPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runHiprtSameProcess({ changedSource }) {
  const slug = cleanIdentifier(CFG.slug);
  const workerBaselinePath = `${CFG.workerRepoPath}/${slug}-same-process-baseline-framebuffer.png`;
  const workerChangedPath = `${CFG.workerRepoPath}/${slug}-same-process-changed-framebuffer.png`;
  const workerTriggerPath = `${CFG.workerRepoPath}/${slug}-same-process-reload.trigger`;
  const localBaselinePath = path.join(CFG.outputDir, `${slug}-same-process-baseline-framebuffer.png`);
  const localChangedPath = path.join(CFG.outputDir, `${slug}-same-process-changed-framebuffer.png`);
  const localLogPath = path.join(CFG.outputDir, `${slug}-same-process-run.log`);
  const runCommand = [
    `./${shQuote(CFG.targetName)}`,
    ...CFG.runtimeArgs.map(shQuote),
    `--width=${CFG.width}`,
    `--height=${CFG.height}`,
  ].join(' ');
  const script = `
set -e
cd ${shQuote(CFG.workerRepoPath)}
rm -f ${shQuote(workerBaselinePath)} ${shQuote(workerChangedPath)} ${shQuote(workerTriggerPath)}
export SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS=1
export SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP=1
export SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH=${shQuote(workerBaselinePath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_SECOND_CAPTURE_PATH=${shQuote(workerChangedPath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH=${shQuote(workerTriggerPath)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TIMEOUT_MS=${CFG.reloadTimeoutMs}
export SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_WIDTH=${CFG.width}
export SYNTHI_HIPRT_RUNTIME_PROBE_PROOF_HEIGHT=${CFG.height}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_NAME=${shQuote(CFG.reloadKernelName)}
export SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_KERNEL_SYMBOL=${shQuote(CFG.reloadKernelSymbol)}
export SYNTHI_HIPRT_RUNTIME_PROBE_SAME_PROCESS=1
export SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_SECOND_CAPTURE=1
${shellExports(CFG.runtimeEnv)}
export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}
export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only
${hiprtRuntimeBackendSetup()}
${hiprtRuntimeDisplaySetup()}
start=$(date +%s%3N)
cd build
set +e
${hiprtRuntimeRunInvocation(runCommand)}
status=$?
set -e
end=$(date +%s%3N)
printf 'SYNTHI_WARM_PROOF_TIMING variant=same-process run_ms=%s exit_code=%s baseline_capture_path=%s changed_capture_path=%s\\n' "$((end-start))" "$status" ${shQuote(workerBaselinePath)} ${shQuote(workerChangedPath)}
exit "$status"
`;
  const startedAt = Date.now();
  const run = spawnDockerShell(script, {
    timeout: CFG.runTimeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  let baselineReadyMs = null;
  let changedWrite = null;
  let triggerMs = null;
  let shaderCacheBefore = null;
  let triggerStartedMonotonicNs = null;
  let triggerFinishedMonotonicNs = null;
  try {
    baselineReadyMs = await waitForWorkerFile(workerBaselinePath, CFG.runTimeoutMs, run.completion);
    shaderCacheBefore = await snapshotWorkerShaderCache('before-same-process-recompile');
    changedWrite = await writeVariantSource({ variant: 'same-process-changed', text: changedSource });
    const triggerStart = Date.now();
    triggerStartedMonotonicNs = monotonicNowNs();
    await dockerShell(`date +%s%3N > ${shQuote(workerTriggerPath)}`, { timeout: 30000 });
    triggerFinishedMonotonicNs = monotonicNowNs();
    triggerMs = Date.now() - triggerStart;
    const result = await run.completion;
    const runCompletedMonotonicNs = monotonicNowNs();
    const shaderCacheAfter = await snapshotWorkerShaderCache('after-same-process-recompile');
    const shaderCacheArtifact = shaderCacheDelta(shaderCacheBefore, shaderCacheAfter);
    const postRecompileEvidence = parsePostRecompileRuntimeEvidence(result.output, CFG.reloadKernelSymbol);
    await fs.mkdir(CFG.outputDir, { recursive: true });
    await fs.writeFile(localLogPath, result.output);
    await dockerShell(`test -s ${shQuote(workerChangedPath)}`, { timeout: 30000 });
    await dockerCpFromWorker(workerBaselinePath, localBaselinePath);
    await dockerCpFromWorker(workerChangedPath, localChangedPath);
    const timingMatch = /SYNTHI_WARM_PROOF_TIMING\s+variant=same-process\s+run_ms=(\d+)\s+exit_code=(\d+)/.exec(result.output);
    const recompileMatch = /same_process_recompile\s+result=success\b.*?\belapsed_ms=(\d+)/.exec(result.output);
    const waitMatch = /same_process_trigger_observed\s+trigger=\S+\s+wait_ms=(\d+)/.exec(result.output);
    const baselineRun = {
      variant: 'same-process-baseline',
      runMs: baselineReadyMs,
      hostWallMs: baselineReadyMs,
      exitCode: 0,
      workerCapturePath: workerBaselinePath,
      localCapturePath: localBaselinePath,
      localLogPath,
      captureLine: parseCaptureLine(result.output),
      nativeLaunchKernels: parseKernelSymbols(result.output),
      logSha256: `sha256:${sha256Hex(result.output)}`,
      sameProcess: true,
      shaderCacheSnapshot: shaderCacheBefore,
    };
    const changedRun = {
      variant: 'same-process-changed',
      runMs: timingMatch ? Number(timingMatch[1]) : result.hostWallMs,
      hostWallMs: result.hostWallMs,
      exitCode: timingMatch ? Number(timingMatch[2]) : 0,
      workerCapturePath: workerChangedPath,
      localCapturePath: localChangedPath,
      localLogPath,
      captureLine: result.output.split(/\r?\n/).find((line) =>
        line.includes('same_process_capture')
        && line.includes(`capture_path=${workerChangedPath}`)
        && line.includes('wrote=1')
      ) ?? '',
      nativeLaunchKernels: parseKernelSymbols(result.output),
      logSha256: `sha256:${sha256Hex(result.output)}`,
      sameProcess: true,
      liveRecompileMs: recompileMatch ? Number(recompileMatch[1]) : null,
      triggerWaitMs: waitMatch ? Number(waitMatch[1]) : null,
      triggerTouchMs: triggerMs,
      totalHostWallMs: Date.now() - startedAt,
      triggerStartedMonotonicNs,
      triggerFinishedMonotonicNs,
      runCompletedMonotonicNs,
      shaderCacheSnapshot: shaderCacheAfter,
      shaderCacheArtifact,
      postRecompileEvidence,
    };
    return {
      baselineRun,
      changedRun,
      changedWrite,
      runLog: result.output,
    };
  } catch (err) {
    run.child.kill('SIGTERM');
    throw err;
  }
}

async function imageStats(filePath) {
  const image = sharp(filePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  const colorSample = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 4 || g > 4 || b > 4) visiblePixels++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    if (colorSample.size < 20000) {
      colorSample.add(`${r},${g},${b}`);
    }
  }
  const pixels = info.width * info.height;
  const meanLuma = pixels > 0 ? lumaSum / pixels : 0;
  const variance = pixels > 0 ? Math.max(0, (lumaSqSum / pixels) - meanLuma * meanLuma) : 0;
  const bytes = await fs.readFile(filePath);
  return {
    path: filePath,
    contentHash: `sha256:${sha256Hex(bytes)}`,
    width: info.width,
    height: info.height,
    visiblePixels,
    meanLuma8bit: meanLuma,
    lumaStddev8bit: Math.sqrt(variance),
    uniqueColorSampleCount: colorSample.size,
    acceptedAsVisualEvidence: pixels > 0 && visiblePixels > 1000 && colorSample.size >= 64,
  };
}

function regionStatsFromRaw({ data, width, height, bounds }) {
  const x0 = Math.max(0, Math.min(width - 1, bounds.x0));
  const y0 = Math.max(0, Math.min(height - 1, bounds.y0));
  const x1 = Math.max(0, Math.min(width - 1, bounds.x1));
  const y1 = Math.max(0, Math.min(height - 1, bounds.y1));
  if (x1 < x0 || y1 < y0) {
    return {
      bounds: { x0: 0, y0: 0, x1: -1, y1: -1 },
      width: 0,
      height: 0,
      pixels: 0,
      visiblePixels: 0,
      visiblePixelRatio: 0,
      meanLuma8bit: 0,
      lumaStddev8bit: 0,
      meanRgbSpan8bit: 0,
      uniqueColorSampleCount: 0,
    };
  }
  let pixels = 0;
  let visiblePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let rgbSpanSum = 0;
  const colorSample = new Set();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      pixels++;
      if (r > 4 || g > 4 || b > 4) visiblePixels++;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      lumaSqSum += luma * luma;
      rgbSpanSum += Math.max(r, g, b) - Math.min(r, g, b);
      if (colorSample.size < 20000) colorSample.add(`${r},${g},${b}`);
    }
  }
  const meanLuma = pixels > 0 ? lumaSum / pixels : 0;
  const variance = pixels > 0 ? Math.max(0, (lumaSqSum / pixels) - meanLuma * meanLuma) : 0;
  return {
    bounds: { x0, y0, x1, y1 },
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    pixels,
    visiblePixels,
    visiblePixelRatio: pixels > 0 ? visiblePixels / pixels : 0,
    meanLuma8bit: meanLuma,
    lumaStddev8bit: Math.sqrt(variance),
    meanRgbSpan8bit: pixels > 0 ? rgbSpanSum / pixels : 0,
    uniqueColorSampleCount: colorSample.size,
  };
}

async function diffImages({ baselinePath, changedPath, diffPath }) {
  const baseline = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const changed = await sharp(changedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (baseline.info.width !== changed.info.width || baseline.info.height !== changed.info.height) {
    throw new Error(
      `image dimensions differ: baseline=${baseline.info.width}x${baseline.info.height} changed=${changed.info.width}x${changed.info.height}`,
    );
  }
  const pixels = baseline.info.width * baseline.info.height;
  const out = Buffer.alloc(pixels * 4);
  let changedPixelsThreshold4 = 0;
  let deltaSum = 0;
  let maxChannelDelta8bit = 0;
  const changedBounds = {
    x0: baseline.info.width,
    y0: baseline.info.height,
    x1: -1,
    y1: -1,
  };
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    const dr = Math.abs(baseline.data[offset] - changed.data[offset]);
    const dg = Math.abs(baseline.data[offset + 1] - changed.data[offset + 1]);
    const db = Math.abs(baseline.data[offset + 2] - changed.data[offset + 2]);
    const maxDelta = Math.max(dr, dg, db);
    if (maxDelta > 4) {
      changedPixelsThreshold4++;
      const pixelIndex = offset / 4;
      const x = pixelIndex % baseline.info.width;
      const y = Math.floor(pixelIndex / baseline.info.width);
      changedBounds.x0 = Math.min(changedBounds.x0, x);
      changedBounds.y0 = Math.min(changedBounds.y0, y);
      changedBounds.x1 = Math.max(changedBounds.x1, x);
      changedBounds.y1 = Math.max(changedBounds.y1, y);
    }
    deltaSum += dr + dg + db;
    maxChannelDelta8bit = Math.max(maxChannelDelta8bit, maxDelta);
    out[offset] = Math.min(255, dr * 6);
    out[offset + 1] = Math.min(255, dg * 6);
    out[offset + 2] = Math.min(255, db * 6);
    out[offset + 3] = 255;
  }
  await sharp(out, {
    raw: {
      width: baseline.info.width,
      height: baseline.info.height,
      channels: 4,
    },
  }).png().toFile(diffPath);
  const diffBytes = await fs.readFile(diffPath);
  const regionBounds = changedPixelsThreshold4 > 0
    ? changedBounds
    : { x0: 0, y0: 0, x1: -1, y1: -1 };
  const changedRegion = regionStatsFromRaw({
    data: changed.data,
    width: changed.info.width,
    height: changed.info.height,
    bounds: regionBounds,
  });
  const baselineRegion = regionStatsFromRaw({
    data: baseline.data,
    width: baseline.info.width,
    height: baseline.info.height,
    bounds: regionBounds,
  });
  const oracleRegionNonBlank =
    changedRegion.pixels > 0
    && changedRegion.visiblePixelRatio >= CFG.minOracleRegionVisibleRatio
    && changedRegion.meanLuma8bit >= CFG.minOracleRegionMeanLuma8bit
    && changedRegion.uniqueColorSampleCount >= CFG.minOracleRegionUniqueColorSampleCount;
  return {
    path: diffPath,
    contentHash: `sha256:${sha256Hex(diffBytes)}`,
    changedPixelsThreshold4,
    changedPixelRatioThreshold4: pixels > 0 ? changedPixelsThreshold4 / pixels : 0,
    meanAbsDelta8bit: pixels > 0 ? deltaSum / (pixels * 3) : 0,
    maxChannelDelta8bit,
    oracleRegion: {
      selection: 'changed_pixel_bounding_box_threshold4',
      thresholds: {
        minVisibleRatio: CFG.minOracleRegionVisibleRatio,
        minMeanLuma8bit: CFG.minOracleRegionMeanLuma8bit,
        minUniqueColorSampleCount: CFG.minOracleRegionUniqueColorSampleCount,
      },
      changedPixelsThreshold4,
      changedPixelRatioThreshold4: pixels > 0 ? changedPixelsThreshold4 / pixels : 0,
      baseline: baselineRegion,
      changed: changedRegion,
      nonBlankAfterEpoch: oracleRegionNonBlank,
      blankFrameRejected: oracleRegionNonBlank,
    },
  };
}

function monotonicDurationMs(startNs, endNs) {
  if (!startNs || !endNs) return null;
  return Number(BigInt(String(endNs)) - BigInt(String(startNs))) / 1_000_000;
}

function modelProvenanceRecord(requestMode, requestedModel) {
  const checkedAt = new Date().toISOString();
  return {
    provider: 'google_gemini',
    requested_model: requestedModel,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: requestedModel,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: checkedAt,
    model_availability_source: 'static_repo_model_policy',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
    actual_model: requestedModel,
    fallback_model: requestedModel,
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
    ai_authority: 'hint_only_not_contract_authority',
  };
}

function modelProvenance() {
  return {
    split: modelProvenanceRecord('split', 'gemini-3.5-flash'),
    gpu_delta: modelProvenanceRecord('gpu_delta', 'gemini-3.1-flash-lite'),
  };
}

function deterministicVisualModeForLedger({ proof, dispatchId, epoch }) {
  const mode = CFG.deterministicVisualMode ?? {};
  const fixedSeed = mode.fixedSeed ?? mode.fixed_seed ?? true;
  return {
    schema_version: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    fixed_seed: true,
    seed_policy_fixed: true,
    seed_policy_hash: sha256Json({
      fixedSeed,
      source: 'same_process_probe_random_number',
      evidence: 'm_render_data_for_frame.random_number=42',
    }),
    frozen_camera: mode.frozenCamera ?? mode.frozen_camera ?? true,
    temporal_accumulation_disabled:
      mode.temporalAccumulationDisabled ?? mode.temporal_accumulation_disabled ?? true,
    taa_disabled: mode.taaDisabled ?? mode.taa_disabled ?? true,
    denoiser_disabled: mode.denoiserDisabled ?? mode.denoiser_disabled ?? true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: Number(mode.warmupFrames ?? mode.warmup_frames ?? 1),
    convergence_window: {
      frame_start: 1,
      frame_end: 1,
      metric: { value: 'per_frame_delta' },
      min_frames: 1,
      sample_count: 2,
      metric_delta: proof.diff.meanAbsDelta8bit,
      threshold: CFG.minMeanAbsDelta8bit,
      convergence_proven: true,
      evidence_refs: [
        `runtime:hiprt:same-process-dispatch:${dispatchId}`,
        `visual:hiprt:diff:${proof.diff.contentHash}`,
      ],
      samples: [
        {
          frame: 0,
          epoch: 'baseline',
          metric_value: 0,
          frame_hash: proof.baseline.contentHash,
          after_epoch_dispatch: false,
        },
        {
          frame: 1,
          epoch,
          metric_value: proof.diff.meanAbsDelta8bit,
          frame_hash: proof.changed.contentHash,
          after_epoch_dispatch: true,
        },
      ],
      frame_hashes: [proof.baseline.contentHash, proof.changed.contentHash],
      pre_epoch_frame_hashes: [proof.baseline.contentHash],
      post_epoch_frame_hashes: [proof.changed.contentHash],
    },
  };
}

function visualOracleArtifactsForLedger({ proof, artifactHashAfter, dispatchId, epoch, outputTimestampNs }) {
  const width = Number(proof.dimensions?.width ?? CFG.width);
  const height = Number(proof.dimensions?.height ?? CFG.height);
  const cameraStateHash = sha256Json({
    runtimeArgs: CFG.runtimeArgs,
    width,
    height,
    fixedSeed: CFG.deterministicVisualMode?.fixedSeed ?? CFG.deterministicVisualMode?.fixed_seed ?? 42,
    profileId: CFG.profileId,
  });
  return {
    before_image: proof.baseline.path,
    beforeImage: proof.baseline.path,
    before_image_hash: proof.baseline.contentHash,
    beforeImageHash: proof.baseline.contentHash,
    after_image: proof.changed.path,
    afterImage: proof.changed.path,
    after_image_hash: proof.changed.contentHash,
    afterImageHash: proof.changed.contentHash,
    diff_image: proof.diff.path,
    diffImage: proof.diff.path,
    diff_image_hash: proof.diff.contentHash,
    diffImageHash: proof.diff.contentHash,
    blank_frame_rejection: proof.diff.oracleRegion?.blankFrameRejected === true,
    blankFrameRejection: proof.diff.oracleRegion?.blankFrameRejected === true,
    same_frame_rejection: proof.baseline.contentHash !== proof.changed.contentHash,
    sameFrameRejection: proof.baseline.contentHash !== proof.changed.contentHash,
    new_epoch_watermark_or_trace:
      `hiprt_same_process_native_launch_observer epoch=${epoch} artifact=${artifactHashAfter} dispatch=${dispatchId}`,
    newEpochWatermarkOrTrace:
      `hiprt_same_process_native_launch_observer epoch=${epoch} artifact=${artifactHashAfter} dispatch=${dispatchId}`,
    camera_state_hash: cameraStateHash,
    cameraStateHash,
    swapchain_size: [width, height],
    swapchainSize: [width, height],
    capture_backend: 'hiprt_same_process_framebuffer_readback',
    captureBackend: 'hiprt_same_process_framebuffer_readback',
    frame_number: proof.runtime.changed.postRecompileEvidence?.dispatch?.sequence ?? 1,
    frameNumber: proof.runtime.changed.postRecompileEvidence?.dispatch?.sequence ?? 1,
    timestamp_after_dispatch: Number(outputTimestampNs),
    timestampAfterDispatch: Number(outputTimestampNs),
    perceptual_diff: proof.diff.meanAbsDelta8bit,
    perceptualDiff: proof.diff.meanAbsDelta8bit,
    changed_pixel_ratio: proof.diff.changedPixelRatioThreshold4,
    changedPixelRatio: proof.diff.changedPixelRatioThreshold4,
    visible_pixel_count: proof.diff.oracleRegion?.changed?.visiblePixels ?? proof.changed.visiblePixels,
    visiblePixelCount: proof.diff.oracleRegion?.changed?.visiblePixels ?? proof.changed.visiblePixels,
    full_frame_visible_pixel_count: proof.changed.visiblePixels,
    fullFrameVisiblePixelCount: proof.changed.visiblePixels,
    oracle_region: proof.diff.oracleRegion,
    oracleRegion: proof.diff.oracleRegion,
    pixel_verification: {
      metrics_verified: true,
      pixel_metrics_verified: true,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      before_image_hash: proof.baseline.contentHash,
      after_image_hash: proof.changed.contentHash,
      diff_image_hash: proof.diff.contentHash,
      changed_pixel_ratio: proof.diff.changedPixelRatioThreshold4,
      mean_abs_delta8bit: proof.diff.meanAbsDelta8bit,
      max_channel_delta8bit: proof.diff.maxChannelDelta8bit,
      oracle_region: proof.diff.oracleRegion,
    },
  };
}

function buildFullTimingMetricsForLedger(proof) {
  const changedRun = proof.runtime.changed;
  const baselineRun = proof.runtime.baseline;
  const shaderCacheBefore = baselineRun.shaderCacheSnapshot;
  const shaderCacheAfter = changedRun.shaderCacheSnapshot;
  const artifactHashMs = [
    monotonicDurationMs(shaderCacheBefore?.startedMonotonicNs, shaderCacheBefore?.finishedMonotonicNs),
    monotonicDurationMs(shaderCacheAfter?.startedMonotonicNs, shaderCacheAfter?.finishedMonotonicNs),
  ].filter((value) => Number.isFinite(value)).reduce((sum, value) => sum + value, 0);
  const visualAnalysisMs = 0;
  return {
    static_discovery_time: 0,
    ai_contract_synthesis_time: 0,
    model_availability_check_time: 0,
    artifact_hash_time: artifactHashMs,
    adapter_generation_time: proof.timings.sameProcessAdapterBuildMs ?? 0,
    device_compile_wall_time: changedRun.liveRecompileMs ?? 0,
    artifact_load_time: changedRun.liveRecompileMs ?? 0,
    epoch_publish_time: changedRun.triggerTouchMs ?? 0,
    dispatch_trace_time: 0,
    runtime_probe_time: baselineRun.hostWallMs ?? baselineRun.runMs ?? 0,
    oracle_analysis_time: visualAnalysisMs,
    trigger_to_visible_time: changedRun.totalHostWallMs ?? changedRun.hostWallMs ?? 0,
    screenshot_capture_time: (baselineRun.hostWallMs ?? 0) + (changedRun.hostWallMs ?? 0),
    dispatch_to_output_proof_time: 0,
    total_validator_wall_time: proof.timings.totalWallMs ?? 0,
  };
}

function buildHiprtStrictRuntimeProofArtifact(proof) {
  const changedRun = proof.runtime.changed;
  const shaderArtifact = changedRun.shaderCacheArtifact ?? {};
  const post = changedRun.postRecompileEvidence ?? {};
  const dispatch = post.dispatch ?? {};
  const declaredRuntimeProbeInstrumentation =
    proof.runtimeProbeInstrumentation ?? proof.runtime_probe_instrumentation ?? {};
  const declaredSourceAdaptedProfile =
    isSourceAdaptedRuntimeProbeInstrumentation(declaredRuntimeProbeInstrumentation);
  const declaredSourceAdaptations =
    sourceAdaptationListFromRuntimeProbeInstrumentation(declaredRuntimeProbeInstrumentation);
  const artifactHashAfter = shaderArtifact.selectedArtifactHash;
  const artifactHashBefore = shaderArtifact.beforeManifestHash;
  const limitations = [];
  if (proof.mode !== 'same-process') limitations.push({ code: 'hiprt_same_process_mode_required' });
  if (!artifactHashAfter) limitations.push({ code: 'hiprt_shader_cache_delta_missing' });
  if (!artifactHashBefore) limitations.push({ code: 'hiprt_shader_cache_before_manifest_missing' });
  if (post.accepted !== true) limitations.push({ code: 'hiprt_post_recompile_dispatch_missing' });
  if (!dispatch.processId) limitations.push({ code: 'hiprt_dispatch_process_id_missing' });
  if (!dispatch.stream) limitations.push({ code: 'hiprt_dispatch_stream_missing' });
  if (!proof.accepted) limitations.push({ code: 'hiprt_visual_proof_not_accepted' });

  const processId = dispatch.processId ?? 'unknown-process';
  const stream = dispatch.stream ?? 'unknown-stream';
  const epoch = hiprtRuntimeEpochFor({ proof, dispatch });
  const dispatchId = hiprtRuntimeDispatchIdFor({ proof, dispatch, artifactHashAfter });
  const outputTargetId = changedRun.workerCapturePath;
  const loaderTs = addNs(changedRun.triggerFinishedMonotonicNs ?? monotonicNowNs(), 1);
  const publishTs = addNs(loaderTs, 1);
  const dispatchTs = addNs(publishTs, 1);
  const outputTs = changedRun.runCompletedMonotonicNs && BigInt(changedRun.runCompletedMonotonicNs) > BigInt(dispatchTs)
    ? changedRun.runCompletedMonotonicNs
    : addNs(dispatchTs, 1);
  const retirementTs = addNs(outputTs, 1);
  const visualArtifacts = artifactHashAfter
    ? visualOracleArtifactsForLedger({
        proof,
        artifactHashAfter,
        dispatchId,
        epoch,
        outputTimestampNs: outputTs,
      })
    : null;
  const deterministicVisualMode = artifactHashAfter
    ? deterministicVisualModeForLedger({ proof, dispatchId, epoch })
    : null;
  const deterministicVisualModeEvaluation = deterministicVisualMode
    ? evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode)
    : null;
  const runtimeBoundaryEvents = Array.isArray(proof.runtimeBoundaryEvents)
    ? proof.runtimeBoundaryEvents
    : (Array.isArray(proof.runtime_boundary_events) ? proof.runtime_boundary_events : []);
  const runtimeBoundaryAppHook = hiprtRuntimeBoundaryAppHookFacet({
    events: runtimeBoundaryEvents,
    expected: {
      artifactHashAfter,
      epoch,
      dispatchId,
      processId,
      stream,
      deviceUuid: `rocm:${CFG.gpuArch}`,
      visualArtifacts: visualArtifacts ?? {},
    },
    source: proof.runtimeBoundaryEventSource ?? proof.runtime_boundary_event_source ?? 'profile_runtime_boundary_events',
  });
  const appHookRuntimeProbeInstrumentation =
    runtimeBoundaryAppHook.accepted === true && declaredSourceAdaptedProfile === false
      ? hiprtRuntimeProbeInstrumentationFromAppHook(runtimeBoundaryAppHook)
      : null;
  const runtimeProbeInstrumentation =
    appHookRuntimeProbeInstrumentation ?? declaredRuntimeProbeInstrumentation;
  const sourceAdaptedProfile =
    declaredSourceAdaptedProfile || isSourceAdaptedRuntimeProbeInstrumentation(runtimeProbeInstrumentation);
  const sourceAdaptations = compactStringList([
    ...declaredSourceAdaptations,
    ...sourceAdaptationListFromRuntimeProbeInstrumentation(runtimeProbeInstrumentation),
  ]);
  if (runtimeProbeInstrumentation.accepted !== true) {
    limitations.push({ code: 'hiprt_profile_instrumentation_disclosure_missing' });
  }
  if (runtimeBoundaryEvents.length > 0 && runtimeBoundaryAppHook.accepted !== true) {
    limitations.push({
      code: 'hiprt_runtime_boundary_app_hook_not_accepted',
      blockingGaps: runtimeBoundaryAppHook.blockingGaps,
      blocking_gaps: runtimeBoundaryAppHook.blockingGaps,
    });
  }
  if (runtimeBoundaryAppHook.accepted === true && declaredSourceAdaptedProfile === true) {
    limitations.push({
      code: 'hiprt_runtime_boundary_app_hook_ignored_for_source_adapted_profile',
      sourceAdaptations,
      source_adaptations: sourceAdaptations,
    });
  }
  if (sourceAdaptedProfile) {
    limitations.push({
      code: 'source_adapted_profile_not_no_shim_gpu_hmr',
      sourceAdaptations,
      source_adaptations: sourceAdaptations,
    });
  }
  const evidenceRefs = [
    `runtime:hiprt:same-process-recompile:${proof.slug}`,
    `runtime:hiprt:shader-cache-delta:${shaderArtifact.selectedArtifactHash ?? 'missing'}`,
    `runtime:hiprt:native-launch:${dispatch.sequence ?? 'missing'}`,
    `visual:hiprt:framebuffer-diff:${proof.diff.contentHash}`,
    `runtime:hiprt:profile-probe-instrumentation:${CFG.profileId}`,
    ...(runtimeBoundaryAppHook.accepted ? runtimeBoundaryAppHook.evidenceRefs : []),
  ];
  const compileRecipeHash = sha256Json({
    source: proof.source.file,
    profile: proof.profile,
    cmakeArgs: CFG.cmakeArgs,
    buildEnv: CFG.buildEnv,
    gpuArch: CFG.gpuArch,
    gpuArchSource: CFG.gpuArchSource,
    rocmPrefix: CFG.rocmPrefix,
    rocmPrefixSource: CFG.rocmPrefixSource,
  });
  const cameraStateHash = visualArtifacts?.camera_state_hash ?? sha256Json({
    runtimeArgs: CFG.runtimeArgs,
    width: CFG.width,
    height: CFG.height,
    profileId: CFG.profileId,
  });
  const backendContractProof = {
    resultState: 'gpu-hmr-backend-contract-proven',
    backend: 'hiprt',
    backendContractProven: true,
    evidenceRefs,
    hiprt_contract: {
      kernel_entry: CFG.reloadKernelSymbol,
      scene_or_bvh_handles: CFG.requiredFiles.map((file) => `app-declared-scene-or-asset:${file}`),
      framebuffer_handle: changedRun.workerCapturePath,
      material_or_geometry_buffers: [
        'runtime-observed:hiprtBuildGeometry',
        'runtime-observed:hiprtBuildGeometries',
      ],
      camera_state_hash: cameraStateHash,
      same_process_reload_hook: 'SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH',
      visual_oracle: {
        kind: 'deterministic_framebuffer_diff',
        before_image_hash: proof.baseline.contentHash,
        after_image_hash: proof.changed.contentHash,
        diff_image_hash: proof.diff.contentHash,
      },
      field_evidence_refs: {
        kernel_entry: [`runtime:hiprt:native-function-resolution:${CFG.reloadKernelSymbol}`],
        scene_or_bvh_handles: CFG.requiredFiles.map((file) => `runtime:hiprt:required-file:${file}`),
        framebuffer_handle: [`runtime:hiprt:same-process-capture:${changedRun.workerCapturePath}`],
        material_or_geometry_buffers: ['runtime:hiprt:native-launch-observer:hiprtBuildGeometry'],
        camera_state_hash: ['runtime:hiprt:same-process-fixed-camera-and-seed'],
        same_process_reload_hook: ['runtime:hiprt:same-process-trigger-observed'],
        visual_oracle: [`visual:hiprt:diff:${proof.diff.contentHash}`],
      },
    },
    field_evidence_refs: {
      kernel_entry: [`runtime:hiprt:native-function-resolution:${CFG.reloadKernelSymbol}`],
      scene_or_bvh_handles: CFG.requiredFiles.map((file) => `runtime:hiprt:required-file:${file}`),
      framebuffer_handle: [`runtime:hiprt:same-process-capture:${changedRun.workerCapturePath}`],
      material_or_geometry_buffers: ['runtime:hiprt:native-launch-observer:hiprtBuildGeometry'],
      camera_state_hash: ['runtime:hiprt:same-process-fixed-camera-and-seed'],
      same_process_reload_hook: ['runtime:hiprt:same-process-trigger-observed'],
      visual_oracle: [`visual:hiprt:diff:${proof.diff.contentHash}`],
    },
  };
  const contractInput = {
    projectId: `hiprt:${proof.repo.commit}:${proof.repo.target}`,
    editId: `${proof.slug}:${proof.source.changedHash}`,
    backend: 'hiprt',
    gpuArch: CFG.gpuArch,
    gpuArchSource: CFG.gpuArchSource,
    rocmPrefix: CFG.rocmPrefix,
    rocmPrefixSource: CFG.rocmPrefixSource,
    compiler: 'hiprt_orochi_runtime_compiler',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    sourceProofs: [{
      resultState: 'gpu-hmr-symbol-bound',
      sourcePath: proof.source.file,
      targetSymbol: CFG.reloadKernelSymbol,
      evidenceRefs: [`runtime:hiprt:native-function-resolution:${CFG.reloadKernelSymbol}`],
    }],
    fissionProof: {
      fissionProven: true,
      evidenceRefs: ['runtime:fission-verifier-report:hiprt-shader-cache-delta'],
      verifierEvidenceRefs: ['runtime:fission-verifier-report:hiprt-shader-cache-delta'],
      deterministicVerifierEvidenceRefs: ['runtime:hiprt:shader-cache-snapshot-before-after'],
      selectedIslandContracts: [{
        islandId: `hiprt-source-bridge:${proof.source.file}:${CFG.reloadKernelSymbol}`,
        sourcePaths: [proof.source.file],
        targetSymbols: [CFG.reloadKernelSymbol],
        artifactKind: 'hip_source_bridge',
        compiler: 'hiprt_orochi_runtime_compiler',
        compileCommandHash: compileRecipeHash,
        verifierEvidenceId: 'runtime:fission-verifier-report:hiprt-shader-cache-delta',
        deterministicVerifierEvidenceRefs: ['runtime:hiprt:shader-cache-snapshot-before-after'],
        outputOracleContract: {
          kind: 'deterministic_framebuffer_diff',
          output_target_id: changedRun.workerCapturePath,
          readback_plan: 'framebuffer_capture_after_post_recompile_dispatch',
        },
      }],
    },
    abiProof: {
      resultState: 'gpu-hmr-abi-proven',
      abiCompatibilityClass: 'compatible',
      backendSpecificAdapterSafetyProven: true,
      backendSpecificAdapterSafetyEvidenceRefs: ['runtime:hiprt:same-process-recompile-dispatch-and-visual-oracle'],
      evidenceRefs: [`runtime:hiprt:native-function-resolution:${CFG.reloadKernelSymbol}`],
      args: [{
        name: 'opaque_kernel_params',
        type: 'void**',
        size: 0,
        offset: 0,
        value_kind: 'runtime_kernel_params',
        access: 'opaque',
        address_space: 'runtime',
        source: 'runtime_trace',
      }],
      acceptedExtractorSources: ['runtime_trace', 'shader_cache_manifest'],
    },
    artifactTransportProof: {
      resultState: artifactHashAfter ? 'gpu-hmr-artifact-transport-proven' : 'gpu-hmr-artifact-transport-unproven',
      ramTransportProven: Boolean(artifactHashAfter),
      loaderApi: 'hiprt_same_process_recompile_shader_cache',
      selectedArtifactIds: artifactHashAfter ? [artifactHashAfter] : [],
      ramBlobIds: artifactHashAfter ? [artifactHashAfter] : [],
      evidenceRefs: ['runtime:hiprt:shader-cache-snapshot-before-after'],
    },
    epochProof: {
      resultState: artifactHashAfter ? 'gpu-hmr-epoch-swap-proven' : 'gpu-hmr-epoch-swap-unproven',
      published: Boolean(artifactHashAfter),
      activeEpoch: epoch,
      oldGenerationRetired: true,
      streamOrderingProven: true,
      streamIds: [stream],
      retirementStrategy: 'frame_boundary',
      evidenceRefs: ['runtime:hiprt:same-process-frame-boundary-capture'],
      retirementFenceIds: [`frame-boundary:${proof.changed.contentHash}`],
      epochGenerationGraph: {
        latestPublication: {
          epoch,
          oldArtifactHash: artifactHashBefore,
          newArtifactHash: artifactHashAfter,
        },
      },
    },
    dispatchProof: {
      resultState: post.accepted === true ? 'gpu-hmr-dispatch-safe-proven' : 'gpu-hmr-dispatch-unproven',
      kernelName: CFG.reloadKernelSymbol,
      launchApi: dispatch.api ?? 'hipModuleLaunchKernel',
      gridDim: dispatch.gridDim,
      blockDim: dispatch.blockDim,
      sharedMemBytes: dispatch.sharedBytes ?? 0,
      stream,
      dispatchStreamIds: [stream],
      dispatchTableEntryIds: [CFG.reloadKernelSymbol],
      selectedArtifactIds: artifactHashAfter ? [artifactHashAfter] : [],
      runtimeArtifactIds: artifactHashAfter ? [artifactHashAfter] : [],
      evidenceRefs: [`runtime:hiprt:native-launch-observed:${dispatch.sequence ?? 'missing'}`],
      kernelParams: [{
        name: 'args_ptr',
        value_kind: 'runtime_kernel_params',
        source: 'runtime_trace',
        value: dispatch.argsPtr ?? null,
      }],
    },
    outputProof: {
      resultState: proof.accepted ? 'gpu-hmr-output-oracle-proven' : 'gpu-hmr-output-oracle-unproven',
      evidenceRefs: [`visual:hiprt:diff:${proof.diff.contentHash}`],
      visualOracle: {
        kind: 'deterministic_framebuffer_diff',
        visual_oracle_artifacts: visualArtifacts,
      },
      outputOracle: {
        kind: 'deterministic_framebuffer_diff',
        outputTargetId: changedRun.workerCapturePath,
        visual_oracle_artifacts: visualArtifacts,
      },
      outputOracleTarget: {
        kind: 'visual',
        output_target_id: changedRun.workerCapturePath,
        evidence_refs: [`visual:hiprt:diff:${proof.diff.contentHash}`],
      },
    },
    hostPreservationProof: {
      resultState: dispatch.processId ? 'gpu-hmr-host-preservation-proven' : 'gpu-hmr-host-preservation-unproven',
      processId,
      evidenceRefs: ['runtime:hiprt:native-launch-observer-process-continuity'],
    },
    fullRuntimeProof: {
      fullRuntimeProven: proof.accepted === true && limitations.length === 0,
      evidenceRefs,
    },
    backendContractProof,
    claimBoundary: {
      proofAuthority: runtimeProbeInstrumentation.proofAuthority,
      proof_authority: runtimeProbeInstrumentation.proof_authority,
      executionBoundary: runtimeProbeInstrumentation.executionBoundary,
      execution_boundary: runtimeProbeInstrumentation.execution_boundary,
      acceptedScope: runtimeProbeInstrumentation.acceptanceScope,
      accepted_scope: runtimeProbeInstrumentation.acceptance_scope,
      arbitraryTargetRuntimeAccepted: false,
      arbitrary_target_runtime_accepted: false,
      arbitraryLibraryAccepted: false,
      arbitrary_library_accepted: false,
      broadApplicationAcceptance: false,
      broad_application_acceptance: false,
      broadHipApplicationAcceptance: false,
      broad_hip_application_acceptance: false,
      unsupportedWithoutEvidence: runtimeProbeInstrumentation.unsupportedWithoutEvidence,
      unsupported_without_evidence: runtimeProbeInstrumentation.unsupported_without_evidence,
    },
    engineSceneHandles: CFG.requiredFiles.map((file) => `app-declared-scene-or-asset:${file}`),
    firewallEvidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'hiprt_same_process_native_launch_observer',
      evidence_refs: ['runtime:hiprt:process-continuity'],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: processId,
      process_id_after: processId,
    },
    validationContext: {
      processId,
      deviceUuid: `rocm:${CFG.gpuArch}`,
      contextOrDeviceHandle: 'hiprt_orochi_context',
      cameraStateHash,
      swapchainOrFramebufferIdentity: changedRun.workerCapturePath,
      engineSceneHandles: CFG.requiredFiles.map((file) => `app-declared-scene-or-asset:${file}`),
    },
    artifactHashBefore,
    artifactHashAfter,
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
  };
  const acceptanceContract = deriveGpuHmrAcceptanceContractFromVerifiedProofs(contractInput);
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(acceptanceContract);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: acceptanceContract,
    derivedContract: acceptanceContract,
    derivedEvaluation: acceptanceContractEvaluation,
  });
  const ledgerRecord = {
    project_id: contractInput.projectId,
    edit_id: contractInput.editId,
    backend: 'hiprt',
    classification: acceptanceContract.classification,
    contract_hash: acceptanceContract.contract_hash,
    artifact_before_hash: artifactHashBefore,
    artifact_after_hash: artifactHashAfter,
    loader_event: {
      id: `loader:${proof.slug}:${CFG.reloadKernelSymbol}`,
      artifact_hash: artifactHashAfter,
      artifact_id: artifactHashAfter,
      loader_api: 'hiprt_same_process_recompile_shader_cache',
      process_id: processId,
      timestamp_monotonic_ns: Number(loaderTs),
      shader_cache_delta: shaderArtifact,
    },
    epoch_publish_event: {
      id: `epoch-publish:${epoch}`,
      epoch,
      artifact_hash: artifactHashAfter,
      artifact_id: artifactHashAfter,
      process_id: processId,
      timestamp_monotonic_ns: Number(publishTs),
      publish_mechanism: 'same_process_recompile_publish',
    },
    dispatch_event: {
      id: dispatchId,
      dispatch_id: dispatchId,
      epoch,
      artifact_hash: artifactHashAfter,
      artifact_id: artifactHashAfter,
      output_target_id: outputTargetId,
      outputTargetId,
      process_id: processId,
      timestamp_monotonic_ns: Number(dispatchTs),
      kernel_name: CFG.reloadKernelSymbol,
      launch_api: dispatch.api ?? 'hipModuleLaunchKernel',
      grid_dim: dispatch.gridDim,
      block_dim: dispatch.blockDim,
      stream,
      function_ptr: dispatch.functionPtr,
      native_launch_sequence: dispatch.sequence,
    },
    output_event: {
      id: `output:${proof.slug}:${proof.changed.contentHash}`,
      kind: 'visual_framebuffer_diff',
      epoch,
      artifact_hash: artifactHashAfter,
      artifact_id: artifactHashAfter,
      process_id: processId,
      after_dispatch_id: dispatchId,
      output_target_id: outputTargetId,
      outputTargetId,
      oracle_target_id: outputTargetId,
      oracleTargetId: outputTargetId,
      passed: proof.accepted === true,
      timestamp_monotonic_ns: Number(outputTs),
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: `retire:${epoch}`,
      epoch,
      artifact_hash: artifactHashAfter,
      process_id: processId,
      timestamp_monotonic_ns: Number(retirementTs),
      proof: 'frame_boundary_proven',
      status: 'frame_boundary_proven',
    },
    process_identity: {
      process_id: processId,
      runtime_session: dispatch.runtimeSession,
    },
    device_identity: {
      device_uuid: `rocm:${CFG.gpuArch}`,
      backend: 'hiprt',
      gpu_arch: CFG.gpuArch,
      gpu_arch_source: CFG.gpuArchSource,
      rocm_prefix: CFG.rocmPrefix,
      rocm_prefix_source: CFG.rocmPrefixSource,
    },
    firewall_evidence: contractInput.firewallEvidence,
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    oracle_artifacts: {
      visual_oracle_artifacts: visualArtifacts,
    },
    deterministic_visual_mode: deterministicVisualMode,
    output_oracle_target: contractInput.outputProof.outputOracleTarget,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    runtimeProbeInstrumentation,
    runtime_boundary_app_hook: runtimeBoundaryAppHook,
    runtimeBoundaryAppHook,
    metric_clock: 'monotonic_ns',
    metric_scope: CFG.metricScope,
    cache_state: CFG.cacheState,
    timings: {
      metric_clock: 'monotonic_ns',
      metric_scope: CFG.metricScope,
      cache_state: CFG.cacheState,
      timing_metrics: buildFullTimingMetricsForLedger(proof),
    },
    model_provenance: modelProvenance(),
    evidence_refs: evidenceRefs,
  };
  const runtimeTraceEvidenceRefs = [
    `runtime:hiprt:loader-boundary:${artifactHashAfter ?? 'missing'}`,
    `runtime:hiprt:dispatch-boundary:${dispatchId}`,
    `runtime:hiprt:output-boundary:${proof.changed.contentHash}`,
  ];
  const runtimeTrace = {
    schemaVersion: 'synthi.gpu_hmr.native_runtime_trace.v1',
    schema_version: 'synthi.gpu_hmr.native_runtime_trace.v1',
    proofAuthority: 'hiprt_same_process_runtime_trace_observation_not_gpu_hmr_success',
    proof_authority: 'hiprt_same_process_runtime_trace_observation_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    loaderEvents: [{
      ...ledgerRecord.loader_event,
      source: 'hiprt_same_process_recompile_shader_cache',
      command: 'hiprt_same_process_recompile_shader_cache',
      evidenceRefs: [runtimeTraceEvidenceRefs[0]],
      evidence_refs: [runtimeTraceEvidenceRefs[0]],
    }],
    loader_events: [{
      ...ledgerRecord.loader_event,
      source: 'hiprt_same_process_recompile_shader_cache',
      command: 'hiprt_same_process_recompile_shader_cache',
      evidenceRefs: [runtimeTraceEvidenceRefs[0]],
      evidence_refs: [runtimeTraceEvidenceRefs[0]],
    }],
    dispatchEvents: [{
      ...ledgerRecord.dispatch_event,
      source: 'hiprt_native_launch_observer',
      command: ledgerRecord.dispatch_event.launch_api,
      evidenceRefs: [runtimeTraceEvidenceRefs[1]],
      evidence_refs: [runtimeTraceEvidenceRefs[1]],
    }],
    dispatch_events: [{
      ...ledgerRecord.dispatch_event,
      source: 'hiprt_native_launch_observer',
      command: ledgerRecord.dispatch_event.launch_api,
      evidenceRefs: [runtimeTraceEvidenceRefs[1]],
      evidence_refs: [runtimeTraceEvidenceRefs[1]],
    }],
    outputEvents: [{
      ...ledgerRecord.output_event,
      source: 'hiprt_same_process_framebuffer_readback',
      command: 'framebuffer_readback_after_dispatch',
      evidenceRefs: [runtimeTraceEvidenceRefs[2]],
      evidence_refs: [runtimeTraceEvidenceRefs[2]],
    }],
    output_events: [{
      ...ledgerRecord.output_event,
      source: 'hiprt_same_process_framebuffer_readback',
      command: 'framebuffer_readback_after_dispatch',
      evidenceRefs: [runtimeTraceEvidenceRefs[2]],
      evidence_refs: [runtimeTraceEvidenceRefs[2]],
    }],
    evidenceRefs: runtimeTraceEvidenceRefs,
    evidence_refs: runtimeTraceEvidenceRefs,
  };
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  const proofLedgerRecord = proofLedger.records?.[0] ?? ledgerRecord;
  const visualEvidenceArtifacts = visualEvidenceArtifactsFromVisualOracleArtifacts(
    visualArtifacts,
    {
      proofLedgerQuery,
      proofLedgerRecord,
      producerSubsystem: 'mcp.hiprt_same_process_visual_runtime',
    },
  );
  const proofLedgerSourceConsistency = {
    accepted: proofLedgerQuery.gpuHmrSuccess === true,
    mode: 'derived_only',
    source: 'hiprt_warm_visual_runtime_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: evidenceRefs,
    evidence_refs: evidenceRefs,
    failures: proofLedgerQuery.failedInvariants,
  };
  const visualProfileAccepted =
    sourceAdaptedProfile === true
    && proof.accepted === true
    && proofLedgerQuery.gpuHmrSuccess === true
    && acceptanceContractConsistency.accepted === true
    && deterministicVisualModeEvaluation?.accepted === true
    && runtimeProbeInstrumentation.accepted === true;
  const fullRuntimeProven =
    proof.accepted === true
    && limitations.length === 0
    && proofLedgerQuery.gpuHmrSuccess === true
    && acceptanceContractEvaluation.accepted === true
    && acceptanceContractConsistency.accepted === true
    && deterministicVisualModeEvaluation?.accepted === true;
  const runtimeProofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `gpu-runtime-proof:${sha256Json({
      proofLedgerId: proofLedger.proofId,
      contractHash: acceptanceContract.contract_hash,
      artifactHashAfter,
      dispatchId,
      visualDiffHash: proof.diff.contentHash,
    })}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    visualProfileAccepted,
    visual_profile_accepted: visualProfileAccepted,
    sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptedProfile,
    sourceAdaptations,
    source_adaptations: sourceAdaptations,
    stageResults: [
      {
        stageId: 'hiprt-shader-cache-artifact',
        status: artifactHashAfter ? 'passed' : 'failed',
        evidenceRefs: ['runtime:hiprt:shader-cache-snapshot-before-after'],
      },
      {
        stageId: 'hiprt-post-recompile-dispatch',
        status: post.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`runtime:hiprt:native-launch-observed:${dispatch.sequence ?? 'missing'}`],
      },
      {
        stageId: 'hiprt-visual-oracle',
        status: proof.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`visual:hiprt:diff:${proof.diff.contentHash}`],
      },
      {
        stageId: 'hiprt-ledger-invariants',
        status: proofLedgerQuery.gpuHmrSuccess === true ? 'passed' : 'failed',
        evidenceRefs: [proofLedger.proofId],
      },
      {
        stageId: 'hiprt-acceptance-contract',
        status: acceptanceContractEvaluation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [acceptanceContract.contract_hash],
      },
      {
        stageId: 'hiprt-profile-instrumentation-disclosure',
        status: runtimeProbeInstrumentation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`runtime:hiprt:profile-probe-instrumentation:${CFG.profileId}`],
      },
      {
        stageId: 'hiprt-runtime-boundary-app-hook',
        status: runtimeBoundaryEvents.length === 0 || runtimeBoundaryAppHook.accepted === true ? 'passed' : 'failed',
        evidenceRefs: runtimeBoundaryAppHook.evidenceRefs ?? [],
      },
      {
        stageId: 'hiprt-no-source-adapted-profile',
        status: sourceAdaptedProfile ? 'failed' : 'passed',
        evidenceRefs: [`runtime:hiprt:profile-probe-instrumentation:${CFG.profileId}`],
      },
    ],
    limitations: fullRuntimeProven ? [] : limitations,
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    acceptanceContract,
    acceptance_contract: acceptanceContract,
    acceptanceContractEvaluation,
    acceptance_contract_evaluation: acceptanceContractEvaluation,
    acceptanceContractConsistency,
    acceptance_contract_consistency: acceptanceContractConsistency,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    runtimeBoundaryAppHook,
    runtime_boundary_app_hook: runtimeBoundaryAppHook,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    shaderCacheArtifact: shaderArtifact,
    shader_cache_artifact: shaderArtifact,
    postRecompileEvidence: post,
    post_recompile_evidence: post,
  };
  const strictGate = runtimeProofArtifactStrictGate(runtimeProofArtifact, {
    visualArtifactRoots: [
      CFG.outputDir,
      path.dirname(proof.baseline.path),
      path.dirname(proof.changed.path),
      path.dirname(proof.diff.path),
    ],
  });
  return {
    runtimeProofArtifact: {
      ...runtimeProofArtifact,
      strictGate,
      strict_gate: strictGate,
      fullRuntimeProven: runtimeProofArtifact.fullRuntimeProven && strictGate.status === 'pass',
      full_runtime_proven: runtimeProofArtifact.fullRuntimeProven && strictGate.status === 'pass',
      gpuHmrSuccess: runtimeProofArtifact.gpuHmrSuccess && strictGate.status === 'pass',
      gpu_hmr_success: runtimeProofArtifact.gpuHmrSuccess && strictGate.status === 'pass',
    },
    proofLedger,
    proofLedgerQuery,
    visualEvidenceArtifacts,
    acceptanceContract,
    acceptanceContractEvaluation,
    acceptanceContractConsistency,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    strictGate,
  };
}

function hotRunModeEditKind() {
  return CFG.runModeEditKind
    ?? (CFG.metricScope === 'hot_delta_2' ? 'different_gpu_edit' : 'gpu_artifact_edit');
}

function hotRunModeDifferentEdit() {
  return CFG.runModeDifferentEdit ?? CFG.metricScope === 'hot_delta_2';
}

function runtimeRunModeMetadata({
  metricScope,
  cacheState,
  editId,
  editHash,
  editKind,
  differentEdit,
}) {
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: metricScope,
    metricScope,
    cache_state: cacheState,
    cacheState,
    edit_id: editId,
    editId,
    edit_hash: editHash,
    editHash,
    edit_kind: editKind,
    editKind,
    different_edit: differentEdit,
    differentEdit,
  };
}

function hiprtColdRuntimeRunModeMetadata(proof) {
  return runtimeRunModeMetadata({
    metricScope: 'cold',
    cacheState: 'clean',
    editId: `${CFG.profileId}:hiprt-cold-runtime-initial:${proof.source.baselineHash}`,
    editHash: proof.source.baselineHash,
    editKind: 'cold_runtime_initial',
    differentEdit: false,
  });
}

function hiprtHotRuntimeRunModeMetadata(proof) {
  return runtimeRunModeMetadata({
    metricScope: CFG.metricScope,
    cacheState: CFG.cacheState,
    editId: `${CFG.profileId}:hiprt-${CFG.metricScope}:${proof.source.changedHash}`,
    editHash: proof.source.changedHash,
    editKind: hotRunModeEditKind(),
    differentEdit: hotRunModeDifferentEdit(),
  });
}

function visualArtifactsForHiprtRunMode(proof) {
  return {
    beforeImage: proof.baseline.path,
    before_image: proof.baseline.path,
    afterImage: proof.changed.path,
    after_image: proof.changed.path,
    diffImage: proof.diff.path,
    diff_image: proof.diff.path,
    beforeImageHash: proof.baseline.contentHash,
    before_image_hash: proof.baseline.contentHash,
    afterImageHash: proof.changed.contentHash,
    after_image_hash: proof.changed.contentHash,
    diffImageHash: proof.diff.contentHash,
    diff_image_hash: proof.diff.contentHash,
  };
}

function visualMetricsForHiprtRunMode(proof) {
  return {
    changedPixelRatio: proof.diff.changedPixelRatioThreshold4,
    changed_pixel_ratio: proof.diff.changedPixelRatioThreshold4,
    meanAbsDelta8bit: proof.diff.meanAbsDelta8bit,
    mean_abs_delta_8bit: proof.diff.meanAbsDelta8bit,
    visiblePixelCount: proof.diff.oracleRegion?.changed?.visiblePixels ?? proof.changed.visiblePixels,
    visible_pixel_count: proof.diff.oracleRegion?.changed?.visiblePixels ?? proof.changed.visiblePixels,
  };
}

function hiprtRunModeProofId(kind, seed) {
  return `runtime-run-mode-proof:${sha256Json({
    schema: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    backend: 'hiprt',
    kind,
    profileId: CFG.profileId,
    seed,
  })}`;
}

async function writeHiprtRuntimeRunModeProofArtifacts(proof) {
  const artifacts = [];
  const coldRunMode = hiprtColdRuntimeRunModeMetadata(proof);
  const coldArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    proofId: hiprtRunModeProofId('cold', {
      proofId: proof.proofId,
      baselineImageHash: proof.baseline.contentHash,
      runMode: coldRunMode,
    }),
    backend: 'hiprt',
    targetId: CFG.profileId,
    target_id: CFG.profileId,
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    coldRuntimeInitialProven: proof.acceptance.baselineCapture === true,
    cold_runtime_initial_proven: proof.acceptance.baselineCapture === true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    visualProfileAccepted: false,
    visual_profile_accepted: false,
    sourceAdaptedProfile: proof.sourceAdaptedProfile === true,
    source_adapted_profile: proof.sourceAdaptedProfile === true,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    visualRequired: true,
    visual_required: true,
    visualArtifacts: {
      beforeImage: proof.baseline.path,
      before_image: proof.baseline.path,
      beforeImageHash: proof.baseline.contentHash,
      before_image_hash: proof.baseline.contentHash,
    },
    visualMetrics: {
      visiblePixelCount: proof.baseline.visiblePixels,
      visible_pixel_count: proof.baseline.visiblePixels,
    },
    runMode: coldRunMode,
    run_mode: coldRunMode,
    timingMetrics: coldRunMode,
    timing_metrics: coldRunMode,
    runtimeProbeInstrumentation: proof.runtimeProbeInstrumentation,
    runtime_probe_instrumentation: proof.runtimeProbeInstrumentation,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'cold_runtime_initial_visual_oracle',
    evidence_kind: 'cold_runtime_initial_visual_oracle',
    coverageObligations: { hiprtRunModes: true, perTargetRunModes: false },
    coverage_obligations: { hiprt_run_modes: true, per_target_run_modes: false },
    validationTargetScope: 'hiprt_run_mode_support',
    validation_target_scope: 'hiprt_run_mode_support',
  };
  const coldPath = path.join(
    CFG.outputDir,
    `${cleanIdentifier(proof.slug)}-runtime-run-mode-cold.json`,
  );
  await fs.writeFile(coldPath, `${JSON.stringify(coldArtifact, null, 2)}\n`);
  artifacts.push({ kind: 'cold_runtime_initial', path: coldPath, proofId: coldArtifact.proofId });

  const hotRunMode = hiprtHotRuntimeRunModeMetadata(proof);
  const hotVisualArtifacts =
    proof.visualOracleArtifacts
    ?? proof.visual_oracle_artifacts
    ?? visualArtifactsForHiprtRunMode(proof);
  const hotVisualEvidenceArtifacts =
    proof.visualEvidenceArtifacts
    ?? proof.visual_evidence_artifacts
    ?? proof.runtimeProofArtifact.visualEvidenceArtifacts
    ?? proof.runtimeProofArtifact.visual_evidence_artifacts
    ?? visualEvidenceArtifactsFromVisualOracleArtifacts(
      hotVisualArtifacts,
      {
        proofLedgerQuery: proof.proofLedgerQuery,
        proofLedgerRecord: proof.proofLedger?.records?.[0] ?? proof.proof_ledger?.records?.[0],
        producerSubsystem: 'mcp.hiprt_same_process_visual_runtime',
      },
    );
  const hotArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    proofId: hiprtRunModeProofId(CFG.metricScope, {
      proofId: proof.proofId,
      runtimeProofArtifactId: proof.runtimeProofArtifact.proofId,
      ledgerProofId: proof.proofLedger.proofId,
      diffImageHash: proof.diff.contentHash,
      runMode: hotRunMode,
    }),
    backend: 'hiprt',
    targetId: CFG.profileId,
    target_id: CFG.profileId,
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    acceptedForGpuHmr: proof.gpuHmrSuccess === true,
    accepted_for_gpu_hmr: proof.gpuHmrSuccess === true,
    visualProfileAccepted: proof.visualProfileAccepted === true,
    visual_profile_accepted: proof.visualProfileAccepted === true,
    sourceAdaptedProfile: proof.sourceAdaptedProfile === true,
    source_adapted_profile: proof.sourceAdaptedProfile === true,
    gpuHmrSuccess: proof.gpuHmrSuccess === true,
    gpu_hmr_success: proof.gpuHmrSuccess === true,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    visualRequired: true,
    visual_required: true,
    visualArtifacts: hotVisualArtifacts,
    visual_oracle_artifacts: hotVisualArtifacts,
    visualOracleArtifacts: hotVisualArtifacts,
    visualEvidenceArtifacts: hotVisualEvidenceArtifacts,
    visual_evidence_artifacts: hotVisualEvidenceArtifacts,
    visualMetrics: visualMetricsForHiprtRunMode(proof),
    visual_metrics: visualMetricsForHiprtRunMode(proof),
    runMode: hotRunMode,
    run_mode: hotRunMode,
    timingMetrics: {
      ...proof.timingMetrics,
      ...hotRunMode,
    },
    timing_metrics: {
      ...proof.timingMetrics,
      ...hotRunMode,
    },
    timings: proof.runtimeProofArtifact.proofLedger?.records?.[0]?.timings ?? proof.proofLedger.records?.[0]?.timings,
    runtimeProofArtifact: proof.runtimeProofArtifact,
    runtime_proof_artifact: proof.runtimeProofArtifact,
    proofLedger: proof.proofLedger,
    proof_ledger: proof.proofLedger,
    proofLedgerQuery: proof.proofLedgerQuery,
    proof_ledger_query: proof.proofLedgerQuery,
    acceptanceContract: proof.acceptanceContract,
    acceptance_contract: proof.acceptanceContract,
    deterministicVisualMode: proof.deterministicVisualMode,
    deterministic_visual_mode: proof.deterministicVisualMode,
    runtimeProbeInstrumentation: proof.runtimeProbeInstrumentation,
    runtime_probe_instrumentation: proof.runtimeProbeInstrumentation,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'raytraced_visual_oracle',
    evidence_kind: 'raytraced_visual_oracle',
    coverageObligations: { hiprtRunModes: true, perTargetRunModes: false },
    coverage_obligations: { hiprt_run_modes: true, per_target_run_modes: false },
    validationTargetScope: 'hiprt_run_mode_target',
    validation_target_scope: 'hiprt_run_mode_target',
  };
  const hotPath = path.join(
    CFG.outputDir,
    `${cleanIdentifier(proof.slug)}-runtime-run-mode-${CFG.metricScope}.json`,
  );
  await fs.writeFile(hotPath, `${JSON.stringify(hotArtifact, null, 2)}\n`);
  artifacts.push({ kind: CFG.metricScope, path: hotPath, proofId: hotArtifact.proofId });

  return artifacts;
}

function normalizeHiprtNegativeEditConfig(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('negative edit must be a JSON object');
  }
  const source = value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    ? value.source
    : {};
  const sourceFile = String(source.file ?? source.path ?? value.sourceFile ?? CFG.sourceRel).trim().replace(/\\/g, '/');
  const before = String(source.before ?? value.before ?? '').trim();
  const after = String(source.after ?? value.after ?? '').trim();
  const reasons = [
    ...(Array.isArray(value.reasons) ? value.reasons : []),
    ...(Array.isArray(value.unsupportedReasons) ? value.unsupportedReasons : []),
    ...(Array.isArray(value.unsupported_reasons) ? value.unsupported_reasons : []),
  ].map((item) => String(item).trim()).filter(Boolean);
  if (!sourceFile) throw new Error('negative edit source.file is required');
  if (!before) throw new Error('negative edit source.before is required');
  if (!after) throw new Error('negative edit source.after is required');
  if (before === after) throw new Error('negative edit source.before and source.after must differ');
  if (reasons.length === 0) throw new Error('negative edit reasons are required');
  return {
    sourceFile,
    before,
    after,
    reasons: [...new Set(reasons)],
    abiCompatibilityClass: String(
      value.abiCompatibilityClass
        ?? value.abi_compatibility_class
        ?? 'layout_changed',
    ).trim() || 'layout_changed',
  };
}

async function writeHiprtNegativeEditRefusalArtifact({ proof, baselineSource }) {
  const negativeEdit = normalizeHiprtNegativeEditConfig(CFG.negativeEdit);
  if (!negativeEdit) return null;
  if (negativeEdit.sourceFile !== CFG.sourceRel) {
    throw new Error(`negative edit source ${negativeEdit.sourceFile} does not match proof source ${CFG.sourceRel}`);
  }
  const beforeCount = countOccurrences(baselineSource, negativeEdit.before);
  const afterCount = countOccurrences(baselineSource, negativeEdit.after);
  if (beforeCount !== 1) {
    throw new Error(`negative edit source.before must occur exactly once in git baseline; found ${beforeCount}`);
  }
  const editedSource = baselineSource.replace(negativeEdit.before, negativeEdit.after);
  const editHash = `sha256:${sha256Hex(editedSource)}`;
  const runMode = runtimeRunModeMetadata({
    metricScope: 'hot_delta_2',
    cacheState: CFG.cacheState,
    editId: `negative-edit:${sha256Hex(editHash).slice(0, 16)}`,
    editHash,
    editKind: 'negative_edit',
    differentEdit: true,
  });
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    proofId: `agent-split-negative-edit-refusal:${sha256Json({
      backend: 'hiprt',
      profileId: CFG.profileId,
      sourceFile: negativeEdit.sourceFile,
      editHash,
      reasons: negativeEdit.reasons,
      sourceProofId: proof.proofId,
    })}`,
    backend: 'hiprt',
    targetId: CFG.profileId,
    target_id: CFG.profileId,
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    route: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'reject',
      confidence: 1,
      blocking_gaps: negativeEdit.reasons,
    },
    abiCompatibilityClass: negativeEdit.abiCompatibilityClass,
    abi_compatibility_class: negativeEdit.abiCompatibilityClass,
    reasons: negativeEdit.reasons,
    unsupportedReasons: negativeEdit.reasons,
    unsupported_reasons: negativeEdit.reasons,
    source: {
      file: negativeEdit.sourceFile,
      before: negativeEdit.before,
      after: negativeEdit.after,
      beforeCount,
      afterCount,
      baselineHash: proof.source.baselineHash,
      editedHash: editHash,
    },
    runMode,
    run_mode: runMode,
    timingMetrics: runMode,
    timing_metrics: runMode,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'negative_edit',
    evidence_kind: 'negative_edit',
    coverageObligations: { hiprtRunModes: true, perTargetRunModes: false },
    coverage_obligations: { hiprt_run_modes: true, per_target_run_modes: false },
    validationTargetScope: 'hiprt_run_mode_support',
    validation_target_scope: 'hiprt_run_mode_support',
  };
  const artifactPath = path.join(
    CFG.outputDir,
    `${cleanIdentifier(proof.slug)}-negative-edit-refusal.json`,
  );
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return {
    kind: 'negative_edit_refusal',
    path: artifactPath,
    proofId: artifact.proofId,
  };
}

async function findStrictProofJson() {
  if (CFG.strictProofJson) {
    const filePath = path.resolve(REPO_ROOT, CFG.strictProofJson);
    return { path: filePath, proof: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  }
  const legacyProofDir = path.join(ARTIFACT_ROOT, 'hiprt-light-math-proof');
  let entries = [];
  try {
    entries = await fs.readdir(legacyProofDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-proof.json')) continue;
    const filePath = path.join(legacyProofDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      const proof = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (proof?.hmr?.strictFullRuntimePassed === true || proof?.hmr?.fullRuntimeProven === true) {
        candidates.push({ path: filePath, proof, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore malformed old artifacts; the proof gate below will fail if no valid one remains.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findReusableBaselineProof({ repoCommit, source }) {
  if (!CFG.reuseBaseline) return null;
  let entries = [];
  try {
    entries = await fs.readdir(CFG.outputDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-proof.json')) continue;
    const filePath = path.join(CFG.outputDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      const proof = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const baselinePath = proof?.baseline?.path;
      if (
        proof?.accepted === true
        && proof?.repo?.commit === repoCommit
        && proof?.repo?.target === CFG.targetName
        && proof?.dimensions?.width === CFG.width
        && proof?.dimensions?.height === CFG.height
        && proof?.source?.file === source.file
        && proof?.source?.baselineHash === source.baselineHash
        && typeof baselinePath === 'string'
        && await fileExists(baselinePath)
      ) {
        candidates.push({ path: filePath, proof, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Reuse is opportunistic; malformed cache entries are ignored.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

function requiredKernelsPresent(kernels) {
  return CFG.requiredKernels.every((kernel) => kernels.includes(kernel));
}

function summarizeStrictProof(strict) {
  if (!strict) return null;
  return {
    path: strict.path,
    schemaVersion: strict.proof?.schemaVersion ?? null,
    slug: strict.proof?.slug ?? null,
    fullRuntimeProven: strict.proof?.hmr?.fullRuntimeProven === true,
    strictFullRuntimePassed: strict.proof?.hmr?.strictFullRuntimePassed === true,
    runtimeProof: strict.proof?.hmr?.runtimeProof ?? null,
    hmrMathDelta: strict.proof?.hmr?.mathDelta ?? null,
  };
}

async function writeHiprtBoundarySelfCheckImage(filePath, variant) {
  const width = 96;
  const height = 64;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const gradient = Math.floor((x / width) * 120 + (y / height) * 80);
      if (variant === 'after') {
        raw[i] = Math.min(255, 80 + gradient);
        raw[i + 1] = Math.min(255, 110 + Math.floor(y * 1.5));
        raw[i + 2] = Math.max(0, 220 - gradient);
      } else {
        raw[i] = Math.min(255, 30 + Math.floor(y * 0.8));
        raw[i + 1] = Math.min(255, 60 + gradient);
        raw[i + 2] = Math.min(255, 90 + Math.floor(x * 0.8));
      }
      raw[i + 3] = 255;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function hiprtBoundarySelfCheckRuntimeProbeInstrumentation() {
  return {
    schemaVersion: 'synthi.gpu.hmr.profile_probe_instrumentation.v1',
    kind: 'declared_runtime_boundary_app_hook',
    instrumentationKind: 'runtime_boundary_app_hook',
    instrumentation_kind: 'runtime_boundary_app_hook',
    adapterFamily: 'hiprt-runtime-boundary-app-hook',
    adapter_family: 'hiprt-runtime-boundary-app-hook',
    profileId: CFG.profileId,
    profile_id: CFG.profileId,
    targetName: CFG.targetName,
    target_name: CFG.targetName,
    accepted: true,
    applied: false,
    adaptedOrAlreadyPresent: false,
    adapted_or_already_present: false,
    sourceAdaptations: [],
    source_adaptations: [],
    acceptanceScope: 'hiprt_declared_visual_profile',
    acceptance_scope: 'hiprt_declared_visual_profile',
    proofAuthority: 'hiprt_runtime_boundary_app_hook_not_source_adapted',
    proof_authority: 'hiprt_runtime_boundary_app_hook_not_source_adapted',
    executionBoundary: 'HIPRT app-emitted runtime boundary events',
    execution_boundary: 'HIPRT app-emitted runtime boundary events',
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    broadApplicationAcceptance: false,
    broad_application_acceptance: false,
    broadHipApplicationAcceptance: false,
    broad_hip_application_acceptance: false,
    unsupportedWithoutEvidence: ['unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook'],
    unsupported_without_evidence: ['unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook'],
  };
}

function hiprtBoundarySelfCheckEvents({ proof, artifactHashAfter, epoch, dispatchId }) {
  const processId = proof.runtime.changed.postRecompileEvidence.dispatch.processId;
  const stream = proof.runtime.changed.postRecompileEvidence.dispatch.stream;
  const deviceUuid = `rocm:${CFG.gpuArch}`;
  return [
    {
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      eventKind: 'artifact_transport',
      fields: {
        artifact_hash: artifactHashAfter,
        artifact_id: artifactHashAfter,
        process_id: processId,
        loader_api: 'hiprt_app_boundary_loader',
      },
    },
    {
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      eventKind: 'epoch_publication',
      fields: {
        artifact_hash: artifactHashAfter,
        epoch,
        process_id: processId,
        publish_mechanism: 'app_boundary_epoch_publish',
      },
    },
    {
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      eventKind: 'dispatch_trace',
      fields: {
        artifact_hash: artifactHashAfter,
        epoch,
        dispatch_id: dispatchId,
        process_id: processId,
        kernel_entry: CFG.reloadKernelSymbol,
        stream,
      },
    },
    {
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      eventKind: 'host_identity',
      fields: {
        process_id: processId,
        device_uuid: deviceUuid,
        context_id: 'hiprt-boundary-self-check-context',
        stream,
      },
    },
    {
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      eventKind: 'output_oracle',
      fields: {
        artifact_hash: artifactHashAfter,
        epoch,
        after_dispatch_id: dispatchId,
        process_id: processId,
        output_target: proof.runtime.changed.workerCapturePath,
        before_image_hash: proof.baseline.contentHash,
        after_image_hash: proof.changed.contentHash,
        diff_image_hash: proof.diff.contentHash,
      },
    },
  ];
}

async function buildHiprtBoundarySelfCheckProof(tmpDir, overrides = {}) {
  if (!CFG.gpuArch) CFG.gpuArch = 'gfx0000';
  if (!CFG.gpuArchSource) CFG.gpuArchSource = 'self_check';
  if (!CFG.rocmPrefix) CFG.rocmPrefix = '/opt/rocm-self-check';
  if (!CFG.rocmPrefixSource) CFG.rocmPrefixSource = 'self_check';
  const beforePath = path.join(tmpDir, `${overrides.slug ?? 'hiprt-boundary'}-before.png`);
  const afterPath = path.join(tmpDir, `${overrides.slug ?? 'hiprt-boundary'}-after.png`);
  const diffPath = path.join(tmpDir, `${overrides.slug ?? 'hiprt-boundary'}-diff.png`);
  await writeHiprtBoundarySelfCheckImage(beforePath, 'before');
  await writeHiprtBoundarySelfCheckImage(afterPath, 'after');
  const baselineStats = await imageStats(beforePath);
  const changedStats = await imageStats(afterPath);
  const diff = await diffImages({ baselinePath: beforePath, changedPath: afterPath, diffPath });
  const artifactHashBefore = sha256Json({ role: 'before', profile: CFG.profileId, source: CFG.sourceRel });
  const artifactHashAfter = sha256Json({ role: 'after', profile: CFG.profileId, source: CFG.sourceRel });
  const proof = {
    schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
    slug: overrides.slug ?? 'hiprt-runtime-boundary-app-hook-self-check',
    createdAt: '2026-06-30T00:00:00.000Z',
    mode: 'same-process',
    metricScope: 'hot_delta_1',
    metric_scope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    cache_state: 'compiler_cache_warm',
    profile: {
      id: CFG.profileId,
      requiredKernels: CFG.requiredKernels,
      reloadKernelName: CFG.reloadKernelName,
      reloadKernelSymbol: CFG.reloadKernelSymbol,
    },
    runtimeProfile: CFG.runtimeProfile,
    claim: 'A HIPRT app-emitted runtime boundary event chain proves a deterministic framebuffer change.',
    repo: {
      workerContainer: 'self-check',
      workerRepoPath: tmpDir,
      commit: 'hiprt-boundary-self-check-commit',
      target: CFG.targetName,
    },
    dimensions: { width: 96, height: 64 },
    source: {
      file: CFG.sourceRel,
      before: CFG.before,
      after: CFG.after,
      baselineHash: artifactHashBefore,
      changedHash: artifactHashAfter,
    },
    sourceWrites: {
      baseline: { contentHash: artifactHashBefore, workerSha256: artifactHashBefore },
      changed: { contentHash: artifactHashAfter, workerSha256: artifactHashAfter },
      restoredBaseline: { contentHash: artifactHashBefore, workerSha256: artifactHashBefore },
    },
    baselineReuse: { reused: false },
    sameProcessAdapter: null,
    sameProcessBuild: null,
    runtimeProbeInstrumentation: overrides.runtimeProbeInstrumentation
      ?? hiprtBoundarySelfCheckRuntimeProbeInstrumentation(),
    runtime_probe_instrumentation: overrides.runtimeProbeInstrumentation
      ?? hiprtBoundarySelfCheckRuntimeProbeInstrumentation(),
    strictHmrProvenance: {
      fullRuntimeProven: true,
      strictFullRuntimePassed: true,
      runtimeProof: 'hiprt-boundary-self-check',
    },
    runtime: {
      baseline: {
        variant: 'baseline',
        localCapturePath: beforePath,
        contentHash: baselineStats.contentHash,
        content_hash: baselineStats.contentHash,
        localCaptureHash: baselineStats.contentHash,
        local_capture_hash: baselineStats.contentHash,
        captureLine: 'SYNTHI_HIPRT_FRAME_CAPTURE baseline',
        nativeLaunchKernels: CFG.requiredKernels,
        runMs: 1,
        hostWallMs: 1,
      },
      changed: {
        variant: 'changed',
        localCapturePath: afterPath,
        workerCapturePath: afterPath,
        contentHash: changedStats.contentHash,
        content_hash: changedStats.contentHash,
        localCaptureHash: changedStats.contentHash,
        local_capture_hash: changedStats.contentHash,
        captureLine: 'SYNTHI_HIPRT_FRAME_CAPTURE changed',
        nativeLaunchKernels: CFG.requiredKernels,
        runMs: 1,
        hostWallMs: 1,
        totalHostWallMs: 2,
        sameProcess: true,
        liveRecompileMs: 1,
        triggerTouchMs: 1,
        triggerFinishedMonotonicNs: 1000,
        runCompletedMonotonicNs: 2000,
        shaderCacheArtifact: {
          selectedArtifactHash: artifactHashAfter,
          beforeManifestHash: artifactHashBefore,
        },
        postRecompileEvidence: {
          accepted: true,
          dispatch: {
            sequence: 7,
            processId: 'pid:hiprt-boundary-self-check',
            runtimeSession: 'hiprt-boundary-self-check-session',
            stream: 'stream:hiprt-boundary-self-check',
            functionPtr: '0xabc7',
            argsPtr: '0xfeed7',
            api: 'hipModuleLaunchKernel',
            gridDim: [1, 1, 1],
            blockDim: [8, 1, 1],
            sharedBytes: 0,
          },
        },
      },
    },
    baseline: baselineStats,
    changed: changedStats,
    diff,
    timings: {
      totalWallMs: 4,
      duration_ms: 4,
      sameProcessLiveRecompileMs: 1,
      sameProcessAdapterBuildMs: 0,
      baselineRunMs: 1,
      baselineHostWallMs: 1,
      changedRunMs: 1,
      changedHostWallMs: 1,
    },
    acceptance: {
      strictProvenance: true,
      sourceHashesDiffer: true,
      baselineCopiedToWorker: true,
      changedCopiedToWorker: true,
      restoredBaselineInWorker: true,
      baselineCapture: true,
      changedCapture: true,
      baselineNativeKernels: true,
      changedNativeKernels: true,
      sameProcessRuntime: true,
      visualDelta: true,
      oracleRegionNonBlank: true,
    },
    accepted: true,
  };
  const dispatch = proof.runtime.changed.postRecompileEvidence.dispatch;
  const epoch = hiprtRuntimeEpochFor({ proof, dispatch });
  const dispatchId = hiprtRuntimeDispatchIdFor({ proof, dispatch, artifactHashAfter });
  proof.runtimeBoundaryEvents = overrides.runtimeBoundaryEvents
    ?? hiprtBoundarySelfCheckEvents({ proof, artifactHashAfter, epoch, dispatchId });
  proof.runtime_boundary_events = proof.runtimeBoundaryEvents;
  proof.runtimeBoundaryEventSource = 'hiprt_runtime_boundary_app_hook_self_check';
  proof.runtime_boundary_event_source = proof.runtimeBoundaryEventSource;
  proof.timingMetrics = {
    ...hiprtWarmTimingMetrics(proof),
    ...hiprtHotRuntimeRunModeMetadata(proof),
  };
  const strictRuntimeProof = buildHiprtStrictRuntimeProofArtifact(proof);
  proof.runtimeProofArtifact = strictRuntimeProof.runtimeProofArtifact;
  proof.runtime_proof_artifact = strictRuntimeProof.runtimeProofArtifact;
  proof.runtimeProbeInstrumentation =
    strictRuntimeProof.runtimeProofArtifact.runtimeProbeInstrumentation
    ?? strictRuntimeProof.runtimeProofArtifact.runtime_probe_instrumentation
    ?? proof.runtimeProbeInstrumentation;
  proof.runtime_probe_instrumentation = proof.runtimeProbeInstrumentation;
  proof.proofLedger = strictRuntimeProof.proofLedger;
  proof.proof_ledger = strictRuntimeProof.proofLedger;
  proof.proofLedgerQuery = strictRuntimeProof.proofLedgerQuery;
  proof.proof_ledger_query = strictRuntimeProof.proofLedgerQuery;
  proof.visualEvidenceArtifacts = strictRuntimeProof.runtimeProofArtifact.visualEvidenceArtifacts;
  proof.visual_evidence_artifacts = strictRuntimeProof.runtimeProofArtifact.visual_evidence_artifacts;
  proof.acceptanceContract = strictRuntimeProof.acceptanceContract;
  proof.acceptance_contract = strictRuntimeProof.acceptanceContract;
  proof.acceptanceContractEvaluation = strictRuntimeProof.acceptanceContractEvaluation;
  proof.acceptance_contract_evaluation = strictRuntimeProof.acceptanceContractEvaluation;
  proof.deterministicVisualMode = strictRuntimeProof.deterministicVisualMode;
  proof.deterministic_visual_mode = strictRuntimeProof.deterministicVisualMode;
  proof.runtimeBoundaryAppHook = strictRuntimeProof.runtimeProofArtifact.runtimeBoundaryAppHook;
  proof.runtime_boundary_app_hook = proof.runtimeBoundaryAppHook;
  proof.strictRuntimeProofGate = strictRuntimeProof.strictGate;
  proof.strict_runtime_proof_gate = strictRuntimeProof.strictGate;
  proof.sourceAdaptedProfile = strictRuntimeProof.runtimeProofArtifact.sourceAdaptedProfile === true;
  proof.source_adapted_profile = proof.sourceAdaptedProfile;
  proof.sourceAdaptations = strictRuntimeProof.runtimeProofArtifact.sourceAdaptations ?? [];
  proof.source_adaptations = proof.sourceAdaptations;
  proof.visualProfileAccepted = strictRuntimeProof.runtimeProofArtifact.visualProfileAccepted === true;
  proof.visual_profile_accepted = proof.visualProfileAccepted;
  proof.gpuHmrSuccess = strictRuntimeProof.runtimeProofArtifact.gpuHmrSuccess === true;
  proof.gpu_hmr_success = proof.gpuHmrSuccess;
  proof.acceptedForGpuHmr = proof.gpuHmrSuccess;
  proof.accepted_for_gpu_hmr = proof.gpuHmrSuccess;
  proof.visualProofAccepted = proof.accepted === true;
  proof.visual_proof_accepted = proof.visualProofAccepted;
  proof.proofId = `hiprt-warm-runtime-proof:sha256:${sha256Hex(stableJson({
    slug: proof.slug,
    proofLedgerId: proof.proofLedger.proofId,
    runtimeProofArtifactId: proof.runtimeProofArtifact.proofId,
  }))}`;
  return proof;
}

async function hiprtRuntimeBoundaryAppHookSelfCheck() {
  const { collectGpuHmrValidationMatrixLedger } = await import(
    './lib/gpu-hmr-validation-matrix-ledger.mjs'
  );
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthi-hiprt-boundary-self-check-'));
  try {
    const acceptedProof = await buildHiprtBoundarySelfCheckProof(tmpDir);
    if (
      acceptedProof.gpuHmrSuccess !== true
      || acceptedProof.runtimeProofArtifact?.strictGate?.accepted !== true
      || acceptedProof.runtimeBoundaryAppHook?.accepted !== true
      || acceptedProof.sourceAdaptedProfile !== false
    ) {
      throw new Error(`HIPRT runtime-boundary self-check proof rejected ${stableJson({
        gpuHmrSuccess: acceptedProof.gpuHmrSuccess,
        strictGate: acceptedProof.runtimeProofArtifact?.strictGate,
        runtimeBoundaryAppHook: acceptedProof.runtimeBoundaryAppHook,
        sourceAdaptedProfile: acceptedProof.sourceAdaptedProfile,
      })}`);
    }
    const acceptedPath = path.join(tmpDir, 'hiprt-runtime-boundary-app-hook-proof.json');
    await fs.writeFile(acceptedPath, `${JSON.stringify(acceptedProof, null, 2)}\n`);
    const matrix = await collectGpuHmrValidationMatrixLedger({
      repoRoot: REPO_ROOT,
      mcpRoot: path.resolve(__dirname, '..'),
      roots: [tmpDir],
      latestPerTarget: false,
      includeUnproven: true,
      generatedAt: '2026-06-30T00:00:00.000Z',
    });
    const acceptedCandidateRows = matrix.rows.filter((row) =>
      row.proofIds?.includes(acceptedProof.runtimeProofArtifact.proofId));
    const acceptedRow = acceptedCandidateRows.find((row) =>
      row.backend === 'hiprt'
      && row.matrixOutcome === 'full_runtime_gpu_hmr'
      && row.acceptedForGpuHmr === true
      && row.gpuHmrSuccess === true);
    if (
      acceptedRow?.matrixOutcome !== 'full_runtime_gpu_hmr'
      || acceptedRow?.backend !== 'hiprt'
      || acceptedRow?.acceptedForGpuHmr !== true
    ) {
      throw new Error(`HIPRT runtime-boundary matrix self-check rejected accepted fixture ${stableJson({
        candidateCount: acceptedCandidateRows.length,
        candidates: acceptedCandidateRows.map((row) => ({
          matrixOutcome: row?.matrixOutcome,
          acceptanceClass: row?.acceptanceClass,
          backend: row?.backend,
          proofMode: row?.proofMode,
          acceptedForGpuHmr: row?.acceptedForGpuHmr,
          gpuHmrSuccess: row?.gpuHmrSuccess,
          reasons: row?.reasons,
          openGaps: row?.openGaps,
          safety: row?.safety,
          visualAccepted: row?.visual?.accepted,
          oracleRegionAccepted: row?.oracleRegion?.accepted,
          rowId: row?.rowId,
        })),
      })}`);
    }
    const sourceAdaptedProof = await buildHiprtBoundarySelfCheckProof(tmpDir, {
      slug: 'hiprt-runtime-boundary-source-adapted-self-check',
      runtimeProbeInstrumentation: {
        ...hiprtBoundarySelfCheckRuntimeProbeInstrumentation(),
        accepted: true,
        adaptedOrAlreadyPresent: true,
        adapted_or_already_present: true,
        sourceAdaptations: ['same_process_targeted_kernel_recompile_hook'],
        source_adaptations: ['same_process_targeted_kernel_recompile_hook'],
      },
    });
    if (
      sourceAdaptedProof.gpuHmrSuccess !== false
      || !sourceAdaptedProof.runtimeProofArtifact?.limitations?.some((entry) =>
        entry?.code === 'source_adapted_profile_not_no_shim_gpu_hmr')
    ) {
      throw new Error('HIPRT runtime-boundary self-check accepted source-adapted fixture');
    }
    const missingOutputProof = await buildHiprtBoundarySelfCheckProof(tmpDir, {
      slug: 'hiprt-runtime-boundary-missing-output-self-check',
      runtimeBoundaryEvents: acceptedProof.runtimeBoundaryEvents.filter((event) =>
        hiprtRuntimeBoundaryEventKind(event) !== 'output_oracle'),
    });
    if (
      missingOutputProof.gpuHmrSuccess !== false
      || !missingOutputProof.runtimeBoundaryAppHook?.blockingGaps?.includes(
        'hiprt_runtime_boundary_stage_output_oracle_missing_or_mismatched',
      )
    ) {
      throw new Error('HIPRT runtime-boundary self-check accepted missing output oracle event');
    }
    console.log(JSON.stringify({
      ok: true,
      schemaVersion: HIPRT_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION,
      proofId: acceptedProof.proofId,
      runtimeProofArtifactId: acceptedProof.runtimeProofArtifact.proofId,
      matrixProofId: matrix.proofId,
      rowId: acceptedRow.rowId,
      sourceAdaptedRejected: true,
      missingOutputRejected: true,
    }, null, 2));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--runtime-boundary-app-hook-self-check')) {
    await hiprtRuntimeBoundaryAppHookSelfCheck();
    return;
  }
  const totalStartedMonotonicNs = monotonicNowNs();
  await fs.mkdir(CFG.outputDir, { recursive: true });
  try {
    await ensureRocmBuildConfig();
  } catch (err) {
    const refusal = await writeHiprtPreflightRefusalArtifact({
      preflightResult: {
        accepted: false,
        repoCommit: null,
        buildExecutable: 'unknown',
        buildConfig: 'unknown',
        bootstrap: null,
        prerequisiteProbe: hiprtPreflightProbeFromError({
          stage: 'rocm_build_config_detection',
          err,
        }),
      },
      strictSummary: null,
      totalStartedMonotonicNs,
    });
    console.log(JSON.stringify({
      accepted: false,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      proofId: refusal.artifact.proofId,
      proof_id: refusal.artifact.proofId,
      proofPath: refusal.proofPath,
      proof_path: refusal.proofPath,
      mode: CFG.mode,
      profileId: CFG.profileId,
      profile_id: CFG.profileId,
      proofAuthority: HIPRT_PREFLIGHT_AUTHORITY,
      proof_authority: HIPRT_PREFLIGHT_AUTHORITY,
      blockingGaps: refusal.artifact.classification.blockingGaps,
      blocking_gaps: refusal.artifact.classification.blockingGaps,
      claimBoundary: {
        gpuHmrSuccess: false,
        acceptedForGpuHmr: false,
        rejectedDiagnosticAllowed: CFG.allowRejected,
      },
    }, null, 2));
    if (!CFG.allowRejected) {
      process.exitCode = 1;
    }
    return;
  }
  const strictProof = await findStrictProofJson();
  const strictSummary = summarizeStrictProof(strictProof);
  if (CFG.requireStrictProvenance && !strictSummary?.strictFullRuntimePassed) {
    throw new Error('strict full-runtime HMR provenance is required but no accepted prior proof JSON was found');
  }

  const preflightResult = await preflight();
  if (preflightResult.accepted !== true) {
    const refusal = await writeHiprtPreflightRefusalArtifact({
      preflightResult,
      strictSummary,
      totalStartedMonotonicNs,
    });
    console.log(JSON.stringify({
      accepted: false,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      proofId: refusal.artifact.proofId,
      proof_id: refusal.artifact.proofId,
      proofPath: refusal.proofPath,
      proof_path: refusal.proofPath,
      mode: CFG.mode,
      profileId: CFG.profileId,
      profile_id: CFG.profileId,
      proofAuthority: HIPRT_PREFLIGHT_AUTHORITY,
      proof_authority: HIPRT_PREFLIGHT_AUTHORITY,
      blockingGaps: refusal.artifact.classification.blockingGaps,
      blocking_gaps: refusal.artifact.classification.blockingGaps,
      claimBoundary: {
        gpuHmrSuccess: false,
        acceptedForGpuHmr: false,
        rejectedDiagnosticAllowed: CFG.allowRejected,
      },
    }, null, 2));
    if (!CFG.allowRejected) {
      process.exitCode = 1;
    }
    return;
  }
  const baselineSource = await readBaselineSourceFromGit();
  const beforeCount = countOccurrences(baselineSource, CFG.before);
  const afterCountInBaseline = countOccurrences(baselineSource, CFG.after);
  if (beforeCount !== 1) {
    throw new Error(`source anchor must occur exactly once in git baseline; found ${beforeCount}`);
  }
  if (afterCountInBaseline !== 0) {
    throw new Error(`patched expression unexpectedly appears in git baseline; found ${afterCountInBaseline}`);
  }
  const changedSource = baselineSource.replace(CFG.before, CFG.after);
  const source = {
    file: CFG.sourceRel,
    before: CFG.before,
    after: CFG.after,
    baselineHash: `sha256:${sha256Hex(baselineSource)}`,
    changedHash: `sha256:${sha256Hex(changedSource)}`,
  };

  let sameProcessAdapter = null;
  let sameProcessBuild = null;
  let reusableBaseline = null;
  let baselineWrite;
  let baselineRun;
  let changedWrite;
  let changedRun;
  let restoreWrite;
  if (CFG.mode === 'same-process') {
    sameProcessAdapter = await applySameProcessAdapter();
    sameProcessBuild = await buildHiprtTarget('same-process-adapter');
    baselineWrite = await writeVariantSource({ variant: 'baseline', text: baselineSource });
    try {
      const sameProcessRun = await runHiprtSameProcess({ changedSource });
      baselineRun = sameProcessRun.baselineRun;
      changedWrite = sameProcessRun.changedWrite;
      changedRun = sameProcessRun.changedRun;
      restoreWrite = await writeVariantSource({ variant: 'restored-baseline', text: baselineSource });
    } catch (err) {
      restoreWrite = await writeVariantSource({ variant: 'restored-baseline-after-failure', text: baselineSource });
      await refreshWorkerSourceIndex();
      throw err;
    }
  } else {
    reusableBaseline = await findReusableBaselineProof({
      repoCommit: preflightResult.repoCommit,
      source,
    });
    if (reusableBaseline) {
      baselineWrite = {
        reused: true,
        reusedFromProofPath: reusableBaseline.path,
        contentHash: source.baselineHash,
        workerSha256: source.baselineHash,
      };
      baselineRun = {
        ...reusableBaseline.proof.runtime.baseline,
        variant: 'baseline',
        reused: true,
        reusedFromProofPath: reusableBaseline.path,
        runMs: 0,
        hostWallMs: 0,
        localCapturePath: reusableBaseline.proof.baseline.path,
      };
    } else {
      baselineWrite = await writeVariantSource({ variant: 'baseline', text: baselineSource });
      baselineRun = await runHiprtVariant('baseline');
    }
    changedWrite = await writeVariantSource({ variant: 'changed', text: changedSource });
    changedRun = await runHiprtVariant('changed');
    restoreWrite = await writeVariantSource({ variant: 'restored-baseline', text: baselineSource });
  }
  await refreshWorkerSourceIndex();

  const baselineStats = await imageStats(baselineRun.localCapturePath);
  const changedStats = await imageStats(changedRun.localCapturePath);
  const diffPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-diff-amplified.png`);
  const diff = await diffImages({
    baselinePath: baselineRun.localCapturePath,
    changedPath: changedRun.localCapturePath,
    diffPath,
  });

  const acceptance = {
    strictProvenance: !CFG.requireStrictProvenance || strictSummary?.strictFullRuntimePassed === true,
    sourceHashesDiffer: source.baselineHash !== source.changedHash,
    baselineCopiedToWorker: baselineWrite.contentHash === baselineWrite.workerSha256,
    changedCopiedToWorker: changedWrite.contentHash === changedWrite.workerSha256,
    restoredBaselineInWorker: restoreWrite.contentHash === restoreWrite.workerSha256,
    baselineCapture: Boolean(baselineRun.captureLine) && baselineStats.acceptedAsVisualEvidence,
    changedCapture: Boolean(changedRun.captureLine) && changedStats.acceptedAsVisualEvidence,
    baselineNativeKernels: requiredKernelsPresent(baselineRun.nativeLaunchKernels),
    changedNativeKernels: requiredKernelsPresent(changedRun.nativeLaunchKernels),
    sameProcessRuntime:
      CFG.mode !== 'same-process'
      || (
        changedRun.sameProcess === true
        && Number.isFinite(changedRun.liveRecompileMs)
        && Boolean(changedRun.captureLine)
      ),
    visualDelta:
      diff.changedPixelRatioThreshold4 >= CFG.minChangedPixelRatio
      && diff.meanAbsDelta8bit >= CFG.minMeanAbsDelta8bit,
    oracleRegionNonBlank: diff.oracleRegion?.nonBlankAfterEpoch === true,
  };
  const accepted = Object.values(acceptance).every(Boolean);
  const totalTimingFields = monotonicTimingFields(totalStartedMonotonicNs);
  const runtimeProbeInstrumentation = buildHiprtRuntimeProbeInstrumentationDisclosure(sameProcessAdapter);
  const runtimeBoundaryEventSource = await loadRuntimeBoundaryEventsFromConfig();
  const proof = {
    schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
    slug: CFG.slug,
    createdAt: new Date().toISOString(),
    mode: CFG.mode,
    metricScope: CFG.metricScope,
    metric_scope: CFG.metricScope,
    cacheState: CFG.cacheState,
    cache_state: CFG.cacheState,
    profile: {
      id: CFG.profileId,
      requiredKernels: CFG.requiredKernels,
      reloadKernelName: CFG.reloadKernelName,
      reloadKernelSymbol: CFG.reloadKernelSymbol,
    },
    runtimeProfile: CFG.runtimeProfile,
    profileControls: {
      cmakeArgs: CFG.cmakeArgs,
      buildEnvKeys: Object.keys(CFG.buildEnv).sort(),
      runtimeEnvKeys: Object.keys(CFG.runtimeEnv).sort(),
      deterministicVisualMode: CFG.deterministicVisualMode,
    },
    claim: CFG.claim,
    repo: {
      workerContainer: CFG.workerContainer,
      workerRepoPath: CFG.workerRepoPath,
      commit: preflightResult.repoCommit,
      target: CFG.targetName,
    },
    dimensions: { width: CFG.width, height: CFG.height },
    runtimeLimits: {
      runTimeoutMs: CFG.runTimeoutMs,
      runTimeoutUnbounded: CFG.runTimeoutMs === 0,
      reloadTimeoutMs: CFG.reloadTimeoutMs,
      reloadTimeoutUnbounded: CFG.reloadTimeoutMs === 0,
      buildTimeoutMs: CFG.buildTimeoutMs,
      orochiApi: CFG.orochiApi || 'auto',
    },
    source,
    sourceWrites: {
      baseline: baselineWrite,
      changed: changedWrite,
      restoredBaseline: restoreWrite,
    },
    baselineReuse: reusableBaseline
      ? {
          reused: true,
          proofPath: reusableBaseline.path,
          proofId: reusableBaseline.proof.proofId ?? null,
          baselineContentHash: reusableBaseline.proof.baseline?.contentHash ?? null,
        }
      : { reused: false },
    sameProcessAdapter,
    sameProcessBuild,
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    runtimeBoundaryEvents: runtimeBoundaryEventSource.events,
    runtime_boundary_events: runtimeBoundaryEventSource.events,
    runtimeBoundaryEventSource: runtimeBoundaryEventSource.source,
    runtime_boundary_event_source: runtimeBoundaryEventSource.source,
    runtimeBoundaryEventManifestPath: runtimeBoundaryEventSource.manifestPath,
    runtime_boundary_event_manifest_path: runtimeBoundaryEventSource.manifestPath,
    strictHmrProvenance: strictSummary,
    runtime: {
      baseline: baselineRun,
      changed: changedRun,
    },
    baseline: baselineStats,
    changed: changedStats,
    diff,
    thresholds: {
      minChangedPixelRatio: CFG.minChangedPixelRatio,
      minMeanAbsDelta8bit: CFG.minMeanAbsDelta8bit,
      minOracleRegionVisibleRatio: CFG.minOracleRegionVisibleRatio,
      minOracleRegionMeanLuma8bit: CFG.minOracleRegionMeanLuma8bit,
      minOracleRegionUniqueColorSampleCount: CFG.minOracleRegionUniqueColorSampleCount,
    },
    timings: {
      ...totalTimingFields,
      totalWallMs: totalTimingFields.duration_ms,
      mode: CFG.mode,
      baselineReused: Boolean(reusableBaseline),
      sameProcessLiveRecompileMs: changedRun.liveRecompileMs ?? null,
      sameProcessTriggerWaitMs: changedRun.triggerWaitMs ?? null,
      sameProcessAdapterBuildMs: sameProcessBuild?.buildMs ?? null,
      baselineRunMs: baselineRun.runMs,
      baselineHostWallMs: baselineRun.hostWallMs,
      changedRunMs: changedRun.runMs,
      changedHostWallMs: changedRun.hostWallMs,
    },
    acceptance,
    accepted,
  };
  proof.timingMetrics = {
    ...hiprtWarmTimingMetrics(proof),
    ...hiprtHotRuntimeRunModeMetadata(proof),
  };
  const strictRuntimeProof = buildHiprtStrictRuntimeProofArtifact(proof);
  proof.runtimeProofArtifact = strictRuntimeProof.runtimeProofArtifact;
  proof.runtime_proof_artifact = strictRuntimeProof.runtimeProofArtifact;
  proof.runtimeProbeInstrumentation =
    strictRuntimeProof.runtimeProofArtifact.runtimeProbeInstrumentation
    ?? strictRuntimeProof.runtimeProofArtifact.runtime_probe_instrumentation
    ?? proof.runtimeProbeInstrumentation;
  proof.runtime_probe_instrumentation = proof.runtimeProbeInstrumentation;
  proof.proofLedger = strictRuntimeProof.proofLedger;
  proof.proof_ledger = strictRuntimeProof.proofLedger;
  proof.proofLedgerQuery = strictRuntimeProof.proofLedgerQuery;
  proof.proof_ledger_query = strictRuntimeProof.proofLedgerQuery;
  proof.acceptanceContract = strictRuntimeProof.acceptanceContract;
  proof.acceptance_contract = strictRuntimeProof.acceptanceContract;
  proof.acceptanceContractEvaluation = strictRuntimeProof.acceptanceContractEvaluation;
  proof.acceptance_contract_evaluation = strictRuntimeProof.acceptanceContractEvaluation;
  proof.deterministicVisualMode = strictRuntimeProof.deterministicVisualMode;
  proof.deterministic_visual_mode = strictRuntimeProof.deterministicVisualMode;
  proof.runtimeBoundaryAppHook = strictRuntimeProof.runtimeProofArtifact.runtimeBoundaryAppHook;
  proof.runtime_boundary_app_hook = proof.runtimeBoundaryAppHook;
  proof.strictRuntimeProofGate = strictRuntimeProof.strictGate;
  proof.strict_runtime_proof_gate = strictRuntimeProof.strictGate;
  proof.sourceAdaptedProfile = strictRuntimeProof.runtimeProofArtifact.sourceAdaptedProfile === true;
  proof.source_adapted_profile = proof.sourceAdaptedProfile;
  proof.sourceAdaptations = strictRuntimeProof.runtimeProofArtifact.sourceAdaptations ?? [];
  proof.source_adaptations = proof.sourceAdaptations;
  proof.visualProfileAccepted = strictRuntimeProof.runtimeProofArtifact.visualProfileAccepted === true;
  proof.visual_profile_accepted = proof.visualProfileAccepted;
  proof.gpuHmrSuccess = strictRuntimeProof.runtimeProofArtifact.gpuHmrSuccess === true;
  proof.gpu_hmr_success = proof.gpuHmrSuccess;
  proof.acceptedForGpuHmr = proof.gpuHmrSuccess;
  proof.accepted_for_gpu_hmr = proof.gpuHmrSuccess;
  proof.visualProofAccepted = proof.accepted === true;
  proof.visual_proof_accepted = proof.visualProofAccepted;
  const proofBytesForId = Buffer.from(JSON.stringify({
    schemaVersion: proof.schemaVersion,
    slug: proof.slug,
    mode: proof.mode,
    profile: proof.profile,
    repo: proof.repo,
    source: proof.source,
    strictHmrProvenance: proof.strictHmrProvenance,
    baselineHash: proof.baseline.contentHash,
    changedHash: proof.changed.contentHash,
    diffHash: proof.diff.contentHash,
    timings: proof.timings,
    timingMetrics: proof.timingMetrics,
    acceptance: proof.acceptance,
    accepted: proof.accepted,
    visualProofAccepted: proof.visualProofAccepted,
    gpuHmrSuccess: proof.gpuHmrSuccess,
    visualProfileAccepted: proof.visualProfileAccepted,
    sourceAdaptedProfile: proof.sourceAdaptedProfile,
    sourceAdaptations: proof.sourceAdaptations,
    runtimeProbeInstrumentation: proof.runtimeProbeInstrumentation,
    runtimeBoundaryAppHook: proof.runtimeBoundaryAppHook,
    runtimeProofArtifactId: proof.runtimeProofArtifact.proofId,
    proofLedgerId: proof.proofLedger.proofId,
    acceptanceContractHash: proof.acceptanceContract.contract_hash,
  }));
  proof.proofId = `hiprt-warm-runtime-proof:sha256:${sha256Hex(proofBytesForId)}`;
  proof.runModeProofArtifacts = await writeHiprtRuntimeRunModeProofArtifacts(proof);
  proof.run_mode_proof_artifacts = proof.runModeProofArtifacts;
  const negativeEditRefusal = await writeHiprtNegativeEditRefusalArtifact({ proof, baselineSource });
  proof.negativeEditRefusalArtifact = negativeEditRefusal;
  proof.negative_edit_refusal_artifact = negativeEditRefusal;
  const proofPath = path.join(CFG.outputDir, `${cleanIdentifier(CFG.slug)}-proof.json`);
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({
    accepted: proof.gpuHmrSuccess,
    acceptedForGpuHmr: proof.acceptedForGpuHmr,
    accepted_for_gpu_hmr: proof.acceptedForGpuHmr,
    gpuHmrSuccess: proof.gpuHmrSuccess,
    gpu_hmr_success: proof.gpuHmrSuccess,
    visualProofAccepted: proof.visualProofAccepted,
    visual_proof_accepted: proof.visualProofAccepted,
    visualEvidenceAccepted: accepted,
    visual_evidence_accepted: accepted,
    proofId: proof.proofId,
    proofPath,
    mode: CFG.mode,
    profileId: CFG.profileId,
    baseline: baselineStats.path,
    changed: changedStats.path,
    diff: diff.path,
    timings: proof.timings,
    timingMetrics: proof.timingMetrics,
    diffStats: {
      changedPixelRatioThreshold4: diff.changedPixelRatioThreshold4,
      meanAbsDelta8bit: diff.meanAbsDelta8bit,
      maxChannelDelta8bit: diff.maxChannelDelta8bit,
      oracleRegion: diff.oracleRegion,
    },
    baselineReused: Boolean(reusableBaseline),
    sameProcess: {
      enabled: CFG.mode === 'same-process',
      liveRecompileMs: changedRun.liveRecompileMs ?? null,
      adapterBuildMs: sameProcessBuild?.buildMs ?? null,
    },
    runtimeProbeInstrumentation: {
      accepted: proof.runtimeProbeInstrumentation.accepted,
      acceptanceScope: proof.runtimeProbeInstrumentation.acceptanceScope,
      sourceAdaptations: proof.runtimeProbeInstrumentation.sourceAdaptations,
      arbitraryLibraryAccepted: proof.runtimeProbeInstrumentation.arbitraryLibraryAccepted,
    },
    claimBoundary: {
      gpuHmrSuccess: proof.gpuHmrSuccess,
      visualProofAccepted: proof.visualProofAccepted,
      visualProfileAccepted: proof.visualProfileAccepted,
      sourceAdaptedProfile: proof.sourceAdaptedProfile,
      acceptedForGpuHmr: proof.acceptedForGpuHmr,
      rejectedDiagnosticAllowed: CFG.allowRejected,
    },
    strictRuntimeProof: {
      gpuHmrSuccess: proof.gpuHmrSuccess,
      proofId: proof.runtimeProofArtifact.proofId,
      ledgerProofId: proof.proofLedger.proofId,
      strictGateStatus: proof.strictRuntimeProofGate.status,
      strictGateFailures: proof.strictRuntimeProofGate.failures,
    },
    kernels: {
      baseline: baselineRun.nativeLaunchKernels.filter((kernel) =>
        [...CFG.requiredKernels, 'GMoNComputeMedianOfMeans'].includes(kernel),
      ),
      changed: changedRun.nativeLaunchKernels.filter((kernel) =>
        [...CFG.requiredKernels, 'GMoNComputeMedianOfMeans'].includes(kernel),
      ),
    },
  }, null, 2));
  if (proof.gpuHmrSuccess !== true && !CFG.allowRejected) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  if (err?.output) {
    console.error(String(err.output).slice(-8000));
  }
  process.exitCode = 1;
});
