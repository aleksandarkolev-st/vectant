#!/usr/bin/env node
// Full-path GPU-HMR validation:
//   normal user source -> agent GPU split -> generated device edit -> GPU HMR.
//
// This differs from gpu-hmr-dynamic-workspace-test.mjs, which starts from an
// already-adapted project. Here the seeded source intentionally contains no
// Synthi ABI exports such as core_on_update/device_on_load.
//
// Run:
//   cd mcp/synthi-mcp
//   SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=auto node scripts/gpu-hmr-agent-split-workspace-test.mjs

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  mcpFrameAtOrAfterFrameGate,
  mcpFrameGateSatisfiedByScreenshot,
  mcpScreenshotArgsForFrameGate,
  mcpScreenshotMetadataFromToolResult,
} from './lib/gpu-hmr-visual-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  slug: process.env.SLUG ?? `gpu-agent-split-${Date.now()}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-agent-split-test',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 180000),
  hotSwapTimeoutMs: Number(process.env.SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS ?? 15000),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 240000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  frameGateTimeoutMs: Number(process.env.SYNTHI_GPU_AGENT_FRAME_GATE_TIMEOUT_MS ?? 1200000),
  workerContainer: process.env.WORKER_CONTAINER ?? 'synthi-ide-worker-1',
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  mcpVisionBackend: process.env.SYNTHI_MCP_VISION_BACKEND
    ?? ((process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY) ? 'gemini_api' : 'agent_side'),
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? process.env.SYNTHI_GPU_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuSplitModel: process.env.SYNTHI_GPU_SPLIT_MODEL
    ?? process.env.SYNTHI_GEMINI_MODEL
    ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GPU_DELTA_MODEL
    ?? process.env.SYNTHI_GEMINI_DELTA_MODEL
    ?? 'gemini-3.1-flash-lite',
  fixture: (process.env.SYNTHI_GPU_AGENT_FIXTURE ?? 'flow').toLowerCase(),
  mode: (process.env.SYNTHI_GPU_AGENT_MODE ?? 'validate').toLowerCase(),
  captureArtifacts: process.env.SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS === '1',
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const RESULTS_BASENAME = CFG.mode === 'seed-only' ? 'agent-split-seed-results' : 'agent-split-results';
const RESULTS_JSON = path.join(LOG_DIR, `${RESULTS_BASENAME}.json`);
const RESULTS_TXT = path.join(LOG_DIR, `${RESULTS_BASENAME}.txt`);
const ARTIFACT_DIR = path.join(
  LOG_DIR,
  'agent-split-artifacts',
  CFG.slug.replace(/[^a-zA-Z0-9_.-]+/g, '-'),
);
const EXPOSED_SPLIT_DIR = cleanVisibleWorkspaceDir(
  process.env.SYNTHI_GPU_EXPOSED_SPLIT_DIR ?? 'gpu_hmr_demo',
);

const results = [];
function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  results.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : '[warn]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
}

function cleanVisibleWorkspaceDir(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('.') || normalized.split('/').some((part) => !part || part.startsWith('.'))) {
    return 'gpu_hmr_demo';
  }
  return normalized;
}

function fail(message) {
  record('fatal', 'fail', message);
  throw new Error(message);
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return json ?? {};
}

function execText(cmd, args, timeoutMs = 10000, rejectOnError = false) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err && rejectOnError) {
        err.output = text;
        reject(err);
        return;
      }
      if (err) resolve(undefined);
      else resolve(text);
    });
  });
}

async function dockerContainerExists(nameOrId) {
  if (!nameOrId) return false;
  const inspected = await execText('docker', ['container', 'inspect', nameOrId], 5000);
  return typeof inspected === 'string' && inspected.length > 0;
}

async function resolveDockerContainer(configured, service) {
  if (await dockerContainerExists(configured)) return configured;

  const repoRoot = path.resolve(__dirname, '../../..');
  const composeId = await execText(
    'docker',
    ['compose', '--project-directory', repoRoot, 'ps', '-q', service],
    8000,
  );
  const id = String(composeId || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (id) return id;

  const labelIds = await execText(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`],
    8000,
  );
  const labelId = String(labelIds || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return labelId || configured;
}

async function resolveDockerContainers() {
  if (CFG.mcpTransport !== 'docker') return;
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
}

async function detectVendor() {
  if (CFG.vendor === 'cuda' || CFG.vendor === 'rocm') return CFG.vendor;
  const workerProbe = await execText('docker', [
    'exec',
    CFG.workerContainer,
    'sh',
    '-lc',
    'if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then echo cuda; elif [ -e /dev/dxg ] || command -v hipcc >/dev/null 2>&1; then echo rocm; else echo ""; fi',
  ]);
  const detected = String(workerProbe || '').trim().split(/\s+/).find((v) => v === 'cuda' || v === 'rocm');
  if (detected) return detected;
  throw new Error('could not auto-detect GPU vendor; set SYNTHI_GPU_VENDOR=cuda or rocm');
}

function archProbeCommand(vendor) {
  if (vendor === 'cuda') {
    return "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>/dev/null | awk 'NF { gsub(/\\./, \"\", $1); print \"sm_\" $1; exit }'; fi";
  }
  return "if command -v rocminfo >/dev/null 2>&1; then rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; elif command -v rocm_agent_enumerator >/dev/null 2>&1; then rocm_agent_enumerator 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; fi";
}

async function detectArch(vendor) {
  if (CFG.gpuArch && CFG.gpuArch.toLowerCase() !== 'auto') return CFG.gpuArch;
  if (CFG.mcpTransport !== 'docker') return undefined;
  const out = await execText('docker', [
    'exec',
    CFG.workerContainer,
    'sh',
    '-lc',
    archProbeCommand(vendor),
  ]);
  const detected = String(out || '').trim().split(/\s+/).find((v) => (
    vendor === 'cuda' ? /^sm_\d+$/.test(v) : /^gfx[0-9][0-9a-z]*$/.test(v)
  ));
  return detected;
}

async function createWorkspace({ name, slug }) {
  return createValidationWorkspace({
    frontendUrl: CFG.frontendUrl,
    name,
    slug,
    httpJson,
    record,
  });
}

async function writeFilesBatch({ slug, files }) {
  const res = await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', content: f.content })),
      syncToGcs: CFG.syncToGcs,
    },
    { 'x-user-id': CFG.hostId },
  );
  const errors = (res.errors ?? []).filter((e) => e.stage !== 'gcs_upload');
  if (errors.length) throw new Error(`write-files-batch errors: ${JSON.stringify(errors)}`);
  return res;
}

async function stageAndCommit({ slug, message }) {
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/stage-all`, {}, { 'x-user-id': CFG.hostId });
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/commit`, { message }, { 'x-user-id': CFG.hostId });
}

async function readWorkerLogTail(maxBytes = 8 * 1024 * 1024, opts = {}) {
  if (opts.since) {
    return new Promise((resolve) => {
      execFile(
        'docker',
        ['logs', '--since', opts.since, CFG.workerContainer],
        { maxBuffer: 128 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve('');
          resolve(`${stdout ?? ''}${stderr ?? ''}`);
        },
      );
    });
  }
  try {
    const st = await stat(CFG.workerLogPath);
    const fd = await import('node:fs').then((m) => m.promises.open(CFG.workerLogPath, 'r'));
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    return buf.toString('utf8');
  } catch {
    return new Promise((resolve) => {
      const args = ['logs', '--tail', '6000'];
      args.push(CFG.workerContainer);
      execFile('docker', args, { maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve('');
        resolve(`${stdout ?? ''}${stderr ?? ''}`);
      });
    });
  }
}

async function workerCheckpoint() {
  return { at: new Date(Date.now() - 2000).toISOString() };
}

async function awaitWorkerLogRegex(regex, timeoutMs, checkpoint) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = await readWorkerLogTail(8 * 1024 * 1024, checkpoint?.at ? { since: checkpoint.at } : {});
    regex.lastIndex = 0;
    const match = tail.match(regex);
    if (match) return { matched: true, snippet: match[0].slice(0, 500), tail };
    await sleep(700);
  }
  const tail = await readWorkerLogTail(8 * 1024 * 1024, checkpoint?.at ? { since: checkpoint.at } : {});
  return { matched: false, snippet: '', tail };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function workerWorkspacePath() {
  const logs = await readWorkerLogTail(4 * 1024 * 1024);
  const matches = [...logs.matchAll(/\[WORKER\] workspace tempdir: ([^\r\n]+)/g)];
  const fromLog = matches.at(-1)?.[1]?.trim();
  if (fromLog) return fromLog;
  const latestTmp = await execText('docker', [
    'exec',
    CFG.workerContainer,
    'sh',
    '-lc',
    'ls -td /tmp/.tmp* 2>/dev/null | head -1',
  ]);
  if (latestTmp) return latestTmp.trim();
  throw new Error('could not locate worker temp workspace path');
}

async function readWorkerFile(workspacePath, relPath) {
  const full = `${workspacePath.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`;
  return execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(full)}`],
    10000,
    true,
  );
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[mcp] ${s}`);
    });
    proc.on('exit', (code, sig) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP exited ${code ?? sig} before response`));
      }
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out. stderr tail:\n${this.stderrTail.slice(-10).join('')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) throw new Error(`tool ${name} isError: ${textBlock?.text ?? JSON.stringify(res.content)}`);
    if (!textBlock?.text) return {};
    try { return JSON.parse(textBlock.text); } catch { return { raw: textBlock.text }; }
  }

  async toolCallRaw(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) throw new Error(`tool ${name} isError: ${textBlock?.text ?? JSON.stringify(res.content)}`);
    let json = {};
    if (textBlock?.text) {
      try { json = JSON.parse(textBlock.text); } catch { json = { raw: textBlock.text }; }
    }
    return { json, content };
  }
}

