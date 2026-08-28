#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import {
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  buildGpuHmrProofLedger,
  evaluateGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
  recomputeGpuHmrAcceptanceContractHash,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  buildComputeExpectedOutputContract,
} from './lib/gpu-hmr-compute-oracle-semantics.mjs';
import { buildArtifactCasManifest } from './lib/gpu-hmr-artifact-cas.mjs';
import {
  webGpuRuntimeComputeTimingMetrics,
} from './lib/gpu-hmr-timing-metrics.mjs';
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
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof');
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'profiles/webgpu-wgsl-runtime-compute-storage.json');
const SCHEMA = 'synthi.gpu_hmr.webgpu_runtime_compute_proof.v1';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';

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

const WEBGPU_LAUNCH_ARGS = Object.freeze([
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-features=Vulkan,WebGPU,UseSkiaRenderer',
  '--disable-gpu-sandbox',
]);
const NUMERIC_DATA_TYPES = new Set(['float32', 'uint32', 'int32']);
const COMPUTE_SEMANTIC_ORACLE_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.compute_semantic_oracle_identity.v1';
const INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA =
  'synthi.gpu_hmr.independent_semantic_oracle_request.v1';
const INDEPENDENT_SEMANTIC_ORACLE_RESULT_SCHEMA =
  'synthi.gpu_hmr.independent_semantic_oracle_result.v1';
const WEBGPU_SELECTION_CONTRACT_SCHEMA =
  'synthi.gpu_hmr.webgpu_selection_contract.v1';
const INDEPENDENT_TYPED_BYTE_VERIFIER_SCHEMA =
  'synthi.gpu_hmr.independent_typed_byte_verifier.v1';
const WEBGPU_ADAPTER_INFO_FIELDS = Object.freeze([
  'vendor',
  'architecture',
  'device',
  'description',
  'subgroupMinSize',
  'subgroupMaxSize',
  'isFallbackAdapter',
]);
const SEMANTIC_ORACLE_BINDING_FIELDS = Object.freeze([
  'projectId',
  'editId',
  'targetId',
  'requestId',
  'artifactAfterHash',
  'artifactSourceHash',
  'artifactBindingHash',
  'outputTargetId',
  'outputResourceId',
  'backend',
  'runtimeSessionId',
  'dispatchId',
  'traceArtifactHash',
  'pipelineStateHash',
  'resourceTraceHash',
  'observedReadbackHash',
  'adapterRequestOptionsHash',
  'requestedAdapterSelectorHash',
  'observedAdapterInfoHash',
  'requiredDeviceFeaturesHash',
  'requiredDeviceLimitsHash',
  'deviceRequestDescriptorHash',
  'webGpuSelectionHash',
  'trustedOracleImplementationHash',
]);
const OBSERVED_RUNTIME_BINDING_FIELDS = Object.freeze([
  'artifactAfterHash',
  'outputTargetId',
  'outputResourceId',
  'backend',
  'runtimeSessionId',
  'dispatchId',
  'traceArtifactHash',
  'pipelineStateHash',
  'resourceTraceHash',
  'observedReadbackHash',
  'adapterRequestOptionsHash',
  'requestedAdapterSelectorHash',
  'observedAdapterInfoHash',
  'requiredDeviceFeaturesHash',
  'requiredDeviceLimitsHash',
  'deviceRequestDescriptorHash',
  'webGpuSelectionHash',
]);
const SEMANTIC_ORACLE_RECEIPT_FIELDS = Object.freeze([
  ...SEMANTIC_ORACLE_BINDING_FIELDS,
  'semanticRequestHash',
  'oracleImplementationHash',
]);
const TEST_TIMING_SPLIT_NOT_APPLICABLE_REASON =
  'split_not_performed_by_webgpu_runtime_compute_producer';
const TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON = 'compute_only_test_has_no_visual_contract';
const TEST_TIMING_BROWSER_CLOCK_GAP_REASON =
  'browser_phase_not_delimited_in_node_monotonic_clock';
const TEST_TIMING_OUTPUT_READY_GAP_REASON =
  'output_ready_boundary_not_delimited_in_node_monotonic_clock';
const TEST_TIMING_RETIREMENT_GAP_REASON =
  'retirement_boundary_not_delimited_in_node_monotonic_clock';
const TEST_TIMING_TERMINAL_PASS_REASON = 'webgpu_runtime_compute_completed';
const TEST_TIMING_TERMINAL_REFUSAL_REASON = 'webgpu_runtime_compute_refused';
const TEST_TIMING_TERMINAL_FAILURE_REASON = 'webgpu_runtime_compute_failed';
const TEST_TIMING_BROWSER_PHASES = Object.freeze([
  'compile',
  'load',
  'epoch_publication',
  'dispatch',
]);
const TEST_TIMING_VISUAL_PHASES = Object.freeze([
  'trigger_to_visible',
  'screenshot_capture',
  'visual_analysis',
]);

const CFG = {
  slug: process.env.SLUG ?? `webgpu-runtime-compute-${nowSlugDate()}`,
  profilePath: process.env.SYNTHI_WEBGPU_COMPUTE_PROFILE ?? DEFAULT_PROFILE_PATH,
  browserExecutable: process.env.SYNTHI_WEBGPU_BROWSER_EXECUTABLE ?? '',
  timeoutMs: Number(process.env.SYNTHI_WEBGPU_COMPUTE_TIMEOUT_MS ?? 60000),
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
  metricScope: process.env.SYNTHI_WEBGPU_COMPUTE_METRIC_SCOPE ?? 'hot_delta_1',
  cacheState: process.env.SYNTHI_WEBGPU_COMPUTE_CACHE_STATE ?? 'pipeline_cache_warm',
  differentEdit: process.env.SYNTHI_WEBGPU_COMPUTE_DIFFERENT_EDIT === '1',
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

export function createWebgpuRuntimeComputeTimingV2Recorder(options = {}) {
  const recorder = new GpuHmrTestTimingRecorder(options);
  recorder.notApplicable('split', TEST_TIMING_SPLIT_NOT_APPLICABLE_REASON);
  for (const phaseKey of TEST_TIMING_BROWSER_PHASES) {
    recorder.unavailable(phaseKey, TEST_TIMING_BROWSER_CLOCK_GAP_REASON);
  }
  recorder.unavailable('output_ready', TEST_TIMING_OUTPUT_READY_GAP_REASON);
  recorder.unavailable('retirement', TEST_TIMING_RETIREMENT_GAP_REASON);
  for (const phaseKey of TEST_TIMING_VISUAL_PHASES) {
    recorder.notApplicable(phaseKey, TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON);
  }
  return recorder;
}

export async function measureWebgpuRuntimeComputeTimingPhase(recorder, phaseKey, operation) {
  recorder.startPhase(phaseKey);
  try {
    return await operation();
  } finally {
    recorder.finishPhase(phaseKey);
  }
}

export function finalizeWebgpuRuntimeComputeTimingV2({
  recorder,
  outcome,
  terminalReason,
}) {
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
    throw new TypeError(
      `invalid WebGPU compute timing-v2 record: ${validation.validationGaps.join(',')}`,
    );
  }
  return record;
}

export function attachWebgpuRuntimeComputeTestTiming(target, testTiming) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('WebGPU compute timing attachment target must be an object');
  }
  const validation = validateGpuHmrTestTiming(testTiming);
  if (
    testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA
    || validation.valid !== true
    || testTiming.acceptedForGpuHmr !== false
    || testTiming.gpuHmrSuccess !== false
  ) {
    throw new TypeError('WebGPU compute timing attachment requires valid support-only timing-v2');
  }
  const existingCamel = target.testTiming;
  const existingSnake = target.test_timing;
  if (
    (existingCamel && stableJson(existingCamel) !== stableJson(testTiming))
    || (existingSnake && stableJson(existingSnake) !== stableJson(testTiming))
    || (existingCamel && existingSnake && stableJson(existingCamel) !== stableJson(existingSnake))
  ) {
    throw new TypeError('WebGPU compute timing aliases conflict');
  }
  target.testTiming = testTiming;
  target.test_timing = testTiming;
  return target;
}

function webgpuRuntimeComputeTimingOutcome(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:unsupported|unavailable|missing|not found|returned null)/iu.test(message)
    ? 'refused'
    : 'failed';
}

function webgpuRuntimeComputeTimingReason(outcome) {
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
  return String(value || 'webgpu-runtime-compute').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function aliasedValue(record, camelKey, snakeKey, context) {
  const source = objectOrEmpty(record);
  const hasCamel = Object.prototype.hasOwnProperty.call(source, camelKey);
  const hasSnake = Object.prototype.hasOwnProperty.call(source, snakeKey);
  if (hasCamel && hasSnake && stableJson(source[camelKey]) !== stableJson(source[snakeKey])) {
    throw new Error(`${context} aliases ${camelKey}/${snakeKey} conflict`);
  }
  return hasCamel ? source[camelKey] : hasSnake ? source[snakeKey] : undefined;
}

function camelCaseForSnakeKey(key) {
  return key.replace(/_([a-z0-9])/gu, (_, character) => character.toUpperCase());
}

function assertCamelSnakeAliasesUnambiguous(value, context = 'profile') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCamelSnakeAliasesUnambiguous(entry, `${context}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    if (key.includes('_')) {
      const camelKey = camelCaseForSnakeKey(key);
      if (
        camelKey !== key
        && Object.prototype.hasOwnProperty.call(value, camelKey)
        && stableJson(entry) !== stableJson(value[camelKey])
      ) {
        throw new Error(`${context} aliases ${camelKey}/${key} conflict`);
      }
    }
    assertCamelSnakeAliasesUnambiguous(entry, `${context}.${key}`);
  }
}

function aliasedRuntimeText(record, camelKey, snakeKey, context) {
  const value = aliasedValue(record, camelKey, snakeKey, context);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function aliasedRuntimeArray(record, camelKey, snakeKey, context) {
  const value = aliasedValue(record, camelKey, snakeKey, context);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} ${camelKey}/${snakeKey} must be an array`);
  return value;
}

