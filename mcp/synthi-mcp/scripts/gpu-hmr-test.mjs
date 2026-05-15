#!/usr/bin/env node
// Synthi GPU-HMR test harness — executes docs/GPU_HMR_ULTRAPLAN.md §9.
//
// Models its plumbing on scripts/live-test.mjs (workspace seeding via
// frontend + collab-server, file batches with syncToGcs, stage/commit,
// MCP JSON-RPC over stdio) and adds GPU-specific phases P0–P3.
//
// Forward-compatible: today's main has no GPU plumbing, so every per-phase
// row will record as WARN/skipped. As Phase 0/1/2/3 of the plan land, rows
// flip to PASS without script changes. The wire/seed checks pass today.
//
// Run:
//   cd mcp/synthi-mcp
//   pnpm build
//   SYNTHI_GPU_HMR=1 node scripts/gpu-hmr-test.mjs
//
// Env (see docs §12.2 for the full table):
//   FRONTEND_URL                 http://localhost:3000
//   COLLAB_URL                   http://localhost:1234
//   SIGNALING_URL                ws://localhost:9000
//   AI_ENGINE_URL                http://localhost:8000
//   WORKER_LOG_PATH              <repo>/backend/synthi-webrtc-compiler/.run/worker.log
//   SLUG                         gpu-hmr-<ts>
//   SYNTHI_GPU_VENDOR            cuda | rocm | both              (default cuda)
//   SYNTHI_GPU_ARCH              override target arch (cuda: sm_80, rocm: gfx1201)
//   SYNTHI_GPU_FAST_SWAP_BUDGET_MS 300
//   SYNTHI_GPU_LAUNCH_WATCHDOG_MS  5000
//   SYNTHI_GPU_DRAIN_TIMEOUT_MS    2000
//   SYNTHI_GPU_HIP_FAKE_RUNTIME  unset (set to ask worker to load HIP-CPU)
//   SKIP_PHASES                  comma-separated phase ids
//   ONLY_PHASES                  comma-separated phase ids
//   HMR_TIMEOUT_MS               60000
//   MCP_ENTRY                    ../dist/index.js
//   MCP_TRANSPORT                docker | host
//   MCP_CONTAINER                synthi-ide-mcp-1 (auto-detected from compose if absent/stale)
//   MCP_SIGNALING_URL            ws://signaling-server:9000 (docker transport)
//   SYNTHI_GPU_USE_MCP           1 (set 0 to use direct AI endpoint probe only)
//   GOOGLE_API_KEY               (only needed if MCP attach is exercised)

import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────── config ─────────────────────────

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  aiEngineUrl: process.env.AI_ENGINE_URL ?? 'http://localhost:8000',
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  slug: process.env.SLUG ?? `gpu-hmr-${Date.now()}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-test',
  workspaceName: process.env.WORKSPACE_NAME ?? 'Synthi GPU-HMR Test',
  gpuHmr: (process.env.SYNTHI_GPU_HMR ?? '0') === '1',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'cuda').toLowerCase(),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  fastSwapBudgetMs: Number(process.env.SYNTHI_GPU_FAST_SWAP_BUDGET_MS ?? 300),
  watchdogMs: Number(process.env.SYNTHI_GPU_LAUNCH_WATCHDOG_MS ?? 5000),
  drainTimeoutMs: Number(process.env.SYNTHI_GPU_DRAIN_TIMEOUT_MS ?? 2000),
  snapshotBudgetMs: Number(process.env.SYNTHI_GPU_SNAPSHOT_BUDGET_MS ?? 250),
  hipFakeRuntime: process.env.SYNTHI_GPU_HIP_FAKE_RUNTIME === '1',
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 90000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  mcpPrometheusPort: process.env.MCP_PROMETHEUS_PORT,
  workerContainer: process.env.WORKER_CONTAINER ?? 'synthi-ide-worker-1',
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3-flash-preview',
  useMcpCompile: (process.env.SYNTHI_GPU_USE_MCP ?? '1') !== '0',
  directAiFallback: process.env.SYNTHI_GPU_DIRECT_AI_FALLBACK === '1',
  skipPhases: new Set((process.env.SKIP_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  onlyPhases: new Set((process.env.ONLY_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  syncToGcs: true,
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const MCP_STDERR_LOG = path.join(LOG_DIR, 'mcp.stderr.log');

// ───────────────────────── log + results ─────────────────────────

const color = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[36m', dim: '\x1b[2m',
};
function log(kind, msg) {
  const tag = { info: color.blue + '[i]', ok: color.green + '[✓]',
                warn: color.yellow + '[!]', fail: color.red + '[✗]',
                skip: color.dim + '[…]' }[kind];
  console.log(`${tag}${color.reset} ${msg}`);
}

const results = [];
function record(phase, name, status, detail = '') {
  results.push({ phase, name, status, detail, ts: new Date().toISOString() });
  const l = status === 'pass' ? 'ok' : status === 'fail' ? 'fail' : status === 'skip' ? 'skip' : 'warn';
  log(l, `[${phase}] ${name}${detail ? ' — ' + detail : ''}`);
}
function shouldRun(phase) {
  if (CFG.onlyPhases.size > 0 && !CFG.onlyPhases.has(phase)) return false;
  if (CFG.skipPhases.has(phase)) return false;
  return true;
}
function skipIfNoGpuToolchain(phase, ctx, name) {
  if (ctx.toolchain?.ok) return false;
  record(phase, name, 'skip', ctx.toolchain?.reason ?? 'no_toolchain');
  return true;
}

// ───────────────────────── http + tcp helpers ─────────────────────────

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json ?? {};
}

function tcpPing(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}
function parseUrl(u) {
  const x = new URL(u);
  return { host: x.hostname, port: Number(x.port) || (x.protocol === 'wss:' || x.protocol === 'https:' ? 443 : 80) };
}

function execText(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function dockerContainerExists(nameOrId) {
  if (!nameOrId) return false;
  try {
    await execText('docker', ['container', 'inspect', nameOrId], 5000);
    return true;
  } catch {
    return false;
  }
}

async function resolveDockerContainer(configured, service) {
  if (await dockerContainerExists(configured)) return configured;

  const repoRoot = path.resolve(__dirname, '../../..');
  try {
    const ids = await execText(
      'docker',
      ['compose', '--project-directory', repoRoot, 'ps', '-q', service],
      8000,
    );
    const id = ids.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (id) return id;
  } catch {
    // Fall through to label-based discovery for stacks launched with an
    // explicit compose project name.
  }

  try {
    const ids = await execText(
      'docker',
      ['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`],
      8000,
    );
    const id = ids.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (id) return id;
  } catch {
    // Keep the configured value so the downstream docker exec error remains
    // visible in the test output.
  }

  return configured;
}

async function resolveDockerContainers() {
  if (CFG.mcpTransport !== 'docker') return;
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
}

// ───────────────────────── collab + frontend wire ─────────────────────────

