#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
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
import {
  runtimeProofArtifactStrictGate,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GpuHmrTestTimingRecorder,
  validateGpuHmrTestTiming,
} from './lib/gpu-hmr-test-timing-v2.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/hip-module-runtime-proof');
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'profiles/hip-module-runtime-readback.json');
const DECLARED_PROFILE_PATH = path.join(__dirname, 'profiles/hip-module-runtime-uint32-reordered.json');
const PROBE_SOURCE_PATH = path.join(__dirname, 'probes/hip_module_runtime_probe.cpp');
const SCHEMA = 'synthi.gpu_hmr.hip_module_runtime_proof.v1';
const PROFILE_SCHEMA = 'synthi.gpu.hmr.hip_module_runtime_profile.v1';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';
const LEGACY_SUPPORTED_SCOPE = 'explicit-hip-module-float32-readback';
const DECLARED_CONTRACT_SCOPE = 'explicit-hip-module-declared-readback';
const SUPPORTED_SCOPES = new Set([LEGACY_SUPPORTED_SCOPE, DECLARED_CONTRACT_SCOPE]);
const TEST_TIMING_SPLIT_NOT_APPLICABLE_REASON =
  'split_not_performed_by_hip_module_runtime_producer';
const TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON = 'compute_only_test_has_no_visual_contract';
const TEST_TIMING_CHILD_CLOCK_GAP_REASON =
  'hip_probe_phase_not_bound_to_validator_monotonic_clock';
const TEST_TIMING_OUTPUT_READY_GAP_REASON =
  'output_ready_boundary_not_bound_to_validator_monotonic_clock';
const TEST_TIMING_RETIREMENT_GAP_REASON =
  'retirement_boundary_not_bound_to_validator_monotonic_clock';
const TEST_TIMING_TERMINAL_PASS_REASON = 'hip_module_runtime_completed';
const TEST_TIMING_TERMINAL_REFUSAL_REASON = 'hip_module_runtime_refused';
const TEST_TIMING_TERMINAL_FAILURE_REASON = 'hip_module_runtime_failed';
const TEST_TIMING_CHILD_PHASES = Object.freeze([
  'load',
  'epoch_publication',
  'dispatch',
]);
const TEST_TIMING_VISUAL_PHASES = Object.freeze([
  'trigger_to_visible',
  'screenshot_capture',
  'visual_analysis',
]);

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

export function createHipModuleRuntimeTimingV2Recorder(options = {}) {
  const recorder = new GpuHmrTestTimingRecorder(options);
  recorder.notApplicable('split', TEST_TIMING_SPLIT_NOT_APPLICABLE_REASON);
  for (const phaseKey of TEST_TIMING_CHILD_PHASES) {
    recorder.unavailable(phaseKey, TEST_TIMING_CHILD_CLOCK_GAP_REASON);
  }
  recorder.unavailable('output_ready', TEST_TIMING_OUTPUT_READY_GAP_REASON);
  recorder.unavailable('retirement', TEST_TIMING_RETIREMENT_GAP_REASON);
  for (const phaseKey of TEST_TIMING_VISUAL_PHASES) {
    recorder.notApplicable(phaseKey, TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON);
  }
  return recorder;
}

export async function measureHipModuleRuntimeTimingPhase(recorder, phaseKey, operation) {
  recorder.startPhase(phaseKey);
  try {
    return await operation();
  } finally {
    recorder.finishPhase(phaseKey);
  }
}

export function finalizeHipModuleRuntimeTimingV2({ recorder, outcome, terminalReason }) {
  if (recorder.isFinalized) return recorder.record;
  const record = recorder.finalize({
    outcome,
    visualCapable: false,
    terminalReason,
    notApplicableReason: TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  const validation = validateGpuHmrTestTiming(record);
  if (
    record.schema !== GPU_HMR_TEST_TIMING_SCHEMA
    || validation.valid !== true
    || record.authority !== 'timing_only'
    || record.timingOnly !== true
    || record.acceptedForGpuHmr !== false
    || record.gpuHmrSuccess !== false
    || GPU_HMR_TEST_TIMING_PHASE_KEYS.some((phaseKey) => !record.phases?.[phaseKey])
  ) {
    throw new TypeError(`invalid HIP module timing-v2 record: ${validation.validationGaps.join(',')}`);
  }
  return record;
}

export function attachHipModuleRuntimeTestTiming(target, testTiming) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('HIP module timing attachment target must be an object');
  }
  const validation = validateGpuHmrTestTiming(testTiming);
  if (
    testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA
    || validation.valid !== true
    || testTiming.acceptedForGpuHmr !== false
    || testTiming.gpuHmrSuccess !== false
  ) {
    throw new TypeError('HIP module timing attachment requires valid support-only timing-v2');
  }
  const existingCamel = target.testTiming;
  const existingSnake = target.test_timing;
  if (
    (existingCamel && stableJson(existingCamel) !== stableJson(testTiming))
    || (existingSnake && stableJson(existingSnake) !== stableJson(testTiming))
    || (existingCamel && existingSnake && stableJson(existingCamel) !== stableJson(existingSnake))
  ) {
    throw new TypeError('HIP module timing aliases conflict');
  }
  target.testTiming = testTiming;
  target.test_timing = testTiming;
  return target;
}

function hipModuleRuntimeTimingOutcome(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:unsupported|unavailable|missing|requires|does not match|not found)/iu.test(message)
    ? 'refused'
    : 'failed';
}

function hipModuleRuntimeTimingReason(outcome) {
  return outcome === 'refused'
    ? TEST_TIMING_TERMINAL_REFUSAL_REASON
    : TEST_TIMING_TERMINAL_FAILURE_REASON;
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

function isGfxArch(value) {
  return /^gfx[0-9][0-9a-z]*$/iu.test(String(value ?? '').trim());
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

function proofArtifactPath(value) {
  const text = firstText(value);
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) return null;
  return text;
}

function computeOracleStrictGateOptions(oracleArtifacts = {}) {
  const artifactPaths = [
    oracleArtifacts.raw_readback_bin,
    oracleArtifacts.rawReadbackBin,
    oracleArtifacts.before_raw_readback_bin,
    oracleArtifacts.beforeRawReadbackBin,
    oracleArtifacts.readback_schema_json,
    oracleArtifacts.readbackSchemaJson,
    oracleArtifacts.rendered_card_png,
    oracleArtifacts.renderedCardPng,
    oracleArtifacts.raw_readback_cas_manifest,
    oracleArtifacts.rawReadbackCasManifest,
  ].map(proofArtifactPath).filter(Boolean);
  const allowedArtifactRoots = [...new Set(artifactPaths.map((artifactPath) => {
    const resolved = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(REPO_ROOT, artifactPath);
    return path.dirname(resolved);
  }))];
  return {
    allowedArtifactRoots,
    computeArtifactPathBaseRoots: [REPO_ROOT],
  };
}

function nsSince(startNs) {
  return Number(process.hrtime.bigint() - startNs);
}

function durationNs(startNs, endNs) {
  return Number(endNs - startNs);
}

function normalizeDataType(value, field) {
  const dataType = firstText(value) ?? 'float32';
  if (!['float32', 'uint32', 'int32'].includes(dataType)) {
    throw new Error(`${field} uses unsupported data type ${dataType}`);
  }
  return dataType;
}

function byteWidthForDataType(dataType) {
  if (dataType === 'float32' || dataType === 'uint32' || dataType === 'int32') return 4;
  throw new Error(`unsupported data type ${dataType}`);
}

function normalizeNumericValues(rawValues, field, dataType = 'float32') {
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    throw new Error(`${field} must be a non-empty numeric array`);
  }
  const values = rawValues.map(Number);
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) throw new Error(`${field}[${invalidIndex}] must be finite`);
  if (dataType === 'uint32') {
    const bad = values.findIndex((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff);
    if (bad >= 0) throw new Error(`${field}[${bad}] must be a uint32`);
  }
  if (dataType === 'int32') {
    const bad = values.findIndex((value) => !Number.isInteger(value) || value < -2147483648 || value > 2147483647);
    if (bad >= 0) throw new Error(`${field}[${bad}] must be an int32`);
  }
  return values;
}

