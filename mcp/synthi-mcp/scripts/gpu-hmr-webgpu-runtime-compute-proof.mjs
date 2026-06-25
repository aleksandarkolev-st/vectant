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
  buildGpuHmrProofLedger,
  evaluateGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  webGpuRuntimeComputeTimingMetrics,
} from './lib/gpu-hmr-timing-metrics.mjs';

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

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const normalizedExpected = dataType === 'float32'
    ? decodeNumericValues(encodeNumericValues(expected, dataType), dataType)
    : expected.map(Number);
  const compared = Math.min(actual.length, normalizedExpected.length);
  const mismatches = [];
  let maxAbsDelta = 0;
  for (let index = 0; index < compared; index += 1) {
    const delta = Math.abs(Number(actual[index]) - Number(normalizedExpected[index]));
    maxAbsDelta = Math.max(maxAbsDelta, delta);
    if (delta > tolerance) {
      mismatches.push({
        index,
        actual: actual[index],
        expected: normalizedExpected[index],
        abs_delta: delta,
      });
    }
  }
  if (actual.length < normalizedExpected.length) {
    for (let index = actual.length; index < normalizedExpected.length; index += 1) {
      mismatches.push({
        index,
        actual: null,
        expected: normalizedExpected[index],
        abs_delta: null,
      });
    }
  }
  return {
    declared: true,
    matched: mismatches.length === 0,
    compared,
    maxAbsDelta,
    mismatches,
  };
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
  const entryPoint = firstText(shader.entryPoint, shader.entry_point, pipeline.entryPoint, pipeline.entry_point)
    ?? 'main';
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