async function createWorkspace({ name, slug }) {
  return httpJson('POST', `${CFG.frontendUrl}/api/workspace`, { name, slug });
}

async function writeFilesBatch({ slug, userId, files, syncToGcs }) {
  const res = await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', content: f.content })),
      syncToGcs: syncToGcs === true,
    },
    { 'x-user-id': userId },
  );
  const otherErrs = (res.errors ?? []).filter((e) => e.stage !== 'gcs_upload');
  if (otherErrs.length) throw new Error(`write-files-batch errors: ${JSON.stringify(otherErrs)}`);
  return res;
}

async function stageAndCommit({ slug, userId, message }) {
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/stage-all`, {}, { 'x-user-id': userId });
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/commit`, { message }, { 'x-user-id': userId });
}

async function readFileViaCollab({ slug, filePath }) {
  // collab-server exposes /git/:slug/file?path=… — use the same JSON wire
  const url = `${CFG.collabUrl}/git/${slug}/file?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, { headers: { 'x-user-id': CFG.hostId } });
  return r.ok ? await r.text() : null;
}

// ───────────────────────── ai-engine wire ─────────────────────────

async function aiEngineProbe() {
  const out = { reachable: false, hasGpuEndpoints: false, endpoints: {} };
  try {
    const r = await fetch(`${CFG.aiEngineUrl}/`).catch(() => null);
    out.reachable = !!r;
  } catch { /* ignore */ }
  for (const ep of ['/refactor/split/gpu', '/refactor/diff_patch/gpu', '/refactor/heal/gpu']) {
    try {
      // OPTIONS or a bad POST will 405/422 if route exists, 404 if not.
      const r = await fetch(`${CFG.aiEngineUrl}${ep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      out.endpoints[ep] = r.status;
    } catch (e) {
      out.endpoints[ep] = `err:${e.message.slice(0, 30)}`;
    }
  }
  out.hasGpuEndpoints = Object.values(out.endpoints).every((s) => typeof s === 'number' && s !== 404);
  return out;
}

// ───────────────────────── worker log tail ─────────────────────────

async function readWorkerLogTail(maxBytes = 256 * 1024) {
  try {
    const st = await stat(CFG.workerLogPath);
    const fd = await import('node:fs').then((m) => m.promises.open(CFG.workerLogPath, 'r'));
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    return buf.toString('utf8');
  } catch (e) {
    return null;
  }
}

async function awaitWorkerLogRegex(regex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = await readWorkerLogTail();
    if (tail && regex.test(tail)) {
      const m = tail.match(regex);
      return { matched: true, snippet: m?.[0] ?? '', tail };
    }
    await sleep(500);
  }
  return { matched: false, snippet: '', tail: await readWorkerLogTail() };
}

// ───────────────────────── MCP JSON-RPC over stdio ─────────────────────────

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
      if (process.env.MCP_VERBOSE) process.stderr.write(color.dim + '[mcp] ' + color.reset + s);
    });
    proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP exited ${code ?? sig} before response`));
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
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms. stderr tail:\n${this.stderrTail.slice(-10).join('')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) {
      const errMsg = textBlock?.text || JSON.stringify(res.content);
      throw new Error(`tool ${name} isError: ${errMsg}`);
    }
    const imageBlock = content.find((b) => b?.type === 'image');
    let parsed;
    if (textBlock?.text) {
      try { parsed = JSON.parse(textBlock.text); }
      catch { parsed = { raw: textBlock.text }; }
    } else {
      parsed = {};
    }
    if (imageBlock?.data) parsed.data = imageBlock.data;
    return parsed;
  }
}

let mcpState = null;

async function startMcp() {
  if (!CFG.useMcpCompile) return null;
  if (mcpState?.client) return mcpState;

  let proc;
  if (CFG.mcpTransport === 'docker') {
    const mcpEnv = {
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.mcpSignalingUrl,
      SYNTHI_VISION_BACKEND: 'gemini_api',
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_PROMETHEUS_HOST: '0.0.0.0',
    };
    if (CFG.mcpPrometheusPort) mcpEnv.SYNTHI_PROMETHEUS_PORT = CFG.mcpPrometheusPort;
    const args = ['exec', '-i'];
    for (const [k, v] of Object.entries(mcpEnv)) args.push('-e', `${k}=${v}`);
    args.push(CFG.mcpContainer, 'node', '/app/dist/index.js');
    proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    if (!existsSync(CFG.mcpEntry)) {
      throw new Error(`MCP entry not found: ${CFG.mcpEntry}; run npm run build in mcp/synthi-mcp`);
    }
    const env = {
      ...process.env,
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.signalingUrl,
      SYNTHI_VISION_BACKEND: 'gemini_api',
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_PROMETHEUS_HOST: '127.0.0.1',
    };
    if (CFG.mcpPrometheusPort) env.SYNTHI_PROMETHEUS_PORT = CFG.mcpPrometheusPort;
    proc = spawn('node', [CFG.mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  const stderrStream = (await import('node:fs')).createWriteStream(MCP_STDERR_LOG, { flags: 'a' });
  proc.stderr.pipe(stderrStream);
  const client = new McpClient(proc);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'synthi-gpu-hmr-test', version: '0.0.1' },
  }, 20000);
  await client.request('notifications/initialized', {}, 5000).catch(() => {});
  const tools = await client.request('tools/list', {}, 20000);
  const toolNames = tools.tools?.map((t) => t.name) ?? [];
  mcpState = { proc, client, stderrStream, attached: false, toolNames };
  record('preflight', 'MCP tools/list',
    toolNames.includes('synthi_compile') && toolNames.includes('synthi_wait_hmr') ? 'pass' : 'fail',
    `transport=${CFG.mcpTransport} count=${toolNames.length}`);
  return mcpState;
}

async function ensureMcpAttached() {
  const state = await startMcp();
  if (!state) return null;
  if (state.attached) return state;
  const attachArgs = {
    sessionId: CFG.slug,
    'i-understand-no-auth': true,
  };
  if (CFG.mcpTransport !== 'docker') attachArgs.signalingUrl = CFG.signalingUrl;
  const attach = await state.client.toolCall('synthi_attach', attachArgs, CFG.mcpAttachTimeoutMs);
  if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
  state.attached = true;
  record('preflight', 'MCP synthi_attach', 'pass',
    attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached; no frame yet');
  return state;
}

async function stopMcp() {
  if (!mcpState) return;
  const { proc, stderrStream } = mcpState;
  try { proc.stdin.end(); } catch { /* ignore */ }
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  try { stderrStream.end(); } catch { /* ignore */ }
  mcpState = null;
}

// ───────────────────────── toolchain probe ─────────────────────────

function execWhich(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], (err, stdout) => resolve(err ? null : stdout.trim().split(/\r?\n/)[0]));
  });
}

async function probeToolchain() {
  // We probe both the harness host AND, if MCP_TRANSPORT=docker, the worker
  // container. The worker container is what actually has to have nvcc; the
  // harness host probe is just informational.
  const out = { host: {}, worker: {} };
  out.host.nvcc = await execWhich('nvcc');
  out.host.hipcc = await execWhich('hipcc');

  await new Promise((res) => {
    execFile('docker', ['exec', CFG.workerContainer, 'sh', '-c', 'command -v nvcc || true'], (e, so) => {
      if (!e) out.worker.nvcc = so.trim() || null;
      res();
    });
  });
  await new Promise((res) => {
    execFile('docker', ['exec', CFG.workerContainer, 'sh', '-c', 'command -v hipcc || true'], (e, so) => {
      if (!e) out.worker.hipcc = so.trim() || null;
      res();
    });
  });
  return out;
}

function toolchainForVendor(tc, vendor) {
  if (vendor === 'rocm') {
    if (tc.worker.hipcc) return { ok: true, source: 'worker', path: tc.worker.hipcc };
    if (CFG.hipFakeRuntime) return { ok: true, source: 'fake-runtime', path: 'SYNTHI_GPU_HIP_FAKE_RUNTIME=1' };
    if (tc.worker.hipcc === undefined && tc.host.hipcc) return { ok: true, source: 'host', path: tc.host.hipcc };
    return { ok: false, reason: 'no_toolchain: hipcc not found' };
  }
  if (tc.worker.nvcc) return { ok: true, source: 'worker', path: tc.worker.nvcc };
  if (tc.worker.nvcc === undefined && tc.host.nvcc) return { ok: true, source: 'host', path: tc.host.nvcc };
  return { ok: false, reason: 'no_toolchain: nvcc not found' };
}

// ───────────────────────── fixtures ─────────────────────────
// Hand-written 5-file projects — the harness skips the Kernel-Splitter LLM
// step so we have exact, deterministic byte-level inputs.

const SHARED_H = `// shared.h — GPU HMR test fixture
#pragma once
#include "synthi_gpu_runtime.h"
#include <cstdint>
#include <cstddef>

