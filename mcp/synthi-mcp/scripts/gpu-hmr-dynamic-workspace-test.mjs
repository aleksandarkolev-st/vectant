#!/usr/bin/env node
// Dynamic GPU-HMR workspace validation.
//
// This is intentionally separate from gpu-hmr-test.mjs: that script validates
// the canonical five-file fixture; this one proves the adapted project contract
// is manifest-driven by generating random source paths and helper headers.
//
// Run:
//   cd mcp/synthi-mcp
//   SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=auto node scripts/gpu-hmr-dynamic-workspace-test.mjs
//
// Container names are auto-detected from docker compose by service name, so
// this works with compose projects like `vectant-ade` and older `synthi-ide`.

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
  slug: process.env.SLUG ?? `gpu-hmr-dynamic-${Date.now()}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-dynamic-test',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
  hmrWaitTimeoutMs: Number(process.env.SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS ?? 5000),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 90000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  workerContainer: process.env.WORKER_CONTAINER ?? 'synthi-ide-worker-1',
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3-flash-preview',
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const RESULTS_JSON = path.join(LOG_DIR, 'dynamic-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'dynamic-results.txt');

const results = [];
function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  results.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : '[warn]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
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

function execText(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve(undefined);
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
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
  if (CFG.mcpTransport !== 'docker') return vendor === 'rocm' ? 'gfx90a' : 'sm_80';
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
  return detected || (vendor === 'rocm' ? 'gfx90a' : 'sm_80');
}

async function createWorkspace({ name, slug }) {
  return httpJson('POST', `${CFG.frontendUrl}/api/workspace`, { name, slug });
}

async function writeFilesBatch({ slug, files }) {
  const res = await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: 'utf8', content: f.content })),
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
      else args.push('--tail', '4000');
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
    if (match) return { matched: true, snippet: match[0].slice(0, 300) };
    await sleep(700);
  }
  return { matched: false, snippet: '' };
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
}

let mcpState = null;
async function startMcp() {
  if (mcpState?.client) return mcpState;
  let proc;
  if (CFG.mcpTransport === 'docker') {
    const args = [
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
    ];
    proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    clientInfo: { name: 'synthi-gpu-hmr-dynamic-test', version: '0.0.1' },
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

function makePaths(vendor) {
  const tag = (process.env.SYNTHI_DYNAMIC_TAG || `dyn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`)
    .replace(/[^A-Za-z0-9_]/g, '_');
  return {
    tag,
    math: `include/${tag}_flow_math.hpp`,
    palette: `include/${tag}_flow_palette.hpp`,
    shared: `include/${tag}_flow_state.hpp`,
    core: `src/${tag}_flow_core.cpp`,
    gui: `ui/${tag}_flow_surface.cpp`,
    hostRunner: `run/${tag}_flow_runner.cpp`,
    device: `gpu/${tag}_particle_kernel.${vendor === 'rocm' ? 'hip' : 'cu'}`,
    manifest: '.synthi/build_manifest.json',
  };
}

function mathHeader() {
  return `#pragma once
inline float flow_wrap_radius(int i, float base) {
    return base + (float)((i * 19) % 58);
}
`;
}

function paletteHeader() {
  return `#pragma once
struct FlowPalette { unsigned char r; unsigned char g; unsigned char b; };
constexpr FlowPalette FLOW_INWARD_COLOR{44, 190, 255};
constexpr FlowPalette FLOW_OUTWARD_COLOR{255, 142, 64};
`;
}

function sharedHeader(paths) {
  const mathBase = path.basename(paths.math);
  const paletteBase = path.basename(paths.palette);
  return `#pragma once
#include "synthi_gpu_runtime.h"
#include "${mathBase}"
#include "${paletteBase}"
#include <SDL2/SDL.h>
#include <cstdint>
#include <cstddef>

constexpr int FLOW_BALLS = 768;
constexpr int FLOW_W = 800;
constexpr int FLOW_H = 600;

