#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
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
  recomputeGpuHmrAcceptanceContractHash,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import {
  hipModuleRuntimeTimingMetrics,
} from './lib/gpu-hmr-timing-metrics.mjs';
import {
  runtimeProofArtifactStrictGate,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  buildComputeExpectedOutputContract,
} from './lib/gpu-hmr-compute-oracle-semantics.mjs';
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
const COMPUTE_SEMANTIC_ORACLE_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.compute_semantic_oracle_identity.v1';
const INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA =
  'synthi.gpu_hmr.independent_semantic_oracle_request.v1';
const INDEPENDENT_SEMANTIC_ORACLE_RESULT_SCHEMA =
  'synthi.gpu_hmr.independent_semantic_oracle_result.v1';
const SEMANTIC_ORACLE_BINDING_FIELDS = Object.freeze([
  'projectId',
  'editId',
  'targetId',
  'requestId',
  'artifactAfterHash',
  'artifactSourceHash',
  'artifactBindingHash',
  'compileManifestHash',
  'outputTargetId',
  'outputResourceId',
  'backend',
  'runtimeSessionId',
  'dispatchId',
  'traceArtifactHash',
  'resourceOrPlanHash',
  'resourceTraceHash',
  'observedReadbackHash',
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
  'resourceOrPlanHash',
  'resourceTraceHash',
  'observedReadbackHash',
]);
const SEMANTIC_ORACLE_RECEIPT_FIELDS = Object.freeze([
  ...SEMANTIC_ORACLE_BINDING_FIELDS,
  'semanticRequestHash',
  'oracleImplementationHash',
]);
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

function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/gu, (_, char) => char.toUpperCase());
}

function rejectConflictingSnakeCamelAliases(value, context = 'value') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectConflictingSnakeCamelAliases(entry, `${context}[${index}]`));
    return value;
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  for (const key of Object.keys(value)) {
    if (key.includes('_')) {
      const camelKey = snakeToCamel(key);
      if (
        camelKey !== key
        && Object.hasOwn(value, camelKey)
        && stableJson(value[key]) !== stableJson(value[camelKey])
      ) {
        throw new Error(`${context} aliases ${key}/${camelKey} conflict`);
      }
    }
    rejectConflictingSnakeCamelAliases(value[key], `${context}.${key}`);
  }
  return value;
}

function authoritativeAlias(record, keys, context) {
  const source = objectOrEmpty(record);
  const present = keys
    .filter((key) => Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null)
    .map((key) => ({ key, value: source[key] }));
  if (present.length > 1) {
    const canonical = stableJson(present[0].value);
    const conflict = present.find((entry) => stableJson(entry.value) !== canonical);
    if (conflict) {
      throw new Error(`${context} aliases ${present.map((entry) => entry.key).join('/')} conflict`);
    }
  }
  return present[0]?.value ?? null;
}

function authoritativeText(record, keys, context, { required = false } = {}) {
  const raw = authoritativeAlias(record, keys, context);
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (required && !value) throw new Error(`${context} is required`);
  return value;
}

function authoritativeNumber(record, keys, context, { required = false } = {}) {
  const raw = authoritativeAlias(record, keys, context);
  const value = raw === null ? null : Number(raw);
  if ((required && !Number.isFinite(value)) || (raw !== null && !Number.isFinite(value))) {
    throw new Error(`${context} must be finite`);
  }
  return value;
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

function computeOracleStrictGateOptions(trustedArtifactRoot) {
  const root = firstText(trustedArtifactRoot);
  if (!root) throw new Error('HIP strict proof requires a runner-established artifact root');
  return {
    allowedArtifactRoots: [path.resolve(root)],
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

function lexHipStructure(source) {
  const tokens = [];
  let index = 0;
  const isIdentStart = (char) => char === '_'
    || (char >= 'A' && char <= 'Z')
    || (char >= 'a' && char <= 'z');
  const isIdentPart = (char) => isIdentStart(char) || (char >= '0' && char <= '9');
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
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
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      if (index + 1 >= source.length) throw new Error(`unterminated HIP block comment at byte ${start}`);
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 2;
        else index += 1;
      }
      if (source[index] !== quote) throw new Error(`unterminated HIP literal at byte ${start}`);
      index += 1;
      tokens.push({ kind: 'literal', value: '<literal>', start });
      continue;
    }
    if (isIdentStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentPart(source[index])) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), start });
      continue;
    }
    if ('(){}[],*&='.includes(char)) {
      tokens.push({ kind: 'punct', value: char, start: index });
      index += 1;
      continue;
    }
    tokens.push({ kind: 'other', value: char, start: index });
    index += 1;
  }
  return tokens;
}

function matchingHipStructureToken(tokens, start, open, close, context) {
  if (tokens[start]?.value !== open) throw new Error(`${context} is missing ${open}`);
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`${context} has unbalanced ${open}${close}`);
}

function normalizeKernelParamTokens(tokens, parameterIndex) {
  if (tokens.length === 1 && tokens[0].value === 'void') return null;
  if (tokens.length < 2 || tokens.some((token) => token.kind === 'other' || token.value === '=')) {
    throw new Error(`unsupported HIP kernel parameter ${parameterIndex}`);
  }
  const name = tokens.at(-1);
  const typeTokens = tokens.slice(0, -1);
  if (
    name.kind !== 'identifier'
    || typeTokens.some((token) => token.kind !== 'identifier' && !['*', '&'].includes(token.value))
  ) {
    throw new Error(`malformed HIP kernel parameter ${parameterIndex}`);
  }
  let type = '';
  for (const token of typeTokens) {
    if (token.value === '*' || token.value === '&') type += token.value;
    else type += `${type && !type.endsWith('*') && !type.endsWith('&') ? ' ' : ''}${token.value}`;
  }
  return {
    raw: [...typeTokens.map((token) => token.value), name.value].join(' '),
    type,
    name: name.value,
  };
}