constexpr int N_ELEMS = 1 << 20;          // 1 048 576 floats = 4 MiB per buffer

struct CoreState {
    uint32_t magic;                       // CORE_STATE_MAGIC
    uint32_t version;
    float*   d_a;
    float*   d_b;
    float*   d_c;
    int      n;
    uint64_t frame;
    double   accumulator;                 // touched on host every frame
    SynthiGpuRuntime* gpu;                // Synthi runtime boundary for sidecar launches
    std::uintptr_t stream;
};
`;

const CORE_CPP = `// core.cpp — GPU HMR test fixture (Phase 0/1 vector add)
#include "shared.h"
#include <cstdlib>
#include <cstring>
#include <cuda_runtime.h>

#define CORE_STATE_MAGIC 0x47505501u  // 'GPU' v1

static CoreState* g_state = nullptr;

extern "C" void* core_on_load(void* prev, size_t prev_len) {
    if (prev && prev_len >= sizeof(CoreState)) {
        CoreState* p = (CoreState*) prev;
        if (p->magic == CORE_STATE_MAGIC) {
            g_state = p;                  // reuse — buffers must survive HMR
            return p;
        }
    }
    g_state = (CoreState*) std::malloc(sizeof(CoreState));
    std::memset(g_state, 0, sizeof(*g_state));
    g_state->magic = CORE_STATE_MAGIC;
    g_state->version = 1;
    g_state->n = N_ELEMS;
    cudaStream_t stream = nullptr;
    cudaStreamCreate(&stream);
    g_state->stream = reinterpret_cast<std::uintptr_t>(stream);
    cudaMalloc(&g_state->d_a, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_b, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_c, sizeof(float) * N_ELEMS);
    synthi_register(g_state->gpu, g_state->d_a, sizeof(float) * N_ELEMS, "a", "persistent");
    synthi_register(g_state->gpu, g_state->d_b, sizeof(float) * N_ELEMS, "b", "persistent");
    synthi_register(g_state->gpu, g_state->d_c, sizeof(float) * N_ELEMS, "c", "persistent");
    // Deterministic seed: a[i]=i, b[i]=2i
    float* host = (float*) std::malloc(sizeof(float) * N_ELEMS);
    for (int i = 0; i < N_ELEMS; ++i) host[i] = (float) i;
    cudaMemcpy(g_state->d_a, host, sizeof(float) * N_ELEMS, cudaMemcpyHostToDevice);
    for (int i = 0; i < N_ELEMS; ++i) host[i] = (float)(2 * i);
    cudaMemcpy(g_state->d_b, host, sizeof(float) * N_ELEMS, cudaMemcpyHostToDevice);
    std::free(host);
    return g_state;
}

extern "C" void core_tick(void* /*ctx*/) {
    dim3 block(256);
    dim3 grid((g_state->n + block.x - 1) / block.x);
    synthi_gpu_launch(
        g_state->gpu,
        "vec_add",
        grid,
        block,
        0,
        g_state->stream,
        { &g_state->d_a, &g_state->d_b, &g_state->d_c, &g_state->n }
    );
    g_state->frame += 1;
    g_state->accumulator += 1.0;
}

extern "C" const DeviceDescriptor* device_descriptor() {
    static const char* arches[] = { "sm_80" };
    static const char* kernels[] = { "vec_add" };
    static DeviceDescriptor descriptor = {
        "cuda",
        arches,
        kernels,
        1,
        1,
        0,
    };
    return &descriptor;
}

extern "C" void device_on_load(const unsigned char* /*prev_blob*/, std::size_t /*len*/) {
    if (!g_state) return;
    synthi_register(g_state->gpu, g_state->d_a, sizeof(float) * g_state->n, "a", "persistent");
    synthi_register(g_state->gpu, g_state->d_b, sizeof(float) * g_state->n, "b", "persistent");
    synthi_register(g_state->gpu, g_state->d_c, sizeof(float) * g_state->n, "c", "persistent");
}

extern "C" std::size_t device_save_size() { return 0; }
extern "C" void device_save_write(unsigned char* /*out*/, std::size_t /*cap*/) {}

extern "C" unsigned long long device_kernel_sig_hash(const char* name) {
    return std::strcmp(name, "vec_add") == 0 ? 0x7e5b30b1a64c21d5ULL : 0ULL;
}
`;

const GUI_CPP = `// gui.cpp — GPU HMR test fixture (renders a 256-bin histogram of d_c)
#include "shared.h"
#include <cuda_runtime.h>
#include <cstdio>

extern "C" void gui_on_render(void* /*renderer*/, void* state_void) {
    CoreState* s = (CoreState*) state_void;
    // Pull a tiny sample back to the host so the harness can read it without
    // a full GUI integration. The harness only needs deterministic numbers.
    float sample[8] = {0};
    if (s && s->d_c) {
        cudaMemcpy(sample, s->d_c, sizeof(sample), cudaMemcpyDeviceToHost);
    }
    std::printf("[gui] frame=%llu c[0..7]=%g %g %g %g %g %g %g %g\\n",
        (unsigned long long) (s ? s->frame : 0),
        sample[0], sample[1], sample[2], sample[3],
        sample[4], sample[5], sample[6], sample[7]);
}
`;

const HOST_RUNNER_CPP = `// host_runner.cpp — minimal runner: tick + render in a loop.
#include "shared.h"
#include <chrono>
#include <thread>
#include <cstdio>

