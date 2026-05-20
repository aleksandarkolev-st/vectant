#!/usr/bin/env node
// Large multi-file GPU HMR validation:
//   ordinary user project -> MCP compile -> AI GPU split -> visible first frame
//   -> user device-source AI delta -> GPU sidecar HMR -> visible changed frame.

import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  slug: process.env.SLUG ?? `gpu-scale-validation-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-scale-validation',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  renderBackend: (process.env.SYNTHI_SCALE_RENDER_BACKEND ?? 'sdl2').toLowerCase().replace(/^sdl$/, 'sdl2'),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview',
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'vectant-ade-mcp-1',
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  aiEngineContainer: process.env.AI_ENGINE_CONTAINER ?? 'vectant-ade-ai-engine-1',
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 260000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  firstCompileTimeoutMs: Number(process.env.SYNTHI_SCALE_FIRST_TIMEOUT_MS ?? 240000),
  hotSwapTimeoutMs: Number(process.env.SYNTHI_SCALE_HMR_TIMEOUT_MS ?? 30000),
  hmrDeltaMode: (process.env.SYNTHI_SCALE_HMR_DELTA_MODE ?? 'ai_user_delta').toLowerCase(),
  aiDeltaEvidenceTimeoutMs: Number(process.env.SYNTHI_SCALE_AI_DELTA_EVIDENCE_TIMEOUT_MS ?? 45000),
  screenshotAttempts: Number(process.env.SYNTHI_SCALE_SCREENSHOT_ATTEMPTS ?? 6),
  screenshotRetryDelayMs: Number(process.env.SYNTHI_SCALE_SCREENSHOT_RETRY_MS ?? 1000),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_SCALE_SCREENSHOT_FRESHNESS_MS ?? 5000),
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const RESULTS_JSON = path.join(LOG_DIR, 'scale-validation-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'scale-validation-results.txt');
const BACKEND_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-results.json`);
const BACKEND_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-results.txt`);

const FORBIDDEN_ABI = [
  'core_on_load',
  'core_on_update',
  'gui_on_load',
  'gui_on_render',
  'device_on_load',
  'device_descriptor',
  'device_kernel_sig_hash',
];
const FORBIDDEN_ROLE_NAMES = ['core', 'gui', 'host_runner', 'device', 'shared'];
const GENERATED_WORKSPACE_ARTIFACTS = new Set([
  'core.cpp',
  'gui.cpp',
  'host_runner.cpp',
  'shared.h',
  'device.hip',
  'device.cu',
  '.synthi_split_meta.json',
  '.synthi/build_manifest.json',
]);

const report = {
  slug: CFG.slug,
  repo_commit: '',
  model: CFG.geminiModel,
  vendor: '',
  arch: '',
  render_backend: CFG.renderBackend,
  source_file_mix: {},
  workspace_file_count: 0,
  relevant_file_count: 0,
  started_at: new Date().toISOString(),
  finished_at: '',
  compose_files: ['docker-compose.yml', 'docker-compose.gpu-amd.yml'],
  containers: {},
  env: {},
  worker_restarted_before_run: process.env.SYNTHI_WORKER_RESTARTED_BEFORE_RUN === '1',
  ai_engine_restarted_before_run: process.env.SYNTHI_AI_ENGINE_RESTARTED_BEFORE_RUN === '1',
  split_cache_bypassed_by_worker_restart: process.env.SYNTHI_WORKER_RESTARTED_BEFORE_RUN === '1',
  generated_roles: {},
  launch_indirection: {},
  phases: [],
  screenshots: [],
  checks: [],
};

function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  report.checks.push(row);
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
  const id = await execText('docker', ['compose', '--project-directory', REPO_ROOT, 'ps', '-q', service], 8000);
  return String(id || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || configured;
}

async function resolveDockerContainers() {
  if (CFG.mcpTransport !== 'docker') return;
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
  CFG.aiEngineContainer = await resolveDockerContainer(CFG.aiEngineContainer, 'ai-engine');
}

async function containerSnapshot(container) {
  const text = await execText('docker', [
    'inspect',
    '--format',
    '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.Created}}',
    container,
  ]);
  const [id, image_id, image, created] = String(text || '').split('|');
  return { id, image_id, image, created };
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
  const out = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', archProbeCommand(vendor)]);
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

async function listWorkspaceFiles(slug) {
  const result = await httpJson('GET', `${CFG.collabUrl}/git/${slug}/files`, null, { 'x-user-id': CFG.hostId });
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.files)) return result.files;
  return [];
}

async function dockerLogs(container, checkpoint) {
  const args = ['logs'];
  if (checkpoint?.at) args.push('--since', checkpoint.at);
  else args.push('--tail', '5000');
  args.push(container);
  return execText('docker', args, 20000) || '';
}

async function workerCheckpoint() {
  return { at: new Date(Date.now() - 2000).toISOString() };
}

async function awaitLogRegex(container, regex, timeoutMs, checkpoint) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = await dockerLogs(container, checkpoint);
    regex.lastIndex = 0;
    const match = tail.match(regex);
    if (match) return { matched: true, snippet: match[0].slice(0, 500), tail };
    await sleep(700);
  }
  const tail = await dockerLogs(container, checkpoint);
  return { matched: false, snippet: '', tail };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function workerWorkspacePath(checkpoint) {
  const logs = await dockerLogs(CFG.workerContainer, checkpoint);
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
  return execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(full)}`], 10000, true);
}

async function writeWorkerFile(workspacePath, relPath, content) {
  const safeName = relPath.replace(/[\\/:\s]+/g, '_').replace(/^_+/, '') || 'worker-file';
  const tmp = path.join(ARTIFACT_DIR, `${CFG.slug}-${safeName}.tmp`);
  await writeFile(tmp, content);
  const full = `${workspacePath.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`;
  await execText('docker', ['cp', tmp, `${CFG.workerContainer}:${full}`], 10000, true);
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
      '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
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
        GEMINI_API_KEY: CFG.googleApiKey,
        SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      },
    });
  }
  const client = new McpClient(proc);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'synthi-gpu-hmr-scale-validation', version: '0.0.1' },
  }, 20000);
  await client.request('notifications/initialized', {}, 5000).catch(() => {});
  const tools = await client.request('tools/list', {}, 20000);
  const names = tools.tools?.map((t) => t.name) ?? [];
  record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') && names.includes('synthi_screenshot') ? 'pass' : 'fail', `count=${names.length}`);
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

function addFile(files, pathName, content, relevant = false) {
  files.push({ path: pathName, content: content.trimStart().replace(/\r\n/g, '\n'), relevant });
}

function addMultiSourceShardPack(files) {
  for (let i = 0; i < 10; i += 1) {
    const suffix = String(i).padStart(2, '0');
    addFile(files, `src/field/flow_profile_${suffix}.hpp`, `
#pragma once
namespace scale::field_profile_${i} {
constexpr float kRadialPull = ${(0.18 + i * 0.011).toFixed(3)}f;
constexpr float kTangentialBias = ${(0.03 + i * 0.004).toFixed(3)}f;
inline float radial_weight(float normalized_radius) {
  return kRadialPull + normalized_radius * kTangentialBias;
}
}
`, true);
  }

  for (let i = 0; i < 10; i += 1) {
    const suffix = String(i).padStart(2, '0');
    addFile(files, `src/field/flow_table_${suffix}.h`, `
#pragma once
namespace scale_flow_table_${i} {
static const int kPaletteBand = ${i % 4};
static const float kBoundaryDamping = ${(0.61 + i * 0.01).toFixed(3)}f;
static inline float clamp_edge(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
}
`, true);
  }

  for (let i = 0; i < 10; i += 1) {
    const suffix = String(i).padStart(2, '0');
    addFile(files, `src/field/flow_module_${suffix}.cpp`, `
#include "flow_profile_${suffix}.hpp"
#include "flow_table_${suffix}.h"
namespace scale::field_module_${i} {
float archived_force_${i}(float radius, float velocity) {
  float weighted = field_profile_${i}::radial_weight(radius);
  return scale_flow_table_${i}::clamp_edge(weighted + velocity * 0.125f, -4.0f, 4.0f);
}
}
`, true);
  }

  for (let i = 0; i < 10; i += 1) {
    const suffix = String(i).padStart(2, '0');
    addFile(files, `src/kernels/flow_kernel_${suffix}.hip`, `
#include "../field/flow_profile_${suffix}.hpp"
#include "../field/flow_table_${suffix}.h"
namespace scale::kernel_notes_${i} {
constexpr float kFlowGain = field_profile_${i}::kRadialPull;
constexpr int kColorBand = scale_flow_table_${i}::kPaletteBand;
struct FlowKernelNote {
  float gain;
  int band;
};
static inline FlowKernelNote note() {
  return {kFlowGain, kColorBand};
}
}
`, true);
  }
}

