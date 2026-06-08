#!/usr/bin/env node
// Large multi-file GPU HMR validation:
//   ordinary user project -> MCP compile -> AI GPU split -> visible first frame
//   -> user device-source AI delta -> GPU sidecar HMR -> visible changed frame.
//
// Target-resolution modes:
//   SYNTHI_SCALE_CMAKE_TARGET_MODE=single    one executable owns the run file
//   SYNTHI_SCALE_CMAKE_TARGET_MODE=multi     extra executable exists; run file still maps to one target
//   SYNTHI_SCALE_CMAKE_TARGET_MODE=ambiguous two executables own the run file; split must be rejected

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

function normalizeHmrDeltaMode(value) {
  const normalized = String(value ?? 'ai_user_delta').toLowerCase().replace(/[-\s]+/g, '_');
  const aliases = {
    forced: 'ai_user_delta',
    forced_ai_delta: 'ai_user_delta',
    ai_delta: 'ai_user_delta',
    direct: 'natural_user_delta',
    direct_device: 'natural_user_delta',
    no_force: 'natural_user_delta',
    no_forced_delta: 'natural_user_delta',
    natural: 'natural_user_delta',
  };
  return aliases[normalized] ?? normalized;
}

function parseNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  slug: process.env.SLUG ?? `gpu-scale-validation-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-scale-validation',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  renderBackend: (process.env.SYNTHI_SCALE_RENDER_BACKEND ?? 'sdl2')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/^sdl$/, 'sdl2')
    .replace(/^imgui-sdl$/, 'imgui-sdl2')
    .replace(/^imgui-glfw-opengl$/, 'imgui-glfw'),
  cmakeTargetMode: (process.env.SYNTHI_SCALE_CMAKE_TARGET_MODE ?? 'single')
    .toLowerCase()
    .replace(/_/g, '-'),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
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
  hmrDeltaMode: normalizeHmrDeltaMode(process.env.SYNTHI_SCALE_HMR_DELTA_MODE ?? 'ai_user_delta'),
  validationProfile: (process.env.SYNTHI_SCALE_VALIDATION_PROFILE ?? 'full').toLowerCase().replace(/[-\s]+/g, '_'),
  aiDeltaEvidenceTimeoutMs: Number(process.env.SYNTHI_SCALE_AI_DELTA_EVIDENCE_TIMEOUT_MS ?? 45000),
  templateEvidenceMode: (process.env.SYNTHI_SCALE_TEMPLATE_EVIDENCE ?? 'missing').toLowerCase(),
  screenshotAttempts: Number(process.env.SYNTHI_SCALE_SCREENSHOT_ATTEMPTS ?? 6),
  screenshotRetryDelayMs: Number(process.env.SYNTHI_SCALE_SCREENSHOT_RETRY_MS ?? 1000),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_SCALE_SCREENSHOT_FRESHNESS_MS ?? 5000),
  targetWorkspaceFileCount: parseNonNegativeIntegerEnv('SYNTHI_SCALE_TARGET_FILE_COUNT', 0),
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  mcpVisionBackend: process.env.SYNTHI_MCP_VISION_BACKEND
    ?? ((process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY) ? 'gemini_api' : 'agent_side'),
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const RESULTS_JSON = path.join(LOG_DIR, 'scale-validation-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'scale-validation-results.txt');
const BACKEND_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-results.json`);
const BACKEND_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-results.txt`);
const MODE_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-results.json`);
const MODE_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-results.txt`);
const TARGET_MODE_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.cmakeTargetMode}-results.json`);
const TARGET_MODE_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.cmakeTargetMode}-results.txt`);
const HMR_MODE_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.hmrDeltaMode}-results.json`);
const HMR_MODE_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.hmrDeltaMode}-results.txt`);
const NATURAL_PROFILE_RESULTS_JSON = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.cmakeTargetMode}-${CFG.validationProfile}-${CFG.hmrDeltaMode}-results.json`);
const NATURAL_PROFILE_RESULTS_TXT = path.join(LOG_DIR, `scale-validation-${CFG.renderBackend}-${CFG.templateEvidenceMode}-${CFG.cmakeTargetMode}-${CFG.validationProfile}-${CFG.hmrDeltaMode}-results.txt`);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

const FORBIDDEN_ABI = [
  'core_on_load',
  'core_on_update',
  'gui_on_load',
  'gui_on_render',
  'device_on_load',
  'device_descriptor',
  'device_kernel_sig_hash',
];
const FORBIDDEN_ROLE_BASENAMES = new Set([
  'core.cpp',
  'gui.cpp',
  'host_runner.cpp',
  'shared.h',
  'device.cu',
  'device.hip',
]);
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
const SUPPORTED_RENDER_FIXTURES = new Set([
  'sdl2',
  'glfw',
  'raylib',
  'sfml',
  'imgui-sdl2',
  'imgui-glfw',
  'vulkan',
]);
const SUPPORTED_CMAKE_TARGET_MODES = new Set(['single', 'multi', 'ambiguous']);
const SUPPORTED_HMR_DELTA_MODES = new Set(['ai_user_delta', 'natural_user_delta']);
const SUPPORTED_VALIDATION_PROFILES = new Set(['full', 'natural']);

function renderBackendProfile(renderBackend) {
  const profiles = {
    sdl2: {
      label: 'SDL2',
      source: 'src/render/sdl_canvas.cpp',
      header: 'src/render/sdl_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE SDL2)',
      cmakePrelude: '',
      dependencyPackages: ['libsdl2-dev'],
      dependencyProbe: "printf '%s\\n' '#include <SDL2/SDL.h>' 'int main(){ return SDL_Init(0); }' | c++ -x c++ - -lSDL2 -o /tmp/synthi-sdl2-probe && rm -f /tmp/synthi-sdl2-probe",
      marker: /\bSDL_|SDL2\/SDL\.h|-lSDL2/,
      forbidden: /\bGLFW|raylib\.h|SFML\/Graphics\.hpp|vulkan\/vulkan\.h|Vk[A-Z]|ImGui::/,
    },
    glfw: {
      label: 'GLFW + OpenGL',
      source: 'src/render/glfw_canvas.cpp',
      header: 'src/render/glfw_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE glfw GL)',
      cmakePrelude: '',
      dependencyPackages: ['libglfw3-dev', 'libgl1-mesa-dev'],
      dependencyProbe: "printf '%s\\n' '#include <GLFW/glfw3.h>' '#include <GL/gl.h>' 'int main(){ return glfwInit() ? 0 : 1; }' | c++ -x c++ - -lglfw -lGL -o /tmp/synthi-glfw-probe && rm -f /tmp/synthi-glfw-probe",
      marker: /\b(?:GLFW|glfw|-lglfw|GL\/gl\.h|glClear|glBegin|glDraw)/,
      forbidden: /\bSDL_|SDL2\/SDL\.h|raylib\.h|SFML\/Graphics\.hpp|vulkan\/vulkan\.h|Vk[A-Z]|ImGui::/,
    },
    raylib: {
      label: 'raylib',
      source: 'src/render/raylib_canvas.cpp',
      header: 'src/render/raylib_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE raylib)',
      cmakePrelude: '',
      dependencyPackages: ['raylib development package or source-installed libraylib'],
      dependencyProbe: "printf '%s\\n' '#include <raylib.h>' 'int main(){ return 0; }' | c++ -x c++ - -lraylib -o /tmp/synthi-raylib-probe && rm -f /tmp/synthi-raylib-probe",
      marker: /\b(?:raylib\.h|InitWindow|BeginDrawing|DrawCircle|-lraylib)\b/,
      forbidden: /\bSDL_|SDL2\/SDL\.h|GLFW|SFML\/Graphics\.hpp|vulkan\/vulkan\.h|Vk[A-Z]|ImGui::/,
    },
    sfml: {
      label: 'SFML',
      source: 'src/render/sfml_canvas.cpp',
      header: 'src/render/sfml_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE sfml-graphics sfml-window sfml-system)',
      cmakePrelude: '',
      dependencyPackages: ['libsfml-dev'],
      dependencyProbe: "printf '%s\\n' '#include <SFML/Graphics.hpp>' 'int main(){ sf::CircleShape shape; return 0; }' | c++ -x c++ - -lsfml-graphics -lsfml-window -lsfml-system -o /tmp/synthi-sfml-probe && rm -f /tmp/synthi-sfml-probe",
      marker: /\b(?:SFML\/Graphics\.hpp|sf::RenderWindow|sfml-graphics)\b/,
      forbidden: /\bSDL_|SDL2\/SDL\.h|GLFW|raylib\.h|vulkan\/vulkan\.h|Vk[A-Z]|ImGui::/,
    },
    'imgui-sdl2': {
      label: 'ImGui + SDL2',
      source: 'src/render/imgui_sdl_canvas.cpp',
      header: 'src/render/imgui_sdl_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE SDL2 imgui)',
      cmakePrelude: '',
      dependencyPackages: ['libsdl2-dev', 'libimgui-dev'],
      dependencyProbe: "printf '%s\\n' '#include <SDL2/SDL.h>' '#include <imgui.h>' 'int main(){ ImGui::CreateContext(); ImGui::DestroyContext(); return 0; }' | c++ -x c++ - -lSDL2 -limgui -o /tmp/synthi-imgui-sdl2-probe && rm -f /tmp/synthi-imgui-sdl2-probe",
      marker: /\b(?:ImGui::|imgui\.h|SDL2\/SDL\.h|-lSDL2|imgui)\b/,
      forbidden: /\bGLFW|raylib\.h|SFML\/Graphics\.hpp|vulkan\/vulkan\.h|Vk[A-Z]/,
    },
    'imgui-glfw': {
      label: 'ImGui + GLFW',
      source: 'src/render/imgui_glfw_canvas.cpp',
      header: 'src/render/imgui_glfw_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE glfw GL imgui)',
      cmakePrelude: '',
      dependencyPackages: ['libglfw3-dev', 'libgl1-mesa-dev', 'libimgui-dev'],
      dependencyProbe: "printf '%s\\n' '#include <GLFW/glfw3.h>' '#include <GL/gl.h>' '#include <imgui.h>' 'int main(){ ImGui::CreateContext(); ImGui::DestroyContext(); return 0; }' | c++ -x c++ - -lglfw -lGL -limgui -o /tmp/synthi-imgui-glfw-probe && rm -f /tmp/synthi-imgui-glfw-probe",
      marker: /\b(?:ImGui::|imgui\.h|GLFW|glfw|-lglfw|imgui)\b/,
      forbidden: /\bSDL_|SDL2\/SDL\.h|raylib\.h|SFML\/Graphics\.hpp|vulkan\/vulkan\.h|Vk[A-Z]/,
    },
    vulkan: {
      label: 'Vulkan unsupported fallback',
      source: 'src/render/vulkan_canvas.cpp',
      header: 'src/render/vulkan_canvas.hpp',
      link: 'target_link_libraries(particle_field PRIVATE Vulkan::Vulkan)',
      cmakePrelude: 'find_package(Vulkan REQUIRED)',
      dependencyPackages: ['libvulkan-dev'],
      dependencyProbe: "printf '%s\\n' '#include <vulkan/vulkan.h>' 'int main(){ VkInstance instance = VK_NULL_HANDLE; return instance == VK_NULL_HANDLE ? 0 : 1; }' | c++ -x c++ - -lvulkan -o /tmp/synthi-vulkan-probe && rm -f /tmp/synthi-vulkan-probe",
      marker: /\b(?:vulkan\/vulkan\.h|Vk[A-Z]|vk[A-Z]|VK_|Vulkan::Vulkan)\b/,
      forbidden: /\bSDL_|SDL2\/SDL\.h|GLFW|raylib\.h|SFML\/Graphics\.hpp|ImGui::/,
      unsupportedReason: 'unsupported.graphics_backend_vulkan',
    },
  };
  const profile = profiles[renderBackend];
  if (!profile) {
    throw new Error(`unsupported render backend fixture ${renderBackend}`);
  }
  return profile;
}

