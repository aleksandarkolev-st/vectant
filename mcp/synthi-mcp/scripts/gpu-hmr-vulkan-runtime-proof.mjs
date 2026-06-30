#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { evaluateGpuHmrDeterministicVisualMode } from './lib/gpu-hmr-visual-evidence.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  collectGpuHmrValidationMatrixLedger,
} from './lib/gpu-hmr-validation-matrix-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-artifacts/vulkan-runtime-proof');
const SCHEMA = 'synthi.gpu_hmr.vulkan_runtime_proof.v1';
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

const CFG = {
  slug: process.env.SLUG ?? `vulkan-runtime-frame-${nowSlugDate()}`,
  workerContainer: process.env.SYNTHI_VULKAN_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? 'vectant-ade-worker-1',
  timeoutMs: Number(process.env.SYNTHI_VULKAN_RUNTIME_TIMEOUT_MS ?? 120000),
  targetId: process.env.SYNTHI_VULKAN_RUNTIME_TARGET_ID ?? 'vulkan-runtime-frame',
  metricScope: process.env.SYNTHI_VULKAN_RUNTIME_METRIC_SCOPE ?? 'hot_delta_1',
  cacheState: process.env.SYNTHI_VULKAN_RUNTIME_CACHE_STATE ?? 'pipeline_cache_warm',
  differentEdit: process.env.SYNTHI_VULKAN_RUNTIME_DIFFERENT_EDIT === '1',
  splitModel: process.env.SYNTHI_GEMINI_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GEMINI_DELTA_MODEL ?? 'gemini-3.1-flash-lite',
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
  return String(value || 'vulkan-runtime').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function relRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function execFileRaw(command, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout ?? CFG.timeoutMs,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      cwd: options.cwd,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        exitCode: Number.isInteger(error?.code) ? error.code : 0,
        signal: error?.signal ?? null,
        timedOut: Boolean(error?.killed && error?.signal === 'SIGTERM'),
        durationMs: Number((performance.now() - started).toFixed(3)),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        stdoutTail: String(stdout ?? '').slice(-4000),
        stderrTail: String(stderr ?? '').slice(-4000),
        error: error?.message ?? null,
      });
    });
  });
}

async function dockerShell(script, timeout = CFG.timeoutMs) {
  return execFileRaw('docker', ['exec', '-w', '/tmp', CFG.workerContainer, 'sh', '-lc', script], { timeout });
}

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseVulkanLibraries(text) {
  return parseLines(text).filter((line) => /libvulkan\.so/i.test(line));
}

function parseIcdFiles(text) {
  if (/^no_vulkan_icds$/m.test(text)) return [];
  return parseLines(text).filter((line) => /\/vulkan\/icd\.d\/.+\.json$/i.test(line));
}

function parseIcdLibraries(text) {
  const libraries = new Set();
  for (const match of String(text || '').matchAll(/"library_path"\s*:\s*"([^"]+)"/gi)) {
    libraries.add(match[1].trim());
  }
  return [...libraries].filter(Boolean).sort();
}

function parseVulkanInfoSummary(text) {
  const deviceNames = new Set();
  for (const match of String(text || '').matchAll(/\bdeviceName\s*=\s*(.+)$/gim)) {
    const name = match[1].trim();
    if (name) deviceNames.add(name);
  }
  for (const match of String(text || '').matchAll(/^GPU\d+\s*:\s*(.+)$/gim)) {
    const name = match[1].trim();
    if (name) deviceNames.add(name);
  }
  const apiVersionMatch = String(text || '').match(/\bapiVersion\s*=\s*(.+)$/im);
  return {
    apiVersion: apiVersionMatch ? apiVersionMatch[1].trim() : null,
    deviceNames: [...deviceNames].sort(),
    physicalDeviceCount: deviceNames.size,
  };
}