let mcpState = null;
async function startMcp() {
  if (mcpState?.client) return mcpState;
  let proc;
  if (CFG.mcpTransport === 'docker') {
    proc = spawn('docker', [
      'exec',
      '-i',
      '-e', `SYNTHI_SESSION_ID=${CFG.slug}`,
      '-e', `SYNTHI_SIGNALING_URL=${CFG.mcpSignalingUrl}`,
      '-e', `SYNTHI_VISION_BACKEND=${CFG.mcpVisionBackend}`,
      '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
      '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
      '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
      '-e', `SYNTHI_GPU_SPLIT_MODEL=${CFG.gpuSplitModel}`,
      '-e', `SYNTHI_GPU_DELTA_MODEL=${CFG.gpuDeltaModel}`,
      CFG.mcpContainer,
      'node',
      '/app/dist/index.js',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    if (!existsSync(CFG.mcpEntry)) throw new Error(`MCP entry not found: ${CFG.mcpEntry}`);
    proc = spawn('node', [CFG.mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SYNTHI_SESSION_ID: CFG.slug,
        SYNTHI_SIGNALING_URL: CFG.signalingUrl,
        SYNTHI_VISION_BACKEND: CFG.mcpVisionBackend,
        GOOGLE_API_KEY: CFG.googleApiKey,
        GEMINI_API_KEY: CFG.googleApiKey,
        SYNTHI_GEMINI_MODEL: CFG.geminiModel,
        SYNTHI_GPU_SPLIT_MODEL: CFG.gpuSplitModel,
        SYNTHI_GPU_DELTA_MODEL: CFG.gpuDeltaModel,
      },
    });
  }
  const client = new McpClient(proc);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'synthi-gpu-hmr-agent-split-test', version: '0.0.1' },
  }, 20000);
  await client.request('notifications/initialized', {}, 5000).catch(() => {});
  const tools = await client.request('tools/list', {}, 20000);
  const names = tools.tools?.map((t) => t.name) ?? [];
  record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') ? 'pass' : 'fail', `count=${names.length}`);
  mcpState = { proc, client, attached: false };
  return mcpState;
}