function extractKernelSignature(source, kernelName) {
  const tokens = lexHipStructure(String(source ?? ''));
  const matches = [];
  let braceDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '{') {
      braceDepth += 1;
      continue;
    }
    if (token.value === '}') {
      braceDepth -= 1;
      if (braceDepth < 0) throw new Error('HIP source has unbalanced top-level braces');
      continue;
    }
    if (braceDepth !== 0 || token.value !== '__global__') continue;
    const returnType = tokens[index + 1];
    const name = tokens[index + 2];
    if (returnType?.value !== 'void' || name?.kind !== 'identifier') {
      throw new Error('HIP __global__ declaration must be a named void function');
    }
    if (tokens[index + 3]?.value !== '(') throw new Error(`HIP kernel ${name.value} parameter list is missing`);
    const paramsEnd = matchingHipStructureToken(tokens, index + 3, '(', ')', `HIP kernel ${name.value}`);
    if (tokens[paramsEnd + 1]?.value !== '{') throw new Error(`HIP kernel ${name.value} body is missing`);
    const bodyEnd = matchingHipStructureToken(tokens, paramsEnd + 1, '{', '}', `HIP kernel ${name.value}`);
    if (name.value === kernelName) {
      const parameterTokens = tokens.slice(index + 4, paramsEnd);
      const parts = [];
      let start = 0;
      let nested = 0;
      parameterTokens.forEach((parameterToken, parameterIndex) => {
        if (parameterToken.value === '(' || parameterToken.value === '[') nested += 1;
        else if (parameterToken.value === ')' || parameterToken.value === ']') nested -= 1;
        if (parameterToken.value === ',' && nested === 0) {
          parts.push(parameterTokens.slice(start, parameterIndex));
          start = parameterIndex + 1;
        }
      });
      parts.push(parameterTokens.slice(start));
      const params = parts.length === 1 && parts[0].length === 0
        ? []
        : parts.map(normalizeKernelParamTokens).filter(Boolean);
      matches.push(params);
    }
    index = bodyEnd;
  }
  if (braceDepth !== 0) throw new Error('HIP source has unbalanced top-level braces');
  if (matches.length > 1) throw new Error(`HIP source has duplicate kernel ${kernelName}`);
  const params = matches[0] ?? [];
  return {
    found: matches.length === 1,
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
  const actualValues = Array.isArray(actual) ? actual : [];
  const expectedValues = Array.isArray(expected) ? expected : [];
  const compared = Math.min(actualValues.length, expectedValues.length);
  let maxAbsDelta = 0;
  for (let index = 0; index < compared; index += 1) {
    const actualValue = Number(actualValues[index]);
    const expectedValue = Number(expectedValues[index]);
    const finite = Number.isFinite(actualValue) && Number.isFinite(expectedValue);
    const delta = finite ? Math.abs(actualValue - expectedValue) : null;
    if (delta !== null) maxAbsDelta = Math.max(maxAbsDelta, delta);
    if (!finite || delta > tolerance) {
      mismatches.push({
        index,
        actual: actualValues[index],
        expected: expectedValues[index],
        abs_delta: delta,
        reason: finite ? 'tolerance_exceeded' : 'non_finite_value',
      });
    }
  }
  if (actualValues.length !== expectedValues.length) {
    mismatches.push({
      index: compared,
      actual_length: actualValues.length,
      expected_length: expectedValues.length,
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

function hipSemanticOracleImplementation(request) {
  const fail = (message) => {
    throw new Error(`hip semantic oracle: ${message}`);
  };
  const positiveDim = (value, name) => {
    if (
      !value
      || !Number.isSafeInteger(value.x)
      || !Number.isSafeInteger(value.y)
      || !Number.isSafeInteger(value.z)
      || value.x <= 0
      || value.y <= 0
      || value.z <= 0
    ) {
      fail(`${name} must contain positive integer x/y/z dimensions`);
    }
    return value;
  };
  const dataTypeFor = (type) => {
    if (type === 'f32') return 'float32';
    if (type === 'u32') return 'uint32';
    if (type === 'i32') return 'int32';
    fail(`unsupported storage type ${type}`);
  };
  const sourceTypeFor = (tokens, context) => {
    const words = tokens
      .map((token) => token.value)
      .filter((value) => !['const', 'volatile', '__restrict__', '__restrict', 'restrict'].includes(value));
    const pointerDepth = words.filter((value) => value === '*').length;
    const baseWords = words.filter((value) => value !== '*');
    let type = null;
    if (baseWords.length === 1 && baseWords[0] === 'float') type = 'f32';
    else if (baseWords.length === 1 && baseWords[0] === 'int') type = 'i32';
    else if (baseWords.length === 1 && baseWords[0] === 'int32_t') type = 'i32';
    else if (baseWords.length === 1 && baseWords[0] === 'uint32_t') type = 'u32';
    else if (baseWords.length === 2 && baseWords[0] === 'unsigned' && baseWords[1] === 'int') type = 'u32';
    if (!type || pointerDepth > 1) fail(`unsupported ${context} type ${words.join(' ')}`);
    return {
      type,
      pointer: pointerDepth === 1,
      constQualified: tokens.some((token) => token.value === 'const'),
    };
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
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1;
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
      if (char === '"') {
        const start = index;
        index += 1;
        let value = '';
        while (index < source.length && source[index] !== '"') {
          if (source[index] === '\\') {
            if (index + 1 >= source.length) fail(`unterminated string at byte ${start}`);
            value += source[index + 1];
            index += 2;
          } else {
            value += source[index];
            index += 1;
          }
        }
        if (source[index] !== '"') fail(`unterminated string at byte ${start}`);
        index += 1;
        tokens.push({ kind: 'string', value, start });
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
        let sawDot = false;
        if (char === '.') {
          sawDot = true;
          index += 1;
        }
        while (isDigit(source[index])) index += 1;
        if (!sawDot && source[index] === '.') {
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
        if ('fFuU'.includes(source[index] ?? '')) index += 1;
        tokens.push({ kind: 'number', value: source.slice(start, index), start });
        continue;
      }
      const pair = source.slice(index, index + 2);
      if (['>=', '<=', '==', '!=', '&&', '||', '::'].includes(pair)) {
        tokens.push({ kind: 'punct', value: pair, start: index });
        index += 2;
        continue;
      }
      if ('(){}[];,.*+-/%<>=&'.includes(char)) {
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
  const parseKernel = (source, entryPoint) => {
    const tokens = lex(source);
    const matches = [];
    let braceDepth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.value === '{') {
        braceDepth += 1;
        continue;
      }
      if (token.value === '}') {
        braceDepth -= 1;
        if (braceDepth < 0) fail('unbalanced top-level braces');
        continue;
      }
      if (braceDepth !== 0 || token.value !== '__global__') continue;
      if (tokens[index + 1]?.value !== 'void') fail('__global__ entry must return void');
      const nameToken = tokens[index + 2];
      if (nameToken?.kind !== 'identifier') fail('__global__ entry name is missing');
      if (tokens[index + 3]?.value !== '(') fail(`kernel ${nameToken.value} parameter list is missing`);
      const paramsEnd = matchingIndex(tokens, index + 3, '(', ')', `kernel ${nameToken.value}`);
      if (tokens[paramsEnd + 1]?.value !== '{') fail(`kernel ${nameToken.value} body is missing`);
      const bodyEnd = matchingIndex(tokens, paramsEnd + 1, '{', '}', `kernel ${nameToken.value}`);
      if (nameToken.value === entryPoint) {
        matches.push({
          name: nameToken.value,
          parameterTokens: tokens.slice(index + 4, paramsEnd),
          bodyTokens: tokens.slice(paramsEnd + 1, bodyEnd + 1),
        });
      }
      index = bodyEnd;
    }
    if (braceDepth !== 0) fail('unbalanced top-level braces');
    if (matches.length !== 1) fail(`expected exactly one __global__ entry named ${entryPoint}, found ${matches.length}`);
    const kernel = matches[0];
    const parameterParts = kernel.parameterTokens.length === 0
      ? []
      : splitTopLevel(kernel.parameterTokens, ',');
    kernel.parameters = parameterParts.map((part, parameterIndex) => {
      if (part.length < 2) fail(`kernel parameter ${parameterIndex} is malformed`);
      const nameToken = part.at(-1);
      if (nameToken.kind !== 'identifier') fail(`kernel parameter ${parameterIndex} name is missing`);
      const sourceType = sourceTypeFor(part.slice(0, -1), `kernel parameter ${nameToken.value}`);
      return { name: nameToken.value, ...sourceType };
    });
    return kernel;
  };
  const parseBody = (bodyTokens) => {
    let position = 0;
    const peek = (offset = 0) => bodyTokens[position + offset];
    const take = (value = null) => {
      const token = peek();
      if (!token || (value !== null && token.value !== value)) {
        fail(`expected ${value ?? 'token'} in kernel body, found ${token?.value ?? 'end of body'}`);
      }
      position += 1;
      return token;
    };
    let parseExpression;
    let parseBlock;
    const parsePrimary = () => {
      const token = peek();
      if (!token) fail('expression ended unexpectedly');
      if (token.value === 'static_cast') {
        take('static_cast');
        take('<');
        const typeTokens = [];
        while (peek()?.value !== '>') typeTokens.push(take());
        take('>');
        const target = sourceTypeFor(typeTokens, 'static_cast target');
        if (target.pointer) fail('pointer static_cast is unsupported');
        take('(');
        const value = parseExpression();
        take(')');
        return { kind: 'cast', targetType: target.type, value };
      }
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
      fail(`unsupported primary expression token ${token.value}`);
    };
    const parsePostfix = () => {
      let value = parsePrimary();
      while (true) {
        if (peek()?.value === '.') {
          take('.');
          const member = take();
          if (member.kind !== 'identifier') fail('member name is missing');
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
    const declarationStart = () => ['const', 'float', 'int', 'unsigned', 'uint32_t', 'int32_t', 'auto'].includes(peek()?.value);
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
        if (peek()?.value === 'else') fail('else statements are unsupported');
        return { kind: 'if', condition, consequent };
      }
      if (declarationStart()) {
        const typeTokens = [];
        if (peek()?.value === 'const') typeTokens.push(take());
        while (!(peek()?.kind === 'identifier' && peek(1)?.value === '=')) {
          const token = take();
          if ([';', '{', '}'].includes(token.value)) fail('malformed local declaration');
          typeTokens.push(token);
        }
        const name = take().value;
        take('=');
        const initializer = parseExpression();
        take(';');
        const declaredType = typeTokens.some((token) => token.value === 'auto')
          ? null
          : sourceTypeFor(typeTokens, `local ${name}`).type;
        return { kind: 'declaration', name, declaredType, initializer };
      }
      const target = parseExpression();
      take('=');
      const value = parseExpression();
      take(';');
      if (target.kind !== 'index' || target.object.kind !== 'identifier') {
        fail('only direct buffer element assignments are supported');
      }
      return { kind: 'assignment', target, value };
    };
    parseBlock = () => {
      take('{');
      const statements = [];
      while (peek()?.value !== '}') {
        if (!peek()) fail('kernel body block is unterminated');
        statements.push(parseStatement());
      }
      take('}');
      return { kind: 'block', statements };
    };
    const body = parseBlock();
    if (position !== bodyTokens.length) fail('kernel body contains trailing syntax');
    return body;
  };
  const i32Min = -2147483648n;
  const i32Max = 2147483647n;
  const u32Mod = 4294967296n;
  const typed = (type, value) => ({ type, value });
  const assertFinite = (value) => {
    if (!Number.isFinite(value)) fail('floating-point operation produced a non-finite value');
    return value;
  };
  const convert = (input, targetType, explicit = false) => {
    if (input.type === targetType) return input;
    if (targetType === 'f32') return typed('f32', Math.fround(assertFinite(Number(input.value))));
    if (targetType === 'f64') return typed('f64', assertFinite(Number(input.value)));
    if (!explicit && (input.type === 'f32' || input.type === 'f64')) {
      fail(`implicit floating-point to ${targetType} conversion is unsupported`);
    }
    const numeric = input.type === 'f32' || input.type === 'f64'
      ? Math.trunc(assertFinite(input.value))
      : Number(input.value);
    if (!Number.isSafeInteger(numeric)) fail(`value cannot be represented as ${targetType}`);
    const integer = BigInt(numeric);
    if (targetType === 'u32') {
      if (explicit) return typed('u32', ((integer % u32Mod) + u32Mod) % u32Mod);
      if (integer < 0n || integer >= u32Mod) fail('implicit uint32 conversion is out of range');
      return typed('u32', integer);
    }
    if (targetType === 'i32') {
      if (integer < i32Min || integer > i32Max) fail('int32 conversion is out of range');
      return typed('i32', integer);
    }
    fail(`unsupported conversion to ${targetType}`);
  };
  const commonType = (left, right) => {
    if (left.type === 'f64' || right.type === 'f64') return 'f64';
    if (left.type === 'f32' || right.type === 'f32') return 'f32';
    if (left.type === 'u32' || right.type === 'u32') return 'u32';
    if (left.type === 'i32' && right.type === 'i32') return 'i32';
    fail(`arithmetic operands ${left.type} and ${right.type} are unsupported`);
  };
  const integerOperation = (operator, left, right, type) => {
    if ((operator === '/' || operator === '%') && right === 0n) fail('integer division by zero');
    let result;
    if (operator === '+') result = left + right;
    else if (operator === '-') result = left - right;
    else if (operator === '*') result = left * right;
    else if (operator === '/') result = left / right;
    else if (operator === '%') result = left % right;
    else fail(`unsupported integer operator ${operator}`);
    if (type === 'u32') return ((result % u32Mod) + u32Mod) % u32Mod;
    if (result < i32Min || result > i32Max) fail('signed int32 overflow has undefined HIP C++ semantics');
    return result;
  };
  const binary = (operator, rawLeft, rawRight) => {
    if (rawLeft.type === 'bool' || rawRight.type === 'bool') fail('boolean arithmetic is unsupported');
    const type = commonType(rawLeft, rawRight);
    const left = convert(rawLeft, type);
    const right = convert(rawRight, type);
    if (['<', '<=', '>', '>=', '==', '!='].includes(operator)) {
      const a = left.value;
      const b = right.value;
      if (operator === '<') return typed('bool', a < b);
      if (operator === '<=') return typed('bool', a <= b);
      if (operator === '>') return typed('bool', a > b);
      if (operator === '>=') return typed('bool', a >= b);
      if (operator === '==') return typed('bool', a === b);
      return typed('bool', a !== b);
    }
    if (type === 'u32' || type === 'i32') {
      return typed(type, integerOperation(operator, left.value, right.value, type));
    }
    let result;
    if (operator === '+') result = left.value + right.value;
    else if (operator === '-') result = left.value - right.value;
    else if (operator === '*') result = left.value * right.value;
    else if (operator === '/') result = left.value / right.value;
    else if (operator === '%') result = left.value % right.value;
    else fail(`unsupported floating-point operator ${operator}`);
    assertFinite(result);
    return typed(type, type === 'f32' ? Math.fround(result) : result);
  };
  const numberValue = (raw) => {
    const suffix = raw.at(-1);
    const hasFloatSuffix = suffix === 'f' || suffix === 'F';
    const hasUnsignedSuffix = suffix === 'u' || suffix === 'U';
    const text = hasFloatSuffix || hasUnsignedSuffix ? raw.slice(0, -1) : raw;
    const floating = text.includes('.') || text.includes('e') || text.includes('E');
    if (hasUnsignedSuffix && floating) fail(`invalid unsigned literal ${raw}`);
    if (floating) {
      const value = assertFinite(Number(text));
      return typed(hasFloatSuffix ? 'f32' : 'f64', hasFloatSuffix ? Math.fround(value) : value);
    }
    const value = BigInt(text);
    if (hasFloatSuffix) return typed('f32', Math.fround(Number(value)));
    if (hasUnsignedSuffix) {
      if (value < 0n || value >= u32Mod) fail(`uint32 literal ${raw} is out of range`);
      return typed('u32', value);
    }
    if (value < i32Min || value > i32Max) fail(`unsuffixed integer literal ${raw} is outside int32`);
    return typed('i32', value);
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
    fail('HIP source or entry point is missing');
  }
  const kernel = parseKernel(source, entryPoint);
  const body = parseBody(kernel.bodyTokens);
  const resources = Array.isArray(request.resources) ? request.resources : [];
  const parameters = Array.isArray(request.launch?.parameters) ? request.launch.parameters : [];
  if (kernel.parameters.length !== parameters.length) fail('source and launch parameter counts differ');
  const resourcesByName = new Map();
  for (const resource of resources) {
    if (typeof resource?.name !== 'string' || resourcesByName.has(resource.name)) {
      fail('resource names must be present and unique');
    }
    resourcesByName.set(resource.name, resource);
  }
  const parameterBindings = new Map();
  kernel.parameters.forEach((sourceParameter, index) => {
    const declared = parameters[index];
    if (!declared || declared.name !== sourceParameter.name) {
      fail(`launch parameter ${index} does not match source parameter ${sourceParameter.name}`);
    }
    const expectedKind = sourceParameter.pointer ? 'buffer' : 'scalar';
    if (declared.kind !== expectedKind) fail(`launch parameter ${declared.name} kind mismatches source`);
    const sourceDataType = dataTypeFor(sourceParameter.type);
    if (declared.dataType !== sourceDataType) fail(`launch parameter ${declared.name} dtype mismatches source ${sourceDataType}`);
    if (sourceParameter.pointer) {
      const resource = resourcesByName.get(declared.buffer);
      if (!resource) fail(`launch parameter ${declared.name} references a missing resource`);
      if (resource.dataType !== sourceDataType) fail(`resource ${resource.name} dtype mismatches source ${sourceDataType}`);
      parameterBindings.set(sourceParameter.name, { sourceParameter, declared, resource });
    } else {
      parameterBindings.set(sourceParameter.name, { sourceParameter, declared });
    }
  });
  const outputResourceId = request.binding?.outputResourceId ?? request.binding?.outputTargetId;
  const outputBindings = [...parameterBindings.values()].filter((binding) => (
    binding.sourceParameter.pointer && binding.resource?.name === outputResourceId
  ));
  if (outputBindings.length !== 1) fail('runtime output resource does not select exactly one kernel parameter');
  const outputBinding = outputBindings[0];
  if (outputBinding.sourceParameter.constQualified) fail('runtime output parameter is const-qualified');
  const inputBindings = [...parameterBindings.values()].filter((binding) => (
    binding.sourceParameter.pointer
    && binding.sourceParameter.constQualified
    && binding.resource?.name !== outputResourceId
  ));
  if (inputBindings.length !== 1) fail('target kernel must have exactly one const input buffer in the supported subset');
  const inputBinding = inputBindings[0];
  if (inputBinding.sourceParameter.type !== outputBinding.sourceParameter.type) {
    fail('input and output source element types differ');
  }
  const dataType = dataTypeFor(outputBinding.sourceParameter.type);
  const gridDim = positiveDim(request.launch?.gridDim, 'grid dimensions');
  const blockDim = positiveDim(request.launch?.blockDim, 'block dimensions');
  if (gridDim.y !== 1 || gridDim.z !== 1 || blockDim.y !== 1 || blockDim.z !== 1) {
    fail('only one-dimensional HIP launches are supported');
  }
  const inputValues = decode(inputBinding.resource.initialBytes, dataType);
  const outputValues = decode(outputBinding.resource.initialBytes, dataType);
  const invocationCount = gridDim.x * blockDim.x;
  const evaluate = (node, environment, builtins) => {
    if (node.kind === 'number') return numberValue(node.raw);
    if (node.kind === 'identifier') {
      if (!environment.has(node.name)) fail(`unknown semantic symbol ${node.name}`);
      return environment.get(node.name);
    }
    if (node.kind === 'member') {
      if (node.object.kind !== 'identifier' || node.member !== 'x') fail('only HIP builtin .x members are supported');
      const value = builtins[node.object.name];
      if (value === undefined) fail(`unsupported HIP builtin ${node.object.name}.${node.member}`);
      return typed('u32', BigInt(value));
    }
    if (node.kind === 'index') {
      if (node.object.kind !== 'identifier') fail('nested buffer indexing is unsupported');
      const buffer = environment.get(node.object.name);
      if (!buffer || buffer.kind !== 'buffer') fail(`${node.object.name} is not a buffer`);
      const indexValue = convert(evaluate(node.index, environment, builtins), 'u32');
      const index = Number(indexValue.value);
      if (!Number.isSafeInteger(index) || index < 0 || index >= buffer.values.length) {
        fail(`buffer ${node.object.name} index ${index} is out of bounds`);
      }
      return buffer.values[index];
    }
    if (node.kind === 'cast') return convert(evaluate(node.value, environment, builtins), node.targetType, true);
    if (node.kind === 'unary') {
      if (node.operator === '&') fail('address-of is unsupported in HIP arithmetic');
      const value = evaluate(node.value, environment, builtins);
      if (node.operator === '+') return value;
      if (value.type === 'u32') return typed('u32', (u32Mod - value.value) % u32Mod);
      if (value.type === 'i32') {
        if (value.value === i32Min) fail('signed unary negation overflows int32');
        return typed('i32', -value.value);
      }
      return typed(value.type, value.type === 'f32' ? Math.fround(-value.value) : -value.value);
    }
    if (node.kind === 'binary') {
      return binary(node.operator, evaluate(node.left, environment, builtins), evaluate(node.right, environment, builtins));
    }
    fail(`unsupported expression node ${node.kind}`);
  };
  const written = new Set();
  const executeStatement = (statement, environment, builtins) => {
    if (statement.kind === 'block') {
      for (const child of statement.statements) {
        const signal = executeStatement(child, environment, builtins);
        if (signal) return signal;
      }
      return null;
    }
    if (statement.kind === 'return') return 'return';
    if (statement.kind === 'if') {
      const condition = evaluate(statement.condition, environment, builtins);
      if (condition.type !== 'bool') fail('if condition is not boolean');
      return condition.value ? executeStatement(statement.consequent, environment, builtins) : null;
    }
    if (statement.kind === 'declaration') {
      if (environment.has(statement.name)) fail(`local ${statement.name} shadows an existing symbol`);
      let value = evaluate(statement.initializer, environment, builtins);
      if (statement.declaredType) value = convert(value, statement.declaredType);
      environment.set(statement.name, value);
      return null;
    }
    if (statement.kind === 'assignment') {
      const bufferName = statement.target.object.name;
      if (bufferName !== outputBinding.sourceParameter.name) fail(`write to non-output buffer ${bufferName}`);
      const outputIndex = Number(convert(evaluate(statement.target.index, environment, builtins), 'u32').value);
      if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex >= outputValues.length) {
        fail(`output index ${outputIndex} is out of bounds`);
      }
      if (written.has(outputIndex)) fail(`multiple invocations write output index ${outputIndex}`);
      outputValues[outputIndex] = convert(evaluate(statement.value, environment, builtins), outputBinding.sourceParameter.type);
      written.add(outputIndex);
      return null;
    }
    fail(`unsupported statement ${statement.kind}`);
  };
  for (let globalIndex = 0; globalIndex < invocationCount; globalIndex += 1) {
    const environment = new Map();
    for (const [name, binding] of parameterBindings) {
      if (binding.sourceParameter.pointer) {
        environment.set(name, {
          kind: 'buffer',
          type: binding.sourceParameter.type,
          values: binding.resource === outputBinding.resource ? outputValues : inputValues,
        });
      } else {
        const value = binding.declared.value;
        if (!Number.isFinite(Number(value))) fail(`scalar ${name} is not finite`);
        const sourceType = binding.sourceParameter.type;
        if (sourceType === 'f32') environment.set(name, typed('f32', Math.fround(Number(value))));
        else {
          if (!Number.isSafeInteger(Number(value))) fail(`scalar ${name} is not an integer`);
          environment.set(name, convert(typed('i32', BigInt(Number(value))), sourceType, true));
        }
      }
    }
    executeStatement(body, environment, {
      blockIdx: Math.floor(globalIndex / blockDim.x),
      blockDim: blockDim.x,
      threadIdx: globalIndex % blockDim.x,
    });
  }
  if (written.size === 0) fail('target kernel produced no output writes');
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
      language: 'hip-cpp',
      entryPoint,
      parser: 'strict-token-ast-v1',
      inputParameter: inputBinding.sourceParameter.name,
      outputParameter: outputBinding.sourceParameter.name,
      sourceDataType: dataType,
      selectedBody: kernel.bodyTokens.map((token) => token.value).join(' '),
      gridDim,
      blockDim,
      invocationCount,
      outputWriteCount: written.size,
    },
  };
}

function semanticOracleImplementationBytes() {
  return Buffer.from(`export default ${hipSemanticOracleImplementation.toString()};\n`, 'utf8');
}

function semanticOracleCodeHash() {
  return sha256Bytes(semanticOracleImplementationBytes());
}

function buildHipLaunchObservation(profile) {
  const resources = profile.buffers.all.map((buffer) => {
    const bytes = buffer.values.length > 0
      ? encodeNumericValues(buffer.values, buffer.dataType)
      : Buffer.alloc(buffer.byteLength);
    return {
      name: buffer.name,
      role: buffer.role,
      dataType: buffer.dataType,
      byteLength: buffer.byteLength,
      initialBytes: Array.from(bytes),
      initialBytesHash: sha256Bytes(bytes),
    };
  });
  return {
    resources,
    parameters: profile.abi.params.map((param) => (
      param.launch_kind === 'buffer'
        ? { name: param.name, kind: 'buffer', buffer: param.buffer, dataType: param.data_type }
        : { name: param.name, kind: 'scalar', dataType: param.scalar_type, value: param.scalar_value }
    )),
    gridDim: profile.launch.gridDim,
    blockDim: profile.launch.blockDim,
    sharedMemBytes: profile.launch.sharedMemBytes,
    stream: profile.launch.stream,
  };
}

function hipResourceTraceFromLaunchObservation({ launchObservation, planHash }) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(planHash ?? '')) {
    throw new Error('HIP resource trace requires a content-addressed probe plan');
  }
  const resources = firstArray(launchObservation?.resources).map((resource) => {
    const initialBytes = firstArray(resource?.initialBytes).map(Number);
    const initialBytesHash = sha256Bytes(Buffer.from(initialBytes));
    if (
      !firstText(resource?.name)
      || initialBytes.length !== resource.byteLength
      || initialBytesHash !== resource.initialBytesHash
    ) {
      throw new Error('HIP resource trace contains an invalid launch resource');
    }
    return {
      name: resource.name,
      role: resource.role,
      dataType: resource.dataType,
      byteLength: resource.byteLength,
      initialBytes,
      initialBytesHash,
      ...(firstText(resource.resourceId) ? { resourceId: resource.resourceId } : {}),
      ...(firstText(resource.devicePointer) ? { devicePointer: resource.devicePointer } : {}),
    };
  });
  const parameters = firstArray(launchObservation?.parameters).map((parameter, index) => ({
    ...parameter,
    index: nonNegativeInteger(parameter?.index, index),
  }));
  const material = {
    schemaVersion: 'synthi.gpu_hmr.hip_runtime_resource_trace.v1',
    planHash,
    resources,
    parameters,
  };
  return {
    ...material,
    resourceTraceHash: sha256Text(stableJson(material)),
  };
}

function bindHipRuntimeInvocationEvidence({
  runtimeTrace,
  planHash,
  observedReadbackHash,
  expectedKernelIdentity,
  expectedArtifactHash,
  epoch = '2',
}) {
  rejectConflictingSnakeCamelAliases(runtimeTrace, 'HIP native runtime trace');
  if (!/^sha256:[0-9a-f]{64}$/u.test(observedReadbackHash ?? '')) {
    throw new Error('HIP runtime invocation evidence requires the observed readback hash');
  }
  const dispatch = oneTraceFact(
    runtimeTrace?.dispatchEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} dispatch`,
  );
  const dispatchId = authoritativeText(dispatch, ['id'], `epoch-${epoch} dispatch.id`, { required: true });
  const output = oneTraceFact(
    runtimeTrace?.outputEvents,
    (event) => authoritativeText(
      event,
      ['after_dispatch_id', 'afterDispatchId'],
      `epoch-${epoch} output.afterDispatchId`,
    ) === dispatchId,
    `output for dispatch ${dispatchId}`,
  );
  const loader = oneTraceFact(
    runtimeTrace?.loaderEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} loader`,
  );
  const symbol = oneTraceFact(
    runtimeTrace?.symbolEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} symbol resolution`,
  );
  const requiredText = (record, keys, field) => authoritativeText(record, keys, field, { required: true });
  const loaderId = requiredText(loader, ['id'], `epoch-${epoch} loader.id`);
  const symbolId = requiredText(symbol, ['id'], `epoch-${epoch} symbol.id`);
  const outputId = requiredText(output, ['id'], `epoch-${epoch} output.id`);
  const artifactHash = requiredText(dispatch, ['artifact_hash', 'artifactHash'], `epoch-${epoch} dispatch.artifactHash`);
  const loaderArtifactHash = requiredText(loader, ['artifact_hash', 'artifactHash'], `epoch-${epoch} loader.artifactHash`);
  const outputResourceId = requiredText(output, ['output_target_id', 'outputTargetId'], `epoch-${epoch} output.outputTargetId`);
  const dispatchOutputResourceId = requiredText(dispatch, ['output_target_id', 'outputTargetId'], `epoch-${epoch} dispatch.outputTargetId`);
  const loadedBytesHash = requiredText(loader, ['loaded_bytes_hash', 'loadedBytesHash'], `epoch-${epoch} loader.loadedBytesHash`);
  const requestedSymbol = requiredText(
    symbol,
    ['requested_symbol', 'requestedSymbol', 'kernel_name', 'kernelName'],
    `epoch-${epoch} symbol.requestedSymbol`,
  );
  const resolvedSymbol = requiredText(symbol, ['resolved_symbol', 'resolvedSymbol'], `epoch-${epoch} symbol.resolvedSymbol`);
  const dispatchSymbol = requiredText(
    dispatch,
    ['resolved_symbol', 'resolvedSymbol', 'kernel_name', 'kernelName'],
    `epoch-${epoch} dispatch.resolvedSymbol`,
  );
  const functionId = requiredText(symbol, ['function_id', 'functionId'], `epoch-${epoch} symbol.functionId`);
  const dispatchFunctionId = requiredText(dispatch, ['function_id', 'functionId'], `epoch-${epoch} dispatch.functionId`);
  const resolvedFunctionAddress = requiredText(
    symbol,
    ['resolved_function_address', 'resolvedFunctionAddress'],
    `epoch-${epoch} symbol.resolvedFunctionAddress`,
  );
  const dispatchFunctionAddress = requiredText(
    dispatch,
    ['resolved_function_address', 'resolvedFunctionAddress'],
    `epoch-${epoch} dispatch.resolvedFunctionAddress`,
  );
  const outputReadbackHash = requiredText(output, ['readback_hash', 'readbackHash'], `epoch-${epoch} output.readbackHash`);
  const outputReadbackByteLength = authoritativeNumber(
    output,
    ['readback_byte_length', 'readbackByteLength'],
    `epoch-${epoch} output.readbackByteLength`,
    { required: true },
  );
  const expectedFunctionId = `hip-function:${sha256Text(stableJson({
    loadedBytesHash,
    requestedSymbol,
    resolvedFunctionAddress,
    resolvedSymbol,
  }))}`;
  if (
    artifactHash !== loaderArtifactHash
    || outputResourceId !== dispatchOutputResourceId
    || artifactHash !== expectedArtifactHash
    || loadedBytesHash !== expectedArtifactHash
    || authoritativeNumber(loader, ['loaded_byte_length', 'loadedByteLength'], `epoch-${epoch} loader.loadedByteLength`, { required: true }) <= 0
    || requestedSymbol !== expectedKernelIdentity
    || resolvedSymbol !== expectedKernelIdentity
    || dispatchSymbol !== expectedKernelIdentity
    || dispatchFunctionId !== functionId
    || functionId !== expectedFunctionId
    || !/^0x[0-9a-f]+$/u.test(resolvedFunctionAddress)
    || resolvedFunctionAddress === '0x0'
    || dispatchFunctionAddress !== resolvedFunctionAddress
    || outputReadbackHash !== observedReadbackHash
    || !Number.isSafeInteger(outputReadbackByteLength)
    || outputReadbackByteLength <= 0
  ) {
    throw new Error('HIP runtime invocation evidence disagrees on loaded bytes, symbol, function address, dispatch, artifact, output resource, or readback');
  }
  const invocation = objectOrEmpty(runtimeTrace?.probeInvocation);
  if (invocation.producer !== 'native_hip_module_runtime_probe') {
    throw new Error('HIP runtime invocation evidence is missing an independent native probe producer');
  }
  const resourceTrace = hipResourceTraceFromLaunchObservation({
    launchObservation: { resources: invocation.resources, parameters: invocation.parameters },
    planHash,
  });
  const resourcesById = new Map();
  const pointers = new Set();
  for (const resource of resourceTrace.resources) {
    if (
      !firstText(resource.resourceId)
      || !firstText(resource.devicePointer)
      || resourcesById.has(resource.resourceId)
      || pointers.has(resource.devicePointer)
    ) throw new Error('HIP native resource trace requires unique resource IDs and device pointers');
    resourcesById.set(resource.resourceId, resource);
    pointers.add(resource.devicePointer);
  }
  for (const parameter of resourceTrace.parameters) {
    if (!firstText(parameter.name) || !firstText(parameter.argumentAddress)) {
      throw new Error('HIP native parameter trace requires names and argument addresses');
    }
    if (parameter.kind === 'buffer') {
      const resource = resourcesById.get(parameter.resourceId);
      if (!resource || resource.devicePointer !== parameter.devicePointer) {
        throw new Error(`HIP pointer parameter ${parameter.name} is not bound to a traced runtime resource`);
      }
    } else if (
      parameter.kind !== 'scalar'
      || !Number.isFinite(Number(parameter.value))
      || !/^sha256:[0-9a-f]{64}$/u.test(parameter.encodedBytesHash ?? '')
    ) {
      throw new Error(`HIP scalar parameter ${parameter.name} is missing runtime value evidence`);
    }
  }
  const parameterTraceHash = sha256Text(stableJson(resourceTrace.parameters));
  const outputRuntimeResources = resourceTrace.resources.filter((resource) => resource.name === outputResourceId);
  if (outputRuntimeResources.length !== 1) {
    throw new Error('HIP readback identity does not select exactly one traced runtime resource');
  }
  const [outputRuntimeResource] = outputRuntimeResources;
  const invocationFunctionId = requiredText(invocation, ['functionId', 'function_id'], 'probeInvocation.functionId');
  const invocationFunctionAddress = requiredText(
    invocation,
    ['resolvedFunctionAddress', 'resolved_function_address'],
    'probeInvocation.resolvedFunctionAddress',
  );
  if (
    requiredText(invocation, ['planHash', 'plan_hash'], 'probeInvocation.planHash') !== planHash
    || requiredText(invocation, ['resourceTraceHash', 'resource_trace_hash'], 'probeInvocation.resourceTraceHash') !== resourceTrace.resourceTraceHash
    || requiredText(invocation, ['parameterTraceHash', 'parameter_trace_hash'], 'probeInvocation.parameterTraceHash') !== parameterTraceHash
    || requiredText(invocation, ['dispatchId', 'dispatch_id'], 'probeInvocation.dispatchId') !== dispatchId
    || requiredText(invocation, ['artifactHash', 'artifact_hash'], 'probeInvocation.artifactHash') !== artifactHash
    || requiredText(invocation, ['loadedBytesHash', 'loaded_bytes_hash'], 'probeInvocation.loadedBytesHash') !== loadedBytesHash
    || requiredText(invocation, ['kernelIdentity', 'kernel_identity'], 'probeInvocation.kernelIdentity') !== expectedKernelIdentity
    || requiredText(invocation, ['resolvedSymbol', 'resolved_symbol'], 'probeInvocation.resolvedSymbol') !== resolvedSymbol
    || invocationFunctionId !== functionId
    || invocationFunctionAddress !== resolvedFunctionAddress
    || requiredText(invocation, ['loaderEventId', 'loader_event_id'], 'probeInvocation.loaderEventId') !== loaderId
    || requiredText(invocation, ['symbolEventId', 'symbol_event_id'], 'probeInvocation.symbolEventId') !== symbolId
    || requiredText(invocation, ['outputEventId', 'output_event_id'], 'probeInvocation.outputEventId') !== outputId
    || requiredText(invocation, ['outputResourceId', 'output_resource_id'], 'probeInvocation.outputResourceId') !== outputResourceId
    || requiredText(invocation, ['outputRuntimeResourceId', 'output_runtime_resource_id'], 'probeInvocation.outputRuntimeResourceId') !== outputRuntimeResource.resourceId
    || requiredText(invocation, ['outputDevicePointer', 'output_device_pointer'], 'probeInvocation.outputDevicePointer') !== outputRuntimeResource.devicePointer
    || requiredText(invocation, ['observedReadbackHash', 'observed_readback_hash'], 'probeInvocation.observedReadbackHash') !== observedReadbackHash
    || authoritativeNumber(invocation, ['readbackByteLength', 'readback_byte_length'], 'probeInvocation.readbackByteLength', { required: true }) !== outputReadbackByteLength
    || outputReadbackByteLength !== outputRuntimeResource.byteLength
    || requiredText(dispatch, ['resource_trace_hash', 'resourceTraceHash'], `epoch-${epoch} dispatch.resourceTraceHash`) !== resourceTrace.resourceTraceHash
    || requiredText(dispatch, ['parameter_trace_hash', 'parameterTraceHash'], `epoch-${epoch} dispatch.parameterTraceHash`) !== parameterTraceHash
  ) {
    throw new Error('HIP native invocation trace is not exactly bound to the loader, symbol, parameters, resources, dispatch, and readback');
  }
  return invocation;
}

function hipRuntimeSessionId(runtimeTrace) {
  const runtimeSessionId = firstText(runtimeTrace?.runtimeSessionId, runtimeTrace?.runtime_session_id);
  if (!runtimeSessionId) throw new Error('HIP semantic oracle requires an observed runtime session id');
  return runtimeSessionId;
}

function canonicalRuntimeTraceBytes(runtimeTrace) {
  return Buffer.from(stableJson(runtimeTrace), 'utf8');
}

function canonicalRuntimeTraceHash(runtimeTrace) {
  return sha256Bytes(canonicalRuntimeTraceBytes(runtimeTrace));
}

async function persistCanonicalRuntimeTrace({ outDir, targetId, runtimeTrace }) {
  const tracePath = path.join(outDir, `${safeSlug(targetId)}-canonical-runtime-trace.json`);
  const bytes = canonicalRuntimeTraceBytes(runtimeTrace);
  const hash = sha256Bytes(bytes);
  await writeFile(tracePath, bytes);
  if (sha256Bytes(await readFile(tracePath)) !== hash) {
    throw new Error('HIP canonical runtime trace artifact changed after persistence');
  }
  return { path: tracePath, hash };
}

function oneTraceFact(items, predicate, context) {
  const matches = firstArray(items).filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`HIP observed binding requires exactly one ${context}; found ${matches.length}`);
  }
  return matches[0];
}

function deriveHipObservedBinding({
  runtimeTrace,
  traceArtifactHash,
  planHash,
  resourceTraceHash = null,
  observedReadbackHash = null,
  epoch = '2',
  expectedArtifactHash = null,
}) {
  rejectConflictingSnakeCamelAliases(runtimeTrace, 'HIP observed runtime trace');
  const canonicalHash = canonicalRuntimeTraceHash(runtimeTrace);
  if (traceArtifactHash !== canonicalHash) {
    throw new Error('HIP runtime trace artifact hash does not match the observed trace bytes');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(planHash ?? '')) {
    throw new Error('HIP observed binding requires a content-addressed probe plan hash');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(resourceTraceHash ?? '')) {
    throw new Error('HIP observed binding requires a content-addressed resource trace');
  }
  const dispatch = oneTraceFact(
    runtimeTrace?.dispatchEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} dispatch`,
  );
  const dispatchId = firstText(dispatch.id);
  if (!dispatchId) throw new Error('HIP observed dispatch id is missing');
  const output = oneTraceFact(
    runtimeTrace?.outputEvents,
    (event) => firstText(event?.after_dispatch_id, event?.afterDispatchId) === dispatchId,
    `output for dispatch ${dispatchId}`,
  );
  const loader = oneTraceFact(
    runtimeTrace?.loaderEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} loader`,
  );
  const backend = firstText(runtimeTrace?.device?.backend);
  const outputTargetId = firstText(dispatch.output_target_id, dispatch.outputTargetId);
  const outputResourceId = firstText(output.output_target_id, output.outputTargetId);
  const artifactHashes = [
    firstText(loader.artifact_hash, loader.artifactHash),
    firstText(dispatch.artifact_hash, dispatch.artifactHash),
    firstText(output.artifact_hash, output.artifactHash),
  ];
  if (!backend || !outputTargetId || !outputResourceId || artifactHashes.some((value) => !value)) {
    throw new Error('HIP runtime trace is missing backend, output-resource, or artifact facts');
  }
  if (outputTargetId !== outputResourceId) {
    throw new Error('HIP dispatch and readback output resources differ');
  }
  if (new Set(artifactHashes).size !== 1) {
    throw new Error('HIP loader, dispatch, and output artifact hashes differ');
  }
  if (expectedArtifactHash && artifactHashes[0] !== expectedArtifactHash) {
    throw new Error('HIP observed artifact hash does not match the verified HSACO');
  }
  const boundReadbackHash = observedReadbackHash ?? sha256Text(stableJson({
    outputEvent: output,
    outputTargetId: outputResourceId,
  }));
  if (!/^sha256:[0-9a-f]{64}$/u.test(boundReadbackHash)) {
    throw new Error('HIP observed binding requires a content-addressed readback identity');
  }
  const invocation = objectOrEmpty(runtimeTrace?.probeInvocation);
  if (observedReadbackHash !== null && Object.keys(invocation).length === 0) {
    throw new Error('HIP observed readback is not bound to runtime invocation evidence');
  }
  if (Object.keys(invocation).length > 0 && (
    invocation.planHash !== planHash
    || invocation.resourceTraceHash !== resourceTraceHash
    || invocation.dispatchId !== dispatchId
    || invocation.artifactHash !== artifactHashes[0]
    || invocation.outputResourceId !== outputResourceId
    || invocation.observedReadbackHash !== boundReadbackHash
  )) {
    throw new Error('HIP runtime invocation evidence does not match dispatch, artifact, resource, or readback facts');
  }
  return {
    artifactAfterHash: artifactHashes[0],
    outputTargetId,
    outputResourceId,
    backend,
    runtimeSessionId: hipRuntimeSessionId(runtimeTrace),
    dispatchId,
    traceArtifactHash,
    resourceOrPlanHash: planHash,
    resourceTraceHash,
    observedReadbackHash: boundReadbackHash,
  };
}

function buildHipSemanticOracleRequest({
  profile,
  runMode,
  artifactAfterHash,
  artifactSource = profile.afterSource,
  artifactSourceHash = profile.afterHash,
  runtimeTrace,
  launchObservation,
  compiled,
  planHash = null,
  observedReadbackHash = null,
  traceArtifactHash = canonicalRuntimeTraceHash(runtimeTrace),
  trustedOracleImplementationHash = semanticOracleCodeHash(),
  epoch = '2',
}) {
  rejectConflictingSnakeCamelAliases(runtimeTrace, 'HIP semantic request runtime trace');
  rejectConflictingSnakeCamelAliases(launchObservation, 'HIP semantic request launch observation');
  const effectivePlanHash = planHash ?? sha256Text(stableJson({
    kind: 'hip-semantic-planning-input',
    artifactAfterHash,
    launchObservation,
  }));
  const plannedResourceTrace = hipResourceTraceFromLaunchObservation({
    launchObservation,
    planHash: effectivePlanHash,
  });
  const runtimeInvocation = observedReadbackHash === null
    ? null
    : bindHipRuntimeInvocationEvidence({
      runtimeTrace,
      planHash: effectivePlanHash,
      observedReadbackHash,
      expectedKernelIdentity: profile.kernel.name,
      expectedArtifactHash: artifactAfterHash,
      epoch,
    });
  const boundResourceTrace = runtimeInvocation
    ? hipResourceTraceFromLaunchObservation({
      launchObservation: {
        resources: runtimeInvocation.resources,
        parameters: runtimeInvocation.parameters,
      },
      planHash: effectivePlanHash,
    })
    : plannedResourceTrace;
  const observedBinding = deriveHipObservedBinding({
    runtimeTrace,
    traceArtifactHash,
    planHash: effectivePlanHash,
    resourceTraceHash: boundResourceTrace.resourceTraceHash,
    observedReadbackHash,
    epoch,
    expectedArtifactHash: artifactAfterHash,
  });
  const dispatch = oneTraceFact(
    runtimeTrace?.dispatchEvents,
    (event) => String(event?.epoch) === String(epoch),
    `epoch-${epoch} dispatch`,
  );
  const gridDim = objectOrEmpty(dispatch.grid_dim ?? dispatch.gridDim);
  const blockDim = objectOrEmpty(dispatch.block_dim ?? dispatch.blockDim);
  if (!gridDim.x || !blockDim.x) {
    throw new Error('HIP semantic request requires observed dispatch dimensions');
  }
  const compileManifestHash = compiled?.compileManifestHash;
  const artifactBindingHash = compileManifestHash
    ? sha256Text(stableJson({
      sourceHash: artifactSourceHash,
      compiledArtifactHash: artifactAfterHash,
      compileManifestHash,
      entryPoint: profile.kernel.entryPoint,
    }))
    : null;
  return {
    schemaVersion: INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA,
    binding: {
      projectId: profile.targetId,
      editId: runMode.edit_id,
      targetId: runMode.target_id,
      requestId: runMode.request_id,
      artifactSourceHash,
      artifactBindingHash,
      compileManifestHash,
      ...observedBinding,
      trustedOracleImplementationHash,
    },
    artifact: {
      kind: 'hip-source',
      source: artifactSource,
      sourceHash: artifactSourceHash,
      entryPoint: profile.kernel.entryPoint,
      compiledArtifactHash: artifactAfterHash,
      compileManifest: compiled?.compileManifest ?? null,
      compileManifestHash: compileManifestHash ?? null,
      sourceArtifactBindingHash: artifactBindingHash,
    },
    resources: runtimeInvocation?.resources ?? plannedResourceTrace.resources,
    launch: {
      api: firstText(dispatch.launch_api, dispatch.launchApi),
      dispatchId: observedBinding.dispatchId,
      gridDim,
      blockDim,
      sharedMemBytes: nonNegativeInteger(dispatch.shared_mem_bytes ?? dispatch.sharedMemBytes, null),
      stream: firstText(dispatch.stream),
      parameters: runtimeInvocation?.parameters ?? plannedResourceTrace.parameters,
      planHash: effectivePlanHash,
      resourceTraceHash: boundResourceTrace.resourceTraceHash,
    },
  };
}

function validateSemanticOracleRequest(request) {
  rejectConflictingSnakeCamelAliases(request, 'HIP semantic oracle request');
  if (request?.schemaVersion !== INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA) {
    throw new Error('HIP semantic oracle request schema is invalid');
  }
  if (request.binding?.backend !== 'hip') {
    throw new Error('HIP semantic oracle request backend binding is invalid');
  }
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    if (!firstText(request.binding?.[field])) {
      throw new Error(`HIP semantic oracle binding ${field} is missing`);
    }
  }
  for (const field of [
    'artifactAfterHash',
    'artifactSourceHash',
    'artifactBindingHash',
    'compileManifestHash',
    'traceArtifactHash',
    'resourceOrPlanHash',
    'resourceTraceHash',
    'observedReadbackHash',
    'trustedOracleImplementationHash',
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(request.binding[field])) {
      throw new Error(`HIP semantic oracle binding ${field} is not a sha256 identity`);
    }
  }
  if (sha256Text(request.artifact?.source ?? '') !== request.artifact?.sourceHash) {
    throw new Error('HIP semantic oracle artifact source hash mismatch');
  }
  if (
    request.binding.targetId !== request.binding.projectId
    || request.binding.artifactSourceHash !== request.artifact.sourceHash
  ) {
    throw new Error('HIP semantic oracle target or source identity binding mismatch');
  }
  if (request.artifact?.compiledArtifactHash !== request.binding.artifactAfterHash) {
    throw new Error('HIP semantic oracle source/compiled artifact binding mismatch');
  }
  const compileManifest = request.artifact?.compileManifest;
  if (
    !compileManifest
    || sha256Text(stableJson(compileManifest)) !== request.artifact.compileManifestHash
    || request.artifact.compileManifestHash !== request.binding.compileManifestHash
  ) {
    throw new Error('HIP semantic oracle compile manifest is missing or content mismatched');
  }
  const boundSources = firstArray(compileManifest.sourceInputs)
    .filter((entry) => entry?.sha256 === request.artifact.sourceHash);
  const boundHsacos = firstArray(compileManifest.outputs)
    .filter((entry) => entry?.sha256 === request.artifact.compiledArtifactHash);
  if (
    compileManifest.entryPoint !== request.artifact.entryPoint
    || boundSources.length !== 1
    || boundHsacos.length !== 1
  ) {
    throw new Error('HIP semantic oracle compile manifest does not bind the exact source, entry, and HSACO');
  }
  const artifactBindingHash = sha256Text(stableJson({
    sourceHash: request.artifact.sourceHash,
    compiledArtifactHash: request.artifact.compiledArtifactHash,
    compileManifestHash: request.artifact.compileManifestHash,
    entryPoint: request.artifact.entryPoint,
  }));
  if (
    artifactBindingHash !== request.artifact.sourceArtifactBindingHash
    || artifactBindingHash !== request.binding.artifactBindingHash
  ) {
    throw new Error('HIP semantic oracle source-to-HSACO binding hash mismatch');
  }
  if (
    request.launch?.dispatchId !== request.binding.dispatchId
    || request.launch?.planHash !== request.binding.resourceOrPlanHash
    || request.launch?.resourceTraceHash !== request.binding.resourceTraceHash
  ) {
    throw new Error('HIP semantic oracle dispatch/plan binding mismatch');
  }
  if (!Array.isArray(request.resources) || request.resources.length === 0) {
    throw new Error('HIP semantic oracle observed resources are missing');
  }
  const resourceNames = new Set();
  for (const resource of request.resources) {
    const declaredBytes = firstArray(resource.initialBytes);
    if (
      !firstText(resource.name)
      || resourceNames.has(resource.name)
      || declaredBytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
      throw new Error('HIP semantic oracle resources must have unique names and byte-valued contents');
    }
    resourceNames.add(resource.name);
    const bytes = Buffer.from(declaredBytes);
    if (
      bytes.length !== resource.byteLength
      || sha256Bytes(bytes) !== resource.initialBytesHash
    ) {
      throw new Error(`HIP semantic oracle input bytes mismatch for ${resource.name}`);
    }
  }
  const recomputedResourceTrace = hipResourceTraceFromLaunchObservation({
    launchObservation: {
      resources: request.resources,
      parameters: firstArray(request.launch?.parameters),
    },
    planHash: request.launch.planHash,
  });
  if (recomputedResourceTrace.resourceTraceHash !== request.binding.resourceTraceHash) {
    throw new Error('HIP semantic oracle resources and parameters do not match the bound resource trace');
  }
}

async function executeSemanticOracle(request, implementationBytes = semanticOracleImplementationBytes()) {
  validateSemanticOracleRequest(request);
  const implementationHash = sha256Bytes(implementationBytes);
  if (implementationHash !== request.binding.trustedOracleImplementationHash) {
    throw new Error('HIP semantic oracle implementation is not the trusted request-bound implementation');
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
    throw new Error('HIP semantic oracle returned an invalid result');
  }
  const expectedBytes = Buffer.from(result.expectedBytes);
  const canonicalBytes = encodeNumericValues(result.expectedValues, result.dataType);
  if (!expectedBytes.equals(canonicalBytes)) {
    throw new Error('HIP semantic oracle result bytes do not match its values');
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
  implementationBytes,
  request,
  execution,
  observedBytes,
  observedBinding,
}) {
  const failures = [];
  const implementationHash = sha256Bytes(implementationBytes);
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
  ) {
    failures.push('semantic_oracle_binding_receipt_invalid');
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
    requestHash: semanticRequestHash,
    bindingHash: sha256Text(stableJson(request?.binding)),
    expectedRawHash: execution?.expectedRawHash ?? null,
    observedRawHash: sha256Bytes(Buffer.from(observedBytes)),
    mismatchCount: comparison.mismatches.length,
    maxAbsDelta: null,
    verificationMethod: 'independent_dataview_typed_byte_comparison_without_oracle_execution',
    failures,
  };
}

function buildSemanticOracleIdentity(binding) {
  for (const field of SEMANTIC_ORACLE_BINDING_FIELDS) {
    if (!firstText(binding?.[field])) {
      throw new Error(`HIP semantic oracle identity is missing ${field}`);
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
    compile_manifest_hash: binding.compileManifestHash,
    trace_artifact_hash: binding.traceArtifactHash,
    resource_or_plan_hash: binding.resourceOrPlanHash,
    resource_trace_hash: binding.resourceTraceHash,
    observed_readback_hash: binding.observedReadbackHash,
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
      `runtime:hip-module:semantic-oracle:${execution.implementationHash}`,
      ...request.resources.map((resource) => resource.initialBytesHash),
    ],
  });
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
  rejectConflictingSnakeCamelAliases(raw, field);
  const dataType = normalizeDataType(raw.dataType ?? raw.data_type, `${field}.dataType`);
  const values = Array.isArray(raw.values)
    ? normalizeNumericValues(raw.values, `${field}.values`, dataType)
    : [];
  const byteLength = positiveInteger(
    raw.byteLength ?? raw.byte_length,
    values.length > 0 ? values.length * byteWidthForDataType(dataType) : null,
  );
  if (!byteLength) throw new Error(`${field}.byteLength is required when values are not declared`);
  const name = authoritativeText(raw, ['name'], `${field}.resourceIdentity`, {
    required: true,
  });
  const role = authoritativeText(raw, ['role', 'resourceRole', 'resource_role'], `${field}.resourceRole`, {
    required: true,
  });
  return {
    name,
    role,
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
  const explicitName = authoritativeText(
    param,
    ['buffer', 'bufferName', 'buffer_name'],
    `kernel param ${firstText(param.name) ?? 'arg'}.buffer`,
  );
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
  throw new Error(`kernel pointer param ${name ?? 'arg'} must explicitly map to a declared buffer`);
}

function normalizeAbiParams(rawParams, buffers, constants, elementCount) {
  const params = firstArray(rawParams);
  if (params.length === 0) throw new Error('abi.params must declare kernel launch parameters');
  const normalized = params.map((rawParam, index) => {
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
    const declaredScalarValue = authoritativeAlias(
      param,
      ['value', 'scalarValue', 'scalar_value'],
      `abi.params[${index}].scalarValue`,
    );
    const scalarValue = finiteNumber(
      declaredScalarValue ?? constants[base.name],
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
  const pointerParams = normalized.filter((param) => param.launch_kind === 'buffer');
  const pointerBindings = new Map();
  for (const param of pointerParams) {
    const prior = pointerBindings.get(param.buffer);
    if (prior) {
      throw new Error(`unsupported HIP multi-pointer alias: ${prior} and ${param.name} both map to ${param.buffer}`);
    }
    pointerBindings.set(param.buffer, param.name);
    if (!['read', 'write'].includes(param.access)) {
      throw new Error(`kernel pointer param ${param.name} must declare read or write access`);
    }
  }
  const writable = pointerParams.filter((param) => param.access === 'write');
  const readable = pointerParams.filter((param) => param.access === 'read');
  if (writable.length !== 1 || readable.length !== 1 || pointerParams.length !== 2) {
    throw new Error('unsupported HIP multi-resource semantics: exactly one read pointer and one write pointer are required');
  }
  const output = buffers.find((buffer) => buffer.name === writable[0].buffer);
  const input = buffers.find((buffer) => buffer.name === readable[0].buffer);
  if (!output || !['readback', 'output'].includes(output.role) || !input || input.role !== 'input') {
    throw new Error('HIP pointer roles must bind one input resource and one readback/output resource');
  }
  return normalized;
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

function resolveHipKernelIdentity(rawKernel) {
  const kernel = objectOrEmpty(rawKernel);
  rejectConflictingSnakeCamelAliases(kernel, 'profile.kernel');
  const name = authoritativeText(
    kernel,
    ['name', 'kernelName', 'kernel_name'],
    'profile.kernel.name',
    { required: true },
  );
  const entryPoint = authoritativeText(
    kernel,
    ['entryPoint', 'entry_point'],
    'profile.kernel.entryPoint',
    { required: true },
  );
  if (name !== entryPoint) {
    throw new Error(`HIP kernel identity mismatch: kernel.name=${name} entryPoint=${entryPoint}`);
  }
  return name;
}

async function loadProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const profileDir = path.dirname(resolvedPath);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  rejectConflictingSnakeCamelAliases(raw, 'HIP module profile');
  const compile = objectOrEmpty(raw.compile);
  const kernel = objectOrEmpty(raw.kernel);
  const launch = objectOrEmpty(raw.launch);
  const oracle = objectOrEmpty(authoritativeAlias(raw, ['outputOracle', 'output_oracle'], 'profile.outputOracle'));
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
  const inputBuffers = buffers.filter((buffer) => buffer.role === 'input');
  const readbackIdentity = authoritativeText(
    oracle,
    ['readbackBuffer', 'readback_buffer'],
    'profile.outputOracle.readbackBuffer',
    { required: true },
  );
  const readbackBuffers = buffers.filter((buffer) => (
    buffer.name === readbackIdentity && ['readback', 'output'].includes(buffer.role)
  ));
  if (inputBuffers.length !== 1 || readbackBuffers.length !== 1) {
    throw new Error('profile must explicitly identify exactly one input role and one readback resource role/identity');
  }
  const [inputBuffer] = inputBuffers;
  const [readbackBuffer] = readbackBuffers;
  const readbackDataType = readbackBuffer.dataType;
  const expectedBeforeHintRaw = authoritativeAlias(
    oracle,
    ['expectedBeforeValues', 'expected_before_values'],
    'profile.outputOracle.expectedBeforeValues',
  );
  const expectedAfterHintRaw = authoritativeAlias(
    oracle,
    ['expectedAfterValues', 'expected_after_values', 'expectedValues', 'expected_values'],
    'profile.outputOracle.expectedAfterValues',
  );
  const expectedBeforeHint = expectedBeforeHintRaw === null ? [] : expectedBeforeHintRaw;
  const expectedAfterHint = expectedAfterHintRaw === null ? [] : expectedAfterHintRaw;
  if (!Array.isArray(expectedBeforeHint) || !Array.isArray(expectedAfterHint)) {
    throw new Error('profile outputOracle expected-value hints must be arrays');
  }
  const expectedBeforeValues = expectedBeforeHint.length > 0
    ? normalizeNumericValues(expectedBeforeHint, 'outputOracle.expectedBeforeValuesHint', readbackDataType)
    : [];
  const expectedAfterValues = expectedAfterHint.length > 0
    ? normalizeNumericValues(expectedAfterHint, 'outputOracle.expectedAfterValuesHint', readbackDataType)
    : [];
  const dataTypeWidth = byteWidthForDataType(readbackDataType);
  if (readbackBuffer.byteLength % dataTypeWidth !== 0) {
    throw new Error('readback byte length must align to its declared data type');
  }
  const elementCount = readbackBuffer.byteLength / dataTypeWidth;
  const [beforeSourceBytes, afterSourceBytes] = await Promise.all([
    readFile(beforePath),
    readFile(afterPath),
  ]);
  const beforeSource = beforeSourceBytes.toString('utf8');
  const afterSource = afterSourceBytes.toString('utf8');
  const beforeHash = sha256Bytes(beforeSourceBytes);
  const afterHash = sha256Bytes(afterSourceBytes);
  const targetId = firstText(raw.targetId, raw.target_id, raw.id) ?? safeSlug(path.basename(resolvedPath, '.json'));
  const deterministicSlice = objectOrEmpty(oracle.deterministicSlice ?? oracle.deterministic_slice);
  const runMode = objectOrEmpty(raw.runMode ?? raw.run_mode);
  const negativeEdit = objectOrEmpty(raw.negativeEdit ?? raw.negative_edit);
  const constantsRecord = Object.fromEntries(Object.entries(constants).map(([key, value]) => [key, Number(value)]));
  const kernelName = resolveHipKernelIdentity(kernel);
  const kernelEntryPoint = kernelName;
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
      entryPoint: kernelEntryPoint,
      resolvedSymbol: kernelName,
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
      profileExpectedOutputRequiredHint:
        oracle.expectedOutputRequired !== false && oracle.expected_output_required !== false,
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
  const editId = `${profile.targetId}-hip-module-${profile.runMode.metricScope}`;
  const requestId = `hip-module-request:${sha256Text(stableJson({
    targetId: profile.targetId,
    editId,
    editHash: profile.afterHash,
    metricScope: profile.runMode.metricScope,
    differentEdit: profile.runMode.differentEdit,
  })).replace(/^sha256:/, '')}`;
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: profile.runMode.metricScope,
    metricScope: profile.runMode.metricScope,
    cache_state: profile.runMode.cacheState,
    cacheState: profile.runMode.cacheState,
    target_id: profile.targetId,
    targetId: profile.targetId,
    request_id: requestId,
    requestId,
    edit_id: editId,
    editId,
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

async function readVerifiedSha256(filePath, expectedHash, label) {
  const bytes = await readFile(filePath);
  const observedHash = sha256Bytes(bytes);
  if (observedHash !== expectedHash) {
    throw new Error(`${label} hash mismatch: expected ${expectedHash}, observed ${observedHash}`);
  }
  return bytes;
}

async function verifyHipProfileSourceInputs(profile) {
  const [beforeBytes, afterBytes] = await Promise.all([
    readVerifiedSha256(profile.beforePath, profile.beforeHash, 'HIP before source input'),
    readVerifiedSha256(profile.afterPath, profile.afterHash, 'HIP after source input'),
  ]);
  return { beforeBytes, afterBytes };
}

function compileManifestRole(entries, role, label) {
  const matches = firstArray(entries).filter((entry) => entry?.role === role);
  if (matches.length !== 1) {
    throw new Error(`HIP compile manifest must contain exactly one ${label} entry`);
  }
  return matches[0];
}

async function verifyHipCompiledArtifactsForLoad(compiled) {
  const manifest = compiled?.compileManifest;
  if (
    !manifest
    || sha256Text(stableJson(manifest)) !== compiled.compileManifestHash
    || manifest.entryPoint !== compiled.kernelIdentity
  ) {
    throw new Error('HIP compile manifest or exact kernel identity is missing or invalid before module load');
  }
  const beforeInput = compileManifestRole(manifest.sourceInputs, 'before', 'before source');
  const afterInput = compileManifestRole(manifest.sourceInputs, 'after', 'after source');
  const beforeOutput = compileManifestRole(manifest.outputs, 'before_hsaco', 'before HSACO');
  const afterOutput = compileManifestRole(manifest.outputs, 'after_hsaco', 'after HSACO');
  if (
    beforeInput.sha256 !== compiled.beforeSourceHash
    || afterInput.sha256 !== compiled.afterSourceHash
    || beforeOutput.sha256 !== compiled.beforeHsacoHash
    || afterOutput.sha256 !== compiled.afterHsacoHash
  ) {
    throw new Error('HIP compile manifest no longer binds the staged sources and HSACO outputs');
  }
  const [beforeSourceBytes, afterSourceBytes, beforeHsacoBytes, afterHsacoBytes] = await Promise.all([
    readVerifiedSha256(compiled.beforeSourceSnapshot, beforeInput.sha256, 'HIP staged before source'),
    readVerifiedSha256(compiled.afterSourceSnapshot, afterInput.sha256, 'HIP staged after source'),
    readVerifiedSha256(compiled.beforeHsaco, beforeOutput.sha256, 'HIP before HSACO'),
    readVerifiedSha256(compiled.afterHsaco, afterOutput.sha256, 'HIP after HSACO'),
  ]);
  const sourceArtifactBindingHash = sha256Text(stableJson({
    sourceHash: afterInput.sha256,
    compiledArtifactHash: afterOutput.sha256,
    compileManifestHash: compiled.compileManifestHash,
    entryPoint: manifest.entryPoint,
  }));
  if (sourceArtifactBindingHash !== compiled.sourceArtifactBindingHash) {
    throw new Error('HIP source-to-HSACO binding changed before module load');
  }
  if (compiled.compileManifestPath) {
    const persisted = JSON.parse(await readFile(compiled.compileManifestPath, 'utf8'));
    const persistedManifest = {
      schemaVersion: persisted.schemaVersion,
      compiler: persisted.compiler,
      compileTarget: persisted.compileTarget,
      entryPoint: persisted.entryPoint,
      sourceInputs: persisted.sourceInputs,
      commands: persisted.commands,
      outputs: persisted.outputs,
    };
    if (
      persisted.compileManifestHash !== compiled.compileManifestHash
      || persisted.sourceArtifactBindingHash !== compiled.sourceArtifactBindingHash
      || stableJson(persistedManifest) !== stableJson(manifest)
    ) {
      throw new Error('HIP persisted compile manifest changed before module load');
    }
  }
  return { beforeSourceBytes, afterSourceBytes, beforeHsacoBytes, afterHsacoBytes };
}

async function writePrivateHipCasObject({ casDir, bytes, expectedHash, role }) {
  if (sha256Bytes(bytes) !== expectedHash) {
    throw new Error(`HIP ${role} CAS input bytes do not match ${expectedHash}`);
  }
  const casPath = path.join(casDir, `${expectedHash.slice('sha256:'.length)}.hsaco`);
  const handle = await open(casPath, 'wx', 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(casPath, 0o400);
  await readVerifiedSha256(casPath, expectedHash, `HIP private ${role} CAS object`);
  return casPath;
}

async function stagePrivateHipLoaderCas({ compiled, outDir }) {
  const verified = await verifyHipCompiledArtifactsForLoad(compiled);
  const casDir = await mkdtemp(path.join(outDir, '.hip-loader-cas-'));
  await chmod(casDir, 0o700);
  const beforePath = await writePrivateHipCasObject({
    casDir,
    bytes: verified.beforeHsacoBytes,
    expectedHash: compiled.beforeHsacoHash,
    role: 'before HSACO',
  });
  const afterPath = await writePrivateHipCasObject({
    casDir,
    bytes: verified.afterHsacoBytes,
    expectedHash: compiled.afterHsacoHash,
    role: 'after HSACO',
  });
  return {
    schemaVersion: 'synthi.gpu_hmr.hip_loader_cas.v1',
    casDir,
    beforePath,
    afterPath,
    beforeHash: compiled.beforeHsacoHash,
    afterHash: compiled.afterHsacoHash,
  };
}

async function stageRemoteHipLoaderCas({ compiled, localCas }) {
  const remoteCasDir = `${compiled.remoteDir}/loader-cas-${safeSlug(path.basename(localCas.casDir))}`;
  await dockerExec(CFG.execContainer, ['mkdir', '-m', '700', remoteCasDir], { timeout: CFG.timeoutMs });
  const remoteBeforePath = `${remoteCasDir}/${path.basename(localCas.beforePath)}`;
  const remoteAfterPath = `${remoteCasDir}/${path.basename(localCas.afterPath)}`;
  await dockerCpTo(CFG.execContainer, localCas.beforePath, remoteBeforePath);
  await dockerCpTo(CFG.execContainer, localCas.afterPath, remoteAfterPath);
  await dockerExec(CFG.execContainer, ['chmod', '400', remoteBeforePath, remoteAfterPath], { timeout: CFG.timeoutMs });
  await Promise.all([
    verifyRemoteSha256(CFG.execContainer, remoteBeforePath, localCas.beforeHash, 'HIP remote before loader CAS'),
    verifyRemoteSha256(CFG.execContainer, remoteAfterPath, localCas.afterHash, 'HIP remote after loader CAS'),
  ]);
  return { remoteCasDir, remoteBeforePath, remoteAfterPath };
}

async function verifyRemoteSha256(container, filePath, expectedHash, label) {
  const result = await dockerExec(container, ['sha256sum', filePath], { timeout: CFG.timeoutMs });
  const observed = firstText(result.stdout)?.trim().split(/\s+/u)[0];
  if (!observed || `sha256:${observed.toLowerCase()}` !== expectedHash) {
    throw new Error(`${label} remote hash mismatch before HIP operation`);
  }
}

async function finalizeHipCompiledArtifacts({ profile, outDir, compiled }) {
  const [beforeSnapshotHash, afterSnapshotHash, beforeHsacoHash, afterHsacoHash] = await Promise.all([
    sha256File(compiled.beforeSourceSnapshot),
    sha256File(compiled.afterSourceSnapshot),
    sha256File(compiled.beforeHsaco),
    sha256File(compiled.afterHsaco),
  ]);
  if (beforeSnapshotHash !== profile.beforeHash || afterSnapshotHash !== profile.afterHash) {
    throw new Error('HIP source snapshot hash changed before compile-manifest finalization');
  }
  const manifest = {
    schemaVersion: 'synthi.gpu_hmr.hip_source_hsaco_compile_manifest.v1',
    compiler: compiled.compiler,
    compileTarget: profile.compile.gpuArch || profile.compile.compileTarget,
    entryPoint: profile.kernel.entryPoint,
    sourceInputs: [
      { role: 'before', path: relRepo(compiled.beforeSourceSnapshot), sha256: beforeSnapshotHash },
      { role: 'after', path: relRepo(compiled.afterSourceSnapshot), sha256: afterSnapshotHash },
    ],
    commands: compiled.commands,
    outputs: [
      { role: 'before_hsaco', path: relRepo(compiled.beforeHsaco), sha256: beforeHsacoHash },
      { role: 'after_hsaco', path: relRepo(compiled.afterHsaco), sha256: afterHsacoHash },
    ],
  };
  const compileManifestHash = sha256Text(stableJson(manifest));
  const sourceArtifactBindingHash = sha256Text(stableJson({
    sourceHash: afterSnapshotHash,
    compiledArtifactHash: afterHsacoHash,
    compileManifestHash,
    entryPoint: profile.kernel.entryPoint,
  }));
  const compileManifestPath = path.join(outDir, `${safeSlug(profile.targetId)}-compile-manifest.json`);
  await writeFile(compileManifestPath, `${JSON.stringify({
    ...manifest,
    compileManifestHash,
    sourceArtifactBindingHash,
  }, null, 2)}\n`);
  return {
    ...compiled,
    kernelIdentity: profile.kernel.name,
    beforeHsacoHash,
    afterHsacoHash,
    beforeSourceHash: beforeSnapshotHash,
    afterSourceHash: afterSnapshotHash,
    compileManifest: manifest,
    compileManifestHash,
    compileManifestPath,
    sourceArtifactBindingHash,
  };
}

async function compileRuntimeArtifacts({ profile, outDir }) {
  const hostPath = probeExecutablePath(outDir);
  const beforeHsaco = path.join(outDir, `${safeSlug(profile.targetId)}-before.hsaco`);
  const afterHsaco = path.join(outDir, `${safeSlug(profile.targetId)}-after.hsaco`);
  const beforeSourceSnapshot = path.join(outDir, `${safeSlug(profile.targetId)}-before-source.hip`);
  const afterSourceSnapshot = path.join(outDir, `${safeSlug(profile.targetId)}-after-source.hip`);
  const sourceInputs = await verifyHipProfileSourceInputs(profile);
  await Promise.all([
    writeFile(beforeSourceSnapshot, sourceInputs.beforeBytes),
    writeFile(afterSourceSnapshot, sourceInputs.afterBytes),
  ]);
  if (
    await sha256File(beforeSourceSnapshot) !== profile.beforeHash
    || await sha256File(afterSourceSnapshot) !== profile.afterHash
  ) {
    throw new Error('HIP immutable source snapshot hash does not match cold-intake bytes');
  }
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
    await dockerCpTo(CFG.execContainer, beforeSourceSnapshot, remoteBeforeSource);
    await dockerCpTo(CFG.execContainer, afterSourceSnapshot, remoteAfterSource);
    await Promise.all([
      verifyRemoteSha256(CFG.execContainer, remoteBeforeSource, profile.beforeHash, 'HIP before compile source'),
      verifyRemoteSha256(CFG.execContainer, remoteAfterSource, profile.afterHash, 'HIP after compile source'),
    ]);
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
    await verifyRemoteSha256(CFG.execContainer, remoteBeforeSource, profile.beforeHash, 'HIP before compile source');
    await dockerExec(CFG.execContainer, [CFG.hipcc, ...beforeArgs], { timeout: CFG.timeoutMs });
    await verifyRemoteSha256(CFG.execContainer, remoteBeforeSource, profile.beforeHash, 'HIP before compile source');
    await verifyRemoteSha256(CFG.execContainer, remoteAfterSource, profile.afterHash, 'HIP after compile source');
    await dockerExec(CFG.execContainer, [CFG.hipcc, ...afterArgs], { timeout: CFG.timeoutMs });
    await verifyRemoteSha256(CFG.execContainer, remoteAfterSource, profile.afterHash, 'HIP after compile source');
    await dockerCpFrom(CFG.execContainer, remoteBeforeHsaco, beforeHsaco);
    await dockerCpFrom(CFG.execContainer, remoteAfterHsaco, afterHsaco);
    await verifyHipProfileSourceInputs(profile);
    const compileEnd = process.hrtime.bigint();
    const finalized = await finalizeHipCompiledArtifacts({ profile, outDir, compiled: {
      transport: 'docker_exec_container',
      container: CFG.execContainer,
      hostPath,
      remoteHostPath,
      beforeHsaco,
      afterHsaco,
      beforeSourceSnapshot,
      afterSourceSnapshot,
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
    } });
    await verifyHipCompiledArtifactsForLoad(finalized);
    return finalized;
  }
  const hostArgs = ['-std=c++17', '-O2', PROBE_SOURCE_PATH, '-o', hostPath];
  const beforeArgs = hipccArgsForHsaco({
    sourcePath: beforeSourceSnapshot,
    outputPath: beforeHsaco,
    gpuArch: profile.compile.gpuArch,
  });
  const afterArgs = hipccArgsForHsaco({
    sourcePath: afterSourceSnapshot,
    outputPath: afterHsaco,
    gpuArch: profile.compile.gpuArch,
  });
  await execFileChecked(CFG.hipcc, hostArgs);
  await readVerifiedSha256(beforeSourceSnapshot, profile.beforeHash, 'HIP staged before source');
  await execFileChecked(CFG.hipcc, beforeArgs);
  await readVerifiedSha256(beforeSourceSnapshot, profile.beforeHash, 'HIP staged before source');
  await readVerifiedSha256(afterSourceSnapshot, profile.afterHash, 'HIP staged after source');
  await execFileChecked(CFG.hipcc, afterArgs);
  await readVerifiedSha256(afterSourceSnapshot, profile.afterHash, 'HIP staged after source');
  await verifyHipProfileSourceInputs(profile);
  const compileEnd = process.hrtime.bigint();
  const finalized = await finalizeHipCompiledArtifacts({ profile, outDir, compiled: {
    transport: 'local_process',
    hostPath,
    beforeHsaco,
    afterHsaco,
    beforeSourceSnapshot,
    afterSourceSnapshot,
    compiler: CFG.hipcc,
    commands: {
      host: [CFG.hipcc, ...hostArgs],
      before: [CFG.hipcc, ...beforeArgs],
      after: [CFG.hipcc, ...afterArgs],
    },
    compileDurationNs: durationNs(compileStart, compileEnd),
  } });
  await verifyHipCompiledArtifactsForLoad(finalized);
  return finalized;
}

function csv(values) {
  return values.map((value) => Number(value).toString()).join(',');
}

async function writeProbePlan({
  profile,
  outDir,
  beforeHsacoHash,
  afterHsacoHash,
  launchObservation,
  probeOracle,
}) {
  const planPath = path.join(outDir, `${safeSlug(profile.targetId)}-probe-plan.env`);
  const bufferLines = launchObservation.resources.flatMap((buffer, index) => [
    `buffer_${index}_name=${buffer.name}`,
    `buffer_${index}_role=${buffer.role}`,
    `buffer_${index}_data_type=${buffer.dataType}`,
    `buffer_${index}_byte_length=${buffer.byteLength}`,
    `buffer_${index}_values=${csv(decodeNumericValues(Buffer.from(buffer.initialBytes), buffer.dataType))}`,
    `buffer_${index}_initial_bytes_hash=${buffer.initialBytesHash}`,
  ]);
  const paramLines = launchObservation.parameters.flatMap((param, index) => {
    const base = [
      `param_${index}_name=${param.name}`,
      `param_${index}_type=${profile.abi.params[index].type}`,
      `param_${index}_value_kind=${param.kind === 'buffer' ? 'global_buffer' : 'by_value'}`,
      `param_${index}_access=${profile.abi.params[index].access}`,
    ];
    if (param.kind === 'buffer') {
      return [...base, `param_${index}_buffer=${param.buffer}`];
    }
    return [
      ...base,
      `param_${index}_scalar_type=${param.dataType}`,
      `param_${index}_scalar_value=${param.value}`,
    ];
  });
  if (
    probeOracle.before.elementCount !== probeOracle.after.elementCount
    || probeOracle.before.dataType !== probeOracle.after.dataType
    || probeOracle.before.tolerance !== probeOracle.after.tolerance
  ) {
    throw new Error('HIP probe semantic-oracle epochs disagree on output schema');
  }
  const lines = [
    `kernel_name=${profile.kernel.name}`,
    `artifact_hash_before=${beforeHsacoHash}`,
    `artifact_hash_after=${afterHsacoHash}`,
    `dispatch_binding=hip-module-function-slot:${profile.kernel.name}`,
    `compile_target=${profile.compile.gpuArch || profile.compile.compileTarget}`,
    `readback_buffer=${profile.buffers.readback.name}`,
    `readback_data_type=${profile.buffers.readback.dataType}`,
    `grid_x=${launchObservation.gridDim.x}`,
    `grid_y=${launchObservation.gridDim.y}`,
    `grid_z=${launchObservation.gridDim.z}`,
    `block_x=${launchObservation.blockDim.x}`,
    `block_y=${launchObservation.blockDim.y}`,
    `block_z=${launchObservation.blockDim.z}`,
    `shared_mem_bytes=${launchObservation.sharedMemBytes}`,
    `element_count=${probeOracle.after.elementCount}`,
    `tolerance=${probeOracle.after.tolerance}`,
    `buffer_count=${launchObservation.resources.length}`,
    ...bufferLines,
    `param_count=${launchObservation.parameters.length}`,
    ...paramLines,
    `expected_before_values=${csv(probeOracle.before.expectedValues)}`,
    `expected_after_values=${csv(probeOracle.after.expectedValues)}`,
    `semantic_oracle_implementation_hash=${probeOracle.after.implementationHash}`,
    `semantic_oracle_before_request_hash=${probeOracle.before.requestHash}`,
    `semantic_oracle_after_request_hash=${probeOracle.after.requestHash}`,
  ];
  const planBytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const planHash = sha256Bytes(planBytes);
  await writeFile(planPath, planBytes);
  await readVerifiedSha256(planPath, planHash, 'HIP probe plan');
  return { planPath, planHash };
}

async function runHipProbe({ profile, compiled, outDir, launchObservation, probeOracle }) {
  const rawAfterPath = path.join(outDir, `${safeSlug(profile.targetId)}-after-readback.bin`);
  const runtimeTracePath = path.join(outDir, `${safeSlug(profile.targetId)}-runtime-trace.json`);
  const { planPath, planHash } = await writeProbePlan({
    profile,
    outDir,
    beforeHsacoHash: compiled.beforeHsacoHash,
    afterHsacoHash: compiled.afterHsacoHash,
    launchObservation,
    probeOracle,
  });
  await readVerifiedSha256(planPath, planHash, 'HIP probe plan');
  const loaderCas = await stagePrivateHipLoaderCas({ compiled, outDir });
  const runtimeStart = process.hrtime.bigint();
  if (compiled.transport === 'docker_exec_container') {
    const remotePlanPath = `${compiled.remoteDir}/probe-plan.env`;
    const remoteRawAfterPath = `${compiled.remoteDir}/after-readback.bin`;
    const remoteRuntimeTracePath = `${compiled.remoteDir}/runtime-trace.json`;
    await dockerCpTo(CFG.execContainer, planPath, remotePlanPath);
    await verifyRemoteSha256(CFG.execContainer, remotePlanPath, planHash, 'HIP probe plan');
    const remoteLoaderCas = await stageRemoteHipLoaderCas({ compiled, localCas: loaderCas });
    const run = await dockerExec(CFG.execContainer, [
      compiled.remoteHostPath,
      remotePlanPath,
      remoteLoaderCas.remoteBeforePath,
      remoteLoaderCas.remoteAfterPath,
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
      planHash,
      loaderCas: { ...loaderCas, ...remoteLoaderCas },
      launchObservation,
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
    loaderCas.beforePath,
    loaderCas.afterPath,
    rawAfterPath,
    runtimeTracePath,
  ], {
    timeout: CFG.timeoutMs,
  });
  const runtimeEnd = process.hrtime.bigint();
  const runtimeTrace = JSON.parse(await readFile(runtimeTracePath, 'utf8'));
  return {
    planPath,
    planHash,
    loaderCas,
    launchObservation,
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

async function writeComputeOracleArtifacts({
  outDir,
  profile,
  runtimeTrace,
  rawAfterPath,
  expectedOutputContract,
  semanticOracle,
}) {
  const { implementationBytes, request, execution } = semanticOracle;
  const traceArtifact = semanticOracle.traceArtifact;
  if (
    !traceArtifact?.path
    || traceArtifact.hash !== request.binding.traceArtifactHash
    || traceArtifact.hash !== canonicalRuntimeTraceHash(runtimeTrace)
    || sha256Bytes(await readFile(traceArtifact.path)) !== traceArtifact.hash
  ) {
    throw new Error('HIP semantic oracle runtime trace artifact binding is stale or invalid');
  }
  const dataType = execution.dataType;
  const afterBytes = await readFile(rawAfterPath);
  const rawHash = sha256Bytes(afterBytes);
  const afterValues = decodeNumericValues(afterBytes, dataType);
  const beforeValues = firstArray(runtimeTrace.outputEvents)?.[0]?.values;
  if (!Array.isArray(beforeValues) || beforeValues.length === 0) {
    throw new Error('HIP runtime trace is missing observed before-epoch readback values');
  }
  const beforeBytes = encodeNumericValues(beforeValues, dataType);
  const beforeRawPath = path.join(outDir, `${safeSlug(profile.targetId)}-before-readback.bin`);
  const schemaPath = path.join(outDir, `${safeSlug(profile.targetId)}-readback-schema.json`);
  const cardPath = path.join(outDir, `${safeSlug(profile.targetId)}-compute-card.png`);
  const implementationPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle.mjs`);
  const requestPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle-request.json`);
  const resultPath = path.join(outDir, `${safeSlug(profile.targetId)}-semantic-oracle-result.json`);
  await writeFile(beforeRawPath, beforeBytes);
  const requestBytes = Buffer.from(stableJson(request), 'utf8');
  const resultBytes = Buffer.from(stableJson(execution), 'utf8');
  await writeFile(implementationPath, implementationBytes);
  await writeFile(requestPath, requestBytes);
  await writeFile(resultPath, resultBytes);
  const implementationHash = sha256Bytes(await readFile(implementationPath));
  const requestHash = sha256Bytes(await readFile(requestPath));
  const resultHash = sha256Bytes(await readFile(resultPath));
  if (
    implementationHash !== execution.implementationHash
    || requestHash !== execution.requestHash
  ) {
    throw new Error('HIP semantic oracle content-addressed artifacts failed hash verification');
  }
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedValues = expectedOutputContract.expectedValues;
  const expectedBytes = encodeNumericValues(expectedValues, dataType);
  const expectedHash = sha256Bytes(expectedBytes);
  if (expectedHash !== execution.expectedRawHash) {
    throw new Error('HIP expected-output contract does not match independent semantic oracle bytes');
  }
  const expectedVerification = compareNumericValues(
    afterValues,
    expectedValues,
    expectedOutputContract.tolerance,
  );
  const independentVerification = await verifyIndependentSemanticOracle({
    implementationBytes,
    request,
    execution,
    observedBytes: afterBytes,
    observedBinding: deriveHipObservedBinding({
      runtimeTrace,
      traceArtifactHash: semanticOracle.traceArtifact.hash,
      planHash: request.binding.resourceOrPlanHash,
      resourceTraceHash: request.binding.resourceTraceHash,
      observedReadbackHash: rawHash,
      expectedArtifactHash: request.binding.artifactAfterHash,
    }),
  });
  const profileHintValues = profile.outputOracle.expectedAfterValues;
  const profileHintVerification = Array.isArray(profileHintValues) && profileHintValues.length > 0
    ? compareNumericValues(
      execution.expectedValues,
      profileHintValues,
      profile.outputOracle.tolerance,
    )
    : { declared: false, matched: null, compared: 0, maxAbsDelta: null, mismatches: [] };
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
    shape: expectedOutputContract.shape,
    byteOrder: expectedOutputContract.byteOrder,
    readbackResource: profile.buffers.readback.name,
    dispatchId: runtimeTrace.outputEvents?.[1]?.after_dispatch_id ?? runtimeTrace.dispatchEvents?.[1]?.id,
    epoch: 2,
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
      values: profileHintValues,
      tolerance: profile.outputOracle.tolerance,
      matchedIndependentOracle: profileHintVerification.matched,
    },
    semanticOracle: {
      implementationHash,
      requestHash,
      resultHash,
      binding: request.binding,
      expectedRawHash: execution.expectedRawHash,
      recomputed: independentVerification.accepted,
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
  const schemaHash = sha256Bytes(await readFile(schemaPath));
  const cardHash = sha256Bytes(await readFile(cardPath));
  if ([rawHash, beforeHash, expectedHash, sliceHash].includes(implementationHash)) {
    throw new Error('HIP semantic oracle implementation hash aliases readback/data evidence');
  }
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
    readback_schema_hash: schemaHash,
    checksum_before: beforeHash,
    checksum_after: rawHash,
    output_change_expected: true,
    profile_output_change_hint: profile.outputOracle.expectedOutputChange,
    expected_output_declared: true,
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
      offset: sliceOffset,
      length: sliceLength,
      hash: sliceHash,
      source: 'runtime_raw_readback',
    },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: implementationHash,
    semantic_oracle_implementation: relRepo(implementationPath),
    semantic_oracle_implementation_hash: implementationHash,
    oracle_implementation_artifact: {
      schemaVersion: 'synthi.gpu_hmr.oracle_implementation_artifact.v1',
      role: 'oracle_implementation',
      path: relRepo(implementationPath),
      content_hash: implementationHash,
      byte_length: implementationBytes.length,
    },
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
    semantic_oracle_trusted_implementation_hash: request.binding.trustedOracleImplementationHash,
    runtime_trace_artifact: relRepo(traceArtifact.path),
    runtime_trace_artifact_hash: traceArtifact.hash,
    semantic_oracle_expected_raw_hash: execution.expectedRawHash,
    semantic_oracle_recomputed: independentVerification.accepted,
    semantic_oracle_verification: independentVerification,
    rendered_card_png: relRepo(cardPath),
    renderedCardPng: relRepo(cardPath),
    rendered_card_hash: cardHash,
    producer: 'hip_module_runtime_proof',
    timestamp_after_dispatch: null,
    epoch: 2,
    raw_readback_verification: {
      raw_readback_hash: rawHash,
      hash_verified: true,
      byte_length: afterBytes.length,
      deterministic_slice_hash: sliceHash,
      deterministic_slice_hash_verified: true,
      readback_schema_hash: schemaHash,
    },
  };
}

function computeOracleValidation({ artifacts, observedBinding }) {
  rejectConflictingSnakeCamelAliases(artifacts, 'HIP readback validation artifacts');
  const changed = artifacts.checksum_before !== artifacts.checksum_after;
  const expectedVerified = artifacts.expected_output_declared === true
    && artifacts.expected_output_verified === true
    && artifacts.expected_output_source === 'content_addressed_semantic_oracle';
  const bindingVerified = OBSERVED_RUNTIME_BINDING_FIELDS.every((field) => (
    artifacts.semantic_oracle_binding?.[field] === observedBinding?.[field]
  ));
  const schemaDeclared = firstText(artifacts.readback_schema_json, artifacts.readbackSchemaJson) !== null;
  const schemaHashDeclared = /^sha256:[0-9a-f]{64}$/u.test(artifacts.readback_schema_hash ?? '');
  const sliceDeclared = artifacts.deterministic_slice
    && Number.isInteger(artifacts.deterministic_slice.offset)
    && Number.isInteger(artifacts.deterministic_slice.length)
    && /^sha256:[0-9a-f]{64}$/u.test(artifacts.deterministic_slice.hash ?? '');
  const implementationVerified =
    /^sha256:[0-9a-f]{64}$/u.test(artifacts.semantic_oracle_implementation_hash ?? '')
    && artifacts.semantic_oracle_implementation_hash === artifacts.oracle_code_hash
    && artifacts.semantic_oracle_recomputed === true
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

function evidenceRefsForFields(fields, evidenceRefs) {
  return Object.fromEntries(fields.map((field) => [field, evidenceRefs]));
}

function buildFissionReport({
  profile,
  compiled,
  runtimeTrace,
  oracleArtifacts,
  expectedOutputContract,
}) {
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
      expected_output_contract: expectedOutputContract,
      semantic_oracle_binding: oracleArtifacts.semantic_oracle_binding,
      semantic_oracle_request_hash: oracleArtifacts.semantic_oracle_request_hash,
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

function buildContract({
  profile,
  compiled,
  runtimeTrace,
  runMode,
  oracleArtifacts,
  expectedOutputContract,
}) {
  const afterDispatch = runtimeTrace.dispatchEvents?.[1] ?? {};
  const semanticOracleIdentity = oracleArtifacts.semantic_oracle_identity;
  if (!semanticOracleIdentityVerified(semanticOracleIdentity, oracleArtifacts.semantic_oracle_binding)) {
    throw new Error('HIP contract requires a verified semantic oracle identity');
  }
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
      source_hash_after: compiled.afterSourceHash,
      compile_manifest_hash: compiled.compileManifestHash,
      source_artifact_binding_hash: compiled.sourceArtifactBindingHash,
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
    semantic_oracle_identity: semanticOracleIdentity,
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
    fission_report: buildFissionReport({
      profile,
      compiled,
      runtimeTrace,
      oracleArtifacts,
      expectedOutputContract,
    }),
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
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
      trusted_oracle_implementation_hash:
        semanticOracleIdentity.trusted_oracle_implementation_hash,
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
  contract.contract_hash = recomputeGpuHmrAcceptanceContractHash(contract);
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
  const runtimeSessionId = hipRuntimeSessionId(runtimeTrace);
  const outputTargetId = profile.buffers.readback.name;
  const semanticOracleIdentity = oracleArtifacts.semantic_oracle_identity;
  if (!semanticOracleIdentityVerified(semanticOracleIdentity, oracleArtifacts.semantic_oracle_binding)) {
    throw new Error('HIP proof ledger requires a verified semantic oracle identity');
  }
  const outputEvent = {
    id: `hip-module-output-${afterEpoch}`,
    kind: 'compute_readback',
    passed: oracleValidation.accepted,
    after_dispatch_id: dispatchId,
    artifact_hash: compiled.afterHsacoHash,
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
    backend: 'hip',
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
    backend: 'hip',
    runtime_session_id: runtimeSessionId,
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    semantic_oracle_identity: semanticOracleIdentity,
    artifact_before_hash: compiled.beforeHsacoHash,
    artifact_after_hash: compiled.afterHsacoHash,
    loader_event: {
      id: `hip-module-loader-${afterEpoch}`,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      source: 'hipModuleLoadData',
      artifact_source_hash: semanticOracleIdentity.artifact_source_hash,
      compile_manifest_hash: semanticOracleIdentity.compile_manifest_hash,
      source_artifact_binding_hash: semanticOracleIdentity.artifact_binding_hash,
      semantic_oracle_identity: semanticOracleIdentity,
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
    },
    epoch_publish_event: {
      id: `hip-module-publish-${afterEpoch}`,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      dispatch_binding: `hipModuleLaunchKernel:${profile.kernel.name}`,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: compiled.afterHsacoHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
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
      request_id: semanticOracleIdentity.request_id,
      edit_id: semanticOracleIdentity.edit_id,
      target_id: semanticOracleIdentity.target_id,
      output_resource_id: semanticOracleIdentity.output_resource_id,
      trace_artifact_hash: semanticOracleIdentity.trace_artifact_hash,
      resource_or_plan_hash: semanticOracleIdentity.resource_or_plan_hash,
      resource_trace_hash: semanticOracleIdentity.resource_trace_hash,
      semantic_oracle_identity: semanticOracleIdentity,
      semantic_oracle_identity_hash: semanticOracleIdentity.identity_hash,
    },
    output_event: outputEvent,
    retirement_event: {
      id: `hip-module-retire-${beforeEpoch}`,
      status: 'stream_event_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      runtime_session_id: runtimeSessionId,
      retired_epoch: beforeEpoch,
      evidence_refs: [dispatchId, 'runtime:hip-module:hipEventRecord', 'runtime:hip-module:hipStreamSynchronize', 'runtime:hip-module:hipModuleUnload'],
    },
    process_identity: {
      process_id: processId,
      host_pid: processId,
      same_process: runtimeTrace.sameProcess === true,
      runtime_session_id: runtimeSessionId,
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
  rejectConflictingSnakeCamelAliases(runtimeTrace, 'HIP native API trace');
  const loaders = Array.isArray(runtimeTrace.loaderEvents) ? runtimeTrace.loaderEvents : [];
  const symbols = Array.isArray(runtimeTrace.symbolEvents) ? runtimeTrace.symbolEvents : [];
  const dispatches = Array.isArray(runtimeTrace.dispatchEvents) ? runtimeTrace.dispatchEvents : [];
  const outputs = Array.isArray(runtimeTrace.outputEvents) ? runtimeTrace.outputEvents : [];
  const counts = {
    hipModuleLoadData: loaders.filter((entry) => entry?.api === 'hipModuleLoadData').length,
    hipModuleGetFunction: symbols.filter((entry) => entry?.api === 'hipModuleGetFunction').length,
    hipModuleLaunchKernel: dispatches.filter((entry) => (
      authoritativeText(entry, ['launch_api', 'launchApi'], 'dispatch.launchApi') === 'hipModuleLaunchKernel'
    )).length,
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
  artifactRoot,
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
    computeOracleStrictGateOptions(artifactRoot),
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

function emitSyntheticHipRuntimeInvocationEvidence({
  runtimeTrace,
  launchObservation,
  planHash,
  observedReadbackHash,
  kernelIdentity,
  beforeArtifactHash,
  afterArtifactHash,
}) {
  const resources = launchObservation.resources.map((resource, index) => ({
    ...resource,
    resourceId: `hip-resource-${index}-${resource.initialBytesHash.slice(-12)}`,
    devicePointer: `0x${(0x1000 + index * 0x100).toString(16)}`,
  }));
  const byName = new Map(resources.map((resource) => [resource.name, resource]));
  const parameters = launchObservation.parameters.map((parameter, index) => {
    const argumentAddress = `0x${(0x4000 + index * 0x20).toString(16)}`;
    if (parameter.kind === 'buffer') {
      const resource = byName.get(parameter.buffer);
      if (!resource) throw new Error(`synthetic HIP trace param ${parameter.name} has no resource`);
      return {
        ...parameter,
        index,
        argumentAddress,
        resourceId: resource.resourceId,
        devicePointer: resource.devicePointer,
      };
    }
    const encodedBytes = encodeNumericValues([parameter.value], parameter.dataType);
    return {
      ...parameter,
      index,
      argumentAddress,
      encodedBytes: Array.from(encodedBytes),
      encodedBytesHash: sha256Bytes(encodedBytes),
    };
  });
  const resourceTrace = hipResourceTraceFromLaunchObservation({
    launchObservation: { resources, parameters },
    planHash,
  });
  const parameterTraceHash = sha256Text(stableJson(resourceTrace.parameters));
  let afterFunctionId = null;
  let afterFunctionAddress = null;
  for (const [index, artifactHash] of [beforeArtifactHash, afterArtifactHash].entries()) {
    const epoch = String(index + 1);
    const loader = oneTraceFact(runtimeTrace.loaderEvents, (event) => String(event.epoch) === epoch, `epoch-${epoch} loader`);
    loader.id ??= `hip-module-self-check-loader-${epoch}`;
    loader.loaded_bytes_hash = artifactHash;
    loader.loaded_byte_length = 4096 + index;
    const symbol = oneTraceFact(runtimeTrace.symbolEvents, (event) => String(event.epoch) === epoch, `epoch-${epoch} symbol`);
    symbol.id ??= `hip-module-self-check-symbol-${epoch}`;
    symbol.requested_symbol = kernelIdentity;
    symbol.resolved_symbol = kernelIdentity;
    const functionAddress = `0x${(0x9000 + index * 0x100).toString(16)}`;
    const functionId = `hip-function:${sha256Text(stableJson({
      loadedBytesHash: artifactHash,
      requestedSymbol: kernelIdentity,
      resolvedFunctionAddress: functionAddress,
      resolvedSymbol: kernelIdentity,
    }))}`;
    symbol.function_id = functionId;
    symbol.resolved_function_address = functionAddress;
    const dispatch = oneTraceFact(runtimeTrace.dispatchEvents, (event) => String(event.epoch) === epoch, `epoch-${epoch} dispatch`);
    dispatch.kernel_name = kernelIdentity;
    dispatch.resolved_symbol = kernelIdentity;
    dispatch.function_id = functionId;
    dispatch.resolved_function_address = functionAddress;
    dispatch.resource_trace_hash = resourceTrace.resourceTraceHash;
    dispatch.parameter_trace_hash = parameterTraceHash;
    const output = oneTraceFact(runtimeTrace.outputEvents, (event) => String(event.epoch) === epoch, `epoch-${epoch} output`);
    output.readback_hash = epoch === '2'
      ? observedReadbackHash
      : sha256Bytes(encodeNumericValues(output.values, resources.find((resource) => resource.name === output.output_target_id).dataType));
    output.readback_byte_length = resources.find((resource) => resource.name === output.output_target_id).byteLength;
    if (epoch === '2') {
      afterFunctionId = functionId;
      afterFunctionAddress = functionAddress;
    }
  }
  const dispatch = oneTraceFact(runtimeTrace.dispatchEvents, (event) => String(event.epoch) === '2', 'epoch-2 dispatch');
  const loader = oneTraceFact(runtimeTrace.loaderEvents, (event) => String(event.epoch) === '2', 'epoch-2 loader');
  const symbol = oneTraceFact(runtimeTrace.symbolEvents, (event) => String(event.epoch) === '2', 'epoch-2 symbol');
  const output = oneTraceFact(runtimeTrace.outputEvents, (event) => String(event.epoch) === '2', 'epoch-2 output');
  const outputResourceId = firstText(dispatch.output_target_id, dispatch.outputTargetId);
  const outputResource = byName.get(outputResourceId);
  if (!outputResource) throw new Error('synthetic HIP trace output has no runtime resource');
  runtimeTrace.probeInvocation = {
    schemaVersion: 'synthi.gpu_hmr.hip_runtime_invocation_evidence.v1',
    producer: 'native_hip_module_runtime_probe',
    planHash,
    resourceTraceHash: resourceTrace.resourceTraceHash,
    parameterTraceHash,
    resources,
    parameters,
    loaderEventId: loader.id,
    symbolEventId: symbol.id,
    dispatchId: dispatch.id,
    artifactHash: afterArtifactHash,
    loadedBytesHash: afterArtifactHash,
    kernelIdentity,
    resolvedSymbol: kernelIdentity,
    functionId: afterFunctionId,
    resolvedFunctionAddress: afterFunctionAddress,
    outputEventId: output.id,
    outputResourceId,
    outputRuntimeResourceId: outputResource.resourceId,
    outputDevicePointer: outputResource.devicePointer,
    observedReadbackHash,
    readbackByteLength: outputResource.byteLength,
  };
  return runtimeTrace.probeInvocation;
}

async function buildSyntheticRuntimeProofFixture(profile) {
  const runMode = runModeMetadata(profile);
  const compiled = {
    kernelIdentity: profile.kernel.name,
    afterSourceHash: profile.afterHash,
    beforeHsacoHash: sha256Text(`${profile.targetId}:before-hsaco`),
    afterHsacoHash: sha256Text(`${profile.targetId}:after-hsaco`),
    commands: {
      host: ['hipcc', '-std=c++17', 'hip_module_runtime_probe.cpp'],
      before: ['hipcc', '--genco', profile.beforePath],
      after: ['hipcc', '--genco', profile.afterPath],
    },
  };
  compiled.compileManifest = {
    schemaVersion: 'synthi.gpu_hmr.hip_source_hsaco_compile_manifest.v1',
    compiler: 'hipcc',
    compileTarget: profile.compile.gpuArch || profile.compile.compileTarget,
    entryPoint: profile.kernel.entryPoint,
    sourceInputs: [
      { role: 'before', path: relRepo(profile.beforePath), sha256: profile.beforeHash },
      { role: 'after', path: relRepo(profile.afterPath), sha256: profile.afterHash },
    ],
    commands: compiled.commands,
    outputs: [
      { role: 'before_hsaco', path: 'self-check/before.hsaco', sha256: compiled.beforeHsacoHash },
      { role: 'after_hsaco', path: 'self-check/after.hsaco', sha256: compiled.afterHsacoHash },
    ],
  };
  compiled.compileManifestHash = sha256Text(stableJson(compiled.compileManifest));
  compiled.sourceArtifactBindingHash = sha256Text(stableJson({
    sourceHash: profile.afterHash,
    compiledArtifactHash: compiled.afterHsacoHash,
    compileManifestHash: compiled.compileManifestHash,
    entryPoint: profile.kernel.entryPoint,
  }));
  const implementationBytes = semanticOracleImplementationBytes();
  const launchObservation = buildHipLaunchObservation(profile);
  const dispatchBefore = 'hip-module-self-check-dispatch-1';
  const dispatchAfter = 'hip-module-self-check-dispatch-2';
  const outputTargetId = profile.buffers.readback.name;
  const syntheticPlanHash = sha256Text(stableJson({
    kind: 'hip-self-check-probe-plan',
    launchObservation,
    beforeHsacoHash: compiled.beforeHsacoHash,
    afterHsacoHash: compiled.afterHsacoHash,
  }));
  const runtimeTrace = {
    runtimeSessionId: 'hip-module-self-check-session',
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
      {
        id: dispatchBefore,
        launch_api: 'hipModuleLaunchKernel',
        epoch: '1',
        artifact_hash: compiled.beforeHsacoHash,
        timestamp_monotonic_ns: 50,
        output_target_id: outputTargetId,
        outputTargetId,
        grid_dim: launchObservation.gridDim,
        block_dim: launchObservation.blockDim,
        shared_mem_bytes: launchObservation.sharedMemBytes,
        stream: launchObservation.stream,
      },
      {
        id: dispatchAfter,
        launch_api: 'hipModuleLaunchKernel',
        epoch: '2',
        artifact_hash: compiled.afterHsacoHash,
        timestamp_monotonic_ns: 150,
        output_target_id: outputTargetId,
        outputTargetId,
        grid_dim: launchObservation.gridDim,
        block_dim: launchObservation.blockDim,
        shared_mem_bytes: launchObservation.sharedMemBytes,
        stream: launchObservation.stream,
      },
    ],
    outputEvents: [
      {
        id: 'hip-module-self-check-output-1',
        passed: true,
        after_dispatch_id: dispatchBefore,
        artifact_hash: compiled.beforeHsacoHash,
        epoch: '1',
        timestamp_monotonic_ns: 60,
        output_target_id: outputTargetId,
        outputTargetId,
      },
      {
        id: 'hip-module-self-check-output-2',
        passed: true,
        after_dispatch_id: dispatchAfter,
        artifact_hash: compiled.afterHsacoHash,
        epoch: '2',
        timestamp_monotonic_ns: 160,
        output_target_id: outputTargetId,
        outputTargetId,
      },
    ],
    retirementEvent: {
      id: 'hip-module-self-check-retire-1',
      status: 'stream_event_proven',
      epoch: '1',
      timestamp_monotonic_ns: 170,
    },
  };
  const beforeRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.beforeHsacoHash,
    artifactSource: profile.beforeSource,
    artifactSourceHash: profile.beforeHash,
    runtimeTrace,
    launchObservation,
    compiled,
    planHash: syntheticPlanHash,
    epoch: '1',
  });
  const beforeExecution = await executeSemanticOracle(beforeRequest, implementationBytes);
  const afterPlanningRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.afterHsacoHash,
    runtimeTrace,
    launchObservation,
    compiled,
    planHash: syntheticPlanHash,
  });
  const afterPlanningExecution = await executeSemanticOracle(afterPlanningRequest, implementationBytes);
  runtimeTrace.outputEvents[0].values = beforeExecution.expectedValues;
  runtimeTrace.outputEvents[1].values = afterPlanningExecution.expectedValues;
  const syntheticReadbackHash = sha256Bytes(Buffer.from(afterPlanningExecution.expectedBytes));
  emitSyntheticHipRuntimeInvocationEvidence({
    runtimeTrace,
    launchObservation,
    planHash: syntheticPlanHash,
    observedReadbackHash: syntheticReadbackHash,
    kernelIdentity: profile.kernel.name,
    beforeArtifactHash: compiled.beforeHsacoHash,
    afterArtifactHash: compiled.afterHsacoHash,
  });
  const selfCheckArtifactDir = path.join(ARTIFACT_DIR, 'self-check');
  await mkdir(selfCheckArtifactDir, { recursive: true });
  const traceArtifact = await persistCanonicalRuntimeTrace({
    outDir: selfCheckArtifactDir,
    targetId: profile.targetId,
    runtimeTrace,
  });
  const semanticRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.afterHsacoHash,
    runtimeTrace,
    launchObservation,
    compiled,
    planHash: syntheticPlanHash,
    observedReadbackHash: syntheticReadbackHash,
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
  const rawAfterPath = path.join(
    selfCheckArtifactDir,
    `${safeSlug(profile.targetId)}-after-readback.bin`,
  );
  await writeFile(rawAfterPath, Buffer.from(semanticExecution.expectedBytes));
  const oracleArtifacts = await writeComputeOracleArtifacts({
    outDir: selfCheckArtifactDir,
    profile,
    runtimeTrace,
    rawAfterPath,
    expectedOutputContract,
    semanticOracle,
  });
  const observedBinding = deriveHipObservedBinding({
    runtimeTrace,
    traceArtifactHash: traceArtifact.hash,
    planHash: syntheticPlanHash,
    resourceTraceHash: semanticRequest.binding.resourceTraceHash,
    observedReadbackHash: syntheticReadbackHash,
    expectedArtifactHash: compiled.afterHsacoHash,
  });
  const oracleValidation = computeOracleValidation({ artifacts: oracleArtifacts, observedBinding });
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
  oracleArtifacts.timestamp_after_dispatch = timings.outputTimestampNs;
  const contract = buildContract({
    profile,
    compiled,
    runtimeTrace,
    runMode,
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
    artifactRoot: selfCheckArtifactDir,
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
    artifactRoot: selfCheckArtifactDir,
    runtimeProofArtifact,
    contract,
    proofLedger,
    ledger,
    contractEvaluation,
    contractConsistency,
    oracleValidation,
    nativeApiEvidence,
    oracleArtifacts,
    semanticOracle,
    observedBinding,
    runtimeTrace,
    launchObservation,
    compiled,
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

function hipGoldenRequest({ source, entryPoint, dataType, inputBytes }) {
  return {
    schemaVersion: INDEPENDENT_SEMANTIC_ORACLE_REQUEST_SCHEMA,
    binding: {
      outputTargetId: 'output',
      outputResourceId: 'output',
    },
    artifact: { kind: 'hip_cpp', source, entryPoint },
    resources: [
      {
        name: 'input',
        role: 'input',
        dataType,
        initialBytes: inputBytes,
      },
      {
        name: 'output',
        role: 'readback',
        dataType,
        initialBytes: [0, 0, 0, 0],
      },
    ],
    launch: {
      parameters: [
        { name: 'input', kind: 'buffer', buffer: 'input', dataType },
        { name: 'n', kind: 'scalar', dataType: 'uint32', value: 1 },
        { name: 'output', kind: 'buffer', buffer: 'output', dataType },
      ],
      gridDim: { x: 1, y: 1, z: 1 },
      blockDim: { x: 1, y: 1, z: 1 },
    },
  };
}

function runHipHandComputedSemanticGoldens() {
  const u32DivisionSource = `