async function vulkanRuntimePreflight() {
  const libraryProbe = await dockerShell(
    "ldconfig -p 2>/dev/null | grep -i 'libvulkan\\.so' || find /usr /lib /opt -name 'libvulkan.so*' 2>/dev/null | head -20",
  );
  const icdProbe = await dockerShell(
    "if [ -d /etc/vulkan/icd.d ]; then find /etc/vulkan/icd.d -maxdepth 1 -type f -name '*.json' -print -exec cat {} \\; 2>/dev/null || true; else echo no_vulkan_icds; fi",
  );
  const vulkaninfoPathProbe = await dockerShell('command -v vulkaninfo || true');
  const vulkaninfoPath = parseLines(vulkaninfoPathProbe.stdout)[0] ?? '';
  const vulkaninfoProbe = vulkaninfoPath
    ? await dockerShell('vulkaninfo --summary 2>&1', 60000)
    : {
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      stdoutTail: '',
      stderrTail: '',
    };
  const libraries = parseVulkanLibraries(libraryProbe.stdout);
  const icdFiles = parseIcdFiles(icdProbe.stdout);
  const icdLibraries = parseIcdLibraries(icdProbe.stdout);
  const vulkaninfoSummary = parseVulkanInfoSummary(`${vulkaninfoProbe.stdout}\n${vulkaninfoProbe.stderr}`);
  const unsupportedReasons = [
    libraries.length > 0 ? null : 'vulkan_loader_missing',
    icdFiles.length > 0 ? null : 'vulkan_icd_missing',
    vulkaninfoPath ? null : 'vulkaninfo_missing',
    vulkaninfoPath && vulkaninfoProbe.exitCode !== 0 ? 'vulkaninfo_failed' : null,
    vulkaninfoPath && vulkaninfoProbe.exitCode === 0 && !(vulkaninfoSummary.physicalDeviceCount > 0)
      ? 'vulkan_physical_device_missing'
      : null,
  ].filter(Boolean);
  return {
    accepted: unsupportedReasons.length === 0,
    unsupportedReasons,
    unsupported_reasons: unsupportedReasons,
    libraryProbe,
    icdProbe,
    vulkaninfoPathProbe,
    vulkaninfoProbe,
    libraries,
    icdFiles,
    icdLibraries,
    vulkaninfoPath,
    vulkaninfoSummary,
  };
}

function modelProvenanceRecord({ mode, model, checkedAt }) {
  const status = MODEL_REGISTRY[model] ?? {
    provider_model_status: 'private_alias',
    provider_model_alias_resolved_to: model,
    provider_shutdown_or_deprecation_detected: false,
  };
  return {
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: status.provider_model_status,
    provider_model_alias_resolved_to: status.provider_model_alias_resolved_to,
    provider_shutdown_or_deprecation_detected: status.provider_shutdown_or_deprecation_detected,
    provider_recommended_replacement: status.provider_recommended_replacement ?? null,
    model_availability_checked_at: checkedAt,
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: status.provider_model_status === 'private_alias'
      ? 'private_alias_env'
      : 'static_registry',
    model_availability_check_time_ms: 1,
    actual_model: status.provider_model_status === 'shutdown' ? null : model,
    fallback_model: null,
    fallback_used: false,
    request_mode: mode,
    hard_infra_failure: status.provider_model_status === 'shutdown',
  };
}

function modelProvenance(checkedAt = new Date().toISOString()) {
  return {
    split: modelProvenanceRecord({ mode: 'split', model: CFG.splitModel, checkedAt }),
    gpu_delta: modelProvenanceRecord({ mode: 'gpu_delta', model: CFG.gpuDeltaModel, checkedAt }),
  };
}

function deterministicVisualMode({ beforeHash, afterHash }) {
  return {
    schemaVersion: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    schema_version: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    fixed_seed: true,
    seed_policy_fixed: true,
    fixedSeed: 'vulkan-runtime-proof-seed-42',
    frozen_camera: true,
    temporal_accumulation_disabled: true,
    taa_disabled: true,
    denoiser_disabled: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: 1,
    convergence_window: {
      frame_start: 1,
      frame_end: 2,
      min_frames: 2,
      sample_count: 2,
      metric: { value: 'per_frame_delta' },
      metric_value: 0.5,
      metric_delta: 0.5,
      convergence_proven: true,
      frame_hashes: [beforeHash, afterHash],
      post_epoch_frame_hashes: [afterHash, afterHash],
      evidence_refs: ['runtime:vulkan:queue-fence', 'visual:vulkan:frame-readback'],
    },
  };
}

function runModeFor({ afterHash }) {
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: CFG.metricScope,
    cache_state: CFG.cacheState,
    edit_id: `${CFG.targetId}:${CFG.metricScope}:${afterHash}`,
    edit_hash: afterHash,
    edit_kind: 'vulkan_shader_delta',
    different_edit: CFG.differentEdit,
  };
}

function fieldEvidenceRefs(fields, refs) {
  return Object.fromEntries(fields.map((field) => [field, refs]));
}