async function ensureMcpAttached() {
  const state = await startMcp();
  if (state.attached) return state;
  const args = { sessionId: CFG.slug, 'i-understand-no-auth': true };
  if (CFG.mcpTransport !== 'docker') args.signalingUrl = CFG.signalingUrl;
  const attach = await state.client.toolCall('synthi_attach', args, CFG.mcpAttachTimeoutMs);
  if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
  state.attached = true;
  record('mcp attach', 'pass', attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached');
  return state;
}

async function stopMcp() {
  if (!mcpState) return;
  try { mcpState.proc.stdin.end(); } catch { /* ignore */ }
  try { mcpState.proc.kill('SIGTERM'); } catch { /* ignore */ }
  mcpState = null;
}

function runtimeInclude(vendor) {
  return vendor === 'rocm'
    ? '#include <hip/hip_runtime.h>'
    : '#include <cuda_runtime.h>';
}

function runtimeApi(vendor) {
  return vendor === 'rocm'
    ? {
        malloc: 'hipMalloc',
        memcpy: 'hipMemcpy',
        h2d: 'hipMemcpyHostToDevice',
        d2h: 'hipMemcpyDeviceToHost',
        sync: 'hipDeviceSynchronize',
        free: 'hipFree',
        link: '-lamdhip64',
        build: 'hipcc',
      }
    : {
        malloc: 'cudaMalloc',
        memcpy: 'cudaMemcpy',
        h2d: 'cudaMemcpyHostToDevice',
        d2h: 'cudaMemcpyDeviceToHost',
        sync: 'cudaDeviceSynchronize',
        free: 'cudaFree',
        link: '-lcudart -lcuda',
        build: 'nvcc',
      };
}

function monolithicSource(vendor) {
  if (CFG.fixture === 'complex-flow') return complexFlowSource(vendor);
  if (CFG.fixture === 'ray-light') return rayLightSource(vendor);

  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU app.
// No Synthi split/HMR ABI appears in this file.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION 1.0f
#endif

constexpr int BALLS = 512;
constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;

__global__ void particle_flow(float* x, float* y, int n, float cx, float cy, float speed, unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    float dx = cx - x[i];
    float dy = cy - y[i];
    float len = sqrtf(dx * dx + dy * dy) + 0.0001f;
    const float direction = FLOW_DIRECTION; // SYNTHI_HMR_DIRECTION_TOKEN
    x[i] += direction * dx / len * speed;
    y[i] += direction * dy / len * speed;

    float ox = x[i] - cx;
    float oy = y[i] - cy;
    float radius = sqrtf(ox * ox + oy * oy);
    float theta = 2.39996323f * (float)i + 0.015f * (float)(frame % 251ULL);
    if (direction > 0.0f && radius < 16.0f) {
        float rr = 300.0f + (float)((i * 19) % 58);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
    if (direction < 0.0f && radius > 384.0f) {
        float rr = 20.0f + (float)((i * 11) % 24);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
}

static void seed(float* x, float* y) {
    for (int i = 0; i < BALLS; ++i) {
        float theta = 2.39996323f * (float)i;
        float radius = 220.0f + (float)((i * 37) % 100);
        x[i] = WIDTH * 0.5f + cosf(theta) * radius;
        y[i] = HEIGHT * 0.5f + sinf(theta) * radius;
    }
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi Agent GPU Split", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[BALLS];
    float hostY[BALLS];
    seed(hostX, hostY);

    float* deviceX = nullptr;
    float* deviceY = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceY, sizeof(float) * BALLS);
    ${api.memcpy}(deviceX, hostX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceY, hostY, sizeof(float) * BALLS, ${api.h2d});

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((BALLS + block.x - 1) / block.x);
        particle_flow<<<grid, block>>>(deviceX, deviceY, BALLS, WIDTH * 0.5f, HEIGHT * 0.5f, 2.35f, frame++);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * BALLS, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 8, 10, 18, 255);
        SDL_RenderClear(renderer);
        SDL_SetRenderDrawColor(renderer, 70, 190, 255, 255);
        for (int i = 0; i < BALLS; ++i) {
            SDL_Rect r{(int)hostX[i], (int)hostY[i], 3, 3};
            SDL_RenderFillRect(renderer, &r);
        }
        SDL_RenderPresent(renderer);
        if ((frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-flow] frame=%llu\\n", frame);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function complexFlowSource(vendor) {
  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU app.
// More complex fixture: two kernels, persistent velocity/hue buffers, and
// branch-heavy device math. No Synthi split/HMR ABI appears in this file.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION 1.0f
#endif

constexpr int BALLS = 768;
constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;

__device__ float wrap_unit(float v) {
    while (v < 0.0f) v += 1.0f;
    while (v >= 1.0f) v -= 1.0f;
    return v;
}

extern "C" __global__ void particle_flow(
    float* x,
    float* y,
    float* vx,
    float* vy,
    float* hue,
    int n,
    float cx,
    float cy,
    float baseSpeed,
    float wobble,
    unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    float dx = cx - x[i];
    float dy = cy - y[i];
    float len = sqrtf(dx * dx + dy * dy) + 0.0001f;
    float swirl = sinf((float)i * 0.017f + (float)(frame % 997ULL) * 0.025f);
    const float direction = FLOW_DIRECTION; // SYNTHI_HMR_DIRECTION_TOKEN
    float ax = direction * dx / len * baseSpeed + (-dy / len) * wobble * swirl;
    float ay = direction * dy / len * baseSpeed + ( dx / len) * wobble * swirl;

    vx[i] = vx[i] * 0.84f + ax * 0.16f;
    vy[i] = vy[i] * 0.84f + ay * 0.16f;
    x[i] += vx[i];
    y[i] += vy[i];

    float ox = x[i] - cx;
    float oy = y[i] - cy;
    float radius = sqrtf(ox * ox + oy * oy);
    float theta = 2.39996323f * (float)i + 0.011f * (float)(frame % 389ULL);
    if (direction > 0.0f && radius < 18.0f) {
        float rr = 330.0f + (float)((i * 29) % 70);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
        vx[i] *= -0.15f;
        vy[i] *= -0.15f;
    }
    if (direction < 0.0f && radius > 420.0f) {
        float rr = 24.0f + (float)((i * 13) % 38);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
        vx[i] = -vx[i] * 0.25f;
        vy[i] = -vy[i] * 0.25f;
    }
    hue[i] = wrap_unit(hue[i] + 0.0015f + 0.0009f * swirl);
}

extern "C" __global__ void cool_hue(float* hue, int n, float amount) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    hue[i] = wrap_unit(hue[i] - amount + 0.00003f * (float)((i * 17) % 31));
}

static void seed(float* x, float* y, float* vx, float* vy, float* hue) {
    for (int i = 0; i < BALLS; ++i) {
        float theta = 2.39996323f * (float)i;
        float radius = 230.0f + (float)((i * 37) % 130);
        x[i] = WIDTH * 0.5f + cosf(theta) * radius;
        y[i] = HEIGHT * 0.5f + sinf(theta) * radius;
        vx[i] = -sinf(theta) * 0.65f;
        vy[i] =  cosf(theta) * 0.65f;
        hue[i] = (float)((i * 23) % 360) / 360.0f;
    }
}

static void color(float h, unsigned char& r, unsigned char& g, unsigned char& b) {
    h = h - floorf(h);
    float x = 1.0f - fabsf(fmodf(h * 6.0f, 2.0f) - 1.0f);
    float rr = 0.0f, gg = 0.0f, bb = 0.0f;
    if (h < 1.0f / 6.0f) { rr = 1.0f; gg = x; }
    else if (h < 2.0f / 6.0f) { rr = x; gg = 1.0f; }
    else if (h < 3.0f / 6.0f) { gg = 1.0f; bb = x; }
    else if (h < 4.0f / 6.0f) { gg = x; bb = 1.0f; }
    else if (h < 5.0f / 6.0f) { rr = x; bb = 1.0f; }
    else { rr = 1.0f; bb = x; }
    r = (unsigned char)(32.0f + rr * 210.0f);
    g = (unsigned char)(40.0f + gg * 190.0f);
    b = (unsigned char)(48.0f + bb * 180.0f);
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi Agent Complex GPU Split", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[BALLS];
    float hostY[BALLS];
    float hostVX[BALLS];
    float hostVY[BALLS];
    float hostHue[BALLS];
    seed(hostX, hostY, hostVX, hostVY, hostHue);

    float* deviceX = nullptr;
    float* deviceY = nullptr;
    float* deviceVX = nullptr;
    float* deviceVY = nullptr;
    float* deviceHue = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceY, sizeof(float) * BALLS);
    ${api.malloc}(&deviceVX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceVY, sizeof(float) * BALLS);
    ${api.malloc}(&deviceHue, sizeof(float) * BALLS);
    ${api.memcpy}(deviceX, hostX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceY, hostY, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceVX, hostVX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceVY, hostVY, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceHue, hostHue, sizeof(float) * BALLS, ${api.h2d});

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((BALLS + block.x - 1) / block.x);
        particle_flow<<<grid, block>>>(deviceX, deviceY, deviceVX, deviceVY, deviceHue,
                                       BALLS, WIDTH * 0.5f, HEIGHT * 0.5f,
                                       2.55f, 1.85f, frame++);
        cool_hue<<<grid, block>>>(deviceHue, BALLS, 0.0007f);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostHue, deviceHue, sizeof(float) * BALLS, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 6, 8, 16, 255);
        SDL_RenderClear(renderer);
        for (int i = 0; i < BALLS; ++i) {
            unsigned char r = 0, g = 0, b = 0;
            color(hostHue[i], r, g, b);
            SDL_SetRenderDrawColor(renderer, r, g, b, 255);
            SDL_Rect rect{(int)hostX[i], (int)hostY[i], 3, 3};
            SDL_RenderFillRect(renderer, &rect);
        }
        SDL_RenderPresent(renderer);
        if ((frame % 150ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-complex-flow] frame=%llu hue0=%.3f\\n", frame, hostHue[0]);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    ${api.free}(deviceVX);
    ${api.free}(deviceVY);
    ${api.free}(deviceHue);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function rayLightSource(vendor) {
  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU ray-light visual app.
// Deterministic validation fixture: fixed camera, fixed seed, no temporal
// accumulation, and GPU-authored ray sample positions.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;
constexpr int BEAMS = 17;
constexpr int LEG_STEPS = 44;
constexpr int STEPS = LEG_STEPS * 3;
constexpr int RAY_SAMPLES = BEAMS * STEPS;

extern "C" __global__ void trace_light_rays(float* sampleX, float* sampleY, float* sampleEnergy, int samples) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= samples) return;

    int beam = idx % BEAMS;
    int step = idx / BEAMS;
    float lane = ((float)beam - (float)(BEAMS - 1) * 0.5f) / ((float)(BEAMS - 1) * 0.5f);

    const float direction = 1.0f; // SYNTHI_HMR_DIRECTION_TOKEN
    float emitterX = 400.0f + direction * 252.0f;
    float emitterY = 74.0f;

    float rayDx = -direction * (0.70f + lane * 0.10f);
    float rayDy = 1.0f;
    float invRayLen = rsqrtf(rayDx * rayDx + rayDy * rayDy);
    rayDx *= invRayLen;
    rayDy *= invRayLen;

    const float mirrorAnchorX = 400.0f;
    const float mirrorMidY = 260.0f;
    const float mirrorSlope = 0.32f;
    float denom = rayDx - mirrorSlope * rayDy;
    float mirrorT = (mirrorAnchorX + (emitterY - mirrorMidY) * mirrorSlope - emitterX) / denom;
    if (mirrorT < 40.0f) mirrorT = 40.0f;
    float hitX = emitterX + rayDx * mirrorT;
    float hitY = emitterY + rayDy * mirrorT;
    hitY += lane * 10.0f;
    hitX = mirrorAnchorX + (hitY - mirrorMidY) * mirrorSlope;

    float normalX = 1.0f;
    float normalY = -mirrorSlope;
    float invNormalLen = rsqrtf(normalX * normalX + normalY * normalY);
    normalX *= invNormalLen;
    normalY *= invNormalLen;
    float dotN = rayDx * normalX + rayDy * normalY;
    float reflectX = rayDx - 2.0f * dotN * normalX;
    float reflectY = rayDy - 2.0f * dotN * normalY;
    if (reflectY < 0.25f) reflectY = 0.72f;
    float invReflectLen = rsqrtf(reflectX * reflectX + reflectY * reflectY);
    reflectX *= invReflectLen;
    reflectY *= invReflectLen;

    float groundY = 504.0f + lane * 7.0f;
    float groundT = (groundY - hitY) / reflectY;
    if (groundT < 90.0f) groundT = 90.0f;
    float groundX = hitX + reflectX * groundT;

    float diffuseX = -reflectX * 0.42f + lane * 0.10f;
    float diffuseY = -0.82f;
    float invDiffuseLen = rsqrtf(diffuseX * diffuseX + diffuseY * diffuseY);
    diffuseX *= invDiffuseLen;
    diffuseY *= invDiffuseLen;
    float diffuseEndX = groundX + diffuseX * (88.0f + 18.0f * fabsf(lane));
    float diffuseEndY = groundY + diffuseY * 108.0f;

    int segment = step / LEG_STEPS;
    int segmentStep = step - segment * LEG_STEPS;
    if (segment > 2) {
        segment = 2;
        segmentStep = LEG_STEPS - 1;
    }
    float u = (float)segmentStep / (float)(LEG_STEPS - 1);
    float x;
    float y;
    float energy;
    if (segment == 0) {
        x = emitterX + (hitX - emitterX) * u;
        y = emitterY + (hitY - emitterY) * u;
        energy = 1.0f - 0.25f * u;
    } else if (segment == 1) {
        x = hitX + (groundX - hitX) * u;
        y = hitY + (groundY - hitY) * u;
        float caustic = expf(-((u - 0.82f) * (u - 0.82f)) / (2.0f * 0.10f * 0.10f));
        energy = 0.68f + caustic * 0.62f;
    } else {
        x = groundX + (diffuseEndX - groundX) * u;
        y = groundY + (diffuseEndY - groundY) * u;
        energy = 0.42f * (1.0f - u);
    }
    sampleX[idx] = x;
    sampleY[idx] = y;
    sampleEnergy[idx] = energy;
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi GPU Ray Light HMR", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[RAY_SAMPLES];
    float hostY[RAY_SAMPLES];
    float hostEnergy[RAY_SAMPLES];
    float* deviceX = nullptr;
    float* deviceY = nullptr;
    float* deviceEnergy = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * RAY_SAMPLES);
    ${api.malloc}(&deviceY, sizeof(float) * RAY_SAMPLES);
    ${api.malloc}(&deviceEnergy, sizeof(float) * RAY_SAMPLES);

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((RAY_SAMPLES + block.x - 1) / block.x);
        trace_light_rays<<<grid, block>>>(deviceX, deviceY, deviceEnergy, RAY_SAMPLES);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * RAY_SAMPLES, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * RAY_SAMPLES, ${api.d2h});
        ${api.memcpy}(hostEnergy, deviceEnergy, sizeof(float) * RAY_SAMPLES, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 5, 8, 18, 255);
        SDL_RenderClear(renderer);

        SDL_SetRenderDrawColor(renderer, 20, 30, 34, 255);
        SDL_Rect ground{0, 340, WIDTH, HEIGHT - 340};
        SDL_RenderFillRect(renderer, &ground);
        SDL_SetRenderDrawColor(renderer, 38, 55, 58, 255);
        for (int gx = 0; gx < WIDTH; gx += 40) {
            SDL_RenderDrawLine(renderer, gx, 340, gx - 90, HEIGHT);
        }
        for (int gy = 360; gy < HEIGHT; gy += 42) {
            SDL_RenderDrawLine(renderer, 0, gy, WIDTH, gy);
        }

        SDL_SetRenderDrawColor(renderer, 92, 176, 210, 255);
        SDL_RenderDrawLine(renderer, 350, 184, 448, 491);
        SDL_RenderDrawLine(renderer, 354, 184, 452, 491);
        SDL_SetRenderDrawColor(renderer, 20, 48, 58, 255);
        SDL_Rect mirrorBack{386, 252, 78, 18};
        SDL_RenderFillRect(renderer, &mirrorBack);
        SDL_SetRenderDrawColor(renderer, 12, 12, 16, 255);
        SDL_Rect occluder{455, 374, 54, 86};
        SDL_RenderFillRect(renderer, &occluder);
        SDL_SetRenderDrawColor(renderer, 78, 86, 92, 255);
        SDL_RenderDrawRect(renderer, &occluder);

        for (int beam = 0; beam < BEAMS; ++beam) {
            for (int step = 1; step < STEPS; ++step) {
                int prev = (step - 1) * BEAMS + beam;
                int cur = step * BEAMS + beam;
                int e = (int)(hostEnergy[cur] * 255.0f);
                if (e < 0) e = 0;
                if (e > 255) e = 255;
                if (step < LEG_STEPS) {
                    SDL_SetRenderDrawColor(renderer, 255, 226, 116 + e / 4, 255);
                } else if (step < LEG_STEPS * 2) {
                    SDL_SetRenderDrawColor(renderer, 128 + e / 3, 218, 255, 255);
                } else {
                    SDL_SetRenderDrawColor(renderer, 255, 160 + e / 5, 80, 255);
                }
                SDL_RenderDrawLine(renderer, (int)hostX[prev], (int)hostY[prev], (int)hostX[cur], (int)hostY[cur]);
                if ((step % 8) == 0) {
                    int size = 1 + e / 128;
                    SDL_Rect sample{(int)hostX[cur], (int)hostY[cur], size, size};
                    SDL_RenderFillRect(renderer, &sample);
                }
            }
            int mirrorHit = LEG_STEPS * BEAMS + beam;
            int groundHit = (LEG_STEPS * 2) * BEAMS + beam;
            SDL_SetRenderDrawColor(renderer, 170, 238, 255, 255);
            SDL_Rect hit{(int)hostX[mirrorHit] - 3, (int)hostY[mirrorHit] - 3, 7, 7};
            SDL_RenderFillRect(renderer, &hit);
            SDL_SetRenderDrawColor(renderer, 255, 212, 104, 255);
            SDL_Rect pool{(int)hostX[groundHit] - 7, (int)hostY[groundHit] - 2, 15, 5};
            SDL_RenderFillRect(renderer, &pool);
        }

        SDL_SetRenderDrawColor(renderer, 255, 236, 154, 255);
        SDL_Rect emitter{(int)hostX[0] - 8, (int)hostY[0] - 8, 16, 16};
        SDL_RenderFillRect(renderer, &emitter);

        SDL_RenderPresent(renderer);
        SDL_Delay(16);

        if ((++frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-ray-light] frame=%llu deterministic=1\\n", frame);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    ${api.free}(deviceEnergy);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function assertNoSynthiAbi(source) {
  const forbidden = ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'];
  const found = forbidden.filter((needle) => source.includes(needle));
  if (found.length) fail(`monolithic source unexpectedly contains Synthi ABI markers: ${found.join(', ')}`);
  record('monolithic source has no Synthi ABI', 'pass');
}

async function compileViaMcp(args, timeoutMs) {
  const state = await ensureMcpAttached();
  const compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  if (!compile?.ok) throw new Error(`synthi_compile failed: ${JSON.stringify(compile).slice(0, 500)}`);
  const waitContract = waitContractForCompile({ args, compile, timeoutMs });
  const wait = await state.client.toolCall(
    'synthi_wait_hmr',
    waitContract.waitArgs,
    timeoutMs + 5000,
  ).catch((e) => ({ status: 'timeout_or_error', error: e.message }));
  const waitSummary = {
    role: waitContract.role,
    module: waitContract.waitArgs.module ?? null,
    since_ts: waitContract.waitArgs.since_ts ?? null,
    requireGpuFullRuntimeProof: waitContract.waitArgs.requireGpuFullRuntimeProof === true,
    requiredGpuProofState: waitContract.waitArgs.requiredGpuProofState ?? null,
    status: wait?.status ?? null,
    frame_gate: wait?.frame_gate ?? null,
  };
  if (wait?.error) waitSummary.error = String(wait.error).slice(0, 4000);
  if (wait?.gpu_proof_validation) waitSummary.gpu_proof_validation = wait.gpu_proof_validation;
  if (wait?.gpu_proof_telemetry) waitSummary.gpu_proof_telemetry = wait.gpu_proof_telemetry;
  record('mcp wait_hmr proof gate', wait?.status === 'applied' ? 'pass' : 'warn', JSON.stringify(waitSummary));
  return { compile, wait, waitContract };
}

function cleanRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function upsertObjectField(root, parentKey, filePath, value) {
  const normalized = cleanRel(filePath);
  if (!normalized) return;
  if (!root[parentKey] || typeof root[parentKey] !== 'object' || Array.isArray(root[parentKey])) {
    root[parentKey] = {};
  }
  root[parentKey][normalized] = value;
}

function upsertDeviceMappingReportField(root, parentKey, filePath, value) {
  if (!root.device_mapping_report || typeof root.device_mapping_report !== 'object' || Array.isArray(root.device_mapping_report)) {
    root.device_mapping_report = {};
  }
  upsertObjectField(root.device_mapping_report, parentKey, filePath, value);
}

function sidecarWithSourceBaseline(sidecarRaw, filePath, source) {
  const root = JSON.parse(sidecarRaw);
  const normalized = cleanRel(filePath);
  if (!normalized || !String(source || '').trim()) {
    return JSON.stringify(root, null, 2);
  }
  const baselineHash = sha256Hex(source);
  upsertObjectField(root, 'sourceBaselineContents', normalized, source);
  upsertObjectField(root, 'sourceBaselineHashes', normalized, baselineHash);
  upsertDeviceMappingReportField(root, 'sourceBaselineContents', normalized, source);
  upsertDeviceMappingReportField(root, 'sourceBaselineHashes', normalized, baselineHash);
  return JSON.stringify(root, null, 2);
}

function manifestRoleForPath(manifest, filePath) {
  const moduleFiles = manifest?.module_files && typeof manifest.module_files === 'object'
    ? manifest.module_files
    : {};
  const normalizedPath = cleanRel(filePath);
  for (const [role, rolePath] of Object.entries(moduleFiles)) {
    if (cleanRel(rolePath) === normalizedPath) return role;
  }
  return null;
}

function waitContractForCompile({ args, compile, timeoutMs }) {
  const manifest = args?.compile_manifest;
  const filename = cleanRel(args?.filename);
  const role = manifestRoleForPath(manifest, filename);
  const isGpuDeviceEdit = role === 'device' || (
    manifest?.gpu && /\.(hip|cu|cl|wgsl|glsl|spv|spirv)$/i.test(filename)
  );
  const module = process.env.SYNTHI_GPU_HMR_WAIT_MODULE
    ?? (isGpuDeviceEdit ? 'device' : role ?? undefined);
  const waitArgs = {
    timeoutMs,
    ...(Number.isFinite(compile?.dispatched_at)
      ? { since_ts: compile.dispatched_at }
      : {}),
    ...(module ? { module } : {}),
  };
  const requiredState = process.env.SYNTHI_GPU_HMR_REQUIRED_PROOF_STATE;
  if (requiredState && requiredState.trim()) {
    waitArgs.requiredGpuProofState = requiredState.trim();
  } else if (isGpuDeviceEdit && process.env.SYNTHI_GPU_HMR_REQUIRE_FULL_RUNTIME_PROOF !== '0') {
    waitArgs.requireGpuFullRuntimeProof = true;
  }
  return { waitArgs, role, isGpuDeviceEdit };
}

function manifestRolePaths(manifest, vendor) {
  const moduleFiles = manifest?.module_files && typeof manifest.module_files === 'object'
    ? manifest.module_files
    : {};
  return {
    shared: cleanRel(moduleFiles.shared || 'shared.h'),
    core: cleanRel(moduleFiles.core || 'core.cpp'),
    gui: cleanRel(moduleFiles.gui || 'gui.cpp'),
    host_runner: cleanRel(moduleFiles.host_runner || 'host_runner.cpp'),
    device: cleanRel(moduleFiles.device || (vendor === 'rocm' ? 'device.hip' : 'device.cu')),
  };
}

async function readGeneratedSplit(vendor) {
  const workspacePath = await workerWorkspacePath();
  const sidecarRaw = await readWorkerFile(workspacePath, '.synthi_split_meta.json');
  const sidecar = JSON.parse(sidecarRaw);
  const manifest = sidecar.compile_manifest;
  if (!manifest?.gpu) throw new Error('generated sidecar missing compile_manifest.gpu');
  const roles = manifestRolePaths(manifest, vendor);
  const files = {};
  for (const rel of Object.values(roles)) {
    files[rel] = await readWorkerFile(workspacePath, rel);
  }
  return { workspacePath, sidecarRaw, sidecar, manifest, roles, files };
}

function validateGeneratedSplit(split) {
  const core = split.files[split.roles.core] || '';
  const gui = split.files[split.roles.gui] || '';
  const host = split.files[split.roles.host_runner] || '';
  const device = split.files[split.roles.device] || '';
  const missing = [];
  if (!core.includes('core_on_update')) missing.push('core_on_update');
  if (!gui.includes('gui_on_render')) missing.push('gui_on_render');
  if (!host.includes('main(')) missing.push('host_runner main');
  if (!device.includes('__global__')) missing.push('__global__ device kernel');
  if (missing.length) throw new Error(`generated split missing expected generated pieces: ${missing.join(', ')}`);
  record('generated split contains HMR ABI', 'pass', Object.values(split.roles).join(', '));
}

function flipDeviceDirection(source) {
  const marker = 'SYNTHI_HMR_DIRECTION_TOKEN';
  const lines = source.split('\n');
  const markerIndex = lines.findIndex((line) => line.includes(marker));
  if (markerIndex >= 0) {
    const old = lines[markerIndex];
    const next = old.replace('1.0f', '-1.0f').replace('1.0', '-1.0');
    if (next !== old) {
      lines[markerIndex] = next;
      return lines.join('\n');
    }
  }
  const replacements = [
    [/FLOW_DIRECTION\s+1\.0f/g, 'FLOW_DIRECTION -1.0f'],
    [/FLOW_DIRECTION\s+1\.0/g, 'FLOW_DIRECTION -1.0'],
    [/const\s+float\s+direction\s*=\s*1\.0f\s*;/g, 'const float direction = -1.0f;'],
    [/const\s+float\s+direction\s*=\s*1\.0\s*;/g, 'const float direction = -1.0f;'],
    [/\bx\s*\[\s*i\s*\]\s*\+=\s*dx\s*\/\s*len\s*\*\s*speed\s*;/g, 'x[i] -= dx / len * speed;'],
    [/\by\s*\[\s*i\s*\]\s*\+=\s*dy\s*\/\s*len\s*\*\s*speed\s*;/g, 'y[i] -= dy / len * speed;'],
    [/\bx\s*\[\s*i\s*\]\s*\+=\s*direction\s*\*\s*dx\s*\/\s*len\s*\*\s*speed\s*;/g, 'x[i] -= direction * dx / len * speed;'],
    [/\by\s*\[\s*i\s*\]\s*\+=\s*direction\s*\*\s*dy\s*\/\s*len\s*\*\s*speed\s*;/g, 'y[i] -= direction * dy / len * speed;'],
  ];
  for (const [regex, replacement] of replacements) {
    const edited = source.replace(regex, replacement);
    if (edited !== source) return edited;
  }
  const nonce = BigInt(`0x${Buffer.from(`${Date.now()}:${source.length}`).toString('hex').slice(0, 16)}`);
  const nonceDecl = `\n// Synthi GPU HMR validation edit: device-only artifact nonce.\n__device__ unsigned long long synthi_hmr_validation_nonce = ${nonce}ULL;\n`;
  if (/synthi_hmr_validation_nonce\s*=/.test(source)) {
    return source.replace(/synthi_hmr_validation_nonce\s*=\s*\d+ULL/g, `synthi_hmr_validation_nonce = ${nonce}ULL`);
  }
  return `${source.trimEnd()}\n${nonceDecl}`;
}

function exposedSplitPath(filePath) {
  const rel = cleanRel(filePath);
  const prefix = '.synthi/generated/gpu/';
  if (!rel.startsWith(prefix)) return null;
  const suffix = rel.slice(prefix.length).split('/').filter(Boolean).join('/');
  return suffix ? `${EXPOSED_SPLIT_DIR}/${suffix}` : null;
}

function exposedCompileManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest || {}));
  if (copy.module_files && typeof copy.module_files === 'object') {
    for (const [role, filePath] of Object.entries(copy.module_files)) {
      const exposed = exposedSplitPath(filePath);
      if (exposed) copy.module_files[role] = exposed;
    }
  }
  if (copy.gpu?.device_roles && Array.isArray(copy.gpu.device_roles)) {
    copy.gpu.device_roles = copy.gpu.device_roles.map((role) => {
      if (!role || typeof role !== 'object') return role;
      const exposed = exposedSplitPath(role.path);
      return exposed ? { ...role, path: exposed } : role;
    });
  }
  return copy;
}