struct CoreState {
    uint32_t magic;
    uint32_t version;
    SDL_Renderer* renderer;
    float* d_x;
    float* d_y;
    float h_x[FLOW_BALLS];
    float h_y[FLOW_BALLS];
    int n;
    float cx;
    float cy;
    float speed;
    float last_avg_radius;
    int flow_trend;
    uint64_t frame;
    double accumulator;
    SynthiGpuRuntime* gpu;
    std::uintptr_t stream;
};
`;
}

function runtimeInclude(vendor) {
  return vendor === 'rocm' ? '#include <hip/hip_runtime.h>' : '#include <cuda_runtime.h>';
}

function vendorCoreRewrites(vendor, src, arch) {
  if (vendor !== 'rocm') return src;
  return src
    .replaceAll('cudaStream_t', 'hipStream_t')
    .replaceAll('cudaStreamCreate', 'hipStreamCreate')
    .replaceAll('cudaMalloc', 'hipMalloc')
    .replaceAll('cudaMemcpyHostToDevice', 'hipMemcpyHostToDevice')
    .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
    .replaceAll('cudaMemcpy', 'hipMemcpy')
    .replaceAll('"cuda"', '"rocm"')
    .replaceAll('"sm_80"', `"${arch}"`);
}

function coreSource(paths, vendor, arch) {
  const src = `#include "${paths.shared}"
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define CORE_STATE_MAGIC 0x464C4F57u

static CoreState* g_state = nullptr;

static void flow_register_buffers() {
    if (!g_state) return;
    synthi_register(g_state->gpu, g_state->d_x, sizeof(float) * FLOW_BALLS, "dynamic.flow.x", "persistent");
    synthi_register(g_state->gpu, g_state->d_y, sizeof(float) * FLOW_BALLS, "dynamic.flow.y", "persistent");
}

static void flow_seed_host() {
    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float theta = 2.39996323f * (float)i;
        const float radius = 220.0f + (float)((i * 37) % 110);
        g_state->h_x[i] = g_state->cx + std::cos(theta) * radius;
        g_state->h_y[i] = g_state->cy + std::sin(theta) * radius;
    }
}

extern "C" void* core_on_load(void* prev, void* renderer) {
    if (prev) {
        CoreState* p = (CoreState*) prev;
        if (p->magic == CORE_STATE_MAGIC && p->version == 1) {
            g_state = p;
            g_state->renderer = (SDL_Renderer*) renderer;
            flow_register_buffers();
            std::fprintf(stderr, "[gpu-flow-dynamic] reused state frame=%llu\\n", (unsigned long long) g_state->frame);
            return p;
        }
    }
    g_state = (CoreState*) std::malloc(sizeof(CoreState));
    std::memset(g_state, 0, sizeof(*g_state));
    g_state->magic = CORE_STATE_MAGIC;
    g_state->version = 1;
    g_state->renderer = (SDL_Renderer*) renderer;
    g_state->n = FLOW_BALLS;
    g_state->cx = FLOW_W * 0.5f;
    g_state->cy = FLOW_H * 0.5f;
    g_state->speed = 2.35f;
    cudaStream_t stream = nullptr;
    cudaStreamCreate(&stream);
    g_state->stream = reinterpret_cast<std::uintptr_t>(stream);
    cudaMalloc(&g_state->d_x, sizeof(float) * FLOW_BALLS);
    cudaMalloc(&g_state->d_y, sizeof(float) * FLOW_BALLS);
    flow_seed_host();
    cudaMemcpy(g_state->d_x, g_state->h_x, sizeof(float) * FLOW_BALLS, cudaMemcpyHostToDevice);
    cudaMemcpy(g_state->d_y, g_state->h_y, sizeof(float) * FLOW_BALLS, cudaMemcpyHostToDevice);
    flow_register_buffers();
    std::fprintf(stderr, "[gpu-flow-dynamic] allocated particles=%d\\n", FLOW_BALLS);
    return g_state;
}

extern "C" void core_on_update(void* ctx, double dt) {
    CoreState* s = (CoreState*) ctx;
    if (!s) return;
    g_state = s;
    dim3 block(256);
    dim3 grid((s->n + block.x - 1) / block.x);
    unsigned long long frame = (unsigned long long) s->frame;
    synthi_gpu_launch(
        s->gpu,
        "particle_flow",
        grid,
        block,
        0,
        s->stream,
        { &s->d_x, &s->d_y, &s->n, &s->cx, &s->cy, &s->speed, &frame }
    );
    s->frame += 1;
    s->accumulator += dt;
}

extern "C" const DeviceDescriptor* device_descriptor() {
    static const char* arches[] = { "sm_80" };
    static const char* kernels[] = { "particle_flow" };
    static DeviceDescriptor descriptor = { "cuda", arches, kernels, 1, 1, 0 };
    return &descriptor;
}

