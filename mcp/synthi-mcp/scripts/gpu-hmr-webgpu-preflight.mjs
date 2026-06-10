#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight');
const SCHEMA = 'synthi.gpu_hmr.webgpu_preflight.v1';

function nowSlugDate() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

const CFG = {
  slug: process.env.SLUG ?? `webgpu-preflight-${nowSlugDate()}`,
  browserExecutable: process.env.SYNTHI_WEBGPU_BROWSER_EXECUTABLE ?? '',
  timeoutMs: Number(process.env.SYNTHI_WEBGPU_PREFLIGHT_TIMEOUT_MS ?? 60000),
  seed: process.env.SYNTHI_WEBGPU_PREFLIGHT_SEED ?? '12345',
};

const WEBGPU_LAUNCH_ARGS = Object.freeze([
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-features=Vulkan,WebGPU,UseSkiaRenderer',
  '--disable-gpu-sandbox',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function safeSlug(value) {
  return String(value || 'webgpu-preflight').replace(/[^a-zA-Z0-9_.-]+/g, '-');
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

function diagnosticHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Synthi WebGPU Preflight</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #080a0f; color: #eef3ff; font: 14px system-ui, sans-serif; }
    body { display: grid; place-items: center; }
    main { width: 640px; }
    canvas { width: 640px; height: 360px; display: block; background: #111827; }
    pre { margin: 12px 0 0; white-space: pre-wrap; color: #b7c4dc; }
  </style>
</head>
<body>
  <main>
    <canvas width="640" height="360"></canvas>
    <pre id="status">starting</pre>
  </main>
  <script>
    async function run() {
      const status = document.getElementById('status');
      const result = {
        isSecureContext: window.isSecureContext,
        hasNavigatorGpu: Boolean(navigator.gpu),
        adapterFound: false,
        deviceCreated: false,
        renderSubmitted: false,
        preferredCanvasFormat: null,
        adapterInfo: null,
        features: [],
        limits: {},
        error: null,
      };
      try {
        if (!navigator.gpu) {
          throw new Error('navigator.gpu missing');
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        result.adapterFound = Boolean(adapter);
        if (!adapter) {
          throw new Error('requestAdapter returned null');
        }
        result.features = Array.from(adapter.features || []).sort();
        result.limits = {
          maxTextureDimension2D: adapter.limits?.maxTextureDimension2D ?? null,
          maxComputeWorkgroupSizeX: adapter.limits?.maxComputeWorkgroupSizeX ?? null,
        };
        const info = adapter.info || (
          typeof adapter.requestAdapterInfo === 'function'
            ? await adapter.requestAdapterInfo()
            : null
        );
        if (info) {
          result.adapterInfo = {
            vendor: info.vendor || '',
            architecture: info.architecture || '',
            device: info.device || '',
            description: info.description || '',
          };
        }
        const device = await adapter.requestDevice();
        result.deviceCreated = Boolean(device);
        const canvas = document.querySelector('canvas');
        const context = canvas.getContext('webgpu');
        const format = navigator.gpu.getPreferredCanvasFormat();
        result.preferredCanvasFormat = format;
        context.configure({ device, format, alphaMode: 'opaque' });
        const module = device.createShaderModule({
          code: \`
            @vertex
            fn vs(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4f {
              var positions = array<vec2f, 3>(
                vec2f(-0.72, -0.58),
                vec2f(0.72, -0.58),
                vec2f(0.0, 0.66)
              );
              let xy = positions[vertexIndex];
              return vec4f(xy, 0.0, 1.0);
            }

            @fragment
            fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
              let uv = pos.xy / vec2f(640.0, 360.0);
              return vec4f(0.20 + uv.x * 0.65, 0.35 + uv.y * 0.40, 0.92, 1.0);
            }
          \`,
        });
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        result.renderSubmitted = true;
        device.destroy();
      } catch (error) {
        result.error = String(error && error.message ? error.message : error);
      }
      status.textContent = JSON.stringify(result, null, 2);
      window.__synthiWebGpuPreflight = result;
    }
    run();
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

async function runBrowserProbe(browserExecutable, screenshotPath) {
  const { server, url } = await startServer(diagnosticHtml());
  let browser;
  const started = performance.now();
  try {
    browser = await chromium.launch({
      executablePath: browserExecutable,
      headless: true,
      args: WEBGPU_LAUNCH_ARGS,
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 440 } });
    await page.goto(url, { waitUntil: 'load', timeout: CFG.timeoutMs });
    await page.waitForFunction(() => Boolean(window.__synthiWebGpuPreflight), null, {
      timeout: CFG.timeoutMs,
    });
    const result = await page.evaluate(() => window.__synthiWebGpuPreflight);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return {
      launched: true,
      durationMs: Number((performance.now() - started).toFixed(3)),
      url,
      result,
      screenshotPath,
      error: null,
    };
  } catch (error) {
    return {
      launched: Boolean(browser),
      durationMs: Number((performance.now() - started).toFixed(3)),
      url,
      result: null,
      screenshotPath: null,
      error: String(error && error.message ? error.message : error),
    };
  } finally {
    try { await browser?.close(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
}

function classifyWebGpuPreflight({ browserExecutable, probe }) {
  const unsupportedReasons = [];
  if (!browserExecutable) unsupportedReasons.push('browser_executable_missing');
  if (browserExecutable && !probe?.launched) unsupportedReasons.push('browser_launch_failed');
  const result = probe?.result ?? {};
  if (probe?.launched && result.isSecureContext !== true) unsupportedReasons.push('secure_context_missing');
  if (probe?.launched && result.hasNavigatorGpu !== true) unsupportedReasons.push('navigator_gpu_missing');
  if (probe?.launched && result.adapterFound !== true) unsupportedReasons.push('webgpu_adapter_missing');
  if (probe?.launched && result.deviceCreated !== true) unsupportedReasons.push('webgpu_device_creation_failed');
  if (probe?.launched && result.renderSubmitted !== true) unsupportedReasons.push('webgpu_render_submit_failed');
  return {
    webgpuAccepted: unsupportedReasons.length === 0,
    resultState: unsupportedReasons.length === 0
      ? 'webgpu-runtime-preflight-accepted'
      : 'webgpu-runtime-rejected',
    unsupportedReasons,
  };
}

async function buildProof() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const browserExecutable = findBrowserExecutable();
  const screenshotPath = path.join(ARTIFACT_DIR, `${safeSlug(CFG.slug)}-diagnostic.png`);
  const probe = browserExecutable
    ? await runBrowserProbe(browserExecutable, screenshotPath)
    : {
      launched: false,
      durationMs: 0,
      url: null,
      result: null,
      screenshotPath: null,
      error: 'browser executable missing',
    };
  const classification = classifyWebGpuPreflight({ browserExecutable, probe });
  const proof = {
    schema: SCHEMA,
    slug: CFG.slug,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((performance.now() - started).toFixed(3)),
    seed: CFG.seed,
    browser: {
      executable: browserExecutable,
      candidateExecutables: candidateBrowserExecutables(),
      launchArgs: WEBGPU_LAUNCH_ARGS,
    },
    probe,
    classification: {
      webgpuAccepted: classification.webgpuAccepted,
      resultState: classification.resultState,
      unsupportedReasons: classification.unsupportedReasons,
      adapterInfo: probe.result?.adapterInfo ?? null,
      features: probe.result?.features ?? [],
      limits: probe.result?.limits ?? {},
      preferredCanvasFormat: probe.result?.preferredCanvasFormat ?? null,
      diagnosticScreenshot: probe.screenshotPath,
    },
    acceptance: {
      acceptedForWebGpuRuntimePreflight: classification.webgpuAccepted,
      acceptedForWebGpuPipelineProof: false,
      gpuHmrSuccess: false,
      reason: classification.webgpuAccepted
        ? 'preflight_only_shader_module_pipeline_and_frame_oracle_still_required'
        : 'runtime_preflight_rejected',
      shaderModuleEpochRequired: true,
      bindGroupLayoutProofRequired: true,
      pipelineLayoutProofRequired: true,
      pipelineRecreateProofRequired: true,
      frameOutputOracleRequired: true,
      noShimApplied: true,
      noBrowserFlagClaimedAsHmr: true,
    },
  };
  proof.proofId = `webgpu-preflight-proof:${sha256Text(canonicalJson(proof))}`;
  return proof;
}

async function writeProof(proof) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const proofPath = path.join(ARTIFACT_DIR, `${safeSlug(CFG.slug)}-proof.json`);
  const summaryPath = path.join(ARTIFACT_DIR, `${safeSlug(CFG.slug)}-summary.txt`);
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  await writeFile(summaryPath, [
    `proof_id=${proof.proofId}`,
    `result_state=${proof.classification.resultState}`,
    `webgpu_accepted=${proof.classification.webgpuAccepted}`,
    `browser=${proof.browser.executable || 'none'}`,
    `browser_launch_args=${proof.browser.launchArgs.join(' ')}`,
    `adapter=${JSON.stringify(proof.classification.adapterInfo)}`,
    `preferred_canvas_format=${proof.classification.preferredCanvasFormat || 'unknown'}`,
    `features=${proof.classification.features.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `diagnostic_screenshot=${proof.classification.diagnosticScreenshot || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_browser_flag_claimed_as_hmr=${proof.acceptance.noBrowserFlagClaimedAsHmr}`,
    '',
  ].join('\n'));
  return { proofPath, summaryPath };
}

function selfCheck() {
  const accepted = classifyWebGpuPreflight({
    browserExecutable: 'chrome',
    probe: {
      launched: true,
      result: {
        isSecureContext: true,
        hasNavigatorGpu: true,
        adapterFound: true,
        deviceCreated: true,
        renderSubmitted: true,
      },
    },
  });
  const rejectedNoGpu = classifyWebGpuPreflight({
    browserExecutable: 'chrome',
    probe: {
      launched: true,
      result: {
        isSecureContext: true,
        hasNavigatorGpu: false,
        adapterFound: false,
        deviceCreated: false,
        renderSubmitted: false,
      },
    },
  });
  const rejectedNoBrowser = classifyWebGpuPreflight({
    browserExecutable: null,
    probe: { launched: false, result: null },
  });
  if (!accepted.webgpuAccepted || accepted.resultState !== 'webgpu-runtime-preflight-accepted') {
    throw new Error('WebGPU preflight self-check failed accepted case');
  }
  if (
    rejectedNoGpu.webgpuAccepted
    || !rejectedNoGpu.unsupportedReasons.includes('navigator_gpu_missing')
  ) {
    throw new Error('WebGPU preflight self-check failed navigator.gpu case');
  }
  if (
    rejectedNoBrowser.webgpuAccepted
    || !rejectedNoBrowser.unsupportedReasons.includes('browser_executable_missing')
  ) {
    throw new Error('WebGPU preflight self-check failed missing browser case');
  }
  console.log('[ok] WebGPU preflight self-check passed');
}

if (process.argv.includes('--self-check')) {
  try {
    selfCheck();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
} else {
  try {
    const proof = await buildProof();
    const { proofPath, summaryPath } = await writeProof(proof);
    console.log(`proof_id=${proof.proofId}`);
    console.log(`result_state=${proof.classification.resultState}`);
    console.log(`webgpu_accepted=${proof.classification.webgpuAccepted}`);
    console.log(`proof_json=${proofPath}`);
    console.log(`summary_txt=${summaryPath}`);
    if (proof.classification.diagnosticScreenshot) {
      console.log(`diagnostic_screenshot=${proof.classification.diagnosticScreenshot}`);
    }
    if (!proof.classification.webgpuAccepted) {
      console.log(`unsupported_reasons=${proof.classification.unsupportedReasons.join(',')}`);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
