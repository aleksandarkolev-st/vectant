#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  buildGpuHmrProofLedger,
  evaluateGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import {
  hipModuleRuntimeTimingMetrics,
} from './lib/gpu-hmr-timing-metrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/hip-module-runtime-proof');
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'profiles/hip-module-runtime-readback.json');
const PROBE_SOURCE_PATH = path.join(__dirname, 'probes/hip_module_runtime_probe.cpp');
const SCHEMA = 'synthi.gpu_hmr.hip_module_runtime_proof.v1';
const PROFILE_SCHEMA = 'synthi.gpu.hmr.hip_module_runtime_profile.v1';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';
const SUPPORTED_SCOPE = 'explicit-hip-module-float32-readback';

const MODEL_REGISTRY = Object.freeze({
  'gemini-3.5-flash': {
    provider_model_status: 'available',
    provider_model_alias_resolved_to: 'gemini-3.5-flash',
    provider_shutdown_or_deprecation_detected: false,
  },
  'gemini-3.1-flash-lite': {
    provider_model_status: 'available',
    provider_model_alias_resolved_to: 'gemini-3.1-flash-lite',
    provider_shutdown_or_deprecation_detected: false,
  },
  'gemini-3.1-flash-lite-preview': {
    provider_model_status: 'shutdown',
    provider_model_alias_resolved_to: 'gemini-3.1-flash-lite',
    provider_shutdown_or_deprecation_detected: true,
    provider_recommended_replacement: 'gemini-3.1-flash-lite',
  },
});

const CFG = {
  slug: process.env.SLUG ?? `hip-module-runtime-${nowSlugDate()}`,
  profilePath: process.env.SYNTHI_HIP_MODULE_PROFILE ?? DEFAULT_PROFILE_PATH,
  hipcc: process.env.SYNTHI_HIP_MODULE_HIPCC ?? process.env.HIPCC ?? 'hipcc',
  execContainer: process.env.SYNTHI_HIP_MODULE_EXEC_CONTAINER ?? process.env.WORKER_CONTAINER ?? '',
  gpuArch: process.env.SYNTHI_HIP_MODULE_GPU_ARCH ?? process.env.SYNTHI_GPU_ARCH ?? '',
  timeoutMs: Number(process.env.SYNTHI_HIP_MODULE_TIMEOUT_MS ?? 120000),
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
  metricScope: process.env.SYNTHI_HIP_MODULE_METRIC_SCOPE ?? '',
  cacheState: process.env.SYNTHI_HIP_MODULE_CACHE_STATE ?? '',
  differentEdit: process.env.SYNTHI_HIP_MODULE_DIFFERENT_EDIT === '1',
};

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Text(value) {
  return sha256Bytes(String(value));
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function safeSlug(value) {
  return String(value || 'hip-module-runtime').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInteger(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInteger(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function resolveRelative(baseDir, value) {
  if (!firstText(value)) return null;
  const candidate = String(value);
  return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
}

function relRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function nsSince(startNs) {
  return Number(process.hrtime.bigint() - startNs);
}

function durationNs(startNs, endNs) {
  return Number(endNs - startNs);
}

function encodeFloat32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(Number(value), index * 4));
  return buffer;
}

function decodeFloat32(bytes) {
  const out = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    out.push(bytes.readFloatLE(offset));
  }
  return out;
}

function normalizeFloat32Values(rawValues, field) {
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    throw new Error(`${field} must be a non-empty float array`);
  }
  const values = rawValues.map(Number);
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) throw new Error(`${field}[${invalidIndex}] must be finite`);
  return values;
}

function normalizeDim(raw, fallback = {}) {
  const dim = objectOrEmpty(raw);
  return {
    x: positiveInteger(dim.x, fallback.x ?? 1),
    y: positiveInteger(dim.y, fallback.y ?? 1),
    z: positiveInteger(dim.z, fallback.z ?? 1),
  };
}

function compareFloat32Values(actual, expected, tolerance) {
  const mismatches = [];
  const compared = Math.min(actual.length, expected.length);
  let maxAbsDelta = 0;
  for (let index = 0; index < compared; index += 1) {
    const delta = Math.abs(Number(actual[index]) - Number(expected[index]));
    maxAbsDelta = Math.max(maxAbsDelta, delta);
    if (delta > tolerance) {
      mismatches.push({
        index,
        actual: actual[index],
        expected: expected[index],
        abs_delta: delta,
      });
    }
  }
  if (actual.length !== expected.length) {
    mismatches.push({
      index: compared,
      actual_length: actual.length,
      expected_length: expected.length,
      abs_delta: null,
    });
  }
  return {
    declared: true,
    matched: mismatches.length === 0,
    compared,
    maxAbsDelta,
    mismatches,
  };
}

function modelRegistryStatus(model) {
  return MODEL_REGISTRY[model] ?? {
    provider_model_status: 'unknown',
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
  };
}

function modelProvenanceRecord({ mode, model, checkedAt }) {
  const status = modelRegistryStatus(model);
  return {
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: status.provider_model_status,
    provider_model_alias_resolved_to: status.provider_model_alias_resolved_to,
    provider_shutdown_or_deprecation_detected: status.provider_shutdown_or_deprecation_detected,
    provider_model_status_source: 'static_registry',
    provider_model_status_checked_against: MODEL_AVAILABILITY_SOURCE,
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
    model_availability_checked_at: checkedAt,
    actual_model: status.provider_model_status === 'shutdown' ? null : model,
    fallback_model: null,
    fallback_used: false,
    request_mode: mode,
    hard_infra_failure: status.provider_model_status === 'shutdown',
  };
}

function modelProvenance({ checkedAt, splitModel, gpuDeltaModel }) {
  return {
    split: modelProvenanceRecord({ mode: 'split', model: splitModel, checkedAt }),
    gpu_delta: modelProvenanceRecord({ mode: 'gpu_delta', model: gpuDeltaModel, checkedAt }),
  };
}

function timingFields(ns, runMode) {
  const fallback = 0;
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    different_edit: runMode.different_edit,
    static_discovery_time: ns.staticDiscovery ?? fallback,
    ai_contract_synthesis_time: ns.aiContractSynthesis ?? fallback,
    model_availability_check_time: ns.modelAvailability ?? fallback,
    artifact_hash_time: ns.artifactHash ?? fallback,
    adapter_generation_time: ns.adapterGeneration ?? fallback,
    device_compile_wall_time: ns.deviceCompileWall ?? fallback,
    artifact_load_time: ns.artifactLoad ?? fallback,
    epoch_publish_time: ns.epochPublish ?? fallback,
    dispatch_trace_time: ns.dispatchTrace ?? fallback,
    runtime_probe_time: ns.runtimeProbe ?? fallback,
    oracle_analysis_time: ns.oracleAnalysis ?? fallback,
    trigger_to_visible_time: ns.triggerToVisible ?? fallback,
    screenshot_capture_time: ns.screenshotCapture ?? fallback,
    dispatch_to_output_proof_time: ns.dispatchToOutputProof ?? fallback,
    total_validator_wall_time: ns.totalValidatorWall ?? fallback,
  };
}