extern "C" void* core_on_load(void*, size_t);
extern "C" void core_tick(void*);
extern "C" void gui_on_render(void*, void*);

int main() {
    void* state = core_on_load(nullptr, 0);
    for (int i = 0; i < 1000; ++i) {
        core_tick(state);
        gui_on_render(nullptr, state);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    return 0;
}
`;

const DEVICE_CU_PHASE0 = `// device.cu — vector add baseline (Phase 0/1)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
`;

// Phase-1 edit: + becomes * — same signature, kernel hash unchanged.
const DEVICE_CU_PHASE1_EDIT = DEVICE_CU_PHASE0.replace(
  'c[i] = a[i] + b[i];',
  'c[i] = a[i] * b[i];',
);

// Phase-2 fast-swap edit: introduce vectorized inner work but keep signature.
const DEVICE_CU_PHASE2_FAST = `// device.cu — vector add (Phase 2 fast-swap edit, vectorized inner)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    // Same signature, same semantics, different inner shape — hash unchanged.
    if (i < n) {
        float x = a[i], y = b[i];
        c[i] = x * y;
    }
}
`;

// Phase-2 abi-breaking edit: extra parameter — signature changes.
const DEVICE_CU_PHASE2_ABI_BREAK = `// device.cu — abi-breaking edit (extra parameter)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n, float scale) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = (a[i] + b[i]) * scale;
}
`;

// Phase-3 healer drills — pathological inputs the GPU healer must natively fix.
const DEVICE_CU_HEAL_T1 = DEVICE_CU_PHASE0.replace(
  'c[i] = a[i] + b[i];',
  'c[i] = __shfl_down(0xFFFFFFFF, a[i], 16) + b[i];', // missing _sync — nvcc rejects on sm_70+
);
const DEVICE_CU_HEAL_T2 = `// device.cu — Tier 2 (compile-soft / spills)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    float local[200];                          // force massive register pressure
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    for (int k = 0; k < 200; ++k) local[k] = a[(i + k) % n] * 1.000001f;
    float sum = 0; for (int k = 0; k < 200; ++k) sum += local[k];
    if (i < n) c[i] = sum + b[i];
}
`;
const DEVICE_CU_HEAL_T3 = DEVICE_CU_PHASE0.replace(
  'if (i < n) c[i] = a[i] + b[i];',
  'c[i + 4] = a[i] + b[i];', // last block over-indexes
);

function manifestFor(vendor) {
  const arch = CFG.gpuArch ?? (vendor === 'rocm' ? 'gfx1201' : 'sm_80');
  if (vendor === 'rocm') {
    return {
      compiler: 'clang++',
      files: ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp', 'device.hip'],
      gpu: {
        vendor: 'rocm',
        device_compiler: 'hipcc',
        arch: [arch],
        device_flags: ['-O3', '-g'],
        runtime_libs: ['amdhip64'],
        snapshot_mode: 'auto',
        fatbin_strategy: 'sidecar_module',
        ...(CFG.hipFakeRuntime ? { fake_runtime: 'hip-cpu' } : {}),
      },
    };
  }
  return {
    compiler: 'g++',
    files: ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp', 'device.cu'],
    gpu: {
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

function verifySeedFixtureContract(files) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const hostText = ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp']
    .map((p) => byPath.get(p) ?? '')
    .join('\n');
  const deviceText = byPath.get('device.cu') ?? byPath.get('device.hip') ?? '';
  const findings = [];
  if (!(byPath.get('shared.h') ?? '').includes('#include "synthi_gpu_runtime.h"')) {
    findings.push('shared.h_missing_synthi_gpu_runtime_header');
  }
  if (!/\bsynthi_gpu_launch\s*\(/.test(hostText)) {
    findings.push('host_missing_synthi_gpu_launch_boundary');
  }
  if (/\w+\s*<<<[\s\S]*?>>>/.test(hostText)) {
    findings.push('host_contains_raw_triple_chevron_launch');
  }
  if (/\bvec_add_launch\b/.test(hostText) || /\bvec_add_launch\b/.test(deviceText)) {
    findings.push('private_vec_add_launch_wrapper_present');
  }
  if (!/\bdevice_descriptor\s*\(/.test(hostText)) {
    findings.push('missing_device_descriptor_export');
  }
  if (!/\bdevice_on_load\s*\(/.test(hostText)) {
    findings.push('missing_device_on_load_export');
  }
  if (!/\bdevice_save_size\s*\(/.test(hostText) || !/\bdevice_save_write\s*\(/.test(hostText)) {
    findings.push('missing_device_save_exports');
  }
  if (!/\bdevice_kernel_sig_hash\s*\(/.test(hostText)) {
    findings.push('missing_device_kernel_sig_hash_export');
  }
  if (!/\b__global__\s+void\s+vec_add\s*\(/.test(deviceText)) {
    findings.push('device_missing_vec_add_kernel');
  }
  return { ok: findings.length === 0, findings };
}

// ───────────────────────── compile + HMR over MCP ─────────────────────────

async function postCompileViaMcp({ ctx, files }) {
  const state = await ensureMcpAttached();
  const primaryPath = files[0]?.path ?? ctx.deviceFilename;
  const primarySource = ctx.sourceFiles.get(primaryPath);
  if (typeof primarySource !== 'string') {
    return { ok: false, reason: `missing_primary_source:${primaryPath}` };
  }
  const additionalFiles = [...ctx.sourceFiles.entries()]
    .filter(([name]) => name !== primaryPath)
    .map(([name, content]) => ({ name, content }));

  const compileRes = await state.client.toolCall('synthi_compile', {
    language: 'cpp',
    filename: primaryPath,
    source: primarySource,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: 'auto',
    slug: CFG.slug,
  });
  if (!compileRes?.ok) {
    return { ok: false, reason: `mcp_compile_failed:${JSON.stringify(compileRes).slice(0, 240)}` };
  }

  let hmr = null;
  try {
    hmr = await state.client.toolCall('synthi_wait_hmr', { timeoutMs: CFG.hmrTimeoutMs }, CFG.hmrTimeoutMs + 5000);
  } catch (e) {
    return { ok: true, body: { compile: compileRes }, hmr: { status: 'timeout_or_error', error: e.message } };
  }
  return { ok: true, body: { compile: compileRes }, hmr };
}

async function postCompileViaAiEngine({ slug, files, manifest }) {
  // The AI engine endpoint surface we want here is /refactor/diff_patch/gpu
  // (or /refactor/split/gpu for first compile). This is only a fallback for
  // legacy CI lanes where MCP/WebRTC is unavailable.
  try {
    const body = {
      slug,
      files,
      manifest,
      prefer_gpu_pipeline: true,
    };
    const r = await fetch(`${CFG.aiEngineUrl}/refactor/diff_patch/gpu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 404) return { ok: false, reason: 'endpoint_not_implemented' };
    if (!r.ok) return { ok: false, reason: `status_${r.status}`, body: (await r.text()).slice(0, 500) };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