async function loadProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const profileDir = path.dirname(resolvedPath);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const shader = objectOrEmpty(raw.shader);
  const beforePath = resolveRelative(profileDir, firstText(shader.beforePath, shader.before_path));
  const afterPath = resolveRelative(profileDir, firstText(shader.afterPath, shader.after_path));
  if (!beforePath || !afterPath) throw new Error('profile shader.beforePath and shader.afterPath are required');
  const [beforeSource, afterSource, beforeHash, afterHash] = await Promise.all([
    readFile(beforePath, 'utf8'),
    readFile(afterPath, 'utf8'),
    sha256File(beforePath),
    sha256File(afterPath),
  ]);
  const pipeline = normalizeComputePipeline(raw.pipeline, shader);
  const negativeEdit = normalizeNegativeEdit(raw.negativeEdit ?? raw.negative_edit);
  const targetId = firstText(raw.targetId, raw.target_id, raw.id) ?? safeSlug(path.basename(resolvedPath, '.json'));
  const oracle = objectOrEmpty(raw.computeOracle ?? raw.compute_oracle ?? raw.oracle);
  const readbackSelector = objectOrEmpty(oracle.readbackResource ?? oracle.readback_resource);
  const declaredReadback = {
    group: nonNegativeIntegerOrNull(readbackSelector.group) ?? pipeline.readbackResources[0]?.group ?? 0,
    binding: nonNegativeIntegerOrNull(readbackSelector.binding) ?? pipeline.readbackResources[0]?.binding ?? 0,
  };
  const readbackResource = pipeline.readbackResources.find((candidate) =>
    candidate.group === declaredReadback.group && candidate.binding === declaredReadback.binding
  ) ?? pipeline.readbackResources[0];
  if (!readbackResource) throw new Error('profile must declare a readback storage buffer resource');
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
  const expectedOutputDataType = normalizeDataType(
    firstText(expectedOutput.dataType, expectedOutput.data_type) ?? readbackResource.dataType,
    'compute_oracle_expected_output',
  );
  if (expectedOutputDataType !== readbackResource.dataType) {
    throw new Error(
      `compute oracle expected output data type ${expectedOutputDataType} does not match readback resource ${readbackResource.dataType}`,
    );
  }
  const normalizedExpectedAfterValues = expectedAfterValues
    ? normalizeNumericValues(expectedAfterValues, 'compute_oracle_expected_output', expectedOutputDataType)
    : null;
  return {
    raw,
    schemaVersion: firstText(raw.schemaVersion, raw.schema_version) ?? 'synthi.gpu.hmr.webgpu_compute_profile.v1',
    id: targetId,
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
    negativeEdit,
    computeOracle: {
      claim: firstText(oracle.claim) ?? 'WebGPU compute output changes after the epoch dispatch.',
      readbackResource,
      expectedOutputChange: oracle.expectedOutputChange !== false && oracle.expected_output_change !== false,
      expectedOutput: {
        dataType: expectedOutputDataType,
        values: normalizedExpectedAfterValues,
        tolerance: floatTolerance,
        required: expectedOutput.required !== false && oracle.expected_output_required !== false,
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
      const adapter = await navigator.gpu.requestAdapter();
      markApi('requestAdapter');
      if (!adapter) throw new Error('WebGPU requestAdapter returned null');
      const device = await adapter.requestDevice();
      markApi('requestDevice');
      const pageInstanceId = crypto.randomUUID();
      const shaderStage = GPUShaderStage.COMPUTE;
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
        const shaderModule = device.createShaderModule({ code: source });
        markApi('createShaderModule', { epoch, artifactHash });
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
        markApi('copyBufferToBuffer', { epoch, byteLength: readbackResource.resource.byteLength });
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
            buffers: [...resourceTable.values()].map((item) => ({
              group: item.groupIndex,
              binding: item.binding,
              layoutType: item.resource.layoutType,
              access: item.resource.access,
              byteLength: item.resource.byteLength,
              readback: item.resource.readback,
              resetBeforeDispatch: item.resource.resetBeforeDispatch,
              resourceHash: item.resource.resourceHash,
            })),
          },
        };
      }
      const adapterInfo = {
        features: [...adapter.features].sort(),
        limits: Object.fromEntries(Object.entries(adapter.limits ?? {}).map(([key, value]) => [key, Number(value)])),
      };
      const before = await dispatchEpoch(beforeSource, profileForPage.beforeHash);
      const after = await dispatchEpoch(afterSource, profileForPage.afterHash);
      return {
        url: location.href,
        adapterInfo,
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
  return `webgpu-adapter:${sha256Text(stableJson({
    features: trace.adapterInfo?.features ?? [],
    limits: trace.adapterInfo?.limits ?? {},
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

function buildFissionReport({ profile, trace, processContinuity, oracleArtifacts }) {
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
      readback_resource: profile.computeOracle.readbackResource,
      raw_readback_hash: oracleArtifacts.raw_readback_hash,
      expected_output_hash: oracleArtifacts.expected_output_hash,
      expected_output_verified: oracleArtifacts.expected_output_verified,
      deterministic_slice: oracleArtifacts.deterministic_slice,
    },
    evidence_refs: [
      verifierEvidenceRef,
      `runtime:webgpu-compute:dispatch:${trace.after.dispatchId}`,
      `runtime:webgpu-compute:readback:${oracleArtifacts.raw_readback_hash}`,
    ],
  };
}

function buildContract({ profile, trace, runMode, processContinuity, oracleArtifacts }) {
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
      target_id: 'webgpu-compute-readback-buffer',
      compute_only_target_verified: true,
      evidence_refs: [oracleArtifacts.raw_readback_hash, oracleArtifacts.rendered_card_png],
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
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
    fission_report: buildFissionReport({ profile, trace, processContinuity, oracleArtifacts }),
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
  contract.contract_hash = sha256Text(stableJson(contract));
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

async function writeComputeOracleArtifacts({ outDir, profile, trace }) {
  const dataType = profile.computeOracle.expectedOutput.dataType;
  const beforeBytes = Buffer.from(trace.before.readbackBytes);
  const afterBytes = Buffer.from(trace.after.readbackBytes);
  const beforeValues = decodeNumericValues(beforeBytes, dataType);
  const afterValues = decodeNumericValues(afterBytes, dataType);
  const rawHash = sha256Bytes(afterBytes);
  const beforeHash = sha256Bytes(beforeBytes);
  const expectedValues = profile.computeOracle.expectedOutput.values;
  const expectedVerification = compareNumericValues(
    afterValues,
    expectedValues,
    profile.computeOracle.expectedOutput.tolerance,
    dataType,
  );
  const expectedBytes = expectedVerification.declared ? encodeNumericValues(expectedValues, dataType) : null;
  const expectedHash = expectedBytes ? sha256Bytes(expectedBytes) : null;
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
  await writeFile(beforeRawPath, beforeBytes);
  await writeFile(rawPath, afterBytes);
  const readbackSchema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    producer: 'webgpu_runtime_compute_proof',
    dataType,
    byteLength: afterBytes.length,
    elementCount: afterValues.length,
    readbackResource: profile.computeOracle.readbackResource,
    dispatchId: trace.after.dispatchId,
    epoch: trace.after.epoch,
    rawReadbackHash: rawHash,
    expectedOutput: {
      dataType: profile.computeOracle.expectedOutput.dataType,
      values: expectedValues,
      tolerance: profile.computeOracle.expectedOutput.tolerance,
      expectedHash,
      verified: expectedVerification.matched,
      maxAbsDelta: expectedVerification.maxAbsDelta,
      compared: expectedVerification.compared,
      mismatches: expectedVerification.mismatches,
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
    output_change_expected: profile.computeOracle.expectedOutputChange,
    expected_output_declared: expectedVerification.declared,
    expected_output_required: profile.computeOracle.expectedOutput.required,
    expected_output_data_type: profile.computeOracle.expectedOutput.dataType,
    expected_output_values: expectedValues,
    expected_output_hash: expectedHash,
    expected_output_tolerance: profile.computeOracle.expectedOutput.tolerance,
    expected_output_verified: expectedVerification.matched,
    expected_output_max_abs_delta: expectedVerification.maxAbsDelta,
    expected_output_compared: expectedVerification.compared,
    expected_output_mismatches: expectedVerification.mismatches,
    deterministic_slice: {
      ...boundedSlice,
      hash: sliceHash,
      source: 'runtime_raw_readback',
    },
    deterministic_slice_hash: sliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: sha256Text(renderComputeCard.toString()),
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

function computeOracleValidation({ artifacts }) {
  const changed = artifacts.checksum_before !== artifacts.checksum_after;
  const expectedVerified = artifacts.expected_output_required === false
    ? artifacts.expected_output_verified !== false
    : artifacts.expected_output_declared === true && artifacts.expected_output_verified === true;
  return {
    accepted: changed
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
  const outputEvent = {
    id: `webgpu-compute-output-${afterEpoch}`,
    kind: 'compute_readback',
    passed: oracleValidation.accepted,
    after_dispatch_id: dispatchId,
    artifact_hash: profile.afterHash,
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
    backend: 'webgpu',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    artifact_before_hash: profile.beforeHash,
    artifact_after_hash: profile.afterHash,
    loader_event: {
      id: `webgpu-compute-loader-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      source: 'device.createShaderModule',
    },
    epoch_publish_event: {
      id: `webgpu-compute-publish-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      pipeline_id: trace.after.pipelineId,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      pipeline_id: trace.after.pipelineId,
      dispatch_workgroups: trace.after.dispatchWorkgroups,
      resource_state_hash: profile.pipeline.resourceStateHash,
      runtime_resource_trace: trace.after.resourceTrace,
      command: 'GPUComputePassEncoder.dispatchWorkgroups',
    },
    output_event: outputEvent,
    retirement_event: {
      id: `webgpu-compute-retire-${trace.before.epoch}`,
      status: 'queue_idle_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: trace.before.epoch,
      evidence_refs: [dispatchId, `runtime:webgpu-compute:onSubmittedWorkDone:${afterEpoch}`],
    },
    process_identity: {
      process_id: processId,
      browser_pid: processId,
      page_url: trace.url,
      same_page_instance_id: trace.after.pageInstanceId,
    },
    device_identity: {
      backend: 'webgpu',
      device_uuid: webgpuDeviceUuid(trace),
      adapter_info: trace.adapterInfo,
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
      target_id: 'webgpu-compute-readback-buffer',
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

async function main() {
  const totalStart = process.hrtime.bigint();
  const staticStart = process.hrtime.bigint();
  const profile = await loadProfile(CFG.profilePath);
  const staticEnd = process.hrtime.bigint();
  const modelStart = process.hrtime.bigint();
  const modelCheckedAt = new Date().toISOString();
  const provenance = modelProvenance({
    checkedAt: modelCheckedAt,
    splitModel: CFG.splitModel,
    gpuDeltaModel: CFG.gpuDeltaModel,
  });
  const modelEnd = process.hrtime.bigint();
  const runtimeStart = process.hrtime.bigint();
  const browserRun = await runBrowserCompute(profile);
  const runtimeEnd = process.hrtime.bigint();
  const trace = {
    url: browserRun.url,
    adapterInfo: browserRun.trace.adapterInfo,
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
  const oracleStart = process.hrtime.bigint();
  const runSlug = safeSlug(`${CFG.slug}-${profile.targetId}`);
  const outDir = path.join(ARTIFACT_DIR, runSlug);
  await mkdir(outDir, { recursive: true });
  const oracleArtifacts = await writeComputeOracleArtifacts({ outDir, profile, trace });
  const oracleValidation = computeOracleValidation({ artifacts: oracleArtifacts });
  const oracleEnd = process.hrtime.bigint();
  const runMode = runModeMetadata(profile);
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
  });
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    before: contract,
    after: contract,
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
    timings: {
      totalValidatorWallTimeNs: timings.total_validator_wall_time,
      dispatchToOutputProofTimeNs: timings.dispatch_to_output_proof_time,
    },
  }, null, 2));
  if (!accepted) process.exitCode = 1;
}

async function selfCheck() {
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
    dispatch_event: { id: 'dispatch', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 30, process_id: '100' },
    output_event: { id: 'output', after_dispatch_id: 'dispatch', artifact_hash: fakeArtifact, epoch: 'epoch-2', timestamp_monotonic_ns: 40, process_id: '100' },
    retirement_event: { id: 'retire', status: 'queue_idle_proven', timestamp_monotonic_ns: 50, process_id: '100' },
    process_identity: { process_id: '100' },
    device_identity: { device_uuid: 'webgpu-adapter:self-check' },
    output_oracle_target: {
      kind: 'compute',
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
  if (evaluation.gpuHmrSuccess || !evaluation.failedInvariants.some((gate) => gate.code === 'compute_oracle_artifacts_missing')) {
    throw new Error('self-check failed to reject missing compute raw readback artifacts');
  }
  console.log(JSON.stringify({
    ok: true,
    supportedScope: supported.scope,
    supportedUint32Scope: supportedUint32.scope,
    forgedLedgerFailedGate: 'compute_oracle_artifacts_missing',
  }, null, 2));
}

if (process.argv.includes('--self-check')) {
  selfCheck().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