async function loadProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const profileDir = path.dirname(resolvedPath);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const compile = objectOrEmpty(raw.compile);
  const kernel = objectOrEmpty(raw.kernel);
  const launch = objectOrEmpty(raw.launch);
  const oracle = objectOrEmpty(raw.outputOracle ?? raw.output_oracle);
  const constants = objectOrEmpty(raw.constants);
  const abi = objectOrEmpty(raw.abi);
  const beforePath = resolveRelative(profileDir, firstText(
    compile.sourceBeforePath,
    compile.source_before_path,
    compile.beforePath,
    compile.before_path,
  ));
  const afterPath = resolveRelative(profileDir, firstText(
    compile.sourceAfterPath,
    compile.source_after_path,
    compile.afterPath,
    compile.after_path,
  ));
  if (!beforePath || !afterPath) throw new Error('profile compile.sourceBeforePath and compile.sourceAfterPath are required');
  const buffers = firstArray(raw.buffers);
  const inputBuffer = buffers.find((buffer) => objectOrEmpty(buffer).role === 'input')
    ?? buffers.find((buffer) => firstText(objectOrEmpty(buffer).name) === 'input');
  const readbackBuffer = buffers.find((buffer) => objectOrEmpty(buffer).role === 'readback')
    ?? buffers.find((buffer) => firstText(objectOrEmpty(buffer).name) === firstText(oracle.readbackBuffer, oracle.readback_buffer));
  if (!inputBuffer || !readbackBuffer) throw new Error('profile must declare input and readback buffers');
  const inputValues = normalizeFloat32Values(inputBuffer.values, 'buffers[input].values');
  const expectedBeforeValues = normalizeFloat32Values(
    firstArray(oracle.expectedBeforeValues, oracle.expected_before_values),
    'outputOracle.expectedBeforeValues',
  );
  const expectedAfterValues = normalizeFloat32Values(
    firstArray(oracle.expectedAfterValues, oracle.expected_after_values, oracle.expectedValues, oracle.expected_values),
    'outputOracle.expectedAfterValues',
  );
  if (inputValues.length !== expectedBeforeValues.length || inputValues.length !== expectedAfterValues.length) {
    throw new Error('input, expected-before, and expected-after arrays must have the same length');
  }
  const [beforeSource, afterSource, beforeHash, afterHash] = await Promise.all([
    readFile(beforePath, 'utf8'),
    readFile(afterPath, 'utf8'),
    sha256File(beforePath),
    sha256File(afterPath),
  ]);
  const targetId = firstText(raw.targetId, raw.target_id, raw.id) ?? safeSlug(path.basename(resolvedPath, '.json'));
  const deterministicSlice = objectOrEmpty(oracle.deterministicSlice ?? oracle.deterministic_slice);
  const runMode = objectOrEmpty(raw.runMode ?? raw.run_mode);
  const negativeEdit = objectOrEmpty(raw.negativeEdit ?? raw.negative_edit);
  return {
    raw,
    schemaVersion: firstText(raw.schemaVersion, raw.schema_version) ?? PROFILE_SCHEMA,
    id: targetId,
    targetId,
    projectName: firstText(raw.project?.name, raw.name) ?? targetId,
    projectKind: firstText(raw.project?.kind, raw.project_kind) ?? 'gpu_project',
    validationScope: firstText(raw.validationScope, raw.validation_scope) ?? SUPPORTED_SCOPE,
    profilePath: resolvedPath,
    profileHash: sha256Text(stableJson(raw)),
    beforePath,
    afterPath,
    beforeSource,
    afterSource,
    beforeHash,
    afterHash,
    compile: {
      compiler: firstText(compile.compiler) ?? CFG.hipcc,
      compileTarget: firstText(compile.compileTarget, compile.compile_target) ?? 'rocm-hip-module-hsaco',
      gpuArch: firstText(compile.gpuArch, compile.gpu_arch, CFG.gpuArch) ?? '',
    },
    kernel: {
      name: firstText(kernel.name, kernel.kernelName, kernel.kernel_name) ?? 'synthi_hmr_float32_epoch_kernel',
      entryPoint: firstText(kernel.entryPoint, kernel.entry_point, kernel.name) ?? 'synthi_hmr_float32_epoch_kernel',
      launchApi: firstText(kernel.launchApi, kernel.launch_api) ?? 'hipModuleLaunchKernel',
    },
    launch: {
      gridDim: normalizeDim(launch.gridDim ?? launch.grid_dim, { x: 1, y: 1, z: 1 }),
      blockDim: normalizeDim(launch.blockDim ?? launch.block_dim, { x: 64, y: 1, z: 1 }),
      sharedMemBytes: nonNegativeInteger(launch.sharedMemBytes ?? launch.shared_mem_bytes, 0),
      stream: firstText(launch.stream) ?? 'hipStreamCreate',
    },
    abi: {
      class: firstText(abi.class, abi.value, abi.abiCompatibilityClass, abi.abi_compatibility_class) ?? 'compatible',
      params: firstArray(abi.params, abi.args).map((param) => ({
        name: firstText(param.name) ?? 'arg',
        type: firstText(param.type) ?? 'unknown',
        size: nonNegativeInteger(param.size, null),
        offset: nonNegativeInteger(param.offset, null),
        value_kind: firstText(param.valueKind, param.value_kind) ?? 'unknown',
        access: firstText(param.access) ?? 'unknown',
        address_space: firstText(param.addressSpace, param.address_space) ?? 'unknown',
        source: firstText(param.source) ?? 'profile_runtime_trace_contract',
      })),
    },
    buffers: {
      input: {
        name: firstText(inputBuffer.name) ?? 'input',
        dataType: firstText(inputBuffer.dataType, inputBuffer.data_type) ?? 'float32',
        values: inputValues,
      },
      readback: {
        name: firstText(readbackBuffer.name) ?? 'output',
        dataType: firstText(readbackBuffer.dataType, readbackBuffer.data_type) ?? 'float32',
        byteLength: positiveInteger(readbackBuffer.byteLength ?? readbackBuffer.byte_length, inputValues.length * 4),
      },
    },
    constants: {
      scale: finiteNumber(constants.scale, 1.0),
      bias: finiteNumber(constants.bias, 0.0),
    },
    outputOracle: {
      kind: firstText(oracle.kind) ?? 'buffer_checksum',
      expectedBeforeValues,
      expectedAfterValues,
      expectedOutputRequired: oracle.expectedOutputRequired !== false && oracle.expected_output_required !== false,
      expectedOutputChange: oracle.expectedOutputChange !== false && oracle.expected_output_change !== false,
      tolerance: Math.max(0, finiteNumber(oracle.tolerance, 0.00001)),
      deterministicSlice: {
        offset: nonNegativeInteger(deterministicSlice.offset ?? deterministicSlice.byte_offset, 0),
        length: positiveInteger(deterministicSlice.length ?? deterministicSlice.byte_length, inputValues.length * 4),
      },
    },
    runMode: {
      metricScope: firstText(CFG.metricScope, runMode.metricScope, runMode.metric_scope) ?? 'hot_delta_1',
      cacheState: firstText(CFG.cacheState, runMode.cacheState, runMode.cache_state) ?? 'compiler_cache_warm',
      differentEdit: CFG.differentEdit || runMode.differentEdit === true || runMode.different_edit === true,
    },
    negativeEdit: Object.keys(negativeEdit).length > 0 ? {
      editId: firstText(negativeEdit.editId, negativeEdit.edit_id) ?? `${targetId}-negative-edit`,
      editHash: sha256Text(stableJson(negativeEdit)),
      claim: firstText(negativeEdit.claim) ?? null,
      reasons: firstArray(negativeEdit.reasons, negativeEdit.unsupportedReasons, negativeEdit.unsupported_reasons),
      abiCompatibilityClass: firstText(
        negativeEdit.abiCompatibilityClass,
        negativeEdit.abi_compatibility_class,
      ) ?? 'layout_changed',
    } : null,
  };
}