function visibleGpuSplitFiles(split) {
  const files = [];
  for (const [filePath, content] of Object.entries(split.files || {})) {
    const exposed = exposedSplitPath(filePath);
    if (exposed) files.push({ path: exposed, content });
  }
  if (!files.length) return files;
  const manifest = exposedCompileManifest(split.manifest);
  files.push({ path: 'synthi/build_manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' });
  files.push({
    path: `${EXPOSED_SPLIT_DIR}/README.md`,
    content: [
      '# GPU HMR Split Files',
      '',
      'These files are the visible editor surface for the generated GPU split.',
      'Edit the device file here for the fast GPU HMR delta path.',
      'The internal `.synthi/` files remain implementation metadata.',
      '',
    ].join('\n'),
  });
  return files;
}

async function persistGeneratedSplitToWorkspace(split) {
  const files = Object.entries(split.files).map(([filePath, content]) => ({ path: filePath, content }));
  files.push({ path: '.synthi_split_meta.json', content: split.sidecarRaw });
  files.push({ path: '.synthi/build_manifest.json', content: JSON.stringify(split.manifest, null, 2) + '\n' });
  files.push(...visibleGpuSplitFiles(split));
  await writeFilesBatch({ slug: CFG.slug, files });
  record('persist generated split to workspace', 'pass', `${files.length} files`);
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-agent-split-test: persist generated split' })
    .then(() => record('workspace commit generated split', 'pass'))
    .catch((e) => record('workspace commit generated split', 'warn', e.message.slice(0, 200)));
}