function sourceFileMix(files) {
  const mix = { cpp: 0, hpp: 0, h: 0, hip: 0, cu: 0, total: 0 };
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.cpp')) mix.cpp += 1;
    else if (lower.endsWith('.hpp')) mix.hpp += 1;
    else if (lower.endsWith('.h')) mix.h += 1;
    else if (lower.endsWith('.hip')) mix.hip += 1;
    else if (lower.endsWith('.cu')) mix.cu += 1;
  }
  mix.total = mix.cpp + mix.hpp + mix.h + mix.hip + mix.cu;
  return mix;
}

function buildScaleProject(vendor, arch, renderBackend) {
  const isRocm = vendor === 'rocm';
  const deviceExt = isRocm ? 'hip' : 'cu';
  const runtimeInclude = isRocm ? '#include <hip/hip_runtime.h>' : '#include <cuda_runtime.h>';
  const launchComment = isRocm ? 'hipLaunchKernelGGL' : 'cudaLaunchKernel';
  const renderSource = renderBackend === 'glfw' ? 'src/render/glfw_canvas.cpp' : 'src/render/sdl_canvas.cpp';
  const renderLink = renderBackend === 'glfw'
    ? 'target_link_libraries(particle_field PRIVATE glfw GL)'
    : 'target_link_libraries(particle_field PRIVATE SDL2)';
  const files = [];

  addFile(files, 'README.md', `
# Particle Field Validation Fixture

Ordinary multi-file GPU project used by the scale validation harness.
Render backend: ${renderBackend === 'glfw' ? 'GLFW + OpenGL' : 'SDL2'}.
`, true);

  addFile(files, 'CMakeLists.txt', `
cmake_minimum_required(VERSION 3.24)
project(particle_field_validation LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
add_executable(particle_field
  src/app/main.cpp
  src/app/simulation.cpp
  ${renderSource}
  src/gpu/particle_kernels.${deviceExt}
)
${renderLink}
`, true);

  addFile(files, 'src/config/particle_config.hpp', `
#pragma once
namespace scale {
constexpr int kParticleCount = 512;
constexpr int kCanvasWidth = 800;
constexpr int kCanvasHeight = 600;
constexpr float kResetPadding = 18.0f;
}
`, true);

  addFile(files, 'src/config/build_options.hpp', `
#pragma once
#define SCALE_GPU_TARGET "${isRocm ? 'rocm' : 'cuda'}"
#define SCALE_GPU_ARCH "${arch}"
`, true);

  addFile(files, 'src/math/vec2.hpp', `
#pragma once
namespace scale {
struct Vec2 {
  float x = 0.0f;
  float y = 0.0f;
};
}
`, true);

  addFile(files, 'src/math/color.hpp', `
#pragma once
#include <cstdint>
namespace scale {
struct Rgba {
  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  uint8_t a = 255;
};
}
`, true);

  addFile(files, 'src/gpu/particle_api.hpp', `
#pragma once
#include <cstdint>
#include "../config/particle_config.hpp"

namespace scale {
struct ParticleBuffers {
  float* x;
  float* y;
  float* vx;
  float* vy;
  std::uint32_t* rgba;
  int count;
};

struct LaunchParams {
  float dt;
  float center_x;
  float center_y;
  float bounds_x;
  float bounds_y;
};

void launch_particle_field(ParticleBuffers buffers, LaunchParams params);
}
`, true);

  addFile(files, `src/gpu/particle_kernels.${deviceExt}`, `
${runtimeInclude}
#include "particle_api.hpp"

namespace scale {
constexpr float kHmrScaleDirection = 1.0f; // HMR_SCALE_DIRECTION_TOKEN
constexpr int kHmrScaleColorBias = 0;      // HMR_SCALE_COLOR_TOKEN

static __device__ unsigned int color_for(int i, float x, float y) {
  int band = (i + kHmrScaleColorBias + int(x * 0.03f) + int(y * 0.02f)) & 3;
  if (band == 0) return 0xff28d7ffu;
  if (band == 1) return 0xffffd166u;
  if (band == 2) return 0xff7bd88fu;
  return 0xffff5c8au;
}

extern "C" __global__ void advance_particle_field(
    float* x, float* y, float* vx, float* vy, unsigned int* rgba,
    int count, LaunchParams params) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= count) return;

  float px = x[i];
  float py = y[i];
  float dx = params.center_x - px;
  float dy = params.center_y - py;
  float len = sqrtf(dx * dx + dy * dy) + 0.001f;
  float swirl = ((i & 7) - 3.5f) * 0.018f;
  vx[i] += kHmrScaleDirection * ((dx / len) * 0.42f - dy * swirl) * params.dt;
  vy[i] += kHmrScaleDirection * ((dy / len) * 0.42f + dx * swirl) * params.dt;

  px += vx[i] * params.dt * 44.0f;
  py += vy[i] * params.dt * 44.0f;

  if (px < kResetPadding) {
    px = params.bounds_x - kResetPadding;
    vx[i] = fabsf(vx[i]) * 0.72f;
  } else if (px > params.bounds_x - kResetPadding) {
    px = kResetPadding;
    vx[i] = -fabsf(vx[i]) * 0.72f;
  }
  if (py < kResetPadding) {
    py = params.bounds_y - kResetPadding;
    vy[i] = fabsf(vy[i]) * 0.72f;
  } else if (py > params.bounds_y - kResetPadding) {
    py = kResetPadding;
    vy[i] = -fabsf(vy[i]) * 0.72f;
  }

  x[i] = px;
  y[i] = py;
  rgba[i] = color_for(i, px, py);
}

void launch_particle_field(ParticleBuffers buffers, LaunchParams params) {
  // Real user project launch site: ${launchComment}.
  (void)buffers;
  (void)params;
}
}
`, true);

  addFile(files, 'src/app/simulation.hpp', `
#pragma once
#include <array>
#include <vector>
#include "../math/vec2.hpp"
#include "../math/color.hpp"
#include "../gpu/particle_api.hpp"

namespace scale {
struct ParticleSnapshot {
  std::vector<Vec2> positions;
  std::vector<Rgba> colors;
};

class Simulation {
 public:
  Simulation();
  void step(float dt);
  ParticleSnapshot snapshot() const;

 private:
  std::array<float, kParticleCount> x_{};
  std::array<float, kParticleCount> y_{};
  std::array<float, kParticleCount> vx_{};
  std::array<float, kParticleCount> vy_{};
  std::array<std::uint32_t, kParticleCount> rgba_{};
};
}
`, true);

  addFile(files, 'src/app/simulation.cpp', `
#include "simulation.hpp"
#include <cmath>
#include "../config/particle_config.hpp"

namespace scale {
Simulation::Simulation() {
  for (int i = 0; i < kParticleCount; ++i) {
    float row = float(i / 32);
    float col = float(i % 32);
    x_[i] = 80.0f + col * 19.0f;
    y_[i] = 70.0f + row * 23.0f;
    vx_[i] = std::sin(float(i) * 0.37f) * 0.4f;
    vy_[i] = std::cos(float(i) * 0.29f) * 0.4f;
    rgba_[i] = 0xff28d7ffu;
  }
}

void Simulation::step(float dt) {
  ParticleBuffers buffers{x_.data(), y_.data(), vx_.data(), vy_.data(), rgba_.data(), kParticleCount};
  LaunchParams params{dt, kCanvasWidth * 0.5f, kCanvasHeight * 0.5f, float(kCanvasWidth), float(kCanvasHeight)};
  launch_particle_field(buffers, params);
}

ParticleSnapshot Simulation::snapshot() const {
  ParticleSnapshot out;
  out.positions.reserve(kParticleCount);
  out.colors.reserve(kParticleCount);
  for (int i = 0; i < kParticleCount; ++i) {
    out.positions.push_back({x_[i], y_[i]});
    std::uint32_t c = rgba_[i];
    out.colors.push_back({std::uint8_t(c & 0xff), std::uint8_t((c >> 8) & 0xff), std::uint8_t((c >> 16) & 0xff), 255});
  }
  return out;
}
}
`, true);

  if (renderBackend === 'sdl2') {
    addFile(files, 'src/render/sdl_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
struct SDL_Window;
struct SDL_Renderer;
namespace scale {
class SdlCanvas {
 public:
  SdlCanvas(int width, int height);
  ~SdlCanvas();
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  int width_;
  int height_;
  SDL_Window* window_;
  SDL_Renderer* renderer_;
  bool open_;
};
}
`, true);

    addFile(files, 'src/render/sdl_canvas.cpp', `
#include "sdl_canvas.hpp"
#include <SDL2/SDL.h>
#include <cstddef>
// LINK: -lSDL2
namespace scale {
SdlCanvas::SdlCanvas(int width, int height)
    : width_(width), height_(height), window_(nullptr), renderer_(nullptr), open_(true) {
  SDL_Init(SDL_INIT_VIDEO);
  window_ = SDL_CreateWindow("Scale Particle Field",
                             SDL_WINDOWPOS_CENTERED,
                             SDL_WINDOWPOS_CENTERED,
                             width_,
                             height_,
                             SDL_WINDOW_SHOWN);
  if (window_) {
    renderer_ = SDL_CreateRenderer(window_, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer_) {
      renderer_ = SDL_CreateRenderer(window_, -1, SDL_RENDERER_SOFTWARE);
    }
  }
}

SdlCanvas::~SdlCanvas() {
  if (renderer_) SDL_DestroyRenderer(renderer_);
  if (window_) SDL_DestroyWindow(window_);
  SDL_Quit();
}

bool SdlCanvas::pump() {
  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    if (event.type == SDL_QUIT) open_ = false;
  }
  return open_;
}

void SdlCanvas::draw(const ParticleSnapshot& snapshot) {
  if (!renderer_) return;
  SDL_SetRenderDrawColor(renderer_, 6, 10, 18, 255);
  SDL_RenderClear(renderer_);

  if (snapshot.colors.empty()) {
    SDL_RenderPresent(renderer_);
    return;
  }

  for (std::size_t i = 0; i < snapshot.positions.size(); ++i) {
    const Vec2& p = snapshot.positions[i];
    const Rgba& c = snapshot.colors[i % snapshot.colors.size()];
    SDL_Rect particle{static_cast<int>(p.x) - 3, static_cast<int>(p.y) - 3, 7, 7};
    SDL_SetRenderDrawColor(renderer_, c.r, c.g, c.b, c.a);
    SDL_RenderFillRect(renderer_, &particle);
  }

  SDL_SetRenderDrawColor(renderer_, 255, 255, 255, 64);
  SDL_RenderDrawLine(renderer_, width_ / 2 - 20, height_ / 2, width_ / 2 + 20, height_ / 2);
  SDL_RenderDrawLine(renderer_, width_ / 2, height_ / 2 - 20, width_ / 2, height_ / 2 + 20);
  SDL_RenderPresent(renderer_);
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/sdl_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::SdlCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else {
    addFile(files, 'src/render/glfw_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
struct GLFWwindow;
namespace scale {
class GlfwCanvas {
 public:
  GlfwCanvas(int width, int height);
  ~GlfwCanvas();
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  int width_;
  int height_;
  GLFWwindow* window_;
  bool open_;
};
}
`, true);

    addFile(files, 'src/render/glfw_canvas.cpp', `
#include "glfw_canvas.hpp"
#include <GLFW/glfw3.h>
#include <GL/gl.h>
#include <cstddef>
// LINK: -lglfw -lGL
namespace scale {
GlfwCanvas::GlfwCanvas(int width, int height)
    : width_(width), height_(height), window_(nullptr), open_(true) {
  if (!glfwInit()) {
    open_ = false;
    return;
  }
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 2);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 1);
  window_ = glfwCreateWindow(width_, height_, "Scale Particle Field", nullptr, nullptr);
  if (!window_) {
    open_ = false;
    glfwTerminate();
    return;
  }
  glfwMakeContextCurrent(window_);
  glfwSwapInterval(1);
}

GlfwCanvas::~GlfwCanvas() {
  if (window_) glfwDestroyWindow(window_);
  glfwTerminate();
}

bool GlfwCanvas::pump() {
  if (!window_ || !open_) return false;
  glfwPollEvents();
  open_ = !glfwWindowShouldClose(window_);
  return open_;
}

void GlfwCanvas::draw(const ParticleSnapshot& snapshot) {
  if (!window_) return;
  glfwMakeContextCurrent(window_);
  int fbw = width_;
  int fbh = height_;
  glfwGetFramebufferSize(window_, &fbw, &fbh);
  glViewport(0, 0, fbw, fbh);
  glMatrixMode(GL_PROJECTION);
  glLoadIdentity();
  glOrtho(0.0, double(width_), double(height_), 0.0, -1.0, 1.0);
  glMatrixMode(GL_MODELVIEW);
  glLoadIdentity();

  glClearColor(0.024f, 0.039f, 0.071f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);

  for (std::size_t i = 0; i < snapshot.positions.size(); ++i) {
    const Vec2& p = snapshot.positions[i];
    const Rgba& c = snapshot.colors[i % snapshot.colors.size()];
    const float r = c.r / 255.0f;
    const float g = c.g / 255.0f;
    const float b = c.b / 255.0f;
    glColor4f(r, g, b, 1.0f);
    glBegin(GL_QUADS);
    glVertex2f(p.x - 4.0f, p.y - 4.0f);
    glVertex2f(p.x + 4.0f, p.y - 4.0f);
    glVertex2f(p.x + 4.0f, p.y + 4.0f);
    glVertex2f(p.x - 4.0f, p.y + 4.0f);
    glEnd();
  }

  glColor4f(1.0f, 1.0f, 1.0f, 0.25f);
  glBegin(GL_LINES);
  glVertex2f(width_ / 2.0f - 24.0f, height_ / 2.0f);
  glVertex2f(width_ / 2.0f + 24.0f, height_ / 2.0f);
  glVertex2f(width_ / 2.0f, height_ / 2.0f - 24.0f);
  glVertex2f(width_ / 2.0f, height_ / 2.0f + 24.0f);
  glEnd();

  glfwSwapBuffers(window_);
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/glfw_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::GlfwCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  }

  addMultiSourceShardPack(files);

  for (let i = 0; i < 120; i += 1) {
    addFile(files, `docs/notes/field-note-${String(i).padStart(3, '0')}.md`, `
# Field Note ${i}

This note records experiment ${i} with particle drift coefficients and palette observations.
`);
  }
  for (let i = 0; i < 50; i += 1) {
    addFile(files, `assets/palettes/palette-${String(i).padStart(3, '0')}.json`, JSON.stringify({
      name: `palette-${i}`,
      stops: ['#28d7ff', '#ffd166', '#7bd88f', '#ff5c8a'],
      index: i,
    }, null, 2) + '\n');
  }
  for (let i = 0; i < 40; i += 1) {
    addFile(files, `experiments/archive/variant-${String(i).padStart(3, '0')}.cpp`, `
namespace archived_variant_${i} {
float coefficient_${i}(float x) { return x * ${1 + i * 0.001}f; }
}
`);
  }
  for (let i = 0; i < 30; i += 1) {
    addFile(files, `include/generated/table-${String(i).padStart(3, '0')}.hpp`, `
#pragma once
namespace generated_table_${i} {
constexpr int kValue = ${i};
}
`);
  }

  return {
    files,
    relevantFiles: files.filter((f) => f.relevant),
    primaryPath: 'src/app/main.cpp',
    devicePath: `src/gpu/particle_kernels.${deviceExt}`,
  };
}

function assertOrdinaryUserProject(files) {
  const abiHits = [];
  const roleNameHits = [];
  for (const file of files) {
    for (const needle of FORBIDDEN_ABI) {
      if (file.content.includes(needle)) abiHits.push(`${file.path}:${needle}`);
    }
    const lower = file.path.toLowerCase();
    for (const role of FORBIDDEN_ROLE_NAMES) {
      if (lower.split('/').some((part) => part.includes(role))) {
        roleNameHits.push(`${file.path}:${role}`);
      }
    }
  }
  if (abiHits.length) fail(`starting project contains Synthi ABI exports: ${abiHits.slice(0, 8).join(', ')}`);
  if (roleNameHits.length) fail(`starting project filenames contain generated role names: ${roleNameHits.slice(0, 8).join(', ')}`);
  record('ordinary user project guard', 'pass', `${files.length} files, no Synthi ABI or generated role filenames`);
}

async function compileViaMcp(args, waitTimeoutMs, phaseName, checkpoint) {
  const state = await ensureMcpAttached();
  const wallStart = Date.now();
  const compileDispatchedAt = new Date().toISOString();
  const compile = await state.client.toolCall('synthi_compile', args, waitTimeoutMs);
  if (!compile?.ok) throw new Error(`synthi_compile failed: ${JSON.stringify(compile).slice(0, 500)}`);
  const waitStartedAt = new Date().toISOString();
  const wait = await waitHmrForCurrentWorkspace(state, waitTimeoutMs, phaseName);
  const waitFinishedAt = new Date().toISOString();
  const wallElapsed = Date.now() - wallStart;
  const workerTail = await dockerLogs(CFG.workerContainer, checkpoint);
  const phase = {
    name: phaseName,
    compile_dispatched_at: compileDispatchedAt,
    wait_hmr_started_at: waitStartedAt,
    wait_hmr_finished_at: waitFinishedAt,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? 'unknown',
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    frame_gate: wait?.frame_gate ?? null,
    wall_elapsed_ms: wallElapsed,
    worker_log_markers: collectWorkerMarkers(workerTail),
  };
  report.phases.push(phase);
  if (wait?.status !== 'applied') {
    throw new Error(`${phaseName} wait_hmr status=${wait?.status ?? 'missing'} detail=${JSON.stringify(wait).slice(0, 500)}`);
  }
  return { compile, wait, phase };
}

async function waitHmrForCurrentWorkspace(state, timeoutMs, phaseName) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const wait = await state.client.toolCall('synthi_wait_hmr', { timeoutMs: remaining }, remaining + 5000);
    last = wait;
    const previewId = wait?.detail?.preview_id;
    if (previewId && previewId !== CFG.slug) {
      record(`${phaseName} ignored stale wait_hmr`, 'warn', `preview_id=${previewId} status=${wait?.status ?? 'unknown'}`);
      continue;
    }
    return wait;
  }
  return last ?? { status: 'timeout', elapsedMs: timeoutMs, source: 'validation_harness' };
}

async function dispatchCompileViaMcp(args, timeoutMs, phaseName, checkpoint) {
  const state = await ensureMcpAttached();
  const wallStart = Date.now();
  const compileDispatchedAt = new Date().toISOString();
  const compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  const workerTail = await dockerLogs(CFG.workerContainer, checkpoint);
  const phase = {
    name: phaseName,
    compile_dispatched_at: compileDispatchedAt,
    wait_hmr_started_at: null,
    wait_hmr_finished_at: null,
    wait_hmr_elapsed_ms: null,
    wait_hmr_terminal_elapsed_ms: null,
    wait_hmr_status: compile?.ok ? 'not_waited_expected_rejection' : 'dispatch_failed',
    wait_hmr_source: 'negative_validation',
    wait_hmr_detail: compile ?? null,
    frame_gate: null,
    wall_elapsed_ms: Date.now() - wallStart,
    worker_log_markers: collectWorkerMarkers(workerTail),
  };
  report.phases.push(phase);
  if (!compile?.ok) throw new Error(`synthi_compile dispatch failed: ${JSON.stringify(compile).slice(0, 500)}`);
  return { compile, phase };
}

function collectWorkerMarkers(text) {
  const patterns = [
    /\[AI Split\] ENTER[^\n]*/g,
    /GPU markers detected; calling GPU split endpoint[^\n]*/g,
    /GPU split endpoint returned a 5-file split/g,
    /\[GPU AI Delta\][^\n]*/g,
    /\[compile-device\] (?:hipcc|nvcc)[^\n]*/g,
    /\[gpu-reload\] plan=[^\n]*/g,
    /Device sidecar reload vendor=[^\n]*result=Success[^\n]*/g,
  ];
  const out = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      out.push(match[0].slice(0, 500));
    }
  }
  return [...new Set(out)];
}