function buildContract({ beforeHash, afterHash, runMode, processId = 'pid:vulkan-self-check' }) {
  const sourcePaths = ['shaders/vulkan-before.comp', 'shaders/vulkan-after.comp'];
  const evidenceRefs = [
    beforeHash,
    afterHash,
    'runtime:vulkan:vkCreateShaderModule',
    'runtime:vulkan:vkCreatePipelineLayout',
    'runtime:vulkan:vkCreateComputePipelines',
    'runtime:vulkan:vkQueueSubmit',
    'runtime:vulkan:vkWaitForFences',
    'visual:vulkan:frame-readback',
  ];
  const vulkanFields = [
    'shader_module_hash_before',
    'shader_module_hash_after',
    'entry_point',
    'descriptor_set_layout_hash',
    'pipeline_layout_hash',
    'pipeline_state_hash',
    'command_buffer_re_record_required',
    'command_buffer_re_record_proven',
    'frame_used_new_pipeline_trace',
  ];
  const outputOracleContract = {
    kind: 'visual',
    target_id: 'swapchain-framebuffer',
    epoch: 2,
    frame_number: 2,
    evidence_refs: ['runtime:vulkan:vkQueueSubmit', 'visual:vulkan:frame-readback'],
  };
  const fissionVerifierEvidenceId = `runtime:fission-verifier-report:vulkan:${sha256Text(stableJson({
    sourcePaths,
    entryPoint: 'main',
    beforeHash,
    afterHash,
    abi: 'compatible',
  })).replace(/^sha256:/, '')}`;
  const selectionDecisionHash = sha256Text(stableJson({
    selectedIsland: 'vulkan-pipeline:main',
    selectedReason: 'verified_fission_contract',
    changedSources: sourcePaths,
    beforeHash,
    afterHash,
    outputOracleContract,
  }));
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    backend: 'vulkan',
    confidence: 0.95,
    evidence_refs: evidenceRefs,
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: sourcePaths,
      artifact_kind: 'spirv',
      entry_points: ['main'],
      compile_target: 'vulkan-1.2-compute',
      compiler: 'glslang-or-equivalent-spirv-compiler',
      compiler_args_hash: sha256Text('vulkan-runtime-proof-spirv-compile-options'),
      supported_pipeline_scope: 'vulkan_declared_pipeline_visual',
    },
    artifact_hash_before: beforeHash,
    artifact_hash_after: afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['static:vulkan:descriptor-layout', 'runtime:vulkan:pipeline-layout'],
      notes: 'Descriptor and pipeline layouts are unchanged; command-buffer re-record and frame output proof remain required.',
    },
    abi_metadata: {
      args: [],
      descriptor_or_binding_layout: {
        set_layouts: ['set0.binding0.storage-image.rgba8'],
        descriptor_set_layout_hash: sha256Text('set0.binding0.storage-image.rgba8'),
      },
      workgroup_or_launch_shape: { work_dim: 2, global_work_size: [64, 64], local_work_size: [8, 8] },
      stream_or_queue_requirements: { queue: 'vulkan-graphics-or-compute-queue', fence_required: true },
      extractor_provenance: {
        source: 'vulkan_runtime_trace_and_spirv_layout',
        extractor: 'synthi-vulkan-runtime-proof',
        evidence_refs: ['runtime:vulkan:vkCreatePipelineLayout', 'runtime:vulkan:vkCmdDispatch'],
      },
    },
    firewall_evidence: {
      route: 'gpu_runtime_epoch_reload',
      evidence_source: 'vulkan_runtime_same_process_trace',
      evidence_refs: [`runtime:vulkan:process-continuity:${processId}`, 'runtime:vulkan:vkQueueSubmit'],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: processId,
      process_id_after: processId,
    },
    output_oracle_target: outputOracleContract,
    reload_mechanism: 'built_in',
    adapter_outcome: 'adapter_not_needed_builtin_reload',
    reload_evidence_refs: ['runtime:vulkan:vkCreateShaderModule', 'runtime:vulkan:vkCreateComputePipelines'],
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: processId,
      device_uuid: sha256Text('vulkan-self-check-device'),
      context_or_device_handle: 'VkDevice:self-check',
      queue_or_stream_handle: 'VkQueue:self-check',
      persistent_gpu_allocations: ['swapchain-framebuffer', 'readback-buffer'],
      engine_scene_handles: [],
      camera_state_hash: sha256Text('vulkan-fixed-camera'),
      swapchain_or_framebuffer_identity: 'VkImage:swapchain-framebuffer:self-check',
    },
    epoch_policy: {
      publish_mechanism: 'vkCreateShaderModule+vkCreateComputePipelines',
      dispatch_binding: 'vkCmdBindPipeline:epoch-2',
      retirement_mechanism: 'vkWaitForFences-before-destroy-old-pipeline',
    },
    epoch_retirement_proof: {
      value: 'frame_boundary_proven',
      evidence_refs: ['runtime:vulkan:vkWaitForFences', 'runtime:vulkan:vkDestroyPipeline'],
    },
    fission_report: {
      selected_island: 'vulkan-pipeline:main',
      selected_reason: 'verified_fission_contract',
      changed_sources: sourcePaths,
      included_dependencies: [],
      excluded_host_sources: [],
      artifact_hash_before: beforeHash,
      artifact_hash_after: afterHash,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: fissionVerifierEvidenceId,
      deterministic_verifier_evidence_refs: [
        fissionVerifierEvidenceId,
        'static:vulkan:descriptor-layout',
      ],
      selection_decision_hash: selectionDecisionHash,
      output_oracle_contract: outputOracleContract,
      smallest_safe_island_proven: true,
      evidence_refs: [
        fissionVerifierEvidenceId,
        'runtime:vulkan:vkCreatePipelineLayout',
        'runtime:vulkan:vkCreateComputePipelines',
      ],
    },
    vulkan_contract: {
      shader_module_hash_before: beforeHash,
      shader_module_hash_after: afterHash,
      entry_point: 'main',
      descriptor_set_layout_hash: sha256Text('set0.binding0.storage-image.rgba8'),
      pipeline_layout_hash: sha256Text('pipeline-layout:set0.storage-image'),
      pipeline_state_hash: afterHash,
      command_buffer_re_record_required: true,
      command_buffer_re_record_proven: true,
      frame_used_new_pipeline_trace: 'vkQueueSubmit:command-buffer-epoch-2:frame-2',
      supported_pipeline_scope: 'vulkan_declared_pipeline_visual',
      field_evidence_refs: fieldEvidenceRefs(vulkanFields, evidenceRefs),
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `vulkan-contract:${contract.contract_hash}`;
  return contract;
}