async function compileGeneratedDevice(split, editedDevice) {
  const previousDevice = split.files[split.roles.device];
  const sidecarRaw = sidecarWithSourceBaseline(split.sidecarRaw, split.roles.device, previousDevice);
  split.files[split.roles.device] = editedDevice;
  const allFiles = [
    ...Object.entries(split.files).map(([name, content]) => ({ name, content })),
    { name: '.synthi_split_meta.json', content: sidecarRaw },
    { name: '.synthi/build_manifest.json', content: JSON.stringify(split.manifest, null, 2) + '\n' },
  ];
  const additionalFiles = allFiles.filter((f) => cleanRel(f.name) !== cleanRel(split.roles.device));
  await writeFilesBatch({
    slug: CFG.slug,
    files: [{ path: split.roles.device, content: editedDevice }],
  });
  return compileViaMcp({
    language: 'cpp',
    filename: split.roles.device,
    source: editedDevice,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: split.manifest.gpu.vendor,
    gpu_arch: CFG.gpuArch,
    compile_manifest: split.manifest,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs);
}

async function writeImageArtifact(name, imageData) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  await writeFile(file, Buffer.from(imageData, 'base64'));
  return path.relative(process.cwd(), file);
}

async function writeJsonArtifact(name, value) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(value, null, 2));
  return path.relative(process.cwd(), file);
}