function exclusiveDeclaredValue(primary, secondary, context) {
  if (primary !== undefined && secondary !== undefined) {
    if (stableJson(primary) !== stableJson(secondary)) {
      throw new Error(`${context} declarations conflict`);
    }
    return primary;
  }
  return primary ?? secondary;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function declaredObjectOrEmpty(value, context) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function integerOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function positiveIntegerOrNull(value) {
  const n = integerOrNull(value);
  return n !== null && n > 0 ? n : null;
}

function nonNegativeIntegerOrNull(value) {
  const n = integerOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteNumberArrayOrNull(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map((entry) => finiteNumber(entry));
  return values.every((entry) => entry !== null) ? values : null;
}

function normalizeDataType(value, context, unsupported = null) {
  const dataType = firstText(value)?.toLowerCase() ?? 'float32';
  if (!NUMERIC_DATA_TYPES.has(dataType)) {
    if (unsupported) {
      unsupported.push(`${context}_resource_data_type_unsupported:${dataType}`);
      return 'float32';
    }
    throw new Error(`${context} uses unsupported data type ${dataType}`);
  }
  return dataType;
}

function byteWidthForDataType(dataType) {
  if (NUMERIC_DATA_TYPES.has(dataType)) return 4;
  throw new Error(`unsupported data type ${dataType}`);
}

function normalizeNumericValues(rawValues, context, dataType, unsupported = null) {
  const values = Array.isArray(rawValues) ? rawValues.map(Number) : [];
  if (values.length === 0) {
    if (unsupported) unsupported.push(`${context}_${dataType}_values_missing`);
    else throw new Error(`${context} must declare ${dataType} values`);
    return [];
  }
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) {
    if (unsupported) unsupported.push(`${context}_${dataType}_value_not_finite:${invalidIndex}`);
    else throw new Error(`${context}[${invalidIndex}] must be finite`);
    return values;
  }
  if (dataType === 'uint32') {
    const bad = values.findIndex((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff);
    if (bad >= 0 && unsupported) unsupported.push(`${context}_uint32_value_out_of_range:${bad}`);
    else if (bad >= 0) throw new Error(`${context}[${bad}] must be a uint32`);
  }
  if (dataType === 'int32') {
    const bad = values.findIndex((value) => !Number.isInteger(value) || value < -2147483648 || value > 2147483647);
    if (bad >= 0 && unsupported) unsupported.push(`${context}_int32_value_out_of_range:${bad}`);
    else if (bad >= 0) throw new Error(`${context}[${bad}] must be an int32`);
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

function compareNumericValues(actual, expected, tolerance, dataType) {
  if (!Array.isArray(expected) || expected.length === 0) {
    return {
      declared: false,
      matched: false,
      compared: 0,
      maxAbsDelta: null,
      mismatches: [],
    };
  }
  const actualValues = Array.isArray(actual) ? actual.map(Number) : [];
  const expectedValues = expected.map(Number);
  const normalizedExpected = dataType === 'float32'
    ? decodeNumericValues(encodeNumericValues(expectedValues, dataType), dataType)
    : expectedValues;
  const compared = Math.min(actualValues.length, normalizedExpected.length);
  const mismatches = [];
  let maxAbsDelta = 0;
  for (let index = 0; index < compared; index += 1) {
    const actualValue = actualValues[index];
    const expectedValue = normalizedExpected[index];
    const finite = Number.isFinite(actualValue) && Number.isFinite(expectedValue);
    const delta = finite ? Math.abs(actualValue - expectedValue) : null;
    if (delta !== null) maxAbsDelta = Math.max(maxAbsDelta, delta);
    if (!finite || delta > tolerance) {
      mismatches.push({
        index,
        actual: actualValues[index],
        expected: expectedValue,
        abs_delta: delta,
        reason: finite ? 'tolerance_exceeded' : 'non_finite_value',
      });
    }
  }
  if (actualValues.length !== normalizedExpected.length) {
    mismatches.push({
      index: compared,
      actual_length: actualValues.length,
      expected_length: normalizedExpected.length,
      abs_delta: null,
      reason: 'length_mismatch',
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

function independentlyEncodeTypedValues(values, dataType) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('independent typed-byte verifier requires non-empty expected values');
  }
  const byteWidth = { float32: 4, uint32: 4, int32: 4 }[dataType];
  if (!byteWidth) throw new Error(`independent typed-byte verifier does not support ${dataType}`);
  const view = new DataView(new ArrayBuffer(values.length * byteWidth));
  values.forEach((rawValue, index) => {
    const value = Number(rawValue);
    const offset = index * byteWidth;
    if (!Number.isFinite(value)) throw new Error(`expected value ${index} is not finite`);
    if (dataType === 'float32') view.setFloat32(offset, value, true);
    else if (dataType === 'uint32') {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`expected value ${index} is not uint32`);
      }
      view.setUint32(offset, value, true);
    } else {
      if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
        throw new Error(`expected value ${index} is not int32`);
      }
      view.setInt32(offset, value, true);
    }
  });
  return Buffer.from(view.buffer);
}

function verifyExactTypedReadback({ observedBytes, expectedValues, expectedBytes, expectedRawHash, dataType }) {
  const canonicalExpected = independentlyEncodeTypedValues(expectedValues, dataType);
  const declaredExpected = Buffer.from(Array.isArray(expectedBytes) ? expectedBytes : []);
  const observed = Buffer.from(observedBytes);
  const failures = [];
  const mismatches = [];
  if (!declaredExpected.equals(canonicalExpected)) {
    failures.push('semantic_oracle_expected_bytes_not_canonical');
  }
  if (expectedRawHash !== sha256Bytes(canonicalExpected)) {
    failures.push('semantic_oracle_expected_raw_hash_mismatch');
  }
  if (observed.length !== canonicalExpected.length) {
    failures.push('semantic_oracle_observed_byte_length_mismatch');
    failures.push('semantic_oracle_observed_element_count_mismatch');
  }
  const compared = Math.min(observed.length, canonicalExpected.length);
  for (let index = 0; index < compared; index += 1) {
    if (observed[index] !== canonicalExpected[index]) {
      mismatches.push({ index, actualByte: observed[index], expectedByte: canonicalExpected[index] });
    }
  }
  if (observed.length !== canonicalExpected.length) {
    mismatches.push({ index: compared, actualLength: observed.length, expectedLength: canonicalExpected.length });
  }
  return {
    matched: failures.length === 0 && mismatches.length === 0,
    failures,
    mismatches,
    expectedByteLength: canonicalExpected.length,
    expectedElementCount: expectedValues.length,
  };
}

function independentTypedByteVerifierHash() {
  return sha256Text([
    INDEPENDENT_TYPED_BYTE_VERIFIER_SCHEMA,
    independentlyEncodeTypedValues.toString(),
    verifyExactTypedReadback.toString(),
  ].join('\n'));
}

function webGpuSemanticOracleImplementation(request) {
  const fail = (message) => {
    throw new Error(`webgpu semantic oracle: ${message}`);
  };
  const isIdentStart = (char) => (
    char === '_'
    || (char >= 'A' && char <= 'Z')
    || (char >= 'a' && char <= 'z')
  );
  const isIdentPart = (char) => isIdentStart(char) || (char >= '0' && char <= '9');
  const isDigit = (char) => char >= '0' && char <= '9';
  const lex = (source) => {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        index += 1;
        continue;
      }
      if (char === '/' && source[index + 1] === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        const start = index;
        index += 2;
        while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
          index += 1;
        }
        if (index + 1 >= source.length) fail(`unterminated block comment at byte ${start}`);
        index += 2;
        continue;
      }
      if (isIdentStart(char)) {
        const start = index;
        index += 1;
        while (index < source.length && isIdentPart(source[index])) index += 1;
        tokens.push({ kind: 'identifier', value: source.slice(start, index), start });
        continue;
      }
      if (isDigit(char) || (char === '.' && isDigit(source[index + 1]))) {
        const start = index;
        if (char === '.') index += 1;
        while (isDigit(source[index])) index += 1;
        if (source[index] === '.') {
          index += 1;
          while (isDigit(source[index])) index += 1;
        }
        if (source[index] === 'e' || source[index] === 'E') {
          index += 1;
          if (source[index] === '+' || source[index] === '-') index += 1;
          const exponentStart = index;
          while (isDigit(source[index])) index += 1;
          if (index === exponentStart) fail(`invalid numeric exponent at byte ${start}`);
        }
        if ('uUiIfF'.includes(source[index] ?? '')) index += 1;
        tokens.push({ kind: 'number', value: source.slice(start, index), start });
        continue;
      }
      const pair = source.slice(index, index + 2);
      if (['>=', '<=', '==', '!=', '&&', '||', '->'].includes(pair)) {
        tokens.push({ kind: 'punct', value: pair, start: index });
        index += 2;
        continue;
      }
      if ('@(){}[];,.:*+-/%<>=&'.includes(char)) {
        tokens.push({ kind: 'punct', value: char, start: index });
        index += 1;
        continue;
      }
      fail(`unsupported token ${JSON.stringify(char)} at byte ${index}`);
    }
    return tokens;
  };
  const matchingIndex = (tokens, start, open, close, context) => {
    if (tokens[start]?.value !== open) fail(`${context} is missing ${open}`);
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index].value === open) depth += 1;
      else if (tokens[index].value === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    fail(`${context} has unbalanced ${open}${close}`);
  };
  const splitTopLevel = (tokens, separator) => {
    const parts = [];
    let start = 0;
    let round = 0;
    let square = 0;
    let angle = 0;
    tokens.forEach((token, index) => {
      if (token.value === '(') round += 1;
      else if (token.value === ')') round -= 1;
      else if (token.value === '[') square += 1;
      else if (token.value === ']') square -= 1;
      else if (token.value === '<') angle += 1;
      else if (token.value === '>') angle -= 1;
      if (token.value === separator && round === 0 && square === 0 && angle === 0) {
        parts.push(tokens.slice(start, index));
        start = index + 1;
      }
    });
    parts.push(tokens.slice(start));
    return parts;
  };
  const parseProgram = (source, entryPoint) => {
    const tokens = lex(source);
    let position = 0;
    const structs = new Map();
    const globals = [];
    const functions = [];
    const peek = (offset = 0) => tokens[position + offset];
    const take = (value = null) => {
      const token = peek();
      if (!token || (value !== null && token.value !== value)) {
        fail(`expected ${value ?? 'token'} at WGSL top level, found ${token?.value ?? 'end of source'}`);
      }
      position += 1;
      return token;
    };
    const parseAttributes = () => {
      const attributes = [];
      while (peek()?.value === '@') {
        take('@');
        const name = take();
        if (name.kind !== 'identifier') fail('WGSL attribute name is missing');
        let args = [];
        if (peek()?.value === '(') {
          const end = matchingIndex(tokens, position, '(', ')', `@${name.value}`);
          args = tokens.slice(position + 1, end);
          position = end + 1;
        }
        attributes.push({ name: name.value, args });
      }
      return attributes;
    };
    const parseType = () => {
      const token = take();
      if (token.kind !== 'identifier') fail('WGSL type name is missing');
      if (['f32', 'u32', 'i32', 'vec3u', 'vec3i', 'vec3f'].includes(token.value)) {
        return { kind: 'scalar-or-vector', name: token.value };
      }
      if (token.value === 'array') {
        take('<');
        const element = parseType();
        if (peek()?.value === ',') fail('fixed-size arrays are outside the semantic-oracle subset');
        take('>');
        return { kind: 'array', element };
      }
      return { kind: 'named', name: token.value };
    };
    while (position < tokens.length) {
      const attributes = parseAttributes();
      const declaration = peek()?.value;
      if (declaration === 'struct') {
        if (attributes.length > 0) fail('attributes on structs are unsupported');
        take('struct');
        const name = take();
        if (name.kind !== 'identifier' || structs.has(name.value)) fail('WGSL struct name is missing or duplicated');
        take('{');
        const members = new Map();
        while (peek()?.value !== '}') {
          const memberAttributes = parseAttributes();
          if (memberAttributes.length > 0) fail('attributes on struct members are unsupported');
          const memberName = take();
          if (memberName.kind !== 'identifier' || members.has(memberName.value)) fail('WGSL struct member is missing or duplicated');
          take(':');
          const type = parseType();
          if (![';', ','].includes(peek()?.value)) fail('WGSL struct member terminator is missing');
          take();
          members.set(memberName.value, type);
        }
        take('}');
        if (peek()?.value === ';') take(';');
        structs.set(name.value, { name: name.value, members });
        continue;
      }
      if (declaration === 'var') {
        take('var');
        take('<');
        const addressSpace = take().value;
        take(',');
        const access = take().value;
        take('>');
        const name = take();
        if (name.kind !== 'identifier') fail('WGSL global variable name is missing');
        take(':');
        const type = parseType();
        take(';');
        const attributeValue = (attributeName) => {
          const matches = attributes.filter((attribute) => attribute.name === attributeName);
          if (matches.length !== 1 || matches[0].args.length !== 1 || matches[0].args[0].kind !== 'number') {
            fail(`global ${name.value} requires one @${attributeName} integer`);
          }
          const value = Number(matches[0].args[0].value.replace(/[uU]$/u, ''));
          if (!Number.isSafeInteger(value) || value < 0) fail(`global ${name.value} has invalid @${attributeName}`);
          return value;
        };
        if (addressSpace !== 'storage' || !['read', 'read_write'].includes(access)) {
          fail(`global ${name.value} uses unsupported address space or access mode`);
        }
        globals.push({
          name: name.value,
          group: attributeValue('group'),
          binding: attributeValue('binding'),
          addressSpace,
          access,
          type,
        });
        continue;
      }
      if (declaration === 'fn') {
        take('fn');
        const name = take();
        if (name.kind !== 'identifier') fail('WGSL function name is missing');
        const paramsEnd = matchingIndex(tokens, position, '(', ')', `function ${name.value}`);
        const parameterTokens = tokens.slice(position + 1, paramsEnd);
        position = paramsEnd + 1;
        let returnType = null;
        if (peek()?.value === '->') {
          take('->');
          parseAttributes();
          returnType = parseType();
        }
        if (peek()?.value !== '{') fail(`function ${name.value} body is missing`);
        const bodyEnd = matchingIndex(tokens, position, '{', '}', `function ${name.value}`);
        functions.push({
          name: name.value,
          attributes,
          parameterTokens,
          returnType,
          bodyTokens: tokens.slice(position, bodyEnd + 1),
        });
        position = bodyEnd + 1;
        continue;
      }
      fail(`unsupported WGSL top-level declaration ${declaration ?? 'end of source'}`);
    }
    const entries = functions.filter((fn) => fn.name === entryPoint);
    if (entries.length !== 1) fail(`expected exactly one WGSL entry named ${entryPoint}, found ${entries.length}`);
    const entry = entries[0];
    if (entry.returnType !== null) fail(`WGSL compute entry ${entryPoint} must not return a value`);
    if (entry.attributes.filter((attribute) => attribute.name === 'compute').length !== 1) {
      fail(`WGSL entry ${entryPoint} is not uniquely marked @compute`);
    }
    const workgroupAttributes = entry.attributes.filter((attribute) => attribute.name === 'workgroup_size');
    if (workgroupAttributes.length !== 1) fail(`WGSL entry ${entryPoint} requires one @workgroup_size`);
    const workgroupParts = splitTopLevel(workgroupAttributes[0].args, ',');
    if (workgroupParts.length < 1 || workgroupParts.length > 3) fail('WGSL workgroup size rank is unsupported');
    const workgroupSize = [0, 1, 1];
    workgroupParts.forEach((part, index) => {
      if (part.length !== 1 || part[0].kind !== 'number') fail('WGSL workgroup size must be literal');
      const value = Number(part[0].value.replace(/[uU]$/u, ''));
      if (!Number.isSafeInteger(value) || value <= 0) fail('WGSL workgroup size must be positive');
      workgroupSize[index] = value;
    });
    const parameterParts = entry.parameterTokens.length === 0 ? [] : splitTopLevel(entry.parameterTokens, ',');
    entry.parameters = parameterParts.map((part) => {
      let cursor = 0;
      const attributes = [];
      while (part[cursor]?.value === '@') {
        cursor += 1;
        const name = part[cursor++];
        if (part[cursor]?.value !== '(') fail('WGSL parameter attribute arguments are missing');
        const end = matchingIndex(part, cursor, '(', ')', `parameter @${name?.value}`);
        attributes.push({ name: name?.value, args: part.slice(cursor + 1, end) });
        cursor = end + 1;
      }
      const name = part[cursor++];
      if (name?.kind !== 'identifier' || part[cursor++]?.value !== ':') fail('WGSL entry parameter is malformed');
      const typeToken = part[cursor++];
      if (typeToken?.kind !== 'identifier' || cursor !== part.length) fail('WGSL entry parameter type is unsupported');
      return { name: name.value, type: typeToken.value, attributes };
    });
    entry.workgroupSize = workgroupSize;
    return { structs, globals, entry };
  };
  const parseBody = (bodyTokens) => {
    let position = 0;
    const peek = (offset = 0) => bodyTokens[position + offset];
    const take = (value = null) => {
      const token = peek();
      if (!token || (value !== null && token.value !== value)) {
        fail(`expected ${value ?? 'token'} in WGSL entry body, found ${token?.value ?? 'end of body'}`);
      }
      position += 1;
      return token;
    };
    let parseExpression;
    let parseBlock;
    const parsePrimary = () => {
      const token = peek();
      if (!token) fail('WGSL expression ended unexpectedly');
      if (token.value === '(') {
        take('(');
        const value = parseExpression();
        take(')');
        return value;
      }
      if (token.kind === 'number') {
        take();
        return { kind: 'number', raw: token.value };
      }
      if (token.kind === 'identifier') {
        take();
        return { kind: 'identifier', name: token.value };
      }
      fail(`unsupported WGSL primary token ${token.value}`);
    };
    const parsePostfix = () => {
      let value = parsePrimary();
      while (true) {
        if (peek()?.value === '(') {
          if (value.kind !== 'identifier') fail('only named WGSL calls are supported');
          take('(');
          const args = [];
          if (peek()?.value !== ')') {
            while (true) {
              args.push(parseExpression());
              if (peek()?.value !== ',') break;
              take(',');
            }
          }
          take(')');
          value = { kind: 'call', name: value.name, args };
        } else if (peek()?.value === '.') {
          take('.');
          const member = take();
          if (member.kind !== 'identifier') fail('WGSL member name is missing');
          value = { kind: 'member', object: value, member: member.value };
        } else if (peek()?.value === '[') {
          take('[');
          const index = parseExpression();
          take(']');
          value = { kind: 'index', object: value, index };
        } else {
          break;
        }
      }
      return value;
    };
    const parseUnary = () => {
      if (['+', '-', '&'].includes(peek()?.value)) {
        const operator = take().value;
        return { kind: 'unary', operator, value: parseUnary() };
      }
      return parsePostfix();
    };
    const parseMultiplicative = () => {
      let value = parseUnary();
      while (['*', '/', '%'].includes(peek()?.value)) {
        const operator = take().value;
        value = { kind: 'binary', operator, left: value, right: parseUnary() };
      }
      return value;
    };
    const parseAdditive = () => {
      let value = parseMultiplicative();
      while (['+', '-'].includes(peek()?.value)) {
        const operator = take().value;
        value = { kind: 'binary', operator, left: value, right: parseMultiplicative() };
      }
      return value;
    };
    const parseRelational = () => {
      let value = parseAdditive();
      while (['<', '<=', '>', '>=', '==', '!='].includes(peek()?.value)) {
        const operator = take().value;
        value = { kind: 'binary', operator, left: value, right: parseAdditive() };
      }
      return value;
    };
    parseExpression = () => parseRelational();
    const parseStatement = () => {
      if (peek()?.value === '{') return parseBlock();
      if (peek()?.value === 'return') {
        take('return');
        take(';');
        return { kind: 'return' };
      }
      if (peek()?.value === 'if') {
        take('if');
        take('(');
        const condition = parseExpression();
        take(')');
        const consequent = parseStatement();
        if (peek()?.value === 'else') fail('WGSL else statements are outside the supported subset');
        return { kind: 'if', condition, consequent };
      }
      if (peek()?.value === 'let') {
        take('let');
        const name = take();
        if (name.kind !== 'identifier') fail('WGSL let name is missing');
        let declaredType = null;
        if (peek()?.value === ':') {
          take(':');
          const type = take();
          if (!['f32', 'u32', 'i32'].includes(type.value)) fail(`unsupported WGSL local type ${type.value}`);
          declaredType = type.value;
        }
        take('=');
        const initializer = parseExpression();
        take(';');
        return { kind: 'declaration', name: name.value, declaredType, initializer };
      }
      const target = parseExpression();
      take('=');
      const value = parseExpression();
      take(';');
      if (target.kind !== 'index' || target.object.kind !== 'member') {
        fail('only storage-buffer element assignments are supported');
      }
      return { kind: 'assignment', target, value };
    };
    parseBlock = () => {
      take('{');
      const statements = [];
      while (peek()?.value !== '}') {
        if (!peek()) fail('WGSL entry block is unterminated');
        statements.push(parseStatement());
      }
      take('}');
      return { kind: 'block', statements };
    };
    const body = parseBlock();
    if (position !== bodyTokens.length) fail('WGSL entry body contains trailing syntax');
    return body;
  };
  const dataTypeFor = (type) => {
    if (type === 'f32') return 'float32';
    if (type === 'u32') return 'uint32';
    if (type === 'i32') return 'int32';
    fail(`unsupported WGSL storage element type ${type}`);
  };
  const storageElementType = (global, structs) => {
    let type = global.type;
    if (type.kind === 'named') {
      const struct = structs.get(type.name);
      if (!struct) fail(`storage global ${global.name} references unknown struct ${type.name}`);
      if (struct.members.size !== 1 || !struct.members.has('data')) {
        fail(`storage struct ${type.name} must contain only a data runtime array`);
      }
      type = struct.members.get('data');
    }
    if (type.kind !== 'array' || type.element.kind !== 'scalar-or-vector') {
      fail(`storage global ${global.name} is not a scalar runtime array`);
    }
    if (!['f32', 'u32', 'i32'].includes(type.element.name)) {
      fail(`storage global ${global.name} has unsupported element type ${type.element.name}`);
    }
    return type.element.name;
  };
  const typed = (type, value) => ({ type, value });
  const i32Min = -2147483648n;
  const i32Max = 2147483647n;
  const u32Max = 4294967295n;
  const assertFinite = (value) => {
    if (!Number.isFinite(value)) fail('WGSL floating-point operation produced a non-finite value');
    return value;
  };
  const convert = (input, targetType, explicit = false) => {
    if (input.type === targetType) return input;
    if (targetType === 'f32') {
      if (!['f32', 'u32', 'i32', 'abstract-int', 'abstract-float'].includes(input.type)) {
        fail(`cannot convert ${input.type} to f32`);
      }
      return typed('f32', Math.fround(assertFinite(Number(input.value))));
    }
    if (!['u32', 'i32'].includes(targetType)) fail(`unsupported WGSL conversion target ${targetType}`);
    if ((input.type === 'f32' || input.type === 'abstract-float') && !explicit) {
      fail(`implicit ${input.type} to ${targetType} conversion is invalid WGSL`);
    }
    const numeric = input.type === 'f32' || input.type === 'abstract-float'
      ? Math.trunc(assertFinite(input.value))
      : Number(input.value);
    if (!Number.isSafeInteger(numeric)) fail(`WGSL value cannot be represented as ${targetType}`);
    const integer = BigInt(numeric);
    if (!explicit && input.type === 'abstract-int') {
      if (targetType === 'u32' && (integer < 0n || integer > u32Max)) fail('abstract integer is outside u32');
      if (targetType === 'i32' && (integer < i32Min || integer > i32Max)) fail('abstract integer is outside i32');
    }
    return typed(targetType, targetType === 'u32' ? BigInt.asUintN(32, integer) : BigInt.asIntN(32, integer));
  };
  const materialize = (value) => {
    if (value.type === 'abstract-int') return convert(value, 'i32');
    if (value.type === 'abstract-float') return convert(value, 'f32');
    return value;
  };
  const commonType = (left, right) => {
    if (left.type === right.type) return left.type;
    const concrete = [left.type, right.type].find((type) => ['f32', 'u32', 'i32'].includes(type));
    const abstract = concrete === left.type ? right.type : left.type;
    if (concrete) {
      if (concrete === 'f32' && ['abstract-int', 'abstract-float'].includes(abstract)) return 'f32';
      if (['u32', 'i32'].includes(concrete) && abstract === 'abstract-int') return concrete;
      fail(`WGSL operands ${left.type} and ${right.type} have incompatible types`);
    }
    if (
      (left.type === 'abstract-float' && right.type === 'abstract-int')
      || (right.type === 'abstract-float' && left.type === 'abstract-int')
    ) return 'abstract-float';
    fail(`WGSL operands ${left.type} and ${right.type} have incompatible abstract types`);
  };
  const convertForOperation = (value, type) => {
    if (value.type === type) return value;
    if (type === 'abstract-float' && value.type === 'abstract-int') return typed(type, Number(value.value));
    return convert(value, type);
  };
  const integerOperation = (operator, left, right, type) => {
    if ((operator === '/' || operator === '%') && right === 0n) fail('WGSL integer division by zero');
    if (type === 'i32' && left === i32Min && right === -1n && operator === '/') {
      fail('WGSL i32 minimum divided by -1 is outside the supported deterministic subset');
    }
    let result;
    if (operator === '+') result = left + right;
    else if (operator === '-') result = left - right;
    else if (operator === '*') result = left * right;
    else if (operator === '/') result = left / right;
    else if (operator === '%') result = left % right;
    else fail(`unsupported WGSL integer operator ${operator}`);
    if (type === 'u32') return BigInt.asUintN(32, result);
    if (type === 'i32') return BigInt.asIntN(32, result);
    return result;
  };
  const binary = (operator, rawLeft, rawRight) => {
    if (rawLeft.type === 'bool' || rawRight.type === 'bool') fail('WGSL boolean arithmetic is unsupported');
    const type = commonType(rawLeft, rawRight);
    const left = convertForOperation(rawLeft, type);
    const right = convertForOperation(rawRight, type);
    if (['<', '<=', '>', '>=', '==', '!='].includes(operator)) {
      if (operator === '<') return typed('bool', left.value < right.value);
      if (operator === '<=') return typed('bool', left.value <= right.value);
      if (operator === '>') return typed('bool', left.value > right.value);
      if (operator === '>=') return typed('bool', left.value >= right.value);
      if (operator === '==') return typed('bool', left.value === right.value);
      return typed('bool', left.value !== right.value);
    }
    if (['u32', 'i32', 'abstract-int'].includes(type)) {
      return typed(type, integerOperation(operator, left.value, right.value, type));
    }
    let result;
    if (operator === '+') result = left.value + right.value;
    else if (operator === '-') result = left.value - right.value;
    else if (operator === '*') result = left.value * right.value;
    else if (operator === '/') result = left.value / right.value;
    else if (operator === '%') result = left.value % right.value;
    else fail(`unsupported WGSL floating-point operator ${operator}`);
    assertFinite(result);
    return typed(type, type === 'f32' ? Math.fround(result) : result);
  };
  const numberValue = (raw) => {
    const suffix = raw.at(-1);
    const hasSuffix = 'uUiIfF'.includes(suffix);
    const text = hasSuffix ? raw.slice(0, -1) : raw;
    const floating = text.includes('.') || text.includes('e') || text.includes('E');
    if ((suffix === 'u' || suffix === 'U' || suffix === 'i' || suffix === 'I') && floating) {
      fail(`invalid WGSL integer literal ${raw}`);
    }
    if (suffix === 'u' || suffix === 'U') {
      const value = BigInt(text);
      if (value < 0n || value > u32Max) fail(`WGSL u32 literal ${raw} is out of range`);
      return typed('u32', value);
    }
    if (suffix === 'i' || suffix === 'I') {
      const value = BigInt(text);
      if (value < i32Min || value > i32Max) fail(`WGSL i32 literal ${raw} is out of range`);
      return typed('i32', value);
    }
    if (suffix === 'f' || suffix === 'F') return typed('f32', Math.fround(assertFinite(Number(text))));
    return floating
      ? typed('abstract-float', assertFinite(Number(text)))
      : typed('abstract-int', BigInt(text));
  };
  const decode = (bytes, dataType) => {
    if (!Array.isArray(bytes) || bytes.length === 0 || bytes.length % 4 !== 0) {
      fail('resource bytes must be a non-empty aligned byte array');
    }
    if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      fail('resource bytes contain a non-byte value');
    }
    const raw = Uint8Array.from(bytes);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const values = [];
    for (let offset = 0; offset < raw.byteLength; offset += 4) {
      if (dataType === 'float32') values.push(typed('f32', view.getFloat32(offset, true)));
      else if (dataType === 'uint32') values.push(typed('u32', BigInt(view.getUint32(offset, true))));
      else if (dataType === 'int32') values.push(typed('i32', BigInt(view.getInt32(offset, true))));
      else fail(`unsupported data type ${dataType}`);
    }
    return values;
  };
  const encode = (values, dataType) => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    const targetType = dataType === 'float32' ? 'f32' : dataType === 'uint32' ? 'u32' : 'i32';
    values.forEach((value, index) => {
      const converted = convert(value, targetType, true);
      if (dataType === 'float32') view.setFloat32(index * 4, converted.value, true);
      else if (dataType === 'uint32') view.setUint32(index * 4, Number(converted.value), true);
      else if (dataType === 'int32') view.setInt32(index * 4, Number(converted.value), true);
    });
    return Array.from(bytes);
  };
  if (!request || request.schemaVersion !== 'synthi.gpu_hmr.independent_semantic_oracle_request.v1') {
    fail('request schema is invalid');
  }
  const source = request.artifact?.source;
  const entryPoint = request.artifact?.entryPoint;
  if (typeof source !== 'string' || source.length === 0 || typeof entryPoint !== 'string') {
    fail('WGSL source or entry point is missing');
  }
  const program = parseProgram(source, entryPoint);
  const body = parseBody(program.entry.bodyTokens);
  const referencedIdentifiers = new Set();
  const collectReferencedIdentifiers = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'identifier') referencedIdentifiers.add(node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collectReferencedIdentifiers);
      else collectReferencedIdentifiers(value);
    }
  };
  collectReferencedIdentifiers(body);
  const resources = Array.isArray(request.resources) ? request.resources : [];
  const resourceKeys = new Set();
  for (const resource of resources) {
    const key = `${resource?.group}:${resource?.binding}`;
    if (!Number.isSafeInteger(resource?.group) || !Number.isSafeInteger(resource?.binding) || resourceKeys.has(key)) {
      fail('observed WGSL resources require unique integer group/binding pairs');
    }
    resourceKeys.add(key);
  }
  const copiedResources = resources.filter((resource) => resource.copiedByRuntime === true);
  if (copiedResources.length !== 1) {
    fail(`runtime trace must identify exactly one copied output resource, found ${copiedResources.length}`);
  }
  const outputResource = copiedResources[0];
  const expectedOutputResourceId = [
    `group:${outputResource.group}`,
    `binding:${outputResource.binding}`,
    `resource:${outputResource.resourceHash}`,
  ].join(':');
  if (request.binding?.outputResourceId !== expectedOutputResourceId) {
    fail('runtime output resource identity does not match the copied group/binding/resource');
  }
  const outputGlobals = program.globals.filter((global) => (
    global.group === outputResource.group && global.binding === outputResource.binding
  ));
  if (outputGlobals.length !== 1) fail('copied runtime resource does not select exactly one WGSL global');
  const outputGlobal = outputGlobals[0];
  if (outputGlobal.access !== 'read_write') fail('copied output WGSL global is not read_write storage');
  if (outputResource.access !== 'read_write' || outputResource.readback !== true) {
    fail('copied output resource is not an observed read_write readback resource');
  }
  const referencedGlobals = program.globals.filter((global) => referencedIdentifiers.has(global.name));
  const inputGlobals = referencedGlobals.filter((global) => global.access === 'read');
  if (inputGlobals.length !== 1) {
    fail(`selected WGSL entry requires exactly one read storage global, found ${inputGlobals.length}`);
  }
  const inputGlobal = inputGlobals[0];
  const unsupportedReferencedGlobals = referencedGlobals.filter((global) => (
    global !== inputGlobal && global !== outputGlobal
  ));
  if (unsupportedReferencedGlobals.length > 0 || !referencedIdentifiers.has(outputGlobal.name)) {
    fail('selected WGSL entry references storage globals outside the exact input/output pair');
  }
  const inputResources = resources.filter((resource) => (
    resource.group === inputGlobal.group && resource.binding === inputGlobal.binding
  ));
  if (inputResources.length !== 1) fail('WGSL input global does not select exactly one observed resource');
  const inputResource = inputResources[0];
  if (!['read', 'read_only'].includes(inputResource.access) || inputResource.readback === true) {
    fail('WGSL input resource access/readback role mismatches reflection');
  }
  const outputType = storageElementType(outputGlobal, program.structs);
  const inputType = storageElementType(inputGlobal, program.structs);
  if (outputType !== inputType) fail('WGSL input and output source element types differ');
  const dataType = dataTypeFor(outputType);
  if (outputResource.dataType !== dataType || inputResource.dataType !== dataType) {
    fail(`declared resource dtype does not match reflected WGSL ${dataType}`);
  }
  const builtinParameters = program.entry.parameters.filter((parameter) => (
    parameter.attributes.some((attribute) => (
      attribute.name === 'builtin'
      && attribute.args.length === 1
      && attribute.args[0].value === 'global_invocation_id'
    ))
  ));
  if (builtinParameters.length !== 1 || builtinParameters[0].type !== 'vec3u') {
    fail('WGSL entry requires exactly one vec3u @builtin(global_invocation_id) parameter');
  }
  if (program.entry.parameters.length !== 1) fail('additional WGSL entry parameters are unsupported');
  const dispatchWorkgroups = request.dispatch?.workgroups;
  if (
    !Array.isArray(dispatchWorkgroups)
    || dispatchWorkgroups.length !== 3
    || dispatchWorkgroups.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) fail('dispatch workgroups must contain three positive integers');
  const workgroupSize = program.entry.workgroupSize;
  if (workgroupSize[1] !== 1 || workgroupSize[2] !== 1 || dispatchWorkgroups[1] !== 1 || dispatchWorkgroups[2] !== 1) {
    fail('only one-dimensional WGSL compute dispatches are supported');
  }
  const inputValues = decode(inputResource.initialBytes, dataType);
  const outputValues = decode(outputResource.initialBytes, dataType);
  const globalsByName = new Map(program.globals.map((global) => [global.name, global]));
  const invocationCount = dispatchWorkgroups[0] * workgroupSize[0];
  const evaluate = (node, environment) => {
    if (node.kind === 'number') return numberValue(node.raw);
    if (node.kind === 'identifier') {
      if (!environment.has(node.name)) fail(`unknown WGSL semantic symbol ${node.name}`);
      return environment.get(node.name);
    }
    if (node.kind === 'member') {
      const object = evaluate(node.object, environment);
      if (object.kind === 'vector') {
        if (!['x', 'y', 'z'].includes(node.member)) fail(`unsupported WGSL vector member ${node.member}`);
        return object.values[['x', 'y', 'z'].indexOf(node.member)];
      }
      if (object.kind === 'buffer' && node.member === 'data') return object;
      fail(`unsupported WGSL member ${node.member}`);
    }
    if (node.kind === 'index') {
      const buffer = evaluate(node.object, environment);
      if (buffer.kind !== 'buffer') fail('WGSL indexed value is not a storage buffer');
      const indexValue = convert(evaluate(node.index, environment), 'u32');
      const index = Number(indexValue.value);
      if (!Number.isSafeInteger(index) || index < 0 || index >= buffer.values.length) {
        fail(`WGSL storage index ${index} is out of bounds`);
      }
      return buffer.values[index];
    }
    if (node.kind === 'unary') {
      const value = evaluate(node.value, environment);
      if (node.operator === '&') return { kind: 'reference', value };
      if (node.operator === '+') return value;
      if (value.type === 'u32') return typed('u32', BigInt.asUintN(32, -value.value));
      if (value.type === 'i32') return typed('i32', BigInt.asIntN(32, -value.value));
      if (value.type === 'abstract-int') return typed('abstract-int', -value.value);
      if (value.type === 'f32') return typed('f32', Math.fround(-value.value));
      if (value.type === 'abstract-float') return typed('abstract-float', -value.value);
      fail(`unsupported WGSL unary operand ${value.type}`);
    }
    if (node.kind === 'call') {
      if (['f32', 'u32', 'i32'].includes(node.name)) {
        if (node.args.length !== 1) fail(`${node.name} conversion requires one argument`);
        return convert(evaluate(node.args[0], environment), node.name, true);
      }
      if (node.name === 'arrayLength') {
        if (node.args.length !== 1) fail('arrayLength requires one argument');
        const reference = evaluate(node.args[0], environment);
        if (reference.kind !== 'reference' || reference.value.kind !== 'buffer') {
          fail('arrayLength argument must reference a storage runtime array');
        }
        return typed('u32', BigInt(reference.value.values.length));
      }
      fail(`unsupported WGSL call ${node.name}`);
    }
    if (node.kind === 'binary') {
      return binary(node.operator, evaluate(node.left, environment), evaluate(node.right, environment));
    }
    fail(`unsupported WGSL expression node ${node.kind}`);
  };
  const written = new Set();
  const executeStatement = (statement, environment) => {
    if (statement.kind === 'block') {
      for (const child of statement.statements) {
        const signal = executeStatement(child, environment);
        if (signal) return signal;
      }
      return null;
    }
    if (statement.kind === 'return') return 'return';
    if (statement.kind === 'if') {
      const condition = evaluate(statement.condition, environment);
      if (condition.type !== 'bool') fail('WGSL if condition is not boolean');
      return condition.value ? executeStatement(statement.consequent, environment) : null;
    }
    if (statement.kind === 'declaration') {
      if (environment.has(statement.name)) fail(`WGSL local ${statement.name} shadows an existing symbol`);
      let value = evaluate(statement.initializer, environment);
      value = statement.declaredType ? convert(value, statement.declaredType) : materialize(value);
      environment.set(statement.name, value);
      return null;
    }
    if (statement.kind === 'assignment') {
      const targetObject = statement.target.object;
      if (
        targetObject.object.kind !== 'identifier'
        || targetObject.object.name !== outputGlobal.name
        || targetObject.member !== 'data'
      ) fail('WGSL entry writes a resource other than the runtime-copied output');
      const index = Number(convert(evaluate(statement.target.index, environment), 'u32').value);
      if (!Number.isSafeInteger(index) || index < 0 || index >= outputValues.length) {
        fail(`WGSL output index ${index} is out of bounds`);
      }
      if (written.has(index)) fail(`multiple WGSL invocations write output index ${index}`);
      outputValues[index] = convert(evaluate(statement.value, environment), outputType);
      written.add(index);
      return null;
    }
    fail(`unsupported WGSL statement ${statement.kind}`);
  };
  for (let globalIndex = 0; globalIndex < invocationCount; globalIndex += 1) {
    const environment = new Map();
    for (const [name, global] of globalsByName) {
      const resource = resources.find((candidate) => candidate.group === global.group && candidate.binding === global.binding);
      if (!resource) continue;
      environment.set(name, {
        kind: 'buffer',
        type: storageElementType(global, program.structs),
        values: global === outputGlobal ? outputValues : inputValues,
      });
    }
    environment.set(builtinParameters[0].name, {
      kind: 'vector',
      values: [typed('u32', BigInt(globalIndex)), typed('u32', 0n), typed('u32', 0n)],
    });
    executeStatement(body, environment);
  }
  if (written.size === 0) fail('WGSL target entry produced no output writes');
  const plainValues = outputValues.map((value) => Number(value.value));
  return {
    schemaVersion: 'synthi.gpu_hmr.independent_semantic_oracle_result.v1',
    dataType,
    elementCount: outputValues.length,
    shape: [outputValues.length],
    byteOrder: 'little_endian',
    tolerance: dataType === 'float32' ? 0.00001 : 0,
    expectedValues: plainValues,
    expectedBytes: encode(outputValues, dataType),
    semanticProgram: {
      language: 'wgsl',
      parser: 'strict-token-ast-v1',
      entryPoint,
      inputBinding: [inputGlobal.group, inputGlobal.binding],
      outputBinding: [outputGlobal.group, outputGlobal.binding],
      sourceDataType: dataType,
      selectedBody: program.entry.bodyTokens.map((token) => token.value).join(' '),
      workgroupSize,
      dispatchWorkgroups,
      invocationCount,
      outputWriteCount: written.size,
    },
  };
}

function semanticOracleImplementationBytes() {
  return Buffer.from(`export default ${webGpuSemanticOracleImplementation.toString()};\n`, 'utf8');
}

function semanticOracleCodeHash() {
  return sha256Bytes(semanticOracleImplementationBytes());
}

function webGpuRuntimeSessionId(trace) {
  const epochPageInstanceId = aliasedRuntimeText(
    trace?.after,
    'pageInstanceId',
    'page_instance_id',
    'WebGPU after-epoch page instance',
  );
  const tracePageInstanceId = aliasedRuntimeText(
    trace,
    'pageInstanceId',
    'page_instance_id',
    'WebGPU runtime page instance',
  );
  if (epochPageInstanceId && tracePageInstanceId && epochPageInstanceId !== tracePageInstanceId) {
    throw new Error('WebGPU runtime page instance evidence is ambiguous');
  }
  const pageInstanceId = epochPageInstanceId ?? tracePageInstanceId;
  if (!pageInstanceId) throw new Error('WebGPU semantic oracle requires an observed page instance id');
  return `webgpu-page:${pageInstanceId}`;
}

function canonicalRuntimeTraceBytes(trace) {
  return Buffer.from(stableJson(trace), 'utf8');
}

function canonicalRuntimeTraceHash(trace) {
  return sha256Bytes(canonicalRuntimeTraceBytes(trace));
}

async function persistCanonicalRuntimeTrace({ outDir, targetId, trace }) {
  const tracePath = path.join(outDir, `${safeSlug(targetId)}-canonical-runtime-trace.json`);
  const bytes = canonicalRuntimeTraceBytes(trace);
  const hash = sha256Bytes(bytes);
  await writeFile(tracePath, bytes);
  if (sha256Bytes(await readFile(tracePath)) !== hash) {
    throw new Error('WebGPU canonical runtime trace artifact changed after persistence');
  }
  return { path: tracePath, hash };
}

function webGpuCopiedResource(epochTrace) {
  const resourceTrace = aliasedValue(
    epochTrace,
    'resourceTrace',
    'resource_trace',
    'WebGPU epoch resource trace',
  );
  const copied = aliasedRuntimeArray(
    resourceTrace,
    'copiedResources',
    'copied_resources',
    'WebGPU copied-resource trace',
  );
  if (copied.length !== 1) {
    throw new Error(`WebGPU runtime trace must identify exactly one copied resource; found ${copied.length}`);
  }
  const selected = copied[0];
  if (
    !Number.isSafeInteger(selected?.group)
    || !Number.isSafeInteger(selected?.binding)
    || !aliasedRuntimeText(selected, 'resourceHash', 'resource_hash', 'WebGPU copied resource')
  ) {
    throw new Error('WebGPU copied-resource trace is incomplete');
  }
  return selected;
}

function deriveWebGpuObservedBinding({
  trace,
  traceArtifactHash,
  epochKey = 'after',
  observedReadbackHash = null,
}) {
  if (traceArtifactHash !== canonicalRuntimeTraceHash(trace)) {
    throw new Error('WebGPU runtime trace artifact hash does not match the observed trace bytes');
  }
  const epochTrace = trace?.[epochKey];
  if (!epochTrace || typeof epochTrace !== 'object') {
    throw new Error(`WebGPU runtime trace is missing ${epochKey} epoch facts`);
  }
  const resourceTrace = aliasedValue(
    epochTrace,
    'resourceTrace',
    'resource_trace',
    `WebGPU ${epochKey} resource trace`,
  );
  const copiedResource = webGpuCopiedResource(epochTrace);
  const matchingBuffers = firstArray(resourceTrace?.buffers).filter((resource) => (
    Number(resource?.group) === copiedResource.group
    && Number(resource?.binding) === copiedResource.binding
    && aliasedRuntimeText(resource, 'resourceHash', 'resource_hash', 'WebGPU traced buffer')
      === aliasedRuntimeText(copiedResource, 'resourceHash', 'resource_hash', 'WebGPU copied resource')
  ));
  if (matchingBuffers.length !== 1) {
    throw new Error(`WebGPU copied resource resolves to ${matchingBuffers.length} traced buffers`);
  }
  const adapterBackend = aliasedRuntimeText(trace?.adapterInfo, 'backend', 'backend', 'WebGPU adapter backend');
  const epochBackend = aliasedRuntimeText(epochTrace, 'backend', 'backend', 'WebGPU epoch backend');
  if (adapterBackend && epochBackend && adapterBackend !== epochBackend) {
    throw new Error('WebGPU runtime backend evidence is ambiguous');
  }
  const backend = adapterBackend ?? epochBackend;
  const dispatchId = aliasedRuntimeText(epochTrace, 'dispatchId', 'dispatch_id', 'WebGPU dispatch');
  const outputTargetId = aliasedRuntimeText(epochTrace, 'outputTargetId', 'output_target_id', 'WebGPU output target');
  const artifactAfterHash = aliasedRuntimeText(epochTrace, 'artifactHash', 'artifact_hash', 'WebGPU artifact');
  const pipelineStateHash = aliasedRuntimeText(epochTrace, 'pipelineStateHash', 'pipeline_state_hash', 'WebGPU pipeline state');
  const resourceTraceHash = sha256Text(stableJson(resourceTrace));
  const readbackBytes = aliasedRuntimeArray(epochTrace, 'readbackBytes', 'readback_bytes', 'WebGPU readback');
  const selectionEvidence = aliasedValue(
    trace,
    'webgpuSelection',
    'webgpu_selection',
    'WebGPU runtime selection evidence',
  );
  const selectionBindingHashes = webGpuSelectionBindingHashes(selectionEvidence);
  const boundReadbackHash = observedReadbackHash
    ?? (readbackBytes.length > 0
      ? sha256Bytes(Buffer.from(readbackBytes))
      : aliasedRuntimeText(matchingBuffers[0], 'initialBytesHash', 'initial_bytes_hash', 'WebGPU traced buffer bytes'));
  if (
    backend !== 'webgpu'
    || !dispatchId
    || !outputTargetId
    || !/^sha256:[0-9a-f]{64}$/u.test(artifactAfterHash ?? '')
    || !/^sha256:[0-9a-f]{64}$/u.test(pipelineStateHash ?? '')
    || !/^sha256:[0-9a-f]{64}$/u.test(boundReadbackHash ?? '')
  ) {
    throw new Error('WebGPU runtime trace is missing backend, dispatch, artifact, pipeline, output, or readback facts');
  }
  const outputResourceId = [
    `group:${copiedResource.group}`,
    `binding:${copiedResource.binding}`,
    `resource:${aliasedRuntimeText(copiedResource, 'resourceHash', 'resource_hash', 'WebGPU copied resource')}`,
  ].join(':');
  return {
    artifactAfterHash,
    outputTargetId,
    outputResourceId,
    backend,
    runtimeSessionId: webGpuRuntimeSessionId(trace),
    dispatchId,
    traceArtifactHash,
    pipelineStateHash,
    resourceTraceHash,
    observedReadbackHash: boundReadbackHash,
    ...selectionBindingHashes,
  };
}