const report = {
  slug: CFG.slug,
  repo_commit: '',
  model: CFG.geminiModel,
  vendor: '',
  arch: '',
  render_backend: CFG.renderBackend,
  cmake_target_mode: CFG.cmakeTargetMode,
  hmr_delta_mode: CFG.hmrDeltaMode,
  validation_profile: CFG.validationProfile,
  source_file_mix: {},
  template_evidence_mode: CFG.templateEvidenceMode,
  workspace_file_count: 0,
  relevant_file_count: 0,
  framework_dependency: {},
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
  warm_rebuild: {},
  runtime_policy: {},
  direct_device_fast_path: {},
  ai_delta_observations: [],
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
  if (!detected) {
    throw new Error(`could not auto-detect ${vendor} GPU arch; set SYNTHI_GPU_ARCH explicitly`);
  }
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
      '-e', `SYNTHI_VISION_BACKEND=${CFG.mcpVisionBackend}`,
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
        SYNTHI_VISION_BACKEND: CFG.mcpVisionBackend,
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

function addInertScaleFiles(files, targetCount) {
  if (!targetCount || files.length >= targetCount) return;
  const categories = [
    {
      dir: 'docs/scale',
      ext: 'md',
      content: (i) => `
# Scale Context Note ${i}

This ordinary project note is intentionally unrelated to the selected GPU target.
`,
    },
    {
      dir: 'tests/fixtures',
      ext: 'json',
      content: (i) => JSON.stringify({
        fixture: `scale-context-${i}`,
        target: 'unrelated',
        values: [i, i + 1, i + 2],
      }, null, 2) + '\n',
    },
    {
      dir: 'examples/archive',
      ext: 'cpp',
      content: (i) => `
namespace archived_example_${i} {
float archived_value_${i}(float input) {
  return input * ${Number(1 + (i % 97) * 0.0001).toFixed(4)}f;
}
}
`,
    },
    {
      dir: 'include/catalog',
      ext: 'hpp',
      content: (i) => `
#pragma once
namespace scale_catalog_${i} {
constexpr int kCatalogValue = ${i};
}
`,
    },
  ];

  let i = 0;
  while (files.length < targetCount) {
    const category = categories[i % categories.length];
    const local = String(Math.floor(i / categories.length)).padStart(5, '0');
    addFile(files, `${category.dir}/context_${local}.${category.ext}`, category.content(i));
    i += 1;
  }
}

function buildScaleProject(vendor, arch, renderBackend, cmakeTargetMode = 'single') {
  const isRocm = vendor === 'rocm';
  const renderProfile = renderBackendProfile(renderBackend);
  const deviceExt = isRocm ? 'hip' : 'cu';
  const runtimeInclude = isRocm ? '#include <hip/hip_runtime.h>' : '#include <cuda_runtime.h>';
  const launchComment = isRocm ? 'hipLaunchKernelGGL' : 'cudaLaunchKernel';
  const useTemplateFixture = ['missing', 'fresh', 'stale'].includes(CFG.templateEvidenceMode);
  const emitTemplateEvidence = ['fresh', 'stale'].includes(CFG.templateEvidenceMode);
  const templateInclude = useTemplateFixture ? '#include "particle_template_math.hpp"' : '';
  const attractionGain = useTemplateFixture
    ? '::scale_template::tuned_gain<float, 128>(0.42f)'
    : '0.42f';
  const integrationScale = useTemplateFixture
    ? '::scale_template::tuned_gain<float, 256>(44.0f)'
    : '44.0f';
  const renderSource = renderProfile.source;
  const renderLink = renderProfile.link;
  const appTargetSources = [
    'src/app/main.cpp',
    'src/app/simulation.cpp',
    renderSource,
    `src/gpu/particle_kernels.${deviceExt}`,
  ];
  const cmakeExtraTargets = [];
  const codemodelTargets = [
    {
      name: 'particle_field',
      id: 'particle_field::@scale',
      jsonFile: 'target-particle_field-Debug.json',
    },
  ];
  const targetReplies = [
    {
      path: '.cmake/api/v1/reply/target-particle_field-Debug.json',
      value: {
        name: 'particle_field',
        id: 'particle_field::@scale',
        type: 'EXECUTABLE',
        sources: appTargetSources.map((sourcePath) => ({ path: sourcePath })),
      },
    },
  ];
  if (cmakeTargetMode === 'multi') {
    cmakeExtraTargets.push('add_executable(field_inspector tools/field_inspector.cpp)');
    codemodelTargets.push({
      name: 'field_inspector',
      id: 'field_inspector::@scale',
      jsonFile: 'target-field_inspector-Debug.json',
    });
    targetReplies.push({
      path: '.cmake/api/v1/reply/target-field_inspector-Debug.json',
      value: {
        name: 'field_inspector',
        id: 'field_inspector::@scale',
        type: 'EXECUTABLE',
        sources: [{ path: 'tools/field_inspector.cpp' }],
      },
    });
  } else if (cmakeTargetMode === 'ambiguous') {
    cmakeExtraTargets.push(`
add_executable(particle_field_shadow
  ${appTargetSources.join('\n  ')}
)
${renderLink.replace('particle_field', 'particle_field_shadow')}
`);
    codemodelTargets.push({
      name: 'particle_field_shadow',
      id: 'particle_field_shadow::@scale',
      jsonFile: 'target-particle_field_shadow-Debug.json',
    });
    targetReplies.push({
      path: '.cmake/api/v1/reply/target-particle_field_shadow-Debug.json',
      value: {
        name: 'particle_field_shadow',
        id: 'particle_field_shadow::@scale',
        type: 'EXECUTABLE',
        sources: appTargetSources.map((sourcePath) => ({ path: sourcePath })),
      },
    });
  }
  const files = [];
  const mainCompileArguments = [
    'clang++',
    '-std=c++20',
    '-Isrc',
    `-DSCALE_GPU_TARGET=${isRocm ? 'rocm' : 'cuda'}`,
    `-DSCALE_GPU_ARCH=${arch}`,
    '-c',
    'src/app/main.cpp',
  ];
  const deviceCompileArguments = [
    isRocm ? 'hipcc' : 'nvcc',
    '-Isrc',
    isRocm ? `--offload-arch=${arch}` : `-arch=${arch}`,
    '-c',
    `src/gpu/particle_kernels.${deviceExt}`,
  ];

  addFile(files, 'README.md', `
# Particle Field Validation Fixture

Ordinary multi-file GPU project used by the scale validation harness.
Render backend: ${renderProfile.label}.
`, true);

  addFile(files, 'CMakeLists.txt', `
cmake_minimum_required(VERSION 3.24)
project(particle_field_validation LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
${renderProfile.cmakePrelude}
add_executable(particle_field
  ${appTargetSources.join('\n  ')}
)
${renderLink}
${cmakeExtraTargets.join('\n')}
`, true);

  const compileCommands = [
    {
      directory: '/workspace/particle_field_validation/build',
      file: '/workspace/particle_field_validation/src/app/main.cpp',
      arguments: mainCompileArguments,
    },
    {
      directory: '/workspace/particle_field_validation/build',
      file: `/workspace/particle_field_validation/src/gpu/particle_kernels.${deviceExt}`,
      arguments: deviceCompileArguments,
    },
  ];
  if (cmakeTargetMode === 'multi') {
    compileCommands.push({
      directory: '/workspace/particle_field_validation/build',
      file: '/workspace/particle_field_validation/tools/field_inspector.cpp',
      arguments: [
        'clang++',
        '-std=c++20',
        '-Isrc',
        '-DTOOL_TARGET=1',
        '-c',
        'tools/field_inspector.cpp',
      ],
    });
  } else if (cmakeTargetMode === 'ambiguous') {
    compileCommands.push({
      directory: '/workspace/particle_field_validation/build-shadow',
      file: '/workspace/particle_field_validation/src/app/main.cpp',
      arguments: [
        'clang++',
        '-std=c++20',
        '-Isrc',
        '-DPARTICLE_FIELD_SHADOW_TARGET=1',
        `-DSCALE_GPU_TARGET=${isRocm ? 'rocm' : 'cuda'}`,
        `-DSCALE_GPU_ARCH=${arch}`,
        '-c',
        'src/app/main.cpp',
      ],
    });
  }
  addFile(files, 'compile_commands.json', JSON.stringify(compileCommands, null, 2) + '\n', true);

  addFile(files, '.cmake/api/v1/reply/codemodel-v2-debug.json', JSON.stringify({
    kind: 'codemodel',
    configurations: [
      {
        name: 'Debug',
        targets: codemodelTargets,
      },
    ],
  }, null, 2) + '\n', true);

  for (const reply of targetReplies) {
    addFile(files, reply.path, JSON.stringify(reply.value, null, 2) + '\n', true);
  }

  if (emitTemplateEvidence) {
    const templateEvidenceEntries = [
      {
        templateName: 'scale_template::tuned_gain<T, BLOCK_SIZE>',
        templateArgs: ['float', '128'],
        owningTU: `src/gpu/particle_kernels.${deviceExt}`,
        instantiationSite: 'src/gpu/particle_template_math.hpp:7',
        reachableFromKernel: 'advance_particle_field(float*, float*, float*, float*, unsigned int*, int, scale::LaunchParams)',
        changedInputs: ['BLOCK_SIZE'],
        sourceHeaders: ['src/gpu/particle_template_math.hpp'],
        generatedRole: 'device.particle_kernels',
        abiFingerprint: stableHash(['tuned_gain', 'float', '128', arch]),
        layoutFingerprint: stableHash(['layout', 'tuned_gain', 'float', '128', arch]),
        artifactFingerprint: stableHash(['artifact', 'tuned_gain', 'float', '128', arch]),
      },
      {
        templateName: 'scale_template::tuned_gain<T, BLOCK_SIZE>',
        templateArgs: ['float', '256'],
        owningTU: `src/gpu/particle_kernels.${deviceExt}`,
        instantiationSite: 'src/gpu/particle_template_math.hpp:7',
        reachableFromKernel: 'advance_particle_field(float*, float*, float*, float*, unsigned int*, int, scale::LaunchParams)',
        changedInputs: ['BLOCK_SIZE'],
        sourceHeaders: ['src/gpu/particle_template_math.hpp'],
        generatedRole: 'device.particle_kernels',
        abiFingerprint: stableHash(['tuned_gain', 'float', '256', arch]),
        layoutFingerprint: stableHash(['layout', 'tuned_gain', 'float', '256', arch]),
        artifactFingerprint: stableHash(['artifact', 'tuned_gain', 'float', '256', arch]),
      },
    ];
    addFile(files, '.cmake/api/v1/reply/synthi-template-evidence.json', JSON.stringify({
      templateEvidence: {
        schemaVersion: 'synthi.gpu.template_evidence.v1',
        status: CFG.templateEvidenceMode,
        producer: 'clang-libtooling+vendor-artifacts',
        compileCommandHash: stableHash(deviceCompileArguments),
        effectiveFlagsHash: stableHash(deviceCompileArguments.slice(1)),
        gpuArch: arch,
        bounded: true,
        entries: templateEvidenceEntries,
      },
    }, null, 2) + '\n', true);
  }

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

  if (useTemplateFixture) {
    addFile(files, 'src/gpu/particle_template_math.hpp', `
#pragma once

namespace scale_template {
template <typename T, int BLOCK_SIZE>
__device__ T tuned_gain(T value) {
  constexpr T adjustment = static_cast<T>((BLOCK_SIZE % 257) + 1) * static_cast<T>(0.00001f);
  return value + adjustment;
}
}
`, true);
  }

  addFile(files, `src/gpu/particle_kernels.${deviceExt}`, `
${runtimeInclude}
#include "particle_api.hpp"
${templateInclude}

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
  vx[i] += kHmrScaleDirection * ((dx / len) * ${attractionGain} - dy * swirl) * params.dt;
  vy[i] += kHmrScaleDirection * ((dy / len) * ${attractionGain} + dx * swirl) * params.dt;

  px += vx[i] * params.dt * ${integrationScale};
  py += vy[i] * params.dt * ${integrationScale};

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
  } else if (renderBackend === 'glfw') {
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
  } else if (renderBackend === 'raylib') {
    addFile(files, 'src/render/raylib_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
namespace scale {
class RaylibCanvas {
 public:
  RaylibCanvas(int width, int height);
  ~RaylibCanvas();
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  int width_;
  int height_;
};
}
`, true);

    addFile(files, 'src/render/raylib_canvas.cpp', `
#include "raylib_canvas.hpp"
#include <raylib.h>
#include <cstddef>
namespace scale {
RaylibCanvas::RaylibCanvas(int width, int height) : width_(width), height_(height) {
  InitWindow(width_, height_, "Scale Particle Field");
  SetTargetFPS(60);
}
RaylibCanvas::~RaylibCanvas() { CloseWindow(); }
bool RaylibCanvas::pump() { return !WindowShouldClose(); }
void RaylibCanvas::draw(const ParticleSnapshot& snapshot) {
  BeginDrawing();
  ClearBackground(Color{6, 10, 18, 255});
  for (std::size_t i = 0; i < snapshot.positions.size(); ++i) {
    const Vec2& p = snapshot.positions[i];
    const Rgba& c = snapshot.colors[i % snapshot.colors.size()];
    DrawCircle(static_cast<int>(p.x), static_cast<int>(p.y), 4.0f, Color{c.r, c.g, c.b, c.a});
  }
  EndDrawing();
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/raylib_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::RaylibCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else if (renderBackend === 'sfml') {
    addFile(files, 'src/render/sfml_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
#include <SFML/Graphics.hpp>
namespace scale {
class SfmlCanvas {
 public:
  SfmlCanvas(int width, int height);
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  sf::RenderWindow window_;
};
}
`, true);

    addFile(files, 'src/render/sfml_canvas.cpp', `
#include "sfml_canvas.hpp"
#include <cstddef>
namespace scale {
SfmlCanvas::SfmlCanvas(int width, int height)
    : window_(sf::VideoMode(width, height), "Scale Particle Field") {
  window_.setFramerateLimit(60);
}
bool SfmlCanvas::pump() {
  sf::Event event;
  while (window_.pollEvent(event)) {
    if (event.type == sf::Event::Closed) window_.close();
  }
  return window_.isOpen();
}
void SfmlCanvas::draw(const ParticleSnapshot& snapshot) {
  window_.clear(sf::Color(6, 10, 18));
  for (std::size_t i = 0; i < snapshot.positions.size(); ++i) {
    const Vec2& p = snapshot.positions[i];
    const Rgba& c = snapshot.colors[i % snapshot.colors.size()];
    sf::CircleShape particle(4.0f);
    particle.setFillColor(sf::Color(c.r, c.g, c.b, c.a));
    particle.setPosition(p.x, p.y);
    window_.draw(particle);
  }
  window_.display();
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/sfml_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::SfmlCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else if (renderBackend === 'imgui-sdl2') {
    addFile(files, 'src/render/imgui_sdl_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
struct SDL_Window;
struct SDL_Renderer;
namespace scale {
class ImguiSdlCanvas {
 public:
  ImguiSdlCanvas(int width, int height);
  ~ImguiSdlCanvas();
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  SDL_Window* window_;
  SDL_Renderer* renderer_;
  bool open_;
};
}
`, true);

    addFile(files, 'src/render/imgui_sdl_canvas.cpp', `
#include "imgui_sdl_canvas.hpp"
#include <SDL2/SDL.h>
#include <imgui.h>
#include <cstddef>
namespace scale {
ImguiSdlCanvas::ImguiSdlCanvas(int width, int height) : window_(nullptr), renderer_(nullptr), open_(true) {
  SDL_Init(SDL_INIT_VIDEO);
  window_ = SDL_CreateWindow("Scale Particle Field", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, width, height, SDL_WINDOW_SHOWN);
  renderer_ = window_ ? SDL_CreateRenderer(window_, -1, SDL_RENDERER_ACCELERATED) : nullptr;
  ImGui::CreateContext();
}
ImguiSdlCanvas::~ImguiSdlCanvas() {
  ImGui::DestroyContext();
  if (renderer_) SDL_DestroyRenderer(renderer_);
  if (window_) SDL_DestroyWindow(window_);
  SDL_Quit();
}
bool ImguiSdlCanvas::pump() {
  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    if (event.type == SDL_QUIT) open_ = false;
  }
  return open_;
}
void ImguiSdlCanvas::draw(const ParticleSnapshot& snapshot) {
  ImGui::NewFrame();
  ImGui::Begin("GPU HMR");
  ImGui::Text("particles: %d", static_cast<int>(snapshot.positions.size()));
  ImGui::End();
  ImGui::Render();
  if (renderer_) SDL_RenderPresent(renderer_);
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/imgui_sdl_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::ImguiSdlCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else if (renderBackend === 'imgui-glfw') {
    addFile(files, 'src/render/imgui_glfw_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
struct GLFWwindow;
namespace scale {
class ImguiGlfwCanvas {
 public:
  ImguiGlfwCanvas(int width, int height);
  ~ImguiGlfwCanvas();
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  GLFWwindow* window_;
};
}
`, true);

    addFile(files, 'src/render/imgui_glfw_canvas.cpp', `
#include "imgui_glfw_canvas.hpp"
#include <GLFW/glfw3.h>
#include <imgui.h>
namespace scale {
ImguiGlfwCanvas::ImguiGlfwCanvas(int width, int height) : window_(nullptr) {
  glfwInit();
  window_ = glfwCreateWindow(width, height, "Scale Particle Field", nullptr, nullptr);
  if (window_) glfwMakeContextCurrent(window_);
  ImGui::CreateContext();
}
ImguiGlfwCanvas::~ImguiGlfwCanvas() {
  ImGui::DestroyContext();
  if (window_) glfwDestroyWindow(window_);
  glfwTerminate();
}
bool ImguiGlfwCanvas::pump() {
  if (!window_) return false;
  glfwPollEvents();
  return !glfwWindowShouldClose(window_);
}
void ImguiGlfwCanvas::draw(const ParticleSnapshot& snapshot) {
  ImGui::NewFrame();
  ImGui::Begin("GPU HMR");
  ImGui::Text("particles: %d", static_cast<int>(snapshot.positions.size()));
  ImGui::End();
  ImGui::Render();
  if (window_) glfwSwapBuffers(window_);
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/imgui_glfw_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::ImguiGlfwCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else if (renderBackend === 'vulkan') {
    addFile(files, 'src/render/vulkan_canvas.hpp', `
#pragma once
#include "../app/simulation.hpp"
#include <vulkan/vulkan.h>
namespace scale {
class VulkanCanvas {
 public:
  VulkanCanvas(int width, int height);
  bool pump();
  void draw(const ParticleSnapshot& snapshot);
 private:
  VkInstance instance_;
};
}
`, true);

    addFile(files, 'src/render/vulkan_canvas.cpp', `
#include "vulkan_canvas.hpp"
namespace scale {
VulkanCanvas::VulkanCanvas(int, int) : instance_(VK_NULL_HANDLE) {}
bool VulkanCanvas::pump() { return true; }
void VulkanCanvas::draw(const ParticleSnapshot& snapshot) {
  (void)snapshot;
  (void)instance_;
}
}
`, true);

    addFile(files, 'src/app/main.cpp', `
#include "simulation.hpp"
#include "../render/vulkan_canvas.hpp"
#include "../config/particle_config.hpp"

int main() {
  scale::Simulation simulation;
  scale::VulkanCanvas canvas(scale::kCanvasWidth, scale::kCanvasHeight);
  for (int frame = 0; frame < 240 && canvas.pump(); ++frame) {
    simulation.step(1.0f / 60.0f);
    canvas.draw(simulation.snapshot());
  }
  return 0;
}
`, true);
  } else {
    throw new Error(`missing fixture generator for render backend ${renderBackend}`);
  }

  if (cmakeTargetMode === 'multi') {
    addFile(files, 'tools/field_inspector.cpp', `
#include <iostream>

int main() {
  std::cout << "field inspector target\\n";
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

  addInertScaleFiles(files, CFG.targetWorkspaceFileCount);

  return {
    files,
    relevantFiles: files.filter((f) => f.relevant),
    primaryPath: 'src/app/main.cpp',
    devicePath: `src/gpu/particle_kernels.${deviceExt}`,
    templateHeaderPath: useTemplateFixture ? 'src/gpu/particle_template_math.hpp' : null,
  };
}

function assertOrdinaryUserProject(files) {
  const abiHits = [];
  const roleNameHits = [];
  for (const file of files) {
    for (const needle of FORBIDDEN_ABI) {
      if (file.content.includes(needle)) abiHits.push(`${file.path}:${needle}`);
    }
    const basename = file.path.toLowerCase().split('/').pop() ?? '';
    if (FORBIDDEN_ROLE_BASENAMES.has(basename)) roleNameHits.push(file.path);
  }
  if (abiHits.length) fail(`starting project contains Synthi ABI exports: ${abiHits.slice(0, 8).join(', ')}`);
  if (roleNameHits.length) fail(`starting project filenames contain generated role names: ${roleNameHits.slice(0, 8).join(', ')}`);
  record('ordinary user project guard', 'pass', `${files.length} files, no Synthi ABI or generated role filenames`);
}

async function assertRenderBackendDependencies(renderProfile) {
  const packages = renderProfile.dependencyPackages || [];
  report.framework_dependency = {
    backend: CFG.renderBackend,
    label: renderProfile.label,
    packages,
    status: 'not_checked',
  };

  if (renderProfile.unsupportedReason) {
    report.framework_dependency.status = 'not_required_for_explicit_fallback';
    record(
      'render backend dependency preflight',
      'pass',
      `${renderProfile.label}: not required for explicit unsupported fallback`,
    );
    return;
  }
  if (CFG.mcpTransport !== 'docker') {
    report.framework_dependency.status = 'skipped_host_transport';
    record(
      'render backend dependency preflight',
      'warn',
      `${renderProfile.label}: skipped outside docker transport`,
    );
    return;
  }
  if (!renderProfile.dependencyProbe) {
    report.framework_dependency.status = 'missing_probe';
    fail(`render backend ${renderProfile.label} has no dependency probe`);
  }

  const output = await execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', renderProfile.dependencyProbe],
    45000,
  );
  if (typeof output === 'undefined') {
    report.framework_dependency.status = 'missing';
    fail(
      `render backend dependencies missing for ${renderProfile.label}; install/provide: ${packages.join(', ')}`,
    );
  }
  report.framework_dependency.status = 'available';
  record(
    'render backend dependency preflight',
    'pass',
    `${renderProfile.label}: ${packages.join(', ') || 'no extra packages'}`,
  );
}

async function compileViaMcp(args, waitTimeoutMs, phaseName, checkpoint, options = {}) {
  const expectedHmrModule = typeof options.expectedHmrModule === 'string'
    && options.expectedHmrModule.trim()
    ? options.expectedHmrModule.trim()
    : null;
  const state = await ensureMcpAttached();
  const wallStart = Date.now();
  const compileDispatchedAt = new Date().toISOString();
  const compile = await state.client.toolCall('synthi_compile', args, waitTimeoutMs);
  if (!compile?.ok) throw new Error(`synthi_compile failed: ${JSON.stringify(compile).slice(0, 500)}`);
  const waitStartedAt = new Date().toISOString();
  const wait = await waitHmrForCurrentWorkspace(state, waitTimeoutMs, phaseName, expectedHmrModule);
  const waitFinishedAt = new Date().toISOString();
  const wallElapsed = Date.now() - wallStart;
  const workerTail = await dockerLogs(CFG.workerContainer, checkpoint);
  const phase = {
    name: phaseName,
    expected_hmr_module: expectedHmrModule,
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

async function compileUnsupportedViaMcp(args, timeoutMs, phaseName, expectedReason) {
  const state = await ensureMcpAttached();
  const wallStart = Date.now();
  let compile = null;
  let wait = null;
  let detail = null;
  let matched = false;
  try {
    compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
    detail = compile;
    matched = JSON.stringify(compile).includes(expectedReason)
      || JSON.stringify(compile).includes('unsupported_project_shape');
    if (compile?.ok && !matched) {
      wait = await waitHmrForCurrentWorkspace(state, timeoutMs, phaseName);
      detail = { compile, wait };
      matched = JSON.stringify(wait).includes(expectedReason)
        || JSON.stringify(wait).includes('unsupported_project_shape');
    }
  } catch (err) {
    detail = { error: String(err?.message || err) };
    matched = detail.error.includes(expectedReason) || detail.error.includes('unsupported_project_shape');
    if (!matched) throw err;
  }
  if (!matched) {
    throw new Error(
      `${phaseName} did not produce expected unsupported reason ${expectedReason}: `
        + JSON.stringify(detail).slice(0, 1000),
    );
  }
  const phase = {
    name: phaseName,
    wait_hmr_status: 'expected_unsupported',
    wait_hmr_source: 'deterministic_validation',
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_detail: detail,
    frame_gate: { status: 'not_applicable', reason: expectedReason },
    wall_elapsed_ms: Date.now() - wallStart,
    worker_log_markers: [],
  };
  report.phases.push(phase);
  record(`${phaseName} explicit fallback`, 'pass', expectedReason);
  return phase;
}

async function waitHmrForCurrentWorkspace(state, timeoutMs, phaseName, expectedModule = null) {
  const startedAt = Date.now();
  const eventLogSinceTs = startedAt - 2000;
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const sliceTimeoutMs = Math.min(remaining, 30000);
    let wait;
    try {
      wait = await state.client.toolCall(
        'synthi_wait_hmr',
        {
          timeoutMs: sliceTimeoutMs,
          ...(expectedModule ? { module: expectedModule } : {}),
        },
        sliceTimeoutMs + 7000,
      );
    } catch (err) {
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, expectedModule);
      if (recovered) return recovered;
      throw err;
    }
    last = wait;
    const previewId = wait?.detail?.preview_id;
    if (previewId && previewId !== CFG.slug) {
      record(`${phaseName} ignored stale wait_hmr`, 'warn', `preview_id=${previewId} status=${wait?.status ?? 'unknown'}`);
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, expectedModule);
      if (recovered) return recovered;
      continue;
    }
    if (wait?.status === 'timeout') {
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, expectedModule);
      if (recovered) return recovered;
      continue;
    }
    if (
      expectedModule
      && wait?.status === 'discarded'
      && wait?.detail?.reason === 'superseded_by_newer_candidate'
    ) {
      record(
        `${phaseName} ignored superseded candidate wait_hmr`,
        'warn',
        `expected_module=${expectedModule}`,
      );
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, expectedModule);
      if (recovered) return recovered;
      continue;
    }
    return wait;
  }
  const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, expectedModule);
  if (recovered) return recovered;
  return last ?? { status: 'timeout', elapsedMs: timeoutMs, source: 'validation_harness' };
}