async function captureScreenshot(label, compareTo = null) {
  const state = await ensureMcpAttached();
  const safe = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  let lastRow = null;
  const attempts = Math.max(1, CFG.screenshotAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const shot = await state.client.toolCallRaw(
      'synthi_screenshot',
      { freshness_max_ms: CFG.screenshotFreshnessMaxMs },
      30000,
    );
    const image = shot.content.find((b) => b?.type === 'image' && typeof b.data === 'string');
    if (!image?.data) throw new Error(`synthi_screenshot returned no image for ${label}`);
    const input = Buffer.from(image.data, 'base64');
    const suffix = attempt === 1 ? '' : `-attempt-${attempt}`;
    const outPath = path.join(ARTIFACT_DIR, `${CFG.slug}-${safe}${suffix}.png`);
    await writeFile(outPath, input);
    const analysis = await analyzeImage(input);
    const row = {
      path: outPath,
      width: analysis.width,
      height: analysis.height,
      visible_pixels: analysis.visible_pixels,
      mean_luma: analysis.mean_luma,
      captured_after_phase: label,
      attempt,
      seq: Number(shot.json?.seq || 0),
    };
    if (compareTo) {
      row.differs_from_first = await screenshotsDiffer(compareTo.path, outPath);
    }
    report.screenshots.push(row);
    const ok = row.width >= 320 && row.height >= 240 && row.visible_pixels > 500;
    const detail = `${row.width}x${row.height} visible=${row.visible_pixels} luma=${row.mean_luma.toFixed(1)} path=${outPath}`;
    if (ok) {
      record(`screenshot ${label}`, 'pass', attempt === 1 ? detail : `${detail} attempt=${attempt}`);
      return row;
    }
    lastRow = row;
    if (attempt < attempts) {
      record(`screenshot ${label} retry`, 'warn', `${detail} attempt=${attempt}/${attempts}`);
      await sleep(CFG.screenshotRetryDelayMs);
    }
  }
  const detail = lastRow
    ? `${lastRow.width}x${lastRow.height} visible=${lastRow.visible_pixels} luma=${lastRow.mean_luma.toFixed(1)} path=${lastRow.path}`
    : 'no screenshot captured';
  record(`screenshot ${label}`, 'fail', detail);
  throw new Error(`screenshot ${label} was not visibly non-black`);
}