function buildWebGpuSemanticOracleRequest({
  profile,
  runMode,
  trace,
  artifactSource = profile.afterSource,
  artifactSourceHash = profile.afterHash,
  artifactAfterHash = profile.afterHash,
  epochKey = 'after',
  traceArtifactHash = canonicalRuntimeTraceHash(trace),
  trustedOracleImplementationHash = semanticOracleCodeHash(),
  observedReadbackHash = null,
}) {
  const epochTrace = trace?.[epochKey];
  const resourceTrace = aliasedValue(
    epochTrace,
    'resourceTrace',
    'resource_trace',
    `WebGPU ${epochKey} resource trace`,
  );
  const copiedResource = webGpuCopiedResource(epochTrace);
  if (
    aliasedRuntimeText(epochTrace, 'compiledSourceHash', 'compiled_source_hash', 'WebGPU compiled source') !== artifactAfterHash
    || aliasedRuntimeText(epochTrace, 'entryPoint', 'entry_point', 'WebGPU entry point') !== profile.shader.entryPoint
    || aliasedRuntimeText(epochTrace, 'outputTargetId', 'output_target_id', 'WebGPU output target')
      !== profile.computeOracle.outputTarget.id
    || copiedResource.group !== profile.computeOracle.outputResource.group
    || copiedResource.binding !== profile.computeOracle.outputResource.binding
  ) {
    throw new Error('WebGPU runtime trace does not match the profile-declared shader or output identity');
  }
  const resources = firstArray(resourceTrace?.buffers).map((resource) => {
    const initialBytes = aliasedRuntimeArray(resource, 'initialBytes', 'initial_bytes', 'WebGPU resource bytes').map(Number);
    const resourceHash = aliasedRuntimeText(resource, 'resourceHash', 'resource_hash', 'WebGPU resource hash');
    return {
      group: Number(resource.group),
      binding: Number(resource.binding),
      dataType: aliasedRuntimeText(resource, 'dataType', 'data_type', 'WebGPU resource data type'),
      access: firstText(resource.access),
      readback: resource.readback === true,
      resourceHash,
      copiedByRuntime:
        Number(resource.group) === copiedResource.group
        && Number(resource.binding) === copiedResource.binding
        && resourceHash === aliasedRuntimeText(copiedResource, 'resourceHash', 'resource_hash', 'WebGPU copied resource'),
      resetBeforeDispatch: resource.resetBeforeDispatch === true,
      initialBytes,
      initialBytesHash: sha256Bytes(Buffer.from(initialBytes)),
    };
  });
  if (resources.filter((resource) => resource.copiedByRuntime).length !== 1) {
    throw new Error('WebGPU copied resource does not resolve uniquely in the runtime resource trace');
  }
  const observedBinding = deriveWebGpuObservedBinding({
    trace,
    traceArtifactHash,
    epochKey,
    observedReadbackHash: observedReadbackHash ?? (
      aliasedRuntimeArray(epochTrace, 'readbackBytes', 'readback_bytes', 'WebGPU readback').length === 0
        ? resources.find((resource) => resource.copiedByRuntime)?.initialBytesHash
        : null
    ),
  });
  if (observedBinding.artifactAfterHash !== artifactAfterHash) {
    throw new Error('WebGPU observed shader artifact does not match the requested source artifact');
  }
  if (
    observedBinding.outputTargetId !== profile.computeOracle.outputTarget.id
    || observedBinding.outputResourceId !== [
      `group:${profile.computeOracle.outputResource.group}`,
      `binding:${profile.computeOracle.outputResource.binding}`,
      `resource:${aliasedRuntimeText(copiedResource, 'resourceHash', 'resource_hash', 'WebGPU copied resource')}`,
    ].join(':')
  ) {
    throw new Error('WebGPU observed output identity does not match the profile declaration');
  }
  const artifactBindingHash = sha256Text(stableJson({
    sourceHash: artifactSourceHash,
    artifactAfterHash,
    entryPoint: profile.shader.entryPoint,
    pipelineStateHash: observedBinding.pipelineStateHash,
  }));
  const requestId = sha256Text(stableJson({
    backend: observedBinding.backend,
    runtimeSessionId: observedBinding.runtimeSessionId,
    dispatchId: observedBinding.dispatchId,
    traceArtifactHash: observedBinding.traceArtifactHash,
    artifactBindingHash,
    resourceTraceHash: observedBinding.resourceTraceHash,
  }));
  const binding = {
    projectId: profile.targetId,
    editId: runMode.edit_id,
    targetId: profile.targetId,
    requestId,
    artifactSourceHash,
    artifactBindingHash,
    ...observedBinding,
    trustedOracleImplementationHash,
  };
  return {
    schemaVersion: INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA,
    binding,
    artifact: {
      kind: 'wgsl',
      source: artifactSource,
      sourceHash: artifactSourceHash,
      entryPoint: profile.shader.entryPoint,
    },
    resources,
    dispatch: {
      id: observedBinding.dispatchId,
      epoch: epochTrace.epoch,
      workgroups: firstArray(epochTrace.dispatchWorkgroups).map(Number),
      resourceStateHash: resourceTrace?.resourceStateHash ?? null,
      resourceTrace,
      webgpuSelection: validateWebGpuSelectionEvidence(aliasedValue(
        trace,
        'webgpuSelection',
        'webgpu_selection',
        'WebGPU runtime selection evidence',
      )),
      outputResource: {
        group: copiedResource.group,
        binding: copiedResource.binding,
        resourceHash: aliasedRuntimeText(copiedResource, 'resourceHash', 'resource_hash', 'WebGPU copied resource'),
      },
      readbackSelection: profile.computeOracle.readbackSelection,
    },
  };
}

function validateSemanticOracleRequest(request) {
  if (request?.schemaVersion !== INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA) {
    throw new Error('WebGPU semantic oracle request schema is invalid');
  }
  if (request.binding?.backend !== 'webgpu') {
    throw new Error('WebGPU semantic oracle request backend binding is invalid');
  }
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    if (!firstText(request.binding?.[field])) {
      throw new Error(`WebGPU semantic oracle binding ${field} is missing`);
    }
  }
  for (const field of [
    'artifactAfterHash',
    'artifactSourceHash',
    'artifactBindingHash',
    'traceArtifactHash',
    'pipelineStateHash',
    'resourceTraceHash',
    'observedReadbackHash',
    'adapterRequestOptionsHash',
    'requestedAdapterSelectorHash',
    'observedAdapterInfoHash',
    'requiredDeviceFeaturesHash',
    'requiredDeviceLimitsHash',
    'deviceRequestDescriptorHash',
    'webGpuSelectionHash',
    'trustedOracleImplementationHash',
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(request.binding[field])) {
      throw new Error(`WebGPU semantic oracle binding ${field} is not a sha256 identity`);
    }
  }
  if (sha256Text(request.artifact?.source ?? '') !== request.artifact?.sourceHash) {
    throw new Error('WebGPU semantic oracle artifact source hash mismatch');
  }
  if (
    request.binding.targetId !== request.binding.projectId
    || request.binding.artifactSourceHash !== request.artifact.sourceHash
    || request.binding.artifactAfterHash !== request.artifact.sourceHash
  ) {
    throw new Error('WebGPU semantic oracle target/source/artifact identity mismatch');
  }
  const artifactBindingHash = sha256Text(stableJson({
    sourceHash: request.artifact.sourceHash,
    artifactAfterHash: request.binding.artifactAfterHash,
    entryPoint: request.artifact.entryPoint,
    pipelineStateHash: request.binding.pipelineStateHash,
  }));
  if (artifactBindingHash !== request.binding.artifactBindingHash) {
    throw new Error('WebGPU semantic oracle source-to-pipeline binding hash mismatch');
  }
  if (request.dispatch?.id !== request.binding.dispatchId) {
    throw new Error('WebGPU semantic oracle dispatch binding mismatch');
  }
  if (
    !request.dispatch?.resourceTrace
    || sha256Text(stableJson(request.dispatch.resourceTrace)) !== request.binding.resourceTraceHash
  ) {
    throw new Error('WebGPU semantic oracle embedded resource trace hash mismatch');
  }
  const selectionBindingHashes = request.dispatch?.webgpuSelection
    ? webGpuSelectionBindingHashes(request.dispatch.webgpuSelection)
    : null;
  if (
    !selectionBindingHashes
    || Object.entries(selectionBindingHashes).some(([field, hash]) => request.binding[field] !== hash)
  ) {
    throw new Error('WebGPU semantic oracle selection evidence hash mismatch');
  }
  if (!request.dispatch?.outputResource || typeof request.dispatch.outputResource !== 'object') {
    throw new Error('WebGPU semantic oracle copied output resource is missing');
  }
  if (!Array.isArray(request.resources) || request.resources.length === 0) {
    throw new Error('WebGPU semantic oracle observed resources are missing');
  }
  const keys = new Set();
  for (const resource of request.resources) {
    const key = `${resource.group}:${resource.binding}`;
    const declaredBytes = firstArray(resource.initialBytes);
    if (
      keys.has(key)
      || declaredBytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
      throw new Error('WebGPU semantic oracle resources must be uniquely addressed and byte-valued');
    }
    keys.add(key);
    const bytes = Buffer.from(declaredBytes);
    if (bytes.length === 0 || sha256Bytes(bytes) !== resource.initialBytesHash) {
      throw new Error(`WebGPU semantic oracle input bytes mismatch at ${resource.group}:${resource.binding}`);
    }
  }
  const copied = request.resources.filter((resource) => resource.copiedByRuntime === true);
  const requestedSelector = objectOrEmpty(request.dispatch?.readbackSelection?.requested);
  const resolvedSelector = objectOrEmpty(request.dispatch?.readbackSelection?.resolved);
  const expectedOutputResourceId = request.dispatch?.outputResource
    ? [
      `group:${request.dispatch.outputResource.group}`,
      `binding:${request.dispatch.outputResource.binding}`,
      `resource:${request.dispatch.outputResource.resourceHash}`,
    ].join(':')
    : null;
  const traceBuffers = firstArray(request.dispatch.resourceTrace.buffers);
  const tracedCopies = aliasedRuntimeArray(
    request.dispatch.resourceTrace,
    'copiedResources',
    'copied_resources',
    'WebGPU semantic resource copies',
  );
  const resourceTraceMatches = request.resources.every((resource) => {
    const candidates = traceBuffers.filter((candidate) => (
      Number(candidate?.group) === resource.group
      && Number(candidate?.binding) === resource.binding
      && aliasedRuntimeText(candidate, 'resourceHash', 'resource_hash', 'WebGPU semantic traced resource') === resource.resourceHash
      && aliasedRuntimeText(candidate, 'dataType', 'data_type', 'WebGPU semantic traced resource') === resource.dataType
      && firstText(candidate?.access) === resource.access
    ));
    return candidates.length === 1;
  });
  const expectedResolvedSelectorId = [
    `group:${request.dispatch.outputResource.group}`,
    `binding:${request.dispatch.outputResource.binding}`,
    `resource:${request.dispatch.outputResource.resourceHash}`,
  ].join(':');
  const requestedSelectorMatchesResolved = requestedSelector.mode === 'explicit'
    ? (
      requestedSelector.group === request.dispatch.outputResource.group
      && requestedSelector.binding === request.dispatch.outputResource.binding
      && requestedSelector.selectorId === `group:${requestedSelector.group}:binding:${requestedSelector.binding}`
      && requestedSelector.resolvedSelectorId === expectedResolvedSelectorId
    )
    : (
      requestedSelector.mode === 'implicit_unique'
      && requestedSelector.group === null
      && requestedSelector.binding === null
      && requestedSelector.selectorId === 'implicit:unique-readback-resource'
      && requestedSelector.resolvedSelectorId === expectedResolvedSelectorId
    );
  if (
    copied.length !== 1
    || tracedCopies.length !== 1
    || request.binding.outputResourceId !== expectedOutputResourceId
    || copied[0].group !== request.dispatch.outputResource.group
    || copied[0].binding !== request.dispatch.outputResource.binding
    || copied[0].resourceHash !== request.dispatch.outputResource.resourceHash
    || Number(tracedCopies[0]?.group) !== request.dispatch.outputResource.group
    || Number(tracedCopies[0]?.binding) !== request.dispatch.outputResource.binding
    || aliasedRuntimeText(tracedCopies[0], 'resourceHash', 'resource_hash', 'WebGPU semantic traced copy')
      !== request.dispatch.outputResource.resourceHash
    || resourceTraceMatches !== true
    || !firstText(requestedSelector.mode)
    || !firstText(requestedSelector.selectorId)
    || requestedSelectorMatchesResolved !== true
    || resolvedSelector.group !== request.dispatch.outputResource.group
    || resolvedSelector.binding !== request.dispatch.outputResource.binding
    || resolvedSelector.resourceHash !== request.dispatch.outputResource.resourceHash
    || resolvedSelector.selectorId !== expectedResolvedSelectorId
  ) {
    throw new Error('WebGPU semantic oracle copied-resource requested/resolved selection is ambiguous or mismatched');
  }
}

async function executeSemanticOracle(request, implementationBytes = semanticOracleImplementationBytes()) {
  validateSemanticOracleRequest(request);
  const implementationHash = sha256Bytes(implementationBytes);
  if (implementationHash !== request.binding.trustedOracleImplementationHash) {
    throw new Error('WebGPU semantic oracle implementation is not the trusted request-bound implementation');
  }
  const moduleUrl = `data:text/javascript;base64,${implementationBytes.toString('base64')}#${implementationHash.slice(-16)}`;
  const oracleModule = await import(moduleUrl);
  const result = await oracleModule.default(JSON.parse(JSON.stringify(request)));
  if (
    result?.schemaVersion !== INDEPENDENT_SEMANTIC_ORACLE_RESULT_SCHEMA
    || !Array.isArray(result.expectedValues)
    || !Array.isArray(result.expectedBytes)
    || result.expectedValues.length === 0
  ) {
    throw new Error('WebGPU semantic oracle returned an invalid result');
  }
  const expectedBytes = Buffer.from(result.expectedBytes);
  const canonicalBytes = encodeNumericValues(result.expectedValues, result.dataType);
  if (!expectedBytes.equals(canonicalBytes)) {
    throw new Error('WebGPU semantic oracle result bytes do not match its values');
  }
  const semanticRequestHash = sha256Text(stableJson(request));
  const bindingReceipt = {
    ...request.binding,
    semanticRequestHash,
    oracleImplementationHash: implementationHash,
  };
  return {
    ...result,
    implementationSchemaVersion: COMPUTE_SEMANTIC_ORACLE_IDENTITY_SCHEMA_VERSION,
    implementationHash,
    requestHash: semanticRequestHash,
    semanticRequestHash,
    bindingHash: sha256Text(stableJson(request.binding)),
    bindingReceipt,
    bindingReceiptHash: sha256Text(stableJson(bindingReceipt)),
    expectedRawHash: sha256Bytes(expectedBytes),
  };
}

async function verifyIndependentSemanticOracle({
  request,
  execution,
  observedBytes,
  observedBinding,
}) {
  const failures = [];
  try {
    validateSemanticOracleRequest(request);
  } catch (error) {
    failures.push(`semantic_oracle_request_validation_failed:${String(error?.message ?? error)}`);
  }
  const implementationHash = request?.binding?.trustedOracleImplementationHash ?? null;
  const verifierImplementationHash = independentTypedByteVerifierHash();
  const semanticRequestHash = sha256Text(stableJson(request));
  if (execution?.implementationHash !== implementationHash) {
    failures.push('semantic_oracle_implementation_hash_mismatch');
  }
  if (
    request?.binding?.trustedOracleImplementationHash !== implementationHash
    || execution?.bindingReceipt?.oracleImplementationHash !== implementationHash
  ) {
    failures.push('semantic_oracle_trusted_implementation_binding_mismatch');
  }
  if (
    execution?.requestHash !== semanticRequestHash
    || execution?.semanticRequestHash !== semanticRequestHash
    || execution?.bindingReceipt?.semanticRequestHash !== semanticRequestHash
  ) {
    failures.push('semantic_oracle_request_hash_mismatch');
  }
  for (const field of OBSERVED_RUNTIME_BINDING_FIELDS) {
    if (request?.binding?.[field] !== observedBinding?.[field]) {
      failures.push(`semantic_oracle_binding_${field}_mismatch`);
    }
  }
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    if (request?.binding?.[field] !== execution?.bindingReceipt?.[field]) {
      failures.push(`semantic_oracle_receipt_${field}_mismatch`);
    }
  }
  if (
    execution?.bindingReceiptHash !== sha256Text(stableJson(execution?.bindingReceipt))
    || SEMANTIC_ORACLE_RECEIPT_FIELDS.some((field) => !firstText(execution?.bindingReceipt?.[field]))
  ) failures.push('semantic_oracle_binding_receipt_invalid');
  if (implementationHash === verifierImplementationHash) {
    failures.push('semantic_oracle_shared_oracle_substitution');
  }
  let comparison = { matched: false, mismatches: [], failures: [] };
  try {
    comparison = verifyExactTypedReadback({
      observedBytes,
      expectedValues: execution?.expectedValues,
      expectedBytes: execution?.expectedBytes,
      expectedRawHash: execution?.expectedRawHash,
      dataType: execution?.dataType,
    });
    failures.push(...comparison.failures);
  } catch (error) {
    failures.push(`semantic_oracle_observed_output_verification_failed:${String(error?.message ?? error)}`);
  }
  if (comparison.matched !== true) failures.push('semantic_oracle_observed_output_mismatch');
  return {
    schemaVersion: 'synthi.gpu_hmr.independent_semantic_oracle_verification.v1',
    accepted: failures.length === 0,
    implementationHash,
    verifierSchemaVersion: INDEPENDENT_TYPED_BYTE_VERIFIER_SCHEMA,
    verifierImplementationHash,
    requestHash: semanticRequestHash,
    bindingHash: sha256Text(stableJson(request?.binding)),
    expectedRawHash: execution?.expectedRawHash ?? null,
    observedRawHash: sha256Bytes(Buffer.from(observedBytes)),
    mismatchCount: comparison.mismatches.length,
    maxAbsDelta: null,
    failures,
  };
}

function buildSemanticOracleIdentity(binding) {
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    if (!firstText(binding?.[field])) {
      throw new Error(`WebGPU semantic oracle identity is missing ${field}`);
    }
  }
  const identity = {
    schema_version: COMPUTE_SEMANTIC_ORACLE_IDENTITY_SCHEMA_VERSION,
    backend: binding.backend,
    project_id: binding.projectId,
    edit_id: binding.editId,
    target_id: binding.targetId,
    request_id: binding.requestId,
    runtime_session_id: binding.runtimeSessionId,
    dispatch_id: binding.dispatchId,
    output_target_id: binding.outputTargetId,
    output_resource_id: binding.outputResourceId,
    artifact_after_hash: binding.artifactAfterHash,
    artifact_source_hash: binding.artifactSourceHash,
    artifact_binding_hash: binding.artifactBindingHash,
    trace_artifact_hash: binding.traceArtifactHash,
    pipeline_state_hash: binding.pipelineStateHash,
    resource_trace_hash: binding.resourceTraceHash,
    observed_readback_hash: binding.observedReadbackHash,
    adapter_request_options_hash: binding.adapterRequestOptionsHash,
    requested_adapter_selector_hash: binding.requestedAdapterSelectorHash,
    observed_adapter_info_hash: binding.observedAdapterInfoHash,
    required_device_features_hash: binding.requiredDeviceFeaturesHash,
    required_device_limits_hash: binding.requiredDeviceLimitsHash,
    device_request_descriptor_hash: binding.deviceRequestDescriptorHash,
    webgpu_selection_hash: binding.webGpuSelectionHash,
    trusted_oracle_implementation_hash: binding.trustedOracleImplementationHash,
  };
  return {
    ...identity,
    identity_hash: sha256Text(stableJson(identity)),
  };
}

function semanticOracleIdentityVerified(identity, binding) {
  try {
    return stableJson(identity) === stableJson(buildSemanticOracleIdentity(binding));
  } catch {
    return false;
  }
}