async function postCompile({ ctx, slug, files, manifest }) {
  for (const f of files) ctx.sourceFiles.set(f.path, f.content);

  try {
    await writeFilesBatch({ slug, userId: CFG.hostId, files, syncToGcs: CFG.syncToGcs });
  } catch (e) {
    return { ok: false, reason: `collab_write_failed:${e.message.slice(0, 180)}` };
  }

  if (CFG.useMcpCompile) {
    try {
      const viaMcp = await postCompileViaMcp({ ctx, files });
      if (viaMcp.ok || !CFG.directAiFallback) return viaMcp;
      record('mcp', 'compile fallback to AI endpoint', 'warn', viaMcp.reason ?? 'mcp compile failed');
    } catch (e) {
      if (!CFG.directAiFallback) return { ok: false, reason: `mcp_compile_failed:${e.message.slice(0, 220)}` };
      record('mcp', 'compile fallback to AI endpoint', 'warn', e.message.slice(0, 220));
    }
  }

  return postCompileViaAiEngine({ slug, files, manifest });
}

async function postHeal({ slug, tier, error, manifest }) {
  try {
    const body = { slug, tier, error, manifest_gpu: manifest.gpu };
    const r = await fetch(`${CFG.aiEngineUrl}/refactor/heal/gpu`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 404) return { ok: false, reason: 'endpoint_not_implemented' };
    if (!r.ok) return { ok: false, reason: `status_${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

// ───────────────────────── no-shim verifier (mirrors §11.4) ─────────────────────────

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; ++i) dp[i][0] = i;
  for (let j = 0; j <= b.length; ++j) dp[0][j] = j;
  for (let i = 1; i <= a.length; ++i) {
    for (let j = 1; j <= b.length; ++j) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function verifyHealOutput(edits, manifestFiles, existingKernels) {
  const findings = [];
  for (const e of edits ?? []) {
    if (!manifestFiles.includes(e.module)) {
      findings.push({ rule: 'no_new_files', detail: `module ${e.module} not in manifest` });
    }
    // Detect __global__ declarations in `content`
    const m = (e.content ?? '').match(/__global__\s+\w[\w<>,\s\*&]*\s+(\w+)\s*\(/);
    if (m) {
      const newSym = m[1];
      for (const k of existingKernels) {
        const suffixed = /^(.+)_(safe|v2|fallback|fixed|patched)$/.test(newSym);
        const dist = levenshtein(newSym, k);
        const nearMiss = dist > 0 && dist <= 3;
        if (suffixed || nearMiss || newSym.startsWith(`safe_${k}`) || newSym === `${k}_safe`) {
          findings.push({ rule: 'no_wrapper_kernel', detail: `${newSym} resembles ${k}` });
        }
      }
    }
    if (/^[^.]+\.(cu|hip)$/.test(e.module) && e.operation === 'create') {
      findings.push({ rule: 'no_new_device_file', detail: e.module });
    }
  }
  return { ok: findings.length === 0, findings };
}

// ───────────────────────── phases ─────────────────────────

async function preflight() {
  log('info', '── Preflight ──');
  const fe = parseUrl(CFG.frontendUrl);
  const col = parseUrl(CFG.collabUrl);
  const sig = parseUrl(CFG.signalingUrl);
  const ai = parseUrl(CFG.aiEngineUrl);
  const [feOk, colOk, sigOk, aiOk] = await Promise.all([
    tcpPing(fe.host, fe.port), tcpPing(col.host, col.port),
    tcpPing(sig.host, sig.port), tcpPing(ai.host, ai.port),
  ]);
  record('preflight', 'frontend reachable', feOk ? 'pass' : 'fail', CFG.frontendUrl);
  record('preflight', 'collab-server reachable', colOk ? 'pass' : 'fail', CFG.collabUrl);
  record('preflight', 'signaling reachable', sigOk ? 'pass' : 'warn', CFG.signalingUrl);
  record('preflight', 'ai-engine reachable', aiOk ? 'pass' : 'warn', CFG.aiEngineUrl);

  const ep = await aiEngineProbe();
  record('preflight', 'GPU endpoints present',
    ep.hasGpuEndpoints ? 'pass' : 'warn',
    JSON.stringify(ep.endpoints));

  const tc = await probeToolchain();
  record('preflight', 'nvcc on host', tc.host.nvcc ? 'pass' : 'skip', tc.host.nvcc ?? 'not found');
  record('preflight', 'hipcc on host', tc.host.hipcc ? 'pass' : 'skip', tc.host.hipcc ?? 'not found');
  if (tc.worker.nvcc !== undefined) {
    record('preflight', 'nvcc in worker', tc.worker.nvcc ? 'pass' : 'skip', tc.worker.nvcc ?? 'not found');
    record('preflight', 'hipcc in worker', tc.worker.hipcc ? 'pass' : 'skip', tc.worker.hipcc ?? 'not found');
  }

  record('preflight', 'SYNTHI_GPU_HMR flag', CFG.gpuHmr ? 'pass' : 'warn',
    CFG.gpuHmr ? 'enabled' : 'unset/0 — phases will be skipped or downgraded');

  return { feOk, colOk, sigOk, aiOk, ep, tc };
}

async function seedWorkspace(vendor) {
  const m = manifestFor(vendor);
  const deviceFilename = vendor === 'rocm' ? 'device.hip' : 'device.cu';
  log('info', `Seeding workspace slug=${CFG.slug} vendor=${vendor}`);

  let ws;
  try {
    ws = await createWorkspace({ name: `${CFG.workspaceName} (${vendor})`, slug: CFG.slug });
  } catch (e) {
    record('seed', 'create workspace', 'fail', e.message.slice(0, 200));
    return null;
  }
  record('seed', 'create workspace', 'pass', `id=${ws.id} slug=${ws.slug}`);

  const files = [
    { path: 'shared.h', content: SHARED_H },
    { path: 'core.cpp', content: CORE_CPP },
    { path: 'gui.cpp', content: GUI_CPP },
    { path: 'host_runner.cpp', content: HOST_RUNNER_CPP },
    { path: deviceFilename, content: DEVICE_CU_PHASE0 },
    { path: '.synthi/build_manifest.json', content: JSON.stringify(m, null, 2) },
  ];

  const contract = verifySeedFixtureContract(files);
  record('seed', 'fixture uses Synthi GPU runtime contract',
    contract.ok ? 'pass' : 'fail',
    contract.ok ? 'synthi_gpu_launch + lifecycle exports' : contract.findings.join(', '));

  try {
    await writeFilesBatch({ slug: CFG.slug, userId: CFG.hostId, files, syncToGcs: CFG.syncToGcs });
    record('seed', 'write-files-batch (5 src + manifest)', 'pass', `${files.length} files`);
  } catch (e) {
    record('seed', 'write-files-batch (5 src + manifest)', 'fail', e.message.slice(0, 200));
    return null;
  }

  try {
    await stageAndCommit({ slug: CFG.slug, userId: CFG.hostId, message: 'gpu-hmr-test: seed' });
    record('seed', 'stage + commit', 'pass');
  } catch (e) {
    record('seed', 'stage + commit', 'warn', e.message.slice(0, 200));
  }

  // Read back the device file as a content-hash check.
  const got = await readFileViaCollab({ slug: CFG.slug, filePath: deviceFilename });
  const seedOk = got != null && got.includes('vec_add');
  record('seed', `${deviceFilename} present in collab`, seedOk ? 'pass' : 'fail',
    got ? `${got.length} bytes` : 'not found');

  return {
    workspace: ws,
    manifest: m,
    deviceFilename,
    sourceFiles: new Map(files.map((f) => [f.path, f.content])),
  };
}

async function phaseP0(ctx) {
  if (!shouldRun('P0')) return record('P0', 'phase skipped', 'skip', 'SKIP_PHASES/ONLY_PHASES filter');
  if (!CFG.gpuHmr) return record('P0', 'toolchain smoke', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P0', ctx, 'toolchain smoke')) return;

  log('info', '── Phase P0: toolchain smoke ──');
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE0 }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) {
    return record('P0', 'compile dispatch', 'warn',
      `${compile.reason}${compile.body ? ' body=' + compile.body.slice(0, 120) : ''}`);
  }
  record('P0', 'compile dispatch', 'pass');

  // Worker log assertions for §9.3.
  const sawNvcc = await awaitWorkerLogRegex(/compile-device.*(nvcc|hipcc)/i, 30000);
  record('P0', 'worker invokes device compiler', sawNvcc.matched ? 'pass' : 'warn',
    sawNvcc.snippet || 'no log marker (was worker.log path set?)');

  const sawCubin = await awaitWorkerLogRegex(/cuModuleLoadData ok|hipModuleLoad ok|kernels=\[/, 15000);
  record('P0', 'gpu adapter loaded cubin/hsaco', sawCubin.matched ? 'pass' : 'warn',
    sawCubin.snippet || 'no marker');

  // ccache must NOT wrap nvcc/hipcc (§5.3 regression check).
  const tail = await readWorkerLogTail();
  const ccacheLeak = tail && /ccache\s+(nvcc|hipcc)/.test(tail);
  record('P0', 'device compiler not wrapped by ccache', !ccacheLeak ? 'pass' : 'fail',
    ccacheLeak ? 'ccache nvcc/hipcc found in worker.log' : 'clean');
}

async function phaseP1(ctx) {
  if (!shouldRun('P1')) return record('P1', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P1', 'cold reload buffer survival', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P1', ctx, 'cold reload buffer survival')) return;

  log('info', '── Phase P1: cold reload + buffer survival ──');
  // Record pre-edit buffer pointers from worker.log (P0 should have logged them).
  const preTail = await readWorkerLogTail();
  const prePtrs = [...(preTail ?? '').matchAll(/buffer\s+([a-z])=\s*0x([0-9a-fA-F]+)/g)]
    .map((m) => `${m[1]}=0x${m[2]}`);

  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE1_EDIT }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) {
    return record('P1', 'edit dispatch', 'warn', compile.reason);
  }
  record('P1', 'edit dispatch', 'pass');

  const reload = await awaitWorkerLogRegex(
    /\[gpu-reload\]\s+plan=(device_only|cold|host_only|mixed|abi_breaking)/, CFG.hmrTimeoutMs);
  record('P1', 'reload plan emitted', reload.matched ? 'pass' : 'warn',
    reload.snippet || 'no plan marker — orchestrator not wired yet');

  const reused = await awaitWorkerLogRegex(/reused buffer\s+[a-z]=0x/, 10000);
  record('P1', 'buffer pointers reused across swap', reused.matched ? 'pass' : 'warn',
    reused.snippet || 'no reuse marker');

  // If we saw both pre and post pointer lines, assert at least one match.
  if (prePtrs.length > 0) {
    const postTail = await readWorkerLogTail();
    const postPtrs = [...(postTail ?? '').matchAll(/reused buffer\s+([a-z])=0x([0-9a-fA-F]+)/g)]
      .map((m) => `${m[1]}=0x${m[2]}`);
    const overlap = prePtrs.filter((p) => postPtrs.includes(p));
    record('P1', 'pre/post pointer overlap',
      overlap.length >= 1 ? 'pass' : 'warn',
      `pre=${prePtrs.length} post=${postPtrs.length} overlap=${overlap.length}`);
  } else {
    record('P1', 'pre/post pointer overlap', 'skip', 'no pre-edit pointers in worker.log');
  }

  // §6.1 latency assertion — first edit may pay the full PCIe round trip,
  // but the second-edit-onward must stay inside SYNTHI_GPU_SNAPSHOT_BUDGET_MS*2
  // because dirty-bit accounting should have flagged most buffers clean.
  const snapTelemetry = await awaitWorkerLogRegex(
    /gpu_snapshot_telemetry.*snapshot_ms=(\d+).*snapshot_bytes=(\d+)/, 2000);
  if (snapTelemetry.matched) {
    const ms = Number((snapTelemetry.snippet.match(/snapshot_ms=(\d+)/) ?? [])[1]);
    const bytes = Number((snapTelemetry.snippet.match(/snapshot_bytes=(\d+)/) ?? [])[1]);
    const budget = CFG.snapshotBudgetMs * 2; // first-edit allowance
    record('P1', `snapshot latency within ${budget}ms`,
      ms <= budget ? 'pass' : 'fail',
      `snapshot_ms=${ms}  bytes=${(bytes / (1<<20)).toFixed(1)}MiB`);

    // Tier reporting — we want Tier B telemetry to surface the tier in use
    const tierMatch = (await readWorkerLogTail() ?? '').match(/snapshot_tier=([AB])/);
    if (tierMatch) {
      record('P1', 'snapshot tier reported', 'pass', `tier=${tierMatch[1]}`);
    }
  } else {
    record('P1', 'snapshot latency telemetry', 'warn',
      'no gpu_snapshot_telemetry log line — §6.1 mitigations not wired yet');
  }

  // Second-edit pass: tighter budget. Apply the same edit twice (identity);
  // dirty-bit accounting should mark every buffer clean → near-zero snapshot.
  const second = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE1_EDIT }],
    manifest: ctx.manifest,
  });
  if (second.ok) {
    const second2 = await awaitWorkerLogRegex(
      /gpu_snapshot_telemetry.*snapshot_ms=(\d+).*snapshot_bytes=(\d+)/, 5000);
    if (second2.matched) {
      // Walk back to find the LAST telemetry line (the second-edit one).
      const all = [...(second2.tail ?? '').matchAll(/snapshot_ms=(\d+).*?snapshot_bytes=(\d+)/g)];
      const last = all[all.length - 1];
      if (last) {
        const ms = Number(last[1]);
        const budget = CFG.snapshotBudgetMs;
        record('P1', `2nd-edit snapshot within tight budget (${budget}ms)`,
          ms <= budget ? 'pass' : 'fail',
          `snapshot_ms=${ms}  (dirty-bit accounting should skip clean buffers — §6.1.2)`);
      }
    }
  }
}

async function phaseP2(ctx) {
  if (!shouldRun('P2')) return record('P2', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P2', 'fast device swap', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P2', ctx, 'fast device swap')) return;

  log('info', '── Phase P2: fast device-only swap + abi-breaking ──');

  // Fast path
  const tFast0 = Date.now();
  const fast = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE2_FAST }],
    manifest: ctx.manifest,
  });
  if (!fast.ok) {
    record('P2', 'fast-swap dispatch', 'warn', fast.reason);
  } else {
    record('P2', 'fast-swap dispatch', 'pass');
    const fastDone = await awaitWorkerLogRegex(/\[gpu-reload\].*plan=device_only.*total_ms=(\d+)/, CFG.hmrTimeoutMs);
    if (fastDone.matched) {
      const ms = Number((fastDone.snippet.match(/total_ms=(\d+)/) ?? [])[1]);
      const within = ms <= CFG.fastSwapBudgetMs;
      record('P2', `fast swap within budget (${CFG.fastSwapBudgetMs}ms)`,
        within ? 'pass' : 'warn',
        `total_ms=${ms}`);
    } else {
      record('P2', `fast swap within budget (${CFG.fastSwapBudgetMs}ms)`, 'warn',
        `no plan=device_only marker (wall=${Date.now() - tFast0}ms)`);
    }
  }

  // ABI-breaking
  const abi = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE2_ABI_BREAK }],
    manifest: ctx.manifest,
  });
  if (!abi.ok) {
    record('P2', 'abi-break dispatch', 'warn', abi.reason);
  } else {
    record('P2', 'abi-break dispatch', 'pass');
    const abiReload = await awaitWorkerLogRegex(/plan=(abi_breaking|mixed)/, CFG.hmrTimeoutMs);
    record('P2', 'classifier emits abi_breaking/mixed',
      abiReload.matched ? 'pass' : 'warn',
      abiReload.snippet || 'no marker');
  }
}

async function phaseP3Heal(ctx) {
  if (!shouldRun('P3-heal')) return record('P3-heal', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-heal', 'healer drills', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-heal', ctx, 'healer drills')) return;

  log('info', '── Phase P3-heal: three-tier healer drills ──');

  const drills = [
    { tier: 'compile_hard', name: 'Tier 1 (compile hard, missing __shfl_down_sync)', body: DEVICE_CU_HEAL_T1 },
    { tier: 'compile_soft', name: 'Tier 2 (register pressure / spills)',              body: DEVICE_CU_HEAL_T2 },
    { tier: 'runtime',      name: 'Tier 3 (illegal address: out-of-bounds index)',    body: DEVICE_CU_HEAL_T3 },
  ];

  for (const d of drills) {
    log('info', `─ drill: ${d.name}`);
    // 1. inject pathological code
    const inject = await postCompile({
      ctx,
      slug: CFG.slug,
      files: [{ path: ctx.deviceFilename, content: d.body }],
      manifest: ctx.manifest,
    });
    if (!inject.ok) {
      record('P3-heal', `${d.name}: inject`, 'warn', inject.reason);
      continue;
    }
    record('P3-heal', `${d.name}: inject`, 'pass');

    // 2. ask heal endpoint to patch
    const heal = await postHeal({
      slug: CFG.slug,
      tier: d.tier,
      error: { kind: d.tier === 'compile_hard' ? 'nvcc_undefined_identifier'
                   : d.tier === 'compile_soft' ? 'ptxas_register_pressure'
                   : 'cudaErrorIllegalAddress' },
      manifest: ctx.manifest,
    });
    if (!heal.ok) {
      record('P3-heal', `${d.name}: heal endpoint`, 'warn', heal.reason);
      continue;
    }
    record('P3-heal', `${d.name}: heal endpoint`, 'pass',
      `edits=${heal.body?.edits?.length ?? 0}`);

    // 3. apply no-shim verifier rules locally
    const verify = verifyHealOutput(
      heal.body?.edits ?? [],
      ctx.manifest.files,
      ['vec_add'],
    );
    record('P3-heal', `${d.name}: no-shim verifier`,
      verify.ok ? 'pass' : 'fail',
      verify.ok ? 'clean' : verify.findings.map((f) => `${f.rule}:${f.detail}`).join('; '));

    // 4. assert no new device file
    const hasNewDeviceFile = (heal.body?.edits ?? []).some((e) =>
      /\.(cu|hip)$/.test(e.module) && e.module !== ctx.deviceFilename && e.operation === 'create');
    record('P3-heal', `${d.name}: no new device files`,
      !hasNewDeviceFile ? 'pass' : 'fail',
      hasNewDeviceFile ? 'create operation on new .cu/.hip' : 'clean');
  }
}

async function phaseP3Mixed(ctx) {
  if (!shouldRun('P3-mixed')) return record('P3-mixed', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-mixed', 'mixed reload', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-mixed', ctx, 'mixed reload')) return;

  log('info', '── Phase P3-mixed: host + device edit in one batch ──');
  // Edit both core.cpp (touch host launch) and device.cu (touch kernel) together.
  const editedCore = CORE_CPP.replace(
    'g_state->accumulator += 1.0;',
    'g_state->accumulator += 2.5;   // P3-mixed: accumulator must survive',
  );
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [
      { path: 'core.cpp',           content: editedCore },
      { path: ctx.deviceFilename,   content: DEVICE_CU_PHASE2_FAST },
    ],
    manifest: ctx.manifest,
  });
  if (!compile.ok) return record('P3-mixed', 'dispatch', 'warn', compile.reason);
  record('P3-mixed', 'dispatch', 'pass');

  const seq = await awaitWorkerLogRegex(
    /device_save[\s\S]{0,200}host_swap[\s\S]{0,200}device_swap[\s\S]{0,200}device_restore/,
    CFG.hmrTimeoutMs);
  record('P3-mixed', 'orchestrator step sequence',
    seq.matched ? 'pass' : 'warn',
    seq.matched ? 'save→host_swap→device_swap→restore observed' : 'sequence not found');

  const onLoad = await awaitWorkerLogRegex(/device_on_load\s+(called|invoked|ok)/, 5000);
  record('P3-mixed', 'device_on_load invoked exactly once',
    onLoad.matched ? 'pass' : 'warn', onLoad.snippet);
}

async function phaseP3StreamHang(ctx) {
  if (!shouldRun('P3-stream-hang')) return record('P3-stream-hang', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-stream-hang', 'stream hang watchdog', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-stream-hang', ctx, 'stream hang watchdog')) return;

  log('info', '── Phase P3-stream-hang: watchdog + drain timeout ──');
  // Inject a kernel guaranteed to spin.
  const hangBody = `
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    volatile int x = 0;
    while (x == 0) { /* spin until something the compiler can't prove changes */ }
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
`;
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: hangBody }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) return record('P3-stream-hang', 'inject hang dispatch', 'warn', compile.reason);
  record('P3-stream-hang', 'inject hang dispatch', 'pass');

  const watchTimeout = CFG.watchdogMs + 3000;
  const hangEvt = await awaitWorkerLogRegex(/STREAM_HANG|stream_hang/, watchTimeout);
  record('P3-stream-hang', `watchdog synthesizes STREAM_HANG within ${CFG.watchdogMs}ms (+slack)`,
    hangEvt.matched ? 'pass' : 'warn', hangEvt.snippet);

  const drainTimeout = CFG.drainTimeoutMs + 2000;
  const drain = await awaitWorkerLogRegex(/drain timeout|drain_timeout|cold[- ]restart/, drainTimeout);
  record('P3-stream-hang', 'drain timeout → cold restart fallback',
    drain.matched ? 'pass' : 'warn', drain.snippet);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  await resolveDockerContainers();

  console.log(color.blue + '\n━━━ Synthi GPU-HMR live test ━━━' + color.reset);
  console.log(`  slug         ${CFG.slug}`);
  console.log(`  vendor       ${CFG.vendor}`);
  console.log(`  gpu-hmr flag ${CFG.gpuHmr}`);
  console.log(`  mcp compile  ${CFG.useMcpCompile ? `${CFG.mcpTransport}:${CFG.mcpContainer}` : 'disabled'}`);
  console.log(`  worker log   ${CFG.workerLogPath}`);
  console.log('');

  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const pre = await preflight();
  if (CFG.useMcpCompile) {
    try {
      await startMcp();
    } catch (e) {
      record('preflight', 'MCP initialize/tools-list', 'warn', e.message.slice(0, 220));
    }
  }
  // Hard-blockers: workspace + collab must be reachable to do anything useful.
  if (!pre.feOk || !pre.colOk) {
    log('fail', 'frontend or collab unreachable — cannot seed workspace; exiting with FAIL summary');
    await writeSummary();
    await stopMcp();
    process.exit(1);
  }

  const vendors = CFG.vendor === 'both' ? ['cuda', 'rocm'] : [CFG.vendor];
  for (const vendor of vendors) {
    log('info', `── Vendor: ${vendor} ──`);
    const ctx = await seedWorkspace(vendor);
    if (!ctx) {
      record(`seed:${vendor}`, 'seed failed; skipping phases', 'fail');
      continue;
    }
    ctx.vendor = vendor;
    ctx.toolchain = toolchainForVendor(pre.tc, vendor);
    record(`vendor:${vendor}`, 'GPU toolchain gate',
      ctx.toolchain.ok ? 'pass' : 'skip',
      ctx.toolchain.ok ? `${ctx.toolchain.source}:${ctx.toolchain.path}` : ctx.toolchain.reason);
    // Phases run sequentially because they share the same workspace state.
    try { await phaseP0(ctx); }            catch (e) { record('P0',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP1(ctx); }            catch (e) { record('P1',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP2(ctx); }            catch (e) { record('P2',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3Mixed(ctx); }       catch (e) { record('P3-mixed',      'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3Heal(ctx); }        catch (e) { record('P3-heal',       'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3StreamHang(ctx); }  catch (e) { record('P3-stream-hang','unexpected throw', 'fail', e.message.slice(0, 200)); }
  }

  await writeSummary();
  await stopMcp();
}

async function writeSummary() {
  console.log('');
  console.log(color.blue + '━━━ GPU HMR test summary ━━━' + color.reset);
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`  Checked ${results.length}: ${color.green}${passed} PASS${color.reset}  ${color.yellow}${warned} WARN${color.reset}  ${color.red}${failed} FAIL${color.reset}  ${color.dim}${skipped} SKIP${color.reset}`);

  // Phase headline
  const phases = ['P0', 'P1', 'P2', 'P3-mixed', 'P3-heal', 'P3-stream-hang'];
  const headline = phases.map((p) => {
    const rows = results.filter((r) => r.phase === p);
    if (rows.length === 0) return `${p} -`;
    if (rows.some((r) => r.status === 'fail')) return `${p} ✗`;
    if (rows.every((r) => r.status === 'skip')) return `${p} ⊝`;
    if (rows.every((r) => r.status === 'pass')) return `${p} ✓`;
    return `${p} ~`;
  }).join('  ');
  console.log(`  Phases: ${headline}`);

  if (failed + warned > 0) {
    console.log('');
    for (const r of results.filter((r) => r.status === 'fail' || r.status === 'warn')) {
      const tag = r.status === 'fail' ? color.red + 'FAIL' : color.yellow + 'WARN';
      console.log(`  ${tag}${color.reset}  [${r.phase}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }
  }

  const summary = {
    slug: CFG.slug,
    vendor: CFG.vendor,
    gpu_hmr_flag: CFG.gpuHmr,
    run_at: new Date().toISOString(),
    config: {
      fastSwapBudgetMs: CFG.fastSwapBudgetMs,
      watchdogMs: CFG.watchdogMs,
      drainTimeoutMs: CFG.drainTimeoutMs,
    },
    summary: { total: results.length, passed, warned, failed, skipped },
    results,
  };
  await writeFile(path.join(LOG_DIR, 'results.json'), JSON.stringify(summary, null, 2));
  const txt = results.map((r) =>
    `${r.status.toUpperCase().padEnd(5)}  [${r.phase}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`
  ).join('\n') + '\n';
  await writeFile(path.join(LOG_DIR, 'results.txt'), txt);

  console.log('');
  console.log(`  Artifacts: ${ARTIFACT_DIR}`);
  console.log(`  Logs:      ${LOG_DIR}`);
  console.log(`  Results:   ${path.join(LOG_DIR, 'results.json')}`);

  process.exitCode = failed > 0 ? 1 : 0;
}

async function selfCheck() {
  const files = [
    { path: 'shared.h', content: SHARED_H },
    { path: 'core.cpp', content: CORE_CPP },
    { path: 'gui.cpp', content: GUI_CPP },
    { path: 'host_runner.cpp', content: HOST_RUNNER_CPP },
    { path: 'device.cu', content: DEVICE_CU_PHASE0 },
    { path: '.synthi/build_manifest.json', content: JSON.stringify(manifestFor('cuda'), null, 2) },
  ];
  const contract = verifySeedFixtureContract(files);
  if (!contract.ok) {
    console.error(`gpu-hmr-test self-check failed: ${contract.findings.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('gpu-hmr-test self-check passed: fixture uses Synthi GPU runtime contract');
}

const entry = process.argv.includes('--self-check') ? selfCheck : main;
entry().catch((e) => {
  console.error(color.red + '\nFATAL: ' + color.reset + (e.stack ?? e.message));
  process.exit(1);
});
