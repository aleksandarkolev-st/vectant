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
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
  workerContainer: process.env.WORKER_CONTAINER ?? 'synthi-ide-worker-1',
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3-flash-preview',
  fixture: (process.env.SYNTHI_GPU_AGENT_FIXTURE ?? 'flow').toLowerCase(),
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const RESULTS_JSON = path.join(LOG_DIR, 'agent-split-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'agent-split-results.txt');

const results = [];
function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  results.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : '[warn]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
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
  return httpJson('POST', `${CFG.frontendUrl}/api/workspace`, { name, slug });
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
      const args = ['logs'];
      if (opts.since) args.push('--since', opts.since);
      else args.push('--tail', '6000');
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
      '-e', 'SYNTHI_VISION_BACKEND=gemini_api',
      '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
      '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
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
        SYNTHI_VISION_BACKEND: 'gemini_api',
        GOOGLE_API_KEY: CFG.googleApiKey,
        SYNTHI_GEMINI_MODEL: CFG.geminiModel,
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
  const wait = await state.client.toolCall(
    'synthi_wait_hmr',
    { timeoutMs },
    timeoutMs + 5000,
  ).catch((e) => ({ status: 'timeout_or_error', error: e.message }));
  return { compile, wait };
}

function cleanRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
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

async function persistGeneratedSplitToWorkspace(split) {
  const files = Object.entries(split.files).map(([filePath, content]) => ({ path: filePath, content }));
  files.push({ path: '.synthi_split_meta.json', content: split.sidecarRaw });
  files.push({ path: '.synthi/build_manifest.json', content: JSON.stringify(split.manifest, null, 2) + '\n' });
  await writeFilesBatch({ slug: CFG.slug, files });
  record('persist generated split to workspace', 'pass', `${files.length} files`);
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-agent-split-test: persist generated split' })
    .then(() => record('workspace commit generated split', 'pass'))
    .catch((e) => record('workspace commit generated split', 'warn', e.message.slice(0, 200)));
}

async function compileGeneratedDevice(split, editedDevice) {
  split.files[split.roles.device] = editedDevice;
  const allFiles = [
    ...Object.entries(split.files).map(([name, content]) => ({ name, content })),
    { name: '.synthi_split_meta.json', content: split.sidecarRaw },
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
    compile_manifest: split.manifest,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs);
}

async function assertMcpScreenshot() {
  const state = await ensureMcpAttached();
  const capture = async () => {
    const shot = await state.client.toolCallRaw(
      'synthi_screenshot',
      { freshness_max_ms: 15000 },
      30000,
    );
    const image = shot.content.find((b) => b?.type === 'image' && typeof b.data === 'string');
    const meta = shot.json || {};
    return {
      meta,
      width: Number(meta.w || meta.width || 0),
      height: Number(meta.h || meta.height || 0),
      seq: Number(meta.seq || 0),
      bytes: image ? Math.floor(image.data.length * 3 / 4) : 0,
    };
  };
  const first = await capture();
  await sleep(750);
  const second = await capture();
  const ok =
    first.width >= 320 &&
    first.height >= 240 &&
    first.bytes > 512 &&
    second.width === first.width &&
    second.height === first.height &&
    second.bytes > 512 &&
    second.seq > first.seq;
  record(
    'mcp screenshot after hmr',
    ok ? 'pass' : 'fail',
    ok
      ? `${first.width}x${first.height} seq=${first.seq}->${second.seq} bytes~${first.bytes}/${second.bytes}`
      : `invalid screenshot first=${JSON.stringify(first.meta).slice(0, 120)} second=${JSON.stringify(second.meta).slice(0, 120)} bytes~${first.bytes}/${second.bytes}`,
  );
  if (!ok) throw new Error('MCP screenshot after HMR did not return a valid frame');
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

  const split = await readGeneratedSplit(vendor);
  record('read generated split from worker', 'pass', `worker=${split.workspacePath}`);
  validateGeneratedSplit(split);
  await persistGeneratedSplitToWorkspace(split);

  const editedDevice = flipDeviceDirection(split.files[split.roles.device]);
  const secondStart = await workerCheckpoint();
  await compileGeneratedDevice(split, editedDevice);
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

  await assertMcpScreenshot();

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