function buildExpectedOutputContract({ semanticOracle }) {
  const { request, execution } = semanticOracle;
  return buildComputeExpectedOutputContract({
    comparisonMode: 'numeric_tolerance',
    dtype: execution.dataType,
    shape: execution.shape,
    elementCount: execution.elementCount,
    byteOrder: execution.byteOrder,
    tolerance: execution.tolerance,
    expectedValues: execution.expectedValues,
    binding: {
      projectId: request.binding.projectId,
      editId: request.binding.editId,
      artifactAfterHash: request.binding.artifactAfterHash,
      outputTargetId: request.binding.outputTargetId,
      oracleCodeHash: execution.implementationHash,
    },
    evidenceRefs: [
      request.artifact.sourceHash,
      execution.requestHash,
      execution.bindingHash,
      `runtime:webgpu-compute:semantic-oracle:${execution.implementationHash}`,
      ...request.resources.map((resource) => resource.initialBytesHash),
    ],
  });
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

function normalizeVisibilityTokens(rawVisibility, context, unsupported) {
  const rawTokens = Array.isArray(rawVisibility)
    ? rawVisibility
    : firstText(rawVisibility)
      ? String(rawVisibility).split(/[|,+\s]+/g)
      : [];
  const tokens = rawTokens
    .map((token) => String(token).trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    unsupported.push(`${context}_visibility_missing`);
    return [];
  }
  const allowed = new Set(['compute']);
  const invalid = tokens.filter((token) => !allowed.has(token));
  if (invalid.length > 0) {
    unsupported.push(`${context}_visibility_unsupported:${[...new Set(invalid)].join(',')}`);
  }
  return [...new Set(tokens.filter((token) => allowed.has(token)))].sort();
}

function normalizeComputeBufferResource(rawEntry, layoutEntry, context, unsupported) {
  const resource = objectOrEmpty(rawEntry.resource ?? rawEntry.bufferResource ?? rawEntry.buffer_resource);
  const layoutBuffer = objectOrEmpty(layoutEntry.buffer);
  const layoutType = firstText(layoutBuffer.type) ?? 'storage';
  const kind = firstText(resource.kind, resource.resourceKind, resource.resource_kind, resource.type)
    ?? (layoutType === 'uniform' ? 'uniform_buffer' : 'storage_buffer');
  const expectedKinds = layoutType === 'uniform'
    ? new Set(['uniform_buffer', 'uniform-buffer', 'uniformBuffer'])
    : new Set(['storage_buffer', 'storage-buffer', 'storageBuffer']);
  if (!expectedKinds.has(kind)) {
    unsupported.push(`${context}_resource_kind_unsupported:${kind}`);
  }
  const dataType = normalizeDataType(
    resource.dataType ?? resource.data_type ?? resource.typeName ?? resource.type_name,
    context,
    unsupported,
  );
  const values = normalizeNumericValues(
    resource.values ?? resource[dataType] ?? resource.float32 ?? resource.data,
    context,
    dataType,
    unsupported,
  );
  const access = firstText(resource.access, resource.accessMode, resource.access_mode)
    ?? (layoutType === 'read-only-storage' ? 'read_only' : layoutType === 'uniform' ? 'read_only' : 'read_write');
  const byteLength = values.length * byteWidthForDataType(dataType);
  const minBindingSize = nonNegativeIntegerOrNull(layoutBuffer.minBindingSize ?? layoutBuffer.min_binding_size) ?? 0;
  if (minBindingSize > 0 && byteLength < minBindingSize) {
    unsupported.push(`${context}_resource_smaller_than_min_binding_size`);
  }
  const normalized = {
    kind: layoutType === 'uniform' ? 'uniform_buffer' : 'storage_buffer',
    layoutType,
    dataType,
    access,
    values,
    byteLength,
    readback: rawEntry.readback === true || resource.readback === true,
    resetBeforeDispatch: rawEntry.resetBeforeDispatch === true
      || rawEntry.reset_before_dispatch === true
      || resource.resetBeforeDispatch === true
      || resource.reset_before_dispatch === true,
  };
  return {
    ...normalized,
    resourceHash: sha256Text(stableJson(normalized)),
  };
}

function normalizeComputeBindGroups(pipeline, unsupported) {
  const rawLayouts = Array.isArray(pipeline.bindGroupLayouts)
    ? pipeline.bindGroupLayouts
    : Array.isArray(pipeline.bind_group_layouts)
      ? pipeline.bind_group_layouts
      : [];
  const rawBindGroups = firstArray(pipeline.bindGroups, pipeline.bind_groups);
  if (rawLayouts.length === 0) unsupported.push('bind_group_layouts_missing');
  if (rawBindGroups.length === 0) unsupported.push('bind_groups_missing');

  const bindGroupLayouts = rawLayouts.map((rawLayout, layoutIndex) => {
    const layout = objectOrEmpty(rawLayout);
    const entries = firstArray(layout.entries).map((rawEntry, entryIndex) => {
      const entry = objectOrEmpty(rawEntry);
      const context = `bind_group_layout_${layoutIndex}_entry_${entryIndex}`;
      const binding = nonNegativeIntegerOrNull(entry.binding);
      if (binding === null) unsupported.push(`${context}_binding_missing`);
      const buffer = objectOrEmpty(entry.buffer);
      const type = firstText(buffer.type) ?? 'storage';
      if (!['uniform', 'storage', 'read-only-storage'].includes(type)) {
        unsupported.push(`${context}_buffer_type_unsupported:${type}`);
      }
      return {
        binding,
        visibility: normalizeVisibilityTokens(entry.visibility, context, unsupported),
        buffer: {
          type,
          minBindingSize: nonNegativeIntegerOrNull(buffer.minBindingSize ?? buffer.min_binding_size) ?? 0,
        },
      };
    });
    if (entries.length === 0) unsupported.push(`bind_group_layout_${layoutIndex}_entries_missing`);
    const duplicateBindings = entries
      .map((entry) => entry.binding)
      .filter((binding, index, all) => binding !== null && all.indexOf(binding) !== index);
    if (duplicateBindings.length > 0) {
      unsupported.push(`bind_group_layout_${layoutIndex}_duplicate_bindings:${[...new Set(duplicateBindings)].join(',')}`);
    }
    return {
      label: firstText(layout.label) ?? `compute-layout-${layoutIndex}`,
      entries,
    };
  });

  const bindGroups = rawBindGroups.map((rawGroup, groupIndex) => {
    const group = objectOrEmpty(rawGroup);
    const layoutIndex = nonNegativeIntegerOrNull(group.layoutIndex ?? group.layout_index) ?? groupIndex;
    const layout = bindGroupLayouts[layoutIndex];
    if (!layout) unsupported.push(`bind_group_${groupIndex}_layout_missing:${layoutIndex}`);
    const layoutEntries = new Map((layout?.entries ?? []).map((entry) => [entry.binding, entry]));
    const entries = firstArray(group.entries).map((rawEntry, entryIndex) => {
      const entry = objectOrEmpty(rawEntry);
      const binding = nonNegativeIntegerOrNull(entry.binding);
      const context = `bind_group_${groupIndex}_entry_${entryIndex}`;
      if (binding === null) unsupported.push(`${context}_binding_missing`);
      const layoutEntry = layoutEntries.get(binding);
      if (!layoutEntry) unsupported.push(`${context}_layout_entry_missing:${binding}`);
      const resource = normalizeComputeBufferResource(entry, layoutEntry ?? {}, context, unsupported);
      return {
        binding,
        resource,
      };
    });
    const layoutBindings = new Set((layout?.entries ?? []).map((entry) => entry.binding));
    const resourceBindings = new Set(entries.map((entry) => entry.binding));
    for (const binding of layoutBindings) {
      if (!resourceBindings.has(binding)) unsupported.push(`bind_group_${groupIndex}_resource_missing_for_binding:${binding}`);
    }
    return {
      layoutIndex,
      entries,
    };
  });

  const readbackResources = [];
  bindGroups.forEach((group, groupIndex) => {
    group.entries.forEach((entry) => {
      if (entry.resource.readback === true) {
        readbackResources.push({
          group: groupIndex,
          binding: entry.binding,
          byteLength: entry.resource.byteLength,
          dataType: entry.resource.dataType,
          resourceHash: entry.resource.resourceHash,
        });
      }
    });
  });
  if (readbackResources.length === 0) unsupported.push('readback_resource_missing');

  return { bindGroupLayouts, bindGroups, readbackResources };
}

function normalizeDispatch(rawDispatch, unsupported) {
  const source = Array.isArray(rawDispatch)
    ? rawDispatch
    : firstArray(rawDispatch?.workgroups, rawDispatch?.workgroupCounts, rawDispatch?.workgroup_counts);
  const values = (source.length > 0 ? source : [1, 1, 1]).map((value) => positiveIntegerOrNull(value));
  if (values.length < 1 || values.length > 3 || values.some((value) => value === null)) {
    unsupported.push('dispatch_workgroups_invalid');
  }
  return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
}

function normalizeComputePipeline(rawPipeline = {}, rawShader = {}) {
  const pipeline = objectOrEmpty(rawPipeline);
  const shader = objectOrEmpty(rawShader);
  const unsupported = [];
  const layout = firstText(pipeline.layout, pipeline.pipelineLayout, pipeline.pipeline_layout)
    ?? 'explicit-compute-profiled';
  if (layout !== 'explicit-compute-profiled') {
    unsupported.push('compute_pipeline_layout_not_explicit_profiled');
  }
  const shaderEntryPoint = aliasedRuntimeText(
    shader,
    'entryPoint',
    'entry_point',
    'WebGPU shader entry point',
  );
  const pipelineEntryPoint = aliasedRuntimeText(
    pipeline,
    'entryPoint',
    'entry_point',
    'WebGPU pipeline entry point',
  );
  const entryPoint = exclusiveDeclaredValue(
    shaderEntryPoint ?? undefined,
    pipelineEntryPoint ?? undefined,
    'WebGPU shader/pipeline entry point',
  );
  if (!entryPoint) throw new Error('WebGPU compute profile must declare a shader entry point');
  const bindGroups = normalizeComputeBindGroups(pipeline, unsupported);
  const dispatchWorkgroups = normalizeDispatch(
    pipeline.dispatchWorkgroups ?? pipeline.dispatch_workgroups ?? shader.dispatchWorkgroups ?? shader.dispatch_workgroups,
    unsupported,
  );
  if (unsupported.length > 0) {
    const error = new Error(`unsupported WebGPU compute profile pipeline: ${unsupported.join(',')}`);
    error.unsupportedReasons = unsupported;
    throw error;
  }
  const resourceStateHash = sha256Text(stableJson({
    bindGroupLayouts: bindGroups.bindGroupLayouts,
    bindGroups: bindGroups.bindGroups,
  }));
  const bindGroupLayoutHash = sha256Text(stableJson(bindGroups.bindGroupLayouts));
  const pipelineLayoutHash = sha256Text(stableJson({
    layout,
    bindGroupLayouts: bindGroups.bindGroupLayouts,
  }));
  const pipelineStateHash = sha256Text(stableJson({
    entryPoint,
    bindGroupLayoutHash,
    pipelineLayoutHash,
    resourceStateHash,
    dispatchWorkgroups,
  }));
  const dataTypes = [...new Set(bindGroups.bindGroups.flatMap((group) =>
    group.entries.map((entry) => entry.resource.dataType)
  ))].sort();
  const readbackDataTypes = [...new Set(bindGroups.readbackResources.map((resource) => resource.dataType))].sort();
  const scopeDataType = dataTypes.length === 1 ? dataTypes[0] : 'mixed-numeric';
  const readbackScope = readbackDataTypes.length === 1 ? readbackDataTypes[0] : 'mixed-numeric';
  const scopeSuffix = scopeDataType === readbackScope
    ? `${scopeDataType}-readback`
    : `${scopeDataType}-${readbackScope}-readback`;
  return {
    scope: `explicit-compute-profiled-layout-storage-uniform-${scopeSuffix}`,
    layout,
    entryPoint,
    bindGroupLayouts: bindGroups.bindGroupLayouts,
    bindGroups: bindGroups.bindGroups,
    readbackResources: bindGroups.readbackResources,
    dispatchWorkgroups,
    resourceStateHash,
    bindGroupLayoutHash,
    pipelineLayoutHash,
    pipelineStateHash,
    unsupportedReasons: [],
  };
}

function normalizeNegativeEdit(rawNegativeEdit = null) {
  if (!rawNegativeEdit || typeof rawNegativeEdit !== 'object' || Array.isArray(rawNegativeEdit)) return null;
  const pipelineCandidate = rawNegativeEdit.pipeline ?? rawNegativeEdit.pipeline_edit ?? rawNegativeEdit.pipelineEdit;
  if (!pipelineCandidate || typeof pipelineCandidate !== 'object' || Array.isArray(pipelineCandidate)) {
    throw new Error('negativeEdit.pipeline is required for WebGPU compute refusal proof');
  }
  let unsupportedReasons = [];
  try {
    normalizeComputePipeline(pipelineCandidate, rawNegativeEdit.shader ?? {});
  } catch (error) {
    unsupportedReasons = Array.isArray(error.unsupportedReasons)
      ? error.unsupportedReasons
      : [String(error.message || error)];
  }
  if (unsupportedReasons.length === 0) {
    throw new Error('negativeEdit.pipeline must be rejected by the WebGPU compute profile validator');
  }
  const declaredReasons = firstArray(
    rawNegativeEdit.reasons,
    rawNegativeEdit.unsupportedReasons,
    rawNegativeEdit.unsupported_reasons,
  );
  const editHash = sha256Text(stableJson({
    pipelineCandidate,
    unsupportedReasons,
    declaredReasons,
  }));
  return {
    editId: firstText(rawNegativeEdit.editId, rawNegativeEdit.edit_id)
      ?? `webgpu-compute-negative-edit:${editHash.replace(/^sha256:/, '').slice(0, 16)}`,
    editHash,
    reasons: [...new Set([
      ...unsupportedReasons,
      ...declaredReasons.map((reason) => firstText(reason)).filter(Boolean),
      'webgpu_compute_binding_abi_changed',
      'gpu_hmr_rejected_before_load',
    ])],
    pipeline: pipelineCandidate,
    claim: firstText(rawNegativeEdit.claim) ?? null,
  };
}

function candidateBrowserExecutables() {
  return [
    CFG.browserExecutable,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

function findBrowserExecutable() {
  return candidateBrowserExecutables().find((candidate) => existsSync(candidate)) ?? null;
}

function resolveWebGpuReadbackSelection({ oracle, pipeline }) {
  const hasExplicitSelector = Object.prototype.hasOwnProperty.call(oracle, 'readbackResource')
    || Object.prototype.hasOwnProperty.call(oracle, 'readback_resource');
  const selector = objectOrEmpty(oracle.readbackResource ?? oracle.readback_resource);
  let requested;
  let candidates;
  if (hasExplicitSelector) {
    const group = nonNegativeIntegerOrNull(selector.group);
    const binding = nonNegativeIntegerOrNull(selector.binding);
    if (group === null || binding === null) {
      throw new Error('explicit WebGPU readback selector must contain non-negative integer group and binding');
    }
    requested = {
      mode: 'explicit',
      group,
      binding,
      selectorId: `group:${group}:binding:${binding}`,
    };
    candidates = pipeline.readbackResources.filter((candidate) => (
      candidate.group === group && candidate.binding === binding
    ));
  } else {
    requested = {
      mode: 'implicit_unique',
      group: null,
      binding: null,
      selectorId: 'implicit:unique-readback-resource',
    };
    candidates = pipeline.readbackResources;
  }
  if (candidates.length !== 1) {
    throw new Error(`${hasExplicitSelector ? 'explicit' : 'implicit'} WebGPU readback selector resolved ${candidates.length} resources`);
  }
  const resource = candidates[0];
  const resolved = {
    group: resource.group,
    binding: resource.binding,
    resourceHash: resource.resourceHash,
    dataType: resource.dataType,
    byteLength: resource.byteLength,
    selectorId: `group:${resource.group}:binding:${resource.binding}:resource:${resource.resourceHash}`,
  };
  return {
    requested: { ...requested, resolvedSelectorId: resolved.selectorId },
    resolved,
    resource,
  };
}

function normalizeProfileOutputIdentity({ oracle, readbackSelection }) {
  const rawTarget = declaredObjectOrEmpty(aliasedValue(
    oracle,
    'outputTarget',
    'output_target',
    'WebGPU compute output target',
  ), 'WebGPU compute output target');
  const targetId = aliasedRuntimeText(
    rawTarget,
    'id',
    'id',
    'WebGPU compute output target',
  );
  if (!targetId) {
    throw new Error('WebGPU compute profile must declare computeOracle.outputTarget.id');
  }
  const rawResource = declaredObjectOrEmpty(aliasedValue(
    oracle,
    'outputResource',
    'output_resource',
    'WebGPU compute output resource',
  ), 'WebGPU compute output resource');
  const group = nonNegativeIntegerOrNull(rawResource.group);
  const binding = nonNegativeIntegerOrNull(rawResource.binding);
  if (group === null || binding === null) {
    throw new Error('WebGPU compute profile must declare computeOracle.outputResource group and binding');
  }
  if (
    group !== readbackSelection.resource.group
    || binding !== readbackSelection.resource.binding
  ) {
    throw new Error('WebGPU compute output resource must match the resolved readback resource');
  }
  return {
    target: { id: targetId },
    resource: { group, binding },
  };
}

function normalizeWebGpuSelectionContract(rawProfile, { requireDeclared = false } = {}) {
  const rawSelectionValue = aliasedValue(
    rawProfile,
    'webgpuSelection',
    'webgpu_selection',
    'WebGPU profile selection',
  );
  if (requireDeclared && rawSelectionValue === undefined) {
    throw new Error('WebGPU compute profile must declare webgpuSelection');
  }
  const rawSelection = declaredObjectOrEmpty(rawSelectionValue, 'WebGPU profile selection');
  if (
    requireDeclared
    && (!Object.prototype.hasOwnProperty.call(rawSelection, 'adapter')
      || !Object.prototype.hasOwnProperty.call(rawSelection, 'device'))
  ) {
    throw new Error('WebGPU compute profile must declare adapter and device selection contracts');
  }
  const rawAdapter = declaredObjectOrEmpty(rawSelection.adapter, 'WebGPU adapter selection');
  const rawDevice = declaredObjectOrEmpty(rawSelection.device, 'WebGPU device selection');
  const rawAdapterOptionsValue = exclusiveDeclaredValue(
    aliasedValue(rawAdapter, 'requestOptions', 'request_options', 'WebGPU adapter request'),
    aliasedValue(rawSelection, 'requestAdapterOptions', 'request_adapter_options', 'WebGPU adapter request'),
    'WebGPU adapter request',
  );
  if (requireDeclared && rawAdapterOptionsValue === undefined) {
    throw new Error('WebGPU compute profile must declare adapter request options');
  }
  const rawAdapterOptions = declaredObjectOrEmpty(rawAdapterOptionsValue, 'WebGPU adapter request options');
  const allowedAdapterOptionKeys = new Set([
    'powerPreference', 'power_preference',
    'featureLevel', 'feature_level',
    'forceFallbackAdapter', 'force_fallback_adapter',
    'xrCompatible', 'xr_compatible',
  ]);
  const unknownAdapterOption = Object.keys(rawAdapterOptions)
    .find((key) => !allowedAdapterOptionKeys.has(key));
  if (unknownAdapterOption) {
    throw new Error(`unsupported WebGPU requestAdapter option ${unknownAdapterOption}`);
  }
  const requestAdapterOptions = {};
  const powerPreference = aliasedValue(
    rawAdapterOptions,
    'powerPreference',
    'power_preference',
    'WebGPU requestAdapter power preference',
  );
  if (powerPreference !== undefined) {
    if (!['low-power', 'high-performance'].includes(powerPreference)) {
      throw new Error('WebGPU requestAdapter powerPreference must be low-power or high-performance');
    }
    requestAdapterOptions.powerPreference = powerPreference;
  }
  const featureLevel = aliasedValue(
    rawAdapterOptions,
    'featureLevel',
    'feature_level',
    'WebGPU requestAdapter feature level',
  );
  if (featureLevel !== undefined) {
    if (!['core', 'compatibility'].includes(featureLevel)) {
      throw new Error('WebGPU requestAdapter featureLevel must be core or compatibility');
    }
    requestAdapterOptions.featureLevel = featureLevel;
  }
  for (const [key, snakeKey] of [
    ['forceFallbackAdapter', 'force_fallback_adapter'],
    ['xrCompatible', 'xr_compatible'],
  ]) {
    const value = aliasedValue(rawAdapterOptions, key, snakeKey, `WebGPU requestAdapter ${key}`);
    if (value !== undefined) {
      if (typeof value !== 'boolean') {
        throw new Error(`WebGPU requestAdapter ${key} must be boolean`);
      }
      requestAdapterOptions[key] = value;
    }
  }

  const requiredAdapterInfo = declaredObjectOrEmpty(exclusiveDeclaredValue(
    aliasedValue(rawAdapter, 'requiredInfo', 'required_info', 'WebGPU adapter selector'),
    aliasedValue(rawSelection, 'requiredAdapterInfo', 'required_adapter_info', 'WebGPU adapter selector'),
    'WebGPU adapter selector',
  ), 'WebGPU required adapter info');
  const normalizedRequiredAdapterInfo = {};
  const adapterInfoAliases = new Map([
    ['subgroup_min_size', 'subgroupMinSize'],
    ['subgroup_max_size', 'subgroupMaxSize'],
    ['is_fallback_adapter', 'isFallbackAdapter'],
  ]);
  for (const [declaredKey, value] of Object.entries(requiredAdapterInfo)) {
    const key = adapterInfoAliases.get(declaredKey) ?? declaredKey;
    if (!WEBGPU_ADAPTER_INFO_FIELDS.includes(key)) {
      throw new Error(`unsupported observable WebGPU adapter selector ${key}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedRequiredAdapterInfo, key)
      && stableJson(normalizedRequiredAdapterInfo[key]) !== stableJson(value)
    ) {
      throw new Error(`WebGPU adapter selector aliases for ${key} conflict`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`WebGPU adapter selector ${key} must be a finite scalar`);
    }
    normalizedRequiredAdapterInfo[key] = value;
  }

  const rawDeviceDescriptorValue = exclusiveDeclaredValue(
    aliasedValue(rawDevice, 'requestDescriptor', 'request_descriptor', 'WebGPU device request'),
    aliasedValue(rawSelection, 'requestDeviceDescriptor', 'request_device_descriptor', 'WebGPU device request'),
    'WebGPU device request',
  );
  if (requireDeclared && rawDeviceDescriptorValue === undefined) {
    throw new Error('WebGPU compute profile must declare a device request descriptor');
  }
  const rawDeviceDescriptor = declaredObjectOrEmpty(rawDeviceDescriptorValue, 'WebGPU device request descriptor');
  const allowedDeviceDescriptorKeys = new Set([
    'label',
    'requiredFeatures', 'required_features',
    'requiredLimits', 'required_limits',
    'defaultQueue', 'default_queue',
  ]);
  const unknownDeviceMember = Object.keys(rawDeviceDescriptor)
    .find((key) => !allowedDeviceDescriptorKeys.has(key));
  if (unknownDeviceMember) {
    throw new Error(`unsupported WebGPU requestDevice descriptor member ${unknownDeviceMember}`);
  }
  const requestDeviceDescriptor = {};
  if (Object.prototype.hasOwnProperty.call(rawDeviceDescriptor, 'label')) {
    if (typeof rawDeviceDescriptor.label !== 'string') {
      throw new Error('WebGPU requestDevice label must be a string');
    }
    requestDeviceDescriptor.label = rawDeviceDescriptor.label;
  }
  const declaredRequiredFeatures = aliasedValue(
    rawDeviceDescriptor,
    'requiredFeatures',
    'required_features',
    'WebGPU requestDevice required features',
  );
  const requiredFeatures = declaredRequiredFeatures ?? [];
  if (!Array.isArray(requiredFeatures) || requiredFeatures.some((value) => typeof value !== 'string' || !value)) {
    throw new Error('WebGPU requestDevice requiredFeatures must be non-empty strings');
  }
  if (new Set(requiredFeatures).size !== requiredFeatures.length) {
    throw new Error('WebGPU requestDevice requiredFeatures must be unique');
  }
  if (declaredRequiredFeatures !== undefined) {
    requestDeviceDescriptor.requiredFeatures = [...requiredFeatures];
  }
  const declaredRequiredLimits = aliasedValue(
    rawDeviceDescriptor,
    'requiredLimits',
    'required_limits',
    'WebGPU requestDevice required limits',
  );
  const requiredLimits = declaredRequiredLimits ?? {};
  if (!requiredLimits || typeof requiredLimits !== 'object' || Array.isArray(requiredLimits)) {
    throw new Error('WebGPU requestDevice requiredLimits must be an object');
  }
  for (const [key, value] of Object.entries(requiredLimits)) {
    if (!key || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`WebGPU requestDevice required limit ${key || '<empty>'} must be a non-negative safe integer`);
    }
  }
  if (declaredRequiredLimits !== undefined) {
    requestDeviceDescriptor.requiredLimits = { ...requiredLimits };
  }
  const declaredDefaultQueue = aliasedValue(
    rawDeviceDescriptor,
    'defaultQueue',
    'default_queue',
    'WebGPU requestDevice default queue',
  );
  if (declaredDefaultQueue !== undefined) {
    const defaultQueue = declaredObjectOrEmpty(declaredDefaultQueue, 'WebGPU defaultQueue descriptor');
    const unknownQueueMember = Object.keys(defaultQueue).find((key) => key !== 'label');
    if (unknownQueueMember || (defaultQueue.label !== undefined && typeof defaultQueue.label !== 'string')) {
      throw new Error(`unsupported WebGPU defaultQueue descriptor member ${unknownQueueMember ?? 'label'}`);
    }
    requestDeviceDescriptor.defaultQueue = defaultQueue.label === undefined ? {} : { label: defaultQueue.label };
  }
  return {
    schemaVersion: WEBGPU_SELECTION_CONTRACT_SCHEMA,
    requestAdapterOptions,
    requestedAdapterSelector: { requiredInfo: normalizedRequiredAdapterInfo },
    requestDeviceDescriptor,
  };
}

function validateWebGpuSelectionEvidence(evidence) {
  assertCamelSnakeAliasesUnambiguous(evidence, 'WebGPU runtime selection evidence');
  if (evidence?.schemaVersion !== WEBGPU_SELECTION_CONTRACT_SCHEMA) {
    throw new Error('WebGPU runtime selection evidence schema is invalid');
  }
  const requestAdapterOptions = objectOrEmpty(evidence.requestAdapterOptions);
  const requestedAdapterSelector = objectOrEmpty(evidence.requestedAdapterSelector);
  const requiredInfo = objectOrEmpty(requestedAdapterSelector.requiredInfo);
  const observedAdapterInfo = evidence.observedAdapterInfo;
  const normalizedContract = normalizeWebGpuSelectionContract({
    webgpuSelection: {
      requestAdapterOptions,
      requiredAdapterInfo: requiredInfo,
      requestDeviceDescriptor: evidence.requestDeviceDescriptor,
    },
  });
  if (stableJson({
    schemaVersion: evidence.schemaVersion,
    requestAdapterOptions,
    requestedAdapterSelector,
    requestDeviceDescriptor: evidence.requestDeviceDescriptor,
  }) !== stableJson(normalizedContract)) {
    throw new Error('WebGPU runtime selection evidence does not match the typed request contract');
  }
  if (observedAdapterInfo !== null && (
    !observedAdapterInfo
    || typeof observedAdapterInfo !== 'object'
    || Array.isArray(observedAdapterInfo)
  )) {
    throw new Error('WebGPU observed adapter info must be an object or null');
  }
  for (const [key, value] of Object.entries(observedAdapterInfo ?? {})) {
    if (
      !WEBGPU_ADAPTER_INFO_FIELDS.includes(key)
      || !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`WebGPU observed adapter info field ${key} is invalid`);
    }
  }
  for (const [key, expected] of Object.entries(requiredInfo)) {
    if (!WEBGPU_ADAPTER_INFO_FIELDS.includes(key)) {
      throw new Error(`WebGPU runtime adapter selector ${key} is unsupported`);
    }
    if (!observedAdapterInfo || !Object.prototype.hasOwnProperty.call(observedAdapterInfo, key)) {
      throw new Error(`required WebGPU adapter selector ${key} is not observable`);
    }
    if (stableJson(observedAdapterInfo[key]) !== stableJson(expected)) {
      throw new Error(`required WebGPU adapter selector ${key} was not satisfied`);
    }
  }
  const descriptor = objectOrEmpty(evidence.requestDeviceDescriptor);
  const requiredFeatures = descriptor.requiredFeatures ?? [];
  const requiredLimits = descriptor.requiredLimits ?? {};
  const adapterFeatures = new Set(evidence.adapterCapabilities?.features ?? []);
  const deviceFeatures = new Set(evidence.deviceCapabilities?.features ?? []);
  if (
    !Array.isArray(evidence.adapterCapabilities?.features)
    || !Array.isArray(evidence.deviceCapabilities?.features)
    || [...adapterFeatures, ...deviceFeatures].some((feature) => typeof feature !== 'string' || !feature)
    || adapterFeatures.size !== evidence.adapterCapabilities.features.length
    || deviceFeatures.size !== evidence.deviceCapabilities.features.length
  ) {
    throw new Error('WebGPU runtime feature evidence must contain feature-name strings');
  }
  for (const feature of requiredFeatures) {
    if (!adapterFeatures.has(feature) || !deviceFeatures.has(feature)) {
      throw new Error(`required WebGPU device feature ${feature} was not satisfied`);
    }
  }
  const lowerIsBetterLimits = new Set([
    'minUniformBufferOffsetAlignment',
    'minStorageBufferOffsetAlignment',
  ]);
  for (const [key, requested] of Object.entries(requiredLimits)) {
    const adapterLimit = evidence.adapterCapabilities?.limits?.[key];
    const deviceLimit = evidence.deviceCapabilities?.limits?.[key];
    if (!Number.isFinite(adapterLimit)) {
      throw new Error(`required WebGPU adapter limit ${key} is not observable`);
    }
    if (!Number.isFinite(deviceLimit)) {
      throw new Error(`required WebGPU device limit ${key} is not observable`);
    }
    const satisfied = lowerIsBetterLimits.has(key)
      ? adapterLimit <= requested && deviceLimit <= requested
      : adapterLimit >= requested && deviceLimit >= requested;
    if (!satisfied) throw new Error(`required WebGPU device limit ${key} was not satisfied`);
  }
  if (evidence.selectorSatisfied !== true) {
    throw new Error('WebGPU runtime selection evidence is not satisfied');
  }
  return {
    ...evidence,
    requestAdapterOptions,
    requestedAdapterSelector,
    requestDeviceDescriptor: descriptor,
  };
}

function webGpuSelectionHash(evidence) {
  return sha256Text(stableJson(validateWebGpuSelectionEvidence(evidence)));
}

function webGpuSelectionBindingHashes(evidence) {
  const validated = validateWebGpuSelectionEvidence(evidence);
  const descriptor = validated.requestDeviceDescriptor;
  return {
    adapterRequestOptionsHash: sha256Text(stableJson(validated.requestAdapterOptions)),
    requestedAdapterSelectorHash: sha256Text(stableJson(validated.requestedAdapterSelector)),
    observedAdapterInfoHash: sha256Text(stableJson(validated.observedAdapterInfo ?? null)),
    requiredDeviceFeaturesHash: sha256Text(stableJson(descriptor.requiredFeatures ?? [])),
    requiredDeviceLimitsHash: sha256Text(stableJson(descriptor.requiredLimits ?? {})),
    deviceRequestDescriptorHash: sha256Text(stableJson(descriptor)),
    webGpuSelectionHash: sha256Text(stableJson(validated)),
  };
}

function normalizeProfileTargetId(rawProfile) {
  const targetId = aliasedRuntimeText(
    rawProfile,
    'targetId',
    'target_id',
    'WebGPU profile target ID',
  );
  if (!targetId) throw new Error('WebGPU compute profile must declare targetId');
  return targetId;
}

async function loadProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const profileDir = path.dirname(resolvedPath);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  assertCamelSnakeAliasesUnambiguous(raw);
  const shader = objectOrEmpty(raw.shader);
  const beforePath = resolveRelative(profileDir, aliasedRuntimeText(
    shader,
    'beforePath',
    'before_path',
    'WebGPU shader before path',
  ));
  const afterPath = resolveRelative(profileDir, aliasedRuntimeText(
    shader,
    'afterPath',
    'after_path',
    'WebGPU shader after path',
  ));
  if (!beforePath || !afterPath) throw new Error('profile shader.beforePath and shader.afterPath are required');
  const [beforeSource, afterSource, beforeHash, afterHash] = await Promise.all([
    readFile(beforePath, 'utf8'),
    readFile(afterPath, 'utf8'),
    sha256File(beforePath),
    sha256File(afterPath),
  ]);
  const pipeline = normalizeComputePipeline(raw.pipeline, shader);
  const negativeEdit = normalizeNegativeEdit(aliasedValue(
    raw,
    'negativeEdit',
    'negative_edit',
    'WebGPU negative edit',
  ));
  const targetId = normalizeProfileTargetId(raw);
  const rawOracle = aliasedValue(raw, 'computeOracle', 'compute_oracle', 'WebGPU compute oracle');
  if (rawOracle === undefined) throw new Error('WebGPU compute profile must declare computeOracle');
  const oracle = declaredObjectOrEmpty(rawOracle, 'WebGPU compute oracle');
  const readbackSelection = resolveWebGpuReadbackSelection({ oracle, pipeline });
  const outputIdentity = normalizeProfileOutputIdentity({ oracle, readbackSelection });
  const webgpuSelection = normalizeWebGpuSelectionContract(raw, { requireDeclared: true });
  const readbackResource = readbackSelection.resource;
  const deterministicSliceRaw = objectOrEmpty(oracle.deterministicSlice ?? oracle.deterministic_slice);
  const sliceOffset = nonNegativeIntegerOrNull(deterministicSliceRaw.offset ?? deterministicSliceRaw.byte_offset) ?? 0;
  const sliceLength = positiveIntegerOrNull(deterministicSliceRaw.length ?? deterministicSliceRaw.byte_length)
    ?? Math.min(32, readbackResource.byteLength);
  const expectedOutput = objectOrEmpty(oracle.expectedOutput ?? oracle.expected_output);
  const expectedAfterValues = finiteNumberArrayOrNull(firstArray(
    expectedOutput.values,
    expectedOutput.afterValues,
    expectedOutput.after_values,
    oracle.expectedAfterValues,
    oracle.expected_after_values,
    oracle.expectedValues,
    oracle.expected_values,
  ));
  const floatTolerance = Math.max(0, finiteNumber(
    expectedOutput.tolerance ?? expectedOutput.floatTolerance ?? expectedOutput.float_tolerance
      ?? oracle.floatTolerance ?? oracle.float_tolerance,
    0.00001,
  ));
  const expectedOutputHintDataType = normalizeDataType(
    firstText(expectedOutput.dataType, expectedOutput.data_type) ?? readbackResource.dataType,
    'compute_oracle_expected_output',
  );
  const normalizedExpectedAfterValues = expectedAfterValues
    ? normalizeNumericValues(expectedAfterValues, 'compute_oracle_expected_output_hint', readbackResource.dataType)
    : null;
  return {
    raw,
    schemaVersion: firstText(raw.schemaVersion, raw.schema_version) ?? 'synthi.gpu.hmr.webgpu_compute_profile.v1',
    id: firstText(raw.id) ?? targetId,
    targetId,
    projectName: firstText(raw.project?.name, raw.name) ?? targetId,
    projectKind: firstText(raw.project?.kind, raw.project_kind) ?? 'gpu_project',
    profilePath: resolvedPath,
    profileHash: sha256Text(stableJson(raw)),
    beforePath,
    afterPath,
    beforeSource,
    afterSource,
    beforeHash,
    afterHash,
    shader: {
      artifactKind: firstText(shader.artifactKind, shader.artifact_kind) ?? 'wgsl',
      entryPoint: pipeline.entryPoint,
    },
    pipeline,
    webgpuSelection,
    negativeEdit,
    computeOracle: {
      claim: firstText(oracle.claim) ?? 'WebGPU compute output changes after the epoch dispatch.',
      outputTarget: outputIdentity.target,
      outputResource: outputIdentity.resource,
      readbackResource,
      readbackSelection: {
        requested: readbackSelection.requested,
        resolved: readbackSelection.resolved,
      },
      expectedOutputChange: oracle.expectedOutputChange !== false && oracle.expected_output_change !== false,
      expectedOutput: {
        dataType: readbackResource.dataType,
        values: normalizedExpectedAfterValues,
        tolerance: floatTolerance,
        required: true,
        profileHintDataType: expectedOutputHintDataType,
        profileHintRequired: expectedOutput.required !== false && oracle.expected_output_required !== false,
      },
      deterministicSlice: {
        offset: sliceOffset,
        length: Math.min(sliceLength, readbackResource.byteLength - sliceOffset),
      },
    },
  };
}

function startServer() {
  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>WebGPU Compute Proof</title></head>',
    '<body><main id="root">WebGPU compute proof runtime</main></body></html>',
  ].join('');
  const server = createServer((_, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
    });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

async function browserProcessIdentity(browser) {
  const childProcess = typeof browser.process === 'function' ? browser.process() : null;
  if (childProcess?.pid) {
    return {
      processId: String(childProcess.pid),
      source: 'playwright_browser_process',
      browserPid: String(childProcess.pid),
    };
  }
  if (typeof browser.newBrowserCDPSession === 'function') {
    try {
      const session = await browser.newBrowserCDPSession();
      const processInfo = await session.send('SystemInfo.getProcessInfo');
      await session.detach().catch(() => {});
      const browserProcess = Array.isArray(processInfo.processInfo)
        ? processInfo.processInfo.find((entry) => entry.type === 'browser')
          ?? processInfo.processInfo.find((entry) => entry.id)
        : null;
      if (browserProcess?.id) {
        return {
          processId: `chrome-process-${browserProcess.id}`,
          source: 'cdp_SystemInfo.getProcessInfo',
          browserPid: String(browserProcess.id),
          processType: browserProcess.type ?? null,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function runBrowserCompute(profile) {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('No Chrome/Edge/Chromium executable found for WebGPU compute proof');
  const runtime = await startServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: WEBGPU_LAUNCH_ARGS,
    });
    const processIdentityBefore = await browserProcessIdentity(browser);
    const page = await browser.newPage();
    await page.goto(runtime.url, { waitUntil: 'domcontentloaded', timeout: CFG.timeoutMs });
    const trace = await page.evaluate(async ({ profileForPage, beforeSource, afterSource }) => {
      const perfOrigin = performance.now();
      const apiTrace = [];
      const markApi = (name, detail = {}) => {
        apiTrace.push({ name, detail, t: performance.now() - perfOrigin });
      };
      if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
      const selectionContract = profileForPage.webgpuSelection;
      const requestAdapterOptions = { ...selectionContract.requestAdapterOptions };
      const requestDeviceDescriptor = {
        ...selectionContract.requestDeviceDescriptor,
        requiredFeatures: selectionContract.requestDeviceDescriptor.requiredFeatures
          ? [...selectionContract.requestDeviceDescriptor.requiredFeatures]
          : undefined,
        requiredLimits: selectionContract.requestDeviceDescriptor.requiredLimits
          ? { ...selectionContract.requestDeviceDescriptor.requiredLimits }
          : undefined,
        defaultQueue: selectionContract.requestDeviceDescriptor.defaultQueue
          ? { ...selectionContract.requestDeviceDescriptor.defaultQueue }
          : undefined,
      };
      for (const key of ['requiredFeatures', 'requiredLimits', 'defaultQueue']) {
        if (requestDeviceDescriptor[key] === undefined) delete requestDeviceDescriptor[key];
      }
      const adapter = await navigator.gpu.requestAdapter(requestAdapterOptions);
      markApi('requestAdapter', { options: requestAdapterOptions });
      if (!adapter) throw new Error('WebGPU requestAdapter returned null');
      const adapterFeatures = [...adapter.features].sort();
      const adapterLimits = Object.fromEntries(
        Object.entries(adapter.limits ?? {}).map(([key, value]) => [key, Number(value)]),
      );
      const exposedInfo = adapter.info && typeof adapter.info === 'object' ? adapter.info : null;
      const observedAdapterInfo = exposedInfo
        ? Object.fromEntries([
          'vendor',
          'architecture',
          'device',
          'description',
          'subgroupMinSize',
          'subgroupMaxSize',
          'isFallbackAdapter',
        ].filter((key) => exposedInfo[key] !== undefined).map((key) => [key, exposedInfo[key]]))
        : null;
      for (const [key, expected] of Object.entries(
        selectionContract.requestedAdapterSelector.requiredInfo,
      )) {
        if (!observedAdapterInfo || !Object.prototype.hasOwnProperty.call(observedAdapterInfo, key)) {
          throw new Error(`required WebGPU adapter selector ${key} is not observable`);
        }
        if (JSON.stringify(observedAdapterInfo[key]) !== JSON.stringify(expected)) {
          throw new Error(`required WebGPU adapter selector ${key} was not satisfied`);
        }
      }
      for (const feature of requestDeviceDescriptor.requiredFeatures ?? []) {
        if (!adapter.features.has(feature)) {
          throw new Error(`required WebGPU device feature ${feature} is not supported by the adapter`);
        }
      }
      for (const key of Object.keys(requestDeviceDescriptor.requiredLimits ?? {})) {
        if (!Number.isFinite(Number(adapter.limits?.[key]))) {
          throw new Error(`required WebGPU device limit ${key} is not exposed by the adapter`);
        }
      }
      const device = await adapter.requestDevice(requestDeviceDescriptor);
      markApi('requestDevice', { descriptor: requestDeviceDescriptor });
      const deviceFeatures = [...device.features].sort();
      const deviceLimits = Object.fromEntries(
        Object.entries(device.limits ?? {}).map(([key, value]) => [key, Number(value)]),
      );
      const pageInstanceId = crypto.randomUUID();
      const shaderStage = GPUShaderStage.COMPUTE;
      const sha256 = async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      };
      const bufferUsageForType = (type, readback) => {
        if (type === 'uniform') return GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
        if (readback) usage |= GPUBufferUsage.COPY_SRC;
        return usage;
      };
      const makeNumericBytes = (values, dataType) => {
        const buffer = new ArrayBuffer(values.length * 4);
        const view = new DataView(buffer);
        values.forEach((value, index) => {
          const offset = index * 4;
          if (dataType === 'float32') view.setFloat32(offset, Number(value), true);
          else if (dataType === 'uint32') view.setUint32(offset, Number(value), true);
          else if (dataType === 'int32') view.setInt32(offset, Number(value), true);
          else throw new Error(`unsupported numeric resource data type: ${dataType}`);
        });
        return new Uint8Array(buffer);
      };
      const bindGroupLayouts = profileForPage.pipeline.bindGroupLayouts.map((layout, layoutIndex) => {
        markApi('createBindGroupLayout', { layoutIndex });
        return device.createBindGroupLayout({
          label: layout.label,
          entries: layout.entries.map((entry) => ({
            binding: entry.binding,
            visibility: shaderStage,
            buffer: {
              type: entry.buffer.type,
              minBindingSize: entry.buffer.minBindingSize,
            },
          })),
        });
      });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts });
      markApi('createPipelineLayout');
      const resourceTable = new Map();
      const bindGroups = profileForPage.pipeline.bindGroups.map((group, groupIndex) => {
        const entries = group.entries.map((entry) => {
          const resource = entry.resource;
          const bytes = makeNumericBytes(resource.values, resource.dataType);
          const buffer = device.createBuffer({
            label: `compute-buffer-g${groupIndex}-b${entry.binding}`,
            size: bytes.byteLength,
            usage: bufferUsageForType(resource.layoutType, resource.readback),
          });
          markApi('createBuffer', { groupIndex, binding: entry.binding, byteLength: bytes.byteLength });
          device.queue.writeBuffer(buffer, 0, bytes);
          markApi('queueWriteBuffer', { groupIndex, binding: entry.binding, byteLength: bytes.byteLength });
          resourceTable.set(`${groupIndex}:${entry.binding}`, {
            groupIndex,
            binding: entry.binding,
            resource,
            buffer,
            initialBytes: bytes,
          });
          return {
            binding: entry.binding,
            resource: { buffer },
          };
        });
        markApi('createBindGroup', { groupIndex });
        return device.createBindGroup({
          layout: bindGroupLayouts[group.layoutIndex],
          entries,
        });
      });
      const readbackKey = `${profileForPage.computeOracle.readbackResource.group}:${profileForPage.computeOracle.readbackResource.binding}`;
      const readbackResource = resourceTable.get(readbackKey);
      if (!readbackResource) throw new Error(`declared readback resource not found: ${readbackKey}`);
      const readbackBuffer = device.createBuffer({
        label: 'compute-proof-readback-buffer',
        size: readbackResource.resource.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      markApi('createBuffer', { readback: true, byteLength: readbackResource.resource.byteLength });
      let epochCounter = 0;
      let pipelineCounter = 0;
      async function dispatchEpoch(source, artifactHash) {
        epochCounter += 1;
        const epoch = `webgpu-compute-epoch-${epochCounter}`;
        const compiledSourceHash = await sha256(new TextEncoder().encode(source));
        if (compiledSourceHash !== artifactHash) {
          throw new Error(`WGSL source changed before createShaderModule: expected ${artifactHash}, observed ${compiledSourceHash}`);
        }
        const shaderModule = device.createShaderModule({ code: source });
        markApi('createShaderModule', { epoch, artifactHash, compiledSourceHash });
        const pipeline = device.createComputePipeline({
          label: `compute-proof-pipeline-${epochCounter}`,
          layout: pipelineLayout,
          compute: {
            module: shaderModule,
            entryPoint: profileForPage.shader.entryPoint,
          },
        });
        pipelineCounter += 1;
        markApi('createComputePipeline', { epoch, artifactHash });
        for (const item of resourceTable.values()) {
          if (item.resource.resetBeforeDispatch) {
            device.queue.writeBuffer(item.buffer, 0, item.initialBytes);
            markApi('queueWriteBuffer', {
              reset: true,
              groupIndex: item.groupIndex,
              binding: item.binding,
              byteLength: item.initialBytes.byteLength,
            });
          }
        }
        const dispatchId = `webgpu-compute-dispatch-${epochCounter}`;
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass({ label: `compute-proof-pass-${epochCounter}` });
        pass.setPipeline(pipeline);
        bindGroups.forEach((bindGroup, groupIndex) => {
          pass.setBindGroup(groupIndex, bindGroup);
          markApi('setBindGroup', { epoch, groupIndex });
        });
        pass.dispatchWorkgroups(
          profileForPage.pipeline.dispatchWorkgroups[0],
          profileForPage.pipeline.dispatchWorkgroups[1],
          profileForPage.pipeline.dispatchWorkgroups[2],
        );
        markApi('dispatchWorkgroups', { epoch, dispatchId });
        pass.end();
        encoder.copyBufferToBuffer(
          readbackResource.buffer,
          0,
          readbackBuffer,
          0,
          readbackResource.resource.byteLength,
        );
        const copiedResource = {
          group: readbackResource.groupIndex,
          binding: readbackResource.binding,
          resourceHash: readbackResource.resource.resourceHash,
          dataType: readbackResource.resource.dataType,
          byteLength: readbackResource.resource.byteLength,
        };
        markApi('copyBufferToBuffer', {
          epoch,
          sourceGroup: copiedResource.group,
          sourceBinding: copiedResource.binding,
          sourceResourceHash: copiedResource.resourceHash,
          byteLength: copiedResource.byteLength,
        });
        device.queue.submit([encoder.finish()]);
        markApi('queueSubmit', { epoch });
        await device.queue.onSubmittedWorkDone();
        markApi('queueOnSubmittedWorkDone', { epoch });
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        markApi('mapAsync', { epoch });
        const mapped = new Uint8Array(readbackBuffer.getMappedRange()).slice();
        readbackBuffer.unmap();
        markApi('unmap', { epoch });
        return {
          epoch,
          dispatchId,
          artifactHash,
          compiledSourceHash,
          backend: 'webgpu',
          entryPoint: profileForPage.shader.entryPoint,
          pipelineStateHash: profileForPage.pipeline.pipelineStateHash,
          outputTargetId: profileForPage.computeOracle.outputTarget.id,
          output_target_id: profileForPage.computeOracle.outputTarget.id,
          shaderModuleId: `webgpu-compute-shader-module-${epochCounter}-${artifactHash.slice(-12)}`,
          pipelineId: `webgpu-compute-pipeline-${pipelineCounter}-${artifactHash.slice(-12)}`,
          pageInstanceId,
          readbackBytes: Array.from(mapped),
          dispatchWorkgroups: profileForPage.pipeline.dispatchWorkgroups,
          resourceTrace: {
            resourceStateHash: profileForPage.pipeline.resourceStateHash,
            bindGroupLayoutCount: profileForPage.pipeline.bindGroupLayouts.length,
            bindGroupCount: profileForPage.pipeline.bindGroups.length,
            readbackResource: profileForPage.computeOracle.readbackResource,
            readbackSelection: profileForPage.computeOracle.readbackSelection,
            copiedResources: [copiedResource],
            buffers: [...resourceTable.values()].map((item) => ({
              group: item.groupIndex,
              binding: item.binding,
              layoutType: item.resource.layoutType,
              dataType: item.resource.dataType,
              access: item.resource.access,
              byteLength: item.resource.byteLength,
              readback: item.resource.readback,
              resetBeforeDispatch: item.resource.resetBeforeDispatch,
              resourceHash: item.resource.resourceHash,
              initialBytes: Array.from(item.initialBytes),
            })),
          },
        };
      }
      const webgpuSelection = {
        schemaVersion: selectionContract.schemaVersion,
        requestAdapterOptions,
        requestedAdapterSelector: selectionContract.requestedAdapterSelector,
        observedAdapterInfo,
        adapterCapabilities: { features: adapterFeatures, limits: adapterLimits },
        requestDeviceDescriptor,
        deviceCapabilities: { features: deviceFeatures, limits: deviceLimits },
        selectorSatisfied: true,
      };
      const adapterInfo = {
        backend: 'webgpu',
        observed: observedAdapterInfo,
        features: adapterFeatures,
        limits: adapterLimits,
      };
      const before = await dispatchEpoch(beforeSource, profileForPage.beforeHash);
      const after = await dispatchEpoch(afterSource, profileForPage.afterHash);
      return {
        url: location.href,
        adapterInfo,
        webgpuSelection,
        pageInstanceId,
        before,
        after,
        apiTrace,
      };
    }, {
      profileForPage: {
        beforeHash: profile.beforeHash,
        afterHash: profile.afterHash,
        shader: profile.shader,
        pipeline: profile.pipeline,
        computeOracle: profile.computeOracle,
        webgpuSelection: profile.webgpuSelection,
      },
      beforeSource: profile.beforeSource,
      afterSource: profile.afterSource,
    });
    const processIdentityAfter = await browserProcessIdentity(browser);
    const sameProcess =
      processIdentityBefore?.processId
      && processIdentityAfter?.processId
      && processIdentityBefore.processId === processIdentityAfter.processId;
    return {
      executablePath,
      processIdBefore: processIdentityBefore?.processId ?? null,
      processIdAfter: processIdentityAfter?.processId ?? null,
      processRestarted: sameProcess !== true,
      processIdentityBefore,
      processIdentityAfter,
      url: runtime.url,
      trace,
    };
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => runtime.server.close(resolve));
  }
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

function runModeMetadata(profile) {
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: CFG.metricScope,
    metricScope: CFG.metricScope,
    cache_state: CFG.cacheState,
    cacheState: CFG.cacheState,
    edit_id: `${profile.targetId}-webgpu-compute-${CFG.metricScope}`,
    editId: `${profile.targetId}-webgpu-compute-${CFG.metricScope}`,
    edit_hash: profile.afterHash,
    editHash: profile.afterHash,
    edit_kind: 'gpu_artifact_edit',
    editKind: 'gpu_artifact_edit',
    different_edit: CFG.differentEdit,
    differentEdit: CFG.differentEdit,
  };
}

function nativeWebGpuApiEvidence(trace) {
  const apiTrace = Array.isArray(trace.apiTrace) ? trace.apiTrace : [];
  const required = [
    'requestAdapter',
    'requestDevice',
    'createBuffer',
    'createBindGroupLayout',
    'createBindGroup',
    'createShaderModule',
    'createComputePipeline',
    'dispatchWorkgroups',
    'copyBufferToBuffer',
    'queueOnSubmittedWorkDone',
    'mapAsync',
  ];
  const counts = Object.fromEntries(required.map((name) => [
    name,
    apiTrace.filter((entry) => entry?.name === name).length,
  ]));
  const failedGates = required.filter((name) => counts[name] <= 0).map((name) => `missing_${name}`);
  return {
    accepted: failedGates.length === 0,
    required,
    counts,
    failedGates,
    apiTrace,
    source: 'browser_native_webgpu_api_trace',
  };
}

function webgpuDeviceUuid(trace) {
  return `webgpu-runtime-device:${sha256Text(stableJson({
    runtimeSessionId: webGpuRuntimeSessionId(trace),
    webGpuSelectionHash: webGpuSelectionHash(trace.webgpuSelection),
  })).replace(/^sha256:/, '')}`;
}

function computeStateHash(profile) {
  return sha256Text(stableJson({
    targetId: profile.targetId,
    pipeline: profile.pipeline.scope,
    resources: profile.pipeline.resourceStateHash,
    dispatch: profile.pipeline.dispatchWorkgroups,
  }));
}

function evidenceRefsForFields(fields, evidenceRefs) {
  return Object.fromEntries(fields.map((field) => [field, evidenceRefs]));
}

function buildFissionReport({
  profile,
  trace,
  processContinuity,
  oracleArtifacts,
  expectedOutputContract,
}) {
  const decision = {
    targetId: profile.targetId,
    beforeHash: profile.beforeHash,
    afterHash: profile.afterHash,
    entryPoint: profile.shader.entryPoint,
    pipelineScope: profile.pipeline.scope,
    resourceStateHash: profile.pipeline.resourceStateHash,
    readbackHash: oracleArtifacts.raw_readback_hash,
  };
  const verifierEvidenceRef = `runtime:fission-verifier-report:${sha256Text(stableJson(decision)).replace(/^sha256:/, '')}`;
  return {
    selected_island: `webgpu-wgsl-compute:${profile.targetId}:${profile.afterHash}`,
    selected_reason: 'verified_fission_contract',
    changed_sources: [profile.afterPath],
    included_dependencies: [profile.profilePath],
    excluded_host_sources: [],
    artifact_hash_before: profile.beforeHash,
    artifact_hash_after: profile.afterHash,
    abi_compatibility_class: 'compatible',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: processContinuity.processRestarted,
    full_rebuild_used: false,
    unaffected_artifacts_hash_unchanged: true,
    smallest_safe_island_proven: true,
    selected_verifier_evidence_id: verifierEvidenceRef,
    deterministic_verifier_evidence_refs: [
      verifierEvidenceRef,
      `runtime:webgpu-compute:resource-state:${profile.pipeline.resourceStateHash}`,
      `runtime:webgpu-compute:dispatch:${trace.after.dispatchId}`,
      oracleArtifacts.raw_readback_hash,
    ],
    selection_decision_hash: sha256Text(stableJson(decision)),
    output_oracle_contract: {
      kind: 'compute_readback',
      target_id: profile.computeOracle.outputTarget.id,
      readback_resource: profile.computeOracle.outputResource,
      raw_readback_hash: oracleArtifacts.raw_readback_hash,
      expected_output_hash: oracleArtifacts.expected_output_hash,
      expected_output_verified: oracleArtifacts.expected_output_verified,
      expected_output_contract: expectedOutputContract,
      semantic_oracle_binding: oracleArtifacts.semantic_oracle_binding,
      semantic_oracle_request_hash: oracleArtifacts.semantic_oracle_request_hash,
      deterministic_slice: oracleArtifacts.deterministic_slice,
    },
    evidence_refs: [
      verifierEvidenceRef,
      `runtime:webgpu-compute:dispatch:${trace.after.dispatchId}`,
      `runtime:webgpu-compute:readback:${oracleArtifacts.raw_readback_hash}`,
    ],
  };
}

function buildContract({
  profile,
  trace,
  runMode,
  processContinuity,
  oracleArtifacts,
  expectedOutputContract,
}) {
  const semanticOracleIdentity = oracleArtifacts.semantic_oracle_identity;
  if (!semanticOracleIdentityVerified(semanticOracleIdentity, oracleArtifacts.semantic_oracle_binding)) {
    throw new Error('WebGPU contract requires a verified semantic oracle identity');
  }
  const fieldEvidenceRefs = [
    profile.profileHash,
    profile.beforeHash,
    profile.afterHash,
    `${trace.after.dispatchId}:${trace.after.epoch}`,
    `runtime:webgpu-compute:resource-state:${profile.pipeline.resourceStateHash}`,
    oracleArtifacts.raw_readback_hash,
  ];
  const resourceTrace = trace.after.resourceTrace;
  const stateHash = computeStateHash(profile);
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: profile.targetId,
    edit_id: runMode.edit_id,
    backend: { value: 'webgpu' },
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
      artifact_kind: 'wgsl',
      entry_points: [profile.shader.entryPoint],
      compile_target: 'browser-webgpu-compute',
      compiler: 'WebGPU createShaderModule/createComputePipeline',
      compiler_args_hash: sha256Text(stableJson({
        layout: profile.pipeline.layout,
        entryPoint: profile.shader.entryPoint,
        bindGroupLayoutHash: profile.pipeline.bindGroupLayoutHash,
        pipelineLayoutHash: profile.pipeline.pipelineLayoutHash,
      })),
      supported_pipeline_scope: profile.pipeline.scope,
      source_hash_after: semanticOracleIdentity.artifact_source_hash,
      source_pipeline_binding_hash: semanticOracleIdentity.artifact_binding_hash,
    },
    artifact_hash_before: profile.beforeHash,
    artifact_hash_after: profile.afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: fieldEvidenceRefs,
    },
    abi_metadata: {
      args: [],
      descriptor_or_binding_layout: {
        bind_group_layout_hash: profile.pipeline.bindGroupLayoutHash,
        pipeline_layout_hash: profile.pipeline.pipelineLayoutHash,
        vertex_buffer_layout_hash: 'not-applicable:webgpu-compute',
        color_target_state_hash: 'not-applicable:webgpu-compute',
        resource_state_hash: profile.pipeline.resourceStateHash,
        pipeline_state_hash: profile.pipeline.pipelineStateHash,
        runtime_resource_trace: resourceTrace,
        source: 'runtime_trace',
      },
      workgroup_or_launch_shape: {
        dispatch_workgroups: profile.pipeline.dispatchWorkgroups,
        source: 'runtime_trace',
      },
      stream_or_queue_requirements: {
        queue: 'GPUDevice.defaultQueue',
        synchronization: 'GPUQueue.onSubmittedWorkDone plus mapAsync readback',
        source: 'runtime_trace',
      },
      extractor_sources: ['runtime_trace', 'webgpu_compute_profile_schema'],
      extractor_provenance: [{
        source: 'runtime_trace',
        trace_epoch: trace.after.epoch,
        dispatch_id: trace.after.dispatchId,
      }],
    },
    reload_mechanism: { value: 'built_in' },
    adapter_outcome: { value: 'adapter_not_needed_builtin_reload' },
    reload_evidence_refs: [
      `runtime:webgpu-compute:createShaderModule:${trace.after.epoch}`,
      `runtime:webgpu-compute:createComputePipeline:${trace.after.pipelineId}`,
      `runtime:webgpu-compute:resource-state:${profile.pipeline.resourceStateHash}`,
    ],
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'webgpu_same_page_native_compute_trace',
      evidence_refs: [`runtime:webgpu-compute:process-continuity:${processContinuity.processIdAfter}`],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: processContinuity.processRestarted,
      process_id_before: processContinuity.processIdBefore,
      process_id_after: processContinuity.processIdAfter,
    },
    output_oracle_target: {
      kind: 'compute',
      target_id: profile.computeOracle.outputTarget.id,
      compute_only_target_verified: true,
      evidence_refs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.rendered_card_png],
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    semantic_oracle_identity: semanticOracleIdentity,
    state_preservation_checks: {
      process_id: processContinuity.processIdAfter,
      device_uuid: webgpuDeviceUuid(trace),
      context_or_device_handle: `webgpu-page:${trace.after.pageInstanceId}`,
      queue_or_stream_handle: `webgpu-default-queue:${trace.after.pageInstanceId}`,
      persistent_gpu_allocations: {
        resource_state_hash: profile.pipeline.resourceStateHash,
        runtime_resource_trace: resourceTrace,
      },
      engine_scene_handles: [],
      camera_state_hash: stateHash,
      swapchain_or_framebuffer_identity: `webgpu-compute-readback:${profile.computeOracle.readbackResource.group}:${profile.computeOracle.readbackResource.binding}:${profile.computeOracle.readbackResource.byteLength}`,
    },
    fission_report: buildFissionReport({
      profile,
      trace,
      processContinuity,
      oracleArtifacts,
      expectedOutputContract,
    }),
    epoch_policy: {
      publish_mechanism: 'same-page-compute-pipeline-slot',
      dispatch_binding: 'compute-pass-setPipeline-after-pipeline-recreate',
      retirement_mechanism: 'queue-submitted-work-done',
    },
    epoch_retirement_proof: {
      value: 'queue_idle_proven',
      evidence_refs: [`runtime:webgpu-compute:onSubmittedWorkDone:${trace.after.epoch}`],
    },
    webgpu_contract: {
      pipeline_kind: 'compute',
      wgsl_hash_before: profile.beforeHash,
      wgsl_hash_after: profile.afterHash,
      shader_module_epoch: trace.after.epoch,
      entry_points: [profile.shader.entryPoint],
      bind_group_layout_hash: profile.pipeline.bindGroupLayoutHash,
      pipeline_layout_hash: profile.pipeline.pipelineLayoutHash,
      vertex_buffer_layout_hash: 'not-applicable:webgpu-compute',
      color_target_state_hash: 'not-applicable:webgpu-compute',
      pipeline_state_hash: profile.pipeline.pipelineStateHash,
      pipeline_recreate_required: true,
      pipeline_recreate_proven: true,
      supported_pipeline_scope: profile.pipeline.scope,
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
      trusted_oracle_implementation_hash:
        semanticOracleIdentity.trusted_oracle_implementation_hash,
      bind_group_layouts: profile.pipeline.bindGroupLayouts,
      runtime_resource_trace: resourceTrace,
      compute_pipeline_trace: `${trace.after.dispatchId}:${trace.after.epoch}:${profile.afterHash}`,
      compute_readback_trace: `${trace.after.dispatchId}:${oracleArtifacts.raw_readback_hash}`,
      frame_used_new_pipeline_trace: `${trace.after.dispatchId}:${trace.after.epoch}:${profile.afterHash}`,
      field_evidence_refs: evidenceRefsForFields([
        'wgsl_hash_before',
        'wgsl_hash_after',
        'shader_module_epoch',
        'entry_points',
        'bind_group_layout_hash',
        'pipeline_layout_hash',
        'vertex_buffer_layout_hash',
        'color_target_state_hash',
        'pipeline_state_hash',
        'runtime_resource_trace',
        'compute_pipeline_trace',
        'compute_readback_trace',
        'frame_used_new_pipeline_trace',
      ], fieldEvidenceRefs),
    },
  };
  contract.contract_hash = recomputeGpuHmrAcceptanceContractHash(contract);
  contract.contract_id = `webgpu-compute-contract:${contract.contract_hash}`;
  return contract;
}

async function renderComputeCard({ filePath, profile, beforeValues, afterValues, rawHash, sliceHash, expectedVerification }) {
  const width = 720;
  const height = 420;
  const maxAbs = Math.max(1, ...afterValues.map((value) => Math.abs(value)));
  const bars = afterValues.slice(0, 16).map((value, index) => {
    const barWidth = 30;
    const x = 42 + index * 40;
    const h = Math.max(2, Math.abs(value) / maxAbs * 190);
    const y = value >= 0 ? 300 - h : 300;
    const fill = value >= 0 ? '#16a34a' : '#dc2626';
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${fill}"/>`;
  }).join('');
  const beforeText = beforeValues.slice(0, 8).map((value) => value.toFixed(2)).join(', ');
  const afterText = afterValues.slice(0, 8).map((value) => value.toFixed(2)).join(', ');
  const expectedText = expectedVerification.declared
    ? `expected output verified: ${expectedVerification.matched ? 'true' : 'false'} max_delta=${expectedVerification.maxAbsDelta?.toFixed?.(6) ?? 'n/a'}`
    : 'expected output verified: false (not declared)';
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="32" y="42" fill="#e5e7eb" font-family="Arial" font-size="24">WebGPU Compute Readback Proof</text>
  <text x="32" y="76" fill="#93c5fd" font-family="Arial" font-size="14">${profile.targetId}</text>
  <text x="32" y="105" fill="#cbd5e1" font-family="Arial" font-size="13">raw ${rawHash.slice(0, 24)}... slice ${sliceHash.slice(0, 24)}...</text>
  <text x="32" y="134" fill="#cbd5e1" font-family="Arial" font-size="13">before[0..7] ${beforeText}</text>
  <text x="32" y="160" fill="#cbd5e1" font-family="Arial" font-size="13">after[0..7] ${afterText}</text>
  <text x="32" y="186" fill="#cbd5e1" font-family="Arial" font-size="13">${expectedText}</text>
  <line x1="32" y1="300" x2="688" y2="300" stroke="#475569" stroke-width="1"/>
  ${bars}
  <text x="32" y="370" fill="#e2e8f0" font-family="Arial" font-size="13">Card is generated from the mapped GPU readback bytes, not a log-only assertion.</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function writeComputeOracleArtifacts({
  outDir,
  profile,
  trace,
  expectedOutputContract,
  semanticOracle,
}) {
  const {
    implementationBytes,
    request,
    execution,
    traceArtifact,
  } = semanticOracle;
  const dataType = execution.dataType;
  const beforeBytes = Buffer.from(trace.before.readbackBytes);
  const afterBytes = Buffer.from(trace.after.readbackBytes);
  const beforeValues = decodeNumericValues(beforeBytes, dataType);
  const afterValues = decodeNumericValues(afterBytes, dataType);
  const rawHash = sha256Bytes(afterBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedValues = expectedOutputContract.expectedValues;
  if (
    afterBytes.length !== firstArray(execution.expectedBytes).length
    || afterValues.length !== execution.elementCount
    || afterValues.length !== expectedOutputContract.elementCount
  ) {
    throw new Error('WebGPU readback byte length or typed element count does not exactly match the semantic output contract');
  }
  const expectedVerification = compareNumericValues(
    afterValues,
    expectedValues,
    expectedOutputContract.tolerance,
    dataType,
  );
  const expectedBytes = expectedVerification.declared ? encodeNumericValues(expectedValues, dataType) : null;
  const expectedHash = expectedBytes ? sha256Bytes(expectedBytes) : null;
  if (expectedHash !== execution.expectedRawHash) {
    throw new Error('WebGPU expected-output contract does not match independent semantic oracle bytes');
  }
  if (
    !traceArtifact?.path
    || traceArtifact.hash !== request.binding.traceArtifactHash
    || traceArtifact.hash !== canonicalRuntimeTraceHash(trace)
    || sha256Bytes(await readFile(traceArtifact.path)) !== traceArtifact.hash
  ) {
    throw new Error('WebGPU semantic oracle trace artifact is missing or no longer matches its bound runtime facts');
  }
  const observedBinding = deriveWebGpuObservedBinding({
    trace,
    traceArtifactHash: traceArtifact.hash,
    observedReadbackHash: rawHash,
  });
  const independentVerification = await verifyIndependentSemanticOracle({
    request,
    execution,
    observedBytes: afterBytes,
    observedBinding,
  });
  const slice = profile.computeOracle.deterministicSlice;
  const boundedSlice = {
    offset: Math.min(slice.offset, Math.max(0, afterBytes.length - 1)),
    length: Math.min(slice.length, afterBytes.length - Math.min(slice.offset, Math.max(0, afterBytes.length - 1))),
  };
  const sliceBytes = afterBytes.subarray(boundedSlice.offset, boundedSlice.offset + boundedSlice.length);
  const sliceHash = sha256Bytes(sliceBytes);
  const rawPath = path.join(outDir, `${safeSlug(profile.targetId)}-after-readback.bin`);
  const beforeRawPath = path.join(outDir, `${safeSlug(profile.targetId)}-before-readback.bin`);
  const schemaPath = path.join(outDir, `${safeSlug(profile.targetId)}-readback-schema.json`);
  const cardPath = path.join(outDir, `${safeSlug(profile.targetId)}-compute-card.png`);
  const implementationPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle.mjs`);
  const requestPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle-request.json`);
  const resultPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle-result.json`);
  await writeFile(beforeRawPath, beforeBytes);
  await writeFile(rawPath, afterBytes);
  const requestBytes = Buffer.from(stableJson(request), 'utf8');
  const resultBytes = Buffer.from(stableJson(execution), 'utf8');
  await writeFile(implementationPath, implementationBytes);
  await writeFile(requestPath, requestBytes);
  await writeFile(resultPath, resultBytes);
  const persistedImplementationBytes = await readFile(implementationPath);
  const implementationHash = sha256Bytes(persistedImplementationBytes);
  const implementationByteLength = persistedImplementationBytes.byteLength;
  const requestHash = sha256Bytes(await readFile(requestPath));
  const resultHash = sha256Bytes(await readFile(resultPath));
  if (
    implementationHash !== execution.implementationHash
    || requestHash !== execution.requestHash
  ) {
    throw new Error('WebGPU semantic oracle content-addressed artifacts failed hash verification');
  }
  const implementationArtifact = {
    schemaVersion: 'synthi.gpu_hmr.oracle_implementation_artifact.v1',
    role: 'oracle_implementation',
    path: relRepo(implementationPath),
    content_hash: implementationHash,
    byte_length: implementationByteLength,
  };
  const implementationLocator = await buildArtifactCasManifest({
    bytes: persistedImplementationBytes,
    localPath: implementationPath,
    artifactKind: 'semantic_oracle_implementation',
    mediaType: 'text/javascript',
    role: 'oracle_implementation',
    producer: {
      name: 'webgpu_runtime_compute_proof',
      kind: 'runtime_compute_proof',
    },
    producerSubsystem: 'webgpu_runtime_compute_proof',
    sessionNamespace: safeSlug(profile.targetId),
    transportKind: 'direct_worker_path',
  });
  if (
    implementationLocator.contentHash !== implementationHash
    || implementationLocator.byteLength !== implementationByteLength
  ) {
    throw new Error('WebGPU semantic oracle direct/CAS byte identity mismatch');
  }
  const profileHintValues = profile.computeOracle.expectedOutput.values;
  const profileHintVerification = Array.isArray(profileHintValues) && profileHintValues.length > 0
    ? compareNumericValues(
      execution.expectedValues,
      profileHintValues,
      profile.computeOracle.expectedOutput.tolerance,
      dataType,
    )
    : { declared: false, matched: null, compared: 0, maxAbsDelta: null, mismatches: [] };
  const readbackSchema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    producer: 'webgpu_runtime_compute_proof',
    dataType,
    byteLength: afterBytes.length,
    elementCount: afterValues.length,
    shape: expectedOutputContract.shape,
    byteOrder: expectedOutputContract.byteOrder,
    readbackResource: profile.computeOracle.readbackResource,
    readbackSelection: profile.computeOracle.readbackSelection,
    dispatchId: trace.after.dispatchId,
    epoch: trace.after.epoch,
    rawReadbackHash: rawHash,
    expectedOutput: {
      authority: 'content_addressed_semantic_oracle',
      dataType,
      values: expectedValues,
      tolerance: expectedOutputContract.tolerance,
      expectedHash,
      verified: expectedVerification.matched,
      maxAbsDelta: expectedVerification.maxAbsDelta,
      compared: expectedVerification.compared,
      mismatches: expectedVerification.mismatches,
    },
    profileExpectedOutputHint: {
      authority: 'diagnostic_hint_only',
      dataType: profile.computeOracle.expectedOutput.profileHintDataType,
      values: profileHintValues,
      tolerance: profile.computeOracle.expectedOutput.tolerance,
      matchedIndependentOracle: profileHintVerification.matched,
    },
    semanticOracle: {
      implementationHash,
      requestHash,
      resultHash,
      binding: request.binding,
      bindingReceipt: execution.bindingReceipt,
      bindingReceiptHash: execution.bindingReceiptHash,
      semanticRequestHash: execution.semanticRequestHash,
      traceArtifact: relRepo(traceArtifact.path),
      traceArtifactHash: traceArtifact.hash,
      expectedRawHash: execution.expectedRawHash,
      semanticExecutionPerformedByVerifier: false,
      typedByteVerifierSchemaVersion: independentVerification.verifierSchemaVersion,
      typedByteVerifierImplementationHash: independentVerification.verifierImplementationHash,
      typedByteVerified: independentVerification.accepted,
    },
    deterministicSlice: {
      ...boundedSlice,
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
  });
  const schemaHash = sha256Bytes(await readFile(schemaPath));
  const cardHash = sha256Bytes(await readFile(cardPath));
  if ([rawHash, beforeHash, expectedHash, sliceHash].includes(implementationHash)) {
    throw new Error('WebGPU semantic oracle implementation hash aliases readback/data evidence');
  }
  return {
    raw_readback_bin: relRepo(rawPath),
    rawReadbackBin: relRepo(rawPath),
    before_raw_readback_bin: relRepo(beforeRawPath),
    readback_schema_json: relRepo(schemaPath),
    readbackSchemaJson: relRepo(schemaPath),
    raw_readback_hash: rawHash,
    rawReadbackHash: rawHash,
    raw_readback_hash_verified: true,
    raw_readback_source: 'runtime_raw_readback',
    raw_readback_byte_length: afterBytes.length,
    readback_schema_hash: schemaHash,
    checksum_before: beforeHash,
    checksum_after: rawHash,
    output_change_expected: true,
    profile_output_change_hint: profile.computeOracle.expectedOutputChange,
    expected_output_declared: expectedVerification.declared,
    expected_output_required: true,
    expected_output_source: 'content_addressed_semantic_oracle',
    expected_output_data_type: dataType,
    expected_output_values: expectedValues,
    expected_output_hash: expectedHash,
    expected_output_tolerance: expectedOutputContract.tolerance,
    expected_output_verified: expectedVerification.matched,
    expected_output_max_abs_delta: expectedVerification.maxAbsDelta,
    expected_output_compared: expectedVerification.compared,
    expected_output_mismatches: expectedVerification.mismatches,
    profile_expected_output_hint_declared: profileHintVerification.declared,
    profile_expected_output_hint_matched: profileHintVerification.matched,
    deterministic_slice: {
      ...boundedSlice,
      hash: sliceHash,
      source: 'runtime_raw_readback',
    },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: implementationHash,
    semantic_oracle_implementation: relRepo(implementationPath),
    semantic_oracle_implementation_hash: implementationHash,
    oracle_implementation_artifact: implementationArtifact,
    semantic_oracle_implementation_locator: implementationLocator,
    semantic_oracle_request_json: relRepo(requestPath),
    semantic_oracle_request_hash: requestHash,
    semantic_oracle_result_json: relRepo(resultPath),
    semantic_oracle_result_hash: resultHash,
    semantic_oracle_binding: request.binding,
    semantic_oracle_binding_hash: execution.bindingHash,
    semantic_oracle_binding_receipt: execution.bindingReceipt,
    semantic_oracle_binding_receipt_hash: execution.bindingReceiptHash,
    semantic_oracle_identity: buildSemanticOracleIdentity(request.binding),
    semantic_oracle_semantic_request_hash: execution.semanticRequestHash,
    semantic_oracle_trace_artifact: relRepo(traceArtifact.path),
    semantic_oracle_trace_artifact_hash: traceArtifact.hash,
    semantic_oracle_expected_raw_hash: execution.expectedRawHash,
    semantic_oracle_typed_byte_verified: independentVerification.accepted,
    semantic_oracle_verifier_schema_version: independentVerification.verifierSchemaVersion,
    semantic_oracle_verifier_implementation_hash:
      independentVerification.verifierImplementationHash,
    semantic_oracle_verification: independentVerification,
    rendered_card_png: relRepo(cardPath),
    renderedCardPng: relRepo(cardPath),
    rendered_card_hash: cardHash,
    producer: 'webgpu_runtime_compute_proof',
    timestamp_after_dispatch: null,
    epoch: trace.after.epoch,
    raw_readback_verification: {
      raw_readback_hash: rawHash,
      hash_verified: true,
      byte_length: afterBytes.length,
      deterministic_slice_hash: sliceHash,
      deterministic_slice_hash_verified: true,
      readback_schema_hash: schemaHash,
      rendered_card_hash: cardHash,
    },
  };
}

function computeOracleValidation({ artifacts, observedBinding }) {
  const changed = artifacts.checksum_before !== artifacts.checksum_after;
  const expectedVerified = artifacts.expected_output_declared === true
    && artifacts.expected_output_verified === true
    && artifacts.expected_output_source === 'content_addressed_semantic_oracle';
  const bindingVerified = OBSERVED_RUNTIME_BINDING_FIELDS.every((field) => (
    artifacts.semantic_oracle_binding?.[field] === observedBinding?.[field]
  ));
  const schemaDeclared = firstText(aliasedValue(
    artifacts,
    'readbackSchemaJson',
    'readback_schema_json',
    'WebGPU compute oracle readback schema',
  )) !== null;
  const schemaHashDeclared = /^sha256:[0-9a-f]{64}$/u.test(artifacts.readback_schema_hash ?? '');
  const sliceDeclared = artifacts.deterministic_slice
    && Number.isInteger(artifacts.deterministic_slice.offset)
    && Number.isInteger(artifacts.deterministic_slice.length)
    && /^sha256:[0-9a-f]{64}$/u.test(artifacts.deterministic_slice.hash ?? '');
  const implementationVerified =
    /^sha256:[0-9a-f]{64}$/u.test(artifacts.semantic_oracle_implementation_hash ?? '')
    && artifacts.semantic_oracle_implementation_hash === artifacts.oracle_code_hash
    && artifacts.semantic_oracle_typed_byte_verified === true
    && artifacts.semantic_oracle_verification?.accepted === true;
  const identityVerified = semanticOracleIdentityVerified(
    artifacts.semantic_oracle_identity,
    artifacts.semantic_oracle_binding,
  ) && artifacts.semantic_oracle_identity?.trusted_oracle_implementation_hash
    === artifacts.oracle_code_hash;
  const failedGates = [
    changed ? null : 'compute_oracle_checksum_unchanged',
    artifacts.raw_readback_hash_verified === true ? null : 'compute_oracle_raw_readback_hash_unverified',
    artifacts.deterministic_slice_hash_verified === true ? null : 'compute_oracle_deterministic_slice_hash_unverified',
    expectedVerified ? null : 'compute_oracle_expected_output_not_verified',
    schemaDeclared ? null : 'compute_oracle_readback_schema_missing',
    schemaHashDeclared ? null : 'compute_oracle_readback_schema_hash_missing',
    sliceDeclared ? null : 'compute_oracle_deterministic_slice_missing',
    implementationVerified ? null : 'compute_oracle_independent_semantic_recompute_unverified',
    bindingVerified ? null : 'compute_oracle_independent_semantic_binding_mismatch',
    identityVerified ? null : 'compute_oracle_semantic_oracle_identity_unverified',
  ].filter(Boolean);
  return {
    accepted: failedGates.length === 0,
    checksumChanged: changed,
    rawReadbackHashVerified: artifacts.raw_readback_hash_verified === true,
    deterministicSliceHashVerified: artifacts.deterministic_slice_hash_verified === true,
    expectedOutputDeclared: artifacts.expected_output_declared === true,
    expectedOutputVerified: artifacts.expected_output_verified === true,
    expectedOutputRequired: artifacts.expected_output_required !== false,
    expectedOutputHash: artifacts.expected_output_hash,
    expectedOutputMaxAbsDelta: artifacts.expected_output_max_abs_delta,
    semanticOracleRecomputed: implementationVerified,
    semanticOracleBindingVerified: bindingVerified,
    semanticOracleIdentityVerified: identityVerified,
    failedGates,
  };
}

function buildProofLedgerRecord({
  profile,
  trace,
  contract,
  runMode,
  timings,
  modelProvenance,
  processContinuity,
  oracleArtifacts,
  oracleValidation,
}) {
  const afterEpoch = trace.after.epoch;
  const dispatchId = trace.after.dispatchId;
  const processId = processContinuity.processIdAfter;
  const runtimeSessionId = webGpuRuntimeSessionId(trace);
  const outputTargetId = aliasedRuntimeText(
    trace.after,
    'outputTargetId',
    'output_target_id',
    'WebGPU proof-ledger output target',
  );
  if (outputTargetId !== profile.computeOracle.outputTarget.id) {
    throw new Error('WebGPU proof ledger output target does not match the profile declaration');
  }
  const semanticOracleIdentity = oracleArtifacts.semantic_oracle_identity;
  if (!semanticOracleIdentityVerified(semanticOracleIdentity, oracleArtifacts.semantic_oracle_binding)) {
    throw new Error('WebGPU proof ledger requires a verified semantic oracle identity');
  }
  const outputEvent = {
    id: `webgpu-compute-output-${afterEpoch}`,
    kind: 'compute_readback',
    passed: oracleValidation.accepted,
    after_dispatch_id: dispatchId,
    artifact_hash: profile.afterHash,
    epoch: afterEpoch,
    output_target_id: outputTargetId,
    outputTargetId,
    oracle_code_hash: oracleArtifacts.oracle_code_hash,
    semantic_oracle_identity: semanticOracleIdentity,
    semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
    request_id: semanticOracleIdentity.request_id,
    edit_id: semanticOracleIdentity.edit_id,
    target_id: semanticOracleIdentity.target_id,
    output_resource_id: semanticOracleIdentity.output_resource_id,
    trusted_oracle_implementation_hash:
      semanticOracleIdentity.trusted_oracle_implementation_hash,
    runtime_session_id: runtimeSessionId,
    backend: 'webgpu',
    timestamp_monotonic_ns: timings.outputTimestampNs,
    process_id: processId,
    output_oracle: {
      kind: 'compute_oracle',
      output_target_id: outputTargetId,
      oracle_code_hash: oracleArtifacts.oracle_code_hash,
      runtime_session_id: runtimeSessionId,
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
    backend: 'webgpu',
    runtime_session_id: runtimeSessionId,
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    semantic_oracle_identity: semanticOracleIdentity,
    artifact_before_hash: profile.beforeHash,
    artifact_after_hash: profile.afterHash,
    loader_event: {
      id: `webgpu-compute-loader-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      source: 'device.createShaderModule',
      artifact_source_hash: semanticOracleIdentity.artifact_source_hash,
      source_pipeline_binding_hash: semanticOracleIdentity.artifact_binding_hash,
      semantic_oracle_identity: semanticOracleIdentity,
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
    },
    epoch_publish_event: {
      id: `webgpu-compute-publish-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      pipeline_id: trace.after.pipelineId,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      pipeline_id: trace.after.pipelineId,
      dispatch_workgroups: trace.after.dispatchWorkgroups,
      resource_state_hash: profile.pipeline.resourceStateHash,
      runtime_resource_trace: trace.after.resourceTrace,
      output_target_id: outputTargetId,
      outputTargetId,
      command: 'GPUComputePassEncoder.dispatchWorkgroups',
      request_id: semanticOracleIdentity.request_id,
      edit_id: semanticOracleIdentity.edit_id,
      target_id: semanticOracleIdentity.target_id,
      output_resource_id: semanticOracleIdentity.output_resource_id,
      trace_artifact_hash: semanticOracleIdentity.trace_artifact_hash,
      pipeline_state_hash: semanticOracleIdentity.pipeline_state_hash,
      resource_trace_hash: semanticOracleIdentity.resource_trace_hash,
      semantic_oracle_identity: semanticOracleIdentity,
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
    },
    output_event: outputEvent,
    retirement_event: {
      id: `webgpu-compute-retire-${trace.before.epoch}`,
      status: 'queue_idle_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      retired_epoch: trace.before.epoch,
      evidence_refs: [dispatchId, `runtime:webgpu-compute:onSubmittedWorkDone:${afterEpoch}`],
    },
    process_identity: {
      process_id: processId,
      browser_pid: processId,
      page_url: trace.url,
      same_page_instance_id: trace.after.pageInstanceId,
      runtime_session_id: runtimeSessionId,
    },
    device_identity: {
      backend: 'webgpu',
      device_uuid: webgpuDeviceUuid(trace),
      device_identity_scope: 'opaque_runtime_session_not_hardware_identity',
      adapter_identity_observed: false,
      adapter_info: trace.adapterInfo,
      webgpu_selection: trace.webgpuSelection,
      queue: 'GPUDevice.defaultQueue',
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: processContinuity.processRestarted,
      process_id_before: processContinuity.processIdBefore,
      process_id_after: processContinuity.processIdAfter,
      evidence_source: 'webgpu_same_page_native_compute_trace',
      evidence_refs: [`runtime:webgpu-compute:process-continuity:${processId}`],
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
      profile.afterHash,
      oracleArtifacts.raw_readback_hash,
      `runtime:webgpu-compute:dispatch:${dispatchId}`,
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: processContinuity.processRestarted,
  };
}

function buildRuntimeProofArtifact({
  profile,
  trace,
  contract,
  contractEvaluation,
  contractConsistency,
  proofLedger,
  ledger,
  oracleArtifacts,
  oracleValidation,
  nativeApiEvidence,
  processContinuity,
}) {
  const proofLedgerSourceConsistency = {
    accepted: ledger.gpuHmrSuccess === true && ledger.failedInvariants.length === 0,
    mode: 'derived_only',
    source: 'webgpu_runtime_compute_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: proofLedger.records?.[0]?.evidence_refs ?? [],
    evidence_refs: proofLedger.records?.[0]?.evidence_refs ?? [],
    failures: ledger.failedInvariants,
  };
  const limitationCodes = [
    ...(ledger.failedInvariants ?? []).map((failure) => failure.code),
    ...(contractEvaluation.failedGates ?? []).map((failure) => failure.code),
    ...(contractConsistency.failedGates ?? []).map((failure) => failure.code),
    ...(oracleValidation.failedGates ?? []),
    ...(nativeApiEvidence.failedGates ?? []),
    ...(processContinuity.failedGates ?? []),
  ].filter(Boolean);
  const fullRuntimeProven =
    ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && oracleValidation.accepted === true
    && nativeApiEvidence.accepted === true
    && processContinuity.accepted === true
    && limitationCodes.length === 0;
  const limitations = fullRuntimeProven
    ? []
    : [...new Set(limitationCodes)].map((code) => ({ code }));
  const runtimeProofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `webgpu-compute-runtime-proof:${sha256Text(stableJson({
      proofLedgerId: proofLedger.proofId,
      contractHash: contract.contract_hash,
      dispatchId: trace.after.dispatchId,
      epoch: trace.after.epoch,
      rawReadbackHash: oracleArtifacts.raw_readback_hash,
      pipelineStateHash: profile.pipeline.pipelineStateHash,
    })).replace(/^sha256:/, '')}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      {
        stageId: 'webgpu-compute-wgsl-artifact',
        status: profile.beforeHash && profile.afterHash && profile.beforeHash !== profile.afterHash ? 'passed' : 'failed',
        evidenceRefs: [profile.beforeHash, profile.afterHash].filter(Boolean),
      },
      {
        stageId: 'webgpu-compute-pipeline-epoch',
        status: nativeApiEvidence.accepted === true && trace.after.epoch && trace.after.pipelineId ? 'passed' : 'failed',
        evidenceRefs: [
          `runtime:webgpu-compute:createShaderModule:${trace.after.epoch}`,
          `runtime:webgpu-compute:createComputePipeline:${trace.after.pipelineId}`,
        ],
      },
      {
        stageId: 'webgpu-compute-post-epoch-dispatch',
        status: ledger.gpuHmrSuccess === true ? 'passed' : 'failed',
        evidenceRefs: [trace.after.dispatchId, proofLedger.proofId],
      },
      {
        stageId: 'webgpu-compute-raw-readback-oracle',
        status: oracleValidation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [
          oracleArtifacts.raw_readback_hash,
          oracleArtifacts.deterministic_slice_hash,
          oracleArtifacts.readback_schema_hash,
        ].filter(Boolean),
      },
      {
        stageId: 'webgpu-compute-acceptance-contract',
        status: contractEvaluation.accepted === true && contractConsistency.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [contract.contract_hash],
      },
      {
        stageId: 'webgpu-compute-process-firewall',
        status: processContinuity.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`runtime:webgpu-compute:process:${processContinuity.processIdAfter}`],
      },
    ],
    limitations,
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
    nativeWebGpuApiEvidence: nativeApiEvidence,
    native_webgpu_api_evidence: nativeApiEvidence,
    processContinuity,
    process_continuity: processContinuity,
  };
  const strictGate = runtimeProofArtifactStrictGate(runtimeProofArtifact);
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
    backend: 'webgpu',
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
      webgpuComputeRunModes: true,
      webgpu_compute_run_modes: true,
    },
    validationTargetScope: 'webgpu_compute_run_mode_target',
    validation_target_scope: 'webgpu_compute_run_mode_target',
  };
}