async function analyzeImage(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  let lumaTotal = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaTotal += luma;
    if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) visible += 1;
  }
  const pixels = Math.max(1, info.width * info.height);
  return { width: info.width, height: info.height, visible_pixels: visible, mean_luma: lumaTotal / pixels };
}

async function screenshotsDiffer(leftPath, rightPath) {
  const left = await sharp(leftPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return true;
  let changed = 0;
  const len = Math.min(left.data.length, right.data.length);
  for (let i = 0; i < len; i += left.info.channels) {
    const dr = Math.abs((left.data[i] ?? 0) - (right.data[i] ?? 0));
    const dg = Math.abs((left.data[i + 1] ?? 0) - (right.data[i + 1] ?? 0));
    const db = Math.abs((left.data[i + 2] ?? 0) - (right.data[i + 2] ?? 0));
    if (dr + dg + db > 40) changed += 1;
  }
  return changed > 1000;
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

async function readGeneratedSplit(vendor, checkpoint) {
  const workspacePath = await workerWorkspacePath(checkpoint);
  const sidecarRaw = await readWorkerFile(workspacePath, '.synthi_split_meta.json');
  const sidecar = JSON.parse(sidecarRaw);
  const manifest = sidecar.compile_manifest;
  if (!manifest?.gpu) throw new Error('generated sidecar missing compile_manifest.gpu');
  const roles = manifestRolePaths(manifest, vendor);
  const files = {};
  for (const rel of Object.values(roles)) {
    files[rel] = await readWorkerFile(workspacePath, rel);
  }
  report.generated_roles = roles;
  return { workspacePath, sidecarRaw, sidecar, manifest, roles, files };
}

function validateGeneratedSplit(split, renderBackend) {
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
  const generatedText = `${core}\n${gui}\n${host}\n${device}\n${split.sidecarRaw}\n${JSON.stringify(split.manifest)}`;
  if (renderBackend === 'glfw') {
    if (!/\b(?:GLFW|glfw|-lglfw|GL\/gl\.h|glClear|glBegin|glDraw)/.test(generatedText)) {
      throw new Error('generated GLFW split does not preserve GLFW/OpenGL markers or link flags');
    }
    if (/\bSDL_|SDL2\/SDL\.h|-lSDL2/.test(generatedText)) {
      throw new Error('generated GLFW split introduced SDL markers');
    }
    record('generated split preserved GLFW/OpenGL backend', 'pass', 'no SDL markers in generated roles');
  } else if (renderBackend === 'sdl2') {
    if (!/\bSDL_|SDL2\/SDL\.h|-lSDL2/.test(generatedText)) {
      throw new Error('generated SDL2 split does not preserve SDL2 markers or link flags');
    }
    record('generated split preserved SDL2 backend', 'pass', 'SDL2 markers present');
  }
  record('generated split contains HMR ABI', 'pass', Object.values(split.roles).join(', '));
}

function launchIndirectionReport(sidecar) {
  return sidecar?.launchIndirectionReport
    || sidecar?.launch_indirection_report
    || sidecar?.runReport?.launchIndirectionReport
    || null;
}

function staleLaunchPointerChecks(sidecar) {
  const launchReport = launchIndirectionReport(sidecar);
  return sidecar?.staleLaunchPointerChecks
    || sidecar?.runReport?.staleLaunchPointerChecks
    || launchReport?.staleLaunchPointerChecks
    || null;
}

function validateLaunchIndirectionContract(split) {
  const launchReport = launchIndirectionReport(split.sidecar);
  const staleChecks = staleLaunchPointerChecks(split.sidecar);
  if (!launchReport) throw new Error('split sidecar missing launch indirection report');
  if (!staleChecks) throw new Error('split sidecar missing stale launch pointer checks');
  if (launchReport.schemaVersion !== 'synthi.gpu.launch_indirection.v1') {
    throw new Error(`unexpected launch indirection schema: ${launchReport.schemaVersion ?? 'missing'}`);
  }
  if (launchReport.status !== 'pass') {
    throw new Error(`launch indirection report did not pass: ${JSON.stringify(launchReport).slice(0, 500)}`);
  }
  if (staleChecks.status !== 'pass') {
    throw new Error(`stale launch pointer check did not pass: ${JSON.stringify(staleChecks).slice(0, 500)}`);
  }
  if (staleChecks.failureReasonCode !== 'reload_failed.stale_launch_pointer') {
    throw new Error(`unexpected stale launch failure reason: ${staleChecks.failureReasonCode ?? 'missing'}`);
  }
  const hostText = [
    split.files[split.roles.core] || '',
    split.files[split.roles.gui] || '',
    split.files[split.roles.host_runner] || '',
  ].join('\n');
  const publicWrapperCalls = [...hostText.matchAll(/\bsynthi_gpu_launch\s*\(/g)];
  const forbidden = hostText.match(/\bsynthi_gpu_(?:launch_raw(?:_checked)?|launch_table|launch_generation)\s*\(|\b[A-Za-z_][A-Za-z0-9_:]*\s*<<<|\b(?:cuModuleGetFunction|hipModuleGetFunction|cuLaunchKernel|hipModuleLaunchKernel)\s*\(/);
  if (!publicWrapperCalls.length) {
    throw new Error('generated host roles do not call synthi_gpu_launch public wrapper');
  }
  if (forbidden) {
    throw new Error(`generated host role bypasses launch indirection: ${forbidden[0]}`);
  }
  if (Number(launchReport.directLaunchBypassCount || 0) !== 0 || Number(launchReport.vendorSymbolLookupBypassCount || 0) !== 0) {
    throw new Error(`launch indirection report contains bypass counts: ${JSON.stringify(launchReport).slice(0, 500)}`);
  }
  report.launch_indirection = {
    schemaVersion: launchReport.schemaVersion,
    status: launchReport.status,
    tableVersion: launchReport.tableVersion ?? null,
    launchSiteCount: launchReport.launchSiteCount ?? publicWrapperCalls.length,
    staleLaunchPointerCheckStatus: staleChecks.status,
    failureReasonCode: staleChecks.failureReasonCode,
  };
  record(
    'generated launch sites use indirection table',
    'pass',
    `launchSites=${report.launch_indirection.launchSiteCount} tableVersion=${report.launch_indirection.tableVersion ?? 'n/a'}`,
  );
  record('stale launch pointer check passed', 'pass', staleChecks.failureReasonCode);
}

function generatedWorkspaceArtifacts(split) {
  const artifacts = new Set(GENERATED_WORKSPACE_ARTIFACTS);
  for (const rel of Object.values(split?.roles ?? {})) {
    artifacts.add(cleanRel(rel));
  }
  return artifacts;
}

function recordGeneratedSplitKeptInternal(split) {
  record('generated split kept internal', 'pass', `${Object.values(split.roles).join(', ')} supplied inline to HMR compile only`);
}

async function assertNoGeneratedSplitWorkspaceArtifacts(split) {
  const listed = await listWorkspaceFiles(CFG.slug);
  const paths = listed
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .map(cleanRel)
    .filter(Boolean);
  const generatedArtifacts = generatedWorkspaceArtifacts(split);
  const leaked = paths.filter((p) => generatedArtifacts.has(p));
  if (leaked.length) {
    fail(`workspace contains generated split artifacts: ${leaked.join(', ')}`);
  }
  record('workspace visible tree remains user files only', 'pass', `${paths.length} listed files; no generated split artifacts`);
}

function editUserDeviceSource(source) {
  const replacements = [
    [/\bvx\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*\+=\s*([^;]+);/, (_m, idx, expr) => `vx[${idx}] -= ${expr};`],
    [/\bvy\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*\+=\s*([^;]+);/, (_m, idx, expr) => `vy[${idx}] -= ${expr};`],
    [/\brgba\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*=\s*([^;]+);/, (_m, idx, expr) => `rgba[${idx}] = ((${expr}) ^ 0x00ffffffu);`],
  ];
  for (const [regex, replacement] of replacements) {
    const edited = source.replace(regex, replacement);
    if (edited !== source) return edited;
  }
  throw new Error('user device source did not preserve an editable scale validation token');
}

function editUserDeviceSignature(source) {
  const edited = source.replace(
    /(__global__\s+void\s+[A-Za-z_][A-Za-z0-9_]*\s*\()([^)]*)(\)\s*\{)/,
    (_match, prefix, params, suffix) => {
      const extra = params.trim() ? ', float synthi_hmr_abi_probe' : 'float synthi_hmr_abi_probe';
      return `${prefix}${params}${extra}${suffix}`;
    },
  );
  if (edited === source) throw new Error('user device source did not preserve an editable kernel signature');
  return edited;
}

function editUserDeviceConstantGlobalLayout(source) {
  if (source.includes('synthi_hmr_layout_probe')) {
    throw new Error('user device source already contains layout probe symbol');
  }
  const insertion = '__constant__ float synthi_hmr_layout_probe[2];\n';
  const namespaceIndex = source.search(/\bnamespace\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/);
  if (namespaceIndex >= 0) {
    return `${source.slice(0, namespaceIndex)}${insertion}${source.slice(namespaceIndex)}`;
  }
  const kernelIndex = source.search(/(?:extern\s+"C"\s+)?__global__\s+void\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  if (kernelIndex >= 0) {
    return `${source.slice(0, kernelIndex)}${insertion}${source.slice(kernelIndex)}`;
  }
  throw new Error('user device source did not preserve an insertion point for a device-global layout probe');
}

function sidecarWithStaleToolchain(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  sidecar.toolchainCapabilities = sidecar.toolchainCapabilities && typeof sidecar.toolchainCapabilities === 'object'
    ? sidecar.toolchainCapabilities
    : {};
  sidecar.toolchainCapabilities.status = 'stale';
  sidecar.toolchainCapabilities.staleReason = 'scale_validation_probe';
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function sidecarWithoutToolchain(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  sidecar.toolchainCapabilities = {
    schemaVersion: 'synthi.gpu.toolchain_capability.v1',
    status: 'missing',
    missingReason: 'scale_validation_probe',
    supportsDeviceOnlyReload: false,
  };
  delete sidecar.toolchainCapabilityProfile;
  delete sidecar.toolchainCapabilityProfileHash;
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function sidecarWithStaleLaunchPointer(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  const baseReport = launchIndirectionReport(sidecar) || {};
  const staleChecks = {
    ...(baseReport.staleLaunchPointerChecks || {}),
    schemaVersion: 'synthi.gpu.stale_launch_pointer_check.v1',
    status: 'fail',
    runtimeGenerationChecked: false,
    failureReasonCode: 'reload_failed.stale_launch_pointer',
    reasonCodes: ['stale_launch_pointer_detected', 'reload_failed.stale_launch_pointer'],
  };
  const staleReport = {
    ...baseReport,
    schemaVersion: 'synthi.gpu.launch_indirection.v1',
    status: 'fail',
    stalePointerRisk: 'detected',
    generatedLaunchSitesUseIndirection: baseReport.generatedLaunchSitesUseIndirection ?? true,
    directLaunchBypassCount: Number(baseReport.directLaunchBypassCount || 0),
    staleLaunchPointerChecks: staleChecks,
    reasonCodes: ['stale_launch_pointer_detected', 'reload_failed.stale_launch_pointer'],
  };
  sidecar.launch_indirection_report = staleReport;
  sidecar.launchIndirectionReport = staleReport;
  sidecar.staleLaunchPointerChecks = staleChecks;
  if (sidecar.runReport && typeof sidecar.runReport === 'object') {
    sidecar.runReport.launchIndirectionReport = staleReport;
    sidecar.runReport.staleLaunchPointerChecks = staleChecks;
  }
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

async function compileUserDeviceDelta(project, editedDevice, vendor, checkpoint) {
  if (CFG.hmrDeltaMode !== 'ai_user_delta') {
    throw new Error(`unsupported SYNTHI_SCALE_HMR_DELTA_MODE=${CFG.hmrDeltaMode}; expected ai_user_delta`);
  }
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.devicePath))
    .map((f) => ({ name: f.path, content: f.content }));
  return compileViaMcp({
    language: 'cpp',
    filename: project.devicePath,
    source: editedDevice,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    force_gpu_ai_delta: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs, 'ai_device_delta_hmr', checkpoint);
}

async function dispatchUserDeviceSignatureNegative(project, signatureEditedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, signatureEditedDevice, vendor, checkpoint, 'negative_signature_rejection');
}

async function dispatchUserDeviceConstantGlobalNegative(project, layoutEditedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, layoutEditedDevice, vendor, checkpoint, 'negative_constant_global_rejection');
}

async function dispatchUserDeviceStaleToolchainNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, editedDevice, vendor, checkpoint, 'negative_stale_toolchain_rejection');
}

async function dispatchUserDeviceMissingToolchainNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, editedDevice, vendor, checkpoint, 'negative_missing_toolchain_rejection');
}

async function dispatchUserDeviceStaleLaunchPointerNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, editedDevice, vendor, checkpoint, 'negative_stale_launch_pointer_rejection');
}

