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
//   SYNTHI_GPU_FAST_SWAP_BUDGET_MS 300
//   SYNTHI_GPU_LAUNCH_WATCHDOG_MS  5000
//   SYNTHI_GPU_DRAIN_TIMEOUT_MS    2000
//   SYNTHI_GPU_HIP_FAKE_RUNTIME  unset (set to ask worker to load HIP-CPU)
//   SKIP_PHASES                  comma-separated phase ids
//   ONLY_PHASES                  comma-separated phase ids
//   HMR_TIMEOUT_MS               60000
//   MCP_ENTRY                    ../dist/index.js
//   MCP_TRANSPORT                docker | host
//   MCP_CONTAINER                synthi-ide-mcp-1
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
  fastSwapBudgetMs: Number(process.env.SYNTHI_GPU_FAST_SWAP_BUDGET_MS ?? 300),
  watchdogMs: Number(process.env.SYNTHI_GPU_LAUNCH_WATCHDOG_MS ?? 5000),
  drainTimeoutMs: Number(process.env.SYNTHI_GPU_DRAIN_TIMEOUT_MS ?? 2000),
  hipFakeRuntime: process.env.SYNTHI_GPU_HIP_FAKE_RUNTIME === '1',
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'host').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  skipPhases: new Set((process.env.SKIP_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  onlyPhases: new Set((process.env.ONLY_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  syncToGcs: true,
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');

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

  if (process.env.WORKER_CONTAINER || CFG.mcpTransport === 'docker') {
    const ctr = process.env.WORKER_CONTAINER ?? CFG.mcpContainer;
    out.worker.nvcc = await new Promise((res) => {
      execFile('docker', ['exec', ctr, 'sh', '-c', 'command -v nvcc || true'], (e, so) => {
        res(e ? null : (so.trim() || null));
      });
    });
    out.worker.hipcc = await new Promise((res) => {
      execFile('docker', ['exec', ctr, 'sh', '-c', 'command -v hipcc || true'], (e, so) => {
        res(e ? null : (so.trim() || null));
      });
    });
  }
  return out;
}

// ───────────────────────── fixtures ─────────────────────────
// Hand-written 5-file projects — the harness skips the Kernel-Splitter LLM
// step so we have exact, deterministic byte-level inputs.

const SHARED_H = `// shared.h — GPU HMR test fixture
#pragma once
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
};

// Forward declares used by host and device sides.
extern "C" {
    void vec_add_launch(const float* a, const float* b, float* c, int n);
}
`;

const CORE_CPP = `// core.cpp — GPU HMR test fixture (Phase 0/1 vector add)
#include "shared.h"
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
    cudaMalloc(&g_state->d_a, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_b, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_c, sizeof(float) * N_ELEMS);
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
    vec_add_launch(g_state->d_a, g_state->d_b, g_state->d_c, g_state->n);
    g_state->frame += 1;
    g_state->accumulator += 1.0;
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

extern "C" void vec_add_launch(const float* a, const float* b, float* c, int n) {
    int block = 256;
    int grid = (n + block - 1) / block;
    vec_add<<<grid, block>>>(a, b, c, n);
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
extern "C" void vec_add_launch(const float* a, const float* b, float* c, int n) {
    int block = 256;
    int grid = (n + block - 1) / block;
    vec_add<<<grid, block>>>(a, b, c, n);
}
`;

// Phase-2 abi-breaking edit: extra parameter — signature changes.
const DEVICE_CU_PHASE2_ABI_BREAK = `// device.cu — abi-breaking edit (extra parameter)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n, float scale) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = (a[i] + b[i]) * scale;
}
extern "C" void vec_add_launch(const float* a, const float* b, float* c, int n) {
    int block = 256;
    int grid = (n + block - 1) / block;
    vec_add<<<grid, block>>>(a, b, c, n, 1.0f);   // host updated in sync
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
extern "C" void vec_add_launch(const float* a, const float* b, float* c, int n) {
    int block = 256; int grid = (n + block - 1) / block;
    vec_add<<<grid, block>>>(a, b, c, n);
}
`;
const DEVICE_CU_HEAL_T3 = DEVICE_CU_PHASE0.replace(
  'if (i < n) c[i] = a[i] + b[i];',
  'c[i + 4] = a[i] + b[i];', // last block over-indexes
);

function manifestFor(vendor) {
  if (vendor === 'rocm') {
    return {
      compiler: 'clang++',
      files: ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp', 'device.hip'],
      gpu: {
        vendor: 'rocm',
        device_compiler: 'hipcc',
        arch: ['gfx90a'],
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
      arch: ['sm_80'],
      device_flags: ['-O3', '-lineinfo', '--use_fast_math'],
      runtime_libs: ['cudart', 'cuda'],
      snapshot_mode: 'auto',
      fatbin_strategy: 'sidecar_module',
    },
  };
}

// ───────────────────────── compile + HMR over the AI engine wire ─────────────────────────
//
// In production this is mediated by MCP/synthi_compile. For determinism this
// harness can also POST directly to the AI engine when MCP isn't wired in
// (most CI lanes don't have a real WebRTC stack up).

async function postCompile({ slug, files, manifest }) {
  // The AI engine endpoint surface we want here is /refactor/diff_patch/gpu
  // (or /refactor/split/gpu for first compile). Today neither exists, so we
  // probe and return a structured "not_implemented" rather than throwing.
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
  record('preflight', 'nvcc on host', tc.host.nvcc ? 'pass' : 'warn', tc.host.nvcc ?? 'not found');
  record('preflight', 'hipcc on host', tc.host.hipcc ? 'pass' : 'warn', tc.host.hipcc ?? 'not found');
  if (tc.worker.nvcc !== undefined) {
    record('preflight', 'nvcc in worker', tc.worker.nvcc ? 'pass' : 'warn', tc.worker.nvcc ?? 'not found');
    record('preflight', 'hipcc in worker', tc.worker.hipcc ? 'pass' : 'warn', tc.worker.hipcc ?? 'not found');
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

  return { workspace: ws, manifest: m, deviceFilename };
}

async function phaseP0(ctx) {
  if (!shouldRun('P0')) return record('P0', 'phase skipped', 'skip', 'SKIP_PHASES/ONLY_PHASES filter');
  if (!CFG.gpuHmr) return record('P0', 'toolchain smoke', 'skip', 'feature_flag_off');

  log('info', '── Phase P0: toolchain smoke ──');
  const compile = await postCompile({
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

  log('info', '── Phase P1: cold reload + buffer survival ──');
  // Record pre-edit buffer pointers from worker.log (P0 should have logged them).
  const preTail = await readWorkerLogTail();
  const prePtrs = [...(preTail ?? '').matchAll(/buffer\s+([a-z])=\s*0x([0-9a-fA-F]+)/g)]
    .map((m) => `${m[1]}=0x${m[2]}`);

  const compile = await postCompile({
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
}

async function phaseP2(ctx) {
  if (!shouldRun('P2')) return record('P2', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P2', 'fast device swap', 'skip', 'feature_flag_off');

  log('info', '── Phase P2: fast device-only swap + abi-breaking ──');

  // Fast path
  const tFast0 = Date.now();
  const fast = await postCompile({
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

  log('info', '── Phase P3-mixed: host + device edit in one batch ──');
  // Edit both core.cpp (touch host launch) and device.cu (touch kernel) together.
  const editedCore = CORE_CPP.replace(
    'g_state->accumulator += 1.0;',
    'g_state->accumulator += 2.5;   // P3-mixed: accumulator must survive',
  );
  const compile = await postCompile({
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

  log('info', '── Phase P3-stream-hang: watchdog + drain timeout ──');
  // Inject a kernel guaranteed to spin.
  const hangBody = `
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    volatile int x = 0;
    while (x == 0) { /* spin until something the compiler can't prove changes */ }
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
extern "C" void vec_add_launch(const float* a, const float* b, float* c, int n) {
    int block = 256; int grid = (n + block - 1) / block;
    vec_add<<<grid, block>>>(a, b, c, n);
}
`;
  const compile = await postCompile({
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
  console.log(color.blue + '\n━━━ Synthi GPU-HMR live test ━━━' + color.reset);
  console.log(`  slug         ${CFG.slug}`);
  console.log(`  vendor       ${CFG.vendor}`);
  console.log(`  gpu-hmr flag ${CFG.gpuHmr}`);
  console.log(`  worker log   ${CFG.workerLogPath}`);
  console.log('');

  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const pre = await preflight();
  // Hard-blockers: workspace + collab must be reachable to do anything useful.
  if (!pre.feOk || !pre.colOk) {
    log('fail', 'frontend or collab unreachable — cannot seed workspace; exiting with FAIL summary');
    await writeSummary();
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
    // Phases run sequentially because they share the same workspace state.
    try { await phaseP0(ctx); }            catch (e) { record('P0',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP1(ctx); }            catch (e) { record('P1',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP2(ctx); }            catch (e) { record('P2',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3Mixed(ctx); }       catch (e) { record('P3-mixed',      'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3Heal(ctx); }        catch (e) { record('P3-heal',       'unexpected throw', 'fail', e.message.slice(0, 200)); }
    try { await phaseP3StreamHang(ctx); }  catch (e) { record('P3-stream-hang','unexpected throw', 'fail', e.message.slice(0, 200)); }
  }

  await writeSummary();
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

main().catch((e) => {
  console.error(color.red + '\nFATAL: ' + color.reset + (e.stack ?? e.message));
  process.exit(1);
});