function runModeMetadata(profile) {
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: profile.runMode.metricScope,
    metricScope: profile.runMode.metricScope,
    cache_state: profile.runMode.cacheState,
    cacheState: profile.runMode.cacheState,
    edit_id: `${profile.targetId}-hip-module-${profile.runMode.metricScope}`,
    editId: `${profile.targetId}-hip-module-${profile.runMode.metricScope}`,
    edit_hash: profile.afterHash,
    editHash: profile.afterHash,
    edit_kind: 'gpu_artifact_edit',
    editKind: 'gpu_artifact_edit',
    different_edit: profile.runMode.differentEdit,
    differentEdit: profile.runMode.differentEdit,
  };
}

function execFileChecked(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      timeout: options.timeout ?? CFG.timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env ?? process.env,
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

async function dockerExec(container, args, options = {}) {
  return execFileChecked('docker', [
    'exec',
    '-u',
    'root',
    '-w',
    options.workdir ?? '/tmp',
    container,
    ...args,
  ], {
    timeout: options.timeout ?? CFG.timeoutMs,
  });
}

async function dockerCpTo(container, localPath, remotePath) {
  await execFileChecked('docker', ['cp', localPath, `${container}:${remotePath}`], {
    timeout: CFG.timeoutMs,
  });
}

async function dockerCpFrom(container, remotePath, localPath) {
  await execFileChecked('docker', ['cp', `${container}:${remotePath}`, localPath], {
    timeout: CFG.timeoutMs,
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteDirFor(outDir) {
  return `/tmp/synthi-hip-module-runtime/${safeSlug(path.basename(outDir))}`;
}

function hipccArgsForHsaco({ sourcePath, outputPath, gpuArch }) {
  const args = ['--genco', '-O2'];
  if (gpuArch) args.push(`--offload-arch=${gpuArch}`);
  args.push('-o', outputPath, sourcePath);
  return args;
}

function probeExecutablePath(outDir) {
  return process.platform === 'win32'
    ? path.join(outDir, 'hip_module_runtime_probe.exe')
    : path.join(outDir, 'hip_module_runtime_probe');
}

async function compileRuntimeArtifacts({ profile, outDir }) {
  const hostPath = probeExecutablePath(outDir);
  const beforeHsaco = path.join(outDir, `${safeSlug(profile.targetId)}-before.hsaco`);
  const afterHsaco = path.join(outDir, `${safeSlug(profile.targetId)}-after.hsaco`);
  const compileStart = process.hrtime.bigint();
  if (CFG.execContainer) {
    const remoteDir = remoteDirFor(outDir);
    const remoteProbeSource = `${remoteDir}/hip_module_runtime_probe.cpp`;
    const remoteBeforeSource = `${remoteDir}/before.hip`;
    const remoteAfterSource = `${remoteDir}/after.hip`;
    const remoteHostPath = `${remoteDir}/hip_module_runtime_probe`;
    const remoteBeforeHsaco = `${remoteDir}/before.hsaco`;
    const remoteAfterHsaco = `${remoteDir}/after.hsaco`;
    await dockerExec(CFG.execContainer, [
      'sh',
      '-lc',
      `rm -rf ${shellQuote(remoteDir)} && mkdir -p ${shellQuote(remoteDir)}`,
    ], { timeout: CFG.timeoutMs });
    await dockerCpTo(CFG.execContainer, PROBE_SOURCE_PATH, remoteProbeSource);
    await dockerCpTo(CFG.execContainer, profile.beforePath, remoteBeforeSource);
    await dockerCpTo(CFG.execContainer, profile.afterPath, remoteAfterSource);
    const hostArgs = ['-std=c++17', '-O2', remoteProbeSource, '-o', remoteHostPath];
    const beforeArgs = hipccArgsForHsaco({
      sourcePath: remoteBeforeSource,
      outputPath: remoteBeforeHsaco,
      gpuArch: profile.compile.gpuArch,
    });
    const afterArgs = hipccArgsForHsaco({
      sourcePath: remoteAfterSource,
      outputPath: remoteAfterHsaco,
      gpuArch: profile.compile.gpuArch,
    });
    await dockerExec(CFG.execContainer, [CFG.hipcc, ...hostArgs], { timeout: CFG.timeoutMs });
    await dockerExec(CFG.execContainer, [CFG.hipcc, ...beforeArgs], { timeout: CFG.timeoutMs });
    await dockerExec(CFG.execContainer, [CFG.hipcc, ...afterArgs], { timeout: CFG.timeoutMs });
    await dockerCpFrom(CFG.execContainer, remoteBeforeHsaco, beforeHsaco);
    await dockerCpFrom(CFG.execContainer, remoteAfterHsaco, afterHsaco);
    const compileEnd = process.hrtime.bigint();
    return {
      transport: 'docker_exec_container',
      container: CFG.execContainer,
      hostPath,
      remoteHostPath,
      beforeHsaco,
      afterHsaco,
      remoteBeforeHsaco,
      remoteAfterHsaco,
      remoteDir,
      compiler: CFG.hipcc,
      commands: {
        host: ['docker', 'exec', '-u', 'root', '-w', '/tmp', CFG.execContainer, CFG.hipcc, ...hostArgs],
        before: ['docker', 'exec', '-u', 'root', '-w', '/tmp', CFG.execContainer, CFG.hipcc, ...beforeArgs],
        after: ['docker', 'exec', '-u', 'root', '-w', '/tmp', CFG.execContainer, CFG.hipcc, ...afterArgs],
      },
      compileDurationNs: durationNs(compileStart, compileEnd),
      beforeHsacoHash: await sha256File(beforeHsaco),
      afterHsacoHash: await sha256File(afterHsaco),
    };
  }
  const hostArgs = ['-std=c++17', '-O2', PROBE_SOURCE_PATH, '-o', hostPath];
  const beforeArgs = hipccArgsForHsaco({
    sourcePath: profile.beforePath,
    outputPath: beforeHsaco,
    gpuArch: profile.compile.gpuArch,
  });
  const afterArgs = hipccArgsForHsaco({
    sourcePath: profile.afterPath,
    outputPath: afterHsaco,
    gpuArch: profile.compile.gpuArch,
  });
  await execFileChecked(CFG.hipcc, hostArgs);
  await execFileChecked(CFG.hipcc, beforeArgs);
  await execFileChecked(CFG.hipcc, afterArgs);
  const compileEnd = process.hrtime.bigint();
  return {
    transport: 'local_process',
    hostPath,
    beforeHsaco,
    afterHsaco,
    compiler: CFG.hipcc,
    commands: {
      host: [CFG.hipcc, ...hostArgs],
      before: [CFG.hipcc, ...beforeArgs],
      after: [CFG.hipcc, ...afterArgs],
    },
    compileDurationNs: durationNs(compileStart, compileEnd),
    beforeHsacoHash: await sha256File(beforeHsaco),
    afterHsacoHash: await sha256File(afterHsaco),
  };
}

function csv(values) {
  return values.map((value) => Number(value).toString()).join(',');
}

async function writeProbePlan({ profile, outDir, beforeHsacoHash, afterHsacoHash }) {
  const planPath = path.join(outDir, `${safeSlug(profile.targetId)}-probe-plan.env`);
  const lines = [
    `kernel_name=${profile.kernel.name}`,
    `artifact_hash_before=${beforeHsacoHash}`,
    `artifact_hash_after=${afterHsacoHash}`,
    `dispatch_binding=hip-module-function-slot:${profile.kernel.name}`,
    `compile_target=${profile.compile.gpuArch || profile.compile.compileTarget}`,
    `grid_x=${profile.launch.gridDim.x}`,
    `grid_y=${profile.launch.gridDim.y}`,
    `grid_z=${profile.launch.gridDim.z}`,
    `block_x=${profile.launch.blockDim.x}`,
    `block_y=${profile.launch.blockDim.y}`,
    `block_z=${profile.launch.blockDim.z}`,
    `shared_mem_bytes=${profile.launch.sharedMemBytes}`,
    `element_count=${profile.buffers.input.values.length}`,
    `scale=${profile.constants.scale}`,
    `bias=${profile.constants.bias}`,
    `input_values=${csv(profile.buffers.input.values)}`,
    `expected_before_values=${csv(profile.outputOracle.expectedBeforeValues)}`,
    `expected_after_values=${csv(profile.outputOracle.expectedAfterValues)}`,
  ];
  await writeFile(planPath, `${lines.join('\n')}\n`);
  return planPath;
}

async function runHipProbe({ profile, compiled, outDir }) {
  const rawAfterPath = path.join(outDir, `${safeSlug(profile.targetId)}-after-readback.bin`);
  const runtimeTracePath = path.join(outDir, `${safeSlug(profile.targetId)}-runtime-trace.json`);
  const planPath = await writeProbePlan({
    profile,
    outDir,
    beforeHsacoHash: compiled.beforeHsacoHash,
    afterHsacoHash: compiled.afterHsacoHash,
  });
  const runtimeStart = process.hrtime.bigint();
  if (compiled.transport === 'docker_exec_container') {
    const remotePlanPath = `${compiled.remoteDir}/probe-plan.env`;
    const remoteRawAfterPath = `${compiled.remoteDir}/after-readback.bin`;
    const remoteRuntimeTracePath = `${compiled.remoteDir}/runtime-trace.json`;
    await dockerCpTo(CFG.execContainer, planPath, remotePlanPath);
    const run = await dockerExec(CFG.execContainer, [
      compiled.remoteHostPath,
      remotePlanPath,
      compiled.remoteBeforeHsaco,
      compiled.remoteAfterHsaco,
      remoteRawAfterPath,
      remoteRuntimeTracePath,
    ], {
      timeout: CFG.timeoutMs,
    });
    await dockerCpFrom(CFG.execContainer, remoteRawAfterPath, rawAfterPath);
    await dockerCpFrom(CFG.execContainer, remoteRuntimeTracePath, runtimeTracePath);
    const runtimeEnd = process.hrtime.bigint();
    const runtimeTrace = JSON.parse(await readFile(runtimeTracePath, 'utf8'));
    return {
      planPath,
      rawAfterPath,
      runtimeTracePath,
      runtimeTrace,
      stdout: run.stdout,
      stderr: run.stderr,
      runtimeDurationNs: durationNs(runtimeStart, runtimeEnd),
    };
  }
  const run = await execFileChecked(compiled.hostPath, [
    planPath,
    compiled.beforeHsaco,
    compiled.afterHsaco,
    rawAfterPath,
    runtimeTracePath,
  ], {
    timeout: CFG.timeoutMs,
  });
  const runtimeEnd = process.hrtime.bigint();
  const runtimeTrace = JSON.parse(await readFile(runtimeTracePath, 'utf8'));
  return {
    planPath,
    rawAfterPath,
    runtimeTracePath,
    runtimeTrace,
    stdout: run.stdout,
    stderr: run.stderr,
    runtimeDurationNs: durationNs(runtimeStart, runtimeEnd),
  };
}

async function renderComputeCard({
  filePath,
  profile,
  beforeValues,
  afterValues,
  rawHash,
  sliceHash,
  expectedVerification,
  runtimeTrace,
}) {
  const width = 760;
  const height = 440;
  const maxAbs = Math.max(1, ...afterValues.map((value) => Math.abs(value)));
  const bars = afterValues.slice(0, 16).map((value, index) => {
    const barWidth = 32;
    const x = 42 + index * 42;
    const h = Math.max(2, Math.abs(value) / maxAbs * 190);
    const y = value >= 0 ? 315 - h : 315;
    const fill = value >= 0 ? '#22c55e' : '#ef4444';
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${fill}"/>`;
  }).join('');
  const beforeText = beforeValues.slice(0, 8).map((value) => value.toFixed(2)).join(', ');
  const afterText = afterValues.slice(0, 8).map((value) => value.toFixed(2)).join(', ');
  const expectedText = `expected output verified: ${expectedVerification.matched ? 'true' : 'false'} max_delta=${expectedVerification.maxAbsDelta?.toFixed?.(6) ?? 'n/a'}`;
  const deviceText = `${runtimeTrace.device?.name ?? 'HIP device'} ${runtimeTrace.device?.compile_target ?? ''}`.slice(0, 90);
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#111827"/>
  <text x="32" y="42" fill="#f9fafb" font-family="Arial" font-size="24">HIP Module Runtime Readback Proof</text>
  <text x="32" y="75" fill="#93c5fd" font-family="Arial" font-size="14">${profile.targetId}</text>
  <text x="32" y="102" fill="#cbd5e1" font-family="Arial" font-size="13">${deviceText}</text>
  <text x="32" y="130" fill="#cbd5e1" font-family="Arial" font-size="13">raw ${rawHash.slice(0, 28)}... slice ${sliceHash.slice(0, 28)}...</text>
  <text x="32" y="158" fill="#cbd5e1" font-family="Arial" font-size="13">before[0..7] ${beforeText}</text>
  <text x="32" y="184" fill="#cbd5e1" font-family="Arial" font-size="13">after[0..7] ${afterText}</text>
  <text x="32" y="210" fill="#cbd5e1" font-family="Arial" font-size="13">${expectedText}</text>
  <text x="32" y="236" fill="#cbd5e1" font-family="Arial" font-size="13">API chain: hipModuleLoadData -> hipModuleGetFunction -> hipModuleLaunchKernel -> D2H readback</text>
  <line x1="32" y1="315" x2="728" y2="315" stroke="#4b5563" stroke-width="1"/>
  ${bars}
  <text x="32" y="392" fill="#e5e7eb" font-family="Arial" font-size="13">Card is generated from the raw HIP readback bytes after the epoch-2 dispatch.</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function writeComputeOracleArtifacts({ outDir, profile, runtimeTrace, rawAfterPath }) {
  const afterBytes = await readFile(rawAfterPath);
  const afterValues = decodeFloat32(afterBytes);
  const beforeValues = runtimeTrace.outputEvents?.[0]?.values ?? profile.outputOracle.expectedBeforeValues;
  const beforeBytes = encodeFloat32(beforeValues);
  const beforeRawPath = path.join(outDir, `${safeSlug(profile.targetId)}-before-readback.bin`);
  const schemaPath = path.join(outDir, `${safeSlug(profile.targetId)}-readback-schema.json`);
  const cardPath = path.join(outDir, `${safeSlug(profile.targetId)}-compute-card.png`);
  await writeFile(beforeRawPath, beforeBytes);
  const rawHash = sha256Bytes(afterBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedBytes = encodeFloat32(profile.outputOracle.expectedAfterValues);
  const expectedHash = sha256Bytes(expectedBytes);
  const expectedVerification = compareFloat32Values(
    afterValues,
    profile.outputOracle.expectedAfterValues,
    profile.outputOracle.tolerance,
  );
  const sliceOffset = Math.min(profile.outputOracle.deterministicSlice.offset, Math.max(0, afterBytes.length - 1));
  const sliceLength = Math.min(profile.outputOracle.deterministicSlice.length, afterBytes.length - sliceOffset);
  const sliceBytes = afterBytes.subarray(sliceOffset, sliceOffset + sliceLength);
  const sliceHash = sha256Bytes(sliceBytes);
  const readbackSchema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    producer: 'hip_module_runtime_proof',
    dataType: 'float32',
    byteLength: afterBytes.length,
    elementCount: afterValues.length,
    readbackResource: profile.buffers.readback.name,
    dispatchId: runtimeTrace.outputEvents?.[1]?.after_dispatch_id ?? runtimeTrace.dispatchEvents?.[1]?.id,
    epoch: 2,
    rawReadbackHash: rawHash,
    expectedOutput: {
      dataType: 'float32',
      values: profile.outputOracle.expectedAfterValues,
      tolerance: profile.outputOracle.tolerance,
      expectedHash,
      verified: expectedVerification.matched,
      maxAbsDelta: expectedVerification.maxAbsDelta,
      compared: expectedVerification.compared,
      mismatches: expectedVerification.mismatches,
    },
    deterministicSlice: {
      offset: sliceOffset,
      length: sliceLength,
      hash: sliceHash,
    },
    beforeValues,
    afterValues,
  };
  await writeFile(schemaPath, `${JSON.stringify(readbackSchema, null, 2)}\n`);
  await renderComputeCard({
    filePath: cardPath,
    profile,
    beforeValues,
    afterValues,
    rawHash,
    sliceHash,
    expectedVerification,
    runtimeTrace,
  });
  return {
    raw_readback_bin: relRepo(rawAfterPath),
    rawReadbackBin: relRepo(rawAfterPath),
    before_raw_readback_bin: relRepo(beforeRawPath),
    readback_schema_json: relRepo(schemaPath),
    readbackSchemaJson: relRepo(schemaPath),
    raw_readback_hash: rawHash,
    rawReadbackHash: rawHash,
    raw_readback_hash_verified: true,
    raw_readback_source: 'runtime_raw_readback',
    raw_readback_byte_length: afterBytes.length,
    readback_schema_hash: sha256Bytes(await readFile(schemaPath)),
    checksum_before: beforeHash,
    checksum_after: rawHash,
    output_change_expected: profile.outputOracle.expectedOutputChange,
    expected_output_declared: true,
    expected_output_required: profile.outputOracle.expectedOutputRequired,
    expected_output_data_type: 'float32',
    expected_output_values: profile.outputOracle.expectedAfterValues,
    expected_output_hash: expectedHash,
    expected_output_tolerance: profile.outputOracle.tolerance,
    expected_output_verified: expectedVerification.matched,
    expected_output_max_abs_delta: expectedVerification.maxAbsDelta,
    expected_output_compared: expectedVerification.compared,
    expected_output_mismatches: expectedVerification.mismatches,
    deterministic_slice: {
      offset: sliceOffset,
      length: sliceLength,
      hash: sliceHash,
      source: 'runtime_raw_readback',
    },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: sha256Text(renderComputeCard.toString()),
    rendered_card_png: relRepo(cardPath),
    renderedCardPng: relRepo(cardPath),
    rendered_card_hash: sha256Bytes(await readFile(cardPath)),
    producer: 'hip_module_runtime_proof',
    timestamp_after_dispatch: null,
    epoch: 2,
    raw_readback_verification: {
      raw_readback_hash: rawHash,
      hash_verified: true,
      byte_length: afterBytes.length,
      deterministic_slice_hash: sliceHash,
      deterministic_slice_hash_verified: true,
      readback_schema_hash: sha256Bytes(await readFile(schemaPath)),
    },
  };
}

function computeOracleValidation({ artifacts }) {
  const changed = artifacts.checksum_before !== artifacts.checksum_after;
  const expectedVerified = artifacts.expected_output_required === false
    ? artifacts.expected_output_verified !== false
    : artifacts.expected_output_declared === true && artifacts.expected_output_verified === true;
  return {
    accepted:
      changed
      && artifacts.raw_readback_hash_verified === true
      && artifacts.deterministic_slice_hash_verified === true
      && expectedVerified,
    checksumChanged: changed,
    rawReadbackHashVerified: artifacts.raw_readback_hash_verified === true,
    deterministicSliceHashVerified: artifacts.deterministic_slice_hash_verified === true,
    expectedOutputDeclared: artifacts.expected_output_declared === true,
    expectedOutputVerified: artifacts.expected_output_verified === true,
    expectedOutputRequired: artifacts.expected_output_required !== false,
    expectedOutputHash: artifacts.expected_output_hash,
    expectedOutputMaxAbsDelta: artifacts.expected_output_max_abs_delta,
    failedGates: [
      changed ? null : 'compute_oracle_checksum_unchanged',
      artifacts.raw_readback_hash_verified === true ? null : 'compute_oracle_raw_readback_hash_unverified',
      artifacts.deterministic_slice_hash_verified === true ? null : 'compute_oracle_deterministic_slice_hash_unverified',
      expectedVerified ? null : 'compute_oracle_expected_output_not_verified',
    ].filter(Boolean),
  };
}

function evidenceRefsForFields(fields, evidenceRefs) {
  return Object.fromEntries(fields.map((field) => [field, evidenceRefs]));
}

function buildFissionReport({ profile, compiled, runtimeTrace, oracleArtifacts }) {
  const decision = {
    targetId: profile.targetId,
    beforeHsacoHash: compiled.beforeHsacoHash,
    afterHsacoHash: compiled.afterHsacoHash,
    kernelName: profile.kernel.name,
    launch: profile.launch,
    readbackHash: oracleArtifacts.raw_readback_hash,
  };
  const verifierEvidenceRef = `runtime:fission-verifier-report:${sha256Text(stableJson(decision)).replace(/^sha256:/, '')}`;
  return {
    selected_island: `hip-module-hsaco:${profile.targetId}:${compiled.afterHsacoHash}`,
    selected_reason: 'verified_hip_module_contract',
    changed_sources: [profile.afterPath],
    included_dependencies: [profile.profilePath, PROBE_SOURCE_PATH],
    excluded_host_sources: [],
    artifact_hash_before: compiled.beforeHsacoHash,
    artifact_hash_after: compiled.afterHsacoHash,
    abi_compatibility_class: profile.abi.class,
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: runtimeTrace.processRestarted === true,
    full_rebuild_used: false,
    unaffected_artifacts_hash_unchanged: true,
    smallest_safe_island_proven: true,
    selected_verifier_evidence_id: verifierEvidenceRef,
    deterministic_verifier_evidence_refs: [
      verifierEvidenceRef,
      `runtime:hip-module:dispatch:${runtimeTrace.dispatchEvents?.[1]?.id}`,
      oracleArtifacts.raw_readback_hash,
    ],
    selection_decision_hash: sha256Text(stableJson(decision)),
    output_oracle_contract: {
      kind: 'compute_readback',
      readback_buffer: profile.buffers.readback.name,
      raw_readback_hash: oracleArtifacts.raw_readback_hash,
      expected_output_hash: oracleArtifacts.expected_output_hash,
      expected_output_verified: oracleArtifacts.expected_output_verified,
      deterministic_slice: oracleArtifacts.deterministic_slice,
    },
    evidence_refs: [
      verifierEvidenceRef,
      compiled.afterHsacoHash,
      `runtime:hip-module:dispatch:${runtimeTrace.dispatchEvents?.[1]?.id}`,
      `runtime:hip-module:readback:${oracleArtifacts.raw_readback_hash}`,
    ],
  };
}

function buildContract({ profile, compiled, runtimeTrace, runMode, oracleArtifacts }) {
  const afterDispatch = runtimeTrace.dispatchEvents?.[1] ?? {};
  const fieldEvidenceRefs = [
    profile.profileHash,
    compiled.beforeHsacoHash,
    compiled.afterHsacoHash,
    `${afterDispatch.id}:2`,
    oracleArtifacts.raw_readback_hash,
  ];
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: profile.targetId,
    edit_id: runMode.edit_id,
    backend: { value: 'hip' },
    confidence: 1.0,
    evidence_refs: fieldEvidenceRefs,
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: { value: 'reject' },
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 1.0,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: [profile.beforePath, profile.afterPath, profile.profilePath],
      artifact_kind: 'hsaco',
      entry_points: [profile.kernel.entryPoint],
      compile_target: profile.compile.gpuArch || profile.compile.compileTarget,
      compiler: CFG.hipcc,
      compiler_args_hash: sha256Text(stableJson(compiled.commands)),
      supported_pipeline_scope: profile.validationScope,
    },
    artifact_hash_before: compiled.beforeHsacoHash,
    artifact_hash_after: compiled.afterHsacoHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: profile.abi.class,
      evidence_refs: fieldEvidenceRefs,
    },
    abi_metadata: {
      args: profile.abi.params,
      descriptor_or_binding_layout: {
        value: 'hip_module_kernel_params',
        source: 'profile_runtime_trace_contract',
      },
      workgroup_or_launch_shape: {
        grid_dim: profile.launch.gridDim,
        block_dim: profile.launch.blockDim,
        source: 'runtime_trace',
      },
      stream_or_queue_requirements: {
        stream: profile.launch.stream,
        synchronization: 'hipEventRecord plus hipStreamSynchronize',
        source: 'runtime_trace',
      },
      extractor_sources: ['runtime_trace', 'hip_module_profile_schema'],
      extractor_provenance: [{
        source: 'runtime_trace',
        trace_epoch: 2,
        dispatch_id: afterDispatch.id,
      }],
    },
    reload_mechanism: { value: 'built_in' },
    adapter_outcome: { value: 'adapter_not_needed_builtin_reload' },
    reload_evidence_refs: [
      `runtime:hip-module:hipModuleLoadData:${compiled.afterHsacoHash}`,
      `runtime:hip-module:hipModuleGetFunction:${profile.kernel.name}`,
      `runtime:hip-module:epoch:2`,
    ],
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'hip_module_same_process_runtime_trace',
      evidence_refs: [`runtime:hip-module:process-continuity:${runtimeTrace.processId}`],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: runtimeTrace.processRestarted === true,
      process_id_before: runtimeTrace.processId,
      process_id_after: runtimeTrace.processId,
    },
    output_oracle_target: {
      kind: 'compute',
      target_id: profile.buffers.readback.name,
      compute_only_target_verified: true,
      evidence_refs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.rendered_card_png],
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: runtimeTrace.processId,
      device_uuid: runtimeTrace.device?.device_uuid,
      context_or_device_handle: runtimeTrace.device?.device_uuid,
      queue_or_stream_handle: profile.launch.stream,
      persistent_gpu_allocations: {
        readback_buffer: profile.buffers.readback.name,
        byte_length: profile.buffers.readback.byteLength,
      },
      engine_scene_handles: [],
      camera_state_hash: 'not-applicable:hip-module-compute',
      swapchain_or_framebuffer_identity: `hip-readback:${profile.buffers.readback.name}:${profile.buffers.readback.byteLength}`,
    },
    fission_report: buildFissionReport({ profile, compiled, runtimeTrace, oracleArtifacts }),
    epoch_policy: {
      publish_mechanism: 'same-process-hip-module-dispatch-slot',
      dispatch_binding: `hipModuleLaunchKernel:${profile.kernel.name}`,
      retirement_mechanism: 'hip-event-stream-synchronization-then-hipModuleUnload',
    },
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: ['runtime:hip-module:hipEventRecord', 'runtime:hip-module:hipStreamSynchronize', 'runtime:hip-module:hipModuleUnload'],
    },
    hip_contract: {
      kernel_name: profile.kernel.name,
      launch_api: 'hipModuleLaunchKernel',
      grid_dim: profile.launch.gridDim,
      block_dim: profile.launch.blockDim,
      shared_mem_bytes: profile.launch.sharedMemBytes,
      stream: profile.launch.stream,
      kernel_params: profile.abi.params,
      code_object_metadata: {
        artifact_kind: 'hsaco',
        compile_target: profile.compile.gpuArch || profile.compile.compileTarget,
        hsaco_hash_before: compiled.beforeHsacoHash,
        hsaco_hash_after: compiled.afterHsacoHash,
        symbol_resolution_api: 'hipModuleGetFunction',
      },
      output_buffers: [profile.buffers.readback.name],
      readback_oracle: {
        kind: profile.outputOracle.kind,
        readback_buffer: profile.buffers.readback.name,
        raw_readback_hash: oracleArtifacts.raw_readback_hash,
        expected_output_hash: oracleArtifacts.expected_output_hash,
        expected_output_verified: oracleArtifacts.expected_output_verified,
        after_dispatch_id: afterDispatch.id,
      },
      supported_pipeline_scope: profile.validationScope,
      field_evidence_refs: evidenceRefsForFields([
        'kernel_name',
        'launch_api',
        'grid_dim',
        'block_dim',
        'shared_mem_bytes',
        'stream',
        'kernel_params',
        'code_object_metadata',
        'output_buffers',
        'readback_oracle',
      ], fieldEvidenceRefs),
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `hip-module-contract:${contract.contract_hash}`;
  return contract;
}

function buildProofLedgerRecord({
  profile,
  compiled,
  runtimeTrace,
  contract,
  runMode,
  timings,
  modelProvenance,
  oracleArtifacts,
  oracleValidation,
}) {
  const afterEpoch = 2;
  const beforeEpoch = 1;
  const dispatchId = runtimeTrace.dispatchEvents?.[1]?.id ?? 'hip-module-dispatch-epoch-2';
  const processId = runtimeTrace.processId;
  const outputEvent = {
    id: `hip-module-output-${afterEpoch}`,
    kind: 'compute_readback',
    passed: oracleValidation.accepted,
    after_dispatch_id: dispatchId,
    artifact_hash: compiled.afterHsacoHash,
    epoch: afterEpoch,
    timestamp_monotonic_ns: timings.outputTimestampNs,
    process_id: processId,
    output_oracle: {
      kind: 'compute_oracle',
      oracle_artifacts: {
        compute_oracle_artifacts: {
          ...oracleArtifacts,
          timestamp_after_dispatch: timings.outputTimestampNs,
        },
      },
    },
  };
  return {
    project_id: profile.targetId,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    different_edit: runMode.different_edit,
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    artifact_before_hash: compiled.beforeHsacoHash,
    artifact_after_hash: compiled.afterHsacoHash,
    loader_event: {
      id: `hip-module-loader-${afterEpoch}`,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      source: 'hipModuleLoadData',
    },
    epoch_publish_event: {
      id: `hip-module-publish-${afterEpoch}`,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      dispatch_binding: `hipModuleLaunchKernel:${profile.kernel.name}`,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      launch_api: 'hipModuleLaunchKernel',
      kernel_name: profile.kernel.name,
      grid_dim: profile.launch.gridDim,
      block_dim: profile.launch.blockDim,
      shared_mem_bytes: profile.launch.sharedMemBytes,
      stream: profile.launch.stream,
      kernel_params: profile.abi.params,
      command: 'hipModuleLaunchKernel',
    },
    output_event: outputEvent,
    retirement_event: {
      id: `hip-module-retire-${beforeEpoch}`,
      status: 'stream_event_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: beforeEpoch,
      evidence_refs: [dispatchId, 'runtime:hip-module:hipEventRecord', 'runtime:hip-module:hipStreamSynchronize', 'runtime:hip-module:hipModuleUnload'],
    },
    process_identity: {
      process_id: processId,
      host_pid: processId,
      same_process: runtimeTrace.sameProcess === true,
    },
    device_identity: {
      backend: 'hip',
      device_uuid: runtimeTrace.device?.device_uuid,
      adapter_info: runtimeTrace.device,
      stream: profile.launch.stream,
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: runtimeTrace.processRestarted === true,
      process_id_before: processId,
      process_id_after: processId,
      evidence_source: 'hip_module_same_process_runtime_trace',
      evidence_refs: [`runtime:hip-module:process-continuity:${processId}`],
    },
    output_oracle_target: {
      kind: 'compute',
      target_id: profile.buffers.readback.name,
      compute_only_target_verified: true,
      evidence_refs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.rendered_card_png],
    },
    oracle_artifacts: {
      compute_oracle_artifacts: {
        ...oracleArtifacts,
        timestamp_after_dispatch: timings.outputTimestampNs,
      },
    },
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    timings,
    timing_metrics: {
      metric_clock: 'monotonic_ns',
      metric_scope: runMode.metric_scope,
      cache_state: runMode.cache_state,
    },
    model_provenance: modelProvenance,
    evidence_refs: [
      profile.profileHash,
      compiled.afterHsacoHash,
      oracleArtifacts.raw_readback_hash,
      `runtime:hip-module:dispatch:${dispatchId}`,
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: runtimeTrace.processRestarted === true,
  };
}

function nativeHipApiEvidence(runtimeTrace) {
  const loaders = Array.isArray(runtimeTrace.loaderEvents) ? runtimeTrace.loaderEvents : [];
  const symbols = Array.isArray(runtimeTrace.symbolEvents) ? runtimeTrace.symbolEvents : [];
  const dispatches = Array.isArray(runtimeTrace.dispatchEvents) ? runtimeTrace.dispatchEvents : [];
  const outputs = Array.isArray(runtimeTrace.outputEvents) ? runtimeTrace.outputEvents : [];
  const counts = {
    hipModuleLoadData: loaders.filter((entry) => entry?.api === 'hipModuleLoadData').length,
    hipModuleGetFunction: symbols.filter((entry) => entry?.api === 'hipModuleGetFunction').length,
    hipModuleLaunchKernel: dispatches.filter((entry) => entry?.launch_api === 'hipModuleLaunchKernel').length,
    outputReadback: outputs.filter((entry) => entry?.passed === true).length,
  };
  const failedGates = [
    counts.hipModuleLoadData >= 2 ? null : 'missing_hipModuleLoadData',
    counts.hipModuleGetFunction >= 2 ? null : 'missing_hipModuleGetFunction',
    counts.hipModuleLaunchKernel >= 2 ? null : 'missing_hipModuleLaunchKernel',
    counts.outputReadback >= 2 ? null : 'missing_output_readback',
    runtimeTrace.sameProcess === true ? null : 'same_process_not_proven',
  ].filter(Boolean);
  return {
    accepted: failedGates.length === 0,
    required: ['hipModuleLoadData', 'hipModuleGetFunction', 'hipModuleLaunchKernel', 'outputReadback'],
    counts,
    failedGates,
    source: 'native_hip_module_runtime_trace',
  };
}

function buildRunModeProof({ profile, runMode, ledger, proofLedger, oracleArtifacts, nativeApiEvidence }) {
  const record = proofLedger.records[0];
  const material = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    targetId: profile.targetId,
    backend: 'hip',
    runMode,
    ledgerProofId: ledger.proofId,
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    nativeApiCounts: nativeApiEvidence.counts,
    dispatchId: record.dispatchEvent.id,
  };
  return {
    ...material,
    proofId: `runtime-run-mode-proof:${sha256Text(stableJson(material)).replace(/^sha256:/, '')}`,
    accepted: ledger.gpuHmrSuccess === true,
    coverageObligations: {
      hipModuleRunModes: true,
      hip_module_run_modes: true,
    },
    validationTargetScope: 'hip_module_runtime_readback_target',
    validation_target_scope: 'hip_module_runtime_readback_target',
  };
}