function buildNegativeRefusal({ profile }) {
  if (!profile.negativeEdit) return null;
  const material = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    backend: 'webgpu',
    targetId: profile.targetId,
    profileId: profile.id,
    editId: profile.negativeEdit.editId,
    editHash: profile.negativeEdit.editHash,
    claim: profile.negativeEdit.claim,
    reasons: profile.negativeEdit.reasons,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    refusalProven: true,
    refusedBeforeLoad: true,
    validationTargetScope: 'webgpu_compute_run_mode_target',
    validation_target_scope: 'webgpu_compute_run_mode_target',
    coverageObligations: {
      webgpuComputeRunModes: true,
      webgpu_compute_run_modes: true,
    },
  };
  return {
    ...material,
    proofId: `agent-split-negative-edit-refusal:${sha256Text(stableJson(material)).replace(/^sha256:/, '')}`,
  };
}

function declaredNegativeRefusalTestTiming() {
  const recorder = createWebgpuRuntimeComputeTimingV2Recorder();
  return finalizeWebgpuRuntimeComputeTimingV2({
    recorder,
    outcome: 'refused',
    terminalReason: 'webgpu_runtime_compute_negative_edit_refused_before_runtime',
  });
}

async function main(testTimingRecorder) {
  const totalStart = process.hrtime.bigint();
  const staticStart = process.hrtime.bigint();
  const profile = await measureWebgpuRuntimeComputeTimingPhase(
    testTimingRecorder,
    'cold_intake',
    () => loadProfile(CFG.profilePath),
  );
  const staticEnd = process.hrtime.bigint();
  const modelStart = process.hrtime.bigint();
  const modelCheckedAt = new Date().toISOString();
  const provenance = await measureWebgpuRuntimeComputeTimingPhase(
    testTimingRecorder,
    'discovery',
    async () => modelProvenance({
      checkedAt: modelCheckedAt,
      splitModel: CFG.splitModel,
      gpuDeltaModel: CFG.gpuDeltaModel,
    }),
  );
  const modelEnd = process.hrtime.bigint();
  const runtimeStart = process.hrtime.bigint();
  const browserRun = await runBrowserCompute(profile);
  const runtimeEnd = process.hrtime.bigint();
  const trace = {
    url: browserRun.url,
    adapterInfo: browserRun.trace.adapterInfo,
    webgpuSelection: validateWebGpuSelectionEvidence(browserRun.trace.webgpuSelection),
    apiTrace: browserRun.trace.apiTrace,
    before: browserRun.trace.before,
    after: browserRun.trace.after,
  };
  const sameProcess =
    browserRun.processIdBefore
    && browserRun.processIdAfter
    && browserRun.processIdBefore === browserRun.processIdAfter;
  const processContinuity = {
    accepted: sameProcess === true,
    processIdBefore: browserRun.processIdBefore,
    processIdAfter: browserRun.processIdAfter,
    processRestarted: browserRun.processRestarted,
    sourceBefore: browserRun.processIdentityBefore?.source ?? null,
    sourceAfter: browserRun.processIdentityAfter?.source ?? null,
    failedGates: sameProcess === true ? [] : ['browser_process_identity_changed_or_missing'],
  };
  testTimingRecorder.startPhase('proof_finalization');
  const oracleStart = process.hrtime.bigint();
  const runSlug = safeSlug(`${CFG.slug}-${profile.targetId}`);
  const outDir = path.join(ARTIFACT_DIR, runSlug);
  await mkdir(outDir, { recursive: true });
  const runMode = runModeMetadata(profile);
  const implementationBytes = semanticOracleImplementationBytes();
  const traceArtifact = await persistCanonicalRuntimeTrace({
    outDir,
    targetId: profile.targetId,
    trace,
  });
  const semanticRequest = buildWebGpuSemanticOracleRequest({
    profile,
    runMode,
    trace,
    traceArtifactHash: traceArtifact.hash,
  });
  const semanticExecution = await executeSemanticOracle(semanticRequest, implementationBytes);
  const semanticOracle = {
    implementationBytes,
    request: semanticRequest,
    execution: semanticExecution,
    runMode,
    traceArtifact,
  };
  const expectedOutputContract = buildExpectedOutputContract({ semanticOracle });
  const oracleArtifacts = await writeComputeOracleArtifacts({
    outDir,
    profile,
    trace,
    expectedOutputContract,
    semanticOracle,
  });
  const oracleValidation = computeOracleValidation({
    artifacts: oracleArtifacts,
    observedBinding: deriveWebGpuObservedBinding({
      trace,
      traceArtifactHash: traceArtifact.hash,
    }),
  });
  const oracleEnd = process.hrtime.bigint();
  const timings = timingFields({
    staticDiscovery: durationNs(staticStart, staticEnd),
    aiContractSynthesis: 0,
    modelAvailability: durationNs(modelStart, modelEnd),
    artifactHash: 0,
    adapterGeneration: 0,
    deviceCompileWall: durationNs(runtimeStart, runtimeEnd),
    artifactLoad: 1,
    epochPublish: 1,
    dispatchTrace: durationNs(runtimeStart, runtimeEnd),
    runtimeProbe: durationNs(runtimeStart, runtimeEnd),
    oracleAnalysis: durationNs(oracleStart, oracleEnd),
    triggerToVisible: durationNs(runtimeStart, oracleEnd),
    screenshotCapture: 0,
    dispatchToOutputProof: durationNs(runtimeStart, oracleEnd),
    totalValidatorWall: nsSince(totalStart),
  }, runMode);
  timings.loaderTimestampNs = timings.static_discovery_time + timings.model_availability_check_time + 10;
  timings.publishTimestampNs = timings.loaderTimestampNs + 10;
  timings.dispatchTimestampNs = timings.publishTimestampNs + 10;
  timings.outputTimestampNs = timings.dispatchTimestampNs + timings.oracle_analysis_time + 10;
  timings.retirementTimestampNs = timings.outputTimestampNs + 10;
  oracleArtifacts.timestamp_after_dispatch = timings.outputTimestampNs;
  const contract = buildContract({
    profile,
    trace,
    runMode,
    processContinuity,
    oracleArtifacts,
    expectedOutputContract,
  });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
    derivedEvaluation: contractEvaluation,
  });
  const ledgerRecord = buildProofLedgerRecord({
    profile,
    trace,
    contract,
    runMode,
    timings,
    modelProvenance: provenance,
    processContinuity,
    oracleArtifacts,
    oracleValidation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const ledgerEvaluation = evaluateGpuHmrProofLedger(proofLedger.records[0]);
  const nativeApiEvidence = nativeWebGpuApiEvidence(trace);
  const runtimeProofArtifact = buildRuntimeProofArtifact({
    profile,
    trace,
    contract,
    contractEvaluation,
    contractConsistency,
    proofLedger,
    ledger,
    oracleArtifacts,
    oracleValidation,
    nativeApiEvidence,
    processContinuity,
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
    },
    browser: {
      executablePath: browserRun.executablePath,
      processContinuity,
    },
    trace,
    computeOracleArtifacts: oracleArtifacts,
    compute_oracle_artifacts: oracleArtifacts,
    computeOracleValidation: oracleValidation,
    nativeWebGpuApiEvidence: nativeApiEvidence,
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
    noHardcodedProjectBranch: true,
    noShimApplied: true,
  };
  if (proofMaterial.negativeEditRefusal) {
    attachWebgpuRuntimeComputeTestTiming(
      proofMaterial.negativeEditRefusal,
      declaredNegativeRefusalTestTiming(),
    );
  }
  proofMaterial.proofId = `webgpu-runtime-compute-proof:${sha256Text(stableJson({
    schema: proofMaterial.schema,
    profile: proofMaterial.profile,
    contractHash: contract.contract_hash,
    ledgerProofId: ledger.proofId,
    rawReadbackHash: oracleArtifacts.raw_readback_hash,
    nativeApiCounts: nativeApiEvidence.counts,
    runtimeProofArtifactId: runtimeProofArtifact.proofId,
  })).replace(/^sha256:/, '')}`;
  proofMaterial.timingMetrics = webGpuRuntimeComputeTimingMetrics(proofMaterial);
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
  const testTiming = finalizeWebgpuRuntimeComputeTimingV2({
    recorder: testTimingRecorder,
    outcome: accepted ? 'pass' : 'refused',
    terminalReason: accepted
      ? TEST_TIMING_TERMINAL_PASS_REASON
      : TEST_TIMING_TERMINAL_REFUSAL_REASON,
  });
  attachWebgpuRuntimeComputeTestTiming(proofMaterial, testTiming);
  attachWebgpuRuntimeComputeTestTiming(runtimeProofArtifact, testTiming);
  attachWebgpuRuntimeComputeTestTiming(proofMaterial.runModeProof, testTiming);
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
    nativeWebGpuApiAccepted: nativeApiEvidence.accepted,
    testTiming,
    test_timing: testTiming,
    timings: {
      totalValidatorWallTimeNs: timings.total_validator_wall_time,
      dispatchToOutputProofTimeNs: timings.dispatch_to_output_proof_time,
    },
  }, null, 2));
  if (!accepted) process.exitCode = 1;
}