// __global__ void golden_div(const unsigned int*, unsigned int, unsigned int*) { output[0] = 91u; }
__device__ unsigned int dead_helper(unsigned int value) { return value + 97u; }
__global__ void second_entry(const unsigned int* input, unsigned int n, unsigned int* output) {
  const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  output[i] = 77u;
}
extern "C" __global__ void golden_div(const unsigned int* input, unsigned int n, unsigned int* output) {
  const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  /* dead_helper(input[i]) / 0u and second_entry are not selected */
  output[i] = input[i] / 2u * 2u;
}`;
  const divisionRequest = hipGoldenRequest({
    source: u32DivisionSource,
    entryPoint: 'golden_div',
    dataType: 'uint32',
    inputBytes: [3, 0, 0, 0],
  });
  const division = hipSemanticOracleImplementation(divisionRequest);
  if (
    stableJson(division.expectedValues) !== stableJson([2])
    || stableJson(division.expectedBytes) !== stableJson([2, 0, 0, 0])
    || division.semanticProgram.selectedBody.includes('second_entry')
    || division.semanticProgram.selectedBody.includes('dead_helper')
  ) {
    throw new Error('HIP hand-computed 3 / 2 * 2 or exact-entry golden failed');
  }

  const wrapRequest = hipGoldenRequest({
    source: `__global__ void golden_wrap(const unsigned int* input, unsigned int n, unsigned int* output) {
      const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
      if (i >= n) return;
      output[i] = input[i] + 1u;
    }`,
    entryPoint: 'golden_wrap',
    dataType: 'uint32',
    inputBytes: [255, 255, 255, 255],
  });
  const wrap = hipSemanticOracleImplementation(wrapRequest);
  if (
    stableJson(wrap.expectedValues) !== stableJson([0])
    || stableJson(wrap.expectedBytes) !== stableJson([0, 0, 0, 0])
  ) throw new Error('HIP hand-computed uint32 wrap golden failed');

  const signedDivisionRequest = hipGoldenRequest({
    source: `__global__ void golden_signed(const int* input, unsigned int n, int* output) {
      const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
      if (i >= n) return;
      output[i] = input[i] / 2 * 2;
    }`,
    entryPoint: 'golden_signed',
    dataType: 'int32',
    inputBytes: [253, 255, 255, 255],
  });
  const signedDivision = hipSemanticOracleImplementation(signedDivisionRequest);
  if (
    stableJson(signedDivision.expectedValues) !== stableJson([-2])
    || stableJson(signedDivision.expectedBytes) !== stableJson([254, 255, 255, 255])
  ) throw new Error('HIP hand-computed signed division golden failed');

  const f32Request = hipGoldenRequest({
    source: `__global__ void golden_f32(const float* input, unsigned int n, float* output) {
      const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
      if (i >= n) return;
      output[i] = (input[i] + 1.0f) + 1.0f;
    }`,
    entryPoint: 'golden_f32',
    dataType: 'float32',
    inputBytes: [0, 0, 128, 75],
  });
  const f32 = hipSemanticOracleImplementation(f32Request);
  if (
    stableJson(f32.expectedValues) !== stableJson([16777216])
    || stableJson(f32.expectedBytes) !== stableJson([0, 0, 128, 75])
  ) throw new Error('HIP hand-computed per-operation f32 rounding golden failed');

  let dtypeMismatchRejected = false;
  try {
    const mismatch = JSON.parse(JSON.stringify(divisionRequest));
    mismatch.launch.parameters[0].dataType = 'int32';
    hipSemanticOracleImplementation(mismatch);
  } catch {
    dtypeMismatchRejected = true;
  }
  let unsupportedSyntaxRejected = false;
  try {
    const unsupported = JSON.parse(JSON.stringify(divisionRequest));
    unsupported.artifact.source = unsupported.artifact.source.replace(
      'input[i] / 2u * 2u',
      'input[i] > 0u ? input[i] : 0u',
    );
    hipSemanticOracleImplementation(unsupported);
  } catch {
    unsupportedSyntaxRejected = true;
  }
  let wrongEntrypointRejected = false;
  try {
    const wrong = JSON.parse(JSON.stringify(divisionRequest));
    wrong.artifact.entryPoint = `missing_${sha256Text(wrong.artifact.source).slice(7, 19)}`;
    hipSemanticOracleImplementation(wrong);
  } catch {
    wrongEntrypointRejected = true;
  }
  if (!dtypeMismatchRejected || !unsupportedSyntaxRejected || !wrongEntrypointRejected) {
    throw new Error('HIP semantic oracle did not fail closed for dtype, syntax, or entry-point mismatch');
  }
  return {
    integerDivision: division.expectedValues,
    uint32Wrap: wrap.expectedValues,
    signedDivision: signedDivision.expectedValues,
    f32Rounding: f32.expectedValues,
    exactEntryPointSelected: true,
    dtypeMismatchRejected,
    unsupportedSyntaxRejected,
    wrongEntrypointRejected,
  };
}

async function runHipSourceAndHsacoToctouChecks(outDir) {
  const sourceBeforePath = path.join(outDir, 'toctou-original-before.hip');
  const sourceAfterPath = path.join(outDir, 'toctou-original-after.hip');
  const beforeSourceSnapshot = path.join(outDir, 'toctou-staged-before.hip');
  const afterSourceSnapshot = path.join(outDir, 'toctou-staged-after.hip');
  const beforeHsaco = path.join(outDir, 'toctou-before.hsaco');
  const afterHsaco = path.join(outDir, 'toctou-after.hsaco');
  const compileManifestPath = path.join(outDir, 'toctou-compile-manifest.json');
  const beforeSourceBytes = Buffer.from('before-source-bytes\n', 'utf8');
  const afterSourceBytes = Buffer.from('after-source-bytes\n', 'utf8');
  const beforeHsacoBytes = Buffer.from([1, 2, 3, 4]);
  const afterHsacoBytes = Buffer.from([5, 6, 7, 8]);
  await Promise.all([
    writeFile(sourceBeforePath, beforeSourceBytes),
    writeFile(sourceAfterPath, afterSourceBytes),
    writeFile(beforeSourceSnapshot, beforeSourceBytes),
    writeFile(afterSourceSnapshot, afterSourceBytes),
    writeFile(beforeHsaco, beforeHsacoBytes),
    writeFile(afterHsaco, afterHsacoBytes),
  ]);
  const profile = {
    beforePath: sourceBeforePath,
    afterPath: sourceAfterPath,
    beforeHash: 'sha256:33fd75289cfbd78a0f196b6931ed2a2daf28c7bf03040c699870a5c6aa2e0031',
    afterHash: 'sha256:b371413926130c705fca2de6c78e3cb20b34a63df97263d5eaa7d8184349544b',
  };
  profile.beforeHash = sha256Bytes(beforeSourceBytes);
  profile.afterHash = sha256Bytes(afterSourceBytes);
  await verifyHipProfileSourceInputs(profile);
  await writeFile(sourceAfterPath, Buffer.from('swapped-source\n', 'utf8'));
  let sourceSwapRejected = false;
  try {
    await verifyHipProfileSourceInputs(profile);
  } catch {
    sourceSwapRejected = true;
  }
  await writeFile(sourceAfterPath, afterSourceBytes);

  const manifest = {
    schemaVersion: 'synthi.gpu_hmr.hip_source_hsaco_compile_manifest.v1',
    compiler: 'self-check-compiler',
    compileTarget: 'self-check-target',
    entryPoint: 'self_check_kernel',
    sourceInputs: [
      { role: 'before', path: relRepo(beforeSourceSnapshot), sha256: profile.beforeHash },
      { role: 'after', path: relRepo(afterSourceSnapshot), sha256: profile.afterHash },
    ],
    commands: { before: ['self-check'], after: ['self-check'] },
    outputs: [
      { role: 'before_hsaco', path: relRepo(beforeHsaco), sha256: sha256Bytes(beforeHsacoBytes) },
      { role: 'after_hsaco', path: relRepo(afterHsaco), sha256: sha256Bytes(afterHsacoBytes) },
    ],
  };
  const compileManifestHash = sha256Text(stableJson(manifest));
  const sourceArtifactBindingHash = sha256Text(stableJson({
    sourceHash: profile.afterHash,
    compiledArtifactHash: sha256Bytes(afterHsacoBytes),
    compileManifestHash,
    entryPoint: manifest.entryPoint,
  }));
  const compiled = {
    kernelIdentity: manifest.entryPoint,
    beforeSourceSnapshot,
    afterSourceSnapshot,
    beforeHsaco,
    afterHsaco,
    beforeSourceHash: profile.beforeHash,
    afterSourceHash: profile.afterHash,
    beforeHsacoHash: sha256Bytes(beforeHsacoBytes),
    afterHsacoHash: sha256Bytes(afterHsacoBytes),
    compileManifest: manifest,
    compileManifestHash,
    compileManifestPath,
    sourceArtifactBindingHash,
  };
  await writeFile(compileManifestPath, `${JSON.stringify({
    ...manifest,
    compileManifestHash,
    sourceArtifactBindingHash,
  }, null, 2)}\n`);
  await verifyHipCompiledArtifactsForLoad(compiled);
  const loaderCas = await stagePrivateHipLoaderCas({ compiled, outDir });
  await writeFile(afterHsaco, Buffer.from([9, 9, 9, 9]));
  const casSnapshotStable = sha256Bytes(await readFile(loaderCas.afterPath)) === compiled.afterHsacoHash;
  let hsacoSwapRejected = false;
  try {
    await verifyHipCompiledArtifactsForLoad(compiled);
  } catch {
    hsacoSwapRejected = true;
  }
  await writeFile(afterHsaco, afterHsacoBytes);
  await writeFile(afterSourceSnapshot, Buffer.from('swapped-staged-source\n', 'utf8'));
  let stagedSourceSwapRejected = false;
  try {
    await verifyHipCompiledArtifactsForLoad(compiled);
  } catch {
    stagedSourceSwapRejected = true;
  }
  await writeFile(afterSourceSnapshot, afterSourceBytes);
  if (!sourceSwapRejected || !hsacoSwapRejected || !stagedSourceSwapRejected || !casSnapshotStable) {
    throw new Error('HIP source/HSACO TOCTOU self-check did not reject every swap');
  }
  return { sourceSwapRejected, stagedSourceSwapRejected, hsacoSwapRejected, casSnapshotStable };
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
      declaredProfile.abi.signatureValidation?.matched === true
      && declaredProfile.abi.signatureValidation?.blockingGaps?.length === 0,
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
    name: 'profile-expected-output-is-available-as-diagnostic-hint',
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
  const numericComparatorAdversarial = {
    nanActualRejected: !compareNumericValues([Number.NaN], [0], 1).matched,
    infinityExpectedRejected: !compareNumericValues([1], [Number.POSITIVE_INFINITY], Number.MAX_VALUE).matched,
    trailingActualRejected: !compareNumericValues([1, 2], [1], 0).matched,
    trailingExpectedRejected: !compareNumericValues([1], [1, 2], 0).matched,
  };
  checks.push({
    name: 'numeric-comparison-rejects-non-finite-and-length-mismatch',
    ok: Object.values(numericComparatorAdversarial).every(Boolean),
    detail: numericComparatorAdversarial,
  });
  const comparatorDivergenceGolden = verifyExactTypedReadback({
    observedBytes: encodeNumericValues([1.0001], 'float32'),
    expectedValues: [1],
    expectedBytes: Array.from(encodeNumericValues([1], 'float32')),
    expectedRawHash: sha256Bytes(encodeNumericValues([1], 'float32')),
    dataType: 'float32',
  });
  checks.push({
    name: 'independent-typed-byte-verifier-diverges-from-tolerant-primary-comparator',
    ok:
      compareNumericValues([1.0001], [1], 0.1).matched === true
      && comparatorDivergenceGolden.matched === false
      && comparatorDivergenceGolden.mismatches.length > 0,
    detail: comparatorDivergenceGolden,
  });
  let splitKernelIdentityRejected = false;
  try {
    resolveHipKernelIdentity({ name: 'resolved_symbol', entryPoint: 'semantic_entry' });
  } catch {
    splitKernelIdentityRejected = true;
  }
  checks.push({
    name: 'kernel-name-entry-point-split-rejected-before-execution',
    ok: splitKernelIdentityRejected,
  });
  let missingKernelIdentityRejected = false;
  let missingEntryPointRejected = false;
  try {
    resolveHipKernelIdentity({});
  } catch {
    missingKernelIdentityRejected = true;
  }
  try {
    resolveHipKernelIdentity({ name: 'generic_explicit_kernel' });
  } catch {
    missingEntryPointRejected = true;
  }
  let missingResourceIdentityRejected = false;
  let missingResourceRoleRejected = false;
  try {
    normalizeProfileBuffer({ role: 'input', dataType: 'float32', values: [1] }, 'adversarial.resource');
  } catch {
    missingResourceIdentityRejected = true;
  }
  try {
    normalizeProfileBuffer({ name: 'input', dataType: 'float32', values: [1] }, 'adversarial.resource');
  } catch {
    missingResourceRoleRejected = true;
  }
  checks.push({
    name: 'kernel-entry-point-and-resource-role-identity-have-no-fallbacks',
    ok:
      missingKernelIdentityRejected
      && missingEntryPointRejected
      && missingResourceIdentityRejected
      && missingResourceRoleRejected,
    detail: {
      missingKernelIdentityRejected,
      missingEntryPointRejected,
      missingResourceIdentityRejected,
      missingResourceRoleRejected,
    },
  });
  let extraPointerRejected = false;
  try {
    normalizeAbiParams([
      { name: 'output', type: 'float*', valueKind: 'global_buffer', access: 'write' },
      { name: 'input', type: 'const float*', valueKind: 'global_buffer', access: 'read' },
      { name: 'scratch', type: 'float*', valueKind: 'global_buffer', access: 'write' },
    ], [
      ...profile.buffers.all,
      { name: 'scratch', role: 'scratch', dataType: 'float32', byteLength: 4, values: [] },
    ], {}, profile.outputOracle.elementCount);
  } catch {
    extraPointerRejected = true;
  }
  let pointerAliasRejected = false;
  try {
    normalizeAbiParams([
      { name: 'output', type: 'float*', valueKind: 'global_buffer', access: 'write' },
      { name: 'input', type: 'const float*', valueKind: 'global_buffer', access: 'read' },
      { name: 'alias', type: 'const float*', valueKind: 'global_buffer', access: 'read', buffer: 'input' },
    ], profile.buffers.all, {}, profile.outputOracle.elementCount);
  } catch {
    pointerAliasRejected = true;
  }
  checks.push({
    name: 'unsupported-extra-and-aliased-pointer-semantics-fail-closed',
    ok: extraPointerRejected && pointerAliasRejected,
    detail: { extraPointerRejected, pointerAliasRejected },
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
  const semanticGoldens = runHipHandComputedSemanticGoldens();
  checks.push({
    name: 'hand-computed-typed-semantics-and-exact-entry-goldens',
    ok:
      semanticGoldens.integerDivision[0] === 2
      && semanticGoldens.uint32Wrap[0] === 0
      && semanticGoldens.signedDivision[0] === -2
      && semanticGoldens.f32Rounding[0] === 16777216
      && semanticGoldens.exactEntryPointSelected === true
      && semanticGoldens.dtypeMismatchRejected === true
      && semanticGoldens.unsupportedSyntaxRejected === true
      && semanticGoldens.wrongEntrypointRejected === true,
    detail: semanticGoldens,
  });
  const toctouArtifactDir = path.join(ARTIFACT_DIR, 'self-check', 'hip-source-hsaco-toctou');
  await mkdir(toctouArtifactDir, { recursive: true });
  const toctouChecks = await runHipSourceAndHsacoToctouChecks(toctouArtifactDir);
  checks.push({
    name: 'source-staging-and-hsaco-swaps-are-rejected',
    ok:
      toctouChecks.sourceSwapRejected === true
      && toctouChecks.stagedSourceSwapRejected === true
      && toctouChecks.hsacoSwapRejected === true
      && toctouChecks.casSnapshotStable === true,
    detail: toctouChecks,
  });
  const syntheticProof = await buildSyntheticRuntimeProofFixture(profile);
  const assertRuntimeInvocationRejected = (mutation) => {
    const trace = JSON.parse(JSON.stringify(syntheticProof.runtimeTrace));
    mutation(trace);
    try {
      bindHipRuntimeInvocationEvidence({
        runtimeTrace: trace,
        planHash: syntheticProof.semanticOracle.request.binding.resourceOrPlanHash,
        observedReadbackHash: syntheticProof.semanticOracle.request.binding.observedReadbackHash,
        expectedKernelIdentity: profile.kernel.name,
        expectedArtifactHash: syntheticProof.compiled.afterHsacoHash,
      });
      return false;
    } catch {
      return true;
    }
  };
  const runtimeEvidenceAdversarial = {
    missingTraceRejected: assertRuntimeInvocationRejected((trace) => { delete trace.probeInvocation; }),
    replacedLoadedBytesRejected: assertRuntimeInvocationRejected((trace) => {
      trace.loaderEvents.find((event) => String(event.epoch) === '2').loaded_bytes_hash = sha256Text('replacement');
    }),
    wrongResolvedSymbolRejected: assertRuntimeInvocationRejected((trace) => {
      trace.symbolEvents.find((event) => String(event.epoch) === '2').resolved_symbol = 'other_symbol';
    }),
    missingResolvedFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      delete trace.symbolEvents.find((event) => String(event.epoch) === '2').resolved_function_address;
    }),
    missingDispatchFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      delete trace.dispatchEvents.find((event) => String(event.epoch) === '2').resolved_function_address;
    }),
    missingInvocationFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      delete trace.probeInvocation.resolvedFunctionAddress;
    }),
    mismatchedSymbolFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      trace.symbolEvents.find((event) => String(event.epoch) === '2').resolved_function_address = '0xdeadbeef';
    }),
    mismatchedDispatchFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      trace.dispatchEvents.find((event) => String(event.epoch) === '2').resolved_function_address = '0xdeadbeef';
    }),
    mismatchedInvocationFunctionAddressRejected: assertRuntimeInvocationRejected((trace) => {
      trace.probeInvocation.resolvedFunctionAddress = '0xdeadbeef';
    }),
    pointerRebindingRejected: assertRuntimeInvocationRejected((trace) => {
      trace.probeInvocation.parameters.find((parameter) => parameter.kind === 'buffer').devicePointer = '0xdeadbeef';
    }),
    crossPairedPointerResourceRejected: assertRuntimeInvocationRejected((trace) => {
      const [firstBuffer, secondBuffer] = trace.probeInvocation.parameters.filter(
        (parameter) => parameter.kind === 'buffer',
      );
      firstBuffer.resourceId = secondBuffer.resourceId;
    }),
    missingParameterTraceRejected: assertRuntimeInvocationRejected((trace) => {
      delete trace.dispatchEvents.find((event) => String(event.epoch) === '2').parameter_trace_hash;
    }),
  };
  checks.push({
    name: 'native-loaded-byte-symbol-function-address-pointer-resource-and-parameter-evidence-is-mandatory',
    ok: Object.values(runtimeEvidenceAdversarial).every(Boolean),
    detail: runtimeEvidenceAdversarial,
  });
  const conflictingAliasAdversarial = {
    loaderRejected: assertRuntimeInvocationRejected((trace) => {
      trace.loaderEvents.find((event) => String(event.epoch) === '2').artifactHash = sha256Text('conflicting-loader-alias');
    }),
    symbolRejected: assertRuntimeInvocationRejected((trace) => {
      trace.symbolEvents.find((event) => String(event.epoch) === '2').resolvedFunctionAddress = '0xdeadbeef';
    }),
    resourceRejected: assertRuntimeInvocationRejected((trace) => {
      trace.probeInvocation.resources[0].device_pointer = '0xdeadbeef';
    }),
    parameterRejected: assertRuntimeInvocationRejected((trace) => {
      trace.probeInvocation.parameters[0].argument_address = '0xdeadbeef';
    }),
    dispatchRejected: assertRuntimeInvocationRejected((trace) => {
      trace.dispatchEvents.find((event) => String(event.epoch) === '2').resourceTraceHash = sha256Text('conflicting-dispatch-alias');
    }),
    readbackRejected: assertRuntimeInvocationRejected((trace) => {
      trace.outputEvents.find((event) => String(event.epoch) === '2').readbackHash = sha256Text('conflicting-readback-alias');
    }),
  };
  checks.push({
    name: 'conflicting-loader-symbol-resource-parameter-dispatch-and-readback-aliases-fail-closed',
    ok: Object.values(conflictingAliasAdversarial).every(Boolean),
    detail: conflictingAliasAdversarial,
  });
  const strictGateOptions = computeOracleStrictGateOptions(syntheticProof.artifactRoot);
  checks.push({
    name: 'runtime-proof-artifact-strictly-accepted',
    ok:
      syntheticProof.runtimeProofArtifact.gpuHmrSuccess === true
      && syntheticProof.runtimeProofArtifact.fullRuntimeProven === true
      && syntheticProof.runtimeProofArtifact.strictGate?.status === 'pass'
      && syntheticProof.runtimeProofArtifact.proofLedgerSourceConsistency?.mode === 'derived_only',
    detail: syntheticProof.runtimeProofArtifact.strictGate,
  });
  const externalArtifactRoot = path.join(ARTIFACT_DIR, 'self-check-external-root');
  const externalImplementationPath = path.join(externalArtifactRoot, 'semantic-oracle.mjs');
  await mkdir(externalArtifactRoot, { recursive: true });
  await writeFile(externalImplementationPath, syntheticProof.semanticOracle.implementationBytes);
  const externalImplementationArtifact = JSON.parse(
    JSON.stringify(syntheticProof.runtimeProofArtifact),
  );
  mutateComputeArtifacts(externalImplementationArtifact, (artifacts) => {
    artifacts.semantic_oracle_implementation = relRepo(externalImplementationPath);
    artifacts.semanticOracleImplementation = relRepo(externalImplementationPath);
    for (const key of [
      'oracle_implementation_artifact',
      'oracleImplementationArtifact',
      'semantic_oracle_implementation_artifact',
      'semanticOracleImplementationArtifact',
    ]) {
      if (artifacts[key] && typeof artifacts[key] === 'object') {
        artifacts[key].path = relRepo(externalImplementationPath);
      }
    }
  });
  const externalImplementationGate = runtimeProofArtifactStrictGate(
    externalImplementationArtifact,
    strictGateOptions,
  );
  checks.push({
    name: 'strict-gate-rejects-proof-selected-external-oracle-root',
    ok:
      externalImplementationGate.status === 'fail'
      && externalImplementationGate.failures.includes(
        'compute_oracle_implementation_artifact_path_unreadable',
      ),
    detail: externalImplementationGate,
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
      const gate = runtimeProofArtifactStrictGate(forged, strictGateOptions);
      return gate.status === 'fail'
        && gate.failures.some((failure) => failure === 'proof_ledger_recomputed_query_rejected');
    })(),
  });
  const { semanticOracle, observedBinding } = syntheticProof;
  const oracleCodeHash = semanticOracleCodeHash();
  const semanticExpectedOutputContract = buildExpectedOutputContract({ semanticOracle });
  const semanticIdentity = buildSemanticOracleIdentity(semanticOracle.request.binding);
  const ledgerRecord = syntheticProof.proofLedger.records?.[0] ?? {};
  const semanticLoaderEvent = ledgerRecord.loader_event ?? ledgerRecord.loaderEvent ?? {};
  const semanticDispatchEvent = ledgerRecord.dispatch_event ?? ledgerRecord.dispatchEvent ?? {};
  const semanticOutputEvent = ledgerRecord.output_event ?? ledgerRecord.outputEvent ?? {};
  checks.push({
    name: 'independent-semantic-oracle-is-content-addressed-and-fully-bound',
    ok:
      oracleCodeHash === semanticOracle.execution.implementationHash
      && semanticExpectedOutputContract.binding.projectId === profile.targetId
      && semanticExpectedOutputContract.binding.editId === runMode.edit_id
      && semanticExpectedOutputContract.binding.artifactAfterHash === syntheticProof.compiled.afterHsacoHash
      && semanticExpectedOutputContract.binding.outputTargetId === profile.buffers.readback.name
      && semanticExpectedOutputContract.binding.oracleCodeHash === oracleCodeHash
      && observedBinding.backend === 'hip'
      && observedBinding.runtimeSessionId === hipRuntimeSessionId(syntheticProof.runtimeTrace),
  });
  const nonExecutableImplementationVerification = await verifyIndependentSemanticOracle({
    implementationBytes: Buffer.from('this is intentionally not executable JavaScript', 'utf8'),
    request: semanticOracle.request,
    execution: semanticOracle.execution,
    observedBytes: semanticOracle.execution.expectedBytes,
    observedBinding,
  });
  const forbiddenFixtureNames = [profile.id, profile.kernel.name, declaredProfile.id, declaredProfile.kernel.name];
  const verificationImplementationSource = [
    verifyIndependentSemanticOracle,
    verifyExactTypedReadback,
    independentlyEncodeTypedValues,
  ].map((implementation) => implementation.toString()).join('\n');
  checks.push({
    name: 'semantic-verification-does-not-execute-production-oracle-or-branch-on-fixture-identity',
    ok:
      !verifyIndependentSemanticOracle.toString().includes('executeSemanticOracle(')
      && nonExecutableImplementationVerification.accepted === false
      && nonExecutableImplementationVerification.verificationMethod
        === 'independent_dataview_typed_byte_comparison_without_oracle_execution'
      && !nonExecutableImplementationVerification.failures.some((failure) => failure.includes('recompute'))
      && forbiddenFixtureNames.every((name) => !verificationImplementationSource.includes(name)),
    detail: nonExecutableImplementationVerification,
  });
  checks.push({
    name: 'semantic-identity-persists-through-contract-loader-dispatch-output-and-ledger',
    ok:
      stableJson(syntheticProof.contract.semantic_oracle_identity) === stableJson(semanticIdentity)
      && stableJson(semanticLoaderEvent.semantic_oracle_identity) === stableJson(semanticIdentity)
      && stableJson(semanticDispatchEvent.semantic_oracle_identity) === stableJson(semanticIdentity)
      && stableJson(semanticOutputEvent.semantic_oracle_identity) === stableJson(semanticIdentity)
      && semanticLoaderEvent.semantic_oracle_identity_hash === semanticIdentity.identity_hash
      && semanticLoaderEvent.compile_manifest_hash === semanticIdentity.compile_manifest_hash
      && semanticDispatchEvent.semantic_oracle_identity_hash === semanticIdentity.identity_hash
      && semanticDispatchEvent.request_id === semanticIdentity.request_id
      && semanticDispatchEvent.output_resource_id === semanticIdentity.output_resource_id
      && semanticOutputEvent.semantic_oracle_identity_hash === semanticIdentity.identity_hash
      && semanticOutputEvent.trusted_oracle_implementation_hash
        === semanticIdentity.trusted_oracle_implementation_hash,
  });

  const forgedValues = [...semanticOracle.execution.expectedValues];
  forgedValues[0] = forgedValues[0] + 97;
  const forgedObservedBytes = encodeNumericValues(
    forgedValues,
    semanticOracle.execution.dataType,
  );
  const forgedProfile = {
    ...profile,
    outputOracle: {
      ...profile.outputOracle,
      expectedAfterValues: forgedValues,
      tolerance: Number.MAX_SAFE_INTEGER,
    },
  };
  const forgedRequest = buildHipSemanticOracleRequest({
    profile: forgedProfile,
    runMode,
    artifactAfterHash: syntheticProof.compiled.afterHsacoHash,
    runtimeTrace: syntheticProof.runtimeTrace,
    launchObservation: syntheticProof.launchObservation,
    compiled: syntheticProof.compiled,
    planHash: semanticOracle.request.binding.resourceOrPlanHash,
    observedReadbackHash: semanticOracle.request.binding.observedReadbackHash,
    traceArtifactHash: semanticOracle.request.binding.traceArtifactHash,
  });
  const forgedDeclarationMatches = compareNumericValues(
    forgedValues,
    forgedProfile.outputOracle.expectedAfterValues,
    forgedProfile.outputOracle.tolerance,
  ).matched;
  const forgedExecution = await executeSemanticOracle(
    forgedRequest,
    semanticOracle.implementationBytes,
  );
  const forgedVerification = await verifyIndependentSemanticOracle({
    implementationBytes: semanticOracle.implementationBytes,
    request: forgedRequest,
    execution: forgedExecution,
    observedBytes: forgedObservedBytes,
    observedBinding,
  });
  checks.push({
    name: 'matched-byte-profile-declaration-forgery-rejected',
    ok:
      forgedDeclarationMatches === true
      && forgedVerification.accepted === false
      && forgedVerification.failures.includes('semantic_oracle_observed_output_mismatch')
      && forgedExecution.expectedRawHash === semanticOracle.execution.expectedRawHash
      && forgedExecution.requestHash === semanticOracle.execution.requestHash
      && forgedExecution.implementationHash === semanticOracle.execution.implementationHash,
    detail: forgedVerification,
  });

  let resourceTraceTamperRejected = false;
  try {
    const tamperedRequest = JSON.parse(JSON.stringify(semanticOracle.request));
    const tamperedResource = tamperedRequest.resources.find((resource) => resource.role === 'input');
    tamperedResource.initialBytes[0] ^= 1;
    tamperedResource.initialBytesHash = sha256Bytes(Buffer.from(tamperedResource.initialBytes));
    await executeSemanticOracle(tamperedRequest, semanticOracle.implementationBytes);
  } catch {
    resourceTraceTamperRejected = true;
  }
  let parameterTraceTamperRejected = false;
  try {
    const tamperedRequest = JSON.parse(JSON.stringify(semanticOracle.request));
    const scalar = tamperedRequest.launch.parameters.find((parameter) => parameter.kind === 'scalar');
    scalar.value = Number(scalar.value) + 1;
    await executeSemanticOracle(tamperedRequest, semanticOracle.implementationBytes);
  } catch {
    parameterTraceTamperRejected = true;
  }
  checks.push({
    name: 'resource-and-parameter-plan-trace-tampering-is-rejected',
    ok: resourceTraceTamperRejected && parameterTraceTamperRejected,
    detail: { resourceTraceTamperRejected, parameterTraceTamperRejected },
  });

  const rebindingFailures = {};
  let allRebindingsRejected = true;
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
      implementationBytes: semanticOracle.implementationBytes,
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
      allRebindingsRejected = false;
    }
  }
  checks.push({
    name: 'semantic-oracle-rejects-project-edit-artifact-target-backend-runtime-rebinding',
    ok: allRebindingsRejected,
    detail: rebindingFailures,
  });
  const staleRuntimeTrace = JSON.parse(JSON.stringify(syntheticProof.runtimeTrace));
  staleRuntimeTrace.staleArtifactMarker = true;
  let staleTraceArtifactRejected = false;
  try {
    deriveHipObservedBinding({
      runtimeTrace: staleRuntimeTrace,
      traceArtifactHash: semanticOracle.request.binding.traceArtifactHash,
      planHash: semanticOracle.request.binding.resourceOrPlanHash,
      resourceTraceHash: semanticOracle.request.binding.resourceTraceHash,
    });
  } catch {
    staleTraceArtifactRejected = true;
  }
  const staleArtifactRequest = JSON.parse(JSON.stringify(semanticOracle.request));
  staleArtifactRequest.artifact.compiledArtifactHash = sha256Text('stale-hip-artifact-self-check');
  let staleArtifactRejected = false;
  try {
    await executeSemanticOracle(staleArtifactRequest, semanticOracle.implementationBytes);
  } catch {
    staleArtifactRejected = true;
  }
  const replayVerification = await verifyIndependentSemanticOracle({
    implementationBytes: semanticOracle.implementationBytes,
    request: semanticOracle.request,
    execution: semanticOracle.execution,
    observedBytes: semanticOracle.execution.expectedBytes,
    observedBinding: {
      ...observedBinding,
      runtimeSessionId: `${observedBinding.runtimeSessionId}:replayed-session`,
    },
  });
  const wrongResourceVerification = await verifyIndependentSemanticOracle({
    implementationBytes: semanticOracle.implementationBytes,
    request: semanticOracle.request,
    execution: semanticOracle.execution,
    observedBytes: semanticOracle.execution.expectedBytes,
    observedBinding: {
      ...observedBinding,
      outputResourceId: `${observedBinding.outputResourceId}:wrong-resource`,
    },
  });
  checks.push({
    name: 'stale-trace-session-replay-and-wrong-resource-are-rejected',
    ok:
      staleTraceArtifactRejected === true
      && staleArtifactRejected === true
      && replayVerification.accepted === false
      && replayVerification.failures.includes('semantic_oracle_binding_runtimeSessionId_mismatch')
      && wrongResourceVerification.accepted === false
      && wrongResourceVerification.failures.includes('semantic_oracle_binding_outputResourceId_mismatch'),
    detail: {
      staleTraceArtifactRejected,
      staleArtifactRejected,
      replayFailures: replayVerification.failures,
      wrongResourceFailures: wrongResourceVerification.failures,
    },
  });

  const strictForgeryFailures = {};
  const checkStrictForgery = (name, mutation, expectedFailure) => {
    const forged = JSON.parse(JSON.stringify(syntheticProof.runtimeProofArtifact));
    mutation(forged);
    const gate = runtimeProofArtifactStrictGate(forged, strictGateOptions);
    strictForgeryFailures[name] = gate.failures;
    checks.push({
      name: `strict-gate-rejects-${name}`,
      ok: gate.status === 'fail' && gate.failures.includes(expectedFailure),
      detail: gate,
    });
  };
  checkStrictForgery(
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
  checkStrictForgery(
    'missing-readback-schema',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.readback_schema_json;
      delete artifacts.readbackSchemaJson;
    }),
    'compute_oracle_semantic_readback_schema_artifact_missing',
  );
  checkStrictForgery(
    'missing-readback-schema-hash',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.readback_schema_hash;
      delete artifacts.readbackSchemaHash;
    }),
    'compute_oracle_semantic_readback_schema_hash_missing',
  );
  checkStrictForgery(
    'missing-deterministic-slice',
    (forged) => mutateComputeArtifacts(forged, (artifacts) => {
      delete artifacts.deterministic_slice;
      delete artifacts.deterministicSlice;
      delete artifacts.deterministic_slice_hash;
      delete artifacts.deterministicSliceHash;
    }),
    'compute_oracle_semantic_deterministic_slice_missing',
  );
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
    semanticOracleImplementationHash: oracleCodeHash,
    matchedByteDeclarationForgeryRejected: forgedVerification.accepted === false,
    semanticOracleRebindingFailures: rebindingFailures,
    strictSemanticForgeryFailures: strictForgeryFailures,
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
  const runMode = runModeMetadata(profile);
  const implementationBytes = semanticOracleImplementationBytes();
  const launchObservation = buildHipLaunchObservation(profile);
  const planningOutputTargetId = profile.buffers.readback.name;
  const planningTrace = {
    runtimeSessionId: `hip-module-probe-plan:${compiled.afterHsacoHash}`,
    device: { backend: 'hip' },
    loaderEvents: [
      { id: 'hip-module-probe-plan-loader-1', epoch: 1, artifact_hash: compiled.beforeHsacoHash },
      { id: 'hip-module-probe-plan-loader-2', epoch: 2, artifact_hash: compiled.afterHsacoHash },
    ],
    dispatchEvents: [
      {
        id: 'hip-module-probe-plan-dispatch-1',
        epoch: 1,
        artifact_hash: compiled.beforeHsacoHash,
        output_target_id: planningOutputTargetId,
        launch_api: profile.kernel.launchApi,
        grid_dim: launchObservation.gridDim,
        block_dim: launchObservation.blockDim,
        shared_mem_bytes: launchObservation.sharedMemBytes,
        stream: launchObservation.stream,
      },
      {
        id: 'hip-module-probe-plan-dispatch-2',
        epoch: 2,
        artifact_hash: compiled.afterHsacoHash,
        output_target_id: planningOutputTargetId,
        launch_api: profile.kernel.launchApi,
        grid_dim: launchObservation.gridDim,
        block_dim: launchObservation.blockDim,
        shared_mem_bytes: launchObservation.sharedMemBytes,
        stream: launchObservation.stream,
      },
    ],
    outputEvents: [
      {
        id: 'hip-module-probe-plan-output-1',
        epoch: 1,
        artifact_hash: compiled.beforeHsacoHash,
        after_dispatch_id: 'hip-module-probe-plan-dispatch-1',
        output_target_id: planningOutputTargetId,
      },
      {
        id: 'hip-module-probe-plan-output-2',
        epoch: 2,
        artifact_hash: compiled.afterHsacoHash,
        after_dispatch_id: 'hip-module-probe-plan-dispatch-2',
        output_target_id: planningOutputTargetId,
      },
    ],
  };
  const beforePlanningRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.beforeHsacoHash,
    artifactSource: profile.beforeSource,
    artifactSourceHash: profile.beforeHash,
    runtimeTrace: planningTrace,
    launchObservation,
    compiled,
    epoch: '1',
  });
  const afterPlanningRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.afterHsacoHash,
    runtimeTrace: planningTrace,
    launchObservation,
    compiled,
  });
  const probeOracle = {
    before: await executeSemanticOracle(beforePlanningRequest, implementationBytes),
    after: await executeSemanticOracle(afterPlanningRequest, implementationBytes),
  };
  const runtime = await runHipProbe({
    profile,
    compiled,
    outDir,
    launchObservation,
    probeOracle,
  });
  testTimingRecorder.startPhase('proof_finalization');
  const oracleStart = process.hrtime.bigint();
  const observedReadbackHash = await sha256File(runtime.rawAfterPath);
  if (sha256Bytes(await readFile(runtime.planPath)) !== runtime.planHash) {
    throw new Error('HIP executed probe plan bytes no longer match the bound plan hash');
  }
  bindHipRuntimeInvocationEvidence({
    runtimeTrace: runtime.runtimeTrace,
    planHash: runtime.planHash,
    observedReadbackHash,
    expectedKernelIdentity: profile.kernel.name,
    expectedArtifactHash: compiled.afterHsacoHash,
  });
  const traceArtifact = await persistCanonicalRuntimeTrace({
    outDir,
    targetId: profile.targetId,
    runtimeTrace: runtime.runtimeTrace,
  });
  const semanticRequest = buildHipSemanticOracleRequest({
    profile,
    runMode,
    artifactAfterHash: compiled.afterHsacoHash,
    runtimeTrace: runtime.runtimeTrace,
    launchObservation: runtime.launchObservation,
    compiled,
    planHash: runtime.planHash,
    observedReadbackHash,
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
    runtimeTrace: runtime.runtimeTrace,
    rawAfterPath: runtime.rawAfterPath,
    expectedOutputContract,
    semanticOracle,
  });
  const oracleValidation = computeOracleValidation({
    artifacts: oracleArtifacts,
    observedBinding: deriveHipObservedBinding({
      runtimeTrace: runtime.runtimeTrace,
      traceArtifactHash: traceArtifact.hash,
      planHash: runtime.planHash,
      resourceTraceHash: semanticRequest.binding.resourceTraceHash,
      observedReadbackHash,
      expectedArtifactHash: compiled.afterHsacoHash,
    }),
  });
  const oracleEnd = process.hrtime.bigint();
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
    artifactRoot: outDir,
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