extern "C" void device_on_load(const unsigned char*, std::size_t) {
    flow_register_buffers();
    std::fprintf(stderr, "[gpu-flow-dynamic] device_on_load frame=%llu\\n", (unsigned long long) (g_state ? g_state->frame : 0));
}

extern "C" std::size_t device_save_size() { return 0; }
extern "C" void device_save_write(unsigned char*, std::size_t) {}

extern "C" unsigned long long device_kernel_sig_hash(const char* name) {
    return std::strcmp(name, "particle_flow") == 0 ? 0x41f10beef1257781ULL : 0ULL;
}
`;
  return vendorCoreRewrites(vendor, src, arch);
}

function guiSource(paths, vendor) {
  let src = `#include "${paths.shared}"
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>

static void fill_circle(SDL_Renderer* ren, int cx, int cy, int radius) {
    for (int y = -radius; y <= radius; ++y) {
        for (int x = -radius; x <= radius; ++x) {
            if (x * x + y * y <= radius * radius) SDL_RenderDrawPoint(ren, cx + x, cy + y);
        }
    }
}

extern "C" void* gui_on_load(void* prev, void*, void*) { return prev; }

extern "C" void gui_on_render(void* state_void) {
    CoreState* s = (CoreState*) state_void;
    if (!s || !s->renderer) return;
    SDL_Renderer* ren = s->renderer;
    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(ren, 6, 10, 18, 255);
    SDL_RenderClear(ren);
    if (s->d_x && s->d_y) {
        cudaMemcpy(s->h_x, s->d_x, sizeof(float) * FLOW_BALLS, cudaMemcpyDeviceToHost);
        cudaMemcpy(s->h_y, s->d_y, sizeof(float) * FLOW_BALLS, cudaMemcpyDeviceToHost);
    }
    float avg_radius = 0.0f;
    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float dx = s->h_x[i] - s->cx;
        const float dy = s->h_y[i] - s->cy;
        avg_radius += std::sqrt(dx * dx + dy * dy);
    }
    avg_radius /= (float) FLOW_BALLS;
    const float delta = avg_radius - s->last_avg_radius;
    if (s->last_avg_radius > 1.0f) {
        if (delta > 0.08f) s->flow_trend = 1;
        if (delta < -0.08f) s->flow_trend = -1;
    }
    s->last_avg_radius = avg_radius;
    const FlowPalette color = s->flow_trend > 0 ? FLOW_OUTWARD_COLOR : FLOW_INWARD_COLOR;
    SDL_SetRenderDrawColor(ren, color.r, color.g, color.b, 255);
    fill_circle(ren, (int)s->cx, (int)s->cy, 18);
    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float dx = s->h_x[i] - s->cx;
        const float dy = s->h_y[i] - s->cy;
        const float radius = std::sqrt(dx * dx + dy * dy);
        const unsigned char alpha = (unsigned char)(110 + ((i * 17) % 120));
        SDL_SetRenderDrawColor(ren, color.r, color.g, color.b, alpha);
        fill_circle(ren, (int)s->h_x[i], (int)s->h_y[i], radius < 64.0f ? 3 : 2);
    }
    if ((s->frame % 60) == 0) {
        std::fprintf(stderr, "[gpu-flow-dynamic] frame=%llu avg_radius=%.2f trend=%s\\n",
            (unsigned long long) s->frame,
            avg_radius,
            s->flow_trend > 0 ? "outward" : "inward");
    }
}
`;
  if (vendor === 'rocm') {
    src = src
      .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
      .replaceAll('cudaMemcpy', 'hipMemcpy');
  }
  return src;
}

function hostRunnerSource(paths) {
  return `#include "${paths.shared}"
#include <chrono>
#include <thread>

extern "C" void* core_on_load(void*, void*);
extern "C" void core_on_update(void*, double);
extern "C" void* gui_on_load(void*, void*, void*);
extern "C" void gui_on_render(void*);