function hmrPreviewId(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (typeof detail.preview_id === 'string') return detail.preview_id;
  if (detail.data && typeof detail.data === 'object' && typeof detail.data.preview_id === 'string') {
    return detail.data.preview_id;
  }
  if (detail.detail && typeof detail.detail === 'object' && typeof detail.detail.preview_id === 'string') {
    return detail.detail.preview_id;
  }
  return null;
}

function hmrStatusFromEvent(entry) {
  const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
  if (entry?.status && entry.status !== 'intermediate') return entry.status;
  if (typeof raw.status === 'string') {
    if (raw.status === 'state-migrated') return 'applied';
    return raw.status;
  }
  if (raw.event === 'Promoted') return 'applied';
  if (raw.event === 'RolledBack') return 'rejected';
  if (raw.event === 'Discarded') return 'discarded';
  return null;
}

function hmrModule(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (typeof detail.module === 'string') return detail.module;
  if (detail.data && typeof detail.data === 'object' && typeof detail.data.module === 'string') {
    return detail.data.module;
  }
  if (detail.detail && typeof detail.detail === 'object' && typeof detail.detail.module === 'string') {
    return detail.detail.module;
  }
  return null;
}

async function currentHmrFromEventLog(state, sinceTs, startedAt, expectedModule = null) {
  const log = await state.client.toolCall(
    'synthi_get_event_log',
    { kind: 'hmr', since_ts: sinceTs, limit: 200 },
    10000,
  ).catch(() => null);
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  for (const entry of entries.slice().reverse()) {
    const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
    const previewId = hmrPreviewId(raw);
    if (previewId !== CFG.slug) continue;
    const status = hmrStatusFromEvent(entry);
    if (!['applied', 'rejected', 'compile-error', 'full-reload-required', 'discarded'].includes(status)) {
      continue;
    }
    const detail = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (
      expectedModule
      && status === 'applied'
      && hmrModule(detail) !== expectedModule
    ) {
      continue;
    }
    return {
      status,
      elapsedMs: Date.now() - startedAt,
      hmrElapsedMs: typeof entry.ts === 'number' ? entry.ts - startedAt : null,
      source: 'event_log',
      detail,
      frame_gate: {
        status: 'event_log_recovered',
        note: 'terminal HMR event was recovered from the MCP session event log after a stale wait_hmr event',
      },
    };
  }
  return null;
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
    /\[gpu-hmr\] device_only (?:fast path accepted|fast path rejected|hard stop)[^\n]*/g,
    /\[gpu-hmr\] warm_rebuild[^\n]*/g,
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
  const profile = renderBackendProfile(renderBackend);
  if (profile.unsupportedReason) {
    throw new Error(`validateGeneratedSplit called for unsupported backend ${renderBackend}; expected explicit fallback`);
  }
  if (!profile.marker.test(generatedText)) {
    throw new Error(`generated ${renderBackend} split does not preserve framework markers or link flags`);
  }
  if (profile.forbidden?.test(generatedText)) {
    throw new Error(`generated ${renderBackend} split introduced markers from another framework`);
  }
  record(`generated split preserved ${profile.label} backend`, 'pass', 'framework markers present');
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

function validateProdRunReportContract(split, project, vendor, arch) {
  const reportDoc = split.sidecar?.runReport;
  if (!reportDoc || typeof reportDoc !== 'object') {
    throw new Error('split sidecar missing production runReport');
  }
  if (reportDoc.schemaVersion !== 'synthi.gpu.run_report.v1') {
    throw new Error(`unexpected run report schema: ${reportDoc.schemaVersion ?? 'missing'}`);
  }
  const capability = reportDoc.toolchainCapabilityProfile || split.sidecar?.toolchainCapabilities;
  if (!capability || capability.status !== 'current') {
    throw new Error(`run report missing current toolchain capability profile: ${JSON.stringify(capability).slice(0, 300)}`);
  }
  if (capability.gpuVendor !== vendor) {
    throw new Error(`run report vendor mismatch: ${capability.gpuVendor ?? 'missing'} !== ${vendor}`);
  }
  if (capability.gpuArch !== arch) {
    throw new Error(`run report arch mismatch: ${capability.gpuArch ?? 'missing'} !== ${arch}`);
  }
  if (!reportDoc.toolchainCapabilityProfileHash) {
    throw new Error('run report missing toolchainCapabilityProfileHash');
  }
  if (!reportDoc.effectiveFlagsHash) {
    throw new Error('run report missing effectiveFlagsHash');
  }
  if (!Array.isArray(reportDoc.rankedReloadOptions) || reportDoc.rankedReloadOptions.length === 0) {
    throw new Error('run report missing ranked reload options');
  }
  if (!reportDoc.arbiterDecision) {
    throw new Error('run report missing arbiterDecision');
  }
  if (!reportDoc.compileDbHash) {
    throw new Error('run report missing compileDbHash');
  }
  if (!reportDoc.cmakeCodemodelHash) {
    throw new Error('run report missing cmakeCodemodelHash');
  }
  const buildMetadata = reportDoc.sourceContextReport?.buildMetadata || {};
  const cmakeFileApi = buildMetadata.cmakeFileApi || {};
  const targetResolution = buildMetadata.targetResolution || {};
  if (buildMetadata.compileCommandsStatus !== 'selected') {
    throw new Error(`compile_commands was not selected: ${buildMetadata.compileCommandsStatus ?? 'missing'}`);
  }
  if (buildMetadata.cmakeFileApiStatus !== 'available') {
    throw new Error(`CMake File API was not available: ${buildMetadata.cmakeFileApiStatus ?? 'missing'}`);
  }
  if (targetResolution.status !== 'selected') {
    throw new Error(`CMake target was not selected: ${JSON.stringify(targetResolution).slice(0, 500)}`);
  }
  if (CFG.cmakeTargetMode === 'multi') {
    if (Number(cmakeFileApi.targetCount || 0) < 2) {
      throw new Error(`multi-target fixture did not expose multiple CMake targets: ${JSON.stringify(cmakeFileApi).slice(0, 500)}`);
    }
    if ((targetResolution.matchingTargets || []).length !== 1) {
      throw new Error(`multi-target fixture should have one matching executable target: ${JSON.stringify(targetResolution).slice(0, 500)}`);
    }
    record(
      'multi-target CMake File API selected the focus executable',
      'pass',
      `targets=${cmakeFileApi.targetCount} method=${targetResolution.method}`,
    );
  }
  if (targetResolution.selectedTarget?.name !== 'particle_field') {
    throw new Error(`unexpected selected CMake target: ${targetResolution.selectedTarget?.name ?? 'missing'}`);
  }
  if (!targetResolution.selectedTarget?.sourceFiles?.includes(project.primaryPath)) {
    throw new Error(`selected CMake target does not include ${project.primaryPath}`);
  }
  const selectedTarget = reportDoc.selectedTarget || {};
  if (selectedTarget.targetName !== 'particle_field') {
    throw new Error(`run report selectedTarget not promoted from CMake File API: ${JSON.stringify(selectedTarget).slice(0, 300)}`);
  }
  const headerGraph = reportDoc.affectedHeaderGraph;
  if (!headerGraph || headerGraph.schemaVersion !== 'synthi.gpu.device_include_graph.v1') {
    throw new Error(`run report missing device include graph: ${JSON.stringify(headerGraph).slice(0, 300)}`);
  }
  if (headerGraph.status !== 'bounded') {
    throw new Error(`device include graph is not bounded: ${JSON.stringify(headerGraph).slice(0, 500)}`);
  }
  if (!headerGraph.reachableHeaders?.includes('src/gpu/particle_api.hpp')) {
    throw new Error(`device include graph missing reachable particle_api.hpp: ${JSON.stringify(headerGraph).slice(0, 500)}`);
  }
  if (CFG.templateEvidenceMode === 'fresh') {
    if (!headerGraph.reachableHeaders?.includes('src/gpu/particle_template_math.hpp')) {
      throw new Error(`device include graph missing reachable template header: ${JSON.stringify(headerGraph).slice(0, 500)}`);
    }
    if (reportDoc.templateEvidenceStatus !== 'fresh') {
      throw new Error(`fresh template evidence was not accepted: ${reportDoc.templateEvidenceStatus ?? 'missing'}`);
    }
    if (reportDoc.templateEvidenceInvalidationReasons?.length) {
      throw new Error(`fresh template evidence has invalidation reasons: ${reportDoc.templateEvidenceInvalidationReasons.join(',')}`);
    }
    const instantiations = reportDoc.affectedTemplateInstantiations || [];
    if (!Array.isArray(instantiations) || instantiations.length < 2) {
      throw new Error(`run report missing bounded template instantiations: ${JSON.stringify(instantiations).slice(0, 500)}`);
    }
    const warmOption = reportDoc.rankedReloadOptions.find((option) => option.plan === 'warm_rebuild');
    if (!warmOption || warmOption.safety !== 'pass') {
      throw new Error(`warm_rebuild was not ranked safe with fresh template evidence: ${JSON.stringify(warmOption).slice(0, 500)}`);
    }
    if (warmOption.requiresConsent) {
      throw new Error(`non-RDC fresh template evidence should not require consent: ${JSON.stringify(warmOption).slice(0, 500)}`);
    }
    record(
      'fresh template evidence enables bounded warm rebuild option',
      'pass',
      `instantiations=${instantiations.length} warm=${warmOption.safety}`,
    );
  } else {
    const expectedStatus = CFG.templateEvidenceMode === 'stale' ? 'stale' : 'missing';
    const expectedReason = CFG.templateEvidenceMode === 'stale'
      ? 'template_evidence_stale'
      : 'template_evidence_missing';
    if (!headerGraph.reachableHeaders?.includes('src/gpu/particle_template_math.hpp')) {
      throw new Error(`device include graph missing reachable template header: ${JSON.stringify(headerGraph).slice(0, 500)}`);
    }
    if (reportDoc.templateEvidenceStatus !== expectedStatus) {
      throw new Error(`unexpected templateEvidenceStatus: ${reportDoc.templateEvidenceStatus ?? 'missing'} !== ${expectedStatus}`);
    }
    if (!reportDoc.templateEvidenceInvalidationReasons?.includes(expectedReason)) {
      throw new Error(`run report missing ${expectedReason} invalidation reason`);
    }
    const warmOption = reportDoc.rankedReloadOptions.find((option) => option.plan === 'warm_rebuild');
    if (!warmOption || warmOption.safety !== 'fail') {
      throw new Error(`warm_rebuild was not blocked with ${expectedReason}: ${JSON.stringify(warmOption).slice(0, 500)}`);
    }
    if (!warmOption.reasonCodes?.includes(expectedReason)) {
      throw new Error(`warm_rebuild missing ${expectedReason} reason code: ${JSON.stringify(warmOption).slice(0, 500)}`);
    }
    record(
      `${expectedStatus} template evidence blocks warm rebuild`,
      'pass',
      `reason=${expectedReason} warm=${warmOption.safety}`,
    );
  }
  report.prod_run_report = {
    schemaVersion: reportDoc.schemaVersion,
    arbiterDecision: reportDoc.arbiterDecision,
    selectedPlan: reportDoc.selectedPlan ?? null,
    compileDbHash: reportDoc.compileDbHash,
    cmakeCodemodelHash: reportDoc.cmakeCodemodelHash,
    targetResolutionMethod: reportDoc.targetResolutionMethod ?? targetResolution.method ?? null,
    cmakeTargetCount: cmakeFileApi.targetCount ?? null,
    targetName: selectedTarget.targetName,
    toolchainCapabilityProfileHash: reportDoc.toolchainCapabilityProfileHash,
    templateEvidenceStatus: reportDoc.templateEvidenceStatus,
    affectedTemplateInstantiationCount: Array.isArray(reportDoc.affectedTemplateInstantiations)
      ? reportDoc.affectedTemplateInstantiations.length
      : 0,
    affectedHeaderGraphStatus: headerGraph.status,
  };
  record(
    'production run report records target, capability, cache, and header graph',
    'pass',
    `target=${selectedTarget.targetName} arbiter=${reportDoc.arbiterDecision} headers=${headerGraph.reachableHeaders.length}`,
  );
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

function editTemplateHeaderSource(source) {
  const replacements = [
    [/\b0\.00001f\b/, '0.00300f'],
    [/\b0\.00300f\b/, '0.00450f'],
    [/\b0\.00450f\b/, '0.00600f'],
  ];
  for (const [regex, replacement] of replacements) {
    const edited = source.replace(regex, replacement);
    if (edited !== source) return edited;
  }
  const edited = source.replace(/\b0\.00600f\b/, '0.00750f');
  if (edited === source) throw new Error('template header did not preserve the arithmetic tuning literal');
  return edited;
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

function sidecarWithGpuDeviceTaint(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  const marker = {
    kind: 'tdr_timeout',
    reasonCode: 'gpu_driver_tdr',
    source: 'scale_validation_probe',
  };
  sidecar.gpuDriverFaultMarkers = [marker];
  sidecar.gpuDeviceTainted = true;
  delete sidecar.gpuFaultPolicy;
  delete sidecar.fastPathPolicy;
  delete sidecar.arbiterDecision;
  delete sidecar.selectedPlan;
  delete sidecar.arbiterReasonCodes;
  delete sidecar.rankedReloadOptions;
  delete sidecar.consentRequired;
  delete sidecar.consentReason;
  delete sidecar.runReport;
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function sidecarWithFragmentedVram(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  sidecar.memoryArenaStats = {
    schemaVersion: 'synthi.gpu.memory_arena_stats.v1',
    status: 'reported',
    totalReservedBytes: 1024,
    liveAllocationBytes: 768,
    liveAllocationCount: 6,
    freeSpanCount: 4,
    largestFreeBlockBytes: 64,
    fragmentationRatio: 0.62,
    reloadGeneration: 120,
    pendingAllocationBytes: 128,
    recentAllocationFailureReason: 'largest_free_block_too_small',
    pointerSafetyProvable: false,
  };
  delete sidecar.memoryRefreshPolicy;
  delete sidecar.plannedMemoryRefresh;
  delete sidecar.fastPathPolicy;
  delete sidecar.arbiterDecision;
  delete sidecar.selectedPlan;
  delete sidecar.arbiterReasonCodes;
  delete sidecar.rankedReloadOptions;
  delete sidecar.consentRequired;
  delete sidecar.consentReason;
  delete sidecar.runReport;
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function sidecarWithRdcIncrementalDeviceLinkUnsupported(rawSidecar) {
  const sidecar = JSON.parse(rawSidecar);
  const roleIds = generatedDeviceRoleIds(sidecar);
  sidecar.toolchainCapabilities = {
    ...(sidecar.toolchainCapabilities && typeof sidecar.toolchainCapabilities === 'object'
      ? sidecar.toolchainCapabilities
      : {}),
    schemaVersion: 'synthi.gpu.toolchain_capability.v1',
    status: 'current',
    requiresRdc: true,
    supportsIncrementalDeviceLink: false,
    rdcDeviceLink: {
      schemaVersion: 'synthi.gpu.rdc_device_link.v1',
      required: true,
      supportsIncremental: false,
      estimatedMs: 3000,
      budgetMs: 5000,
      linkerBound: true,
      overBudget: false,
      affectedRoles: roleIds,
      reasonCodes: ['rdc_device_link_required', 'incremental_device_link_unsupported'],
    },
  };
  if (sidecar.compile_manifest?.gpu && typeof sidecar.compile_manifest.gpu === 'object') {
    const gpu = sidecar.compile_manifest.gpu;
    const deviceFlags = Array.isArray(gpu.device_flags) ? gpu.device_flags : [];
    gpu.device_flags = Array.from(new Set([...deviceFlags, '-fgpu-rdc']));
    gpu.device_link = {
      ...(gpu.device_link && typeof gpu.device_link === 'object' ? gpu.device_link : {}),
      requires_rdc: true,
      supports_incremental: false,
      affected_roles: roleIds,
      estimated_ms: 3000,
      budget_ms: 5000,
    };
  }
  delete sidecar.fastPathPolicy;
  delete sidecar.arbiterDecision;
  delete sidecar.selectedPlan;
  delete sidecar.arbiterReasonCodes;
  delete sidecar.rankedReloadOptions;
  delete sidecar.consentRequired;
  delete sidecar.consentReason;
  delete sidecar.runReport;
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function generatedDeviceRoleIds(sidecar) {
  const roles = [];
  const generatedRoles = sidecar.generatedRoles || sidecar.generated_roles || {};
  const roleList = generatedRoles.deviceRoles || generatedRoles.device_roles || [];
  if (Array.isArray(roleList)) {
    for (const role of roleList) {
      const id = role?.id || role?.roleId || role?.name;
      if (typeof id === 'string' && id.trim()) roles.push(id.trim());
    }
  }
  const manifestRoles = sidecar.compile_manifest?.gpu?.device_roles
    || sidecar.compileManifest?.gpu?.deviceRoles
    || [];
  if (Array.isArray(manifestRoles)) {
    for (const role of manifestRoles) {
      const id = role?.id || role?.roleId || role?.name;
      if (typeof id === 'string' && id.trim()) roles.push(id.trim());
    }
  }
  return [...new Set(roles)].sort();
}

function validateGpuTaintPolicySidecar(rawSidecar) {
  const sidecar = typeof rawSidecar === 'string' ? JSON.parse(rawSidecar) : rawSidecar;
  const policy = sidecar.gpuFaultPolicy || sidecar.gpu_fault_policy || {};
  if (policy.tainted !== true) {
    throw new Error(`GPU fault policy did not mark session tainted: ${JSON.stringify(policy).slice(0, 500)}`);
  }
  if (policy.screenshotsAcceptedAsProof !== false) {
    throw new Error(`GPU fault policy still accepts screenshots as proof: ${JSON.stringify(policy).slice(0, 500)}`);
  }
  const reasons = Array.isArray(policy.reasonCodes) ? policy.reasonCodes : [];
  if (!reasons.includes('gpu_device_tainted')) {
    throw new Error(`GPU fault policy missing gpu_device_tainted reason: ${JSON.stringify(policy).slice(0, 500)}`);
  }
  report.runtime_policy.gpu_taint = {
    status: policy.status,
    screenshotsAcceptedAsProof: policy.screenshotsAcceptedAsProof,
    reasonCodes: reasons,
  };
  record('GPU device taint invalidates screenshot proof', 'pass', reasons.join(','));
}

function validateMemoryRefreshPolicySidecar(rawSidecar) {
  const sidecar = typeof rawSidecar === 'string' ? JSON.parse(rawSidecar) : rawSidecar;
  const policy = sidecar.memoryRefreshPolicy || sidecar.memory_refresh_policy || {};
  if (policy.status !== 'refresh_required') {
    throw new Error(`memory refresh policy did not require refresh: ${JSON.stringify(policy).slice(0, 500)}`);
  }
  const planned = policy.plannedMemoryRefresh || {};
  if (planned.needed !== true) {
    throw new Error(`memory refresh policy missing planned refresh: ${JSON.stringify(policy).slice(0, 500)}`);
  }
  const reasons = Array.isArray(policy.reasonCodes) ? policy.reasonCodes : [];
  for (const required of ['vram_fragmented', 'vram_session_refresh_required']) {
    if (!reasons.includes(required)) {
      throw new Error(`memory refresh policy missing ${required}: ${JSON.stringify(policy).slice(0, 500)}`);
    }
  }
  report.runtime_policy.vram_refresh = {
    status: policy.status,
    plannedMemoryRefresh: planned,
    reasonCodes: reasons,
  };
  record('fragmented VRAM requires planned session refresh', 'pass', reasons.join(','));
}

async function compileUserDeviceDelta(project, editedDevice, vendor, checkpoint) {
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.devicePath))
    .map((f) => ({ name: f.path, content: f.content }));
  const args = {
    language: 'cpp',
    filename: project.devicePath,
    source: editedDevice,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  };
  let phaseName = 'natural_device_body_hmr';
  if (CFG.hmrDeltaMode === 'ai_user_delta') {
    args.user_requested_deterministic = true;
    args.force_gpu_ai_delta = true;
    phaseName = 'ai_device_delta_hmr';
  }
  return compileViaMcp(args, CFG.hotSwapTimeoutMs, phaseName, checkpoint, {
    expectedHmrModule: 'device',
  });
}

async function compileTemplateWarmRebuild(project, editedHeader, currentDevice, vendor, checkpoint) {
  if (!project.templateHeaderPath) {
    throw new Error('scale project has no template header path for warm rebuild validation');
  }
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.templateHeaderPath))
    .map((f) => ({
      name: f.path,
      content: cleanRel(f.path) === cleanRel(project.devicePath) ? currentDevice : f.content,
    }));
  const args = {
    language: 'cpp',
    filename: project.templateHeaderPath,
    source: editedHeader,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  };
  if (CFG.validationProfile !== 'natural') {
    args.user_requested_deterministic = true;
    args.force_gpu_ai_delta = false;
  }
  return compileViaMcp(args, CFG.hotSwapTimeoutMs, 'template_warm_rebuild_hmr', checkpoint, {
    expectedHmrModule: 'device',
  });
}

async function dispatchTemplateWarmRebuildNegative(project, editedHeader, currentDevice, vendor, checkpoint) {
  if (!project.templateHeaderPath) {
    throw new Error('scale project has no template header path for warm rebuild validation');
  }
  const additionalFiles = project.files
    .filter((f) => cleanRel(f.path) !== cleanRel(project.templateHeaderPath))
    .map((f) => ({
      name: f.path,
      content: cleanRel(f.path) === cleanRel(project.devicePath) ? currentDevice : f.content,
    }));
  return dispatchCompileViaMcp({
    language: 'cpp',
    filename: project.templateHeaderPath,
    source: editedHeader,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    force_gpu_ai_delta: false,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hotSwapTimeoutMs, 'negative_template_warm_rebuild_rejection', checkpoint);
}

function validateWarmRebuildSidecar(sidecar, project) {
  const plan = sidecar.lastReloadPlanReport || sidecar.runReport?.reloadPlan;
  const verifier = sidecar.lastWarmRebuildVerifierReport;
  if (!plan || plan.plan !== 'warm_rebuild') {
    throw new Error(`warm rebuild sidecar missing warm_rebuild plan: ${JSON.stringify(plan).slice(0, 500)}`);
  }
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes : [];
  for (const required of ['build.warm_rebuild', 'template_evidence_fresh', 'template_instantiation_bounded']) {
    if (!reasonCodes.includes(required)) {
      throw new Error(`warm rebuild plan missing ${required}: ${JSON.stringify(plan).slice(0, 500)}`);
    }
  }
  if (!verifier || verifier.status !== 'accept') {
    throw new Error(`warm rebuild verifier did not accept: ${JSON.stringify(verifier).slice(0, 500)}`);
  }
  if (sidecar.patchTier !== 'warm_rebuild') {
    throw new Error(`warm rebuild sidecar patchTier mismatch: ${sidecar.patchTier ?? 'missing'}`);
  }
  const reportDoc = sidecar.runReport || {};
  const selectedPlan = reportDoc.selectedPlan || sidecar.selectedPlan;
  const arbiterDecision = reportDoc.arbiterDecision || sidecar.arbiterDecision;
  if (selectedPlan !== 'warm_rebuild' || arbiterDecision !== 'auto_run') {
    throw new Error(`warm rebuild run report did not auto-run: ${JSON.stringify({ selectedPlan, arbiterDecision }).slice(0, 300)}`);
  }
  const affected = plan.affectedUserFiles || [];
  if (!affected.includes(project.templateHeaderPath)) {
    throw new Error(`warm rebuild plan missing affected template header: ${JSON.stringify(affected).slice(0, 300)}`);
  }
  report.warm_rebuild = {
    plan: plan.plan,
    patchTier: sidecar.patchTier,
    arbiterDecision,
    selectedPlan,
    reasonCodes,
    verifierStatus: verifier.status,
  };
  record('warm rebuild report accepted bounded template edit', 'pass', reasonCodes.join(','));
}

function validateDirectDeviceFastPathSidecar(rawSidecar, project) {
  const sidecar = typeof rawSidecar === 'string' ? JSON.parse(rawSidecar) : rawSidecar;
  const plan = sidecar.lastReloadPlanReport || sidecar.runReport?.reloadPlan;
  const verifier = sidecar.lastDeviceFastPathVerifierReport;
  if (!plan || plan.plan !== 'device_only') {
    throw new Error(`direct device sidecar missing device_only plan: ${JSON.stringify(plan).slice(0, 500)}`);
  }
  if (!verifier || verifier.status !== 'pass') {
    throw new Error(`direct device verifier did not pass: ${JSON.stringify(verifier).slice(0, 500)}`);
  }
  if (sidecar.patchTier !== 'device_only') {
    throw new Error(`direct device sidecar patchTier mismatch: ${sidecar.patchTier ?? 'missing'}`);
  }
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes : [];
  for (const required of [
    'edit.kernel_body_only',
    'abi.kernel_signature_unchanged',
    'abi.constant_global_layout_unchanged',
    'build.device_sidecar_only',
  ]) {
    if (!reasonCodes.includes(required)) {
      throw new Error(`direct device plan missing ${required}: ${JSON.stringify(plan).slice(0, 500)}`);
    }
  }
  const affected = plan.affectedUserFiles || [];
  if (!affected.includes(project.devicePath)) {
    throw new Error(`direct device plan missing affected device file: ${JSON.stringify(affected).slice(0, 300)}`);
  }
  report.direct_device_fast_path = {
    plan: plan.plan,
    patchTier: sidecar.patchTier,
    verifierStatus: verifier.status,
    reasonCodes,
  };
  record('direct device-only sidecar report accepted body edit', 'pass', reasonCodes.join(','));
}

function validateNaturalAiDeltaFallbackSidecar(rawSidecar, project) {
  const sidecar = typeof rawSidecar === 'string' ? JSON.parse(rawSidecar) : rawSidecar;
  const plan = sidecar.lastReloadPlanReport || sidecar.runReport?.reloadPlan;
  if (!plan || plan.plan !== 'device_only') {
    throw new Error(`natural AI delta fallback missing device_only plan: ${JSON.stringify(plan).slice(0, 500)}`);
  }
  if (sidecar.patchTier !== 'ai_delta') {
    throw new Error(`natural AI delta fallback patchTier mismatch: ${sidecar.patchTier ?? 'missing'}`);
  }
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes : [];
  for (const required of [
    'ai_delta.generated_role_patch',
    'ai_delta.reload_plan.device_only',
    'ai_delta.local_proof_failed',
    'verifier.ai_delta_edits_applied',
  ]) {
    if (!reasonCodes.includes(required)) {
      throw new Error(`natural AI delta fallback plan missing ${required}: ${JSON.stringify(plan).slice(0, 500)}`);
    }
  }
  const affected = plan.affectedUserFiles || [];
  if (!affected.includes(project.devicePath)) {
    throw new Error(`natural AI delta fallback plan missing affected device file: ${JSON.stringify(affected).slice(0, 300)}`);
  }
  report.direct_device_fast_path = {
    plan: plan.plan,
    patchTier: sidecar.patchTier,
    verifierStatus: 'ai_delta_applied',
    reasonCodes,
  };
  record('natural AI delta fallback was verifier-gated', 'pass', reasonCodes.join(','));
}

async function recordAiDeltaObservation(phase, workerCheckpointValue, aiCheckpointValue, expectedCalled) {
  const workerTail = await dockerLogs(CFG.workerContainer, workerCheckpointValue);
  const aiTail = await dockerLogs(CFG.aiEngineContainer, aiCheckpointValue);
  const workerMarkers = [...workerTail.matchAll(/\[GPU AI Delta\][^\n]*/g)]
    .map((match) => match[0].slice(0, 500));
  const backendMarkers = [...aiTail.matchAll(/\[GpuDiffPatch\][^\n]*/g)]
    .map((match) => match[0].slice(0, 500));
  const observation = {
    phase,
    hmrDeltaMode: CFG.hmrDeltaMode,
    validationProfile: CFG.validationProfile,
    workerCalled: workerMarkers.length > 0,
    backendCalled: backendMarkers.length > 0,
    workerMarkers: [...new Set(workerMarkers)],
    backendMarkers: [...new Set(backendMarkers)],
  };
  report.ai_delta_observations.push(observation);

  const workerStatus = observation.workerCalled === expectedCalled ? 'pass' : 'fail';
  const backendStatus = observation.backendCalled === expectedCalled ? 'pass' : 'fail';
  const expectedText = expectedCalled ? 'called' : 'not called';
  record(
    `${phase} GPU AI delta worker ${expectedText}`,
    workerStatus,
    observation.workerMarkers[0] || 'no GPU AI delta worker marker',
  );
  record(
    `${phase} GPU AI delta backend ${expectedText}`,
    backendStatus,
    observation.backendMarkers[0] || 'no GpuDiffPatch marker',
  );
  if (workerStatus === 'fail' || backendStatus === 'fail') {
    throw new Error(
      `${phase} GPU AI delta expectation failed: expected_called=${expectedCalled} `
        + `worker_called=${observation.workerCalled} backend_called=${observation.backendCalled}`,
    );
  }
  return observation;
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

async function dispatchUserDeviceGpuTaintNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, editedDevice, vendor, checkpoint, 'negative_gpu_taint_rejection');
}

async function dispatchUserDeviceFragmentedVramNegative(project, editedDevice, vendor, checkpoint) {
  return dispatchUserDeviceNegative(project, editedDevice, vendor, checkpoint, 'negative_fragmented_vram_rejection');
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
  await writeFile(MODE_RESULTS_JSON, json);
  await writeFile(TARGET_MODE_RESULTS_JSON, json);
  await writeFile(HMR_MODE_RESULTS_JSON, json);
  await writeFile(NATURAL_PROFILE_RESULTS_JSON, json);
  const lines = [
    `slug: ${report.slug}`,
    `repo_commit: ${report.repo_commit}`,
    `model: ${report.model}`,
    `vendor: ${report.vendor}`,
    `arch: ${report.arch}`,
    `render_backend: ${report.render_backend}`,
    `template_evidence_mode: ${report.template_evidence_mode}`,
    `cmake_target_mode: ${report.cmake_target_mode}`,
    `hmr_delta_mode: ${report.hmr_delta_mode}`,
    `validation_profile: ${report.validation_profile}`,
    `source_file_mix: ${JSON.stringify(report.source_file_mix)}`,
    `workspace_file_count: ${report.workspace_file_count}`,
    `relevant_file_count: ${report.relevant_file_count}`,
    `generated_roles: ${JSON.stringify(report.generated_roles)}`,
    `prod_run_report: ${JSON.stringify(report.prod_run_report ?? null)}`,
    '',
    ...report.checks.map((r) => `${r.status.toUpperCase()} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`),
    '',
    ...report.phases.map((p) => {
      const detail = p.wait_hmr_detail ? ` detail=${JSON.stringify(p.wait_hmr_detail).slice(0, 500)}` : '';
      const frameGate = p.frame_gate ? ` frame_gate=${JSON.stringify(p.frame_gate).slice(0, 300)}` : '';
      return `PHASE ${p.name} wait=${p.wait_hmr_status} source=${p.wait_hmr_source ?? ''} wait_ms=${p.wait_hmr_elapsed_ms} terminal_wait_ms=${p.wait_hmr_terminal_elapsed_ms ?? ''} wall_ms=${p.wall_elapsed_ms}${detail}${frameGate}`;
    }),
    '',
    ...report.ai_delta_observations.map((o) => `AI_DELTA ${o.phase} mode=${o.hmrDeltaMode} profile=${o.validationProfile} worker_called=${o.workerCalled} backend_called=${o.backendCalled} worker_marker=${o.workerMarkers?.[0] ?? ''} backend_marker=${o.backendMarkers?.[0] ?? ''}`),
    '',
    ...report.screenshots.map((s) => `SCREENSHOT ${s.captured_after_phase} ${s.width}x${s.height} visible=${s.visible_pixels} luma=${s.mean_luma.toFixed(1)} path=${s.path} differs=${s.differs_from_first ?? ''}`),
  ];
  const text = lines.join('\n') + '\n';
  await writeFile(RESULTS_TXT, text);
  await writeFile(BACKEND_RESULTS_TXT, text);
  await writeFile(MODE_RESULTS_TXT, text);
  await writeFile(TARGET_MODE_RESULTS_TXT, text);
  await writeFile(HMR_MODE_RESULTS_TXT, text);
  await writeFile(NATURAL_PROFILE_RESULTS_TXT, text);
  console.log(`results: ${RESULTS_TXT}`);
  console.log(`backend_results: ${BACKEND_RESULTS_TXT}`);
  console.log(`mode_results: ${MODE_RESULTS_TXT}`);
  console.log(`target_mode_results: ${TARGET_MODE_RESULTS_TXT}`);
  console.log(`hmr_mode_results: ${HMR_MODE_RESULTS_TXT}`);
  console.log(`profile_results: ${NATURAL_PROFILE_RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  if (!SUPPORTED_RENDER_FIXTURES.has(CFG.renderBackend)) {
    fail(`unsupported SYNTHI_SCALE_RENDER_BACKEND=${CFG.renderBackend}; expected ${[...SUPPORTED_RENDER_FIXTURES].join(', ')}`);
  }
  if (!['missing', 'fresh', 'stale'].includes(CFG.templateEvidenceMode)) {
    fail(`unsupported SYNTHI_SCALE_TEMPLATE_EVIDENCE=${CFG.templateEvidenceMode}; expected missing, fresh, or stale`);
  }
  if (!SUPPORTED_CMAKE_TARGET_MODES.has(CFG.cmakeTargetMode)) {
    fail(`unsupported SYNTHI_SCALE_CMAKE_TARGET_MODE=${CFG.cmakeTargetMode}; expected ${[...SUPPORTED_CMAKE_TARGET_MODES].join(', ')}`);
  }
  if (!SUPPORTED_HMR_DELTA_MODES.has(CFG.hmrDeltaMode)) {
    fail(`unsupported SYNTHI_SCALE_HMR_DELTA_MODE=${CFG.hmrDeltaMode}; expected ${[...SUPPORTED_HMR_DELTA_MODES].join(', ')}`);
  }
  if (!SUPPORTED_VALIDATION_PROFILES.has(CFG.validationProfile)) {
    fail(`unsupported SYNTHI_SCALE_VALIDATION_PROFILE=${CFG.validationProfile}; expected ${[...SUPPORTED_VALIDATION_PROFILES].join(', ')}`);
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
    SYNTHI_SCALE_CMAKE_TARGET_MODE: CFG.cmakeTargetMode,
    SYNTHI_SCALE_HMR_DELTA_MODE: CFG.hmrDeltaMode,
    SYNTHI_SCALE_VALIDATION_PROFILE: CFG.validationProfile,
    SYNTHI_SCALE_TEMPLATE_EVIDENCE: CFG.templateEvidenceMode,
    SYNTHI_SCALE_TARGET_FILE_COUNT: String(CFG.targetWorkspaceFileCount),
    SYNTHI_SYNC_TO_GCS: process.env.SYNTHI_SYNC_TO_GCS ?? '',
  };
  report.containers = {
    worker: await containerSnapshot(CFG.workerContainer),
    ai_engine: await containerSnapshot(CFG.aiEngineContainer),
    mcp: await containerSnapshot(CFG.mcpContainer),
  };
  record(
    'gpu target',
    'pass',
    `${vendor} arch=${arch} render_backend=${CFG.renderBackend} cmake_target_mode=${CFG.cmakeTargetMode} template_evidence=${CFG.templateEvidenceMode} hmr_delta_mode=${CFG.hmrDeltaMode} validation_profile=${CFG.validationProfile}`,
  );

  const project = buildScaleProject(vendor, arch, CFG.renderBackend, CFG.cmakeTargetMode);
  report.workspace_file_count = project.files.length;
  report.relevant_file_count = project.relevantFiles.length;
  report.source_file_mix = sourceFileMix(project.relevantFiles);
  if (project.files.length < 200) fail(`scale fixture only has ${project.files.length} files`);
  if (report.source_file_mix.total < 40) fail(`scale fixture only has ${report.source_file_mix.total} source/header/device files`);
  record('source file mix', 'pass', JSON.stringify(report.source_file_mix));
  assertOrdinaryUserProject(project.files);
  await assertRenderBackendDependencies(renderBackendProfile(CFG.renderBackend));

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

  if (CFG.cmakeTargetMode === 'ambiguous') {
    const ambiguousWorkerCheckpoint = await workerCheckpoint();
    const ambiguousAiCheckpoint = await workerCheckpoint();
    await compileUnsupportedViaMcp({
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
    }, CFG.firstCompileTimeoutMs, 'ambiguous_cmake_target_rejected', 'target_resolution_ambiguous');

    const workerFileMarker = await awaitLogRegex(
      CFG.workerContainer,
      new RegExp(`\\[AI Split\\] ENTER .*files=${project.files.length}.*gpu_arch=${arch}`),
      1000,
      ambiguousWorkerCheckpoint,
    );
    record('worker saw full ambiguous target file set', workerFileMarker.matched ? 'pass' : 'fail', workerFileMarker.snippet || `missing files=${project.files.length}`);
    const aiAmbiguousMarker = await awaitLogRegex(
      CFG.aiEngineContainer,
      /deterministic unsupported project rejection: .*target resolution is ambiguous|target_resolution_ambiguous/,
      1000,
      ambiguousAiCheckpoint,
    );
    record(
      'ai-engine rejected ambiguous CMake target before split generation',
      aiAmbiguousMarker.matched ? 'pass' : 'fail',
      aiAmbiguousMarker.snippet || 'missing target_resolution_ambiguous marker',
    );
    if (!workerFileMarker.matched || !aiAmbiguousMarker.matched) {
      throw new Error('ambiguous target rejection evidence missing');
    }
    await writeReport();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

  if (CFG.renderBackend === 'vulkan') {
    await compileUnsupportedViaMcp({
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
    }, CFG.firstCompileTimeoutMs, 'vulkan_unsupported_fallback', 'unsupported.graphics_backend_vulkan');
    await writeReport();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

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
  }, CFG.firstCompileTimeoutMs, 'first_ai_split_compile', firstCheckpoint, {
    expectedHmrModule: 'device',
  });
  record('first compile via MCP', 'pass', `files=${1 + additionalFiles.length}`);

  const workerFileMarker = await awaitLogRegex(
    CFG.workerContainer,
    new RegExp(`\\[AI Split\\] ENTER .*files=${project.files.length}.*gpu_arch=${arch}`),
    1000,
    firstCheckpoint,
  );
  record('worker saw full file set', workerFileMarker.matched ? 'pass' : 'fail', workerFileMarker.snippet || `missing files=${project.files.length}`);

  const workerSplitCacheHit = await awaitLogRegex(
    CFG.workerContainer,
    /\[AI Split\] Level 1 HIT \(exact source_hash match\)/,
    1000,
    firstCheckpoint,
  );
  const aiFileMarker = await awaitLogRegex(
    CFG.aiEngineContainer,
    new RegExp(`\\[split/gpu\\] request file context count=${project.files.length}\\b`),
    1000,
    aiCheckpoint,
  );
  const aiContextStatus = aiFileMarker.matched || workerSplitCacheHit.matched ? 'pass' : 'fail';
  const aiContextDetail = aiFileMarker.matched
    ? aiFileMarker.snippet
    : (workerSplitCacheHit.snippet || `missing count=${project.files.length}`);
  record('ai-engine saw full file set or split cache hit', aiContextStatus, aiContextDetail);
  if (!workerFileMarker.matched || aiContextStatus !== 'pass') {
    throw new Error('file-set delivery evidence missing');
  }

  const firstShot = await captureScreenshot('first-compile');
  const split = await readGeneratedSplit(vendor, firstCheckpoint);
  validateGeneratedSplit(split, CFG.renderBackend);
  validateLaunchIndirectionContract(split);
  validateProdRunReportContract(split, project, vendor, arch);
  record('read generated split from worker', 'pass', `worker=${split.workspacePath}`);
  recordGeneratedSplitKeptInternal(split);

  const editedDevice = editUserDeviceSource(deviceSource.content);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: editedDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: user device delta' });
  const secondCheckpoint = await workerCheckpoint();
  const secondAiCheckpoint = { ...secondCheckpoint };
  const deviceDeltaResult = await compileUserDeviceDelta(project, editedDevice, vendor, secondCheckpoint);
  record(
    CFG.hmrDeltaMode === 'ai_user_delta'
      ? 'user device-source AI delta compile via MCP'
      : 'user device-source natural compile via MCP',
    'pass',
    project.devicePath,
  );
  await assertNoGeneratedSplitWorkspaceArtifacts(split);

  let naturalAiDeltaFallback = false;
  if (CFG.hmrDeltaMode === 'ai_user_delta') {
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
      secondAiCheckpoint,
    );
    record('ai-engine processed GPU delta', aiDeltaBackend.matched ? 'pass' : 'fail', aiDeltaBackend.snippet || 'no GpuDiffPatch marker');
    if (!aiDeltaBackend.matched) throw new Error('GPU AI delta backend evidence missing');
    await recordAiDeltaObservation('user_device_delta', secondCheckpoint, secondAiCheckpoint, true);
  } else {
    const naturalLogs = await dockerLogs(CFG.workerContainer, secondCheckpoint);
    const naturalFullSplit = naturalLogs.match(/\[AI Split\] ENTER[^\n]*/);
    record(
      'natural body edit avoided full AI re-split',
      naturalFullSplit ? 'fail' : 'pass',
      naturalFullSplit?.[0] || 'no full AI split marker after body edit',
    );
    if (naturalFullSplit) throw new Error(`natural body edit unexpectedly performed full AI re-split: ${naturalFullSplit[0]}`);
    naturalAiDeltaFallback = /\[GPU AI Delta\]/.test(naturalLogs);
    if (naturalAiDeltaFallback) {
      const aiDeltaBackend = await awaitLogRegex(
        CFG.aiEngineContainer,
        /\[GpuDiffPatch\][^\n]*/,
        CFG.aiDeltaEvidenceTimeoutMs,
        secondAiCheckpoint,
      );
      record('natural fallback processed GPU delta', aiDeltaBackend.matched ? 'pass' : 'fail', aiDeltaBackend.snippet || 'no GpuDiffPatch marker');
      if (!aiDeltaBackend.matched) throw new Error('natural GPU AI delta backend evidence missing');
    }
    await recordAiDeltaObservation('user_device_delta', secondCheckpoint, secondAiCheckpoint, naturalAiDeltaFallback);
  }

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

  let verifiedFastPathSidecarRaw = await readWorkerFile(split.workspacePath, '.synthi_split_meta.json');
  if (CFG.hmrDeltaMode === 'natural_user_delta') {
    if (naturalAiDeltaFallback) {
      validateNaturalAiDeltaFallbackSidecar(verifiedFastPathSidecarRaw, project);
    } else {
      validateDirectDeviceFastPathSidecar(verifiedFastPathSidecarRaw, project);
    }
  }

  if (CFG.templateEvidenceMode === 'fresh') {
    const headerFile = project.files.find((f) => f.path === project.templateHeaderPath);
    if (!headerFile) throw new Error(`missing template header ${project.templateHeaderPath}`);
    const editedHeader = editTemplateHeaderSource(headerFile.content);
    await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.templateHeaderPath, content: editedHeader }] });
    await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: bounded template warm rebuild' });
    const warmCheckpoint = await workerCheckpoint();
    await compileTemplateWarmRebuild(project, editedHeader, editedDevice, vendor, warmCheckpoint);
    record('template header warm rebuild compile via MCP', 'pass', project.templateHeaderPath);
    await assertNoGeneratedSplitWorkspaceArtifacts(split);

    const escapedHeader = project.templateHeaderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const warmAccepted = await awaitLogRegex(
      CFG.workerContainer,
      new RegExp(`\\[gpu-hmr\\] warm_rebuild accepted: user=${escapedHeader}[^\\n]*build\\.warm_rebuild`),
      10000,
      warmCheckpoint,
    );
    record('bounded template edit uses warm_rebuild', warmAccepted.matched ? 'pass' : 'fail', warmAccepted.snippet || 'no warm_rebuild accepted marker');
    if (!warmAccepted.matched) throw new Error('warm rebuild acceptance evidence missing');

    const warmCompile = await awaitLogRegex(
      CFG.workerContainer,
      new RegExp(`\\[compile-device\\] ${vendor === 'rocm' ? 'hipcc' : 'nvcc'} -> [^\\n]*`),
      10000,
      warmCheckpoint,
    );
    record('warm rebuild compiles device sidecar', warmCompile.matched ? 'pass' : 'fail', warmCompile.snippet || 'no device compile marker');
    if (!warmCompile.matched) throw new Error('warm rebuild device compile evidence missing');

    const warmReload = await awaitLogRegex(
      CFG.workerContainer,
      /\[gpu-reload\] plan=warm_rebuild[^\n]*|Device sidecar reload vendor=[^\n]*result=Success[^\n]*/,
      10000,
      warmCheckpoint,
    );
    record('warm rebuild reload observed', warmReload.matched ? 'pass' : 'fail', warmReload.snippet || 'no warm rebuild reload marker');
    if (!warmReload.matched) throw new Error('warm rebuild reload evidence missing');

    const warmLogs = await dockerLogs(CFG.workerContainer, warmCheckpoint);
    const warmAiMarker = warmLogs.match(/\[AI Split\] ENTER[^\n]*|\[GPU AI Delta\] Calling[^\n]*/);
    record('warm rebuild avoided AI split and AI delta', warmAiMarker ? 'fail' : 'pass', warmAiMarker?.[0] || 'no AI split/delta marker during warm rebuild');
    if (warmAiMarker) throw new Error(`warm rebuild unexpectedly invoked AI: ${warmAiMarker[0]}`);

    await sleep(1000);
    const warmShot = await captureScreenshot('post-warm-rebuild', secondShot);
    if (!warmShot.differs_from_first) {
      throw new Error('post-warm-rebuild screenshot did not differ materially from post-HMR screenshot');
    }

    const warmSidecarRaw = await readWorkerFile(split.workspacePath, '.synthi_split_meta.json');
    validateWarmRebuildSidecar(JSON.parse(warmSidecarRaw), project);
    headerFile.content = editedHeader;
    verifiedFastPathSidecarRaw = warmSidecarRaw;
  }

  if (CFG.validationProfile === 'natural') {
    record(
      'natural validation skipped forced negative gates',
      'pass',
      'ordinary first split, device body edit, and bounded header edit completed without forced AI delta',
    );
    await writeReport();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

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

  const gpuTaintDevice = editUserDeviceSource(missingCapabilityDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: gpuTaintDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: gpu taint rejection probe' });
  const gpuTaintSidecar = sidecarWithGpuDeviceTaint(verifiedFastPathSidecarRaw);
  await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', gpuTaintSidecar);
  const gpuTaintCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceGpuTaintNegative(project, gpuTaintDevice, vendor, gpuTaintCheckpoint);
  record('GPU taint edit compile dispatched via MCP', 'pass', project.devicePath);
  const gpuTaintReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*gpu_device_tainted[^\n]*/,
    10000,
    gpuTaintCheckpoint,
  );
  record('GPU device taint blocks device_only', gpuTaintReject.matched ? 'pass' : 'fail', gpuTaintReject.snippet || 'no gpu_device_tainted rejection marker');
  if (!gpuTaintReject.matched) throw new Error('GPU device taint rejection evidence missing');

  const gpuTaintHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*gpu_device_tainted[^\n]*/,
    10000,
    gpuTaintCheckpoint,
  );
  record('GPU device taint stops unsafe fallback', gpuTaintHardStop.matched ? 'pass' : 'fail', gpuTaintHardStop.snippet || 'no GPU taint hard-stop marker');
  if (!gpuTaintHardStop.matched) throw new Error('GPU device taint hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(gpuTaintHardStop, gpuTaintCheckpoint, 'GPU device taint does not reload sidecar');
  validateGpuTaintPolicySidecar(await readWorkerFile(split.workspacePath, '.synthi_split_meta.json'));

  const fragmentedVramDevice = editUserDeviceSource(gpuTaintDevice);
  await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.devicePath, content: fragmentedVramDevice }] });
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: fragmented vram rejection probe' });
  const fragmentedVramSidecar = sidecarWithFragmentedVram(verifiedFastPathSidecarRaw);
  await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', fragmentedVramSidecar);
  const fragmentedVramCheckpoint = await workerCheckpoint();
  await dispatchUserDeviceFragmentedVramNegative(project, fragmentedVramDevice, vendor, fragmentedVramCheckpoint);
  record('fragmented VRAM edit compile dispatched via MCP', 'pass', project.devicePath);
  const fragmentedVramReject = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only fast path rejected: user=[^\n]*vram_session_refresh_required[^\n]*/,
    10000,
    fragmentedVramCheckpoint,
  );
  record('fragmented VRAM blocks device_only', fragmentedVramReject.matched ? 'pass' : 'fail', fragmentedVramReject.snippet || 'no vram_session_refresh_required rejection marker');
  if (!fragmentedVramReject.matched) throw new Error('fragmented VRAM rejection evidence missing');

  const fragmentedVramHardStop = await awaitLogRegex(
    CFG.workerContainer,
    /\[gpu-hmr\] device_only hard stop: user=[^\n]*vram_session_refresh_required[^\n]*/,
    10000,
    fragmentedVramCheckpoint,
  );
  record('fragmented VRAM stops unsafe fallback', fragmentedVramHardStop.matched ? 'pass' : 'fail', fragmentedVramHardStop.snippet || 'no fragmented VRAM hard-stop marker');
  if (!fragmentedVramHardStop.matched) throw new Error('fragmented VRAM hard-stop evidence missing');
  await assertNoSidecarReloadAfterHardStop(fragmentedVramHardStop, fragmentedVramCheckpoint, 'fragmented VRAM does not reload sidecar');
  validateMemoryRefreshPolicySidecar(await readWorkerFile(split.workspacePath, '.synthi_split_meta.json'));

  if (CFG.templateEvidenceMode !== 'fresh' && project.templateHeaderPath) {
    await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', verifiedFastPathSidecarRaw);
    const headerFile = project.files.find((f) => f.path === project.templateHeaderPath);
    if (!headerFile) throw new Error(`missing template header ${project.templateHeaderPath}`);
    const rejectedHeader = editTemplateHeaderSource(headerFile.content);
    await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.templateHeaderPath, content: rejectedHeader }] });
    await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: template evidence rejection probe' });
    const templateRejectCheckpoint = await workerCheckpoint();
    await dispatchTemplateWarmRebuildNegative(project, rejectedHeader, editedDevice, vendor, templateRejectCheckpoint);
    record('template warm rebuild rejection compile dispatched via MCP', 'pass', project.templateHeaderPath);
    const expectedReason = CFG.templateEvidenceMode === 'stale'
      ? 'template_evidence_stale'
      : 'template_evidence_missing';
    const templateReject = await awaitLogRegex(
      CFG.workerContainer,
      new RegExp(`\\[gpu-hmr\\] warm_rebuild rejected: user=[^\\n]*${expectedReason}[^\\n]*`),
      10000,
      templateRejectCheckpoint,
    );
    record(`${CFG.templateEvidenceMode} template evidence rejects warm rebuild execution`, templateReject.matched ? 'pass' : 'fail', templateReject.snippet || `no ${expectedReason} warm rejection marker`);
    if (!templateReject.matched) throw new Error(`${expectedReason} warm rebuild rejection evidence missing`);
    await assertNoSidecarReloadAfterHardStop(templateReject, templateRejectCheckpoint, `${expectedReason} warm rebuild does not reload sidecar`);
  }

  if (CFG.templateEvidenceMode === 'fresh' && project.templateHeaderPath) {
    await writeWorkerFile(split.workspacePath, '.synthi_split_meta.json', sidecarWithRdcIncrementalDeviceLinkUnsupported(verifiedFastPathSidecarRaw));
    const headerFile = project.files.find((f) => f.path === project.templateHeaderPath);
    if (!headerFile) throw new Error(`missing template header ${project.templateHeaderPath}`);
    const rdcHeader = editTemplateHeaderSource(headerFile.content);
    await writeFilesBatch({ slug: CFG.slug, files: [{ path: project.templateHeaderPath, content: rdcHeader }] });
    await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-scale-validation: rdc linker-bound rejection probe' });
    const rdcCheckpoint = await workerCheckpoint();
    await dispatchTemplateWarmRebuildNegative(project, rdcHeader, editedDevice, vendor, rdcCheckpoint);
    record('RDC warm rebuild rejection compile dispatched via MCP', 'pass', project.templateHeaderPath);
    const rdcReject = await awaitLogRegex(
      CFG.workerContainer,
      /\[gpu-hmr\] warm_rebuild rejected: user=[^\n]*incremental_device_link_unsupported[^\n]*/,
      10000,
      rdcCheckpoint,
    );
    record('unsupported incremental device-link blocks warm rebuild auto-run', rdcReject.matched ? 'pass' : 'fail', rdcReject.snippet || 'no incremental_device_link_unsupported warm rejection marker');
    if (!rdcReject.matched) throw new Error('unsupported incremental device-link warm rebuild rejection evidence missing');
    const linkerBound = await awaitLogRegex(
      CFG.workerContainer,
      /\[gpu-hmr\] warm_rebuild rejected: user=[^\n]*device_linker_bound[^\n]*/,
      10000,
      rdcCheckpoint,
    );
    record('RDC warm path reports linker-bound consent reason', linkerBound.matched ? 'pass' : 'fail', linkerBound.snippet || 'no device_linker_bound warm rejection marker');
    if (!linkerBound.matched) throw new Error('RDC linker-bound warm rebuild evidence missing');
    await assertNoSidecarReloadAfterHardStop(rdcReject, rdcCheckpoint, 'unsupported incremental device-link warm rebuild does not reload sidecar');
  }

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