function withoutImageData(shot) {
  if (!shot || typeof shot !== 'object') return shot;
  const { imageData, ...rest } = shot;
  return rest;
}

async function assertVisualDelta(beforeShot, afterShot) {
  if (!beforeShot?.imageData || !afterShot?.imageData) {
    throw new Error('visual delta requires saved before/after screenshot data');
  }
  const beforeInput = Buffer.from(beforeShot.imageData, 'base64');
  const afterInput = Buffer.from(afterShot.imageData, 'base64');
  const before = await sharp(beforeInput).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(afterInput)
    .resize(before.info.width, before.info.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = Math.max(1, before.info.width * before.info.height);
  const diff = Buffer.alloc(pixelCount * 4);
  let changed = 0;
  let totalAbs = 0;
  for (let i = 0, p = 0; i < before.data.length && i < after.data.length; i += before.info.channels, p += 4) {
    const dr = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0));
    const dg = Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0));
    const db = Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0));
    const delta = dr + dg + db;
    totalAbs += delta / 3;
    if (delta > 42) changed += 1;
    diff[p] = Math.min(255, dr * 4);
    diff[p + 1] = Math.min(255, dg * 4);
    diff[p + 2] = Math.min(255, db * 4);
    diff[p + 3] = 255;
  }
  const changedRatio = changed / pixelCount;
  const meanAbs = totalAbs / pixelCount;
  const diffPath = path.join(ARTIFACT_DIR, 'before-after-diff.png');
  await sharp(diff, {
    raw: {
      width: before.info.width,
      height: before.info.height,
      channels: 4,
    },
  }).png().toFile(diffPath);
  const detail = `changed=${(changedRatio * 100).toFixed(2)}% mean_abs=${meanAbs.toFixed(2)} diff=${path.relative(process.cwd(), diffPath)}`;
  const ok = changedRatio > 0.01 && meanAbs > 1.0;
  record('mcp screenshot visual delta', ok ? 'pass' : 'fail', detail);
  if (!ok) throw new Error(`visual delta too small: ${detail}`);
  return { changedRatio, meanAbs, diffPath: path.relative(process.cwd(), diffPath) };
}