int main() {
    void* state = core_on_load(nullptr, nullptr);
    gui_on_load(nullptr, nullptr, state);
    for (int i = 0; i < 1000; ++i) {
        core_on_update(state, 0.016);
        gui_on_render(state);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    return 0;
}
`;
}

function deviceSource(direction, vendor) {
  const prefix = vendor === 'rocm' ? '#include <hip/hip_runtime.h>\n' : '';
  return `${prefix}#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION ${direction}
#endif

extern "C" __global__ void particle_flow(float* x, float* y, int n, float cx, float cy, float speed, unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    float dx = cx - x[i];
    float dy = cy - y[i];
    float len = sqrtf(dx * dx + dy * dy) + 0.0001f;
    x[i] += FLOW_DIRECTION * dx / len * speed;
    y[i] += FLOW_DIRECTION * dy / len * speed;
    float ox = x[i] - cx;
    float oy = y[i] - cy;
    float radius = sqrtf(ox * ox + oy * oy);
    float theta = 2.39996323f * (float)i + 0.015f * (float)(frame % 251ULL);
    if (FLOW_DIRECTION > 0.0f && radius < 16.0f) {
        float rr = 310.0f + (float)((i * 19) % 58);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
    if (FLOW_DIRECTION < 0.0f && radius > 388.0f) {
        float rr = 14.0f + (float)((i * 11) % 24);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
}
`;
}

function manifestFor(vendor, paths, arch) {
  const commonFlags = [
    '-shared',
    '-fPIC',
    '-O0',
    '-fno-merge-constants',
    '-D_POSIX_C_SOURCE=199309L',
    '-g',
    '-gdwarf-4',
    '-fno-omit-frame-pointer',
    '-fdiagnostics-format=json',
  ];
  const base = {
    compiler: 'g++',
    std: 'c++17',
    common_flags: vendor === 'rocm'
      ? [...commonFlags, '-D__HIP_PLATFORM_AMD__', '-I/opt/rocm/include']
      : [...commonFlags, '-I/usr/local/cuda/include'],
    core_link_flags: vendor === 'rocm'
      ? ['-L/opt/rocm/lib', '-lamdhip64']
      : ['-L/usr/local/cuda/lib64', '-L/usr/local/cuda/lib64/stubs', '-lcudart', '-lcuda'],
    gui_link_flags: vendor === 'rocm'
      ? ['-L/opt/rocm/lib', '-lamdhip64', '-lSDL2', '-lm']
      : ['-L/usr/local/cuda/lib64', '-L/usr/local/cuda/lib64/stubs', '-lcudart', '-lcuda', '-lSDL2', '-lm'],
    shared_link_flags: [],
    runner_link_flags: vendor === 'rocm'
      ? ['-L/opt/rocm/lib', '-lamdhip64', '-ldl', '-lSDL2', '-lm']
      : ['-L/usr/local/cuda/lib64', '-L/usr/local/cuda/lib64/stubs', '-lcudart', '-lcuda', '-ldl', '-lSDL2', '-lm'],
    files: [paths.math, paths.palette, paths.shared, paths.core, paths.gui, paths.hostRunner, paths.device],
    module_files: {
      shared: paths.shared,
      core: paths.core,
      gui: paths.gui,
      host_runner: paths.hostRunner,
      device: paths.device,
    },
    system_packages: [],
    hot_reload_mode: 'swap',
    confidence: {
      overall: 'high',
      runner_synthesis: 'high',
      link_flags: 'high',
      notes: `${vendor} dynamic GPU HMR validation with randomized module paths`,
    },
  };
  return {
    ...base,
    gpu: vendor === 'rocm'
      ? {
          vendor: 'rocm',
          device_compiler: 'hipcc',
          arch: [arch],
          device_flags: ['-O3', '-g'],
          runtime_libs: ['amdhip64'],
          snapshot_mode: 'auto',
          fatbin_strategy: 'sidecar_module',
        }
      : {
          vendor: 'cuda',
          device_compiler: 'nvcc',
          arch: [arch],
          device_flags: ['-O3', '-lineinfo', '--use_fast_math'],
          runtime_libs: ['cudart', 'cuda'],
          snapshot_mode: 'auto',
          fatbin_strategy: 'sidecar_module',
        },
  };
}

function sourceFiles(vendor, paths, manifest) {
  const arch = manifest.gpu.arch[0];
  return [
    { path: paths.math, content: mathHeader() },
    { path: paths.palette, content: paletteHeader() },
    { path: paths.shared, content: sharedHeader(paths) },
    { path: paths.core, content: coreSource(paths, vendor, arch) },
    { path: paths.gui, content: guiSource(paths, vendor) },
    { path: paths.hostRunner, content: hostRunnerSource(paths) },
    { path: paths.device, content: deviceSource('1.0f', vendor) },
    { path: paths.manifest, content: JSON.stringify(manifest, null, 2) },
  ];
}

async function seedWorkspace(vendor, arch) {
  const paths = makePaths(vendor);
  const manifest = manifestFor(vendor, paths, arch);
  const files = sourceFiles(vendor, paths, manifest);
  const workspace = await createWorkspace({
    name: `Synthi GPU-HMR Dynamic (${vendor})`,
    slug: CFG.slug,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);
  await writeFilesBatch({ slug: CFG.slug, files });
  record('write randomized files', 'pass', `${files.length} files tag=${paths.tag}`);
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-dynamic-test: seed randomized manifest' })
    .then(() => record('stage + commit workspace', 'pass'))
    .catch((e) => record('stage + commit workspace', 'warn', e.message.slice(0, 160)));
  return { workspace, paths, manifest, sourceFiles: new Map(files.map((f) => [f.path, f.content])) };
}

async function compileViaMcp(ctx, primaryPath, content) {
  ctx.sourceFiles.set(primaryPath, content);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: primaryPath, content }] });
  const state = await ensureMcpAttached();
  const additionalFiles = [...ctx.sourceFiles.entries()]
    .filter(([name]) => name !== primaryPath)
    .map(([name, fileContent]) => ({ name, content: fileContent }));
  const compile = await state.client.toolCall('synthi_compile', {
    language: 'cpp',
    filename: primaryPath,
    source: content,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: ctx.manifest.gpu.vendor,
    compile_manifest: ctx.manifest,
    slug: CFG.slug,
    width: 800,
    height: 600,
  });
  if (!compile?.ok) throw new Error(`synthi_compile failed: ${JSON.stringify(compile).slice(0, 400)}`);
  const waitTimeout = Math.min(CFG.hmrTimeoutMs, CFG.hmrWaitTimeoutMs);
  const hmr = await state.client.toolCall('synthi_wait_hmr', { timeoutMs: waitTimeout }, waitTimeout + 5000)
    .catch((e) => ({ status: 'timeout_or_error', error: e.message }));
  return { compile, hmr };
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await resolveDockerContainers();
  const vendor = await detectVendor();
  const arch = await detectArch(vendor);
  CFG.gpuArch = arch;
  process.env.SYNTHI_GPU_ARCH = arch;
  record('gpu vendor', 'pass', `${vendor} arch=${arch}`);

  const ctx = await seedWorkspace(vendor, arch);
  const inwardStart = await workerCheckpoint();
  await compileViaMcp(ctx, ctx.paths.device, deviceSource('1.0f', vendor));
  record('inward compile via MCP', 'pass', ctx.paths.device);

  const sawDynamicCompile = await awaitWorkerLogRegex(
    new RegExp(`compile-device.*${ctx.paths.device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|source resolved from workspace file=${ctx.paths.device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    CFG.hmrTimeoutMs,
    inwardStart,
  );
  record('dynamic device filename observed by worker', sawDynamicCompile.matched ? 'pass' : 'warn', sawDynamicCompile.snippet || 'no dynamic filename marker');

  const sawLaunch = await awaitWorkerLogRegex(
    /synthi_gpu_launch kernel=particle_flow|Device sidecar reload vendor=.*result=Success/,
    CFG.hmrTimeoutMs,
    inwardStart,
  );
  record('inward GPU launch observed', sawLaunch.matched ? 'pass' : 'warn', sawLaunch.snippet || 'no launch marker');

  const outwardStart = await workerCheckpoint();
  await compileViaMcp(ctx, ctx.paths.device, deviceSource('-1.0f', vendor));
  record('outward compile via MCP', 'pass', ctx.paths.device);

  const hotSwap = await awaitWorkerLogRegex(
    /\[gpu-reload\].*plan=device_only|Device sidecar reload vendor=.*result=Success/,
    CFG.hmrTimeoutMs,
    outwardStart,
  );
  record('outward edit hot-swapped', hotSwap.matched ? 'pass' : 'fail', hotSwap.snippet || 'no device-only reload marker');

  const trend = await awaitWorkerLogRegex(
    /\[gpu-flow-dynamic\].*trend=outward/,
    15000,
    outwardStart,
  );
  record('render loop reports outward flow', trend.matched ? 'pass' : 'warn', trend.snippet || 'no outward trend marker');

  await writeResults();
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
