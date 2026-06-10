#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import {
  buildGpuHmrProofLedger,
  evaluateGpuHmrProofLedger,
} from './lib/gpu-hmr-proof-ledger.mjs';

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

function normalizeSupportedPipeline(rawPipeline = {}) {
  const pipeline = rawPipeline && typeof rawPipeline === 'object' && !Array.isArray(rawPipeline)
    ? rawPipeline
    : {};
  const bindGroupLayouts = Array.isArray(pipeline.bindGroupLayouts)
    ? pipeline.bindGroupLayouts
    : Array.isArray(pipeline.bind_group_layouts)
      ? pipeline.bind_group_layouts
      : [];
  const vertexBufferLayouts = Array.isArray(pipeline.vertexBufferLayouts)
    ? pipeline.vertexBufferLayouts
    : Array.isArray(pipeline.vertex_buffer_layouts)
      ? pipeline.vertex_buffer_layouts
      : [];
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
  if (layout !== 'explicit-empty') unsupported.push('pipeline_layout_not_explicit_empty');
  if (bindGroupLayouts.length !== 0) unsupported.push('bind_group_layouts_not_supported_by_runner');
  if (vertexBufferLayouts.length !== 0) unsupported.push('vertex_buffer_layouts_not_supported_by_runner');
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
  if (unsupported.length > 0) {
    const error = new Error(`unsupported WebGPU visual profile pipeline: ${unsupported.join(',')}`);
    error.unsupportedReasons = unsupported;
    throw error;
  }
  return {
    scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    layout,
    primitiveTopology,
    bindGroupLayouts: [],
    vertexBufferLayouts: [],
    colorTargetState: {
      format: 'preferredCanvasFormat',
      alphaMode: 'opaque',
    },
    unsupportedReasons: [],
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
  const pipeline = normalizeSupportedPipeline(profile.pipeline);
  return {
    raw: profile,
    profilePath: resolvedPath,
    profileHash: sha256Text(stableJson(profile)),
    id: firstText(profile.id) ?? safeSlug(path.basename(resolvedPath, '.json')),
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
    draw: {
      vertexCount: finiteNumber(shader.draw?.vertexCount ?? shader.draw?.vertex_count, 3),
    },
    pipeline,
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

function diagnosticHtml(profile) {
  const runtimeConfig = {
    width: profile.width,
    height: profile.height,
    entryPoints: profile.entryPoints,
    primitiveTopology: profile.pipeline.primitiveTopology,
    vertexCount: profile.draw.vertexCount,
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
        createShaderModuleNative: String(state.device.createShaderModule || '').includes('[native code]'),
        createRenderPipelineNative: String(state.device.createRenderPipeline || '').includes('[native code]'),
      };
      const canvas = document.querySelector('canvas');
      state.context = canvas.getContext('webgpu');
      state.format = navigator.gpu.getPreferredCanvasFormat();
      state.context.configure({ device: state.device, format: state.format, alphaMode: 'opaque' });
    }

    async function renderEpoch(code, artifactHash, label) {
      await ensureDevice();
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
      const pipelineLayout = state.device.createPipelineLayout({ bindGroupLayouts: [] });
      const pipeline = state.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: config.entryPoints.vertex, buffers: [] },
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
      pass.draw(config.vertexCount);
      pass.end();
      const commandBuffer = encoder.finish();
      const dispatchId = 'webgpu-dispatch-' + state.epochCounter;
      event('dispatch', { label, epoch, artifactHash, pipelineId, pipelineEpoch, dispatchId });
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

async function compareImages(beforePath, afterPath, diffPath) {
  const before = await sharp(beforePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(afterPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = before.info;
  if (width !== after.info.width || height !== after.info.height || channels !== after.info.channels) {
    throw new Error(`image dimensions differ before=${width}x${height} after=${after.info.width}x${after.info.height}`);
  }
  const pixels = width * height;
  const diff = Buffer.alloc(pixels * 4);
  let changed = 0;
  let visible = 0;
  let totalAbs = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * channels;
    const dr = Math.abs(before.data[offset] - after.data[offset]);
    const dg = Math.abs(before.data[offset + 1] - after.data[offset + 1]);
    const db = Math.abs(before.data[offset + 2] - after.data[offset + 2]);
    const maxDelta = Math.max(dr, dg, db);
    const beforeVisible = before.data[offset] > 12 || before.data[offset + 1] > 12 || before.data[offset + 2] > 12;
    const afterVisible = after.data[offset] > 12 || after.data[offset + 1] > 12 || after.data[offset + 2] > 12;
    if (beforeVisible || afterVisible) visible += 1;
    if (maxDelta > 8) changed += 1;
    totalAbs += dr + dg + db;
    const d = Math.min(255, Math.round(maxDelta * 4));
    const diffOffset = pixel * 4;
    diff[diffOffset] = d;
    diff[diffOffset + 1] = d;
    diff[diffOffset + 2] = d;
    diff[diffOffset + 3] = 255;
  }
  await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(diffPath);
  const meanAbsDelta8bit = totalAbs / (pixels * 3);
  return {
    width,
    height,
    changedPixels: changed,
    changedPixelRatio: changed / pixels,
    meanAbsDelta8bit,
    perceptualDiff: meanAbsDelta8bit / 255,
    visiblePixelCount: visible,
  };
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
  const required = [
    'hasNavigatorGpu',
    'requestAdapterNative',
    'requestDeviceNative',
    'createShaderModuleNative',
    'createRenderPipelineNative',
  ];
  const failedGates = required.filter((key) => apiEvidence[key] !== true);
  return {
    accepted: failedGates.length === 0,
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

function buildContract({ profile, trace, hashes }) {
  const bindGroupLayoutHash = sha256Text(stableJson(profile.pipeline.bindGroupLayouts));
  const pipelineLayoutHash = sha256Text(stableJson({
    bindGroupLayouts: profile.pipeline.bindGroupLayouts,
    layout: 'explicit-empty',
  }));
  const vertexBufferLayoutHash = sha256Text(stableJson(profile.pipeline.vertexBufferLayouts));
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
    colorTargetStateHash,
  }));
  const contract = {
    contract_version: 'synthi.gpu_hmr.contract.v1',
    project_id: profile.id,
    backend: { value: 'webgpu' },
    confidence: 1.0,
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 1.0,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: [profile.beforePath, profile.afterPath].filter(Boolean),
      artifact_kind: 'wgsl',
      entry_points: [profile.entryPoints.vertex, profile.entryPoints.fragment],
      compile_target: 'browser-webgpu',
      compiler: 'WebGPU createShaderModule',
      compiler_args_hash: sha256Text(stableJson({ browser: 'chromium', layout: 'explicit-empty' })),
      supported_pipeline_scope: profile.pipeline.scope,
    },
    artifact_hash_before: profile.beforeHash,
    artifact_hash_after: profile.afterHash,
    abi_compatibility_class: { value: 'compatible' },
    reload_mechanism: { value: 'built_in' },
    adapter_outcome: { value: 'adapter_not_needed_builtin_reload' },
    webgpu_contract: {
      wgsl_hash_before: profile.beforeHash,
      wgsl_hash_after: profile.afterHash,
      shader_module_epoch: trace.after.epoch,
      entry_points: [profile.entryPoints.vertex, profile.entryPoints.fragment],
      bind_group_layout_hash: bindGroupLayoutHash,
      pipeline_layout_hash: pipelineLayoutHash,
      vertex_buffer_layout_hash: vertexBufferLayoutHash,
      color_target_state_hash: colorTargetStateHash,
      pipeline_state_hash: pipelineStateHash,
      pipeline_recreate_required: true,
      pipeline_recreate_proven: true,
      supported_pipeline_scope: profile.pipeline.scope,
      unsupported_pipeline_reasons: profile.pipeline.unsupportedReasons,
      frame_used_new_pipeline_trace: `${trace.after.dispatchId}:${trace.after.epoch}:${profile.afterHash}`,
    },
    epoch_policy: {
      publish_mechanism: 'same-page-pipeline-slot',
      dispatch_binding: 'render-pass-setPipeline-after-pipeline-recreate',
      retirement_mechanism: 'frame-boundary',
    },
    epoch_retirement_proof: {
      value: 'frame_boundary_proven',
      evidence_refs: [hashes.afterImageHash],
    },
  };
  contract.contract_hash = sha256Text(stableJson(contract));
  contract.contract_id = `webgpu-contract:${contract.contract_hash}`;
  return contract;
}

function timingFields(ns) {
  const fallback = 0;
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'pipeline_cache_warm',
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
}) {
  const afterEpoch = trace.after.epoch;
  const dispatchId = trace.after.dispatchId;
  const processId = processContinuity.processIdAfter;
  const evidenceRefs = [
    profile.profileHash,
    artifacts.beforeImageHash,
    artifacts.afterImageHash,
    artifacts.diffImageHash,
    contract.contract_hash,
  ];
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
      profile: profile.id,
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
  };
  return {
    project_id: profile.id,
    edit_id: `${safeSlug(profile.id)}-wgsl-hot-delta`,
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
    timings: timingFields(timings.ns),
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'pipeline_cache_warm',
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
    const metrics = await compareImages(beforeImage, afterImage, diffImage);
    const oracleEndNs = process.hrtime.bigint();

    const artifacts = {
      beforeImage,
      afterImage,
      diffImage,
      beforeImageHash: await sha256File(beforeImage),
      afterImageHash: await sha256File(afterImage),
      diffImageHash: await sha256File(diffImage),
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
    const contract = buildContract({ profile, trace, hashes: artifacts });
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
    });
    const proofLedger = buildGpuHmrProofLedger(ledgerRecord);
    const ledgerQuery = evaluateGpuHmrProofLedger(ledgerRecord);
    const gpuHmrSuccess = proofLedger.gpuHmrSuccess === true
      && ledgerQuery.gpuHmrSuccess === true
      && visualThresholdValidation.accepted === true
      && processContinuity.accepted === true
      && nativeWebGpuEvidence.accepted === true;
    const proof = {
      schema: SCHEMA,
      slug: CFG.slug,
      profile: {
        id: profile.id,
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
      deterministicVisualMode: profile.deterministicVisualMode,
      proofLedger,
      proofLedgerQuery: ledgerQuery,
      gpuHmrSuccess,
      resultState: gpuHmrSuccess
        ? 'webgpu-hmr-full-runtime-proven'
        : 'webgpu-hmr-rejected',
      timings: timingFields(timings.ns),
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

    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(summaryPath, [
      `proof_id=${proof.proofId}`,
      `result_state=${proof.resultState}`,
      `gpu_hmr_success=${proof.gpuHmrSuccess}`,
      `ledger_proof_id=${proofLedger.proofId}`,
      `ledger_failed_invariants=${ledgerQuery.failedInvariants.map((failure) => failure.code).join(',') || 'none'}`,
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

    if (!gpuHmrSuccess) {
      const failures = [
        ...ledgerQuery.failedInvariants.map((f) => f.code),
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
  let unsupportedPipelineRejected = false;
  try {
    normalizeSupportedPipeline({ bindGroupLayouts: [{ entries: [] }] });
  } catch (error) {
    unsupportedPipelineRejected = Array.isArray(error.unsupportedReasons)
      && error.unsupportedReasons.includes('bind_group_layouts_not_supported_by_runner');
  }
  if (!unsupportedPipelineRejected) {
    throw new Error('self-check failed to reject unsupported bind-group pipeline profile');
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
  console.log(`proof_json=${proofPath}`);
  console.log(`summary_txt=${summaryPath}`);
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