async function assertMcpScreenshot(label = 'mcp screenshot after hmr', artifactPrefix = 'after-hmr', waitEvidence = null) {
  const state = await ensureMcpAttached();
  let gateTokenConsumed = false;
  let verifiedGateCapture = null;
  const analyzeImage = async (data) => {
    if (!data) return { bytes: 0, visiblePixels: 0, meanLuma: 0 };
    const bytes = Math.floor(data.length * 3 / 4);
    const input = Buffer.from(data, 'base64');
    const { data: raw, info } = await sharp(input)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let visiblePixels = 0;
    let lumaTotal = 0;
    for (let i = 0; i < raw.length; i += info.channels) {
      const r = raw[i] ?? 0;
      const g = raw[i + 1] ?? 0;
      const b = raw[i + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaTotal += luma;
      if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) {
        visiblePixels += 1;
      }
    }
    const pixels = Math.max(1, info.width * info.height);
    return { bytes, visiblePixels, meanLuma: lumaTotal / pixels };
  };
  const capture = async () => {
    const useFrameGate = waitEvidence && !gateTokenConsumed;
    const screenshotArgs = mcpScreenshotArgsForFrameGate(useFrameGate ? waitEvidence : null, {
      freshnessMaxMs: 15000,
      frameGateTimeoutMs: CFG.frameGateTimeoutMs,
    });
    const shot = await state.client.toolCallRaw(
      'synthi_screenshot',
      screenshotArgs,
      Math.max(30000, CFG.frameGateTimeoutMs + 5000),
    );
    if (screenshotArgs.after_frame_gate) gateTokenConsumed = true;
    const image = shot.content.find((b) => b?.type === 'image' && typeof b.data === 'string');
    const meta = mcpScreenshotMetadataFromToolResult(shot) || {};
    const frameMeta = {
      ...meta,
      seq: Number(meta.seq || 0),
      ts: Number(meta.ts || 0),
    };
    const gateTokenVerified = mcpFrameGateSatisfiedByScreenshot(waitEvidence, frameMeta);
    if (gateTokenVerified) {
      verifiedGateCapture = {
        seq: frameMeta.seq,
        ts: frameMeta.ts,
      };
    }
    const frameAfterGate = !waitEvidence
      ? false
      : gateTokenVerified
        || (verifiedGateCapture !== null
          && mcpFrameAtOrAfterFrameGate(waitEvidence, frameMeta)
          && frameMeta.seq >= verifiedGateCapture.seq
          && frameMeta.ts >= verifiedGateCapture.ts);
    const analysis = await analyzeImage(image?.data);
    return {
      meta,
      imageData: image?.data || '',
      width: Number(meta.w || meta.width || 0),
      height: Number(meta.h || meta.height || 0),
      seq: frameMeta.seq,
      ts: frameMeta.ts,
      frameGateTokenVerified: gateTokenVerified,
      frameCaptureAfterEpochDispatch: frameAfterGate,
      ...analysis,
    };
  };
  const isVisibleFrame = (shot) =>
    shot.width >= 320 &&
    shot.height >= 240 &&
    shot.bytes > 512 &&
    shot.visiblePixels > 500;
  const deadline = Date.now() + 15000;
  const samples = [];
  while (Date.now() < deadline) {
    const shot = await capture();
    samples.push(shot);
    const eligibleVisible = samples
      .filter(isVisibleFrame)
      .filter((sample) => !waitEvidence || sample.frameCaptureAfterEpochDispatch === true);
    if (eligibleVisible.length >= 2) break;
    await sleep(500);
  }
  const visible = samples
    .filter(isVisibleFrame)
    .filter((sample) => !waitEvidence || sample.frameCaptureAfterEpochDispatch === true);
  const first = visible[0] ?? samples[0] ?? { meta: {}, width: 0, height: 0, seq: 0, bytes: 0, visiblePixels: 0, meanLuma: 0 };
  const second = visible.find((shot) => shot.seq > first.seq) ?? visible[1] ?? samples[samples.length - 1] ?? first;
  const frameGateVerified = !waitEvidence || samples.some((sample) => sample.frameGateTokenVerified === true);
  const ok =
    isVisibleFrame(first) &&
    second.width === first.width &&
    second.height === first.height &&
    second.bytes > 512 &&
    second.visiblePixels > 500 &&
    second.seq > first.seq &&
    frameGateVerified &&
    (!waitEvidence || (
      first.frameCaptureAfterEpochDispatch === true &&
      second.frameCaptureAfterEpochDispatch === true
    ));
  let artifactDetail = '';
  if (ok && CFG.captureArtifacts) {
    const firstPath = await writeImageArtifact(`${artifactPrefix}-first`, first.imageData);
    const secondPath = await writeImageArtifact(`${artifactPrefix}-second`, second.imageData);
    const metaPath = await writeJsonArtifact(`${artifactPrefix}-metadata`, {
      first: withoutImageData(first),
      second: withoutImageData(second),
    });
    artifactDetail = ` images=${firstPath},${secondPath} metadata=${metaPath}`;
  }
  record(
    label,
    ok ? 'pass' : 'fail',
    ok
      ? `${first.width}x${first.height} seq=${first.seq}->${second.seq} visible=${first.visiblePixels}/${second.visiblePixels} luma=${first.meanLuma.toFixed(1)}/${second.meanLuma.toFixed(1)} bytes~${first.bytes}/${second.bytes} frame_gate_after=${second.frameCaptureAfterEpochDispatch}${artifactDetail}`
      : `invalid screenshot first=${JSON.stringify(first.meta).slice(0, 120)} second=${JSON.stringify(second.meta).slice(0, 120)} visible=${first.visiblePixels}/${second.visiblePixels} luma=${first.meanLuma.toFixed(1)}/${second.meanLuma.toFixed(1)} bytes~${first.bytes}/${second.bytes} frame_gate_after=${second.frameCaptureAfterEpochDispatch}`,
  );
  if (!ok) throw new Error(`${label} did not return a valid frame`);
  return { first, second };
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await resolveDockerContainers();
  const vendor = await detectVendor();
  const arch = await detectArch(vendor);
  if (arch) {
    CFG.gpuArch = arch;
    process.env.SYNTHI_GPU_ARCH = arch;
  }
  record('gpu vendor', 'pass', `${vendor} arch=${arch ?? 'auto'}`);
  record('fixture', 'pass', CFG.fixture);

  const source = monolithicSource(vendor);
  assertNoSynthiAbi(source);

  const workspace = await createWorkspace({
    name: `Synthi GPU Agent Split (${vendor})`,
    slug: CFG.slug,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);

  await writeFilesBatch({ slug: CFG.slug, files: [{ path: 'main.cpp', content: source }] });
  record('seed monolithic user source', 'pass', 'main.cpp');
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-agent-split-test: seed monolithic source' })
    .then(() => record('workspace commit seed', 'pass'))
    .catch((e) => record('workspace commit seed', 'warn', e.message.slice(0, 200)));

  if (CFG.mode === 'seed-only') {
    record('seed-only workspace ready', 'pass', 'open the URL and click Run to trigger AI split');
    await writeResults();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

  const firstStart = await workerCheckpoint();
  await compileViaMcp({
    language: 'cpp',
    filename: 'main.cpp',
    source,
    files: [],
    is_gui: true,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hmrTimeoutMs);
  record('first compile via MCP', 'pass', 'use_ai_split=true prefer_gpu_pipeline=true');

  const sawGpuSplit = await awaitWorkerLogRegex(
    /GPU markers detected; calling GPU split endpoint|GPU split endpoint returned a 5-file split/,
    CFG.hmrTimeoutMs,
    firstStart,
  );
  record('worker used GPU split endpoint', sawGpuSplit.matched ? 'pass' : 'fail', sawGpuSplit.snippet || 'no GPU split marker');

  const sawDeviceCompile = await awaitWorkerLogRegex(
    /compile-device.*(hipcc|nvcc)|Device sidecar reload vendor=.*result=Success/,
    CFG.hmrTimeoutMs,
    firstStart,
  );
  record('generated device compiled', sawDeviceCompile.matched ? 'pass' : 'fail', sawDeviceCompile.snippet || 'no device compile marker');

  const baselineShot = CFG.captureArtifacts
    ? await assertMcpScreenshot('mcp screenshot before hmr', 'before-hmr')
    : null;

  const split = await readGeneratedSplit(vendor);
  record('read generated split from worker', 'pass', `worker=${split.workspacePath}`);
  validateGeneratedSplit(split);
  await persistGeneratedSplitToWorkspace(split);

  const editedDevice = flipDeviceDirection(split.files[split.roles.device]);
  const secondStart = await workerCheckpoint();
  const generatedDeviceResult = await compileGeneratedDevice(split, editedDevice);
  record('device edit compile via MCP', 'pass', split.roles.device);

  const sawSplitEdit = await awaitWorkerLogRegex(
    new RegExp(`FallbackDeterministic.*split file edit.*${split.roles.device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|compile-device.*${split.roles.device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    CFG.hotSwapTimeoutMs + 30000,
    secondStart,
  );
  record('generated device file used for HMR', sawSplitEdit.matched ? 'pass' : 'fail', sawSplitEdit.snippet || 'no split-file/device marker');

  const hotSwap = await awaitWorkerLogRegex(
    /\[gpu-reload\].*plan=device_only|Device sidecar reload vendor=.*result=Success/,
    CFG.hotSwapTimeoutMs + 30000,
    secondStart,
  );
  record('device-only GPU HMR observed', hotSwap.matched ? 'pass' : 'fail', hotSwap.snippet || 'no device-only reload marker');

  const afterShot = await assertMcpScreenshot('mcp screenshot after hmr', 'after-hmr', generatedDeviceResult.wait);
  if (CFG.captureArtifacts && baselineShot) {
    await assertVisualDelta(baselineShot.second, afterShot.second);
  }

  await sleep(2000);
  const afterReload = await readWorkerLogTail(4 * 1024 * 1024, secondStart?.at ? { since: secondStart.at } : {});
  const crashMatch = afterReload.match(/Runner process (?:has already )?exited[^\n]*|SIGSEGV|core dumped|module loading could begin|module-load-failed|mismatch rollback|Device reload result .*Failed/);
  record('runner stayed alive after GPU HMR', crashMatch ? 'fail' : 'pass', crashMatch?.[0] || 'no runner crash marker');

  await writeResults();
  console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length) process.exitCode = 1;
}

async function writeResults() {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(RESULTS_JSON, JSON.stringify(results, null, 2));
  await writeFile(RESULTS_TXT, results.map((r) => `${r.status.toUpperCase()} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`).join('\n') + '\n');
  console.log(`results: ${RESULTS_TXT}`);
}

run()
  .catch(async (err) => {
    record('fatal', 'fail', err.stack || err.message);
    await writeResults().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => stopMcp());