async function renderSelfCheckFrames(outDir) {
  const width = 384;
  const height = 256;
  const beforeSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#101827"/>
  <rect x="32" y="48" width="138" height="128" fill="#2563eb"/>
  <circle cx="256" cy="118" r="58" fill="#f97316"/>
  <text x="28" y="226" fill="#e5e7eb" font-family="Arial" font-size="20">Vulkan epoch 1</text>
</svg>`;
  const afterSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#101827"/>
  <rect x="32" y="48" width="138" height="128" fill="#14b8a6"/>
  <circle cx="256" cy="118" r="58" fill="#facc15"/>
  <text x="28" y="226" fill="#e5e7eb" font-family="Arial" font-size="20">Vulkan epoch 2</text>
</svg>`;
  const beforePath = path.join(outDir, 'vulkan-before-frame.png');
  const afterPath = path.join(outDir, 'vulkan-after-frame.png');
  const diffPath = path.join(outDir, 'vulkan-diff-frame.png');
  await sharp(Buffer.from(beforeSvg)).png().toFile(beforePath);
  await sharp(Buffer.from(afterSvg)).png().toFile(afterPath);
  const beforeRaw = await sharp(beforePath).raw().toBuffer({ resolveWithObject: true });
  const afterRaw = await sharp(afterPath).raw().toBuffer({ resolveWithObject: true });
  const diffRaw = Buffer.alloc(beforeRaw.data.length);
  let changedPixels = 0;
  let totalAbs = 0;
  for (let offset = 0; offset < beforeRaw.data.length; offset += beforeRaw.info.channels) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(Number(afterRaw.data[offset + channel]) - Number(beforeRaw.data[offset + channel]));
      totalAbs += delta;
      diffRaw[offset + channel] = Math.min(255, delta * 3);
      if (delta > 4) pixelChanged = true;
    }
    if (beforeRaw.info.channels === 4) diffRaw[offset + 3] = 255;
    if (pixelChanged) changedPixels += 1;
  }
  await sharp(diffRaw, {
    raw: { width, height, channels: beforeRaw.info.channels },
  }).png().toFile(diffPath);
  const beforeHash = await sha256File(beforePath);
  const afterHash = await sha256File(afterPath);
  const diffHash = await sha256File(diffPath);
  const pixelCount = width * height;
  return {
    width,
    height,
    beforePath,
    afterPath,
    diffPath,
    beforeHash,
    afterHash,
    diffHash,
    changedPixels,
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsDelta8bit: totalAbs / (pixelCount * 3),
    visiblePixelCount: changedPixels,
    perceptualDiff: totalAbs / (pixelCount * 3 * 255),
  };
}

function buildVisualOracleArtifacts({ frames, dispatchId, artifactHash, timestamp }) {
  const trace = `epoch=2 dispatch=${dispatchId} artifact=${artifactHash}`;
  return {
    before_image: relRepo(frames.beforePath),
    after_image: relRepo(frames.afterPath),
    diff_image: relRepo(frames.diffPath),
    before_image_hash: frames.beforeHash,
    after_image_hash: frames.afterHash,
    diff_image_hash: frames.diffHash,
    before_image_hash_verified: true,
    after_image_hash_verified: true,
    diff_image_hash_verified: true,
    pixel_metrics_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: trace,
    camera_state_hash: sha256Text('vulkan-fixed-camera'),
    swapchain_size: [frames.width, frames.height],
    capture_backend: 'vulkan_frame_readback',
    frame_number: 2,
    timestamp_after_dispatch: timestamp,
    perceptual_diff: frames.perceptualDiff,
    changed_pixel_ratio: frames.changedPixelRatio,
    visible_pixel_count: frames.visiblePixelCount,
    visual_pixel_verification: {
      metrics_verified: true,
      before_image_hash: frames.beforeHash,
      after_image_hash: frames.afterHash,
      diff_image_hash: frames.diffHash,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      changed_pixel_ratio: frames.changedPixelRatio,
      mean_abs_delta_8bit: frames.meanAbsDelta8bit,
      visible_pixel_count: frames.visiblePixelCount,
    },
  };
}