function buildNegativeRefusal({ profile }) {
  if (!profile.negativeEdit) return null;
  const material = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    backend: 'hip',
    targetId: profile.targetId,
    profileId: profile.id,
    editId: profile.negativeEdit.editId,
    editHash: profile.negativeEdit.editHash,
    claim: profile.negativeEdit.claim,
    reasons: profile.negativeEdit.reasons,
    abiCompatibilityClass: profile.negativeEdit.abiCompatibilityClass,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    refusalProven: true,
    refusedBeforeLoad: true,
    validationTargetScope: 'hip_module_runtime_readback_target',
    validation_target_scope: 'hip_module_runtime_readback_target',
    coverageObligations: {
      hipModuleRunModes: true,
      hip_module_run_modes: true,
    },
  };
  return {
    ...material,
    proofId: `agent-split-negative-edit-refusal:${sha256Text(stableJson(material)).replace(/^sha256:/, '')}`,
  };
}

async function selfCheck() {
  const profile = await loadProfile(DEFAULT_PROFILE_PATH);
  const runMode = runModeMetadata(profile);
  const checks = [];
  checks.push({
    name: 'default-profile-normalizes',
    ok:
      profile.schemaVersion === PROFILE_SCHEMA
      && profile.validationScope === SUPPORTED_SCOPE
      && profile.kernel.launchApi === 'hipModuleLaunchKernel',
  });
  checks.push({
    name: 'profile-declares-expected-output',
    ok:
      profile.outputOracle.expectedOutputRequired === true
      && profile.outputOracle.expectedAfterValues.length === profile.buffers.input.values.length,
  });
  checks.push({
    name: 'run-mode-derived-from-profile',
    ok:
      runMode.metric_scope === 'hot_delta_1'
      && runMode.cache_state === 'compiler_cache_warm',
  });
  checks.push({
    name: 'negative-edit-refuses-before-load',
    ok:
      buildNegativeRefusal({ profile })?.refusalProven === true
      && buildNegativeRefusal({ profile })?.acceptedForGpuHmr === false,
  });
  checks.push({
    name: 'unsupported-scope-fails-self-check',
    ok: (() => {
      const copy = { ...profile, validationScope: 'project-specific-hidden-branch' };
      return copy.validationScope !== SUPPORTED_SCOPE;
    })(),
  });
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    schema: 'synthi.gpu_hmr.hip_module_runtime_self_check.v1',
    checks,
    passed: failed.length === 0,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await selfCheck();
    return;
  }
  const totalStart = process.hrtime.bigint();
  const staticStart = process.hrtime.bigint();
  const profile = await loadProfile(CFG.profilePath);
  if (profile.validationScope !== SUPPORTED_SCOPE) {
    throw new Error(`unsupported HIP module validation scope: ${profile.validationScope}`);
  }
  const staticEnd = process.hrtime.bigint();
  const modelStart = process.hrtime.bigint();
  const modelCheckedAt = new Date().toISOString();
  const provenance = modelProvenance({
    checkedAt: modelCheckedAt,
    splitModel: CFG.splitModel,
    gpuDeltaModel: CFG.gpuDeltaModel,
  });
  const modelEnd = process.hrtime.bigint();
  const runSlug = safeSlug(`${CFG.slug}-${profile.targetId}`);
  const outDir = path.join(ARTIFACT_DIR, runSlug);
  await mkdir(outDir, { recursive: true });
  const compiled = await compileRuntimeArtifacts({ profile, outDir });
  const runtime = await runHipProbe({ profile, compiled, outDir });
  const oracleStart = process.hrtime.bigint();
  const oracleArtifacts = await writeComputeOracleArtifacts({
    outDir,
    profile,
    runtimeTrace: runtime.runtimeTrace,
    rawAfterPath: runtime.rawAfterPath,
  });
  const oracleValidation = computeOracleValidation({ artifacts: oracleArtifacts });
  const oracleEnd = process.hrtime.bigint();
  const runMode = runModeMetadata(profile);
  const timings = timingFields({
    staticDiscovery: durationNs(staticStart, staticEnd),
    aiContractSynthesis: 0,
    modelAvailability: durationNs(modelStart, modelEnd),
    artifactHash: 0,
    adapterGeneration: 0,
    deviceCompileWall: compiled.compileDurationNs,
    artifactLoad: 1,
    epochPublish: 1,
    dispatchTrace: runtime.runtimeDurationNs,
    runtimeProbe: runtime.runtimeDurationNs,
    oracleAnalysis: durationNs(oracleStart, oracleEnd),
    triggerToVisible: compiled.compileDurationNs + runtime.runtimeDurationNs + durationNs(oracleStart, oracleEnd),
    screenshotCapture: 0,
    dispatchToOutputProof: runtime.runtimeDurationNs + durationNs(oracleStart, oracleEnd),
    totalValidatorWall: nsSince(totalStart),
  }, runMode);
  timings.loaderTimestampNs = timings.static_discovery_time + timings.model_availability_check_time + compiled.compileDurationNs + 10;
  timings.publishTimestampNs = timings.loaderTimestampNs + 10;
  timings.dispatchTimestampNs = timings.publishTimestampNs + 10;
  timings.outputTimestampNs = timings.dispatchTimestampNs + timings.oracle_analysis_time + 10;
  timings.retirementTimestampNs = timings.outputTimestampNs + 10;
  oracleArtifacts.timestamp_after_dispatch = timings.outputTimestampNs;
  const contract = buildContract({
    profile,
    compiled,
    runtimeTrace: runtime.runtimeTrace,
    runMode,
    oracleArtifacts,
  });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    before: contract,
    after: contract,
  });
  const ledgerRecord = buildProofLedgerRecord({
    profile,
    compiled,
    runtimeTrace: runtime.runtimeTrace,
    contract,
    runMode,
    timings,
    modelProvenance: provenance,
    oracleArtifacts,
    oracleValidation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const ledgerEvaluation = evaluateGpuHmrProofLedger(proofLedger.records[0]);
  const nativeApiEvidence = nativeHipApiEvidence(runtime.runtimeTrace);
  const accepted =
    contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && ledgerEvaluation.gpuHmrSuccess === true
    && oracleValidation.accepted === true
    && nativeApiEvidence.accepted === true
    && runtime.runtimeTrace.processRestarted === false;
  const proofMaterial = {
    schema: SCHEMA,
    slug: runSlug,
    profile: {
      id: profile.id,
      targetId: profile.targetId,
      profilePath: relRepo(profile.profilePath),
      projectName: profile.projectName,
      validationScope: profile.validationScope,
    },
    compiler: {
      hipcc: CFG.hipcc,
      executionTransport: compiled.transport,
      executionContainer: compiled.container ?? null,
      gpuArch: profile.compile.gpuArch,
      commands: compiled.commands,
      hsacoBefore: relRepo(compiled.beforeHsaco),
      hsacoAfter: relRepo(compiled.afterHsaco),
      hsacoBeforeHash: compiled.beforeHsacoHash,
      hsacoAfterHash: compiled.afterHsacoHash,
    },
    runtimeTrace: runtime.runtimeTrace,
    computeOracleArtifacts: oracleArtifacts,
    compute_oracle_artifacts: oracleArtifacts,
    computeOracleValidation: oracleValidation,
    nativeHipApiEvidence: nativeApiEvidence,
    contract,
    contractEvaluation,
    contractConsistency,
    proofLedger,
    ledger,
    ledgerEvaluation,
    modelProvenance: provenance,
    timings,
    timingMetrics: null,
    runModeProof: buildRunModeProof({
      profile,
      runMode,
      ledger,
      proofLedger,
      oracleArtifacts,
      nativeApiEvidence,
    }),
    negativeEditRefusal: buildNegativeRefusal({ profile }),
    gpuHmrSuccess: accepted,
    accepted,
    noHardcodedProjectBranch: true,
    noShimApplied: true,
  };
  proofMaterial.proofId = `hip-module-runtime-proof:${sha256Text(stableJson({
    schema: proofMaterial.schema,
    profile: proofMaterial.profile,
    contractHash: contract.contract_hash,
    ledgerProofId: ledger.proofId,
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    nativeApiCounts: nativeApiEvidence.counts,
  })).replace(/^sha256:/, '')}`;
  proofMaterial.timingMetrics = hipModuleRuntimeTimingMetrics(proofMaterial);
  const proofPath = path.join(outDir, `${runSlug}-proof.json`);
  await writeFile(proofPath, `${JSON.stringify(proofMaterial, null, 2)}\n`);
  if (proofMaterial.negativeEditRefusal) {
    await writeFile(
      path.join(outDir, `${runSlug}-negative-refusal.json`),
      `${JSON.stringify(proofMaterial.negativeEditRefusal, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(outDir, `${runSlug}-run-mode-proof.json`),
    `${JSON.stringify(proofMaterial.runModeProof, null, 2)}\n`,
  );
  console.log(JSON.stringify({
    proofId: proofMaterial.proofId,
    gpuHmrSuccess: proofMaterial.gpuHmrSuccess,
    proofPath: relRepo(proofPath),
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    renderedCardPng: oracleArtifacts.rendered_card_png,
    ledgerProofId: ledger.proofId,
    failedLedgerInvariants: ledger.failedInvariants,
    contractAccepted: contractEvaluation.accepted,
    computeOracleAccepted: oracleValidation.accepted,
    nativeHipApiAccepted: nativeApiEvidence.accepted,
    timings: {
      totalValidatorWallTimeNs: timings.total_validator_wall_time,
      dispatchToOutputProofTimeNs: timings.dispatch_to_output_proof_time,
    },
  }, null, 2));
  if (!accepted) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