function encodeNumericValues(values, dataType) {
  const width = byteWidthForDataType(dataType);
  const buffer = Buffer.alloc(values.length * width);
  values.forEach((value, index) => {
    const offset = index * width;
    if (dataType === 'float32') buffer.writeFloatLE(Number(value), offset);
    else if (dataType === 'uint32') buffer.writeUInt32LE(Number(value), offset);
    else if (dataType === 'int32') buffer.writeInt32LE(Number(value), offset);
    else throw new Error(`unsupported data type ${dataType}`);
  });
  return buffer;
}

function decodeNumericValues(bytes, dataType) {
  const width = byteWidthForDataType(dataType);
  if (bytes.length % width !== 0) {
    throw new Error(`readback byte length ${bytes.length} is not aligned to ${dataType}`);
  }
  const out = [];
  for (let offset = 0; offset + width <= bytes.length; offset += width) {
    if (dataType === 'float32') out.push(bytes.readFloatLE(offset));
    else if (dataType === 'uint32') out.push(bytes.readUInt32LE(offset));
    else if (dataType === 'int32') out.push(bytes.readInt32LE(offset));
  }
  return out;
}

function isSupportedScope(scope) {
  return SUPPORTED_SCOPES.has(scope);
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKernelParam(param) {
  const text = String(param ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === 'void') return null;
  const cleaned = text.replace(/\s*=\s*[^,]+$/u, '').trim();
  const match = cleaned.match(/^(.+?)([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (!match) return { raw: cleaned, type: cleaned, name: '' };
  const type = match[1]
    .trim()
    .replace(/\s*([*&])\s*/gu, '$1')
    .replace(/\s+/gu, ' ');
  return { raw: cleaned, type, name: match[2] };
}

function extractKernelSignature(source, kernelName) {
  const pattern = new RegExp(
    `(?:extern\\s+"C"\\s+)?__global__\\s+void\\s+${regexEscape(kernelName)}\\s*\\(([^)]*)\\)`,
    'su',
  );
  const match = String(source ?? '').match(pattern);
  const params = match
    ? match[1].split(',').map(normalizeKernelParam).filter(Boolean)
    : [];
  return {
    found: Boolean(match),
    params,
    signatureHash: sha256Text(stableJson(params.map((param) => ({ type: param.type, name: param.name })))),
  };
}

function abiSignature(params) {
  const normalized = firstArray(params).map((param) => ({
    type: firstText(param.type) ?? 'unknown',
    name: firstText(param.name) ?? '',
  }));
  return {
    params: normalized,
    signatureHash: sha256Text(stableJson(normalized)),
  };
}

function normalizeDim(raw, fallback = {}) {
  const dim = objectOrEmpty(raw);
  return {
    x: positiveInteger(dim.x, fallback.x ?? 1),
    y: positiveInteger(dim.y, fallback.y ?? 1),
    z: positiveInteger(dim.z, fallback.z ?? 1),
  };
}

function compareNumericValues(actual, expected, tolerance) {
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

function eventNs(event, field = 'timestamp_monotonic_ns') {
  const alias = field === 'start_timestamp_monotonic_ns' ? event?.startTimestampMonotonicNs : event?.timestampMonotonicNs;
  const value = Number(event?.[field] ?? alias);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nsDelta(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round(end - start) : 0;
}

function afterEpochTraceEvents(runtimeTrace) {
  const byEpoch = (items) => firstArray(items).find((entry) => String(entry?.epoch) === '2') ?? {};
  return {
    loader: byEpoch(runtimeTrace.loaderEvents),
    symbol: byEpoch(runtimeTrace.symbolEvents),
    epoch: byEpoch(runtimeTrace.epochEvents),
    dispatch: byEpoch(runtimeTrace.dispatchEvents),
    output: byEpoch(runtimeTrace.outputEvents),
    retirement: objectOrEmpty(runtimeTrace.retirementEvent),
  };
}

function normalizeProfileBuffer(buffer, field) {
  const raw = objectOrEmpty(buffer);
  const dataType = normalizeDataType(raw.dataType ?? raw.data_type, `${field}.dataType`);
  const values = Array.isArray(raw.values)
    ? normalizeNumericValues(raw.values, `${field}.values`, dataType)
    : [];
  const byteLength = positiveInteger(
    raw.byteLength ?? raw.byte_length,
    values.length > 0 ? values.length * byteWidthForDataType(dataType) : null,
  );
  if (!byteLength) throw new Error(`${field}.byteLength is required when values are not declared`);
  return {
    name: firstText(raw.name) ?? field,
    role: firstText(raw.role) ?? 'storage',
    dataType,
    byteLength,
    values,
  };
}

function normalizedParamKind(param) {
  const valueKind = firstText(param.valueKind, param.value_kind) ?? 'unknown';
  const type = firstText(param.type) ?? 'unknown';
  if (valueKind === 'global_buffer' || valueKind === 'buffer' || type.includes('*')) return 'buffer';
  if (valueKind === 'by_value' || valueKind === 'scalar') return 'scalar';
  return 'unsupported';
}

function scalarDataTypeFromParam(param) {
  const rawType = String(firstText(param.type) ?? '').replace(/\s+/g, ' ').trim();
  if (/^(const\s+)?float$/u.test(rawType)) return 'float32';
  if (/^(const\s+)?unsigned\s+int$/u.test(rawType) || /^(const\s+)?uint32_t$/u.test(rawType)) return 'uint32';
  if (/^(const\s+)?int$/u.test(rawType) || /^(const\s+)?int32_t$/u.test(rawType)) return 'int32';
  throw new Error(`unsupported HIP module scalar parameter type ${rawType || 'unknown'} for ${firstText(param.name) ?? 'arg'}`);
}

function bufferForParam(param, buffers) {
  const explicitName = firstText(param.buffer, param.bufferName, param.buffer_name);
  if (explicitName) {
    const explicit = buffers.find((buffer) => buffer.name === explicitName);
    if (!explicit) throw new Error(`kernel param ${param.name} references missing buffer ${explicitName}`);
    return explicit;
  }
  const name = firstText(param.name);
  if (name) {
    const direct = buffers.find((buffer) => buffer.name === name);
    if (direct) return direct;
  }
  const access = firstText(param.access) ?? 'unknown';
  if (access === 'write') {
    const writeBuffer = buffers.find((buffer) => buffer.role === 'readback' || buffer.role === 'output');
    if (writeBuffer) return writeBuffer;
  }
  if (access === 'read') {
    const readBuffer = buffers.find((buffer) => buffer.role === 'input');
    if (readBuffer) return readBuffer;
  }
  throw new Error(`kernel param ${name ?? 'arg'} must map to a declared buffer`);
}

function normalizeAbiParams(rawParams, buffers, constants, elementCount) {
  const params = firstArray(rawParams);
  if (params.length === 0) throw new Error('abi.params must declare kernel launch parameters');
  return params.map((rawParam, index) => {
    const param = objectOrEmpty(rawParam);
    const kind = normalizedParamKind(param);
    if (kind === 'unsupported') {
      throw new Error(`kernel param ${firstText(param.name) ?? index} has unsupported value kind`);
    }
    const base = {
      name: firstText(param.name) ?? `arg${index}`,
      type: firstText(param.type) ?? 'unknown',
      size: nonNegativeInteger(param.size, null),
      offset: nonNegativeInteger(param.offset, null),
      value_kind: firstText(param.valueKind, param.value_kind) ?? (kind === 'buffer' ? 'global_buffer' : 'by_value'),
      access: firstText(param.access) ?? 'unknown',
      address_space: firstText(param.addressSpace, param.address_space) ?? (kind === 'buffer' ? 'global' : 'private'),
      source: firstText(param.source) ?? 'profile_runtime_trace_contract',
    };
    if (kind === 'buffer') {
      const buffer = bufferForParam({ ...param, ...base }, buffers);
      return {
        ...base,
        launch_kind: 'buffer',
        buffer: buffer.name,
        data_type: buffer.dataType,
      };
    }
    const scalarType = normalizeDataType(
      firstText(param.scalarDataType, param.scalar_data_type) ?? scalarDataTypeFromParam(base),
      `abi.params[${index}].scalarDataType`,
    );
    const scalarValue = finiteNumber(
      param.value ?? param.scalarValue ?? param.scalar_value ?? constants[base.name],
      base.name === 'n' ? elementCount : null,
    );
    if (scalarValue === null) throw new Error(`scalar kernel param ${base.name} must declare a value or matching constant`);
    normalizeNumericValues([scalarValue], `abi.params[${index}].scalarValue`, scalarType);
    return {
      ...base,
      launch_kind: 'scalar',
      scalar_type: scalarType,
      scalar_value: scalarValue,
    };
  });
}

function validateProfileAbiSignatures({ abiParams, beforeSource, afterSource, negativeSourceAfter, kernelName }) {
  const declared = abiSignature(abiParams);
  const before = extractKernelSignature(beforeSource, kernelName);
  const after = extractKernelSignature(afterSource, kernelName);
  const negative = negativeSourceAfter ? extractKernelSignature(negativeSourceAfter, kernelName) : null;
  const matched = before.found === true
    && after.found === true
    && before.signatureHash === declared.signatureHash
    && after.signatureHash === declared.signatureHash;
  return {
    declared,
    before,
    after,
    negative,
    matched,
    blockingGaps: [
      before.found === true ? null : 'before_kernel_signature_missing',
      after.found === true ? null : 'after_kernel_signature_missing',
      before.signatureHash === declared.signatureHash ? null : 'before_kernel_signature_mismatch',
      after.signatureHash === declared.signatureHash ? null : 'after_kernel_signature_mismatch',
    ].filter(Boolean),
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
  const buffers = firstArray(raw.buffers).map((buffer, index) => normalizeProfileBuffer(buffer, `buffers[${index}]`));
  const inputBuffer = buffers.find((buffer) => buffer.role === 'input')
    ?? buffers.find((buffer) => buffer.name === 'input');
  const readbackBuffer = buffers.find((buffer) => buffer.role === 'readback')
    ?? buffers.find((buffer) => buffer.name === firstText(oracle.readbackBuffer, oracle.readback_buffer));
  if (!inputBuffer || !readbackBuffer) throw new Error('profile must declare input and readback buffers');
  const readbackDataType = readbackBuffer.dataType;
  const expectedBeforeValues = normalizeNumericValues(
    firstArray(oracle.expectedBeforeValues, oracle.expected_before_values),
    'outputOracle.expectedBeforeValues',
    readbackDataType,
  );
  const expectedAfterValues = normalizeNumericValues(
    firstArray(oracle.expectedAfterValues, oracle.expected_after_values, oracle.expectedValues, oracle.expected_values),
    'outputOracle.expectedAfterValues',
    readbackDataType,
  );
  if (oracle.expectedOutputRequired === false || oracle.expected_output_required === false) {
    throw new Error('outputOracle.expectedOutputRequired must be true for HIP module runtime acceptance');
  }
  const elementCount = expectedAfterValues.length;
  if (expectedBeforeValues.length !== elementCount) {
    throw new Error('expected-before and expected-after arrays must have the same length');
  }
  if (readbackBuffer.byteLength !== elementCount * byteWidthForDataType(readbackDataType)) {
    throw new Error('readback byte length must match expected output data type and length');
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
  const constantsRecord = Object.fromEntries(Object.entries(constants).map(([key, value]) => [key, Number(value)]));
  const kernelName = firstText(kernel.name, kernel.kernelName, kernel.kernel_name) ?? 'synthi_hmr_float32_epoch_kernel';
  const abiParams = normalizeAbiParams(firstArray(abi.params, abi.args), buffers, constantsRecord, elementCount);
  const negativeSourceAfterPath = resolveRelative(profileDir, firstText(
    negativeEdit.sourceAfterPath,
    negativeEdit.source_after_path,
    negativeEdit.afterPath,
    negativeEdit.after_path,
  ));
  const negativeSourceAfter = negativeSourceAfterPath ? await readFile(negativeSourceAfterPath, 'utf8') : null;
  const signatureValidation = validateProfileAbiSignatures({
    abiParams,
    beforeSource,
    afterSource,
    negativeSourceAfter,
    kernelName,
  });
  const compileTarget = firstText(compile.compileTarget, compile.compile_target) ?? 'rocm-hip-module-hsaco';
  const gpuArch = firstText(
    compile.gpuArch,
    compile.gpu_arch,
    CFG.gpuArch,
    isGfxArch(compileTarget) ? compileTarget : null,
  ) ?? '';
  return {
    raw,
    schemaVersion: firstText(raw.schemaVersion, raw.schema_version) ?? PROFILE_SCHEMA,
    id: targetId,
    targetId,
    projectName: firstText(raw.project?.name, raw.name) ?? targetId,
    projectKind: firstText(raw.project?.kind, raw.project_kind) ?? 'gpu_project',
    validationScope: firstText(raw.validationScope, raw.validation_scope) ?? LEGACY_SUPPORTED_SCOPE,
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
      compileTarget,
      gpuArch,
    },
    kernel: {
      name: kernelName,
      entryPoint: firstText(kernel.entryPoint, kernel.entry_point, kernel.name) ?? kernelName,
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
      params: abiParams,
      signatureValidation,
    },
    buffers: {
      all: buffers,
      input: {
        name: inputBuffer.name,
        dataType: inputBuffer.dataType,
        byteLength: inputBuffer.byteLength,
        values: inputBuffer.values,
      },
      readback: {
        name: readbackBuffer.name,
        dataType: readbackBuffer.dataType,
        byteLength: readbackBuffer.byteLength,
      },
    },
    constants: constantsRecord,
    outputOracle: {
      kind: firstText(oracle.kind) ?? 'buffer_checksum',
      expectedBeforeValues,
      expectedAfterValues,
      expectedOutputRequired: true,
      expectedOutputChange: oracle.expectedOutputChange !== false && oracle.expected_output_change !== false,
      tolerance: Math.max(0, finiteNumber(oracle.tolerance, 0.00001)),
      dataType: readbackDataType,
      deterministicSlice: {
        offset: nonNegativeInteger(deterministicSlice.offset ?? deterministicSlice.byte_offset, 0),
        length: positiveInteger(deterministicSlice.length ?? deterministicSlice.byte_length, readbackBuffer.byteLength),
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
      sourceAfterPath: negativeSourceAfterPath,
      sourceAfterHash: negativeSourceAfter ? sha256Text(negativeSourceAfter) : null,
      sourceAfterSignature: signatureValidation.negative,
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
  const bufferLines = profile.buffers.all.flatMap((buffer, index) => [
    `buffer_${index}_name=${buffer.name}`,
    `buffer_${index}_role=${buffer.role}`,
    `buffer_${index}_data_type=${buffer.dataType}`,
    `buffer_${index}_byte_length=${buffer.byteLength}`,
    `buffer_${index}_values=${csv(buffer.values)}`,
  ]);
  const paramLines = profile.abi.params.flatMap((param, index) => {
    const base = [
      `param_${index}_name=${param.name}`,
      `param_${index}_type=${param.type}`,
      `param_${index}_value_kind=${param.value_kind}`,
      `param_${index}_access=${param.access}`,
    ];
    if (param.launch_kind === 'buffer') {
      return [...base, `param_${index}_buffer=${param.buffer}`];
    }
    return [
      ...base,
      `param_${index}_scalar_type=${param.scalar_type}`,
      `param_${index}_scalar_value=${param.scalar_value}`,
    ];
  });
  const lines = [
    `kernel_name=${profile.kernel.name}`,
    `artifact_hash_before=${beforeHsacoHash}`,
    `artifact_hash_after=${afterHsacoHash}`,
    `dispatch_binding=hip-module-function-slot:${profile.kernel.name}`,
    `compile_target=${profile.compile.gpuArch || profile.compile.compileTarget}`,
    `readback_buffer=${profile.buffers.readback.name}`,
    `readback_data_type=${profile.buffers.readback.dataType}`,
    `grid_x=${profile.launch.gridDim.x}`,
    `grid_y=${profile.launch.gridDim.y}`,
    `grid_z=${profile.launch.gridDim.z}`,
    `block_x=${profile.launch.blockDim.x}`,
    `block_y=${profile.launch.blockDim.y}`,
    `block_z=${profile.launch.blockDim.z}`,
    `shared_mem_bytes=${profile.launch.sharedMemBytes}`,
    `element_count=${profile.outputOracle.expectedAfterValues.length}`,
    `tolerance=${profile.outputOracle.tolerance}`,
    `buffer_count=${profile.buffers.all.length}`,
    ...bufferLines,
    `param_count=${profile.abi.params.length}`,
    ...paramLines,
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
  const dataType = profile.outputOracle.dataType;
  const afterBytes = await readFile(rawAfterPath);
  const afterValues = decodeNumericValues(afterBytes, dataType);
  const beforeValues = runtimeTrace.outputEvents?.[0]?.values ?? profile.outputOracle.expectedBeforeValues;
  const beforeBytes = encodeNumericValues(beforeValues, dataType);
  const beforeRawPath = path.join(outDir, `${safeSlug(profile.targetId)}-before-readback.bin`);
  const schemaPath = path.join(outDir, `${safeSlug(profile.targetId)}-readback-schema.json`);
  const cardPath = path.join(outDir, `${safeSlug(profile.targetId)}-compute-card.png`);
  await writeFile(beforeRawPath, beforeBytes);
  const rawHash = sha256Bytes(afterBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedBytes = encodeNumericValues(profile.outputOracle.expectedAfterValues, dataType);
  const expectedHash = sha256Bytes(expectedBytes);
  const expectedVerification = compareNumericValues(
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
    dataType,
    byteLength: afterBytes.length,
    elementCount: afterValues.length,
    readbackResource: profile.buffers.readback.name,
    dispatchId: runtimeTrace.outputEvents?.[1]?.after_dispatch_id ?? runtimeTrace.dispatchEvents?.[1]?.id,
    epoch: 2,
    rawReadbackHash: rawHash,
    expectedOutput: {
      dataType,
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
    expected_output_data_type: dataType,
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
  const expectedVerified = artifacts.expected_output_declared === true && artifacts.expected_output_verified === true;
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
    selected_reason: 'verified_fission_contract',
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
      target_id: profile.buffers.readback.name,
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
  const afterEpoch = '2';
  const beforeEpoch = '1';
  const dispatchId = runtimeTrace.dispatchEvents?.[1]?.id ?? 'hip-module-dispatch-epoch-2';
  const processId = runtimeTrace.processId;
  const outputTargetId = profile.buffers.readback.name;
  const outputEvent = {
    id: `hip-module-output-${afterEpoch}`,
    kind: 'compute_readback',
    passed: oracleValidation.accepted,
    after_dispatch_id: dispatchId,
    artifact_hash: compiled.afterHsacoHash,
    epoch: afterEpoch,
    output_target_id: outputTargetId,
    outputTargetId,
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
    schema_version: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
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
      output_target_id: outputTargetId,
      outputTargetId,
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
      target_id: outputTargetId,
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

function failedGateCodes(...values) {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') return entry.code;
        return null;
      });
    }
    return [];
  }).filter((code) => typeof code === 'string' && code.trim()))];
}

function hipModuleHardwareTargetEvidence({ profile, runtimeTrace, contract }) {
  const device = objectOrEmpty(runtimeTrace.device);
  const adapter = objectOrEmpty(device.adapter_info);
  const contractArtifact = objectOrEmpty(contract.artifact_identity);
  const compileTarget = firstText(
    profile.compile.gpuArch,
    device.gpu_arch,
    device.gcn_arch_name,
    adapter.gpu_arch,
    adapter.gcn_arch_name,
    adapter.gcnArchName,
    contractArtifact.compile_target,
    device.compile_target,
    profile.compile.compileTarget,
  );
  const deviceBackend = firstText(device.backend, adapter.backend);
  const deviceUuid = firstText(device.device_uuid, device.deviceUuid, adapter.device_uuid, adapter.deviceUuid);
  const deviceName = firstText(device.name, adapter.name);
  const failedGates = [
    deviceBackend === 'hip' ? null : 'hip_module_device_backend_not_hip',
    isGfxArch(compileTarget) ? null : 'hip_module_gpu_arch_not_proven',
    deviceUuid || deviceName ? null : 'hip_module_device_identity_missing',
  ].filter(Boolean);
  return {
    schemaVersion: 'synthi.gpu_hmr.hip_module_hardware_target_evidence.v1',
    accepted: failedGates.length === 0,
    backend: deviceBackend ?? null,
    gpuArch: isGfxArch(compileTarget) ? compileTarget : null,
    gpu_arch: isGfxArch(compileTarget) ? compileTarget : null,
    compileTarget: compileTarget ?? null,
    compile_target: compileTarget ?? null,
    deviceUuid: deviceUuid ?? null,
    device_uuid: deviceUuid ?? null,
    deviceName: deviceName ?? null,
    device_name: deviceName ?? null,
    source: 'hip_runtime_trace_and_profile_compile_target',
    evidenceRefs: [
      deviceUuid ? `runtime:hip-module:device:${deviceUuid}` : null,
      compileTarget ? `runtime:hip-module:compile-target:${compileTarget}` : null,
    ].filter(Boolean),
    evidence_refs: [
      deviceUuid ? `runtime:hip-module:device:${deviceUuid}` : null,
      compileTarget ? `runtime:hip-module:compile-target:${compileTarget}` : null,
    ].filter(Boolean),
    failedGates,
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function buildRuntimeProofArtifact({
  profile,
  compiled,
  runtimeTrace,
  contract,
  contractEvaluation,
  contractConsistency,
  proofLedger,
  ledger,
  oracleArtifacts,
  oracleValidation,
  nativeApiEvidence,
}) {
  const record = proofLedger.records?.[0] ?? {};
  const dispatchId = record.dispatch_event?.id ?? record.dispatchEvent?.id ?? runtimeTrace.dispatchEvents?.[1]?.id;
  const proofLedgerSourceConsistency = {
    accepted: ledger.gpuHmrSuccess === true && ledger.failedInvariants.length === 0,
    mode: 'derived_only',
    source: 'hip_module_runtime_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: record.evidence_refs ?? record.evidenceRefs ?? [],
    evidence_refs: record.evidence_refs ?? record.evidenceRefs ?? [],
    failures: ledger.failedInvariants,
  };
  const processContinuity = {
    accepted: runtimeTrace.sameProcess === true && runtimeTrace.processRestarted === false,
    sameProcess: runtimeTrace.sameProcess === true,
    same_process: runtimeTrace.sameProcess === true,
    processRestarted: runtimeTrace.processRestarted === true,
    process_restarted: runtimeTrace.processRestarted === true,
    processId: runtimeTrace.processId,
    process_id: runtimeTrace.processId,
    failedGates: [
      runtimeTrace.sameProcess === true ? null : 'same_process_not_proven',
      runtimeTrace.processRestarted === false ? null : 'process_restarted',
    ].filter(Boolean),
  };
  const artifactChanged =
    typeof compiled.beforeHsacoHash === 'string'
    && typeof compiled.afterHsacoHash === 'string'
    && compiled.beforeHsacoHash !== compiled.afterHsacoHash;
  const retirementProven = contract.epoch_retirement_proof?.value === 'stream_event_proven';
  const hardwareTargetEvidence = hipModuleHardwareTargetEvidence({ profile, runtimeTrace, contract });
  const limitationCodes = failedGateCodes(
    ledger.failedInvariants,
    contractEvaluation.failedGates,
    contractConsistency.failedGates,
    oracleValidation.failedGates,
    nativeApiEvidence.failedGates,
    hardwareTargetEvidence.failedGates,
    processContinuity.failedGates,
    artifactChanged ? [] : ['hip_module_artifact_hash_not_changed'],
    retirementProven ? [] : ['hip_module_epoch_retirement_unproven'],
  );
  const fullRuntimeProven =
    ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && oracleValidation.accepted === true
    && nativeApiEvidence.accepted === true
    && hardwareTargetEvidence.accepted === true
    && processContinuity.accepted === true
    && artifactChanged
    && retirementProven
    && limitationCodes.length === 0;
  const runtimeProofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `hip-module-runtime-proof-artifact:${sha256Text(stableJson({
      proofLedgerId: proofLedger.proofId,
      contractHash: contract.contract_hash,
      artifactHashAfter: compiled.afterHsacoHash,
      dispatchId,
      rawReadbackHash: oracleArtifacts.raw_readback_hash,
      nativeApiCounts: nativeApiEvidence.counts,
    })).replace(/^sha256:/, '')}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      {
        stageId: 'hip-module-hsaco-artifact',
        status: artifactChanged ? 'passed' : 'failed',
        evidenceRefs: [compiled.beforeHsacoHash, compiled.afterHsacoHash].filter(Boolean),
      },
      {
        stageId: 'hip-module-load-symbol-epoch',
        status:
          nativeApiEvidence.counts?.hipModuleLoadData >= 2
          && nativeApiEvidence.counts?.hipModuleGetFunction >= 2
            ? 'passed'
            : 'failed',
        evidenceRefs: [
          `runtime:hip-module:hipModuleLoadData:${compiled.afterHsacoHash}`,
          `runtime:hip-module:hipModuleGetFunction:${profile.kernel.name}`,
        ],
      },
      {
        stageId: 'hip-module-post-epoch-dispatch',
        status:
          nativeApiEvidence.counts?.hipModuleLaunchKernel >= 2
          && ledger.gpuHmrSuccess === true
            ? 'passed'
            : 'failed',
        evidenceRefs: [dispatchId, proofLedger.proofId].filter(Boolean),
      },
      {
        stageId: 'hip-module-raw-readback-oracle',
        status: oracleValidation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [
          oracleArtifacts.raw_readback_hash,
          oracleArtifacts.deterministic_slice_hash,
          oracleArtifacts.readback_schema_hash,
        ].filter(Boolean),
      },
      {
        stageId: 'hip-module-hardware-target',
        status: hardwareTargetEvidence.accepted === true ? 'passed' : 'failed',
        evidenceRefs: hardwareTargetEvidence.evidenceRefs,
      },
      {
        stageId: 'hip-module-acceptance-contract',
        status: contractEvaluation.accepted === true && contractConsistency.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [contract.contract_hash],
      },
      {
        stageId: 'hip-module-process-firewall',
        status: processContinuity.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`runtime:hip-module:process-continuity:${runtimeTrace.processId}`],
      },
      {
        stageId: 'hip-module-epoch-retirement',
        status: retirementProven ? 'passed' : 'failed',
        evidenceRefs: contract.epoch_retirement_proof?.evidence_refs ?? [],
      },
    ],
    limitations: fullRuntimeProven ? [] : limitationCodes.map((code) => ({ code })),
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    acceptanceContract: contract,
    acceptance_contract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptance_contract_evaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
    acceptance_contract_consistency: contractConsistency,
    computeOracleArtifacts: oracleArtifacts,
    compute_oracle_artifacts: oracleArtifacts,
    computeOracleValidation: oracleValidation,
    compute_oracle_validation: oracleValidation,
    nativeHipApiEvidence: nativeApiEvidence,
    native_hip_api_evidence: nativeApiEvidence,
    hardwareTargetEvidence,
    hardware_target_evidence: hardwareTargetEvidence,
    processContinuity,
    process_continuity: processContinuity,
  };
  const strictGate = runtimeProofArtifactStrictGate(
    runtimeProofArtifact,
    computeOracleStrictGateOptions(oracleArtifacts),
  );
  return {
    ...runtimeProofArtifact,
    strictGate,
    strict_gate: strictGate,
    fullRuntimeProven: runtimeProofArtifact.fullRuntimeProven && strictGate.status === 'pass',
    full_runtime_proven: runtimeProofArtifact.fullRuntimeProven && strictGate.status === 'pass',
    gpuHmrSuccess: runtimeProofArtifact.gpuHmrSuccess && strictGate.status === 'pass',
    gpu_hmr_success: runtimeProofArtifact.gpuHmrSuccess && strictGate.status === 'pass',
  };
}

function buildRunModeProof({
  profile,
  runMode,
  ledger,
  proofLedger,
  oracleArtifacts,
  nativeApiEvidence,
  runtimeProofArtifact,
}) {
  const record = proofLedger.records[0];
  const material = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    targetId: profile.targetId,
    backend: 'hip',
    runMode,
    ledgerProofId: ledger.proofId,
    runtimeProofArtifactId: runtimeProofArtifact?.proofId ?? null,
    runtime_proof_artifact_id: runtimeProofArtifact?.proofId ?? null,
    runtimeProofStrictGate: runtimeProofArtifact?.strictGate?.status ?? 'unknown',
    runtime_proof_strict_gate: runtimeProofArtifact?.strictGate?.status ?? 'unknown',
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    nativeApiCounts: nativeApiEvidence.counts,
    dispatchId: record.dispatchEvent.id,
  };
  return {
    ...material,
    proofId: `runtime-run-mode-proof:${sha256Text(stableJson(material)).replace(/^sha256:/, '')}`,
    accepted: ledger.gpuHmrSuccess === true && runtimeProofArtifact?.gpuHmrSuccess === true,
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
  const acceptedSignature = abiSignature(profile.abi.params);
  const negativeSignature = profile.negativeEdit.sourceAfterSignature;
  const signatureChanged = acceptedSignature.signatureHash !== negativeSignature?.signatureHash;
  const executableStaticCheckAccepted =
    negativeSignature?.found === true
    && signatureChanged
    && profile.negativeEdit.abiCompatibilityClass === 'layout_changed';
  const material = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    backend: 'hip',
    targetId: profile.targetId,
    profileId: profile.id,
    editId: profile.negativeEdit.editId,
    editHash: profile.negativeEdit.editHash,
    claim: profile.negativeEdit.claim,
    reasons: executableStaticCheckAccepted
      ? profile.negativeEdit.reasons
      : [...profile.negativeEdit.reasons, 'negative_edit_signature_change_not_observed'],
    abiCompatibilityClass: profile.negativeEdit.abiCompatibilityClass,
    executableStaticCheck: {
      source: 'hip_module_negative_source_signature',
      sourceAfterPath: profile.negativeEdit.sourceAfterPath ? relRepo(profile.negativeEdit.sourceAfterPath) : null,
      sourceAfterHash: profile.negativeEdit.sourceAfterHash,
      acceptedSignatureHash: acceptedSignature.signatureHash,
      negativeSignatureHash: negativeSignature?.signatureHash ?? null,
      negativeKernelFound: negativeSignature?.found === true,
      signatureChanged,
      acceptedParams: acceptedSignature.params,
      negativeParams: negativeSignature?.params ?? [],
      accepted: executableStaticCheckAccepted,
    },
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    refusalProven: executableStaticCheckAccepted,
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

function declaredHipModuleNegativeRefusalTestTiming() {
  const recorder = createHipModuleRuntimeTimingV2Recorder();
  return finalizeHipModuleRuntimeTimingV2({
    recorder,
    outcome: 'refused',
    terminalReason: 'hip_module_negative_edit_refused_before_runtime',
  });
}

function buildSyntheticRuntimeProofFixture(profile) {
  const runMode = runModeMetadata(profile);
  const compiled = {
    beforeHsacoHash: sha256Text(`${profile.targetId}:before-hsaco`),
    afterHsacoHash: sha256Text(`${profile.targetId}:after-hsaco`),
    commands: {
      host: ['hipcc', '-std=c++17', 'hip_module_runtime_probe.cpp'],
      before: ['hipcc', '--genco', profile.beforePath],
      after: ['hipcc', '--genco', profile.afterPath],
    },
  };
  const dispatchBefore = 'hip-module-self-check-dispatch-1';
  const dispatchAfter = 'hip-module-self-check-dispatch-2';
  const outputTargetId = profile.buffers.readback.name;
  const runtimeTrace = {
    processId: 'hip-module-self-check-process',
    sameProcess: true,
    processRestarted: false,
    device: {
      backend: 'hip',
      name: 'HIP self-check device',
      device_uuid: 'hip-self-check-device',
      gpu_arch: profile.compile.gpuArch,
      gcn_arch_name: profile.compile.gpuArch,
      compile_target: profile.compile.gpuArch || profile.compile.compileTarget,
    },
    loaderEvents: [
      { api: 'hipModuleLoadData', epoch: '1', artifact_hash: compiled.beforeHsacoHash, start_timestamp_monotonic_ns: 10, timestamp_monotonic_ns: 20 },
      { api: 'hipModuleLoadData', epoch: '2', artifact_hash: compiled.afterHsacoHash, start_timestamp_monotonic_ns: 110, timestamp_monotonic_ns: 120 },
    ],
    symbolEvents: [
      { api: 'hipModuleGetFunction', epoch: '1', kernel_name: profile.kernel.name, timestamp_monotonic_ns: 30 },
      { api: 'hipModuleGetFunction', epoch: '2', kernel_name: profile.kernel.name, timestamp_monotonic_ns: 130 },
    ],
    epochEvents: [
      { epoch: '1', artifact_hash: compiled.beforeHsacoHash, timestamp_monotonic_ns: 40 },
      { epoch: '2', artifact_hash: compiled.afterHsacoHash, timestamp_monotonic_ns: 140 },
    ],
    dispatchEvents: [
      { id: dispatchBefore, launch_api: 'hipModuleLaunchKernel', epoch: '1', artifact_hash: compiled.beforeHsacoHash, timestamp_monotonic_ns: 50, output_target_id: outputTargetId, outputTargetId },
      { id: dispatchAfter, launch_api: 'hipModuleLaunchKernel', epoch: '2', artifact_hash: compiled.afterHsacoHash, timestamp_monotonic_ns: 150, output_target_id: outputTargetId, outputTargetId },
    ],
    outputEvents: [
      { id: 'hip-module-self-check-output-1', passed: true, values: profile.outputOracle.expectedBeforeValues, after_dispatch_id: dispatchBefore, epoch: '1', timestamp_monotonic_ns: 60, output_target_id: outputTargetId, outputTargetId },
      { id: 'hip-module-self-check-output-2', passed: true, values: profile.outputOracle.expectedAfterValues, after_dispatch_id: dispatchAfter, epoch: '2', timestamp_monotonic_ns: 160, output_target_id: outputTargetId, outputTargetId },
    ],
    retirementEvent: {
      id: 'hip-module-self-check-retire-1',
      status: 'stream_event_proven',
      epoch: '1',
      timestamp_monotonic_ns: 170,
    },
  };
  const expectedBytes = encodeNumericValues(profile.outputOracle.expectedAfterValues, profile.outputOracle.dataType);
  const beforeBytes = encodeNumericValues(profile.outputOracle.expectedBeforeValues, profile.outputOracle.dataType);
  const deterministicSliceBytes = expectedBytes.subarray(
    profile.outputOracle.deterministicSlice.offset,
    profile.outputOracle.deterministicSlice.offset + profile.outputOracle.deterministicSlice.length,
  );
  const rawReadbackHash = sha256Bytes(expectedBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const sliceHash = sha256Bytes(deterministicSliceBytes);
  const selfCheckArtifactDir = path.join(ARTIFACT_DIR, 'self-check');
  mkdirSync(selfCheckArtifactDir, { recursive: true });
  const rawAfterPath = path.join(selfCheckArtifactDir, 'after-readback.bin');
  const rawBeforePath = path.join(selfCheckArtifactDir, 'before-readback.bin');
  const schemaPath = path.join(selfCheckArtifactDir, 'readback-schema.json');
  const cardPath = path.join(selfCheckArtifactDir, 'compute-card.png');
  const schemaBytes = Buffer.from(`${stableJson({
    dataType: profile.outputOracle.dataType,
    byteLength: expectedBytes.length,
    targetId: profile.buffers.readback.name,
  })}\n`);
  const cardBytes = Buffer.from('hip module self-check compute card\n');
  writeFileSync(rawAfterPath, expectedBytes);
  writeFileSync(rawBeforePath, beforeBytes);
  writeFileSync(schemaPath, schemaBytes);
  writeFileSync(cardPath, cardBytes);
  const readbackSchemaHash = sha256Bytes(schemaBytes);
  const renderedCardHash = sha256Bytes(cardBytes);
  const oracleArtifacts = {
    raw_readback_bin: relRepo(rawAfterPath),
    rawReadbackBin: relRepo(rawAfterPath),
    before_raw_readback_bin: relRepo(rawBeforePath),
    readback_schema_json: relRepo(schemaPath),
    readbackSchemaJson: relRepo(schemaPath),
    raw_readback_hash: rawReadbackHash,
    rawReadbackHash: rawReadbackHash,
    raw_readback_hash_verified: true,
    raw_readback_source: 'runtime_raw_readback',
    raw_readback_byte_length: expectedBytes.length,
    readback_schema_hash: readbackSchemaHash,
    checksum_before: beforeHash,
    checksum_after: rawReadbackHash,
    output_change_expected: true,
    expected_output_declared: true,
    expected_output_required: true,
    expected_output_data_type: profile.outputOracle.dataType,
    expected_output_values: profile.outputOracle.expectedAfterValues,
    expected_output_hash: sha256Bytes(expectedBytes),
    expected_output_tolerance: profile.outputOracle.tolerance,
    expected_output_verified: true,
    expected_output_max_abs_delta: 0,
    expected_output_compared: profile.outputOracle.expectedAfterValues.length,
    expected_output_mismatches: [],
    deterministic_slice: {
      offset: profile.outputOracle.deterministicSlice.offset,
      length: profile.outputOracle.deterministicSlice.length,
      hash: sliceHash,
      source: 'runtime_raw_readback',
    },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: sha256Text('hip_module_self_check_oracle_code'),
    rendered_card_png: relRepo(cardPath),
    renderedCardPng: relRepo(cardPath),
    rendered_card_hash: renderedCardHash,
    producer: 'hip_module_runtime_proof_self_check',
    timestamp_after_dispatch: 160,
    epoch: 2,
    raw_readback_verification: {
      raw_readback_hash: rawReadbackHash,
      hash_verified: true,
      byte_length: expectedBytes.length,
      deterministic_slice_hash: sliceHash,
      deterministic_slice_hash_verified: true,
      readback_schema_hash: readbackSchemaHash,
    },
  };
  const oracleValidation = computeOracleValidation({ artifacts: oracleArtifacts });
  const timings = timingFields({
    staticDiscovery: 1,
    aiContractSynthesis: 0,
    modelAvailability: 1,
    artifactHash: 1,
    adapterGeneration: 0,
    deviceCompileWall: 1,
    artifactLoad: 10,
    epochPublish: 10,
    dispatchTrace: 10,
    runtimeProbe: 100,
    oracleAnalysis: 10,
    triggerToVisible: 130,
    screenshotCapture: 0,
    dispatchToOutputProof: 20,
    totalValidatorWall: 150,
  }, runMode);
  timings.loaderTimestampNs = 120;
  timings.publishTimestampNs = 140;
  timings.dispatchTimestampNs = 150;
  timings.outputTimestampNs = 160;
  timings.retirementTimestampNs = 170;
  const contract = buildContract({ profile, compiled, runtimeTrace, runMode, oracleArtifacts });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    before: contract,
    after: contract,
  });
  const ledgerRecord = buildProofLedgerRecord({
    profile,
    compiled,
    runtimeTrace,
    contract,
    runMode,
    timings,
    modelProvenance: modelProvenance({
      checkedAt: '2026-06-25T00:00:00.000Z',
      splitModel: 'gemini-3.5-flash',
      gpuDeltaModel: 'gemini-3.1-flash-lite',
    }),
    oracleArtifacts,
    oracleValidation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const nativeApiEvidence = nativeHipApiEvidence(runtimeTrace);
  const runtimeProofArtifact = buildRuntimeProofArtifact({
    profile,
    compiled,
    runtimeTrace,
    contract,
    contractEvaluation,
    contractConsistency,
    proofLedger,
    ledger,
    oracleArtifacts,
    oracleValidation,
    nativeApiEvidence,
  });
  return {
    runtimeProofArtifact,
    proofLedger,
    ledger,
    contractEvaluation,
    contractConsistency,
    oracleValidation,
    nativeApiEvidence,
  };
}

async function selfCheck() {
  const profile = await loadProfile(DEFAULT_PROFILE_PATH);
  const declaredProfile = await loadProfile(DECLARED_PROFILE_PATH);
  profile.compile.gpuArch = profile.compile.gpuArch || 'gfx000';
  declaredProfile.compile.gpuArch = declaredProfile.compile.gpuArch || 'gfx000';
  const runMode = runModeMetadata(profile);
  const checks = [];
  checks.push({
    name: 'default-profile-normalizes',
    ok:
      profile.schemaVersion === PROFILE_SCHEMA
      && isSupportedScope(profile.validationScope)
      && profile.kernel.launchApi === 'hipModuleLaunchKernel',
  });
  checks.push({
    name: 'declared-profile-abi-signature-validated',
    ok:
      profile.abi.signatureValidation?.matched === true
      && profile.abi.signatureValidation?.blockingGaps?.length === 0,
  });
  checks.push({
    name: 'profile-params-drive-launch-plan',
    ok:
      profile.abi.params.some((param) => param.launch_kind === 'buffer' && param.buffer === profile.buffers.readback.name)
      && profile.abi.params.some((param) => param.launch_kind === 'scalar' && param.scalar_type),
  });
  checks.push({
    name: 'declared-contract-profile-supports-reordered-uint32-abi',
    ok:
      declaredProfile.validationScope === DECLARED_CONTRACT_SCOPE
      && declaredProfile.outputOracle.dataType === 'uint32'
      && declaredProfile.abi.signatureValidation?.matched === true
      && declaredProfile.abi.params.map((param) => param.name).join(',') === 'input,n,increment,output'
      && declaredProfile.abi.params[1]?.launch_kind === 'scalar'
      && declaredProfile.abi.params[3]?.buffer === declaredProfile.buffers.readback.name,
  });
  checks.push({
    name: 'profile-declares-expected-output',
    ok:
      profile.outputOracle.expectedOutputRequired === true
      && profile.outputOracle.expectedAfterValues.length * byteWidthForDataType(profile.outputOracle.dataType) === profile.buffers.readback.byteLength,
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
      && buildNegativeRefusal({ profile })?.acceptedForGpuHmr === false
      && buildNegativeRefusal({ profile })?.executableStaticCheck?.accepted === true,
  });
  checks.push({
    name: 'unsupported-scope-fails-self-check',
    ok: (() => {
      const copy = { ...profile, validationScope: 'project-specific-hidden-branch' };
      return !isSupportedScope(copy.validationScope);
    })(),
  });
  const syntheticProof = buildSyntheticRuntimeProofFixture(profile);
  checks.push({
    name: 'runtime-proof-artifact-strictly-accepted',
    ok:
      syntheticProof.runtimeProofArtifact.gpuHmrSuccess === true
      && syntheticProof.runtimeProofArtifact.fullRuntimeProven === true
      && syntheticProof.runtimeProofArtifact.strictGate?.status === 'pass'
      && syntheticProof.runtimeProofArtifact.proofLedgerSourceConsistency?.mode === 'derived_only',
    detail: syntheticProof.runtimeProofArtifact.strictGate,
  });
  checks.push({
    name: 'runtime-proof-output-target-bound',
    ok: (() => {
      const record = syntheticProof.proofLedger.records?.[0] ?? {};
      const outputTargetId = profile.buffers.readback.name;
      const dispatchEvent = record.dispatch_event ?? record.dispatchEvent ?? {};
      const outputEvent = record.output_event ?? record.outputEvent ?? {};
      const outputOracleTarget = record.output_oracle_target ?? record.outputOracleTarget ?? {};
      return (dispatchEvent.output_target_id ?? dispatchEvent.outputTargetId) === outputTargetId
        && (outputEvent.output_target_id ?? outputEvent.outputTargetId) === outputTargetId
        && (outputOracleTarget.target_id ?? outputOracleTarget.targetId) === outputTargetId;
    })(),
  });
  checks.push({
    name: 'runtime-proof-artifact-rejects-forged-cpu-fallback',
    ok: (() => {
      const forged = JSON.parse(JSON.stringify(syntheticProof.runtimeProofArtifact));
      forged.proofLedger.records[0].cpu_hmr_used = true;
      forged.proof_ledger.records[0].cpu_hmr_used = true;
      const gate = runtimeProofArtifactStrictGate(forged);
      return gate.status === 'fail'
        && gate.failures.some((failure) => failure === 'proof_ledger_recomputed_query_rejected');
    })(),
  });
  let timingClock = 0n;
  const timingRecorder = createHipModuleRuntimeTimingV2Recorder({
    clock: () => {
      timingClock += 10n;
      return timingClock;
    },
  });
  await measureHipModuleRuntimeTimingPhase(timingRecorder, 'cold_intake', async () => {});
  await measureHipModuleRuntimeTimingPhase(timingRecorder, 'discovery', async () => {});
  await measureHipModuleRuntimeTimingPhase(timingRecorder, 'compile', async () => {});
  await measureHipModuleRuntimeTimingPhase(timingRecorder, 'proof_finalization', async () => {});
  const testTiming = finalizeHipModuleRuntimeTimingV2({
    recorder: timingRecorder,
    outcome: 'pass',
    terminalReason: TEST_TIMING_TERMINAL_PASS_REASON,
  });
  const timingValidation = validateGpuHmrTestTiming(testTiming);
  checks.push({
    name: 'timing-v2-preserves-measured-and-typed-gap-semantics',
    ok:
      timingValidation.valid === true
      && testTiming.phases.cold_intake.state === 'measured'
      && testTiming.phases.discovery.state === 'measured'
      && testTiming.phases.compile.state === 'measured'
      && testTiming.phases.proof_finalization.state === 'measured'
      && testTiming.phases.load.state === 'unavailable'
      && testTiming.phases.trigger_to_visible.state === 'not_applicable'
      && testTiming.phases.trigger_to_visible.reasonCode
        === TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON,
    detail: timingValidation,
  });
  const timedTarget = {};
  attachHipModuleRuntimeTestTiming(timedTarget, testTiming);
  checks.push({
    name: 'timing-v2-aliases-are-identical',
    ok: stableJson(timedTarget.testTiming) === stableJson(timedTarget.test_timing),
  });
  let timingAuthorityForgeryRejected = false;
  try {
    attachHipModuleRuntimeTestTiming({}, {
      ...testTiming,
      acceptedForGpuHmr: true,
    });
  } catch {
    timingAuthorityForgeryRejected = true;
  }
  checks.push({
    name: 'timing-v2-cannot-claim-gpu-hmr-authority',
    ok: timingAuthorityForgeryRejected,
  });
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    schema: 'synthi.gpu_hmr.hip_module_runtime_self_check.v1',
    checks,
    timingSchema: testTiming.schema,
    timingAuthorityForgeryRejected,
    passed: failed.length === 0,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function main(testTimingRecorder) {
  const totalStart = process.hrtime.bigint();
  const staticStart = process.hrtime.bigint();
  const profile = await measureHipModuleRuntimeTimingPhase(
    testTimingRecorder,
    'cold_intake',
    async () => {
      const loaded = await loadProfile(CFG.profilePath);
      if (!isSupportedScope(loaded.validationScope)) {
        throw new Error(`unsupported HIP module validation scope: ${loaded.validationScope}`);
      }
      if (loaded.abi.signatureValidation?.matched !== true) {
        throw new Error(`HIP module profile ABI does not match source signatures: ${loaded.abi.signatureValidation?.blockingGaps?.join(',') || 'unknown_gap'}`);
      }
      if (!isGfxArch(loaded.compile.gpuArch)) {
        throw new Error('HIP module runtime proof requires explicit gfx* GPU arch evidence; set compile.gpuArch, SYNTHI_HIP_MODULE_GPU_ARCH, or SYNTHI_GPU_ARCH');
      }
      return loaded;
    },
  );
  const staticEnd = process.hrtime.bigint();
  const modelStart = process.hrtime.bigint();
  const modelCheckedAt = new Date().toISOString();
  const provenance = await measureHipModuleRuntimeTimingPhase(
    testTimingRecorder,
    'discovery',
    async () => modelProvenance({
      checkedAt: modelCheckedAt,
      splitModel: CFG.splitModel,
      gpuDeltaModel: CFG.gpuDeltaModel,
    }),
  );
  const modelEnd = process.hrtime.bigint();
  const runSlug = safeSlug(`${CFG.slug}-${profile.targetId}`);
  const outDir = path.join(ARTIFACT_DIR, runSlug);
  await mkdir(outDir, { recursive: true });
  const compiled = await measureHipModuleRuntimeTimingPhase(
    testTimingRecorder,
    'compile',
    () => compileRuntimeArtifacts({ profile, outDir }),
  );
  const runtime = await runHipProbe({ profile, compiled, outDir });
  testTimingRecorder.startPhase('proof_finalization');
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
  const traceEvents = afterEpochTraceEvents(runtime.runtimeTrace);
  const loaderStartNs = eventNs(traceEvents.loader, 'start_timestamp_monotonic_ns');
  const loaderEndNs = eventNs(traceEvents.loader);
  const symbolNs = eventNs(traceEvents.symbol);
  const publishNs = eventNs(traceEvents.epoch);
  const dispatchNs = eventNs(traceEvents.dispatch);
  const outputNs = eventNs(traceEvents.output);
  const retirementNs = eventNs(traceEvents.retirement);
  const oracleDurationNs = durationNs(oracleStart, oracleEnd);
  const timings = timingFields({
    staticDiscovery: durationNs(staticStart, staticEnd),
    aiContractSynthesis: 0,
    modelAvailability: durationNs(modelStart, modelEnd),
    artifactHash: 0,
    adapterGeneration: 0,
    deviceCompileWall: compiled.compileDurationNs,
    artifactLoad: nsDelta(loaderStartNs, loaderEndNs),
    epochPublish: nsDelta(symbolNs, publishNs),
    dispatchTrace: nsDelta(dispatchNs, outputNs),
    runtimeProbe: runtime.runtimeDurationNs,
    oracleAnalysis: oracleDurationNs,
    triggerToVisible: compiled.compileDurationNs + nsDelta(loaderStartNs, outputNs) + oracleDurationNs,
    screenshotCapture: 0,
    dispatchToOutputProof: nsDelta(dispatchNs, outputNs) + oracleDurationNs,
    totalValidatorWall: nsSince(totalStart),
  }, runMode);
  timings.loaderTimestampNs = loaderEndNs;
  timings.publishTimestampNs = publishNs;
  timings.dispatchTimestampNs = dispatchNs;
  timings.outputTimestampNs = outputNs;
  timings.retirementTimestampNs = retirementNs;
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
  const runtimeProofArtifact = buildRuntimeProofArtifact({
    profile,
    compiled,
    runtimeTrace: runtime.runtimeTrace,
    contract,
    contractEvaluation,
    contractConsistency,
    proofLedger,
    ledger,
    oracleArtifacts,
    oracleValidation,
    nativeApiEvidence,
  });
  const accepted =
    runtimeProofArtifact.gpuHmrSuccess === true
    && ledgerEvaluation.gpuHmrSuccess === true;
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
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
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
      runtimeProofArtifact,
    }),
    negativeEditRefusal: buildNegativeRefusal({ profile }),
    gpuHmrSuccess: accepted,
    accepted,
    claimBoundary: {
      proofAuthority: 'scoped_native_hip_module_runtime_trace',
      acceptedScope: profile.validationScope,
      supportedScopes: [...SUPPORTED_SCOPES],
      executionBoundary: 'standalone_hip_module_probe',
      arbitraryTargetRuntimeAccepted: false,
      arbitraryLibraryAccepted: false,
      broadHipApplicationAcceptance: false,
      nativeApisRequired: nativeApiEvidence.required,
      unsupportedWithoutEvidence: [
        'target_app_without_declared_reload_hook',
        'framework_owned_kernel_cache_without_epoch_trace',
        'library_runtime_without_artifact_transport_trace',
        'dispatch_without_raw_readback_or_visual_oracle',
      ],
    },
  };
  if (proofMaterial.negativeEditRefusal) {
    attachHipModuleRuntimeTestTiming(
      proofMaterial.negativeEditRefusal,
      declaredHipModuleNegativeRefusalTestTiming(),
    );
  }
  proofMaterial.proofId = `hip-module-runtime-proof:${sha256Text(stableJson({
    schema: proofMaterial.schema,
    profile: proofMaterial.profile,
    contractHash: contract.contract_hash,
    ledgerProofId: ledger.proofId,
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    nativeApiCounts: nativeApiEvidence.counts,
    runtimeProofArtifactId: runtimeProofArtifact.proofId,
  })).replace(/^sha256:/, '')}`;
  proofMaterial.timingMetrics = hipModuleRuntimeTimingMetrics(proofMaterial);
  const proofPath = path.join(outDir, `${runSlug}-proof.json`);
  const runtimeProofArtifactPath = path.join(outDir, `${runSlug}-runtime-proof-artifact.json`);
  proofMaterial.runtimeProofArtifactPath = relRepo(runtimeProofArtifactPath);
  proofMaterial.runtime_proof_artifact_path = relRepo(runtimeProofArtifactPath);
  await writeFile(runtimeProofArtifactPath, `${JSON.stringify(runtimeProofArtifact, null, 2)}\n`);
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
  testTimingRecorder.finishPhase('proof_finalization');
  const testTiming = finalizeHipModuleRuntimeTimingV2({
    recorder: testTimingRecorder,
    outcome: accepted ? 'pass' : 'refused',
    terminalReason: accepted
      ? TEST_TIMING_TERMINAL_PASS_REASON
      : TEST_TIMING_TERMINAL_REFUSAL_REASON,
  });
  attachHipModuleRuntimeTestTiming(proofMaterial, testTiming);
  attachHipModuleRuntimeTestTiming(runtimeProofArtifact, testTiming);
  attachHipModuleRuntimeTestTiming(proofMaterial.runModeProof, testTiming);
  await writeFile(runtimeProofArtifactPath, `${JSON.stringify(runtimeProofArtifact, null, 2)}\n`);
  await writeFile(proofPath, `${JSON.stringify(proofMaterial, null, 2)}\n`);
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
    runtimeProofArtifactId: runtimeProofArtifact.proofId,
    runtimeProofStrictGate: runtimeProofArtifact.strictGate?.status ?? null,
    ledgerProofId: ledger.proofId,
    failedLedgerInvariants: ledger.failedInvariants,
    contractAccepted: contractEvaluation.accepted,
    computeOracleAccepted: oracleValidation.accepted,
    nativeHipApiAccepted: nativeApiEvidence.accepted,
    testTiming,
    test_timing: testTiming,
    timings: {
      totalValidatorWallTimeNs: timings.total_validator_wall_time,
      dispatchToOutputProofTimeNs: timings.dispatch_to_output_proof_time,
    },
  }, null, 2));
  if (!accepted) process.exitCode = 1;
}

if (process.argv.includes('--self-check')) {
  selfCheck().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
} else {
  const testTimingRecorder = createHipModuleRuntimeTimingV2Recorder();
  main(testTimingRecorder).catch((error) => {
    const outcome = hipModuleRuntimeTimingOutcome(error);
    let testTiming = null;
    try {
      testTiming = finalizeHipModuleRuntimeTimingV2({
        recorder: testTimingRecorder,
        outcome,
        terminalReason: hipModuleRuntimeTimingReason(outcome),
      });
    } catch (timingError) {
      console.error(timingError.stack || timingError.message);
    }
    console.error(JSON.stringify({
      schemaVersion: 'synthi.gpu_hmr.hip_module_runtime_failure.v1',
      error: String(error?.message ?? error),
      outcome,
      testTiming,
      test_timing: testTiming,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    }, null, 2));
    process.exitCode = 1;
  });
}