function syntheticWebGpuResourceTrace(profile) {
  const buffers = profile.pipeline.bindGroups.flatMap((group, groupIndex) => (
    group.entries.map((entry) => ({
      group: groupIndex,
      binding: entry.binding,
      layoutType: entry.resource.layoutType,
      dataType: entry.resource.dataType,
      access: entry.resource.access,
      byteLength: entry.resource.byteLength,
      readback: entry.resource.readback,
      resetBeforeDispatch: entry.resource.resetBeforeDispatch,
      resourceHash: entry.resource.resourceHash,
      initialBytes: Array.from(encodeNumericValues(
        entry.resource.values,
        entry.resource.dataType,
      )),
    }))
  ));
  const copiedResources = buffers.filter((resource) => (
    resource.group === profile.computeOracle.readbackResource.group
    && resource.binding === profile.computeOracle.readbackResource.binding
  )).map((resource) => ({
    group: resource.group,
    binding: resource.binding,
    resourceHash: resource.resourceHash,
    dataType: resource.dataType,
    byteLength: resource.byteLength,
  }));
  if (copiedResources.length !== 1) {
    throw new Error(`synthetic WebGPU trace requires one copied resource; found ${copiedResources.length}`);
  }
  return {
    resourceStateHash: profile.pipeline.resourceStateHash,
    bindGroupLayoutCount: profile.pipeline.bindGroupLayouts.length,
    bindGroupCount: profile.pipeline.bindGroups.length,
    readbackResource: profile.computeOracle.readbackResource,
    readbackSelection: profile.computeOracle.readbackSelection,
    copiedResources,
    buffers,
  };
}