function buildLedgerRecord({ beforeHash, afterHash, contract, runMode, frames, timings, visualArtifacts }) {
  const dispatchId = 'vulkan-dispatch-epoch-2';
  const processId = 'pid:vulkan-self-check';
  const deterministicMode = deterministicVisualMode({ beforeHash: frames.beforeHash, afterHash: frames.afterHash });
  return {
    project_id: CFG.targetId,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    backend: 'vulkan',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contract.contract_hash,
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: 'vulkan-shader-module-epoch-2',
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timings.loaderTimestampNs,
      process_id: processId,
      source: 'vkCreateShaderModule',
    },
    epoch_publish_event: {
      id: 'vulkan-pipeline-publish-epoch-2',
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timings.publishTimestampNs,
      process_id: processId,
      dispatch_binding: 'vkCmdBindPipeline:epoch-2',
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timings.dispatchTimestampNs,
      process_id: processId,
      launch_api: 'vkQueueSubmit',
      command_buffer: 'VkCommandBuffer:epoch-2',
      pipeline: 'VkPipeline:epoch-2',
      command: 'vkCmdDispatch',
    },
    output_event: {
      id: 'vulkan-frame-output-epoch-2',
      kind: 'visual_frame_readback',
      passed: true,
      after_dispatch_id: dispatchId,
      artifact_hash: afterHash,
      epoch: '2',
      timestamp_monotonic_ns: timings.outputTimestampNs,
      process_id: processId,
      output_oracle: {
        kind: 'visual_oracle',
        oracle_artifacts: {
          visual_oracle_artifacts: visualArtifacts,
        },
      },
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: 'vulkan-retire-epoch-1',
      status: 'frame_boundary_proven',
      timestamp_monotonic_ns: timings.retirementTimestampNs,
      process_id: processId,
      retired_epoch: '1',
      evidence_refs: ['runtime:vulkan:vkWaitForFences', 'runtime:vulkan:vkDestroyPipeline'],
    },
    process_identity: {
      process_id: processId,
      host_pid: processId,
      same_process: true,
    },
    device_identity: {
      backend: 'vulkan',
      device_uuid: contract.state_preservation_checks.device_uuid,
      adapter_info: { backend: 'vulkan', deviceName: 'self-check-vulkan-device' },
      queue: 'VkQueue:self-check',
    },
    firewall_evidence: contract.firewall_evidence,
    output_oracle_target: contract.output_oracle_target,
    oracle_artifacts: {
      visual_oracle_artifacts: visualArtifacts,
    },
    deterministicVisualMode: deterministicMode,
    deterministic_visual_mode: deterministicMode,
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    timings,
    model_provenance: modelProvenance(),
    evidence_refs: [
      beforeHash,
      afterHash,
      frames.afterHash,
      `runtime:vulkan:dispatch:${dispatchId}`,
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
  };
}

function nativeVulkanApiEvidence() {
  const counts = {
    vkCreateShaderModule: 2,
    vkCreatePipelineLayout: 2,
    vkCreateComputePipelines: 2,
    vkAllocateCommandBuffers: 2,
    vkBeginCommandBuffer: 2,
    vkCmdBindPipeline: 2,
    vkCmdDispatch: 2,
    vkQueueSubmit: 2,
    vkWaitForFences: 2,
    vkMapMemory: 1,
  };
  return {
    accepted: true,
    required: Object.keys(counts),
    counts,
    failedGates: [],
    source: 'native_vulkan_runtime_trace',
  };
}

function negativeLayoutRefusal() {
  return {
    schemaVersion: 'synthi.gpu_hmr.vulkan_negative_layout_refusal.v1',
    refusalProven: true,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    abiCompatibilityClass: 'layout_changed',
    reasonCodes: ['descriptor_set_layout_changed', 'pipeline_layout_changed', 'command_buffer_re_record_required'],
    executableStaticCheck: {
      accepted: true,
      layoutChanged: true,
      pipelineLayoutChanged: true,
      negativeShaderFound: true,
      sourceAfterHash: sha256Text('vulkan-negative-layout-source'),
      acceptedLayoutHash: sha256Text('set0.binding0.storage-image.rgba8'),
      negativeLayoutHash: sha256Text('set0.binding0.storage-image+uniform-buffer'),
    },
  };
}

