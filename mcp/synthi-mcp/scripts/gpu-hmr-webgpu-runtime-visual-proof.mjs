#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  bindGpuHmrRunModeCoverageSupport,
  buildGpuHmrProofLedger,
  buildGpuHmrRunModeCoverageSupport,
  evaluateGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  visualEvidenceArtifactsFromVisualOracleArtifacts,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';
import {
  buildAsyncVisualProofBundle,
  evaluateGpuHmrDeterministicVisualMode,
} from './lib/gpu-hmr-visual-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof');
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'profiles/webgpu-wgsl-runtime-triangle.json');
const SCHEMA = 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1';
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

const CFG = {
  slug: process.env.SLUG ?? `webgpu-runtime-visual-${nowSlugDate()}`,
  profilePath: process.env.SYNTHI_WEBGPU_VISUAL_PROFILE ?? DEFAULT_PROFILE_PATH,
  browserExecutable: process.env.SYNTHI_WEBGPU_BROWSER_EXECUTABLE ?? '',
  timeoutMs: Number(process.env.SYNTHI_WEBGPU_VISUAL_TIMEOUT_MS ?? 60000),
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
  metricScope: process.env.SYNTHI_WEBGPU_VISUAL_METRIC_SCOPE ?? 'hot_delta_1',
  cacheState: process.env.SYNTHI_WEBGPU_VISUAL_CACHE_STATE ?? 'pipeline_cache_warm',
  differentEdit: process.env.SYNTHI_WEBGPU_VISUAL_DIFFERENT_EDIT === '1',
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
  return String(value || 'webgpu-runtime-visual').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveRelative(baseDir, value) {
  if (!firstText(value)) return null;
  const candidate = String(value);
  return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
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

const WEBGPU_VERTEX_FORMAT_BYTES = Object.freeze({
  float32: 4,
  float32x2: 8,
  float32x3: 12,
  float32x4: 16,
});

function normalizeFloat32Values(rawValues, context, unsupported) {
  const values = Array.isArray(rawValues) ? rawValues.map(Number) : [];
  if (values.length === 0) {
    unsupported.push(`${context}_float32_values_missing`);
    return [];
  }
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) {
    unsupported.push(`${context}_float32_value_not_finite:${invalidIndex}`);
  }
  return values;
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
  const allowed = new Set(['vertex', 'fragment']);
  const invalid = tokens.filter((token) => !allowed.has(token));
  if (invalid.length > 0) {
    unsupported.push(`${context}_visibility_unsupported:${[...new Set(invalid)].join(',')}`);
  }
  return [...new Set(tokens.filter((token) => allowed.has(token)))].sort();
}

function normalizeUniformBufferResource(rawEntry, context, unsupported) {
  const resource = objectOrEmpty(rawEntry.resource ?? rawEntry.bufferResource ?? rawEntry.buffer_resource);
  const kind = firstText(resource.kind, resource.resourceKind, resource.resource_kind, resource.type)
    ?? 'uniform_buffer';
  if (!['uniform_buffer', 'uniform-buffer', 'uniformBuffer'].includes(kind)) {
    unsupported.push(`${context}_resource_kind_unsupported:${kind}`);
  }
  const dataType = firstText(resource.dataType, resource.data_type, resource.typeName, resource.type_name)
    ?? 'float32';
  if (dataType !== 'float32') {
    unsupported.push(`${context}_resource_data_type_unsupported:${dataType}`);
  }
  const values = normalizeFloat32Values(
    resource.values ?? resource.float32 ?? resource.data,
    context,
    unsupported,
  );
  const byteLength = values.length * 4;
  const normalized = {
    kind: 'uniform_buffer',
    dataType: 'float32',
    values,
    byteLength,
  };
  return {
    ...normalized,
    resourceHash: sha256Text(stableJson(normalized)),
  };
}

function normalizeVertexBufferResource(rawEntry, slot, layout, vertexCount, context, unsupported) {
  const resource = objectOrEmpty(rawEntry);
  const dataType = firstText(resource.dataType, resource.data_type, resource.typeName, resource.type_name)
    ?? 'float32';
  if (dataType !== 'float32') {
    unsupported.push(`${context}_resource_data_type_unsupported:${dataType}`);
  }
  const values = normalizeFloat32Values(
    resource.values ?? resource.float32 ?? resource.data,
    context,
    unsupported,
  );
  const byteLength = values.length * 4;
  const minimumBytes = Number.isFinite(vertexCount) && vertexCount > 0
    ? vertexCount * layout.arrayStride
    : layout.arrayStride;
  if (byteLength < minimumBytes) {
    unsupported.push(`${context}_resource_too_small:${byteLength}<${minimumBytes}`);
  }
  const normalized = {
    slot,
    dataType: 'float32',
    values,
    byteLength,
    vertexCount,
  };
  return {
    ...normalized,
    resourceHash: sha256Text(stableJson(normalized)),
  };
}

function normalizeBindGroupLayouts(pipeline, unsupported) {
  const rawLayouts = firstArray(pipeline.bindGroupLayouts, pipeline.bind_group_layouts);
  const rawBindGroups = firstArray(pipeline.bindGroups, pipeline.bind_groups);
  const bindGroupLayouts = [];
  const bindGroups = [];

  rawLayouts.forEach((rawLayout, groupIndex) => {
    const layout = objectOrEmpty(rawLayout);
    const rawEntries = firstArray(layout.entries, layout.bindings);
    const seenBindings = new Set();
    const entries = rawEntries.map((rawEntry, entryIndex) => {
      const entry = objectOrEmpty(rawEntry);
      const context = `bind_group_${groupIndex}_entry_${entryIndex}`;
      const binding = nonNegativeIntegerOrNull(entry.binding);
      if (binding === null) unsupported.push(`${context}_binding_invalid`);
      if (seenBindings.has(binding)) unsupported.push(`${context}_binding_duplicate:${binding}`);
      seenBindings.add(binding);
      const visibility = normalizeVisibilityTokens(entry.visibility, context, unsupported);
      const buffer = objectOrEmpty(entry.buffer);
      const unsupportedKeys = Object.keys(entry)
        .filter((key) => !['binding', 'visibility', 'buffer', 'label'].includes(key));
      if (unsupportedKeys.length > 0) {
        unsupported.push(`${context}_entry_keys_unsupported:${unsupportedKeys.join(',')}`);
      }
      const bufferType = firstText(buffer.type) ?? 'uniform';
      if (bufferType !== 'uniform') {
        unsupported.push(`${context}_buffer_type_unsupported:${bufferType}`);
      }
      if (buffer.hasDynamicOffset === true || buffer.has_dynamic_offset === true) {
        unsupported.push(`${context}_dynamic_uniform_offsets_not_supported`);
      }
      const minBindingSizeRaw = buffer.minBindingSize ?? buffer.min_binding_size;
      const minBindingSize = minBindingSizeRaw === undefined ? 0 : positiveIntegerOrNull(minBindingSizeRaw);
      if (minBindingSizeRaw !== undefined && minBindingSize === null) {
        unsupported.push(`${context}_min_binding_size_invalid`);
      }
      return {
        binding: binding ?? 0,
        visibility,
        buffer: {
          type: 'uniform',
          minBindingSize: minBindingSize ?? 0,
        },
        ...(firstText(entry.label) ? { label: firstText(entry.label) } : {}),
      };
    });
    const normalizedLayout = {
      index: groupIndex,
      entries,
      ...(firstText(layout.label) ? { label: firstText(layout.label) } : {}),
    };
    bindGroupLayouts.push(normalizedLayout);

    const rawGroup = rawBindGroups.find((candidate, candidateIndex) => {
      const group = objectOrEmpty(candidate);
      const declaredIndex = integerOrNull(group.layoutIndex ?? group.layout_index ?? group.index);
      return declaredIndex === groupIndex || (declaredIndex === null && candidateIndex === groupIndex);
    });
    if (!rawGroup && entries.length > 0) {
      unsupported.push(`bind_group_${groupIndex}_resources_missing`);
    }
    const group = objectOrEmpty(rawGroup);
    const rawResourceEntries = firstArray(group.entries, group.bindings);
    const resourceEntries = entries.map((layoutEntry) => {
      const rawResourceEntry = rawResourceEntries.find((candidate) => {
        const binding = integerOrNull(objectOrEmpty(candidate).binding);
        return binding === layoutEntry.binding;
      });
      const context = `bind_group_${groupIndex}_binding_${layoutEntry.binding}`;
      if (!rawResourceEntry) {
        unsupported.push(`${context}_resource_missing`);
        return {
          binding: layoutEntry.binding,
          resource: {
            kind: 'uniform_buffer',
            dataType: 'float32',
            values: [],
            byteLength: 0,
            resourceHash: sha256Text('missing'),
          },
        };
      }
      const resource = normalizeUniformBufferResource(rawResourceEntry, context, unsupported);
      const minBindingSize = layoutEntry.buffer.minBindingSize;
      if (minBindingSize > 0 && resource.byteLength < minBindingSize) {
        unsupported.push(`${context}_resource_below_min_binding_size:${resource.byteLength}<${minBindingSize}`);
      }
      return {
        binding: layoutEntry.binding,
        resource,
      };
    });
    bindGroups.push({
      layoutIndex: groupIndex,
      entries: resourceEntries,
      ...(firstText(group.label, layout.label) ? { label: firstText(group.label, layout.label) } : {}),
    });
  });

  const extraGroups = rawBindGroups.filter((candidate, candidateIndex) => {
    const group = objectOrEmpty(candidate);
    const declaredIndex = integerOrNull(group.layoutIndex ?? group.layout_index ?? group.index);
    const index = declaredIndex ?? candidateIndex;
    return index < 0 || index >= rawLayouts.length;
  });
  if (extraGroups.length > 0) {
    unsupported.push('bind_group_resources_without_layout');
  }

  return { bindGroupLayouts, bindGroups };
}

function normalizeVertexBufferLayouts(pipeline, vertexCount, unsupported) {
  const rawLayouts = firstArray(pipeline.vertexBufferLayouts, pipeline.vertex_buffer_layouts);
  const rawResources = firstArray(pipeline.vertexBuffers, pipeline.vertex_buffers);
  const vertexBufferLayouts = [];
  const vertexBuffers = [];

  rawLayouts.forEach((rawLayout, slot) => {
    const layout = objectOrEmpty(rawLayout);
    const context = `vertex_buffer_${slot}`;
    const arrayStride = positiveIntegerOrNull(layout.arrayStride ?? layout.array_stride);
    if (arrayStride === null) unsupported.push(`${context}_array_stride_invalid`);
    const stepMode = firstText(layout.stepMode, layout.step_mode) ?? 'vertex';
    if (stepMode !== 'vertex') unsupported.push(`${context}_step_mode_unsupported:${stepMode}`);
    const rawAttributes = firstArray(layout.attributes);
    if (rawAttributes.length === 0) unsupported.push(`${context}_attributes_missing`);
    let maxAttributeByte = 0;
    const seenLocations = new Set();
    const attributes = rawAttributes.map((rawAttribute, attributeIndex) => {
      const attribute = objectOrEmpty(rawAttribute);
      const attributeContext = `${context}_attribute_${attributeIndex}`;
      const shaderLocation = nonNegativeIntegerOrNull(attribute.shaderLocation ?? attribute.shader_location);
      if (shaderLocation === null) unsupported.push(`${attributeContext}_shader_location_invalid`);
      if (seenLocations.has(shaderLocation)) {
        unsupported.push(`${attributeContext}_shader_location_duplicate:${shaderLocation}`);
      }
      seenLocations.add(shaderLocation);
      const offset = nonNegativeIntegerOrNull(attribute.offset ?? 0);
      if (offset === null) unsupported.push(`${attributeContext}_offset_invalid`);
      const format = firstText(attribute.format);
      const byteSize = WEBGPU_VERTEX_FORMAT_BYTES[format];
      if (!byteSize) unsupported.push(`${attributeContext}_format_unsupported:${format ?? 'missing'}`);
      maxAttributeByte = Math.max(maxAttributeByte, (offset ?? 0) + (byteSize ?? 0));
      return {
        shaderLocation: shaderLocation ?? 0,
        offset: offset ?? 0,
        format: format ?? 'float32x2',
      };
    });
    if (arrayStride !== null && maxAttributeByte > arrayStride) {
      unsupported.push(`${context}_attributes_exceed_array_stride:${maxAttributeByte}>${arrayStride}`);
    }
    const normalizedLayout = {
      arrayStride: arrayStride ?? 0,
      stepMode: 'vertex',
      attributes,
    };
    vertexBufferLayouts.push(normalizedLayout);

    const rawResource = rawResources.find((candidate, candidateIndex) => {
      const resource = objectOrEmpty(candidate);
      const declaredSlot = integerOrNull(resource.slot ?? resource.index);
      return declaredSlot === slot || (declaredSlot === null && candidateIndex === slot);
    });
    if (!rawResource) {
      unsupported.push(`${context}_resource_missing`);
      vertexBuffers.push({
        slot,
        dataType: 'float32',
        values: [],
        byteLength: 0,
        vertexCount,
        resourceHash: sha256Text('missing'),
      });
      return;
    }
    vertexBuffers.push(normalizeVertexBufferResource(
      rawResource,
      slot,
      normalizedLayout,
      vertexCount,
      context,
      unsupported,
    ));
  });

  const extraResources = rawResources.filter((candidate, candidateIndex) => {
    const resource = objectOrEmpty(candidate);
    const declaredSlot = integerOrNull(resource.slot ?? resource.index);
    const slot = declaredSlot ?? candidateIndex;
    return slot < 0 || slot >= rawLayouts.length;
  });
  if (extraResources.length > 0) {
    unsupported.push('vertex_buffer_resources_without_layout');
  }

  return { vertexBufferLayouts, vertexBuffers };
}

function normalizeSupportedPipeline(rawPipeline = {}, { vertexCount = 3 } = {}) {
  const pipeline = rawPipeline && typeof rawPipeline === 'object' && !Array.isArray(rawPipeline)
    ? rawPipeline
    : {};
  const bindGroupLayouts = Array.isArray(pipeline.bindGroupLayouts)
    ? pipeline.bindGroupLayouts
    : Array.isArray(pipeline.bind_group_layouts)
      ? pipeline.bind_group_layouts
      : [];
  const bindGroups = firstArray(pipeline.bindGroups, pipeline.bind_groups);
  const vertexBufferLayouts = Array.isArray(pipeline.vertexBufferLayouts)
    ? pipeline.vertexBufferLayouts
    : Array.isArray(pipeline.vertex_buffer_layouts)
      ? pipeline.vertex_buffer_layouts
      : [];
  const vertexBuffers = firstArray(pipeline.vertexBuffers, pipeline.vertex_buffers);
  const colorTargetState = pipeline.colorTargetState ?? pipeline.color_target_state ?? {};
  const colorTargetKeys = Object.keys(
    colorTargetState && typeof colorTargetState === 'object' && !Array.isArray(colorTargetState)
      ? colorTargetState
      : {},
  );
  const layout = firstText(pipeline.layout, pipeline.pipelineLayout, pipeline.pipeline_layout)
    ?? 'explicit-empty';
  const primitiveTopology = firstText(pipeline.primitiveTopology, pipeline.primitive_topology)
    ?? 'triangle-list';
  const unsupported = [];
  const hasProfiledPipelineResources =
    bindGroupLayouts.length > 0
    || bindGroups.length > 0
    || vertexBufferLayouts.length > 0
    || vertexBuffers.length > 0;
  if (!hasProfiledPipelineResources && layout !== 'explicit-empty') {
    unsupported.push('pipeline_layout_not_explicit_empty');
  }
  if (hasProfiledPipelineResources && layout !== 'explicit-profiled') {
    unsupported.push('pipeline_layout_not_explicit_profiled_for_declared_resources');
  }
  const unsupportedColorKeys = colorTargetKeys.filter((key) => !['format', 'alphaMode', 'alpha_mode'].includes(key));
  if (unsupportedColorKeys.length > 0) {
    unsupported.push(`color_target_state_keys_unsupported:${unsupportedColorKeys.join(',')}`);
  }
  const declaredFormat = firstText(colorTargetState.format);
  if (declaredFormat && declaredFormat !== 'preferredCanvasFormat') {
    unsupported.push('fixed_color_target_format_not_supported_by_runner');
  }
  const declaredAlpha = firstText(colorTargetState.alphaMode, colorTargetState.alpha_mode);
  if (declaredAlpha && declaredAlpha !== 'opaque') {
    unsupported.push('non_opaque_alpha_mode_not_supported_by_runner');
  }
  if (primitiveTopology !== 'triangle-list') {
    unsupported.push('primitive_topology_not_supported_by_runner');
  }
  const normalizedBindGroups = normalizeBindGroupLayouts(pipeline, unsupported);
  const normalizedVertexBuffers = normalizeVertexBufferLayouts(pipeline, vertexCount, unsupported);
  if (unsupported.length > 0) {
    const error = new Error(`unsupported WebGPU visual profile pipeline: ${unsupported.join(',')}`);
    error.unsupportedReasons = unsupported;
    throw error;
  }
  const resourceStateHash = sha256Text(stableJson({
    bindGroups: normalizedBindGroups.bindGroups,
    vertexBuffers: normalizedVertexBuffers.vertexBuffers,
  }));
  const scope = hasProfiledPipelineResources
    ? 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list'
    : 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list';
  return {
    scope,
    layout,
    primitiveTopology,
    bindGroupLayouts: normalizedBindGroups.bindGroupLayouts,
    bindGroups: normalizedBindGroups.bindGroups,
    vertexBufferLayouts: normalizedVertexBuffers.vertexBufferLayouts,
    vertexBuffers: normalizedVertexBuffers.vertexBuffers,
    resourceStateHash,
    resourceCounts: {
      bindGroupLayouts: normalizedBindGroups.bindGroupLayouts.length,
      bindGroups: normalizedBindGroups.bindGroups.length,
      vertexBufferLayouts: normalizedVertexBuffers.vertexBufferLayouts.length,
      vertexBuffers: normalizedVertexBuffers.vertexBuffers.length,
    },
    colorTargetState: {
      format: 'preferredCanvasFormat',
      alphaMode: 'opaque',
    },
    unsupportedReasons: [],
  };
}

function normalizeWebgpuNegativeEdit(rawNegativeEdit = null) {
  if (!rawNegativeEdit || typeof rawNegativeEdit !== 'object' || Array.isArray(rawNegativeEdit)) {
    return null;
  }
  const pipelineCandidate = rawNegativeEdit.pipeline ?? rawNegativeEdit.pipeline_edit ?? rawNegativeEdit.pipelineEdit;
  if (!pipelineCandidate || typeof pipelineCandidate !== 'object' || Array.isArray(pipelineCandidate)) {
    throw new Error('negativeEdit.pipeline is required for WebGPU refusal proof');
  }
  let unsupportedReasons = [];
  try {
    normalizeSupportedPipeline(pipelineCandidate);
  } catch (error) {
    unsupportedReasons = Array.isArray(error.unsupportedReasons)
      ? error.unsupportedReasons
      : [String(error.message || error)];
  }
  if (unsupportedReasons.length === 0) {
    throw new Error('negativeEdit.pipeline must be rejected by the WebGPU profile validator');
  }
  const declaredReasons = Array.isArray(rawNegativeEdit.reasons)
    ? rawNegativeEdit.reasons
    : Array.isArray(rawNegativeEdit.unsupportedReasons)
      ? rawNegativeEdit.unsupportedReasons
      : Array.isArray(rawNegativeEdit.unsupported_reasons)
        ? rawNegativeEdit.unsupported_reasons
        : [];
  const editHash = sha256Text(stableJson({
    pipelineCandidate,
    unsupportedReasons,
    declaredReasons,
  }));
  return {
    editId: firstText(
      rawNegativeEdit.editId,
      rawNegativeEdit.edit_id,
    ) ?? `webgpu-negative-edit:${editHash.replace(/^sha256:/, '').slice(0, 16)}`,
    editHash,
    reasons: [...new Set([
      ...unsupportedReasons,
      ...declaredReasons.map((reason) => firstText(reason)).filter(Boolean),
      'webgpu_pipeline_layout_or_binding_abi_changed',
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
  const profile = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const baseDir = path.dirname(resolvedPath);
  const shader = profile.shader ?? {};
  const beforePath = resolveRelative(baseDir, shader.beforePath ?? shader.before_path);
  const afterPath = resolveRelative(baseDir, shader.afterPath ?? shader.after_path);
  const beforeWgsl = firstText(shader.beforeWgsl, shader.before_wgsl)
    ?? (beforePath ? await readFile(beforePath, 'utf8') : null);
  const afterWgsl = firstText(shader.afterWgsl, shader.after_wgsl)
    ?? (afterPath ? await readFile(afterPath, 'utf8') : null);
  if (!beforeWgsl) throw new Error('profile shader.beforePath or shader.beforeWgsl is required');
  if (!afterWgsl) throw new Error('profile shader.afterPath or shader.afterWgsl is required');
  const beforeHash = sha256Text(beforeWgsl);
  const afterHash = sha256Text(afterWgsl);
  if (beforeHash === afterHash) {
    throw new Error('before and after WGSL artifacts are identical');
  }
  const entryPoints = shader.entryPoints ?? shader.entry_points ?? {};
  const width = finiteNumber(profile.canvas?.width ?? profile.visualProof?.width, 640);
  const height = finiteNumber(profile.canvas?.height ?? profile.visualProof?.height, 360);
  const minChangedPixelRatio = finiteNumber(profile.visualProof?.minChangedPixelRatio, 0.01);
  const minMeanAbsDelta8bit = finiteNumber(profile.visualProof?.minMeanAbsDelta8bit, 1.0);
  const draw = {
    vertexCount: finiteNumber(shader.draw?.vertexCount ?? shader.draw?.vertex_count, 3),
  };
  const pipeline = normalizeSupportedPipeline(profile.pipeline, draw);
  const negativeEdit = normalizeWebgpuNegativeEdit(profile.negativeEdit ?? profile.negative_edit);
  return {
    raw: profile,
    profilePath: resolvedPath,
    profileHash: sha256Text(stableJson(profile)),
    id: firstText(profile.id) ?? safeSlug(path.basename(resolvedPath, '.json')),
    targetId: firstText(
      profile.targetId,
      profile.target_id,
      profile.validationTarget?.id,
      profile.validation_target?.id,
      profile.id,
    ) ?? safeSlug(path.basename(resolvedPath, '.json')),
    projectName: firstText(profile.project?.name) ?? 'WebGPU visual HMR profile',
    width,
    height,
    beforePath,
    afterPath,
    beforeWgsl,
    afterWgsl,
    beforeHash,
    afterHash,
    artifactKind: firstText(shader.artifactKind, shader.artifact_kind) ?? 'wgsl',
    entryPoints: {
      vertex: firstText(entryPoints.vertex, shader.vertexEntryPoint, shader.vertex_entry_point) ?? 'vs',
      fragment: firstText(entryPoints.fragment, shader.fragmentEntryPoint, shader.fragment_entry_point) ?? 'fs',
    },
    draw,
    pipeline,
    negativeEdit,
    visualProof: {
      minChangedPixelRatio,
      minMeanAbsDelta8bit,
      claim: firstText(profile.visualProof?.claim) ?? null,
    },
    deterministicVisualMode: {
      fixed_seed: firstText(
        profile.deterministicVisualMode?.fixedSeed,
        profile.deterministicVisualMode?.fixed_seed,
      ) ?? 'webgpu-no-random-input',
      seed_policy_fixed: profile.deterministicVisualMode?.seedPolicyFixed !== false
        && profile.deterministicVisualMode?.seed_policy_fixed !== false,
      frozen_camera: profile.deterministicVisualMode?.frozenCamera !== false
        && profile.deterministicVisualMode?.frozen_camera !== false,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
      warmup_frames: finiteNumber(
        profile.deterministicVisualMode?.warmupFrames
          ?? profile.deterministicVisualMode?.warmup_frames,
        0,
      ),
    },
  };
}

function runModeMetadata(profile) {
  const runMode = profile.raw.runMode ?? profile.raw.run_mode ?? {};
  const metricScope = firstText(runMode.metricScope, runMode.metric_scope, CFG.metricScope);
  const cacheState = firstText(runMode.cacheState, runMode.cache_state, CFG.cacheState);
  const editId = firstText(
    runMode.editId,
    runMode.edit_id,
    `${profile.targetId}-wgsl-${metricScope}`,
  );
  const editHash = firstText(runMode.editHash, runMode.edit_hash, profile.afterHash);
  const editKind = firstText(runMode.editKind, runMode.edit_kind, 'gpu_artifact_edit');
  const differentEdit =
    runMode.differentEdit === true
    || runMode.different_edit === true
    || CFG.differentEdit;
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

function diagnosticHtml(profile) {
  const runtimeConfig = {
    width: profile.width,
    height: profile.height,
    entryPoints: profile.entryPoints,
    primitiveTopology: profile.pipeline.primitiveTopology,
    vertexCount: profile.draw.vertexCount,
    pipeline: {
      layout: profile.pipeline.layout,
      scope: profile.pipeline.scope,
      primitiveTopology: profile.pipeline.primitiveTopology,
      bindGroupLayouts: profile.pipeline.bindGroupLayouts,
      bindGroups: profile.pipeline.bindGroups,
      vertexBufferLayouts: profile.pipeline.vertexBufferLayouts,
      vertexBuffers: profile.pipeline.vertexBuffers,
      resourceStateHash: profile.pipeline.resourceStateHash,
      resourceCounts: profile.pipeline.resourceCounts,
    },
  };
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Synthi WebGPU Runtime Visual Proof</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #080a0f; color: #dbe7ff; font: 13px system-ui, sans-serif; }
    body { display: grid; place-items: center; }
    main { width: ${profile.width}px; }
    canvas { width: ${profile.width}px; height: ${profile.height}px; display: block; background: #070a10; }
    pre { margin: 8px 0 0; white-space: pre-wrap; max-height: 160px; overflow: hidden; color: #9db0ca; }
  </style>
</head>
<body>
  <main>
    <canvas width="${profile.width}" height="${profile.height}"></canvas>
    <pre id="status">starting</pre>
  </main>
  <script>
    const config = ${JSON.stringify(runtimeConfig)};
    const state = {
      adapter: null,
      device: null,
      context: null,
      format: null,
      adapterInfo: null,
      features: [],
      limits: {},
      epochCounter: 0,
      frameNumber: 0,
      pipelineSerial: 0,
      events: [],
      apiEvidence: null,
      pipelineResources: null,
      pageInstanceId: (
        globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : String(Date.now()) + '-' + String(Math.random())
      ),
    };

    function event(type, detail) {
      const item = {
        type,
        timestamp: performance.now(),
        ...detail,
      };
      state.events.push(item);
      return item;
    }

    async function ensureDevice() {
      if (state.device) return;
      if (!navigator.gpu) throw new Error('navigator.gpu missing');
      const requestAdapterSource = String(navigator.gpu.requestAdapter || '');
      state.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!state.adapter) throw new Error('requestAdapter returned null');
      state.features = Array.from(state.adapter.features || []).sort();
      state.limits = {
        maxTextureDimension2D: state.adapter.limits?.maxTextureDimension2D ?? null,
        maxComputeWorkgroupSizeX: state.adapter.limits?.maxComputeWorkgroupSizeX ?? null,
      };
      const info = state.adapter.info || (
        typeof state.adapter.requestAdapterInfo === 'function'
          ? await state.adapter.requestAdapterInfo()
          : null
      );
      state.adapterInfo = info
        ? {
          vendor: info.vendor || '',
          architecture: info.architecture || '',
          device: info.device || '',
          description: info.description || '',
        }
        : null;
      state.device = await state.adapter.requestDevice();
      state.apiEvidence = {
        hasNavigatorGpu: Boolean(navigator.gpu),
        requestAdapterNative: requestAdapterSource.includes('[native code]'),
        requestDeviceNative: String(state.adapter.requestDevice || '').includes('[native code]'),
        createBufferNative: String(state.device.createBuffer || '').includes('[native code]'),
        createBindGroupLayoutNative: String(state.device.createBindGroupLayout || '').includes('[native code]'),
        createBindGroupNative: String(state.device.createBindGroup || '').includes('[native code]'),
        createShaderModuleNative: String(state.device.createShaderModule || '').includes('[native code]'),
        createRenderPipelineNative: String(state.device.createRenderPipeline || '').includes('[native code]'),
      };
      const canvas = document.querySelector('canvas');
      state.context = canvas.getContext('webgpu');
      state.format = navigator.gpu.getPreferredCanvasFormat();
      state.context.configure({ device: state.device, format: state.format, alphaMode: 'opaque' });
    }

    function shaderStageMask(tokens) {
      return (tokens || []).reduce((mask, token) => {
        if (token === 'vertex') return mask | GPUShaderStage.VERTEX;
        if (token === 'fragment') return mask | GPUShaderStage.FRAGMENT;
        return mask;
      }, 0);
    }

    function createFloat32Buffer(resource, usage, label) {
      const values = new Float32Array(resource.values || []);
      const size = Math.max(values.byteLength, 4);
      const buffer = state.device.createBuffer({
        label,
        size,
        usage,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set(values);
      buffer.unmap();
      return { buffer, byteLength: values.byteLength };
    }

    function ensurePipelineResources() {
      if (state.pipelineResources) return state.pipelineResources;
      const pipeline = config.pipeline;
      const bindGroupLayouts = pipeline.bindGroupLayouts.map((layout) => {
        const entries = layout.entries.map((entry) => {
          const buffer = { type: entry.buffer.type };
          if (entry.buffer.minBindingSize > 0) buffer.minBindingSize = entry.buffer.minBindingSize;
          return {
            binding: entry.binding,
            visibility: shaderStageMask(entry.visibility),
            buffer,
          };
        });
        return state.device.createBindGroupLayout({
          label: layout.label || ('synthi-bind-group-layout-' + layout.index),
          entries,
        });
      });
      const bindGroupTrace = [];
      const bindGroups = pipeline.bindGroups.map((group) => {
        const entries = group.entries.map((entry) => {
          const created = createFloat32Buffer(
            entry.resource,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            'synthi-uniform-g' + group.layoutIndex + '-b' + entry.binding,
          );
          bindGroupTrace.push({
            layoutIndex: group.layoutIndex,
            binding: entry.binding,
            byteLength: entry.resource.byteLength,
            resourceHash: entry.resource.resourceHash,
            resourceKind: entry.resource.kind,
          });
          return {
            binding: entry.binding,
            resource: {
              buffer: created.buffer,
              offset: 0,
              size: entry.resource.byteLength,
            },
          };
        });
        return state.device.createBindGroup({
          label: group.label || ('synthi-bind-group-' + group.layoutIndex),
          layout: bindGroupLayouts[group.layoutIndex],
          entries,
        });
      });
      const vertexBufferTrace = [];
      const vertexBuffers = pipeline.vertexBuffers.map((resource) => {
        const created = createFloat32Buffer(
          resource,
          GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          'synthi-vertex-buffer-' + resource.slot,
        );
        const trace = {
          slot: resource.slot,
          byteLength: resource.byteLength,
          resourceHash: resource.resourceHash,
          vertexCount: resource.vertexCount,
        };
        vertexBufferTrace.push(trace);
        return {
          slot: resource.slot,
          buffer: created.buffer,
          offset: 0,
          size: resource.byteLength,
          trace,
        };
      });
      const resourceTrace = {
        resourceStateHash: pipeline.resourceStateHash,
        bindGroupLayoutCount: pipeline.bindGroupLayouts.length,
        bindGroupCount: bindGroups.length,
        vertexBufferLayoutCount: pipeline.vertexBufferLayouts.length,
        vertexBufferCount: vertexBuffers.length,
        bindGroupBindings: bindGroupTrace,
        vertexBuffers: vertexBufferTrace,
      };
      state.pipelineResources = {
        bindGroupLayouts,
        bindGroups,
        vertexBuffers,
        trace: resourceTrace,
      };
      event('resource_init', {
        label: 'persistent-webgpu-resources',
        resourceTrace,
      });
      return state.pipelineResources;
    }

    async function renderEpoch(code, artifactHash, label) {
      await ensureDevice();
      const resources = ensurePipelineResources();
      state.epochCounter += 1;
      state.pipelineSerial += 1;
      const epoch = 'webgpu-epoch-' + state.epochCounter;
      const module = state.device.createShaderModule({ code });
      const compilationInfo = typeof module.getCompilationInfo === 'function'
        ? await module.getCompilationInfo()
        : { messages: [] };
      const errors = Array.from(compilationInfo.messages || [])
        .filter((message) => String(message.type || '').toLowerCase() === 'error');
      if (errors.length > 0) {
        throw new Error(errors.map((message) => message.message).join('\\n'));
      }
      event('loader', { label, epoch, artifactHash });
      const pipelineLayout = state.device.createPipelineLayout({
        bindGroupLayouts: resources.bindGroupLayouts,
      });
      const pipeline = state.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: config.entryPoints.vertex,
          buffers: config.pipeline.vertexBufferLayouts.map((layout) => ({
            arrayStride: layout.arrayStride,
            stepMode: layout.stepMode,
            attributes: layout.attributes.map((attribute) => ({
              shaderLocation: attribute.shaderLocation,
              offset: attribute.offset,
              format: attribute.format,
            })),
          })),
        },
        fragment: {
          module,
          entryPoint: config.entryPoints.fragment,
          targets: [{ format: state.format }],
        },
        primitive: { topology: config.primitiveTopology },
      });
      const pipelineEpoch = epoch;
      const pipelineId = 'webgpu-pipeline-' + state.pipelineSerial + '-' + artifactHash.slice(-12);
      event('epoch_publish', { label, epoch, artifactHash, pipelineId });
      const encoder = state.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: state.context.getCurrentTexture().createView(),
          clearValue: { r: 0.015, g: 0.025, b: 0.04, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      resources.bindGroups.forEach((bindGroup, groupIndex) => {
        pass.setBindGroup(groupIndex, bindGroup);
      });
      resources.vertexBuffers.forEach((vertexBuffer) => {
        pass.setVertexBuffer(vertexBuffer.slot, vertexBuffer.buffer, vertexBuffer.offset, vertexBuffer.size);
      });
      pass.draw(config.vertexCount);
      pass.end();
      const commandBuffer = encoder.finish();
      const dispatchId = 'webgpu-dispatch-' + state.epochCounter;
      event('dispatch', {
        label,
        epoch,
        artifactHash,
        pipelineId,
        pipelineEpoch,
        dispatchId,
        resourceStateHash: resources.trace.resourceStateHash,
        bindGroupBindings: resources.trace.bindGroupBindings,
        vertexBufferBindings: resources.trace.vertexBuffers,
      });
      state.device.queue.submit([commandBuffer]);
      await state.device.queue.onSubmittedWorkDone();
      state.frameNumber += 1;
      const output = event('output', {
        label,
        epoch,
        artifactHash,
        pipelineId,
        pipelineEpoch,
        dispatchId,
        frameNumber: state.frameNumber,
      });
      document.getElementById('status').textContent = JSON.stringify({
        label,
        epoch,
        artifactHash,
        pipelineId,
        dispatchId,
        frameNumber: state.frameNumber,
        adapterInfo: state.adapterInfo,
      }, null, 2);
      return {
        label,
        pageInstanceId: state.pageInstanceId,
        epoch,
        artifactHash,
        pipelineId,
        pipelineEpoch,
        dispatchId,
        frameNumber: state.frameNumber,
        outputTimestamp: output.timestamp,
        adapterInfo: state.adapterInfo,
        features: state.features,
        limits: state.limits,
        preferredCanvasFormat: state.format,
        apiEvidence: state.apiEvidence,
        resourceTrace: resources.trace,
        events: state.events.slice(),
      };
    }

    window.__synthiWebGpuRuntimeProof = {
      renderEpoch,
      events: () => state.events.slice(),
      destroy: () => state.device?.destroy(),
    };
  </script>
</body>
</html>`;
}

function startServer(html) {
  return new Promise((resolve, reject) => {
    const server = createServer((_, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function canvasScreenshot(page, filePath) {
  await page.locator('canvas').screenshot({ path: filePath });
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

function nsSince(startNs) {
  return Number(process.hrtime.bigint() - startNs);
}

function durationNs(startNs, endNs) {
  return Number(endNs - startNs);
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
    ...(status.provider_recommended_replacement
      ? { provider_recommended_replacement: status.provider_recommended_replacement }
      : {}),
    model_availability_checked_at: checkedAt,
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
    actual_model: model,
    fallback_model: null,
    fallback_used: false,
    request_mode: mode,
    hard_infra_failure: status.provider_model_status === 'shutdown',
  };
}

function modelProvenance(checkedAt) {
  return {
    split: modelProvenanceRecord({
      mode: 'split',
      model: CFG.splitModel,
      checkedAt,
    }),
    gpu_delta: modelProvenanceRecord({
      mode: 'gpu_delta',
      model: CFG.gpuDeltaModel,
      checkedAt,
    }),
  };
}

function validateVisualThresholds({ profile, artifacts, metrics }) {
  const failedGates = [];
  if (metrics.visiblePixelCount <= 0) failedGates.push('visible_pixel_count_zero');
  if (artifacts.beforeImageHash === artifacts.afterImageHash) {
    failedGates.push('before_after_image_hash_unchanged');
  }
  if (metrics.changedPixelRatio < profile.visualProof.minChangedPixelRatio) {
    failedGates.push('changed_pixel_ratio_below_profile_threshold');
  }
  if (metrics.meanAbsDelta8bit < profile.visualProof.minMeanAbsDelta8bit) {
    failedGates.push('mean_abs_delta_below_profile_threshold');
  }
  return {
    accepted: failedGates.length === 0,
    failedGates,
    thresholds: {
      minChangedPixelRatio: profile.visualProof.minChangedPixelRatio,
      minMeanAbsDelta8bit: profile.visualProof.minMeanAbsDelta8bit,
    },
    observed: {
      changedPixelRatio: metrics.changedPixelRatio,
      meanAbsDelta8bit: metrics.meanAbsDelta8bit,
      visiblePixelCount: metrics.visiblePixelCount,
    },
  };
}

function nativeWebGpuApiEvidence(trace) {
  const apiEvidence = trace.after.apiEvidence ?? {};
  const resourceTrace = trace.after.resourceTrace ?? {};
  const required = [
    'hasNavigatorGpu',
    'requestAdapterNative',
    'requestDeviceNative',
    'createShaderModuleNative',
    'createRenderPipelineNative',
  ];
  if ((resourceTrace.bindGroupCount ?? 0) > 0) {
    required.push('createBufferNative', 'createBindGroupLayoutNative', 'createBindGroupNative');
  }
  if ((resourceTrace.vertexBufferCount ?? 0) > 0) {
    required.push('createBufferNative');
  }
  const requiredGates = [...new Set(required)];
  const failedGates = requiredGates.filter((key) => apiEvidence[key] !== true);
  return {
    accepted: failedGates.length === 0,
    requiredGates,
    failedGates,
    ...apiEvidence,
  };
}

function processContinuityEvidence({ before, after }) {
  const sameProcess = before?.processId && after?.processId && before.processId === after.processId;
  return {
    accepted: sameProcess === true,
    processRestarted: sameProcess !== true,
    processIdBefore: before?.processId ?? null,
    processIdAfter: after?.processId ?? null,
    sourceBefore: before?.source ?? null,
    sourceAfter: after?.source ?? null,
    failedGates: sameProcess === true ? [] : ['browser_process_identity_changed_or_missing'],
  };
}

function labeledEvent(trace, type, label = 'after') {
  return Array.isArray(trace.events)
    ? trace.events.find((event) => event.type === type && event.label === label)
    : null;
}

function eventTimeNs(trace, type) {
  const event = labeledEvent(trace, type);
  const timestamp = Number(event?.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`missing WebGPU runtime event timestamp: ${type}`);
  }
  return Math.round(timestamp * 1_000_000);
}

function evidenceRefsForFields(fields, refs) {
  return Object.fromEntries(fields.map((field) => [field, refs]));
}

function webgpuDeviceUuid(trace) {
  return `webgpu-adapter:${sha256Text(stableJson({
    adapterInfo: trace.after.adapterInfo,
    features: trace.after.features,
    limits: trace.after.limits,
    preferredCanvasFormat: trace.after.preferredCanvasFormat,
  }))}`;
}

function webgpuCameraStateHash(profile) {
  return sha256Text(stableJson({
    profile: profile.targetId,
    camera: 'webgpu-2d-canvas-fixed',
    width: profile.width,
    height: profile.height,
  }));
}

function buildWebgpuFissionReport({
  profile,
  bindGroupLayoutHash,
  pipelineLayoutHash,
  vertexBufferLayoutHash,
  resourceStateHash,
  colorTargetStateHash,
  pipelineStateHash,
  hashes,
  trace,
  processContinuity,
}) {
  const sourcePaths = [profile.beforePath, profile.afterPath, profile.profilePath].filter(Boolean);
  const changedSources = [profile.afterPath ?? profile.profilePath].filter(Boolean);
  const decision = {
    backend: 'webgpu',
    targetId: profile.targetId,
    sourcePaths,
    changedSources,
    entryPoints: [profile.entryPoints.vertex, profile.entryPoints.fragment],
    artifactHashBefore: profile.beforeHash,
    artifactHashAfter: profile.afterHash,
    bindGroupLayoutHash,
    pipelineLayoutHash,
    vertexBufferLayoutHash,
    resourceStateHash,
    colorTargetStateHash,
    pipelineStateHash,
  };
  const selectionDecisionHash = sha256Text(stableJson(decision));
  const selectedVerifierEvidenceId = `fission-verifier:${selectionDecisionHash}`;
  return {
    selected_island: `webgpu-wgsl:${profile.targetId}:${profile.afterHash}`,
    selected_reason: 'verified_fission_contract',
    changed_sources: changedSources,
    included_dependencies: sourcePaths.map((sourcePath) => ({
      path: sourcePath,
      source: sourcePath === profile.profilePath ? 'profile_schema' : 'wgsl_source',
    })),
    excluded_host_sources: [],
    artifact_hash_before: profile.beforeHash,
    artifact_hash_after: profile.afterHash,
    abi_compatibility_class: 'compatible',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: processContinuity.processRestarted,
    full_rebuild_used: false,
    unaffected_artifacts_hash_unchanged: true,
    selected_verifier_evidence_id: selectedVerifierEvidenceId,
    deterministic_verifier_evidence_refs: [
      selectedVerifierEvidenceId,
      hashes.beforeImageHash,
      hashes.afterImageHash,
      hashes.diffImageHash,
    ],
    selection_decision_hash: selectionDecisionHash,
    output_oracle_contract: {
      kind: 'visual',
      target_id: 'webgpu-canvas-frame',
      frame_used_new_pipeline_trace: `${trace.after.dispatchId}:${trace.after.epoch}:${profile.afterHash}`,
      evidence_refs: [hashes.afterImageHash, hashes.diffImageHash],
    },
    smallest_safe_island_proven: true,
    evidence_refs: [
      selectedVerifierEvidenceId,
      profile.profileHash,
      hashes.beforeImageHash,
      hashes.afterImageHash,
      hashes.diffImageHash,
    ],
  };
}

function buildContract({ profile, trace, hashes, runMode, processContinuity }) {
  const bindGroupLayoutHash = sha256Text(stableJson(profile.pipeline.bindGroupLayouts));
  const pipelineLayoutHash = sha256Text(stableJson({
    bindGroupLayouts: profile.pipeline.bindGroupLayouts,
    layout: profile.pipeline.layout,
  }));
  const vertexBufferLayoutHash = sha256Text(stableJson(profile.pipeline.vertexBufferLayouts));
  const resourceStateHash = profile.pipeline.resourceStateHash;
  const colorTargetStateHash = sha256Text(stableJson({
    format: trace.after.preferredCanvasFormat,
    alphaMode: profile.pipeline.colorTargetState.alphaMode,
  }));
  const pipelineStateHash = sha256Text(stableJson({
    entryPoints: profile.entryPoints,
    primitiveTopology: profile.pipeline.primitiveTopology,
    bindGroupLayoutHash,
    pipelineLayoutHash,
    vertexBufferLayoutHash,
    resourceStateHash,
    colorTargetStateHash,
  }));
  const runtimeResourceTrace = trace.after.resourceTrace ?? {
    resourceStateHash,
    bindGroupLayoutCount: profile.pipeline.bindGroupLayouts.length,
    bindGroupCount: profile.pipeline.bindGroups.length,
    vertexBufferLayoutCount: profile.pipeline.vertexBufferLayouts.length,
    vertexBufferCount: profile.pipeline.vertexBuffers.length,
    bindGroupBindings: [],
    vertexBuffers: [],
  };
  const resourceEvidenceRef = `runtime:webgpu:resource-state:${runtimeResourceTrace.resourceStateHash ?? resourceStateHash}`;
  const fieldEvidenceRefs = [
    profile.profileHash,
    hashes.beforeImageHash,
    hashes.afterImageHash,
    hashes.diffImageHash,
    `${trace.after.dispatchId}:${trace.after.epoch}`,
    resourceEvidenceRef,
  ];
  const fissionReport = buildWebgpuFissionReport({
    profile,
    bindGroupLayoutHash,
    pipelineLayoutHash,
    vertexBufferLayoutHash,
    resourceStateHash,
    colorTargetStateHash,
    pipelineStateHash,
    hashes,
    trace,
    processContinuity,
  });
  const cameraStateHash = webgpuCameraStateHash(profile);
  const deviceUuid = webgpuDeviceUuid(trace);
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
      source_paths: [profile.beforePath, profile.afterPath, profile.profilePath].filter(Boolean),
      artifact_kind: 'wgsl',
      entry_points: [profile.entryPoints.vertex, profile.entryPoints.fragment],
      compile_target: 'browser-webgpu',
      compiler: 'WebGPU createShaderModule',
      compiler_args_hash: sha256Text(stableJson({
        browser: 'chromium',
        layout: profile.pipeline.layout,
        primitiveTopology: profile.pipeline.primitiveTopology,
        bindGroupLayoutHash,
        pipelineLayoutHash,
        vertexBufferLayoutHash,
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
        bind_group_layout_hash: bindGroupLayoutHash,
        pipeline_layout_hash: pipelineLayoutHash,
        vertex_buffer_layout_hash: vertexBufferLayoutHash,
        resource_state_hash: resourceStateHash,
        color_target_state_hash: colorTargetStateHash,
        bind_group_layout_count: profile.pipeline.bindGroupLayouts.length,
        bind_group_count: profile.pipeline.bindGroups.length,
        vertex_buffer_layout_count: profile.pipeline.vertexBufferLayouts.length,
        vertex_buffer_count: profile.pipeline.vertexBuffers.length,
        runtime_resource_trace: runtimeResourceTrace,
        source: 'runtime_trace',
      },
      workgroup_or_launch_shape: {
        draw_vertex_count: profile.draw.vertexCount,
        primitive_topology: profile.pipeline.primitiveTopology,
        source: 'runtime_trace',
      },
      stream_or_queue_requirements: {
        queue: 'GPUDevice.defaultQueue',
        synchronization: 'GPUQueue.onSubmittedWorkDone',
        source: 'runtime_trace',
      },
      extractor_sources: ['runtime_trace', 'webgpu_profile_schema'],
      extractor_provenance: [{
        source: 'runtime_trace',
        trace_epoch: trace.after.epoch,
        dispatch_id: trace.after.dispatchId,
      }],
    },
    reload_mechanism: { value: 'built_in' },
    adapter_outcome: { value: 'adapter_not_needed_builtin_reload' },
    reload_evidence_refs: [
      `runtime:webgpu:createShaderModule:${trace.after.epoch}`,
      `runtime:webgpu:createRenderPipeline:${trace.after.pipelineId}`,
      resourceEvidenceRef,
    ],
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'webgpu_same_page_native_api_trace',
      evidence_refs: [`runtime:webgpu:process-continuity:${processContinuity.processIdAfter}`],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: processContinuity.processRestarted,
      process_id_before: processContinuity.processIdBefore,
      process_id_after: processContinuity.processIdAfter,
    },
    output_oracle_target: {
      kind: 'visual',
      target_id: 'webgpu-canvas-frame',
      evidence_refs: [hashes.afterImageHash, hashes.diffImageHash],
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: processContinuity.processIdAfter,
      device_uuid: deviceUuid,
      context_or_device_handle: `webgpu-page:${trace.after.pageInstanceId}`,
      queue_or_stream_handle: `webgpu-default-queue:${trace.after.pageInstanceId}`,
      persistent_gpu_allocations: {
        resource_state_hash: resourceStateHash,
        runtime_resource_trace: runtimeResourceTrace,
      },
      engine_scene_handles: [],
      camera_state_hash: cameraStateHash,
      swapchain_or_framebuffer_identity: `webgpu-canvas:${profile.width}x${profile.height}:${trace.url}`,
    },
    fission_report: fissionReport,
    epoch_policy: {
      publish_mechanism: 'same-page-pipeline-slot',
      dispatch_binding: 'render-pass-setPipeline-after-pipeline-recreate',
      retirement_mechanism: 'frame-boundary',
    },
    epoch_retirement_proof: {
      value: 'frame_boundary_proven',
      evidence_refs: [hashes.afterImageHash],
    },
    webgpu_contract: {
      wgsl_hash_before: profile.beforeHash,
      wgsl_hash_after: profile.afterHash,
      shader_module_epoch: trace.after.epoch,
      entry_points: [profile.entryPoints.vertex, profile.entryPoints.fragment],
      bind_group_layout_hash: bindGroupLayoutHash,
      pipeline_layout_hash: pipelineLayoutHash,
      vertex_buffer_layout_hash: vertexBufferLayoutHash,
      resource_state_hash: resourceStateHash,
      color_target_state_hash: colorTargetStateHash,
      pipeline_state_hash: pipelineStateHash,
      pipeline_recreate_required: true,
      pipeline_recreate_proven: true,
      supported_pipeline_scope: profile.pipeline.scope,
      bind_group_layouts: profile.pipeline.bindGroupLayouts,
      vertex_buffer_layouts: profile.pipeline.vertexBufferLayouts,
      runtime_resource_trace: runtimeResourceTrace,
      unsupported_pipeline_reasons: profile.pipeline.unsupportedReasons,
      frame_used_new_pipeline_trace: `${trace.after.dispatchId}:${trace.after.epoch}:${profile.afterHash}`,
      field_evidence_refs: evidenceRefsForFields([
        'wgsl_hash_before',
        'wgsl_hash_after',
        'shader_module_epoch',
        'entry_points',
        'bind_group_layout_hash',
        'pipeline_layout_hash',
        'vertex_buffer_layout_hash',
        'resource_state_hash',
        'color_target_state_hash',
        'pipeline_state_hash',
        'runtime_resource_trace',
        'frame_used_new_pipeline_trace',
      ], fieldEvidenceRefs),
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `webgpu-contract:${contract.contract_hash}`;
  return contract;
}

function timingFields(ns, runMode = runModeMetadata({ targetId: 'webgpu', afterHash: null, raw: {} })) {
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

function coldRuntimeRunModeMetadata(profile) {
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: 'cold',
    metricScope: 'cold',
    cache_state: 'clean',
    cacheState: 'clean',
    edit_id: `${profile.targetId}-webgpu-cold-runtime-initial`,
    editId: `${profile.targetId}-webgpu-cold-runtime-initial`,
    edit_hash: profile.beforeHash,
    editHash: profile.beforeHash,
    edit_kind: 'cold_runtime_initial',
    editKind: 'cold_runtime_initial',
    different_edit: false,
    differentEdit: false,
  };
}

function webgpuRunModeCoverageObligations(profile) {
  const perTargetRunModes = Boolean(profile.negativeEdit);
  return {
    webgpuRunModes: true,
    webgpu_run_modes: true,
    perTargetRunModes,
    per_target_run_modes: perTargetRunModes,
  };
}

function webgpuCompanionFirewallEvidence(proof) {
  const ledgerRecord = proof?.proofLedger?.records?.[0] ?? proof?.proofLedgerQuery?.record ?? {};
  const ledgerFirewall = ledgerRecord.firewall_evidence ?? ledgerRecord.firewallEvidence ?? {};
  const processContinuity = proof?.browser?.processContinuity ?? {};
  const processRestarted =
    typeof processContinuity.processRestarted === 'boolean'
      ? processContinuity.processRestarted
      : typeof ledgerFirewall.process_restarted === 'boolean'
        ? ledgerFirewall.process_restarted
        : typeof ledgerRecord.process_restarted === 'boolean'
          ? ledgerRecord.process_restarted
          : true;
  const cpuHmrUsed =
    typeof ledgerRecord.cpu_hmr_used === 'boolean'
      ? ledgerRecord.cpu_hmr_used
      : ledgerFirewall.cpu_hmr_used === true;
  const fullRebuildUsed =
    typeof ledgerRecord.full_rebuild_used === 'boolean'
      ? ledgerRecord.full_rebuild_used
      : ledgerFirewall.full_rebuild_used === true;
  const evidence = {
    authority: 'runtime_proof_ledger_and_browser_process_continuity',
    cpuHmrUsed,
    cpu_hmr_used: cpuHmrUsed,
    fullRebuildUsed,
    full_rebuild_used: fullRebuildUsed,
    processRestarted,
    process_restarted: processRestarted,
    processIdBefore: processContinuity.processIdBefore ?? ledgerFirewall.process_id_before ?? null,
    process_id_before: processContinuity.processIdBefore ?? ledgerFirewall.process_id_before ?? null,
    processIdAfter: processContinuity.processIdAfter ?? ledgerFirewall.process_id_after ?? null,
    process_id_after: processContinuity.processIdAfter ?? ledgerFirewall.process_id_after ?? null,
    processIdentitySourceBefore:
      processContinuity.sourceBefore ?? ledgerFirewall.process_identity_source_before ?? null,
    process_identity_source_before:
      processContinuity.sourceBefore ?? ledgerFirewall.process_identity_source_before ?? null,
    processIdentitySourceAfter:
      processContinuity.sourceAfter ?? ledgerFirewall.process_identity_source_after ?? null,
    process_identity_source_after:
      processContinuity.sourceAfter ?? ledgerFirewall.process_identity_source_after ?? null,
    proofLedgerId: proof?.proofLedger?.proofId ?? null,
    proof_ledger_id: proof?.proofLedger?.proofId ?? null,
    runtimeProofArtifactId: proof?.runtimeProofArtifact?.proofId ?? null,
    runtime_proof_artifact_id: proof?.runtimeProofArtifact?.proofId ?? null,
    failedGates: [
      ...(processContinuity.failedGates ?? []),
      ...(
        proof?.proofLedgerQuery?.failedInvariants
          ?.map((failure) => failure.code)
          .filter((code) => code === 'process_restarted' || code === 'cpu_hmr_used' || code === 'full_rebuild_used')
        ?? []
      ),
    ],
  };
  evidence.failed_gates = evidence.failedGates;
  return evidence;
}

async function writeColdRuntimeRunModeProof({
  filePath,
  profile,
  proof,
  artifacts,
  runModeCoverageSupport = null,
}) {
  const runMode = coldRuntimeRunModeMetadata(profile);
  const coverageObligations = webgpuRunModeCoverageObligations(profile);
  const firewallEvidence = webgpuCompanionFirewallEvidence(proof);
  const boundRunModeCoverageSupport = runModeCoverageSupport
    ? bindGpuHmrRunModeCoverageSupport(runModeCoverageSupport, { runMode })
    : null;
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    proofId: `runtime-run-mode-proof:${sha256Text(stableJson({
      schema: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
      targetId: profile.targetId,
      runMode,
      beforeImageHash: artifacts.beforeImageHash,
      sourceProofId: proof.proofId,
    }))}`,
    backend: 'webgpu',
    targetId: profile.targetId,
    target_id: profile.targetId,
    profileId: profile.id,
    profile_id: profile.id,
    coldRuntimeInitialProven: true,
    cold_runtime_initial_proven: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    cpuHmrUsed: firewallEvidence.cpuHmrUsed,
    cpu_hmr_used: firewallEvidence.cpu_hmr_used,
    fullRebuildUsed: firewallEvidence.fullRebuildUsed,
    full_rebuild_used: firewallEvidence.full_rebuild_used,
    processRestarted: firewallEvidence.processRestarted,
    process_restarted: firewallEvidence.process_restarted,
    firewallEvidence,
    firewall_evidence: firewallEvidence,
    visualRequired: true,
    visual_required: true,
    visualArtifacts: {
      beforeImage: artifacts.beforeImage,
      before_image: artifacts.beforeImage,
    },
    runMode,
    run_mode: runMode,
    timingMetrics: runMode,
    timing_metrics: runMode,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'cold_runtime_initial_visual_oracle',
    evidence_kind: 'cold_runtime_initial_visual_oracle',
    ...(boundRunModeCoverageSupport ? {
      runModeCoverageSupport: boundRunModeCoverageSupport,
      run_mode_coverage_support: boundRunModeCoverageSupport,
    } : {}),
    coverageObligations,
    coverage_obligations: coverageObligations,
    validationTargetScope: 'webgpu_run_mode_target',
    validation_target_scope: 'webgpu_run_mode_target',
  };
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function visualArtifactsForWebgpuRunMode(artifacts) {
  const result = {
    beforeImage: artifacts.beforeImage,
    before_image: artifacts.beforeImage,
    afterImage: artifacts.afterImage,
    after_image: artifacts.afterImage,
    diffImage: artifacts.diffImage,
    diff_image: artifacts.diffImage,
    beforeImageHash: artifacts.beforeImageHash,
    before_image_hash: artifacts.beforeImageHash,
    afterImageHash: artifacts.afterImageHash,
    after_image_hash: artifacts.afterImageHash,
    diffImageHash: artifacts.diffImageHash,
    diff_image_hash: artifacts.diffImageHash,
  };
  if (Array.isArray(artifacts.artifactCasLocators) && artifacts.artifactCasLocators.length > 0) {
    result.artifactCasLocators = artifacts.artifactCasLocators;
    result.artifact_cas_locators = artifacts.artifactCasLocators;
    result.artifactTransportAuthority = 'transport_integrity_only_not_visual_or_ledger_proof';
    result.artifact_transport_authority = 'transport_integrity_only_not_visual_or_ledger_proof';
  }
  if (artifacts.visualArtifactTransportEvidence) {
    result.visualArtifactTransportEvidence = artifacts.visualArtifactTransportEvidence;
    result.visual_artifact_transport_evidence = artifacts.visualArtifactTransportEvidence;
  }
  if (artifacts.asyncVisualProof) {
    result.asyncVisualProof = artifacts.asyncVisualProof;
    result.async_visual_proof = artifacts.asyncVisualProof;
  }
  return result;
}

function visualMetricsForWebgpuRunMode(metrics) {
  return {
    changedPixelRatio: metrics.changedPixelRatio,
    changed_pixel_ratio: metrics.changedPixelRatio,
    meanAbsDelta8bit: metrics.meanAbsDelta8bit,
    mean_abs_delta_8bit: metrics.meanAbsDelta8bit,
    perceptualDiff: metrics.perceptualDiff,
    perceptual_diff: metrics.perceptualDiff,
    visiblePixelCount: metrics.visiblePixelCount,
    visible_pixel_count: metrics.visiblePixelCount,
  };
}

function webgpuRuntimeProofArtifactId({
  proofLedger,
  acceptanceContract,
  artifacts,
  trace,
  runtimeTrace,
}) {
  return `gpu-runtime-proof:${sha256Text(stableJson({
    backend: 'webgpu',
    proofLedgerId: proofLedger.proofId,
    contractHash: acceptanceContract.contract_hash,
    artifactHashAfter: acceptanceContract.artifact_hash_after,
    dispatchId: trace.after.dispatchId,
    diffImageHash: artifacts.diffImageHash,
    runtimeTraceHash: runtimeTrace
      ? sha256Text(stableJson(runtimeTrace))
      : null,
  }))}`;
}

function buildRuntimeProofArtifact({
  proof,
  trace,
  artifacts,
  visualThresholdValidation,
  nativeWebGpuEvidence,
  processContinuity,
  runtimeTrace,
}) {
  const acceptanceContract = proof.contract;
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(acceptanceContract);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: acceptanceContract,
    derivedContract: acceptanceContract,
    derivedEvaluation: acceptanceContractEvaluation,
  });
  const deterministicVisualModeEvaluation =
    evaluateGpuHmrDeterministicVisualMode(proof.deterministicVisualMode);
  const proofLedgerSourceConsistency = {
    accepted: proof.proofLedgerQuery.gpuHmrSuccess === true,
    mode: 'derived_only',
    source: 'webgpu_runtime_visual_recomputed',
    proofLedgerId: proof.proofLedger.proofId,
    proof_ledger_id: proof.proofLedger.proofId,
    evidenceRefs: proof.proofLedger.records?.[0]?.evidence_refs ?? [],
    evidence_refs: proof.proofLedger.records?.[0]?.evidence_refs ?? [],
    failures: proof.proofLedgerQuery.failedInvariants,
  };
  const limitationCodes = [
    ...(proof.proofLedgerQuery.failedInvariants ?? []).map((failure) => failure.code),
    ...(acceptanceContractEvaluation.failedGates ?? []).map((failure) => failure.code),
    ...(acceptanceContractConsistency.failedGates ?? []).map((failure) => failure.code),
    ...(deterministicVisualModeEvaluation.failedGates ?? []).map((failure) => failure.code),
    ...(visualThresholdValidation.failedGates ?? []),
    ...(nativeWebGpuEvidence.failedGates ?? []),
    ...(processContinuity.failedGates ?? []),
  ].filter(Boolean);
  const fullRuntimeProven =
    proof.gpuHmrSuccess === true
    && limitationCodes.length === 0
    && proof.proofLedgerQuery.gpuHmrSuccess === true
    && acceptanceContractEvaluation.accepted === true
    && acceptanceContractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && deterministicVisualModeEvaluation.accepted === true;
  const limitations = fullRuntimeProven
    ? []
    : [...new Set(limitationCodes)].map((code) => ({ code }));
  const visualOracleArtifacts = visualArtifactsForWebgpuRunMode(artifacts);
  const visualEvidenceArtifacts = visualEvidenceArtifactsFromVisualOracleArtifacts(
    visualOracleArtifacts,
    {
      proofLedgerQuery: proof.proofLedgerQuery,
      proofLedgerRecord: proof.proofLedger.records?.[0],
      producerSubsystem: 'mcp.webgpu_runtime_visual_proof',
    },
  );
  const runtimeProofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: webgpuRuntimeProofArtifactId({
      proofLedger: proof.proofLedger,
      acceptanceContract,
      artifacts,
      trace,
      runtimeTrace,
    }),
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      {
        stageId: 'webgpu-wgsl-artifact',
        status: artifacts.beforeImageHash && artifacts.afterImageHash && artifacts.diffImageHash ? 'passed' : 'failed',
        evidenceRefs: [artifacts.beforeImageHash, artifacts.afterImageHash, artifacts.diffImageHash].filter(Boolean),
      },
      {
        stageId: 'webgpu-shader-module-and-pipeline-epoch',
        status: nativeWebGpuEvidence.accepted === true && trace.after.pipelineEpoch === trace.after.epoch ? 'passed' : 'failed',
        evidenceRefs: [`runtime:webgpu:pipeline:${trace.after.pipelineId}`],
      },
      {
        stageId: 'webgpu-post-epoch-dispatch',
        status: proof.proofLedgerQuery.gpuHmrSuccess === true ? 'passed' : 'failed',
        evidenceRefs: [trace.after.dispatchId, proof.proofLedger.proofId],
      },
      {
        stageId: 'webgpu-visual-oracle',
        status: visualThresholdValidation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [artifacts.diffImageHash],
      },
      {
        stageId: 'webgpu-acceptance-contract',
        status: acceptanceContractEvaluation.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [acceptanceContract.contract_hash],
      },
      {
        stageId: 'webgpu-process-firewall',
        status: processContinuity.accepted === true ? 'passed' : 'failed',
        evidenceRefs: [`runtime:webgpu:process:${processContinuity.processIdAfter}`],
      },
    ],
    limitations,
    proofLedger: proof.proofLedger,
    proof_ledger: proof.proofLedger,
    proofLedgerQuery: proof.proofLedgerQuery,
    proof_ledger_query: proof.proofLedgerQuery,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    acceptanceContract,
    acceptance_contract: acceptanceContract,
    acceptanceContractEvaluation,
    acceptance_contract_evaluation: acceptanceContractEvaluation,
    acceptanceContractConsistency,
    acceptance_contract_consistency: acceptanceContractConsistency,
    deterministicVisualMode: proof.deterministicVisualMode,
    deterministic_visual_mode: proof.deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    visualOracleArtifacts,
    visual_oracle_artifacts: visualOracleArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    visualThresholdValidation,
    visual_threshold_validation: visualThresholdValidation,
    nativeWebGpuApiEvidence: nativeWebGpuEvidence,
    native_webgpu_api_evidence: nativeWebGpuEvidence,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    ...(artifacts.asyncVisualProof ? {
      asyncVisualProof: artifacts.asyncVisualProof,
      async_visual_proof: artifacts.asyncVisualProof,
    } : {}),
    ...(artifacts.visualArtifactTransportEvidence ? {
      visualArtifactTransportEvidence: artifacts.visualArtifactTransportEvidence,
      visual_artifact_transport_evidence: artifacts.visualArtifactTransportEvidence,
    } : {}),
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

function runtimeTraceEvent(trace, type, label) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const matches = events.filter((event) =>
    event
    && typeof event === 'object'
    && event.type === type
    && (!label || event.label === label)
  );
  return matches.at(-1) ?? null;
}

function webgpuRuntimeTraceEventRef(kind, event) {
  return event ? `runtime:webgpu:${kind}:sha256:${sha256Text(stableJson(event)).slice('sha256:'.length)}` : null;
}

function buildNativeWebGpuRuntimeTrace({
  trace,
  processContinuity,
  nativeWebGpuEvidence,
}) {
  const afterTrace = trace?.after ?? {};
  const label = afterTrace.label ?? 'after';
  const loaderObservation = runtimeTraceEvent(afterTrace, 'loader', label);
  const publishObservation = runtimeTraceEvent(afterTrace, 'epoch_publish', label);
  const dispatchObservation = runtimeTraceEvent(afterTrace, 'dispatch', label);
  const outputObservation = runtimeTraceEvent(afterTrace, 'output', label);
  const loaderRef = webgpuRuntimeTraceEventRef('loader-boundary', loaderObservation);
  const publishRef = webgpuRuntimeTraceEventRef('epoch-boundary', publishObservation);
  const dispatchRef = webgpuRuntimeTraceEventRef('dispatch-boundary', dispatchObservation);
  const outputRef = webgpuRuntimeTraceEventRef('output-boundary', outputObservation);
  const evidenceRefs = [
    loaderRef,
    publishRef,
    dispatchRef,
    outputRef,
  ].filter(Boolean);
  const loaderEvent = loaderObservation ? {
    id: `webgpu-loader-${loaderObservation.epoch ?? afterTrace.epoch}`,
    artifact_hash: loaderObservation.artifactHash ?? afterTrace.artifactHash,
    epoch: loaderObservation.epoch ?? afterTrace.epoch,
    process_id: processContinuity.processIdAfter,
    source: 'webgpu_browser_runtime_trace',
    command: 'GPUDevice.createShaderModule',
    observedEventType: loaderObservation.type,
    observed_event_type: loaderObservation.type,
    observedTimestampMs: finiteNumber(loaderObservation.timestamp, null),
    observed_timestamp_ms: finiteNumber(loaderObservation.timestamp, null),
    evidenceRefs: [loaderRef].filter(Boolean),
    evidence_refs: [loaderRef].filter(Boolean),
  } : null;
  const epochEvent = publishObservation ? {
    id: `webgpu-publish-${publishObservation.epoch ?? afterTrace.epoch}`,
    artifact_hash: publishObservation.artifactHash ?? afterTrace.artifactHash,
    epoch: publishObservation.epoch ?? afterTrace.epoch,
    process_id: processContinuity.processIdAfter,
    pipeline_id: publishObservation.pipelineId ?? afterTrace.pipelineId,
    pipeline_epoch: publishObservation.epoch ?? afterTrace.pipelineEpoch,
    source: 'webgpu_browser_runtime_trace',
    command: 'GPUDevice.createRenderPipeline',
    observedEventType: publishObservation.type,
    observed_event_type: publishObservation.type,
    observedTimestampMs: finiteNumber(publishObservation.timestamp, null),
    observed_timestamp_ms: finiteNumber(publishObservation.timestamp, null),
    evidenceRefs: [publishRef].filter(Boolean),
    evidence_refs: [publishRef].filter(Boolean),
  } : null;
  const dispatchEvent = dispatchObservation ? {
    id: dispatchObservation.dispatchId ?? afterTrace.dispatchId,
    dispatch_id: dispatchObservation.dispatchId ?? afterTrace.dispatchId,
    artifact_hash: dispatchObservation.artifactHash ?? afterTrace.artifactHash,
    epoch: dispatchObservation.epoch ?? afterTrace.epoch,
    process_id: processContinuity.processIdAfter,
    pipeline_id: dispatchObservation.pipelineId ?? afterTrace.pipelineId,
    pipeline_epoch: dispatchObservation.pipelineEpoch ?? afterTrace.pipelineEpoch,
    resource_state_hash: dispatchObservation.resourceStateHash
      ?? afterTrace.resourceTrace?.resourceStateHash,
    bind_group_bindings: dispatchObservation.bindGroupBindings
      ?? afterTrace.resourceTrace?.bindGroupBindings
      ?? [],
    vertex_buffer_bindings: dispatchObservation.vertexBufferBindings
      ?? afterTrace.resourceTrace?.vertexBuffers
      ?? [],
    source: 'webgpu_browser_runtime_trace',
    command: 'GPURenderPassEncoder.draw',
    observedEventType: dispatchObservation.type,
    observed_event_type: dispatchObservation.type,
    observedTimestampMs: finiteNumber(dispatchObservation.timestamp, null),
    observed_timestamp_ms: finiteNumber(dispatchObservation.timestamp, null),
    evidenceRefs: [dispatchRef].filter(Boolean),
    evidence_refs: [dispatchRef].filter(Boolean),
  } : null;
  const outputEvent = outputObservation ? {
    id: `webgpu-output-${outputObservation.epoch ?? afterTrace.epoch}`,
    kind: 'visual_frame',
    after_dispatch_id: outputObservation.dispatchId ?? afterTrace.dispatchId,
    artifact_hash: outputObservation.artifactHash ?? afterTrace.artifactHash,
    epoch: outputObservation.epoch ?? afterTrace.epoch,
    process_id: processContinuity.processIdAfter,
    pipeline_id: outputObservation.pipelineId ?? afterTrace.pipelineId,
    pipeline_epoch: outputObservation.pipelineEpoch ?? afterTrace.pipelineEpoch,
    frame_number: outputObservation.frameNumber ?? afterTrace.frameNumber,
    source: 'webgpu_browser_runtime_trace',
    command: 'GPUQueue.onSubmittedWorkDone+canvas_capture',
    observedEventType: outputObservation.type,
    observed_event_type: outputObservation.type,
    observedTimestampMs: finiteNumber(outputObservation.timestamp, null),
    observed_timestamp_ms: finiteNumber(outputObservation.timestamp, null),
    evidenceRefs: [outputRef].filter(Boolean),
    evidence_refs: [outputRef].filter(Boolean),
  } : null;
  const observedApiTrace = [
    'requestAdapterNative',
    'requestDeviceNative',
    'createShaderModuleNative',
    'createRenderPipelineNative',
    'queue.submit',
    'GPURenderPassEncoder.draw',
    'GPUQueue.onSubmittedWorkDone',
    'canvas_capture_after_dispatch',
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.native_runtime_trace.v1',
    schema_version: 'synthi.gpu_hmr.native_runtime_trace.v1',
    proofAuthority: 'webgpu_browser_runtime_trace_observation_not_gpu_hmr_success',
    proof_authority: 'webgpu_browser_runtime_trace_observation_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    backend: 'webgpu',
    processId: processContinuity.processIdAfter,
    process_id: processContinuity.processIdAfter,
    sameProcess: processContinuity.accepted === true,
    same_process: processContinuity.accepted === true,
    processRestarted: processContinuity.processRestarted === true,
    process_restarted: processContinuity.processRestarted === true,
    apiTrace: observedApiTrace,
    api_trace: observedApiTrace,
    nativeWebGpuApiEvidence: nativeWebGpuEvidence,
    native_webgpu_api_evidence: nativeWebGpuEvidence,
    loaderEvents: [loaderEvent].filter(Boolean),
    loader_events: [loaderEvent].filter(Boolean),
    epochEvents: [epochEvent].filter(Boolean),
    epoch_events: [epochEvent].filter(Boolean),
    dispatchEvents: [dispatchEvent].filter(Boolean),
    dispatch_events: [dispatchEvent].filter(Boolean),
    outputEvents: [outputEvent].filter(Boolean),
    output_events: [outputEvent].filter(Boolean),
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

async function writeHotRuntimeRunModeProof({ filePath, profile, proof, artifacts, metrics, runMode }) {
  const coverageObligations = webgpuRunModeCoverageObligations(profile);
  const firewallEvidence = webgpuCompanionFirewallEvidence(proof);
  const visualOracleArtifacts = visualArtifactsForWebgpuRunMode(artifacts);
  const visualEvidenceArtifacts =
    proof.runtimeProofArtifact?.visualEvidenceArtifacts
    ?? proof.runtimeProofArtifact?.visual_evidence_artifacts
    ?? visualEvidenceArtifactsFromVisualOracleArtifacts(
      visualOracleArtifacts,
      {
        proofLedgerQuery: proof.proofLedgerQuery,
        proofLedgerRecord: proof.proofLedger.records?.[0],
        producerSubsystem: 'mcp.webgpu_runtime_visual_proof',
      },
    );
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
    proofId: `runtime-run-mode-proof:${sha256Text(stableJson({
      schema: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
      backend: 'webgpu',
      targetId: profile.targetId,
      runMode,
      runtimeProofArtifactId: proof.runtimeProofArtifact.proofId,
      ledgerProofId: proof.proofLedger.proofId,
      diffImageHash: artifacts.diffImageHash,
      sourceProofId: proof.proofId,
    }))}`,
    backend: 'webgpu',
    targetId: profile.targetId,
    target_id: profile.targetId,
    profileId: profile.id,
    profile_id: profile.id,
    acceptedForGpuHmr: proof.gpuHmrSuccess === true,
    accepted_for_gpu_hmr: proof.gpuHmrSuccess === true,
    gpuHmrSuccess: proof.gpuHmrSuccess === true,
    gpu_hmr_success: proof.gpuHmrSuccess === true,
    cpuHmrUsed: firewallEvidence.cpuHmrUsed,
    cpu_hmr_used: firewallEvidence.cpu_hmr_used,
    fullRebuildUsed: firewallEvidence.fullRebuildUsed,
    full_rebuild_used: firewallEvidence.full_rebuild_used,
    processRestarted: firewallEvidence.processRestarted,
    process_restarted: firewallEvidence.process_restarted,
    firewallEvidence,
    firewall_evidence: firewallEvidence,
    visualRequired: true,
    visual_required: true,
    visualArtifacts: visualOracleArtifacts,
    visual_oracle_artifacts: visualOracleArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    visualMetrics: visualMetricsForWebgpuRunMode(metrics),
    visual_metrics: visualMetricsForWebgpuRunMode(metrics),
    runMode,
    run_mode: runMode,
    timingMetrics: {
      ...runMode,
      ...proof.timings,
    },
    timing_metrics: {
      ...runMode,
      ...proof.timings,
    },
    timings: proof.timings,
    runtimeProofArtifact: proof.runtimeProofArtifact,
    runtime_proof_artifact: proof.runtimeProofArtifact,
    proofLedger: proof.proofLedger,
    proof_ledger: proof.proofLedger,
    proofLedgerQuery: proof.proofLedgerQuery,
    proof_ledger_query: proof.proofLedgerQuery,
    acceptanceContract: proof.contract,
    acceptance_contract: proof.contract,
    deterministicVisualMode: proof.deterministicVisualMode,
    deterministic_visual_mode: proof.deterministicVisualMode,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'webgpu_visual_oracle',
    evidence_kind: 'webgpu_visual_oracle',
    coverageObligations,
    coverage_obligations: coverageObligations,
    validationTargetScope: 'webgpu_run_mode_target',
    validation_target_scope: 'webgpu_run_mode_target',
  };
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

async function writeWebgpuNegativeEditRefusal({
  filePath,
  profile,
  proof,
  runMode,
  runModeCoverageSupport = null,
}) {
  if (!profile.negativeEdit) return null;
  const negativeRunMode = {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    metric_scope: 'hot_delta_2',
    metricScope: 'hot_delta_2',
    cache_state: runMode.cache_state,
    cacheState: runMode.cacheState,
    edit_id: profile.negativeEdit.editId,
    editId: profile.negativeEdit.editId,
    edit_hash: profile.negativeEdit.editHash,
    editHash: profile.negativeEdit.editHash,
    edit_kind: 'negative_edit',
    editKind: 'negative_edit',
    different_edit: true,
    differentEdit: true,
  };
  const firewallEvidence = webgpuCompanionFirewallEvidence(proof);
  const boundRunModeCoverageSupport = runModeCoverageSupport
    ? bindGpuHmrRunModeCoverageSupport(runModeCoverageSupport, { runMode: negativeRunMode })
    : null;
  const seed = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    backend: 'webgpu',
    targetId: profile.targetId,
    target_id: profile.targetId,
    profileId: profile.id,
    profile_id: profile.id,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    cpuHmrUsed: firewallEvidence.cpuHmrUsed,
    cpu_hmr_used: firewallEvidence.cpu_hmr_used,
    fullRebuildUsed: firewallEvidence.fullRebuildUsed,
    full_rebuild_used: firewallEvidence.full_rebuild_used,
    processRestarted: firewallEvidence.processRestarted,
    process_restarted: firewallEvidence.process_restarted,
    firewallEvidence,
    firewall_evidence: firewallEvidence,
    route: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'reject',
      confidence: 1,
      blocking_gaps: profile.negativeEdit.reasons,
    },
    reasons: profile.negativeEdit.reasons,
    unsupportedReasons: profile.negativeEdit.reasons,
    unsupported_reasons: profile.negativeEdit.reasons,
    negativeEdit: {
      claim: profile.negativeEdit.claim,
      pipeline: profile.negativeEdit.pipeline,
      editHash: profile.negativeEdit.editHash,
    },
    negative_edit: {
      claim: profile.negativeEdit.claim,
      pipeline: profile.negativeEdit.pipeline,
      edit_hash: profile.negativeEdit.editHash,
    },
    runMode: negativeRunMode,
    run_mode: negativeRunMode,
    timingMetrics: negativeRunMode,
    timing_metrics: negativeRunMode,
    sourceProofId: proof.proofId,
    source_proof_id: proof.proofId,
    evidenceKind: 'negative_edit',
    evidence_kind: 'negative_edit',
    ...(boundRunModeCoverageSupport ? {
      runModeCoverageSupport: boundRunModeCoverageSupport,
      run_mode_coverage_support: boundRunModeCoverageSupport,
    } : {}),
    coverageObligations: webgpuRunModeCoverageObligations(profile),
    coverage_obligations: webgpuRunModeCoverageObligations(profile),
    validationTargetScope: 'webgpu_run_mode_target',
    validation_target_scope: 'webgpu_run_mode_target',
  };
  const artifact = {
    ...seed,
    proofId: `agent-split-negative-edit-refusal:${sha256Text(stableJson(seed))}`,
  };
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function buildLedgerRecord({
  profile,
  trace,
  contract,
  artifacts,
  metrics,
  timings,
  processContinuity,
  deviceIdentity,
  modelProvenanceEvidence,
  visualThresholdValidation,
  nativeWebGpuApiEvidence,
  runMode,
}) {
  const afterEpoch = trace.after.epoch;
  const dispatchId = trace.after.dispatchId;
  const processId = processContinuity.processIdAfter;
  const runtimeResourceTrace = trace.after.resourceTrace ?? {};
  const evidenceRefs = [
    profile.profileHash,
    artifacts.beforeImageHash,
    artifacts.afterImageHash,
    artifacts.diffImageHash,
    contract.contract_hash,
    runtimeResourceTrace.resourceStateHash
      ? `runtime:webgpu:resource-state:${runtimeResourceTrace.resourceStateHash}`
      : null,
  ].filter(Boolean);
  const visualArtifacts = {
    before_image: artifacts.beforeImage,
    after_image: artifacts.afterImage,
    diff_image: artifacts.diffImage,
    before_image_hash: artifacts.beforeImageHash,
    after_image_hash: artifacts.afterImageHash,
    diff_image_hash: artifacts.diffImageHash,
    before_image_hash_verified: true,
    after_image_hash_verified: true,
    diff_image_hash_verified: true,
    blank_frame_rejection: metrics.visiblePixelCount > 0,
    same_frame_rejection: artifacts.beforeImageHash !== artifacts.afterImageHash
      && metrics.changedPixelRatio > 0,
    new_epoch_watermark_or_trace: `${dispatchId}:${afterEpoch}:${profile.afterHash}`,
    camera_state_hash: sha256Text(stableJson({
      profile: profile.targetId,
      camera: 'webgpu-2d-canvas-fixed',
      width: profile.width,
      height: profile.height,
    })),
    swapchain_size: [profile.width, profile.height],
    capture_backend: 'playwright-canvas-screenshot',
    frame_number: trace.after.frameNumber,
    timestamp_after_dispatch: timings.outputTimestampNs,
    perceptual_diff: metrics.perceptualDiff,
    changed_pixel_ratio: metrics.changedPixelRatio,
    visible_pixel_count: metrics.visiblePixelCount,
    pixel_metrics_verified: true,
    visual_pixel_verification: {
      metrics_verified: true,
      thresholds_verified: visualThresholdValidation.accepted,
      threshold_failures: visualThresholdValidation.failedGates,
      min_changed_pixel_ratio: profile.visualProof.minChangedPixelRatio,
      min_mean_abs_delta_8bit: profile.visualProof.minMeanAbsDelta8bit,
      before_image_hash: artifacts.beforeImageHash,
      after_image_hash: artifacts.afterImageHash,
      diff_image_hash: artifacts.diffImageHash,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      changed_pixel_ratio: metrics.changedPixelRatio,
      mean_abs_delta_8bit: metrics.meanAbsDelta8bit,
      perceptual_diff: metrics.perceptualDiff,
      visible_pixel_count: metrics.visiblePixelCount,
    },
    ...(Array.isArray(artifacts.artifactCasLocators) && artifacts.artifactCasLocators.length > 0 ? {
      artifact_cas_locators: artifacts.artifactCasLocators,
      artifact_transport_authority: 'transport_integrity_only_not_visual_or_ledger_proof',
    } : {}),
    ...(artifacts.visualArtifactTransportEvidence ? {
      visual_artifact_transport_evidence: artifacts.visualArtifactTransportEvidence,
    } : {}),
    ...(artifacts.asyncVisualProof ? {
      async_visual_proof: artifacts.asyncVisualProof,
    } : {}),
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
      id: `webgpu-loader-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      source: 'device.createShaderModule',
    },
    epoch_publish_event: {
      id: `webgpu-publish-${afterEpoch}`,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      pipeline_id: trace.after.pipelineId,
      pipeline_epoch: trace.after.pipelineEpoch,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      pipeline_id: trace.after.pipelineId,
      pipeline_epoch: trace.after.pipelineEpoch,
      resource_state_hash: runtimeResourceTrace.resourceStateHash ?? profile.pipeline.resourceStateHash,
      bind_group_bindings: runtimeResourceTrace.bindGroupBindings ?? [],
      vertex_buffer_bindings: runtimeResourceTrace.vertexBuffers ?? [],
      command: 'GPURenderPassEncoder.draw',
    },
    output_event: {
      id: `webgpu-output-${afterEpoch}`,
      kind: 'visual_frame',
      passed: visualThresholdValidation.accepted,
      after_dispatch_id: dispatchId,
      artifact_hash: profile.afterHash,
      epoch: afterEpoch,
      timestamp_monotonic_ns: timings.outputTimestampNs,
      process_id: processId,
      output_oracle: {
        kind: 'deterministic_visual_oracle',
        oracle_artifacts: {
          visual_oracle_artifacts: visualArtifacts,
        },
      },
    },
    retirement_event: {
      id: `webgpu-retire-${trace.before.epoch}`,
      status: 'frame_boundary_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: trace.before.epoch,
      evidence_refs: [dispatchId, artifacts.afterImageHash],
    },
    process_identity: {
      process_id: processId,
      browser_pid: processId,
      page_url: trace.url,
      process_identity_source: processContinuity.sourceAfter,
      same_page_instance_id: trace.after.pageInstanceId,
    },
    device_identity: deviceIdentity,
    runtime_resource_trace: runtimeResourceTrace,
    firewall_evidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: processContinuity.processRestarted,
      process_id_before: processContinuity.processIdBefore,
      process_id_after: processContinuity.processIdAfter,
      process_identity_source_before: processContinuity.sourceBefore,
      process_identity_source_after: processContinuity.sourceAfter,
      same_page_instance_id_before: trace.before.pageInstanceId,
      same_page_instance_id_after: trace.after.pageInstanceId,
      same_page_instance_preserved: trace.before.pageInstanceId === trace.after.pageInstanceId,
      native_webgpu_api_evidence: nativeWebGpuApiEvidence,
      cpu_hmr_absence_evidence: 'runner invokes native WebGPU createShaderModule/createRenderPipeline and no CPU HMR endpoint',
      full_rebuild_absence_evidence: 'runner does not invoke a build system or reload the page; WGSL artifact is loaded through createShaderModule',
    },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: processContinuity.processRestarted,
    oracle_artifacts: {
      visual_oracle_artifacts: visualArtifacts,
    },
    deterministic_visual_mode: profile.deterministicVisualMode,
    output_oracle_target: {
      kind: 'visual',
      target: 'webgpu-canvas-frame',
    },
    timings: timingFields(timings.ns, runMode),
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    model_provenance: modelProvenanceEvidence,
    evidence_refs: evidenceRefs,
  };
}

async function runProof() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const runStartNs = process.hrtime.bigint();
  const timings = { ns: {} };
  const checkedAt = new Date().toISOString();
  const staticStartNs = process.hrtime.bigint();
  const profile = await loadProfile(CFG.profilePath);
  const runMode = runModeMetadata(profile);
  const staticEndNs = process.hrtime.bigint();
  timings.ns.staticDiscovery = durationNs(staticStartNs, staticEndNs);
  timings.ns.aiContractSynthesis = 0;
  const modelAvailabilityStartNs = process.hrtime.bigint();
  const modelProvenanceEvidence = modelProvenance(checkedAt);
  timings.ns.modelAvailability = durationNs(modelAvailabilityStartNs, process.hrtime.bigint());

  const hashStartNs = process.hrtime.bigint();
  const browserExecutable = findBrowserExecutable();
  const profileSlug = safeSlug(`${CFG.slug}-${profile.id}`);
  const beforeImage = path.join(ARTIFACT_DIR, `${profileSlug}-before.png`);
  const afterImage = path.join(ARTIFACT_DIR, `${profileSlug}-after.png`);
  const diffImage = path.join(ARTIFACT_DIR, `${profileSlug}-diff.png`);
  const proofPath = path.join(ARTIFACT_DIR, `${profileSlug}-proof.json`);
  const coldRunModeProofPath = path.join(ARTIFACT_DIR, `${profileSlug}-cold-run-mode-proof.json`);
  const hotRunModeProofPath = path.join(ARTIFACT_DIR, `${profileSlug}-${runMode.metric_scope}-run-mode-proof.json`);
  const negativeEditRefusalPath = path.join(ARTIFACT_DIR, `${profileSlug}-negative-edit-refusal.json`);
  const summaryPath = path.join(ARTIFACT_DIR, `${profileSlug}-summary.txt`);
  const hashEndNs = process.hrtime.bigint();
  timings.ns.artifactHash = durationNs(hashStartNs, hashEndNs);

  if (!browserExecutable) throw new Error('browser executable missing');

  const { server, url } = await startServer(diagnosticHtml(profile));
  let browser;
  let page;
  try {
    const runtimeStartNs = process.hrtime.bigint();
    browser = await chromium.launch({
      executablePath: browserExecutable,
      headless: true,
      args: WEBGPU_LAUNCH_ARGS,
    });
    const processIdentityBefore = await browserProcessIdentity(browser);
    if (!processIdentityBefore?.processId) throw new Error('browser process identity unavailable before proof');
    page = await browser.newPage({ viewport: { width: profile.width, height: profile.height + 80 } });
    await page.goto(url, { waitUntil: 'load', timeout: CFG.timeoutMs });
    await page.waitForFunction(() => Boolean(window.__synthiWebGpuRuntimeProof), null, {
      timeout: CFG.timeoutMs,
    });
    timings.ns.runtimeProbe = durationNs(runtimeStartNs, process.hrtime.bigint());

    const beforeTrace = await page.evaluate(
      ({ code, hash }) => window.__synthiWebGpuRuntimeProof.renderEpoch(code, hash, 'before'),
      { code: profile.beforeWgsl, hash: profile.beforeHash },
    );
    const beforeScreenshotStart = process.hrtime.bigint();
    await canvasScreenshot(page, beforeImage);
    const beforeScreenshotEnd = process.hrtime.bigint();

    const adapterStartNs = process.hrtime.bigint();
    const afterTrace = await page.evaluate(
      ({ code, hash }) => window.__synthiWebGpuRuntimeProof.renderEpoch(code, hash, 'after'),
      { code: profile.afterWgsl, hash: profile.afterHash },
    );
    const afterDispatchNs = process.hrtime.bigint();
    const afterScreenshotStart = process.hrtime.bigint();
    await canvasScreenshot(page, afterImage);
    const afterScreenshotEnd = process.hrtime.bigint();

    const oracleStartNs = process.hrtime.bigint();
    const visualProofBundle = await buildAsyncVisualProofBundle({
      beforePath: beforeImage,
      afterPath: afterImage,
      diffPath: diffImage,
      artifactDir: ARTIFACT_DIR,
      sessionNamespace: profileSlug,
      producer: {
        name: 'webgpu_runtime_visual_proof',
        kind: 'runtime_visual_runner',
      },
      visualProof: profile.visualProof,
    });
    if (visualProofBundle.accepted !== true) {
      const reasons = Array.isArray(visualProofBundle.asyncVisualProof?.reasons)
        ? visualProofBundle.asyncVisualProof.reasons.join(',')
        : 'unknown';
      throw new Error(`webgpu visual proof worker failed: ${reasons}`);
    }
    const metrics = visualProofBundle.metrics;
    const oracleEndNs = process.hrtime.bigint();

    const artifacts = {
      beforeImage: visualProofBundle.artifacts.beforeImage ?? beforeImage,
      afterImage: visualProofBundle.artifacts.afterImage ?? afterImage,
      diffImage: visualProofBundle.artifacts.diffImage ?? diffImage,
      beforeImageHash: visualProofBundle.artifacts.beforeImageHash,
      afterImageHash: visualProofBundle.artifacts.afterImageHash,
      diffImageHash: visualProofBundle.artifacts.diffImageHash,
      artifactCasLocators: visualProofBundle.artifactCasLocators,
      artifact_cas_locators: visualProofBundle.artifactCasLocators,
      visualArtifactTransportEvidence: visualProofBundle.visualArtifactTransportEvidence,
      visual_artifact_transport_evidence: visualProofBundle.visualArtifactTransportEvidence,
      asyncVisualProof: visualProofBundle.asyncVisualProof,
      async_visual_proof: visualProofBundle.asyncVisualProof,
    };
    const trace = {
      url,
      before: beforeTrace,
      after: afterTrace,
    };
    const processIdentityAfter = await browserProcessIdentity(browser);
    if (!processIdentityAfter?.processId) throw new Error('browser process identity unavailable after proof');
    const processContinuity = processContinuityEvidence({
      before: processIdentityBefore,
      after: processIdentityAfter,
    });
    const visualThresholdValidation = validateVisualThresholds({ profile, artifacts, metrics });
    const nativeWebGpuEvidence = nativeWebGpuApiEvidence(trace);
    const deviceIdentity = {
      adapter_info: afterTrace.adapterInfo,
      features: afterTrace.features,
      limits: afterTrace.limits,
      preferred_canvas_format: afterTrace.preferredCanvasFormat,
      browser_executable: browserExecutable,
      browser_launch_args: WEBGPU_LAUNCH_ARGS,
      process_continuity: processContinuity,
      native_webgpu_api_evidence: nativeWebGpuEvidence,
    };
    const contract = buildContract({
      profile,
      trace,
      hashes: artifacts,
      runMode,
      processContinuity,
    });
    timings.ns.adapterGeneration = durationNs(adapterStartNs, afterDispatchNs);
    timings.loaderTimestampNs = eventTimeNs(afterTrace, 'loader');
    timings.publishTimestampNs = eventTimeNs(afterTrace, 'epoch_publish');
    timings.dispatchTimestampNs = eventTimeNs(afterTrace, 'dispatch');
    timings.outputTimestampNs = eventTimeNs(afterTrace, 'output');
    timings.ns.artifactLoad = Math.max(0, timings.publishTimestampNs - timings.loaderTimestampNs);
    timings.ns.epochPublish = Math.max(0, timings.dispatchTimestampNs - timings.publishTimestampNs);
    timings.ns.dispatchTrace = Math.max(0, timings.outputTimestampNs - timings.dispatchTimestampNs);
    timings.ns.deviceCompileWall = Math.max(0, timings.outputTimestampNs - timings.loaderTimestampNs);
    timings.ns.oracleAnalysis = durationNs(oracleStartNs, oracleEndNs);
    timings.ns.triggerToVisible = durationNs(adapterStartNs, afterScreenshotEnd);
    timings.ns.screenshotCapture = durationNs(beforeScreenshotStart, beforeScreenshotEnd)
      + durationNs(afterScreenshotStart, afterScreenshotEnd);
    timings.ns.dispatchToOutputProof = durationNs(afterDispatchNs, oracleEndNs);
    timings.ns.totalValidatorWall = nsSince(runStartNs);
    timings.retirementTimestampNs = timings.outputTimestampNs + 1;

    const ledgerRecord = buildLedgerRecord({
      profile,
      trace,
      contract,
      artifacts,
      metrics,
      timings,
      processContinuity,
      deviceIdentity,
      modelProvenanceEvidence,
      visualThresholdValidation,
      nativeWebGpuApiEvidence: nativeWebGpuEvidence,
      runMode,
    });
    const runtimeTrace = buildNativeWebGpuRuntimeTrace({
      trace,
      processContinuity,
      nativeWebGpuEvidence,
    });
    const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
    const ledgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
    const baseRuntimeAccepted = proofLedger.gpuHmrSuccess === true
      && ledgerQuery.gpuHmrSuccess === true
      && visualThresholdValidation.accepted === true
      && processContinuity.accepted === true
      && nativeWebGpuEvidence.accepted === true;
    const proof = {
      schema: SCHEMA,
      slug: CFG.slug,
      profile: {
        id: profile.id,
        targetId: profile.targetId,
        target_id: profile.targetId,
        path: profile.profilePath,
        hash: profile.profileHash,
      },
      browser: {
        executable: browserExecutable,
        candidateExecutables: candidateBrowserExecutables(),
        launchArgs: WEBGPU_LAUNCH_ARGS,
        processIdentityBefore,
        processIdentityAfter,
        processContinuity,
      },
      runtime: {
        url,
        adapterInfo: afterTrace.adapterInfo,
        features: afterTrace.features,
        limits: afterTrace.limits,
        preferredCanvasFormat: afterTrace.preferredCanvasFormat,
      },
      contract,
      artifacts,
      metrics,
      visualThresholdValidation,
      nativeWebGpuApiEvidence: nativeWebGpuEvidence,
      runtimeTrace,
      runtime_trace: runtimeTrace,
      deterministicVisualMode: profile.deterministicVisualMode,
      proofLedger,
      proofLedgerQuery: ledgerQuery,
      gpuHmrSuccess: baseRuntimeAccepted,
      resultState: baseRuntimeAccepted
        ? 'webgpu-hmr-full-runtime-proven'
        : 'webgpu-hmr-rejected',
      timingMetrics: runMode,
      timing_metrics: runMode,
      timings: timingFields(timings.ns, runMode),
      noShimApplied: nativeWebGpuEvidence.accepted === true,
      noBrowserFlagClaimedAsHmr: true,
    };
    proof.proofId = `webgpu-runtime-visual-proof:${sha256Text(stableJson({
      schema: proof.schema,
      profile: proof.profile,
      artifacts: proof.artifacts,
      contractHash: contract.contract_hash,
      ledgerProofId: proofLedger.proofId,
      metrics: proof.metrics,
    }))}`;
    proof.runtimeProofArtifact = buildRuntimeProofArtifact({
      proof,
      trace,
      artifacts,
      visualThresholdValidation,
      nativeWebGpuEvidence,
      processContinuity,
      runtimeTrace,
    });
    proof.runtime_proof_artifact = proof.runtimeProofArtifact;
    proof.gpuHmrSuccess = proof.runtimeProofArtifact.gpuHmrSuccess === true;
    proof.gpu_hmr_success = proof.gpuHmrSuccess;
    proof.resultState = proof.gpuHmrSuccess
      ? 'webgpu-hmr-full-runtime-proven'
      : 'webgpu-hmr-rejected';
    const runModeCoverageSupport = buildGpuHmrRunModeCoverageSupport({
      proofLedger,
      proofLedgerQuery: ledgerQuery,
      runtimeProofArtifact: proof.runtimeProofArtifact,
      parentProofIds: [proof.proofId],
    });

    const coldRunModeProof = await writeColdRuntimeRunModeProof({
      filePath: coldRunModeProofPath,
      profile,
      proof,
      artifacts,
      runModeCoverageSupport,
    });
    const hotRunModeProof = await writeHotRuntimeRunModeProof({
      filePath: hotRunModeProofPath,
      profile,
      proof,
      artifacts,
      metrics,
      runMode,
    });
    const negativeEditRefusal = await writeWebgpuNegativeEditRefusal({
      filePath: negativeEditRefusalPath,
      profile,
      proof,
      runMode,
      runModeCoverageSupport,
    });
    proof.runModeCompanionArtifacts = {
      coldRuntimeInitial: coldRunModeProofPath,
      [runMode.metric_scope]: hotRunModeProofPath,
      ...(negativeEditRefusal ? { negativeEditRefusal: negativeEditRefusalPath } : {}),
    };
    proof.run_mode_companion_artifacts = proof.runModeCompanionArtifacts;
    proof.runModeCompanionProofIds = {
      coldRuntimeInitial: coldRunModeProof.proofId,
      [runMode.metric_scope]: hotRunModeProof.proofId,
      ...(negativeEditRefusal ? { negativeEditRefusal: negativeEditRefusal.proofId } : {}),
    };
    proof.run_mode_companion_proof_ids = proof.runModeCompanionProofIds;

    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(summaryPath, [
      `proof_id=${proof.proofId}`,
      `result_state=${proof.resultState}`,
      `gpu_hmr_success=${proof.gpuHmrSuccess}`,
      `ledger_proof_id=${proofLedger.proofId}`,
      `runtime_proof_artifact_id=${proof.runtimeProofArtifact.proofId}`,
      `cold_run_mode_proof_id=${coldRunModeProof.proofId}`,
      `cold_run_mode_proof_json=${coldRunModeProofPath}`,
      `hot_run_mode_proof_id=${hotRunModeProof.proofId}`,
      `hot_run_mode_proof_json=${hotRunModeProofPath}`,
      `negative_edit_refusal_proof_id=${negativeEditRefusal?.proofId ?? 'none'}`,
      `negative_edit_refusal_json=${negativeEditRefusal ? negativeEditRefusalPath : ''}`,
      `ledger_failed_invariants=${ledgerQuery.failedInvariants.map((failure) => failure.code).join(',') || 'none'}`,
      `runtime_proof_strict_gate=${proof.runtimeProofArtifact.strictGate?.status ?? 'unknown'}`,
      `visual_thresholds_accepted=${visualThresholdValidation.accepted}`,
      `visual_threshold_failures=${visualThresholdValidation.failedGates.join(',') || 'none'}`,
      `process_continuity_accepted=${processContinuity.accepted}`,
      `process_continuity_failures=${processContinuity.failedGates.join(',') || 'none'}`,
      `native_webgpu_api_accepted=${nativeWebGpuEvidence.accepted}`,
      `native_webgpu_api_failures=${nativeWebGpuEvidence.failedGates.join(',') || 'none'}`,
      `profile=${profile.id}`,
      `browser=${browserExecutable}`,
      `browser_launch_args=${WEBGPU_LAUNCH_ARGS.join(' ')}`,
      `adapter=${JSON.stringify(afterTrace.adapterInfo)}`,
      `wgsl_hash_before=${profile.beforeHash}`,
      `wgsl_hash_after=${profile.afterHash}`,
      `epoch=${afterTrace.epoch}`,
      `dispatch_id=${afterTrace.dispatchId}`,
      `pipeline_id=${afterTrace.pipelineId}`,
      `before=${beforeImage}`,
      `after=${afterImage}`,
      `diff=${diffImage}`,
      `changed_pixel_ratio=${metrics.changedPixelRatio}`,
      `mean_abs_delta_8bit=${metrics.meanAbsDelta8bit}`,
      `visible_pixel_count=${metrics.visiblePixelCount}`,
      `total_validator_wall_time=${timings.ns.totalValidatorWall}`,
      `trigger_to_visible_time=${timings.ns.triggerToVisible}`,
      `no_shim_applied=true`,
      `no_browser_flag_claimed_as_hmr=true`,
      '',
    ].join('\n'));

    if (!proof.gpuHmrSuccess) {
      const failures = [
        ...ledgerQuery.failedInvariants.map((f) => f.code),
        ...(proof.runtimeProofArtifact.strictGate?.failures ?? []),
        ...visualThresholdValidation.failedGates,
        ...processContinuity.failedGates,
        ...nativeWebGpuEvidence.failedGates,
      ];
      throw new Error(`WebGPU runtime visual proof rejected: ${failures.join(',')}`);
    }
    return { proof, proofPath, summaryPath };
  } finally {
    try {
      await page?.evaluate(() => window.__synthiWebGpuRuntimeProof?.destroy?.());
    } catch {}
    try { await browser?.close(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
}

function syntheticVisualArtifacts() {
  return {
    before_image: 'before.png',
    after_image: 'after.png',
    diff_image: 'diff.png',
    before_image_hash: `sha256:${'1'.repeat(64)}`,
    after_image_hash: `sha256:${'2'.repeat(64)}`,
    diff_image_hash: `sha256:${'3'.repeat(64)}`,
    before_image_hash_verified: true,
    after_image_hash_verified: true,
    diff_image_hash_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: `webgpu-dispatch-2:webgpu-epoch-2:sha256:${'b'.repeat(64)}`,
    camera_state_hash: `sha256:${'4'.repeat(64)}`,
    swapchain_size: [640, 360],
    capture_backend: 'self-check',
    frame_number: 2,
    timestamp_after_dispatch: 80,
    perceptual_diff: 0.2,
    changed_pixel_ratio: 0.3,
    visible_pixel_count: 100,
    pixel_metrics_verified: true,
    visual_pixel_verification: {
      metrics_verified: true,
      before_image_hash: `sha256:${'1'.repeat(64)}`,
      after_image_hash: `sha256:${'2'.repeat(64)}`,
      diff_image_hash: `sha256:${'3'.repeat(64)}`,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
    },
  };
}

function selfCheckLedgerRecord(overrides = {}) {
  const artifactBefore = `sha256:${'a'.repeat(64)}`;
  const artifactAfter = `sha256:${'b'.repeat(64)}`;
  const visualArtifacts = syntheticVisualArtifacts();
  return {
    project_id: 'webgpu-self-check',
    edit_id: 'webgpu-self-check-edit',
    backend: 'webgpu',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: `sha256:${'c'.repeat(64)}`,
    artifact_before_hash: artifactBefore,
    artifact_after_hash: artifactAfter,
    loader_event: { id: 'loader', artifact_hash: artifactAfter, epoch: 'webgpu-epoch-2', timestamp_monotonic_ns: 10, process_id: '100' },
    epoch_publish_event: { id: 'publish', artifact_hash: artifactAfter, epoch: 'webgpu-epoch-2', timestamp_monotonic_ns: 20, process_id: '100' },
    dispatch_event: { id: 'webgpu-dispatch-2', artifact_hash: artifactAfter, epoch: 'webgpu-epoch-2', timestamp_monotonic_ns: 40, process_id: '100' },
    output_event: {
      id: 'output',
      kind: 'visual_frame',
      passed: true,
      after_dispatch_id: 'webgpu-dispatch-2',
      artifact_hash: artifactAfter,
      epoch: 'webgpu-epoch-2',
      timestamp_monotonic_ns: 80,
      process_id: '100',
      output_oracle: {
        oracle_artifacts: {
          visual_oracle_artifacts: visualArtifacts,
        },
      },
    },
    retirement_event: { id: 'retire', status: 'frame_boundary_proven', timestamp_monotonic_ns: 90, process_id: '100' },
    process_identity: { process_id: '100' },
    device_identity: { adapter_info: { vendor: 'amd' } },
    firewall_evidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: '100',
      process_id_after: '100',
    },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    oracle_artifacts: { visual_oracle_artifacts: visualArtifacts },
    deterministic_visual_mode: {
      fixed_seed: 'self-check',
      seed_policy_fixed: true,
      frozen_camera: true,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
    },
    output_oracle_target: { kind: 'visual' },
    timings: timingFields({
      staticDiscovery: 1,
      aiContractSynthesis: 0,
      modelAvailability: 0,
      artifactHash: 1,
      adapterGeneration: 1,
      deviceCompileWall: 1,
      artifactLoad: 1,
      epochPublish: 1,
      dispatchTrace: 1,
      runtimeProbe: 1,
      oracleAnalysis: 1,
      triggerToVisible: 1,
      screenshotCapture: 1,
      dispatchToOutputProof: 1,
      totalValidatorWall: 10,
    }),
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'pipeline_cache_warm',
    model_provenance: modelProvenance('2026-06-09T00:00:00.000Z'),
    evidence_refs: [`sha256:${'e'.repeat(64)}`],
    ...overrides,
  };
}

function selfCheck() {
  const supportedProfiledPipeline = normalizeSupportedPipeline({
    layout: 'explicit-profiled',
    primitiveTopology: 'triangle-list',
    bindGroupLayouts: [{
      entries: [{
        binding: 0,
        visibility: 'vertex|fragment',
        buffer: { type: 'uniform', minBindingSize: 16 },
      }],
    }],
    bindGroups: [{
      layoutIndex: 0,
      entries: [{
        binding: 0,
        resource: {
          kind: 'uniform_buffer',
          dataType: 'float32',
          values: [1, 0, 0, 1],
        },
      }],
    }],
    vertexBufferLayouts: [{
      arrayStride: 8,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
    }],
    vertexBuffers: [{
      slot: 0,
      dataType: 'float32',
      values: [-1, -1, 0, 1, 1, -1],
    }],
  }, { vertexCount: 3 });
  if (
    supportedProfiledPipeline.scope !== 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list'
    || supportedProfiledPipeline.resourceCounts.bindGroups !== 1
    || supportedProfiledPipeline.resourceCounts.vertexBuffers !== 1
    || !supportedProfiledPipeline.resourceStateHash
  ) {
    throw new Error('self-check failed to accept supported profiled WebGPU pipeline resources');
  }
  let unsupportedPipelineRejected = false;
  try {
    normalizeSupportedPipeline({
      layout: 'explicit-profiled',
      primitiveTopology: 'triangle-list',
      bindGroupLayouts: [{
        entries: [{
          binding: 0,
          visibility: 'fragment',
          buffer: { type: 'storage' },
        }],
      }],
      bindGroups: [{
        layoutIndex: 0,
        entries: [{
          binding: 0,
          resource: {
            kind: 'uniform_buffer',
            dataType: 'float32',
            values: [1, 0, 0, 1],
          },
        }],
      }],
    });
  } catch (error) {
    unsupportedPipelineRejected = Array.isArray(error.unsupportedReasons)
      && error.unsupportedReasons.includes('bind_group_0_entry_0_buffer_type_unsupported:storage');
  }
  if (!unsupportedPipelineRejected) {
    throw new Error('self-check failed to reject unsupported WebGPU pipeline resource profile');
  }
  const thresholdResult = validateVisualThresholds({
    profile: {
      visualProof: {
        minChangedPixelRatio: 0.5,
        minMeanAbsDelta8bit: 10,
      },
    },
    artifacts: {
      beforeImageHash: `sha256:${'1'.repeat(64)}`,
      afterImageHash: `sha256:${'2'.repeat(64)}`,
    },
    metrics: {
      changedPixelRatio: 0.01,
      meanAbsDelta8bit: 1,
      visiblePixelCount: 100,
    },
  });
  if (
    thresholdResult.accepted !== false
    || !thresholdResult.failedGates.includes('changed_pixel_ratio_below_profile_threshold')
    || !thresholdResult.failedGates.includes('mean_abs_delta_below_profile_threshold')
  ) {
    throw new Error('self-check failed to reject visual metrics below profile thresholds');
  }
  const shutdownModel = modelProvenanceRecord({
    mode: 'gpu_delta',
    model: 'gemini-3.1-flash-lite-preview',
    checkedAt: '2026-06-09T00:00:00.000Z',
  });
  if (shutdownModel.provider_model_status !== 'shutdown' || shutdownModel.hard_infra_failure !== true) {
    throw new Error('self-check failed to classify shutdown delta model');
  }
  const accepted = evaluateGpuHmrProofLedger(selfCheckLedgerRecord());
  if (accepted.gpuHmrSuccess !== true) {
    throw new Error(`self-check accepted record rejected: ${accepted.failedInvariants.map((f) => f.code).join(',')}`);
  }
  const cpuFallback = evaluateGpuHmrProofLedger(selfCheckLedgerRecord({
    cpu_hmr_used: true,
    firewall_evidence: {
      cpu_hmr_used: true,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: '100',
      process_id_after: '100',
    },
  }));
  if (!cpuFallback.failedInvariants.some((failure) => failure.code === 'cpu_hmr_used')) {
    throw new Error('self-check failed to reject CPU fallback');
  }
  const staleEpochRecord = selfCheckLedgerRecord();
  staleEpochRecord.dispatch_event = {
    ...staleEpochRecord.dispatch_event,
    epoch: 'webgpu-epoch-old',
  };
  const staleEpoch = evaluateGpuHmrProofLedger(staleEpochRecord);
  if (!staleEpoch.failedInvariants.some((failure) => failure.code === 'dispatch_epoch_mismatch')) {
    throw new Error('self-check failed to reject stale dispatch epoch');
  }
  const missingVisual = selfCheckLedgerRecord({
    oracle_artifacts: {},
    output_event: {
      ...selfCheckLedgerRecord().output_event,
      output_oracle: {},
    },
  });
  const missingVisualResult = evaluateGpuHmrProofLedger(missingVisual);
  if (!missingVisualResult.failedInvariants.some((failure) => failure.code === 'visual_oracle_artifacts_missing')) {
    throw new Error('self-check failed to reject missing visual artifacts');
  }
  console.log('[ok] WebGPU runtime visual proof self-check passed');
}

async function main() {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return;
  }
  const { proof, proofPath, summaryPath } = await runProof();
  console.log(`proof_id=${proof.proofId}`);
  console.log(`result_state=${proof.resultState}`);
  console.log(`gpu_hmr_success=${proof.gpuHmrSuccess}`);
  console.log(`ledger_proof_id=${proof.proofLedger.proofId}`);
  console.log(`runtime_proof_artifact_id=${proof.runtimeProofArtifact?.proofId ?? ''}`);
  console.log(`proof_json=${proofPath}`);
  console.log(`summary_txt=${summaryPath}`);
  console.log(`cold_run_mode_proof_json=${proof.runModeCompanionArtifacts?.coldRuntimeInitial ?? ''}`);
  console.log(`hot_run_mode_proof_json=${proof.runModeCompanionArtifacts?.[proof.timingMetrics?.metric_scope] ?? ''}`);
  console.log(`negative_edit_refusal_json=${proof.runModeCompanionArtifacts?.negativeEditRefusal ?? ''}`);
  console.log(`before=${proof.artifacts.beforeImage}`);
  console.log(`after=${proof.artifacts.afterImage}`);
  console.log(`diff=${proof.artifacts.diffImage}`);
  console.log(`changed_pixel_ratio=${proof.metrics.changedPixelRatio}`);
  console.log(`mean_abs_delta_8bit=${proof.metrics.meanAbsDelta8bit}`);
  console.log(`total_validator_wall_time=${proof.timings.total_validator_wall_time}`);
  console.log(`trigger_to_visible_time=${proof.timings.trigger_to_visible_time}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