async function buildSyntheticRuntimeProofFixture(profile) {
  const runMode = runModeMetadata(profile);
  const resourceTrace = syntheticWebGpuResourceTrace(profile);
  const pageInstanceId = 'webgpu-compute-self-check-page';
  const apiNames = [
    'requestAdapter',
    'requestDevice',
    'createBuffer',
    'createBindGroupLayout',
    'createBindGroup',
    'createShaderModule',
    'createComputePipeline',
    'dispatchWorkgroups',
    'copyBufferToBuffer',
    'queueOnSubmittedWorkDone',
    'mapAsync',
  ];
  const syntheticFeatures = [
    'self-check',
    ...(profile.webgpuSelection.requestDeviceDescriptor.requiredFeatures ?? []),
  ];
  const syntheticLimits = {
    maxComputeWorkgroupsPerDimension: 65535,
    ...(profile.webgpuSelection.requestDeviceDescriptor.requiredLimits ?? {}),
  };
  const requiredInfo = profile.webgpuSelection.requestedAdapterSelector.requiredInfo;
  const observedAdapterInfo = Object.keys(requiredInfo).length > 0 ? { ...requiredInfo } : null;
  const webgpuSelection = validateWebGpuSelectionEvidence({
    schemaVersion: WEBGPU_SELECTION_CONTRACT_SCHEMA,
    requestAdapterOptions: profile.webgpuSelection.requestAdapterOptions,
    requestedAdapterSelector: profile.webgpuSelection.requestedAdapterSelector,
    observedAdapterInfo,
    adapterCapabilities: { features: syntheticFeatures, limits: syntheticLimits },
    requestDeviceDescriptor: profile.webgpuSelection.requestDeviceDescriptor,
    deviceCapabilities: { features: syntheticFeatures, limits: syntheticLimits },
    selectorSatisfied: true,
  });
  const trace = {
    url: 'http://127.0.0.1/self-check',
    adapterInfo: {
      backend: 'webgpu',
      observed: observedAdapterInfo,
      features: syntheticFeatures,
      limits: syntheticLimits,
    },
    webgpuSelection,
    apiTrace: apiNames.map((name, index) => ({ name, detail: {}, t: index + 1 })),
    before: {
      epoch: 'webgpu-compute-epoch-1',
      dispatchId: 'webgpu-compute-self-check-dispatch-1',
      artifactHash: profile.beforeHash,
      compiledSourceHash: profile.beforeHash,
      backend: 'webgpu',
      entryPoint: profile.shader.entryPoint,
      pipelineStateHash: profile.pipeline.pipelineStateHash,
      outputTargetId: profile.computeOracle.outputTarget.id,
      output_target_id: profile.computeOracle.outputTarget.id,
      shaderModuleId: 'webgpu-compute-self-check-module-1',
      pipelineId: 'webgpu-compute-self-check-pipeline-1',
      pageInstanceId,
      dispatchWorkgroups: profile.pipeline.dispatchWorkgroups,
      resourceTrace,
    },
    after: {
      epoch: 'webgpu-compute-epoch-2',
      dispatchId: 'webgpu-compute-self-check-dispatch-2',
      artifactHash: profile.afterHash,
      compiledSourceHash: profile.afterHash,
      backend: 'webgpu',
      entryPoint: profile.shader.entryPoint,
      pipelineStateHash: profile.pipeline.pipelineStateHash,
      outputTargetId: profile.computeOracle.outputTarget.id,
      output_target_id: profile.computeOracle.outputTarget.id,
      shaderModuleId: 'webgpu-compute-self-check-module-2',
      pipelineId: 'webgpu-compute-self-check-pipeline-2',
      pageInstanceId,
      dispatchWorkgroups: profile.pipeline.dispatchWorkgroups,
      resourceTrace,
    },
  };
  const implementationBytes = semanticOracleImplementationBytes();
  const beforeRequest = buildWebGpuSemanticOracleRequest({
    profile,
    runMode,
    trace,
    artifactSource: profile.beforeSource,
    artifactSourceHash: profile.beforeHash,
    artifactAfterHash: profile.beforeHash,
    epochKey: 'before',
  });
  const beforeExecution = await executeSemanticOracle(beforeRequest, implementationBytes);
  trace.before.readbackBytes = beforeExecution.expectedBytes;
  const planningRequest = buildWebGpuSemanticOracleRequest({ profile, runMode, trace });
  const planningExecution = await executeSemanticOracle(planningRequest, implementationBytes);
  trace.after.readbackBytes = planningExecution.expectedBytes;
  const outDir = path.join(ARTIFACT_DIR, 'self-check');
  await mkdir(outDir, { recursive: true });
  const traceArtifact = await persistCanonicalRuntimeTrace({
    outDir,
    targetId: profile.targetId,
    trace,
  });
  const semanticRequest = buildWebGpuSemanticOracleRequest({
    profile,
    runMode,
    trace,
    traceArtifactHash: traceArtifact.hash,
  });
  const semanticExecution = await executeSemanticOracle(semanticRequest, implementationBytes);
  const semanticOracle = {
    implementationBytes,
    request: semanticRequest,
    execution: semanticExecution,
    runMode,
    traceArtifact,
  };
  const expectedOutputContract = buildExpectedOutputContract({ semanticOracle });
  const oracleArtifacts = await writeComputeOracleArtifacts({
    outDir,
    profile,
    trace,
    expectedOutputContract,
    semanticOracle,
  });
  const observedBinding = deriveWebGpuObservedBinding({
    trace,
    traceArtifactHash: traceArtifact.hash,
  });
  const oracleValidation = computeOracleValidation({ artifacts: oracleArtifacts, observedBinding });
  const processContinuity = {
    accepted: true,
    processIdBefore: 'webgpu-self-check-process',
    processIdAfter: 'webgpu-self-check-process',
    processRestarted: false,
    sourceBefore: 'self_check',
    sourceAfter: 'self_check',
    failedGates: [],
  };
  const timings = timingFields({
    staticDiscovery: 1,
    aiContractSynthesis: 0,
    modelAvailability: 1,
    artifactHash: 1,
    adapterGeneration: 0,
    deviceCompileWall: 10,
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
  oracleArtifacts.timestamp_after_dispatch = timings.outputTimestampNs;
  const contract = buildContract({
    profile,
    trace,
    runMode,
    processContinuity,
    oracleArtifacts,
    expectedOutputContract,
  });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
    derivedEvaluation: contractEvaluation,
  });
  const ledgerRecord = buildProofLedgerRecord({
    profile,
    trace,
    contract,
    runMode,
    timings,
    modelProvenance: modelProvenance({
      checkedAt: '2026-06-25T00:00:00.000Z',
      splitModel: 'gemini-3.5-flash',
      gpuDeltaModel: 'gemini-3.1-flash-lite',
    }),
    processContinuity,
    oracleArtifacts,
    oracleValidation,
  });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const nativeApiEvidence = nativeWebGpuApiEvidence(trace);
  const runtimeProofArtifact = buildRuntimeProofArtifact({
    profile,
    trace,
    contract,
    contractEvaluation,
    contractConsistency,
    proofLedger,
    ledger,
    oracleArtifacts,
    oracleValidation,
    nativeApiEvidence,
    processContinuity,
  });
  return {
    runtimeProofArtifact,
    contract,
    proofLedger,
    ledger,
    contractEvaluation,
    contractConsistency,
    nativeApiEvidence,
    oracleArtifacts,
    oracleValidation,
    semanticOracle,
    observedBinding,
    trace,
  };
}

function mutateComputeArtifacts(runtimeProofArtifact, mutation) {
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (
      Object.prototype.hasOwnProperty.call(value, 'raw_readback_bin')
      || Object.prototype.hasOwnProperty.call(value, 'rawReadbackBin')
    ) {
      mutation(value);
    }
    Object.values(value).forEach(visit);
  };
  visit(runtimeProofArtifact);
}

function webGpuGoldenRequest({ source, entryPoint, outputTargetId, dataType, inputBytes }) {
  if (!firstText(entryPoint) || !firstText(outputTargetId)) {
    throw new Error('WebGPU semantic golden request requires declared entry point and output target identity');
  }
  const inputResourceHash = `sha256:${'1'.repeat(64)}`;
  const outputResourceHash = `sha256:${'2'.repeat(64)}`;
  return {
    schemaVersion: INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA,
    binding: {
      outputTargetId,
      outputResourceId: `group:0:binding:1:resource:${outputResourceHash}`,
    },
    artifact: { kind: 'wgsl', source, entryPoint },
    resources: [
      {
        group: 0,
        binding: 0,
        dataType,
        access: 'read',
        readback: false,
        copiedByRuntime: false,
        resourceHash: inputResourceHash,
        initialBytes: inputBytes,
      },
      {
        group: 0,
        binding: 1,
        dataType,
        access: 'read_write',
        readback: true,
        copiedByRuntime: true,
        resourceHash: outputResourceHash,
        initialBytes: [0, 0, 0, 0],
      },
    ],
    dispatch: { workgroups: [1, 1, 1] },
  };
}

function runWebGpuHandComputedSemanticGoldens() {
  const entryPoint = 'main';
  const outputTargetId = 'webgpu-semantic-golden-output';
  const divisionSource = `
struct Values { data: array<u32>, };
@group(0) @binding(0) var<storage, read> input_values: Values;
@group(0) @binding(1) var<storage, read_write> output_values: Values;
@group(1) @binding(0) var<storage, read> dead_input_values: Values;
@group(1) @binding(1) var<storage, read_write> dead_output_values: Values;
// @compute @workgroup_size(1) fn main() { output_values.data[0] = 91u; }
fn dead_helper(value: u32) -> u32 { return value + 97u; }
@compute @workgroup_size(1)
fn second_entry(@builtin(global_invocation_id) global_id: vec3u) {
  dead_output_values.data[global_id.x] = dead_helper(dead_input_values.data[global_id.x]);
}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= arrayLength(&input_values.data)) { return; }
  /* dead_helper and second_entry are not selected */
  output_values.data[i] = input_values.data[i] / 2u * 2u;
}`;
  const divisionRequest = webGpuGoldenRequest({
    source: divisionSource,
    entryPoint,
    outputTargetId,
    dataType: 'uint32',
    inputBytes: [3, 0, 0, 0],
  });
  const division = webGpuSemanticOracleImplementation(divisionRequest);
  if (
    stableJson(division.expectedValues) !== stableJson([2])
    || stableJson(division.expectedBytes) !== stableJson([2, 0, 0, 0])
    || division.semanticProgram.selectedBody.includes('second_entry')
    || division.semanticProgram.selectedBody.includes('dead_helper')
  ) throw new Error('WebGPU hand-computed 3 / 2 * 2 or exact-entry golden failed');

  const wrapRequest = webGpuGoldenRequest({
    source: `
struct Values { data: array<u32>, };
@group(0) @binding(0) var<storage, read> input_values: Values;
@group(0) @binding(1) var<storage, read_write> output_values: Values;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= arrayLength(&input_values.data)) { return; }
  output_values.data[i] = input_values.data[i] + 1u;
}`,
    entryPoint,
    outputTargetId,
    dataType: 'uint32',
    inputBytes: [255, 255, 255, 255],
  });
  const wrap = webGpuSemanticOracleImplementation(wrapRequest);
  if (
    stableJson(wrap.expectedValues) !== stableJson([0])
    || stableJson(wrap.expectedBytes) !== stableJson([0, 0, 0, 0])
  ) throw new Error('WebGPU hand-computed uint32 wrap golden failed');

  const signedDivisionRequest = webGpuGoldenRequest({
    source: `
struct Values { data: array<i32>, };
@group(0) @binding(0) var<storage, read> input_values: Values;
@group(0) @binding(1) var<storage, read_write> output_values: Values;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= arrayLength(&input_values.data)) { return; }
  output_values.data[i] = input_values.data[i] / 2 * 2;
}`,
    entryPoint,
    outputTargetId,
    dataType: 'int32',
    inputBytes: [253, 255, 255, 255],
  });
  const signedDivision = webGpuSemanticOracleImplementation(signedDivisionRequest);
  if (
    stableJson(signedDivision.expectedValues) !== stableJson([-2])
    || stableJson(signedDivision.expectedBytes) !== stableJson([254, 255, 255, 255])
  ) throw new Error('WebGPU hand-computed signed division golden failed');

  const f32Request = webGpuGoldenRequest({
    source: `
struct Values { data: array<f32>, };
@group(0) @binding(0) var<storage, read> input_values: Values;
@group(0) @binding(1) var<storage, read_write> output_values: Values;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= arrayLength(&input_values.data)) { return; }
  output_values.data[i] = (input_values.data[i] + 1.0f) + 1.0f;
}`,
    entryPoint,
    outputTargetId,
    dataType: 'float32',
    inputBytes: [0, 0, 128, 75],
  });
  const f32 = webGpuSemanticOracleImplementation(f32Request);
  if (
    stableJson(f32.expectedValues) !== stableJson([16777216])
    || stableJson(f32.expectedBytes) !== stableJson([0, 0, 128, 75])
  ) throw new Error('WebGPU hand-computed per-operation f32 rounding golden failed');

  let dtypeMismatchRejected = false;
  try {
    const mismatch = JSON.parse(JSON.stringify(divisionRequest));
    mismatch.resources[1].dataType = 'float32';
    webGpuSemanticOracleImplementation(mismatch);
  } catch {
    dtypeMismatchRejected = true;
  }
  let ambiguousCopiedResourceRejected = false;
  try {
    const ambiguous = JSON.parse(JSON.stringify(divisionRequest));
    ambiguous.resources[0].copiedByRuntime = true;
    webGpuSemanticOracleImplementation(ambiguous);
  } catch {
    ambiguousCopiedResourceRejected = true;
  }
  let wrongCopiedResourceRejected = false;
  try {
    const wrong = JSON.parse(JSON.stringify(divisionRequest));
    wrong.resources[0].copiedByRuntime = true;
    wrong.resources[1].copiedByRuntime = false;
    wrong.binding.outputResourceId = `group:0:binding:0:resource:${wrong.resources[0].resourceHash}`;
    webGpuSemanticOracleImplementation(wrong);
  } catch {
    wrongCopiedResourceRejected = true;
  }
  let unsupportedSyntaxRejected = false;
  try {
    const unsupported = JSON.parse(JSON.stringify(divisionRequest));
    unsupported.artifact.source = unsupported.artifact.source.replace(
      'input_values.data[i] / 2u * 2u',
      'select(0u, input_values.data[i], input_values.data[i] > 0u)',
    );
    webGpuSemanticOracleImplementation(unsupported);
  } catch {
    unsupportedSyntaxRejected = true;
  }
  let wrongEntrypointRejected = false;
  try {
    const wrong = JSON.parse(JSON.stringify(divisionRequest));
    wrong.artifact.entryPoint = `missing_${sha256Text(wrong.artifact.source).slice(7, 19)}`;
    webGpuSemanticOracleImplementation(wrong);
  } catch {
    wrongEntrypointRejected = true;
  }
  if (
    !dtypeMismatchRejected
    || !ambiguousCopiedResourceRejected
    || !wrongCopiedResourceRejected
    || !unsupportedSyntaxRejected
    || !wrongEntrypointRejected
  ) throw new Error('WebGPU semantic oracle did not fail closed for an adversarial golden');
  return {
    integerDivision: division.expectedValues,
    uint32Wrap: wrap.expectedValues,
    signedDivision: signedDivision.expectedValues,
    f32Rounding: f32.expectedValues,
    exactEntryPointSelected: true,
    dtypeMismatchRejected,
    ambiguousCopiedResourceRejected,
    wrongCopiedResourceRejected,
    unsupportedSyntaxRejected,
    wrongEntrypointRejected,
  };
}