async function dispatchForcedAiDeltaStaleLaunchPointerNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchForcedAiDeltaNegative(project, editedDevice, vendor, checkpoint, 'negative_forced_ai_delta_stale_launch_pointer_rejection');
}

async function dispatchForcedAiDeltaStaleToolchainNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchForcedAiDeltaNegative(project, editedDevice, vendor, checkpoint, 'negative_forced_ai_delta_stale_toolchain_rejection');
}

async function dispatchForcedAiDeltaMissingToolchainNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchForcedAiDeltaNegative(project, editedDevice, vendor, checkpoint, 'negative_forced_ai_delta_missing_toolchain_rejection');
}

async function dispatchForcedAiDeltaNegative(project, editedDevice, vendor, checkpoint, phaseName) {
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.devicePath))
    .map((f) => ({ name: f.path, content: f.content }));
  return dispatchCompileViaMcp({
    language: 'cpp',
    filename: project.devicePath,
    source: editedDevice,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    force_gpu_ai_delta: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs, phaseName, checkpoint);
}

async function dispatchUserDeviceNegative(project, deviceSource, vendor, checkpoint, phaseName) {
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.devicePath))
    .map((f) => ({ name: f.path, content: f.content }));
  return dispatchCompileViaMcp({
    language: 'cpp',
    filename: project.devicePath,
    source: deviceSource,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs, phaseName, checkpoint);
}