function runtimeProofArtifact({ beforeHash, afterHash, proofLedger, ledger, contract, contractEvaluation, contractConsistency, frames, visualArtifacts, nativeApiEvidence, runMode }) {
  const record = proofLedger.records?.[0] ?? {};
  const deterministicVisualModeEvaluation = evaluateGpuHmrDeterministicVisualMode(record.deterministicVisualMode);
  const proofLedgerSourceConsistency = {
    accepted: ledger.gpuHmrSuccess === true && ledger.failedInvariants.length === 0,
    mode: 'derived_only',
    source: 'vulkan_runtime_recomputed',
    proofLedgerId: proofLedger.proofId,
    proof_ledger_id: proofLedger.proofId,
    evidenceRefs: record.evidence_refs ?? [],
    evidence_refs: record.evidence_refs ?? [],
    failures: ledger.failedInvariants,
  };
  const visualThresholdValidation = {
    accepted: frames.changedPixelRatio > 0 && frames.meanAbsDelta8bit > 0 && frames.visiblePixelCount > 0,
    changedPixelRatio: frames.changedPixelRatio,
    meanAbsDelta8bit: frames.meanAbsDelta8bit,
    visiblePixelCount: frames.visiblePixelCount,
    failedGates: [
      frames.changedPixelRatio > 0 ? null : 'vulkan_visual_zero_changed_pixels',
      frames.meanAbsDelta8bit > 0 ? null : 'vulkan_visual_zero_mean_delta',
      frames.visiblePixelCount > 0 ? null : 'vulkan_visual_no_visible_pixels',
    ].filter(Boolean),
  };
  const limitationCodes = [
    ...ledger.failedInvariants.map((failure) => failure.code),
    ...contractEvaluation.failedGates.map((failure) => failure.code),
    ...contractConsistency.failedGates.map((failure) => failure.code),
    ...nativeApiEvidence.failedGates,
    ...visualThresholdValidation.failedGates,
    ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
    beforeHash !== afterHash ? null : 'vulkan_shader_module_hash_not_changed',
  ].filter(Boolean);
  const fullRuntimeProven =
    ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && contractEvaluation.accepted === true
    && contractConsistency.accepted === true
    && proofLedgerSourceConsistency.accepted === true
    && nativeApiEvidence.accepted === true
    && visualThresholdValidation.accepted === true
    && deterministicVisualModeEvaluation.accepted === true
    && beforeHash !== afterHash
    && limitationCodes.length === 0;
  const artifact = {
    schemaVersion: 'synthi.gpu.hmr.runtime_proof_artifact.v1',
    proofId: `vulkan-runtime-proof-artifact:${sha256Text(stableJson({
      proofLedgerId: proofLedger.proofId,
      contractHash: contract.contract_hash,
      artifactHashAfter: afterHash,
      afterImageHash: frames.afterHash,
    })).replace(/^sha256:/, '')}`,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    gpuHmrSuccess: fullRuntimeProven,
    gpu_hmr_success: fullRuntimeProven,
    stageResults: [
      { stageId: 'vulkan-shader-module', status: beforeHash !== afterHash ? 'passed' : 'failed', evidenceRefs: [beforeHash, afterHash] },
      { stageId: 'vulkan-pipeline-layout', status: nativeApiEvidence.counts.vkCreatePipelineLayout >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkCreatePipelineLayout'] },
      { stageId: 'vulkan-command-buffer-rerecord', status: nativeApiEvidence.counts.vkBeginCommandBuffer >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkBeginCommandBuffer'] },
      { stageId: 'vulkan-queue-submit-fence', status: nativeApiEvidence.counts.vkQueueSubmit >= 2 && nativeApiEvidence.counts.vkWaitForFences >= 2 ? 'passed' : 'failed', evidenceRefs: ['runtime:vulkan:vkQueueSubmit', 'runtime:vulkan:vkWaitForFences'] },
      { stageId: 'vulkan-visual-frame-oracle', status: visualThresholdValidation.accepted ? 'passed' : 'failed', evidenceRefs: [visualArtifacts.after_image_hash, visualArtifacts.diff_image_hash] },
      { stageId: 'vulkan-acceptance-contract', status: contractEvaluation.accepted && contractConsistency.accepted ? 'passed' : 'failed', evidenceRefs: [contract.contract_hash] },
    ],
    limitations: fullRuntimeProven ? [] : limitationCodes.map((code) => ({ code })),
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    acceptanceContract: contract,
    acceptance_contract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptance_contract_evaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
    acceptance_contract_consistency: contractConsistency,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    deterministicVisualMode: record.deterministicVisualMode,
    deterministic_visual_mode: record.deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    nativeVulkanApiEvidence: nativeApiEvidence,
    native_vulkan_api_evidence: nativeApiEvidence,
    visualThresholdValidation,
    visual_threshold_validation: visualThresholdValidation,
    runMode,
    run_mode: runMode,
  };
  artifact.strictGate = runtimeProofArtifactStrictGate(artifact);
  artifact.strict_gate = artifact.strictGate;
  return artifact;
}

async function buildAcceptedSelfCheckProof(outDir) {
  await mkdir(outDir, { recursive: true });
  const beforeHash = sha256Text('vulkan-before-spirv');
  const afterHash = sha256Text('vulkan-after-spirv');
  const runMode = runModeFor({ afterHash });
  const frames = await renderSelfCheckFrames(outDir);
  const timings = {
    metric_clock: 'monotonic_ns',
    metric_scope: runMode.metric_scope,
    cache_state: runMode.cache_state,
    edit_id: runMode.edit_id,
    edit_hash: runMode.edit_hash,
    edit_kind: runMode.edit_kind,
    different_edit: runMode.different_edit,
    static_discovery_time: 1,
    ai_contract_synthesis_time: 0,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 0,
    device_compile_wall_time: 100,
    artifact_load_time: 20,
    epoch_publish_time: 20,
    dispatch_trace_time: 20,
    runtime_probe_time: 100,
    oracle_analysis_time: 100,
    trigger_to_visible_time: 260,
    screenshot_capture_time: 20,
    dispatch_to_output_proof_time: 20,
    total_validator_wall_time: 360,
    loaderTimestampNs: 10,
    publishTimestampNs: 20,
    dispatchTimestampNs: 30,
    outputTimestampNs: 40,
    retirementTimestampNs: 50,
  };
  const contract = buildContract({ beforeHash, afterHash, runMode });
  const visualArtifacts = buildVisualOracleArtifacts({
    frames,
    dispatchId: 'vulkan-dispatch-epoch-2',
    artifactHash: afterHash,
    timestamp: timings.outputTimestampNs,
  });
  const ledgerRecord = buildLedgerRecord({ beforeHash, afterHash, contract, runMode, frames, timings, visualArtifacts });
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
  const ledger = queryGpuHmrLedgerInvariants(proofLedger);
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({ before: contract, after: contract });
  const nativeApiEvidence = nativeVulkanApiEvidence();
  const artifact = runtimeProofArtifact({
    beforeHash,
    afterHash,
    proofLedger,
    ledger,
    contract,
    contractEvaluation,
    contractConsistency,
    frames,
    visualArtifacts,
    nativeApiEvidence,
    runMode,
  });
  return {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
    backend: 'vulkan',
    resultState: artifact.gpuHmrSuccess ? 'gpu-hmr-full-runtime-proven' : 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: artifact.gpuHmrSuccess === true,
    gpuHmrSuccess: artifact.gpuHmrSuccess === true,
    acceptedForGpuHmr: artifact.gpuHmrSuccess === true,
    proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
      proofLedgerId: proofLedger.proofId,
      runtimeProofArtifactId: artifact.proofId,
      afterHash,
      afterImageHash: frames.afterHash,
    })).digest('hex')}`,
    compiler: {
      beforeShaderModuleHash: beforeHash,
      before_shader_module_hash: beforeHash,
      afterShaderModuleHash: afterHash,
      after_shader_module_hash: afterHash,
    },
    contract,
    acceptanceContract: contract,
    acceptance_contract: contract,
    contractEvaluation,
    contract_evaluation: contractEvaluation,
    proofLedger,
    proof_ledger: proofLedger,
    ledger,
    proofLedgerQuery: ledger,
    proof_ledger_query: ledger,
    runtimeProofArtifact: artifact,
    runtime_proof_artifact: artifact,
    visualOracleArtifacts: visualArtifacts,
    visual_oracle_artifacts: visualArtifacts,
    visualThresholdValidation: artifact.visualThresholdValidation,
    visual_threshold_validation: artifact.visualThresholdValidation,
    deterministicVisualMode: ledgerRecord.deterministicVisualMode,
    deterministic_visual_mode: ledgerRecord.deterministicVisualMode,
    nativeVulkanApiEvidence: nativeApiEvidence,
    native_vulkan_api_evidence: nativeApiEvidence,
    negativeLayoutRefusal: negativeLayoutRefusal(),
    negative_layout_refusal: negativeLayoutRefusal(),
    timings,
    runMode,
    run_mode: runMode,
    limitations: artifact.gpuHmrSuccess ? [] : artifact.limitations,
  };
}

async function buildLiveRefusal(outDir) {
  await mkdir(outDir, { recursive: true });
  const preflight = await vulkanRuntimePreflight();
  const proof = {
    schemaVersion: SCHEMA,
    schema: SCHEMA,
    targetId: CFG.targetId,
    profile: { id: CFG.targetId, targetId: CFG.targetId, validationScope: 'vulkan_declared_pipeline_visual' },
    backend: 'vulkan',
    proofId: `vulkan-runtime-proof:sha256:${createHash('sha256').update(stableJson({
      targetId: CFG.targetId,
      unsupportedReasons: preflight.unsupportedReasons,
      slug: CFG.slug,
    })).digest('hex')}`,
    resultState: 'gpu-hmr-runtime-proof-rejected',
    fullRuntimeProven: false,
    gpuHmrSuccess: false,
    acceptedForGpuHmr: false,
    vulkanRuntimePreflight: {
      accepted: preflight.accepted,
      unsupportedReasons: preflight.unsupportedReasons,
      unsupported_reasons: preflight.unsupportedReasons,
      libraries: preflight.libraries,
      icdFiles: preflight.icdFiles,
      icd_files: preflight.icdFiles,
      icdLibraries: preflight.icdLibraries,
      icd_libraries: preflight.icdLibraries,
      vulkaninfoPath: preflight.vulkaninfoPath || null,
      vulkaninfo_path: preflight.vulkaninfoPath || null,
      vulkaninfoSummary: preflight.vulkaninfoSummary,
      vulkaninfo_summary: preflight.vulkaninfoSummary,
    },
    limitations: preflight.unsupportedReasons.map((code) => ({ code })),
  };
  if (preflight.accepted) {
    proof.limitations.push({ code: 'vulkan_runtime_probe_not_implemented_for_live_success' });
  }
  const proofPath = path.join(outDir, `${safeSlug(CFG.targetId)}-vulkan-runtime-rejected.json`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return { proof, proofPath };
}

async function selfCheck() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'synthi-vulkan-runtime-self-check-'));
  const proof = await buildAcceptedSelfCheckProof(tmp);
  if (proof.runtimeProofArtifact?.gpuHmrSuccess !== true) {
    throw new Error(`self-check strict artifact rejected: ${JSON.stringify({
      strictGate: proof.runtimeProofArtifact?.strictGate,
      ledger: proof.ledger,
      contractEvaluation: proof.contractEvaluation,
      limitations: proof.runtimeProofArtifact?.limitations,
    }, null, 2)}`);
  }
  const proofPath = path.join(tmp, 'vulkan-runtime-proof.json');
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  const matrix = await collectGpuHmrValidationMatrixLedger({
    repoRoot: REPO_ROOT,
    mcpRoot: MCP_ROOT,
    roots: [tmp],
    latestPerTarget: false,
    includeUnproven: true,
    generatedAt: '2026-06-30T00:00:00.000Z',
  });
  const row = matrix.rows.find((entry) => entry.targetId === CFG.targetId && entry.backend === 'vulkan');
  if (!row || row.matrixOutcome !== 'full_runtime_gpu_hmr' || row.acceptanceScope !== 'vulkan_declared_pipeline_visual') {
    throw new Error(`self-check matrix row rejected: ${JSON.stringify({
      openGaps: row?.openGaps,
      reasons: row?.reasons,
      ledger: row?.ledger,
      runtimeProofArtifact: row?.runtimeProofArtifact,
      declaredScopeEvidence: row?.declaredScopeEvidence,
      nativeVulkanApiEvidence: row?.nativeVulkanApiEvidence,
      negativeLayoutRefusalAccepted: row?.negativeLayoutRefusalAccepted,
    }, null, 2)}`);
  }
  const forged = JSON.parse(JSON.stringify(proof));
  const forgedAfterHash = sha256Text('forged-after-frame');
  const corruptVisualArtifacts = (value) => {
    if (value && typeof value === 'object') {
      value.after_image_hash = forgedAfterHash;
      value.afterImageHash = forgedAfterHash;
    }
  };
  forged.proofId = 'vulkan-runtime-proof:sha256:forged';
  corruptVisualArtifacts(forged.visualOracleArtifacts);
  corruptVisualArtifacts(forged.visual_oracle_artifacts);
  const forgedRecord = forged.proofLedger?.records?.[0];
  corruptVisualArtifacts(forgedRecord?.oracle_artifacts?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.oracleArtifacts?.visualOracleArtifacts);
  corruptVisualArtifacts(forgedRecord?.output_event?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.outputEvent?.visualOracleArtifacts);
  corruptVisualArtifacts(forgedRecord?.output_event?.output_oracle?.oracle_artifacts?.visual_oracle_artifacts);
  corruptVisualArtifacts(forgedRecord?.outputEvent?.outputOracle?.oracleArtifacts?.visualOracleArtifacts);
  await writeFile(path.join(tmp, 'vulkan-runtime-proof-forged.json'), `${JSON.stringify(forged, null, 2)}\n`);
  const forgedMatrix = await collectGpuHmrValidationMatrixLedger({
    repoRoot: REPO_ROOT,
    mcpRoot: MCP_ROOT,
    roots: [tmp],
    latestPerTarget: false,
    includeUnproven: true,
    generatedAt: '2026-06-30T00:00:00.000Z',
  });
  const forgedRow = forgedMatrix.rows.find((entry) => entry.proofIds?.includes('vulkan-runtime-proof:sha256:forged'));
  if (forgedRow?.matrixOutcome === 'full_runtime_gpu_hmr') {
    throw new Error('forged Vulkan visual frame hash was accepted');
  }
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: SCHEMA,
    proofId: proof.proofId,
    matrixProofId: matrix.proofId,
    rowId: row.rowId,
    forgedRejected: true,
  }, null, 2));
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await selfCheck();
    return;
  }
  const outDir = path.join(ARTIFACT_DIR, CFG.slug);
  const { proof, proofPath } = await buildLiveRefusal(outDir);
  console.log(JSON.stringify({
    ok: proof.gpuHmrSuccess === true,
    schemaVersion: SCHEMA,
    proofId: proof.proofId,
    resultState: proof.resultState,
    fullRuntimeProven: proof.fullRuntimeProven,
    gpuHmrSuccess: proof.gpuHmrSuccess,
    proofPath,
    limitations: proof.limitations,
  }, null, 2));
}

await main();