async function selfCheck() {
  const semanticProfile = await loadProfile(DEFAULT_PROFILE_PATH);
  const semanticRunMode = runModeMetadata(semanticProfile);
  const aliasConflictRejected = (profileFragment) => {
    try {
      assertCamelSnakeAliasesUnambiguous(profileFragment);
      return false;
    } catch {
      return true;
    }
  };
  const profileAliasConflictAdversarial = {
    targetId: aliasConflictRejected({ targetId: 'target-a', target_id: 'target-b' }),
    beforePath: aliasConflictRejected({ shader: { beforePath: 'before-a.wgsl', before_path: 'before-b.wgsl' } }),
    afterPath: aliasConflictRejected({ shader: { afterPath: 'after-a.wgsl', after_path: 'after-b.wgsl' } }),
    entryPoint: aliasConflictRejected({ shader: { entryPoint: 'main', entry_point: 'other' } }),
    computeOracle: aliasConflictRejected({
      computeOracle: { claim: 'first' },
      compute_oracle: { claim: 'second' },
    }),
    outputTarget: aliasConflictRejected({
      computeOracle: { outputTarget: { id: 'target-a' }, output_target: { id: 'target-b' } },
    }),
    outputResource: aliasConflictRejected({
      computeOracle: {
        outputResource: { group: 0, binding: 1 },
        output_resource: { group: 0, binding: 2 },
      },
    }),
    webgpuSelection: aliasConflictRejected({
      webgpuSelection: { adapter: {} },
      webgpu_selection: { adapter: { requestOptions: { powerPreference: 'low-power' } } },
    }),
  };
  if (!Object.values(profileAliasConflictAdversarial).every(Boolean)) {
    throw new Error('self-check failed recursive WebGPU profile alias conflict rejection');
  }
  const omittedIdentityAdversarial = {
    targetId: (() => {
      try {
        normalizeProfileTargetId({ id: 'must-not-be-used-as-target-id' });
        return false;
      } catch {
        return true;
      }
    })(),
    entryPoint: (() => {
      try {
        normalizeComputePipeline(semanticProfile.raw.pipeline, {});
        return false;
      } catch {
        return true;
      }
    })(),
    outputTarget: (() => {
      try {
        normalizeProfileOutputIdentity({
          oracle: { outputResource: semanticProfile.computeOracle.outputResource },
          readbackSelection: { resource: semanticProfile.computeOracle.readbackResource },
        });
        return false;
      } catch {
        return true;
      }
    })(),
    outputResource: (() => {
      try {
        normalizeProfileOutputIdentity({
          oracle: { outputTarget: semanticProfile.computeOracle.outputTarget },
          readbackSelection: { resource: semanticProfile.computeOracle.readbackResource },
        });
        return false;
      } catch {
        return true;
      }
    })(),
    webgpuSelection: (() => {
      try {
        normalizeWebGpuSelectionContract({}, { requireDeclared: true });
        return false;
      } catch {
        return true;
      }
    })(),
  };
  if (!Object.values(omittedIdentityAdversarial).every(Boolean)) {
    throw new Error('self-check failed omitted WebGPU profile identity rejection');
  }
  const numericComparatorAdversarial = {
    nanActualRejected: !compareNumericValues([Number.NaN], [0], Number.MAX_VALUE, 'float32').matched,
    infinityExpectedRejected: !compareNumericValues([1], [Number.POSITIVE_INFINITY], Number.MAX_VALUE, 'float32').matched,
    trailingActualRejected: !compareNumericValues([1, 2], [1], 0, 'float32').matched,
    trailingExpectedRejected: !compareNumericValues([1], [1, 2], 0, 'float32').matched,
    typedNanExpectedRejected: (() => {
      try {
        independentlyEncodeTypedValues([Number.NaN], 'float32');
        return false;
      } catch {
        return true;
      }
    })(),
    typedInfinityExpectedRejected: (() => {
      try {
        independentlyEncodeTypedValues([Number.POSITIVE_INFINITY], 'float32');
        return false;
      } catch {
        return true;
      }
    })(),
  };
  if (!Object.values(numericComparatorAdversarial).every(Boolean)) {
    throw new Error('self-check failed WebGPU non-finite or unequal-length numeric comparison rejection');
  }
  const comparatorDivergenceGolden = verifyExactTypedReadback({
    observedBytes: encodeNumericValues([1.0001], 'float32'),
    expectedValues: [1],
    expectedBytes: Array.from(encodeNumericValues([1], 'float32')),
    expectedRawHash: sha256Bytes(encodeNumericValues([1], 'float32')),
    dataType: 'float32',
  });
  if (
    compareNumericValues([1.0001], [1], 0.1, 'float32').matched !== true
    || comparatorDivergenceGolden.matched !== false
    || comparatorDivergenceGolden.mismatches.length === 0
  ) {
    throw new Error('self-check failed WebGPU independent typed-byte comparator divergence golden');
  }
  const implicitUniqueSelection = resolveWebGpuReadbackSelection({
    oracle: {},
    pipeline: semanticProfile.pipeline,
  });
  const selectorRejected = (oracle, readbackResources) => {
    try {
      resolveWebGpuReadbackSelection({
        oracle,
        pipeline: { ...semanticProfile.pipeline, readbackResources },
      });
      return false;
    } catch {
      return true;
    }
  };
  const selected = semanticProfile.pipeline.readbackResources[0];
  const selectorAdversarial = {
    partialExplicitRejected: selectorRejected({ readbackResource: { group: selected.group } }, semanticProfile.pipeline.readbackResources),
    absentExplicitRejected: selectorRejected({ readbackResource: { group: 99, binding: 99 } }, semanticProfile.pipeline.readbackResources),
    implicitAmbiguousRejected: selectorRejected({}, [selected, { ...selected, binding: selected.binding + 1 }]),
    explicitAmbiguousRejected: selectorRejected(
      { readbackResource: { group: selected.group, binding: selected.binding } },
      [selected, { ...selected }],
    ),
    requestedResolvedPersisted:
      semanticProfile.computeOracle.readbackSelection.requested.mode === 'explicit'
      && semanticProfile.computeOracle.readbackSelection.resolved.resourceHash === selected.resourceHash,
    implicitUniqueResolved:
      implicitUniqueSelection.requested.mode === 'implicit_unique'
      && implicitUniqueSelection.resource.resourceHash === selected.resourceHash,
  };
  const typedSelectionContract = normalizeWebGpuSelectionContract({
    webgpuSelection: {
      adapter: {
        requestOptions: { powerPreference: 'high-performance', forceFallbackAdapter: false },
        requiredInfo: { vendor: 'self-check-vendor' },
      },
      device: {
        requestDescriptor: {
          label: 'self-check-device',
          requiredFeatures: ['self-check-feature'],
          requiredLimits: { maxComputeWorkgroupsPerDimension: 1 },
          defaultQueue: { label: 'self-check-queue' },
        },
      },
    },
  });
  const typedSelectionEvidence = {
    ...typedSelectionContract,
    observedAdapterInfo: { vendor: 'self-check-vendor' },
    adapterCapabilities: {
      features: ['self-check-feature'],
      limits: { maxComputeWorkgroupsPerDimension: 65535 },
    },
    deviceCapabilities: {
      features: ['self-check-feature'],
      limits: { maxComputeWorkgroupsPerDimension: 1 },
    },
    selectorSatisfied: true,
  };
  validateWebGpuSelectionEvidence(typedSelectionEvidence);
  const runtimeSelectionConflictRejected = (mutation) => {
    const conflicted = JSON.parse(JSON.stringify(typedSelectionEvidence));
    mutation(conflicted);
    try {
      validateWebGpuSelectionEvidence(conflicted);
      return false;
    } catch {
      return true;
    }
  };
  const runtimeSelectionAliasConflictAdversarial = {
    requestedAdapterSelector: runtimeSelectionConflictRejected((evidence) => {
      evidence.requested_adapter_selector = {
        requiredInfo: { vendor: 'conflicting-vendor' },
      };
    }),
    requestDeviceDescriptor: runtimeSelectionConflictRejected((evidence) => {
      evidence.request_device_descriptor = {
        ...evidence.requestDeviceDescriptor,
        label: 'conflicting-device',
      };
    }),
    observedAdapterInfo: runtimeSelectionConflictRejected((evidence) => {
      evidence.observed_adapter_info = { vendor: 'conflicting-vendor' };
    }),
    nestedObservedAdapterInfo: runtimeSelectionConflictRejected((evidence) => {
      evidence.observedAdapterInfo.subgroupMinSize = 4;
      evidence.observedAdapterInfo.subgroup_min_size = 8;
    }),
    nestedRequiredAdapterInfo: runtimeSelectionConflictRejected((evidence) => {
      evidence.requestedAdapterSelector.required_info = { vendor: 'conflicting-vendor' };
    }),
    nestedRequiredFeatures: runtimeSelectionConflictRejected((evidence) => {
      evidence.requestDeviceDescriptor.required_features = ['conflicting-feature'];
    }),
  };
  if (!Object.values(runtimeSelectionAliasConflictAdversarial).every(Boolean)) {
    throw new Error('self-check failed recursive runtime WebGPU selection alias conflict rejection');
  }
  selectorAdversarial.exactAdapterOptionsPreserved = stableJson(
    typedSelectionContract.requestAdapterOptions,
  ) === stableJson({ powerPreference: 'high-performance', forceFallbackAdapter: false });
  selectorAdversarial.exactDeviceDescriptorPreserved = stableJson(
    typedSelectionContract.requestDeviceDescriptor,
  ) === stableJson({
    label: 'self-check-device',
    requiredFeatures: ['self-check-feature'],
    requiredLimits: { maxComputeWorkgroupsPerDimension: 1 },
    defaultQueue: { label: 'self-check-queue' },
  });
  selectorAdversarial.unobservableRequiredSelectorRejected = (() => {
    try {
      validateWebGpuSelectionEvidence({ ...typedSelectionEvidence, observedAdapterInfo: null });
      return false;
    } catch {
      return true;
    }
  })();
  selectorAdversarial.mismatchedRequiredSelectorRejected = (() => {
    try {
      validateWebGpuSelectionEvidence({
        ...typedSelectionEvidence,
        observedAdapterInfo: { vendor: 'different-vendor' },
      });
      return false;
    } catch {
      return true;
    }
  })();
  selectorAdversarial.ambiguousSelectorDeclarationRejected = (() => {
    try {
      normalizeWebGpuSelectionContract({
        webgpuSelection: {
          adapter: { requiredInfo: { vendor: 'one' } },
          requiredAdapterInfo: { vendor: 'two' },
        },
      });
      return false;
    } catch {
      return true;
    }
  })();
  if (!Object.values(selectorAdversarial).every(Boolean)) {
    throw new Error('self-check failed WebGPU requested/resolved readback selector rejection');
  }
  const semanticGoldens = runWebGpuHandComputedSemanticGoldens();
  const syntheticProof = await buildSyntheticRuntimeProofFixture(semanticProfile);
  if (
    syntheticProof.runtimeProofArtifact.gpuHmrSuccess !== true
    || syntheticProof.runtimeProofArtifact.strictGate?.status !== 'pass'
    || syntheticProof.oracleValidation.accepted !== true
  ) {
    throw new Error(`self-check failed accepted WebGPU semantic proof: ${JSON.stringify({
      strictGate: syntheticProof.runtimeProofArtifact.strictGate,
      limitations: syntheticProof.runtimeProofArtifact.limitations,
      ledger: syntheticProof.ledger,
      contractEvaluation: syntheticProof.contractEvaluation,
      contractConsistency: syntheticProof.contractConsistency,
      nativeApiEvidence: syntheticProof.nativeApiEvidence,
      oracleValidation: syntheticProof.oracleValidation,
    }, null, 2)}`);
  }
  const { semanticOracle, observedBinding } = syntheticProof;
  const authoritativeAliasConflictTrace = JSON.parse(JSON.stringify(syntheticProof.trace));
  authoritativeAliasConflictTrace.after.output_target_id = 'conflicting-output-target';
  let authoritativeAliasConflictRejected = false;
  try {
    buildWebGpuSemanticOracleRequest({
      profile: semanticProfile,
      runMode: semanticRunMode,
      trace: authoritativeAliasConflictTrace,
    });
  } catch {
    authoritativeAliasConflictRejected = true;
  }
  if (!authoritativeAliasConflictRejected) {
    throw new Error('self-check failed to reject conflicting authoritative runtime aliases');
  }
  const profileOutputIdentityRejections = {
    target: false,
    resource: false,
  };
  try {
    buildWebGpuSemanticOracleRequest({
      profile: {
        ...semanticProfile,
        computeOracle: {
          ...semanticProfile.computeOracle,
          outputTarget: { id: `${semanticProfile.computeOracle.outputTarget.id}:wrong-target` },
        },
      },
      runMode: semanticRunMode,
      trace: syntheticProof.trace,
    });
  } catch {
    profileOutputIdentityRejections.target = true;
  }
  try {
    buildWebGpuSemanticOracleRequest({
      profile: {
        ...semanticProfile,
        computeOracle: {
          ...semanticProfile.computeOracle,
          outputResource: {
            group: semanticProfile.computeOracle.outputResource.group,
            binding: semanticProfile.computeOracle.outputResource.binding + 1,
          },
        },
      },
      runMode: semanticRunMode,
      trace: syntheticProof.trace,
    });
  } catch {
    profileOutputIdentityRejections.resource = true;
  }
  if (!Object.values(profileOutputIdentityRejections).every(Boolean)) {
    throw new Error('self-check failed profile-declared runtime output identity cross-binding');
  }

  const selectionRebindingFailures = {};
  const assertSelectionRebindingRejected = async (name, mutate) => {
    const reboundRequest = JSON.parse(JSON.stringify(semanticOracle.request));
    mutate(reboundRequest.dispatch.webgpuSelection.requestDeviceDescriptor);
    try {
      await executeSemanticOracle(reboundRequest, semanticOracle.implementationBytes);
      selectionRebindingFailures[name] = false;
    } catch {
      selectionRebindingFailures[name] = true;
    }
    if (!selectionRebindingFailures[name]) {
      throw new Error(`self-check failed WebGPU ${name} rebinding rejection`);
    }
  };
  await assertSelectionRebindingRejected('descriptor', (descriptor) => {
    descriptor.label = 'rebound-device';
  });
  await assertSelectionRebindingRejected('feature', (descriptor) => {
    descriptor.requiredFeatures = ['self-check'];
  });
  await assertSelectionRebindingRejected('limit', (descriptor) => {
    descriptor.requiredLimits = { maxComputeWorkgroupsPerDimension: 1 };
  });
  let tamperedRequestedSelectorRejected = false;
  try {
    const tamperedRequest = JSON.parse(JSON.stringify(semanticOracle.request));
    const requested = tamperedRequest.dispatch.readbackSelection.requested;
    requested.group += 7;
    requested.selectorId = `group:${requested.group}:binding:${requested.binding}`;
    await executeSemanticOracle(tamperedRequest, semanticOracle.implementationBytes);
  } catch {
    tamperedRequestedSelectorRejected = true;
  }
  selectorAdversarial.tamperedRequestedSelectorRejected = tamperedRequestedSelectorRejected;
  if (!tamperedRequestedSelectorRejected) {
    throw new Error('self-check failed WebGPU requested selector tampering with unchanged resolved resource rejection');
  }
  const trailingReadbackVerification = await verifyIndependentSemanticOracle({
    request: syntheticProof.semanticOracle.request,
    execution: syntheticProof.semanticOracle.execution,
    observedBytes: Buffer.concat([
      Buffer.from(syntheticProof.semanticOracle.execution.expectedBytes),
      Buffer.alloc(byteWidthForDataType(syntheticProof.semanticOracle.execution.dataType)),
    ]),
    observedBinding: syntheticProof.observedBinding,
  });
  const truncatedReadbackVerification = await verifyIndependentSemanticOracle({
    request: syntheticProof.semanticOracle.request,
    execution: syntheticProof.semanticOracle.execution,
    observedBytes: Buffer.from(syntheticProof.semanticOracle.execution.expectedBytes).subarray(
      0,
      syntheticProof.semanticOracle.execution.expectedBytes.length
        - byteWidthForDataType(syntheticProof.semanticOracle.execution.dataType),
    ),
    observedBinding: syntheticProof.observedBinding,
  });
  if (
    trailingReadbackVerification.accepted !== false
    || !trailingReadbackVerification.failures.includes('semantic_oracle_observed_byte_length_mismatch')
    || !trailingReadbackVerification.failures.includes('semantic_oracle_observed_element_count_mismatch')
    || truncatedReadbackVerification.accepted !== false
    || !truncatedReadbackVerification.failures.includes('semantic_oracle_observed_byte_length_mismatch')
  ) {
    throw new Error('self-check failed WebGPU exact readback byte/element count rejection');
  }
  const sharedOracleRequest = JSON.parse(JSON.stringify(semanticOracle.request));
  const sharedOracleExecution = JSON.parse(JSON.stringify(semanticOracle.execution));
  const substitutedVerifierHash = independentTypedByteVerifierHash();
  sharedOracleRequest.binding.trustedOracleImplementationHash = substitutedVerifierHash;
  const substitutedRequestHash = sha256Text(stableJson(sharedOracleRequest));
  sharedOracleExecution.implementationHash = substitutedVerifierHash;
  sharedOracleExecution.requestHash = substitutedRequestHash;
  sharedOracleExecution.semanticRequestHash = substitutedRequestHash;
  sharedOracleExecution.bindingHash = sha256Text(stableJson(sharedOracleRequest.binding));
  sharedOracleExecution.bindingReceipt = {
    ...sharedOracleRequest.binding,
    semanticRequestHash: substitutedRequestHash,
    oracleImplementationHash: substitutedVerifierHash,
  };
  sharedOracleExecution.bindingReceiptHash = sha256Text(stableJson(
    sharedOracleExecution.bindingReceipt,
  ));
  const sharedOracleSubstitutionVerification = await verifyIndependentSemanticOracle({
    request: sharedOracleRequest,
    execution: sharedOracleExecution,
    observedBytes: sharedOracleExecution.expectedBytes,
    observedBinding,
  });
  if (
    sharedOracleSubstitutionVerification.accepted !== false
    || !sharedOracleSubstitutionVerification.failures.includes(
      'semantic_oracle_shared_oracle_substitution',
    )
  ) {
    throw new Error('self-check failed shared semantic-oracle/verifier substitution rejection');
  }
  const oracleCodeHash = semanticOracleCodeHash();
  const expectedOutputContract = buildExpectedOutputContract({ semanticOracle });
  const semanticIdentity = buildSemanticOracleIdentity(semanticOracle.request.binding);
  const ledgerRecord = syntheticProof.proofLedger.records?.[0] ?? {};
  const semanticLoaderEvent = ledgerRecord.loader_event ?? ledgerRecord.loaderEvent ?? {};
  const semanticDispatchEvent = ledgerRecord.dispatch_event ?? ledgerRecord.dispatchEvent ?? {};
  const semanticOutputEvent = ledgerRecord.output_event ?? ledgerRecord.outputEvent ?? {};
  if (
    oracleCodeHash !== semanticOracle.execution.implementationHash
    || expectedOutputContract.binding.projectId !== semanticProfile.targetId
    || expectedOutputContract.binding.editId !== semanticRunMode.edit_id
    || expectedOutputContract.binding.artifactAfterHash !== semanticProfile.afterHash
    || expectedOutputContract.binding.outputTargetId !== semanticProfile.computeOracle.outputTarget.id
    || expectedOutputContract.binding.oracleCodeHash !== oracleCodeHash
    || observedBinding.backend !== 'webgpu'
    || observedBinding.runtimeSessionId !== webGpuRuntimeSessionId(syntheticProof.trace)
  ) {
    throw new Error('self-check failed WebGPU independent semantic expected-output binding');
  }
  if (
    stableJson(syntheticProof.contract.semantic_oracle_identity) !== stableJson(semanticIdentity)
    || stableJson(semanticLoaderEvent.semantic_oracle_identity) !== stableJson(semanticIdentity)
    || stableJson(semanticDispatchEvent.semantic_oracle_identity) !== stableJson(semanticIdentity)
    || stableJson(semanticOutputEvent.semantic_oracle_identity) !== stableJson(semanticIdentity)
    || semanticLoaderEvent.semantic_oracle_identity_hash !== semanticIdentity.identity_hash
    || semanticDispatchEvent.semantic_oracle_identity_hash !== semanticIdentity.identity_hash
    || semanticDispatchEvent.request_id !== semanticIdentity.request_id
    || semanticDispatchEvent.output_resource_id !== semanticIdentity.output_resource_id
    || semanticOutputEvent.semantic_oracle_identity_hash !== semanticIdentity.identity_hash
    || semanticOutputEvent.trusted_oracle_implementation_hash
      !== semanticIdentity.trusted_oracle_implementation_hash
  ) {
    throw new Error(`self-check failed WebGPU semantic identity contract/ledger event chain: ${JSON.stringify({
      expected: semanticIdentity,
      contract: syntheticProof.contract.semantic_oracle_identity,
      loader: semanticLoaderEvent,
      dispatch: semanticDispatchEvent,
      output: semanticOutputEvent,
    }, null, 2)}`);
  }

  const forgedValues = [...semanticOracle.execution.expectedValues];
  forgedValues[0] = forgedValues[0] + 97;
  const forgedObservedBytes = encodeNumericValues(forgedValues, semanticOracle.execution.dataType);
  const forgedProfile = {
    ...semanticProfile,
    computeOracle: {
      ...semanticProfile.computeOracle,
      expectedOutput: {
        ...semanticProfile.computeOracle.expectedOutput,
        values: forgedValues,
        tolerance: Number.MAX_SAFE_INTEGER,
      },
    },
  };
  const forgedRequest = buildWebGpuSemanticOracleRequest({
    profile: forgedProfile,
    runMode: semanticRunMode,
    trace: syntheticProof.trace,
  });
  const forgedDeclarationMatches = compareNumericValues(
    forgedValues,
    forgedProfile.computeOracle.expectedOutput.values,
    forgedProfile.computeOracle.expectedOutput.tolerance,
    semanticOracle.execution.dataType,
  ).matched;
  const forgedExecution = await executeSemanticOracle(
    forgedRequest,
    semanticOracle.implementationBytes,
  );
  const forgedVerification = await verifyIndependentSemanticOracle({
    request: forgedRequest,
    execution: forgedExecution,
    observedBytes: forgedObservedBytes,
    observedBinding,
  });
  if (
    forgedDeclarationMatches !== true
    || forgedVerification.accepted !== false
    || !forgedVerification.failures.includes('semantic_oracle_observed_output_mismatch')
    || forgedExecution.expectedRawHash !== semanticOracle.execution.expectedRawHash
    || forgedExecution.implementationHash !== semanticOracle.execution.implementationHash
  ) {
    throw new Error('self-check failed to reject matched-byte profile declaration forgery');
  }

  const rebindingFailures = {};
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    const runtimeObservedField = OBSERVED_RUNTIME_BINDING_FIELDS.includes(field);
    const reboundBinding = runtimeObservedField
      ? { ...observedBinding, [field]: `${observedBinding[field]}:rebound` }
      : observedBinding;
    const reboundExecution = JSON.parse(JSON.stringify(semanticOracle.execution));
    if (!runtimeObservedField) {
      reboundExecution.bindingReceipt[field] = `${reboundExecution.bindingReceipt[field]}:rebound`;
      reboundExecution.bindingReceiptHash = sha256Text(stableJson(reboundExecution.bindingReceipt));
    }
    const verification = await verifyIndependentSemanticOracle({
      request: semanticOracle.request,
      execution: reboundExecution,
      observedBytes: semanticOracle.execution.expectedBytes,
      observedBinding: reboundBinding,
    });
    const failure = runtimeObservedField
      ? `semantic_oracle_binding_${field}_mismatch`
      : `semantic_oracle_receipt_${field}_mismatch`;
    rebindingFailures[field] = verification.failures;
    if (verification.accepted !== false || !verification.failures.includes(failure)) {
      throw new Error(`self-check failed to reject WebGPU semantic ${field} rebinding`);
    }
  }

  const staleRuntimeTrace = JSON.parse(JSON.stringify(syntheticProof.trace));
  staleRuntimeTrace.staleArtifactMarker = true;
  let staleTraceArtifactRejected = false;
  try {
    deriveWebGpuObservedBinding({
      trace: staleRuntimeTrace,
      traceArtifactHash: semanticOracle.request.binding.traceArtifactHash,
    });
  } catch {
    staleTraceArtifactRejected = true;
  }
  const staleArtifactRequest = JSON.parse(JSON.stringify(semanticOracle.request));
  staleArtifactRequest.artifact.source = `${staleArtifactRequest.artifact.source}\n// stale`;
  let staleArtifactRejected = false;
  try {
    await executeSemanticOracle(staleArtifactRequest, semanticOracle.implementationBytes);
  } catch {
    staleArtifactRejected = true;
  }
  const replayVerification = await verifyIndependentSemanticOracle({
    request: semanticOracle.request,
    execution: semanticOracle.execution,
    observedBytes: semanticOracle.execution.expectedBytes,
    observedBinding: {
      ...observedBinding,
      runtimeSessionId: `${observedBinding.runtimeSessionId}:replayed-session`,
    },
  });
  const wrongResourceVerification = await verifyIndependentSemanticOracle({
    request: semanticOracle.request,
    execution: semanticOracle.execution,
    observedBytes: semanticOracle.execution.expectedBytes,
    observedBinding: {
      ...observedBinding,
      outputResourceId: `${observedBinding.outputResourceId}:wrong-resource`,
    },
  });
  const ambiguousResourceTrace = JSON.parse(JSON.stringify(syntheticProof.trace));
  ambiguousResourceTrace.after.resourceTrace.copiedResources.push({
    ...ambiguousResourceTrace.after.resourceTrace.copiedResources[0],
    binding: ambiguousResourceTrace.after.resourceTrace.copiedResources[0].binding + 1,
  });
  let ambiguousRuntimeCopyRejected = false;
  try {
    buildWebGpuSemanticOracleRequest({
      profile: semanticProfile,
      runMode: semanticRunMode,
      trace: ambiguousResourceTrace,
    });
  } catch {
    ambiguousRuntimeCopyRejected = true;
  }
  const wrongResourceTrace = JSON.parse(JSON.stringify(syntheticProof.trace));
  const tracedInput = wrongResourceTrace.after.resourceTrace.buffers.find((resource) => (
    resource.group === 0 && resource.binding === 0
  ));
  wrongResourceTrace.after.resourceTrace.copiedResources = [{
    group: tracedInput.group,
    binding: tracedInput.binding,
    resourceHash: tracedInput.resourceHash,
    dataType: tracedInput.dataType,
    byteLength: tracedInput.byteLength,
  }];
  let wrongRuntimeCopyRejected = false;
  try {
    const wrongRequest = buildWebGpuSemanticOracleRequest({
      profile: semanticProfile,
      runMode: semanticRunMode,
      trace: wrongResourceTrace,
    });
    await executeSemanticOracle(wrongRequest, semanticOracle.implementationBytes);
  } catch {
    wrongRuntimeCopyRejected = true;
  }
  let requestCopyTraceTamperRejected = false;
  try {
    const tamperedRequest = JSON.parse(JSON.stringify(semanticOracle.request));
    const tamperedInput = tamperedRequest.resources.find((resource) => (
      resource.group === 0 && resource.binding === 0
    ));
    const tamperedOutput = tamperedRequest.resources.find((resource) => (
      resource.group === 0 && resource.binding === 1
    ));
    tamperedInput.copiedByRuntime = true;
    tamperedOutput.copiedByRuntime = false;
    tamperedRequest.dispatch.outputResource = {
      group: tamperedInput.group,
      binding: tamperedInput.binding,
      resourceHash: tamperedInput.resourceHash,
    };
    tamperedRequest.binding.outputResourceId = [
      `group:${tamperedInput.group}`,
      `binding:${tamperedInput.binding}`,
      `resource:${tamperedInput.resourceHash}`,
    ].join(':');
    await executeSemanticOracle(tamperedRequest, semanticOracle.implementationBytes);
  } catch {
    requestCopyTraceTamperRejected = true;
  }
  if (
    !staleTraceArtifactRejected
    || !staleArtifactRejected
    || replayVerification.accepted !== false
    || !replayVerification.failures.includes('semantic_oracle_binding_runtimeSessionId_mismatch')
    || wrongResourceVerification.accepted !== false
    || !wrongResourceVerification.failures.includes('semantic_oracle_binding_outputResourceId_mismatch')
    || !ambiguousRuntimeCopyRejected
    || !wrongRuntimeCopyRejected
    || !requestCopyTraceTamperRejected
  ) {
    throw new Error('self-check failed stale trace, session replay, or runtime copied-resource rejection');
  }

  const strictForgeryFailures = {};
  const assertStrictForgeryRejected = (name, mutation, expectedFailure) => {
    const forged = JSON.parse(JSON.stringify(syntheticProof.runtimeProofArtifact));
    mutation(forged);
    const gate = runtimeProofArtifactStrictGate(forged);
    strictForgeryFailures[name] = gate.failures;
    if (gate.status !== 'fail' || !gate.failures.includes(expectedFailure)) {
      throw new Error(`self-check failed ${name}: ${JSON.stringify(gate)}`);
    }
  };
  assertStrictForgeryRejected(
    'missing-output-event-oracle-code-hash',
    (forged) => {
      for (const ledgerKey of ['proofLedger', 'proof_ledger']) {
        for (const record of forged?.[ledgerKey]?.records ?? []) {
          delete record.output_event?.oracle_code_hash;
          delete record.output_event?.oracleCodeHash;
          delete record.outputEvent?.oracle_code_hash;
          delete record.outputEvent?.oracleCodeHash;
        }
      }
    },
    'compute_oracle_semantic_oracle_code_hash_output_event_missing',
  );
  assertStrictForgeryRejected(
    'missing-oracle-implementation-byte-artifact',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.oracle_implementation_artifact;
      delete artifacts.oracleImplementationArtifact;
      delete artifacts.semantic_oracle_implementation_artifact;
      delete artifacts.semanticOracleImplementationArtifact;
      delete artifacts.oracle_implementation_locator;
      delete artifacts.oracleImplementationLocator;
      delete artifacts.semantic_oracle_implementation_locator;
      delete artifacts.semanticOracleImplementationLocator;
    }),
    'compute_oracle_implementation_byte_artifact_missing',
  );
  assertStrictForgeryRejected(
    'forged-oracle-implementation-byte-artifact',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      const implementationArtifact = artifacts.oracle_implementation_artifact;
      if (implementationArtifact) {
        implementationArtifact.path = artifacts.raw_readback_bin;
        implementationArtifact.byte_length = artifacts.raw_readback_byte_length;
      }
    }),
    'compute_oracle_implementation_artifact_hash_mismatch',
  );
  assertStrictForgeryRejected(
    'missing-readback-schema',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.readback_schema_json;
      delete artifacts.readbackSchemaJson;
    }),
    'compute_oracle_semantic_readback_schema_artifact_missing',
  );
  assertStrictForgeryRejected(
    'missing-readback-schema-hash',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.readback_schema_hash;
      delete artifacts.readbackSchemaHash;
    }),
    'compute_oracle_semantic_readback_schema_hash_missing',
  );
  assertStrictForgeryRejected(
    'missing-deterministic-slice',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.deterministic_slice;
      delete artifacts.deterministicSlice;
      delete artifacts.deterministic_slice_hash;
      delete artifacts.deterministicSliceHash;
    }),
    'compute_oracle_semantic_deterministic_slice_missing',
  );
  const supported = normalizeComputePipeline({
    layout: 'explicit-compute-profiled',
    bindGroupLayouts: [{
      entries: [
        { binding: 0, visibility: 'compute', buffer: { type: 'read-only-storage', minBindingSize: 16 } },
        { binding: 1, visibility: 'compute', buffer: { type: 'storage', minBindingSize: 16 } },
      ],
    }],
    bindGroups: [{
      entries: [
        { binding: 0, resource: { kind: 'storage_buffer', dataType: 'float32', values: [1, 2, 3, 4] } },
        { binding: 1, readback: true, resetBeforeDispatch: true, resource: { kind: 'storage_buffer', dataType: 'float32', values: [0, 0, 0, 0] } },
      ],
    }],
    dispatchWorkgroups: [1, 1, 1],
  }, { entryPoint: 'main' });
  if (supported.scope !== 'explicit-compute-profiled-layout-storage-uniform-float32-readback') {
    throw new Error('self-check failed to accept supported compute pipeline');
  }
  const supportedUint32 = normalizeComputePipeline({
    layout: 'explicit-compute-profiled',
    bindGroupLayouts: [{
      entries: [
        { binding: 0, visibility: 'compute', buffer: { type: 'read-only-storage', minBindingSize: 16 } },
        { binding: 1, visibility: 'compute', buffer: { type: 'storage', minBindingSize: 16 } },
      ],
    }],
    bindGroups: [{
      entries: [
        { binding: 0, resource: { kind: 'storage_buffer', dataType: 'uint32', values: [1, 2, 3, 4] } },
        { binding: 1, readback: true, resetBeforeDispatch: true, resource: { kind: 'storage_buffer', dataType: 'uint32', values: [0, 0, 0, 0] } },
      ],
    }],
    dispatchWorkgroups: [1, 1, 1],
  }, { entryPoint: 'main' });
  if (
    supportedUint32.scope !== 'explicit-compute-profiled-layout-storage-uniform-uint32-readback'
    || supportedUint32.readbackResources[0]?.dataType !== 'uint32'
    || supportedUint32.readbackResources[0]?.byteLength !== 16
  ) {
    throw new Error('self-check failed to accept typed uint32 compute pipeline');
  }
  const uint32Values = [0, 1, 4294967295];
  const decodedUint32 = decodeNumericValues(encodeNumericValues(uint32Values, 'uint32'), 'uint32');
  if (decodedUint32.join(',') !== uint32Values.join(',')) {
    throw new Error('self-check failed to round-trip uint32 oracle bytes');
  }
  let rejected = false;
  try {
    normalizeComputePipeline({
      layout: 'explicit-compute-profiled',
      bindGroupLayouts: [{
        entries: [{ binding: 0, visibility: 'fragment', buffer: { type: 'sampler' } }],
      }],
      bindGroups: [{
        entries: [{ binding: 0, resource: { kind: 'sampler', dataType: 'float32', values: [1] } }],
      }],
    }, { entryPoint: 'main' });
  } catch (error) {
    rejected = Array.isArray(error.unsupportedReasons)
      && error.unsupportedReasons.some((reason) => reason.includes('visibility_unsupported'))
      && error.unsupportedReasons.some((reason) => reason.includes('buffer_type_unsupported'));
  }
  if (!rejected) throw new Error('self-check failed to reject unsupported compute resource');
  let rejectedDataType = false;
  try {
    normalizeComputePipeline({
      layout: 'explicit-compute-profiled',
      bindGroupLayouts: [{
        entries: [{ binding: 0, visibility: 'compute', buffer: { type: 'storage', minBindingSize: 4 } }],
      }],
      bindGroups: [{
        entries: [{ binding: 0, readback: true, resource: { kind: 'storage_buffer', dataType: 'float16', values: [1] } }],
      }],
    }, { entryPoint: 'main' });
  } catch (error) {
    rejectedDataType = Array.isArray(error.unsupportedReasons)
      && error.unsupportedReasons.some((reason) => reason.includes('resource_data_type_unsupported:float16'));
  }
  if (!rejectedDataType) throw new Error('self-check failed to reject unsupported compute data type');
  const fakeArtifact = 'sha256:' + 'a'.repeat(64);
  const fakeRecord = {
    project_id: 'webgpu-compute-self-check',
    edit_id: 'webgpu-compute-self-check-edit',
    backend: 'webgpu',
    classification: { project_kind: 'gpu_project', edit_kind: 'gpu_artifact_edit', route: 'gpu_hmr' },
    contract_hash: 'sha256:' + 'b'.repeat(64),
    artifact_before_hash: 'sha256:' + 'c'.repeat(64),
    artifact_after_hash: fakeArtifact,
    loader_event: { id: 'loader', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 10, process_id: '100' },
    epoch_publish_event: { id: 'publish', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 20, process_id: '100' },
    dispatch_event: { id: 'dispatch', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 30, process_id: '100', output_target_id: semanticProfile.computeOracle.outputTarget.id, outputTargetId: semanticProfile.computeOracle.outputTarget.id },
    output_event: { id: 'output', after_dispatch_id: 'dispatch', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 40, process_id: '100', output_target_id: semanticProfile.computeOracle.outputTarget.id, outputTargetId: semanticProfile.computeOracle.outputTarget.id },
    retirement_event: { id: 'retire', status: 'queue_idle_proven', timestamp_monotonic_ns: 50, process_id: '100' },
    process_identity: { process_id: '100' },
    device_identity: { device_uuid: 'webgpu-adapter:self-check' },
    output_oracle_target: {
      kind: 'compute',
      target_id: semanticProfile.computeOracle.outputTarget.id,
      compute_only_target_verified: true,
      evidence_refs: ['runtime:self-check'],
    },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'pipeline_cache_warm',
    timings: timingFields({}, { metric_scope: 'hot_delta_1', cache_state: 'pipeline_cache_warm' }),
    model_provenance: modelProvenance({
      checkedAt: '2026-06-24T00:00:00.000Z',
      splitModel: 'gemini-3.5-flash',
      gpuDeltaModel: 'gemini-3.1-flash-lite',
    }),
    evidence_refs: ['runtime:self-check'],
  };
  const evaluation = evaluateGpuHmrProofLedger(fakeRecord);
  if (
    fakeRecord.dispatch_event.output_target_id !== semanticProfile.computeOracle.outputTarget.id
    || fakeRecord.output_event.output_target_id !== semanticProfile.computeOracle.outputTarget.id
    || fakeRecord.output_oracle_target.target_id !== semanticProfile.computeOracle.outputTarget.id
  ) {
    throw new Error('self-check failed to bind WebGPU compute output target identity');
  }
  if (evaluation.gpuHmrSuccess || !evaluation.failedInvariants.some((gate) => gate.code === 'compute_oracle_artifacts_missing')) {
    throw new Error('self-check failed to reject missing compute raw readback artifacts');
  }
  let timingClock = 0n;
  const timingRecorder = createWebgpuRuntimeComputeTimingV2Recorder({
    clock: () => {
      timingClock += 10n;
      return timingClock;
    },
  });
  await measureWebgpuRuntimeComputeTimingPhase(timingRecorder, 'cold_intake', async () => {});
  await measureWebgpuRuntimeComputeTimingPhase(timingRecorder, 'discovery', async () => {});
  await measureWebgpuRuntimeComputeTimingPhase(timingRecorder, 'proof_finalization', async () => {});
  const testTiming = finalizeWebgpuRuntimeComputeTimingV2({
    recorder: timingRecorder,
    outcome: 'pass',
    terminalReason: TEST_TIMING_TERMINAL_PASS_REASON,
  });
  const timingValidation = validateGpuHmrTestTiming(testTiming);
  if (
    timingValidation.valid !== true
    || testTiming.phases.cold_intake.state !== 'measured'
    || testTiming.phases.discovery.state !== 'measured'
    || testTiming.phases.proof_finalization.state !== 'measured'
    || testTiming.phases.compile.state !== 'unavailable'
    || testTiming.phases.trigger_to_visible.state !== 'not_applicable'
    || testTiming.phases.trigger_to_visible.reasonCode
      !== TEST_TIMING_VISUAL_NOT_APPLICABLE_REASON
  ) {
    throw new Error(`self-check failed timing-v2 semantics: ${timingValidation.blockingGaps.join(',')}`);
  }
  const timedTarget = {};
  attachWebgpuRuntimeComputeTestTiming(timedTarget, testTiming);
  if (stableJson(timedTarget.testTiming) !== stableJson(timedTarget.test_timing)) {
    throw new Error('self-check failed timing-v2 alias attachment');
  }
  let forgedTimingRejected = false;
  try {
    attachWebgpuRuntimeComputeTestTiming({}, {
      ...testTiming,
      acceptedForGpuHmr: true,
    });
  } catch {
    forgedTimingRejected = true;
  }
  if (!forgedTimingRejected) {
    throw new Error('self-check failed to reject timing authority forgery');
  }
  console.log(JSON.stringify({
    ok: true,
    supportedScope: supported.scope,
    supportedUint32Scope: supportedUint32.scope,
    forgedLedgerFailedGate: 'compute_oracle_artifacts_missing',
    semanticOracleImplementationHash: oracleCodeHash,
    handComputedSemanticGoldens: semanticGoldens,
    numericComparatorAdversarial,
    profileAliasConflictAdversarial,
    omittedIdentityAdversarial,
    runtimeSelectionAliasConflictAdversarial,
    readbackSelectorAdversarial: selectorAdversarial,
    authoritativeRuntimeAliasConflictRejected: authoritativeAliasConflictRejected,
    profileOutputIdentityRejections,
    webGpuSelectionRebindingRejected: selectionRebindingFailures,
    sharedOracleSubstitutionRejected:
      sharedOracleSubstitutionVerification.accepted === false,
    independentTypedByteVerifierHash: independentTypedByteVerifierHash(),
    exactReadbackLengthAdversarial: {
      trailingRejected: trailingReadbackVerification.accepted === false,
      truncatedRejected: truncatedReadbackVerification.accepted === false,
    },
    matchedByteDeclarationForgeryRejected: true,
    semanticOracleRebindingFailures: rebindingFailures,
    runtimeBindingAdversarialChecks: {
      staleTraceArtifactRejected,
      staleArtifactRejected,
      sessionReplayRejected: replayVerification.accepted === false,
      wrongResourceRejected: wrongResourceVerification.accepted === false,
      ambiguousRuntimeCopyRejected,
      wrongRuntimeCopyRejected,
      requestCopyTraceTamperRejected,
    },
    strictSemanticForgeryFailures: strictForgeryFailures,
    timingSchema: testTiming.schema,
    timingAuthorityForgeryRejected: forgedTimingRejected,
  }, null, 2));
}

if (process.argv.includes('--self-check')) {
  selfCheck().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const testTimingRecorder = createWebgpuRuntimeComputeTimingV2Recorder();
  main(testTimingRecorder).catch((error) => {
    const outcome = webgpuRuntimeComputeTimingOutcome(error);
    let testTiming = null;
    try {
      testTiming = finalizeWebgpuRuntimeComputeTimingV2({
        recorder: testTimingRecorder,
        outcome,
        terminalReason: webgpuRuntimeComputeTimingReason(outcome),
      });
    } catch (timingError) {
      console.error(timingError);
    }
    console.error(JSON.stringify({
      schemaVersion: 'synthi.gpu_hmr.webgpu_runtime_compute_failure.v1',
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