async function assertNoSidecarReloadAfterHardStop(hardStop, checkpoint, checkName) {
  await sleep(1500);
  const negativeTail = await dockerLogs(CFG.workerContainer, checkpoint);
  const hardStopOffset = hardStop.snippet ? negativeTail.indexOf(hardStop.snippet) : -1;
  const tailAfterHardStop = hardStopOffset >= 0
    ? negativeTail.slice(hardStopOffset + hardStop.snippet.length)
    : negativeTail;
  const reload = tailAfterHardStop.match(/Device sidecar reload vendor=[^\n]*result=Success[^\n]*/);
  record(checkName, reload ? 'fail' : 'pass', reload?.[0] || 'no successful sidecar reload after hard-stop rejection');
  if (reload) throw new Error(`${checkName}: unexpected sidecar reload: ${reload[0]}`);
}

async function writeReport() {
  report.finished_at = new Date().toISOString();
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  await writeFile(RESULTS_JSON, json);
  await writeFile(BACKEND_RESULTS_JSON, json);
  const lines = [
    `slug: ${report.slug}`,
    `repo_commit: ${report.repo_commit}`,
    `model: ${report.model}`,
    `vendor: ${report.vendor}`,
    `arch: ${report.arch}`,
    `render_backend: ${report.render_backend}`,
    `source_file_mix: ${JSON.stringify(report.source_file_mix)}`,
    `workspace_file_count: ${report.workspace_file_count}`,
    `relevant_file_count: ${report.relevant_file_count}`,
    `generated_roles: ${JSON.stringify(report.generated_roles)}`,
    '',
    ...report.checks.map((r) => `${r.status.toUpperCase()} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`),
    '',
    ...report.phases.map((p) => {
      const detail = p.wait_hmr_detail ? ` detail=${JSON.stringify(p.wait_hmr_detail).slice(0, 500)}` : '';
      const frameGate = p.frame_gate ? ` frame_gate=${JSON.stringify(p.frame_gate).slice(0, 300)}` : '';
      return `PHASE ${p.name} wait=${p.wait_hmr_status} source=${p.wait_hmr_source ?? ''} wait_ms=${p.wait_hmr_elapsed_ms} terminal_wait_ms=${p.wait_hmr_terminal_elapsed_ms ?? ''} wall_ms=${p.wall_elapsed_ms}${detail}${frameGate}`;
    }),
    '',
    ...report.screenshots.map((s) => `SCREENSHOT ${s.captured_after_phase} ${s.width}x${s.height} visible=${s.visible_pixels} luma=${s.mean_luma.toFixed(1)} path=${s.path} differs=${s.differs_from_first ?? ''}`),
  ];
  const text = lines.join('\n') + '\n';
  await writeFile(RESULTS_TXT, text);
  await writeFile(BACKEND_RESULTS_TXT, text);
  console.log(`results: ${RESULTS_TXT}`);
  console.log(`backend_results: ${BACKEND_RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  if (!['sdl2', 'glfw'].includes(CFG.renderBackend)) {
    fail(`unsupported SYNTHI_SCALE_RENDER_BACKEND=${CFG.renderBackend}; expected sdl2 or glfw`);
  }
  await resolveDockerContainers();
  report.repo_commit = await execText('git', ['rev-parse', 'HEAD'], 10000, true);
  const vendor = await detectVendor();
  const arch = await detectArch(vendor);
  CFG.gpuArch = arch;
  report.vendor = vendor;
  report.arch = arch;
  report.env = {
    SYNTHI_GEMINI_MODEL: CFG.geminiModel,
    SYNTHI_GPU_VENDOR: process.env.SYNTHI_GPU_VENDOR ?? '',
    SYNTHI_GPU_ARCH: arch,
    SYNTHI_SCALE_RENDER_BACKEND: CFG.renderBackend,
    SYNTHI_SCALE_HMR_DELTA_MODE: CFG.hmrDeltaMode,
    SYNTHI_SYNC_TO_GCS: process.env.SYNTHI_SYNC_TO_GCS ?? '',
  };
  report.containers = {
    worker: await containerSnapshot(CFG.workerContainer),
    ai_engine: await containerSnapshot(CFG.aiEngineContainer),
    mcp: await containerSnapshot(CFG.mcpContainer),
  };
  record('gpu target', 'pass', `${vendor} arch=${arch} render_backend=${CFG.renderBackend}`);

  const project = buildScaleProject(vendor, arch, CFG.renderBackend);
  report.workspace_file_count = project.files.length;
  report.relevant_file_count = project.relevantFiles.length;
  report.source_file_mix = sourceFileMix(project.relevantFiles);
  if (project.files.length < 200) fail(`scale fixture only has ${project.files.length} files`);
  if (report.source_file_mix.total < 40) fail(`scale fixture only has ${report.source_file_mix.total} source/header/device files`);
  record('source file mix', 'pass', JSON.stringify(report.source_file_mix));
  assertOrdinaryUserProject(project.files);

  const workspace = await createWorkspace({ name: `Synthi GPU Scale Validation (${vendor}/${CFG.renderBackend})`, slug: CFG.slug });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);
  await writeFilesBatch({ slug: CFG.slug, files: project.files });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: seed ordinary project' });
  record('seed scale workspace', 'pass', `${project.files.length} files`);

  const primary = project.files.find((f) => f.path === project.primaryPath);
  if (!primary) fail(`missing primary source ${project.primaryPath}`);
  const deviceSource = project.files.find((f) => f.path === project.devicePath);
  if (!deviceSource) fail(`missing device source ${project.devicePath}`);
  const additionalFiles = project.files
    .filter((f) => f.path !== project.primaryPath)
    .map((f) => ({ name: f.path, content: f.content }));

  const firstCheckpoint = await workerCheckpoint();
  const aiCheckpoint = await workerCheckpoint();
  await compileViaMcp({
    language: 'cpp',
    filename: project.primaryPath,
    source: primary.content,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: arch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.firstCompileTimeoutMs, 'first_ai_split_compile', firstCheckpoint);
  record('first compile via MCP', 'pass', `files=${1 + additionalFiles.length}`);

  const workerFileMarker = await awaitLogRegex(
    CFG.workerContainer,
    new RegExp(`\\[AI Split\\] ENTER .*files=${project.files.length}.*gpu_arch=${arch}`),
    1000,
    firstCheckpoint,
  );
  record('worker saw full file set', workerFileMarker.matched ? 'pass' : 'fail', workerFileMarker.snippet || `missing files=${project.files.length}`);

  const aiFileMarker = await awaitLogRegex(
    CFG.aiEngineContainer,
    new RegExp(`\\[split/gpu\\] request file context count=${project.files.length}.*${project.primaryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    1000,
    aiCheckpoint,
  );
  record('ai-engine saw full file set', aiFileMarker.matched ? 'pass' : 'fail', aiFileMarker.snippet || `missing count=${project.files.length}`);
  if (!workerFileMarker.matched || !aiFileMarker.matched) {
    throw new Error('file-set delivery evidence missing');
  }

  const firstShot = await captureScreenshot('first-compile');
  const split = await readGeneratedSplit(vendor, firstCheckpoint);
  validateGeneratedSplit(split, CFG.renderBackend);
  validateLaunchIndirectionContract(split);
  record('read generated split from worker', 'pass', `worker=${split.workspacePath}`);
  recordGeneratedSplitKeptInternal(split);

  const editedDevice = editUserDeviceSource(deviceSource.content);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: editedDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: user device delta' });
  const secondCheckpoint = await workerCheckpoint();
  await compileUserDeviceDelta(project, editedDevice, vendor, secondCheckpoint);
  record('user device-source AI delta compile via MCP', 'pass', project.devicePath);
  await assertNoGeneratedSplitWorkspaceArtifacts(split);

  const aiDeltaWorker = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] Calling [^\n]*\/refactor\/diff_patch\/gpu[^\n]*|\[GPU AI Delta\] accepted: user=[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    secondCheckpoint,
  );
  record('worker forced GPU AI delta endpoint', aiDeltaWorker.matched ? 'pass' : 'fail', aiDeltaWorker.snippet || 'no GPU AI delta worker marker');
  if (!aiDeltaWorker.matched) throw new Error('GPU AI delta worker evidence missing');

  const aiDeltaBackend = await awaitLogRegex(
    CFG.aiEngineContainer,
    /\[GpuDiffPatch\][^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    secondCheckpoint,
  );
  record('ai-engine processed GPU delta', aiDeltaBackend.matched ? 'pass' : 'fail', aiDeltaBackend.snippet || 'no GpuDiffPatch marker');
  if (!aiDeltaBackend.matched) throw new Error('GPU AI delta backend evidence missing');

  const hotSwap = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-reload\] plan=device_only[^\n]*|Device sidecar reload vendor=[^\n]*result=Success[^\n]*/,
    1000,
    secondCheckpoint,
  );
  record('device-only GPU HMR observed', hotSwap.matched ? 'pass' : 'fail', hotSwap.snippet || 'no device-only reload marker');
  if (!hotSwap.matched) throw new Error('device-only GPU HMR evidence missing');

  await sleep(1000);
  const secondShot = await captureScreenshot('post-hmr', firstShot);
  if (!secondShot.differs_from_first) {
    throw new Error('post-HMR screenshot did not differ materially from first screenshot');
  }

  const afterReload = await dockerLogs(CFG.workerContainer, secondCheckpoint);
  const crashMatch = afterReload.match(/Runner process (?:has already )?exited[^\n]*|SIGSEGV|core dumped|Device reload result .*Failed/);
  record('runner stayed alive after GPU HMR', crashMatch ? 'fail' : 'pass', crashMatch?.[0] || 'no runner crash marker');
  if (crashMatch) throw new Error(`runner/device failure after HMR: ${crashMatch[0]}`);

  const verifiedFastPathSidecarRaw = await readWorkerFile(split.workspacePath, '.synthi_split_meta.json');

  const layoutEditedDevice = editUserDeviceConstantGlobalLayout(editedDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: layoutEditedDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: constant layout rejection probe' });
  const layoutCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceConstantGlobalNegative(project, layoutEditedDevice, vendor, layoutCheckpoint);
  record('constant/global edit compile dispatched via MCP', 'pass', project.devicePath);
  const layoutReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*abi\.constant_global_layout_changed[^\n]*/,
    10000,
    layoutCheckpoint,
  );
  record('constant/global edit blocks device_only', layoutReject.matched ? 'pass' : 'fail', layoutReject.snippet || 'no abi.constant_global_layout_changed rejection marker');
  if (!layoutReject.matched) throw new Error('constant/global layout rejection evidence missing');

  const layoutHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*abi\.constant_global_layout_changed[^\n]*/,
    10000,
    layoutCheckpoint,
  );
  record('constant/global edit stops unsafe fallback', layoutHardStop.matched ? 'pass' : 'fail', layoutHardStop.snippet || 'no hard-stop rejection marker');
  if (!layoutHardStop.matched) throw new Error('constant/global layout hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(layoutHardStop, layoutCheckpoint, 'constant/global edit does not reload sidecar');

  const signatureEditedDevice = editUserDeviceSignature(editedDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: signatureEditedDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: signature rejection probe' });
  const negativeCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceSignatureNegative(project, signatureEditedDevice, vendor, negativeCheckpoint);
  record('signature edit compile dispatched via MCP', 'pass', project.devicePath);
  const signatureReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*abi\.kernel_signature_changed[^\n]*/,
    10000,
    negativeCheckpoint,
  );
  record('signature edit blocks device_only', signatureReject.matched ? 'pass' : 'fail', signatureReject.snippet || 'no abi.kernel_signature_changed rejection marker');
  if (!signatureReject.matched) throw new Error('signature rejection evidence missing');

  const signatureHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*abi\.kernel_signature_changed[^\n]*/,
    10000,
    negativeCheckpoint,
  );
  record('signature edit stops unsafe fallback', signatureHardStop.matched ? 'pass' : 'fail', signatureHardStop.snippet || 'no hard-stop rejection marker');
  if (!signatureHardStop.matched) throw new Error('signature hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(signatureHardStop, negativeCheckpoint, 'signature edit does not reload sidecar');

  const staleLaunchDevice = editUserDeviceSource(editedDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: staleLaunchDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: stale launch pointer rejection probe' });
  const staleLaunchSidecar = sidecarWithStaleLaunchPointer(verifiedFastPathSidecarRaw);
  await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', staleLaunchSidecar);
  const staleLaunchCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceStaleLaunchPointerNegative(project, staleLaunchDevice, vendor, staleLaunchCheckpoint);
  record('stale launch pointer edit compile dispatched via MCP', 'pass', project.devicePath);
  const staleLaunchReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*stale_launch_pointer_detected[^\n]*/,
    10000,
    staleLaunchCheckpoint,
  );
  record('stale launch pointer blocks device_only', staleLaunchReject.matched ? 'pass' : 'fail', staleLaunchReject.snippet || 'no stale_launch_pointer_detected rejection marker');
  if (!staleLaunchReject.matched) throw new Error('stale launch pointer rejection evidence missing');

  const staleLaunchHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*stale_launch_pointer_detected[^\n]*/,
    10000,
    staleLaunchCheckpoint,
  );
  record('stale launch pointer stops unsafe fallback', staleLaunchHardStop.matched ? 'pass' : 'fail', staleLaunchHardStop.snippet || 'no stale launch pointer hard-stop marker');
  if (!staleLaunchHardStop.matched) throw new Error('stale launch pointer hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(staleLaunchHardStop, staleLaunchCheckpoint, 'stale launch pointer does not reload sidecar');

  const staleLaunchAiDeltaCheckpoint = await workerCheckpoint();
  await dispatchForcedAiDeltaStaleLaunchPointerNegative(project, staleLaunchDevice, vendor, staleLaunchAiDeltaCheckpoint);
  record('stale launch pointer forced AI delta dispatched via MCP', 'pass', project.devicePath);
  const staleLaunchAiDeltaWorker = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] Calling [^\n]*\/refactor\/diff_patch\/gpu[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleLaunchAiDeltaCheckpoint,
  );
  record('worker sent stale-launch-pointer delta to GPU AI endpoint', staleLaunchAiDeltaWorker.matched ? 'pass' : 'fail', staleLaunchAiDeltaWorker.snippet || 'no forced stale-launch-pointer GPU AI delta worker marker');
  if (!staleLaunchAiDeltaWorker.matched) throw new Error('forced stale-launch-pointer GPU AI delta worker evidence missing');

  const staleLaunchAiDeltaBackend = await awaitLogRegex(
    CFG.aiEngineContainer,
    /\[GpuDiffPatch\][^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleLaunchAiDeltaCheckpoint,
  );
  record('ai-engine processed stale-launch-pointer GPU delta', staleLaunchAiDeltaBackend.matched ? 'pass' : 'fail', staleLaunchAiDeltaBackend.snippet || 'no stale-launch-pointer GpuDiffPatch marker');
  if (!staleLaunchAiDeltaBackend.matched) throw new Error('forced stale-launch-pointer GPU AI delta backend evidence missing');

  const staleLaunchAiDeltaReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] rejected: user=[^\n]*requested_plan=device_only[^\n]*stale_launch_pointer_detected[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleLaunchAiDeltaCheckpoint,
  );
  record('stale launch pointer AI delta rejected by verifier policy', staleLaunchAiDeltaReject.matched ? 'pass' : 'fail', staleLaunchAiDeltaReject.snippet || 'no stale-launch-pointer AI delta verifier rejection marker');
  if (!staleLaunchAiDeltaReject.matched) throw new Error('forced stale-launch-pointer GPU AI delta verifier rejection evidence missing');
  await assertNoSidecarReloadAfterHardStop(staleLaunchAiDeltaReject, staleLaunchAiDeltaCheckpoint, 'stale launch pointer AI delta does not reload sidecar');

  const staleCapabilityDevice = editUserDeviceSource(staleLaunchDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: staleCapabilityDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: stale toolchain rejection probe' });
  const staleToolchainSidecar = sidecarWithStaleToolchain(
    verifiedFastPathSidecarRaw,
  );
  await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', staleToolchainSidecar);
  const staleToolchainCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceStaleToolchainNegative(project, staleCapabilityDevice, vendor, staleToolchainCheckpoint);
  record('stale toolchain edit compile dispatched via MCP', 'pass', project.devicePath);
  const staleToolchainReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*toolchain_capability_stale[^\n]*/,
    10000,
    staleToolchainCheckpoint,
  );
  record('stale toolchain capability blocks device_only', staleToolchainReject.matched ? 'pass' : 'fail', staleToolchainReject.snippet || 'no toolchain_capability_stale rejection marker');
  if (!staleToolchainReject.matched) throw new Error('stale toolchain rejection evidence missing');

  const staleToolchainHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*toolchain_capability_stale[^\n]*/,
    10000,
    staleToolchainCheckpoint,
  );
  record('stale toolchain capability stops unsafe fallback', staleToolchainHardStop.matched ? 'pass' : 'fail', staleToolchainHardStop.snippet || 'no stale toolchain hard-stop marker');
  if (!staleToolchainHardStop.matched) throw new Error('stale toolchain hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(staleToolchainHardStop, staleToolchainCheckpoint, 'stale toolchain capability does not reload sidecar');

  const staleAiDeltaCheckpoint = await workerCheckpoint();
  await dispatchForcedAiDeltaStaleToolchainNegative(project, staleCapabilityDevice, vendor, staleAiDeltaCheckpoint);
  record('stale toolchain forced AI delta dispatched via MCP', 'pass', project.devicePath);
  const staleAiDeltaWorker = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] Calling [^\n]*\/refactor\/diff_patch\/gpu[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleAiDeltaCheckpoint,
  );
  record('worker sent stale-toolchain delta to GPU AI endpoint', staleAiDeltaWorker.matched ? 'pass' : 'fail', staleAiDeltaWorker.snippet || 'no forced GPU AI delta worker marker');
  if (!staleAiDeltaWorker.matched) throw new Error('forced stale-toolchain GPU AI delta worker evidence missing');

  const staleAiDeltaBackend = await awaitLogRegex(
    CFG.aiEngineContainer,
    /\[GpuDiffPatch\][^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleAiDeltaCheckpoint,
  );
  record('ai-engine processed stale-toolchain GPU delta', staleAiDeltaBackend.matched ? 'pass' : 'fail', staleAiDeltaBackend.snippet || 'no stale-toolchain GpuDiffPatch marker');
  if (!staleAiDeltaBackend.matched) throw new Error('forced stale-toolchain GPU AI delta backend evidence missing');

  const staleAiDeltaReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] rejected: user=[^\n]*requested_plan=device_only[^\n]*toolchain_capability_stale[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    staleAiDeltaCheckpoint,
  );
  record('stale toolchain AI delta rejected by verifier policy', staleAiDeltaReject.matched ? 'pass' : 'fail', staleAiDeltaReject.snippet || 'no stale-toolchain AI delta verifier rejection marker');
  if (!staleAiDeltaReject.matched) throw new Error('forced stale-toolchain GPU AI delta verifier rejection evidence missing');
  await assertNoSidecarReloadAfterHardStop(staleAiDeltaReject, staleAiDeltaCheckpoint, 'stale toolchain AI delta does not reload sidecar');

  const missingCapabilityDevice = staleCapabilityDevice;
  const missingToolchainSidecar = sidecarWithoutToolchain(
    verifiedFastPathSidecarRaw,
  );
  await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', missingToolchainSidecar);
  const missingToolchainCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceMissingToolchainNegative(project, missingCapabilityDevice, vendor, missingToolchainCheckpoint);
  record('missing toolchain edit compile dispatched via MCP', 'pass', project.devicePath);
  const missingToolchainReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*toolchain_capability_missing[^\n]*/,
    10000,
    missingToolchainCheckpoint,
  );
  record('missing toolchain capability blocks device_only', missingToolchainReject.matched ? 'pass' : 'fail', missingToolchainReject.snippet || 'no toolchain_capability_missing rejection marker');
  if (!missingToolchainReject.matched) throw new Error('missing toolchain rejection evidence missing');

  const missingToolchainHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*toolchain_capability_missing[^\n]*/,
    10000,
    missingToolchainCheckpoint,
  );
  record('missing toolchain capability stops unsafe fallback', missingToolchainHardStop.matched ? 'pass' : 'fail', missingToolchainHardStop.snippet || 'no missing toolchain hard-stop marker');
  if (!missingToolchainHardStop.matched) throw new Error('missing toolchain hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(missingToolchainHardStop, missingToolchainCheckpoint, 'missing toolchain capability does not reload sidecar');

  const missingAiDeltaCheckpoint = await workerCheckpoint();
  await dispatchForcedAiDeltaMissingToolchainNegative(project, missingCapabilityDevice, vendor, missingAiDeltaCheckpoint);
  record('missing toolchain forced AI delta dispatched via MCP', 'pass', project.devicePath);
  const missingAiDeltaWorker = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] Calling [^\n]*\/refactor\/diff_patch\/gpu[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    missingAiDeltaCheckpoint,
  );
  record('worker sent missing-toolchain delta to GPU AI endpoint', missingAiDeltaWorker.matched ? 'pass' : 'fail', missingAiDeltaWorker.snippet || 'no forced missing-toolchain GPU AI delta worker marker');
  if (!missingAiDeltaWorker.matched) throw new Error('forced missing-toolchain GPU AI delta worker evidence missing');

  const missingAiDeltaBackend = await awaitLogRegex(
    CFG.aiEngineContainer,
    /\[GpuDiffPatch\][^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    missingAiDeltaCheckpoint,
  );
  record('ai-engine processed missing-toolchain GPU delta', missingAiDeltaBackend.matched ? 'pass' : 'fail', missingAiDeltaBackend.snippet || 'no missing-toolchain GpuDiffPatch marker');
  if (!missingAiDeltaBackend.matched) throw new Error('forced missing-toolchain GPU AI delta backend evidence missing');

  const missingAiDeltaReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[GPU AI Delta\] rejected: user=[^\n]*requested_plan=device_only[^\n]*toolchain_capability_missing[^\n]*/,
    CFG.aiDeltaEvidenceTimeoutMs,
    missingAiDeltaCheckpoint,
  );
  record('missing toolchain AI delta rejected by verifier policy', missingAiDeltaReject.matched ? 'pass' : 'fail', missingAiDeltaReject.snippet || 'no missing-toolchain AI delta verifier rejection marker');
  if (!missingAiDeltaReject.matched) throw new Error('forced missing-toolchain GPU AI delta verifier rejection evidence missing');
  await assertNoSidecarReloadAfterHardStop(missingAiDeltaReject, missingAiDeltaCheckpoint, 'missing toolchain AI delta does not reload sidecar');

  await writeReport();
  const failures = report.checks.filter((r) => r.status === 'fail');
  if (failures.length) process.exitCode = 1;
  console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
}

run()
  .catch(async (err) => {
    record('fatal', 'fail', err.stack || err.message);
    await writeReport().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => stopMcp());
